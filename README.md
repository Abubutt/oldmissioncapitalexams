# Old Mission Capital — Adaptive Practice Exam

A full-stack practice exam app for the Old Mission Capital Jr. SWE screening
(C++, Python, Data Structures & Algorithms, Operating Systems, Linux/CLI, Networking),
runnable locally or deployed for free. Ships with a built-in 50-question bank, and
can generate brand-new, adaptive 50-question exams on demand using an LLM (Claude,
OpenAI, or a local Ollama model) — weaker sections get more new questions. A
shared access code gates generation on any public deploy so a live link can't
silently spend your API key on strangers.

## Architecture

- **Backend:** Node.js + Express (`server.js`), serving `public/` as static files.
- **`POST /api/generate-exam`:** reads the requesting user's history, allocates 50
  questions across the 6 sections (weaker sections get more, every section gets a
  minimum of 4), and calls the configured LLM provider once per section **in
  parallel** to write new multiple-choice questions, avoiding that user's recent
  duplicates. Responses are validated as JSON server-side and retried once on a
  parse/schema failure.
- **`POST /api/record-results`:** called by the frontend on submit; updates the
  requesting user's history with per-section accuracy and recently-seen question text.
- **`GET /api/history`:** returns the requesting user's history (used to render the
  "Practice history" panel on the results screen).
- **`POST /api/login`** / **`GET /api/gate-status`:** the access gate — see
  "Access & identity" below.
- **`lib/providers/`** — pluggable LLM backend (`anthropic.js` / `openai.js` /
  `ollama.js`), selected via `LLM_PROVIDER` in `.env`. `generateExam.js` is
  provider-agnostic: same prompts, same JSON schema, regardless of which is active.
- **`lib/historyStore/`** — pluggable storage backend (`file.js` / `redis.js`),
  auto-selected based on whether `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set.
  `lib/history.js` doesn't know or care which one is behind it.
- Your LLM API key is read server-side only, via `dotenv`. It is never sent to
  the browser.

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

1. On "Generate New Exam," the backend reads the current user's history and
   computes their accuracy per section (sections with no history default to a
   neutral 50%).
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

## Access & identity

Two separate concepts, both handled by the gate screen the app shows on first visit:

- **Access code** (`ACCESS_CODE` in `.env`) — a single shared secret that gates
  *whether you can use the app at all*. Unset = open (local dev). Set = every
  visitor needs it, so a public deploy can't have strangers spending your API
  key. One code for everyone you share it with.
- **Email** — *whose* history a visitor sees. Not an authenticated identity:
  there's no confirmation link, no password, no way to prove an email belongs
  to you. It's a convenient per-person data bucket for a small trusted group
  behind the access code, not a public signup system — anyone who knows (or
  guesses) an email and has the access code can view or build history under
  it. Good enough for "so my progress doesn't get mixed up with my
  friend's when we're both practicing off the same link"; not good enough to
  put sensitive data behind.

Locally with no `ACCESS_CODE` set, the gate is skipped entirely and every
request uses a fixed local identity — solo local use stays exactly as
frictionless as before this existed.

## Persistence

Each user's history — per-section totals and a rolling list of their last
~150 seen question texts (to avoid exact repeats) — is tracked separately,
keyed by the email they entered at the gate. Updated every time that user
submits an exam (`POST /api/record-results`).

By default this is a JSON file per user under `data/history/` (plus a
one-time fallback read of the old pre-multi-user `data/history.json`, so nothing
already recorded there is lost). That's fine for `npm start` on your own
machine, but **most free hosting tiers wipe the filesystem on every redeploy
or restart** — a deployed instance would silently forget everyone's progress
on the next deploy. For anything actually deployed, back it with Upstash
Redis instead.

### Setting up the database (Upstash Redis, free)

1. Go to [upstash.com](https://upstash.com) and sign up (GitHub or email —
   no credit card required for the free tier: 256MB storage, 500K
   commands/month, no expiration).
2. **Create Database** → give it a name → pick a region close to wherever
   you'll host the app → Create.
3. On the database's page, find the **REST API** section and copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. Add both to your `.env` (local) or your host's environment variables
   (deployed) — see `.env.example`.

No schema, no migrations — each user's history is stored as one JSON blob
under its own key (`omc:history:<email>`). The backend picks file vs. Redis
automatically based on whether those two env vars are set; the server log on
boot tells you which is active (`History store: file` or
`History store: upstash-redis`).

**Known limitation, not fixed:** two submissions from the *same* email at the
exact same instant can race (last write wins). Submissions from different
users never race each other, since each has its own key. Fine for a
small-group practice tool; not worth adding real transactions for here.

## Deploying for free

GitHub itself can't run this — GitHub Pages only serves static files, and this
app needs a persistent Node process (to hold your LLM API key server-side and
never send it to the browser). You need an actual host that runs
`node server.js` continuously; GitHub stays the source repo it deploys from.

### Render (recommended)

1. Go to [render.com](https://render.com) and sign up (GitHub login is
   easiest — it can then read your repos directly). Render's free web service
   tier doesn't require a card for most sign-ups, but if you're ever prompted
   for one during this flow, stop and decide for yourself before continuing —
   this project doesn't need a paid tier.
2. **New** → **Web Service** → connect your GitHub repo.
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Add environment variables (**Environment** tab) — this is the actual
   equivalent of "a secret only you can see": never in your repo, never in
   your code, invisible to visitors.
   ```
   LLM_PROVIDER=openai
   OPENAI_API_KEY=<your key>
   OPENAI_MODEL=gpt-4o
   ACCESS_CODE=<your access code>
   UPSTASH_REDIS_REST_URL=<from the Upstash step above>
   UPSTASH_REDIS_REST_TOKEN=<from the Upstash step above>
   ```
5. **Create Web Service**. Render builds and deploys automatically; future
   pushes to your repo's default branch redeploy automatically too.

**What "free" actually means here:** Render's free web service tier spins
down after 15 minutes with no traffic — the next request wakes it back up,
with a 30–60 second cold start, then normal speed after that. 750 free
instance-hours/month, comfortably enough for a personal/small-group tool that
isn't under constant traffic.

### Alternatives

Railway and Fly.io both work similarly (connect GitHub repo, set env vars,
deploy) but neither currently has an uncapped ongoing free tier the way
Render and Upstash do — worth knowing if Render's cold starts are a
dealbreaker, but they're not drop-in free replacements.

## Files

```
server.js                    Express app, access gate, and all API routes
lib/generateExam.js          Section allocation + provider calls + JSON validation/retry
lib/providers/index.js       Picks anthropic.js / openai.js / ollama.js based on LLM_PROVIDER
lib/providers/anthropic.js      Anthropic SDK backend
lib/providers/openai.js         OpenAI REST API backend
lib/providers/ollama.js         Ollama HTTP API backend
lib/history.js               Per-user history logic (accuracy, recent questions, run log)
lib/historyStore/index.js    Picks file.js or redis.js based on UPSTASH_REDIS_REST_* env vars
lib/historyStore/file.js        Local disk, one JSON file per user under data/history/
lib/historyStore/redis.js       Upstash Redis, one key per user
public/index.html            Frontend: access gate, exam UI, timer, scoring, review, history panel
```
