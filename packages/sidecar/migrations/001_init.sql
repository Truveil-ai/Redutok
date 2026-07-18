-- Redutok sidecar state store, initial schema.
-- Raw artifacts are retained per session so zoom never re-executes anything.
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  artifact_class TEXT NOT NULL,
  tool TEXT,
  created_at TEXT NOT NULL,
  raw TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  distilled TEXT,
  distilled_bytes INTEGER,
  profile TEXT,
  gates_passed INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts (session_id);

CREATE TABLE IF NOT EXISTS served_files (
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  served_at TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);

CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY,
  state_md TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit (session_id);
