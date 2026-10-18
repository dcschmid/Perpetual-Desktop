use super::*;

struct Fixture {
    root: PathBuf,
    locations: Locations,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("perpetual-extensions-{}", am_proto::new_id()));
        std::fs::create_dir_all(&root).unwrap();
        let home = root.join("home");
        let locations = Locations {
            codex: home.join(".codex"),
            claude: home.join(".claude"),
            claude_json: home.join(".claude.json"),
            home,
        };
        Self { root, locations }
    }
    fn write(&self, path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    fn skill(&self, path: &Path, name: &str) {
        self.write(
            &path.join("SKILL.md"),
            &format!("---\nname: {name}\ndescription: A useful skill\n---\nRun the helper.\n"),
        );
        self.write(&path.join("scripts/helper.sh"), "echo helper\n");
    }
    fn repo(&self) -> PathBuf {
        let repo = self.root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        checked_git(&repo, &["init"]);
        self.write(&repo.join("README.md"), "test\n");
        checked_git(&repo, &["add", "."]);
        checked_git(
            &repo,
            &[
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "init",
            ],
        );
        repo
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn checked_git(root: &Path, args: &[&str]) -> String {
    let result = git(root, args).unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

#[test]
fn discovery_redacts_credentials_and_requires_project_server_opt_in() {
    let f = Fixture::new();
    let repo = f.root.join("repo");
    f.write(&f.locations.codex.join("config.toml"), "[mcp_servers.service]\nurl='https://secret.invalid/?token=hidden'\nhttp_headers={Authorization='secret-value'}\n");
    f.write(
        &repo.join(".codex/config.toml"),
        "[mcp_servers.service]\ncommand='project-secret-command'\nargs=['private-argument']\n",
    );
    f.skill(&repo.join(".agents/skills/folder"), "actual-name");
    let (mut catalog, raw) = discover(&f.locations, AgentKind::Codex, &[repo]).unwrap();
    assert_eq!(raw[0].value["command"], "project-secret-command");
    assert_eq!(catalog.skills[0].name, "actual-name");
    assert!(!catalog.mcp_servers[0].enabled);
    assert!(catalog.mcp_servers[0].project);
    let encoded = serde_json::to_string(&catalog).unwrap();
    for secret in [
        "hidden",
        "secret-value",
        "project-secret-command",
        "private-argument",
    ] {
        assert!(!encoded.contains(secret));
    }
    let id = catalog.mcp_servers[0].id.clone();
    apply_preferences(
        &mut catalog,
        &Preferences {
            mcp: BTreeMap::from([(id, true)]),
            ..Default::default()
        },
    );
    assert!(catalog.mcp_servers[0].enabled);
    f.write(
        &f.locations.codex.join("config.toml"),
        "token='never-print-this\n",
    );
    let err = read_config(AgentKind::Codex, &f.locations.codex.join("config.toml"))
        .unwrap_err()
        .to_string();
    assert!(err.contains("Invalid TOML"));
    assert!(!err.contains("never-print-this"));
}

#[test]
fn adding_servers_preserves_other_configuration_and_rejects_duplicates() {
    let f = Fixture::new();
    let path = f.locations.codex.join("config.toml");
    f.write(
        &path,
        "# My settings\nmodel = 'my-model' # keep me\n[mcp_servers.existing]\ncommand='existing'\n",
    );
    let mut input = AddMcpServer {
        scope: ExtensionScope {
            agent: AgentKind::Codex,
            repo_id: None,
        },
        name: "new-server".into(),
        transport: "http".into(),
        command: None,
        args: vec![],
        url: Some("https://example.invalid/mcp".into()),
        env_vars: vec![],
        bearer_token_env_var: Some("MCP_TOKEN".into()),
    };
    add_server(&path, &input).unwrap();
    let text = read_text(&path).unwrap();
    assert!(text.contains("# My settings"));
    assert!(text.contains("# keep me"));
    let value = read_config(AgentKind::Codex, &path).unwrap();
    assert_eq!(value["model"], "my-model");
    assert_eq!(value["mcp_servers"]["existing"]["command"], "existing");
    assert_eq!(
        value["mcp_servers"]["new-server"]["bearer_token_env_var"],
        "MCP_TOKEN"
    );
    assert!(add_server(&path, &input).is_err());
    input.scope.agent = AgentKind::ClaudeCode;
    add_server(&f.locations.claude_json, &input).unwrap();
    assert_eq!(
        read_config(input.scope.agent, &f.locations.claude_json).unwrap()["mcpServers"]
            ["new-server"]["headers"]["Authorization"],
        "Bearer ${MCP_TOKEN}"
    );
    input.name = "bad.name".into();
    assert!(add_server(&path, &input).is_err());
    input.name = "valid".into();
    input.bearer_token_env_var = Some("TOKEN=value".into());
    assert!(add_server(&path, &input).is_err());
}

#[test]
fn import_keeps_supporting_files_and_never_replaces_an_existing_skill() {
    let f = Fixture::new();
    let source = f.root.join("my-skill");
    let target = f.root.join("target");
    f.skill(&source, "my-skill");
    import_skill_folder(&source, &target).unwrap();
    assert_eq!(
        read_text(&target.join("my-skill/scripts/helper.sh")).unwrap(),
        "echo helper\n"
    );
    assert!(import_skill_folder(&source, &target).is_err());
    assert!(import_skill_folder(&source, &source.join("nested")).is_err());
    #[cfg(unix)]
    {
        f.write(&f.root.join("outside-secret"), "secret");
        std::os::unix::fs::symlink(f.root.join("outside-secret"), source.join("escape")).unwrap();
        assert!(import_skill_folder(&source, &f.root.join("other-target")).is_err());
        assert!(!f.root.join("other-target/my-skill").exists());
    }
}

#[test]
fn codex_accounts_inherit_only_extensions_and_refresh_removed_servers() {
    let f = Fixture::new();
    let workspace = f.root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let source = f.locations.codex.join("config.toml");
    f.write(&source, "model='global-model'\n[mcp_servers.shared]\ncommand='shared'\nenv={TOKEN='server-secret'}\n");
    f.write(&f.locations.codex.join("auth.json"), "global-auth-secret");
    f.skill(&f.locations.codex.join("skills/build"), "build");
    for name in ["account-a", "account-b"] {
        let home = f.root.join(name);
        f.write(
            &home.join("config.toml"),
            "model='account-model'\n[mcp_servers.private]\ncommand='private'\n",
        );
        f.write(&home.join("auth.json"), name);
        let mut policy = AgentPolicyRuntime {
            launch_env: vec![("CODEX_HOME".into(), home.to_string_lossy().into_owned())],
            ..Default::default()
        };
        prepare_native(
            &f.locations,
            &f.root.join("data"),
            AgentKind::Codex,
            &[],
            &workspace,
            &[],
            &mut policy,
        )
        .unwrap();
        let value = read_config(AgentKind::Codex, &home.join("config.toml")).unwrap();
        assert_eq!(value["model"], "account-model");
        assert_eq!(
            value["mcp_servers"]["shared"]["env"]["TOKEN"],
            "server-secret"
        );
        assert_eq!(value["mcp_servers"]["private"]["command"], "private");
        assert_eq!(read_text(&home.join("auth.json")).unwrap(), name);
        assert!(home.join("skills/build/scripts/helper.sh").is_file());
        assert!(!format!("{policy:?}").contains("server-secret"));
    }
    f.write(
        &source,
        "[mcp_servers.replacement]\ncommand='replacement'\n",
    );
    let home = f.root.join("account-a");
    inherit_codex_mcp(&f.locations, &home).unwrap();
    let value = read_config(AgentKind::Codex, &home.join("config.toml")).unwrap();
    assert!(value["mcp_servers"].get("shared").is_none());
    assert!(value["mcp_servers"].get("replacement").is_some());
    assert!(value["mcp_servers"].get("private").is_some());
}

#[test]
fn worktree_bridges_are_private_and_original_project_files_stay_committable() {
    let f = Fixture::new();
    let repo = f.repo();
    let workspace = f.root.join("worktree");
    checked_git(
        &repo,
        &["worktree", "add", "-b", "task", workspace.to_str().unwrap()],
    );
    f.skill(&repo.join(".agents/skills/review"), "review");
    f.write(
        &repo.join(".codex/config.toml"),
        "[mcp_servers.project]\ncommand='npx'\nargs=['project-server']\n",
    );
    let mut policy = AgentPolicyRuntime::default();
    prepare_native(
        &f.locations,
        &f.root.join("data"),
        AgentKind::Codex,
        &[repo.clone()],
        &workspace,
        &[],
        &mut policy,
    )
    .unwrap();
    assert!(workspace
        .join(".agents/skills/review/scripts/helper.sh")
        .is_file());
    assert!(policy
        .codex_config_overrides
        .iter()
        .any(|v| v.contains("perpetual-disabled-project-server") && v.contains("enabled=false")));
    assert!(checked_git(&workspace, &["status", "--porcelain"]).is_empty());
    let original_status = checked_git(&repo, &["status", "--porcelain"]);
    assert!(original_status.contains(".agents/"));
    assert!(original_status.contains(".codex/"));
    checked_git(&workspace, &["add", "-A"]);
    assert!(checked_git(&workspace, &["diff", "--cached", "--name-only"]).is_empty());
    let base = checked_git(&repo, &["rev-parse", "HEAD"]);
    assert!(am_vcs::worktree_diff(&workspace, base.trim(), 100_000)
        .unwrap()
        .files
        .is_empty());
    std::fs::remove_dir_all(repo.join(".agents/skills/review")).unwrap();
    prepare_native(
        &f.locations,
        &f.root.join("data"),
        AgentKind::Codex,
        &[repo],
        &workspace,
        &[],
        &mut AgentPolicyRuntime::default(),
    )
    .unwrap();
    assert!(std::fs::symlink_metadata(workspace.join(".agents/skills/review")).is_err());
}

#[test]
fn claude_uses_private_filtered_mcp_file_and_native_skill_denials() {
    let f = Fixture::new();
    let repo = f.root.join("repo");
    let workspace = f.root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    f.write(&f.locations.claude_json, r#"{"session":"never-copy-auth","mcpServers":{"global":{"command":"npx","env":{"TOKEN":"private-token"}},"off":{"url":"https://disabled.invalid"}}}"#);
    f.write(
        &repo.join(".mcp.json"),
        r#"{"mcpServers":{"project":{"command":"project-server"}}}"#,
    );
    let skill = f.locations.claude.join("skills/folder");
    f.skill(&skill, "actual-skill-name");
    let profile = f.root.join("account");
    f.write(
        &profile.join(".claude.json"),
        r#"{"session":"account-auth","mcpServers":{"account":{"command":"account-server"}}}"#,
    );
    let mut policy = AgentPolicyRuntime {
        launch_env: vec![(
            "CLAUDE_CONFIG_DIR".into(),
            profile.to_string_lossy().into_owned(),
        )],
        ..Default::default()
    };
    let project_id = discover(&f.locations, AgentKind::ClaudeCode, &[repo.clone()])
        .unwrap()
        .0
        .mcp_servers
        .into_iter()
        .find(|s| s.name == "project")
        .unwrap()
        .id;
    let prefs = Preferences {
        mcp: BTreeMap::from([("global:off".into(), false), (project_id, true)]),
        skills: BTreeMap::from([(skill.to_string_lossy().into_owned(), false)]),
    };
    prepare_native(
        &f.locations,
        &f.root.join("data"),
        AgentKind::ClaudeCode,
        &[repo],
        &workspace,
        &[prefs],
        &mut policy,
    )
    .unwrap();
    let path = policy.claude_mcp_config.as_ref().unwrap();
    let config = read_config(AgentKind::ClaudeCode, path).unwrap();
    for name in ["global", "project", "account"] {
        assert!(config["mcpServers"].get(name).is_some());
    }
    assert!(config["mcpServers"].get("off").is_none());
    assert!(config.get("session").is_none());
    assert!(policy
        .denied_tools
        .contains(&"Skill(actual-skill-name)".into()));
    assert_eq!(
        read_config(AgentKind::ClaudeCode, &profile.join(".claude.json")).unwrap()["session"],
        "account-auth"
    );
    assert!(!format!("{policy:?}").contains("private-token"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn codex_project_transports_are_private_disabled_by_default_and_approval_is_versioned() {
    let f = Fixture::new();
    let repo = f.root.join("project");
    let workspace = f.root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    f.write(
        &repo.join(".codex/config.toml"),
        "[mcp_servers.shared]\ncommand='npx'\nenv={TOKEN='project-secret'}\n",
    );
    let (mut catalog, raw) = discover(&f.locations, AgentKind::Codex, &[repo.clone()]).unwrap();
    apply_preferences(
        &mut catalog,
        &Preferences {
            mcp: BTreeMap::from([("global:shared".into(), true)]),
            ..Default::default()
        },
    );
    assert!(!catalog.mcp_servers[0].enabled);
    let approval = Preferences {
        mcp: BTreeMap::from([(catalog.mcp_servers[0].id.clone(), true)]),
        ..Default::default()
    };
    let mut policy = AgentPolicyRuntime::default();
    prepare_native(
        &f.locations,
        &f.root.join("data"),
        AgentKind::Codex,
        &[repo.clone()],
        &workspace,
        &[approval],
        &mut policy,
    )
    .unwrap();
    let runtime_name = project_server_name(&raw[0]);
    let config = read_config(AgentKind::Codex, &f.locations.codex.join("config.toml")).unwrap();
    assert_eq!(config["mcp_servers"][&runtime_name]["enabled"], false);
    assert_eq!(
        config["mcp_servers"][&runtime_name]["env"]["TOKEN"],
        "project-secret"
    );
    assert!(policy.allowed_mcp_servers.contains(&runtime_name));
    assert!(policy.codex_config_overrides.iter().any(|value| value
        == "mcp_servers.shared={command=\"perpetual-disabled-project-server\",enabled=false}"));
    assert!(!policy
        .codex_config_overrides
        .join(" ")
        .contains("project-secret"));
    assert!(discover(&f.locations, AgentKind::Codex, &[])
        .unwrap()
        .0
        .mcp_servers
        .is_empty());
    f.write(
        &repo.join(".codex/config.toml"),
        "[mcp_servers.shared]\ncommand='changed-unapproved-command'\n",
    );
    let changed = discover(&f.locations, AgentKind::Codex, &[repo]).unwrap().0;
    assert_ne!(changed.mcp_servers[0].id, catalog.mcp_servers[0].id);
    assert!(!changed.mcp_servers[0].enabled);
    let path = f.locations.codex.join("config.toml");
    let mut stale = read_config(AgentKind::Codex, &path).unwrap();
    stale["mcp_servers"][&runtime_name]["enabled"] = json!(true);
    write_config(AgentKind::Codex, &path, &stale, "mcp_servers").unwrap();
    prepare_codex_servers(
        &f.locations,
        None,
        &catalog,
        &[],
        &mut AgentPolicyRuntime::default(),
    )
    .unwrap();
    assert_eq!(
        read_config(AgentKind::Codex, &path).unwrap()["mcp_servers"][&runtime_name]["enabled"],
        false
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(f.locations.codex.join("config.toml"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn codex_skill_overrides_use_the_skill_file_for_native_and_managed_paths() {
    let f = Fixture::new();
    let repo = f.repo();
    let workspace = f.root.join("worktree");
    checked_git(
        &repo,
        &["worktree", "add", "-b", "task", workspace.to_str().unwrap()],
    );
    let skill = repo.join(".agents/skills/review");
    f.skill(&skill, "review");
    let file = skill.join("SKILL.md");
    f.write(
        &f.locations.codex.join("config.toml"),
        &format!(
            "[[skills.config]]\npath={}\nenabled=false\n",
            serde_json::to_string(&file).unwrap()
        ),
    );
    let catalog = discover(&f.locations, AgentKind::Codex, &[repo.clone()])
        .unwrap()
        .0;
    assert!(!catalog.skills[0].enabled);
    let mut policy = AgentPolicyRuntime::default();
    prepare_native(
        &f.locations,
        &f.root.join("data"),
        AgentKind::Codex,
        &[repo],
        &workspace,
        &[],
        &mut policy,
    )
    .unwrap();
    let override_value = policy
        .codex_config_overrides
        .iter()
        .find_map(|v| v.strip_prefix("skills.config="))
        .unwrap();
    let parsed: Value = toml_edit::de::from_str(&format!("skills={override_value}")).unwrap();
    let rules = parsed["skills"].as_array().unwrap();
    for expected in [file, workspace.join(".agents/skills/review/SKILL.md")] {
        assert!(rules
            .iter()
            .any(|v| Path::new(v["path"].as_str().unwrap()) == expected && v["enabled"] == false));
    }
    assert!(rules
        .iter()
        .all(|v| v["path"].as_str().unwrap().ends_with("SKILL.md")));
}

#[test]
fn a_malformed_skill_does_not_block_other_skills_or_agent_preparation() {
    let f = Fixture::new();
    f.skill(&f.locations.codex.join("skills/valid"), "valid");
    f.write(
        &f.locations.codex.join("skills/invalid/SKILL.md"),
        "---\nname: [\ndescription: never-include-this-source-in-an-error\n---\nInstructions\n",
    );
    let catalog = discover(&f.locations, AgentKind::Codex, &[]).unwrap().0;
    assert_eq!(catalog.skills.len(), 1);
    assert_eq!(catalog.warnings.len(), 1);
    assert!(!catalog.warnings[0].contains("never-include"));
    let workspace = f.root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    prepare_native(
        &f.locations,
        &f.root.join("data"),
        AgentKind::Codex,
        &[],
        &workspace,
        &[],
        &mut AgentPolicyRuntime::default(),
    )
    .unwrap();
}

#[test]
fn metadata_supports_windows_newlines_yaml_comments_and_multiline_descriptions() {
    let f = Fixture::new();
    let root = f.locations.claude.join("skills");
    f.write(&root.join("folder/SKILL.md"), "---\r\nname: 'review-pr' # actual CLI name\r\ndescription: >-\r\n  Review a pull request\r\n  with team rules.\r\n---\r\nInstructions\r\n");
    let skills = scan_skills(&root, false, &BTreeMap::new(), &mut vec![]).unwrap();
    assert_eq!(skills[0].name, "review-pr");
    assert_eq!(
        skills[0].description,
        "Review a pull request with team rules."
    );
}

#[cfg(unix)]
#[test]
fn atomic_updates_preserve_user_configuration_symlinks() {
    let f = Fixture::new();
    let actual = f.root.join("dotfiles/config.toml");
    f.write(&actual, "model='existing'\n");
    std::fs::create_dir_all(&f.locations.codex).unwrap();
    let link = f.locations.codex.join("config.toml");
    std::os::unix::fs::symlink(&actual, &link).unwrap();
    private_write(&link, b"model='updated'\n").unwrap();
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(read_text(&actual).unwrap(), "model='updated'\n");
}
