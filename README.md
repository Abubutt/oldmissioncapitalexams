# Old Mission Capital — Adaptive Practice Exam

A local full-stack practice exam app for the Old Mission Capital Jr. SWE screening
(C++, Python, Data Structures & Algorithms, Operating Systems, Linux/CLI, Networking).
Ships with a built-in 50-question bank, and can generate brand-new, adaptive 50-question
exams on demand using an LLM (Claude or a local Ollama model) — weaker sections get
more new questions.

## Architecture

- **Backend:** Node.js + Express (`server.js`), serving `public/` as static files.
- **`POST /api/generate-exam`:** reads your history, allocates 50 questions across
  the 6 sections (weaker sections get more, every section gets a minimum of 4),
  and calls the configured LLM provider once per section **in parallel** to write
  new multiple-choice questions, avoiding recent duplicates. Responses are validated
  as JSON server-side and retried once on a parse/schema failure.
- **`POST /api/record-results`:** called by the frontend on submit; updates
  `data/history.json` with per-section accuracy and recently-seen question text.
- **`GET /api/history`:** returns the raw history file (used to render the
  "Practice history" panel on the results screen).
- **`lib/providers/`** — pluggable model backend (`anthropic.js` / `ollama.js`),
  selected via `LLM_PROVIDER` in `.env`. `generateExam.js` is provider-agnostic:
  it builds the same prompts and validates the same JSON schema regardless of
  which one is active.
- Your `ANTHROPIC_API_KEY` (if used) is read server-side only, via `dotenv`. It is
  never sent to the browser.

## Setup

```bash
npm install
cp .env.example .env   # then edit .env — see "Choosing a provider" below
npm start
```

Open http://localhost:3000.

## Choosing a provider

Set `LLM_PROVIDER` in `.env` to `anthropic` (default), `ollama`, or `openai`.

### Anthropic

Question generation defaults to `claude-sonnet-4-5`. If your API key doesn't have
access to that model, `POST /api/generate-exam` will return a clear
`model_not_found` error (shown as an alert in the browser) — set `ANTHROPIC_MODEL`
in `.env` to a model you do have access to (e.g. `claude-opus-4-8`,
`claude-sonnet-4-6`, `claude-haiku-4-5`) and restart the server.

### Ollama (free, local, no API key)

```
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3        # whatever you've pulled via `ollama pull <model>`
OLLAMA_BASE_URL=http://localhost:11434
```

Requires `ollama serve` running locally. `POST /api/generate-exam` will return a
clear error and remediation step if Ollama isn't reachable
(`ollama_unreachable` — start `ollama serve`) or the model isn't pulled
(`ollama_model_not_found` — run `ollama pull <model>`).

**Quality caveat — read before trusting the answer key.** Smaller local models
are noticeably weaker than Claude at this task, and the failure mode isn't just
JSON formatting (that part is handled reliably — see below) — it's the *answer
key itself*. Spot-testing `llama3:8b` on 9 C++ questions, one had a flatly wrong
"correct" answer (it claimed `decltype` resolves types at runtime; it's a
compile-time operator, same as `auto`), and 2–3 more marked a plausible-but-
non-standard option correct where the textbook answer existed as a distractor.
That's a real hit rate, not a fluke — expect it on any local 7–14B model.
Treat Ollama-generated exams as extra practice volume, not ground truth: spot-check
answers you're unsure about, and prefer Claude (or a stronger local model, e.g.
`qwen2.5-coder:14b` or `llama3.1:8b`) for anything close to the real screening date.

The JSON-formatting side is solid: the app asks for `{"questions": [...]}` (an
object with a named array field) rather than a bare top-level JSON array. Bare
arrays are where small models actually go wrong mechanically — tested against
`llama3:8b`, a bare-array request for 3 questions collapsed to a single object
instead of 3; the object-wrapped version reliably returned exactly N items up
to at least 9 in testing. If you use a model with a smaller native context
window than 8192 tokens, lower `OLLAMA_NUM_CTX` to match it; a larger-context
model (e.g. `qwen2.5:14b` at 32k) can raise it.

### OpenAI

```
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o        # set to whatever your key actually has access to
```

Defaults to `gpt-4o` if `OPENAI_MODEL` is unset — that's a safe known-good
default, not necessarily the newest model on your account, since model access
depends on your OpenAI billing tier and isn't something this app can detect in
advance. If the default (or whatever you set) isn't available to your key,
`POST /api/generate-exam` returns a clear `openai_model_not_found` error
telling you to change `OPENAI_MODEL` and restart — same pattern as the
Anthropic path. `openai_auth_failed` means the key itself is wrong.

Verified against a live key on `gpt-4o`: a full 50-question exam generated in
~10s (all schema-valid, correctly distributed across sections), and a manual
spot-check of 18 questions across all 6 sections — including two code-trace
questions (a Python list-mutation function, a nested-if JS snippet) — found
zero incorrect answer keys, a clear step up from the Ollama/`llama3:8b` sample
(1 flatly wrong, 2–3 debatable out of 9). Still worth a periodic skim rather
than blind trust, especially on anything language-lawyer-y, but this is the
provider to use when it matters. Uses OpenAI's JSON mode
(`response_format: {type: "json_object"}`) plus the same object-wrapper
schema and validate-then-retry-once logic as the other two providers.

## How adaptive generation works

1. On "Generate New Exam," the backend reads `data/history.json` and computes your
   accuracy per section (sections with no history default to a neutral 50%).
2. It allocates 50 questions across the 6 sections: every section gets a floor of
   4 questions (the real exam is broad, not narrow), and the remaining ~26 are
   distributed proportionally to `1 - accuracy` — weaker sections get more.
3. It fires 6 parallel calls to Claude (one per section), each with a system
   prompt describing the section, style, and difficulty, plus a sample of up to
   40 recently-seen question texts for that section to avoid near-duplicates.
4. Each response is parsed as JSON and schema-validated
   (`{q, code, opts[4], a}`); a malformed response is retried once with a
   stricter instruction before failing.
5. All 6 sections' questions are merged, shuffled, and returned as one 50-question
   exam. The frontend swaps it in for `QUESTIONS`, resets the timer and answers,
   and reuses all existing exam-taking/scoring/review UI.

## Persistence

`data/history.json` tracks, per section: total questions answered, total correct,
and a rolling list of the last ~150 question texts seen (to avoid exact repeats
in future generations). It's updated every time you submit an exam from the
frontend (via `POST /api/record-results`). The file is created automatically on
first run if it doesn't exist.

## Files

```
server.js                 Express app + the two API routes
lib/generateExam.js       Section allocation + provider calls + JSON validation/retry
lib/providers/index.js    Picks anthropic.js or ollama.js based on LLM_PROVIDER
lib/providers/anthropic.js   Anthropic SDK backend
lib/providers/ollama.js      Ollama HTTP API backend
lib/history.js            data/history.json read/write helpers
public/index.html         Frontend: exam UI, timer, scoring, review mode, history panel
data/history.json         Local progress data (gitignored is up to you — kept by default)
```
