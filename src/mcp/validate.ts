// Lightweight JSON-schema check for JIT_CALL. JIT proxies MCP tools, so the
// client's own schema validation (which normally guards a direct call) is gone.
// Validate the basics here instead of forwarding a call the server will reject.
export function validateToolArguments(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return errors;
  }
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : undefined;
  const required = Array.isArray(schema.required)
    ? schema.required.map(String)
    : [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null) {
      errors.push(`missing required argument '${key}'`);
    }
  }
  if (!properties) return errors;
  const additional = schema.additionalProperties;
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) {
      if (additional === false) errors.push(`unexpected argument '${key}'`);
      continue;
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    const rawType = (spec as Record<string, unknown>).type;
    const expected = Array.isArray(rawType)
      ? rawType.map(String)
      : rawType
        ? [String(rawType)]
        : [];
    if (expected.length === 0 || value === undefined) continue;
    if (!matchesType(value, expected)) {
      errors.push(`argument '${key}' should be ${expected.join(" or ")}`);
    }
  }
  return errors;
}

function matchesType(value: unknown, types: string[]): boolean {
  for (const type of types) {
    switch (type) {
      case "null":
        if (value === null) return true;
        break;
      case "string":
        if (typeof value === "string") return true;
        break;
      case "number":
        if (typeof value === "number") return true;
        break;
      case "integer":
        if (typeof value === "number" && Number.isInteger(value)) return true;
        break;
      case "boolean":
        if (typeof value === "boolean") return true;
        break;
      case "array":
        if (Array.isArray(value)) return true;
        break;
      case "object":
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return true;
        }
        break;
      default:
        // Unknown type (any/composite): do not block the call.
        return true;
    }
  }
  return false;
}
