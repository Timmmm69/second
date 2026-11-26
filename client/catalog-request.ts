import { api } from "./api";

declare global {
  interface Window {
    luchokCatalogStarted?: boolean;
    luchokCatalogRequest?: { path: string; response: Promise<Response>; controller: AbortController };
  }
}

export function requestCatalog<T>(path: string, signal: AbortSignal) {
  window.luchokCatalogStarted = true;
  const early = window.luchokCatalogRequest;
  delete window.luchokCatalogRequest;
  if (early?.path === path) {
    if (signal.aborted) early.controller.abort();
    else signal.addEventListener("abort", () => early.controller.abort(), { once: true });
    return api<T>(path, { signal, pendingResponse: early.response });
  }
  early?.controller.abort();
  return api<T>(path, { signal });
}
