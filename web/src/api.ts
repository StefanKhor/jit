export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let unauthorizedHandler: () => void = () => {};

export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

export function authKey(): string {
  try {
    return localStorage.getItem("jit_api_key") || "";
  } catch {
    return "";
  }
}

export function setAuthKey(key: string | null): void {
  try {
    if (key) localStorage.setItem("jit_api_key", key);
    else localStorage.removeItem("jit_api_key");
  } catch {
    // Storage can be unavailable in private contexts.
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...((options.headers as Record<string, string> | undefined) || {}),
  };
  const key = authKey();
  if (key) headers["X-API-Key"] = key;

  let response: Response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new ApiError("Cannot reach the JIT server.");
  }

  if (response.status === 401) {
    unauthorizedHandler();
    throw new ApiError("Unauthorized", 401);
  }

  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}
