// 判定层：CO2 高值处置的业务规则。
// 只操作传入的数据实体，不触碰存储与页面，阈值集中在此调整。

const THRESHOLDS = {
  highDeltaPpm: 150, // 读数高出基准 150ppm 触发高值处置
  recoverDeltaPpm: 80, // 回到基准 80ppm 以内视为恢复
  recheckIntervalMinutes: 30 // 两次合格复测的最小间隔
};

const RECHECK_INTERVAL_MS = THRESHOLDS.recheckIntervalMinutes * 60 * 1000;

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function isHigh(co2, baselineCo2) {
  return Number(co2) - Number(baselineCo2) >= THRESHOLDS.highDeltaPpm;
}

function isRecovered(co2, baselineCo2) {
  return Number(co2) - Number(baselineCo2) <= THRESHOLDS.recoverDeltaPpm;
}

function openIncidentOf(db, siteId) {
  return (db.incidents || []).find((entry) => entry.siteId === siteId && entry.status !== '已关闭');
}

// 许可联动：处置未关闭且已触发停发时，入口停发许可，否则正常签发
function syncPermit(db, incident) {
  const site = (db.sites || []).find((entry) => entry.id === incident.siteId);
  if (!site) return;
  const suspend = incident.status !== '已关闭' && Boolean(incident.permitSuspended);
  const next = suspend ? '停发' : '正常签发';
  if ((site.permitStatus || '正常签发') === next) return;
  site.permitStatus = next;
  site.updatedAt = new Date().toISOString();
  site.history = site.history || [];
  site.history.unshift(stamp(
    suspend ? '入口停发许可' : '入口恢复签发',
    suspend ? '读数高出基准150ppm且洞内有人' : '处置关闭，恢复进场'
  ));
}

// 读数归单：同一样点有未关闭处置单时，后报读数并入原单；否则按判定开新单。
function recordReading(db, survey) {
  const site = (db.sites || []).find((entry) => entry.id === survey.siteId);
  if (!site || survey.co2 === undefined || survey.co2 === null || survey.co2 === '') return null;
  const now = new Date().toISOString();
  const reading = {
    surveyId: survey.id,
    co2: Number(survey.co2),
    peopleInside: Number(survey.peopleInside || 0),
    surveyor: survey.surveyor || '',
    at: now
  };
  const high = isHigh(reading.co2, site.baselineCo2);
  let incident = openIncidentOf(db, site.id);
  if (!incident && !high) return { incident: null, high };

  if (!incident) {
    incident = {
      id: newId('incident'),
      siteId: site.id,
      status: '处置中',
      baselineCo2: Number(site.baselineCo2),
      peakCo2: 0,
      permitSuspended: false,
      readings: [],
      ventilationChecks: [],
      revisions: [],
      handlingTeam: reading.surveyor ? [reading.surveyor] : [],
      openedAt: now,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
      history: [stamp('开立处置单', `CO2 ${reading.co2}ppm，高出基准${reading.co2 - Number(site.baselineCo2)}ppm`)]
    };
    db.incidents.push(incident);
  }
  incident.readings.push(reading);
  incident.peakCo2 = incident.readings.reduce((max, entry) => Math.max(max, Number(entry.co2)), 0);
  incident.updatedAt = now;
  incident.history.unshift(stamp('读数归单', `${reading.surveyor || '巡测'}上报 ${reading.co2}ppm`));

  if (high) {
    survey.status = '异常待复查';
    survey.history = survey.history || [];
    survey.history.unshift(stamp('高值判定', `高出基准${reading.co2 - Number(site.baselineCo2)}ppm，纳入处置单`));
    if (site.protectedStatus === '常规观察') {
      site.protectedStatus = '重点保护';
      site.history = site.history || [];
      site.history.unshift(stamp('重点保护', 'CO2高值，自动列入重点保护'));
    }
    // 读数高出基准150ppm且洞内有人 → 入口停发许可
    if (reading.peopleInside > 0) incident.permitSuspended = true;
  }
  syncPermit(db, incident);
  return { incident, high };
}

// 通风复测：须由非处置组成员进行；满足关闭条件时自动关闭处置并恢复许可。
function recordRecheck(db, incident, input) {
  if (incident.status === '已关闭') return { error: '处置单已关闭' };
  const tester = String(input.tester || '').trim();
  if (!tester) return { error: '请填写复测人' };
  if ((incident.handlingTeam || []).includes(tester)) return { error: '复测须由非处置组成员进行' };
  const co2 = Number(input.co2);
  if (!Number.isFinite(co2)) return { error: '复测读数无效' };
  let at = new Date().toISOString();
  if (input.at) {
    const parsed = new Date(input.at);
    if (Number.isNaN(parsed.getTime())) return { error: '复测时间无效' };
    at = parsed.toISOString();
  }
  const check = {
    id: newId('check'),
    tester,
    co2,
    at,
    pass: isRecovered(co2, incident.baselineCo2)
  };
  incident.ventilationChecks = incident.ventilationChecks || [];
  incident.ventilationChecks.push(check);
  incident.updatedAt = new Date().toISOString();
  incident.history.unshift(stamp('通风复测', `${tester} 测得 ${co2}ppm（${check.pass ? '回到基准80ppm以内' : '未回到基准80ppm以内'}）`));
  if (closeVerdict(incident).ok) {
    closeIncident(db, incident, '两次复测回到基准80ppm以内且间隔满30分钟');
  }
  return { check, closed: incident.status === '已关闭' };
}

function qualifyingChecks(incident) {
  return (incident.ventilationChecks || [])
    .filter((check) => isRecovered(check.co2, incident.baselineCo2))
    .slice()
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

// 关闭条件：两次复测都回到基准80ppm以内，且间隔满30分钟
function closeVerdict(incident) {
  if (incident.status === '已关闭') return { ok: false, reason: '处置单已关闭' };
  const passing = qualifyingChecks(incident);
  if (passing.length < 2) return { ok: false, reason: '需要两次回到基准80ppm以内的复测' };
  const gapMs = new Date(passing[passing.length - 1].at) - new Date(passing[0].at);
  if (gapMs < RECHECK_INTERVAL_MS) return { ok: false, reason: '两次合格复测间隔需满30分钟' };
  return { ok: true };
}

function closeIncident(db, incident, note) {
  const now = new Date().toISOString();
  incident.status = '已关闭';
  incident.closedAt = now;
  incident.permitSuspended = false;
  incident.updatedAt = now;
  incident.history = incident.history || [];
  incident.history.unshift(stamp('关闭处置', note || ''));
  syncPermit(db, incident);
}

// 基准或原读数更正后，未关闭单按新值重判；更正前的判定快照留档。
function rejudgeIncident(db, incident, reason) {
  if (incident.status === '已关闭') return null;
  const site = (db.sites || []).find((entry) => entry.id === incident.siteId);
  if (!site) return null;
  const now = new Date().toISOString();
  incident.revisions = incident.revisions || [];
  incident.revisions.push({
    at: now,
    reason,
    snapshot: {
      baselineCo2: incident.baselineCo2,
      peakCo2: incident.peakCo2,
      permitSuspended: incident.permitSuspended,
      status: incident.status,
      readings: (incident.readings || []).map((entry) => ({ ...entry })),
      ventilationChecks: (incident.ventilationChecks || []).map((entry) => ({ ...entry }))
    }
  });
  incident.baselineCo2 = Number(site.baselineCo2);
  incident.peakCo2 = (incident.readings || []).reduce((max, entry) => Math.max(max, Number(entry.co2)), 0);
  // 许可按新值重判：仍存在高出基准150ppm且洞内有人的读数才维持停发
  incident.permitSuspended = (incident.readings || []).some(
    (entry) => isHigh(entry.co2, incident.baselineCo2) && Number(entry.peopleInside || 0) > 0
  );
  // 复测合格线随新基准走，重算合格标记
  for (const check of incident.ventilationChecks || []) {
    check.pass = isRecovered(check.co2, incident.baselineCo2);
  }
  incident.updatedAt = now;
  incident.history = incident.history || [];
  incident.history.unshift(stamp('按新值重判', reason));
  if (closeVerdict(incident).ok) {
    closeIncident(db, incident, `${reason}后仍满足关闭条件`);
  } else {
    syncPermit(db, incident);
  }
  return incident;
}

function rejudgeSite(db, site) {
  return (db.incidents || [])
    .filter((entry) => entry.siteId === site.id && entry.status !== '已关闭')
    .map((incident) => rejudgeIncident(db, incident, '基准更正'))
    .filter(Boolean);
}

// 原读数更正：同步更新归单读数，再按新值重判
function correctSurveyReading(db, survey) {
  const incident = openIncidentOf(db, survey.siteId);
  if (!incident) return null;
  const reading = (incident.readings || []).find((entry) => entry.surveyId === survey.id);
  if (!reading) return null;
  if (survey.co2 !== undefined) reading.co2 = Number(survey.co2);
  if (survey.peopleInside !== undefined) reading.peopleInside = Number(survey.peopleInside || 0);
  return rejudgeIncident(db, incident, '原读数更正');
}

module.exports = {
  THRESHOLDS,
  isHigh,
  isRecovered,
  openIncidentOf,
  recordReading,
  recordRecheck,
  closeVerdict,
  closeIncident,
  rejudgeIncident,
  rejudgeSite,
  correctSurveyReading
};
