import type { BoomNetworkBroker } from "./network-broker.ts"

export type BoomWebToolName = "webfetch" | "websearch"

export type BoomWebToolResult = {
  title: string
  output: string
  metadata?: Record<string, unknown>
}

const MAX_VISIBLE_BYTES = 32_768

function bounded(text: string): { output: string; truncated: boolean } {
  const bytes = Buffer.from(text)
  if (bytes.byteLength <= MAX_VISIBLE_BYTES) return { output: text, truncated: false }
  const suffix = "\n… web output truncated by Boom …"
  return {
    output: new TextDecoder().decode(bytes.subarray(0, MAX_VISIBLE_BYTES - Buffer.byteLength(suffix))) + suffix,
    truncated: true,
  }
}

/** Unicode scalar values only: beyond 0x10FFFF, or inside the surrogate block, no character exists. */
function decodeCodePoint(value: number): string | undefined {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x10ffff) return undefined
  if (value >= 0xd800 && value <= 0xdfff) return undefined
  return String.fromCodePoint(value)
}

function decodeEntities(text: string): string {
  try {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      // An out-of-range numeric entity (e.g. &#x110000;) names no character: keep the entity text
      // verbatim instead of letting fromCodePoint's RangeError disable the whole webfetch tool.
      const normalized = entity.toLowerCase()
      if (normalized.startsWith("#x"))
        return decodeCodePoint(Number.parseInt(normalized.slice(2), 16)) ?? match
      if (normalized.startsWith("#"))
        return decodeCodePoint(Number.parseInt(normalized.slice(1), 10)) ?? match
      return named[normalized] ?? match
    })
  } catch {
    // Defensive backstop for anything the validation above misses: rendering must degrade to the
    // untouched original text, never fail.
    return text
  }
}

function htmlText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function htmlMarkdown(html: string): string {
  const linked = html
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_all, url: string, label: string) => `[${htmlText(label)}](${url})`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level: string, text: string) => `${"#".repeat(Number(level))} ${htmlText(text)}\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_all, text: string) => `- ${htmlText(text)}\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_all, text: string) => `\n\`\`\`\n${decodeEntities(text.replace(/<[^>]+>/g, ""))}\n\`\`\`\n`)
  return htmlText(linked)
}

export function createBoomWebToolExecutor(broker: BoomNetworkBroker) {
  return async (input: {
    name: BoomWebToolName
    arguments: Record<string, unknown>
    directory: string
    sessionID?: string
    signal?: AbortSignal
  }): Promise<BoomWebToolResult> => {
    if (input.name === "websearch") {
      const query = input.arguments.query as string
      const result = await broker.search({
        directory: input.directory,
        sessionID: input.sessionID,
        request: {
          query,
          numResults: typeof input.arguments.numResults === "number" ? input.arguments.numResults : 8,
          livecrawl: input.arguments.livecrawl === "preferred" ? "preferred" : "fallback",
          type: input.arguments.type === "fast" || input.arguments.type === "deep" ? input.arguments.type : "auto",
          contextMaxCharacters: typeof input.arguments.contextMaxCharacters === "number"
            ? input.arguments.contextMaxCharacters
            : 10_000,
          signal: input.signal,
        },
      })
      const output = bounded(result.output || "No search results found.")
      return {
        title: `${result.provider} search: ${query}`,
        output: output.output,
        metadata: { provider: result.provider, query, truncated: output.truncated },
      }
    }

    const url = input.arguments.url as string
    const format = input.arguments.format === "text" || input.arguments.format === "html"
      ? input.arguments.format
      : "markdown"
    const response = await broker.fetch({
      directory: input.directory,
      sessionID: input.sessionID,
      url,
      timeoutMs: typeof input.arguments.timeout === "number" ? input.arguments.timeout * 1_000 : undefined,
      signal: input.signal,
    })
    const contentType = response.headers["content-type"] ?? "application/octet-stream"
    const textual = /(?:text\/|application\/(?:json|xml|javascript|xhtml\+xml))/.test(contentType)
    let rendered: string
    if (!textual) rendered = `<binary response: ${contentType}, ${response.body.byteLength} bytes>`
    else {
      const content = response.body.toString("utf8")
      const html = /html|xhtml/.test(contentType)
      rendered = !html || format === "html" ? content : format === "text" ? htmlText(content) : htmlMarkdown(content)
    }
    const output = bounded(rendered)
    return {
      title: `HTTP ${response.status} · ${response.url} (${contentType})`,
      output: output.output,
      metadata: {
        url: response.url,
        status: response.status,
        contentType,
        bytes: response.body.byteLength,
        redirects: response.redirects,
        durationMs: response.durationMs,
        truncated: output.truncated,
      },
    }
  }
}
