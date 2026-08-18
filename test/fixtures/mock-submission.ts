import type { Challenge } from "../../src/challenge.ts"
import type { Workspace } from "../../src/workspace.ts"

type Verdict = "accepted" | "rejected" | "pending"

type SubmissionInput = {
  root: string
  challenge: Challenge
  workspace: Workspace
  candidate: string
  signal?: AbortSignal
}

type SubmissionResult = {
  adapter: string
  verdict: Verdict
  detail: string
  submittedAt: string
}

/** Test-only verdict source for runner state-machine tests. */
export class MockSubmissionGateway {
  constructor(private readonly adapters: Array<{
    id: string
    submitFlag(input: SubmissionInput): Promise<SubmissionResult>
  }> = []) {}

  async submitFlagWithRetry(
    input: SubmissionInput,
    options: { attempts?: number; retryDelayMs?: number } = {},
  ): Promise<SubmissionResult> {
    const adapterID = input.challenge.platform?.adapter
    const adapter = this.adapters.find((item) => item.id === adapterID)
    if (!adapter) {
      return {
        adapter: "manual",
        verdict: "pending",
        detail: "No test submission gateway configured",
        submittedAt: new Date().toISOString(),
      }
    }
    const attempts = Math.max(1, options.attempts ?? 2)
    let last: SubmissionResult | undefined
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await adapter.submitFlag(input)
      if (last.verdict !== "pending" || attempt === attempts) return last
    }
    return last!
  }
}
