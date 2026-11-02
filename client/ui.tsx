import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
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
    close: <path d="m6 6 12 12M18 6 6 18" />,
    filter: (
      <>
        <path d="M3 6h18M3 12h18M3 18h18" />
        <circle cx="8" cy="6" r="2" fill="white" />
        <circle cx="16" cy="12" r="2" fill="white" />
        <circle cx="9" cy="18" r="2" fill="white" />
      </>
    ),
    check: <path d="m5 12 4 4L20 5" />,
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
export function Field({
  label,
  error,
  hint,
  ...props
}: {
  label: string;
  error?: string;
  hint?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  const automaticId = useId();
  const id = props.id || automaticId;
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input
        {...props}
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={
          error ? `${id}-error` : hint ? `${id}-hint` : undefined
        }
      />
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && (
        <span role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </label>
  );
}
export function Select({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <select {...props}>{children}</select>
    </label>
  );
}
export function Textarea({
  label,
  value,
  onChange,
  rows = 4,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
      />
      {hint && <small>{hint}</small>}
    </label>
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
        {err.status === 409
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
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const els = ref.current?.querySelectorAll<HTMLElement>(
          "button,input,select,textarea,a[href]",
        );
        if (!els?.length) return;
        const first = els[0],
          last = els[els.length - 1];
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
