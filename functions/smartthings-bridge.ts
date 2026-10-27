// SmartThings bridge (Phase 4.4): power/volume/mute for the Samsung soundbar.
// Auth: ST_PAT secret; target device: ST_DEVICE_ID secret (seeded from
// GET /devices once). Endpoint auth: DASHBOARD_READ_TOKEN like the other feeds.

const ST_API = "https://api.smartthings.com/v1";
const ST_OAUTH_TOKEN = "https://api.smartthings.com/oauth/token";

let cachedStToken: { token: string; expires: number } | null = null;

// SmartThings OAuth: access tokens last 24h, refresh tokens rotate on use.
// The current refresh token lives in the st_session table (persisted by this
// function after every refresh); ST_CLIENT_ID/SECRET bootstrap the session.
async function stAccessToken(): Promise<string> {
  if (cachedStToken && Date.now() < cachedStToken.expires - 120_000) return cachedStToken.token;
  const { createAdminClient } = await import("npm:@insforge/sdk");
  const admin = createAdminClient({ baseUrl: requiredEnv("INSFORGE_BASE_URL"), apiKey: requiredEnv("INSFORGE_API_KEY") });
  const { data: rows } = await admin.database.from("st_session").select("refresh_token").eq("id", "default").limit(1);
  const refresh = rows?.[0]?.refresh_token;
  if (typeof refresh !== "string" || !refresh) {
    throw new Error("SmartThings not connected — run scripts/connect-smartthings.mjs once.");
  }
  const res = await fetch(ST_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: requiredEnv("ST_CLIENT_ID"),
      client_secret: requiredEnv("ST_CLIENT_SECRET"),
      refresh_token: refresh,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`smartthings token refresh failed: ${res.status} ${errBody.slice(0, 100)}`);
  }
  const data = await res.json();
  if (data.refresh_token) {
    await admin.database.from("st_session").update({ refresh_token: data.refresh_token, updated_at: new Date().toISOString() }).eq("id", "default");
  }
  cachedStToken = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 86400) * 1000 };
  return cachedStToken.token;
}

async function stHeaders(): Promise<HeadersInit> {
  return { Authorization: `Bearer ${await stAccessToken()}`, "Content-Type": "application/json" };
}

async function st(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${ST_API}${path}`, {
    ...init,
    headers: { ...(await stHeaders()), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) {
    // token went stale mid-flight: force refresh once
    cachedStToken = null;
    const res2 = await fetch(`${ST_API}${path}`, {
      ...init,
      headers: { ...(await stHeaders()), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res2.ok) throw new Error(`smartthings ${path} -> ${res2.status}`);
    return res2.json();
  }
  if (!res.ok) throw new Error(`smartthings ${path} -> ${res.status}`);
  return res.json();
}

async function deviceId(): Promise<string> {
  return requiredEnv("ST_DEVICE_ID");
}

async function deviceStatus(): Promise<{ state: string; volume: number | null; muted: boolean | null }> {
  const id = await deviceId();
  const data = await st(`/devices/${id}/status`);
  const comp = data.components?.main ?? {};
  const vol = comp.audioVolume?.volume?.value;
  const muted = comp.audioMute?.mute?.value;
  const sw = comp.switch?.switch?.value;
  return { state: String(sw ?? "unknown"), volume: typeof vol === "number" ? vol : null, muted: typeof muted === "boolean" ? muted : null };
}

async function runCommand(body: { action?: string; value?: number }): Promise<string> {
  const id = await deviceId();
  const action = body.action ?? "";
  let commands: Array<{ capability: string; command: string; arguments?: number[] }> = [];
  if (action === "off") {
    commands = [{ capability: "switch", command: "off" }];
  } else if (action === "on") {
    commands = [{ capability: "switch", command: "on" }];
  } else if (action === "volume") {
    // HARD CAP at 20% (owner request) - soundbars are loud; every volume path
    // (Telegram, Kindle) funnels through this clamp. Above 20% = manual only.
    const volume = Math.max(0, Math.min(20, Math.round(body.value ?? -1)));
    if (volume < 0) return "What volume? e.g. \"volume 30\".";
    commands = [{ capability: "audioVolume", command: "setVolume", arguments: [volume] }];
  } else if (action === "mute") {
    commands = [{ capability: "audioMute", command: "mute" }];
  } else if (action === "unmute") {
    commands = [{ capability: "audioMute", command: "unmute" }];
  } else {
    return `Unknown soundbar action "${String(action).slice(0, 24)}".`;
  }
  await st(`/devices/${id}/commands`, {
    method: "POST",
    body: JSON.stringify({ commands }),
  });
  const labels: Record<string, string> = {
    off: "Soundbar off",
    on: "Soundbar on",
    volume: `Soundbar volume ${Math.max(0, Math.min(20, Math.round(body.value ?? 0)))}%`,
    mute: "Soundbar muted",
    unmute: "Soundbar unmuted",
  };
  return `🔊 ${labels[action] ?? action}`;
}

// Soundbar power/volume feed the same state row the SSE hash watches.
async function storeSoundbarState(): Promise<void> {
  try {
    const status = await deviceStatus();
    const { createAdminClient } = await import("npm:@insforge/sdk");
    const admin = createAdminClient({ baseUrl: requiredEnv("INSFORGE_BASE_URL"), apiKey: requiredEnv("INSFORGE_API_KEY") });
    const existing = await admin.database.from("spotify_state").select("data").eq("id", "default").limit(1);
    let merged: Record<string, unknown> = { soundbar_on: status.state === "on", soundbar_volume: status.volume };
    const prev = existing?.data?.[0]?.data;
    if (typeof prev === "object" && prev !== null) {
      merged = { ...prev, ...merged };
    } else if (typeof prev === "string") {
      try { merged = { ...JSON.parse(prev), ...merged }; } catch { /* keep defaults */ }
    }
    await admin.database.from("spotify_state").delete().eq("id", "default");
    await admin.database.from("spotify_state").insert([{
      id: "default",
      data: JSON.stringify(merged),
      updated_at: new Date().toISOString(),
    }]);
  } catch (e) {
    console.error("spotify_state soundbar write failed", String(e).slice(0, 120));
  }
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (!isAuthorized(req)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.get("list") === "devices") {
        const data = await st("/devices");
        return jsonResponse({ ok: true, devices: (data.items ?? []).map((d: { deviceId: string; name: string; label?: string }) => ({ id: d.deviceId, name: d.name, label: d.label })) });
      }
      return jsonResponse({ ok: true, status: await deviceStatus() });
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const summary = await runCommand(body ?? {});
      try {
        await storeSoundbarState();
      } catch {
        // state write is best-effort
      }
      return jsonResponse({ ok: true, summary });
    }
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("smartthings-bridge error", String(error).slice(0, 300));
    return jsonResponse({ ok: false, error: String(error).slice(0, 200) }, 500);
  }
}

function isAuthorized(req: Request): boolean {
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

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Dashboard-Read-Token, Authorization"
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" }
  });
}
