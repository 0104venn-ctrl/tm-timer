-- TM Timer world ranking database (Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  id       TEXT PRIMARY KEY,   -- random UUID generated per browser
  name     TEXT NOT NULL,      -- nickname (max 16 chars)
  country  TEXT NOT NULL,      -- country code from Cloudflare geolocation (KR, US ...)
  last_at  INTEGER NOT NULL    -- time of the last record (ms)
);

CREATE TABLE IF NOT EXISTS daily (
  day        TEXT NOT NULL,    -- UTC date YYYY-MM-DD
  id         TEXT NOT NULL,
  minutes    INTEGER NOT NULL,
  sessions   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, id)
);

CREATE INDEX IF NOT EXISTS idx_daily_rank ON daily (day, minutes DESC);
