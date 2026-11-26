import { useState } from "react";
import { useApp } from "./context";
import { MapLink } from "./buyer-widgets";
import { Button, Icon, Loading, Sheet } from "./ui";
import { storeHours } from "../shared/store-hours";
import { defaultBuyerGuide } from "../shared/buyer-guide";
import { openTelegram } from "./telegram";

export default function About() {
  const { settings, go, demo } = useApp();
  const [details, setDetails] = useState<"pickup"|"shipping"|null>(null);
  if (!settings) return <Loading />;
  const hours = storeHours(settings.calendar);
  const guide = { ...defaultBuyerGuide, ...settings.buyerGuide };
  const phone = settings.phone && settings.phoneIsTest === false && settings.phone.replace(/\D/g, "") !== "375337777777";
  return <div className="page narrow about-page">
    <section className="about-intro">
      <p className="eyebrow">Вещи · Минск</p>
      <h1>{settings.name}</h1>
      <p className="lead pre-wrap">{settings.about || `${settings.name} — магазин вещей в Минске. В основном у нас новые вещи: одежда, детские находки, сумки и аксессуары. Если есть дефект, отдельно показываем и описываем его в карточке.`}</p>
      <Button onClick={() => go("/catalog")}>Выбрать вещи</Button>
    </section>
    <section className="store-visit" aria-labelledby="visit-title">
      <div className="section-heading"><Icon name="pin"/><h2 id="visit-title">Заглядывайте на примерку</h2></div>
      <p className="visit-address">{settings.address || "Адрес уточняется"}</p>
      <p className="visit-hours">{hours.schedule}</p>
      <p className="small-text">{hours.status}</p>
      {hours.exceptions.slice(0,3).map(e=><p className="schedule-change" key={e.day}>{e.label}: {e.hours}</p>)}
      <MapLink address={settings.address} />
      <details className="hours-details"><summary>Подробный график</summary><dl className="details-list">{hours.days.map(day=><div key={day.day}><dt>{day.name}</dt><dd>{day.hours}</dd></div>)}</dl>{hours.exceptions.map(e=><p key={e.day}>{e.label}: {e.hours}</p>)}</details>
    </section>
    <section className="about-section">
      <p className="eyebrow">Бесплатная бронь</p><h2>Сначала примерьте</h2>
      <ol className="try-on-steps">{[["Выберите вещи", "Соберите корзину и подтвердите бронь."],["Дождитесь готовности", "Сотрудник найдёт и проверит каждую вещь."],["Приходите за своим", "Примерьте и оплатите только то, что подошло."]].map(([title,text],i)=><li key={title}><span>{i+1}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol>
      <p className="small-text">На примерке можно отказаться от части вещей. Точный срок брони появится после проверки.</p>
      <button className="text-link" onClick={()=>setDetails("pickup")}>Все условия бронирования</button>
    </section>
    <section className="about-section shipping-story">
      <div className="section-heading"><Icon name="box"/><h2>Удобнее с доставкой?</h2></div>
      <p>{guide.shippingSummary}. Укажите получателя и пункт выдачи — домашний адрес не нужен.</p>
      <p className="muted">Отправку оформляет сотрудник. Расходы и порядок оплаты согласуем с вами до передачи посылки.</p>
      <button className="text-link" onClick={()=>setDetails("shipping")}>Как устроена доставка</button>
    </section>
    <section className="about-section">
      <h2>Поможем с выбором и получением</h2><p>Есть вопрос о вещи, примерке или доставке? Если уже оформили обращение, подготовьте его номер — так мы быстрее разберёмся.</p>
      {settings.telegramUsername && !demo ? <Button secondary onClick={()=>openTelegram(settings.telegramUsername)}>Написать магазину</Button> : phone && !demo ? <a className="button secondary" href={`tel:${settings.phone}`}>Позвонить {settings.phone}</a> : <p className="small-text">{demo ? "Связь с магазином появится после подключения подтверждённого контакта поддержки." : "Контакт поддержки уточняется. Адрес и график посещения указаны выше."}</p>}
    </section>
    <footer className="store-footer">
      <h2>Сведения и правила</h2>
      {settings.seller && <p className="pre-wrap">{settings.seller}</p>}
      <details className="document"><summary>Возвраты и обращения</summary><p className="pre-wrap">{guide.returns}</p></details>
      <details className="document"><summary>Данные для получения</summary><p className="pre-wrap">{guide.privacy}</p></details>
      {settings.documentStatus === "APPROVED" ? Object.entries(settings.documents).map(([key,text])=><details className="document" key={key}><summary>{{privacy:"Обработка персональных данных",reservation:"Бронирование и получение",shipping:"Условия отправки",returns:"Правила возврата товаров"}[key] || key}</summary><p className="pre-wrap">{text}</p></details>) : <p className="small-text">Документы продавца готовятся к публикации. Приём реальных обращений откроется после проверки сведений и условий.</p>}
      <p className="small-text">Время Минска · цены в BYN</p>
    </footer>
    {details && <Sheet title={details === "pickup" ? "Бронь с примеркой" : "Доставка в пункт выдачи"} onClose={()=>setDetails(null)}><p className="pre-wrap">{guide[details]}</p><p className="pre-wrap">{details === "shipping" ? guide.dispatch : guide.cancellation}</p><Button secondary onClick={()=>setDetails(null)}>Понятно</Button></Sheet>}
  </div>;
}
