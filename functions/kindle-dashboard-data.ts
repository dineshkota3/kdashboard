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

type HealthTarget = {
  metric: "steps" | "calories" | "exercise_minutes" | "sleep_hours" | "resting_hr";
  person: string;
  label: string;
  target_value: string | number;
  unit: string;
  updated_at: string;
};

type HealthSummary = {
  date: string;
  steps: number;
  dietary_energy_kcal: string | number;
  protein_g: string | number;
  carbs_g?: string | number;
  fat_g?: string | number;
  exercise_minutes?: number;
  resting_hr?: number;
  sleep_hours?: string | number;
  active_energy_kcal?: string | number;
  distance_km?: string | number;
  hrv_sdns_ms?: string | number;
  respiratory_rate?: string | number;
  vo2max?: string | number;
  hourly?: Record<string, unknown>;
  synced_at: string;
  updated_at: string;
};

type HealthPersonPayload = {
  person: string;
  label: string;
  date: string;
  steps: number;
  steps_target: number;
  steps_unit: string;
  sleep_h: number;
  sleep_target_h: number;
  exercise_minutes: number;
  exercise_target: number;
  resting_hr: number;
  hrv_sdns_ms: number;
  respiratory_rate: number;
  vo2max: number;
  score: number;
  verdict: string;
  steps_hit: boolean;
  exercise_hit: boolean;
  sleep_hit: boolean;
  rest_hint: boolean;
  hr_baseline: number;
  hr_flag: string;
  synced_at: string | null;
  hourly: Record<string, unknown>;
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
  health: {
    date: string | null;
    steps: number;
    calories: number;
    protein_g: number;
    steps_target: number;
    calories_target: number;
    steps_unit: string;
    calories_unit: string;
    synced_at: string | null;
    people: HealthPersonPayload[];
  };
  pregnancy: PregnancyPayload;
  challenge: {
    date: string;
    day: number;
    water_l: number;
    water_target_l: number;
    sleep_hours: number;
    sleep_target_hours: number;
    workouts: number;
    workout_target: number;
  };
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

// Phase 4: two-person health. One Apple Health source per phone; the slot
// vocabulary matches the calendar system (dinesh/keethu).
const HEALTH_SOURCE_DINESH = "apple_health_ios";
const HEALTH_SOURCE_KEETHU = "apple_health_ios_keethu";
const HEALTH_SOURCES = [HEALTH_SOURCE_DINESH, HEALTH_SOURCE_KEETHU];
const SLEEP_TARGET_HOURS = 8;
const EXERCISE_TARGET_MINUTES = 30;
const HR_BASELINE_WINDOW_DAYS = 7;
const HR_FLAG_BPM_ABOVE_BASELINE = 7;
const PERSON_SCORE_WEIGHTS = { steps: 0.4, exercise: 0.3, sleep: 0.3 };

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
  const [
    itemsResult,
    healthResult,
    healthBaselineResult,
    challengeResult,
    challengeStartResult,
    targetsResult
  ] = await Promise.all([
    admin.database
      .from("planner_items")
      .select("id,list_key,text,done,store,created_at,updated_at")
      .in("list_key", ["todo", "workout", "grocery"])
      .order("created_at", { ascending: false }),
    admin.database
      .from("health_daily_summaries")
      .select("date,source,steps,dietary_energy_kcal,protein_g,exercise_minutes,resting_hr,sleep_hours,active_energy_kcal,distance_km,hrv_sdns_ms,respiratory_rate,vo2max,hourly,synced_at,updated_at")
      .in("source", HEALTH_SOURCES)
      .eq("date", today),
    admin.database
      .from("health_daily_summaries")
      .select("date,source,resting_hr")
      .in("source", HEALTH_SOURCES)
      .gte("date", addLocalDays(today, -HR_BASELINE_WINDOW_DAYS))
      .lt("date", today)
      .order("date", { ascending: false }),
    admin.database
      .from("challenge_daily_logs")
      .select("date,water_l,sleep_hours,workouts,updated_at")
      .eq("date", today)
      .limit(1),
    admin.database
      .from("challenge_daily_logs")
      .select("date")
      .order("date", { ascending: true })
      .limit(1),
    admin.database
      .from("health_targets")
      .select("metric,person,label,target_value,unit,updated_at")
      .order("metric", { ascending: true })
  ]);
  const baseQueryMs = elapsedMs(baseStarted);

  const { data: items, error: itemsError } = itemsResult;
  if (itemsError) throw itemsError;

  const { data: healthRows, error: healthError } = healthResult;
  if (healthError) throw healthError;

  const { data: baselineRows, error: baselineError } = healthBaselineResult;
  if (baselineError) throw baselineError;

  const { data: challengeRows, error: challengeError } = challengeResult;
  if (challengeError) throw challengeError;

  const { data: challengeStartRows, error: challengeStartError } = challengeStartResult;
  if (challengeStartError) throw challengeStartError;

  const { data: targets, error: targetsError } = targetsResult;
  if (targetsError) throw targetsError;

  const buildStarted = timeMs();
  const staleCompletedCutoff = Date.now() - COMPLETED_ITEM_HIDE_AFTER_MS;
  const plannerItems = (items as PlannerItem[]).filter((item) => shouldShowPlannerItem(item, staleCompletedCutoff));
  const calendar = await loadCalendarPayload(admin, today);
  const healthBySource = new Map<string, HealthSummary>();
  for (const row of (healthRows as HealthSummary[]) ?? []) {
    if (row?.source) healthBySource.set(row.source, row);
  }
  const hrHistory = (baselineRows ?? []) as Array<{ source: string; resting_hr: number }>;
  const health = healthBySource.get(HEALTH_SOURCE_DINESH) ?? null;
  const challenge = firstRow<ChallengeLog>(challengeRows);
  const challengeStart = firstRow<Pick<ChallengeLog, "date">>(challengeStartRows);
  const challengeDay = challengeStart?.date ? challengeDayFor(today, challengeStart.date) : 1;
  const healthTargets = targets as HealthTarget[];
  const stepsTarget = metricTarget(healthTargets, "steps", "dinesh", 10000, "steps");
  const caloriesTarget = metricTarget(healthTargets, "calories", "dinesh", 2000, "kcal");
  const healthPeople = [
    personHealth(healthBySource.get(HEALTH_SOURCE_DINESH) ?? null, "dinesh", today, healthTargets, hrHistory),
    personHealth(healthBySource.get(HEALTH_SOURCE_KEETHU) ?? null, "keethu", today, healthTargets, hrHistory)
  ];

  const payloadWithoutVersion = {
    ok: true as const,
    generated_at: `${today}T00:00:00+05:30`,
    health: {
      date: health?.date ?? null,
      steps: Math.max(0, Number(health?.steps ?? 0)),
      calories: Math.max(0, Number(health?.dietary_energy_kcal ?? 0)),
      protein_g: Math.max(0, Number(health?.protein_g ?? 0)),
      steps_target: Math.max(0, Number(stepsTarget.target_value)),
      calories_target: Math.max(0, Number(caloriesTarget.target_value)),
      steps_unit: stepsTarget.unit,
      calories_unit: caloriesTarget.unit,
      synced_at: health?.synced_at ?? null,
      // Phase 4: per-person feeds. Compat fields above stay first (old binary +
      // challenge view read them); people follows.
      people: healthPeople
    },
    pregnancy: pregnancyBlock(today),
    challenge: {
      date: today,
      day: challengeDay,
      water_l: Math.max(0, Number(challenge?.water_l ?? 0)),
      water_target_l: 3,
      sleep_hours: Math.max(0, Number(challenge?.sleep_hours ?? 0)),
      sleep_target_hours: 8,
      workouts: Math.max(0, Number(challenge?.workouts ?? 0)),
      workout_target: 2
    },
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
      health: payloadWithoutVersion.health,
      challenge: payloadWithoutVersion.challenge,
      lists: payloadWithoutVersion.lists,
      calendar: payloadWithoutVersion.calendar,
      pregnancy: payloadWithoutVersion.pregnancy
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

function challengeDayFor(today: string, startDate: string): number {
  const diff = localDateIndex(today) - localDateIndex(startDate);
  if (!Number.isFinite(diff)) return 1;
  return Math.max(1, Math.min(75, diff + 1));
}

function localDateIndex(value: string): number {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return Number.NaN;
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function metricTarget(
  targets: HealthTarget[],
  metric: HealthTarget["metric"],
  person: string,
  fallbackValue: number,
  fallbackUnit: string
): HealthTarget {
  return targets.find((target) => target.metric === metric && target.person === person) ?? {
    metric,
    person,
    label: metric,
    target_value: fallbackValue,
    unit: fallbackUnit,
    updated_at: ""
  };
}

// ---- Phase 4: two-person health + pregnancy ----

function personHealth(
  row: HealthSummary | null,
  person: string,
  today: string,
  targets: HealthTarget[],
  hrHistory: Array<{ source: string; resting_hr: number }>
): HealthPersonPayload {
  const label = person.charAt(0).toUpperCase() + person.slice(1);
  const stepsTarget = metricTarget(targets, "steps", person, person === "keethu" ? 6000 : 10000, "steps");
  const steps = Math.max(0, Number(row?.steps ?? 0));
  const sleepHours = Math.max(0, Number(row?.sleep_hours ?? 0));
  const exerciseMinutes = Math.max(0, Number(row?.exercise_minutes ?? 0));
  const restingHr = Math.max(0, Number(row?.resting_hr ?? 0));

  const stepsRatio = Math.min(1, steps / Math.max(1, Number(stepsTarget.target_value)));
  const exerciseRatio = Math.min(1, exerciseMinutes / EXERCISE_TARGET_MINUTES);
  const sleepRatio = Math.min(1, sleepHours / SLEEP_TARGET_HOURS);
  const score = Math.round(100 * (
    PERSON_SCORE_WEIGHTS.steps * stepsRatio +
    PERSON_SCORE_WEIGHTS.exercise * exerciseRatio +
    PERSON_SCORE_WEIGHTS.sleep * sleepRatio
  ));
  const verdict = score >= 80 ? "GREAT" : score >= 60 ? "GOOD" : score >= 40 ? "OK" : "LOW";
  const stepsHit = stepsRatio >= 1;
  const exerciseHit = exerciseRatio >= 1;
  const sleepHit = sleepRatio >= 1;

  const baseline = hrBaseline(hrHistory, person === "keethu" ? HEALTH_SOURCE_KEETHU : HEALTH_SOURCE_DINESH);
  const hrFlag = baseline <= 0 || restingHr <= 0
    ? "none"
    : restingHr >= baseline + HR_FLAG_BPM_ABOVE_BASELINE
      ? "high"
      : restingHr <= baseline - HR_FLAG_BPM_ABOVE_BASELINE
        ? "low"
        : "ok";
  // Hint precedence: an elevated resting heart rate outranks the rest suggestion.
  const hint = hrFlag === "high"
    ? "HR ELEVATED"
    : person === "keethu" && exerciseMinutes < EXERCISE_TARGET_MINUTES && sleepHours >= SLEEP_TARGET_HOURS
      ? "REST"
      : "";

  return {
    person,
    label,
    date: row?.date ?? today,
    steps,
    steps_target: Math.max(0, Number(stepsTarget.target_value)),
    steps_unit: stepsTarget.unit,
    sleep_h: Math.round(sleepHours * 10) / 10,
    sleep_target_h: SLEEP_TARGET_HOURS,
    exercise_minutes: exerciseMinutes,
    exercise_target: EXERCISE_TARGET_MINUTES,
    resting_hr: restingHr,
    hrv_sdns_ms: Math.max(0, Number(row?.hrv_sdns_ms ?? 0)),
    respiratory_rate: Math.max(0, Number(row?.respiratory_rate ?? 0)),
    vo2max: Math.max(0, Number(row?.vo2max ?? 0)),
    score,
    verdict,
    steps_hit: stepsHit,
    exercise_hit: exerciseHit,
    sleep_hit: sleepHit,
    rest_hint: hint === "REST",
    hr_baseline: baseline,
    hr_flag: hrFlag,
    synced_at: row?.synced_at ?? null,
    hourly: row?.hourly && typeof row.hourly === "object" ? row.hourly : {}
  };
}

function hrBaseline(history: Array<{ source: string; resting_hr: number }>, source: string): number {
  const values = history
    .filter((row) => row.source === source && Number(row.resting_hr) > 0)
    .map((row) => Number(row.resting_hr));
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
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
