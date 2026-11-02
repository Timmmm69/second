import type { Calendar } from "../client/types";
const zone = "Europe/Minsk";
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year:"numeric",month:"2-digit",day:"2-digit" });
const labelFormat = new Intl.DateTimeFormat("ru-BY", { timeZone:zone, day:"numeric",month:"long" });
const weekdayNames = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
export function storeHours(calendar: Calendar, now = new Date()) {
  const today = dayFormat.format(now);
  const at = (day:string) => new Date(`${day}T12:00:00Z`);
  const hours = (day:string) => Object.hasOwn(calendar.exceptions,day) ? calendar.exceptions[day] : calendar.week[String(at(day).getUTCDay())] ?? null;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone:zone,hour:"2-digit",minute:"2-digit",hourCycle:"h23" }).format(now);
  const todayHours = hours(today);
  const uniform = Array.from({length:7},(_,i)=>calendar.week[String(i)] ?? null).every(h => JSON.stringify(h) === JSON.stringify(calendar.week["0"]));
  const schedule = uniform && calendar.week["0"] ? `Ежедневно ${calendar.week["0"].join("–")}` : "График по дням недели";
  let status = todayHours && time >= todayHours[0] && time < todayHours[1] ? `Сегодня до ${todayHours[1]}` : "Сегодня закрыто";
  if (todayHours && time < todayHours[0]) status = `Сегодня с ${todayHours[0]}`;
  else if (!todayHours || time >= todayHours[1]) {
    for(let i=1;i<=370;i++) {
      const day=new Date(at(today).getTime()+i*86400000).toISOString().slice(0,10), h=hours(day);
      if(h) {status += ` · откроемся ${labelFormat.format(at(day))} в ${h[0]}`;break;}
    }
  }
  const exceptions = Object.entries(calendar.exceptions).filter(([day])=>day>=today).sort(([a],[b])=>a.localeCompare(b)).map(([day,h])=>({day,label:labelFormat.format(at(day)),hours:h ? h.join("–") : "закрыто"}));
  return {schedule,status,exceptions,days:[1,2,3,4,5,6,0].map(day=>({day,name:weekdayNames[day],hours:calendar.week[String(day)]?.join("–") || "Выходной"}))};
}
