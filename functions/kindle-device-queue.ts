// Device command queue (Phase 4.2): Telegram writes device_commands rows; the
// Kindle (on the home LAN, the only thing that can reach the WiZ bulb's local
// UDP API) fetches pending rows here, executes them, and acks.
//
// Auth: DASHBOARD_READ_TOKEN (same token/headers as the dashboard data feed).
// GET  -> {commands:[{id,target,action}]}  (<=5 oldest pending)
// POST {id, ok} -> mark done/failed + executed_at
//
// The SSE stream's version hash counts pending rows, so the Kindle learns
// about new commands in ~2s without any polling loop. Nightly
// planner-cleanup prunes rows older than a day.

type CommandRow = {
  id: string;
  target: string;
  action: unknown;
};

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (!isAuthorized(req)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const { createAdminClient } = await import("npm:@insforge/sdk");
    const admin = createAdminClient({
      baseUrl: requiredEnv("INSFORGE_BASE_URL"),
      apiKey: requiredEnv("INSFORGE_API_KEY")
    });

    if (req.method === "GET") {
      const { data: rows, error } = await admin.database
        .from("device_commands")
        .select("id,target,action")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(5);
      if (error) throw error;
      return jsonResponse({
        ok: true,
        commands: (rows ?? []) as CommandRow[]
      });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      const id = body && typeof body.id === "string" ? body.id : "";
      if (!id) return jsonResponse({ ok: false, error: "Missing id" }, 400);
      const ok = Boolean(body?.ok);
      const { error } = await admin.database
        .from("device_commands")
        .update({ status: ok ? "done" : "failed", executed_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      return jsonResponse({ ok: true, id, status: ok ? "done" : "failed" });
    }

    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error) }, 500);
  }
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
