function getProvider() {
  const name = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  if (name === 'ollama') return require('./ollama');
  if (name === 'anthropic') return require('./anthropic');
  if (name === 'openai') return require('./openai');
  throw new Error(`Unknown LLM_PROVIDER "${name}". Use "anthropic", "ollama", or "openai".`);
}

module.exports = { getProvider };
