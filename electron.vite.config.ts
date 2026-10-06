import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: { externalizeDeps: true }
  },
  preload: {
    build: {
      externalizeDeps: true,
      // Sandboxed preloads must be CommonJS
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } }
    }
  },
  renderer: {
    publicDir: resolve('logo'),
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
