import type { ScanFinding, ScanReport, SkillspectorReport } from "./types.js";

// Installing an MCP server runs a process, which is a trust decision, so scan
// the command it would run and require an explicit acknowledgement when it looks
// dangerous. Skills are NOT inspected here: NVIDIA SkillSpector is the security
// authority for skills (see src/skillspector.ts). These patterns exist only
// because SkillSpector has no equivalent for a local MCP command.
const HIGH = "high" as const;
const MEDIUM = "medium" as const;
const LOW = "low" as const;

interface Rule {
  level: "high" | "medium" | "low";
  name: string;
  pattern: RegExp;
  detail: string;
}

const RULES: Rule[] = [
  {
    level: HIGH,
    name: "instruction-override",
    pattern:
      /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instruction|prompt|rule|direction)/i,
    detail: "Text tries to override the agent's existing instructions.",
  },
  {
    level: HIGH,
    name: "system-prompt",
    pattern: /\b(system prompt|jailbreak|developer message|you are now)\b/i,
    detail: "Text references the system prompt or attempts a role change.",
  },
  {
    level: HIGH,
    name: "always-inject",
    pattern:
      /\b(always|must)\b[^.\n]{0,30}\b(use|run|load|call|prefer)\b[^.\n]{0,20}\b(this|first|before anything)\b/i,
    detail: "Text instructs the agent to always use this entry.",
  },
  {
    level: HIGH,
    name: "secret-access",
    pattern:
      /(~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.git-credentials|keychain|login\.keychain|\/etc\/shadow)/i,
    detail: "Text references private key or credential stores.",
  },
  {
    level: HIGH,
    name: "exfiltration",
    pattern:
      /\b(curl|wget|fetch|http)\b[^.\n]{0,60}(\|\s*(sh|bash|zsh|node|python)|\bPOST\b|-d\s|\bdata-binary\b)/i,
    detail: "Text pipes downloaded content to a shell or posts data outward.",
  },
  {
    level: MEDIUM,
    name: "env-secrets",
    pattern:
      /\b(process\.env|os\.environ|\$\{?(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS))\b/i,
    detail: "Text reads environment variables that commonly hold secrets.",
  },
  {
    level: MEDIUM,
    name: "destructive-shell",
    pattern: /\b(rm\s+-rf|sudo\b|chmod\s+777|mkfs\b|dd\s+if=)/i,
    detail: "Text contains a destructive or privileged shell command.",
  },
  {
    level: MEDIUM,
    name: "raw-ip-url",
    pattern: /https?:\/\/\d{1,3}(\.\d{1,3}){3}(:\d+)?/,
    detail: "Text points at a bare IP address rather than a named host.",
  },
  {
    level: LOW,
    name: "base64-blob",
    pattern: /\b[A-Za-z0-9+/]{200,}={0,2}\b/,
    detail: "Text contains a large base64-like blob.",
  },
];

const MAX_FINDINGS = 12;

export function scanText(text: string): ScanReport {
  const findings: ScanFinding[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    findings.push({
      level: rule.level,
      rule: rule.name,
      detail: `${rule.detail} (matched "${match[0].trim().slice(0, 60)}")`,
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return finish(findings);
}

// MCP servers run a command, so also inspect the command/args for shell tricks.
export function scanMcpConfig(config: Record<string, unknown>): ScanReport {
  const parts: string[] = [];
  const command = config.command;
  if (typeof command === "string") parts.push(command);
  if (Array.isArray(command)) parts.push(command.map(String).join(" "));
  if (Array.isArray(config.args)) parts.push(config.args.map(String).join(" "));
  const url = config.url || config.serverUrl;
  if (typeof url === "string") parts.push(url);
  const text = parts.join(" ");
  const report = scanText(text);
  if (/(\|\s*(sh|bash|zsh)|curl[^\n]{0,80}\|\s*(sh|bash))/i.test(text)) {
    if (!report.findings.some((finding) => finding.rule === "exfiltration")) {
      report.findings.unshift({
        level: HIGH,
        rule: "download-and-run",
        detail: "The server command downloads and pipes code into a shell.",
      });
    }
  }
  return finish(report.findings);
}

function finish(findings: ScanFinding[]): ScanReport {
  const requiresAck = findings.some(
    (finding) =>
      finding.level === "high" ||
      finding.level === "medium" ||
      finding.level === "critical",
  );
  const gate = gateMode() === "off" ? "allow" : requiresAck ? "ack" : "allow";
  return {
    ok: findings.length === 0 && gate === "allow",
    requires_ack: gate === "ack",
    gate,
    findings,
  };
}

// --- The install gate -------------------------------------------------------
//
// The security authority for a skill is NVIDIA SkillSpector
// (github.com/NVIDIA/skillspector), driven by src/skillspector.ts. Its
// recommendation maps straight onto the gate, exactly as the project documents:
// SAFE -> allow, CAUTION -> acknowledge, DO_NOT_INSTALL -> block. JIT does not
// second-guess that verdict with patterns of its own. The `scanText` rules above
// are used only for MCP server commands, which SkillSpector does not inspect.

export type GateMode = "block" | "warn" | "off";

/** What a caller can present to pass the gate: an acknowledgement or a force. */
export interface SecurityGate {
  acknowledge?: boolean;
  force?: boolean;
}

/** `JIT_SECURITY_GATE`: block (default), warn (never hard-block), or off. */
export function gateMode(): GateMode {
  const raw = String(process.env.JIT_SECURITY_GATE || "").trim().toLowerCase();
  return raw === "warn" || raw === "off" ? raw : "block";
}

/**
 * Turn a SkillSpector verdict into the install gate. A verdict we could not
 * obtain — scanner missing, timeout, unreadable output, or a recommendation we do
 * not recognise — asks for an explicit acknowledgement rather than passing
 * silently. A skill is never installed without *some* answer about its safety.
 */
export function securityReport(scanner: SkillspectorReport | null): ScanReport {
  const findings: ScanFinding[] = (scanner?.findings || []).map((finding) => ({
    ...finding,
    scanner: "skillspector" as const,
  }));

  let gate: "allow" | "ack" | "block";
  if (!scanner || !scanner.available) gate = "ack";
  else if (scanner.recommendation === "DO_NOT_INSTALL") gate = "block";
  else if (scanner.recommendation === "CAUTION") gate = "ack";
  else if (scanner.recommendation === "SAFE") gate = "allow";
  // Fail safe on a shape we do not understand rather than assuming it is fine.
  else gate = "ack";

  const mode = gateMode();
  if (mode === "off") gate = "allow";
  else if (mode === "warn" && gate === "block") gate = "ack";

  if (!scanner) {
    return { ok: false, requires_ack: gate === "ack", gate, findings };
  }

  return {
    ok: findings.length === 0 && gate === "allow",
    requires_ack: gate === "ack",
    findings,
    gate,
    scanners: scanner.available ? ["skillspector"] : [],
    scanner_available: scanner.available,
    scanner_source: scanner.source,
    safe_to_install: scanner.available && gate === "allow",
    ...(scanner.risk_score !== null ? { risk_score: scanner.risk_score } : {}),
    ...(scanner.severity ? { severity: scanner.severity } : {}),
    ...(scanner.recommendation
      ? { recommendation: scanner.recommendation }
      : {}),
    ...(scanner.llm_requested !== null
      ? { llm_used: Boolean(scanner.llm_requested && scanner.llm_available) }
      : {}),
    ...(scanner.error ? { note: scanner.error } : {}),
  };
}

export function ackMessage(report: ScanReport): string {
  const first = report.findings.find((finding) => finding.level !== "low");
  return (
    "this entry needs explicit acknowledgement before install" +
    (first ? `: ${first.detail}` : "")
  );
}

export function blockMessage(report: ScanReport): string {
  const score =
    typeof report.risk_score === "number" ? ` (risk ${report.risk_score}/100)` : "";
  const first = report.findings.find((finding) => finding.level !== "low");
  return (
    `blocked by the security scan${score}` +
    (first ? `: ${first.detail}` : "") +
    "; review the findings, then override explicitly to install"
  );
}

/**
 * Apply the report to an install. A `block` needs the explicit `force` override;
 * an `ack` needs `acknowledge` (or `force`). Anything else passes through.
 */
export function enforceGate(
  report: ScanReport,
  options: SecurityGate = {},
): void {
  if (report.gate === "block" && !options.force) {
    throw new Error(blockMessage(report));
  }
  if (report.gate === "ack" && !options.acknowledge && !options.force) {
    throw new Error(ackMessage(report));
  }
}

