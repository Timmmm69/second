export type Role = "BUYER" | "STAFF" | "OWNER";
export interface User {
  id: string;
  telegramId: string;
  role: Role;
}
export interface Media {
  id: string;
  url: string;
  variants?: Record<string, string>;
  width?: number;
  height?: number;
  role?: string;
  position?: number;
}
export interface Item {
  hasDefect?: boolean;
  defectDescription?: string;
  id: string;
  sku: string;
  title: string;
  category: string;
  priceMinor: number;
  publication: string;
  physical: string;
  version: number;
  attributes: Record<string, string | number>;
  measurements: Record<string, number>;
  media: Media[];
  available: boolean;
  storageLocation?: string;
}
export interface Category {
  sortOrder: number;
  archived: boolean;
  version: number;
  id: string;
  name: string;
  measurements: string[];
}
export interface Calendar {
  week: Record<string, [string, string] | null>;
  exceptions: Record<string, [string, string] | null>;
}
export interface Carrier {
  partialDelivery?: boolean;
  enabled: boolean;
  terms: string;
  contract?: string;
  codConfirmed?: boolean;
  returnsConfirmed?: boolean;
  paymentScheme?: string;
  returnsScheme?: string;
  verifiedAt?: string;
}
export interface Settings {
  buyerGuide?: import("../shared/buyer-guide").BuyerGuide;
  about?: string;
  phoneIsTest?: boolean;
  documentStatus?: "DRAFT" | "APPROVED";
  name: string;
  address: string;
  phone: string;
  telegramUsername: string;
  seller: string;
  documents: {
    privacy: string;
    reservation: string;
    shipping: string;
    returns: string;
  };
  calendar: Calendar;
  carriers: Record<"BELPOST" | "EUROPOST", Carrier>;
  acceptingOrders: boolean;
  version: number;
}
export type Method = "PICKUP" | "BELPOST" | "EUROPOST";
export interface Draft {
  method: Method;
  phone: string;
  fullName: string;
  city: string;
  office: string;
  officeAddress?: string;
  postalCode: string;
  comment: string;
}
export interface Line {
  hasDefect?: boolean;
  defectDescription?: string;
  id: string;
  itemId: string;
  title: string;
  sku: string;
  priceMinor: number;
  outcome: string;
  checked: boolean;
  media: Media[];
  attributes: Record<string, string | number>;
  storageLocation?: string;
}
export interface Shipment {
  id: string;
  tracking: string;
  status: string;
  source: string;
  updatedAt: string;
  trackingUrl?: string;
}
export interface Proposal {
  message: string;
  respondBy: string;
  lineIds: string[];
}
export interface Order {
  id: string;
  number: string | number;
  method: Method;
  status: string;
  reservationStatus: string;
  version: number;
  totalMinor: number;
  createdAt: string;
  verifyBy: string;
  readyAt?: string;
  pickupDeadline?: string;
  dispatchDeadline?: string;
  recipient: Draft;
  ruleSnapshot?: Settings;
  pickupCode?: string;
  lines: Line[];
  shipment?: Shipment;
  proposal?: Proposal;
  notes?: { note: string; createdAt: string }[];
  returnCases?: {
    id: string;
    status: string;
    createdAt: string;
    receivedAt?: string;
    closedAt?: string;
    decision?: string;
  }[];
  cancelRequested?:
    | boolean
    | { type: string; lineIds?: string[]; recipient?: Record<string, string> };
}
export interface Event {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  orderId?: string;
  readAt?: string;
}
export interface Issue {
  id: string;
  type?: string;
  message?: string;
  status?: string;
  entityId?: string;
  createdAt?: string;
  assignedTo?: string;
  kind?: string;
  itemId?: string;
  orderId?: string;
}
export interface Return {
  id: string;
  orderId: string;
  status: string;
  version: number;
  reason: string;
  note?: string;
  lines?: Line[];
  createdAt?: string;
}
export const methodNames: Record<Method, string> = {
  PICKUP: "Самовывоз",
  BELPOST: "Белпочта",
  EUROPOST: "Европочта",
};
export const statusNames: Record<string, string> = {
  CHECKING: "Проверяем наличие",
  READY_FOR_PICKUP: "Можно забирать",
  PREPARING: "Готовим к отправке",
  AWAITING_CUSTOMER: "Нужно ваше решение",
  DISPATCH_READY: "Оформлено, ещё не сдано",
  IN_FULFILLMENT: "Отправлено",
  HANDOVER: "Идёт выдача",
  FULFILLED: "Получено",
  CANCELLED: "Отменено",
  EXPIRED: "Срок истёк",
  RETURNING: "Возвращается",
  RETURNED: "Возвращено",
  CLOSED: "Завершено",
  REGISTERED: "Оформлено",
  ACCEPTED: "Принято почтой",
  IN_TRANSIT: "В пути",
  AT_OFFICE: "В отделении",
  DELIVERED: "Вручено",
  RETURN_REQUESTED: "Запрошен возврат",
  RETURN_IN_TRANSIT: "Возвращается",
  RETURN_RECEIVED: "Возврат получен",
  LOST_OR_DAMAGED: "Проблема с посылкой",
  RESERVED: "Закреплено",
  HANDED_OVER: "Выдано",
  RELEASE_PENDING: "Ожидает осмотра",
  SOLD: "Продано",
  INSPECTION: "На проверке",
  AVAILABLE: "В продаже",
  PICKED: "Собрано",
  PACKED: "Упаковано",
  INTAKE: "Приёмка",
  DRAFT: "Черновик",
  PUBLISHED: "Опубликовано",
  HIDDEN: "Скрыто",
  ARCHIVED: "Архив",
  OPEN: "Открыто",
  RECEIVED: "Получено для осмотра",
  RESOLVED: "Решение принято",
};
export const measurementNames: Record<string, string> = {
  chest: "Грудь, полуобхват",
  waist: "Талия, полуобхват",
  hips: "Бёдра, полуобхват",
  length: "Длина",
  sleeve: "Рукав",
  inseam: "Шаговый шов",
  rise: "Посадка",
  width: "Ширина",
  height: "Высота",
  depth: "Глубина",
  strap: "Длина ремня",
  shoulders: "Плечи",
};
export const money = (n: number) =>
  new Intl.NumberFormat("ru-BY", {
    style: "currency",
    currency: "BYN",
    currencyDisplay: "code",
  }).format((n || 0) / 100);
export const date = (s?: string) =>
  s
    ? new Intl.DateTimeFormat("ru-BY", {
        timeZone: "Europe/Minsk",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(s))
    : "—";

export const itemCount = (n: number) => `${n} ${n % 100 >= 11 && n % 100 <= 14 ? "вещей" : n % 10 === 1 ? "вещь" : n % 10 >= 2 && n % 10 <= 4 ? "вещи" : "вещей"}`;
