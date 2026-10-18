// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rpc } from '../lib/api';
import type { OpenAiEndpoint } from '../lib/types';
import { EndpointSettings } from './EndpointSettings';

const { detect } = vi.hoisted(() => ({ detect: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/api', () => ({ native: true, rpc: vi.fn() }));
vi.mock('../lib/store', () => ({ useStore: () => ({ detect }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
let endpoints: OpenAiEndpoint[];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  endpoints = [
    {
      id: 'gateway',
      label: 'My gateway',
      base_url: 'https://example.test/v1',
      models: ['yolo-auto'],
      enabled: true,
      api_key_configured: true,
    },
  ];
  vi.mocked(rpc).mockImplementation(async (name, payload) => {
    if (name === 'get_openai_endpoints') return structuredClone(endpoints);
    if (name === 'save_openai_endpoint') {
      const input = payload as OpenAiEndpoint;
      const previous = endpoints.find((e) => e.id === input.id);
      const saved = {
        ...input,
        api_key_configured:
          (previous?.base_url === input.base_url && previous.api_key_configured) || false,
      };
      endpoints = [...endpoints.filter((e) => e.id !== saved.id), saved];
      return structuredClone(saved);
    }
    if (name === 'set_openai_endpoint_key') {
      const { id, key } = payload as { id: string; key: string };
      endpoints.find((e) => e.id === id)!.api_key_configured = !!key;
    }
    if (name === 'probe_openai_endpoint') return { models: ['vendor/Model-A', 'yolo-auto'] };
    if (name === 'delete_openai_endpoint')
      endpoints = endpoints.filter((e) => e.id !== (payload as { id: string }).id);
    return undefined;
  });
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
  await act(async () => root.render(<EndpointSettings />));
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter((el) => el.textContent?.trim() === label || el.getAttribute('aria-label') === label)
    .at(-1);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
async function fill(label: string, value: string) {
  const parent = [...document.querySelectorAll('label')].find((el) =>
    el.textContent?.startsWith(label),
  );
  const input = parent?.querySelector('input,textarea') as HTMLInputElement | HTMLTextAreaElement;
  expect(input, label).toBeTruthy();
  await act(async () => {
    const prototype =
      input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}

it('saves gateway aliases and sends credentials only to the separate key command', async () => {
  await render();
  await click('Add endpoint');
  await fill('Name', 'YOLO');
  await fill('API base URL', 'http://localhost:8181/router/v1');
  await fill('API key', 'test-only-secret');
  await fill('Model IDs', 'yolo-auto\nvendor/Model-A');
  await submit();
  const saved = vi
    .mocked(rpc)
    .mock.calls.find(([name]) => name === 'save_openai_endpoint')![1] as OpenAiEndpoint;
  expect(saved).toMatchObject({
    label: 'YOLO',
    base_url: 'http://localhost:8181/router/v1',
    models: ['yolo-auto', 'vendor/Model-A'],
  });
  expect(JSON.stringify(saved)).not.toContain('test-only-secret');
  expect(rpc).toHaveBeenCalledWith('set_openai_endpoint_key', {
    id: saved.id,
    key: 'test-only-secret',
  });
  expect(container.textContent).toContain('YOLO');
  expect(detect).toHaveBeenCalled();
});

it('preserves a saved key when editing with an empty password field', async () => {
  await render();
  await click('Edit My gateway');
  await fill('Name', 'Renamed');
  await submit();
  expect(vi.mocked(rpc).mock.calls.some(([name]) => name === 'set_openai_endpoint_key')).toBe(
    false,
  );
  expect(endpoints[0].api_key_configured).toBe(true);
});

it('saves Chat Completions for YOLO Auto and preserves the saved key when changing protocol', async () => {
  await render();
  await click('Edit My gateway');
  const select = document.querySelector<HTMLSelectElement>('select')!;
  expect(select.value).toBe('responses');
  await act(async () => {
    select.value = 'chat_completions';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(document.body.textContent).toContain('https://yolo-auto.com/v1');
  await submit();
  expect(endpoints[0].api).toBe('chat_completions');
  expect(endpoints[0].api_key_configured).toBe(true);
  expect(vi.mocked(rpc).mock.calls.some(([name]) => name === 'set_openai_endpoint_key')).toBe(
    false,
  );
  await click('Edit My gateway');
  expect(document.querySelector<HTMLSelectElement>('select')!.value).toBe('chat_completions');
});

it('discovers models, accepts manual aliases, and refreshes saved metadata when closing', async () => {
  await render();
  await click('Edit My gateway');
  await click('Save and discover models');
  expect(rpc).toHaveBeenCalledWith('probe_openai_endpoint', { id: 'gateway' });
  await click('vendor/Model-A');
  await fill('Model IDs', 'yolo-auto\nvendor/Model-A\ncustom-route');
  await submit();
  expect(endpoints[0].models).toEqual(['yolo-auto', 'vendor/Model-A', 'custom-route']);
  await click('Edit My gateway');
  await fill('Name', 'Saved during discovery');
  await click('Save and discover models');
  await click('Cancel');
  expect(container.textContent).toContain('Saved during discovery');
  expect(detect).toHaveBeenCalled();
});

it('keeps the form open on credential failure and explains URL changes', async () => {
  await render();
  await click('Edit My gateway');
  await fill('API base URL', 'https://other.test/v1');
  expect(document.body.textContent).toContain('Changing the address clears the saved key');
  await fill('API key', 'replacement-key');
  const implementation = vi.mocked(rpc).getMockImplementation()!;
  vi.mocked(rpc).mockImplementation(async (name, payload) => {
    if (name === 'set_openai_endpoint_key') throw new Error('Credential store locked');
    return implementation(name, payload);
  });
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Credential store locked',
  );
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
    'replacement-key',
  );
});

it('disables and deletes endpoints and refreshes the model menu', async () => {
  await render();
  await click('Enable My gateway');
  expect(endpoints[0].enabled).toBe(false);
  await click('Remove My gateway');
  await click('Remove endpoint');
  expect(endpoints).toEqual([]);
  expect(container.textContent).toContain('No custom endpoints yet');
  expect(detect).toHaveBeenCalledTimes(2);
});
