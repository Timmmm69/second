import test from "node:test";
import assert from "node:assert/strict";
import {
  pickupDeadline,
  dispatchDeadline,
  addOpenHours,
  localDate,
  type Calendar,
} from "../server/calendar.js";
const calendar: Calendar = {
  week: {
    "1": ["10:00", "20:00"],
    "2": ["10:00", "20:00"],
    "3": ["10:00", "20:00"],
    "4": ["10:00", "20:00"],
    "5": ["10:00", "20:00"],
    "6": ["10:00", "18:00"],
  },
  exceptions: {},
};
test("T10 Monday ready -> Tuesday closing, not 24 hours", () =>
  assert.equal(
    pickupDeadline(new Date("2026-11-02T08:25:00Z"), calendar).toISOString(),
    "2026-11-03T17:00:00.000Z",
  ));
test("T10 Saturday ready -> Monday closing when Sunday closed", () =>
  assert.equal(
    pickupDeadline(new Date("2026-11-07T14:00:00Z"), calendar).toISOString(),
    "2026-11-09T17:00:00.000Z",
  ));
test("T11 calendar closure skips precisely to next open day", () =>
  assert.equal(
    pickupDeadline(new Date("2026-11-02T08:25:00Z"), {
      ...calendar,
      exceptions: { "2026-11-03": null },
    }).toISOString(),
    "2026-11-04T17:00:00.000Z",
  ));
test("T13 open hours ignore night and weekend", () =>
  assert.equal(
    addOpenHours(new Date("2026-11-07T14:00:00Z"), 4, calendar).toISOString(),
    "2026-11-09T10:00:00.000Z",
  ));
test("D11 dispatch by next working day closing", () =>
  assert.equal(
    dispatchDeadline(new Date("2026-11-07T12:00:00Z"), calendar).toISOString(),
    "2026-11-09T17:00:00.000Z",
  ));
test("Minsk date independent of host timezone", () =>
  assert.equal(localDate(new Date("2026-11-02T22:00:00Z")), "2026-11-03"));
