// Minimal replacement for concurrently: spawn both dev children with fully
// inherited, open stdio (concurrently's piped/redirected stdio silently kills
// `tsx watch` children on Windows — the server child dies with no output).
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const run = (name, command) => {
  const child = spawn(command, {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
    shell: isWin,
    env: process.env,
  });
  child.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown();
  });
  children.push(child);
};

const children = [];
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("server", "npx tsx watch src/cli.ts dashboard");
run("web", "npx vite --config web/vite.config.ts");
