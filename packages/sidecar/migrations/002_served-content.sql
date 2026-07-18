-- Delta engine: retain the last served content per (session, path) so a
-- changed file can be served as a unified diff against the previous serve.
ALTER TABLE served_files ADD COLUMN content TEXT NOT NULL DEFAULT '';
