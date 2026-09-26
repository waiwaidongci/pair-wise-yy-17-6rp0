const state = {
  config: null,
  db: {},
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function siteLabel(siteId) {
  const site = (state.db.sites || []).find((entry) => entry.id === siteId);
  if (!site) return '未关联';
  return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value ?? '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  const corrections = (view.corrections || [])
    .map((entry) => `<button class="ghost" data-correct="1" data-collection="${collection}" data-id="${item.id}" data-field="${entry.field}" data-label="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions || corrections ? `<div class="actions">${actions}${corrections}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderAnyCard(item, collection, view) {
  return collection === 'incidents' ? renderIncidentCard(item) : renderCard(item, collection, view);
}

function renderIncidentCard(item) {
  const open = item.status !== '已关闭';
  const team = (item.handlingTeam || []).join('、') || '-';
  const permit = open && item.permitSuspended ? pill('停发', 'bad') : pill('正常签发', 'ok');
  const readings = (item.readings || []).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.surveyor || '巡测')} 上报 ${escapeHtml(entry.co2)}ppm${Number(entry.peopleInside) > 0 ? `，洞内${escapeHtml(entry.peopleInside)}人` : ''}</span></div>
  `).join('');
  const checks = (item.ventilationChecks || []).map((check) => `
    <div class="history-item"><span>${fmtDate(check.at)}</span><span>${escapeHtml(check.tester)} 复测 ${escapeHtml(check.co2)}ppm（${check.pass ? '回到基准80ppm以内' : '未回到基准80ppm以内'}）</span></div>
  `).join('');
  const recheck = open ? `
    <form class="recheck" data-recheck="${item.id}">
      <div class="form-grid">
        <label>复测人（非处置组）<input name="tester" required></label>
        <label>复测 CO2 (ppm)<input type="number" name="co2" required></label>
        <label>复测时间（默认当前）<input type="datetime-local" name="at"></label>
      </div>
      <div class="actions">
        <button>登记通风复测</button>
        <button type="button" class="ghost" data-close="${item.id}">关闭处置</button>
      </div>
    </form>` : '';
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(siteLabel(item.siteId))}</h3><div class="inline-actions">${pill(item.status, toneFor(item.status))}${permit}</div></div>
    <div class="meta">开立 ${fmtDate(item.openedAt)}${item.closedAt ? ` · 关闭 ${fmtDate(item.closedAt)}` : ''} · 处置组：${escapeHtml(team)} · 留档 ${(item.revisions || []).length} 次</div>
    <div class="detail">
      <div>基准CO2<br><strong>${escapeHtml(item.baselineCo2)}ppm</strong></div>
      <div>峰值CO2<br><strong>${escapeHtml(item.peakCo2)}ppm</strong></div>
      <div>复测次数<br><strong>${(item.ventilationChecks || []).length}</strong></div>
    </div>
    ${readings ? `<div class="history"><div class="meta">归单读数</div>${readings}</div>` : ''}
    ${checks ? `<div class="history"><div class="meta">通风复测</div>${checks}</div>` : ''}
    ${recheck}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderIncidentList(view) {
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db.incidents || [])];
  if (status) items = items.filter((item) => item.status === status);
  if (query) {
    items = items.filter((item) => siteLabel(item.siteId).includes(query)
      || (item.readings || []).some((entry) => String(entry.surveyor || '').includes(query))
      || (item.ventilationChecks || []).some((entry) => String(entry.tester || '').includes(query)));
  }
  return items.length ? items.map(renderIncidentCard).join('') : '<div class="empty">暂无处置单</div>';
}

function renderDashboardView(view) {
  const sources = Array.isArray(view.focus) ? view.focus : [view.focus];
  const panels = sources.map((source) => {
    let items = [...(state.db[source.collection] || [])];
    if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
    items = items.slice(0, source.limit || 8);
    const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
    const cards = items.map((item) => renderAnyCard(item, source.collection, cardView)).join('');
    return `<div class="panel"><h2>${escapeHtml(source.title || view.focusTitle || '')}</h2><div class="list">${cards || '<div class="empty">暂无重点事项</div>'}</div></div>`;
  }).join('');
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    ${panels}
  </section>`;
}

function renderIncidentsView(view) {
  return `<section class="view" id="${view.id}">
    <div class="panel">
      <h2>${escapeHtml(view.listTitle)}</h2>
      <div class="toolbar">
        <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
        <select id="status-${view.id}">
          <option value="">全部状态</option>
          ${(view.statusOptions || []).map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
        </select>
      </div>
      <div class="list" id="list-${view.id}">${renderIncidentList(view)}</div>
    </div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'incidents') return renderIncidentsView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const closeBtn = event.target.closest('[data-close]');
  const correctBtn = event.target.closest('[data-correct]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
  if (closeBtn) {
    try {
      await api(`/api/incidents/${closeBtn.dataset.close}/close`, { method: 'POST', body: '{}' });
      await load();
      toast('处置已关闭，许可已恢复');
    } catch (error) {
      toast(error.message);
    }
  }
  if (correctBtn) {
    const { collection, id, field, label } = correctBtn.dataset;
    const item = (state.db[collection] || []).find((entry) => entry.id === id);
    const input = window.prompt(`${label}（当前：${item?.[field] ?? '-'}）`, item?.[field] ?? '');
    if (input === null) return;
    const value = Number(input);
    if (!Number.isFinite(value)) {
      toast('数值无效');
      return;
    }
    try {
      await api(`/api/${collection}/${id}`, { method: 'PATCH', body: JSON.stringify({ [field]: value, historyAction: label }) });
      await load();
      toast('已更正，未关闭处置单已按新值重判');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (!view) return;
  $(`#list-${view.id}`).innerHTML = view.type === 'incidents' ? renderIncidentList(view) : renderList(view);
});

document.addEventListener('submit', async (event) => {
  const recheckForm = event.target.closest('[data-recheck]');
  if (recheckForm) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(recheckForm).entries());
    payload.co2 = Number(payload.co2);
    if (payload.at) payload.at = new Date(payload.at).toISOString();
    else delete payload.at;
    try {
      const result = await api(`/api/incidents/${recheckForm.dataset.recheck}/recheck`, { method: 'POST', body: JSON.stringify(payload) });
      await load();
      toast(result.closed ? '复测合格，处置已关闭并恢复许可' : '复测已登记');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
  form.reset();
  await load();
  toast('已保存');
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
