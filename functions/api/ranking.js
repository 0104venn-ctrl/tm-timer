// TM Timer world ranking API (Cloudflare Pages Functions + D1)
//   GET  /api/ranking?id=<uuid>&period=day|week|month
//                                              top 20 people with 2+ hours in the period (UTC), country ranking, and my standing.
//                                              week = Monday to today, month = the 1st to today
//   POST /api/ranking {id, name, start: true}   timer started (start time recorded on the server clock)
//   POST /api/ranking {id, name, minutes}       focus minutes since then, sent on pause / phase end / page close (0 = rename only)
//
// Anti-cheat: a user is never credited more than the time that actually elapsed since their last record,
// at most 180 minutes per report and 960 minutes (16 h) per day.

const MAX_SESSION = 180;
const MAX_DAY = 960;
const QUALIFY = 120;   // minimum focus minutes to appear in the ranking
const TOP = 20;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return n && [...n].length <= 16 ? n : null;
}

async function myStanding(db, day, id) {
  const row = await db.prepare('SELECT minutes, sessions FROM daily WHERE day = ? AND id = ?').bind(day, id).first();
  if (!row) return { minutes: 0, sessions: 0, rank: null };
  const ahead = await db.prepare('SELECT COUNT(*) AS n FROM daily WHERE day = ? AND minutes > ?').bind(day, row.minutes).first();
  return { minutes: row.minutes, sessions: row.sessions, rank: ahead.n + 1 };
}

const DAY_MS = 86400000;
const PERIODS = ['day', 'week', 'month'];

// [from, to] UTC dates of the current period, and when the next one starts
function periodRange(period, now) {
  const today = Date.parse(utcDay(now) + 'T00:00:00Z');
  let from = today, next = today + DAY_MS;
  if (period === 'week') {
    const dow = (new Date(today).getUTCDay() + 6) % 7;   // Monday = 0
    from = today - dow * DAY_MS; next = from + 7 * DAY_MS;
  } else if (period === 'month') {
    const d = new Date(today);
    from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return { from: utcDay(from), to: utcDay(today), next };
}

// Per-user totals over the period
const PER = `WITH per AS (
  SELECT id, SUM(minutes) AS minutes, SUM(sessions) AS sessions, MAX(updated_at) AS last
    FROM daily WHERE day BETWEEN ? AND ? GROUP BY id)`;

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const now = Date.now();
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const period = PERIODS.includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'day';
  const { from, to, next } = periodRange(period, now);

  const top = await db.prepare(`${PER}
    SELECT u.name, u.country, p.minutes, p.sessions, (p.id = ?) AS mine
      FROM per p JOIN users u ON u.id = p.id
     WHERE p.minutes >= ?
     ORDER BY p.minutes DESC, p.last ASC
     LIMIT ?`).bind(from, to, id, QUALIFY, TOP).all();
  const countries = await db.prepare(`${PER}
    SELECT u.country, SUM(p.minutes) AS minutes, COUNT(*) AS people
      FROM per p JOIN users u ON u.id = p.id
     WHERE p.minutes >= ?
     GROUP BY u.country
     ORDER BY minutes DESC
     LIMIT ?`).bind(from, to, QUALIFY, TOP).all();
  const total = await db.prepare(`${PER}
    SELECT COUNT(*) AS people, COALESCE(SUM(minutes), 0) AS minutes FROM per WHERE minutes >= ?`).bind(from, to, QUALIFY).first();

  let me = null;
  if (ID_RE.test(id)) {
    const u = await db.prepare('SELECT name, country FROM users WHERE id = ?').bind(id).first();
    const row = await db.prepare(`${PER} SELECT minutes, sessions FROM per WHERE id = ?`).bind(from, to, id).first();
    const st = { minutes: row ? row.minutes : 0, sessions: row ? row.sessions : 0, rank: null };
    if (st.minutes >= QUALIFY) {
      const ahead = await db.prepare(`${PER} SELECT COUNT(*) AS n FROM per WHERE minutes > ?`).bind(from, to, st.minutes).first();
      st.rank = ahead.n + 1;
    }
    me = { ...st, name: u ? u.name : null, country: u ? u.country : (request.cf && request.cf.country) || null };
  }
  return json({ period, day: to, from, to, resetsInMs: next - now, qualify: QUALIFY, total, top: top.results, countries: countries.results, me });
}

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const id = String(body.id || '');
  const name = cleanName(body.name);
  const minutes = Number(body.minutes);
  if (!ID_RE.test(id)) return json({ error: 'bad_id' }, 400);
  if (!name) return json({ error: 'bad_name' }, 400);
  const isStart = body.start === true;
  if (!isStart && (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_SESSION)) return json({ error: 'bad_minutes' }, 400);

  const now = Date.now();
  const day = utcDay(now);
  const country = (request.cf && request.cf.country) || 'XX';
  const user = await db.prepare('SELECT last_at FROM users WHERE id = ?').bind(id).first();

  if (isStart) {   // timer start: the next report is capped by the time elapsed from now
    await db.prepare(
      `INSERT INTO users (id, name, country, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, country = excluded.country, last_at = excluded.last_at`).bind(id, name, country, now).run();
    return json({ ok: true, started: now });
  }

  if (minutes === 0) {   // rename only
    await db.prepare(
      `INSERT INTO users (id, name, country, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, country = excluded.country`).bind(id, name, country, now).run();
    return json({ ok: true, credited: 0, me: await myStanding(db, day, id) });
  }

  // never credit more than the real time since the last record (+1 min slack)
  const elapsed = user ? Math.floor((now - user.last_at) / 60000) + 1 : MAX_SESSION;
  const today = await db.prepare('SELECT minutes FROM daily WHERE day = ? AND id = ?').bind(day, id).first();
  const room = MAX_DAY - (today ? today.minutes : 0);
  const credited = Math.max(0, Math.min(minutes, elapsed, room));
  if (credited < 1) return json({ error: 'too_soon', me: await myStanding(db, day, id) }, 429);

  await db.batch([
    db.prepare(
      `INSERT INTO users (id, name, country, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, country = excluded.country, last_at = excluded.last_at`).bind(id, name, country, now),
    db.prepare(
      `INSERT INTO daily (day, id, minutes, sessions, updated_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(day, id) DO UPDATE SET minutes = minutes + excluded.minutes, sessions = sessions + 1, updated_at = excluded.updated_at`).bind(day, id, credited, now)
  ]);
  return json({ ok: true, credited, me: await myStanding(db, day, id) });
}
