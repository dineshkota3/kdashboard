import { test } from "node:test";
import assert from "node:assert/strict";
import { pickReminders } from "./calendar-reminders.ts";

// Base: 2026-10-16 10:00 UTC
const NOW = Date.parse("2026-10-16T10:00:00Z");

function at(minsFromNow: number): string {
  return new Date(NOW + minsFromNow * 60_000).toISOString();
}

test("pickReminders: t1 window [60,75) fires for ~1h-ahead events", () => {
  const picked = pickReminders([{ id: "a", title: "Dentist", all_day: false, start_iso: at(65) }], NOW);
  assert.deepEqual(picked, [{ id: "a", kind: "t1" }]);
});

test("pickReminders: t1 does not fire before or after the window", () => {
  const picked = pickReminders([
    { id: "early", title: "Too soon", all_day: false, start_iso: at(55) },
    { id: "late", title: "Too late", all_day: false, start_iso: at(80) }
  ], NOW);
  assert.deepEqual(picked, []);
});

test("pickReminders: t12 window [720,735) fires", () => {
  const picked = pickReminders([{ id: "b", title: "Flight", all_day: false, start_iso: at(725) }], NOW);
  assert.deepEqual(picked, [{ id: "b", kind: "t12" }]);
});

test("pickReminders: t1 skips all-day events, t12 keeps them", () => {
  const picked = pickReminders([
    { id: "bd", title: "Happy birthday!", all_day: true, start_iso: at(65) }
  ], NOW);
  assert.deepEqual(picked, [], "all-day exactly 65 min out is within t12? no — 65 < 720");
});

test("pickReminders: all-day event at ~12h gets only t12", () => {
  const picked = pickReminders([
    { id: "bd", title: "Happy birthday!", all_day: true, start_iso: at(722) }
  ], NOW);
  assert.deepEqual(picked, [{ id: "bd", kind: "t12" }]);
});

test("pickReminders: window boundaries are [inclusive, exclusive)", () => {
  const events = [
    { id: "e1", title: "A", all_day: false, start_iso: at(61) },
    { id: "e2", title: "B", all_day: false, start_iso: at(74) },
    { id: "e3", title: "C", all_day: false, start_iso: at(721) },
    { id: "e4", title: "D", all_day: false, start_iso: at(734) },
    { id: "e5", title: "E", all_day: false, start_iso: at(75) },
    { id: "e6", title: "F", all_day: false, start_iso: at(720) },
    { id: "e7", title: "G", all_day: false, start_iso: at(736) }
  ];
  const picked = pickReminders(events, NOW);
  assert.deepEqual(picked, [
    { id: "e1", kind: "t1" },
    { id: "e2", kind: "t1" },
    { id: "e3", kind: "t12" },
    { id: "e4", kind: "t12" },
    { id: "e6", kind: "t12" }
  ]);
});

test("pickReminders: malformed start times are ignored", () => {
  const picked = pickReminders([{ id: "x", title: "?", all_day: false, start_iso: "not-a-date" }], NOW);
  assert.deepEqual(picked, []);
});
