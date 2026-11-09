import { productColor, productSize } from "../shared/catalog-attributes.js";
import { useEffect, useRef, useState, useMemo, useSyncExternalStore, type FormEvent } from "react";
import {
  api,
  ApiError,
  command,
  operationKey,
  readLocal,
  saveLocal,
} from "./api";
import { useApp } from "./context";
import {
  Button,
  Copy,
  Empty,
  ErrorBox,
  Field,
  Icon,
  Loading,
  Photo,
  Select,
  Sheet,
  Summary,
  Textarea,
  useLoad,
} from "./ui";
import {
  date,
  itemCount,
  type Settings,
  methodNames,
  money,
  statusNames,
  type Draft,
  type Event,
  type Item,
  type Line,
  type Method,
  type Order,
} from "./types";
import { getDraftSession } from "./checkout-draft";
import { storeHours } from "../shared/store-hours";
import { defaultBuyerGuide } from "../shared/buyer-guide";
import { openTelegram, tg } from "./telegram";
const draftDefault: Draft = {
  method: "PICKUP",
  phone: "",
  fullName: "",
  city: "",
  office: "",
  officeAddress: "",
  postalCode: "",
  comment: "",
};
const activeLine = (line: Line) =>
  ["RESERVED", "RELEASE_PENDING"].includes(line.outcome);
let catalogCache: {
  filterKey: string;
  items: Item[];
  cursor: string;
  next: string | null;
} | null = null;
export default function Buyer() {
  const { path } = useApp();
  if (path.startsWith("/items/")) return <ItemPage id={path.split("/")[2]} />;
  if (path === "/selection") return <Selection />;
  if (path === "/checkout" || path.startsWith("/checkout/")) return <Checkout key={path} />;
  if (path.startsWith("/orders/")) return <OrderPage id={path.split("/")[2]} />;
  if (path === "/orders") return <Orders />;
  if (path === "/about") return <About />;
  if (path === "/support") return <Support />;
  if (path === "/events") return <Events />;
  if (path === "/invite") return <Invite />;
  return <Catalog />;
}
function Catalog() {
  const { categories, go, selectionIds, setSelection, toast, settings } = useApp();
  const [filters, setFilters] = useState<Record<string, string>>(() => {
      const saved = readLocal<Record<string, string>>("catalogFilters", { sort: "new" });
      const allowed = ["sort", "q", "category", "audience", "minPrice", "maxPrice", "sizeLabel", "brand", "color", "material", "season"];
      return Object.fromEntries(Object.entries(saved).filter(([key, value]) => {
        if (key === "sizeLabel" && saved.sizeSystem && saved.sizeSystem !== "RU") return false;
        if (key === "color" && !productColor(value)) return false;
        return allowed.includes(key);
      }));
    }),
    [q, setQ] = useState(filters.q || ""),
    [filterOpen, setFilterOpen] = useState(false),
    [draft, setDraft] = useState(filters),
    [cursor, setCursor] = useState(() =>
      catalogCache?.filterKey === JSON.stringify(filters)
        ? catalogCache.cursor
        : "",
    ),
    [items, setItems] = useState<Item[]>(() =>
      catalogCache?.filterKey === JSON.stringify(filters)
        ? catalogCache.items
        : [],
    ),
    [more, setMore] = useState<string | null>(() =>
      catalogCache?.filterKey === JSON.stringify(filters)
        ? catalogCache.next
        : null,
    ),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((v) => {
        if (v.q === q || (!v.q && !q)) return v;
        setCursor("");
        return { ...v, q };
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => {
    saveLocal("catalogFilters", filters);
  }, [filters]);
  const scrollRestored = useRef(false);
  useEffect(() => {
    catalogCache = {
      filterKey: JSON.stringify(filters),
      items,
      cursor,
      next: more,
    };
  }, [filters, items, cursor, more]);
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
  const query = new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v !== "")
      .map(([key, value]) => [
        key,
        ["minPrice", "maxPrice"].includes(key)
          ? String(Math.round(Number(value.replace(",", ".")) * 100))
          : value.trim(),
      ]),
  );
  if (cursor) query.set("cursor", cursor);
  const queryString = query.toString();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<{ items: Item[]; nextCursor: string | null }>(
      `/catalog?${queryString}`,
      { signal: controller.signal },
    )
      .then((data) => {
        setItems((old) =>
          cursor
            ? [
                ...old.filter((i) => !data.items.some((n) => n.id === i.id)),
                ...data.items,
              ]
            : data.items,
        );
        setMore(data.nextCursor);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [queryString, refresh, cursor]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState !== "visible") return;
      setRefresh((v) => v + 1);
      const ids = Array.from(
        document.querySelectorAll<HTMLElement>("article[data-item-id]"),
      )
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.bottom >= 0 && rect.top <= window.innerHeight;
        })
        .map((el) => el.dataset.itemId)
        .filter((id): id is string => Boolean(id));
      Promise.all(
        ids.map((id) => api<Item>(`/items/${id}`).catch(() => null)),
      ).then((current) => {
        const fresh = new Map(
          current.filter((i): i is Item => i !== null).map((i) => [i.id, i]),
        );
        setItems((previous) =>
          previous
            .filter((i) => fresh.get(i.id)?.available !== false)
            .map((i) => fresh.get(i.id) || i),
        );
      });
    };
    const timer = setInterval(update, 15000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, []);
  const change = (key: string, value: string) => {
    setCursor("");
    setFilters((v) => ({ ...v, [key]: value }));
  };
  const validRange =
    !draft.minPrice || !draft.maxPrice ||
    Number(draft.minPrice) <= Number(draft.maxPrice);
  const appliedCount = Object.entries(filters).filter(
    ([k, v]) => !["q", "sort"].includes(k) && v,
  ).length;
  return (
    <div className="page catalog-page">
      <p className="catalog-kicker">Секонд-хенд · Минск</p>
      <div className="search-row">
        <label className="search-pill">
          <Icon name="search" />
          <span>
            <strong>Что ищем?</strong>
            <input
              type="search"
              placeholder="Название, бренд, цвет, артикул"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Поиск вещей"
            />
          </span>
          {q && (
            <button
              className="icon-button small"
              aria-label="Очистить поиск"
              onClick={() => setQ("")}
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </label>
        <button
          className="search-cta"
          aria-label="Найти вещи"
          onClick={() => {
            change("q", q);
            setRefresh((v) => v + 1);
          }}
        >
          <Icon name="search" />
        </button>
      </div>
      <div className="chips" aria-label="Категории">
        <button
          className={!filters.category ? "selected" : ""}
          onClick={() => change("category", "")}
        >
          Всё
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            className={filters.category === c.id ? "selected" : ""}
            onClick={() => change("category", c.id)}
          >
            {c.name}
          </button>
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
          action={
            <Button
              secondary
              onClick={() => {
                setQ("");
                setCursor("");
                setFilters({ sort: "new" });
              }}
            >
              Сбросить фильтры
            </Button>
          }
        >
          Попробуйте другую категорию или более широкий диапазон.
        </Empty>
      ) : (
        <div className="product-grid">
          {items.map((item, i) => (
            <article
              key={item.id}
              data-item-id={item.id}
              className="product-card"
            >
              <button
                className="product-link"
                onClick={() => go(`/items/${item.id}`)}
              >
                <Photo
                  media={item.media?.find((photo) => photo.role !== "MEASUREMENT")}
                  alt={item.title}
                  priority={i < 4}
                />
                <h2>{item.title}</h2>
                <p className="muted">
                  {productSize(item.attributes) || categories.find((c) => c.id === item.category)?.name}
                </p>
                {item.hasDefect && <span className="defect-badge">Есть дефект</span>}
                <strong className="price">{money(item.priceMinor)}</strong>
              </button>
              <button
                className={`save-item ${selectionIds.includes(item.id) ? "selected" : ""}`}
                aria-label={
                  selectionIds.includes(item.id)
                    ? `Убрать ${item.title} из подборки`
                    : `Добавить ${item.title} в подборку`
                }
                onClick={() =>
                  setSelection(
                    selectionIds.includes(item.id)
                      ? selectionIds.filter((id) => id !== item.id)
                      : [...selectionIds, item.id],
                  )
                    .then(() =>
                      toast(
                        selectionIds.includes(item.id)
                          ? "Вещь убрана из подборки"
                          : "В подборке. Закрепим при оформлении.",
                      ),
                    )
                    .catch(setError)
                }
              >
                <Icon
                  name={selectionIds.includes(item.id) ? "check" : "plus"}
                  size={18}
                />
              </button>
            </article>
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
          <div className="form-stack">
            <Select
              label="Сначала показывать"
              value={draft.sort || "new"}
              onChange={(e) =>
                setDraft((v) => ({ ...v, sort: e.target.value }))
              }
            >
              <option value="new">Новые поступления</option>
              <option value="price_asc">Дешевле</option>
              <option value="price_desc">Дороже</option>
            </Select>
            <Select
              label="Категория"
              value={draft.category || ""}
              onChange={(e) =>
                setDraft((v) => ({ ...v, category: e.target.value }))
              }
            >
              <option value="">Все категории</option>
              {categories.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select
              label="Назначение"
              value={draft.audience || ""}
              onChange={(e) =>
                setDraft((v) => ({ ...v, audience: e.target.value }))
              }
            >
              <option value="">Любое</option>
              {["Женское", "Мужское", "Унисекс", "Детское"].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
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
            <Field
              label="Размер"
              value={draft.sizeLabel || ""}
              placeholder="Например, 44 или 110"
              onChange={(e) =>
                setDraft((v) => ({ ...v, sizeLabel: e.target.value }))
              }
            />
            {[
              ["brand", "Бренд"],
              ["color", "Цвет"],
              ["material", "Материал"],
              ["season", "Сезон"],
            ].map(([key, label]) => (
              <Field
                key={key}
                label={label}
                value={draft[key] || ""}
                onChange={(e) =>
                  setDraft((v) => ({ ...v, [key]: e.target.value }))
                }
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
          </div>
        </Sheet>
      )}
    </div>
  );
}
function ItemPage({ id }: { id: string }) {
  const { go, selectionIds, setSelection, settings, toast } = useApp();
  const { data: item, error, loading, reload } = useLoad<Item>(`/items/${id}`);
  const [gallery, setGallery] = useState(false),
    [index, setIndex] = useState(0),
    [zoom, setZoom] = useState(1),
    [actionError, setActionError] = useState<unknown>(null);
  const size = productSize(item?.attributes);
  const media = item?.media.filter((photo) => photo.role !== "MEASUREMENT") ?? [];
  if (loading && !item) return <Loading cards />;
  if (!item)
    return (
      <div className="page">
        <ErrorBox error={error} retry={reload} />
      </div>
    );
  const chosen = selectionIds.includes(id);
  return (
    <div className="page item-page">
      <div className="item-layout">
        <div>
          <button
            className="gallery-cover"
            onClick={() => setGallery(true)}
            disabled={!media.length}
            aria-label="Открыть фотогалерею"
          >
            <Photo
              media={media[index]}
              alt={item.title}
              contain
              priority
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
                  <Photo media={m} alt={`${item.title}, фото ${i + 1}`} />
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
          {!item.available && (
            <div className="notice">
              <strong>Сейчас недоступно</strong>
              <p>
                Эту вещь уже закрепили или сняли с продажи. Выберите другую в
                каталоге.
              </p>
            </div>
          )}
          <section className="detail-section">
            <h2>Детали вещи</h2>
            <p>Единственный экземпляр.</p>
            <dl className="details-list">
              {[
                ["brand", "Бренд"],
                ["material", "Состав"],
                ["color", "Цвет"],
                ["season", "Сезон"],
                ["care", "Уход"],
                ["manufacturer", "Изготовитель"],
                ["importer", "Импортёр"],
                ["origin", "Страна происхождения"],
                ["documents", "Сведения о документах"],
              ]
                .map(([key, label]) => [label, key === "color" ? productColor(item.attributes.color) : item.attributes[key]])
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
          </section>
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
          <ErrorBox error={actionError} />
          <div className="item-cta">
            <div>
              <strong>{money(item.priceMinor)}</strong>
              <small>Один экземпляр</small>
            </div>
            <Button
              disabled={!item.available}
              onClick={() =>
                setSelection(
                  chosen
                    ? selectionIds.filter((v) => v !== id)
                    : [...selectionIds, id],
                )
                  .then(() => toast(chosen ? "Вещь убрана" : "Вещь в подборке"))
                  .catch(setActionError)
              }
            >
              {chosen ? "В подборке ✓" : "В подборку"}
            </Button>
            <small>Добавление в подборку ещё не резервирует вещь</small>
          </div>
        </div>
      </div>
      {gallery && media.length > 0 && (
        <Sheet
          title={`Фото ${index + 1} из ${media.length}`}
          onClose={() => setGallery(false)}
        >
          <div
            className="gallery-view"
            onTouchStart={(e) => {
              e.currentTarget.dataset.startX = String(e.touches[0].clientX);
            }}
            onTouchEnd={(e) => {
              const delta =
                e.changedTouches[0].clientX -
                Number(e.currentTarget.dataset.startX);
              if (Math.abs(delta) > 60 && zoom === 1)
                setIndex(
                  (i) =>
                    (i + (delta < 0 ? 1 : -1) + media.length) %
                    media.length,
                );
            }}
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
      <h1>Ваша подборка</h1>
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
          <section className="selection-checkout" aria-label="Оформление подборки">
            <Summary label="Стоимость вещей">{money(selection.reduce((s, i) => s + i.priceMinor, 0))}</Summary>
            <div className="receiving-actions">
              <Button disabled={!selection.length || offline} onClick={() => { if (demo || authenticated()) go("/checkout/pickup"); }}>
                <Icon name="pin" /><span><strong>Забронировать в магазине</strong><small>{settings?.buyerGuide?.pickupSummary || defaultBuyerGuide.pickupSummary}</small></span><Icon name="next" size={18} />
              </Button>
              <Button secondary disabled={!selection.length || offline || (!demo && !settings?.carriers.EUROPOST.enabled)} onClick={() => { if (demo || authenticated()) go("/checkout/delivery"); }}>
                <Icon name="box" /><span><strong>Оформить доставку</strong><small>{demo || settings?.carriers.EUROPOST.enabled ? settings?.buyerGuide?.shippingSummary || defaultBuyerGuide.shippingSummary : "Отправка пока недоступна"}</small></span><Icon name="next" size={18} />
              </Button>
            </div>
            <p className="small-text">{settings?.buyerGuide?.selection || defaultBuyerGuide.selection}</p>
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
                  <Photo media={item.media.find((photo) => photo.role !== "MEASUREMENT")} alt={item.title} />
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
function Checkout() {
  const { user, settings, selection, selectionIds, setSelection, go, toast, path, offline, demo } = useApp();
  const requestedMethod = path.endsWith("/pickup") ? "PICKUP" : path.endsWith("/delivery") ? "EUROPOST" : null;

  const session = useMemo(() => getDraftSession(user?.id || "anonymous", api), [user?.id]);
  const draftState = useSyncExternalStore(session.subscribe, session.snapshot);
  const { draft, loaded } = draftState;
  const accountKey = (name: string) => `${user?.id || "anonymous"}:${name}`;
  const [step, setStep] = useState(() =>
      readLocal(accountKey("checkout-lease"), null) ? 2 : requestedMethod ? 1 : 0,
    ),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [attempted, setAttempted] = useState(false),
    [lease, setLease] = useState<{ id: string; expiresAt: string; items?: Item[]; rules?: Settings } | null>(() =>
      readLocal(accountKey("checkout-lease"), null),
    ),
    [conflicts, setConflicts] = useState<{ itemId: string; reason: string }[]>(
      [],
    ),
    [pending, setPending] = useState(() =>
      Boolean(readLocal(accountKey("checkout-operation"), null)),
    );
  const confirmationBody = useRef<Record<string,unknown> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (loaded) { window.scrollTo({top:0,behavior:"instant"}); heading.current?.focus({preventScroll:true}); } }, [step,loaded]);
  const key = useRef(
    readLocal<string | null>(accountKey("checkout-operation"), null) || operationKey(),
  );
  useEffect(() => {
    if (!user) return;
    let active = true;
    (async () => {
      await session.load();
      if (!active) return;
      const data = session.snapshot().draft;
      if (lease && ((!lease.rules && !pending) || (requestedMethod && !pending && data.method !== requestedMethod))) {
        await api(`/checkout/leases/${lease.id}`, {method:"DELETE"});
        if (!active) return;
        setLease(null); saveLocal(accountKey("checkout-lease"), null); setStep(1);
      }
      if (requestedMethod && !pending && data.method !== requestedMethod) session.update({ method: requestedMethod });
    })().catch(e => { if (active) setError(e); });
    return () => { active = false; session.flush({keepalive:true}).catch(() => {}); };
  }, [user?.id, session, requestedMethod]);
  useEffect(() => {
    const flush = () => { if (document.hidden) session.flush({keepalive:true}).catch(() => {}); };
    const leave = () => { session.flush({keepalive:true}).catch(() => {}); };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", leave);
    return () => { document.removeEventListener("visibilitychange", flush); window.removeEventListener("pagehide", leave); };
  }, [session]);
  const changeReceiving = async () => {
    try { await session.flush(); go("/checkout"); } catch(e) { setError(e); }
  };
  const set = (key: keyof Draft, value: string) => session.update({[key]:value});
  const contact = () => {
    const phoneAtRequest = session.snapshot().draft.phone;
    const app = tg();
    if (!app?.requestContact) {
      toast(
        "Введите номер вручную — Telegram не поддерживает запрос контакта в этом окне.",
      );
      return;
    }
    app.requestContact(async (success) => {
      if (success) {
        try {
          const saved = await api<Partial<Draft>>("/me/contact");
          if (saved.phone && session.snapshot().draft.phone === phoneAtRequest) set("phone", saved.phone);
          else
            toast("Контакт передан. При необходимости введите номер вручную.");
        } catch (e) {
          setError(e);
        }
      } else toast("Можно ввести телефон вручную.");
    });
  };
  const acquire = async (ids = selectionIds) => {
    if (pending) return;
    setBusy(true);
    setError(null);
    setConflicts([]);
    try {
      await session.flush();
      const response = await command<{ id: string; expiresAt: string; items: Item[]; rules: Settings }>(
        "/checkout/leases",
        { itemIds: ids },
      );
      setLease(response);
      saveLocal(accountKey("checkout-lease"), response);
      setStep(2);
    } catch (e) {
      setError(e);
      if (e instanceof ApiError) setConflicts(e.conflicts);
    } finally {
      setBusy(false);
    }
  };
  const recover = async () => {
    setBusy(true);
    try {
      const op = await api<Order | { result: Order }>(
        `/operations/${key.current}`,
      );
      const order = "result" in op ? op.result : op;
      if (order.id) {
        session.finish();
        saveLocal(accountKey("checkout-operation"), null);
        saveLocal(accountKey("checkout-lease"), null);
        await setSelection([]).catch(() => {});
        go(`/orders/${order.id}`);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!lease) return;
    setBusy(true);
    setError(null);
    saveLocal(accountKey("checkout-operation"), key.current);
    try {
      if (!pending) await session.flush();
      confirmationBody.current ??= { ...draft, ...session.orderMetadata(), leaseId: lease.id, termsAccepted: true, settingsVersion: lease.rules?.version };
      const order = await command<Order>(
        "/orders",
        confirmationBody.current,
        "POST",
        key.current,
      );
      session.finish();
      saveLocal(accountKey("checkout-operation"), null);
      saveLocal(accountKey("checkout-lease"), null);
      await setSelection([]).catch(() => {});
      go(`/orders/${order.id}`);
    } catch (e) {
      setError(e);
      const uncertain = !(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.code === "IDEMPOTENCY_MISMATCH";
      if (uncertain) {
        setPending(true);
        try {
          const op = await api<Order | { result: Order }>(
            `/operations/${key.current}`,
          );
          const order = "result" in op ? op.result : op;
          if (order.id) {
            session.finish();
            saveLocal(accountKey("checkout-operation"), null);
            saveLocal(accountKey("checkout-lease"), null);
            await setSelection([]).catch(() => {});
            go(`/orders/${order.id}`);
          }
        } catch {
          /* Keep original operation key for explicit retry. */
        }
      } else if (
        e instanceof ApiError &&
        (e.status === 410 || e.code === "LEASE_EXPIRED" || e.code === "RULES_CHANGED")
      ) {
        if (e.code === "RULES_CHANGED") await api(`/checkout/leases/${lease.id}`, { method:"DELETE" }).catch(() => {});
        setLease(null);
        saveLocal(accountKey("checkout-lease"), null);
        setStep(1);
        key.current = operationKey();
        saveLocal(accountKey("checkout-operation"), null);
      }
      if (!uncertain) {
        confirmationBody.current = null; setPending(false);
        saveLocal(accountKey("checkout-operation"), null); key.current = operationKey();
      }
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (loaded && pending) recover();
  }, [loaded]);
  const displayedSettings = lease?.rules || settings;
  const guide = { ...defaultBuyerGuide, ...displayedSettings?.buyerGuide };
  if (!user && !demo)
    return (
      <div className="page">
        <Empty title="Откройте магазин через Telegram">
          Для оформления нужна защищённая авторизация. Подборка сохранена на
          этом устройстве.
        </Empty>
      </div>
    );
  if (!loaded)
    return (
      <div className="page narrow">
        <ErrorBox
          error={error}
          retry={() => session.load().catch(setError)}
        />
        {!error && <Loading />}
      </div>
    );
  const unavailable = selection.filter((i) => !i.available);
  const availableIds = selectionIds.filter(
    (id) =>
      !conflicts.some((c) => c.itemId === id) &&
      !unavailable.some((i) => i.id === id),
  );
  const fieldErrors: Record<string,string> = error instanceof ApiError ? {...error.fieldErrors} : {};
  if (attempted) {
    if (!/^\+?[\d\s()-]{9,22}$/.test(draft.phone)) fieldErrors.phone = "Укажите телефон для связи";
    if (draft.method !== "PICKUP") {
      if (draft.fullName.trim().split(/\s+/).length < 2) fieldErrors.fullName = "Укажите фамилию и имя получателя";
      if (!draft.city.trim()) fieldErrors.city = "Укажите населённый пункт";
      if (!draft.office.trim()) fieldErrors.office = "Укажите номер или название пункта";
      if (draft.method === "EUROPOST" && !draft.officeAddress?.trim()) fieldErrors.officeAddress = "Укажите адрес пункта выдачи";
      if (draft.method === "BELPOST" && !/^\d{6}$/.test(draft.postalCode)) fieldErrors.postalCode = "Укажите шестизначный индекс";
    }
  }
  const validPhone = /^\+?[\d\s()-]{9,22}$/.test(draft.phone);
  const validRecipient =
    draft.method === "PICKUP" ||
    Boolean(
      draft.fullName.trim().split(/\s+/).length >= 2 &&
        draft.city.trim() &&
        draft.office.trim() &&
        (draft.method !== "EUROPOST" || draft.officeAddress?.trim()) &&
        (draft.method !== "BELPOST" || /^\d{6}$/.test(draft.postalCode)),
    );
  const methodEnabled = draft.method === "PICKUP" || Boolean(settings?.carriers[draft.method]?.enabled);
  const total = (lease?.items || selection).reduce((s, i) => s + i.priceMinor, 0);
  return (
    <div className="page narrow checkout-page">
      <ol className="checkout-progress" aria-label="Этапы оформления">{["Получение", "Данные", "Подтверждение"].map((label, i) => <li key={label} aria-current={i === step ? "step" : undefined} className={i <= step ? "reached" : ""}><span>{i+1}</span>{label}</li>)}</ol>
      <h1 ref={heading} tabIndex={-1}>
        {["Как получить вещи?", "Данные для получения", "Всё верно?"][step]}
      </h1>
      <ErrorBox error={error || draftState.error} />
      {!methodEnabled && !demo && <div className="notice" role="status"><h2>Этот способ сейчас недоступен</h2><p>Выберите самовывоз или другой доступный способ. Введённые данные сохранятся.</p><Button secondary onClick={changeReceiving}>Изменить получение</Button></div>}
      {pending && (
        <div className="notice">
          <h2>Проверяем результат оформления</h2>
          <p>
            Не удалось получить подтверждение. Проверьте результат перед новым оформлением — повторная проверка не создаст вторую бронь.
          </p>
          <Button onClick={recover} disabled={busy}>
            Проверить результат
          </Button>
          <Button secondary onClick={submit} disabled={busy || !lease || offline}>Повторить это подтверждение</Button>
          <p className="small-text">Повтор использует тот же ключ операции и не создаёт второе обращение.</p>
        </div>
      )}
      {step === 0 && (
        <>
          <p className="muted">Выберите удобный способ</p>
          <div className="delivery-options">
            {(["PICKUP", "EUROPOST", "BELPOST"] as Method[]).map((method) => {
              const enabled =
                method === "PICKUP" || settings?.carriers[method]?.enabled;
              return (
                <label
                  key={method}
                  className={`delivery-option ${draft.method === method ? "selected" : ""} ${!enabled ? "disabled" : ""}`}
                >
                  <div>
                    <Icon name={method === "PICKUP" ? "pin" : "box"} />
                    <strong>{method === "PICKUP" ? "Забронировать в магазине" : method === "EUROPOST" ? "Оформить доставку" : methodNames[method]}</strong>
                    <input
                      type="radio"
                      name="method"
                      checked={draft.method === method}
                      disabled={!enabled}
                      onChange={() => set("method", method)}
                    />
                  </div>
                  <p>
                    {method === "PICKUP"
                      ? guide.pickupSummary
                      : enabled
                        ? method === "EUROPOST" ? guide.shippingSummary : "В отделение · условия до отправки"
                        : "Способ пока не подключён магазином"}
                  </p>
                </label>
              );
            })}
          </div>
          <section className="detail-section">
            <h2>
              {draft.method === "PICKUP"
                ? "Бесплатная бронь"
                : "Отправка в пункт выдачи"}
            </h2>
            <p>
              {draft.method === "PICKUP"
                ? guide.pickup : guide.shipping}
            </p>
            <p className="muted">
              {draft.method === "PICKUP"
                ? settings?.address
                : guide.dispatch}
            </p>
          </section>
          <Summary label="Вещи">{money(total)}</Summary>
          <div className="bottom-action">
            <Button onClick={() => setStep(1)}>Указать контакт</Button>
          </div>
        </>
      )}
      {step === 1 && (
        <form
          className="form-stack"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault(); setAttempted(true);
            if (validPhone && validRecipient) acquire();
            else requestAnimationFrame(()=> document.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus());
          }}
        >
          <div className="receiving-summary"><Icon name={draft.method === "PICKUP" ? "pin" : "box"} /><div><strong>{draft.method === "PICKUP" ? "Бронь с примеркой" : "Доставка в пункт выдачи"}</strong><p className="small-text">{draft.method === "PICKUP" ? settings?.address : guide.shippingSummary}</p></div></div>
          {demo && <p className="small-text">Тестовые контакты можно менять. Они хранятся до перезагрузки.</p>}

          <Field
            label="Телефон"
            hint="Для связи по обращению. Telegram не передаёт номер автоматически."
            type="tel"
            autoComplete="tel"
            required
            value={draft.phone}
            onChange={(e) => set("phone", e.target.value)}
            placeholder="+375 29 000 00 00"
            error={draft.phone && !validPhone ? "Проверьте номер телефона" : fieldErrors.phone}
          />
          {!demo && <Button secondary onClick={contact}>
            Поделиться контактом Telegram
          </Button>}
          {draft.method !== "PICKUP" && (
            <>
              <Field
                label="Фамилия, имя, отчество получателя"
                autoComplete="name"
                required
                value={draft.fullName}
                onChange={(e) => set("fullName", e.target.value)}
                hint="Получатель может отличаться от владельца Telegram."
                error={draft.fullName && draft.fullName.trim().split(/\s+/).length < 2 ? "Укажите фамилию и имя получателя" : fieldErrors.fullName}
              />
              <Field
                label="Населённый пункт"
                required
                error={fieldErrors.city} value={draft.city}
                onChange={(e) => set("city", e.target.value)}
              />
              <Field
                label={draft.method === "EUROPOST" ? "Номер или название пункта выдачи" : "Номер и адрес отделения"}
                required
                error={fieldErrors.office} value={draft.office}
                onChange={(e) => set("office", e.target.value)}
                hint="Сотрудник проверит пункт выдачи перед отправкой."
              />
              {draft.method === "EUROPOST" && <Field label="Адрес пункта выдачи" required error={fieldErrors.officeAddress} value={draft.officeAddress || ""} onChange={e => set("officeAddress", e.target.value)} hint="Улица и дом пункта выдачи, не домашний адрес покупателя." />}
              <Field
                label={
                  draft.method === "BELPOST"
                    ? "Индекс отделения"
                    : "Индекс, если известен"
                }
                inputMode="numeric"
                pattern={draft.method === "BELPOST" ? "[0-9]{6}" : undefined}
                required={draft.method === "BELPOST"}
                error={fieldErrors.postalCode} value={draft.postalCode}
                onChange={(e) => set("postalCode", e.target.value)}
              />
              <a
                className="external-link"
                href={
                  draft.method === "BELPOST"
                    ? "https://belpost.by"
                    : "https://evropochta.by"
                }
                target="_blank"
                rel="noreferrer"
              >
                Проверить отделение на сайте почты ↗
              </a>
            </>
          )}
          <Textarea
            label="Комментарий магазину, необязательно"
            value={draft.comment}
            onChange={(v) => set("comment", v)}
          />
          <div className="recipient-preferences">
            <label className="check-row"><input type="checkbox" checked={draftState.saveRecipient} disabled={draftState.clearing} onChange={e=>session.setSaveRecipient(e.target.checked)} /><span>Сохранить данные для следующих обращений<small>После оформления подставим телефон и последнего получателя. Можно исправить или очистить. Это не рекламная подписка.</small></span></label>
            <button type="button" className="text-link" disabled={draftState.clearing || busy} onClick={()=>session.clear().then(()=>toast("Данные получателя и черновик очищены")).catch(setError)}>Очистить сохранённые данные</button>
          </div>
          <p className="draft-status small-text" role="status">{{idle:"",saving:"Сохраняем…",saved:"Сохранено",failed:"Не удалось сохранить. Ввод остаётся в форме."}[draftState.status]}</p>
          {draftState.status === "failed" && <Button secondary onClick={()=>session.flush().catch(setError)}>Повторить сохранение</Button>}
          <p className="small-text">
            Данные используются для исполнения обращения.{" "}
            <button
              type="button"
              className="text-link"
              onClick={() => go("/about")}
            >
              Политика обработки данных
            </button>
          </p>
          <div className="button-stack">
            <Button
              type="submit"
              disabled={
                busy || draftState.clearing ||
                pending ||
                !methodEnabled || offline ||
                !selectionIds.length
              }
            >
              {busy ? "Проверяем наличие…" : "Проверить и продолжить"}
            </Button>
            <Button secondary onClick={changeReceiving}>
              Изменить получение
            </Button>
          </div>
        </form>
      )}
      {conflicts.length > 0 && (
        <section className="notice">
          <h2>Часть вещей уже недоступна</h2>
          {conflicts.map((c) => (
            <p key={c.itemId}>
              {selection.find((i) => i.id === c.itemId)?.title || "Вещь"} ·{" "}
              {c.reason}
            </p>
          ))}
          <p>Новый состав оформится только после вашего решения.</p>
          <Button
            disabled={busy || !availableIds.length}
            onClick={() =>
              setSelection(availableIds).then(() => acquire(availableIds))
            }
          >
            Оформить доступные: {itemCount(availableIds.length)}
          </Button>
          <Button secondary onClick={() => go("/selection")}>
            Вернуться к подборке
          </Button>
        </section>
      )}
      {step === 2 && (
        <>
          <div className="notice">
            <Icon name="clock" />
            <p>
              {demo ? "Перед оформлением вы проверите актуальный состав, цены и особенности вещей." : <>Удерживаем вещи до {date(lease?.expiresAt)}. После истечения перепроверим наличие.</>}
            </p>
          </div>
          <div className="compact-lines">
            {(lease?.items || selection).map((i) => (
              <div className="item-row" key={i.id}>
                <Photo media={i.media.find((photo) => photo.role !== "MEASUREMENT")} alt={i.title} />
                <div>
                  <strong>{i.title}</strong>
                  <p className="muted">
                    {[productSize(i.attributes), i.sku].filter(Boolean).join(" · ")}
                  </p>
                  <Defect item={i} expanded />
                  <strong>{money(i.priceMinor)}</strong>
                </div>
              </div>
            ))}
          </div>
          <section className="detail-section">
            <h2>{methodNames[draft.method]}</h2>
            {<p>{draft.phone}</p>}
            {draft.method === "PICKUP" ? (
              <p>{displayedSettings?.address}<MapLink address={displayedSettings?.address} /></p>
            ) : (
              <>
                <p>{draft.fullName}</p>
                {<p>
                  {draft.city}, {draft.office}{draft.officeAddress ? `, ${draft.officeAddress}` : ""}
                  {draft.postalCode ? `, ${draft.postalCode}` : ""}
                </p>}
              </>
            )}
          </section>
          <section className="detail-section">
            <h2>Бронь и заявка бесплатны</h2>
            <p>
              {draft.method === "PICKUP"
                ? guide.pickup : guide.shipping}
            </p>
            {draft.method !== "PICKUP" && displayedSettings?.carriers[draft.method]?.terms !== guide.shipping && (
              <p className="muted">{displayedSettings?.carriers[draft.method]?.terms}</p>
            )}
            <button className="text-link" onClick={() => go("/about")}>
              Правила магазина и обработки данных
            </button>
          </section>
          <Summary label="Стоимость вещей">{money(total)}</Summary>
          <div className="bottom-action button-stack">
            <Button
              disabled={busy || pending || offline || !methodEnabled || (!demo && !settings?.acceptingOrders)}
              onClick={submit}
            >
              {busy
                ? "Сохраняем…"
                : demo ? (draft.method === "PICKUP" ? "Создать тестовую бронь" : "Создать тестовую заявку") : draft.method === "PICKUP"
                  ? "Подтвердить бесплатную бронь"
                  : "Оформить заявку на отправку"}
            </Button>
            <Button
              secondary
              disabled={busy || pending}
              onClick={async () => {
                if (lease)
                  await api(`/checkout/leases/${lease.id}`, {
                    method: "DELETE",
                  }).catch(setError);
                setLease(null);
                saveLocal(accountKey("checkout-lease"), null);
                setStep(1);
              }}
            >
              Изменить данные
            </Button>
            {!demo && !settings?.acceptingOrders && (
              <p>Магазин временно не принимает новые обращения.</p>
            )}
          </div>
        </>
      )}
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
            <Photo key={line.id} media={line.media?.find((photo) => photo.role !== "MEASUREMENT")} alt={line.title} />
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
function OrderPage({ id }: { id: string }) {
  const { settings, go, toast } = useApp();
  const {
    data: order,
    setData,
    error,
    loading,
    reload,
  } = useLoad<Order>(`/orders/${id}`);
  const [actionError, setActionError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [cancel, setCancel] = useState(false),
    [edit, setEdit] = useState(false),
    [code, setCode] = useState(false),
    [chosen, setChosen] = useState<string[]>([]),
    [recipient, setRecipient] = useState<Draft>(draftDefault);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", update);
    const timer = setInterval(update, 15000);
    return () => {
      document.removeEventListener("visibilitychange", update);
      clearInterval(timer);
    };
  }, [reload]);
  const act = async (path: string, body: unknown, method = "POST") => {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await command<Order>(path, body, method);
      setData(updated);
      setCancel(false);
      setEdit(false);
      toast("Изменения сохранены");
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };
  if (loading && !order) return <Loading />;
  if (!order)
    return (
      <div className="page">
        <ErrorBox error={error} retry={reload} />
      </div>
    );
  const canCancel = [
    "CHECKING",
    "AWAITING_CUSTOMER",
    "READY_FOR_PICKUP",
    "PREPARING",
    "DISPATCH_READY",
  ].includes(order.status);
  const canEdit =
    order.method !== "PICKUP" &&
    ["CHECKING", "PREPARING", "DISPATCH_READY"].includes(order.status);
  const next: Record<string, string> = {
    CHECKING: order.method === "PICKUP" ? "Вещи закреплены за вами. Дождитесь уведомления о готовности, прежде чем приезжать." : "Вещи закреплены за заявкой. Проверим их и свяжемся для согласования условий отправки.",
    READY_FOR_PICKUP:
      "Приходите в магазин и покажите сотруднику номер и код выдачи.",
    PREPARING: "Заявка передана владельцу. Он оформит и сдаст посылку вручную.",
    DISPATCH_READY:
      "Номер отслеживания получен. Посылка ещё в магазине; сообщим, когда передадим её перевозчику.",
    IN_FULFILLMENT: "Следите за посылкой на официальном сайте перевозчика.",
    AWAITING_CUSTOMER:
      "Магазин предложил изменение. Ознакомьтесь и примите решение до указанного срока.",
    EXPIRED: "Срок хранения закончился. Вещи вернутся в каталог после осмотра.",
    RETURNING:
      "Дождитесь возвращения посылки в магазин. Статус обновит сотрудник.",
    FULFILLED: "Получение отмечено. Если возник вопрос, свяжитесь с магазином.",
  };
  return (
    <div className="page narrow">
      <h1>
        {order.method === "PICKUP" ? "Бронь" : "Заявка"} №{order.number}
      </h1>
      <p className="muted">
        {methodNames[order.method]} · {date(order.createdAt)}
      </p>
      <section className="order-status">
        <span className="status-icon">
          <Icon
            name={
              order.status === "READY_FOR_PICKUP" ||
              order.status === "FULFILLED"
                ? "check"
                : "clock"
            }
            size={28}
          />
        </span>
        <h2>{statusNames[order.status] || order.status}</h2>
        {order.status === "READY_FOR_PICKUP" && (
          <strong>Храним до {date(order.pickupDeadline)}</strong>
        )}
        {order.status === "CHECKING" && (
          <strong>Проверим до {date(order.verifyBy)}</strong>
        )}
        {order.status === "PREPARING" && order.dispatchDeadline && (
          <strong>Сдача почте до {date(order.dispatchDeadline)}</strong>
        )}
        <p className="muted">{next[order.status]}</p>
      </section>
      <ErrorBox error={error || actionError} retry={reload} />
      {order.cancelRequested && (
        <div className="notice">
          <strong>Запрос передан сотруднику</strong>
          <p>
            До подтверждения отмены вещи остаются закреплены. Итог появится
            здесь.
          </p>
        </div>
      )}
      {order.proposal && order.status === "AWAITING_CUSTOMER" && (
        <section className="notice">
          <h2>Магазин предлагает изменение</h2>
          <p>{order.proposal.message}</p>
          <p>Ответьте до {date(order.proposal.respondBy)}</p>
          <div className="button-stack">
            <Button
              disabled={busy}
              onClick={() =>
                act(`/orders/${id}/proposal-response`, {
                  version: order.version,
                  accept: true,
                })
              }
            >
              Принять изменение
            </Button>
            <Button
              secondary
              disabled={busy}
              onClick={() =>
                act(`/orders/${id}/proposal-response`, {
                  version: order.version,
                  accept: false,
                })
              }
            >
              Не согласен, отменить
            </Button>
          </div>
        </section>
      )}
      <section className="detail-section">
        <h2>{order.method === "PICKUP" ? "Наш магазин" : "Получение"}</h2>
        {order.method === "PICKUP" ? (
          <>
            <p>{settings?.address || "Адрес укажет магазин"}</p>
            <p className="muted">
              <MapLink address={settings?.address} />
              График и исключения — в разделе «О магазине».
            </p>
          </>
        ) : (
          <>
            <p>{order.recipient?.fullName}</p>
            <p>
              {order.recipient?.city}, {order.recipient?.office}{order.recipient?.officeAddress ? `, ${order.recipient.officeAddress}` : ""}
            </p>
            {order.recipient?.postalCode && (
              <p>Индекс {order.recipient.postalCode}</p>
            )}
          </>
        )}
        <p>{order.recipient?.phone}</p>
      </section>
      {order.shipment && (
        <section className="detail-section">
          <h2>Посылка</h2>
          <p>
            <strong>
              {statusNames[order.shipment.status] || order.shipment.status}
            </strong>
          </p>
          <Summary label="Трек">{order.shipment.tracking}</Summary>
          <p className="small-text">
            Обновлено {date(order.shipment.updatedAt)} · {order.shipment.source}
          </p>
          <a
            className="button secondary"
            href={
              order.shipment.trackingUrl ||
              (order.method === "BELPOST"
                ? `https://belpost.by/Otslezhivaniye-otpravleniy?number=${encodeURIComponent(order.shipment.tracking)}`
                : `https://evropochta.by/track/?number=${encodeURIComponent(order.shipment.tracking)}`)
            }
            target="_blank"
            rel="noreferrer"
          >
            Официальное отслеживание ↗
          </a>
        </section>
      )}
      {Boolean(order.returnCases?.length) && (
        <section className="detail-section">
          <h2>Возврат и рассмотрение</h2>
          {order.returnCases?.map((ret) => (
            <div className="notice" key={ret.id}>
              <strong>
                {{
                  OPEN: "Возврат зарегистрирован",
                  RECEIVED: "Вещи приняты на осмотр",
                  CLOSED: "Решение принято",
                  REJECTED: "Рассмотрение завершено",
                }[ret.status] ||
                  statusNames[ret.status] ||
                  ret.status}
              </strong>
              <p className="small-text">
                Обращение о возврате от {date(ret.createdAt)}
              </p>
              {ret.receivedAt && (
                <p className="small-text">
                  Вещи приняты {date(ret.receivedAt)}
                </p>
              )}
              {ret.closedAt && (
                <p className="small-text">Решение от {date(ret.closedAt)}</p>
              )}
              {ret.decision && <p>{ret.decision}</p>}
              <p className="muted">
                История исходного получения сохранена. Подробности и дальнейшие
                действия уточняйте в магазине.
              </p>
            </div>
          ))}
        </section>
      )}
      <section className="detail-section">
        <h2>Ваши вещи</h2>
        <div className="item-list">
          {order.lines.map((line) => (
            <div className="item-row" key={line.id}>
              <Photo media={line.media?.find((photo) => photo.role !== "MEASUREMENT")} alt={line.title} />
              <div>
                <strong>{line.title}</strong>
                <Defect item={line} />
                <p className="muted">
                  {[productSize(line.attributes), line.sku].filter(Boolean).join(" · ")}
                </p>
                <strong>{money(line.priceMinor)}</strong>
                <p className="small-text">
                  {statusNames[line.outcome] || line.outcome}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <details className="document"><summary>Условия этого обращения</summary><p className="pre-wrap">{order.ruleSnapshot?.buyerGuide?.[order.method === "PICKUP" ? "pickup" : "shipping"] || "Состав и условия зафиксированы при оформлении. Подробности уточняйте в магазине по номеру обращения."}</p>{order.ruleSnapshot?.documents && order.ruleSnapshot.documentStatus === "APPROVED" && <p className="pre-wrap">{order.ruleSnapshot.documents[order.method === "PICKUP" ? "reservation" : "shipping"]}</p>}</details>
      <Summary label="Стоимость вещей">{money(order.totalMinor)}</Summary>
      <p className="muted">
        {order.method === "PICKUP"
          ? "Бронь бесплатна · расчёт в магазине"
          : settings?.buyerGuide?.shipping || defaultBuyerGuide.shipping}
      </p>
      <div className="button-stack section-space">
        {order.status === "READY_FOR_PICKUP" && order.pickupCode && (
          <Button onClick={() => setCode(true)}>Показать код выдачи</Button>
        )}
        {canEdit && (
          <Button
            secondary
            onClick={() => {
              setRecipient({
                ...draftDefault,
                ...order.recipient,
                method: order.method,
              });
              setEdit(true);
            }}
          >
            Изменить данные получателя
          </Button>
        )}
        {canCancel && (
          <Button
            secondary
            onClick={() => {
              setChosen(order.lines.filter(activeLine).map((l) => l.id));
              setCancel(true);
            }}
          >
            Отказаться от части или отменить
          </Button>
        )}
        <Button
          secondary
          onClick={() => {
            if (settings?.telegramUsername)
              openTelegram(settings.telegramUsername);
            else go("/support");
          }}
        >
          Связаться с магазином
        </Button>
        <Copy
          value={String(order.number)}
          label="Скопировать номер обращения"
        />
        <Button ghost onClick={() => go("/about")}>
          Правила возврата товаров
        </Button>
      </div>
      {code && (
        <Sheet title="Код выдачи" onClose={() => setCode(false)}>
          <div className="pickup-code">{order.pickupCode}</div>
          <p>
            Покажите код сотруднику магазина. Он относится только к обращению №
            {order.number} и погасится после выдачи.
          </p>
        </Sheet>
      )}
      {cancel && (
        <Sheet title="Отказ от вещей" onClose={() => setCancel(false)}>
          <p>
            {order.status === "PREPARING" || order.status === "DISPATCH_READY"
              ? "Посылка готовится. Запрос проверит сотрудник до сдачи перевозчику."
              : "Выберите вещи, от которых хотите отказаться."}
          </p>
          {order.lines.filter(activeLine).map((line) => (
            <label className="check-row" key={line.id}>
              <input
                type="checkbox"
                checked={chosen.includes(line.id)}
                onChange={(e) =>
                  setChosen((v) =>
                    e.target.checked
                      ? [...v, line.id]
                      : v.filter((id) => id !== line.id),
                  )
                }
              />
              <span>
                {line.title}
                <small>{money(line.priceMinor)}</small>
              </span>
            </label>
          ))}
          <Summary label="Останется вещей на сумму">
            {money(
              order.lines
                .filter((l) => activeLine(l) && !chosen.includes(l.id))
                .reduce((s, l) => s + l.priceMinor, 0),
            )}
          </Summary>
          <ErrorBox error={actionError} />
          <Button
            disabled={!chosen.length || busy}
            onClick={() =>
              act(`/orders/${id}/cancel`, {
                version: order.version,
                lineIds: chosen,
              })
            }
          >
            {busy ? "Сохраняем…" : "Подтвердить отказ"}
          </Button>
        </Sheet>
      )}
      {edit && (
        <Sheet title="Данные получателя" onClose={() => setEdit(false)}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              act(
                `/orders/${id}/recipient`,
                { ...recipient, version: order.version },
                "PATCH",
              );
            }}
          >
            <Field
              label="Фамилия, имя, отчество"
              required
              value={recipient.fullName}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, fullName: e.target.value }))
              }
            />
            <Field
              label="Телефон"
              type="tel"
              required
              value={recipient.phone}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, phone: e.target.value }))
              }
            />
            <Field
              label="Населённый пункт"
              required
              value={recipient.city}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, city: e.target.value }))
              }
            />
            <Field
              label={order.method === "EUROPOST" ? "Номер или название пункта выдачи" : "Номер и адрес отделения"}
              required
              value={recipient.office}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, office: e.target.value }))
              }
            />
            {order.method === "EUROPOST" && <Field label="Адрес пункта выдачи" required value={recipient.officeAddress || ""} onChange={e => setRecipient(v => ({...v, officeAddress:e.target.value}))} />}
            <Field
              label="Индекс"
              value={recipient.postalCode}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, postalCode: e.target.value }))
              }
            />
            {order.status !== "CHECKING" && (
              <p>Изменение проверит сотрудник до передачи посылки.</p>
            )}
            <ErrorBox error={actionError} />
            <Button type="submit" disabled={busy}>
              Сохранить изменения
            </Button>
          </form>
        </Sheet>
      )}
    </div>
  );
}
function About() {
  const { settings, go, demo } = useApp();
  const [details, setDetails] = useState<"pickup"|"shipping"|null>(null);
  if (!settings) return <Loading />;
  const hours = storeHours(settings.calendar);
  const guide = { ...defaultBuyerGuide, ...settings.buyerGuide };
  const phone = settings.phone && settings.phoneIsTest === false && settings.phone.replace(/\D/g, "") !== "375337777777";
  return <div className="page narrow about-page">
    <section className="about-intro">
      <p className="eyebrow">Вещи · Минск</p>
      <h1>{settings.name}</h1>
      <p className="lead pre-wrap">{settings.about || `${settings.name} — магазин вещей в Минске. В основном у нас новые вещи: одежда, детские находки, сумки и аксессуары. Если есть дефект, отдельно показываем и описываем его в карточке.`}</p>
      <Button onClick={() => go("/catalog")}>Выбрать вещи</Button>
    </section>
    <section className="store-visit" aria-labelledby="visit-title">
      <div className="section-heading"><Icon name="pin"/><h2 id="visit-title">Заглядывайте на примерку</h2></div>
      <p className="visit-address">{settings.address || "Адрес уточняется"}</p>
      <p className="visit-hours">{hours.schedule}</p>
      <p className="small-text">{hours.status}</p>
      {hours.exceptions.slice(0,3).map(e=><p className="schedule-change" key={e.day}>{e.label}: {e.hours}</p>)}
      <MapLink address={settings.address} />
      <details className="hours-details"><summary>Подробный график</summary><dl className="details-list">{hours.days.map(day=><div key={day.day}><dt>{day.name}</dt><dd>{day.hours}</dd></div>)}</dl>{hours.exceptions.map(e=><p key={e.day}>{e.label}: {e.hours}</p>)}</details>
    </section>
    <section className="about-section">
      <p className="eyebrow">Бесплатная бронь</p><h2>Сначала примерьте</h2>
      <ol className="try-on-steps">{[["Выберите вещи", "Соберите подборку и подтвердите бронь."],["Дождитесь готовности", "Сотрудник найдёт и проверит каждую вещь."],["Приходите за своим", "Примерьте и оплатите только то, что подошло."]].map(([title,text],i)=><li key={title}><span>{i+1}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol>
      <p className="small-text">На примерке можно отказаться от части вещей. Точный срок брони появится после проверки.</p>
      <button className="text-link" onClick={()=>setDetails("pickup")}>Все условия бронирования</button>
    </section>
    <section className="about-section shipping-story">
      <div className="section-heading"><Icon name="box"/><h2>Удобнее с доставкой?</h2></div>
      <p>{guide.shippingSummary}. Укажите получателя и пункт выдачи — домашний адрес не нужен.</p>
      <p className="muted">Отправку оформляет сотрудник. Расходы и порядок оплаты согласуем с вами до передачи посылки.</p>
      <button className="text-link" onClick={()=>setDetails("shipping")}>Как устроена доставка</button>
    </section>
    <section className="about-section">
      <h2>Поможем с выбором и получением</h2><p>Есть вопрос о вещи, примерке или доставке? Если уже оформили обращение, подготовьте его номер — так мы быстрее разберёмся.</p>
      {settings.telegramUsername && !demo ? <Button secondary onClick={()=>openTelegram(settings.telegramUsername)}>Написать магазину</Button> : phone && !demo ? <a className="button secondary" href={`tel:${settings.phone}`}>Позвонить {settings.phone}</a> : <p className="small-text">{demo ? "Связь с магазином появится после подключения подтверждённого контакта поддержки." : "Контакт поддержки уточняется. Адрес и график посещения указаны выше."}</p>}
    </section>
    <footer className="store-footer">
      <h2>Сведения и правила</h2>
      {settings.seller && <p className="pre-wrap">{settings.seller}</p>}
      <details className="document"><summary>Возвраты и обращения</summary><p className="pre-wrap">{guide.returns}</p></details>
      <details className="document"><summary>Данные для получения</summary><p className="pre-wrap">{guide.privacy}</p></details>
      {settings.documentStatus === "APPROVED" ? Object.entries(settings.documents).map(([key,text])=><details className="document" key={key}><summary>{{privacy:"Обработка персональных данных",reservation:"Бронирование и получение",shipping:"Условия отправки",returns:"Правила возврата товаров"}[key] || key}</summary><p className="pre-wrap">{text}</p></details>) : <p className="small-text">Документы продавца готовятся к публикации. Приём реальных обращений откроется после проверки сведений и условий.</p>}
      <p className="small-text">Время Минска · цены в BYN</p>
    </footer>
    {details && <Sheet title={details === "pickup" ? "Бронь с примеркой" : "Доставка в пункт выдачи"} onClose={()=>setDetails(null)}><p className="pre-wrap">{guide[details]}</p><p className="pre-wrap">{details === "shipping" ? guide.dispatch : guide.cancellation}</p><Button secondary onClick={()=>setDetails(null)}>Понятно</Button></Sheet>}
  </div>;
}
function Support() {
  const { settings, go, demo } = useApp();
  const [orderNumber, setOrderNumber] = useState("");
  return (
    <div className="page narrow">
      <h1>Связаться с магазином</h1>
      <p className="lead">Поможем с вещами, получением и возвратом.</p>
      <section className="detail-section">
        <h2>Переписка в Telegram</h2>
        <p>
          Откроется личный чат с аккаунтом магазина. Укажите номер вашего
          обращения и вопрос; фотографии можно отправить в переписке.
        </p>
        {settings?.telegramUsername ? (
          <>
            <p className="muted">
              @{settings.telegramUsername.replace(/^@/, "")}
            </p>
            <Button onClick={() => openTelegram(settings.telegramUsername)}>
              Открыть чат магазина
            </Button>
          </>
        ) : (
          <p>Контакт поддержки уточняется.</p>
        )}
      </section>
      {!demo && <Field
        label="Номер обращения, если есть"
        value={orderNumber}
        onChange={(e) => setOrderNumber(e.target.value)}
      />
      }
      {orderNumber && <Copy value={orderNumber} label="Скопировать номер" />}
      {settings?.phone && settings.phoneIsTest === false && settings.phone.replace(/\D/g, "") !== "375337777777" && (
        <a className="button secondary" href={`tel:${settings.phone}`}>
          Позвонить {settings.phone}
        </a>
      )}
      <section className="detail-section">
        <h2>Возврат товара</h2>
        <p>
          Свяжитесь с магазином для согласования передачи вещи и рассмотрения
          требования. Правила и предусмотренные способы официального обращения
          указаны в документах продавца.
        </p>
        <Button ghost onClick={() => go("/about")}>
          Открыть документы магазина
        </Button>
      </section>
    </div>
  );
}
function Events() {
  const { user, go, toast } = useApp();
  const { data, error, loading, reload } = useLoad<{ events: Event[] }>(
    user ? "/me/events" : null,
  );
  const [actionError, setError] = useState<unknown>(null);
  return (
    <div className="page narrow">
      <h1>Уведомления и контакты</h1>
      <p className="muted">
        Только события по вашим обращениям. Сроки действуют независимо от
        доставки сообщения.
      </p>
      <ErrorBox error={error || actionError} retry={reload} />
      {loading ? (
        <Loading />
      ) : !data?.events.length ? (
        <Empty title="Пока нет новых событий">
          После оформления здесь появятся изменения статусов.
        </Empty>
      ) : (
        <div className="event-list">
          {data.events.map((event) => (
            <button
              key={event.id}
              className={`event-row ${!event.readAt ? "unread" : ""}`}
              onClick={() => {
                command(`/me/events/${event.id}/read`)
                  .then(() => {
                    reload();
                    if (event.orderId) go(`/orders/${event.orderId}`);
                  })
                  .catch(setError);
              }}
            >
              <span>
                <strong>
                  {event.message || statusNames[event.type] || event.type}
                </strong>
                <small>{date(event.createdAt)}</small>
              </span>
              <Icon name="next" size={18} />
            </button>
          ))}
        </div>
      )}
      {user && (
        <>
          <section className="detail-section">
            <h2>Сервисные сообщения бота</h2>
            <p>
              Можно разрешить Telegram-боту присылать статусы. Рекламной
              подписки нет.
            </p>
            <Button
              secondary
              onClick={() => {
                if (tg()?.requestWriteAccess)
                  tg()?.requestWriteAccess?.((allowed) => {
                    command(
                      "/me/contact-preference",
                      { allowBot: allowed },
                      "PATCH",
                    )
                      .then(() =>
                        toast(
                          allowed
                            ? "Сервисные уведомления включены"
                            : "Статусы остаются доступны в приложении",
                        ),
                      )
                      .catch(setError);
                  });
                else
                  command("/me/contact-preference", { allowBot: true }, "PATCH")
                    .then(() =>
                      toast(
                        "Канал включён. Бот сможет писать после разрешения в Telegram.",
                      ),
                    )
                    .catch(setError);
              }}
            >
              Разрешить сообщения бота
            </Button>
            <Button
              ghost
              onClick={() =>
                command("/me/contact-preference", { allowBot: false }, "PATCH")
                  .then(() => toast("Сообщения бота выключены"))
                  .catch(setError)
              }
            >
              Выключить сообщения бота
            </Button>
          </section>
          <section className="detail-section">
            <h2>Мои данные</h2>
            <p>
              Запрос на удаление рассмотрит владелец с учётом незавершённых
              обращений и необходимых сроков хранения.
            </p>
            <Button
              secondary
              onClick={() => {
                if (
                  window.confirm(
                    "Отправить запрос на удаление ваших персональных данных?",
                  )
                )
                  command("/me/deletion-request")
                    .then(() => toast("Запрос на удаление передан владельцу"))
                    .catch(setError);
              }}
            >
              Запросить удаление данных
            </Button>
          </section>
        </>
      )}
    </div>
  );
}
function Invite() {
  const { user, refreshUser, toast, go, demo } = useApp();
  const [token, setToken] = useState(""),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  if (demo) return <div className="page narrow"><Empty title="Вход сотрудников">Доступ команды открывается в приложении магазина после приглашения владельца.</Empty></div>;
  return (
    <div className="page narrow">
      <h1>Приглашение сотрудника</h1>
      <p>
        Приглашение действует только для Telegram-аккаунта, которому владелец
        назначил доступ.
      </p>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await command("/me/staff-invite", { token });
            await refreshUser();
            toast("Доступ сотрудника подтверждён");
            go("/staff/queue");
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Код приглашения"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          autoComplete="off"
        />
        <ErrorBox error={error} />
        <Button type="submit" disabled={!user || busy}>
          {busy ? "Проверяем…" : "Принять приглашение"}
        </Button>
        {!user && <p>Сначала откройте Mini App через Telegram.</p>}
      </form>
    </div>
  );
}

function Defect({ item, expanded = false }: { item: { hasDefect?: boolean; defectDescription?: string }; expanded?: boolean }) {
  return item.hasDefect ? <details className="defect-notice" open={expanded || undefined}><summary>Есть дефект — описание</summary><p className="pre-wrap">{item.defectDescription}</p></details> : null;
}

function MapLink({ address }: { address?: string }) {
  if (!address?.trim()) return null;
  const url = `https://yandex.by/maps/?text=${encodeURIComponent(address)}`;
  return <a className="text-link map-link" href={url} target="_blank" rel="noopener noreferrer" onClick={e => { if (tg()?.openLink) { e.preventDefault(); tg()?.openLink?.(url); } }}>Как добраться ↗</a>;
}
