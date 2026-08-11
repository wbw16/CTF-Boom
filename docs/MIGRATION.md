# Prototype migration boundary

This repository was initialized on 2026-07-28 as a clean home for the Boom product and its default
agent, Boom.

## Migrated

- local challenge discovery and zero-required-metadata import;
- answer isolation and conservative flag-format derivation;
- copied run workspaces with `challenge/`, `work/`, and append-only `NOTES.md`;
- live token-budget enforcement from step-finish events;
- repeated tool-call stall detection with call-ID deduplication;
- candidate flag extraction and result scoring;
- independent macOS client with a native directory picker and private loopback API, live and durable
  run events, browser/headless compatibility modes, history compatibility, cancellation, hints,
  per-challenge lifecycle/model state, and safe local artifact operations;
- Boom agent prompt, CTF workflow skill, and `ctf-note` plugin;
- decision-point multi-model consultation with parallel drafts, synthesis, durable artifacts, and
  CLI/desktop entry points;
- writable runtime-resource installation and runtime registration checks;
- Boom-owned MCP configuration compiled into the isolated OpenCode runtime;
- a 52-test core suite and the self-authored `warmup-base64` end-to-end fixture.

## Deliberately not migrated

- the upstream source tree or any direct imports from its private packages;
- unrelated repository documentation and language-file changes;
- existing run artifacts, credentials, virtual environments, and caches;
- seven externally sourced challenges whose redistribution status and known answers have not been
  established;
- interactive chat, session resume, sandboxing, automatic
  platform login, and flag submission.

Those deferred capabilities should be designed in future sessions from this repository, not inherited
implicitly from the prototype.

## Compatibility boundary

The prototype pins published SDK and runtime packages at version `1.18.4`. All compatibility names and
environment variables are contained in `src/runtime.ts`. Other Boom modules must not depend on them.
OpenCode is now the stable product runtime rather than a dependency scheduled for replacement. Boom owns
the MCP configuration source of truth and deliberately does not inherit external OpenCode configuration.
