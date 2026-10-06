// Renders the joint direction diagrams to docs/joints/*.png (npm run diagrams).
// Runs in Electron: serves the diagram page with Vite, draws it in a hidden
// window and saves the images it returns.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { createServer } from 'vite'

const here = import.meta.dirname
const outDir = resolve(here, '../../docs/joints')

app.whenReady().then(async () => {
  const server = await createServer({ configFile: resolve(here, 'vite.config.ts'), server: { port: 0 } })
  try {
    await server.listen()
    const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
    await win.loadURL(server.resolvedUrls.local[0])
    // wait for the page module (Vite may reload the page once after optimizing deps)
    const images = await win.webContents.executeJavaScript(`new Promise(done => {
      const poll = () => window.renderDiagrams ? done(window.renderDiagrams()) : setTimeout(poll, 50)
      poll()
    })`)
    mkdirSync(outDir, { recursive: true })
    for (const { name, png } of images) {
      writeFileSync(resolve(outDir, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'))
      console.log(`docs/joints/${name}.png`)
    }
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    await server.close()
    app.quit()
  }
})
