# Releasing Perpetual

## Cut a release

1. Set the same version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, and run `npm install` so `package-lock.json` follows.
2. Commit, then tag and push:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. The **Release** workflow builds the Windows installer, a universal macOS app, and Linux x86_64 `.deb` and `.AppImage` packages. It signs Windows/macOS builds when configured, checks their signatures, writes `SHA256SUMS.txt` for all packages, records build provenance attestations, and opens a **draft** GitHub release.
4. Download the packages from the draft, install them on clean accounts on each supported platform, and run through the checklist below. Then publish the draft.

The Check workflow also uploads Windows, universal macOS, and Linux x86_64 packages for each tested commit, including `dev`, so you can test a candidate before tagging. Linux packages are built on Ubuntu 22.04 and require Ubuntu 22.04 / Debian 12 or newer, or a comparable glibc-based distribution. ARM64 Linux can be built from source but is not packaged by CI.

To rebuild an unpublished draft, run the Release workflow manually and enter its tag. This updates the draft assets and matching checksums. Published releases are immutable: use a new version instead. Publishing a release triggers the Site workflow; the installer UI and release parsing code are retained, but the landing page currently directs users to source setup. Restore the installer flow and unsigned-download notice only when downloads are ready to be offered again.

## Code signing

Signing is what stops Windows from warning people about an unknown publisher. SHA-256 checksums let people confirm a download wasn't altered, but they don't affect SmartScreen or antivirus reputation. A signature does.

The workflow signs with [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/). One-time setup:

1. Create a Trusted Signing account and a **Public Trust** certificate profile in Azure, and complete identity validation. Check Microsoft's current eligibility rules for individuals and organizations first.
2. Create an app registration (service principal) and give it the **Trusted Signing Certificate Profile Signer** role on the account.
3. In the GitHub repository settings, add:
   - Secrets: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`
   - Variables: `AZURE_SIGNING_ENDPOINT` (for example `https://eus.codesigning.azure.net`), `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`

Without these, releases are built unsigned, and the release notes say so.

Even signed, a brand-new publisher can still see SmartScreen prompts until the certificate builds reputation through downloads. Keep signing every release with the same identity.

### macOS

macOS won't open downloaded apps that aren't signed with a Developer ID and notarized by Apple without extra steps from the user. You need an [Apple Developer Program](https://developer.apple.com/programs/) membership. Then add these repository secrets:

- `APPLE_CERTIFICATE`: your **Developer ID Application** certificate exported as a `.p12` and base64-encoded
- `APPLE_CERTIFICATE_PASSWORD`: the `.p12` password
- `APPLE_SIGNING_IDENTITY`: for example `Developer ID Application: Your Name (TEAMID)`
- `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), and `APPLE_TEAM_ID` for notarization

Without them, the macOS app is only ad-hoc signed. After attempting to open it, people may need to use **System Settings → Privacy & Security → Open Anyway** as [Apple describes](https://support.apple.com/en-us/102445).

## If antivirus flags a build

False positives happen to new, unsigned, or rarely downloaded executables. If one is reported:

- Submit the file to Microsoft at <https://www.microsoft.com/wdsi/filesubmission> as a software developer, and to the reporting vendor's false-positive form.
- Include the release URL and the SHA-256 hash from `SHA256SUMS.txt`.

What the app already avoids, so it doesn't look like malware:

- It installs per user under `%LOCALAPPDATA%` and never asks for administrator rights.
- Background helpers (git and the provider CLIs) run without flashing console windows. Browser sign-in opens only the browser; interactive CLI tooling and Claude setup-token sign-in open a terminal when requested.
- It doesn't use packers, obfuscation, or PowerShell execution-policy bypasses.
- The webview may only open `https://` links in the browser and pick folders; all other native access goes through the app's own commands.
- The binary carries full version information: product name, publisher, version, and copyright.

## Release checklist

For native smoke tests on a headless Xvfb display, use `LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1`. Check that the window renders content; a window title alone can hide a blank webview. Use temporary `PERPETUAL_DATA_DIR` and `XDG_CACHE_HOME` folders, and set `APPIMAGE_EXTRACT_AND_RUN=1` to test the AppImage without FUSE.

- [ ] The Windows installer runs without administrator rights, and the Start menu shortcut launches the app.
- [ ] On macOS, the app opens from Applications after the unsigned-app override, and its window controls sit in the title bar.
- [ ] On Linux, `sudo apt install ./Perpetual_*_amd64.deb` installs the package and dependencies, and the desktop launcher opens the app.
- [ ] The Linux AppImage opens after `chmod +x`; also test `--appimage-extract-and-run` without FUSE. Check both X11 and Wayland sessions.
- [ ] On Linux, interactive CLI sign-in opens an installed terminal emulator, browser sign-in opens the browser, and sleep/wake leaves tasks resumable.
- [ ] On first launch, a signed-in Codex or Claude CLI appears in Accounts with its email.
- [ ] Browser sign-in for Codex and Claude opens the browser without a terminal window, then the account becomes signed in.
- [ ] A task runs on Codex and on Claude, and the reply streams in.
- [ ] Choosing **Use** on another account moves the active account, and the next message uses it.
- [ ] Changes from a task with a project appear in **Changes** and apply to the project.
- [ ] Light, dark, and system themes all read well. The window restores its last size and position.
- [ ] Uninstalling from **Settings → Apps** (Windows), moving the app to the Trash (macOS), or using `sudo apt remove perpetual` / deleting the AppImage (Linux) removes it.
