const express = require('express');
const path = require('path');

const app = express();
const config = require('./project.config');
const judgment = require('./lib/judgment');
const { Store } = require('./lib/store');

const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const store = new Store(DB_FILE);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

// 补齐集合与默认值，旧数据文件可直接升级
function ensureShape(db) {
  for (const key of Object.keys(config.collections)) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  for (const site of db.sites) {
    if (!site.permitStatus) site.permitStatus = '正常签发';
  }
  return db;
}

const asyncRoute = (handler) => (req, res) => {
  handler(req, res).catch((error) => {
    console.error(error);
    res.status(500).json({ error: '服务器内部错误' });
  });
};

app.get('/api/config', (req, res) => {
  res.json({ ...config, thresholds: judgment.THRESHOLDS });
});

app.get('/api/db', asyncRoute(async (req, res) => {
  const db = ensureShape(await store.read());
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
}));

// 巡测上报：高值判定、归单、许可联动在同一事务内完成
app.post('/api/surveys', asyncRoute(async (req, res) => {
  const now = new Date().toISOString();
  const survey = {
    id: newId('surveys'),
    status: '正常',
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  await store.transact((db) => {
    ensureShape(db);
    db.surveys.push(survey);
    judgment.recordReading(db, survey);
    return survey;
  });
  res.status(201).json(survey);
}));

// 通风复测：非处置组成员登记，条件满足即关闭处置并恢复许可
app.post('/api/incidents/:id/recheck', asyncRoute(async (req, res) => {
  let failure = null;
  const outcome = await store.transact((db) => {
    ensureShape(db);
    const incident = db.incidents.find((entry) => entry.id === req.params.id);
    if (!incident) { failure = [404, '处置单不存在']; return false; }
    const result = judgment.recordRecheck(db, incident, req.body || {});
    if (result.error) { failure = [409, result.error]; return false; }
    return result;
  });
  if (failure) return res.status(failure[0]).json({ error: failure[1] });
  res.status(201).json(outcome);
}));

// 手动关闭：同样要满足复测条件
app.post('/api/incidents/:id/close', asyncRoute(async (req, res) => {
  let failure = null;
  const outcome = await store.transact((db) => {
    ensureShape(db);
    const incident = db.incidents.find((entry) => entry.id === req.params.id);
    if (!incident) { failure = [404, '处置单不存在']; return false; }
    const verdict = judgment.closeVerdict(incident);
    if (!verdict.ok) { failure = [409, verdict.reason]; return false; }
    judgment.closeIncident(db, incident, '复测合格，手动关闭');
    return incident;
  });
  if (failure) return res.status(failure[0]).json({ error: failure[1] });
  res.json(outcome);
}));

app.post('/api/:collection', asyncRoute(async (req, res) => {
  let failure = null;
  const outcome = await store.transact((db) => {
    ensureShape(db);
    const { collection } = req.params;
    if (!Array.isArray(db[collection])) { failure = [404, 'unknown collection']; return false; }
    const now = new Date().toISOString();
    const item = {
      id: newId(collection),
      ...req.body,
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建', req.body.note || req.body.memo || '')]
    };
    db[collection].push(item);
    return item;
  });
  if (failure) return res.status(failure[0]).json({ error: failure[1] });
  res.status(201).json(outcome);
}));

app.patch('/api/:collection/:id', asyncRoute(async (req, res) => {
  let failure = null;
  const outcome = await store.transact((db) => {
    ensureShape(db);
    const { collection, id } = req.params;
    if (!Array.isArray(db[collection])) { failure = [404, 'unknown collection']; return false; }
    const item = db[collection].find((entry) => entry.id === id);
    if (!item) { failure = [404, 'not found']; return false; }
    const historyAction = req.body.historyAction;
    delete req.body.historyAction;
    // 基准或原读数发生更正时，未关闭处置单要按新值重判
    const baselineCorrected = collection === 'sites'
      && req.body.baselineCo2 !== undefined
      && Number(req.body.baselineCo2) !== Number(item.baselineCo2);
    const readingCorrected = collection === 'surveys'
      && (req.body.co2 !== undefined || req.body.peopleInside !== undefined);
    Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
    item.history = item.history || [];
    if (historyAction || req.body.note || req.body.memo || req.body.status) {
      item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
    }
    if (baselineCorrected) judgment.rejudgeSite(db, item);
    if (readingCorrected) judgment.correctSurveyReading(db, item);
    return item;
  });
  if (failure) return res.status(failure[0]).json({ error: failure[1] });
  res.json(outcome);
}));

app.delete('/api/:collection/:id', asyncRoute(async (req, res) => {
  let failure = null;
  await store.transact((db) => {
    ensureShape(db);
    const { collection, id } = req.params;
    if (!Array.isArray(db[collection])) { failure = [404, 'unknown collection']; return false; }
    const before = db[collection].length;
    db[collection] = db[collection].filter((entry) => entry.id !== id);
    if (db[collection].length === before) { failure = [404, 'not found']; return false; }
    return true;
  });
  if (failure) return res.status(failure[0]).json({ error: failure[1] });
  res.status(204).end();
}));

app.post('/api/action/:actionId/:id', asyncRoute(async (req, res) => {
  let failure = null;
  const outcome = await store.transact((db) => {
    ensureShape(db);
    const action = config.actions.find((entry) => entry.id === req.params.actionId);
    if (!action) { failure = [404, 'unknown action']; return false; }
    const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
    if (!item) { failure = [404, 'not found']; return false; }
    const result = runAction(db, action, item);
    if (result.error) { failure = [409, result.error]; return false; }
    return result.item;
  });
  if (failure) return res.status(failure[0]).json({ error: failure[1] });
  res.json(outcome);
}));

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
