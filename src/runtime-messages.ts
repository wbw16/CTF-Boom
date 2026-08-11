import type { RuntimeMessage } from "./runtime-contract.ts"

function settled(state: RuntimeMessage["parts"][number]["state"]) {
  return state === "completed" || state === "error"
}

/**
 * Return every message ID after which a transcript can be forked without orphaning a tool use or
 * result. A settled tool part is self-contained (the OpenCode representation); an unsettled
 * assistant tool part must be followed by exactly one matching tool-role result (the Native
 * representation).
 */
export function runtimeForkBoundaries(messages: readonly RuntimeMessage[]) {
  const boundaries: string[] = []
  const pending = new Set<string>()
  const used = new Set<string>()
  let valid = true

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        if (!part.callID || used.has(part.callID)) {
          valid = false
          continue
        }
        used.add(part.callID)
        if (!settled(part.state)) pending.add(part.callID)
      }
    } else if (message.role === "tool") {
      const results = message.parts.filter((part) => part.type === "tool")
      if (results.length === 0) valid = false
      for (const part of results) {
        if (!part.callID || !pending.delete(part.callID)) valid = false
      }
    }

    if (valid && pending.size === 0 && (message.role === "assistant" || message.role === "tool"))
      boundaries.push(message.id)
  }
  return boundaries
}

/** Resolve and validate the requested fork point using only Boom-neutral transcript semantics. */
export function resolveRuntimeForkBoundary(
  messages: readonly RuntimeMessage[],
  messageID?: string,
) {
  const boundaries = runtimeForkBoundaries(messages)
  const selected = messageID ?? boundaries.at(-1)
  if (!selected)
    throw new Error("Runtime conversation has no complete API-round boundary to fork")
  if (!messages.some((message) => message.id === selected))
    throw new Error(`Runtime fork message does not exist: ${selected}`)
  if (!boundaries.includes(selected))
    throw new Error(`Runtime fork message is not a complete API-round boundary: ${selected}`)
  return selected
}
