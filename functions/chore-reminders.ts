// Chore reminders (Phase 4.1): a cron (every 30 min, 07,37 * * * *) POSTs here
// and the bot nudges every open chore whose window has started — one combined
// message per run — until the owner replies "chore done <name>" or skips it.
//
// Requires secrets: CHORE_REMINDER_TOKEN (header auth), TELEGRAM_BOT_TOKEN,
// TELEGRAM_ALLOWED_CHAT_ID, INSFORGE_BASE_URL, INSFORGE_API_KEY.
//
// Budget note: 48 runs/day ≈ 1,488 InsForge calls/mo (~1.5% of the free tier)
// and at most ONE outbound Telegram call per run. Quiet hours 00:00-09:00
// dashboard time (DASHBOARD_TIMEZONE): no sends, but the sweep still runs.

export const QUIET_START_MIN = 540; // 09:00 dashboard-local

export type ChoreRow = {
  id: string;
  text: string;
  pattern: "daily" | "weekly" | "once";
  days: string;
  once_date: string;
  start_min: number;
  end_min: number;
  skip_date: string;
  last_notified_at: string;
};

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

// English short weekday -> canonical 2-letter code ('mo'..'su').
function weekdayCode(short: string): string {
  const map: Record<string, string> = {
    mon: "mo", tue: "tu", wed: "we", thu: "th", fri: "fr", sat: "sa", sun: "su"
  };
  return map[short.slice(0, 3).toLowerCase()] ?? short.slice(0, 2);
}

// Dashboard-local calendar parts for a moment: 'YYYY-MM-DD', 'mo'..'su', minutes since midnight.
export function dashboardNow(ms: number, timeZone: string = dashboardTimezone()): { day: string; weekday: string; nowMin: number } {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .format(d).toLowerCase();
  const weekday = weekdayCode(wd);
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false
  }).format(d);
  const [h, m] = hm.split(":").map(Number);
  return { day, weekday, nowMin: h * 60 + m };
}

// Occurrence rule shared with the webhook: does the chore fire on `day`?
export function occursOn(chore: Pick<ChoreRow, "pattern" | "days" | "once_date">, day: string): boolean {
  if (chore.pattern === "once") return chore.once_date === day;
  if (chore.pattern === "daily") return true;
  return chore.days.split(",").map((s) => s.trim()).includes(weekdayOf(day));
}

// 'YYYY-MM-DD' -> 'mo'..'su' (pure, no tz needed: the date IS dashboard-local).
export function weekdayOf(day: string): string {
  // Days are stored as dashboard-local; compute weekday from noon UTC to stay
  // clear of any local-timezone edge in the runtime.
  const parsed = Date.parse(`${day}T12:00:00Z`);
  const wd = new Date(parsed).toUTCString().slice(0, 3).toLowerCase();
  return weekdayCode(wd);
}

// Pure core the unit tests exercise: which chores nag at this instant?
export function dueChores(
  chores: ChoreRow[],
  doneIds: Set<string>,
  nowMs: number,
  spacingMs = 29 * 60_000,
  timeZone?: string
): ChoreRow[] {
  const { day, nowMin } = dashboardNow(nowMs, timeZone);
  if (nowMin < QUIET_START_MIN) return []; // quiet hours 00:00-09:00
  return chores.filter((chore) => {
    if (doneIds.has(chore.id)) return false;
    if (chore.skip_date === day) return false;
    if (!occursOn(chore, day)) return false;
    if (chore.start_min > nowMin || chore.end_min < nowMin) return false;
    const last = Date.parse(chore.last_notified_at);
    return !Number.isFinite(last) || nowMs - last >= spacingMs;
  });
}

// Pure: human window, "22:00" or "9:00-22:00" (24h, dashboard-consistent).
export function timeDisplay(startMin: number, endMin: number): string {
  const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return startMin === endMin || endMin >= 1440 ? fmt(startMin) : `${fmt(startMin)}-${fmt(endMin)}`;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }
  const expectedToken = Deno.env.get("CHORE_REMINDER_TOKEN");
  const receivedToken = req.headers.get("x-chore-reminder-token");
  if (!expectedToken || receivedToken !== expectedToken) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const { createAdminClient } = await import("npm:@insforge/sdk");
    const admin = createAdminClient({
      baseUrl: requiredEnv("INSFORGE_BASE_URL"),
      apiKey: requiredEnv("INSFORGE_API_KEY")
    });

    const nowMs = Date.now();
    const { day } = dashboardNow(nowMs);

    // Sweep: one-off chores whose day passed are deleted (owner rule). Recurring
    // chores are never swept; their open state is derived per day.
    const { data: stale, error: staleError } = await admin.database
      .from("chores")
      .select("id")
      .eq("pattern", "once")
      .lt("once_date", day);
    if (staleError) throw staleError;
    for (const row of stale ?? []) {
      await admin.database.from("chores").delete().eq("id", row.id);
    }

    const { data: chores, error: choreError } = await admin.database
      .from("chores")
      .select("id,text,pattern,days,once_date,start_min,end_min,skip_date,last_notified_at,created_at");
    if (choreError) throw choreError;
    // Same sort as the webhook's numbered list: start time, then creation.
    const sortedChores = ((chores ?? []) as ChoreRow[]).sort(
      (a, b) => a.start_min - b.start_min || a.created_at.localeCompare(b.created_at)
    );

    const { data: dones, error: doneError } = await admin.database
      .from("chore_dones")
      .select("chore_id")
      .eq("day", day);
    if (doneError) throw doneError;

    const doneIds = new Set<string>((dones ?? []).map((r: { chore_id: string }) => r.chore_id));
    const due = dueChores(sortedChores, doneIds, nowMs);

    let notified = 0;
    if (due.length > 0) {
      // Number by position in the full sorted list so the reminder numbers
      // match the "chores" query reply (and "chore done N" targets it).
      const lines = due.map((c) => {
        const pos = sortedChores.findIndex((x) => x.id === c.id) + 1;
        return `${pos}. ${c.text} (${timeDisplay(c.start_min, c.end_min)})`;
      });
      const sent = await sendTelegramMessage(
        `⏰ Chore reminder${due.length > 1 ? "s" : ""}:\n${lines.join("\n")}\nReply "chore done N" or "chore skip N".`
      );
      if (sent) {
        notified = due.length;
        for (const chore of due) {
          await admin.database.from("chores").update({ last_notified_at: new Date().toISOString() }).eq("id", chore.id);
        }
      }
    }

    return jsonResponse({ ok: true, day, swept: (stale ?? []).length, due: due.length, notified });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error) }, 500);
  }
}

async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_ALLOWED_CHAT_ID");
  if (!token || !chatId) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ chat_id: chatId, text })
    });
    return response.ok;
  } catch {
    return false;
  }
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Chore-Reminder-Token"
  };
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
