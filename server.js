const express = require('express');
const path = require('path');

const config = require('./project.config');
const { createStore } = require('./src/store');
const judgment = require('./src/judgment');

const app = express();
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const store = createStore(DB_FILE);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const stamp = judgment.stamp;

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function sendError(res, result) {
  res.status(result.status || 409).json({ error: result.error });
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await store.read();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// ---- 高值处置域接口（判定在 src/judgment.js，存储在 src/store.js）----

// 上报读数：同样点有未关闭处置单时归并到原单，否则高出基准 150ppm 开新单
app.post('/api/readings', async (req, res) => {
  const result = await store.mutate((db) => judgment.recordReading(db, config, req.body));
  if (result.error) return sendError(res, result);
  res.status(201).json(result);
});

// 通风复测：非处置组成员、两次、间隔 30 分钟、均回到基准 80ppm 内才关闭
app.post('/api/incidents/:id/retests', async (req, res) => {
  const result = await store.mutate((db) => judgment.addRetest(db, config, req.params.id, req.body));
  if (result.error) return sendError(res, result);
  res.status(result.closed ? 200 : 201).json(result);
});

// 进场许可：洞穴有未关闭且停发中的处置单时拒绝签发
app.post('/api/permits', async (req, res) => {
  const result = await store.mutate((db) => judgment.issuePermit(db, config, req.body));
  if (result.error) return sendError(res, result);
  res.status(201).json(result.permit);
});

// ---- 通用集合接口 ----

app.post('/api/:collection', async (req, res) => {
  const { collection } = req.params;
  const result = await store.mutate((db) => {
    if (!Array.isArray(db[collection])) return { error: 'unknown collection', status: 404 };
    const now = new Date().toISOString();
    const item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...req.body,
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建', req.body.note || req.body.memo || '')]
    };
    db[collection].push(item);
    return { item };
  });
  if (result.error) return sendError(res, result);
  res.status(201).json(result.item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const { collection, id } = req.params;
  const result = await store.mutate((db) => {
    if (!Array.isArray(db[collection])) return { error: 'unknown collection', status: 404 };
    const item = db[collection].find((entry) => entry.id === id);
    if (!item) return { error: 'not found', status: 404 };
    const historyAction = req.body.historyAction;
    delete req.body.historyAction;
    Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
    item.history = item.history || [];
    if (historyAction || req.body.note || req.body.memo || req.body.status) {
      item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
    }
    // 更正联动：基准或原读数更正后，未关闭处置单按新值重判，旧单留档
    if (collection === 'sites' && req.body.baselineCo2 !== undefined) {
      judgment.rejudgeOpenIncidents(db, config, id, `基准CO2更正为 ${req.body.baselineCo2}ppm，按新值重判`);
    }
    if (collection === 'surveys' && (req.body.co2 !== undefined || req.body.occupancy !== undefined)) {
      judgment.syncSurveyCorrection(db, config, item);
    }
    return { item };
  });
  if (result.error) return sendError(res, result);
  res.json(result.item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const { collection, id } = req.params;
  const result = await store.mutate((db) => {
    if (!Array.isArray(db[collection])) return { error: 'unknown collection', status: 404 };
    const before = db[collection].length;
    db[collection] = db[collection].filter((entry) => entry.id !== id);
    if (db[collection].length === before) return { error: 'not found', status: 404 };
    return { ok: true };
  });
  if (result.error) return sendError(res, result);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const result = await store.mutate((db) => {
    const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
    if (!item) return { error: 'not found', status: 404 };
    const actionResult = runAction(db, action, item);
    if (actionResult.error) return actionResult;
    return { item: actionResult.item };
  });
  if (result.error) return sendError(res, result);
  res.json(result.item);
});

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
