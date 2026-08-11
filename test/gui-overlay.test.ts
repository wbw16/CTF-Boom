import { describe, expect, test } from "bun:test"
import { fitOverlayToViewport } from "../frontend/src/overlay.ts"

describe("GUI overlay positioning", () => {
  test("keeps menus inside every viewport edge", () => {
    const viewport = { width: 800, height: 600 }
    const overlay = { width: 230, height: 410 }

    expect(fitOverlayToViewport({ x: 760, y: 570 }, overlay, viewport)).toEqual({
      left: 562,
      top: 182,
    })
    expect(fitOverlayToViewport({ x: -20, y: -10 }, overlay, viewport)).toEqual({
      left: 8,
      top: 8,
    })
  })

  test("pins an overlay larger than the viewport to the safe gutter", () => {
    expect(
      fitOverlayToViewport(
        { x: 100, y: 100 },
        { width: 500, height: 700 },
        { width: 320, height: 480 },
      ),
    ).toEqual({ left: 8, top: 8 })
  })
})
