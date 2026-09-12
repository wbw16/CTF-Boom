import { describe, expect, test } from "bun:test"

type FakeWindow = {
  webkit?: { messageHandlers?: { boom?: { postMessage: (value: unknown) => void } } }
  __boomNativePickerResult?: (result: { id?: string; path?: string | null; paths?: string[] }) => void
  prompt?: (message: string, value?: string) => string | null
}

const messages: Array<{ id?: string; type?: string; multiple?: boolean; title?: string }> = []
const shell: FakeWindow = {
  webkit: {
    messageHandlers: {
      boom: {
        postMessage: (value) => messages.push(value as { id?: string; type?: string }),
      },
    },
  },
}
;(globalThis as unknown as { window: FakeWindow }).window = shell
const bridge = await import("../frontend/src/bridge.ts")

describe("GUI native picker bridge", () => {
  test("resolves the paths a multi-select file panel returns", async () => {
    const pending = bridge.chooseFiles({ title: "附件", initial: "/tmp", multiple: true })
    const request = messages.at(-1)
    expect(request?.type).toBe("pickFiles")
    expect(request?.multiple).toBe(true)

    shell.__boomNativePickerResult?.({ id: request?.id, paths: ["/tmp/one.bin", "/tmp/two.bin"] })
    expect(await pending).toEqual(["/tmp/one.bin", "/tmp/two.bin"])
  })

  test("treats a dismissed file panel as no selection", async () => {
    const pending = bridge.chooseFiles({ title: "附件" })
    const request = messages.at(-1)
    shell.__boomNativePickerResult?.({ id: request?.id, path: null, paths: [] })
    expect(await pending).toBeNull()
  })

  test("keeps the single-path directory panel unchanged", async () => {
    const pending = bridge.chooseDirectory({ title: "工作目录", initial: "/tmp" })
    const request = messages.at(-1)
    expect(request?.type).toBe("pickDirectory")

    shell.__boomNativePickerResult?.({ id: request?.id, path: "/Volumes/Storage/Code/boom-v3" })
    expect(await pending).toBe("/Volumes/Storage/Code/boom-v3")
  })

  test("falls back to a newline-separated prompt without a native shell", async () => {
    const saved = shell.webkit
    shell.webkit = undefined
    shell.prompt = () => " /tmp/a.bin \n\n/tmp/b.bin\n"
    try {
      expect(await bridge.chooseFiles({ title: "附件" })).toEqual(["/tmp/a.bin", "/tmp/b.bin"])
      shell.prompt = () => ""
      expect(await bridge.chooseFiles({ title: "附件" })).toBeNull()
    } finally {
      shell.webkit = saved
      shell.prompt = undefined
    }
  })
})
