import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseFastHeuristicMessage,
  parseMessageHeuristically,
  validateTelegramAction,
  validateEventAction,
  parseEventHeuristically,
  applySlotHint,
  isValidSlotName,
  extractGroceryStore,
  parseQueryMessage,
  parseEventRangeDays,
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



// ---- challenge check-ins ----






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

test("validateTelegramAction rejects kind none (LLM no-action guard)", () => {
  assert.equal(validateTelegramAction({ kind: "none" }), null);
});

// ---- calendar events (phase 3) ----
// 2026-10-12T04:30Z = Monday 10:00 IST

test("parseEventHeuristically: friday 3pm -> next Friday 15:00 IST", () => {
  const a = parseEventHeuristically("schedule dentist Friday 3pm", new Date("2026-10-12T04:30:00Z"), "Asia/Kolkata");
  assert.ok(a);
  assert.equal(a.kind, "calendar");
  assert.equal(a.title, "dentist");
  assert.equal(a.start_iso, "2026-10-16T09:30:00.000Z");
  assert.equal(a.duration_min, 60);
  assert.equal(a.all_day, false);
});

test("parseEventHeuristically: /event tomorrow 9am standup", () => {
  const a = parseEventHeuristically("/event tomorrow 9am standup", new Date("2026-10-12T04:30:00Z"), "Asia/Kolkata");
  assert.ok(a);
  assert.equal(a.title, "standup");
  assert.equal(a.start_iso, "2026-10-13T03:30:00.000Z");
});

test("parseEventHeuristically: tonight 8pm", () => {
  const a = parseEventHeuristically("schedule gym tonight 8pm", new Date("2026-10-12T04:30:00Z"), "Asia/Kolkata");
  assert.ok(a);
  assert.equal(a.title, "gym");
  assert.equal(a.start_iso, "2026-10-12T14:30:00.000Z");
});

test("parseEventHeuristically: past weekday rolls to next week", () => {
  const a = parseEventHeuristically("schedule brunch sunday 10am", new Date("2026-10-12T04:30:00Z"), "Asia/Kolkata");
  assert.ok(a);
  assert.equal(a.start_iso, "2026-10-18T04:30:00.000Z");
});

test("parseEventHeuristically: same-day past time rolls to next week", () => {
  const a = parseEventHeuristically("schedule standup today 9am", new Date("2026-10-12T04:30:00Z"), "Asia/Kolkata");
  assert.ok(a);
  assert.equal(a.start_iso, "2026-10-19T03:30:00.000Z");
});

test("parseEventHeuristically: Amsterdam timezone (DST-aware)", () => {
  const a = parseEventHeuristically("schedule dentist friday 3pm", new Date("2026-10-12T04:30:00Z"), "Europe/Amsterdam");
  assert.ok(a);
  assert.equal(a.title, "dentist");
  assert.equal(a.start_iso, "2026-10-16T13:00:00.000Z");
});

test("parseEventHeuristically: garbage and planner phrasing -> null", () => {
  assert.equal(parseEventHeuristically("schedule something sometime", new Date("2026-10-12T04:30:00Z"), "Asia/Kolkata"), null);
  assert.equal(parseEventHeuristically("add milk to groceries", new Date("2026-10-12T04:30:00Z"), "Asia/Kolkata"), null);
  assert.equal(parseEventHeuristically("book", new Date("2026-10-12T04:30:00Z"), "Asia/Kolkata"), null);
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

test("validateEventAction normalizes {date,time} via timezone (IST)", () => {
  const a = validateEventAction({
    kind: "calendar", action: "create_event", title: "Standup", date: "2026-10-16", time: "9:30"
  }, "Asia/Kolkata");
  assert.ok(a);
  assert.equal(a.start_iso, "2026-10-16T04:00:00.000Z");
  assert.equal(a.duration_min, 60);
});

test("validateEventAction normalizes {date,time} via timezone (Amsterdam, DST)", () => {
  const a = validateEventAction({
    kind: "calendar", action: "create_event", title: "Standup", date: "2026-10-16", time: "15:00"
  }, "Europe/Amsterdam");
  assert.ok(a);
  assert.equal(a.start_iso, "2026-10-16T13:00:00.000Z");
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

test("PLANNER_SYSTEM_PROMPT mentions calendar_slot routing (phase 3.1)", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /calendar_slot/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /meal|recipe/i);
});

test("PLANNER_SYSTEM_PROMPT: fuzzy person matching + clarify-on-ambiguity (phase 3.1 LLM routing)", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /fuzzy-matching/i);
  assert.match(PLANNER_SYSTEM_PROMPT, /kind":"clarify/);
  assert.match(PLANNER_SYSTEM_PROMPT, /dinner with keethu/i);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /meal|recipe/i);
});

test("validateTelegramAction accepts a good clarify action", () => {
  const a = validateTelegramAction({ kind: "clarify", question: "Keethu's calendar or yours?" });
  assert.ok(a);
  assert.equal((a as any).kind, "clarify");
  assert.equal((a as any).question, "Keethu's calendar or yours?");
});

test("validateTelegramAction rejects bad clarify actions", () => {
  assert.equal(validateTelegramAction({ kind: "clarify", question: "   " }), null);
  assert.equal(validateTelegramAction({ kind: "clarify" }), null);
  assert.equal(validateTelegramAction({ kind: "clarify", question: 42 }), null);
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

// ---- phase 3.1: multi-calendar routing ----

const NOW = new Date("2026-10-12T04:30:00Z");
const SLOTS = ["dinesh", "keethu"];

test("isValidSlotName accepts slugs and rejects junk", () => {
  assert.equal(isValidSlotName("keethu"), true);
  assert.equal(isValidSlotName("owner"), true);
  assert.equal(isValidSlotName("am"), true);
  assert.equal(isValidSlotName("Keethu!"), false);
  assert.equal(isValidSlotName("3rd-person"), false);
  assert.equal(isValidSlotName(""), false);
});

test("applySlotHint: 'for keethu:' routes and strips the name from the message", () => {
  const hint = applySlotHint("schedule for keethu: dentist friday 3pm", SLOTS);
  assert.equal(hint.slot, "keethu");
  const event = parseEventHeuristically(hint.message, NOW, "Europe/Amsterdam");
  assert.ok(event);
  assert.equal(event.title, "dentist", "stripped message must not leak the name into the title");
  assert.equal(event.start_iso, "2026-10-16T13:00:00.000Z");
});

test("applySlotHint: 'for friday' is NOT mistaken for a calendar", () => {
  const hint = applySlotHint("schedule dentist for friday 3pm", SLOTS);
  assert.equal(hint.slot, null);
  assert.equal(hint.message, "schedule dentist for friday 3pm", "message untouched");
});

test("applySlotHint: '<name>: schedule ...' prefix label form", () => {
  // The prefix label only routes when the rest is a booking (trigger word
  // required) — "keethu: dentist friday 3pm" alone is not a booking.
  const hint = applySlotHint("keethu: schedule dentist friday 3pm", SLOTS);
  assert.equal(hint.slot, "keethu");
  const event = parseEventHeuristically(hint.message, NOW, "Europe/Amsterdam");
  assert.ok(event);
  assert.equal(event.title, "dentist");
});

test("applySlotHint: \"for <name>'s calendar\" form", () => {
  const hint = applySlotHint("schedule dentist in keethu's calendar friday 3pm", SLOTS);
  assert.equal(hint.slot, "keethu");
  const event = parseEventHeuristically(hint.message, NOW, "Europe/Amsterdam");
  assert.ok(event);
  assert.equal(event.title, "dentist");
});

test("applySlotHint: trailing 'for keethu' in a booking routes and strips", () => {
  const hint = applySlotHint("book dentist appointment for keethu friday 3pm", SLOTS);
  assert.equal(hint.slot, "keethu");
  const event = parseEventHeuristically(hint.message, NOW, "Europe/Amsterdam");
  assert.ok(event);
  // heuristic keeps non-trigger words: "appointment" survives (pre-existing behavior)
  assert.equal(event.title, "dentist appointment");
  assert.ok(!/keethu/i.test(event.title), "name must not leak into the title");
});

test("applySlotHint: owner-style message stays slot-less", () => {
  const hint = applySlotHint("schedule dentist friday 3pm", SLOTS);
  assert.equal(hint.slot, null);
  assert.equal(hint.message, "schedule dentist friday 3pm");
});

test("applySlotHint: unknown person never routes (nor strips)", () => {
  const hint = applySlotHint("schedule for craig: dentist friday 3pm", SLOTS);
  assert.equal(hint.slot, null);
  assert.equal(hint.message, "schedule for craig: dentist friday 3pm");
});

test("applySlotHint: no slots connected -> passthrough", () => {
  const hint = applySlotHint("schedule for keethu: dentist friday 3pm", []);
  assert.equal(hint.slot, null);
  assert.equal(hint.message, "schedule for keethu: dentist friday 3pm");
});

test("applySlotHint: non-booking messages are never touched", () => {
  const message = "add milk for keethu to groceries";
  const hint = applySlotHint(message, SLOTS);
  assert.equal(hint.slot, null);
  assert.equal(hint.message, message);
});

test("applySlotHint: case-insensitive name, lowercased slot", () => {
  const hint = applySlotHint("schedule for Keethu: dentist friday 3pm", SLOTS);
  assert.equal(hint.slot, "keethu");
});

test("validateEventAction preserves a valid calendar_slot", () => {
  const a = validateEventAction({
    kind: "calendar", action: "create_event", title: "Dentist",
    start_iso: "2026-10-16T09:30:00Z", calendar_slot: "Keethu"
  });
  assert.ok(a);
  assert.equal(a.calendar_slot, "keethu", "slot normalized to lowercase");
});

test("validateEventAction rejects a malformed calendar_slot", () => {
  assert.equal(validateEventAction({
    kind: "calendar", action: "create_event", title: "Dentist",
    start_iso: "2026-10-16T09:30:00Z", calendar_slot: "Keethu!"
  }), null);
});

test("validateEventAction omits calendar_slot when absent", () => {
  const a = validateEventAction({
    kind: "calendar", action: "create_event", title: "Dentist",
    start_iso: "2026-10-16T09:30:00Z"
  });
  assert.ok(a);
  assert.equal("calendar_slot" in a, false);
});

test("parseEventHeuristically stays owner-routed (no calendar_slot field)", () => {
  const a = parseEventHeuristically("schedule dentist friday 3pm", NOW, "Asia/Kolkata");
  assert.ok(a);
  assert.equal("calendar_slot" in a, false);
});

// ---- phase 3.1: grocery shop sublists ----

test("extractGroceryStore: names the shop and strips it from the message", () => {
  assert.deepEqual(extractGroceryStore("add paneer to indian grocery"), { store: "indian", cleaned: "add paneer to" });
  assert.deepEqual(extractGroceryStore("add ayran from turkish market"), { store: "turkish", cleaned: "add ayran from" });
  assert.deepEqual(extractGroceryStore("add brood to albert heijn"), { store: "ah", cleaned: "add brood to" });
  assert.deepEqual(extractGroceryStore("add milk to groceries"), { store: null, cleaned: "add milk to groceries" });
});

test("grocery add with store keyword routes to the store sublist", () => {
  const a = parseMessageHeuristically("add paneer to indian grocery") as any;
  assert.equal(a.kind, "planner");
  assert.equal(a.list_key, "grocery");
  assert.deepEqual(a.items, ["paneer"]);
  assert.equal(a.store, "indian");
});

test("grocery add via bare shop name implies the grocery list", () => {
  const a = parseMessageHeuristically("add brood to ah") as any;
  assert.equal(a.list_key, "grocery");
  assert.deepEqual(a.items, ["brood"]);
  assert.equal(a.store, "ah");
});

test("plain grocery add carries no store (defaults to ah at write time)", () => {
  const a = parseMessageHeuristically("add milk to groceries") as any;
  assert.equal(a.list_key, "grocery");
  assert.equal("store" in a, false);
});

test("store keyword never leaks into non-grocery lists", () => {
  const a = parseMessageHeuristically("add indian cookbook to todo") as any;
  assert.equal(a.list_key, "todo");
  assert.equal("store" in a, false);
  assert.ok(!/store/.test(a.items[0]), "store words stripped from item text");
});

test("validateTelegramAction keeps a valid store and drops junk store values", () => {
  const good = validateTelegramAction({ kind: "planner", action: "add", list_key: "grocery", items: ["paneer"], store: "INDIAN" });
  assert.ok(good);
  assert.equal((good as any).store, "indian", "normalized to lowercase");

  const dropped = validateTelegramAction({ kind: "planner", action: "add", list_key: "grocery", items: ["x"], store: "carrefour" });
  assert.ok(dropped);
  assert.equal("store" in dropped, false, "unknown shop dropped, add still accepted");

  const todo = validateTelegramAction({ kind: "planner", action: "add", list_key: "todo", items: ["x"], store: "ah" });
  assert.ok(todo);
  assert.equal("store" in todo, false, "store ignored for non-grocery lists");
});

test("PLANNER_SYSTEM_PROMPT documents the grocery store sublists", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /"store":"ah\|turkish\|indian/);
  assert.match(PLANNER_SYSTEM_PROMPT, /Albert Heijn/);
});

// ---- phase 3.1: read-only Telegram queries ----

test("parseQueryMessage: list lookups route to their query", () => {
  assert.equal(parseQueryMessage("what's on my grocery list")?.query, "grocery");
  assert.equal(parseQueryMessage("grocery list")?.query, "grocery");
  assert.equal(parseQueryMessage("groceries")?.query, "grocery");
  assert.equal(parseQueryMessage("grab the grocery list")?.query, "grocery");
  assert.equal(parseQueryMessage("what are my todos")?.query, "todo");
  assert.equal(parseQueryMessage("todo")?.query, "todo");
  assert.equal(parseQueryMessage("show chores")?.query, "todo");
  assert.equal(parseQueryMessage("workout list")?.query, "workout");
});

test("parseQueryMessage: today's events route to events_today", () => {
  assert.equal(parseQueryMessage("any events today?")?.query, "events_today");
  assert.equal(parseQueryMessage("what's on today")?.query, "events_today");
  assert.equal(parseQueryMessage("events today")?.query, "events_today");
  assert.equal(parseQueryMessage("my plans today")?.query, "events_today");
});

// ---- phase 4: per-person health targets ----

test("dinner with keethu never becomes a target action", () => {
  // The heuristic fallback cannot answer it; the LLM path handles clarify.
  const a = parseMessageHeuristically("dinner with keethu friday") as any;
  assert.notEqual(a?.kind, "target");
  assert.notEqual(a?.kind, "query");
});

test("parseQueryMessage: mutations are never queries", () => {
  assert.equal(parseQueryMessage("add milk to groceries"), null);
  assert.equal(parseQueryMessage("add clean desk to todo"), null);
  assert.equal(parseQueryMessage("mark milk done"), null);
  assert.equal(parseQueryMessage("clear todo"), null);
  assert.equal(parseQueryMessage("remove eggs from groceries"), null);
  assert.equal(parseQueryMessage("schedule dentist today 3pm"), null, "bookings beat queries");
  assert.equal(parseQueryMessage("/event tomorrow 9am standup"), null);
  assert.equal(parseQueryMessage("schedule dinner with keethu today"), null, "ambiguity flow beats queries");
});

test("parseQueryMessage: unrelated messages stay null", () => {
  assert.equal(parseQueryMessage("what's the capital of France"), null);
  assert.equal(parseQueryMessage("drank 1L water"), null);
  assert.equal(parseQueryMessage("slept 7.5 hours"), null);
  assert.equal(parseQueryMessage("events tomorrow"), null, "only windows are wired, not 'tomorrow' alone");
});

// ---- phase 3.1: event range queries ----

test("parseEventRangeDays: explicit day and week counts", () => {
  assert.equal(parseEventRangeDays("events next 7 days"), 7);
  assert.equal(parseEventRangeDays("coming 10 days"), 10);
  assert.equal(parseEventRangeDays("next 2 weeks"), 14);
  assert.equal(parseEventRangeDays("events in 3 days"), 3);
});

test("parseEventRangeDays: named windows per owner definition", () => {
  assert.equal(parseEventRangeDays("any events next week"), 7, "next week = 7 days");
  assert.equal(parseEventRangeDays("what's on this week"), 7);
  assert.equal(parseEventRangeDays("coming week"), 7);
  assert.equal(parseEventRangeDays("next fortnight"), 14);
  assert.equal(parseEventRangeDays("events next month"), 30);
  assert.equal(parseEventRangeDays("any events today"), null, "today has its own action");
  assert.equal(parseEventRangeDays("no window here"), null);
});

test("parseQueryMessage: range queries route with days", () => {
  const week = parseQueryMessage("any events scheduled for next week");
  assert.equal(week?.query, "events_range");
  assert.equal(week?.days, 7);

  const ten = parseQueryMessage("events coming 10 days");
  assert.equal(ten?.query, "events_range");
  assert.equal(ten?.days, 10);

  const month = parseQueryMessage("what's on next month");
  assert.equal(month?.query, "events_range");
  assert.equal(month?.days, 30);
});

test("parseQueryMessage: range mutations still rejected", () => {
  assert.equal(parseQueryMessage("schedule dentist next week"), null, "booking beats range query");
  assert.equal(parseQueryMessage("add dentist next week to calendar"), null);
});

test("validateTelegramAction gates events_range days", () => {
  assert.equal(validateTelegramAction({ kind: "query", query: "events_range", days: 10 })?.days, 10);
  assert.equal(validateTelegramAction({ kind: "query", query: "events_range", days: 1.5 }), null);
  assert.equal(validateTelegramAction({ kind: "query", query: "events_range", days: 400 }), null);
  assert.equal(validateTelegramAction({ kind: "query", query: "events_range" }), null, "days required");
});

test("validateTelegramAction accepts a good query and rejects bad ones", () => {
  assert.equal(validateTelegramAction({ kind: "query", query: "events_today" })?.query, "events_today");
  assert.equal(validateTelegramAction({ kind: "query", query: "meal_plan" }), null);
  assert.equal(validateTelegramAction({ kind: "query" }), null);
});

test("PLANNER_SYSTEM_PROMPT documents the query action", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /"kind\\":\\"query|kind":"query/);
  assert.match(PLANNER_SYSTEM_PROMPT, /events_today/);
});

test("applySlotHint: 'add X to <name> calendar' routes and strips (no trigger verb)", () => {
  const hint = applySlotHint("add kindle test to keethu calendar friday 4pm", SLOTS);
  assert.equal(hint.slot, "keethu", "calendar phrasing alone must be booking-shaped");
  assert.ok(!/keethu/i.test(hint.message), "name+calendar fragment stripped");
  assert.match(hint.message, /kindle test/);
});

test("applySlotHint: 'add X to <name>'s calendar' routes", () => {
  const hint = applySlotHint("add kindle test to keethu's calendar friday 4pm", SLOTS);
  assert.equal(hint.slot, "keethu");
});

test("applySlotHint: '<name> calendar' beat 'for <name>' (longer strip wins)", () => {
  const hint = applySlotHint("schedule dentist for keethu calendar friday 3pm", SLOTS);
  assert.equal(hint.slot, "keethu");
  const event = parseEventHeuristically(hint.message, NOW, "Europe/Amsterdam");
  assert.ok(event);
  assert.equal(event.title, "dentist", "word 'calendar' must not leak into the title");
});

test("applySlotHint: generic calendar mention without a connected name stays owner", () => {
  const hint = applySlotHint("add dentist to my calendar friday 3pm", SLOTS);
  assert.equal(hint.slot, null, "no connected name present");
  assert.equal(hint.message, "add dentist to my calendar friday 3pm");
});

test("applySlotHint: planner message containing 'calendar' is left intact when no name matches", () => {
  const message = "add calendar widget to todo";
  const hint = applySlotHint(message, SLOTS);
  assert.equal(hint.slot, null);
  assert.equal(hint.message, message);
});

// ---- phase 4: pregnancy tasks + nutrition ----

test("parseQueryMessage: pregnancy tasks and nutrition route", () => {
  assert.equal(parseQueryMessage("tasks")?.query, "pregnancy_tasks");
  assert.equal(parseQueryMessage("care tasks")?.query, "pregnancy_tasks");
  assert.equal(parseQueryMessage("pregnancy tasks")?.query, "pregnancy_tasks");
  assert.equal(parseQueryMessage("nutrition this week")?.query, "nutrition");
  assert.equal(parseQueryMessage("what vitamins")?.query, "nutrition");
  assert.equal(parseQueryMessage("what should she eat this week")?.query, "nutrition");
});

test("task completion messages are not queries (they reach the LLM path)", () => {
  assert.equal(parseQueryMessage("kraamzorg done"), null);
  assert.equal(parseQueryMessage("mark kraamzorg done"), null);
  assert.equal(parseQueryMessage("kinkhoest booked"), null);
});

test("validateTelegramAction accepts pregnancy task + nutrition queries", () => {
  assert.equal(validateTelegramAction({ kind: "query", query: "pregnancy_tasks" })?.query, "pregnancy_tasks");
  assert.equal(validateTelegramAction({ kind: "query", query: "nutrition" })?.query, "nutrition");
});

test("validateTelegramAction accepts a pregnancy task completion", () => {
  const a = validateTelegramAction({ kind: "pregnancy_task", action: "complete_task", task: "kraamzorg" });
  assert.ok(a);
  assert.equal(a.kind, "pregnancy_task");
  assert.equal((a as any).task, "kraamzorg");
  assert.equal(validateTelegramAction({ kind: "pregnancy_task", action: "complete_task", task: "  " }), null);
});

test("PLANNER_SYSTEM_PROMPT documents pregnancy tasks + nutrition queries", () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /pregnancy_task/);
  assert.match(PLANNER_SYSTEM_PROMPT, /"nutrition"/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /challenge|add_water|set_target/);
});
