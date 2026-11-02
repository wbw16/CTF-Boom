/** Product working-window ceiling, independent of the Provider's declared total capacity. */
export const BOOM_CONTEXT_LIMIT = 300_000
export const DEFAULT_MODEL_CONTEXT = 128_000
export const CONTEXT_RESERVE = 8_192

export function modelContext(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 2
    ? Math.floor(value) : DEFAULT_MODEL_CONTEXT
}

export function runtimeModelLimits(context: unknown, output: number, input?: number) {
  const capacity = modelContext(context)
  const working = Math.min(capacity, BOOM_CONTEXT_LIMIT)
  const reserve = Math.min(CONTEXT_RESERVE, Math.max(0, Math.floor(working / 10)))
  const requestedOutput = Number.isFinite(output) && output > 0 ? Math.floor(output) : 16_384
  const requestedInput = input !== undefined && Number.isFinite(input) && input > 0 ? Math.floor(input) : Infinity
  const maximumOutput = Math.min(Math.max(1, requestedOutput), working - reserve - 1)
  return {
    context: capacity,
    output: maximumOutput,
    input: Math.max(1, Math.min(requestedInput, working - maximumOutput - reserve)),
  }
}
