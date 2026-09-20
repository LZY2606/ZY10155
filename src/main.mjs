import './styles.css';

const state = { cases: [], selectedCase: null, plan: null, preview: null, message: null };
const app = document.querySelector('#app');

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'request_failed'), { data, status: response.status });
  return data;
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const badge = (code, text = code) => `<span class="badge ${code === 'error' ? 'error' : code === 'warning' ? 'warning' : 'info'}">${escapeHtml(text)}</span>`;

function matchChips(bindings = []) {
  return `<div class="chips">${bindings.map((binding) => {
    const names = binding.names.length ? binding.names.join(', ') : '(empty)';
    const status = binding.status === 'empty' ? 'error' : binding.status === 'broad' ? 'warning' : 'ok';
    return `<span class="badge ${status}">${escapeHtml(binding.reference.command || 'literal')}</span><span class="chip mono">${escapeHtml(names)}</span>`;
  }).join('')}</div>`;
}

function constraintRows(entries) {
  return entries.map((entry) => {
    const groups = ['targets', 'sources', 'from', 'to', 'through'].map((key) => matchChips(entry.objectBindings?.[key])).join('');
    const diag = entry.diagnostics.map((item) => badge(item.severity, item.code)).join('');
    const date = entry.dateStatus === 'active' ? '<span class="badge ok">active</span>' : `<span class="badge muted-badge">${entry.dateStatus}</span>`;
    const effective = entry.effective ? '<span class="badge ok">effective</span>' : '<span class="badge muted-badge">shadowed/invalid</span>';
    return `<tr>
      <td class="mono">${escapeHtml(entry.layerId)}:${escapeHtml(entry.line)}<br>${escapeHtml(entry.kind)}</td>
      <td>${effective}${date}${entry.disabled ? badge('warning', 'disabled') : ''}${diag}</td>
      <td>${groups || '<span class="muted">none</span>'}<div class="muted">${escapeHtml(entry.reason || '')}</div></td>
      <td>${editControls(entry)}</td>
    </tr>`;
  }).join('');
}

function editControls(entry) {
  if (state.plan?.status !== 'draft' || !entry.effective) return '';
  const editable = ['set_false_path', 'set_multicycle_path'].includes(entry.kind);
  if (!editable) return '';
  const fromPattern = entry.objectBindings.from?.[0]?.reference?.patterns?.[0];
  const patternKey = `pattern:${entry.id}:from:0`;
  const exceptionKey = `exception:${entry.id}`;
  const patternRevision = state.plan.edits.find((edit) => edit.objectKey === patternKey)?.objectRevision ?? 0;
  const exceptionRevision = state.plan.edits.find((edit) => edit.objectKey === exceptionKey)?.objectRevision ?? 0;
  return `<div class="small">
    <button data-action="edit-pattern" data-entry="${escapeHtml(entry.id)}" data-field="from" data-index="0" data-revision="${patternRevision}">改 from 模式</button>
    <button class="secondary" data-action="disable" data-entry="${escapeHtml(entry.id)}" data-revision="${exceptionRevision}">禁用例外</button>
    ${fromPattern ? `<div class="muted mono">${escapeHtml(fromPattern)}</div>` : ''}
  </div>`;
}

function renderClockGraph(graph) {
  const nodes = graph.nodes;
  const width = 720;
  const height = 220;
  const xStep = width / (nodes.length + 1);
  const pos = new Map(nodes.map((node, index) => [node.name, { x: xStep * (index + 1), y: node.kind === 'base' ? 70 : 160 }]));
  const edges = graph.edges.map((edge) => {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#486581" stroke-width="2" marker-end="url(#arrow)"/>`;
  }).join('');
  const circles = nodes.map((node) => {
    const p = pos.get(node.name);
    return `<g><circle cx="${p.x}" cy="${p.y}" r="24" fill="${node.kind === 'base' ? '#dbeafe' : '#dcfce7'}" stroke="#315a99"/>
      <text x="${p.x}" y="${p.y + 4}" text-anchor="middle" class="node-label">${escapeHtml(node.name)}</text>
      <text x="${p.x}" y="${p.y + 46}" text-anchor="middle" class="edge-label">${node.period ? `${node.period}ns` : `/ ${node.divideBy || node.multiplyBy || '?'}`}</text></g>`;
  }).join('');
  return `<svg class="clock-svg" viewBox="0 0 ${width} ${height}">
    <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#486581"/></marker></defs>
    ${edges}${circles}</svg>`;
}

function endpointRows() {
  const changes = new Map((state.plan?.changedEndpoints || []).map((change) => [change.endpointId, change]));
  return state.plan.endpoints.map((endpoint) => {
    const change = changes.get(endpoint.id);
    const trace = endpoint.trace.map((item) => `<div class="mono">${escapeHtml(item.effect)}: ${escapeHtml(item.entryId)}</div>`).join('') || '<span class="muted">default timing</span>';
    return `<tr>
      <td class="mono">${escapeHtml(endpoint.id)}<br>${escapeHtml(endpoint.from)} → ${escapeHtml(endpoint.to)}</td>
      <td><span class="badge ${endpoint.conclusion === 'timed' ? 'info' : 'warning'}">${endpoint.conclusion}</span>${change ? '<span class="badge error">will change</span>' : ''}</td>
      <td>${trace}</td>
      <td>${change ? `<div class="diff-before small">${escapeHtml(change.before?.conclusion || 'missing')}</div><div class="diff-after small">${escapeHtml(change.after?.conclusion || 'missing')}</div>` : '<span class="muted">无变化</span>'}</td>
    </tr>`;
  }).join('');
}

function renderEditor() {
  if (!state.preview) return '';
  return `<div class="editor">
    <h2>提交前影响预览</h2>
    <div class="muted">${state.preview.changes.length} 个 endpoint 结论会改变</div>
    ${state.preview.changes.map((change) => `<div class="mono small">${escapeHtml(change.endpointId)}: <span class="diff-before">${escapeHtml(change.before?.conclusion || 'missing')}</span> → <span class="diff-after">${escapeHtml(change.after?.conclusion || 'missing')}</span></div>`).join('')}
    <div class="row" style="margin-top:10px"><input id="new-pattern" type="text" style="min-width:280px" placeholder="对象模式，例如 U_CORE/U_FSM/state*"><button id="confirm-edit">确认编辑</button><button class="secondary" id="cancel-edit">取消</button></div>
  </div>`;
}

function render() {
  const plan = state.plan;
  app.innerHTML = `
    <header class="topbar"><h1>SDC 约束审查</h1><div class="small">规则版本 ${plan?.ruleVersion || '1.0.0'} · as-of ${plan?.asOf || '-'}</div></header>
    <div class="layout">
      <aside class="sidebar">
        <div class="panel"><h2>Fixture</h2>${state.cases.map((item) => `<button class="case-button ${state.selectedCase === item.id ? 'active' : ''}" data-case="${item.id}">${escapeHtml(item.name)}<br><span class="muted">${item.id}</span></button>`).join('')}</div>
        ${plan ? `<div class="panel"><h2>合并计划</h2><p><span class="badge ${plan.status === 'published' ? 'ok' : 'info'}">${plan.status}</span><span class="badge muted-badge">rev ${plan.revision}</span></p>
          <p class="muted mono">input ${plan.inputFingerprint.slice(0, 18)}</p>
          <div class="row"><input type="date" id="as-of" value="${plan.asOf}"><button class="secondary" id="reopen-date">重建</button></div>
          <div class="row" style="margin-top:10px"><button id="freeze" ${plan.status !== 'draft' ? 'disabled' : ''}>冻结计划</button><button id="publish" ${plan.status !== 'frozen' ? 'disabled' : ''}>发布</button></div>
          ${renderEditor()}
        </div>` : ''}
      </aside>
      <main class="content">
        ${state.message ? `<div class="panel">${badge(state.message.type, state.message.text)}</div>` : ''}
        ${plan ? `
        <section class="panel"><h2>诊断</h2>${plan.merged.diagnostics.map((item) => `<div>${badge(item.severity, item.code)} <span class="small">${escapeHtml(item.message)} @ ${escapeHtml(item.layerId || '')}:${escapeHtml(item.line || '')}</span></div>`).join('') || '<span class="muted">无</span>'}</section>
        <section class="grid2">
          <div class="panel"><h2>时钟派生图</h2>${renderClockGraph(plan.merged.clockGraph)}</div>
          <div class="panel"><h2>Multicycle 关联</h2>${plan.merged.multicycle.map((pair) => `<div class="small mono">setup=${pair.setup?.pathCount ?? '-'} hold=${pair.hold?.pathCount ?? '-'}<br>${escapeHtml(pair.pathKey)}</div>`).join('')}</div>
        </section>
        <section class="panel"><h2>对象匹配与约束层</h2><table><thead><tr><th>条目</th><th>状态</th><th>匹配集</th><th>操作</th></tr></thead><tbody>${constraintRows(plan.merged.entries)}</tbody></table></section>
        <section class="panel"><h2>Endpoint 有效约束追踪</h2><table><thead><tr><th>Endpoint</th><th>结论</th><th>追踪</th><th>影响</th></tr></thead><tbody>${endpointRows()}</tbody></table></section>` : '<div class="panel">请选择一个 fixture。</div>'}
      </main>
    </div>`;
}

async function loadCases() {
  state.cases = (await api('/api/cases')).cases;
  state.selectedCase = state.cases[0]?.id ?? null;
  if (state.selectedCase) await openPlan();
  render();
}

async function openPlan(asOf = '2026-09-21') {
  state.plan = await api('/api/plans', { method: 'POST', body: { caseId: state.selectedCase, asOf } });
  state.preview = null;
}

app.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    state.message = null;
    const caseId = target.dataset.case;
    if (caseId) {
      state.selectedCase = caseId;
      await openPlan(document.querySelector('#as-of')?.value || '2026-09-21');
      return render();
    }
    if (target.id === 'reopen-date') return openPlan(document.querySelector('#as-of').value).then(render);
    if (target.id === 'freeze') { state.plan = await api(`/api/plans/${state.plan.id}/freeze`, { method: 'POST' }); return render(); }
    if (target.id === 'publish') { state.plan = await api(`/api/plans/${state.plan.id}/publish`, { method: 'POST' }); return render(); }
    if (target.id === 'cancel-edit') { state.preview = null; return render(); }

    const entryId = target.dataset.entry;
    if (target.dataset.action === 'disable') {
      state.preview = await api(`/api/plans/${state.plan.id}/preview`, { method: 'POST', body: { type: 'disable_exception', targetEntryId: entryId } });
      state.pendingEdit = { type: 'disable_exception', targetEntryId: entryId, expectedObjectRevision: Number(target.dataset.revision || 0) };
      return render();
    }
    if (target.dataset.action === 'edit-pattern') {
      const entry = state.plan.merged.entries.find((item) => item.id === entryId);
      const pattern = entry.objectBindings.from[0].reference.patterns[0];
      state.preview = await api(`/api/plans/${state.plan.id}/preview`, { method: 'POST', body: { type: 'change_pattern', targetEntryId: entryId, field: 'from', collectionIndex: 0, pattern } });
      state.pendingEdit = { type: 'change_pattern', targetEntryId: entryId, field: 'from', collectionIndex: 0, pattern, expectedObjectRevision: Number(target.dataset.revision || 0) };
      return render();
    }
    if (target.id === 'confirm-edit') {
      if (state.pendingEdit.type === 'change_pattern') state.pendingEdit.pattern = document.querySelector('#new-pattern').value;
      const result = await api(`/api/plans/${state.plan.id}/edits`, { method: 'POST', body: state.pendingEdit });
      state.plan = result.plan;
      state.preview = null;
      state.pendingEdit = null;
      return render();
    }
  } catch (error) {
    state.message = { type: 'error', text: `${error.message} ${JSON.stringify(error.data || {})}` };
    render();
  }
});

loadCases().catch((error) => {
  app.innerHTML = `<pre>${escapeHtml(error.stack)}</pre>`;
});
