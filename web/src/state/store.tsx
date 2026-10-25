import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { api, authKey, setAuthKey, setUnauthorizedHandler } from "../api";
import type {
  ConfirmRequest,
  Health,
  McpServerSummary,
  PublicConfig,
  SkillDetail,
  SkillListItem,
  Stats,
  ToastKind,
  ToastMessage,
  View,
} from "../types";

/**
 * Dialog state is one object rather than seven flags: they are mutually
 * independent panels over the dashboard, and keeping them together means one
 * setter instead of seven and no risk of a stale sibling.
 */
export interface DialogState {
  skill: boolean;
  skillDetail: SkillDetail | null;
  mcpAdd: boolean;
  transfer: boolean;
  transferTab: "in" | "out";
  setup: boolean;
}

const NO_DIALOGS: DialogState = {
  skill: false,
  skillDetail: null,
  mcpAdd: false,
  transfer: false,
  transferTab: "in",
  setup: false,
};

export interface AppContextValue {
  /* boot & session */
  booting: boolean;
  loginRequired: boolean;
  loginError: string;
  login: (key: string) => Promise<void>;
  logout: () => void;

  /* server state */
  health: Health | null;
  online: boolean;
  config: PublicConfig | null;
  stats: Stats | null;
  saveConfig: (updates: Record<string, unknown>) => Promise<PublicConfig>;
  setConfig: (config: PublicConfig) => void;
  loadConfig: () => Promise<PublicConfig>;

  /* index contents */
  skills: SkillListItem[];
  mcpServers: McpServerSummary[];
  loadSkills: () => Promise<SkillListItem[]>;
  loadMcp: () => Promise<McpServerSummary[]>;
  refreshAll: () => Promise<void>;

  /* navigation & chrome */
  view: View;
  setView: (view: View) => void;

  /* feedback */
  toast: (message: string, kind?: ToastKind) => void;
  toastMessage: ToastMessage | null;
  confirmAction: (title: string, text: string, label?: string) => Promise<boolean>;
  confirmRequest: ConfirmRequest | null;
  clearConfirm: () => void;

  /* dialogs */
  dialogs: DialogState;
  openSkill: (id: string) => Promise<void>;
  closeSkill: () => void;
  openTransfer: (tab?: "in" | "out") => Promise<void>;
  closeTransfer: () => void;
  openMcpAdd: () => void;
  closeMcpAdd: () => void;
  setSetupOpen: (open: boolean) => void;

  api: typeof api;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useJit(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useJit must be used inside AppProvider");
  return value;
}

/**
 * The one place that talks to the JIT server. Views read state and call the
 * handful of actions they need; nothing is threaded through props.
 */
export function AppProvider({ children }: { children: ReactNode }) {
  const [booting, setBooting] = useState(true);
  const [loginRequired, setLoginRequired] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [online, setOnline] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [view, setViewState] = useState<View>("overview");
  const [toastMessage, setToastMessage] = useState<ToastMessage | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [dialogs, setDialogs] = useState<DialogState>(NO_DIALOGS);

  const patchDialogs = useCallback(
    (patch: Partial<DialogState>) => setDialogs((current) => ({ ...current, ...patch })),
    [],
  );

  const booted = useRef(false);
  const setupShown = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const previousConfirm = useRef<((value: boolean) => void) | null>(null);

  const showToast = useCallback((message: string, kind: ToastKind = "ok") => {
    setToastMessage({ id: Date.now(), message, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMessage(null), 4200);
  }, []);

  const reportError = useCallback(
    (error: unknown) => {
      // A 401 is handled by the unauthorized handler, not by a toast.
      if (error instanceof Error && error.message === "Unauthorized") return;
      showToast(error instanceof Error ? error.message : String(error), "error");
    },
    [showToast],
  );

  const confirmAction = useCallback(
    (title: string, text: string, label = "Confirm") =>
      new Promise<boolean>((resolve) => {
        previousConfirm.current?.(false);
        previousConfirm.current = resolve;
        setConfirmRequest({ title, text, label, resolve });
      }),
    [],
  );

  const clearConfirm = useCallback(() => setConfirmRequest(null), []);

  const loadConfig = useCallback(async (): Promise<PublicConfig> => {
    const data = await api<PublicConfig>("/api/config");
    setConfig(data);
    return data;
  }, []);

  const loadStats = useCallback(async (): Promise<void> => {
    try {
      setStats(await api<Stats>("/api/stats"));
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  const loadSkills = useCallback(async (): Promise<SkillListItem[]> => {
    try {
      const data = await api<{ skills: SkillListItem[] }>("/api/skills");
      setSkills(data.skills || []);
      return data.skills || [];
    } catch (error) {
      reportError(error);
      return [];
    }
  }, [reportError]);

  const loadMcp = useCallback(async (): Promise<McpServerSummary[]> => {
    try {
      const data = await api<{ servers: McpServerSummary[] }>("/api/mcp");
      setMcpServers(data.servers || []);
      return data.servers || [];
    } catch (error) {
      reportError(error);
      return [];
    }
  }, [reportError]);

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.allSettled([loadStats(), loadSkills(), loadMcp()]);
  }, [loadMcp, loadSkills, loadStats]);

  const saveConfig = useCallback(
    async (updates: Record<string, unknown>): Promise<PublicConfig> => {
      const data = await api<{ saved: boolean; config: PublicConfig }>("/api/config", {
        method: "POST",
        body: JSON.stringify(updates),
      });
      setConfig(data.config);
      return data.config;
    },
    [],
  );

  const loadAppData = useCallback(async (): Promise<void> => {
    const cfg = await loadConfig();
    await refreshAll();
    if (cfg.first_run && !setupShown.current) {
      setupShown.current = true;
      patchDialogs({ setup: true });
    }
  }, [loadConfig, refreshAll, patchDialogs]);

  const login = useCallback(
    async (key: string): Promise<void> => {
      setAuthKey(key);
      try {
        await api("/api/status");
      } catch (error) {
        setAuthKey(null);
        throw error;
      }
      await loadAppData();
      setLoginError("");
      setLoginRequired(false);
    },
    [loadAppData],
  );

  const logout = useCallback(() => {
    setAuthKey(null);
    window.location.reload();
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setLoginRequired(true);
      setLoginError("That key was rejected.");
      setBooting(false);
    });
  }, []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      try {
        const response = await fetch("/api/health");
        if (!response.ok) throw new Error("health check failed");
        const payload = (await response.json()) as Health;
        setHealth(payload);
        setOnline(true);
        if (payload.auth_required) {
          if (!authKey()) {
            setLoginRequired(true);
            setBooting(false);
            return;
          }
          try {
            await api("/api/status");
          } catch {
            setLoginError("That key was rejected.");
            setLoginRequired(true);
            setBooting(false);
            return;
          }
        }
        await loadAppData();
        setBooting(false);
      } catch {
        setLoginError("Cannot reach the JIT server.");
        setLoginRequired(true);
        setBooting(false);
      }
    })();
  }, [loadAppData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetch("/api/health")
        .then((response) => {
          setOnline(response.ok);
          return response.ok ? response.json() : null;
        })
        .then((payload: Health | null) => {
          if (payload) setHealth(payload);
        })
        .catch(() => setOnline(false));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (loginRequired || booting) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      setViewState("search");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [booting, loginRequired]);

  const setView = useCallback(
    (next: View) => {
      setViewState(next);
      window.scrollTo(0, 0);
      if (next === "mcp") void loadMcp();
    },
    [loadMcp],
  );

  const openSkill = useCallback(
    async (id: string) => {
      try {
        const detail = await api<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`);
        patchDialogs({ skillDetail: detail, skill: true });
      } catch (error) {
        reportError(error);
      }
    },
    [patchDialogs, reportError],
  );

  const openTransfer = useCallback(
    async (tab: "in" | "out" = "in") => {
      await loadSkills();
      patchDialogs({ transferTab: tab, transfer: true });
    },
    [loadSkills, patchDialogs],
  );

  const value: AppContextValue = {
    booting,
    loginRequired,
    loginError,
    login,
    logout,
    health,
    online,
    config,
    stats,
    saveConfig,
    setConfig,
    loadConfig,
    skills,
    mcpServers,
    loadSkills,
    loadMcp,
    refreshAll,
    view,
    setView,
    toast: showToast,
    toastMessage,
    confirmAction,
    confirmRequest,
    clearConfirm,
    dialogs,
    openSkill,
    closeSkill: () => patchDialogs({ skill: false }),
    openTransfer,
    closeTransfer: () => patchDialogs({ transfer: false }),
    openMcpAdd: () => patchDialogs({ mcpAdd: true }),
    closeMcpAdd: () => patchDialogs({ mcpAdd: false }),
    setSetupOpen: (open) => patchDialogs({ setup: open }),
    api,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
