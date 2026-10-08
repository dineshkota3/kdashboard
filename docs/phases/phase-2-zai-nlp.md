# Phase 2 — Z.ai glm-4.6 NLP Swap

> Status: ☐ Not started
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

_Record latency observations, prompt-tuning notes, and any commands that needed prompt fixes._
