type Attributes = Record<string, unknown>;

export const catalogAudiences = ["Женское", "Мужское", "Детское", "Унисекс", "Питомцы"] as const;

export function productColor(value: unknown) {
  const color = typeof value === "string" ? value.trim() : "";
  return !color.includes("#") && !/^(?:[\da-f]{6}|[\da-f]{8})$/i.test(color) && /\p{L}/u.test(color) ? color : "";
}

const letter = "(?:X*S|M|X*L|[1-9][0-9]*XL)";
const letterSize = new RegExp(`^${letter}(?:\\s*/\\s*${letter})?$`, "i");

export function isLetterSize(label: string) {
  return letterSize.test(label);
}

export function parseSizeInput(raw: string) {
  const label = raw.trim();
  if (isLetterSize(label)) return { sizeSystem: "INT", sizeLabel: label.replace(/\s/g, "").toUpperCase() };
  if (/^\d{1,4}$/.test(label)) return { sizeSystem: "RU", sizeLabel: label };
  const cm = /^(?:на\s+)?(\d{1,4}(?:[.,]\d)?)\s*(?:см|cm)$/i.exec(label)?.[1];
  if (cm) {
    const value = Number(cm.replace(",", "."));
    if (value > 0 && value <= 2000) return { sizeSystem: "CM", sizeLabel: String(value).replace(".", ",") };
  }
  return null;
}

export function productSize(attributes?: Attributes) {
  const label = String(attributes?.sizeLabel ?? "").trim();
  const system = attributes?.sizeSystem;
  if ((system === "INT" || system === "RU") && isLetterSize(label)) return label.replace(/\s/g, "").toUpperCase();
  if (system === "CM" && label) return `на ${label} см`;
  if (!label || system === "RU") return label;
  if (system === "EU" || system === "US") return `${label} (${system})`;
  return `${label} (старая маркировка)`;
}
