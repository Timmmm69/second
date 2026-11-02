import { AppError } from "./errors.js";
export interface Calendar {
  week: Record<string, [string, string] | null>;
  exceptions: Record<string, [string, string] | null>;
}
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Minsk",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function localDate(at: Date): string {
  return dateFormatter.format(at);
}
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function hoursFor(
  day: string,
  calendar: Calendar,
): [string, string] | null {
  if (Object.hasOwn(calendar.exceptions, day)) return calendar.exceptions[day];
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return calendar.week[String(dow)] ?? null;
}
export function atLocal(day: string, time: string): Date {
  // Minsk has UTC+03 since 2011; use Intl to resolve the zone rather than relying on host timezone.
  const target = Date.parse(`${day}T${time}:00Z`);
  let guess = target;
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Minsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const local = fmt.format(new Date(guess)).replace(" ", "T") + "Z";
    guess += target - Date.parse(local);
  }
  return new Date(guess);
}
export function nextClosing(fromDay: string, calendar: Calendar): Date {
  for (let i = 0; i < 370; i++) {
    const d = addDays(fromDay, i),
      hours = hoursFor(d, calendar);
    if (hours) return atLocal(d, hours[1]);
  }
  throw new AppError(
    422,
    "CALENDAR_CLOSED",
    "Не найден рабочий день в календаре магазина",
  );
}
export function pickupDeadline(readyAt: Date, calendar: Calendar): Date {
  return nextClosing(addDays(localDate(readyAt), 1), calendar);
}
export function dispatchDeadline(verifiedAt: Date, calendar: Calendar): Date {
  return nextClosing(addDays(localDate(verifiedAt), 1), calendar);
}
export function addOpenHours(
  start: Date,
  hours: number,
  calendar: Calendar,
): Date {
  let remaining = hours * 3600000,
    day = localDate(start),
    cursor = start.getTime();
  for (let i = 0; i < 740; i++, day = addDays(day, 1)) {
    const interval = hoursFor(day, calendar);
    if (!interval) continue;
    const open = atLocal(day, interval[0]).getTime(),
      close = atLocal(day, interval[1]).getTime(),
      from = Math.max(open, cursor);
    if (close <= from) continue;
    const available = close - from;
    if (remaining <= available) return new Date(from + remaining);
    remaining -= available;
    cursor = close;
  }
  throw new AppError(
    422,
    "CALENDAR_CLOSED",
    "Не найдено достаточно открытых часов магазина",
  );
}
