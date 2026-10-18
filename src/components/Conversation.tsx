import { displayMessage, unpackMessage } from '../lib/attachments';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  GitCompare,
  Cloud,
  MoreHorizontal,
  Trash2,
  Pencil,
  Copy,
  Check,
  Terminal,
  ShieldAlert,
  CircleAlert,
  RefreshCw,
  Clock,
  ListOrdered,
  ExternalLink,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamingCaret } from '../lib/streamingCaret';
import { mergeThreadEvents } from '../lib/streaming';
import { toast } from 'sonner';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Queue } from './Queue';
import { LoadingState, QuestionCard, ToolRun } from './ai';
import { Review } from './Review';
import { Composer, type RunOptions } from './Composer';
import { formatQuestionAnswers, questionsFromEvent } from '../lib/userQuestions';
import { activeAccount, useStore } from '../lib/store';
import { action, native, rpc } from '../lib/api';
import { buildTranscriptItems, type TranscriptItem, type TransitionIcon } from '../lib/transcript';
import {
  INSTALL_URLS,
  PROVIDERS,
  accountName,
  agentName,
  errorMessage,
  providerName,
  resetTime,
  statusInfo,
} from '../lib/format';
import type {
  AgentKind,
  AgentThread,
  AgentThreadEvent,
  AgentTurn,
  QueuedTurn,
  CloudRun,
  ActivityEvent,
  ApprovalRequest,
} from '../lib/types';
import {
  Button,
  Confirm,
  Dot,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
  Modal,
  PerpetualMark,
  ProviderLogo,
  Tip,
  cn,
} from './ui';

const LIVE = ['running', 'running_in_cloud', 'awaiting_approval', 'queued'];

export function Conversation({
  thread,
  openReview = false,
  onReviewOpened,
  onSelect,
  onNavigate,
}: {
  thread?: AgentThread;
  /** Open the Changes panel once, then report it through `onReviewOpened`. */
  openReview?: boolean;
  onReviewOpened?: () => void;
  onNavigate: (page: string) => void;
  onSelect: (id: string | null) => void;
}) {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    setEditing(null);
  }, [thread?.id]);
  const [draft, setDraft] = useState({ text: '', seq: 0 });
  const fill = (text: string) => setDraft((old) => ({ text, seq: old.seq + 1 }));
  const [events, setEvents] = useState<AgentThreadEvent[]>([]);
  const [queued, setQueued] = useState<QueuedTurn[]>([]);
  const [cloudRuns, setCloudRuns] = useState<CloudRun[]>([]);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [turnAgents, setTurnAgents] = useState<Record<string, AgentKind>>({});
  const [loaded, setLoaded] = useState(false);
  const [review, setReview] = useState(false);
  useEffect(() => {
    if (!openReview) return;
    setReview(true);
    onReviewOpened?.();
  }, [openReview]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const received = useRef(new Map<string, AgentThreadEvent>());
  const pendingNewThread = useRef<AgentThread | undefined>(undefined);

  useEffect(() => {
    received.current.clear();
    setEvents([]);
    setLoaded(false);
    stick.current = true;
  }, [thread?.id]);

  useEffect(() => {
    if (!thread) return;
    let live = true;
    // Render history as soon as it arrives. Account/activity/turn metadata must
    // not hold the conversation behind a slower request.
    void rpc<AgentThreadEvent[]>('list_thread_events', { thread_id: thread.id })
      .then((history) => {
        if (!live) return;
        setEvents(mergeThreadEvents(history, [...received.current.values()]));
        for (const event of history) {
          const update = received.current.get(event.id);
          if (
            update &&
            update.text === event.text &&
            JSON.stringify(update.data) === JSON.stringify(event.data)
          ) {
            received.current.delete(event.id);
          }
        }
        setLoaded(true);
      })
      .catch((err) => live && toast.error(errorMessage(err)));
    void Promise.all([
      rpc<QueuedTurn[]>('list_queued_turns', { thread_id: thread.id }),
      rpc<CloudRun[]>('list_cloud_runs', { thread_id: thread.id }),
      rpc<ActivityEvent[]>('list_activity', { project_id: thread.project_id, limit: 200 }),
      rpc<AgentTurn[]>('list_thread_turns', { thread_id: thread.id }),
    ])
      .then(([q, c, a, turns]) => {
        if (!live) return;
        setTurnAgents(Object.fromEntries(turns.map((turn) => [turn.id, turn.agent_kind])));
        setQueued(q);
        setCloudRuns(c);
        setActivities(
          a.filter(
            (event) =>
              event.task_id === thread.id ||
              (event.payload as { thread_id?: string } | null)?.thread_id === thread.id,
          ),
        );
      })
      .catch((err) => live && toast.error(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [thread?.id, store.revision]);

  // Stream new and growing messages in as they happen.
  useEffect(() => {
    if (!thread) return;
    let frame: number | undefined;
    const pending = new Map<string, AgentThreadEvent>();
    const off = store.onThreadEvent((event) => {
      if (event.thread_id !== thread.id) return;
      received.current.set(event.id, event);
      pending.set(event.id, event);
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const updates = [...pending.values()];
        pending.clear();
        setEvents((old) => mergeThreadEvents(old, updates));
      });
    });
    return () => {
      off();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [thread?.id, store.onThreadEvent]);

  useLayoutEffect(() => {
    // Follow growth before paint without scrolling the surrounding application.
    const element = scroller.current;
    if (stick.current && element) element.scrollTop = element.scrollHeight;
  }, [events, queued, activities, store.approvals, thread?.status]);

  const send = async (message: string, options: RunOptions) => {
    setBusy(true);
    stick.current = true;
    try {
      let current = thread ?? pendingNewThread.current;
      if (!current) {
        current = await rpc<AgentThread>('create_agent_thread', {
          ...options,
          project_id: store.project?.id,
          title: displayMessage(message).split('\n')[0].slice(0, 64),
          objective: message,
          preferred_agent: options.agent,
          force_managed_workspace: true,
        });
        store.upsertThread(current);
        pendingNewThread.current = current;
      } else {
        await rpc('update_agent_thread', {
          id: current.id,
          patch: {
            model: options.model,
            reasoning: options.reasoning,
            permission: options.permission,
            execution_backend: options.execution_backend,
            task_budget: options.task_budget,
            local_provider: options.local_provider || null,
            local_base_url: options.local_base_url || null,
          },
        });
      }
      try {
        await rpc(editing ? 'edit_thread_message' : 'send_thread_message', {
          event_id: editing,
          thread_id: current.id,
          agent: options.agent,
          permission: options.permission,
          message,
          client_message_id: crypto.randomUUID(),
        });
        if (editing) {
          setEditing(null);
          setEvents((old) => {
            const target = old.find((e) => e.id === editing);
            const cut = target ? old.findIndex((e) => e.turn_id === target.turn_id) : -1;
            return cut >= 0 ? old.slice(0, cut) : old;
          });
          const refreshed = await rpc<AgentThreadEvent[]>('list_thread_events', {
            thread_id: current.id,
          }).catch(() => null);
          if (refreshed) setEvents(refreshed);
          setActivities(
            await rpc<ActivityEvent[]>('list_activity', {
              project_id: current.project_id,
              limit: 200,
            }).catch(() => []),
          );
        }
        if (!thread) onSelect(current.id);
      } finally {
        // Account probes and sidebar refreshes must not delay showing the reply.
        void store.refresh();
      }
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const accountLabel = (id: string) => {
    const account = store.accounts.find((a) => a.id === id);
    return account ? accountName(account) : null;
  };
  const items = useMemo(
    () =>
      buildTranscriptItems({
        thread: thread || null,
        events,
        activities,
        queued: [],
        cloudRuns,
        accountLabel,
      }),
    [thread, events, activities, cloudRuns, store.accounts],
  );
  const approvals = store.approvals.filter((a) => a.thread_id && a.thread_id === thread?.id);
  const composer = (
    <Composer
      draft={draft}
      editing={!!editing}
      onCancelEdit={() => {
        setEditing(null);
        fill('');
      }}
      hero={!thread}
      onCommand={(name) => {
        if (name === 'diff') setReview(true);
        else if (name === 'new') onSelect(null);
        else onNavigate(name === 'resume' ? 'search' : name);
      }}
      onNavigate={onNavigate}
      thread={thread}
      budgetStarted={Object.keys(turnAgents).length > 0}
      busy={busy}
      onSend={send}
      onStop={() =>
        void action(async () => {
          await rpc('stop_agent_thread', { thread_id: thread?.id });
          await store.refresh();
        })
      }
    />
  );

  if (!thread)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-6 py-10">
          <div className="mb-7 flex flex-col items-center text-center">
            <PerpetualMark size={30} />
            <h1 className="mt-4 text-[26px] font-semibold tracking-[-0.03em]">
              What should we work on?
            </h1>
          </div>
          <SetupNotice onNavigate={onNavigate} />
          {composer}
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {[
              ['Plan a change', '/plan '],
              ['Review my changes', '/review '],
              [
                'Explain this project',
                'Explain how this project is structured and how its main parts fit together.',
              ],
              ['Fix a bug', '/debug '],
            ].map(([label, text]) => (
              <button
                key={label}
                onClick={() => fill(text)}
                className="h-8 rounded-full border border-line px-3.5 text-xs text-muted transition-colors hover:bg-hover hover:text-ink"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );

  const running = LIVE.includes(thread.status);
  const lastGroupOpen = running;
  const lastAsk = [...events].reverse().find((e) => e.role === 'user');
  const runStart =
    (lastAsk && Date.parse(lastAsk.ts)) || Date.parse(thread.updated_at) || Date.now();
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ThreadBar
          thread={thread}
          cloudRuns={cloudRuns}
          review={review}
          onReview={() => setReview((v) => !v)}
          onDeleted={() => onSelect(null)}
        />
        <div
          ref={scroller}
          onScroll={() => {
            const e = scroller.current!;
            stick.current = e.scrollHeight - e.scrollTop - e.clientHeight < 120;
          }}
          className="min-h-0 flex-1 overflow-y-auto px-6"
        >
          <div className="mx-auto max-w-[760px] pt-6 pb-6">
            <Transcript
              items={items}
              agentFor={(event) =>
                turnAgents[event.turn_id] ||
                thread.active_agent ||
                thread.preferred_agent ||
                'codex'
              }
              openLast={lastGroupOpen}
              onOpenFiles={() => setReview(true)}
              onEdit={(event) => {
                if (busy || LIVE.includes(thread.status)) {
                  toast.info('Stop the task before editing a message.');
                  return;
                }
                setEditing(event.id);
                fill(event.text || '');
              }}
              onAnswer={async (text) => {
                await rpc('send_thread_message', {
                  thread_id: thread.id,
                  agent: thread.active_agent || thread.preferred_agent || 'codex',
                  permission: thread.permission,
                  message: text,
                  client_message_id: crypto.randomUUID(),
                });
                await store.refresh();
              }}
            />
            {loaded && !items.length && (
              <p className="py-16 text-center text-[13px] text-muted">
                {thread.status === 'draft' ? 'Send a message to start.' : 'Starting…'}
              </p>
            )}
            {running && items.length > 0 && <Working thread={thread} since={runStart} />}
          </div>
        </div>
        <div className="mx-auto w-full max-w-[808px] shrink-0 px-6 pt-2 pb-4">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
          <Queue turns={queued} refresh={store.refresh} />
          {composer}
        </div>
      </div>
      {review && <Review thread={thread} onClose={() => setReview(false)} />}
    </div>
  );
}

/** Explains, once, what's missing before a first task can run. */
function SetupNotice({ onNavigate }: { onNavigate: (page: string) => void }) {
  const store = useStore();
  if (!native || store.loading || !store.agents.length) return null;
  if (PROVIDERS.some((agent) => activeAccount(store.accounts, agent))) return null;
  if (
    store.agents.some((a) => a.kind === 'codex' && a.installed) &&
    store.models.some(
      (c) =>
        c.agent === 'codex' &&
        c.models.some((m) => m.available && m.source === 'openai_compatible'),
    )
  )
    return null;
  const installed = PROVIDERS.filter(
    (agent) => store.agents.find((a) => a.kind === agent)?.installed,
  );
  return (
    <div className="mb-4 rounded-xl border border-line bg-elevated/50 px-4 py-3.5">
      <div className="text-[13px] font-medium">
        {installed.length ? 'Sign in to start' : 'Install Codex or Claude Code to start'}
      </div>
      <p className="mt-0.5 text-xs leading-5 text-muted">
        {installed.length
          ? 'Perpetual runs tasks with your Codex or Claude subscription.'
          : 'Perpetual runs tasks through the Codex or Claude Code command-line tools.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {PROVIDERS.map((agent) =>
          installed.includes(agent) ? (
            <Button
              key={agent}
              size="sm"
              variant="secondary"
              onClick={() => void store.signIn({ agent })}
            >
              <ProviderLogo agent={agent} size={13} />
              Sign in to {agentName(agent)}
            </Button>
          ) : (
            <Button
              key={agent}
              size="sm"
              variant="secondary"
              onClick={() => void action(() => openUrl(INSTALL_URLS[agent]))}
            >
              <ProviderLogo agent={agent} size={13} />
              Get {providerName(agent)}
              <ExternalLink size={11} />
            </Button>
          ),
        )}
        <Button size="sm" onClick={() => onNavigate('accounts')}>
          Manage accounts
        </Button>
      </div>
    </div>
  );
}

function ThreadBar({
  thread,
  cloudRuns,
  review,
  onReview,
  onDeleted,
}: {
  thread: AgentThread;
  cloudRuns: CloudRun[];
  review: boolean;
  onReview: () => void;
  onDeleted: () => void;
}) {
  const store = useStore();
  const [rename, setRename] = useState(false);
  const [remove, setRemove] = useState(false);
  const [title, setTitle] = useState(thread.title);
  const status = statusInfo(thread.status);
  const running = LIVE.includes(thread.status);
  const agent = thread.active_agent || thread.preferred_agent;
  const account = store.accounts.find((a) => a.id === thread.provider_account_id);
  const activeCloud = cloudRuns.some((r) =>
    ['provisioning', 'running', 'stalled'].includes(r.status),
  );
  const [cloudEnabled, setCloudEnabled] = useState(false);
  useEffect(() => {
    if (native)
      rpc<{ enabled: boolean }>('get_cloud_policy')
        .then((policy) => setCloudEnabled(policy.enabled))
        .catch(() => setCloudEnabled(false));
  }, []);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line/40 px-4 text-xs">
      <span className="flex items-center gap-2 text-muted">
        <Dot tone={status.tone} live={status.live} />
        {status.label}
        {thread.status === 'waiting_for_limit' && thread.limit_reset_at && (
          <span className="text-faint">· until {resetTime(thread.limit_reset_at)}</span>
        )}
      </span>
      {agent && (
        <span className="flex min-w-0 items-center gap-1.5 text-faint">
          <span className="text-line">|</span>
          <ProviderLogo agent={agent} size={12} />
          <span className="truncate">{account ? accountName(account) : agentName(agent)}</span>
        </span>
      )}
      <span className="flex-1" />
      <Button size="sm" onClick={onReview} className={cn(review && 'bg-hover text-ink')}>
        <GitCompare size={13} />
        Changes
      </Button>
      <MenuRoot>
        <MenuTrigger asChild>
          <button
            aria-label="Task actions"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink data-[state=open]:bg-hover"
          >
            <MoreHorizontal size={16} />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="w-52">
          <MenuItem
            onSelect={() => {
              setTitle(thread.title);
              setRename(true);
            }}
          >
            <Pencil size={14} className="text-muted" />
            Rename
          </MenuItem>
          {activeCloud ? (
            <MenuItem
              onSelect={() =>
                void action(async () => {
                  await rpc('reclaim_cloud_run', { thread_id: thread.id });
                  await store.refresh();
                }, 'Brought back to this computer')
              }
            >
              <Cloud size={14} className="text-muted" />
              Bring back from cloud
            </MenuItem>
          ) : (
            cloudEnabled && (
              <MenuItem
                disabled={running}
                onSelect={() =>
                  void action(async () => {
                    await rpc('launch_cloud_handoff', { thread_id: thread.id, agent: null });
                    await store.refresh();
                  }, 'Continuing in the cloud')
                }
              >
                <Cloud size={14} className="text-muted" />
                Continue in cloud
              </MenuItem>
            )
          )}
          <MenuSeparator />
          <MenuItem danger onSelect={() => setRemove(true)}>
            <Trash2 size={14} />
            Delete
          </MenuItem>
        </MenuContent>
      </MenuRoot>
      <Modal
        open={rename}
        onOpenChange={setRename}
        title="Rename task"
        width={420}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRename(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!title.trim()}
              onClick={() =>
                void action(async () => {
                  await rpc('update_agent_thread', {
                    id: thread.id,
                    patch: { title: title.trim() },
                  });
                  await store.refresh();
                  setRename(false);
                })
              }
            >
              Save
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim()) return;
            void action(async () => {
              await rpc('update_agent_thread', { id: thread.id, patch: { title: title.trim() } });
              await store.refresh();
              setRename(false);
            });
          }}
        >
          <input
            autoFocus
            aria-label="Task name"
            className="w-full"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </form>
      </Modal>
      <Confirm
        open={remove}
        onOpenChange={setRemove}
        title="Delete this task?"
        description={
          running
            ? 'This task is still running. Deleting it stops the task and removes its conversation.'
            : 'Its conversation and history will be deleted. Changes already applied to your projects stay.'
        }
        confirmLabel={running ? 'Stop and delete' : 'Delete'}
        danger
        onConfirm={() =>
          action(async () => {
            await rpc('delete_agent_thread', { id: thread.id, force: running });
            onDeleted();
            await store.refresh();
          })
        }
      />
    </div>
  );
}

function Working({ thread, since }: { thread: AgentThread; since: number }) {
  const label =
    thread.status === 'awaiting_approval'
      ? 'Waiting for your approval'
      : thread.status === 'queued'
        ? 'Waiting to start'
        : thread.status === 'running_in_cloud'
          ? 'Working in the cloud'
          : 'Working';
  return (
    <div className="mt-3">
      <LoadingState label={label} since={since} />
    </div>
  );
}

type Block =
  | { kind: 'item'; item: TranscriptItem }
  | { kind: 'steps'; id: string; events: AgentThreadEvent[] };

const isStep = (event: AgentThreadEvent) =>
  event.role === 'tool' || event.kind.includes('tool') || event.kind === 'file_changed';

/** Groups consecutive tool calls and file edits into one collapsible block. */
function toBlocks(items: TranscriptItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    if (item.type === 'event' && isStep(item.event) && !questionsFromEvent(item.event).length) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'steps') last.events.push(item.event);
      else blocks.push({ kind: 'steps', id: item.event.id, events: [item.event] });
    } else blocks.push({ kind: 'item', item });
  }
  return blocks;
}

function Transcript({
  items,
  agentFor,
  openLast,
  onOpenFiles,
  onEdit,
  onAnswer,
}: {
  items: TranscriptItem[];
  agentFor: (event: AgentThreadEvent) => AgentKind;
  openLast: boolean;
  onOpenFiles: () => void;
  onEdit: (event: AgentThreadEvent) => void;
  onAnswer: (text: string) => Promise<void>;
}) {
  const blocks = toBlocks(items);
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === 'steps' ? (
          <ToolRun
            key={block.id}
            events={block.events}
            live={openLast && index === blocks.length - 1}
            onOpenFiles={onOpenFiles}
          />
        ) : block.item.type === 'event' ? (
          <EventMessage
            key={block.item.event.id}
            event={block.item.event}
            agent={agentFor(block.item.event)}
            answered={blocks
              .slice(index + 1)
              .some(
                (b) => b.kind === 'item' && b.item.type === 'event' && b.item.event.role === 'user',
              )}
            onEdit={onEdit}
            onAnswer={onAnswer}
          />
        ) : block.item.type === 'transition' ? (
          <Transition key={block.item.id} item={block.item} />
        ) : null,
      )}
    </>
  );
}

const TRANSITION_ICONS: Record<TransitionIcon, typeof Clock> = {
  clock: Clock,
  refresh: RefreshCw,
  alert: CircleAlert,
  queue: ListOrdered,
  cloud: Cloud,
  terminal: Terminal,
};

function Transition({ item }: { item: Extract<TranscriptItem, { type: 'transition' }> }) {
  const Icon = TRANSITION_ICONS[item.icon ?? 'refresh'];
  return (
    <div className="my-5 flex items-start justify-center gap-2 text-center text-xs">
      <Icon
        size={13}
        className={cn(
          'mt-0.5 shrink-0',
          item.tone === 'danger'
            ? 'text-danger'
            : item.tone === 'warning'
              ? 'text-warning'
              : 'text-muted',
        )}
      />
      <span className="text-muted">
        {item.text}
        {item.detail && <span className="text-faint"> · {item.detail}</span>}
      </span>
    </div>
  );
}

function EventMessage({
  event,
  agent,
  answered,
  onEdit,
  onAnswer,
}: {
  event: AgentThreadEvent;
  agent: AgentKind;
  answered: boolean;
  onEdit: (event: AgentThreadEvent) => void;
  onAnswer: (text: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const questions = questionsFromEvent(event);
  if (questions.length)
    return (
      <QuestionCard
        questions={questions}
        answered={answered}
        onSubmit={async (answers) => {
          try {
            await onAnswer(formatQuestionAnswers(questions, answers));
          } catch (error) {
            toast.error(errorMessage(error));
            throw error;
          }
        }}
      />
    );
  if (event.kind === 'error')
    return (
      <div className="my-4 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-[13px]">
        <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 break-words selectable">{errorMessage(event.text)}</div>
      </div>
    );
  // Older versions saved a canned greeting as an assistant message. It was
  // never produced by the selected agent, so do not present it as one.
  if ((event.data as { source?: string } | null)?.source === 'perpetual') return null;
  if (!event.text?.trim()) return null;
  const streaming = (event.data as { streaming?: boolean } | null)?.streaming === true;
  const copy = () =>
    void action(async () => {
      await navigator.clipboard.writeText(displayMessage(event.text || ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  const actions = (
    <span className="flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      <MessageAction label={copied ? 'Copied' : 'Copy'} onClick={copy}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </MessageAction>
      {event.role === 'user' && (
        <MessageAction label="Edit message" onClick={() => onEdit(event)}>
          <Pencil size={13} />
        </MessageAction>
      )}
    </span>
  );
  // Keep actions beneath the bubble, aligned to its right edge.
  if (event.role === 'user')
    return (
      <article className="group mt-6 mb-6 flex flex-col items-end gap-1 first:mt-0">
        <div className="max-w-[85%] rounded-2xl bg-hover px-4 py-2.5 text-[14px] leading-6 whitespace-pre-wrap break-words selectable">
          {unpackMessage(event.text || '').text}
          <div className="flex flex-wrap gap-2">
            {unpackMessage(event.text || '').attachments.map((file, i) => (
              <span key={i} className="max-w-56 text-xs text-muted">
                {file.mime.startsWith('image/') && (
                  <img
                    src={`data:${file.mime};base64,${file.data}`}
                    alt={file.name}
                    className="mb-1 max-h-40 max-w-56 rounded-lg object-contain"
                  />
                )}
                <span className="block truncate" title={file.name}>
                  📎 {file.name}
                </span>
              </span>
            ))}
          </div>
        </div>
        {actions}
      </article>
    );
  return (
    <article className="group my-4">
      <div className="mb-1.5 flex h-6 items-center gap-2 text-xs font-medium text-muted">
        <ProviderLogo agent={agent} size={14} />
        {agentName(agent)}
      </div>
      <MessageBody text={event.text} streaming={streaming} />
      {!streaming && <div className="mt-1 flex">{actions}</div>}
    </article>
  );
}

// Older Markdown does not need to be parsed again for every incoming token.
const MARKDOWN_PLUGINS = [remarkGfm];
const STREAMING_PLUGINS = [streamingCaret];
const MessageBody = memo(function MessageBody({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <div className="prose-chat">
      <Markdown
        remarkPlugins={MARKDOWN_PLUGINS}
        rehypePlugins={streaming ? STREAMING_PLUGINS : undefined}
      >
        {text}
      </Markdown>
    </div>
  );
});

function MessageAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tip label={label}>
      <button
        aria-label={label}
        onClick={onClick}
        className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-ink"
      >
        {children}
      </button>
    </Tip>
  );
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const store = useStore();
  const [pending, setPending] = useState<string | null>(null);
  const decide = (decision: 'allow' | 'allow_for_session' | 'deny' | 'abort') =>
    void (async () => {
      setPending(decision);
      await action(async () => {
        await rpc('resolve_approval', { id: approval.id, decision });
        await store.refresh();
      });
      setPending(null);
    })();
  const detail =
    approval.command?.join(' ') ||
    (approval.input && typeof approval.input === 'object' && Object.keys(approval.input).length
      ? JSON.stringify(approval.input, null, 2)
      : null);
  const what =
    approval.kind === 'command'
      ? 'run a command'
      : approval.kind === 'file_change'
        ? 'change files'
        : `use ${approval.tool_name}`;
  const pill = (tone: 'primary' | 'quiet') =>
    cn(
      'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors disabled:opacity-40',
      tone === 'primary'
        ? 'bg-ink text-surface hover:bg-ink/85'
        : 'text-muted hover:bg-hover hover:text-ink',
    );
  const busy = pending !== null;
  return (
    <div
      className="mb-3 overflow-hidden rounded-2xl border border-line bg-elevated shadow-[0_10px_40px_-24px_rgba(0,0,0,0.55)]"
      style={{ animation: 'fade-up 380ms cubic-bezier(0.23, 1, 0.32, 1) both' }}
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2 text-[13.5px] font-medium">
          <span className="flex size-5 items-center justify-center rounded-full bg-warning/15 text-warning">
            <ShieldAlert size={12} />
          </span>
          {agentName(approval.agent)} wants to {what}
        </div>
        {detail && (
          <pre className="mt-2.5 max-h-40 overflow-auto rounded-lg bg-sidebar px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all selectable">
            {detail}
          </pre>
        )}
        {approval.cwd && (
          <p className="mt-1.5 truncate font-mono text-[11px] text-faint">in {approval.cwd}</p>
        )}
        {approval.reason && <p className="mt-2 text-xs leading-5 text-muted">{approval.reason}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line/70 px-3 py-2.5">
        <button
          type="button"
          disabled={busy}
          className={pill('quiet')}
          onClick={() => decide('abort')}
        >
          {pending === 'abort' ? 'Stopping…' : 'Stop task'}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          disabled={busy}
          className={pill('quiet')}
          onClick={() => decide('deny')}
        >
          Deny
        </button>
        <button
          type="button"
          disabled={busy}
          className={pill('quiet')}
          onClick={() => decide('allow_for_session')}
        >
          Allow for this task
        </button>
        <button
          type="button"
          disabled={busy}
          className={pill('primary')}
          onClick={() => decide('allow')}
        >
          {pending === 'allow' ? 'Allowing…' : 'Allow'}
        </button>
      </div>
    </div>
  );
}
