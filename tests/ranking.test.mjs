// Tests ranking.js against an in-memory node:sqlite stand-in for D1 (start/stop records, 2-hour minimum, top 20)
// Run: node --no-warnings tests/ranking.test.mjs   (Node 22.5+)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const api = await import(pathToFileURL(ROOT + '/functions/api/ranking.js').href);

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(ROOT + '/schema.sql', 'utf8'));
const stmt = (sql) => ({
  args: [], sql,
  bind(...a) { return { ...this, args: a }; },
  async first() { return raw.prepare(this.sql).get(...this.args) ?? null; },
  async all() { return { results: raw.prepare(this.sql).all(...this.args) }; },
  async run() { raw.prepare(this.sql).run(...this.args); return {}; }
});
const env = { DB: { prepare: stmt, async batch(list) { raw.exec('BEGIN'); for (const s of list) await s.run(); raw.exec('COMMIT'); } } };

let clock = Date.parse('2026-10-04T01:00:00Z');
Date.now = () => clock;
const MIN = 60000;
const post = async (body, country = 'KR') => {
  const r = await api.onRequestPost({ env, request: Object.assign(new Request('https://x/api/ranking', { method: 'POST', body: JSON.stringify(body) }), { cf: { country } }) });
  return { status: r.status, ...(await r.json()) };
};
const get = async (id = '') => (await api.onRequestGet({ env, request: Object.assign(new Request('https://x/api/ranking?id=' + id), { cf: { country: 'KR' } }) })).json();
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const A = uid(1);
// 1) start → report after 25 min: 25 min credited
assert.equal((await post({ id: A, name: '민지', start: true })).status, 200);
clock += 25 * MIN;
let r = await post({ id: A, name: '민지', minutes: 25 });
assert.equal(r.credited, 25);
// 2) claim 60 min only 10 min after start → only the real 10 min (+1 slack) is credited
await post({ id: A, name: '민지', start: true });
clock += 10 * MIN;
r = await post({ id: A, name: '민지', minutes: 60 });
assert.equal(r.credited, 11);
// 3) spamming start/stop never adds more than the 1-minute slack
for (let i = 0; i < 5; i++) { await post({ id: A, name: '민지', start: true }); r = await post({ id: A, name: '민지', minutes: 25 }); assert.equal(r.credited, 1); }
// A = 25 + 11 + 5 = 41 min → under 2 hours, not ranked
let g = await get(A);
assert.equal(g.qualify, 120);
assert.equal(g.me.minutes, 41); assert.equal(g.me.rank, null); assert.equal(g.top.length, 0); assert.equal(g.total.people, 0);
// 4) appears in the ranking after passing 2 hours
for (let i = 0; i < 4; i++) { await post({ id: A, name: '민지', start: true }); clock += 25 * MIN; await post({ id: A, name: '민지', minutes: 25 }); clock += 5 * MIN; }
g = await get(A);
assert.equal(g.me.minutes, 141); assert.equal(g.me.rank, 1); assert.deepEqual(g.top.map(x => [x.name, x.minutes, x.mine]), [['민지', 141, 1]]);
// 5) only the top 20 are listed; the country ranking also counts 2h+ people only
for (let i = 2; i <= 26; i++) {
  const id = uid(i);
  raw.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, 'p' + i, i % 2 ? 'US' : 'JP', clock);
  raw.prepare('INSERT INTO daily VALUES (?,?,?,?,?)').run('2026-10-04', id, i <= 24 ? 130 + i : 60, 5, clock);
}
g = await get(A);
assert.equal(g.top.length, 20);
assert.ok(g.top.every(x => x.minutes >= 120));
assert.equal(g.top[0].minutes, 154);
assert.equal(g.total.people, 24);              // A + p2..p24 (p25 and p26 have 60 min and are excluded)
assert.equal(g.me.rank, 14);                    // 13 people between 132 and 154 min are ahead of 141
assert.ok(g.top.some(x => x.mine));            // rank 14 is inside the top 20, so it is listed
assert.ok(g.countries.every(c => c.minutes >= 120));
// 6) invalid input
assert.equal((await post({ id: 'nope', name: 'x', minutes: 25 })).status, 400);
assert.equal((await post({ id: A, name: '', start: true })).status, 400);
assert.equal((await post({ id: A, name: 'a'.repeat(17), minutes: 25 })).status, 400);
assert.equal((await post({ id: A, name: 'ok', minutes: 999 })).status, 400);
// 7) renaming adds no time and does not move the start time
const before = raw.prepare('SELECT last_at FROM users WHERE id = ?').get(A).last_at;
r = await post({ id: A, name: '새이름', minutes: 0 });
assert.equal(r.credited, 0);
assert.equal(raw.prepare('SELECT last_at FROM users WHERE id = ?').get(A).last_at, before);
// 8) resets when the UTC day changes
clock = Date.parse('2026-10-05T00:01:00Z');
g = await get(A);
assert.equal(g.top.length, 0); assert.equal(g.me.minutes, 0); assert.equal(g.day, '2026-10-05');
console.log('ALL API TESTS PASSED');
