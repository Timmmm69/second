import { useEffect, useState } from "react";
import { command } from "./api";
import { useApp } from "./context";
import { activeLine } from "./buyer-order-data";
import { Defect, MapLink } from "./buyer-widgets";
import { Button, Copy, ErrorBox, Field, Icon, Loading, Photo, Sheet, Summary, useLoad } from "./ui";
import { date, methodNames, money, statusNames, type Draft, type Order } from "./types";
import { openTelegram } from "./telegram";
import { productSize } from "../shared/catalog-attributes.js";
import { defaultBuyerGuide } from "../shared/buyer-guide";

const draftDefault: Draft = {
  method: "PICKUP",
  phone: "",
  fullName: "",
  city: "",
  office: "",
  officeAddress: "",
  postalCode: "",
  comment: "",
};

export default function OrderPage({ id, onInventoryChange }: { id: string; onInventoryChange: () => void }) {
  const { settings, go, toast } = useApp();
  const {
    data: order,
    setData,
    error,
    loading,
    reload,
  } = useLoad<Order>(`/orders/${id}`);
  const [actionError, setActionError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [cancel, setCancel] = useState(false),
    [edit, setEdit] = useState(false),
    [code, setCode] = useState(false),
    [chosen, setChosen] = useState<string[]>([]),
    [recipient, setRecipient] = useState<Draft>(draftDefault);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", update);
    const timer = setInterval(update, 15000);
    return () => {
      document.removeEventListener("visibilitychange", update);
      clearInterval(timer);
    };
  }, [reload]);
  const act = async (path: string, body: unknown, method = "POST") => {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await command<Order>(path, body, method);
      onInventoryChange();
      setData(updated);
      setCancel(false);
      setEdit(false);
      toast("Изменения сохранены");
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  };
  if (loading && !order) return <Loading />;
  if (!order)
    return (
      <div className="page">
        <ErrorBox error={error} retry={reload} />
      </div>
    );
  const canCancel = [
    "CHECKING",
    "AWAITING_CUSTOMER",
    "READY_FOR_PICKUP",
    "PREPARING",
    "DISPATCH_READY",
  ].includes(order.status);
  const canEdit =
    order.method !== "PICKUP" &&
    ["CHECKING", "PREPARING", "DISPATCH_READY"].includes(order.status);
  const next: Record<string, string> = {
    CHECKING: "Заявка принята. Мы проверим наличие товаров и свяжемся с вами для подтверждения заказа.",
    READY_FOR_PICKUP:
      "Приходите в магазин и покажите сотруднику номер и код выдачи.",
    PREPARING: "Заявка передана владельцу. Он оформит и сдаст посылку вручную.",
    DISPATCH_READY:
      "Номер отслеживания получен. Посылка ещё в магазине; сообщим, когда передадим её перевозчику.",
    IN_FULFILLMENT: "Следите за посылкой на официальном сайте перевозчика.",
    AWAITING_CUSTOMER:
      "Магазин предложил изменение. Ознакомьтесь и примите решение до указанного срока.",
    EXPIRED: "Срок хранения закончился. Вещи вернутся в каталог после осмотра.",
    RETURNING:
      "Дождитесь возвращения посылки в магазин. Статус обновит сотрудник.",
    FULFILLED: "Получение отмечено. Если возник вопрос, свяжитесь с магазином.",
  };
  return (
    <div className="page narrow">
      <h1>
        {order.method === "PICKUP" ? "Бронь" : "Заявка"} №{order.number}
      </h1>
      <p className="muted">
        {methodNames[order.method]} · {date(order.createdAt)}
      </p>
      <section className="order-status">
        <span className="status-icon">
          <Icon
            name={
              order.status === "READY_FOR_PICKUP" ||
              order.status === "FULFILLED"
                ? "check"
                : "clock"
            }
            size={28}
          />
        </span>
        <h2>{statusNames[order.status] || order.status}</h2>
        {order.status === "READY_FOR_PICKUP" && (
          <strong>Храним до {date(order.pickupDeadline)}</strong>
        )}
        {order.status === "CHECKING" && (
          <strong>Проверим до {date(order.verifyBy)}</strong>
        )}
        {order.status === "PREPARING" && order.dispatchDeadline && (
          <strong>Сдача почте до {date(order.dispatchDeadline)}</strong>
        )}
        <p className="muted">{next[order.status]}</p>
      </section>
      <ErrorBox error={error || actionError} retry={reload} />
      {order.cancelRequested && (
        <div className="notice">
          <strong>Запрос передан сотруднику</strong>
          <p>
            До подтверждения отмены вещи остаются закреплены. Итог появится
            здесь.
          </p>
        </div>
      )}
      {order.proposal && order.status === "AWAITING_CUSTOMER" && (
        <section className="notice">
          <h2>Магазин предлагает изменение</h2>
          <p>{order.proposal.message}</p>
          <p>Ответьте до {date(order.proposal.respondBy)}</p>
          <div className="button-stack">
            <Button
              disabled={busy}
              onClick={() =>
                act(`/orders/${id}/proposal-response`, {
                  version: order.version,
                  accept: true,
                })
              }
            >
              Принять изменение
            </Button>
            <Button
              secondary
              disabled={busy}
              onClick={() =>
                act(`/orders/${id}/proposal-response`, {
                  version: order.version,
                  accept: false,
                })
              }
            >
              Не согласен, отменить
            </Button>
          </div>
        </section>
      )}
      <section className="detail-section">
        <h2>{order.method === "PICKUP" ? "Наш магазин" : "Получение"}</h2>
        {order.method === "PICKUP" ? (
          <>
            <p>{settings?.address || "Адрес укажет магазин"}</p>
            <p className="muted">
              <MapLink address={settings?.address} />
              График и исключения — в разделе «О магазине».
            </p>
          </>
        ) : (
          <>
            <p>{order.recipient?.fullName}</p>
            <p>
              {[order.recipient?.city, order.recipient?.office, order.recipient?.officeAddress].filter(Boolean).join(", ")}
            </p>
            {order.recipient?.postalCode && (
              <p>Индекс {order.recipient.postalCode}</p>
            )}
          </>
        )}
        <p>{order.recipient?.phone}</p>
      </section>
      {order.shipment && (
        <section className="detail-section">
          <h2>Посылка</h2>
          <p>
            <strong>
              {statusNames[order.shipment.status] || order.shipment.status}
            </strong>
          </p>
          <Summary label="Трек">{order.shipment.tracking}</Summary>
          <p className="small-text">
            Обновлено {date(order.shipment.updatedAt)} · {order.shipment.source}
          </p>
          <a
            className="button secondary"
            href={
              order.shipment.trackingUrl ||
              (order.method === "BELPOST"
                ? `https://belpost.by/Otslezhivaniye-otpravleniy?number=${encodeURIComponent(order.shipment.tracking)}`
                : `https://evropochta.by/track/?number=${encodeURIComponent(order.shipment.tracking)}`)
            }
            target="_blank"
            rel="noreferrer"
          >
            Официальное отслеживание ↗
          </a>
        </section>
      )}
      {Boolean(order.returnCases?.length) && (
        <section className="detail-section">
          <h2>Возврат и рассмотрение</h2>
          {order.returnCases?.map((ret) => (
            <div className="notice" key={ret.id}>
              <strong>
                {{
                  OPEN: "Возврат зарегистрирован",
                  RECEIVED: "Вещи приняты на осмотр",
                  CLOSED: "Решение принято",
                  REJECTED: "Рассмотрение завершено",
                }[ret.status] ||
                  statusNames[ret.status] ||
                  ret.status}
              </strong>
              <p className="small-text">
                Обращение о возврате от {date(ret.createdAt)}
              </p>
              {ret.receivedAt && (
                <p className="small-text">
                  Вещи приняты {date(ret.receivedAt)}
                </p>
              )}
              {ret.closedAt && (
                <p className="small-text">Решение от {date(ret.closedAt)}</p>
              )}
              {ret.decision && <p>{ret.decision}</p>}
              <p className="muted">
                История исходного получения сохранена. Подробности и дальнейшие
                действия уточняйте в магазине.
              </p>
            </div>
          ))}
        </section>
      )}
      <section className="detail-section">
        <h2>Ваши вещи</h2>
        <div className="item-list">
          {order.lines.map((line) => (
            <div className="item-row" key={line.id}>
              <Photo media={line.media?.[0]} alt={line.title} />
              <div>
                <strong>{line.title}</strong>
                <Defect item={line} />
                <p className="muted">
                  {[productSize(line.attributes), line.sku].filter(Boolean).join(" · ")}
                </p>
                <strong>{money(line.priceMinor)}</strong>
                <p className="small-text">
                  {statusNames[line.outcome] || line.outcome}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <details className="document"><summary>Условия этого обращения</summary><p className="pre-wrap">{order.ruleSnapshot?.buyerGuide?.[order.method === "PICKUP" ? "pickup" : "shipping"] || "Состав и условия зафиксированы при оформлении. Подробности уточняйте в магазине по номеру обращения."}</p>{order.ruleSnapshot?.documents && order.ruleSnapshot.documentStatus === "APPROVED" && <p className="pre-wrap">{order.ruleSnapshot.documents[order.method === "PICKUP" ? "reservation" : "shipping"]}</p>}</details>
      <Summary label="Стоимость вещей">{money(order.totalMinor)}</Summary>
      <p className="muted">
        {order.method === "PICKUP"
          ? "Бронь бесплатна · расчёт в магазине"
          : settings?.buyerGuide?.shipping || defaultBuyerGuide.shipping}
      </p>
      <div className="button-stack section-space">
        {order.status === "READY_FOR_PICKUP" && order.pickupCode && (
          <Button onClick={() => setCode(true)}>Показать код выдачи</Button>
        )}
        {canEdit && (
          <Button
            secondary
            onClick={() => {
              setRecipient({
                ...draftDefault,
                ...order.recipient,
                method: order.method,
              });
              setEdit(true);
            }}
          >
            Изменить данные получателя
          </Button>
        )}
        {canCancel && (
          <Button
            secondary
            onClick={() => {
              setChosen(order.lines.filter(activeLine).map((l) => l.id));
              setCancel(true);
            }}
          >
            Отказаться от части или отменить
          </Button>
        )}
        <Button
          secondary
          onClick={() => {
            if (settings?.telegramUsername)
              openTelegram(settings.telegramUsername);
            else go("/support");
          }}
        >
          Связаться с магазином
        </Button>
        <Copy
          value={String(order.number)}
          label="Скопировать номер обращения"
        />
        <Button ghost onClick={() => go("/about")}>
          Правила возврата товаров
        </Button>
      </div>
      {code && (
        <Sheet title="Код выдачи" onClose={() => setCode(false)}>
          <div className="pickup-code">{order.pickupCode}</div>
          <p>
            Покажите код сотруднику магазина. Он относится только к обращению №
            {order.number} и погасится после выдачи.
          </p>
        </Sheet>
      )}
      {cancel && (
        <Sheet title="Отказ от вещей" onClose={() => setCancel(false)}>
          <p>
            {order.status === "PREPARING" || order.status === "DISPATCH_READY"
              ? "Посылка готовится. Запрос проверит сотрудник до сдачи перевозчику."
              : "Выберите вещи, от которых хотите отказаться."}
          </p>
          {order.lines.filter(activeLine).map((line) => (
            <label className="check-row" key={line.id}>
              <input
                type="checkbox"
                checked={chosen.includes(line.id)}
                onChange={(e) =>
                  setChosen((v) =>
                    e.target.checked
                      ? [...v, line.id]
                      : v.filter((id) => id !== line.id),
                  )
                }
              />
              <span>
                {line.title}
                <small>{money(line.priceMinor)}</small>
              </span>
            </label>
          ))}
          <Summary label="Останется вещей на сумму">
            {money(
              order.lines
                .filter((l) => activeLine(l) && !chosen.includes(l.id))
                .reduce((s, l) => s + l.priceMinor, 0),
            )}
          </Summary>
          <ErrorBox error={actionError} />
          <Button
            disabled={!chosen.length || busy}
            onClick={() =>
              act(`/orders/${id}/cancel`, {
                version: order.version,
                lineIds: chosen,
              })
            }
          >
            {busy ? "Сохраняем…" : "Подтвердить отказ"}
          </Button>
        </Sheet>
      )}
      {edit && (
        <Sheet title="Данные получателя" onClose={() => setEdit(false)}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              act(
                `/orders/${id}/recipient`,
                { ...recipient, version: order.version },
                "PATCH",
              );
            }}
          >
            <Field
              label="Фамилия, имя, отчество"
              required
              value={recipient.fullName}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, fullName: e.target.value }))
              }
            />
            <Field
              label="Телефон"
              type="tel"
              required
              value={recipient.phone}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, phone: e.target.value }))
              }
            />
            <Field
              label="Населённый пункт"
              required
              value={recipient.city}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, city: e.target.value }))
              }
            />
            <Field
              label={order.method === "EUROPOST" ? "Предпочтительное отделение, если известно" : "Отделение или его адрес"}
              required={order.method === "BELPOST" && !recipient.officeAddress}
              value={recipient.office}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, office: e.target.value }))
              }
            />
            {(order.method === "EUROPOST" || recipient.officeAddress) && <Field label="Адрес пункта выдачи, если известен" value={recipient.officeAddress || ""} onChange={e => setRecipient(v => ({...v, officeAddress:e.target.value}))} />}
            {order.method === "BELPOST" && <Field
              label="Индекс"
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={recipient.postalCode}
              onChange={(e) =>
                setRecipient((v) => ({ ...v, postalCode: e.target.value }))
              }
            />}
            {order.status !== "CHECKING" && (
              <p>Изменение проверит сотрудник до передачи посылки.</p>
            )}
            <ErrorBox error={actionError} />
            <Button type="submit" disabled={busy}>
              Сохранить изменения
            </Button>
          </form>
        </Sheet>
      )}
    </div>
  );
}
