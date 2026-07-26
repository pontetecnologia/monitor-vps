const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

function serviceNameOf(container) {
  const labels = container.Labels || {};
  return labels['com.docker.swarm.service.name'] || (container.Names[0] || '').replace(/^\//, '');
}

function projectOf(serviceName) {
  const idx = serviceName.indexOf('_');
  return idx === -1 ? serviceName : serviceName.slice(0, idx);
}

async function listContainers() {
  const containers = await docker.listContainers({ all: true });
  return containers.map((c) => {
    const serviceName = serviceNameOf(c);
    return {
      id: c.Id,
      name: serviceName,
      project: projectOf(serviceName),
      image: c.Image,
      state: c.State,
      status: c.Status,
      createdAt: c.Created,
      // Image pode ser so um digest sha256 sem RepoTags (imagem "dangling"), entao
      // o nome da imagem nao e confiavel para identificar postgres; a porta 5432
      // exposta pelo entrypoint oficial da imagem e o sinal estavel.
      isPostgres: /^postgres(:|$)/.test(c.Image) || (c.Ports || []).some((p) => p.PrivatePort === 5432),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function containerStats(id) {
  const container = docker.getContainer(id);
  const stats = await container.stats({ stream: false });
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cpuCount = (stats.cpu_stats.cpu_usage.percpu_usage || [1]).length;
  const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpuCount * 100 : 0;
  const memUsage = stats.memory_stats.usage || 0;
  const memLimit = stats.memory_stats.limit || 1;
  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memUsageMB: Math.round(memUsage / 1024 / 1024),
    memPercent: Math.round((memUsage / memLimit) * 1000) / 10,
  };
}

async function restartContainer(id) {
  await docker.getContainer(id).restart({ t: 10 });
}

async function stopContainer(id) {
  await docker.getContainer(id).stop({ t: 10 });
}

async function startContainer(id) {
  await docker.getContainer(id).start();
}

async function systemDf() {
  return docker.df();
}

async function pruneImages() {
  return docker.pruneImages({ filters: { dangling: { false: true } } });
}

async function pruneContainers() {
  return docker.pruneContainers();
}

async function execInContainer(id, cmd) {
  const container = docker.getContainer(id);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  return new Promise((resolve, reject) => {
    exec.start({}, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      container.modem.demuxStream(
        stream,
        { write: (chunk) => { output += chunk.toString(); } },
        { write: (chunk) => { output += chunk.toString(); } },
      );
      stream.on('end', async () => {
        try {
          const info = await exec.inspect();
          resolve({ output, exitCode: info.ExitCode });
        } catch (e) {
          reject(e);
        }
      });
      stream.on('error', reject);
    });
  });
}

async function getPostgresUser(id) {
  const info = await docker.getContainer(id).inspect();
  const env = info.Config.Env || [];
  const match = env.find((e) => e.startsWith('POSTGRES_USER='));
  return match ? match.split('=')[1] : 'postgres';
}

async function listPostgresDatabases(id) {
  const user = await getPostgresUser(id);
  const { output, exitCode } = await execInContainer(id, [
    // -d postgres: psql conecta por padrao a um banco com o mesmo nome do usuario,
    // que nem sempre existe (ex: POSTGRES_USER=ponte sem banco "ponte"). O banco
    // de manutencao "postgres" sempre existe e serve so para consultar o catalogo.
    'psql', '-U', user, '-d', 'postgres', '-t', '-A', '-F', '|',
    '-c', "SELECT datname, pg_database_size(datname), pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname NOT IN ('template0','template1') ORDER BY pg_database_size(datname) DESC;",
  ]);
  if (exitCode !== 0) return { user, databases: [], error: output.trim() };
  const databases = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [datname, sizeBytes, sizePretty] = line.split('|');
      return { datname, sizeBytes: Number(sizeBytes), sizePretty };
    });
  return { user, databases };
}

async function vacuumDatabase(id, datname) {
  const user = await getPostgresUser(id);
  return execInContainer(id, ['vacuumdb', '-U', user, datname]);
}

module.exports = {
  docker,
  listContainers,
  containerStats,
  restartContainer,
  stopContainer,
  startContainer,
  systemDf,
  pruneImages,
  pruneContainers,
  listPostgresDatabases,
  vacuumDatabase,
};
