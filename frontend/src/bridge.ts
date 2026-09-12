let nativeRequestID = 0
const nativeRequests = new Map<string, (result: NativePickerReply) => void>()

type NativePickerReply = { path?: string; paths?: string[] }

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        boom?: {
          postMessage: (value: unknown) => void
        }
      }
    }
    __boomNativePickerResult?: (result: { id?: string; path?: string; paths?: string[] }) => void
  }
}

/**
 * Ask the macOS shell for a selection. Returns null when Boom runs in a browser, where no native
 * picker exists and the caller falls back to a prompt, and never rejects: a shell that closes the
 * panel without answering resolves to an empty reply.
 */
function requestNative(message: {
  type: "pickDirectory" | "pickFiles"
  title: string
  initial: string
  multiple?: boolean
}): Promise<NativePickerReply> | null {
  const bridge = window.webkit?.messageHandlers?.boom
  if (!bridge) return null
  const id = `${message.type}-${++nativeRequestID}`
  return new Promise((resolve) => {
    nativeRequests.set(id, resolve)
    try {
      bridge.postMessage({ ...message, id })
    } catch {
      nativeRequests.delete(id)
      resolve({})
    }
  })
}

export async function chooseDirectory(options: { title: string; initial?: string }): Promise<string | null> {
  const native = requestNative({
    type: "pickDirectory",
    title: options.title,
    initial: options.initial ?? "",
  })
  if (native === null) return window.prompt(options.title, options.initial ?? "")
  const result = await native
  return result.path?.trim() ? result.path : null
}

/**
 * Pick one or more files from the operator's disk, for challenge attachments.
 *
 * A browser cannot expose a picked file's path, so the compatibility fallback asks for the paths
 * directly — the same trade-off `chooseDirectory` already makes when it prompts.
 */
export async function chooseFiles(options: {
  title: string
  initial?: string
  multiple?: boolean
}): Promise<string[] | null> {
  const native = requestNative({
    type: "pickFiles",
    title: options.title,
    initial: options.initial ?? "",
    multiple: options.multiple !== false,
  })
  if (native === null) {
    const answer = window.prompt(`${options.title}（每行一个绝对路径）`, options.initial ?? "")
    if (answer === null) return null
    const paths = answer
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    return paths.length > 0 ? paths : null
  }
  const result = await native
  const paths = (result.paths ?? (result.path ? [result.path] : [])).filter(
    (path): path is string => typeof path === "string" && path.trim() !== "",
  )
  return paths.length > 0 ? paths : null
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

// Installed lazily so importing this module never requires a DOM (component tests render
// outside a browser, and the bridge is now a static import of several views).
if (typeof window !== "undefined") {
  window.__boomNativePickerResult = (result) => {
    const resolve = nativeRequests.get(result?.id ?? "")
    if (!resolve) return
    nativeRequests.delete(result.id ?? "")
    resolve({
      path: typeof result.path === "string" ? result.path : undefined,
      paths: Array.isArray(result.paths)
        ? result.paths.filter((path): path is string => typeof path === "string")
        : undefined,
    })
  }
}
