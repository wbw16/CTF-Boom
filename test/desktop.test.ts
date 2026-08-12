import { expect, test } from "bun:test"
import { nativeClientOpenCommand } from "../src/desktop.ts"

test("launches the native UI through its app bundle so macOS uses the bundled icon", () => {
  expect(nativeClientOpenCommand("/tmp/Boom.app", "http://127.0.0.1:7331/")).toEqual([
    "open",
    "-n",
    "-W",
    "/tmp/Boom.app",
    "--args",
    "http://127.0.0.1:7331/",
  ])
})
