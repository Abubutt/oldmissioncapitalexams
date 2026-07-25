const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

// Constructed lazily (on first complete() call via providers/index.js's require),
// not at server startup, so selecting the ollama provider never requires
// ANTHROPIC_API_KEY to be set.
const client = new Anthropic();

async function complete({ system, user, maxTokens }) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }]
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text content in Anthropic response');
  return textBlock.text;
}

module.exports = { complete, MODEL, name: 'anthropic' };
