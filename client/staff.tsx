import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, readLocal, saveLocal } from "./api";
import { useApp } from "./context";
import { OrderCard } from "./buyer";
import { useMutation } from "./mutations";
import { tg } from "./telegram";
import {
  Button,
  Copy,
  Empty,
  ErrorBox,
  Field,
  Icon,
  Loading,
  Photo,
  Select,
  Sheet,
  Summary,
  Textarea,
  useLoad,
} from "./ui";
import {
  date,
  measurementNames,
  methodNames,
  money,
  statusNames,
  type Item,
  type Issue,
  type Media,
  type Order,
  type Return,
} from "./types";
export default function Staff() {
  const { path } = useApp();
  if (path.startsWith("/staff/items/"))
    return <ItemEditor id={path.split("/")[3]} />;
  if (path.startsWith("/staff/orders/"))
    return <StaffOrder id={path.split("/")[3]} />;
  if (path === "/staff/items") return <Items />;
  if (path === "/staff/search") return <Search />;
  if (path === "/staff/returns") return <Returns />;
  if (path === "/staff/counter") return <Counter />;
  return <Queue />;
}
function Queue() {
  const { go } = useApp();
  const [filter, setFilter] = useState("checking");
  const { data, error, loading, reload } = useLoad<{
    orders: Order[];
    issues: Issue[];
  }>(`/staff/queue?filter=${filter}`);
  const mutation = useMutation();
  useEffect(() => {
    const timer = setInterval(reload, 30000);
    return () => clearInterval(timer);
  }, [reload]);
  return (
    <div className="page narrow">
      <div className="section-heading">
        <h1>Очередь</h1>
        <button
          className="icon-button"
          aria-label="Обновить очередь"
          onClick={reload}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <p className="muted">Следующее действие — всегда под рукой</p>
      <div className="chips">
        {[
          ["checking", "Проверить"],
          ["pickup", "Выдать"],
          ["shipping", "Отправить"],
          ["deadlines", "Сроки"],
          ["problems", "Проблемы"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={filter === key ? "selected" : ""}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="quick-actions">
        <Button secondary onClick={() => go("/staff/counter")}>
          <Icon name="bag" size={18} />
          Продажа в магазине
        </Button>
        <Button secondary onClick={() => go("/staff/returns")}>
          Возвраты
        </Button>
      </div>
      <ErrorBox error={error} retry={reload} />
      {mutation.recovery}
      {loading && !data ? (
        <Loading />
      ) : filter === "problems" ? (
        <div className="issue-list">
          {!data?.issues.length ? (
            <Empty title="Проблем в очереди нет">
              Проверьте обычные задачи и сроки.
            </Empty>
          ) : (
            data.issues.map((issue) => (
              <section className="notice" key={issue.id}>
                <h2>{issue.message || issue.type || "Нужна проверка"}</h2>
                <p className="muted">
                  {date(issue.createdAt)} · {issue.status}
                </p>
                {(issue.itemId || issue.orderId) && (
                  <Button
                    ghost
                    onClick={() =>
                      go(
                        issue.itemId
                          ? `/staff/items/${issue.itemId}`
                          : `/staff/orders/${issue.orderId}`,
                      )
                    }
                  >
                    {issue.itemId
                      ? "Открыть вещь для проверки"
                      : "Открыть связанное обращение"}
                  </Button>
                )}
                <div className="button-stack">
                  <Button
                    secondary
                    disabled={mutation.busy}
                    onClick={() =>
                      mutation
                        .run(`/staff/issues/${issue.id}/assign`)
                        .then(reload)
                    }
                  >
                    Взять в работу
                  </Button>
                  {![
                    "INSPECTION",
                    "RETURN_INSPECTION",
                    "QUALITY_CHECK",
                  ].includes(issue.kind || "") && (
                    <Button
                      secondary
                      disabled={mutation.busy}
                      onClick={() => {
                        const note = window.prompt(
                          "Что проверено и как решена проблема?",
                        );
                        if (note)
                          mutation
                            .run(`/staff/issues/${issue.id}/resolve`, { note })
                            .then(reload);
                      }}
                    >
                      Закрыть по факту проверки
                    </Button>
                  )}
                </div>
              </section>
            ))
          )}
        </div>
      ) : !data?.orders.length ? (
        <Empty title="В этой очереди пока нет задач">
          Новые обращения появятся автоматически.
        </Empty>
      ) : (
        <div className="order-list">
          {data.orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              onOpen={() => go(`/staff/orders/${order.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
function Items() {
  const { go } = useApp();
  const [q, setQ] = useState(""),
    [state, setState] = useState(""),
    [bulkIds, setBulkIds] = useState<string[]>([]),
    [bulkOpen, setBulkOpen] = useState(false),
    [scan, setScan] = useState(false);
  const selectedSnapshots = useRef(new Map<string, Item>());
  const mutation = useMutation();
  const { data, error, loading, reload } = useLoad<{ items: Item[] }>(
    `/staff/items?q=${encodeURIComponent(q)}&state=${state}`,
  );
  return (
    <div className="page narrow">
      <div className="section-heading">
        <h1>Вещи</h1>
        <Button onClick={() => go("/staff/items/new")}>
          <Icon name="plus" size={18} />
          Добавить
        </Button>
      </div>
      <Field
        label="Найти вещь"
        type="search"
        placeholder="Артикул или название"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <Button
        secondary
        onClick={() =>
          scanSku(
            (value) => setQ(value),
            () => setScan(true),
          )
        }
      >
        <Icon name="photo" size={18} />
        Сканировать бирку
      </Button>
      <div className="chips">
        {[
          ["", "Все"],
          ["DRAFT", "Черновики"],
          ["AVAILABLE", "В продаже"],
          ["INSPECTION", "На проверке"],
          ["SOLD", "Проданные"],
          ["HIDDEN", "Скрытые"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={state === key ? "selected" : ""}
            onClick={() => setState(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorBox error={error} retry={reload} />
      {mutation.recovery}
      {bulkIds.length > 0 && (
        <div className="notice">
          <Summary label="Выбрано доступных вещей">{bulkIds.length}</Summary>
          <Button secondary onClick={() => setBulkOpen(true)}>
            Снять выбранные с витрины
          </Button>
          <Button ghost onClick={() => setBulkIds([])}>
            Сбросить выбор
          </Button>
        </div>
      )}
      {loading ? (
        <Loading />
      ) : !data?.items.length ? (
        <Empty
          title="Вещей пока нет"
          action={
            <Button onClick={() => go("/staff/items/new")}>
              Добавить вещь
            </Button>
          }
        >
          Создайте карточку конкретной физической вещи и загрузите её
          фотографии.
        </Empty>
      ) : (
        <div className="item-list">
          {data.items.map((item) => (
            <div className="item-row staff-item-row" key={item.id}>
              {item.available && (
                <label className="bulk-select">
                  <input
                    type="checkbox"
                    aria-label={`Выбрать ${item.title} для снятия с витрины`}
                    checked={bulkIds.includes(item.id)}
                    onChange={(e) => {
                      if (e.target.checked)
                        selectedSnapshots.current.set(item.id, item);
                      else selectedSnapshots.current.delete(item.id);
                      setBulkIds((v) =>
                        e.target.checked
                          ? [...v, item.id]
                          : v.filter((id) => id !== item.id),
                      );
                    }}
                  />
                </label>
              )}
              <button
                className="staff-row-link"
                onClick={() => go(`/staff/items/${item.id}`)}
              >
                <Photo media={item.media[0]} alt={item.title} />
                <div>
                  <strong>{item.title || "Новая вещь"}</strong>
                  <p className="muted">
                    {item.sku} · {item.storageLocation || "Место не задано"}
                  </p>
                  <strong>{money(item.priceMinor)}</strong>
                  <p className="small-text">
                    {statusNames[item.physical] || item.physical} ·{" "}
                    {statusNames[item.publication] || item.publication}
                  </p>
                </div>
                <Icon name="next" size={18} />
              </button>
            </div>
          ))}
        </div>
      )}
      {bulkOpen && (
        <Sheet title="Снять вещи с витрины?" onClose={() => setBulkOpen(false)}>
          <p>
            Будут скрыты {bulkIds.length} доступных вещей. Если хотя бы одна уже
            закреплена, сервер отклонит весь набор.
          </p>
          {bulkIds
            .map((id) => selectedSnapshots.current.get(id))
            .filter((item): item is Item => Boolean(item))
            .map((item) => (
              <p key={item.id}>
                {item.title} · {item.sku}
              </p>
            ))}
          {mutation.recovery}
          <Button
            disabled={mutation.busy}
            onClick={async () => {
              const result = await mutation.run("/staff/items/bulk-hide", {
                items: bulkIds.map((id) => ({
                  id,
                  version: selectedSnapshots.current.get(id)!.version,
                })),
                confirmed: true,
              });
              if (result) {
                setBulkIds([]);
                setBulkOpen(false);
                reload();
              }
            }}
          >
            Подтвердить снятие с витрины
          </Button>
        </Sheet>
      )}
      {scan && (
        <Scanner
          onClose={() => setScan(false)}
          onResult={(value) => {
            setQ(value);
            setScan(false);
          }}
        />
      )}
    </div>
  );
}
const initialItem = {
  title: "",
  sku: "",
  category: "outerwear",
  priceMinor: 0,
  attributes: {
    sizeSystem: "INT",
    sizeLabel: "",
    brand: "",
    material: "",
    color: "",
    season: "",
    audience: "Унисекс",
    care: "",
    manufacturer: "",
    importer: "",
    origin: "",
    documents: "",
  } as Record<string, string | number>,
  measurements: {} as Record<string, number>,
  storageLocation: "",
};
function ItemEditor({ id }: { id: string }) {
  const { categories, go, toast, user } = useApp();
  const {
    data: item,
    setData,
    error,
    loading,
    reload,
  } = useLoad<Item>(id === "new" ? null : `/staff/items/${id}`);
  const [form, setForm] = useState(initialItem),
    [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState(false),
    [uploadStatus, setUploadStatus] = useState(""),
    [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const mutation = useMutation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState(false);
  const [price, setPrice] = useState("");
  useEffect(() => {
    if (item) {
      setForm({
        title: item.title,
        sku: item.sku,
        category: item.category,
        priceMinor: item.priceMinor,
        attributes: { ...initialItem.attributes, ...item.attributes },
        measurements: item.measurements || {},
        storageLocation: item.storageLocation || "",
      });
      setPrice(String(item.priceMinor / 100));
      setDirty(false);
    }
  }, [item]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  const set = (key: string, value: string) => {
    setForm((v) => ({ ...v, [key]: value }));
    setDirty(true);
  };
  const attr = (key: string, value: string | number) => {
    setForm((v) => ({ ...v, attributes: { ...v.attributes, [key]: value } }));
    setDirty(true);
  };
  const save = async () => {
    const data = {
      ...form,
      sku: form.sku.trim() || undefined,
      priceMinor: Math.round(Number(price.replace(",", ".")) * 100),
      ...(item ? { version: item.version } : {}),
    };
    const result = await mutation.run<Item>(
      id === "new" ? "/staff/items" : `/staff/items/${id}`,
      data,
      id === "new" ? "POST" : "PATCH",
    );
    if (result) {
      setData(result);
      setDirty(false);
      toast("Карточка сохранена");
      if (id === "new") go(`/staff/items/${result.id}`);
    }
    return result;
  };
  const upload = async (files: File[]) => {
    if (!item) {
      mutation.setError(
        new Error("Сначала сохраните карточку, затем добавьте фотографии."),
      );
      return;
    }
    setUploadFiles(files);
    for (let i = 0; i < files.length; i++) {
      setUploadStatus(`Загружаем ${i + 1} из ${files.length}…`);
      const body = new FormData();
      body.append("itemId", item.id);
      body.append("file", files[i]);
      try {
        await api<Media>("/staff/media/uploads", { method: "POST", body });
        setUploadFiles(files.slice(i + 1));
      } catch (e) {
        mutation.setError(e);
        setUploadStatus("Загрузка прервана. Остальные файлы можно повторить.");
        reload();
        return;
      }
    }
    setUploadFiles([]);
    setUploadStatus("Фотографии обработаны и сохранены");
    reload();
  };
  const mediaAction = async (
    media: Media,
    body: Record<string, unknown>,
    method = "PATCH",
  ) => {
    await mutation.run(`/staff/media/${media.id}`, body, method);
    reload();
  };
  if (loading && !item) return <Loading />;
  const measurementKeys =
    categories.find((c) => c.id === form.category)?.measurements ||
    Object.keys(measurementNames);
  const missing = [
    !form.title ? "Название" : "",
    !Number(price) ? "Цена" : "",
    !form.storageLocation ? "Место хранения" : "",
    !item?.media?.length ? "Фото" : "",
    ...["material", "care", "manufacturer", "importer", "origin", "documents"]
      .filter((k) => !form.attributes[k])
      .map(
        (k) =>
          ({
            material: "Состав",
            care: "Уход",
            manufacturer: "Изготовитель",
            importer: "Импортёр",
            origin: "Происхождение",
            documents: "Документы",
          })[k] || k,
      ),
  ].filter(Boolean);
  return (
    <div className="page narrow item-editor">
      <h1>{id === "new" ? "Новая вещь" : "Карточка вещи"}</h1>
      <p className="muted">Одна карточка — один физический экземпляр</p>
      <ErrorBox error={error} retry={reload} />
      {mutation.recovery}
      {item && (
        <div className="status-strip">
          <span>{statusNames[item.publication] || item.publication}</span>
          <span>{statusNames[item.physical] || item.physical}</span>
          <span>Версия {item.version}</span>
        </div>
      )}
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field
          label="Название"
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          required
        />
        <Field
          label="Артикул"
          value={form.sku}
          onChange={(e) => set("sku", e.target.value)}
          hint="Оставьте пустым при создании для автоматического артикула."
        />
        <Select
          label="Категория"
          value={form.category}
          onChange={(e) => set("category", e.target.value)}
        >
          {categories.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Field
          label="Цена, BYN"
          value={price}
          inputMode="decimal"
          required
          onChange={(e) => {
            setPrice(e.target.value);
            setDirty(true);
          }}
        />
        <Field
          label="Место хранения"
          value={form.storageLocation}
          onChange={(e) => set("storageLocation", e.target.value)}
          placeholder="Например, зал · рейл 2"
        />
        {!["bags", "accessories"].includes(form.category) && (
          <div className="form-pair">
            <Select
              label="Размерная система"
              value={String(form.attributes.sizeSystem || "INT")}
              onChange={(e) => attr("sizeSystem", e.target.value)}
            >
              {["INT", "EU", "RU", "US", "Без бирки"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
            <Field
              label="Размер на бирке"
              value={String(form.attributes.sizeLabel || "")}
              onChange={(e) => attr("sizeLabel", e.target.value)}
            />
          </div>
        )}
        {form.category === "children" && (
          <Field
            label="Рост, см"
            type="number"
            min="1"
            value={form.attributes.height || ""}
            onChange={(e) => attr("height", Number(e.target.value))}
          />
        )}
        <Select
          label="Назначение"
          value={String(form.attributes.audience || "Унисекс")}
          onChange={(e) => attr("audience", e.target.value)}
        >
          {["Женское", "Мужское", "Унисекс", "Детское"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        <h2>Замеры, см</h2>
        <p className="small-text">
          Введите фактические размеры. Грудь, талия и бёдра — полуобхват.
        </p>
        <div className="form-pair">
          {measurementKeys.map((key) => (
            <Field
              key={key}
              label={measurementNames[key] || key}
              type="number"
              min="0"
              step="0.1"
              value={form.measurements[key] ? form.measurements[key] / 10 : ""}
              onChange={(e) => {
                const value = Math.round(Number(e.target.value) * 10);
                setForm((v) => ({
                  ...v,
                  measurements: { ...v.measurements, [key]: value },
                }));
                setDirty(true);
              }}
            />
          ))}
        </div>
        <h2>Сведения о новой вещи</h2>
        {[
          ["brand", "Бренд"],
          ["color", "Цвет"],
          ["season", "Сезон"],
          ["material", "Состав"],
          ["care", "Уход"],
          ["manufacturer", "Изготовитель"],
          ["importer", "Импортёр"],
          ["origin", "Страна происхождения"],
          ["documents", "Маркировка и документы"],
        ].map(([key, label]) => (
          <Field
            key={key}
            label={label}
            value={String(form.attributes[key] || "")}
            onChange={(e) => attr(key, e.target.value)}
          />
        ))}
        <Button type="submit" disabled={mutation.busy}>
          {mutation.busy ? "Сохраняем…" : "Сохранить карточку"}
        </Button>
        {dirty && (
          <p className="small-text">
            Есть несохранённые изменения. Сохраните их перед выходом.
          </p>
        )}
      </form>
      <section className="detail-section">
        <div className="section-heading">
          <h2>Фотографии</h2>
          <Button
            secondary
            disabled={!item || Boolean(uploadFiles.length)}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="plus" size={18} />
            Добавить
          </Button>
        </div>
        <input
          ref={fileInput}
          hidden
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            if (e.target.files) upload(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        <p className="small-text">
          До 12 фото по 15 МБ. Общий вид, обратная сторона, бирка и детали.
          Геолокация удаляется сервером.
        </p>
        {uploadStatus && <p role="status">{uploadStatus}</p>}
        {uploadFiles.length > 0 && (
          <Button secondary onClick={() => upload(uploadFiles)}>
            Повторить оставшиеся файлы
          </Button>
        )}
        <div className="media-editor">
          {item?.media.map((media, index) => (
            <div key={media.id}>
              <Photo media={media} alt={`Фото ${index + 1}`} />
              <Select
                label={`Тип фото ${index + 1}`}
                value={media.role || "FRONT"}
                onChange={(e) =>
                  mediaAction(media, { role: e.target.value, position: index })
                }
              >
                {[
                  ["FRONT", "Общий вид"],
                  ["BACK", "Сзади"],
                  ["LABEL", "Бирка"],
                  ["MEASUREMENT", "Замер"],
                  ["DETAIL", "Деталь"],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
              <div className="photo-actions">
                <button
                  className="icon-button"
                  aria-label="Переместить раньше"
                  disabled={index === 0 || mutation.busy}
                  onClick={() => mediaAction(media, { position: index - 1 })}
                >
                  <Icon name="back" size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Повернуть фото"
                  disabled={mutation.busy}
                  onClick={() => mediaAction(media, { rotation: 90 })}
                >
                  ↻
                </button>
                <button
                  className="icon-button"
                  aria-label="Удалить фото"
                  disabled={mutation.busy}
                  onClick={() => {
                    if (confirm("Удалить фотографию из карточки?"))
                      mediaAction(media, {}, "DELETE");
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
      {item && (
        <section className="detail-section">
          <h2>Публикация и наличие</h2>
          <div className="button-stack">
            <Button secondary onClick={() => setPreview(true)}>
              Предпросмотр карточки
            </Button>
            {item.publication === "PUBLISHED" ? (
              <Button
                secondary
                disabled={mutation.busy}
                onClick={() =>
                  mutation
                    .run<Item>(`/staff/items/${id}/hide`, {
                      version: item.version,
                    })
                    .then((result) => {
                      if (result) setData(result);
                    })
                }
              >
                Снять с витрины
              </Button>
            ) : (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                  />
                  <span>
                    Проверил вещь, маркировку и фактическое наличие в зале
                  </span>
                </label>
                <Button
                  disabled={!checked || dirty || mutation.busy}
                  onClick={() =>
                    mutation
                      .run<Item>(`/staff/items/${id}/publish`, {
                        version: item.version,
                        checked: true,
                      })
                      .then((result) => {
                        if (result) {
                          setData(result);
                          toast("Вещь опубликована");
                        }
                      })
                  }
                >
                  Опубликовать
                </Button>
              </>
            )}
            {item.physical === "INSPECTION" && (
              <Button
                secondary
                disabled={mutation.busy}
                onClick={() => {
                  if (
                    confirm(
                      "Вещь осмотрена, пригодна к повторной продаже и возвращена на место в зале?",
                    )
                  )
                    mutation
                      .run<Item>(`/staff/items/${id}/inspect`, {
                        version: item.version,
                        suitable: true,
                        reason: "Физически осмотрена и возвращена в зал",
                      })
                      .then((result) => {
                        if (result) setData(result);
                      });
                }}
              >
                Осмотрена — вернуть в продажу
              </Button>
            )}
            {user?.role === "OWNER" && item.physical === "INSPECTION" && (
              <Button
                secondary
                danger
                disabled={mutation.busy}
                onClick={() => {
                  const reason = prompt("Причина списания и документ");
                  if (reason)
                    mutation
                      .run<Item>(`/staff/items/${id}/write-off`, {
                        version: item.version,
                        reason,
                      })
                      .then((result) => {
                        if (result) setData(result);
                      });
                }}
              >
                Списать по результату проверки
              </Button>
            )}
          </div>
        </section>
      )}
      {preview && (
        <Sheet title="Предпросмотр" onClose={() => setPreview(false)}>
          <Photo media={item?.media[0]} alt={form.title} contain />
          <h1>{form.title || "Название не заполнено"}</h1>
          <p>
            {form.attributes.sizeSystem} {form.attributes.sizeLabel}
          </p>
          <strong>{money(Math.round(Number(price) * 100))}</strong>
          <dl className="details-list">
            {Object.entries(form.measurements)
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{measurementNames[k] || k}</dt>
                  <dd>{v / 10} см</dd>
                </div>
              ))}
          </dl>
          <p>{form.attributes.material}</p>
          {missing.length > 0 && (
            <div className="notice">
              <strong>До публикации заполните</strong>
              <p>{missing.join(", ")}</p>
            </div>
          )}
          <Button onClick={() => setPreview(false)}>
            Вернуться к редактированию
          </Button>
        </Sheet>
      )}
    </div>
  );
}
function StaffOrder({ id }: { id: string }) {
  const { go, toast } = useApp();
  const {
    data: order,
    setData,
    error,
    loading,
    reload,
  } = useLoad<Order>(`/orders/${id}`);
  const mutation = useMutation();
  const [found, setFound] = useState<string[]>([]),
    [accepted, setAccepted] = useState<string[]>([]),
    [handover, setHandover] = useState<string | null>(null),
    [code, setCode] = useState(""),
    [tracking, setTracking] = useState(""),
    [source, setSource] = useState(""),
    [note, setNote] = useState(""),
    [propose, setPropose] = useState(false),
    [proposed, setProposed] = useState<string[]>([]),
    [message, setMessage] = useState(""),
    [respondBy, setRespondBy] = useState(""),
    [returnReason, setReturnReason] = useState(""),
    [returnLines, setReturnLines] = useState<string[]>([]),
    [showReturn, setShowReturn] = useState(false),
    [shipmentState, setShipmentState] = useState("IN_TRANSIT");
  useEffect(() => {
    if (order) {
      setFound(order.lines.filter((l) => l.checked).map((l) => l.itemId));
      setAccepted(
        order.lines
          .filter((l) => ["RESERVED", "RELEASE_PENDING"].includes(l.outcome))
          .map((l) => l.id),
      );
      setProposed(
        order.lines
          .filter((l) => ["RESERVED", "RELEASE_PENDING"].includes(l.outcome))
          .map((l) => l.id),
      );
      const extra = order as Order & {
        handoverId?: string;
        handover?: { id: string };
      };
      if (extra.handoverId || extra.handover?.id)
        setHandover(extra.handoverId || extra.handover?.id || null);
    }
  }, [order]);
  const action = async (path: string, body: Record<string, unknown>) => {
    const result = await mutation.run<Order>(path, body);
    if (result?.id) setData(result);
    else if (result) reload();
    return result;
  };
  if (loading && !order) return <Loading />;
  if (!order)
    return (
      <div className="page">
        <ErrorBox error={error} retry={reload} />
      </div>
    );
  const reserved = order.lines.filter((l) =>
    ["RESERVED", "RELEASE_PENDING"].includes(l.outcome),
  );
  const terminal = [
    "FULFILLED",
    "CANCELLED",
    "EXPIRED",
    "RETURNED",
    "CLOSED",
  ].includes(order.status);
  const canShipment = order.status === "PREPARING";
  const cancelRequest = order.cancelRequested as unknown as
    | { type?: string; lineIds?: string[]; recipient?: Record<string, string> }
    | undefined;
  return (
    <div className="page narrow staff-order">
      <div className="section-heading">
        <h1>№{order.number}</h1>
        <button
          className="icon-button"
          aria-label="Обновить обращение"
          onClick={reload}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <p className="muted">
        {methodNames[order.method]} · {date(order.createdAt)}
      </p>
      <div className="status-strip">
        <strong>{statusNames[order.status] || order.status}</strong>
        <span>Версия {order.version}</span>
      </div>
      {order.verifyBy && order.status === "CHECKING" && (
        <div className="notice">
          <Icon name="clock" />
          <span>Проверить до {date(order.verifyBy)}</span>
        </div>
      )}
      {order.pickupDeadline && order.status === "READY_FOR_PICKUP" && (
        <div className="notice">
          <Icon name="clock" />
          <span>Храним до {date(order.pickupDeadline)}</span>
        </div>
      )}
      {order.dispatchDeadline && order.status === "PREPARING" && (
        <div className="notice">Сдать до {date(order.dispatchDeadline)}</div>
      )}
      <ErrorBox error={error} retry={reload} />
      {mutation.recovery}
      <Button
        secondary
        disabled={mutation.busy}
        onClick={() =>
          action(`/staff/orders/${id}/assign`, { version: order.version })
        }
      >
        Взять обращение в работу
      </Button>
      <section className="detail-section">
        <h2>Состав · {order.lines.length} вещей</h2>
        <div className="item-list">
          {order.lines.map((line) => (
            <div className="item-row" key={line.id}>
              <button
                className="row-photo"
                onClick={() => go(`/staff/items/${line.itemId}`)}
              >
                <Photo media={line.media?.[0]} alt={line.title} />
              </button>
              <div className="row-content">
                <strong>{line.title}</strong>
                <p className="muted">
                  {line.sku} · {line.attributes?.sizeLabel}
                </p>
                <p className="small-text">
                  {line.storageLocation || "Место хранения — в карточке вещи"}
                </p>
                <strong>{money(line.priceMinor)}</strong>
                <p className="small-text">
                  {statusNames[line.outcome] || line.outcome}
                </p>
                {order.status === "CHECKING" &&
                  ["RESERVED", "RELEASE_PENDING"].includes(line.outcome) && (
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={found.includes(line.itemId)}
                        onChange={(e) =>
                          setFound((v) =>
                            e.target.checked
                              ? [...v, line.itemId]
                              : v.filter((i) => i !== line.itemId),
                          )
                        }
                      />
                      <span>Найдена и убрана в пакет</span>
                    </label>
                  )}
              </div>
            </div>
          ))}
        </div>
        <Summary label="Стоимость вещей">{money(order.totalMinor)}</Summary>
        {order.status === "CHECKING" && (
          <div className="button-stack section-space">
            <Button
              disabled={mutation.busy}
              onClick={() =>
                action(`/staff/orders/${id}/verify`, {
                  version: order.version,
                  foundItemIds: found,
                })
              }
            >
              Сохранить построчную проверку
            </Button>
            <Button
              disabled={
                mutation.busy ||
                !reserved.length ||
                !reserved.every((l) => l.checked)
              }
              onClick={() =>
                action(`/staff/orders/${id}/ready`, { version: order.version })
              }
            >
              {order.method === "PICKUP"
                ? "Можно забирать"
                : "Проверено — готовим к отправке"}
            </Button>
            <p className="small-text">
              Готовность доступна после сохранённой проверки каждой вещи.
            </p>
            <Button secondary onClick={() => setPropose(true)}>
              Недостача — согласовать новый состав
            </Button>
          </div>
        )}
      </section>
      <section className="detail-section">
        <h2>Контакт и получение</h2>
        <p>{order.recipient?.fullName}</p>
        {order.recipient?.phone && (
          <a className="text-link" href={`tel:${order.recipient.phone}`}>
            {order.recipient.phone}
          </a>
        )}
        {order.method !== "PICKUP" && (
          <>
            <p>
              {order.recipient?.city}, {order.recipient?.office}
            </p>
            <p>Индекс {order.recipient?.postalCode || "не указан"}</p>
            <Copy
              value={[
                order.recipient?.fullName,
                order.recipient?.phone,
                order.recipient?.city,
                order.recipient?.office,
                order.recipient?.postalCode,
              ]
                .filter(Boolean)
                .join("\n")}
              label="Скопировать данные в кабинет почты"
            />
          </>
        )}
        <p className="muted">
          Переписка — в аккаунте магазина. При отсутствии username связывайтесь
          по указанному телефону.
        </p>
      </section>
      {cancelRequest && (
        <section className="notice">
          <h2>
            Запрос покупателя:{" "}
            {cancelRequest.type === "RECIPIENT"
              ? "новые данные получателя"
              : "отмена"}
          </h2>
          {cancelRequest.recipient && (
            <p>{Object.values(cancelRequest.recipient).join(", ")}</p>
          )}
          <Field
            label="Источник подтверждения / пояснение"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <div className="button-stack">
            <Button
              disabled={!source || mutation.busy}
              onClick={() =>
                action(`/staff/orders/${id}/change-request`, {
                  version: order.version,
                  approve: true,
                  source,
                })
              }
            >
              Подтвердить после проверки
            </Button>
            <Button
              secondary
              disabled={!source || mutation.busy}
              onClick={() =>
                action(`/staff/orders/${id}/change-request`, {
                  version: order.version,
                  approve: false,
                  source,
                })
              }
            >
              Отклонить с пояснением
            </Button>
          </div>
          <p>До решения не сдавайте посылку перевозчику.</p>
        </section>
      )}
      {order.status === "READY_FOR_PICKUP" && (
        <section className="detail-section">
          <h2>Начать выдачу</h2>
          <p>
            Попросите покупателя открыть код в Mini App. Проверяйте его до
            фактической передачи вещей.
          </p>
          <Field
            label="Код выдачи"
            inputMode="numeric"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button
            disabled={!code || mutation.busy}
            onClick={async () => {
              const result = await mutation.run<{
                id: string;
                orderId: string;
              }>(`/staff/orders/${id}/handovers`, {
                version: order.version,
                code,
              });
              if (result) {
                setHandover(result.id);
                reload();
              }
            }}
          >
            Проверить код и начать выдачу
          </Button>
        </section>
      )}
      {order.status === "HANDOVER" && (
        <section className="detail-section">
          <h2>Выдача и примерка</h2>
          <p>
            Отметьте фактически принимаемые вещи. Остальные перейдут на осмотр.
            Расчёт проводится вне приложения.
          </p>
          {reserved.map((line) => (
            <label className="check-row" key={line.id}>
              <input
                type="checkbox"
                checked={accepted.includes(line.id)}
                onChange={(e) =>
                  setAccepted((v) =>
                    e.target.checked
                      ? [...v, line.id]
                      : v.filter((i) => i !== line.id),
                  )
                }
              />
              <span>
                {line.title}
                <small>{money(line.priceMinor)}</small>
              </span>
            </label>
          ))}
          <Summary label="Принимаемые вещи">
            {money(
              order.lines
                .filter((l) => accepted.includes(l.id))
                .reduce((s, l) => s + l.priceMinor, 0),
            )}
          </Summary>
          <Button
            disabled={!handover || mutation.busy}
            onClick={() => {
              if (
                confirm(
                  "Фактическая выдача подтверждена? Неотмеченные вещи уйдут на осмотр.",
                )
              )
                action(`/staff/handovers/${handover}/complete`, {
                  acceptedLineIds: accepted,
                });
            }}
          >
            Подтвердить фактическую выдачу
          </Button>
          {!handover && (
            <p className="field-error">
              Не найден ID выдачи. Обновите обращение; до выяснения не
              передавайте вещи повторно.
            </p>
          )}
        </section>
      )}
      {canShipment && (
        <section className="detail-section">
          <h2>Оформление вручную</h2>
          <p>
            Оформите посылку в корпоративном кабинете выбранной почты. Ввод
            трека ещё не означает сдачу.
          </p>
          <Field
            label="Номер отправления / трек"
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
          />
          <Field
            label="Источник / документ оформления"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <Button
            disabled={
              !tracking || !source || mutation.busy || Boolean(cancelRequest)
            }
            onClick={() =>
              action("/staff/shipments", {
                orderId: id,
                version: order.version,
                tracking,
                source,
              })
            }
          >
            Сохранить оформленное отправление
          </Button>
        </section>
      )}
      {order.shipment && (
        <section className="detail-section">
          <h2>
            Посылка ·{" "}
            {statusNames[order.shipment.status] || order.shipment.status}
          </h2>
          <Summary label="Трек">{order.shipment.tracking}</Summary>
          <Copy value={order.shipment.tracking} label="Скопировать трек" />
          <p className="small-text">
            Последняя проверка {date(order.shipment.updatedAt)} ·{" "}
            {order.shipment.source}
          </p>
          <Field
            label="Подтверждённый источник / документ"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            hint="Например, квитанция приёмки или сведения официального отслеживания с датой."
          />
          {order.shipment.status === "REGISTERED" && (
            <div className="button-stack">
              <Button
                disabled={!source || mutation.busy || Boolean(cancelRequest)}
                onClick={() => {
                  if (
                    confirm(
                      "Почта фактически приняла посылку, есть подтверждение?",
                    )
                  )
                    action(
                      `/staff/shipments/${order.shipment?.id}/acceptance`,
                      { version: order.version, source },
                    );
                }}
              >
                Подтвердить фактическую сдачу
              </Button>
              <Button
                secondary
                disabled={!source || mutation.busy}
                onClick={() => {
                  if (
                    confirm(
                      "Отмена оформленного отправления у перевозчика подтверждена?",
                    )
                  )
                    action(`/staff/shipments/${order.shipment?.id}/cancel`, {
                      version: order.version,
                      source,
                    });
                }}
              >
                Почта подтвердила отмену
              </Button>
            </div>
          )}
          {![
            "REGISTERED",
            "CANCELLED",
            "DELIVERED",
            "RETURN_RECEIVED",
          ].includes(order.shipment.status) && (
            <div className="form-stack">
              <Select
                label="Подтверждённый статус"
                value={shipmentState}
                onChange={(e) => setShipmentState(e.target.value)}
              >
                {[
                  "IN_TRANSIT",
                  "AT_OFFICE",
                  "DELIVERED",
                  "RETURN_IN_TRANSIT",
                  "RETURN_RECEIVED",
                  "LOST_OR_DAMAGED",
                ].map((s) => (
                  <option key={s} value={s}>
                    {statusNames[s]}
                  </option>
                ))}
              </Select>
              {shipmentState === "DELIVERED" && (
                <>
                  <p>
                    Отметьте фактически выданные строки. Частичная выдача
                    возможна только по подтверждённой услуге перевозчика.
                  </p>
                  {order.lines
                    .filter(
                      (l) => !["CANCELLED", "EXPIRED"].includes(l.outcome),
                    )
                    .map((line) => (
                      <label className="check-row" key={line.id}>
                        <input
                          type="checkbox"
                          checked={accepted.includes(line.id)}
                          onChange={(e) =>
                            setAccepted((v) =>
                              e.target.checked
                                ? [...v, line.id]
                                : v.filter((i) => i !== line.id),
                            )
                          }
                        />
                        <span>{line.title}</span>
                      </label>
                    ))}
                </>
              )}
              <Button
                disabled={!source || mutation.busy}
                onClick={() =>
                  action(`/staff/shipments/${order.shipment?.id}/events`, {
                    version: order.version,
                    status: shipmentState,
                    source,
                    ...(shipmentState === "DELIVERED"
                      ? { deliveredLineIds: accepted }
                      : {}),
                  })
                }
              >
                Зафиксировать подтверждённый статус
              </Button>
              <Button
                secondary
                disabled={!source || mutation.busy}
                onClick={() =>
                  action(
                    `/staff/shipments/${order.shipment?.id}/return-request`,
                    { version: order.version, source },
                  )
                }
              >
                Запросить возврат у перевозчика
              </Button>
            </div>
          )}
        </section>
      )}
      <section className="detail-section">
        <h2>Служебная заметка</h2>
        <p className="small-text">
          Без секретов и лишних персональных данных. Переписка остаётся в
          аккаунте магазина.
        </p>
        <Textarea
          label="Результат связи / следующий шаг"
          value={note}
          onChange={setNote}
        />
        <Button
          secondary
          disabled={!note.trim() || mutation.busy}
          onClick={async () => {
            const result = await action(`/staff/orders/${id}/note`, {
              version: order.version,
              note,
            });
            if (result) setNote("");
          }}
        >
          Сохранить заметку
        </Button>
        {order.notes?.map((n, i) => (
          <p className="small-text pre-wrap" key={i}>
            {date(n.createdAt)} · {n.note}
          </p>
        ))}
      </section>
      <section className="detail-section">
        <h2>Отказ и возврат</h2>
        <div className="button-stack">
          {!terminal && order.status !== "HANDOVER" && (
            <Button
              secondary
              disabled={mutation.busy}
              onClick={() => {
                if (
                  confirm(
                    "Отменить обращение? Если посылка готовится или уже сдана, будет создан запрос проверки.",
                  )
                )
                  action(`/orders/${id}/cancel`, { version: order.version });
              }}
            >
              Отменить по согласованному отказу
            </Button>
          )}
          <Button
            secondary
            onClick={() => {
              setReturnLines(
                order.lines
                  .filter((l) => ["HANDED_OVER", "SOLD"].includes(l.outcome))
                  .map((l) => l.id),
              );
              setShowReturn(true);
            }}
          >
            Зафиксировать возврат вещи
          </Button>
          <Button ghost onClick={() => go("/staff/returns")}>
            Открыть очередь возвратов
          </Button>
        </div>
      </section>
      {propose && (
        <Sheet
          title="Предложить новый состав"
          onClose={() => setPropose(false)}
        >
          <p>
            Выберите строки, которые магазин может подтвердить. Покупатель
            должен явно принять новый состав.
          </p>
          {reserved.map((line) => (
            <label key={line.id} className="check-row">
              <input
                type="checkbox"
                checked={proposed.includes(line.id)}
                onChange={(e) =>
                  setProposed((v) =>
                    e.target.checked
                      ? [...v, line.id]
                      : v.filter((i) => i !== line.id),
                  )
                }
              />
              <span>{line.title}</span>
            </label>
          ))}
          <Textarea
            label="Что изменилось и почему"
            value={message}
            onChange={setMessage}
          />
          <Field
            label="Ответить до, время Минска"
            type="datetime-local"
            value={respondBy}
            onChange={(e) => setRespondBy(e.target.value)}
          />
          {mutation.recovery}
          <Button
            disabled={
              !proposed.length || !message || !respondBy || mutation.busy
            }
            onClick={async () => {
              const result = await action(`/staff/orders/${id}/propose`, {
                version: order.version,
                lineIds: proposed,
                message,
                respondBy: new Date(`${respondBy}:00+03:00`).toISOString(),
              });
              if (result) setPropose(false);
            }}
          >
            Передать предложение покупателю
          </Button>
        </Sheet>
      )}
      {showReturn && (
        <Sheet title="Возврат товара" onClose={() => setShowReturn(false)}>
          <p>
            История исходной продажи сохраняется. Возврат денег при
            необходимости выполняется отдельно.
          </p>
          {order.lines
            .filter((l) => ["HANDED_OVER", "SOLD"].includes(l.outcome))
            .map((line) => (
              <label key={line.id} className="check-row">
                <input
                  type="checkbox"
                  checked={returnLines.includes(line.id)}
                  onChange={(e) =>
                    setReturnLines((v) =>
                      e.target.checked
                        ? [...v, line.id]
                        : v.filter((i) => i !== line.id),
                    )
                  }
                />
                <span>{line.title}</span>
              </label>
            ))}
          <Textarea
            label="Причина и требование покупателя"
            value={returnReason}
            onChange={setReturnReason}
          />
          {mutation.recovery}
          <Button
            disabled={!returnLines.length || !returnReason || mutation.busy}
            onClick={async () => {
              const result = await mutation.run<Return>("/staff/returns", {
                orderId: id,
                lineIds: returnLines,
                reason: returnReason,
              });
              if (result) {
                setShowReturn(false);
                toast("Возврат зафиксирован");
                go("/staff/returns");
              }
            }}
          >
            Создать служебный возврат
          </Button>
        </Sheet>
      )}
    </div>
  );
}
function Search() {
  const { go } = useApp();
  const [q, setQ] = useState(""),
    [search, setSearch] = useState("");
  const { data, error, loading, reload } = useLoad<{
    items: Item[];
    orders: Order[];
  }>(search ? `/staff/search?q=${encodeURIComponent(search)}` : null);
  return (
    <div className="page narrow">
      <h1>Найти</h1>
      <form
        className="search-row"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q);
        }}
      >
        <label className="search-pill">
          <Icon name="search" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Артикул, номер, имя, телефон"
            aria-label="Поиск по магазину"
          />
        </label>
        <button className="search-cta" type="submit" aria-label="Найти">
          <Icon name="search" />
        </button>
      </form>
      <p className="small-text">Поиск по данным покупателей журналируется.</p>
      <ErrorBox error={error} retry={reload} />
      {loading ? (
        <Loading />
      ) : !search ? (
        <Empty title="Введите артикул или номер">
          Также можно найти обращение по телефону или имени получателя.
        </Empty>
      ) : (
        <>
          {data?.items.length ? (
            <section>
              <h2>Вещи</h2>
              {data.items.map((item) => (
                <button
                  key={item.id}
                  className="item-row staff-item-row"
                  onClick={() => go(`/staff/items/${item.id}`)}
                >
                  <Photo media={item.media[0]} alt={item.title} />
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.sku}</p>
                    <p className="muted">
                      {statusNames[item.physical] || item.physical}
                    </p>
                  </div>
                  <Icon name="next" />
                </button>
              ))}
            </section>
          ) : null}
          {data?.orders.length ? (
            <section>
              <h2>Обращения</h2>
              {data.orders.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  onOpen={() => go(`/staff/orders/${order.id}`)}
                />
              ))}
            </section>
          ) : null}
          {!data?.items.length && !data?.orders.length && (
            <Empty title="Ничего не найдено">
              Проверьте номер или попробуйте другой запрос.
            </Empty>
          )}
        </>
      )}
    </div>
  );
}
function Counter() {
  const { go, toast } = useApp();
  const [q, setQ] = useState(""),
    [chosen, setChosen] = useState<Item[]>([]),
    [scan, setScan] = useState(false),
    [operation, setOperation] = useState<{ id: string; items: Item[] } | null>(
      () => {
        const saved = readLocal<{ id: string; itemIds: string[] } | null>(
          "counter-operation",
          null,
        );
        return saved ? { id: saved.id, items: [] } : null;
      },
    );
  const { data, error, loading, reload } = useLoad<{ items: Item[] }>(
    `/staff/items?q=${encodeURIComponent(q)}&state=AVAILABLE`,
  );
  const mutation = useMutation();
  useEffect(() => {
    const saved = readLocal<{ id: string; itemIds: string[] } | null>(
      "counter-operation",
      null,
    );
    if (saved)
      Promise.all(
        saved.itemIds.map((itemId) => api<Item>(`/staff/items/${itemId}`)),
      )
        .then((items) => setOperation({ id: saved.id, items }))
        .catch(mutation.setError);
  }, []);
  return (
    <div className="page narrow">
      <h1>Продажа в магазине</h1>
      <p className="muted">
        Закрепите опубликованные вещи до расчёта и фактической передачи. Чужую
        бронь перезаписать нельзя.
      </p>
      {mutation.recovery}
      <ErrorBox error={error} retry={reload} />
      {!operation ? (
        <>
          <Field
            label="Артикул / название"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button
            secondary
            onClick={() =>
              scanSku(
                (value) => setQ(value),
                () => setScan(true),
              )
            }
          >
            <Icon name="photo" size={18} />
            Сканировать бирку
          </Button>
          {loading ? (
            <Loading />
          ) : (
            <div>
              {data?.items.map((item) => (
                <label key={item.id} className="item-row check-item">
                  <input
                    type="checkbox"
                    checked={chosen.some((i) => i.id === item.id)}
                    onChange={(e) =>
                      setChosen((v) =>
                        e.target.checked
                          ? [...v, item]
                          : v.filter((i) => i.id !== item.id),
                      )
                    }
                  />
                  <Photo media={item.media[0]} alt={item.title} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.sku} · {money(item.priceMinor)}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          )}
          <Summary label={`Выбрано ${chosen.length} вещей`}>
            {money(chosen.reduce((s, i) => s + i.priceMinor, 0))}
          </Summary>
          <Button
            disabled={!chosen.length || mutation.busy}
            onClick={async () => {
              const result = await mutation.run<{ id: string; items: Item[] }>(
                "/staff/availability-operations",
                { itemIds: chosen.map((i) => i.id) },
              );
              if (result) {
                setOperation(result);
                saveLocal("counter-operation", {
                  id: result.id,
                  itemIds: chosen.map((i) => i.id),
                });
              }
            }}
          >
            Закрепить перед продажей
          </Button>
        </>
      ) : (
        <section className="notice">
          <h2>Вещи закреплены за этой операцией</h2>
          {(operation.items || chosen).map((item) => (
            <p key={item.id}>
              {item.title} · {item.sku} · {money(item.priceMinor)}
            </p>
          ))}
          <p>
            Расчёт проводится в кассе вне Mini App. После фактической передачи
            подтвердите продажу. При неизвестном результате вещи останутся
            недоступны до проверки.
          </p>
          <div className="button-stack">
            <Button
              disabled={mutation.busy}
              onClick={async () => {
                if (
                  !confirm("Фактическая передача выбранных вещей подтверждена?")
                )
                  return;
                const result = await mutation.run(
                  `/staff/availability-operations/${operation.id}/complete`,
                  { sold: true },
                );
                if (result) {
                  saveLocal("counter-operation", null);
                  toast("Продажа отмечена");
                  go("/staff/items");
                }
              }}
            >
              Фактически продано
            </Button>
            <Button
              secondary
              disabled={mutation.busy}
              onClick={async () => {
                const result = await mutation.run(
                  `/staff/availability-operations/${operation.id}/complete`,
                  { sold: false },
                );
                if (result) {
                  saveLocal("counter-operation", null);
                  setOperation(null);
                  setChosen([]);
                  reload();
                  toast(
                    "Продажа отменена. Проверьте вещи перед возвратом в зал.",
                  );
                }
              }}
            >
              Продажа не состоялась
            </Button>
          </div>
        </section>
      )}
      {scan && (
        <Scanner
          onClose={() => setScan(false)}
          onResult={(value) => {
            setQ(value);
            setScan(false);
          }}
        />
      )}
    </div>
  );
}
function Returns() {
  const { user, go, toast, ownerCode, setOwnerCode } = useApp();
  const { data, error, loading, reload } = useLoad<{ returns: Return[] }>(
    "/staff/returns",
  );
  const mutation = useMutation();
  return (
    <div className="page narrow">
      <h1>Возвраты и осмотр</h1>
      {user?.role === "OWNER" && (
        <Field
          label="Код владельца для принятия решения"
          value={ownerCode}
          inputMode="numeric"
          autoComplete="one-time-code"
          onChange={(e) => setOwnerCode(e.target.value)}
        />
      )}
      <p className="muted">
        До физического приёма и проверки вещи остаются недоступны.
      </p>
      <ErrorBox error={error} retry={reload} />
      {mutation.recovery}
      {loading ? (
        <Loading />
      ) : !data?.returns.length ? (
        <Empty title="Возвратов пока нет">
          Служебный возврат создаётся из исходного обращения.
        </Empty>
      ) : (
        data.returns.map((ret) => (
          <section className="notice" key={ret.id}>
            <h2>Возврат · {statusNames[ret.status] || ret.status}</h2>
            <p>{ret.reason}</p>
            {ret.lines?.map((line) => (
              <p key={line.id}>
                {line.title} · {line.sku}
              </p>
            ))}
            <Button ghost onClick={() => go(`/staff/orders/${ret.orderId}`)}>
              Исходное обращение
            </Button>
            {ret.status === "OPEN" && (
              <Button
                secondary
                disabled={mutation.busy}
                onClick={async () => {
                  if (
                    !confirm(
                      "Возвращённые вещи фактически получены магазином и сверены?",
                    )
                  )
                    return;
                  const result = await mutation.run(
                    `/staff/returns/${ret.id}/receive`,
                    { version: ret.version },
                  );
                  if (result) {
                    reload();
                    toast("Возврат принят на осмотр");
                  }
                }}
              >
                Фактически принять вещи
              </Button>
            )}
            {user?.role === "OWNER" &&
              ["RECEIVED", "INSPECTION"].includes(ret.status) && (
                <div className="button-stack">
                  <Button
                    secondary
                    disabled={mutation.busy}
                    onClick={async () => {
                      const note = prompt(
                        "Результат осмотра, основание решения и подтверждение пригодности к повторной продаже",
                      );
                      if (!note) return;
                      const result = await mutation.run(
                        `/owner/returns/${ret.id}/resolve`,
                        { version: ret.version, suitable: true, note },
                      );
                      if (result) {
                        reload();
                        toast(
                          "Решение принято. Повторная публикация — отдельным действием в карточке вещи.",
                        );
                      }
                    }}
                  >
                    Осмотрена, пригодна для повторной продажи
                  </Button>
                  <Button
                    secondary
                    disabled={mutation.busy}
                    onClick={async () => {
                      const note = prompt(
                        "Что выявлено и какое решение принято?",
                      );
                      if (!note) return;
                      const result = await mutation.run(
                        `/owner/returns/${ret.id}/resolve`,
                        { version: ret.version, suitable: false, note },
                      );
                      if (result) reload();
                    }}
                  >
                    Не возвращать в продажу
                  </Button>
                </div>
              )}
          </section>
        ))
      )}
    </div>
  );
}

function scanSku(onResult: (value: string) => void, fallback: () => void) {
  const app = tg();
  if (
    app?.showScanQrPopup &&
    (!app.isVersionAtLeast || app.isVersionAtLeast("6.4"))
  ) {
    app.showScanQrPopup(
      { text: "Наведите камеру на QR-код бирки с артикулом" },
      (value) => {
        onResult(value.trim().slice(0, 80));
        app.closeScanQrPopup?.();
        return true;
      },
    );
  } else fallback();
}
interface BarcodeReader {
  detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}
function Scanner({
  onResult,
  onClose,
}: {
  onResult: (value: string) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    [error, setError] = useState<unknown>(null),
    [started, setStarted] = useState(false);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  useEffect(() => {
    if (!started) return;
    let stream: MediaStream | undefined,
      timer: ReturnType<typeof setInterval> | undefined,
      stopped = false,
      detecting = false;
    const start = async () => {
      try {
        const detectorClass = (
          window as unknown as {
            BarcodeDetector?: new (options: {
              formats: string[];
            }) => BarcodeReader;
          }
        ).BarcodeDetector;
        if (!detectorClass || !navigator.mediaDevices?.getUserMedia)
          throw new Error(
            "Камера сканера недоступна в этом браузере. Введите артикул в поле поиска или используйте QR-сканер Telegram.",
          );
        const detector = new detectorClass({
          formats: ["qr_code", "code_128", "ean_13"],
        });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
        }
        timer = setInterval(async () => {
          if (detecting || !video.current || video.current.readyState < 2)
            return;
          detecting = true;
          try {
            const results = await detector.detect(video.current);
            if (results[0]?.rawValue) {
              stopped = true;
              clearInterval(timer);
              stream?.getTracks().forEach((track) => track.stop());
              resultRef.current(results[0].rawValue.trim().slice(0, 80));
            }
          } catch (e) {
            setError(e);
          } finally {
            detecting = false;
          }
        }, 350);
      } catch (e) {
        setError(e);
      }
    };
    start();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [started]);
  return (
    <Sheet title="Сканировать артикул" onClose={onClose}>
      <p>
        Наведите камеру на QR-код или штрихкод бирки магазина. Изображение
        обрабатывается на устройстве.
      </p>
      {started && (
        <video
          ref={video}
          playsInline
          muted
          className="scanner-video"
          aria-label="Камера сканера"
        />
      )}
      <ErrorBox error={error} />
      {!started && (
        <Button onClick={() => setStarted(true)}>
          Разрешить камеру и начать
        </Button>
      )}
      <Button secondary onClick={onClose}>
        Ввести артикул вручную
      </Button>
    </Sheet>
  );
}
