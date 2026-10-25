// SmartThings bridge (Phase 4.4): power/volume/mute for the Samsung soundbar.
// Auth: ST_PAT secret; target device: ST_DEVICE_ID secret (seeded from
// GET /devices once). Endpoint auth: DASHBOARD_READ_TOKEN like the other feeds.

const ST_API = "https://api.smartthings.com/v1";

function stHeaders(): HeadersInit {
  return { Authorization: `Bearer ${requiredEnv("ST_PAT")}`, "Content-Type": "application/json" };
}

async function st(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${ST_API}${path}`, {
    ...init,
    headers: { ...stHeaders(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
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
