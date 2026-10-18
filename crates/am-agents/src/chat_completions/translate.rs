use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone)]
pub(super) struct Tool {
    name: String,
    namespace: Option<String>,
    custom: bool,
}
type Tools = HashMap<String, Tool>;

fn wire_name(namespace: Option<&str>, name: &str) -> String {
    if namespace.is_none()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && !name.starts_with("perpetual_ns_")
    {
        return name.into();
    }
    // Namespaces can be long and include characters forbidden in Chat tool names.
    let key = serde_json::to_vec(&(namespace, name)).unwrap();
    format!("perpetual_ns_{:x}", Sha256::digest(key))[..61].to_string()
}

fn add_tools(
    source: &[Value],
    namespace: Option<&str>,
    tools: &mut Tools,
    result: &mut Vec<Value>,
) -> Result<()> {
    for tool in source {
        let kind = tool["type"].as_str().unwrap_or("");
        if !matches!(kind, "function" | "custom" | "namespace") {
            return Err("Chat Completions endpoints support function and custom tools; disable hosted web search and other Responses-only tools");
        }
        let name = tool["name"]
            .as_str()
            .ok_or("Endpoint tool is missing its name")?;
        if kind == "namespace" && namespace.is_none() {
            add_tools(
                tool["tools"]
                    .as_array()
                    .ok_or("Invalid endpoint tool namespace")?,
                Some(name),
                tools,
                result,
            )?;
            continue;
        }
        if !matches!(kind, "function" | "custom") {
            return Err("Chat Completions endpoints support function and custom tools; disable hosted web search and other Responses-only tools");
        }
        let custom = kind == "custom";
        let wire = wire_name(namespace, name);
        if tools
            .insert(
                wire.clone(),
                Tool {
                    name: name.into(),
                    namespace: namespace.map(str::to_string),
                    custom,
                },
            )
            .is_some()
        {
            return Err("Endpoint contains duplicate tool names");
        }
        let mut description = tool["description"].as_str().unwrap_or("").to_string();
        if custom {
            description
                .push_str("\nPass the complete raw tool input in the input string property.");
            if let Some(format) = tool.get("format") {
                description.push_str(&format!("\nRequired input format: {format}"));
            }
        }
        let parameters = if custom {
            json!({"type":"object", "properties":{"input":{"type":"string"}}, "required":["input"], "additionalProperties":false})
        } else {
            tool.get("parameters")
                .cloned()
                .unwrap_or(json!({"type":"object","properties":{}}))
        };
        result.push(json!({"type":"function", "function":{"name":wire,"description":description,"parameters":parameters}}));
    }
    Ok(())
}

fn content(value: &Value) -> Result<Value> {
    if value.is_string() {
        return Ok(value.clone());
    }
    let mut result = vec![];
    for part in value
        .as_array()
        .ok_or("Unsupported endpoint message content")?
    {
        match part["type"].as_str().unwrap_or("") {
            "input_text" | "output_text" | "text" => {
                result.push(json!({"type":"text","text":part["text"]}))
            }
            "input_image" => {
                if !part["image_url"].is_string() {
                    return Err("Endpoint images require an image URL or data URL");
                }
                let mut image = json!({"url":part["image_url"]});
                if let Some(detail) = part.get("detail") {
                    image["detail"] = detail.clone()
                }
                result.push(json!({"type":"image_url","image_url":image}));
            }
            _ => {
                return Err(
                    "Chat Completions endpoint received unsupported content; use text or images",
                )
            }
        }
    }
    Ok(Value::Array(result))
}

pub(super) fn request(input: &Value) -> Result<(Value, Tools)> {
    if input["stream"] != true {
        return Err("Endpoint adapter requires streaming requests");
    }
    if input
        .get("previous_response_id")
        .is_some_and(|v| !v.is_null())
    {
        return Err("Chat Completions endpoints require replayed conversation input");
    }
    let mut tools = Tools::new();
    let mut chat_tools = vec![];
    if let Some(source) = input["tools"].as_array() {
        add_tools(source, None, &mut tools, &mut chat_tools)?
    }
    let mut messages: Vec<Value> = vec![];
    let mut system_instructions = vec![];
    if let Some(instructions) = input["instructions"].as_str().filter(|s| !s.is_empty()) {
        system_instructions.push(instructions.to_owned());
    }
    let items = if let Some(text) = input["input"].as_str() {
        vec![json!({"role":"user","content":text})]
    } else {
        input["input"]
            .as_array()
            .ok_or("Endpoint request is missing conversation input")?
            .clone()
    };
    let mut reasoning = String::new();
    for item in items {
        match item["type"].as_str().unwrap_or("message") {
            "message" => {
                let role = match item["role"].as_str().unwrap_or("") {
                    "developer" | "system" => "system",
                    "user" => "user",
                    "assistant" => "assistant",
                    _ => return Err("Endpoint message has an unsupported role"),
                };
                let content = content(&item["content"])?;
                if role == "system" {
                    if let Some(text) = content.as_str() {
                        system_instructions.push(text.to_owned());
                    } else {
                        for part in content.as_array().unwrap() {
                            system_instructions.push(
                                part["text"]
                                    .as_str()
                                    .ok_or("Endpoint system instructions must contain only text")?
                                    .to_owned(),
                            );
                        }
                    }
                    continue;
                }
                let mut message = json!({"role":role,"content":content});
                if role == "assistant" && !reasoning.is_empty() {
                    message["reasoning_content"] = std::mem::take(&mut reasoning).into()
                }
                messages.push(message);
            }
            "function_call" | "custom_tool_call" => {
                let name = item["name"]
                    .as_str()
                    .ok_or("Endpoint tool call is missing its name")?;
                let arguments = if item["type"] == "custom_tool_call" {
                    json!({"input":item["input"]}).to_string()
                } else {
                    item["arguments"]
                        .as_str()
                        .ok_or("Endpoint tool arguments must be a JSON string")?
                        .into()
                };
                let call = json!({"id":item["call_id"], "type":"function", "function":{"name":wire_name(item["namespace"].as_str(),name),"arguments":arguments}});
                if let Some(last) = messages.last_mut().filter(|m| m["role"] == "assistant") {
                    if last.get("tool_calls").is_none() {
                        last["tool_calls"] = json!([])
                    }
                    last["tool_calls"].as_array_mut().unwrap().push(call);
                    if !reasoning.is_empty() {
                        last["reasoning_content"] = std::mem::take(&mut reasoning).into()
                    }
                } else {
                    let mut message =
                        json!({"role":"assistant","content":null,"tool_calls":[call]});
                    if !reasoning.is_empty() {
                        message["reasoning_content"] = std::mem::take(&mut reasoning).into()
                    }
                    messages.push(message);
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                messages.push(json!({"role":"tool", "tool_call_id":item["call_id"], "content":content(&item["output"])?}));
            }
            "reasoning" => {
                if let Some(summary) = item["summary"].as_array() {
                    for part in summary {
                        if let Some(text) = part["text"].as_str() {
                            reasoning.push_str(text)
                        }
                    }
                }
            }
            _ => {
                return Err("Chat Completions endpoint received a Responses-only conversation item")
            }
        }
    }
    // Codex can send several developer messages, including after user input.
    // Chat templates such as Qwen's require one system message at the start.
    if !system_instructions.is_empty() {
        messages.insert(
            0,
            json!({"role":"system","content":system_instructions.join("\n\n")}),
        );
    }
    let mut body = json!({"model":input["model"], "messages":messages, "stream":true, "stream_options":{"include_usage":true}});
    if !chat_tools.is_empty() {
        body["tools"] = chat_tools.into();
        if let Some(choice) = input.get("tool_choice") {
            body["tool_choice"] = if choice.is_string() {
                choice.clone()
            } else {
                json!({"type":"function","function":{"name":wire_name(choice["namespace"].as_str(),choice["name"].as_str().ok_or("Unsupported endpoint tool choice")?)}})
            };
        }
        if let Some(parallel) = input.get("parallel_tool_calls") {
            body["parallel_tool_calls"] = parallel.clone()
        }
    }
    if let Some(effort) = input["reasoning"].get("effort").filter(|v| !v.is_null()) {
        body["reasoning_effort"] = effort.clone()
    }
    if let Some(max) = input.get("max_output_tokens") {
        body["max_tokens"] = max.clone()
    }
    if let Some(temp) = input.get("temperature") {
        body["temperature"] = temp.clone()
    }
    // Never forward Responses-only store/include/client metadata or developer roles.
    Ok((body, tools))
}

/// A bounded SSE decoder. Decode UTF-8 only after a complete event, so split
/// Unicode and CRLF sequences survive arbitrary HTTP chunk boundaries.
#[derive(Default)]
pub(super) struct Sse {
    pending: Vec<u8>,
    data: Vec<String>,
    event_size: usize,
}
impl Sse {
    pub(super) fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>> {
        self.pending.extend_from_slice(chunk);
        let mut events = vec![];
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "Endpoint stream is not valid UTF-8")?
                .trim_end_matches(['\r', '\n']);
            self.event_size += line.len();
            if self.event_size > super::MAX_BODY {
                return Err("Endpoint stream event is too large");
            }
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
                self.event_size = 0;
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).into())
            }
        }
        if self.pending.len() + self.event_size > super::MAX_BODY {
            return Err("Endpoint stream event is too large");
        }
        Ok(events)
    }
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
}

pub(super) struct Output {
    id: String,
    model: String,
    tools: Tools,
    text: String,
    reasoning: String,
    calls: BTreeMap<u64, Call>,
    usage: Value,
    finish: Option<String>,
    size: usize,
    sequence: u64,
}

impl Output {
    pub(super) fn new(model: &str, tools: Tools) -> Self {
        Self {
            id: format!("resp_{}", uuid::Uuid::new_v4().simple()),
            model: model.into(),
            tools,
            text: String::new(),
            reasoning: String::new(),
            calls: BTreeMap::new(),
            usage: Value::Null,
            finish: None,
            size: 0,
            sequence: 0,
        }
    }
    fn event(&mut self, mut value: Value) -> Value {
        value["sequence_number"] = self.sequence.into();
        self.sequence += 1;
        value
    }
    fn response(&self, status: &str, items: Vec<Value>) -> Value {
        let input = self.usage["prompt_tokens"].as_u64().unwrap_or(0);
        let output = self.usage["completion_tokens"].as_u64().unwrap_or(0);
        json!({"id":self.id,"object":"response","created_at":chrono::Utc::now().timestamp(),"model":self.model,"status":status,"output":items,
            "usage":{"input_tokens":input,"output_tokens":output,"total_tokens":input.saturating_add(output),"input_tokens_details":{"cached_tokens":self.usage["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0)},"output_tokens_details":{"reasoning_tokens":self.usage["completion_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0)}}})
    }
    fn message(&self, done: bool) -> Value {
        json!({"type":"message","id":format!("msg_{}",self.id),"role":"assistant","status":if done {"completed"} else {"in_progress"},"content":if done {vec![json!({"type":"output_text","text":self.text,"annotations":[]})]}else{vec![]}})
    }
    pub(super) fn created(&mut self) -> Vec<Value> {
        vec![self.event(
            json!({"type":"response.created","response":self.response("in_progress",vec![])}),
        )]
    }
    pub(super) fn chunk(&mut self, chunk: &Value) -> Result<Vec<Value>> {
        if chunk.get("error").is_some() {
            return Err("Chat Completions endpoint reported a stream error");
        }
        if let Some(usage) = chunk.get("usage").filter(|v| !v.is_null()) {
            self.usage = usage.clone()
        }
        let Some(choices) = chunk["choices"].as_array() else {
            return Err("Endpoint stream is missing choices");
        };
        let mut events = vec![];
        for choice in choices {
            if choice["index"].as_u64().unwrap_or(0) != 0 {
                continue;
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                self.finish = Some(reason.into())
            }
            let delta = &choice["delta"];
            if delta["refusal"].as_str().is_some_and(|s| !s.is_empty()) {
                return Err("Chat Completions endpoint refused the request");
            }
            if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
                if self.text.is_empty() {
                    events.push(self.event(json!({"type":"response.output_item.added","output_index":0,"item":self.message(false)})));
                    events.push(self.event(json!({"type":"response.content_part.added","output_index":0,"item_id":format!("msg_{}",self.id),"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}})));
                }
                self.text.push_str(text);
                self.size += text.len();
                events.push(self.event(json!({"type":"response.output_text.delta","output_index":0,"item_id":format!("msg_{}",self.id),"content_index":0,"delta":text})));
            }
            if let Some(reasoning) = delta["reasoning_content"]
                .as_str()
                .or_else(|| delta["reasoning"].as_str())
            {
                self.reasoning.push_str(reasoning);
                self.size += reasoning.len()
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                for call in calls {
                    let index = call["index"]
                        .as_u64()
                        .ok_or("Endpoint tool delta is missing its index")?;
                    if self.calls.len() >= 128 && !self.calls.contains_key(&index) {
                        return Err("Endpoint returned too many tool calls");
                    }
                    let stored = self.calls.entry(index).or_default();
                    for (key, target) in [
                        ("id", &mut stored.id),
                        ("name", &mut stored.name),
                        ("arguments", &mut stored.arguments),
                    ] {
                        let source = if key == "id" { call } else { &call["function"] };
                        if let Some(text) = source[key].as_str() {
                            target.push_str(text);
                            self.size += text.len()
                        }
                    }
                }
            }
        }
        if self.size > super::MAX_BODY {
            return Err("Endpoint response is too large");
        }
        Ok(events)
    }
    pub(super) fn completed(&mut self) -> Result<Vec<Value>> {
        match self.finish.as_deref() {
            Some("stop" | "tool_calls") => {}
            Some("length") => {
                return Err("Chat Completions endpoint reached its output token limit")
            }
            Some("content_filter") => {
                return Err("Chat Completions endpoint filtered the response")
            }
            _ => return Err("Chat Completions stream did not report a successful finish"),
        }
        if self.text.is_empty() && self.calls.is_empty() {
            return Err("Chat Completions endpoint returned no assistant output");
        }
        let mut events = vec![];
        let mut items = vec![];
        if !self.text.is_empty() {
            let item = self.message(true);
            events.push(self.event(json!({"type":"response.output_text.done","output_index":0,"item_id":item["id"],"content_index":0,"text":self.text})));
            events.push(self.event(json!({"type":"response.content_part.done","output_index":0,"item_id":item["id"],"content_index":0,"part":item["content"][0]})));
            events.push(
                self.event(
                    json!({"type":"response.output_item.done","output_index":0,"item":item}),
                ),
            );
            items.push(item);
        }
        if !self.reasoning.is_empty() {
            let item = json!({"type":"reasoning","id":format!("rs_{}",self.id),"summary":[{"type":"summary_text","text":self.reasoning}]});
            events.push(self.event(
                json!({"type":"response.output_item.added","output_index":items.len(),"item":item}),
            ));
            events.push(self.event(
                json!({"type":"response.output_item.done","output_index":items.len(),"item":item}),
            ));
            items.push(item);
        }
        for (index, call) in std::mem::take(&mut self.calls) {
            let tool = self
                .tools
                .get(&call.name)
                .ok_or("Endpoint returned an unknown tool name")?;
            if call.id.is_empty() {
                return Err("Endpoint returned a tool call without an ID");
            }
            let mut item = json!({"type":if tool.custom {"custom_tool_call"} else {"function_call"},"id":format!("fc_{}_{index}",self.id),"call_id":call.id,"name":tool.name,"status":"completed"});
            if let Some(namespace) = &tool.namespace {
                item["namespace"] = namespace.clone().into()
            }
            let (delta_type, delta, key) = if tool.custom {
                let args: Value = serde_json::from_str(&call.arguments)
                    .map_err(|_| "Endpoint custom tool arguments are not valid JSON")?;
                let raw = args["input"]
                    .as_str()
                    .ok_or("Endpoint custom tool is missing its input string")?
                    .to_string();
                ("response.custom_tool_call_input", raw, "input")
            } else {
                let _: Value = serde_json::from_str(&call.arguments)
                    .map_err(|_| "Endpoint tool arguments are not valid JSON")?;
                (
                    "response.function_call_arguments",
                    call.arguments,
                    "arguments",
                )
            };
            item[key] = delta.clone().into();
            let mut added = item.clone();
            added["status"] = "in_progress".into();
            added[key] = "".into();
            events.push(self.event(json!({"type":"response.output_item.added","output_index":items.len(),"item":added})));
            events.push(self.event(json!({"type":format!("{delta_type}.delta"),"output_index":items.len(),"item_id":item["id"],"delta":delta})));
            let mut done = json!({"type":format!("{delta_type}.done"),"output_index":items.len(),"item_id":item["id"]});
            done[key] = item[key].clone();
            events.push(self.event(done));
            events.push(self.event(
                json!({"type":"response.output_item.done","output_index":items.len(),"item":item}),
            ));
            items.push(item);
        }
        events.push(self.event(
            json!({"type":"response.completed","response":self.response("completed",items)}),
        ));
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        json!({"model":"yolo", "stream":true, "store":false,"include":["reasoning.encrypted_content"],
            "tools":[{"type":"function","name":"exec_command","parameters":{"type":"object"}},
                {"type":"custom","name":"apply_patch","description":"Apply a patch","format":{"type":"text"}},
                {"type":"namespace","name":"mcp__example__","tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}]}],
            "input":[{"type":"message","role":"developer","content":[{"type":"input_text","text":"Instructions"}]},
                {"role":"user","content":[{"type":"input_text","text":"Look at this"},{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]}]})
    }

    #[test]
    fn translates_roles_images_tools_and_parallel_tool_history_without_responses_fields() {
        let mut input = fixture();
        input["input"].as_array_mut().unwrap().extend([
            json!({"type":"reasoning","summary":[{"type":"summary_text","text":"Check first"}]}),
            json!({"type":"function_call","call_id":"a","name":"exec_command","arguments":"{}"}),
            json!({"type":"custom_tool_call","call_id":"b","name":"apply_patch","input":"*** Begin Patch"}),
            json!({"type":"function_call_output","call_id":"a","output":"ok"}),
            json!({"type":"custom_tool_call_output","call_id":"b","output":[{"type":"input_text","text":"patched"}]}),
        ]);
        let (body, tools) = request(&input).unwrap();
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(
            body["messages"][1]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            body["messages"][2]["tool_calls"].as_array().unwrap().len(),
            2
        );
        assert_eq!(body["messages"][2]["reasoning_content"], "Check first");
        assert_eq!(body["messages"][3]["tool_call_id"], "a");
        assert_eq!(body["messages"][4]["role"], "tool");
        assert!(body.get("store").is_none() && body.get("include").is_none());
        assert_eq!(tools.len(), 3);
        assert!(tools["apply_patch"].custom);
        assert!(tools
            .values()
            .any(|t| t.namespace.as_deref() == Some("mcp__example__")));
    }

    #[test]
    fn consolidates_all_system_and_developer_instructions_before_the_conversation() {
        let input = json!({"model":"yolo","stream":true,"instructions":"Base instructions",
        "input":[
            {"role":"developer","content":[{"type":"input_text","text":"Permissions"}]},
            {"role":"user","content":"First question"},
            {"role":"assistant","content":[{"type":"output_text","text":"First answer"}]},
            {"role":"system","content":"Updated instructions"},
            {"role":"developer","content":[{"type":"input_text","text":"Project rules"},{"type":"input_text","text":"More rules"}]},
            {"role":"user","content":"Follow-up question"}
        ]});
        let (body, _) = request(&input).unwrap();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| message["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["system", "user", "assistant", "user"]
        );
        assert_eq!(messages[0]["content"], "Base instructions\n\nPermissions\n\nUpdated instructions\n\nProject rules\n\nMore rules");
        assert_eq!(messages[1]["content"], "First question");
        assert_eq!(messages[2]["content"][0]["text"], "First answer");
        assert_eq!(messages[3]["content"], "Follow-up question");
    }

    #[test]
    fn tool_stream_round_trips_custom_and_namespaced_calls_and_usage() {
        let (_, tools) = request(&fixture()).unwrap();
        let name = wire_name(Some("mcp__example__"), "lookup");
        let mut output = Output::new("yolo", tools);
        output
            .chunk(&json!({"choices":[{"index":0,"delta":{"tool_calls":[
            {"index":1,"id":"b","function":{"name":name,"arguments":"{\"q\":"}},
            {"index":0,"id":"a","function":{"name":"apply_patch","arguments":"{\"input\":"}}]}}]}))
            .unwrap();
        output
            .chunk(&json!({"choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"function":{"arguments":"\"*** Begin Patch\"}"}},
            {"index":1,"function":{"arguments":"\"Berlin\"}"}}]},"finish_reason":"tool_calls"}]}))
            .unwrap();
        output.chunk(&json!({"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":4}}})).unwrap();
        let events = output.completed().unwrap();
        let response = &events.last().unwrap()["response"];
        assert_eq!(response["usage"]["input_tokens"], 20);
        assert_eq!(
            response["usage"]["input_tokens_details"]["cached_tokens"],
            4
        );
        assert_eq!(response["output"][0]["type"], "custom_tool_call");
        assert_eq!(response["output"][0]["input"], "*** Begin Patch");
        assert_eq!(response["output"][1]["namespace"], "mcp__example__");
        assert_eq!(response["output"][1]["name"], "lookup");
        let mut followup = fixture();
        followup["input"]
            .as_array_mut()
            .unwrap()
            .extend(response["output"].as_array().unwrap().clone());
        let (body, _) = request(&followup).unwrap();
        let calls = &body["messages"][2]["tool_calls"];
        assert_eq!(
            calls[0]["function"]["arguments"],
            "{\"input\":\"*** Begin Patch\"}"
        );
        assert_eq!(calls[1]["function"]["name"], name);
    }

    #[test]
    fn streams_text_incrementally_and_never_completes_truncated_or_invalid_tool_responses() {
        let (_, tools) = request(&fixture()).unwrap();
        let mut output = Output::new("yolo", tools.clone());
        let first = output
            .chunk(&json!({"choices":[{"delta":{"content":"Grüße "}}]}))
            .unwrap();
        assert!(first
            .iter()
            .any(|e| e["type"] == "response.output_text.delta"));
        assert!(output.completed().is_err());
        output
            .chunk(&json!({"choices":[{"delta":{"content":"Welt"},"finish_reason":"stop"}]}))
            .unwrap();
        let done = output.completed().unwrap();
        assert_eq!(
            done.last().unwrap()["response"]["output"][0]["content"][0]["text"],
            "Grüße Welt"
        );
        for reason in ["length", "content_filter", "unknown"] {
            let mut output = Output::new("yolo", tools.clone());
            output
                .chunk(&json!({"choices":[{"delta":{},"finish_reason":reason}]}))
                .unwrap();
            assert!(output.completed().is_err());
        }
        let mut output = Output::new("yolo", tools);
        output.chunk(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"missing","arguments":"{}"}}]},"finish_reason":"tool_calls"}]})).unwrap();
        assert!(output.completed().is_err());
    }

    #[test]
    fn sse_handles_split_unicode_crlf_comments_multiline_data_and_bounds() {
        let bytes = ": keepalive\r\ndata: Grüße\r\ndata: Welt\r\n\r\ndata: [DONE]\n\n".as_bytes();
        let mut parser = Sse::default();
        let mut data = vec![];
        for byte in bytes {
            data.extend(parser.push(&[*byte]).unwrap())
        }
        assert_eq!(data, ["Grüße\nWelt", "[DONE]"]);
        assert!(parser
            .push(&vec![b'x'; super::super::MAX_BODY + 1])
            .is_err());
    }

    #[test]
    fn unsupported_protocol_features_fail_before_inference() {
        for (key, value) in [
            ("previous_response_id", json!("resp_prior")),
            ("tools", json!([{"type":"web_search","name":"web"}])),
            ("stream", json!(false)),
            (
                "input",
                json!([{"type":"compaction","encrypted_content":"opaque"}]),
            ),
        ] {
            let mut input = fixture();
            input[key] = value;
            assert!(request(&input).is_err(), "{key}");
        }
    }
}
