const Anthropic = require('@anthropic-ai/sdk');
const { readHistory, SECTION_NAMES } = require('./history');
const { getProvider } = require('./providers');
const { getExcerptsBySection } = require('./materials');

const DEFAULT_TOTAL_QUESTIONS = 50;
const MIN_TOTAL_QUESTIONS = 5;
const MAX_TOTAL_QUESTIONS = 150; // server-side safety bound; the UI offers a tighter range
const MIN_PER_SECTION = 4;
// Trimmed from 40: measured ~800 extra input tokens per section call for the
// last 25 items beyond a 15-item sample, with no meaningful dedup benefit —
// 15 recent examples is already enough signal to steer away from repeats.
const RECENT_SAMPLE_SIZE = 15;

/**
 * Split totalQuestions across the 6 sections. Every section gets at least
 * MIN_PER_SECTION (scaled down if totalQuestions is too small to support
 * that floor across all 6); the remainder is allocated proportionally to
 * weakness (1 - accuracy), so sections the user is worse at get more new
 * questions. Sections with no history default to a neutral 0.5 accuracy.
 *
 * If focusSection is given (0-5), the adaptive spread is skipped entirely
 * and all totalQuestions go to that one section — for "just quiz me on
 * Python" instead of the usual broad mix.
 */
function allocateQuestionCounts(history, focusSection, totalQuestions = DEFAULT_TOTAL_QUESTIONS) {
  if (focusSection !== null && focusSection !== undefined) {
    return [{ name: SECTION_NAMES[focusSection], sIndex: focusSection, count: totalQuestions }];
  }

  const n = SECTION_NAMES.length;
  const perSectionFloor = Math.max(1, Math.min(MIN_PER_SECTION, Math.floor(totalQuestions / n)));
  const remaining = totalQuestions - perSectionFloor * n;

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
    count: perSectionFloor + extra[i]
  }));
}

// Question objects live inside a named "questions" field rather than being
// the bare top-level JSON value. Some local models (tested: Ollama +
// llama3:8b) reliably honor "return this object shape" but collapse a
// bare "return a JSON array of N items" instruction down to a single object.
// Wrapping avoids that failure mode and costs nothing for stronger models.
function buildSystemPrompt(sectionName, count, materialExcerpt, materialMode) {
  let prompt = `You are an exam-question writer creating NEW multiple-choice questions for a technical screening exam (the "Old Mission Capital Jr. Software Engineer" screening).

Write exactly ${count} questions for the section: "${sectionName}".

Match the style and difficulty of a broad CS-fundamentals screening exam for junior software engineers: clear and unambiguous, exactly one correct answer, three plausible distractors, and occasionally a short code snippet (a few lines) when it clarifies the concept being tested. Cover a spread of sub-topics within the section rather than clustering on one narrow idea. Double-check that the option you mark correct is actually correct before responding. Keep question text and options tight — one sentence per question where possible, options a few words each, no restating the question, no filler beyond what clarity needs.`;

  if (materialExcerpt) {
    if (materialMode === 'material-only') {
      prompt += `\n\nBase every question strictly on the source material below — test understanding of the specific concepts, facts, or examples it contains, not outside knowledge. If the excerpt doesn't have enough distinct content for ${count} non-redundant questions, cover it as thoroughly as reasonable rather than padding with unrelated general-knowledge questions.\n\n--- SOURCE MATERIAL ---\n${materialExcerpt}\n--- END SOURCE MATERIAL ---`;
    } else {
      prompt += `\n\nAbout half of these questions should be grounded specifically in the source material below (testing concepts, facts, or examples it actually contains); the rest should be general knowledge for this section as usual, same style either way.\n\n--- SOURCE MATERIAL ---\n${materialExcerpt}\n--- END SOURCE MATERIAL ---`;
    }
  }

  prompt += `\n\nRespond with ONLY valid JSON — no prose, no markdown code fences, no commentary before or after the JSON. The JSON must be a single object of this exact shape: {"questions": [array of exactly ${count} question objects]}. Each question object has this exact shape: {"q": string, "code": string or null, "opts": [string, string, string, string], "a": integer 0-3}. "a" is the zero-based index into "opts" of the correct answer. "code" must be null when no code snippet is needed, not an empty string. The "questions" array MUST contain exactly ${count} items.`;

  return prompt;
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

// This is a ceiling, not a cost — only tokens actually generated are billed,
// so a tighter cap doesn't save money by itself. It's here as a backstop
// against a verbose outlier response. Measured ~50-65 tokens/question on
// gpt-4o with the concise-output instruction above; kept at 150/question +
// 300 overhead (not tightened all the way down to that) since this prompt is
// shared across all three providers and a less instruction-compliant local
// model (see Ollama quality notes in the README) may not shrink its output
// as reliably — too tight a cap there risks truncating valid JSON mid-object.
function estimateMaxTokens(count) {
  return Math.min(8192, count * 150 + 300);
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

async function generateSection(provider, name, sIndex, count, recentQuestions, materialExcerpt, materialMode) {
  const system = buildSystemPrompt(name, count, materialExcerpt, materialMode);
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

async function generateExam(userKey, { materialMode = 'blend', focusSection = null, totalQuestions = DEFAULT_TOTAL_QUESTIONS } = {}) {
  const provider = getProvider();
  const history = await readHistory(userKey);
  const clampedTotal = Math.max(MIN_TOTAL_QUESTIONS, Math.min(MAX_TOTAL_QUESTIONS, totalQuestions));
  const allocations = allocateQuestionCounts(history, focusSection, clampedTotal);
  const excerptsBySection = await getExcerptsBySection();

  const results = await Promise.all(
    allocations.map(({ name, sIndex, count }) =>
      generateSection(
        provider,
        name,
        sIndex,
        count,
        history.sections[name]?.recentQuestions || [],
        excerptsBySection[sIndex],
        materialMode
      )
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

module.exports = {
  generateExam,
  allocateQuestionCounts,
  DEFAULT_TOTAL_QUESTIONS,
  MIN_TOTAL_QUESTIONS,
  MAX_TOTAL_QUESTIONS
};
