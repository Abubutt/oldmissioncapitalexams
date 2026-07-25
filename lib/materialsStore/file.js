const fs = require('fs/promises');
const path = require('path');

const MATERIALS_PATH = path.join(__dirname, '..', '..', 'data', 'materials.json');

// Local-disk fallback, same tradeoffs as lib/historyStore/file.js — fine for
// `npm start`, wiped on redeploy for most free hosts. Single shared blob
// (materials are a shared library, not per-user), so no key parameter.
async function readRaw() {
  try {
    return await fs.readFile(MATERIALS_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeRaw(jsonString) {
  await fs.mkdir(path.dirname(MATERIALS_PATH), { recursive: true });
  await fs.writeFile(MATERIALS_PATH, jsonString, 'utf8');
}

module.exports = { readRaw, writeRaw, name: 'file' };
