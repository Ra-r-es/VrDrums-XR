// ============================================================
// MR Drumset - Mixed Reality Percussion Instrument
// ============================================================
// Architecture overview:
//   - Three.js scene with realistic drum shells and cymbals
//   - WebXR VR mode for Pico 4 headset
//   - Socket.IO for bridge server (OSC to Pure Data)
//   - Spectator mirror: desktop browser shows VR user's view
//   - Swept-plane collision: per-surface normal + radius, works
//     for horizontal drums and tilted cymbals alike
//   - Contact-point particles, cymbal wobble, drum head flex
//   - Web Audio API with master bus, compressor, stereo pan
// ============================================================

import eruda from 'eruda';
eruda.init();

import * as THREE from 'three';
import { VRButton }        from 'three/examples/jsm/webxr/VRButton.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { io }              from 'socket.io-client';

// ============================================================
// NETWORK
// ============================================================
const socket = io();
socket.on('connect',    () => { console.log('[Net] Connected'); setStatus('conn', true); });
socket.on('disconnect', () => { console.log('[Net] Disconnected'); setStatus('conn', false); });

// ============================================================
// RENDERER & SCENE
// ============================================================
const BG_COLOR = 0x060612;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR);
scene.fog = new THREE.FogExp2(BG_COLOR, 0.12);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 50);
camera.position.set(0, 1.55, 1.0);
camera.lookAt(0, 0.9, -0.5);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// PBR environment lighting — gives cymbals real specular reflections.
// Rendered once at startup; near-zero runtime cost.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ============================================================
// LIGHTING
// Warm main + cool accents. Environment does most specular work.
// ============================================================
scene.add(new THREE.AmbientLight(0x1a1a30, 0.35));

const mainLight = new THREE.PointLight(0xffaa55, 1.6, 8);
mainLight.position.set(0, 2.5, -0.3);
scene.add(mainLight);

const blueAccent = new THREE.PointLight(0x4488ff, 0.9, 6);
blueAccent.position.set(-1.5, 1.5, -0.5);
scene.add(blueAccent);

const redAccent = new THREE.PointLight(0xff4444, 0.9, 6);
redAccent.position.set(1.5, 1.5, -0.5);
scene.add(redAccent);

const rimLight = new THREE.PointLight(0x8844ff, 1.2, 5);
rimLight.position.set(0, 1, -2);
scene.add(rimLight);

// ============================================================
// ENVIRONMENT
// ============================================================
const platformGeo = new THREE.RingGeometry(0.1, 1.4, 64);
platformGeo.rotateX(-Math.PI / 2);
scene.add(new THREE.Mesh(platformGeo, new THREE.MeshStandardMaterial({
    color: 0x0a0a20, metalness: 0.9, roughness: 0.2,
    transparent: true, opacity: 0.5
}))).position.y = 0.005;

const grid = new THREE.PolarGridHelper(1.5, 8, 3, 32, 0x222244, 0x222244);
grid.position.y = 0.01;
scene.add(grid);

// Atmospheric dust
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
// SHARED GEOMETRIES / MATERIALS
// ============================================================
const RIM_TUBE = 0.012;
const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xcccccc, metalness: 1.0, roughness: 0.18
});
const matteMat  = new THREE.MeshStandardMaterial({
    color: 0x222228, metalness: 0.4, roughness: 0.7
});

// Thin stand pole used under cymbals / snare.
function makeStand(height) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.012, height, 10),
        chromeMat
    );
    pole.position.y = height * 0.5;
    g.add(pole);
    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.14, 0.02, 20),
        matteMat
    );
    base.position.y = 0.01;
    g.add(base);
    return g;
}

// Tensioning lugs around a drum shell. `n` lugs at radius `r`, height `h`.
function addLugs(group, n, r, h) {
    const lugGeo = new THREE.BoxGeometry(0.02, h * 0.6, 0.016);
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const m = new THREE.Mesh(lugGeo, chromeMat);
        m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        m.lookAt(0, m.position.y, 0);
        group.add(m);
    }
}

// ============================================================
// INSTRUMENT FACTORIES
// Each builder returns:
//   { group, hitMesh, localHitCenter, localHitNormal, hitRadius,
//     head?  — optional head mesh for compression flex
//     bow?   — optional cymbal mesh for wobble rotation }
// localHit{Center,Normal} are in group space; transformed to
// world every frame by the collision system.
// ============================================================

// Cylindrical drum with head on top, tilt-able forward.
// `tilt` rotates the whole drum forward (toward player) in radians.
function buildDrumTop({ radius, height, shellColor, headColor, tiltX = 0, lugs = 6 }) {
    const group = new THREE.Group();

    // Tilt mount — a child group holds drum so the whole thing angles
    const body = new THREE.Group();
    body.rotation.x = tiltX;
    group.add(body);

    // Shell: wood/lacquer
    const shell = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, height, 32, 1, true),
        new THREE.MeshStandardMaterial({
            color: shellColor, metalness: 0.25, roughness: 0.45, side: THREE.DoubleSide
        })
    );
    shell.position.y = 0;
    body.add(shell);

    // Top rim (hoop)
    const topRim = new THREE.Mesh(
        new THREE.TorusGeometry(radius + 0.002, RIM_TUBE, 10, 48),
        chromeMat
    );
    topRim.rotation.x = Math.PI / 2;
    topRim.position.y = height * 0.5;
    body.add(topRim);

    // Bottom rim
    const botRim = topRim.clone();
    botRim.position.y = -height * 0.5;
    body.add(botRim);

    // Drumhead (disc) — this is what we visually flex on hit
    const headGeo = new THREE.CircleGeometry(radius - 0.003, 48);
    headGeo.rotateX(-Math.PI / 2);
    const head = new THREE.Mesh(headGeo, new THREE.MeshStandardMaterial({
        color: headColor, metalness: 0.1, roughness: 0.35,
        emissive: 0x000000, emissiveIntensity: 0
    }));
    head.position.y = height * 0.5 + 0.0005;
    body.add(head);

    // Lugs around shell
    const lugGroup = new THREE.Group();
    addLugs(lugGroup, lugs, radius + 0.005, height);
    body.add(lugGroup);

    // Hit plane is the top head. In `body` local space it sits at
    // y = height/2 with normal +Y. We need it in `group` local space,
    // so bake the tilt transform: a tilt around X rotates normal & center.
    body.updateMatrix();
    const localCenter = new THREE.Vector3(0, height * 0.5 + 0.0005, 0).applyMatrix4(body.matrix);
    const localNormal = new THREE.Vector3(0, 1, 0).transformDirection(body.matrix);

    return {
        group, body, head, hitMesh: head,
        localHitCenter: localCenter,
        localHitNormal: localNormal,
        hitRadius: radius - 0.01
    };
}

// Bass drum — cylinder lying on its side, front head facing +Z (toward player).
function buildBassDrum({ radius, length, shellColor, headColor }) {
    const group = new THREE.Group();

    const body = new THREE.Group();
    // Lay cylinder on its side (axis along Z) by rotating around X
    body.rotation.x = Math.PI / 2;
    group.add(body);

    const shell = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, length, 40, 1, true),
        new THREE.MeshStandardMaterial({
            color: shellColor, metalness: 0.35, roughness: 0.4, side: THREE.DoubleSide
        })
    );
    body.add(shell);

    // Two rims (front/back of cylinder, i.e. ±Y in body space)
    for (const y of [-length * 0.5, length * 0.5]) {
        const rim = new THREE.Mesh(
            new THREE.TorusGeometry(radius + 0.002, RIM_TUBE * 1.2, 10, 56),
            chromeMat
        );
        rim.rotation.x = Math.PI / 2;
        rim.position.y = y;
        body.add(rim);
    }

    // Front head (the one player strikes) — must face +Z in world.
    // body rotated +π/2 around X maps local +Y → world +Z, so front = +Y
    const headGeo = new THREE.CircleGeometry(radius - 0.004, 48);
    headGeo.rotateX(-Math.PI / 2);
    const head = new THREE.Mesh(headGeo, new THREE.MeshStandardMaterial({
        color: headColor, metalness: 0.15, roughness: 0.35
    }));
    head.position.y = length * 0.5 + 0.0005;
    body.add(head);

    // Lugs around shell
    addLugs(body, 10, radius + 0.006, length);

    body.updateMatrix();
    const localCenter = new THREE.Vector3(0, length * 0.5 + 0.0005, 0).applyMatrix4(body.matrix);
    const localNormal = new THREE.Vector3(0, 1, 0).transformDirection(body.matrix);

    // Legs (feet) so the drum doesn't float
    const legGeo = new THREE.CylinderGeometry(0.01, 0.01, radius * 0.8, 8);
    for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, matteMat);
        leg.position.set(sx * radius * 0.85, -radius * 0.4, 0);
        leg.rotation.z = sx * 0.35;
        group.add(leg);
    }

    return {
        group, body, head, hitMesh: head,
        localHitCenter: localCenter,
        localHitNormal: localNormal,
        hitRadius: radius - 0.02
    };
}

// Cymbal — thin tapered disc with small bell at center. Tilts optional.
// `tiltX` nods forward, `tiltZ` rolls sideways.
function buildCymbal({ radius, bellRadius, color, tiltX = 0, tiltZ = 0 }) {
    const group = new THREE.Group();

    // Bow — the big disc, we wobble this on hit.
    // Store base quaternion so wobble can compose on top of the tilt
    // without overwriting it.
    const bow = new THREE.Group();
    bow.rotation.x = tiltX;
    bow.rotation.z = tiltZ;
    bow.updateMatrix();
    bow.userData.baseQuat = bow.quaternion.clone();
    group.add(bow);

    // Main disc — very slight cone gives realistic bow profile
    const discGeo = new THREE.CylinderGeometry(radius, radius * 0.98, 0.004, 64, 1);
    const cymbalMat = new THREE.MeshStandardMaterial({
        color, metalness: 1.0, roughness: 0.28,
        emissive: 0x000000, emissiveIntensity: 0
    });
    const disc = new THREE.Mesh(discGeo, cymbalMat);
    bow.add(disc);

    // Bell (dome) in center
    const bell = new THREE.Mesh(
        new THREE.SphereGeometry(bellRadius, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.45),
        cymbalMat
    );
    bell.position.y = 0.006;
    bow.add(bell);

    bow.updateMatrix();
    const localCenter = new THREE.Vector3(0, 0.002, 0).applyMatrix4(bow.matrix);
    const localNormal = new THREE.Vector3(0, 1, 0).transformDirection(bow.matrix);

    return {
        group, bow, hitMesh: disc,
        localHitCenter: localCenter,
        localHitNormal: localNormal,
        hitRadius: radius - 0.01
    };
}

// Hi-hat: two cymbals with a small gap. Hit top one.
function buildHiHat({ radius, color }) {
    const group = new THREE.Group();
    const top = buildCymbal({ radius, bellRadius: 0.025, color });
    const bot = buildCymbal({ radius, bellRadius: 0.025, color });
    bot.group.position.y = -0.04;
    bot.group.rotation.x = Math.PI; // inverted
    group.add(top.group);
    group.add(bot.group);

    return {
        group, bow: top.bow, hitMesh: top.hitMesh,
        localHitCenter: top.localHitCenter,
        localHitNormal: top.localHitNormal,
        hitRadius: top.hitRadius
    };
}

// ============================================================
// INSTRUMENT DEFINITIONS
// Laid out as a real drumset from player's viewpoint (facing -Z):
//   Bass drum front-center on floor
//   Snare slightly left of center at waist
//   Two rack toms mounted over bass
//   Floor tom right side
//   Hi-hat left, crash upper-left, ride upper-right
// ============================================================
const instruments = [];

const DEFS = [
    {
        name: 'bassdrum', label: 'Bass Drum',
        pos: [0.00, 0.30, -0.60], stand: null,
        hitColor: 0xff4466, accentCol: 0x991133,
        build: () => buildBassDrum({
            radius: 0.26, length: 0.36,
            shellColor: 0x551122, headColor: 0xeeeeee
        })
    },
    {
        name: 'snare', label: 'Snare',
        pos: [-0.10, 0.85, -0.30], stand: 0.85,
        hitColor: 0xffffff, accentCol: 0xd8d8e0,
        build: () => buildDrumTop({
            radius: 0.17, height: 0.12,
            shellColor: 0x8899aa, headColor: 0xf8f8f8,
            tiltX: 0.08, lugs: 8
        })
    },
    {
        name: 'hitom', label: 'Hi Tom',
        pos: [-0.16, 1.05, -0.70], stand: null,
        hitColor: 0x88eeff, accentCol: 0x226688,
        build: () => buildDrumTop({
            radius: 0.11, height: 0.14,
            shellColor: 0x225577, headColor: 0xf0f0f0,
            tiltX: 0.35, lugs: 6
        })
    },
    {
        name: 'medtom', label: 'Med Tom',
        pos: [0.16, 1.05, -0.70], stand: null,
        hitColor: 0x66ddee, accentCol: 0x1f6080,
        build: () => buildDrumTop({
            radius: 0.13, height: 0.16,
            shellColor: 0x1c4a6a, headColor: 0xf0f0f0,
            tiltX: 0.35, lugs: 6
        })
    },
    {
        name: 'floortom', label: 'Floor Tom',
        pos: [0.55, 0.60, -0.50], stand: null,
        hitColor: 0x88aaff, accentCol: 0x223388,
        build: () => buildDrumTop({
            radius: 0.18, height: 0.22,
            shellColor: 0x19366e, headColor: 0xf0f0f0,
            tiltX: 0.04, lugs: 8
        })
    },
    {
        name: 'hihat', label: 'Hi-Hat',
        pos: [-0.55, 0.90, -0.35], stand: 0.90,
        hitColor: 0xffee88, accentCol: 0xbb9922,
        build: () => buildHiHat({ radius: 0.15, color: 0xd4b040 })
    },
    {
        name: 'crash', label: 'Crash',
        pos: [-0.55, 1.30, -0.75], stand: 1.30,
        hitColor: 0xffdd44, accentCol: 0xb88c20,
        build: () => buildCymbal({
            radius: 0.20, bellRadius: 0.028, color: 0xe3b848,
            tiltX: 0.25, tiltZ: 0.18
        })
    },
    {
        name: 'ride', label: 'Ride',
        pos: [0.60, 1.25, -0.70], stand: 1.25,
        hitColor: 0xffdd88, accentCol: 0xb0924a,
        build: () => buildCymbal({
            radius: 0.26, bellRadius: 0.034, color: 0xc6a44a,
            tiltX: 0.18, tiltZ: -0.12
        })
    },
];

DEFS.forEach(d => {
    const built = d.build();
    built.group.position.set(...d.pos);
    scene.add(built.group);

    // Stand pole if applicable
    if (d.stand) {
        const stand = makeStand(d.pos[1]);
        stand.position.set(d.pos[0], 0, d.pos[2]);
        scene.add(stand);
    }

    // Ground glow disc under instrument
    const glowGeo = new THREE.CircleGeometry(built.hitRadius * 1.1, 32);
    glowGeo.rotateX(-Math.PI / 2);
    const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
        color: d.accentCol, transparent: true, opacity: 0.10,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
    glow.position.set(d.pos[0], 0.015, d.pos[2]);
    scene.add(glow);

    instruments.push({
        name: d.name, label: d.label,
        group: built.group,
        body: built.body || null,
        head: built.head || null,
        bow:  built.bow  || null,
        hitMesh: built.hitMesh,
        glow,
        basePos: new THREE.Vector3(...d.pos),
        baseY: d.pos[1],
        localHitCenter: built.localHitCenter,
        localHitNormal: built.localHitNormal,
        hitRadius: built.hitRadius,
        hitColor: new THREE.Color(d.hitColor),
        accentCol: new THREE.Color(d.accentCol),
        // Runtime state
        hitTimer: 0, hitVel: 0,
        wobbleAxis: new THREE.Vector3(1, 0, 0),
        wobbleAngle: 0, wobbleVel: 0,
        flex: 0  // drum head compression
    });
});

// Cached list of raycastable hit meshes for pointer interaction
const instrumentMeshes = instruments.map(i => i.hitMesh);

// ============================================================
// PARTICLE SYSTEM
// Ring buffer, spawned at actual hit-contact point with velocity
// directed along surface normal (and tangentially for spark spray).
// ============================================================
const P_MAX = 400;
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
    size: 0.03, vertexColors: true, transparent: true, opacity: 0.95,
    sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false
}));
particlePoints.frustumCulled = false;
scene.add(particlePoints);

let pNext = 0;
const _tanA = new THREE.Vector3();
const _tanB = new THREE.Vector3();

// Emit a burst at `pos` with dominant direction along `normal`.
function emitBurst(pos, normal, color, count, velocity) {
    // Build two tangent axes perpendicular to normal
    _tanA.set(1, 0, 0);
    if (Math.abs(normal.dot(_tanA)) > 0.9) _tanA.set(0, 1, 0);
    _tanA.crossVectors(normal, _tanA).normalize();
    _tanB.crossVectors(normal, _tanA).normalize();

    for (let n = 0; n < count; n++) {
        const i = pNext;
        pNext = (pNext + 1) % P_MAX;
        const i3 = i * 3;

        // Small positional jitter around contact point
        pPos[i3]     = pos.x + (Math.random() - 0.5) * 0.02;
        pPos[i3 + 1] = pos.y + (Math.random() - 0.5) * 0.02;
        pPos[i3 + 2] = pos.z + (Math.random() - 0.5) * 0.02;

        // Velocity: mostly along normal, splash tangentially
        const radialSpeed   = 0.4 + Math.random() * 1.2 * velocity;
        const normalSpeed   = (0.8 + Math.random() * 1.4) * velocity;
        const ang = Math.random() * Math.PI * 2;
        const rx = Math.cos(ang) * radialSpeed;
        const ry = Math.sin(ang) * radialSpeed;

        pVel[i3]     = normal.x * normalSpeed + _tanA.x * rx + _tanB.x * ry;
        pVel[i3 + 1] = normal.y * normalSpeed + _tanA.y * rx + _tanB.y * ry;
        pVel[i3 + 2] = normal.z * normalSpeed + _tanA.z * rx + _tanB.z * ry;

        pCol[i3]     = Math.min(1, color.r + (Math.random() - 0.5) * 0.25);
        pCol[i3 + 1] = Math.min(1, color.g + (Math.random() - 0.5) * 0.25);
        pCol[i3 + 2] = Math.min(1, color.b + (Math.random() - 0.5) * 0.25);

        pSiz[i]  = 0.014 + Math.random() * 0.02;
        pLife[i] = 0.4 + Math.random() * 0.6;
    }
}

function tickParticles(dt) {
    for (let i = 0; i < P_MAX; i++) {
        if (pLife[i] <= 0) continue;
        pLife[i] -= dt;
        if (pLife[i] <= 0) { pSiz[i] = 0; continue; }
        const i3 = i * 3;
        pPos[i3]     += pVel[i3]     * dt;
        pPos[i3 + 1] += pVel[i3 + 1] * dt;
        pPos[i3 + 2] += pVel[i3 + 2] * dt;
        pVel[i3 + 1] -= 3.0 * dt; // gravity
        // Air drag — makes sparks decelerate naturally
        const drag = 1 - dt * 1.4;
        pVel[i3]     *= drag;
        pVel[i3 + 2] *= drag;
        pSiz[i] *= (1 - dt * 2.2);
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.size.needsUpdate     = true;
    pGeo.attributes.color.needsUpdate    = true;
}

// ============================================================
// AUDIO SYNTHESIS
// Master bus: dryGain -> compressor -> destination.
// Each voice builds on oscillators + filtered noise with stereo pan
// derived from hit X position, and velocity-sensitive filter depth.
// ============================================================
let audioCtx, masterBus, comp;

function ensureAudio() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return; }
    comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value      = 12;
    comp.ratio.value     = 4;
    comp.attack.value    = 0.003;
    comp.release.value   = 0.25;
    masterBus = audioCtx.createGain();
    masterBus.gain.value = 0.8;
    masterBus.connect(comp).connect(audioCtx.destination);
}

// Short filtered noise buffer, reused per voice
function makeNoise(seconds, type, freq, q) {
    const len = Math.max(1, Math.floor(audioCtx.sampleRate * seconds));
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const flt = audioCtx.createBiquadFilter();
    flt.type = type; flt.frequency.value = freq;
    if (q !== undefined) flt.Q.value = q;
    src.connect(flt);
    return { src, flt };
}

function playSound(name, velocity, pan) {
    ensureAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const t = audioCtx.currentTime;
    const v = Math.max(0.05, Math.min(1, velocity));

    const panNode = audioCtx.createStereoPanner();
    panNode.pan.value = Math.max(-1, Math.min(1, pan));
    const voiceGain  = audioCtx.createGain();
    voiceGain.gain.value = 1.0;
    panNode.connect(voiceGain).connect(masterBus);

    const out = panNode;

    // Convenience: add a tonal sweep component
    const addTone = (f0, f1, decay, gain, waveform = 'sine') => {
        const osc = audioCtx.createOscillator();
        const g   = audioCtx.createGain();
        osc.type = waveform;
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(Math.max(0.01, f1), t + decay);
        g.gain.setValueAtTime(gain * v, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + decay);
        osc.connect(g).connect(out);
        osc.start(t); osc.stop(t + decay + 0.02);
    };

    // Convenience: add a filtered noise burst
    const addNoise = (decay, filterType, freq, q, gain) => {
        const { src, flt } = makeNoise(decay, filterType, freq, q);
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(gain * v, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + decay);
        flt.connect(g).connect(out);
        src.start(t); src.stop(t + decay + 0.02);
    };

    switch (name) {
        case 'bassdrum':
            // Subsonic thump + attack click
            addTone(120, 35, 0.45, 1.4, 'sine');
            addTone(60,  30, 0.6,  0.7, 'sine');
            addNoise(0.03, 'lowpass', 2000, 0.8, 0.6);
            break;
        case 'snare':
            // Tonal body + snare wire buzz
            addTone(200, 120, 0.12, 0.6, 'triangle');
            addNoise(0.18, 'bandpass', 1800, 1.5, 1.0);
            addNoise(0.08, 'highpass', 4500, 0.7, 0.6);
            break;
        case 'hitom':
            addTone(300, 110, 0.28, 1.0, 'sine');
            addNoise(0.03, 'lowpass', 1800, 0.7, 0.3);
            break;
        case 'medtom':
            addTone(220, 90,  0.34, 1.0, 'sine');
            addNoise(0.03, 'lowpass', 1400, 0.7, 0.3);
            break;
        case 'floortom':
            addTone(130, 60,  0.55, 1.1, 'sine');
            addNoise(0.03, 'lowpass', 900,  0.7, 0.3);
            break;
        case 'hihat':
            // Fast metallic shimmer
            addNoise(0.08, 'highpass', 7000, 0.8, 0.8);
            addNoise(0.05, 'bandpass', 9000, 2.0, 0.5);
            break;
        case 'crash':
            addNoise(1.2, 'highpass', 4500, 0.6, 0.9);
            addNoise(1.4, 'bandpass', 7000, 0.9, 0.5);
            addNoise(0.3, 'bandpass', 10000, 2.0, 0.4);
            break;
        case 'ride': {
            // Short pingy tone + sustained shimmer
            addTone(4200, 3800, 0.4, 0.12, 'sine');
            addNoise(1.8, 'highpass', 5500, 0.5, 0.55);
            addNoise(1.5, 'bandpass', 8500, 1.0, 0.35);
            break;
        }
    }
}

// ============================================================
// HIT SYSTEM
// ============================================================
const COOLDOWN = 90;              // ms between hits on same instrument
const hitTimes = {};

// Dedicated scratch vectors so hitInstrument can't stomp the ones
// that emitBurst relies on.
const _hitOffset = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _hitGroupPos = new THREE.Vector3();
const _invBowMat = new THREE.Matrix4();

function hitInstrument(instr, velocity, contactWorld = null) {
    if (!instr) return;
    const now = performance.now();
    if (now - (hitTimes[instr.name] || 0) < COOLDOWN) return;
    hitTimes[instr.name] = now;

    const v = Math.max(0.08, Math.min(1, velocity));

    // Visual flash
    instr.hitTimer = 0.3;
    instr.hitVel   = v;
    instr.hitMesh.material.emissive.copy(instr.hitColor);
    instr.hitMesh.material.emissiveIntensity = 1.5 + v * 3;
    if (instr.glow) instr.glow.material.opacity = 0.4 + 0.3 * v;

    // World-space surface normal (reused below for particles)
    _hitNormal.copy(instr.localHitNormal)
        .transformDirection(instr.group.matrixWorld);

    // Cymbal wobble: impart angular velocity around axis perpendicular
    // to the hit offset projected into the surface. Axis is stored in
    // bow-local space so the base tilt (baseQuat) is preserved while
    // wobble composes a small extra rotation on top each frame.
    if (instr.bow && contactWorld) {
        instr.group.getWorldPosition(_hitGroupPos);
        _hitOffset.copy(contactWorld).sub(_hitGroupPos);
        // Project offset onto surface plane so axis lies in the plane
        _hitOffset.addScaledVector(_hitNormal, -_hitOffset.dot(_hitNormal));
        instr.wobbleAxis.crossVectors(_hitOffset, _hitNormal);
        if (instr.wobbleAxis.lengthSq() < 1e-8) instr.wobbleAxis.set(1, 0, 0);
        instr.wobbleAxis.normalize();
        // Convert world axis to bow-local so it stays valid when
        // base tilt is re-applied each frame
        instr.bow.updateMatrixWorld();
        _invBowMat.copy(instr.bow.matrixWorld).invert();
        instr.wobbleAxis.transformDirection(_invBowMat);
        instr.wobbleVel += 6 * v;
    }

    // Drum head compression (visual flex)
    if (instr.head) instr.flex = v;

    // Particles at contact point, sprayed along surface normal
    const spawnPos = contactWorld || instr.group.position;
    emitBurst(spawnPos, _hitNormal, instr.hitColor, Math.floor(14 + 26 * v), v);

    // Audio (with stereo pan based on hit X)
    const pan = Math.max(-1, Math.min(1, spawnPos.x / 0.8));
    playSound(instr.name, v, pan);

    // Network: send actual contact point (Pd may use xyz for spatialization)
    socket.emit('drumHit', {
        instrument: instr.name,
        velocity: v,
        x: spawnPos.x, y: spawnPos.y, z: spawnPos.z
    });

    console.log(`[Hit] ${instr.label} v=${v.toFixed(2)}`);
}

// Per-instrument visual decay — restores emissive, flex, wobble
const _wobbleQuat = new THREE.Quaternion();
function tickInstrumentAnims(dt, time) {
    instruments.forEach((instr, i) => {
        // Emissive flash decay
        if (instr.hitTimer > 0) {
            instr.hitTimer -= dt;
            const t = Math.max(0, instr.hitTimer / 0.3); // 1 -> 0
            instr.hitMesh.material.emissiveIntensity =
                0.0 + (1.5 + instr.hitVel * 3) * t;
            if (instr.glow) instr.glow.material.opacity = 0.1 + 0.3 * t;
            if (instr.hitTimer <= 0) {
                instr.hitMesh.material.emissive.setHex(0x000000);
                instr.hitMesh.material.emissiveIntensity = 0;
                if (instr.glow) instr.glow.material.opacity = 0.10;
            }
        }

        // Idle bob (subtle — keep hit plane accurate)
        instr.group.position.y = instr.baseY + Math.sin(time * 0.6 + i * 1.3) * 0.004;

        // Cymbal wobble: spring-damped angular swing composed on top
        // of the cymbal's base tilt (stored in bow.userData.baseQuat).
        if (instr.bow) {
            instr.wobbleAngle += instr.wobbleVel * dt;
            instr.wobbleVel   -= instr.wobbleAngle * 22 * dt;    // spring
            instr.wobbleVel   *= Math.max(0, 1 - 3.5 * dt);       // damping
            instr.wobbleAngle *= Math.max(0, 1 - 0.5 * dt);
            _wobbleQuat.setFromAxisAngle(instr.wobbleAxis,
                instr.wobbleAngle * 0.08);                        // up to ~5°
            instr.bow.quaternion.copy(instr.bow.userData.baseQuat)
                .multiply(_wobbleQuat);
        }

        // Drum head compression: tiny Y squash on body, recover
        if (instr.head && instr.flex > 0) {
            const sy = 1 - 0.06 * instr.flex;
            if (instr.body) instr.body.scale.set(1, sy, 1);
            instr.flex *= Math.max(0, 1 - 8 * dt);
            if (instr.flex < 0.01 && instr.body) {
                instr.flex = 0;
                instr.body.scale.set(1, 1, 1);
            }
        }
    });
}

// ============================================================
// XR CONTROLLERS
// ============================================================
document.body.appendChild(VRButton.createButton(renderer, {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
}));

const controllers = [];
const raycaster   = new THREE.Raycaster();
const tmpMat      = new THREE.Matrix4();

// Drumstick visual: tapered cylinder, base at controller origin
const stickGeo = new THREE.CylinderGeometry(0.009, 0.014, 0.38, 10);
stickGeo.translate(0, 0.19, 0);
const stickMat = new THREE.MeshStandardMaterial({
    color: 0x8a6836, roughness: 0.55, metalness: 0.15
});
// Grip wrap near base
const gripGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.06, 10);
gripGeo.translate(0, 0.04, 0);
const gripMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a, roughness: 0.9, metalness: 0.05
});
const tipGeo = new THREE.SphereGeometry(0.015, 12, 8);
const tipMat = new THREE.MeshStandardMaterial({
    color: 0xe4d4aa, roughness: 0.3, metalness: 0.4
});

for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    scene.add(ctrl);

    // Drumstick points along controller's -Z
    const stick = new THREE.Mesh(stickGeo, stickMat);
    stick.rotation.x = -Math.PI / 2;
    ctrl.add(stick);

    const grip = new THREE.Mesh(gripGeo, gripMat);
    grip.rotation.x = -Math.PI / 2;
    ctrl.add(grip);

    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.set(0, 0, -0.38);
    ctrl.add(tip);

    // Ray line
    const rayGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -2.5)
    ]);
    const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({
        color: 0x4488ff, transparent: true, opacity: 0.25
    }));
    ctrl.add(ray);

    const state = {
        group: ctrl, tip, ray,
        // Swept collision: previous tip world pos
        prevTip: new THREE.Vector3(),
        hasPrev: false,
        // Which instrument the stick is currently "inside" the
        // playable plane region — used to avoid re-triggering
        // while lingering against the surface
        engaged: new Set(),
        targeted: null,
        isSelecting: false
    };
    controllers.push(state);

    ctrl.addEventListener('connected', e => {
        ctrl.userData.handedness = e.data.handedness;
    });

    // Trigger press — ray-hit instrument or foot pedal
    ctrl.addEventListener('selectstart', () => {
        state.isSelecting = true;
        if (state.targeted) {
            hitInstrument(state.targeted, 0.9);
            haptic(state, 0.5, 50);
        } else {
            const pedal = ctrl.userData.handedness === 'right' ? 'bassdrum' : 'hihat';
            hitInstrument(instruments.find(d => d.name === pedal), 0.9);
            haptic(state, 0.3, 30);
        }
    });

    ctrl.addEventListener('selectend', () => { state.isSelecting = false; });
}

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
    } catch { /* haptics unsupported */ }
}

// ============================================================
// COLLISION DETECTION — SWEPT PLANE PER INSTRUMENT
// For each instrument we have a playable plane (center, normal,
// radius) in world space. Each frame we check whether the stick
// tip crossed the plane between the previous and current frame,
// and if so, whether the intersection point lies within the
// circular playable region. Hit velocity = component of motion
// along the surface normal over dt. Works for any orientation.
// ============================================================
const _curr   = new THREE.Vector3();
const _delta  = new THREE.Vector3();
const _center = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _contact = new THREE.Vector3();
const _radial  = new THREE.Vector3();

function tickCollision(dt) {
    // Update instrument world matrices for accurate planes
    instruments.forEach(i => i.group.updateMatrixWorld());

    controllers.forEach(ctrl => {
        if (!ctrl.group.visible) { ctrl.hasPrev = false; return; }

        ctrl.tip.getWorldPosition(_curr);

        if (ctrl.hasPrev) {
            instruments.forEach(instr => {
                // Transform plane into world space
                _center.copy(instr.localHitCenter)
                    .applyMatrix4(instr.group.matrixWorld);
                _normal.copy(instr.localHitNormal)
                    .transformDirection(instr.group.matrixWorld);

                // Signed distances of prev and curr from plane
                const dPrev = _delta.copy(ctrl.prevTip).sub(_center).dot(_normal);
                const dCurr = _delta.copy(_curr).sub(_center).dot(_normal);

                // Hit condition: came from positive side, now on or past surface
                const crossed = dPrev > 0 && dCurr <= 0;

                if (crossed) {
                    // Linear interpolation to contact point on the plane
                    const t = dPrev / (dPrev - dCurr || 1e-6);
                    _contact.copy(ctrl.prevTip).lerp(_curr, t);

                    // Radial distance in plane from center
                    _radial.copy(_contact).sub(_center);
                    // Subtract normal component (projection onto plane)
                    _radial.addScaledVector(_normal, -_radial.dot(_normal));
                    const radial = _radial.length();

                    if (radial <= instr.hitRadius && !ctrl.engaged.has(instr.name)) {
                        // Velocity along inbound normal — this is the real
                        // strike speed regardless of surface orientation
                        const vn = (dPrev - dCurr) / Math.max(dt, 1e-4);
                        // Normalize: typical hard hit ~2.5 m/s along normal
                        const vel = Math.min(1, vn / 2.5);
                        if (vel > 0.08) {
                            hitInstrument(instr, vel, _contact);
                            haptic(ctrl, Math.min(1, vel), 40);
                        }
                        ctrl.engaged.add(instr.name);
                    }
                } else if (dCurr > 0.02) {
                    // Once stick has left the surface region, allow re-trigger
                    ctrl.engaged.delete(instr.name);
                }
            });
        }

        ctrl.prevTip.copy(_curr);
        ctrl.hasPrev = true;

        // Raycasting
        tmpMat.identity().extractRotation(ctrl.group.matrixWorld);
        raycaster.ray.origin.setFromMatrixPosition(ctrl.group.matrixWorld);
        raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMat);
        raycaster.far = 3;

        const hits = raycaster.intersectObjects(instrumentMeshes);
        if (hits.length > 0) {
            ctrl.ray.material.color.setHex(0xff8844);
            ctrl.ray.material.opacity = 0.7;
            ctrl.targeted = instruments.find(inst => inst.hitMesh === hits[0].object);
        } else {
            ctrl.ray.material.color.setHex(0x4488ff);
            ctrl.ray.material.opacity = 0.25;
            ctrl.targeted = null;
        }
    });
}

// ============================================================
// SPECTATOR MIRROR SYSTEM
// ============================================================
let isSpectator = true;

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

// Ghost sticks for spectator
const ghosts = [];
for (let g = 0; g < 2; g++) {
    const group = new THREE.Group();
    const gs = new THREE.Mesh(stickGeo.clone(),
        new THREE.MeshStandardMaterial({ color: 0x44aaff, transparent: true, opacity: 0.5 }));
    gs.rotation.x = -Math.PI / 2;
    group.add(gs);
    const gt = new THREE.Mesh(tipGeo.clone(),
        new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.5 }));
    gt.position.set(0, 0, -0.38);
    group.add(gt);
    group.visible = false;
    scene.add(group);
    ghosts.push(group);
}

renderer.xr.addEventListener('sessionstart', () => {
    isSpectator = false;
    scene.background = null;
    scene.fog = null;
    ensureAudio(); // user-gesture unlocked context
    socket.emit('xrSessionStart');
    setStatus('xr', 'VR Active');
});

renderer.xr.addEventListener('sessionend', () => {
    isSpectator = true;
    scene.background = new THREE.Color(BG_COLOR);
    scene.fog = new THREE.FogExp2(BG_COLOR, 0.12);
    setStatus('xr', 'Spectator Mode');
});

// Pose sync
let poseFrame = 0;
function sendPose() {
    if (isSpectator || !renderer.xr.isPresenting) return;
    if (++poseFrame % 2) return; // ~36fps

    const xrCam = renderer.xr.getCamera();
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

socket.on('drumHitFeedback', data => {
    if (!isSpectator) return;
    const instr = instruments.find(inst => inst.name === data.instrument);
    if (!instr) return;
    const v = data.velocity || 0.8;
    // Mirror the visual hit (no sound, no OSC)
    instr.hitTimer = 0.3;
    instr.hitVel   = v;
    instr.hitMesh.material.emissive.copy(instr.hitColor);
    instr.hitMesh.material.emissiveIntensity = 1.5 + v * 3;
    if (instr.glow) instr.glow.material.opacity = 0.4 + 0.3 * v;
    if (instr.head) instr.flex = v;
    // Wobble (approximate — no contact point sent, use generic axis)
    if (instr.bow) {
        instr.wobbleAxis.set(1, 0, 0);
        instr.wobbleVel += 5 * v;
    }
    const spawn = new THREE.Vector3(data.x, data.y, data.z);
    const worldNormal = new THREE.Vector3()
        .copy(instr.localHitNormal)
        .transformDirection(instr.group.matrixWorld);
    emitBurst(spawn, worldNormal, instr.hitColor, Math.floor(14 + 26 * v), v);
});

socket.on('xrSessionEnd', () => {
    if (!isSpectator) return;
    camera.position.set(0, 1.55, 1.0);
    camera.lookAt(0, 0.9, -0.5);
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

    frames++;
    if (elapsed - lastFpsT >= 1) {
        setStatus('fps', Math.round(frames / (elapsed - lastFpsT)));
        frames = 0; lastFpsT = elapsed;
    }

    tickInstrumentAnims(dt, elapsed);
    tickParticles(dt);
    ambientDust.rotation.y = elapsed * 0.03;

    if (renderer.xr.isPresenting && !isSpectator) {
        tickCollision(dt);
    }

    renderer.render(scene, camera);

    if (renderer.xr.isPresenting && !isSpectator) sendPose();
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
