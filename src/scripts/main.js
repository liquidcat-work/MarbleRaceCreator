import { createIcons, icons, Move, Maximize2, Pencil } from 'lucide';
import { Editor } from './editor.js';
import { Storage } from './storage.js';
import { PhysicsSim } from './physics.js';
import { UI } from './ui.js';

class App {
    constructor() {
        this.currentTab = 'races';
        this.editor = null;
        this.simulation = null;
        this.selectedMarbles = ['Red', 'Blue', 'Green']; // Default selection
        
        this.init();
    }

    async init() {
        createIcons({ icons });
        this.setupViewportProtection();
        try {
            // Standard WebsimSocket initialization
            window.room = new WebsimSocket(); 
        } catch (e) {
            console.warn("Room init failed:", e);
        }
        this.storage = new Storage();
        this.ui = new UI(this);
        this.editor = new Editor(this);
        this.simulation = new PhysicsSim(this);

        this.setupEventListeners();
        this.loadMarbles();
        this.ui.renderRaces();
        
        // Initial state
        this.switchTab('races');
    }

    setupViewportProtection() {
        const stopGestureZoom = (event) => {
            if (event.touches && event.touches.length > 1) {
                event.preventDefault();
            }
        };

        const stopDoubleTapZoom = (event) => {
            if (event.type === 'dblclick' || event.type === 'gesturestart' || event.type === 'gesturechange' || event.type === 'gestureend') {
                event.preventDefault();
            }
        };

        document.addEventListener('touchstart', stopGestureZoom, { passive: false });
        document.addEventListener('touchmove', stopGestureZoom, { passive: false });
        document.addEventListener('touchend', stopGestureZoom, { passive: false });
        document.addEventListener('dblclick', stopDoubleTapZoom, { passive: false });
        document.addEventListener('gesturestart', stopDoubleTapZoom, { passive: false });
        document.addEventListener('gesturechange', stopDoubleTapZoom, { passive: false });
        document.addEventListener('gestureend', stopDoubleTapZoom, { passive: false });

        window.addEventListener('wheel', (event) => {
            if (event.ctrlKey) event.preventDefault();
        }, { passive: false });

        document.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '0'].includes(event.key)) {
                event.preventDefault();
            }
        });

        const zoomTargets = [
            document.documentElement,
            document.body,
            document.getElementById('app'),
            document.getElementById('content-area'),
            document.getElementById('bottom-tabs'),
            ...document.querySelectorAll('button, input, select, textarea, canvas, .nav-tab, .tool-btn, .parts-tab, .tool-cat-btn, .modal, .modal-content')
        ];

        zoomTargets.filter(Boolean).forEach((element) => {
            element.style.touchAction = 'none';
            element.style.webkitTouchCallout = 'none';
            element.style.webkitUserSelect = 'none';
            element.style.userSelect = 'none';
        });

        const contentArea = document.getElementById('content-area');
        if (contentArea) {
            contentArea.style.touchAction = 'pan-y';
        }
    }

    setupEventListeners() {
        // Bottom Tabs (guarded)
        const navTabs = document.querySelectorAll('.nav-tab');
        if (navTabs && navTabs.length) {
            navTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const tabName = tab.getAttribute('data-tab');
                    this.switchTab(tabName);
                });
            });
        }

        // Editor parts-tab refresh (guarded)
        const partsTabs = document.querySelectorAll('.parts-tab');
        if (partsTabs && partsTabs.length) {
            partsTabs.forEach(btn => {
                btn.addEventListener('click', () => {
                    if (this.editor) this.editor.renderPartsList();
                });
            });
        }

        // New race button (guarded)
        const btnNewRace = document.getElementById('btn-new-race');
        if (btnNewRace) {
            btnNewRace.addEventListener('click', () => {
                if (this.editor && typeof this.editor.createNewWorld === 'function') {
                    this.editor.createNewWorld();
                    this.switchTab('editor');
                }
            });
        }

        // Safe bindings for optional buttons (defensive)
        const exitEditorBtn = document.getElementById('btn-exit-editor');
        if (exitEditorBtn) {
            exitEditorBtn.addEventListener('click', () => {
                if (this.editor && this.editor.hasUnsavedChanges) {
                    this.ui.showConfirm('Unsaved Changes', 'You have unsaved changes. Continue to menu?', () => {
                        // Discard unsaved edits by resetting the editor to a fresh world,
                        // then return to the Races tab.
                        try {
                            if (this.editor && typeof this.editor.createNewWorld === 'function') {
                                this.editor.createNewWorld();
                            } else if (this.editor) {
                                this.editor.world = { id: Date.now(), name: 'New Race', parts: [], wires: [], created: Date.now() };
                                this.editor.hasUnsavedChanges = false;
                            }
                        } catch (e) { /* ignore reset errors */ }
                        this.switchTab('races');
                    });
                } else {
                    this.switchTab('races');
                }
            });
        }

        const playRaceBtn = document.getElementById('btn-play-race');
        if (playRaceBtn) {
            playRaceBtn.addEventListener('click', () => {
                this.startRace();
            });
        }

        const playMenuBtn = document.getElementById('btn-play-menu');
        if (playMenuBtn) {
            playMenuBtn.addEventListener('click', () => {
                const el = document.getElementById('play-burger-content');
                if (el) el.classList.remove('hidden');
            });
        }

        const closeBurgerBtn = document.getElementById('btn-close-burger');
        if (closeBurgerBtn) {
            closeBurgerBtn.addEventListener('click', () => {
                const el = document.getElementById('play-burger-content');
                if (el) el.classList.add('hidden');
            });
        }

        const exitPlayBtn = document.getElementById('btn-exit-play');
        if (exitPlayBtn) {
            exitPlayBtn.addEventListener('click', () => {
                this.stopRace();
                const el = document.getElementById('play-burger-content');
                if (el) el.classList.add('hidden');
            });
        }

        const restartBtn = document.getElementById('btn-restart-race');
        if (restartBtn) {
            restartBtn.addEventListener('click', () => {
                this.startRace();
                const el = document.getElementById('play-burger-content');
                if (el) el.classList.add('hidden');
            });
        }
    }

    switchTab(tabName) {
        // clear previous tab state
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

        // mark nav
        const activeTab = document.querySelector(`.nav-tab[data-tab="${tabName}"]`);
        if (activeTab) activeTab.classList.add('active');

        // handle editor special full-screen view
        const editorView = document.getElementById('editor-view');
        const playView = document.getElementById('play-view');
        const bottomTabs = document.getElementById('bottom-tabs');

        if (tabName === 'editor') {
            if (editorView) editorView.classList.remove('hidden');
            if (this.editor && typeof this.editor.onOpen === 'function') this.editor.onOpen();
            // hide bottom tabs while in editor for a focused workspace
            if (bottomTabs) bottomTabs.classList.add('hidden');
            // ensure other panes are not active
            if (playView) playView.classList.add('hidden');
        } else {
            // leaving editor: ensure editor view hidden
            if (editorView) editorView.classList.add('hidden');

            // Activate the requested pane (if exists)
            const pane = document.getElementById(`tab-${tabName}`);
            if (pane) pane.classList.add('active');

            // Show bottom tabs unless play view is currently active
            if (bottomTabs) {
                const playVisible = playView && !playView.classList.contains('hidden');
                if (!playVisible) bottomTabs.classList.remove('hidden');
            }
        }

        // When switching to play tab via nav (if any), ensure play view visibility is respected
        if (tabName === 'races') this.ui.renderRaces();
        if (tabName === 'marbles') this.ui.renderMarbles();
        if (tabName === 'community') this.ui.renderCommunity();
        if (tabName === 'news') this.ui.renderNews();

        this.currentTab = tabName;
    }

    loadMarbles() {
        const saved = this.storage.loadMarbleSelection();
        if (saved) this.selectedMarbles = saved;
    }

    async startRace() {
        const loadingOverlay = document.getElementById('loading-overlay');
        loadingOverlay.classList.remove('hidden');

        // Wait 1 second as requested
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Compute centroid and export data while the screen is black/loading
        const worldData = this.editor.getWorldData();
        
        if (!worldData.parts.find(p => p.type === 'spawner' || p.type === 'spawn_point')) {
            loadingOverlay.classList.add('hidden');
            alert('Add a Marble Spawn Point first!');
            return;
        }
        
        // Resolve selected marble descriptors: map selected labels to palette entries (objects) so
        // the physics layer receives full metadata (meta/colors) rather than just a label string.
        const resolvedMarbles = (this.selectedMarbles || []).map(label => {
            // prefer object entries in UI palette that match this label
            const found = (Array.isArray(this.ui.marbleColors) ? this.ui.marbleColors.find(c => {
                if (typeof c === 'object' && c.label) return String(c.label) === String(label);
                return String(c) === String(label);
            }) : null);

            if (found && typeof found === 'object') {
                // If a meta object exists, pass it intact so PhysicsSim can interpret gradients/special types.
                return {
                    label: found.label,
                    css: found.css,
                    meta: found.meta || {}
                };
            }

            // fallback: treat the label as a simple color name/string
            return { label, meta: {}, color: String(label) };
        });

        document.getElementById('editor-view').classList.add('hidden');
        document.getElementById('play-view').classList.remove('hidden');
        document.getElementById('bottom-tabs').classList.add('hidden');
        loadingOverlay.classList.add('hidden');
        
        // Pass the exact world snapshot and resolved marble descriptors
        this.simulation.start(worldData, resolvedMarbles);
    }

    stopRace() {
        this.simulation.stop();
        document.getElementById('play-view').classList.add('hidden');
        document.getElementById('editor-view').classList.remove('hidden');
        // Ensure bottom tabs are visible again when exiting play mode
        document.getElementById('bottom-tabs').classList.remove('hidden');
    }

    exitToMain() {
        this.stopRace();
        this.switchTab('races');
        document.getElementById('bottom-tabs').classList.remove('hidden');
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
