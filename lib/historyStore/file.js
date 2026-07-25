const fs = require('fs/promises');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, '..', '..', 'data', 'history');
// Pre-existing single-user file from before per-user storage, kept as a
// fallback read so nothing already recorded there just vanishes.
const LEGACY_HISTORY_PATH = path.join(__dirname, '..', '..', 'data', 'history.json');

// Local-disk fallback. Fine for `npm start` on your own machine, but most
// free hosting tiers wipe the filesystem on every redeploy/restart — use the
// redis store (UPSTASH_REDIS_REST_URL/TOKEN) for anything actually deployed.
function fileFor(userKey) {
  return path.join(HISTORY_DIR, `${encodeURIComponent(userKey.toLowerCase().trim())}.json`);
}

async function readRaw(userKey) {
  try {
    return await fs.readFile(fileFor(userKey), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // Fall back to the old shared file so pre-per-user data isn't just lost.
  try {
    return await fs.readFile(LEGACY_HISTORY_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeRaw(userKey, jsonString) {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  await fs.writeFile(fileFor(userKey), jsonString, 'utf8');
}

module.exports = { readRaw, writeRaw, name: 'file' };
