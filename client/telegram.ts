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
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred?: (type: "success" | "warning" | "error") => void;
    selectionChanged?: () => void;
  };
  requestContact?: (callback: (success: boolean) => void) => void;
  requestWriteAccess?: (callback: (success: boolean) => void) => void;
  openTelegramLink?: (url: string) => void;
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
export function openTelegram(username: string) {
  const safe = username.replace(/^@/, "");
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(safe)) return false;
  const url = `https://t.me/${safe}`;
  if (tg()?.openTelegramLink) tg()?.openTelegramLink?.(url);
  else window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/** Telegram haptics are entirely local and optional. */
export function tapFeedback(kind: "selection" | "success" | "light" = "light") {
  const feedback = tg()?.HapticFeedback;
  try {
    if (kind === "selection") feedback?.selectionChanged?.();
    else if (kind === "success") feedback?.notificationOccurred?.("success");
    else feedback?.impactOccurred?.("light");
  } catch { /* Older clients may not support haptics. */ }
}
export function openTelegramDraft(username: string, message: string) {
  const safe = username.replace(/^@/, "");
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(safe)) return false;
  const url = `https://t.me/${safe}?text=${encodeURIComponent(message)}`;
  if (tg()?.openTelegramLink) tg()?.openTelegramLink?.(url);
  else window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
export function shareTelegramItem(id: string, title: string, price: string) {
  const url = `${window.location.origin}/share/item/${encodeURIComponent(id)}`;
  const message = `${title} · ${price}. Посмотри эту находку в «Лучке».`;
  const target = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(message)}`;
  if (tg()?.openTelegramLink) tg()?.openTelegramLink?.(target);
  else window.open(target, "_blank", "noopener,noreferrer");
}
