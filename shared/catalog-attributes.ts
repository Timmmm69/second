type Attributes = Record<string, unknown>;

export function productColor(value: unknown) {
  const color = typeof value === "string" ? value.trim() : "";
  return !color.includes("#") && !/^(?:[\da-f]{6}|[\da-f]{8})$/i.test(color) && /\p{L}/u.test(color) ? color : "";
}

export function productSize(attributes?: Attributes) {
  const label = String(attributes?.sizeLabel ?? "").trim();
  if (!label || attributes?.sizeSystem === "RU") return label;
  const system = attributes?.sizeSystem;
  if (system === "EU" || system === "US") return `${label} (${system})`;
  return `${label} (старая маркировка)`;
}
