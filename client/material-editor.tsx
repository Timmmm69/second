import { useState } from "react";
import { api } from "./api";
import type { MaterialOption } from "./types";
import { Button, ErrorBox, Field, Icon, Select, useLoad } from "./ui";

export type MaterialDraft = {
  key: number;
  materialId: string;
  name: string;
  percent: string;
};

export function MaterialEditor({
  value, onChange, onBusyChange, validationError, legacy,
}: {
  value: MaterialDraft[];
  onChange: (update: (rows: MaterialDraft[]) => MaterialDraft[]) => void;
  onBusyChange: (busy: boolean) => void;
  validationError?: string;
  legacy?: string;
}) {
  const catalog = useLoad<MaterialOption[]>("/staff/materials");
  const [added, setAdded] = useState<MaterialOption[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const materials = [...new Map([...(catalog.data ?? []), ...added]
    .map(material => [material.id, material])).values()]
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const setRow = (key: number, update: Partial<MaterialDraft>) =>
    onChange(rows => rows.map(row => row.key === key ? { ...row, ...update } : row));

  const choose = async (row: MaterialDraft, selected: string) => {
    const known = materials.find(material => material.id === selected);
    if (known) {
      setRow(row.key, { materialId: known.id, name: known.name });
      return;
    }
    if (!selected.trim() || pending) return;
    setPending(true);
    onBusyChange(true);
    setError(null);
    try {
      const material = await api<MaterialOption>("/staff/materials", {
        method: "POST", body: { name: selected },
      });
      setAdded(previous => previous.some(option => option.id === material.id)
        ? previous : [...previous, material]);
      setRow(row.key, { materialId: material.id, name: material.name });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  };

  const total = value.reduce((sum, row) =>
    sum + (/^\d+$/.test(row.percent) ? Number(row.percent) : 0), 0);
  return (
    <div className="composition-editor">
      <p className="small-text">Выберите материал или введите свой. Процент необязателен, если он неизвестен.</p>
      {legacy && <p className="small-text">Исходная запись с бирки: {legacy}</p>}
      <ErrorBox error={catalog.error} retry={catalog.reload} />
      <ErrorBox error={error} />
      {value.map((row, index) => (
        <div className="composition-row" key={row.key}>
          <Select label={`Материал ${index + 1}`}
            markEmpty
            value={row.materialId}
            searchPlaceholder="Найти или добавить материал"
            allowCustom
            disabled={pending || catalog.loading}
            options={materials.map(material => ({
              value: material.id, label: material.name,
              searchText: material.aliases.join(" "),
            }))}
            onValueChange={choice => { void choose(row, choice); }}
          />
          <Field label="Доля, %" markEmpty type="number" inputMode="numeric"
            min="1" max="100" step="1" placeholder="?"
            value={row.percent}
            onChange={event => setRow(row.key, { percent: event.target.value })}
          />
          <button type="button" className="icon-button composition-remove"
            aria-label={`Убрать материал ${index + 1}`}
            disabled={pending}
            onClick={() => onChange(rows => rows.length > 1
              ? rows.filter(part => part.key !== row.key)
              : [{ key: row.key, materialId: "", name: "", percent: "" }])}>
            <Icon name="close" size={18} />
          </button>
        </div>
      ))}
      <div className="composition-actions">
        <Button type="button" secondary disabled={pending || value.length >= 20}
          onClick={() => onChange(rows => [...rows, {
            key: Math.max(0, ...rows.map(row => row.key)) + 1,
            materialId: "", name: "", percent: "",
          }])}>
          <Icon name="plus" size={18} /> Добавить материал
        </Button>
        <span className="small-text">Указано: {total}% из 100%</span>
      </div>
      {validationError && <p className="field-error" role="alert">{validationError}</p>}
    </div>
  );
}
