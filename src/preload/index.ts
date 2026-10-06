import { contextBridge, ipcRenderer } from 'electron'
import type { MovensBridge } from '../shared/types'

const bridge: MovensBridge = {
  api: (path, body) => ipcRenderer.invoke('robot:request', path, body),
  library: {
    load: () => ipcRenderer.invoke('library:load'),
    save: lib => ipcRenderer.invoke('library:save', lib),
    exportJson: (name, data) => ipcRenderer.invoke('file:export', name, data),
    importJson: () => ipcRenderer.invoke('file:import')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: s => ipcRenderer.invoke('settings:set', s)
  }
}

contextBridge.exposeInMainWorld('movens', bridge)
