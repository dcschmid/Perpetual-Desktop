# Perpetual

A desktop workspace for Windows, macOS, and Linux for long-running Codex and Claude Code tasks. Perpetual keeps a task's conversation, workspace, and queued messages together, and when an account reaches its usage limit it continues on your next account.

## Get started

Installer downloads are temporarily paused while signed releases are prepared. Run Perpetual from source using the commands in [Build from source](#build-from-source).

Setup installs Codex CLI if neither Codex nor Claude Code is available. You can also install [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup). Sign in from Perpetual to start running tasks. Existing CLI sign-ins are detected automatically.

## Accounts

- **Several accounts per provider.** Each account you add signs in separately, in its own profile.
- **Switch any time.** Pick the account to use from the sidebar, the composer, or **Accounts**. The next message uses it.
- **Automatic switching.** When an account reaches its usage limit, the task continues on the next ready account in your switching order. If every account is limited, it resumes when the first one resets.

Sign-ins stay on your computer. Setup tokens are stored in Windows Credential Manager, the macOS Keychain, or the Linux kernel keyring, not in Perpetual's database. Linux kernel keyring entries can expire and are cleared on reboot; setup tokens may need to be added again.

## Skills and MCP

Open **Settings → Skills & MCP** to discover existing Codex and Claude Code extensions, import a skill folder, add a stdio or HTTP MCP server, and enable or disable extensions. Choose **Global** for defaults across local projects, or a connected repository for project overrides. Changes apply to the next local task or conversation run.

Perpetual reads Codex skills from `~/.agents/skills`, `$CODEX_HOME/skills` (normally `~/.codex/skills`), and a repository's `.agents/skills`. It reads Claude Code skills from `$CLAUDE_CONFIG_DIR/skills` (normally `~/.claude/skills`) and a repository's `.claude/skills`. Imports include supporting scripts and assets. Plugin and bundled extensions remain managed by their CLI.

MCP servers use native configuration: Codex `config.toml` / project `.codex/config.toml`, and Claude Code `~/.claude.json` / project `.mcp.json`. Custom `CODEX_HOME` and `CLAUDE_CONFIG_DIR` locations are respected. New servers accept environment variable names for credentials. Variables must be available to the desktop app; OAuth login remains a CLI action in the selected account's profile.

Project MCP servers require explicit activation in Perpetual. Changing a server's project configuration requires activating it again. Codex project servers receive the project-specific **CLI name** shown in Settings; use that name for OAuth login and explicit MCP tool references. Their transports are cached as disabled entries in the selected native profile and activated only for the matching run. This keeps credentials out of process arguments and prevents concurrent projects from replacing each other's servers.

Isolated accounts inherit extension configuration and skill folders while keeping their own sign-in credentials. Missing project skills are made available in managed worktrees; generated links use private worktree Git exclusions so they stay out of task commits while the original project files remain available to commit. Existing worktree skill files are preserved. Claude Code local runs use a private, filtered MCP configuration; plugin MCP servers need a direct server entry to participate. Docker and cloud runs continue to use their own installed extensions, configuration and credentials.

## OpenAI-compatible endpoints

Open **Settings → Endpoints → Add endpoint** to configure a gateway name, its API base URL (for example `https://gateway.example/v1`), API protocol, an optional API key, and exact model IDs or routing aliases. Enabled models appear as **Gateway · Model** in the Codex model menu; you can also choose one as the default under **Settings → Models**. Codex CLI must be installed, but a separate OpenAI sign-in is not required for these endpoints.

Choose **Responses** for gateways exposing `/responses`, or **Chat Completions** for gateways exposing `/chat/completions`. Both require SSE streaming and tool calls. The Chat Completions mode runs a session-scoped local adapter, including text/images, function tools, custom tools such as patching, namespaced MCP tools, conversation replay, and usage. Hosted web search and Responses-only features such as encrypted compaction are unavailable in this mode. Interrupted requests are not retried automatically. Existing endpoints keep Responses until you change the protocol.

For [YOLO Auto](https://yolo-auto.com/docs), use base URL **`https://yolo-auto.com/v1`**, protocol **Chat Completions**, your YOLO API key, and a model ID such as **`yolo`** or **`qwen3.8-27b`**. `yolo-auto` is the service name, not a documented model ID. Edit an already saved YOLO endpoint to change its protocol; its saved key is preserved when the URL stays the same.

Perpetual passes the model ID unchanged, so aliases work when the gateway provides them. **Save and discover models** makes a read-only request to `/models`; model IDs can always be entered manually, and discovery alone does not verify inference or tool-call compatibility.

API keys stay in the system credential store, separate from endpoint settings and conversation history. On Linux, kernel keyring entries can expire or disappear on reboot; save the key again if prompted. Leaving the key field blank preserves an existing key. Changing the URL clears it so credentials do not follow an edited address. Disabled or removed endpoints cannot start another run. Endpoint selection is explicit and never becomes an automatic offline fallback; existing cloud sign-ins and CLI configuration remain available.

Custom endpoints currently run through Codex on the local **Host** backend. When a gateway is limited or unavailable, its task pauses for you to retry; its quota does not change your OpenAI account status or trigger account switching. Docker and cloud runs use their own provider configuration and credentials.

## Build from source

Install [Git](https://git-scm.com/downloads) and Node.js 24 LTS (also supported: Node 22.13+ on 22.x, or 26+). Use Windows, macOS, or a glibc-based Linux distribution with WebKitGTK 4.1 (Ubuntu 22.04+, Debian 12+, Linux Mint 21+, or equivalent). Linux source builds support x86_64 and ARM64; CI packages target x86_64. On Windows, [App Installer](https://apps.microsoft.com/detail/9nblggh4nns1) provides `winget` for installing missing system tools.

In PowerShell (Windows) or a terminal (macOS/Linux), clone the repository and run the desktop app:

```sh
git clone --branch dev https://github.com/SakethSripada/Perpetual-Desktop.git
cd Perpetual-Desktop
npm start
```

`npm start` installs missing native build dependencies (Microsoft C++ Build Tools and WebView2 on Windows, Xcode Command Line Tools on macOS, or Tauri's system libraries using apt on Debian/Ubuntu/Mint), rustup, the pinned Rust toolchain, and JavaScript dependencies, then opens the desktop app. Accept the system installation prompts; Linux may request your sudo password, and Windows may request administrator approval or a restart. If a restart is needed, run `npm start` again afterward. The first Rust build takes several minutes. Keep the terminal open while using the app.

If neither coding agent is installed, setup installs Codex CLI in `~/.perpetual/tools` (your user profile on Windows) and makes it available to the app without a global npm installation. Sign in from Perpetual to run tasks. Use `npm run setup` to prepare without launching and `npm run doctor` to check build prerequisites. After setup, `npm run desktop` launches directly without reinstalling dependencies.

For manual setup or managed computers, install [rustup](https://rustup.rs/), plus Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK and WebView2 on Windows, or Xcode Command Line Tools (`xcode-select --install`) on macOS. Then run `npm start`. Rust 1.96.1 is pinned in `rust-toolchain.toml`.

On Debian/Ubuntu/Mint, the Linux system dependencies can also be installed manually:

```sh
sudo apt-get update
sudo apt-get install build-essential pkg-config libwebkit2gtk-4.1-dev libssl-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev curl wget file patchelf dbus xdg-utils
```

For Fedora, Arch, and other distributions, install the corresponding [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) before running setup. Interactive CLI sign-in needs a terminal emulator such as GNOME Terminal, Konsole, Xfce Terminal, or xterm. `dbus-monitor` enables sleep/shutdown detection, and `xdg-open` opens browser sign-in links.

Run `npm run bundle` in that same folder to build an installer or app into `target/release/bundle/`. `npm run dev` opens a browser preview of the interface without the engine. The desktop app also needs a signed-in Codex CLI or Claude Code installation as described above.

Linux builds produce a `.deb` and an `.AppImage`. Install the `.deb` with `sudo apt install ./target/release/bundle/deb/Perpetual_*_amd64.deb`. Alternatively, make the AppImage executable (`chmod +x target/release/bundle/appimage/*.AppImage`) and run it. AppImage may require FUSE 2 (`libfuse2` on Ubuntu 22.04, `libfuse2t64` on Ubuntu 24.04/Mint 22); without it, pass `--appimage-extract-and-run`. The CI builds on Ubuntu 22.04 to keep the minimum glibc version compatible; locally built packages inherit your build system's minimum library versions.

Checks:

```sh
npm test
npm run build
cargo test -p am-core --lib
cargo test -p perpetual-desktop --test persistence
```

Optional checks against installed, signed-in providers (use temporary data and consume provider usage):

```sh
cargo test -p perpetual-desktop --test live_threads -- --ignored --nocapture --test-threads=1
cargo test -p am-daemon --test live_approval -- --ignored --nocapture --test-threads=1
```

Set `PERPETUAL_DATA_DIR` to run the app against a separate data folder while developing.

### Layout

- `src/`: the interface (React, TypeScript, Tailwind, Radix UI)
- `src-tauri/`: the native shell: window, IPC, provider sign-in, and shutdown
- `crates/`: the engine, database, provider adapters, Git worktrees, and protocol
- `landing/`: the website. `npm run record` in that folder re-records its product videos from the real interface with a scripted demo backend.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and report vulnerabilities as described in [SECURITY.md](SECURITY.md). Maintainers: see [RELEASING.md](RELEASING.md).

MIT licensed. Codex and Claude are trademarks of their respective owners. See [NOTICE](NOTICE).
