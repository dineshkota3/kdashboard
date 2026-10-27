# CLAUDE.md

Kindle Dashboard — e-ink family dashboard (Kindle PW5 + InsForge backend + Telegram bot).
Backend/API conventions live in [AGENTS.md](AGENTS.md). Per-phase history lives in [docs/phases/](docs/phases/).

## Privacy & secrets — nothing personal in git (hard rule)

No secrets, keys, tokens, IDs, usernames, emails, phone numbers, or ANY personally
identifiable information (PII) may ever be committed to git — not in code, docs,
phase logs, fixtures, test data, scripts, or commit messages. This repo is public.

- Credentials live ONLY in InsForge secrets (CLI) or a local git-ignored `.env`.
- When writing docs or results logs, use placeholders: `<owner chat id>`,
  `your-project.insforge.app`, `a-long-random-token`. Name secrets, never quote values.
- This is enforced practice, not theory: personal email, LAN IP, and the owner's
  chat id were all scrubbed from phase logs (commits `caac1ef`, `22319ae`).
- Before committing anything generated (logs, JSON dumps, command output), scan it
  for PII first. If PII lands in a commit, scrub it in a follow-up commit; rewrite
  history only if the owner asks.

## InsForge free-tier guardrails (read before ANY backend change)

The backend runs on the InsForge **free plan**. Limits reset monthly (cycle: 8th → 7th).
Any change you make must not burn through limits in a short time. Full numbers, usage
history, and rationale: [docs/resources/insforge-limits.md](docs/resources/insforge-limits.md).

| Metric | Free limit | Biggest movers in this repo |
|---|---|---|
| Edge function calls | 100,000 / mo | Kindle hourly fetch, Telegram webhooks, token refreshes |
| Bandwidth (egress) | 5 GB / mo | dashboard payloads + SSE |
| Database | 500 MB | planner/health/challenge rows |
| AI gateway credits | $1 / mo | must stay $0 — the app uses Z.ai directly, never the InsForge gateway |

Hard rules:
- **NEVER do polling or any pattern that increases InsForge function-call/egress/DB usage** - check `npx -y @insforge/cli usage` BEFORE implementing anything, and re-check right after deploying. Prefer event-driven designs (SSE + DB writes on change) over timers; every new recurring call must be justified in the phase doc with a per-month estimate.
- No polling loops / retry storms against functions; keep every outbound fetch's `AbortSignal.timeout(8-10s)`.
- Kindle refresh stays hourly (`INTERVAL=3600`); SSE (`kindle-dashboard-events.ts`) stays DB-only — no outbound API calls, ever.
- Batch DB writes; no new cron schedules more frequent than hourly without asking.

## Usage check protocol

Check InsForge usage **after every implementation that touches functions/DB/storage,
and whenever asked**:

```sh
npx -y @insforge/cli usage            # per-metric usage for the current cycle
npx -y @insforge/cli billing cycles   # when the current cycle resets
```

Compare against the table above and the latest snapshot in
[docs/resources/insforge-limits.md](docs/resources/insforge-limits.md) — if the pace
projects past ~50% of any limit, say so and stop before deploying more. Append a row
to the usage-history table there when you check.
