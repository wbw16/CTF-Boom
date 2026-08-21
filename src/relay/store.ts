import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import {
  DEFAULT_LEASE_MS,
  DEFAULT_DEVICE_SLOTS,
  MAX_DEVICE_SLOTS,
  iso,
  type Assignment,
  type AssignmentPhase,
  type AssignmentStatus,
  type ChallengeKind,
  type ChallengePhase,
  type ChallengeSnapshot,
  type ChallengeStatus,
  type Device,
  type DeviceRole,
  type Flag,
  type FlagStatus,
  type MasterState,
  type PublishChallengeRequest,
  type WriteupStatus,
} from "./protocol.ts"

type Row = Record<string, unknown>

type RawDevice = Row & {
  id: string
  role: DeviceRole
  name: string
  token_hash: string
  max_slots: number
  last_seen_at: number
  created_at: number
}

type RawChallenge = Row & {
  id: string
  slug: string
  category: string | null
  kind: ChallengeKind
  revision: number
  status: ChallengeStatus
  bundle_sha256: string
  remote_url: string | null
  remote_expire_at: number | null
  result_bundle_sha256: string | null
  writeup_status: WriteupStatus
  writeup_target_device: string | null
  created_at: number
  updated_at: number
}

type RawAssignment = Row & {
  id: string
  challenge_id: string
  device_id: string
  revision: number
  phase: AssignmentPhase
  status: AssignmentStatus
  lease_until: number | null
  created_at: number
  finished_at: number | null
}

type RawFlag = Row & {
  id: string
  challenge_id: string
  assignment_id: string
  device_id: string
  value: string
  status: FlagStatus
  detail: string | null
  created_at: number
}

export class RelayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "RelayError"
  }
}

function fail(status: number, message: string): never {
  throw new RelayError(status, message)
}

function deviceView(row: RawDevice): Device {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    maxSlots: row.max_slots,
    lastSeenAt: iso(row.last_seen_at)!,
    createdAt: iso(row.created_at)!,
  }
}

function challengeView(row: RawChallenge): ChallengeSnapshot {
  return {
    id: row.id,
    slug: row.slug,
    ...(row.category ? { category: row.category } : {}),
    kind: row.kind,
    revision: row.revision,
    status: row.status,
    bundleSha256: row.bundle_sha256,
    ...(row.remote_url ? { remoteUrl: row.remote_url } : {}),
    ...(row.remote_expire_at ? { remoteExpiresAt: iso(row.remote_expire_at) } : {}),
    ...(row.result_bundle_sha256 ? { resultBundleSha256: row.result_bundle_sha256 } : {}),
    writeupStatus: row.writeup_status,
    ...(row.writeup_target_device ? { writeupTargetDevice: row.writeup_target_device } : {}),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  }
}

function flagView(row: RawFlag): Flag {
  return {
    id: row.id,
    challengeId: row.challenge_id,
    assignmentId: row.assignment_id,
    deviceId: row.device_id,
    value: row.value,
    status: row.status,
    ...(row.detail ? { detail: row.detail } : {}),
    createdAt: iso(row.created_at)!,
  }
}

function queueStatus(phase: ChallengePhase): ChallengeStatus {
  return phase === "offline" ? "queued_offline" : "queued_online"
}

function assignedStatus(phase: ChallengePhase): ChallengeStatus {
  return phase === "offline" ? "assigned_offline" : "assigned_online"
}

function uniqueID() {
  return crypto.randomUUID()
}

function devicesTableDDL(name: string) {
  return `CREATE TABLE ${name} (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('worker', 'master-worker')),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    max_slots INTEGER NOT NULL CHECK (max_slots BETWEEN 1 AND ${MAX_DEVICE_SLOTS}),
    last_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`
}

function deviceSlotsUpperBound(sql: string) {
  const match = /max_slots\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*max_slots\s+BETWEEN\s+1\s+AND\s+(\d+)\s*\)/i.exec(sql)
  return match ? Number(match[1]) : undefined
}

/**
 * SQLite owns every state transition that can otherwise race between polling workers.  All methods
 * are synchronous internally so a BEGIN IMMEDIATE transaction cannot yield half an assignment.
 */
export class RelayStore {
  readonly #db: Database
  readonly #leaseMs: number
  readonly #now: () => number

  private constructor(database: Database, options: { leaseMs?: number; now?: () => number } = {}) {
    this.#db = database
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.#now = options.now ?? (() => Date.now())
    this.#db.exec("PRAGMA foreign_keys = ON")
    this.#db.exec("PRAGMA journal_mode = WAL")
    this.#db.exec("PRAGMA busy_timeout = 5000")
    this.#migrate()
  }

  static async open(
    dataDirectory: string,
    options: { leaseMs?: number; now?: () => number } = {},
  ) {
    const directory = path.resolve(dataDirectory)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return new RelayStore(new Database(path.join(directory, "relay.sqlite"), { create: true }), options)
  }

  close() {
    this.#db.close()
  }

  #migrate() {
    const existing = this.#get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'")
    if (existing) {
      if (deviceSlotsUpperBound(existing.sql) !== MAX_DEVICE_SLOTS) this.#rebuildDevicesTable()
    } else {
      this.#db.exec(devicesTableDDL("devices"))
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        category TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('offline', 'remote')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN (
          'queued_offline', 'assigned_offline', 'ready_online', 'queued_online', 'assigned_online', 'solved'
        )),
        bundle_sha256 TEXT NOT NULL,
        remote_url TEXT,
        remote_expire_at INTEGER,
        result_bundle_sha256 TEXT,
        writeup_status TEXT NOT NULL DEFAULT 'none' CHECK (writeup_status IN ('none', 'pending', 'done')),
        writeup_target_device TEXT REFERENCES devices(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES challenges(id),
        device_id TEXT NOT NULL REFERENCES devices(id),
        revision INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('offline', 'online', 'writeup')),
        status TEXT NOT NULL CHECK (status IN ('active', 'finished', 'expired', 'superseded')),
        lease_until INTEGER,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_assignment_per_challenge
        ON assignments(challenge_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS assignments_by_device
        ON assignments(device_id, status, lease_until);
      CREATE TABLE IF NOT EXISTS flags (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES challenges(id),
        assignment_id TEXT NOT NULL REFERENCES assignments(id),
        device_id TEXT NOT NULL REFERENCES devices(id),
        value TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
        detail TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(challenge_id, value)
      );
      CREATE INDEX IF NOT EXISTS pending_flags ON flags(status, created_at);
      CREATE TABLE IF NOT EXISTS results (
        assignment_id TEXT PRIMARY KEY REFERENCES assignments(id),
        result_bundle_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS writeups (
        challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id),
        assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(id),
        device_id TEXT NOT NULL REFERENCES devices(id),
        bundle_sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  }

  #rebuildDevicesTable() {
    this.#db.exec("PRAGMA foreign_keys = OFF")
    try {
      this.#db.exec(`
        BEGIN IMMEDIATE;
        ${devicesTableDDL("devices_next")};
        INSERT INTO devices_next (id, role, name, token_hash, max_slots, last_seen_at, created_at)
          SELECT id, role, name, token_hash, max_slots, last_seen_at, created_at FROM devices;
        DROP TABLE devices;
        ALTER TABLE devices_next RENAME TO devices;
        COMMIT;
      `)
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK")
      } catch {}
      throw error
    } finally {
      this.#db.exec("PRAGMA foreign_keys = ON")
    }
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE")
    try {
      const value = work()
      this.#db.exec("COMMIT")
      return value
    } catch (error) {
      this.#db.exec("ROLLBACK")
      throw error
    }
  }

  #get<T extends Row>(sql: string, ...values: SQLQueryBindings[]) {
    return this.#db.query(sql).get(...values) as T | null
  }

  #all<T extends Row>(sql: string, ...values: SQLQueryBindings[]) {
    return this.#db.query(sql).all(...values) as T[]
  }

  #run(sql: string, ...values: SQLQueryBindings[]) {
    return this.#db.query(sql).run(...values)
  }

  #deviceByID(id: string) {
    return this.#get<RawDevice>("SELECT * FROM devices WHERE id = ?", id)
  }

  #challengeByID(id: string) {
    return this.#get<RawChallenge>("SELECT * FROM challenges WHERE id = ?", id)
  }

  #assignmentByID(id: string) {
    return this.#get<RawAssignment>("SELECT * FROM assignments WHERE id = ?", id)
  }

  #challengeSnapshot(row: RawChallenge) {
    const accepted = row.status === "solved"
      ? this.#get<RawFlag>("SELECT * FROM flags WHERE challenge_id = ? AND status = 'accepted' LIMIT 1", row.id)
      : undefined
    return {
      ...challengeView(row),
      ...(accepted ? { acceptedFlag: accepted.value } : {}),
    }
  }

  #assignmentView(row: RawAssignment): Assignment {
    const challenge = this.#challengeByID(row.challenge_id)
    if (!challenge) throw new Error(`Assignment ${row.id} has no challenge`)
    return {
      id: row.id,
      challengeId: row.challenge_id,
      deviceId: row.device_id,
      revision: row.revision,
      phase: row.phase,
      status: row.status,
      ...(row.lease_until ? { leaseUntil: iso(row.lease_until) } : {}),
      createdAt: iso(row.created_at)!,
      ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
      challenge: this.#challengeSnapshot(challenge),
    }
  }

  #createAssignment(input: {
    challenge: RawChallenge
    deviceID: string
    phase: AssignmentPhase
    now: number
  }) {
    const assignment: RawAssignment = {
      id: uniqueID(),
      challenge_id: input.challenge.id,
      device_id: input.deviceID,
      revision: input.challenge.revision,
      phase: input.phase,
      status: "active",
      lease_until: input.now + this.#leaseMs,
      created_at: input.now,
      finished_at: null,
    }
    this.#run(
      `INSERT INTO assignments (
        id, challenge_id, device_id, revision, phase, status, lease_until, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
      assignment.id,
      assignment.challenge_id,
      assignment.device_id,
      assignment.revision,
      assignment.phase,
      assignment.lease_until,
      assignment.created_at,
    )
    return assignment
  }

  #bestMasterWorker() {
    return this.#get<RawDevice>(
      "SELECT * FROM devices WHERE role = 'master-worker' ORDER BY last_seen_at DESC, created_at ASC LIMIT 1",
    )
  }

  /** Requeue solve work and give writeup retries to a master worker without trusting clock-skewed clients. */
  #expireLeases(now: number) {
    const expired = this.#all<RawAssignment>(
      "SELECT * FROM assignments WHERE status = 'active' AND lease_until <= ? ORDER BY lease_until ASC",
      now,
    )
    for (const assignment of expired) {
      const challenge = this.#challengeByID(assignment.challenge_id)
      if (!challenge) continue
      this.#run(
        "UPDATE assignments SET status = 'expired', finished_at = ?, lease_until = NULL WHERE id = ? AND status = 'active'",
        now,
        assignment.id,
      )
      if (assignment.phase === "writeup") {
        const master = this.#bestMasterWorker()
        this.#run(
          "UPDATE challenges SET writeup_target_device = ?, updated_at = ? WHERE id = ? AND writeup_status = 'pending'",
          master?.id ?? null,
          now,
          challenge.id,
        )
        continue
      }
      if (challenge.status === assignedStatus(assignment.phase) && challenge.revision === assignment.revision) {
        this.#run(
          "UPDATE challenges SET status = ?, updated_at = ? WHERE id = ?",
          queueStatus(assignment.phase),
          now,
          challenge.id,
        )
      }
    }

    // A target can disappear before it has polled to receive the writeup assignment at all. Treat
    // the post-acceptance lease window as its delivery deadline, then let a master worker recover it.
    const undispatchedWriteups = this.#all<RawChallenge>(
      `SELECT * FROM challenges c
       WHERE c.status = 'solved' AND c.writeup_status = 'pending' AND c.writeup_target_device IS NOT NULL
       AND c.updated_at <= ?
       AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.challenge_id = c.id AND a.status = 'active')`,
      now - this.#leaseMs,
    )
    const master = this.#bestMasterWorker()
    for (const challenge of undispatchedWriteups) {
      this.#run(
        "UPDATE challenges SET writeup_target_device = ?, updated_at = ? WHERE id = ?",
        master?.id ?? null,
        now,
        challenge.id,
      )
    }
  }

  /** Writeups use ordinary worker capacity and are created only when the target polls with a free slot. */
  #assignPendingWriteups(device: RawDevice, now: number, limit: number) {
    if (limit === 0) return 0
    const challenges = this.#all<RawChallenge>(
      `SELECT c.* FROM challenges c
       WHERE c.status = 'solved' AND c.writeup_status = 'pending'
       AND (c.writeup_target_device = ? OR (? = 'master-worker' AND c.writeup_target_device IS NULL))
       AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.challenge_id = c.id AND a.status = 'active')
       ORDER BY c.updated_at ASC LIMIT ?`,
      device.id,
      device.role,
      limit,
    )
    for (const challenge of challenges) {
      this.#createAssignment({ challenge, deviceID: device.id, phase: "writeup", now })
      if (!challenge.writeup_target_device)
        this.#run("UPDATE challenges SET writeup_target_device = ?, updated_at = ? WHERE id = ?", device.id, now, challenge.id)
    }
    return challenges.length
  }

  registerDevice(input: { id: string; name: string; role: DeviceRole; maxSlots?: number; tokenHash: string }) {
    const now = this.#now()
    const maxSlots = input.maxSlots ?? DEFAULT_DEVICE_SLOTS
    return this.#transaction(() => {
      const existing = this.#deviceByID(input.id)
      if (existing) {
        this.#run(
          `UPDATE devices SET role = ?, name = ?, token_hash = ?, max_slots = ?, last_seen_at = ?
           WHERE id = ?`,
          input.role,
          input.name,
          input.tokenHash,
          maxSlots,
          now,
          existing.id,
        )
        return {
          device: deviceView({
            ...existing,
            role: input.role,
            name: input.name,
            token_hash: input.tokenHash,
            max_slots: maxSlots,
            last_seen_at: now,
          }),
          created: false,
        }
      }
      const row: RawDevice = {
        id: input.id,
        role: input.role,
        name: input.name,
        token_hash: input.tokenHash,
        max_slots: maxSlots,
        last_seen_at: now,
        created_at: now,
      }
      this.#run(
        "INSERT INTO devices (id, role, name, token_hash, max_slots, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        row.id,
        row.role,
        row.name,
        row.token_hash,
        row.max_slots,
        row.last_seen_at,
        row.created_at,
      )
      return { device: deviceView(row), created: true }
    })
  }

  authenticateDevice(tokenHash: string) {
    const device = this.#get<RawDevice>("SELECT * FROM devices WHERE token_hash = ?", tokenHash)
    return device ? deviceView(device) : undefined
  }

  publishChallenge(id: string, input: PublishChallengeRequest) {
    const now = this.#now()
    return this.#transaction(() => {
      const existing = this.#challengeByID(id)
      if (!existing) {
        if (input.phase !== "offline") fail(409, "A challenge must be published offline before its online phase")
        const challenge: RawChallenge = {
          id,
          slug: input.slug,
          category: input.category ?? null,
          kind: input.kind,
          revision: input.revision,
          status: "queued_offline",
          bundle_sha256: input.bundleSha256,
          remote_url: null,
          remote_expire_at: null,
          result_bundle_sha256: null,
          writeup_status: "none",
          writeup_target_device: null,
          created_at: now,
          updated_at: now,
        }
        this.#run(
          `INSERT INTO challenges (
            id, slug, category, kind, revision, status, bundle_sha256, remote_url, remote_expire_at,
            result_bundle_sha256, writeup_status, writeup_target_device, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'none', NULL, ?, ?)`,
          challenge.id,
          challenge.slug,
          challenge.category,
          challenge.kind,
          challenge.revision,
          challenge.status,
          challenge.bundle_sha256,
          challenge.created_at,
          challenge.updated_at,
        )
        return this.#challengeSnapshot(challenge)
      }

      if (existing.kind !== input.kind) fail(409, "Challenge kind cannot change")
      if (input.revision < existing.revision) fail(409, "Challenge revision is older than Relay state")
      if (existing.status === "solved") return this.#challengeSnapshot(existing)

      if (input.phase === "offline") {
        if (input.revision === existing.revision) {
          if (
            existing.slug === input.slug &&
            existing.category === (input.category ?? null) &&
            existing.bundle_sha256 === input.bundleSha256
          ) return this.#challengeSnapshot(existing)
          fail(409, "A challenge revision cannot be republished with different offline content")
        }
        this.#run(
          `UPDATE assignments SET status = 'superseded', finished_at = ?, lease_until = NULL
           WHERE challenge_id = ? AND status = 'active'`,
          now,
          id,
        )
        this.#run(
          `UPDATE challenges SET slug = ?, category = ?, revision = ?, status = 'queued_offline',
             bundle_sha256 = ?, remote_url = NULL, remote_expire_at = NULL, result_bundle_sha256 = NULL,
             writeup_status = 'none', writeup_target_device = NULL, updated_at = ? WHERE id = ?`,
          input.slug,
          input.category ?? null,
          input.revision,
          input.bundleSha256,
          now,
          id,
        )
        return this.#challengeSnapshot(this.#challengeByID(id)!)
      }

      if (input.kind !== "remote") fail(409, "Only remote challenges have an online phase")
      if (!input.remoteUrl || !input.remoteExpiresAt) fail(400, "Online publication requires remoteUrl and remoteExpiresAt")
      if (existing.status !== "ready_online" && existing.status !== "queued_online" && existing.status !== "assigned_online")
        fail(409, "The remote offline phase has not produced a result bundle")
      if (input.revision === existing.revision) {
        if (
          existing.slug === input.slug &&
          existing.category === (input.category ?? null) &&
          existing.bundle_sha256 === input.bundleSha256 &&
          existing.remote_url === input.remoteUrl &&
          existing.remote_expire_at === input.remoteExpiresAt
        ) return this.#challengeSnapshot(existing)
        fail(409, "A challenge revision cannot be republished with different online content")
      }

      this.#run(
        `UPDATE assignments SET status = 'superseded', finished_at = ?, lease_until = NULL
         WHERE challenge_id = ? AND phase = 'online' AND status = 'active'`,
        now,
        id,
      )
      this.#run(
        `UPDATE challenges SET slug = ?, category = ?, revision = ?, status = 'queued_online', bundle_sha256 = ?,
           remote_url = ?, remote_expire_at = ?, updated_at = ? WHERE id = ?`,
        input.slug,
        input.category ?? null,
        input.revision,
        input.bundleSha256,
        input.remoteUrl,
        input.remoteExpiresAt,
        now,
        id,
      )
      return this.#challengeSnapshot(this.#challengeByID(id)!)
    })
  }

  poll(deviceID: string, freeSlots: number, locallyActive: readonly string[]) {
    const now = this.#now()
    return this.#transaction(() => {
      this.#expireLeases(now)
      const device = this.#deviceByID(deviceID)
      if (!device) fail(401, "Unknown device")
      this.#run("UPDATE devices SET last_seen_at = ? WHERE id = ?", now, device.id)
      device.last_seen_at = now
      let active = this.#all<RawAssignment>(
        "SELECT * FROM assignments WHERE device_id = ? AND status = 'active' ORDER BY created_at ASC",
        device.id,
      )
      let capacity = Math.max(0, Math.min(freeSlots, device.max_slots - active.length))
      capacity -= this.#assignPendingWriteups(device, now, capacity)
      active = this.#all<RawAssignment>(
        "SELECT * FROM assignments WHERE device_id = ? AND status = 'active' ORDER BY created_at ASC",
        device.id,
      )
      this.#run(
        "UPDATE assignments SET lease_until = ? WHERE device_id = ? AND status = 'active'",
        now + this.#leaseMs,
        device.id,
      )
      const phaseOrder: ChallengePhase[] = device.role === "master-worker" ? ["online", "offline"] : ["offline"]
      let remaining = capacity
      for (const phase of phaseOrder) {
        if (remaining === 0) break
        const candidates = this.#all<RawChallenge>(
          "SELECT * FROM challenges WHERE status = ? ORDER BY created_at ASC, id ASC LIMIT ?",
          queueStatus(phase),
          remaining,
        )
        for (const challenge of candidates) {
          // The partial unique index is the final guard if a second request reaches this point.
          this.#createAssignment({ challenge, deviceID: device.id, phase, now })
          this.#run("UPDATE challenges SET status = ?, updated_at = ? WHERE id = ?", assignedStatus(phase), now, challenge.id)
          remaining -= 1
        }
      }
      active = this.#all<RawAssignment>(
        "SELECT * FROM assignments WHERE device_id = ? AND status = 'active' ORDER BY created_at ASC",
        device.id,
      )
      const activeIDs = new Set(active.map((assignment) => assignment.id))
      const stopAssignments: Array<{ id: string; reason: string }> = []
      for (const id of locallyActive) {
        if (activeIDs.has(id)) continue
        const prior = this.#assignmentByID(id)
        if (prior?.device_id === device.id) stopAssignments.push({ id, reason: prior.status })
      }
      const rejected = this.#all<RawFlag>(
        "SELECT * FROM flags WHERE device_id = ? AND status = 'rejected' ORDER BY created_at ASC LIMIT 200",
        device.id,
      )
      return {
        device: deviceView(device),
        assignments: active.map((assignment) => this.#assignmentView(assignment)),
        stopAssignments,
        rejectedFlags: rejected.map(flagView),
      }
    })
  }

  submitResult(deviceID: string, input: { assignmentID: string; bundleSha256?: string }) {
    const now = this.#now()
    return this.#transaction(() => {
      const assignment = this.#assignmentByID(input.assignmentID)
      if (!assignment || assignment.device_id !== deviceID) fail(404, "Assignment not found")
      if (assignment.phase === "writeup") fail(409, "Writeup assignments cannot upload a result")
      const challenge = this.#challengeByID(assignment.challenge_id)
      if (!challenge) fail(404, "Challenge not found")
      if (challenge.kind !== "remote" && input.bundleSha256 === undefined) {
        if (assignment.status !== "active") fail(409, "Assignment is no longer active")
        if (challenge.status !== "assigned_offline" || challenge.revision !== assignment.revision)
          fail(409, "Assignment was superseded")
        this.#run(
          "UPDATE assignments SET status = 'finished', finished_at = ?, lease_until = NULL WHERE id = ?",
          now,
          assignment.id,
        )
        this.#run("UPDATE challenges SET status = 'queued_offline', updated_at = ? WHERE id = ?", now, challenge.id)
        return { challenge: this.#challengeSnapshot(this.#challengeByID(challenge.id)!), idempotent: false }
      }
      if ((assignment.phase !== "offline" || challenge.kind !== "remote") && input.bundleSha256)
        fail(409, "Only remote offline assignments can upload a result bundle")
      const existing = this.#get<Row & { result_bundle_sha256: string }>(
        "SELECT result_bundle_sha256 FROM results WHERE assignment_id = ?",
        assignment.id,
      )
      if (existing) {
        if ((input.bundleSha256 ?? "") === existing.result_bundle_sha256)
          return { challenge: this.#challengeSnapshot(challenge), idempotent: true }
        fail(409, "A different result was already stored for this assignment")
      }
      if (assignment.status !== "active") fail(409, "Assignment is no longer active")
      if (challenge.status !== "assigned_offline" || challenge.revision !== assignment.revision)
        fail(409, "Assignment was superseded")

      if (!input.bundleSha256) {
        this.#run(
          "INSERT INTO results (assignment_id, result_bundle_sha256, created_at) VALUES (?, '', ?)",
          assignment.id,
          now,
        )
        this.#run(
          "UPDATE assignments SET status = 'finished', finished_at = ?, lease_until = NULL WHERE id = ?",
          now,
          assignment.id,
        )
        this.#run(
          "UPDATE challenges SET status = ?, updated_at = ? WHERE id = ?",
          queueStatus(assignment.phase),
          now,
          challenge.id,
        )
        return { challenge: this.#challengeSnapshot(this.#challengeByID(challenge.id)!), idempotent: false }
      }
      this.#run(
        "INSERT INTO results (assignment_id, result_bundle_sha256, created_at) VALUES (?, ?, ?)",
        assignment.id,
        input.bundleSha256,
        now,
      )
      this.#run(
        "UPDATE assignments SET status = 'finished', finished_at = ?, lease_until = NULL WHERE id = ?",
        now,
        assignment.id,
      )
      this.#run(
        `UPDATE challenges SET status = 'ready_online', result_bundle_sha256 = ?, updated_at = ? WHERE id = ?`,
        input.bundleSha256,
        now,
        challenge.id,
      )
      return { challenge: this.#challengeSnapshot(this.#challengeByID(challenge.id)!), idempotent: false }
    })
  }

  submitFlag(deviceID: string, input: { id: string; assignmentID: string; value: string }) {
    const now = this.#now()
    return this.#transaction(() => {
      const byID = this.#get<RawFlag>("SELECT * FROM flags WHERE id = ?", input.id)
      if (byID) {
        if (byID.assignment_id === input.assignmentID && byID.device_id === deviceID && byID.value === input.value)
          return { flag: flagView(byID), idempotent: true }
        fail(409, "submissionId was already used for a different flag")
      }
      const assignment = this.#assignmentByID(input.assignmentID)
      if (!assignment || assignment.device_id !== deviceID) fail(404, "Assignment not found")
      if (assignment.phase === "writeup") fail(409, "Writeup assignments cannot submit flags")
      const challenge = this.#challengeByID(assignment.challenge_id)
      if (!challenge || challenge.status === "solved") fail(409, "Challenge is already solved")
      if (challenge.revision !== assignment.revision) fail(409, "Assignment was superseded")
      const duplicate = this.#get<RawFlag>(
        "SELECT * FROM flags WHERE challenge_id = ? AND value = ?",
        challenge.id,
        input.value,
      )
      if (duplicate) return { flag: flagView(duplicate), idempotent: true }
      const flag: RawFlag = {
        id: input.id,
        challenge_id: challenge.id,
        assignment_id: assignment.id,
        device_id: deviceID,
        value: input.value,
        status: "pending",
        detail: null,
        created_at: now,
      }
      this.#run(
        "INSERT INTO flags (id, challenge_id, assignment_id, device_id, value, status, detail, created_at) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)",
        flag.id,
        flag.challenge_id,
        flag.assignment_id,
        flag.device_id,
        flag.value,
        flag.created_at,
      )
      return { flag: flagView(flag), idempotent: false }
    })
  }

  updateFlag(id: string, input: { status: FlagStatus; detail?: string }) {
    const now = this.#now()
    return this.#transaction(() => {
      const flag = this.#get<RawFlag>("SELECT * FROM flags WHERE id = ?", id)
      if (!flag) fail(404, "Flag not found")
      const challenge = this.#challengeByID(flag.challenge_id)
      if (!challenge) throw new Error(`Flag ${id} has no challenge`)
      if (flag.status === "accepted" && input.status !== "accepted") fail(409, "An accepted flag is final")
      if (challenge.status === "solved" && flag.status !== "accepted" && input.status === "accepted")
        fail(409, "Challenge was solved by another flag")
      this.#run("UPDATE flags SET status = ?, detail = ? WHERE id = ?", input.status, input.detail ?? null, id)

      if (input.status === "accepted" && challenge.status !== "solved") {
        this.#run(
          "UPDATE assignments SET status = 'finished', finished_at = ?, lease_until = NULL WHERE challenge_id = ? AND status = 'active'",
          now,
          challenge.id,
        )
        this.#run(
          `UPDATE challenges SET status = 'solved', writeup_status = 'pending', writeup_target_device = ?,
             updated_at = ? WHERE id = ?`,
          flag.device_id,
          now,
          challenge.id,
        )
      }
      return flagView(this.#get<RawFlag>("SELECT * FROM flags WHERE id = ?", id)!)
    })
  }

  submitWriteup(deviceID: string, input: { assignmentID: string; bundleSha256: string }) {
    const now = this.#now()
    return this.#transaction(() => {
      const assignment = this.#assignmentByID(input.assignmentID)
      if (!assignment || assignment.device_id !== deviceID) fail(404, "Assignment not found")
      const existing = this.#get<Row & { bundle_sha256: string }>(
        "SELECT bundle_sha256 FROM writeups WHERE assignment_id = ?",
        assignment.id,
      )
      if (existing) {
        if (existing.bundle_sha256 === input.bundleSha256) return { idempotent: true }
        fail(409, "A different writeup was already stored for this assignment")
      }
      if (assignment.phase !== "writeup" || assignment.status !== "active") fail(409, "Writeup assignment is no longer active")
      const challenge = this.#challengeByID(assignment.challenge_id)
      if (!challenge || challenge.status !== "solved" || challenge.writeup_status !== "pending")
        fail(409, "Challenge does not need a writeup")
      this.#run(
        "INSERT INTO writeups (challenge_id, assignment_id, device_id, bundle_sha256, created_at) VALUES (?, ?, ?, ?, ?)",
        challenge.id,
        assignment.id,
        deviceID,
        input.bundleSha256,
        now,
      )
      this.#run(
        "UPDATE assignments SET status = 'finished', finished_at = ?, lease_until = NULL WHERE id = ?",
        now,
        assignment.id,
      )
      this.#run(
        "UPDATE challenges SET writeup_status = 'done', updated_at = ? WHERE id = ?",
        now,
        challenge.id,
      )
      return { idempotent: false }
    })
  }

  masterState(): MasterState {
    const now = this.#now()
    return this.#transaction(() => {
      this.#expireLeases(now)
      const pendingFlags = this.#all<RawFlag>("SELECT * FROM flags WHERE status = 'pending' ORDER BY created_at ASC")
      const pendingFlagChallenges = this.#all<RawChallenge>(
        `SELECT c.* FROM challenges c
         WHERE EXISTS (SELECT 1 FROM flags f WHERE f.challenge_id = c.id AND f.status = 'pending')
         ORDER BY c.updated_at ASC`,
      )
      const readyOnline = this.#all<RawChallenge>(
        "SELECT * FROM challenges WHERE status = 'ready_online' ORDER BY updated_at ASC",
      )
      const activeRemote = this.#all<RawChallenge>(
        "SELECT * FROM challenges WHERE kind = 'remote' AND status IN ('queued_online', 'assigned_online') ORDER BY updated_at ASC",
      )
      const expired = this.#all<RawAssignment>(
        "SELECT * FROM assignments WHERE status = 'expired' ORDER BY finished_at ASC LIMIT 500",
      )
      const pendingWriteups = this.#all<RawChallenge>(
        "SELECT * FROM challenges WHERE writeup_status = 'pending' ORDER BY updated_at ASC",
      )
      return {
        pendingFlags: pendingFlags.map(flagView),
        pendingFlagChallenges: pendingFlagChallenges.map((challenge) => this.#challengeSnapshot(challenge)),
        readyOnline: readyOnline.map((challenge) => this.#challengeSnapshot(challenge)),
        activeRemote: activeRemote.map((challenge) => this.#challengeSnapshot(challenge)),
        expiredAssignments: expired.map((assignment) => this.#assignmentView(assignment)),
        pendingWriteups: pendingWriteups.map((challenge) => this.#challengeSnapshot(challenge)),
      }
    })
  }

}
