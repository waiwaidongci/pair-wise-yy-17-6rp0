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
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
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

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

// ---- 高值处置视图 ----

function siteLabel(siteId) {
  const site = state.db.sites?.find((entry) => entry.id === siteId);
  return site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : siteId;
}

function closureProgressText(incident) {
  const rules = state.config.rules;
  const qualifying = (incident.retests || []).filter(
    (retest) => retest.co2 - incident.baselineCo2 <= rules.resumeMargin && !rules.handlingTeam.includes(retest.tester)
  );
  return `达标复测 ${qualifying.length}/${rules.retestsRequired}（非处置组成员、≤基准+${rules.resumeMargin}ppm、间隔≥${rules.retestIntervalMinutes}分钟）`;
}

function renderIncidentCard(incident) {
  const rules = state.config.rules;
  const open = incident.status === '处置中';
  const readings = [...(incident.readings || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  const retests = [...(incident.retests || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  const pills = [pill(incident.status, toneFor(incident.status))];
  if (open && incident.entryHold) pills.push(pill('停发许可', 'bad'));
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(siteLabel(incident.siteId))}</h3><div class="pill-row">${pills.join('')}</div></div>
    <div class="detail">
      <div>基准CO2<br><strong>${incident.baselineCo2}ppm</strong></div>
      <div>触发读数<br><strong>${incident.triggerCo2}ppm</strong></div>
      <div>峰值<br><strong>${incident.peakCo2}ppm</strong></div>
    </div>
    <div class="sublist">
      <h4>归并读数（${readings.length}）</h4>
      ${readings.map((reading) => `<div class="sublist-item"><span>${fmtDate(reading.at)}</span><span>${escapeHtml(reading.reporter)} · ${reading.co2}ppm · 洞内${reading.occupancy}人</span></div>`).join('')}
    </div>
    <div class="sublist">
      <h4>通风复测（${retests.length}）</h4>
      ${retests.length ? retests.map((retest) => {
        const ok = retest.co2 - incident.baselineCo2 <= rules.resumeMargin;
        return `<div class="sublist-item"><span>${fmtDate(retest.at)}</span><span>${escapeHtml(retest.tester)} · ${retest.co2}ppm · ${ok ? '达标' : '未达标'}</span></div>`;
      }).join('') : '<div class="meta">暂无复测</div>'}
    </div>
    ${open ? `<form class="retest-form" data-retest="${incident.id}">
      <div class="meta">${closureProgressText(incident)}</div>
      <div class="form-grid">
        <label>复测人员<input name="tester" required placeholder="须为非处置组成员"></label>
        <label>复测CO2 (ppm)<input type="number" name="co2" required></label>
        <label class="wide">复测时间（留空取当前时间）<input type="datetime-local" name="at"></label>
      </div>
      <div class="actions"><button>登记复测</button></div>
    </form>` : `<div class="meta">已于 ${fmtDate(incident.closedAt)} 关闭，处置留档，许可已恢复。</div>`}
    ${historyHtml(incident)}
  </article>`;
}

function renderIncidentList() {
  const query = $('#search-incidents')?.value.trim() || '';
  const status = $('#status-incidents')?.value || '';
  let items = [...(state.db.incidents || [])];
  if (status) items = items.filter((item) => item.status === status);
  if (query) items = items.filter((item) => siteLabel(item.siteId).includes(query) || String(item.cave || '').includes(query));
  return items.length ? items.map(renderIncidentCard).join('') : '<div class="empty">暂无处置单</div>';
}

function renderIncidentsView(view) {
  const rules = state.config.rules;
  return `<section class="view" id="${view.id}">
    <div class="panel">
      <h2>高值处置单</h2>
      <p class="meta">读数高出基准 ${rules.highMargin}ppm 自动开单；同一样点未关闭时后续读数归并原单，多人同时上报不丢数。读数高超 ${rules.highMargin}ppm 且洞内有人时入口停发许可。关闭需 ${rules.retestsRequired} 次非处置组成员通风复测，间隔≥${rules.retestIntervalMinutes}分钟且均回到基准 ${rules.resumeMargin}ppm 以内。处置组：${rules.handlingTeam.join('、')}。</p>
      <div class="toolbar">
        <input id="search-incidents" placeholder="搜索洞穴、分区、样点">
        <select id="status-incidents">
          <option value="">全部状态</option>
          <option>处置中</option>
          <option>已关闭</option>
        </select>
      </div>
      <div class="list" id="list-incidents">${renderIncidentList()}</div>
    </div>
  </section>`;
}

// ---- 进场许可视图 ----

function heldCaves() {
  const caves = (state.db.incidents || [])
    .filter((incident) => incident.status === '处置中' && incident.entryHold)
    .map((incident) => incident.cave);
  return [...new Set(caves)];
}

function holdBannerHtml() {
  const caves = heldCaves();
  if (!caves.length) return '';
  return `<div class="banner">停发许可：${caves.map(escapeHtml).join('、')}（存在未关闭高值处置单，读数高超基准且洞内有人）</div>`;
}

function renderPermitList() {
  const items = state.db.permits || [];
  if (!items.length) return '<div class="empty">暂无许可记录</div>';
  return items.map((permit) => `<article class="card">
    <div class="card-head"><h3>${escapeHtml(permit.cave)} / ${escapeHtml(permit.team)}</h3>${pill(permit.status, toneFor(permit.status))}</div>
    <div class="meta">${permit.headcount}人 · ${fmtDate(permit.createdAt)}${permit.note ? ' · ' + escapeHtml(permit.note) : ''}</div>
    ${historyHtml(permit)}
  </article>`).join('');
}

function renderPermitsView(view) {
  const caves = [...new Set((state.db.sites || []).map((site) => site.cave).filter(Boolean))];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-permit-form>
        <h2>签发进场许可</h2>
        <div class="form-grid">
          <label class="wide">洞穴<select name="cave" required>${caves.map((cave) => `<option>${escapeHtml(cave)}</option>`).join('')}</select></label>
          <label>队伍/负责人<input name="team" required></label>
          <label>人数<input type="number" name="headcount" min="1" required></label>
          <label class="wide">备注<input name="note"></label>
        </div>
        <div class="actions"><button>签发许可</button></div>
      </form>
      <div class="panel">
        <h2>许可记录</h2>
        <div id="hold-banner">${holdBannerHtml()}</div>
        <div class="list" id="list-permits">${renderPermitList()}</div>
      </div>
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

function renderView(view) {
  if (view.type === 'dashboard') return renderDashboardView(view);
  if (view.type === 'incidents') return renderIncidentsView(view);
  if (view.type === 'permits') return renderPermitsView(view);
  return renderCrudView(view);
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map(renderView).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
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
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'search-incidents' || event.target.id === 'status-incidents') {
    $('#list-incidents').innerHTML = renderIncidentList();
    return;
  }
  const view = state.config.views.find((entry) => entry.collection && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const retestForm = event.target.closest('[data-retest]');
  if (retestForm) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(retestForm).entries());
    payload.co2 = Number(payload.co2);
    if (!payload.at) delete payload.at;
    try {
      const result = await api(`/api/incidents/${retestForm.dataset.retest}/retests`, { method: 'POST', body: JSON.stringify(payload) });
      await load();
      toast(result.closed ? '复测达标，处置已关闭并恢复许可' : '复测已登记');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const permitForm = event.target.closest('[data-permit-form]');
  if (permitForm) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(permitForm).entries());
    payload.headcount = Number(payload.headcount || 0);
    try {
      await api('/api/permits', { method: 'POST', body: JSON.stringify(payload) });
      permitForm.reset();
      await load();
      toast('许可已签发');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  const target = view.endpoint || form.dataset.create;
  try {
    const result = await api(`/api/${target}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
    form.reset();
    await load();
    if (view.endpoint === 'readings' && result?.incident) {
      toast(result.created ? '读数高值，已开立处置单' : '读数已归入未关闭处置单');
    } else {
      toast('已保存');
    }
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
