# Phase 0 — Foundation: Fork + Strip Meals + InsForge Bootstrap + Telegram (Heuristics Only)

> Status: ☐ Not started
> Gate: Phase 1 starts only after every verification item below passes.

## Goal

A clean fork of `thecodedose/kdashboard` at `/Users/dineshkota/dev/kindle_project` where:

- Telegram list commands (groceries / workout / todo-chores), health targets, and challenge check-ins work against **your own InsForge project**.
- All meal/recipe/meal-plan code is removed end-to-end (schema, Telegram parser, dashboard payload, C++ renderer, assets, docs).
- No LLM key is needed yet — the built-in heuristic parser handles everything (this proves the parser is complete before Phase 2 swaps in Z.ai).
- No Kindle involvement yet.

## 1. Fork + clone

```sh
# 1. Fork on GitHub using the authenticated gh CLI (creates <you>/kdashboard)
gh repo fork thecodedose/kdashboard --clone=false

# 2. Clone into the project folder (dir is non-empty with docs/, so clone to tmp and merge)
git clone git@github.com:<you>/kdashboard /tmp/kdashboard
cp -R /tmp/kdashboard/. /Users/dineshkota/dev/kindle_project/
rm -rf /tmp/kdashboard

cd /Users/dineshkota/dev/kindle_project
git checkout -b fork/phase-0-strip-meals
npm install          # requires Node.js 20+
```

Keep `main` tracking upstream so we can diff/restore individual files later.

## 2. Strip meals/recipes — exact file changes

### Migrations — DELETE these files
- `migrations/20260629052000_create-recipes.sql`
- `migrations/20260629065000_add-sample-toast.sql`
- `migrations/20260629070000_add-recipe-photo-pgm.sql`
- `migrations/20260629070100_clear-sample-toast-storage-photo.sql`
- `migrations/20260701000000_add-recipe-rating.sql`
- `migrations/20260701001000_recipe-rating-out-of-five.sql`
- `migrations/20260629162000_create-meal-plan-entries.sql`
- `migrations/20260707010000_add-sample-protein-snack.sql`
- `migrations/20260707011000_add-sample-smoothie.sql`

### Migrations — EDIT
- `migrations/001_planner_lists.sql`: remove `'meal'` from the `list_key` CHECK constraint and from the seed rows. Result: only `grocery`, `workout`, `todo`.
- `migrations/20260707000000_enable_rls_private_tables.sql`: remove the recipes / recipe_ingredients / meal_plan RLS lines.

### `functions/telegram-webhook.ts`
Types (delete):
- `RecipeIngredientInput`, `RecipeAction`, `RecipeRatingAction`, `MealPlanAction`
- `ListKey` becomes `"grocery" | "workout" | "todo"`; drop `"meal"` from `LIST_ALIASES` / `LIST_KEYS`.

Functions (delete):
- `applyMealPlanAction`, `applyRecipeAction`, `applyRecipeRatingAction`
- `parseMealPlanHeuristically`, `parseRecipeHeuristically`, `parseRecipeRatingHeuristically`
- their validators, `normalizeRecipeIngredient`, `extractRecipeTitle`, `extractRecipeRatingTitle`, `parseIngredientsList`, `clampRecipeRating`
- meal/recipe lines in the OpenAI/LLM system prompt (full prompt rewrite happens in Phase 2 anyway)

`applyTelegramAction` dispatch reduces to: **challenge → target → planner**.

### `functions/kindle-dashboard-data.ts`
- Delete `RecipeRow`, `RecipeIngredientRow`, `MealPlanEntryRow` types, `recipesResult`, `mealPlanResult`, ingredients query, `recipes` / `meal_plan` payload fields, and their version-hash members.
- Add `"workout"` to the `planner_items` `.in("list_key", [...])` filter and to the `lists` mapping array (order: `todo, workout, grocery` — home grid consumes this order).

### `functions/kindle-dashboard-events.ts`
- Same strip as dashboard-data (remove recipes/meal_plan from payload + hash members); add `"workout"` to the lists query.

### `functions/kindle-dashboard-toggle.ts`
- Unchanged (list-level toggle already generic).

### `kindle/native/src/kindle_dashboard.cpp`
Delete:
- Structs: `RecipeRecord`, `RecipeIngredientRecord`, `MealPlanEntry`
- Functions: `parseRecipes`, `parseMealPlan`, `parseRecipeIngredients`, `recipeIndexById`, `recipePhotoPath`, `drawRecipeLocalImage`, `drawMealPlannerDashboard`, `drawRecipesDashboard`, `drawRecipeRecordDashboard`, `drawRecipeDashboard`, `drawMealPlannerTile`, star-rating helpers
- Touch actions: `kTouchOpenRecipes`, `kTouchOpenRecipe`, `kTouchOpenMealPlanRecipe`, the recipe branches in `handlePendingTouch` / `kTouchBack`
- Globals: `g_active_recipe*`, `g_active_recipes`

Home layout (`drawBitmapDashboard`, ~line 1948) — new grid:
- Left column: `lists[0]` (Todo/Chores) + 75-day challenge tile (unchanged)
- Right column: Workout card (`lists[1]`) above Grocery card (`lists[2]`) — **the workout card replaces the meal-planner tile slot**
- Header "DAILY OPS" + STEPS/CALORIES gauges and footer stay as-is

### `kindle/native/Makefile`
- Remove `meal-planner-cover.pgm` and `assets/recipes` copy lines from BOTH `extension` and `extension-zig` targets.

### `kindle/native/fixtures/dashboard-data.json`
- Ensure fixture has a `workout` list with 2–3 sample items; keep no recipes/meal_plan keys (fixture already omits them).

### Docs
- `docs/INSTALL_FOR_USERS.md`: remove meal sections.
- `.env.example`: leave `OPENAI_*` entries untouched for now (dead until Phase 2 renames them).

## 3. External setup (InsForge + Telegram)

```sh
# InsForge — create account at insforge.dev first, then:
npx @insforge/cli login
npx @insforge/cli create --name kindle-dashboard --region us-east --template empty

# Server-side secrets (functions read these at runtime)
npx @insforge/cli secrets add INSFORGE_BASE_URL https://<project>.insforge.app
npx @insforge/cli secrets add INSFORGE_API_KEY <server-only-api-key>

# Bootstrap: applies trimmed migrations, generates TELEGRAM_WEBHOOK_SECRET,
# HEALTH_SYNC_TOKEN, DASHBOARD_READ_TOKEN, DASHBOARD_TOGGLE_TOKEN, deploys 5 functions
npm run kit:backend

# Telegram
# 1. BotFather → /newbot → save BOT_TOKEN
# 2. Send any message to your bot, then:
npm run telegram:chat-id -- --bot-token <BOT_TOKEN>
# 3. Register webhook + chat allowlist:
npm run telegram:configure -- \
  --bot-token <BOT_TOKEN> \
  --chat-id <CHAT_ID> \
  --webhook-url https://<project>.insforge.app/functions/telegram-webhook
```

Secrets handling rule: tokens go only into terminal commands or local ignored `.env` — never into committed files.

## 4. Verification (all must pass)

Backend payload:
```sh
curl -sS -H "X-Dashboard-Read-Token: <DASHBOARD_READ_TOKEN>" \
  https://<project>.insforge.app/functions/kindle-dashboard-data | jq '.lists | map(.key), has("recipes"), has("meal_plan")'
```
- [ ] `lists` keys = `["todo","workout","grocery"]`; `recipes`/`meal_plan` absent; `has(...)` both false.

Telegram commands (all via heuristic parser — no LLM key set):
- [ ] `add milk and eggs to groceries` → adds 2 items to grocery
- [ ] `need apples, yogurt, oats in grocery` → adds 3 items
- [ ] `put leg day on workout` → adds to workout
- [ ] `add clean desk to todo` → adds to todo
- [ ] `mark milk done` → toggles done
- [ ] `undo milk` → back to open
- [ ] `remove eggs from groceries` → deleted
- [ ] `clear todo` → clears done items
- [ ] `drank 1L water` / `set steps target to 12000` → health targets update
- [ ] `add meal butter chicken` → **rejected** ("could not understand") — proves strip is complete
- [ ] Message from a second Telegram account → ignored (chat allowlist works)

Database (InsForge dashboard → Database):
- [ ] Tables: `planner_lists`, `planner_items`, `health_*`, `challenge_*` exist; **no** `recipes`, `recipe_ingredients`, `meal_plan_entries`

macOS renderer sanity (no Kindle needed):
```sh
npm run native:check      # builds kindle-dashboard-local, renders fixtures/dashboard-data.json
```
- [ ] Renders without crashing; home grid shows Todo + Challenge (left), Workout + Grocery (right)

## 5. Rollback / fallback

- Any broken strip: restore the individual file from upstream `main` (`git checkout main -- functions/telegram-webhook.ts`) and re-apply deletions incrementally.
- Function deploy failure: `npx @insforge/cli functions deploy telegram-webhook --file functions/telegram-webhook.ts --name "Telegram Planner Webhook"` one at a time; check function logs in the InsForge dashboard.
- Migration failure on bootstrap: InsForge DB is fresh — fix SQL, drop partial tables via dashboard, re-run `npm run kit:backend`.

## 6. Results log

_Update this section as work happens: dates, command outputs, deviations from plan._
