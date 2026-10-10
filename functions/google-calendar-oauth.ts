import { createAdminClient } from "npm:@insforge/sdk";

// Google Calendar OAuth: single self-contained function.
//   GET without ?code=  -> returns the Google consent URL (open in a browser)
//   GET with  ?code=    -> exchanges the code, stores the refresh token,
//                          responds "Calendar connected."
//
// Requires secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
// The redirect URI is this function's own URL (registered in Google Console).

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
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("client_id", clientId);
      return jsonResponse({ ok: true, auth_url: authUrl.toString() });
    }

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

    const { error } = await admin.database
      .from("google_calendar_state")
      .upsert({
        id: 1,
        refresh_token: refreshToken,
        access_token: accessToken,
        token_expiry: Number.isFinite(expiresIn)
          ? new Date(Date.now() + expiresIn * 1000).toISOString()
          : new Date(Date.now() + 3600 * 1000).toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: "id" });

    if (error) throw error;

    return jsonResponse({ ok: true, message: "Calendar connected." });
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
