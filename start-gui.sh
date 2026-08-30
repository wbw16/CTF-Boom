#!/usr/bin/env bash
# Start Boom's GUI with a ready-to-use local 西湖论剑 workspace.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="${BOOM_ROOT:-${project_dir}/xihulunjian-ctf}"

# Boom initializes the workspace itself on startup (runs/, plus challenges/ unless
# category folders such as WEB/PWN/MISC already sit directly inside the root).
# Do not pre-create challenges/ here: an empty one would shadow a root-level catalog.

cd -- "${project_dir}"
exec bun src/index.ts gui --root "${root}" "$@"
