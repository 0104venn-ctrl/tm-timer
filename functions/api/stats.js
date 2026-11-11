// TM Timer site stats API (Cloudflare Pages Functions + D1)
//   POST /api/stats {id}   record one visit per browser per UTC day (only the country is stored)
//   GET  /api/stats?period=day|week|month|all
//                          visits, top 10 countries by focus time (with visits), and total focus time for the period.
//                          day = today (UTC), week = Monday to today, month = the 1st to today, all = everything (default)

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (data, status = 200, cache = 'no-store') => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache }
});

const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

const DAY_MS = 86400000;
const PERIODS = ['day', 'week', 'month', 'all'];

// [from, to] UTC dates of the period ('all' spans every record)
function periodRange(period, now) {
  const today = Date.parse(utcDay(now) + 'T00:00:00Z');
  let from = today;
  if (period === 'all') return { from: '0000-01-01', to: '9999-12-31' };
  if (period === 'week') from = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
  if (period === 'month') { const d = new Date(today); from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  return { from: utcDay(from), to: utcDay(today) };
}

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  const asked = new URL(request.url).searchParams.get('period');
  const period = PERIODS.includes(asked) ? asked : 'all';
  const { from, to } = periodRange(period, Date.now());
  const visits = await db.prepare(
    `SELECT COUNT(*) AS visits,
            COUNT(DISTINCT id) AS visitors,
            COUNT(DISTINCT CASE WHEN country NOT IN ('XX', 'T1') THEN country END) AS countries
       FROM visits WHERE day BETWEEN ? AND ?`).bind(from, to).first();
  // Visits and focus minutes per country in the period, ranked by focus time (then visits)
  const byCountry = await db.prepare(
    `SELECT country, SUM(visits) AS visits, SUM(minutes) AS minutes
       FROM (SELECT country, COUNT(*) AS visits, 0 AS minutes FROM visits WHERE day BETWEEN ? AND ? GROUP BY country
             UNION ALL
             SELECT u.country, 0, SUM(d.minutes) FROM daily d JOIN users u ON u.id = d.id WHERE d.day BETWEEN ? AND ? GROUP BY u.country)
      WHERE country NOT IN ('XX', 'T1')
      GROUP BY country
      ORDER BY minutes DESC, visits DESC, country ASC
      LIMIT 10`).bind(from, to, from, to).all();
  const study = await db.prepare(
    'SELECT COALESCE(SUM(minutes), 0) AS minutes, COALESCE(SUM(sessions), 0) AS sessions FROM daily WHERE day BETWEEN ? AND ?').bind(from, to).first();
  return json({
    period,
    from: period === 'all' ? null : from,
    to: period === 'all' ? null : to,
    visits: visits.visits || 0,
    visitors: visits.visitors || 0,
    countries: visits.countries || 0,
    byCountry: byCountry.results,
    studyMinutes: study.minutes,
    studySessions: study.sessions
  }, 200, 'public, max-age=10');
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
