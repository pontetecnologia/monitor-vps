const { execFile } = require('child_process');
const { promisify } = require('util');
const { Writable } = require('stream');
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

async function memSummary() {
  const { stdout } = await execFileAsync('cat', [`${HOSTFS}/proc/meminfo`]);
  const kb = Object.fromEntries(stdout.split('\n').filter(Boolean).map((line) => {
    const [key, value] = line.split(':');
    return [key.trim(), parseInt(value, 10)];
  }));
  const totalBytes = kb.MemTotal * 1024;
  const availBytes = kb.MemAvailable * 1024;
  const usedBytes = totalBytes - availBytes;
  return {
    totalBytes,
    usedBytes,
    availBytes,
    usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10,
  };
}

function readCpuTicks(stdout) {
  const fields = stdout.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = fields[3] + (fields[4] || 0); // idle + iowait
  const total = fields.reduce((sum, v) => sum + v, 0);
  return { idle, total };
}

async function cpuSummary() {
  const first = readCpuTicks((await execFileAsync('cat', [`${HOSTFS}/proc/stat`])).stdout);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = readCpuTicks((await execFileAsync('cat', [`${HOSTFS}/proc/stat`])).stdout);
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  const usedPercent = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0;
  return { usedPercent };
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

function collectorStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, enc, cb) { chunks.push(chunk); cb(); },
  });
  return { stream, get output() { return Buffer.concat(chunks).toString('utf8'); } };
}

async function runHostContainer(cmd, extraHostConfig = {}) {
  await ensureImage('alpine:3');
  const container = await docker.createContainer({
    Image: 'alpine:3',
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: { Binds: ['/:/host:rw'], AutoRemove: true, ...extraHostConfig },
  });
  const stdout = collectorStream();
  const stderr = collectorStream();
  const stream = await container.attach({ stream: true, stdout: true, stderr: true });
  container.modem.demuxStream(stream, stdout.stream, stderr.stream);
  await container.start();
  const { StatusCode } = await container.wait();
  return { statusCode: StatusCode, output: stdout.output + stderr.output };
}

// Igual ao runHostContainer, mas escreve dados no stdin do container em vez de
// so ler a saida. Usado pra trocar a senha do root sem nunca colocar a senha em
// texto puro num argumento de comando (isso ficaria visivel via `docker inspect`
// enquanto o container efemero ainda existe) - vai só pelo stdin, que nao fica
// registrado em lugar nenhum.
async function runHostContainerWithStdin(cmd, stdinData, extraHostConfig = {}) {
  await ensureImage('alpine:3');
  const container = await docker.createContainer({
    Image: 'alpine:3',
    Cmd: cmd,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: { Binds: ['/:/host:rw'], AutoRemove: true, ...extraHostConfig },
  });
  const stdout = collectorStream();
  const stderr = collectorStream();
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true });
  container.modem.demuxStream(stream, stdout.stream, stderr.stream);
  await container.start();
  stream.write(stdinData);
  stream.end();
  const { StatusCode } = await container.wait();
  return { statusCode: StatusCode, output: stdout.output + stderr.output };
}

async function changeRootPassword(newPassword) {
  const { statusCode, output } = await runHostContainerWithStdin(
    ['chroot', '/host', 'chpasswd'],
    `root:${newPassword}\n`,
  );
  if (statusCode !== 0) throw new Error(`Falha ao trocar a senha do root: ${output.trim()}`);
}

async function vacuumJournal(days) {
  const { statusCode } = await runHostContainer(['chroot', '/host', 'journalctl', `--vacuum-time=${days}d`]);
  return statusCode;
}

async function cleanupRotatedLogs(days) {
  const { statusCode } = await runHostContainer([
    'sh', '-c',
    `find /host/var/log -type f \\( -name "*.gz" -o -name "*.log.[0-9]*" -o -name "*.[0-9]" \\) -mtime +${days} -delete`,
  ]);
  return statusCode;
}

// Bloqueios ficam restritos a porta 22 (SSH). Isso e proposital: o painel chega
// pelo Cloudflare/Traefik nas portas 80/443, entao nenhum bloqueio feito aqui
// pode derrubar o acesso ao proprio painel.
const FIREWALL_HOST_CONFIG = { NetworkMode: 'host', CapAdd: ['NET_ADMIN'] };
const BLOCK_CHAIN = 'VPS_MONITOR_BLOCK';

function isValidIpv4(ip) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)
    && ip.split('.').every((octet) => Number(octet) <= 255);
}

async function topFailedLoginIps(limit = 20) {
  const { output } = await runHostContainer([
    'chroot', '/host', 'sh', '-c',
    "lastb -i 2>/dev/null | awk '{print $3}' | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' | sort | uniq -c | sort -rn",
  ]);
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)$/);
      return match ? { ip: match[2], count: Number(match[1]) } : null;
    })
    .filter(Boolean);
}

async function ensureBlockChain() {
  await runHostContainer([
    'chroot', '/host', 'sh', '-c',
    `iptables -N ${BLOCK_CHAIN} 2>/dev/null; iptables -C INPUT -j ${BLOCK_CHAIN} 2>/dev/null || iptables -I INPUT 1 -j ${BLOCK_CHAIN}`,
  ], FIREWALL_HOST_CONFIG);
}

async function blockIp(ip) {
  if (!isValidIpv4(ip)) throw new Error('IP invalido');
  await ensureBlockChain();
  const rule = ['chroot', '/host', 'iptables', '-C', BLOCK_CHAIN, '-s', ip, '-p', 'tcp', '--dport', '22', '-j', 'DROP'];
  const check = await runHostContainer(rule, FIREWALL_HOST_CONFIG);
  if (check.statusCode !== 0) {
    await runHostContainer(['chroot', '/host', 'iptables', '-A', BLOCK_CHAIN, '-s', ip, '-p', 'tcp', '--dport', '22', '-j', 'DROP'], FIREWALL_HOST_CONFIG);
  }
}

async function unblockIp(ip) {
  if (!isValidIpv4(ip)) throw new Error('IP invalido');
  await runHostContainer(['chroot', '/host', 'iptables', '-D', BLOCK_CHAIN, '-s', ip, '-p', 'tcp', '--dport', '22', '-j', 'DROP'], FIREWALL_HOST_CONFIG);
}

async function listBlockedIps() {
  const { output } = await runHostContainer([
    'chroot', '/host', 'sh', '-c',
    `iptables -L ${BLOCK_CHAIN} -n 2>/dev/null | awk 'NR>2 {print $4}'`,
  ], FIREWALL_HOST_CONFIG);
  return output.trim().split('\n').filter(Boolean);
}

module.exports = {
  diskSummary,
  memSummary,
  cpuSummary,
  logBreakdown,
  rotatedLogsPreview,
  vacuumJournal,
  cleanupRotatedLogs,
  topFailedLoginIps,
  blockIp,
  unblockIp,
  listBlockedIps,
  isValidIpv4,
  changeRootPassword,
};
