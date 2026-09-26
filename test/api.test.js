const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const PORT = 4912;
const BASE = `http://127.0.0.1:${PORT}`;

const seed = {
  sites: [
    { id: 's1', cave: '甲洞', zone: 'A区', pointCode: 'A-01', route: '西线', sensitivity: '高', protectedStatus: '常规观察', baselineTemp: 16, baselineHumidity: 90, baselineCo2: 600, note: '', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', history: [] }
  ],
  surveys: [],
  incidents: [],
  permits: []
};

async function api(pathName, options = {}) {
  const res = await fetch(`${BASE}${pathName}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = res.status === 204 ? null : await res.json();
  return { status: res.status, body };
}

function post(pathName, payload) {
  return api(pathName, { method: 'POST', body: JSON.stringify(payload) });
}

let server;
let dbFile;

test.before(async () => {
  dbFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cave-')), 'db.json');
  await fs.writeFile(dbFile, JSON.stringify(seed, null, 2));
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile }
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('running')) resolve();
    });
    server.stderr.on('data', (chunk) => reject(new Error(chunk.toString())));
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
});

test.after(() => {
  server?.kill();
});

test('两人同时上报不丢数：读数归并到同一未关闭处置单', async () => {
  const first = await post('/api/readings', { siteId: 's1', surveyor: '沈宁', date: '2026-09-26', temperature: 16, humidity: 90, co2: 900, dripRate: 10, occupancy: 4 });
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);

  // 并发上报：两条请求同时发出，都必须落库且归并到原单
  const [a, b] = await Promise.all([
    post('/api/readings', { siteId: 's1', surveyor: '王五', date: '2026-09-26', temperature: 16, humidity: 90, co2: 860, dripRate: 11, occupancy: 3 }),
    post('/api/readings', { siteId: 's1', surveyor: '李四', date: '2026-09-26', temperature: 16, humidity: 91, co2: 870, dripRate: 9, occupancy: 2 })
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  const { body: db } = await api('/api/db');
  assert.equal(db.surveys.length, 3);
  assert.equal(db.incidents.length, 1);
  assert.equal(db.incidents[0].readings.length, 3);
  assert.equal(db.incidents[0].peakCo2, 900);
  assert.equal(db.incidents[0].entryHold, true);
});

test('入口停发许可 → 两次合规复测后关闭并恢复', async () => {
  const blocked = await post('/api/permits', { cave: '甲洞', team: '科考队', headcount: 4 });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /暂停发放/);

  const { body: db } = await api('/api/db');
  const incidentId = db.incidents[0].id;

  const member = await post(`/api/incidents/${incidentId}/retests`, { tester: '沈宁', co2: 620 });
  assert.equal(member.status, 409);

  const r1 = await post(`/api/incidents/${incidentId}/retests`, { tester: '王五', co2: 660, at: '2026-09-26T11:00:00Z' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.closed, false);

  const r2 = await post(`/api/incidents/${incidentId}/retests`, { tester: '李四', co2: 655, at: '2026-09-26T11:30:00Z' });
  assert.equal(r2.body.closed, true);

  const allowed = await post('/api/permits', { cave: '甲洞', team: '科考队', headcount: 4 });
  assert.equal(allowed.status, 201);
  assert.equal(allowed.body.status, '已签发');
});

test('基准更正后未关闭单按新值重判', async () => {
  // 新开一单（上一单已关闭，留档不动）
  const made = await post('/api/readings', { siteId: 's1', surveyor: '王五', date: '2026-09-27', temperature: 16, humidity: 90, co2: 820, dripRate: 10, occupancy: 3 });
  assert.equal(made.body.created, true);
  const incidentId = made.body.incident.id;

  // 基准 600 → 700：820 不再高超 150ppm，停发解除
  const patched = await api('/api/sites/s1', { method: 'PATCH', body: JSON.stringify({ baselineCo2: 700 }) });
  assert.equal(patched.status, 200);

  const { body: db } = await api('/api/db');
  const open = db.incidents.find((entry) => entry.id === incidentId);
  assert.equal(open.entryHold, false);
  assert.equal(open.baselineCo2, 700);
  assert.ok(open.history.some((entry) => entry.action === '重判'));

  // 已关闭的旧单保持原基准快照，留档不动
  const closed = db.incidents.find((entry) => entry.status === '已关闭');
  assert.equal(closed.baselineCo2, 600);

  const allowed = await post('/api/permits', { cave: '甲洞', team: '维护组', headcount: 2 });
  assert.equal(allowed.status, 201);
});
