import { createAdminClient } from "npm:@insforge/sdk";

type ListKey = "grocery" | "workout" | "todo";

type PlannerItem = {
  id: string;
  list_key: ListKey;
  text: string;
  done: boolean;
  store?: string | null;
  created_at: string;
  updated_at: string;
};

type PregnancyTaskPayload = {
  key: string;
  label: string;
  detail: string;
  category: string;
  due_week: number;
  due_date: string;
  due_display: string;
  done: boolean;
  overdue: boolean;
  days_until: number;
};

type PregnancyTodoPayload = {
  id: string;
  text: string;
  done: boolean;
};

type PregnancyNutritionPayload = {
  week: number;
  line1: string;
  line2: string;
  supplement1: string;
  supplement2: string;
  meal_b: string;
  meal_l: string;
  meal_d: string;
};

type PregnancyMilestone = {
  week: number;
  label: string;
  date: string;
  date_display: string;
  done: boolean;
  days_until: number;
};

type PregnancyPayload = {
  configured: boolean;
  due_date?: string;
  due_display?: string;
  weeks?: number;
  days?: number;
  trimester?: number;
  days_to_go?: number;
  progress_pct?: number;
  milestones?: PregnancyMilestone[];
};

type ChallengeLog = {
  date: string;
  water_l: string | number;
  sleep_hours: string | number;
  workouts: number;
  updated_at: string;
};

type CalendarEvent = {
  title: string;
  start_iso: string;
  end_iso: string;
  all_day: boolean;
  location: string | null;
  date_offset: number;
};

type CalendarFeedPayload = {
  slot: string;
  status: "ok" | "unavailable";
  events: CalendarEvent[];
};

type CalendarPayload = {
  status: "ok" | "not_connected" | "unavailable";
  events: CalendarEvent[];
  calendars: CalendarFeedPayload[];
};

type GoogleCalendarState = {
  slot: string | null;
  refresh_token: string | null;
  access_token: string | null;
  token_expiry: string | null;
  calendar_id: string | null;
  timezone: string | null;
};

type DashboardPayload = {
  ok: true;
  generated_at: string;
  version: string;
  pregnancy: PregnancyPayload;
  tasks: PregnancyTaskPayload[];
  pregnancy_todos: PregnancyTodoPayload[];
  chores: ChorePayload[];
  spotify: SpotifyPayload | null;
  nutrition: PregnancyNutritionPayload;
  lists: Array<{
    key: ListKey;
    title: string;
    items: Array<{
      id: string;
      text: string;
      done: boolean;
      updated_at: string;
    }>;
  }>;
  calendar: CalendarPayload;
};

const LIST_TITLES: Record<ListKey, string> = {
  todo: "Chores",
  workout: "Workout",
  grocery: "Grocery"
};
const COMPLETED_ITEM_HIDE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// Phase 4.1: scheduled chores for TODAY only (server resolves occurrence,
// done, skip, overdue — zero date logic in the C++ renderer).
type ChorePayload = {
  id: string;
  text: string;
  time_display: string;
  done: boolean;
  overdue: boolean;
};

// Phase 4.4: Spotify now-playing (read at fetch time; the soundbar streams
// directly from Spotify — nothing audio-related crosses this backend).
type SpotifyPayload = {
  track: string;
  artist: string;
  is_playing: boolean;
  progress_ms: number;
  duration_ms: number;
  device: string;
  playlists: Array<{ name: string; uri: string }>;
};

let spotifyTokenCache: { token: string; expires: number } | null = null;

async function spotifyAccessToken(): Promise<string | null> {
  const refresh = Deno.env.get("SPOTIFY_REFRESH_TOKEN");
  const clientId = Deno.env.get("SPOTIFY_CLIENT_ID");
  const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!refresh || !clientId || !clientSecret) return null;
  if (spotifyTokenCache && Date.now() < spotifyTokenCache.expires - 60_000) return spotifyTokenCache.token;
  try {
    // prefer the possibly-rotated refresh token persisted in the DB
    let effectiveRefresh = refresh;
    try {
      const { createAdminClient: adminFactory } = await import("npm:@insforge/sdk");
      const admin = adminFactory({ baseUrl: requiredEnv("INSFORGE_BASE_URL"), apiKey: requiredEnv("INSFORGE_API_KEY") });
      const { data: rows } = await admin.database.from("spotify_refresh").select("token").eq("id", "default").limit(1);
      const stored = rows?.[0]?.token;
      if (typeof stored === "string" && stored) effectiveRefresh = stored;
      var adminRef = admin;
    } catch {
      // DB read is best-effort; fall back to the bootstrap secret
    }
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: effectiveRefresh }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;
    if (data.refresh_token && typeof adminRef !== "undefined") {
      try {
        await adminRef.database.from("spotify_refresh").delete().eq("id", "default");
        await adminRef.database.from("spotify_refresh").insert([{ id: "default", token: data.refresh_token, updated_at: new Date().toISOString() }]);
      } catch {
        // best-effort persistence of the rotated token
      }
    }
    spotifyTokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return spotifyTokenCache.token;
  } catch {
    return null;
  }
}

// Hourly persistence so the SSE hash reflects Spotify changes even when the
// change came from the phone app (the bridges write it on commands too).
async function storeSpotifyState(np: SpotifyPayload | null): Promise<void> {
  try {
    const { createAdminClient } = await import("npm:@insforge/sdk");
    const admin = createAdminClient({ baseUrl: requiredEnv("INSFORGE_BASE_URL"), apiKey: requiredEnv("INSFORGE_API_KEY") });
    await admin.database.from("spotify_state").delete().eq("id", "hourly");
    await admin.database.from("spotify_state").insert([{
      id: "hourly",
      data: JSON.stringify(np ?? { is_playing: false, track: null }),
      updated_at: new Date().toISOString(),
    }]);
  } catch {
    // best-effort
  }
}

async function spotifyBlock(): Promise<SpotifyPayload | null> {
  try {
    const token = await spotifyAccessToken();
    if (!token) return null;
    const res = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 204 || res.status === 202) return null;
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.item ?? {};
    if (!item.name) return null;
    return {
      track: String(item.name).slice(0, 80),
      artist: String((item.artists ?? []).map((a: { name: string }) => a.name)[0] ?? "").slice(0, 60),
      is_playing: Boolean(data.is_playing),
      progress_ms: data.progress_ms ?? 0,
      duration_ms: item.duration_ms ?? 0,
      device: String(data.device?.name ?? "").slice(0, 40),
      playlists: await spotifyPlaylists(token),
    };
  } catch {
    return null;
  }
}

// Saved playlists for the Kindle MUSIC screen (tap = play on the soundbar).
async function spotifyPlaylists(token: string): Promise<Array<{ name: string; uri: string }>> {
  try {
    const res = await fetch("https://api.spotify.com/v1/me/playlists?limit=5", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items ?? []).map((pl: { name: string; uri: string }) => ({
      name: String(pl.name).slice(0, 40),
      uri: String(pl.uri),
    }));
  } catch {
    return [];
  }
}

type ChoreRow = {
  id: string;
  text: string;
  pattern: "daily" | "weekly" | "once";
  days: string;
  once_date: string;
  start_min: number;
  end_min: number;
  skip_date: string;
};

function choreWeekdayOf(day: string): string {
  const parsed = Date.parse(`${day}T12:00:00Z`);
  const wd = new Date(parsed).toUTCString().slice(0, 3).toLowerCase();
  return wd === "tue" ? "tu" : wd === "thu" ? "th" : wd === "sun" ? "su" : wd;
}

function choreOccursOn(chore: ChoreRow, day: string): boolean {
  if (chore.pattern === "once") return chore.once_date === day;
  if (chore.pattern === "daily") return true;
  return chore.days.split(",").filter(Boolean).includes(choreWeekdayOf(day));
}

function choreTimeDisplay(startMin: number, endMin: number): string {
  const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return endMin >= 1440 ? fmt(startMin) : `${fmt(startMin)}-${fmt(endMin)}`;
}

function buildChores(rows: ChoreRow[], doneIds: Set<string>, today: string, nowMin: number): ChorePayload[] {
  return rows
    .filter((chore) => choreOccursOn(chore, today) && chore.skip_date !== today)
    .sort((a, b) => a.start_min - b.start_min)
    .map((chore) => ({
      id: chore.id,
      text: chore.text,
      time_display: choreTimeDisplay(chore.start_min, chore.end_min),
      done: doneIds.has(chore.id),
      overdue: !doneIds.has(chore.id) && nowMin > chore.end_min
    }));
}

// Phase 4: pregnancy nutrition guidance (NL Voedingscentrum-aligned). The
// supplements list is week-dependent (foliumzuur only until week 10).
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

export default async function(req: Request): Promise<Response> {
  const requestStarted = timeMs();
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  if (!isAuthorizedDashboardRead(req)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const requestedDate = dashboardRequestedDate(req);
    const payload = await loadDashboardPayload(requestedDate);
    return jsonResponse(payload);
  } catch (error) {
    console.error("kindle-dashboard-data error", JSON.stringify(error)?.slice(0, 600), errorMessage(error));
    return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
  } finally {
    logTiming("kindle-dashboard-data", { total_ms: elapsedMs(requestStarted) });
  }
}

async function loadDashboardPayload(today = dashboardLocalDate()): Promise<DashboardPayload> {
  const admin = createAdminClient({
    baseUrl: requiredEnv("INSFORGE_BASE_URL"),
    apiKey: requiredEnv("INSFORGE_API_KEY")
  });

  const baseStarted = timeMs();
  const [itemsResult, tasksResult, todosResult, choresResult, choresDoneResult] = await Promise.all([
    admin.database
      .from("planner_items")
      .select("id,list_key,text,done,store,created_at,updated_at")
      .in("list_key", ["todo", "workout", "grocery"])
      .order("created_at", { ascending: false }),
    admin.database
      .from("pregnancy_tasks")
      .select("key,label,detail,due_week,category,done")
      .order("due_week", { ascending: true }),
    admin.database
      .from("pregnancy_todos")
      .select("id,text,done,created_at")
      .order("created_at", { ascending: false }),
    admin.database
      .from("chores")
      .select("id,text,pattern,days,once_date,start_min,end_min,skip_date"),
    admin.database
      .from("chore_dones")
      .select("chore_id")
      .eq("day", today)
  ]);
  const baseQueryMs = elapsedMs(baseStarted);

  const { data: items, error: itemsError } = itemsResult;
  if (itemsError) throw itemsError;

  const { data: taskRows, error: tasksError } = tasksResult;
  if (tasksError) throw tasksError;

  const { data: todoRows, error: todosError } = todosResult;
  if (todosError) throw todosError;

  const { data: choreRows, error: choresError } = choresResult;
  if (choresError) throw choresError;

  const { data: choresDoneRows, error: choresDoneError } = choresDoneResult;
  if (choresDoneError) throw choresDoneError;

  const buildStarted = timeMs();
  const staleCompletedCutoff = Date.now() - COMPLETED_ITEM_HIDE_AFTER_MS;
  const plannerItems = (items as PlannerItem[]).filter((item) => shouldShowPlannerItem(item, staleCompletedCutoff));
  const calendar = await loadCalendarPayload(admin, today);

  const payloadWithoutVersion = {
    ok: true as const,
    generated_at: `${today}T00:00:00+05:30`,
    pregnancy: pregnancyBlock(today),
    tasks: buildPregnancyTasks((taskRows ?? []) as PregnancyTaskRow[], today),
    pregnancy_todos: ((todoRows ?? []) as PregnancyTodoPayload[])
      .slice(0, 8)
      .map((row) => ({ id: row.id, text: row.text, done: row.done })),
    chores: buildChores(
      (choreRows ?? []) as ChoreRow[],
      new Set<string>((choresDoneRows ?? []).map((r: { chore_id: string }) => r.chore_id)),
      today,
      dashboardNowMin()
    ),
    spotify: await (async () => {
      const block = await spotifyBlock();
      try {
        await storeSpotifyState(block);
      } catch {
        // best-effort
      }
      return block;
    })(),
    nutrition: nutritionBlock(today),
    lists: (["todo", "workout", "grocery"] as const).map((key) => ({
      key,
      title: LIST_TITLES[key],
      items: plannerItems
        .filter((item) => item.list_key === key)
        .sort((a, b) => {
          if (a.done !== b.done) return a.done ? 1 : -1;
          return b.created_at.localeCompare(a.created_at);
        })
        .map((item) => ({
          id: item.id,
          text: item.text,
          done: item.done,
          updated_at: item.updated_at,
          ...(key === "grocery" && item.store ? { store: item.store } : {})
        }))
    })),
    calendar
  };

  const payload = {
    ...payloadWithoutVersion,
    version: hashText(JSON.stringify({
      pregnancy: payloadWithoutVersion.pregnancy,
      tasks: payloadWithoutVersion.tasks,
      pregnancy_todos: payloadWithoutVersion.pregnancy_todos,
      chores: payloadWithoutVersion.chores,
      spotify: payloadWithoutVersion.spotify,
      nutrition: payloadWithoutVersion.nutrition,
      lists: payloadWithoutVersion.lists,
      calendar: payloadWithoutVersion.calendar
    }))
  };
  logTiming("kindle-dashboard-data", {
    base_query_ms: baseQueryMs,
    payload_build_ms: elapsedMs(buildStarted)
  });
  return payload;
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

// Minutes since dashboard-local midnight — used for the chores overdue flag.
function dashboardNowMin(): number {
  const timezone = Deno.env.get("DASHBOARD_TIMEZONE") || "Asia/Kolkata";
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date());
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function dashboardRequestedDate(req: Request): string {
  const url = new URL(req.url);
  const explicitDate = url.searchParams.get("date");
  if (explicitDate && /^\d{4}-\d{2}-\d{2}$/.test(explicitDate)) {
    return explicitDate;
  }

  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset === 0) {
    return dashboardLocalDate();
  }

  return addLocalDays(dashboardLocalDate(), Math.max(-365, Math.min(365, offset)));
}

function addLocalDays(date: string, offset: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + offset));
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, "0");
  const d = String(value.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localDateIndex(value: string): number {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return Number.NaN;
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

const GESTATION_DAYS = 280;
const PREGNANCY_MILESTONE_WEEKS = [
  { week: 12, label: "NT SCAN / T1 END" },
  { week: 20, label: "ANATOMY SCAN" },
  { week: 24, label: "VIABILITY" },
  { week: 28, label: "TRIMESTER 3" },
  { week: 32, label: "32 WEEKS" },
  { week: 36, label: "36 WEEKS" },
  { week: 37, label: "FULL TERM" },
  { week: 40, label: "DUE DATE" }
];

function pregnancyBlock(today: string): PregnancyPayload {
  const dueDate = (Deno.env.get("PREGNANCY_DUE_DATE") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return { configured: false };
  }
  const dueIndex = localDateIndex(dueDate);
  const todayIndex = localDateIndex(today);
  const gestationalDays = todayIndex - (dueIndex - GESTATION_DAYS);
  const weeks = Math.max(0, Math.floor(gestationalDays / 7));
  const trimester = gestationalDays < 98 ? 1 : gestationalDays < 196 ? 2 : 3;
  const daysToGo = dueIndex - todayIndex;
  return {
    configured: true,
    due_date: dueDate,
    due_display: formatShortDate(dueDate),
    weeks,
    days: gestationalDays >= 0 ? ((gestationalDays % 7) + 7) % 7 : 0,
    trimester,
    days_to_go: daysToGo,
    progress_pct: Math.max(0, Math.min(100, Math.round((gestationalDays / GESTATION_DAYS) * 100))),
    milestones: PREGNANCY_MILESTONE_WEEKS.map(({ week, label }) => {
      const milestoneDate = addLocalDays(dueDate, (week - 40) * 7);
      const milestoneIndex = dueIndex + (week - 40) * 7;
      return {
        week,
        label,
        date: milestoneDate,
        date_display: formatShortDate(milestoneDate),
        done: todayIndex >= milestoneIndex,
        days_until: milestoneIndex - todayIndex
      };
    })
  };
}

function formatShortDate(date: string): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return `${months[month - 1]} ${String(day).padStart(2, "0")} ${year}`;
}

type PregnancyTaskRow = {
  key: string;
  label: string;
  detail: string;
  due_week: number;
  category: string;
  done: boolean;
};

// Due date for a task week: due + (week - 40) weeks (week 40 = due date).
function taskDueDate(dueDate: string, dueWeek: number): string {
  return addLocalDays(dueDate, (dueWeek - 40) * 7);
}

function pregnancyDueDate(): string {
  const dueDate = (Deno.env.get("PREGNANCY_DUE_DATE") || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : "";
}

function buildPregnancyTasks(rows: PregnancyTaskRow[], today: string): PregnancyTaskPayload[] {
  const dueDate = pregnancyDueDate();
  const dueIndexBase = dueDate ? localDateIndex(dueDate) : Number.NaN;
  const todayIndex = localDateIndex(today);
  return rows
    .map((row) => {
      const rowDue = dueDate ? taskDueDate(dueDate, row.due_week) : "";
      const rowDueIndex = dueDate ? localDateIndex(rowDue) : Number.NaN;
      return {
        key: row.key,
        label: row.label,
        detail: row.detail ?? "",
        category: row.category ?? "CARE",
        due_week: row.due_week,
        due_date: rowDue,
        due_display: rowDue ? formatShortDate(rowDue) : "",
        done: Boolean(row.done),
        overdue: !row.done && Number.isFinite(rowDueIndex) ? todayIndex > rowDueIndex : false,
        days_until: Number.isFinite(rowDueIndex) ? rowDueIndex - todayIndex : 0
      };
    })
    .sort((a, b) => a.due_week - b.due_week || Number(a.done) - Number(b.done));
}

function nutritionBlock(today: string): PregnancyNutritionPayload {
  const dueDate = pregnancyDueDate();
  const configured = Boolean(dueDate);
  const week = configured
    ? Math.max(0, Math.floor((localDateIndex(today) - (localDateIndex(dueDate) - GESTATION_DAYS)) / 7))
    : 0;

  const lines = (PREGNANCY_NUTRITION_TRIMESTERS.find((t) => week < t.untilWeek) ?? PREGNANCY_NUTRITION_TRIMESTERS[PREGNANCY_NUTRITION_TRIMESTERS.length - 1]).lines;
  const supplements = ["VITAMINE D 10 UG DAILY"];
  if (configured && week <= 10) supplements.push("FOLIUMZUUR 0.5 MG DAILY (TILL WEEK 10)");
  supplements.push("NO ALCOHOL - CAFFEINE < 200 MG/DAY");

  // Meals today: rotates by weekday, all pregnancy-safe (cooked, pasteurized)
  const weekday = (localDateIndex(today) + 4) % 7; // 0 = Sunday
  const meal = PREGNANCY_MEALS[weekday] ?? PREGNANCY_MEALS[0];
  return {
    week,
    line1: lines[0] ?? "",
    line2: lines[1] ?? "",
    supplement1: supplements[0] ?? "",
    supplement2: supplements[1] ?? "",
    meal_b: meal.b,
    meal_l: meal.l,
    meal_d: meal.d
  };
}

// Pregnancy-safe daily meal rotation (no raw fish/meat, pasteurized dairy only)
const PREGNANCY_MEALS: Array<{ b: string; l: string; d: string }> = [
  { b: "YOGHURT + GRANOLA + FRUIT", l: "VOLKOREN BROOD + EI", d: "ROAST CHICKEN + VEG" },
  { b: "HAVERMOUT + BANANA", l: "BROOD + KAAS + KOMKOMMER", d: "PASTA + TOMATO SAUCE + VEG" },
  { b: "YOGHURT + BERRIES", l: "SOUP + VOLKOREN BROOD", d: "SALMON + POTATO + VEG" },
  { b: "HAVERMOUT + APPLE", l: "WRAP + CHICKEN + SALAD", d: "RIJS + BEAN CURRY" },
  { b: "YOGHURT + GRANOLA", l: "BROOD + PINDAKAAS + EI", d: "STIR-FRY + RIJS" },
  { b: "HAVERMOUT + PEAR", l: "BROOD + EI + TOMATO", d: "FISH + POTATO + VEG" },
  { b: "YOGHURT + MUESLI", l: "SALAD + CHICKEN", d: "PASTA + PESTO + VEG" }
];

function firstRow<T>(rows: unknown): T | null {
  return Array.isArray(rows) && rows.length > 0 ? rows[0] as T : null;
}

function shouldShowPlannerItem(item: PlannerItem, staleCompletedCutoff: number): boolean {
  if (!item.done) return true;
  const updatedAt = Date.parse(item.updated_at);
  if (!Number.isFinite(updatedAt)) return true;
  return updatedAt > staleCompletedCutoff;
}

async function loadCalendarPayload(admin: any, today: string): Promise<CalendarPayload> {
  try {
    // One row per connected Google account (Phase 3.1). created_at ordering
    // keeps the original owner first. Capped at 4 feeds — that is the device
    // layout budget and keeps the hourly fetch bounded.
    const { data: stateRows, error: stateError } = await admin.database
      .from("google_calendar_state")
      .select("slot,refresh_token,access_token,token_expiry,calendar_id,timezone")
      .order("created_at", { ascending: true })
      .limit(4);
    if (stateError) throw stateError;

    const states = (Array.isArray(stateRows) ? stateRows as GoogleCalendarState[] : [])
      .filter((state) => state?.refresh_token);
    if (states.length === 0) {
      return { status: "not_connected", events: [], calendars: [] };
    }

    // Each feed fails independently — one revoked calendar never degrades the others.
    const timezone = Deno.env.get("DASHBOARD_TIMEZONE") || "Asia/Kolkata";
    const feeds = await Promise.all(states.map((state) => loadFeedEvents(admin, state, today, timezone)));

    const anyOk = feeds.some((feed) => feed.status === "ok");
    const status: CalendarPayload["status"] = anyOk ? "ok" : "unavailable";
    // Feeds carry different ISO shapes (offset vs Z vs date-only) — sort on the
    // parsed instant, not the string.
    const mergedEvents = feeds
      .flatMap((feed) => feed.events)
      .sort((a, b) => {
        const timeA = Date.parse(a.start_iso);
        const timeB = Date.parse(b.start_iso);
        if (Number.isFinite(timeA) && Number.isFinite(timeB)) return timeA - timeB;
        return a.start_iso.localeCompare(b.start_iso);
      })
      .slice(0, 10);
    return { status, events: mergedEvents, calendars: feeds };
  } catch (error) {
    console.warn("calendar_payload_unavailable", error instanceof Error ? error.message : String(error));
    return { status: "unavailable", events: [], calendars: [] };
  }
}

// Only ~4 months of upcoming events are fetched: without an upper bound Google
// expands yearly recurring events (birthdays) years ahead, which floods the
// 10-event budget and pushes useful near-term events off the list.
const CALENDAR_LOOKAHEAD_MS = 122 * 24 * 60 * 60 * 1000;

async function loadFeedEvents(admin: any, state: GoogleCalendarState, today: string, timezone: string): Promise<CalendarFeedPayload> {
  const slot = state.slot || "owner";
  try {
    const accessToken = await ensureCalendarAccessToken(admin, state);
    if (!accessToken) {
      return { slot, status: "unavailable", events: [] };
    }

    const calendarId = encodeURIComponent(state.calendar_id || "primary");
    const params = new URLSearchParams({
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + CALENDAR_LOOKAHEAD_MS).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "10",
      timeZone: state.timezone || "Asia/Kolkata"
    });
    const eventsResponse = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!eventsResponse.ok) {
      console.warn(`calendar_events_failed status=${eventsResponse.status} slot=${slot}`);
      return { slot, status: "unavailable", events: [] };
    }

    const eventsJson = await eventsResponse.json();
    const rawItems = Array.isArray(eventsJson?.items) ? eventsJson.items : [];
    const events = rawItems
      .map((item: unknown) => mapCalendarEvent(item, today, timezone))
      .filter((item: CalendarEvent | null): item is CalendarEvent => item !== null)
      // Google sorts by startTime, so double-entered events (same flight added
      // twice) sit adjacent — collapse exact copies instead of wasting strip rows.
      .filter((item, index, all) => index === 0 ||
        !(item.title === all[index - 1].title &&
          item.start_iso === all[index - 1].start_iso &&
          item.end_iso === all[index - 1].end_iso));
    return { slot, status: "ok", events };
  } catch (error) {
    console.warn(`calendar_feed_unavailable slot=${slot}`, error instanceof Error ? error.message : String(error));
    return { slot, status: "unavailable", events: [] };
  }
}

async function ensureCalendarAccessToken(admin: any, state: GoogleCalendarState): Promise<string | null> {
  const expiryMs = state.token_expiry ? Date.parse(state.token_expiry) : 0;
  const hasFreshToken = state.access_token && Number.isFinite(expiryMs) && expiryMs > Date.now() + 60_000;
  if (hasFreshToken) {
    return state.access_token as string;
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    console.warn("calendar_token_refresh_skipped missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET");
    return null;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: state.refresh_token as string,
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

// Phase 4: each event carries its day offset from the payload date so the
// Kindle can jump from an event row to that date's health screen. All-day
// events have a date-only start (UTC midnight) — use the literal string,
// never format the instant (it lands on the previous local day).
function mapCalendarEvent(item: unknown, today: string, timezone: string): CalendarEvent | null {
  if (!item || typeof item !== "object") return null;
  const event = item as Record<string, any>;
  const start = event.start ?? {};
  const end = event.end ?? {};
  const startIso = String(start.dateTime || start.date || "");
  if (!startIso) return null;
  const title = typeof event.summary === "string" && event.summary.trim()
    ? event.summary.trim().slice(0, 120)
    : "(untitled)";
  const allDay = Boolean(start.date) && !start.dateTime;
  const eventDay = allDay ? startIso.slice(0, 10) : new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(startIso));
  const eventDayIndex = localDateIndex(eventDay);
  const dateOffset = Number.isFinite(eventDayIndex) ? eventDayIndex - localDateIndex(today) : 0;
  return {
    title,
    start_iso: startIso,
    end_iso: String(end.dateTime || end.date || ""),
    all_day: allDay,
    location: typeof event.location === "string" ? event.location.slice(0, 200) : null,
    date_offset: dateOffset
  };
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Dashboard-Read-Token, Authorization"
  };
}

function isAuthorizedDashboardRead(req: Request): boolean {
  const configuredToken = requiredEnv("DASHBOARD_READ_TOKEN");
  const receivedToken =
    req.headers.get("x-dashboard-read-token") ||
    bearerToken(req.headers.get("authorization")) ||
    new URL(req.url).searchParams.get("read_token");
  return Boolean(receivedToken) && receivedToken === configuredToken;
}

function bearerToken(header: string | null): string {
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  return match?.[1]?.trim() || "";
}

function requiredEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function timeMs(): number {
  return performance.now();
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}

function logTiming(label: string, timing: Record<string, number>): void {
  console.log(`${label} timing ${JSON.stringify(timing)}`);
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
