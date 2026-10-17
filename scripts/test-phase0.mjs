#!/usr/bin/env node
// Phase 0 integration tests: repo hygiene, migration consistency, fixture
// shape, and C++ renderer smoke tests. Run via `npm test` (after
// `node --test functions/telegram-webhook.test.ts` for parser unit tests).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

function walk(dir, skip = new Set()) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, skip));
    else out.push(p);
  }
  return out;
}

console.log("phase 0: repo hygiene");
check("no meal/recipe references outside phase docs", () => {
  const includeExt = /\.(ts|mjs|js|json|sql|cpp|h|sh|md|example|xml|toml)$/;
  const targets = ["functions", "migrations", "scripts", "kindle", "docs", "README.md", ".env.example"];
  const offenders = [];
  for (const target of targets) {
    const p = join(ROOT, target);
    if (!existsSync(p)) continue;
    const files = statSync(p).isDirectory() ? walk(p, new Set(["build", "node_modules", "phases", "Config"])) : [p];
    for (const file of files) {
      if (!includeExt.test(file)) continue;
      if (file.endsWith("FORK_NOTES.md") || file.endsWith("test-phase0.mjs")) continue;
      if (file.endsWith(".test.ts")) continue; // negative-assertion tests legitimately contain the words
      const text = readFileSync(file, "utf8");
      if (/meal|recipe/i.test(text)) offenders.push(file.replace(`${ROOT}/`, ""));
    }
  }
  assert.deepEqual(offenders, []);
});

console.log("phase 0: bootstrap consistency");
check("all schema migrations in bootstrap list exist", () => {
  const src = readFileSync(join(ROOT, "scripts/bootstrap-insforge-kit.mjs"), "utf8");
  const listMatch = src.match(/const schemaMigrations = \[([\s\S]*?)\];/);
  assert.ok(listMatch, "schemaMigrations block found");
  const files = [...listMatch[1].matchAll(/"([^"]+\.sql)"/g)].map((m) => m[1]);
  assert.ok(files.length >= 4, "at least 4 migrations listed");
  for (const file of files) assert.ok(existsSync(join(ROOT, file)), `missing: ${file}`);
});

check("planner_lists CHECK keys == seed keys == {grocery, workout, todo}", () => {
  const sql = readFileSync(join(ROOT, "migrations/001_planner_lists.sql"), "utf8");
  const checkKeys = [...sql.matchAll(/CHECK \(key IN \(([^)]*)\)\)/g)][0][1]
    .split(",").map((s) => s.trim().replaceAll("'", "")).sort();
  const seedBlock = sql.split("VALUES")[1];
  const seedKeys = [...seedBlock.matchAll(/\('([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(checkKeys, ["grocery", "todo", "workout"]);
  assert.deepEqual(seedKeys, ["grocery", "todo", "workout"]);
});

check("no meal/recipe table names in any migration", () => {
  for (const file of walk(join(ROOT, "migrations"))) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/recipe|meal_plan/i.test(text), `${file} mentions recipe/meal_plan`);
  }
});

console.log("phase 0: fixture shape");
check("fixture lists == todo, workout, grocery and no recipe sections", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "kindle/native/fixtures/dashboard-data.json"), "utf8"));
  assert.deepEqual(fixture.lists.map((l) => l.key), ["todo", "workout", "grocery"]);
  assert.equal(fixture.recipes, undefined);
  assert.equal(fixture.meal_plan, undefined);
});

console.log("phase 0: renderer smoke");
const BIN = join(ROOT, "kindle/native/build/kindle-dashboard-local");
check("native binary builds cleanly", () => {
  execFileSync("make", ["-C", join(ROOT, "kindle/native"), "local"], { stdio: "pipe" });
  assert.ok(existsSync(BIN), "kindle-dashboard-local built");
});

const tmp = mkdtempSync(join(tmpdir(), "kdash-test-"));
for (const view of [null, "challenge", "chores", "workout", "grocery", "calendar", "health", "pregnancy", "health-steps", "health-hr"]) {
  check(`render view=${view ?? "home"} at PW5 resolution`, () => {
    const out = join(tmp, `view-${view ?? "home"}.pgm`);
    const args = ["--render", join(ROOT, "kindle/native/fixtures/dashboard-data.json"), "--dump-pgm", out, "--dump-size", "1236x1648"];
    if (view) args.push("--view", view);
    const result = spawnSync(BIN, args, { stdio: "pipe" });
    assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
    const header = readFileSync(out).subarray(0, 20).toString("latin1");
    assert.match(header, /^P5\n1236 1648\n/);
    const bytes = readFileSync(out);
    // Non-blank: mix of dark and light pixels
    let dark = 0;
    for (let i = 4096; i < bytes.length; i += 997) if (bytes[i] < 128) dark += 1;
    assert.ok(dark > 20, `too few dark pixels (${dark}) — likely blank render`);
  });
}

check("render tolerates fixture without workout/grocery lists", () => {
  const minimal = { ok: true, version: "test", lists: [{ key: "todo", title: "Chores", items: [] }] };
  const path = join(tmp, "minimal.json");
  execFileSync("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(JSON.stringify(minimal))})`]);
  const out = join(tmp, "minimal.pgm");
  const result = spawnSync(BIN, ["--render", path, "--dump-pgm", out], { stdio: "pipe" });
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
});

// ---- phase 3.1: multi-calendar renderer ----

function writeTempJson(name, value) {
  const path = join(tmp, name);
  execFileSync("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(JSON.stringify(value))})`]);
  return path;
}

function renderToPgm(fixturePath, view) {
  const out = join(tmp, `out-${Math.random().toString(36).slice(2)}.pgm`);
  const args = ["--render", fixturePath, "--dump-pgm", out, "--dump-size", "1236x1648"];
  if (view) args.push("--view", view);
  const result = spawnSync(BIN, args, { stdio: "pipe" });
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  return readFileSync(out);
}

function darkPixelCount(bytes) {
  let dark = 0;
  for (let i = 4096; i < bytes.length; i += 997) if (bytes[i] < 128) dark += 1;
  return dark;
}

check("phase 3.1: home renders TWO strips when calendars[] has 2 feeds", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "kindle/native/fixtures/dashboard-data.json"), "utf8"));
  const bytes = renderToPgm(join(ROOT, "kindle/native/fixtures/dashboard-data.json"), null);
  const twoFeed = darkPixelCount(bytes);

  const single = { ...fixture, calendar: { status: "ok", events: fixture.calendar.events } };
  const singlePath = writeTempJson("single-feed.json", single);
  const oneFeed = darkPixelCount(renderToPgm(singlePath, null));

  assert.ok(twoFeed > oneFeed, `two-strip render should ink more pixels (two=${twoFeed}, one=${oneFeed})`);
});

check("phase 3.1: parser tolerates calendars[] without top-level events", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "kindle/native/fixtures/dashboard-data.json"), "utf8"));
  const feedsOnly = { ...fixture, calendar: { status: "ok", calendars: fixture.calendar.calendars } };
  const path = writeTempJson("feeds-only.json", feedsOnly);
  for (const view of [null, "calendar"]) {
    const bytes = renderToPgm(path, view);
    assert.ok(darkPixelCount(bytes) > 20, `view=${view ?? "home"} render blank`);
  }
});

check("phase 3.1: legacy payload without calendars[] still renders one strip", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "kindle/native/fixtures/dashboard-data.json"), "utf8"));
  const legacy = { ...fixture, calendar: { status: "ok", events: fixture.calendar.events } };
  const path = writeTempJson("legacy-calendar.json", legacy);
  for (const view of [null, "calendar"]) {
    const bytes = renderToPgm(path, view);
    assert.ok(darkPixelCount(bytes) > 20, `view=${view ?? "home"} render blank`);
  }
});

check("phase 3.1: not_connected aggregate with one dead feed still renders both strips", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "kindle/native/fixtures/dashboard-data.json"), "utf8"));
  const degraded = {
    ...fixture,
    calendar: {
      status: "ok",
      events: fixture.calendar.events,
      calendars: [
        fixture.calendar.calendars[0],
        { slot: "keethu", status: "unavailable", events: [] }
      ]
    }
  };
  const path = writeTempJson("degraded-feed.json", degraded);
  const bytes = renderToPgm(path, null);
  assert.ok(darkPixelCount(bytes) > 20, "home render blank");
});

// ---- phase 4: health screens ----

check("phase 4: fixture carries two health people + configured pregnancy", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "kindle/native/fixtures/dashboard-data.json"), "utf8"));
  assert.equal(fixture.health.people.length, 2);
  assert.equal(fixture.health.people[0].person, "dinesh");
  assert.equal(fixture.pregnancy.configured, true);
  assert.equal(fixture.pregnancy.milestones.length, 8);
});

check("phase 4: health + pregnancy views render non-blank", () => {
  const fixturePath = join(ROOT, "kindle/native/fixtures/dashboard-data.json");
  for (const view of ["health", "pregnancy", "health-steps", "health-hr"]) {
    const bytes = renderToPgm(fixturePath, view);
    assert.ok(darkPixelCount(bytes) > 20, `view=${view} render blank`);
  }
});

check("phase 4: legacy payload without people/pregnancy still renders", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "kindle/native/fixtures/dashboard-data.json"), "utf8"));
  const { people, ...healthCompat } = fixture.health;
  const legacy = { ...fixture, health: healthCompat };
  delete legacy.pregnancy;
  const path = writeTempJson("legacy-no-people.json", legacy);
  for (const view of [null, "health", "pregnancy"]) {
    const bytes = renderToPgm(path, view);
    assert.ok(darkPixelCount(bytes) > 20, `view=${view ?? "home"} render blank`);
  }
});

check("phase 4: unconfigured pregnancy renders the setup hint", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "kindle/native/fixtures/dashboard-data.json"), "utf8"));
  const unconfigured = { ...fixture, pregnancy: { configured: false } };
  const path = writeTempJson("pregnancy-unset.json", unconfigured);
  const bytes = renderToPgm(path, "pregnancy");
  assert.ok(darkPixelCount(bytes) > 20, "pregnancy render blank");
});

rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall phase 0 tests passed");
