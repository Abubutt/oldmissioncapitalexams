const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const API_KEY = process.env.OPENAI_API_KEY;

// $ per 1M tokens. Only used for the console cost estimate below — not sent
// anywhere, doesn't affect behavior. Add a row here if you switch models and
// want the estimate to stay accurate; unlisted models just skip the $ line.
const PRICING = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 }
};
let sessionTokens = { prompt: 0, completion: 0 };

function logUsage(usage) {
  if (!usage) return;
  sessionTokens.prompt += usage.prompt_tokens || 0;
  sessionTokens.completion += usage.completion_tokens || 0;
  const price = PRICING[MODEL];
  const callCost = price
    ? (usage.prompt_tokens * price.in + usage.completion_tokens * price.out) / 1e6
    : null;
  const sessionCost = price
    ? (sessionTokens.prompt * price.in + sessionTokens.completion * price.out) / 1e6
    : null;
  const costStr = callCost !== null ? ` (~$${callCost.toFixed(4)}, session total ~$${sessionCost.toFixed(4)})` : '';
  console.log(
    `[openai] ${usage.prompt_tokens} in + ${usage.completion_tokens} out = ${usage.total_tokens} tokens${costStr}`
  );
}

class OpenAIAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIAuthError';
  }
}

class OpenAIModelNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIModelNotFoundError';
  }
}

class OpenAIAPIError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenAIAPIError';
  }
}

async function complete({ system, user, maxTokens }) {
  if (!API_KEY) {
    throw new OpenAIAuthError('OPENAI_API_KEY is not set. Add it to .env.');
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        // Basic JSON mode (guarantees syntactically-valid JSON, not schema
        // conformance) — same object-wrapper convention used for the other
        // providers, validated server-side in generateExam.js either way.
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
  } catch (err) {
    throw new OpenAIAPIError(`Could not reach the OpenAI API: ${err.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new OpenAIAuthError('OpenAI authentication failed. Check OPENAI_API_KEY in .env.');
    }
    if (res.status === 404 || /model.*(not.*found|does not exist)/i.test(body)) {
      throw new OpenAIModelNotFoundError(
        `OpenAI model "${MODEL}" isn't accessible with this key. Set OPENAI_MODEL in .env to a model ` +
          `you have access to (e.g. gpt-4o, gpt-4o-mini, or the current flagship on your account), then restart.`
      );
    }
    throw new OpenAIAPIError(`OpenAI request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  logUsage(data.usage);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new OpenAIAPIError('No content in OpenAI response');
  return text;
}

module.exports = {
  complete,
  MODEL,
  name: 'openai',
  OpenAIAuthError,
  OpenAIModelNotFoundError,
  OpenAIAPIError
};
