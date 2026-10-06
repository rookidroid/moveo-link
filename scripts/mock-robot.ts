// Stand-alone simulated robot over HTTP, for testing the app's real
// connection path without the arm (the app also has a built-in simulation).
//
//   npm run mock -- [--port 8080] [--uncalibrated]
//   then connect the app to localhost:8080

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { SimRobot } from '../src/shared/simRobot'

const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1]) || 8080
const uncalibrated = args.includes('--uncalibrated')
const sim = new SimRobot({ calibrated: !uncalibrated })

function send(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url || '/').split('?')[0]
  if (req.method === 'GET') {
    const r = sim.handle(path)
    return send(res, r.status, r.data)
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' })
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    let body: any = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { /* empty body */ }
    const r = sim.handle(path, body)
    console.log('POST', path, raw, '->', r.status)
    send(res, r.status, r.data)
  })
}).listen(port, () => {
  console.log(`Mock Movens on http://localhost:${port} (${uncalibrated ? 'uncalibrated' : 'calibrated'})`)
})
