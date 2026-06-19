const GRID_SIZE = 20;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

 // Simplify a polyline using the Ramer-Douglas-Peucker algorithm
// Default epsilon lowered to preserve more detail; callers can pass a scaled epsilon (e.g. based on camera zoom).
function simplifyPath(points, epsilon = 2) {
    if (!points || points.length < 3) return points ? points.slice() : [];
    const sq = (v) => v * v;
    const perpDistSq = (pt, a, b) => {
        const dx = b.x - a.x, dy = b.y - a.y;
        if (dx === 0 && dy === 0) return sq(pt.x - a.x) + sq(pt.y - a.y);
        const t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx*dx + dy*dy);
        const projx = a.x + dx * t;
        const projy = a.y + dy * t;
        return sq(pt.x - projx) + sq(pt.y - projy);
    };
    const eps2 = epsilon * epsilon;
    const rdp = (pts) => {
        if (pts.length < 3) return pts.slice();
        let maxIdx = -1, maxDist = -1;
        for (let i = 1; i < pts.length - 1; i++) {
            const d = perpDistSq(pts[i], pts[0], pts[pts.length - 1]);
            if (d > maxDist) { maxDist = d; maxIdx = i; }
        }
        if (maxDist > eps2) {
            const left = rdp(pts.slice(0, maxIdx + 1));
            const right = rdp(pts.slice(maxIdx));
            return left.slice(0, -1).concat(right);
        } else {
            return [pts[0], pts[pts.length - 1]];
        }
    };
    return rdp(points);
}

 // Compute centroid of points
function centroid(points) {
    const c = { x: 0, y: 0 };
    if (!points || points.length === 0) return c;
    points.forEach(p => { c.x += p.x; c.y += p.y; });
    c.x /= points.length; c.y /= points.length;
    return c;
}



// Point-in-polygon test using raycast winding (returns true when point is strictly inside)
function pointInPolygon(pt, polygon) {
    if (!polygon || polygon.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
            (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 0.0000001) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Compute intersection point between segment AB and segment CD (returns null if no intersection)
function segmentIntersection(A, B, C, D) {
    const a1 = B.y - A.y;
    const b1 = A.x - B.x;
    const c1 = a1 * A.x + b1 * A.y;

    const a2 = D.y - C.y;
    const b2 = C.x - D.x;
    const c2 = a2 * C.x + b2 * C.y;

    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-9) return null; // parallel

    const x = (b2 * c1 - b1 * c2) / det;
    const y = (a1 * c2 - a2 * c1) / det;

    // check within both segments' bounding boxes (inclusive)
    const within = (v, w, val) => (Math.min(v, w) - 1e-6 <= val && val <= Math.max(v, w) + 1e-6);
    if (within(A.x, B.x, x) && within(A.y, B.y, y) && within(C.x, D.x, x) && within(C.y, D.y, y)) {
        return { x, y };
    }
    return null;
}

// Signed side of point P against line AB: >0 one side, <0 other, 0 on line
function sideOfLine(A, B, P) {
    return (B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x);
}

// Return true when point P lies within the bounding box of segment AB (inclusive, with small epsilon).
// This ensures vertices that are collinear with the infinite line but lie outside the actual cut segment
// are not incorrectly included in both resulting polygons.
function pointOnSegment(A, B, P, eps = 1e-6) {
    const minX = Math.min(A.x, B.x) - eps;
    const maxX = Math.max(A.x, B.x) + eps;
    const minY = Math.min(A.y, B.y) - eps;
    const maxY = Math.max(A.y, B.y) + eps;
    return (P.x >= minX && P.x <= maxX && P.y >= minY && P.y <= maxY);
}

export class Editor {
    constructor(app) {
        this.app = app;
        this.canvas = document.getElementById('editor-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.world = { name: 'New Race', parts: [], wires: [] };
        this.hasUnsavedChanges = false;
        this._history = { past: [], future: [] };
        this._suppressHistoryPush = false;

        this.camera = { x: 0, y: 0, zoom: 0.9 };
        this.targetCamera = { x: 0, y: 0, zoom: 0.9 }; // used for smoothing
        this.activeTool = 'move';
        this.activeToolCategory = 'simple';
        this.selectedPartIds = []; // Multi-select support
        this.activeCategory = 'basic';
        this.vertexEditing = null;

        this.holdStartTime = 0;
        this.holdStartPos = null; // world coords when hold begins
        this.DRAG_HOLD_THRESHOLD = 1000; // ms to trigger drag-select (was 1500)
        this.DRAG_STATIONARY_THRESHOLD = 6; // px allowed movement while holding
        this.dragSelectStart = null;
        this.dragSelectEnd = null;
        this.isDragSelecting = false;
        this.multiSelectSignalRadius = 0;

        this.drawPath = null;
        this.isDragging = false;
        this.lastTouch = null;

        // Gesture tuning
        this.PINCH_DIST_DEADZONE = 10; // pixels of distance change required
        this.PINCH_MOVE_DEADZONE = 4; // pixels of midpoint move required

        this.init();
        // wire editor-level keyboard shortcuts for undo/redo
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                try { this.undo(); } catch (err) {}
            } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
                e.preventDefault();
                try { this.redo(); } catch (err) {}
            }
        });

        // wire buttons if present
        try {
            const btnU = document.getElementById('btn-undo');
            const btnR = document.getElementById('btn-redo');
            if (btnU) btnU.addEventListener('click', () => this.undo());
            if (btnR) btnR.addEventListener('click', () => this.redo());
            this.updateUndoRedoUI();
        } catch (err) {}
    }

    init() {
        this.resize();
        window.addEventListener('resize', () => this.resize());
        this.setupInput();
        this.setupUI();
        this.render();

        // Poll for resolution changes every 1s and call resize() when changed.
        // Stores last known innerWidth/innerHeight to avoid redundant work.
        this._lastViewport = { w: window.innerWidth, h: window.innerHeight };
        this._resizePoll = setInterval(() => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            if (w !== this._lastViewport.w || h !== this._lastViewport.h) {
                this._lastViewport.w = w;
                this._lastViewport.h = h;
                try { this.resize(); } catch (e) { /* ignore */ }
            }
        }, 1000);

        // Autosave: save periodically when there are unsaved changes, and on visibility/unload.
        try {
            // Periodic autosave every 4 seconds when there are changes
            this._autosaveInterval = setInterval(() => {
                try {
                    if (this.hasUnsavedChanges && this.app && this.app.storage && typeof this.app.storage.saveWorld === 'function') {
                        const snapshot = this.getWorldData();
                        // ensure world has an id before saving
                        snapshot.id = snapshot.id || Date.now();

                        // Maintain an autosave counter in localStorage so each autosave gets a unique sequence number.
                        const counterKey = 'autosave_counter_v1';
                        let counter = 1;
                        try {
                            const raw = localStorage.getItem(counterKey);
                            if (raw) counter = Number(raw) || 1;
                        } catch (e) { counter = 1; }

                        // Name the autosave with a stable incrementing index
                        snapshot.name = `Autosave #${counter}`;

                        // Remove previous autosaves to avoid accumulating old autosave entries.
                        try {
                            const existing = (this.app.storage && typeof this.app.storage.loadWorlds === 'function') ? (this.app.storage.loadWorlds() || []) : [];
                            const filtered = existing.filter(w => !(typeof w.name === 'string' && w.name.startsWith('Autosave #')));
                            // Save filtered list back (overwrite) then append new autosave after.
                            try {
                                // Use storage.saveWorld for consistency — first persist filtered list directly to localStorage key if available
                                if (this.app.storage && typeof this.app.storage.saveWorld === 'function' && typeof this.app.storage.loadWorlds === 'function') {
                                    // overwrite by writing filtered array directly to localStorage to ensure previous autosaves removed
                                    const saveKey = (this.app.storage.keys && this.app.storage.keys.worlds) ? this.app.storage.keys.worlds : 'marble_worlds_v2';
                                    localStorage.setItem(saveKey, JSON.stringify(filtered));
                                } else {
                                    // fallback: write directly to the default key used elsewhere
                                    localStorage.setItem('marble_worlds_v2', JSON.stringify(filtered));
                                }
                            } catch (innerErr) {
                                console.warn('Failed to prune previous autosaves:', innerErr);
                            }
                        } catch (e) {
                            // swallow prune errors
                        }

                        // Persist the autosave via storage.saveWorld (which will append)
                        try {
                            const p = this.app.storage.saveWorld(snapshot);
                            // if saveWorld returns a promise, handle it; otherwise continue
                            if (p && p.then) p.then(() => {}).catch(() => {});
                        } catch (e) {
                            // fallback to direct storage write if storage.saveWorld fails
                            try {
                                const k = (this.app.storage && this.app.storage.keys && this.app.storage.keys.worlds) ? this.app.storage.keys.worlds : 'marble_worlds_v2';
                                const arr = JSON.parse(localStorage.getItem(k) || '[]');
                                arr.push(snapshot);
                                localStorage.setItem(k, JSON.stringify(arr));
                            } catch (err) { console.warn('Fallback autosave failed', err); }
                        }

                        // increment and persist the counter
                        try {
                            localStorage.setItem(counterKey, String(counter + 1));
                        } catch (e) {}

                        this.hasUnsavedChanges = false;
                    }
                } catch (e) {
                    // swallow autosave failures
                    console.warn('Autosave failed:', e);
                }
            }, 4000);

            // Save when page is hidden (user switched tab / backgrounded)
            this._onVisibilityChange = () => {
                if (document.hidden) {
                    try {
                        if (this.hasUnsavedChanges && this.app && this.app.storage && typeof this.app.storage.saveWorld === 'function') {
                            const snapshot = this.getWorldData();
                            snapshot.id = snapshot.id || Date.now();
                            snapshot.name = snapshot.name || (`World ${snapshot.id}`);
                            this.app.storage.saveWorld(snapshot);
                            this.hasUnsavedChanges = false;
                        }
                    } catch (e) { console.warn('Visibility autosave failed:', e); }
                }
            };
            document.addEventListener('visibilitychange', this._onVisibilityChange);

            // Save on unload / beforeunload to capture sudden exits
            this._onBeforeUnload = (ev) => {
                try {
                    if (this.hasUnsavedChanges && this.app && this.app.storage && typeof this.app.storage.saveWorld === 'function') {
                        const snapshot = this.getWorldData();
                        snapshot.id = snapshot.id || Date.now();
                        snapshot.name = snapshot.name || (`World ${snapshot.id}`);
                        this.app.storage.saveWorld(snapshot);
                        // don't block unload; just persist
                        this.hasUnsavedChanges = false;
                    }
                } catch (e) { /* ignore */ }

                // Allow browser to show its default confirmation if there are unsaved changes still flagged
                if (this.hasUnsavedChanges) {
                    const warning = 'You have unsaved changes — are you sure you want to leave?';
                    ev.returnValue = warning;
                    return warning;
                }
                return undefined;
            };
            window.addEventListener('beforeunload', this._onBeforeUnload);
        } catch (err) {
            console.warn('Autosave setup failed', err);
        }

        // Ensure there's an initial history snapshot so Undo has a stable base state.
        try {
            // push a clean snapshot of the current world without recording it as a user action
            this._suppressHistoryPush = false;
            this.pushHistory();
            this.updateUndoRedoUI();
        } catch (e) {
            console.warn('Initial history push failed', e);
        }
    }

    resize() {
        // High-DPI rendering: keep CSS size = viewport but scale internal buffer by DPR for crisper editor visuals
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const DPR = Math.max(1, window.devicePixelRatio || 1);
        // Set CSS size so layout remains consistent
        this.canvas.style.width = vw + 'px';
        this.canvas.style.height = vh + 'px';
        // Set internal pixel buffer scaled by DPR
        this.canvas.width = Math.max(1, Math.round(vw * DPR));
        this.canvas.height = Math.max(1, Math.round(vh * DPR));
        // Adjust 2D context so 1 unit = 1 CSS pixel
        try {
            this.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
            this.ctx.imageSmoothingEnabled = true;
            if (this.ctx.imageSmoothingQuality) this.ctx.imageSmoothingQuality = 'high';
        } catch (e) {
            // fallback: do nothing if setTransform not available
        }
    }

    setupInput() {
        // track active pointers like touches
        this.activePointers = new Map();
        this.primaryPointerId = null;
        this.panning = false; // used for right-click pan mapping on PC

        // prevent context menu so right-click drag works as pan
        this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

        this.canvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();

            // If this is a right-button mouse down, force pan mode immediately (regardless of tool)
            // Capture pointer so we reliably receive pointermove/pointerup events for the pan.
            if (e.pointerType === 'mouse' && e.button === 2) {
                try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
                this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                this.panning = true;
                this.primaryPointerId = e.pointerId;
                this.lastTouch = { x: e.clientX, y: e.clientY };
                // Do not invoke tool handlers when right-button is used for panning
                return;
            }

            // register pointer for normal (left/touch/pen) interactions
            try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
            this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            // set primary pointer if none
            if (this.primaryPointerId === null) {
                this.primaryPointerId = e.pointerId;
            }

            // If we now have 2+ active pointers, prepare pinch handling
            if (this.activePointers.size >= 2) {
                this.setupPinch();
            }

            // forward to normal tool pointer handling only for left-button / touch / pen
            this.onPointerDown(e);
        });

        this.canvas.addEventListener('pointermove', (e) => {
            e.preventDefault();

            // Calculate movement delta BEFORE updating lastTouch to avoid zeroing out movement
            const dx = this.lastTouch ? (e.clientX - this.lastTouch.x) : 0;
            const dy = this.lastTouch ? (e.clientY - this.lastTouch.y) : 0;

            // Always update lastTouch so hover detection works even when not dragging
            this.lastTouch = { x: e.clientX, y: e.clientY };
            
            // Refresh cursor hover state immediately
            try { this.updateCursor(); } catch (err) { /* ignore */ }

            if (!this.activePointers.has(e.pointerId)) return;
            // update pointer record
            this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            // If panning (right-click drag on mouse), handle camera pan directly regardless of tool
            if (this.panning && e.pointerType === 'mouse') {
                if (e.pointerId === this.primaryPointerId) {
                    this.camera.x += dx;
                    this.camera.y += dy;
                }
                return;
            }

            // Pass the calculated delta to handle tool-specific or gesture-based movement
            // We'll calculate local world coords inside onPointerMove; call it with dx/dy as before.
            this.onPointerMove(e, dx, dy);
        });

        const handlePointerUp = (e) => {
            e.preventDefault();
            const wasPrimary = (e.pointerId === this.primaryPointerId);
            this.activePointers.delete(e.pointerId);

            // if we released a right-button pan, disable panning and release capture
            // Use panning flag + pointerType rather than checking e.button on pointerup
            if (this.panning && e.pointerType === 'mouse') {
                this.panning = false;
                try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
                // clear primary if it was the panning pointer so subsequent pointers can become primary
                if (wasPrimary) this.primaryPointerId = null;
                return;
            }

            // If the finger that was controlling the tool just lifted, end the tool gesture immediately
            if (wasPrimary) {
                this.onPointerUp(e);
                this.primaryPointerId = null;
            }

            // If no pointers are left, clear pinch state
            if (this.activePointers.size === 0) {
                this.pinch = null;
                return;
            }

            // If we no longer have a primary pointer but still have touches, pick a new primary
            if (this.primaryPointerId === null) {
                const nextId = this.activePointers.keys().next().value;
                this.primaryPointerId = nextId;
                const nextPointer = this.activePointers.get(nextId);
                this.lastTouch = { x: nextPointer.x, y: nextPointer.y };

                // Refresh pinch if we still have 2+ fingers
                if (this.activePointers.size >= 2) {
                    this.setupPinch();
                } else {
                    this.pinch = null;
                }
            }
        };

        this.canvas.addEventListener('pointerup', handlePointerUp);
        this.canvas.addEventListener('pointercancel', handlePointerUp);
        // wheel stays as zoom control (already calls onWheel)
        this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    }

    setupPinch() {
        const pts = Array.from(this.activePointers.values()).slice(0, 2);
        const a = pts[0], b = pts[1];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 0.0001;
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        
        this.pinch = {
            baseDist: dist,
            baseZoom: this.camera.zoom,
            lastMid: { x: midX, y: midY },
            isZooming: false,
            isPanning: false
        };
    }

    setupUI() {
        // Ensure Move tool is active by default in UI
        const defaultBtn = document.querySelector('.tool-btn[data-tool="move"]');
        if (defaultBtn) {
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            defaultBtn.classList.add('active');
            this.activeTool = 'move';
        }

        // Tool category switching
        document.querySelectorAll('.tool-cat-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const cat = btn.getAttribute('data-category');
                document.querySelectorAll('.tool-cat-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                document.querySelectorAll('.tool-group').forEach(g => g.classList.add('hidden'));
                document.getElementById(`tools-${cat}`).classList.remove('hidden');
                this.activeToolCategory = cat;
            });
        });

        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.activeTool = btn.getAttribute('data-tool');
                if (this.activeTool !== 'vertex') this.vertexEditing = null;
                this.drawPath = null;
                // If switching away from move/vertex/resize, maybe clear multi-select?
                // For now keep it sticky.
            });
        });

        // Selection actions
        document.getElementById('btn-mass-copy')?.addEventListener('click', () => this.massCopy());
        document.getElementById('btn-mass-delete')?.addEventListener('click', () => this.massDelete());
        document.getElementById('btn-mass-settings')?.addEventListener('click', () => this.massSettings());

        document.querySelectorAll('.parts-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.parts-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.activeCategory = tab.getAttribute('data-category');
                this.renderPartsList();
            });
        });

        this.renderPartsList();
    }

    renderPartsList() {
        const list = document.getElementById('parts-list');
        list.innerHTML = '';

        const categories = {
            basic: ['Rectangle', 'Triangle', 'Circle', 'Polygon'],
            interactive: ['Win Zone', 'Teleporter', 'Button', 'Door', 'Bumper', 'Fan', 'Sticky Platform', 'Fluid Sensor'],
            dynamic: ['Moving Platform', 'Wedge', 'Spinner'],
            spawners: ['Spawn Point']
        };

        categories[this.activeCategory].forEach(type => {
            const item = document.createElement('div');
            item.className = 'part-item';
            item.innerHTML = `<span>${type}</span>`;
            item.addEventListener('click', () => this.placePart(type));
            list.appendChild(item);
        });
    }

    placePart(type) {
        // Place part exactly at canvas center mapped to world coords with strict integer grid snapping (no fractional offsets).
        const rect = this.canvas.getBoundingClientRect();
        const cssCenterX = rect.width / 2;
        const cssCenterY = rect.height / 2;

        // Convert CSS center -> world coords (camera uses CSS-pixel space)
        const worldX = (cssCenterX - this.camera.x) / this.camera.zoom;
        const worldY = (cssCenterY - this.camera.y) / this.camera.zoom;

        // Snap to GRID_SIZE and enforce integer numbers (no fractional offsets)
        const snapped = this.snapToGrid(worldX, worldY);
        snapped.x = Math.round(snapped.x);
        snapped.y = Math.round(snapped.y);

        // Ensure spawn point uses the exact same strict snapping (no special offset)
        const tkey = String(type || '').toLowerCase().replace(/\s+/g, '_');
        if (tkey === 'spawn_point' || tkey === 'spawn point') {
            snapped.x = Math.round(worldX / GRID_SIZE) * GRID_SIZE;
            snapped.y = Math.round(worldY / GRID_SIZE) * GRID_SIZE;
            snapped.x = Math.round(snapped.x);
            snapped.y = Math.round(snapped.y);
        }

        // Prepare settings and color
        const defaultColor = '#3b82f6';
        const settings = this.getDefaultSettings(type, snapped.x, snapped.y) || {};
        settings.color = settings.color || defaultColor;
        const assignedColor = settings.color;

        const newPart = {
            id: Date.now(),
            type: tkey,
            x: snapped.x,
            y: snapped.y,
            rotation: 0,
            width: GRID_SIZE * 2,
            height: GRID_SIZE,
            color: assignedColor,
            collision: true,
            settings,
            vertices: this.getDefaultVertices(type, snapped.x, snapped.y)
        };

        // Fans are intended to be 1x1 in editor units (single cell). Enforce here for precise placement.
        if (tkey === 'fan') {
            newPart.width = GRID_SIZE;
            newPart.height = GRID_SIZE;
            // re-generate vertices to match enforced 1x1 size
            newPart.vertices = this.getDefaultVertices('Fan', newPart.x, newPart.y);
        }

        // Force integer alignment for all vertices to avoid any fractional/grid offsets
        if (Array.isArray(newPart.vertices) && newPart.vertices.length) {
            newPart.vertices = newPart.vertices.map(v => ({ x: Math.round(Number(v.x) || 0), y: Math.round(Number(v.y) || 0) }));
        }

        // Minimal overlap avoidance: only integer-grid nudges (keep multiples of GRID_SIZE)
        const overlaps = (a, b) => {
            const ax1 = a.x - (a.width || GRID_SIZE) / 2;
            const ay1 = a.y - (a.height || GRID_SIZE) / 2;
            const ax2 = a.x + (a.width || GRID_SIZE) / 2;
            const ay2 = a.y + (a.height || GRID_SIZE) / 2;
            const bx1 = b.x - (b.width || GRID_SIZE) / 2;
            const by1 = b.y - (b.height || GRID_SIZE) / 2;
            const bx2 = b.x + (b.width || GRID_SIZE) / 2;
            const by2 = b.y + (b.height || GRID_SIZE) / 2;
            return !(ax2 <= bx1 || ax1 >= bx2 || ay2 <= by1 || ay1 >= by2);
        };

        let attempts = 0;
        while (this.world.parts.some(p => overlaps(newPart, p)) && attempts < 8) {
            // Nudge by exactly one GRID cell (integer), keep vertices aligned as integers
            newPart.y += GRID_SIZE;
            if (newPart.vertices && newPart.vertices.length) {
                newPart.vertices = newPart.vertices.map(v => ({ x: Math.round(v.x), y: Math.round(v.y + GRID_SIZE) }));
            }
            newPart.x = Math.round(newPart.x);
            newPart.y = Math.round(newPart.y);
            attempts++;
        }

        // Final enforcement: ensure part.x/y and any vertices are snapped to the grid (integers * GRID_SIZE)
        // Convert any absolute coords to the nearest grid multiple to guarantee alignment
        const enforceGrid = (val) => Math.round(val / GRID_SIZE) * GRID_SIZE;
        newPart.x = enforceGrid(newPart.x);
        newPart.y = enforceGrid(newPart.y);
        if (Array.isArray(newPart.vertices)) {
            newPart.vertices = newPart.vertices.map(v => ({ x: enforceGrid(Math.round(Number(v.x) || 0)), y: enforceGrid(Math.round(Number(v.y) || 0)) }));
        }

        this.world.parts.push(newPart);
        try { this.updatePartCentroid(newPart); } catch (e) { /* ignore */ }
        this.selectedPartId = newPart.id;
        this.selectedPartIds = [newPart.id];
        this.hasUnsavedChanges = true;

        // record history (placing a part)
        try { this.pushHistory(); } catch (e) { /* ignore history failures */ }
    }

    getDefaultSettings(type, x = 0, y = 0) {
        const t = type.toLowerCase();
        // add color + bounciness defaults to broad categories so almost everything solid can be tuned
        const defaultColor = '#3b82f6'; // editor blue default
        if (t === 'spawn point') return { bounciness: 0.5, color: '#f97316' }; // orange spawn
        if (t === 'win zone') return { timer: 20, color: 'rgba(34,197,94,0.5)' };
        if (t === 'bumper') return { strength: 1.5, direction: 0, bounciness: 0.6, color: defaultColor }; 
        if (t === 'fan') return { force: 0.12, range: GRID_SIZE * 6, direction: -Math.PI / 2, color: defaultColor };
        // Fluid sensor: stops marbles on contact and releases after release_seconds (default 1s)
        if (t === 'fluid sensor' || t === 'fluid_sensor') return { release_seconds: 1, color: '#60a5fa', isSensor: true };
        if (t === 'sticky platform' || t === 'sticky_platform') return { sticky: true, friction: 1.0, color: defaultColor };
        if (t === 'moving platform') return {
            p1: { x: x, y: y }, 
            p2: { x: x + (GRID_SIZE * 5), y: y }, 
            speed: 40,
            loop: 'ping-pong',
            color: defaultColor,
            bounciness: 0
        };
        if (t === 'spinner') return { speed: 2.0, color: defaultColor, bounciness: 0 };
        // For generic solids (rect, triangle, polygon, circle) expose bounciness + color
        return { bounciness: 0, color: defaultColor };
    }

    getDefaultVertices(type, x, y) {
        const t = type.toLowerCase();
        const w = GRID_SIZE, h = GRID_SIZE;
        if (t === 'triangle') return [{x: x, y: y-h}, {x: x+w, y: y+h}, {x: x-w, y: y+h}];
        if (t === 'circle') return [];
        if (t === 'bumper') {
            // represent bumper as a rounded element (approximated circle polygon)
            const radius = GRID_SIZE;
            const steps = 12; // 12-sided approximation for a smooth round bumper
            const pts = [];
            for (let i = 0; i < steps; i++) {
                const angle = (i / steps) * Math.PI * 2;
                pts.push({ x: Math.round((x + Math.cos(angle) * radius) / 1) , y: Math.round((y + Math.sin(angle) * radius) / 1) });
            }
            return pts;
        }
        if (t === 'fan') {
            // represent as a compact 1x1 cell rectangle for placement; actual force handled in simulation
            const half = Math.round(GRID_SIZE / 2);
            return [
                { x: x - half, y: y - half }, { x: x + half, y: y - half },
                { x: x + half, y: y + half }, { x: x - half, y: y + half }
            ];
        }
        if (t === 'sticky platform' || t === 'sticky_platform') {
            // flat platform rectangle
            return [
                {x: x - w, y: y - h/4}, {x: x + w, y: y - h/4},
                {x: x + w, y: y + h/4}, {x: x - w, y: y + h/4}
            ];
        }
        return [
            {x: x-w, y: y-h/2}, {x: x+w, y: y-h/2},
            {x: x+w, y: y+h/2}, {x: x-w, y: y+h/2}
        ];
    }

    snapToGrid(x, y) {
        const snappedX = Math.round(x / GRID_SIZE) * GRID_SIZE;
        const snappedY = Math.round(y / GRID_SIZE) * GRID_SIZE;
        return { x: snappedX, y: snappedY };
    }

    onPointerDown(e) {
        if (!this.isDragging) this.isDragging = true;
        this.lastTouch = { x: e.clientX, y: e.clientY };

        // Handle multi-touch pinch setup regardless of tool state
        if (this.activePointers.size >= 2) {
            this.setupPinch();
            this.holdStartTime = 0; // Cancel multi-select hold if zooming
        }

        // Only handle tool start if this is the primary pointer
        if (e.pointerId !== this.primaryPointerId) return;

        // compute world coords up-front so tools can use them safely
        const wx = (e.clientX - this.camera.x) / this.camera.zoom;
        const wy = (e.clientY - this.camera.y) / this.camera.zoom;

        // Start multi-select hold timer and record start position for stillness check
        this.holdStartTime = Date.now();
        this.selectionPulse = null;
        this.holdStartPos = { x: wx, y: wy };

        // CUT tool: record start point for a snip (world coords) - snap to grid
        if (this.activeTool === 'cut') {
            this.holdStartTime = 0; // No multi-select in cut mode
            const s = this.snapToGrid(wx, wy);
            this.cutStart = { x: s.x, y: s.y };
            // initialize preview end to start so indicator exists immediately
            this.cutPreviewEnd = { x: s.x, y: s.y };
            // ensure we don't start other tool interactions
            return;
        }

        let hitPart = this.getPartAt(wx, wy);

        // If no part hit, check if the pointer is over the resize gizmos of the currently selected part.
        // This prevents deselection when user taps on a gizmo that lies just outside the part geometry.
        if (!hitPart && this.selectedPartIds.length === 1) {
            const selected = this.world.parts.find(p => p.id === this.selectedPartIds[0]);
            if (selected && this.isOverGizmo(selected, wx, wy)) {
                hitPart = selected;
            }
        }

        // Tool Logic
        if (this.activeTool === 'resize' && hitPart) {
            this.selectedPartIds = [hitPart.id];

            // Circle-specific resize initialization
            if (hitPart.type === 'circle') {
                const startDist = Math.hypot(wx - hitPart.x, wy - hitPart.y);
                this.resizingPart = {
                    part: hitPart,
                    type: 'circle',
                    startRadius: hitPart.radius || GRID_SIZE,
                    startDist: Math.max(1, startDist)
                };
                // Clear other gesture states
                this.draggingPart = null;
                this.draggingVertex = null;
                this.wireStartPart = null;
                this.tempWireEnd = null;
                return;
            }

            // Compute bounding box and corner hit test (polygons / rects)
            // Build a vertex list in world-space. If the part lacks explicit vertices, create the rectangle corners
            // then rotate those corners into world-space using the part's rotation so gizmo hit tests are accurate.
            const verts = hitPart.vertices && hitPart.vertices.length ? hitPart.vertices.map(v => ({ x: v.x, y: v.y })) : (()=>{
                const hw = (hitPart.width || GRID_SIZE) / 2;
                const hh = (hitPart.height || GRID_SIZE) / 2;
                const localCorners = [
                    { x: -hw, y: -hh },
                    { x:  hw, y: -hh },
                    { x:  hw, y:  hh },
                    { x: -hw, y:  hh }
                ];
                const angle = hitPart.rotation || 0;
                const cx = hitPart.x || 0, cy = hitPart.y || 0;
                const cosA = Math.cos(angle), sinA = Math.sin(angle);
                return localCorners.map(c => ({
                    x: Math.round((cx + c.x * cosA - c.y * sinA)),
                    y: Math.round((cy + c.x * sinA + c.y * cosA))
                }));
            })();

            // compute bbox from world-space verts
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            verts.forEach(v => { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); });

            // corners are already in world-space so gizmo checks consider rotation
            const corners = [
                { x: minX, y: minY }, // top-left
                { x: maxX, y: minY }, // top-right
                { x: maxX, y: maxY }, // bottom-right
                { x: minX, y: maxY }  // bottom-left
            ];

            // Determine if a corner was touched (within gizmo radius). Use double the visual gizmo hitbox.
            const gizmoRadius = ((GRID_SIZE * 0.9) / this.camera.zoom) * 2;
            let cornerIndex = -1;
            for (let i = 0; i < corners.length; i++) {
                const c = corners[i];
                if (Math.hypot(c.x - wx, c.y - wy) <= gizmoRadius) { cornerIndex = i; break; }
            }

            // Start resize state with corner index (or fallback to scale-from-center behavior)
            this.resizingPart = {
                part: hitPart,
                type: 'poly',
                startVertices: hitPart.vertices ? hitPart.vertices.map(v => ({...v})) : verts.map(v => ({...v})),
                bbox: { minX, maxX, minY, maxY },
                cornerIndex,
                // store original center for scaling fallback (world-space)
                center: { x: (minX + maxX)/2, y: (minY + maxY)/2 }
            };
            // Clear other gesture states to avoid mixing older resize state machine with new one
            this.draggingPart = null;
            this.draggingVertex = null;
            this.wireStartPart = null;
            this.tempWireEnd = null;
            return;
        }

        if (this.activeTool === 'delete' && hitPart) {
            this.world.parts = this.world.parts.filter(p => p.id !== hitPart.id);
            this.hasUnsavedChanges = true;
            try { this.pushHistory(); } catch (e) {}
            return;
        }

        if (this.activeTool === 'rotate' && hitPart) {
            // Fake-rotate instead of changing angle: swap sizes and rotate geometry by +90° (no continuous angle state)
            const ROT_DEG = 90 * (Math.PI / 180); // +90deg
            const rotate90Around = (x, y, cx, cy) => {
                const dx = x - cx;
                const dy = y - cy;
                // (+90°) -> (dx,dy) -> (-dy, dx)
                return { x: Math.round(cx - dy), y: Math.round(cy + dx) };
            };

            const applyFakeRotateToPart = (p) => {
                // If part uses explicit vertices, rotate each vertex around part center.
                if (Array.isArray(p.vertices) && p.vertices.length > 0) {
                    const cx = Number(p.x || 0);
                    const cy = Number(p.y || 0);
                    p.vertices = p.vertices.map(v => {
                        const r = rotate90Around(Number(v.x || 0), Number(v.y || 0), cx, cy);
                        return { x: r.x, y: r.y };
                    });
                    // swap width/height as a visual/interaction hack for the rotate action
                    const w = Number(p.width || GRID_SIZE);
                    const h = Number(p.height || GRID_SIZE);
                    p.width = Math.round(h);
                    p.height = Math.round(w);
                    // recompute centroid if stored
                    try { this.updatePartCentroid(p); } catch (e) {}
                } else {
                    // No explicit vertices: treat as a rectangle; swap width/height and rotate the center point slightly snapped to grid
                    const oldW = Number(p.width || GRID_SIZE);
                    const oldH = Number(p.height || GRID_SIZE);
                    p.width = Math.round(oldH);
                    p.height = Math.round(oldW);

                    // For rectangular parts we simulate a 90° rotation by nudging any attached gizmos/points.
                    // Rotate the part's stored local rotation for compatibility but keep it normalized to 0 to avoid relying on rotation in other systems.
                    p.rotation = 0;

                    // If part had implicit corners (no vertices), ensure its position remains grid-aligned
                    p.x = Math.round(Number(p.x || 0));
                    p.y = Math.round(Number(p.y || 0));
                }
            };

            // Support multi-select: apply fake rotation around group centroid so group transforms coherently
            if (this.selectedPartIds && this.selectedPartIds.length > 1) {
                let cx = 0, cy = 0, count = 0;
                this.selectedPartIds.forEach(id => {
                    const p = this.world.parts.find(x => x.id === id);
                    if (p) { cx += Number(p.x || 0); cy += Number(p.y || 0); count++; }
                });
                if (count > 0) {
                    cx = Math.round(cx / count);
                    cy = Math.round(cy / count);
                    // rotate each part position around group centroid and then fake-rotate its geometry
                    this.selectedPartIds.forEach(id => {
                        const p = this.world.parts.find(x => x.id === id);
                        if (!p) return;
                        const newPos = rotate90Around(Number(p.x || 0), Number(p.y || 0), cx, cy);
                        p.x = newPos.x;
                        p.y = newPos.y;
                        applyFakeRotateToPart(p);
                    });
                }
            } else {
                // single part
                applyFakeRotateToPart(hitPart);
            }

            // clear any numeric rotation so other systems don't double-apply transforms
            if (hitPart) { hitPart.rotation = 0; }
            if (this.selectedPartIds && this.selectedPartIds.length) {
                this.selectedPartIds.forEach(id => {
                    const p = this.world.parts.find(x => x.id === id);
                    if (p) p.rotation = 0;
                });
            }

            // Ensure integer grid alignment for all modified vertices/positions
            this.world.parts.forEach(p => {
                p.x = Math.round(Number(p.x || 0));
                p.y = Math.round(Number(p.y || 0));
                if (Array.isArray(p.vertices)) {
                    p.vertices = p.vertices.map(v => ({ x: Math.round(Number(v.x || 0)), y: Math.round(Number(v.y || 0)) }));
                }
            });

            this.hasUnsavedChanges = true;
            try { this.pushHistory(); } catch (e) {}
            return;
        }

        if (this.activeTool === 'settings' && hitPart) {
            this.app.ui.showPartSettings(hitPart);
            return;
        }

        if (this.activeTool === 'vertex') {
            const editingPart = this.world.parts.find(p => p.id === this.vertexEditing);
            if (editingPart && (this.vertexEditing === hitPart?.id || this.selectedPartIds.includes(hitPart?.id))) {
                const vIndex = this.getVertexAt(editingPart, wx, wy);
                if (vIndex !== -1) {
                    const now = Date.now();
                    // detect double-click on the same vertex (within 350ms)
                    if (this._lastVertexClick &&
                        this._lastVertexClick.partId === editingPart.id &&
                        this._lastVertexClick.index === vIndex &&
                        (now - this._lastVertexClick.time) <= 350) {
                        // Double-click: delete vertex
                        editingPart.vertices.splice(vIndex, 1);
                        // update centroid and validate
                        this.updatePartCentroid(editingPart);
                        this.ensureValidVertices(editingPart);
                        this.hasUnsavedChanges = true;
                        // record history so undo can restore the removed vertex
                        try { this.pushHistory(); } catch (e) {}
                        this._lastVertexClick = null;
                        this.selectedPartId = editingPart.id;
                        return;
                    } else {
                        // record single click time for potential double-click
                        this._lastVertexClick = { partId: editingPart.id, index: vIndex, time: now };
                        // begin dragging the vertex as before
                        this.draggingVertex = { part: editingPart, index: vIndex };
                        this.selectedPartId = editingPart.id;
                        return;
                    }
                } else {
                    const eIndex = this.getEdgeAt(editingPart, wx, wy);
                    if (eIndex !== -1) {
                        const snapped = this.snapToGrid(wx, wy);
                        editingPart.vertices.splice(eIndex + 1, 0, { x: snapped.x, y: snapped.y });
                        // update centroid immediately so part.x/part.y reflect the change live
                        this.updatePartCentroid(editingPart);
                        this.hasUnsavedChanges = true;
                        // record history so the inserted vertex can be undone
                        try { this.pushHistory(); } catch (e) {}
                        this.draggingVertex = { part: editingPart, index: eIndex + 1 };
                        this.selectedPartId = editingPart.id;
                        return;
                    }
                }
            } else if (hitPart) {
                this.vertexEditing = hitPart.id;
                this.selectedPartId = hitPart.id;
                this.selectedPartIds = [hitPart.id];
                // If the part doesn't have explicit vertices (like a default rect), initialize them
                if (!hitPart.vertices || hitPart.vertices.length === 0) {
                    hitPart.vertices = this.getDefaultVertices(hitPart.type, hitPart.x, hitPart.y);
                }
                return;
            } else {
                this.vertexEditing = null;
            }
        }

        if (this.activeTool === 'draw') {
            this.drawPath = [{ x: wx, y: wy }];
            return;
        }

        if (this.activeTool === 'wire' && hitPart) {
            this.wireStartPart = hitPart;
            return;
        }

        if (hitPart) {
            // If clicking an already-selected part, preserve multi-selection; otherwise select only it.
            if (Array.isArray(this.selectedPartIds) && this.selectedPartIds.includes(hitPart.id)) {
                // preserve existing multi-selection
            } else {
                this.selectedPartIds = [hitPart.id];
            }

            // keep single-selection mirror in sync and update selection UI
            this.selectedPartId = hitPart.id;
            try { this.updateSelectionUI(); } catch (e) {}

            if (this.activeTool === 'move') {
                // Handle moving multiple parts at once
                this.draggingParts = this.selectedPartIds.map(id => {
                    const p = this.world.parts.find(part => part.id === id);
                    return p ? { part: p, offsetX: (wx - p.x), offsetY: (wy - p.y) } : null;
                }).filter(p => p);
                // Anti-bad-grid-align: if part or any vertex is off-grid, mark it so we force-align after this move
                const isOffGrid = (v) => (v % GRID_SIZE) !== 0;
                let offGrid = (hitPart.x % GRID_SIZE !== 0) || (hitPart.y % GRID_SIZE !== 0);
                if (!offGrid && hitPart.vertices && hitPart.vertices.length) {
                    offGrid = hitPart.vertices.some(v => (v.x % GRID_SIZE !== 0) || (v.y % GRID_SIZE !== 0));
                }
                if (offGrid && !hitPart._isDrawn) hitPart._forceAlignOnNextMove = true;
            }
            // When touching a part, never pan the editor with this finger
            this.panning = false;
        } else {
            // Background touch handling:
            // - Do NOT immediately deselect on pointerdown. Instead mark a pending deselect and only
            //   apply it on pointerup. This prevents the editor from losing selection before a drag
            //   or vertex/gizmo interaction begins.
            if (this.activePointers.size === 1) {
                let shouldPreserve = false;

                // First: check whether the pointer lies over any selected-part hitbox (gizmo OR vertex)
                // Use the same generous hit tests as the resize gizmo and vertex logic so taps just below visuals
                // still count as interacting with the part and won't cause a deselect.
                if (this.selectedPartIds && this.selectedPartIds.length > 0) {
                    for (const selId of this.selectedPartIds) {
                        const sel = this.world.parts.find(p => p.id === selId);
                        if (!sel) continue;
                        const overGizmo = this.isOverGizmo(sel, wx, wy);
                        const overVertex = this.getVertexAt(sel, wx, wy) !== -1;
                        if (overGizmo || overVertex) { shouldPreserve = true; break; }
                        // also allow a conservative part hit (point-in-polygon / center distance) to preserve selection
                        const partHit = this.getPartAt(wx, wy);
                        if (partHit && partHit.id === sel.id) { shouldPreserve = true; break; }
                    }
                }

                // Preserve selection when the user is actively interacting with a part (drag/resize/vertex/wire)
                if (this.draggingVertex || this.resizingPart || (this.draggingParts && this.draggingParts.length) || this.wireStartPart || this.tempWireEnd) {
                    shouldPreserve = true;
                }

                // Vertex tool: if the pointer hit any part (even if not in selected list), preserve selection so user can begin vertex edit
                if (this.activeTool === 'vertex' && hitPart) shouldPreserve = true;

                // If nothing suggests we should preserve selection, mark a pending deselect.
                // This will be cancelled on move (if they start dragging) or applied on pointerup.
                if (!shouldPreserve) {
                    this._pendingDeselect = { startTime: Date.now(), startPos: { x: wx, y: wy }, pointerId: e.pointerId };
                } else {
                    this._pendingDeselect = null;
                }

                this.panning = false;
            }
        }
    }

    onPointerMove(e, dx, dy) {
        if (!this.isDragging) return;

        // Cancel pending deselect if pointer moved beyond stationary threshold (user likely started dragging)
        if (this._pendingDeselect && this._pendingDeselect.startPos) {
            const px = (this.lastTouch && typeof this.lastTouch.x === 'number') ? (this.lastTouch.x - this.camera.x) / this.camera.zoom : null;
            const py = (this.lastTouch && typeof this.lastTouch.y === 'number') ? (this.lastTouch.y - this.camera.y) / this.camera.zoom : null;
            if (px !== null && py !== null) {
                const moved = Math.hypot(px - this._pendingDeselect.startPos.x, py - this._pendingDeselect.startPos.y);
                if (moved > (this.DRAG_STATIONARY_THRESHOLD || 6)) {
                    this._pendingDeselect = null;
                }
            }
        }

        // Handle multi-touch zooming/panning first
        if (this.activePointers.size >= 2 && this.pinch) {
            const pts = Array.from(this.activePointers.values()).slice(0, 2);
            const a = pts[0], b = pts[1];
            const curDist = Math.hypot(a.x - b.x, a.y - b.y) || 0.0001;
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2;

            // Handle Zoom
            const worldPos = {
                x: (midX - this.camera.x) / this.camera.zoom,
                y: (midY - this.camera.y) / this.camera.zoom
            };
            // increase max zoom to 8 for closer inspection
            const newZoom = clamp(this.pinch.baseZoom * (curDist / this.pinch.baseDist), 0.4, 8);
            this.camera.zoom = newZoom;
            this.camera.x = midX - worldPos.x * this.camera.zoom;
            this.camera.y = midY - worldPos.y * this.camera.zoom;

            // Handle Pan
            this.camera.x += (midX - this.pinch.lastMid.x);
            this.camera.y += (midY - this.pinch.lastMid.y);
            this.pinch.lastMid = { x: midX, y: midY };
            
            // If we are pinching, we skip tool logic for other pointers for clarity
            return;
        }

        // Tool Logic - only if this is the primary pointer
        if (e.pointerId === this.primaryPointerId) {
            const wx = (e.clientX - this.camera.x) / this.camera.zoom;
            const wy = (e.clientY - this.camera.y) / this.camera.zoom;

            // Multi-select hold logic
            if (this.holdStartTime > 0 && !this.isDragSelecting) {
                const elapsed = Date.now() - this.holdStartTime;
                const threshold = this.DRAG_HOLD_THRESHOLD; // use configurable threshold (now 1000ms)
                const maxFingerRadius = 44; // target "finger" size in px

                // If the pointer has moved beyond the allowed stationary threshold since hold start, cancel the hold.
                if (this.holdStartPos) {
                    const moved = Math.hypot(wx - this.holdStartPos.x, wy - this.holdStartPos.y);
                    if (moved > this.DRAG_STATIONARY_THRESHOLD) {
                        this.holdStartTime = 0;
                        this.holdStartPos = null;
                        this.multiSelectSignalRadius = 0;
                    }
                }

                // Only start drag-select if we've both waited long enough AND the pointer remained effectively still.
                const stillEnough = this.holdStartPos ? (Math.hypot(wx - this.holdStartPos.x, wy - this.holdStartPos.y) <= this.DRAG_STATIONARY_THRESHOLD) : true;
                if (elapsed > threshold && stillEnough) {
                    // Begin drag-select and emit a brief selection pulse indicator
                    this.isDragSelecting = true;
                    this.dragSelectStart = { x: wx, y: wy };
                    this.dragSelectEnd = { x: wx, y: wy };
                    this.draggingParts = null; // Cancel current drag
                    this.holdStartTime = 0;
                    this.holdStartPos = null;
                    // quick pulse: duration in ms, store world position for rendering
                    this.selectionPulse = { start: Date.now(), duration: 300, x: wx, y: wy };
                } else {
                    // do not animate gradual radius here; we'll use a brief pulse on activation instead
                }
            }

            if (this.isDragSelecting) {
                this.dragSelectEnd = { x: wx, y: wy };
                return;
            }

            // Update cut preview while dragging when using cut tool (snapped to grid)
            if (this.activeTool === 'cut' && this.cutStart) {
                // only update preview for primary pointer to avoid multi-touch conflicts
                if (e.pointerId === this.primaryPointerId) {
                    const snapped = this.snapToGrid(wx, wy);
                    this.cutPreviewEnd = { x: snapped.x, y: snapped.y };
                }
                return;
            }

            if (this.activeTool === 'draw' && this.drawPath) {
                const last = this.drawPath[this.drawPath.length - 1];
                if (Math.hypot(last.x - wx, last.y - wy) > 2) {
                    this.drawPath.push({ x: wx, y: wy });
                }

                // Live smoothing + grid alignment for preview:
                try {
                    // 1) Simplify the current raw stroke to reduce noise while drawing
                    const smoothed = simplifyPath(this.drawPath, 2.5);

                    // 2) Snap smoothed points to grid
                    const gridSnapped = smoothed.map(v => ({
                        x: Math.round(v.x / GRID_SIZE) * GRID_SIZE,
                        y: Math.round(v.y / GRID_SIZE) * GRID_SIZE
                    }));

                    // 3) Remove consecutive duplicates created by snapping
                    const unique = [];
                    for (let i = 0; i < gridSnapped.length; i++) {
                        const v = gridSnapped[i];
                        if (unique.length === 0 || unique[unique.length - 1].x !== v.x || unique[unique.length - 1].y !== v.y) {
                            unique.push(v);
                        }
                    }

                    // 4) Final light simplification to remove collinear/grid-induced redundancy
                    this.currentDrawPreview = simplifyPath(unique, 0.1);
                } catch (err) {
                    // fallback: no preview
                    this.currentDrawPreview = null;
                }

                return;
            }

            if (this.resizingPart) {
                const rp = this.resizingPart;
                const part = rp.part;
                // If a corner was selected, move that corner to pointer and resize bbox; otherwise scale from center
                if (rp.cornerIndex !== -1 && rp.startVertices && rp.startVertices.length) {
                    // Build start bbox
                    const { minX: sMinX, maxX: sMaxX, minY: sMinY, maxY: sMaxY } = rp.bbox;
                    // current corner target (snap to grid)
                    const target = this.snapToGrid(wx, wy);
                    let newMinX = sMinX, newMaxX = sMaxX, newMinY = sMinY, newMaxY = sMaxY;
                    if (rp.cornerIndex === 0) { newMinX = target.x; newMinY = target.y; }
                    if (rp.cornerIndex === 1) { newMaxX = target.x; newMinY = target.y; }
                    if (rp.cornerIndex === 2) { newMaxX = target.x; newMaxY = target.y; }
                    if (rp.cornerIndex === 3) { newMinX = target.x; newMaxY = target.y; }
                    // Avoid inverted zero-size boxes
                    if (newMaxX - newMinX < 4) {
                        if (rp.cornerIndex === 0 || rp.cornerIndex === 3) newMinX = newMaxX - 4;
                        else newMaxX = newMinX + 4;
                    }
                    if (newMaxY - newMinY < 4) {
                        if (rp.cornerIndex === 0 || rp.cornerIndex === 1) newMinY = newMaxY - 4;
                        else newMaxY = newMinY + 4;
                    }
                    const oldW = sMaxX - sMinX || 1;
                    const oldH = sMaxY - sMinY || 1;
                    const newW = newMaxX - newMinX;
                    const newH = newMaxY - newMinY;
                    const sx = newW / oldW;
                    const sy = newH / oldH;
                    // Apply scale relative to sMinX/sMinY origin
                    rp.startVertices.forEach((v, i) => {
                        const nx = newMinX + (v.x - sMinX) * sx;
                        const ny = newMinY + (v.y - sMinY) * sy;
                        part.vertices[i].x = Math.round(nx / GRID_SIZE) * GRID_SIZE;
                        part.vertices[i].y = Math.round(ny / GRID_SIZE) * GRID_SIZE;
                    });
                    // Update part center position for consistent behavior (recompute centroid)
                    const minX = Math.min(...part.vertices.map(v => v.x));
                    const maxX = Math.max(...part.vertices.map(v => v.x));
                    const minY = Math.min(...part.vertices.map(v => v.y));
                    const maxY = Math.max(...part.vertices.map(v => v.y));
                    part.x = Math.round(((minX + maxX) / 2) / GRID_SIZE) * GRID_SIZE;
                    part.y = Math.round(((minY + maxY) / 2) / GRID_SIZE) * GRID_SIZE;
                } else if (rp.startVertices && rp.startVertices.length) {
                    // Uniform scale from center based on pointer distance (snap scale to 10%)
                    const center = rp.center;
                    const startDistAvg = rp.startVertices.reduce((s,v)=>s+Math.hypot(v.x-center.x,v.y-center.y),0)/rp.startVertices.length || 1;
                    const curDistAvg = rp.startVertices.reduce((s,v,i)=>s+Math.hypot((v.x + (wx - this.lastTouch.x)) - center.x, (v.y + (wy - this.lastTouch.y)) - center.y),0)/rp.startVertices.length;
                    let scale = Math.max(0.1, curDistAvg / startDistAvg);
                    scale = Math.round(scale * 10) / 10;
                    rp.startVertices.forEach((v,i) => {
                        part.vertices[i].x = Math.round((center.x + (v.x - center.x) * scale) / GRID_SIZE) * GRID_SIZE;
                        part.vertices[i].y = Math.round((center.y + (v.y - center.y) * scale) / GRID_SIZE) * GRID_SIZE;
                    });
                    // recalc center
                    const minX = Math.min(...part.vertices.map(v => v.x));
                    const maxX = Math.max(...part.vertices.map(v => v.x));
                    const minY = Math.min(...part.vertices.map(v => v.y));
                    const maxY = Math.max(...part.vertices.map(v => v.y));
                    part.x = Math.round(((minX + maxX) / 2) / GRID_SIZE) * GRID_SIZE;
                    part.y = Math.round(((minY + maxY) / 2) / GRID_SIZE) * GRID_SIZE;
                }
                this.hasUnsavedChanges = true;
                // mark that a resize occurred so we record it on pointer up
                this._resizedDuringInteraction = true;
            } else if (this.draggingVertex) {
                const snapped = this.snapToGrid(wx, wy);
                this.draggingVertex.part.vertices[this.draggingVertex.index] = { x: snapped.x, y: snapped.y };
                // update centroid live while dragging a vertex so editor position stays in sync
                this.updatePartCentroid(this.draggingVertex.part);
                this.hasUnsavedChanges = true;
                this._vertexEditedDuringInteraction = true;
            } else if (this.activeTool === 'wire' && this.wireStartPart) {
                this.tempWireEnd = { x: wx, y: wy };
            } else if (this.draggingParts) {
                this.draggingParts.forEach(dp => {
                    const part = dp.part;
                    const oldX = part.x, oldY = part.y;
                    part.x = wx - dp.offsetX;
                    part.y = wy - dp.offsetY;
                    const snapped = this.snapToGrid(part.x, part.y);
                    const vx = snapped.x - oldX, vy = snapped.y - oldY;
                    part.x = snapped.x;
                    part.y = snapped.y;
                    if (part.vertices) part.vertices.forEach(v => { v.x += vx; v.y += vy; });
                });
                this.hasUnsavedChanges = true;
                // mark moved so we push a single history entry on pointerup
                this._movedDuringInteraction = true;
            } else if (this.panning && this.activePointers.size >= 2) {
                // Safety: panning should only ever happen with two or more fingers,
                // but in practice all two-finger movement is handled in the pinch branch above.
                this.camera.x += dx;
                this.camera.y += dy;
            }
        }
    }

    onPointerUp(e) {
        this.holdStartTime = 0;
        this.multiSelectSignalRadius = 0;

        // If a pending deselect was set on pointerdown and nothing cancelled it, apply it now.
        // However: before clearing selection, ensure there isn't actually a hit-target (part, gizmo, or vertex)
        // under the release point — this prevents deselection when the user intended to start a drag.
        if (this._pendingDeselect) {
            try {
                const pd = this._pendingDeselect;
                // only apply for the same pointer that created the pending deselect (best-effort)
                if (!pd.pointerId || pd.pointerId === e.pointerId) {
                    // compute world coords of release
                    const wx = (e.clientX - this.camera.x) / this.camera.zoom;
                    const wy = (e.clientY - this.camera.y) / this.camera.zoom;

                    // Check for any part directly under the pointer
                    const partUnderPointer = this.getPartAt(wx, wy);

                    // Check whether the pointer lies over any gizmo or vertex of currently selected parts
                    let overSelectedGizmoOrVertex = false;
                    if (this.selectedPartIds && this.selectedPartIds.length > 0) {
                        for (const selId of this.selectedPartIds) {
                            const sel = this.world.parts.find(p => p.id === selId);
                            if (!sel) continue;
                            if (this.isOverGizmo(sel, wx, wy)) { overSelectedGizmoOrVertex = true; break; }
                            if (this.getVertexAt(sel, wx, wy) !== -1) { overSelectedGizmoOrVertex = true; break; }
                        }
                    }

                    // Also allow vertex tool to preserve selection if pointer hits any part (even if not selected)
                    const preserveBecauseVertexTool = (this.activeTool === 'vertex' && partUnderPointer);

                    // If we detected any meaningful target under the pointer, DO NOT deselect.
                    const shouldDeselect = !(partUnderPointer || overSelectedGizmoOrVertex || preserveBecauseVertexTool);

                    if (shouldDeselect) {
                        this.selectedPartId = null;
                        this.selectedPartIds = [];
                    }
                }
            } catch (err) {
                // On error, fallback to previous behavior (safe)
                try { this.selectedPartId = null; this.selectedPartIds = []; } catch (e) {}
            }
            this._pendingDeselect = null;
        }

        if (this.isDragSelecting && this.dragSelectStart && this.dragSelectEnd) {
            const x1 = Math.min(this.dragSelectStart.x, this.dragSelectEnd.x);
            const x2 = Math.max(this.dragSelectStart.x, this.dragSelectEnd.x);
            const y1 = Math.min(this.dragSelectStart.y, this.dragSelectEnd.y);
            const y2 = Math.max(this.dragSelectStart.y, this.dragSelectEnd.y);

            this.selectedPartIds = this.world.parts.filter(p => {
                // Simple rect-in-rect for speed
                const halfW = (p.width || GRID_SIZE) / 2;
                const halfH = (p.height || GRID_SIZE) / 2;
                const px1 = p.x - halfW;
                const px2 = p.x + halfW;
                const py1 = p.y - halfH;
                const py2 = p.y + halfH;
                return px1 >= x1 && px2 <= x2 && py1 >= y1 && py2 <= y2;
            }).map(p => p.id);

            this.isDragSelecting = false;
            this.dragSelectStart = null;
            this.dragSelectEnd = null;
            this.updateSelectionUI();
            return;
        }

        // CUT TOOL: snip polygons along a straight line from cutStart -> release position
        if (this.activeTool === 'cut' && this.cutStart) {
            // Use snapped preview end if present, otherwise compute snapped from release point
            const rawEndWx = (e.clientX - this.camera.x) / this.camera.zoom;
            const rawEndWy = (e.clientY - this.camera.y) / this.camera.zoom;
            const snappedEnd = this.cutPreviewEnd ? { x: this.cutPreviewEnd.x, y: this.cutPreviewEnd.y } : this.snapToGrid(rawEndWx, rawEndWy);

            const A = { x: this.cutStart.x, y: this.cutStart.y };
            const B = { x: snappedEnd.x, y: snappedEnd.y };

            // minimal length to avoid accidental tiny cuts (use grid units)
            if (Math.hypot(B.x - A.x, B.y - A.y) > Math.max(6, GRID_SIZE * 0.2)) {
                // For each polygon part, attempt to split if cut intersects polygon
                for (let pi = this.world.parts.length - 1; pi >= 0; pi--) {
                    const part = this.world.parts[pi];
                    if (!part || !part.vertices || part.vertices.length < 3) continue;

                    const verts = part.vertices;
                    const polyA = [];
                    const polyB = [];

                    for (let i = 0; i < verts.length; i++) {
                        const P = verts[i];
                        const Q = verts[(i + 1) % verts.length];
                        const sP = sideOfLine(A, B, P);
                        const sQ = sideOfLine(A, B, Q);

                        // add current vertex to its side list (vertices on line go to both only if they lie within the finite cut segment)
                        if (Math.abs(sP) < 1e-6) {
                            // include the vertex on both polygons only when it actually lies between A and B
                            if (pointOnSegment(A, B, P)) {
                                polyA.push({ x: P.x, y: P.y });
                                polyB.push({ x: P.x, y: P.y });
                            } else {
                                // treat collinear-but-outside vertices by their side sign to avoid distant duplication
                                if (sP > 0) polyA.push({ x: P.x, y: P.y });
                                else polyB.push({ x: P.x, y: P.y });
                            }
                        } else if (sP > 0) polyA.push({ x: P.x, y: P.y });
                        else polyB.push({ x: P.x, y: P.y });

                        // check for segment intersection (proper crossing)
                        if ((sP > 0 && sQ < 0) || (sP < 0 && sQ > 0)) {
                            const I = segmentIntersection(P, Q, A, B);
                            if (I) {
                                // push intersection to both polygons
                                polyA.push({ x: I.x, y: I.y });
                                polyB.push({ x: I.x, y: I.y });
                            }
                        }
                    }

                    // Clean duplicates and ensure both polys are valid
                    const clean = (arr) => {
                        const out = [];
                        for (let v of arr) {
                            if (out.length === 0 || Math.hypot(out[out.length-1].x - v.x, out[out.length-1].y - v.y) > 1e-6) out.push(v);
                        }
                        // also ensure first != last
                        if (out.length > 1 && Math.hypot(out[0].x - out[out.length-1].x, out[0].y - out[out.length-1].y) < 1e-6) out.pop();
                        return out;
                    };

                    const aClean = clean(polyA);
                    const bClean = clean(polyB);

                    if (aClean.length >= 3 && bClean.length >= 3) {
                        // Replace original part with two new polygon parts
                        const cxA = Math.round((aClean.reduce((s,v)=>s+v.x,0)/aClean.length)/GRID_SIZE)*GRID_SIZE;
                        const cyA = Math.round((aClean.reduce((s,v)=>s+v.y,0)/aClean.length)/GRID_SIZE)*GRID_SIZE;
                        const cxB = Math.round((bClean.reduce((s,v)=>s+v.x,0)/bClean.length)/GRID_SIZE)*GRID_SIZE;
                        const cyB = Math.round((bClean.reduce((s,v)=>s+v.y,0)/bClean.length)/GRID_SIZE)*GRID_SIZE;

                        const partA = {
                            id: Date.now() + Math.floor(Math.random()*1000),
                            type: 'polygon',
                            x: cxA,
                            y: cyA,
                            rotation: 0,
                            width: Math.max(GRID_SIZE, 1),
                            height: Math.max(GRID_SIZE, 1),
                            color: part.color,
                            collision: part.collision,
                            settings: JSON.parse(JSON.stringify(part.settings || {})),
                            vertices: aClean
                        };
                        const partB = {
                            id: Date.now() + Math.floor(Math.random()*1000) + 5000,
                            type: 'polygon',
                            x: cxB,
                            y: cyB,
                            rotation: 0,
                            width: Math.max(GRID_SIZE, 1),
                            height: Math.max(GRID_SIZE, 1),
                            color: part.color,
                            collision: part.collision,
                            settings: JSON.parse(JSON.stringify(part.settings || {})),
                            vertices: bClean
                        };

                        // replace original with new parts
                        this.world.parts.splice(pi, 1, partA, partB);
                        this.hasUnsavedChanges = true;
                        try { this.pushHistory(); } catch (e) {}
                    }
                }
            }

            // clear cut state and preview
            this.cutStart = null;
            this.cutPreviewEnd = null;
            // If any vertex edits occurred during this interaction, commit a single history snapshot
            if (this._vertexEditedDuringInteraction) {
                this.hasUnsavedChanges = true;
                try { this.pushHistory(); } catch (e) {}
                this._vertexEditedDuringInteraction = false;
            }
            // Reset interaction flags
            this.isDragging = false;
            this.draggingVertex = null;
            this.resizingPart = null;
            this.wireStartPart = null;
            this.tempWireEnd = null;
            this.draggingPart = null;
            this.panning = false;
            this.pinch = null;
            return;
        }



        // Existing draw-to-create behavior preserved
        if (this.activeTool === 'draw' && this.drawPath && this.drawPath.length > 3) {
            // Prefer using the live preview if available (it is already smoothed & grid-aligned)
            const finalVerts = (this.currentDrawPreview && this.currentDrawPreview.length >= 3)
                ? this.currentDrawPreview.slice()
                : simplifyPath(this.drawPath, 2.5).map(v => ({
                    x: Math.round(v.x / GRID_SIZE) * GRID_SIZE,
                    y: Math.round(v.y / GRID_SIZE) * GRID_SIZE
                }));

            // Remove consecutive duplicates
            const uniqueVerts = [];
            finalVerts.forEach(v => {
                if (uniqueVerts.length === 0 || uniqueVerts[uniqueVerts.length - 1].x !== v.x || uniqueVerts[uniqueVerts.length - 1].y !== v.y) {
                    uniqueVerts.push(v);
                }
            });

            // Final clean simplification
            const cleanVerts = simplifyPath(uniqueVerts, 0.1);

            if (cleanVerts.length < 3) {
                this.drawPath = null;
                this.currentDrawPreview = null;
                return;
            }

            // Compute bbox & snapped center
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            cleanVerts.forEach(v => { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); });

            const cx = Math.round(((minX + maxX) / 2) / GRID_SIZE) * GRID_SIZE;
            const cy = Math.round(((minY + maxY) / 2) / GRID_SIZE) * GRID_SIZE;

            // Ensure drawn polygons carry an explicit color stored both on part.color and part.settings.color
            const drawDefaultColor = '#3b82f6';
            const newSettings = { color: drawDefaultColor };

            const newPart = {
                id: Date.now(),
                type: 'polygon',
                x: cx,
                y: cy,
                rotation: 0,
                width: Math.max(GRID_SIZE, maxX - minX),
                height: Math.max(GRID_SIZE, maxY - minY),
                color: newSettings.color,
                collision: true,
                settings: newSettings,
                vertices: cleanVerts,
                _isDrawn: true
            };

            this.world.parts.push(newPart);
            // compute and store centroid for exact editor -> play export alignment
            try { this.updatePartCentroid(newPart); } catch (e) { /* ignore */ }
            this.selectedPartId = newPart.id;
            this.hasUnsavedChanges = true;
            try { this.pushHistory(); } catch (e) {}
            this.drawPath = null;
            this.currentDrawPreview = null;
        } else {
            this.drawPath = null;
            this.currentDrawPreview = null;
        }

        // Snap dragging parts on release
        if (this.draggingParts) {
            this.draggingParts.forEach(dp => {
                const part = dp.part;
                const oldX = part.x;
                const oldY = part.y;
                const snapped = this.snapToGrid(part.x, part.y);
                part.x = snapped.x;
                part.y = snapped.y;
                const dx = part.x - oldX;
                const dy = part.y - oldY;
                if (part.vertices) part.vertices.forEach(v => { v.x += dx; v.y += dy; });
            });
            // if any parts moved during this interaction, record a single history snapshot
            if (this._movedDuringInteraction) {
                this.hasUnsavedChanges = true;
                try { this.pushHistory(); } catch (e) {}
            }
            this._movedDuringInteraction = false;
        }

        if (this.activeTool === 'wire' && this.wireStartPart) {
            const wx = (e.clientX - this.camera.x) / this.camera.zoom;
            const wy = (e.clientY - this.camera.y) / this.camera.zoom;
            const endPart = this.getPartAt(wx, wy);
            if (endPart && endPart.id !== this.wireStartPart.id) {
                this.world.wires.push({ from: this.wireStartPart.id, to: endPart.id });
                this.hasUnsavedChanges = true;
                try { this.pushHistory(); } catch (e) {}
            }
        }

        this.isDragging = false;
        this.draggingVertex = null;
        this.resizingPart = null;
        this.wireStartPart = null;
        this.tempWireEnd = null;
        this.draggingParts = null;
        this.panning = false;
        this.pinch = null;
    }

    onWheel(e) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const worldPos = { x: (mx - this.camera.x) / this.camera.zoom, y: (my - this.camera.y) / this.camera.zoom };
        const delta = e.deltaY > 0 ? 0.92 : 1.08;
        // increased upper zoom ceiling from 8 -> 16 for more zoom-in capability
        this.camera.zoom = clamp(this.camera.zoom * delta, 0.4, 16);
        this.camera.x = mx - worldPos.x * this.camera.zoom;
        this.camera.y = my - worldPos.y * this.camera.zoom;
    }

    getPartAt(x, y) {
        // Exact shape hit test: prefer precise checks (point-in-polygon / circle).
        // For simple rect-like parts we transform the test point into the part's local space
        // so rotation is correctly accounted for.
        const touchPoint = { x, y };

        const rotatePointAround = (px, py, cx, cy, angle) => {
            const dx = px - cx;
            const dy = py - cy;
            const s = Math.sin(-angle); // note: we rotate the point by -angle to move into part-local space
            const c = Math.cos(-angle);
            return {
                x: cx + (dx * c - dy * s),
                y: cy + (dx * s + dy * c)
            };
        };

        // iterate in reverse so top-most (recently added) parts get priority
        for (let i = this.world.parts.length - 1; i >= 0; i--) {
            const p = this.world.parts[i];
            if (!p) continue;

            // Circle parts: distance check against declared radius (use GRID_SIZE as default)
            if (p.type === 'circle') {
                const r = (p.radius || GRID_SIZE);
                if (Math.hypot(x - p.x, y - p.y) <= r + 6) return p;
                continue;
            }

            // Polygon parts with explicit vertices: use precise point-in-polygon test (vertices are world-space)
            if (p.vertices && p.vertices.length >= 3) {
                try {
                    if (pointInPolygon(touchPoint, p.vertices)) return p;
                    // continue to next part if not inside
                } catch (e) {
                    // fallthrough to bbox fallback below
                }
            } else {
                // No explicit vertices: treat as rectangle centered at p.x,p.y with width/height but account for rotation.
                const halfW = (p.width || GRID_SIZE) / 2;
                const halfH = (p.height || GRID_SIZE) / 2;

                // Transform test point into part-local (unrotated) space
                const local = rotatePointAround(x, y, p.x || 0, p.y || 0, p.rotation || 0);

                if (local.x >= (p.x - halfW - 6) && local.x <= (p.x + halfW + 6) &&
                    local.y >= (p.y - halfH - 6) && local.y <= (p.y + halfH + 6)) {
                    return p;
                }
            }

            // As a final fallback, allow a small distance to center to account for visual handles
            if (Math.hypot(x - p.x, y - p.y) < GRID_SIZE * 0.6) return p;
        }
        return null;
    }

    getVertexAt(part, x, y) {
        // Return the index of a vertex that's the best hit for point (x,y) or -1.
        if (!part || !Array.isArray(part.vertices) || part.vertices.length === 0) return -1;

        const isTouch = (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 'ontouchstart' in window));
        const zoom = Math.max(0.1, this.camera.zoom || 1);

        // Base visual tolerance in CSS pixels, then convert to world-space by dividing by zoom.
        const baseTolerancePx = isTouch ? 16 : 8; // larger for touch
        const tolerance = (baseTolerancePx / zoom);

        // Also compute a generous gizmo-derived fallback radius (keeps prior behavior)
        const gizmoRadiusFromGizmo = ((GRID_SIZE * 0.9) / zoom) * 2;
        const effectiveRadius = Math.max(tolerance, gizmoRadiusFromGizmo);

        // Helper: distance from point to a segment AB (returns {dist, projT, closestPoint})
        const pointToSegment = (A, B, P) => {
            const vx = B.x - A.x;
            const vy = B.y - A.y;
            const wx = P.x - A.x;
            const wy = P.y - A.y;
            const vv = vx*vx + vy*vy;
            let t = vv > 0 ? ((wx*vx + wy*vy) / vv) : 0;
            t = Math.max(0, Math.min(1, t));
            const cx = A.x + vx * t;
            const cy = A.y + vy * t;
            const d = Math.hypot(P.x - cx, P.y - cy);
            return { dist: d, projT: t, closest: { x: cx, y: cy } };
        };

        const P = { x, y };
        let bestIdx = -1;
        let bestScore = Infinity; // lower is better

        // First pass: prefer exact vertex proximity
        for (let i = 0; i < part.vertices.length; i++) {
            const v = part.vertices[i];
            const d = Math.hypot(v.x - x, v.y - y);
            if (d <= effectiveRadius && d < bestScore) {
                bestScore = d;
                bestIdx = i;
            }
        }

        if (bestIdx !== -1) return bestIdx;

        // Second pass: handle collinear / near-edge taps by checking distance to adjacent segments.
        // If a tap lies very near an edge and is also close to one of the edge endpoints, prefer that endpoint.
        for (let i = 0; i < part.vertices.length; i++) {
            const a = part.vertices[i];
            const b = part.vertices[(i + 1) % part.vertices.length];
            const seg = pointToSegment(a, b, P);
            // allow a slightly larger tolerance for edges (so users can tap on a thin edge)
            const edgeTolerance = Math.max(effectiveRadius * 1.25, GRID_SIZE * 0.15 / zoom);
            if (seg.dist <= edgeTolerance) {
                // if projection is near an endpoint, pick that endpoint (handles colinear cases)
                if (seg.projT <= 0.15) {
                    // near A
                    const da = Math.hypot(a.x - x, a.y - y);
                    if (da < bestScore) { bestScore = da; bestIdx = i; }
                } else if (seg.projT >= 0.85) {
                    // near B
                    const bi = (i + 1) % part.vertices.length;
                    const db = Math.hypot(b.x - x, b.y - y);
                    if (db < bestScore) { bestScore = db; bestIdx = bi; }
                } else {
                    // If projection is in middle of edge, prefer the nearest vertex only if it's still within a forgiving radius.
                    const da = Math.hypot(a.x - x, a.y - y);
                    const db = Math.hypot(b.x - x, b.y - y);
                    const nearestVertDist = Math.min(da, db);
                    if (nearestVertDist <= effectiveRadius * 1.1 && nearestVertDist < bestScore) {
                        bestScore = nearestVertDist;
                        bestIdx = da < db ? i : ((i + 1) % part.vertices.length);
                    }
                }
            }
        }

        // Final: if nothing found, return -1
        return bestIdx !== -1 ? bestIdx : -1;
    }

    // Determine whether a pointer (in world coords) is over the resize gizmos of a part.
    // Gizmo visual size remains as drawn, but hitbox is made more forgiving for touch and stylus users.
    isOverGizmo(part, x, y) {
        // Build world-space corners similar to resize logic so rotation is respected.
        const verts = part.vertices && part.vertices.length ? part.vertices.map(v => ({ x: v.x, y: v.y })) : (()=>{
            const hw = (part.width || GRID_SIZE) / 2;
            const hh = (part.height || GRID_SIZE) / 2;
            const localCorners = [
                { x: -hw, y: -hh },
                { x:  hw, y: -hh },
                { x:  hw, y:  hh },
                { x: -hw, y:  hh }
            ];
            const angle = part.rotation || 0;
            const cx = part.x || 0, cy = part.y || 0;
            const cosA = Math.cos(angle), sinA = Math.sin(angle);
            return localCorners.map(c => ({
                x: cx + c.x * cosA - c.y * sinA,
                y: cy + c.x * sinA + c.y * cosA
            }));
        })();

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        verts.forEach(v => { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); });
        const corners = [
            { x: minX, y: minY }, // top-left
            { x: maxX, y: minY }, // top-right
            { x: maxX, y: maxY }, // bottom-right
            { x: minX, y: maxY }  // bottom-left
        ];

        // Increase gizmo hit radius relative to zoom and allow extra vertical tolerance to account for finger occlusion.
        const isTouch = (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 'ontouchstart' in window));
        const baseMultiplier = isTouch ? 3.0 : 2.0; // extra generous on touch
        const gizmoRadius = (((GRID_SIZE * 0.9) / this.camera.zoom) * baseMultiplier);
        const extraVertical = isTouch ? (18 / this.camera.zoom) : (6 / this.camera.zoom);

        for (let i = 0; i < corners.length; i++) {
            const c = corners[i];
            const dx = Math.abs(c.x - x);
            const dy = Math.abs(c.y - y);
            if (dx <= gizmoRadius && dy <= gizmoRadius + extraVertical) return true;
            if (Math.hypot(c.x - x, c.y - y) <= gizmoRadius) return true;
        }
        return false;
    }

    // Check whether any currently selected part (or the vertex/gizmo areas of them) lies under the given world coordinate.
    // This helps avoid accidental deselection when the user's pointer is slightly below or occluding a vertex/gizmo.
    isOverAnySelectedHitbox(wx, wy) {
        if (!this.selectedPartIds || this.selectedPartIds.length === 0) return false;
        for (const selId of this.selectedPartIds) {
            const part = this.world.parts.find(p => p.id === selId);
            if (!part) continue;
            // generous vertex check
            if (this.getVertexAt(part, wx, wy) !== -1) return true;
            // gizmo check
            if (this.isOverGizmo(part, wx, wy)) return true;
            // conservative shape hit test (point in polygon / bbox) so taps just outside visuals still count
            if (part.vertices && part.vertices.length >= 3) {
                if (pointInPolygon({ x: wx, y: wy }, part.vertices)) return true;
            } else {
                const halfW = (part.width || GRID_SIZE) / 2;
                const halfH = (part.height || GRID_SIZE) / 2;
                if (wx >= part.x - halfW - 8 && wx <= part.x + halfW + 8 && wy >= part.y - halfH - 8 && wy <= part.y + halfH + 8) return true;
            }
            // Also allow a small downward tolerance for finger occlusion (if pointer is slightly below the part center)
            const downTolerance = 18 / (this.camera.zoom || 1);
            if (Math.abs(wx - part.x) < (GRID_SIZE * 0.6) && (wy - part.y) > 0 && (wy - part.y) <= downTolerance) return true;
        }
        return false;
    }

    // Recompute and store a part's centroid without changing part.x/part.y.
    // Vertices remain authoritative in world coordinates; centroid is written to part.centroid.
    updatePartCentroid(part) {
        if (!part || !Array.isArray(part.vertices) || part.vertices.length === 0) return;
        let cx = 0, cy = 0;
        for (let v of part.vertices) { cx += (Number(v.x) || 0); cy += (Number(v.y) || 0); }
        cx /= part.vertices.length;
        cy /= part.vertices.length;
        // Store computed centroid separately so we never override editor-placement coordinates
        part.centroid = { x: cx, y: cy };
    }

    // Ensure a part has a valid number of vertices; if it has 2 or fewer, remove the part entirely.
    ensureValidVertices(part) {
        if (!part) return;
        if (!part.vertices || part.vertices.length <= 2) {
            this.world.parts = this.world.parts.filter(p => p.id !== part.id);
            this.hasUnsavedChanges = true;
        }
    }

    getEdgeAt(part, x, y) {
        // Return the index of the segment (v[i] -> v[i+1]) if the point is near that edge, else -1.
        if (!part || !Array.isArray(part.vertices) || part.vertices.length < 2) return -1;

        const zoom = Math.max(0.1, this.camera.zoom || 1);
        const isTouch = (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 'ontouchstart' in window));
        const baseTolerancePx = isTouch ? 16 : 8;
        const tolerance = Math.max((baseTolerancePx / zoom), (GRID_SIZE * 0.12 / zoom));

        // Helper distance to segment (same as in getVertexAt)
        const pointToSegment = (A, B, P) => {
            const vx = B.x - A.x;
            const vy = B.y - A.y;
            const wx = P.x - A.x;
            const wy = P.y - A.y;
            const vv = vx*vx + vy*vy;
            let t = vv > 0 ? ((wx*vx + wy*vy) / vv) : 0;
            t = Math.max(0, Math.min(1, t));
            const cx = A.x + vx * t;
            const cy = A.y + vy * t;
            const d = Math.hypot(P.x - cx, P.y - cy);
            return { dist: d, projT: t, closest: { x: cx, y: cy } };
        };

        const P = { x, y };
        let bestIdx = -1;
        let bestDist = Infinity;

        for (let i = 0; i < part.vertices.length; i++) {
            const a = part.vertices[i];
            const b = part.vertices[(i + 1) % part.vertices.length];
            const seg = pointToSegment(a, b, P);
            // prefer edges with smaller perpendicular distance, break ties by projection closeness to midpoint
            if (seg.dist <= tolerance && seg.dist < bestDist) {
                bestDist = seg.dist;
                bestIdx = i;
            }
        }

        return bestIdx;
    }

    updateCursor() {
        // Determine cursor based on active tool, hover state and dragging state.
        try {
            const canvas = this.canvas;
            // default
            let cur = 'default';

            // world coords for primary pointer if available
            const p = (this.lastTouch && typeof this.lastTouch.x === 'number') ? { x: (this.lastTouch.x - this.camera.x) / this.camera.zoom, y: (this.lastTouch.y - this.camera.y) / this.camera.zoom } : null;
            const overPart = p ? this.getPartAt(p.x, p.y) : null;

            const tool = (this.activeTool || '').toLowerCase();

            if (tool === 'move') {
                if (this.draggingPart) cur = 'grabbing';
                else if (overPart) cur = 'grab';
                else cur = 'default';
            } else if (tool === 'resize') {
                cur = overPart ? 'nwse-resize' : 'default';
            } else if (tool === 'rotate') {
                cur = overPart ? 'alias' : 'default';
            } else if (tool === 'delete') {
                cur = overPart ? 'not-allowed' : 'default';
            } else if (tool === 'draw') {
                cur = 'crosshair';
            } else if (tool === 'vertex') {
                // over a vertex dot?
                if (overPart) {
                    const vIndex = this.getVertexAt(overPart, p.x, p.y);
                    if (this.draggingVertex) cur = 'grabbing';
                    else if (vIndex !== -1) cur = 'grab';
                    else cur = 'default';
                } else {
                    cur = 'default';
                }
            } else if (tool === 'settings') {
                cur = overPart ? 'help' : 'default';
            } else if (tool === 'wire') {
                if (this.wireStartPart && this.tempWireEnd) cur = 'grabbing';
                else if (overPart) cur = 'pointer';
                else cur = 'default';
            } else {
                cur = 'default';
            }

            // apply to canvas only when changed (avoid thrashing)
            if (canvas && canvas.style && canvas.style.cursor !== cur) {
                canvas.style.cursor = cur;
            }
        } catch (e) {
            // swallow any cursor errors
        }
    }

    updateSelectionUI() {
        const bar = document.getElementById('selection-actions');
        if (this.selectedPartIds.length > 1) {
            bar?.classList.remove('hidden');
        } else {
            bar?.classList.add('hidden');
        }
    }

    massCopy() {
        const newIds = [];
        this.selectedPartIds.forEach(id => {
            const p = this.world.parts.find(part => part.id === id);
            if (p) {
                const copy = JSON.parse(JSON.stringify(p));
                copy.id = Date.now() + Math.random();
                copy.x += GRID_SIZE;
                copy.y += GRID_SIZE;
                if (copy.vertices) copy.vertices.forEach(v => { v.x += GRID_SIZE; v.y += GRID_SIZE; });
                this.world.parts.push(copy);
                newIds.push(copy.id);
            }
        });
        this.selectedPartIds = newIds;
        this.hasUnsavedChanges = true;
        try { this.pushHistory(); } catch (e) {}
        this.updateSelectionUI();
    }

    massDelete() {
        if (!confirm(`Delete ${this.selectedPartIds.length} selected parts?`)) return;
        this.world.parts = this.world.parts.filter(p => !this.selectedPartIds.includes(p.id));
        this.selectedPartIds = [];
        this.hasUnsavedChanges = true;
        try { this.pushHistory(); } catch (e) {}
        this.updateSelectionUI();
    }

    massSettings() {
        const first = this.world.parts.find(p => p.id === this.selectedPartIds[0]);
        if (!first) return;
        
        // Show standard settings modal, but hijack the save logic
        this.app.ui.showPartSettings(first);
        const originalSave = document.getElementById('btn-save-settings').onclick;
        
        document.getElementById('btn-save-settings').onclick = () => {
            // Apply first's final settings to all other selected parts of the same type
            this.selectedPartIds.forEach(id => {
                const p = this.world.parts.find(part => part.id === id);
                if (p && p.id !== first.id && p.type === first.type) {
                    p.settings = JSON.parse(JSON.stringify(first.settings));
                }
            });
            if (originalSave) originalSave();
            // record the mass settings change as a single history entry
            try { this.pushHistory(); } catch (e) {}
        };
    }

    // --- History management (undo / redo) ---
    pushHistory() {
        if (this._suppressHistoryPush) return;
        try {
            const snapshot = JSON.parse(JSON.stringify(this.getWorldData()));
            // avoid pushing duplicates back-to-back
            const last = this._history.past.length ? this._history.past[this._history.past.length - 1] : null;
            if (last && JSON.stringify(last) === JSON.stringify(snapshot)) {
                return;
            }
            this._history.past.push(snapshot);
            // limit history size to avoid unbounded memory usage
            if (this._history.past.length > 80) this._history.past.shift();
            // clear future on new action
            this._history.future = [];
            this.updateUndoRedoUI();
        } catch (e) { /* ignore */ }
    }

    undo() {
        if (!this._history.past.length) return;
        try {
            const current = JSON.parse(JSON.stringify(this.getWorldData()));
            this._history.future.push(current);
            const prev = this._history.past.pop();
            if (prev) {
                this._suppressHistoryPush = true;
                this.world = JSON.parse(JSON.stringify(prev));
                this._suppressHistoryPush = false;
                this.selectedPartId = null;
                this.selectedPartIds = [];
                this.hasUnsavedChanges = true;
                this.updateUndoRedoUI();
            }
        } catch (e) { console.warn('undo failed', e); }
    }

    redo() {
        if (!this._history.future.length) return;
        try {
            const next = this._history.future.pop();
            if (next) {
                this._suppressHistoryPush = true;
                // save current to past before applying redo
                const current = JSON.parse(JSON.stringify(this.getWorldData()));
                this._history.past.push(current);
                this.world = JSON.parse(JSON.stringify(next));
                this._suppressHistoryPush = false;
                this.selectedPartId = null;
                this.selectedPartIds = [];
                this.hasUnsavedChanges = true;
                this.updateUndoRedoUI();
            }
        } catch (e) { console.warn('redo failed', e); }
    }

    updateUndoRedoUI() {
        try {
            const u = document.getElementById('btn-undo');
            const r = document.getElementById('btn-redo');
            if (u) u.disabled = this._history.past.length === 0;
            if (r) r.disabled = this._history.future.length === 0;
        } catch (e) {}
    }

    render() {
        requestAnimationFrame(() => this.render());
        const { ctx, canvas, camera, world } = this;
        
        // Fill canvas with the theme panel color (fall back to dark navy)
        const panelColor = getComputedStyle(document.documentElement).getPropertyValue('--panel')?.trim() || '#071122';
        ctx.fillStyle = panelColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.save();
        ctx.translate(camera.x, camera.y);
        ctx.scale(camera.zoom, camera.zoom);

        this.drawGrid();

        // Draw brief selection pulse when drag-select is triggered
        if (this.selectionPulse) {
            const now = Date.now();
            const elapsed = now - this.selectionPulse.start;
            const dur = Math.max(1, this.selectionPulse.duration || 300);
            const t = Math.min(1, elapsed / dur);
            // grow radius from small to a visible size and fade alpha out
            const minR = 6 / camera.zoom;
            const maxR = 44 / camera.zoom;
            const radius = lerp(minR, maxR, t);
            const alpha = 1 - t;
            let wx = this.selectionPulse.x;
            let wy = this.selectionPulse.y;
            // fallback to lastTouch/world mapping if coordinates missing
            if ((typeof wx !== 'number' || typeof wy !== 'number') && this.lastTouch) {
                wx = (this.lastTouch.x - this.camera.x) / this.camera.zoom;
                wy = (this.lastTouch.y - this.camera.y) / this.camera.zoom;
            } else if ((typeof wx !== 'number' || typeof wy !== 'number') && this.holdStartPos) {
                wx = this.holdStartPos.x;
                wy = this.holdStartPos.y;
            }
            ctx.beginPath();
            ctx.arc(wx, wy, radius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(56,189,248,${0.12 * alpha})`;
            ctx.fill();
            ctx.lineWidth = 1.2 / camera.zoom;
            ctx.strokeStyle = `rgba(56,189,248,${0.9 * alpha})`;
            ctx.stroke();
            if (t >= 1) this.selectionPulse = null;
        }

        // Draw drag selection rectangle
        if (this.isDragSelecting && this.dragSelectStart && this.dragSelectEnd) {
            const x1 = this.dragSelectStart.x;
            const y1 = this.dragSelectStart.y;
            const w = this.dragSelectEnd.x - x1;
            const h = this.dragSelectEnd.y - y1;
            ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
            ctx.fillRect(x1, y1, w, h);
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
            ctx.lineWidth = 1.5 / camera.zoom;
            ctx.setLineDash([5 / camera.zoom, 5 / camera.zoom]);
            ctx.strokeRect(x1, y1, w, h);
            ctx.setLineDash([]);
        }

        // Draw active Lasso path
        if (this.drawPath && this.drawPath.length > 1) {
            // raw stroke (hand-drawn) for immediate feedback
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.8)';
            ctx.lineWidth = 3 / camera.zoom;
            ctx.setLineDash([5 / camera.zoom, 5 / camera.zoom]);
            ctx.moveTo(this.drawPath[0].x, this.drawPath[0].y);
            for (let i = 1; i < this.drawPath.length; i++) {
                ctx.lineTo(this.drawPath[i].x, this.drawPath[i].y);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            // Use the live smoothed & grid-aligned preview for a filled preview when available
            const previewVerts = (this.currentDrawPreview && this.currentDrawPreview.length > 2) ? this.currentDrawPreview : null;
            if (previewVerts) {
                ctx.beginPath();
                ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
                ctx.moveTo(previewVerts[0].x, previewVerts[0].y);
                for (let i = 1; i < previewVerts.length; i++) ctx.lineTo(previewVerts[i].x, previewVerts[i].y);
                ctx.closePath();
                ctx.fill();

                // also draw the smoothed outline
                ctx.beginPath();
                ctx.strokeStyle = 'rgba(20,115,220,0.9)';
                ctx.lineWidth = 2 / camera.zoom;
                ctx.moveTo(previewVerts[0].x, previewVerts[0].y);
                for (let i = 1; i < previewVerts.length; i++) ctx.lineTo(previewVerts[i].x, previewVerts[i].y);
                ctx.closePath();
                ctx.stroke();
            } else {
                // Fill area preview fallback (no smoothing available)
                ctx.beginPath();
                ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
                // create a closed shape from the raw stroke for a lightweight preview
                ctx.moveTo(this.drawPath[0].x, this.drawPath[0].y);
                for (let i = 1; i < this.drawPath.length; i++) ctx.lineTo(this.drawPath[i].x, this.drawPath[i].y);
                ctx.closePath();
                ctx.fill();
            }
        }

        // Draw cut preview indicator when in CUT tool: translucent, width-scaled line
        if (this.activeTool === 'cut' && this.cutStart && this.cutPreviewEnd) {
            try {
                ctx.save();
                const A = this.cutStart;
                const B = this.cutPreviewEnd;
                const dx = B.x - A.x;
                const dy = B.y - A.y;
                const dist = Math.hypot(dx, dy);
                // scale width with distance but clamp and normalize by camera zoom
                const base = Math.max(2, Math.min(48, dist / 20));
                ctx.lineWidth = (base) / Math.max(0.0001, camera.zoom);
                ctx.strokeStyle = 'rgba(239,68,68,0.35)';
                ctx.setLineDash([8 / camera.zoom, 6 / camera.zoom]);
                ctx.beginPath();
                ctx.moveTo(A.x, A.y);
                ctx.lineTo(B.x, B.y);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();
            } catch (e) {
                // ignore render errors for preview
            }
        }

        // Draw Wires
        ctx.strokeStyle = '#6366f1';
        ctx.lineWidth = 2;
        world.wires.forEach(w => {
            const p1 = world.parts.find(p => p.id === w.from);
            const p2 = world.parts.find(p => p.id === w.to);
            if (p1 && p2) {
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.stroke();
            }
        });

        // Draw latest marble trails from last play run if available and enabled
        try {
            const app = this.app;
            const show = app && app.showMarbleTrails;
            const trails = app && app.latestMarbleTrails;
            if (show && Array.isArray(trails) && trails.length > 0) {
                ctx.save();
                // draw semi-transparent lines, newest samples on top; cap sample density for performance
                trails.forEach(tr => {
                    if (!tr.points || tr.points.length < 2) return;
                    ctx.beginPath();
                    // use last known color if available
                    const c = (tr.points[0] && tr.points[0].color) || '#ffffff';
                    ctx.strokeStyle = (typeof c === 'string' && c.indexOf('linear-gradient') === -1) ? c : '#ffffff';
                    ctx.lineWidth = 2 / camera.zoom;
                    ctx.globalAlpha = 0.9;
                    ctx.moveTo(tr.points[0].x, tr.points[0].y);
                    // draw downsampled to avoid too many segments
                    const step = Math.max(1, Math.floor(tr.points.length / 400));
                    for (let i = step; i < tr.points.length; i += step) {
                        ctx.lineTo(tr.points[i].x, tr.points[i].y);
                    }
                    // ensure final point connected
                    const last = tr.points[tr.points.length - 1];
                    if (last) ctx.lineTo(last.x, last.y);
                    ctx.stroke();
                });
                ctx.restore();
            }
        } catch (e) {
            // don't break editor render on trail drawing errors
        }

        if (this.tempWireEnd && this.wireStartPart) {
            ctx.beginPath();
            ctx.setLineDash([5, 5]);
            ctx.moveTo(this.wireStartPart.x, this.wireStartPart.y);
            ctx.lineTo(this.tempWireEnd.x, this.tempWireEnd.y);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Draw Parts
        world.parts.forEach(p => {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rotation);
            
            const isSelected = this.selectedPartIds.includes(p.id);
            // Prefer explicit part color, then settings.color, then sensible defaults so polygons use chosen color
            // Prefer explicit color set on the part, then settings.color; fall back to sensible defaults.
            let fill = p.color || (p.settings && p.settings.color) || null;
            if (!fill) {
                if (p.type === 'win_zone') fill = 'rgba(34, 197, 94, 0.5)';
                else if (p.type === 'spawn_point') fill = 'rgba(249, 115, 22, 0.8)';
                else if (p.type === 'teleporter') fill = 'rgba(168, 85, 247, 0.8)';
                else fill = '#3b82f6';
            }
            // If this part is selected and no explicit color was provided, slightly brighten for visibility.
            if (this.selectedPartIds && this.selectedPartIds.includes && this.selectedPartIds.includes(p.id) && (!p.color && !(p.settings && p.settings.color))) {
                // simple brighten by using a highlighted color
                fill = (p.color || (p.settings && p.settings.color)) || '#60a5fa';
            }
            ctx.fillStyle = fill;

            if (p.type === 'circle') {
                ctx.beginPath();
                ctx.arc(0, 0, GRID_SIZE, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.vertices && p.vertices.length > 0) {
                // Always render the authoritative vertices to avoid visual simplification
                const drawVerts = p.vertices;
                ctx.beginPath();
                drawVerts.forEach((v, i) => {
                    const vx = v.x - p.x;
                    const vy = v.y - p.y;
                    if (i === 0) ctx.moveTo(vx, vy);
                    else ctx.lineTo(vx, vy);
                });
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = '#1d4ed8';
                ctx.stroke();
            }
            
            ctx.restore();

            // Fan visual: direction arrow showing blow angle & force/range when part is a fan
            if (p.type === 'fan') {
                try {
                    const dir = (p.settings && typeof p.settings.direction === 'number') ? p.settings.direction : -Math.PI/2;
                    const force = (p.settings && typeof p.settings.force === 'number') ? Math.max(0, p.settings.force) : 0.12;
                    const range = (p.settings && typeof p.settings.range === 'number') ? Math.max(20, p.settings.range) : (GRID_SIZE * 6);

                    // draw cone
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate(dir);
                    ctx.beginPath();
                    const coneHalf = Math.PI / 8; // visual half-angle
                    ctx.moveTo(0, 0);
                    ctx.arc(0, 0, range, -coneHalf, coneHalf);
                    ctx.closePath();
                    ctx.fillStyle = 'rgba(56,189,248,0.08)';
                    ctx.fill();

                    // draw central arrow scaled by force
                    const arrowLen = Math.min(range, 20 + force * 200);
                    ctx.strokeStyle = 'rgba(56,189,248,0.95)';
                    ctx.fillStyle = 'rgba(56,189,248,0.95)';
                    ctx.lineWidth = Math.max(1 / camera.zoom, 1.2);
                    ctx.beginPath();
                    ctx.moveTo(0, 0);
                    ctx.lineTo(arrowLen, 0);
                    ctx.stroke();

                    // arrow head
                    ctx.beginPath();
                    ctx.moveTo(arrowLen, 0);
                    ctx.lineTo(arrowLen - 8 / camera.zoom, -6 / camera.zoom);
                    ctx.lineTo(arrowLen - 8 / camera.zoom, 6 / camera.zoom);
                    ctx.closePath();
                    ctx.fill();
                    ctx.restore();
                } catch (e) {
                    // fail safe - do not break render loop
                }
            }

            // Resize tool feedback & corner gizmos
            if (this.activeTool === 'resize' && isSelected && this.selectedPartIds.length === 1) {
                // compute bbox
                const verts = p.vertices && p.vertices.length ? p.vertices : [
                    { x: p.x - (p.width||GRID_SIZE)/2, y: p.y - (p.height||GRID_SIZE)/2 },
                    { x: p.x + (p.width||GRID_SIZE)/2, y: p.y - (p.height||GRID_SIZE)/2 },
                    { x: p.x + (p.width||GRID_SIZE)/2, y: p.y + (p.height||GRID_SIZE)/2 },
                    { x: p.x - (p.width||GRID_SIZE)/2, y: p.y + (p.height||GRID_SIZE)/2 }
                ];
                const minX = Math.min(...verts.map(v=>v.x));
                const maxX = Math.max(...verts.map(v=>v.x));
                const minY = Math.min(...verts.map(v=>v.y));
                const maxY = Math.max(...verts.map(v=>v.y));

                // draw bbox
                ctx.strokeStyle = 'rgba(255,255,255,0.7)';
                ctx.lineWidth = 2 / camera.zoom;
                ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
                ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
                ctx.setLineDash([]);

                // draw 4 corner gizmos (sized relative to GRID_SIZE and zoom)
                const gizmoSize = Math.max((GRID_SIZE * 0.3) / camera.zoom, 6);
                const corners = [
                    { x: minX, y: minY },
                    { x: maxX, y: minY },
                    { x: maxX, y: maxY },
                    { x: minX, y: maxY }
                ];
                corners.forEach(c => {
                    ctx.fillStyle = 'rgba(96,165,250,0.95)';
                    ctx.beginPath();
                    ctx.rect(c.x - gizmoSize, c.y - gizmoSize, gizmoSize*2, gizmoSize*2);
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(2,6,23,0.6)';
                    ctx.lineWidth = 1 / camera.zoom;
                    ctx.stroke();
                });
            }

            // Vertex Editor Overlays
            if (this.vertexEditing === p.id) {
                // Visual radius for the vertex dot
                const visualRadius = 6 / camera.zoom;
                p.vertices.forEach(v => {
                    ctx.fillStyle = '#ef4444';
                    ctx.beginPath();
                    ctx.arc(v.x, v.y, visualRadius, 0, Math.PI * 2);
                    ctx.fill();
                });
                // Draw edge midpoints (visual only)
                for (let i = 0; i < p.vertices.length; i++) {
                    const v1 = p.vertices[i];
                    const v2 = p.vertices[(i + 1) % p.vertices.length];
                    ctx.fillStyle = 'rgba(239, 68, 68, 0.5)';
                    ctx.beginPath();
                    ctx.arc((v1.x+v2.x)/2, (v1.y+v2.y)/2, 4 / camera.zoom, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        });

        ctx.restore();

        // update cursor state each frame (reflect hover / dragging)
        this.updateCursor();
    }

    drawGrid() {
        // Dark, crisp grid aligned to pixels (uses 0.5 offset for sharp single-pixel lines)
        const { ctx, canvas, camera } = this;
        const topLeftWorldX = (-camera.x) / camera.zoom;
        const topLeftWorldY = (-camera.y) / camera.zoom;
        const bottomRightWorldX = (canvas.width - camera.x) / camera.zoom;
        const bottomRightWorldY = (canvas.height - camera.y) / camera.zoom;

        const startX = Math.floor(topLeftWorldX / GRID_SIZE) * GRID_SIZE;
        const startY = Math.floor(topLeftWorldY / GRID_SIZE) * GRID_SIZE;
        const endX = Math.ceil(bottomRightWorldX / GRID_SIZE) * GRID_SIZE;
        const endY = Math.ceil(bottomRightWorldY / GRID_SIZE) * GRID_SIZE;

        // Draw subtle main grid lines (increased opacity for visibility)
        ctx.save();
        const pxOffset = 0.5 / camera.zoom;
        ctx.translate(pxOffset, pxOffset);

        ctx.lineWidth = 1 / camera.zoom;
        ctx.strokeStyle = 'rgba(255,255,255,0.06)'; // made stronger
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

        // stronger major grid lines every 4 cells for orientation (increased opacity)
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

    onOpen() {
        this.resize();
    }

    createNewWorld() {
        // Stop any running simulation to ensure physics bodies and related resources are cleared.
        try {
            if (this.app && this.app.simulation && typeof this.app.simulation.stop === 'function') {
                this.app.simulation.stop();
            }
        } catch (e) { /* ignore stop errors */ }

        // Clear editor-side polling to avoid lingering timers referencing old world objects.
        try {
            if (this._resizePoll) {
                clearInterval(this._resizePoll);
                this._resizePoll = null;
            }
        } catch (e) { /* ignore */ }

        // Reset world and editor state
        this.world = { 
            id: Date.now(),
            name: 'New Race ' + new Date().toLocaleTimeString(), 
            parts: [], 
            wires: [],
            created: Date.now()
        };
        this.hasUnsavedChanges = false;
        this.camera = { x: 0, y: 0, zoom: 1 };

        // Clear interaction state to avoid holding references to old parts
        this.selectedPartId = null;
        this.vertexEditing = null;
        this.drawPath = null;
        this.currentDrawPreview = null;
        this.draggingPart = null;
        this.draggingVertex = null;
        this.resizingPart = null;
        this.wireStartPart = null;
        this.tempWireEnd = null;

        // Record the fresh world as the base history snapshot so Undo has a meaningful origin.
        try {
            // ensure we don't create duplicate identical snapshots
            this.pushHistory();
            this.updateUndoRedoUI();
        } catch (e) {
            console.warn('createNewWorld history push failed', e);
        }
    }

    getWorldData() {
        // Compute precise centroid without moving the bodies in the editor itself.
        const world = this.world || { parts: [], wires: [] };

        const clonePart = (p) => {
            // Calculate actual centroid from raw vertices if they exist
            let computedCentroid = null;
            if (Array.isArray(p.vertices) && p.vertices.length) {
                let sumX = 0, sumY = 0;
                p.vertices.forEach(v => { sumX += v.x; sumY += v.y; });
                computedCentroid = { x: sumX / p.vertices.length, y: sumY / p.vertices.length };
            }

            return {
                ...JSON.parse(JSON.stringify(p)),
                // Export centroid and original positions exactly
                centroid: computedCentroid,
                x: Number(p.x),
                y: Number(p.y),
                vertices: Array.isArray(p.vertices) ? p.vertices.map(v => ({ x: Number(v.x), y: Number(v.y) })) : null
            };
        };

        return {
            ...JSON.parse(JSON.stringify(world)),
            parts: (world.parts || []).map(clonePart)
        };
    }
}