CREATE TABLE IF NOT EXISTS print_events (
  id TEXT PRIMARY KEY,
  file_name TEXT DEFAULT '',
  active_tray INTEGER DEFAULT -1,
  spool_id TEXT DEFAULT '',
  filament_used_g REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  completed_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT DEFAULT ''
);
