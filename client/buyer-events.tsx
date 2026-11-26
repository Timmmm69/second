import { useState } from "react";
import { command } from "./api";
import { useApp } from "./context";
import { Button, Empty, ErrorBox, Icon, Loading, useLoad } from "./ui";
import { date, statusNames, type Event } from "./types";
import { tg } from "./telegram";

export default function Events() {
  const { user, go, toast } = useApp();
  const { data, error, loading, reload } = useLoad<{ events: Event[] }>(
    user ? "/me/events" : null,
  );
  const [actionError, setError] = useState<unknown>(null);
  return (
    <div className="page narrow">
      <h1>Уведомления и контакты</h1>
      <p className="muted">
        Только события по вашим обращениям. Сроки действуют независимо от
        доставки сообщения.
      </p>
      <ErrorBox error={error || actionError} retry={reload} />
      {loading ? (
        <Loading />
      ) : !data?.events.length ? (
        <Empty title="Пока нет новых событий">
          После оформления здесь появятся изменения статусов.
        </Empty>
      ) : (
        <div className="event-list">
          {data.events.map((event) => (
            <button
              key={event.id}
              className={`event-row ${!event.readAt ? "unread" : ""}`}
              onClick={() => {
                command(`/me/events/${event.id}/read`)
                  .then(() => {
                    reload();
                    if (event.orderId) go(`/orders/${event.orderId}`);
                  })
                  .catch(setError);
              }}
            >
              <span>
                <strong>
                  {event.message || statusNames[event.type] || event.type}
                </strong>
                <small>{date(event.createdAt)}</small>
              </span>
              <Icon name="next" size={18} />
            </button>
          ))}
        </div>
      )}
      {user && (
        <>
          <section className="detail-section">
            <h2>Сервисные сообщения бота</h2>
            <p>
              Можно разрешить Telegram-боту присылать статусы. Рекламной
              подписки нет.
            </p>
            <Button
              secondary
              onClick={() => {
                if (tg()?.requestWriteAccess)
                  tg()?.requestWriteAccess?.((allowed) => {
                    command(
                      "/me/contact-preference",
                      { allowBot: allowed },
                      "PATCH",
                    )
                      .then(() =>
                        toast(
                          allowed
                            ? "Сервисные уведомления включены"
                            : "Статусы остаются доступны в приложении",
                        ),
                      )
                      .catch(setError);
                  });
                else
                  command("/me/contact-preference", { allowBot: true }, "PATCH")
                    .then(() =>
                      toast(
                        "Канал включён. Бот сможет писать после разрешения в Telegram.",
                      ),
                    )
                    .catch(setError);
              }}
            >
              Разрешить сообщения бота
            </Button>
            <Button
              ghost
              onClick={() =>
                command("/me/contact-preference", { allowBot: false }, "PATCH")
                  .then(() => toast("Сообщения бота выключены"))
                  .catch(setError)
              }
            >
              Выключить сообщения бота
            </Button>
          </section>
          <section className="detail-section">
            <h2>Мои данные</h2>
            <p>
              Запрос на удаление рассмотрит владелец с учётом незавершённых
              обращений и необходимых сроков хранения.
            </p>
            <Button
              secondary
              onClick={() => {
                if (
                  window.confirm(
                    "Отправить запрос на удаление ваших персональных данных?",
                  )
                )
                  command("/me/deletion-request")
                    .then(() => toast("Запрос на удаление передан владельцу"))
                    .catch(setError);
              }}
            >
              Запросить удаление данных
            </Button>
          </section>
        </>
      )}
    </div>
  );
}
