// Status store — Vercel KV when configured, in-memory fallback for local dev.
// Each serverless invocation gets a fresh in-memory store, so set up KV for
// persistence across requests (add the Vercel KV integration in the dashboard).

let _mem = {};

async function kv() {
  if (process.env.KV_REST_API_URL || process.env.KV_URL) {
    try {
      const { kv: client } = await import('@vercel/kv');
      return client;
    } catch {}
  }
  return null;
}

export async function setStatus(data) {
  const payload = { ...data, updatedAt: Date.now() };
  const client = await kv();
  if (client) {
    await client.set('booking:status', payload, { ex: 86_400 });
  } else {
    _mem['booking:status'] = payload;
  }
}

export async function getStatus() {
  const client = await kv();
  if (client) return (await client.get('booking:status')) ?? null;
  return _mem['booking:status'] ?? null;
}

export async function appendLog(line) {
  const cur = (await getStatus()) ?? {};
  const ts = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const log = cur.log ? `${cur.log}\n[${ts} PT] ${line}` : `[${ts} PT] ${line}`;
  await setStatus({ ...cur, log });
}
