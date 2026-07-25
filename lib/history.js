const fs = require('fs/promises');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '..', 'data', 'history.json');
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

async function writeHistory(history) {
  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
}

async function readHistory() {
  let raw;
  try {
    raw = await fs.readFile(HISTORY_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const fresh = emptyHistory();
      await writeHistory(fresh);
      return fresh;
    }
    throw err;
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
 * Fold one completed exam's results into history.json.
 * `questions` and `answers` are parallel arrays: answers[i] is the selected
 * option index (or null/undefined if skipped) for questions[i].
 */
async function recordResults({ questions, answers }) {
  if (!Array.isArray(questions) || !Array.isArray(answers)) {
    throw new Error('questions and answers arrays are required');
  }

  const history = await readHistory();
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

  await writeHistory(history);

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
