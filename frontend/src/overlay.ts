export type OverlayPoint = { x: number; y: number }
export type OverlaySize = { width: number; height: number }

export function fitOverlayToViewport(
  anchor: OverlayPoint,
  overlay: OverlaySize,
  viewport: OverlaySize,
  gutter = 8,
) {
  const maxLeft = Math.max(gutter, viewport.width - overlay.width - gutter)
  const maxTop = Math.max(gutter, viewport.height - overlay.height - gutter)
  return {
    left: Math.max(gutter, Math.min(anchor.x, maxLeft)),
    top: Math.max(gutter, Math.min(anchor.y, maxTop)),
  }
}
