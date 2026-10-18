//! Session-scoped Responses → Chat Completions bridge for Codex host runs.
//! The upstream key stays here; the child receives a fresh loopback-only key.
#[cfg(test)]
mod tests;
mod translate;

use std::{convert::Infallible, sync::Arc, time::Duration};

use bytes::Bytes;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, Limited, StreamBody};
use hyper::{
    body::Incoming, server::conn::http1, service::service_fn, Request, Response, StatusCode,
};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::mpsc, task::JoinSet};
use tokio_stream::{wrappers::ReceiverStream, StreamExt};

use crate::{AgentError, SessionSpec};

const MAX_BODY: usize = 20 * 1024 * 1024;
type Body = UnsyncBoxBody<Bytes, Infallible>;

pub(crate) struct Bridge(tokio::task::JoinHandle<()>);

impl Drop for Bridge {
    fn drop(&mut self) {
        // Dropping the listener task also aborts its JoinSet of connections.
        // Dropped response bodies close their channels and cancel upstream work.
        self.0.abort();
    }
}

struct Gateway {
    http: reqwest::Client,
    url: String,
    key: Option<String>,
    local_key: String,
    model: String,
}

pub(crate) async fn prepare(spec: &mut SessionSpec) -> Result<Option<Bridge>, AgentError> {
    let Some(local) = spec.local_model.as_mut() else {
        return Ok(None);
    };
    if local.api != am_proto::EndpointApi::ChatCompletions {
        return Ok(None);
    }
    if local.provider != am_proto::LocalModelProviderKind::OpenAiCompatible
        || !matches!(spec.runtime, crate::SessionRuntime::Host { .. })
    {
        return Err(AgentError::Other(
            "Chat Completions endpoints require Codex on Host execution".into(),
        ));
    }
    let base_url = local.base_url.as_deref().ok_or_else(|| {
        AgentError::Other("Chat Completions endpoint is missing its base URL".into())
    })?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| AgentError::Other("Could not start endpoint compatibility adapter".into()))?;
    let address = listener
        .local_addr()
        .map_err(|_| AgentError::Other("Could not resolve endpoint adapter address".into()))?;
    let gateway = Arc::new(Gateway {
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(300))
            .build()
            .map_err(|_| AgentError::Other("Could not initialize endpoint adapter".into()))?,
        url: format!("{}/chat/completions", base_url.trim_end_matches('/')),
        key: local.api_token.take(),
        local_key: format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()),
        model: local.model.clone(),
    });
    local.base_url = Some(format!("http://{address}/v1"));
    local.api_token = Some(gateway.local_key.clone());
    let task = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept(), if connections.len() < 8 => {
                    let Ok((socket, _)) = accepted else { break };
                    let gateway = gateway.clone();
                    connections.spawn(async move {
                        let service = service_fn(move |request| serve(request, gateway.clone()));
                        let _ = http1::Builder::new()
                            .header_read_timeout(Duration::from_secs(30))
                            .timer(hyper_util::rt::TokioTimer::new())
                            .serve_connection(TokioIo::new(socket), service).await;
                    });
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        }
    });
    Ok(Some(Bridge(task)))
}

fn failure(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(
            Full::new(Bytes::from(
                json!({"error": {"message": message}}).to_string(),
            ))
            .boxed_unsync(),
        )
        .unwrap()
}

async fn serve(
    request: Request<Incoming>,
    gateway: Arc<Gateway>,
) -> Result<Response<Body>, Infallible> {
    if request.headers().contains_key("origin")
        || request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            != Some(format!("Bearer {}", gateway.local_key).as_str())
    {
        return Ok(failure(
            StatusCode::UNAUTHORIZED,
            "Endpoint adapter authentication required",
        ));
    }
    if request.method() != hyper::Method::POST || request.uri().path() != "/v1/responses" {
        return Ok(failure(
            StatusCode::NOT_FOUND,
            "Endpoint adapter supports POST /v1/responses",
        ));
    }
    let bytes = match tokio::time::timeout(
        Duration::from_secs(30),
        Limited::new(request.into_body(), MAX_BODY).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        _ => {
            return Ok(failure(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Endpoint request is too large or incomplete",
            ))
        }
    };
    let input: Value = match serde_json::from_slice(&bytes) {
        Ok(input) => input,
        Err(_) => {
            return Ok(failure(
                StatusCode::BAD_REQUEST,
                "Endpoint request must be JSON",
            ))
        }
    };
    if input["model"].as_str() != Some(&gateway.model) {
        return Ok(failure(
            StatusCode::BAD_REQUEST,
            "Endpoint adapter model does not match this session",
        ));
    }
    let (body, tools) = match translate::request(&input) {
        Ok(result) => result,
        Err(message) => return Ok(failure(StatusCode::BAD_REQUEST, message)),
    };
    let mut upstream = gateway.http.post(&gateway.url).json(&body);
    if let Some(key) = &gateway.key {
        upstream = upstream.bearer_auth(key);
    }
    let response = match upstream.send().await {
        Ok(response) => response,
        Err(_) => {
            return Ok(failure(
                StatusCode::BAD_GATEWAY,
                "Could not reach Chat Completions endpoint",
            ))
        }
    };
    if !response.status().is_success() {
        // Never forward arbitrary error bodies/headers: gateways may echo keys or prompts.
        let status = response.status();
        let message = format!("Chat Completions endpoint returned HTTP {}. Check the endpoint, API key, model, or allowance.", status.as_u16());
        let mut result = failure(status, &message);
        if let Some(retry) = response.headers().get("retry-after") {
            result.headers_mut().insert("retry-after", retry.clone());
        }
        return Ok(result);
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"))
    {
        return Ok(failure(
            StatusCode::BAD_GATEWAY,
            "Chat Completions endpoint must support SSE streaming",
        ));
    }
    let (tx, rx) = mpsc::channel::<Bytes>(16);
    tokio::spawn(pump(
        response,
        tx,
        translate::Output::new(&gateway.model, tools),
    ));
    let stream =
        ReceiverStream::new(rx).map(|bytes| Ok::<_, Infallible>(hyper::body::Frame::data(bytes)));
    Ok(Response::builder()
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(StreamBody::new(stream).boxed_unsync())
        .unwrap())
}

async fn send(tx: &mpsc::Sender<Bytes>, events: Vec<Value>) -> Result<(), ()> {
    for event in events {
        let bytes = Bytes::from(format!(
            "event: {}\ndata: {event}\n\n",
            event["type"].as_str().unwrap_or("error")
        ));
        tx.send(bytes).await.map_err(|_| ())?;
    }
    Ok(())
}

async fn pump(
    mut response: reqwest::Response,
    tx: mpsc::Sender<Bytes>,
    mut output: translate::Output,
) {
    let result = async {
        send(&tx, output.created()).await.map_err(|_| "Client disconnected")?;
        let mut parser = translate::Sse::default();
        loop {
            let chunk = tokio::select! {
                _ = tx.closed() => return Ok(()),
                chunk = response.chunk() => chunk.map_err(|_| "Chat Completions stream disconnected")?,
            };
            let Some(chunk) = chunk else { return Err("Chat Completions stream ended without [DONE]") };
            for data in parser.push(&chunk)? {
                if data == "[DONE]" {
                    send(&tx, output.completed()?).await.map_err(|_| "Client disconnected")?;
                    return Ok(());
                }
                let chunk: Value = serde_json::from_str(&data).map_err(|_| "Chat Completions endpoint sent invalid stream JSON")?;
                send(&tx, output.chunk(&chunk)?).await.map_err(|_| "Client disconnected")?;
            }
        }
    }.await;
    if let Err(message) = result {
        let _ = send(
            &tx,
            vec![json!({"type":"error", "code":"chat_completions_error", "message":message})],
        )
        .await;
    }
}
