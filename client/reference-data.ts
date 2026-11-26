const maxAge = 120_000;

export function createReferenceCache<T>(fetchData: (path: string) => Promise<T>) {
  const entries = new Map<string, { request: Promise<T>; expires: number }>();

  const load = (path: string, key = path) => {
    const cached = entries.get(key);
    if (cached && cached.expires > Date.now()) return cached.request;
    const entry = {
      expires: Infinity,
      request: fetchData(path).then((data) => {
        entry.expires = Date.now() + maxAge;
        return data;
      }).catch((error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      }),
    };
    entries.set(key, entry);
    return entry.request;
  };
  return { load, invalidate: (key: string) => entries.delete(key), isCurrent: (key: string, request: Promise<T>) => entries.get(key)?.request === request };
}
