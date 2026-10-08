# Phase 1 — Kindle Display on PW5 (KUAL Next + Zig Cross-Compile)

> Status: ☐ Not started
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

_Record battery readings, which ABI ladder step worked, and any deviations._
