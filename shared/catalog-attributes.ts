type Attributes = Record<string, unknown>;

export function productColor(value: unknown) {
  const color = typeof value === "string" ? value.trim() : "";
  return !color.includes("#") && !/^(?:[\da-f]{6}|[\da-f]{8})$/i.test(color) && /\p{L}/u.test(color) ? color : "";
}

export const letterSizePattern = "(?:X*S|M|X*L|[1-9][0-9]*XL)";
const letterSize = new RegExp(`^${letterSizePattern}$`, "i");

export function isLetterSize(label: string) {
  return letterSize.test(label);
}

export function productSize(attributes?: Attributes) {
  const label = String(attributes?.sizeLabel ?? "").trim();
  const system = attributes?.sizeSystem;
  if ((system === "INT" || system === "RU") && isLetterSize(label)) return label.toUpperCase();
  if (!label || system === "RU") return label;
  if (system === "EU" || system === "US") return `${label} (${system})`;
  return `${label} (старая маркировка)`;
}
