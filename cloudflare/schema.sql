-- D1 database webtv-db (binding DB). Applied 2026-11-17.
CREATE TABLE IF NOT EXISTS votes (cc TEXT NOT NULL, ch TEXT NOT NULL, day INTEGER NOT NULL, who TEXT NOT NULL, ok INTEGER NOT NULL, PRIMARY KEY (cc, ch, day, who));
CREATE INDEX IF NOT EXISTS votes_cc_day ON votes (cc, day);
-- email reminders: double opt-in; marketing consent is separate, optional and recorded with its exact wording
CREATE TABLE IF NOT EXISTS subscribers (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE, tz TEXT, cc TEXT, marketing INTEGER NOT NULL DEFAULT 0, consent_text TEXT, consent_version TEXT, consent_at INTEGER, consent_ip TEXT, created_at INTEGER NOT NULL, confirm_sent_at INTEGER, confirmed_at INTEGER, unsubscribed_at INTEGER, marketing_withdrawn_at INTEGER);
CREATE TABLE IF NOT EXISTS email_reminders (id TEXT PRIMARY KEY, sub_id TEXT NOT NULL, ch TEXT NOT NULL, ch_name TEXT, title TEXT NOT NULL, start INTEGER NOT NULL, url TEXT, created_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE (sub_id, ch, start));
CREATE INDEX IF NOT EXISTS rem_due ON email_reminders (sent_at, start);
CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, day INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL);
