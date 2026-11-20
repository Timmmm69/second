export interface TelegramApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  setBottomBarColor?: (color: string) => void;
  safeAreaInset?: { top: number; bottom: number };
  contentSafeAreaInset?: { top: number; bottom: number };
  viewportStableHeight?: number;
  BackButton: {
    show: () => void;
    hide: () => void;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
  };
  onEvent: (name: string, callback: () => void) => void;
  offEvent: (name: string, callback: () => void) => void;
  requestContact?: (callback: (success: boolean) => void) => void;
  requestWriteAccess?: (callback: (success: boolean) => void) => void;
  openTelegramLink?: (url: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: "light" | "medium" | "heavy" | "soft" | "rigid") => void;
    selectionChanged: () => void;
    notificationOccurred: (type: "success" | "warning" | "error") => void;
  };
  openLink?: (url: string) => void;
  showScanQrPopup?: (
    params: { text?: string },
    callback: (text: string) => boolean,
  ) => void;
  closeScanQrPopup?: () => void;
  isVersionAtLeast?: (version: string) => boolean;
}
declare global {
  interface Window {
    Telegram?: { WebApp: TelegramApp };
    __veshiCloseSheet?: () => void;
  }
}
export const tg = () => import.meta.env.VITE_PUBLIC_DEMO === "1" ? undefined : window.Telegram?.WebApp;

export function openTelegramUrl(url: string): boolean {
  if (!url.startsWith("https://t.me/")) return false;
  if (tg()?.openTelegramLink) tg()?.openTelegramLink?.(url);
  else window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

export function openTelegram(username: string): boolean {
  const safe = username.replace(/^@/, "");
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(safe)) return false;
  return openTelegramUrl(`https://t.me/${safe}`);
}

/** Telegram supports a draft text parameter for a specific public username. */
export function telegramMessageUrl(username: string, text: string): string | null {
  const safe = username.replace(/^@/, "");
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(safe)) return null;
  const url = new URL(`https://t.me/${safe}`);
  url.searchParams.set("text", text);
  return url.toString();
}

export function openTelegramMessage(username: string, text: string): boolean {
  const url = telegramMessageUrl(username, text);
  return url ? openTelegramUrl(url) : false;
}

export function itemShareUrl(origin: string, itemId: string): string {
  return new URL(`/share/items/${encodeURIComponent(itemId)}`, origin).toString();
}

export function telegramItemShareUrl(url: string, title: string, formattedPrice: string): string {
  const share = new URL("https://t.me/share/url");
  share.searchParams.set("url", url);
  share.searchParams.set("text", `${title} · ${formattedPrice} · Лучок`);
  return share.toString();
}

export type HapticAction = "add" | "select" | "success";
export function haptic(action: HapticAction): void {
  try {
    const feedback = tg()?.HapticFeedback;
    if (action === "select") feedback?.selectionChanged();
    else if (action === "success") feedback?.notificationOccurred("success");
    else feedback?.impactOccurred("light");
  } catch {
    // Older Telegram clients may not implement the current SDK API.
  }
}
