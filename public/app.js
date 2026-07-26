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
  connectWs(wsToken);
  setInterval(refreshSummary, 15000);
  setInterval(refreshPostgres, 30000);
  setInterval(refreshSecurity, 30000);
}

showLogin();
