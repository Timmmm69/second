import { tg } from "./telegram";

export function Defect({ item, expanded = false }: { item: { hasDefect?: boolean; defectDescription?: string }; expanded?: boolean }) {
  return item.hasDefect ? <details className="defect-notice" open={expanded || undefined}><summary>Есть дефект — описание</summary><p className="pre-wrap">{item.defectDescription}</p></details> : null;
}

export function MapLink({ address }: { address?: string }) {
  if (!address?.trim()) return null;
  const url = `https://yandex.by/maps/?text=${encodeURIComponent(address)}`;
  return <a className="text-link map-link" href={url} target="_blank" rel="noopener noreferrer" onClick={e => { if (tg()?.openLink) { e.preventDefault(); tg()?.openLink?.(url); } }}>Как добраться ↗</a>;
}
