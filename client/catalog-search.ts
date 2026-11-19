// Keep client-side search deduplication aligned with server-side query normalization.
export const SEARCH_DEBOUNCE_MS = 700;

export function normalizeCatalogSearch(query: string | undefined): string {
  return (query ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

export function shouldApplyCatalogSearch(applied: string | undefined, next: string): boolean {
  return normalizeCatalogSearch(applied) !== normalizeCatalogSearch(next);
}
