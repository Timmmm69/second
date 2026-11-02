// Only public, synthetic data exported from the project's isolated seed.
// No server, authorization, Telegram token, orders or customer records.
(() => {
  const originalFetch = window.fetch.bind(window);
  const data = originalFetch('/preview-data.json').then(r => {
    if (!r.ok) throw new Error('Preview data unavailable');
    return r.json();
  });
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: {'Content-Type': 'application/json; charset=utf-8'},
  });
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/'))
      return originalFetch(input, options);
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const method = (options.method || input.method || 'GET').toUpperCase();
    if (method !== 'GET') return json({code: 'PREVIEW_ONLY', message:
      'В просмотре оформления отключены.'}, 403);
    const d = await data;
    const path = url.pathname.slice(4);
    if (path === '/auth/me') return json({user: null, dev: false});
    if (path === '/settings') return json(d.settings);
    if (path === '/categories') return json(d.categories);
    if (path === '/catalog') {
      const q = url.searchParams;
      let items = d.items.filter(i => {
        const a = i.attributes;
        if (q.get('q') && ![i.title, i.sku, a.brand].join(' ').toLowerCase().includes(q.get('q').trim().toLowerCase())) return false;
        if (q.get('category') && i.category !== q.get('category')) return false;
        for (const k of ['brand','color','material','season','audience','sizeSystem','sizeLabel'])
          if (q.get(k) && String(a[k] ?? '').toLowerCase() !== q.get(k).toLowerCase()) return false;
        for (const [k, value, min] of [
          ['minPrice', i.priceMinor, true], ['maxPrice', i.priceMinor, false],
          ['minHeight', a.height, true], ['maxHeight', a.height, false],
          ['minMeasure', i.measurements[q.get('measurement')], true],
          ['maxMeasure', i.measurements[q.get('measurement')], false],
        ]) if (q.get(k) && (value == null || (min ? value < +q.get(k) : value > +q.get(k)))) return false;
        return true;
      });
      if (q.get('sort')?.startsWith('price_')) items = items.toSorted((a,b) =>
        q.get('sort') === 'price_asc' ? a.priceMinor-b.priceMinor : b.priceMinor-a.priceMinor);
      return json({items, nextCursor: null});
    }
    if (path.startsWith('/items/')) {
      const item = d.items.find(i => i.id === path.split('/')[2]);
      return item ? json(item) : json({message:'Вещь не найдена'},404);
    }
    return json({code:'PREVIEW_ONLY',message:'Этот раздел доступен в полном приложении. Здесь можно посмотреть каталог, подборку и шаги оформления.'},403);
  };
})();
