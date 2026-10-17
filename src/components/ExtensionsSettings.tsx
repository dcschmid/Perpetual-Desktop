import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderPlus, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { native, rpc } from '../lib/api';
import { errorMessage } from '../lib/format';
import { useStore } from '../lib/store';
import type { AgentKind, ExtensionCatalog, ExtensionScope } from '../lib/types';
import { Button, Card, Modal, Section, Select, Toggle } from './ui';

const field =
  'h-9 w-full rounded-lg border border-line bg-elevated px-3 text-[13px] text-ink outline-none focus-visible:border-muted';

export function ExtensionsSettings() {
  const { repos } = useStore();
  const [agent, setAgent] = useState<AgentKind>('codex');
  const [repoId, setRepoId] = useState('');
  const [catalog, setCatalog] = useState<ExtensionCatalog | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const generation = useRef(0);
  const scope: ExtensionScope = { agent, repo_id: repoId || null };

  const reload = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const next = await rpc<ExtensionCatalog>('list_extensions', {
        agent,
        repo_id: repoId || null,
      });
      if (request === generation.current) setCatalog(next);
    } catch (e) {
      if (request === generation.current) {
        setCatalog(null);
        setError(errorMessage(e));
      }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [agent, repoId]);

  useEffect(() => {
    setCatalog(null);
    if (native) void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);

  async function mutate(run: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await run();
      toast.success(message);
      await reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function importSkill() {
    try {
      const source = await open({
        directory: true,
        multiple: false,
        title: 'Choose a folder containing SKILL.md',
      });
      if (typeof source === 'string')
        await mutate(() => rpc('import_skill', { scope, source }), 'Skill imported');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  function toggle(kind: 'skill' | 'mcp', id: string, enabled: boolean) {
    void mutate(
      () => rpc('set_extension_enabled', { scope, kind, id, enabled }),
      'Saved for the next agent run',
    );
  }

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-sm font-semibold text-ink">Skills & MCP</h2>
        <p className="mt-2 max-w-xl text-[13px] leading-6 text-muted">
          Use your existing CLI extensions with local agent runs. Global choices apply to every
          project and account. Choose a repository to override them for that project.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          aria-label="Extension provider"
          value={agent}
          disabled={busy}
          onChange={(e) => setAgent(e.target.value as AgentKind)}
        >
          <option value="codex">Codex</option>
          <option value="claude_code">Claude Code</option>
        </Select>
        <Select
          aria-label="Extension scope"
          value={repoId}
          disabled={busy}
          onChange={(e) => setRepoId(e.target.value)}
        >
          <option value="">Global · all projects</option>
          {repos
            .filter((repo) => repo.local_path)
            .map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
        </Select>
        <Button
          aria-label="Refresh extensions"
          disabled={!native || busy}
          loading={loading}
          onClick={() => void reload()}
        >
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>
      {!native && (
        <p className="text-[13px] text-muted">
          Open the desktop app to manage extensions on this computer.
        </p>
      )}
      {error && (
        <Card role="alert" className="p-4 text-[13px] text-danger">
          {error}
          <Button onClick={() => void reload()}>Retry</Button>
        </Card>
      )}
      {loading && !catalog && (
        <p role="status" className="text-[13px] text-muted">
          Reading extension configuration…
        </p>
      )}
      {catalog && (
        <>
          <Section
            title="Skills"
            description="Import a folder with SKILL.md and its supporting files. Existing skills are discovered automatically."
            actions={
              <Button
                variant="secondary"
                disabled={busy || loading}
                onClick={() => void importSkill()}
              >
                <FolderPlus size={14} />
                Import skill
              </Button>
            }
          >
            <Card className="divide-y divide-line">
              {catalog.skills.length === 0 && (
                <p className="p-4 text-[13px] text-muted">No skills found in this scope.</p>
              )}
              {catalog.skills.map((skill) => (
                <ExtensionRow
                  key={skill.path}
                  name={skill.name}
                  description={skill.description}
                  detail={skill.path}
                  project={skill.project}
                  enabled={skill.enabled}
                  disabled={busy || loading}
                  onChange={() => toggle('skill', skill.path, !skill.enabled)}
                />
              ))}
            </Card>
          </Section>
          <Section
            title="MCP servers"
            description="Enable project servers here before their first run. Store credentials in environment variables or use the CLI’s OAuth login."
            actions={
              <Button
                variant="secondary"
                disabled={busy || loading}
                onClick={() => setAdding(true)}
              >
                <Plus size={14} />
                Add server
              </Button>
            }
          >
            <Card className="divide-y divide-line">
              {catalog.mcp_servers.length === 0 && (
                <p className="p-4 text-[13px] text-muted">No MCP servers found in this scope.</p>
              )}
              {catalog.mcp_servers.map((server) => (
                <ExtensionRow
                  key={server.name}
                  name={server.name}
                  description={server.transport.toUpperCase()}
                  detail={
                    server.runtime_name !== server.name
                      ? `${server.source} · CLI name: ${server.runtime_name}`
                      : server.source
                  }
                  project={server.project}
                  enabled={server.enabled}
                  disabled={busy || loading}
                  onChange={() => toggle('mcp', server.id, !server.enabled)}
                />
              ))}
            </Card>
          </Section>
          <p className="text-xs leading-5 text-muted">
            Changes apply to new local runs, including managed worktrees and isolated accounts. CLI
            trust, permissions and OAuth requirements still apply. Plugin-provided extensions are
            managed by the CLI.
          </p>
          {agent === 'claude_code' && (
            <p className="text-xs leading-5 text-muted">
              Claude Code local runs use the MCP servers listed here. Add a direct server entry to
              use an MCP server supplied by a plugin.
            </p>
          )}
          {catalog.warnings.map((warning) => (
            <p key={warning} role="status" className="text-xs text-muted">
              {warning}
            </p>
          ))}
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Configuration locations</summary>
            <ul className="mt-3 space-y-2">
              {catalog.locations.map((path) => (
                <li key={path} className="break-all font-mono">
                  {path}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {adding && (
        <AddServer
          scope={scope}
          busy={busy}
          onClose={() => setAdding(false)}
          onSave={(input) =>
            mutate(async () => {
              await rpc('add_mcp_server', input);
              setAdding(false);
            }, 'MCP server added')
          }
        />
      )}
    </div>
  );
}

function ExtensionRow({
  name,
  description,
  detail,
  project,
  enabled,
  disabled,
  onChange,
}: {
  name: string;
  description: string;
  detail: string;
  project: boolean;
  enabled: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-4 p-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{name}</span>
          <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted">
            {project ? 'Project' : 'Global'}
          </span>
        </div>
        {description && <p className="mt-1 text-xs leading-5 text-muted">{description}</p>}
        <p className="mt-1 break-all font-mono text-[10px] leading-4 text-muted">{detail}</p>
      </div>
      <Toggle label={`Enable ${name}`} checked={enabled} disabled={disabled} onChange={onChange} />
    </div>
  );
}

function AddServer({
  scope,
  busy,
  onClose,
  onSave,
}: {
  scope: ExtensionScope;
  busy: boolean;
  onClose: () => void;
  onSave: (input: unknown) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [tokenEnv, setTokenEnv] = useState('');
  const [error, setError] = useState('');
  async function submit() {
    setError('');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) {
      setError('Use a server name with letters, numbers, underscores or hyphens.');
      return;
    }
    if (transport === 'stdio' && !command.trim()) {
      setError('Enter the command to launch the server.');
      return;
    }
    if (transport === 'http' && !/^https?:\/\//.test(url)) {
      setError('Enter an http:// or https:// URL.');
      return;
    }
    await onSave({
      scope,
      name,
      transport,
      command: command || null,
      args: args.split('\n').filter(Boolean),
      url: url || null,
      env_vars: env.split(/[\s,]+/).filter(Boolean),
      bearer_token_env_var: tokenEnv || null,
    });
  }
  const label = (title: string, control: ReactNode) => (
    <label className="block space-y-1.5 text-xs text-muted">
      <span>{title}</span>
      {control}
    </label>
  );
  return (
    <Modal
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
      title="Add MCP server"
      description={
        scope.repo_id
          ? 'Save to this repository’s native MCP configuration.'
          : 'Save to your global CLI configuration.'
      }
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Add server
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {label(
          'Name',
          <input
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
          />,
        )}
        {label(
          'Transport',
          <Select value={transport} onChange={(e) => setTransport(e.target.value)}>
            <option value="stdio">Local command (stdio)</option>
            <option value="http">HTTP</option>
          </Select>,
        )}
        {transport === 'stdio' ? (
          <>
            {label(
              'Command',
              <input
                className={field}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
              />,
            )}
            {label(
              'Arguments · one per line',
              <textarea
                className={`${field} h-24 py-2 font-mono`}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder'}
              />,
            )}
            {label(
              'Environment variable names',
              <input
                className={field}
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                placeholder="MY_API_TOKEN, OTHER_VARIABLE"
              />,
            )}
          </>
        ) : (
          <>
            {label(
              'Server URL',
              <input
                className={field}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
              />,
            )}
            {label(
              'Bearer token environment variable · optional',
              <input
                className={field}
                value={tokenEnv}
                onChange={(e) => setTokenEnv(e.target.value)}
                placeholder="MY_API_TOKEN"
              />,
            )}
          </>
        )}
        <p className="text-xs leading-5 text-muted">
          Environment variables must be available to the desktop app. Saving a server does not
          connect to it or launch its command.
        </p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
