import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ probe: vi.fn(), run: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.probe, spawn: mocks.run }));
const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const originalNpm = process.env.npm_execpath;
const originalGetuid = process.getuid;

beforeEach(() => {
  vi.resetModules();
  mocks.probe.mockReset().mockReturnValue({ status: 0, stdout: 'available' });
  mocks.run.mockReset().mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
  process.env.npm_execpath = '/mock/npm.cjs';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  process.env.PATH = originalPath;
  if (originalNpm === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = originalNpm;
  if (originalGetuid === undefined) delete process.getuid;
  else process.getuid = originalGetuid;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function load(platform) {
  Object.defineProperty(process, 'platform', { value: platform });
  if (platform === 'linux') process.getuid = () => 1000;
  return (await import('./setup.mjs')).setup;
}

describe('source setup', () => {
  it('checks an existing macOS installation without installing anything', async () => {
    const setup = await load('darwin');
    await setup({ check: true });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('stops doctor at missing native tools without opening an installer', async () => {
    mocks.probe.mockImplementation((command) => ({ status: command === 'xcode-select' ? 1 : 0 }));
    await expect((await load('darwin'))({ check: true })).rejects.toThrow(
      'Apple command-line tools',
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('checks Linux without installing anything or looking for Apple tools', async () => {
    await (
      await load('linux')
    )({ check: true });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.probe.mock.calls.some(([command]) => command === 'xcode-select')).toBe(false);
    expect(mocks.probe).toHaveBeenCalledWith(
      'pkg-config',
      expect.arrayContaining(['--exists', 'webkit2gtk-4.1']),
      expect.anything(),
    );
  });
  it('reports missing Linux libraries in doctor without invoking sudo', async () => {
    mocks.probe.mockImplementation((command) => ({ status: command === 'pkg-config' ? 1 : 0 }));
    await expect((await load('linux'))({ check: true })).rejects.toThrow('sudo apt-get install');
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('installs Linux system libraries before Rust and launch', async () => {
    let nativeProbes = 0;
    mocks.probe.mockImplementation((command) => ({
      status: command === 'pkg-config' && nativeProbes++ === 0 ? 1 : 0,
    }));
    await (
      await load('linux')
    )({ launch: true });
    expect(mocks.run.mock.calls[0].slice(0, 2)).toEqual(['sudo', ['apt-get', 'update']]);
    expect(mocks.run.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['install', '-y', 'libwebkit2gtk-4.1-dev']),
    );
    expect(mocks.run.mock.calls[2][0]).toBe('rustup');
    expect(mocks.run.mock.calls.at(-1)[1]).toEqual(['/mock/npm.cjs', 'run', 'desktop']);
  });
  it('gives Linux manual instructions when apt is unavailable', async () => {
    mocks.probe.mockImplementation((command) => ({
      status: ['pkg-config', 'apt-get'].includes(command) ? 1 : 0,
    }));
    await expect((await load('linux'))({ launch: true })).rejects.toThrow(
      'https://v2.tauri.app/start/prerequisites/#linux',
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('does not launch when Linux dependency installation fails', async () => {
    mocks.probe.mockImplementation((command) => ({ status: command === 'cc' ? 1 : 0 }));
    mocks.run.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 1));
      return child;
    });
    await expect((await load('linux'))({ launch: true })).rejects.toThrow('failed');
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it('installs dependencies before launching and keeps an existing provider', async () => {
    await (
      await load('darwin')
    )({ launch: true });
    const calls = mocks.run.mock.calls.map(([command, args]) => [command, args]);
    expect(calls[0][1]).toEqual([
      'toolchain',
      'install',
      '1.96.1',
      '--profile',
      'minimal',
      '--no-self-update',
    ]);
    expect(calls[1][1]).toEqual(['/mock/npm.cjs', 'ci']);
    expect(calls[2][1]).toEqual(['/mock/npm.cjs', 'run', 'desktop']);
    expect(calls).toHaveLength(3);
  });
  it('installs a missing provider in the user profile before launch', async () => {
    mocks.probe.mockImplementation((command) => ({
      status: ['codex', 'claude'].includes(command) ? 1 : 0,
    }));
    await (
      await load('darwin')
    )({ launch: true });
    const args = mocks.run.mock.calls[2][1];
    expect(args).toContain('--prefix');
    expect(args).toContain('@openai/codex');
    expect(args).not.toContain('--global');
    expect(process.env.PATH).toContain('node_modules');
    expect(mocks.run.mock.calls[3][1]).toEqual(['/mock/npm.cjs', 'run', 'desktop']);
  });
  it('does not launch if dependency installation fails', async () => {
    mocks.run.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 1));
      return child;
    });
    await expect((await load('darwin'))({ launch: true })).rejects.toThrow('failed');
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it('requests Apple tools and continues after they become available', async () => {
    let requested = false;
    mocks.probe.mockImplementation((command, args) => {
      if (command === 'xcode-select') {
        if (args[0] === '--install') requested = true;
        return { status: requested ? 0 : 1 };
      }
      return { status: 0 };
    });
    await (
      await load('darwin')
    )({});
    expect(requested).toBe(true);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it('installs missing Windows C++ tools and WebView2 before dependencies', async () => {
    let vsProbes = 0;
    mocks.probe.mockImplementation((command) => {
      if (command.endsWith('vswhere.exe'))
        return { status: vsProbes++ === 0 ? 1 : 0, stdout: 'VS' };
      if (command === 'powershell.exe') return { status: 1 };
      return { status: 0, stdout: 'available' };
    });
    await (
      await load('win32')
    )({ launch: true });
    expect(mocks.run.mock.calls[0][1]).toContain('Microsoft.VisualStudio.2022.BuildTools');
    expect(mocks.run.mock.calls[0][1]).toContain(
      '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended',
    );
    expect(mocks.run.mock.calls[1][1]).toContain('Microsoft.EdgeWebView2Runtime');
    expect(mocks.run.mock.calls.at(-1)[1]).toEqual(['/mock/npm.cjs', 'run', 'desktop']);
    const registryCommand = mocks.probe.mock.calls.find(
      ([command]) => command === 'powershell.exe',
    )[1][2];
    expect(registryCommand).toContain('HKLM:\\SOFTWARE\\');
    expect(registryCommand).not.toContain('HKLM:\\\\');
  });
  it.each(['darwin', 'linux'])(
    'downloads %s rustup from the official host before the toolchain',
    async (platform) => {
      mocks.probe.mockImplementation((command) => ({ status: command === 'rustup' ? 1 : 0 }));
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
      vi.stubGlobal('fetch', fetchMock);
      await (
        await load(platform)
      )({});
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const target = platform === 'linux' ? 'unknown-linux-gnu' : 'apple-darwin';
      expect(fetchMock.mock.calls[0][0]).toBe(
        `https://static.rust-lang.org/rustup/dist/${arch}-${target}/rustup-init`,
      );
      expect(mocks.run.mock.calls[0][1]).toEqual([
        '-y',
        '--profile',
        'minimal',
        '--default-toolchain',
        'none',
      ]);
      expect(mocks.run.mock.calls[1][0]).toBe('rustup');
    },
  );
  it('does not continue to build after a failed Rust download', async () => {
    mocks.probe.mockImplementation((command) => ({ status: command === 'rustup' ? 1 : 0 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect((await load('darwin'))({ launch: true })).rejects.toThrow(
      'Rust installer download failed',
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('stops cleanly when winget is unavailable', async () => {
    mocks.probe.mockImplementation((command) => ({ status: command === 'git' ? 0 : 1 }));
    await expect((await load('win32'))({})).rejects.toThrow('App Installer');
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
