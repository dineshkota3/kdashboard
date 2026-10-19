type ListKey = "grocery" | "workout" | "todo";

type PlannerAction = {
  kind?: "planner";
  action: "add" | "complete" | "uncomplete" | "delete" | "clear";
  list_key: ListKey;
  items: string[];
  all_lists?: boolean;
  store?: string;
};

export type CalendarEventAction = {
  kind: "calendar";
  action: "create_event";
  title: string;
  start_iso: string;
  duration_min: number;
  all_day: boolean;
  location?: string;
  calendar_slot?: string;
};

// LLM-only action: the message is a real request but its target is ambiguous
// (e.g. "dinner with keethu"). Nothing is stored - the question goes back to
// the Telegram chat.
export type ClarifyAction = {
  kind: "clarify";
  question: string;
};

// Read-only lookups: "what's on my grocery list", "any events today?",
// "events next week" (days = 7), "coming 10 days" (days = 10).
// Nothing is stored - the answer goes back to the Telegram chat.
export type QueryAction = {
  kind: "query";
  query: "grocery" | "todo" | "workout" | "events_today" | "events_range" | "pregnancy_tasks" | "pregnancy_todo" | "nutrition";
  days?: number;
};

// Phase 4: mark a pregnancy care task as done ("kraamzorg done"). The task
// text is fuzzy-matched against the seeded checklist at apply time.
type PregnancyTaskAction = {
  kind: "pregnancy_task";
  action: "complete_task";
  task: string;
};

// Phase 4: personal todos on the pregnancy board (distinct from the seeded
// care timeline). add = new DO NOW item; done = fuzzy-complete by text.
type PregnancyTodoAction = {
  kind: "pregnancy_todo";
  action: "add" | "done";
  text: string;
};

type TelegramAction = PlannerAction | PregnancyTaskAction | PregnancyTodoAction | CalendarEventAction | ClarifyAction | QueryAction;

type TelegramUpdate = {
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
};

export default async function(req: Request): Promise<Response> {
  const started = timeMs();
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method === "GET") {
    return jsonResponse({ ok: true, service: "telegram-webhook" });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const configuredSecret = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
  const receivedSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (receivedSecret !== configuredSecret) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const update = (await req.json()) as TelegramUpdate;
  const chatId = String(update.message?.chat?.id ?? "");
  const allowedChatId = requiredEnv("TELEGRAM_ALLOWED_CHAT_ID");
  if (chatId !== allowedChatId) {
    return jsonResponse({ ok: true, ignored: true, reason: "chat_not_allowed" });
  }

  const text = update.message?.text?.trim();
  if (!text) {
    return jsonResponse({ ok: true, ignored: true, reason: "no_text" });
  }

  const parseStarted = timeMs();
  const action = await parseTelegramMessage(text);
  const parseMs = elapsedMs(parseStarted);
  if (!action) {
    sendTelegramMessageInBackground(chatId, "I could not understand that update.");
    return jsonResponse({ ok: true, ignored: true, reason: "unparsed" });
  }

  const { createAdminClient } = await import("npm:@insforge/sdk");
  const admin = createAdminClient({
    baseUrl: requiredEnv("INSFORGE_BASE_URL"),
    apiKey: requiredEnv("INSFORGE_API_KEY")
  });

  const applyStarted = timeMs();
  const summary = await applyTelegramAction(admin, action);
  const applyMs = elapsedMs(applyStarted);
  sendTelegramMessageInBackground(chatId, summary);
  logTiming("telegram-webhook", {
    action: action.kind || "planner",
    parse_ms: parseMs,
    apply_ms: applyMs,
    total_ms: elapsedMs(started)
  });

  return jsonResponse({ ok: true, action, summary });
}

export const PLANNER_SYSTEM_PROMPT = [
  "You parse one Telegram dashboard message into strict JSON and respond with only the JSON object.",
  "For planner/list updates return: {\"kind\":\"planner\",\"action\":\"add|complete|uncomplete|delete|clear\",\"list_key\":\"grocery|workout|todo\",\"items\":[\"short item\"],\"all_lists\":false}. Use list_key \"todo\" for chores/tasks. Use [] only for clear.",
  "The grocery list has three shop sublists. For a grocery add, set \"store\":\"ah|turkish|indian\" when the message names the shop (Albert Heijn/AH -> ah, Turkish market -> turkish, Indian store/market -> indian). Omit \"store\" for plain grocery items - they land on Albert Heijn. Never set store for non-grocery lists.",
  "For calendar bookings return: {\"kind\":\"calendar\",\"action\":\"create_event\",\"title\":\"Dentist\",\"date\":\"YYYY-MM-DD\",\"time\":\"HH:MM\",\"duration_min\":60,\"all_day\":false,\"location\":\"optional\",\"calendar_slot\":\"optional\"} where time is 24-hour in the owner's timezone given below. For all-day events omit time and set all_day true. Resolve relative dates like 'Friday', 'tomorrow', 'tonight' against the current date/time provided below.",
  "Two people share this dashboard; their calendar names are in the connected-calendar line of the system context. For a booking that is clearly FOR one of them, set \"calendar_slot\" to that person's name, fuzzy-matching spelling (\"keethuu\" -> keethu, \"my wife\" -> the matching name). Weekdays, months and times are NEVER people. Omit calendar_slot when no person is meant - the event then goes to the first (owner) calendar.",
  "If a message mentions a person but does NOT make clear whose calendar the event belongs to (for example \"dinner with keethu\"), do NOT guess: return {\"kind\":\"clarify\",\"question\":\"One short question asking whose calendar - e.g. Keethu's or Dinesh's?\"}. When the message names a calendar explicitly (the word calendar, or \"for <name>\"), never clarify.",
  "Read-only questions that ask what is ON a list or what events/plans exist in a window (no change requested) return: {\"kind\":\"query\",\"query\":\"grocery|todo|workout|events_today|events_range|pregnancy_tasks|pregnancy_todo|nutrition\",\"days\":7}. \"events_today\" is for questions about TODAY only. \"events_range\" covers next week, coming days, etc. - set \"days\" to the window length in days: next week/coming week = 7, next 10 days = 10, next fortnight = 14, next month = 30. \"pregnancy_tasks\" lists the pregnancy care checklist; \"pregnancy_todo\" lists the personal pregnancy todos shown on the dashboard DO NOW section; \"nutrition\" gives this week's pregnancy nutrition + supplements.",
  "For personal pregnancy todos return {\"kind\":\"pregnancy_todo\",\"action\":\"add\",\"text\":\"<todo text>\"} when the message asks to ADD something to the pregnancy todos/dashboard list (e.g. \"add buy vitamins to pregnancy todo\"), and {\"kind\":\"pregnancy_todo\",\"action\":\"done\",\"text\":\"<todo words>\"} when it marks one of those personal todos as done. These are separate from the pregnancy care checklist tasks.",
  "For pregnancy care tasks return: {\"kind\":\"pregnancy_task\",\"action\":\"complete_task\",\"task\":\"<task words>\"} when the message marks a pregnancy care task as done (kraamzorg booking, kinkhoest vaccination, GBS swab, scans, hospital registration, baby shopping, hospital bag). Fuzzy-match the task words against the connected task list in the system context.",
  "Undo/redo/revert requests are NOT supported: for any message asking to undo, revert, or take back the last change, return {\"kind\":\"none\"}. Also return {\"kind\":\"none\"} for questions or small talk instead of inventing items.",
].join(" ");

async function parseTelegramMessage(message: string): Promise<TelegramAction | null> {
  // Phase 3.1 multi-calendar routing: the connected names are injected into the
  // LLM context for EVERY message so it can fuzzy-route bookings ("for keethuu")
  // and ask back on ambiguity. The regex hint stays as the deterministic
  // exact-match layer (and the only router when Z.ai is unavailable).
  const slots = await loadConnectedCalendarSlots();
  const hint = applySlotHint(message, slots);
  const action = await parseAction(hint.message, slots);
  if (action && isEventAction(action) && hint.slot) {
    action.calendar_slot = hint.slot;
  }
  return action;
}

async function parseAction(message: string, slots: string[]): Promise<TelegramAction | null> {
  const fastAction = parseFastHeuristicMessage(message);
  if (fastAction) return fastAction;

  const zaiKey = Deno.env.get("ZAI_API_KEY");
  if (!zaiKey) {
    return parseMessageHeuristically(message);
  }

  const slotLine = slots.length > 0
    ? ` Connected calendars: ${slots.join(", ")}.`
    : "";
  const response = await fetch("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${zaiKey}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: Deno.env.get("ZAI_MODEL") || "glm-4.7",
      messages: [
        { role: "system", content: `${PLANNER_SYSTEM_PROMPT} Owner timezone: ${dashboardTimezone()}. Current date/time there: ${nowString(dashboardTimezone())}.${slotLine}` },
        { role: "user", content: message }
      ],
      response_format: { type: "json_object" },
      temperature: 0
    })
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    console.warn(`zai_parse_failed status=${response.status} body=${errBody.slice(0, 300)}`);
    return parseMessageHeuristically(message);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return parseMessageHeuristically(message);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return parseMessageHeuristically(message);
  }
  if (parsed && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === "none") {
    return null;
  }
  return validateTelegramAction(parsed) ?? parseMessageHeuristically(message);
}

function validateClarifyAction(input: unknown): ClarifyAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<ClarifyAction>;
  if (candidate.kind !== "clarify") return null;
  const question = typeof candidate.question === "string" ? candidate.question.trim().slice(0, 300) : "";
  if (!question) return null;
  return { kind: "clarify", question };
}

async function applyTelegramAction(admin: any, action: TelegramAction): Promise<string> {
  if (action.kind === "clarify") return action.question;
  if (action.kind === "query") return applyQueryAction(admin, action);
  if (action.kind === "pregnancy_task") return applyPregnancyTaskAction(admin, action);
  if (action.kind === "pregnancy_todo") return applyPregnancyTodoAction(admin, action);
  if (isEventAction(action)) return applyCalendarCreateAction(admin, action);
  return applyPlannerAction(admin, action);
}

// ---- phase 3.1: read-only query handlers ----

const SHOP_LABELS: Record<string, string> = {
  ah: "Albert Heijn",
  turkish: "Turkish Market",
  indian: "Indian Store"
};

async function applyQueryAction(admin: any, action: QueryAction): Promise<string> {
  if (action.query === "events_today") return queryEventsWindow(admin, 1);
  if (action.query === "events_range") return queryEventsWindow(admin, action.days || 7);
  if (action.query === "pregnancy_tasks") {
    return listPregnancyTasksReply(await loadPregnancyTaskRows(admin), dashboardLocalDate());
  }
  if (action.query === "pregnancy_todo") {
    return listPregnancyTodosReply(await loadPregnancyTodos(admin));
  }
  if (action.query === "nutrition") return nutritionReply(dashboardLocalDate());
  return queryListItems(admin, action.query);
}

// ---- Phase 4: personal pregnancy todos (DO NOW on the dashboard) ----

async function loadPregnancyTodos(admin: any): Promise<Array<{ id: string; text: string; done: boolean }>> {
  const { data: rows, error } = await admin.database
    .from("pregnancy_todos")
    .select("id,text,done")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return Array.isArray(rows) ? rows as Array<{ id: string; text: string; done: boolean }> : [];
}

function listPregnancyTodosReply(todos: Array<{ id: string; text: string; done: boolean }>): string {
  const open = todos.filter((t) => !t.done);
  if (open.length === 0) return "🤰 Pregnancy todos: all done!";
  return `🤰 Pregnancy todos (${open.length} open):\n${open.map((t) => `• ${t.text}`).join("\n")}`;
}

async function applyPregnancyTodoAction(admin: any, action: PregnancyTodoAction): Promise<string> {
  const todos = await loadPregnancyTodos(admin);
  if (action.action === "add") {
    const text = action.text.trim().slice(0, 120);
    if (!text) return "What should I add to the pregnancy todos?";
    const { error } = await admin.database
      .from("pregnancy_todos")
      .insert([{ id: crypto.randomUUID(), text, done: false }]);
    if (error) throw error;
    return `🤰 Added to pregnancy todos: ${text}`;
  }

  // done: fuzzy-complete the open todo whose text best matches
  const open = todos.filter((t) => !t.done);
  const query = action.text.trim().toLowerCase();
  let best: { id: string; text: string } | null = null;
  let bestScore = 0;
  for (const todo of open) {
    const hay = todo.text.toLowerCase();
    if (hay.includes(query)) {
      const score = 100 + query.length;
      if (score > bestScore) { bestScore = score; best = todo; }
      continue;
    }
    let score = 0;
    for (const word of query.split(/\s+/)) {
      if (word.length > 2 && hay.includes(word)) score += word.length;
    }
    if (score > bestScore) { bestScore = score; best = todo; }
  }
  if (!best) {
    return open.length === 0
      ? "No open pregnancy todos to mark done."
      : `No pregnancy todo matches "${action.text.slice(0, 40)}".\n${listPregnancyTodosReply(todos)}`;
  }
  const { error } = await admin.database
    .from("pregnancy_todos")
    .update({ done: true })
    .eq("id", best.id);
  if (error) throw error;
  return `✅ Pregnancy todo done: ${best.text}`;
}

async function queryListItems(admin: any, listKey: "grocery" | "todo" | "workout"): Promise<string> {
  const { data: rows, error } = await admin.database
    .from("planner_items")
    .select("text,store")
    .eq("list_key", listKey)
    .eq("done", false)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) throw error;
  const items = Array.isArray(rows) ? rows as Array<{ text: string; store: string | null }> : [];
  if (items.length === 0) {
    return listKey === "grocery" ? "🛒 Grocery list is empty." : `📝 ${plannerListLabel(listKey).charAt(0).toUpperCase() + plannerListLabel(listKey).slice(1)} list is empty.`;
  }

  if (listKey === "grocery") {
    // Grouped by shop, in the same shop order as the Kindle board.
    const lines: string[] = ["🛒 Grocery list:"];
    for (const store of GROCERY_STORES) {
      const storeItems = items.filter((item) => (item.store || "ah") === store);
      if (storeItems.length === 0) continue;
      lines.push("", `${SHOP_LABELS[store]}:`);
      for (const item of storeItems) lines.push(`• ${item.text}`);
    }
    const unassigned = items.filter((item) => !item.store || !GROCERY_STORES.includes(item.store));
    if (unassigned.length > 0) {
      lines.push("", "Other:");
      for (const item of unassigned) lines.push(`• ${item.text}`);
    }
    return lines.join("\n");
  }

  const label = plannerListLabel(listKey);
  return `📝 ${label.charAt(0).toUpperCase() + label.slice(1)}:\n${items.map((item) => `• ${item.text}`).join("\n")}`;
}

async function queryEventsWindow(admin: any, days: number): Promise<string> {
  const connected = (await loadCalendarStates(admin)).filter((state) => state.refresh_token);
  if (connected.length === 0) {
    return "Calendar not connected — run google:setup (first user) or google:connect (additional user).";
  }

  const timezone = dashboardTimezone();
  const date = dashboardLocalDate();
  const startIso = zonedToUtcIso(date, "00:00", timezone);
  const endDate = new Date(Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const endIso = zonedToUtcIso(endDate, "00:00", timezone);
  if (!startIso || !endIso) return "Calendar unavailable — could not resolve the window. Try again later.";

  const sections: string[] = [];
  for (const state of connected) {
    const name = slotLabel(state.slot);
    const accessToken = await ensureGoogleAccessToken(admin, state);
    if (!accessToken) {
      sections.push(`${name}:\n• unavailable`);
      continue;
    }
    const calendarId = encodeURIComponent(state.calendar_id || "primary");
    const params = new URLSearchParams({
      timeMin: startIso,
      timeMax: endIso,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "20",
      timeZone: state.timezone || timezone
    });
    try {
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) }
      );
      if (!response.ok) {
        sections.push(`${name}:\n• unavailable`);
        continue;
      }
      const json = await response.json();
      const items = Array.isArray(json?.items) ? json.items : [];
      const lines = items
        .map((item: any) => {
          const start = item?.start ?? {};
          const startIso = String(start.dateTime || start.date || "");
          if (!startIso) return null;
          const title = typeof item?.summary === "string" && item.summary.trim() ? item.summary.trim().slice(0, 80) : "(untitled)";
          const allDay = Boolean(start.date) && !start.dateTime;
          const stamp = days === 1
            ? formatTodayTime(startIso, allDay, state.timezone || timezone)
            : formatRangeTime(startIso, allDay, state.timezone || timezone);
          return `• ${stamp} — ${title}`;
        })
        .filter(Boolean);
      sections.push(`${name}:\n${lines.length > 0 ? lines.join("\n") : "• nothing scheduled"}`);
    } catch {
      sections.push(`${name}:\n• unavailable`);
    }
  }

  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
  const header = days === 1
    ? `📅 Today (${new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(new Date())}):`
    : `📅 Next ${days} days (${dayFmt.format(Date.parse(startIso))} → ${dayFmt.format(Date.parse(endIso) - 60_000)}):`;
  return `${header}\n${sections.join("\n\n")}`;
}

// Same-day events need no date label — just the wall-clock time (or "all day").
function formatTodayTime(startIso: string, allDay: boolean, timezone: string): string {
  const parsed = Date.parse(startIso);
  if (!Number.isFinite(parsed)) return startIso;
  if (allDay) return "all day";
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true });
  return fmt.format(parsed);
}

// Multi-day ranges need the date on every event.
function formatRangeTime(startIso: string, allDay: boolean, timezone: string): string {
  const parsed = Date.parse(startIso);
  if (!Number.isFinite(parsed)) return startIso;
  if (allDay) {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
    return `all day ${fmt.format(parsed)}`;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true
  });
  return fmt.format(parsed);
}

function isEventAction(action: TelegramAction): action is CalendarEventAction {
  return (action as CalendarEventAction).kind === "calendar";
}

async function applyCalendarCreateAction(admin: any, action: CalendarEventAction): Promise<string> {
  const connected = (await loadCalendarStates(admin)).filter((state) => state.refresh_token);
  if (connected.length === 0) {
    return "Calendar not connected — run google:setup (first user) or google:connect (additional user), then open the OAuth link.";
  }

  // Default target is the FIRST connected row (created_at order) — always the
  // original owner, matching the pre-3.1 behavior. An explicit slot that no
  // connected row answers fails loudly instead of silently booking elsewhere.
  const targetSlot = action.calendar_slot?.trim().toLowerCase() || "";
  const state = targetSlot
    ? connected.find((row) => (row.slot || "owner") === targetSlot)
    : connected[0];
  if (!state) {
    const names = connected.map((row) => row.slot || "owner").join(", ");
    return `No calendar connected for "${targetSlot}". Connected: ${names}`;
  }

  const accessToken = await ensureGoogleAccessToken(admin, state);
  if (!accessToken) {
    return "Calendar unavailable — could not refresh the Google token. Try again later.";
  }

  const allDay = action.all_day;
  const startIso = action.start_iso;
  const endIso = allDay ? allDayEndDate(startIso) : new Date(Date.parse(startIso) + action.duration_min * 60_000).toISOString();
  if (!allDay && !Number.isFinite(Date.parse(endIso))) {
    return "I could not understand that update.";
  }

  const body: Record<string, unknown> = {
    summary: action.title,
    ...(allDay
      ? { start: { date: startIso.slice(0, 10) }, end: { date: endIso } }
      : { start: { dateTime: startIso }, end: { dateTime: endIso } }),
    ...(action.location ? { location: action.location } : {})
  };

  const calendarId = encodeURIComponent(state.calendar_id || "primary");
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify(body)
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`calendar_event_insert_failed status=${response.status} body=${detail.slice(0, 200)}`);
    return "Calendar unavailable — Google rejected the event. Try again later.";
  }

  return `Scheduled for ${slotLabel(state.slot)}: ${action.title} — ${formatEventStart(startIso, allDay, state.timezone || dashboardTimezone())}`;
}

function slotLabel(slot: string | null): string {
  const name = slot || "owner";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function dashboardTimezone(): string {
  try {
    if (typeof Deno !== "undefined") {
      return Deno.env.get("DASHBOARD_TIMEZONE") || "Asia/Kolkata";
    }
  } catch {
    // fall through to default
  }
  return "Asia/Kolkata";
}

// DST-safe conversion: resolve a wall-clock date+time in a timezone to a UTC instant.
function zonedToUtcIso(dateStr: string, timeStr: string, timeZone: string): string {
  const [rawHours, rawMinutes] = timeStr.split(":");
  const time = `${rawHours.padStart(2, "0")}:${rawMinutes.padStart(2, "0")}:00`;
  const naiveMs = Date.parse(`${dateStr}T${time}Z`);
  if (!Number.isFinite(naiveMs)) return "";
  let ts = naiveMs;
  for (let pass = 0; pass < 2; pass++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).formatToParts(new Date(ts));
    const by = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const hour = by.hour === "24" ? "00" : by.hour;
    const wallAsUtc = Date.parse(`${by.year}-${by.month}-${by.day}T${hour}:${by.minute}:${by.second}Z`);
    if (!Number.isFinite(wallAsUtc)) return "";
    ts += naiveMs - wallAsUtc;
  }
  return new Date(ts).toISOString();
}

async function loadCalendarStates(admin: any): Promise<GoogleCalendarStateRow[]> {
  const { data: rows, error } = await admin.database
    .from("google_calendar_state")
    .select("slot,refresh_token,access_token,token_expiry,calendar_id,timezone")
    .order("created_at", { ascending: true })
    .limit(4);
  if (error) throw error;
  return Array.isArray(rows) ? rows as GoogleCalendarStateRow[] : [];
}

// Names of the connected calendars for Telegram routing. Never blocks parsing:
// a DB hiccup yields no slots and every booking falls through to the owner.
async function loadConnectedCalendarSlots(): Promise<string[]> {
  try {
    const { createAdminClient } = await import("npm:@insforge/sdk");
    const admin = createAdminClient({
      baseUrl: requiredEnv("INSFORGE_BASE_URL"),
      apiKey: requiredEnv("INSFORGE_API_KEY")
    });
    const { data: rows, error } = await admin.database
      .from("google_calendar_state")
      .select("slot")
      .order("created_at", { ascending: true })
      .limit(4);
    if (error) throw error;
    return (Array.isArray(rows) ? rows : [])
      .map((row: any) => String(row?.slot ?? "").trim().toLowerCase())
      .filter((slot: string) => isValidSlotName(slot));
  } catch (error) {
    console.warn("calendar_slots_lookup_failed", error instanceof Error ? error.message : String(error));
    return [];
  }
}

type GoogleCalendarStateRow = {
  slot: string | null;
  refresh_token: string | null;
  access_token: string | null;
  token_expiry: string | null;
  calendar_id: string | null;
  timezone: string | null;
};

async function ensureGoogleAccessToken(admin: any, state: GoogleCalendarStateRow): Promise<string | null> {
  const expiryMs = state.token_expiry ? Date.parse(state.token_expiry) : 0;
  if (state.access_token && Number.isFinite(expiryMs) && expiryMs > Date.now() + 60_000) {
    return state.access_token;
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret || !state.refresh_token) return null;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: state.refresh_token,
      grant_type: "refresh_token"
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn(`calendar_token_refresh_failed status=${response.status} body=${detail.slice(0, 200)}`);
    return null;
  }

  const tokens = await response.json();
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
  if (!accessToken) return null;

  const expiresIn = Number(tokens?.expires_in);
  const lifetimeSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  await admin.database
    .from("google_calendar_state")
    .update({
      access_token: accessToken,
      token_expiry: new Date(Date.now() + lifetimeSeconds * 1000).toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("slot", state.slot || "owner");
  return accessToken;
}

function allDayEndDate(startDateIso: string): string {
  const dateOnly = startDateIso.slice(0, 10);
  const nextDay = new Date(Date.parse(`${dateOnly}T00:00:00Z`) + 24 * 60 * 60 * 1000);
  return nextDay.toISOString().slice(0, 10);
}

function formatEventStart(startIso: string, allDay: boolean, timezone: string): string {
  const parsed = Date.parse(startIso);
  if (!Number.isFinite(parsed)) return startIso;
  if (allDay) {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
    return `${fmt.format(parsed)} (all day)`;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true
  });
  let label = timezone;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(parsed);
    label = parts.find((part) => part.type === "timeZoneName")?.value || timezone;
  } catch {
    label = timezone;
  }
  return `${fmt.format(parsed)} ${label}`;
}

function nowString(timezone: string): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  });
  return `${fmt.format(now)} (${timezone})`;
}

async function applyPlannerAction(admin: any, action: PlannerAction): Promise<string> {
  const listName = plannerListLabel(action.list_key);
  if (action.action === "clear") {
    const { error } = await admin.database
      .from("planner_items")
      .delete()
      .eq("list_key", action.list_key);
    if (error) throw error;
    return `Cleared ${listName}.`;
  }

  if (action.action === "add") {
    // Grocery items land on a shop sublist; unspecified defaults to Albert Heijn.
    const rows = action.items.map((text) => ({
      list_key: action.list_key,
      text,
      done: false,
      ...(action.list_key === "grocery" ? { store: action.store || "ah" } : {})
    }));
    const { error } = await admin.database.from("planner_items").insert(rows);
    if (error) throw error;
    return `Added ${action.items.join(", ")} to ${listName}.`;
  }

  const done = action.action === "complete";
  if (action.action === "complete" || action.action === "uncomplete") {
    for (const item of action.items) {
      let query = admin.database
        .from("planner_items")
        .update({ done })
        .ilike("text", `%${item}%`);
      if (!action.all_lists) {
        query = query.eq("list_key", action.list_key);
      }
      const { error } = await query;
      if (error) throw error;
    }
    return `${done ? "Marked done" : "Marked open"}: ${action.items.join(", ")}.`;
  }

  for (const item of action.items) {
    let query = admin.database
      .from("planner_items")
      .delete()
      .ilike("text", `%${item}%`);
    if (!action.all_lists) {
      query = query.eq("list_key", action.list_key);
    }
    const { error } = await query;
    if (error) throw error;
  }

  return `Removed ${action.items.join(", ")} from ${listName}.`;
}

function plannerListLabel(listKey: ListKey): string {
  return listKey === "todo" ? "chores" : listKey;
}

async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

function sendTelegramMessageInBackground(chatId: string, text: string): void {
  sendTelegramMessage(chatId, text).catch((error) => {
    console.error(`telegram-webhook reply_error ${errorMessage(error)}`);
  });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Bot-Api-Secret-Token"
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- Phase 4: pregnancy care tasks + nutrition ----

type PregnancyTaskRow = {
  key: string;
  label: string;
  detail: string;
  due_week: number;
  category: string;
  done: boolean;
};

const GESTATION_DAYS = 280;
const PREGNANCY_NUTRITION_TRIMESTERS: Array<{ untilWeek: number; lines: string[] }> = [
  {
    untilWeek: 13,
    lines: [
      "SMALL PORTIONS - GINGER EASES NAUSEA",
      "NO RAW MEAT/FISH - NO SOFT RAW-MILK CHEESE"
    ]
  },
  {
    untilWeek: 27,
    lines: [
      "PROTEIN EVERY PLATE - IRON-RICH + VITAMIN C",
      "CALCIUM DAILY - FIBER + PLENTY OF WATER"
    ]
  },
  {
    untilWeek: 99,
    lines: [
      "EXTRA PROTEIN - SMALL FREQUENT PORTIONS",
      "OILY FISH 1X/WEEK - WATCH DIZZINESS/SWELLING"
    ]
  }
];

async function loadPregnancyTaskRows(admin: any): Promise<PregnancyTaskRow[]> {
  const { data: rows, error } = await admin.database
    .from("pregnancy_tasks")
    .select("key,label,detail,due_week,category,done")
    .order("due_week", { ascending: true });
  if (error) throw error;
  return Array.isArray(rows) ? rows as PregnancyTaskRow[] : [];
}

function pregnancyDueDate(): string {
  const dueDate = (Deno.env.get("PREGNANCY_DUE_DATE") || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : "";
}

function gestationalWeek(today: string): number {
  const dueDate = pregnancyDueDate();
  if (!dueDate) return 0;
  const dueIndex = Date.UTC(
    Number(dueDate.slice(0, 4)), Number(dueDate.slice(5, 7)) - 1, Number(dueDate.slice(8, 10))
  ) / 86400000;
  const parts = today.split("-").map(Number);
  const todayIndex = Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000;
  return Math.max(0, Math.floor(Math.max(0, todayIndex - (dueIndex - GESTATION_DAYS)) / 7));
}

function listPregnancyTasksReply(rows: PregnancyTaskRow[], today: string): string {
  const week = gestationalWeek(today);
  const open = rows.filter((row) => !row.done);
  const doneCount = rows.length - open.length;
  const lines: string[] = [`🤰 Week ${week} — ${open.length} task${open.length === 1 ? "" : "s"} open (${doneCount} done):`];
  for (const row of open) {
    const state = row.due_week <= week ? "OVERDUE" : `W${row.due_week}`;
    lines.push(`• [${state}] ${row.label}`);
  }
  if (open.length === 0) lines.push("• nothing open — great job!");
  return lines.join("\n");
}

async function applyPregnancyTaskAction(admin: any, action: PregnancyTaskAction): Promise<string> {
  const rows = await loadPregnancyTaskRows(admin);
  if (rows.length === 0) return "No pregnancy tasks configured.";
  const today = dashboardLocalDate();

  const query = action.task.trim().toLowerCase();
  let best: PregnancyTaskRow | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const hay = `${row.key} ${row.label}`.toLowerCase();
    if (hay.includes(query)) {
      const score = 100 + query.length;
      if (score > bestScore) { bestScore = score; best = row; }
      continue;
    }
    let score = 0;
    for (const word of query.split(/\s+/)) {
      if (word.length > 2 && hay.includes(word)) score += word.length;
    }
    if (score > bestScore) { bestScore = score; best = row; }
  }

  if (!best) {
    return `Unknown task "${action.task.slice(0, 40)}".\n${listPregnancyTasksReply(rows, today)}`;
  }
  if (best.done) {
    return `${best.label} is already marked done.`;
  }
  const { error } = await admin.database
    .from("pregnancy_tasks")
    .update({ done: true, done_at: new Date().toISOString() })
    .eq("key", best.key);
  if (error) throw error;
  return `✅ ${best.label} — marked done.`;
}

const PREGNANCY_MEALS: Array<{ b: string; l: string; d: string }> = [
  { b: "YOGHURT + GRANOLA + FRUIT", l: "VOLKOREN BROOD + EI", d: "ROAST CHICKEN + VEG" },
  { b: "HAVERMOUT + BANANA", l: "BROOD + KAAS + KOMKOMMER", d: "PASTA + TOMATO SAUCE + VEG" },
  { b: "YOGHURT + BERRIES", l: "SOUP + VOLKOREN BROOD", d: "SALMON + POTATO + VEG" },
  { b: "HAVERMOUT + APPLE", l: "WRAP + CHICKEN + SALAD", d: "RIJS + BEAN CURRY" },
  { b: "YOGHURT + GRANOLA", l: "BROOD + PINDAKAAS + EI", d: "STIR-FRY + RIJS" },
  { b: "HAVERMOUT + PEAR", l: "BROOD + EI + TOMATO", d: "FISH + POTATO + VEG" },
  { b: "YOGHURT + MUESLI", l: "SALAD + CHICKEN", d: "PASTA + PESTO + VEG" }
];

function nutritionReply(today: string): string {
  const week = gestationalWeek(today);
  const lines = (PREGNANCY_NUTRITION_TRIMESTERS.find((t) => week < t.untilWeek) ??
    PREGNANCY_NUTRITION_TRIMESTERS[PREGNANCY_NUTRITION_TRIMESTERS.length - 1]).lines;
  const supplements = ["Vitamine D 10 µg daily"];
  if (week <= 10) supplements.push("Foliumzuur 0.5 mg daily (until week 10)");
  supplements.push("No alcohol - caffeine < 200 mg/day");

  const weekday = (Math.floor(Date.parse(today) / 86400000) + 4) % 7; // 0 = Sunday
  const meal = PREGNANCY_MEALS[(weekday + 7) % 7];
  const meals = meal ? [`Meals today:`, `B: ${meal.b}`, `L: ${meal.l}`, `D: ${meal.d}`] : [];
  return [
    `🥗 Nutrition — week ${week}:`,
    ...lines.map((line) => `• ${line}`),
    "",
    ...supplements.map((s) => `• ${s}`),
    "",
    ...meals
  ].join("\n");
}

export function parseFastHeuristicMessage(message: string): TelegramAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  if (/^\/event\b/i.test(normalized)) {
    const eventAction = parseEventHeuristically(normalized);
    if (eventAction) return eventAction;
  }

  const todoAction = parsePregnancyTodoAction(normalized);
  if (todoAction) return todoAction;

  const queryAction = parseQueryMessage(normalized);
  if (queryAction) return queryAction;

  const hasPlannerVerb = /\b(add|put|include|buy|get|need|mark|check off|complete|completed|done|undo|uncheck|delete|remove|drop|clear|empty|reset)\b/.test(lower);
  // Question-shaped messages are lookups, not planner adds — let the LLM route them.
  const questionShaped = /^(what|any|show|is|are|do|does|list|read|grab|give|send|see|check)\b/.test(lower);
  if (hasPlannerVerb && hasExplicitList(normalized) && !questionShaped) {
    return parseMessageHeuristically(normalized);
  }

  return null;
}

// ---- phase 3.1: read-only Telegram queries ----

// Detects lookups ("what's on my grocery list", "any events today?"). Anything
// that mutates state (add/mark/clear/schedule/...) is NEVER a query, so the
// guard runs before the patterns.
export function parseQueryMessage(message: string): QueryAction | null {
  const lower = message.trim().replace(/\s+/g, " ").toLowerCase();
  if (/\b(add|put|include|buy|get|need|mark|check off|complete|completed|done|undo|uncheck|delete|remove|drop|clear|empty|reset|schedule|book|appointment)\b/.test(lower)) {
    return null;
  }
  if (/^\/event\b/.test(lower)) return null;

  const listy = /(what|show|list|any|read|grab|give|send|see|check|my)\b/.test(lower) || message.trim().split(/\s+/).length <= 3;
  if (/\bgrocer(y|ies)|shopping list\b/.test(lower) && listy) {
    return { kind: "query", query: "grocery" };
  }
  // Pregnancy care tasks checked BEFORE the generic todo/list patterns so
  // "care tasks" / "pregnancy tasks" never route to the chores list.
  if (/\bpregnancy tasks?\b|\bcare tasks?\b|^tasks?$|^my tasks\b/.test(lower)) {
    return { kind: "query", query: "pregnancy_tasks" };
  }
  if (/\btodos?|to-?dos?|chores?\b/.test(lower) && listy) {
    return { kind: "query", query: "todo" };
  }
  if (/\bworkout|exercise|training|gym\b/.test(lower) && listy) {
    return { kind: "query", query: "workout" };
  }
  if (/\bevents?\b|\bcalendar\b|\bplans?\b|\bwhat'?s on\b/.test(lower) && /\btoday\b|\btonight\b/.test(lower)) {
    return { kind: "query", query: "events_today" };
  }
  const rangeDays = parseEventRangeDays(lower);
  if (rangeDays !== null && /\bevents?\b|\bcalendar\b|\bplans?\b|\bplanned?\b|\bwhat'?s on\b|\bscheduled?\b|\bagenda\b/.test(lower)) {
    return { kind: "query", query: "events_range", days: rangeDays };
  }
  if (/\bnutrition\b|\bvitamins?\b|\bsupplements?\b|\bwhat (should|do) (i|we|she) eat\b|\bfood this week\b/.test(lower)) {
    return { kind: "query", query: "nutrition" };
  }
  return null;
}

// "next week" / "coming week" = 7 days (owner's definition); "next 10 days" = 10;
// "2 weeks" = 14; "next month" = 30. Returns null when no window is named.
export function parseEventRangeDays(message: string): number | null {
  const lower = message.toLowerCase();
  const numberMatch = lower.match(/\b(\d{1,3})\s*(days?|weeks?)\b/);
  if (numberMatch) {
    const n = Number(numberMatch[1]) * (/week/.test(numberMatch[2]) ? 7 : 1);
    return n >= 1 && n <= 90 ? n : null;
  }
  if (/\b(next|coming|this|following)\s+week\b/.test(lower)) return 7;
  if (/\bfortnight\b/.test(lower)) return 14;
  if (/\b(next|coming)\s+month\b/.test(lower)) return 30;
  return null;
}

// ---- phase 3.1: multi-calendar routing ----

const SLOT_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/;

export function isValidSlotName(value: string): boolean {
  return SLOT_PATTERN.test(value);
}

export function looksLikeBookingMessage(message: string): boolean {
  // "calendar" counts as booking-shaped: "add dentist to keethu calendar" must
  // route, not become a chores item (or an owner-calendar event).
  return /(^\/event\b)|\b(schedule|book|appointment)\b|\bcalendar\b/i.test(message);
}

// Extract a target calendar from a booking message WITHOUT mistaking calendar
// words for people: "schedule dentist for friday 3pm" must keep booking to the
// owner, so a candidate name is only accepted when it matches a CONNECTED slot.
// The matched fragment is stripped so the event title never inherits the name.
export function applySlotHint(message: string, slots: string[]): { message: string; slot: string | null } {
  const known = slots.filter((slot) => isValidSlotName(slot));
  if (known.length === 0 || !looksLikeBookingMessage(message)) {
    return { message, slot: null };
  }

  const normalized = message.trim().replace(/\s+/g, " ");
  const name = "([a-z][a-z0-9_-]{0,15})";
  const candidates: Array<{ slot: string; start: number; end: number }> = [];
  // "<name>(('s)|s)? calendar" wins over the bare "for <name>" form so the
  // longer fragment (including the word "calendar") is stripped from the title.
  for (const match of normalized.matchAll(new RegExp(`\\b(?:in|to|on|for)?\\s*${name}'?s?\\s+calendar\\b`, "gi"))) {
    candidates.push({ slot: match[1].toLowerCase(), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  for (const match of normalized.matchAll(new RegExp(`\\bfor\\s+${name}\\b`, "gi"))) {
    candidates.push({ slot: match[1].toLowerCase(), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  const prefixMatch = normalized.match(new RegExp(`^${name}\\s*:\\s*`, "i"));
  if (prefixMatch) {
    candidates.push({ slot: prefixMatch[1].toLowerCase(), start: 0, end: prefixMatch[0].length });
  }

  const hit = candidates.find((candidate) => known.includes(candidate.slot));
  if (!hit) return { message, slot: null };

  const stripped = `${normalized.slice(0, hit.start)} ${normalized.slice(hit.end)}`
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:;,.\-]+\s*/, "")
    .trim();
  return { message: stripped, slot: hit.slot };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" }
  });
}

function requiredEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function timeMs(): number {
  return Date.now();
}

function elapsedMs(started: number): number {
  return Date.now() - started;
}

function logTiming(label: string, timing: Record<string, number | string>): void {
  console.log(`${label} timing ${JSON.stringify(timing)}`);
}

const LIST_ALIASES: Record<ListKey, string[]> = {
  grocery: ["grocery", "groceries", "shopping", "market"],
  workout: ["workout", "exercise", "training", "gym"],
  todo: ["todo", "to-do", "task", "tasks", "errand", "errands"]
};

const LIST_KEYS: ListKey[] = ["grocery", "workout", "todo"];

function detectListKey(message: string): ListKey {
  const lower = message.toLowerCase();
  for (const key of LIST_KEYS) {
    if (LIST_ALIASES[key].some((alias) => lower.includes(alias))) return key;
  }
  return "todo";
}

// ---- phase 3.1: grocery shop sublists ----

export const GROCERY_STORES = ["ah", "turkish", "indian"];

// Phrases longest-first per store so "turkish market" wins over "turkish".
const STORE_ALIASES: Array<{ store: string; phrases: string[] }> = [
  { store: "ah", phrases: ["albert heijn", "ah"] },
  { store: "turkish", phrases: ["turkish market", "turkish"] },
  { store: "indian", phrases: ["indian grocery", "indian store", "indian market", "indian"] }
];

// Detects which shop a grocery message names ("add paneer to indian grocery")
// and returns the message with that phrase removed so the item text stays clean.
export function extractGroceryStore(message: string): { store: string | null; cleaned: string } {
  const normalized = message.trim().replace(/\s+/g, " ");
  for (const entry of STORE_ALIASES) {
    for (const phrase of entry.phrases) {
      const pattern = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const match = normalized.match(pattern);
      if (match && match.index !== undefined) {
        const cleaned = `${normalized.slice(0, match.index)} ${normalized.slice(match.index + match[0].length)}`
          .replace(/\s+/g, " ")
          .trim();
        return { store: entry.store, cleaned };
      }
    }
  }
  return { store: null, cleaned: normalized };
}

export function parseMessageHeuristically(message: string): TelegramAction {
  const { store, cleaned } = extractGroceryStore(message.trim().replace(/\s+/g, " "));
  const normalized = cleaned;
  let explicitList = hasExplicitList(normalized);
  if (!explicitList && store) {
    // "add brood to ah" — naming the shop implies the grocery list.
    explicitList = true;
  }
  if (!explicitList) {
    const eventAction = parseEventHeuristically(normalized);
    if (eventAction) return eventAction;
  }

  const lower = normalized.toLowerCase();
  let listKey = detectListKey(normalized);
  if (!hasExplicitList(normalized) && store) {
    listKey = "grocery";
  }

  let action: PlannerAction["action"] = "add";
  if (/\b(undo|uncheck|not done|incomplete)\b/.test(lower)) {
    action = "uncomplete";
  } else if (/\b(delete|remove|drop)\b/.test(lower)) {
    action = "delete";
  } else if (/\b(clear|empty|reset)\b/.test(lower)) {
    action = "clear";
  } else if (/\b(done|complete|completed|check off|mark)\b/.test(lower)) {
    action = "complete";
  }

  const withoutActionFirst = normalized
    .replace(/^(please\s+)?(add|put|include|buy|get|need|mark|check off|complete|completed|done|undo|uncheck|delete|remove|drop|clear|empty|reset)\s+/i, "")
    .replace(/\s+(done|complete|completed)$/i, "")
    .replace(/\s+(to|in|on|from)\s+(my\s+)?(grocery|groceries|shopping|market|workout|exercise|training|gym|todo|to-do|task|tasks|errand|errands)(\s+list|\s+plan)?$/i, "")
    .replace(/\s+(to|in|on|from)$/i, "")
    .trim();
  const withoutAction = stripListWords(withoutActionFirst, listKey)
    .replace(/\s+(to|in|on|from)$/i, "")
    .trim();

  const items =
    action === "clear"
      ? []
      : withoutAction
          .split(/\s*(?:,| and |\+)\s*/i)
          .map((item) => item.replace(/^the\s+/i, "").trim())
          .filter(Boolean);

  return {
    kind: "planner",
    action,
    list_key: listKey,
    items:
      action === "clear"
        ? []
        : items.length > 0
          ? items
          : [withoutAction || normalized],
    all_lists: !explicitList && (action === "complete" || action === "uncomplete" || action === "delete"),
    ...(listKey === "grocery" && store ? { store } : {})
  };
}

function validatePregnancyTaskAction(input: unknown): PregnancyTaskAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<PregnancyTaskAction>;
  if (candidate.kind !== "pregnancy_task" || candidate.action !== "complete_task") return null;
  const task = typeof candidate.task === "string" ? candidate.task.trim().slice(0, 80) : "";
  if (!task) return null;
  return { kind: "pregnancy_task", action: "complete_task", task };
}

// Phase 4: personal pregnancy todos (DO NOW on the pregnancy board).
// add: "add order vitamins to pregnancy todo" -> pregnancy_todo add
// done: "pregnancy todo done order vitamins" -> pregnancy_todo done
export function parsePregnancyTodoAction(message: string): PregnancyTodoAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (!lower.includes("pregnancy")) return null;
  if (!/\b(todo|todos|dashboard|list)\b/.test(lower)) return null;

  const addMatch = lower.match(/\b(?:add|put)\s+(.+?)\s+to\s+(?:my |the )?pregnancy(?:\s+(?:todo|dashboard|list))?\s*$/);
  if (addMatch) return { kind: "pregnancy_todo", action: "add", text: addMatch[1].trim() };

  const doneMatch = lower.match(/^(?:done|finished|completed)\s+(?:with\s+)?(?:my |the )?pregnancy\s+(?:todo|todos|list)\b[:\s-]*(.+)$/);
  if (doneMatch && doneMatch[1].trim()) return { kind: "pregnancy_todo", action: "done", text: doneMatch[1].trim() };
  return null;
}

function validatePregnancyTodoAction(input: unknown): PregnancyTodoAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<PregnancyTodoAction>;
  if (candidate.kind !== "pregnancy_todo") return null;
  if (candidate.action !== "add" && candidate.action !== "done") return null;
  const text = typeof candidate.text === "string" ? candidate.text.trim().slice(0, 120) : "";
  if (!text) return null;
  return { kind: "pregnancy_todo", action: candidate.action, text };
}

function validateQueryAction(input: unknown): QueryAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<QueryAction>;
  if (candidate.kind !== "query") return null;
  if (candidate.query === "events_range") {
    const days = Number(candidate.days);
    if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1 || days > 90) return null;
    return { kind: "query", query: "events_range", days };
  }
  if (candidate.query === "pregnancy_tasks" || candidate.query === "pregnancy_todo" || candidate.query === "nutrition") {
    return { kind: "query", query: candidate.query };
  }
  if (candidate.query !== "grocery" && candidate.query !== "todo" && candidate.query !== "workout" && candidate.query !== "events_today") return null;
  return { kind: "query", query: candidate.query };
}

export function validateTelegramAction(input: unknown): TelegramAction | null {
  return validateQueryAction(input) ?? validatePregnancyTodoAction(input) ?? validatePregnancyTaskAction(input) ?? validateClarifyAction(input) ?? validateEventAction(input) ?? validatePlannerAction(input);
}

export function validateEventAction(input: unknown, timeZone: string = dashboardTimezone()): CalendarEventAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<CalendarEventAction> & { date?: unknown; time?: unknown };
  if (candidate.kind !== "calendar" && candidate.action !== "create_event") return null;
  if (candidate.action && candidate.action !== "create_event") return null;

  const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, 120) : "";
  if (!title) return null;

  let startIso: string;
  let allDay = Boolean(candidate.all_day);

  if (typeof candidate.start_iso === "string" && candidate.start_iso.trim()) {
    const raw = candidate.start_iso.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      startIso = raw;
      allDay = true;
    } else if (Number.isFinite(Date.parse(raw)) && raw.includes("T")) {
      startIso = raw;
    } else {
      return null;
    }
  } else if (typeof candidate.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.date) &&
             typeof candidate.time === "string" && /^\d{1,2}:\d{2}$/.test(candidate.time)) {
    startIso = zonedToUtcIso(candidate.date, candidate.time, timeZone);
    if (!startIso) return null;
  } else {
    return null;
  }

  if (!Number.isFinite(Date.parse(startIso))) return null;

  let durationMin = 60;
  if (candidate.duration_min !== undefined && candidate.duration_min !== null) {
    const parsed = Number(candidate.duration_min);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 24 * 60) return null;
    durationMin = Math.round(parsed);
  }

  const location = typeof candidate.location === "string" && candidate.location.trim()
    ? candidate.location.trim().slice(0, 200)
    : undefined;

  // Phase 3.1: an explicit target that is not a well-formed slot name should
  // fail loudly rather than silently book into the owner's calendar.
  const rawSlot = candidate.calendar_slot === undefined || candidate.calendar_slot === null
    ? ""
    : String(candidate.calendar_slot).trim().toLowerCase();
  if (candidate.calendar_slot !== undefined && candidate.calendar_slot !== null && !isValidSlotName(rawSlot)) {
    return null;
  }

  return {
    kind: "calendar",
    action: "create_event",
    title,
    start_iso: startIso,
    duration_min: durationMin,
    all_day: allDay,
    ...(location ? { location } : {}),
    ...(rawSlot ? { calendar_slot: rawSlot } : {})
  };
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6
};

export function parseEventHeuristically(message: string, now: Date = new Date(), timeZone: string = dashboardTimezone()): CalendarEventAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  const isSlashCommand = /^\/event\b/i.test(normalized);
  const triggered = isSlashCommand || /\b(schedule|book|appointment)\b/.test(lower);
  if (!triggered) return null;

  const weekdayMatch = lower.match(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|rsday|urday)?\b/);
  const relativeMatch = lower.match(/\b(tomorrow|tonight|today)\b/);
  const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!weekdayMatch && !relativeMatch && !timeMatch) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  let dayOffset = 0;
  if (weekdayMatch) {
    const todayLocal = new Date(Date.UTC(Number(byType.year), Number(byType.month) - 1, Number(byType.day)));
    const targetIndex = WEEKDAY_INDEX[weekdayMatch[1]];
    dayOffset = (targetIndex - todayLocal.getUTCDay() + 7) % 7;
  } else if (relativeMatch?.[1] === "tomorrow") {
    dayOffset = 1;
  }

  let hours: number;
  let minutes = 0;
  if (timeMatch) {
    hours = Number(timeMatch[1]);
    minutes = Number(timeMatch[2] ?? 0);
    if (/pm/i.test(timeMatch[3] ?? "") && hours < 12) hours += 12;
    if (/am/i.test(timeMatch[3] ?? "") && hours === 12) hours = 0;
  } else if (relativeMatch?.[1] === "tonight") {
    hours = 20;
  } else {
    hours = 9;
  }
  if (hours > 23 || minutes > 59) return null;

  const pad = (value: number) => String(value).padStart(2, "0");
  const baseDay = new Date(Date.UTC(Number(byType.year), Number(byType.month) - 1, Number(byType.day) + dayOffset));
  const dateStr = `${baseDay.getUTCFullYear()}-${pad(baseDay.getUTCMonth() + 1)}-${pad(baseDay.getUTCDate())}`;
  const startIso = zonedToUtcIso(dateStr, `${pad(hours)}:${pad(minutes)}`, timeZone);
  if (!startIso) return null;
  let startMs = Date.parse(startIso);
  if (startMs <= now.getTime()) {
    startMs += 7 * 24 * 60 * 60 * 1000;
  }

  const finalIso = new Date(startMs).toISOString();
  const title = normalized
    .replace(/^\/event\b/i, " ")
    .replace(/\b(schedule|book|appointment)\b/i, " ")
    .replace(new RegExp(`\\b${weekdayMatch?.[0] ?? "\\u0000"}\\b`, "i"), " ")
    .replace(/\b(tomorrow|tonight|today)\b/i, " ")
    .replace(timeMatch ? new RegExp(timeMatch[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : /\u0000/, " ")
    .replace(/\b(at|on|next|this|for)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-,;:]+|[-,;:]+$/g, "")
    .trim();
  if (!title) return null;

  return {
    kind: "calendar",
    action: "create_event",
    title,
    start_iso: finalIso,
    duration_min: 60,
    all_day: false
  };
}

function validatePlannerAction(input: unknown): PlannerAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<PlannerAction>;

  if (!["add", "complete", "uncomplete", "delete", "clear"].includes(String(candidate.action))) return null;
  if (!LIST_KEYS.includes(candidate.list_key as ListKey)) return null;

  const items = Array.isArray(candidate.items)
    ? candidate.items.map((item) => String(item).trim()).filter(Boolean)
    : [];

  if (candidate.action !== "clear" && items.length === 0) return null;

  const rawStore = typeof candidate.store === "string" ? candidate.store.trim().toLowerCase() : "";
  return {
    kind: "planner",
    action: candidate.action as PlannerAction["action"],
    list_key: candidate.list_key as ListKey,
    items,
    all_lists: Boolean(candidate.all_lists),
    ...(candidate.list_key === "grocery" && GROCERY_STORES.includes(rawStore) ? { store: rawStore } : {})
  };
}

function extractMacroNumber(value: string, pattern: RegExp): number | null {
  const match = value.match(pattern);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function dashboardLocalDate(): string {
  const timezone = Deno.env.get("DASHBOARD_TIMEZONE") || "Asia/Kolkata";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function stripListWords(message: string, listKey: ListKey): string {
  let output = message;
  for (const alias of LIST_ALIASES[listKey]) {
    output = output.replace(new RegExp(`\\b${escapeRegExp(alias)}\\b`, "ig"), "");
  }
  return output.replace(/\s+(list|plan)\b/gi, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExplicitList(message: string): boolean {
  const lower = message.toLowerCase();
  return LIST_KEYS.some((key) => LIST_ALIASES[key].some((alias) => lower.includes(alias)));
}
