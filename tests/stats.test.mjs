// Tests stats.js against an in-memory node:sqlite stand-in for D1 (visit counting, country totals, total focus time)
// Run: node --no-warnings tests/stats.test.mjs   (Node 22.5+)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const api = await import(pathToFileURL(ROOT + '/functions/api/stats.js').href);

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(ROOT + '/schema.sql', 'utf8'));
const stmt = (sql) => ({
  args: [], sql,
  bind(...a) { return { ...this, args: a }; },
  async first() { return raw.prepare(this.sql).get(...this.args) ?? null; },
  async all() { return { results: raw.prepare(this.sql).all(...this.args) }; },
  async run() { raw.prepare(this.sql).run(...this.args); return {}; }
});
const env = { DB: { prepare: stmt } };

let clock = Date.parse('2026-11-10T03:00:00Z');
Date.now = () => clock;
const visit = async (id, country) => {
  const r = await api.onRequestPost({ env, request: Object.assign(new Request('https://x/api/stats', { method: 'POST', body: JSON.stringify({ id }) }), { cf: { country } }) });
  return r.status;
};
const stats = async () => (await api.onRequestGet({ env, request: new Request('https://x/api/stats') })).json();
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// empty database
let s = await stats();
assert.deepEqual([s.period, s.visits, s.visitors, s.countries, s.studyMinutes], ['all', 0, 0, 0, 0]);

// 1) one visit per browser per day, however many times the page loads
assert.equal(await visit(uid(1), 'KR'), 200);
assert.equal(await visit(uid(1), 'KR'), 200);
assert.equal(await visit(uid(2), 'KR'), 200);
assert.equal(await visit(uid(3), 'US'), 200);
s = await stats();
assert.equal(s.visits, 3); assert.equal(s.countries, 2);
// 2) the next UTC day counts again
clock += 24 * 3600e3;
await visit(uid(1), 'KR');
s = await stats();
assert.equal(s.visits, 4); assert.equal(s.visitors, 3);
assert.deepEqual(s.byCountry, [{ country: 'KR', visits: 3, minutes: 0 }, { country: 'US', visits: 1, minutes: 0 }]);
// 3) unknown / Tor countries are counted as visits but not listed as countries
await visit(uid(4), 'XX'); await visit(uid(5), 'T1');
s = await stats();
assert.equal(s.visits, 6); assert.equal(s.countries, 2); assert.equal(s.byCountry.length, 2);
// 4) total focus time comes from the ranking table
raw.prepare('INSERT INTO daily VALUES (?,?,?,?,?)').run('2026-11-10', uid(1), 375, 16, clock);
raw.prepare('INSERT INTO daily VALUES (?,?,?,?,?)').run('2026-11-11', uid(3), 50, 2, clock);
s = await stats();
assert.equal(s.studyMinutes, 425); assert.equal(s.studySessions, 18);
// focus time per country comes from users.country; the country with more focus time ranks first
raw.prepare('INSERT INTO users VALUES (?,?,?,?)').run(uid(1), 'a', 'KR', clock);
raw.prepare('INSERT INTO users VALUES (?,?,?,?)').run(uid(3), 'b', 'US', clock);
raw.prepare('INSERT INTO daily VALUES (?,?,?,?,?)').run('2026-11-12', uid(3), 400, 16, clock);
s = await stats();
assert.deepEqual(s.byCountry.map(c => [c.country, c.visits, c.minutes]), [['US', 1, 450], ['KR', 3, 375]]);
// 5) invalid input
const bad = async (body) => (await api.onRequestPost({ env, request: new Request('https://x/api/stats', { method: 'POST', body }) })).status;
assert.equal(await bad(JSON.stringify({ id: 'nope' })), 400);
assert.equal(await bad('not json'), 400);
// 6) top 10 countries only
for (let i = 0; i < 12; i++) await visit(uid(100 + i), 'C' + String.fromCharCode(65 + i));
s = await stats();
assert.equal(s.byCountry.length, 10); assert.equal(s.countries, 14);
// 7) periods: clock is 2026-11-11 (Wednesday) 03:00 UTC; the week starts Monday 11-09
const P = async (period) => (await api.onRequestGet({ env, request: new Request('https://x/api/stats?period=' + period) })).json();
raw.exec('DELETE FROM visits; DELETE FROM daily; DELETE FROM users;');
const A = uid(1), B = uid(2);
raw.prepare('INSERT INTO users VALUES (?,?,?,?)').run(A, 'a', 'KR', clock);
raw.prepare('INSERT INTO users VALUES (?,?,?,?)').run(B, 'b', 'US', clock);
for (const [day, id, c] of [['2026-11-11', A, 'KR'], ['2026-11-10', A, 'KR'], ['2026-11-05', B, 'US'], ['2026-10-20', B, 'US']])
  raw.prepare('INSERT INTO visits VALUES (?,?,?)').run(day, id, c);
for (const [day, id, m] of [['2026-11-11', A, 30], ['2026-11-10', A, 60], ['2026-11-05', B, 200], ['2026-10-20', B, 500]])
  raw.prepare('INSERT INTO daily VALUES (?,?,?,?,?)').run(day, id, m, 1, clock);
s = await P('day');
assert.deepEqual([s.from, s.to, s.visits, s.studyMinutes], ['2026-11-11', '2026-11-11', 1, 30]);
assert.deepEqual(s.byCountry.map(c => [c.country, c.visits, c.minutes]), [['KR', 1, 30]]);
s = await P('week');
assert.deepEqual([s.from, s.visits, s.studyMinutes], ['2026-11-09', 2, 90]);
assert.deepEqual(s.byCountry.map(c => [c.country, c.visits, c.minutes]), [['KR', 2, 90]]);
s = await P('month');
assert.deepEqual([s.from, s.visits, s.countries, s.studyMinutes], ['2026-11-01', 3, 2, 290]);
assert.deepEqual(s.byCountry.map(c => [c.country, c.visits, c.minutes]), [['US', 1, 200], ['KR', 2, 90]]);
s = await P('all');
assert.deepEqual([s.from, s.visits, s.studyMinutes], [null, 4, 790]);
assert.deepEqual(s.byCountry.map(c => [c.country, c.visits, c.minutes]), [['US', 2, 700], ['KR', 2, 90]]);
assert.equal((await P('bogus')).period, 'all');
console.log('ALL STATS TESTS PASSED');
