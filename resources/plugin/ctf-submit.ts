import { tool, type Plugin } from "@opencode-ai/plugin"
import { lstat, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function resultTarget(directory: string) {
  const runRoot = await realpath(path.resolve(directory))
  const workRoot = await realpath(path.join(runRoot, "work"))
  if (!inside(runRoot, workRoot)) throw new Error("Result work directory escapes the run.")
  const target = path.join(workRoot, "RESULT.json")
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
    throw new Error("Result is not a real file.")
  return target
}

const CtfSubmitPlugin: Plugin = async () => ({
  tool: {
    "ctf-submit": tool({
      description: `Record Boom's current flag candidate in work/RESULT.json.

Call this immediately after finding a credible flag candidate. The host ends the current solve turn,
passes the value to an optional platform adapter or manual review, and only requests a final Writeup
after acceptance. The call is idempotent and may replace the same result.`,
      args: {
        candidate: tool.schema.string().min(1).max(4096).describe("The literal flag, with no Markdown or commentary."),
      },
      async execute(args, ctx) {
        if (path.resolve(ctx.directory) === path.resolve(ctx.worktree))
          throw new Error("The session is not inside a Boom run workspace. Start it with `boom run`.")
        const flag = args.candidate.trim()
        if (!flag || /[\0\r\n]/.test(flag)) throw new Error("candidate must be one non-empty line.")
        const target = await resultTarget(ctx.directory)
        const result = {
          version: 1,
          status: "ready",
          sessionID: ctx.sessionID,
          flag,
          writeup: "work/WRITEUP.md",
          recordedAt: new Date().toISOString(),
        }
        const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
        await writeFile(temporary, `${JSON.stringify(result, undefined, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        })
        await rename(temporary, target)
        return {
          title: "candidate recorded",
          output: "Stored the candidate in work/RESULT.json; Boom will stop this solve turn and request a verdict.",
          metadata: { path: "work/RESULT.json", recordedAt: result.recordedAt },
        }
      },
    }),
  },
})

export default CtfSubmitPlugin
