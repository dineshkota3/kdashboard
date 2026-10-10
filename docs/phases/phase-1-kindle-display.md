# Phase 1 — Kindle Display on PW5 (KUAL Next + Zig Cross-Compile)

> Status: ◐ In progress (render + SSE verified on device 2026-10-10; 24h battery test running, results due 2026-10-11)
> Gate: Phase 2 starts only after the dashboard renders on the Kindle and survives a 24 h battery check.

## Goal

The Phase-0 dashboard renders natively on the Paperwhite 11th gen (1236×1648, fw 5.18.6) from the InsForge backend — on-demand refresh, hourly auto-refresh, SSE push on Telegram updates, and a battery-friendly overnight sleep window.

## 0. Device prep (one-time)

Firmware 5.16.3+ requires **KUAL Next** (classic KUAL is broken on these firmwares). The jailbreak is already done.

1. Follow https://kindlemodging.org (kindlemodding wiki) post-jailbreak pages: install **MRPI**, then **KUAL Next**.
   - KUAL Next loads standard `config.xml` + `menu.json` extensions — exactly what `kindle/kual/kindle-dashboard/` ships.
   - Note: after any future Amazon firmware update, MRPI/KUAL Next typically need reinstallation.
2. Confirm you see the KUAL launcher entry on the Kindle home screen.
3. Decide file-transfer route for this phase: **USB** (fine for install) and optionally **USBNetwork** (SSH — makes iterating much faster; see kindlemodding wiki).

## 1. Build on the Mac

```sh
# Toolchain
brew install zig

# Sanity: native render check on macOS (fixture → PGM/PNG you can open)
npm run native:check

# Cross-compile + package the KUAL extension (default: static musl, arm-linux-musleabi)
make -C kindle/native extension-zig
# → build/kindle-dashboard-kual.tar.gz
```

`ZIG_TARGET` / `ZIG_MCPU` / `ZIG_LDFLAGS` are `?=` variables — overridable on the make command line (ABI ladder below).

## 2. Install on the Kindle

Either via USB mount (`/Volumes/Kindle`) or SSH (USBNetwork):

```sh
# USB route: extract into the visible extensions/ folder of the Kindle volume
tar -C /Volumes/Kindle/extensions -xzf kindle/native/build/kindle-dashboard-kual.tar.gz
# (SSH route: tar -C /mnt/us/extensions -xzf ... after scp)

# Or use the repo helper (writes config + shortcuts):
# DASHBOARD_DATA_URL=... DASHBOARD_READ_TOKEN=... npm run native:install
```

On the Kindle, create `kindle-dashboard/config.sh` next to the extension's `menu.json` (copy `config.sh.example`):

```sh
DASHBOARD_DATA_URL="https://<project>.insforge.app/functions/kindle-dashboard-data"
DASHBOARD_EVENTS_URL="https://<project>.function2.insforge.app/kindle-dashboard-events"
DASHBOARD_TOGGLE_URL="https://<project>.insforge.app/functions/kindle-dashboard-toggle"
DASHBOARD_READ_TOKEN="<DASHBOARD_READ_TOKEN>"
DASHBOARD_TOGGLE_TOKEN="<DASHBOARD_TOGGLE_TOKEN>"
INTERVAL="3600"
DASHBOARD_KEEP_AWAKE="1"
DASHBOARD_SLEEP_WINDOW="23:30-06:30"
DASHBOARD_TIMEZONE="Asia/Kolkata"
INVERT_IMAGES="0"
```

Note the SSE host is `function2.insforge.app` — the main gateway buffers SSE.

## 3. ABI ladder (only if the binary won't run)

Check `/mnt/us/documents/kindle-dashboard-native.log` for `Illegal instruction` or `Exec format error`, then escalate:

1. `make -C kindle/native extension-zig` (default soft-float static musl — usually works; ABI only matters at the EABI syscall boundary)
2. `make -C kindle/native extension-zig ZIG_TARGET=arm-linux-musleabihf ZIG_MCPU=generic+v7a`
3. `make -C kindle/native extension-zig ZIG_TARGET=arm-linux-gnueabihf ZIG_MCPU=generic+v7a`
4. Real cross-GCC: `make -C kindle/native extension KINDLE_CXX=/path/to/arm-linux-gnueabihf-g++`

Re-copy the tar.gz after each rebuild. `bin/proof.sh` and `bin/diagnose.sh` in the extension help isolate issues.

## 4. Verification

- [ ] KUAL → **Kindle Dashboard → Diagnostics**: firmware, free disk, and endpoint reachability look sane
- [ ] KUAL → **Refresh Once (Light)**: screen shows "DAILY OPS" header, STEPS/CALORIES gauges, Todo + Challenge (left), Workout + Grocery (right), status "live"
- [ ] Telegram `add battery test to todo` → Kindle re-renders within a few seconds (SSE push works)
- [ ] KUAL → **Start Dashboard (Light)** with the config above → device stays awake, refreshes hourly, sleeps 23:30–06:30
- [ ] `cat /mnt/us/documents/kindle-dashboard-data.json` on Kindle matches the backend payload
- [ ] **Battery test**: record battery % now; check after 24 h. Expect single-digit %/day with keep-awake + Wi-Fi wake-ups
- [ ] KUAL → **Stop Dashboard** → device returns to normal screensaver behavior

## 5. Rollback / fallback

- **Stop Dashboard** KUAL item always restores normal Kindle behavior (it kills the process, releases `preventScreenSaver`).
- Battery too hungry: set `DASHBOARD_KEEP_AWAKE="0"` — device sleeps normally; refreshes happen only while awake (screensaver keeps last image; hourly refresh still fires when in use).
- SSE never fires: hourly `INTERVAL` refresh still renders; debug `DASHBOARD_EVENTS_URL` host later without blocking.
- If keep-awake interferes with reading: only run **Refresh Once** on demand and keep the dashboard stopped.

## Tests

- **Local (must pass before packaging):** `npm test` — includes renderer smoke tests rendering every view at the PW5's 1236×1648 resolution with non-blank-output assertions. Add cases here if you touch the renderer: render with a fixture missing `workout` or `grocery` lists, and with `--invert-images`.
- **Extension script checks (on Kindle via SSH or KUAL):**
  - `bin/diagnose.sh` → firmware, disk, endpoint reachability all sane
  - `bin/proof.sh` → repo's own proof checks pass
  - `bin/once.sh` / `once-light.sh` / `once-dark.sh` → one refresh cycle each, exit 0, log shows `render=` success lines
  - `bin/start.sh` then `bin/stop.sh` → process pidfile created then removed; `preventScreenSaver` released after stop (`lipc-get-prop com.lab126.powerd getSimulatedSleepValue` or observable sleep behavior)
- **Data integrity:** `cat /mnt/us/documents/kindle-dashboard-data.json` matches `curl` of `kindle-dashboard-data` (same version hash)
- New on-device observations get recorded in the Results log; anything scriptable gets added to `scripts/test-phase1.mjs` (optional: device-over-SSH assertions).

## 6. Results log

- **2026-10-10 — Mac-side build complete** (zig 0.17.0 via Homebrew):
  - `npm run native:check` passes (binary builds + runs; `bitmap unavailable` expected on macOS — PW5-res render assertions live in `npm test`).
  - `make -C kindle/native extension-zig` built clean with default ABI ladder step 1 (`arm-linux-musleabi`, static musl, stripped).
  - Binary verified: `ELF 32-bit LSB executable, ARM, EABI5, statically linked, stripped`. Package: `kindle/native/build/kindle-dashboard-kual.tar.gz` (392K, includes config.sh.example, menu.json, PGM assets, all bin/ scripts).
  - Next: device prep (MRPI + KUAL Next), install via USB/SSH, create `config.sh`.
- **2026-10-10 — Extension installed + config written via USB:**
  - Package extracted to `/Volumes/Kindle/extensions/kindle-dashboard/`; `config.sh` created from example with live URLs (data/toggle on `eq8jq3jz.us-east.insforge.app`, events on `eq8jq3jz.function2.insforge.app`), tokens from InsForge secrets (read token verified → HTTP 200 from Mac), `INTERVAL=3600`, keep-awake on, sleep window `23:30-06:30`, tz `Asia/Kolkata`.
- **2026-10-10 — USBNetwork (USBNetLite) set up; remote access over Wi-Fi SSH:**
  - Installed `notmarek/kindle-usbnetlite` 1.0.M (`Update_usbnetlite_1.0.P_install_khf_11thgenplus.bin`) via `mrpackages` + `;log mrpi`.
  - Pre-staged dedicated SSH key (`~/.ssh/kindle_ed25519`) into `usbnetlite/etc/dropbear/authorized_keys` and set `ALLOW_PASSWORD_LOGIN="false"` **before** first enable — default `root/kindle` password auth never active on the network.
  - Kindle found on LAN at `<kindle-lan-ip>` (ping sweep + key-auth probe); pinned in `~/.ssh/config` as `Host kindle`. dropbear on :22, USE_WIFI=true.
  - **SSH at boot enabled** (2026-10-10 12:07, `/mnt/us/usbnetlite/auto` flag verified) — dropbear survives reboots.
- **2026-10-10 — ABI ladder step 1 runs on device; render + SSE verified:**
  - Zig-built static musl binary (soft-float `arm-linux-musleabi`) runs fine on PW5 fw 5.18.6 — no `Illegal instruction`, no ladder escalation needed.
  - Device: kernel 4.9.77-lab126, framebuffer `hwtcon_v2` 1236×1648 8bpp, touch on `/dev/input/event1`.
  - **Bug found + fixed:** `bin/diagnose.sh` did not pass `--read-token` to the native one-shot → its fetch always 401'd against the token-gated endpoint (unlike `dashboard.sh`, which passes it). Fixed in repo + deployed to device; re-run: `timing=fetch ok=1`, exit 0, cache 1034 bytes.
  - Visual render verified via saved PGM (converted to PNG): DAILY OPS header, LIVE status, STEPS/CALORIES gauges (targets 12,000 / 2,000 from backend), CHORES + 75-Day Challenge left, WORKOUT + GROCERY right — matches Phase-0 grid.
  - **SSE push verified E2E:** Telegram `add sse test to todo` → bot reply → log shows `events=planner refresh=1` → `refresh_now` → `timing=fetch ok=1` → framebuffer re-render → item visible in saved frame.
  - KUAL wrappers (start light/dark, once, stop) exercised by user earlier — all exit 0; touch tap → exit-to-home works.
- **2026-10-10 — Home grid reduced to Chores + Grocery (user preference):**
  - Removed the 75-Day Challenge tile and the Workout card from `drawBitmapDashboard`; home now = CHORES full-height left, GROCERY full-height right. Challenge screen/workout view code and backend payload untouched (reachable views reduced to chores/grocery from home; `drawChallengeTile` helper deleted to keep the warning-free build).
  - Rebuilt (zig, zero warnings), `npm test` green, deployed over SSH (md5 verified). Render confirmed visually.
  - **Gotcha:** `dashboard.sh` runs `pkill -f` on the binary path — never include the literal binary path in the same SSH command string as start/stop (kills your own session). Deploy = separate ssh calls: scp binary → chmod (own call) → `start-light.sh` (own call).
- **2026-10-10 — 24h battery test started:** baseline **99% at 11:44 EEDT**, dashboard running (start light), keep-awake on, hourly interval. Check ~2026-10-11 11:45 EEDT; expect single-digit %/day.
  - Note: periodic repaint ticks render from cache and save frames labelled `cached/offline` — cosmetic; event/manual renders show `live`.

