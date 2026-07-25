const URL_BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'omc:materials';

// Single shared key — materials are a shared library across everyone behind
// the access code, unlike history which is keyed per user.
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

async function readRaw() {
  return await execute(['GET', KEY]);
}

async function writeRaw(jsonString) {
  await execute(['SET', KEY, jsonString]);
}

module.exports = { readRaw, writeRaw, name: 'upstash-redis' };
