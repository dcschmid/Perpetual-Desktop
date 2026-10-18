use super::*;
use crate::{
    AgentAdapter, AgentPolicyRuntime, CodexAdapter, LocalModelRuntime, PermissionPolicy,
    SessionStatus,
};
use std::sync::Mutex;

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        // UUID and exclusive creation prevent reuse of another process's files.
        // nosemgrep: rust.lang.security.temp-dir.temp-dir
        let path = std::env::temp_dir().join(format!("perpetual-chat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn spec(url: &str) -> SessionSpec {
    SessionSpec {
        worktree: "/tmp".into(),
        prompt: "Test".into(),
        model: Some("yolo".into()),
        reasoning: None,
        local_model: Some(LocalModelRuntime {
            provider: am_proto::LocalModelProviderKind::OpenAiCompatible,
            api: am_proto::EndpointApi::ChatCompletions,
            model: "yolo".into(),
            base_url: Some(url.into()),
            api_token: Some("mock-only-key".into()),
        }),
        permission: PermissionPolicy::ReadOnly,
        runtime: crate::SessionRuntime::default(),
        policy: None,
        approver: None,
    }
}

struct Mock {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    paths: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort()
    }
}
impl Mock {
    async fn new(status: StatusCode) -> Self {
        Self::with_tool(status, "command").await
    }

    async fn with_tool(status: StatusCode, target: &'static str) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let url = format!("http://{}/Gateway/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(vec![]));
        let paths = Arc::new(Mutex::new(vec![]));
        let (captured, captured_paths) = (requests.clone(), paths.clone());
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    socket = listener.accept() => {
                        let Ok((socket,_)) = socket else {break};
                        let requests = captured.clone();
                        let paths = captured_paths.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |request: Request<Incoming>| {
                                let requests = requests.clone(); let paths = paths.clone();
                                async move {
                                    paths.lock().unwrap().push(request.uri().path().into());
                                    if request.uri().path() != "/Gateway/v1/chat/completions" {
                                        return Ok::<_,Infallible>(failure(StatusCode::NOT_FOUND,"Route not found"));
                                    }
                                    assert_eq!(request.headers()["authorization"],"Bearer mock-only-key");
                                    let body:Value = serde_json::from_slice(&request.into_body().collect().await.unwrap().to_bytes()).unwrap();
                                    assert_eq!(body["model"],"yolo");
                                    assert!(body.get("store").is_none());
                                    assert!(body["messages"].as_array().unwrap().iter().all(|m| m["role"]!="developer"));
                                    let messages = body["messages"].as_array().unwrap();
                                    assert!(messages.iter().enumerate().all(|(index, message)| message["role"] != "system" || index == 0), "System message must be at the beginning");
                                    let n = { let mut captured=requests.lock().unwrap(); captured.push(body.clone()); captured.len() };
                                    if status != StatusCode::OK {
                                        let mut response = failure(status,"NEVER-ECHO-THIS-secret");
                                        response.headers_mut().insert("retry-after","12".parse().unwrap());
                                        return Ok(response);
                                    }
                                    let deltas = if n==1 {
                                        let tool = body["tools"].as_array().unwrap().iter().find(|t| {
                                            let name = t["function"]["name"].as_str().unwrap_or("");
                                            match target {
                                                "command" => matches!(name,"exec_command"|"shell_command"),
                                                "mcp" => t["function"]["description"].as_str().unwrap_or("").contains("Perpetual adapter MCP test"),
                                                other => name == other,
                                            }
                                        }).expect("Codex must expose the requested tool");
                                        let name = tool["function"]["name"].as_str().unwrap();
                                        let args = match target {
                                            "mcp" => json!({"value":"MCP_OK"}),
                                            _ if name=="exec_command" => json!({"cmd":"printf endpoint_mock_ok"}),
                                            _ => json!({"command":"printf endpoint_mock_ok"}),
                                        };
                                        vec![json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_mock","type":"function","function":{"name":name,"arguments":""}}]},"finish_reason":null}]}),
                                            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":args.to_string()}}]},"finish_reason":"tool_calls"}]})]
                                    } else {
                                        assert!(body["messages"].as_array().unwrap().iter().any(|m| m["role"]=="tool" && m["tool_call_id"]=="call_mock"));
                                        let result = body["messages"].as_array().unwrap().iter().find(|m| m["role"]=="tool" && m["tool_call_id"]=="call_mock").unwrap().to_string();
                                        assert!(result.contains(match target {"mcp"=>"MCP_OK",_=>"endpoint_mock_ok"}), "{result}");
                                        vec![json!({"choices":[{"index":0,"delta":{"content":"Endpoint mock "},"finish_reason":null}]}),
                                            json!({"choices":[{"index":0,"delta":{"content":"verified."},"finish_reason":"stop"}]})]
                                    };
                                    let mut data = String::new();
                                    for chunk in deltas { data.push_str(&format!("data: {chunk}\r\n\r\n")) }
                                    data.push_str("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n");
                                    Ok(Response::builder().header("content-type","text/event-stream")
                                        .body(Full::new(Bytes::from(data)).boxed_unsync()).unwrap())
                                }
                            });
                            let _=http1::Builder::new().serve_connection(TokioIo::new(socket),service).await;
                        });
                    }
                    _=connections.join_next(),if !connections.is_empty()=>{}
                }
            }
        });
        Self {
            url,
            requests,
            paths,
            task,
        }
    }
}

fn request() -> Value {
    json!({"model":"yolo","stream":true,"tools":[{"type":"function","name":"exec_command","parameters":{"type":"object"}}],"input":[{"role":"user","content":"test"}]})
}

#[tokio::test]
async fn reproduces_responses_404_and_bridge_targets_chat_route_with_separate_credentials() {
    let mock = Mock::new(StatusCode::OK).await;
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        http.post(format!("{}/responses", mock.url))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let mut spec = spec(&mock.url);
    let bridge = prepare(&mut spec).await.unwrap().unwrap();
    let local = spec.local_model.unwrap();
    let key = local.api_token.unwrap();
    assert_ne!(key, "mock-only-key");
    let url = format!("{}/responses", local.base_url.unwrap());
    assert_eq!(
        http.post(&url)
            .json(&request())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        http.post(&url)
            .bearer_auth(&key)
            .header("origin", "https://example.test")
            .json(&request())
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = http
        .post(&url)
        .bearer_auth(&key)
        .json(&request())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(body.contains("response.completed"));
    assert!(body.contains("function_call"));
    assert_eq!(mock.requests.lock().unwrap().len(), 1);
    assert_eq!(
        *mock.paths.lock().unwrap(),
        ["/Gateway/v1/responses", "/Gateway/v1/chat/completions"]
    );
    drop(bridge);
    tokio::time::timeout(Duration::from_secs(2), async {
        while http.post(&url).bearer_auth(&key).send().await.is_ok() {
            tokio::task::yield_now().await
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn upstream_errors_preserve_status_and_retry_after_but_redact_payload() {
    let mock = Mock::new(StatusCode::TOO_MANY_REQUESTS).await;
    let mut spec = spec(&mock.url);
    let _bridge = prepare(&mut spec).await.unwrap();
    let local = spec.local_model.unwrap();
    let result = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("{}/responses", local.base_url.unwrap()))
        .bearer_auth(local.api_token.unwrap())
        .json(&request())
        .send()
        .await
        .unwrap();
    assert_eq!(result.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(result.headers()["retry-after"], "12");
    let body = result.text().await.unwrap();
    assert!(body.contains("HTTP 429"));
    assert!(!body.contains("NEVER-ECHO-THIS"));
}

#[tokio::test]
async fn disconnect_and_session_shutdown_cancel_the_upstream_stream() {
    for stop_session in [false, true] {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
        let closed_tx = Arc::new(Mutex::new(Some(closed_tx)));
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let service = service_fn(move |request: Request<Incoming>| {
                let closed = closed_tx.clone();
                async move {
                    let _ = request.into_body().collect().await.unwrap();
                    let (tx, rx) = mpsc::channel::<Bytes>(1);
                    tx.send(Bytes::from_static(b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"}}]}\n\n")).await.unwrap();
                    tokio::spawn(async move {
                        tx.closed().await;
                        if let Some(tx) = closed.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                    });
                    let stream = ReceiverStream::new(rx)
                        .map(|bytes| Ok::<_, Infallible>(hyper::body::Frame::data(bytes)));
                    Ok::<_, Infallible>(
                        Response::builder()
                            .header("content-type", "text/event-stream")
                            .body(StreamBody::new(stream).boxed_unsync())
                            .unwrap(),
                    )
                }
            });
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .await;
        });
        let mut spec = spec(&upstream);
        let mut bridge = prepare(&mut spec).await.unwrap();
        let local = spec.local_model.unwrap();
        let mut response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{}/responses", local.base_url.unwrap()))
            .bearer_auth(local.api_token.unwrap())
            .json(&request())
            .send()
            .await
            .unwrap();
        assert!(response.chunk().await.unwrap().is_some());
        if stop_session {
            drop(bridge.take());
        } else {
            drop(response);
        }
        tokio::time::timeout(Duration::from_secs(3), closed_rx)
            .await
            .unwrap()
            .unwrap();
        server.abort();
    }
}

#[tokio::test]
#[ignore = "requires installed Codex CLI; uses only a local mock, no paid inference"]
async fn installed_codex_completes_chat_completions_tool_loop_and_resumes() {
    let root = Temp::new();
    let mock = Mock::new(StatusCode::OK).await;
    let mut spec = spec(&mock.url);
    spec.worktree = root.0.clone();
    spec.policy = Some(AgentPolicyRuntime {
        launch_env: vec![("CODEX_HOME".into(), root.0.to_string_lossy().into())],
        ..Default::default()
    });
    let adapter = CodexAdapter::new();
    let mut session = None;
    for attempt in 0..2 {
        let mut handle = if attempt == 0 {
            adapter.start(spec.clone()).await.unwrap()
        } else {
            adapter
                .resume(session.clone().unwrap(), spec.clone())
                .await
                .unwrap()
        };
        let mut text = String::new();
        let mut ended = false;
        tokio::time::timeout(Duration::from_secs(45), async {
            while let Some(event) = handle.events.recv().await {
                match event {
                    crate::NormalizedEvent::SessionStarted { session_id } => {
                        session = Some(crate::SessionRef {
                            agent_session_id: session_id,
                        })
                    }
                    crate::NormalizedEvent::AssistantTextDelta { delta } => text.push_str(&delta),
                    crate::NormalizedEvent::SessionEnded { status, .. } => {
                        assert_eq!(status, SessionStatus::Completed);
                        ended = true
                    }
                    crate::NormalizedEvent::Error { message, .. } => panic!("{message}"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        assert!(ended);
        assert!(text.contains("Endpoint mock verified."), "{text}");
    }
    assert_eq!(mock.requests.lock().unwrap().len(), 3);
    assert!(mock
        .paths
        .lock()
        .unwrap()
        .iter()
        .all(|p| p == "/Gateway/v1/chat/completions"));
}

#[tokio::test]
#[ignore = "requires installed Codex CLI and Python; uses only a local mock"]
async fn installed_codex_routes_namespaced_mcp_calls() {
    let root = Temp::new();
    let script = root.0.join("mock_mcp.py");
    std::fs::write(&script, r#"import json, sys
for line in sys.stdin:
    value = json.loads(line)
    if 'id' not in value: continue
    method = value.get('method')
    if method == 'initialize': result = {'protocolVersion':'2024-11-05', 'capabilities':{'tools':{}}, 'serverInfo':{'name':'perpetual-compat-test','version':'1'}}
    elif method == 'tools/list': result = {'tools':[{'name':'echo','description':'Perpetual adapter MCP test','inputSchema':{'type':'object','properties':{'value':{'type':'string'}},'required':['value']},'annotations':{'readOnlyHint':True}}]}
    elif method == 'tools/call': result = {'content':[{'type':'text','text':value['params']['arguments']['value']}]}
    else: result = {}
    print(json.dumps({'jsonrpc':'2.0','id':value['id'],'result':result}), flush=True)
"#).unwrap();
    // JSON strings are valid TOML basic strings for these generated paths.
    std::fs::write(
        root.0.join("config.toml"),
        format!(
            "[mcp_servers.compat_test]\ncommand = \"python3\"\nargs = [{}]\n",
            serde_json::to_string(&script.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    let mock = Mock::with_tool(StatusCode::OK, "mcp").await;
    let mut spec = spec(&mock.url);
    spec.worktree = root.0.clone();
    spec.permission = PermissionPolicy::WorkspaceWrite;
    spec.policy = Some(AgentPolicyRuntime {
        launch_env: vec![("CODEX_HOME".into(), root.0.to_string_lossy().into())],
        ..Default::default()
    });
    let mut handle = CodexAdapter::new().start(spec).await.unwrap();
    let mut completed = false;
    tokio::time::timeout(Duration::from_secs(45), async {
        while let Some(event) = handle.events.recv().await {
            match event {
                crate::NormalizedEvent::SessionEnded { status, .. } => {
                    assert_eq!(status, SessionStatus::Completed);
                    completed = true
                }
                crate::NormalizedEvent::Error { message, .. } => panic!("{message}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(completed);
    assert_eq!(mock.requests.lock().unwrap().len(), 2);
}
