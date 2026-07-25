const Anthropic = require('@anthropic-ai/sdk');
const { readHistory, SECTION_NAMES } = require('./history');
const { getProvider } = require('./providers');

const TOTAL_QUESTIONS = 50;
const MIN_PER_SECTION = 4;
const RECENT_SAMPLE_SIZE = 40;

/**
 * Split 50 questions across the 6 sections. Every section gets at least
 * MIN_PER_SECTION; the remainder is allocated proportionally to weakness
 * (1 - accuracy), so sections the user is worse at get more new questions.
 * Sections with no history default to a neutral 0.5 accuracy.
 */
function allocateQuestionCounts(history) {
  const n = SECTION_NAMES.length;
  const remaining = TOTAL_QUESTIONS - MIN_PER_SECTION * n;

  const accuracies = SECTION_NAMES.map((name) => {
    const sec = history.sections[name];
    if (!sec || sec.totalAnswered === 0) return 0.5;
    return sec.totalCorrect / sec.totalAnswered;
  });

  // Floor so even a perfect section still gets a small share of new questions.
  const weights = accuracies.map((acc) => Math.max(0.05, 1 - acc));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / weightSum) * remaining);

  const extra = raw.map((r) => Math.floor(r));
  const allocated = extra.reduce((a, b) => a + b, 0);
  let leftover = remaining - allocated;

  const byFraction = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);

  for (let k = 0; k < leftover; k++) {
    extra[byFraction[k % n].i]++;
  }

  return SECTION_NAMES.map((name, i) => ({
    name,
    sIndex: i,
    count: MIN_PER_SECTION + extra[i]
  }));
}

// Question objects live inside a named "questions" field rather than being
// the bare top-level JSON value. Some local models (tested: Ollama +
// llama3:8b) reliably honor "return this object shape" but collapse a
// bare "return a JSON array of N items" instruction down to a single object.
// Wrapping avoids that failure mode and costs nothing for stronger models.
function buildSystemPrompt(sectionName, count) {
  return `You are an exam-question writer creating NEW multiple-choice questions for a technical screening exam (the "Old Mission Capital Jr. Software Engineer" screening).

Write exactly ${count} questions for the section: "${sectionName}".

Match the style and difficulty of a broad CS-fundamentals screening exam for junior software engineers: clear and unambiguous, exactly one correct answer, three plausible distractors, and occasionally a short code snippet (a few lines) when it clarifies the concept being tested. Cover a spread of sub-topics within the section rather than clustering on one narrow idea. Double-check that the option you mark correct is actually correct before responding.

Respond with ONLY valid JSON — no prose, no markdown code fences, no commentary before or after the JSON. The JSON must be a single object of this exact shape: {"questions": [array of exactly ${count} question objects]}. Each question object has this exact shape: {"q": string, "code": string or null, "opts": [string, string, string, string], "a": integer 0-3}. "a" is the zero-based index into "opts" of the correct answer. "code" must be null when no code snippet is needed, not an empty string. The "questions" array MUST contain exactly ${count} items.`;
}

function buildUserPrompt(count, recentQuestions) {
  if (!recentQuestions.length) {
    return `Generate the ${count} questions now as {"questions": [...]}. There are no prior questions to avoid — write fresh, high-quality questions.`;
  }
  const sample = recentQuestions.slice(-RECENT_SAMPLE_SIZE);
  return `Generate the ${count} questions now as {"questions": [...]}. Avoid duplicating or closely paraphrasing any of these previously-used question texts:\n\n${sample
    .map((q) => `- ${q}`)
    .join('\n')}`;
}

function extractQuestionsArray(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in model response');
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed.questions)) {
    throw new Error('Parsed JSON has no "questions" array');
  }
  return parsed.questions;
}

function validateQuestions(arr, sIndex) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('Response contained an empty "questions" array');
  }
  return arr.map((item) => {
    const optsOk =
      Array.isArray(item?.opts) &&
      item.opts.length === 4 &&
      item.opts.every((o) => typeof o === 'string' && o.length > 0);
    const codeOk = item.code === null || item.code === undefined || typeof item.code === 'string';
    const answerOk = typeof item?.a === 'number' && Number.isInteger(item.a) && item.a >= 0 && item.a <= 3;

    if (typeof item?.q !== 'string' || !item.q.trim() || !optsOk || !codeOk || !answerOk) {
      throw new Error('Question object failed schema validation: ' + JSON.stringify(item).slice(0, 300));
    }

    return { s: sIndex, q: item.q, code: item.code ?? null, opts: item.opts, a: item.a };
  });
}

// Roughly 220 tokens per question object (q + 4 opts) plus overhead. Dynamic
// so a lightly-skewed section (e.g. 4 questions) doesn't over-request, and a
// heavily-skewed one (e.g. 25, from adaptive allocation) has enough room.
function estimateMaxTokens(count) {
  return Math.min(8192, count * 220 + 400);
}

// Auth/connection/model-availability failures — retrying the identical
// request won't fix these, so let them propagate immediately instead of
// burning the one parse/validation retry on a request that will fail the
// same way twice.
function isInfraError(err) {
  return (
    err instanceof Anthropic.APIError ||
    err?.name === 'OllamaConnectionError' ||
    err?.name === 'OllamaModelNotFoundError' ||
    err?.name === 'OpenAIAuthError' ||
    err?.name === 'OpenAIModelNotFoundError' ||
    err?.name === 'OpenAIAPIError'
  );
}

async function generateSection(provider, name, sIndex, count, recentQuestions) {
  const system = buildSystemPrompt(name, count);
  const user = buildUserPrompt(count, recentQuestions);
  const maxTokens = estimateMaxTokens(count);

  async function attempt(extraInstruction) {
    const text = await provider.complete({
      system: extraInstruction ? `${system}\n\n${extraInstruction}` : system,
      user,
      maxTokens
    });
    return validateQuestions(extractQuestionsArray(text), sIndex);
  }

  try {
    return await attempt();
  } catch (err) {
    if (isInfraError(err)) throw err;
    console.warn(`[generateExam] retrying section "${name}" after parse/validation failure:`, err.message);
    return await attempt(
      `IMPORTANT: Your previous response was not valid JSON matching the required schema, or did not contain exactly ${count} items in "questions". Return ONLY {"questions": [...]} with exactly ${count} items, no prose, no markdown fences.`
    );
  }
}

async function generateExam(userKey) {
  const provider = getProvider();
  const history = await readHistory(userKey);
  const allocations = allocateQuestionCounts(history);

  const results = await Promise.all(
    allocations.map(({ name, sIndex, count }) =>
      generateSection(provider, name, sIndex, count, history.sections[name]?.recentQuestions || [])
    )
  );

  const questions = results.flat();

  // Shuffle so sections aren't blocked together in the final exam.
  for (let i = questions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [questions[i], questions[j]] = [questions[j], questions[i]];
  }

  return questions;
}

module.exports = { generateExam, allocateQuestionCounts, TOTAL_QUESTIONS };
