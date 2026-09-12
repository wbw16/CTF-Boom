import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import VisionPlugin from "../resources/plugin/vision.ts"

const temporary: string[] = []
const previousModel = process.env.BOOM_VISION_MODEL

afterEach(async () => {
  if (previousModel === undefined) delete process.env.BOOM_VISION_MODEL
  else process.env.BOOM_VISION_MODEL = previousModel
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function visionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-vision-"))
  temporary.push(root)
  await mkdir(path.join(root, "input"))
  await mkdir(path.join(root, "work"))
  await writeFile(path.join(root, "input", "sample.png"), Buffer.from("89504e470d0a1a0a", "hex"))
  return root
}

function visionClient(prompts: Record<string, unknown>[], deleted: string[]) {
  return {
    session: {
      async create() { return { data: { id: "vision-session" } } },
      async prompt(input: Record<string, unknown>) {
        prompts.push(input)
        return { data: { parts: [{ type: "text", text: "visible answer" }] } }
      },
      async delete(input: { path: { id: string } }) {
        deleted.push(input.path.id)
        return { data: true }
      },
    },
  }
}

// The plugin tool's exact Zod types are irrelevant to these tests; the fixture client and args are
// plain records, matching how the runtime invokes the tool.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runDescribe(definition: any, root: string, question: string) {
  return definition.execute(
    { path: "input/sample.png", question },
    {
      directory: root,
      worktree: root,
      sessionID: "solver-session",
      messageID: "message",
      agent: "boom",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    },
  )
}

test("describe-image sends one task-local image to the configured model and removes its session", async () => {
  const root = await visionFixture()
  process.env.BOOM_VISION_MODEL = "test/vision"
  const prompts: Record<string, unknown>[] = []
  const deleted: string[] = []
  const hooks = await VisionPlugin({ client: visionClient(prompts, deleted) } as never)
  const definition = hooks.tool?.["describe-image"]
  expect(definition).toBeDefined()
  const result = await runDescribe(definition!, root, "What is visible?")
  expect(result).toMatchObject({ output: "visible answer", metadata: { model: "test/vision" } })
  expect(prompts[0]).toMatchObject({
    body: {
      model: { providerID: "test", modelID: "vision" },
      parts: [
        { type: "text", text: "What is visible?" },
        { type: "file", mime: "image/png", filename: "sample.png" },
      ],
    },
  })
  expect(deleted).toEqual(["vision-session"])
})

test("describe-image persists its question and answer to work/vision-log.md", async () => {
  const root = await visionFixture()
  process.env.BOOM_VISION_MODEL = "test/vision"
  const hooks = await VisionPlugin({ client: visionClient([], []) } as never)
  const definition = hooks.tool?.["describe-image"]
  expect(definition).toBeDefined()

  await runDescribe(definition!, root, "Read the pixel text character by character.")
  await runDescribe(definition!, root, "Describe the top band pattern.")

  const log = await readFile(path.join(root, "work", "vision-log.md"), "utf8")
  expect(log).toContain("describe-image · input/sample.png")
  expect(log).toContain("**问题**：Read the pixel text character by character.")
  expect(log).toContain("Describe the top band pattern.")
  expect(log).toContain("visible answer")
})
