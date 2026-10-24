# Phase 4.2 — Smart Home: WiZ Lights on the Kindle + Telegram

> Status: 🚧 In progress (2026-10-24 — plan locked, implementation started)
> Decisions locked with owner (2026-10-24): **1 bulb now, multi-bulb-ready** (schema/UI take N bulbs,
> Telegram name-matches); **full control set** (ON/OFF, brightness steps, warm/cool white, color
> presets incl. night light; scenes deferred); **2–5 s Telegram→light latency via the command queue
> accepted**.
> Note: the fork parent left a `phase-5-smartthings.md`; that SmartThings phase was never executed in
> this fork. This phase supersedes it here and stays in the 4.x series.
> Gate: done only when (a) the Kindle screen shows the bulb's live state and toggles it via UDP,
> (b) "lights off" in Telegram turns the light off within a few seconds, (c) brightness/color/temperature
> work from both surfaces, (d) a powered-off bulb shows OFFLINE without crashing anything.

## Goal

- New Kindle screen **LIGHTS**: one card per bulb with live state + ON/OFF toggle, brightness steps,
  warm/cool white, and color presets. No phone app needed for everyday control.
- Telegram: `lights on` / `lights off` / `dim lights to 50` / `lights warm white` / `lights blue` /
  `night light` / `bedroom light off` (name-matched when several bulbs exist).
- First device: one Philips WiZ bulb; the design supports multiple bulbs.

## How WiZ control works (researched)

WiZ bulbs speak a **local UDP JSON protocol on port 38899** — the same protocol the official app uses
on the LAN, documented by the community (pywizlight, Home Assistant's integration):

- `{"method":"getPilot"}` → current state: `{"result":{"state":true,"brightness":50,"temp":3100,...}}`
- `{"method":"setPilot","params":{"state":false}}` / `{"state":true,"brightness":80}` /
  `{"temp":2700}` / `{"r":255,"g":0,"b":0}` / `{"sceneId":...}` → bulb replies `{"result":{"succeeded":true}}`
- `{"method":"getSystemConfig"}` → friendly name + MAC (for multi-bulb discovery)
- LAN-only: no official cloud API. Nothing leaves the house.

## Architecture decision (the key constraint)

InsForge edge functions run in the cloud and **cannot reach a device behind home NAT**. The Kindle is
already on the same Wi-Fi as the bulb, so:

```
Telegram msg ──► telegram-webhook (cloud) ──► device_commands row (DB)
                                                  │ SSE hash change (existing stream, ~2s)
Kindle (LAN) ── UDP 38899 setPilot ──► BULB ◄──┘ device sees pending command,
        │                                          fetches it, executes, acks
        └── POST ack (cloud) ──► row marked done
```

- **Kindle = actuator.** On/off/brightness/color are one UDP packet, sub-100 ms on the device screen.
- **Telegram → light** rides the existing SSE stream (kindle-dashboard-events): its version hash
  starts counting *pending device commands*, so the Kindle learns about a command in ~2–4 s total.
  No new polling (CLAUDE.md guardrail respected — SSE stays DB-only).
- **Device screen → light** is direct UDP; the cloud is not in the loop at all.

## 1. Backend (small)

### `migrations/20261024000000-device-commands.sql` (+ bootstrap list)

```sql
CREATE TABLE IF NOT EXISTS device_commands (
  id          TEXT PRIMARY KEY,                 -- crypto.randomUUID
  target      TEXT NOT NULL DEFAULT 'all',      -- bulb name hint ('all' = every bulb)
  action      JSONB NOT NULL,                   -- setPilot params {"state":false,...}
  source      TEXT NOT NULL DEFAULT 'telegram',
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at TIMESTAMPTZ
);
ALTER TABLE device_commands ENABLE ROW LEVEL SECURITY;
```

One-shot rows: executed and acked once, then pruned by the existing nightly `planner-cleanup`
(extend it to delete rows older than 1 day).

### `functions/kindle-device-queue.ts` (new)

- `GET` (DASHBOARD_READ_TOKEN auth): pending commands (≤5, oldest first) as
  `{commands:[{id,target,action}]}`.
- `POST` (same auth): `{id, ok}` → mark done/failed + `executed_at`.
- Extend `kindle-dashboard-events.ts` version hash with the pending-command count → the SSE nudge.

### `functions/telegram-webhook.ts`

- `DeviceAction { kind:"device", action:"set", target, state?, brightness?, temp?, color?, scene? }`
  + validator; applier writes a `device_commands` row and replies
  `💡 lights → off` / `💡 bedroom → 50% warm white`. Reply is an ACK OF INTENT (the actual bulb
  result lands via the Kindle; a bulb that is offline is reported on the screen, not in chat).
- LLM prompt lines (kind:"device", the surfaces it covers, target = bulb name substring or "all")
  + deterministic fallback patterns (`lights on/off`, `dim lights to N`, `lights <color/temp>`,
  `night light`).
- Clarify preserved: `light` with no verb/target stays LLM-routed; unknown phrasing → clarify, never
  a guessed toggle (this switches physical hardware — wrong guesses are worse than a question).

## 2. Kindle C++

- `WizLight { ip[16], mac[18], name[32], state, brightness, temp, r,g,b, scene, online }` + a small
  UDP client (send JSON, await reply, 1 s timeout). Discovery at screen-open: broadcast
  `{"method":"registration"}` on 255.255.255.255:38899, collect responders, merge with the cached
  list in `/mnt/us/documents/kindle-dashboard-wiz.json` (survives reboots; bulbs keep their IP via
  router DHCP reservation — documented fallback if broadcast is blocked).
- **LIGHTS screen** (`g_active_screen` 4; opened from a header button like PREGNANCY/TIMELINE):
  per bulb card — name + live state line (`ON 80% WARM`), buttons: ON/OFF toggle, `25/50/75/100%`
  brightness row, `WARM / COOL` white row, color presets row (`WHITE RED GREEN BLUE NIGHT`).
  Tap → optimistic state drawn instantly, UDP fires, `getPilot` refresh reconciles; offline bulb
  renders `OFFLINE - CHECK BULB` and disables nothing (retry on tap).
- Command executor: on SSE version change (command pending), fetch queue → for each command match
  target bulb (name hint) → UDP setPilot → ack. Runs in the main loop between renders (bounded work,
  no busy loops).
- Zero new egress beyond the existing hourly fetch + SSE pattern (ack posts are ~200 bytes each).

## 3. Fixture + tests

- Fixture: `lights: [{name, state, brightness, temp, online}]`-style status payload for rendering the
  screen from static data (the live screen reads UDP directly; the fixture only feeds renders/tests).
- `telegram-webhook.test.ts`: device parser table (on/off/dim/colors/scenes/night light/name targets),
  validator (brightness 1–100 clamp, color enum), applier reply strings, mutation-guard precedence,
  clarify on ambiguous light messages.
- `kindle-device-queue` pure helpers (row → params merge) if any.
- `scripts/test-phase0.mjs`: LIGHTS view renders non-blank at both resolutions; offline bulb renders.

## 4. Implementation order

1. Migration + bootstrap list → apply live
2. `kindle-device-queue.ts` + events-hash extension → deploy
3. Webhook device actions + prompt + tests → deploy
4. C++: UDP client, discovery + cache, LIGHTS screen, SSE command executor → `npm test` + renders
5. Device deploy (stop → scp → chmod → once-light → start-light)
6. E2E on the real bulb: screen toggle/dim/colors; Telegram `lights off` → light off ≤ ~5 s;
   bulb unplugged → OFFLINE renders
7. Usage check + usage-history row → docs (FORK_NOTES + this file status) → commit + push

## 5. Verification

- Telegram `lights off` → SSE nudge → device executes: lamp visibly off within ~2–5 s (webhook 1 call
  + SSE tick + 1 UDP packet + 1 ack post).
- Screen toggle → instant (UDP, no cloud hop).
- `getPilot` on an unreachable IP times out (1 s) → OFFLINE state, no crash, next tap retries.
- Budget: per Telegram command = 1 fn call + 1 ack call; screen use = zero fn calls (pure LAN).

## 6. Guardrails

- No new cron, no polling loops (SSE piggybacks the existing stream); all timeouts ≤ 2 s for UDP,
  8–10 s for HTTP per CLAUDE.md.
- `device_commands` is the only new table (~tens of bytes/row, pruned nightly).
- The bulb API never touches the internet; no WiZ cloud account, no new secrets (reuses
  DASHBOARD_READ_TOKEN; TELEGRAM_WEBHOOK_SECRET unchanged).

## Rollback

Device: restore `.bak` binary. Backend: revert + redeploy; `device_commands` stays inert. The LIGHTS
screen disappears; Telegram light phrasings degrade to clarify/none.

## Risks / notes

- **Broadcast/multicast on Kindle Wi-Fi**: if the router isolates clients or blocks broadcast,
  discovery falls back to the cached/configured bulb IP (DHCP reservation on the router). Unicast
  control always works once the IP is known.
- **2.4/5 GHz**: bulb is 2.4 GHz-only; the Kindle must be on the same bridged subnet (it is, same SSID).
- Multiple bulbs later: same screen, N cards (cap ~4 on PW5), Telegram name matching already designed.
- Future devices (plug, sensor): the queue schema is device-agnostic (`action` JSONB) — new device
  types only add C++ actuators + parser lines.
