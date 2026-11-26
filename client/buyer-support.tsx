import { useState } from "react";
import { useApp } from "./context";
import { Button, Copy, Field } from "./ui";
import { openTelegram } from "./telegram";

export default function Support() {
  const { settings, go, demo } = useApp();
  const [orderNumber, setOrderNumber] = useState("");
  return (
    <div className="page narrow">
      <h1>Связаться с магазином</h1>
      <p className="lead">Поможем с вещами, получением и возвратом.</p>
      <section className="detail-section">
        <h2>Переписка в Telegram</h2>
        <p>
          Откроется личный чат с аккаунтом магазина. Укажите номер вашего
          обращения и вопрос; фотографии можно отправить в переписке.
        </p>
        {settings?.telegramUsername ? (
          <>
            <p className="muted">
              @{settings.telegramUsername.replace(/^@/, "")}
            </p>
            <Button onClick={() => openTelegram(settings.telegramUsername)}>
              Открыть чат магазина
            </Button>
          </>
        ) : (
          <p>Контакт поддержки уточняется.</p>
        )}
      </section>
      {!demo && <Field
        label="Номер обращения, если есть"
        value={orderNumber}
        onChange={(e) => setOrderNumber(e.target.value)}
      />
      }
      {orderNumber && <Copy value={orderNumber} label="Скопировать номер" />}
      {settings?.phone && settings.phoneIsTest === false && settings.phone.replace(/\D/g, "") !== "375337777777" && (
        <a className="button secondary" href={`tel:${settings.phone}`}>
          Позвонить {settings.phone}
        </a>
      )}
      <section className="detail-section">
        <h2>Возврат товара</h2>
        <p>
          Свяжитесь с магазином для согласования передачи вещи и рассмотрения
          требования. Правила и предусмотренные способы официального обращения
          указаны в документах продавца.
        </p>
        <Button ghost onClick={() => go("/about")}>
          Открыть документы магазина
        </Button>
      </section>
    </div>
  );
}
