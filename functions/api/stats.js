// TM Timer site stats API (Cloudflare Pages Functions + D1)
//   POST /api/stats {id}   record one visit per browser per UTC day (only the country is stored)
//   GET  /api/stats        all-time visits, visits by country, and total focus time studied on the site

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (data, status = 200, cache = 'no-store') => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache }
});

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

export async function onRequestGet({ env }) {
  const db = env.DB;
  const day = utcDay(Date.now());
  const visits = await db.prepare(
    `SELECT COUNT(*) AS visits,
            COUNT(DISTINCT id) AS visitors,
            COUNT(DISTINCT CASE WHEN country NOT IN ('XX', 'T1') THEN country END) AS countries,
            SUM(CASE WHEN day = ? THEN 1 ELSE 0 END) AS today
       FROM visits`).bind(day).first();
  const byCountry = await db.prepare(
    `SELECT country, COUNT(*) AS visits
       FROM visits
      WHERE country NOT IN ('XX', 'T1')
      GROUP BY country
      ORDER BY visits DESC, country ASC
      LIMIT 10`).all();
  const study = await db.prepare('SELECT COALESCE(SUM(minutes), 0) AS minutes, COALESCE(SUM(sessions), 0) AS sessions FROM daily').first();
  return json({
    visits: visits.visits || 0,
    visitors: visits.visitors || 0,
    countries: visits.countries || 0,
    today: visits.today || 0,
    byCountry: byCountry.results,
    studyMinutes: study.minutes,
    studySessions: study.sessions
  }, 200, 'public, max-age=60');
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const id = String(body.id || '');
  if (!ID_RE.test(id)) return json({ error: 'bad_id' }, 400);
  const country = (request.cf && request.cf.country) || 'XX';
  await env.DB.prepare('INSERT OR IGNORE INTO visits (day, id, country) VALUES (?, ?, ?)')
    .bind(utcDay(Date.now()), id, country).run();
  return json({ ok: true });
}
