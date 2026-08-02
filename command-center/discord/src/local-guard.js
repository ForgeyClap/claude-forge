// Beschermt de lokale HTTP-endpoints (dashboard + bot-status) tegen misbruik
// vanuit een browser. Binden op 127.0.0.1 houdt het netwerk buiten, maar niet de
// browser van de eigenaar: een simpele POST vanaf een kwaadaardige pagina bereikt
// localhost wél (CSRF), en een DNS-rebinding-domein kan 127.0.0.1 raken met een
// eigen Host-header. Daarom: Host-allowlist + Origin/Referer-check op writes.
const ALLOWED_HOSTS = (port) =>
  new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

export function guardRequest(req, port) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!ALLOWED_HOSTS(port).has(host)) {
    return { ok: false, code: 403, error: 'ongeldige Host-header' };
  }
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
  const origin = req.headers.origin ?? req.headers.referer ?? null;
  if (isWrite && origin) {
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return { ok: false, code: 403, error: 'ongeldige Origin' };
    }
    if (!ALLOWED_HOSTS(port).has(originHost)) {
      return { ok: false, code: 403, error: 'verzoek van een andere site geweigerd' };
    }
  }
  // Een write zonder Origin/Referer komt niet van een pagina (curl, fetch uit een
  // script op dezelfde machine) — die laten we door, dat is de bedoelde weg.
  return { ok: true };
}
