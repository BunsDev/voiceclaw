import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetShutdownStateForTests,
  gracefulShutdown,
  inFlightTaskCount,
  trackBackgroundTask,
} from "../src/shutdown.js"

describe("gracefulShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    __resetShutdownStateForTests()
    vi.useRealTimers()
  })

  it("awaits in-flight tasks and resolves once they settle", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    let resolved = false
    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true
        resolve()
      }, 200)
    })
    trackBackgroundTask(task, "test-task")

    const shutdownPromise = gracefulShutdown(1000)
    await vi.advanceTimersByTimeAsync(200)
    await shutdownPromise

    expect(resolved).toBe(true)
    expect(inFlightTaskCount()).toBe(0)

    const settledMessage = logSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("all background tasks settled")),
    )
    expect(settledMessage).toBe(true)

    logSpy.mockRestore()
  })

  it("returns within the cap when a task never resolves", async () => {
    const stuck = new Promise<void>(() => {})
    trackBackgroundTask(stuck, "stuck-task")

    const shutdownPromise = gracefulShutdown(100)
    await vi.advanceTimersByTimeAsync(100)
    await shutdownPromise

    expect(inFlightTaskCount()).toBe(1)
  })

  it("is idempotent — second call is a no-op", async () => {
    let resolved = false
    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true
        resolve()
      }, 100)
    })
    trackBackgroundTask(task, "idempotent-task")

    const first = gracefulShutdown(500)
    await vi.advanceTimersByTimeAsync(100)
    await first
    expect(resolved).toBe(true)

    let secondTaskRan = false
    const second = new Promise<void>((resolve) => {
      setTimeout(() => {
        secondTaskRan = true
        resolve()
      }, 200)
    })
    trackBackgroundTask(second, "second-task")

    await gracefulShutdown(500)
    expect(secondTaskRan).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    await second
  })

  it("awaits tasks that get added during the drain", async () => {
    let earlyResolved = false
    let lateResolved = false

    const early = new Promise<void>((resolve) => {
      setTimeout(() => {
        earlyResolved = true
        resolve()
      }, 100)
    })
    trackBackgroundTask(early, "early-task")

    const shutdownPromise = gracefulShutdown(1000)

    // Yield so gracefulShutdown enters its drain loop and snapshots the first
    // pending task before we add the late one.
    await Promise.resolve()

    const late = new Promise<void>((resolve) => {
      setTimeout(() => {
        lateResolved = true
        resolve()
      }, 300)
    })
    trackBackgroundTask(late, "late-task")

    await vi.advanceTimersByTimeAsync(300)
    await shutdownPromise

    expect(earlyResolved).toBe(true)
    expect(lateResolved).toBe(true)
    expect(inFlightTaskCount()).toBe(0)
  })
})
