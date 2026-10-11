#!/usr/bin/env node
// Connect an ADDITIONAL Google Calendar to the Kindle Dashboard (Phase 3.1).
//
//   npm run google:connect -- --slot keethu --timezone Europe/Amsterdam
//
// Reuses the OAuth client already stored by `npm run google:setup` — no gcloud,
// no new Google Cloud project, no secret changes. The second user just consents
// with THEIR Google account in the browser.
//
// IMPORTANT: run the consent in the second user's browser profile (or an
// incognito window). If the browser is signed in as the owner, Google silently
// reuses that session and the owner's calendar gets stored under this slot.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const REDIRECT_PATH = "/functions/google-calendar-oauth";
const SLOT_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/;

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

function openBrowser(url) {
  try {
    if (process.platform === "darwin") run("open", [url]);
    else if (process.platform === "linux") run("xdg-open", [url]);
  } catch {
    // user opens the printed link manually
  }
}

function readInsforgeBaseUrl() {
  const path = ".insforge/project.json";
  if (!existsSync(path)) return "";
  const config = JSON.parse(readFileSync(path, "utf8"));
  const base = config.oss_host || config.backend_url || "";
  return String(base).replace(/\/+$/, "");
}

// `npx @insforge/cli secrets get KEY` prints `KEY =<value>` (no space after =)
// on the last line. See docs/FORK_NOTES.md — do NOT parse with awk '{print $NF}'.
function secretValue(key) {
  const output = runInsforge(["secrets", "get", key], { capture: true });
  const line = output.split("\n").find((row) => row.startsWith(key)) ?? "";
  return line.replace(new RegExp(`^${key}[\\s]*=[\\s]*`), "").trim();
}

function printState(states) {
  console.log("\nConnected calendars (oldest first — the first row is the booking default):");
  for (const row of states) {
    console.log(`  - ${row.slot}: ${row.connected ? "connected" : "NOT connected"} · calendar=${row.calendar_id || "primary"} · tz=${row.timezone || "default"}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: npm run google:connect -- --slot <name> [--timezone <tz>] [--no-open]

Connects an ADDITIONAL Google calendar (e.g. a partner's) to this deployment.
Requires google:setup to have been run once for the owner — this script never
creates a Google Cloud project and never touches OAuth secrets.`);
    process.exit(0);
  }

  const slotArg = args.includes("--slot") ? args[args.indexOf("--slot") + 1] : "";
  const timezoneArg = args.includes("--timezone") ? args[args.indexOf("--timezone") + 1] : "";
  const noOpen = args.includes("--no-open");

  const slot = (slotArg || "").trim().toLowerCase();
  if (!SLOT_PATTERN.test(slot)) {
    console.error("--slot is required: a lowercase name, 1-16 chars, letters/digits/-/_ (e.g. --slot keethu).");
    process.exit(1);
  }
  if (slot === "owner") {
    console.error('The first calendar is already "owner" — pick a personal name for the additional user.');
    process.exit(1);
  }

  const insforgeBase = readInsforgeBaseUrl();
  if (!insforgeBase) {
    console.error("No linked InsForge project found (.insforge/project.json).");
    console.error("Run `npx -y @insforge/cli login` + `npx -y @insforge/cli link` first.");
    process.exit(1);
  }

  console.log("Kindle Dashboard — connect an additional Google Calendar");
  console.log("========================================================");
  console.log(`InsForge project: ${insforgeBase}`);
  console.log(`Slot:             ${slot}`);

  console.log("[1/4] Checking the existing OAuth client...");
  try {
    if (!secretValue("GOOGLE_CLIENT_ID") || !secretValue("GOOGLE_CLIENT_SECRET")) {
      throw new Error("missing");
    }
  } catch {
    console.error("\nGOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not stored yet.");
    console.error("Run `npm run google:setup` ONCE for the first (owner) calendar.");
    console.error("Do NOT rerun google:setup for this user — it would replace the OAuth");
    console.error("client and invalidate the owner's stored token. Then rerun google:connect.");
    process.exit(1);
  }
  console.log("- OAuth client found (reusing it — no new Google Cloud project needed)");

  console.log("[2/4] Fetching the consent link...");
  const consentJson = await fetch(`${insforgeBase}${REDIRECT_PATH}?slot=${encodeURIComponent(slot)}`).then((r) => r.json());
  if (!consentJson.auth_url) {
    console.error("Could not fetch a consent URL — check function logs in the InsForge dashboard.");
    process.exit(1);
  }

  console.log(`
[3/4] Consent (browser step)

  Open the link below ${noOpen ? "" : "(also opening in your browser)"} and consent with the
  GOOGLE ACCOUNT OF THE PERSON FOR THIS SLOT — not the owner's account.

  ${consentJson.auth_url}

  - Use their browser profile or an incognito window: Google silently reuses
    the signed-in session, and the owner's calendar would land on slot "${slot}".
  - Expect the one-time "Google hasn't verified this app" screen:
    Advanced -> Go to <app name> (unsafe). That warning is normal for a
    personal, unverified app in Production.
`);
  if (!noOpen) openBrowser(consentJson.auth_url);
  await ask(`Press Enter once you see "Calendar connected."...`);

  console.log("[4/4] Verifying...");
  try {
    if (timezoneArg) {
      runInsforge(["db", "query", `UPDATE google_calendar_state SET timezone = '${timezoneArg.replace(/'/g, "''")}' WHERE slot = '${slot}'`]);
    }
    const stateJson = await runInsforge(
      ["db", "query", `SELECT slot, refresh_token IS NOT NULL AS connected, calendar_id, timezone FROM google_calendar_state ORDER BY created_at`, "--json"],
      { capture: true }
    );
    const states = JSON.parse(stateJson)?.data ?? [];
    const mine = states.find((row) => row.slot === slot);
    if (!mine?.connected) {
      console.error(`WARNING: slot "${slot}" has no refresh token yet — re-open the consent link (step 3).`);
      printState(states);
      process.exit(1);
    }
    printState(states);
    if (timezoneArg && mine.timezone !== timezoneArg) {
      console.log(`Note: timezone is ${mine.timezone}; wanted ${timezoneArg} — set it in the InsForge dashboard.`);
    }
  } catch {
    console.error("Could not verify automatically — check the table in the InsForge dashboard.");
  }

  console.log(`
Done. Events for "${slot}" appear on their Kindle strip at the hourly refresh.
Book into it from Telegram:  schedule for ${slot}: dentist friday 3pm
Owner bookings stay unchanged: schedule dentist friday 3pm`);
}

await main();
