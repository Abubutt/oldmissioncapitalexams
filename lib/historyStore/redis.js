const URL_BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Whole-history-as-one-blob-per-user storage against Upstash's REST API (no
// TCP redis client needed — plain fetch, one HTTP call per command). Each
// user's data lives under its own key, so concurrent submissions from
// different people never race each other; survives redeploys/restarts,
// unlike a free host's local disk.
function keyFor(userKey) {
  return `omc:history:${userKey.toLowerCase().trim()}`;
}

async function execute(command) {
  const res = await fetch(URL_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Upstash request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Upstash error: ${data.error}`);
  return data.result;
}

async function readRaw(userKey) {
  return await execute(['GET', keyFor(userKey)]);
}

async function writeRaw(userKey, jsonString) {
  await execute(['SET', keyFor(userKey), jsonString]);
}

module.exports = { readRaw, writeRaw, name: 'upstash-redis' };
