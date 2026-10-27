import { useState, type FormEvent } from "react";

import { fmt, summary } from "../format";
import { useJit } from "../state/store";
import type { BulkResult } from "../types";
import { Badge, StatusDot } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { Empty, Stat } from "../ui/Display";
import { Checkbox, Input } from "../ui/Field";
import { PageHead, Panel, PanelBody, PanelHead } from "../ui/Panel";
import { SelectAll, SelectionBar, useSelection } from "../ui/Selection";
import { Table, TableWrap, Td, Th, Tr } from "../ui/Table";

export function Skills() {
  const ctx = useJit();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const sel = useSelection(ctx.skills.map((skill) => skill.id));

  const addPath = async (event: FormEvent) => {
    event.preventDefault();
    const value = path.trim();
    if (!value) return;
    setBusy(true);
    const post = (extra: Record<string, unknown>) =>
      ctx.api<{
        found?: number;
        added?: number;
        updated?: number;
        skipped?: number;
        errors?: string[];
      }>("/api/skills/add", {
        method: "POST",
        body: JSON.stringify({ path: value, ...extra }),
      });
    try {
      const result = await post({});
      ctx.toast(
        summary(result),
        (result.errors || []).length ? "error" : "ok",
      );
      setPath("");
      await ctx.refreshAll();
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setBusyId(id);
    try {
      await ctx.api("/api/skills/toggle", {
        method: "POST",
        body: JSON.stringify({ id, enabled }),
      });
      ctx.toast(`${id} ${enabled ? "enabled" : "disabled"}.`);
      await ctx.refreshAll();
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyId("");
    }
  };

  const remove = async (id: string, managed: boolean) => {
    const skill = ctx.skills.find((entry) => entry.id === id);
    const pathLabel = skill?.path || "the source file";
    const ok = await ctx.confirmAction(
      managed ? "Uninstall this skill?" : "Unindex this skill?",
      managed
        ? `"${id}" is a JIT-owned copy at ${pathLabel}. This deletes that copy and removes it from the index. Your original local file, if any, is untouched.`
        : `"${id}" will be removed from the JIT index. The source file at ${pathLabel} is not touched.`,
      managed ? "Uninstall" : "Unindex",
    );
    if (!ok) return;
    setBusyId(id);
    try {
      await ctx.api(
        `/api/skills/${encodeURIComponent(id)}${managed ? "?purge=1" : ""}`,
        { method: "DELETE" },
      );
      ctx.toast(managed ? `Uninstalled ${id}.` : `${id} unindexed.`);
      await ctx.refreshAll();
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyId("");
    }
  };

  const bulk = async (action: "enable" | "disable" | "remove") => {
    const ids = [...sel.selected];
    if (ids.length === 0 || bulkBusy) return;
    if (action === "remove") {
      const managed = ids.filter(
        (id) => ctx.skills.find((skill) => skill.id === id)?.managed,
      ).length;
      const ok = await ctx.confirmAction(
        `Remove ${ids.length} skill${ids.length === 1 ? "" : "s"}?`,
        managed
          ? `${managed} of these are JIT-owned copies and will be deleted from disk. The rest are removed from the index only; their files stay put.`
          : "They are removed from the JIT index only. Their files are never touched.",
        "Remove",
      );
      if (!ok) return;
    }
    setBulkBusy(true);
    try {
      const result = await ctx.api<BulkResult>("/api/skills/bulk", {
        method: "POST",
        body: JSON.stringify({ ids, action }),
      });
      const verb =
        action === "remove"
          ? "Removed"
          : action === "enable"
            ? "Enabled"
            : "Disabled";
      const parts = [`${verb} ${result.ok.length}`];
      if (result.files_removed) {
        parts.push(
          `${result.files_removed} file${result.files_removed === 1 ? "" : "s"} deleted`,
        );
      }
      if (result.failed.length) parts.push(`${result.failed.length} failed`);
      ctx.toast(parts.join(" · "), result.failed.length ? "error" : "ok");
      sel.clear();
      await ctx.refreshAll();
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBulkBusy(false);
    }
  };

  const total = ctx.skills.length;
  const enabled = ctx.skills.reduce((count, skill) => count + (skill.enabled ? 1 : 0), 0);

  return (
    <div className="space-y-6">
      <PageHead
        kicker="02 — Skills"
        title={
          <span className="flex items-baseline gap-2">
            The catalog.
            <span className="num text-sm text-ink-3">{total}</span>
          </span>
        }
        description="Only what you import is indexed. JIT never scans your skill folders on startup. Transfer copies files in or out; indexing a path leaves the file where it lives."
        actions={<Button onClick={() => ctx.openTransfer("in")}>Transfer</Button>}
      />

      {ctx.skillSources ? (
        <div className="surface flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border border-line bg-inset/50 px-5 py-3.5">
          <Stat
            label="Local"
            value={fmt(ctx.skillSources.local)}
            hint="in your own folders"
          />
          <Stat
            label="JIT"
            value={fmt(ctx.skillSources.jit)}
            hint="in JIT's store"
          />
          <p className="max-w-md text-xs leading-relaxed text-ink-3">
            Counted where the files are found, so a skill that lives in both
            places appears in both numbers.
          </p>
        </div>
      ) : null}

      <Panel>
        <PanelHead
          title="Index by path"
          hint="Indexes in place. Use Transfer to copy files into JIT."
        />
        <PanelBody>
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={addPath}>
            <Input
              type="text"
              aria-label="Skill path"
              placeholder="/path/to/skills or a SKILL.md file"
              spellCheck={false}
              autoComplete="off"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              className="flex-1"
            />
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Indexing…" : "Index path"}
            </Button>
          </form>
        </PanelBody>
      </Panel>

      {total === 0 ? (
        <Panel className="border-dashed bg-panel/60">
          <Empty
            title="Nothing indexed yet."
            actions={
              <Button variant="primary" onClick={() => ctx.openTransfer("in")}>
                Transfer skills
              </Button>
            }
          >
            Paste a path above to index a skill in place.
          </Empty>
        </Panel>
      ) : (
        <Panel id="skills-table">
          <PanelHead
            title={sel.count ? `${fmt(sel.count)} selected` : "Skills"}
            hint={sel.count ? undefined : `${fmt(enabled)} of ${fmt(total)} enabled`}
            actions={
              sel.count ? (
                <SelectionBar count={sel.count} onClear={sel.clear}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => void bulk("enable")}
                  >
                    Enable
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={bulkBusy}
                    onClick={() => void bulk("disable")}
                  >
                    Disable
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={bulkBusy}
                    onClick={() => void bulk("remove")}
                  >
                    {bulkBusy ? "Working…" : "Remove"}
                  </Button>
                </SelectionBar>
              ) : null
            }
          />
          <TableWrap>
            <Table className="w-full min-w-[720px] table-fixed">
              <thead>
                <tr>
                  <Th className="w-[44px]">
                    <SelectAll selection={sel} label="Select all skills" />
                  </Th>
                  <Th>Name</Th>
                  <Th
                    className="num hidden w-[84px] text-right sm:table-cell"
                    title="Body tokens — the full skill text, fetched on demand"
                  >
                    Tokens
                  </Th>
                  <Th
                    className="num hidden w-[92px] text-right sm:table-cell"
                    title="Name and description tokens a plain skill catalog carries"
                  >
                    Plain catalog
                  </Th>
                  <Th className="w-[110px]">State</Th>
                  <Th className="w-[190px] text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {ctx.skills.map((skill) => {
                  const managed = Boolean(skill.managed);
                  const action = managed ? "Uninstall" : "Unindex";
                  const actionTitle = managed
                    ? "Delete the JIT-owned copy and remove it from the index"
                    : "Remove from the index only; the source file stays";
                  const description = skill.description || "No description";
                  const picked = sel.has(skill.id);
                  return (
                    <Tr
                      key={skill.id}
                      className={cx(picked && "bg-accent/[0.04]")}
                    >
                      <Td className="w-[44px]">
                        <Checkbox
                          checked={picked}
                          aria-label={`Select ${skill.name}`}
                          onChange={(event) =>
                            sel.toggle(skill.id, event.target.checked)
                          }
                        />
                      </Td>
                      <Td>
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            className="min-w-0 truncate text-left text-sm font-medium text-ink hover:text-accent"
                            title={skill.name}
                            onClick={() => void ctx.openSkill(skill.id)}
                          >
                            {skill.name}
                          </button>
                          <Badge tone="neutral" className="shrink-0">
                            {managed ? "JIT copy" : "Local file"}
                          </Badge>
                          <span
                            className="shrink-0"
                            title={
                              skill.has_embedding
                                ? "Embedding vector is indexed; eligible for semantic retrieval."
                                : "No embedding vector is indexed; strict semantic retrieval cannot return this skill yet."
                            }
                          >
                            <Badge tone={skill.has_embedding ? "info" : "warn"}>
                              {skill.has_embedding ? "vector ready" : "no vector"}
                            </Badge>
                          </span>
                        </div>
                        <p
                          className="mt-1 min-w-0 truncate text-xs text-ink-3"
                          title={description}
                        >
                          {description}
                        </p>
                      </Td>
                      <Td
                        className="num hidden text-right text-ink-2 sm:table-cell"
                        title="Body tokens"
                      >
                        {fmt(skill.tokens)}
                      </Td>
                      <Td
                        className="num hidden text-right text-ink-2 sm:table-cell"
                        title="Name and description tokens in a plain catalog"
                      >
                        {fmt(skill.catalog_tokens)}
                      </Td>
                      <Td>
                        <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                          <StatusDot tone={skill.enabled ? "ok" : "neutral"} />
                          {skill.enabled ? "enabled" : "disabled"}
                        </span>
                      </Td>
                      <Td className="text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId === skill.id}
                            onClick={() => void toggle(skill.id, !skill.enabled)}
                          >
                            {skill.enabled ? "Disable" : "Enable"}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busyId === skill.id}
                            title={actionTitle}
                            onClick={() => void remove(skill.id, managed)}
                          >
                            {busyId === skill.id ? "…" : action}
                          </Button>
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </Panel>
      )}
    </div>
  );
}
