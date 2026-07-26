// Geolocalizacao por IP via ip-api.com (sem chave). Usa o endpoint de lote
// (ate 100 IPs por chamada) para nao estourar o limite gratuito (45 req/min)
// mesmo com varios IPs novos aparecendo a cada atualizacao da lista de
// tentativas de login. Resultado fica cacheado em memoria (localizacao de
// um IP nao muda entre atualizacoes da tela).
const cache = new Map();

async function lookupGeoBatch(ips) {
  const uncached = [...new Set(ips)].filter((ip) => !cache.has(ip));
  if (uncached.length > 0) {
    try {
      const res = await fetch('http://ip-api.com/batch?fields=status,country,city,query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(uncached),
        signal: AbortSignal.timeout(5000),
      });
      const results = await res.json();
      results.forEach((r) => {
        cache.set(r.query, r.status === 'success' ? { city: r.city || null, country: r.country || null } : { city: null, country: null });
      });
    } catch {
      // sem geolocalizacao agora; tenta de novo na proxima chamada (nao fica em cache)
    }
  }
  return Object.fromEntries(ips.map((ip) => [ip, cache.get(ip) || { city: null, country: null }]));
}

module.exports = { lookupGeoBatch };
