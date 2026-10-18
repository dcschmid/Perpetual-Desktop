import {
  packMessage,
  unpackMessage,
  readAttachments,
  attachmentBytes,
  MAX_BYTES,
  type Attachment,
} from '../lib/attachments';
import { toast } from 'sonner';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Plus,
  X,
  ChevronDown,
  FolderGit2,
  FolderOpen,
  Gauge,
  Square,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { commandPrompt, parseCommand, slashCommands } from '../lib/commands';
import { activeAccount, useStore } from '../lib/store';
import { action, rpc } from '../lib/api';
import { PROVIDERS, accountName, accountState, providerName } from '../lib/format';
import type {
  AgentKind,
  AgentThread,
  AgentThreadRepo,
  ExecutionBackend,
  PermissionPolicy,
  TaskBudget,
} from '../lib/types';
import { AccountMenuContent } from './AccountSwitcher';
import { useAddFolder } from './AddFolder';
import {
  Button,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Modal,
  ProviderLogo,
  Select,
  Tip,
  cn,
} from './ui';

export interface RunOptions {
  agent: AgentKind;
  permission: PermissionPolicy;
  execution_backend: ExecutionBackend;
  model: string | null;
  reasoning: string | null;
  repo_ids: string[];
  task_budget: TaskBudget;
  local_provider?: string | null;
  local_base_url?: string | null;
}

const ACCESS: Record<PermissionPolicy, { label: string; detail: string }> = {
  read_only: { label: 'Read only', detail: 'Can read files but not change them' },
  workspace_write: { label: 'Workspace', detail: 'Can edit files in the task workspace' },
  autonomous: { label: 'Full access', detail: 'Can run any command without asking' },
};

const LAST_AGENT = 'composer.agent';
function initialAgent(thread?: AgentThread): AgentKind {
  if (thread?.active_agent) return thread.active_agent;
  try {
    const saved = localStorage.getItem(LAST_AGENT);
    if (saved === 'codex' || saved === 'claude_code') return saved;
  } catch {
    // Fall through to the default.
  }
  return 'codex';
}

export function Composer({
  thread,
  busy,
  onSend,
  onStop,
  draft,
  onCommand,
  onNavigate,
  hero,
  budgetStarted = false,
  editing = false,
  onCancelEdit,
}: {
  thread?: AgentThread;
  draft: { text: string; seq: number };
  onCommand: (name: string) => void;
  onNavigate: (page: string) => void;
  busy: boolean;
  onSend: (message: string, options: RunOptions) => Promise<boolean>;
  onStop: () => void;
  /** The larger, centered composer used to start a task. */
  hero?: boolean;
  budgetStarted?: boolean;
  editing?: boolean;
  onCancelEdit?: () => void;
}) {
  const store = useStore();
  const folder = useAddFolder();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = async (files: File[]) => {
    if (!files.length || reading || busy) return;
    setReading(true);
    try {
      const added = await readAttachments(files);
      setAttachments((old) => {
        if (old.length + added.length > 10 || attachmentBytes([...old, ...added]) > MAX_BYTES) {
          toast.error('Attach up to 10 files totaling 20 MB.');
          return old;
        }
        return [...old, ...added];
      });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setReading(false);
    }
  };
  const [agent, setAgent] = useState<AgentKind>(() => initialAgent(thread));
  const [permission, setPermission] = useState<PermissionPolicy>(
    thread?.permission || 'workspace_write',
  );
  const [repos, setRepos] = useState<string[]>([]);
  const [budget, setBudget] = useState<TaskBudget>(thread?.task_budget || { mode: 'unlimited' });
  const [budgetAmount, setBudgetAmount] = useState(
    thread?.task_budget.mode === 'tokens'
      ? String(thread.task_budget.limit_tokens)
      : thread?.task_budget.mode === 'weekly_percent'
        ? String(thread.task_budget.limit_percent)
        : '',
  );
  const [options, setOptions] = useState(false);
  const [suggestion, setSuggestion] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const beforeEdit = useRef<{ text: string; attachments: Attachment[] } | null>(null);

  const catalog = store.models.find((m) => m.agent === agent);
  const selected = store.modelPreferences.selected[agent];
  const threadUsesAgent = !!thread && (!thread.active_agent || thread.active_agent === agent);
  const model = selected?.model ?? (threadUsesAgent ? thread?.model || '' : '');
  const reasoning = selected?.reasoning ?? (threadUsesAgent ? thread?.reasoning || '' : '');
  const hiddenModels = store.modelPreferences.hidden[agent] ?? [];
  const preferredDefault = store.modelPreferences.defaults[agent] || '';
  const models =
    catalog?.models.filter(
      (m) => (m.available || m.id === model) && !hiddenModels.includes(m.id),
    ) ?? [];
  const chosenModel = catalog?.models.find(
    (m) => m.id === (model || (!thread ? preferredDefault : '')),
  );
  const defaultModel =
    catalog?.models.find((m) => m.id === preferredDefault) ??
    catalog?.models.find((m) => m.id === catalog.default_model) ??
    catalog?.models.find((m) => m.default);
  const displayedModel = chosenModel ?? (!model ? defaultModel : undefined);
  const modelLabel =
    displayedModel?.label ??
    (model.startsWith('perpetual-endpoint/')
      ? 'Endpoint unavailable'
      : model || `${providerName(agent)} chooses`);
  const defaultReasoning = displayedModel?.default_reasoning ?? catalog?.default_reasoning;
  const reasoningLabel = reasoning || defaultReasoning || `${providerName(agent)} chooses`;
  const efforts = displayedModel?.reasoning ?? catalog?.reasoning ?? [];
  const running =
    !!thread &&
    ['running', 'running_in_cloud', 'awaiting_approval', 'queued'].includes(thread.status);
  const account = activeAccount(store.accounts, agent);
  // A new task starts on a provider that can run it, unless the person picks one.
  const picked = useRef(!!thread);
  useEffect(() => {
    if (picked.current || chosenModel?.local_provider || !store.accounts.length) return;
    picked.current = true;
    const other = PROVIDERS.find((p) => p !== agent);
    if (!account && other && activeAccount(store.accounts, other)) setAgent(other);
  }, [store.accounts]);
  const providerAccounts = store.accounts.filter((a) => a.agent === agent);
  const managed = providerAccounts.length > 0 && !chosenModel?.local_provider;
  const allLimited =
    managed && !account && providerAccounts.some((a) => accountState(a) === 'limited');

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (editing && !beforeEdit.current) beforeEdit.current = { text, attachments };
    if (!editing && beforeEdit.current) {
      setText(beforeEdit.current.text);
      setAttachments(beforeEdit.current.attachments);
      beforeEdit.current = null;
      return;
    }
    if (draft.seq) {
      const restored = unpackMessage(draft.text);
      setText(restored.text);
      setAttachments(restored.attachments);
      input.current?.focus();
    }
  }, [draft, editing]);
  useEffect(() => {
    if (thread?.active_agent) {
      setAgent(thread.active_agent);
    }
  }, [thread?.id, thread?.active_agent]);
  useEffect(() => {
    const next = thread?.task_budget ?? { mode: 'unlimited' as const };
    setBudget(next);
    setBudgetAmount(
      next.mode === 'tokens'
        ? String(next.limit_tokens)
        : next.mode === 'weekly_percent'
          ? String(next.limit_percent)
          : '',
    );
  }, [thread?.id]);
  useEffect(() => {
    if (!thread) return;
    void action(async () => {
      const links = await rpc<AgentThreadRepo[]>('list_thread_repos', { thread_id: thread.id });
      setRepos(links.map((link) => link.repo_id));
    });
  }, [thread?.id]);
  // Grow with the text, up to a comfortable limit.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const chooseAgent = (next: AgentKind) => {
    picked.current = true;
    setAgent(next);
    if (next === 'claude_code') {
      if (budget.mode === 'weekly_percent') {
        setBudget({ mode: 'unlimited' });
        setBudgetAmount('');
        toast.info('Weekly usage budgets require Codex. Budget turned off for Claude.');
      }
    }
    try {
      localStorage.setItem(LAST_AGENT, next);
    } catch {
      // Not persisted; the choice still applies to this task.
    }
  };
  const chooseRepos = (next: string[]) => {
    setRepos(next);
    if (thread && !running)
      void action(async () => {
        await rpc('assign_thread_repos', { thread_id: thread.id, repo_ids: next });
      });
  };

  const send = async () => {
    if ((!text.trim() && !attachments.length) || reading || busy || sending.current) return;
    const submittedText = text;
    let message = text.trim();
    let runPermission = permission;
    const command = parseCommand(message);
    if (command) {
      if (command.name === 'model') {
        const match = models.find(
          (m) =>
            m.id.toLowerCase() === command.argument.toLowerCase() ||
            m.label.toLowerCase() === command.argument.toLowerCase() ||
            m.aliases.includes(command.argument.toLowerCase()),
        );
        if (!match) {
          toast.info(
            command.argument
              ? `No model named "${command.argument}".`
              : 'Choose a model from the model menu.',
          );
          return;
        }
        store.setModelSelection(agent, match.id, '');
        setText('');
        toast.success(`Model set to ${match.label}`);
        return;
      }
      if (command.name === 'effort') {
        if (!efforts.includes(command.argument)) {
          toast.info(
            efforts.length
              ? `Choose one of: ${efforts.join(', ')}.`
              : 'This model has no reasoning levels.',
          );
          return;
        }
        store.setModelSelection(agent, model || defaultModel?.id || '', command.argument);
        setText('');
        return;
      }
      if (command.name === 'permissions') {
        const map: Record<string, PermissionPolicy> = {
          read: 'read_only',
          'read-only': 'read_only',
          read_only: 'read_only',
          write: 'workspace_write',
          workspace: 'workspace_write',
          workspace_write: 'workspace_write',
          'workspace-write': 'workspace_write',
          full: 'autonomous',
          autonomous: 'autonomous',
          'full-access': 'autonomous',
        };
        if (!map[command.argument]) {
          toast.info('Use read-only, workspace, or full-access.');
          return;
        }
        setPermission(map[command.argument]);
        setText('');
        return;
      }
      if (command.name === 'debug' && !command.argument) {
        toast.info('Describe the problem after /debug.');
        return;
      }
      const prompt = commandPrompt(command.name, command.argument, agent);
      if (prompt) {
        message = prompt;
        if (['plan', 'review', 'security-review'].includes(command.name))
          runPermission = 'read_only';
      } else {
        if (command.name === 'stop') onStop();
        else if (command.name === 'help') {
          setText('/');
          return;
        } else if (command.name === 'status')
          toast.info(
            `${providerName(agent)} · ${modelLabel} · ${reasoningLabel} reasoning · ${ACCESS[permission].label}${account ? ` · ${accountName(account)}` : ''}`,
          );
        else onCommand(command.name);
        setText('');
        return;
      }
    }
    sending.current = true;
    try {
      if (
        await onSend(packMessage(message, attachments), {
          agent,
          permission: runPermission,
          execution_backend: 'host',
          model: model || (!thread ? preferredDefault || null : null),
          reasoning: reasoning || null,
          repo_ids: repos,
          task_budget: budget,
          local_provider:
            chosenModel?.local_provider ??
            (threadUsesAgent && thread?.model === model ? thread.local_provider : null),
          local_base_url:
            chosenModel?.local_base_url ??
            (threadUsesAgent && thread?.model === model ? thread.local_base_url : null),
        })
      ) {
        setText((current) => (current === submittedText ? '' : current));
        setAttachments([]);
      }
    } finally {
      sending.current = false;
    }
  };

  const suggestions = /^\/[a-z-]*$/.test(text)
    ? slashCommands.filter(([name]) => name.startsWith(text.slice(1)))
    : [];
  useEffect(() => setSuggestion(0), [text]);
  const complete = (name: string) => {
    setText(`/${name} `);
    input.current?.focus();
  };

  const repoLabel = repos.length
    ? repos.length === 1
      ? (store.repos.find((r) => r.id === repos[0])?.name ?? '1 folder')
      : `${repos.length} projects`
    : 'No folder';

  return (
    <div className="relative">
      {suggestions.length > 0 && (
        <div
          role="listbox"
          className={cn(
            'absolute right-0 left-0 z-20 max-h-64 overflow-y-auto rounded-xl border border-line bg-elevated p-1 shadow-xl',
            hero ? 'top-full mt-2' : 'bottom-full mb-2',
          )}
        >
          {suggestions.map(([name, description], index) => (
            <button
              key={name}
              role="option"
              aria-selected={index === suggestion}
              onMouseEnter={() => setSuggestion(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(name);
              }}
              className={cn(
                'flex w-full items-center gap-4 rounded-lg px-3 py-1.5 text-left text-[13px]',
                index === suggestion && 'bg-hover',
              )}
            >
              <span className="w-32 shrink-0 font-medium">/{name}</span>
              <span className="truncate text-muted">{description}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          'rounded-2xl border border-line bg-elevated transition-colors focus-within:border-muted/50',
          hero
            ? 'shadow-[0_12px_40px_-24px_rgba(0,0,0,0.5)]'
            : 'shadow-[0_8px_30px_-22px_rgba(0,0,0,0.5)]',
        )}
      >
        {editing && (
          <div className="flex items-center justify-between px-4 pt-3 text-xs text-muted">
            Editing message · later replies will be replaced
            <button type="button" disabled={busy || reading} onClick={onCancelEdit}>
              Cancel
            </button>
          </div>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
        {(attachments.length > 0 || reading) && (
          <div className="flex flex-wrap gap-2 px-4 pt-2">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="flex max-w-48 items-center gap-2 rounded-lg bg-hover px-2 py-1 text-xs"
              >
                {a.mime.startsWith('image/') && (
                  <img
                    src={`data:${a.mime};base64,${a.data}`}
                    alt=""
                    className="h-8 w-8 rounded object-cover"
                  />
                )}
                <span className="truncate" title={a.name}>
                  {a.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  disabled={busy}
                  onClick={() => setAttachments((old) => old.filter((f) => f.id !== a.id))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {reading && <span className="text-xs text-muted">Reading files…</span>}
          </div>
        )}
        <textarea
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length) {
              e.preventDefault();
              void addFiles(Array.from(e.dataTransfer.files));
            }
          }}
          ref={input}
          aria-label="Message"
          value={text}
          rows={hero ? 3 : 1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (suggestions.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setSuggestion(
                  (i) =>
                    (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) %
                    suggestions.length,
                );
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                const [name] = suggestions[suggestion];
                if (`/${name}` !== text.trim() || e.key === 'Tab') {
                  e.preventDefault();
                  complete(name);
                  return;
                }
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setText('');
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            running
              ? 'Add a follow-up…'
              : thread
                ? 'Reply…'
                : 'Describe a task, or type / for commands'
          }
          className={cn(
            'block w-full resize-none bg-transparent px-4 text-[14px] leading-6 placeholder:text-faint',
            hero ? 'min-h-[88px] pt-4 pb-1' : 'min-h-[48px] pt-3 pb-1',
          )}
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <button
            type="button"
            aria-label="Attach files"
            title="Attach images, PDFs, or files"
            disabled={reading || busy}
            onClick={() => picker.current?.click()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <Plus size={18} />
          </button>
          <MenuRoot>
            <MenuTrigger asChild>
              <button className="flex h-8 max-w-72 items-center gap-2 rounded-lg px-2 text-xs text-ink/90 hover:bg-hover data-[state=open]:bg-hover">
                <ProviderLogo agent={agent} size={15} />
                <span className="truncate">{modelLabel}</span>
                <span className="shrink-0 text-muted capitalize">{reasoningLabel}</span>
                <ChevronDown size={12} className="shrink-0 text-muted" />
              </button>
            </MenuTrigger>
            <MenuContent align="start" side={hero ? 'bottom' : 'top'} className="w-64">
              <MenuLabel>Agent</MenuLabel>
              <MenuRadioGroup value={agent} onValueChange={(v) => chooseAgent(v as AgentKind)}>
                {PROVIDERS.map((kind) => {
                  const ready = !!activeAccount(store.accounts, kind);
                  const known = store.accounts.some((a) => a.agent === kind);
                  return (
                    <MenuRadioItem key={kind} value={kind} disabled={running && kind !== agent}>
                      <ProviderLogo agent={kind} size={14} />
                      <span className="flex-1">{providerName(kind)}</span>
                      {known && !ready && (
                        <span className="text-[11px] text-faint">Unavailable</span>
                      )}
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuSub>
                <MenuSubTrigger>
                  <span className="flex-1">Model</span>
                  <span className="max-w-28 truncate text-xs text-muted">{modelLabel}</span>
                </MenuSubTrigger>
                <MenuSubContent className="w-72">
                  <MenuRadioGroup
                    value={model || defaultModel?.id || ''}
                    onValueChange={(v) => {
                      store.setModelSelection(agent, v, '');
                    }}
                  >
                    {models.map((m) => (
                      <MenuRadioItem key={m.id} value={m.id}>
                        <span className="truncate">{m.label}</span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuSubContent>
              </MenuSub>
              <MenuSub>
                <MenuSubTrigger disabled={!efforts.length}>
                  <span className="flex-1">Reasoning</span>
                  <span className="max-w-28 truncate text-xs text-muted capitalize">
                    {reasoningLabel}
                  </span>
                </MenuSubTrigger>
                <MenuSubContent className="w-44">
                  <MenuRadioGroup
                    value={reasoning || defaultReasoning || ''}
                    onValueChange={(value) =>
                      store.setModelSelection(agent, model || defaultModel?.id || '', value)
                    }
                  >
                    {efforts.map((r) => (
                      <MenuRadioItem key={r} value={r}>
                        <span className="capitalize">{r}</span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuSubContent>
              </MenuSub>
            </MenuContent>
          </MenuRoot>

          <MenuRoot>
            <MenuTrigger asChild disabled={running}>
              <button className="flex h-8 max-w-44 items-center gap-1.5 rounded-lg px-2 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-50 data-[state=open]:bg-hover">
                <FolderGit2 size={14} className="shrink-0" />
                <span className="truncate">{repoLabel}</span>
                <ChevronDown size={12} className="shrink-0" />
              </button>
            </MenuTrigger>
            <MenuContent align="start" side={hero ? 'bottom' : 'top'} className="w-64">
              <MenuLabel>Folders this task works in</MenuLabel>
              {store.repos.map((repo) => (
                <MenuCheckboxItem
                  key={repo.id}
                  checked={repos.includes(repo.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) =>
                    chooseRepos(
                      checked ? [...repos, repo.id] : repos.filter((id) => id !== repo.id),
                    )
                  }
                >
                  <span className="truncate">{repo.name}</span>
                </MenuCheckboxItem>
              ))}
              {!store.repos.length && (
                <p className="px-2.5 pb-1.5 text-xs leading-5 text-muted">
                  Without a folder, the task starts in an empty workspace.
                </p>
              )}
              <MenuSeparator />
              <MenuItem
                onSelect={() =>
                  void folder.pick().then((repo) => {
                    if (repo && !repos.includes(repo.id)) chooseRepos([...repos, repo.id]);
                  })
                }
              >
                <FolderOpen size={14} className="text-muted" />
                Choose a folder…
              </MenuItem>
            </MenuContent>
          </MenuRoot>

          <MenuRoot>
            <MenuTrigger asChild>
              <button className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted hover:bg-hover hover:text-ink data-[state=open]:bg-hover">
                <ShieldCheck
                  size={14}
                  className={cn(permission === 'autonomous' && 'text-warning')}
                />
                <span className="hidden sm:inline">{ACCESS[permission].label}</span>
                <ChevronDown size={12} />
              </button>
            </MenuTrigger>
            <MenuContent align="start" side={hero ? 'bottom' : 'top'} className="w-72">
              <MenuLabel>Access</MenuLabel>
              <MenuRadioGroup
                value={permission}
                onValueChange={(v) => setPermission(v as PermissionPolicy)}
              >
                {(Object.keys(ACCESS) as PermissionPolicy[]).map((key) => (
                  <MenuRadioItem key={key} value={key} className="h-auto py-1.5">
                    <div>
                      <div>{ACCESS[key].label}</div>
                      <div className="text-[11px] text-muted">{ACCESS[key].detail}</div>
                    </div>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </MenuRoot>

          <Tip label="Usage budget">
            <button
              aria-label="Usage budget"
              onClick={() => setOptions(true)}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink',
                budget.mode !== 'unlimited' && 'text-accent',
              )}
            >
              <Gauge size={15} />
            </button>
          </Tip>

          <span className="flex-1" />
          {running && (
            <Tip label="Stop">
              <button
                aria-label="Stop"
                onClick={onStop}
                className="mr-1 flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink hover:bg-hover"
              >
                <Square size={11} fill="currentColor" />
              </button>
            </Tip>
          )}
          <Tip label={running ? 'Queue follow-up (Enter)' : 'Send (Enter)'}>
            <button
              aria-label={running ? 'Queue follow-up' : 'Send'}
              onClick={() => void send()}
              disabled={(!text.trim() && !attachments.length) || reading || busy}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-surface transition-opacity hover:opacity-85 disabled:opacity-25"
            >
              <ArrowUp size={17} strokeWidth={2.25} />
            </button>
          </Tip>
        </div>
      </div>

      <div className="mt-2 flex min-h-5 items-center justify-between gap-3 px-1 text-xs">
        {managed ? (
          <MenuRoot>
            <MenuTrigger asChild>
              <button
                className={cn(
                  'flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-hover',
                  account ? 'text-faint hover:text-muted' : 'text-warning',
                )}
              >
                {!account && <TriangleAlert size={12} className="shrink-0" />}
                <span className="truncate">
                  {account
                    ? accountName(account)
                    : allLimited
                      ? `Every ${providerName(agent)} account is at its limit`
                      : `No ${providerName(agent)} account is signed in`}
                </span>
                <ChevronDown size={11} className="shrink-0" />
              </button>
            </MenuTrigger>
            <AccountMenuContent
              agents={[agent]}
              side={hero ? 'bottom' : 'top'}
              onManage={() => onNavigate('accounts')}
            />
          </MenuRoot>
        ) : (
          <span />
        )}
        {budget.mode !== 'unlimited' && (
          <span className="shrink-0 text-faint">
            {budget.mode === 'tokens'
              ? `${budget.limit_tokens.toLocaleString()} tokens`
              : `${budget.limit_percent}% of weekly usage`}
          </span>
        )}
      </div>

      <Modal
        open={options}
        onOpenChange={setOptions}
        title="Usage budget"
        width={440}
        footer={
          <Button variant="primary" onClick={() => setOptions(false)}>
            Done
          </Button>
        }
      >
        <div className="grid gap-4 text-[13px]">
          <label className="grid gap-1.5">
            Budget type
            <Select
              aria-label="Budget type"
              className="flex-1"
              value={budget.mode}
              disabled={running}
              onChange={(e) => {
                const next = e.target.value;
                if (next === 'unlimited') {
                  setBudget({ mode: 'unlimited' });
                  setBudgetAmount('');
                } else if (next === 'tokens') {
                  const amount = Math.max(
                    200000,
                    budgetStarted && thread?.task_budget.mode === 'tokens'
                      ? thread.task_budget.limit_tokens
                      : 0,
                  );
                  setBudget({ mode: 'tokens', limit_tokens: amount });
                  setBudgetAmount(String(amount));
                } else {
                  const amount = Math.max(
                    5,
                    budgetStarted && thread?.task_budget.mode === 'weekly_percent'
                      ? thread.task_budget.limit_percent
                      : 0,
                  );
                  setBudget({ mode: 'weekly_percent', limit_percent: amount });
                  setBudgetAmount(String(amount));
                }
              }}
            >
              <option value="unlimited">No budget</option>
              <option
                value="tokens"
                disabled={budgetStarted && thread?.task_budget.mode !== 'tokens'}
              >
                Total tokens
              </option>
              <option
                value="weekly_percent"
                disabled={
                  agent !== 'codex' ||
                  (budgetStarted && thread?.task_budget.mode !== 'weekly_percent')
                }
              >
                Weekly usage percentage{agent !== 'codex' ? ' (Codex only)' : ''}
              </option>
            </Select>
          </label>
          {budget.mode !== 'unlimited' && (
            <label className="grid gap-1.5">
              {budget.mode === 'tokens' ? 'Token limit' : 'Weekly usage limit'}
              <div className="flex items-center gap-2">
                <input
                  aria-label={budget.mode === 'tokens' ? 'Token limit' : 'Weekly usage limit'}
                  type="number"
                  inputMode="numeric"
                  className="w-32 tabular-nums"
                  min={
                    budget.mode === 'tokens'
                      ? Math.max(
                          10000,
                          budgetStarted && thread?.task_budget.mode === 'tokens'
                            ? thread.task_budget.limit_tokens
                            : 10000,
                        )
                      : Math.max(
                          1,
                          budgetStarted && thread?.task_budget.mode === 'weekly_percent'
                            ? thread.task_budget.limit_percent
                            : 1,
                        )
                  }
                  max={budget.mode === 'tokens' ? 10000000 : 100}
                  step={1}
                  disabled={running}
                  value={budgetAmount}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setBudgetAmount(raw);
                    const amount = Number(raw);
                    if (!Number.isSafeInteger(amount)) return;
                    if (
                      budget.mode === 'tokens' &&
                      amount >=
                        Math.max(
                          10000,
                          budgetStarted && thread?.task_budget.mode === 'tokens'
                            ? thread.task_budget.limit_tokens
                            : 10000,
                        ) &&
                      amount <= 10000000
                    ) {
                      setBudget({ mode: 'tokens', limit_tokens: amount });
                    } else if (
                      budget.mode === 'weekly_percent' &&
                      amount >=
                        Math.max(
                          1,
                          budgetStarted && thread?.task_budget.mode === 'weekly_percent'
                            ? thread.task_budget.limit_percent
                            : 1,
                        ) &&
                      amount <= 100
                    ) {
                      setBudget({ mode: 'weekly_percent', limit_percent: amount });
                    }
                  }}
                  onBlur={() =>
                    setBudgetAmount(
                      String(budget.mode === 'tokens' ? budget.limit_tokens : budget.limit_percent),
                    )
                  }
                />
                <span className="text-xs text-muted">
                  {budget.mode === 'tokens' ? 'tokens' : '%'}
                </span>
              </div>
            </label>
          )}
        </div>
      </Modal>
      {folder.dialog}
    </div>
  );
}
