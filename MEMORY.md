# Boom project memory

Last updated: 2026-08-13.

Read this first when resuming work. It records what is built, what is proven, and what is not — not
how the code is structured (read the code for that).

## Boom V3 status

Formal V3 development happens in `/Volumes/Storage/Code/boom-v3`; the current solver-slimming branch
is `codex/slim-solver`, based on `codex/boom-v3`. The original
`/Volumes/Storage/Code/boom` worktree is a local CTF/data lab on
`codex/boom-v3-wip-20260803`; commit `7f89f7a` preserves the pre-split product WIP. Do not cherry-pick
that snapshot wholesale: it includes an unfinished orchestration rewrite.

`docs/BOOM_V3.md` is the historical M0–M8 architecture record; this file and the current code define
the slimmer product. The IDA Pro MCP integration landed on `codex/public-release` (commit `397d907`);
do not treat `codex/slim-solver` as the only active product branch. The runtime milestones M1–M5,
autonomy-first orchestration, neutral Agent resources, the Tool Host/Policy, Native kernel and first
party Provider drivers are implemented and covered by the current test suite. The current product
route keeps OpenCode as the stable bundled Runtime; Native remains an experimental and test asset,
not a prerequisite for new product work. Boom-owned MCP configuration/control and declarative CTF
platform adapters remain product capabilities.

Since 2026-08-07 the product direction is **solver-focused slimming**: everything except the
solving process is being weakened or removed. Work continues on `codex/slim-solver`. Already done:
the dead orchestrator state machine was deleted (single progress ledger), a compact no-model-call
handoff is injected into every continuation turn, automatic escalation is capped at one read-only L1
second opinion with the economy model, and writeup turns use the economy model. V2 baseline,
checkpoint roles/API/UI, evidence branches, verifier state, automatic recovery, and their agent
resources/tests are deleted. CLI now delegates to `GuiRunner`, so active and post-compaction
consultation have CLI/GUI parity. The managed `idalib` (headless IDA Pro) MCP is now product-integrated
through Boom's own thin result broker; other analysis-tool MCP servers (e.g. Wireshark) remain future
integration targets.

The user's stated target failure mode is a solver that **tunnels**: it keeps working, does not notice
it is in a dead end, and digs deeper instead of reconsidering. Three pieces now address it, all built
on the principle that a *tool call is not progress* — only an artifact, a `ctf-note`, or a candidate is:

- **In-turn dead-end brake** (`session.ts`): aborts a turn as `stalled` once
  `stalledInTurnBudgetRatio` (0.25, in `AUTONOMY_THRESHOLDS`) of the challenge budget is spent with no
  durable signal. Two-stage — a token counter triggers, then a `work/` mtime scan plus a running-tool
  check confirms — because artifact writes emit no runtime event, so spend alone cannot tell a dead end
  from quiet productivity. Fires once per turn; `withStallBrake` attaches it to solve turns only. The
  0.25 value was selected by replaying 45 archived runs: the old 0.15 guess would have interrupted four
  candidate-producing runs, while 0.25 produced no such replay false positive and still caught five
  no-result runs. This remains replay calibration, not a substitute for the planned benchmark.
- **L1 anti-tunnel questions** (`escalation.ts`): the read-only `boom-consultant` must answer real progress / most likely
  blind spot / one falsifiable experiment, and is explicitly told the whole direction may be wrong
  rather than merely incomplete. Answers ride to the solver in `escalationHint`'s raw reply text, so no
  report-schema change was needed. The prompt demands a ```json fence; the parser now lives in
  `orchestration/structured-report.ts` and prefers fenced JSON before falling back to an object span.
- **Blind candidate review** (`orchestration/second-opinion.ts`): advisory only, never changes
  acceptance. Runs in the platform-`pending` branch precisely because nothing else checks a candidate
  there, and no adapter is the common case. `selectReviewer` prefers a model the solver did not just
  use and reports `sameModelAsSolver` when it cannot. Evidence comes from `NOTES.md` plus a `work/`
  artifact listing, with the candidate and confidence lines stripped — **not** `WRITEUP.md`, which does
  not exist yet at review time since writeups follow acceptance.

Consultation is now **N-ary**: 2–4 experts (`CONSULT_EXPERTS`) draft in parallel and the main model
synthesises one new plan. The synthesiser is told not to treat a majority as correct, and is warned
when experts share a model so repeated output is not read as independent corroboration. One shared
pool serves both features: `GuiSettings.consultModels`, with `GuiSettings.blindReview` as a separate
toggle. The GUI can trigger consultation directly, the main solver can request it through
`ctf-consult`, and a completed main-solver context compaction triggers it automatically. Blind review
still fires independently on every candidate, so its cost can be switched off without emptying the
pool.

Active consultation is a **host transition**, not a prompt-only convention. `ctf-consult({ reason })`
writes a validated, session-scoped request under `work/.boom/`; the terminal tool ends the solve turn,
`GuiRunner` runs the configured 2–4 expert drafts and synthesis, persists `work/CONSULTATION.md`, then
continues the main solver. Only the main solver profile owns this tool; consultants and worker roles
cannot recursively request another panel. `NOTES.md` is the panel's durable source of truth. If no GUI
pool has been configured, the automatic path falls back to Economy + Strong; repeated use of one actual
model is explicitly labelled as non-independent evidence.

Boom normalizes every discovered/configured model's declared context limit to **300,000 tokens** through
`BOOM_CONTEXT_LIMIT`, and writes OpenCode runtime configuration with automatic compaction enabled. A
completed compaction during a main solve turn ends that turn and queues one mandatory consultation
before continuation; runtime headroom means compaction may begin near the boundary rather than after an
invalid over-limit provider request. Consultant turns are role-isolated and do not enter this recursive
transition. A real paid-provider run that actually reaches the 300k boundary has not yet been performed.

## Identity

- Product and default solver agent: **Boom**. CLI and agent ID: `boom`.
- Formal V3 worktree: `/Volumes/Storage/Code/boom-v3`; local experiment/data worktree:
  `/Volumes/Storage/Code/boom`.
- Boom core depends on the Boom-owned contracts in `src/runtime-contract.ts`; concrete runtime SDKs
  are translated at the boundary. OpenCode is the bundled default adapter and its SDK is reached only
  through `src/runtime.ts`. Never import source from the neighbouring `opencode` repository — copy
  design and configuration, not code.
- Boom V2 was merged into `main` at `151caff`. Runtime decoupling continues on
  `codex/runtime-decoupling`; the first boundary implementation is commit `550e43d`.

## What Boom does today

`boom run --root <dir>` discovers every challenge under `<root>/challenges/`, gives each its own
workspace under `<root>/runs/<slug>/<run-id>/`, and drives the Boom agent at it. Each run writes
`result.json` (outcome, tokens, candidates, finish reason, part histogram, retries) beside its
`NOTES.md` and `work/`.

`boom gui --root <dir>` opens an independent macOS desktop client backed by a private loopback API
and the same discovery, workspace, runtime, and session code. In the GUI, one challenge has one
durable task workspace and each model invocation is a **turn** inside that task. The user can add a
prompt, change the model, and continue the same task after completion, cancellation, token budget, or
wall-clock timeout without creating another model-named directory. Old one-shot run directories stay
readable and are adopted in place when first continued or reviewed.

The GUI streams and persists events, supports batch starts and per-task continuation, real
cancellation, model pins, independent saved settings, hints, lifecycle controls, evidence browsing,
native directory selection, imports, safe reset/delete, local artifact opening, manual flag review,
and decision-point multi-model consultation, including a visible consultation button and persistent
2–4-model pool. `--browser` keeps an explicit compatibility mode;
`--headless` starts only the API.

`boom run` accepts 2–4 repeatable `--consult provider/model` flags as a startup preflight and shared
active-consultation pool. The experts draft in parallel, the Strong model synthesises, and that model
then solves from the merged plan. Because CLI uses `GuiRunner`, model-triggered and completed-compaction
consultations use the same transition as the desktop client.

Boom V2 orchestration is no longer an active product path. Historical `result.json` evaluation remains
read-only, but new runs do not create baseline, checkpoint, branch, verifier, or recovery state.

Also available: `boom doctor`, `boom version`.

## Frontend (2026-08-08)

The GUI is now a **React 19 + TypeScript + Vite** app in `frontend/`:

- Build: `bun run build:web` → `frontend/dist`; dev server: `bun run dev:web`
  (port 7332, proxies `/api` to the GUI server on 7331).
- `src/gui.ts` serves `frontend/dist/index.html` when a build exists, and falls
  back to the vanilla prototype (`prototype/boom-gui-v3.html` +
  `boom-gui-v3.js`) when it does not, so an unbuilt checkout still opens.
- Styling follows `DESIGN.md` (Apple design language): light default with
  parchment surfaces, a single Action Blue `#0066cc`, SF Pro font stacks,
  pill buttons, and no gradients. A dark theme is available through the
  global-nav toggle and is persisted in `localStorage["boom-theme"]`
  (`document.documentElement.dataset.theme = "dark"`).
- Implemented screens: two-row nav (global nav + frosted sub-nav), challenge
  queue, detail tabs (stream / flags / notes / writeup / consultation / files /
  meta), settings with searchable model selects and a chip-based 2–4 consult
  pool, plus Provider / MCP / platform / armor-prompt / delete
  dialogs.
- Live SSE updates merge `run.event` deltas into React state
  (`frontend/src/state.ts`); full snapshots refresh on lifecycle events. Detail
  is fetched per selected challenge/run, not per SSE event.
- Both the macOS native client (WKWebView) and `--browser` mode load the same
  React app; the native directory picker bridge is preserved in
  `frontend/src/bridge.ts`.

## Design decisions that are settled

**The agent decides how to solve.** `resources/runtime/agents/boom/SYSTEM.md` deliberately contains no
solving loop, no what-to-look-for. It constrains only where output goes, what must be recorded, and
host safety. `resources/skills/ctf-workflow/SKILL.md` is record *formats* only. Do not reintroduce
prescriptive solving steps, and do not add per-challenge special cases — the user asked for this
explicitly.

**New runs report candidates through a structured slot.** The solver calls `ctf-submit` as soon as a
credible candidate exists (writeup is not written before acceptance); Boom accepts only a submission
made by the current runtime conversation. Reply/Markdown extraction remains only for reading legacy
history. A model result is always a **candidate**, never an automatically solved challenge.
Acceptance comes only from the platform verdict when a submission adapter is configured; local verification
(local-checker / offline-derivation / blind model review) is deliberately not used as an acceptance
substitute. A submission that returns no verdict (`pending`) is retried once after ~5 seconds and,
if still unresolved, stops at manual review with the failure reason shown. Without a platform,
every candidate stops at manual review.

- Platform `accepted`: mark the task `solved`; the main flow ends. No writeup turn is queued
  automatically.
- Platform `rejected`: record the rejected candidate, tell the next agent it is wrong (including
  the platform reason), and enqueue another turn in the same workspace.
- Manual `确认正确`: mark the task `solved`; the main flow ends (no automatic writeup).
- Manual `不正确，继续`: same as a rejection.

Known/correct flags must never enter a run workspace. In particular, confirmation data is stored
outside the agent workspace; only a rejected candidate may be written to `task.json`/`NOTES.md`
because it is explicitly known to be wrong.

**A model may proactively leave a dead end through a real tool.** The main solver has
`ctf-consult({ reason })`; its request is validated and bound to the current runtime session, so stale
files cannot retrigger a later turn. The host then ends the turn, runs the panel and synthesis, and
continues from the resulting consultation artifact. This tool is intentionally absent from worker and
consultant profiles to prevent recursive consultation.

**Context pressure is a host event.** Model catalogs, provider discovery/registry, runtime config and
the GUI all use the 300k Boom context declaration. OpenCode automatic compaction remains responsible for
summarizing before the provider window is exceeded. A completed main-solver compaction is converted into
the same host-side consultation transition as `ctf-consult`, so the solver gets an external plan before
resuming from compressed memory.

**IDA Pro MCP runs through Boom's thin result broker.** The managed local server `idalib` is wrapped at
runtime-config compile time (`wrapLocalIdaProxy`) into
`[bun, src/runtime/ida-proxy.ts, ...idalib-mcp]`. The proxy is a pure stdio passthrough that never
rewrites tool schemas: oversized results are archived to `work/ida/results/<id>.txt` with a
pointer+preview left in context, an upstream-truncated `analyze_batch` is re-queried per function,
dedup is keyed on canonical args plus result hash with an `index.jsonl` ledger, and
`boom_ida_get`/`boom_ida_list` (surfaced to the model as `idalib_boom_ida_get`/`idalib_boom_ida_list`)
read archives in bounded line chunks. Offload threshold is `BOOM_IDA_OFFLOAD_CHARS` (default 16K
chars). Workspace discovery uses MCP `roots/list`; any failure — no root, disk write, upstream error —
degrades to verbatim pass-through. Upstream `idalib-mcp` and its read-only profile are untouched.

**Writeup is a separate flow, not a main-flow phase.** After acceptance the task stays `solved` until
the user explicitly triggers it (GUI **生成 Writeup** button / `POST /api/runs/writeup`). That turn
reads the confirmed flag and run artifacts, writes `work/WRITEUP.md`, and only then archives the
task. The writeup turn never changes the accepted flag.

**The persistent unit is a task, not a model run.** A task has `task.json`, a status, cumulative
usage, rejected candidates, and an ordered list of turns. Model, prompt, limits, result, and timing
belong to each turn. New GUI task directories use a neutral `-task` suffix. Switching models only
changes `currentModel` and the next turn; it does not fork files. An explicit “new independent task”
action is the only normal way to create another workspace for the same challenge.

**`NOTES.md` is task memory, not an append-only log.** The append-only audit trail is
`work/events.jsonl`. `ctf-note` still supports incremental `note` and `ruled-out` entries, but also
supports `checkpoint`, which atomically replaces `NOTES.md` with a compact handoff: current goal,
confirmed facts, live hypotheses, ruled-out directions, key artifacts, user-rejected flags, and exact
next steps. Use that handoff when transferring work to another turn; simple in-progress actions do not
need a fixed checkpoint call. New workspaces start with the structured skeleton.

**V3 is autonomy-first.** The main Agent starts solving directly. Escalation becomes eligible
after 20 active minutes or 30% of the challenge token budget, but it triggers only when the tail also
shows no meaningful progress and no productive long-running tool. At most one read-only L1 second
opinion runs per progress fingerprint; there are no fixed pre-passes or higher orchestration tiers.

**Multi-model value is "independent judgment", not "a multi-model pipeline".** The V2 fixed services
were removed. Their replacement is one on-demand **second-opinion service** with a single
shared input (the compact handoff summary) and a single text output appended to the next solver
turn — no per-role state or report files:

- A. Stall diagnosis: auto when eligible and stalled; one economy model returns 1–2 falsifiable
  experiments. Current L1 is the seed; it must also answer "was there real progress; what is the most
  likely blind spot".
- B. Candidate blind review: auto when a candidate appears; one different model checks the derivation
  for counterexamples. It only hints the solver — platform/manual verdict remains the only acceptance.
- C. Active consultation: user-, model-, or post-compaction-triggered; 2–4 expert models plus one
  strong synthesizer merge into one plan.

**Stall detection is deterministic, not a model self-report.** Progress is measured by artifact
hashes, `ctf-note` changes, non-repeated tool results, and candidates (already in
`orchestration/progress.ts`; 5-minute tail threshold). Do not ask the model every 5 minutes —
self-reports are unreliable and costly. Mid-turn coverage currently has a 150-second total-silence
watchdog and the 25%-budget durable-progress brake. The remaining gap is a **time-based progress
heartbeat** for an actively churning turn: live reasoning/events reset the silence timer even when no
artifact or note advances, while a running tool suppresses it entirely.

**Boom owns the runtime contract.** Solver, progress, consultation, history, and GUI orchestration
must not depend on SDK-native sessions, events, response
parts, model references, or Provider APIs. They use `AgentRuntime`, `RuntimeConversation`,
`RuntimeEvent`, `RuntimePromptResult`, and the optional `ProviderRuntime`. OpenCode translation stays
inside `src/runtime.ts`; its plugin resources are compatibility wrappers. An agent-only backend is
valid even when it has no Provider catalog or OAuth support. `GuiRunner` accepts a `RuntimeLauncher`
for injection, and run results record runtime backend/version provenance.

**Core tools stay visible.** Main Boom and workers retain OpenCode-equivalent file discovery,
`bash`, system PATH tools, `task`, Skill, and Web tools. Safety belongs in task filesystem, credential,
process, budget, concurrency, and cancellation boundaries—not in globally hiding tools. CTF network
and search are default-open in the V3 target; M3 must make that policy authoritative in Boom.

**Boom tools have a native host.** `src/tool-runtime.ts` exposes backend-neutral implementations of
`boom-exec`, `ctf-note`, `ctf-consult`, and `ctf-submit`. `ctf-consult` records a host-consumed control
request rather than running models inside the tool call. A future native or third-party adapter should
mount that host instead of reimplementing safety, command, and durable-memory semantics.

**Archives: the framework unpacks one layer only.** Nested archives, passwords, and forged headers
are usually the puzzle itself.

**The GUI's live-update path must not rebuild the whole view.** The client is a React 19 +
TypeScript + Vite app in `frontend/` (built to `frontend/dist`), served by `src/gui.ts` inside a
WKWebView or a browser via `--browser`. `applyRunEvent` in `frontend/src/state.ts` merges SSE
`run.event` deltas into React state locally, and the detail view is re-fetched only when the
selected challenge or its run set changes. Do not reintroduce a blanket full state fetch/render on
every event.

**Untrusted text is rendered by an escape-first markdown subset.** `NOTES.md` and `WRITEUP.md` hold model
output and challenge text — a web challenge legitimately contains `<img onerror=...>`, which must display
as characters. `renderMarkdown`/`mdInline` in `boom-gui-v3.js` escape first and then emit only tags they
construct, with an http(s)/mailto allowlist for `href`. No library: the CSP is `script-src 'self'`
(`gui.ts`), so a CDN copy cannot load, and offline use is required. Both panes are **read-only on
purpose** — a running agent writes `NOTES.md` concurrently, so user edits and the agent's next write
would overwrite each other. There is no save endpoint and none should be added without a conflict story.

**The GUI is a desktop client, not a browser tab.** On macOS, `boom gui` owns an AppKit window with a
WebKit content view and a private loopback API; closing the window closes that API. Keep the native
directory picker and same-origin/navigation restrictions. A normal browser is compatibility-only
via `--browser`.

**Desktop windows must fit the current visible screen.** Never restore a fixed 1280px frame or set a
minimum width larger than `NSScreen.visibleFrame` (the Dock can substantially reduce it). Initial,
restored, and cross-screen frames are clamped to the visible area. The content remains a two-column
workbench down to a 720px product minimum, with responsive 320/280px queue widths, zero-min-width
grid tracks, and wrapping long paths.

## Verified working (with evidence)

| Capability | Evidence |
|---|---|
| Archive handling | 5/5 real archives unpacked, including SHA-256-named files with no extension (identified by magic bytes) and GBK entry names |
| Parallel execution | 4 challenges advancing at once; worker pool refills a slot the moment one finishes |
| Token accounting | Per-step usage is *summed*, not maxed (upstream overwrites `tokens` per step and only accumulates `cost`) |
| Cache weighting | Cache reads count ×0.1 against the budget, full price when reported. Real runs are ~13% weighted, so this is decisive: one challenge consumed 11.9M raw under a 10M cap and correctly survived |
| Abort backstops | `budget`, `timeout`, `empty`, `stalled` have each fired on real runs |
| Agent autonomy | Unprompted: unpacked a nested zip, split a PDF into pages, pip-installed dependencies into `work/vendor/` |
| Subagent dispatch | `boom-worker` dispatched 11 times, tasks named Decode/Decrypt/Brute/QR/Explore |
| Retry on failure | Transient failures (TLS, 5xx, 429) and rejected attachments recover in the same session, keeping `work/` and `NOTES.md` |
| Desktop client/API | Core tests cover desktop lifecycle, state, SSE, history compatibility, persistent tasks, hints, consultation routing, cancellation, settings persistence, flag review, lifecycle actions, reset/delete, and path boundaries |
| React GUI rewrite | Typecheck, 216 tests, and production build pass; Playwright smoke checks verified settings, consult-pool selection/save, Provider/MCP/platform/armor dialogs, theme toggle + persistence, and narrow-width layout |
| Multi-model consultation | Unit, session, `GuiRunner`, and HTTP integration tests prove 2–4 drafts run concurrently, synthesis waits for all, every trigger uses the same bounded `challenge/work/clues` summary without mutating the solver context, artifacts persist, usage reduces the remaining budget, model requests resume automatically, and completed compactions enter the same path. A paid-provider end-to-end consult has not yet been run. |
| 300k context/compaction transition | Configuration, provider, session, and runner tests pin model metadata to 300k, enable runtime auto-compaction, terminate the main solve turn on a completed compaction, run consultation, and resume automatically. The actual 300k paid-provider boundary has not yet been exercised. |
| Narrow-screen layout | Reproduced an old 1280px autosaved frame on a display with only ~804px available beside a right-side Dock; after the fix, the real client simultaneously exposed the full queue, detail pane, run controls, flag counter, tabs, and rerun bar, with both window edges on-screen |
| Persistent task UX | Real macOS UI inspection verified the saved-settings dialog, per-turn model selector and prompt, “continue” controls, pending-flag grouping, and correct/wrong review actions. HTTP tests prove rejection continues the same run ID and confirmation marks the task solved without writing a known flag into the workspace; the separate writeup turn is what archives. |
| Platform submission retry | Runner test proves a `pending` platform verdict is retried once and, when the retry accepts, the main flow ends at `solved` with no automatic writeup turn. |
| Writeup separation | GUI tests prove manual confirmation no longer queues a writeup, and `/api/runs/writeup` starts one only for a task with a confirmed, unarchived flag. |
| Task memory | Unit tests prove multi-model turns aggregate in one `task.json`, rejected flags survive in task memory, checkpoint-ready NOTES use the structured skeleton, and host confirmation data is absent from the workspace |
| Slim orchestration | Tests prove direct L0 solving, one continuation, one L1 per progress fingerprint, read-only consultant isolation, model/post-compaction consultation transitions, and the absence of fixed V2 pre-passes |
| Runtime replacement boundary | 115 core tests / 537 assertions pass. Shared conformance drives the real OpenCode adapter with a deterministic scripted Provider and covers normalized lifecycle/text/reasoning/tool/usage/retry/finish, cancellation, path/edit/exec/note/submission behavior, tool defaults, role isolation, and stable prompts. |
| IDA MCP result broker | 8 proxy tests over a fake upstream cover passthrough, tool merge, archiving, per-function split, dedup, error passthrough, chunked retrieval, and no-root degradation. A real-IDA end-to-end using the actual `idalib-mcp` and `task-ef2417cb55`'s binary archived `idb_open`/`survey_binary`/`decompile` to `work/ida/results/`, left small `get_bytes` inline, and read back bounded chunks via `boom_ida_get`/`boom_ida_list`. `runtime-mcp` boots the wrapped command through real OpenCode. |
| armor-prompt plugin load | The `system.replace is not a function` plugin-load crash is gone from the 2026-08-13 runtime log after removing the stray named export; regression test simulates OpenCode's legacy module loader. |
| Recovery context handoff | Silent/stalled turns export a ≤200K-char context snapshot into the next recovery prompt; session and runner tests assert the snapshot is rendered and injected. |
| REVERSE task-ef2417cb55 | Re-run on 2026-08-13 completed with candidate `CTF{upDN_B_a_im_ur_pRoOf_0f_p1y}` (manual verdict pending); no recurrence of the previous provider stalls, and `ctf-note` populated `NOTES.md` this time. |

## Measured results — the honest number

As of 2026-08-07 `ctf/runs/` contains 34 challenge run directories. The current
`ctf/challenges/` set has 10 challenges:

| Result | Count |
|---|---|
| archived (confirmed + writeup) | **8 / 10** |
| paused without candidate | 2 / 10 (`easy_cms`, `压缩包分析`, both manually aborted) |

The 10-challenge batch was solved mostly with `deepseek/deepseek-v4-flash` as the primary solver;
`gpt-5.6-terra` / `gpt-5.6-sol` participated in some turns. Latest-run status across all 34 run
directories: 8 archived, 14 candidate-found (legacy, awaiting manual/platform verdict), 6 paused,
6 old-format records. The earlier 7-challenge numbers (terra 3/7, mini 1/7 plus 3 wrong flags) are
obsolete; those challenges are no longer in `ctf/challenges/` (moved to backups).

**Long tasks are the weak spot.** Simple tasks finish in one turn with ~10–30K raw tokens; long
tasks (`easy_cms`, `Rabbit`, `ddl`, `镜子里面的世界`) burn 8–14M raw tokens and often stall. The
main causes are context bloat, repeated reasoning, and escalation overhead — the target of the
slimming work above. The 300k normalization, compaction consultation, proactive `ctf-consult`, and
calibrated brake are the current mitigations; they have not yet been measured on the benchmark.

2026-08-13: `task-ef2417cb55` (Hard REVERSE, "Orbit Residue") re-run completed with candidate
`CTF{upDN_B_a_im_ur_pRoOf_0f_p1y}` after 7.19M raw tokens across two turns
(`mimo/mimo-v2.5-pro` hot-switched to `deepseek/deepseek-v4-flash`), awaiting manual verdict. The
earlier 3.30M-token run on the same challenge died of three provider stalls with no notes written;
this run reached the candidate and wrote full `NOTES.md` findings.

## Known problems

**Without a platform verdict, Boom cannot infer correctness.** Manual correct/wrong review and the
rejection/continuation loop are the fallback. The `军事密码` challenge produced a well-formed md5 in
both rounds — one correct, one wrong. New turns carry structured candidate source and verification
(`remote`, `local-checker`, `offline-derivation`, or `unverified`) and the GUI surfaces it, but in
the product main flow only the platform verdict drives acceptance; the other verification levels are
legacy/test paths. That is honest provenance, not independent proof: a model can still overstate how
well it verified a result.

**Mid-turn low-information detection is incomplete, not absent.** A 150-second no-activity watchdog
catches a runtime/provider that emits nothing while no tool is running, and the 25%-budget in-turn
brake catches token spend without durable progress. However, every live runtime event resets the
silence watchdog and an active tool suppresses it, so there is still no time-based 5-minute
durable-progress heartbeat that interrupts an actively churning solver. Do not describe the silence
watchdog as tunnel detection.

**Free models cannot be used in parallel.** `free/deepseek-v4-flash-free` hangs under concurrency 4
*and* 2 — an independent probe got no response for 100s. Not a Boom bug. Paid models are fine.

**MiMo is unsuitable as the primary solver.** `mimo/mimo-v2.5` reasons heavily and acts rarely: it
burned 1.04M tokens on one challenge with no conclusion, and idled 25 minutes on another. Its
strength suits the consult role instead.

**Reasoning models can return reasoning and no text.** That used to be reported as `completed`;
it is now `stop: "empty"`. `reply` falls back to reasoning text so a stated flag is not discarded.

**Native is not the current product gate.** The Native kernel and drivers remain useful experimental
and conformance assets, but the stable product Runtime is OpenCode. New work should close product
gaps at the Boom boundary instead of expanding Native for replaceability alone.

**Upstream idalib-mcp hides outputs above 50K chars.** ida-pro-mcp replaces oversized structured
outputs with a preview plus an HTTP download hint; in headless stdio mode there is no HTTP server, so
the full payload exists only in a bounded in-process cache. Boom's proxy recovers per-function data
for `analyze_batch` by re-querying, but the durable fix is an upstream PR (expose `get_cached_output`
in stdio or make the limit configurable).

**Note-taking is not yet guaranteed.** The failed 2026-08-12 run of `task-ef2417cb55` made zero
`ctf-note` calls across 237 tool events and left `NOTES.md` as the template, even though the solver
profile permits the tool. The provider stalls cut each turn before any handoff moment, and the model
stored progress as `work/*.py` scripts instead of conclusions. The 2026-08-13 run did write notes, so
this is behavioral rather than a tooling failure; consider a hard prompt rule or a soft host check
(e.g. remind after `idb_open` completes with no note yet) if it recurs.

## Gotchas

- `result.json`'s `parts` histogram covers only the final message. An absent `agent`/`subtask` entry
  does **not** mean no subagent ran — check the runtime log for `boom-worker subagent)`.
- Runs created before the GUI have no `work/events.jsonl`; the GUI can reconstruct their result,
  `NOTES.md`, and file tree, but correctly says the historical event stream is unavailable. A run
  directory with no `result.json` is shown as `interrupted`, never as currently running.
- A new task's `NOTES.md` is now a multi-section structured skeleton, so the old 73-byte heuristic is
  obsolete. Inspect whether the sections contain real findings and whether a compact handoff was written.
- `task.json` is host task metadata inside the workspace. It contains turn history and rejected flags
  but must never contain the host-confirmed correct flag.
- `challenge/` files are `0o444`. Deleting old runs needs `chmod -R u+w ctf/runs` first. Directories
  are intentionally left writable — a read-only directory makes the workspace undeletable.
- Provider keys live in `.env.local` (gitignored) as `BOOM_<PROVIDER>_API_KEY`, injected into the
  runtime config by `installProviders` in `src/runtime.ts`. `resources/providers.json` holds
  everything except the key.
- The runtime's OpenAI credential is separate from the `codex` CLI's. `codex` working does not mean
  Boom can reach OpenAI.
- Interactive permissions (`question`, `external_directory`) are `deny`, not `ask`: `ask` blocks
  forever in an unattended batch. This cost one challenge a 7-minute hang before it was found.
- The desktop client listens only on loopback and accepts only same-origin API calls. Root selection
  and imports use a native macOS directory picker; the explicit browser compatibility mode falls back
  to entering a server-side absolute path.
- The native `.app` is compiled through `xcrun swiftc` and cached by source/compiler/architecture/
  flags/version hash under `$BOOM_HOME/native-client/`. Editing `BoomApp.swift` therefore rebuilds
  the client automatically on its next launch; do not patch a cached `.app` directly.
- `BoomMainWindow` deliberately remembers its frame, but every launch and screen change clamps the
  restored size and origin to the active screen's `visibleFrame`. Preserve that clamp when changing
  window setup, especially on machines with a side Dock or when moving between displays.
- `web/` is an unrelated, nested Sites prototype — and it is **empty**, so do not look for the client
  there. The shipped GUI is the React app in `frontend/`; `prototype/boom-gui-v3.html` plus
  `boom-gui-v3.js` remain only as a fallback when `frontend/dist` is missing.
- `src/gui.ts` serves `frontend/dist/index.html` when it exists and falls back to the prototype
  otherwise. Run `bun run build:web` after frontend changes; `bun test` builds it automatically.
- The theme is persisted in `localStorage["boom-theme"]` and applied via
  `document.documentElement.dataset.theme`; light is the default, dark uses
  `:root[data-theme="dark"]` overrides. The toggle sits in the global nav.
- A live run's `durationMs` is frozen when the snapshot is built (`runner.ts`), while `startedAt` keeps
  advancing. Anything computing elapsed time must ignore `durationMs` for a running/queued run or the
  display sticks — this was the "time does not refresh" bug.
- The frontend has no automated test harness (no jsdom/happy-dom). `test/gui.test.ts` asserts that
  the built bundle is served; manual browser QA used Playwright against a running `boom gui`.
  When testing escaping, assert on **which tags the output contains**, not on substrings: an escaped
  payload still contains the text `onerror=`, so a substring assertion reports a false failure.
- Bun strips the first `--` after a script path from `process.argv`. `ida-proxy.ts` therefore takes
  the upstream command as plain positional arguments with no separator; do not re-add a `--` marker
  to the wrapped MCP command.
- OpenCode prefixes MCP tool names with the server ID (`idalib_*`): the model sees
  `idalib_boom_ida_get`/`idalib_boom_ida_list`, while the wire `tools/call` to the proxy carries the
  raw names `boom_ida_get`/`boom_ida_list`. Keep both names straight in prompts and tests.
- OpenCode truncates every tool result at 50KB/2000 lines by default and stores the remainder in an
  isolated runtime temp directory that Boom's task-relative file tools cannot read. The IDA proxy
  must not rely on that spill path; it archives from the response it actually receives.
- OpenCode SDK/event/session/provider names are allowed only in `src/runtime.ts` and the compatibility
  plugin resources. A core module importing them is a boundary regression.
- `resources/plugin/boom-exec.ts`, `ctf-note.ts`, and `ctf-submit.ts` remain legacy dedicated OpenCode
  compatibility implementations. `ctf-consult` is registered through `resources/plugin/boom-bridge.ts`
  and the Boom Tool Host; do not add a fourth old-style plugin. `src/tool-runtime.ts` is the
  backend-neutral source for a future adapter. Keep wrapper behavior aligned until all compatibility
  code can delegate without breaking copied runtime-resource loading.

## Before packaging

Run `bun run typecheck` and `bun test` (which runs `bun run build:web` first) from the
repository root; when touching the fallback prototype, also run
`node --check prototype/boom-gui-v3.js`. Typecheck plus the feature/unit/GUI/session/runner suites
currently pass. The real OpenCode `runtime-conformance` and `runtime-mcp` cases are timing-sensitive
under full parallel load: their functional assertions pass in isolation, but the aggregate run can
exceed their built-in 20/30s timeouts. Do not revive the obsolete “expected HTTP 401” explanation.
Before packaging, either obtain a clean aggregate pass or document the isolated passes and
investigate scheduling/timeout contention; do not misclassify a parallel timeout as a product
assertion failure.

## Next, in order

1. **Render NOTES.md/writeup CSS check and GUI regression sweep.** The markdown renderer landed and its
   escaping is verified, but two checks were interrupted: whether every tag it emits has matching CSS,
   and a full regression review of the seven GUI fixes (see the GUI section below).
2. **Confirm the legacy candidate-found runs.** The 14 old candidate-found tasks need manual or
   platform verdicts before their solve rate can be counted; update this file with the real numbers
   afterwards.
3. **Add a `boom writeup` CLI command** so the separate writeup flow is usable outside the GUI;
   today only the GUI button exists.
4. **Build a small real-challenge benchmark** (20–30 representative CRYPTO/MISC/REVERSE/WEB/PWN
   challenges) measuring solve rate, wrong-candidate rate, tokens, time and failure category. Let
   those measurements choose the next solver improvement; do not add another runtime subsystem by
   default.
5. **Confirm the 2026-08-13 candidate.** Verify or reject `CTF{upDN_B_a_im_ur_pRoOf_0f_p1y}` for
   `task-ef2417cb55`, then fold the verdict into the measured numbers.
6. **Upstream ida-pro-mcp PR.** Expose `get_cached_output` in stdio mode or make the 50K-char
   structured-output limit configurable, then simplify the proxy's per-function re-query path.
7. **Guarantee note-taking.** If another run burns many tokens without `ctf-note`, add a hard prompt
   rule (note after key findings) or a soft host check that reminds after `idb_open`/N steps with no
   note yet.
