# InsForge Free-Tier Limits — Reference

> Owner-facing reference for the kindle-dashboard InsForge project (`eq8jq3jz.us-east.insforge.app`, org "Personal Org", plan: free).
> CLAUDE.md carries the short guardrails; this file carries the numbers, the check commands, and the usage history.
> Checked against insforge.dev/pricing on 2026-10-11 — re-verify if InsForge announces plan changes.

## Free plan limits (per billing month)

| Metric | Free limit | Notes |
|---|---|---|
| Edge function calls | **100,000 / mo** | Raised from 10,000 in June 2026. Main mover in this project. |
| Bandwidth (egress) | **5 GB / mo** | Payload fetches + SSE. Second mover. |
| Database size | **500 MB** | Tiny rows here; non-issue unless logs/rows accumulate. |
| File storage | **1 GB** | Unused today (0 B). |
| Monthly active users | 50,000 | Irrelevant at n=2. |
| AI gateway credits | **$1 / mo** | Unused — the app calls Z.ai directly, NOT the InsForge AI gateway. Keep it that way. |
| Build minutes | 600 min / mo | Site deploys only; none today. |
| Custom compute | 120 h / mo | Unused today. |

**Billing cycle: 8th → 7th of each month** (usage resets on the 8th).
**Free projects pause after 1 week of inactivity** — this project self-pings hourly from the Kindle, so it stays warm; do not remove that traffic pattern.

## How to check usage

```sh
npx -y @insforge/cli usage            # org usage for the current billing period (per-metric + per-project)
npx -y @insforge/cli billing cycles   # current cycle window (reset date)
npx -y @insforge/cli billing status   # plan
npx -y @insforge/cli diagnose         # full backend health report
```

## Usage snapshot — 2026-10-11 (cycle 10/8 → 11/7, day 3 of 30)

| Metric | Used | Limit | % |
|---|---|---|---|
| function_calls | 1,130 | 100,000 | 1.1% |
| egress | 142.67 MB | 5 GB | 2.8% |
| database | 12.57 MB | 500 MB | 2.5% |
| storage | 0 B | 1 GB | 0% |
| ai_credits | $0 | $1 | 0% |

Extrapolated to a full cycle (~10x): ~11K calls, ~1.4 GB egress — comfortably inside the plan.

## What consumes what in this project

- **Kindle fetch**: 1 × `kindle-dashboard-data` per hour (config.sh `INTERVAL=3600`) + on-demand refreshes. ~7 KB payload each.
- **SSE**: `kindle-dashboard-events` holds a connection and polls the DB only (every 2 s, DB-local — no egress to speak of). **Never add outbound calls there.**
- **Calendar reminders cron**: `calendar-reminders` every 15 min = 96 calls/day ≈ **2,880 calls/mo (2.9% of budget)** — now the single largest consumer. Each tick = exactly 1 function call; the Google/Telegram/DB work inside is free. NEVER tighten the cron to 1-min (43K/mo = 43%).
- **Telegram webhooks**: per message — 1 webhook call + (booking) Google token refresh + calendar insert. Message volume is human-scale.
- **Token refreshes**: `google-calendar-oauth` + per-hour access-token refresh writes in dashboard-data.
- **Deploys**: function deploys are cheap; per-request calls are the budget.

## Guardrails (how changes can breach limits)

1. No polling loops or retry storms against functions; every outbound call keeps its `AbortSignal.timeout(8–10s)`.
2. Kindle refresh interval stays hourly — never lower `INTERVAL` in config.sh.
3. SSE stays DB-only — no Google/API calls in `kindle-dashboard-events.ts`.
4. Batch DB writes (`insert([...])`), no N+1 query patterns.
5. No new cron schedules firing more often than hourly without asking the owner.
6. Keep Z.ai direct (not the InsForge AI gateway) — the $1 credit stays untouched.

## Escalation thresholds

Investigate before deploying more if, mid-cycle:
- `function_calls` pace projects past ~50K (e.g. > 1,700/day sustained), or
- `egress` > ~2.5 GB at cycle end pace, or
- any single change adds > 1 call per Kindle-refresh-minute.

## Usage history

| Date | Cycle day | function_calls | egress | db | Notes |
|---|---|---|---|---|---|
| 2026-10-11 | 3 | 1,130 | 142.67 MB | 12.57 MB | Phase 3.1 deploy day; includes E2E webhook tests |
| 2026-10-15 | 7 | 1,853 | 226.04 MB | 12.96 MB | First cycle with the reminders cron (96 calls/day, the largest consumer). Pace ~181 calls/day + ~21 MB egress/day → projects to ~5.4% calls / ~13% egress at cycle end. No breach risk. |
| 2026-10-19 | 11 | 2,758 | 333.17 MB | 13.46 MB | Phase 4 pregnancy todos: deploys + webhook E2E (add/done/list). Pace ~226 calls/day + ~26 MB egress/day → ~7% calls / ~16% egress at cycle end. No breach risk. |
| 2026-10-19 | 11 | 2,905 | 335 MB | 13.5 MB | Phase 4.1 scheduled chores: 4 deploys + E2E + new 30-min chore-reminders cron (48/day = ~1,488/mo owner-sanctioned). Pace ~275 calls/day → ~9% calls at cycle end. No breach risk. |
| 2026-10-20 | 12 | 3,135 | 340 MB | 13.5 MB | Phase 4.1 hardening: LLM-first routing + clarify, day-aware chores queries; 3 webhook deploys + E2E. Pace ~260 calls/day incl. the chore cron → ~8% calls at cycle end. No breach risk. |
| 2026-10-24 | 16 | 3,695 | 345 MB | 13.5 MB | Phase 4.2 WiZ lights: migration + 4 deploys + tests (device install pending). Light commands ≈ 2 calls each, negligible. No breach risk. |
