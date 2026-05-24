/**
 * @fileoverview Task lifecycle notification scanner.
 *
 * Encapsulates the duplicate-detection logic for task error/completion
 * events. Extracted from TaskStore.fetchList to reduce store file size
 * and isolate this pure-logic concern for independent unit testing.
 *
 * Usage:
 *   const notifier = createTaskNotifier()
 *   // Inside fetchList polling loop:
 *   notifier.scanTasks(tasksToScan, { onTaskError, onTaskComplete, onBtComplete })
 */
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsSeeder } from '@shared/utils'
import { logger } from '@shared/logger'
import type { Aria2Task } from '@shared/types'

interface ScanCallbacks {
  onTaskError?: ((task: Aria2Task) => void) | null
  onTaskComplete?: ((task: Aria2Task) => void) | null
  /** Fires when a BT task first enters seeding state (download phase complete). */
  onBtComplete?: ((task: Aria2Task) => void) | null
}

export interface TaskNotifier {
  /** Scan a batch of tasks for new errors/completions and fire callbacks. */
  scanTasks: (tasks: Aria2Task[], callbacks: ScanCallbacks) => void
  /** Clear all seen GIDs and reset the initial scan flag. */
  reset: () => void
}

/**
 * Creates an isolated notification scanner with its own deduplication state.
 *
 * The scanner suppresses callbacks during the first (initial) scan to avoid
 * ghost notifications for tasks that were already in a terminal state before
 * the app started monitoring.
 */
export function createTaskNotifier(): TaskNotifier {
  const notifiedErrorGids = new Set<string>()
  const notifiedCompleteGids = new Set<string>()
  const notifiedBtCompleteGids = new Set<string>()
  const restoredBtCompleteKeys = new Set<string>()
  let scanCount = 0

  function initialScanDone(): boolean {
    return scanCount > 0
  }

  function btCompletionKey(task: Aria2Task): string {
    return task.infoHash || task.gid
  }

  function btRestoreKeys(task: Aria2Task): string[] {
    return task.infoHash ? [task.gid, task.infoHash] : [task.gid]
  }

  function isRestoredBt(task: Aria2Task): boolean {
    return btRestoreKeys(task).some((key) => restoredBtCompleteKeys.has(key))
  }

  function scanTasks(tasks: Aria2Task[], callbacks: ScanCallbacks): void {
    const { onTaskError, onTaskComplete, onBtComplete } = callbacks

    // Detect newly errored tasks
    if (onTaskError) {
      for (const task of tasks) {
        if (
          task.status === TASK_STATUS.ERROR &&
          task.errorCode &&
          task.errorCode !== '0' &&
          !notifiedErrorGids.has(task.gid)
        ) {
          notifiedErrorGids.add(task.gid)
          if (initialScanDone()) {
            onTaskError(task)
          }
        }
      }
    }

    // Detect newly completed tasks (HTTP/FTP downloads)
    if (onTaskComplete) {
      for (const task of tasks) {
        if (task.status === 'complete' && !notifiedCompleteGids.has(task.gid)) {
          notifiedCompleteGids.add(task.gid)
          if (initialScanDone()) {
            onTaskComplete(task)
          }
        }
      }
    }

    // Detect BT tasks entering seeding state (download phase complete)
    if (onBtComplete) {
      for (const task of tasks) {
        if (!initialScanDone() && task.bittorrent) {
          for (const key of btRestoreKeys(task)) {
            restoredBtCompleteKeys.add(key)
          }
        }

        if (checkTaskIsSeeder(task)) {
          const key = btCompletionKey(task)
          if (!notifiedBtCompleteGids.has(key)) {
            notifiedBtCompleteGids.add(key)
            if (initialScanDone() && !isRestoredBt(task)) {
              onBtComplete(task)
            }
          }
        }
      }
    }

    // Mark initial scan as done AFTER all callbacks — unconditionally.
    if (!initialScanDone()) {
      logger.debug('TaskNotifier.initialScan', `suppressed notifications for ${tasks.length} pre-existing task(s)`)
    }
    scanCount = Math.min(scanCount + 1, Number.MAX_SAFE_INTEGER)
  }

  function reset(): void {
    notifiedErrorGids.clear()
    notifiedCompleteGids.clear()
    notifiedBtCompleteGids.clear()
    restoredBtCompleteKeys.clear()
    scanCount = 0
  }

  return { scanTasks, reset }
}
