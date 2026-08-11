import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { discoverChallenges, loadAnswers } from "../src/challenge.ts"
import { importCTFTiny } from "../src/ctftiny-dataset.ts"
import { CTFTINY_FINGERPRINTS } from "../src/ctftiny-fingerprints.ts"

async function fixture(root: string) {
  await mkdir(path.join(root, "ctftiny", "cry", "sample"), { recursive: true })
  await writeFile(path.join(root, "LICENSE"), "GPL-2.0 fixture\n")
  await writeFile(
    path.join(root, "README.md"),
    "| Category | Event | Name | Difficulty |\n|---|---|---|---|\n| cry | 2023q | sample | Easy |\n",
  )
  const index: Record<string, unknown> = {}
  for (let indexValue = 0; indexValue < 50; indexValue += 1) {
    const slug = indexValue === 0 ? "cry-sample" : `cry-sample-${indexValue}`
    const name = indexValue === 0 ? "sample" : `sample${indexValue}`
    const directory = path.join(root, "ctftiny", "cry", name)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "handout.txt"), `evidence-${indexValue}`)
    await writeFile(path.join(directory, "solver.py"), `print('flag{answer-${indexValue}}')`)
    await writeFile(
      path.join(directory, "challenge.json"),
      `${JSON.stringify({
        name,
        category: "crypto",
        description: `Recover sample ${indexValue}`,
        flag: `flag{answer-${indexValue}}`,
        files: ["handout.txt"],
        ...(indexValue === 0 ? { type: "dynamic" } : {}),
      })}\n`,
    )
    index[slug] = {
      year: "2023",
      event: "CSAW-Quals",
      category: "crypto",
      challenge: name,
      path: `ctftiny/cry/${name}`,
    }
  }
  await writeFile(path.join(root, "ctftiny.json"), `${JSON.stringify(index)}\n`)
  const table = Object.values(index).map((value) => {
    const entry = value as { challenge: string }
    return `| cry | 2023q | ${entry.challenge} | Easy |`
  })
  await writeFile(
    path.join(root, "README.md"),
    `| Category | Event | Name | Difficulty |\n|---|---|---|---|\n${table.join("\n")}\n`,
  )
}

describe("CTFTiny importer", () => {
  test("defines a fully renamed profile for every pinned challenge", () => {
    expect(Object.keys(CTFTINY_FINGERPRINTS)).toHaveLength(50)
    for (const [slug, profile] of Object.entries(CTFTINY_FINGERPRINTS)) {
      expect(profile.description).not.toMatch(/CTFTiny|osirislab|CSAW-(?:Quals|Finals)/i)
      for (const [source, destination] of Object.entries(profile.files)) {
        if (destination === source) throw new Error(`${slug}: attachment path was not neutralized: ${source}`)
      }
    }
  })

  test("neutralizes challenge fingerprints while keeping answers and provenance host-side", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-ctftiny-"))
    const source = path.join(root, "source")
    const output = path.join(root, "output")
    try {
      await fixture(source)
      const summary = await importCTFTiny(source, output, "fixture")
      expect(summary).toMatchObject({ challenges: 50, offline: 50, serviceDependent: 0 })

      const sourceMap = JSON.parse(await readFile(path.join(output, "eval", "source-map.json"), "utf8")) as Record<
        string,
        { upstream_id: string; files: Record<string, string> }
      >
      const publicSlug = Object.entries(sourceMap).find(([, value]) => value.upstream_id === "cry-sample")?.[0]
      expect(publicSlug).toMatch(/^task-[a-f0-9]{10}$/)
      expect(sourceMap[publicSlug!]?.files).toEqual({ "artifact-01.txt": "handout.txt" })

      const challengeRoot = path.join(output, "challenges", "CRYPTO", publicSlug!)
      expect(await Bun.file(path.join(challengeRoot, "files", "artifact-01.txt")).text()).toBe("evidence-0")
      expect(await Bun.file(path.join(output, "challenges", "CRYPTO", "cry-sample")).exists()).toBe(false)
      expect(await Bun.file(path.join(challengeRoot, "solver.py")).exists()).toBe(false)
      expect(await Bun.file(path.join(challengeRoot, "files", "solver.py")).exists()).toBe(false)
      expect(await readFile(path.join(challengeRoot, "README.md"), "utf8")).not.toMatch(/sample|CTFTiny|CSAW/i)
      expect(await readFile(path.join(challengeRoot, "meta.json"), "utf8")).not.toMatch(/sample|CTFTiny|CSAW|upstream/i)

      const challenges = await discoverChallenges(output)
      expect(challenges).toHaveLength(50)
      const challenge = challenges.find((value) => value.slug === publicSlug)
      expect(challenge).toMatchObject({ slug: publicSlug, category: "CRYPTO", difficulty: "Easy" })
      expect(challenge?.files).toEqual(["artifact-01.txt"])
      expect((await loadAnswers(output)).get(publicSlug!)).toBe("flag{answer-0}")
      expect(await readFile(path.join(output, "LICENSE.CTFTINY"), "utf8")).toBe("GPL-2.0 fixture\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
