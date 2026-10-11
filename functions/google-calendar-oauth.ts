import { createAdminClient } from "npm:@insforge/sdk";

// Google Calendar OAuth: single self-contained function.
//   GET without ?code=  -> returns the Google consent URL (open in a browser).
//                          Optional ?slot=<name> connects an additional calendar
//                          (Phase 3.1); the slot rides the OAuth state parameter.
//   GET with  ?code=    -> exchanges the code, stores the refresh token in the
//                          row for the slot that started the flow, responds
//                          "Calendar connected."
//
// Requires secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
// The redirect URI is this function's own URL (registered in Google Console).

const DEFAULT_SLOT = "owner";
const SLOT_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/;

export default async function(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const clientId = requiredEnv("GOOGLE_CLIENT_ID");
    const clientSecret = requiredEnv("GOOGLE_CLIENT_SECRET");
    // The gateway may present an internal host in req.url (e.g. *.insforge.deno.net),
    // so the redirect URI is built from the stable public base URL instead.
    const publicBase = requiredEnv("INSFORGE_BASE_URL").replace(/\/$/, "");
    const redirectUri = `${publicBase}/functions/google-calendar-oauth`;
    const url = new URL(req.url);
    const code = url.searchParams.get("code");

    if (!code) {
      const slot = normalizeSlot(url.searchParams.get("slot"));
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("state", slot);
      return jsonResponse({ ok: true, slot, auth_url: authUrl.toString() });
    }

    const slot = normalizeSlot(url.searchParams.get("state"));

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      })
    });

    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => "");
      console.error(`google_oauth_exchange_failed status=${tokenResponse.status} body=${detail.slice(0, 300)}`);
      let reason = "";
      try {
        reason = String(JSON.parse(detail)?.error ?? "");
      } catch {
        reason = "";
      }
      return jsonResponse({ ok: false, error: `Token exchange failed (${tokenResponse.status}${reason ? `: ${reason}` : ""})`, redirect_uri: redirectUri }, 502);
    }

    const tokens = await tokenResponse.json();
    const refreshToken = typeof tokens?.refresh_token === "string" ? tokens.refresh_token : "";
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
    const expiresIn = Number(tokens?.expires_in);

    if (!refreshToken) {
      return jsonResponse({
        ok: false,
        error: "No refresh_token returned — revoke the app at myaccount.google.com/permissions and re-consent with prompt=consent"
      }, 502);
    }

    const admin = createAdminClient({
      baseUrl: requiredEnv("INSFORGE_BASE_URL"),
      apiKey: requiredEnv("INSFORGE_API_KEY")
    });

    // Best-effort: resolve which account consented (the primary calendar id is
    // the account email) so the DB shows who owns each slot. Failure leaves 'primary'.
    let calendarId = "primary";
    try {
      const whoResponse = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000)
      });
      if (whoResponse.ok) {
        const who = await whoResponse.json();
        if (typeof who?.id === "string" && who.id.includes("@")) calendarId = who.id;
      }
    } catch {
      // keep 'primary'
    }

    const { error } = await admin.database
      .from("google_calendar_state")
      .upsert({
        slot,
        calendar_id: calendarId,
        refresh_token: refreshToken,
        access_token: accessToken,
        token_expiry: Number.isFinite(expiresIn)
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : new Date(Date.now() + 3600 * 1000).toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: "slot" });

    if (error) throw error;

    return jsonResponse({ ok: true, message: "Calendar connected.", slot });
  } catch (error) {
    console.error("google-calendar-oauth error", error);
    return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
  }
}

function requiredEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

// Slot names are lowercase slugs (kebab/underscore). Anything absent or
// malformed falls back to the owner slot — the state parameter is generated by
// this function, so a mangled value is never worth failing the flow over.
function normalizeSlot(raw: string | null): string {
  const slot = (raw ?? "").trim().toLowerCase();
  if (SLOT_PATTERN.test(slot)) return slot;
  if (raw) console.warn(`google_calendar_slot_invalid raw=${raw.slice(0, 40)}`);
  return DEFAULT_SLOT;
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
