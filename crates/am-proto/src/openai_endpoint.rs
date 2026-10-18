use serde::{Deserialize, Serialize};

/// Wire protocol exposed by a user-owned gateway.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointApi {
    #[default]
    Responses,
    ChatCompletions,
}

/// Non-secret settings for a user-owned OpenAI-compatible gateway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiEndpoint {
    pub id: String,
    pub label: String,
    pub base_url: String,
    #[serde(default)]
    pub api: EndpointApi,
    pub models: Vec<String>,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub api_key_configured: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAiEndpointProbe {
    pub models: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_endpoints_default_to_responses() {
        let endpoint: OpenAiEndpoint = serde_json::from_str(
            r#"{"id":"old","label":"Gateway","base_url":"https://example.test/v1","models":["model"]}"#,
        ).unwrap();
        assert_eq!(endpoint.api, EndpointApi::Responses);
        assert!(endpoint.enabled);
    }
}
