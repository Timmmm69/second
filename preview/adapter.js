// Browser-only demonstration. This file is injected only by build:preview.
// Every /api request is answered here; no request is forwarded to a real API.
// Only the explicitly selected public catalogue/settings are persisted. Customer
// input, drafts, operations, queues and event messages live in memory exclusively.
(() => {
  const originalFetch = window.fetch.bind(window);
  const STORAGE_KEY = 'luchok-demo-public-v5';
  const synthetic = { method: 'PICKUP', phone: '+375 00 000 00 00', fullName: 'Тестов Тест Тестович', city: 'Минск', office: 'Тестовый пункт №1', officeAddress: 'Тестовая улица, 1', postalCode: '', comment: '' };
  const identity = { id: '00000000-0000-4000-8000-000000000001', telegramId: '900000000001', displayName: 'Тестовый покупатель', username: null };
  const clone = value => JSON.parse(JSON.stringify(value));
  const productColor = value => {
    const color = typeof value === 'string' ? value.trim() : '';
    return !color.includes('#') && !/^(?:[\da-f]{6}|[\da-f]{8})$/i.test(color) && /\p{L}/u.test(color) ? color : '';
  };
  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const h = Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  };
  const now = () => new Date().toISOString();
  let role = 'BUYER';
  let initial, state, selection = [], orders = [], leases = new Map(), operations = new Map(), events = [], journal = [], profile = clone(synthetic), draft = clone(synthetic);
  let draftGeneration = uuid(), draftRevision = 0, profileEnabled = true, profileVersion = 0;
  const ready = originalFetch('/preview-data.json').then(async response => {
    if (!response.ok) throw new Error('Preview data unavailable');
    initial = await response.json();
    state = clone(initial);
    state.categories = state.categories.map((category, index) => ({ sortOrder: index * 10, version: 1, archived: false, ...category }));
    state.items = state.items.map(item => ({ physical: 'AVAILABLE', publication: 'PUBLISHED', storageLocation: 'Тестовый зал · рейл 1', ...item }));
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved?.schema === 5 && Array.isArray(saved.items) && Array.isArray(saved.categories) && saved.settings) {
        const items = saved.items.map(item => {
          const fixture = initial.items.find(sample => sample.id === item.id && sample.version === item.version);
          if (!fixture || !String(item.attributes.color).startsWith('#')) return item;
          return { ...item, attributes: { ...item.attributes, color: fixture.attributes.color } };
        });
        state = { items, categories: saved.categories, settings: saved.settings };
      }
    } catch { /* Storage is optional; a private browser may disallow it. */ }
  });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  const fail = (status, code, message, extra = {}) => { throw { status, code, message, ...extra }; };
  const ensure = (condition, status, code, message, extra) => { if (!condition) fail(status, code, message, extra); };
  const staff = () => ensure(role !== 'BUYER', 403, 'ROLE', 'Переключитесь в менеджера или владельца демонстрации.');
  const owner = () => ensure(role === 'OWNER', 403, 'ROLE', 'Переключитесь во владельца демонстрации.');
  const user = () => ({ ...identity, role });
  const persist = () => {
    // Strict allowlist. Never add draft/order/event/operation/profile data here.
    const publicSettings = clone(state.settings);
    publicSettings.phone = ''; publicSettings.telegramUsername = ''; publicSettings.seller = '';
    publicSettings.documents = { privacy: '', reservation: '', shipping: '', returns: '' };
    publicSettings.documentStatus = 'DRAFT'; publicSettings.phoneIsTest = true;
    const items = state.items.map(item => ({
      id: item.id, sku: item.sku, title: item.title, category: item.category,
      priceMinor: item.priceMinor, publication: item.publication,
      // A local order cannot leave a persistent stock lock after reload.
      physical: ['RESERVED', 'PICKED', 'PACKED'].includes(item.physical) ? 'AVAILABLE' : item.physical,
      version: item.version, attributes: item.attributes, measurements: item.measurements,
      media: item.media, hasDefect: item.hasDefect, defectDescription: item.defectDescription,
      storageLocation: item.storageLocation,
    }));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 5, items, categories: state.categories, settings: publicSettings })); }
    catch { fail(507, 'DEMO_STORAGE', 'Память браузера заполнена. Уменьшите фотографии или сбросьте демонстрацию. Изменение действует до перезагрузки.'); }
  };
  const settings = () => ({ ...clone(state.settings), phone: '', phoneIsTest: true, telegramUsername: '', seller: '', documentStatus: 'DRAFT', documents: { privacy: '', reservation: '', shipping: '', returns: '' } });
  const claimed = itemId => orders.some(order => order.lines.some(line => line.itemId === itemId && ['RESERVED', 'RELEASE_PENDING'].includes(line.outcome))) || [...leases.values()].some(lease => Date.parse(lease.expiresAt) > Date.now() && lease.items.some(item => item.id === itemId));
  const itemView = item => ({ ...clone(item), available: item.publication === 'PUBLISHED' && item.physical === 'AVAILABLE' && !claimed(item.id) });
  const findItem = id => { const item = state.items.find(item => item.id === id); ensure(item, 404, 'NOT_FOUND', 'Вещь не найдена'); return item; };
  const findOrder = id => { const order = orders.find(order => order.id === id); ensure(order, 404, 'NOT_FOUND', 'Обращение не найдено в этой демонстрационной сессии.'); return order; };
  const checkVersion = (record, body) => ensure(record.version === body.version, 409, 'VERSION', 'Данные изменились. Обновите карточку и повторите действие.');
  const orderView = order => {
    const result = clone(order);
    if (role === 'BUYER') { delete result.buyer; delete result.notes; delete result.handover; }
    else delete result.pickupCode;
    if (!['READY_FOR_PICKUP', 'HANDOVER'].includes(order.status)) delete result.pickupCode;
    return result;
  };
  const event = (order, message) => {
    events.unshift({ id: uuid(), type: order.status, message, createdAt: now(), orderId: order.id });
  };
  const record = (command, id) => journal.unshift({ id: uuid(), command, actorId: role, entityId: id, createdAt: now(), details: { demo: true } });
  const recipientFields = ['method', 'phone', 'fullName', 'city', 'office', 'officeAddress', 'postalCode', 'comment'];
  const cleanRecipient = body => Object.fromEntries(recipientFields.map(key => [key, String(body[key] ?? (key === 'method' ? 'PICKUP' : ''))]));
  const validateRecipient = body => {
    const fields = {};
    if (!/^\+?[\d\s()-]{9,22}$/.test(body.phone || '')) fields.phone = 'Проверьте номер телефона';
    if (!['PICKUP', 'EUROPOST', 'BELPOST'].includes(body.method)) fields.method = 'Выберите получение';
    if (body.method !== 'PICKUP') {
      if ((body.fullName || '').trim().split(/\s+/).length < 2) fields.fullName = 'Укажите фамилию и имя получателя';
      for (const [key, label] of [['city', 'населённый пункт'], ['office', 'пункт выдачи'], ['officeAddress', 'адрес пункта выдачи']])
        if (!String(body[key] || '').trim() && (key !== 'officeAddress' || body.method === 'EUROPOST')) fields[key] = `Укажите ${label}`;
      if (body.method === 'BELPOST' && !/^\d{6}$/.test(body.postalCode || '')) fields.postalCode = 'Укажите шестизначный индекс';
    }
    ensure(!Object.keys(fields).length, 422, 'VALIDATION', 'Проверьте заполненные поля', { fieldErrors: fields });
  };
  const dateParts = date => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const deadline = (offset = 1) => {
    const parts = dateParts(new Date());
    const day = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00+03:00`);
    day.setUTCDate(day.getUTCDate() + offset);
    for (let index = 0; index < 370; index++) {
      const p = dateParts(day), key = `${p.year}-${p.month}-${p.day}`;
      const hours = Object.hasOwn(state.settings.calendar.exceptions, key) ? state.settings.calendar.exceptions[key] : state.settings.calendar.week[String(day.getUTCDay())];
      if (hours) return new Date(`${key}T${hours[1]}:00+03:00`).toISOString();
      day.setUTCDate(day.getUTCDate() + 1);
    }
    return null;
  };
  const reset = () => {
    state = clone(initial);
    state.categories = state.categories.map((category, index) => ({ sortOrder: index * 10, version: 1, archived: false, ...category }));
    state.items = state.items.map(item => ({ physical: 'AVAILABLE', publication: 'PUBLISHED', storageLocation: 'Тестовый зал · рейл 1', ...item }));
    selection = []; orders = []; leases = new Map(); operations = new Map(); events = []; journal = [];
    profile = clone(synthetic); draft = clone(synthetic); draftGeneration = uuid(); draftRevision = 0; profileEnabled = true; profileVersion = 0; role = 'BUYER';
    try {
      localStorage.removeItem(STORAGE_KEY);
      // These are this application's public UI caches; contacts are never here.
      for (const key of ['selection', 'checkout-lease', 'checkout-operation', 'catalogFilters', 'catalogScroll']) localStorage.removeItem(key);
    } catch { /* Optional browser storage. */ }
  };
  const asDataURL = file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Не удалось прочитать фото')); reader.readAsDataURL(file);
  });
  const rotatePhoto = (media, rotation) => new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = rotation % 180 ? image.height : image.width; canvas.height = rotation % 180 ? image.width : image.height;
      const context = canvas.getContext('2d');
      context.translate(canvas.width / 2, canvas.height / 2); context.rotate(rotation * Math.PI / 180); context.drawImage(image, -image.width / 2, -image.height / 2);
      resolve({ url: canvas.toDataURL('image/webp', 0.86), width: canvas.width, height: canvas.height });
    }; image.onerror = reject; image.src = media.url;
  });
  const handle = async (path, method, body, query) => {
    if (path === '/demo/role' && method === 'POST') { ensure(['BUYER', 'STAFF', 'OWNER'].includes(body.role), 422, 'ROLE', 'Неизвестная демонстрационная роль'); role = body.role; return { user: user(), dev: false }; }
    if (path === '/demo/reset' && method === 'POST') { reset(); return { ok: true }; }
    if (path === '/auth/me' && method === 'GET') return { user: user(), dev: false };
    if (path.startsWith('/auth/')) fail(403, 'DEMO_BOUNDARY', 'В демонстрации нет входа Telegram и реальных служебных доступов. Используйте переключатель ролей.');
    if (path.startsWith('/owner/')) owner();
    if (path.startsWith('/staff/')) staff();
    if (path === '/settings' && method === 'GET') return settings();
    if (['/categories', '/staff/categories', '/owner/categories'].includes(path) && method === 'GET') return clone(state.categories.filter(category => path !== '/categories' || !category.archived).toSorted((a, b) => a.sortOrder - b.sortOrder));
    if (path === '/owner/settings' && method === 'GET') return settings();
    if (path === '/owner/settings' && method === 'PATCH') {
      checkVersion(state.settings, body);
      ensure(String(body.name || '').trim(), 422, 'VALIDATION', 'Укажите название магазина', { fieldErrors: { name: 'Укажите название' } });
      // A demo never approves documents, verifies contracts, or activates services.
      state.settings = { ...clone(body), version: state.settings.version + 1, documentStatus: 'DRAFT', phone: '', phoneIsTest: true, telegramUsername: '', seller: '', documents: { privacy: '', reservation: '', shipping: '', returns: '' } };
      state.settings.carriers.BELPOST.enabled = false;
      record('demo.settings', 'store'); persist(); return settings();
    }
    if (path.startsWith('/owner/categories') && ['POST', 'PATCH'].includes(method)) {
      const id = path.split('/')[3], existing = state.categories.find(category => category.id === id);
      if (method === 'PATCH') { ensure(existing, 404, 'NOT_FOUND', 'Категория не найдена'); checkVersion(existing, body); }
      ensure(String(body.name || '').trim(), 422, 'VALIDATION', 'Укажите название категории');
      ensure(!body.archived || !state.items.some(item => item.category === id), 409, 'CATEGORY_IN_USE', 'Сначала перенесите вещи в другую категорию');
      const category = { id: id || `demo-${uuid().slice(0, 8)}`, name: body.name.trim(), sortOrder: Number(body.sortOrder) || 0, measurements: clone(body.measurements ?? existing?.measurements ?? []), archived: !!body.archived, version: (existing?.version || 0) + 1 };
      if (existing) Object.assign(existing, category); else state.categories.push(category);
      record('demo.category', category.id); persist(); return category;
    }
    if (path === '/owner/audit' && method === 'GET') return { events: clone(journal) };
    if (path === '/owner/staff' && method === 'GET') return { staff: [] };
    if (path === '/owner/operations' && method === 'GET') fail(403, 'DEMO_BOUNDARY', 'В демонстрации нет сервера, диска магазина, worker и реальных уведомлений.');
    if (path.startsWith('/owner/')) fail(403, 'DEMO_BOUNDARY', 'Эта системная операция доступна только в рабочем приложении. В демонстрации нет сервера, договоров и сотрудников.');
    if (path === '/catalog' && method === 'GET') {
      let items = state.items.map(itemView).filter(item => item.available).filter(item => {
        const a = item.attributes;
        if (query.get('q') && ![item.title, item.sku, a.brand, productColor(a.color)].join(' ').toLowerCase().replace(/\s+/g, ' ').includes(query.get('q').trim().toLowerCase().replace(/\s+/g, ' '))) return false;
        if (query.get('category') && item.category !== query.get('category')) return false;
        for (const key of ['brand', 'material', 'season', 'audience'])
          if (query.get(key) && String(a[key] ?? '').toLowerCase() !== query.get(key).toLowerCase()) return false;
        const color = query.get('color')?.trim().toLowerCase();
        if (color && productColor(a.color).toLowerCase() !== color) return false;
        const size = query.get('sizeLabel')?.trim().toLowerCase();
        if (size && (a.sizeSystem !== 'RU' || String(a.sizeLabel ?? '').trim().toLowerCase() !== size)) return false;
        for (const [key, value, min] of [['minPrice', item.priceMinor, true], ['maxPrice', item.priceMinor, false]])
          if (query.get(key) && (value == null || (min ? value < +query.get(key) : value > +query.get(key)))) return false;
        return true;
      });
      if (query.get('sort')?.startsWith('price_')) items = items.toSorted((a, b) => query.get('sort') === 'price_asc' ? a.priceMinor - b.priceMinor : b.priceMinor - a.priceMinor);
      return { items, nextCursor: null, serverNow: now() };
    }
    if (/^\/items\/[^/]+$/.test(path) && method === 'GET') return itemView(findItem(path.split('/')[2]));
    if (path === '/me/selection') {
      if (method === 'PUT') selection = [...new Set(body.itemIds || [])].filter(id => state.items.some(item => item.id === id));
      if (['GET', 'PUT'].includes(method)) return { itemIds: clone(selection), items: selection.map(id => itemView(findItem(id))) };
    }
    if (path === '/me/checkout-draft') {
      if (method === 'GET') return { ...clone(draft || profile || { ...synthetic, phone: '', fullName: '', city: '', office: '', officeAddress: '' }), draftToken: draftGeneration, draftRevision, saveRecipient: profileEnabled, recipientVersion: profileVersion };
      if (method === 'PATCH') {
        ensure(body.draftToken === draftGeneration, 409, 'DRAFT_CLOSED', 'Оформление завершено. Откройте новую форму.');
        ensure(Number.isInteger(body.draftRevision) && body.draftRevision >= draftRevision, 409, 'DRAFT_STALE', 'Более свежие данные уже сохранены.');
        if (body.draftRevision > draftRevision) {
          draft = cleanRecipient(body); draftRevision = body.draftRevision;
          if (typeof body.saveRecipient === 'boolean') profileEnabled = body.saveRecipient;
        }
        return { ok: true, draftToken: draftGeneration, draftRevision };
      }
    }
    if (path === '/me/recipient-profile') {
      if (method === 'GET') return { recipient: clone(profile), enabled: profileEnabled, version: profileVersion };
      if (method === 'DELETE') {
        ensure(body.version === profileVersion, 409, 'VERSION', 'Данные получателя изменились. Обновите форму.');
        profile = null; profileEnabled = false; profileVersion++; draft = null; draftGeneration = uuid(); draftRevision = 0;
        return { ok: true, version: profileVersion, draftToken: draftGeneration, draftRevision: 0 };
      }
      if (method === 'PATCH') {
        ensure(body.version === profileVersion, 409, 'VERSION', 'Данные получателя изменились. Обновите форму.');
        profileEnabled = !!body.enabled; profile = profileEnabled ? { ...cleanRecipient(body.recipient || {}), comment: '' } : null; profileVersion++;
        return { recipient: clone(profile), enabled: profileEnabled, version: profileVersion };
      }
    }
    if (path === '/me/contact' && method === 'GET') return { phone: synthetic.phone };
    if (path === '/me/events' && method === 'GET') return { events: clone(events) };
    if (/^\/me\/events\/[^/]+\/read$/.test(path) && method === 'POST') { const item = events.find(item => item.id === path.split('/')[3]); if (item) item.readAt = now(); return { ok: true }; }
    if (path === '/me/contact-preference' || path === '/me/deletion-request') fail(403, 'DEMO_BOUNDARY', 'В демонстрации нет реального бота и персонального аккаунта. Сброс удаляет локальные тестовые данные.');
    if (path === '/checkout/leases' && method === 'POST') {
      const ids = [...new Set(body.itemIds || [])];
      ensure(ids.length > 0, 422, 'SELECTION', 'Выберите хотя бы одну вещь');
      const conflicts = ids.filter(id => !itemView(findItem(id)).available).map(itemId => ({ itemId, reason: 'Вещь уже занята или снята с витрины' }));
      ensure(!conflicts.length, 409, 'ITEM_CONFLICT', 'Часть вещей недоступна', { conflicts });
      const lease = { id: uuid(), expiresAt: new Date(Date.now() + 600000).toISOString(), items: ids.map(id => itemView(findItem(id))), rules: settings() };
      leases.set(lease.id, lease); return lease;
    }
    if (/^\/checkout\/leases\/[^/]+$/.test(path) && method === 'DELETE') { leases.delete(path.split('/')[3]); return { ok: true }; }
    if (path === '/orders' && method === 'POST') {
      const lease = leases.get(body.leaseId);
      ensure(lease && Date.parse(lease.expiresAt) > Date.now(), 410, 'LEASE_EXPIRED', 'Время проверки истекло. Перепроверьте наличие.');
      ensure(body.settingsVersion === state.settings.version, 409, 'RULES_CHANGED', 'Условия изменились. Проверьте их ещё раз.');
      ensure(body.termsAccepted, 422, 'TERMS', 'Подтвердите условия');
      ensure(state.settings.acceptingOrders, 409, 'STORE_CLOSED', 'Тестовый приём обращений выключен в настройках демонстрации.');
      ensure(body.method === 'PICKUP' || (body.method === 'EUROPOST' && state.settings.carriers.EUROPOST.enabled), 422, 'METHOD', 'Способ получения недоступен');
      validateRecipient(body);
      ensure(body.draftToken === draftGeneration, 409, 'DRAFT_CLOSED', 'Оформление завершено. Откройте новую форму.');
      ensure(body.recipientVersion === profileVersion, 409, 'VERSION', 'Данные получателя изменились. Обновите форму.');
      const recipient = cleanRecipient(body);
      if (recipient.method === 'PICKUP') for (const key of ['fullName', 'city', 'office', 'officeAddress', 'postalCode']) recipient[key] = '';
      const order = { id: uuid(), number: String(1001 + orders.length), version: 1, method: body.method, status: 'CHECKING', reservationStatus: 'RESERVED', totalMinor: lease.items.reduce((sum, item) => sum + item.priceMinor, 0), createdAt: now(), verifyBy: deadline(0) || deadline(), recipient, ruleSnapshot: clone(lease.rules), pickupCode: String(Math.floor(100000 + Math.random() * 900000)), buyer: { ...clone(identity), atCheckout: clone(identity) }, notes: [], lines: lease.items.map(item => ({ ...clone(item), id: uuid(), itemId: item.id, outcome: 'RESERVED', checked: false })) };
      orders.unshift(order); leases.delete(lease.id);
      selection = selection.filter(id => !lease.items.some(item => item.id === id));
      profileEnabled = !!body.saveRecipient;
      profile = profileEnabled ? { ...cleanRecipient(draft || body), comment: '' } : null; profileVersion++;
      draft = null; draftGeneration = uuid(); draftRevision = 0;
      event(order, `Обращение №${order.number}: проверяем наличие`); record('demo.order.created', order.id); return orderView(order);
    }
    if (path === '/me/orders' && method === 'GET') return { orders: orders.map(orderView) };
    if (/^\/orders\/[^/]+$/.test(path) && method === 'GET') return orderView(findOrder(path.split('/')[2]));
    if (/^\/orders\/[^/]+\/recipient$/.test(path) && method === 'PATCH') {
      const order = findOrder(path.split('/')[2]); checkVersion(order, body); validateRecipient({ ...body, method: order.method });
      ensure(order.status === 'CHECKING', 409, 'ORDER_STATE', 'Изменения после проверки согласуются с менеджером.');
      order.recipient = cleanRecipient({ ...body, method: order.method }); order.version++; return orderView(order);
    }
    if (/^\/orders\/[^/]+\/cancel$/.test(path) && method === 'POST') {
      const order = findOrder(path.split('/')[2]); checkVersion(order, body);
      ensure(['CHECKING', 'READY_FOR_PICKUP'].includes(order.status), 409, 'ORDER_STATE', 'В этом статусе отмену нужно согласовать с менеджером.');
      for (const line of order.lines.filter(line => body.lineIds.includes(line.id))) line.outcome = 'RELEASED';
      order.totalMinor = order.lines.filter(line => line.outcome === 'RESERVED').reduce((sum, line) => sum + line.priceMinor, 0);
      if (!order.lines.some(line => line.outcome === 'RESERVED')) { order.status = 'CANCELLED'; order.reservationStatus = 'CANCELLED'; }
      order.version++; event(order, `Обращение №${order.number}: состав обновлён`); return orderView(order);
    }
    if (path === '/staff/queue' && method === 'GET') {
      const filter = query.get('filter');
      const statuses = { checking: ['CHECKING', 'AWAITING_CUSTOMER'], pickup: ['READY_FOR_PICKUP', 'HANDOVER'], shipping: ['PREPARING', 'DISPATCH_READY', 'IN_FULFILLMENT'], deadlines: ['CHECKING', 'READY_FOR_PICKUP', 'PREPARING', 'DISPATCH_READY'] };
      return { orders: orders.filter(order => (statuses[filter] || []).includes(order.status)).map(orderView), issues: [] };
    }
    if (/^\/staff\/orders\/[^/]+\/(assign|verify|ready|note|handovers)$/.test(path) && method === 'POST') {
      const order = findOrder(path.split('/')[3]), action = path.split('/')[4]; checkVersion(order, body);
      if (action === 'assign') order.assignedTo = 'Демонстрационный менеджер';
      if (action === 'verify') {
        ensure(order.status === 'CHECKING', 409, 'ORDER_STATE', 'Проверка уже завершена');
        for (const line of order.lines) line.checked = body.foundItemIds.includes(line.itemId);
      }
      if (action === 'ready') {
        ensure(order.status === 'CHECKING' && order.lines.filter(line => line.outcome === 'RESERVED').every(line => line.checked), 409, 'NOT_CHECKED', 'Сначала сохраните проверку каждой вещи');
        order.readyAt = now(); order.status = order.method === 'PICKUP' ? 'READY_FOR_PICKUP' : 'PREPARING';
        if (order.method === 'PICKUP') order.pickupDeadline = deadline(); else order.dispatchDeadline = deadline();
        event(order, `Обращение №${order.number}: ${order.method === 'PICKUP' ? 'можно забирать' : 'готовим к отправке'}`);
      }
      if (action === 'note') { order.notes.push({ note: String(body.note || ''), createdAt: now() }); }
      if (action === 'handovers') {
        ensure(order.status === 'READY_FOR_PICKUP', 409, 'ORDER_STATE', 'Выдача сейчас недоступна');
        ensure(body.code === order.pickupCode, 422, 'PICKUP_CODE', 'Код выдачи не совпадает');
        order.handover = { id: uuid(), orderId: order.id }; order.status = 'HANDOVER'; order.version++; return clone(order.handover);
      }
      order.version++; record(`demo.order.${action}`, order.id); return orderView(order);
    }
    if (/^\/staff\/handovers\/[^/]+\/complete$/.test(path) && method === 'POST') {
      const order = orders.find(order => order.handover?.id === path.split('/')[3]);
      ensure(order && order.status === 'HANDOVER', 409, 'HANDOVER', 'Выдача не найдена или уже завершена');
      for (const line of order.lines.filter(line => line.outcome === 'RESERVED')) {
        line.outcome = body.acceptedLineIds.includes(line.id) ? 'HANDED_OVER' : 'RELEASED';
        const item = findItem(line.itemId); item.physical = line.outcome === 'HANDED_OVER' ? 'SOLD' : 'INSPECTION';
      }
      order.status = 'FULFILLED'; order.reservationStatus = 'FULFILLED'; order.version++;
      event(order, `Обращение №${order.number}: выдача завершена`); return orderView(order);
    }
    if (path === '/staff/shipments' && method === 'POST') {
      const order = findOrder(body.orderId); checkVersion(order, body);
      ensure(order.method !== 'PICKUP' && order.status === 'PREPARING', 409, 'ORDER_STATE', 'Сначала подтвердите проверку заявки');
      ensure(String(body.tracking || '').trim() && String(body.source || '').trim(), 422, 'SHIPMENT', 'Укажите трек и источник');
      order.shipment = { id: uuid(), tracking: body.tracking.trim(), source: body.source.trim(), status: 'REGISTERED', updatedAt: now() };
      order.status = 'DISPATCH_READY'; order.version++; event(order, `Обращение №${order.number}: трек оформлен, посылка ещё не сдана`); return orderView(order);
    }
    if (/^\/staff\/shipments\/[^/]+\/(acceptance|events|cancel)$/.test(path) && method === 'POST') {
      const order = orders.find(order => order.shipment?.id === path.split('/')[3]), action = path.split('/')[4];
      ensure(order, 404, 'SHIPMENT', 'Посылка не найдена'); checkVersion(order, body);
      ensure(String(body.source || '').trim(), 422, 'SOURCE', 'Укажите подтверждённый источник');
      if (action === 'acceptance') { ensure(order.shipment.status === 'REGISTERED', 409, 'SHIPMENT_STATE', 'Посылка уже принята'); order.shipment.status = 'ACCEPTED'; order.status = 'IN_FULFILLMENT'; }
      if (action === 'events') {
        ensure(order.shipment.status !== 'REGISTERED', 409, 'SHIPMENT_STATE', 'Сначала подтвердите фактическую сдачу');
        ensure(['IN_TRANSIT', 'AT_OFFICE', 'DELIVERED', 'RETURN_IN_TRANSIT', 'RETURN_RECEIVED', 'LOST_OR_DAMAGED'].includes(body.status), 422, 'SHIPMENT_STATE', 'Неизвестный статус');
        order.shipment.status = body.status;
        if (body.status === 'DELIVERED') { order.status = 'FULFILLED'; order.reservationStatus = 'FULFILLED'; for (const line of order.lines) { line.outcome = 'SOLD'; findItem(line.itemId).physical = 'SOLD'; } }
      }
      if (action === 'cancel') { ensure(order.shipment.status === 'REGISTERED', 409, 'SHIPMENT_STATE', 'Посылка уже сдана'); order.shipment.status = 'CANCELLED'; order.status = 'CANCELLED'; for (const line of order.lines) line.outcome = 'RELEASED'; }
      order.shipment.source = body.source; order.shipment.updatedAt = now(); order.version++;
      event(order, `Обращение №${order.number}: статус посылки обновлён`); record(`demo.shipment.${action}`, order.id); return orderView(order);
    }
    if (path === '/staff/items' && method === 'GET') {
      const q = (query.get('q') || '').trim().toLowerCase(), filter = query.get('state');
      return { items: state.items.filter(item => (!q || `${item.title} ${item.sku}`.toLowerCase().includes(q)) && (!filter || item.physical === filter || item.publication === filter)).map(itemView) };
    }
    if (/^\/staff\/items\/[^/]+$/.test(path) && method === 'GET') return itemView(findItem(path.split('/')[3]));
    if (path === '/staff/items/bulk-hide' && method === 'POST') {
      ensure(body.confirmed, 422, 'CONFIRM', 'Подтвердите изменение');
      const items = body.items.map(value => { const item = findItem(value.id); checkVersion(item, value); ensure(!claimed(item.id), 409, 'CLAIMED', 'Вещь закреплена обращением'); return item; });
      for (const item of items) { item.publication = 'HIDDEN'; item.version++; }
      persist(); return { items: items.map(itemView) };
    }
    if ((path === '/staff/items' && method === 'POST') || (/^\/staff\/items\/[^/]+$/.test(path) && method === 'PATCH')) {
      const existing = method === 'PATCH' ? findItem(path.split('/')[3]) : null;
      if (existing) { checkVersion(existing, body); ensure(!claimed(existing.id), 409, 'CLAIMED', 'Вещь закреплена. Сначала обработайте обращение.'); }
      ensure(String(body.title || '').trim() && Number.isInteger(body.priceMinor) && body.priceMinor >= 0, 422, 'VALIDATION', 'Проверьте название и цену');
      ensure(state.categories.some(category => category.id === body.category && !category.archived), 422, 'CATEGORY', 'Выберите действующую категорию');
      ensure(!body.hasDefect || String(body.defectDescription || '').trim(), 422, 'VALIDATION', 'Опишите дефект', { fieldErrors: { defectDescription: 'Опишите конкретный дефект' } });
      const item = { ...(existing || { id: uuid(), sku: `DEMO-${state.items.length + 1}`, media: [], publication: 'DRAFT', physical: 'AVAILABLE' }), ...clone(body), version: (existing?.version || 0) + 1 };
      item.measurements = body.measurements ?? existing?.measurements ?? {};
      item.attributes ??= {};
      const color = item.attributes.color, namedColor = productColor(color), previousColor = existing?.attributes.color;
      if (!namedColor && previousColor && !productColor(previousColor) && (color === previousColor || color === undefined || (typeof color === 'string' && !color.trim()))) {
        item.attributes.color = previousColor;
      } else if (color !== undefined) {
        ensure(namedColor || (typeof color === 'string' && !color.trim()), 422, 'COLOR', 'Укажите название цвета словами');
        item.attributes.color = namedColor;
      }
      if (!body.sku) item.sku = existing?.sku || `DEMO-${state.items.length + 1}`;
      if (!item.hasDefect) item.defectDescription = '';
      if (existing) Object.assign(existing, item); else state.items.unshift(item);
      record('demo.item.edit', item.id); persist(); return itemView(item);
    }
    if (/^\/staff\/items\/[^/]+\/(publish|hide|inspect|write-off)$/.test(path) && method === 'POST') {
      const item = findItem(path.split('/')[3]), action = path.split('/')[4]; checkVersion(item, body); ensure(!claimed(item.id), 409, 'CLAIMED', 'Вещь закреплена обращением');
      if (action === 'publish') {
        ensure(body.checked && item.media.length && item.title && item.priceMinor && item.storageLocation, 422, 'PUBLISH', 'Заполните данные, фото и подтвердите проверку вещи');
        ensure(['bags', 'accessories'].includes(item.category) || String(item.attributes.sizeLabel ?? '').trim(), 422, 'PUBLISH', 'Укажите размер');
        item.publication = 'PUBLISHED';
      }
      if (action === 'hide') item.publication = 'HIDDEN';
      if (action === 'inspect') { ensure(item.physical === 'INSPECTION' && body.suitable, 409, 'INSPECTION', 'Сначала подтвердите осмотр'); item.physical = 'AVAILABLE'; }
      if (action === 'write-off') { owner(); item.physical = 'WRITTEN_OFF'; item.publication = 'ARCHIVED'; }
      item.version++; record(`demo.item.${action}`, item.id); persist(); return itemView(item);
    }
    if (path === '/staff/media/uploads' && method === 'POST') {
      const item = findItem(body.get('itemId')); ensure(!claimed(item.id), 409, 'CLAIMED', 'Нельзя менять фото закреплённой вещи');
      ensure(item.media.length < 12, 422, 'PHOTO_COUNT', 'Допускается до 12 фото вещи');
      const file = body.get('file'); ensure(file && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type), 422, 'MEDIA', 'Выберите JPEG, PNG или WebP');
      ensure(file.size <= 4 * 1024 * 1024, 413, 'FILE_SIZE', 'Для демонстрации выберите фото до 4 МБ');
      const url = await asDataURL(file), media = { id: uuid(), url, variants: { '480': url, '240': url }, role: 'FRONT', position: item.media.length };
      ensure(!claimed(item.id), 409, 'CLAIMED', 'Вещь закрепили во время обработки фото');
      item.media.push(media); record('demo.media.upload', item.id); persist(); return media;
    }
    if (/^\/staff\/media\/[^/]+$/.test(path) && ['PATCH', 'DELETE'].includes(method)) {
      const mediaId = path.split('/')[3], item = state.items.find(item => item.media.some(media => media.id === mediaId));
      ensure(item, 404, 'MEDIA', 'Фото не найдено'); ensure(!claimed(item.id), 409, 'CLAIMED', 'Нельзя менять фото закреплённой вещи');
      const media = item.media.find(media => media.id === mediaId);
      if (method === 'DELETE') item.media = item.media.filter(media => media.id !== mediaId);
      else {
        if (body.role) media.role = body.role;
        if (body.rotation) { const rotated = await rotatePhoto(media, body.rotation); Object.assign(media, rotated); media.variants = { '480': media.url, '240': media.url }; }
        if (body.position !== undefined) { item.media = item.media.filter(media => media.id !== mediaId); item.media.splice(body.position, 0, media); }
      }
      item.media.forEach((media, index) => { media.position = index; }); persist(); return method === 'DELETE' ? { ok: true } : media;
    }
    if (path === '/staff/returns' && method === 'GET') return { returns: [] };
    if (path === '/staff/search' && method === 'GET') return { orders: orders.filter(order => !query.get('q') || order.number.includes(query.get('q'))).map(orderView), items: state.items.filter(item => !query.get('q') || `${item.sku} ${item.title}`.toLowerCase().includes(query.get('q').toLowerCase())).map(itemView) };
    fail(403, 'DEMO_BOUNDARY', 'Эта операция пока не моделируется в демонстрации. Реальные API, бот, оплата и почтовый кабинет не подключены.');
  };
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return originalFetch(input, options);
    // Even cross-origin /api requests are denied locally instead of leaking input.
    if (url.origin !== location.origin) return json({ code: 'DEMO_BOUNDARY', message: 'Внешний API в демонстрации отключён' }, 403);
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      await ready;
      const method = (options.method || input.method || 'GET').toUpperCase();
      let body = options.body;
      if (body === undefined && typeof input !== 'string' && !(input instanceof URL) && method !== 'GET') body = await input.clone().text();
      if (typeof body === 'string') { try { body = body ? JSON.parse(body) : {}; } catch { fail(422, 'VALIDATION', 'Проверьте данные запроса'); } }
      body ??= {};
      const headers = new Headers(options.headers || (typeof input === 'object' && input.headers) || {});
      const key = headers.get('Idempotency-Key');
      const path = url.pathname.slice(4), fingerprint = `${method}:${path}:${JSON.stringify(body)}`;
      if (key && operations.has(key)) {
        const previous = operations.get(key);
        ensure(previous.fingerprint === fingerprint, 409, 'IDEMPOTENCY_REUSE', 'Ключ действия уже использован для другого запроса');
        return json(previous.result);
      }
      if (path.startsWith('/operations/') && method === 'GET') {
        const operation = operations.get(path.split('/')[2]); ensure(operation, 404, 'OPERATION_NOT_FOUND', 'Результат не найден. Можно повторить исходное действие.'); return json({ result: operation.result });
      }
      const result = await handle(path, method, body, url.searchParams);
      if (key && !['GET', 'HEAD'].includes(method) && !path.startsWith('/demo/')) operations.set(key, { fingerprint, result: clone(result) });
      return json(result);
    } catch (error) {
      return json({ code: error.code || 'DEMO_ERROR', message: error.message || 'Не удалось выполнить тестовое действие', fieldErrors: error.fieldErrors || {}, conflicts: error.conflicts || [] }, error.status || 500);
    }
  };
})();
