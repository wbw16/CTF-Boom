# Boom development notes

- The product and default CTF-solving agent are named `Boom`; the CLI and agent ID are `boom`.
- Keep the runtime dependency behind `src/runtime.ts`; do not import source files from the neighboring
  `opencode` repository.
- Public help, errors, paths, and documentation use Boom names. Compatibility dependency names may
  remain inside `package.json` and `src/runtime.ts`.
- Runtime agent, skill, and plugin resources live under `resources/` and are copied to a writable Boom
  data directory before the internal runtime starts.
- Known flags must never enter a run workspace.
- Full analysis output belongs under a run's `work/` directory. Durable findings and ruled-out directions
  belong in `NOTES.md`.
- Run `bun run typecheck` and `bun test` from this repository before packaging.
- OpenCode is the stable product runtime. Current work improves Boom's product capabilities instead of
  replacing the runtime; keep OpenCode-specific integration behind `src/runtime.ts`.
- MCP protocol, transport, discovery, and calls are provided by OpenCode. Boom owns its isolated MCP
  configuration, UI/CLI, enablement, and credential references and must not inherit user or project
  OpenCode MCP configuration implicitly.
