import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { constants, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import icon from '../../build/icon.png?asset'
import type { Library, Settings } from '../shared/types'
import { normalizeHost, robotRequest } from './robot'
import { JsonStore } from './store'

const here = fileURLToPath(new URL('.', import.meta.url))
let store: JsonStore
let settings: Settings
let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'Movens Link',
    icon,
    backgroundColor: '#0b0d0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep polling the robot (and the 3D view) live while the window is
      // covered by other windows; also keeps the Page Visibility API "visible"
      backgroundThrottling: false
    }
  })

  // External links open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', e => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(here, '../renderer/index.html'))
}

function registerIpc() {
  ipcMain.handle('robot:request', (_e, path: string, body?: unknown) =>
    robotRequest(settings.host, path, body))

  ipcMain.handle('library:load', () => store.loadLibrary())
  ipcMain.handle('library:save', (_e, lib: Library) => store.saveLibrary(lib))

  ipcMain.handle('file:export', async (_e, name: string, data: unknown) => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export',
      defaultPath: String(name).replace(/[\\/:*?"<>|]+/g, '_') + '.json',
      filters: [{ name: 'Movens Link JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return false
    await fs.writeFile(r.filePath, JSON.stringify(data, null, 2), 'utf8')
    return true
  })

  ipcMain.handle('file:import', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import',
      properties: ['openFile'],
      filters: [{ name: 'Movens Link JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      return JSON.parse(await fs.readFile(r.filePaths[0], 'utf8'))
    } catch {
      return { error: 'Not a valid JSON file' }
    }
  })

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', async (_e, s: Partial<Settings>) => {
    if (typeof s.host === 'string') s.host = normalizeHost(s.host)
    settings = await store.saveSettings(s)
    return settings
  })
}

// The app was called Moveo Link: carry its library and settings over once
async function migrateFromMoveo(dir: string) {
  const old = join(app.getPath('appData'), 'Moveo Link')
  await fs.mkdir(dir, { recursive: true })
  for (const name of ['library.json', 'settings.json']) {
    await fs.copyFile(join(old, name), join(dir, name), constants.COPYFILE_EXCL).catch(() => {})
  }
}

app.whenReady().then(async () => {
  await migrateFromMoveo(app.getPath('userData'))
  store = new JsonStore(app.getPath('userData'))
  settings = await store.loadSettings()
  // Development override, e.g. MOVENS_HOST=localhost:8080 for the mock robot
  if (process.env.MOVENS_HOST) settings.host = normalizeHost(process.env.MOVENS_HOST)
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
