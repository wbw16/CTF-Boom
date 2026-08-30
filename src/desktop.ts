import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { NativeClientProcess } from "./gui-command.ts"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
const SOURCE = path.join(PACKAGE_ROOT, "resources", "desktop", "BoomApp.swift")
const ICON = path.join(PACKAGE_ROOT, "resources", "desktop", "Boom.icns")
const COMPILE_FLAGS = ["-O", "-swift-version", "5", "-framework", "AppKit", "-framework", "WebKit"]

export type NativeClientCacheInput = {
  source: string
  icon: Uint8Array
  compilerVersion: string
  architecture: string
  flags: string[]
  boomVersion: string
}

export function nativeClientOpenCommand(app: string, url: string) {
  return ["open", "-n", "-W", app, "--args", url]
}

export function nativeClientCacheKey(input: NativeClientCacheInput) {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        source: input.source,
        icon: Array.from(input.icon),
        compilerVersion: input.compilerVersion,
        architecture: input.architecture,
        flags: input.flags,
        boomVersion: input.boomVersion,
      }),
    )
    .digest("hex")
}

function boomHome() {
  return path.resolve(process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"))
}

/** Hard ceiling for one compiler/tool invocation so an ignored SIGTERM cannot hang startup. */
const RUN_TIMEOUT_MS = 120_000
const RUN_KILL_GRACE_MS = 3_000

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let escalate: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    child.kill()
    escalate = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // Already exited between the two signals.
      }
    }, RUN_KILL_GRACE_MS)
  }, RUN_TIMEOUT_MS)
  let code: number | undefined
  let stdout = ""
  let stderr = ""
  try {
    ;[code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
  } finally {
    clearTimeout(timer)
    if (escalate !== undefined) clearTimeout(escalate)
  }
  if (code !== 0)
    throw new Error(
      `Failed to build the Boom desktop client (${command[0]} exited ${code}): ` +
        (stderr.trim() || stdout.trim() || "unknown compiler error"),
    )
  return stdout.trim()
}

function xml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character]!
  })
}

function infoPlist(version: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Boom</string>
  <key>CFBundleExecutable</key><string>Boom</string>
  <key>CFBundleIdentifier</key><string>com.boom.ctf</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleIconFile</key><string>Boom.icns</string>
  <key>CFBundleName</key><string>Boom</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xml(version)}</string>
  <key>CFBundleVersion</key><string>${xml(version)}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
}

async function packageVersion() {
  const value = (await Bun.file(path.join(PACKAGE_ROOT, "package.json")).json()) as { version: string }
  return value.version
}

export async function ensureDesktopClient() {
  if (process.platform !== "darwin")
    throw new Error("The Boom native client currently requires macOS; use --browser or --headless")
  const source = await readFile(SOURCE, "utf8").catch(() => {
    throw new Error("Boom installation is missing resources/desktop/BoomApp.swift")
  })
  const icon = await readFile(ICON).catch(() => {
    throw new Error("Boom installation is missing resources/desktop/Boom.icns")
  })
  const compilerVersion = await run(["xcrun", "swiftc", "--version"])
  const version = await packageVersion()
  const key = nativeClientCacheKey({
    source,
    icon,
    compilerVersion,
    architecture: process.arch,
    flags: COMPILE_FLAGS,
    boomVersion: version,
  })
  const directory = path.join(boomHome(), "native-client", key)
  const app = path.join(directory, "Boom.app")
  const contents = path.join(app, "Contents")
  const executable = path.join(contents, "MacOS", "Boom")
  const plist = path.join(contents, "Info.plist")
  const resources = path.join(contents, "Resources")
  const bundledIcon = path.join(resources, "Boom.icns")
  const ready = path.join(directory, "ready")
  const [readyValue, executableInfo, plistInfo, iconInfo] = await Promise.all([
    readFile(ready, "utf8").catch(() => ""),
    stat(executable).catch(() => undefined),
    stat(plist).catch(() => undefined),
    stat(bundledIcon).catch(() => undefined),
  ])
  if (
    readyValue.trim() === key &&
    executableInfo?.isFile() &&
    executableInfo.size > 0 &&
    (executableInfo.mode & 0o111) !== 0 &&
    plistInfo?.isFile() &&
    iconInfo?.isFile() &&
    iconInfo.size > 0
  )
    return { app, executable, key }

  await mkdir(path.dirname(executable), { recursive: true })
  await mkdir(resources, { recursive: true })
  const suffix = `${process.pid}.${crypto.randomUUID()}`
  const temporaryExecutable = path.join(directory, `Boom.${suffix}.tmp`)
  const temporaryPlist = path.join(directory, `Info.${suffix}.tmp`)
  const temporaryReady = path.join(directory, `ready.${suffix}.tmp`)
  const temporaryIcon = path.join(resources, `Boom.${suffix}.icns.tmp`)
  try {
    await run(["xcrun", "swiftc", ...COMPILE_FLAGS, SOURCE, "-o", temporaryExecutable])
    await chmod(temporaryExecutable, 0o755)
    await writeFile(temporaryPlist, infoPlist(version), "utf8")
    await writeFile(temporaryIcon, icon)
    await rename(temporaryExecutable, executable)
    await rename(temporaryPlist, plist)
    await rename(temporaryIcon, bundledIcon)
    await writeFile(temporaryReady, `${key}\n`, "utf8")
    await rename(temporaryReady, ready)
  } finally {
    await Promise.all([
      rm(temporaryExecutable, { force: true }),
      rm(temporaryPlist, { force: true }),
      rm(temporaryReady, { force: true }),
      rm(temporaryIcon, { force: true }),
    ])
  }
  return { app, executable, key }
}

export async function launchDesktopClient(url: string): Promise<NativeClientProcess> {
  const target = new URL(url)
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw new Error(`Boom desktop client only accepts a loopback HTTP URL, got: ${url}`)
  const built = await ensureDesktopClient()
  const child = Bun.spawn(nativeClientOpenCommand(built.app, target.toString()), {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  let ended = false
  const exited = child.exited.then((code) => {
    ended = true
    return code
  })
  return {
    exited,
    terminate() {
      if (!ended) {
        child.kill()
        Bun.spawn(["osascript", "-e", 'tell application id "com.boom.ctf" to quit'], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        })
      }
    },
  }
}
