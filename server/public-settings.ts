import { config } from "./config.js";

type LaunchSettings = {
  acceptingOrders?: boolean;
  documentStatus?: string;
  phoneIsTest?: boolean;
  phone?: string;
  address?: string;
  seller?: string;
  telegramUsername?: string;
  documents?: Record<string, string>;
};

export function launchSettingsReady(settings: LaunchSettings) {
  return Boolean(
    settings.documentStatus === "APPROVED" && settings.phoneIsTest === false &&
    settings.phone?.trim() && settings.phone.replace(/\D/g, "") !== "375337777777" &&
    settings.address?.trim() && settings.seller?.trim() && settings.telegramUsername?.trim() &&
    ["privacy", "reservation", "shipping", "returns"].every(key => (settings.documents?.[key] ?? "").trim().length >= 20),
  );
}

export function orderingIssue(settings: LaunchSettings) {
  if (!settings.acceptingOrders) return "STORE_CLOSED";
  if (config.production && !launchSettingsReady(settings)) return "LAUNCH_SETTINGS";
  return null;
}

/** Customer-visible rules only: never expose carrier contracts or internal schemes. */
export function publicSettings(settings: Record<string, any>) {
  return {
    ...settings,
    acceptingOrders: !orderingIssue(settings),
    carriers: Object.fromEntries(Object.entries(settings.carriers as Record<string, any>).map(([key, carrier]) => [key, {enabled:carrier.enabled, terms:carrier.terms}])),
  };
}
