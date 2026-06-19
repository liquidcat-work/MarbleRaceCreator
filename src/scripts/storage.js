import pako from 'https://esm.sh/pako@2.1.0';

export class Storage {
    constructor() {
        this.keys = { 
            worlds: 'marble_worlds_v2', 
            marble: 'marble_sel_v2', 
            acc: 'marble_acc_v2', 
            ws_local: 'ws_entries_local_v2',
            cm_local: 'ws_cm_local_v2',
            music: 'marble_music_v1'
        };
    }

    _room() { return window.room; }

    /* -----------------------
       User worlds (Local Only as requested previously)
       ----------------------- */

    async saveWorld(w) {
        w.id ||= Date.now(); 
        w.created ||= Date.now(); 
        w.name ||= `World ${w.id}`;
        const l = this.loadWorlds(); 
        const i = l.findIndex(x => x.id === w.id);
        if (i !== -1) l[i] = w; else l.push(w);
        localStorage.setItem(this.keys.worlds, JSON.stringify(l));
    }

    loadWorlds() {
        try { 
            const d = localStorage.getItem(this.keys.worlds); 
            return JSON.parse(d) || []; 
        } catch(e){ return []; }
    }

    async deleteWorld(id) {
        localStorage.setItem(this.keys.worlds, JSON.stringify(this.loadWorlds().filter(x => x.id !== id)));
    }

    /* -----------------------
       Marble selection
       ----------------------- */
    saveMarbleSelection(marbles) {
        localStorage.setItem(this.keys.marble, JSON.stringify(marbles));
    }

    loadMarbleSelection() {
        const data = localStorage.getItem(this.keys.marble);
        return data ? JSON.parse(data) : null;
    }

    /* -----------------------
       Music selection + volume persistence
       ----------------------- */
    saveMusicChoice(obj) {
        try { localStorage.setItem(this.keys.music, JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }

    loadMusicChoice() {
        try {
            const d = localStorage.getItem(this.keys.music);
            return d ? JSON.parse(d) : null;
        } catch (e) { return null; }
    }

    /* Debug / dev toggles persistence */
    saveDebugRenderCollider(enabled) {
        try { localStorage.setItem(this.keys.music + '_debug_collider', JSON.stringify({ colliderOutline: !!enabled })); } catch (e) { /* ignore */ }
    }

    loadDebugRenderCollider() {
        try {
            const d = localStorage.getItem(this.keys.music + '_debug_collider');
            const parsed = d ? JSON.parse(d) : null;
            return parsed ? !!parsed.colliderOutline : false;
        } catch (e) { return false; }
    }

    /* -----------------------
       Community (workshop) using "workshop_v3" collection
       ----------------------- */

    _decodeEntry(e) {
        if (!e) return null;
        const out = { ...e };
        // If the record includes a gzipped base64 snapshot, decode it into world
        if (out.world_gzip_b64) {
            try {
                const binStr = atob(out.world_gzip_b64);
                const len = binStr.length;
                const buf = new Uint8Array(len);
                for (let i = 0; i < len; i++) buf[i] = binStr.charCodeAt(i);
                const decompressed = pako.ungzip(buf, { to: 'string' });
                out.world = JSON.parse(decompressed);
            } catch (err) {
                console.warn('Failed to decompress world_gzip_b64', err);
                out.world = out.world_data || {};
            }
        } else if (out.world_data) {
            out.world = out.world_data;
        } else {
            out.world = {};
        }
        return out;
    }

    async createWorkshopEntry(world) {
        // Build metadata and store a gzipped base64 snapshot for full fidelity.
        const username = (await this._getLocalUsername()) || 'anon';
        const worldJson = JSON.stringify(world || {});
        let gzipB64 = null;

        try {
            const gz = pako.gzip(worldJson);
            let binary = '';
            const arr = new Uint8Array(gz);
            const CHUNK = 0x8000;
            for (let i = 0; i < arr.length; i += CHUNK) {
                binary += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
            }
            gzipB64 = btoa(binary);
        } catch (e) {
            console.warn('gzip compression failed; proceeding without gzip', e);
            gzipB64 = null;
        }

        const payload = {
            world_name: world.name || `World ${Date.now()}`,
            parts_count: (world.parts || []).length,
            username,
            created_at: new Date().toISOString(),
            world_preview: {
                id: world.id,
                name: world.name,
                parts_count: (world.parts || []).length
            },
            world_gzip_b64: gzipB64,
            world_index: {
                name: world.name,
                parts: (world.parts || []).length
            }
        };

        // Strict remote-only behavior: require a remote room. Do not fall back to localStorage.
        const room = this._room();
        if (!room) throw new Error('Remote workspace unavailable: cannot create workshop entry without room.');

        // Try v3 first, then v2. Propagate errors to caller if both fail.
        try {
            const rec = await room.collection('workshop_v3').create(payload);
            if (!gzipB64) {
                try {
                    await room.collection('workshop_v3').update(rec.id, { world_data: world });
                } catch (e) { /* ignore best-effort update errors */ }
            }
            return rec;
        } catch (e) {
            // try v2 as a fallback remote collection
            try {
                const rec2 = await room.collection('workshop_v2').create(payload);
                if (!gzipB64) {
                    try {
                        await room.collection('workshop_v2').update(rec2.id, { world_data: world });
                    } catch (ee) {}
                }
                return rec2;
            } catch (err2) {
                // bubble error
                throw new Error('Failed to create workshop entry on remote services: ' + (err2 && err2.message ? err2.message : String(err2)));
            }
        }
    }

    async deleteWorkshopEntry(entryId) {
        const room = this._room();
        if (!room) throw new Error('Remote workspace unavailable: cannot delete workshop entry without room.');

        try {
            await room.collection('workshop_v3').delete(entryId);
            return true;
        } catch (e) {
            // try v2 as fallback remote
            try {
                await room.collection('workshop_v2').delete(entryId);
                return true;
            } catch (e2) {
                throw new Error('Failed to delete remote workshop entry: ' + (e2 && e2.message ? e2.message : String(e2)));
            }
        }
    }

    subscribeWorkshopEntries(callback) {
        const room = this._room();
        if (!room) throw new Error('Remote workspace unavailable: cannot subscribe to workshop entries without room.');

        try {
            let latestV3 = [];
            let latestV2 = [];

            const fireMerged = () => {
                const merged = [];
                const seen = new Set();
                (latestV3 || []).forEach(e => { const d = this._decodeEntry(e); if (d) { merged.push(d); seen.add(String(d.id)); } });
                (latestV2 || []).forEach(e => { const d = this._decodeEntry(e); if (d && !seen.has(String(d.id))) merged.push(d); });
                callback(merged);
            };

            const unsubV3 = room.collection('workshop_v3').subscribe((entries) => {
                latestV3 = entries || [];
                fireMerged();
            });
            const unsubV2 = room.collection('workshop_v2').subscribe((entries) => {
                latestV2 = entries || [];
                fireMerged();
            });

            // return combined unsubscribe
            return () => { try { if (unsubV3) unsubV3(); } catch (e) {} try { if (unsubV2) unsubV2(); } catch (e) {} };
        } catch (e) {
            throw new Error('Failed to subscribe to remote workshop entries: ' + (e && e.message ? e.message : String(e)));
        }
    }

    async listWorkshopEntries() {
        const room = this._room();
        if (!room) throw new Error('Remote workspace unavailable: cannot list workshop entries without room.');

        try {
            const [v3raw, v2raw] = await Promise.allSettled([
                room.collection('workshop_v3').getList(),
                room.collection('workshop_v2').getList()
            ]);

            const v3list = (v3raw.status === 'fulfilled' && Array.isArray(v3raw.value)) ? v3raw.value : [];
            const v2list = (v2raw.status === 'fulfilled' && Array.isArray(v2raw.value)) ? v2raw.value : [];

            const merged = [];
            const seen = new Set();
            (v3list || []).forEach(e => {
                const dec = this._decodeEntry(e);
                if (dec && !seen.has(String(dec.id))) { merged.push(dec); seen.add(String(dec.id)); }
            });
            (v2list || []).forEach(e => {
                const dec = this._decodeEntry(e);
                if (dec && !seen.has(String(dec.id))) { merged.push(dec); seen.add(String(dec.id)); }
            });

            return merged;
        } catch (err) {
            throw new Error('Failed to list remote workshop entries: ' + (err && err.message ? err.message : String(err)));
        }
    }

    loadWorkshopLocal() {
        // Local workshop listing intentionally disabled — remote-only mode enforced.
        throw new Error('Local workshop access disabled: use remote workshop via room API.');
    }

    /* -----------------------
       Workshop comments
       ----------------------- */

    async createWorkshopComment(entryId, username, text) {
        if (!this._room()) throw new Error('Remote workspace unavailable: cannot post comment without room.');
        const payload = {
            entry_id: String(entryId),
            username: username || (await this._getLocalUsername()) || 'anon',
            text: text || '',
        };
        try {
            return await this._room().collection('workshop_comment_v3').create(payload);
        } catch (e) {
            throw new Error('Failed to post remote comment: ' + (e && e.message ? e.message : String(e)));
        }
    }

    subscribeWorkshopComments(entryId, callback) {
        const room = this._room();
        if (!room) throw new Error('Remote workspace unavailable: cannot subscribe to comments without room.');

        try {
            return room.collection('workshop_comment_v3').filter({ entry_id: String(entryId) }).subscribe((rows) => {
                callback((rows || []).slice().reverse());
            });
        } catch (e) {
            throw new Error('Failed to subscribe to remote comments: ' + (e && e.message ? e.message : String(e)));
        }
    }

    async listWorkshopComments(entryId) {
        const room = this._room();
        if (!room) throw new Error('Remote workspace unavailable: cannot list comments without room.');

        try {
            const raw = await room.collection('workshop_comment_v3').filter({ entry_id: String(entryId) }).getList();
            return (raw || []).slice().reverse();
        } catch (e) {
            throw new Error('Failed to list remote comments: ' + (e && e.message ? e.message : String(e)));
        }
    }

    async getDatabaseUsage() {
        // Report usage for remote resources only; do not attempt local fallbacks.
        if (!this._room()) throw new Error('Remote workspace unavailable: cannot compute database usage without room.');

        const sizeOf = (obj) => {
            try { return new TextEncoder().encode(JSON.stringify(obj)).length; } catch (e) { return 0; }
        };

        try {
            const [ws, cm] = await Promise.all([
                this._room().collection('workshop_v3').getList(),
                this._room().collection('workshop_comment_v3').getList()
            ]);
            const result = {
                user_bytes: sizeOf(this.loadWorlds()), // still reflects local user worlds
                community_bytes: sizeOf(ws),
                comments_bytes: sizeOf(cm)
            };
            return result;
        } catch (e) {
            throw new Error('Failed to get remote database usage: ' + (e && e.message ? e.message : String(e)));
        }
    }

    saveAccount(account) { localStorage.setItem(this.keys.acc, JSON.stringify(account)); }
    loadAccount() {
        try { return JSON.parse(localStorage.getItem(this.keys.acc)); } catch(e){ return null; }
    }

    // return a best-effort username from websim or local account
    async _getLocalUsername() {
        try {
            if (typeof window !== 'undefined' && window.websim && typeof window.websim.getCreatedBy === 'function') {
                const creator = await window.websim.getCreatedBy();
                if (creator?.username) return creator.username;
            }
        } catch (e) { /* ignore */ }

        const acc = this.loadAccount();
        return acc?.username || null;
    }
}