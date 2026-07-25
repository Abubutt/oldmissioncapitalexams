function getStore() {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return require('./redis');
  }
  return require('./file');
}

module.exports = { getStore };
