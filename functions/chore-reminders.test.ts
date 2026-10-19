import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dueChores,
  occursOn,
  timeDisplay,
  dashboardNow,
  type ChoreRow
} from "./chore-reminders.ts";

// 2026-10-19 is a Monday. 10:00 UTC = 12:00 Amsterdam (CEST, UTC+2 in October
// pre-DST-transition); 06:00 UTC = 08:00 Amsterdam (inside quiet hours).
const NOON_AMS = Date.parse("2026-10-19T10:00:00Z");
const MORNING_AMS = Date.parse("2026-10-19T06:00:00Z");
const TZ = "Europe/Amsterdam";

function chore(overrides: Partial<ChoreRow>): ChoreRow {
  return {
    id: "c1",
    text: "clean kitchen",
    pattern: "daily",
    days: "",
    once_date: "",
    start_min: 600,
    end_min: 1320,
    skip_date: "",
    last_notified_at: "1970-01-01T00:00:00Z",
    ...overrides
  };
}

test("dashboardNow derives Amsterdam-local day/weekday/minutes", () => {
  const now = dashboardNow(NOON_AMS, TZ);
  assert.equal(now.day, "2026-10-19");
  assert.equal(now.weekday, "mo");
  assert.equal(now.nowMin, 12 * 60);
});

test("occursOn resolves daily, weekly and one-off patterns", () => {
  assert.equal(occursOn(chore({ pattern: "daily" }), "2026-10-19"), true);
  assert.equal(occursOn(chore({ pattern: "weekly", days: "mo" }), "2026-10-19"), true);
  assert.equal(occursOn(chore({ pattern: "weekly", days: "sa" }), "2026-10-19"), false);
  assert.equal(occursOn(chore({ pattern: "weekly", days: "tu,th,sa" }), "2026-10-20"), true);
  assert.equal(occursOn(chore({ pattern: "once", once_date: "2026-10-19" }), "2026-10-19"), true);
  assert.equal(occursOn(chore({ pattern: "once", once_date: "2026-10-20" }), "2026-10-19"), false);
});

test("dueChores: open daily chore inside its window nags", () => {
  const due = dueChores([chore({})], new Set(), NOON_AMS, 29 * 60_000, TZ);
  assert.equal(due.length, 1);
});

test("dueChores: quiet hours 00:00-09:00 send nothing", () => {
  const due = dueChores([chore({ start_min: 0, end_min: 1440 })], new Set(), MORNING_AMS, 29 * 60_000, TZ);
  assert.equal(due.length, 0);
});

test("dueChores: before start_min and after end_min stay silent", () => {
  const evening = dueChores([chore({ start_min: 1320, end_min: 1440 })], new Set(), NOON_AMS, 29 * 60_000, TZ);
  assert.equal(evening.length, 0);
  const afterEnd = dueChores([chore({ start_min: 600, end_min: 660 })], new Set(), NOON_AMS, 29 * 60_000, TZ);
  assert.equal(afterEnd.length, 0);
});

test("dueChores: window end is inclusive", () => {
  const atEnd = Date.parse("2026-10-19T20:00:00Z"); // 22:00 Amsterdam
  const due = dueChores([chore({ start_min: 600, end_min: 1320 })], new Set(), atEnd, 29 * 60_000, TZ);
  assert.equal(due.length, 1);
});

test("dueChores: done and skipped chores stay silent", () => {
  const done = dueChores([chore({})], new Set(["c1"]), NOON_AMS, 29 * 60_000, TZ);
  assert.equal(done.length, 0);
  const skipped = dueChores([chore({ skip_date: "2026-10-19" })], new Set(), NOON_AMS, 29 * 60_000, TZ);
  assert.equal(skipped.length, 0);
});

test("dueChores: 30-min spacing between reminders", () => {
  const recent = new Date(NOON_AMS - 10 * 60_000).toISOString();
  const stale = new Date(NOON_AMS - 30 * 60_000).toISOString();
  assert.equal(dueChores([chore({ last_notified_at: recent })], new Set(), NOON_AMS, 29 * 60_000, TZ).length, 0);
  assert.equal(dueChores([chore({ last_notified_at: stale })], new Set(), NOON_AMS, 29 * 60_000, TZ).length, 1);
});

test("dueChores: weekly fires only on its days; once only on its date", () => {
  const tuesdayChore = chore({ pattern: "weekly", days: "tu" });
  assert.equal(dueChores([tuesdayChore], new Set(), NOON_AMS, 29 * 60_000, TZ).length, 0);
  const tueNoon = Date.parse("2026-10-20T10:00:00Z");
  assert.equal(dueChores([tuesdayChore], new Set(), tueNoon, 29 * 60_000, TZ).length, 1);
  const once = chore({ pattern: "once", once_date: "2026-10-19" });
  assert.equal(dueChores([once], new Set(), NOON_AMS, 29 * 60_000, TZ).length, 1);
});

test("timeDisplay renders point times and windows", () => {
  assert.equal(timeDisplay(1320, 1440), "22:00");
  assert.equal(timeDisplay(600, 1320), "10:00-22:00");
  assert.equal(timeDisplay(570, 1440), "09:30");
});
