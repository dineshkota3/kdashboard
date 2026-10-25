#!/usr/bin/env node
// One-time Spotify authorization for the Kindle Dashboard (Phase 4.4).
// Opens the browser, captures the OAuth callback on 127.0.0.1:4381, exchanges
// the code, and stores SPOTIFY_REFRESH_TOKEN as an InsForge secret.
// Client id/secret are read from InsForge secrets - never printed.

import { execFileSync } from "node:child_process";
import http from "node:http";
import { randomBytes } from "node:crypto";

const REDIRECT_URI = "http://127.0.0.1:4381/callback";
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
].join(" ");

function insforge(args, { silent = false } = {}) {
  return execFileSync("npx", ["-y", "@insforge/cli", ...args], {
    encoding: "utf8",
    stdio: silent ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function getSecret(name) {
  const raw = insforge(["secrets", "get", name, "--json"], { silent: true });
  const data = JSON.parse(raw);
  const value = data.value ?? data.secret ?? (typeof data.secret === "object" ? data.secret.value : undefined);
  if (!value) throw new Error(`secret ${name} is empty`);
  return String(value);
}

const clientId = getSecret("SPOTIFY_CLIENT_ID");
const clientSecret = getSecret("SPOTIFY_CLIENT_SECRET");

const state = randomBytes(12).toString("hex");
const authUrl =
  "https://accounts.spotify.com/authorize" +
  `?response_type=code&client_id=${encodeURIComponent(clientId)}` +
  `&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&state=${state}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("state mismatch");
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`spotify error: ${error || "no code"}`);
    console.error(`spotify returned an error: ${error}`);
    process.exit(1);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.refresh_token) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end("token exchange failed");
    console.error("token exchange failed:", JSON.stringify(tokenData).slice(0, 200));
    process.exit(1);
  }

  insforge(["secrets", "add", "SPOTIFY_REFRESH_TOKEN", String(tokenData.refresh_token)]);
  console.log("SPOTIFY_REFRESH_TOKEN stored in InsForge secrets.");

  res.writeHead(200, { "Content-Type": "text/plain" }).end("Kindle Dashboard: Spotify connected. You can close this tab.");
  server.close();
  process.exit(0);
});

server.listen(4381, "127.0.0.1", () => {
  console.log("Opening Spotify authorization in your browser...");
  console.log("(if nothing opens, visit the URL below)");
  console.log(authUrl);
  execFileSync("open", [authUrl], { stdio: "ignore" });
});
