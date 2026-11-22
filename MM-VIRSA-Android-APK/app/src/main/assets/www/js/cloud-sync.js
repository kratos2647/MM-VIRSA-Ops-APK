/**
 * js/cloud-sync.js
 * Dual-Layer Persistence & Multi-Device Sync Engine for MM VIRSA Ops:
 *  Layer 1 (Always-On Local Disk DB):
 *    When running inside MM-VIRSA-Ops.exe (or Start-VIRSA-Portal.bat), mirrors every change
 *    to %LOCALAPPDATA%\MM-VIRSA-Ops\virsa-database.json + automatic daily rolling backups.
 *  Layer 2 (Two-Way Cloud Sync — Desktop .exe <-> Mobile Phones):
 *    Supports Google Sheets Web App (free) OR Firebase Realtime Database REST URL.
 *    Uses timestamp-based merge (updatedAt) so desktop & mobile never overwrite each other.
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  const SYNC_CFG_KEY = 'virsa_ops_cloud_sync_v1';
  const DEFAULT_VIRSA_SHEETS_URL =
    'https://script.google.com/macros/s/AKfycbxpROCBmg_m892lKf-91ZMKSjyJDd-9RTIrCt4y_bNhikSWzsXixVrvY-NWmW9FptWXBA/exec';
  let pushTimer = null;
  let pullInterval = null;
  let isSyncingNow = false;
  let hasPendingLocalChanges = false;
  let lifecycleBound = false;
  let onStatusChange = null;

  function computeFingerprint(parcels, deletedIds, customCouriers) {
    const pSig = (Array.isArray(parcels) ? parcels : [])
      .map((p) => `${p.trackingNumber}|${p.status}|${p.updatedAt || ''}|${p.returnedAt || ''}|${p.notes || ''}`)
      .sort()
      .join(';');
    const dSig = (Array.isArray(deletedIds) ? deletedIds : []).slice().sort().join(',');
    const cSig = (Array.isArray(customCouriers) ? customCouriers : []).map((c) => c.name).sort().join(',');
    return `${pSig}#${dSig}#${cSig}`;
  }

  function defaultSyncConfig() {
    return {
      enabled: true,
      provider: 'google_sheets', // 'google_sheets' | 'firebase'
      endpointUrl: DEFAULT_VIRSA_SHEETS_URL,
      secretToken: '',
      autoSync: true,
      lastCloudSyncAt: null,
      lastDiskSaveAt: null,
      lastError: ''
    };
  }

  function loadConfig() {
    try {
      const raw = global.localStorage.getItem(SYNC_CFG_KEY);
      if (!raw) return defaultSyncConfig();
      const parsed = App.Security ? App.Security.safeJSONParse(raw) : JSON.parse(raw);
      const merged = Object.assign(defaultSyncConfig(), parsed);
      // If previously saved with empty URL, auto-activate the pre-configured VIRSA Google Sheets endpoint
      if (!merged.endpointUrl) {
        merged.endpointUrl = DEFAULT_VIRSA_SHEETS_URL;
        merged.provider = 'google_sheets';
        merged.enabled = true;
      }
      return merged;
    } catch (_) {
      return defaultSyncConfig();
    }
  }

  function saveConfig(patch) {
    const next = Object.assign({}, loadConfig(), patch);
    try {
      global.localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(next));
    } catch (_) {}
    if (onStatusChange) onStatusChange();
    return next;
  }

  function hasLocalDiskBackend() {
    return Boolean(
      global.location &&
        (global.location.hostname === 'localhost' || global.location.hostname === '127.0.0.1') &&
        global.location.port === '8787'
    );
  }

  // -------------------------------------------------------------------------
  // Smart Conflict-Free Merge (Preserves newest update per parcel + deletions)
  // -------------------------------------------------------------------------
  function mergeParcelLists(localList, remoteList, deletedIdsSet) {
    const map = new Map();
    const deleted = deletedIdsSet || new Set();

    const ingest = (item) => {
      if (!item || !item.trackingNumber) return;
      const key = App.Couriers.normalizeTracking(item.trackingNumber);
      if (deleted.has(item.id) || deleted.has(key)) return;

      const prev = map.get(key);
      if (!prev) {
        map.set(key, item);
        return;
      }
      const prevTs = Date.parse(prev.updatedAt || prev.createdAt || 0) || 0;
      const currTs = Date.parse(item.updatedAt || item.createdAt || 0) || 0;
      if (currTs >= prevTs) {
        // Keep the newer version, preserving non-empty fields from older if newer lacks them
        map.set(key, Object.assign({}, prev, item));
      }
    };

    (Array.isArray(localList) ? localList : []).forEach(ingest);
    (Array.isArray(remoteList) ? remoteList : []).forEach(ingest);

    return Array.from(map.values()).sort((a, b) => {
      const ta = Date.parse(a.createdAt || a.updatedAt || 0) || 0;
      const tb = Date.parse(b.createdAt || b.updatedAt || 0) || 0;
      return tb - ta;
    });
  }

  function mergeCouriers(localC, remoteC) {
    const seen = new Set();
    const out = [];
    [...(localC || []), ...(remoteC || [])].forEach((c) => {
      if (!c || !c.name) return;
      const k = c.name.trim().toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(c);
      }
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // Layer 1: Local Disk Database (/api/db on Desktop .exe / localhost:8787)
  // -------------------------------------------------------------------------
  async function loadFromLocalDisk() {
    if (!hasLocalDiskBackend()) return { ok: false, reason: 'no_local_server' };
    try {
      const res = await fetch('/api/db', { method: 'GET', cache: 'no-store' });
      if (!res.ok) return { ok: false };
      const data = await res.json();
      if (data && data.exists && data.state && Array.isArray(data.state.parcels)) {
        const localState = App.Storage.getState();
        // If local disk has real data (not sample) or browser storage was cleared/sample, restore from disk!
        if (!data.state.isSampleData || localState.isSampleData || localState.parcels.length === 0) {
          const mergedParcels =
            localState.isSampleData && !data.state.isSampleData
              ? data.state.parcels
              : mergeParcelLists(localState.parcels, data.state.parcels, new Set(data.state.deletedIds || []));
          App.Storage.applySyncedState({
            parcels: mergedParcels,
            customCouriers: mergeCouriers(localState.customCouriers, data.state.customCouriers),
            deletedIds: Array.from(new Set([...(localState.deletedIds || []), ...(data.state.deletedIds || [])])).slice(-300),
            isSampleData: Boolean(data.state.isSampleData && localState.isSampleData)
          });
        }
        saveConfig({ lastDiskSaveAt: data.savedAt || new Date().toISOString() });
        return { ok: true, dbPath: data.dbPath || '' };
      } else {
        // First run: persist current state to disk immediately
        await saveToLocalDisk();
        return { ok: true, initialized: true };
      }
    } catch (_) {
      return { ok: false };
    }
  }

  async function saveToLocalDisk() {
    if (!hasLocalDiskBackend()) return { ok: false };
    try {
      const payload = {
        app: 'MM-VIRSA-Ops',
        savedAt: new Date().toISOString(),
        state: App.Storage.getState()
      };
      const res = await fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        saveConfig({ lastDiskSaveAt: payload.savedAt });
        return { ok: true };
      }
      return { ok: false };
    } catch (_) {
      return { ok: false };
    }
  }

  // -------------------------------------------------------------------------
  // Layer 2: Two-Way Cloud Sync (Google Sheets Web App / Firebase RTDB)
  // -------------------------------------------------------------------------
  async function cloudFetch(url, options) {
    const opts = options || {};
    const method = (opts.method || 'GET').toUpperCase();
    if (hasLocalDiskBackend()) {
      const proxyRes = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          method,
          headers: opts.headers || {},
          body: opts.body || null
        })
      });
      const text = await proxyRes.text();
      return { ok: proxyRes.ok, status: proxyRes.status, text };
    }
    const res = await fetch(url, {
      method,
      headers: opts.headers || {},
      body: method === 'GET' ? undefined : opts.body
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }

  function buildFirebaseUrl(baseUrl, secretToken) {
    let url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!url.endsWith('.json')) {
      url += '/virsa_ops_ledger.json';
    }
    if (secretToken) {
      url += (url.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(secretToken);
    }
    return url;
  }

  function buildGoogleSheetsUrl(baseUrl, secretToken, action) {
    const url = String(baseUrl || '').trim();
    const sep = url.includes('?') ? '&' : '?';
    let full = `${url}${sep}action=${encodeURIComponent(action || 'pull')}`;
    const cleanTok = String(secretToken || '').trim();
    if (cleanTok) {
      full += `&token=${encodeURIComponent(cleanTok)}`;
    }
    return full;
  }

  async function syncWithCloud(reason) {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.endpointUrl) {
      return { ok: false, skipped: true, error: 'Cloud Sync is not enabled yet.' };
    }
    if (isSyncingNow) {
      if (reason === 'auto_push' || reason === 'manual') hasPendingLocalChanges = true;
      return { ok: false, skipped: true };
    }
    isSyncingNow = true;
    const pushedOnEntry = hasPendingLocalChanges;
    hasPendingLocalChanges = false;
    if (onStatusChange) onStatusChange(false);

    try {
      const localState = App.Storage.getState();
      const localFpBefore = computeFingerprint(localState.parcels, localState.deletedIds, localState.customCouriers);
      let remoteState = null;

      // 1. PULL remote cloud state first
      if (cfg.provider === 'firebase') {
        const url = buildFirebaseUrl(cfg.endpointUrl, cfg.secretToken);
        const pullRes = await cloudFetch(url, { method: 'GET' });
        if (!pullRes.ok) throw new Error(`Firebase Pull HTTP ${pullRes.status}`);
        const parsed = pullRes.text && pullRes.text !== 'null' ? App.Security.safeJSONParse(pullRes.text) : null;
        if (parsed && Array.isArray(parsed.parcels)) remoteState = parsed;
      } else {
        // Google Sheets Apps Script Web App
        const pullUrl = buildGoogleSheetsUrl(cfg.endpointUrl, cfg.secretToken, 'pull');
        const pullRes = await cloudFetch(pullUrl, { method: 'GET' });
        if (!pullRes.ok) throw new Error(`Google Sheets Pull HTTP ${pullRes.status}`);
        const parsed = App.Security.safeJSONParse(pullRes.text);
        if (parsed && parsed.error) throw new Error(parsed.error);
        if (parsed && Array.isArray(parsed.parcels)) remoteState = parsed;
      }

      const remoteFp = remoteState
        ? computeFingerprint(remoteState.parcels, remoteState.deletedIds, remoteState.customCouriers)
        : '';

      // 2. MERGE local + remote safely using updatedAt & deletedIds
      const mergedDeleted = Array.from(
        new Set([...(localState.deletedIds || []), ...((remoteState && remoteState.deletedIds) || [])])
      ).slice(-400);
      const delSet = new Set(mergedDeleted);

      let mergedParcels;
      if (remoteState && remoteState.parcels.length > 0 && localState.isSampleData && !remoteState.isSampleData) {
        mergedParcels = remoteState.parcels.filter((p) => !delSet.has(p.id));
      } else {
        mergedParcels = mergeParcelLists(localState.parcels, remoteState ? remoteState.parcels : [], delSet);
      }

      const mergedCouriers = mergeCouriers(localState.customCouriers, remoteState ? remoteState.customCouriers : []);
      const isStillSample = Boolean(localState.isSampleData && (!remoteState || remoteState.isSampleData));
      const mergedFp = computeFingerprint(mergedParcels, mergedDeleted, mergedCouriers);
      const localChanged = mergedFp !== localFpBefore;

      if (localChanged) {
        App.Storage.applySyncedState({
          parcels: mergedParcels,
          customCouriers: mergedCouriers,
          deletedIds: mergedDeleted,
          isSampleData: isStillSample
        });
      }

      // 3. SMART PUSH: Only write to Google Sheet / Firebase when remote differs or manual push requested
      const needsRemotePush =
        !remoteState ||
        mergedFp !== remoteFp ||
        pushedOnEntry ||
        reason === 'manual' ||
        reason === 'auto_push';

      const syncedNowISO = new Date().toISOString();

      if (needsRemotePush) {
        const pushPayload = {
          app: 'MM-VIRSA-Ops',
          token: String(cfg.secretToken || '').trim(),
          syncedAt: syncedNowISO,
          isSampleData: isStillSample,
          customCouriers: mergedCouriers,
          deletedIds: mergedDeleted,
          parcels: mergedParcels
        };

        if (cfg.provider === 'firebase') {
          const url = buildFirebaseUrl(cfg.endpointUrl, cfg.secretToken);
          const pushRes = await cloudFetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pushPayload)
          });
          if (!pushRes.ok) throw new Error(`Firebase Push HTTP ${pushRes.status}`);
        } else {
          const pushUrl = buildGoogleSheetsUrl(cfg.endpointUrl, cfg.secretToken, 'push');
          const pushRes = await cloudFetch(pushUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(pushPayload)
          });
          if (!pushRes.ok) throw new Error(`Google Sheets Push HTTP ${pushRes.status}`);
          const parsed = App.Security.safeJSONParse(pushRes.text);
          if (parsed && parsed.error) throw new Error(parsed.error);
        }
      }

      if (localChanged || needsRemotePush) {
        await saveToLocalDisk();
      }
      saveConfig({ lastCloudSyncAt: syncedNowISO, lastError: '' });
      if (App.Security && reason === 'manual') {
        App.Security.logAudit('CLOUD_SYNC', `Two-way synced ${mergedParcels.length} parcels (${cfg.provider})`);
      }

      isSyncingNow = false;
      if (onStatusChange) onStatusChange(localChanged);

      // If another scan happened while this sync was running, push it immediately!
      if (hasPendingLocalChanges) {
        setTimeout(() => syncWithCloud('auto_push'), 250);
      }

      return { ok: true, count: mergedParcels.length, changed: localChanged };
    } catch (err) {
      let msg = (err && err.message) || 'Cloud sync failed.';
      if (/invalid sync secret token|unauthorized/i.test(msg)) {
        msg = 'Secret Token mismatch! Enter the exact same password you wrote in Google Apps Script (var SYNC_SECRET) inside Sync Secret Token above and click Save — OR set var SYNC_SECRET = "" in Apps Script and Deploy -> Manage deployments -> New version.';
      }
      if (pushedOnEntry) hasPendingLocalChanges = true;
      saveConfig({ lastError: msg });
      isSyncingNow = false;
      if (onStatusChange) onStatusChange(false);
      return { ok: false, error: msg };
    }
  }

  /**
   * Called automatically whenever App.Storage saves any change.
   * Immediately writes to Local Disk DB and pushes to Cloud within 600ms!
   */
  function notifyLocalMutation() {
    hasPendingLocalChanges = true;
    if (hasLocalDiskBackend()) {
      saveToLocalDisk();
    }
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.autoSync || !cfg.endpointUrl) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      syncWithCloud('auto_push');
    }, 600);
  }

  function startAutoSyncLoop(statusHandler) {
    onStatusChange = statusHandler;
    if (pullInterval) clearInterval(pullInterval);

    // Continuous lightweight sync every 8 seconds while app is open & visible
    pullInterval = setInterval(() => {
      const cfg = loadConfig();
      if (cfg.enabled && cfg.autoSync && cfg.endpointUrl && !document.hidden) {
        syncWithCloud('auto_poll');
      }
    }, 8000);

    // Instant sync when returning to tab, focusing app window, or coming back online
    if (!lifecycleBound) {
      lifecycleBound = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          const cfg = loadConfig();
          if (cfg.enabled && cfg.autoSync && cfg.endpointUrl) syncWithCloud('visibility');
        }
      });
      global.addEventListener('focus', () => {
        const cfg = loadConfig();
        if (cfg.enabled && cfg.autoSync && cfg.endpointUrl) syncWithCloud('focus');
      });
      global.addEventListener('online', () => {
        const cfg = loadConfig();
        if (cfg.enabled && cfg.autoSync && cfg.endpointUrl) syncWithCloud('online');
      });
    }
  }

  App.CloudSync = {
    loadConfig,
    saveConfig,
    hasLocalDiskBackend,
    loadFromLocalDisk,
    saveToLocalDisk,
    syncWithCloud,
    notifyLocalMutation,
    startAutoSyncLoop,
    isSyncing: () => isSyncingNow
  };
})(window);
