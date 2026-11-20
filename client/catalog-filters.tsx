import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./ui";
import "./catalog-filters.css";

const AccordionContext = createContext<{
  openId: string | null;
  setOpenId: (id: string | null) => void;
} | null>(null);

/** One expanded filter; the values themselves remain in the catalogue draft. */
export function CatalogFilterAccordion({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const focusedField = useRef<{ element: HTMLInputElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const previous = focusedField.current;
    focusedField.current = null;
    if (!previous || !previous.element.isConnected) return;
    const sheet = previous.element.closest<HTMLElement>(".sheet");
    if (sheet) sheet.scrollBy({
      top: previous.element.getBoundingClientRect().top - previous.top,
      behavior: "instant",
    });
  }, [openId]);
  return (
    <AccordionContext.Provider value={{ openId, setOpenId }}>
      <div className="form-stack catalog-filter-accordion" onFocusCapture={(event) => {
        // Close only after the input receives focus. Collapsing on pointerdown can
        // move a price field away from the finger before the click reaches it.
        if (openId && event.target instanceof HTMLInputElement &&
            !event.target.closest(".catalog-filter-select")) {
          focusedField.current = { element: event.target, top: event.target.getBoundingClientRect().top };
          setOpenId(null);
        }
      }}>
        {children}
      </div>
    </AccordionContext.Provider>
  );
}

type Option = { value: string; label: string };
type FilterSelectProps = {
  id?: string;
  label: string;
  options: readonly Option[];
  searchPlaceholder?: string;
  disabled?: boolean;
} & (
  | { multiple?: false; value: string; onValueChange: (value: string) => void }
  | { multiple: true; value: readonly string[]; onValueChange: (value: string[]) => void; allowCustom?: boolean }
);
const normalize = (value: string) => value.trim().toLocaleLowerCase("ru").replaceAll("ё", "е");
const matches = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function CatalogFilterSelect(props: FilterSelectProps) {
  const accordion = useContext(AccordionContext);
  if (!accordion) throw new Error("CatalogFilterSelect requires CatalogFilterAccordion");
  const automaticId = useId();
  const id = props.id || automaticId;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const open = accordion.openId === id && !props.disabled;
  const selectedValues = props.multiple ? props.value : [props.value];
  const choices = props.multiple
    ? [...props.options, ...props.value.filter((value) => !props.options.some((option) => matches(option.value, value)))
      .map((value) => ({ value, label: value }))]
    : props.options;
  const selectedLabel = selectedValues.map((value) => choices.find((option) => matches(option.value, value))?.label ?? value).join(", ");
  const search = normalize(query);
  const customValue = query.trim();
  const custom = props.multiple && props.allowCustom && customValue &&
    !choices.some((option) => matches(option.value, customValue))
    ? { value: customValue, label: `Добавить «${customValue}»` } : null;
  const visible = props.searchPlaceholder && search
    ? [...choices.filter((option) => normalize(option.label).includes(search)), ...(custom ? [custom] : [])]
    : choices;

  useLayoutEffect(() => {
    if (!open) return;
    const section = root.current;
    const button = trigger.current;
    const content = panel.current;
    const sheet = section?.closest<HTMLElement>(".sheet");
    if (!section || !button || !content || !sheet) return;

    // Reserve the next control, including the price label + input after Category
    // and the Apply button after the last filter. Never scroll the document.
    let sibling = section.nextElementSibling;
    let next: HTMLElement | null = null;
    while (sibling && !next) {
      next = sibling.querySelector<HTMLElement>(".catalog-filter-trigger, .field, button, input");
      if (!next && sibling.matches("button, input")) next = sibling as HTMLElement;
      sibling = sibling.nextElementSibling;
    }
    const header = sheet.querySelector<HTMLElement>(".sheet-header");
    const viewport = window.visualViewport;
    const fit = () => {
      const bounds = sheet.getBoundingClientRect();
      const top = Math.max(bounds.top, header?.getBoundingClientRect().bottom ?? bounds.top,
        viewport?.offsetTop ?? 0) + 8;
      const bottom = Math.min(bounds.bottom, (viewport?.offsetTop ?? 0) +
        (viewport?.height ?? window.innerHeight)) - parseFloat(getComputedStyle(sheet).paddingBottom || "0");
      const buttonRect = button.getBoundingClientRect();
      const panelRect = content.getBoundingClientRect();
      const nextBottom = next?.getBoundingClientRect().bottom ?? panelRect.bottom;
      let anchorTop = buttonRect.top;
      let reserved = panelRect.top - anchorTop + nextBottom - panelRect.bottom;
      const searchHeight = content.querySelector<HTMLElement>(".select-search")?.getBoundingClientRect().height ?? 0;
      // While typing on a short viewport, keep the input and results usable.
      // The current heading may scroll above the sheet header; the next filter
      // still stays visible, so the user can continue without dismissing first.
      if (document.activeElement === searchInput.current && bottom - top - reserved < searchHeight + 64) {
        anchorTop = panelRect.top;
        reserved = nextBottom - panelRect.bottom;
      }
      content.style.maxHeight = `${Math.max(0, Math.min(280, Math.floor(bottom - top - reserved)))}px`;
      const visibleEnd = next?.getBoundingClientRect().bottom ?? content.getBoundingClientRect().bottom;
      const delta = anchorTop < top ? anchorTop - top : Math.max(0, visibleEnd - bottom);
      if (Math.abs(delta) > 1) sheet.scrollBy({ top: delta, behavior: "instant" });
    };
    fit();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(sheet);
    observer.observe(content);
    if (header) observer.observe(header);
    if (next) observer.observe(next);
    content.addEventListener("focusin", schedule);
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      content.removeEventListener("focusin", schedule);
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [open, visible.length]);

  const close = () => {
    accordion.setOpenId(null);
    trigger.current?.focus({ preventScroll: true });
  };
  const choose = (option: Option) => {
    if (props.multiple) {
      props.onValueChange(props.value.some((value) => matches(value, option.value))
        ? props.value.filter((value) => !matches(value, option.value))
        : [...props.value, option.value]);
      if (custom && option === custom) setQuery("");
    } else {
      if (option.value !== props.value) props.onValueChange(option.value);
      close();
    }
  };

  return (
    <div className="catalog-filter-select" ref={root} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }}>
      <button id={id} ref={trigger} type="button"
        className="field-control select-trigger catalog-filter-trigger"
        aria-expanded={open} aria-controls={`${id}-panel`}
        disabled={props.disabled || (!props.multiple && !props.options.length)}
        onPointerDown={(event) => {
          // Cancelling a touch pointerdown suppresses the compatibility click in
          // WebKit. Native taps must reach onClick; mouse focus is set below.
          if (event.pointerType === "mouse") event.preventDefault();
        }}
        onClick={() => {
          trigger.current?.focus({ preventScroll: true });
          setQuery("");
          accordion.setOpenId(open ? null : id);
        }}>
        <span className="catalog-filter-heading">
          <span className="catalog-filter-title">{props.label}{props.multiple && props.value.length > 0 &&
            <span className="catalog-filter-count"> · {props.value.length}</span>}</span>
          <span className="catalog-filter-summary" title={selectedLabel}>
            {selectedLabel || "Не выбрано"}
          </span>
        </span>
        <Icon name="down" size={18} />
      </button>
      <div ref={panel} id={`${id}-panel`} hidden={!open}
        className="catalog-filter-panel" role="group" aria-labelledby={id}>
        {props.searchPlaceholder && (
          <div className="select-search">
            <Icon name="search" size={18} />
            <input ref={searchInput} type="search" className="field-control" aria-label={props.searchPlaceholder}
              placeholder={props.searchPlaceholder} value={query}
              maxLength={props.multiple && props.allowCustom ? 200 : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
                if (list.current) list.current.scrollTop = 0;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  const option = custom ?? visible[0];
                  if (option) choose(option);
                }
              }} />
          </div>
        )}
        <div className="catalog-filter-options" ref={list}>
          {visible.map((option) => {
            const checked = selectedValues.some((value) => matches(value, option.value));
            return (
              <label className="catalog-filter-option" key={option.value} data-selected={checked || undefined}>
                <input type={props.multiple ? "checkbox" : "radio"} name={id}
                  checked={checked} onChange={() => choose(option)}
                  onClick={() => { if (!props.multiple && checked) close(); }} />
                <span>{option.label}</span>
              </label>
            );
          })}
          {!visible.length && <p className="select-empty" role="status">
            {search ? "Ничего не найдено. Попробуйте другой запрос." : "Пока нет вариантов."}
          </p>}
        </div>
      </div>
    </div>
  );
}
