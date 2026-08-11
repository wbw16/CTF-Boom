let nativeRequestID = 0
const nativeDirectoryRequests = new Map<string, (path: string | null) => void>()

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        boom?: {
          postMessage: (value: unknown) => void
        }
      }
    }
    __boomNativeDirectoryResult?: (result: { id?: string; path?: string }) => void
  }
}

export function chooseDirectory(options: { title: string; initial?: string }): Promise<string | null> {
  const bridge = window.webkit?.messageHandlers?.boom
  if (!bridge) return Promise.resolve(window.prompt(options.title, options.initial ?? ""))
  const id = `directory-${++nativeRequestID}`
  return new Promise((resolve) => {
    nativeDirectoryRequests.set(id, resolve)
    try {
      bridge.postMessage({ type: "pickDirectory", id, title: options.title, initial: options.initial ?? "" })
    } catch {
      nativeDirectoryRequests.delete(id)
      resolve(window.prompt(options.title, options.initial ?? ""))
    }
  })
}

export function setNativeAppearance(appearance: "light" | "dark"): void {
  const bridge = window.webkit?.messageHandlers?.boom
  if (!bridge) return
  try {
    bridge.postMessage({ type: "setAppearance", appearance })
  } catch {
    // Running outside the desktop shell: the native titlebar does not exist.
  }
}

window.__boomNativeDirectoryResult = (result) => {
  const resolve = nativeDirectoryRequests.get(result?.id ?? "")
  if (!resolve) return
  nativeDirectoryRequests.delete(result.id ?? "")
  resolve(typeof result.path === "string" && result.path ? result.path : null)
}
