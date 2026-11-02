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
