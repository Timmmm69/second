import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import { ApiError, api } from "./api";
import type { Media } from "./types";
import { tg } from "./telegram";
export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    bag: (
      <>
        <path d="M5 7h14v14H5zM9 7V5a3 3 0 0 1 6 0v2" />
      </>
    ),
    orders: (
      <>
        <path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4" />
      </>
    ),
    back: <path d="m15 5-7 7 7 7" />,
    next: <path d="m9 5 7 7-7 7" />,
    down: <path d="m6 9 6 6 6-6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    filter: (
      <>
        <path d="M3 6h18M3 12h18M3 18h18" />
        <circle cx="8" cy="6" r="2" fill="white" />
        <circle cx="16" cy="12" r="2" fill="white" />
        <circle cx="9" cy="18" r="2" fill="white" />
      </>
    ),
    check: <path d="m4.5 13.5 5 5 10-13" />,
    pin: (
      <>
        <path d="M19 10c0 6-7 11-7 11S5 16 5 10a7 7 0 1 1 14 0Z" />
        <circle cx="12" cy="10" r="2" />
      </>
    ),
    box: (
      <>
        <path d="m3 7 9-5 9 5v11l-9 5-9-5ZM3 7l9 5 9-5M12 12v11M7 4l10 6" />
      </>
    ),
    plus: <path d="M12 4v16M4 12h16" />,
    menu: (
      <>
        <circle cx="4" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="20" cy="12" r="1" />
      </>
    ),
    bell: (
      <>
        <path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 21h4" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6l4 2" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M16 8V3H3v13h5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z" />
      </>
    ),
    person: (
      <>
        <circle cx="12" cy="7" r="4" />
        <path d="M4 22v-3a8 8 0 0 1 16 0v3" />
      </>
    ),
    photo: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m3 17 6-6 4 4 3-3 5 5" />
        <circle cx="16" cy="9" r="1" />
      </>
    ),
    alert: (
      <>
        <path d="m12 2 11 19H1Z" />
        <path d="M12 8v5M12 16v1" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7A9 9 0 1 0 21 15M20 2v6h-6" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.bag}
    </svg>
  );
}
export function Button({
  children,
  onClick,
  secondary = false,
  ghost = false,
  danger = false,
  disabled = false,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  secondary?: boolean;
  ghost?: boolean;
  danger?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`button ${secondary ? "secondary" : ""} ${ghost ? "ghost" : ""} ${danger ? "danger" : ""} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
type FieldLabel = { label: string; error?: string; hint?: string };

function FieldFrame({
  id,
  label,
  hint,
  error,
  children,
}: FieldLabel & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label id={`${id}-label`} htmlFor={id}>{label}</label>
      {children}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && (
        <span role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

function fieldDescription(id: string, hint?: string, error?: string, extra?: string) {
  return [extra, hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
}

export function Field({
  label,
  error,
  hint,
  id: providedId,
  className = "",
  ...props
}: FieldLabel & InputHTMLAttributes<HTMLInputElement>) {
  const automaticId = useId();
  const id = providedId || automaticId;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <input
        {...props}
        id={id}
        className={`field-control ${className}`}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={fieldDescription(id, hint, error, props["aria-describedby"])}
      />
    </FieldFrame>
  );
}

type SelectOption = { value: string; label: string };

function searchText(text: string) {
  return text.trim().toLocaleLowerCase("ru").replaceAll("ё", "е");
}

export function Select(props: {
  label: string;
  options: readonly SelectOption[];
  searchPlaceholder?: string;
  disabled?: boolean;
} & (
  | { multiple?: false; value: string; onValueChange: (value: string) => void }
  | { multiple: true; value: readonly string[]; onValueChange: (value: string[]) => void; allowCustom?: boolean }
)) {
  const { label, options, searchPlaceholder, disabled = false } = props;
  const id = useId();
  const listId = `${id}-list`;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const focusSearch = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const open = expanded && !disabled;
  const nativePopover = typeof HTMLElement.prototype.showPopover === "function";
  const selectedValues = props.multiple ? props.value : [props.value];
  const matches = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const selected = selectedValues.map((value) => options.find((option) => matches(option.value, value))?.label ?? value);
  const selectedLabel = selected.join(", ");
  const choices = props.multiple
    ? [...options, ...props.value.filter((value) => !options.some((option) => matches(option.value, value)))
      .map((value) => ({ value, label: value }))]
    : options;
  const filter = searchText(query);
  const customValue = query.trim();
  const custom = props.multiple && props.allowCustom && customValue &&
    !choices.some((option) => matches(option.value, customValue))
    ? { value: customValue, label: `Добавить «${customValue}»` }
    : null;
  const visible = searchPlaceholder && filter
    ? [...choices.filter((option) => searchText(option.label).includes(filter)), ...(custom ? [custom] : [])]
    : choices;
  const activeIndex = visible.findIndex((option) => option.value === activeValue);
  const activeId = open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;

  const close = useCallback(() => setExpanded(false), []);

  useLayoutEffect(() => {
    const anchor = trigger.current;
    const popup = panel.current;
    if (!anchor || !popup) return;
    if (!open) {
      if (nativePopover && popup.matches(":popover-open")) popup.hidePopover();
      return;
    }

    const viewport = window.visualViewport;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const gutter = 8;
      const gap = 6;
      const left = (viewport?.offsetLeft ?? 0) + gutter;
      const right = left + (viewport?.width ?? document.documentElement.clientWidth) - 2 * gutter;
      const top = (viewport?.offsetTop ?? 0) + gutter;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 2 * gutter;
      const width = Math.min(Math.max(rect.width, 200), right - left);
      const below = bottom - rect.bottom - gap;
      const above = rect.top - gap - top;
      const desired = Math.min(308, 14 + (searchPlaceholder ? 54 : 0) + Math.max(1, visible.length) * 44);
      const flip = below < desired && above > below;
      // Constrain the panel to one side so its top layer never covers the trigger.
      const height = Math.min(desired, Math.max(0, flip ? above : below));
      const edge = flip
        ? Math.max(top + height, Math.min(rect.top - gap, bottom))
        : Math.min(bottom - height, Math.max(rect.bottom + gap, top));
      popup.dataset.above = String(flip);
      Object.assign(popup.style, {
        left: `${Math.max(left, Math.min(rect.left, right - width))}px`,
        top: `${edge}px`,
        width: `${width}px`,
        maxHeight: `${Math.min(height, 308)}px`,
      });
    };
    place();
    if (nativePopover && !popup.matches(":popover-open")) popup.showPopover();
    if (focusSearch.current) {
      search.current?.focus({ preventScroll: true });
      focusSearch.current = false;
    }
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && popup.contains(event.target))) place();
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [open, visible.length, searchPlaceholder, nativePopover, close]);

  useLayoutEffect(() => {
    const rows = list.current;
    const option = rows?.children[activeIndex];
    if (!open || !rows || !option) return;
    const view = rows.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < view.top) rows.scrollTop += row.top - view.top;
    else if (row.bottom > view.bottom) rows.scrollTop += row.bottom - view.bottom;
  }, [open, activeIndex]);

  function show(key?: "ArrowDown" | "ArrowUp", keyboard = false) {
    setQuery("");
    setActiveValue(key
      ? choices.find((option) => selectedValues.some((value) => matches(value, option.value)))?.value ??
        (key === "ArrowUp" ? choices.at(-1)?.value : choices[0]?.value) ?? null
      : null);
    focusSearch.current = keyboard && Boolean(searchPlaceholder);
    setExpanded(true);
  }

  function closeFromTrigger() {
    trigger.current?.focus({ preventScroll: true });
    close();
  }

  function choose(option: SelectOption) {
    if (props.multiple) {
      const alreadySelected = props.value.some((value) => matches(value, option.value));
      props.onValueChange(alreadySelected
        ? props.value.filter((value) => !matches(value, option.value))
        : [...props.value, option.value]);
      if (query) {
        setQuery("");
        setActiveValue(null);
        if (list.current) list.current.scrollTop = 0;
      }
      return;
    }
    closeFromTrigger();
    if (option.value !== props.value) props.onValueChange(option.value);
  }

  function handleKey(event: ReactKeyboardEvent<HTMLElement>) {
    const key = event.key;
    const isSearch = event.target === search.current;
    if (key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeFromTrigger();
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        show(key, true);
        return;
      }
      if (!isSearch && searchPlaceholder) search.current?.focus({ preventScroll: true });
      const step = key === "ArrowDown" ? 1 : -1;
      const next = activeIndex < 0
        ? (step > 0 ? 0 : visible.length - 1)
        : Math.max(0, Math.min(visible.length - 1, activeIndex + step));
      setActiveValue(visible[next]?.value ?? null);
    } else if (open && !isSearch && (key === "Home" || key === "End")) {
      event.preventDefault();
      setActiveValue((key === "Home" ? visible[0] : visible.at(-1))?.value ?? null);
    } else if (open && (isSearch || (!searchPlaceholder && activeIndex >= 0)) && !event.nativeEvent.isComposing &&
      (key === "Enter" || (!isSearch && key === " "))) {
      event.preventDefault();
      const option = visible[activeIndex] ?? visible.find((row) => matches(row.value, customValue)) ?? visible[0];
      if (option) choose(option);
    }
  }

  return (
    <FieldFrame id={id} label={label}>
      <div
        className="select-control"
        ref={root}
        onKeyDown={handleKey}
        onBlur={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
        }}
      >
        <button
          ref={trigger}
          id={id}
          type="button"
          className="field-control select-trigger"
          role={searchPlaceholder ? undefined : "combobox"}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={searchPlaceholder ? undefined : activeId}
          aria-labelledby={`${id}-label ${id}-value`}
          disabled={disabled || (!props.multiple && !options.length)}
          onPointerDown={(event) => {
            if (open) event.preventDefault();
          }}
          onClick={(event) => {
            if (open) closeFromTrigger();
            else {
              event.currentTarget.focus({ preventScroll: true });
              show(undefined, event.detail === 0);
            }
          }}
        >
          <span id={`${id}-value`} data-placeholder={!selectedLabel ? "" : undefined}
            className={props.multiple ? "select-multiple-summary" : undefined} title={props.multiple ? selectedLabel : undefined}>
            {selectedLabel || "Выберите вариант"}
          </span>
          <Icon name="down" size={18} />
        </button>
        <div
          ref={panel}
          className="select-panel"
          popover={nativePopover ? "manual" : undefined}
          data-fallback={!nativePopover ? "" : undefined}
          data-open={open ? "" : undefined}
          aria-hidden={!open || undefined}
          inert={!open}
        >
          {searchPlaceholder && (
            <div className="select-search">
              <Icon name="search" size={18} />
              <input
                ref={search}
                type="search"
                role="combobox"
                className="field-control"
                aria-label={searchPlaceholder}
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listId}
                aria-activedescendant={activeId}
                placeholder={searchPlaceholder}
                maxLength={props.multiple && props.allowCustom ? 200 : undefined}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveValue(null);
                  if (list.current) list.current.scrollTop = 0;
                }}
              />
            </div>
          )}
          <div className="select-options" id={listId} role="listbox" aria-multiselectable={props.multiple || undefined} aria-labelledby={`${id}-label`} ref={list}>
            {visible.map((option, index) => {
              const checked = selectedValues.some((value) => matches(option.value, value));
              return (
                <div
                  key={option.value}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={checked}
                  data-active={index === activeIndex ? "" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <span>{option.label}</span>
                  {checked && <Icon name="check" size={18} />}
                </div>
              );
            })}
          </div>
          {!visible.length && <p className="select-empty" role="status">
            {filter ? "Ничего не найдено. Попробуйте другой запрос." : "Пока нет вариантов."}
          </p>}
        </div>
      </div>
    </FieldFrame>
  );
}

export function Textarea({
  label,
  value,
  onChange,
  rows = 4,
  hint,
  error,
  id: providedId,
  className = "",
  ...props
}: FieldLabel & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
}) {
  const automaticId = useId();
  const id = providedId || automaticId;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <textarea
        {...props}
        id={id}
        className={`field-control ${className}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={fieldDescription(id, hint, error, props["aria-describedby"])}
      />
    </FieldFrame>
  );
}

export function ErrorBox({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  if (!error) return null;
  const err = error as ApiError;
  return (
    <div role="alert" className="error-box">
      <strong>
        {err.status === 0 ? "Нет соединения" : err.status === 503 ? "Магазин временно недоступен" : err.status === 422 ? "Проверьте заполненные данные" : err.status === 409
          ? "Данные изменились"
          : err.status === 401
            ? "Откройте приложение через Telegram"
            : "Не удалось выполнить действие"}
      </strong>
      <p>{err.message || String(error)}</p>
      {Object.entries(err.fieldErrors || {}).map(([key, v]) => (
        <p key={key}>{Array.isArray(v) ? v.join(", ") : String(v)}</p>
      ))}
      {err.correlationId && <small>Код обращения: {err.correlationId}</small>}
      {retry && (
        <Button secondary onClick={retry}>
          Повторить
        </Button>
      )}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="bag" size={30} />
      </span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Loading({ cards = false }: { cards?: boolean }) {
  return (
    <div
      role="status"
      aria-label="Загрузка"
      className={cards ? "skeleton-grid" : "loading"}
    >
      {cards ? (
        Array.from({ length: 4 }, (_, i) => (
          <div key={i}>
            <div className="skeleton image" />
            <div className="skeleton line" />
            <div className="skeleton line short" />
          </div>
        ))
      ) : (
        <>
          <span className="spinner" />
          Загружаем…
        </>
      )}
    </div>
  );
}
export function Photo({
  media,
  alt,
  priority = false,
  className = "",
  contain = false,
}: {
  media?: Media;
  alt: string;
  priority?: boolean;
  className?: string;
  contain?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!media?.url)
    return (
      <div
        className={`photo-placeholder ${className}`}
        aria-label="Фотография не добавлена"
      >
        <Icon name="photo" size={32} />
      </div>
    );
  return (
    <div className={`photo-wrap ${contain ? "contain" : ""} ${className}`}>
      {failed ? (
        <button className="photo-retry" onClick={() => setFailed(false)}>
          <Icon name="refresh" />
          Повторить фото
        </button>
      ) : (
        <img
          src={media.url}
          srcSet={
            media.variants
              ? Object.entries(media.variants)
                  .map(([w, u]) => `${u} ${w}w`)
                  .join(", ")
              : undefined
          }
          sizes={
            contain
              ? "(max-width: 600px) 100vw, 560px"
              : "(max-width: 600px) 48vw, 280px"
          }
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          width={media.width || 480}
          height={media.height || 640}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
export function Sheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  useEffect(() => {
    const previousClose = window.__veshiCloseSheet;
    window.__veshiCloseSheet = close;
    tg()?.BackButton.show();
    const prev = document.activeElement as HTMLElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const backdrop = ref.current?.parentElement;
    const viewport = window.visualViewport;
    const syncViewport = () => {
      if (!backdrop || !viewport) return;
      const top = viewport.scale === 1 ? viewport.offsetTop : 0;
      const bottom = viewport.scale === 1 ? Math.max(0, window.innerHeight - viewport.height - top) : 0;
      backdrop.style.setProperty("--sheet-top", `${top}px`);
      backdrop.style.setProperty("--sheet-bottom", `${bottom}px`);
    };
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const elements = ref.current?.querySelectorAll<HTMLElement>(
          "button,input,select,textarea,a[href],summary,[tabindex]",
        );
        const tabbable = Array.from(elements ?? []).filter((element) =>
          element.tabIndex >= 0 && !element.matches(":disabled") &&
          !element.closest("[inert]") && element.getClientRects().length > 0,
        );
        if (!tabbable.length) return;
        const first = tabbable[0], last = tabbable[tabbable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = old;
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      document.removeEventListener("keydown", handler);
      window.__veshiCloseSheet = previousClose;
      if (
        !previousClose &&
        [
          "/catalog",
          "/selection",
          "/orders",
          "/staff/queue",
          "/staff/items",
          "/staff/search",
          "/owner",
        ].includes(location.hash.slice(1) || "/catalog")
      )
        tg()?.BackButton.hide();
      prev?.focus();
    };
  }, [close]);
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header className="sheet-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Закрыть"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Summary({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="summary-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}
export function useLoad<T>(path: string | null, refreshKey: unknown = 0) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(Boolean(path)),
    [version, reload] = useState(0);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, refreshKey, version]);
  const refresh = useCallback(() => reload((v) => v + 1), []);
  return { data, setData, error, loading, reload: refresh };
}
export function Copy({
  value,
  label = "Скопировать",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      ghost
      onClick={() => {
        if (!navigator.clipboard?.writeText) {
          window.prompt("Скопируйте текст", value);
          return;
        }
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => window.prompt("Скопируйте текст", value));
      }}
    >
      <Icon name="copy" size={18} />
      {copied ? "Скопировано" : label}
    </Button>
  );
}
