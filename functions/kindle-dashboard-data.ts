import { createAdminClient } from "npm:@insforge/sdk";

type ListKey = "grocery" | "workout" | "todo";

type PlannerItem = {
  id: string;
  list_key: ListKey;
  text: string;
  done: boolean;
  created_at: string;
  updated_at: string;
};

type HealthSummary = {
  date: string;
  steps: number;
  dietary_energy_kcal: string | number;
  protein_g: string | number;
  synced_at: string;
  updated_at: string;
};

type HealthTarget = {
  metric: "steps" | "calories";
  label: string;
  target_value: string | number;
  unit: string;
  updated_at: string;
};

type ChallengeLog = {
  date: string;
  water_l: string | number;
  sleep_hours: string | number;
  workouts: number;
  updated_at: string;
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
  };
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
};

const LIST_TITLES: Record<ListKey, string> = {
  todo: "Chores",
  workout: "Workout",
  grocery: "Grocery"
};
const COMPLETED_ITEM_HIDE_AFTER_MS = 24 * 60 * 60 * 1000;

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
    challengeResult,
    challengeStartResult,
    targetsResult
  ] = await Promise.all([
    admin.database
      .from("planner_items")
      .select("id,list_key,text,done,created_at,updated_at")
      .in("list_key", ["todo", "workout", "grocery"])
      .order("created_at", { ascending: false }),
    admin.database
      .from("health_daily_summaries")
      .select("date,steps,dietary_energy_kcal,protein_g,synced_at,updated_at")
      .eq("source", "apple_health_ios")
      .eq("date", today)
      .limit(1),
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
      .select("metric,label,target_value,unit,updated_at")
      .order("metric", { ascending: true })
  ]);
  const baseQueryMs = elapsedMs(baseStarted);

  const { data: items, error: itemsError } = itemsResult;
  if (itemsError) throw itemsError;

  const { data: healthRows, error: healthError } = healthResult;
  if (healthError) throw healthError;

  const { data: challengeRows, error: challengeError } = challengeResult;
  if (challengeError) throw challengeError;

  const { data: challengeStartRows, error: challengeStartError } = challengeStartResult;
  if (challengeStartError) throw challengeStartError;

  const { data: targets, error: targetsError } = targetsResult;
  if (targetsError) throw targetsError;

  const buildStarted = timeMs();
  const staleCompletedCutoff = Date.now() - COMPLETED_ITEM_HIDE_AFTER_MS;
  const plannerItems = (items as PlannerItem[]).filter((item) => shouldShowPlannerItem(item, staleCompletedCutoff));
  const health = firstRow<HealthSummary>(healthRows);
  const challenge = firstRow<ChallengeLog>(challengeRows);
  const challengeStart = firstRow<Pick<ChallengeLog, "date">>(challengeStartRows);
  const challengeDay = challengeStart?.date ? challengeDayFor(today, challengeStart.date) : 1;
  const healthTargets = targets as HealthTarget[];
  const stepsTarget = metricTarget(healthTargets, "steps", 10000, "steps");
  const caloriesTarget = metricTarget(healthTargets, "calories", 2000, "kcal");

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
      synced_at: health?.synced_at ?? null
    },
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
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((item) => ({
          id: item.id,
          text: item.text,
          done: item.done,
          updated_at: item.updated_at
        }))
    }))
  };

  const payload = {
    ...payloadWithoutVersion,
    version: hashText(JSON.stringify({
      health: payloadWithoutVersion.health,
      challenge: payloadWithoutVersion.challenge,
      lists: payloadWithoutVersion.lists
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
  fallbackValue: number,
  fallbackUnit: string
): HealthTarget {
  return targets.find((target) => target.metric === metric) ?? {
    metric,
    label: metric,
    target_value: fallbackValue,
    unit: fallbackUnit,
    updated_at: ""
  };
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
