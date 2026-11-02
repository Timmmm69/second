export interface CheckoutFields {
  method: "PICKUP" | "EUROPOST" | "BELPOST";
  phone: string;
  fullName: string;
  city: string;
  office: string;
  officeAddress?: string;
  postalCode: string;
  comment: string;
}

export const emptyCheckoutDraft: CheckoutFields = {
  method: "PICKUP", phone: "", fullName: "", city: "", office: "",
  officeAddress: "", postalCode: "", comment: "",
};
export interface DraftReply extends Partial<CheckoutFields> {
  draftToken: string;
  draftRevision: number;
  saveRecipient: boolean;
  recipientVersion: number;
}
export interface DraftState {
  draft: CheckoutFields;
  loaded: boolean;
  status: "idle" | "saving" | "saved" | "failed";
  error: unknown;
  saveRecipient: boolean;
  recipientVersion: number;
  draftToken: string;
  draftRevision: number;
  finished: boolean;
  clearing: boolean;
}
export type DraftApi = <T>(path: string, options?: {
  method?: string; body?: unknown; keepalive?: boolean;
}) => Promise<T>;

/** Volatile account-scoped state. Contacts never enter local/sessionStorage. */
export class DraftSession {
  private state: DraftState = {
    draft: { ...emptyCheckoutDraft }, loaded: false, status: "idle", error: null,
    saveRecipient: true, recipientVersion: 0, draftToken: "", draftRevision: 0,
    finished: false, clearing: false,
  };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loading: Promise<void> | undefined;
  private requests = new Map<string, Promise<void>>();
  private epoch = 0;
  private acknowledged = 0;
  constructor(private request: DraftApi, private delay = 500) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<DraftState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  load = async () => {
    if (this.state.loaded || this.state.finished) return;
    if (this.loading) return this.loading;
    const epoch = this.epoch;
    this.loading = (async () => {
      try {
        const reply = await this.request<DraftReply>("/me/checkout-draft");
        if (epoch !== this.epoch || this.state.finished) return;
        const draft = Object.fromEntries(Object.entries(emptyCheckoutDraft).map(([key, fallback]) =>
          [key, reply[key as keyof CheckoutFields] ?? fallback])) as unknown as CheckoutFields;
        this.acknowledged = reply.draftRevision;
        this.publish({ draft, loaded: true, status: "idle", error: null,
          draftToken: reply.draftToken, draftRevision: reply.draftRevision,
          saveRecipient: reply.saveRecipient, recipientVersion: reply.recipientVersion });
      } catch (error) {
        if (epoch === this.epoch) this.publish({ status: "failed", error });
        throw error;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  };
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.publish({ draftRevision: this.state.draftRevision + 1, status: "saving", error: null });
    this.timer = setTimeout(() => { this.flush().catch(() => {}); }, this.delay);
  }
  update = (patch: Partial<CheckoutFields>) => {
    if (!this.state.loaded || this.state.finished || this.state.clearing) return;
    this.publish({ draft: { ...this.state.draft, ...patch } });
    this.schedule();
  };
  setSaveRecipient = (saveRecipient: boolean) => {
    if (!this.state.loaded || this.state.finished || this.state.clearing) return;
    this.publish({ saveRecipient });
    this.schedule();
  };
  flush = async ({ keepalive = true }: { keepalive?: boolean } = {}) => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const current = this.state;
    if (!current.loaded || current.finished || current.clearing || current.draftRevision <= this.acknowledged) return;
    const epoch = this.epoch;
    const revision = current.draftRevision;
    const requestId = `${epoch}:${revision}`;
    const existing = this.requests.get(requestId);
    if (existing) return existing;
    const body = { ...current.draft, draftToken: current.draftToken, draftRevision: revision,
      saveRecipient: current.saveRecipient, recipientVersion: current.recipientVersion };
    this.publish({ status: "saving", error: null });
    const promise = (async () => {
      try {
        await this.request("/me/checkout-draft", { method: "PATCH", body, keepalive });
        if (epoch !== this.epoch || this.state.finished) return;
        this.acknowledged = Math.max(this.acknowledged, revision);
        if (revision === this.state.draftRevision) this.publish({ status: "saved", error: null });
      } catch (error) {
        if (epoch === this.epoch && !this.state.finished && revision === this.state.draftRevision)
          this.publish({ status: "failed", error });
        throw error;
      } finally { this.requests.delete(requestId); }
    })();
    this.requests.set(requestId, promise);
    return promise;
  };
  orderMetadata = () => ({ draftToken: this.state.draftToken,
    saveRecipient: this.state.saveRecipient, recipientVersion: this.state.recipientVersion });
  clear = async () => {
    if (!this.state.loaded || this.state.finished || this.state.clearing) return;
    if (this.timer) clearTimeout(this.timer);
    const epoch = ++this.epoch;
    this.publish({ clearing: true, status: "saving", error: null });
    try {
      const reply = await this.request<{ version: number; draftToken: string; draftRevision: number }>(
        "/me/recipient-profile", { method: "DELETE", body: { version: this.state.recipientVersion } });
      if (epoch !== this.epoch || this.state.finished) return;
      this.acknowledged = reply.draftRevision;
      this.publish({ draft: { ...emptyCheckoutDraft, method: this.state.draft.method },
        draftToken: reply.draftToken, draftRevision: reply.draftRevision,
        recipientVersion: reply.version, saveRecipient: false, clearing: false,
        status: "saved", error: null });
    } catch (error) {
      if (epoch === this.epoch) this.publish({ clearing: false, status: "failed", error });
      throw error;
    }
  };
  /** Call only after a confirmed order, or when intentionally discarding this account's cache. */
  finish = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.epoch++;
    this.publish({ draft: { ...emptyCheckoutDraft }, finished: true, loaded: false,
      draftToken: "", status: "idle", error: null, clearing: false });
  };
}
let cached: { accountId: string; session: DraftSession } | undefined;
export function getDraftSession(accountId: string, request: DraftApi) {
  if (cached && (cached.accountId !== accountId || cached.session.snapshot().finished)) {
    cached.session.finish();
    cached = undefined;
  }
  cached ??= { accountId, session: new DraftSession(request) };
  return cached.session;
}
/** Logout/demo reset must discard cached contacts even when the synthetic account ID repeats. */
export function discardDraftSession() {
  cached?.session.finish();
  cached = undefined;
}
