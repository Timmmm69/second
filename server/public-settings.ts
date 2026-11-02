/** Customer-visible rules only: never expose carrier contracts or internal schemes. */
export function publicSettings(settings: Record<string, any>) {
  return {
    ...settings,
    carriers: Object.fromEntries(Object.entries(settings.carriers as Record<string, any>).map(([key, carrier]) => [key, {enabled:carrier.enabled, terms:carrier.terms}])),
  };
}
