-- Phase 4 final: pregnancy care checklist (NL-standard week-by-week).
-- Seeded from Dutch care standards (verloskundige basispakket, PNS screening,
-- Rijksvaccinatieprogramma, kraamzorg advice). due_week drives the dashboard's
-- DO NOW section and Telegram listing; done/done_at is the Telegram check-off
-- state. Dates are derived from PREGNANCY_DUE_DATE at read time, not stored.
CREATE TABLE IF NOT EXISTS pregnancy_tasks (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  detail TEXT,
  due_week INT NOT NULL,
  category TEXT NOT NULL DEFAULT 'CARE',
  done BOOLEAN NOT NULL DEFAULT FALSE,
  done_at TIMESTAMPTZ
);

INSERT INTO pregnancy_tasks (key, label, detail, due_week, category) VALUES
  ('intake',         'Verloskundige intake + bloods',            'Hb, blood group/Rhesus, HIV, syfilis, rubella, glucose-if-risk', 8,  'MED'),
  ('supplements',    'Start foliumzuur 0.5 mg + vitamine D daily', 'Foliumzuur stops at week 10; vitamine D continues throughout', 8,  'HABIT'),
  ('insurance',      'Check insurance: verloskundige + kraamzorg coverage', 'Basisverzekering covers; kraamzorg eigen bijdrage ~5.80/hr', 8, 'ADMIN'),
  ('termijnecho',    'Termijnecho (dating scan)',                '10-12w; confirms the due date', 12, 'MED'),
  ('nipt_decision',  'NIPT counseling + decision',               'Optional; free (national subsidy); from 11w', 12, 'MED'),
  ('echo_13w',       '13-week echo (optional)',                  'Free; covered by national subsidy', 13, 'MED'),
  ('kraamzorg',      'Book kraamzorg',                           'From 12w; latest by 20w; max 49h/8d insured', 16, 'ADMIN'),
  ('announce_work',  'Announce pregnancy at work',               'Legal: at least 3 wks before leave starts (16 wks total)', 17, 'ADMIN'),
  ('book_20w_echo',  'Book 20-week anomaly echo',                'Scan window 18-21w; free', 15, 'ADMIN'),
  ('echo_20w',       '20-week anomaly echo',                     'Checks organs + development; free', 20, 'MED'),
  ('kraamzorg_deadline', 'Kraamzorg absolute deadline',          'If not booked yet: call today', 20, 'ADMIN'),
  ('kinkhoest',      'Kinkhoest (DKT) vaccination at GGD',       'From 22w; free; every pregnancy; book via JGZ/GGD', 23, 'MED'),
  ('checkup_24w',    'Longer checkup + glucose/risk discussion', 'Fundal height; GDM screening if risk factors', 24, 'MED'),
  ('prenatal_course','Start prenatal course (optional)',         'Some aanvullende insurers reimburse', 26, 'PREP'),
  ('t3_nutrition',   'Trimester 3 nutrition shift',              'Extra protein; small frequent portions; oily fish 1x/wk', 28, 'HABIT'),
  ('birth_location', 'Register at birth location + leave paperwork', 'Home/polis/hospital policy choice; zwangerschapsverklaring', 30, 'ADMIN'),
  ('baby_essentials','Baby essentials: car seat, cot, pram, clothes', '', 32, 'PREP'),
  ('jgz_check',      'Check JGZ/consultatiebureau referral',     'Auto after birth; RSV injection (nirsevimab) offered in season', 33, 'ADMIN'),
  ('hospital_bag',   'Hospital bag started',                     '', 34, 'PREP'),
  ('gbs_swab',       'GBS swab / discussion',                    '35-36w via verloskundige', 35, 'MED'),
  ('weekly_controles','Weekly controles from now',               'Full term at 37w; after 40w checks every 2-3 days', 36, 'MED'),
  ('car_seat',       'Car seat installed + bag complete',        '', 36, 'PREP'),
  ('geboorte_plan',  'Geboorteaangifte plan + partner leave schedule', 'Aangifte within 3 workdays; partner 1 wk + 5 wks geboorteverlof', 38, 'ADMIN'),
  ('due_date',       'Due date - Apr 01 2027',                   '', 40, 'MED')
ON CONFLICT (key) DO NOTHING;
