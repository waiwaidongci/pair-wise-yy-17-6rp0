// 判定层：高值处置的全部业务规则，纯函数、不碰文件与网络。
// 输入 db（内存对象）+ config.rules，输出修改后的实体或 { error }。

const DEFAULT_RULES = {
  highMargin: 150, // 读数高出基准 150ppm 触发高值处置
  resumeMargin: 80, // 复测回到基准 80ppm 以内才算达标
  retestIntervalMinutes: 30, // 两次复测至少间隔 30 分钟
  retestsRequired: 2, // 关闭处置需要的达标复测次数
  handlingTeam: [] // 处置组成员，复测须由组外人员完成
};

function rulesOf(config) {
  return { ...DEFAULT_RULES, ...(config.rules || {}) };
}

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function isHighReading(co2, baseline, rules) {
  return Number(co2) - Number(baseline) >= rules.highMargin;
}

function isWithinResume(co2, baseline, rules) {
  return Number(co2) - Number(baseline) <= rules.resumeMargin;
}

function findOpenIncident(db, siteId) {
  return (db.incidents || []).find((entry) => entry.siteId === siteId && entry.status === '处置中');
}

function readingFromSurvey(survey) {
  return {
    surveyId: survey.id,
    co2: Number(survey.co2),
    occupancy: Number(survey.occupancy || 0),
    reporter: survey.surveyor,
    at: survey.createdAt
  };
}

// 关闭条件：retestsRequired 次达标复测（非处置组成员、≤基准+resumeMargin），
// 且最早与最晚一次间隔 ≥ retestIntervalMinutes。
function closureProgress(incident, baseline, rules) {
  const qualifying = (incident.retests || [])
    .filter((retest) => isWithinResume(retest.co2, baseline, rules) && !rules.handlingTeam.includes(retest.tester))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const intervalMs = rules.retestIntervalMinutes * 60000;
  let closable = false;
  for (let i = 0; i + rules.retestsRequired <= qualifying.length && !closable; i += 1) {
    for (let j = i + rules.retestsRequired - 1; j < qualifying.length; j += 1) {
      if (new Date(qualifying[j].at) - new Date(qualifying[i].at) >= intervalMs) {
        closable = true;
        break;
      }
    }
  }
  return { qualifying: qualifying.length, required: rules.retestsRequired, closable };
}

function closeIncident(incident, note) {
  const now = new Date().toISOString();
  incident.status = '已关闭';
  incident.entryHold = false;
  incident.closedAt = now;
  incident.updatedAt = now;
  incident.history.unshift(stamp('关闭处置', note));
}

// 重算未关闭处置单的派生状态：基准快照、峰值、停发许可、是否满足关闭条件。
// 已关闭的旧单一律不动，留档备查。
function refreshIncident(db, config, incident) {
  if (incident.status !== '处置中') return incident;
  const rules = rulesOf(config);
  const site = (db.sites || []).find((entry) => entry.id === incident.siteId);
  const baseline = Number(site ? site.baselineCo2 : incident.baselineCo2);
  incident.baselineCo2 = baseline;
  incident.peakCo2 = Math.max(...incident.readings.map((reading) => Number(reading.co2)));
  // 停发许可：存在高出基准 150ppm 且洞内有人的读数
  incident.entryHold = incident.readings.some(
    (reading) => isHighReading(reading.co2, baseline, rules) && Number(reading.occupancy) > 0
  );
  const progress = closureProgress(incident, baseline, rules);
  if (progress.closable) {
    closeIncident(incident, `${progress.required} 次通风复测均回到基准 ${rules.resumeMargin}ppm 以内且间隔达标，恢复进场许可`);
  }
  incident.updatedAt = new Date().toISOString();
  return incident;
}

function createIncident(db, config, site, survey, now) {
  const baseline = Number(site.baselineCo2);
  const incident = {
    id: newId('incidents'),
    siteId: site.id,
    cave: site.cave,
    status: '处置中',
    baselineCo2: baseline,
    triggerCo2: Number(survey.co2),
    peakCo2: Number(survey.co2),
    entryHold: false,
    readings: [readingFromSurvey(survey)],
    retests: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    history: [stamp('创建处置单', `CO2 ${survey.co2}ppm，高出基准 ${Number(survey.co2) - baseline}ppm`)]
  };
  db.incidents.push(incident);
  if (site.protectedStatus !== '暂停开放') {
    site.protectedStatus = '重点保护';
    site.updatedAt = now;
    site.history = site.history || [];
    site.history.unshift(stamp('重点保护', '触发高值处置'));
  }
  return incident;
}

// 上报读数：登记巡测记录；同样点有未关闭处置单时读数归到原单，
// 否则高出基准 150ppm 才新开处置单。
function recordReading(db, config, input) {
  const rules = rulesOf(config);
  const site = (db.sites || []).find((entry) => entry.id === input.siteId);
  if (!site) return { error: '样点不存在', status: 404 };
  const now = new Date().toISOString();
  const co2 = Number(input.co2);
  if (!Number.isFinite(co2)) return { error: 'CO2读数无效' };
  const high = isHighReading(co2, site.baselineCo2, rules);
  const survey = {
    id: newId('surveys'),
    siteId: site.id,
    surveyor: input.surveyor,
    date: input.date,
    temperature: Number(input.temperature),
    humidity: Number(input.humidity),
    co2,
    dripRate: Number(input.dripRate),
    occupancy: Number(input.occupancy || 0),
    photoUrl: input.photoUrl || '',
    disturbance: input.disturbance || '',
    status: high ? '异常待复查' : '正常',
    reviewNote: '',
    incidentId: null,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', high ? `CO2高出基准 ${co2 - Number(site.baselineCo2)}ppm` : '巡测登记')]
  };
  db.surveys.push(survey);

  let incident = findOpenIncident(db, site.id);
  const created = !incident && high;
  if (incident) {
    incident.readings.push(readingFromSurvey(survey));
    incident.history.unshift(stamp('读数归并', `${survey.surveyor} 上报 CO2 ${co2}ppm，归入原处置单`));
  } else if (high) {
    incident = createIncident(db, config, site, survey, now);
  }
  if (incident) {
    survey.incidentId = incident.id;
    refreshIncident(db, config, incident);
  }
  return { survey, incident: incident || null, created };
}

// 通风复测：须由非处置组成员完成；达标条件满足后自动关闭处置并恢复许可。
function addRetest(db, config, incidentId, input) {
  const rules = rulesOf(config);
  const incident = (db.incidents || []).find((entry) => entry.id === incidentId);
  if (!incident) return { error: '处置单不存在', status: 404 };
  if (incident.status !== '处置中') return { error: '处置单已关闭，无需复测' };
  const tester = String(input.tester || '').trim();
  if (!tester) return { error: '请填写复测人员' };
  if (rules.handlingTeam.includes(tester)) return { error: `${tester} 是处置组成员，通风复测须由非处置组成员完成` };
  const co2 = Number(input.co2);
  if (!Number.isFinite(co2)) return { error: '复测CO2读数无效' };
  let at = new Date().toISOString();
  if (input.at) {
    const parsed = new Date(input.at);
    if (Number.isNaN(parsed.getTime())) return { error: '复测时间无效' };
    at = parsed.toISOString();
  }
  incident.retests = incident.retests || [];
  incident.retests.push({ co2, tester, at });
  const offset = co2 - Number(incident.baselineCo2);
  incident.history.unshift(stamp('通风复测', `${tester} 复测 CO2 ${co2}ppm（基准${offset >= 0 ? '+' : ''}${offset}）`));
  refreshIncident(db, config, incident);
  return { incident, closed: incident.status === '已关闭' };
}

// 进场许可：洞穴存在未关闭且停发中的处置单时，入口停发。
function issuePermit(db, config, input) {
  const cave = String(input.cave || '').trim();
  if (!cave) return { error: '请选择洞穴' };
  const team = String(input.team || '').trim();
  if (!team) return { error: '请填写进场队伍/负责人' };
  const holds = (db.incidents || []).filter(
    (entry) => entry.status === '处置中' && entry.entryHold && entry.cave === cave
  );
  if (holds.length) {
    const peak = Math.max(...holds.map((entry) => entry.peakCo2));
    return { error: `${cave} 有未关闭的高值处置单（峰值 ${peak}ppm 且洞内有人），入口暂停发放许可` };
  }
  const now = new Date().toISOString();
  const permit = {
    id: newId('permits'),
    cave,
    team,
    headcount: Number(input.headcount || 0),
    note: input.note || '',
    status: '已签发',
    createdAt: now,
    updatedAt: now,
    history: [stamp('签发', `${team} ${Number(input.headcount || 0)}人进场`)]
  };
  db.permits.push(permit);
  return { permit };
}

// 基准更正后：未关闭单按新基准重判，已关闭旧单留档不动。
function rejudgeOpenIncidents(db, config, siteId, reason) {
  const changed = [];
  for (const incident of (db.incidents || []).filter((entry) => entry.siteId === siteId && entry.status === '处置中')) {
    refreshIncident(db, config, incident);
    incident.history.unshift(stamp('重判', reason));
    changed.push(incident);
  }
  return changed;
}

// 原读数更正后：同步未关闭单内的对应读数并按新值重判；
// 若该读数不在任何未关闭单中且更正后达到高值，则补开处置单。
function syncSurveyCorrection(db, config, survey) {
  const rules = rulesOf(config);
  const incident = (db.incidents || []).find(
    (entry) => entry.status === '处置中' && (entry.readings || []).some((reading) => reading.surveyId === survey.id)
  );
  if (incident) {
    const reading = incident.readings.find((entry) => entry.surveyId === survey.id);
    reading.co2 = Number(survey.co2);
    reading.occupancy = Number(survey.occupancy || 0);
    if (incident.readings[0] === reading) incident.triggerCo2 = Number(survey.co2);
    refreshIncident(db, config, incident);
    incident.history.unshift(stamp('重判', `原读数更正为 ${survey.co2}ppm，按新值重判`));
    return { incident, created: false };
  }
  const site = (db.sites || []).find((entry) => entry.id === survey.siteId);
  if (site && !findOpenIncident(db, site.id) && isHighReading(survey.co2, site.baselineCo2, rules)) {
    survey.status = '异常待复查';
    const createdIncident = createIncident(db, config, site, survey, new Date().toISOString());
    survey.incidentId = createdIncident.id;
    refreshIncident(db, config, createdIncident);
    return { incident: createdIncident, created: true };
  }
  return { incident: null, created: false };
}

module.exports = {
  DEFAULT_RULES,
  rulesOf,
  stamp,
  isHighReading,
  isWithinResume,
  findOpenIncident,
  closureProgress,
  refreshIncident,
  recordReading,
  addRetest,
  issuePermit,
  rejudgeOpenIncidents,
  syncSurveyCorrection
};
