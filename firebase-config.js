(function (globalScope, factory) {
  var payload = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = payload;
  }
  if (globalScope) {
    globalScope.CTI_FIREBASE_CONFIG = payload.config;
    globalScope.CTI_FIREBASE_OPTIONS = payload.options;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  return {
    config: {
      apiKey: "AIzaSyAagPnVmhn2asJIC7B9BoM854BC3iWyi-k",
      authDomain: "cti-2026.firebaseapp.com",
      projectId: "cti-2026",
      storageBucket: "cti-2026.firebasestorage.app",
      messagingSenderId: "696291792626",
      appId: "1:696291792626:web:895d645676dab95326226b",
      measurementId: "G-16ZZNBNYRY"
    },
    options: {
      enabled: true,
      analyticsEnabled: true,
      anonymousAuth: false,
      webOnly: true,
      collection: "cti_app_state",
      mm60DocId: "asset__mm60_prices_v1",
      maxChunkSize: 300000,
      syncDebounceMs: 80
    }
  };
});
