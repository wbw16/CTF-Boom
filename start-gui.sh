#!/usr/bin/env bash
# Start Boom's GUI with a ready-to-use local 西湖论剑 workspace.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="${BOOM_ROOT:-${project_dir}/xihulunjian-ctf}"

# The GUI intentionally requires these directories to exist.  Creating them here
# makes the first start work before the initial platform synchronization.
mkdir -p -- "${root}/challenges" "${root}/runs"

cd -- "${project_dir}"
exec bun src/index.ts gui --root "${root}" "$@"
