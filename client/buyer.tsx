import { catalogAudiences, productColor, productSize } from "../shared/catalog-attributes.js";
import { lazy, useCallback, useEffect, useId, useRef, useState, useMemo, useSyncExternalStore, type FormEvent } from "react";
import { SEARCH_DEBOUNCE_MS, shouldApplyCatalogSearch } from "./catalog-search";
import { requestCatalog } from "./catalog-request";
import { CatalogFilterAccordion, CatalogFilterSelect } from "./catalog-filters";
import { useHorizontalSwipe } from "./use-horizontal-swipe";
import {
  api,
  ApiError,
  command,
  operationKey,
  readLocal,
  saveLocal,
} from "./api";
import { useApp } from "./context";
import { activeLine } from "./buyer-order-data";
import { Defect, MapLink } from "./buyer-widgets";
import {
  Button,
  Empty,
  ErrorBox,
  Field,
  Icon,
  ItemMeasurements,
  Loading,
  Photo,
  preloadPhoto,
  Sheet,
  Summary,
  Textarea,
  useLoad,
} from "./ui";
import {
  date,
  itemCount,
  methodNames,
  money,
  statusNames,
  type Draft,
  type Item,
  type Method,
  type Order,
} from "./types";
import { checkoutMethods, recipientErrors, shippingCostNotice } from "../shared/checkout.js";
import { getDraftSession } from "./checkout-draft";
import { storeHours } from "../shared/store-hours";
import { openTelegramDraft, shareTelegramItem, tapFeedback, tg } from "./telegram";

const catalogPageSize = "16";
const catalogFreshFor = 30_000;
const detailFreshFor = 15_000;
const catalogPhotoWidth = 480;
const emptyCatalog: Item[] = [];
type CatalogPage = {
  filterKey: string;
  items: Item[];
  cursor: string;
  next: string | null;
  receivedAt: number;
};
let catalogCache: CatalogPage | null = null;
const itemDetails = new Map<string, { item: Item; receivedAt: number }>();
function invalidateCatalog() {
  catalogCache = null;
  itemDetails.clear();
}
const About = lazy(() => import("./buyer-about"));
const Support = lazy(() => import("./buyer-support"));
const Invite = lazy(() => import("./buyer-invite"));
const Events = lazy(() => import("./buyer-events"));
const OrderPage = lazy(() => import("./buyer-order"));

export default function Buyer() {
  const { path } = useApp();
  if (path.startsWith("/items/")) return <ItemPage key={path} id={path.split("/")[2]} />;
  if (path === "/selection") return <Selection />;
  if (path === "/checkout" || path.startsWith("/checkout/")) return <Checkout key={path} />;
  if (path.startsWith("/orders/")) return <OrderPage key={path} id={path.split("/")[2]} onInventoryChange={invalidateCatalog} />;
  if (path === "/orders") return <Orders />;
  if (path === "/about") return <About />;
  if (path === "/support") return <Support />;
  if (path === "/events") return <Events />;
  if (path === "/invite") return <Invite />;
  return <Catalog />;
}
const catalogOptionFields = [
  ["sizeLabel", "Размер", "Найти или добавить размер"],
  ["brand", "Бренд", "Найти или добавить бренд"],
  ["color", "Цвет"],
  ["material", "Материал"],
  ["season", "Сезон"],
] as const;
type CatalogOptionKey = typeof catalogOptionFields[number][0];
type CatalogOptions = Record<CatalogOptionKey, string[]>;
type CatalogFilters = Partial<CatalogOptions & { sort: string; q: string; category: string[]; audience: string[]; minPrice: string; maxPrice: string }>;

function readCatalogFilters(): CatalogFilters {
  const saved = readLocal<Record<string, string | string[]>>("catalogFilters", { sort: "new" });
  const filters: CatalogFilters = {};
  for (const key of ["sort", "q", "minPrice", "maxPrice"] as const) {
    const value = saved[key];
    if (typeof value === "string") filters[key] = value;
  }
  // Preserve filters saved as a single value by previous releases.
  for (const key of ["category", "audience"] as const) {
    const raw = saved[key];
    const values = (Array.isArray(raw) ? raw : [raw])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()).filter(Boolean);
    if (values.length) filters[key] = [...new Set(values)];
  }
  for (const [key] of catalogOptionFields) {
    const raw = saved[key];
    if (key === "sizeLabel" && typeof saved.sizeSystem === "string" &&
      saved.sizeSystem && !["RU", "INT"].includes(saved.sizeSystem)) continue;
    const values = (Array.isArray(raw) ? raw : [raw]).filter((value) => typeof value === "string")
      .map((value) => key === "color" ? productColor(value) : value.trim()).filter(Boolean);
    if (values.length) filters[key] = values;
  }
  return filters;
}

function catalogPath(filters: CatalogFilters, cursor = "") {
  const query = new URLSearchParams({ limit: catalogPageSize });
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) {
      for (const choice of value) query.append(key, choice);
    } else if (value) {
      query.set(key, key === "minPrice" || key === "maxPrice"
        ? String(Math.round(Number(value.replace(",", ".")) * 100))
        : value.trim());
    }
  }
  if (cursor) query.set("cursor", cursor);
  return `/catalog?${query}`;
}

function Catalog() {
  const { authLoading, categories, go, selectionIds, setSelection, toast, settings } = useApp();
  const [filters, setFilters] = useState(readCatalogFilters),
    [q, setQ] = useState(filters.q || ""),
    [filterOpen, setFilterOpen] = useState(false),
    [draft, setDraft] = useState(filters),
    [page, setPage] = useState(() =>
      catalogCache?.filterKey === JSON.stringify(filters) ? catalogCache : null,
    ),
    [cursor, setCursor] = useState(() => page?.cursor ?? ""),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(true);
  const filterKey = JSON.stringify(filters);
  const currentPage = page?.filterKey === filterKey ? page : null;
  const items = currentPage?.items ?? emptyCatalog;
  const more = currentPage?.next;
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const gridRef = useRef<HTMLDivElement>(null);
  const [nearbyPhotos, setNearbyPhotos] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!gridRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      const nearby = entries.filter((entry) => entry.isIntersecting).map((entry) => {
        observer.unobserve(entry.target);
        return (entry.target as HTMLElement).dataset.itemId!;
      });
      if (nearby.length) setNearbyPhotos((previous) => new Set([...previous, ...nearby]));
    }, { rootMargin: "100px 0px" });
    gridRef.current.querySelectorAll("[data-item-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [items]);
  const catalogOptions = useLoad<CatalogOptions>(filterOpen ? "/catalog/options" : null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const applySearch = useCallback((value: string) => {
    if (!shouldApplyCatalogSearch(filters.q, value)) return;
    setCursor("");
    setFilters((previous) => shouldApplyCatalogSearch(previous.q, value)
      ? { ...previous, q: value } : previous);
  }, [filters.q]);
  const previousSearchInput = useRef(q);
  useEffect(() => {
    // A filter reset changes filters.q but must not restore stale input text.
    if (previousSearchInput.current === q) return;
    previousSearchInput.current = q;
    const timer = window.setTimeout(() => applySearch(q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [q, applySearch]);
  useEffect(() => {
    saveLocal("catalogFilters", filters);
    saveLocal("catalogStartup", { filters: filterKey, path: catalogPath(filters) });
  }, [filters, filterKey]);
  const scrollRestored = useRef(false);
  const lastCatalogRefresh = useRef(Date.now());
  useEffect(() => {
    if (page) catalogCache = page;
  }, [page]);
  useEffect(() => {
    if (!items.length || scrollRestored.current) return;
    const frame = requestAnimationFrame(() => {
      scrollRestored.current = true;
      window.scrollTo({
        top: readLocal<number>("catalogScroll", 0),
        behavior: "instant",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [items.length]);
  useEffect(() => {
    let frame: number | null = null;
    const save = () => {
      if (
        !scrollRestored.current ||
        (location.hash.slice(1) || "/catalog") !== "/catalog"
      )
        return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        saveLocal("catalogScroll", window.scrollY),
      );
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      window.removeEventListener("scroll", save);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  const requestPath = catalogPath(filters, cursor);
  const handledRefresh = useRef(0);
  useEffect(() => {
    setError(null);
    const cached = currentPageRef.current;
    const forced = refresh !== handledRefresh.current;
    if (!forced && cached?.cursor === cursor && Date.now() - cached.receivedAt < catalogFreshFor) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => requestCatalog<{ items: Item[]; nextCursor: string | null }>(
      requestPath,
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        handledRefresh.current = refresh;
        setPage((previous) => ({
          filterKey,
          cursor,
          next: data.nextCursor,
          receivedAt: Date.now(),
          items: cursor && previous?.filterKey === filterKey
            ? [...previous.items.filter((item) => !data.items.some((next) => next.id === item.id)), ...data.items]
            : data.items,
        }));
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      }), 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [requestPath, refresh, cursor, filterKey]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCatalogRefresh.current < 120_000) return;
      lastCatalogRefresh.current = Date.now();
      setRefresh((v) => v + 1);
      const ids = Array.from(document.querySelectorAll<HTMLElement>("article[data-item-id]"))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.bottom >= 0 && rect.top <= window.innerHeight;
        })
        .map((el) => el.dataset.itemId)
        .filter((id): id is string => Boolean(id));
      if (!ids.length) return;
      api<{ availableIds: string[] }>("/catalog/availability", {
        method: "POST",
        body: { itemIds: ids },
      }).then(({ availableIds }) => {
        const checked = new Set(ids), available = new Set(availableIds);
        setPage((previous) => previous && ({
          ...previous,
          items: previous.items.filter((item) => !checked.has(item.id) || available.has(item.id)),
        }));
      }).catch(() => {});
    };
    const timer = setInterval(update, 120_000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, []);
  const toggle = (key: "audience" | "category", value: string) => {
    tapFeedback("selection");
    setCursor("");
    setFilters((v) => {
      const selected = v[key] ?? [];
      return {
        ...v,
        [key]: selected.includes(value)
          ? selected.filter((entry) => entry !== value)
          : [...selected, value],
      };
    });
  };
  const clear = (key: "audience" | "category") => {
    tapFeedback("selection");
    setCursor("");
    setFilters((v) => ({ ...v, [key]: undefined }));
  };
  const validRange =
    !draft.minPrice || !draft.maxPrice ||
    Number(draft.minPrice) <= Number(draft.maxPrice);
  const searchId = useId();
  const appliedCount = Object.entries(filters).filter(
    ([key, value]) => !["q", "sort"].includes(key) && (Array.isArray(value) ? value.length : value),
  ).length;
  // Relax the most restrictive active constraint first, without a separate recommendations request.
  const relaxKey = (["q", "sizeLabel", "category", "audience", "brand", "color", "material", "season", "minPrice", "maxPrice"] as const)
    .find((key) => {
      const value = filters[key];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    });
  const relaxFilter = () => {
    if (!relaxKey) return;
    setCursor("");
    if (relaxKey === "q") setQ("");
    setFilters((previous) => ({ ...previous, [relaxKey]: undefined }));
    tapFeedback("selection");
  };
  return (
    <div className="page catalog-page">
      <p className="catalog-kicker">Секонд-хенд · Минск</p>
      <form className="search-row" role="search" onSubmit={(event) => {
        event.preventDefault();
        const button = searchButtonRef.current;
        if (button && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          button.getAnimations().forEach((animation) => animation.cancel());
          button.animate([
            { transform: "scale(1)" },
            { transform: "scale(0.9)", offset: 0.45 },
            { transform: "scale(1)" },
          ], { duration: 180, easing: "ease-out" });
        }
        applySearch(q);
      }}>
        <div className="search-pill">
          <Icon name="search" />
          <div>
            <label htmlFor={searchId}>Что ищем?</label>
            <input
              id={searchId}
              type="search"
              placeholder="Название, бренд, цвет, артикул"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {q && (
            <button
              type="button"
              className="icon-button search-clear"
              aria-label="Очистить поиск"
              onClick={() => setQ("")}
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        <button
          ref={searchButtonRef}
          type="submit"
          className="search-cta"
          aria-label="Найти вещи"
        >
          <Icon name="search" />
        </button>
      </form>
      <div className="chips" role="group" aria-label="Назначение">
        <button className={!filters.audience?.length ? "selected" : ""}
          aria-pressed={!filters.audience?.length} onClick={() => clear("audience")}>Все</button>
        {catalogAudiences.map((audience) => (
          <button key={audience} className={filters.audience?.includes(audience) ? "selected" : ""}
            aria-pressed={Boolean(filters.audience?.includes(audience))}
            onClick={() => toggle("audience", audience)}>{audience}</button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Категории">
        <button className={!filters.category?.length ? "selected" : ""}
          aria-pressed={!filters.category?.length} onClick={() => clear("category")}>Всё</button>
        {categories.map((c) => (
          <button key={c.id} className={filters.category?.includes(c.id) ? "selected" : ""}
            aria-pressed={Boolean(filters.category?.includes(c.id))}
            onClick={() => toggle("category", c.id)}>{c.name}</button>
        ))}
      </div>
      <div className="section-heading">
        <h1>{q ? "Результаты поиска" : "Доступные вещи"}</h1>
        <button
          className="icon-button"
          aria-label={`Фильтры${appliedCount ? `, выбрано ${appliedCount}` : ""}`}
          onClick={() => {
            setDraft(filters);
            setFilterOpen(true);
          }}
        >
          <Icon name="filter" />
          {appliedCount > 0 && (
            <span className="small-count">{appliedCount}</span>
          )}
        </button>
      </div>
      {Boolean(error) && (
        <ErrorBox error={error} retry={() => setRefresh((v) => v + 1)} />
      )}
      <p className="sr-only" aria-live="polite">
        {loading ? "Ищем вещи" : `Показано вещей: ${items.length}`}
      </p>
      {loading && !items.length ? (
        <Loading cards />
      ) : !items.length && !error ? (
        <Empty
          title="Пока ничего не нашли"
          action={<div className="button-stack">
            {relaxKey && <Button onClick={relaxFilter}>
              {relaxKey === "q" ? "Убрать поисковый запрос" : "Ослабить один фильтр"}
            </Button>}
            <Button secondary onClick={() => {
              setQ("");
              setCursor("");
              setFilters({ sort: "new" });
              tapFeedback("selection");
            }}>Показать все вещи</Button>
          </div>}
        >
          Попробуйте ослабить условие поиска.
        </Empty>
      ) : (
        <div className="product-grid" ref={gridRef}>
          {items.map((item, i) => (
            <CatalogProductCard key={item.id} item={item} categoryName={categories.find((c) => c.id === item.category)?.name}
              priority={i < 2} loadPhoto={i < 2 || nearbyPhotos.has(item.id)}
              selectionDisabled={authLoading}
              onOpen={() => go(`/items/${item.id}`)}
              selected={selectionIds.includes(item.id)}
              onToggle={() => {
                const chosen = selectionIds.includes(item.id);
                setSelection(chosen ? selectionIds.filter((id) => id !== item.id) : [...selectionIds, item.id])
                  .then(() => {
                    tapFeedback("success");
                    toast(chosen ? "Вещь убрана из корзины" : "В корзине. Закрепим при оформлении.");
                  }).catch(setError);
              }} />
          ))}
        </div>
      )}
      {more && (
        <Button secondary onClick={() => setCursor(more)} disabled={loading}>
          {loading ? "Загружаем…" : "Показать ещё"}
        </Button>
      )}
      <section className="catalog-note">
        <Icon name="bag" />
        <div>
          <h2>Бронь с примеркой</h2>
          <p>
            Выберите вещи и заберите их в магазине.
            <br />
            {Object.entries(settings?.carriers || {}).filter(([,c]) => c.enabled).length ? `Доставка — ${Object.entries(settings?.carriers || {}).filter(([,c]) => c.enabled).map(([k]) => methodNames[k as Method]).join(" и ")}.` : "Условия отправки уточняются перед запуском."}
          </p>
        </div>
      </section>
      {filterOpen && (
        <Sheet
          title="Фильтры и сортировка"
          onClose={() => setFilterOpen(false)}
        >
          <CatalogFilterAccordion>
            <CatalogFilterSelect
              label="Сначала показывать"
              value={draft.sort || "new"}
              onValueChange={(sort) => setDraft((v) => ({ ...v, sort }))}
              options={[
                { value: "new", label: "Новые поступления" },
                { value: "price_asc", label: "Дешевле" },
                { value: "price_desc", label: "Дороже" },
              ]}
            />
            <CatalogFilterSelect
              label="Назначение"
              multiple
              value={draft.audience ?? []}
              onValueChange={(audience) => setDraft((v) => ({ ...v, audience: audience.length ? audience : undefined }))}
              options={catalogAudiences.map((value) => ({ value, label: value }))}
            />
            <CatalogFilterSelect
              label="Категория"
              multiple
              value={draft.category ?? []}
              onValueChange={(category) => setDraft((v) => ({ ...v, category: category.length ? category : undefined }))}
              searchPlaceholder="Найти категорию"
              options={categories.map((c) => ({ value: c.id, label: c.name }))}
            />
            <div className="form-pair">
              <Field
                label="Цена от, BYN"
                type="number"
                min="0"
                inputMode="decimal"
                value={draft.minPrice || ""}
                onChange={(e) =>
                  setDraft((v) => ({ ...v, minPrice: e.target.value }))
                }
              />
              <Field
                label="До, BYN"
                type="number"
                min="0"
                inputMode="decimal"
                value={draft.maxPrice || ""}
                onChange={(e) =>
                  setDraft((v) => ({ ...v, maxPrice: e.target.value }))
                }
              />
            </div>
            {Boolean(catalogOptions.error) && <ErrorBox error={catalogOptions.error} retry={catalogOptions.reload} />}
            {catalogOptionFields.map(([key, label, searchPlaceholder]) => (
              <CatalogFilterSelect
                key={key}
                label={label}
                multiple
                value={draft[key] ?? []}
                options={(catalogOptions.data?.[key] ?? []).map((value) => ({ value, label: value }))}
                searchPlaceholder={searchPlaceholder}
                allowCustom={Boolean(searchPlaceholder)}
                disabled={catalogOptions.loading && !searchPlaceholder}
                onValueChange={(values) => setDraft((v) => ({ ...v, [key]: values.length ? values : undefined }))}
              />
            ))}
            {!validRange && (
              <p className="field-error">
                Значение «от» не может быть больше значения «до».
              </p>
            )}
            <div className="button-stack">
              <Button
                disabled={!validRange}
                onClick={() => {
                  setCursor("");
                  setQ(draft.q ?? "");
                  setFilters(draft);
                  setFilterOpen(false);
                }}
              >
                Показать вещи
              </Button>
              <Button secondary onClick={() => setDraft({ sort: "new" })}>
                Сбросить
              </Button>
            </div>
          </CatalogFilterAccordion>
        </Sheet>
      )}
    </div>
  );
}

/** Catalogue image swipes reuse media from the current catalogue response. */
function CatalogProductCard({ item, categoryName, priority, loadPhoto, onOpen, selected, selectionDisabled, onToggle }: {
  item: Item; categoryName?: string; priority: boolean; loadPhoto: boolean; onOpen: () => void; selected: boolean; selectionDisabled: boolean; onToggle: () => void;
}) {
  const photos = item.media ?? [];
  const [photoIndex, setPhotoIndex] = useState(0);
  const [photoSelected, setPhotoSelected] = useState(false);
  const photo = photos[photoIndex];
  const changePhoto = (delta: number) => {
    setPhotoSelected(true);
    setPhotoIndex((index) => Math.min(photos.length - 1, Math.max(0, index + delta)));
    tapFeedback("selection");
  };
  const swipeRef = useHorizontalSwipe<HTMLButtonElement>({
    enabled: photos.length > 1,
    onSwipe: changePhoto,
  });
  return <article className="product-card" data-item-id={item.id}>
    <div className="catalog-photo">
      <button className="product-image-button" aria-label={`Открыть ${item.title}`}
        ref={swipeRef} onClick={onOpen}>
        {loadPhoto || photoSelected
          ? <Photo media={photo} alt={item.title} priority={priority || photoSelected} maxWidth={catalogPhotoWidth} />
          : <div className="photo-placeholder" aria-hidden="true" />}
      </button>
      {photos.length > 1 && <div className="catalog-photo-nav" aria-label="Фотографии">
        <button type="button" aria-label="Предыдущее фото" disabled={photoIndex === 0}
          onClick={() => changePhoto(-1)}><Icon name="back" size={15} /></button>
        <span aria-live="off">{photoIndex + 1} / {photos.length}</span>
        <button type="button" aria-label="Следующее фото" disabled={photoIndex === photos.length - 1}
          onClick={() => changePhoto(1)}><Icon name="next" size={15} /></button>
      </div>}
    </div>
    <button className="product-link" onClick={onOpen}>
      <h2>{item.title}</h2>
      <p className="muted">{productSize(item.attributes) || categoryName}</p>
      {item.hasDefect && <span className="defect-badge">Есть дефект</span>}
      <strong className="price">{money(item.priceMinor)}</strong>
    </button>
    <button className={`save-item ${selected ? "selected" : ""}`}
      disabled={selectionDisabled}
      aria-label={selected ? `Убрать ${item.title} из корзины` : `Добавить ${item.title} в корзину`}
      onClick={onToggle}><Icon name={selected ? "check" : "bag"} size={18} /></button>
  </article>;
}

function ItemPage({ id }: { id: string }) {
  const { go, authLoading, selectionIds, setSelection, settings, toast } = useApp();
  const [catalogItem] = useState(() => catalogCache?.items.find((item) => item.id === id));
  const [cachedDetail] = useState(() => {
    const cached = itemDetails.get(id);
    return cached && Date.now() - cached.receivedAt < detailFreshFor ? cached.item : undefined;
  });
  const { data, error, loading, reload } = useLoad<Item>(cachedDetail ? null : `/items/${id}`);
  const confirmed = data ?? cachedDetail;
  const item = confirmed ?? (error ? undefined : catalogItem);
  useEffect(() => {
    if (!data) return;
    itemDetails.set(id, { item: data, receivedAt: Date.now() });
    if (itemDetails.size > 40) itemDetails.delete(itemDetails.keys().next().value!);
  }, [data, id]);
  const [gallery, setGallery] = useState(false),
    [index, setIndex] = useState(0),
    [zoom, setZoom] = useState(1),
    [actionError, setActionError] = useState<unknown>(null);
  const mainPurchase = useRef<HTMLDivElement>(null);
  const updating = useRef(false);
  const [busy, setBusy] = useState(false);
  const [showPurchaseBar, setShowPurchaseBar] = useState(false);
  const available = !authLoading && confirmed?.available === true;
  useEffect(() => {
    const button = mainPurchase.current?.querySelector("button");
    if (!available || !button) return;
    const nav = document.querySelector(".bottom-nav");
    const header = document.querySelector(".app-header");
    const app = tg();
    const viewport = window.visualViewport;
    let observer: IntersectionObserver | undefined;
    let frame = 0;
    const observe = () => {
      observer?.disconnect();
      const fixedHeight = (element: Element | null) => element &&
        ["fixed", "sticky"].includes(getComputedStyle(element).position) ? Math.ceil(element.getBoundingClientRect().height) : 0;
      const css = getComputedStyle(document.body);
      const bottomOffset = Math.max(0, parseFloat(css.getPropertyValue("--app-bottom-offset")) || 0);
      const safeBottom = Math.max(0,
        parseFloat(css.getPropertyValue("--device-safe-bottom")) || 0,
        parseFloat(css.getPropertyValue("--tg-bottom")) || 0,
      );
      const navBounds = nav?.getBoundingClientRect();
      const bottom = nav && navBounds && navBounds.height > 0 && getComputedStyle(nav).position === "fixed"
        ? Math.max(0, window.innerHeight - navBounds.top)
        : bottomOffset + safeBottom;
      observer = new IntersectionObserver(([entry]) => setShowPurchaseBar(entry.intersectionRatio < 0.99), {
        rootMargin: `-${fixedHeight(header)}px 0px -${Math.ceil(bottom)}px 0px`,
        threshold: [0.99],
      });
      observer.observe(button);
    };
    const schedule = () => {
      if (frame) return;
      // App's viewport listener is mounted before this fetched item. Read the
      // updated bottom offset after its animation-frame style update.
      frame = requestAnimationFrame(() => {
        frame = 0;
        observe();
      });
    };
    schedule();
    const resize = new ResizeObserver(schedule);
    if (header) resize.observe(header, { box: "border-box" });
    if (nav) resize.observe(nav, { box: "border-box" });
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    for (const event of ["viewportChanged", "safeAreaChanged", "contentSafeAreaChanged"])
      app?.onEvent(event, schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      for (const event of ["viewportChanged", "safeAreaChanged", "contentSafeAreaChanged"])
        app?.offEvent(event, schedule);
    };
  }, [available]);
  const size = productSize(item?.attributes);
  const media = item?.media ?? [];
  const coverSwipeRef = useHorizontalSwipe<HTMLButtonElement>({
    enabled: media.length > 1,
    onSwipe: (delta) => {
      setIndex((current) => Math.min(media.length - 1, Math.max(0, current + delta)));
      tapFeedback("selection");
    },
  });
  const gallerySwipeRef = useHorizontalSwipe<HTMLDivElement>({
    enabled: zoom === 1 && media.length > 1,
    onSwipe: (delta) => setIndex((current) => (current + delta + media.length) % media.length),
  });
  if (loading && !item) return <Loading cards />;
  if (!item)
    return (
      <div className="page">
        <ErrorBox error={error} retry={reload} />
      </div>
    );
  const chosen = selectionIds.includes(id);
  const floating = available && showPurchaseBar && !gallery;
  const buy = async () => {
    if (!available || updating.current) return;
    if (chosen) {
      go("/selection");
      return;
    }
    updating.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await setSelection([...selectionIds, id]);
      tapFeedback("success");
      toast("Вещь в корзине");
    } catch (e) {
      setActionError(e);
    } finally {
      updating.current = false;
      setBusy(false);
    }
  };
  const purchaseButton = <Button disabled={!available || busy} onClick={buy}>
    {busy ? "Добавляем…" : chosen ? "Перейти в корзину" : "В корзину"}
  </Button>;
  const details = [
    ["brand", "Бренд"],
    ["material", "Состав"],
    ["color", "Цвет"],
    ["season", "Сезон"],
    ["sizeLabel", "Размер"],
    ["care", "Уход"],
    ["manufacturer", "Изготовитель"],
    ["importer", "Импортёр"],
    ["origin", "Страна происхождения"],
    ["documents", "Сведения о документах"],
  ]
    .map(([key, label]) => ({
      label,
      value: String((key === "sizeLabel" ? size : key === "color"
        ? productColor(item.attributes.color) : item.attributes[key]) ?? "").trim(),
    }))
    .filter(detail => detail.value);
  return (
    <div className={`page item-page ${available ? "has-purchase-bar" : ""}`}>
      <div className="item-layout">
        <div>
          <button
            className="gallery-cover"
            ref={coverSwipeRef}
            style={media.length > 1 ? { touchAction: "pan-y pinch-zoom" } : undefined}
            onClick={() => setGallery(true)}
            disabled={!media.length}
            aria-label="Открыть фотогалерею"
          >
            <Photo
              media={media[index]}
              alt={item.title}
              contain
              priority
              previewMaxWidth={media[index]?.id === catalogItem?.media[0]?.id ? catalogPhotoWidth : undefined}
              onLoad={() => {
                // Only the open item's neighbours, after the selected photo loads.
                preloadPhoto(media[index - 1], true);
                preloadPhoto(media[index + 1], true);
              }}
            />
            <span className="photo-counter">
              {media.length ? index + 1 : 0} / {media.length}
            </span>
          </button>
          {media.length > 1 && (
            <div className="photo-thumbs">
              {media.map((m, i) => (
                <button
                  key={m.id}
                  className={index === i ? "selected" : ""}
                  onClick={() => setIndex(i)}
                  aria-label={`Фото ${i + 1}`}
                >
                  <Photo media={m} alt={`${item.title}, фото ${i + 1}`} sizes="56px" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="item-details">
          <h1>{item.title}</h1>
          <p className="muted">
            {size ? `Размер ${size} · ` : ""}
            арт. {item.sku}
          </p>
          <p className="item-price">{money(item.priceMinor)}</p>
          <Defect item={item} expanded />
          <div className="item-social-actions">
            <Button secondary onClick={() => {
              tapFeedback("light");
              shareTelegramItem(item.id, item.title, money(item.priceMinor));
            }}>
              <Icon name="share" size={18} /> Поделиться в Telegram
            </Button>
            <Button ghost onClick={() => {
              const url = `${window.location.origin}/share/item/${encodeURIComponent(item.id)}`;
              const message = `Здравствуйте! Подскажите, пожалуйста, по вещи «${item.title}» (арт. ${item.sku}, ${url}): `;
              tapFeedback("light");
              if (settings?.telegramUsername) {
                openTelegramDraft(settings.telegramUsername, message);
              } else {
                go("/support");
                navigator.clipboard?.writeText(message)
                  .then(() => toast("Вопрос скопирован. Контакт магазина указан в разделе поддержки."))
                  .catch(() => {});
              }
            }}>
              <Icon name="message" size={18} /> Спросить о вещи
            </Button>
          </div>
          {confirmed && !confirmed.available && (
            <div className="notice">
              <strong>Сейчас недоступно</strong>
              <p>
                Эту вещь уже закрепили или сняли с продажи. Выберите другую в
                каталоге.
              </p>
            </div>
          )}
          {item.description && (
            <section className="detail-section">
              <h2>Описание</h2>
              <p className="pre-wrap">{item.description}</p>
            </section>
          )}
          <section className="detail-section">
            <h2>Детали вещи</h2>
            <p>Единственный экземпляр.</p>
            {details.length > 0 && (
              <dl className="details-list">
                {details.map(({ label, value }) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <ItemMeasurements measurements={item.measurements} />
          <section className="detail-section">
            <h2>Получение</h2>
            <p>
              Бесплатная бронь. Самовывоз с примеркой
              {settings?.carriers.BELPOST?.enabled ||
              settings?.carriers.EUROPOST?.enabled
                ? " или отправка в отделение почты"
                : ""}
              .
            </p>
            <Button ghost onClick={() => go("/about")}>
              Сведения о продавце и правила
            </Button>
          </section>
          {!floating && <ErrorBox error={actionError} />}
          <div className="item-cta" ref={mainPurchase} data-floating={floating || undefined}>
            <div>
              <strong>{money(item.priceMinor)}</strong>
              <small>Один экземпляр</small>
            </div>
            {purchaseButton}
            <small>Добавление в корзину ещё не резервирует вещь</small>
          </div>
        </div>
      </div>
      {floating && (
        <div className="purchase-bar" role="region" aria-label="Добавление вещи в корзину">
          <ErrorBox error={actionError} />
          <div className="purchase-bar-content">
            <div className="purchase-bar-price">
              <small>Цена</small>
              <strong>{money(item.priceMinor)}</strong>
            </div>
            {purchaseButton}
          </div>
        </div>
      )}
      {gallery && media.length > 0 && (
        <Sheet
          title={`Фото ${index + 1} из ${media.length}`}
          onClose={() => setGallery(false)}
        >
          <div
            className="gallery-view"
            ref={gallerySwipeRef}
            style={{ touchAction: zoom === 1 ? "pan-y pinch-zoom" : "pan-x pan-y pinch-zoom" }}
          >
            <div
              style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
              onDoubleClick={() => setZoom((z) => (z === 1 ? 2 : 1))}
            >
              <Photo
                media={
                  zoom > 1 && media[index]?.variants?.["1600"]
                    ? {
                        ...media[index],
                        url: media[index].variants!["1600"],
                        variants: undefined,
                      }
                    : media[index]
                }
                alt={item.title}
                contain
                priority
              />
            </div>
          </div>
          <div className="gallery-controls">
            <button
              className="icon-button"
              aria-label="Предыдущее фото"
              disabled={index === 0}
              onClick={() => {
                setIndex((i) => i - 1);
                setZoom(1);
              }}
            >
              <Icon name="back" />
            </button>
            <label>
              Масштаб
              <input
                type="range"
                min="1"
                max="3"
                step="0.25"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              />
            </label>
            <button
              className="icon-button"
              aria-label="Следующее фото"
              disabled={index === media.length - 1}
              onClick={() => {
                setIndex((i) => i + 1);
                setZoom(1);
              }}
            >
              <Icon name="next" />
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
function Selection() {
  const {
    selection,
    selectionIds,
    setSelection,
    go,
    refreshSelection,
    authenticated, settings, offline, demo,
  } = useApp();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    refreshSelection().catch(setError);
  }, [refreshSelection]);
  return (
    <div className="page narrow selection-page">
      <h1>Ваша корзина</h1>
      <p className="muted">
        {itemCount(selectionIds.length)} ·{" "}
        {money(selection.reduce((s, i) => s + i.priceMinor, 0))}
      </p>
      <ErrorBox
        error={error}
        retry={() => refreshSelection().catch(setError)}
      />
      {!selectionIds.length ? (
        <Empty
          title="Здесь будут ваши находки"
          action={
            <Button onClick={() => go("/catalog")}>Посмотреть каталог</Button>
          }
        >
          Добавляйте понравившиеся вещи, чтобы оформить их вместе.
        </Empty>
      ) : (
        <>
          <section className="selection-checkout" aria-label="Оформление корзины">
            <Summary label="Стоимость вещей">{money(selection.reduce((s, i) => s + i.priceMinor, 0))}</Summary>
            <Button disabled={!selection.length || offline || !settings?.acceptingOrders} onClick={() => {
              if (demo || authenticated()) go("/checkout");
            }}>Перейти к оформлению</Button>
            {!settings?.acceptingOrders && <p className="small-text" role="status">Магазин пока не принимает заявки. Вещи остаются в корзине.</p>}
          </section>
          <h2 className="selection-items-heading">Выбранные вещи</h2>
          <div className="item-list">
            {selection.map((item) => (
              <div
                className={`item-row ${!item.available ? "unavailable" : ""}`}
                key={item.id}
              >
                <button
                  className="row-photo"
                  onClick={() => go(`/items/${item.id}`)}
                >
                  <Photo media={item.media[0]} alt={item.title} />
                </button>
                <div className="row-content">
                  <button
                    className="text-link"
                    onClick={() => go(`/items/${item.id}`)}
                  >
                    <strong>{item.title}</strong>
                  </button>
                  <p className="muted">
                    {[productSize(item.attributes), `арт. ${item.sku}`].filter(Boolean).join(" · ")}
                  </p>
                  <Defect item={item} />
                  <strong>{money(item.priceMinor)}</strong>
                  {!item.available && (
                    <p className="field-error">Сейчас недоступно</p>
                  )}
                </div>
                <button
                  className="remove-button"
                  onClick={() =>
                    setSelection(
                      selectionIds.filter((id) => id !== item.id),
                    ).catch(setError)
                  }
                >
                  Убрать
                </button>
              </div>
            ))}
          </div>

          <Button ghost onClick={() => go("/catalog")}>Продолжить выбирать</Button>
        </>
      )}
    </div>
  );
}
type CheckoutOperation = {
  key: string;
  items: { id: string; version: number }[];
  settingsVersion: number;
};

function Checkout() {
  const { user, settings, selection, selectionIds, refreshSelection, refreshSettings, go, toast, offline, demo } = useApp();
  const account = user?.id || "anonymous";
  const operationStorage = `${account}:checkout-operation`;
  const leaseStorage = `${account}:checkout-lease`;
  const session = useMemo(() => getDraftSession(account, api), [account]);
  const draftState = useSyncExternalStore(session.subscribe, session.snapshot);
  const { draft, loaded } = draftState;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState<CheckoutOperation | string | null>(() => readLocal(operationStorage, null));
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!user && !demo) return;
    session.load().catch(setError);
    const oldLease = readLocal<{ id: string } | null>(leaseStorage, null);
    const oldOperation = readLocal<CheckoutOperation | string | null>(operationStorage, null);
    if (oldLease && !oldOperation)
      api(`/checkout/leases/${oldLease.id}`, { method: "DELETE" })
        .then(() => saveLocal(leaseStorage, null)).catch(setError);
    return () => { session.flush().catch(() => {}); };
  }, [user?.id, demo, session, leaseStorage, operationStorage]);

  useEffect(() => {
    const flush = () => session.flush().catch(() => {});
    const onVisibilityChange = () => { if (document.hidden) flush(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flush);
    };
  }, [session]);

  const set = (key: keyof Draft, value: string) => {
    session.update({ [key]: value });
    setError(null);
  };
  const methods = checkoutMethods.filter(method => method === "PICKUP" || settings?.carriers[method]?.enabled);
  const method = methods.includes(draft.method) ? draft.method : "PICKUP";
  const fieldErrors = {
    ...(error instanceof ApiError ? error.fieldErrors : {}),
    ...(attempted ? recipientErrors(method, draft) : {}),
  };
  const unavailable = selectionIds.length !== selection.length || selection.some(item => !item.available);

  const recordPending = (operation: CheckoutOperation | string | null) => {
    saveLocal(operationStorage, operation);
    setPending(operation);
  };
  const complete = (order: Order) => {
    if (!order?.id) throw new Error("Не удалось получить подтверждение сохранения заявки");
    invalidateCatalog();
    recordPending(null);
    saveLocal(leaseStorage, null);
    session.finish();
    tapFeedback("success");
    refreshSelection().catch(() => {});
    go(`/orders/${order.id}`);
  };
  const findResult = async (key: string) => {
    const response = await api<Order | { result: Order }>(`/operations/${key}`);
    return "result" in response ? response.result : response;
  };
  const recover = async () => {
    if (!pending || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      complete(await findResult(typeof pending === "string" ? pending : pending.key));
    } catch (e) {
      setError(e);
      if (typeof pending === "string" && e instanceof ApiError && e.status === 404) {
        const oldLease = readLocal<{ id: string } | null>(leaseStorage, null);
        try {
          if (oldLease) await api(`/checkout/leases/${oldLease.id}`, { method: "DELETE" });
          saveLocal(leaseStorage, null);
          recordPending(null);
          await refreshSelection();
        } catch (releaseError) { setError(releaseError); }
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const submit = async (retry?: CheckoutOperation) => {
    if (submitting.current || offline) return;
    if (!retry && (pending || !settings?.acceptingOrders || !selection.length || unavailable)) return;
    setAttempted(true);
    const current = session.snapshot().draft;
    const selectedMethod = retry ? current.method : method;
    if (Object.keys(recipientErrors(selectedMethod, current)).length) {
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    const operation = retry ?? {
      key: operationKey(),
      items: selection.map(({ id, version }) => ({ id, version })),
      settingsVersion: settings!.version,
    };
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (current.method !== selectedMethod) session.update({ method: selectedMethod });
      await session.flush();
      recordPending(operation);
      const { key, ...snapshot } = operation;
      try {
        const order = await command<Order>("/orders", {
          ...session.snapshot().draft, ...session.orderMetadata(), ...snapshot, termsAccepted: true,
        }, "POST", key);
        complete(order);
      } catch (e) {
        const paused = e instanceof ApiError && ["STORE_CLOSED", "LAUNCH_SETTINGS"].includes(e.code);
        const uncertain = !(e instanceof ApiError) || e.status === 0 ||
          (e.status >= 500 && !paused) || e.code === "IDEMPOTENCY_MISMATCH";
        if (uncertain) {
          try { complete(await findResult(key)); }
          catch { setError(e); }
        } else {
          recordPending(null);
          setError(e);
          if (paused || ["RULES_CHANGED", "DELIVERY_DISABLED"].includes(e.code)) await refreshSettings().catch(() => {});
          if (["ITEM_CHANGED", "ITEM_NOT_FOUND", "AVAILABILITY_CONFLICT"].includes(e.code))
            await refreshSelection().catch(() => {});
        }
      }
    } catch (e) {
      setError(e);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  if (!user && !demo)
    return <div className="page"><Empty title="Откройте магазин через Telegram">
      Для отправки заявки войдите через Telegram. Вещи остаются в корзине.
    </Empty></div>;
  if (!loaded) return <div className="page narrow">
    <ErrorBox error={error} retry={() => session.load().then(() => setError(null)).catch(setError)} />
    {!error && <Loading />}
  </div>;

  return (
    <div className="page narrow checkout-page">
      <h1>Оформление заявки</h1>
      <p className="muted">Выберите способ получения, укажите контакты и отправьте заявку на подтверждение.</p>
      <ErrorBox error={error || draftState.error} />
      {pending && (
        <section className="notice">
          <h2>Проверка результата заявки</h2>
          <p>Если подтверждение не пришло, проверьте, сохранилась ли заявка.</p>
          <div className="button-stack">
            <Button onClick={recover} disabled={busy || offline}>Проверить результат</Button>
            {typeof pending !== "string" && <Button secondary onClick={() => submit(pending)} disabled={busy || offline}>Повторить отправку</Button>}
          </div>
        </section>
      )}
      {!pending && !settings?.acceptingOrders && <p className="notice" role="status">Магазин пока не принимает заявки. Вещи остаются в корзине.</p>}
      {!pending && unavailable && <p className="notice" role="status">Некоторые вещи недоступны. Вернитесь в корзину, чтобы изменить состав заявки.</p>}
      <form ref={form} className="form-stack" noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); void submit(); }}>
        <fieldset className="checkout-fields" disabled={Boolean(pending) || busy || draftState.clearing}>
          <legend>Способ получения</legend>
          <div className="delivery-options">
            {methods.map(option => (
              <label key={option} className={`delivery-option ${method === option ? "selected" : ""}`}>
                <div>
                  <Icon name={option === "PICKUP" ? "pin" : "box"} />
                  <strong>{methodNames[option]}</strong>
                  <input type="radio" name="method" checked={method === option} onChange={() => {
                    session.update({ method: option, office: "", officeAddress: "", postalCode: "" });
                    setError(null);
                  }} />
                </div>
              </label>
            ))}
          </div>
          {method === "PICKUP" ? (
            <div className="checkout-method-note">
              <strong>Бесплатная бронь с примеркой</strong>
              <p>Наличие сначала подтвердит сотрудник. Оплата только в магазине после примерки.</p>
              {settings?.address && <p><strong>Адрес:</strong> {settings.address} · <MapLink address={settings.address} /></p>}
              {settings?.calendar && <p>{storeHours(settings.calendar).schedule}</p>}
            </div>
          ) : (
            <div className="checkout-method-note">
              <strong>Доставка в отделение</strong>
              <p>{shippingCostNotice}. Стоимость и порядок оплаты согласуем с вами до отправки. Отправку оформит сотрудник вручную.</p>
              {settings?.carriers[method]?.terms && <p>{settings.carriers[method].terms}</p>}
            </div>
          )}
        </fieldset>
        <fieldset className="checkout-fields" disabled={Boolean(pending) || busy || draftState.clearing}>
          <legend>Контакты</legend>
          <Field label="Телефон" type="tel" autoComplete="tel" value={draft.phone}
            required maxLength={22} onChange={e => set("phone", e.target.value)} error={fieldErrors.phone} />
          {!demo && tg()?.requestContact && <Button secondary onClick={() => {
            const phone = session.snapshot().draft.phone;
            tg()?.requestContact?.(async (success) => {
              if (!success) return;
              try {
                const saved = await api<Partial<Draft>>("/me/contact");
                if (!submitting.current && saved.phone && session.snapshot().draft.phone === phone) set("phone", saved.phone);
                else toast("Контакт передан. При необходимости введите номер вручную.");
              } catch (e) { setError(e); }
            });
          }}>Поделиться контактом Telegram</Button>}
          {method !== "PICKUP" && <>
            <Field label="Фамилия и имя получателя" autoComplete="name" required maxLength={200}
              value={draft.fullName} error={fieldErrors.fullName} onChange={e => set("fullName", e.target.value)} />
            <Field label="Населённый пункт" required maxLength={150}
              value={draft.city} error={fieldErrors.city} onChange={e => set("city", e.target.value)} />
            <Field label={method === "EUROPOST" ? "Предпочтительное отделение, если известно" : "Отделение или его адрес"}
              required={method === "BELPOST"} maxLength={350} value={[draft.office, draft.officeAddress].filter(Boolean).join(", ")}
              error={fieldErrors.office} onChange={e => { session.update({ office: e.target.value, officeAddress: "" }); setError(null); }} />
            {method === "BELPOST" && <Field label="Индекс отделения, если известен" inputMode="numeric"
              maxLength={6} value={draft.postalCode} error={fieldErrors.postalCode} onChange={e => set("postalCode", e.target.value)} />}
          </>}
          <Textarea label="Комментарий магазину, необязательно" maxLength={1000}
            value={draft.comment} onChange={value => set("comment", value)} />
          <div className="recipient-preferences">
            <label className="check-row"><input type="checkbox" checked={draftState.saveRecipient}
              onChange={e => session.setSaveRecipient(e.target.checked)} /><span>Сохранить данные для следующих заявок</span></label>
            <button type="button" className="text-link"
              onClick={() => session.clear().then(() => toast("Данные получателя и черновик очищены")).catch(setError)}>Очистить сохранённые данные</button>
          </div>
        </fieldset>
        {draftState.status === "failed" && (
          <p className="small-text" role="status">Не удалось сохранить черновик. Данные остаются в форме.</p>
        )}
        <section className="detail-section">
          <h2>Состав заявки</h2>
          <div className="compact-lines">
            {selection.map(item => (
              <div className="item-row" key={item.id}>
                <Photo media={item.media[0]} alt={item.title} />
                <div>
                  <strong>{item.title}</strong>
                  <Defect item={item} />
                  <p>{money(item.priceMinor)}</p>
                </div>
              </div>
            ))}
          </div>
          <Summary label="Стоимость вещей">{money(selection.reduce((sum, item) => sum + item.priceMinor, 0))}</Summary>
        </section>
        <p className="small-text">Отправляя заявку, вы принимаете <button type="button" className="text-link" onClick={() => go("/about")}>правила магазина и обработки данных</button>.</p>
        <div className="button-stack">
          <Button type="submit" disabled={busy || Boolean(pending) || offline || draftState.clearing ||
            !settings?.acceptingOrders || unavailable || !selection.length}>{busy ? "Отправляем…" : "Отправить заявку"}</Button>
          <Button secondary disabled={busy} onClick={() => go("/selection")}>Вернуться в корзину</Button>
        </div>
      </form>
    </div>
  );
}
export function OrderCard({
  order,
  onOpen,
}: {
  order: Order;
  onOpen: () => void;
}) {
  return (
    <button className="order-card" onClick={onOpen}>
      <div className="order-card-header">
        <strong>
          {order.method === "PICKUP" ? "Бронь" : "Заявка"} №{order.number}
        </strong>
        <Icon name="next" size={18} />
      </div>
      <p className="muted">
        {methodNames[order.method]} ·{" "}
        {itemCount(order.lines.filter((l) => activeLine(l) || ["HANDED_OVER", "SOLD"].includes(l.outcome)).length)}
      </p>
      <div className="order-card-content">
        <div className="mini-photos">
          {order.lines.slice(0, 3).map((line) => (
            <Photo key={line.id} media={line.media?.[0]} alt={line.title} />
          ))}
        </div>
        <strong>{money(order.totalMinor)}</strong>
      </div>
      <p className="status-text">
        <Icon
          name={order.status === "READY_FOR_PICKUP" ? "check" : "clock"}
          size={17}
        />
        {statusNames[order.status] || order.status}
      </p>
      {order.pickupDeadline && order.status === "READY_FOR_PICKUP" && (
        <p className="small-text">Храним до {date(order.pickupDeadline)}</p>
      )}
      {order.status === "CHECKING" && (
        <p className="small-text">Проверим до {date(order.verifyBy)}</p>
      )}
    </button>
  );
}
function Orders() {
  const { user, go } = useApp();
  const [tab, setTab] = useState("active");
  const { data, error, loading, reload } = useLoad<{ orders: Order[] }>(
    user ? "/me/orders" : null,
  );
  const terminal = ["CANCELLED", "EXPIRED", "FULFILLED", "CLOSED", "RETURNED"];
  return (
    <div className="page narrow">
      <div className="section-heading">
        <h1>Мои обращения</h1>
        <button
          className="icon-button"
          aria-label="Уведомления"
          onClick={() => go("/events")}
        >
          <Icon name="bell" />
        </button>
      </div>
      <div className="segmented">
        <button
          className={tab === "active" ? "selected" : ""}
          onClick={() => setTab("active")}
        >
          Активные
        </button>
        <button
          className={tab === "done" ? "selected" : ""}
          onClick={() => setTab("done")}
        >
          Завершённые
        </button>
      </div>
      <ErrorBox error={error} retry={reload} />
      {loading ? (
        <Loading />
      ) : !user ? (
        <Empty title="Ваши брони — здесь">
          Откройте магазин через Telegram, чтобы видеть свои обращения.
        </Empty>
      ) : !data?.orders.filter(
          (o) => terminal.includes(o.status) === (tab === "done"),
        ).length ? (
        <Empty
          title={
            tab === "active"
              ? "Пока нет активных обращений"
              : "Завершённых обращений пока нет"
          }
          action={<Button onClick={() => go("/catalog")}>Выбрать вещи</Button>}
        >
          После оформления здесь появятся состав, сроки и следующий шаг.
        </Empty>
      ) : (
        <div className="order-list">
          {data?.orders
            .filter((o) => terminal.includes(o.status) === (tab === "done"))
            .map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onOpen={() => go(`/orders/${order.id}`)}
              />
            ))}
        </div>
      )}
    </div>
  );
}
