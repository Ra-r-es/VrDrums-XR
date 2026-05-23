# MR Drumset

A Mixed Reality drumset playable in a VR headset (Pico 4) using the browser — no app installation required. The player sees 8 virtual drum instruments in their physical space and hits them with the controllers as drumsticks. Sound plays in the headset and through Pure Data on the PC.

## Technologies

| Layer | Technology |
|---|---|
| 3D Graphics | Three.js (WebGL) |
| VR / Headset | WebXR API |
| Audio (headset) | Web Audio API |
| Audio (PC) | Pure Data + OSC |
| Networking | Socket.IO, Node.js, Express |
| Build | Vite |

## Languages

JavaScript (frontend + bridge server), Pure Data patch language

## APIs

- **WebXR** — VR session, controller tracking, haptic feedback
- **Web Audio API** — procedural drum synthesis in the browser
- **OSC over UDP** — hit events sent from bridge server to Pure Data

## Features

- 8 instruments: bass drum, snare, hi-hat, hi tom, med tom, floor tom, crash, ride
- Physical collision detection — hitting a drum triggers based on actual controller speed
- Velocity-sensitive — harder hits produce louder sound and more visual feedback
- Raycast mode — point and pull trigger to hit instruments from a distance
- Virtual foot pedals — trigger button activates bass drum (right) or hi-hat (left)
- Haptic feedback on every hit
- Particle effects, emissive flash, and cymbal wobble on impact
- Spectator mirror — a second browser on PC shows the VR session in real time
- Pure Data integration — every hit sends OSC with instrument name, velocity, and 3D position

## Setup

```bash
npm run install:all   # install all dependencies
npm start             # start frontend (port 5173) and bridge server (port 3000)
```

Open `https://localhost:5173` on PC (spectator view).  
Open `https://<PC-IP>:5173` on the Pico 4 browser, accept the certificate, click **Enter VR**.

For Pure Data audio output, open `pd/drumset.pd` in Pure Data and enable DSP (Audio on).

## Controls

- **Swing controllers** — hit the drums physically
- **Right trigger** — bass drum pedal
- **Left trigger** — hi-hat pedal
- **Point + trigger** — raycast hit for instruments out of reach
