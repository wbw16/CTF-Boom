import { expect, test } from "bun:test"
import { markRead, noticeScope, parseReadNotices } from "../frontend/src/notice-state.ts"

test("read notices persist and remain isolated by workspace and platform", () => {
  const one = noticeScope("/a", "platform-one")
  const two = noticeScope("/a", "platform-two")
  const otherRoot = noticeScope("/b", "platform-one")
  const marked = markRead({}, one, 7)
  expect(marked[one]).toEqual([7])
  expect(marked[two]).toBeUndefined()
  expect(marked[otherRoot]).toBeUndefined()
  expect(markRead(marked, one, 7)).toBe(marked)
  expect(parseReadNotices(JSON.stringify(marked))).toEqual(marked)
  expect(parseReadNotices("broken")).toEqual({})
})
