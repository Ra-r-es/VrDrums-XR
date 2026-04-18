import eruda from 'eruda';

eruda.init();

import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { io } from 'socket.io-client';



const socket = io();

socket.on('connect', () => {
    console.log('Connected to OSC bridge server');
});


const container = document.createElement('div');
document.body.appendChild(container);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
light.position.set(0.5, 1, 0.25);
scene.add(light);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);

scene.background = null;
renderer.xr.setReferenceSpaceType('local-floor');

document.body.appendChild(VRButton.createButton(renderer, {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
}));


const drums = [];
const drumDefinitions = [

    { name: 'hihat', radius: 0.14, height: 0.02, x: -0.45, y: -0.15, z: -0.25, color: 0xccaa00 },
    { name: 'snare', radius: 0.15, height: 0.1, x: -0.25, y: -0.45, z: -0.35, color: 0xcccccc },
    { name: 'floortom', radius: 0.2, height: 0.25, x: 0.5, y: -0.5, z: -0.25, color: 0x2222aa },


    { name: 'crash', radius: 0.2, height: 0.02, x: -0.4, y: 0, z: -0.5, color: 0xddbb00 },
    { name: 'hitom', radius: 0.12, height: 0.1, x: -0.1, y: -0.3, z: -0.5, color: 0x2222aa },
    { name: 'medtom', radius: 0.13, height: 0.12, x: 0.2, y: -0.3, z: -0.5, color: 0x2222aa },
    { name: 'ride', radius: 0.25, height: 0.02, x: 0.55, y: 0, z: -0.5, color: 0xddbb00 },


    { name: 'bassdrum', radius: 0.25, height: 0.2, x: 0.05, y: -0.7, z: -0.4, color: 0x551111 }
];

drumDefinitions.forEach(def => {
    const geometry = new THREE.CylinderGeometry(def.radius, def.radius, def.height, 32);
    const material = new THREE.MeshPhongMaterial({ color: def.color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(def.x, def.y, def.z);
    scene.add(mesh);

    drums.push({
        ...def,
        mesh: mesh,
        originalColor: new THREE.Color(def.color),
        hitColor: new THREE.Color(0xff0000),
        visualFeedbackTimer: 0
    });
});


const stickGeometry = new THREE.CylinderGeometry(0.01, 0.01, 0.4, 8);
stickGeometry.translate(0, 0.05, 0);
const stickMaterial = new THREE.MeshPhongMaterial({ color: 0x884400 });

let controllers = [];

for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    scene.add(controller);

    const stick = new THREE.Mesh(stickGeometry, stickMaterial);

    stick.rotation.x = -Math.PI / 2;
    controller.add(stick);

    controllers.push({
        group: controller,
        stickModel: stick,
        lastHitTime: 0,
        insideDrums: new Set(),
        previousPointsY: []
    });


    controller.addEventListener('connected', function (event) {
        this.userData.handedness = event.data.handedness;
    });


    controller.addEventListener('selectstart', function () {
        const timeNow = performance.now();
        if (this.userData.handedness === 'right') {

            triggerFootPedal('bassdrum', timeNow);
        } else if (this.userData.handedness === 'left') {

            triggerFootPedal('hihat', timeNow);
        }
    });
}

const footPedalLastHit = {
    'bassdrum': 0,
    'hihat': 0
};

function triggerFootPedal(drumName, timeNow) {
    if (timeNow - footPedalLastHit[drumName] > hitCooldown) {
        footPedalLastHit[drumName] = timeNow;


        const drum = drums.find(d => d.name === drumName);
        if (drum) {
            drum.mesh.material.color.copy(drum.hitColor);
            drum.visualFeedbackTimer = 0.1;
        }

        playDrumSound(drumName);
        console.log(`${drumName} (Pedal) Hit!`);

        socket.emit('drumHit', {
            drumName: drumName,
            velocity: 0.9
        });
    }
}


const hitCooldown = 100;


let audioCtx;
function playDrumSound(drumName) {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    const t = audioCtx.currentTime;


    let oscFreq = 0;
    let oscEndFreq = 0.01;
    let oscDecay = 0;
    let oscSweepTime = null;
    let hasNoise = false;
    let noiseFilterFreq = 1000;
    let noiseDecay = 0.1;
    let hitVolume = 1.0;

    switch (drumName) {
        case 'bassdrum':

            oscFreq = 100; oscEndFreq = 0.05; oscDecay = 1.0; hitVolume = 1.5;
            break;
        case 'snare':
            oscFreq = 150; oscEndFreq = 0.01; oscDecay = 0.1; hitVolume = 1.2;
            hasNoise = true; noiseFilterFreq = 1000; noiseDecay = 0.15;
            break;
        case 'hihat':
            oscFreq = 0; oscDecay = 0;
            hasNoise = true; noiseFilterFreq = 5000; noiseDecay = 0.1; hitVolume = 0.5;
            break;
        case 'hitom':
            oscFreq = 250; oscEndFreq = 0.01; oscDecay = 0.3; hitVolume = 1.2;
            break;
        case 'medtom':
            oscFreq = 200; oscEndFreq = 0.01; oscDecay = 0.35; hitVolume = 1.2;
            break;
        case 'floortom':
            oscFreq = 100; oscEndFreq = 0.01; oscDecay = 0.5; hitVolume = 1.2;
            break;
        case 'crash':
            oscFreq = 0; oscDecay = 0;
            hasNoise = true; noiseFilterFreq = 3000; noiseDecay = 1.0; hitVolume = 0.8;
            break;
        case 'ride':
            oscFreq = 0; oscDecay = 0;
            hasNoise = true; noiseFilterFreq = 4000; noiseDecay = 1.5; hitVolume = 0.8;
            break;
    }


    if (oscFreq > 0) {
        const osc = audioCtx.createOscillator();
        const oscGain = audioCtx.createGain();
        osc.connect(oscGain);
        oscGain.connect(audioCtx.destination);

        osc.type = 'sine';
        osc.frequency.setValueAtTime(oscFreq, t);
        osc.frequency.exponentialRampToValueAtTime(oscEndFreq, t + oscDecay);

        oscGain.gain.setValueAtTime(hitVolume, t);
        oscGain.gain.exponentialRampToValueAtTime(0.01, t + oscDecay);

        osc.start(t);
        osc.stop(t + oscDecay);
    }


    if (hasNoise) {
        const bufferSize = audioCtx.sampleRate * noiseDecay;
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;

        const noiseFilter = audioCtx.createBiquadFilter();

        noiseFilter.type = drumName === 'bassdrum' ? 'lowpass' : 'highpass';
        noiseFilter.frequency.value = noiseFilterFreq;

        const noiseGain = audioCtx.createGain();
        noiseGain.gain.setValueAtTime(0.5 * hitVolume, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + noiseDecay);

        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(audioCtx.destination);

        noise.start(t);
    }
}


const clock = new THREE.Clock();

function render() {
    const dt = clock.getDelta();


    drums.forEach(drum => {
        if (drum.visualFeedbackTimer > 0) {
            drum.visualFeedbackTimer -= dt;
            if (drum.visualFeedbackTimer <= 0) {
                drum.mesh.material.color.copy(drum.originalColor);
            }
        }
    });

    const currentTime = performance.now();

    controllers.forEach((ctrl) => {
        if (!ctrl.group.visible) return;


        const stickPoints = [];
        const numPoints = 6;
        for (let i = 0; i < numPoints; i++) {
            const pt = new THREE.Vector3(0, 0, -0.25 * (i / (numPoints - 1)));
            pt.applyMatrix4(ctrl.group.matrixWorld);
            stickPoints.push(pt);
        }

        if (ctrl.previousPointsY.length === 0) {
            ctrl.previousPointsY = stickPoints.map(p => p.y);
        }

        drums.forEach(drum => {

            const drumWorldPos = new THREE.Vector3();
            drum.mesh.getWorldPosition(drumWorldPos);

            const drumTopY = drumWorldPos.y + drum.height / 2;


            let isCurrentlyInside = false;
            let enteredFromTop = false;


            const useFullStick = (drum.name === 'hihat' || drum.name === 'crash' || drum.name === 'ride');

            for (let i = 0; i < stickPoints.length; i++) {
                if (!useFullStick && i !== numPoints - 1) continue;

                const pt = stickPoints[i];
                const distanceToCenterXZ = Math.sqrt(
                    Math.pow(pt.x - drumWorldPos.x, 2) +
                    Math.pow(pt.z - drumWorldPos.z, 2)
                );

                const isInsideRadius = distanceToCenterXZ < drum.radius;

                const isBelowTop = pt.y < drumTopY + 0.02;
                const isAboveBottom = pt.y > drumTopY - drum.height;

                if (isInsideRadius && isBelowTop && isAboveBottom) {
                    isCurrentlyInside = true;
                    if (ctrl.previousPointsY[i] >= drumTopY) {
                        enteredFromTop = true;
                    }
                    break;
                }
            }

            if (isCurrentlyInside) {


                if (!ctrl.insideDrums.has(drum.name)) {
                    if (enteredFromTop && (currentTime - ctrl.lastHitTime > hitCooldown)) {

                        ctrl.lastHitTime = currentTime;


                        drum.mesh.material.color.copy(drum.hitColor);
                        drum.visualFeedbackTimer = 0.1;


                        playDrumSound(drum.name);

                        console.log(`${drum.name} Hit!`);



                        socket.emit('drumHit', {
                            drumName: drum.name,
                            velocity: 0.8
                        });
                    }


                    ctrl.insideDrums.add(drum.name);
                }
            } else {

                ctrl.insideDrums.delete(drum.name);
            }
        });


        ctrl.previousPointsY = stickPoints.map(p => p.y);
    });

    renderer.render(scene, camera);
}

renderer.setAnimationLoop(render);

window.addEventListener('resize', onWindowResize, false);

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}