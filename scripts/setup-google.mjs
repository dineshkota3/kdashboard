#!/usr/bin/env node
// One-command Google Calendar setup for the Kindle Dashboard.
//
//   npm run google:setup
//
// Automates everything that CAN be automated (Google Cloud project, Calendar
// API, InsForge secrets, function deploys, consent link) and walks you through
// the two things Google only allows in the browser (consent branding + OAuth
// client creation).
//
// Requirements: gcloud CLI (brew install --cask google-cloud-sdk), a Google
// account, and this repo linked to your InsForge project.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const REDIRECT_PATH = "/functions/google-calendar-oauth";

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
}

function runInsforge(args, options = {}) {
  return run("npx", ["-y", "@insforge/cli", ...args], options);
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const chars = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk) => {
      const char = chunk.toString("utf8");
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(chars.join(""));
      } else if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007f") {
        chars.pop();
      } else {
        chars.push(char);
      }
    };
    process.stdin.on("data", onData);
  });
}

function readInsforgeBaseUrl() {
  const path = ".insforge/project.json";
  if (!existsSync(path)) return "";
  const config = JSON.parse(readFileSync(path, "utf8"));
  const base = config.oss_host || config.backend_url || "";
  return String(base).replace(/\/+$/, "");
}

function gcloudAccount() {
  try {
    return run("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { capture: true }).trim();
  } catch {
    return "";
  }
}

function openBrowser(url) {
  try {
    if (process.platform === "darwin") run("open", [url]);
    else if (process.platform === "linux") run("xdg-open", [url]);
  } catch {
    // user opens the printed link manually
  }
}

function setInsforgeSecret(key, value) {
  try {
    runInsforge(["secrets", "get", key], { capture: true });
    runInsforge(["secrets", "update", key, "--value", value]);
    console.log(`- updated ${key}`);
  } catch {
    runInsforge(["secrets", "add", key, value]);
    console.log(`- added ${key}`);
  }
}

async function main() {
  const insforgeBase = readInsforgeBaseUrl();
  if (!insforgeBase) {
    console.error("No linked InsForge project found (.insforge/project.json).");
    console.error("Run `npx -y @insforge/cli login` + `npx -y @insforge/cli link` first.");
    process.exit(1);
  }
  const redirectUri = `${insforgeBase}${REDIRECT_PATH}`;

  console.log("Kindle Dashboard — Google Calendar setup");
  console.log("========================================");
  console.log(`InsForge project: ${insforgeBase}`);
  console.log(`Redirect URI Google will need: ${redirectUri}`);
  console.log("");

  console.log("[1/7] Checking gcloud CLI...");
  try {
    run("gcloud", ["--version"], { capture: true });
  } catch {
    console.error(`
gcloud CLI is required. Install it, then re-run this script:
  macOS:  brew install --cask google-cloud-sdk
  other:  https://cloud.google.com/sdk/docs/install
`);
    process.exit(1);
  }

  const account = gcloudAccount();
  if (account) {
    console.log(`[2/7] Already signed in to gcloud as ${account}`);
  } else {
    console.log("[2/7] Opening browser for Google login...");
    run("gcloud", ["auth", "login"]);
  }

  console.log("[3/7] Google Cloud project");
  const newProject = ((await ask("Create a NEW project? [Y/n]: ")) || "Y").toLowerCase() === "y";
  let projectId = "";
  if (newProject) {
    projectId = `kindle-dashboard-${Math.random().toString(36).slice(2, 8)}`;
    run("gcloud", ["projects", "create", projectId, "--name=Kindle Dashboard"]);
    console.log(`Created project ${projectId}`);
  } else {
    projectId = await ask("Enter the existing project ID: ");
    if (!projectId) {
      console.error("Project ID required.");
      process.exit(1);
    }
  }
  run("gcloud", ["config", "set", "project", projectId]);

  console.log("[4/7] Enabling the Google Calendar API...");
  run("gcloud", ["services", "enable", "calendar-json.googleapis.com"]);

  console.log("[5/7] Creating the OAuth client (browser steps — ~2 minutes)");
  console.log(`
Two short forms open in your browser:

  a) Consent screen branding:
     https://console.cloud.google.com/apis/credentials/consent?project=${projectId}
     - App name:           Kindle Dashboard
     - User support email: your email
     - Audience:           External
     - Save. (Optional now: Publish app so tokens never expire.)

  b) Credentials -> Create credentials -> OAuth client ID:
     https://console.cloud.google.com/apis/credentials/oauthclient?project=${projectId}
     - Application type:        Web application
     - Authorized redirect URI: paste EXACTLY the line printed above
     - Create, then copy the Client ID and Client secret.
`);
  await ask("Press Enter when you have the Client ID and Client secret...");
  const clientId = await ask("Paste the Client ID: ");
  const clientSecret = await askHidden("Paste the Client Secret (input hidden): ");

  if (!clientId.includes("apps.googleusercontent.com")) {
    console.error("That does not look like a Google OAuth Client ID (expected ...apps.googleusercontent.com).");
    process.exit(1);
  }
  if (!clientSecret) {
    console.error("Client secret is required.");
    process.exit(1);
  }

  console.log("[6/7] Storing secrets in InsForge and redeploying functions...");
  setInsforgeSecret("GOOGLE_CLIENT_ID", clientId);
  setInsforgeSecret("GOOGLE_CLIENT_SECRET", clientSecret);
  for (const [slug, file, name] of [
    ["google-calendar-oauth", "functions/google-calendar-oauth.ts", "Google Calendar OAuth"],
    ["kindle-dashboard-data", "functions/kindle-dashboard-data.ts", "Kindle Dashboard Data"],
    ["telegram-webhook", "functions/telegram-webhook.ts", "Telegram Planner Webhook"]
  ]) {
    runInsforge(["functions", "deploy", slug, "--file", file, "--name", name]);
  }

  console.log("[7/7] Connecting your calendar (browser step)");
  const consentJson = await fetch(`${insforgeBase}${REDIRECT_PATH}`).then((r) => r.json());
  if (!consentJson.auth_url) {
    console.error("Could not fetch a consent URL — check function logs in the InsForge dashboard.");
    process.exit(1);
  }
  console.log(`Consent link (also opening in your browser):\n${consentJson.auth_url}\n`);
  openBrowser(consentJson.auth_url);
  await ask("Approve access, then press Enter once you see \"Calendar connected.\"...");

  try {
    const state = await runInsforge(
      ["db", "query", "SELECT refresh_token IS NOT NULL AS connected FROM google_calendar_state", "--json"],
      { capture: true }
    );
    const parsed = JSON.parse(state);
    const connected = parsed?.data?.[0]?.connected;
    if (connected) {
      console.log("Verified: refresh token stored.");
    } else {
      console.error("WARNING: no refresh token stored — run the consent link again.");
    }
  } catch {
    console.error("Could not verify the stored token automatically — check the InsForge dashboard.");
  }

  console.log("\nAll done. Calendar events appear on the Kindle at the hourly refresh and on any");
  console.log("Telegram update. Book events by messaging the bot, e.g. `schedule dentist friday 3pm`.");
  console.log("Tip: keep the consent app in Production (Google Auth Platform -> Audience -> Publish");
  console.log("app) so the connection never expires.");
}

await main();
