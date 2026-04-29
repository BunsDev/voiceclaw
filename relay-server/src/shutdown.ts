// Tracks background tasks (transcript syncs, media finalize) so gracefulShutdown
// can await them before exit. Caller is responsible for handling promise
// rejections; trackBackgroundTask only observes resolution to remove from set.

import { log, warn } from "./log.js"

interface TrackedTask {
  promise: Promise<unknown>
  label: string
}

const tasks = new Set<TrackedTask>()
// Guards gracefulShutdown's drain loop against concurrent invocation. The
// SIGTERM/SIGINT-layer flag in index.ts is a separate concern.
let shuttingDown = false

export function trackBackgroundTask(promise: Promise<unknown>, label: string): void {
  const entry: TrackedTask = { promise, label }
  tasks.add(entry)
  // Neutralize rejections at the tracking boundary so callers that forget to
  // attach a .catch() don't trigger an unhandledRejection via .finally's rethrow.
  promise.then(noop, noop).finally(() => {
    tasks.delete(entry)
  })
}

export function inFlightTaskCount(): number {
  return tasks.size
}

export async function gracefulShutdown(timeoutMs: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  const deadline = Date.now() + timeoutMs

  if (tasks.size === 0) {
    log("[shutdown] no in-flight background tasks")
    return
  }

  log(`[shutdown] awaiting ${tasks.size} in-flight background task(s) (cap ${timeoutMs}ms)`)

  while (tasks.size > 0) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break

    const snapshot = Array.from(tasks).map((t) => t.promise)
    await Promise.race([
      Promise.allSettled(snapshot),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining)
        timer.unref()
      }),
    ])
    // Yield so the .finally(deletion) microtasks chained in trackBackgroundTask
    // fire before we re-check tasks.size — otherwise the loop can iterate one
    // extra time on entries whose promises have already settled.
    await Promise.resolve()
  }

  if (tasks.size === 0) {
    log("[shutdown] all background tasks settled")
  } else {
    const unfinished = Array.from(tasks).map((t) => t.label)
    warn(`[shutdown] timed out after ${timeoutMs}ms with ${unfinished.length} unfinished task(s): ${unfinished.join(", ")}`)
  }
}

export function __resetShutdownStateForTests(): void {
  tasks.clear()
  shuttingDown = false
}

function noop(): void {}
