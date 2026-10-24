type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const ORDER: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const requested = (process.env.JIT_LOG_LEVEL || "INFO").toUpperCase();
const configured = (requested === "WARNING" ? "WARN" : requested) as Level;
const threshold = ORDER[configured] ?? ORDER.INFO;

function emit(level: Level, message: string, ...args: unknown[]): void {
  if (ORDER[level] < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.padEnd(5)} ${message}`;
  // Never write logs to stdout: `jit serve` uses stdout for the MCP protocol.
  console.error(line, ...args);
}

export const logger = {
  debug: (message: string, ...args: unknown[]) => emit("DEBUG", message, ...args),
  info: (message: string, ...args: unknown[]) => emit("INFO", message, ...args),
  warn: (message: string, ...args: unknown[]) => emit("WARN", message, ...args),
  error: (message: string, ...args: unknown[]) => emit("ERROR", message, ...args),
};
