import type { PoolClient } from "pg";
import { assert } from "./errors.js";
import { audit } from "./inventory.js";
import { defaultBuyerGuide } from "../shared/buyer-guide.js";
export const draftDocuments = {
  reservation: `Бронирование и самовывоз

${defaultBuyerGuide.selection}

${defaultBuyerGuide.pickup}

Отмена

${defaultBuyerGuide.cancellation}

Сведения о продавце, адрес, график и доступные способы связи публикуются в разделе «О магазине». Бронь не требует предоплаты. Оплата выбранных покупок происходит в магазине.`,
  shipping: `Заявка на отправку

${defaultBuyerGuide.shipping}

${defaultBuyerGuide.dispatch}

До передачи посылки магазин согласует с получателем стоимость вещей, пересылки, упаковки, дополнительных услуг и комиссий, их плательщика и способ оплаты. Фиксированная стоимость и неподтверждённый порядок расчётов не устанавливаются.

Изменение и отмена

${defaultBuyerGuide.cancellation}

При задержке, повреждении или возврате посылки свяжитесь с магазином, укажите номер обращения и трек. Дальнейшие действия и расходы рассматриваются по обстоятельствам и применимым условиям перевозчика.`,
  returns: `Возвраты и обращения

${defaultBuyerGuide.returns}

Для рассмотрения сообщите, когда и каким способом была получена вещь, что произошло и какое решение вы запрашиваете. Сохраните подтверждение покупки и переписку. Магазин сообщает способ передачи вещи и результат рассмотрения через согласованный канал связи.

Эти объяснения не ограничивают права, предусмотренные законодательством Республики Беларусь. Сроки и основания рассматриваются для конкретного товара, способа приобретения и требования покупателя; универсальный запрет возвратов не устанавливается.`,
  privacy: `Обработка данных при оформлении

Для входа используется проверенный Telegram ID и доступные сведения аккаунта. Для исполнения брони обрабатываются выбранные вещи, телефон и комментарий. Для отправки дополнительно используются ФИО, населённый пункт и данные пункта выдачи; необходимые сведения передаются выбранному перевозчику для исполнения отправки.

${defaultBuyerGuide.privacy}

Доступ сотрудников ограничен их служебными правами. Запрос об обработке или удалении данных можно передать магазину; кнопка запроса удаления доступна в разделе уведомлений. Запрос рассматривается с учётом действующих обязательств и применимого законодательства. Сведения об операторе, основаниях обработки, получателях и сроках хранения должны быть проверены продавцом до утверждения документа.`,
};
export const initialStore = {
  name: "Лучок", address: "Минск, ул. Жореса Алфёрова, 9", phone: "+375337777777", phoneIsTest: true,
  telegramUsername: "", about: "Лучок — магазин вещей в Минске. В основном у нас новые вещи: одежда, детские находки, сумки и аксессуары. Если у вещи есть дефект, отдельно показываем и описываем его в карточке.",
  buyerGuide: defaultBuyerGuide,
  documentStatus: "DRAFT", documents: draftDocuments, acceptingOrders: false,
  calendar: { week: Object.fromEntries(Array.from({length:7},(_,i)=>[String(i),["10:00","20:00"]])), exceptions: {} },
};
/** Explicit one-time initialization; never called by startup, migrations or seed. */
export async function initializeStore(c: PoolClient) {
  const row = (await c.query("SELECT * FROM store_settings WHERE id=true FOR UPDATE")).rows[0];
  if (row.value.initializedLuchok) return { ...row.value, version: row.version };
  assert(row.version <= 2 && row.value.name === "Лучок" && !row.value.address && !row.value.phone && !row.value.seller && !row.value.acceptingOrders &&
    !(await c.query("SELECT 1 FROM items UNION ALL SELECT 1 FROM orders LIMIT 1")).rowCount,
    409, "STORE_NOT_EMPTY", "Начальные значения разрешены только в новой неизменённой базе. Настройте существующий магазин через админку");
  const value = { ...row.value, ...initialStore, initializedLuchok: true };
  await c.query("INSERT INTO rule_versions(settings_version,value) VALUES($1,$2)",[row.version,row.value]);
  await c.query("UPDATE store_settings SET value=$1,version=version+1,updated_at=now() WHERE id=true",[value]);
  await audit(c,null,"STORE_INITIALIZE","STORE","true");
  return { ...value, version: row.version+1 };
}
