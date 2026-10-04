// TM Timer 세계 순위 API (Cloudflare Pages Functions + D1)
//   GET  /api/ranking?id=<uuid>                오늘(UTC) 2시간 이상 공부한 사람 중 상위 20 + 국가 순위 + 내 기록
//   POST /api/ranking {id, name, start: true}   타이머 시작 (시작 시각을 서버 시계로 기록)
//   POST /api/ranking {id, name, minutes}       일시정지·단계 종료·창 닫기 때 그동안 공부한 분 기록 (0 = 닉네임만 변경)
//
// 부정 방지: 한 사용자가 인정받는 시간은 '직전 기록 이후 실제로 흐른 시간'을 넘을 수 없고,
// 한 번에 최대 180분, 하루 최대 960분(16시간)까지만 쌓인다.

const MAX_SESSION = 180;
const MAX_DAY = 960;
const QUALIFY = 120;   // 순위에 오르는 최소 공부 시간(분)
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

  if (isStart) {   // 타이머 시작: 이 시각부터 흐른 시간만큼만 다음 기록이 인정됨
    await db.prepare(
      `INSERT INTO users (id, name, country, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, country = excluded.country, last_at = excluded.last_at`).bind(id, name, country, now).run();
    return json({ ok: true, started: now });
  }

  if (minutes === 0) {   // 닉네임만 변경
    await db.prepare(
      `INSERT INTO users (id, name, country, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, country = excluded.country`).bind(id, name, country, now).run();
    return json({ ok: true, credited: 0, me: await myStanding(db, day, id) });
  }

  // 직전 기록 이후 실제로 흐른 시간(+1분 여유)을 넘는 만큼은 인정하지 않음
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
