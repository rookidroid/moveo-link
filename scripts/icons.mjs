// Renders the app icons from logo/*.svg (npm run icons):
//   build/icon.ico  Windows exe/installer icon (16-256 px)
//   build/icon.png  512 px, window icon and fallback for other platforms
// Runs in Electron and rasterizes the SVGs on a canvas in a hidden window.
// Sizes up to 32 px use favicon.svg, which has thicker strokes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'

const root = resolve(import.meta.dirname, '..')
const icon = readFileSync(resolve(root, 'logo/movens-link-icon.svg'), 'utf8')
const small = readFileSync(resolve(root, 'logo/favicon.svg'), 'utf8')
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]

async function render(win, svg, size) {
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
  const url = await win.webContents.executeJavaScript(`new Promise((done, fail) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = ${size}
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size})
      done(c.toDataURL('image/png'))
    }
    img.onerror = fail
    img.src = ${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(sized).toString('base64'))}
  })`)
  return Buffer.from(url.split(',')[1], 'base64')
}

// ICO with PNG-compressed entries (supported since Windows Vista)
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(size % 256, e) // 0 means 256
    header.writeUInt8(size % 256, e + 1)
    header.writeUInt16LE(1, e + 4) // planes
    header.writeUInt16LE(32, e + 6) // bits per pixel
    header.writeUInt32LE(png.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(i => i.png)])
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false })
    await win.loadURL('about:blank')
    const images = []
    for (const size of icoSizes) images.push({ size, png: await render(win, size <= 32 ? small : icon, size) })
    mkdirSync(resolve(root, 'build'), { recursive: true })
    writeFileSync(resolve(root, 'build/icon.ico'), ico(images))
    writeFileSync(resolve(root, 'build/icon.png'), await render(win, icon, 512))
    console.log('build/icon.ico\nbuild/icon.png')
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
