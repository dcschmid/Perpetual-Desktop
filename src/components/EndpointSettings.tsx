import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { native, rpc } from '../lib/api';
import { errorMessage } from '../lib/format';
import { useStore } from '../lib/store';
import type { OpenAiEndpoint, OpenAiEndpointProbe } from '../lib/types';
import { Button, Card, Modal, Section, Toggle } from './ui';

const field =
  'w-full rounded-lg border border-line bg-elevated px-3 py-2 text-[13px] text-ink outline-none focus-visible:border-muted';

export function EndpointSettings() {
  const store = useStore();
  const [endpoints, setEndpoints] = useState<OpenAiEndpoint[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<OpenAiEndpoint | null>(null);
  const [removing, setRemoving] = useState<OpenAiEndpoint | null>(null);

  const reload = useCallback(async () => {
    try {
      setEndpoints(await rpc<OpenAiEndpoint[]>('get_openai_endpoints'));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (native) void reload();
    else setLoading(false);
  }, [reload]);

  async function mutate(run: () => Promise<unknown>) {
    setBusy(true);
    try {
      await run();
      await reload();
      await store.detect();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-7">
      <Section
        title="OpenAI-compatible endpoints"
        description="Use your own gateway with Codex on Host execution. Choose Responses or Chat Completions with tool calls. API keys stay in the system credential store."
        actions={
          <Button
            size="sm"
            variant="secondary"
            disabled={!native || busy || loading}
            onClick={() =>
              setEditing({
                id: crypto.randomUUID(),
                label: '',
                base_url: '',
                api: 'responses',
                models: [],
                enabled: true,
                api_key_configured: false,
              })
            }
          >
            <Plus size={13} /> Add endpoint
          </Button>
        }
      >
        {!native && (
          <p className="text-[13px] text-muted">Configure endpoints in the desktop app.</p>
        )}
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        {native && loading && <p className="text-[13px] text-muted">Loading endpoints…</p>}
        {native && !loading && !endpoints.length && !error && (
          <p className="text-[13px] text-muted">No custom endpoints yet.</p>
        )}
        <div className="space-y-3">
          {endpoints.map((endpoint) => (
            <Card key={endpoint.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium text-ink">{endpoint.label}</h3>
                  <p className="mt-1 break-all text-xs text-muted">{endpoint.base_url}</p>
                  <p className="mt-2 text-xs text-muted">
                    {endpoint.models.length
                      ? endpoint.models.join(', ')
                      : 'Add a model ID to use this endpoint.'}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {endpoint.api === 'chat_completions' ? 'Chat Completions · ' : 'Responses · '}
                    {endpoint.api_key_configured ? 'API key saved' : 'No API key saved'}
                  </p>
                </div>
                <Toggle
                  label={`Enable ${endpoint.label}`}
                  checked={endpoint.enabled}
                  disabled={busy}
                  onChange={(enabled) =>
                    void mutate(() => rpc('save_openai_endpoint', { ...endpoint, enabled }))
                  }
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`Edit ${endpoint.label}`}
                  onClick={() => setEditing(endpoint)}
                >
                  <Pencil size={13} />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`Remove ${endpoint.label}`}
                  onClick={() => setRemoving(endpoint)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
        <p className="mt-4 text-xs leading-5 text-muted">
          Enabled models appear in the Codex model menu. Enter exact model IDs or routing aliases
          such as yolo. These endpoints are used only when you select them.
        </p>
      </Section>
      {editing && (
        <EndpointForm
          key={editing.id}
          endpoint={editing}
          onClose={() => {
            setEditing(null);
            void reload();
            void store.detect().catch((e) => toast.error(errorMessage(e)));
          }}
          onSaved={async () => {
            setEditing(null);
            await reload();
            await store.detect();
          }}
        />
      )}
      <Modal
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
        title="Remove endpoint"
      >
        <p className="text-sm text-muted">
          Remove {removing?.label} and its saved API key? Existing tasks will need another model.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRemoving(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (removing)
                void mutate(async () => {
                  await rpc('delete_openai_endpoint', { id: removing.id });
                  setRemoving(null);
                });
            }}
          >
            Remove endpoint
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function EndpointForm({
  endpoint,
  onClose,
  onSaved,
}: {
  endpoint: OpenAiEndpoint;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [label, setLabel] = useState(endpoint.label);
  const [baseUrl, setBaseUrl] = useState(endpoint.base_url);
  const [api, setApi] = useState<NonNullable<OpenAiEndpoint['api']>>(endpoint.api ?? 'responses');
  const [models, setModels] = useState(endpoint.models.join('\n'));
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [configured, setConfigured] = useState(endpoint.api_key_configured);
  const [savedBaseUrl, setSavedBaseUrl] = useState(endpoint.base_url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [probeDone, setProbeDone] = useState(false);

  async function save() {
    const saved = await rpc<OpenAiEndpoint>('save_openai_endpoint', {
      ...endpoint,
      label,
      base_url: baseUrl,
      api,
      models: models
        .split('\n')
        .map((m) => m.trim())
        .filter(Boolean),
    });
    setConfigured(saved.api_key_configured);
    setSavedBaseUrl(saved.base_url);
    if (apiKey.trim() || clearKey) {
      await rpc('set_openai_endpoint_key', { id: endpoint.id, key: clearKey ? '' : apiKey });
      setConfigured(!clearKey);
      setApiKey('');
      setClearKey(false);
    }
  }

  async function submit(discover: boolean) {
    setBusy(true);
    setError('');
    try {
      await save();
      if (discover) {
        const result = await rpc<OpenAiEndpointProbe>('probe_openai_endpoint', { id: endpoint.id });
        setDiscovered(result.models);
        setProbeDone(true);
      } else {
        await onSaved();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const addressChanged = configured && baseUrl.trim().replace(/\/+$/, '') !== savedBaseUrl;
  return (
    <Modal
      open
      title={endpoint.label ? 'Edit endpoint' : 'Add endpoint'}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
        className="space-y-4"
      >
        <label className="block space-y-1.5 text-xs text-muted">
          Name
          <input
            autoFocus
            required
            maxLength={100}
            className={field}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="My gateway"
            disabled={busy}
          />
        </label>
        <label className="block space-y-1.5 text-xs text-muted">
          API base URL
          <input
            required
            type="url"
            className={field}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://gateway.example/v1"
            disabled={busy}
          />
        </label>
        <label className="block space-y-1.5 text-xs text-muted">
          API protocol
          <select
            aria-label="API protocol"
            className={field}
            value={api}
            onChange={(e) => setApi(e.target.value as NonNullable<OpenAiEndpoint['api']>)}
            disabled={busy}
          >
            <option value="responses">Responses</option>
            <option value="chat_completions">Chat Completions (YOLO Auto, etc.)</option>
          </select>
        </label>
        {api === 'chat_completions' && (
          <p className="text-xs leading-5 text-muted">
            Requires streaming and tool calls. For YOLO Auto use https://yolo-auto.com/v1 and a
            model ID such as yolo or qwen3.8-27b. Hosted web search is unavailable in this mode.
          </p>
        )}
        <label className="block space-y-1.5 text-xs text-muted">
          API key (optional)
          <input
            type="password"
            autoComplete="new-password"
            className={field}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setClearKey(false);
            }}
            placeholder={
              configured
                ? 'Leave blank to keep the saved key'
                : 'No key required for anonymous endpoints'
            }
            disabled={busy || clearKey}
          />
        </label>
        {addressChanged && (
          <p className="text-xs text-muted">
            Changing the address clears the saved key. Enter the key for the new address above.
          </p>
        )}
        {configured && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => setClearKey(e.target.checked)}
              disabled={busy}
            />
            Remove saved API key
          </label>
        )}
        <label className="block space-y-1.5 text-xs text-muted">
          Model IDs (one per line)
          <textarea
            rows={4}
            className={field}
            value={models}
            onChange={(e) => setModels(e.target.value)}
            placeholder={'yolo\nvendor/model-name'}
            disabled={busy}
          />
        </label>
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy || !label.trim() || !baseUrl.trim()}
            onClick={() => void submit(true)}
          >
            <RefreshCw size={13} />
            Save and discover models
          </Button>
          <p className="mt-2 text-xs leading-5 text-muted">
            Reads the model list without generating a response. If discovery is unavailable, enter
            model IDs manually.
          </p>
          {probeDone && !discovered.length && (
            <p className="mt-2 text-xs text-muted">
              No models returned. You can enter model IDs manually.
            </p>
          )}
          {!!discovered.length && (
            <div className="mt-3 flex max-h-40 flex-wrap gap-2 overflow-y-auto">
              {discovered.map((model) => (
                <Button
                  key={model}
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy || models.split('\n').includes(model)}
                  onClick={() =>
                    setModels((old) => [...old.split('\n').filter(Boolean), model].join('\n'))
                  }
                >
                  {model}
                </Button>
              ))}
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !label.trim() || !baseUrl.trim()}
          >
            {busy ? 'Saving…' : 'Save endpoint'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
