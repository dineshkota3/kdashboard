type ListKey = "grocery" | "workout" | "todo";

type PlannerAction = {
  kind?: "planner";
  action: "add" | "complete" | "uncomplete" | "delete" | "clear";
  list_key: ListKey;
  items: string[];
  all_lists?: boolean;
};

type HealthTargetAction = {
  kind: "target";
  action: "set_target";
  metric: "steps" | "calories";
  value: number;
  unit?: string;
};

type ChallengeAction = {
  kind: "challenge";
  action: "add_water" | "set_sleep" | "add_workout";
  value: number;
};

export type CalendarEventAction = {
  kind: "calendar";
  action: "create_event";
  title: string;
  start_iso: string;
  duration_min: number;
  all_day: boolean;
  location?: string;
};

type TelegramAction = PlannerAction | HealthTargetAction | ChallengeAction | CalendarEventAction;

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
  "For health targets return: {\"kind\":\"target\",\"action\":\"set_target\",\"metric\":\"steps|calories\",\"value\":12000,\"unit\":\"steps|kcal\"}.",
  "For 75 day challenge check-ins return: {\"kind\":\"challenge\",\"action\":\"add_water|set_sleep|add_workout\",\"value\":1}. Treat XL water as 1 liter, sleep value as hours, and workout value as one completed workout.",
  "For calendar bookings return: {\"kind\":\"calendar\",\"action\":\"create_event\",\"title\":\"Dentist\",\"date\":\"YYYY-MM-DD\",\"time\":\"HH:MM\",\"duration_min\":60,\"all_day\":false,\"location\":\"optional\"} where time is 24-hour in the owner's timezone given below. For all-day events omit time and set all_day true. Resolve relative dates like 'Friday', 'tomorrow', 'tonight' against the current date/time provided below.",
  "Undo/redo/revert requests are NOT supported: for any message asking to undo, revert, or take back the last change, return {\"kind\":\"none\"}. Also return {\"kind\":\"none\"} for questions or small talk instead of inventing items.",
].join(" ");

async function parseTelegramMessage(message: string): Promise<TelegramAction | null> {
  const fastAction = parseFastHeuristicMessage(message);
  if (fastAction) return fastAction;

  const zaiKey = Deno.env.get("ZAI_API_KEY");
  if (!zaiKey) {
    return parseMessageHeuristically(message);
  }

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
        { role: "system", content: `${PLANNER_SYSTEM_PROMPT} Owner timezone: ${dashboardTimezone()}. Current date/time there: ${nowString(dashboardTimezone())}` },
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

async function applyTelegramAction(admin: any, action: TelegramAction): Promise<string> {
  if (isChallengeAction(action)) return applyChallengeAction(admin, action);
  if (isTargetAction(action)) return applyHealthTargetAction(admin, action);
  if (isEventAction(action)) return applyCalendarCreateAction(admin, action);
  return applyPlannerAction(admin, action);
}

function isEventAction(action: TelegramAction): action is CalendarEventAction {
  return (action as CalendarEventAction).kind === "calendar";
}

async function applyCalendarCreateAction(admin: any, action: CalendarEventAction): Promise<string> {
  const state = await loadCalendarState(admin);
  if (!state?.refresh_token) {
    return "Calendar not connected — open the OAuth link first (curl the google-calendar-oauth function).";
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

  return `Scheduled: ${action.title} — ${formatEventStart(startIso, allDay, dashboardTimezone())}`;
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

async function loadCalendarState(admin: any): Promise<GoogleCalendarStateRow | null> {
  const { data: rows, error } = await admin.database
    .from("google_calendar_state")
    .select("refresh_token,access_token,token_expiry,calendar_id")
    .eq("id", 1)
    .limit(1);
  if (error) throw error;
  return Array.isArray(rows) && rows.length > 0 ? rows[0] as GoogleCalendarStateRow : null;
}

type GoogleCalendarStateRow = {
  refresh_token: string | null;
  access_token: string | null;
  token_expiry: string | null;
  calendar_id: string | null;
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
    .eq("id", 1);
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

async function applyChallengeAction(admin: any, action: ChallengeAction): Promise<string> {
  const date = dashboardLocalDate();
  const { data: existingRows, error: selectError } = await admin.database
    .from("challenge_daily_logs")
    .select("date,water_l,sleep_hours,workouts")
    .eq("date", date)
    .limit(1);
  if (selectError) throw selectError;

  const existing = Array.isArray(existingRows) && existingRows.length > 0 ? existingRows[0] : null;
  const currentWater = Math.max(0, Number(existing?.water_l ?? 0));
  const currentSleep = Math.max(0, Number(existing?.sleep_hours ?? 0));
  const currentWorkouts = Math.max(0, Number(existing?.workouts ?? 0));
  const next = {
    water_l: currentWater,
    sleep_hours: currentSleep,
    workouts: currentWorkouts
  };

  if (action.action === "add_water") {
    next.water_l = roundOneDecimal(currentWater + action.value);
  } else if (action.action === "set_sleep") {
    next.sleep_hours = roundOneDecimal(action.value);
  } else if (action.action === "add_workout") {
    next.workouts = currentWorkouts + Math.max(1, Math.round(action.value));
  }

  if (existing) {
    const { error } = await admin.database
      .from("challenge_daily_logs")
      .update(next)
      .eq("date", date);
    if (error) throw error;
  } else {
    const { error } = await admin.database
      .from("challenge_daily_logs")
      .insert([{ date, ...next }]);
    if (error) throw error;
  }

  if (action.action === "add_water") return `Logged ${formatNumber(action.value)}L water today (${formatNumber(next.water_l)}/3L).`;
  if (action.action === "set_sleep") return `Logged sleep: ${formatNumber(next.sleep_hours)}/8h.`;
  return `Logged workout ${next.workouts}/2 today.`;
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
    const rows = action.items.map((text) => ({ list_key: action.list_key, text, done: false }));
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

async function applyHealthTargetAction(admin: any, action: HealthTargetAction): Promise<string> {
  const unit = action.unit || (action.metric === "steps" ? "steps" : "kcal");
  const label = action.metric === "steps" ? "STEPS" : "CALORIES";

  const { data: existing, error: selectError } = await admin.database
    .from("health_targets")
    .select("metric")
    .eq("metric", action.metric)
    .limit(1);
  if (selectError) throw selectError;

  if (Array.isArray(existing) && existing.length > 0) {
    const { error } = await admin.database
      .from("health_targets")
      .update({ label, target_value: action.value, unit })
      .eq("metric", action.metric);
    if (error) throw error;
  } else {
    const { error } = await admin.database
      .from("health_targets")
      .insert([{ metric: action.metric, label, target_value: action.value, unit }]);
    if (error) throw error;
  }

  return `Set ${action.metric} target to ${formatNumber(action.value)} ${unit}.`;
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

export function parseFastHeuristicMessage(message: string): TelegramAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  if (/^\/event\b/i.test(normalized)) {
    const eventAction = parseEventHeuristically(normalized);
    if (eventAction) return eventAction;
  }

  const challengeAction = parseChallengeHeuristically(normalized);
  if (challengeAction) return challengeAction;

  const targetAction = parseTargetHeuristically(normalized);
  if (targetAction) return targetAction;

  const hasPlannerVerb = /\b(add|put|include|buy|get|need|mark|check off|complete|completed|done|undo|uncheck|delete|remove|drop|clear|empty|reset)\b/.test(lower);
  if (hasPlannerVerb && hasExplicitList(normalized)) {
    return parseMessageHeuristically(normalized);
  }

  return null;
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

export function parseMessageHeuristically(message: string): TelegramAction {
  const challengeAction = parseChallengeHeuristically(message);
  if (challengeAction) return challengeAction;

  const targetAction = parseTargetHeuristically(message);
  if (targetAction) return targetAction;

  const normalized = message.trim().replace(/\s+/g, " ");
  const explicitList = hasExplicitList(normalized);
  if (!explicitList) {
    const eventAction = parseEventHeuristically(normalized);
    if (eventAction) return eventAction;
  }

  const lower = normalized.toLowerCase();
  const listKey = detectListKey(normalized);

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
    all_lists: !explicitList && (action === "complete" || action === "uncomplete" || action === "delete")
  };
}

export function validateTelegramAction(input: unknown): TelegramAction | null {
  return validateChallengeAction(input) ?? validateTargetAction(input) ?? validateEventAction(input) ?? validatePlannerAction(input);
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

  return {
    kind: "calendar",
    action: "create_event",
    title,
    start_iso: startIso,
    duration_min: durationMin,
    all_day: allDay,
    ...(location ? { location } : {})
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

  return {
    kind: "planner",
    action: candidate.action as PlannerAction["action"],
    list_key: candidate.list_key as ListKey,
    items,
    all_lists: Boolean(candidate.all_lists)
  };
}

function validateTargetAction(input: unknown): HealthTargetAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<HealthTargetAction>;
  if (candidate.kind !== "target" && candidate.action !== "set_target") return null;
  if (candidate.action !== "set_target") return null;
  if (candidate.metric !== "steps" && candidate.metric !== "calories") return null;
  const value = Number(candidate.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = typeof candidate.unit === "string" && candidate.unit.trim()
    ? candidate.unit.trim()
    : candidate.metric === "steps" ? "steps" : "kcal";
  return {
    kind: "target",
    action: "set_target",
    metric: candidate.metric,
    value,
    unit
  };
}

function validateChallengeAction(input: unknown): ChallengeAction | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<ChallengeAction>;
  if (candidate.kind !== "challenge") return null;
  if (candidate.action !== "add_water" && candidate.action !== "set_sleep" && candidate.action !== "add_workout") return null;
  const value = Number(candidate.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return {
    kind: "challenge",
    action: candidate.action,
    value
  };
}

function parseTargetHeuristically(message: string): HealthTargetAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (!/\b(target|goal|set|change|update)\b/.test(lower)) return null;
  const metric = /\b(step|steps)\b/.test(lower) ? "steps" : /\b(calorie|calories|kcal)\b/.test(lower) ? "calories" : null;
  if (!metric) return null;
  const valueMatch = normalized.match(/(?:to|at|=|goal|target)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i) ?? normalized.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (!valueMatch) return null;
  const value = Number(valueMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return {
    kind: "target",
    action: "set_target",
    metric,
    value,
    unit: metric === "steps" ? "steps" : "kcal"
  };
}

function parseChallengeHeuristically(message: string): ChallengeAction | null {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  if (/\b(slept|sleep)\b/.test(lower)) {
    const hours = extractMacroNumber(normalized, /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:h|hr|hrs|hour|hours)\b/i)
      ?? extractMacroNumber(normalized, /\b(?:slept|sleep)\s+([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    if (hours && hours > 0) return { kind: "challenge", action: "set_sleep", value: hours };
  }

  if (/\b(water|hydrated|drank|drink)\b/.test(lower)) {
    const liters = extractMacroNumber(normalized, /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:l|liter|liters|litre|litres)\b/i);
    const milliliters = extractMacroNumber(normalized, /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:ml|milliliter|milliliters|millilitre|millilitres)\b/i);
    const amount = liters ?? (milliliters ? milliliters / 1000 : /\bxl\s+water\b|\bwater\s+xl\b/.test(lower) ? 1 : 1);
    return { kind: "challenge", action: "add_water", value: roundOneDecimal(amount) };
  }

  if (/\b(workout|exercise|training|gym)\b/.test(lower) && /\b(did|done|complete|completed|finished|marked|mark)\b/.test(lower)) {
    return { kind: "challenge", action: "add_workout", value: 1 };
  }

  return null;
}

function extractMacroNumber(value: string, pattern: RegExp): number | null {
  const match = value.match(pattern);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isTargetAction(action: TelegramAction): action is HealthTargetAction {
  return (action as HealthTargetAction).kind === "target";
}

function isChallengeAction(action: TelegramAction): action is ChallengeAction {
  return (action as ChallengeAction).kind === "challenge";
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
