const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { docker } = require('./docker');

const HOSTFS = '/hostfs';

async function diskSummary() {
  const { stdout } = await execFileAsync('df', ['-B1', HOSTFS]);
  const line = stdout.trim().split('\n')[1];
  const parts = line.trim().split(/\s+/);
  const [, totalBytes, usedBytes, availBytes] = parts;
  return {
    totalBytes: Number(totalBytes),
    usedBytes: Number(usedBytes),
    availBytes: Number(availBytes),
    usedPercent: Math.round((Number(usedBytes) / Number(totalBytes)) * 1000) / 10,
  };
}

async function logBreakdown() {
  const { stdout } = await execFileAsync('du', ['-sb', ...await listVarLogEntries()]);
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sizeBytes, path] = line.split(/\t/);
      return { path: path.replace(HOSTFS, ''), sizeBytes: Number(sizeBytes) };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 20);
}

async function listVarLogEntries() {
  const { stdout } = await execFileAsync('sh', ['-c', `ls -d ${HOSTFS}/var/log/* 2>/dev/null`]);
  return stdout.trim().split('\n').filter(Boolean);
}

async function rotatedLogsPreview(days) {
  const { stdout } = await execFileAsync('sh', [
    '-c',
    `find ${HOSTFS}/var/log -type f \\( -name "*.gz" -o -name "*.log.[0-9]*" -o -name "*.[0-9]" \\) -mtime +${days} -printf '%s\\n' | awk '{s+=$1} END {print s+0}'`,
  ]);
  return Number(stdout.trim());
}

async function ensureImage(image) {
  try {
    await docker.getImage(image).inspect();
  } catch {
    const stream = await docker.pull(image);
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }
}

async function runHostContainer(cmd) {
  await ensureImage('alpine:3');
  const [data] = await docker.run('alpine:3', cmd, process.stdout, {
    HostConfig: { Binds: ['/:/host:rw'], AutoRemove: true },
  });
  return data.StatusCode;
}

async function vacuumJournal(days) {
  return runHostContainer(['chroot', '/host', 'journalctl', `--vacuum-time=${days}d`]);
}

async function cleanupRotatedLogs(days) {
  return runHostContainer([
    'sh', '-c',
    `find /host/var/log -type f \\( -name "*.gz" -o -name "*.log.[0-9]*" -o -name "*.[0-9]" \\) -mtime +${days} -delete`,
  ]);
}

module.exports = { diskSummary, logBreakdown, rotatedLogsPreview, vacuumJournal, cleanupRotatedLogs };
