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
  if (res.status === 401) {
    showLogin();
    throw new Error('Sessão expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
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

const newPasswordRow = document.getElementById('new-password-row');
document.querySelectorAll('input[name="pw-mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const manual = document.querySelector('input[name="pw-mode"]:checked').value === 'manual';
    newPasswordRow.hidden = !manual;
    document.getElementById('new-password').required = manual;
  });
});

document.getElementById('change-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = document.getElementById('current-password').value;
  const manual = document.querySelector('input[name="pw-mode"]:checked').value === 'manual';
  const newPassword = manual ? document.getElementById('new-password').value : undefined;
  try {
    const data = await api('/api/account/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    document.getElementById('new-password-value').textContent = data.newPassword;
    document.getElementById('password-result').hidden = false;
    e.target.reset();
    newPasswordRow.hidden = true;
  } catch (err) {
    alert(err.message);
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
    alert(err.message);
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
    alert(err.message);
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
  if (!confirm(`Confirma a ação: ${btn.textContent}?`)) return;
  btn.disabled = true;
  const result = document.getElementById('cleanup-result');
  result.textContent = 'Executando...';
  try {
    const endpoint = {
      journal: '/api/cleanup/journal',
      'rotated-logs': '/api/cleanup/rotated-logs',
      'prune-images': '/api/cleanup/prune-images',
      'prune-containers': '/api/cleanup/prune-containers',
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

function renderFailedLogins(list) {
  const tbody = document.querySelector('#failed-logins-table tbody');
  tbody.innerHTML = list.map((entry) => (
    `<tr>
      <td>${entry.ip}</td>
      <td>${fmtGeo(entry.geo)}</td>
      <td class="num">${entry.count}</td>
      <td><div class="row-actions"><button data-block="${entry.ip}" class="danger">Bloquear</button></div></td>
    </tr>`
  )).join('');
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
  renderFailedLogins(failedLogins);
  renderBlockedIps(blockedIps);
}

document.querySelector('#failed-logins-table tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-block]');
  if (!btn) return;
  const ip = btn.dataset.block;
  if (!confirm(`Bloquear o IP ${ip} na porta 22 (SSH)?`)) return;
  btn.disabled = true;
  try {
    await api(`/api/security/block/${ip}`, { method: 'POST' });
    await refreshSecurity();
  } catch (err) {
    alert(err.message);
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
    alert(err.message);
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
