// node:sqlite 위에 D1 흉내를 씌워 ranking.js 를 검증 (시작/종료 기록, 2시간 기준, 상위 20)
// 실행: node --no-warnings tests/ranking.test.mjs   (Node 22.5+)
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
// 1) 시작 → 25분 뒤 종료 기록: 25분 인정
assert.equal((await post({ id: A, name: '민지', start: true })).status, 200);
clock += 25 * MIN;
let r = await post({ id: A, name: '민지', minutes: 25 });
assert.equal(r.credited, 25);
// 2) 시작 후 10분 뒤 '60분 했다' 주장 → 실제 흐른 10분(+여유 1)만 인정
await post({ id: A, name: '민지', start: true });
clock += 10 * MIN;
r = await post({ id: A, name: '민지', minutes: 60 });
assert.equal(r.credited, 11);
// 3) 연타: 시작/종료를 즉시 반복해도 여유 1분 이상은 안 쌓임
for (let i = 0; i < 5; i++) { await post({ id: A, name: '민지', start: true }); r = await post({ id: A, name: '민지', minutes: 25 }); assert.equal(r.credited, 1); }
// A = 25 + 11 + 5 = 41분 → 2시간 미만이라 순위 미표시
let g = await get(A);
assert.equal(g.qualify, 120);
assert.equal(g.me.minutes, 41); assert.equal(g.me.rank, null); assert.equal(g.top.length, 0); assert.equal(g.total.people, 0);
// 4) 2시간 넘기면 순위 등장
for (let i = 0; i < 4; i++) { await post({ id: A, name: '민지', start: true }); clock += 25 * MIN; await post({ id: A, name: '민지', minutes: 25 }); clock += 5 * MIN; }
g = await get(A);
assert.equal(g.me.minutes, 141); assert.equal(g.me.rank, 1); assert.deepEqual(g.top.map(x => [x.name, x.minutes, x.mine]), [['민지', 141, 1]]);
// 5) 상위 20명까지만 + 국가 순위도 2시간 이상만
for (let i = 2; i <= 26; i++) {
  const id = uid(i);
  raw.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, 'p' + i, i % 2 ? 'US' : 'JP', clock);
  raw.prepare('INSERT INTO daily VALUES (?,?,?,?,?)').run('2026-10-04', id, i <= 24 ? 130 + i : 60, 5, clock);
}
g = await get(A);
assert.equal(g.top.length, 20);
assert.ok(g.top.every(x => x.minutes >= 120));
assert.equal(g.top[0].minutes, 154);
assert.equal(g.total.people, 24);              // A + p2..p24 (p25, p26 은 60분이라 제외)
assert.equal(g.me.rank, 14);                    // 132~154분 중 141분보다 많은 13명 다음
assert.ok(g.top.some(x => x.mine));            // 14위는 상위 20 안이라 표시됨
assert.ok(g.countries.every(c => c.minutes >= 120));
// 6) 잘못된 입력
assert.equal((await post({ id: 'nope', name: 'x', minutes: 25 })).status, 400);
assert.equal((await post({ id: A, name: '', start: true })).status, 400);
assert.equal((await post({ id: A, name: 'a'.repeat(17), minutes: 25 })).status, 400);
assert.equal((await post({ id: A, name: 'ok', minutes: 999 })).status, 400);
// 7) 닉네임 변경은 시간 안 쌓이고 시작 시각도 안 바뀜
const before = raw.prepare('SELECT last_at FROM users WHERE id = ?').get(A).last_at;
r = await post({ id: A, name: '새이름', minutes: 0 });
assert.equal(r.credited, 0);
assert.equal(raw.prepare('SELECT last_at FROM users WHERE id = ?').get(A).last_at, before);
// 8) 날짜 바뀌면 초기화
clock = Date.parse('2026-10-05T00:01:00Z');
g = await get(A);
assert.equal(g.top.length, 0); assert.equal(g.me.minutes, 0); assert.equal(g.day, '2026-10-05');
console.log('ALL API TESTS PASSED');
