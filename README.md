<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/movens-link-logo-dark.svg">
    <img src="logo/movens-link-logo.svg" alt="Movens Link" width="420">
  </picture>
</p>

# Movens Link

Desktop controller for the [Movens](https://github.com/rookidroid/movens) 5-axis robot arm over WiFi.
It talks to the ESP32 firmware's REST API (`FIRMWARE/movens`) and adds positions, sequences and a
3D view with mouse teleoperation.

![Control view](docs/control.png)

## Features

**Everything the firmware's web page does:**
- Arm state: tool pose, joint angles and steps, and soft-limit meters.
- Go to origin and the E-stop (STOP button or <kbd>Esc</kbd>).
- Tool (XYZ) stepping and go-to-pose with a reach check, and joint stepping and targets in degrees: in the
  panel that comes up when the gripper or a link is clicked in the 3D view (see below).
- Motion settings (speed / acceleration), on the Settings tab.
- Gripper servo.
- The 4-step joint calibration wizard.

**Simulation first:** the app starts in simulation mode and never contacts the robot until you press
**Connect** (app bar or Settings). Every feature, including the 3D view, positions and sequences, then drives
a built-in virtual arm, so motions can be prepared and rehearsed offline. Disconnecting stops the arm and goes
back to the simulation. If the robot stops answering while connected, the app shows **Offline** and stays on
the robot (it never silently switches to the simulation).

**New:**
- **3D view.** Fills the window behind every tab; the controls lie over it as panels that fold away and
  stay as you left them. A live model of the arm and a translucent *ghost* for previews.
  - Trail of the tool path.
  - Camera presets (Iso, Front, Side, Top).
- **Mouse teleoperation** in the 3D view, picked by clicking the arm. Click anywhere else to go back to orbiting; a preview stays up until you move to it or reset it:
  - *Tool drag*: click the gripper, then drag the gizmo on the fingertip. IK solves the arm live; past the edge of reach or a joint limit, the gizmo and the ghost (now orange) stop at the nearest reachable position. Drag the ring around the fingertip, or use Shift + wheel, to change the pitch.
  - *Joint drag*: click a link to pick its joint, then drag the ring around the joint axis. Blue **+** and orange **−** arrows on the ring show which way the joint's angle grows, as in [Joint directions](#joint-directions).
  - Either brings up a panel with the same target in numbers: type a value, or step it with the **−** / **+** buttons by the chosen step (1, 5, 10 or 50 mm or degrees). *Snap drag* makes dragging move in whole steps too.
  - *Preview* mode moves the arm on **Move** or <kbd>Enter</kbd>. *Live* mode follows the drag, throttled to one request at a time at a capped speed.
- **Positions** (left, under the arm's state) and **Sequences** (right) are panels of the Control tab, beside
  the arm they drive.
- **Positions:**
  - Teach the current arm position, or create tool poses by hand.
  - Edit, convert between joints and tool pose, preview as a ghost, and go there at a chosen speed.
- **Sequences:** chain *move* steps (position, speed %, dwell), *gripper* steps and *wait* steps.
  - Reorder steps by dragging, and set a repeat count.
  - Validate the sequence and preview its tool path in 3D.
  - Run, pause/resume, single-step, run from a step, and stop.
  - Each move waits until all joints have stopped before the next step starts.
- Import/export of the library as JSON.

## Requirements

- The robot firmware with the `POST /movejoints` endpoint and the `speed` option on `/movepose` (current
  `movens` firmware). Older firmware still works for everything except joint-space positions and sequence speeds.
- To connect, join the arm's WiFi access point **movens** (password `movens_1234`), press **Connect** and
  confirm the address (default `192.168.4.1`, remembered between sessions).

## Joint directions

Angles are in degrees and match the firmware's arm model (`movens_config.h`). With every joint at 0° the arm
points straight up. Each diagram below shows a base pose (solid) and the same pose with one joint turned
**+** (blue) and **−** (orange). Calibrate each joint so that its + direction matches. J1 only turns through
0° to 180°, so its diagram starts at 90°.

<table>
  <tr>
    <td><img src="docs/joints/zero.png" alt="Zero pose: all joints at 0 degrees, arm pointing straight up, +X forward" width="420"/></td>
    <td><img src="docs/joints/j1.png" alt="J1 base: plus turns counter-clockwise seen from above" width="420"/></td>
  </tr>
  <tr>
    <td><img src="docs/joints/j2.png" alt="J2 shoulder: plus leans the arm forward" width="420"/></td>
    <td><img src="docs/joints/j3.png" alt="J3 elbow: plus bends the forearm forward" width="420"/></td>
  </tr>
  <tr>
    <td><img src="docs/joints/j4.png" alt="J4 wrist roll: plus is right-handed about the forearm, thumb toward the gripper" width="420"/></td>
    <td><img src="docs/joints/j5.png" alt="J5 wrist pitch: plus tips the gripper forward" width="420"/></td>
  </tr>
</table>

| Joint | + direction |
|---|---|
| J1 base | Counter-clockwise seen from above. Range 0° to 180° (0° = arm faces +X) |
| J2 shoulder | Leans the arm forward (toward +X at J1 = 0) |
| J3 elbow | Bends the forearm forward |
| J4 wrist roll | Right-handed about the forearm (thumb toward the gripper) |
| J5 wrist pitch | Tips the gripper forward, toward the bend of the arm |

## Development

```bash
npm install
npm run dev           # Electron app with hot reload (starts in simulation)
npm run mock          # stand-alone simulated robot over HTTP on localhost:8080 (-- --uncalibrated
                      # to test calibration); connect the app to localhost:8080 to test the real path
npm run web           # renderer only, in a browser at localhost:5180; Connect goes to the mock via a proxy
npm test              # unit tests (kinematics, simulator, sequence runner, storage)
npm run typecheck
npm run diagrams      # redraw the joint direction diagrams in docs/joints/ from the 3D model
npm run dist          # Windows installer + portable exe in dist/
```

The positions and sequences library is stored in `%APPDATA%\Movens Link\library.json`.

### Layout

| Path | |
|---|---|
| `src/main/` | Electron main process: robot HTTP client (`robot.ts`), JSON storage (`store.ts`) |
| `src/preload/` | `window.movens` bridge (IPC) |
| `src/shared/kinematics.ts` | Port of the firmware's `kinematics.cpp`. Keep `KIN` in sync with `movens_config.h` |
| `src/renderer/lib/` | API/polling core, 3D view (`arm3d.ts`, its floor in `floor.ts`), sequence runner, library |
| `src/renderer/styles/` | `app.css` (the firmware's stylesheet), `link.css` (additions), `hud.css` (the full-window 3D view and the panels over it) |
| `src/renderer/views/` | Control (with its Positions and Sequences panels), Calibrate, Settings |
| `src/shared/simRobot.ts` | Simulated robot (same REST API as the firmware), used by simulation mode and the mock |
| `scripts/mock-robot.ts` | HTTP wrapper around the simulated robot |
| `scripts/joint-diagrams/` | Draws `docs/joints/*.png` with the 3D view's arm model (`src/renderer/lib/armModel.ts`) |

All robot requests go through the main process because the firmware's POST replies carry no CORS headers.
