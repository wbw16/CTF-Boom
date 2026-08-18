import { tool, type Plugin } from "@opencode-ai/plugin"
import { constants, lstat, open, readFile, realpath } from "node:fs/promises"
import path from "node:path"

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
])

/**
 * Append one inspection record to `work/vision-log.md` so visual findings survive the turn: the
 * agent can re-read them without re-querying the vision model, and a resumed turn inherits them.
 * The log lives in the agent-writable `work/` tree, so O_NOFOLLOW closes the check/open race and a
 * symlink planted there can never redirect the append. Failures are swallowed — the log is a bonus,
 * never a reason for the inspection tool itself to fail.
 */
async function appendVisionLog(target: string, text: string) {
  const handle = await open(
    target,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(text, "utf8")
  } finally {
    await handle.close()
  }
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function selectedModel(value: string) {
  const resolved = value.startsWith("free/") ? `opencode/${value.slice("free/".length)}` : value
  const [providerID, ...parts] = resolved.split("/")
  const modelID = parts.join("/")
  if (!providerID || !modelID) throw new Error("Vision model must be provider/model")
  return { providerID, modelID }
}

const VisionPlugin: Plugin = async ({ client }) => {
  const configured = process.env.BOOM_VISION_MODEL?.trim()
  if (!configured) return {}
  const model = selectedModel(configured)

  return {
    tool: {
      "describe-image": tool({
        description: "Inspect one task-local image with Boom's configured vision model and answer a focused question about visible content.",
        args: {
          path: tool.schema.string().min(1).max(4096),
          question: tool.schema.string().min(1).max(8192),
        },
        async execute(args, ctx) {
          const root = await realpath(ctx.directory)
          const requested = path.isAbsolute(args.path) ? path.resolve(args.path) : path.resolve(root, args.path)
          if (!inside(root, requested)) throw new Error("Image path escapes the task workspace")
          const info = await lstat(requested).catch(() => undefined)
          if (!info?.isFile() || info.isSymbolicLink()) throw new Error("Image path must be a regular file")
          if (info.size > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 10 MiB vision limit")
          const target = await realpath(requested)
          if (!inside(root, target)) throw new Error("Image path escapes the task workspace")
          const mime = MIME.get(path.extname(target).toLowerCase())
          if (!mime) throw new Error("Vision supports PNG, JPEG, WebP, and GIF images")
          const bytes = await readFile(target)
          const created = await client.session.create({
            query: { directory: root },
            body: { title: "Boom image inspection" },
            signal: ctx.abort,
          })
          if (created.error || !created.data)
            throw new Error(`Failed to start image inspection: ${JSON.stringify(created.error)}`)
          const sessionID = created.data.id
          ctx.metadata({ title: `describe-image · ${path.basename(target)}`, metadata: { model: configured } })
          try {
            const response = await client.session.prompt({
              path: { id: sessionID },
              query: { directory: root },
              signal: ctx.abort,
              body: {
                agent: "boom-consultant",
                model,
                system: "Inspect the attached image and answer the question. Separate directly visible facts from uncertain inference. Do not call tools.",
                tools: {
                  "describe-image": false,
                  read: false,
                  list: false,
                  glob: false,
                  grep: false,
                },
                parts: [
                  { type: "text", text: args.question },
                  {
                    type: "file",
                    mime,
                    filename: path.basename(target),
                    url: `data:${mime};base64,${bytes.toString("base64")}`,
                  },
                ],
              },
            })
            if (response.error || !response.data)
              throw new Error(`Image inspection failed: ${JSON.stringify(response.error)}`)
            const output = response.data.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
              .trim()
            if (!output) throw new Error("Vision model returned no description")
            await appendVisionLog(
              path.join(root, "work", "vision-log.md"),
              [
                `## [${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}] describe-image · ${path.relative(root, target)}`,
                "",
                `**问题**：${args.question}`,
                "",
                "**回答**：",
                output,
                "",
              ].join("\n"),
            ).catch(() => undefined)
            return {
              title: `describe-image · ${path.basename(target)}`,
              output,
              metadata: { model: configured, path: path.relative(root, target) },
            }
          } finally {
            await client.session.delete({
              path: { id: sessionID },
              query: { directory: root },
            }).catch(() => undefined)
          }
        },
      }),
    },
  }
}

export default VisionPlugin
