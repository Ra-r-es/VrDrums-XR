// ============================================================
// MR Drumset - Mixed Reality Percussion Instrument
// ============================================================
// Architecture overview:
//   - Three.js scene with aesthetic 3D instruments
//   - WebXR VR mode for Pico 4 headset
//   - Socket.IO for bridge server (OSC to Pure Data)
//   - Spectator mirror: desktop browser shows VR user's view
//   - Particle system for visual hit feedback
//   - Web Audio API for internal sound synthesis
//
// Interaction modes:
//   1. Physical collision - swing stick into instrument
//   2. Raycasting - point ray at instrument + pull trigger
//   3. Foot pedals - trigger with no ray target (R=bass, L=hihat)
// ============================================================

import eruda from 'eruda';
eruda.init();

import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { io } from 'socket.io-client';

// ============================================================
// NETWORK
// Socket.IO emit() is non-blocking by design, queues message
// and returns immediately. No Web Worker needed.
// ============================================================
const socket = io();
socket.on('connect', () => {
    console.log('[Net] Connected to bridge');
    setStatus('conn', true);
});
socket.on('disconnect', () => {
    console.log('[Net] Disconnected');
    setStatus('conn', false);
});

// ============================================================
// RENDERER & SCENE
// ============================================================
const BG_COLOR = 0x060612;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);
scene.fog = new THREE.FogExp2(BG_COLOR, 0.12);

// Main camera: used for spectator view and before VR starts
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 50);
camera.position.set(0, 1.6, 1.0);
camera.lookAt(0, 0.7, -0.4);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); // Cap at 2x for Pico perf
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// ============================================================
// LIGHTING
// Warm main + cool/warm accents for dramatic contrast
// ============================================================
scene.add(new THREE.AmbientLight(0x1a1a30, 0.4));

const mainLight = new THREE.PointLight(0xffaa55, 2.0, 8);
mainLight.position.set(0, 2.5, -0.3);
scene.add(mainLight);

const blueAccent = new THREE.PointLight(0x4488ff, 1.0, 6);
blueAccent.position.set(-1.5, 1.5, -0.5);
scene.add(blueAccent);

const redAccent = new THREE.PointLight(0xff4444, 1.0, 6);
redAccent.position.set(1.5, 1.5, -0.5);
scene.add(redAccent);

// Rim light from behind for silhouette depth
const rimLight = new THREE.PointLight(0x8844ff, 1.5, 5);
rimLight.position.set(0, 1, -2);
scene.add(rimLight);

// ============================================================
// ENVIRONMENT
// ============================================================
// Circular platform under instruments
const platformGeo = new THREE.RingGeometry(0.1, 1.3, 64);
platformGeo.rotateX(-Math.PI / 2);
const platform = new THREE.Mesh(platformGeo, new THREE.MeshStandardMaterial({
    color: 0x0a0a20, metalness: 0.9, roughness: 0.2,
    transparent: true, opacity: 0.5
}));
platform.position.y = 0.005;
scene.add(platform);

// Polar grid for spatial reference
const grid = new THREE.PolarGridHelper(1.5, 8, 3, 32, 0x222244, 0x222244);
grid.position.y = 0.01;
scene.add(grid);

// Ambient floating dust for atmosphere
const AMB_COUNT = 80;
const ambPos = new Float32Array(AMB_COUNT * 3);
for (let i = 0; i < AMB_COUNT; i++) {
    ambPos[i * 3]     = (Math.random() - 0.5) * 3;
    ambPos[i * 3 + 1] = Math.random() * 2.5;
    ambPos[i * 3 + 2] = (Math.random() - 0.5) * 3 - 0.5;
}
const ambGeo = new THREE.BufferGeometry();
ambGeo.setAttribute('position', new THREE.BufferAttribute(ambPos, 3));
const ambientDust = new THREE.Points(ambGeo, new THREE.PointsMaterial({
    size: 0.008, color: 0x4466aa, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false
}));
ambientDust.frustumCulled = false;
scene.add(ambientDust);

// ============================================================
// INSTRUMENTS
// Aesthetic 3D shapes with MeshStandardMaterial (PBR)
// Layout matches a real drumset from player perspective
// ============================================================
const instruments = [];

const DEFS = [
    //        name        label        geometry factory                                             position              rotation             color      emissive   hitColor   met  rou  hitRadius
    { name: 'hihat',    label: 'Hi-Hat',    geo: () => new THREE.TorusGeometry(0.14, 0.015, 12, 48),        pos: [-0.35,0.85,-0.40], rot: [Math.PI/2,0,0], col: 0xd4aa00, emi: 0x201500, hit: 0xffee88, met: 0.95, rou: 0.05, hr: 0.18 },
    { name: 'snare',    label: 'Snare',     geo: () => new THREE.OctahedronGeometry(0.12, 2),               pos: [-0.10,0.72,-0.40], rot: [0,0,0],         col: 0xccccdd, emi: 0x151518, hit: 0xffffff, met: 0.8,  rou: 0.15, hr: 0.16 },
    { name: 'hitom',    label: 'Hi-Tom',    geo: () => new THREE.IcosahedronGeometry(0.10, 1),              pos: [-0.12,0.90,-0.55], rot: [0,0,0],         col: 0x22bbdd, emi: 0x082028, hit: 0x88eeff, met: 0.7,  rou: 0.2,  hr: 0.14 },
    { name: 'medtom',   label: 'Med-Tom',   geo: () => new THREE.IcosahedronGeometry(0.12, 1),              pos: [0.15, 0.88,-0.55], rot: [0,0,0],         col: 0x2288bb, emi: 0x081520, hit: 0x66ddee, met: 0.7,  rou: 0.2,  hr: 0.16 },
    { name: 'floortom', label: 'Floor Tom', geo: () => new THREE.DodecahedronGeometry(0.16, 1),             pos: [0.42, 0.55,-0.35], rot: [0,0,0],         col: 0x2244cc, emi: 0x080830, hit: 0x88aaff, met: 0.6,  rou: 0.3,  hr: 0.22 },
    { name: 'crash',    label: 'Crash',     geo: () => new THREE.TorusKnotGeometry(0.12, 0.02, 64, 8, 2,3),pos: [-0.45,1.20,-0.55], rot: [0,0,0],         col: 0xeebb00, emi: 0x281800, hit: 0xffdd44, met: 0.9,  rou: 0.1,  hr: 0.20 },
    { name: 'ride',     label: 'Ride',      geo: () => new THREE.TorusGeometry(0.20, 0.018, 12, 48),       pos: [0.50, 1.10,-0.55], rot: [Math.PI/2,0,0], col: 0xbbaa44, emi: 0x181200, hit: 0xffdd88, met: 0.95, rou: 0.05, hr: 0.25 },
    { name: 'bassdrum', label: 'Bass',      geo: () => new THREE.SphereGeometry(0.20, 32, 16),             pos: [0.00, 0.22,-0.50], rot: [0,0,0],         col: 0x991133, emi: 0x180508, hit: 0xff4466, met: 0.5,  rou: 0.4,  hr: 0.25 },
];

DEFS.forEach(d => {
    const mat = new THREE.MeshStandardMaterial({
        color: d.col, emissive: d.emi, emissiveIntensity: 0.3,
        metalness: d.met, roughness: d.rou
    });
    const mesh = new THREE.Mesh(d.geo(), mat);
    mesh.position.set(...d.pos);
    mesh.rotation.set(...d.rot);
    scene.add(mesh);

    // Ground glow disc under each instrument
    const glowGeo = new THREE.CircleGeometry(d.hr * 0.7, 32);
    glowGeo.rotateX(-Math.PI / 2);
    const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
        color: d.col, transparent: true, opacity: 0.12,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
    glow.position.set(d.pos[0], 0.015, d.pos[2]);
    scene.add(glow);

    instruments.push({
        name: d.name, label: d.label, mesh, glow,
        basePos: new THREE.Vector3(...d.pos),
        baseEmissive: new THREE.Color(d.emi),
        hitColor: new THREE.Color(d.hit),
        color: new THREE.Color(d.col),
        hitRadius: d.hr,
        hitTimer: 0, hitVel: 0
    });
});

// ============================================================
// PARTICLE SYSTEM (hit explosions)
// Pre-allocated ring buffer for performance.
// Dead particles have size=0 so GPU skips them.
// ============================================================
const P_MAX = 300;
const pPos  = new Float32Array(P_MAX * 3);
const pCol  = new Float32Array(P_MAX * 3);
const pSiz  = new Float32Array(P_MAX);
const pVel  = new Float32Array(P_MAX * 3);
const pLife = new Float32Array(P_MAX);
pSiz.fill(0);

const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color',    new THREE.BufferAttribute(pCol, 3));
pGeo.setAttribute('size',     new THREE.Float32BufferAttribute(pSiz, 1));

const particlePoints = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.025, vertexColors: true, transparent: true, opacity: 0.9,
    sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false
}));
particlePoints.frustumCulled = false;
scene.add(particlePoints);

let pNext = 0;

function emitParticles(pos, color, count) {
    for (let n = 0; n < count; n++) {
        const i  = pNext;
        pNext = (pNext + 1) % P_MAX;
        const i3 = i * 3;

        // Spawn at instrument position with small jitter
        pPos[i3]     = pos.x + (Math.random() - 0.5) * 0.04;
        pPos[i3 + 1] = pos.y + (Math.random() - 0.5) * 0.04;
        pPos[i3 + 2] = pos.z + (Math.random() - 0.5) * 0.04;

        // Radial explosion with upward bias
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        const sp = 0.3 + Math.random() * 1.0;
        pVel[i3]     = Math.sin(ph) * Math.cos(th) * sp;
        pVel[i3 + 1] = Math.abs(Math.sin(ph) * Math.sin(th)) * sp + 0.4;
        pVel[i3 + 2] = Math.cos(ph) * sp;

        // Color with slight variation for natural look
        pCol[i3]     = Math.min(1, color.r + (Math.random() - 0.5) * 0.25);
        pCol[i3 + 1] = Math.min(1, color.g + (Math.random() - 0.5) * 0.25);
        pCol[i3 + 2] = Math.min(1, color.b + (Math.random() - 0.5) * 0.25);

        pSiz[i]  = 0.012 + Math.random() * 0.02;
        pLife[i] = 0.4 + Math.random() * 0.5;
    }
}

function tickParticles(dt) {
    for (let i = 0; i < P_MAX; i++) {
        if (pLife[i] <= 0) continue;
        pLife[i] -= dt;
        if (pLife[i] <= 0) { pSiz[i] = 0; continue; }
        const i3 = i * 3;
        pPos[i3]     += pVel[i3] * dt;
        pPos[i3 + 1] += pVel[i3 + 1] * dt;
        pPos[i3 + 2] += pVel[i3 + 2] * dt;
        pVel[i3 + 1] -= 3.0 * dt; // Gravity
        pSiz[i] *= (1 - dt * 2.5); // Shrink
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.size.needsUpdate     = true;
    pGeo.attributes.color.needsUpdate    = true;
}

// ============================================================
// AUDIO SYNTHESIS
// Procedural drum sounds using oscillators + filtered noise
// ============================================================
let audioCtx;

function playSound(name) {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch { return; }

    const t = audioCtx.currentTime;
    let freq = 0, endFreq = 0.01, decay = 0;
    let useNoise = false, nFreq = 1000, nDecay = 0.1, vol = 1.0;

    switch (name) {
        case 'bassdrum':  freq = 100; endFreq = 0.05; decay = 1.0; vol = 1.5; break;
        case 'snare':     freq = 150; endFreq = 0.01; decay = 0.1; vol = 1.2;
                          useNoise = true; nFreq = 1000; nDecay = 0.15; break;
        case 'hihat':     useNoise = true; nFreq = 5000; nDecay = 0.1; vol = 0.5; break;
        case 'hitom':     freq = 250; endFreq = 0.01; decay = 0.3; vol = 1.2; break;
        case 'medtom':    freq = 200; endFreq = 0.01; decay = 0.35; vol = 1.2; break;
        case 'floortom':  freq = 100; endFreq = 0.01; decay = 0.5; vol = 1.2; break;
        case 'crash':     useNoise = true; nFreq = 3000; nDecay = 1.0; vol = 0.8; break;
        case 'ride':      useNoise = true; nFreq = 4000; nDecay = 1.5; vol = 0.8; break;
    }

    // Tonal component (sine sweep)
    if (freq > 0) {
        const osc = audioCtx.createOscillator();
        const g   = audioCtx.createGain();
        osc.connect(g).connect(audioCtx.destination);
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(endFreq, t + decay);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + decay);
        osc.start(t);
        osc.stop(t + decay);
    }

    // Noise component (percussive transient)
    if (useNoise) {
        const len = Math.floor(audioCtx.sampleRate * nDecay);
        const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        const flt = audioCtx.createBiquadFilter();
        flt.type = name === 'bassdrum' ? 'lowpass' : 'highpass';
        flt.frequency.value = nFreq;
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0.5 * vol, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + nDecay);
        src.connect(flt).connect(g).connect(audioCtx.destination);
        src.start(t);
    }
}

// ============================================================
// HIT SYSTEM
// Central hit handler: visual feedback, particles, audio, network
// ============================================================
const COOLDOWN = 120; // ms between hits on same instrument
const hitTimes = {};

function hitInstrument(instr, velocity) {
    if (!instr) return;
    const now = performance.now();
    // Prevent multiple triggers per frame using cooldown
    if (now - (hitTimes[instr.name] || 0) < COOLDOWN) return;
    hitTimes[instr.name] = now;

    const v = Math.min(1, velocity);

    // Flash emissive + scale pop
    instr.hitTimer = 0.3;
    instr.hitVel   = v;
    instr.mesh.material.emissive.copy(instr.hitColor);
    instr.mesh.material.emissiveIntensity = 2 + v * 3;
    const s = 1 + 0.25 * v;
    instr.mesh.scale.set(s, s, s);
    if (instr.glow) instr.glow.material.opacity = 0.5;

    // Particle burst
    emitParticles(instr.mesh.position, instr.hitColor, Math.floor(12 + 18 * v));

    // Internal audio
    playSound(instr.name);

    // Send to bridge for Pure Data (OSC)
    // Format matches Pd patch expectations: instrument, velocity, xyz
    socket.emit('drumHit', {
        instrument: instr.name,
        velocity: v,
        x: instr.basePos.x,
        y: instr.basePos.y,
        z: instr.basePos.z
    });

    console.log(`[Hit] ${instr.label} v=${v.toFixed(2)}`);
}

// Smooth decay animation back to idle state
function tickHitAnims(dt) {
    instruments.forEach(instr => {
        if (instr.hitTimer <= 0) return;
        instr.hitTimer -= dt;
        const t = Math.max(0, instr.hitTimer / 0.3); // 1 -> 0

        // Ease-out scale
        const s = 1 + 0.25 * instr.hitVel * t * t;
        instr.mesh.scale.set(s, s, s);
        // Fade emissive
        instr.mesh.material.emissiveIntensity = 0.3 + (2 + instr.hitVel * 3) * t;
        if (instr.glow) instr.glow.material.opacity = 0.12 + 0.38 * t;

        if (instr.hitTimer <= 0) {
            instr.mesh.material.emissive.copy(instr.baseEmissive);
            instr.mesh.material.emissiveIntensity = 0.3;
            instr.mesh.scale.set(1, 1, 1);
            if (instr.glow) instr.glow.material.opacity = 0.12;
        }
    });
}

// Gentle idle float + rotation + emissive pulse
function tickIdleAnims(time) {
    instruments.forEach((instr, i) => {
        if (instr.hitTimer > 0) return;
        instr.mesh.position.y = instr.basePos.y + Math.sin(time * 0.6 + i * 1.3) * 0.006;
        instr.mesh.rotation.y += 0.002;
        instr.mesh.material.emissiveIntensity = 0.2 + Math.sin(time * 1.5 + i * 0.8) * 0.08;
    });
}

// ============================================================
// XR CONTROLLERS
// Each controller has: drumstick, collision tip, ray line
// ============================================================
document.body.appendChild(VRButton.createButton(renderer, {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
}));

const controllers = [];
const raycaster   = new THREE.Raycaster();
const tmpMat      = new THREE.Matrix4();

// Drumstick geometry: cylinder shifted so base is at controller origin
const stickGeo = new THREE.CylinderGeometry(0.008, 0.012, 0.35, 8);
stickGeo.translate(0, 0.175, 0);
const stickMat = new THREE.MeshStandardMaterial({
    color: 0x885522, roughness: 0.6, metalness: 0.2
});

// Rounded tip at end of stick for collision reference
const tipGeo = new THREE.SphereGeometry(0.015, 8, 6);
const tipMat = new THREE.MeshStandardMaterial({
    color: 0xddccaa, roughness: 0.3, metalness: 0.5
});

for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    scene.add(ctrl);

    // Drumstick mesh, rotated to point along controller's -Z
    const stick = new THREE.Mesh(stickGeo, stickMat);
    stick.rotation.x = -Math.PI / 2;
    ctrl.add(stick);

    // Tip at end of stick (z = -0.35 in controller space)
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.set(0, 0, -0.35);
    ctrl.add(tip);

    // Ray line for pointing interaction
    const rayGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -2.5)
    ]);
    const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({
        color: 0x4488ff, transparent: true, opacity: 0.3
    }));
    ctrl.add(ray);

    const state = {
        group: ctrl, tip, ray,
        insideDrums: new Set(),
        prevTipY: null,
        targeted: null,
        isSelecting: false
    };
    controllers.push(state);

    ctrl.addEventListener('connected', e => {
        ctrl.userData.handedness = e.data.handedness;
    });

    // Trigger press: ray-hit targeted instrument, or foot pedal
    ctrl.addEventListener('selectstart', () => {
        state.isSelecting = true;
        if (state.targeted) {
            hitInstrument(state.targeted, 0.9);
            haptic(state, 0.5, 50);
        } else {
            // No ray target -> foot pedal (right=bass, left=hihat)
            const pedal = ctrl.userData.handedness === 'right' ? 'bassdrum' : 'hihat';
            hitInstrument(instruments.find(d => d.name === pedal), 0.9);
            haptic(state, 0.3, 30);
        }
    });

    ctrl.addEventListener('selectend', () => { state.isSelecting = false; });
}

// ============================================================
// HAPTIC FEEDBACK
// Small vibration pulse on impact for tactile response
// ============================================================
function haptic(ctrl, intensity, ms) {
    try {
        const session = renderer.xr.getSession();
        if (!session) return;
        for (const src of session.inputSources) {
            if (src.handedness === ctrl.group.userData.handedness && src.gamepad) {
                const ha = src.gamepad.hapticActuators;
                if (ha && ha[0]) ha[0].pulse(intensity, ms);
            }
        }
    } catch { /* haptics unsupported on this device */ }
}

// ============================================================
// COLLISION DETECTION & RAYCASTING
// Two interaction methods run in parallel each frame:
//   1. Physical: stick tip enters instrument bounding sphere
//      while moving downward (natural drumming motion)
//   2. Ray: visible ray from controller intersects instrument
//      mesh, highlighted in orange when targeted
// ============================================================
const tipWorld = new THREE.Vector3();
const instrumentMeshes = instruments.map(inst => inst.mesh);

function tickCollision(dt) {
    controllers.forEach(ctrl => {
        if (!ctrl.group.visible) return;

        // --- Physical collision ---
        ctrl.tip.getWorldPosition(tipWorld);
        const curY = tipWorld.y;

        instruments.forEach(instr => {
            const dist = tipWorld.distanceTo(instr.mesh.position);
            if (dist < instr.hitRadius) {
                if (!ctrl.insideDrums.has(instr.name)) {
                    // Just entered bounding sphere - check downward motion
                    if (ctrl.prevTipY !== null && ctrl.prevTipY > curY) {
                        // Velocity: displacement/time, scaled to 0-1 range
                        const vel = Math.min(1, Math.abs(ctrl.prevTipY - curY) / Math.max(dt, 0.001) / 2);
                        hitInstrument(instr, vel);
                        haptic(ctrl, Math.min(1, vel), 40);
                    }
                    ctrl.insideDrums.add(instr.name);
                }
            } else {
                ctrl.insideDrums.delete(instr.name);
            }
        });

        ctrl.prevTipY = curY;

        // --- Raycasting ---
        tmpMat.identity().extractRotation(ctrl.group.matrixWorld);
        raycaster.ray.origin.setFromMatrixPosition(ctrl.group.matrixWorld);
        raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMat);
        raycaster.far = 3;

        const hits = raycaster.intersectObjects(instrumentMeshes);
        if (hits.length > 0) {
            ctrl.ray.material.color.setHex(0xff8844);
            ctrl.ray.material.opacity = 0.7;
            ctrl.targeted = instruments.find(inst => inst.mesh === hits[0].object);
        } else {
            ctrl.ray.material.color.setHex(0x4488ff);
            ctrl.ray.material.opacity = 0.3;
            ctrl.targeted = null;
        }
    });
}

// ============================================================
// SPECTATOR MIRROR SYSTEM
// Desktop browser shows what the VR user sees in real-time.
//
// How it works:
//   - VR client (Pico) sends camera pose + controller poses
//     via Socket.IO at ~36fps
//   - Spectator (PC browser) receives poses and updates its
//     local camera/ghost controllers to match
//   - Both render the same Three.js scene, so spectator sees
//     an accurate mirror of the VR experience
// ============================================================
let isSpectator = true;

// Status overlay for debugging
const overlay = document.createElement('div');
overlay.innerHTML = `<div style="position:fixed;top:10px;left:10px;color:#aaa;font-family:monospace;
font-size:12px;background:rgba(0,0,0,0.75);padding:8px 14px;border-radius:6px;
border:1px solid #333;z-index:1000;pointer-events:none;line-height:1.6">
<div id="st-conn">Connecting...</div>
<div id="st-xr">Spectator Mode</div>
<div id="st-fps">FPS: --</div></div>`;
document.body.appendChild(overlay);

function setStatus(key, val) {
    const el = document.getElementById('st-' + key);
    if (!el) return;
    if (key === 'conn') {
        el.textContent = val ? 'Bridge Connected' : 'Disconnected';
        el.style.color = val ? '#4f4' : '#f44';
    }
    if (key === 'xr')  el.textContent = val;
    if (key === 'fps') el.textContent = 'FPS: ' + val;
}

// Ghost controllers rendered on spectator to show VR user's hands
const ghosts = [];
for (let g = 0; g < 2; g++) {
    const group = new THREE.Group();
    const gs = new THREE.Mesh(stickGeo.clone(),
        new THREE.MeshStandardMaterial({ color: 0x44aaff, transparent: true, opacity: 0.5 }));
    gs.rotation.x = -Math.PI / 2;
    group.add(gs);
    const gt = new THREE.Mesh(tipGeo.clone(),
        new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.5 }));
    gt.position.set(0, 0, -0.35);
    group.add(gt);
    group.visible = false;
    scene.add(group);
    ghosts.push(group);
}

// VR session lifecycle
renderer.xr.addEventListener('sessionstart', () => {
    isSpectator = false;
    // Transparent background in VR for passthrough compatibility
    scene.background = null;
    scene.fog = null;
    socket.emit('xrSessionStart');
    setStatus('xr', 'VR Active');
});

renderer.xr.addEventListener('sessionend', () => {
    isSpectator = true;
    scene.background = new THREE.Color(BG_COLOR);
    scene.fog = new THREE.FogExp2(BG_COLOR, 0.12);
    setStatus('xr', 'Spectator Mode');
});

// VR client sends pose data each frame (throttled)
let poseFrame = 0;
function sendPose() {
    if (isSpectator || !renderer.xr.isPresenting) return;
    if (++poseFrame % 2) return; // ~36fps at 72Hz headset refresh

    const xrCam = renderer.xr.getCamera();
    // volatile = drop if socket can't keep up (prevents latency buildup)
    socket.volatile.emit('xrPose', {
        cam: {
            px: xrCam.position.x, py: xrCam.position.y, pz: xrCam.position.z,
            qx: xrCam.quaternion.x, qy: xrCam.quaternion.y,
            qz: xrCam.quaternion.z, qw: xrCam.quaternion.w
        },
        ctrl: controllers.map(c => ({
            px: c.group.position.x, py: c.group.position.y, pz: c.group.position.z,
            qx: c.group.quaternion.x, qy: c.group.quaternion.y,
            qz: c.group.quaternion.z, qw: c.group.quaternion.w,
            vis: c.group.visible
        }))
    });
}

// Spectator receives VR camera + controller poses
socket.on('xrPose', data => {
    if (!isSpectator) return;
    camera.position.set(data.cam.px, data.cam.py, data.cam.pz);
    camera.quaternion.set(data.cam.qx, data.cam.qy, data.cam.qz, data.cam.qw);
    data.ctrl.forEach((c, i) => {
        if (i >= ghosts.length) return;
        ghosts[i].position.set(c.px, c.py, c.pz);
        ghosts[i].quaternion.set(c.qx, c.qy, c.qz, c.qw);
        ghosts[i].visible = c.vis;
    });
    setStatus('xr', 'Mirror Active');
});

// Spectator receives hit feedback (visual only, audio on VR side)
socket.on('drumHitFeedback', data => {
    if (!isSpectator) return;
    const instr = instruments.find(inst => inst.name === data.instrument);
    if (!instr) return;
    const v = data.velocity || 0.8;
    instr.hitTimer = 0.3;
    instr.hitVel = v;
    instr.mesh.material.emissive.copy(instr.hitColor);
    instr.mesh.material.emissiveIntensity = 2 + v * 3;
    const s = 1 + 0.25 * v;
    instr.mesh.scale.set(s, s, s);
    if (instr.glow) instr.glow.material.opacity = 0.5;
    emitParticles(instr.mesh.position, instr.hitColor, Math.floor(12 + 18 * v));
});

// VR session ended remotely
socket.on('xrSessionEnd', () => {
    if (!isSpectator) return;
    // Reset camera to default spectator view
    camera.position.set(0, 1.6, 1.0);
    camera.lookAt(0, 0.7, -0.4);
    ghosts.forEach(g => { g.visible = false; });
    setStatus('xr', 'Spectator Mode');
});

// ============================================================
// RENDER LOOP
// ============================================================
const clock = new THREE.Clock();
let frames = 0, lastFpsT = 0;

function render() {
    const dt = clock.getDelta();
    const elapsed = clock.getElapsedTime();

    // FPS counter (update once per second)
    frames++;
    if (elapsed - lastFpsT >= 1) {
        setStatus('fps', Math.round(frames / (elapsed - lastFpsT)));
        frames = 0;
        lastFpsT = elapsed;
    }

    // Update animations
    tickIdleAnims(elapsed);
    tickHitAnims(dt);
    tickParticles(dt);
    ambientDust.rotation.y = elapsed * 0.03;

    // XR-specific updates (only on VR device)
    if (renderer.xr.isPresenting && !isSpectator) {
        tickCollision(dt);
    }

    // Main render pass (renders to XR headset if presenting)
    renderer.render(scene, camera);

    // Send pose data AFTER render (XR camera matrices are now valid)
    if (renderer.xr.isPresenting && !isSpectator) {
        sendPose();
    }
}

renderer.setAnimationLoop(render);

// ============================================================
// WINDOW RESIZE
// ============================================================
window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});
