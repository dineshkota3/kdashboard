CREATE TABLE IF NOT EXISTS planner_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE CHECK (key IN ('grocery', 'workout', 'todo')),
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planner_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_key TEXT NOT NULL REFERENCES planner_lists(key) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  done BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS planner_items_list_done_created_idx
  ON planner_items (list_key, done, created_at);

DROP TRIGGER IF EXISTS planner_lists_updated_at ON planner_lists;
CREATE TRIGGER planner_lists_updated_at
  BEFORE UPDATE ON planner_lists
  FOR EACH ROW
  EXECUTE FUNCTION system.update_updated_at();

DROP TRIGGER IF EXISTS planner_items_updated_at ON planner_items;
CREATE TRIGGER planner_items_updated_at
  BEFORE UPDATE ON planner_items
  FOR EACH ROW
  EXECUTE FUNCTION system.update_updated_at();

INSERT INTO planner_lists (key, title, sort_order)
VALUES
  ('grocery', 'Grocery list', 1),
  ('workout', 'Workout Plan', 2),
  ('todo', 'Todo List', 3)
ON CONFLICT (key) DO UPDATE
SET title = EXCLUDED.title,
    sort_order = EXCLUDED.sort_order;
