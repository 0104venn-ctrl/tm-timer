-- TM Timer 세계 순위 DB (Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  id       TEXT PRIMARY KEY,   -- 브라우저마다 만들어지는 무작위 UUID
  name     TEXT NOT NULL,      -- 닉네임 (최대 16자)
  country  TEXT NOT NULL,      -- Cloudflare 가 알려주는 접속 국가 코드 (KR, US ...)
  last_at  INTEGER NOT NULL    -- 마지막 기록 시각 (ms)
);

CREATE TABLE IF NOT EXISTS daily (
  day        TEXT NOT NULL,    -- UTC 날짜 YYYY-MM-DD
  id         TEXT NOT NULL,
  minutes    INTEGER NOT NULL,
  sessions   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, id)
);

CREATE INDEX IF NOT EXISTS idx_daily_rank ON daily (day, minutes DESC);
