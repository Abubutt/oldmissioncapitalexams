const crypto = require('crypto');
const { getStore } = require('./materialsStore');
const { SECTION_NAMES } = require('./history');

// Caps chosen to keep the shared blob and per-generation prompt cost bounded
// regardless of how much someone uploads — a few chapters' worth is plenty
// for grounding, and unbounded text would both bloat storage and eventually
// exceed the model's context window.
const MAX_TEXT_CHARS = 150000; // ~35-40k tokens of source text, per material
const MAX_MATERIALS = 200; // shared-library sanity cap, not a hard product limit
const CHUNK_SIZE = 2500; // ~600-700 tokens per chunk
const CHUNKS_PER_EXCERPT = 3; // bounds per-section prompt cost regardless of material size

function emptyData() {
  return { materials: [] };
}

async function readMaterials() {
  const raw = await getStore().readRaw();
  if (raw === null || raw === undefined) return emptyData();
  const parsed = JSON.parse(raw);
  parsed.materials = Array.isArray(parsed.materials) ? parsed.materials : [];
  return parsed;
}

async function writeMaterials(data) {
  await getStore().writeRaw(JSON.stringify(data, null, 2));
}

function assertValidSection(section) {
  if (!Number.isInteger(section) || section < 0 || section >= SECTION_NAMES.length) {
    throw new Error(`section must be an integer 0-${SECTION_NAMES.length - 1}`);
  }
}

/**
 * List materials without their full text (keeps the list payload light —
 * text can be 150k chars per item).
 */
async function listMaterials() {
  const data = await readMaterials();
  return data.materials.map(({ text, ...meta }) => ({ ...meta, chars: text.length }));
}

async function addMaterial({ section, title, text, uploadedBy }) {
  assertValidSection(section);
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('No text content to add (empty file or paste).');

  const data = await readMaterials();
  if (data.materials.length >= MAX_MATERIALS) {
    throw new Error(`Shared library is at its ${MAX_MATERIALS}-material cap. Delete something first.`);
  }

  const material = {
    id: crypto.randomUUID(),
    section,
    title: (title || '').trim() || 'Untitled',
    text: trimmed.slice(0, MAX_TEXT_CHARS),
    truncated: trimmed.length > MAX_TEXT_CHARS,
    uploadedBy: uploadedBy || null,
    addedAt: new Date().toISOString()
  };

  data.materials.push(material);
  await writeMaterials(data);

  const { text: _text, ...meta } = material;
  return { ...meta, chars: material.text.length };
}

async function deleteMaterial(id) {
  const data = await readMaterials();
  const before = data.materials.length;
  data.materials = data.materials.filter((m) => m.id !== id);
  if (data.materials.length === before) throw new Error('Material not found.');
  await writeMaterials(data);
}

// Splits on paragraph boundaries, greedily packing paragraphs into
// ~CHUNK_SIZE windows rather than cutting mid-sentence.
function chunkText(text) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    const candidate = current ? `${current}\n\n${p}` : p;
    if (candidate.length > CHUNK_SIZE && current) {
      chunks.push(current);
      current = p;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * For each section that has at least one material, returns a bounded random
 * excerpt (a few chunks joined together) suitable for dropping into a
 * generation prompt. Sections with no material are simply absent from the
 * returned map. Cost stays flat regardless of total library size — always
 * at most CHUNKS_PER_EXCERPT chunks per section, never "the whole textbook."
 */
async function getExcerptsBySection() {
  const data = await readMaterials();
  const bySection = new Map();
  for (const m of data.materials) {
    if (!bySection.has(m.section)) bySection.set(m.section, []);
    bySection.get(m.section).push(m);
  }

  const excerpts = {};
  for (const [section, mats] of bySection) {
    const allChunks = mats.flatMap((m) => chunkText(m.text));
    if (!allChunks.length) continue;
    const pool = [...allChunks];
    const picked = [];
    while (picked.length < Math.min(CHUNKS_PER_EXCERPT, pool.length)) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    excerpts[section] = picked.join('\n\n---\n\n');
  }
  return excerpts;
}

module.exports = {
  listMaterials,
  addMaterial,
  deleteMaterial,
  getExcerptsBySection,
  MAX_TEXT_CHARS,
  MAX_MATERIALS
};
