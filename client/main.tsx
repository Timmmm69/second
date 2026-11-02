import {
  StrictMode,
  Suspense,
  lazy,
  useCallback,
  useRef,
  useEffect,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { api, command, readLocal, saveLocal } from "./api";
import { AppContext } from "./context";
import { tg } from "./telegram";
import { Button, ErrorBox, Icon, Loading, Sheet } from "./ui";
import type { Category, Item, Settings, User } from "./types";
import Buyer from "./buyer";
import "./style.css";
const Staff = lazy(() => import("./staff"));
const Owner = lazy(() => import("./owner"));
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
    const observer = new ResizeObserver(measure); observer.observe(nav); measure();
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
    [ownerCode, setOwnerCode] = useState(""),
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
  const refreshUser = useCallback(async () => {
    const data = await api<{ user: User | null; dev: boolean }>("/auth/me");
    setUser(data.user);
    setDev(data.dev);
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (tg()?.initData)
          await command("/auth/telegram", { initData: tg()?.initData });
        if (active) {
          await refreshUser();
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
  }, [refreshUser, sdkReady]);
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
    const focus = () => {
      const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement?.tagName || "",
      );
      document.body.classList.toggle("keyboard-open", isInput && (Boolean(tg()?.initData) || window.matchMedia("(pointer: coarse)").matches));
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focus);
    return () => {
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", focus);
    };
  }, []);
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
      await command("/auth/dev", { role });
      await refreshUser();
      setMenu(false);
      go(role === "BUYER" ? "/catalog" : "/staff/queue");
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
        ownerCode,
        setOwnerCode,
      }}
    >
      <div className={`app-shell ${staff ? "service-shell" : ""}`}>
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
        {(dev || import.meta.env.VITE_PUBLIC_DEMO === "1") && <aside className="preview-note" role="note">Просмотр с демонстрационным ассортиментом · реальные оформления отключены</aside>}
        {offline && (
          <div className="network-bar" role="status">
            Нет соединения. Оформление и выдача временно недоступны.
          </div>
        )}
        {authLoading ? (
          <Loading />
        ) : (
          <main id="main-content">
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
                ["/selection", "bag", "Подборка"],
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
