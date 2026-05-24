/**
 * @fileoverview Unit tests for the app-level task lifecycle service.
 *
 * createTaskLifecycleService runs independently of route/tab state.
 * It polls aria2 for active + stopped tasks and feeds them to an
 * internal notifier for completion / error / BT-seeding detection.
 *
 * Core guarantees:
 *   1. Polls both 'active' and 'stopped' task lists on each tick.
 *   2. Suppresses callbacks during the initial scan (startup).
 *   3. Fires onTaskComplete for newly completed tasks after initial scan.
 *   4. Fires onTaskError for newly errored tasks after initial scan.
 *   5. Fires onBtComplete for newly seeding BT tasks after initial scan.
 *   6. Never re-fires for an already-seen GID.
 *   7. Skips scanning when engine is not ready.
 *   8. start() begins periodic polling; stop() halts it.
 *   9. reset() clears deduplication state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Aria2Task, TaskStatus } from '@shared/types'

// ── Mock isEngineReady ────────────────────────────────────────────────
let mockEngineReady = true
vi.mock('@/api/aria2', () => ({
  isEngineReady: () => mockEngineReady,
}))

// ── Mock logger ───────────────────────────────────────────────────────
vi.mock('@shared/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

// ── Import after mocks ───────────────────────────────────────────────
import { createTaskLifecycleService } from '../useTaskLifecycleService'

// ── Helpers ──────────────────────────────────────────────────────────
const makeMockTask = (gid: string, status: TaskStatus = 'active', extra: Partial<Aria2Task> = {}): Aria2Task => ({
  gid,
  status,
  totalLength: '1000',
  completedLength: '500',
  uploadLength: '0',
  downloadSpeed: '1000',
  uploadSpeed: '0',
  connections: '1',
  numSeeders: '0',
  dir: '/tmp',
  files: [],
  bittorrent: undefined,
  infoHash: undefined,
  errorCode: undefined,
  errorMessage: undefined,
  numPieces: undefined,
  pieceLength: undefined,
  followedBy: undefined,
  following: undefined,
  belongsTo: undefined,
  ...extra,
})

function createMockApi() {
  return {
    fetchTaskList: vi.fn().mockResolvedValue([] as Aria2Task[]),
  }
}

function createMockCallbacks() {
  return {
    onTaskError: vi.fn(),
    onTaskComplete: vi.fn(),
    onBtComplete: vi.fn(),
  }
}

describe('createTaskLifecycleService', () => {
  let api: ReturnType<typeof createMockApi>
  let callbacks: ReturnType<typeof createMockCallbacks>

  beforeEach(() => {
    vi.useFakeTimers()
    mockEngineReady = true
    api = createMockApi()
    callbacks = createMockCallbacks()
  })

  it('locks the stopped scan window to 50 items', async () => {
    let tick = 0
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'active') return Promise.resolve([])
      tick++
      if (tick === 1) return Promise.resolve([])
      return Promise.resolve(Array.from({ length: 80 }, (_, i) => makeMockTask(`s${i}`, 'complete')))
    })

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 1000)

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(callbacks.onTaskComplete).toHaveBeenCalledTimes(50)

    service.stop()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Construction ──────────────────────────────────────────────

  it('returns an object with start, stop, and reset methods', () => {
    const service = createTaskLifecycleService(api, callbacks)
    expect(service).toHaveProperty('start')
    expect(service).toHaveProperty('stop')
    expect(service).toHaveProperty('reset')
    expect(typeof service.start).toBe('function')
    expect(typeof service.stop).toBe('function')
    expect(typeof service.reset).toBe('function')
  })

  // ── Polling mechanics ─────────────────────────────────────────

  it('polls both active and stopped task lists on each tick', async () => {
    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 1000)

    // Advance past first tick
    await vi.advanceTimersByTimeAsync(1000)

    expect(api.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
    expect(api.fetchTaskList).toHaveBeenCalledWith({ type: 'stopped' })
  })

  it('schedules next tick only after current scan completes (await-then-schedule)', async () => {
    let resolveActive: ((v: Aria2Task[]) => void) | null = null
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'active') {
        return new Promise<Aria2Task[]>((r) => {
          resolveActive = r
        })
      }
      return Promise.resolve([])
    })

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    // First tick fires at t=500
    await vi.advanceTimersByTimeAsync(500)
    expect(api.fetchTaskList).toHaveBeenCalledTimes(1) // active call started

    // Advance time significantly — next tick should NOT fire because active call is still pending
    await vi.advanceTimersByTimeAsync(2000)
    // Only the active + stopped from first tick
    const callCountBeforeResolve = api.fetchTaskList.mock.calls.length
    expect(callCountBeforeResolve).toBeLessThanOrEqual(2) // at most active + stopped from first tick

    // Resolve the active call — now stopped call runs, then next tick schedules
    resolveActive!([])
    await vi.advanceTimersByTimeAsync(0) // flush microtasks

    // Advance to next tick
    await vi.advanceTimersByTimeAsync(500)
    // Now we should see additional calls from the second tick
    expect(api.fetchTaskList.mock.calls.length).toBeGreaterThan(callCountBeforeResolve)

    service.stop()
  })

  it('stop() prevents further polling', async () => {
    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 1000)

    await vi.advanceTimersByTimeAsync(1000)
    const callCount = api.fetchTaskList.mock.calls.length

    service.stop()

    await vi.advanceTimersByTimeAsync(5000)
    expect(api.fetchTaskList.mock.calls.length).toBe(callCount)
  })

  // ── Engine readiness gate ─────────────────────────────────────

  it('skips scan when engine is not ready', async () => {
    mockEngineReady = false
    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(api.fetchTaskList).not.toHaveBeenCalled()
  })

  it('resumes scanning when engine becomes ready again', async () => {
    mockEngineReady = false
    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 1000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(api.fetchTaskList).not.toHaveBeenCalled()

    mockEngineReady = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.fetchTaskList).toHaveBeenCalled()

    service.stop()
  })

  // ── Initial scan suppression ──────────────────────────────────

  it('does NOT fire callbacks during the initial (first) scan', async () => {
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'stopped') {
        return Promise.resolve([makeMockTask('c1', 'complete'), makeMockTask('e1', 'error', { errorCode: '3' })])
      }
      return Promise.resolve([])
    })

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(callbacks.onTaskComplete).not.toHaveBeenCalled()
    expect(callbacks.onTaskError).not.toHaveBeenCalled()

    service.stop()
  })

  // ── Completion detection ──────────────────────────────────────

  it('fires onTaskComplete for newly completed tasks after initial scan', async () => {
    // First tick: empty (initial scan)
    api.fetchTaskList.mockResolvedValue([])

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    await vi.advanceTimersByTimeAsync(500) // initial scan
    expect(callbacks.onTaskComplete).not.toHaveBeenCalled()

    // Second tick: completed task appears
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'stopped') {
        return Promise.resolve([makeMockTask('c1', 'complete')])
      }
      return Promise.resolve([])
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(callbacks.onTaskComplete).toHaveBeenCalledTimes(1)
    expect(callbacks.onTaskComplete).toHaveBeenCalledWith(expect.objectContaining({ gid: 'c1', status: 'complete' }))

    service.stop()
  })

  // ── Error detection ───────────────────────────────────────────

  it('fires onTaskError for newly errored tasks after initial scan', async () => {
    api.fetchTaskList.mockResolvedValue([])

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    await vi.advanceTimersByTimeAsync(500) // initial scan

    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'stopped') {
        return Promise.resolve([makeMockTask('e1', 'error', { errorCode: '6', errorMessage: 'Network problem' })])
      }
      return Promise.resolve([])
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(callbacks.onTaskError).toHaveBeenCalledTimes(1)
    expect(callbacks.onTaskError).toHaveBeenCalledWith(expect.objectContaining({ gid: 'e1', errorCode: '6' }))

    service.stop()
  })

  // ── BT seeding detection ──────────────────────────────────────

  it('fires onBtComplete for BT tasks entering seeding state', async () => {
    api.fetchTaskList.mockResolvedValue([])

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    await vi.advanceTimersByTimeAsync(500) // initial scan

    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'active') {
        return Promise.resolve([
          makeMockTask('bt1', 'active', {
            bittorrent: { info: { name: 'test.torrent' } },
            seeder: 'true',
            completedLength: '1000',
          }),
        ])
      }
      return Promise.resolve([])
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(callbacks.onBtComplete).toHaveBeenCalledTimes(1)
    expect(callbacks.onBtComplete).toHaveBeenCalledWith(expect.objectContaining({ gid: 'bt1' }))

    service.stop()
  })

  it('does not fire onBtComplete for restored complete BT tasks that report seeder later', async () => {
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'active') {
        return Promise.resolve([
          makeMockTask('bt1', 'active', {
            bittorrent: { info: { name: 'restored.torrent' } },
            infoHash: 'same-info-hash',
            completedLength: '1000',
            totalLength: '1000',
            seeder: 'false',
          }),
        ])
      }
      return Promise.resolve([])
    })

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    await vi.advanceTimersByTimeAsync(500)

    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'active') {
        return Promise.resolve([
          makeMockTask('bt2', 'active', {
            bittorrent: { info: { name: 'restored.torrent' } },
            infoHash: 'same-info-hash',
            completedLength: '1000',
            totalLength: '1000',
            seeder: 'true',
          }),
        ])
      }
      return Promise.resolve([])
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(callbacks.onBtComplete).not.toHaveBeenCalled()

    service.stop()
  })

  it('does not fire onBtComplete for restored BT tasks that start as zero length', async () => {
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'active') {
        return Promise.resolve([
          makeMockTask('bt1', 'active', {
            bittorrent: { info: { name: 'restored.torrent' } },
            completedLength: '0',
            totalLength: '0',
            seeder: 'false',
          }),
        ])
      }
      return Promise.resolve([])
    })

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    await vi.advanceTimersByTimeAsync(500)

    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'active') {
        return Promise.resolve([
          makeMockTask('bt1', 'active', {
            bittorrent: { info: { name: 'restored.torrent' } },
            infoHash: 'hydrated-info-hash',
            completedLength: '1000',
            totalLength: '1000',
            seeder: 'true',
          }),
        ])
      }
      return Promise.resolve([])
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(callbacks.onBtComplete).not.toHaveBeenCalled()

    service.stop()
  })

  // ── Deduplication ─────────────────────────────────────────────

  it('never re-fires for an already-seen GID across multiple scans', async () => {
    api.fetchTaskList.mockResolvedValue([])

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    await vi.advanceTimersByTimeAsync(500) // initial scan

    // Task appears
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'stopped') {
        return Promise.resolve([makeMockTask('c1', 'complete')])
      }
      return Promise.resolve([])
    })

    await vi.advanceTimersByTimeAsync(500) // fires
    expect(callbacks.onTaskComplete).toHaveBeenCalledTimes(1)

    // Same task in next poll — no duplicate
    await vi.advanceTimersByTimeAsync(500)
    expect(callbacks.onTaskComplete).toHaveBeenCalledTimes(1)

    // New task — fires
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'stopped') {
        return Promise.resolve([makeMockTask('c1', 'complete'), makeMockTask('c2', 'complete')])
      }
      return Promise.resolve([])
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(callbacks.onTaskComplete).toHaveBeenCalledTimes(2)

    service.stop()
  })

  // ── Mixed active + stopped scanning ───────────────────────────

  it('detects events from both active and stopped task lists', async () => {
    api.fetchTaskList.mockResolvedValue([])

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    await vi.advanceTimersByTimeAsync(500) // initial scan

    // Active has a seeder, stopped has a completed task
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'active') {
        return Promise.resolve([
          makeMockTask('bt1', 'active', {
            bittorrent: { info: { name: 'torrent' } },
            seeder: 'true',
            completedLength: '1000',
          }),
        ])
      }
      if (type === 'stopped') {
        return Promise.resolve([makeMockTask('c1', 'complete')])
      }
      return Promise.resolve([])
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(callbacks.onBtComplete).toHaveBeenCalledTimes(1)
    expect(callbacks.onTaskComplete).toHaveBeenCalledTimes(1)

    service.stop()
  })

  // ── Error resilience ──────────────────────────────────────────

  it('continues polling after API errors', async () => {
    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    // First tick: API throws
    api.fetchTaskList.mockRejectedValueOnce(new Error('RPC fail'))
    await vi.advanceTimersByTimeAsync(500)

    // Second tick: API works — should still poll
    api.fetchTaskList.mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(500)
    // fetchTaskList called on the second tick (at least 2 times: initial error + retry)
    expect(api.fetchTaskList.mock.calls.length).toBeGreaterThanOrEqual(2)

    service.stop()
  })

  // ── Reset ─────────────────────────────────────────────────────

  it('reset clears deduplication state and re-arms initial scan suppression', async () => {
    api.fetchTaskList.mockResolvedValue([])

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    await vi.advanceTimersByTimeAsync(500) // initial scan

    // Task appears and fires
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'stopped') {
        return Promise.resolve([makeMockTask('c1', 'complete')])
      }
      return Promise.resolve([])
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(callbacks.onTaskComplete).toHaveBeenCalledTimes(1)

    // Reset — should suppress c1 again on next scan (treated as initial)
    service.reset()
    await vi.advanceTimersByTimeAsync(500) // post-reset initial scan
    expect(callbacks.onTaskComplete).toHaveBeenCalledTimes(1) // still 1

    // NEW task after reset initial scan
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'stopped') {
        return Promise.resolve([makeMockTask('c1', 'complete'), makeMockTask('c2', 'complete')])
      }
      return Promise.resolve([])
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(callbacks.onTaskComplete).toHaveBeenCalledTimes(2) // c2 fires

    service.stop()
  })

  // ── Stopped slice limit ───────────────────────────────────────

  it('limits stopped task scan to a reasonable slice', async () => {
    // Return many stopped tasks
    const manyStoppedTasks = Array.from({ length: 100 }, (_, i) => makeMockTask(`s${i}`, 'complete'))
    api.fetchTaskList.mockImplementation(({ type }: { type: string }) => {
      if (type === 'stopped') return Promise.resolve(manyStoppedTasks)
      return Promise.resolve([])
    })

    const service = createTaskLifecycleService(api, callbacks)
    service.start(() => 500)

    await vi.advanceTimersByTimeAsync(500) // initial scan
    await vi.advanceTimersByTimeAsync(500) // second scan — would fire for all

    // Should NOT fire 100 callbacks — service should limit the slice
    expect(callbacks.onTaskComplete.mock.calls.length).toBeLessThanOrEqual(20)

    service.stop()
  })
})
