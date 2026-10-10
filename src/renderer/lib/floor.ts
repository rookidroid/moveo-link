// The floor of the 3D view: a disc that fades into the background toward its
// rim, a grid fading with it, and over both what the arm's shadow falls on.

import * as THREE from 'three'

function smoothstep(x: number, from: number, to: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** Disc on z = 0, each vertex coloured by its distance from the centre */
function discGeometry(radius: number, rings: number, segments: number, colorAt: (r: number) => THREE.Color) {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], index: number[] = []
  for (let ring = 0; ring <= rings; ring++) {
    const r = radius * ring / rings
    const c = colorAt(r)
    for (let s = 0; s < segments; s++) {
      const a = 2 * Math.PI * s / segments
      positions.push(r * Math.cos(a), r * Math.sin(a), 0)
      normals.push(0, 0, 1)
      colors.push(c.r, c.g, c.b)
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let s = 0; s < segments; s++) {
      const a = ring * segments + s, b = ring * segments + (s + 1) % segments
      index.push(a, a + segments, b + segments, a, b + segments, b)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(index)
  return geo
}

/** Grid lines on z = 0 out to `radius`, every `majorEvery`th one major. Each is
 *  cut into pieces a cell long, so it can fade along its length. */
function gridGeometry(radius: number, cell: number, majorEvery: number,
                      colorAt: (r: number, major: boolean) => THREE.Color) {
  const positions: number[] = [], colors: number[] = []
  const count = Math.floor(radius / cell)
  for (let line = -count; line <= count; line++) {
    const across = line * cell, major = line % majorEvery === 0
    for (let piece = -count; piece < count; piece++) {
      const ends = [piece * cell, (piece + 1) * cell]
      if (ends.some(along => Math.hypot(across, along) > radius)) continue
      for (const swap of [false, true]) {
        for (const along of ends) {
          const c = colorAt(Math.hypot(across, along), major)
          positions.push(swap ? along : across, swap ? across : along, 0)
          colors.push(c.r, c.g, c.b)
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geo
}

export function makeFloor(radius: number, cell: number,
                          colors: { ground: string; background: string; grid: string }): THREE.Group {
  const ground = new THREE.Color(colors.ground), background = new THREE.Color(colors.background)
  const line = new THREE.Color(colors.grid)
  const floorColor = (r: number) => ground.clone().lerp(background, smoothstep(r, radius * 0.3, radius))
  const lineColor = (r: number, major: boolean) =>
    floorColor(r).lerp(line, (1 - smoothstep(r, radius * 0.25, radius * 0.9)) * (major ? 1 : 0.45))

  const disc = discGeometry(radius, 12, 96, floorColor)
  const floor = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({
    vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
  }))
  const grid = new THREE.LineSegments(gridGeometry(radius, cell, 5, lineColor),
    new THREE.LineBasicMaterial({ vertexColors: true }))
  const shadow = new THREE.Mesh(disc, new THREE.ShadowMaterial({ opacity: 0.4, depthWrite: false }))
  shadow.receiveShadow = true
  shadow.renderOrder = 1

  const g = new THREE.Group()
  g.add(floor, grid, shadow)
  return g
}
