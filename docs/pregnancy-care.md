# Pregnancy Care Reference — Netherlands Standards (Keethu, due Apr 1 2027)

> Informational summary of the standard Dutch pregnancy care path, compiled from
> deverloskundige.nl, pns.nl, rijksvaccinatieprogramma.nl, Voedingscentrum.nl, Zorginstituut Nederland
> and Rijksoverheid.nl (Oct 2026). **Your verloskundige's individual schedule always prevails — this is
> not medical advice.** The dashboard's pregnancy screens are generated from the due date in the
> `PREGNANCY_DUE_DATE` secret; care-task check-off happens via Telegram (`tasks`, `kraamzorg done`).

## Care providers (who does what)

| Provider | Role |
|---|---|
| **Verloskundige** (midwife) | Primary care for low-risk pregnancies: checkups, scans referral, bloods, birth at home/polis/hospital |
| **Gynaecoloog** (hospital) | Takes over for high-risk/medical indications; referred by the verloskundige |
| **Kraamzorg** | Postpartum home care: first 8–10 days, monitoring + breastfeeding help + household |
| **GGD / JGZ (consultatiebureau)** | Whooping-cough vaccination for the pregnant person (22w+); after birth: baby checkups, RSV injection, vitamin K drops guidance |
| **Huisarts** | General fallback + registration point |

## The standard schedule (mapped to gestational weeks)

| Week | What happens | Insurance |
|---|---|---|
| 8–10 | Verloskundige **intake** + blood panel (Hb/iron, blood group + Rhesus, HIV, syfilis, rubella immunity; glucose only with risk factors) | Basic insurance |
| — | **Foliumzuur 0.4–0.5 mg/day** until week 10; start **vitamine D 10 µg/day** (continues throughout + while breastfeeding) | OTC |
| 10–12 | **Termijnecho** (dating scan) — confirms the due date | Basic insurance |
| 11–14 | **NIPT counseling + test** (optional) — free via national subsidy; does NOT count against your eigen risico | Subsidy |
| 12–14 | **13-wekenecho** (optional, free via subsidy) | Subsidy |
| 12–16 | **Aanmelden kraamzorg** — from 12 weeks possible; **at the latest by week 20**. Basisverzekering: min 24 h, max 49 h over 8 days (medical indication can extend); eigen bijdrage ~€4.80–5.80/hr | Basic + eigen bijdrage |
| 16–20 | **Zwangerschapsverklaring to employer** — legally notify ≥3 weeks before leave starts (leave = 16 weeks total, starts 4–6 weeks before due date) | — |
| 18–21 | **20-wekenecho** (anomaly scan) — free via subsidy; checks organs + development | Subsidy |
| 22–34 | **Kinkhoest (DKT) vaccination** — from week 22; free; via GGD/JGZ; every pregnancy (protects the newborn) | Free |
| 24–28 | Longer checkups; **glucose screening** if risk factors (GDM); ask about **prenatal courses** (aanvullende insurers sometimes reimburse) | Varies |
| ~30 | Register at the birth location (if hospital/polis birth); finalize maternity-leave paperwork | — |
| 28–36 | Checkups every ~2 weeks; growth monitoring | Basic |
| 35–36 | **GBS swab / discussion** (group B strep; decision-aid based in NL) | Basic |
| 36 | Weekly checkups from here; **full term at 37** | Basic |
| 37–40 | Weekly; after 40 weeks: monitoring every 2–3 days to week 42 | Basic |
| Birth | **Geboorteaangifte at the gemeente within 3 workdays**; partner: 1 week birth leave (full pay) + 5 weeks extra geboorteverlof (70% via UWV) | — |
| After birth | **Consultatiebureau (JGZ)** visits auto-referred; newborn **vitamine K drops**; **RSV injection (nirsevimab)** offered via JGZ for babies born ≥ Apr 2025, in season; heel-prick + hearing screening (~1 week) | Free |

## Supplements & nutrition (Voedingscentrum)

**Supplements**
- Foliumzuur 0.4–0.5 mg/day: from 4 weeks before conception until week 10
- Vitamine D 10 µg/day: entire pregnancy + breastfeeding period
- A pregnancy multivitamin is an alternative (don't double-dose foliumzuur/vit D)
- Iron only when a blood test shows low Hb (checked at intake; not automatic)
- Jodium: use iodized salt

**Food rules**
- **No alcohol at all** — no safe amount
- **Caffeine ≤ 200 mg/day** (~2–3 cups coffee)
- Avoid: raw/undercooked meat, raw fish (sushi/salmon sashimi), raw-milk soft cheeses, liver (vitamin A)
- Wash vegetables/fruit well (toxoplasmosis)
- Fatty fish 1×/week (omega-3); avoid high-mercury fish (tuna/marlin/swordfish daily)
- Trimester focus: T1 small portions (nausea) · T2 protein + iron (pair with vitamin C) + calcium ·
  T3 extra protein, small frequent meals
- The dashboard's "NUTRITION THIS WEEK" strip mirrors this per week

## Checklist on the dashboard (mirrors `pregnancy_tasks`)

Check via Telegram: `tasks` (list), `kraamzorg done` (fuzzy-marks done), `nutrition` (this week's guidance).
The full seeded list lives in `migrations/20261017020000_pregnancy-tasks.sql`.

## Google Health note

The Google Health API (successor to Fitbit Web API) exposes **only Fitbit/Pixel device data** —
Apple-Health-synced data is app-visible but not API-readable, and the Google Fit API sunsets end-2026.
That is why this dashboard does not sync health *metrics*; the pregnancy tracker is date-driven instead.
