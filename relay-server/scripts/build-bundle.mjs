#!/usr/bin/env node
import { execSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const relayRoot = resolve(here, "..")
const desktopRoot = resolve(relayRoot, "..", "desktop")
const stagingDir = resolve(desktopRoot, "resources", "relay-server-bundle")

const tscDist = join(relayRoot, "dist")
if (existsSync(tscDist)) rmSync(tscDist, { recursive: true, force: true })
run("yarn", ["tsc"], relayRoot)

if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
mkdirSync(stagingDir, { recursive: true })

cpSync(tscDist, join(stagingDir, "dist"), {
  recursive: true,
  filter: (src) => !src.endsWith(".map") && !src.endsWith(".d.ts"),
})

const pkg = JSON.parse(readFileSync(join(relayRoot, "package.json"), "utf8"))
const productionPkg = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: pkg.type,
  main: "dist/index.js",
  dependencies: pkg.dependencies ?? {},
}
writeFileSync(
  join(stagingDir, "package.json"),
  JSON.stringify(productionPkg, null, 2) + "\n",
)

run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], stagingDir)

console.log(`[relay] bundle staged at ${stagingDir}`)

function run(cmd, args, cwd) {
  console.log(`[relay] $ ${cmd} ${args.join(" ")}  (cwd=${cwd})`)
  execSync([cmd, ...args].join(" "), { cwd, stdio: "inherit" })
}
