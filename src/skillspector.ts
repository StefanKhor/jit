import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { logger } from "./logger.js";
import { securityReport } from "./skillScan.js";
import type { ScanFinding, ScanReport, SkillspectorReport } from "./types.js";

// NVIDIA SkillSpector (github.com/NVIDIA/skillspector) is the security authority
// for skills: 71 patterns across 17 categories, an optional LLM semantic pass, a
// 0-100 risk score, and a stable JSON contract. JIT runs it the way it is
// normally used — `skillspector scan <target> --format json`, LLM analysis on
// when a provider is configured and degraded to static when it is not — and maps
// its recommendation onto the install gate. JIT does not implement security
// checks of its own.
const SPEC = "git+https://github.com/NVIDIA/skillspector.git";
const INSTALL_HINT = `install the scanner: uv tool install ${SPEC}`;

/** How the scanner was located — surfaced so the UI can explain itself. */
export type ScannerSource = SkillspectorReport["source"];

interface Scanner {
  source: ScannerSource;
  command: string[];
  hint: string;
}

const PROBE_TIMEOUT_MS = 20_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

function splitCommand(command: string): string[] {
  return (command.match(/"[^"]*"|\S+/g) || []).map((part) =>
    part.replace(/^"|"$/g, ""),
  );
}

function quote(part: string): string {
  return /\s/.test(part) ? `"${part}"` : part;
}

function probe(command: string[]): boolean {
  const [bin, ...rest] = command;
  if (!bin) return false;
  const args = [...rest, "--version"];
  const result =
    process.platform === "win32"
      ? spawnSync([bin, ...args].map(quote).join(" "), {
          shell: true,
          stdio: "ignore",
          windowsHide: true,
          timeout: PROBE_TIMEOUT_MS,
        })
      : spawnSync(bin, args, { stdio: "ignore", timeout: PROBE_TIMEOUT_MS });
  return !result.error && result.status === 0;
}

let scannerMemo: Scanner | null = null;
// A scan that fails is remembered for the life of the process. Retrying a
// missing or unreachable scanner on every add would add seconds of latency to
// each one for no new information.
let scannerFailed: { source: ScannerSource; error: string } | null = null;

/**
 * Resolve the scanner once per process: an explicit `JIT_SKILLSPECTOR` command
 * wins, then a `skillspector` on PATH, then `uvx` (the npx-like runner that
 * fetches the pinned tool on first use). `JIT_SKILLSPECTOR_OFF` disables the
 * scan, in which case every skill needs an explicit acknowledgement.
 */
export function resolveScanner(): Scanner {
  if (scannerMemo) return scannerMemo;
  if (truthy(process.env.JIT_SKILLSPECTOR_OFF)) {
    return (scannerMemo = { source: "off", command: [], hint: "" });
  }
  const configured = (process.env.JIT_SKILLSPECTOR || "").trim();
  if (configured) {
    return (scannerMemo = {
      source: "env",
      command: splitCommand(configured),
      hint: "",
    });
  }
  if (probe(["skillspector"])) {
    return (scannerMemo = {
      source: "path",
      command: ["skillspector"],
      hint: "",
    });
  }
  if (probe(["uvx"])) {
    return (scannerMemo = {
      source: "uvx",
      command: ["uvx", "--from", SPEC, "skillspector"],
      hint: "",
    });
  }
  return (scannerMemo = { source: "none", command: [], hint: INSTALL_HINT });
}

function scanTimeoutMs(): number {
  const raw = Number(process.env.JIT_SKILLSPECTOR_TIMEOUT);
  if (!Number.isFinite(raw) || raw <= 0) return 300_000;
  return Math.min(900_000, Math.max(5_000, Math.round(raw)));
}

interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

// Async so a slow scan never stalls the dashboard for other requests.
function exec(command: string[], timeout: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const [bin, ...rest] = command;
    if (!bin) {
      resolve({ status: null, stdout: "", stderr: "", error: "empty command" });
      return;
    }
    const child =
      process.platform === "win32"
        ? spawn([bin, ...rest].map(quote).join(" "), {
            shell: true,
            windowsHide: true,
          })
        : spawn(bin, rest, { windowsHide: true });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (payload: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        status: null,
        stdout,
        stderr,
        error: `scan timed out after ${Math.round(timeout / 1000)}s`,
      });
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ status: null, stdout, stderr, error: error.message });
    });
    child.on("close", (status) => {
      finish({ status, stdout, stderr, error: null });
    });
  });
}

function unavailable(
  source: ScannerSource,
  error: string | null,
): SkillspectorReport {
  return {
    available: false,
    source,
    risk_score: null,
    severity: null,
    recommendation: null,
    llm_requested: null,
    llm_available: null,
    scanner_version: null,
    findings: [],
    error,
  };
}

interface RawIssue {
  id?: unknown;
  category?: unknown;
  severity?: unknown;
  message?: unknown;
  description?: unknown;
  confidence?: unknown;
  location?: { file?: unknown; start_line?: unknown } | null;
}

interface RawReport {
  risk_assessment?: { score?: unknown; severity?: unknown; recommendation?: unknown };
  issues?: RawIssue[];
  metadata?: {
    skillspector_version?: unknown;
    llm_requested?: unknown;
    llm_available?: unknown;
    llm_error?: unknown;
  };
}

function parseJson(stdout: string): RawReport | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as RawReport) : null;
  } catch {
    return null;
  }
}

const LEVELS = new Set(["critical", "high", "medium", "low"]);

function normalizeIssues(issues: RawIssue[] | undefined): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const issue of issues || []) {
    const raw = String(issue.severity || "").trim().toLowerCase();
    const level = (LEVELS.has(raw) ? raw : "medium") as ScanFinding["level"];
    const where = issue.location?.file
      ? `${String(issue.location.file)}${
          issue.location.start_line ? `:${String(issue.location.start_line)}` : ""
        } — `
      : "";
    const what =
      issue.message || issue.description || issue.category || "security finding";
    findings.push({
      level,
      rule: String(issue.id || issue.category || "skillspector"),
      detail: `${where}${String(what)}`,
      scanner: "skillspector",
    });
    if (findings.length >= 25) break;
  }
  return findings;
}

function severityOf(value: unknown): SkillspectorReport["severity"] {
  const raw = String(value || "").trim().toUpperCase();
  return raw === "LOW" || raw === "MEDIUM" || raw === "HIGH" || raw === "CRITICAL"
    ? raw
    : null;
}

function recommendationOf(value: unknown): SkillspectorReport["recommendation"] {
  const raw = String(value || "").trim().toUpperCase();
  return raw === "SAFE" || raw === "CAUTION" || raw === "DO_NOT_INSTALL"
    ? raw
    : null;
}

/**
 * Scan a directory, file, or URL with SkillSpector and normalize the report.
 * Never throws: an unavailable scanner, a timeout, or unreadable output comes
 * back as `available: false` (with `error` set) so the caller can decide.
 */
export async function skillspectorScan(target: string): Promise<SkillspectorReport> {
  const scanner = resolveScanner();
  if (scanner.source === "off" || scanner.source === "none") {
    return unavailable(scanner.source, null);
  }
  if (scannerFailed) {
    return unavailable(scannerFailed.source, scannerFailed.error);
  }
  const extra = splitCommand(process.env.JIT_SKILLSPECTOR_ARGS || "");
  const command = [
    ...scanner.command,
    "scan",
    target,
    "--format",
    "json",
    ...extra,
  ];
  const result = await exec(command, scanTimeoutMs());
  if (result.error) {
    logger.warn("SkillSpector scan failed: %s", result.error);
    scannerFailed = { source: scanner.source, error: result.error };
    return unavailable(scanner.source, result.error);
  }
  const raw = parseJson(result.stdout);
  if (!raw) {
    const detail =
      result.status === 2
        ? "SkillSpector could not scan the target"
        : "SkillSpector returned no readable JSON report";
    logger.warn("SkillSpector: %s (exit %s)", detail, result.status);
    scannerFailed = { source: scanner.source, error: detail };
    return unavailable(scanner.source, detail);
  }
  const assessment = raw.risk_assessment || {};
  const metadata = raw.metadata || {};
  const score = Number(assessment.score);
  return {
    available: true,
    source: scanner.source,
    risk_score: Number.isFinite(score) ? score : null,
    severity: severityOf(assessment.severity),
    recommendation: recommendationOf(assessment.recommendation),
    llm_requested:
      typeof metadata.llm_requested === "boolean" ? metadata.llm_requested : null,
    llm_available:
      typeof metadata.llm_available === "boolean" ? metadata.llm_available : null,
    scanner_version: metadata.skillspector_version
      ? String(metadata.skillspector_version)
      : null,
    findings: normalizeIssues(raw.issues),
    error: metadata.llm_error ? String(metadata.llm_error) : null,
  };
}

function unavailableNote(
  source: ScannerSource,
  error: string | null,
): string {
  if (source === "off") return "the security scan is disabled (JIT_SKILLSPECTOR_OFF)";
  if (source === "none") return INSTALL_HINT;
  return error || "the SkillSpector scanner is unavailable";
}

/**
 * The one entry point the install paths use: run SkillSpector on the payload and
 * map its verdict onto the gate. Inline bodies are written to a throwaway
 * directory so the scanner sees a real skill directory, which is what it
 * expects.
 */
export async function scanSkillPayload(input: {
  body?: string;
  path?: string;
}): Promise<ScanReport> {
  const chosen = resolveScanner();
  let temp: string | null = null;
  let target = input.path || "";
  if (!target && typeof input.body === "string") {
    try {
      temp = mkdtempSync(path.join(tmpdir(), "jit-scan-"));
      writeFileSync(path.join(temp, "SKILL.md"), input.body, "utf8");
      target = temp;
    } catch {
      temp = null;
    }
  }

  let scanner: SkillspectorReport | null = null;
  try {
    scanner = target
      ? await skillspectorScan(target)
      : unavailable(chosen.source, null);
  } finally {
    if (temp) {
      try {
        rmSync(temp, { recursive: true, force: true });
      } catch {
        // Best effort: the OS reclaims the temp directory.
      }
    }
  }

  const report = securityReport(scanner);
  if (!report.scanner_available) {
    report.note = unavailableNote(
      scanner?.source ?? resolveScanner().source,
      scanner?.error ?? null,
    );
  }
  return report;
}
