use serde::{Deserialize, Serialize};

/// Non-secret settings for a user-owned OpenAI Responses-compatible gateway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiEndpoint {
    pub id: String,
    pub label: String,
    pub base_url: String,
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
