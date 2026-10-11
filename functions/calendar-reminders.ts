// Telegram calendar reminders (Phase 3.1): a cron (every 15 min) POSTs here and
// the bot announces upcoming events once each at T-12h and T-1h.
//
// Requires secrets: CALENDAR_REMINDER_TOKEN (header auth), TELEGRAM_BOT_TOKEN,
// TELEGRAM_ALLOWED_CHAT_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// INSFORGE_BASE_URL, INSFORGE_API_KEY.
//
// Budget note: every cron tick costs exactly ONE InsForge function call; the
// Google + Telegram + DB work inside is free. 15-min cadence ≈ 2,880 calls/mo.

const T1_EARLY_MIN = 60;
const T1_LATE_MIN = 75;
const T12_EARLY_MIN = 12 * 60;
const T12_LATE_MIN = 12 * 60 + 15;
// One fetch window covers both reminder kinds with buffer for the cron interval.
const FETCH_WINDOW_MIN = T12_LATE_MIN + 5;

export type ReminderCandidate = {
  id: string;
  title: string;
  all_day: boolean;
  start_iso: string;
};

export type PickedReminder = {
  id: string;
  kind: "t1" | "t12";
};

// Pure: which (event, kind) pairs fire for a cron run at nowMs. Google sorts by
// startTime, and the windows are half-open [early, late) so back-to-back runs
// never double-fire the same minute.
export function pickReminders(events: ReminderCandidate[], nowMs: number): PickedReminder[] {
  const picked: PickedReminder[] = [];
  for (const event of events) {
    const startMs = Date.parse(event.start_iso);
    if (!Number.isFinite(startMs)) continue;
    const minsUntil = (startMs - nowMs) / 60_000;
    // All-day events get the evening-before ping only — a "1 hour until your
    // birthday" alarm at midnight is noise.
    if (!event.all_day && minsUntil >= T1_EARLY_MIN && minsUntil < T1_LATE_MIN) {
      picked.push({ id: event.id, kind: "t1" });
    }
    if (minsUntil >= T12_EARLY_MIN && minsUntil < T12_LATE_MIN) {
      picked.push({ id: event.id, kind: "t12" });
    }
  }
  return picked;
}

export default async function(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const expectedToken = Deno.env.get("CALENDAR_REMINDER_TOKEN");
  const receivedToken = req.headers.get("x-calendar-reminder-token");
  if (!expectedToken || receivedToken !== expectedToken) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    // Lazy import so Node unit tests can load this module for the pure helpers.
    const { createAdminClient } = await import("npm:@insforge/sdk");
    const admin = createAdminClient({
      baseUrl: requiredEnv("INSFORGE_BASE_URL"),
      apiKey: requiredEnv("INSFORGE_API_KEY")
    });

    const { data: stateRows, error: stateError } = await admin.database
      .from("google_calendar_state")
      .select("slot,refresh_token,access_token,token_expiry,calendar_id,timezone")
      .order("created_at", { ascending: true })
      .limit(4);
    if (stateError) throw stateError;

    const nowMs = Date.now();
    const sent: string[] = [];

    for (const row of Array.isArray(stateRows) ? stateRows : []) {
      if (!row?.refresh_token) continue;
      const slot = row.slot || "owner";
      const accessToken = await ensureGoogleAccessToken(admin, row);
      if (!accessToken) {
        console.warn(`calendar_reminders_token_failed slot=${slot}`);
        continue;
      }

      const events = await fetchUpcomingEvents(row, accessToken, nowMs);
      const picked = pickReminders(events, nowMs);
      if (picked.length === 0) continue;

      // Ledger check in one query: skip anything already announced.
      const ids = picked.map((p) => p.id);
      const { data: already, error: ledgerError } = await admin.database
        .from("calendar_reminders_sent")
        .select("event_id,kind")
        .in("event_id", ids)
        .eq("slot", slot);
      if (ledgerError) throw ledgerError;
      const sentKeys = new Set((Array.isArray(already) ? already : []).map((r: any) => `${r.event_id}|${r.kind}`));

      for (const pick of picked) {
        const key = `${pick.id}|${pick.kind}`;
        if (sentKeys.has(key)) continue;
        const event = events.find((e: ReminderCandidate) => e.id === pick.id);
        if (!event) continue;
        const message = reminderMessage(event, slot, pick.kind, row.timezone);
        const delivered = await sendTelegramMessage(message);
        if (!delivered) {
          console.warn(`calendar_reminders_send_failed slot=${slot} event=${pick.id}`);
          continue;
        }
        const { error: insertError } = await admin.database
          .from("calendar_reminders_sent")
          .insert([{ event_id: pick.id, slot, kind: pick.kind, sent_at: new Date().toISOString() }]);
        if (insertError) {
          console.error(`calendar_reminders_ledger_failed slot=${slot} event=${pick.id}`, insertError);
          continue;
        }
        sent.push(`${slot}:${pick.kind}:${event.title}`);
      }
    }

    console.log(`calendar_reminders run sent=${sent.length}`);
    return jsonResponse({ ok: true, sent });
  } catch (error) {
    console.error("calendar-reminders error", error instanceof Error ? error.message : String(error));
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function fetchUpcomingEvents(state: any, accessToken: string, nowMs: number): Promise<ReminderCandidate[]> {
  const calendarId = encodeURIComponent(state.calendar_id || "primary");
  const params = new URLSearchParams({
    timeMin: new Date(nowMs).toISOString(),
    timeMax: new Date(nowMs + FETCH_WINDOW_MIN * 60_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
    timeZone: state.timezone || "Asia/Kolkata"
  });
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000)
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn(`calendar_reminders_fetch_failed status=${response.status} body=${detail.slice(0, 200)}`);
    return [];
  }
  const json = await response.json();
  const items = Array.isArray(json?.items) ? json.items : [];
  return items
    .map((item: any) => ({
      id: typeof item?.id === "string" ? item.id : "",
      title: typeof item?.summary === "string" && item.summary.trim() ? item.summary.trim().slice(0, 120) : "(untitled)",
      all_day: Boolean(item?.start?.date) && !item?.start?.dateTime,
      start_iso: String(item?.start?.dateTime || item?.start?.date || "")
    }))
    .filter((e: ReminderCandidate) => e.id && e.start_iso);
}

async function ensureGoogleAccessToken(admin: any, state: any): Promise<string | null> {
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
  if (!response.ok) return null;

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

function reminderMessage(event: ReminderCandidate, slot: string, kind: "t1" | "t12", timezone: string): string {
  const prefix = kind === "t1" ? "⏰ In ~1 hour" : "📅 In ~12 hours";
  return `${prefix} · ${slot.charAt(0).toUpperCase()}${slot.slice(1)}: ${event.title} — ${formatEventStart(event.start_iso, event.all_day, timezone)}`;
}

function formatEventStart(startIso: string, allDay: boolean, timezone: string): string {
  const parsed = Date.parse(startIso);
  if (!Number.isFinite(parsed)) return startIso;
  if (allDay) {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
    return `${fmt.format(parsed)} (all day)`;
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true
  });
  return fmt.format(parsed);
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
    "Access-Control-Allow-Headers": "Content-Type, X-Calendar-Reminder-Token"
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
