# Third-party notices

Boom currently uses the published `@opencode-ai/sdk` and `opencode-ai` packages as an internal
communication and execution runtime. Those packages are distributed under the MIT License by their
respective copyright holders.

Their names remain in dependency metadata and compatibility code. They are implementation details rather
than Boom's public product, command, configuration, or agent name.

See the installed packages for their complete license texts and notices.

The optional benchmark under `benchmarks/ctftiny` is derived from the official
[NYU-LLM-CTF/CTFTiny](https://github.com/NYU-LLM-CTF/CTFTiny) dataset. Its imported challenge
material is licensed under GPL-2.0; the complete upstream license is retained as
`benchmarks/ctftiny/LICENSE.CTFTINY`.

The bundled `resources/runtime/skills/reverse-engineer-anything` skill is derived from REA
([morluto/rea](https://github.com/morluto/rea), version 6.4.0). REA is distributed under the MIT
License; the complete upstream license is retained in that skill directory. The skill text has been
adapted for Boom's `rea_tools` / `rea_call` MCP bridge and its managed MCP configuration.
