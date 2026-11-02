#!/usr/bin/env bun
/**
 * Register a local REA checkout as Boom's managed `rea` MCP server.
 *
 * This is the source-build path: it points Boom at `<checkout>/scripts/rea.mjs` so the
 * integration uses the checkout you develop in instead of downloading `rea-agents` from npm.
 * The runtime still wraps the command in Boom's REA bridge, so agents only see `rea_tools` /
 * `rea_call`.
 *
 * Usage:
 *   bun scripts/install-rea.ts [--source <dir>] [--build] [--disabled] [--agent <boom-agent>]
 *   bun scripts/install-rea.ts --npx [--disabled] [--agent <boom-agent>]
 */
import { lstat } from "node:fs/promises"
import path from "node:path"
import {
  loadMcpStore,
  normalizeManagedMcpServer,
  saveMcpStore,
  type BoomMcpAgentID,
} from "../src/mcp-config.ts"
import { inspectReaSource, reaMcpServer, REA_DEFAULT_AGENTS } from "../src/rea.ts"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")

function usage(code = 1): never {
  const output = code === 0 ? process.stdout : process.stderr
  output.write([
    "Usage: bun scripts/install-rea.ts [options]",
    "",
    "Registers REA as Boom's managed `rea` MCP server. Without --npx, the command points at a",
    "local REA checkout; with --npx it uses the pinned npm release.",
    "",
    "Options:",
    "  --source <dir>          REA checkout (default: BOOM_REA_SOURCE or ../rea)",
    "  --build                 run npm ci / npm run build:cached when the checkout is not built",
    "  --npx                   register `npx -y rea-agents@<pinned> mcp` instead of a checkout",
    "  --node <path>           Node executable used to run the checkout (default: node on PATH)",
    "  --agent <boom-agent>    allow this Boom role; may be repeated",
    "  --disabled              save without connecting on runtime startup",
    "",
    `Default agents: ${REA_DEFAULT_AGENTS.join(", ")}`,
    "",
  ].join("\n"))
  process.exit(code)
}

function value(argv: string[], index: number) {
  const next = argv[index]
  if (!next) usage()
  return next
}

async function exists(target: string) {
  return lstat(target).then(() => true).catch(() => false)
}

async function run(command: string[], cwd: string) {
  process.stderr.write(`\n$ ${command.join(" ")}\n`)
  const child = Bun.spawn(command, {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited with code ${code}`)
}

async function build(source: string, inspection: { built: boolean }) {
  if (inspection.built) return
  if (!(await exists(path.join(source, "node_modules", ".bin", "turbo"))))
    await run(["npm", "ci"], source)
  await run(["npm", "run", "build:cached"], source)
}

function supportsReaNode(version: string) {
  const match = /^v(\d+)\.(\d+)\./.exec(version.trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major === 22) return minor >= 19
  if (major === 24) return minor >= 11
  return major >= 26
}

async function checkNode(node: string) {
  const child = Bun.spawn([node, "--version"], { stdout: "pipe", stderr: "pipe" })
  const [output] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const version = output.trim()
  if (!supportsReaNode(version))
    throw new Error(
      `REA requires Node.js 22.19+, 24.11+ or 26+; ${node} reports ${version || "an unknown version"}. ` +
        "Install a supported Node.js or pass --node <path>.",
    )
  return version
}

async function main(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) usage(0)

  let sourceDirectory = process.env.BOOM_REA_SOURCE?.trim() || path.join(PACKAGE_ROOT, "..", "rea")
  let useNpx = false
  let shouldBuild = false
  let enabled = true
  let nodeExecutable: string | undefined
  const agents: BoomMcpAgentID[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!
    if (option === "--source") sourceDirectory = value(argv, ++index)
    else if (option === "--build") shouldBuild = true
    else if (option === "--npx") useNpx = true
    else if (option === "--node") nodeExecutable = value(argv, ++index)
    else if (option === "--agent") agents.push(value(argv, ++index) as BoomMcpAgentID)
    else if (option === "--disabled") enabled = false
    else usage()
  }

  let server
  if (useNpx) {
    if (shouldBuild) throw new Error("--build is only valid with a local REA source checkout")
    server = reaMcpServer({
      enabled,
      ...(agents.length ? { agents } : {}),
    })
    process.stdout.write("Using the pinned npm REA release. Node.js 22.19+/24.11+/26+ and npx must be on PATH.\n")
  } else {
    const inspection = await inspectReaSource(sourceDirectory)
    if (!inspection.built) {
      if (!shouldBuild)
        throw new Error([
          `REA checkout is not built: ${inspection.directory}`,
          `Build it first with "npm ci && npm run build:cached", or rerun this command with --build.`,
        ].join("\n"))
      await build(inspection.directory, inspection)
      const rebuilt = await inspectReaSource(inspection.directory)
      if (!rebuilt.built)
        throw new Error(`REA build finished but ${rebuilt.buildOutput} is still missing`)
      Object.assign(inspection, rebuilt)
    }
    const node = nodeExecutable ?? Bun.which("node")
    if (!node)
      throw new Error(
        "REA requires Node.js 22.19+, 24.11+ or 26+. Install it, or pass --node <path>.",
      )
    const version = await checkNode(node)
    server = reaMcpServer({
      sourceDirectory: inspection.directory,
      nodeExecutable: node,
      enabled,
      name: "REA — Reverse Engineer Anything (local source)",
      ...(agents.length ? { agents } : {}),
    })
    process.stdout.write(`Using local REA checkout: ${inspection.directory}\n`)
    process.stdout.write(`Using Node.js ${version} at ${node}\n`)
  }

  const normalized = normalizeManagedMcpServer(server)
  const store = await loadMcpStore()
  store.servers[normalized.id] = normalized
  await saveMcpStore(store)
  process.stdout.write([
    `Saved MCP server ${normalized.id} (${normalized.enabled ? "enabled" : "disabled"})`,
    `Agents: ${normalized.agents.join(", ")}`,
    normalized.type === "local" ? `Command: ${normalized.command.join(" ")}` : "",
    "Boom wraps REA in its bridge, so agents see rea_tools / rea_call.",
    "Next: boom mcp test rea",
    "",
  ].filter(Boolean).join("\n"))
}

await main(process.argv.slice(2))
