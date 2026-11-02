export function operationKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class ApiError extends Error {
  status: number;
  code: string;
  fieldErrors: Record<string, string>;
  conflicts: { itemId: string; reason: string }[];
  correlationId?: string;
  constructor(status: number, data: Record<string, unknown>) {
    super(String(data.message || "Не удалось выполнить действие"));
    this.status = status;
    this.code = String(data.code || "REQUEST_FAILED");
    this.fieldErrors = (data.fieldErrors || data.field_errors || {}) as Record<
      string,
      string
    >;
    this.conflicts = (data.conflicts || []) as {
      itemId: string;
      reason: string;
    }[];
    this.correlationId = String(
      data.correlationId || data.correlation_id || "",
    );
  }
}
export async function api<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
    ownerCode?: string;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined && !(options.body instanceof FormData))
    headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET")
    headers["Idempotency-Key"] = options.key || operationKey();
  if (options.ownerCode) headers["X-Owner-Code"] = options.ownerCode;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers,
      body:
        options.body instanceof FormData
          ? options.body
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
      signal: options.signal,
      keepalive: options.keepalive,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(0, {
      code: "NETWORK",
      message:
        "Нет соединения. Введённые данные остаются в текущей сессии. Проверьте сеть и повторите действие.",
    });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}
export const command = <T = unknown>(
  path: string,
  body: unknown = {},
  method = "POST",
  key?: string,
  ownerCode?: string,
) => api<T>(path, { method, body, key, ownerCode });
const demoMemory = new Map<string, unknown>();
const ephemeralDemoKey = (key:string) => /checkout-(lease|operation)|staff-operation|counter-operation/.test(key);
export function readLocal<T>(key: string, fallback: T): T {
  if (import.meta.env.VITE_PUBLIC_DEMO === "1" && ephemeralDemoKey(key)) return (demoMemory.get(key) ?? fallback) as T;
  try {
    return JSON.parse(localStorage.getItem(import.meta.env.VITE_PUBLIC_DEMO === "1" ? `luchok-demo:${key}` : key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function saveLocal(key: string, value: unknown) {
  if (import.meta.env.VITE_PUBLIC_DEMO === "1" && ephemeralDemoKey(key)) { demoMemory.set(key,value); return; }
  try {
    localStorage.setItem(import.meta.env.VITE_PUBLIC_DEMO === "1" ? `luchok-demo:${key}` : key, JSON.stringify(value));
  } catch {
    /* Device storage may be unavailable. Server remains authoritative. */
  }
}
