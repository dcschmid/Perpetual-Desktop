import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  Monitor,
  Cloud,
  Cpu,
  RefreshCw,
  ExternalLink,
  Plus,
  X,
  ChevronRight,
  Copy,
  Check,
  CircleAlert,
  CircleCheck,
  Puzzle,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Theme } from '../App';
import { action, native, rpc } from '../lib/api';
import { errorMessage, providerName } from '../lib/format';
import { useStore } from '../lib/store';
import { credentialStore, keys } from '../lib/platform';
import { ExtensionsSettings } from './ExtensionsSettings';
import type {
  AgentKind,
  CloudAvailability,
  CloudPolicy,
  LocalModelPolicy,
  LocalModelStatus,
  SandboxLoginPrompt,
  SandboxPolicy,
  SandboxRuntimeStatus,
} from '../lib/types';
import {
  Button,
  Kbd,
  Modal,
  PageHeading,
  ProviderLogo,
  Row,
  Section,
  Select,
  ToggleRow,
  cn,
} from './ui';

const REPO = 'https://github.com/SakethSripada/Perpetual-Desktop';
const sections = [
  { id: 'general', label: 'General', icon: Monitor },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'extensions', label: 'Skills & MCP', icon: Puzzle },
  { id: 'cloud', label: 'Cloud', icon: Cloud },
  { id: 'local_model', label: 'Local models', icon: Cpu },
] as const;
type SectionId = (typeof sections)[number]['id'];

export function Settings({ theme, setTheme }: { theme: Theme; setTheme: (v: Theme) => void }) {
  const [section, setSection] = useState<SectionId>('general');
  return (
    <>
      <PageHeading title="Settings" />
      <div className="flex flex-col gap-8 md:flex-row md:gap-10">
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col">
          {sections.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={cn(
                'flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-3 text-left text-[13px] transition-colors',
                section === item.id
                  ? 'bg-hover text-ink'
                  : 'text-muted hover:bg-hover hover:text-ink',
              )}
            >
              <item.icon size={15} strokeWidth={1.75} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {section === 'general' && <General theme={theme} setTheme={setTheme} />}
          {section === 'models' && <ModelSettings />}
          {section === 'extensions' && <ExtensionsSettings />}
          {section === 'cloud' && <CloudSettings />}
          {section === 'local_model' && <LocalModelSettings />}
        </div>
      </div>
    </>
  );
}

function ModelSettings() {
  const store = useStore();
  return (
    <>
      {(['codex', 'claude_code'] as AgentKind[]).map((agent) => {
        const catalog = store.models.find((entry) => entry.agent === agent);
        const preferred = store.modelPreferences.defaults[agent] ?? '';
        const hidden = store.modelPreferences.hidden[agent] ?? [];
        return (
          <Section
            key={agent}
            title={`${providerName(agent)} models`}
            description="Choose the model for new tasks and which models appear in the chat picker."
            actions={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void action(() => store.detect())}
              >
                <RefreshCw size={13} /> Refresh
              </Button>
            }
          >
            <Row
              label="Default model"
              description="Used for new tasks unless you choose another model in chat."
            >
              <Select
                aria-label={`${providerName(agent)} default model`}
                value={preferred}
                onChange={(event) => store.setModelDefault(agent, event.target.value)}
                className="max-w-56"
              >
                <option value="">Use provider default</option>
                {catalog?.models
                  .filter((model) => model.available)
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                {preferred && !catalog?.models.some((model) => model.id === preferred) && (
                  <option value={preferred}>{preferred}</option>
                )}
              </Select>
            </Row>
            <div className="divide-y divide-line/60">
              {catalog?.models.map((model) => (
                <Row key={model.id} label={model.label} description={model.id}>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`${hidden.includes(model.id) ? 'Show' : 'Hide'} ${model.label}`}
                    onClick={() =>
                      store.setModelVisible(agent, model.id, hidden.includes(model.id))
                    }
                  >
                    {hidden.includes(model.id) ? 'Show' : 'Hide'}
                  </Button>
                </Row>
              ))}
              {!catalog && <p className="py-4 text-xs text-muted">Detecting models…</p>}
            </div>
          </Section>
        );
      })}
    </>
  );
}

/** Loads a policy and saves each change as it's made. */
function usePolicy<T extends object>(name: string) {
  const [policy, setPolicy] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<T | null>(null);
  const update = (value: T) => {
    latest.current = value;
    setPolicy(value);
  };
  useEffect(() => {
    if (!native) return;
    rpc<T>(`get_${name}_policy`)
      .then(update)
      .catch((err) => setError(errorMessage(err)));
  }, [name]);
  const save = useCallback(
    async (patch: Partial<T>) => {
      const previous = latest.current;
      if (!previous) return;
      update({ ...previous, ...patch });
      try {
        update(await rpc<T>(`set_${name}_policy`, latest.current));
      } catch (err) {
        toast.error(errorMessage(err));
        update(previous);
      }
    },
    [name],
  );
  return { policy, save, error };
}

function PolicyState({ error }: { error: string | null }) {
  return (
    <p className="py-6 text-[13px] text-muted">
      {!native
        ? 'Available in the Perpetual desktop app.'
        : error
          ? `Couldn't load these settings: ${error}`
          : 'Loading…'}
    </p>
  );
}

function General({ theme, setTheme }: { theme: Theme; setTheme: (v: Theme) => void }) {
  const [version, setVersion] = useState('');
  const [dataDir, setDataDir] = useState('');
  useEffect(() => {
    if (!native) return;
    void getVersion().then(setVersion);
    void invoke<string>('data_dir')
      .then(setDataDir)
      .catch(() => undefined);
  }, []);
  return (
    <>
      <Section title="Appearance">
        <div className="grid grid-cols-3 gap-3">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className={cn(
                'rounded-xl border p-1.5 text-left transition-colors',
                t === theme ? 'border-accent' : 'border-line hover:border-muted/60',
              )}
            >
              <ThemePreview theme={t} />
              <span className="mt-1.5 block px-1 pb-0.5 text-xs capitalize">{t}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Keyboard shortcuts">
        <div className="divide-y divide-line/60">
          {(
            [
              ['New task', keys('N')],
              ['Search tasks', keys('K')],
              ['Show or hide the sidebar', keys('B')],
              ['Open settings', keys(',')],
              ['Send message', ['Enter']],
              ['New line', ['Shift', 'Enter']],
            ] as const
          ).map(([label, keys]) => (
            <Row key={label} label={label} className="py-2.5">
              <span className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </Row>
          ))}
        </div>
      </Section>
      <Section title="About">
        <div className="divide-y divide-line/60">
          <Row label="Version" description={version ? `Perpetual ${version}` : undefined}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void action(() => openUrl(`${REPO}/releases`))}
            >
              Release notes
              <ExternalLink size={12} />
            </Button>
          </Row>
          <Row label="Help and feedback" description="Report a problem or request a feature.">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void action(() => openUrl(`${REPO}/issues`))}
            >
              Open issues
              <ExternalLink size={12} />
            </Button>
          </Row>
          {dataDir && (
            <Row
              label="Data folder"
              description={
                <span className="font-mono text-[11px] break-all selectable">{dataDir}</span>
              }
            />
          )}
          <Row
            label="Privacy"
            description={`Tasks, settings, and sign-ins stay on this computer. Setup tokens are kept in ${credentialStore}.`}
          />
        </div>
      </Section>
    </>
  );
}

function ThemePreview({ theme }: { theme: Theme }) {
  const pane = (dark: boolean) => (
    <div className={cn('flex h-full flex-1', dark ? 'bg-[#1f1f1f]' : 'bg-[#fcfbf9]')}>
      <div className={cn('w-1/3 space-y-1.5 p-2', dark ? 'bg-[#181818]' : 'bg-[#f0efec]')}>
        <div className="h-1 w-5 rounded bg-[#8886]" />
        <div className="h-1 w-7 rounded bg-[#8884]" />
        <div className="h-1 w-6 rounded bg-[#8884]" />
      </div>
      <div className="flex flex-1 flex-col justify-end p-2">
        <div className="h-3 rounded border border-[#8885]" />
      </div>
    </div>
  );
  return (
    <div className="flex h-16 overflow-hidden rounded-lg">
      {theme === 'system' ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(theme === 'dark')
      )}
    </div>
  );
}

/** A number input that saves when it loses focus. */
function NumberField({
  value,
  onCommit,
  min = 0,
  max,
  unit,
  scale = 1,
  label,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  unit?: string;
  /** Stored value = shown value × scale (e.g. 60 to edit seconds as minutes). */
  scale?: number;
  label: string;
}) {
  const [text, setText] = useState(String(value / scale));
  useEffect(() => setText(String(value / scale)), [value, scale]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || text.trim() === '') return setText(String(value / scale));
    const clamped = Math.min(max ?? Infinity, Math.max(min, n));
    const stored = Math.round(clamped * scale);
    setText(String(stored / scale));
    if (stored !== value) onCommit(stored);
  };
  return (
    <span className="flex items-center gap-2">
      <input
        aria-label={label}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="!w-20 text-right tabular-nums"
      />
      {unit && <span className="w-14 text-xs text-muted">{unit}</span>}
    </span>
  );
}

function TextField({
  value,
  onCommit,
  placeholder,
  label,
  className,
}: {
  value: string | null | undefined;
  onCommit: (v: string | null) => void;
  placeholder?: string;
  label: string;
  className?: string;
}) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  return (
    <input
      aria-label={label}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== (value ?? '') && onCommit(text.trim() || null)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={cn('w-56', className)}
    />
  );
}

function Advanced({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink"
      >
        <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
        Advanced
      </button>
      {open && <div className="mt-2 divide-y divide-line/60">{children}</div>}
    </div>
  );
}

function StatusLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 py-2 text-[13px]">
      {ok ? (
        <CircleCheck size={15} className="mt-0.5 shrink-0 text-success" />
      ) : (
        <CircleAlert size={15} className="mt-0.5 shrink-0 text-warning" />
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function CheckButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <Button size="sm" variant="secondary" loading={busy} onClick={onClick}>
      {!busy && <RefreshCw size={13} />}
      Check status
    </Button>
  );
}

function useCheck<T>(name: string) {
  const [result, setResult] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    if (!native) return;
    setBusy(true);
    try {
      setResult(await rpc<T>(name));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [name]);
  useEffect(() => {
    void run();
  }, [run]);
  return { result, busy, run };
}

function CloudSettings() {
  const { policy, save, error } = usePolicy<CloudPolicy>('cloud');
  const check = useCheck<CloudAvailability[]>('cloud_availability');
  if (!policy) return <PolicyState error={error} />;
  const off = !policy.enabled;
  return (
    <>
      <Section
        title="Cloud continuity"
        description="Keep tasks going in the provider's cloud when this computer can't."
      >
        <div className="divide-y divide-line/60">
          <ToggleRow
            label="Continue tasks in the cloud"
            checked={policy.enabled}
            onChange={(v) => void save({ enabled: v })}
          />
          <ToggleRow
            label="When this computer goes to sleep"
            checked={policy.continue_on_sleep}
            disabled={off}
            onChange={(v) => void save({ continue_on_sleep: v })}
          />
          <ToggleRow
            label="When this computer shuts down"
            checked={policy.continue_on_shutdown}
            disabled={off}
            onChange={(v) => void save({ continue_on_shutdown: v })}
          />
          <ToggleRow
            label="Ask before handing off"
            checked={policy.require_approval}
            disabled={off}
            onChange={(v) => void save({ require_approval: v })}
          />
          <ToggleRow
            label="Allow switching providers in the cloud"
            checked={policy.allow_cross_provider}
            disabled={off}
            onChange={(v) => void save({ allow_cross_provider: v })}
          />
          <Row
            label="Codex cloud environment"
            description="The environment ID from Codex cloud settings."
          >
            <TextField
              label="Codex cloud environment"
              placeholder="Environment ID"
              value={policy.codex_env_id}
              onCommit={(v) => void save({ codex_env_id: v })}
            />
          </Row>
          <Row label="Cloud tasks at once">
            <NumberField
              label="Cloud tasks at once"
              min={1}
              max={20}
              value={policy.max_concurrent_cloud_runs}
              onCommit={(v) => void save({ max_concurrent_cloud_runs: v })}
            />
          </Row>
        </div>
        <Advanced>
          <Row label="Save progress every">
            <NumberField
              label="Checkpoint interval"
              unit="minutes"
              scale={60}
              min={1}
              value={policy.checkpoint_interval_secs}
              onCommit={(v) => void save({ checkpoint_interval_secs: v })}
            />
          </Row>
          <Row label="Check cloud tasks every">
            <NumberField
              label="Cloud check interval"
              unit="seconds"
              min={5}
              value={policy.monitor_poll_secs}
              onCommit={(v) => void save({ monitor_poll_secs: v })}
            />
          </Row>
          <Row label="Treat as stalled after" description="With no activity from the cloud task.">
            <NumberField
              label="Stall timeout"
              unit="minutes"
              scale={60}
              min={1}
              value={policy.stall_timeout_secs}
              onCommit={(v) => void save({ stall_timeout_secs: v })}
            />
          </Row>
        </Advanced>
      </Section>
      <Section
        title="Availability"
        actions={<CheckButton busy={check.busy} onClick={() => void check.run()} />}
      >
        {check.result?.map((item) => (
          <StatusLine key={item.agent} ok={item.ready}>
            <span className="flex items-center gap-2">
              <ProviderLogo agent={item.agent} size={13} />
              {providerName(item.agent)} cloud {item.ready ? 'is ready' : 'is not ready'}
            </span>
            {!item.ready && item.blockers.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {item.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </StatusLine>
        ))}
      </Section>
    </>
  );
}

export function SandboxSettings() {
  const { policy, save, error } = usePolicy<SandboxPolicy>('sandbox');
  const check = useCheck<SandboxRuntimeStatus>('detect_sandbox_runtime');
  const [prompt, setPrompt] = useState<(SandboxLoginPrompt & { title: string }) | null>(null);
  if (!policy) return <PolicyState error={error} />;
  const login = (name: string, title: string) =>
    action(async () => {
      const result = await rpc<SandboxLoginPrompt>(name);
      setPrompt({ ...result, title });
      await openUrl(result.url);
    });
  const status = check.result;
  return (
    <>
      <Section
        title="Docker Sandbox"
        description="Run Codex tasks in an isolated container instead of directly on this computer."
      >
        <div className="divide-y divide-line/60">
          <Row label="Run new tasks on">
            <Select
              aria-label="Default environment"
              value={policy.default_backend}
              onChange={(e) =>
                void save({ default_backend: e.target.value as SandboxPolicy['default_backend'] })
              }
            >
              <option value="host">This computer</option>
              <option value="docker_sandbox">Docker Sandbox</option>
            </Select>
          </Row>
          <Row label="Network access" description="What sandboxed tasks can reach.">
            <Select
              aria-label="Network access"
              value={policy.network_preset}
              onChange={(e) => void save({ network_preset: e.target.value })}
            >
              <option value="balanced">Common developer services</option>
              <option value="open">Unrestricted</option>
              <option value="locked_down">No network</option>
            </Select>
          </Row>
          <Row label="Sandboxes at once">
            <NumberField
              label="Sandboxes at once"
              min={1}
              max={16}
              value={policy.max_concurrent_sandboxes}
              onCommit={(v) => void save({ max_concurrent_sandboxes: v })}
            />
          </Row>
          <Row label="CPUs per sandbox">
            <NumberField
              label="CPUs per sandbox"
              min={1}
              max={64}
              value={policy.cpus}
              onCommit={(v) => void save({ cpus: v })}
            />
          </Row>
          <Row label="Memory per sandbox" description="For example 8g or 4096m.">
            <TextField
              label="Memory per sandbox"
              className="!w-24"
              value={policy.memory}
              onCommit={(v) => v && void save({ memory: v })}
            />
          </Row>
        </div>
        <Advanced>
          <Row label="Stop a run after">
            <NumberField
              label="Run timeout"
              unit="minutes"
              scale={60}
              min={1}
              value={policy.run_timeout_secs}
              onCommit={(v) => void save({ run_timeout_secs: v })}
            />
          </Row>
          <Row label="Stop an idle sandbox after">
            <NumberField
              label="Idle timeout"
              unit="minutes"
              scale={60}
              min={1}
              value={policy.idle_timeout_secs}
              onCommit={(v) => void save({ idle_timeout_secs: v })}
            />
          </Row>
          <Row label="Grace period when stopping">
            <NumberField
              label="Stop grace period"
              unit="seconds"
              min={0}
              value={policy.stop_grace_secs}
              onCommit={(v) => void save({ stop_grace_secs: v })}
            />
          </Row>
        </Advanced>
      </Section>
      <Section
        title="Status"
        actions={<CheckButton busy={check.busy} onClick={() => void check.run()} />}
      >
        {status && (
          <>
            <StatusLine ok={status.installed}>
              {status.installed
                ? `Docker Sandbox is installed${status.version ? ` (${status.version})` : ''}`
                : 'Docker Sandbox is not installed'}
              {status.error && <div className="mt-0.5 text-xs text-muted">{status.error}</div>}
            </StatusLine>
            {status.installed && (
              <>
                <StatusLine ok={status.authenticated}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {status.authenticated ? 'Signed in to Docker' : 'Not signed in to Docker'}
                    {!status.authenticated && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void login('sandbox_login', 'Sign in to Docker')}
                      >
                        Sign in
                      </Button>
                    )}
                  </div>
                </StatusLine>
                <StatusLine ok={status.codex_authenticated}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {status.codex_authenticated ? 'Codex is connected' : 'Codex is not connected'}
                    {!status.codex_authenticated && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void login('codex_sandbox_login', 'Connect Codex')}
                      >
                        Connect
                      </Button>
                    )}
                  </div>
                  {status.codex_error && (
                    <div className="mt-0.5 text-xs text-muted">{status.codex_error}</div>
                  )}
                </StatusLine>
              </>
            )}
          </>
        )}
      </Section>
      <Modal
        open={!!prompt}
        onOpenChange={(v) => {
          if (!v) {
            setPrompt(null);
            void check.run();
          }
        }}
        title={prompt?.title ?? ''}
        description="Enter this code in the browser window that opened."
        width={400}
        footer={
          <Button variant="primary" onClick={() => setPrompt(null)}>
            Done
          </Button>
        }
      >
        {prompt && <DeviceCode code={prompt.code} url={prompt.url} />}
      </Modal>
    </>
  );
}

function DeviceCode({ code, url }: { code: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="rounded-xl border border-line bg-sidebar px-6 py-3 font-mono text-2xl tracking-[0.2em] selectable">
        {code}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void action(async () => {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy code'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void action(() => openUrl(url))}>
          Open browser
          <ExternalLink size={12} />
        </Button>
      </div>
    </div>
  );
}

function LocalModelSettings() {
  const { policy, save, error } = usePolicy<LocalModelPolicy>('local_model');
  const check = useCheck<LocalModelStatus[]>('detect_local_models');
  if (!policy) return <PolicyState error={error} />;
  const targets = policy.targets ?? [];
  const setTargets = (next: typeof targets) => void save({ targets: next });
  const detected = (provider: string) =>
    check.result?.find((s) => s.provider === provider)?.models ?? [];
  return (
    <>
      <Section
        title="Local models"
        description="Keep working with a model on this computer, through Ollama or LM Studio, when you're offline."
      >
        <div className="divide-y divide-line/60">
          <ToggleRow
            label="Use local models when offline"
            checked={policy.use_local_fallback}
            onChange={(v) => void save({ use_local_fallback: v })}
          />
          <ToggleRow
            label="Return to cloud models when back online"
            checked={policy.switch_back_to_cloud}
            onChange={(v) => void save({ switch_back_to_cloud: v })}
          />
          <ToggleRow
            label="Resume paused cloud tasks after reconnecting"
            checked={policy.auto_resume_cloud}
            onChange={(v) => void save({ auto_resume_cloud: v })}
          />
          <Row label="Ollama address">
            <TextField
              label="Ollama address"
              value={policy.ollama_base_url}
              onCommit={(v) => v && void save({ ollama_base_url: v })}
            />
          </Row>
          <Row label="LM Studio address">
            <TextField
              label="LM Studio address"
              value={policy.lm_studio_base_url}
              onCommit={(v) => v && void save({ lm_studio_base_url: v })}
            />
          </Row>
        </div>
      </Section>
      <Section
        title="Offline models"
        description="Tried in this order."
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setTargets([...targets, { provider: 'ollama', model: '', base_url: null }])
            }
          >
            <Plus size={13} />
            Add model
          </Button>
        }
      >
        {targets.length ? (
          <div className="space-y-2">
            {targets.map((target, index) => {
              const options = detected(target.provider);
              return (
                <div key={index} className="flex gap-2">
                  <Select
                    aria-label="Local model provider"
                    value={target.provider}
                    onChange={(e) =>
                      setTargets(
                        targets.map((t, i) =>
                          i === index ? { ...t, provider: e.target.value as typeof t.provider } : t,
                        ),
                      )
                    }
                  >
                    <option value="ollama">Ollama</option>
                    <option value="lm_studio">LM Studio</option>
                  </Select>
                  {options.length ? (
                    <Select
                      aria-label="Local model"
                      className="min-w-0 flex-1"
                      value={target.model}
                      onChange={(e) =>
                        setTargets(
                          targets.map((t, i) =>
                            i === index ? { ...t, model: e.target.value } : t,
                          ),
                        )
                      }
                    >
                      <option value="">Choose a model</option>
                      {options.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                      {target.model && !options.some((m) => m.id === target.model) && (
                        <option value={target.model}>{target.model}</option>
                      )}
                    </Select>
                  ) : (
                    <TextField
                      label="Local model ID"
                      className="!w-auto min-w-0 flex-1"
                      placeholder="Model ID, e.g. qwen3:8b"
                      value={target.model}
                      onCommit={(v) =>
                        setTargets(
                          targets.map((t, i) => (i === index ? { ...t, model: v ?? '' } : t)),
                        )
                      }
                    />
                  )}
                  <Button
                    aria-label="Remove model"
                    className="w-8 px-0"
                    onClick={() => setTargets(targets.filter((_, i) => i !== index))}
                  >
                    <X size={15} />
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[13px] text-muted">No offline models yet.</p>
        )}
        <Advanced>
          <Row label="Check the connection every">
            <NumberField
              label="Connection check interval"
              unit="seconds"
              min={5}
              value={policy.probe_interval_secs}
              onCommit={(v) => void save({ probe_interval_secs: v })}
            />
          </Row>
          <Row label="Wait before going offline">
            <NumberField
              label="Offline grace period"
              unit="seconds"
              min={0}
              value={policy.offline_grace_secs}
              onCommit={(v) => void save({ offline_grace_secs: v })}
            />
          </Row>
          <Row label="Successful checks before reconnecting">
            <NumberField
              label="Successful checks before reconnecting"
              min={1}
              max={20}
              value={policy.stable_successes}
              onCommit={(v) => void save({ stable_successes: v })}
            />
          </Row>
        </Advanced>
      </Section>
      <Section
        title="Status"
        actions={<CheckButton busy={check.busy} onClick={() => void check.run()} />}
      >
        {check.result?.map((s) => (
          <StatusLine key={s.provider} ok={s.server_running}>
            {s.label}{' '}
            {s.server_running
              ? `is running · ${s.models.length} ${s.models.length === 1 ? 'model' : 'models'}`
              : s.cli_installed
                ? 'is installed but not running'
                : 'is not installed'}
          </StatusLine>
        ))}
      </Section>
    </>
  );
}
