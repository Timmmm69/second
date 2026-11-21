import { test } from "node:test";
import assert from "node:assert/strict";
import { startVisibleQueuePolling } from "../client/queue-poll.js";

test("queue refreshes 20 times per visible 10 minutes, never polls hidden, catches up once", () => {
  const page = new EventTarget() as EventTarget & { visibilityState: Document["visibilityState"] };
  const browser = new EventTarget();
  page.visibilityState = "visible";
  let time = 0, refreshes = 0;
  const callbacks = new Set<() => void>();
  let cancelCount = 0;
  const stop = startVisibleQueuePolling(() => { refreshes++; }, {
    page,
    browser,
    schedule: (fn, interval) => {
      assert.equal(interval, 30000);
      callbacks.add(fn);
      return 1 as ReturnType<typeof setInterval>;
    },
    cancel: () => { callbacks.clear(); cancelCount++; },
    now: () => time,
  });
  const advance = (minutes: number) => {
    for (let n = 0; n < minutes * 2; n++) {
      time += 30000;
      for (const callback of callbacks) callback();
    }
  };
  advance(10);
  assert.equal(refreshes, 20);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  advance(10);
  assert.equal(refreshes, 20);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  browser.dispatchEvent(new Event("focus"));
  for (const callback of callbacks) callback();
  assert.equal(refreshes, 21, "return + focus + timer must send only one request");
  advance(10);
  assert.equal(refreshes, 41);
  browser.dispatchEvent(new Event("blur"));
  browser.dispatchEvent(new Event("focus"));
  assert.equal(refreshes, 42);
  stop();
  advance(10);
  page.dispatchEvent(new Event("visibilitychange"));
  browser.dispatchEvent(new Event("focus"));
  assert.equal(refreshes, 42, "unmounted queue must not refresh");
  assert.equal(cancelCount, 1);
});

test("initially hidden queue never polls until visible", () => {
  const page = new EventTarget() as EventTarget & { visibilityState: Document["visibilityState"] };
  const browser = new EventTarget();
  page.visibilityState = "hidden";
  let count = 0, tick: () => void = () => {};
  const stop = startVisibleQueuePolling(() => count++, {
    page, browser,
    schedule: (fn) => { tick = fn; return 1 as ReturnType<typeof setInterval>; },
    cancel: () => { tick = () => {}; },
    now: () => 1500,
  });
  tick(); tick();
  assert.equal(count, 0);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(count, 1);
  stop();
});
