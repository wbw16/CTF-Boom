# Boom project memory

Last updated: 2026-09-12.

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

**Worker subagents are model-tiered.** `boom-worker` runs on the economy model and
`boom-worker-pro` on the strong model. The tier is declared in each agent's neutral `agent.json`
(`model: "economy" | "strong"`) and resolved at runtime-config compile time into the generated
OpenCode frontmatter, so a `task` dispatch runs the declared tier's model instead of inheriting the
solver's. `boom`/`boom-consultant` declare no tier and keep the host-selected per-turn model. The
runtime writes `subagent_depth: 2`, letting the strong worker delegate mechanical subtasks to the
economy worker. The policy is adopted at the first `enqueue` (CLI) or first settings save (GUI), and
a change to the economy/strong tiers relaunches the runtime at a safe boundary with a
"Worker 模型档位已更新" handoff — mirroring the Provider-reload pattern. The resolved models join
the prompt-provenance hash.

The design was cross-checked against the vendored `claude-code-source-code`: Claude Code resolves a
subagent's model as env `CLAUDE_CODE_SUBAGENT_MODEL` > per-call Task-tool `model` enum
(sonnet/opus/haiku) > agent frontmatter > `inherit` (parent's exact model; `getAgentModel` in
`utils/model/agent.ts`), uses family aliases resolved at call time, and keeps teammates flat (no
nesting). Boom cannot copy the per-call enum because OpenCode's task tool has no per-call model
parameter (`tool/task.ts`: agent model or parent inheritance only) and its agent frontmatter accepts
only literal `provider/model`. Agent-ID-per-tier is therefore the OpenCode-native compromise; the
Native kernel's per-call model parameter is the future escape hatch. The deliberate difference from
Claude Code — Boom defaults workers to the cheap tier instead of `inherit` — is a measured-risk
decision, see Known problems.

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

**Worker tiering is declared per agent resource, resolved at compile time, and cheap by default.**
An agent's `model` tier in `agent.json` is a Boom-neutral declaration; the literal provider/model is
resolved from the current ModelPolicy when the runtime config is compiled, so resources never hardcode
models. Tier changes are host events (runtime relaunch + safe-boundary handoff), not prompt edits. The
solver selects a tier by choosing `boom-worker` (economy) or `boom-worker-pro` (strong) in the `task`
tool; worker prompts may explain tier economics but must not prescribe solving steps. Workers default
to the cheap tier and are upgraded per task — the inverse of Claude Code's `inherit` default — because
Boom's measured batch was solved mostly by the economy model and CTF work is mechanical-heavy. If
measurement shows frequent cheap-worker failure followed by pro retries, revisit this default instead
of adding more tiers.

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
| Worker model tiers | `boom-worker` resolves `model: economy` and `boom-worker-pro` resolves `model: strong` in the generated OpenCode frontmatter; tierless `boom`/`boom-consultant` stay host-selected; resolved models join the prompt hash. Runner tests prove the CLI enqueue adopts the policy before the first launch, an economy/strong tier change relaunches the runtime (generation 2) with the new policy and forces a safe boundary on unchanged-model jobs with the "Worker 模型档位已更新" handoff, and an unchanged policy does not relaunch. |
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

**Worker tier routing is unmeasured and cheap-by-default carries a misclassification cost.** Claude
Code defaults subagents to `inherit` precisely to avoid a solver misjudging task hardness and paying
for a failed cheap run plus a strong retry. Boom inverts that default; the failure mode is a
`boom-worker` thrash on reasoning-heavy objectives. No real paid run has yet exercised the tiered
dispatch, so the wrong-tier rate and its cost are unknown. The cheap mitigations, gated on
measurement: record per-dispatch outcome (cheap-failed → pro-retried → succeeded?) in the benchmark,
route automatic cheap-failure retries to `boom-worker-pro` at the host, or add a
`BOOM_SUBAGENT_MODEL`-style global override mirroring `CLAUDE_CODE_SUBAGENT_MODEL`. Do not add a
third tier or per-task model hints before those numbers exist.

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

1. **Merge工作区改动。** `src/runner.ts`、`src/gui.ts`、`src/gui-state.ts`、`frontend/src/types.ts`、
   `frontend/src/TopBar.tsx`、`frontend/src/settings/SettingsDialog.tsx`、
   `frontend/src/providers/ProvidersDialog.tsx` 的改动仍在工作区，
   混有 visionModel / network 开关等其他预存工作。需要决定是分拆提交还是一并归入比赛分支。
2. **赛事实战验证。** 拿 `xihulunjian-ctf/` 目录跑一遍完整流程：拉题 → 配网关 → 开计时 →
   选题运行 → 自动提交 → 验证得分。确认解题报告的提交入口（赛方 API 文档未给，
   可能需要人工在平台网页提交）。
3. **批量放题拉取。** 比赛中分批放题，需要周期性回到比赛控制台重新拉取。考虑是否加
   自动轮询。
4. **多机分布式（赛后）。** 本机 CPU/内存是瓶颈，但比赛规则只允许一台 Agent 接入。
   赛后可做"接入机 + 纯计算 worker"的分布式，需要任务分发协议和 workspace 共享。
   当前优先级接口已预留位置。

## 2026-08-14 接口层文档与修复(本轮)

- 新增 `docs/CONVERSATION_INTERFACES.md`:runtime-contract / opencode adapter / native runtime 的
  conversation 接口速查,含事件词汇表、usage 口径、watchdog 心跳语义、陷阱清单。以后改 watchdog、
  会诊、事件流先读它,不必重读三个源文件。
- 顺手修复(全部带测试):opencode part.updated 先于 message.updated 时丢 delta;无 step 事件的
  provider 绕过 token 预算执法(completeRuntimePrompt result.usage 兜底);150s 静默 watchdog
  误杀批量推理 provider(isBusy 心跳:busy 不杀、空闲才杀);自然完成回合 stop=undefined 导致遗留
  watchdog 污染下一回合(finished 门闩);会诊 prompt 超限缩档重试阶梯 + 溢出花费 carve-out;
  token 估算保守化(CJK/hex 密度)。
- 全套件剩余 6 个失败为既有环境问题:environment/runtime-shell 的 EPERM 进程组(DSH 文件沙箱),
  runtime-conformance 的 boom-exec(工作区未完成的 resources 改动),与上述修复无关。

## 2026-08-18 西湖论剑比赛专用构建（`codex/xihulunjian-adaptation`）

分支 `codex/xihulunjian-adaptation`，基于 `codex/public-release`。比赛专用，不保留通用模式行为。
六个提交（`357248a1` .. `e246f2ed`），324 个测试通过，typecheck 干净。

### 已实现

**适配器层**（`src/xihulunjian-platform-adapter.ts`，~700 行）：
- 处理 `{code,message,data}` 统一包裹（code 非 00000 视为失败，即使 HTTP 200）
- 两层嵌套题目列表展开（分类 → corpus[]）
- 双形态 attachment（有附件是对象，无附件是空数组，文档写的 `{files:[...]}` 不存在）
- 靶机环境生命周期：build → poll → ready → recover
- 提交只发花括号内内容；`isCorrect` 缺失时判 `pending`，绝不假定成功
- 同步阶段**不启动环境**（槽位在 solve 时按需申请）
- 附件在独立 CDN 域，下载时不携带 AccessKey（凭证隔离）
- 全平台限流：串行化 + 700ms 间隔 + 指数退避（实测 3 次连续请求即触发 429/40001）

**调度层**（`src/competition/` 四个模块）：
- `policy.ts`：纯决策函数——优先级排序、槽位准入、时间预算、放弃判断
- `environments.ts`：三个环境租约池，释放幂等，即使 recover 失败也释放本地槽
- `submissions.ts`：持久化提交台账（每题 ~15 次上限，远低于平台 50 次红线），防爆破 + 去重
- `adapter.ts`：定位已配置的 xihulunjian 适配器实例（单例缓存，保证限流链不中断）
- `runner.ts` 的 `pump()` 从 FIFO 改为优先级 + 槽位准入，跳过而非堵住队列
- 环境租约释放挂在 `pump()` 的 `.finally()`，覆盖所有终止路径
- `AUTONOMY_THRESHOLDS` 按 3 小时赛重标定（eligible 5min，stalled 2min，cooldown 90s）
- 本地优先轮预算从 25k/5min 提高到 120k/12min（真正的逆向和 exp 开发）

**前端**（`frontend/src/competition/CompetitionDialog.tsx`）：
- 比赛控制台：平台接入（Server Host + AccessKey）、大模型网关、赛时计时、资源并发
- 顶栏赛况芯片：倒计时 + 环境占用，5s 轮询
- AccessKey 写入后从组件状态清除，只显示"已配置/未配置"
- 设置 → 比赛控制台入口（Timer 图标）

**LLM 网关**（`src/runtime/provider-http.ts`）：
- 赛方网关根即端点（POST 返回 200，`/chat/completions` 返回 404）
- 新增精确端点标记 `!`：Base URL 末尾加 `!` 跳过路径拼接
- Provider 对话框加 hint 提示
- 后端按网关 URL 形状嗅探自动判定固定端点（`!` 为通用兜底标记；后在 2026-09 通用化时移除嗅探，仅认 `!`）

### 真实平台验证结果（2026-08-18）

凭证 `https://pro.dasctf.com`，AccessKey `<redacted>`，网关 `https://llm-gateway.dasctf.com/llm-gateway/proxy/e/<redacted-token>`。

- 题目列表：3 道 → 4 道（分批放题，新增 WEB `UploadKing` 200 分 MEDIUM）
- 分类名英文（Web/Pwn/Misc），命中 `CATEGORY_ALIASES`
- `corpus[].id` 即 `exerciseId`，与分类 ID 不同层级
- `difficulty` 有 `VERY_EASY`（文档只有 EASY）
- `score` 是字符串 `"50.0"`
- 环境生命周期完整验证：build → poll → `remote=1.14.76.59:27629` → recover 回收
- `exposeIps` 已含端口（`1.14.76.59:27629`），`ports` 是 `http/80`
- 网关：POST 根返回 200（SSE 流式 + tool_calls + usage），POST `/chat/completions` 返回 404
- GET 网关返回 405，没有模型列表接口
- 网关映射到 `deepseek-v4-flash`

### 赛制参数

3 小时，错误不罚时，无冷却，先交得分高，每题最多 50 次提交（禁止爆破），
flag 格式 `DASCTF{}`/`flag{}`（提交花括号内容），最多 3 个线上环境，
分批放题，递减计分（每多一人解出降 1%，最低 80%），必须走大模型网关（否则取消成绩），
必须提交解题报告（否则取消获奖资格）。

### 未提交的工作区改动

`src/runner.ts`、`src/gui.ts`、`src/gui-state.ts`、`frontend/src/types.ts`、
`frontend/src/TopBar.tsx`、`frontend/src/settings/SettingsDialog.tsx`、
`frontend/src/providers/ProvidersDialog.tsx` 的改动仍在工作区，
混有 visionModel / network 开关等其他预存工作。

### 运行比赛版本

```bash
cd /Volumes/Storage/Code/boom-v3
bun run build:web
bun src/index.ts gui --root ./xihulunjian-ctf
# 设置 → 比赛控制台 → 平台接入 → 大模型网关 → 赛时计时
```

目录 `xihulunjian-ctf/` 是比赛用的干净目录（只有 `challenges/`）。

## 2026-08-23 xhlj 分支修复：分类器与同步幂等性（`relay-autogen-tokens` 工作区）

赛后复盘发现两个赛时真实发生的 bug，已修复并全部带测试（适配器 18 个用例全过，
policy/autopilot/challenge/gui-detail 47 个全过，typecheck 干净）。

### Bug 1：REAL 批次 20 道题全部落入 OTHER

平台分组名是批次标签（"REAL"）而非分类；题目名被匿名化（REAL-01..20），名字分类器
无从下手。但附件文件名暴露了题目本质：joomla/wordpress/drupal/ghost/cmsms 是 CMS
源码审计（WEB），nginx/httpd/openlitespeed/caddy/openresty/postgresql/redis/
clickhouse 是 C/C++ 服务源码审计（PWN，与 REVERSE/PWN 同一解题档位，拿 IDA 提示）。

修复：`inferChallengeCategory` 增加附件名为第三优先级信号（平台分类 > 题目名 > 附件名），
关键词表预编译；真实数据验证 17/20 道题正确重分类，无附件的 3 道 + 中文名题目保持
OTHER 不误动，已正确分类的题目零误动。`scripts/classify-challenges.ts` 顺带修了
把本地 meta.category 回馈为"平台分类"导致错分被冻结的 bug；python 应急脚本同步了
相同规则与附件信号。

### Bug 2：周期同步不是幂等的

旧 `acquireChallenges` 每轮（默认 10 分钟）对全部题目重拉详情并重新下载全部附件：
在"连续 3 次详情即触发 40001 限流"的平台上，这会挤占提交 flag 的请求配额，还会
反复下载数十 MB 的源码包。旧去重逻辑还是每题全树扫描（O(n²)）。

修复：同步改为增量——开扫一次本地索引（按 challenge_id 建索引，识别新旧两种目录
布局），已完整落盘的题目零平台调用、零下载；meta 新增 `attachments` 清单用于判定
完整性；清单缺失（旧数据）或文件丢失（中断）时自动走一次全量物化自愈；跨分类的
重复副本就地合并（rename 到推断分类 + 清空目录修剪）；`hasSolved` 经题目列表直达
本地 meta；`revalidate` 参数保留强制全量重拉的逃生口。python 应急脚本写入同格式
附件清单，两个工具互通。

### 环境坑：Bun canary test runner 子目录 spawn bug

本机 Bun 1.3.14-canary.1：`bun test` 跑**子目录**里的测试文件时，`Bun.spawn`
子进程的 stdout/stderr 静默为空（`python3 -c "print('hi')"` 返回空串）。最小复现
十行，确定性 100%。后果：`runner-competition-scheduling`（python 环境探测失败 →
`Selected Python environment is invalid: JSON Parse error: Unexpected EOF`）等
涉及子进程的测试在 `bun test test/` 下假失败；同一文件放仓库根目录即通过。全量
`bun test test/` 的 42 个失败里，除既有 EPERM/超时环境问题外均源于此。判断测试
真伪时先看失败是否涉及子进程 + 文件是否在子目录；非 spawn 类测试（如适配器套件）
不受影响。升级/回退 Bun 版本即可消除。


## 2026-09-02 比赛平台层解耦（platform decoupling）

西湖论剑专用构建被解耦为"通用比赛平台层 + 可插拔适配器"，作为通用版推入 main。
origin/main（40abce42，通用 V3 基线）是 xhlj 的祖先，因此是**快进推送**，无需 force。

设计（详见 docs/PLATFORMS.md）：

- `src/platform/adapter.ts`：`PlatformAdapter` 接口（提交/公告/环境/限额/normalizeFlag/
  inferChallengeCategory）+ 通用 `unwrapFlagValue`。
- `src/platform/registry.ts`：内置注册表。id/别名解析（`xihulunjian` → `dasctf`）、
  实例缓存（沿用"缓存 Promise 而非值"的并发语义）、`platformAdapterSummaries` 供 GUI。
- `src/platform/credentials.ts`：通用凭证存储 `$BOOM_HOME/platforms/<id>.json`；
  env 优先；旧 env/旧文件声明为 legacy 来源自动读取，写入总落新文件。
- `src/platform/adapters/dasctf.ts`：原 xihulunjian 适配器改名（git mv），id `dasctf`，
  `ownedAdapterIds` 含旧 id，旧工作区 meta.json 无需迁移。
- 接线：runner 按题目的 `platform.adapter` 经注册表分发（不再出现具体平台名）；
  gui 路由通用化为 `/api/platform`、`/api/platform/:id/*`，SSE 事件 `platform.*`；
  提交闸门用 `adapter.limits.maxSubmissionsPerChallenge`（无适配器时用
  submissions.ts 的产品默认 15）；policy 增加 `settings.competition.platformId`。
- **不**恢复声明式 manifest/OpenAPI 引擎（当年因真实 API 塞不进被删，见
  docs/platforms/dasctf.md 的实测偏差记录）。
- `provider-http.ts` 移除 `llm-gateway.dasctf.com` 域名嗅探：固定端点只认 `!` 标记，
  控制台指引改为"末尾加 `!`"。

敏感信息：2026-08-18 的 AccessKey 片段与个人网关 token URL 已从本文件脱敏；
注意它们仍存在于 origin/xhlj 的历史提交里——若该 remote 公开，应作废该网关 token。

兼容性验证：test/platform-credentials.test.ts 覆盖旧 env/旧文件迁移路径；
dasctf 适配器测试整体改名保留。

## 2026-09-12 仓库清理（残留文件与历史文档）

- 删除本地残留目录：`xihulunjian-ctf/`（7.8G 历史比赛工作区）、`ctf-bak/runs/`（4.2G，
  仅保留 `ctf-bak/challenges/`）、`claude-code-source-code/`、`tmp-solve/`、
  `prototype/boom-restyled*.html`、`test-results/`、`.zcode/plans/` 与散落的 `.DS_Store`。
- 删除过时文档：`docs/BOOM_V2.md`、`docs/BOOM_V2_REMAINING_WORK.md`、`docs/research/v3/`
  下的 M1–M5 对照研究及停更的 claude-context-migration-experiment；内容可从 git 历史取回。
  `docs/research/v3/ctf-agent-market-survey.md` 保留（SOLVER_IMPROVEMENT_PLAN 引用）。
- 移除空 gitlink `web`（mode 160000，指向不存在的提交 `8126fc64`）。
- `docs/` 仍在 `.gitignore` 中（初始提交即如此，属有意为之）：`PENTEST*.md`、
  `CONVERSATION_INTERFACES.md`、`SOLVER_IMPROVEMENT_PLAN.md`、`api_doc.md` 仍为本地未跟踪文件；
  其中 `api_doc.md` 被 `src/platform/adapters/dasctf.ts` 注释引用，若要公开需 `git add -f`。
