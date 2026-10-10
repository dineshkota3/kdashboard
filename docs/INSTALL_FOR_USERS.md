# Kindle Dashboard Bring-Your-Own-Backend Install

This guide is for Kindle owners who want their own private dashboard instance.
You will run your own InsForge backend, Telegram bot, and Kindle KUAL package.

If you want a coding assistant to walk through this with you, start with
`docs/SETUP_WITH_ASSISTANT.md`.

## What You Need

- A jailbroken Kindle with KUAL installed.
- A Mac/Linux machine with Node.js 20+ and npm.
- An InsForge account.
- A Telegram bot token from BotFather.
- Optional: Zig or an ARM Kindle cross compiler if you want to rebuild the native binary yourself.

The Kindle package never stores the InsForge admin API key. It reads from public
dashboard endpoints and sends item toggles through the deployed toggle function.

## 1. Create Your Backend

Clone the repo, install dependencies, and log in to InsForge:

```sh
npm install
npx @insforge/cli login
```

Create a fresh InsForge project, or link this checkout to an existing empty one:

```sh
npx @insforge/cli create --name kindle-dashboard --region us-east --template empty
```

Bootstrap the schema, generated secrets, and functions:

```sh
npm run kit:backend
```

The bootstrap script applies the public schema migrations, creates generated
`TELEGRAM_WEBHOOK_SECRET`, `HEALTH_SYNC_TOKEN`, `DASHBOARD_READ_TOKEN`, and
`DASHBOARD_TOGGLE_TOKEN` values if missing, and deploys the dashboard functions.

Sample-data migrations are not used in this fork; `--with-sample-data` is a
no-op kept for compatibility.

## 2. Add Required Backend Secrets

Set the backend URL and API key for the functions. These are server-side
function secrets, not Kindle-side values.

```sh
npx @insforge/cli secrets add INSFORGE_BASE_URL https://your-project.insforge.app
npx @insforge/cli secrets add INSFORGE_API_KEY your-server-only-api-key
```

Optional natural-language parsing (Z.ai):

```sh
npx @insforge/cli secrets add ZAI_API_KEY your-zai-api-key
npx @insforge/cli secrets add ZAI_MODEL glm-4.7
```

If `ZAI_API_KEY` is missing, the Telegram webhook uses its built-in command
parser.

### Google Calendar (one command)

Requires the `gcloud` CLI (`brew install --cask google-cloud-sdk`). The script
creates the Google Cloud project, enables the Calendar API, walks you through
the two browser forms, stores the OAuth secrets, redeploys the functions, and
opens the consent link:

```sh
npm run google:setup
```

Prefer manual setup? Create an OAuth **Web application** client in Google
Console with redirect URI `https://your-project.insforge.app/functions/google-calendar-oauth`,
then:

```sh
npx @insforge/cli secrets add GOOGLE_CLIENT_ID your-client-id
npx @insforge/cli secrets add GOOGLE_CLIENT_SECRET your-client-secret
npx @insforge/cli functions deploy google-calendar-oauth --file functions/google-calendar-oauth.ts --name "Google Calendar OAuth"
curl https://your-project.insforge.app/functions/google-calendar-oauth   # open the auth_url
```

### Housekeeping

Completed list items stay on the board (bottom of each list) for 3 days, then
disappear. A nightly schedule deletes them from the database:

```sh
npx @insforge/cli secrets add PLANNER_CLEANUP_TOKEN a-long-random-token
npx @insforge/cli functions deploy planner-cleanup --file functions/planner-cleanup.ts --name "Planner Cleanup"
npx @insforge/cli schedules create --name planner-nightly-cleanup --cron "30 21 * * *" \
  --method POST --url https://your-project.insforge.app/functions/planner-cleanup \
  --headers '{"X-Planner-Cleanup-Token": "${{secrets.PLANNER_CLEANUP_TOKEN}}"}'
```

Without the schedule, done items still stop showing after 3 days but remain in
the database.

## 3. Connect Telegram

Create a bot with BotFather and send it one message. Then discover your chat ID:

```sh
npm run telegram:chat-id -- --bot-token 123456789:telegram-bot-token
```

Register the webhook and store your bot token/chat allowlist:

```sh
npm run telegram:configure -- \
  --bot-token 123456789:telegram-bot-token \
  --chat-id 123456789 \
  --webhook-url https://your-project.insforge.app/functions/telegram-webhook
```

Try a Telegram command:

```text
add milk and eggs to groceries
add clean desk to todo
mark milk done
```

## Supported Telegram Messages

The webhook supports these message types. If `ZAI_API_KEY` is configured, it
can understand more natural phrasing; if not, the built-in parser supports the
patterns below.

### Planner Lists

Supported lists:

- Grocery: `grocery`, `groceries`, `shopping`, `market`
- Workout: `workout`, `exercise`, `training`, `gym`
- Todo/chores: `todo`, `to-do`, `task`, `tasks`, `errand`, `errands`

Add items:

```text
add milk and eggs to groceries
need apples, yogurt, oats in grocery
put leg day on workout
add clean desk to todo
```

Mark items done:

```text
mark milk done
complete leg day in workout
check off clean desk from todo
```

Mark items open again:

```text
undo milk
uncheck leg day in workout
mark clean desk not done
```

Remove items:

```text
remove eggs from groceries
delete leg day from workout
drop clean desk from todo
```

Clear a list:

```text
clear todo
empty groceries
reset workout
```

If a done/open/remove command does not name a list, the webhook searches across
lists for matching item text.

### Health Targets

Set dashboard targets for steps or calories:

```text
set steps target to 12000
update calorie goal to 2100
change calories target = 1900
```

### 75 Day Challenge Check-Ins

Log water:

```text
drank 1L water
water 750ml
XL water
```

Log sleep:

```text
slept 7.5 hours
sleep 8h
```

Log a workout:

```text
workout done
completed gym
did exercise
```

## 4. Configure the Kindle Package

Build or download `kindle-dashboard-kual.tar.gz`.

Run the local syntax/render check before packaging:

```sh
npm run native:check
```

If you have Zig installed, build a soft-float ARM KUAL package:

```sh
make -C kindle/native extension-zig ZIG=/path/to/zig
```

If you have a dedicated Kindle ARM compiler, build with:

```sh
make -C kindle/native extension
```

The GNU build expects `arm-linux-gnueabi-g++` by default. Override with
`KINDLE_CXX=/path/to/compiler` if your toolchain uses a different binary name.

The package is written to:

```text
kindle/native/build/kindle-dashboard-kual.tar.gz
```

Copy it to the Kindle and extract it into the KUAL extensions directory:

```sh
tar -C /mnt/us/extensions -xzf kindle-dashboard-kual.tar.gz
```

Copy the example config and edit the URLs:

```sh
cd /mnt/us/extensions/kindle-dashboard
cp config.sh.example config.sh
```

`config.sh` should look like this:

```sh
DASHBOARD_DATA_URL="https://your-project.insforge.app/functions/kindle-dashboard-data"
DASHBOARD_EVENTS_URL="https://your-project.function2.insforge.app/kindle-dashboard-events"
DASHBOARD_TOGGLE_URL="https://your-project.insforge.app/functions/kindle-dashboard-toggle"
DASHBOARD_READ_TOKEN="replace-with-your-generated-read-token"
DASHBOARD_TOGGLE_TOKEN="replace-with-your-generated-toggle-token"
INTERVAL="3600"
DASHBOARD_KEEP_AWAKE="1"
DASHBOARD_SLEEP_WINDOW="off"
INVERT_IMAGES="0"
```

Fetch the tokens from InsForge and paste them into `config.sh`:

```sh
npx @insforge/cli secrets get DASHBOARD_READ_TOKEN --json
npx @insforge/cli secrets get DASHBOARD_TOGGLE_TOKEN --json
```

Use the direct `function2.insforge.app` host for the events URL. InsForge's
regular `/functions/...` gateway can buffer SSE responses.

If you use the local installer script, set your data URL explicitly so it does
not seed from the wrong backend:

```sh
DASHBOARD_DATA_URL=https://your-project.insforge.app/functions/kindle-dashboard-data DASHBOARD_READ_TOKEN=<read-token> npm run native:install
```

## 5. Launch On Kindle

On the Kindle, open KUAL:

- `Kindle Dashboard -> Refresh Once (Light)` fetches and renders one update for Kindle light mode.
- `Kindle Dashboard -> Refresh Once (Dark)` fetches and renders one update for Kindle dark mode.
- `Kindle Dashboard -> Start Dashboard (Light)` starts hourly refresh for Kindle light mode.
- `Kindle Dashboard -> Start Dashboard (Dark)` starts hourly refresh for Kindle dark mode.
- `Kindle Dashboard -> Stop Dashboard` stops the process.

Useful Kindle-side files:

```text
/mnt/us/documents/kindle-dashboard-native.log
/mnt/us/documents/kindle-dashboard-diagnose.log
/mnt/us/documents/kindle-dashboard-data.json
```

The native app uses an always-on profile: hourly auto-refresh, manual KUAL
refresh on demand, and no overnight quiet mode by default. For optional
auto-open notes, see `kindle/README.md`.

## 6. Optional Health Sync Companion

The native iOS companion app lives in:

```text
ios/HealthSyncCompanion
```

It reads Apple Health daily steps and nutrition totals, then sends daily
aggregate rows to the `health-sync` InsForge function.

Before running the iOS app, make sure the health pieces are deployed:

```sh
npx @insforge/cli db migrations up 20260627000000_create-health-daily-summaries.sql
npx @insforge/cli secrets add HEALTH_SYNC_TOKEN <long-random-health-sync-token>
npx @insforge/cli functions deploy health-sync --file functions/health-sync.ts --name "Health Sync"
```

Then configure the local iOS secret:

```sh
cd ios/HealthSyncCompanion
cp Config/LocalConfig.example.xcconfig Config/LocalConfig.xcconfig
```

Edit `Config/LocalConfig.xcconfig` so `HEALTH_SYNC_TOKEN` matches the InsForge
secret. Open `HealthSyncCompanion.xcodeproj` in Xcode and run it on a real
iPhone; HealthKit data is not meaningfully testable in the simulator.

## Updating Later

When you pull a new version:

```sh
npm install
npm run kit:backend
make -C kindle/native extension-zig ZIG=/path/to/zig
```

Then replace the installed KUAL extension files, keeping your local `config.sh`.

## Privacy Notes

- Do not share `INSFORGE_API_KEY`, Telegram bot token, webhook secret, or health
  sync token.
- Treat `DASHBOARD_READ_TOKEN` and `DASHBOARD_TOGGLE_TOKEN` as device secrets.
  The read token exposes dashboard data, while the toggle token can change
  checklist state.
- The Kindle reads dashboard data through your deployed function URLs using
  the read token.
- This kit is single-owner by design. For a hosted multi-user service, every
  table and function would need per-user scoping and device pairing.
