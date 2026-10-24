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
  query: "grocery" | "todo" | "workout" | "events_today" | "events_range" | "pregnancy_tasks" | "pregnancy_todo" | "chores" | "chores_all" | "nutrition" | "device_status";
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

// Phase 4.1: scheduled chores (recurrence + time window, reminders every 30 min).
// add stores the parsed schedule; done/skip/delete fuzzy-match today's chores.
type ChoreAction = {
  kind: "chore";
  action: "add" | "done" | "skip" | "delete";
  text: string;
  pattern?: "daily" | "weekly" | "once";
  days?: string;
  once_date?: string;
  start_min?: number;
  end_min?: number;
};

// Phase 4.2: smart-home device commands (first: WiZ lights). The applier
// writes a device_commands row; the Kindle on the home LAN executes the UDP
// call against the bulb. Reply is an ack of intent, not bulb confirmation.
type DeviceAction = {
  kind: "device";
  action: "set";
  target: string;
  state?: boolean;
  brightness?: number;
  temp?: number;
  color?: string;
};

type TelegramAction = PlannerAction | PregnancyTaskAction | PregnancyTodoAction | ChoreAction | DeviceAction | CalendarEventAction | ClarifyAction | QueryAction;

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
  "Read-only questions that ask what is ON a list or what events/plans exist in a window (no change requested) return: {\"kind\":\"query\",\"query\":\"grocery|todo|workout|events_today|events_range|pregnancy_tasks|pregnancy_todo|chores|chores_all|nutrition|device_status\",\"days\":7}. \"events_today\" is for questions about TODAY only. \"events_range\" covers next week, coming days, etc. - set \"days\" to the window length in days: next week/coming week = 7, next 10 days = 10, next fortnight = 14, next month = 30. \"pregnancy_tasks\" lists the pregnancy care checklist; \"pregnancy_todo\" lists the personal pregnancy todos shown on the dashboard DO NOW section; \"chores\" lists today's scheduled chores with their times; set \"days\":1 for chores tomorrow (any day offset 0-6, e.g. \"what chores are there tomorrow\"); \"chores_all\" lists every chore with its full recurring schedule (\"list all the chores\"); \"nutrition\" gives this week's pregnancy nutrition + supplements; \"device_status\" answers questions about the CURRENT light state (the bulb is read from the Kindle screen, not the bot).",
  "For SMART-HOME LIGHTS (WiZ bulbs; a physical action) return {\"kind\":\"device\",\"action\":\"set\",\"target\":\"<bulb name substring or 'all'>\",\"state\":true|false,\"brightness\":<1-100>,\"temp\":<2200-6500 Kelvin>,\"color\":\"white|red|green|blue\"} - include ONLY the fields the message implies: \"lights off\" -> {\"state\":false}; \"dim lights to 50\" -> {\"brightness\":50,\"state\":true}; \"lights warm\" -> {\"temp\":2700,\"state\":true}; \"lights blue\" -> {\"color\":\"blue\",\"state\":true}; \"night light\" -> {\"brightness\":6,\"temp\":2200,\"state\":true}; \"bedroom light off\" -> {\"target\":\"bedroom\",\"state\":false}. NEVER guess a toggle when unsure what the message wants - clarify instead; wrong light switches are worse than a question.",
  "For SCHEDULED CHORES (time-bound tasks with reminders, shown on the dashboard CHORES panel) return {\"kind\":\"chore\",...}. {\"kind\":\"chore\",\"action\":\"add\",\"text\":\"<chore text>\",\"pattern\":\"daily|weekly|once\",\"days\":\"<csv mo,tu,we,th,fr,sa,su when weekly>\",\"once_date\":\"<YYYY-MM-DD when once>\",\"start_min\":<minutes from midnight>,\"end_min\":<minutes from midnight>} when the message adds a chore with a recurrence or time (e.g. \"add chore clean kitchen every saturday\", \"soak the cashew everyday at 10pm\", \"take out trash on tuesday thursday and saturday\"). {\"kind\":\"chore\",\"action\":\"done\",\"text\":\"<chore words>\"} marks one of today's chores done; \"skip\" mutes it for today; \"delete\" removes the chore entirely. Chore messages usually contain the word chore, or words like everyday/every <weekday>/tomorrow/at <time>. These chores are DIFFERENT from the plain todo list (no time, lives indefinitely). Chore time rules: a single point time (\"at 10pm\") is start_min=1320 with end_min=1440 (chores nag until midnight); a window (\"from 10am to 10pm\") sets both; when the message names NO time, OMIT start_min and end_min entirely (server defaults 10:00-22:00). NEVER invent a duration (no start+60) or an all-day 00:00-23:59 window yourself.",
  "For personal pregnancy todos return {\"kind\":\"pregnancy_todo\",\"action\":\"add\",\"text\":\"<todo text>\"} when the message asks to ADD something to the pregnancy todos/dashboard list (e.g. \"add buy vitamins to pregnancy todo\"), and {\"kind\":\"pregnancy_todo\",\"action\":\"done\",\"text\":\"<todo words>\"} when it marks one of those personal todos as done. These are separate from the pregnancy care checklist tasks.",
  "For pregnancy care tasks return: {\"kind\":\"pregnancy_task\",\"action\":\"complete_task\",\"task\":\"<task words>\"} when the message marks a pregnancy care task as done (kraamzorg booking, kinkhoest vaccination, GBS swab, scans, hospital registration, baby shopping, hospital bag). Fuzzy-match the task words against the connected task list in the system context.",
  "Undo/redo/revert requests are NOT supported: for any message asking to undo, revert, or take back the last change, return {\"kind\":\"none\"}. Also return {\"kind\":\"none\"} for questions or small talk instead of inventing items.",
  "When an add or completion does not make clear WHICH list it belongs to - scheduled chores (time-bound, recurring) vs the plain todo list (no time, lives indefinitely) vs grocery vs workout vs a pregnancy todo vs a pregnancy care task - do NOT guess: return {\"kind\":\"clarify\",\"question\":\"<one short question naming the options>\"} (e.g. \"Chore, todo, or grocery?\"). Clues: words like chore, everyday, every <weekday>, at <time>, tomorrow/next <weekday> mean a chore; todo/task/errand mean the todo list; grocery/shopping means grocery. A bare \"chore done\" with no target is ambiguous: ask which chore. A bare add with NO list clue at all (e.g. \"add milk\") is ALSO ambiguous - do NOT default it to grocery: ask \"Chore, todo, or grocery?\".",
  "If a message marks something done but the target is missing or too vague (e.g. just \"chore done\", \"done\"), return {\"kind\":\"clarify\",\"question\":\"<which item?>\"} instead of inventing one.",
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

// Phase 4.1: the LLM routes FIRST — it sees the full routing context (scheduled
// chores vs the plain todo list vs grocery vs pregnancy) and can ask clarify
// questions on ambiguity. The deterministic heuristics are the FALLBACK for
// LLM outages, bad responses, or a missing ZAI_API_KEY.
function heuristicFallback(message: string): TelegramAction | null {
  return parseFastHeuristicMessage(message) ?? parseMessageHeuristically(message);
}

async function parseAction(message: string, slots: string[]): Promise<TelegramAction | null> {
  // Read-only lookups route deterministically first: exact day math ("chores
  // tomorrow"), zero misroute risk (the guard inside rejects mutations), and
  // no LLM latency. Mutations and ambiguous messages go to the LLM.
  const queryAction = parseQueryMessage(message);
  if (queryAction) return queryAction;

  const zaiKey = Deno.env.get("ZAI_API_KEY");
  if (!zaiKey) {
    return heuristicFallback(message);
  }

  const slotLine = slots.length > 0
    ? ` Connected calendars: ${slots.join(", ")}.`
    : "";
  let response: Response;
  try {
    response = await fetch("https://api.z.ai/api/coding/paas/v4/chat/completions", {
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
  } catch (error) {
    console.warn(`zai_fetch_failed error=${String(error).slice(0, 200)}`);
    return heuristicFallback(message);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    console.warn(`zai_parse_failed status=${response.status} body=${errBody.slice(0, 300)}`);
    return heuristicFallback(message);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return heuristicFallback(message);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return heuristicFallback(message);
  }
  if (parsed && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === "none") {
    return null;
  }
  return validateTelegramAction(parsed) ?? heuristicFallback(message);
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
  if (action.kind === "chore") return applyChoreAction(admin, action);
  if (isDeviceAction(action)) return applyDeviceAction(admin, action);
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
  if (action.query === "chores") {
    const offset = action.days && action.days > 0 ? Math.min(action.days, 6) : 0;
    const day = addDaysIso(dashboardLocalDate(), offset);
    return listChoresReply(await loadTodayChores(admin, day), day);
  }
  if (action.query === "chores_all") {
    return listAllChoresReply(await loadAllChores(admin));
  }
  if (action.query === "device_status") {
    return "💡 Live light state is on the Kindle LIGHTS screen — the bot can't see the bulb directly.";
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

  const choreAction = parseChoreAction(normalized);
  if (choreAction) return choreAction;

  // Ambiguous chore statements ("chore done", "add chore" with no target) ask
  // back instead of risking a wrong action.
  if (/\bchores?\b/.test(lower) && !hasExplicitList(lower)) {
    const residual = lower
      .replace(/\b(?:please|the|my|a|an|is|are|do|did|to|it)\b/g, " ")
      .replace(/\bchores?\b/g, " ")
      .replace(/\b(?:add|put|done|finished|completed|skip|delete|remove)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!residual) {
      return {
        kind: "clarify",
        question: /\b(?:done|finished|completed)\b/.test(lower)
          ? "Which chore is done? Name it, e.g. \"chore done soak the cashew\"."
          : "What chore should I add? Include the day(s) and time if any."
      };
    }
  }

  const queryAction = parseQueryMessage(normalized);
  if (queryAction) return queryAction;

  const deviceAction = parseDeviceAction(normalized);
  if (deviceAction) return deviceAction;

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
  // Personal pregnancy todos BEFORE the generic todo pattern so "pregnancy
  // todos" lists the DO NOW todos, not the chores list.
  if (/\bpregnancy\s+(todos?|to-?dos?|list)\b/.test(lower)) {
    return { kind: "query", query: "pregnancy_todo" };
  }
  // Scheduled chores BEFORE the generic todo pattern ("chores" is today's
  // scheduled list now; "todo" stays the indefinite list). Day-aware: tomorrow,
  // and "all chores" lists the whole recurring schedule.
  if (/\bchores?\b/.test(lower)) {
    if (/\ball\b|\bevery\b|\btotal\b|\beverything\b|full (chore )?(list|schedule)|whole (chore )?(list|schedule)/.test(lower)) {
      return { kind: "query", query: "chores_all" };
    }
    const offset = /\btomorrow\b/.test(lower) ? 1 : 0;
    return { kind: "query", query: "chores", ...(offset ? { days: offset } : {}) };
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
  // Live bulb state lives on the Kindle (LAN UDP) — the bot points there.
  if (/\b(are|is)\s+(the\s+)?lights?\s+(on|off)\b|\blight(s)? status\b/.test(lower)) {
    return { kind: "query", query: "device_status" };
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

  // Both word orders: "done pregnancy todo X" and "pregnancy todo done X"
  const doneMatch =
    lower.match(/^(?:done|finished|completed)\s+(?:with\s+)?(?:my |the )?pregnancy\s+(?:todo|todos|list)\b[:\s-]*(.+)$/) ||
    lower.match(/^pregnancy\s+(?:todo|todos|list)\s+(?:done|finished|completed)\s+(.+)$/);
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

// ---- Phase 4.1: scheduled chores (recurrence + window, 30-min reminders) ----

const CHORE_WEEKDAYS: Array<[RegExp, string]> = [
  [/\bmondays?\b|\bmon\b/, "mo"],
  [/\btuesdays?\b|\btues?\b/, "tu"],
  [/\bwednesdays?\b|\bwed\b/, "we"],
  [/\bthursdays?\b|\bthurs?\b/, "th"],
  [/\bfridays?\b|\bfri\b/, "fr"],
  [/\bsaturdays?\b|\bsat\b/, "sa"],
  [/\bsundays?\b|\bsun\b/, "su"]
];

export type ParsedChoreSchedule = {
  pattern: "daily" | "weekly" | "once";
  days: string;
  once_date: string;
  start_min: number;
  end_min: number;
};

// Minutes-since-midnight from "10pm", "9:30 am", "22:00", "7:00". Null when no time.
export function parseChoreTimeToken(lower: string): { min: number; span: [number, number] } | null {
  const patterns: RegExp[] = [
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/,
    /\b(\d{1,2}):(\d{2})\b/,
    /\b(\d{1,2})\s*(?:am|pm)\b/
  ];
  for (const re of patterns) {
    const m = lower.match(re);
    if (!m) continue;
    let hours = Number(m[1]);
    const minutes = m[2] ? Number(m[2]) : 0;
    const meridiem = m[3];
    if (meridiem) {
      if (hours < 1 || hours > 12) continue;
      if (meridiem === "pm" && hours !== 12) hours += 12;
      if (meridiem === "am" && hours === 12) hours = 0;
    } else if (!m[2] && !m[0].includes(":")) {
      continue; // bare "7" is not a time
    }
    if (hours > 23 || minutes > 59) continue;
    return { min: hours * 60 + minutes, span: [m.index ?? 0, (m.index ?? 0) + m[0].length] };
  }
  return null;
}

// Window from "from 10am to 10pm" / "10am-10pm" / "at 10pm" / none (defaults 10:00-22:00).
export function parseChoreTimeWords(lower: string): { start_min: number; end_min: number; spans: Array<[number, number]> } {
  const defaults = { start_min: 600, end_min: 1320, spans: [] as Array<[number, number]> };
  const range = lower.match(/\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (range) {
    const toMin = (h: string, mm: string | undefined, mer: string | undefined, prevHour: number | null) => {
      let hours = Number(h);
      const minutes = mm ? Number(mm) : 0;
      if (mer === "pm" && hours !== 12) hours += 12;
      if (mer === "am" && hours === 12) hours = 0;
      if (!mer && prevHour !== null && hours < prevHour) hours += 12; // "10 to 10" ambiguous; "9-5" style
      return hours * 60 + minutes;
    };
    const start = toMin(range[1], range[2], range[3], null);
    let end = toMin(range[4], range[5], range[6], range[3] ? Number(range[1]) : null);
    if (end <= start) end = Math.min(end + 12 * 60, 1440);
    if (start < 1440 && end > start) {
      return { start_min: start, end_min: Math.max(end, start + 30), spans: [[range.index ?? 0, (range.index ?? 0) + range[0].length]] };
    }
    return defaults;
  }
  const point = parseChoreTimeToken(lower);
  if (point) {
    // Point-time chore nags until midnight (quiet hours trim the tail).
    return { start_min: point.min, end_min: 1440, spans: [point.span] };
  }
  return defaults;
}

// 'YYYY-MM-DD' -> 'mo'..'su' (dates are dashboard-local; noon UTC avoids tz edges).
export function choreWeekdayOf(day: string): string {
  const map: Record<string, string> = {
    mon: "mo", tue: "tu", wed: "we", thu: "th", fri: "fr", sat: "sa", sun: "su"
  };
  const parsed = Date.parse(`${day}T12:00:00Z`);
  const wd = new Date(parsed).toUTCString().slice(0, 3).toLowerCase();
  return map[wd] ?? wd.slice(0, 2);
}

export function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// Next STRICTLY-future occurrence of the weekday ('mo'..'su').
export function nextWeekdayIso(fromIso: string, wd: string): string {
  for (let i = 1; i <= 8; i++) {
    const candidate = addDaysIso(fromIso, i);
    if (choreWeekdayOf(candidate) === wd) return candidate;
  }
  return addDaysIso(fromIso, 7);
}

// Schedule words -> pattern/days/date + the spans to strip from the chore text.
export function parseChoreDayWords(lower: string, today: string): {
  pattern: "daily" | "weekly" | "once";
  days: string;
  once_date: string;
  spans: Array<[number, number]>;
} | null {
  const spans: Array<[number, number]> = [];
  const pushSpan = (m: RegExpMatchArray) => spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);

  const daily = lower.match(/\b(?:every|each)\s+day\b|\beveryday\b|\bdaily\b/);
  if (daily) {
    pushSpan(daily);
    return { pattern: "daily", days: "", once_date: "", spans };
  }

  const everyWd = lower.match(/\b(?:every|each)\s+(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/);
  if (everyWd) {
    pushSpan(everyWd);
    const wd = matchWeekdayToken(everyWd[1]);
    return { pattern: "weekly", days: wd, once_date: "", spans };
  }

  const onList = lower.match(/\b(?:on|every)\s+((?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|mon|tue|tues|wed|thu|thurs|fri|sat|sun)(?:\s*(?:,|and|&)\s*(?:mon|tues|wednes|thurs|fri|satur|sun)days?|\s*(?:,|and|&)\s*(?:mon|tue|tues|wed|thu|thurs|fri|sat|sun))*)\b/);
  if (onList) {
    pushSpan(onList);
    const tokens = onList[1].split(/,|and|&/).map((t) => matchWeekdayToken(t.trim())).filter(Boolean);
    const days = [...new Set(tokens)].join(",");
    if (days) return { pattern: "weekly", days, once_date: "", spans };
  }

  const tomorrow = lower.match(/\btomorrow\b/);
  if (tomorrow) {
    pushSpan(tomorrow);
    return { pattern: "once", days: "", once_date: addDaysIso(today, 1), spans };
  }
  const nextWd = lower.match(/\bnext\s+(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/);
  if (nextWd) {
    pushSpan(nextWd);
    return { pattern: "once", days: "", once_date: nextWeekdayIso(today, matchWeekdayToken(nextWd[1])), spans };
  }
  const todayMatch = lower.match(/\btoday\b/);
  if (todayMatch) {
    pushSpan(todayMatch);
    return { pattern: "once", days: "", once_date: today, spans };
  }
  return null;
}

function matchWeekdayToken(token: string): string {
  const t = token.toLowerCase().trim();
  for (const [re, wd] of CHORE_WEEKDAYS) {
    if (re.test(` ${t} `)) return wd;
  }
  return "";
}

// Chore-shaped adds: the word "chore", a strong recurrence marker
// (everyday / every <weekday> / a multi-weekday list), or an add verb +
// schedule words — and never when an explicit planner list is named
// (grocery/todo/workout keep their routes; bare weekday + no verb stays with
// the LLM so event-ish messages like "dinner saturday" are not hijacked).
export function choreAddShaped(lower: string): boolean {
  if (/\bchores?\b/.test(lower)) {
    // Question-shaped chore mentions are lookups, not adds ("what chores are
    // there tomorrow") — let the query path route them.
    const questionShaped = /^(?:what|which|list|show|any|are|do|does|is|read|grab|give|see|check|tell)\b|are there\b/.test(lower);
    return !questionShaped;
  }
  if (hasExplicitList(lower)) return false;
  const strongRecurrence =
    /\b(?:everyday|every\s+day|each\s+day|daily)\b/.test(lower) ||
    /\bevery\s+(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/.test(lower) ||
    /\bon\s+(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tue|tues|wed|thu|thurs|fri|sat|sun)(?:\s*(?:,|and|&)\s*(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tue|tues|wed|thu|thurs|fri|sat|sun))+\b/.test(lower);
  if (strongRecurrence) return true;
  const addVerb = /\b(?:add|put|create|new|schedule|remind me to)\b/.test(lower);
  if (!addVerb) return false;
  return /\b(?:tomorrow|next\s+(?:mon|tue|wed|thu|fri|sat|sun))\b|\bat\s+\d{1,2}\b|\b\d{1,2}\s*(?:am|pm)\b|\bfrom\s+\d{1,2}\b/.test(lower);
}

// Node tests run without Deno; they pass `today` explicitly.
function choreTodayIso(): string {
  try {
    return dashboardLocalDate();
  } catch {
    return "";
  }
}

export function parseChoreAction(message: string, today: string = choreTodayIso()): ChoreAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  // done / skip / delete: need the word "chore" (bare "done X" stays with the
  // pregnancy-task/LLM paths).
  if (/\bchores?\b/.test(lower)) {
    const skip = lower.match(/^(?:please\s+)?(?:skip|snooze)\s+(?:the\s+|my\s+)?chore\s+(.+?)(?:\s+today)?\s*$/);
    if (skip && skip[1].trim()) return { kind: "chore", action: "skip", text: skip[1].trim() };
    const del = lower.match(/^(?:please\s+)?(?:delete|remove|drop)\s+(?:the\s+|my\s+)?chore\s+(.+)$/);
    if (del && del[1].trim()) return { kind: "chore", action: "delete", text: del[1].trim() };
    const done =
      lower.match(/^chores?\s+(?:done|finished|completed)\s+(.+)$/) ||
      lower.match(/^(?:done|finished|completed)(?:\s+with)?\s+(?:the\s+|my\s+)?chores?\s+(.+)$/);
    if (done && done[1].trim()) return { kind: "chore", action: "done", text: done[1].trim() };
  }

  if (!choreAddShaped(lower)) return null;

  const time = parseChoreTimeWords(lower);
  const day = parseChoreDayWords(lower, today);
  const schedule: ParsedChoreSchedule = {
    pattern: day?.pattern ?? "once",
    days: day?.days ?? "",
    once_date: day?.once_date ?? today,
    start_min: time.start_min,
    end_min: time.end_min
  };

  // Text = message minus schedule spans minus verb scaffolding.
  let text = normalized;
  const spans = [...time.spans, ...(day?.spans ?? [])].sort((a, b) => a[0] - b[0]);
  for (let i = spans.length - 1; i >= 0; i--) {
    text = text.slice(0, spans[i][0]) + " " + text.slice(spans[i][1]);
  }
  text = text
    .replace(/^\/?chore[s]?[:\s-]*/i, "")
    .replace(/^(?:please\s+)?(?:add|put|create|new|schedule)\s+/i, "")
    .replace(/^(?:chore[s]?\s+)?(?:to\s+)?/i, "")
    .replace(/\s+(?:to|into|as)\s+chores?\s*$/i, "")
    .replace(/\s+(?:at|on|every|from|each|and)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–:,\s]+/, "")
    .slice(0, 80);
  // "chore done" / "add chore" leave a bare action or scaffold word, not a
  // chore text — let the clarify guard handle those instead of adding junk.
  if (!text || /^(?:done|finished|completed|skip|delete|remove|it|chore|chores)$/i.test(text)) return null;

  const action: ChoreAction = { kind: "chore", action: "add", text };
  if (day) {
    action.pattern = schedule.pattern;
    if (schedule.pattern === "weekly") action.days = schedule.days;
    if (schedule.pattern === "once" && schedule.once_date !== today) action.once_date = schedule.once_date;
  }
  if (time.spans.length > 0) {
    action.start_min = schedule.start_min;
    action.end_min = schedule.end_min;
  }
  return action;
}

function describeChore(action: ChoreAction): string {
  const time = action.start_min !== undefined && action.end_min !== undefined
    ? ` ${timeWindowLabel(action.start_min, action.end_min)}`
    : " 10:00-22:00";
  if (action.pattern === "daily") return `every day${time}`;
  if (action.pattern === "weekly") return `${(action.days || "").split(",").join(", ")}${time}`;
  if (action.once_date && action.once_date !== dashboardLocalDate()) return `${action.once_date}${time}`;
  return `today${time}`;
}

function timeWindowLabel(startMin: number, endMin: number): string {
  const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return endMin >= 1440 ? fmt(startMin) : `${fmt(startMin)}-${fmt(endMin)}`;
}

type TodayChore = {
  id: string;
  text: string;
  start_min: number;
  end_min: number;
  done: boolean;
};

async function loadTodayChores(admin: any, day: string): Promise<TodayChore[]> {
  const { data: rows, error } = await admin.database
    .from("chores")
    .select("id,text,pattern,days,once_date,start_min,end_min,skip_date");
  if (error) throw error;
  const { data: dones, error: doneError } = await admin.database
    .from("chore_dones")
    .select("chore_id")
    .eq("day", day);
  if (doneError) throw doneError;
  const doneIds = new Set((dones ?? []).map((r: { chore_id: string }) => r.chore_id));
  return (rows ?? [])
    .filter((chore: any) => choreOccursOn(chore, day) && chore.skip_date !== day)
    .map((chore: any) => ({ ...chore, done: doneIds.has(chore.id) }))
    .sort((a: TodayChore, b: TodayChore) => a.start_min - b.start_min);
}

function choreOccursOn(chore: { pattern: string; days: string; once_date: string }, day: string): boolean {
  if (chore.pattern === "once") return chore.once_date === day;
  if (chore.pattern === "daily") return true;
  return chore.days.split(",").filter(Boolean).includes(choreWeekdayOf(day));
}

function listChoresReply(chores: TodayChore[], day: string = dashboardLocalDate()): string {
  const label = day === dashboardLocalDate() ? "today" : `for ${dayLabel(day)}`;
  if (chores.length === 0) return `🧹 No chores ${label}.`;
  const lines = chores.map((c) => {
    const mark = c.done ? "✅" : "⬜";
    return `• ${mark} ${c.text} (${timeWindowLabel(c.start_min, c.end_min)})`;
  });
  return `🧹 Chores ${label} (${chores.filter((c) => c.done).length}/${chores.length} done):\n${lines.join("\n")}`;
}

// 'YYYY-MM-DD' -> "Tue Oct 20" (dashboard-local date; noon UTC avoids tz edges).
function dayLabel(day: string): string {
  const parsed = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(parsed)) return day;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", weekday: "short", day: "numeric", month: "short"
  });
  return fmt.format(parsed);
}

// Every chore with its recurring schedule (not just today's occurrences).
async function loadAllChores(admin: any): Promise<Array<{ text: string; pattern: string; days: string; once_date: string; start_min: number; end_min: number }>> {
  const { data: rows, error } = await admin.database
    .from("chores")
    .select("text,pattern,days,once_date,start_min,end_min")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (rows ?? []) as Array<{ text: string; pattern: string; days: string; once_date: string; start_min: number; end_min: number }>;
}

export function listAllChoresReply(chores: Array<{ text: string; pattern: string; days: string; once_date: string; start_min: number; end_min: number }>): string {
  if (chores.length === 0) return "🧹 No chores scheduled. Add one: \"add chore clean kitchen every saturday\".";
  const lines = chores.map((c) => {
    const time = timeWindowLabel(c.start_min, c.end_min);
    if (c.pattern === "daily") return `• ${c.text} — every day ${time}`;
    if (c.pattern === "weekly") return `• ${c.text} — ${c.days.split(",").filter(Boolean).join(",")} ${time}`;
    return `• ${c.text} — ${c.once_date || "today"} ${time}`;
  });
  return `🧹 All chores (${chores.length}):\n${lines.join("\n")}`;
}

async function applyChoreAction(admin: any, action: ChoreAction): Promise<string> {
  const today = dashboardLocalDate();

  if (action.action === "add") {
    const text = action.text.trim().slice(0, 80);
    if (!text) return "What chore should I add?";
    const row: Record<string, unknown> = {
      id: crypto.randomUUID(),
      text,
      pattern: action.pattern ?? "once",
      days: action.days ?? "",
      once_date: action.once_date ?? (action.pattern ? "" : today),
      start_min: action.start_min ?? 600,
      end_min: action.end_min ?? 1320
    };
    if (row.pattern === "once" && !row.once_date) row.once_date = today;
    if (row.pattern === "daily") row.once_date = "";
    if (row.pattern === "weekly" && !row.days) row.pattern = "daily";
    const { error } = await admin.database.from("chores").insert([row]);
    if (error) throw error;
    return `🧹 Added chore: ${text} — ${describeChore({ ...action, ...row } as ChoreAction)}`;
  }

  const todayChores = await loadTodayChores(admin, today);
  if (action.action === "done") {
    const query = action.text.trim().toLowerCase();
    let best: TodayChore | null = null;
    let bestScore = 0;
    for (const chore of todayChores) {
      if (chore.done) continue;
      const hay = chore.text.toLowerCase();
      if (hay.includes(query)) {
        const score = 100 + query.length;
        if (score > bestScore) { bestScore = score; best = chore; }
      } else if (query.includes(hay) || fuzzyOverlap(query, hay)) {
        const score = 50 + hay.length;
        if (score > bestScore) { bestScore = score; best = chore; }
      }
    }
    if (!best) {
      return `No open chore matches "${action.text.slice(0, 40)}".\n${listChoresReply(todayChores)}`;
    }
    const { error } = await admin.database
      .from("chore_dones")
      .insert([{ chore_id: best.id, day: today }]);
    if (error) throw error;
    return `✅ Chore done: ${best.text}`;
  }

  if (action.action === "skip") {
    const query = action.text.trim().toLowerCase();
    const chore = todayChores.find((c) => c.text.toLowerCase().includes(query)) ??
      todayChores.find((c) => query.includes(c.text.toLowerCase()));
    if (!chore) return `No chore matches "${action.text.slice(0, 40)}".`;
    const { error } = await admin.database.from("chores").update({ skip_date: today }).eq("id", chore.id);
    if (error) throw error;
    return `⏭️ Skipped today: ${chore.text} — back on its next day`;
  }

  // delete: match across ALL chores, not just today's
  const { data: rows, error: rowsError } = await admin.database
    .from("chores")
    .select("id,text");
  if (rowsError) throw rowsError;
  const query = action.text.trim().toLowerCase();
  const all = (rows ?? []) as Array<{ id: string; text: string }>;
  const victim = all.find((c) => c.text.toLowerCase().includes(query)) ??
    all.find((c) => query.includes(c.text.toLowerCase()));
  if (!victim) return `No chore matches "${action.text.slice(0, 40)}".`;
  const { error } = await admin.database.from("chores").delete().eq("id", victim.id);
  if (error) throw error;
  return `🗑️ Deleted chore: ${victim.text}`;
}

function fuzzyOverlap(query: string, hay: string): boolean {
  const qWords = query.split(/\s+/).filter((w) => w.length > 2);
  if (qWords.length === 0) return false;
  const hits = qWords.filter((w) => hay.includes(w)).length;
  return hits / qWords.length >= 0.6;
}

function validateChoreAction(input: unknown): ChoreAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<ChoreAction>;
  if (candidate.kind !== "chore") return null;
  if (candidate.action !== "add" && candidate.action !== "done" && candidate.action !== "skip" && candidate.action !== "delete") return null;
  const text = typeof candidate.text === "string" ? candidate.text.trim().slice(0, 80) : "";
  if (!text) return null;
  const action: ChoreAction = { kind: "chore", action: candidate.action, text };
  if (candidate.action === "add") {
    if (candidate.pattern === "daily" || candidate.pattern === "weekly" || candidate.pattern === "once") action.pattern = candidate.pattern;
    if (typeof candidate.days === "string") action.days = candidate.days.replace(/[^a-z,]/g, "").slice(0, 20);
    if (typeof candidate.once_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.once_date)) action.once_date = candidate.once_date;
    for (const key of ["start_min", "end_min"] as const) {
      const value = candidate[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1440) {
        action[key] = Math.round(value);
      }
    }
    // An "all-day" 00:00-23:59 window from the LLM means no time was actually
    // given — drop it so the server applies the 10:00-22:00 default.
    if (action.start_min === 0 && (action.end_min ?? 0) >= 1439) {
      delete action.start_min;
      delete action.end_min;
    }
    if (action.start_min !== undefined && action.end_min !== undefined && action.end_min <= action.start_min) {
      delete action.start_min;
      delete action.end_min;
    }
  }
  return action;
}

// ---- Phase 4.2: smart-home lights (WiZ, executed by the Kindle over LAN UDP) ----

const LIGHT_COLORS: Record<string, { r: number; g: number; b: number; label: string }> = {
  white: { r: 255, g: 255, b: 255, label: "white" },
  red: { r: 255, g: 30, b: 30, label: "red" },
  green: { r: 40, g: 220, b: 80, label: "green" },
  blue: { r: 60, g: 110, b: 255, label: "blue" }
};

function isDeviceAction(action: TelegramAction): action is DeviceAction {
  return action.kind === "device";
}

// Deterministic fallback: "lights on/off", "dim lights to 50", "lights warm",
// "lights blue", "night light", "bedroom light off". The LLM handles the rest.
export function parseDeviceAction(message: string): DeviceAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (!/\blights?\b/.test(lower) && !/\bnight light\b/.test(lower)) return null;
  if (hasExplicitList(lower)) return null;
  // Status questions have no live answer in the bot (the bulb state lives on
  // the Kindle screen).
  if (/\b(are|is)\s+(the\s+)?lights?\b|\blight status\b/.test(lower)) return null;

  // Target: leading room words before "light(s)" (e.g. "bedroom light off").
  let target = "all";
  const targetMatch = lower.match(/^([a-z]+)\s+lights?\b/);
  if (targetMatch && !/^(?:the|my|a|all|turn|please|dim|set|switch|flip)$/.test(targetMatch[1])) {
    target = targetMatch[1];
  }

  const action: DeviceAction = { kind: "device", action: "set", target };

  const onOff = lower.match(/\b(?:lights?|lamp)\s+(on|off)\b/) || lower.match(/\b(?:turn|switch)\s+(?:the\s+|on\s+|off\s+)*(?:lights?|lamp)\s+(on|off)\b/);
  if (onOff) {
    action.state = onOff[1] === "on";
    return action;
  }
  if (/\bturn\s+on\b|\bswitch\s+on\b/.test(lower)) { action.state = true; return action; }
  if (/\bturn\s+off\b|\bswitch\s+off\b|\blights?\s+out\b/.test(lower)) { action.state = false; return action; }

  const dim = lower.match(/\b(?:dim|set|brightness)\s+(?:the\s+|my\s+)?(?:lights?|lamp)?\s*(?:to|at)?\s*(\d{1,3})\s*%?\b/);
  if (dim) {
    const value = Number(dim[1]);
    if (value >= 1 && value <= 100) {
      action.brightness = value;
      action.state = true;
      return action;
    }
  }

  if (/\bnight\s*(?:light|mode)\b/.test(lower)) {
    action.brightness = 6;
    action.temp = 2200;
    action.state = true;
    return action;
  }

  const white = lower.match(/\b(warm|cool)\s*(?:white)?\b/);
  if (white) {
    action.temp = white[1] === "warm" ? 2700 : 5700;
    action.state = true;
    return action;
  }

  for (const [name, rgb] of Object.entries(LIGHT_COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) {
      action.color = name;
      action.state = true;
      return action;
    }
  }

  return null;
}

function describeDeviceParams(action: DeviceAction): string {
  const parts: string[] = [];
  if (action.state === true) parts.push("on");
  if (action.state === false) parts.push("off");
  if (action.brightness !== undefined) parts.push(`${action.brightness}%`);
  if (action.temp !== undefined) parts.push(action.temp <= 3500 ? "warm white" : "cool white");
  if (action.color) parts.push(action.color);
  return parts.join(" ") || "update";
}

async function applyDeviceAction(admin: any, action: DeviceAction): Promise<string> {
  const params: Record<string, unknown> = {};
  if (action.state !== undefined) params.state = action.state;
  if (action.brightness !== undefined) params.brightness = action.brightness;
  if (action.temp !== undefined) params.temp = action.temp;
  if (action.color) {
    const rgb = LIGHT_COLORS[action.color];
    if (rgb) {
      params.r = rgb.r;
      params.g = rgb.g;
      params.b = rgb.b;
    }
  }
  if (Object.keys(params).length === 0) {
    return "What should the light do? e.g. \"lights off\", \"dim lights to 50\", \"lights warm\".";
  }
  const { error } = await admin.database.from("device_commands").insert([{
    id: crypto.randomUUID(),
    target: (action.target || "all").slice(0, 32),
    action: params,
    source: "telegram"
  }]);
  if (error) throw error;
  const targetLabel = action.target === "all" ? "lights" : `${action.target} light`;
  return `💡 ${targetLabel} → ${describeDeviceParams(action)}`;
}

function validateDeviceAction(input: unknown): DeviceAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<DeviceAction>;
  if (candidate.kind !== "device") return null;
  if (candidate.action !== "set") return null;
  const target = typeof candidate.target === "string" && candidate.target.trim()
    ? candidate.target.trim().toLowerCase().slice(0, 32)
    : "all";
  const action: DeviceAction = { kind: "device", action: "set", target };
  if (typeof candidate.state === "boolean") action.state = candidate.state;
  if (typeof candidate.brightness === "number" && Number.isFinite(candidate.brightness)) {
    const value = Math.round(candidate.brightness);
    if (value < 1 || value > 100) return null;
    action.brightness = value;
  }
  if (typeof candidate.temp === "number" && Number.isFinite(candidate.temp)) {
    const value = Math.round(candidate.temp);
    if (value < 2200 || value > 6500) return null;
    action.temp = value;
  }
  if (typeof candidate.color === "string" && LIGHT_COLORS[candidate.color.toLowerCase()]) {
    action.color = candidate.color.toLowerCase();
  }
  if (action.state === undefined && action.brightness === undefined && action.temp === undefined && !action.color) {
    return null;
  }
  return action;
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
  if (candidate.query === "pregnancy_tasks" || candidate.query === "pregnancy_todo" || candidate.query === "nutrition" || candidate.query === "chores_all" || candidate.query === "device_status") {
    return { kind: "query", query: candidate.query };
  }
  if (candidate.query === "chores") {
    // Optional day offset: 0 = today (default) .. 6.
    if (candidate.days === undefined || candidate.days === null) return { kind: "query", query: "chores" };
    const days = Number(candidate.days);
    if (!Number.isFinite(days) || !Number.isInteger(days) || days < 0 || days > 6) return null;
    return { kind: "query", query: "chores", days };
  }
  if (candidate.query !== "grocery" && candidate.query !== "todo" && candidate.query !== "workout" && candidate.query !== "events_today") return null;
  return { kind: "query", query: candidate.query };
}

export function validateTelegramAction(input: unknown): TelegramAction | null {
  return validateQueryAction(input) ?? validatePregnancyTodoAction(input) ?? validateChoreAction(input) ?? validateDeviceAction(input) ?? validatePregnancyTaskAction(input) ?? validateClarifyAction(input) ?? validateEventAction(input) ?? validatePlannerAction(input);
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
