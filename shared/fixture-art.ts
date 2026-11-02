/** Synthetic clothing illustrations, never photographs of actual stock. */
export function fixtureSvg(shape: string, color: string) {
  const silhouettes: Record<string, string> = {
    jacket:
      "M360 270L280 300L170 550L275 590L340 440L340 1010Q480 1070 620 1010L620 440L685 590L790 550L680 300L600 270Q480 350 360 270Z",
    shirt:
      "M370 270L280 310L165 590L270 630L345 460L345 1010L615 1010L615 460L690 630L795 590L680 310L590 270L480 350Z",
    pants: "M315 270L645 270L670 1050L520 1050L480 590L440 1050L290 1050Z",
    bag: "M250 490Q240 450 290 430L670 430Q720 450 710 490L735 920Q480 1020 225 920ZM355 435L360 310Q480 170 600 310L605 435L565 435L560 330Q480 245 400 330L395 435Z",
    scarf:
      "M340 250L535 265L620 1040L430 1070ZM340 250L535 265L470 530L320 490Z",
    dress:
      "M390 250L570 250L610 420L565 590L700 1040Q480 1130 260 1040L395 590L350 420Z",
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1280" viewBox="0 0 960 1280"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#f0efed"/><stop offset="1" stop-color="#dedcd7"/></linearGradient><linearGradient id="cloth" x2="1"><stop stop-color="${color}"/><stop offset=".48" stop-color="${color}"/><stop offset=".52" stop-color="#ffffff" stop-opacity=".15"/><stop offset="1" stop-color="${color}"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="16" stdDeviation="16" flood-opacity=".12"/></filter></defs><rect width="960" height="1280" fill="url(#bg)"/><path d="M480 180q-25-40 0-55q35-15 40 10q0 20-40 40v50M310 270L480 210L650 270" stroke="#9c9b95" stroke-width="8" fill="none" stroke-linejoin="round"/><path d="${silhouettes[shape] ?? silhouettes.jacket}" fill="url(#cloth)" stroke="#222222" stroke-opacity=".12" stroke-width="3" filter="url(#s)"/><path d="M480 350V1010" stroke="#222" stroke-opacity=".12" stroke-width="3"/></svg>`;
}
