require('dotenv').config();

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { generateExam } = require('./lib/generateExam');
const { readHistory, recordResults } = require('./lib/history');
const { getProvider } = require('./lib/providers');

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

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// If ACCESS_CODE isn't set (e.g. local dev), the app is open — no gate.
// If it is set (e.g. a public deploy), every protected route requires it.
function requireAccessCode(req, res, next) {
  const configured = process.env.ACCESS_CODE;
  if (!configured) return next();
  if (req.headers['x-access-code'] === configured) return next();
  res.status(401).json({ error: 'unauthorized', message: 'Invalid or missing access code.' });
}

app.get('/api/gate-status', (req, res) => {
  res.json({ required: Boolean(process.env.ACCESS_CODE) });
});

app.post('/api/login', (req, res) => {
  const configured = process.env.ACCESS_CODE;
  if (!configured) return res.json({ ok: true });
  const { code } = req.body || {};
  if (code === configured) return res.json({ ok: true });
  res.status(401).json({ ok: false, message: 'Incorrect access code.' });
});

app.post('/api/generate-exam', requireAccessCode, async (req, res) => {
  try {
    const questions = await generateExam();
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

app.post('/api/record-results', requireAccessCode, async (req, res) => {
  try {
    const summary = await recordResults(req.body || {});
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[POST /api/record-results] failed:', err);
    res.status(400).json({ error: 'record_failed', message: err.message || 'Failed to record results.' });
  }
});

app.get('/api/history', requireAccessCode, async (req, res) => {
  try {
    res.json(await readHistory());
  } catch (err) {
    console.error('[GET /api/history] failed:', err);
    res.status(500).json({ error: 'history_read_failed', message: err.message });
  }
});

app.listen(PORT, () => {
  const provider = getProvider();
  console.log(`Old Mission practice exam app running at http://localhost:${PORT}`);
  console.log(`Adaptive question generation provider: ${provider.name} (model: ${provider.MODEL})`);
});
