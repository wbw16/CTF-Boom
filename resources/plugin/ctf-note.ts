import { tool, type Plugin } from "@opencode-ai/plugin"
import { appendFile, lstat, rename, writeFile } from "node:fs/promises"
import path from "node:path"

const HEADER = "# NOTES\n\n这是跨轮次、跨模型共享的任务记忆。由 ctf-note 工具维护。\n"

const CtfNotePlugin: Plugin = async () => ({
  tool: {
    "ctf-note": tool({
      description: `Maintain this Boom task's durable NOTES.md memory.

Use kind "note" for durable progress and artifact paths, kind "ruled-out" for an evidence-backed
closed direction, and kind "checkpoint" for a compact handoff to a later turn. Record only information
that another turn needs; this tool does not define how to solve the challenge.`,
      args: {
        kind: tool.schema.enum(["note", "ruled-out", "checkpoint"]),
        text: tool.schema.string().min(1),
      },
      async execute(args, ctx) {
        if (path.resolve(ctx.directory) === path.resolve(ctx.worktree))
          throw new Error("The session is not inside a Boom run workspace. Start it with `boom run`.")

        const file = path.join(ctx.directory, "NOTES.md")
        const info = await lstat(file).catch(() => undefined)
        if (info?.isSymbolicLink() || (info && !info.isFile()))
          throw new Error("NOTES.md is not a real file.")
        const existing = await Bun.file(file).text().catch(() => undefined)
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

        if (args.kind === "checkpoint") {
          const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
          const text = args.text.trim()
          await writeFile(temporary, `${text.startsWith("# NOTES") ? text : `${HEADER}\n${text}`}\n`, "utf8")
          await rename(temporary, file)
          return {
            title: "checkpoint -> NOTES.md",
            output: `Replaced NOTES.md with a ${text.length}-character task checkpoint.`,
          }
        }

        await appendFile(
          file,
          `${existing === undefined ? HEADER : ""}\n## [${timestamp}] ${args.kind}\n\n${args.text.trim()}\n`,
          "utf8",
        )

        return {
          title: `${args.kind} -> NOTES.md`,
          output: `Appended ${args.kind} entry (${(existing?.match(/^## \[/gm)?.length ?? 0) + 1} total).`,
        }
      },
    }),
  },
})

export default CtfNotePlugin
