import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { native, rpc, subscribe, signIn as launchSignIn } from './api';
import { accountName, agentName, errorMessage } from './format';
import { mergeSnapshot } from './streaming';
import type {
  AgentThread,
  AgentThreadEvent,
  AgentStatus,
  AgentModelCatalog,
  LimitPolicy,
  ProviderAccountStatus,
  Project,
  Repo,
  ApprovalRequest,
  AgentKind,
  ProviderUsage,
} from './types';

export interface Snapshot {
  project: Project | null;
  threads: AgentThread[];
  repos: Repo[];
  agents: AgentStatus[];
  accounts: ProviderAccountStatus[];
  policy: LimitPolicy | null;
  models: AgentModelCatalog[];
  approvals: ApprovalRequest[];
}
export interface ModelPreferences {
  defaults: Partial<Record<AgentKind, string>>;
  hidden: Partial<Record<AgentKind, string[]>>;
  selected: Partial<Record<AgentKind, { model: string; reasoning: string }>>;
}
const MODEL_PREFERENCES_KEY = 'model.preferences';
function readModelPreferences(): ModelPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(MODEL_PREFERENCES_KEY) || '{}');
    const defaults = value?.defaults && typeof value.defaults === 'object' ? value.defaults : {};
    const hidden = value?.hidden && typeof value.hidden === 'object' ? value.hidden : {};
    const selected = value?.selected && typeof value.selected === 'object' ? value.selected : {};
    return {
      defaults: Object.fromEntries(
        (['codex', 'claude_code'] as AgentKind[])
          .filter((agent) => typeof defaults[agent] === 'string')
          .map((agent) => [agent, defaults[agent]]),
      ),
      hidden: Object.fromEntries(
        (['codex', 'claude_code'] as AgentKind[]).map((agent) => [
          agent,
          Array.isArray(hidden[agent])
            ? hidden[agent].filter((id: unknown) => typeof id === 'string')
            : [],
        ]),
      ),
      selected: Object.fromEntries(
        (['codex', 'claude_code'] as AgentKind[])
          .filter(
            (agent) =>
              typeof selected[agent]?.model === 'string' &&
              typeof selected[agent]?.reasoning === 'string',
          )
          .map((agent) => [agent, selected[agent]]),
      ),
    };
  } catch {
    return { defaults: {}, hidden: {}, selected: {} };
  }
}
const empty: Snapshot = {
  project: null,
  threads: [],
  repos: [],
  agents: [],
  accounts: [],
  policy: null,
  models: [],
  approvals: [],
};
type EventListener = (event: AgentThreadEvent) => void;
interface Store extends Snapshot {
  modelPreferences: ModelPreferences;
  setModelDefault: (agent: AgentKind, model: string) => void;
  setModelVisible: (agent: AgentKind, model: string, visible: boolean) => void;
  setModelSelection: (agent: AgentKind, model: string, reasoning: string) => void;
  /** True until the first snapshot arrives. */
  loading: boolean;
  error: string | null;
  revision: number;
  refresh: () => Promise<void>;
  detect: () => Promise<void>;
  /** Make an account the one its provider uses next. */
  activate: (account: ProviderAccountStatus) => Promise<void>;
  /** Sign in to an account, or to the provider's own CLI when none is given. */
  signIn: (target: { accountId: string } | { agent: AgentKind }) => Promise<void>;
  savePolicy: (patch: Partial<LimitPolicy>) => Promise<void>;
  /** Arrange tasks in this order (first = top), updating the list right away. */
  reorderThreads: (orderedIds: string[]) => Promise<void>;
  onThreadEvent: (listener: EventListener) => () => void;
  upsertThread: (thread: AgentThread) => void;
}
const Context = createContext<Store>(null!);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(empty);
  const [modelPreferences, setModelPreferences] = useState(readModelPreferences);
  const updateModelPreferences = useCallback(
    (update: (current: ModelPreferences) => ModelPreferences) => {
      setModelPreferences((current) => {
        const next = update(current);
        try {
          localStorage.setItem(MODEL_PREFERENCES_KEY, JSON.stringify(next));
        } catch {
          /* Keep this session's choice. */
        }
        return next;
      });
    },
    [],
  );
  const setModelDefault = useCallback(
    (agent: AgentKind, model: string) => {
      updateModelPreferences((current) => ({
        defaults: { ...current.defaults, [agent]: model },
        selected: { ...current.selected, [agent]: undefined },
        hidden: {
          ...current.hidden,
          [agent]: (current.hidden[agent] ?? []).filter((id) => id !== model),
        },
      }));
    },
    [updateModelPreferences],
  );
  const setModelVisible = useCallback(
    (agent: AgentKind, model: string, visible: boolean) => {
      updateModelPreferences((current) => ({
        defaults:
          !visible && current.defaults[agent] === model
            ? { ...current.defaults, [agent]: '' }
            : current.defaults,
        hidden: {
          ...current.hidden,
          [agent]: visible
            ? (current.hidden[agent] ?? []).filter((id) => id !== model)
            : [...new Set([...(current.hidden[agent] ?? []), model])],
        },
        selected:
          !visible && current.selected[agent]?.model === model
            ? { ...current.selected, [agent]: undefined }
            : current.selected,
      }));
    },
    [updateModelPreferences],
  );
  const setModelSelection = useCallback(
    (agent: AgentKind, model: string, reasoning: string) => {
      updateModelPreferences((current) => ({
        ...current,
        selected: { ...current.selected, [agent]: { model, reasoning } },
      }));
    },
    [updateModelPreferences],
  );
  const [loading, setLoading] = useState(native);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);
  const threadUpdates = useRef(new Map<string, AgentThread>());
  const detectionId = useRef(0);
  const detectionFlight = useRef<Promise<void> | null>(null);
  const catalogCheckedAt = useRef(0);
  const listeners = useRef(new Set<EventListener>());
  const policyRef = useRef<LimitPolicy | null>(null);
  const policyWrites = useRef(Promise.resolve());
  const pendingPolicyWrites = useRef(0);
  if (!pendingPolicyWrites.current) policyRef.current = state.policy;

  const refresh = useCallback(() => {
    if (!native) return Promise.resolve();
    if (inFlight.current) {
      refreshAgain.current = true;
      return inFlight.current;
    }
    const run = async () => {
      try {
        do {
          refreshAgain.current = false;
          threadUpdates.current.clear();
          try {
            // Start external sign-in probes concurrently, but publish the fast
            // local snapshot without waiting for them.
            const accountRequest = rpc<ProviderAccountStatus[]>('provider_account_statuses')
              .then((accounts) => ({ accounts, error: null }))
              .catch((error: unknown) => ({ accounts: null, error }));
            const project = await rpc<Project>('ensure_workbench_project');
            const [threads, repos, policy, approvals] = await Promise.all([
              rpc<AgentThread[]>('list_agent_threads', { project_id: null }),
              rpc<Repo[]>('list_repos', { project_id: project.id }),
              rpc<LimitPolicy>('get_limit_policy'),
              rpc<ApprovalRequest[]>('list_pending_approvals'),
            ]);
            const mergedThreads = mergeSnapshot(threads, [...threadUpdates.current.values()]);
            setState((old) => ({
              ...old,
              project,
              threads: mergedThreads,
              repos,
              policy: pendingPolicyWrites.current ? policyRef.current : policy,
              approvals,
            }));
            setLoading(false);
            setError(null);
            setRevision((v) => v + 1);
            const result = await accountRequest;
            if (!result.accounts) throw result.error;
            const accounts = result.accounts;
            const latest =
              accounts.length !== (policy.accounts?.length ?? 0)
                ? await rpc<LimitPolicy>('get_limit_policy')
                : policy;
            setState((old) => ({
              ...old,
              accounts,
              policy: pendingPolicyWrites.current ? policyRef.current : latest,
            }));
          } catch (err) {
            setError(errorMessage(err));
          }
        } while (refreshAgain.current);
      } finally {
        setLoading(false);
        inFlight.current = null;
      }
    };
    inFlight.current = run();
    return inFlight.current;
  }, []);

  const detect = useCallback(
    function detect(forceModels = true): Promise<void> {
      if (!native) return Promise.resolve();
      // A settings mutation can race an older catalog request. A forced
      // refresh must observe the saved endpoint state after that request ends.
      if (detectionFlight.current)
        return forceModels
          ? detectionFlight.current.then(() => detect(true))
          : detectionFlight.current;
      const run = async () => {
        const id = ++detectionId.current;
        const [agents, models] = await Promise.all([
          rpc<AgentStatus[]>('detect_agents'),
          forceModels || Date.now() - catalogCheckedAt.current > 60_000
            ? rpc<AgentModelCatalog[]>('agent_model_catalog').then((models) => {
                catalogCheckedAt.current = Date.now();
                return models;
              })
            : Promise.resolve(null),
        ]);
        if (id !== detectionId.current) return;
        setState((old) => ({
          ...old,
          agents,
          models: models
            ? models.map((incoming) => {
                const previous = old.models.find((catalog) => catalog.agent === incoming.agent);
                if (
                  !previous ||
                  previous.binary_path !== incoming.binary_path ||
                  previous.version !== incoming.version
                ) {
                  return incoming;
                }
                const ids = new Set(incoming.models.map((model) => model.id));
                return {
                  ...incoming,
                  models: [
                    ...incoming.models,
                    ...previous.models.filter(
                      (model) => !ids.has(model.id) && model.source !== 'openai_compatible',
                    ),
                  ],
                };
              })
            : old.models,
        }));
        await refresh();
      };
      detectionFlight.current = run().finally(() => {
        detectionFlight.current = null;
      });
      return detectionFlight.current;
    },
    [refresh],
  );

  const activate = useCallback(
    async (account: ProviderAccountStatus) => {
      try {
        await rpc('activate_provider_account', { account_id: account.id });
        await refresh();
        toast.success(`${agentName(account.agent)} now uses ${accountName(account)}`);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [refresh],
  );

  const signIn = useCallback(
    async (target: { accountId: string } | { agent: AgentKind }) => {
      try {
        if ('agent' in target) {
          // Reuse the CLI's own sign-in when it already has one.
          const id = await rpc<string>('add_system_provider_account', { agent: target.agent });
          const statuses = await rpc<ProviderAccountStatus[]>('provider_account_statuses');
          const existing = statuses.find((a) => a.id === id);
          if (existing?.authenticated) {
            await refresh();
            toast.success(
              `Using your ${agentName(target.agent)} sign-in: ${accountName(existing)}`,
            );
            return;
          }
          await launchSignIn(id);
        } else {
          await launchSignIn(target.accountId);
        }
        await refresh();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [refresh],
  );

  const savePolicy = useCallback(
    async (patch: Partial<LimitPolicy>) => {
      const current = policyRef.current;
      if (!current) return;
      const next = { ...current, ...patch };
      policyRef.current = next;
      pendingPolicyWrites.current += 1;
      setState((old) => ({ ...old, policy: next }));
      // Preserve consecutive toggles, including two changes before React's
      // next render, and persist them in the same order they were made.
      const write = policyWrites.current.then(() => rpc('set_limit_policy', next));
      policyWrites.current = write.then(
        () => undefined,
        () => undefined,
      );
      try {
        await write;
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        pendingPolicyWrites.current -= 1;
        if (!pendingPolicyWrites.current) await refresh();
      }
    },
    [refresh],
  );

  const reorderThreads = useCallback(
    async (orderedIds: string[]) => {
      setState((old) => {
        const byId = new Map(old.threads.map((t) => [t.id, t]));
        const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as AgentThread[];
        const rest = old.threads.filter((t) => !orderedIds.includes(t.id));
        return { ...old, threads: [...ordered, ...rest] };
      });
      try {
        await rpc('reorder_agent_threads', { ordered_ids: orderedIds });
      } catch (err) {
        toast.error(errorMessage(err));
        await refresh();
      }
    },
    [refresh],
  );

  const upsertThread = useCallback((thread: AgentThread) => {
    threadUpdates.current.set(thread.id, thread);
    setState((old) => ({
      ...old,
      threads: old.threads.some((t) => t.id === thread.id)
        ? old.threads.map((t) => (t.id === thread.id ? thread : t))
        : [thread, ...old.threads],
    }));
  }, []);

  const onThreadEvent = useCallback((listener: EventListener) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  useEffect(() => {
    void refresh();
    void detect().catch((err) => setError(errorMessage(err)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = subscribe((event) => {
      if (!event) {
        void refresh();
        return;
      }
      if (event.type === 'agent_thread_event') {
        const data = event.data as AgentThreadEvent;
        listeners.current.forEach((listener) => listener(data));
        return;
      }
      if (event.type === 'agent_thread_updated' || event.type === 'agent_thread_created') {
        const thread = event.data as AgentThread;
        upsertThread(thread);
      }
      if (event.type === 'provider_usage_updated') {
        const usage = event.data as { agent: AgentKind; usage: ProviderUsage };
        setState((old) => ({
          ...old,
          agents: old.agents.map((agent) =>
            agent.kind === usage.agent ? { ...agent, usage: usage.usage } : agent,
          ),
        }));
        return;
      }
      if (
        event.type === 'approval_requested' ||
        event.type === 'approval_resolved' ||
        event.type === 'repo_connected'
      )
        void refresh();
      // Throttle instead of debounce: a continuous token stream must still render.
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          setRevision((v) => v + 1);
        }, 250);
    });
    // Coming back to the window (for example after signing in from the provider
    // terminal) re-checks accounts right away.
    let lastFocus = 0;
    const onFocus = () => {
      if (Date.now() - lastFocus < 3000) return;
      lastFocus = Date.now();
      void detect(false).catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    const interval = setInterval(() => void refresh(), 15000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      void sub.then((off) => off());
    };
  }, [refresh, detect, upsertThread]);

  return (
    <Context.Provider
      value={{
        ...state,
        modelPreferences,
        setModelDefault,
        setModelVisible,
        setModelSelection,
        loading,
        error,
        revision,
        refresh,
        detect,
        activate,
        signIn,
        savePolicy,
        reorderThreads,
        onThreadEvent,
        upsertThread,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const useStore = () => useContext(Context);

/** The account a provider's next run uses, if any. */
export const activeAccount = (accounts: ProviderAccountStatus[], agent: AgentKind) =>
  accounts.find((a) => a.agent === agent && a.active) ?? null;
