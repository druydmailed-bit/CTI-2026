(function () {
  var globalScope = window;
  var state = {
    initialized: false,
    initializing: null,
    enabled: false,
    mode: "local-only",
    reason: "Firebase nao configurado.",
    app: null,
    db: null,
    collection: null,
    meta: null,
    lastSyncedAt: "",
    cache: {},
    syncTimer: null,
    syncPromise: null,
    listeners: []
  };

  function cloneStatus() {
    return {
      initialized: state.initialized,
      enabled: state.enabled,
      mode: state.mode,
      reason: state.reason,
      lastSyncedAt: state.lastSyncedAt,
      projectId: state.app && state.app.options ? state.app.options.projectId || "" : "",
      collection: state.collection ? state.collection.id : ""
    };
  }

  function notify() {
    var snapshot = cloneStatus();
    state.listeners.forEach(function (listener) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("Falha ao notificar status da nuvem:", error);
      }
    });
  }

  function setMode(mode, reason) {
    state.mode = mode;
    state.reason = reason;
    notify();
  }

  function canUseWebSync() {
    var options = globalScope.CTI_FIREBASE_OPTIONS || {};
    var isHttp = location.protocol === "http:" || location.protocol === "https:";
    if (options.enabled === false) return false;
    if (options.webOnly !== false && !isHttp) return false;
    return !!globalScope.CTI_FIREBASE_CONFIG;
  }

  function getChunkDocId(key, index) {
    return "state__" + key.replace(/[^a-zA-Z0-9_-]/g, "_") + "__" + index;
  }

  function getMetaDocId() {
    return "state_meta";
  }

  function chunkString(value, maxChunkSize) {
    var safeValue = typeof value === "string" ? value : "";
    var size = Number(maxChunkSize) || 300000;
    if (!safeValue) return [""];
    var chunks = [];
    for (var i = 0; i < safeValue.length; i += size) {
      chunks.push(safeValue.slice(i, i + size));
    }
    return chunks;
  }

  function getServerTimestamp() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  async function init() {
    if (state.initialized) return state.enabled;
    if (state.initializing) return state.initializing;

    state.initializing = (async function () {
      if (!canUseWebSync()) {
        state.initialized = true;
        setMode("local-only", location.protocol === "file:"
          ? "Modo desktop/local ativo. A nuvem so eh usada via http(s)."
          : "Firebase desativado ou sem configuracao.");
        return false;
      }

      if (!globalScope.firebase || !firebase.initializeApp || !firebase.firestore) {
        state.initialized = true;
        setMode("web-local-fallback", "SDK do Firebase nao carregado.");
        return false;
      }

      try {
        var config = globalScope.CTI_FIREBASE_CONFIG;
        var options = globalScope.CTI_FIREBASE_OPTIONS || {};
        state.app = firebase.apps && firebase.apps.length
          ? firebase.app()
          : firebase.initializeApp(config);
        if (options.analyticsEnabled !== false && config.measurementId && firebase.analytics) {
          try {
            firebase.analytics();
          } catch (analyticsError) {
            console.warn("Analytics indisponivel:", analyticsError);
          }
        }
        if (options.anonymousAuth !== false && firebase.auth) {
          try {
            await firebase.auth().signInAnonymously();
          } catch (authError) {
            console.warn("Falha ao autenticar anonimamente no Firebase:", authError);
          }
        }
        state.db = firebase.firestore();
        state.collection = state.db.collection(options.collection || "cti_app_state");
        state.enabled = true;
        state.initialized = true;
        setMode("web-cloud", "Sincronizacao Firebase ativa.");
        return true;
      } catch (error) {
        console.error("Falha ao inicializar Firebase:", error);
        state.initialized = true;
        state.enabled = false;
        setMode("web-local-fallback", "Nao foi possivel conectar ao Firebase.");
        return false;
      }
    })();

    return state.initializing.finally(function () {
      state.initializing = null;
    });
  }

  async function hydrateLocalStorage() {
    var ready = await init();
    if (!ready || !state.collection) return { ok: false, mode: state.mode };

    try {
      var snapshot = await state.collection.get();
      var docs = {};
      snapshot.forEach(function (doc) {
        docs[doc.id] = doc.data();
      });

      var meta = docs[getMetaDocId()];
      if (!meta || !meta.keys) {
        state.meta = { keys: {} };
        state.lastSyncedAt = "";
        notify();
        return { ok: true, empty: true, mode: state.mode };
      }

      state.meta = meta;
      state.cache = {};
      Object.keys(meta.keys).forEach(function (key) {
        var info = meta.keys[key] || {};
        var total = Number(info.chunks) || 0;
        var raw = "";
        for (var index = 0; index < total; index += 1) {
          var chunk = docs[getChunkDocId(key, index)];
          if (chunk && typeof chunk.data === "string") raw += chunk.data;
        }
        if (typeof raw === "string") {
          localStorage.setItem(key, raw);
          state.cache[key] = raw;
        }
      });

      state.lastSyncedAt = meta.updatedAt && meta.updatedAt.toDate
        ? meta.updatedAt.toDate().toISOString()
        : "";
      notify();
      return { ok: true, empty: false, mode: state.mode };
    } catch (error) {
      console.error("Falha ao baixar estado da nuvem:", error);
      setMode("web-local-fallback", "Falha ao carregar dados do Firebase. Seguindo com o cache local.");
      return { ok: false, mode: state.mode, error: error };
    }
  }

  async function uploadState(rawState, reason) {
    var ready = await init();
    if (!ready || !state.collection) return { ok: false, mode: state.mode };

    var payload = rawState && typeof rawState === "object" ? rawState : {};
    var options = globalScope.CTI_FIREBASE_OPTIONS || {};
    var previousMeta = state.meta && state.meta.keys ? state.meta.keys : {};
    var nextMeta = {};

    try {
      var batch = state.db.batch();
      Object.keys(payload).forEach(function (key) {
        var raw = typeof payload[key] === "string" ? payload[key] : "";
        var chunks = chunkString(raw, options.maxChunkSize);
        nextMeta[key] = {
          chunks: chunks.length,
          size: raw.length
        };
        chunks.forEach(function (chunk, index) {
          batch.set(state.collection.doc(getChunkDocId(key, index)), {
            kind: "chunk",
            key: key,
            index: index,
            total: chunks.length,
            data: chunk,
            updatedAt: getServerTimestamp()
          });
        });

        var previousChunks = previousMeta[key] ? Number(previousMeta[key].chunks) || 0 : 0;
        for (var oldIndex = chunks.length; oldIndex < previousChunks; oldIndex += 1) {
          batch.delete(state.collection.doc(getChunkDocId(key, oldIndex)));
        }
      });

      Object.keys(previousMeta).forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) return;
        var previousChunks = Number(previousMeta[key].chunks) || 0;
        for (var index = 0; index < previousChunks; index += 1) {
          batch.delete(state.collection.doc(getChunkDocId(key, index)));
        }
      });

      batch.set(state.collection.doc(getMetaDocId()), {
        kind: "meta",
        schemaVersion: 1,
        updatedAt: getServerTimestamp(),
        updatedBy: reason || "app",
        keys: nextMeta
      }, { merge: true });

      await batch.commit();
      state.meta = { keys: nextMeta };
      state.cache = { ...payload };
      state.lastSyncedAt = new Date().toISOString();
      setMode("web-cloud", "Sincronizacao Firebase ativa.");
      return { ok: true, mode: state.mode };
    } catch (error) {
      console.error("Falha ao enviar estado para a nuvem:", error);
      setMode("web-local-fallback", "Falha ao sincronizar com o Firebase. Os dados continuam salvos localmente.");
      return { ok: false, mode: state.mode, error: error };
    }
  }

  function queueUpload(getter, reason) {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
      state.syncTimer = null;
    }

    var options = globalScope.CTI_FIREBASE_OPTIONS || {};
    var wait = Number(options.syncDebounceMs) || 1200;
    state.syncPromise = new Promise(function (resolve) {
      state.syncTimer = setTimeout(async function () {
        state.syncTimer = null;
        var payload = typeof getter === "function" ? getter() : getter;
        resolve(await uploadState(payload, reason || "auto"));
      }, wait);
    });

    return state.syncPromise;
  }

  async function flushUpload(getter, reason) {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
      state.syncTimer = null;
    }
    var payload = typeof getter === "function" ? getter() : getter;
    state.syncPromise = uploadState(payload, reason || "manual");
    return state.syncPromise;
  }

  function onStatusChange(listener) {
    if (typeof listener !== "function") return function () {};
    state.listeners.push(listener);
    listener(cloneStatus());
    return function () {
      state.listeners = state.listeners.filter(function (item) { return item !== listener; });
    };
  }

  globalScope.CTICloudSync = {
    init: init,
    hydrateLocalStorage: hydrateLocalStorage,
    queueUpload: queueUpload,
    flushUpload: flushUpload,
    getStatus: cloneStatus,
    onStatusChange: onStatusChange
  };
})();
