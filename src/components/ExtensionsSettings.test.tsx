// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { rpc } from '../lib/api';
import type { ExtensionCatalog } from '../lib/types';
import { ExtensionsSettings } from './ExtensionsSettings';

vi.mock('../lib/api', () => ({ native: true, rpc: vi.fn() }));
vi.mock('../lib/store', () => ({
  useStore: () => ({ repos: [{ id: 'repo-1', name: 'Website', local_path: '/project' }] }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
let catalog: ExtensionCatalog;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  catalog = {
    skills: [
      {
        name: 'review',
        description: 'Review changes',
        path: '/skills/review',
        project: false,
        enabled: true,
      },
    ],
    mcp_servers: [
      {
        id: 'global:docs',
        name: 'docs',
        runtime_name: 'docs',
        transport: 'http',
        source: '/config.toml',
        project: false,
        enabled: true,
      },
    ],
    warnings: [],
    locations: ['/skills', '/config.toml'],
  };
  vi.mocked(rpc).mockImplementation(async (name) =>
    name === 'list_extensions' ? structuredClone(catalog) : undefined,
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render() {
  await act(async () => root.render(<ExtensionsSettings />));
}
async function select(label: string, value: string) {
  await act(async () => {
    const el = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')]
    .filter((el) => el.textContent?.trim() === text)
    .at(-1);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}

it('saves project overrides with the selected provider and keeps failed toggles unchanged', async () => {
  await render();
  await select('Extension provider', 'claude_code');
  await select('Extension scope', 'repo-1');
  vi.mocked(rpc).mockImplementation(async (name) => {
    if (name === 'set_extension_enabled') throw new Error('Could not save');
    return structuredClone(catalog);
  });
  await act(async () =>
    (container.querySelector('[aria-label="Enable review"]') as HTMLButtonElement).click(),
  );
  expect(rpc).toHaveBeenCalledWith('set_extension_enabled', {
    scope: { agent: 'claude_code', repo_id: 'repo-1' },
    kind: 'skill',
    id: '/skills/review',
    enabled: false,
  });
  expect(toast.error).toHaveBeenCalledWith('Could not save');
  expect(
    container.querySelector('[aria-label="Enable review"]')?.getAttribute('aria-checked'),
  ).toBe('true');
});

it('ignores a stale global response after switching to project scope', async () => {
  let finish: (value: unknown) => void = () => {};
  vi.mocked(rpc).mockImplementation((name, payload) => {
    if (name === 'list_extensions' && !(payload as { repo_id: string | null }).repo_id)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return Promise.resolve({
      ...catalog,
      skills: [{ ...catalog.skills[0], name: 'project-review' }],
    });
  });
  await render();
  await select('Extension scope', 'repo-1');
  await act(async () => finish(catalog));
  expect(container.textContent).toContain('project-review');
  expect(container.querySelector('[aria-label="Enable review"]')).toBeNull();
});

it('imports the selected skill folder and recovers from a configuration read error', async () => {
  vi.mocked(rpc).mockRejectedValueOnce(new Error('Invalid TOML in /config.toml'));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Invalid TOML');
  await click('Retry');
  vi.mocked(open).mockResolvedValue('/downloads/new-skill');
  await click('Import skill');
  expect(rpc).toHaveBeenCalledWith('import_skill', {
    scope: { agent: 'codex', repo_id: null },
    source: '/downloads/new-skill',
  });
  expect(toast.success).toHaveBeenCalledWith('Skill imported');
});

it('validates a new MCP server before sending any write request', async () => {
  await render();
  await click('Add server');
  await click('Add server');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('server name');
  expect(vi.mocked(rpc).mock.calls.some(([name]) => name === 'add_mcp_server')).toBe(false);
});
