-- Phase 3.1: grocery sublists. planner_items.store groups grocery items by shop:
-- 'ah' (Albert Heijn), 'turkish' (Turkish market), 'indian' (Indian grocery store).
-- Non-grocery rows keep NULL. Existing grocery rows default to 'ah'.
ALTER TABLE planner_items ADD COLUMN IF NOT EXISTS store TEXT;
UPDATE planner_items SET store = 'ah' WHERE list_key = 'grocery' AND store IS NULL;
