import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

export function resolveBundledNode(): string | null {
  const relative = join('bin', 'node')
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, relative)
    return existsSync(packaged) ? packaged : null
  }
  const dev = join(__dirname, '..', '..', 'resources', relative)
  if (existsSync(dev)) return dev
  return process.execPath.endsWith('node') ? process.execPath : null
}
