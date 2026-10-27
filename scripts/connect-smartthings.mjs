#!/usr/bin/env node
// One-time SmartThings OAuth authorization for the Kindle Dashboard.
// Opens the browser, captures the callback on 127.0.0.1:4382, exchanges the
// code, and stores the refresh token in the st_session DB table (SmartThings
// rotates it on every use - the bridge persists each new one automatically).
// Client id/secret are read from InsForge secrets - never printed.

import { execFileSync } from "node:child_process";
import http from "node:http";
import { randomBytes } from "node:crypto";

const REDIRECT_URI = "http://127.0.0.1:4382/callback";

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

function storeRefreshToken(token) {
  const sql = `DELETE FROM st_session WHERE id='default'; INSERT INTO st_session (id, refresh_token, updated_at) VALUES ('default', '${token.replace(/'/g, "")}', NOW());`;
  insforge(["db", "query", sql], { silent: true });
  console.log("Refresh token stored in st_session table.");
}

const clientId = getSecret("ST_CLIENT_ID");
const clientSecret = getSecret("ST_CLIENT_SECRET");

const state = randomBytes(12).toString("hex");
const SCOPES = [
  "r:locations:*", "r:scenes:*", "w:installedapps", "r:installedapps",
  "w:rules:*", "x:scenes:*", "r:hubs:*", "x:devices:*", "r:rules:*",
  "w:locations:*", "r:devices:*", "w:devices:*", "x:locations:*",
].join(" ");
const authUrl =
  "https://account.smartthings.com/oauth/authorize" +
  `?client_id=${encodeURIComponent(clientId)}&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;

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
  if (!code) {
    const error = url.searchParams.get("error") || "no code";
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`smartthings error: ${error}`);
    console.error(`smartthings returned an error: ${error}`);
    process.exit(1);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokenRes = await fetch("https://api.smartthings.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.refresh_token) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end("token exchange failed");
    console.error("token exchange failed:", JSON.stringify(tokenData).slice(0, 200));
    process.exit(1);
  }

  storeRefreshToken(String(tokenData.refresh_token));
  console.log("SmartThings OAuth connected: refresh token stored.");

  res.writeHead(200, { "Content-Type": "text/plain" }).end("Kindle Dashboard: SmartThings connected. You can close this tab.");
  server.close();
  process.exit(0);
});

server.listen(4382, "127.0.0.1", () => {
  console.log("Opening SmartThings authorization in your browser...");
  console.log("(if nothing opens, visit the URL below)");
  console.log(authUrl);
  execFileSync("open", [authUrl], { stdio: "ignore" });
});
