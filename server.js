const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');

const dockerApi = require('./docker');
const hostActions = require('./hostActions');
const { lookupGeoBatch } = require('./geo');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ADMIN_USER || !ADMIN_PASSWORD_HASH || !SESSION_SECRET) {
  console.error('ADMIN_USER, ADMIN_PASSWORD_HASH e SESSION_SECRET sao obrigatorios (veja .env.example)');
  process.exit(1);
}

// A senha pode ser trocada em tempo de execucao pelo painel. Como o container e
// efemero (redeploys recriam do zero), a troca precisa sobreviver num mount
// persistente (/data) em vez de so na memoria - senao qualquer redeploy volta
// pra senha antiga do env var. O env var so serve de valor inicial (1o boot).
const DATA_DIR = process.env.DATA_DIR || '/data';
const ACCOUNT_FILE = path.join(DATA_DIR, 'admin.json');

function loadAccount() {
  try {
    const saved = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    if (saved.username && saved.passwordHash) return saved;
  } catch { /* arquivo ainda nao existe: usa o env var */ }
  return { username: ADMIN_USER, passwordHash: ADMIN_PASSWORD_HASH };
}

function saveAccount(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(next), { mode: 0o600 });
}

let account = loadAccount();

function generateStrongPassword(length = 20) {
  // sem caracteres ambiguos (0/O, 1/l/I) pra facilitar digitar/ler se precisar
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(length), (b) => alphabet[b % alphabet.length]).join('');
}

const app = express();
// 2 hops na frente: Cloudflare (proxy) -> Traefik (EasyPanel) -> este app.
// Se algum dia o Cloudflare sair da frente, volte para 1.
app.set('trust proxy', 2);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' },
});

// token -> expiry, used to authenticate the WebSocket upgrade without re-parsing the session cookie
const wsTokens = new Map();
function issueWsToken() {
  const token = crypto.randomBytes(24).toString('hex');
  wsTokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
  return token;
}
function isValidWsToken(token) {
  const expiry = wsTokens.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) { wsTokens.delete(token); return false; }
  return true;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'Nao autenticado' });
}

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Dados invalidos' });
  }
  const userOk = crypto.timingSafeEqual(
    Buffer.from(username.padEnd(64)), Buffer.from(account.username.padEnd(64)),
  );
  const passOk = userOk && await bcrypt.compare(password, account.passwordHash);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'Usuario ou senha invalidos' });
  }
  req.session.authenticated = true;
  res.json({ ok: true, wsToken: issueWsToken() });
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/account/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string') return res.status(400).json({ error: 'Senha atual obrigatoria' });
    const ok = await bcrypt.compare(currentPassword, account.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });

    const finalPassword = typeof newPassword === 'string' && newPassword.length >= 12
      ? newPassword
      : generateStrongPassword();
    const passwordHash = await bcrypt.hash(finalPassword, 12);
    account = { username: account.username, passwordHash };
    saveAccount(account);
    res.json({ ok: true, newPassword: finalPassword });
  } catch (e) { next(e); }
});

app.get('/api/summary', requireAuth, async (req, res, next) => {
  try {
    const [disk, mem, cpu, df, info] = await Promise.all([
      hostActions.diskSummary(),
      hostActions.memSummary(),
      hostActions.cpuSummary(),
      dockerApi.systemDf(),
      dockerApi.docker.info(),
    ]);
    res.json({
      disk,
      ram: { ...mem, cpuCount: info.NCPU },
      cpu,
      docker: {
        images: { count: df.Images.length, sizeBytes: df.Images.reduce((s, i) => s + i.Size, 0), reclaimableBytes: df.Images.filter((i) => i.Containers === 0).reduce((s, i) => s + i.Size, 0) },
        containers: { count: df.Containers.length, sizeBytes: df.Containers.reduce((s, c) => s + (c.SizeRw || 0), 0) },
      },
    });
  } catch (e) { next(e); }
});

app.get('/api/containers', requireAuth, async (req, res, next) => {
  try {
    const containers = await dockerApi.listContainers();
    const withStats = await Promise.all(containers.map(async (c) => {
      if (c.state !== 'running') return { ...c, stats: null };
      try {
        return { ...c, stats: await dockerApi.containerStats(c.id) };
      } catch {
        return { ...c, stats: null };
      }
    }));
    res.json(withStats);
  } catch (e) { next(e); }
});

app.post('/api/containers/:id/:action', requireAuth, async (req, res, next) => {
  const { id, action } = req.params;
  try {
    if (action === 'restart') await dockerApi.restartContainer(id);
    else if (action === 'stop') await dockerApi.stopContainer(id);
    else if (action === 'start') await dockerApi.startContainer(id);
    else return res.status(400).json({ error: 'Acao invalida' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/postgres', requireAuth, async (req, res, next) => {
  try {
    const containers = await dockerApi.listContainers();
    const pgContainers = containers.filter((c) => c.isPostgres && c.state === 'running');
    const results = await Promise.all(pgContainers.map(async (c) => {
      const { user, databases, error } = await dockerApi.listPostgresDatabases(c.id);
      return { container: c.id, name: c.name, user, databases, error: error || null };
    }));
    res.json(results);
  } catch (e) { next(e); }
});

app.post('/api/postgres/:id/:database/vacuum', requireAuth, async (req, res, next) => {
  try {
    const { output, exitCode } = await dockerApi.vacuumDatabase(req.params.id, req.params.database);
    res.json({ ok: exitCode === 0, output });
  } catch (e) { next(e); }
});

app.get('/api/logs/breakdown', requireAuth, async (req, res, next) => {
  try {
    res.json(await hostActions.logBreakdown());
  } catch (e) { next(e); }
});

function parseDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Parametro "days" invalido');
  return days;
}

app.get('/api/cleanup/rotated-logs/preview', requireAuth, async (req, res, next) => {
  try {
    const days = parseDays(req.query.days || 7);
    res.json({ estimatedBytes: await hostActions.rotatedLogsPreview(days) });
  } catch (e) { next(e); }
});

app.post('/api/cleanup/journal', requireAuth, async (req, res, next) => {
  try {
    const days = parseDays((req.body || {}).days || 3);
    const statusCode = await hostActions.vacuumJournal(days);
    res.json({ ok: statusCode === 0 });
  } catch (e) { next(e); }
});

app.post('/api/cleanup/rotated-logs', requireAuth, async (req, res, next) => {
  try {
    const days = parseDays((req.body || {}).days || 7);
    const statusCode = await hostActions.cleanupRotatedLogs(days);
    res.json({ ok: statusCode === 0 });
  } catch (e) { next(e); }
});

app.post('/api/cleanup/prune-images', requireAuth, async (req, res, next) => {
  try { res.json(await dockerApi.pruneImages()); } catch (e) { next(e); }
});

app.post('/api/cleanup/prune-containers', requireAuth, async (req, res, next) => {
  try { res.json(await dockerApi.pruneContainers()); } catch (e) { next(e); }
});

app.get('/api/security/failed-logins', requireAuth, async (req, res, next) => {
  try {
    const list = await hostActions.topFailedLoginIps(20);
    const geoMap = await lookupGeoBatch(list.map((entry) => entry.ip));
    res.json(list.map((entry) => ({ ...entry, geo: geoMap[entry.ip] })));
  } catch (e) { next(e); }
});

app.get('/api/security/blocked-ips', requireAuth, async (req, res, next) => {
  try { res.json(await hostActions.listBlockedIps()); } catch (e) { next(e); }
});

app.post('/api/security/block/:ip', requireAuth, async (req, res, next) => {
  try {
    const { ip } = req.params;
    if (!hostActions.isValidIpv4(ip)) return res.status(400).json({ error: 'IP invalido' });
    // trust proxy:2 ja resolve req.ip para o IP real do visitante atras de Cloudflare+Traefik
    if (ip === req.ip) return res.status(400).json({ error: 'Nao e possivel bloquear o seu proprio IP' });
    await hostActions.blockIp(ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/security/unblock/:ip', requireAuth, async (req, res, next) => {
  try {
    if (!hostActions.isValidIpv4(req.params.ip)) return res.status(400).json({ error: 'IP invalido' });
    await hostActions.unblockIp(req.params.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Erro interno' });
});

const server = app.listen(PORT, () => console.log(`vps-monitor ouvindo na porta ${PORT}`));

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws' || !isValidWsToken(url.searchParams.get('token'))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

async function snapshot() {
  const list = await dockerApi.listContainers();
  const containers = await Promise.all(list.map(async (c) => {
    if (c.state !== 'running') return { ...c, stats: null };
    try { return { ...c, stats: await dockerApi.containerStats(c.id) }; } catch { return { ...c, stats: null }; }
  }));
  return { type: 'snapshot', containers };
}

setInterval(async () => {
  if (wss.clients.size === 0) return;
  try {
    const data = JSON.stringify(await snapshot());
    wss.clients.forEach((client) => { if (client.readyState === 1) client.send(data); });
  } catch (e) { console.error('snapshot error', e); }
}, 5000);
