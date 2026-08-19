/**
 * Public Relay protocol.  The relay deliberately owns only durable delivery state; the Boom
 * runner and the competition adapter remain on workers and the master connector respectively.
 */

export const RELAY_API_PREFIX = "/v1"
export const DEFAULT_LEASE_MS = 10 * 60_000
export const DEFAULT_MAX_SLOTS = 5
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024
export const MAX_JSON_BYTES = 1 * 1024 * 1024
export const MAX_FLAG_LENGTH = 4_096

export type DeviceRole = "worker" | "master-worker"
export type ChallengeKind = "offline" | "remote"
export type ChallengePhase = "offline" | "online"
export type ChallengeStatus =
  | "queued_offline"
  | "assigned_offline"
  | "ready_online"
  | "queued_online"
  | "assigned_online"
  | "solved"
export type AssignmentPhase = ChallengePhase | "writeup"
export type AssignmentStatus = "active" | "finished" | "expired" | "superseded"
export type FlagStatus = "pending" | "accepted" | "rejected"
export type WriteupStatus = "none" | "pending" | "done"

export type Device = {
  id: string
  role: DeviceRole
  name: string
  maxSlots: number
  lastSeenAt: string
  createdAt: string
}

export type ChallengeSnapshot = {
  id: string
  slug: string
  category?: string
  kind: ChallengeKind
  revision: number
  status: ChallengeStatus
  bundleSha256: string
  remoteUrl?: string
  remoteExpiresAt?: string
  resultBundleSha256?: string
  /** Exposed only to trusted Relay devices after the master has accepted the flag, for writeup recovery. */
  acceptedFlag?: string
  writeupStatus: WriteupStatus
  writeupTargetDevice?: string
  createdAt: string
  updatedAt: string
}

export type Assignment = {
  id: string
  challengeId: string
  deviceId: string
  revision: number
  phase: AssignmentPhase
  status: AssignmentStatus
  leaseUntil?: string
  createdAt: string
  finishedAt?: string
  challenge: ChallengeSnapshot
}

export type Flag = {
  id: string
  challengeId: string
  assignmentId: string
  deviceId: string
  value: string
  status: FlagStatus
  detail?: string
  createdAt: string
}

export type RegisterDeviceRequest = {
  /** Generated once per Boom installation and retained in its local Relay state. */
  id: string
  name: string
  role: DeviceRole
  maxSlots?: number
}

export type PublishChallengeRequest = {
  id?: string
  slug: string
  category?: string
  kind: ChallengeKind
  phase: ChallengePhase
  revision: number
  bundleSha256: string
  remoteUrl?: string
  remoteExpiresAt?: number
}

export type WorkerPollRequest = {
  freeSlots: number
  /** Locally recovered assignments. They are returned as stop entries when their lease is gone. */
  activeAssignmentIds?: string[]
}

export type WorkerPollResponse = {
  device: Device
  assignments: Assignment[]
  stopAssignments: Array<{ id: string; reason: string }>
  rejectedFlags: Flag[]
}

export type UploadResultRequest = {
  assignmentId: string
  /** Omit this for an abandoned offline attempt, which puts the task back into the queue. */
  bundleSha256?: string
}

export type SubmitFlagRequest = {
  id: string
  assignmentId: string
  value: string
}

export type SubmitWriteupRequest = {
  assignmentId: string
  bundleSha256: string
}

export type MasterState = {
  pendingFlags: Flag[]
  /** Challenge snapshots for every pending flag, including queued/assigned offline tasks the connector must judge. */
  pendingFlagChallenges: ChallengeSnapshot[]
  readyOnline: ChallengeSnapshot[]
  /** Includes queued and assigned remote online phases so a restarted connector can recover URLs. */
  activeRemote: ChallengeSnapshot[]
  expiredAssignments: Assignment[]
  pendingWriteups: ChallengeSnapshot[]
}

export type UpdateFlagRequest = {
  status: FlagStatus
  detail?: string
}

export function isDeviceRole(value: unknown): value is DeviceRole {
  return value === "worker" || value === "master-worker"
}

export function isChallengeKind(value: unknown): value is ChallengeKind {
  return value === "offline" || value === "remote"
}

export function isChallengePhase(value: unknown): value is ChallengePhase {
  return value === "offline" || value === "online"
}

export function isFlagStatus(value: unknown): value is FlagStatus {
  return value === "pending" || value === "accepted" || value === "rejected"
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

/** IDs become database keys and URL segments, so constrain them before they reach either layer. */
export function isRelayId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)
}

export function asOptionalText(value: unknown, maximum: number) {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error("Expected text")
  const text = value.trim()
  if (!text || text.length > maximum || /[\0\r\n]/.test(text)) throw new Error("Invalid text")
  return text
}

export function asEpoch(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${field} must be an epoch millisecond timestamp`)
  return value
}

export function asPositiveInteger(value: unknown, field: string, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${field} must be an integer from 1 to ${maximum}`)
  return value
}

export function iso(value: number | null | undefined) {
  return value === null || value === undefined ? undefined : new Date(value).toISOString()
}
