const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

function fmtBytes(bytes) {
  if (bytes == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  // 401 aqui so significa "sessao invalida" - a rota de login (que roda sem
  // sessao ainda) e outras checagens de senha usam 403 justamente pra nao
  // colidir com esse tratamento.
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Sessão expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

const modalBackdrop = document.getElementById('modal-backdrop');
const modalTitleEl = document.getElementById('modal-title');
const modalBodyEl = document.getElementById('modal-body');
const modalFooterEl = document.getElementById('modal-footer');

function openModal({ title, bodyHtml, actions }) {
  return new Promise((resolve) => {
    modalTitleEl.textContent = title;
    modalBodyEl.innerHTML = bodyHtml;
    modalFooterEl.innerHTML = '';

    function close(value) {
      modalBackdrop.hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onKey(e) { if (e.key === 'Escape') close(undefined); }

    actions.forEach((action) => {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.className = action.variant || '';
      btn.type = 'button';
      btn.onclick = () => close(action.value);
      modalFooterEl.appendChild(btn);
    });

    document.addEventListener('keydown', onKey);
    modalBackdrop.onclick = (e) => { if (e.target === modalBackdrop) close(undefined); };
    document.querySelector('.modal-close').onclick = () => close(undefined);
    modalBackdrop.hidden = false;
  });
}

function modalConfirm(message, opts = {}) {
  return openModal({
    title: opts.title || 'Confirmar ação',
    bodyHtml: `<p>${message}</p>`,
    actions: [
      { label: 'Cancelar', value: false, variant: 'ghost' },
      { label: opts.confirmLabel || 'Confirmar', value: true, variant: opts.danger ? 'danger' : '' },
    ],
  }).then((v) => v === true);
}

function modalAlert(message, opts = {}) {
  return openModal({
    title: opts.title || (opts.error ? 'Erro' : 'Aviso'),
    bodyHtml: `<p>${message}</p>`,
    actions: [{ label: 'OK', value: true }],
  });
}

function showLogin() {
  loginScreen.hidden = false;
  appScreen.hidden = true;
}

function showApp() {
  loginScreen.hidden = true;
  appScreen.hidden = false;
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const username = document.getElementById('login-user').value;
  const password = document.getElementById('login-pass').value;
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    showApp();
    boot(data.wsToken);
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

function randomIndex(max) {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % max;
}

function generatePassword({ length, specialCount, upper, lower, digits }) {
  const SPECIAL = '!@#$%^&*()-_=+[]{}';
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LOWER = 'abcdefghijkmnopqrstuvwxyz';
  const DIGITS = '23456789';

  const pools = [];
  if (upper) pools.push(UPPER);
  if (lower) pools.push(LOWER);
  if (digits) pools.push(DIGITS);
  if (pools.length === 0) pools.push(LOWER);

  const special = Math.max(0, Math.min(specialCount, length));
  const chars = [];
  for (let i = 0; i < special; i += 1) chars.push(SPECIAL[randomIndex(SPECIAL.length)]);
  for (let i = chars.length; i < length; i += 1) {
    const pool = pools[i % pools.length];
    chars.push(pool[randomIndex(pool.length)]);
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function setupPasswordGenerator(prefix) {
  const lengthInput = document.getElementById(`${prefix}-length`);
  const specialInput = document.getElementById(`${prefix}-special`);
  const upperInput = document.getElementById(`${prefix}-upper`);
  const lowerInput = document.getElementById(`${prefix}-lower`);
  const digitsInput = document.getElementById(`${prefix}-digits`);
  const previewInput = document.getElementById(`${prefix}-preview`);
  const regenerateBtn = document.getElementById(`${prefix}-regenerate`);

  function regenerate() {
    const length = Math.max(12, Math.min(64, Number(lengthInput.value) || 20));
    const specialCount = Math.max(0, Math.min(length, Number(specialInput.value) || 0));
    lengthInput.value = length;
    specialInput.value = specialCount;
    previewInput.value = generatePassword({
      length,
      specialCount,
      upper: upperInput.checked,
      lower: lowerInput.checked,
      digits: digitsInput.checked,
    });
  }

  [lengthInput, specialInput, upperInput, lowerInput, digitsInput].forEach((el) => {
    el.addEventListener('change', regenerate);
  });
  regenerateBtn.addEventListener('click', regenerate);
  regenerate();

  return () => previewInput.value;
}

const getPanelPassword = setupPasswordGenerator('pw');
const getRootPassword = setupPasswordGenerator('root-pw');

document.getElementById('change-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = getPanelPassword();
  try {
    const data = await api('/api/account/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    document.getElementById('new-password-value').textContent = data.newPassword;
    document.getElementById('password-result').hidden = false;
    document.getElementById('current-password').value = '';
  } catch (err) {
    await modalAlert(err.message, { error: true });
  }
});

document.getElementById('change-root-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await modalConfirm(
    'Isso troca a senha real de <strong>root</strong> usada para acessar a VPS por SSH. Tem certeza que quer continuar?',
    { title: 'Trocar senha do root', confirmLabel: 'Trocar senha do root', danger: true },
  );
  if (!ok) return;

  const currentPassword = document.getElementById('root-current-password').value;
  const newPassword = getRootPassword();
  try {
    const data = await api('/api/vps/root-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    document.getElementById('root-new-password-value').textContent = data.newPassword;
    document.getElementById('root-password-result').hidden = false;
    document.getElementById('root-current-password').value = '';
  } catch (err) {
    await modalAlert(err.message, { error: true });
  }
});

document.getElementById('reboot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await modalConfirm(
    'Isso vai <strong>reiniciar o servidor inteiro agora</strong>. Todos os sites, bancos e este painel ficam fora do ar por 1-2 minutos. Tem certeza?',
    { title: 'Reiniciar VPS', confirmLabel: 'Reiniciar agora', danger: true },
  );
  if (!ok) return;

  const currentPassword = document.getElementById('reboot-current-password').value;
  const result = document.getElementById('reboot-result');
  try {
    await api('/api/vps/reboot', { method: 'POST', body: JSON.stringify({ currentPassword }) });
    document.getElementById('reboot-current-password').value = '';
    result.textContent = 'Comando enviado. O servidor deve voltar em 1-2 minutos.';
  } catch (err) {
    await modalAlert(err.message, { error: true });
  }
});

function severity(pct) {
  return pct > 90 ? 'critical' : pct > 75 ? 'warning' : 'good';
}

function meterTile(label, pct, sub) {
  const color = `var(--${severity(pct)})`;
  return `
    <div class="meter-tile" style="--meter-color: ${color}">
      <div class="meter-header"><span class="label">${label}</span><span class="value">${pct}%</span></div>
      <div class="meter-track"><div class="meter-fill" style="width: ${Math.min(pct, 100)}%"></div></div>
      <div class="sub">${sub}</div>
    </div>`;
}

function renderTiles({ disk, ram, cpu, docker }) {
  const tiles = document.getElementById('tiles');
  tiles.innerHTML = `
    ${meterTile('Disco', disk.usedPercent, `${fmtBytes(disk.availBytes)} livres de ${fmtBytes(disk.totalBytes)}`)}
    ${meterTile('Memória', ram.usedPercent, `${fmtBytes(ram.usedBytes)} de ${fmtBytes(ram.totalBytes)} (${ram.cpuCount} vCPUs)`)}
    ${meterTile('CPU', cpu.usedPercent, 'uso médio no último instante')}
    <div class="tile"><div class="label">Imagens Docker</div><div class="value">${fmtBytes(docker.images.sizeBytes)}</div><div class="sub">${fmtBytes(docker.images.reclaimableBytes)} reaproveitável (${docker.images.count} imagens)</div></div>
    <div class="tile"><div class="label">Containers</div><div class="value">${docker.containers.count}</div><div class="sub">${fmtBytes(docker.containers.sizeBytes)} em disco</div></div>
  `;
}

function renderContainers(list) {
  const tbody = document.querySelector('#containers-table tbody');
  tbody.innerHTML = list.map((c) => {
    const dot = c.state === 'running' ? 'good' : 'muted';
    const stats = c.stats ? `${c.stats.cpuPercent}%` : '-';
    const mem = c.stats ? `${fmtBytes(c.stats.memUsageMB * 1024 * 1024)}` : '-';
    return `<tr>
      <td>${c.name}</td>
      <td>${c.project}</td>
      <td><span class="status-dot ${dot}"></span>${c.status}</td>
      <td class="num">${stats}</td>
      <td class="num">${mem}</td>
      <td><div class="row-actions">
        ${c.state === 'running'
          ? `<button data-id="${c.id}" data-action="restart">Reiniciar</button><button data-id="${c.id}" data-action="stop" class="danger">Parar</button>`
          : `<button data-id="${c.id}" data-action="start">Iniciar</button>`}
      </div></td>
    </tr>`;
  }).join('');
}

document.querySelector('#containers-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await api(`/api/containers/${btn.dataset.id}/${btn.dataset.action}`, { method: 'POST' });
    await refreshContainers();
  } catch (err) {
    await modalAlert(err.message, { error: true });
  } finally {
    btn.disabled = false;
  }
});

async function refreshContainers() {
  renderContainers(await api('/api/containers'));
}

function renderPostgres(list) {
  const tbody = document.querySelector('#postgres-table tbody');
  const rows = [];
  list.forEach((entry) => {
    if (entry.error) {
      rows.push(`<tr><td>${entry.name}</td><td colspan="3" class="muted">Erro: ${entry.error}</td></tr>`);
      return;
    }
    entry.databases.forEach((db) => {
      rows.push(`<tr>
        <td>${entry.name}</td>
        <td>${db.datname}</td>
        <td class="num">${db.sizePretty}</td>
        <td><div class="row-actions"><button data-container="${entry.container}" data-db="${db.datname}">VACUUM</button></div></td>
      </tr>`);
    });
  });
  tbody.innerHTML = rows.join('');
}

document.querySelector('#postgres-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-db]');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Rodando...';
  try {
    const data = await api(`/api/postgres/${btn.dataset.container}/${btn.dataset.db}/vacuum`, { method: 'POST' });
    btn.textContent = data.ok ? 'OK' : 'Falhou';
  } catch (err) {
    btn.textContent = 'Erro';
    await modalAlert(err.message, { error: true });
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = 'VACUUM'; }, 2000);
  }
});

async function refreshPostgres() {
  renderPostgres(await api('/api/postgres'));
}

function renderLogBreakdown(entries) {
  const container = document.getElementById('log-breakdown');
  container.innerHTML = entries.slice(0, 10).map((e) => (
    `<div class="row"><span>${e.path}</span><span class="num">${fmtBytes(e.sizeBytes)}</span></div>`
  )).join('');
}

async function refreshLogBreakdown() {
  renderLogBreakdown(await api('/api/logs/breakdown'));
}

document.querySelector('.cleanup-actions').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const ok = await modalConfirm(`Confirma a ação: <strong>${btn.textContent}</strong>?`, { confirmLabel: 'Confirmar' });
  if (!ok) return;
  btn.disabled = true;
  const result = document.getElementById('cleanup-result');
  result.textContent = 'Executando...';
  try {
    const endpoint = {
      journal: '/api/cleanup/journal',
      'rotated-logs': '/api/cleanup/rotated-logs',
      'prune-images': '/api/cleanup/prune-images',
      'prune-containers': '/api/cleanup/prune-containers',
      'system-trash': '/api/cleanup/system-trash',
    }[action];
    const data = await api(endpoint, { method: 'POST', body: JSON.stringify({}) });
    result.textContent = 'Concluído.';
    await Promise.all([refreshSummary(), refreshLogBreakdown()]);
  } catch (err) {
    result.textContent = `Erro: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

async function refreshSummary() {
  renderTiles(await api('/api/summary'));
}

const HISTORY_SERIES = [
  { key: 'cpu', label: 'CPU', color: 'var(--blue)' },
  { key: 'ram', label: 'Memória', color: 'var(--series-green)' },
  { key: 'disk', label: 'Disco', color: 'var(--series-magenta)' },
];
const CHART_W = 600;
const CHART_H = 220;
const CHART_MARGIN = { top: 10, right: 10, bottom: 20, left: 32 };

let historyData = [];
let historyRangeHours = 24;

function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function chartScales(points) {
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const x = (t) => {
    if (maxT === minT) return CHART_MARGIN.left;
    return CHART_MARGIN.left + ((t - minT) / (maxT - minT)) * (CHART_W - CHART_MARGIN.left - CHART_MARGIN.right);
  };
  const y = (v) => CHART_H - CHART_MARGIN.bottom - (v / 100) * (CHART_H - CHART_MARGIN.top - CHART_MARGIN.bottom);
  return { x, y, minT, maxT };
}

function renderHistoryChart() {
  const svg = document.getElementById('history-chart');
  const cutoff = Date.now() - historyRangeHours * 3600 * 1000;
  const points = historyData.filter((p) => p.t >= cutoff);
  svg.innerHTML = '';
  if (points.length < 2) {
    svg.innerHTML = `<text x="${CHART_W / 2}" y="${CHART_H / 2}" text-anchor="middle" class="chart-axis-label">Ainda coletando histórico…</text>`;
    document.getElementById('chart-legend').innerHTML = '';
    return;
  }

  const { x, y, minT, maxT } = chartScales(points);
  const ns = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();

  [0, 25, 50, 75, 100].forEach((v) => {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', CHART_MARGIN.left); line.setAttribute('x2', CHART_W - CHART_MARGIN.right);
    line.setAttribute('y1', y(v)); line.setAttribute('y2', y(v));
    line.setAttribute('class', 'chart-gridline');
    frag.appendChild(line);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', 2); label.setAttribute('y', y(v) + 3);
    label.setAttribute('class', 'chart-axis-label');
    label.textContent = `${v}%`;
    frag.appendChild(label);
  });

  [minT, (minT + maxT) / 2, maxT].forEach((t, i) => {
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', x(t));
    label.setAttribute('y', CHART_H - 4);
    label.setAttribute('text-anchor', i === 0 ? 'start' : i === 2 ? 'end' : 'middle');
    label.setAttribute('class', 'chart-axis-label');
    label.textContent = fmtTime(t);
    frag.appendChild(label);
  });

  HISTORY_SERIES.forEach((series) => {
    const poly = document.createElementNS(ns, 'polyline');
    poly.setAttribute('points', points.map((p) => `${x(p.t)},${y(p[series.key])}`).join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', series.color);
    poly.setAttribute('stroke-width', '2');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    frag.appendChild(poly);
  });

  const crosshair = document.createElementNS(ns, 'line');
  crosshair.setAttribute('class', 'chart-crosshair');
  crosshair.setAttribute('y1', CHART_MARGIN.top);
  crosshair.setAttribute('y2', CHART_H - CHART_MARGIN.bottom);
  crosshair.setAttribute('visibility', 'hidden');
  frag.appendChild(crosshair);

  svg.appendChild(frag);

  const tooltip = document.getElementById('chart-tooltip');
  svg.onmousemove = (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * CHART_W;
    let nearest = points[0];
    let best = Infinity;
    points.forEach((p) => {
      const d = Math.abs(x(p.t) - mx);
      if (d < best) { best = d; nearest = p; }
    });
    crosshair.setAttribute('x1', x(nearest.t));
    crosshair.setAttribute('x2', x(nearest.t));
    crosshair.setAttribute('visibility', 'visible');
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min((x(nearest.t) / CHART_W) * rect.width + 12, rect.width - 160)}px`;
    tooltip.innerHTML = `
      <div class="time">${fmtTime(nearest.t)}</div>
      ${HISTORY_SERIES.map((s) => `<div class="row"><span class="swatch" style="background:${s.color}"></span>${s.label}: ${nearest[s.key]}%</div>`).join('')}
    `;
  };
  svg.onmouseleave = () => {
    crosshair.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };

  const last = points[points.length - 1];
  document.getElementById('chart-legend').innerHTML = HISTORY_SERIES.map((s) => (
    `<span class="item"><span class="swatch" style="background:${s.color}"></span>${s.label} (${last[s.key]}%)</span>`
  )).join('');
}

document.getElementById('range-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-hours]');
  if (!btn) return;
  document.querySelectorAll('#range-picker button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  historyRangeHours = Number(btn.dataset.hours);
  renderHistoryChart();
});

async function refreshHistory() {
  historyData = await api('/api/metrics/history');
  renderHistoryChart();
}

function fmtGeo(geo) {
  if (!geo || (!geo.city && !geo.country)) return '-';
  return [geo.city, geo.country].filter(Boolean).join(', ');
}

function renderFailedLogins(list, blockedSet) {
  const tbody = document.querySelector('#failed-logins-table tbody');
  tbody.innerHTML = list.map((entry) => {
    const isBlocked = blockedSet.has(entry.ip);
    const status = isBlocked
      ? '<span class="status-dot critical"></span>Bloqueado'
      : '<span class="status-dot good"></span>Liberado';
    const action = isBlocked
      ? `<button data-unblock="${entry.ip}">Liberar</button>`
      : `<button data-block="${entry.ip}" class="danger">Bloquear</button>`;
    return `<tr>
      <td>${entry.ip}</td>
      <td>${fmtGeo(entry.geo)}</td>
      <td class="num">${entry.count}</td>
      <td>${status}</td>
      <td><div class="row-actions">${action}</div></td>
    </tr>`;
  }).join('');
}

function renderBlockedIps(list) {
  const tbody = document.querySelector('#blocked-ips-table tbody');
  tbody.innerHTML = list.length
    ? list.map((ip) => (
      `<tr><td>${ip}</td><td><div class="row-actions"><button data-unblock="${ip}">Liberar</button></div></td></tr>`
    )).join('')
    : '<tr><td colspan="2" class="muted">Nenhum IP bloqueado no momento</td></tr>';
}

async function refreshSecurity() {
  const [failedLogins, blockedIps] = await Promise.all([
    api('/api/security/failed-logins'),
    api('/api/security/blocked-ips'),
  ]);
  renderFailedLogins(failedLogins, new Set(blockedIps));
  renderBlockedIps(blockedIps);
}

document.querySelector('#failed-logins-table tbody').addEventListener('click', async (e) => {
  const blockBtn = e.target.closest('button[data-block]');
  const unblockBtn = e.target.closest('button[data-unblock]');
  const btn = blockBtn || unblockBtn;
  if (!btn) return;

  if (blockBtn) {
    const ip = blockBtn.dataset.block;
    const ok = await modalConfirm(`Bloquear o IP <strong>${ip}</strong> na porta 22 (SSH)?`, { confirmLabel: 'Bloquear', danger: true });
    if (!ok) return;
  }

  const ip = blockBtn ? blockBtn.dataset.block : unblockBtn.dataset.unblock;
  const endpoint = blockBtn ? `/api/security/block/${ip}` : `/api/security/unblock/${ip}`;
  btn.disabled = true;
  try {
    await api(endpoint, { method: 'POST' });
    await refreshSecurity();
  } catch (err) {
    await modalAlert(err.message, { error: true });
    btn.disabled = false;
  }
});

document.querySelector('#blocked-ips-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-unblock]');
  if (!btn) return;
  const ip = btn.dataset.unblock;
  btn.disabled = true;
  try {
    await api(`/api/security/unblock/${ip}`, { method: 'POST' });
    await refreshSecurity();
  } catch (err) {
    await modalAlert(err.message, { error: true });
    btn.disabled = false;
  }
});

let ws;
function connectWs(token) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'snapshot') renderContainers(msg.containers);
  };
  ws.onclose = () => setTimeout(() => connectWs(token), 5000);
}

function boot(wsToken) {
  refreshSummary();
  refreshContainers();
  refreshPostgres();
  refreshLogBreakdown();
  refreshSecurity();
  refreshHistory();
  connectWs(wsToken);
  setInterval(refreshSummary, 15000);
  setInterval(refreshHistory, 60000);
  setInterval(refreshPostgres, 30000);
  setInterval(refreshSecurity, 30000);
}

showLogin();
