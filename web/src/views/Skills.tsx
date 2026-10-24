import { useState, type FormEvent } from "react";

import { useJit } from "../context";
import { fmt, summary } from "../format";
import { Empty } from "../components/ui";

export function Skills() {
  const ctx = useJit();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState("");

  const addPath = async (event: FormEvent) => {
    event.preventDefault();
    const value = path.trim();
    if (!value) return;
    setBusy(true);
    try {
      const result = await ctx.api<{
        found?: number;
        added?: number;
        updated?: number;
        skipped?: number;
        errors?: string[];
      }>("/api/skills/add", {
        method: "POST",
        body: JSON.stringify({ path: value }),
      });
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
      if (ctx.marketLoaded) await ctx.loadMarketplace(true);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyId("");
    }
  };

  return (
    <div>
      <div className="section-head">
        <div>
          <div className="kicker">02 — Skills</div>
          <h2 className="section-title">
            The catalog.<span className="count">{ctx.skills.length}</span>
          </h2>
        </div>
        <div className="section-actions">
          <button
            className="btn btn-solid"
            onClick={() => ctx.setView("marketplace")}
          >
            Browse marketplace
          </button>
          <button className="btn" onClick={() => ctx.openTransfer("in")}>
            Transfer
          </button>
        </div>
      </div>

      <p className="section-copy">
        Only what you import is indexed. JIT never scans your skill folders on
        startup. Transfer copies files in or out; indexing a path leaves the
        file where it lives.
      </p>

      <form className="add-row" onSubmit={addPath}>
        <input
          type="text"
          placeholder="/path/to/skills or a SKILL.md file"
          spellCheck={false}
          autoComplete="off"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <button className="btn btn-solid" type="submit" disabled={busy}>
          {busy ? "Indexing…" : "Index path"}
        </button>
      </form>
      <p
        className="field-help"
        style={{ marginTop: "-14px", marginBottom: "24px" }}
      >
        Indexes in place. Use Transfer to copy files into JIT.
      </p>

      {ctx.skills.length === 0 ? (
        <Empty
          title="Nothing indexed yet."
          actions={
            <>
              <button
                className="btn btn-solid"
                onClick={() => ctx.setView("marketplace")}
              >
                Browse marketplace
              </button>
              <button className="btn" onClick={() => ctx.openTransfer("in")}>
                Transfer skills
              </button>
            </>
          }
        >
          Install from the marketplace, or paste a path above.
        </Empty>
      ) : (
        <div className="table-wrap" id="skills-table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Category</th>
                <th scope="col" className="num">
                  Tokens
                </th>
                <th scope="col">State</th>
                <th scope="col" className="actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {ctx.skills.map((skill) => {
                const category = skill.categories?.[0] || "—";
                const managed = Boolean(skill.managed);
                const action = managed ? "Uninstall" : "Unindex";
                const actionTitle = managed
                  ? "Delete the JIT-owned copy and remove it from the index"
                  : "Remove from the index only; the source file stays";
                return (
                  <tr key={skill.id}>
                    <td>
                      <span className="row-title">
                        <button
                          className="row-name"
                          onClick={() => void ctx.openSkill(skill.id)}
                        >
                          {skill.name}
                        </button>
                        <span
                          className={`tag source${managed ? " jit" : ""}`}
                        >
                          {managed ? "JIT copy" : "Local file"}
                        </span>
                      </span>
                      <div className="row-sub" title={skill.description}>
                        {skill.description || "No description"}
                      </div>
                    </td>
                    <td>
                      <span className="tag">{category}</span>
                    </td>
                    <td className="num">{fmt(skill.tokens)}</td>
                    <td>
                      <span className="state">
                        <i className={`dot ${skill.enabled ? "ok" : ""}`} />
                        {skill.enabled ? "enabled" : "disabled"}
                      </span>
                    </td>
                    <td className="actions">
                      <button
                        className="btn-mini"
                        disabled={busyId === skill.id}
                        onClick={() => void toggle(skill.id, !skill.enabled)}
                      >
                        {skill.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        className="btn-mini danger"
                        disabled={busyId === skill.id}
                        title={actionTitle}
                        onClick={() => void remove(skill.id, managed)}
                      >
                        {busyId === skill.id ? "…" : action}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
