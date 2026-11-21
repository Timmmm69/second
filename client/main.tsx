import {
  Component,
  StrictMode,
  Suspense,
  lazy,
  useCallback,
  useRef,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { api, command, readLocal, saveLocal } from "./api";
import { AppContext } from "./context";
import { tg } from "./telegram";
import { createAuthBootstrap } from "./auth-bootstrap";
import { Button, ErrorBox, Icon, Loading, Sheet } from "./ui";
import type { Category, Item, Settings, User, Role } from "./types";
import Buyer from "./buyer";
import "./style.css";
const Staff = lazy(() => import("./staff"));
const Owner = lazy(() => import("./owner"));

// A deployed version may remove a lazy chunk while an older Telegram WebView
// still holds the previous entry bundle. Reload at most once per minute.
window.addEventListener("vite:preloadError", (event) => {
  let retry = false;
  try {
    const key = "luchok:chunk-reload";
    const previous = Number(sessionStorage.getItem(key) || 0);
    if (!Number.isFinite(previous) || Date.now() - previous > 60_000) {
      sessionStorage.setItem(key, String(Date.now()));
      retry = true;
    }
  } catch {
    // Storage may be restricted in an embedded WebView. Use the error UI.
  }
  if (retry) {
    event.preventDefault();
    location.reload();
  }
});

class RouteErrorBoundary extends Component<
  { children: ReactNode; onCatalog: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page narrow" role="alert">
        <h1>Не удалось открыть раздел</h1>
        <p>Возможно, приложение обновилось. Перезагрузите страницу и попробуйте снова.</p>
        <div className="button-stack">
          <Button onClick={() => location.reload()}>Перезагрузить</Button>
          <Button secondary onClick={this.props.onCatalog}>В каталог</Button>
        </div>
      </div>
    );
  }
}
function miniAppRouteHint() {
  const query = new URLSearchParams(location.search);
  const start =
    query.get("tgWebAppStartParam") ||
    new URLSearchParams(tg()?.initData || "").get("start_param") ||
    "";
  const match =
    /^(item|order)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      start,
    );
  return match
    ? `/${match[1].toLowerCase() === "item" ? "items" : "orders"}/${match[2]}`
    : null;
}
function App() {
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current; if (!nav) return;
    const measure = () => { const height = nav.getBoundingClientRect().height; if (height > 0) document.documentElement.style.setProperty("--measured-nav-height", `${height}px`); };
    const observer = new ResizeObserver(measure);
    // Telegram safe-area updates change padding, not the content-box height.
    observer.observe(nav, { box: "border-box" });
    measure();
    return () => observer.disconnect();
  }, []);
  const [path, setPath] = useState(
      location.hash.slice(1) || miniAppRouteHint() || "/catalog",
    ),
    [user, setUser] = useState<User | null>(null),
    [dev, setDev] = useState(false),
    [authLoading, setAuthLoading] = useState(true),
    [authError, setAuthError] = useState<unknown>(null),
    [settings, setSettings] = useState<Settings | null>(null),
    [categories, setCategories] = useState<Category[]>([]),
    [selectionIds, setSelectionIds] = useState<string[]>(() =>
      readLocal("selection", []),
    ),
    [selection, setItems] = useState<Item[]>([]),
    [menu, setMenu] = useState(false),
    [toast, setToast] = useState(""),
    [offline, setOffline] = useState(!navigator.onLine),
    [sdkReady, setSdkReady] = useState(Boolean(tg()));
  const go = useCallback((to: string) => {
    if ((location.hash.slice(1) || "/catalog") === "/catalog")
      saveLocal("catalogScroll", window.scrollY);
    if (to !== location.hash.slice(1)) location.hash = to;
    setMenu(false);
  }, []);
  useEffect(() => {
    const script = document.getElementById("telegram-sdk");
    const ready = () => {
      if (tg()) setSdkReady(true);
    };
    script?.addEventListener("load", ready);
    let attempts = 0;
    const timer = setInterval(() => {
      ready();
      if (tg() || ++attempts > 50) clearInterval(timer);
    }, 100);
    return () => {
      script?.removeEventListener("load", ready);
      clearInterval(timer);
    };
  }, []);
  const authenticate = useRef(createAuthBootstrap<User>(
    (initData) => command("/auth/telegram", { initData }),
    () => api("/auth/me"),
  ));
  const refreshUser = useCallback(async () => {
    const data = await api<{ user: User | null; dev: boolean }>("/auth/me");
    setUser(data.user);
    setDev(data.dev);
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await authenticate.current(tg()?.initData);
        if (active) {
          setUser(result.user);
          setDev(result.dev);
          if (!location.hash) {
            const hint = miniAppRouteHint();
            if (hint) go(hint);
          }
        }
      } catch (e) {
        if (active) setAuthError(e);
      } finally {
        if (active) setAuthLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [go, sdkReady]);
  const refreshSettings = useCallback(async () => {
    setSettings(await api<Settings>("/settings"));
  }, []);
  const refreshCategories = useCallback(async () => {
    const service = path.startsWith("/staff") || path.startsWith("/owner");
    const route = service && (user?.role === "OWNER" || user?.role === "STAFF")
      ? "/staff/categories" : "/categories";
    setCategories(await api<Category[]>(route));
  }, [path, user?.role]);
  useEffect(() => {
    refreshCategories().catch(() => {});
    const refresh = () => {
      if (!document.hidden) {
        refreshCategories().catch(() => {});
        refreshSettings().catch(() => {});
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshCategories, refreshSettings]);
  useEffect(() => {
    refreshSettings().catch(setAuthError);
    const fn = () => {
      setPath(location.hash.slice(1) || "/catalog");
      window.scrollTo({ top: 0 });
    };
    const net = () => setOffline(!navigator.onLine);
    window.addEventListener("hashchange", fn);
    window.addEventListener("online", net);
    window.addEventListener("offline", net);
    return () => {
      window.removeEventListener("hashchange", fn);
      window.removeEventListener("online", net);
      window.removeEventListener("offline", net);
    };
  }, [refreshSettings]);
  useEffect(() => {
    const app = tg();
    if (!app) return;
    app.ready();
    app.expand();
    // Telegram shows its native confirmation when the user tries to close the Mini App.
    if (app.isVersionAtLeast?.("6.2")) app.enableClosingConfirmation?.();
    // Do not let content scrolling collapse the Telegram Mini App sheet.
    // Native header gestures remain under Telegram control.
    if (app.isVersionAtLeast?.("7.7")) app.disableVerticalSwipes?.();
    app.setHeaderColor?.("#ffffff");
    app.setBackgroundColor?.("#ffffff");
    app.setBottomBarColor?.("#ffffff");
    const insets = () => {
      document.documentElement.style.setProperty(
        "--tg-top",
        `${Math.max(app.safeAreaInset?.top || 0, app.contentSafeAreaInset?.top || 0)}px`,
      );
      document.documentElement.style.setProperty(
        "--tg-bottom",
        `${Math.max(app.safeAreaInset?.bottom || 0, app.contentSafeAreaInset?.bottom || 0)}px`,
      );
      if (app.viewportStableHeight)
        document.documentElement.style.setProperty(
          "--viewport-height",
          `${app.viewportStableHeight}px`,
        );
    };
    insets();
    for (const event of [
      "safeAreaChanged",
      "contentSafeAreaChanged",
      "viewportChanged",
    ])
      app.onEvent(event, insets);
    return () => {
      for (const event of [
        "safeAreaChanged",
        "contentSafeAreaChanged",
        "viewportChanged",
      ])
        app.offEvent(event, insets);
    };
  }, [sdkReady]);
  useEffect(() => {
    if (path !== "/catalog") return;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!shell) return;

    let gesture: { id: number; x: number; y: number; axis: "pending" | "pull" | "other" } | null = null;
    let settleTimer: number | undefined;
    const finish = () => {
      gesture = null;
      if (!shell.classList.contains("is-pulling")) return;
      shell.classList.remove("is-pulling");
      shell.classList.add("pull-settling");
      shell.style.setProperty("--pull-distance", "0px");
      shell.style.setProperty("--pull-reveal-opacity", "0");
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        shell.classList.remove("pull-settling");
        shell.style.removeProperty("--pull-distance");
        shell.style.removeProperty("--pull-reveal-opacity");
      }, 240);
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1 || window.scrollY > 1 ||
        document.body.classList.contains("keyboard-open") ||
        document.querySelector(".sheet-backdrop") ||
        (event.target instanceof Element && event.target.closest(
          ".bottom-nav, input, textarea, select, [contenteditable='true']",
        ))) return;
      window.clearTimeout(settleTimer);
      shell.classList.remove("pull-settling");
      const point = event.touches[0];
      gesture = { id: point.identifier, x: point.clientX, y: point.clientY, axis: "pending" };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || event.touches[0].identifier !== gesture.id) {
        finish();
        return;
      }
      const dx = event.touches[0].clientX - gesture.x;
      const dy = event.touches[0].clientY - gesture.y;
      if (gesture.axis === "pending" && Math.max(Math.abs(dx), Math.abs(dy)) > 10)
        gesture.axis = dy > 0 && dy > Math.abs(dx) * 1.15 ? "pull" : "other";
      if (gesture.axis !== "pull") return;
      if (window.scrollY > 1 || !event.cancelable) {
        finish();
        return;
      }
      event.preventDefault();
      const distance = Math.min(130, Math.max(0, (dy - 10) * 0.6));
      shell.classList.add("is-pulling");
      shell.style.setProperty("--pull-distance", `${distance}px`);
      // The hint only appears after a deliberate, longer pull.
      shell.style.setProperty("--pull-reveal-opacity", String(Math.min(1, Math.max(0, (distance - 65) / 25))));
    };
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", finish, { passive: true });
    window.addEventListener("touchcancel", finish, { passive: true });
    return () => {
      window.clearTimeout(settleTimer);
      for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"])
        window.removeEventListener(type, type === "touchstart" ? start : type === "touchmove" ? move : finish);
      shell.classList.remove("is-pulling", "pull-settling");
      shell.style.removeProperty("--pull-distance");
      shell.style.removeProperty("--pull-reveal-opacity");
    };
  }, [path]);
  useEffect(() => {
    const app = tg();
    if (!app) return;
    const root = [
      "/catalog",
      "/selection",
      "/orders",
      "/staff/queue",
      "/staff/items",
      "/staff/search",
      "/owner",
    ].includes(path);
    const back = () => {
      if (window.__veshiCloseSheet) {
        window.__veshiCloseSheet();
        return;
      }
      if (menu) {
        setMenu(false);
        return;
      }
      if (history.length > 1) history.back();
      else go("/catalog");
    };
    if (root && !menu) app.BackButton.hide();
    else app.BackButton.show();
    app.BackButton.onClick(back);
    return () => app.BackButton.offClick(back);
  }, [path, menu, go, sdkReady]);
  useEffect(() => {
    const app = tg();
    const viewport = window.visualViewport;
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    const keyboardThreshold = 80;
    let bridgeWidth = window.innerWidth;
    let staleTelegramViewport: { height?: number; stableHeight?: number } | null = null;
    const telegramViewportIsStale = () => {
      if (staleTelegramViewport && (app?.viewportHeight !== staleTelegramViewport.height ||
        app?.viewportStableHeight !== staleTelegramViewport.stableHeight)) staleTelegramViewport = null;
      return staleTelegramViewport !== null;
    };
    const mobile = () => coarsePointer.matches || ["android", "android_x", "ios"].includes(app?.platform ?? "");
    const editable = () => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
      if (active instanceof HTMLInputElement)
        return !active.disabled && !active.readOnly &&
          ["text", "search", "email", "url", "tel", "password", "number"].includes(active.type);
      return active instanceof HTMLElement && active.isContentEditable;
    };
    const browserHeight = () => Math.min(
      window.innerHeight,
      viewport?.scale === 1 && Math.abs(viewport.width - window.innerWidth) < 2
        ? viewport.height : window.innerHeight,
    );
    const visibleHeight = () => Math.min(
      browserHeight(),
      !telegramViewportIsStale() && app?.viewportHeight && app.viewportHeight > 0
        ? app.viewportHeight : window.innerHeight,
    );
    const landscape = () => {
      if (!mobile()) return window.innerWidth > window.innerHeight;
      if (screen.orientation?.type) return screen.orientation.type.startsWith("landscape");
      const legacy = (window as Window & { orientation?: number }).orientation;
      if (typeof legacy === "number") return Math.abs(legacy) === 90;
      return screen.width > screen.height;
    };
    let keyboardOpen = false;
    let heightBeforeKeyboard = visibleHeight();
    let physicalLandscape = landscape();
    let compactLandscape = physicalLandscape && window.innerHeight <= 500;
    let layoutWidth = window.innerWidth;
    let rotatedKeyboardHeight: number | null = null;
    let frame = 0;
    let closingTimer: number | undefined;
    const sync = () => {
      const nextLandscape = landscape();
      const orientationChanged = nextLandscape !== physicalLandscape;
      const widthChanged = Math.abs(window.innerWidth - layoutWidth) > 1;
      if (widthChanged) {
        // Rotation's layout resize and Telegram event can arrive separately.
        // Until the bridge catches up, use the new browser geometry directly.
        staleTelegramViewport = app && bridgeWidth !== window.innerWidth
          ? { height: app.viewportHeight, stableHeight: app.viewportStableHeight } : null;
        bridgeWidth = 0;
        if (keyboardOpen) rotatedKeyboardHeight = browserHeight();
        else heightBeforeKeyboard = visibleHeight();
      }
      const height = visibleHeight();
      const focused = editable();
      const shrunk = heightBeforeKeyboard - height > keyboardThreshold;
      // Android can dismiss its keyboard while the input keeps DOM focus.
      // Focus alone must not leave the navigation hidden afterwards.
      if (rotatedKeyboardHeight !== null) {
        // The old portrait baseline cannot describe a landscape keyboard.
        // Use the new layout width to pick the screen axes even before the
        // orientation event arrives. A near-full viewport signals dismissal.
        const shortSide = Math.min(screen.width, screen.height);
        const longSide = Math.max(screen.width, screen.height);
        const screenHeight = window.innerWidth > (shortSide + longSide) / 2 ? shortSide : longSide;
        const nearFullHeight = Math.abs(screenHeight - height) <= keyboardThreshold;
        rotatedKeyboardHeight = Math.min(rotatedKeyboardHeight, height);
        keyboardOpen = mobile() && !nearFullHeight &&
          height - rotatedKeyboardHeight <= keyboardThreshold && (focused || keyboardOpen);
        if (!keyboardOpen) heightBeforeKeyboard = height;
      } else keyboardOpen = mobile() && shrunk && (focused || keyboardOpen);
      if (!keyboardOpen) rotatedKeyboardHeight = null;
      if (focused || !keyboardOpen) {
        window.clearTimeout(closingTimer);
        closingTimer = undefined;
      } else if (closingTimer === undefined) {
        closingTimer = window.setTimeout(() => {
          closingTimer = undefined;
          if (!editable()) {
            // The Mini App itself may have been resized while typing. Do not
            // wait forever for an old viewport height after the input blurs.
            keyboardOpen = false;
            rotatedKeyboardHeight = null;
            heightBeforeKeyboard = visibleHeight();
            sync();
          }
        }, 700);
      }
      document.body.classList.toggle("keyboard-open", keyboardOpen);
      // A keyboard can make a portrait viewport wider than it is tall. Keep the
      // physical layout until the keyboard closes or the device really rotates.
      if (!keyboardOpen || orientationChanged || widthChanged)
        compactLandscape = nextLandscape && window.innerHeight <= 500;
      physicalLandscape = nextLandscape;
      layoutWidth = window.innerWidth;
      document.body.classList.toggle("compact-landscape", compactLandscape);
      if (!keyboardOpen && (!focused || height >= heightBeforeKeyboard)) {
        // Freeze both the baseline and the bottom gap through gradual keyboard
        // animation, including its first few pixels before the threshold.
        heightBeforeKeyboard = height;
        const visualBottom = viewport?.scale === 1
          ? viewport.offsetTop + viewport.height : window.innerHeight;
        // The bridge's stable height can lag behind an already expanded WebView.
        // Only the actual browser viewport may lift fixed bottom controls.
        const bottom = Math.min(window.innerHeight, visualBottom);
        document.documentElement.style.setProperty("--app-bottom-offset", `${Math.max(0, window.innerHeight - bottom)}px`);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => sync());
    };
    const focus = () => sync();
    const viewportChanged = () => {
      bridgeWidth = window.innerWidth;
      staleTelegramViewport = null;
      schedule();
    };
    sync();
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    screen.orientation?.addEventListener("change", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    app?.onEvent("viewportChanged", viewportChanged);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(closingTimer);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      screen.orientation?.removeEventListener("change", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      app?.offEvent("viewportChanged", viewportChanged);
      document.body.classList.remove("keyboard-open", "compact-landscape");
      document.documentElement.style.removeProperty("--app-bottom-offset");
    };
  }, [sdkReady]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const refreshSelection = useCallback(async () => {
    if (user) {
      const data = await api<{ itemIds: string[]; items: Item[] }>(
        "/me/selection",
      );
      setSelectionIds(data.itemIds);
      setItems(data.items);
      saveLocal("selection", data.itemIds);
    } else {
      const ids = readLocal<string[]>("selection", []);
      const fetched = await Promise.all(
        ids.map((id) => api<Item>(`/items/${id}`).catch(() => null)),
      );
      setSelectionIds(ids);
      setItems(fetched.filter((i): i is Item => i !== null));
    }
  }, [user]);
  useEffect(() => {
    if (!authLoading) refreshSelection().catch(() => {});
  }, [authLoading, refreshSelection]);
  const setSelection = useCallback(
    async (ids: string[]) => {
      const unique = [...new Set(ids)];
      if (user) {
        const data = await command<{ itemIds: string[]; items: Item[] }>(
          "/me/selection",
          { itemIds: unique },
          "PUT",
        );
        setSelectionIds(data.itemIds);
        setItems(data.items);
      } else {
        const fetched = await Promise.all(
          unique.map((id) => api<Item>(`/items/${id}`).catch(() => null)),
        );
        setSelectionIds(unique);
        setItems(fetched.filter((i): i is Item => i !== null));
      }
      saveLocal("selection", unique);
    },
    [user],
  );
  const authenticated = () => {
    if (user) return true;
    setMenu(true);
    setToast(
      "Для оформления откройте магазин через Telegram. Просмотр доступен без входа.",
    );
    return false;
  };
  const staff = path.startsWith("/staff") || path.startsWith("/owner");
  const rootPath = [
    "/catalog",
    "/selection",
    "/orders",
    "/staff/queue",
    "/staff/items",
    "/staff/search",
    "/owner",
  ].includes(path);
  const login = async (role: string) => {
    try {
      setAuthError(null);
      await command(import.meta.env.VITE_PUBLIC_DEMO === "1" ? "/demo/role" : "/auth/dev", { role });
      await refreshUser();
      setMenu(false);
      go(role === "BUYER" ? "/catalog" : role === "OWNER" ? "/owner" : "/staff/queue");
    } catch (e) {
      setAuthError(e);
    }
  };
  return (
    <AppContext.Provider
      value={{
        user,
        dev,
        demo: import.meta.env.VITE_PUBLIC_DEMO === "1",
        settings,
        categories,
        refreshCategories,
        refreshSettings,
        selection,
        selectionIds,
        setSelection,
        refreshSelection,
        go,
        path,
        refreshUser,
        toast: setToast,
        authenticated,
        offline,
      }}
    >
      <div className={`app-shell ${staff ? "service-shell" : ""}`}>
        {!staff && path === "/catalog" && (
          <p className="pull-secret" aria-hidden="true">Здесь ничего интересного🦄</p>
        )}
        <header className="app-header">
          <div className="header-start">
            {!rootPath && (
              <button
                className="icon-button"
                aria-label="Назад"
                onClick={() =>
                  history.length > 1 ? history.back() : go("/catalog")
                }
              >
                <Icon name="back" />
              </button>
            )}
            <button
              className="brand"
              onClick={() => go(staff ? "/staff/queue" : "/catalog")}
              aria-label={`${settings?.name || "Лучок"} — главная`}
            >
              {settings?.name || "Лучок"}
              {staff && <span className="mode-caption">Команда магазина</span>}
            </button>
          </div>
          <button
            className="icon-button"
            aria-label="Меню магазина"
            onClick={() => setMenu(true)}
          >
            <Icon name="menu" />
          </button>
        </header>
        {import.meta.env.VITE_PUBLIC_DEMO === "1" ? <aside className="demo-toolbar" aria-label="Управление демонстрацией">
          <p role="note">Демонстрация · все действия тестовые</p>
          <div className="demo-role-switch" aria-label="Режим демонстрации">
            {([["BUYER", "Покупатель"], ["STAFF", "Менеджер"], ["OWNER", "Владелец"]] as [Role,string][]).map(([role,label]) => <button key={role} aria-pressed={user?.role === role} onClick={() => login(role)}>{label}</button>)}
            <button className="demo-reset" onClick={async () => { if (!confirm("Сбросить ваши тестовые обращения и изменения магазина?")) return; try { await command("/demo/reset"); for (const key of Object.keys(localStorage)) if (key.startsWith("luchok-demo:")) localStorage.removeItem(key); location.hash = "/catalog"; location.reload(); } catch(e) { setAuthError(e); setMenu(true); } }}>Сбросить</button>
          </div>
        </aside> : dev && <aside className="preview-note" role="note">Локальная тестовая среда</aside>}
        {offline && (
          <div className="network-bar" role="status">
            Нет соединения. Оформление и выдача временно недоступны.
          </div>
        )}
        {authLoading ? (
          <Loading />
        ) : (
          <main id="main-content">
            <RouteErrorBoundary key={path} onCatalog={() => go("/catalog")}>
              <Suspense fallback={<Loading />}>
              {staff ? (
                user?.role === "STAFF" || user?.role === "OWNER" ? (
                  path.startsWith("/owner") ? (
                    user.role === "OWNER" ? (
                      <Owner />
                    ) : (
                      <ErrorBox
                        error={new Error("Этот раздел доступен владельцу")}
                      />
                    )
                  ) : (
                    <Staff />
                  )
                ) : (
                  <div className="page">
                    <ErrorBox
                      error={
                        new Error(
                          "Служебный раздел доступен сотрудникам магазина",
                        )
                      }
                    />
                    <Button onClick={() => go("/catalog")}>В каталог</Button>
                  </div>
                )
              ) : (
                <Buyer />
              )}
              </Suspense>
            </RouteErrorBoundary>
          </main>
        )}
        <nav
          ref={navRef}
          className="bottom-nav"
          aria-label={staff ? "Навигация сотрудника" : "Навигация покупателя"}
        >
          {(staff
            ? [
                ["/staff/queue", "orders", "Очередь"],
                ["/staff/items", "bag", "Вещи"],
                ["/staff/search", "search", "Найти"],
                ...(user?.role === "OWNER"
                  ? [["/owner", "settings", "Управление"]]
                  : []),
              ]
            : [
                ["/catalog", "search", "Каталог"],
                ["/selection", "bag", "Корзина"],
                ["/orders", "orders", "Мои обращения"],
              ]
          ).map(([to, icon, label]) => (
            <button
              key={to}
              className={
                path === to || (to === "/owner" && path.startsWith("/owner/")) || (to === "/orders" && path.startsWith("/orders/"))
                  ? "active"
                  : ""
              }
              onClick={() => go(to)}
              aria-current={path === to || (to === "/owner" && path.startsWith("/owner/")) ? "page" : undefined}
            >
              <span className="nav-icon">
                <Icon name={icon} />
                {to === "/selection" && selectionIds.length > 0 && (
                  <span className="count-badge">{selectionIds.length}</span>
                )}
              </span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {menu && (
        <Sheet title="Меню магазина" onClose={() => setMenu(false)}>
          <div className="menu-list">
            <button onClick={() => go("/about")}>
              <Icon name="pin" />О магазине и документы
              <Icon name="next" />
            </button>
            <button onClick={() => go("/support")}>
              <Icon name="person" />
              Связаться с магазином
              <Icon name="next" />
            </button>
            <button onClick={() => go("/events")}>
              <Icon name="bell" />
              Уведомления и контакты
              <Icon name="next" />
            </button>
            {user && (user.role === "STAFF" || user.role === "OWNER") && (
              <button onClick={() => go(staff ? "/catalog" : "/staff/queue")}>
                <Icon name="bag" />
                {staff ? "Режим покупателя" : "Режим сотрудника"}
                <Icon name="next" />
              </button>
            )}
            <button onClick={() => go("/invite")}>
              <Icon name="person" />
              Принять приглашение сотрудника
              <Icon name="next" />
            </button>
          </div>
          {!user && (
            <p className="muted">
              Каталог можно смотреть без телефона. Для бронирования откройте
              Mini App через Telegram.
            </p>
          )}
          {dev && (
            <section className="dev-login">
              <h3>Локальная проверка</h3>
              <p>Изолированная тестовая среда</p>
              <div className="button-stack">
                {[
                  ["BUYER", "Покупатель"],
                  ["STAFF", "Сотрудник"],
                  ["OWNER", "Владелец"],
                ].map(([role, label]) => (
                  <Button secondary key={role} onClick={() => login(role)}>
                    Войти: {label}
                  </Button>
                ))}
              </div>
            </section>
          )}
          <ErrorBox error={authError} />
        </Sheet>
      )}
    </AppContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
