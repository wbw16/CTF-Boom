const MD_SAFE_HREF = /^(?:https?:\/\/|mailto:)[^"'<>\s]+$/i

function esc(value: unknown) {
  return String(value ?? "").replace(/[&<>"]/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string)
}

function mdInline(escaped: string) {
  return escaped
    .replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${code}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, text: string, href: string) =>
      MD_SAFE_HREF.test(href)
        ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`
        : whole)
}

/** Minimal markdown renderer for untrusted NOTES.md / WRITEUP.md content. */
export function renderMarkdown(text: string) {
  const source = String(text ?? "")
  if (!source.trim()) return ""
  const out: string[] = []
  let list: "ul" | "ol" | null = null
  let para: string[] = []
  let fence: string | null = null
  let code: string[] = []

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${mdInline(esc(para.join(" ")))}</p>`)
      para = []
    }
  }
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  const openList = (kind: "ul" | "ol") => {
    if (list !== kind) {
      closeList()
      out.push(`<${kind}>`)
      list = kind
    }
  }
  const flushCode = () => {
    out.push(`<pre class="md-code"><code>${esc(code.join("\n"))}</code></pre>`)
    fence = null
    code = []
  }

  for (const raw of source.split(/\r?\n/)) {
    const fenceMatch = /^\s*(```+|~~~+)(.*)$/.exec(raw)
    if (fence) {
      if (fenceMatch && raw.trim().startsWith(fence)) flushCode()
      else code.push(raw)
      continue
    }
    if (fenceMatch) {
      flushPara()
      closeList()
      fence = fenceMatch[1]!.slice(0, 3)
      continue
    }
    if (!raw.trim()) {
      flushPara()
      closeList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      flushPara()
      closeList()
      const level = heading[1]!.length
      out.push(`<h${level} class="md-h">${mdInline(esc(heading[2]))}</h${level}>`)
      continue
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(raw)) {
      flushPara()
      closeList()
      out.push("<hr>")
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw)
    if (quote) {
      flushPara()
      closeList()
      out.push(`<blockquote>${mdInline(esc(quote[1]))}</blockquote>`)
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(raw)
    if (bullet || ordered) {
      flushPara()
      openList(bullet ? "ul" : "ol")
      out.push(`<li>${mdInline(esc((bullet || ordered)![1]))}</li>`)
      continue
    }
    para.push(raw.trim())
  }
  if (fence) flushCode()
  flushPara()
  closeList()
  return out.join("")
}
