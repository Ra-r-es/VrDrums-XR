# MR Drumset - Project Guide

## What This Is
A Mixed Reality percussion instrument: 8 aesthetic 3D drum instruments in VR, played with Pico 4 controllers, with sound synthesis in-browser and OSC output to Pure Data. Desktop browser shows a live mirror of the VR session.

## Architecture (3 Modules)

```
[Pico 4 Browser]                    [PC Browser]
  main.js (WebXR VR)                  main.js (Spectator)
       |                                   ^
       | Socket.IO                         | Socket.IO
       v                                   |
[Bridge Server - bridge/index.js, port 3000]
       |
       | OSC UDP (port 8000)
       v
[Pure Data Patch]
```

## Tech Stack
- **Frontend**: Three.js 0.160, Socket.IO client, Eruda (mobile debug), Vite + basicSsl
- **Bridge**: Express, Socket.IO server, osc (UDP), cors
- **Build**: `npm start` runs both via concurrently

## File Structure
```
/frontend/
  main.js         - Main app: scene, instruments, XR, particles, audio, mirror
  index.html      - Minimal shell, loads main.js as module
  vite.config.js  - HTTPS (basicSsl), host 0.0.0.0:5173, proxy /socket.io -> :3000
  package.json    - three, socket.io-client, eruda, vite

/bridge/
  index.js        - WebSocket-to-OSC bridge, spectator relay
  package.json    - express, socket.io, osc, cors

/package.json     - Root workspace: install:all, start (concurrent frontend+bridge)
```

## Critical Design Decisions

### Why VRButton (immersive-vr) instead of ARButton (immersive-ar)
Pico 4's browser triggers "Recovery Room" (system tracking failure) when requesting `immersive-ar` sessions. Using `immersive-vr` with `local-floor` reference space works reliably. Background is set to `null` in VR for passthrough compatibility.

### Why Vite proxy for Socket.IO
Frontend is served on HTTPS (port 5173, self-signed cert via basicSsl). Bridge is HTTP (port 3000). Direct connection = mixed content blocked by browser. Vite proxies `/socket.io` requests to `http://localhost:3000` transparently.

### Why no Web Worker for WebSocket
Socket.IO `emit()` is non-blocking by design - queues message and returns immediately. No performance benefit from a Worker. Pose data uses `socket.volatile.emit()` to drop frames if the connection can't keep up.

## Spectator Mirror System
The desktop browser and VR headset both load the same `main.js`. The difference:
- **Pico**: Clicks "Enter VR" -> `isSpectator = false` -> sends camera + controller poses via Socket.IO
- **PC**: Never enters VR -> `isSpectator = true` -> receives poses, updates camera + ghost controllers
- Bridge server broadcasts `xrPose` and `drumHitFeedback` to all non-sender clients
- Ghost controllers (translucent blue sticks) show VR user's hand positions on spectator view

## Instrument Layout (main.js)
8 instruments in a natural drumset arrangement around the player:

| Instrument | Geometry         | Position (x,y,z)     | Hit Radius |
|------------|------------------|-----------------------|------------|
| Hi-Hat     | Torus            | -0.35, 0.85, -0.40   | 0.18       |
| Snare      | Octahedron(d=2)  | -0.10, 0.72, -0.40   | 0.16       |
| Hi-Tom     | Icosahedron(d=1) | -0.12, 0.90, -0.55   | 0.14       |
| Med-Tom    | Icosahedron(d=1) |  0.15, 0.88, -0.55   | 0.16       |
| Floor Tom  | Dodecahedron(d=1)|  0.42, 0.55, -0.35   | 0.22       |
| Crash      | TorusKnot(2,3)   | -0.45, 1.20, -0.55   | 0.20       |
| Ride       | Torus            |  0.50, 1.10, -0.55   | 0.25       |
| Bass Drum  | Sphere           |  0.00, 0.22, -0.50   | 0.25       |

Y=0 is floor (`local-floor` reference space). Player head ~1.6m.

## Interaction Modes
1. **Physical collision**: Stick tip enters instrument bounding sphere while moving downward. Velocity = displacement/dt, capped at 1.0. Cooldown 120ms per instrument.
2. **Raycasting**: Visible ray from controller, turns orange on intersection. Trigger press = hit at 0.9 velocity.
3. **Foot pedals**: Trigger with no ray target: right hand = bassdrum, left hand = hihat.

## Socket.IO Events

| Event            | Direction              | Data                                      |
|------------------|------------------------|--------------------------------------------|
| `drumHit`        | VR -> Server           | `{instrument, velocity, x, y, z}`         |
| `drumHitFeedback`| Server -> Spectators   | same as drumHit                            |
| `xrPose`         | VR -> Server -> Specs  | `{cam:{px,py,pz,qx,qy,qz,qw}, ctrl:[...]}` |
| `xrSessionStart` | VR -> Server           | (no data)                                  |
| `xrSessionEnd`   | Server -> Spectators   | (no data, sent on VR client disconnect)    |

## OSC Output to Pure Data
- **Address**: `/drum/hit`
- **Args**: `<instrument:string> <velocity:float> <x:float> <y:float> <z:float>`
- **UDP**: From bridge port 57121 -> `127.0.0.1:8000`

## Visual System
- **Lighting**: Ambient(0x1a1a30) + warm overhead(0xffaa55) + blue accent(L) + red accent(R) + purple rim(behind)
- **Materials**: MeshStandardMaterial with PBR metalness/roughness
- **Hit feedback**: Scale pop (1 + 0.25*v) + emissive flash (hitColor @ intensity 5) + ease-out over 300ms
- **Particles**: 300 pre-allocated ring buffer, radial explosion with gravity, additive blending, auto-shrink
- **Ground glow**: CircleGeometry disc under each instrument, brightens on hit
- **Idle anims**: Sinusoidal float (6mm), slow Y rotation, emissive pulse
- **Ambient dust**: 80 floating particles rotating slowly

## How To Run
```bash
npm run install:all    # Install all dependencies (root + frontend + bridge)
npm start              # Start both servers concurrently
```
- PC browser: `https://localhost:5173` (spectator/mirror)
- Pico browser: `https://<PC-IP>:5173` (accept cert, click "Enter VR")
- Bridge status: `http://localhost:3000/status`

## Pico 4 Requirements
- Guardian/boundary must be set up in Pico Settings
- Room should be well-lit for tracking
- Access page via HTTPS (WebXR requires secure context)
- Accept self-signed certificate warning in Pico browser

## Performance Budget (targeting 72Hz on Pico XR2 Gen1)
- ~20k triangles total (all instruments + environment)
- ~30 draw calls
- 5 lights (1 ambient + 4 point)
- 300 particles max (ring buffer, dead = size 0)
- Pixel ratio capped at 2x
- Pose data throttled to ~36fps (every other VR frame)
- ACESFilmicToneMapping for visual quality at minimal cost
