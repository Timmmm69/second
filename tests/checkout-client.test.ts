import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftSession, emptyCheckoutDraft, getDraftSession, discardDraftSession, type DraftApi } from "../client/checkout-draft.js";

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const initial = { ...emptyCheckoutDraft, phone: "+375 00 000 00 00", fullName: "Тест Тестович",
  draftToken: "generation-one", draftRevision: 2, saveRecipient: true, recipientVersion: 3 };
function setup() {
  const calls: { path: string; body: any; response: ReturnType<typeof deferred> }[] = [];
  const request: DraftApi = async <T>(path: string, options?: {method?: string; body?: unknown}) => {
    if (!options?.method) return initial as T;
    const response = deferred();
    calls.push({path, body: options.body, response});
    return response.promise as Promise<T>;
  };
  return { session: new DraftSession(request, 60000), calls, request };
}
test("checkout autosave only marks the latest acknowledged input saved; late failures do not replace newer success", async () => {
  const { session, calls } = setup();
  await session.load();
  session.update({ phone: "+375 00 111 11 11" });
  const first = session.flush().catch(() => {});
  assert.equal(session.snapshot().status, "saving");
  session.update({ phone: "+375 00 222 22 22" });
  const second = session.flush();
  calls[1].response.resolve({ok:true}); await second;
  assert.equal(session.snapshot().status, "saved");
  calls[0].response.reject(new Error("late stale response")); await first;
  assert.equal(session.snapshot().status, "saved");
  assert.equal(session.snapshot().draft.phone, "+375 00 222 22 22");
  assert.ok(calls[1].body.draftRevision > calls[0].body.draftRevision);
  session.finish();
});
test("an acknowledgement for older input cannot claim unsaved newer input is saved", async () => {
  const { session, calls } = setup(); await session.load();
  session.update({ city: "Первый город" }); const first = session.flush();
  session.update({ city: "Новый город" });
  calls[0].response.resolve({ok:true}); await first;
  assert.equal(session.snapshot().status, "saving");
  assert.equal(session.snapshot().draft.city, "Новый город");
  const second = session.flush(); calls[1].response.reject(new Error("offline"));
  await assert.rejects(second, /offline/);
  assert.equal(session.snapshot().status, "failed");
  assert.equal(session.snapshot().draft.city, "Новый город");
  const retry = session.flush(); assert.equal(calls[2].body.draftRevision, calls[1].body.draftRevision);
  calls[2].response.resolve({ok:true}); await retry;
  assert.equal(session.snapshot().status, "saved"); session.finish();
});
test("completed checkout wipes volatile contacts and never sends a late unmount save", async () => {
  const { session, calls } = setup(); await session.load();
  session.update({ comment: "sensitive synthetic note" }); const save = session.flush();
  session.finish(); calls[0].response.resolve({ok:true}); await save;
  await session.flush({keepalive:true});
  assert.equal(calls.length, 1);
  assert.equal(session.snapshot().draft.comment, "");
  assert.equal(session.snapshot().draft.phone, "");
  assert.equal(session.snapshot().finished, true);
});
test("clear disables recipient reuse, rotates generation, clears contacts and ignores old save acknowledgements", async () => {
  const { session, calls } = setup(); await session.load();
  session.update({ phone: "+375 00 111 11 11" }); const save = session.flush();
  const clear = session.clear();
  assert.equal(calls[1].path, "/me/recipient-profile");
  assert.equal(calls[1].body.version, 3);
  calls[1].response.resolve({version:4,draftToken:"generation-two",draftRevision:0}); await clear;
  assert.equal(session.snapshot().draft.phone, "");
  assert.deepEqual(session.orderMetadata(), {draftToken:"generation-two",saveRecipient:false,recipientVersion:4});
  session.update({ phone: "+375 00 333 33 33" });
  session.update({ city: "Новый город" });
  session.update({ office: "Новый пункт" });
  const newer = session.flush();
  assert.equal(calls[2].body.draftToken, "generation-two");
  assert.equal(calls[2].body.saveRecipient, false);
  assert.equal(calls[2].body.draftRevision, calls[0].body.draftRevision);
  calls[0].response.resolve({ok:true}); await save;
  assert.equal(session.snapshot().status, "saving");
  assert.equal(session.snapshot().draft.phone, "+375 00 333 33 33");
  calls[2].response.resolve({ok:true}); await newer; session.finish();
});
test("delivery values survive changing receiving method; remount/load reuses current in-memory draft", async () => {
  const { session, calls } = setup(); await session.load();
  session.update({method:"EUROPOST",fullName:"Другой Получатель",officeAddress:"Адрес пункта"});
  session.update({method:"PICKUP"}); const save = session.flush();
  await session.load();
  assert.equal(session.snapshot().draft.fullName, "Другой Получатель");
  assert.equal(session.snapshot().draft.officeAddress, "Адрес пункта");
  calls[0].response.resolve({ok:true}); await save;
  assert.equal(calls[0].body.method, "PICKUP"); session.finish();
});

test("switching accounts destroys the previous volatile recipient even if its save completes later", async () => {
  const { request, calls } = setup();
  const alice = getDraftSession("account-a", request);
  await alice.load();
  alice.update({ phone: "+375 00 999 99 99", fullName: "Получатель А" });
  const save = alice.flush();
  const bob = getDraftSession("account-b", request);
  assert.equal(alice.snapshot().draft.phone, "");
  assert.equal(bob.snapshot().draft.fullName, "");
  await bob.load();
  assert.equal(bob.snapshot().draft.fullName, initial.fullName);
  calls[0].response.resolve({ok:true}); await save;
  assert.equal(alice.snapshot().draft.phone, "");
  assert.equal(bob.snapshot().draft.phone, initial.phone);
  discardDraftSession();
  assert.equal(bob.snapshot().draft.phone, "");
});
