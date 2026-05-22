import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRead } from "../../../src/tools/direct/read.js"

describe("read tool", () => {
  let tmpRoot: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "voiceclaw-read-"))
    prevEnv = process.env.VOICECLAW_WORKSPACE
    process.env.VOICECLAW_WORKSPACE = join(tmpRoot, "workspace")
    await mkdir(process.env.VOICECLAW_WORKSPACE, { recursive: true })
  })

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.VOICECLAW_WORKSPACE
    else process.env.VOICECLAW_WORKSPACE = prevEnv
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it("reads a small file with line numbers prefixed", async () => {
    const path = join(tmpRoot, "hello.txt")
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf-8")
    const result = await runRead({ path })
    if ("error" in result) throw new Error(result.error)
    expect(result.content).toBe("1\talpha\n2\tbeta\n3\tgamma\n")
    expect(result.totalLines).toBe(3)
    expect(result.truncated).toBe(false)
  })

  it("treats a file without trailing newline the same as one with", async () => {
    const path = join(tmpRoot, "no-nl.txt")
    await writeFile(path, "a\nb", "utf-8")
    const result = await runRead({ path })
    if ("error" in result) throw new Error(result.error)
    expect(result.content).toBe("1\ta\n2\tb\n")
    expect(result.totalLines).toBe(2)
  })

  it("returns (empty file) for zero-byte files", async () => {
    const path = join(tmpRoot, "empty.txt")
    await writeFile(path, "", "utf-8")
    const result = await runRead({ path })
    if ("error" in result) throw new Error(result.error)
    expect(result.content).toBe("(empty file)")
  })

  it("honors offset (1-indexed) and limit", async () => {
    const path = join(tmpRoot, "lines.txt")
    await writeFile(path, "one\ntwo\nthree\nfour\nfive\n", "utf-8")
    const result = await runRead({ path, offset: 2, limit: 2 })
    if ("error" in result) throw new Error(result.error)
    expect(result.content).toBe("2\ttwo\n3\tthree\n(... truncated)\n")
    expect(result.truncated).toBe(true)
    expect(result.totalLines).toBe(5)
  })

  it("returns a friendly message when offset is past EOF", async () => {
    const path = join(tmpRoot, "short.txt")
    await writeFile(path, "x\ny\n", "utf-8")
    const result = await runRead({ path, offset: 10 })
    if ("error" in result) throw new Error(result.error)
    expect(result.content).toMatch(/past end of file/)
  })

  it("truncates very long lines with an inline marker", async () => {
    const path = join(tmpRoot, "long.txt")
    const longLine = "x".repeat(3000)
    await writeFile(path, longLine + "\n", "utf-8")
    const result = await runRead({ path })
    if ("error" in result) throw new Error(result.error)
    expect(result.content).toMatch(/line truncated/)
    expect(result.content.length).toBeLessThan(longLine.length + 200)
  })

  it("resolves relative paths against the workspace root", async () => {
    const target = join(process.env.VOICECLAW_WORKSPACE!, "notes.md")
    await writeFile(target, "hi\n", "utf-8")
    const result = await runRead({ path: "notes.md" })
    if ("error" in result) throw new Error(result.error)
    expect(result.content).toBe("1\thi\n")
  })

  it("can read files outside the workspace (read-only is allowed anywhere)", async () => {
    const path = join(tmpRoot, "outside.txt")
    await writeFile(path, "outside-content\n", "utf-8")
    const result = await runRead({ path })
    if ("error" in result) throw new Error(result.error)
    expect(result.content).toMatch(/outside-content/)
  })

  it("returns an error when the file does not exist", async () => {
    const result = await runRead({ path: join(tmpRoot, "missing.txt") })
    expect("error" in result).toBe(true)
  })

  it("rejects an empty path", async () => {
    const result = await runRead({ path: "" })
    expect("error" in result).toBe(true)
  })
})
