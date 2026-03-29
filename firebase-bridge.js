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
    clientId: "",
    cache: {},
    docCache: {},
    syncTimer: null,
    syncPromise: null,
    listeners: [],
    remoteListeners: [],
    unsubscribeCollection: null,
    lastMetaToken: ""
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

  function notifyRemote(payload) {
    state.remoteListeners.forEach(function (listener) {
      try {
        listener(payload);
      } catch (error) {
        console.error("Falha ao notificar atualizacao remota:", error);
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

  function getClientId() {
    if (state.clientId) return state.clientId;
    try {
      var existing = globalScope.sessionStorage.getItem("cti_cloud_client_id");
      if (existing) {
        state.clientId = existing;
        return existing;
      }
      var generated = "client_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
      globalScope.sessionStorage.setItem("cti_cloud_client_id", generated);
      state.clientId = generated;
      return generated;
    } catch (error) {
      state.clientId = "client_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
      return state.clientId;
    }
  }

  function getMetaToken(meta) {
    if (!meta || typeof meta !== "object") return "";
    var updatedAt = "";
    if (meta.updatedAt && typeof meta.updatedAt.toMillis === "function") {
      updatedAt = String(meta.updatedAt.toMillis());
    } else if (meta.updatedAt && typeof meta.updatedAt === "string") {
      updatedAt = meta.updatedAt;
    }
    return [
      updatedAt,
      meta.updatedByClientId || "",
      meta.updatedBy || ""
    ].join("|");
  }

  function syncMetaState(meta) {
    state.meta = meta && typeof meta === "object" ? meta : { keys: {} };
    state.lastMetaToken = getMetaToken(meta);
    state.lastSyncedAt = meta && meta.updatedAt && meta.updatedAt.toDate
      ? meta.updatedAt.toDate().toISOString()
      : "";
  }

  function applyDocsToLocalStorage(docs, meta) {
    var sourceDocs = docs && typeof docs === "object" ? docs : {};
    var sourceMeta = meta && typeof meta === "object" ? meta : sourceDocs[getMetaDocId()];
    if (!sourceMeta || !sourceMeta.keys) {
      state.meta = { keys: {} };
      state.cache = {};
      state.lastSyncedAt = "";
      notify();
      return { ok: true, empty: true, mode: state.mode };
    }

    syncMetaState(sourceMeta);
    state.cache = {};
    Object.keys(sourceMeta.keys).forEach(function (key) {
      var info = sourceMeta.keys[key] || {};
      var total = Number(info.chunks) || 0;
      var raw = "";
      for (var index = 0; index < total; index += 1) {
        var chunk = sourceDocs[getChunkDocId(key, index)];
        if (chunk && typeof chunk.data === "string") raw += chunk.data;
      }
      if (typeof raw === "string") {
        localStorage.setItem(key, raw);
        state.cache[key] = raw;
      }
    });

    notify();
    return { ok: true, empty: false, mode: state.mode };
  }

  function startCollectionListener() {
    if (!state.collection || state.unsubscribeCollection) return;

    state.unsubscribeCollection = state.collection.onSnapshot(function (snapshot) {
      snapshot.docChanges().forEach(function (change) {
        if (change.type === "removed") {
          delete state.docCache[change.doc.id];
          return;
        }
        state.docCache[change.doc.id] = change.doc.data();
      });

      var meta = state.docCache[getMetaDocId()];
      if (!meta || !meta.keys) return;

      var token = getMetaToken(meta);
      if (token && token === state.lastMetaToken) return;

      syncMetaState(meta);
      notify();

      if (meta.updatedByClientId && meta.updatedByClientId === getClientId()) return;

      try {
        var result = applyDocsToLocalStorage(state.docCache, meta);
        if (result && (result.ok || result.empty)) {
          notifyRemote({
            meta: meta,
            result: result
          });
        }
      } catch (error) {
        console.error("Falha ao aplicar atualizacao remota do Firebase:", error);
      }
    }, function (error) {
      console.error("Falha no listener em tempo real do Firebase:", error);
    });
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
        getClientId();
        startCollectionListener();
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
      state.docCache = docs;
      return applyDocsToLocalStorage(docs);
    } catch (error) {
      console.error("Falha ao baixar estado da nuvem:", error);
      setMode("web-local-fallback", "Falha ao carregar dados do Firebase. Seguindo com o cache local.");
      return { ok: false, mode: state.mode, error: error };
    }
  }

  async function uploadState(rawState, reason, options) {
    var ready = await init();
    if (!ready || !state.collection) return { ok: false, mode: state.mode };

    var uploadOptions = options && typeof options === "object" ? options : {};
    var incomingPayload = rawState && typeof rawState === "object" ? rawState : {};
    var payload = uploadOptions.partial
      ? Object.assign({}, state.cache || {}, incomingPayload)
      : incomingPayload;
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
        updatedByClientId: getClientId(),
        keys: nextMeta
      }, { merge: true });

      await batch.commit();
      state.meta = {
        keys: nextMeta,
        updatedBy: reason || "app",
        updatedByClientId: getClientId()
      };
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

  function queueUpload(getter, reason, options) {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
      state.syncTimer = null;
    }

    var configOptions = globalScope.CTI_FIREBASE_OPTIONS || {};
    var wait = Number(configOptions.syncDebounceMs) || 1200;
    state.syncPromise = new Promise(function (resolve) {
      state.syncTimer = setTimeout(async function () {
        state.syncTimer = null;
        var payload = typeof getter === "function" ? getter() : getter;
        resolve(await uploadState(payload, reason || "auto", options));
      }, wait);
    });

    return state.syncPromise;
  }

  async function flushUpload(getter, reason, options) {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
      state.syncTimer = null;
    }
    var payload = typeof getter === "function" ? getter() : getter;
    state.syncPromise = uploadState(payload, reason || "manual", options);
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

  function onRemoteChange(listener) {
    if (typeof listener !== "function") return function () {};
    state.remoteListeners.push(listener);
    return function () {
      state.remoteListeners = state.remoteListeners.filter(function (item) { return item !== listener; });
    };
  }

  globalScope.CTICloudSync = {
    init: init,
    hydrateLocalStorage: hydrateLocalStorage,
    queueUpload: queueUpload,
    flushUpload: flushUpload,
    getStatus: cloneStatus,
    onStatusChange: onStatusChange,
    onRemoteChange: onRemoteChange
  };
})();
