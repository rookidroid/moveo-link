// Page that draws the joint direction diagrams in docs/joints (see render.mjs).
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(import.meta.dirname),
  resolve: { alias: { '@shared': resolve(import.meta.dirname, '../../src/shared') } },
  server: { port: 5181 },
  logLevel: 'warn'
})
