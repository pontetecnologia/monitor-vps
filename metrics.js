const fs = require('fs');
const path = require('path');
const hostActions = require('./hostActions');

const DATA_DIR = process.env.DATA_DIR || '/data';
const HISTORY_FILE = path.join(DATA_DIR, 'metrics-history.json');
const RETENTION_MS = 48 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 60 * 1000;

let history = [];

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const cutoff = Date.now() - RETENTION_MS;
    history = Array.isArray(raw) ? raw.filter((s) => s.t >= cutoff) : [];
  } catch {
    history = [];
  }
}

function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) {
    console.error('Falha ao salvar historico de metricas:', e.message);
  }
}

async function sampleOnce() {
  try {
    const [disk, ram, cpu] = await Promise.all([
      hostActions.diskSummary(),
      hostActions.memSummary(),
      hostActions.cpuSummary(),
    ]);
    const cutoff = Date.now() - RETENTION_MS;
    history = history.filter((s) => s.t >= cutoff);
    history.push({ t: Date.now(), disk: disk.usedPercent, ram: ram.usedPercent, cpu: cpu.usedPercent });
    saveHistory();
  } catch (e) {
    console.error('Falha ao coletar amostra de metricas:', e.message);
  }
}

function start() {
  loadHistory();
  sampleOnce();
  setInterval(sampleOnce, SAMPLE_INTERVAL_MS);
}

function getHistory() {
  return history;
}

module.exports = { start, getHistory };
