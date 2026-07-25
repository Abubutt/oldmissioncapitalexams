const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
// o4-mini: a reasoning model, switched from gpt-4o after a live comparison
// (2026-07) found it solved a harder discrete-math batch 8/8 correctly,
// including a two-step license-plate count and a generalized pigeonhole
// problem, vs. gpt-4o's 7/8 (it mismarked the permutation count for a word
// with a repeated letter). Costs more per question — reasoning tokens are
// hidden extra output — but Discrete Math is now the largest section by
// weight (see SECTION_EXAM_WEIGHT in lib/generateExam.js), so correctness
// there matters more than shaving a fraction of a cent.
const MODEL = process.env.OPENAI_MODEL || 'o4-mini';
const API_KEY = process.env.OPENAI_API_KEY;

// $ per 1M tokens. Only used for the console cost estimate below — not sent
// anywhere, doesn't affect behavior. Add a row here if you switch models and
// want the estimate to stay accurate; unlisted models just skip the $ line.
// o-series figures found online were inconsistent as of 2026-07 (OpenAI
// revises o-series pricing often) — using the higher of two figures found so
// the estimate errs toward overestimating rather than under. Check your
// actual OpenAI usage dashboard for ground truth, this is a rough guide only.
const PRICING = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'o4-mini': { in: 1.1, out: 4.4 }
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
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  const reasoningStr = reasoningTokens ? ` [${reasoningTokens} reasoning]` : '';
  console.log(
    `[openai] ${usage.prompt_tokens} in + ${usage.completion_tokens} out${reasoningStr} = ${usage.total_tokens} tokens${costStr}`
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
        // max_completion_tokens, not max_tokens — OpenAI rejects max_tokens
        // outright on o-series and gpt-5 models ("Unsupported parameter"),
        // and max_completion_tokens works fine on gpt-4o too, so this is the
        // one to use across the board now, not just for reasoning models.
        max_completion_tokens: maxTokens,
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
          `you have access to (e.g. o4-mini, gpt-4o, gpt-4o-mini, or the current flagship on your account), then restart.`
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
