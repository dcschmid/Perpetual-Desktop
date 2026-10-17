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
