#!/usr/bin/env node
import { execSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, "..")
const repoRoot = resolve(desktopRoot, "..")
const targetDir = join(desktopRoot, "resources", "bin")
const targetBinary = join(targetDir, "node")

const arch = process.env.NODE_BUNDLE_ARCH ?? "arm64"
const version = readPinnedVersion()
const tarball = `node-${version}-darwin-${arch}.tar.gz`
const url = `https://nodejs.org/dist/${version}/${tarball}`

if (existsSync(targetBinary) && bundledNodeMatches(targetBinary, version)) {
  console.log(`[fetch-node] ${targetBinary} already at ${version}`)
  process.exit(0)
}

mkdirSync(targetDir, { recursive: true })
const stage = mkdtempSync(join(tmpdir(), "voiceclaw-node-"))
try {
  console.log(`[fetch-node] downloading ${url}`)
  execSync(`curl -fsSL "${url}" -o "${join(stage, tarball)}"`, { stdio: "inherit" })
  execSync(`tar -xzf "${tarball}"`, { cwd: stage, stdio: "inherit" })
  const extracted = join(stage, `node-${version}-darwin-${arch}`, "bin", "node")
  if (!existsSync(extracted)) {
    throw new Error(`expected ${extracted} after extraction`)
  }
  copyFileSync(extracted, targetBinary)
  chmodSync(targetBinary, 0o755)
  console.log(`[fetch-node] wrote ${targetBinary} (${version}, ${arch})`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}

function readPinnedVersion() {
  const explicit = process.env.NODE_BUNDLE_VERSION
  if (explicit) return explicit.startsWith("v") ? explicit : `v${explicit}`
  const pinPath = join(desktopRoot, ".node-bundle-version")
  if (existsSync(pinPath)) {
    const raw = readFileSync(pinPath, "utf8").trim()
    return raw.startsWith("v") ? raw : `v${raw}`
  }
  const openclawPkg = JSON.parse(
    readFileSync(join(repoRoot, "vendor", "openclaw", "package.json"), "utf8"),
  )
  const engine = openclawPkg.engines?.node
  throw new Error(
    `[fetch-node] no version pin found. Set NODE_BUNDLE_VERSION or create desktop/.node-bundle-version. ` +
      `openclaw requires ${engine ?? "unknown"}.`,
  )
}

function bundledNodeMatches(binary, version) {
  try {
    const stat = statSync(binary)
    if (!stat.isFile()) return false
    const reported = execSync(`"${binary}" --version`, { encoding: "utf8" }).trim()
    return reported === version
  } catch {
    return false
  }
}
