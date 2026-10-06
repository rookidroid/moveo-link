// Renderer only, in a plain browser, against the mock robot (npm run mock).
// Robot requests go to /robot/* and are proxied to MOVEO_HOST.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const host = process.env.MOVEO_HOST || 'localhost:8080'

export default defineConfig({
  root: 'src/renderer',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  server: {
    port: 5180,
    proxy: { '/robot': { target: `http://${host}`, rewrite: p => p.replace(/^\/robot/, '') } }
  }
})
