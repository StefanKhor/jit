import type { ScanFinding, ScanReport } from "./types.js";

// Installing a skill injects its text into an agent's context, and installing an
// MCP server runs a process. Both are trust decisions, so scan the payload for
// the patterns that matter and let the caller require an explicit acknowledgement
// instead of installing silently.
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
    (finding) => finding.level === "high" || finding.level === "medium",
  );
  return { ok: findings.length === 0, requires_ack: requiresAck, findings };
}
