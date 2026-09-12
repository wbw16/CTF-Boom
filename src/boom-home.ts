/**
 * Boom's own data directory (`$BOOM_HOME`, default `~/.config/boom`): credentials, provider and MCP
 * stores, GUI state, and the installed runtime.
 *
 * One resolver for every caller, because the value comes from the environment and a launcher that
 * forwards an unset variable as the literal text `"undefined"` would otherwise resolve to
 * `<cwd>/undefined` — scattering state (and a stray `undefined/` folder) next to whatever directory
 * Boom happened to start from. An unusable value is ignored instead of trusted.
 * @module boom/boom-home
 */

import os from "node:os"
import path from "node:path"

export function boomHomeDirectory() {
  const configured = process.env.BOOM_HOME?.trim()
  if (configured && configured !== "undefined") return path.resolve(configured)
  return path.join(os.homedir(), ".config", "boom")
}

/**
 * Where `boom gui` writes workspace archives: `$BOOM_HOME/backups`.
 *
 * Backups live outside the workspace on purpose — a copy kept inside `<root>/` would be swept into
 * the next backup and deleted by "clear workspace", which is the one file an operator wants to keep.
 */
export function boomBackupsDirectory() {
  return path.join(boomHomeDirectory(), "backups")
}
