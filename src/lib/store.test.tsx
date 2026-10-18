// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider, useStore } from './store';
import { rpc } from './api';
import type { AgentModelCatalog, AgentModelOption, AgentThread, LimitPolicy } from './types';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Composer } from '../components/Composer';
import { Accounts } from '../components/Accounts';
import { Conversation } from '../components/Conversation';

vi.mock('./api', () => ({
  native: true,
  rpc: vi.fn(),
  subscribe: () => Promise.resolve(() => {}),
  signIn: vi.fn(),
  action: async (run: () => Promise<unknown>) => run(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

let store: ReturnType<typeof useStore>;
let root: Root;
let container: HTMLDivElement;
let saved: LimitPolicy;
function Capture() {
  store = useStore();
  return null;
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  saved = {
    auto_switch: true,
    switch_back: true,
    resume_with_earliest: true,
    agent_priority: ['codex', 'claude_code'],
    unknown_reset_retry_secs: 600,
    keep_awake: true,
    accounts: [],
  };
  vi.mocked(rpc).mockImplementation(async (name, payload) => {
    if (name === 'get_limit_policy') return { ...saved };
    if (name === 'set_limit_policy') {
      saved = payload as LimitPolicy;
      return saved;
    }
    if (name === 'ensure_workbench_project') return { id: 'project' };
    return [];
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <StoreProvider>
        <Capture />
      </StoreProvider>,
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('policy persistence', () => {
  it('preserves two rapid toggles before the next render', async () => {
    await act(async () => {
      await Promise.all([
        store.savePolicy({ auto_switch: false }),
        store.savePolicy({ switch_back: false }),
      ]);
    });
    expect(saved.auto_switch).toBe(false);
    expect(saved.switch_back).toBe(false);
    expect(store.policy).toEqual(saved);
  });

  it('serializes writes and keeps optimistic preferences during a refresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const implementation = vi.mocked(rpc).getMockImplementation()!;
    let writes = 0;
    vi.mocked(rpc).mockImplementation(async (name, payload) => {
      if (name === 'set_limit_policy' && ++writes === 1) await gate;
      return implementation(name, payload);
    });
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = store.savePolicy({ auto_switch: false });
      second = store.savePolicy({ switch_back: false });
      await store.refresh();
    });
    expect(writes).toBe(1);
    expect(store.policy?.auto_switch).toBe(false);
    expect(store.policy?.switch_back).toBe(false);
    await act(async () => {
      release();
      await Promise.all([first, second]);
    });
    expect(writes).toBe(2);
    expect(saved.auto_switch).toBe(false);
    expect(saved.switch_back).toBe(false);
  });
});

describe('message submission', () => {
  it('submits once and preserves a draft entered while sending', async () => {
    let complete!: (success: boolean) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const render = (text: string, seq: number) =>
      root.render(
        <Tooltip.Provider>
          <StoreProvider>
            <Composer
              draft={{ text, seq }}
              busy={false}
              onSend={onSend}
              onStop={() => {}}
              onCommand={() => {}}
              onNavigate={() => {}}
            />
          </StoreProvider>
        </Tooltip.Provider>,
      );
    await act(async () => render('First message', 1));
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    await act(async () => {
      send.click();
      send.click();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => render('Next draft', 2));
    await act(async () => complete(true));
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Next draft');
  });
});

describe('OpenAI-compatible endpoint selection', () => {
  const first: AgentModelOption = {
    id: 'perpetual-endpoint/one/yolo-auto',
    label: 'First · yolo-auto',
    aliases: ['yolo-auto'],
    family: null,
    default: false,
    available: true,
    source: 'openai_compatible',
    reasoning: [],
    local_provider: 'openai_compatible',
    local_base_url: 'https://first.test/v1',
  };
  const second = {
    ...first,
    id: 'perpetual-endpoint/two/yolo-auto',
    label: 'Second · yolo-auto',
    local_base_url: 'https://second.test/v1',
  };
  const catalog = (models: AgentModelOption[]): AgentModelCatalog => ({
    agent: 'codex',
    models,
    default_model: null,
    default_reasoning: null,
    reasoning: [],
    binary_path: '/bin/codex',
    version: '1',
    source: 'codex',
    detected_at: '',
    error: null,
  });

  it('carries endpoint metadata for defaults, switches, and saved thread followups', async () => {
    localStorage.clear();
    const implementation = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (name, payload) =>
      name === 'agent_model_catalog' ? [catalog([first, second])] : implementation(name, payload),
    );
    await act(async () => {
      await store.detect();
      store.setModelDefault('codex', first.id);
    });
    const onSend = vi.fn().mockResolvedValue(true);
    const render = (text: string, seq: number, thread?: AgentThread) =>
      root.render(
        <StoreProvider>
          <Capture />
          <Tooltip.Provider>
            <Composer
              thread={thread}
              draft={{ text, seq }}
              busy={false}
              onSend={onSend}
              onStop={() => {}}
              onCommand={() => {}}
              onNavigate={() => {}}
            />
          </Tooltip.Provider>
        </StoreProvider>,
      );
    const send = async () =>
      act(async () =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
      );
    await act(async () => render('First', 1));
    await send();
    expect(onSend.mock.calls[0][1]).toMatchObject({
      model: first.id,
      local_provider: 'openai_compatible',
      local_base_url: first.local_base_url,
    });
    await act(async () => {
      store.setModelSelection('codex', second.id, '');
      render('Second', 2);
    });
    await send();
    expect(onSend.mock.calls[1][1]).toMatchObject({
      model: second.id,
      local_base_url: second.local_base_url,
    });
    await act(async () => {
      store.setModelSelection('codex', '', '');
      render('Follow up', 3, {
        id: 'thread',
        active_agent: 'codex',
        model: first.id,
        local_provider: 'openai_compatible',
        local_base_url: first.local_base_url,
        task_budget: { mode: 'unlimited' },
      } as AgentThread);
    });
    // No explicit preference: the persisted thread supplies the selection.
    await act(async () => store.setModelDefault('codex', ''));
    await send();
    expect(onSend.mock.calls[2][1]).toMatchObject({
      model: first.id,
      local_provider: 'openai_compatible',
      local_base_url: first.local_base_url,
    });
    localStorage.clear();
  });

  it('removes stale endpoints after a forced refresh races an older detection', async () => {
    const implementation = vi.mocked(rpc).getMockImplementation()!;
    let models = [first, second];
    let release: (() => void) | undefined;
    vi.mocked(rpc).mockImplementation(async (name, payload) => {
      if (name === 'agent_model_catalog') {
        const snapshot = [...models];
        if (release)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return [catalog(snapshot)];
      }
      return implementation(name, payload);
    });
    await act(async () => store.detect());
    expect(store.models[0].models).toHaveLength(2);
    release = () => {};
    let pending!: Promise<void>;
    let refreshed!: Promise<void>;
    await act(async () => {
      pending = store.detect();
    });
    models = [];
    await act(async () => {
      refreshed = store.detect();
      const finish = release!;
      release = undefined;
      finish();
      await Promise.all([pending, refreshed]);
    });
    expect(store.models[0].models).toEqual([]);
  });
});

describe('account creation', () => {
  it('does not create two accounts when Enter is submitted twice', async () => {
    const implementation = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (name, payload) => {
      if (name === 'detect_agents') return [{ kind: 'codex', installed: true }];
      return implementation(name, payload);
    });
    await act(async () =>
      root.render(
        <Tooltip.Provider>
          <StoreProvider>
            <Accounts addOpen setAddOpen={() => {}} />
          </StoreProvider>
        </Tooltip.Provider>,
      ),
    );
    const name = document.querySelector<HTMLInputElement>('input[placeholder="Personal, Work…"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        name,
        'Test account',
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = name.closest('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(
      vi.mocked(rpc).mock.calls.filter(([method]) => method === 'set_limit_policy'),
    ).toHaveLength(1);
    expect(saved.accounts).toHaveLength(1);
  });

  it('saves a setup token once when Enter is submitted twice', async () => {
    saved.accounts = [
      {
        id: 'test-token',
        label: 'Token account',
        agent: 'claude_code',
        auth_mode: 'oauth_token',
        enabled: true,
        use_credits: false,
      },
    ];
    const implementation = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (name, payload) => {
      if (name === 'provider_account_statuses')
        return [
          {
            id: 'test-token',
            label: 'Token account',
            agent: 'claude_code',
            auth_mode: 'oauth_token',
            enabled: true,
            use_credits: false,
            installed: true,
            authenticated: false,
            availability: 'unknown',
            active: false,
          },
        ];
      return implementation(name, payload);
    });
    await act(async () =>
      root.render(
        <Tooltip.Provider>
          <StoreProvider>
            <Accounts addOpen={false} setAddOpen={() => {}} />
          </StoreProvider>
        </Tooltip.Provider>,
      ),
    );
    const signIn = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Sign in',
    )!;
    await act(async () => signIn.click());
    const token = document.querySelector<HTMLInputElement>('input[aria-label="Setup token"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        token,
        'sk-ant-oat-test-placeholder-never-a-real-credential',
      );
      token.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      const form = token.closest('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(
      vi.mocked(rpc).mock.calls.filter(([method]) => method === 'set_provider_account_token'),
    ).toHaveLength(1);
  });
});

describe('first task authentication failure', () => {
  it('keeps the draft and retries the same created task after sign-in fails', async () => {
    const implementation = vi.mocked(rpc).getMockImplementation()!;
    let attempts = 0;
    vi.mocked(rpc).mockImplementation(async (name, payload) => {
      if (name === 'create_agent_thread') return { id: 'new-thread', status: 'draft' };
      if (name === 'send_thread_message' && ++attempts === 1) throw new Error('Sign in required');
      return implementation(name, payload);
    });
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        <Tooltip.Provider>
          <StoreProvider>
            <Conversation onSelect={onSelect} onNavigate={() => {}} />
          </StoreProvider>
        </Tooltip.Provider>,
      ),
    );
    const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Keep my first request',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(input.value).toBe('Keep my first request');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    );
    expect(onSelect).toHaveBeenCalledWith('new-thread');
    expect(
      vi.mocked(rpc).mock.calls.filter(([name]) => name === 'create_agent_thread'),
    ).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe('editing composer drafts', () => {
  it('restores an unsent draft when an edit with attachments is cancelled', async () => {
    const file = { id: 'pdf', name: 'review.pdf', mime: 'application/pdf', data: 'JVBERi0xLjc=' };
    const render = (text: string, seq: number, editing: boolean) =>
      root.render(
        <Tooltip.Provider>
          <StoreProvider>
            <Composer
              draft={{ text, seq }}
              editing={editing}
              busy={false}
              onSend={async () => false}
              onStop={() => {}}
              onCommand={() => {}}
              onNavigate={() => {}}
            />
          </StoreProvider>
        </Tooltip.Provider>,
      );
    await act(async () => render('My unsent draft', 1, false));
    await act(async () =>
      render(
        `Edited request\n\n<perpetual-attachments>${JSON.stringify([file])}</perpetual-attachments>`,
        2,
        true,
      ),
    );
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value.trim()).toBe(
      'Edited request',
    );
    expect(container.textContent).toContain('review.pdf');
    await act(async () => render('', 3, false));
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('My unsent draft');
    expect(container.textContent).not.toContain('review.pdf');
  });
});
