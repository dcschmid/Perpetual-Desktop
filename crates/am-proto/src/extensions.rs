use serde::{Deserialize, Serialize};

use crate::AgentKind;

/// A repository is the native CLI configuration boundary within a project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionScope {
    pub agent: AgentKind,
    pub repo_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: String,
    pub project: bool,
    pub enabled: bool,
}

/// Deliberately excludes environment values, headers and command arguments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerInfo {
    pub id: String,
    pub name: String,
    pub runtime_name: String,
    pub transport: String,
    pub source: String,
    pub project: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionCatalog {
    pub skills: Vec<SkillInfo>,
    pub mcp_servers: Vec<McpServerInfo>,
    pub locations: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetExtensionEnabled {
    pub scope: ExtensionScope,
    pub kind: String,
    /// Skill path or MCP server ID returned by list_extensions.
    pub id: String,
    pub enabled: bool,
}

/// Environment references only: secret values never cross this API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddMcpServer {
    pub scope: ExtensionScope,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub env_vars: Vec<String>,
    pub bearer_token_env_var: Option<String>,
}
