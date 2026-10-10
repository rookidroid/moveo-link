// Shapes of the Movens firmware REST API and of the movens-link library.

export const NUM_JOINTS = 5
export const SERVO_MIN = 700
export const SERVO_MID = 1500
export const SERVO_MAX = 2300
export const DEFAULT_HOST = '192.168.4.1'

/** GET /status — jN steps, aN degrees (null if uncalibrated), mN 1 while moving */
export interface Status {
  [key: string]: number | null
  x: number | null
  y: number | null
  z: number | null
  pitch: number | null
  yaw: number | null
  servo: number
}

export interface JointCal {
  spd: number    // steps per degree, signed; 0 = not calibrated
  home: number   // angle of the alignment pose (step 0)
  min: number
  max: number
  limits: boolean
}
/** GET /calib, keyed 'j1'..'j5' */
export type Calib = Record<string, JointCal>

export interface Pose {
  x: number
  y: number
  z: number
  pitch: number
  yaw?: number | null  // missing / null = approach in the arm plane
}

export interface JointValues {
  unit: 'deg' | 'steps'
  v: number[]  // J1..J5
}

export interface Position {
  id: string
  name: string
  kind: 'joints' | 'pose'
  joints?: JointValues
  pose?: Pose
  gripper: number | null  // µs, null = leave the gripper as it is
  note?: string
  updatedAt: number
}

export type Step =
  | { id: string; type: 'move'; positionId: string; speed: number; dwellMs: number }
  | { id: string; type: 'gripper'; us: number; settleMs: number }
  | { id: string; type: 'wait'; ms: number }

export interface Sequence {
  id: string
  name: string
  repeat: number  // 0 = loop until stopped
  steps: Step[]
  updatedAt: number
}

export interface Library {
  version: 1
  positions: Position[]
  sequences: Sequence[]
}

export interface Settings {
  host: string
}

/** Reply of a robot request, relayed from the main process */
export interface ApiResult<T = any> {
  ok: boolean
  status: number   // HTTP status, 0 = network error / timeout
  data?: T
  error?: string
}

export const emptyLibrary = (): Library => ({ version: 1, positions: [], sequences: [] })

export const uid = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

/** Bridge exposed by the preload script as window.movens */
export interface MovensBridge {
  api(path: string, body?: unknown): Promise<ApiResult>
  library: {
    load(): Promise<Library>
    save(lib: Library): Promise<void>
    exportJson(name: string, data: unknown): Promise<boolean>
    importJson(): Promise<unknown | null>
  }
  settings: {
    get(): Promise<Settings>
    set(s: Partial<Settings>): Promise<Settings>
  }
}
