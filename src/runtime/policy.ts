import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import type { BoomToolProfile, BoomToolRegistry } from "./tool-registry.ts"

export type BoomPolicyDecision = {
  kind: "allow" | "isolate" | "deny"
  reason: string
}

export type TaskPathZone = "input" | "work" | "task"

export type ResolvedTaskPath = {
  root: string
  absolute: string
  relative: string
  zone: TaskPathZone
}

function deny(reason: string): BoomPolicyDecision {
  return { kind: "deny", reason }
}

function effectDecision(profile: BoomToolProfile, tool: string, sideEffect: string): BoomPolicyDecision {
  if (tool === "task") {
    return profile.effects.delegate === "allow"
      ? { kind: "isolate", reason: "subagent execution requires an isolated workspace" }
      : deny("the profile cannot delegate")
  }
  if (tool === "ctf-submit") {
    return profile.effects.submit === "allow"
      ? { kind: "allow", reason: "the profile may submit a candidate" }
      : deny("the profile cannot submit candidates")
  }
  if (sideEffect === "write") {
    return profile.effects.write === "none"
      ? deny("the profile is read-only")
      : { kind: "allow", reason: `writes are scoped to the profile's ${profile.effects.write} workspace` }
  }
  if (sideEffect === "process") {
    return profile.effects.process === "allow"
      ? { kind: "isolate", reason: "process execution requires the task sandbox" }
      : deny("the profile cannot start processes")
  }
  if (sideEffect === "network") {
    return profile.effects.network === "allow"
      ? { kind: "isolate", reason: "network access requires the network broker" }
      : deny("the profile cannot access the network")
  }
  if (sideEffect === "memory") {
    return profile.effects.memory === "allow"
      ? { kind: "allow", reason: "the profile may update task memory" }
      : deny("the profile cannot update task memory")
  }
  return { kind: "allow", reason: "the tool is read-only" }
}

/** Decide whether a profile may dispatch a registered tool. Resource checks happen after this gate. */
export function decideBoomToolPolicy(
  registry: BoomToolRegistry,
  profileID: string,
  tool: string,
): BoomPolicyDecision {
  const profile = registry.profiles[profileID]
  if (!profile) return deny(`unknown tool profile: ${profileID}`)
  if (!profile.tools.includes(tool)) return deny(`tool ${tool} is not visible to profile ${profileID}`)
  const descriptor = registry.tools[tool]
  if (!descriptor) return deny(`tool ${tool} is not registered`)
  return effectDecision(profile, tool, descriptor.sideEffect)
}

/** Check an extra effect requested by a tool, such as network access from a shell process. */
export function decideBoomEffectPolicy(
  registry: BoomToolRegistry,
  profileID: string,
  effect: "network" | "process" | "memory" | "submit" | "delegate",
): BoomPolicyDecision {
  const profile = registry.profiles[profileID]
  if (!profile) return deny(`unknown tool profile: ${profileID}`)
  if (effect === "network") return profile.effects.network === "allow"
    ? { kind: "isolate", reason: "network access requires the network broker" }
    : deny("the profile cannot access the network")
  if (effect === "process") return profile.effects.process === "allow"
    ? { kind: "isolate", reason: "process execution requires the task sandbox" }
    : deny("the profile cannot start processes")
  if (effect === "memory") return profile.effects.memory === "allow"
    ? { kind: "allow", reason: "the profile may update task memory" }
    : deny("the profile cannot update task memory")
  if (effect === "submit") return profile.effects.submit === "allow"
    ? { kind: "allow", reason: "the profile may submit a candidate" }
    : deny("the profile cannot submit candidates")
  return profile.effects.delegate === "allow"
    ? { kind: "isolate", reason: "delegation requires an isolated workspace" }
    : deny("the profile cannot delegate")
}

export function assertBoomPolicy(decision: BoomPolicyDecision, tool: string): void {
  if (decision.kind === "deny") throw new Error(`Boom policy denied ${tool}: ${decision.reason}`)
}

function inside(base: string, target: string): boolean {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function pathSegments(requested: string): string[] {
  if (!requested || requested.includes("\0")) throw new Error("Task path must be a non-empty path without NUL")
  if (path.isAbsolute(requested)) throw new Error(`Task path must be relative: ${requested}`)
  const segments = requested.split(/[\\/]+/)
  if (segments.includes("..")) throw new Error(`Task path escapes the workspace: ${requested}`)
  return segments.filter((segment) => segment && segment !== ".")
}

/**
 * Resolve an existing task path without following symlinks at any level.
 *
 * Native tools deliberately accept task-relative paths only. Compatibility adapters must normalize
 * provider-specific absolute paths before they cross this boundary.
 */
export async function resolveTaskPath(
  directory: string,
  requested: string,
  access: "read" | "write" = "read",
): Promise<ResolvedTaskPath> {
  const root = await realpath(path.resolve(directory))
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error(`Task root is not a real directory: ${directory}`)
  const segments = pathSegments(requested)
  const absolute = path.join(root, ...segments)
  if (!inside(root, absolute)) throw new Error(`Task path escapes the workspace: ${requested}`)

  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`Task path does not exist: ${requested}`)
      throw error
    })
    if (info.isSymbolicLink()) throw new Error(`Task path contains a symbolic link: ${requested}`)
    if (index < segments.length - 1 && !info.isDirectory())
      throw new Error(`Task path parent is not a directory: ${requested}`)
  }

  const relative = segments.join("/") || "."
  const first = segments[0]
  // `challenge/` is the pre-rename name of the read-only input zone; task directories written by
  // earlier Boom versions keep working until they are migrated.
  const zone: TaskPathZone =
    first === "input" || first === "challenge" ? "input" : first === "work" ? "work" : "task"
  if (access === "write") {
    if (zone !== "work" || segments.length < 2)
      throw new Error(`Boom policy denied write outside work/: ${requested}`)
    // Host-owned subtrees agents must never rewrite: work/.boom/**, work/RESULT.json, and the
    // IDA proxy archive work/ida/** (its results plus index.jsonl manifest).
    if (segments[1] === ".boom" || segments[1] === "ida" || relative === "work/RESULT.json")
      throw new Error(`Boom policy denied write to host-owned task state: ${requested}`)
  }
  if (access === "read") {
    // Agent-visible command logs are deliberately readable: the bash/boom-exec result already
    // points at `work/.boom/commands/<id>.log`, and a model that cannot open the path it was handed
    // either repeats the command or gives up. Host-owned metadata (the events ledger, blockers)
    // stays closed, and writes below remain refused for the whole subtree.
    if (zone === "work" && segments.length >= 2 && (segments[1] === ".boom" || relative === "work/RESULT.json")) {
      const commandLog = segments.length === 4 && segments[1] === ".boom" && segments[2] === "commands" &&
        segments[3]!.endsWith(".log")
      if (!commandLog)
        throw new Error(`Boom policy denied read of host-owned task state: ${requested}`)
    }
  }
  return { root, absolute, relative, zone }
}
