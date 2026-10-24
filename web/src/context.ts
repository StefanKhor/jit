import { createContext, useContext } from "react";

import { api } from "./api";
import type {
  Health,
  MarketplaceItem,
  MarketplaceResponse,
  McpServerSummary,
  PublicConfig,
  SkillDetail,
  SkillListItem,
  Stats,
  ToastKind,
  View,
} from "./types";

export interface AppContextValue {
  view: View;
  setView: (view: View) => void;
  health: Health | null;
  online: boolean;
  config: PublicConfig | null;
  stats: Stats | null;
  skills: SkillListItem[];
  mcpServers: McpServerSummary[];
  marketplace: MarketplaceResponse | null;
  marketLoaded: boolean;
  loadConfig: () => Promise<PublicConfig>;
  loadSkills: () => Promise<SkillListItem[]>;
  loadMcp: () => Promise<McpServerSummary[]>;
  loadMarketplace: (force?: boolean) => Promise<void>;
  refreshAll: () => Promise<void>;
  saveConfig: (updates: Record<string, unknown>) => Promise<PublicConfig>;
  setConfig: (config: PublicConfig) => void;
  toast: (message: string, kind?: ToastKind) => void;
  confirmAction: (
    title: string,
    text: string,
    label?: string,
  ) => Promise<boolean>;
  api: typeof api;
  skillOpen: boolean;
  skillDetail: SkillDetail | null;
  openSkill: (id: string) => Promise<void>;
  closeSkill: () => void;
  marketItem: MarketplaceItem | null;
  openMarket: (item: MarketplaceItem) => void;
  closeMarket: () => void;
  transferOpen: boolean;
  transferTab: "in" | "out";
  openTransfer: (tab?: "in" | "out") => Promise<void>;
  closeTransfer: () => void;
  mcpAddOpen: boolean;
  openMcpAdd: () => void;
  closeMcpAdd: () => void;
  mcpExportOpen: boolean;
  openMcpExport: () => Promise<void>;
  closeMcpExport: () => void;
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
  logout: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useJit(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useJit must be used inside AppContext");
  return value;
}
