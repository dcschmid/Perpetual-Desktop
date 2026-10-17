//! Native skill discovery and MCP configuration. Account credentials stay in
//! their original profile; only extension configuration is inherited.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use am_agents::AgentPolicyRuntime;
use am_proto::{
    AddMcpServer, AgentKind, ExtensionCatalog, ExtensionScope, McpServerInfo, SetExtensionEnabled,
    SkillInfo,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use toml_edit::Document as DocumentMut;

use crate::{AppCore, CoreError};

#[cfg(test)]
mod tests;

static FILES: Mutex<()> = Mutex::new(());
static PREFERENCES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MAX_CONFIG: u64 = 4 * 1024 * 1024;
const PROJECT_PREFIX: &str = "perpetual_project_";

fn error(message: impl Into<String>) -> CoreError {
    CoreError::Other(message.into())
}
fn io(err: std::io::Error) -> CoreError {
    error(format!("Extension file operation failed: {err}"))
}

#[derive(Clone)]
struct Locations {
    home: PathBuf,
    codex: PathBuf,
    claude: PathBuf,
    claude_json: PathBuf,
}

impl Locations {
    fn system() -> Result<Self, CoreError> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| error("Home directory unavailable"))?;
        let codex = std::env::var_os("CODEX_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let claude_override = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let claude_json = claude_override
            .as_ref()
            .map(|p| p.join(".claude.json"))
            .unwrap_or_else(|| home.join(".claude.json"));
        let claude = claude_override.unwrap_or_else(|| home.join(".claude"));
        Ok(Self {
            home,
            codex,
            claude,
            claude_json,
        })
    }
    fn config(&self, agent: AgentKind, repo: Option<&Path>) -> PathBuf {
        match (agent, repo) {
            (AgentKind::Codex, Some(root)) => root.join(".codex/config.toml"),
            (AgentKind::Codex, None) => self.codex.join("config.toml"),
            (AgentKind::ClaudeCode, Some(root)) => root.join(".mcp.json"),
            (AgentKind::ClaudeCode, None) => self.claude_json.clone(),
            _ => PathBuf::new(), // rejected by the public management API
        }
    }
    fn skills(&self, agent: AgentKind, repo: Option<&Path>) -> Vec<PathBuf> {
        match (agent, repo) {
            (AgentKind::Codex, Some(root)) => vec![root.join(".agents/skills")],
            (AgentKind::ClaudeCode, Some(root)) => vec![root.join(".claude/skills")],
            (AgentKind::Codex, None) => {
                vec![self.home.join(".agents/skills"), self.codex.join("skills")]
            }
            (AgentKind::ClaudeCode, None) => vec![self.claude.join("skills")],
            _ => vec![],
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Preferences {
    #[serde(default)]
    skills: BTreeMap<String, bool>,
    #[serde(default)]
    mcp: BTreeMap<String, bool>,
}

fn preference_key(scope: &ExtensionScope) -> String {
    format!(
        "extensions.{}.{}",
        scope.agent.as_str(),
        scope.repo_id.as_deref().unwrap_or("global")
    )
}

#[derive(Clone)]
struct Server {
    name: String,
    value: Value,
    source: PathBuf,
    project: bool,
}

fn server_id(server: &Server) -> String {
    if server.project {
        let identity = format!(
            "{}:{}:{}",
            server.source.display(),
            server.name,
            server.value
        );
        format!("project:{:x}", Sha256::digest(identity.as_bytes()))
    } else {
        format!("global:{}", server.name)
    }
}

fn project_server_name(server: &Server) -> String {
    let identity = format!("{}:{}", server.source.display(), server.name);
    let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
    format!("{PROJECT_PREFIX}{}", &digest[..16])
}

fn read_text(path: &Path) -> Result<String, CoreError> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(io(e)),
        Ok(meta) if meta.len() > MAX_CONFIG => {
            return Err(error(format!(
                "Extension file is too large: {}",
                path.display()
            )))
        }
        _ => {}
    }
    std::fs::read_to_string(path).map_err(io)
}

fn read_config(agent: AgentKind, path: &Path) -> Result<Value, CoreError> {
    let text = read_text(path)?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    // Parser diagnostics may contain source lines with credentials.
    let value: Value = if agent == AgentKind::Codex {
        toml_edit::de::from_str(&text)
            .map_err(|_| error(format!("Invalid TOML in {}", path.display())))?
    } else {
        serde_json::from_str(&text)
            .map_err(|_| error(format!("Invalid JSON in {}", path.display())))?
    };
    if !value.is_object() {
        return Err(error(format!(
            "Expected a configuration object in {}",
            path.display()
        )));
    }
    Ok(value)
}

fn servers(agent: AgentKind, path: &Path, project: bool) -> Result<Vec<Server>, CoreError> {
    let value = read_config(agent, path)?;
    let key = if agent == AgentKind::Codex {
        "mcp_servers"
    } else {
        "mcpServers"
    };
    Ok(value
        .get(key)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(name, _)| project || !name.starts_with(PROJECT_PREFIX))
        .map(|(name, value)| Server {
            name: name.clone(),
            value: value.clone(),
            source: path.to_owned(),
            project,
        })
        .collect())
}

fn native_skill_overrides(path: &Path) -> Result<BTreeMap<String, bool>, CoreError> {
    Ok(read_config(AgentKind::Codex, path)?
        .pointer("/skills/config")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| {
            Some((
                v.get("path")?.as_str()?.to_string(),
                v.get("enabled")?.as_bool()?,
            ))
        })
        .collect())
}

fn scan_skills(
    root: &Path,
    project: bool,
    native: &BTreeMap<String, bool>,
    warnings: &mut Vec<String>,
) -> Result<Vec<SkillInfo>, CoreError> {
    let entries = match std::fs::read_dir(root) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(io(e)),
    };
    let mut skills = vec![];
    for entry in entries.take(2048) {
        let path = entry.map_err(io)?.path();
        if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with('.'))
        {
            continue;
        }
        if !path.join("SKILL.md").is_file() {
            continue;
        }
        let text = read_text(&path.join("SKILL.md"))?.replace("\r\n", "\n");
        let frontmatter = text
            .trim_start_matches('\u{feff}')
            .strip_prefix("---\n")
            .and_then(|s| s.split_once("\n---").map(|v| v.0))
            .unwrap_or("");
        #[derive(Default, Deserialize)]
        struct Metadata {
            name: Option<String>,
            description: Option<String>,
        }
        if frontmatter.len() > 64 * 1024 {
            warnings.push(format!(
                "Skipped oversized skill metadata in {}",
                path.join("SKILL.md").display()
            ));
            continue;
        }
        let metadata: Metadata = if frontmatter.is_empty() {
            Metadata::default()
        } else {
            match serde_yaml_ng::from_str(frontmatter) {
                Ok(metadata) => metadata,
                Err(_) => {
                    warnings.push(format!(
                        "Skipped invalid skill metadata in {}",
                        path.join("SKILL.md").display()
                    ));
                    continue;
                }
            }
        };
        let name = metadata
            .name
            .as_deref()
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let description = metadata
            .description
            .as_deref()
            .unwrap_or("")
            .chars()
            .take(300)
            .collect();
        let skill_file = path.join("SKILL.md");
        let enabled = native
            .get(skill_file.to_string_lossy().as_ref())
            .or_else(|| {
                skill_file
                    .canonicalize()
                    .ok()
                    .and_then(|p| native.get(p.to_string_lossy().as_ref()))
            })
            .or_else(|| native.get(path.to_string_lossy().as_ref()))
            .copied()
            .unwrap_or(true);
        let path = path.to_string_lossy().into_owned();
        skills.push(SkillInfo {
            name,
            description,
            path,
            project,
            enabled,
        });
    }
    skills.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(skills)
}

fn discover(
    locations: &Locations,
    agent: AgentKind,
    repos: &[PathBuf],
) -> Result<(ExtensionCatalog, Vec<Server>), CoreError> {
    let mut catalog = ExtensionCatalog {
        skills: vec![],
        mcp_servers: vec![],
        locations: vec![],
        warnings: vec![],
    };
    let mut effective = BTreeMap::new();
    let global_config = locations.config(agent, None);
    let mut overrides = if agent == AgentKind::Codex {
        native_skill_overrides(&global_config)?
    } else {
        BTreeMap::new()
    };
    for repo in repos {
        if agent == AgentKind::Codex {
            overrides.extend(native_skill_overrides(
                &locations.config(agent, Some(repo)),
            )?);
        }
    }
    for repo in std::iter::once(None).chain(repos.iter().map(|p| Some(p.as_path()))) {
        let config = locations.config(agent, repo);
        catalog
            .locations
            .push(config.to_string_lossy().into_owned());
        for server in servers(agent, &config, repo.is_some())? {
            effective.insert(server.name.clone(), server);
        }
        for root in locations.skills(agent, repo) {
            catalog.locations.push(root.to_string_lossy().into_owned());
            catalog.skills.extend(scan_skills(
                &root,
                repo.is_some(),
                &overrides,
                &mut catalog.warnings,
            )?);
        }
        if agent == AgentKind::ClaudeCode {
            let settings = repo
                .map(|r| r.join(".claude/settings.json"))
                .unwrap_or_else(|| locations.claude.join("settings.json"));
            let value = read_config(agent, &settings)?;
            if let Some(rules) = value.pointer("/permissions/deny").and_then(Value::as_array) {
                for skill in &mut catalog.skills {
                    if rules.iter().filter_map(Value::as_str).any(|rule| {
                        rule == "Skill"
                            || rule == format!("Skill({})", skill.name)
                            || rule == format!("Skill({} *)", skill.name)
                    }) {
                        skill.enabled = false;
                    }
                }
            }
            if let Some(root) = repo {
                let local = read_config(agent, &locations.claude_json)?;
                if let Some(map) = local
                    .get("projects")
                    .and_then(|v| v.get(root.to_string_lossy().as_ref()))
                    .and_then(|v| v.get("mcpServers"))
                    .and_then(Value::as_object)
                {
                    for (name, value) in map {
                        effective.insert(
                            name.clone(),
                            Server {
                                name: name.clone(),
                                value: value.clone(),
                                source: locations.claude_json.clone(),
                                project: true,
                            },
                        );
                    }
                }
            }
        }
    }
    let entries: Vec<_> = effective.into_values().collect();
    for server in &entries {
        catalog.mcp_servers.push(McpServerInfo {
            id: server_id(server),
            name: server.name.clone(),
            runtime_name: if agent == AgentKind::Codex && server.project {
                project_server_name(server)
            } else {
                server.name.clone()
            },
            transport: if server.value.get("url").is_some() {
                server
                    .value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("http")
                    .into()
            } else {
                "stdio".into()
            },
            source: server.source.to_string_lossy().into_owned(),
            project: server.project,
            enabled: !server.project
                && server
                    .value
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
        });
    }
    Ok((catalog, entries))
}

fn apply_preferences(catalog: &mut ExtensionCatalog, prefs: &Preferences) {
    for skill in &mut catalog.skills {
        if let Some(v) = prefs.skills.get(&skill.path) {
            skill.enabled = *v;
        }
    }
    for server in &mut catalog.mcp_servers {
        if let Some(v) = prefs.mcp.get(&server.id) {
            server.enabled = *v;
        }
    }
}

impl AppCore {
    async fn extension_repo(&self, scope: &ExtensionScope) -> Result<Option<PathBuf>, CoreError> {
        if !matches!(scope.agent, AgentKind::Codex | AgentKind::ClaudeCode) {
            return Err(error("Extension management supports Codex and Claude Code"));
        }
        match &scope.repo_id {
            None => Ok(None),
            Some(id) => {
                let repo = am_db::repos::repo::get(&self.db.pool, id)
                    .await?
                    .ok_or(CoreError::NotFound)?;
                let root = repo.local_path.ok_or_else(|| {
                    error("Connect a local repository to manage project extensions")
                })?;
                std::fs::canonicalize(root).map(Some).map_err(io)
            }
        }
    }
    async fn extension_preferences(
        &self,
        scope: &ExtensionScope,
    ) -> Result<Preferences, CoreError> {
        am_db::repos::settings::get(&self.db.pool, &preference_key(scope))
            .await?
            .map(|v| {
                serde_json::from_str(&v).map_err(|_| error("Invalid saved extension preferences"))
            })
            .unwrap_or_else(|| Ok(Preferences::default()))
    }
    pub async fn list_extensions(
        &self,
        scope: ExtensionScope,
    ) -> Result<ExtensionCatalog, CoreError> {
        let repo = self.extension_repo(&scope).await?;
        let mut catalog = discover(
            &Locations::system()?,
            scope.agent,
            &repo.into_iter().collect::<Vec<_>>(),
        )?
        .0;
        apply_preferences(
            &mut catalog,
            &self
                .extension_preferences(&ExtensionScope {
                    agent: scope.agent,
                    repo_id: None,
                })
                .await?,
        );
        if scope.repo_id.is_some() {
            apply_preferences(&mut catalog, &self.extension_preferences(&scope).await?);
        }
        Ok(catalog)
    }
    pub async fn set_extension_enabled(&self, input: SetExtensionEnabled) -> Result<(), CoreError> {
        let _guard = PREFERENCES.lock().await;
        let catalog = self.list_extensions(input.scope.clone()).await?;
        let mut prefs = self.extension_preferences(&input.scope).await?;
        match input.kind.as_str() {
            "skill" if catalog.skills.iter().any(|v| v.path == input.id) => {
                prefs.skills.insert(input.id, input.enabled);
            }
            "mcp" if catalog.mcp_servers.iter().any(|v| v.id == input.id) => {
                prefs.mcp.insert(input.id, input.enabled);
            }
            _ => return Err(error("Unknown extension")),
        }
        am_db::repos::settings::set(
            &self.db.pool,
            &preference_key(&input.scope),
            &serde_json::to_string(&prefs)
                .map_err(|_| error("Could not save extension preferences"))?,
        )
        .await?;
        Ok(())
    }
    pub async fn import_skill(
        &self,
        scope: ExtensionScope,
        source: String,
    ) -> Result<(), CoreError> {
        let repo = self.extension_repo(&scope).await?;
        let locations = Locations::system()?;
        let destination = locations.skills(scope.agent, repo.as_deref()).remove(0);
        tokio::task::spawn_blocking(move || {
            let _guard = FILES
                .lock()
                .map_err(|_| error("Extension configuration lock unavailable"))?;
            import_skill_folder(Path::new(&source), &destination)
        })
        .await
        .map_err(|_| error("Skill import failed"))?
    }
    pub async fn add_mcp_server(&self, input: AddMcpServer) -> Result<(), CoreError> {
        let repo = self.extension_repo(&input.scope).await?;
        let path = Locations::system()?.config(input.scope.agent, repo.as_deref());
        let _guard = FILES
            .lock()
            .map_err(|_| error("Extension configuration lock unavailable"))?;
        add_server(&path, &input)
    }

    /// Host adapters keep their native discovery/trust behavior. Bridge only
    /// missing project files, and inherit only extension data into account homes.
    pub(crate) async fn prepare_extensions(
        &self,
        agent: AgentKind,
        repo_ids: &[String],
        workspace: &Path,
        policy: &mut AgentPolicyRuntime,
    ) -> Result<(), CoreError> {
        if !matches!(agent, AgentKind::Codex | AgentKind::ClaudeCode) {
            return Ok(());
        }
        let locations = Locations::system()?;
        let mut repos = vec![];
        let mut prefs = vec![
            self.extension_preferences(&ExtensionScope {
                agent,
                repo_id: None,
            })
            .await?,
        ];
        for id in repo_ids {
            if let Some(root) = self
                .extension_repo(&ExtensionScope {
                    agent,
                    repo_id: Some(id.clone()),
                })
                .await?
            {
                repos.push(root);
                prefs.push(
                    self.extension_preferences(&ExtensionScope {
                        agent,
                        repo_id: Some(id.clone()),
                    })
                    .await?,
                );
            }
        }
        let data_dir = self.data_dir.clone();
        let workspace = workspace.to_owned();
        let mut prepared = policy.clone();
        prepared = tokio::task::spawn_blocking(move || {
            let _guard = FILES
                .lock()
                .map_err(|_| error("Extension configuration lock unavailable"))?;
            prepare_native(
                &locations,
                &data_dir,
                agent,
                &repos,
                &workspace,
                &prefs,
                &mut prepared,
            )?;
            Ok::<_, CoreError>(prepared)
        })
        .await
        .map_err(|_| error("Extension preparation failed"))??;
        *policy = prepared;
        Ok(())
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn valid_env(name: &str) -> bool {
    valid_name(name) && !name.contains('-') && !name.as_bytes()[0].is_ascii_digit()
}

fn add_server(path: &Path, input: &AddMcpServer) -> Result<(), CoreError> {
    if !valid_name(&input.name)
        || input.name == "perpetual"
        || input.name.starts_with(PROJECT_PREFIX)
    {
        return Err(error(
            "Use a unique server name containing letters, numbers, underscores or hyphens",
        ));
    }
    if input.env_vars.iter().any(|v| !valid_env(v))
        || input
            .bearer_token_env_var
            .as_ref()
            .is_some_and(|v| !valid_env(v))
    {
        return Err(error("Invalid environment variable name"));
    }
    let codex = input.scope.agent == AgentKind::Codex;
    let value = match input.transport.as_str() {
        "stdio" => {
            let command = input
                .command
                .as_deref()
                .filter(|v| !v.trim().is_empty() && !v.contains(['\n', '\r', '\0']))
                .ok_or_else(|| error("A command is required"))?;
            if input.args.iter().any(|v| v.contains('\0')) {
                return Err(error("Invalid command argument"));
            }
            if codex {
                json!({"command":command,"args":input.args,"env_vars":input.env_vars})
            } else {
                json!({"type":"stdio","command":command,"args":input.args,"env":input.env_vars.iter().map(|v| (v.clone(), Value::String(format!("${{{v}}}")))).collect::<serde_json::Map<_,_>>()})
            }
        }
        "http" => {
            let url = input
                .url
                .as_deref()
                .ok_or_else(|| error("An HTTP URL is required"))?;
            let parsed = reqwest::Url::parse(url).map_err(|_| error("Invalid HTTP URL"))?;
            if !["http", "https"].contains(&parsed.scheme()) || parsed.host_str().is_none() {
                return Err(error("Use an http:// or https:// URL"));
            }
            let mut value = if codex {
                json!({"url":url})
            } else {
                json!({"type":"http","url":url})
            };
            if let Some(env) = &input.bearer_token_env_var {
                if codex {
                    value["bearer_token_env_var"] = json!(env);
                } else {
                    value["headers"] = json!({"Authorization":format!("Bearer ${{{env}}}")});
                }
            }
            value
        }
        _ => return Err(error("Choose stdio or HTTP transport")),
    };
    let key = if codex { "mcp_servers" } else { "mcpServers" };
    let mut config = read_config(input.scope.agent, path)?;
    if config.get(key).and_then(|v| v.get(&input.name)).is_some() {
        return Err(error(
            "A server with this name already exists in this scope",
        ));
    }
    if config.get(key).is_some_and(|v| !v.is_object()) {
        return Err(error("The MCP configuration must be a table or object"));
    }
    if !config.get(key).is_some_and(Value::is_object) {
        config[key] = json!({});
    }
    config[key][&input.name] = value;
    write_config(input.scope.agent, path, &config, key)
}

fn private_write(path: &Path, contents: &[u8]) -> Result<(), CoreError> {
    let resolved;
    let path = if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        resolved = path.canonicalize().map_err(io)?;
        resolved.as_path()
    } else {
        path
    };
    let parent = path
        .parent()
        .ok_or_else(|| error("Invalid extension path"))?;
    std::fs::create_dir_all(parent).map_err(io)?;
    // A unique sibling permits atomic replacement without truncating the old file.
    let temporary = parent.join(format!(".perpetual-{}.tmp", am_proto::new_id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        use std::io::Write;
        let mut file = options.open(&temporary).map_err(io)?;
        file.write_all(contents).map_err(io)?;
        file.sync_all().map_err(io)?;
        std::fs::rename(&temporary, path).map_err(io)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn write_config(agent: AgentKind, path: &Path, value: &Value, key: &str) -> Result<(), CoreError> {
    if agent == AgentKind::Codex {
        let old = read_text(path)?;
        let mut document = old
            .parse::<DocumentMut>()
            .map_err(|_| error(format!("Invalid TOML in {}", path.display())))?;
        let serialized = toml_edit::ser::to_string(value)
            .map_err(|_| error("Could not encode extension configuration"))?;
        let new = serialized
            .parse::<DocumentMut>()
            .map_err(|_| error("Could not encode extension configuration"))?;
        if let Some(item) = new.get(key) {
            document[key] = item.clone();
        }
        private_write(path, document.to_string().as_bytes())
    } else {
        private_write(
            path,
            &serde_json::to_vec_pretty(value)
                .map_err(|_| error("Could not encode extension configuration"))?,
        )
    }
}

fn import_skill_folder(source: &Path, root: &Path) -> Result<(), CoreError> {
    let source = std::fs::canonicalize(source).map_err(io)?;
    if !source.join("SKILL.md").is_file() {
        return Err(error("Choose a skill folder containing SKILL.md"));
    }
    read_text(&source.join("SKILL.md"))?;
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .filter(|v| valid_name(v))
        .ok_or_else(|| error("Invalid skill folder name"))?;
    std::fs::create_dir_all(root).map_err(io)?;
    let destination = root.join(name);
    if std::fs::symlink_metadata(&destination).is_ok() {
        return Err(error("A skill with this folder name already exists"));
    }
    if root.canonicalize().map_err(io)?.starts_with(&source) {
        return Err(error("The destination must be outside the source skill"));
    }
    let temporary = root.join(format!(".perpetual-{}", am_proto::new_id()));
    let result = copy_skill(&source, &source, &temporary, 0, &mut (0, 0))
        .and_then(|_| std::fs::rename(&temporary, &destination).map_err(io));
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    result
}

fn copy_skill(
    root: &Path,
    source: &Path,
    destination: &Path,
    depth: usize,
    budget: &mut (u64, u64),
) -> Result<(), CoreError> {
    if depth > 24 {
        return Err(error("Skill directory nesting is too deep"));
    }
    let source = source.canonicalize().map_err(io)?;
    if !source.starts_with(root) {
        return Err(error("Skill links must stay within the selected folder"));
    }
    let metadata = std::fs::metadata(&source).map_err(io)?;
    budget.0 += 1;
    budget.1 += metadata.len();
    if budget.0 > 4096 || budget.1 > 64 * 1024 * 1024 {
        return Err(error("Skill exceeds the import limit (4096 files / 64 MB)"));
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(destination).map_err(io)?;
        for entry in std::fs::read_dir(source).map_err(io)? {
            let entry = entry.map_err(io)?;
            copy_skill(
                root,
                &entry.path(),
                &destination.join(entry.file_name()),
                depth + 1,
                budget,
            )?;
        }
    } else if metadata.is_file() {
        std::fs::copy(source, destination).map_err(io)?;
    } else {
        return Err(error(
            "Skills may contain only regular files and directories",
        ));
    }
    Ok(())
}

fn prepare_native(
    locations: &Locations,
    data_dir: &Path,
    agent: AgentKind,
    repos: &[PathBuf],
    workspace: &Path,
    prefs: &[Preferences],
    policy: &mut AgentPolicyRuntime,
) -> Result<(), CoreError> {
    let (mut catalog, servers) = discover(locations, agent, repos)?;
    for prefs in prefs {
        apply_preferences(&mut catalog, prefs);
    }
    let profile = policy
        .launch_env
        .iter()
        .find(|(key, _)| {
            key == if agent == AgentKind::Codex {
                "CODEX_HOME"
            } else {
                "CLAUDE_CONFIG_DIR"
            }
        })
        .map(|(_, v)| PathBuf::from(v));
    if agent == AgentKind::Codex {
        if let Some(profile) = &profile {
            if *profile != locations.codex {
                inherit_codex_mcp(locations, profile)?;
            }
        }
    }
    let relative_skills = if agent == AgentKind::Codex {
        ".agents/skills"
    } else {
        ".claude/skills"
    };
    let identity = format!("{}:{:?}:{}", workspace.display(), profile, agent.as_str());
    let manifest = data_dir
        .join("extensions/bridges")
        .join(format!("{:x}.json", Sha256::digest(identity.as_bytes())));
    let old_bridges = read_config(AgentKind::ClaudeCode, &manifest)?;
    let mut bridges = serde_json::Map::new();
    let mut skill_config = vec![];
    for skill in &catalog.skills {
        let source = PathBuf::from(&skill.path);
        let name = source
            .file_name()
            .ok_or_else(|| error("Invalid skill path"))?;
        let collision = catalog
            .skills
            .iter()
            .filter(|other| {
                other.project == skill.project && Path::new(&other.path).file_name() == Some(name)
            })
            .count()
            > 1;
        let name = if collision {
            format!(
                "{}-{:x}",
                name.to_string_lossy(),
                Sha256::digest(skill.path.as_bytes())
            )
        } else {
            name.to_string_lossy().into_owned()
        };
        let destination = if skill.project {
            Some(workspace.join(relative_skills).join(&name))
        } else {
            profile.as_ref().map(|p| p.join("skills").join(&name))
        };
        if let Some(destination) = &destination {
            if *destination != source {
                let key = destination.to_string_lossy().into_owned();
                if let Some(previous) = old_bridges.get(&key) {
                    remove_owned_bridge(destination, previous)?;
                }
                if bridge_skill(&source, destination, workspace)? {
                    bridges.insert(
                        key,
                        json!({"source":source,"hash":skill_fingerprint(destination)?}),
                    );
                }
            }
            let file = destination.join("SKILL.md");
            skill_config.push(json!({"path":file,"enabled":skill.enabled}));
            if let Ok(canonical) = file.canonicalize() {
                if canonical != file {
                    skill_config.push(json!({"path":canonical,"enabled":skill.enabled}));
                }
            }
        }
        let file = source.join("SKILL.md");
        skill_config.push(json!({"path":file,"enabled":skill.enabled}));
        if let Ok(canonical) = file.canonicalize() {
            if canonical != file {
                skill_config.push(json!({"path":canonical,"enabled":skill.enabled}));
            }
        }
        if agent == AgentKind::ClaudeCode && !skill.enabled {
            policy.denied_tools.push(format!("Skill({})", skill.name));
        }
    }
    for (destination, previous) in old_bridges.as_object().unwrap() {
        if !bridges.contains_key(destination) {
            remove_owned_bridge(Path::new(destination), previous)?;
        }
    }
    private_write(
        &manifest,
        &serde_json::to_vec(&bridges).map_err(|_| error("Could not save skill bridge metadata"))?,
    )?;
    if agent == AgentKind::Codex {
        if !skill_config.is_empty() {
            let values = skill_config
                .iter()
                .map(|v| {
                    format!(
                        "{{path={},enabled={}}}",
                        serde_json::to_string(v.get("path").unwrap()).unwrap(),
                        v["enabled"]
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            policy
                .codex_config_overrides
                .push(format!("skills.config=[{values}]"));
        }
        prepare_codex_servers(locations, profile.as_deref(), &catalog, &servers, policy)?;
    } else {
        let enabled: BTreeSet<_> = catalog
            .mcp_servers
            .iter()
            .filter(|s| s.enabled)
            .map(|s| s.name.as_str())
            .collect();
        let mut map = servers
            .into_iter()
            .filter(|s| enabled.contains(s.name.as_str()))
            .map(|s| (s.name, s.value))
            .collect::<serde_json::Map<_, _>>();
        // An isolated account can also have native account-specific servers.
        if let Some(profile) = &profile {
            for server in self::servers(agent, &profile.join(".claude.json"), false)? {
                if !catalog
                    .mcp_servers
                    .iter()
                    .any(|s| s.name == server.name && (!s.enabled || s.project))
                {
                    map.insert(server.name, server.value);
                }
            }
        }
        let identity = format!("{}:{:?}", workspace.display(), profile);
        let path = data_dir
            .join("extensions/runtime")
            .join(format!("{:x}.json", Sha256::digest(identity.as_bytes())));
        private_write(
            &path,
            &serde_json::to_vec(&json!({"mcpServers":map}))
                .map_err(|_| error("Could not prepare MCP configuration"))?,
        )?;
        policy.claude_mcp_config = Some(path);
    }
    Ok(())
}

fn inherit_codex_mcp(locations: &Locations, profile: &Path) -> Result<(), CoreError> {
    let source = read_config(AgentKind::Codex, &locations.codex.join("config.toml"))?;
    let destination = profile.join("config.toml");
    let manifest = profile.join("perpetual-inherited-mcp.json");
    let previous = read_config(AgentKind::ClaudeCode, &manifest)?;
    let mut config = read_config(AgentKind::Codex, &destination)?;
    if config.get("mcp_servers").is_some_and(|v| !v.is_object()) {
        return Err(error("The account MCP configuration must be a table"));
    }
    if !config.get("mcp_servers").is_some_and(Value::is_object) {
        config["mcp_servers"] = json!({});
    }
    let map = config["mcp_servers"].as_object_mut().unwrap();
    for (name, value) in previous.as_object().unwrap() {
        if map.get(name) == Some(value) {
            map.remove(name);
        }
    }
    let mut inherited = serde_json::Map::new();
    for (name, value) in source
        .get("mcp_servers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if name.starts_with(PROJECT_PREFIX) {
            continue;
        }
        if !map.contains_key(name) {
            map.insert(name.clone(), value.clone());
            inherited.insert(name.clone(), value.clone());
        }
    }
    write_config(AgentKind::Codex, &destination, &config, "mcp_servers")?;
    private_write(
        &manifest,
        &serde_json::to_vec(&inherited)
            .map_err(|_| error("Could not save inheritance metadata"))?,
    )
}

// Register project transports as disabled native entries. Per-launch flags
// activate only explicitly approved entries. Credentials stay out of argv, and
// simultaneous projects cannot replace each other's server configuration.
fn prepare_codex_servers(
    locations: &Locations,
    profile: Option<&Path>,
    catalog: &ExtensionCatalog,
    servers: &[Server],
    policy: &mut AgentPolicyRuntime,
) -> Result<(), CoreError> {
    let path = profile.unwrap_or(&locations.codex).join("config.toml");
    let mut config = read_config(AgentKind::Codex, &path)?;
    let before = config.clone();
    if let Some(map) = config.get_mut("mcp_servers").and_then(Value::as_object_mut) {
        for (name, value) in map {
            if name.starts_with(PROJECT_PREFIX) && value.is_object() {
                value["enabled"] = json!(false);
            }
        }
    }
    for server in servers {
        // Codex -c uses dot-separated paths, not TOML quoted-key parsing.
        if !valid_name(&server.name) {
            return Err(error(format!("Rename Codex MCP server '{}' using only letters, numbers, underscores or hyphens before running it in Perpetual", server.name)));
        }
        let info = catalog
            .mcp_servers
            .iter()
            .find(|s| s.id == server_id(server))
            .ok_or_else(|| error("Missing MCP metadata"))?;
        if server.project {
            // A partial enabled=false override is invalid when native project
            // configuration is not trusted. Supply a complete disabled entry.
            let key = &server.name;
            policy.codex_config_overrides.push(format!(
                "mcp_servers.{key}={{command=\"perpetual-disabled-project-server\",enabled=false}}"
            ));
            if info.enabled {
                let name = project_server_name(server);
                if config.get("mcp_servers").is_some_and(|v| !v.is_object()) {
                    return Err(error("The MCP configuration must be a table"));
                }
                if !config.get("mcp_servers").is_some_and(Value::is_object) {
                    config["mcp_servers"] = json!({});
                }
                let mut value = server.value.clone();
                value["enabled"] = json!(false);
                config["mcp_servers"][&name] = value;
                policy.allowed_mcp_servers.push(name);
            }
        } else if !info.enabled {
            policy.denied_mcp_servers.push(server.name.clone());
        } else {
            policy.allowed_mcp_servers.push(server.name.clone());
        }
    }
    if config != before {
        write_config(AgentKind::Codex, &path, &config, "mcp_servers")?;
    }
    Ok(())
}

fn bridge_skill(source: &Path, destination: &Path, workspace: &Path) -> Result<bool, CoreError> {
    if std::fs::symlink_metadata(destination).is_ok() {
        return Ok(false);
    }
    if let Ok(relative) = destination.strip_prefix(workspace) {
        // Do not resurrect a tracked skill deliberately deleted in the worktree.
        let tracked = git(workspace, &["ls-files", "--", &relative.to_string_lossy()])?;
        if tracked.status.success() && !tracked.stdout.is_empty() {
            return Ok(false);
        }
        exclude_generated(workspace, &relative.to_string_lossy().replace('\\', "/"))?;
    }
    std::fs::create_dir_all(destination.parent().unwrap()).map_err(io)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, destination).map_err(io)?;
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(source, destination).is_err() {
            copy_skill(source, source, destination, 0, &mut (0, 0))?;
        }
    }
    Ok(true)
}

// Fingerprints protect a copied bridge edited by an agent or user on Windows.
// Unix symlinks need only an ownership/target check and no recursive hashing.
fn skill_fingerprint(path: &Path) -> Result<String, CoreError> {
    if std::fs::symlink_metadata(path)
        .map_err(io)?
        .file_type()
        .is_symlink()
    {
        return Ok(String::new());
    }
    fn visit(
        path: &Path,
        hasher: &mut Sha256,
        count: &mut (usize, u64),
        depth: usize,
    ) -> Result<(), CoreError> {
        count.0 += 1;
        if count.0 > 4096 || depth > 24 {
            return Err(error("Skill bridge exceeds the file limit"));
        }
        let meta = std::fs::symlink_metadata(path).map_err(io)?;
        count.1 += meta.len();
        if count.1 > 64 * 1024 * 1024 {
            return Err(error("Skill bridge exceeds the size limit"));
        }
        if meta.file_type().is_symlink() {
            return Err(error("Copied skill bridge contains an unexpected link"));
        }
        if meta.is_dir() {
            let mut entries = std::fs::read_dir(path)
                .map_err(io)?
                .map(|e| e.map(|e| e.path()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(io)?;
            entries.sort();
            for entry in entries {
                hasher.update(entry.file_name().unwrap().to_string_lossy().as_bytes());
                visit(&entry, hasher, count, depth + 1)?;
            }
        } else if meta.is_file() {
            use std::io::Read;
            let mut file = std::fs::File::open(path).map_err(io)?;
            let mut buffer = [0; 8192];
            loop {
                let len = file.read(&mut buffer).map_err(io)?;
                if len == 0 {
                    break;
                }
                hasher.update(&buffer[..len]);
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    visit(path, &mut hash, &mut (0, 0), 0)?;
    Ok(format!("{:x}", hash.finalize()))
}

fn remove_owned_bridge(path: &Path, previous: &Value) -> Result<(), CoreError> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if meta.file_type().is_symlink() {
        if std::fs::read_link(path).map_err(io)?.to_string_lossy()
            == previous["source"].as_str().unwrap_or("")
        {
            #[cfg(windows)]
            std::fs::remove_dir(path).map_err(io)?;
            #[cfg(not(windows))]
            std::fs::remove_file(path).map_err(io)?;
        }
    } else if meta.is_dir()
        && skill_fingerprint(path).is_ok_and(|hash| hash == previous["hash"].as_str().unwrap_or(""))
    {
        std::fs::remove_dir_all(path).map_err(io)?;
    }
    Ok(())
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, CoreError> {
    let mut command = std::process::Command::new("git");
    command.arg("-C").arg(root).args(args);
    am_proto::hide_console(&mut command);
    command.output().map_err(io)
}

fn exclude_generated(workspace: &Path, relative: &str) -> Result<(), CoreError> {
    let output = git(workspace, &["rev-parse", "--absolute-git-dir"])?;
    if !output.status.success() {
        return Ok(());
    } // multi-repository workspace container
    let git_dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let path = git_dir.join("perpetual-extension-excludes");
    // info/exclude is shared by linked worktrees. Keep these rules private so
    // the original project's new skill/config files remain available to commit.
    let core_worktree = git(workspace, &["config", "--local", "--get", "core.worktree"])?;
    let bare = git(workspace, &["config", "--local", "--get", "core.bare"])?;
    if core_worktree.status.success() || String::from_utf8_lossy(&bare.stdout).trim() == "true" {
        return Err(error("Cannot create private extension exclusions for a repository with core.worktree or core.bare set"));
    }
    if !path.exists() {
        let previous = git(
            workspace,
            &["config", "--path", "--get", "core.excludesFile"],
        )?;
        if previous.status.success() {
            let previous = PathBuf::from(String::from_utf8_lossy(&previous.stdout).trim());
            let previous = if previous.is_absolute() {
                previous
            } else {
                workspace.join(previous)
            };
            private_write(&path, read_text(&previous)?.as_bytes())?;
        }
    }
    let mut text = read_text(&path)?;
    let escaped = relative
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace('*', "\\*")
        .replace('?', "\\?")
        .replace(' ', "\\ ");
    let rule = format!("/{escaped}");
    if !text.lines().any(|line| line == rule) {
        text.push_str(&format!("\n# Perpetual local extension bridge\n{rule}\n"));
        private_write(&path, text.as_bytes())?;
    }
    for args in [
        vec!["config", "--local", "extensions.worktreeConfig", "true"],
        vec![
            "config",
            "--worktree",
            "core.excludesFile",
            path.to_str()
                .ok_or_else(|| error("Invalid Git configuration path"))?,
        ],
    ] {
        if !git(workspace, &args)?.status.success() {
            return Err(error("Could not configure private worktree exclusions"));
        }
    }
    Ok(())
}
