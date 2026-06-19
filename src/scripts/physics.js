import Matter from 'matter-js';
import decomp from 'poly-decomp';
import { createBodyForPart } from './ColliderPhysics.js';
Matter.Common.setDecomp(decomp);
const GRID_SIZE = 20;



export class PhysicsSim {
    constructor(app) {
        this.app = app;
        this.engine = Matter.Engine.create();
        this.runner = null;
        this.canvas = document.getElementById('play-canvas');
        this.ctx = this.canvas ? this.canvas.getContext('2d', { alpha: false, desynchronized: false }) : null;
        if (this.ctx) {
            this.ctx.imageSmoothingEnabled = true;
            try { this.ctx.imageSmoothingQuality = 'high'; } catch (e) { /* ignore */ }
        }

        this.marbles = [];
        this.trails = new Map(); // per-marble id -> sampled positions for the latest run
        this._trailSamplerInterval = null; // interval id for 250ms sampling
        // camera.mode must always be one of: 'shared-middle', 'leader', 'free'
        // Use an internal _camera object with a private _mode field to avoid setter recursion.
        this._camera = { x: 0, y: 0, zoom: 1, _mode: 'free' };

        // Expose a camera facade with controlled setters so FREE mode cannot be overridden by other code.
        this.camera = {};
        // mode property delegates to setCameraMode (keeps existing behavior)
        Object.defineProperty(this.camera, 'mode', {
            get: () => this._camera._mode,
            set: (v) => { this.setCameraMode(v); }
        });

        // x and y are guarded: when _cameraFrozenForFree is true (free mode) writes from outside are ignored.
        Object.defineProperty(this.camera, 'x', {
            get: () => this._camera.x,
            set: (v) => {
                // allow internal trusted writes bypass by checking an internal flag
                if (!this._cameraFrozenForFree) this._camera.x = Number(v) || 0;
            }
        });
        Object.defineProperty(this.camera, 'y', {
            get: () => this._camera.y,
            set: (v) => {
                if (!this._cameraFrozenForFree) this._camera.y = Number(v) || 0;
            }
        });

        // zoom still maps through directly (no special protection needed)
        Object.defineProperty(this.camera, 'zoom', {
            get: () => this._camera.zoom,
            set: (v) => { this._camera.zoom = Number(v) || 1; }
        });

        // Helper to force-set camera position from internal methods when necessary
        this._forceSetCamera = (x, y) => {
            this._camera.x = Number(x) || 0;
            this._camera.y = Number(y) || 0;
        };

        this.lastCameraMode = String(this._camera._mode).trim();
        this._lerpVel = { x: 0, y: 0 }; // reserved for smoothing resets
        this.isRunning = false;
        this.startTime = 0;
        this.finishTime = null;
        this.winZone = null;
        this.results = [];
        this.speedMultiplier = 1;
        
        this.partBodies = new Map();
        this.worldData = null;

        // Pointer & gesture state used only for free camera
        this._activePointers = new Map();
        this._pinchBase = null;
        this._isPanning = false;
        this._lastPointer = null;

        // explicit flag to indicate we've frozen camera motion for free mode
        this._cameraFrozenForFree = false;

        this.setupEvents();
    }

    setupEvents() {
        Matter.Events.on(this.engine, 'collisionStart', (event) => {
            event.pairs.forEach(pair => this.handleCollision(pair.bodyA, pair.bodyB));
        });

        const btnToggle = document.getElementById('btn-toggle-camera');
        if (btnToggle) {
            btnToggle.addEventListener('click', (e) => {
                const modes = ['shared-middle', 'leader', 'free'];
                // normalize stored mode and rotate
                const cur = String(this.camera.mode || '').trim().toLowerCase();
                const idx = Math.max(0, modes.indexOf(cur));
                const next = modes[(idx + 1) % modes.length];
                this.setCameraMode(next);
                const label = next === 'shared-middle' ? 'Shared-Middle' : (next.charAt(0).toUpperCase() + next.slice(1));
                try { e.target.innerText = `Camera: ${label}`; } catch { btnToggle.innerText = `Camera: ${label}`; }
            });
        }



        const speeds = [0.25, 0.5, 1, 2, 4, 8];
        const plus = document.getElementById('btn-speed-plus');
        const minus = document.getElementById('btn-speed-minus');
        if (plus) plus.addEventListener('click', () => {
            const i = speeds.indexOf(this.speedMultiplier);
            if (i < speeds.length - 1) this.speedMultiplier = speeds[i+1];
            // apply speed via Matter's timeScale so simulation steps remain fixed-step and deterministic
            try { this.engine.timing.timeScale = this.speedMultiplier; } catch (e) {}
            const cs = document.getElementById('current-speed');
            if (cs) cs.innerText = this.speedMultiplier + 'x';
        });
        if (minus) minus.addEventListener('click', () => {
            const i = speeds.indexOf(this.speedMultiplier);
            if (i > 0) this.speedMultiplier = speeds[i-1];
            try { this.engine.timing.timeScale = this.speedMultiplier; } catch (e) {}
            const cs = document.getElementById('current-speed');
            if (cs) cs.innerText = this.speedMultiplier + 'x';
        });

        // Setup canvas gestures using the Editor-style pointer/pinch/pan handlers so PLAY free camera matches Editor controls
        const canvas = this.canvas;
        if (!canvas) return;

        const clampCanvas = (v, a, b) => Math.max(a, Math.min(b, v));

        // Wheel zoom centered on pointer (canvas pixel accurate)
        canvas.addEventListener('wheel', (ev) => {
            ev.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / Math.max(1, rect.width);
            const scaleY = canvas.height / Math.max(1, rect.height);
            const mxCanvas = (ev.clientX - rect.left) * scaleX;
            const myCanvas = (ev.clientY - rect.top) * scaleY;

            const worldBefore = { x: (mxCanvas - this._camera.x) / this._camera.zoom, y: (myCanvas - this._camera.y) / this._camera.zoom };
            const delta = ev.deltaY > 0 ? 0.92 : 1.08;
            // doubled play-mode zoom ceiling from 5 -> 10
            this.camera.zoom = clampCanvas(this.camera.zoom * delta, 0.4, 10);
            this._forceSetCamera(mxCanvas - worldBefore.x * this.camera.zoom, myCanvas - worldBefore.y * this.camera.zoom);
        }, { passive: false });

        // Maintain active pointer map (client coords)
        this._activePointers = this._activePointers || new Map();
        this._pinchBase = this._pinchBase || null;
        this._isPanning = this._isPanning || false;
        this._lastPointer = this._lastPointer || null;

        // Pointer down: capture and register pointer
        canvas.addEventListener('pointerdown', (e) => {
            try { canvas.setPointerCapture(e.pointerId); } catch {}
            this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

            // If there are two or more pointers, initialize pinch state
            if (this._activePointers.size >= 2) {
                const pts = Array.from(this._activePointers.values()).slice(0, 2);
                const a = pts[0], b = pts[1];
                this._pinchBase = {
                    dist: Math.hypot(a.x - b.x, a.y - b.y) || 0.0001,
                    lastMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
                    baseZoom: this.camera.zoom
                };
                this._isPanning = false;
                this._lastPointer = null;
            } else {
                // single pointer: enable panning only when in 'free' camera mode
                const mode = String(this.camera.mode || '').trim().toLowerCase();
                if (mode === 'free') {
                    this._lastPointer = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType };
                    this._isPanning = true;
                } else {
                    this._lastPointer = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType };
                    this._isPanning = false;
                }
            }
        });

        // Pointer move: handle pinch (two-finger) or single-finger free-camera pan
        canvas.addEventListener('pointermove', (e) => {
            if (!this._activePointers.has(e.pointerId)) return;
            this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

            // Pinch-to-zoom + midpoint pan
            if (this._activePointers.size >= 2 && this._pinchBase) {
                const pts = Array.from(this._activePointers.values()).slice(0, 2);
                const curDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 0.0001;
                const midX = (pts[0].x + pts[1].x) / 2;
                const midY = (pts[0].y + pts[1].y) / 2;
                const rect = canvas.getBoundingClientRect();

                const scaleX = canvas.width / Math.max(1, rect.width);
                const scaleY = canvas.height / Math.max(1, rect.height);
                const mxCanvas = (midX - rect.left) * scaleX;
                const myCanvas = (midY - rect.top) * scaleY;

                const worldBefore = { x: (mxCanvas - this._camera.x) / this._camera.zoom, y: (myCanvas - this._camera.y) / this._camera.zoom };

                const newZoom = clampCanvas(this._pinchBase.baseZoom * (curDist / this._pinchBase.dist), 0.4, 10);
                this.camera.zoom = newZoom;

                const deltaClientX = midX - this._pinchBase.lastMid.x;
                const deltaClientY = midY - this._pinchBase.lastMid.y;
                const deltaCanvasX = deltaClientX * scaleX;
                const deltaCanvasY = deltaClientY * scaleY;

                const targetX = mxCanvas - worldBefore.x * this.camera.zoom - deltaCanvasX;
                const targetY = myCanvas - worldBefore.y * this.camera.zoom - deltaCanvasY;
                this._forceSetCamera(targetX, targetY);

                this._pinchBase.lastMid = { x: midX, y: midY };
                return;
            }

            // Single-finger panning for free camera (client delta converted to canvas pixels)
            const modeNow = String(this.camera.mode || '').trim().toLowerCase();
            if (modeNow === 'free' && this._isPanning && this._lastPointer && e.pointerId === this._lastPointer.id) {
                const dx = e.clientX - this._lastPointer.x;
                const dy = e.clientY - this._lastPointer.y;
                this._lastPointer.x = e.clientX;
                this._lastPointer.y = e.clientY;

                const rect2 = canvas.getBoundingClientRect();
                const scaleX2 = canvas.width / Math.max(1, rect2.width);
                const scaleY2 = canvas.height / Math.max(1, rect2.height);
                this._forceSetCamera(this._camera.x - dx * scaleX2, this._camera.y - dy * scaleY2);
            }
        });

        // Release pointer: cleanup capture, pinch state and panning flag if needed
        const releasePointer = (e) => {
            try { canvas.releasePointerCapture(e.pointerId); } catch {}
            this._activePointers.delete(e.pointerId);
            if (this._activePointers.size < 2) this._pinchBase = null;
            if (this._lastPointer && e.pointerId === this._lastPointer.id) {
                this._isPanning = false;
                this._lastPointer = null;
            }
        };

        canvas.addEventListener('pointerup', releasePointer);
        canvas.addEventListener('pointercancel', releasePointer);
        canvas.addEventListener('pointerout', releasePointer);
        canvas.addEventListener('pointerleave', releasePointer);
    }

    // central setter ensures normalized camera mode and handles transitions cleanly
    setCameraMode(mode) {
        const normalized = String(mode || '').trim().toLowerCase();
        const allowed = ['shared-middle', 'leader', 'free'];
        const finalMode = allowed.includes(normalized) ? normalized : 'shared-middle';

        // If nothing is changing and it's not free, short-circuit for performance.
        if (finalMode === this.lastCameraMode && finalMode !== 'free') {
            this._camera._mode = finalMode;
            return;
        }

        // Transition into free mode: immediately clear any smoothing/gesture state so
        // the camera behaves exactly like the Editor (direct pointer control, no follow).
        if (finalMode === 'free') {
            try { this._activePointers.clear(); } catch (e) { this._activePointers = new Map(); }
            this._pinchBase = null;
            this._isPanning = false;
            this._lastPointer = null;
            this._lerpVel.x = 0;
            this._lerpVel.y = 0;
            // In free mode we want direct 1:1 camera control (editor-like), so DO NOT freeze external writes.
            this._cameraFrozenForFree = false;
            // Ensure we mark lastCameraMode as free so other code doesn't try to re-apply smoothing.
            this.lastCameraMode = 'free';
        } else {
            // Leaving free mode: prevent external direct writes so automated smoothing/follow can control camera
            this._cameraFrozenForFree = true;
        }

        // Write directly to the private backing field to avoid re-entering the setter.
        this._camera._mode = finalMode;
    }

    start(worldData, selectedMarbleTypes) {
        // Reset and configure for robust stable simulation
        this.isRunning = true;
        this.results = [];
        this.startTime = Date.now();
        this.finishTime = null;
        this.speedMultiplier = 1;
        try { this.engine.timing.timeScale = this.speedMultiplier; } catch (e) {}

        // Reset trail sampling for a fresh run and clear any previously exposed latest trails
        try {
            // reset internal trails map
            this.trails = new Map();
            // ensure app-level trail cache cleared for UI while running
            if (this.app) this.app.latestMarbleTrails = [];
            // no interval-based sampler anymore; sampling will occur each frame inside update()
            if (this._trailSamplerInterval) {
                try { clearInterval(this._trailSamplerInterval); } catch (e) {}
                this._trailSamplerInterval = null;
            }
        } catch (e) { /* ignore */ }

        // Stronger solver configuration for higher-fidelity collisions
        try {
            // Raise iteration counts for tighter collision resolution (helps concave shapes & fast marbles)
            this.engine.positionIterations = Math.max(40, this.engine.positionIterations || 40);
            this.engine.velocityIterations = Math.max(20, this.engine.velocityIterations || 20);
            this.engine.constraintIterations = Math.max(12, this.engine.constraintIterations || 12);

            // Make the engine less permissive about positional error if available
            if (typeof this.engine.positionCorrection !== 'undefined') this.engine.positionCorrection = Math.max(0.15, this.engine.positionCorrection || 0.15);
            // ensure timeScale starts consistent
            if (typeof this.engine.timing !== 'undefined') this.engine.timing.timeScale = this.speedMultiplier;
        } catch (e) { /* ignore if engine doesn't expose these */ }

        // Disable sleeping to avoid bodies going to sleep during tight/high-speed interactions
        try { this.engine.enableSleeping = false; } catch (e) { /* ignore */ }

        const csEl = document.getElementById('current-speed');
        if (csEl) csEl.innerText = '1x';

        Matter.World.clear(this.engine.world);
        Matter.Engine.clear(this.engine);

        // canvas sizing - keep crisp and performant
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const DPR = window.devicePixelRatio || 1;
        const maxH = 1080;
        const targetH = Math.min(maxH, Math.max(360, Math.round(vh * DPR)));
        const aspect = vw / Math.max(1, vh);
        const targetW = Math.round(targetH * aspect);

        this.canvas.style.width = vw + 'px';
        this.canvas.style.height = vh + 'px';
        this.canvas.width = Math.max(1, targetW);
        this.canvas.height = Math.max(1, targetH);

        // Poll for resolution changes every 1s while simulation is running.
        if (this._resizePoll == null) {
            this._lastViewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
            this._resizePoll = setInterval(() => {
                const w = window.innerWidth;
                const h = window.innerHeight;
                const dpr = window.devicePixelRatio || 1;
                if (w !== this._lastViewport.w || h !== this._lastViewport.h || dpr !== this._lastViewport.dpr) {
                    this._lastViewport.w = w;
                    this._lastViewport.h = h;
                    this._lastViewport.dpr = dpr;

                    const DPR2 = dpr;
                    const targetH2 = Math.min(maxH, Math.max(360, Math.round(h * DPR2)));
                    const aspect2 = w / Math.max(1, h);
                    const targetW2 = Math.round(targetH2 * aspect2);

                    try {
                        this.canvas.style.width = w + 'px';
                        this.canvas.style.height = h + 'px';
                        this.canvas.width = Math.max(1, targetW2);
                        this.canvas.height = Math.max(1, targetH2);
                        if (this.ctx) {
                            this.ctx.imageSmoothingEnabled = true;
                            try { this.ctx.imageSmoothingQuality = 'high'; } catch (e) { /* ignore */ }
                        }
                    } catch (err) {
                        console.warn('PhysicsSim resize poll failed:', err);
                    }
                }
            }, 1000);
        }

        if (this.ctx) {
            this.ctx.imageSmoothingEnabled = true;
            try { this.ctx.imageSmoothingQuality = 'high'; } catch {}
        }

        this.partBodies.clear();
        this.worldData = worldData;

        // Add parts using the shared collider factory (keeps colliders exactly aligned with rendered parts)
        worldData.parts.forEach(p => {
            try {
                // pass a deep-cloned part snapshot into the collider factory to guarantee no shared mutation
                const body = createBodyForPart(JSON.parse(JSON.stringify(p)), Matter, decomp, GRID_SIZE);

                if (!body) {
                    console.warn(`createBodyForPart returned no body for part ${p.id} (${p.type})`);
                    return;
                }

                // normalize physics material properties with slightly stricter defaults
                body.restitution = Math.max(0, body.restitution ?? 0);
                body.friction = Math.max(0, body.friction ?? 0.06);
                body.frictionStatic = Math.max(0, body.friction * 2);
                body.frictionAir = body.frictionAir ?? 0.0005;

                // If editor part exposes a bounciness setting, normalize and apply it to the collider restitution.
                // Accept either 0..1 values or 0..100 percentages stored by various UI code.
                try {
                    const rawB = Number(p.settings?.bounciness);
                    if (!Number.isNaN(rawB) && rawB !== 0) {
                        let normB = rawB;
                        // treat values > 1 as percentages (e.g. 50 => 0.5)
                        if (Math.abs(normB) > 1) normB = normB / 100;
                        normB = Math.max(0, Math.min(1, normB));
                        body.restitution = Math.max(body.restitution, normB);
                    }
                } catch (e) {
                    // ignore normalization failures
                }

                // sensors for gameplay-only parts
                if (p.type === 'spawn_point' || p.type === 'teleporter' || p.type === 'win_zone') {
                    body.isSensor = true;
                }

                // kinematic / special tagging
                if (p.type === 'moving_platform') {
                    body.isStatic = false;
                    body.isMovingPlatform = true;
                    body._platformData = {
                        p1: p.settings?.p1 || { x: p.x, y: p.y },
                        p2: p.settings?.p2 || { x: p.x + 200, y: p.y },
                        speed: (p.settings?.speed || 40),
                        t: 0,
                        loop: p.settings?.loop || 'ping-pong'
                    };
                    body.plugin = body.plugin || {};
                    body.plugin.kinematic = true;
                } else if (p.type === 'spinner') {
                    body.isStatic = true;
                    body.isSpinner = true;
                    body._spinnerSpeed = (p.settings?.speed || 2.0);
                }

                // Ensure there's a render object so debug drawing and styling can read fillStyle
                body.render = body.render || {};
                // Prefer the editor-specified color (part.color or part.settings.color); otherwise use sensible solid defaults per type
                const editorColor = p.color || (p.settings && p.settings.color);
                if (editorColor) {
                    body.render.fillStyle = editorColor;
                } else {
                    if (p.type === 'win_zone') {
                        body.render.fillStyle = "#22c55e"; // green
                    } else if (p.type === 'spawn_point') {
                        body.render.fillStyle = "#f97316"; // orange
                    } else if (p.type === 'teleporter') {
                        body.render.fillStyle = "#a855f7"; // purple
                    } else {
                        body.render.fillStyle = "#64748b"; // neutral gray
                    }
                }

                // Add to world
                Matter.World.add(this.engine.world, body);

                // For compound bodies, propagate plugin and render metadata to each child part so debug draw has access.
                if (body.parts && body.parts.length > 1) {
                    for (const child of body.parts.slice(1)) {
                        child.plugin = child.plugin || {};
                        // copy plugin info from the parent (originalVertices / centroids etc.)
                        try { Object.assign(child.plugin, body.plugin || {}); } catch (e) {}
                        child.render = child.render || {};
                        child.render.fillStyle = child.render.fillStyle || body.render.fillStyle;
                        // Set label to parent's label for consistent filtering in collision handling
                        child.label = child.label || body.label;
                    }
                } else {
                    // simple body - ensure plugin exists and render style is set
                    body.plugin = body.plugin || {};
                    body.render.fillStyle = body.render.fillStyle || (body.plugin && body.plugin.fillStyle) || "#64748b";
                }

                // Keep mapping from part id to the top-level body for lookup
                this.partBodies.set(p.id, body);

                if (p.type === 'win_zone') this.winZone = p;
            } catch (outerErr) {
                console.warn('createBodyForPart error while creating part collider', p.id, outerErr);
            }
        });

        // Spawn marbles
        const spawn = worldData.parts.find(p => p.type === 'spawn_point');
        const rawBounciness = spawn?.settings?.bounciness;
        const bounciness = (typeof rawBounciness === 'number') ? Math.max(0, Math.min(0.95, rawBounciness)) : 0.55;

        // Defensive: ensure spawn coordinates are integer-grid aligned to avoid 0.5 offsets
        const spawnX = Math.round((spawn?.x || 200));
        // apply +0.5 cell vertical offset so marbles sit slightly above the spawn cell center
        const spawnY = Math.round((spawn?.y || 200)) + Math.round(GRID_SIZE / 2);

        // Randomize spawn order so marbles don't always appear in the same sequence
        const spawnList = (selectedMarbleTypes || []).slice();
        for (let s = spawnList.length - 1; s > 0; s--) {
            const j = Math.floor(Math.random() * (s + 1));
            [spawnList[s], spawnList[j]] = [spawnList[j], spawnList[s]];
        }

        spawnList.forEach((mDesc, idx) => {
            // mDesc may be a simple string (legacy) or a resolved descriptor object { label, css, meta, color }.
            // Normalize into pluginData with clear signals for solid / rainbow / monochrome or gradient metadata.
            // add a small horizontal jitter so marbles don't stack perfectly
            const jitterX = (Math.random() - 0.5) * 8;
            const px = spawnX + (idx * 2) + jitterX;
            const py = spawnY;

            let pluginData = {};

            // If caller provided a resolved descriptor object, honor its meta/css fields first.
            if (mDesc && typeof mDesc === 'object') {
                // Copy meta and css into plugin so renderer can detect special types
                pluginData = Object.assign({}, mDesc.meta || {});
                // Provide a simple color fallback used by the renderer when not a gradient/special
                if (mDesc.meta && mDesc.meta.type === 'solid' && mDesc.meta.color) {
                    pluginData.color = String(mDesc.meta.color).toLowerCase();
                } else if (mDesc.css && typeof mDesc.css === 'string' && mDesc.css.indexOf('linear-gradient') === -1) {
                    pluginData.color = String(mDesc.css).toLowerCase();
                } else if (mDesc.color) {
                    pluginData.color = String(mDesc.color).toLowerCase();
                } else if (typeof mDesc.label === 'string') {
                    pluginData.color = String(mDesc.label).toLowerCase();
                }
                // If the meta indicates rainbow/monochrome, ensure _special flag is set
                if (pluginData.type === 'rainbow' || String(mDesc.label || '').toLowerCase() === 'rainbow') pluginData._special = 'rainbow';
                if (pluginData.type === 'monochrome' || String(mDesc.label || '').toLowerCase() === 'monochrome') pluginData._special = 'monochrome';
                // preserve original descriptor for renderer (gradients/colors array)
                pluginData._descriptor = mDesc;
            } else {
                // legacy: mDesc is a string color name
                const rawColor = String(mDesc || 'gray');
                const normalizedColor = rawColor.toLowerCase();
                pluginData = { color: normalizedColor };
                if (normalizedColor === 'rainbow') pluginData._special = 'rainbow';
                if (normalizedColor === 'monochrome') pluginData._special = 'monochrome';
            }

            // Create marble with tuned mass/inertia for realistic bounces and momentum transfer
            const marble = Matter.Bodies.circle(
                px,
                py,
                15,
                {
                    restitution: Math.min(1, bounciness + 0.18),
                    friction: 0.005,
                    frictionStatic: 0,
                    frictionAir: 0.0001,
                    density: 0.006,
                    label: 'marble',
                    plugin: pluginData,
                    angularDamping: 0.00005,
                    collisionFilter: { group: 0 }
                }
            );

            // Tune mass & inertia for spherical behavior (approximate)
            try {
                // set a consistent mass based on density & area (approximation)
                const desiredMass = 0.4; // slightly heavier to keep momentum stable
                Matter.Body.setMass(marble, desiredMass);
                // ensure inertia approximates a solid disk: (1/2) * m * r^2
                const inertia = 0.5 * desiredMass * (15 * 15);
                Matter.Body.setInertia(marble, inertia);
            } catch (e) { /* ignore if engine doesn't allow direct set */ }

            // visual styling used by renderer (for non-special colors)
            marble.render = marble.render || {};
            // derive a safe render color from plugin metadata or fallback to the string descriptor
            const renderColor = pluginData.color || (typeof mDesc === 'string' ? String(mDesc).toLowerCase() : null);
            if (!pluginData._special) {
                marble.render.fillStyle = renderColor;
            } else {
                // clear fillStyle so renderer uses special drawing code
                marble.render.fillStyle = null;
            }

            // Ensure minimal friction/damping so momentum is preserved but rolling resistance exists
            marble.friction = 0.005;
            marble.frictionStatic = 0;
            marble.frictionAir = 0.0001;
            // keep restitution aligned with created body but ensure it's capped
            marble.restitution = Math.min(1, bounciness + 0.18);
            marble.sleepThreshold = -1; // discourage sleeping further

            Matter.World.add(this.engine.world, marble);

            // Give each marble a small randomized initial push and some rotation for variety.
            try {
                // small throw: x and y components in px/sec (clamped)
                const throwX = (Math.random() - 0.5) * 6; // gentle horizontal nudge
                const throwY = - (Math.random() * 2 + 1); // slight upward lift
                Matter.Body.setVelocity(marble, { x: throwX, y: throwY });

                // small random angular velocity so marbles spin when spawned
                const ang = (Math.random() - 0.5) * 0.6; // radians/sec-ish
                Matter.Body.setAngularVelocity(marble, ang);
            } catch (err) {
                // ignore if engine does not allow immediate velocity setting
            }
        });

        // Initial camera framing — only apply automatic framing if NOT in free camera mode
        if (String(this.camera.mode || '').trim().toLowerCase() !== 'free' && !this._cameraFrozenForFree) {
            const spawnPart = worldData.parts.find(p => p.type === 'spawn_point');
            if (spawnPart) {
                this.camera.x = this.canvas.width/2 - spawnPart.x;
                this.camera.y = this.canvas.height/2 - spawnPart.y;
            } else if (worldData.parts.length) {
                const avg = worldData.parts.reduce((acc,p) => (acc.x+=p.x, acc.y+=p.y, acc), {x:0,y:0});
                avg.x /= worldData.parts.length; avg.y /= worldData.parts.length;
                this.camera.x = this.canvas.width/2 - avg.x;
                this.camera.y = this.canvas.height/2 - avg.y;
            }
        }

        // initialize timing for frame-rate independent updates
        this._lastTimestamp = performance.now();

        // initialize accumulator for fixed-step updates
        this.accumulator = 0;

        // Ensure engine uses deterministic fixed-step updates: do not multiply steps based on speedMultiplier elsewhere.
        try { this.engine.timing.timeScale = this.speedMultiplier; } catch (e) {}

        // start loop using rAF timestamp
        requestAnimationFrame((t) => this.loop(t));
    }

    handleCollision(a, b) {
        const marble = a.label === 'marble' ? a : (b.label === 'marble' ? b : null);
        const other = marble === a ? b : a;
        if (!marble || !other) return;

        // Win zone handling (unchanged)
        if (other.label === 'win_zone' && !marble.finished) {
            marble.finished = true;
            const time = ((Date.now() - this.startTime) / 1000).toFixed(2);
            this.results.push({ color: marble.plugin.color, time });
            if (this.results.length === 1) this.startFinishCountdown();
            const total = this.engine.world.bodies.filter(b => b.label === 'marble').length;
            if (this.results.length === total) this.showResults();
            return;
        }

        // Fluid sensor: fully hold marbles on touch and release them after configured seconds.
        // Add a per-marble, per-sensor cooldown so marbles recently released aren't immediately re-stopped.
        try {
            const partId = other.plugin?.partId;
            const part = partId && this.worldData && Array.isArray(this.worldData.parts)
                ? this.worldData.parts.find(p => String(p.id) === String(partId))
                : null;

            if (part && String(part.type).toLowerCase() === 'fluid_sensor') {
                const secs = Math.max(0.01, Math.min(65, Number(part?.settings?.release_seconds ?? 1)));
                const sensorKey = `fluid_hold_${partId}`;
                const cooldownKey = `fluid_cooldown_${partId}`;

                // If marble has a recent cooldown timestamp for this sensor, ignore re-triggering
                if (marble._fluidCooldowns && marble._fluidCooldowns[partId]) {
                    const since = Date.now() - marble._fluidCooldowns[partId];
                    if (since < 1000) {
                        // still in 1s cooldown window; ignore this collision
                        return;
                    } else {
                        // cooldown expired; clear it
                        delete marble._fluidCooldowns[partId];
                        if (Object.keys(marble._fluidCooldowns).length === 0) delete marble._fluidCooldowns;
                    }
                }

                if (!marble[sensorKey]) {
                    // mark held and record pre-hold state
                    marble[sensorKey] = true;
                    marble._fluidHeld = marble._fluidHeld || new Set();
                    marble._fluidHeld.add(partId);
                    marble._preVel = marble._preVel || {};
                    marble._prePos = marble._prePos || {};
                    marble._preAngle = marble._preAngle || {};
                    marble._preVel[partId] = { x: marble.velocity?.x || 0, y: marble.velocity?.y || 0 };
                    marble._prePos[partId] = { x: marble.position.x, y: marble.position.y };
                    marble._preAngle[partId] = marble.angle || 0;

                    // make marble immobile: clear forces, zero velocities and set static so physics won't move it
                    try {
                        Matter.Body.setVelocity(marble, { x: 0, y: 0 });
                        Matter.Body.setAngularVelocity(marble, 0);
                        if (marble.force) { marble.force.x = 0; marble.force.y = 0; }
                        Matter.Body.setStatic(marble, true);
                    } catch (err) {
                        try { Matter.Body.setVelocity(marble, { x: 0, y: 0 }); } catch {}
                    }

                    // Schedule release which will restore dynamic state and previous velocity (safely clamped)
                    const tid = setTimeout(() => {
                        try {
                            if (marble && !marble.finished) {
                                // Make sure body is dynamic before applying velocities
                                try { Matter.Body.setStatic(marble, false); } catch (err) {}

                                // Restore position if available (guarded)
                                const prevPos = (marble._prePos && marble._prePos[partId]);
                                if (prevPos) {
                                    try { Matter.Body.setPosition(marble, { x: prevPos.x, y: prevPos.y }); } catch (err) {}
                                }

                                // Determine prior velocity but clamp to safe range and guard against non-finite values
                                const rawPrev = (marble._preVel && marble._preVel[partId]) || { x: 0, y: 0 };
                                const clamp = (v) => {
                                    if (!Number.isFinite(v)) return 0;
                                    // limit to a reasonable gameplay max (px/sec)
                                    const MAX = 100;
                                    return Math.max(-MAX, Math.min(MAX, v));
                                };
                                const vx = clamp(Number(rawPrev.x || 0));
                                const vy = clamp(Number(rawPrev.y || 0));

                                // If prior velocity is extremely large or NaN, use a safe zero velocity fallback
                                const safeVel = { x: vx, y: vy };
                                try {
                                    // Clear residual forces first
                                    if (marble.force) { marble.force.x = 0; marble.force.y = 0; }
                                } catch (e) {}

                                try {
                                    // Apply a small guarded velocity to avoid teleport-launch spikes.
                                    // If both components are nearly zero, write exact zero to prevent jitter.
                                    const nearZero = (Math.abs(safeVel.x) < 1e-3 && Math.abs(safeVel.y) < 1e-3);
                                    if (nearZero) {
                                        Matter.Body.setVelocity(marble, { x: 0, y: 0 });
                                    } else {
                                        Matter.Body.setVelocity(marble, safeVel);
                                    }
                                } catch (err) {
                                    try { Matter.Body.setVelocity(marble, { x: 0, y: 0 }); } catch (_) {}
                                }

                                // Reset angular velocity to a stable value (don't restore unbounded rotation)
                                try { Matter.Body.setAngularVelocity(marble, 0); } catch (err) {}
                                try { if (typeof marble.angle === 'number' && marble._preAngle && typeof marble._preAngle[partId] === 'number') { /* keep angle but avoid restoring rotvel */ } } catch (e) {}
                            }
                        } catch (err) {}
                        // cleanup markers and set cooldown timestamp to prevent immediate re-hold
                        try {
                            if (marble && marble._fluidHeld) {
                                marble._fluidHeld.delete(partId);
                                if (marble._fluidHeld.size === 0) delete marble._fluidHeld;
                            }
                            if (marble && marble._preVel) {
                                delete marble._preVel[partId];
                                if (Object.keys(marble._preVel).length === 0) delete marble._preVel;
                            }
                            if (marble && marble._prePos) {
                                delete marble._prePos[partId];
                                if (Object.keys(marble._prePos).length === 0) delete marble._prePos;
                            }
                            if (marble && marble._preAngle) {
                                delete marble._preAngle[partId];
                                if (Object.keys(marble._preAngle).length === 0) delete marble._preAngle;
                            }
                            if (marble) delete marble[sensorKey];

                            // set per-marble cooldown timestamp for this sensor to now (1 second window)
                            marble._fluidCooldowns = marble._fluidCooldowns || {};
                            marble._fluidCooldowns[partId] = Date.now();

                            // clear timer tracking
                            if (marble && marble._fluidTimers) {
                                delete marble._fluidTimers[partId];
                                if (Object.keys(marble._fluidTimers).length === 0) delete marble._fluidTimers;
                            }
                        } catch (err) {}
                    }, Math.round(secs * 1000));

                    marble._fluidTimers = marble._fluidTimers || {};
                    marble._fluidTimers[partId] = tid;
                }

                return;
            }
        } catch (e) {
            console.warn('fluid_sensor collision handler error', e);
        }

        // Teleporter handling with per-marble cooldown and one-way support
        if (other.label === 'teleporter') {
            const telePartId = other.plugin?.partId;
            if (!telePartId || !this.worldData) return;

            // Prevent immediate re-teleport (teleport-back prevention):
            // If marble has a recorded source of last teleport and it's this teleporter, ignore.
            if (marble._teleported_from && String(marble._teleported_from) === String(telePartId)) {
                return;
            }

            // Resolve wiring (one wire assumed) and destination
            const wire = this.worldData.wires.find(w => w.from === telePartId) || this.worldData.wires.find(w => w.to === telePartId);
            if (!wire) return;
            const destId = (wire.from === telePartId) ? wire.to : wire.from;
            const destBody = this.partBodies.get(destId);
            if (!destBody) return;

            // Determine teleporter parts to read settings
            const srcPart = this.worldData.parts.find(p => String(p.id) === String(telePartId));
            const dstPart = this.worldData.parts.find(p => String(p.id) === String(destId));
            const srcOneWay = !!(srcPart && (srcPart.settings?.one_way === true));
            const dstOneWay = !!(dstPart && (dstPart.settings?.one_way === true));

            // Determine cooldown for this teleport (ms). Default 500ms.
            // If either side is marked one_way, treat teleport as one-way (no cooldown) and prevent teleport back.
            const cooldownMs = (srcOneWay || dstOneWay) ? 0 : 500;

            // If marble recently teleported within its cooldown, ignore this collision
            const last = marble._justTeleported || 0;
            const since = Date.now() - last;
            if (last && since < (marble._teleportCooldownMs ?? 500)) {
                return;
            }

            // Perform teleport: place slightly offset to avoid immediate overlap
            Matter.Body.setPosition(marble, { x: destBody.position.x + 20, y: destBody.position.y });
            Matter.Body.setVelocity(marble, { x: 0, y: 0 });
            Matter.Body.setAngularVelocity(marble, 0);

            // Record teleport metadata on marble
            marble._justTeleported = Date.now();
            marble._teleportCooldownMs = cooldownMs;
            // If this teleport is one-way, mark the source so the marble won't teleport back at that teleporter
            if (srcOneWay || dstOneWay) {
                // store teleported_from as the destination id so collisions with the origin teleporter are ignored
                marble._teleported_from = destId;
                // Also schedule removal of _teleported_from after a short safe window (so it doesn't permanently block later teleports)
                setTimeout(() => {
                    try { delete marble._teleported_from; } catch (e) {}
                }, 5000);
            } else {
                // ensure teleported_from is cleared for normal two-way portals
                delete marble._teleported_from;
            }

            return;
        }

        // PART BOUNCINESS: if the other body maps to an editor part that has a bounciness bonus,
        // apply it temporarily to the marble's restitution (additive, capped at 1.0) and restore later.
        try {
            const partId = other.plugin?.partId ?? null;
            if (partId && this.worldData && Array.isArray(this.worldData.parts)) {
                const part = this.worldData.parts.find(p => String(p.id) === String(partId));
                // normalize bounciness whether saved as 0..1 or 0..100 percentage
                const rawB = part ? Number(part.settings?.bounciness) : 0;
                const hasB = !Number.isNaN(rawB) && rawB !== 0;
                if (hasB) {
                    let added = rawB;
                    if (Math.abs(added) > 1) added = added / 100;
                    added = Math.max(0, Math.min(1, added));
                    // Avoid stacking repeated applications by checking a flag/timestamp
                    if (!marble._bouncyApplied || (Date.now() - marble._bouncyApplied) > 250) {
                        marble._bouncyApplied = Date.now();
                        // store original restitution to restore later
                        if (typeof marble._originalRestitution !== 'number') marble._originalRestitution = marble.restitution ?? 0;
                        const newRest = Math.min(1, (marble._originalRestitution || 0) + added);
                        marble.restitution = newRest;
                        // Schedule a restore shortly after collision to avoid persistent high restitution
                        setTimeout(() => {
                            try {
                                if (marble && typeof marble._originalRestitution === 'number') {
                                    marble.restitution = marble._originalRestitution;
                                }
                                delete marble._bouncyApplied;
                                delete marble._originalRestitution;
                            } catch (e) {}
                        }, 250);
                    }
                }
            }
        } catch (e) {
            // swallow errors - do not break simulation
        }

        // Cleanup: if we hit a teleporter but marble had a short _justTeleported marker beyond cooldown, clear it
        if (other.label === 'teleporter' && marble._justTeleported) {
            const dt = Date.now() - marble._justTeleported;
            const cooldown = marble._teleportCooldownMs ?? 500;
            if (dt < cooldown) return;
            delete marble._justTeleported;
            delete marble._teleportCooldownMs;
        }
    }

    startFinishCountdown() {
        const el = document.getElementById('finish-countdown');
        if (!el) return;
        el.classList.remove('hidden');
        let count = this.winZone?.settings?.timer || 20;
        el.innerText = count;
        const interval = setInterval(() => {
            count--;
            el.innerText = count;
            if (count <= 0 || !this.isRunning) {
                clearInterval(interval);
                el.classList.add('hidden');
                if (this.isRunning) this.showResults();
            }
        }, 1000);
    }

    showResults() {
        this.isRunning = false;

        // Expose latest trails to the app for Editor display (convert Map -> array snapshot)
        try {
            if (this.app) {
                const trailsArr = [];
                for (const [id, points] of (this.trails || new Map()).entries()) {
                    trailsArr.push({ id, points: Array.isArray(points) ? points.slice() : [] });
                }
                // Keep only the latest run's trails in app state
                this.app.latestMarbleTrails = trailsArr;
            }
        } catch (e) { /* ignore trail export failures */ }

        const modal = document.getElementById('results-screen');
        const list = document.getElementById('results-list');
        if (!modal || !list) return;
        list.innerHTML = '';
        const all = this.engine.world.bodies.filter(b => b.label === 'marble');
        this.results.forEach((r,i) => list.innerHTML += `<div class="result-item"><strong>${i+1}st</strong> - ${r.color} - ${r.time}s</div>`);
        all.forEach(m => { if (!m.finished) list.innerHTML += `<div class="result-item dq"><strong>DQ</strong> - ${m.plugin.color}</div>`; });
        modal.classList.remove('hidden');
        const overlay = document.getElementById('modal-overlay'); if (overlay) overlay.classList.remove('hidden');
    }

    loop(timestamp) {
        if (!this.isRunning) return;

        // normalize timestamp
        if (typeof timestamp !== 'number') timestamp = performance.now();

        // compute raw delta and clamp to avoid spiral of death
        const rawDeltaMs = Math.max(0, timestamp - (this._lastTimestamp || timestamp));
        this._lastTimestamp = timestamp;
        const MAX_FRAME_DELTA_MS = 250;
        const deltaMs = Math.min(rawDeltaMs, MAX_FRAME_DELTA_MS);

        // accumulate and run fixed-step updates inside update()
        this.accumulator += deltaMs;
        // call update with the accumulated time (update will consume fixed steps)
        try {
            this.update(deltaMs);
        } catch (err) {
            console.error('PhysicsSim update error:', err);
        }

        // schedule next frame
        requestAnimationFrame((t) => this.loop(t));
    }

    // Fixed-step update + render that draws bodies in camera space.
    update(deltaMs) {
        try {
            // frame counter and checkpointing: sample every 2nd frame
            this._frameCounter = this._frameCounter || 0;
            this._frameCounter++;
            if (this._frameCounter % 2 === 0) {
                try {
                    const cps = { t: Date.now(), marbles: [] };
                    const bodies = Matter.Composite.allBodies(this.engine.world) || [];
                    for (const b of bodies) {
                        if (b && b.label === 'marble') cps.marbles.push({ id: b.id, x: b.position.x, y: b.position.y });
                    }
                    this.checkpoints = this.checkpoints || [];
                    this.checkpoints.push(cps);
                    // keep checkpoint list bounded
                    if (this.checkpoints.length > 200) this.checkpoints.shift();
                } catch (e) { /* checkpoint sampling failed - ignore */ }
            }

            // Per-frame marble trail sampling (records every frame into this.trails)
            try {
                const bodies = Matter.Composite.allBodies(this.engine.world) || [];
                for (const b of bodies) {
                    if (!b || b.label !== 'marble') continue;
                    const id = String(b.id || Math.random());
                    if (!this.trails.has(id)) this.trails.set(id, []);
                    const buf = this.trails.get(id);
                    const color = (b.plugin && (b.plugin.color || (b.plugin._descriptor && b.plugin._descriptor.meta && b.plugin._descriptor.meta.color))) || b.render?.fillStyle || '#ffffff';
                    buf.push({ x: b.position.x, y: b.position.y, color });
                    // keep history bounded per marble to avoid memory growth
                    if (buf.length > 1200) buf.shift();
                }
            } catch (e) { /* per-frame sampler errors shouldn't stop the loop */ }

            const FIXED_STEP_MS = 1000 / 60;

            // ---- physics step via accumulator ----
            // accumulator was advanced in loop(); use it here for step logic
            this.accumulator = this.accumulator || 0;
            this.accumulator += 0; // accumulator already incremented in loop; keep for safety
            while (this.accumulator >= FIXED_STEP_MS) {
                // Adaptive substepping: inspect fastest body linear/angular motion to decide extra substeps
                // This reduces tunneling for high-speed translation/rotation by running multiple smaller updates.
                let maxVel = 0;
                let maxAngVel = 0;
                try {
                    for (const b of Matter.Composite.allBodies(this.engine.world)) {
                        if (!b) continue;
                        const lv = Math.hypot(b.velocity?.x || 0, b.velocity?.y || 0);
                        maxVel = Math.max(maxVel, lv);
                        maxAngVel = Math.max(maxAngVel, Math.abs(b.angularVelocity || 0));
                    }
                } catch (e) {
                    maxVel = 0; maxAngVel = 0;
                }

                // Heuristics: convert max motion into required substeps.
                // Faster objects -> more substeps, but clamp to avoid spiralling cost.
                // Tuning: threshold values tuned for typical marble / platform speeds.
                const linearThreshold = 120; // px/sec before needing extra substeps
                const angularThreshold = 10; // rad/sec before needing extra substeps
                let substeps = 1;
                if (maxVel > linearThreshold) {
                    substeps = Math.min(6, Math.ceil(maxVel / linearThreshold));
                }
                if (maxAngVel > angularThreshold) {
                    substeps = Math.max(substeps, Math.min(6, Math.ceil(maxAngVel / angularThreshold)));
                }

                // If many bodies exist with high speeds, raise substeps modestly
                const bodyCount = (this.engine.world && this.engine.world.bodies) ? this.engine.world.bodies.length : 0;
                if (bodyCount > 60) substeps = Math.min(4, substeps);

                // Run substeps with smaller dt to emulate continuous collision detection behavior
                const stepMs = Math.floor(FIXED_STEP_MS / substeps);
                for (let s = 0; s < substeps; s++) {
                    Matter.Engine.update(this.engine, stepMs);
                }

                this.accumulator -= FIXED_STEP_MS;
            }

            // kinematic updates (platforms/spinners) based on the frame delta in seconds
            const dtSec = Math.min(deltaMs / 1000, 0.08);
            this.updateMovingPlatforms(dtSec);
            this.updateSpinners(dtSec);
            // Apply fan forces after kinematic updates so moving platforms/spinners don't interfere
            try { this.applyFanForces(dtSec); } catch (e) { /* swallow errors */ }

            // ---- rendering ----
            const ctx = this.ctx;
            const canvas = this.canvas;
            if (!ctx || !canvas) return;

            // clear full canvas in pixel space
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // camera facade expected to use x/y in world coords; render using centered camera transform
            const camera = this.camera;
            const mode = String(camera.mode || '').trim().toLowerCase();

            // Automated Camera Follow Logic (updates world coordinates that appear at screen center)
            // Simplified and reliable behaviors:
            // - free: do nothing (user controls camera directly)
            // - leader: follow marble nearest the win zone (fallback to leader by progress)
            // - shared-middle: center on the robust group center of active marbles
            if (mode === 'free') {
                // Free mode: leave camera fully under user control
                this.lastCameraMode = 'free';
            } else if (mode === 'leader') {
                // Prefer the marble nearest the win zone for leader mode (more stable for finish-focused races)
                const marbles = this.engine.world.bodies.filter(b => b.label === 'marble' && !b.finished);
                let target = null;

                if (this.winZone) {
                    // If winZone has a physics body mapping, prefer physical position; otherwise use stored part coords.
                    const wzBody = (this.partBodies && this.partBodies.size) ? Array.from(this.partBodies.values()).find(bb => bb.label === 'win_zone') : null;
                    const wzPos = wzBody ? { x: wzBody.position.x, y: wzBody.position.y } : { x: this.winZone.x || 0, y: this.winZone.y || 0 };

                    // Find marble with minimum distance to the win zone
                    let bestDist = Infinity;
                    for (const m of marbles) {
                        const d = Math.hypot(m.position.x - wzPos.x, m.position.y - wzPos.y);
                        if (d < bestDist) { bestDist = d; target = m; }
                    }
                }

                // Fallback: if no winZone or no marbles found above, pick the marble with greatest progress (max y)
                if (!target && marbles.length > 0) {
                    target = marbles.reduce((a, b) => (b.position.y > a.position.y ? b : a), marbles[0]);
                }

                if (target) {
                    const tx = target.position.x;
                    const ty = target.position.y;
                    const lerpVal = 0.2;
                    this._forceSetCamera(this._camera.x + (tx - this._camera.x) * lerpVal, this._camera.y + (ty - this._camera.y) * lerpVal);
                }

                this.lastCameraMode = 'leader';
            } else { // shared-middle and any other
                const marbles = this.engine.world.bodies.filter(b => b.label === 'marble' && !b.finished);
                if (marbles.length > 0) {
                    // Compute bounding-box center for robustness (handles spread groups)
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    marbles.forEach(m => {
                        minX = Math.min(minX, m.position.x);
                        minY = Math.min(minY, m.position.y);
                        maxX = Math.max(maxX, m.position.x);
                        maxY = Math.max(maxY, m.position.y);
                    });
                    const centerX = (minX + maxX) / 2;
                    const centerY = (minY + maxY) / 2;

                    // Smoothly lerp the camera toward the group center
                    const lerpVal = 0.15;
                    this._forceSetCamera(this._camera.x + (centerX - this._camera.x) * lerpVal, this._camera.y + (centerY - this._camera.y) * lerpVal);
                }
                this.lastCameraMode = 'shared-middle';
            }

            ctx.save();

            // Translate so camera.x/camera.y are at canvas center
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.scale(camera.zoom || 1, camera.zoom || 1);
            ctx.translate(-camera.x || 0, -camera.y || 0);

            // Draw Grid in Play Mode
            this.drawGrid();

            // Draw all bodies. Handle compound bodies by drawing their individual parts for concave support.
            let lastBody = null;
            const bodies = Matter.Composite.allBodies(this.engine.world);
            for (const body of bodies) { lastBody = body;
                // Matter compound bodies: body.parts[0] is the container, body.parts[1...] are actual shapes.
                const parts = (body.parts && body.parts.length > 1) ? body.parts.slice(1) : [body];
                
                for (const part of parts) {
                    if (!part.vertices || part.vertices.length < 3) continue;

                    ctx.save();
                    const verts = part.vertices;
                    ctx.beginPath();
                    ctx.moveTo(verts[0].x, verts[0].y);
                    for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
                    ctx.closePath();

                    // Inherit styling from parent body
                    // Use the render.fillStyle determined when the body was created (prefer part-level then body-level)
                    ctx.fillStyle = part.render?.fillStyle || body.render?.fillStyle || "#64748b";
                    // marbles may also carry color information in plugin or render; prefer render.fillStyle for consistency
                    if (body.label === 'marble') ctx.fillStyle = body.render?.fillStyle || body.plugin?.color || "#fff";

                    ctx.fill();
                    ctx.lineWidth = 1 / (camera.zoom || 1);
                    ctx.strokeStyle = "rgba(0,0,0,0.15)";
                    ctx.stroke();
                    ctx.restore();
                }

                // Special rendering for whole bodies labeled 'marble' that may not be covered by compound-part fills above.
                // Draw marble visuals per-body here to avoid referencing an undefined variable after the loop.
                if (body.label === 'marble') {
                    try {
                        

                        // Representative position & radius (use body.position)
                        const r = 15; // matches spawn radius
                        const cx = body.position.x;
                        const cy = body.position.y;

                        // Use plugin metadata to detect special colors
                        const special = body.plugin && body.plugin._special ? body.plugin._special : null;
                        const colorTag = (body.plugin && body.plugin.color) ? String(body.plugin.color).toLowerCase() : null;

                        if (special === 'rainbow' || colorTag === 'rainbow') {
                            // Smooth spectrum lerp: sample N hues across the circle and blend them radially,
                            // while cycling the base hue over time to animate a continuous spectrum loop.
                            const nowSec = ((Date.now() - (this.startTime || 0)) / 1000);
                            const cycleSec = 3.5; // full spectrum cycle duration
                            const base = (nowSec / cycleSec) % 1; // 0..1
                            const segments = 6; // number of spectrum stops to interpolate
                            // helper: convert hue(0..360),sat(0..1),light(0..1) -> rgb string
                            const hslToRgbStr = (h, s, l) => {
                                // h: 0..360, s/l: 0..1
                                const k = (n) => (n + h/30) % 12;
                                const a = s * Math.min(l, 1 - l);
                                const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
                                const r = Math.round(255 * f(0));
                                const g = Math.round(255 * f(8));
                                const b = Math.round(255 * f(4));
                                return `rgb(${r},${g},${b})`;
                            };

                            // build a smooth radial gradient by creating several color stops that sweep the hue spectrum
                            const grad = ctx.createRadialGradient(cx - r*0.15, cy - r*0.15, r*0.05, cx, cy, r);
                            for (let i = 0; i <= segments; i++) {
                                // position along gradient 0..1
                                const tpos = i / segments;
                                // hue cycles around full 360 degrees, offset by base so animation moves
                                const hue = ((base + tpos) % 1) * 360;
                                const col = hslToRgbStr(hue, 0.92, 0.55);
                                // slightly bias stops toward outer rim for visible bands
                                const stop = Math.pow(tpos, 0.85);
                                grad.addColorStop(Math.min(1, Math.max(0, stop)), col);
                            }

                            // fill marble with the animated gradient
                            ctx.beginPath();
                            ctx.arc(cx, cy, r, 0, Math.PI * 2);
                            ctx.fillStyle = grad;
                            ctx.fill();

                            // gentle white sheen to preserve spherical feel
                            const sheen = ctx.createRadialGradient(cx - r*0.25, cy - r*0.25, r*0.02, cx, cy, r);
                            sheen.addColorStop(0, 'rgba(255,255,255,0.8)');
                            sheen.addColorStop(0.6, 'rgba(255,255,255,0.04)');
                            sheen.addColorStop(1, 'rgba(0,0,0,0)');
                            ctx.beginPath();
                            ctx.arc(cx, cy, r, 0, Math.PI * 2);
                            ctx.fillStyle = sheen;
                            ctx.fill();

                            // subtle outline
                            ctx.beginPath();
                            ctx.arc(cx, cy, r, 0, Math.PI * 2);
                            ctx.lineWidth = 0.8 / (camera.zoom || 1);
                            ctx.strokeStyle = 'rgba(0,0,0,0.18)';
                            ctx.stroke();
                        } else if (special === 'monochrome' || colorTag === 'monochrome') {
                            // Ping-pong lerp between black and white over time for a smooth monochrome pulse.
                            const nowSec = ((Date.now() - (this.startTime || 0)) / 1000);
                            const period = 2.4; // seconds for full back-and-forth
                            const phase = (nowSec % period) / period; // 0..1
                            // create ping-pong in 0..1
                            const ping = phase < 0.5 ? (phase * 2) : (1 - (phase - 0.5) * 2);
                            // smooth easing
                            const ease = (v) => v * v * (3 - 2 * v);
                            const t = ease(ping);

                            // linear interpolate between white and black
                            const lerpByte = (a, b, f) => Math.round(a + (b - a) * f);
                            const centerR = lerpByte(255, 0, t);
                            const centerG = lerpByte(255, 0, t);
                            const centerB = lerpByte(255, 0, t);
                            const rimR = lerpByte(40, 0, t); // keep rim darker even when center is light
                            const rimG = lerpByte(40, 0, t);
                            const rimB = lerpByte(40, 0, t);

                            // radial gradient from center to rim using interpolated colors
                            const g = ctx.createRadialGradient(cx - r*0.18, cy - r*0.18, r*0.03, cx, cy, r);
                            g.addColorStop(0, `rgb(${centerR},${centerG},${centerB})`);
                            g.addColorStop(0.6, `rgb(${Math.round((centerR+rimR)/2)},${Math.round((centerG+rimG)/2)},${Math.round((centerB+rimB)/2)})`);
                            g.addColorStop(1, `rgb(${rimR},${rimG},${rimB})`);

                            ctx.beginPath();
                            ctx.arc(cx, cy, r, 0, Math.PI * 2);
                            ctx.fillStyle = g;
                            ctx.fill();

                            // small glossy highlight whose opacity depends on the phase to enhance the pulse
                            ctx.beginPath();
                            ctx.ellipse(cx - r*0.33, cy - r*0.45, r*0.42, r*0.25, Math.PI/6, 0, Math.PI*2);
                            ctx.fillStyle = `rgba(255,255,255,${0.08 + 0.32 * (1 - t)})`;
                            ctx.fill();

                            ctx.beginPath();
                            ctx.arc(cx, cy, r, 0, Math.PI * 2);
                            ctx.lineWidth = 0.8 / (camera.zoom || 1);
                            ctx.strokeStyle = 'rgba(0,0,0,0.22)';
                            ctx.stroke();
                        }
                    } catch (e) {
                        // don't block render on special-draw failures
                    }
                }
            }

            ctx.restore();

            // update UI timer
            const time = ((Date.now() - this.startTime) / 1000).toFixed(1);
            const timerEl = document.getElementById('race-timer');
            if (timerEl) { timerEl.innerText = time + 's'; timerEl.classList.remove('hidden'); }
        } catch (e) {
            console.error("PhysicsSim render/update error:", e);
        }
    }

    updateMovingPlatforms(dtSec) {
        this.engine.world.bodies.forEach(body => {
            if (body.isMovingPlatform && body._platformData) {
                const d = body._platformData;
                const len = Math.hypot(d.p2.x - d.p1.x, d.p2.y - d.p1.y) || 1;
                d.t += (d.speed * dtSec) / len;
                let t = d.t % 2;
                if (d.loop === 'ping-pong') {
                    if (t > 1) t = 2 - t;
                } else {
                    t = d.t % 1;
                }
                const nx = d.p1.x + (d.p2.x - d.p1.x) * t;
                const ny = d.p1.y + (d.p2.y - d.p1.y) * t;
                Matter.Body.setPosition(body, { x: nx, y: ny });
                Matter.Body.setVelocity(body, { x: 0, y: 0 });
            }
        });
    }

    updateSpinners(dtSec) {
        this.engine.world.bodies.forEach(body => {
            if (body.isSpinner) {
                const speed = body._spinnerSpeed || 2.0;
                const newAngle = (body.angle || 0) + speed * dtSec;
                Matter.Body.setAngle(body, newAngle);
                Matter.Body.setAngularVelocity(body, 0);
            }
        });
    }

    // Apply fan forces to marbles: cone check + distance attenuation, per-frame impulse-ish application
    applyFanForces(dtSec) {
        if (!this.worldData || !Array.isArray(this.worldData.parts)) return;
        const fans = this.worldData.parts.filter(p => p.type === 'fan');
        if (!fans || fans.length === 0) return;

        // gather marble bodies
        const marbles = this.engine.world.bodies.filter(b => b.label === 'marble');
        if (!marbles || marbles.length === 0) return;

        for (const fan of fans) {
            const fx = Number(fan.x || 0);
            const fy = Number(fan.y || 0);
            const dir = (fan.settings && typeof fan.settings.direction === 'number') ? fan.settings.direction : -Math.PI/2;
            const force = (fan.settings && typeof fan.settings.force === 'number') ? Math.max(0, fan.settings.force) : 0.12;
            const range = (fan.settings && typeof fan.settings.range === 'number') ? Math.max(20, fan.settings.range) : (GRID_SIZE * 6);
            const coneHalf = Math.PI / 6; // 30° half-angle for gameplay (configurable)
            const forceScale = force; // direct multiplier

            // precompute direction unit vector
            const ux = Math.cos(dir);
            const uy = Math.sin(dir);

            for (const m of marbles) {
                if (!m || !m.position) continue;
                const vx = m.position.x - fx;
                const vy = m.position.y - fy;
                const dist = Math.hypot(vx, vy);
                if (dist <= 0.0001 || dist > range) continue;

                // normalized vector from fan to marble
                const nx = vx / dist;
                const ny = vy / dist;
                // angle between fan forward and vector to marble (cosine check)
                const dot = ux * nx + uy * ny;
                const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
                if (angle > coneHalf) continue; // outside cone

                // attenuation: linear falloff (1 at origin -> 0 at range), sharpened with quadratic
                const t = Math.max(0, 1 - (dist / range));
                const atten = t * t;

                // Compute force magnitude (N). Use marble mass to compute acceleration impulse
                const mag = forceScale * atten;

                // Apply as a small impulse (force * dt) to preserve frame-rate independence roughly
                const impulseX = ux * mag * dtSec * 60; // scale up so values feel responsive
                const impulseY = uy * mag * dtSec * 60;

                try {
                    // If marble is sleeping, wake it
                    if (m.isSleeping) Matter.Body.set(m, 'isSleeping', false);

                    // Apply a velocity change by setting a small force/velocity (using setVelocity additive)
                    // We'll add velocity rather than direct force to avoid depending on engine force integration.
                    const newVx = (m.velocity.x || 0) + impulseX;
                    const newVy = (m.velocity.y || 0) + impulseY;
                    Matter.Body.setVelocity(m, { x: newVx, y: newVy });
                } catch (e) {
                    // ignore per-marble failures
                }
            }
        }
    }



    // Draw a light editor-sized grid similar to the Editor
    drawGrid() {
        if (!this.ctx || !this.canvas) return;
        const ctx = this.ctx;
        const camera = this._camera;
        const canvas = this.canvas;

        // World rect calculation adjusted for centered camera transform
        const halfW = (canvas.width / 2) / (camera.zoom || 1);
        const halfH = (canvas.height / 2) / (camera.zoom || 1);
        
        const topLeftWorldX = camera.x - halfW;
        const topLeftWorldY = camera.y - halfH;
        const bottomRightWorldX = camera.x + halfW;
        const bottomRightWorldY = camera.y + halfH;

        const startX = Math.floor(topLeftWorldX / GRID_SIZE) * GRID_SIZE;
        const startY = Math.floor(topLeftWorldY / GRID_SIZE) * GRID_SIZE;
        const endX = Math.ceil(bottomRightWorldX / GRID_SIZE) * GRID_SIZE;
        const endY = Math.ceil(bottomRightWorldY / GRID_SIZE) * GRID_SIZE;

        ctx.save();
        // subtle thin lines for cell grid — increased visibility
        ctx.lineWidth = 1 / camera.zoom;
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        for (let x = startX; x <= endX; x += GRID_SIZE) {
            ctx.beginPath();
            ctx.moveTo(x, startY);
            ctx.lineTo(x, endY);
            ctx.stroke();
        }
        for (let y = startY; y <= endY; y += GRID_SIZE) {
            ctx.beginPath();
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
            ctx.stroke();
        }

        // stronger major lines every 4 cells — increased opacity for clarity
        ctx.lineWidth = 1.6 / camera.zoom;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        const major = GRID_SIZE * 4;
        const majorStartX = Math.floor(startX / major) * major;
        const majorStartY = Math.floor(startY / major) * major;
        for (let x = majorStartX; x <= endX; x += major) {
            ctx.beginPath();
            ctx.moveTo(x, startY);
            ctx.lineTo(x, endY);
            ctx.stroke();
        }
        for (let y = majorStartY; y <= endY; y += major) {
            ctx.beginPath();
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
            ctx.stroke();
        }
        ctx.restore();
    }



    stop() {
        // Export sampled trails so Editor can draw the latest run and make them available even after stopping
        try {
            // export current trails snapshot to the app (trails are sampled per-frame inside update)
            if (this.app) {
                const out = [];
                try {
                    for (const [id, pts] of (this.trails || new Map()).entries()) {
                        out.push({ id, points: Array.isArray(pts) ? pts.slice() : [] });
                    }
                } catch (e) { /* ignore conversion errors */ }
                this.app.latestMarbleTrails = out;
            }
        } catch (e) { /* ignore export errors */ }

        this.isRunning = false;
        const t = document.getElementById('race-timer'); if (t) t.classList.add('hidden');
        const f = document.getElementById('finish-countdown'); if (f) f.classList.add('hidden');
        this.partBodies.clear();
        this.worldData = null;
        try { this._activePointers.clear(); } catch (e) { this._activePointers = new Map(); }
        this._pinchBase = null;
        this._isPanning = false;
        this._lastPointer = null;
        this._cameraFrozenForFree = false;

        // Remove resize listener and cancel any pending frames when stopping simulation
        try {
            if (this._handleCanvasResize) {
                window.removeEventListener('resize', this._handleCanvasResize);
                this._handleCanvasResize = null;
            }
            if (this._pendingResizeFrame) {
                cancelAnimationFrame(this._pendingResizeFrame);
                this._pendingResizeFrame = null;
            }
        } catch (e) { /* ignore */ }
    }
}