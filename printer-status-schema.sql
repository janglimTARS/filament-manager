CREATE TABLE IF NOT EXISTS printer_status (
  id TEXT PRIMARY KEY DEFAULT 'default',
  state TEXT DEFAULT 'offline',
  nozzle_temp REAL DEFAULT 0,
  nozzle_target REAL DEFAULT 0,
  bed_temp REAL DEFAULT 0,
  bed_target REAL DEFAULT 0,
  chamber_temp REAL DEFAULT 0,
  progress INTEGER DEFAULT 0,
  remaining_minutes INTEGER DEFAULT 0,
  current_file TEXT DEFAULT '',
  current_layer INTEGER DEFAULT 0,
  total_layers INTEGER DEFAULT 0,
  fan_speed INTEGER DEFAULT 0,
  errors TEXT DEFAULT '[]',
  ams_data TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);
