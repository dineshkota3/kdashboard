# Phase 2 — Z.ai glm-4.7 NLP Swap

> Status: ✅ Complete (2026-10-10 — glm-4.7 via Z.ai Coding Plan endpoint; natural-phrasing checklist green, fallback proven live)
> Gate: Phase 3 starts only after natural-phrasing commands parse correctly and the heuristic fallback is proven.

## Goal

Natural-language Telegram commands are parsed by Z.ai's OpenAI-compatible endpoint (glm-4.6). The built-in heuristic parser remains the automatic fallback whenever Z.ai is missing, erroring, or returns malformed JSON.

## 1. File changes

### `functions/telegram-webhook.ts` — in `parseTelegramMessage`

Replace the OpenAI branch:

```ts
const zaiKey = Deno.env.get("ZAI_API_KEY");
if (!zaiKey) return parseMessageHeuristically(message);

const response = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
  method: "POST",
  headers: { "Authorization": `Bearer ${zaiKey}`, "Content-Type": "application/json" },
  signal: AbortSignal.timeout(20000),
  body: JSON.stringify({
    model: Deno.env.get("ZAI_MODEL") || "glm-4.6",
    messages: [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: message }
    ],
    response_format: { type: "json_object" },
    temperature: 0
  })
});
```

- Keep the existing `!response.ok` / bad-JSON / validation-failure paths — they already fall back to heuristics.
- Rewrite `PLANNER_SYSTEM_PROMPT` for the remaining action kinds only:
  - planner actions (`list_key`: `grocery | workout | todo` — `todo` means chores; add/complete/uncomplete/remove/clear)
  - health target actions, challenge check-ins
  - Strict-JSON-only instruction, no prose. (Phase 3 will extend this prompt with the calendar event schema.)

### `.env.example`
- Replace `OPENAI_API_KEY` / `OPENAI_MODEL` with `ZAI_API_KEY` / `ZAI_MODEL=glm-4.6`.

### Docs
- `docs/INSTALL_FOR_USERS.md`, `docs/SETUP_WITH_ASSISTANT.md`, `README.md`: swap the optional-LLM-key section to Z.ai.

## 2. External setup

```sh
# Z.ai account → API key, then:
npx @insforge/cli secrets add ZAI_API_KEY <key>
npx @insforge/cli secrets add ZAI_MODEL glm-4.6

# Redeploy the webhook
npx @insforge/cli functions deploy telegram-webhook \
  --file functions/telegram-webhook.ts --name "Telegram Planner Webhook"
```

If a legacy `OPENAI_API_KEY` secret exists from Phase 0 defaults, delete it so the code path is unambiguous:
`npx @insforge/cli secrets remove OPENAI_API_KEY` (check `--help` for exact remove/update verbs).

## 3. Verification

Natural phrasing (each should produce the right action):
- [ ] `i need to buy oranges and bread tomorrow` → grocery items added
- [ ] `gym done today` → workout/challenge recorded
- [ ] `please remove eggs from my shopping list` → egg removed from grocery
- [ ] `mark the clean desk thing as done` → todo item completed
- [ ] `oops undo that` → last action reverted (if supported by existing action set)

Fallback proof:
- [ ] Temporarily break the key: `npx @insforge/cli secrets update ZAI_API_KEY --value invalid`
- [ ] Send `add bananas to groceries` → **still works** via heuristics; function logs show the Z.ai 401 path
- [ ] Restore the real key

Latency/quality:
- [ ] Check InsForge function logs for parse latency. glm-4.6 reasoning can be slow; if consistently >20 s, lower the timeout (fallback absorbs failures) or consider `glm-4.5-air` for speed.

## 4. Rollback / fallback

- Delete the `ZAI_API_KEY` secret → permanent heuristic mode (by design, zero code changes needed).
- If `response_format: json_object` proves unsupported/misbehaving for glm-4.6: drop the field; strict validators already reject malformed JSON into the heuristic path.

## Tests

- **Extend `functions/telegram-webhook.test.ts`:**
  - source-level assertion: the LLM system prompt (in `telegram-webhook.ts`) contains `grocery|workout|todo` and no `meal`/`recipe` schema lines
  - keep all existing heuristic-parser tests green — they ARE the fallback contract; if you tweak prompts/parsers, they must still pass
  - if you extract any new pure helpers (e.g. response-JSON cleanup), export them and unit-test them here
- **Live tests (need Z.ai key):** the natural-phrasing verification list above; log the chosen action kind per message and compare against intent
- **Fallback tests (live):** invalid `ZAI_API_KEY` → parse still succeeds via heuristics; function log shows the failed Z.ai call then a heuristic action
- `npm test` must stay green before and after redeploying the webhook function.

## 5. Results log

- **2026-10-10 — Code shipped and deployed:**
  - `parseTelegramMessage`: OpenAI branch → Z.ai (`https://api.z.ai/api/paas/v4/chat/completions`, `ZAI_API_KEY`, `ZAI_MODEL=glm-4.6`, 20s `AbortSignal.timeout`). Prompt extracted to exported `PLANNER_SYSTEM_PROMPT` (strict-JSON-only instruction added; kinds unchanged: planner/target/challenge).
  - `.env.example` + README + INSTALL_FOR_USERS + SETUP_WITH_ASSISTANT swapped to Z.ai. No legacy `OPENAI_*` secrets existed in InsForge (verified).
  - Failure-path logging: `zai_parse_failed status=<code> body=<first 300 chars>` (warn) before heuristic fallback.
  - Tests: +2 (prompt contains `grocery|workout|todo`, no meal/recipe; source references api.z.ai + ZAI_* env names, zero OpenAI strings). `npm test` 29 unit + 10 integration green. Webhook redeployed.
- **2026-10-10 — Fallback path proven live (unintentionally, by the account itself):**
  - Z.ai returns **429 error 1113 "Insufficient balance or no resource package. Please recharge."** on every call → heuristic fallback absorbed all of them; every webhook still returned 200 with correct actions. Zero user-visible breakage.
  - Measured: fast-heuristic parse ≈ 1 ms; Z.ai-attempt-then-fallback ≈ 0.4–0.8 s (429 round trip); full webhook 200 in 0.4–1.3 s.
  - Routing note: messages with a planner verb + explicit list alias (e.g. "add … to my shopping list") are deterministically parsed and never hit Z.ai; natural phrasing without list keywords ("i need to buy X and Y tomorrow") is what reaches the LLM. The heuristic catch-all splits unknown text on " and " into a todo add — acceptable fallback behavior, but worth remembering when judging LLM vs fallback results.
  - **BLOCKED:** LLM-path verification (natural-phrasing checklist, glm-4.6 latency) needs Z.ai account credits. Options: top up glm-4.6, or switch `ZAI_MODEL` to `glm-4.5-air` (possibly covered by trial resources; also faster per phase doc). Rerun the verification checklist + fallback `secrets update` test once the account can serve requests.
  - Test artifacts cleaned from `planner_items` after live tests.
- **2026-10-10 (later) — glm-4.7 + Coding Plan endpoint: Phase 2 COMPLETE:**
  - Standard `api/paas/v4` kept 429-ing (error 1113) even after switching `ZAI_MODEL=glm-4.7` → the account is a **GLM Coding Plan**, not a pay-as-you-go balance. `api/coding-paas/v4` (hyphen) returned wrapped 404. **Correct OpenAI-compatible Coding Plan base: `https://api.z.ai/api/coding/paas/v4/chat/completions`** — works with glm-4.7.
  - Natural-phrasing checklist (all live): "i need to buy oranges and bread tomorrow" → grocery [oranges, bread] ✓; "gym done today" → challenge add_workout ✓; "please remove eggs from my shopping list" → grocery delete eggs ✓ (deterministic fast path — "remove"+"shopping"); "mark the clean desk thing as done" → complete todo [clean desk] ✓; "can you buy apples and bananas" → grocery ✓; "drank a big glass of water" → challenge add_water ✓ (fast path).
  - **Latency:** glm-4.7 parse ≈ 2–3.5 s end-to-end (well under the 20 s timeout); fast heuristic ≈ 1 ms; 429-fallback ≈ 0.4–0.8 s.
  - **Undo quirk found + fixed:** "oops undo that" made glm-4.7 hallucinate `uncomplete` with the literal text (harmless no-op, but noisy reply). Fix: prompt instructs `{"kind":"none"}` for undo/questions/chat, **and** the webhook now treats `kind:"none"` as terminal null (reply "I could not understand") instead of letting `??` fallback turn it into a heuristic uncomplete. Verified: undo → `unparsed`; real commands unaffected.
  - Fallback invalid-key test: covered by reality — four production calls hit real 429s and every one fell back invisibly. No need to break the key on purpose.
  - Challenge/test artifacts cleaned (planner test rows deleted; today's water/workouts reset to 0 after check-in tests).
  - Known routing behavior: verb + list-alias messages never reach Z.ai (deterministic); list-keyword-free natural phrasing does. `ZAI_MODEL` secret = glm-4.7; code default updated to match.
