# Old Mission Capital — Adaptive Practice Exam

A full-stack practice exam app for the Old Mission Capital Jr. SWE screening
(C++, Python, Data Structures & Algorithms, Operating Systems, Linux/CLI,
Networking, and Discrete Math), runnable locally or deployed for free. Ships
with a built-in question bank, and can generate brand-new, adaptive exams (any
size, default 50) on demand using an LLM (Claude, OpenAI, or a local Ollama
model) — weaker and more heavily-weighted sections get more new questions,
optionally grounded in your own uploaded study material, optionally confined
to whichever sections you pick. A shared access code gates generation on any
public deploy so a live link can't silently spend your API key on strangers.

## Architecture

- **Backend:** Node.js + Express (`server.js`), serving `public/` as static files.
- **`POST /api/generate-exam`:** reads the requesting user's history, allocates 50
  questions across the active sections (weaker and more heavily-weighted sections
  get more, every active section gets a minimum of 4), and calls the configured
  LLM provider once per section **in parallel** to write new multiple-choice
  questions, avoiding that user's recent
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
OPENAI_MODEL=o4-mini       # set to whatever your key actually has access to
```

Defaults to `o4-mini` if `OPENAI_MODEL` is unset — a **reasoning model**,
switched to from `gpt-4o` (2026-07) after Discrete Math became the
largest section by weight (see below) and a live comparison showed it's
meaningfully more reliable at combinatorics specifically. If the default (or
whatever you set) isn't available to your key, `POST /api/generate-exam`
returns a clear `openai_model_not_found` error telling you to change
`OPENAI_MODEL` and restart — same pattern as the Anthropic path.
`openai_auth_failed` means the key itself is wrong.

**Why o4-mini, verified not assumed.** Ran matched discrete-math batches
through `gpt-4o` and `o4-mini` with identical prompts. `gpt-4o` got 7/8
correct — it mismarked the permutation count for "MISS" (a word with a
repeated letter) as 24 instead of the correct 12, forgetting to divide by the
repeat. `o4-mini` got 8/8, including two genuinely harder problems solved
correctly: a two-step license-plate count (11,232,000, computed exactly) and
a generalized pigeonhole problem. A follow-up full-exam-scale test (17
discrete math questions in one run) found 16/17 correct — the one issue was
a real, subtle one: "split 12 students into three groups of 4" was answered
as 34,650, the count if the three groups are labeled/ordered, when the more
natural reading (unlabeled groups) requires dividing by 3! for the
symmetric partitions, giving 5,775. Also tried `gpt-5` (the newer flagship on
this account) and it failed outright at this task — with an 8000-token
budget it spent the *entire* budget on hidden reasoning and returned no
visible output at all, a real failure mode of reasoning models worth knowing
about, not a one-off.

**This means don't blindly trust discrete math answers either — spot-check
them, same advice as every other provider/mode in this README** — o4-mini is
a clear improvement over gpt-4o for this content, not a guarantee.

**API quirks this required fixing, in case you switch models yourself.**
o-series models and `gpt-5` both reject the `max_tokens` parameter outright
("Unsupported parameter") — they require `max_completion_tokens` instead.
`gpt-4o` accepts `max_completion_tokens` too, so the provider now sends that
parameter name unconditionally rather than branching per model.
`max_completion_tokens` also has to budget for hidden reasoning tokens (billed,
but never appear in the visible output) — reasoning models pay most of their
token cost here, not on the JSON itself (measured ~2000-2900 total completion
tokens for an 8-to-20-question discrete-math batch, mostly a fixed per-call
reasoning overhead rather than scaling linearly with question count). The
token budget (`estimateMaxTokens` in `lib/generateExam.js`) was raised well
past what plain chat models need specifically so a reasoning model can't hit
the ceiling mid-thought and return nothing (which is what happened to `gpt-5`
in testing) — it's a ceiling, not a cost, so this doesn't spend anything extra
on models that don't need it.

Uses OpenAI's JSON mode (`response_format: {type: "json_object"}`) plus the
same object-wrapper schema and validate-then-retry-once logic as the other
two providers.

**Token/cost efficiency.** The server logs real per-call usage — including
reasoning tokens on models that report them — and running session cost to the
console (`[openai] 338 in + 407 out [192 reasoning] = 745 tokens (~$0.0049,
session total ~$0.0249)`) — no separate dashboard needed to see what a click
of "Generate New Exam" actually costs. Some history on getting this number
down, from when `gpt-4o` was still the default:
- **Explicit conciseness instruction** in the system prompt (one sentence per
  question where possible, tight options, no filler) — cut output tokens from
  750→407 per section on a `gpt-4o` test, no drop in spot-checked correctness.
- **Trimmed the recent-questions dedup sample from 40→15** — the last 25
  items were adding ~800 input tokens per section for an established user
  with no measurable dedup benefit.
- Net measured result on `gpt-4o` at the time: a full 50-question exam
  dropped from ~$0.0495 to ~$0.032 (~35%) for a fresh user. **This doesn't
  carry over to `o4-mini`** — reasoning tokens make the new default cost
  roughly 2x `gpt-4o` per exam in practice (measured: a full 50-question
  adaptive exam across all 7 sections ran ~$0.087 on `o4-mini` vs. `gpt-4o`'s
  ~$0.03-0.05), which is the real tradeoff for the correctness improvement
  above. If cost matters more than discrete-math correctness for your use,
  set `OPENAI_MODEL=gpt-4o` (or `gpt-4o-mini`, ~16x cheaper again but
  unverified here) back in `.env`.
- **o-series pricing is genuinely uncertain as of 2026-07** — two sources
  checked gave different numbers for `o4-mini` ($0.55/$2.20 vs. $1.10/$4.40
  per 1M input/output tokens; OpenAI revises o-series pricing often). The
  console estimate uses the higher figure so it errs toward overestimating,
  not under — check your actual OpenAI usage dashboard for ground truth.

## How adaptive generation works

1. On "Generate New Exam," the backend reads the current user's history and
   computes their accuracy per section (sections with no history default to a
   neutral 50%).
2. It allocates the requested number of questions (default 50, see "Choosing
   how many questions" below) across the active sections — every section you
   have checked in the dashboard's "Sections" picker, all of them by default.
   Every active section gets a floor of up to 4 questions (scaled down
   automatically if the total is too small to support that — e.g. a
   6-question exam floors at 1/section instead of 4), and the remainder is
   distributed proportionally to `SECTION_EXAM_WEIGHT × (1 - accuracy)` —
   sections that are both more heavily represented on the real exam *and*
   ones you're worse at get more new questions. See "Section selection"
   below for what happens when you uncheck some sections.
3. It fires one call per active section (in parallel), each with a system
   prompt describing the section, style, and difficulty, plus a sample of up
   to 15 recently-seen question texts for that section to avoid
   near-duplicates. If study material exists for that section (see below),
   the prompt also includes a bounded excerpt from it and an instruction to
   ground some or all questions in it.
4. Each response is parsed as JSON and schema-validated
   (`{q, code, opts[4], a}`); a malformed response is retried once with a
   stricter instruction before failing.
5. All sections' questions are merged, shuffled, and returned as one exam.
   The frontend swaps it in for `QUESTIONS`, resets the timer and answers,
   and reuses all existing exam-taking/scoring/review UI (which already sizes
   itself off `QUESTIONS.length` rather than assuming 50, so this needed no
   separate UI work).

### Choosing how many questions

The dashboard's "# Questions" field controls the size of the next
**Generate New Exam** call — defaults to 50, accepts 5-150. It has no effect
on **Take Practice Exam**, which always uses whatever bank (default or
last-generated) is currently loaded, unfiltered by count — that button's
hint text says so explicitly to avoid the field looking like it applies
everywhere. Validated both client-side (the number input's `min`/`max`) and
server-side (clamped again in `server.js`, since client-side bounds are only
a UX nicety, never trusted alone).

### Section selection

The dashboard's "Sections" checkboxes default to all checked (the full
adaptive spread across every section, weighted per `SECTION_EXAM_WEIGHT`) but
can be narrowed to any subset — uncheck everything except Discrete Math for
"just quiz me on discrete math," or check Discrete Math + C++ + Linux/CLI to
mirror what the real exam is actually reported to cover (see "Study
materials" below for where that intel came from). `all` / `none` links next
to the label toggle every box at once; unchecking every box and trying to
generate shows an alert and refuses rather than silently sending an empty
request. Applies to both buttons:

- **Take Practice Exam** filters whatever bank is currently loaded (the
  default question set, or the last AI-generated exam) down to the checked
  sections client-side — no API call, works offline from the static bank. If
  the currently-loaded bank has no questions in any checked section (e.g. you
  just generated a Discrete-Math-only exam, then check only "Networking"), it
  says so rather than starting a broken empty exam.
- **Generate New Exam** sends `focusSections` (an array of section indices,
  or omitted entirely when every box is checked) to the backend, which
  confines the weighted allocation to just those sections instead of
  spreading it across all of them — narrower pool, same weighting logic.

The chosen selection is sticky: retaking an exam (`↻ Retake Exam` on the
results screen) reuses whatever sections were active for the exam you just
took, not whatever the checkboxes currently show.

### Discrete Math — why it exists and why it's weighted so heavily

Added after a firsthand account of the actual screening (2026-07, secondhand
via a friend who'd taken it): **"80% discrete math [combinatorics and
permutations, explicitly not proofs], then some C++ code snippets, OS stuff,
and Linux commands"** — with `fork()` vs. `vfork()` vs. `clone()` named as an
example Linux question. That's obviously one account of one exam instance,
not a guarantee of what you'll see, but it's specific and credible enough to
act on:

- Added as a 7th section, appended to the end of `SECTION_NAMES` (both
  `lib/history.js` and `public/index.html` — these two arrays must stay
  identical and in the same order, since a question's `s` field is a raw
  index into them; inserting a new section anywhere but the end would
  silently reassign every already-stored question's section).
- `SECTION_EXAM_WEIGHT` in `lib/generateExam.js` gives Discrete Math roughly
  6x the baseline weight of most other sections in adaptive mode (Networking
  and the less-mentioned sections were trimmed down, not zeroed out — this is
  one account, not a certainty). A default 50-question adaptive exam lands
  around 17/50 (~34%) Discrete Math in practice — nowhere near the reported
  80%, because the per-section floor (guaranteeing every section some
  presence) eats a fixed chunk of the budget before the weighting kicks in.
  **If you want to actually mirror an 80/20-ish split, use the Section
  checkboxes** to narrow generation to just Discrete Math (+ C++/OS/Linux if
  you want the "some of these too" part) rather than relying on the adaptive
  default to get there on its own.
- The static question bank got 14 new hand-authored combinatorics/permutations
  questions (not AI-generated — written and checked directly, the same
  correctness bar as everything else in the static bank) and 3 new
  `fork()`/`vfork()`/`clone()` questions added to Linux/CLI.
- AI generation for this section gets an extra style instruction
  (`SECTION_STYLE_NOTES` in `lib/generateExam.js`) steering toward
  computational counting problems and explicitly away from proofs, graph
  theory, or formal logic — matching "it's just the combinatorics and
  permutations... not proofs" from the source account.
- This is also *why* the OpenAI provider's default model changed to
  `o4-mini` — see "Choosing a provider" → OpenAI above for the live
  correctness comparison that motivated it, including a real error it
  caught in `gpt-4o`'s output and a real (different) error it made itself.

### Difficulty

The dashboard's "Difficulty" dropdown (Easy / Medium / Hard, defaults to
Medium — the original fixed calibration this app always used) is sent as
`difficulty` and folded into every section's system prompt as a calibration
paragraph (`DIFFICULTY_GUIDANCE` in `lib/generateExam.js`), same style/schema
requirements either way. Only affects **Generate New Exam** — the static
question bank has one fixed difficulty and isn't recalibrated by this
setting.

**Verified this produces a real behavioral difference, not just prompt
theater** — generated matched easy vs. hard 8-question C++ sets and read
every question. Easy: operator syntax, `const`, pointer declaration syntax,
access specifiers, `sizeof(char)` — genuinely introductory. Hard: object
slicing, `x = x++ + ++x` sequencing, `delete` on a null pointer, virtual
dispatch inside a constructor — genuinely advanced, requiring real C++
experience rather than course recall.

**Found a real correctness error in the hard set while verifying it,
worth knowing about.** One hard question asked about `volatile` and marked
"ensures updates are visible to other threads" as correct — that's a
widely-held misconception, not true. `volatile` in C++ only prevents the
compiler from optimizing away repeated reads of that memory location (for
things like memory-mapped I/O); it gives no thread-synchronization or
cross-thread visibility guarantee at all — that's what `std::atomic` or a
real synchronization primitive is for. All 8 easy-tier questions checked out
correct in the same test; this was the only error across 16 total, and it
landed specifically in the tier explicitly asked to probe "common
misconceptions" — which is exactly the territory where a model can end up
reproducing a misconception as fact instead of testing it. Treat hard-tier
answers with a bit more skepticism than easy/medium, the same spirit as the
Ollama and material-only caveats elsewhere in this README.

## Study materials (RAG-lite grounding)

You can feed the generator real source material — a PDF or pasted text — so
generated questions test *that specific content* instead of (or alongside)
general knowledge. Manage it from the "Study Materials" card on the
dashboard: upload a PDF or paste text, assign it to one of the sections,
give it an optional title.

**Shared, not per-user.** Unlike practice history, materials are one shared
library — anyone behind the access code can upload, use, or delete any of
them. Upload a chapter once; it's available to everyone using the deployment,
immediately, no re-uploading per person.

**How it's used in generation** — for any section that has at least one
material attached:
1. All materials for that section are split into ~2500-character chunks on
   paragraph boundaries (`lib/materials.js`'s `chunkText`).
2. A **bounded random sample** (3 chunks, regardless of how much total
   material exists for that section) is picked and dropped into that
   section's generation prompt. This keeps the token cost of a section with
   material flat whether you've uploaded one page or a whole textbook —
   consistent with the token-efficiency work elsewhere in this app — and
   means repeated generations tend to cover different parts of a large
   document over time rather than always the same opening chunk.
3. The dashboard's "Material use" dropdown (only shown once at least one
   material exists) controls how strictly: **Blend** asks for roughly half
   the section's questions grounded in the excerpt and half general
   knowledge; **Material only** asks for every question in that section to
   come from the excerpt, covering it as thoroughly as the content allows
   rather than padding with unrelated questions if it's thin. This is chosen
   per generation, not fixed per material.

Sections with no material attached are completely unaffected — same
general-knowledge generation as before this feature existed.

**Material-only is a strong instruction, not a hard guarantee.** There's no
schema-level enforcement making every question reference the excerpt — it's
prompt instruction only, same as everything else this app asks the model to
do. Tested live against `gpt-4o` with a small (~3000-char, 2-chunk) source
document short enough that both chunks — effectively the whole document —
were included in the prompt every time: one generation run produced 3-4
questions on topics never mentioned in the source (device drivers, deadlock
prevention) despite the instruction saying not to pad with unrelated
content; an identical follow-up run at a smaller count stayed fully
grounded. Run-to-run variance, not a reproducible bug — but don't treat
"material only" as a hard filter, especially with a short source document.
Larger source documents give the model more to work with and are likely to
hold up better.

**PDF extraction** uses `pdf-parse` (text only — no OCR, so a scanned image
PDF with no text layer will extract as empty). Non-PDF files aren't
accepted; paste the text instead. Uploads are capped at 15MB (checked before
parsing) and extracted text is capped at 150,000 characters per material
(~35-40k tokens) — long past what a single exam's grounding needs, and
enough headroom that hitting it is a signal you're uploading more than one
exam's worth of material anyway.

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

**Why a refresh doesn't ask again.** The gate screen only appears once per
browser. On success, the email + access code are stored in `localStorage`;
every later page load silently re-POSTs them to `/api/login` in the
background and boots straight in if they're still valid — no code is
skipped, it's just automatic instead of retyped. If `ACCESS_CODE` is ever
changed on the server, that silent re-check fails and the gate reappears.
This is "remember this browser," not a security boundary on its own — anyone
with access to a device where you're already logged in can use the app
without the code, same as most session-based sites. Fine for this app's
threat model (don't let strangers spend your API key); there's no explicit
log-out, since clearing the site's local storage does the same thing.

## Dashboard

Logging in (or a silent re-verify on refresh) lands on a dashboard, not
straight into an exam:

- **Lifetime Stats** — accuracy per section across every exam that email has
  ever taken.
- **Past Exams** — every recorded exam, newest first, as `score (pct%)` +
  timestamp. Click one to open a full review of that exact exam: score,
  that run's per-section breakdown, and every question with your answer and
  the correct one marked — the same review UI as the results screen, just
  scoped to a specific historical run instead of the one you just took.
- Empty state (new email, 0 exams) shows the same layout with "—" for every
  section and "No exams taken yet" instead of erroring or hiding the page.
- "Take Practice Exam" / "Generate New Exam" both start fresh from here, same
  as they always did — the dashboard is a new front door, not a detour.

This is why each stored run now includes its full question/answer set, not
just a score — see "Persistence" below. Exams recorded before this was added
show the score and section breakdown but not a question-level review, and
say so rather than pretending the data exists.

## Persistence

Each user's history — per-section lifetime totals, a rolling list of their
last ~150 seen question texts (to avoid exact repeats), and up to the last 30
full exam runs (score, per-section breakdown, and the exact questions +
answers, for the dashboard's per-exam review) — is tracked separately, keyed
by the email they entered at the gate. Updated every time that user submits
an exam (`POST /api/record-results`).

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
lib/materials.js             Shared study-material CRUD, chunking, random excerpt selection
lib/materialsStore/index.js  Same file-vs-redis pattern as historyStore, but one shared key/file
public/index.html            Frontend: access gate, dashboard, exam UI, timer, scoring, review
```
