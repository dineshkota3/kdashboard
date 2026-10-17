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

type PregnancyTask = {
  key: string;
  label: string;
  due_week: number;
  done: boolean;
};

type DashboardData = {
  items: PlannerItem[];
  tasks: PregnancyTask[];
  pregnancyWeek: number;
  pregnancyDay: number;
};

export default function(req: Request): Response {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  if (!isAuthorizedDashboardRead(req)) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" }
    });
  }

  const encoder = new TextEncoder();
  let lastVersion = "";
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      async function pushIfChanged(force = false) {
        if (closed) return;
        try {
          const data = await loadDashboardData();
          if (closed) return;
          const version = getDashboardVersion(data);
          if (!force && version === lastVersion) {
            controller.enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`));
            return;
          }

          lastVersion = version;
          controller.enqueue(encoder.encode(`event: planner\n`));
          controller.enqueue(encoder.encode(`data: ${version}\n\n`));
        } catch (error) {
          controller.enqueue(encoder.encode(`event: planner-error\n`));
          controller.enqueue(encoder.encode(`data: ${errorMessage(error)}\n\n`));
        }
      }

      controller.enqueue(encoder.encode(`: connected ${new Date().toISOString()}\n\n`));
      void pushIfChanged(true);
      intervalId = setInterval(() => void pushIfChanged(), 2000);
      timeoutId = setTimeout(() => {
        closed = true;
        if (intervalId) clearInterval(intervalId);
        controller.close();
      }, 55000);
    },
    cancel() {
      closed = true;
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}

async function loadDashboardData(): Promise<DashboardData> {
  const started = timeMs();
  const admin = createAdminClient({
    baseUrl: requiredEnv("INSFORGE_BASE_URL"),
    apiKey: requiredEnv("INSFORGE_API_KEY")
  });
  const today = dashboardLocalDate();

  const baseStarted = timeMs();
  const [itemsResult, tasksResult] = await Promise.all([
    admin.database
      .from("planner_items")
      .select("id,list_key,text,done,created_at,updated_at")
      .in("list_key", ["todo", "workout", "grocery"])
      .order("created_at", { ascending: false }),
    admin.database
      .from("pregnancy_tasks")
      .select("key,label,due_week,done")
      .order("due_week", { ascending: true })
  ]);
  const baseQueryMs = elapsedMs(baseStarted);

  const { data: items, error: itemsError } = itemsResult;
  if (itemsError) throw itemsError;

  const { data: tasks, error: tasksError } = tasksResult;
  if (tasksError) throw tasksError;

  const payload = {
    items: items as PlannerItem[],
    tasks: tasks as PregnancyTask[],
    ...pregnancyProgress(today)
  };
  logTiming("kindle-dashboard-events", {
    base_query_ms: baseQueryMs,
    payload_build_ms: elapsedMs(started) - baseQueryMs,
    total_ms: elapsedMs(started)
  });
  return payload;
}

// Pregnancy week/day derived from PREGNANCY_DUE_DATE so the SSE hash rolls at
// midnight (same math as kindle-dashboard-data.ts).
function pregnancyProgress(today: string): { pregnancyWeek: number; pregnancyDay: number } {
  const dueDate = (Deno.env.get("PREGNANCY_DUE_DATE") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { pregnancyWeek: 0, pregnancyDay: 0 };
  const dueIndex = Date.UTC(
    Number(dueDate.slice(0, 4)), Number(dueDate.slice(5, 7)) - 1, Number(dueDate.slice(8, 10))
  ) / 86400000;
  const todayParts = today.split("-").map(Number);
  const todayIndex = Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2]) / 86400000;
  const gestationalDays = Math.max(0, Math.round(todayIndex - (dueIndex - 280)));
  return { pregnancyWeek: Math.floor(gestationalDays / 7), pregnancyDay: gestationalDays % 7 };
}

function getDashboardVersion(data: DashboardData): string {
  return hashText(JSON.stringify({
    items: [...data.items].sort((a, b) => a.updated_at.localeCompare(b.updated_at)),
    tasks: [...data.tasks].sort((a, b) => a.key.localeCompare(b.key)),
    pregnancyWeek: data.pregnancyWeek,
    pregnancyDay: data.pregnancyDay
  }));
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

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
