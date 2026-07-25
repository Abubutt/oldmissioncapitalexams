const { getStore } = require('./historyStore');

const MAX_RECENT_QUESTIONS = 150;
const MAX_RUNS_STORED = 50;

// Order here is load-bearing: index into this array is the `s` field on
// every question object, shared between the frontend and the generator.
const SECTION_NAMES = [
  'C++',
  'Python',
  'Data Structures & Algorithms',
  'Operating Systems',
  'Linux / CLI',
  'Networking & General CS'
];

function emptySection() {
  return { totalAnswered: 0, totalCorrect: 0, recentQuestions: [] };
}

function emptyHistory() {
  const sections = {};
  for (const name of SECTION_NAMES) sections[name] = emptySection();
  return { examsTaken: 0, sections, runs: [] };
}

// userKey identifies whose history this is — normalized email, from the
// gate screen. Not verified (no confirmation link, no password) — it's a
// convenient per-person data bucket for a small trusted group behind the
// shared access code, not an authentication system. Anyone who knows (or
// guesses) an email can view/build history under it.
function assertUserKey(userKey) {
  if (typeof userKey !== 'string' || !userKey.trim()) {
    throw new Error('A user email is required.');
  }
}

async function writeHistory(userKey, history) {
  assertUserKey(userKey);
  await getStore().writeRaw(userKey, JSON.stringify(history, null, 2));
}

async function readHistory(userKey) {
  assertUserKey(userKey);
  const raw = await getStore().readRaw(userKey);
  if (raw === null || raw === undefined) {
    const fresh = emptyHistory();
    await writeHistory(userKey, fresh);
    return fresh;
  }

  const parsed = JSON.parse(raw);
  parsed.sections = parsed.sections || {};
  for (const name of SECTION_NAMES) {
    if (!parsed.sections[name]) parsed.sections[name] = emptySection();
  }
  parsed.examsTaken = parsed.examsTaken || 0;
  parsed.runs = Array.isArray(parsed.runs) ? parsed.runs : [];
  return parsed;
}

/**
 * Fold one completed exam's results into userKey's history.
 * `questions` and `answers` are parallel arrays: answers[i] is the selected
 * option index (or null/undefined if skipped) for questions[i].
 */
async function recordResults(userKey, { questions, answers }) {
  assertUserKey(userKey);
  if (!Array.isArray(questions) || !Array.isArray(answers)) {
    throw new Error('questions and answers arrays are required');
  }

  const history = await readHistory(userKey);
  let totalCorrect = 0;

  questions.forEach((q, i) => {
    const sectionName = SECTION_NAMES[q.s];
    if (!sectionName) return;
    const sec = history.sections[sectionName];
    const userAnswer = answers[i];

    if (userAnswer !== null && userAnswer !== undefined) {
      sec.totalAnswered++;
      if (userAnswer === q.a) {
        sec.totalCorrect++;
        totalCorrect++;
      }
    }

    if (typeof q.q === 'string' && q.q.trim()) {
      sec.recentQuestions.push(q.q);
      if (sec.recentQuestions.length > MAX_RECENT_QUESTIONS) {
        sec.recentQuestions = sec.recentQuestions.slice(-MAX_RECENT_QUESTIONS);
      }
    }
  });

  history.examsTaken++;
  history.runs.push({
    date: new Date().toISOString(),
    correct: totalCorrect,
    total: questions.length
  });
  if (history.runs.length > MAX_RUNS_STORED) {
    history.runs = history.runs.slice(-MAX_RUNS_STORED);
  }

  await writeHistory(userKey, history);

  return {
    examsTaken: history.examsTaken,
    sections: history.sections
  };
}

module.exports = {
  readHistory,
  writeHistory,
  recordResults,
  SECTION_NAMES,
  MAX_RECENT_QUESTIONS
};
