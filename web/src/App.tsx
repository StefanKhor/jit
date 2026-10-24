import { useCallback, useEffect, useRef, useState } from "react";

import { api, authKey, setAuthKey, setUnauthorizedHandler } from "./api";
import { AppContext, type AppContextValue } from "./context";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import {
  ConfirmDialog,
  MarketDialog,
  McpAddDialog,
  McpExportDialog,
  SetupDialog,
  SkillDialog,
  Toast,
  TransferDialog,
} from "./components/Dialogs";
import { Brand } from "./components/ui";
import { Overview } from "./views/Overview";
import { Skills } from "./views/Skills";
import { Marketplace } from "./views/Marketplace";
import { Mcp } from "./views/Mcp";
import { Search } from "./views/Search";
import { Settings } from "./views/Settings";
import type {
  ConfirmRequest,
  Health,
  MarketplaceItem,
  MarketplaceResponse,
  McpServerSummary,
  PublicConfig,
  SkillDetail,
  SkillListItem,
  Stats,
  ToastKind,
  ToastMessage,
  View,
} from "./types";

export function App() {
  const [booting, setBooting] = useState(true);
  const [loginRequired, setLoginRequired] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [online, setOnline] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [marketplace, setMarketplace] = useState<MarketplaceResponse | null>(null);
  const [marketLoaded, setMarketLoaded] = useState(false);
  const [view, setViewState] = useState<View>("overview");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [marketItem, setMarketItem] = useState<MarketplaceItem | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTab, setTransferTab] = useState<"in" | "out">("in");
  const [mcpAddOpen, setMcpAddOpen] = useState(false);
  const [mcpExportOpen, setMcpExportOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const booted = useRef(false);
  const setupShown = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const previousConfirm = useRef<((value: boolean) => void) | null>(null);

  const showToast = useCallback((message: string, kind: ToastKind = "ok") => {
    setToast({ id: Date.now(), message, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const confirmAction = useCallback(
    (title: string, text: string, label = "Confirm") =>
      new Promise<boolean>((resolve) => {
        previousConfirm.current?.(false);
        previousConfirm.current = resolve;
        setConfirmRequest({ title, text, label, resolve });
      }),
    [],
  );

  const loadConfig = useCallback(async (): Promise<PublicConfig> => {
    const data = await api<PublicConfig>("/api/config");
    setConfig(data);
    return data;
  }, []);

  const loadStats = useCallback(async (): Promise<void> => {
    try {
      setStats(await api<Stats>("/api/stats"));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Unauthorized") {
        showToast(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }, [showToast]);

  const loadSkills = useCallback(async (): Promise<SkillListItem[]> => {
    try {
      const data = await api<{ skills: SkillListItem[] }>("/api/skills");
      setSkills(data.skills || []);
      return data.skills || [];
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Unauthorized") {
        showToast(error instanceof Error ? error.message : String(error), "error");
      }
      return [];
    }
  }, [showToast]);

  const loadMcp = useCallback(async (): Promise<McpServerSummary[]> => {
    try {
      const data = await api<{ servers: McpServerSummary[] }>("/api/mcp");
      setMcpServers(data.servers || []);
      return data.servers || [];
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Unauthorized") {
        showToast(error instanceof Error ? error.message : String(error), "error");
      }
      return [];
    }
  }, [showToast]);

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.allSettled([loadStats(), loadSkills(), loadMcp()]);
  }, [loadMcp, loadSkills, loadStats]);

  const loadMarketplace = useCallback(
    async (force = false): Promise<void> => {
      if (marketLoaded && !force) return;
      try {
        const data = await api<MarketplaceResponse>("/api/marketplace");
        setMarketplace(data);
        setMarketLoaded(true);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Unauthorized") {
          showToast(error instanceof Error ? error.message : String(error), "error");
        }
      }
    },
    [marketLoaded, showToast],
  );

  const saveConfig = useCallback(
    async (updates: Record<string, unknown>): Promise<PublicConfig> => {
      const data = await api<{ saved: boolean; config: PublicConfig }>(
        "/api/config",
        { method: "POST", body: JSON.stringify(updates) },
      );
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
      setSetupOpen(true);
    }
  }, [loadConfig, refreshAll]);

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
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
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
      if (next === "marketplace") void loadMarketplace();
      if (next === "mcp") void loadMcp();
    },
    [loadMarketplace, loadMcp],
  );

  const openSkill = useCallback(
    async (id: string) => {
      try {
        const detail = await api<SkillDetail>(
          `/api/skills/${encodeURIComponent(id)}`,
        );
        setSkillDetail(detail);
        setSkillOpen(true);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), "error");
      }
    },
    [showToast],
  );

  const openTransfer = useCallback(
    async (tab: "in" | "out" = "in") => {
      setTransferTab(tab);
      await loadSkills();
      setTransferOpen(true);
    },
    [loadSkills],
  );

  const openMcpExport = useCallback(async () => {
    const servers = await loadMcp();
    if (servers.length === 0) {
      showToast("No JIT-managed MCP servers to export.", "error");
      return;
    }
    setMcpExportOpen(true);
  }, [loadMcp, showToast]);

  const value: AppContextValue = {
    view,
    setView,
    health,
    online,
    config,
    stats,
    skills,
    mcpServers,
    marketplace,
    marketLoaded,
    loadConfig,
    loadSkills,
    loadMcp,
    loadMarketplace,
    refreshAll,
    saveConfig,
    setConfig,
    toast: showToast,
    confirmAction,
    api,
    skillOpen,
    skillDetail,
    openSkill,
    closeSkill: () => setSkillOpen(false),
    marketItem,
    openMarket: setMarketItem,
    closeMarket: () => setMarketItem(null),
    transferOpen,
    transferTab,
    openTransfer,
    closeTransfer: () => setTransferOpen(false),
    mcpAddOpen,
    openMcpAdd: () => setMcpAddOpen(true),
    closeMcpAdd: () => setMcpAddOpen(false),
    mcpExportOpen,
    openMcpExport,
    closeMcpExport: () => setMcpExportOpen(false),
    setupOpen,
    setSetupOpen,
    logout,
  };

  if (booting) {
    return (
      <div className="boot-screen">
        <Brand size={28} />
        <div className="wordmark">JIT</div>
        <div className="boot-copy">Reading the index…</div>
      </div>
    );
  }

  if (loginRequired) {
    return <Login onLogin={login} initialError={loginError} />;
  }

  if (!config) {
    return (
      <div className="boot-screen">
        <Brand size={28} />
        <div className="wordmark">JIT</div>
        <div className="boot-copy">The dashboard is unavailable.</div>
      </div>
    );
  }

  return (
    <AppContext.Provider value={value}>
      <Shell>
        {view === "overview" ? <Overview /> : null}
        {view === "skills" ? <Skills /> : null}
        {view === "marketplace" ? <Marketplace /> : null}
        {view === "mcp" ? <Mcp /> : null}
        {view === "search" ? <Search /> : null}
        {view === "settings" ? <Settings /> : null}
      </Shell>

      <SetupDialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
      />
      <SkillDialog
        open={skillOpen}
        detail={skillDetail}
        onClose={() => setSkillOpen(false)}
      />
      <MarketDialog item={marketItem} onClose={() => setMarketItem(null)} />
      <McpAddDialog
        open={mcpAddOpen}
        onClose={() => setMcpAddOpen(false)}
      />
      <TransferDialog
        open={transferOpen}
        initialTab={transferTab}
        onClose={() => setTransferOpen(false)}
      />
      <McpExportDialog
        open={mcpExportOpen}
        onClose={() => setMcpExportOpen(false)}
      />
      <ConfirmDialog
        request={confirmRequest}
        onDone={() => setConfirmRequest(null)}
      />
      <Toast toast={toast} />
    </AppContext.Provider>
  );
}
