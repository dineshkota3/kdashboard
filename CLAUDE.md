# CLAUDE.md

Kindle Dashboard — e-ink family dashboard (Kindle PW5 + InsForge backend + Telegram bot).
Backend/API conventions live in [AGENTS.md](AGENTS.md). Per-phase history lives in [docs/phases/](docs/phases/).

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
