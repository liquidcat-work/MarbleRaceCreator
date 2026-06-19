export class UI {
    constructor(app) {
        this.app = app;
        // Central marble palette used everywhere (rendering, select all, etc.)
        this.marbleColors = ['Red','Orange','Yellow','Lime','Green','Teal','Cyan','Blue','Indigo','Purple','Lavender','Pink','Magenta','Peach','Brown','Silver','Gold','Black','White','Gray','Rainbow','Monochrome','Metallic'];
        this.setupGeneralEvents();
        // Poll database usage every 30 seconds and keep a reference so it can be cleared if needed
        this._dbAutoPoll = setInterval(() => {
            try { this.updateDatabaseUsage(); } catch (e) { /* ignore */ }
        }, 30000);
    }

    setupGeneralEvents() {
        document.getElementById('btn-results-close').addEventListener('click', () => {
            this.app.exitToMain();
            this.hideModals();
        });

        // Music manager: load tracks, persist selection & volume
        try {
            // available track filenames (must match project assets)
            this._musicTracks = {
                'Wii Party Soundtrack - Main Menu Music.mp3': '/Wii Party Soundtrack - Main Menu Music.mp3',
                'Background Music.m4a': '/Background Music.m4a',
                'Windows XP installation music [HD].mp3': '/Windows XP installation music [HD].mp3'
            };

            // create single audio element and reuse it
            this._musicAudio = new Audio();
            this._musicAudio.loop = true;
            this._musicAudio.preload = 'metadata';

            // apply saved music state
            const saved = (this.app && this.app.storage && typeof this.app.storage.loadMusicChoice === 'function') ? this.app.storage.loadMusicChoice() : null;
            const initialTrack = saved?.track || 'none';
            const initialVolume = (typeof saved?.volume === 'number') ? saved.volume : (document.getElementById('setting-music') ? parseInt(document.getElementById('setting-music').value, 10) / 100 : 0.5);

            // set UI to reflect saved
            const sel = document.getElementById('setting-music-track');
            if (sel) sel.value = initialTrack;

            const volEl = document.getElementById('setting-music');
            if (volEl) volEl.value = Math.round((initialVolume || 0) * 100);

            // helper to persist state
            const persistMusicState = (track, volume) => {
                try {
                    if (this.app && this.app.storage && typeof this.app.storage.saveMusicChoice === 'function') {
                        this.app.storage.saveMusicChoice({ track: track || 'none', volume: Number(volume) });
                    }
                } catch (e) {}
            };

            // track selection handler
            if (sel) {
                sel.addEventListener('change', (ev) => {
                    const t = ev.target.value;
                    if (!t || t === 'none') {
                        try { this._musicAudio.pause(); this._musicAudio.src = ''; } catch (e) {}
                        persistMusicState('none', (volEl ? (parseInt(volEl.value,10)/100) : initialVolume));
                        return;
                    }
                    const url = this._musicTracks[t];
                    if (url) {
                        // safe load & play (user gesture may be required by browser)
                        try {
                            this._musicAudio.src = url;
                            this._musicAudio.volume = (volEl ? parseInt(volEl.value,10)/100 : initialVolume);
                            const playPromise = this._musicAudio.play();
                            if (playPromise && playPromise.catch) playPromise.catch(() => { /* autoplay blocked; OK */ });
                        } catch (e) { console.warn('Music play failed', e); }
                        persistMusicState(t, (volEl ? (parseInt(volEl.value,10)/100) : initialVolume));
                    }
                });
            }

            // volume slider handler
            if (volEl) {
                volEl.addEventListener('input', (ev) => {
                    const v = Math.max(0, Math.min(100, parseInt(ev.target.value, 10))) / 100;
                    try { if (this._musicAudio) this._musicAudio.volume = v; } catch (e) {}
                    const curTrack = (document.getElementById('setting-music-track') || {}).value || 'none';
                    persistMusicState(curTrack, v);
                });
            }

            // Initialize audio source if saved track present
            if (initialTrack && initialTrack !== 'none' && this._musicTracks[initialTrack]) {
                this._musicAudio.src = this._musicTracks[initialTrack];
                this._musicAudio.volume = initialVolume;
                // try to play once on init (may be blocked until user interacts)
                try { const p = this._musicAudio.play(); if (p && p.catch) p.catch(()=>{}); } catch (e) {}
            }
        } catch (err) { console.warn('Music manager init failed', err); }

        // Debug collider setting: reflect saved state and wire change
        try {
            const debugEl = document.getElementById('setting-debug-collider');
            if (debugEl) {
                const savedDebug = (this.app && this.app.storage && typeof this.app.storage.loadDebugRenderCollider === 'function') ? this.app.storage.loadDebugRenderCollider() : false;
                debugEl.checked = !!savedDebug;
                // reflect into sim if available
                if (this.app && this.app.simulation) this.app.simulation.debugRenderColliders = !!savedDebug;

                debugEl.addEventListener('change', (ev) => {
                    const enabled = !!ev.target.checked;
                    try {
                        if (this.app && this.app.storage && typeof this.app.storage.saveDebugRenderCollider === 'function') {
                            this.app.storage.saveDebugRenderCollider(enabled);
                        }
                    } catch (e) {}
                    if (this.app && this.app.simulation) this.app.simulation.debugRenderColliders = enabled;
                });
            }
        } catch (e) { /* ignore debug wiring failures */ }

        // Show marble trails toggle (persistent only for session)
        try {
            const trailEl = document.getElementById('setting-show-trails');
            if (trailEl) {
                // default off
                this.app.showMarbleTrails = !!(this.app.showMarbleTrails);
                trailEl.checked = !!this.app.showMarbleTrails;
                trailEl.addEventListener('change', (ev) => {
                    this.app.showMarbleTrails = !!ev.target.checked;
                    // force a re-render of editor so trails appear/disappear immediately
                    try { if (this.app && this.app.editor) this.app.editor.render(); } catch (e) {}
                });
            }
        } catch (e) { /* ignore */ }

        document.getElementById('btn-results-editor').addEventListener('click', () => {
            this.app.stopRace();
            this.hideModals();
        });

        document.getElementById('btn-save-world').addEventListener('click', () => {
            document.getElementById('save-world-modal').classList.remove('hidden');
            document.getElementById('modal-overlay').classList.remove('hidden');
            document.getElementById('input-world-name').value = this.app.editor.world.name;
        });

        document.getElementById('btn-confirm-save').addEventListener('click', () => {
            // Use editor.getWorldData() to capture an exact, un-quantized snapshot of the editor geometry
            // so saved worlds and play-mode receive a one-to-one copy of shapes and centroids.
            try {
                const inputName = document.getElementById('input-world-name').value || (this.app.editor.world && this.app.editor.world.name) || '';
                const copy = (this.app && this.app.editor && typeof this.app.editor.getWorldData === 'function')
                    ? this.app.editor.getWorldData()
                    : JSON.parse(JSON.stringify(this.app.editor.world));
                copy.name = inputName || copy.name;
                this.app.storage.saveWorld(copy);
                this.app.editor.hasUnsavedChanges = false;
            } catch (err) {
                // fallback to original world object if snapshotting fails
                this.app.editor.world.name = document.getElementById('input-world-name').value;
                this.app.storage.saveWorld(this.app.editor.world);
                this.app.editor.hasUnsavedChanges = false;
            }
            this.hideModals();
        });

        document.getElementById('btn-cancel-save').addEventListener('click', () => this.hideModals());

        // 4K screenshot of the play canvas (captures the play canvas only, no UI)
        const screenshotBtn = document.getElementById('btn-screenshot');
        if (screenshotBtn) {
            screenshotBtn.addEventListener('click', async () => {
                try {
                    const playCanvas = document.getElementById('play-canvas');
                    if (!playCanvas) return alert('Play canvas not found.');

                    // Desired 4K resolution
                    const targetW = 3840;
                    const targetH = 2160;

                    // Create an offscreen canvas and draw the play canvas scaled to 4K
                    const off = document.createElement('canvas');
                    off.width = targetW;
                    off.height = targetH;
                    const octx = off.getContext('2d');
                    if (!octx) return alert('Unable to create canvas context.');

                    // Fill background to avoid transparency artifacts
                    octx.fillStyle = '#000';
                    octx.fillRect(0, 0, targetW, targetH);

                    // Draw source canvas into the target, scaling to fit 4K
                    // Use source pixel size (playCanvas.width/height) so we scale correctly
                    octx.drawImage(playCanvas, 0, 0, playCanvas.width, playCanvas.height, 0, 0, targetW, targetH);

                    // Convert to blob and trigger download
                    off.toBlob((blob) => {
                        if (!blob) return alert('Failed to create image blob.');
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `marble_race_${Date.now()}.png`;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(() => URL.revokeObjectURL(url), 2000);
                    }, 'image/png', 1);
                } catch (err) {
                    console.error('Screenshot failed', err);
                    alert('Screenshot failed. See console.');
                }
            });
        }

        // Hide UI in Play Mode checkbox wiring (persisted)
        try {
            const chk = document.getElementById('chk-hide-ui-play');
            const playView = document.getElementById('play-view');
            if (chk && playView) {
                // initialize from localStorage
                const saved = localStorage.getItem('hide_ui_play');
                const enabled = saved === '1';
                chk.checked = enabled;
                if (enabled) playView.classList.add('hide-ui');

                chk.addEventListener('change', (ev) => {
                    const on = !!ev.target.checked;
                    if (on) playView.classList.add('hide-ui');
                    else playView.classList.remove('hide-ui');
                    try { localStorage.setItem('hide_ui_play', on ? '1' : '0'); } catch (e) {}
                });
            }
        } catch (e) { /* ignore hookup failures */ }

        // Select All / Deselect All for marbles
        const btnSelectAll = document.getElementById('btn-select-all');
        const btnDeselectAll = document.getElementById('btn-deselect-all');
        if (btnSelectAll) {
            btnSelectAll.addEventListener('click', () => {
                // use centralized palette so selections match what's rendered
                const colors = Array.isArray(this.marbleColors) ? this.marbleColors.slice() : [];
                this.app.selectedMarbles = [...colors];
                try { if (this.app.storage && typeof this.app.storage.saveMarbleSelection === 'function') this.app.storage.saveMarbleSelection(this.app.selectedMarbles); } catch (e) {}
                this.renderMarbles();
            });
        }
        if (btnDeselectAll) {
            btnDeselectAll.addEventListener('click', () => {
                this.app.selectedMarbles = [];
                try { if (this.app.storage && typeof this.app.storage.saveMarbleSelection === 'function') this.app.storage.saveMarbleSelection(this.app.selectedMarbles); } catch (e) {}
                this.renderMarbles();
            });
        }

        // Create Marble button: open modal to author a custom marble (solid / rainbow / monochrome)
        const createBtn = document.getElementById('btn-create-marble');
        if (createBtn) {
            createBtn.addEventListener('click', () => {
                // open the modal in "create new" mode (no existing descriptor, index = null)
                this.openCustomMarbleModal(null, null);
            });
        }

        // Helper: open/create/edit custom marble modal
        // descriptor: either null for new or an object from this.marbleColors; index: integer index in marbleColors when editing
        this.openCustomMarbleModal = (descriptor = null, index = null) => {
            const modalId = 'custom-marble-modal';
            document.getElementById(modalId)?.remove();

            const modal = document.createElement('div');
            modal.id = modalId;
            modal.className = 'modal';
            modal.style.maxWidth = '520px';
            modal.innerHTML = `
                <div class="modal-content">
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <h3>${descriptor ? 'Edit Marble' : 'Create Marble'}</h3>
                    <button id="${modalId}-close" class="secondary-btn">Close</button>
                  </div>
                  <div style="display:flex;gap:12px;flex-direction:column;margin-top:8px;">
                    <label>Name</label>
                    <input type="text" id="${modalId}-name" placeholder="My Marble">
                    <label>Type</label>
                    <select id="${modalId}-type" aria-label="Marble type">
                      <option value="solid">Solid</option>
                      <option value="rainbow">Rainbow (multi-color lerp)</option>
                      <option value="monochrome">Monochrome (2-color lerp)</option>
                    </select>

                    <div id="${modalId}-solid-controls">
                      <label>Color</label>
                      <input type="color" id="${modalId}-color1" value="#ff0000">
                    </div>

                    <div id="${modalId}-mono-controls" class="hidden">
                      <label>Color A</label>
                      <input type="color" id="${modalId}-mono-a" value="#ffffff">
                      <label>Color B</label>
                      <input type="color" id="${modalId}-mono-b" value="#000000">
                    </div>

                    <div id="${modalId}-rain-controls" class="hidden">
                      <label>Colors (comma separated hex) — example: #ff0000,#00ff00,#0000ff</label>
                      <input type="text" id="${modalId}-rain-list" placeholder="#ff0000,#ff8000,#ffff00,#00ff00">
                    </div>

                    <label>Shininess (0-100)</label>
                    <input type="range" id="${modalId}-shininess" min="0" max="100" value="50">

                    <label>Bounciness (0-100%)</label>
                    <input type="range" id="${modalId}-bounciness" min="0" max="100" value="50">

                    <div style="display:flex;gap:8px;align-items:center;">
                      <canvas id="${modalId}-preview" width="120" height="120" style="border:1px solid rgba(0,0,0,0.06);border-radius:8px;background:#fff"></canvas>
                      <div style="flex:1">
                        <button id="${modalId}-save" class="primary-btn" style="width:100%;">${descriptor ? 'Save Changes' : 'Save Marble'}</button>
                      </div>
                    </div>
                  </div>
                </div>
            `;
            document.body.appendChild(modal);
            document.getElementById('modal-overlay').classList.remove('hidden');

            const selType = document.getElementById(`${modalId}-type`);
            const solidControls = document.getElementById(`${modalId}-solid-controls`);
            const monoControls = document.getElementById(`${modalId}-mono-controls`);
            const rainControls = document.getElementById(`${modalId}-rain-controls`);
            const preview = document.getElementById(`${modalId}-preview`);
            const ctx = preview.getContext('2d');

            // populate fields if editing
            if (descriptor && typeof descriptor === 'object') {
                const meta = descriptor.meta || {};
                document.getElementById(`${modalId}-name`).value = descriptor.label || meta.name || '';
                const t = meta.type || descriptor.meta?.type || 'solid';
                selType.value = t;
                if (t === 'solid') document.getElementById(`${modalId}-color1`).value = this._normalizeColorForInput(meta.color || descriptor.css || '#ff0000');
                if (t === 'monochrome') {
                    document.getElementById(`${modalId}-mono-a`).value = this._normalizeColorForInput(meta.a || '#ffffff');
                    document.getElementById(`${modalId}-mono-b`).value = this._normalizeColorForInput(meta.b || '#000000');
                }
                if (t === 'rainbow') {
                    document.getElementById(`${modalId}-rain-list`).value = (meta.colors && meta.colors.join(',')) || '';
                }
                document.getElementById(`${modalId}-shininess`).value = Math.round((meta.shininess || 0.5) * 100);
                document.getElementById(`${modalId}-bounciness`).value = Math.round((meta.bounciness || 0) * 100);
            }

            const updateVisibility = () => {
                const v = selType.value;
                solidControls.classList.toggle('hidden', v !== 'solid');
                monoControls.classList.toggle('hidden', v !== 'monochrome');
                rainControls.classList.toggle('hidden', v !== 'rainbow');
                renderPreview();
            };

            const bindPreviewInputs = () => {
                selType.addEventListener('change', updateVisibility);
                document.getElementById(`${modalId}-color1`).addEventListener('input', renderPreview);
                document.getElementById(`${modalId}-mono-a`).addEventListener('input', renderPreview);
                document.getElementById(`${modalId}-mono-b`).addEventListener('input', renderPreview);
                document.getElementById(`${modalId}-rain-list`).addEventListener('input', renderPreview);
                document.getElementById(`${modalId}-shininess`).addEventListener('input', renderPreview);
                document.getElementById(`${modalId}-bounciness`).addEventListener('input', renderPreview);
            };

            bindPreviewInputs();

            document.getElementById(`${modalId}-close`).addEventListener('click', () => {
                modal.remove();
                document.getElementById('modal-overlay').classList.add('hidden');
            });

            function hexToRgb(hex) {
                const h = hex.replace('#','');
                return { r: parseInt(h.substring(0,2),16), g: parseInt(h.substring(2,4),16), b: parseInt(h.substring(4,6),16) };
            }
            function lerpColor(a,b,t) {
                return {
                  r: Math.round(a.r + (b.r - a.r) * t),
                  g: Math.round(a.g + (b.g - a.g) * t),
                  b: Math.round(a.b + (b.b - a.b) * t)
                };
            }
            function rgbToCss(c) { return `rgb(${c.r},${c.g},${c.b})`; }

            function renderPreview() {
                // clear
                ctx.clearRect(0,0,preview.width,preview.height);
                // draw simple sphere with gradient based on type
                const type = selType.value;
                const shininess = Number(document.getElementById(`${modalId}-shininess`).value) / 100;
                const bounc = Number(document.getElementById(`${modalId}-bounciness`).value) / 100;

                const cx = preview.width/2;
                const cy = preview.height/2;
                const r = Math.min(preview.width, preview.height)/2 - 6;

                if (type === 'solid') {
                    const c = hexToRgb(document.getElementById(`${modalId}-color1`).value || '#ff0000');
                    const grad = ctx.createRadialGradient(cx - r*0.25, cy - r*0.25, r*0.05, cx, cy, r);
                    const center = { r: Math.min(255, Math.round(c.r + (255 - c.r) * shininess)), g: Math.min(255, Math.round(c.g + (255 - c.g) * shininess)), b: Math.min(255, Math.round(c.b + (255 - c.b) * shininess)) };
                    grad.addColorStop(0, rgbToCss(center));
                    grad.addColorStop(0.6, rgbToCss(c));
                    grad.addColorStop(1, `rgba(0,0,0,${0.25 - 0.2 * shininess})`);
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, 0, Math.PI*2);
                    ctx.fillStyle = grad;
                    ctx.fill();
                } else if (type === 'monochrome') {
                    const a = hexToRgb(document.getElementById(`${modalId}-mono-a`).value || '#ffffff');
                    const b = hexToRgb(document.getElementById(`${modalId}-mono-b`).value || '#000000');
                    const center = lerpColor(a, b, 0.25 + shininess*0.5);
                    const rim = lerpColor(a, b, 0.85 - shininess*0.5);
                    const grad = ctx.createRadialGradient(cx - r*0.25, cy - r*0.25, r*0.02, cx, cy, r);
                    grad.addColorStop(0, rgbToCss(center));
                    grad.addColorStop(0.6, rgbToCss(lerpColor(center, rim, 0.4)));
                    grad.addColorStop(1, rgbToCss(rim));
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, 0, Math.PI*2);
                    ctx.fillStyle = grad;
                    ctx.fill();
                } else if (type === 'rainbow') {
                    const raw = (document.getElementById(`${modalId}-rain-list`).value || '').split(',').map(s => s.trim()).filter(Boolean);
                    const colors = raw.length ? raw : ['#ff0000','#ff8000','#ffff00','#00ff00','#00ffff','#0000ff','#8000ff'];
                    const grad = ctx.createRadialGradient(cx - r*0.25, cy - r*0.25, r*0.02, cx, cy, r);
                    const n = colors.length;
                    for (let i=0;i<n;i++) {
                        const stop = i / Math.max(1, n-1);
                        const c = hexToRgb(colors[i]);
                        const boosted = { r: Math.min(255, Math.round(c.r + (255 - c.r) * shininess*0.25)), g: Math.min(255, Math.round(c.g + (255 - c.g) * shininess*0.25)), b: Math.min(255, Math.round(c.b + (255 - c.b) * shininess*0.25)) };
                        grad.addColorStop(stop, rgbToCss(boosted));
                    }
                    ctx.beginPath();
                    ctx.arc(cx, cy, r, 0, Math.PI*2);
                    ctx.fillStyle = grad;
                    ctx.fill();
                }

                // highlight sheen
                ctx.beginPath();
                ctx.ellipse(cx - r*0.28, cy - r*0.34, r*0.5, r*0.32, Math.PI/6, 0, Math.PI*2);
                ctx.fillStyle = `rgba(255,255,255,${0.12 + 0.5*shininess})`;
                ctx.fill();

                // subtle outline
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI*2);
                ctx.lineWidth = 1;
                ctx.strokeStyle = `rgba(0,0,0,${0.2 + 0.2*(1 - shininess)})`;
                ctx.stroke();

                // draw small bounciness indicator (number)
                ctx.fillStyle = '#000';
                ctx.font = '12px sans-serif';
                ctx.fillText(`${Math.round(bounc*100)}% bounciness`, 8, preview.height - 8);
            }

            // initial visibility & render
            updateVisibility();

            document.getElementById(`${modalId}-save`).addEventListener('click', () => {
                const name = (document.getElementById(`${modalId}-name`).value || '').trim() || `Custom ${Date.now()}`;
                const type = document.getElementById(`${modalId}-type`).value;
                const shininess = Number(document.getElementById(`${modalId}-shininess`).value) / 100;
                const bounciness = Number(document.getElementById(`${modalId}-bounciness`).value) / 100;

                let meta = { name, type, shininess, bounciness, created: Date.now() };
                if (type === 'solid') {
                    meta.color = document.getElementById(`${modalId}-color1`).value;
                } else if (type === 'monochrome') {
                    meta.a = document.getElementById(`${modalId}-mono-a`).value;
                    meta.b = document.getElementById(`${modalId}-mono-b`).value;
                } else if (type === 'rainbow') {
                    meta.colors = (document.getElementById(`${modalId}-rain-list`).value || '').split(',').map(s=>s.trim()).filter(Boolean);
                    if (!meta.colors.length) meta.colors = ['#ff0000','#00ff00','#0000ff'];
                }

                const label = name;
                let css = '#999';
                if (type === 'solid') {
                    css = (meta.color || '#ff0000').toLowerCase();
                } else if (type === 'monochrome') {
                    const a = meta.a || '#ffffff', b = meta.b || '#000000';
                    css = `linear-gradient(180deg, ${a}, ${b})`;
                } else if (type === 'rainbow') {
                    css = `linear-gradient(90deg, ${meta.colors.join(',')})`;
                }

                if (index === null || typeof index === 'undefined') {
                    // create new entry
                    const idName = `custom:${Date.now()}`;
                    this.marbleColors.push({ id: idName, label, css, meta });
                    // select newly created marble
                    this.app.selectedMarbles.push(label);
                } else {
                    // update existing entry in-place
                    const existing = this.marbleColors[index];
                    const updated = { ...(typeof existing === 'object' ? existing : {}), label, css, meta };
                    this.marbleColors[index] = updated;
                    // update selected label if it was selected previously (replace old label with new)
                    this.app.selectedMarbles = this.app.selectedMarbles.map(s => (s === (existing.label || String(existing)) ? label : s));
                }

                // re-render palette, persist selection, close modal
                try { this.app.storage.saveMarbleSelection(this.app.selectedMarbles); } catch (e) {}
                this.renderMarbles();
                modal.remove();
                document.getElementById('modal-overlay').classList.add('hidden');
            });
        };

        // Login / Create Account button in Settings (adds modal + local mock account)
        // Ensure the settings button exists and wire the modal controls
        const loginBtn = document.querySelector('#tab-settings .secondary-btn') || document.querySelector('button[data-action="login"]');
        if (loginBtn) {
            loginBtn.id = loginBtn.id || 'btn-login';
            loginBtn.addEventListener('click', () => {
                const acc = this.app.storage.loadAccount();
                document.getElementById('account-username').value = acc?.username || '';
                document.getElementById('account-modal-title').innerText = acc ? 'Account' : 'Login / Create Account';
                document.getElementById('account-modal').classList.remove('hidden');
                document.getElementById('modal-overlay').classList.remove('hidden');
            });
        }

        // Account modal buttons
        const btnAccountSave = document.getElementById('btn-account-save');
        if (btnAccountSave) {
            btnAccountSave.addEventListener('click', () => {
                const username = document.getElementById('account-username').value.trim();
                if (!username) {
                    alert('Please enter a username.');
                    return;
                }
                const account = { username, created: Date.now() };
                this.app.storage.saveAccount(account);
                // reflect account in UI (simple acknowledgement)
                alert(`Signed in as ${username}`);
                this.hideModals();
                // refresh usage info after account changes
                this.updateDatabaseUsage();
            });
        }

        const btnAccountCancel = document.getElementById('btn-account-cancel');
        if (btnAccountCancel) {
            btnAccountCancel.addEventListener('click', () => this.hideModals());
        }

        // AI Map generation: generate an image then ask the LLM to return a structured race layout (parts + wires)
        const aiBtn = document.getElementById('btn-ai-map');
        if (aiBtn) {
            aiBtn.addEventListener('click', async () => {
                const overlay = document.getElementById('loading-overlay');
                try {
                    const prompt = prompt('Describe the map you want the AI to generate (e.g. "colorful marble race island with ramps and loops")');
                    if (!prompt) return;

                    if (overlay) overlay.classList.remove('hidden');

                    // 1) optional background image generation (best-effort)
                    let imageResult = null;
                    if (window.websim && typeof window.websim.imageGen === 'function') {
                        try {
                            imageResult = await window.websim.imageGen({ prompt, aspect_ratio: '16:9' });
                        } catch (e) {
                            console.warn('imageGen failed (continuing with fallback):', e);
                            imageResult = null;
                        }
                    }

                    // 2) attempt LLM layout generation; tolerate any failure and fall back
                    let layout = null;
                    try {
                        const sys = {
                            role: "system",
                            content: "You are a helpful assistant that outputs a single JSON object describing a Marble Race world. Respond with only JSON (no surrounding text). Schema: { parts: [ { type: string, x: number, y: number, rotation?: number, width?: number, height?: number, vertices?: [{x:number,y:number}], settings?: {} } ], wires?: [ { from: number|string, to: number|string } ] } . Use types like 'spawn_point','win_zone','rectangle','polygon','moving_platform','spinner','teleporter','fan','bumper'. Coordinate space: 0..2000. Keep total parts under ~40."
                        };
                        const userMsg = {
                            role: "user",
                            content: `Create a marble-race layout for: "${prompt}". Include at least one spawn_point and one win_zone. Return coordinates and reasonable sizes/vertices suitable for gameplay.`
                        };

                        if (window.websim && window.websim.chat && typeof window.websim.chat.completions.create === 'function') {
                            const conv = [sys, userMsg];
                            const completion = await window.websim.chat.completions.create({ messages: conv });
                            const raw = completion && completion.content ? completion.content : completion;
                            try {
                                layout = (typeof raw === 'string') ? JSON.parse(raw) : raw;
                            } catch (e) {
                                // try to extract JSON substring
                                const txt = (typeof raw === 'string') ? raw : JSON.stringify(raw);
                                const m = txt.match(/\{[\s\S]*\}$/);
                                if (m) {
                                    try { layout = JSON.parse(m[0]); } catch (parseErr) { layout = null; }
                                } else {
                                    layout = null;
                                }
                            }
                        } else {
                            layout = null;
                        }
                    } catch (err) {
                        console.warn('LLM layout request failed, falling back to local template:', err);
                        layout = null;
                    }

                    // 3) build world (use LLM layout if valid, otherwise fallback template)
                    const now = Date.now();
                    const world = {
                        id: now,
                        name: `AI Map - ${new Date().toLocaleTimeString()}`,
                        parts: [],
                        wires: [],
                        created: now,
                        metadata: {
                            prompt,
                            ai_map_url: imageResult?.url || null,
                            generated_by_ai: !!layout
                        }
                    };

                    if (layout && Array.isArray(layout.parts) && layout.parts.length > 0) {
                        let nextId = now + 1;
                        const mapId = (rawId) => {
                            if (typeof rawId === 'number' || typeof rawId === 'string') return rawId;
                            return (nextId++);
                        };
                        layout.parts.forEach(p => {
                            const type = (p.type || 'rectangle').toLowerCase();
                            const part = {
                                id: mapId(p.id) || (nextId++),
                                type: String(type).replace(/\s+/g, '_'),
                                x: Number(p.x || 200),
                                y: Number(p.y || 200),
                                rotation: Number(p.rotation || 0),
                                width: p.width || 40,
                                height: p.height || 20,
                                color: p.color || null,
                                collision: p.collision !== false,
                                settings: p.settings || {},
                                vertices: Array.isArray(p.vertices) ? p.vertices.map(v => ({ x: Number(v.x), y: Number(v.y) })) : (p.vertices || [])
                            };
                            if (part.type === 'spawn_point') part.settings = Object.assign({ bounciness: 0.5, color: '#f97316' }, part.settings);
                            if (part.type === 'win_zone') part.settings = Object.assign({ timer: 20, color: 'rgba(34,197,94,0.5)' }, part.settings);
                            world.parts.push(part);
                        });
                        if (Array.isArray(layout.wires)) layout.wires.forEach(w => world.wires.push({ from: w.from, to: w.to }));
                    } else {
                        // reliable fallback playable layout
                        const spawn = {
                            id: now + 1, type: 'spawn_point', x: 200, y: 200, rotation: 0, width: 40, height: 40,
                            color: '#f97316', collision: false, settings: { bounciness: 0.5, color: '#f97316' }, vertices: []
                        };
                        const ramp = {
                            id: now + 2, type: 'polygon', x: 420, y: 240, rotation: -0.25, width: 200, height: 80,
                            color: '#64748b', collision: true, settings: {}, vertices: [{x:360,y:200},{x:520,y:200},{x:560,y:260},{x:340,y:260}]
                        };
                        const straight = {
                            id: now + 3, type: 'rectangle', x: 760, y: 300, rotation: 0, width: 380, height: 40,
                            color: '#64748b', collision: true, settings: {}, vertices: [{x:560,y:280},{x:960,y:280},{x:960,y:320},{x:560,y:320}]
                        };
                        const win = {
                            id: now + 4, type: 'win_zone', x: 1040, y: 300, rotation: 0, width: 60, height: 60,
                            color: 'rgba(34,197,94,0.5)', collision: false, settings: { timer: 20 }, vertices: [{x:1010,y:270},{x:1070,y:270},{x:1070,y:330},{x:1010,y:330}]
                        };
                        world.parts.push(spawn, ramp, straight, win);
                    }

                    // persist and open in editor (best-effort save)
                    try { await this.app.storage.saveWorld(world); } catch (e) { try { this.app.storage.saveWorld(world); } catch(_){} }
                    this.app.editor.world = world;
                    this.app.switchTab('editor');
                    alert('AI map created and opened in Editor.');
                } catch (err) {
                    console.error('AI map generation failed (unexpected):', err);
                    alert('AI map generation failed. See console.');
                } finally {
                    if (overlay) overlay.classList.add('hidden');
                }
            });
        }

        // Static workshop modal close button (outside dynamic content) — ensure it hides modal and unsubscribes comment listener
        const workshopStaticClose = document.getElementById('workshop-entry-close');
        if (workshopStaticClose) {
            workshopStaticClose.addEventListener('click', () => {
                try { if (this._commentUnsub) { this._commentUnsub(); this._commentUnsub = null; } } catch (e) { /* ignore */ }
                this.hideModals();
            });
        }

        // Add a compact DB usage area to Settings
        this.ensureSettingsUsageUI();
        // initial load
        this.updateDatabaseUsage();
    }

    async renderRaces() {
        const grid = document.getElementById('race-grid');
        const empty = document.getElementById('race-empty-state');
        grid.innerHTML = '';

        // Force localStorage-only listing for "My Races"
        let worlds = [];
        try {
            if (this.app && this.app.storage && typeof this.app.storage.loadWorlds === 'function') {
                worlds = this.app.storage.loadWorlds() || [];
            }
        } catch (e) {
            console.warn('renderRaces: failed to load local worlds:', e);
            worlds = [];
        }

        if (!Array.isArray(worlds) || worlds.length === 0) {
            empty.classList.remove('hidden');
            return;
        } else {
            empty.classList.add('hidden');
        }

        worlds.forEach(w => {
            const world = w || {};
            const card = document.createElement('div');
            card.className = 'card small';
            card.innerHTML = `
                <div class="card-preview preview-1-1" data-id="${world.id}-thumb"></div>
                <div class="card-title">${world.name || 'Untitled'}</div>
                <button class="card-menu-btn" data-id="${world.id}" title="Options">⋮</button>
            `;
            const previewContainer = card.querySelector('.card-preview.preview-1-1');
            const openEditor = () => { this.app.editor.world = world; this.app.switchTab('editor'); };
            previewContainer.addEventListener('click', openEditor);

            const createThumbCanvas = (container) => {
                const c = document.createElement('canvas');
                c.style.width = '100%';
                c.style.height = '100%';
                c.style.display = 'block';
                container.appendChild(c);

                setTimeout(() => {
                    try {
                        const ctx = c.getContext('2d');
                        const DPR = window.devicePixelRatio || 1;
                        const displayW = Math.max(32, Math.round(container.clientWidth));
                        const displayH = Math.max(32, Math.round(container.clientHeight || displayW));
                        c.width = Math.round(displayW * DPR);
                        c.height = Math.round(displayH * DPR);
                        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
                        ctx.clearRect(0, 0, displayW, displayH);
                        ctx.fillStyle = '#f3f4f6';
                        ctx.fillRect(0, 0, displayW, displayH);

                        if (!world || !world.parts || world.parts.length === 0) {
                            ctx.fillStyle = '#9ca3af';
                            ctx.font = '10px sans-serif';
                            ctx.fillText('No parts', 6, 14);
                            return;
                        }

                        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                        world.parts.forEach(p => { minX = Math.min(minX, p.x || 0); minY = Math.min(minY, p.y || 0); maxX = Math.max(maxX, p.x || 0); maxY = Math.max(maxY, p.y || 0); });
                        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = displayW; maxY = displayH; }
                        const pad = 12;
                        const worldW = Math.max(1, maxX - minX);
                        const worldH = Math.max(1, maxY - minY);

                        const fitScale = Math.min((displayW - pad) / worldW, (displayH - pad) / worldH);
                        const zoomOutFactor = 0.6;
                        const scale = Math.max(0.01, fitScale * zoomOutFactor);

                        const offsetX = (displayW - worldW * scale) / 2;
                        const offsetY = (displayH - worldH * scale) / 2;

                        ctx.save();
                        ctx.translate(offsetX - minX * scale, offsetY - minY * scale);
                        ctx.scale(scale, scale);

                        (world.parts || []).slice(0, 200).forEach(p => {
                            // prefer explicit part.color, then settings.color; fallback to type defaults
                            const fill = p.color || (p.settings && p.settings.color) || null;
                            if (p.type === 'win_zone') ctx.fillStyle = fill || 'rgba(34,197,94,0.5)';
                            else if (p.type === 'spawn_point') ctx.fillStyle = fill || 'rgba(249,115,22,0.8)';
                            else if (p.type === 'teleporter') ctx.fillStyle = fill || 'rgba(168,85,247,0.8)';
                            else ctx.fillStyle = fill || '#6b7280';

                            if (p.vertices && p.vertices.length >= 3) {
                                ctx.beginPath();
                                ctx.moveTo(p.vertices[0].x, p.vertices[0].y);
                                for (let i = 1; i < p.vertices.length; i++) ctx.lineTo(p.vertices[i].x, p.vertices[i].y);
                                ctx.closePath();
                                ctx.fill();
                            } else {
                                ctx.fillRect((p.x || 0) - 6, (p.y || 0) - 5, 12, 8);
                            }
                        });

                        ctx.restore();
                    } catch (e) { /* ignore drawing errors */ }
                }, 0);
            };

            createThumbCanvas(previewContainer);

            const menuBtn = card.querySelector('.card-menu-btn');
            menuBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const existing = document.getElementById('race-card-menu');
                if (existing) existing.remove();

                const menu = document.createElement('div');
                menu.id = 'race-card-menu';
                menu.style.position = 'fixed';
                menu.style.zIndex = 300000;
                menu.style.background = 'white';
                menu.style.border = '1px solid rgba(0,0,0,0.08)';
                menu.style.borderRadius = '8px';
                menu.style.boxShadow = '0 6px 18px rgba(0,0,0,0.12)';
                menu.style.padding = '6px';
                menu.style.minWidth = '140px';
                menu.style.color = '#061025';
                const rect = menuBtn.getBoundingClientRect();
                const top = Math.min(window.innerHeight - 8 - 100, rect.bottom + 6);
                const left = Math.min(window.innerWidth - 8 - 180, rect.left);
                menu.style.top = `${top}px`;
                menu.style.left = `${left}px`;

                const makeItem = (label) => {
                    const it = document.createElement('div');
                    it.style.padding = '8px 10px';
                    it.style.cursor = 'pointer';
                    it.style.borderRadius = '6px';
                    it.style.fontSize = '13px';
                    it.innerText = label;
                    it.addEventListener('mouseenter', () => it.style.background = 'rgba(0,0,0,0.04)');
                    it.addEventListener('mouseleave', () => it.style.background = 'transparent');
                    return it;
                };

                const openIt = makeItem('Open');
                openIt.addEventListener('click', () => {
                    this.app.editor.world = world;
                    this.app.switchTab('editor');
                    menu.remove();
                });

                const renameIt = makeItem('Rename');
                renameIt.addEventListener('click', () => {
                    const newName = prompt('Rename world', world.name || '');
                    if (newName !== null && newName.trim() !== '') {
                        world.name = newName.trim();
                        try { this.app.storage.saveWorld(world); } catch(e){ console.warn(e); }
                        this.renderRaces();
                    }
                    menu.remove();
                });

                const deleteIt = makeItem('Delete');
                deleteIt.style.color = 'var(--danger)';
                deleteIt.addEventListener('click', async () => {
                    const ok = confirm(`Delete \"${world.name}\"? This cannot be undone.`);
                    if (ok) {
                        try {
                            if (this.app.storage && typeof this.app.storage.deleteWorld === 'function') {
                                await this.app.storage.deleteWorld(world.id);
                            }
                        } catch (e) {
                            console.warn('deleteWorld failed', e);
                        }
                        this.renderRaces();
                    }
                    menu.remove();
                });

                menu.appendChild(openIt);
                menu.appendChild(renameIt);
                menu.appendChild(deleteIt);

                document.body.appendChild(menu);

                const onDocClick = (e) => {
                    if (!menu.contains(e.target) && e.target !== menuBtn) {
                        menu.remove();
                        document.removeEventListener('click', onDocClick);
                    }
                };
                setTimeout(() => document.addEventListener('click', onDocClick), 0);

            });

            grid.appendChild(card);
        });
    }

    renderMarbles() {
        const grid = document.getElementById('marble-grid');
        // extended palette (we keep actual objects if present)
        const colors = Array.isArray(this.marbleColors) ? this.marbleColors.slice() : [];
        
        grid.innerHTML = '';
        colors.forEach((c, idx) => {
            const label = (typeof c === 'object' && c.label) ? c.label : String(c);
            const isSelected = this.app.selectedMarbles.includes(label);
            const item = document.createElement('div');
            item.className = `marble-item ${isSelected ? 'selected' : ''}`;
            // include a small menu button (three dots) only for user-created marbles (objects) and position it top-left
            const menuDisplay = (typeof c === 'object') ? 'inline-block' : 'none';
            item.innerHTML = `
                <div style="position:relative;width:100%;display:flex;align-items:center;justify-content:center;">
                  <div class="marble-preview" style="background: ${this.getMarbleCSS(c)}"></div>
                  <button class="marble-menu-btn" data-index="${idx}" title="Options" style="position:absolute;left:6px;top:4px;background:transparent;border:0;color:inherit;font-weight:700;cursor:pointer;display:${menuDisplay};">⋮</button>
                </div>
                <span style="margin-top:6px;max-width:100%;text-align:center;display:block;word-break:break-word">${label}</span>
                ${isSelected ? '<i class="check-mark" data-lucide="check-circle-2"></i>' : ''}
            `;
            // Toggle selection when clicking the item (but not the menu button)
            item.addEventListener('click', (ev) => {
                if (ev.target && ev.target.classList && ev.target.classList.contains('marble-menu-btn')) return;
                this.toggleMarble(label);
            });

            // Menu button handling (edit/delete)
            const menuBtn = item.querySelector('.marble-menu-btn');
            menuBtn?.addEventListener('click', (ev) => {
                ev.stopPropagation();
                // remove any existing open menu
                document.getElementById('marble-item-menu')?.remove();

                const menu = document.createElement('div');
                menu.id = 'marble-item-menu';
                menu.style.position = 'fixed';
                menu.style.zIndex = 400000;
                menu.style.background = 'white';
                menu.style.color = '#061025';
                menu.style.border = '1px solid rgba(0,0,0,0.08)';
                menu.style.borderRadius = '8px';
                menu.style.padding = '6px';
                menu.style.minWidth = '140px';
                menu.style.boxShadow = '0 6px 18px rgba(0,0,0,0.12)';
                const rect = menuBtn.getBoundingClientRect();
                const top = Math.min(window.innerHeight - 8 - 120, rect.bottom + 6);
                const left = Math.min(window.innerWidth - 8 - 220, rect.left);
                menu.style.top = `${top}px`;
                menu.style.left = `${left}px`;

                const makeItem = (label, color) => {
                    const it = document.createElement('div');
                    it.style.padding = '8px 10px';
                    it.style.cursor = 'pointer';
                    it.style.borderRadius = '6px';
                    it.style.fontSize = '13px';
                    it.innerText = label;
                    if (color) it.style.color = color;
                    it.addEventListener('mouseenter', () => it.style.background = 'rgba(0,0,0,0.04)');
                    it.addEventListener('mouseleave', () => it.style.background = 'transparent');
                    return it;
                };

                const editIt = makeItem('Edit');
                editIt.addEventListener('click', () => {
                    // open modal in edit mode
                    this.openCustomMarbleModal(c, idx);
                    menu.remove();
                });

                const deleteIt = makeItem('Delete', 'crimson');
                deleteIt.addEventListener('click', () => {
                    if (!confirm(`Delete marble "${label}"?`)) return;
                    // remove from palette (by index)
                    this.marbleColors.splice(idx, 1);
                    // also remove from selected list if present
                    this.app.selectedMarbles = this.app.selectedMarbles.filter(m => m !== label);
                    try { this.app.storage.saveMarbleSelection(this.app.selectedMarbles); } catch (e) {}
                    this.renderMarbles();
                    menu.remove();
                });

                const closeIt = makeItem('Close');
                closeIt.addEventListener('click', () => menu.remove());

                menu.appendChild(editIt);
                menu.appendChild(deleteIt);
                menu.appendChild(closeIt);
                document.body.appendChild(menu);

                const onDocClick = (e) => {
                    if (!menu.contains(e.target) && e.target !== menuBtn) {
                        menu.remove();
                        document.removeEventListener('click', onDocClick);
                    }
                };
                setTimeout(() => document.addEventListener('click', onDocClick), 0);
            });

            grid.appendChild(item);
        });
        // Re-run lucide for newly added icons (if available globally)
        if (window.lucide) window.lucide.createIcons();
    }

    // Workshop tab rendering: simple cards (username, generated image, vertex count). Tap opens a detailed modal with left: preview/meta and right: comment wall.
    async renderCommunity() {
        const grid = document.getElementById('community-grid');
        grid.innerHTML = '';

        // Top upload controls (sticky)
        const topRow = document.createElement('div');
        topRow.className = 'community-top';
        topRow.innerHTML = `
            <div style="display:flex;gap:8px;align-items:center;width:100%;flex-wrap:wrap;">
                <select id="upload-world-select" style="flex:1 1 260px;padding:8px;border-radius:6px;border:1px solid rgba(0,0,0,0.08);min-width:160px;"></select>
                <button id="upload-world-btn" class="primary-btn" style="flex:0 0 auto;white-space:nowrap;">Upload to Workshop</button>
            </div>
        `;
        grid.appendChild(topRow);

        // list container
        const listContainer = document.createElement('div');
        listContainer.id = 'workshop-list';
        listContainer.style.maxHeight = 'calc(100vh - 120px)';
        listContainer.style.overflow = 'auto';
        listContainer.style.padding = '8px 4px';
        listContainer.style.display = 'flex';
        listContainer.style.flexDirection = 'column';
        listContainer.style.gap = '10px';
        grid.appendChild(listContainer);

        // populate upload selector with local worlds
        let localWorlds = [];
        try { localWorlds = (typeof this.app.storage.loadWorlds === 'function') ? (this.app.storage.loadWorlds() || []) : []; } catch (e) { localWorlds = []; }
        const sel = document.getElementById('upload-world-select');
        sel.innerHTML = '';
        if (!Array.isArray(localWorlds) || localWorlds.length === 0) {
            const opt = document.createElement('option'); opt.value = ''; opt.text = 'No local worlds to upload'; sel.appendChild(opt); sel.disabled = true;
        } else {
            sel.disabled = false;
            localWorlds.forEach((w, idx) => {
                const opt = document.createElement('option');
                const idValue = (w && w.id !== undefined && w.id !== null) ? String(w.id) : (w && w.created) ? String(w.created) : `local-${idx}`;
                opt.value = idValue;
                opt.dataset.localIndex = String(idx);
                opt.text = w?.name || `World ${idValue}`;
                sel.appendChild(opt);
            });
            if (!sel.value && sel.options.length > 0) sel.selectedIndex = 0;
        }

        // upload handler (keeps original behavior)
        document.getElementById('upload-world-btn').onclick = async () => {
            if (!sel || sel.disabled) return alert('No local world available to upload.');
            const selectedOption = sel.options[sel.selectedIndex] || null;
            if (!selectedOption || !selectedOption.value) return alert('Select a local world to upload.');
            const selectedValue = selectedOption.value;
            const selectedIndex = selectedOption.dataset?.localIndex;
            let freshLocalWorlds = (typeof this.app.storage.loadWorlds === 'function') ? (this.app.storage.loadWorlds() || []) : [];
            if (!Array.isArray(freshLocalWorlds)) freshLocalWorlds = [];
            let world = freshLocalWorlds.find(w => (w && (String(w.id) === String(selectedValue) || String(w.created) === String(selectedValue))));
            if (!world && typeof selectedIndex !== 'undefined') {
                const idx = parseInt(selectedIndex, 10);
                if (!Number.isNaN(idx) && freshLocalWorlds[idx]) world = freshLocalWorlds[idx];
            }
            if (!world) world = freshLocalWorlds.find(w => w && String(w.name) === String(selectedOption.text));
            if (!world) {
                console.error('Upload attempted but selected world not found', { selectedValue, selectedIndex, available: freshLocalWorlds.length });
                return alert('Selected world not found. See console for details.');
            }
            try {
                const worldCopy = JSON.parse(JSON.stringify(world));
                if (!worldCopy.id) worldCopy.id = Date.now();
                if (!worldCopy.name) worldCopy.name = `World ${worldCopy.id}`;
                await this.app.storage.createWorkshopEntry(worldCopy);
                alert('Uploaded to Workshop.');
                const updatedLocal = (typeof this.app.storage.loadWorlds === 'function') ? this.app.storage.loadWorlds() : freshLocalWorlds;
                sel.innerHTML = '';
                if (!updatedLocal || updatedLocal.length === 0) {
                    const opt = document.createElement('option'); opt.value = ''; opt.text = 'No local worlds to upload'; sel.appendChild(opt); sel.disabled = true;
                } else {
                    sel.disabled = false;
                    updatedLocal.forEach((w, idx) => {
                        const opt = document.createElement('option');
                        const idValue = (w && w.id !== undefined && w.id !== null) ? String(w.id) : String(w.created ?? `local-${idx}`);
                        opt.value = idValue; opt.text = w.name || `World ${idValue}`; opt.dataset.localIndex = String(idx); sel.appendChild(opt);
                    });
                    const foundIndex = [...updatedLocal].findIndex(w => String(w.id) === String(worldCopy.id));
                    sel.selectedIndex = foundIndex >= 0 ? foundIndex : 0;
                }
            } catch (e) {
                console.error('Upload to workshop failed', e);
                alert('Upload failed. See console for details.');
            }
        };

        // small preview drawer (responsive): size canvas to its displayed size and draw at device pixel ratio for crispness
        const drawPreviewSimple = (world, canvas) => {
            try {
                const DPR = window.devicePixelRatio || 1;
                // Set canvas internal pixel size to match its CSS display size * DPR
                const displayWidth = Math.max(1, canvas.clientWidth);
                const displayHeight = Math.max(1, canvas.clientHeight);
                if (canvas.width !== Math.round(displayWidth * DPR) || canvas.height !== Math.round(displayHeight * DPR)) {
                    canvas.width = Math.round(displayWidth * DPR);
                    canvas.height = Math.round(displayHeight * DPR);
                }
                const ctx = canvas.getContext('2d');
                // scale drawing to DPR so 1 unit = 1 CSS pixel
                ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
                ctx.clearRect(0,0,displayWidth,displayHeight);
                ctx.fillStyle = '#f3f4f6'; ctx.fillRect(0,0,displayWidth,displayHeight);
                if (!world || !world.parts || world.parts.length === 0) {
                    ctx.fillStyle = '#9ca3af'; ctx.font = '12px sans-serif'; ctx.fillText('No parts', 10, 16); return;
                }
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                world.parts.forEach(p => { minX = Math.min(minX, p.x||0); minY = Math.min(minY, p.y||0); maxX = Math.max(maxX, p.x||0); maxY = Math.max(maxY, p.y||0); });
                if (!isFinite(minX)) { minX = 0; minY = 0; maxX = displayWidth; maxY = displayHeight; }
                const pad = 20; const w = Math.max(1, maxX - minX); const h = Math.max(1, maxY - minY);
                const scale = Math.min((displayWidth - pad) / w, (displayHeight - pad) / h);
                ctx.save(); ctx.translate(8,8); ctx.scale(scale, scale); ctx.translate(-minX, -minY);
                world.parts.slice(0,50).forEach(p => {
                    const fill = p.color || (p.settings && p.settings.color) || null;
                    ctx.fillStyle = (p.type === 'win_zone') ? (fill || 'rgba(34,197,94,0.5)') : (p.type === 'spawn_point') ? (fill || 'rgba(249,115,22,0.8)') : (fill || '#6b7280');
                    if (p.vertices && p.vertices.length >= 3) {
                        ctx.beginPath(); ctx.moveTo(p.vertices[0].x, p.vertices[0].y);
                        for (let i=1;i<p.vertices.length;i++) ctx.lineTo(p.vertices[i].x, p.vertices[i].y);
                        ctx.closePath(); ctx.fill();
                    } else {
                        ctx.fillRect((p.x||0)-6, (p.y||0)-5, 12, 8);
                    }
                });
                ctx.restore();
            } catch (err) { console.warn('preview draw failed', err); }
        };

        // simplified entry card renderer: username, image, vertex count
        const renderEntries = (entries) => {
            const list = Array.isArray(entries) ? entries.slice().sort((a,b) => new Date(b.created_at) - new Date(a.created_at)) : [];
            listContainer.innerHTML = '';
            if (list.length === 0) {
                const note = document.createElement('div'); note.style.padding = '12px'; note.style.color = 'var(--muted)'; note.innerText = 'No workshop entries yet.'; listContainer.appendChild(note); return;
            }

            list.forEach(entry => {
                const card = document.createElement('div');
                card.className = 'card';
                card.style.display = 'flex';
                card.style.alignItems = 'center';
                card.style.gap = '10px';
                card.style.padding = '10px';

                // responsive small preview canvas (keeps wide aspect but scales to layout)
                const preview = document.createElement('canvas');
                // compact fixed-size thumbnail for workshop cards (consistent visual weight)
                preview.className = 'preview-canvas';
                preview.style.flex = '0 0 auto';
                preview.style.width = '120px';
                preview.style.height = '80px';
                preview.style.minWidth = '120px';
                preview.style.minHeight = '80px';
                preview.style.maxWidth = '120px';
                preview.style.maxHeight = '80px';
                preview.style.display = 'block';
                preview.style.borderRadius = '8px';
                preview.style.border = '1px solid rgba(0,0,0,0.06)';
                preview.style.background = 'rgba(255,255,255,0.02)';
                preview.style.objectFit = 'cover';
                preview.style.boxShadow = '0 4px 12px rgba(2,6,23,0.25)';
                // initial draw (drawPreviewSimple will size the internal buffer to the CSS size)
                setTimeout(() => drawPreviewSimple(entry.world, preview), 0);

                // username and vertex count
                const meta = document.createElement('div');
                meta.style.display = 'flex';
                meta.style.flexDirection = 'column';
                meta.style.gap = '4px';
                const user = document.createElement('div');
                user.style.fontWeight = '700';
                user.innerText = entry.username || 'anon';
                const verts = (entry.world?.parts || []).reduce((acc,p) => acc + (Array.isArray(p.vertices) ? p.vertices.length : 0), 0);
                const info = document.createElement('div');
                info.style.color = 'var(--muted)';
                info.style.fontSize = '13px';
                info.innerText = `${(entry.world?.parts?.length || 0)} parts • ${verts} vertices`;

                meta.appendChild(user);
                meta.appendChild(info);

                card.appendChild(preview);
                card.appendChild(meta);
                listContainer.appendChild(card);

                // click opens full modal: left preview/meta, right comment wall
                card.addEventListener('click', (ev) => {
                    const modal = document.getElementById('workshop-entry-modal');
                    const body = document.getElementById('workshop-entry-body');
                    const titleEl = document.getElementById('workshop-entry-title');
                    titleEl.innerText = entry.world?.name || `Workshop Entry ${entry.id}`;
                    // build left and right columns
                    body.innerHTML = `
                        <div style="display:flex;gap:12px;align-items:flex-start;">
                            <div style="flex:0 0 min(720px,48%); max-width:720px; display:flex;flex-direction:column;gap:8px;">
                                <div style="font-weight:700;">${entry.username || 'anon'}</div>
                                <!-- modal preview: use square preview-picture (1:1) as the only true thumbnail (display reduced to ~half size) -->
                                <canvas id="workshop-preview-${entry.id}" class="preview-square" style="width:50%;max-width:180px;height:auto;border-radius:6px;border:1px solid rgba(0,0,0,0.04);"></canvas>
                                <div style="color:var(--muted)"><strong>Parts:</strong> ${(entry.world?.parts?.length || 0)}</div>
                                <div style="color:var(--muted)"><strong>Vertices:</strong> ${verts}</div>
                            </div>
                            <div style="flex:1 1 auto; display:flex;flex-direction:column;gap:8px;">
                                <div style="font-weight:700;">Comments</div>
                                <div id="comment-wall" style="flex:1 1 auto;border:1px solid rgba(0,0,0,0.04);padding:8px;border-radius:6px;overflow:auto;background:rgba(255,255,255,0.01);min-height:180px;color:var(--muted);">
                                    <!-- comments will be injected here -->
                                </div>
                                <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
                                    <input id="comment-input" placeholder="Write a comment..." style="flex:1;padding:8px;border-radius:6px;border:1px solid rgba(0,0,0,0.06);background:transparent;color:var(--muted)">
                                    <button id="comment-send" class="primary-btn" style="flex:0 0 auto;min-width:90px;">Post</button>
                                </div>
                                <div style="display:flex;gap:8px;margin-top:8px;">
                                    <!-- Use unique IDs for buttons inside this dynamic modal to avoid collisions with the global modal -->
                                    <button id="workshop-entry-download-local" class="secondary-btn">Download</button>
                                    <button id="workshop-entry-import-local" class="primary-btn">Import & Edit</button>
                                    <div style="flex:1"></div>
                                    <!-- Delete button will be shown only if current user is the uploader; wired below -->
                                    <button id="workshop-entry-delete-local" class="secondary-btn" style="display:none;color:var(--danger);border-color:rgba(239,68,68,0.12);">Delete</button>
                                    <button id="workshop-entry-close-local" class="secondary-btn">Close</button>
                                </div>
                            </div>
                        </div>
                    `;
                    // draw responsive preview (allow drawPreviewSimple to size internal buffer)
                    const canvas = document.getElementById(`workshop-preview-${entry.id}`);
                    // wait a tick so CSS layout is applied, then draw at proper size
                    setTimeout(() => drawPreviewSimple(entry.world, canvas), 0);

                    // Comments wiring: load and subscribe
                    const commentWall = document.getElementById('comment-wall');
                    const commentInput = document.getElementById('comment-input');
                    const commentSend = document.getElementById('comment-send');

                    // helper to render comment list
                    const renderComments = (comments) => {
                        commentWall.innerHTML = '';
                        if (!comments || comments.length === 0) {
                            const note = document.createElement('div');
                            note.style.padding = '8px';
                            note.style.color = 'var(--muted)';
                            note.innerText = 'No comments yet. Be the first to comment!';
                            commentWall.appendChild(note);
                            return;
                        }
                        comments.forEach(c => {
                            const row = document.createElement('div');
                            row.style.padding = '6px';
                            row.style.borderBottom = '1px solid rgba(0,0,0,0.04)';
                            const who = document.createElement('div');
                            who.style.fontWeight = '700';
                            who.style.fontSize = '13px';
                            who.innerText = c.username || 'anon';
                            const when = document.createElement('div');
                            when.style.fontSize = '11px';
                            when.style.color = 'var(--muted)';
                            const d = new Date(c.created_at || Date.now());
                            when.innerText = d.toLocaleString();
                            const txt = document.createElement('div');
                            txt.style.marginTop = '4px';
                            txt.style.color = 'var(--muted)';
                            txt.innerText = c.text || '';
                            row.appendChild(who);
                            row.appendChild(when);
                            row.appendChild(txt);
                            commentWall.appendChild(row);
                        });
                        // keep scrolled to bottom
                        commentWall.scrollTop = commentWall.scrollHeight;
                    };

                    // subscribe if available, else load once
                    if (this._commentUnsub) { try { this._commentUnsub(); } catch (e) {} this._commentUnsub = null; }
                    if (this.app.storage && typeof this.app.storage.subscribeWorkshopComments === 'function') {
                        this._commentUnsub = this.app.storage.subscribeWorkshopComments(entry.id, (list) => {
                            renderComments(list);
                        });
                    } else {
                        // one-shot load
                        (async () => {
                            if (this.app.storage && typeof this.app.storage.listWorkshopComments === 'function') {
                                const list = await this.app.storage.listWorkshopComments(entry.id);
                                renderComments(list);
                            } else {
                                renderComments([]);
                            }
                        })();
                    }

                    // send handler
                    commentSend.onclick = async () => {
                        const text = (commentInput.value || '').trim();
                        if (!text) return;
                        // determine username: use stored account if available
                        let username = 'anon';
                        try { const acc = this.app.storage.loadAccount(); if (acc?.username) username = acc.username; } catch (e) {}
                        try {
                            if (this.app.storage && typeof this.app.storage.createWorkshopComment === 'function') {
                                await this.app.storage.createWorkshopComment(entry.id, username, text);
                                commentInput.value = '';
                                // For local fallback we may need to re-run list; subscription will handle remote updates
                                if (!this._commentUnsub && this.app.storage && typeof this.app.storage.listWorkshopComments === 'function') {
                                    const list = await this.app.storage.listWorkshopComments(entry.id);
                                    renderComments(list);
                                }
                            } else {
                                alert('Commenting not available.');
                            }
                        } catch (err) {
                            console.error('Failed to post comment', err);
                            alert('Failed to post comment.');
                        }
                    };

                    // wire modal actions (download/import reuse storage APIs) - use the unique local IDs
                    document.getElementById('workshop-entry-download-local').onclick = async () => {
                        try {
                            const entriesList = await this.app.storage.listWorkshopEntries();
                            const found = entriesList.find(e => String(e.id) === String(entry.id));
                            if (!found) return alert('Entry not found.');
                            const copy = JSON.parse(JSON.stringify(found.world));
                            copy.id = Date.now(); copy.name = (copy.name || 'Imported World') + ' (Downloaded)';
                            this.app.storage.saveWorld(copy);
                            this.app.ui.renderRaces();
                            alert('Downloaded to My Races.'); 
                            // close the modal and cleanup comments subscription if present
                            if (this._commentUnsub) { try { this._commentUnsub(); } catch (err) {} this._commentUnsub = null; }
                            this.hideModals();
                        } catch (e) { console.error(e); alert('Download failed.'); }
                    };
                    document.getElementById('workshop-entry-import-local').onclick = async () => {
                        try {
                            const entriesList = await this.app.storage.listWorkshopEntries();
                            const found = entriesList.find(e => String(e.id) === String(entry.id));
                            if (!found) return alert('Entry not found.');
                            const copy = JSON.parse(JSON.stringify(found.world));
                            copy.id = Date.now(); copy.name = (copy.name || 'Imported World') + ' (Workshop)';
                            this.app.storage.saveWorld(copy);
                            // cleanup subscription before switching views
                            if (this._commentUnsub) { try { this._commentUnsub(); } catch (err) {} this._commentUnsub = null; }
                            this.app.editor.world = copy; this.hideModals(); this.app.switchTab('editor');
                            alert('Imported and opened in Editor.');
                        } catch (e) { console.error(e); alert('Import failed.'); }
                    };

                    // Wire delete button (visible only to uploader)
                    (async () => {
                        try {
                            const currentUser = await (this.app.storage && typeof this.app.storage._getLocalUsername === 'function' ? this.app.storage._getLocalUsername() : Promise.resolve(null));
                            const deleteBtn = document.getElementById('workshop-entry-delete-local');
                            if (deleteBtn) {
                                if (currentUser && String(currentUser) === String(entry.username)) {
                                    deleteBtn.style.display = 'inline-block';
                                    deleteBtn.onclick = async () => {
                                        if (!confirm(`Delete your workshop entry \"${entry.world?.name || entry.world_name || entry.id}\"? This cannot be undone.`)) return;
                                        try {
                                            const ok = await this.app.storage.deleteWorkshopEntry(entry.id);
                                            if (ok) {
                                                alert('Entry deleted.');
                                                // refresh workshop list if present
                                                try { if (this._workshopUnsub) { /* subscription will update automatically */ } else { if (this.app.ui && typeof this.app.ui.renderCommunity === 'function') this.app.ui.renderCommunity(); } } catch(e){}
                                                if (this._commentUnsub) { try { this._commentUnsub(); } catch (err) {} this._commentUnsub = null; }
                                                this.hideModals();
                                            } else {
                                                alert('Delete failed. See console.');
                                            }
                                        } catch (err) {
                                            console.error('Delete failed', err);
                                            alert('Delete failed. See console.');
                                        }
                                    };
                                } else {
                                    deleteBtn.style.display = 'none';
                                }
                            }
                        } catch (err) {
                            console.warn('Delete button wiring failed', err);
                        }
                    })();

                    document.getElementById('workshop-entry-close-local').onclick = () => {
                        if (this._commentUnsub) { try { this._commentUnsub(); } catch (e) {} this._commentUnsub = null; }
                        this.hideModals();
                    };

                    modal.classList.remove('hidden'); document.getElementById('modal-overlay').classList.remove('hidden');
                });
            });
        };



        // subscribe or load once
        if (this.app.storage.subscribeWorkshopEntries) {
            this._workshopUnsub = this.app.storage.subscribeWorkshopEntries((entries) => { renderEntries(entries); });
        } else {
            const entries = await this.app.storage.listWorkshopEntries();
            renderEntries(entries);
        }
    }

    renderNews() {
        const container = document.getElementById('news-list');
        if (!container) return;
        container.innerHTML = '';
        container.className = 'news-dashboard layout-LeftHalfTwoQuartersRight';

        // --- FRAME 1: Global Chat ---
        const chatFrame = document.createElement('div');
        chatFrame.className = 'news-frame';
        chatFrame.innerHTML = `
            <div class="news-frame-header">Global Chat <i data-lucide="message-square" style="width:14px;height:14px"></i></div>
            <div id="global-chat-box" style="flex:1; overflow-y:auto; margin-bottom:8px; font-size:13px;"></div>
            <div style="display:flex; gap:6px;">
                <input id="global-chat-input" placeholder="Party message..." style="flex:1; font-size:12px; height:32px;">
                <button id="global-chat-send" class="primary-btn" style="padding:4px 12px; height:32px;">Send</button>
            </div>
        `;
        container.appendChild(chatFrame);

        // --- FRAME 2: First Upload ---
        const firstUploadFrame = document.createElement('div');
        firstUploadFrame.className = 'news-frame';
        firstUploadFrame.innerHTML = `
            <div class="news-frame-header">First Workshop Upload <i data-lucide="award" style="width:14px;height:14px"></i></div>
            <div id="first-upload" style="font-size:14px; font-weight:700; color:var(--muted)">...</div>
        `;
        container.appendChild(firstUploadFrame);

        // --- FRAME 3: Latest Upload ---
        const latestUploadFrame = document.createElement('div');
        latestUploadFrame.className = 'news-frame';
        latestUploadFrame.innerHTML = `
            <div class="news-frame-header">Latest Workshop Upload <i data-lucide="clock" style="width:14px;height:14px"></i></div>
            <div id="latest-upload" style="font-size:14px; font-weight:700; color:var(--muted)">...</div>
        `;
        container.appendChild(latestUploadFrame);

        if (window.lucide) window.lucide.createIcons();

        const chatBox = document.getElementById('global-chat-box');
        const input = document.getElementById('global-chat-input');
        const send = document.getElementById('global-chat-send');

        const renderMessages = (msgs) => {
            chatBox.innerHTML = '';
            (msgs || []).forEach(m => {
                const row = document.createElement('div');
                row.style.padding='6px';
                row.style.borderBottom='1px solid rgba(0,0,0,0.04)';
                row.innerHTML = `<strong>${m.username||'anon'}</strong> <span style="color:var(--muted);font-size:12px;margin-left:6px">${new Date(m.created_at||Date.now()).toLocaleTimeString()}</span><div style="margin-top:4px;color:var(--muted)">${m.text||m.comment||m.raw_content||''}</div>`;
                chatBox.appendChild(row);
            });
            chatBox.scrollTop = chatBox.scrollHeight;
        };

        // Hook into remote storage comment APIs for the global chat (no localStorage fallback)
        try {
            if (this._globalChatUnsub) { try { this._globalChatUnsub(); } catch(e){} this._globalChatUnsub = null; }
            if (this.app.storage && typeof this.app.storage.subscribeWorkshopComments === 'function') {
                // Remote subscription only — do not fallback to localStorage
                try {
                    this._globalChatUnsub = this.app.storage.subscribeWorkshopComments('global_chat', (list) => {
                        renderMessages(list);
                    });
                } catch (subErr) {
                    console.warn('Remote global chat subscription failed:', subErr);
                    renderMessages([]);
                }
            } else {
                // No remote API available — show empty state and log (explicitly avoid localStorage)
                console.warn('Global chat unavailable: remote comment API not present.');
                renderMessages([]);
            }
        } catch (e) {
            console.warn('renderNews chat hookup failed', e);
            renderMessages([]);
        }

        const doSend = async () => {
            const txt = (input.value || '').trim();
            if (!txt) return;
            try {
                const username = (this.app.storage && typeof this.app.storage.loadAccount === 'function') ? (this.app.storage.loadAccount()?.username || 'anon') : 'anon';
                if (this.app.storage && typeof this.app.storage.createWorkshopComment === 'function') {
                    await this.app.storage.createWorkshopComment('global_chat', username, txt);
                    input.value = '';
                } else {
                    // Explicit: do not fall back to localStorage for global chat — inform the user
                    alert('Global chat is not available (remote service missing). Your message was not sent.');
                }
            } catch (e) {
                console.error('Failed to send global chat message:', e);
                alert('Failed to send message to global chat. See console for details.');
            }
        };

        send.addEventListener('click', doSend);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });

        // show first and latest workshop uploads using storage.listWorkshopEntries()
        const showUploads = async () => {
            try {
                const entries = (this.app.storage && typeof this.app.storage.listWorkshopEntries === 'function')
                    ? await this.app.storage.listWorkshopEntries()
                    : (this.app.storage ? this.app.storage.loadWorkshopLocal() : []);
                if (entries && entries.length) {
                    const sorted = entries.slice().sort((a,b)=> new Date(a.created_at) - new Date(b.created_at));
                    const first = sorted[0];
                    const latest = sorted[sorted.length-1];
                    const fEl = document.getElementById('first-upload');
                    const lEl = document.getElementById('latest-upload');
                    fEl.innerText = first?.world?.name || first?.world_name || '—';
                    lEl.innerText = latest?.world?.name || latest?.world_name || '—';
                } else {
                    document.getElementById('first-upload').innerText = 'No uploads';
                    document.getElementById('latest-upload').innerText = 'No uploads';
                }
            } catch (e) {
                console.warn('showUploads failed', e);
            }
        };
        showUploads();
    }

    getMarbleCSS(color) {
        // Accept either a string color name or an object describing a custom marble.
        // If it's an object prefer its css field, then label; otherwise fall back to string handling.
        try {
            if (!color) return '#9ca3af';
            if (typeof color === 'object') {
                // object shape: { id, label, css, meta }
                if (color.css) return color.css;
                if (color.label) return color.label.toString();
                // fallback to inspect meta or stringified object
                return JSON.stringify(color);
            }
            const c = String(color || '').toLowerCase();
            if (c === 'rainbow') return 'linear-gradient(90deg, red,orange,yellow,green,cyan,blue,indigo,violet)';
            if (c === 'monochrome') return 'linear-gradient(to bottom, white, black)';
            if (c === 'metallic') return 'linear-gradient(135deg,#a8a8a8,#e9e9e9,#6b6b6b)';
            if (c === 'silver') return 'linear-gradient(135deg,#cfcfcf,#ffffff,#9f9f9f)';
            if (c === 'gold') return 'linear-gradient(135deg,#ffd54a,#ffb300,#8b6f00)';
            if (c === 'peach') return 'linear-gradient(135deg,#ffd0b3,#ffb89a)';
            if (c === 'lavender') return 'linear-gradient(135deg,#e9d7ff,#d6c3ff)';
            if (c === 'teal') return '#14b8a6';
            if (c === 'indigo') return '#4f46e5';
            if (c === 'pink') return '#ec4899';
            if (c === 'magenta') return '#d946ef';
            if (c === 'brown') return '#8b5a2b';
            if (c === 'gray') return '#9ca3af';
            if (c === 'black') return '#111827';
            if (c === 'white') return 'linear-gradient(180deg,#ffffff,#f3f4f6)';
            // fallback: return the provided string unchanged
            return String(color);
        } catch (e) {
            return '#9ca3af';
        }
    }

    // Helper to normalize any css color to a hex color input friendly value (best-effort)
    _normalizeColorForInput(raw) {
        try {
            if (!raw) return '#3b82f6';
            // If already hex (#...), return as-is (ensure 7-char #rrggbb)
            if (typeof raw === 'string') {
                let s = raw.trim();
                if (s[0] === '#') {
                    if (s.length === 4) {
                        // expand shorthand #rgb -> #rrggbb
                        s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
                    }
                    return s.substring(0,7);
                }
                // If rgb(...) convert to hex
                const rgbMatch = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
                if (rgbMatch) {
                    const r = parseInt(rgbMatch[1],10), g = parseInt(rgbMatch[2],10), b = parseInt(rgbMatch[3],10);
                    const hx = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
                    return hx;
                }
                // otherwise fallback to default
                return '#3b82f6';
            }
            return '#3b82f6';
        } catch (e) { return '#3b82f6'; }
    }

    toggleMarble(color) {
        if (this.app.selectedMarbles.includes(color)) {
            this.app.selectedMarbles = this.app.selectedMarbles.filter(m => m !== color);
        } else {
            this.app.selectedMarbles.push(color);
        }
        this.app.storage.saveMarbleSelection(this.app.selectedMarbles);
        this.renderMarbles();
    }

    showPartSettings(part) {
        const modal = document.getElementById('part-settings-modal');
        const fields = document.getElementById('settings-fields');
        document.getElementById('settings-part-name').innerText = part.type.replace('_', ' ').toUpperCase();
        
        fields.innerHTML = '';

        // Provide a shared color input for most solid/visual parts so body.render.fillStyle is driven by part.color
        // and also keep it mirrored into part.settings.color for compatibility.
        const currentColor = this._normalizeColorForInput(part.color || (part.settings && part.settings.color) || '#3b82f6');
        const colorFieldHtml = `
            <label>Color</label>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <input type="color" id="setting-color" value="${currentColor}" style="width:56px;height:40px;padding:4px;border-radius:6px;border:1px solid rgba(0,0,0,0.06);">
              <button id="btn-reset-color" class="secondary-btn" style="padding:6px 8px;font-size:12px;">Reset Color</button>
            </div>
        `;
        fields.insertAdjacentHTML('beforeend', colorFieldHtml);
        
        // Bounciness slider for most solid parts (exposed as percentage that will be used additively on marbles)
        const showBouncinessFor = ['rectangle','polygon','triangle','moving_platform','spinner','bumper','sticky_platform'];
        if (showBouncinessFor.includes(part.type)) {
            const bounceVal = (typeof part.settings?.bounciness === 'number') ? Math.round(part.settings.bounciness * 100) : 0;
            fields.insertAdjacentHTML('beforeend', `
                <label>Part Bounciness Bonus (0-100%)</label>
                <input type="range" id="setting-bounce" min="0" max="100" value="${bounceVal}">
            `);
        }

        if (part.type === 'win_zone') {
            fields.insertAdjacentHTML('beforeend', `
                <label>Countdown Timer (sec)</label>
                <input type="number" id="setting-timer" value="${part.settings.timer}">
            `);
        } else if (part.type === 'fluid_sensor') {
            fields.insertAdjacentHTML('beforeend', `
                <label>Hold Duration (sec)</label>
                <input type="number" id="setting-release-seconds" min="0.01" max="65" step="0.01" value="${Number(part.settings?.release_seconds || 1)}">
                <div style="font-size:12px;color:var(--muted);margin-top:6px;">Stops marbles on touch and releases them after this many seconds.</div>
            `);
        } else if (part.type === 'fan') {
            // Fan-specific controls: direction (degrees) and force (game units)
            const deg = (typeof part.settings?.direction === 'number') ? (part.settings.direction * 180 / Math.PI).toFixed(1) : '-90.0';
            const forceVal = (typeof part.settings?.force === 'number') ? part.settings.force : 0.12;
            const rangeVal = (typeof part.settings?.range === 'number') ? part.settings.range : (32 * 6);
            const spreadVal = (typeof part.settings?.spread === 'number') ? part.settings.spread : 60; // degrees total cone
            fields.insertAdjacentHTML('beforeend', `
                <label>Direction (deg)</label>
                <input type="number" id="setting-fan-direction" value="${deg}" step="1" min="-360" max="360">
                <label>Force</label>
                <input type="number" id="setting-fan-force" value="${forceVal}" step="0.01" min="0" max="10">
                <label>Range (px)</label>
                <input type="number" id="setting-fan-range" value="${rangeVal}" step="1" min="8" max="5000">
                <label>Spread (deg)</label>
                <input type="number" id="setting-fan-spread" value="${spreadVal}" step="1" min="1" max="179">
                <div style="font-size:12px;color:var(--muted);margin-top:6px;">Direction in degrees (0 = right, -90 = up). Force controls strength; Range sets cone length in pixels; Spread sets cone width in degrees.</div>
            `);
        } else {
            if (part.type === 'moving_platform') {
                fields.insertAdjacentHTML('beforeend', `
                    <label>Speed</label>
                    <input type="number" id="setting-speed" value="${part.settings?.speed || 40}">
                `);
            }
            if (part.type === 'spinner') {
                fields.insertAdjacentHTML('beforeend', `
                    <label>Spin Speed</label>
                    <input type="number" id="setting-spin" value="${part.settings?.speed || 2}">
                `);
            }
        }

        modal.classList.remove('hidden');
        document.getElementById('modal-overlay').classList.remove('hidden');

        // Wire Reset Color button (if present)
        const resetBtn = document.getElementById('btn-reset-color');
        if (resetBtn) {
            resetBtn.onclick = () => {
                // Reset to sensible default and update color picker
                const defaultColor = this._normalizeColorForInput(part.settings?.color || '#3b82f6');
                const colorEl = document.getElementById('setting-color');
                if (colorEl) colorEl.value = defaultColor;
            };
        }

        document.getElementById('btn-save-settings').onclick = () => {
            // Save color first (applies broadly)
            const colorEl = document.getElementById('setting-color');
            if (colorEl) {
                const normalized = this._normalizeColorForInput(colorEl.value);
                try { part.color = normalized; } catch(e) {}
                try { part.settings = part.settings || {}; part.settings.color = normalized; } catch(e) {}
            }

            // Read bounciness slider if present and clamp to [0,1]
            const bounceEl = document.getElementById('setting-bounce');
            if (bounceEl) {
                let bv = Number(bounceEl.value || 0);
                bv = Math.max(0, Math.min(100, bv));
                part.settings = part.settings || {};
                part.settings.bounciness = bv / 100; // store as 0..1
            }

            if (part.type === 'win_zone') {
                const timerEl = document.getElementById('setting-timer');
                if (timerEl) part.settings.timer = parseInt(timerEl.value, 10);
            }
            if (part.type === 'moving_platform') {
                const speedEl = document.getElementById('setting-speed');
                if (speedEl) part.settings.speed = Number(speedEl.value);
            }
            if (part.type === 'spinner') {
                const spinEl = document.getElementById('setting-spin');
                if (spinEl) part.settings.speed = Number(spinEl.value);
            }
            if (part.type === 'fluid_sensor') {
                const relEl = document.getElementById('setting-release-seconds');
                if (relEl) {
                    let val = Number(relEl.value || 0);
                    if (!Number.isFinite(val)) val = 1;
                    // clamp to allowed range 0.01 .. 65
                    val = Math.max(0.01, Math.min(65, val));
                    part.settings = part.settings || {};
                    part.settings.release_seconds = val;
                }
            }
            if (part.type === 'fan') {
                const dirEl = document.getElementById('setting-fan-direction');
                const forceEl = document.getElementById('setting-fan-force');
                const rangeEl = document.getElementById('setting-fan-range');
                const spreadEl = document.getElementById('setting-fan-spread');
                if (!part.settings) part.settings = {};
                if (dirEl) {
                    // convert degrees to radians for internal storage
                    const deg = Number(dirEl.value || 0);
                    const rad = (isFinite(deg) ? (deg * Math.PI / 180) : -Math.PI / 2);
                    part.settings.direction = rad;
                }
                if (forceEl) {
                    let fv = Number(forceEl.value || 0);
                    if (!Number.isFinite(fv)) fv = 0.12;
                    part.settings.force = Math.max(0, fv);
                }
                if (rangeEl) {
                    let rv = Number(rangeEl.value || 0);
                    if (!Number.isFinite(rv)) rv = (32 * 6);
                    part.settings.range = Math.max(8, rv);
                }
                if (spreadEl) {
                    let sv = Number(spreadEl.value || 0);
                    if (!Number.isFinite(sv)) sv = 60;
                    // clamp spread to sensible 1..179 degrees (avoid degenerate cones)
                    sv = Math.max(1, Math.min(179, sv));
                    part.settings.spread = sv;
                }
            }

            // Persist to storage if this world is saved and update UI thumbs
            try {
                if (this.app && this.app.storage && typeof this.app.storage.saveWorld === 'function') {
                    try { this.app.storage.saveWorld(this.app.editor.getWorldData()); } catch (e) { /* fallback below */ }
                }
            } catch (e) {}

            this.hideModals();
        };
    }

    showConfirm(title, msg, onConfirm) {
        if (confirm(`${title}\n\n${msg}`)) onConfirm();
    }

    hideModals() {
        document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
        document.getElementById('modal-overlay').classList.add('hidden');
    }

    // Ensure there's a small usage UI in the settings pane
    ensureSettingsUsageUI() {
        const settings = document.querySelector('.settings-list');
        if (!settings) return;
        // avoid duplicating
        if (document.getElementById('db-usage-container')) return;
        const container = document.createElement('div');
        container.id = 'db-usage-container';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '8px';
        container.style.marginTop = '8px';
        container.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <div style="display:flex;flex-direction:column;">
                    <strong style="font-size:13px">Database Usage</strong>
                    <span id="db-usage-max" style="font-size:12px;color:var(--muted);margin-top:2px;">Cap: —</span>
                </div>
                <button id="btn-refresh-db-usage" class="secondary-btn" style="padding:6px 8px;font-size:12px">Refresh</button>
            </div>
            <div id="db-usage-bars" style="display:flex;flex-direction:column;gap:6px;">
                <div style="font-size:12px;color:var(--muted)">User Worlds <span id="db-user-count" style="float:right"></span>
                    <div style="background:rgba(255,255,255,0.04);height:8px;border-radius:6px;margin-top:4px;overflow:hidden;">
                        <div id="db-user-bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--accent),var(--accent-2));"></div>
                    </div>
                </div>
                <div style="font-size:12px;color:var(--muted)">Workshop <span id="db-community-count" style="float:right"></span>
                    <div style="background:rgba(255,255,255,0.04);height:8px;border-radius:6px;margin-top:4px;overflow:hidden;">
                        <div id="db-community-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#60a5fa,#38bdf8);"></div>
                    </div>
                </div>
                <div style="font-size:12px;color:var(--muted)">Comments <span id="db-comments-count" style="float:right"></span>
                    <div style="background:rgba(255,255,255,0.04);height:8px;border-radius:6px;margin-top:4px;overflow:hidden;">
                        <div id="db-comments-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#34d399,#10b981);"></div>
                    </div>
                </div>
            </div>
        `;
        settings.appendChild(container);
        const btn = document.getElementById('btn-refresh-db-usage');
        if (btn) btn.addEventListener('click', () => this.updateDatabaseUsage());
    }

    // Query storage for DB counts and update a simple progress UI.
    async updateDatabaseUsage() {
        if (!this.app || !this.app.storage || typeof this.app.storage.getDatabaseUsage !== 'function') return;
        try {
            // storage now returns raw byte counts
            const usage = await this.app.storage.getDatabaseUsage(); // { user_bytes, community_bytes, comments_bytes }

            // Adaptive formatter: convert bytes into human-friendly unit (bit/byte/kb/mb/gb/tb)
            const adapt = (bytes) => {
                // If zero, show "0 byte"
                if (!bytes) return { value: 0, label: '0 byte' };

                // For very small payloads, show bits (if <1 byte show bits, else bytes and up)
                if (bytes < 1) {
                    const bits = Math.round(bytes * 8);
                    return { value: bits, label: `${bits} bit` };
                }

                const units = ['byte', 'KB', 'MB', 'GB', 'TB'];
                let v = Number(bytes);
                let idx = 0;
                while (v >= 1024 && idx < units.length - 1) {
                    v = v / 1024;
                    idx++;
                }
                // Format to two decimals when >= KB, otherwise integer bytes
                const formatted = (idx === 0) ? `${Math.round(v)} byte` : `${v.toFixed(2)} ${units[idx]}`;
                return { value: v, label: formatted };
            };

            const user = adapt(usage.user_bytes || 0);
            const comm = adapt(usage.community_bytes || 0);
            const comments = adapt(usage.comments_bytes || 0);

            // For bar visualization we need a numeric scale. Use bytes and a soft cap chosen adaptively:
            // Fixed soft cap: use 50 MB as the visualization scale cap so bars are comparable across runs
            const softCap = 50 * 1024 * 1024;

            const pctOf = (n) => Math.round(Math.min(100, (n / softCap) * 100));

            const userPct = pctOf(usage.user_bytes || 0);
            const commPct = pctOf(usage.community_bytes || 0);
            const commentsPct = pctOf(usage.comments_bytes || 0);

            const elUser = document.getElementById('db-user-bar');
            const elComm = document.getElementById('db-community-bar');
            const elComments = document.getElementById('db-comments-bar');
            const cntUser = document.getElementById('db-user-count');
            const cntComm = document.getElementById('db-community-count');
            const cntComments = document.getElementById('db-comments-count');
            const elMax = document.getElementById('db-usage-max');

            if (elUser) elUser.style.width = userPct + '%';
            if (elComm) elComm.style.width = commPct + '%';
            if (elComments) elComments.style.width = commentsPct + '%';

            if (cntUser) cntUser.innerText = user.label;
            if (cntComm) cntComm.innerText = comm.label;
            if (cntComments) cntComments.innerText = comments.label;

            if (elMax) {
                // Show the soft cap in an adaptive unit as well
                const adaptCap = (b) => {
                    if (!b) return '0 byte';
                    const units = ['byte', 'KB', 'MB', 'GB', 'TB'];
                    let v = Number(b);
                    let idx = 0;
                    while (v >= 1024 && idx < units.length - 1) { v /= 1024; idx++; }
                    return (idx === 0) ? `${Math.round(v)} byte` : `${v.toFixed(2)} ${units[idx]}`;
                };
                elMax.innerText = `Scale cap: ${adaptCap(softCap)} (${softCap.toLocaleString()} B)`;
            }
        } catch (e) {
            console.warn('updateDatabaseUsage failed', e);
        }
    }
}