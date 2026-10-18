//! User-configured gateways. Settings and model catalogs contain no credentials.
use am_agents::LocalModelRuntime;
use am_proto::{AgentModelOption, LocalModelProviderKind, OpenAiEndpoint, OpenAiEndpointProbe};
use keyring::Entry;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Arc, time::Duration};

use crate::{AppCore, CoreError};

const SETTINGS_KEY: &str = "openai_endpoints";
#[cfg(not(test))]
const TOKEN_SERVICE: &str = "perpetual";
static SETTINGS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl AppCore {
    pub async fn get_openai_endpoints(&self) -> Result<Vec<OpenAiEndpoint>, CoreError> {
        let raw = am_db::repos::settings::get(&self.db.pool, SETTINGS_KEY).await?;
        raw.map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|_| fail("Could not read OpenAI-compatible endpoint settings"))
        })
        .transpose()
        .map(Option::unwrap_or_default)
    }

    pub async fn save_openai_endpoint(
        &self,
        endpoint: OpenAiEndpoint,
    ) -> Result<OpenAiEndpoint, CoreError> {
        let _lock = SETTINGS_LOCK.lock().await;
        let mut endpoint = normalize_endpoint(endpoint)?;
        let mut endpoints = self.get_openai_endpoints().await?;
        let previous = endpoints.iter().find(|e| e.id == endpoint.id);
        endpoint.api_key_configured = previous.is_some_and(|e| e.api_key_configured);
        // An existing credential must never follow an edited URL to another gateway.
        if previous.is_some_and(|e| e.base_url != endpoint.base_url && e.api_key_configured) {
            self.delete_endpoint_key(&endpoint.id)?;
            endpoint.api_key_configured = false;
        }
        if let Some(previous) = endpoints.iter_mut().find(|e| e.id == endpoint.id) {
            *previous = endpoint.clone();
        } else {
            if endpoints.len() >= 50 {
                return Err(fail("Configure at most 50 endpoints"));
            }
            endpoints.push(endpoint.clone());
        }
        self.store_openai_endpoints(&endpoints).await?;
        Ok(endpoint)
    }

    pub async fn delete_openai_endpoint(&self, id: &str) -> Result<(), CoreError> {
        let _lock = SETTINGS_LOCK.lock().await;
        let mut endpoints = self.get_openai_endpoints().await?;
        let endpoint = endpoints
            .iter()
            .find(|e| e.id == id)
            .ok_or_else(not_found)?;
        if endpoint.api_key_configured {
            self.delete_endpoint_key(id)?;
        }
        endpoints.retain(|e| e.id != id);
        self.store_openai_endpoints(&endpoints).await
    }

    /// Empty clears the credential; keys are never accepted in settings or URLs.
    pub async fn set_openai_endpoint_key(&self, id: &str, key: &str) -> Result<(), CoreError> {
        let _lock = SETTINGS_LOCK.lock().await;
        let mut endpoints = self.get_openai_endpoints().await?;
        let endpoint = endpoints
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(not_found)?;
        let key = key.trim();
        if key.len() > 8192 || key.chars().any(char::is_control) {
            return Err(fail("Enter a valid API key"));
        }
        if key.is_empty() {
            self.delete_endpoint_key(id)?;
        } else {
            self.endpoint_key_entry(id)?
                .set_password(key)
                .map_err(|_| fail("Could not save API key in the system credential store"))?;
        }
        endpoint.api_key_configured = !key.is_empty();
        self.store_openai_endpoints(&endpoints).await
    }

    /// Explicit, read-only model discovery. A successful probe does not promise
    /// Responses/tool-call support; callers may always enter routing aliases.
    pub async fn probe_openai_endpoint(&self, id: &str) -> Result<OpenAiEndpointProbe, CoreError> {
        let lock = SETTINGS_LOCK.lock().await;
        let endpoint = self
            .get_openai_endpoints()
            .await?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(not_found)?;
        let key = self.load_endpoint_key(&endpoint)?;
        drop(lock);
        probe_models(&endpoint.base_url, key.as_deref()).await
    }

    pub(crate) async fn openai_endpoint_models(&self) -> Result<Vec<AgentModelOption>, CoreError> {
        Ok(self
            .get_openai_endpoints()
            .await?
            .into_iter()
            .filter(|e| e.enabled)
            .flat_map(|endpoint| {
                endpoint
                    .models
                    .iter()
                    .map(|model| AgentModelOption {
                        id: selection_id(&endpoint.id, model),
                        label: format!("{} · {}", endpoint.label, model),
                        aliases: vec![model.clone()],
                        family: None,
                        default: false,
                        available: true,
                        source: "openai_compatible".into(),
                        reasoning: vec![],
                        default_reasoning: None,
                        local_provider: Some(LocalModelProviderKind::OpenAiCompatible),
                        local_base_url: Some(endpoint.base_url.clone()),
                    })
                    .collect::<Vec<_>>()
            })
            .collect())
    }

    pub(crate) async fn openai_endpoint_runtime(
        &self,
        selection: &str,
        base_url: Option<&str>,
    ) -> Result<LocalModelRuntime, CoreError> {
        let _lock = SETTINGS_LOCK.lock().await;
        let endpoints = self.get_openai_endpoints().await?;
        let (endpoint, model) = resolve_selection(&endpoints, selection, base_url)?;
        Ok(LocalModelRuntime {
            provider: LocalModelProviderKind::OpenAiCompatible,
            api: endpoint.api,
            model: model.to_string(),
            base_url: Some(endpoint.base_url.clone()),
            api_token: self.load_endpoint_key(endpoint)?,
        })
    }

    async fn store_openai_endpoints(&self, endpoints: &[OpenAiEndpoint]) -> Result<(), CoreError> {
        let value = serde_json::to_string(endpoints)
            .map_err(|_| fail("Could not encode endpoint settings"))?;
        am_db::repos::settings::set(&self.db.pool, SETTINGS_KEY, &value).await?;
        Ok(())
    }

    fn endpoint_key_entry(&self, id: &str) -> Result<Arc<Entry>, CoreError> {
        validate_id(id)?;
        let scope = format!(
            "{:x}",
            Sha256::digest(self.data_dir.to_string_lossy().as_bytes())
        );
        let account = format!("openai-endpoint:{scope}:{id}");
        #[cfg(test)]
        {
            Ok(tests::key_entry(&account))
        }
        #[cfg(not(test))]
        {
            Entry::new(TOKEN_SERVICE, &account)
                .map(Arc::new)
                .map_err(|_| fail("System credential store is unavailable"))
        }
    }

    fn load_endpoint_key(&self, endpoint: &OpenAiEndpoint) -> Result<Option<String>, CoreError> {
        if !endpoint.api_key_configured {
            return Ok(None);
        }
        self.endpoint_key_entry(&endpoint.id)?
            .get_password()
            .map(Some)
            .map_err(|_| {
                fail("Endpoint API key is unavailable. Save it again in Settings → Endpoints.")
            })
    }

    fn delete_endpoint_key(&self, id: &str) -> Result<(), CoreError> {
        match self.endpoint_key_entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(fail(
                "Could not remove endpoint API key from the system credential store",
            )),
        }
    }
}

fn selection_id(endpoint_id: &str, model: &str) -> String {
    format!("perpetual-endpoint/{endpoint_id}/{model}")
}

fn resolve_selection<'a>(
    endpoints: &'a [OpenAiEndpoint],
    selection: &str,
    base_url: Option<&str>,
) -> Result<(&'a OpenAiEndpoint, &'a str), CoreError> {
    for endpoint in endpoints.iter().filter(|e| e.enabled) {
        if base_url != Some(endpoint.base_url.as_str()) {
            continue;
        }
        for model in &endpoint.models {
            if selection_id(&endpoint.id, model) == selection {
                return Ok((endpoint, model));
            }
        }
    }
    Err(fail(
        "This endpoint or model was changed, disabled, or removed. Choose a model again.",
    ))
}

fn normalize_endpoint(mut endpoint: OpenAiEndpoint) -> Result<OpenAiEndpoint, CoreError> {
    validate_id(&endpoint.id)?;
    endpoint.label = endpoint.label.trim().to_string();
    if endpoint.label.is_empty()
        || endpoint.label.len() > 100
        || endpoint.label.chars().any(char::is_control)
    {
        return Err(fail("Enter an endpoint name of 1–100 characters"));
    }
    let url = reqwest::Url::parse(endpoint.base_url.trim())
        .map_err(|_| fail("Enter an HTTP or HTTPS API base URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(fail(
            "Use an HTTP or HTTPS base URL without credentials, query parameters, or fragments",
        ));
    }
    let path = url.path().trim_end_matches('/').to_string();
    if ["/responses", "/chat/completions", "/models"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
    {
        return Err(fail(
            "Enter the API base URL, such as https://gateway.example/v1",
        ));
    }
    endpoint.base_url = url.to_string().trim_end_matches('/').to_string();
    let mut seen = HashSet::new();
    endpoint.models = endpoint
        .models
        .into_iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .filter(|m| seen.insert(m.clone()))
        .collect();
    if endpoint.models.len() > 100
        || endpoint
            .models
            .iter()
            .any(|m| m.len() > 256 || m.chars().any(char::is_control))
    {
        return Err(fail(
            "Enter at most 100 model IDs, each at most 256 characters",
        ));
    }
    Ok(endpoint)
}

fn validate_id(id: &str) -> Result<(), CoreError> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(fail("Invalid endpoint ID"));
    }
    Ok(())
}

async fn probe_models(base_url: &str, key: Option<&str>) -> Result<OpenAiEndpointProbe, CoreError> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| fail("Could not initialize endpoint connection"))?;
    let mut request = http.get(format!("{base_url}/models"));
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| fail("Could not reach endpoint. Check its address and connection."))?;
    if !response.status().is_success() {
        return Err(fail(&format!("Model discovery returned HTTP {}. Check the URL and API key, or enter model IDs manually.", response.status().as_u16())));
    }
    let mut bytes = vec![];
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| fail("Could not read model list"))?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(fail("Endpoint model list is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| fail("Endpoint did not return a JSON model list"))?;
    let data = body["data"]
        .as_array()
        .ok_or_else(|| fail("Endpoint did not return an OpenAI-compatible model list"))?;
    let mut models: Vec<_> = data
        .iter()
        .filter_map(|m| m["id"].as_str())
        .filter(|m| !m.is_empty() && m.len() <= 256 && !m.chars().any(char::is_control))
        .take(100)
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    Ok(OpenAiEndpointProbe { models })
}

fn fail(message: &str) -> CoreError {
    CoreError::Other(message.into())
}
fn not_found() -> CoreError {
    fail("Endpoint was not found")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercise credential CRUD without changing the user's OS keyring or the
    // global keyring builder used by unrelated modules/tests.
    pub(super) fn key_entry(account: &str) -> Arc<Entry> {
        use std::{
            collections::HashMap,
            sync::{Mutex, OnceLock},
        };
        static ENTRIES: OnceLock<Mutex<HashMap<String, Arc<Entry>>>> = OnceLock::new();
        ENTRIES
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .entry(account.into())
            .or_insert_with(|| {
                Arc::new(Entry::new_with_credential(Box::<
                    keyring::mock::MockCredential,
                >::default()))
            })
            .clone()
    }

    fn endpoint(id: &str) -> OpenAiEndpoint {
        OpenAiEndpoint {
            id: id.into(),
            api: am_proto::EndpointApi::Responses,
            label: "Gateway".into(),
            base_url: "https://example.test/v1/".into(),
            models: vec![
                " yolo-auto ".into(),
                "yolo-auto".into(),
                "vendor/Model-A".into(),
            ],
            enabled: true,
            api_key_configured: false,
        }
    }

    #[test]
    fn base_urls_and_models_preserve_gateway_paths_and_case() {
        let endpoint = normalize_endpoint(endpoint("one")).unwrap();
        assert_eq!(endpoint.base_url, "https://example.test/v1");
        assert_eq!(endpoint.models, ["yolo-auto", "vendor/Model-A"]);
        let mut custom = endpoint.clone();
        custom.base_url = "http://localhost:8080/api/openai/v1/".into();
        assert_eq!(
            normalize_endpoint(custom).unwrap().base_url,
            "http://localhost:8080/api/openai/v1"
        );
        let mut encoded = endpoint.clone();
        encoded.base_url = "https://example.test/tenant%2FTeam/API/".into();
        assert_eq!(
            normalize_endpoint(encoded).unwrap().base_url,
            "https://example.test/tenant%2FTeam/API"
        );
    }

    #[tokio::test]
    async fn endpoint_crud_keeps_secrets_separate_and_invalidates_changed_destinations() {
        // UUID plus exclusive creation: an existing path fails the test.
        // nosemgrep: rust.lang.security.temp-dir.temp-dir
        let root = std::env::temp_dir().join(format!("perpetual-endpoints-{}", am_proto::new_id()));
        std::fs::create_dir(&root).unwrap();
        let core = AppCore::new(&root).await.unwrap();
        let mut input = endpoint("one");
        input.api = am_proto::EndpointApi::ChatCompletions;
        input.api_key_configured = true; // Client cannot forge credential state.
        let mut saved = core.save_openai_endpoint(input).await.unwrap();
        assert!(!saved.api_key_configured);
        core.set_openai_endpoint_key("one", "test-only-secret")
            .await
            .unwrap();
        saved = core.get_openai_endpoints().await.unwrap().remove(0);
        assert!(saved.api_key_configured);
        let raw = am_db::repos::settings::get(&core.db.pool, SETTINGS_KEY)
            .await
            .unwrap()
            .unwrap();
        assert!(!raw.contains("test-only-secret"));
        let models = core.openai_endpoint_models().await.unwrap();
        assert_eq!(models[0].label, "Gateway · yolo-auto");
        assert!(!serde_json::to_string(&models)
            .unwrap()
            .contains("test-only-secret"));
        let run = core
            .openai_endpoint_runtime(&models[0].id, models[0].local_base_url.as_deref())
            .await
            .unwrap();
        assert_eq!(run.model, "yolo-auto");
        assert_eq!(run.api, am_proto::EndpointApi::ChatCompletions);
        assert_eq!(run.api_token.as_deref(), Some("test-only-secret"));
        assert!(core
            .local_model_runtime(None, Some(models[0].id.clone()), None)
            .await
            .is_err());
        core.save_openai_endpoint(saved.clone()).await.unwrap();
        assert!(core.get_openai_endpoints().await.unwrap()[0].api_key_configured);
        saved.enabled = false;
        core.save_openai_endpoint(saved.clone()).await.unwrap();
        assert!(core.openai_endpoint_models().await.unwrap().is_empty());
        assert!(core
            .openai_endpoint_runtime(&models[0].id, models[0].local_base_url.as_deref())
            .await
            .is_err());
        saved.enabled = true;
        saved.base_url = "https://other.test/Router".into();
        let saved = core.save_openai_endpoint(saved).await.unwrap();
        assert!(!saved.api_key_configured);
        assert!(matches!(
            core.endpoint_key_entry("one").unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        assert!(core
            .openai_endpoint_runtime(&models[0].id, models[0].local_base_url.as_deref())
            .await
            .is_err());
        assert!(core
            .openai_endpoint_runtime(&models[0].id, Some(&saved.base_url))
            .await
            .unwrap()
            .api_token
            .is_none());
        core.set_openai_endpoint_key("one", "replacement-secret")
            .await
            .unwrap();
        core.set_openai_endpoint_key("one", "").await.unwrap();
        assert!(!core.get_openai_endpoints().await.unwrap()[0].api_key_configured);
        core.set_openai_endpoint_key("one", "replacement-secret")
            .await
            .unwrap();
        core.delete_openai_endpoint("one").await.unwrap();
        assert!(core.get_openai_endpoints().await.unwrap().is_empty());
        assert!(matches!(
            core.endpoint_key_entry("one").unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        core.shutdown().await;
        core.db.pool.close().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn urls_reject_credentials_queries_and_inference_paths_without_echoing_them() {
        for url in [
            "file:///tmp/test",
            "https://user:secret@example.test",
            "https://example.test?key=secret",
            "https://example.test/#secret",
            "https://example.test/v1/responses",
            "https://example.test/v1/chat/completions",
        ] {
            let mut input = endpoint("one");
            input.base_url = url.into();
            let error = normalize_endpoint(input).unwrap_err().to_string();
            assert!(!error.contains("secret"));
        }
    }

    #[test]
    fn identical_models_on_multiple_endpoints_stay_distinct_and_fail_closed() {
        let first = normalize_endpoint(endpoint("one")).unwrap();
        let second = normalize_endpoint(endpoint("two")).unwrap();
        let endpoints = vec![first, second];
        let id = selection_id("two", "vendor/Model-A");
        let (endpoint, model) =
            resolve_selection(&endpoints, &id, Some("https://example.test/v1")).unwrap();
        assert_eq!(endpoint.id, "two");
        assert_eq!(model, "vendor/Model-A");
        assert!(resolve_selection(&endpoints, &id, Some("https://other.test/v1")).is_err());
        let mut endpoints = endpoints;
        endpoints[1].enabled = false;
        assert!(resolve_selection(&endpoints, &id, Some("https://example.test/v1")).is_err());
    }

    #[tokio::test]
    async fn probe_uses_bearer_auth_and_exact_api_base_without_inference() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut input = vec![0; 8192];
            let n = socket.read(&mut input).await.unwrap();
            let request = String::from_utf8_lossy(&input[..n]).to_lowercase();
            assert!(request.starts_with("get /gateway/v1/models "));
            assert!(request.contains("authorization: bearer test-key"));
            let body = r#"{"data":[{"id":"yolo-auto"},{"id":"vendor/Model-A"}]}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let result = probe_models(&format!("http://{address}/gateway/v1"), Some("test-key"))
            .await
            .unwrap();
        assert_eq!(result.models, ["vendor/Model-A", "yolo-auto"]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn probe_rejects_redirects_and_redacts_gateway_error_bodies() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for status in ["302 Found", "401 Unauthorized"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut input = vec![0; 8192];
                socket.read(&mut input).await.unwrap();
                let body = "credential-echo-must-never-appear";
                socket.write_all(format!("HTTP/1.1 {status}\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            let error = probe_models(&format!("http://{address}/v1"), Some("test-key"))
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains(&status[..3]));
            assert!(!error.contains("credential-echo") && !error.contains("test-key"));
            server.await.unwrap();
        }
    }
}
