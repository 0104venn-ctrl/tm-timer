// TM Timer world ranking API (Cloudflare Pages Functions + D1)
//   GET  /api/ranking?id=<uuid>                top 20 people with 2+ hours today (UTC), country ranking, and my standing
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

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const now = Date.now();
  const day = utcDay(now);
  const id = new URL(request.url).searchParams.get('id') || '';

  const top = await db.prepare(
    `SELECT u.name, u.country, d.minutes, d.sessions, (d.id = ?) AS mine
       FROM daily d JOIN users u ON u.id = d.id
      WHERE d.day = ? AND d.minutes >= ?
      ORDER BY d.minutes DESC, d.updated_at ASC
      LIMIT ?`).bind(id, day, QUALIFY, TOP).all();
  const countries = await db.prepare(
    `SELECT u.country, SUM(d.minutes) AS minutes, COUNT(*) AS people
       FROM daily d JOIN users u ON u.id = d.id
      WHERE d.day = ? AND d.minutes >= ?
      GROUP BY u.country
      ORDER BY minutes DESC
      LIMIT ?`).bind(day, QUALIFY, TOP).all();
  const total = await db.prepare('SELECT COUNT(*) AS people, COALESCE(SUM(minutes), 0) AS minutes FROM daily WHERE day = ? AND minutes >= ?').bind(day, QUALIFY).first();

  let me = null;
  if (ID_RE.test(id)) {
    const u = await db.prepare('SELECT name, country FROM users WHERE id = ?').bind(id).first();
    const st = await myStanding(db, day, id);
    if (st.minutes < QUALIFY) st.rank = null;
    me = { ...st, name: u ? u.name : null, country: u ? u.country : (request.cf && request.cf.country) || null };
  }
  const nextReset = Date.parse(day + 'T00:00:00Z') + 86400000;
  return json({ day, resetsInMs: nextReset - now, qualify: QUALIFY, total, top: top.results, countries: countries.results, me });
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
