require('dotenv').config();

const path = require('path');
const express = require('express');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const {
  generateExam,
  DEFAULT_TOTAL_QUESTIONS,
  MIN_TOTAL_QUESTIONS,
  MAX_TOTAL_QUESTIONS
} = require('./lib/generateExam');
const { readHistory, recordResults, SECTION_NAMES } = require('./lib/history');
const { getProvider } = require('./lib/providers');
const { getStore } = require('./lib/historyStore');
const { listMaterials, addMaterial, deleteMaterial } = require('./lib/materials');

const PROVIDER_NAME = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

if (PROVIDER_NAME === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    '\n[startup] ANTHROPIC_API_KEY is not set (LLM_PROVIDER=anthropic).\n' +
      'Either add your key to .env, e.g.:\n' +
      '  cp .env.example .env\n' +
      '  # then edit .env and set ANTHROPIC_API_KEY=sk-ant-...\n' +
      'or switch providers by setting LLM_PROVIDER=ollama or LLM_PROVIDER=openai in .env.\n'
  );
  process.exit(1);
}
if (PROVIDER_NAME === 'openai' && !process.env.OPENAI_API_KEY) {
  console.error(
    '\n[startup] OPENAI_API_KEY is not set (LLM_PROVIDER=openai).\n' +
      'Add it to .env, e.g.:\n' +
      '  OPENAI_API_KEY=sk-...\n'
  );
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB — text is extracted then the buffer is discarded
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// If ACCESS_CODE isn't set (e.g. local dev), the app is open — no gate.
// If it is set (e.g. a public deploy), every protected route requires it.
function requireAccessCode(req, res, next) {
  const configured = process.env.ACCESS_CODE;
  if (!configured) return next();
  if (req.headers['x-access-code'] === configured) return next();
  res.status(401).json({ error: 'unauthorized', message: 'Invalid or missing access code.' });
}

// Email is the per-person storage key (not an authenticated identity — no
// confirmation link, no password). It's what lets someone come back and see
// their own progress with just the access code + the same email, without
// building real accounts.
function requireEmail(req, res, next) {
  const email = (req.headers['x-user-email'] || '').toString().trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email', message: 'A valid email is required.' });
  }
  req.userKey = email;
  next();
}

app.get('/api/gate-status', (req, res) => {
  res.json({ required: Boolean(process.env.ACCESS_CODE) });
});

app.post('/api/login', (req, res) => {
  const { code, email } = req.body || {};
  const normalizedEmail = (email || '').toString().trim().toLowerCase();
  if (!EMAIL_RE.test(normalizedEmail)) {
    return res.status(400).json({ ok: false, message: 'Enter a valid email.' });
  }
  const configured = process.env.ACCESS_CODE;
  if (configured && code !== configured) {
    return res.status(401).json({ ok: false, message: 'Incorrect access code.' });
  }
  res.json({ ok: true });
});

app.post('/api/generate-exam', requireAccessCode, requireEmail, async (req, res) => {
  try {
    const { materialMode, focusSections, totalQuestions, difficulty } = req.body || {};
    const validMode = materialMode === 'material-only' ? 'material-only' : 'blend';
    const validDifficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
    let sections = null;
    if (Array.isArray(focusSections) && focusSections.length > 0) {
      const valid = [...new Set(focusSections.map(Number))].filter(
        (n) => Number.isInteger(n) && n >= 0 && n < SECTION_NAMES.length
      );
      if (valid.length > 0) sections = valid;
    }
    let count = DEFAULT_TOTAL_QUESTIONS;
    if (totalQuestions !== null && totalQuestions !== undefined && totalQuestions !== '') {
      const n = Number(totalQuestions);
      if (Number.isInteger(n)) count = Math.max(MIN_TOTAL_QUESTIONS, Math.min(MAX_TOTAL_QUESTIONS, n));
    }

    const questions = await generateExam(req.userKey, {
      materialMode: validMode,
      focusSections: sections,
      totalQuestions: count,
      difficulty: validDifficulty
    });
    res.json({ questions });
  } catch (err) {
    console.error('[POST /api/generate-exam] failed:', err);

    if (err.name === 'OllamaConnectionError') {
      return res.status(502).json({ error: 'ollama_unreachable', message: err.message });
    }
    if (err.name === 'OllamaModelNotFoundError') {
      return res.status(502).json({ error: 'ollama_model_not_found', message: err.message });
    }
    if (err.name === 'OpenAIAuthError') {
      return res.status(502).json({ error: 'openai_auth_failed', message: err.message });
    }
    if (err.name === 'OpenAIModelNotFoundError') {
      return res.status(502).json({ error: 'openai_model_not_found', message: err.message });
    }
    if (err.name === 'OpenAIAPIError') {
      return res.status(502).json({ error: 'openai_api_error', message: err.message });
    }
    if (err instanceof Anthropic.NotFoundError) {
      const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
      return res.status(502).json({
        error: 'model_not_found',
        message:
          `The model "${model}" was not found or isn't accessible with this API key. ` +
          `Set ANTHROPIC_MODEL in your .env file to a model you have access to (e.g. claude-opus-4-8, ` +
          `claude-sonnet-4-6, or claude-haiku-4-5), then restart the server and try again.`
      });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(502).json({
        error: 'auth_failed',
        message: 'Anthropic API authentication failed. Check that ANTHROPIC_API_KEY in .env is correct.'
      });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({
        error: 'anthropic_api_error',
        message: err.message || 'The Anthropic API returned an error.'
      });
    }

    res.status(500).json({
      error: 'generation_failed',
      message: err.message || 'Failed to generate a new exam.'
    });
  }
});

app.post('/api/record-results', requireAccessCode, requireEmail, async (req, res) => {
  try {
    const summary = await recordResults(req.userKey, req.body || {});
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[POST /api/record-results] failed:', err);
    res.status(400).json({ error: 'record_failed', message: err.message || 'Failed to record results.' });
  }
});

app.get('/api/history', requireAccessCode, requireEmail, async (req, res) => {
  try {
    res.json(await readHistory(req.userKey));
  } catch (err) {
    console.error('[GET /api/history] failed:', err);
    res.status(500).json({ error: 'history_read_failed', message: err.message });
  }
});

// Materials are a shared library (not per-user, unlike history/generation) —
// anyone behind the access code can upload, see, or delete any of them.
app.post('/api/materials', requireAccessCode, upload.single('file'), async (req, res) => {
  try {
    const section = Number(req.body.section);
    if (!Number.isInteger(section) || section < 0 || section >= SECTION_NAMES.length) {
      return res.status(400).json({ error: 'invalid_section', message: 'A valid section is required.' });
    }

    let text = (req.body.text || '').toString();
    let title = (req.body.title || '').toString().trim();

    if (req.file) {
      const isPdf = req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(req.file.originalname || '');
      if (!isPdf) {
        return res.status(400).json({
          error: 'invalid_file',
          message: 'Only PDF file uploads are supported — paste text directly for other formats.'
        });
      }
      const parser = new PDFParse({ data: req.file.buffer });
      const result = await parser.getText();
      text = result.text || '';
      if (!title) title = (req.file.originalname || '').replace(/\.pdf$/i, '');
    }

    const uploadedBy = (req.headers['x-user-email'] || '').toString().trim().toLowerCase() || null;
    const material = await addMaterial({ section, title, text, uploadedBy });
    res.json({ ok: true, material });
  } catch (err) {
    console.error('[POST /api/materials] failed:', err);
    res.status(400).json({ error: 'material_upload_failed', message: err.message || 'Failed to add material.' });
  }
});

app.get('/api/materials', requireAccessCode, async (req, res) => {
  try {
    res.json({ materials: await listMaterials() });
  } catch (err) {
    console.error('[GET /api/materials] failed:', err);
    res.status(500).json({ error: 'materials_read_failed', message: err.message });
  }
});

app.delete('/api/materials/:id', requireAccessCode, async (req, res) => {
  try {
    await deleteMaterial(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/materials] failed:', err);
    res.status(404).json({ error: 'material_not_found', message: err.message || 'Material not found.' });
  }
});

// Catches errors thrown before a route's own try/catch can run — notably
// multer's file-size-limit error, which fires during upload parsing, before
// the /api/materials handler body executes. Without this, such errors would
// fall through to Express's default HTML error page, which breaks every
// frontend fetch() call expecting JSON.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'upload_error', message: err.message });
  }
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'server_error', message: err.message || 'Unexpected server error.' });
});

app.listen(PORT, () => {
  const provider = getProvider();
  const store = getStore();
  console.log(`Old Mission practice exam app running at http://localhost:${PORT}`);
  console.log(`Adaptive question generation provider: ${provider.name} (model: ${provider.MODEL})`);
  console.log(`History store: ${store.name}`);
});
