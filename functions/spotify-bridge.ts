// Spotify control bridge (Phase 4.4): the Kindle screen and the Telegram
// webhook both POST here; the bridge talks to the Spotify Web API.
// Auth: SPOTIFY_REFRESH_TOKEN (one-time browser login via
// scripts/connect-spotify.mjs) -> access tokens cached per warm instance.
// Endpoint auth: x-dashboard-read-token (same token as the data feed).

type NowPlaying = {
  is_playing: boolean;
  track: string | null;
  artist: string | null;
  progress_ms: number;
  duration_ms: number;
  device: string | null;
};

let cachedToken: { token: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires - 60_000) return cachedToken.token;
  const refresh = requiredEnv("SPOTIFY_REFRESH_TOKEN");
  const basic = btoa(`${requiredEnv("SPOTIFY_CLIENT_ID")}:${requiredEnv("SPOTIFY_CLIENT_SECRET")}`);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`spotify token refresh failed: ${res.status}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

async function spotifyApi(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  return fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
}

// Bounded wait for the soundbar to (re)register with Spotify Connect after
// power-on (~30-60s). Total function time stays under ~45s.
async function waitForSoundbar(maxWaitMs = 40000): Promise<string | null> {
  const deadline = Date.now() + maxWaitMs;
  let id = await soundbarDeviceId();
  while (!id && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    id = await soundbarDeviceId();
  }
  return id;
}

// The soundbar is the default playback target; find it by name hint.
async function soundbarDeviceId(): Promise<string | null> {
  const hint = (Deno.env.get("SPOTIFY_DEVICE_HINT") || "soundbar").toLowerCase();
  const res = await spotifyApi("/me/player/devices");
  if (!res.ok) return null;
  const data = await res.json();
  for (const device of data.devices ?? []) {
    if (String(device.name ?? "").toLowerCase().includes(hint)) return device.id as string;
  }
  return (data.devices ?? [])[0]?.id ?? null;
}

async function nowPlaying(): Promise<NowPlaying> {
  const res = await spotifyApi("/me/player");
  if (res.status === 204 || res.status === 202) {
    return { is_playing: false, track: null, artist: null, progress_ms: 0, duration_ms: 0, device: null };
  }
  if (!res.ok) throw new Error(`me/player ${res.status}`);
  const data = await res.json();
  const item = data.item ?? {};
  return {
    is_playing: Boolean(data.is_playing),
    track: item.name ?? null,
    artist: (item.artists ?? []).map((a: { name: string }) => a.name)[0] ?? null,
    progress_ms: data.progress_ms ?? 0,
    duration_ms: item.duration_ms ?? 0,
    device: data.device?.name ?? null,
  };
}

// Search candidates waiting for the user's numbered pick ("play 2").
async function storePending(items: Array<{ name: string; artist: string; uri: string }>): Promise<void> {
  const { createAdminClient } = await import("npm:@insforge/sdk");
  const admin = createAdminClient({ baseUrl: requiredEnv("INSFORGE_BASE_URL"), apiKey: requiredEnv("INSFORGE_API_KEY") });
  await admin.database.from("spotify_pending").delete().eq("id", "telegram");
  await admin.database.from("spotify_pending").insert([{
    id: "telegram",
    items: JSON.stringify(items),
    created_at: new Date().toISOString(),
  }]);
}

async function loadPending(): Promise<Array<{ name: string; artist: string; uri: string }>> {
  const { createAdminClient } = await import("npm:@insforge/sdk");
  const admin = createAdminClient({ baseUrl: requiredEnv("INSFORGE_BASE_URL"), apiKey: requiredEnv("INSFORGE_API_KEY") });
  const { data } = await admin.database.from("spotify_pending").select("items").eq("id", "telegram").limit(1);
  try {
    const items = data?.[0]?.items;
    return typeof items === "string" ? JSON.parse(items) : items ?? [];
  } catch {
    return [];
  }
}

async function runCommand(body: { action?: string; query?: string; volume?: number; index?: number; uri?: string }): Promise<string> {
  const action = body.action ?? "";
  if (action === "select") {
    const idx = Math.max(1, Math.round(body.index ?? 0)) - 1;
    const pending = await loadPending();
    if (idx < 0 || idx >= pending.length) {
      return pending.length
        ? `Pick 1-${pending.length}: ${pending.map((t, i) => `${i + 1}. ${t.name} — ${t.artist}`).join(" | ")}`
        : "Nothing to pick from — play a song first.";
    }
    const track = pending[idx];
    const deviceId = (await soundbarDeviceId()) ?? "";
    if (deviceId) await spotifyApi("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [deviceId], play: false }) });
    const play = await spotifyApi(`/me/player/play${deviceId ? `?device_id=${deviceId}` : ""}`, {
      method: "PUT",
      body: JSON.stringify({ uris: [track.uri] }),
    });
    if (!play.ok && play.status !== 202) return `Play failed (${play.status}).`;
    return `▶️ ${track.name} — ${track.artist}`;
  }
  if (action === "playlists") {
    const res = await spotifyApi("/me/playlists?limit=10");
    const items = (await res.json()).items ?? [];
    if (items.length === 0) return "No saved playlists.";
    return `📚 Playlists: ${items.map((p: { name: string }, i: number) => `${i + 1}. ${p.name}`).join(" | ")}`;
  }
  if (action === "liked") {
    const res = await spotifyApi("/me/tracks?limit=10");
    const items = (await res.json()).items ?? [];
    const tracks = items.map((it: { track: { name: string; artists: { name: string }[]; uri: string } }) => ({
      name: it.track.name,
      artist: it.track.artists?.[0]?.name ?? "",
      uri: it.track.uri,
    }));
    await storePending(tracks);
    if (tracks.length === 0) return "No saved (liked) songs.";
    return `❤️ Saved songs: ${tracks.map((t: { name: string; artist: string }, i: number) => `${i + 1}. ${t.name} — ${t.artist}`).join(" | ")} — reply "play N".`;
  }
  if (action === "play_liked") {
    const deviceId = (await soundbarDeviceId()) ?? "";
    const res = await spotifyApi("/me/tracks?limit=20");
    const items = (await res.json()).items ?? [];
    const uris = items.map((it: { track: { uri: string } }) => it.track.uri).filter(Boolean);
    if (uris.length === 0) return "No saved (liked) songs to play.";
    if (deviceId) await spotifyApi("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [deviceId], play: false }) });
    const play = await spotifyApi(`/me/player/play${deviceId ? `?device_id=${deviceId}` : ""}`, {
      method: "PUT",
      body: JSON.stringify({ uris }),
    });
    if (!play.ok && play.status !== 202) return `Play failed (${play.status}).`;
    return `▶️ Playing ${uris.length} saved songs.`;
  }
  if (action === "play_playlist") {
    const uri = body.uri ?? "";
    if (!uri) return "Missing playlist.";
    const deviceId = (await soundbarDeviceId()) ?? "";
    if (deviceId) await spotifyApi("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [deviceId], play: false }) });
    const play = await spotifyApi(`/me/player/play${deviceId ? `?device_id=${deviceId}` : ""}`, {
      method: "PUT",
      body: JSON.stringify({ context_uri: uri }),
    });
    if (!play.ok && play.status !== 202) return `Play failed (${play.status}).`;
    return "▶️ Playing playlist.";
  }
  if (action === "status") {
    const np = await nowPlaying();
    return np.track
      ? `🎵 ${np.track} — ${np.artist} ${np.is_playing ? "(playing" : "(paused"} on ${np.device})`
      : "🎵 Nothing playing on Spotify.";
  }
  if (action === "transfer") {
    const deviceId = await soundbarDeviceId();
    if (!deviceId) return "No Spotify device found — play something once in the Spotify app so the soundbar appears.";
    await spotifyApi("/me/player", {
      method: "PUT",
      body: JSON.stringify({ device_ids: [deviceId], play: true }),
    });
    return `▶️ Playback moved to the ${Deno.env.get("SPOTIFY_DEVICE_HINT") || "soundbar"}.`;
  }
  if (action === "search_play") {
    const query = (body.query ?? "").trim();
    if (!query) return "What should I play?";
    let deviceId = (await soundbarDeviceId()) ?? "";
    const search = await spotifyApi(`/search?q=${encodeURIComponent(query)}&type=track&limit=5`);
    if (!search.ok) return `Search failed (${search.status}).`;
    const tracks = (await search.json()).tracks?.items ?? [];
    if (tracks.length === 0) return `No track found for "${query.slice(0, 60)}".`;
    const options = tracks.map((t: { name: string; artists: { name: string }[]; uri: string }) => ({
      name: t.name,
      artist: t.artists?.[0]?.name ?? "",
      uri: t.uri,
    }));
    if (!deviceId) deviceId = (await waitForSoundbar(20000)) ?? "";
    if (options.length > 1) {
      await storePending(options);
      const list = options.map((o: { name: string; artist: string }, i: number) => `${i + 1}. ${o.name} — ${o.artist}`).join("\n");
      return `Several matches for "${query.slice(0, 50)}":\n${list}\nReply "play N" to choose.`;
    }
    if (deviceId) {
      await spotifyApi("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [deviceId], play: false }) });
    }
    const play = await spotifyApi(`/me/player/play${deviceId ? `?device_id=${deviceId}` : ""}`, {
      method: "PUT",
      body: JSON.stringify({ uris: [options[0].uri] }),
    });
    if (!play.ok && play.status !== 202) return `Play failed (${play.status}).`;
    return `▶️ ${options[0].name} — ${options[0].artist}`;
  }
  if (action === "pause" || action === "play" || action === "next" || action === "prev") {
    // Target the soundbar explicitly: when it has no active Spotify session
    // (idle soundbars unregister), bare commands do nothing. Transfer first
    // to wake the session, then run the command against its device id.
    let deviceId = (await soundbarDeviceId()) ?? "";
    if (!deviceId && action !== "pause") {
      deviceId = (await waitForSoundbar()) ?? "";
    }
    if (!deviceId) {
      return "Soundbar not connected to Spotify — play a song once from the Spotify app to wake it.";
    }
    if (action === "pause") {
      await spotifyApi(`/me/player/pause?device_id=${deviceId}`, { method: "PUT" });
      return "⏸️ Paused.";
    }
    if (action === "play") {
      await spotifyApi("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [deviceId], play: true }) });
      return "▶️ Playing on the soundbar.";
    }
    if (action === "next") {
      await spotifyApi(`/me/player/next?device_id=${deviceId}`, { method: "POST" });
      return "⏭️ Next track.";
    }
    await spotifyApi(`/me/player/previous?device_id=${deviceId}`, { method: "POST" });
    return "⏮️ Previous track.";
  }
  if (action === "volume") {
    const volume = Math.max(0, Math.min(100, Math.round(body.volume ?? -1)));
    if (volume < 0) return "What volume? e.g. \"volume 40\".";
    await spotifyApi(`/me/player/volume?volume_percent=${volume}`, { method: "PUT" });
    return `🔊 Volume ${volume}%.`;
  }
  return `Unknown action "${action.slice(0, 24)}".`;
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
        const res = await spotifyApi("/me/player/devices");
        return jsonResponse({ ok: true, devices: (await res.json()).devices ?? [] });
      }
      return jsonResponse({ ok: true, now_playing: await nowPlaying() });
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const summary = await runCommand(body ?? {});
      return jsonResponse({ ok: true, summary });
    }
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("spotify-bridge error", String(error).slice(0, 300));
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
