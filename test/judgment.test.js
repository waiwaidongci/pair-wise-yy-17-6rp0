const test = require('node:test');
const assert = require('node:assert/strict');

const judgment = require('../src/judgment');

const config = { rules: { handlingTeam: ['沈宁', '陆则明'] } };

function makeDb() {
  return {
    sites: [
      { id: 's1', cave: '甲洞', zone: 'A区', pointCode: 'A-01', baselineCo2: 600, protectedStatus: '常规观察', history: [] }
    ],
    surveys: [],
    incidents: [],
    permits: []
  };
}

function reading(input = {}) {
  return { siteId: 's1', surveyor: '王五', date: '2026-09-26', temperature: 16, humidity: 90, dripRate: 10, occupancy: 0, co2: 620, ...input };
}

test('读数达到基准+150ppm 开处置单，洞内有人时停发许可', () => {
  const db = makeDb();
  const result = judgment.recordReading(db, config, reading({ co2: 750, occupancy: 4 }));
  assert.equal(result.created, true);
  assert.equal(db.incidents.length, 1);
  assert.equal(db.incidents[0].entryHold, true);
  assert.equal(db.incidents[0].triggerCo2, 750);
  assert.equal(db.surveys[0].status, '异常待复查');
  assert.equal(db.sites[0].protectedStatus, '重点保护');
});

test('低于阈值不开单；高出但洞内无人则不停发许可', () => {
  const db = makeDb();
  const below = judgment.recordReading(db, config, reading({ co2: 749 }));
  assert.equal(below.incident, null);
  assert.equal(db.surveys[0].status, '正常');

  const high = judgment.recordReading(db, config, reading({ co2: 900, occupancy: 0 }));
  assert.equal(high.created, true);
  assert.equal(db.incidents[0].entryHold, false);
  assert.equal(judgment.issuePermit(db, config, { cave: '甲洞', team: '甲队', headcount: 2 }).permit.status, '已签发');
});

test('同一样点未关闭时，后报读数归到原单，不重复开单', () => {
  const db = makeDb();
  judgment.recordReading(db, config, reading({ co2: 800, occupancy: 2 }));
  const second = judgment.recordReading(db, config, reading({ surveyor: '李四', co2: 700, occupancy: 1 }));
  assert.equal(second.created, false);
  assert.equal(db.incidents.length, 1);
  assert.equal(db.incidents[0].readings.length, 2);
  assert.equal(db.incidents[0].peakCo2, 800);
  assert.equal(db.surveys[1].incidentId, db.incidents[0].id);
});

test('停发中的洞穴拒绝签发许可，处置关闭后恢复', () => {
  const db = makeDb();
  judgment.recordReading(db, config, reading({ co2: 900, occupancy: 5 }));
  const blocked = judgment.issuePermit(db, config, { cave: '甲洞', team: '乙队', headcount: 3 });
  assert.match(blocked.error, /暂停发放/);

  const id = db.incidents[0].id;
  judgment.addRetest(db, config, id, { tester: '王五', co2: 660, at: '2026-09-26T10:00:00Z' });
  const done = judgment.addRetest(db, config, id, { tester: '李四', co2: 650, at: '2026-09-26T10:30:00Z' });
  assert.equal(done.closed, true);
  assert.equal(db.incidents[0].entryHold, false);
  assert.equal(judgment.issuePermit(db, config, { cave: '甲洞', team: '乙队', headcount: 3 }).permit.status, '已签发');
});

test('处置组成员不能复测；复测须两次、间隔30分钟且均回到基准80ppm内', () => {
  const db = makeDb();
  judgment.recordReading(db, config, reading({ co2: 900, occupancy: 1 }));
  const id = db.incidents[0].id;

  const member = judgment.addRetest(db, config, id, { tester: '沈宁', co2: 620 });
  assert.match(member.error, /非处置组成员/);

  judgment.addRetest(db, config, id, { tester: '王五', co2: 700, at: '2026-09-26T09:00:00Z' }); // 超基准100，不达标
  judgment.addRetest(db, config, id, { tester: '王五', co2: 660, at: '2026-09-26T09:30:00Z' }); // 达标第1次
  const tooClose = judgment.addRetest(db, config, id, { tester: '李四', co2: 650, at: '2026-09-26T09:50:00Z' }); // 间隔不足
  assert.equal(tooClose.closed, false);
  const done = judgment.addRetest(db, config, id, { tester: '李四', co2: 640, at: '2026-09-26T10:05:00Z' }); // 与09:30间隔35分钟
  assert.equal(done.closed, true);
  assert.equal(db.incidents[0].status, '已关闭');

  const again = judgment.addRetest(db, config, id, { tester: '王五', co2: 630 });
  assert.match(again.error, /已关闭/);
});

test('基准更正后未关闭单按新值重判，已关闭旧单留档不动', () => {
  const db = makeDb();
  judgment.recordReading(db, config, reading({ co2: 800, occupancy: 3 }));
  const openId = db.incidents[0].id;

  // 先关闭一单（第二样点），再更正其基准，验证旧单不被重判
  db.sites.push({ id: 's2', cave: '乙洞', zone: 'B区', pointCode: 'B-01', baselineCo2: 500, protectedStatus: '常规观察', history: [] });
  judgment.recordReading(db, config, reading({ siteId: 's2', co2: 700, occupancy: 2 }));
  const closedId = db.incidents.find((i) => i.siteId === 's2').id;
  judgment.addRetest(db, config, closedId, { tester: '王五', co2: 560, at: '2026-09-26T10:00:00Z' });
  judgment.addRetest(db, config, closedId, { tester: '李四', co2: 550, at: '2026-09-26T10:30:00Z' });
  const closedSnapshot = JSON.stringify(db.incidents.find((i) => i.id === closedId));

  // 基准 600 → 700：800 的读数不再高超 150ppm，停发解除
  db.sites.find((s) => s.id === 's1').baselineCo2 = 700;
  const changed = judgment.rejudgeOpenIncidents(db, config, 's1', '基准更正重判');
  assert.equal(changed.length, 1);
  assert.equal(db.incidents.find((i) => i.id === openId).entryHold, false);
  assert.equal(db.incidents.find((i) => i.id === openId).baselineCo2, 700);

  // 旧单留档：任何字段都不变
  db.sites.find((s) => s.id === 's2').baselineCo2 = 999;
  judgment.rejudgeOpenIncidents(db, config, 's2', '基准更正重判');
  assert.equal(JSON.stringify(db.incidents.find((i) => i.id === closedId)), closedSnapshot);
});

test('原读数更正后同步未关闭单并重判；漏单更正到高值补开处置单', () => {
  const db = makeDb();
  judgment.recordReading(db, config, reading({ co2: 800, occupancy: 2 }));
  const survey = db.surveys[0];
  survey.co2 = 700; // 更正后不再高超150
  judgment.syncSurveyCorrection(db, config, survey);
  const incident = db.incidents[0];
  assert.equal(incident.readings[0].co2, 700);
  assert.equal(incident.triggerCo2, 700);
  assert.equal(incident.entryHold, false);

  // 未入单的记录更正到高值 → 补开处置单
  const db2 = makeDb();
  judgment.recordReading(db2, config, reading({ co2: 620 }));
  const lone = db2.surveys[0];
  lone.co2 = 810;
  lone.occupancy = 2;
  const result = judgment.syncSurveyCorrection(db2, config, lone);
  assert.equal(result.created, true);
  assert.equal(db2.incidents[0].entryHold, true);
});
