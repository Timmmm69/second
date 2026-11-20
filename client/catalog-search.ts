// Keep client-side search deduplication aligned with server-side query normalization.
export const SEARCH_DEBOUNCE_MS = 700;

export function normalizeCatalogSearch(query: string | undefined): string {
  return (query ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

export function shouldApplyCatalogSearch(applied: string | undefined, next: string): boolean {
  return normalizeCatalogSearch(applied) !== normalizeCatalogSearch(next);
}

/** Rank locally available ways to broaden an empty catalog search.
 * Suggestions never issue speculative catalog or availability requests.
 */
export type EmptySearchFilters = {
  q?: string;
  sizeLabel?: string[];
  brand?: string[];
  material?: string[];
  color?: string[];
  season?: string[];
  minPrice?: string;
  maxPrice?: string;
  category?: string[];
  audience?: string[];
};

export type EmptySearchAction = {
  key: keyof EmptySearchFilters;
  label: string;
};

const relaxations: ReadonlyArray<EmptySearchAction> = [
  { key: "q", label: "Искать без текста" },
  { key: "sizeLabel", label: "Все размеры" },
  { key: "brand", label: "Все бренды" },
  { key: "material", label: "Любой материал" },
  { key: "color", label: "Все цвета" },
  { key: "season", label: "Любой сезон" },
  { key: "minPrice", label: "Без минимальной цены" },
  { key: "maxPrice", label: "Без максимальной цены" },
  { key: "category", label: "Все категории" },
  { key: "audience", label: "Любое назначение" },
];

export function emptySearchActions(filters: EmptySearchFilters): EmptySearchAction[] {
  return relaxations
    .filter(({ key }) => {
      const value = filters[key];
      return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim());
    })
    .slice(0, 2);
}
