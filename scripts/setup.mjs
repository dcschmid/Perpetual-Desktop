import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function supportedNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return (major === 22 && minor >= 13) || major === 24 || major >= 26;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const linuxPackages = [
  'build-essential',
  'pkg-config',
  'libwebkit2gtk-4.1-dev',
  'libssl-dev',
  'libxdo-dev',
  'libayatana-appindicator3-dev',
  'librsvg2-dev',
  'curl',
  'wget',
  'file',
  'patchelf',
  'dbus',
  'xdg-utils',
];
function probe(command, args = []) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code}).`)),
    );
  });
}
function npm(args) {
  // npm exposes its JS entrypoint even on Windows; no shell quoting is needed.
  if (!process.env.npm_execpath)
    throw new Error('Run this through npm: npm run setup, npm run doctor, or npm start.');
  return run(process.execPath, [process.env.npm_execpath, ...args]);
}

function hasBuildTools() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe',
  );
  const vs = probe(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ]);
  return vs.status === 0 && Boolean(vs.stdout?.trim());
}

async function winget(id, extra = []) {
  if (probe('winget', ['--version']).status !== 0)
    throw new Error(
      'Install App Installer from the Microsoft Store to enable winget, then run npm start again. Alternatively, install the prerequisites listed in README.md.',
    );
  await run('winget', [
    'install',
    '--id',
    id,
    '--exact',
    '--source',
    'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    ...extra,
  ]);
}

async function installRustup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'perpetual-rustup-'));
  try {
    const target = windows
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
      : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'linux' ? 'unknown-linux-gnu' : 'apple-darwin'}`;
    const installer = path.join(directory, windows ? 'rustup-init.exe' : 'rustup-init');
    const response = await fetch(
      `https://static.rust-lang.org/rustup/dist/${target}/rustup-init${windows ? '.exe' : ''}`,
    );
    if (!response.ok) throw new Error(`Rust installer download failed (${response.status}).`);
    writeFileSync(installer, Buffer.from(await response.arrayBuffer()), { mode: 0o700 });
    await run(installer, ['-y', '--profile', 'minimal', '--default-toolchain', 'none']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function linuxBuildTools(check) {
  if (
    probe('cc', ['--version']).status === 0 &&
    probe('pkg-config', ['--exists', 'gtk+-3.0', 'webkit2gtk-4.1', 'openssl', 'librsvg-2.0'])
      .status === 0
  )
    return;
  const instructions = `Linux build dependencies are missing. On Debian/Ubuntu/Mint run: sudo apt-get install ${linuxPackages.join(' ')}. Other distributions: https://v2.tauri.app/start/prerequisites/#linux`;
  if (check || probe('apt-get', ['--version']).status !== 0) throw new Error(instructions);
  console.log('Installing Linux build dependencies. sudo may ask for your password.');
  const command = process.getuid() === 0 ? 'apt-get' : 'sudo';
  const prefix = command === 'sudo' ? ['apt-get'] : [];
  await run(command, [...prefix, 'update']);
  await run(command, [...prefix, 'install', '-y', ...linuxPackages]);
  if (
    probe('cc', ['--version']).status !== 0 ||
    probe('pkg-config', ['--exists', 'gtk+-3.0', 'webkit2gtk-4.1', 'openssl', 'librsvg-2.0'])
      .status !== 0
  )
    throw new Error(instructions);
}

export async function setup({ check = false, launch = false } = {}) {
  if (!supportedNode(process.version))
    throw new Error('Install Node.js 22.13+ (22.x), 24.x, or 26+: https://nodejs.org/');
  if (!['win32', 'darwin', 'linux'].includes(process.platform))
    throw new Error('The desktop app supports Windows, macOS, and Linux.');
  if (process.platform === 'linux' && !['x64', 'arm64'].includes(process.arch))
    throw new Error('Linux source builds require an x86_64 or ARM64 system.');
  if (probe('git', ['--version']).status !== 0)
    throw new Error('Install Git: https://git-scm.com/downloads');

  // Newly installed Rust must be visible to this process and the desktop build.
  const cargoBin = path.join(process.env.CARGO_HOME || path.join(homedir(), '.cargo'), 'bin');
  const providerRoot = path.join(homedir(), '.perpetual', 'tools');
  const providerBin = path.join(providerRoot, 'node_modules', '.bin');
  process.env.PATH = [cargoBin, providerBin, process.env.PATH ?? ''].join(path.delimiter);
  if (windows && !hasBuildTools()) {
    if (check) throw new Error('C++ build tools are missing. Run npm run setup.');
    console.log('Installing Microsoft C++ Build Tools. Accept the system prompts.');
    await winget('Microsoft.VisualStudio.2022.BuildTools', [
      '--override',
      '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended',
    ]);
    if (!hasBuildTools())
      throw new Error(
        'Finish installing Desktop development with C++ and a Windows SDK, restart if prompted, then run npm start again.',
      );
  } else if (process.platform === 'darwin' && probe('xcode-select', ['-p']).status !== 0) {
    if (check) throw new Error('Apple command-line tools are missing. Run npm run setup.');
    console.log('Accept the Apple command-line tools installation. Waiting for it to finish…');
    const result = probe('xcode-select', ['--install']);
    if (result.status !== 0)
      throw new Error(
        'Install Apple command-line tools with xcode-select --install, then run npm start again.',
      );
    const deadline = Date.now() + 60 * 60 * 1000;
    while (probe('xcode-select', ['-p']).status !== 0) {
      if (Date.now() >= deadline)
        throw new Error('Finish installing Apple command-line tools, then run npm start again.');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  if (process.platform === 'linux') await linuxBuildTools(check);
  if (windows) {
    const webview = probe('powershell.exe', [
      '-NoProfile',
      '-Command',
      "$paths = @('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\*', 'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\*', 'HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\*'); if (Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.name -eq 'Microsoft Edge WebView2 Runtime' -and $_.pv -and $_.pv -ne '0.0.0.0' }) { exit 0 }; exit 1",
    ]);
    if (webview.status !== 0) {
      if (check) throw new Error('WebView2 Runtime is missing. Run npm run setup.');
      await winget('Microsoft.EdgeWebView2Runtime');
    }
  }
  if (probe('rustup', ['--version']).status !== 0) {
    if (check) throw new Error('Rust is missing. Run npm run setup.');
    console.log('Installing Rust from rust-lang.org…');
    await installRustup();
  }
  const toolchain = readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8').match(
    /channel\s*=\s*"([^"]+)"/,
  )?.[1];
  if (!toolchain) throw new Error('Cannot read the pinned Rust toolchain.');
  if (check) {
    const rust = probe('rustup', ['run', toolchain, 'rustc', '--version']);
    if (rust.status !== 0)
      throw new Error(
        `Rust ${toolchain} is missing. Run npm run setup to install it automatically.`,
      );
    if (!existsSync(path.join(root, 'node_modules/@tauri-apps/cli/package.json')))
      throw new Error('JavaScript dependencies are missing. Run npm run setup.');
    console.log('Build prerequisites and dependencies are available.');
  } else {
    await run('rustup', [
      'toolchain',
      'install',
      toolchain,
      '--profile',
      'minimal',
      '--no-self-update',
    ]);
    await npm(['ci']);
    const hasProvider = windows
      ? ['codex', 'claude'].some((name) => probe('where.exe', [name]).status === 0)
      : ['codex', 'claude'].some((name) => probe(name, ['--version']).status === 0);
    if (!hasProvider) {
      console.log('Installing Codex CLI so you can sign in and run tasks…');
      await npm(['install', '--prefix', providerRoot, '--no-audit', '--no-fund', '@openai/codex']);
    }
    console.log(
      'Source setup complete. Run npm run desktop to open Perpetual, or npm run bundle to build an installer.',
    );
  }
  console.log(
    'Sign in from the app to run tasks. Existing signed-in CLI accounts are detected automatically.',
  );
  if (launch) await npm(['run', 'desktop']);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup({
    check: process.argv.includes('--check'),
    launch: process.argv.includes('--launch'),
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
