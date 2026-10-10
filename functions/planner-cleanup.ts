import { createAdminClient } from "npm:@insforge/sdk";

// Deletes planner items that have been done for longer than the cleanup
// window. Intended to be invoked nightly by an InsForge schedule.
//
// Auth: x-planner-cleanup-token header must match the PLANNER_CLEANUP_TOKEN
// secret. The window (hours) can be overridden with PLANNER_CLEANUP_AFTER_HOURS.

const DEFAULT_AFTER_HOURS = 72;

export default async function(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  if (!isAuthorizedCleanup(req)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const afterHours = readAfterHours();
    const cutoff = new Date(Date.now() - afterHours * 60 * 60 * 1000).toISOString();

    const admin = createAdminClient({
      baseUrl: requiredEnv("INSFORGE_BASE_URL"),
      apiKey: requiredEnv("INSFORGE_API_KEY")
    });

    const { data: deleted, error } = await admin.database
      .from("planner_items")
      .delete()
      .eq("done", true)
      .lt("updated_at", cutoff)
      .select("id");

    if (error) throw error;

    const removed = Array.isArray(deleted) ? deleted.length : 0;
    console.log(`planner-cleanup removed=${removed} after_hours=${afterHours}`);
    return jsonResponse({
      ok: true,
      removed,
      after_hours: afterHours,
      checked_at: new Date().toISOString()
    });
  } catch (error) {
    console.error("planner-cleanup failed", error);
    return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
  }
}

function readAfterHours(): number {
  const raw = Number(Deno.env.get("PLANNER_CLEANUP_AFTER_HOURS"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AFTER_HOURS;
}

function isAuthorizedCleanup(req: Request): boolean {
  const configuredToken = requiredEnv("PLANNER_CLEANUP_TOKEN");
  const receivedToken =
    req.headers.get("x-planner-cleanup-token") ||
    bearerToken(req.headers.get("authorization"));
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
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Planner-Cleanup-Token, Authorization"
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
