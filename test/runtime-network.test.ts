import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createBoomNetworkBroker,
  isPrivateNetworkAddress,
  type NetworkTransportInput,
} from "../src/runtime/network-broker.ts"
import { loadBoomToolRegistry } from "../src/runtime/tool-registry.ts"
import { createBoomToolHost } from "../src/tool-runtime.ts"

const RESOURCE_ROOT = path.join(import.meta.dir, "..", "resources")
const temporary: string[] = []

afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-network-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "work", ".boom"), { recursive: true })
  return directory
}

const publicResolver = async (_hostname: string) => [{ address: "93.184.216.34", family: 4 as const }]

describe("M3 Network Broker", () => {
  test("classifies private, metadata, loopback, and public destinations", () => {
    for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::", "::1", "fd00::1", "fe80::1"])
      expect(isPrivateNetworkAddress(address)).toBe(true)
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
      expect(isPrivateNetworkAddress(address)).toBe(false)
  })

  test("pins every redirect to a validated public address and writes a redacted audit", async () => {
    const directory = await workspace()
    const resolved: string[] = []
    const transported: NetworkTransportInput[] = []
    const broker = createBoomNetworkBroker({
      resolver: async (hostname) => {
        resolved.push(hostname)
        return publicResolver(hostname)
      },
      transport: async (input) => {
        transported.push(input)
        if (input.url.hostname === "start.example") return {
          status: 302,
          headers: { location: "https://next.example/final?token=private-value" } as Record<string, string>,
          body: Buffer.alloc(0),
        }
        return {
          status: 200,
          headers: { "content-type": "text/plain" } as Record<string, string>,
          body: Buffer.from("public result"),
        }
      },
    })
    const response = await broker.fetch({
      directory,
      sessionID: "network-session",
      url: "https://start.example/path?api_key=initial-secret",
    })
    expect(response.body.toString()).toBe("public result")
    expect(response.redirects).toBe(1)
    expect(resolved).toEqual(["start.example", "next.example"])
    expect(transported.map((item) => item.address)).toEqual(["93.184.216.34", "93.184.216.34"])
    const audit = await readFile(path.join(directory, "work", ".boom", "network-events.jsonl"), "utf8")
    expect(audit).toContain("%5Bredacted%5D")
    expect(audit).not.toContain("private-value")
    expect(audit).not.toContain("initial-secret")
  })

  test("returns HTTP error responses as auditable probe observations", async () => {
    const directory = await workspace()
    const broker = createBoomNetworkBroker({
      resolver: publicResolver,
      transport: async () => ({
        status: 404,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("not found"),
      }),
    })
    const response = await broker.fetch({ directory, sessionID: "probe", url: "https://target.example/missing" })
    expect(response.status).toBe(404)
    expect(response.body.toString()).toBe("not found")
    const audit = await readFile(path.join(directory, "work", ".boom", "network-events.jsonl"), "utf8")
    expect(audit).toContain('"status":404')
    expect(audit).not.toContain('"type":"network.error"')
  })

  test("uses the pinned transport against a real task-local HTTP listener", async () => {
    const directory = await workspace()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("loopback ctf target", { headers: { "content-type": "text/plain" } }),
    })
    try {
      const response = await createBoomNetworkBroker().fetch({
        directory,
        sessionID: "loopback-network",
        url: `http://127.0.0.1:${server.port}/challenge`,
      })
      expect(response.status).toBe(200)
      expect(response.body.toString()).toBe("loopback ctf target")
      const origin = `http://127.0.0.1:${server.port}`
      await expect(createBoomNetworkBroker({ deniedOrigins: new Set([origin]) }).fetch({
        directory,
        sessionID: "blocked-control-plane",
        url: `${origin}/internal-runtime`,
      })).rejects.toThrow("Boom control-plane origin")
    } finally {
      server.stop(true)
    }
  })

  test("keeps CTF destinations open by default and supports an explicit strict private-network profile", async () => {
    const directory = await workspace()
    let calls = 0
    const openBroker = createBoomNetworkBroker({
      resolver: async () => [{ address: "169.254.169.254", family: 4 }],
      transport: async () => {
        calls += 1
        return { status: 200, headers: {}, body: Buffer.from("ctf private target") }
      },
    })
    expect((await openBroker.fetch({ directory, url: "http://private-target.example/challenge" })).body.toString())
      .toBe("ctf private target")
    expect(calls).toBe(1)

    const strictBroker = createBoomNetworkBroker({
      privateNetwork: "deny",
      resolver: async () => [{ address: "169.254.169.254", family: 4 }],
      transport: async () => {
        calls += 1
        return { status: 200, headers: {}, body: Buffer.from("denied") }
      },
    })
    await expect(strictBroker.fetch({ directory, url: "http://metadata.example/latest" }))
      .rejects.toThrow("non-public destination")
    expect(calls).toBe(1)
    await expect(openBroker.fetch({ directory, url: "https://user:password@example.com/" }))
      .rejects.toThrow("must not contain credentials")

    const oversized = createBoomNetworkBroker({
      resolver: publicResolver,
      transport: async () => ({ status: 200, headers: {}, body: Buffer.alloc(2_000) }),
    })
    await expect(oversized.fetch({ directory, url: "https://example.com/", maximumBytes: 1_024 }))
      .rejects.toThrow("exceeds 1024 bytes")

    const host = createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT), { networkBroker: openBroker })
    await expect(host.execute({
      name: "webfetch",
      arguments: { url: "https://example.com/" },
      directory,
      profileID: "verifier",
    })).rejects.toThrow("Boom policy denied webfetch")
  })
})

describe("M3 native Web tools", () => {
  test("keeps out-of-range numeric entities harmless instead of disabling webfetch", async () => {
    const directory = await workspace()
    const broker = createBoomNetworkBroker({
      resolver: publicResolver,
      transport: async () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" } as Record<string, string>,
        body: Buffer.from(
          "<html><body><p>&#x110000;</p><p>&#xD800;</p><p>flag&#65;&#x42;&amp;done</p></body></html>",
        ),
      }),
    })
    const host = createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT), { networkBroker: broker })
    const fetched = await host.execute({
      name: "webfetch",
      arguments: { url: "https://example.com/", format: "text" },
      directory,
      profileID: "solver",
      sessionID: "web-tools-entities",
    })
    // Entities naming no Unicode scalar value stay verbatim instead of throwing a RangeError.
    expect(fetched.output).toContain("&#x110000;")
    expect(fetched.output).toContain("&#xD800;")
    // In-range entities keep decoding normally.
    expect(fetched.output).toContain("flagAB&done")
  })

  test("formats brokered HTML and delegates bounded search through the configured provider", async () => {
    const directory = await workspace()
    const broker = createBoomNetworkBroker({
      resolver: publicResolver,
      transport: async () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from("<html><body><h1>Boom</h1><script>secret()</script><a href=\"https://example.com/evidence\">Evidence</a></body></html>"),
      }),
      searchProvider: async (request) => ({
        provider: "scripted-search",
        output: `result for ${request.query} (${request.numResults})`,
      }),
    })
    const host = createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT), { networkBroker: broker })
    const fetched = await host.execute({
      name: "webfetch",
      arguments: { url: "https://example.com/", format: "markdown" },
      directory,
      profileID: "solver",
      sessionID: "web-tools",
    })
    expect(fetched.output).toContain("Boom")
    expect(fetched.output).toContain("[Evidence](https://example.com/evidence)")
    expect(fetched.output).not.toContain("secret()")

    const searched = await host.execute({
      name: "websearch",
      arguments: { query: "Boom CTF", numResults: 3 },
      directory,
      profileID: "solver",
      sessionID: "web-tools",
    })
    expect(searched.title).toBe("scripted-search search: Boom CTF")
    expect(searched.output).toBe("result for Boom CTF (3)")
  })
})
