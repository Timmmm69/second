import { useEffect, useState } from "react";
import { api, command } from "./api";
import { useApp } from "./context";
import { tg } from "./telegram";
import { useMutation } from "./mutations";
import {
  Button,
  Copy,
  Empty,
  ErrorBox,
  Field,
  Icon,
  Loading,
  Summary,
  Textarea,
  useLoad,
} from "./ui";
import {
  date,
  methodNames,
  type Category,
  measurementNames,
  type Carrier,
  type Settings,
  type User,
} from "./types";
interface AuditEvent {
  id: string;
  actorId?: string;
  command: string;
  entityId?: string;
  createdAt: string;
  before?: unknown;
  after?: unknown;
  details?: unknown;
}
interface Operation {
  id: string;
  type?: string;
  eventType?: string;
  kind?: string;
  state?: string;
  message?: string;
  status?: string;
  attempts?: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt?: string;
}
export default function Owner() {
  const [tab, setTab] = useState("settings");
  return (
    <div className="page narrow owner-page">
      <h1>Управление</h1>
      <p className="muted">Настройки магазина и доступы владельца</p>
      <div className="chips">
        {[
          ["settings", "Магазин"],
          ["categories", "Категории"],
          ["staff", "Сотрудники"],
          ["audit", "Журнал"],
          ["operations", "Работа системы"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "selected" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "settings" ? (
        <StoreSettings />
      ) : tab === "categories" ? (
        <CategorySettings />
      ) : tab === "staff" ? (
        <StaffAccess />
      ) : tab === "audit" ? (
        <Audit />
      ) : (
        <Operations />
      )}
    </div>
  );
}
function OwnerSecurity({
  code,
  onChange,
}: {
  code: string;
  onChange: (v: string) => void;
}) {
  const [error, setError] = useState<unknown>(null),
    [done, setDone] = useState(false);
  return (
    <section className="security-box">
      <h3>Подтверждение владельца</h3>
      <p className="small-text">
        Для защищённых изменений нужна свежая авторизация и код приложения
        аутентификатора. В локальной среде проверка может быть отключена.
      </p>
      <Field
        label="Одноразовый код владельца"
        value={code}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
      />
      <Button
        secondary
        onClick={async () => {
          try {
            if (!tg()?.initData)
              throw new Error(
                "Для повторного подтверждения откройте Mini App через Telegram.",
              );
            await command("/auth/telegram", { initData: tg()?.initData });
            setDone(true);
          } catch (e) {
            setError(e);
          }
        }}
      >
        {done ? "Авторизация подтверждена" : "Подтвердить авторизацию Telegram"}
      </Button>
      <ErrorBox error={error} />
    </section>
  );
}
function StoreSettings() {
  const { toast, ownerCode, setOwnerCode, refreshSettings } = useApp();
  const { data, error, loading, reload } = useLoad<Settings>("/owner/settings");
  const [form, setForm] = useState<Settings | null>(null),
    [busy, setBusy] = useState(false),
    [saveError, setSaveError] = useState<unknown>(null),
    [exceptionDate, setExceptionDate] = useState(""),
    [exceptionClosed, setExceptionClosed] = useState(true),
    [exceptionOpen, setExceptionOpen] = useState("10:00"),
    [exceptionClose, setExceptionClose] = useState("20:00");
  useEffect(() => {
    if (data) setForm(structuredClone(data));
  }, [data]);
  if (loading && !form) return <Loading />;
  if (!form) return <ErrorBox error={error} retry={reload} />;
  const set = (key: keyof Settings, value: unknown) =>
    setForm((v) => (v ? { ...v, [key]: value } : v));
  const carrier = (key: "BELPOST" | "EUROPOST", patch: Partial<Carrier>) =>
    setForm((v) =>
      v
        ? {
            ...v,
            carriers: {
              ...v.carriers,
              [key]: { ...v.carriers[key], ...patch },
            },
          }
        : v,
    );
  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const response = await command<Settings>(
        "/owner/settings",
        form,
        "PATCH",
        undefined,
        ownerCode,
      );
      setForm(structuredClone(response));
      await refreshSettings();
      toast("Настройки сохранены. Действующие сроки не сокращаются.");
    } catch (e) {
      setSaveError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <ErrorBox error={error || saveError} />
      <section>
        <h2>Магазин и продавец</h2>
        <div className="form-stack">
          <Field
            label="Название магазина"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            required
          />
          <Field
            label="Адрес магазина"
            value={form.address}
            onChange={(e) => set("address", e.target.value)}
          />
          <Field
            label="Телефон магазина"
            type="tel"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
          />
          <Field
            label="Telegram-аккаунт магазина"
            value={form.telegramUsername}
            placeholder="username без @"
            onChange={(e) => set("telegramUsername", e.target.value)}
          />
          <Textarea
            label="Реквизиты и сведения о продавце"
            value={form.seller}
            onChange={(v) => set("seller", v)}
            hint="Укажите фактические данные и предусмотренные официальные способы подачи обращений."
          />
        </div>
      </section>
      <section className="detail-section">
        <h2>Часы работы</h2>
        <p className="small-text">
          Europe/Minsk. Изменение календаря может только увеличить уже обещанные
          сроки из-за закрытия магазина.
        </p>
        {[
          "Понедельник",
          "Вторник",
          "Среда",
          "Четверг",
          "Пятница",
          "Суббота",
          "Воскресенье",
        ].map((day, index) => {
          const key = String((index + 1) % 7),
            value = form.calendar.week[key];
          return (
            <div className="calendar-row" key={day}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) =>
                    set("calendar", {
                      ...form.calendar,
                      week: {
                        ...form.calendar.week,
                        [key]: e.target.checked ? ["10:00", "20:00"] : null,
                      },
                    })
                  }
                />
                <span>{day}</span>
              </label>
              {value && (
                <div className="form-pair">
                  <Field
                    label={`Открытие, ${day}`}
                    type="time"
                    value={value[0]}
                    onChange={(e) =>
                      set("calendar", {
                        ...form.calendar,
                        week: {
                          ...form.calendar.week,
                          [key]: [e.target.value, value[1]],
                        },
                      })
                    }
                  />
                  <Field
                    label={`Закрытие, ${day}`}
                    type="time"
                    value={value[1]}
                    onChange={(e) =>
                      set("calendar", {
                        ...form.calendar,
                        week: {
                          ...form.calendar.week,
                          [key]: [value[0], e.target.value],
                        },
                      })
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
        <h3>Исключения по датам</h3>
        {Object.entries(form.calendar.exceptions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, hours]) => (
            <div className="summary-row" key={day}>
              <span>
                {day}: {hours ? `${hours[0]}–${hours[1]}` : "закрыт"}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Удалить исключение ${day}`}
                onClick={() => {
                  const exceptions = { ...form.calendar.exceptions };
                  delete exceptions[day];
                  set("calendar", { ...form.calendar, exceptions });
                }}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          ))}
        <Field
          label="Дата исключения"
          type="date"
          value={exceptionDate}
          onChange={(e) => setExceptionDate(e.target.value)}
        />
        <label className="check-row">
          <input
            type="checkbox"
            checked={exceptionClosed}
            onChange={(e) => setExceptionClosed(e.target.checked)}
          />
          <span>Магазин закрыт весь день</span>
        </label>
        {!exceptionClosed && (
          <div className="form-pair">
            <Field
              label="Открытие"
              type="time"
              value={exceptionOpen}
              onChange={(e) => setExceptionOpen(e.target.value)}
            />
            <Field
              label="Закрытие"
              type="time"
              value={exceptionClose}
              onChange={(e) => setExceptionClose(e.target.value)}
            />
          </div>
        )}
        <Button
          secondary
          disabled={!exceptionDate}
          onClick={() => {
            set("calendar", {
              ...form.calendar,
              exceptions: {
                ...form.calendar.exceptions,
                [exceptionDate]: exceptionClosed
                  ? null
                  : [exceptionOpen, exceptionClose],
              },
            });
            setExceptionDate("");
          }}
        >
          Добавить исключение
        </Button>
      </section>
      <section className="detail-section">
        <h2>Условия получения и документы</h2>
        <p>
          Не публикуйте непроверенные правовые тексты. Бронь и подача заявки
          бесплатны; условия возврата указываются в документах магазина.
        </p>
        {(["reservation", "shipping", "returns", "privacy"] as const).map(
          (key) => (
            <Textarea
              key={key}
              label={
                {
                  reservation: "Бронь и самовывоз",
                  shipping: "Почтовая отправка",
                  returns: "Возвраты товаров",
                  privacy: "Персональные данные",
                }[key]
              }
              value={form.documents[key]}
              onChange={(value) =>
                set("documents", { ...form.documents, [key]: value })
              }
              rows={6}
            />
          ),
        )}
      </section>
      <section className="detail-section">
        <h2>Почтовые способы</h2>
        <p className="small-text">
          Включайте способ после проверки действующего договора, наложенного
          платежа, расходов и возвратов. Оформление посылок — вручную в кабинете
          почты.
        </p>
        {(["BELPOST", "EUROPOST"] as const).map((key) => (
          <section className="carrier-settings" key={key}>
            <h3>{methodNames[key]}</h3>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.carriers[key]?.enabled || false}
                onChange={(e) => carrier(key, { enabled: e.target.checked })}
              />
              <span>Доступна покупателям</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.carriers[key]?.partialDelivery || false}
                onChange={(e) =>
                  carrier(key, { partialDelivery: e.target.checked })
                }
              />
              <span>Договор допускает частичную выдачу</span>
            </label>
            <Field
              label="Реквизиты договора"
              value={form.carriers[key]?.contract || ""}
              onChange={(e) => carrier(key, { contract: e.target.value })}
            />
            <Textarea
              label="Раскрываемые покупателю условия"
              value={form.carriers[key]?.terms || ""}
              onChange={(value) => carrier(key, { terms: value })}
            />
            <Textarea
              label="Проверенная схема расчётов и плательщики"
              value={form.carriers[key]?.paymentScheme || ""}
              onChange={(value) => carrier(key, { paymentScheme: value })}
            />
            <Textarea
              label="Проверенные условия возврата посылки"
              value={form.carriers[key]?.returnsScheme || ""}
              onChange={(value) => carrier(key, { returnsScheme: value })}
            />
            <Field
              label="Дата проверки договора и условий"
              type="date"
              value={form.carriers[key]?.verifiedAt?.slice(0, 10) || ""}
              onChange={(e) => carrier(key, { verifiedAt: e.target.value })}
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.carriers[key]?.codConfirmed || false}
                onChange={(e) =>
                  carrier(key, { codConfirmed: e.target.checked })
                }
              />
              <span>Наложенный платёж разрешён действующим договором</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.carriers[key]?.returnsConfirmed || false}
                onChange={(e) =>
                  carrier(key, { returnsConfirmed: e.target.checked })
                }
              />
              <span>Проверены условия невостребованной посылки и возврата</span>
            </label>
          </section>
        ))}
      </section>
      <section className="detail-section">
        <h2>Новые оформления</h2>
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.acceptingOrders}
            onChange={(e) => set("acceptingOrders", e.target.checked)}
          />
          <span>Принимать новые брони и заявки</span>
        </label>
        <p className="small-text">
          Выключение не отменяет действующие обязательства. Перед запуском
          должны быть заполнены фактические сведения и проверены условия.
        </p>
      </section>
      <OwnerSecurity code={ownerCode} onChange={setOwnerCode} />
      <div className="bottom-action">
        <Button type="submit" disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить настройки"}
        </Button>
      </div>
    </form>
  );
}
function CategorySettings() {
  const { ownerCode, setOwnerCode, refreshCategories, toast } = useApp();
  const { data, error, loading, reload } = useLoad<Category[]>("/owner/categories");
  const blank = { name: "", sortOrder: 100, measurements: [] as string[], archived: false };
  const [form, setForm] = useState<Category | typeof blank>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mutation = useMutation();
  const [saveError, setError] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await mutation.run<Category>(editing ? `/owner/categories/${editing}` : "/owner/categories",
        { name: form.name, measurements: form.measurements, sortOrder: form.sortOrder,
          archived: form.archived, ...(editing && "version" in form ? { version: form.version } : {}) },
        editing ? "PATCH" : "POST");
      if (!result) return;
      setEditing(null);
      setForm(blank);
      reload();
      await refreshCategories();
      toast("Категория сохранена");
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return <div className="form-stack">
    <p>Категории можно добавлять без разработчика. Меньшее число порядка — выше в списке. Архивировать можно только категорию без вещей: сначала перенесите их в другую.</p>
    <ErrorBox error={error || saveError || mutation.error} retry={reload} />
    {mutation.recovery}
    {loading ? <Loading /> : <section className="detail-section">
      <h2>Категории магазина</h2>
      {data?.map(c => <div className="summary-row" key={c.id}>
        <span>{c.name}{c.archived ? " · в архиве" : ""} <small>· порядок {c.sortOrder}</small></span>
        <Button secondary disabled={busy} onClick={() => { setEditing(c.id); setForm(structuredClone(c)); setError(null); }}>Изменить {c.name}</Button>
      </div>)}
    </section>}
    <form className="form-stack" onSubmit={e => { e.preventDefault(); save(); }}>
      <h2>{editing ? "Редактировать категорию" : "Новая категория"}</h2>
      <Field label="Название категории" value={form.name} required maxLength={100}
        placeholder="Например, Одежда для собак" onChange={e => setForm(v => ({...v,name:e.target.value}))} />
      <Field label="Порядок отображения" type="number" min="0" max="1000000" required
        value={form.sortOrder} onChange={e => setForm(v => ({...v,sortOrder:Number(e.target.value)}))} />
      <fieldset><legend>Замеры в редакторе вещей</legend>
        <p className="small-text">Выберите подходящие замеры. Значения вводятся в сантиметрах в карточке вещи.</p>
        {Object.entries(measurementNames).map(([key,label]) => <label className="check-row" key={key}>
          <input type="checkbox" checked={form.measurements.includes(key)} onChange={e => {
            const checked=e.target.checked;
            setForm(v => ({...v,measurements:checked ? [...v.measurements,key] : v.measurements.filter(k => k!==key)}));
          }} /><span>{label}</span>
        </label>)}
      </fieldset>
      <label className="check-row"><input type="checkbox" checked={form.archived}
        onChange={e => setForm(v => ({...v,archived:e.target.checked}))} /><span>В архиве</span></label>
      <OwnerSecurity code={ownerCode} onChange={setOwnerCode} />
      <Button type="submit" disabled={busy || !form.name.trim()}>{busy ? "Сохраняем…" : "Сохранить категорию"}</Button>
      {editing && <Button secondary disabled={busy} onClick={() => {setEditing(null);setForm(blank);setError(null);}}>Отменить редактирование</Button>}
    </form>
  </div>;
}
function StaffAccess() {
  const { toast, user, ownerCode: code, setOwnerCode: setCode } = useApp();
  const { data, error, loading, reload } = useLoad<{ staff: User[] }>(
    "/owner/staff",
  );
  const [id, setId] = useState(""),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState<{ token: string; expiresAt: string } | null>(
      null,
    ),
    [actionError, setError] = useState<unknown>(null);
  const inviteAction = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await command<{ token: string; expiresAt: string }>(
        "/owner/staff/invites",
        { telegramId: id, role: "STAFF" },
        "POST",
        undefined,
        code,
      );
      setInvite(result);
      toast("Приглашение создано для указанного аккаунта");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <ErrorBox error={error || actionError} retry={reload} />
      {loading ? (
        <Loading />
      ) : (
        <section className="detail-section">
          <h2>Действующие доступы</h2>
          {data?.staff.map((staff) => (
            <div className="staff-access-row" key={staff.id}>
              <div>
                <strong>Telegram ID {staff.telegramId}</strong>
                <p className="muted">
                  {staff.role === "OWNER" ? "Владелец" : "Сотрудник"}
                </p>
              </div>
              {staff.id !== user?.id && staff.role !== "OWNER" && (
                <Button
                  secondary
                  danger
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !confirm(
                        "Отозвать доступ? Следующая служебная команда этого сотрудника будет запрещена.",
                      )
                    )
                      return;
                    setBusy(true);
                    try {
                      await api(`/owner/staff/${staff.id}`, {
                        method: "DELETE",
                        ownerCode: code,
                      });
                      reload();
                      toast("Доступ отозван");
                    } catch (e) {
                      setError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Отозвать
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
      <section className="detail-section">
        <h2>Пригласить сотрудника</h2>
        <p>
          Сотрудник сможет вести вещи, цены, брони, выдачу и отправки.
          Управление доступами остаётся у владельца.
        </p>
        <Field
          label="Подтверждённый Telegram ID"
          inputMode="numeric"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <OwnerSecurity code={code} onChange={setCode} />
        <Button disabled={busy || !/^\d+$/.test(id)} onClick={inviteAction}>
          Создать одноразовое приглашение
        </Button>
        {invite && (
          <div className="notice">
            <h3>Приглашение готово</h3>
            <p>
              Передайте код лично указанному сотруднику. Действует до{" "}
              {date(invite.expiresAt)}.
            </p>
            <p className="invite-token">{invite.token}</p>
            <Copy value={invite.token} label="Скопировать код приглашения" />
          </div>
        )}
      </section>
    </div>
  );
}
function Audit() {
  const [actor, setActor] = useState(""),
    [entity, setEntity] = useState(""),
    [from, setFrom] = useState("");
  const { data, error, loading, reload } = useLoad<{ events: AuditEvent[] }>(
    `/owner/audit?${new URLSearchParams(Object.entries({ actor, entity, from }).filter(([, value]) => Boolean(value))).toString()}`,
  );
  return (
    <div>
      <div className="form-stack">
        <Field
          label="ID сотрудника"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
        <Field
          label="ID объекта"
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
        />
        <Field
          label="Начиная с даты"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
      <ErrorBox error={error} retry={reload} />
      {loading ? (
        <Loading />
      ) : !data?.events.length ? (
        <Empty title="Действий пока нет">
          Критические команды записываются сервером автоматически.
        </Empty>
      ) : (
        <div className="audit-list">
          {data.events.map((event) => (
            <details key={event.id} className="document">
              <summary>
                {date(event.createdAt)} · {event.command}
              </summary>
              <p className="small-text">
                Сотрудник {event.actorId || "система"} · объект{" "}
                {event.entityId || "—"}
              </p>
              <pre>
                {JSON.stringify(
                  event.details || { before: event.before, after: event.after },
                  null,
                  2,
                )}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
function Operations() {
  const { data, error, loading, reload } = useLoad<{
    outbox: Operation[];
    issues: Operation[];
    disk?: { availableBytes?: number; totalBytes?: number; freeBytes?: number };
    worker?: unknown;
  }>("/owner/operations");
  return (
    <div>
      <div className="section-heading">
        <h2>Работа системы</h2>
        <button className="icon-button" aria-label="Обновить" onClick={reload}>
          <Icon name="refresh" />
        </button>
      </div>
      <ErrorBox error={error} retry={reload} />
      {loading ? (
        <Loading />
      ) : (
        data && (
          <>
            <section className="detail-section">
              <h3>Постоянный диск</h3>
              <Summary label="Свободно">
                {typeof (data.disk?.availableBytes ?? data.disk?.freeBytes) ===
                "number"
                  ? `${(((data.disk?.availableBytes ?? data.disk?.freeBytes) || 0) / 1024 ** 3).toFixed(1)} ГБ`
                  : "Сведения недоступны"}
              </Summary>
              <p className="small-text">
                Каталог, база и фотографии находятся на одном постоянном диске.
                После потери этого диска без копии восстановление данных не
                гарантируется.
              </p>
            </section>
            <section className="detail-section">
              <h3>Сервисные уведомления</h3>
              {!data.outbox?.length ? (
                <p className="muted">Задержанных уведомлений нет.</p>
              ) : (
                data.outbox.map((op) => (
                  <div className="operation-row" key={op.id}>
                    <strong>{op.type || op.eventType || op.id}</strong>
                    <p>
                      {op.status || op.state} · попыток {op.attempts || 0}
                    </p>
                    {op.lastError && <p>{op.lastError}</p>}
                    <small>Следующая попытка: {date(op.nextAttemptAt)}</small>
                  </div>
                ))
              )}
            </section>
            <section className="detail-section">
              <h3>Проблемы операций</h3>
              {!data.issues?.length ? (
                <p className="muted">Открытых проблем нет.</p>
              ) : (
                data.issues.map((op) => (
                  <p key={op.id}>
                    {op.message || op.kind || op.type} · {op.status || op.state}
                  </p>
                ))
              )}
            </section>
          </>
        )
      )}
    </div>
  );
}
