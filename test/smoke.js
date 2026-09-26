// 冒烟测试：起独立实例（临时数据文件），验证高值处置全流程。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3991;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(cond, message) {
  if (cond) console.log(`  ✓ ${message}`);
  else { failures += 1; console.error(`  ✗ ${message}`); }
}

async function api(pathName, options = {}) {
  const res = await fetch(`${BASE}${pathName}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

const post = (pathName, payload) => api(pathName, { method: 'POST', body: JSON.stringify(payload) });
const patch = (pathName, payload) => api(pathName, { method: 'PATCH', body: JSON.stringify(payload) });

async function getDb() {
  const { body } = await api('/api/db');
  return body;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cave-incident-'));
  const dbFile = path.join(tmp, 'db.json');
  fs.writeFileSync(dbFile, JSON.stringify({
    sites: [{
      id: 'site-1', cave: '测试洞', zone: '一区', pointCode: 'T-01', route: '东线',
      sensitivity: '中', protectedStatus: '常规观察', permitStatus: '正常签发',
      baselineTemp: 16, baselineHumidity: 90, baselineCo2: 600, note: '',
      createdAt: '2026-09-26T08:00:00.000Z', updatedAt: '2026-09-26T08:00:00.000Z', history: []
    }],
    surveys: [],
    incidents: []
  }, null, 2));

  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile },
    stdio: 'pipe'
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('running at')) resolve(); });
    child.on('exit', () => reject(new Error('server exited')));
    setTimeout(resolve, 3000);
  });

  try {
    console.log('1. 普通读数不开单');
    let res = await post('/api/surveys', { siteId: 'site-1', surveyor: '甲', date: '2026-09-26', temperature: 16, humidity: 90, co2: 650, peopleInside: 0, dripRate: 10 });
    check(res.status === 201, '正常读数上报成功');
    let db = await getDb();
    check(db.incidents.length === 0, '未高出150ppm，不开处置单');
    check(db.surveys[0].status === '正常', '巡测记录保持正常');

    console.log('2. 高值且洞内有人：开单并停发许可');
    res = await post('/api/surveys', { siteId: 'site-1', surveyor: '沈宁', date: '2026-09-26', temperature: 16, humidity: 90, co2: 800, peopleInside: 5, dripRate: 10 });
    check(res.status === 201 && res.body.status === '异常待复查', '高值读数自动标异常');
    db = await getDb();
    check(db.incidents.length === 1 && db.incidents[0].status === '处置中', '自动开立处置单');
    check(db.incidents[0].permitSuspended === true, '洞内有人，处置单标记停发');
    check(db.sites[0].permitStatus === '停发', '入口停发许可');
    check(db.sites[0].protectedStatus === '重点保护', '样点自动列入重点保护');
    const incidentId = db.incidents[0].id;

    console.log('3. 两人同时上报：归到原单且不丢数');
    const [r1, r2] = await Promise.all([
      post('/api/surveys', { siteId: 'site-1', surveyor: '甲', date: '2026-09-26', temperature: 16, humidity: 90, co2: 820, peopleInside: 2, dripRate: 10 }),
      post('/api/surveys', { siteId: 'site-1', surveyor: '乙', date: '2026-09-26', temperature: 16, humidity: 90, co2: 780, peopleInside: 0, dripRate: 10 })
    ]);
    check(r1.status === 201 && r2.status === 201, '两条上报都成功');
    db = await getDb();
    check(db.incidents.length === 1, '同一样点未关闭，仍只有一张处置单');
    const incident = db.incidents[0];
    check(incident.readings.length === 3, `后报读数归到原单（当前 ${incident.readings.length} 条）`);
    check(incident.readings.some((r) => r.surveyor === '甲' && r.co2 === 820), '甲的读数未丢');
    check(incident.readings.some((r) => r.surveyor === '乙' && r.co2 === 780), '乙的读数未丢');
    check(incident.peakCo2 === 820, '峰值按归单读数更新');

    console.log('4. 通风复测规则');
    res = await post(`/api/incidents/${incidentId}/recheck`, { tester: '沈宁', co2: 650 });
    check(res.status === 409, '处置组成员复测被拒绝');
    res = await post(`/api/incidents/${incidentId}/recheck`, { tester: '外组小李', co2: 700, at: '2026-09-26T09:50:00.000Z' });
    check(res.status === 201 && res.body.closed === false, '未回到基准80ppm以内的复测只登记不关闭');
    res = await post(`/api/incidents/${incidentId}/recheck`, { tester: '外组小王', co2: 660, at: '2026-09-26T10:00:00.000Z' });
    check(res.status === 201 && res.body.closed === false, '仅一次合格复测不关闭');
    res = await post(`/api/incidents/${incidentId}/recheck`, { tester: '外组小李', co2: 650, at: '2026-09-26T10:10:00.000Z' });
    check(res.status === 201 && res.body.closed === false, '两次合格但间隔不足30分钟不关闭');
    res = await post(`/api/incidents/${incidentId}/close`, {});
    check(res.status === 409, '手动关闭同样被条件拦截');
    res = await post(`/api/incidents/${incidentId}/recheck`, { tester: '外组小王', co2: 655, at: '2026-09-26T10:35:00.000Z' });
    check(res.status === 201 && res.body.closed === true, '两次合格且间隔满30分钟，自动关闭');
    db = await getDb();
    check(db.incidents[0].status === '已关闭', '处置单已关闭');
    check(db.sites[0].permitStatus === '正常签发', '关闭后入口恢复签发');

    console.log('5. 关闭后再报高值：开新单');
    res = await post('/api/surveys', { siteId: 'site-1', surveyor: '沈宁', date: '2026-09-27', temperature: 16, humidity: 90, co2: 900, peopleInside: 2, dripRate: 10 });
    db = await getDb();
    check(db.incidents.length === 2, '关闭后重新开单');
    const second = db.incidents.find((entry) => entry.status === '处置中');
    check(Boolean(second) && second.permitSuspended === true, '新单处置中且停发');
    check(db.sites[0].permitStatus === '停发', '入口再次停发');

    console.log('6. 基准更正：未关闭单按新值重判，旧单留档');
    res = await patch('/api/sites/site-1', { baselineCo2: 850, historyAction: '更正基准CO2' });
    check(res.status === 200, '基准更正成功');
    db = await getDb();
    let open = db.incidents.find((entry) => entry.id === second.id);
    check(open.baselineCo2 === 850, '处置单按新基准重判');
    check(open.permitSuspended === false, '900 不再高出新基准150ppm，停发解除');
    check(db.sites[0].permitStatus === '正常签发', '入口恢复签发');
    check(open.revisions.length === 1 && open.revisions[0].snapshot.baselineCo2 === 600, '旧判定留档');

    console.log('7. 原读数更正：归单读数同步重判');
    const surveyId = open.readings[0].surveyId;
    res = await patch(`/api/surveys/${surveyId}`, { co2: 1000, historyAction: '更正CO2读数' });
    check(res.status === 200, '读数更正成功');
    db = await getDb();
    open = db.incidents.find((entry) => entry.id === second.id);
    check(open.readings[0].co2 === 1000, '归单读数同步更新');
    check(open.peakCo2 === 1000, '峰值重算');
    check(open.permitSuspended === true && db.sites[0].permitStatus === '停发', '1000 高出新基准150ppm且洞内有人，恢复停发');
    check(open.revisions.length === 2, '再次留档');
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\n${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
