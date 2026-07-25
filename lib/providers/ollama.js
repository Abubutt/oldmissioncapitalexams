const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'llama3';
// Match to your model's native context window (Llama 3 8B = 8192). A local
// model with a bigger window (e.g. qwen2.5:14b) can raise this via .env.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;

class OllamaConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OllamaConnectionError';
  }
}

class OllamaModelNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OllamaModelNotFoundError';
  }
}

async function complete({ system, user, maxTokens }) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        // Constrains output to syntactically-valid JSON. Doesn't guarantee it
        // matches our schema (array length, field types) — that's still
        // enforced by generateExam.js's validate-then-retry-once logic.
        format: 'json',
        options: {
          num_predict: maxTokens,
          num_ctx: NUM_CTX,
          temperature: 0.8
        },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
  } catch (err) {
    throw new OllamaConnectionError(
      `Could not reach Ollama at ${BASE_URL}. Is "ollama serve" running? (${err.message})`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404 || /not found/i.test(body)) {
      throw new OllamaModelNotFoundError(
        `Ollama model "${MODEL}" isn't pulled. Run: ollama pull ${MODEL}`
      );
    }
    throw new Error(`Ollama request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.message?.content;
  if (!text) throw new Error('No content in Ollama response');
  return text;
}

module.exports = { complete, MODEL, name: 'ollama', OllamaConnectionError, OllamaModelNotFoundError };
