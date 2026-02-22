CREATE TABLE IF NOT EXISTS spools (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  color_name TEXT NOT NULL,
  color_hex TEXT DEFAULT '#ffffff',
  material TEXT NOT NULL DEFAULT 'PLA',
  diameter REAL DEFAULT 1.75,
  total_weight REAL NOT NULL,
  remaining_weight REAL NOT NULL,
  location TEXT DEFAULT '',
  purchase_date TEXT DEFAULT '',
  cost REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS storage_locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS printer_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  ip TEXT DEFAULT '',
  token TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
