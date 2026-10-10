import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseFastHeuristicMessage,
  parseMessageHeuristically,
  validateTelegramAction,
  validateEventAction,
  parseEventHeuristically,
  PLANNER_SYSTEM_PROMPT
} from "./telegram-webhook.ts";

// ---- planner: add ----

test("add single item to grocery", () => {
  const a = parseMessageHeuristically("add milk to groceries") as any;
  assert.equal(a.kind, "planner");
  assert.equal(a.action, "add");
  assert.equal(a.list_key, "grocery");
  assert.deepEqual(a.items, ["milk"]);
});

test("add multiple items with 'and'", () => {
  const a = parseMessageHeuristically("add milk and eggs to groceries") as any;
  assert.equal(a.list_key, "grocery");
  assert.deepEqual(a.items, ["milk", "eggs"]);
});

test("add comma-separated items", () => {
  const a = parseMessageHeuristically("need apples, yogurt, oats in grocery") as any;
  assert.equal(a.action, "add");
  assert.equal(a.list_key, "grocery");
  assert.deepEqual(a.items, ["apples", "yogurt", "oats"]);
});

test("add to workout list", () => {
  const a = parseMessageHeuristically("put leg day on workout") as any;
  assert.equal(a.list_key, "workout");
  assert.deepEqual(a.items, ["leg day"]);
});

test("add to todo list", () => {
  const a = parseMessageHeuristically("add clean desk to todo") as any;
  assert.equal(a.list_key, "todo");
  assert.deepEqual(a.items, ["clean desk"]);
});

test("implicit add via 'buy'/'need' verb with explicit list", () => {
  const a = parseFastHeuristicMessage("buy tomatoes market") as any;
  assert.ok(a, "fast path should catch buy+list");
  assert.equal(a.list_key, "grocery");
  assert.equal(a.action, "add");
});

// ---- planner: complete / uncomplete / delete / clear ----

test("mark item done", () => {
  const a = parseMessageHeuristically("mark milk done") as any;
  assert.equal(a.action, "complete");
  assert.deepEqual(a.items, ["milk"]);
});

test("check off item", () => {
  const a = parseMessageHeuristically("check off clean desk from todo") as any;
  assert.equal(a.action, "complete");
  assert.equal(a.list_key, "todo");
});

test("undo / uncheck item", () => {
  const a = parseMessageHeuristically("undo milk") as any;
  assert.equal(a.action, "uncomplete");
  assert.equal(a.all_lists, true, "no explicit list -> all_lists for uncomplete");
});

test("remove item from list", () => {
  const a = parseMessageHeuristically("remove eggs from groceries") as any;
  assert.equal(a.action, "delete");
  assert.equal(a.list_key, "grocery");
  assert.deepEqual(a.items, ["eggs"]);
});

test("clear a list", () => {
  const a = parseMessageHeuristically("clear todo") as any;
  assert.equal(a.action, "clear");
  assert.equal(a.list_key, "todo");
  assert.deepEqual(a.items, []);
});

test("empty/reset synonyms", () => {
  const a = parseMessageHeuristically("empty groceries") as any;
  assert.equal(a.action, "clear");
  const b = parseMessageHeuristically("reset workout") as any;
  assert.equal(b.action, "clear");
});

// ---- meals must NOT parse to meal/recipe actions ----

test("meal text no longer produces meal/recipe actions", () => {
  for (const msg of [
    "add meal butter chicken",
    "set meal plan to oats",
    "rate Sample Wrap 4.5/5",
    "add recipe wrap calories 400"
  ]) {
    const fast = parseFastHeuristicMessage(msg);
    const full = parseMessageHeuristically(msg);
    for (const a of [fast, full]) {
      if (a) assert.notEqual((a as any).kind, "meal_plan");
      if (a) assert.notEqual((a as any).kind, "recipe");
      if (a) assert.notEqual((a as any).kind, "recipe_rating");
    }
  }
});

// ---- health targets ----

test("set steps target", () => {
  const a = parseMessageHeuristically("set steps target to 12000") as any;
  assert.equal(a.kind, "target");
  assert.equal(a.metric, "steps");
  assert.equal(a.value, 12000);
});

test("set calories target", () => {
  const a = parseMessageHeuristically("change calories goal to 2200") as any;
  assert.equal(a.kind, "target");
  assert.equal(a.metric, "calories");
  assert.equal(a.value, 2200);
});

// ---- challenge check-ins ----

test("water logging with liters", () => {
  const a = parseMessageHeuristically("drank 1L water") as any;
  assert.equal(a.kind, "challenge");
  assert.equal(a.action, "add_water");
  assert.equal(a.value, 1);
});

test("water logging with ml", () => {
  const a = parseMessageHeuristically("drank 500ml water") as any;
  assert.equal(a.kind, "challenge");
  assert.equal(a.action, "add_water");
  assert.equal(a.value, 0.5);
});

test("bare water mention defaults to 1L", () => {
  const a = parseMessageHeuristically("water") as any;
  assert.equal(a.kind, "challenge");
  assert.equal(a.action, "add_water");
  assert.equal(a.value, 1);
});

test("sleep logging", () => {
  const a = parseMessageHeuristically("slept 7.5 hours") as any;
  assert.equal(a.kind, "challenge");
  assert.equal(a.action, "set_sleep");
  assert.equal(a.value, 7.5);
});

test("workout check-in", () => {
  const a = parseMessageHeuristically("gym done today") as any;
  assert.equal(a.kind, "challenge");
  assert.equal(a.action, "add_workout");
});

// ---- validators (LLM JSON gate) ----

test("validateTelegramAction accepts a good planner action", () => {
  const a = validateTelegramAction({
    kind: "planner",
    action: "add",
    list_key: "grocery",
    items: ["milk"],
    all_lists: false
  });
  assert.ok(a);
  assert.equal((a as any).list_key, "grocery");
});

test("validateTelegramAction rejects unknown list_key (incl. meal)", () => {
  assert.equal(validateTelegramAction({ kind: "planner", action: "add", list_key: "meal", items: ["x"] }), null);
  assert.equal(validateTelegramAction({ kind: "planner", action: "add", list_key: "pantry", items: ["x"] }), null);
});

test("validateTelegramAction rejects meal_plan / recipe / recipe_rating kinds", () => {
  assert.equal(validateTelegramAction({ kind: "meal_plan", action: "add_meal", recipes: ["x"] }), null);
  assert.equal(validateTelegramAction({ kind: "recipe", action: "add_recipe", title: "x" }), null);
  assert.equal(validateTelegramAction({ kind: "recipe_rating", action: "rate_recipe", title: "x", rating: 4 }), null);
});

test("validateTelegramAction rejects add with empty items", () => {
  assert.equal(validateTelegramAction({ kind: "planner", action: "add", list_key: "todo", items: [] }), null);
});

test("validateTelegramAction accepts clear with empty items", () => {
  const a = validateTelegramAction({ kind: "planner", action: "clear", list_key: "todo", items: [] });
  assert.ok(a);
});

test("validateTelegramAction rejects bad target values", () => {
  assert.equal(validateTelegramAction({ kind: "target", action: "set_target", metric: "steps", value: -5 }), null);
  assert.equal(validateTelegramAction({ kind: "target", action: "set_target", metric: "flops", value: 5 }), null);
});

test("validateTelegramAction accepts challenge action", () => {
  const a = validateTelegramAction({ kind: "challenge", action: "add_water", value: 1 });
  assert.ok(a);
  assert.equal((a as any).action, "add_water");
});

test("validateTelegramAction rejects kind none (LLM no-action guard)", () => {
  assert.equal(validateTelegramAction({ kind: "none" }), null);
});

// ---- calendar events (phase 3) ----
// 2026-10-12T04:30Z = Monday 10:00 IST

test("parseEventHeuristically: friday 3pm -> next Friday 15:00 IST", () => {
  const a = parseEventHeuristically("schedule dentist Friday 3pm", new Date("2026-10-12T04:30:00Z"));
  assert.ok(a);
  assert.equal(a.kind, "calendar");
  assert.equal(a.title, "dentist");
  assert.equal(a.start_iso, "2026-10-16T09:30:00.000Z");
  assert.equal(a.duration_min, 60);
  assert.equal(a.all_day, false);
});

test("parseEventHeuristically: /event tomorrow 9am standup", () => {
  const a = parseEventHeuristically("/event tomorrow 9am standup", new Date("2026-10-12T04:30:00Z"));
  assert.ok(a);
  assert.equal(a.title, "standup");
  assert.equal(a.start_iso, "2026-10-13T03:30:00.000Z");
});

test("parseEventHeuristically: tonight 8pm", () => {
  const a = parseEventHeuristically("schedule gym tonight 8pm", new Date("2026-10-12T04:30:00Z"));
  assert.ok(a);
  assert.equal(a.title, "gym");
  assert.equal(a.start_iso, "2026-10-12T14:30:00.000Z");
});

test("parseEventHeuristically: past weekday rolls to next week", () => {
  const a = parseEventHeuristically("schedule brunch sunday 10am", new Date("2026-10-12T04:30:00Z"));
  assert.ok(a);
  assert.equal(a.start_iso, "2026-10-18T04:30:00.000Z");
});

test("parseEventHeuristically: same-day past time rolls to next week", () => {
  const a = parseEventHeuristically("schedule standup today 9am", new Date("2026-10-12T04:30:00Z"));
  assert.ok(a);
  assert.equal(a.start_iso, "2026-10-19T03:30:00.000Z");
});

test("parseEventHeuristically: garbage and planner phrasing -> null", () => {
  assert.equal(parseEventHeuristically("schedule something sometime", new Date("2026-10-12T04:30:00Z")), null);
  assert.equal(parseEventHeuristically("add milk to groceries", new Date("2026-10-12T04:30:00Z")), null);
  assert.equal(parseEventHeuristically("book", new Date("2026-10-12T04:30:00Z")), null);
});

test("validateEventAction accepts iso start", () => {
  const a = validateEventAction({
    kind: "calendar", action: "create_event", title: "Dentist",
    start_iso: "2026-10-16T09:30:00Z", duration_min: 45
  });
  assert.ok(a);
  assert.equal(a.duration_min, 45);
  assert.equal(a.all_day, false);
});

test("validateEventAction normalizes {date,time} to IST iso", () => {
  const a = validateEventAction({
    kind: "calendar", action: "create_event", title: "Standup", date: "2026-10-16", time: "9:30"
  });
  assert.ok(a);
  assert.equal(a.start_iso, "2026-10-16T09:30:00+05:30");
  assert.equal(a.duration_min, 60);
});

test("validateEventAction date-only start implies all_day", () => {
  const a = validateEventAction({
    kind: "calendar", action: "create_event", title: "Trip", start_iso: "2026-10-20"
  });
  assert.ok(a);
  assert.equal(a.all_day, true);
});

test("validateEventAction rejects empty title, bad duration, malformed start", () => {
  assert.equal(validateEventAction({ kind: "calendar", action: "create_event", title: "  ", start_iso: "2026-10-16T09:30:00Z" }), null);
  assert.equal(validateEventAction({ kind: "calendar", action: "create_event", title: "X", start_iso: "2026-10-16T09:30:00Z", duration_min: 0 }), null);
  assert.equal(validateEventAction({ kind: "calendar", action: "create_event", title: "X", start_iso: "not-a-date" }), null);
  assert.equal(validateEventAction({ kind: "calendar", action: "create_event", title: "X" }), null);
});

test("heuristic /event goes through fast path", () => {
  const a = parseFastHeuristicMessage("/event tomorrow 9am standup");
  assert.ok(a);
  assert.equal(a.kind, "calendar");
});

// ---- Z.ai LLM prompt contract (phase 2) ----

test("PLANNER_SYSTEM_PROMPT covers planner lists, no meal/recipe schema", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /grocery\|workout\|todo/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /meal|recipe/i);
});

test("webhook source uses Z.ai endpoint and env names, not OpenAI", () => {
  const source = readFileSync(new URL("./telegram-webhook.ts", import.meta.url), "utf8");
  assert.match(source, /https:\/\/api\.z\.ai\/api\/coding\/paas\/v4\/chat\/completions/);
  assert.match(source, /ZAI_API_KEY/);
  assert.match(source, /ZAI_MODEL/);
  assert.doesNotMatch(source, /api\.openai\.com/);
  assert.doesNotMatch(source, /OPENAI_API_KEY/);
  assert.doesNotMatch(source, /OPENAI_MODEL/);
});
