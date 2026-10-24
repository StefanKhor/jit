import { Login } from "./Login";
import { Shell } from "./Shell";
import { BulkInstallDialog } from "../dialogs/BulkInstallDialog";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { MarketDialog } from "../dialogs/MarketDialog";
import { McpAddDialog } from "../dialogs/McpAddDialog";
import { McpExportDialog } from "../dialogs/McpExportDialog";
import { SetupDialog } from "../dialogs/SetupDialog";
import { SkillDialog } from "../dialogs/SkillDialog";
import { TransferDialog } from "../dialogs/TransferDialog";
import { AppProvider, useJit } from "../state/store";
import { Wordmark } from "../ui/Display";
import { Toast } from "../ui/Toast";
import { Mcp } from "../views/Mcp";
import { Marketplace } from "../views/Marketplace";
import { Overview } from "../views/Overview";
import { Search } from "../views/Search";
import { Settings } from "../views/Settings";
import { Skills } from "../views/Skills";

export function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}

/** Chooses between the boot screen, the key gate and the dashboard itself. */
function Root() {
  const ctx = useJit();

  if (ctx.booting) return <BootScreen copy="Reading the index…" />;
  if (ctx.loginRequired) {
    return <Login onLogin={ctx.login} initialError={ctx.loginError} />;
  }
  if (!ctx.config) return <BootScreen copy="The dashboard is unavailable." />;

  return (
    <>
      <Shell>
        {ctx.view === "overview" ? <Overview /> : null}
        {ctx.view === "skills" ? <Skills /> : null}
        {ctx.view === "marketplace" ? <Marketplace /> : null}
        {ctx.view === "mcp" ? <Mcp /> : null}
        {ctx.view === "search" ? <Search /> : null}
        {ctx.view === "settings" ? <Settings /> : null}
      </Shell>

      <SetupDialog
        open={ctx.dialogs.setup}
        onClose={() => ctx.setSetupOpen(false)}
      />
      <SkillDialog
        open={ctx.dialogs.skill}
        detail={ctx.dialogs.skillDetail}
        onClose={ctx.closeSkill}
      />
      <MarketDialog item={ctx.dialogs.market} onClose={ctx.closeMarket} />
      <BulkInstallDialog
        items={ctx.dialogs.marketBulk}
        onClose={ctx.closeMarketBulk}
      />
      <McpAddDialog open={ctx.dialogs.mcpAdd} onClose={ctx.closeMcpAdd} />
      <TransferDialog
        open={ctx.dialogs.transfer}
        initialTab={ctx.dialogs.transferTab}
        onClose={ctx.closeTransfer}
      />
      <McpExportDialog
        open={ctx.dialogs.mcpExport}
        onClose={ctx.closeMcpExport}
      />
      <ConfirmDialog request={ctx.confirmRequest} onDone={ctx.clearConfirm} />
      <Toast toast={ctx.toastMessage} />
    </>
  );
}

function BootScreen({ copy }: { copy: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-4">
        <Wordmark className="text-base" />
        <div className="flex items-center gap-2 text-xs text-ink-3">
          <span className="size-1 animate-pulse rounded-full bg-accent" />
          {copy}
        </div>
      </div>
    </div>
  );
}
