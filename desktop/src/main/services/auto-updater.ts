import { app } from 'electron'
import type { AppUpdater, UpdateInfo, ProgressInfo } from 'electron-updater'
import { openLogStream } from '../logs'
import { getDb } from '../db'
import { getMainWindow, markQuitting } from '../window-lifecycle'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'staged'
  | 'up-to-date'
  | 'error'

export type UpdateState = {
  currentVersion: string
  stagedVersion: string | null
  lastChecked: number | null
  status: UpdateStatus
  releaseNotes: string | null
  error: string | null
}

type RebuildTrayFn = () => void

let updaterInstance: AppUpdater | null = null
let rebuildTray: RebuildTrayFn | null = null
let initialized = false

const state: UpdateState = {
  currentVersion: app.getVersion(),
  stagedVersion: null,
  lastChecked: null,
  status: 'idle',
  releaseNotes: null,
  error: null,
}

let logStream: ReturnType<typeof openLogStream> | null = null

function log(msg: string, extra?: unknown): void {
  const line = extra !== undefined
    ? `[${new Date().toISOString()}] ${msg} ${JSON.stringify(extra)}\n`
    : `[${new Date().toISOString()}] ${msg}\n`
  process.stdout.write(line)
  logStream?.write(line)
}

function broadcast(channel: string, payload?: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function persistLastChecked(ts: number): void {
  try {
    const db = getDb()
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    ).run('updater_last_checked', String(ts), String(ts))
  } catch (err) {
    log('persist last_checked failed', err)
  }
}

function releaseNotesAsString(notes: UpdateInfo['releaseNotes']): string | null {
  if (!notes) return null
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === 'string' ? n : n.note ?? ''))
      .filter(Boolean)
      .join('\n\n')
  }
  return null
}

export function getUpdateState(): UpdateState {
  return { ...state }
}

export function setRebuildTray(fn: RebuildTrayFn): void {
  rebuildTray = fn
}

export async function checkForUpdatesNow(): Promise<UpdateState> {
  if (!updaterInstance) return getUpdateState()
  state.status = 'checking'
  broadcast('updates:stateChanged', getUpdateState())
  try {
    await updaterInstance.checkForUpdates()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state.status = 'error'
    state.error = msg
    state.lastChecked = Date.now()
    persistLastChecked(state.lastChecked)
    log('check failed', msg)
    broadcast('updates:stateChanged', getUpdateState())
  }
  return getUpdateState()
}

export function installNow(source: 'banner' | 'settings' | 'tray'): void {
  if (!updaterInstance || state.stagedVersion == null) return
  log(`install initiated source=${source}`)
  markQuitting()
  updaterInstance.quitAndInstall(false, true)
}

export async function initAutoUpdater(onRebuildTray?: RebuildTrayFn): Promise<void> {
  if (initialized) return
  if (!app.isPackaged) return
  if (process.env.VOICECLAW_DISABLE_UPDATER === '1') return

  if (onRebuildTray) rebuildTray = onRebuildTray

  try {
    logStream = openLogStream('auto-updater.log')
  } catch {
    // non-fatal
  }

  let mod: { autoUpdater: AppUpdater } | undefined
  try {
    mod = require('electron-updater') as { autoUpdater: AppUpdater }
  } catch (err) {
    log('electron-updater not available', err)
    return
  }

  const updater = mod.autoUpdater
  updaterInstance = updater

  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true

  updater.setFeedURL({
    provider: 'generic',
    url: 'https://raw.githubusercontent.com/yagudaev/voiceclaw/main/desktop/releases',
    channel: 'latest-mac',
  })

  updater.on('checking-for-update', () => {
    state.status = 'checking'
    state.error = null
    log('checking for update')
    broadcast('updates:stateChanged', getUpdateState())
  })

  updater.on('update-available', (info: UpdateInfo) => {
    state.status = 'downloading'
    state.releaseNotes = releaseNotesAsString(info.releaseNotes)
    state.lastChecked = Date.now()
    persistLastChecked(state.lastChecked)
    log('update available', { version: info.version })
    broadcast('updates:stateChanged', getUpdateState())
    broadcast('updates:available', { version: info.version, releaseNotes: state.releaseNotes })
  })

  updater.on('update-not-available', (info: UpdateInfo) => {
    state.status = 'up-to-date'
    state.lastChecked = Date.now()
    persistLastChecked(state.lastChecked)
    log('up to date', { version: info.version })
    broadcast('updates:stateChanged', getUpdateState())
  })

  updater.on('download-progress', (progress: ProgressInfo) => {
    state.status = 'downloading'
    log(`download progress ${Math.round(progress.percent)}%`)
    broadcast('updates:downloadProgress', { percent: progress.percent, bytesPerSecond: progress.bytesPerSecond })
  })

  updater.on('update-downloaded', (info: UpdateInfo) => {
    state.status = 'staged'
    state.stagedVersion = info.version
    state.releaseNotes = releaseNotesAsString(info.releaseNotes)
    state.lastChecked = Date.now()
    persistLastChecked(state.lastChecked)
    log('update staged', { version: info.version })
    broadcast('updates:stateChanged', getUpdateState())
    broadcast('updates:staged', { version: info.version, releaseNotes: state.releaseNotes })
    rebuildTray?.()
  })

  updater.on('error', (err: Error) => {
    state.status = 'error'
    state.error = err.message
    state.lastChecked = Date.now()
    persistLastChecked(state.lastChecked)
    log('error', err.message)
    broadcast('updates:stateChanged', getUpdateState())
    broadcast('updates:error', { message: err.message })
  })

  initialized = true

  try {
    await updater.checkForUpdates()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state.status = 'error'
    state.error = msg
    state.lastChecked = Date.now()
    persistLastChecked(state.lastChecked)
    log('initial check failed', msg)
    broadcast('updates:stateChanged', getUpdateState())
  }

  const FOUR_HOURS = 4 * 60 * 60 * 1000
  setInterval(() => {
    updater.checkForUpdates().catch((err: Error) => log('periodic check failed', err))
  }, FOUR_HOURS)
}
