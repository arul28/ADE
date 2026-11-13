var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// wrangler-modules-watch:wrangler:modules-watch
var init_wrangler_modules_watch = __esm({
  "wrangler-modules-watch:wrangler:modules-watch"() {
    init_modules_watch_stub();
  }
});

// node_modules/wrangler/templates/modules-watch-stub.js
var init_modules_watch_stub = __esm({
  "node_modules/wrangler/templates/modules-watch-stub.js"() {
    init_wrangler_modules_watch();
  }
});

// node_modules/@opentelemetry/api/build/src/version.js
var require_version = __commonJS({
  "node_modules/@opentelemetry/api/build/src/version.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.VERSION = void 0;
    exports.VERSION = "1.9.1";
  }
});

// node_modules/@opentelemetry/api/build/src/internal/semver.js
var require_semver = __commonJS({
  "node_modules/@opentelemetry/api/build/src/internal/semver.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isCompatible = exports._makeCompatibilityCheck = void 0;
    var version_1 = require_version();
    var re2 = /^(\d+)\.(\d+)\.(\d+)(-(.+))?$/;
    function _makeCompatibilityCheck(ownVersion) {
      const acceptedVersions = /* @__PURE__ */ new Set([ownVersion]);
      const rejectedVersions = /* @__PURE__ */ new Set();
      const myVersionMatch = ownVersion.match(re2);
      if (!myVersionMatch) {
        return () => false;
      }
      const ownVersionParsed = {
        major: +myVersionMatch[1],
        minor: +myVersionMatch[2],
        patch: +myVersionMatch[3],
        prerelease: myVersionMatch[4]
      };
      if (ownVersionParsed.prerelease != null) {
        return /* @__PURE__ */ __name(function isExactmatch(globalVersion) {
          return globalVersion === ownVersion;
        }, "isExactmatch");
      }
      function _reject(v) {
        rejectedVersions.add(v);
        return false;
      }
      __name(_reject, "_reject");
      function _accept(v) {
        acceptedVersions.add(v);
        return true;
      }
      __name(_accept, "_accept");
      return /* @__PURE__ */ __name(function isCompatible(globalVersion) {
        if (acceptedVersions.has(globalVersion)) {
          return true;
        }
        if (rejectedVersions.has(globalVersion)) {
          return false;
        }
        const globalVersionMatch = globalVersion.match(re2);
        if (!globalVersionMatch) {
          return _reject(globalVersion);
        }
        const globalVersionParsed = {
          major: +globalVersionMatch[1],
          minor: +globalVersionMatch[2],
          patch: +globalVersionMatch[3],
          prerelease: globalVersionMatch[4]
        };
        if (globalVersionParsed.prerelease != null) {
          return _reject(globalVersion);
        }
        if (ownVersionParsed.major !== globalVersionParsed.major) {
          return _reject(globalVersion);
        }
        if (ownVersionParsed.major === 0) {
          if (ownVersionParsed.minor === globalVersionParsed.minor && ownVersionParsed.patch <= globalVersionParsed.patch) {
            return _accept(globalVersion);
          }
          return _reject(globalVersion);
        }
        if (ownVersionParsed.minor <= globalVersionParsed.minor) {
          return _accept(globalVersion);
        }
        return _reject(globalVersion);
      }, "isCompatible");
    }
    __name(_makeCompatibilityCheck, "_makeCompatibilityCheck");
    exports._makeCompatibilityCheck = _makeCompatibilityCheck;
    exports.isCompatible = _makeCompatibilityCheck(version_1.VERSION);
  }
});

// node_modules/@opentelemetry/api/build/src/internal/global-utils.js
var require_global_utils = __commonJS({
  "node_modules/@opentelemetry/api/build/src/internal/global-utils.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.unregisterGlobal = exports.getGlobal = exports.registerGlobal = void 0;
    var version_1 = require_version();
    var semver_1 = require_semver();
    var major = version_1.VERSION.split(".")[0];
    var GLOBAL_OPENTELEMETRY_API_KEY = /* @__PURE__ */ Symbol.for(`opentelemetry.js.api.${major}`);
    var _global = typeof globalThis === "object" ? globalThis : typeof self === "object" ? self : typeof window === "object" ? window : typeof global === "object" ? global : {};
    function registerGlobal(type, instance, diag, allowOverride = false) {
      var _a;
      const api = _global[GLOBAL_OPENTELEMETRY_API_KEY] = (_a = _global[GLOBAL_OPENTELEMETRY_API_KEY]) !== null && _a !== void 0 ? _a : {
        version: version_1.VERSION
      };
      if (!allowOverride && api[type]) {
        const err = new Error(`@opentelemetry/api: Attempted duplicate registration of API: ${type}`);
        diag.error(err.stack || err.message);
        return false;
      }
      if (api.version !== version_1.VERSION) {
        const err = new Error(`@opentelemetry/api: Registration of version v${api.version} for ${type} does not match previously registered API v${version_1.VERSION}`);
        diag.error(err.stack || err.message);
        return false;
      }
      api[type] = instance;
      diag.debug(`@opentelemetry/api: Registered a global for ${type} v${version_1.VERSION}.`);
      return true;
    }
    __name(registerGlobal, "registerGlobal");
    exports.registerGlobal = registerGlobal;
    function getGlobal(type) {
      var _a, _b;
      const globalVersion = (_a = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _a === void 0 ? void 0 : _a.version;
      if (!globalVersion || !(0, semver_1.isCompatible)(globalVersion)) {
        return;
      }
      return (_b = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _b === void 0 ? void 0 : _b[type];
    }
    __name(getGlobal, "getGlobal");
    exports.getGlobal = getGlobal;
    function unregisterGlobal(type, diag) {
      diag.debug(`@opentelemetry/api: Unregistering a global for ${type} v${version_1.VERSION}.`);
      const api = _global[GLOBAL_OPENTELEMETRY_API_KEY];
      if (api) {
        delete api[type];
      }
    }
    __name(unregisterGlobal, "unregisterGlobal");
    exports.unregisterGlobal = unregisterGlobal;
  }
});

// node_modules/@opentelemetry/api/build/src/diag/ComponentLogger.js
var require_ComponentLogger = __commonJS({
  "node_modules/@opentelemetry/api/build/src/diag/ComponentLogger.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DiagComponentLogger = void 0;
    var global_utils_1 = require_global_utils();
    var DiagComponentLogger = class {
      static {
        __name(this, "DiagComponentLogger");
      }
      constructor(props) {
        this._namespace = props.namespace || "DiagComponentLogger";
      }
      debug(...args) {
        return logProxy("debug", this._namespace, args);
      }
      error(...args) {
        return logProxy("error", this._namespace, args);
      }
      info(...args) {
        return logProxy("info", this._namespace, args);
      }
      warn(...args) {
        return logProxy("warn", this._namespace, args);
      }
      verbose(...args) {
        return logProxy("verbose", this._namespace, args);
      }
    };
    exports.DiagComponentLogger = DiagComponentLogger;
    function logProxy(funcName, namespace, args) {
      const logger = (0, global_utils_1.getGlobal)("diag");
      if (!logger) {
        return;
      }
      return logger[funcName](namespace, ...args);
    }
    __name(logProxy, "logProxy");
  }
});

// node_modules/@opentelemetry/api/build/src/diag/types.js
var require_types = __commonJS({
  "node_modules/@opentelemetry/api/build/src/diag/types.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DiagLogLevel = void 0;
    var DiagLogLevel;
    (function(DiagLogLevel2) {
      DiagLogLevel2[DiagLogLevel2["NONE"] = 0] = "NONE";
      DiagLogLevel2[DiagLogLevel2["ERROR"] = 30] = "ERROR";
      DiagLogLevel2[DiagLogLevel2["WARN"] = 50] = "WARN";
      DiagLogLevel2[DiagLogLevel2["INFO"] = 60] = "INFO";
      DiagLogLevel2[DiagLogLevel2["DEBUG"] = 70] = "DEBUG";
      DiagLogLevel2[DiagLogLevel2["VERBOSE"] = 80] = "VERBOSE";
      DiagLogLevel2[DiagLogLevel2["ALL"] = 9999] = "ALL";
    })(DiagLogLevel = exports.DiagLogLevel || (exports.DiagLogLevel = {}));
  }
});

// node_modules/@opentelemetry/api/build/src/diag/internal/logLevelLogger.js
var require_logLevelLogger = __commonJS({
  "node_modules/@opentelemetry/api/build/src/diag/internal/logLevelLogger.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createLogLevelDiagLogger = void 0;
    var types_1 = require_types();
    function createLogLevelDiagLogger(maxLevel, logger) {
      if (maxLevel < types_1.DiagLogLevel.NONE) {
        maxLevel = types_1.DiagLogLevel.NONE;
      } else if (maxLevel > types_1.DiagLogLevel.ALL) {
        maxLevel = types_1.DiagLogLevel.ALL;
      }
      logger = logger || {};
      function _filterFunc(funcName, theLevel) {
        const theFunc = logger[funcName];
        if (typeof theFunc === "function" && maxLevel >= theLevel) {
          return theFunc.bind(logger);
        }
        return function() {
        };
      }
      __name(_filterFunc, "_filterFunc");
      return {
        error: _filterFunc("error", types_1.DiagLogLevel.ERROR),
        warn: _filterFunc("warn", types_1.DiagLogLevel.WARN),
        info: _filterFunc("info", types_1.DiagLogLevel.INFO),
        debug: _filterFunc("debug", types_1.DiagLogLevel.DEBUG),
        verbose: _filterFunc("verbose", types_1.DiagLogLevel.VERBOSE)
      };
    }
    __name(createLogLevelDiagLogger, "createLogLevelDiagLogger");
    exports.createLogLevelDiagLogger = createLogLevelDiagLogger;
  }
});

// node_modules/@opentelemetry/api/build/src/api/diag.js
var require_diag = __commonJS({
  "node_modules/@opentelemetry/api/build/src/api/diag.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DiagAPI = void 0;
    var ComponentLogger_1 = require_ComponentLogger();
    var logLevelLogger_1 = require_logLevelLogger();
    var types_1 = require_types();
    var global_utils_1 = require_global_utils();
    var API_NAME = "diag";
    var DiagAPI = class _DiagAPI {
      static {
        __name(this, "DiagAPI");
      }
      /** Get the singleton instance of the DiagAPI API */
      static instance() {
        if (!this._instance) {
          this._instance = new _DiagAPI();
        }
        return this._instance;
      }
      /**
       * Private internal constructor
       * @private
       */
      constructor() {
        function _logProxy(funcName) {
          return function(...args) {
            const logger = (0, global_utils_1.getGlobal)("diag");
            if (!logger)
              return;
            return logger[funcName](...args);
          };
        }
        __name(_logProxy, "_logProxy");
        const self2 = this;
        const setLogger = /* @__PURE__ */ __name((logger, optionsOrLogLevel = { logLevel: types_1.DiagLogLevel.INFO }) => {
          var _a, _b, _c;
          if (logger === self2) {
            const err = new Error("Cannot use diag as the logger for itself. Please use a DiagLogger implementation like ConsoleDiagLogger or a custom implementation");
            self2.error((_a = err.stack) !== null && _a !== void 0 ? _a : err.message);
            return false;
          }
          if (typeof optionsOrLogLevel === "number") {
            optionsOrLogLevel = {
              logLevel: optionsOrLogLevel
            };
          }
          const oldLogger = (0, global_utils_1.getGlobal)("diag");
          const newLogger = (0, logLevelLogger_1.createLogLevelDiagLogger)((_b = optionsOrLogLevel.logLevel) !== null && _b !== void 0 ? _b : types_1.DiagLogLevel.INFO, logger);
          if (oldLogger && !optionsOrLogLevel.suppressOverrideMessage) {
            const stack = (_c = new Error().stack) !== null && _c !== void 0 ? _c : "<failed to generate stacktrace>";
            oldLogger.warn(`Current logger will be overwritten from ${stack}`);
            newLogger.warn(`Current logger will overwrite one already registered from ${stack}`);
          }
          return (0, global_utils_1.registerGlobal)("diag", newLogger, self2, true);
        }, "setLogger");
        self2.setLogger = setLogger;
        self2.disable = () => {
          (0, global_utils_1.unregisterGlobal)(API_NAME, self2);
        };
        self2.createComponentLogger = (options) => {
          return new ComponentLogger_1.DiagComponentLogger(options);
        };
        self2.verbose = _logProxy("verbose");
        self2.debug = _logProxy("debug");
        self2.info = _logProxy("info");
        self2.warn = _logProxy("warn");
        self2.error = _logProxy("error");
      }
    };
    exports.DiagAPI = DiagAPI;
  }
});

// node_modules/@opentelemetry/api/build/src/baggage/internal/baggage-impl.js
var require_baggage_impl = __commonJS({
  "node_modules/@opentelemetry/api/build/src/baggage/internal/baggage-impl.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BaggageImpl = void 0;
    var BaggageImpl = class _BaggageImpl {
      static {
        __name(this, "BaggageImpl");
      }
      constructor(entries) {
        this._entries = entries ? new Map(entries) : /* @__PURE__ */ new Map();
      }
      getEntry(key) {
        const entry = this._entries.get(key);
        if (!entry) {
          return void 0;
        }
        return Object.assign({}, entry);
      }
      getAllEntries() {
        return Array.from(this._entries.entries());
      }
      setEntry(key, entry) {
        const newBaggage = new _BaggageImpl(this._entries);
        newBaggage._entries.set(key, entry);
        return newBaggage;
      }
      removeEntry(key) {
        const newBaggage = new _BaggageImpl(this._entries);
        newBaggage._entries.delete(key);
        return newBaggage;
      }
      removeEntries(...keys) {
        const newBaggage = new _BaggageImpl(this._entries);
        for (const key of keys) {
          newBaggage._entries.delete(key);
        }
        return newBaggage;
      }
      clear() {
        return new _BaggageImpl();
      }
    };
    exports.BaggageImpl = BaggageImpl;
  }
});

// node_modules/@opentelemetry/api/build/src/baggage/internal/symbol.js
var require_symbol = __commonJS({
  "node_modules/@opentelemetry/api/build/src/baggage/internal/symbol.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.baggageEntryMetadataSymbol = void 0;
    exports.baggageEntryMetadataSymbol = /* @__PURE__ */ Symbol("BaggageEntryMetadata");
  }
});

// node_modules/@opentelemetry/api/build/src/baggage/utils.js
var require_utils = __commonJS({
  "node_modules/@opentelemetry/api/build/src/baggage/utils.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.baggageEntryMetadataFromString = exports.createBaggage = void 0;
    var diag_1 = require_diag();
    var baggage_impl_1 = require_baggage_impl();
    var symbol_1 = require_symbol();
    var diag = diag_1.DiagAPI.instance();
    function createBaggage(entries = {}) {
      return new baggage_impl_1.BaggageImpl(new Map(Object.entries(entries)));
    }
    __name(createBaggage, "createBaggage");
    exports.createBaggage = createBaggage;
    function baggageEntryMetadataFromString(str) {
      if (typeof str !== "string") {
        diag.error(`Cannot create baggage metadata from unknown type: ${typeof str}`);
        str = "";
      }
      return {
        __TYPE__: symbol_1.baggageEntryMetadataSymbol,
        toString() {
          return str;
        }
      };
    }
    __name(baggageEntryMetadataFromString, "baggageEntryMetadataFromString");
    exports.baggageEntryMetadataFromString = baggageEntryMetadataFromString;
  }
});

// node_modules/@opentelemetry/api/build/src/context/context.js
var require_context = __commonJS({
  "node_modules/@opentelemetry/api/build/src/context/context.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ROOT_CONTEXT = exports.createContextKey = void 0;
    function createContextKey2(description) {
      return Symbol.for(description);
    }
    __name(createContextKey2, "createContextKey");
    exports.createContextKey = createContextKey2;
    var BaseContext = class _BaseContext {
      static {
        __name(this, "BaseContext");
      }
      /**
       * Construct a new context which inherits values from an optional parent context.
       *
       * @param parentContext a context from which to inherit values
       */
      constructor(parentContext) {
        const self2 = this;
        self2._currentContext = parentContext ? new Map(parentContext) : /* @__PURE__ */ new Map();
        self2.getValue = (key) => self2._currentContext.get(key);
        self2.setValue = (key, value) => {
          const context2 = new _BaseContext(self2._currentContext);
          context2._currentContext.set(key, value);
          return context2;
        };
        self2.deleteValue = (key) => {
          const context2 = new _BaseContext(self2._currentContext);
          context2._currentContext.delete(key);
          return context2;
        };
      }
    };
    exports.ROOT_CONTEXT = new BaseContext();
  }
});

// node_modules/@opentelemetry/api/build/src/diag/consoleLogger.js
var require_consoleLogger = __commonJS({
  "node_modules/@opentelemetry/api/build/src/diag/consoleLogger.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DiagConsoleLogger = exports._originalConsoleMethods = void 0;
    var consoleMap = [
      { n: "error", c: "error" },
      { n: "warn", c: "warn" },
      { n: "info", c: "info" },
      { n: "debug", c: "debug" },
      { n: "verbose", c: "trace" }
    ];
    exports._originalConsoleMethods = {};
    if (typeof console !== "undefined") {
      const keys = [
        "error",
        "warn",
        "info",
        "debug",
        "trace",
        "log"
      ];
      for (const key of keys) {
        if (typeof console[key] === "function") {
          exports._originalConsoleMethods[key] = console[key];
        }
      }
    }
    var DiagConsoleLogger = class {
      static {
        __name(this, "DiagConsoleLogger");
      }
      constructor() {
        function _consoleFunc(funcName) {
          return function(...args) {
            let theFunc = exports._originalConsoleMethods[funcName];
            if (typeof theFunc !== "function") {
              theFunc = exports._originalConsoleMethods["log"];
            }
            if (typeof theFunc !== "function" && console) {
              theFunc = console[funcName];
              if (typeof theFunc !== "function") {
                theFunc = console.log;
              }
            }
            if (typeof theFunc === "function") {
              return theFunc.apply(console, args);
            }
          };
        }
        __name(_consoleFunc, "_consoleFunc");
        for (let i = 0; i < consoleMap.length; i++) {
          this[consoleMap[i].n] = _consoleFunc(consoleMap[i].c);
        }
      }
    };
    exports.DiagConsoleLogger = DiagConsoleLogger;
  }
});

// node_modules/@opentelemetry/api/build/src/metrics/NoopMeter.js
var require_NoopMeter = __commonJS({
  "node_modules/@opentelemetry/api/build/src/metrics/NoopMeter.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createNoopMeter = exports.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = exports.NOOP_OBSERVABLE_GAUGE_METRIC = exports.NOOP_OBSERVABLE_COUNTER_METRIC = exports.NOOP_UP_DOWN_COUNTER_METRIC = exports.NOOP_HISTOGRAM_METRIC = exports.NOOP_GAUGE_METRIC = exports.NOOP_COUNTER_METRIC = exports.NOOP_METER = exports.NoopObservableUpDownCounterMetric = exports.NoopObservableGaugeMetric = exports.NoopObservableCounterMetric = exports.NoopObservableMetric = exports.NoopHistogramMetric = exports.NoopGaugeMetric = exports.NoopUpDownCounterMetric = exports.NoopCounterMetric = exports.NoopMetric = exports.NoopMeter = void 0;
    var NoopMeter = class {
      static {
        __name(this, "NoopMeter");
      }
      constructor() {
      }
      /**
       * @see {@link Meter.createGauge}
       */
      createGauge(_name, _options) {
        return exports.NOOP_GAUGE_METRIC;
      }
      /**
       * @see {@link Meter.createHistogram}
       */
      createHistogram(_name, _options) {
        return exports.NOOP_HISTOGRAM_METRIC;
      }
      /**
       * @see {@link Meter.createCounter}
       */
      createCounter(_name, _options) {
        return exports.NOOP_COUNTER_METRIC;
      }
      /**
       * @see {@link Meter.createUpDownCounter}
       */
      createUpDownCounter(_name, _options) {
        return exports.NOOP_UP_DOWN_COUNTER_METRIC;
      }
      /**
       * @see {@link Meter.createObservableGauge}
       */
      createObservableGauge(_name, _options) {
        return exports.NOOP_OBSERVABLE_GAUGE_METRIC;
      }
      /**
       * @see {@link Meter.createObservableCounter}
       */
      createObservableCounter(_name, _options) {
        return exports.NOOP_OBSERVABLE_COUNTER_METRIC;
      }
      /**
       * @see {@link Meter.createObservableUpDownCounter}
       */
      createObservableUpDownCounter(_name, _options) {
        return exports.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC;
      }
      /**
       * @see {@link Meter.addBatchObservableCallback}
       */
      addBatchObservableCallback(_callback, _observables) {
      }
      /**
       * @see {@link Meter.removeBatchObservableCallback}
       */
      removeBatchObservableCallback(_callback) {
      }
    };
    exports.NoopMeter = NoopMeter;
    var NoopMetric = class {
      static {
        __name(this, "NoopMetric");
      }
    };
    exports.NoopMetric = NoopMetric;
    var NoopCounterMetric = class extends NoopMetric {
      static {
        __name(this, "NoopCounterMetric");
      }
      add(_value, _attributes) {
      }
    };
    exports.NoopCounterMetric = NoopCounterMetric;
    var NoopUpDownCounterMetric = class extends NoopMetric {
      static {
        __name(this, "NoopUpDownCounterMetric");
      }
      add(_value, _attributes) {
      }
    };
    exports.NoopUpDownCounterMetric = NoopUpDownCounterMetric;
    var NoopGaugeMetric = class extends NoopMetric {
      static {
        __name(this, "NoopGaugeMetric");
      }
      record(_value, _attributes) {
      }
    };
    exports.NoopGaugeMetric = NoopGaugeMetric;
    var NoopHistogramMetric = class extends NoopMetric {
      static {
        __name(this, "NoopHistogramMetric");
      }
      record(_value, _attributes) {
      }
    };
    exports.NoopHistogramMetric = NoopHistogramMetric;
    var NoopObservableMetric = class {
      static {
        __name(this, "NoopObservableMetric");
      }
      addCallback(_callback) {
      }
      removeCallback(_callback) {
      }
    };
    exports.NoopObservableMetric = NoopObservableMetric;
    var NoopObservableCounterMetric = class extends NoopObservableMetric {
      static {
        __name(this, "NoopObservableCounterMetric");
      }
    };
    exports.NoopObservableCounterMetric = NoopObservableCounterMetric;
    var NoopObservableGaugeMetric = class extends NoopObservableMetric {
      static {
        __name(this, "NoopObservableGaugeMetric");
      }
    };
    exports.NoopObservableGaugeMetric = NoopObservableGaugeMetric;
    var NoopObservableUpDownCounterMetric = class extends NoopObservableMetric {
      static {
        __name(this, "NoopObservableUpDownCounterMetric");
      }
    };
    exports.NoopObservableUpDownCounterMetric = NoopObservableUpDownCounterMetric;
    exports.NOOP_METER = new NoopMeter();
    exports.NOOP_COUNTER_METRIC = new NoopCounterMetric();
    exports.NOOP_GAUGE_METRIC = new NoopGaugeMetric();
    exports.NOOP_HISTOGRAM_METRIC = new NoopHistogramMetric();
    exports.NOOP_UP_DOWN_COUNTER_METRIC = new NoopUpDownCounterMetric();
    exports.NOOP_OBSERVABLE_COUNTER_METRIC = new NoopObservableCounterMetric();
    exports.NOOP_OBSERVABLE_GAUGE_METRIC = new NoopObservableGaugeMetric();
    exports.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = new NoopObservableUpDownCounterMetric();
    function createNoopMeter() {
      return exports.NOOP_METER;
    }
    __name(createNoopMeter, "createNoopMeter");
    exports.createNoopMeter = createNoopMeter;
  }
});

// node_modules/@opentelemetry/api/build/src/metrics/Metric.js
var require_Metric = __commonJS({
  "node_modules/@opentelemetry/api/build/src/metrics/Metric.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ValueType = void 0;
    var ValueType;
    (function(ValueType2) {
      ValueType2[ValueType2["INT"] = 0] = "INT";
      ValueType2[ValueType2["DOUBLE"] = 1] = "DOUBLE";
    })(ValueType = exports.ValueType || (exports.ValueType = {}));
  }
});

// node_modules/@opentelemetry/api/build/src/propagation/TextMapPropagator.js
var require_TextMapPropagator = __commonJS({
  "node_modules/@opentelemetry/api/build/src/propagation/TextMapPropagator.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.defaultTextMapSetter = exports.defaultTextMapGetter = void 0;
    exports.defaultTextMapGetter = {
      get(carrier, key) {
        if (carrier == null) {
          return void 0;
        }
        return carrier[key];
      },
      keys(carrier) {
        if (carrier == null) {
          return [];
        }
        return Object.keys(carrier);
      }
    };
    exports.defaultTextMapSetter = {
      set(carrier, key, value) {
        if (carrier == null) {
          return;
        }
        carrier[key] = value;
      }
    };
  }
});

// node_modules/@opentelemetry/api/build/src/context/NoopContextManager.js
var require_NoopContextManager = __commonJS({
  "node_modules/@opentelemetry/api/build/src/context/NoopContextManager.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoopContextManager = void 0;
    var context_1 = require_context();
    var NoopContextManager = class {
      static {
        __name(this, "NoopContextManager");
      }
      active() {
        return context_1.ROOT_CONTEXT;
      }
      with(_context, fn, thisArg, ...args) {
        return fn.call(thisArg, ...args);
      }
      bind(_context, target) {
        return target;
      }
      enable() {
        return this;
      }
      disable() {
        return this;
      }
    };
    exports.NoopContextManager = NoopContextManager;
  }
});

// node_modules/@opentelemetry/api/build/src/api/context.js
var require_context2 = __commonJS({
  "node_modules/@opentelemetry/api/build/src/api/context.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ContextAPI = void 0;
    var NoopContextManager_1 = require_NoopContextManager();
    var global_utils_1 = require_global_utils();
    var diag_1 = require_diag();
    var API_NAME = "context";
    var NOOP_CONTEXT_MANAGER = new NoopContextManager_1.NoopContextManager();
    var ContextAPI = class _ContextAPI {
      static {
        __name(this, "ContextAPI");
      }
      /** Empty private constructor prevents end users from constructing a new instance of the API */
      constructor() {
      }
      /** Get the singleton instance of the Context API */
      static getInstance() {
        if (!this._instance) {
          this._instance = new _ContextAPI();
        }
        return this._instance;
      }
      /**
       * Set the current context manager.
       *
       * @returns true if the context manager was successfully registered, else false
       */
      setGlobalContextManager(contextManager) {
        return (0, global_utils_1.registerGlobal)(API_NAME, contextManager, diag_1.DiagAPI.instance());
      }
      /**
       * Get the currently active context
       */
      active() {
        return this._getContextManager().active();
      }
      /**
       * Execute a function with an active context
       *
       * @param context context to be active during function execution
       * @param fn function to execute in a context
       * @param thisArg optional receiver to be used for calling fn
       * @param args optional arguments forwarded to fn
       */
      with(context2, fn, thisArg, ...args) {
        return this._getContextManager().with(context2, fn, thisArg, ...args);
      }
      /**
       * Bind a context to a target function or event emitter
       *
       * @param context context to bind to the event emitter or function. Defaults to the currently active context
       * @param target function or event emitter to bind
       */
      bind(context2, target) {
        return this._getContextManager().bind(context2, target);
      }
      _getContextManager() {
        return (0, global_utils_1.getGlobal)(API_NAME) || NOOP_CONTEXT_MANAGER;
      }
      /** Disable and remove the global context manager */
      disable() {
        this._getContextManager().disable();
        (0, global_utils_1.unregisterGlobal)(API_NAME, diag_1.DiagAPI.instance());
      }
    };
    exports.ContextAPI = ContextAPI;
  }
});

// node_modules/@opentelemetry/api/build/src/trace/trace_flags.js
var require_trace_flags = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/trace_flags.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TraceFlags = void 0;
    var TraceFlags3;
    (function(TraceFlags4) {
      TraceFlags4[TraceFlags4["NONE"] = 0] = "NONE";
      TraceFlags4[TraceFlags4["SAMPLED"] = 1] = "SAMPLED";
    })(TraceFlags3 = exports.TraceFlags || (exports.TraceFlags = {}));
  }
});

// node_modules/@opentelemetry/api/build/src/trace/invalid-span-constants.js
var require_invalid_span_constants = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/invalid-span-constants.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.INVALID_SPAN_CONTEXT = exports.INVALID_TRACEID = exports.INVALID_SPANID = void 0;
    var trace_flags_1 = require_trace_flags();
    exports.INVALID_SPANID = "0000000000000000";
    exports.INVALID_TRACEID = "00000000000000000000000000000000";
    exports.INVALID_SPAN_CONTEXT = {
      traceId: exports.INVALID_TRACEID,
      spanId: exports.INVALID_SPANID,
      traceFlags: trace_flags_1.TraceFlags.NONE
    };
  }
});

// node_modules/@opentelemetry/api/build/src/trace/NonRecordingSpan.js
var require_NonRecordingSpan = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/NonRecordingSpan.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NonRecordingSpan = void 0;
    var invalid_span_constants_1 = require_invalid_span_constants();
    var NonRecordingSpan = class {
      static {
        __name(this, "NonRecordingSpan");
      }
      constructor(spanContext = invalid_span_constants_1.INVALID_SPAN_CONTEXT) {
        this._spanContext = spanContext;
      }
      // Returns a SpanContext.
      spanContext() {
        return this._spanContext;
      }
      // By default does nothing
      setAttribute(_key, _value) {
        return this;
      }
      // By default does nothing
      setAttributes(_attributes) {
        return this;
      }
      // By default does nothing
      addEvent(_name, _attributes) {
        return this;
      }
      addLink(_link) {
        return this;
      }
      addLinks(_links) {
        return this;
      }
      // By default does nothing
      setStatus(_status) {
        return this;
      }
      // By default does nothing
      updateName(_name) {
        return this;
      }
      // By default does nothing
      end(_endTime) {
      }
      // isRecording always returns false for NonRecordingSpan.
      isRecording() {
        return false;
      }
      // By default does nothing
      recordException(_exception, _time) {
      }
    };
    exports.NonRecordingSpan = NonRecordingSpan;
  }
});

// node_modules/@opentelemetry/api/build/src/trace/context-utils.js
var require_context_utils = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/context-utils.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getSpanContext = exports.setSpanContext = exports.deleteSpan = exports.setSpan = exports.getActiveSpan = exports.getSpan = void 0;
    var context_1 = require_context();
    var NonRecordingSpan_1 = require_NonRecordingSpan();
    var context_2 = require_context2();
    var SPAN_KEY = (0, context_1.createContextKey)("OpenTelemetry Context Key SPAN");
    function getSpan(context2) {
      return context2.getValue(SPAN_KEY) || void 0;
    }
    __name(getSpan, "getSpan");
    exports.getSpan = getSpan;
    function getActiveSpan2() {
      return getSpan(context_2.ContextAPI.getInstance().active());
    }
    __name(getActiveSpan2, "getActiveSpan");
    exports.getActiveSpan = getActiveSpan2;
    function setSpan(context2, span) {
      return context2.setValue(SPAN_KEY, span);
    }
    __name(setSpan, "setSpan");
    exports.setSpan = setSpan;
    function deleteSpan(context2) {
      return context2.deleteValue(SPAN_KEY);
    }
    __name(deleteSpan, "deleteSpan");
    exports.deleteSpan = deleteSpan;
    function setSpanContext(context2, spanContext) {
      return setSpan(context2, new NonRecordingSpan_1.NonRecordingSpan(spanContext));
    }
    __name(setSpanContext, "setSpanContext");
    exports.setSpanContext = setSpanContext;
    function getSpanContext(context2) {
      var _a;
      return (_a = getSpan(context2)) === null || _a === void 0 ? void 0 : _a.spanContext();
    }
    __name(getSpanContext, "getSpanContext");
    exports.getSpanContext = getSpanContext;
  }
});

// node_modules/@opentelemetry/api/build/src/trace/spancontext-utils.js
var require_spancontext_utils = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/spancontext-utils.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.wrapSpanContext = exports.isSpanContextValid = exports.isValidSpanId = exports.isValidTraceId = void 0;
    var invalid_span_constants_1 = require_invalid_span_constants();
    var NonRecordingSpan_1 = require_NonRecordingSpan();
    var isHex = new Uint8Array([
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      1,
      1,
      1,
      1,
      1
    ]);
    function isValidHex(id, length) {
      if (typeof id !== "string" || id.length !== length)
        return false;
      let r = 0;
      for (let i = 0; i < id.length; i += 4) {
        r += (isHex[id.charCodeAt(i)] | 0) + (isHex[id.charCodeAt(i + 1)] | 0) + (isHex[id.charCodeAt(i + 2)] | 0) + (isHex[id.charCodeAt(i + 3)] | 0);
      }
      return r === length;
    }
    __name(isValidHex, "isValidHex");
    function isValidTraceId(traceId) {
      return isValidHex(traceId, 32) && traceId !== invalid_span_constants_1.INVALID_TRACEID;
    }
    __name(isValidTraceId, "isValidTraceId");
    exports.isValidTraceId = isValidTraceId;
    function isValidSpanId(spanId) {
      return isValidHex(spanId, 16) && spanId !== invalid_span_constants_1.INVALID_SPANID;
    }
    __name(isValidSpanId, "isValidSpanId");
    exports.isValidSpanId = isValidSpanId;
    function isSpanContextValid2(spanContext) {
      return isValidTraceId(spanContext.traceId) && isValidSpanId(spanContext.spanId);
    }
    __name(isSpanContextValid2, "isSpanContextValid");
    exports.isSpanContextValid = isSpanContextValid2;
    function wrapSpanContext(spanContext) {
      return new NonRecordingSpan_1.NonRecordingSpan(spanContext);
    }
    __name(wrapSpanContext, "wrapSpanContext");
    exports.wrapSpanContext = wrapSpanContext;
  }
});

// node_modules/@opentelemetry/api/build/src/trace/NoopTracer.js
var require_NoopTracer = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/NoopTracer.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoopTracer = void 0;
    var context_1 = require_context2();
    var context_utils_1 = require_context_utils();
    var NonRecordingSpan_1 = require_NonRecordingSpan();
    var spancontext_utils_1 = require_spancontext_utils();
    var contextApi = context_1.ContextAPI.getInstance();
    var NoopTracer = class {
      static {
        __name(this, "NoopTracer");
      }
      // startSpan starts a noop span.
      startSpan(name, options, context2 = contextApi.active()) {
        const root = Boolean(options === null || options === void 0 ? void 0 : options.root);
        if (root) {
          return new NonRecordingSpan_1.NonRecordingSpan();
        }
        const parentFromContext = context2 && (0, context_utils_1.getSpanContext)(context2);
        if (isSpanContext(parentFromContext) && (0, spancontext_utils_1.isSpanContextValid)(parentFromContext)) {
          return new NonRecordingSpan_1.NonRecordingSpan(parentFromContext);
        } else {
          return new NonRecordingSpan_1.NonRecordingSpan();
        }
      }
      startActiveSpan(name, arg2, arg3, arg4) {
        let opts;
        let ctx;
        let fn;
        if (arguments.length < 2) {
          return;
        } else if (arguments.length === 2) {
          fn = arg2;
        } else if (arguments.length === 3) {
          opts = arg2;
          fn = arg3;
        } else {
          opts = arg2;
          ctx = arg3;
          fn = arg4;
        }
        const parentContext = ctx !== null && ctx !== void 0 ? ctx : contextApi.active();
        const span = this.startSpan(name, opts, parentContext);
        const contextWithSpanSet = (0, context_utils_1.setSpan)(parentContext, span);
        return contextApi.with(contextWithSpanSet, fn, void 0, span);
      }
    };
    exports.NoopTracer = NoopTracer;
    function isSpanContext(spanContext) {
      return spanContext !== null && typeof spanContext === "object" && "spanId" in spanContext && typeof spanContext["spanId"] === "string" && "traceId" in spanContext && typeof spanContext["traceId"] === "string" && "traceFlags" in spanContext && typeof spanContext["traceFlags"] === "number";
    }
    __name(isSpanContext, "isSpanContext");
  }
});

// node_modules/@opentelemetry/api/build/src/trace/ProxyTracer.js
var require_ProxyTracer = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/ProxyTracer.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProxyTracer = void 0;
    var NoopTracer_1 = require_NoopTracer();
    var NOOP_TRACER = new NoopTracer_1.NoopTracer();
    var ProxyTracer = class {
      static {
        __name(this, "ProxyTracer");
      }
      constructor(provider, name, version, options) {
        this._provider = provider;
        this.name = name;
        this.version = version;
        this.options = options;
      }
      startSpan(name, options, context2) {
        return this._getTracer().startSpan(name, options, context2);
      }
      startActiveSpan(_name, _options, _context, _fn) {
        const tracer = this._getTracer();
        return Reflect.apply(tracer.startActiveSpan, tracer, arguments);
      }
      /**
       * Try to get a tracer from the proxy tracer provider.
       * If the proxy tracer provider has no delegate, return a noop tracer.
       */
      _getTracer() {
        if (this._delegate) {
          return this._delegate;
        }
        const tracer = this._provider.getDelegateTracer(this.name, this.version, this.options);
        if (!tracer) {
          return NOOP_TRACER;
        }
        this._delegate = tracer;
        return this._delegate;
      }
    };
    exports.ProxyTracer = ProxyTracer;
  }
});

// node_modules/@opentelemetry/api/build/src/trace/NoopTracerProvider.js
var require_NoopTracerProvider = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/NoopTracerProvider.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoopTracerProvider = void 0;
    var NoopTracer_1 = require_NoopTracer();
    var NoopTracerProvider = class {
      static {
        __name(this, "NoopTracerProvider");
      }
      getTracer(_name, _version, _options) {
        return new NoopTracer_1.NoopTracer();
      }
    };
    exports.NoopTracerProvider = NoopTracerProvider;
  }
});

// node_modules/@opentelemetry/api/build/src/trace/ProxyTracerProvider.js
var require_ProxyTracerProvider = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/ProxyTracerProvider.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ProxyTracerProvider = void 0;
    var ProxyTracer_1 = require_ProxyTracer();
    var NoopTracerProvider_1 = require_NoopTracerProvider();
    var NOOP_TRACER_PROVIDER = new NoopTracerProvider_1.NoopTracerProvider();
    var ProxyTracerProvider = class {
      static {
        __name(this, "ProxyTracerProvider");
      }
      /**
       * Get a {@link ProxyTracer}
       */
      getTracer(name, version, options) {
        var _a;
        return (_a = this.getDelegateTracer(name, version, options)) !== null && _a !== void 0 ? _a : new ProxyTracer_1.ProxyTracer(this, name, version, options);
      }
      getDelegate() {
        var _a;
        return (_a = this._delegate) !== null && _a !== void 0 ? _a : NOOP_TRACER_PROVIDER;
      }
      /**
       * Set the delegate tracer provider
       */
      setDelegate(delegate) {
        this._delegate = delegate;
      }
      getDelegateTracer(name, version, options) {
        var _a;
        return (_a = this._delegate) === null || _a === void 0 ? void 0 : _a.getTracer(name, version, options);
      }
    };
    exports.ProxyTracerProvider = ProxyTracerProvider;
  }
});

// node_modules/@opentelemetry/api/build/src/trace/SamplingResult.js
var require_SamplingResult = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/SamplingResult.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SamplingDecision = void 0;
    var SamplingDecision;
    (function(SamplingDecision2) {
      SamplingDecision2[SamplingDecision2["NOT_RECORD"] = 0] = "NOT_RECORD";
      SamplingDecision2[SamplingDecision2["RECORD"] = 1] = "RECORD";
      SamplingDecision2[SamplingDecision2["RECORD_AND_SAMPLED"] = 2] = "RECORD_AND_SAMPLED";
    })(SamplingDecision = exports.SamplingDecision || (exports.SamplingDecision = {}));
  }
});

// node_modules/@opentelemetry/api/build/src/trace/span_kind.js
var require_span_kind = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/span_kind.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SpanKind = void 0;
    var SpanKind;
    (function(SpanKind2) {
      SpanKind2[SpanKind2["INTERNAL"] = 0] = "INTERNAL";
      SpanKind2[SpanKind2["SERVER"] = 1] = "SERVER";
      SpanKind2[SpanKind2["CLIENT"] = 2] = "CLIENT";
      SpanKind2[SpanKind2["PRODUCER"] = 3] = "PRODUCER";
      SpanKind2[SpanKind2["CONSUMER"] = 4] = "CONSUMER";
    })(SpanKind = exports.SpanKind || (exports.SpanKind = {}));
  }
});

// node_modules/@opentelemetry/api/build/src/trace/status.js
var require_status = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/status.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SpanStatusCode = void 0;
    var SpanStatusCode;
    (function(SpanStatusCode2) {
      SpanStatusCode2[SpanStatusCode2["UNSET"] = 0] = "UNSET";
      SpanStatusCode2[SpanStatusCode2["OK"] = 1] = "OK";
      SpanStatusCode2[SpanStatusCode2["ERROR"] = 2] = "ERROR";
    })(SpanStatusCode = exports.SpanStatusCode || (exports.SpanStatusCode = {}));
  }
});

// node_modules/@opentelemetry/api/build/src/trace/internal/tracestate-validators.js
var require_tracestate_validators = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/internal/tracestate-validators.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateValue = exports.validateKey = void 0;
    var VALID_KEY_CHAR_RANGE = "[_0-9a-z-*/]";
    var VALID_KEY = `[a-z]${VALID_KEY_CHAR_RANGE}{0,255}`;
    var VALID_VENDOR_KEY = `[a-z0-9]${VALID_KEY_CHAR_RANGE}{0,240}@[a-z]${VALID_KEY_CHAR_RANGE}{0,13}`;
    var VALID_KEY_REGEX = new RegExp(`^(?:${VALID_KEY}|${VALID_VENDOR_KEY})$`);
    var VALID_VALUE_BASE_REGEX = /^[ -~]{0,255}[!-~]$/;
    var INVALID_VALUE_COMMA_EQUAL_REGEX = /,|=/;
    function validateKey(key) {
      return VALID_KEY_REGEX.test(key);
    }
    __name(validateKey, "validateKey");
    exports.validateKey = validateKey;
    function validateValue(value) {
      return VALID_VALUE_BASE_REGEX.test(value) && !INVALID_VALUE_COMMA_EQUAL_REGEX.test(value);
    }
    __name(validateValue, "validateValue");
    exports.validateValue = validateValue;
  }
});

// node_modules/@opentelemetry/api/build/src/trace/internal/tracestate-impl.js
var require_tracestate_impl = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/internal/tracestate-impl.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TraceStateImpl = void 0;
    var tracestate_validators_1 = require_tracestate_validators();
    var MAX_TRACE_STATE_ITEMS = 32;
    var MAX_TRACE_STATE_LEN = 512;
    var LIST_MEMBERS_SEPARATOR = ",";
    var LIST_MEMBER_KEY_VALUE_SPLITTER = "=";
    var TraceStateImpl = class _TraceStateImpl {
      static {
        __name(this, "TraceStateImpl");
      }
      constructor(rawTraceState) {
        this._internalState = /* @__PURE__ */ new Map();
        if (rawTraceState)
          this._parse(rawTraceState);
      }
      set(key, value) {
        const traceState = this._clone();
        if (traceState._internalState.has(key)) {
          traceState._internalState.delete(key);
        }
        traceState._internalState.set(key, value);
        return traceState;
      }
      unset(key) {
        const traceState = this._clone();
        traceState._internalState.delete(key);
        return traceState;
      }
      get(key) {
        return this._internalState.get(key);
      }
      serialize() {
        return Array.from(this._internalState.keys()).reduceRight((agg, key) => {
          agg.push(key + LIST_MEMBER_KEY_VALUE_SPLITTER + this.get(key));
          return agg;
        }, []).join(LIST_MEMBERS_SEPARATOR);
      }
      _parse(rawTraceState) {
        if (rawTraceState.length > MAX_TRACE_STATE_LEN)
          return;
        this._internalState = rawTraceState.split(LIST_MEMBERS_SEPARATOR).reduceRight((agg, part) => {
          const listMember = part.trim();
          const i = listMember.indexOf(LIST_MEMBER_KEY_VALUE_SPLITTER);
          if (i !== -1) {
            const key = listMember.slice(0, i);
            const value = listMember.slice(i + 1, part.length);
            if ((0, tracestate_validators_1.validateKey)(key) && (0, tracestate_validators_1.validateValue)(value)) {
              agg.set(key, value);
            } else {
            }
          }
          return agg;
        }, /* @__PURE__ */ new Map());
        if (this._internalState.size > MAX_TRACE_STATE_ITEMS) {
          this._internalState = new Map(Array.from(this._internalState.entries()).reverse().slice(0, MAX_TRACE_STATE_ITEMS));
        }
      }
      // @ts-expect-error TS6133 Accessed in tests only.
      _keys() {
        return Array.from(this._internalState.keys()).reverse();
      }
      _clone() {
        const traceState = new _TraceStateImpl();
        traceState._internalState = new Map(this._internalState);
        return traceState;
      }
    };
    exports.TraceStateImpl = TraceStateImpl;
  }
});

// node_modules/@opentelemetry/api/build/src/trace/internal/utils.js
var require_utils2 = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace/internal/utils.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createTraceState = void 0;
    var tracestate_impl_1 = require_tracestate_impl();
    function createTraceState(rawTraceState) {
      return new tracestate_impl_1.TraceStateImpl(rawTraceState);
    }
    __name(createTraceState, "createTraceState");
    exports.createTraceState = createTraceState;
  }
});

// node_modules/@opentelemetry/api/build/src/context-api.js
var require_context_api = __commonJS({
  "node_modules/@opentelemetry/api/build/src/context-api.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.context = void 0;
    var context_1 = require_context2();
    exports.context = context_1.ContextAPI.getInstance();
  }
});

// node_modules/@opentelemetry/api/build/src/diag-api.js
var require_diag_api = __commonJS({
  "node_modules/@opentelemetry/api/build/src/diag-api.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.diag = void 0;
    var diag_1 = require_diag();
    exports.diag = diag_1.DiagAPI.instance();
  }
});

// node_modules/@opentelemetry/api/build/src/metrics/NoopMeterProvider.js
var require_NoopMeterProvider = __commonJS({
  "node_modules/@opentelemetry/api/build/src/metrics/NoopMeterProvider.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NOOP_METER_PROVIDER = exports.NoopMeterProvider = void 0;
    var NoopMeter_1 = require_NoopMeter();
    var NoopMeterProvider = class {
      static {
        __name(this, "NoopMeterProvider");
      }
      getMeter(_name, _version, _options) {
        return NoopMeter_1.NOOP_METER;
      }
    };
    exports.NoopMeterProvider = NoopMeterProvider;
    exports.NOOP_METER_PROVIDER = new NoopMeterProvider();
  }
});

// node_modules/@opentelemetry/api/build/src/api/metrics.js
var require_metrics = __commonJS({
  "node_modules/@opentelemetry/api/build/src/api/metrics.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MetricsAPI = void 0;
    var NoopMeterProvider_1 = require_NoopMeterProvider();
    var global_utils_1 = require_global_utils();
    var diag_1 = require_diag();
    var API_NAME = "metrics";
    var MetricsAPI = class _MetricsAPI {
      static {
        __name(this, "MetricsAPI");
      }
      /** Empty private constructor prevents end users from constructing a new instance of the API */
      constructor() {
      }
      /** Get the singleton instance of the Metrics API */
      static getInstance() {
        if (!this._instance) {
          this._instance = new _MetricsAPI();
        }
        return this._instance;
      }
      /**
       * Set the current global meter provider.
       * Returns true if the meter provider was successfully registered, else false.
       */
      setGlobalMeterProvider(provider) {
        return (0, global_utils_1.registerGlobal)(API_NAME, provider, diag_1.DiagAPI.instance());
      }
      /**
       * Returns the global meter provider.
       */
      getMeterProvider() {
        return (0, global_utils_1.getGlobal)(API_NAME) || NoopMeterProvider_1.NOOP_METER_PROVIDER;
      }
      /**
       * Returns a meter from the global meter provider.
       */
      getMeter(name, version, options) {
        return this.getMeterProvider().getMeter(name, version, options);
      }
      /** Remove the global meter provider */
      disable() {
        (0, global_utils_1.unregisterGlobal)(API_NAME, diag_1.DiagAPI.instance());
      }
    };
    exports.MetricsAPI = MetricsAPI;
  }
});

// node_modules/@opentelemetry/api/build/src/metrics-api.js
var require_metrics_api = __commonJS({
  "node_modules/@opentelemetry/api/build/src/metrics-api.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.metrics = void 0;
    var metrics_1 = require_metrics();
    exports.metrics = metrics_1.MetricsAPI.getInstance();
  }
});

// node_modules/@opentelemetry/api/build/src/propagation/NoopTextMapPropagator.js
var require_NoopTextMapPropagator = __commonJS({
  "node_modules/@opentelemetry/api/build/src/propagation/NoopTextMapPropagator.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NoopTextMapPropagator = void 0;
    var NoopTextMapPropagator = class {
      static {
        __name(this, "NoopTextMapPropagator");
      }
      /** Noop inject function does nothing */
      inject(_context, _carrier) {
      }
      /** Noop extract function does nothing and returns the input context */
      extract(context2, _carrier) {
        return context2;
      }
      fields() {
        return [];
      }
    };
    exports.NoopTextMapPropagator = NoopTextMapPropagator;
  }
});

// node_modules/@opentelemetry/api/build/src/baggage/context-helpers.js
var require_context_helpers = __commonJS({
  "node_modules/@opentelemetry/api/build/src/baggage/context-helpers.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.deleteBaggage = exports.setBaggage = exports.getActiveBaggage = exports.getBaggage = void 0;
    var context_1 = require_context2();
    var context_2 = require_context();
    var BAGGAGE_KEY = (0, context_2.createContextKey)("OpenTelemetry Baggage Key");
    function getBaggage(context2) {
      return context2.getValue(BAGGAGE_KEY) || void 0;
    }
    __name(getBaggage, "getBaggage");
    exports.getBaggage = getBaggage;
    function getActiveBaggage() {
      return getBaggage(context_1.ContextAPI.getInstance().active());
    }
    __name(getActiveBaggage, "getActiveBaggage");
    exports.getActiveBaggage = getActiveBaggage;
    function setBaggage(context2, baggage) {
      return context2.setValue(BAGGAGE_KEY, baggage);
    }
    __name(setBaggage, "setBaggage");
    exports.setBaggage = setBaggage;
    function deleteBaggage(context2) {
      return context2.deleteValue(BAGGAGE_KEY);
    }
    __name(deleteBaggage, "deleteBaggage");
    exports.deleteBaggage = deleteBaggage;
  }
});

// node_modules/@opentelemetry/api/build/src/api/propagation.js
var require_propagation = __commonJS({
  "node_modules/@opentelemetry/api/build/src/api/propagation.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PropagationAPI = void 0;
    var global_utils_1 = require_global_utils();
    var NoopTextMapPropagator_1 = require_NoopTextMapPropagator();
    var TextMapPropagator_1 = require_TextMapPropagator();
    var context_helpers_1 = require_context_helpers();
    var utils_1 = require_utils();
    var diag_1 = require_diag();
    var API_NAME = "propagation";
    var NOOP_TEXT_MAP_PROPAGATOR = new NoopTextMapPropagator_1.NoopTextMapPropagator();
    var PropagationAPI = class _PropagationAPI {
      static {
        __name(this, "PropagationAPI");
      }
      /** Empty private constructor prevents end users from constructing a new instance of the API */
      constructor() {
        this.createBaggage = utils_1.createBaggage;
        this.getBaggage = context_helpers_1.getBaggage;
        this.getActiveBaggage = context_helpers_1.getActiveBaggage;
        this.setBaggage = context_helpers_1.setBaggage;
        this.deleteBaggage = context_helpers_1.deleteBaggage;
      }
      /** Get the singleton instance of the Propagator API */
      static getInstance() {
        if (!this._instance) {
          this._instance = new _PropagationAPI();
        }
        return this._instance;
      }
      /**
       * Set the current propagator.
       *
       * @returns true if the propagator was successfully registered, else false
       */
      setGlobalPropagator(propagator) {
        return (0, global_utils_1.registerGlobal)(API_NAME, propagator, diag_1.DiagAPI.instance());
      }
      /**
       * Inject context into a carrier to be propagated inter-process
       *
       * @param context Context carrying tracing data to inject
       * @param carrier carrier to inject context into
       * @param setter Function used to set values on the carrier
       */
      inject(context2, carrier, setter = TextMapPropagator_1.defaultTextMapSetter) {
        return this._getGlobalPropagator().inject(context2, carrier, setter);
      }
      /**
       * Extract context from a carrier
       *
       * @param context Context which the newly created context will inherit from
       * @param carrier Carrier to extract context from
       * @param getter Function used to extract keys from a carrier
       */
      extract(context2, carrier, getter = TextMapPropagator_1.defaultTextMapGetter) {
        return this._getGlobalPropagator().extract(context2, carrier, getter);
      }
      /**
       * Return a list of all fields which may be used by the propagator.
       */
      fields() {
        return this._getGlobalPropagator().fields();
      }
      /** Remove the global propagator */
      disable() {
        (0, global_utils_1.unregisterGlobal)(API_NAME, diag_1.DiagAPI.instance());
      }
      _getGlobalPropagator() {
        return (0, global_utils_1.getGlobal)(API_NAME) || NOOP_TEXT_MAP_PROPAGATOR;
      }
    };
    exports.PropagationAPI = PropagationAPI;
  }
});

// node_modules/@opentelemetry/api/build/src/propagation-api.js
var require_propagation_api = __commonJS({
  "node_modules/@opentelemetry/api/build/src/propagation-api.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.propagation = void 0;
    var propagation_1 = require_propagation();
    exports.propagation = propagation_1.PropagationAPI.getInstance();
  }
});

// node_modules/@opentelemetry/api/build/src/api/trace.js
var require_trace = __commonJS({
  "node_modules/@opentelemetry/api/build/src/api/trace.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TraceAPI = void 0;
    var global_utils_1 = require_global_utils();
    var ProxyTracerProvider_1 = require_ProxyTracerProvider();
    var spancontext_utils_1 = require_spancontext_utils();
    var context_utils_1 = require_context_utils();
    var diag_1 = require_diag();
    var API_NAME = "trace";
    var TraceAPI = class _TraceAPI {
      static {
        __name(this, "TraceAPI");
      }
      /** Empty private constructor prevents end users from constructing a new instance of the API */
      constructor() {
        this._proxyTracerProvider = new ProxyTracerProvider_1.ProxyTracerProvider();
        this.wrapSpanContext = spancontext_utils_1.wrapSpanContext;
        this.isSpanContextValid = spancontext_utils_1.isSpanContextValid;
        this.deleteSpan = context_utils_1.deleteSpan;
        this.getSpan = context_utils_1.getSpan;
        this.getActiveSpan = context_utils_1.getActiveSpan;
        this.getSpanContext = context_utils_1.getSpanContext;
        this.setSpan = context_utils_1.setSpan;
        this.setSpanContext = context_utils_1.setSpanContext;
      }
      /** Get the singleton instance of the Trace API */
      static getInstance() {
        if (!this._instance) {
          this._instance = new _TraceAPI();
        }
        return this._instance;
      }
      /**
       * Set the current global tracer.
       *
       * @returns true if the tracer provider was successfully registered, else false
       */
      setGlobalTracerProvider(provider) {
        const success = (0, global_utils_1.registerGlobal)(API_NAME, this._proxyTracerProvider, diag_1.DiagAPI.instance());
        if (success) {
          this._proxyTracerProvider.setDelegate(provider);
        }
        return success;
      }
      /**
       * Returns the global tracer provider.
       */
      getTracerProvider() {
        return (0, global_utils_1.getGlobal)(API_NAME) || this._proxyTracerProvider;
      }
      /**
       * Returns a tracer from the global tracer provider.
       */
      getTracer(name, version) {
        return this.getTracerProvider().getTracer(name, version);
      }
      /** Remove the global tracer provider */
      disable() {
        (0, global_utils_1.unregisterGlobal)(API_NAME, diag_1.DiagAPI.instance());
        this._proxyTracerProvider = new ProxyTracerProvider_1.ProxyTracerProvider();
      }
    };
    exports.TraceAPI = TraceAPI;
  }
});

// node_modules/@opentelemetry/api/build/src/trace-api.js
var require_trace_api = __commonJS({
  "node_modules/@opentelemetry/api/build/src/trace-api.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.trace = void 0;
    var trace_1 = require_trace();
    exports.trace = trace_1.TraceAPI.getInstance();
  }
});

// node_modules/@opentelemetry/api/build/src/index.js
var require_src = __commonJS({
  "node_modules/@opentelemetry/api/build/src/index.js"(exports) {
    "use strict";
    init_modules_watch_stub();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.trace = exports.propagation = exports.metrics = exports.diag = exports.context = exports.INVALID_SPAN_CONTEXT = exports.INVALID_TRACEID = exports.INVALID_SPANID = exports.isValidSpanId = exports.isValidTraceId = exports.isSpanContextValid = exports.createTraceState = exports.TraceFlags = exports.SpanStatusCode = exports.SpanKind = exports.SamplingDecision = exports.ProxyTracerProvider = exports.ProxyTracer = exports.defaultTextMapSetter = exports.defaultTextMapGetter = exports.ValueType = exports.createNoopMeter = exports.DiagLogLevel = exports.DiagConsoleLogger = exports.ROOT_CONTEXT = exports.createContextKey = exports.baggageEntryMetadataFromString = void 0;
    var utils_1 = require_utils();
    Object.defineProperty(exports, "baggageEntryMetadataFromString", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return utils_1.baggageEntryMetadataFromString;
    }, "get") });
    var context_1 = require_context();
    Object.defineProperty(exports, "createContextKey", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return context_1.createContextKey;
    }, "get") });
    Object.defineProperty(exports, "ROOT_CONTEXT", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return context_1.ROOT_CONTEXT;
    }, "get") });
    var consoleLogger_1 = require_consoleLogger();
    Object.defineProperty(exports, "DiagConsoleLogger", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return consoleLogger_1.DiagConsoleLogger;
    }, "get") });
    var types_1 = require_types();
    Object.defineProperty(exports, "DiagLogLevel", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return types_1.DiagLogLevel;
    }, "get") });
    var NoopMeter_1 = require_NoopMeter();
    Object.defineProperty(exports, "createNoopMeter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return NoopMeter_1.createNoopMeter;
    }, "get") });
    var Metric_1 = require_Metric();
    Object.defineProperty(exports, "ValueType", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return Metric_1.ValueType;
    }, "get") });
    var TextMapPropagator_1 = require_TextMapPropagator();
    Object.defineProperty(exports, "defaultTextMapGetter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return TextMapPropagator_1.defaultTextMapGetter;
    }, "get") });
    Object.defineProperty(exports, "defaultTextMapSetter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return TextMapPropagator_1.defaultTextMapSetter;
    }, "get") });
    var ProxyTracer_1 = require_ProxyTracer();
    Object.defineProperty(exports, "ProxyTracer", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ProxyTracer_1.ProxyTracer;
    }, "get") });
    var ProxyTracerProvider_1 = require_ProxyTracerProvider();
    Object.defineProperty(exports, "ProxyTracerProvider", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return ProxyTracerProvider_1.ProxyTracerProvider;
    }, "get") });
    var SamplingResult_1 = require_SamplingResult();
    Object.defineProperty(exports, "SamplingDecision", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return SamplingResult_1.SamplingDecision;
    }, "get") });
    var span_kind_1 = require_span_kind();
    Object.defineProperty(exports, "SpanKind", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return span_kind_1.SpanKind;
    }, "get") });
    var status_1 = require_status();
    Object.defineProperty(exports, "SpanStatusCode", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return status_1.SpanStatusCode;
    }, "get") });
    var trace_flags_1 = require_trace_flags();
    Object.defineProperty(exports, "TraceFlags", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return trace_flags_1.TraceFlags;
    }, "get") });
    var utils_2 = require_utils2();
    Object.defineProperty(exports, "createTraceState", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return utils_2.createTraceState;
    }, "get") });
    var spancontext_utils_1 = require_spancontext_utils();
    Object.defineProperty(exports, "isSpanContextValid", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return spancontext_utils_1.isSpanContextValid;
    }, "get") });
    Object.defineProperty(exports, "isValidTraceId", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return spancontext_utils_1.isValidTraceId;
    }, "get") });
    Object.defineProperty(exports, "isValidSpanId", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return spancontext_utils_1.isValidSpanId;
    }, "get") });
    var invalid_span_constants_1 = require_invalid_span_constants();
    Object.defineProperty(exports, "INVALID_SPANID", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return invalid_span_constants_1.INVALID_SPANID;
    }, "get") });
    Object.defineProperty(exports, "INVALID_TRACEID", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return invalid_span_constants_1.INVALID_TRACEID;
    }, "get") });
    Object.defineProperty(exports, "INVALID_SPAN_CONTEXT", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return invalid_span_constants_1.INVALID_SPAN_CONTEXT;
    }, "get") });
    var context_api_1 = require_context_api();
    Object.defineProperty(exports, "context", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return context_api_1.context;
    }, "get") });
    var diag_api_1 = require_diag_api();
    Object.defineProperty(exports, "diag", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return diag_api_1.diag;
    }, "get") });
    var metrics_api_1 = require_metrics_api();
    Object.defineProperty(exports, "metrics", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return metrics_api_1.metrics;
    }, "get") });
    var propagation_api_1 = require_propagation_api();
    Object.defineProperty(exports, "propagation", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return propagation_api_1.propagation;
    }, "get") });
    var trace_api_1 = require_trace_api();
    Object.defineProperty(exports, "trace", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return trace_api_1.trace;
    }, "get") });
    exports.default = {
      context: context_api_1.context,
      diag: diag_api_1.diag,
      metrics: metrics_api_1.metrics,
      propagation: propagation_api_1.propagation,
      trace: trace_api_1.trace
    };
  }
});

// .wrangler/tmp/bundle-dtUgRt/middleware-loader.entry.ts
init_modules_watch_stub();

// .wrangler/tmp/bundle-dtUgRt/middleware-insertion-facade.js
init_modules_watch_stub();

// src/index.ts
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/index.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/index.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/debug-build.js
init_modules_watch_stub();
var DEBUG_BUILD = typeof __SENTRY_DEBUG__ === "undefined" || __SENTRY_DEBUG__;

// node_modules/@sentry/core/build/esm/utils/worldwide.js
init_modules_watch_stub();
var GLOBAL_OBJ = globalThis;

// node_modules/@sentry/core/build/esm/instrument/handlers.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/debug-logger.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/carrier.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/version.js
init_modules_watch_stub();
var SDK_VERSION = "11.7.0";

// node_modules/@sentry/core/build/esm/carrier.js
function getMainCarrier() {
  getSentryCarrier(GLOBAL_OBJ);
  return GLOBAL_OBJ;
}
__name(getMainCarrier, "getMainCarrier");
function getSentryCarrier(carrier) {
  const __SENTRY__ = carrier.__SENTRY__ = carrier.__SENTRY__ || {};
  __SENTRY__.version = __SENTRY__.version || SDK_VERSION;
  return __SENTRY__[SDK_VERSION] = __SENTRY__[SDK_VERSION] || {};
}
__name(getSentryCarrier, "getSentryCarrier");
function getGlobalSingleton(name, creator, obj = GLOBAL_OBJ) {
  const __SENTRY__ = obj.__SENTRY__ = obj.__SENTRY__ || {};
  const carrier = __SENTRY__[SDK_VERSION] = __SENTRY__[SDK_VERSION] || {};
  return carrier[name] || (carrier[name] = creator());
}
__name(getGlobalSingleton, "getGlobalSingleton");

// node_modules/@sentry/core/build/esm/utils/debug-logger.js
var CONSOLE_LEVELS = [
  "debug",
  "info",
  "warn",
  "error",
  "log",
  "assert",
  "trace"
];
var PREFIX = "Sentry Logger ";
var originalConsoleMethods = {};
function consoleSandbox(callback) {
  if (!("console" in GLOBAL_OBJ)) {
    return callback();
  }
  const console2 = GLOBAL_OBJ.console;
  const wrappedFuncs = {};
  const wrappedLevels = Object.keys(originalConsoleMethods);
  wrappedLevels.forEach((level) => {
    const originalConsoleMethod = originalConsoleMethods[level];
    wrappedFuncs[level] = console2[level];
    console2[level] = originalConsoleMethod;
  });
  try {
    return callback();
  } finally {
    wrappedLevels.forEach((level) => {
      console2[level] = wrappedFuncs[level];
    });
  }
}
__name(consoleSandbox, "consoleSandbox");
function enable() {
  _getLoggerSettings().enabled = true;
}
__name(enable, "enable");
function disable() {
  _getLoggerSettings().enabled = false;
}
__name(disable, "disable");
function isEnabled() {
  return _getLoggerSettings().enabled;
}
__name(isEnabled, "isEnabled");
function log(...args) {
  _maybeLog("log", ...args);
}
__name(log, "log");
function warn(...args) {
  _maybeLog("warn", ...args);
}
__name(warn, "warn");
function error(...args) {
  _maybeLog("error", ...args);
}
__name(error, "error");
function _maybeLog(level, ...args) {
  if (!DEBUG_BUILD) {
    return;
  }
  if (isEnabled()) {
    consoleSandbox(() => {
      GLOBAL_OBJ.console[level](`${PREFIX}[${level}]:`, ...args);
    });
  }
}
__name(_maybeLog, "_maybeLog");
function _getLoggerSettings() {
  if (!DEBUG_BUILD) {
    return { enabled: false };
  }
  return getGlobalSingleton("loggerSettings", () => ({ enabled: false }));
}
__name(_getLoggerSettings, "_getLoggerSettings");
var debug = {
  /** Enable logging. */
  enable,
  /** Disable logging. */
  disable,
  /** Check if logging is enabled. */
  isEnabled,
  /** Log a message. */
  log,
  /** Log a warning. */
  warn,
  /** Log an error. */
  error
};

// node_modules/@sentry/core/build/esm/utils/stacktrace.js
init_modules_watch_stub();
var STACKTRACE_FRAME_LIMIT = 50;
var UNKNOWN_FUNCTION = "?";
var WEBPACK_ERROR_REGEXP = /\(error: (.*)\)/;
var STRIP_FRAME_REGEXP = /captureMessage|captureException/;
function createStackParser(...parsers) {
  const sortedParsers = parsers.sort((a, b2) => a[0] - b2[0]).map((p2) => p2[1]);
  return (stack, skipFirstLines = 0, framesToPop = 0) => {
    const frames = [];
    const lines = stack.split("\n");
    for (let i = skipFirstLines; i < lines.length; i++) {
      let line = lines[i];
      if (line.length > 1024) {
        line = line.slice(0, 1024);
      }
      const cleanedLine = WEBPACK_ERROR_REGEXP.test(line) ? line.replace(WEBPACK_ERROR_REGEXP, "$1") : line;
      if (cleanedLine.includes("Error: ")) {
        continue;
      }
      for (const parser of sortedParsers) {
        const frame = parser(cleanedLine);
        if (frame) {
          frames.push(frame);
          break;
        }
      }
      if (frames.length >= STACKTRACE_FRAME_LIMIT + framesToPop) {
        break;
      }
    }
    return stripSentryFramesAndReverse(frames.slice(framesToPop));
  };
}
__name(createStackParser, "createStackParser");
function stackParserFromStackParserOptions(stackParser) {
  if (Array.isArray(stackParser)) {
    return createStackParser(...stackParser);
  }
  return stackParser;
}
__name(stackParserFromStackParserOptions, "stackParserFromStackParserOptions");
function stripSentryFramesAndReverse(stack) {
  if (!stack.length) {
    return [];
  }
  const localStack = Array.from(stack);
  if (/sentryWrapped/.test(getLastStackFrame(localStack).function || "")) {
    localStack.pop();
  }
  localStack.reverse();
  if (STRIP_FRAME_REGEXP.test(getLastStackFrame(localStack).function || "")) {
    localStack.pop();
    if (STRIP_FRAME_REGEXP.test(getLastStackFrame(localStack).function || "")) {
      localStack.pop();
    }
  }
  return localStack.slice(0, STACKTRACE_FRAME_LIMIT).map((frame) => ({
    ...frame,
    filename: frame.filename || getLastStackFrame(localStack).filename,
    function: frame.function || UNKNOWN_FUNCTION
  }));
}
__name(stripSentryFramesAndReverse, "stripSentryFramesAndReverse");
function getLastStackFrame(arr) {
  return arr[arr.length - 1] || {};
}
__name(getLastStackFrame, "getLastStackFrame");
var defaultFunctionName = "<anonymous>";
function getFunctionName(fn) {
  try {
    if (!fn || typeof fn !== "function") {
      return defaultFunctionName;
    }
    return fn.name || defaultFunctionName;
  } catch {
    return defaultFunctionName;
  }
}
__name(getFunctionName, "getFunctionName");
function getFramesFromEvent(event) {
  const exception = event.exception;
  if (exception) {
    const frames = [];
    try {
      exception.values.forEach((value) => {
        if (value.stacktrace.frames) {
          frames.push(...value.stacktrace.frames);
        }
      });
      return frames;
    } catch {
      return void 0;
    }
  }
  return void 0;
}
__name(getFramesFromEvent, "getFramesFromEvent");
function normalizeStackTracePath(path) {
  let filename = path?.startsWith("file://") ? path.slice(7) : path;
  if (filename?.match(/\/[A-Z]:/)) {
    filename = filename.slice(1);
  }
  return filename;
}
__name(normalizeStackTracePath, "normalizeStackTracePath");

// node_modules/@sentry/core/build/esm/instrument/handlers.js
var handlers = {};
var instrumented = {};
function addHandler(type, handler) {
  handlers[type] = handlers[type] || [];
  handlers[type].push(handler);
  return () => {
    const typeHandlers = handlers[type];
    if (typeHandlers) {
      const index = typeHandlers.indexOf(handler);
      if (index !== -1) {
        typeHandlers.splice(index, 1);
      }
    }
  };
}
__name(addHandler, "addHandler");
function maybeInstrument(type, instrumentFn) {
  if (!instrumented[type]) {
    instrumented[type] = true;
    try {
      instrumentFn();
    } catch (e) {
      DEBUG_BUILD && debug.error(`Error while instrumenting ${type}`, e);
    }
  }
}
__name(maybeInstrument, "maybeInstrument");
function triggerHandlers(type, data) {
  const typeHandlers = type && handlers[type];
  if (!typeHandlers) {
    return;
  }
  for (const handler of typeHandlers) {
    try {
      handler(data);
    } catch (e) {
      DEBUG_BUILD && debug.error(
        `Error while triggering instrumentation handler.
Type: ${type}
Name: ${getFunctionName(handler)}
Error:`,
        e
      );
    }
  }
}
__name(triggerHandlers, "triggerHandlers");

// node_modules/@sentry/core/build/esm/utils/spanUtils.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/asyncContext/index.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/asyncContext/stackStrategy.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/defaultScopes.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/scope.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/session.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/misc.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/object.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/is.js
init_modules_watch_stub();
var objectToString = Object.prototype.toString;
function isError(wat) {
  switch (objectToString.call(wat)) {
    case "[object Error]":
    case "[object Exception]":
    case "[object DOMException]":
    case "[object WebAssembly.Exception]":
      return true;
    default:
      return isInstanceOf(wat, Error);
  }
}
__name(isError, "isError");
function isBuiltin(wat, className) {
  return objectToString.call(wat) === `[object ${className}]`;
}
__name(isBuiltin, "isBuiltin");
function isErrorEvent(wat) {
  return isBuiltin(wat, "ErrorEvent");
}
__name(isErrorEvent, "isErrorEvent");
function isString(wat) {
  return isBuiltin(wat, "String");
}
__name(isString, "isString");
function isParameterizedString(wat) {
  return typeof wat === "object" && wat !== null && "__sentry_template_string__" in wat && "__sentry_template_values__" in wat;
}
__name(isParameterizedString, "isParameterizedString");
function isPrimitive(wat) {
  return wat === null || isParameterizedString(wat) || typeof wat !== "object" && typeof wat !== "function";
}
__name(isPrimitive, "isPrimitive");
function isPlainObject(wat) {
  return isBuiltin(wat, "Object");
}
__name(isPlainObject, "isPlainObject");
function isObjectLike(wat) {
  return typeof wat === "object" && wat !== null;
}
__name(isObjectLike, "isObjectLike");
function isEvent(wat) {
  return typeof Event !== "undefined" && isInstanceOf(wat, Event);
}
__name(isEvent, "isEvent");
function isRegExp(wat) {
  return isBuiltin(wat, "RegExp");
}
__name(isRegExp, "isRegExp");
function isThenable(wat) {
  return Boolean(wat?.then && typeof wat.then === "function");
}
__name(isThenable, "isThenable");
function isInstanceOf(wat, base) {
  try {
    return wat instanceof base;
  } catch {
    return false;
  }
}
__name(isInstanceOf, "isInstanceOf");
function isRequest(request) {
  return typeof Request !== "undefined" && isInstanceOf(request, Request);
}
__name(isRequest, "isRequest");

// node_modules/@sentry/core/build/esm/utils/object.js
function fill(source, name, replacementFactory) {
  if (!(name in source)) {
    return;
  }
  const original = source[name];
  if (typeof original !== "function") {
    return;
  }
  const wrapped = replacementFactory(original);
  if (typeof wrapped === "function") {
    markFunctionWrapped(wrapped, original);
  }
  try {
    source[name] = wrapped;
  } catch {
    DEBUG_BUILD && debug.log(`Failed to replace method "${name}" in object`, source);
  }
}
__name(fill, "fill");
function addNonEnumerableProperty(obj, name, value) {
  try {
    Object.defineProperty(obj, name, {
      // enumerable: false, // the default, so we can save on bundle size by not explicitly setting it
      value,
      writable: true,
      configurable: true
    });
  } catch {
    DEBUG_BUILD && debug.log(`Failed to add non-enumerable property "${String(name)}" to object`, obj);
  }
}
__name(addNonEnumerableProperty, "addNonEnumerableProperty");
function markFunctionWrapped(wrapped, original) {
  try {
    const proto = original.prototype || {};
    wrapped.prototype = original.prototype = proto;
    addNonEnumerableProperty(wrapped, "__sentry_original__", original);
  } catch {
  }
}
__name(markFunctionWrapped, "markFunctionWrapped");
function getOriginalFunction(func) {
  return func.__sentry_original__;
}
__name(getOriginalFunction, "getOriginalFunction");
function convertToPlainObject(value) {
  if (isError(value)) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
      ...getOwnProperties(value)
    };
  }
  if (isEvent(value)) {
    const { type, target, currentTarget, detail } = value;
    return {
      type,
      target,
      currentTarget,
      ...detail ? { detail } : {},
      ...getOwnProperties(value)
    };
  }
  return value;
}
__name(convertToPlainObject, "convertToPlainObject");
function getOwnProperties(obj) {
  if (isObjectLike(obj)) {
    return Object.fromEntries(Object.entries(obj));
  }
  return {};
}
__name(getOwnProperties, "getOwnProperties");
function extractExceptionKeysForMessage(exception) {
  const keys = Object.keys(convertToPlainObject(exception));
  keys.sort();
  return !keys[0] ? "[object has no keys]" : keys.join(", ");
}
__name(extractExceptionKeysForMessage, "extractExceptionKeysForMessage");

// node_modules/@sentry/core/build/esm/utils/randomSafeContext.js
init_modules_watch_stub();
var RESOLVED_RUNNER;
function withRandomSafeContext(cb) {
  if (RESOLVED_RUNNER !== void 0) {
    return RESOLVED_RUNNER ? RESOLVED_RUNNER(cb) : cb();
  }
  const sym = /* @__PURE__ */ Symbol.for("__SENTRY_SAFE_RANDOM_ID_WRAPPER__");
  const globalWithSymbol = GLOBAL_OBJ;
  if (sym in globalWithSymbol && typeof globalWithSymbol[sym] === "function") {
    RESOLVED_RUNNER = globalWithSymbol[sym];
    return RESOLVED_RUNNER(cb);
  }
  RESOLVED_RUNNER = null;
  return cb();
}
__name(withRandomSafeContext, "withRandomSafeContext");
function safeMathRandom() {
  return withRandomSafeContext(() => Math.random());
}
__name(safeMathRandom, "safeMathRandom");
function safeDateNow() {
  return withRandomSafeContext(() => Date.now());
}
__name(safeDateNow, "safeDateNow");

// node_modules/@sentry/core/build/esm/utils/string.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/normalize.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/normalizationHints.js
init_modules_watch_stub();
var SENTRY_SKIP_NORMALIZATION = /* @__PURE__ */ Symbol.for("sentry.skipNormalization");
var SENTRY_OVERRIDE_NORMALIZATION_DEPTH = /* @__PURE__ */ Symbol.for("sentry.overrideNormalizationDepth");
function hasSkipNormalizationHint(value) {
  return Boolean(value[SENTRY_SKIP_NORMALIZATION]);
}
__name(hasSkipNormalizationHint, "hasSkipNormalizationHint");
function getNormalizationDepthOverrideHint(value) {
  const v = value[SENTRY_OVERRIDE_NORMALIZATION_DEPTH];
  return typeof v === "number" ? v : void 0;
}
__name(getNormalizationDepthOverrideHint, "getNormalizationDepthOverrideHint");

// node_modules/@sentry/core/build/esm/utils/normalize.js
var stringifier;
function normalize(input, depth = 100, maxProperties = Infinity) {
  try {
    return visit("", input, depth, maxProperties);
  } catch (err) {
    return { ERROR: `**non-serializable** (${err})` };
  }
}
__name(normalize, "normalize");
function normalizeToSize(object, depth = 3, maxSize = 100 * 1024) {
  const normalized = normalize(object, depth);
  if (jsonSize(normalized) > maxSize) {
    return normalizeToSize(object, depth - 1, maxSize);
  }
  return normalized;
}
__name(normalizeToSize, "normalizeToSize");
function visit(key, value, depth = Infinity, maxProperties = Infinity, memo = memoBuilder()) {
  const [memoize, unmemoize] = memo;
  if (value == null || // this matches null and undefined -> eqeq not eqeqeq
  ["boolean", "string"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const stringified = stringifyValue(key, value);
  if (!stringified.startsWith("[object ")) {
    return stringified;
  }
  if (hasSkipNormalizationHint(value)) {
    return value;
  }
  const overrideDepth = getNormalizationDepthOverrideHint(value);
  const remainingDepth = overrideDepth !== void 0 ? overrideDepth : depth;
  if (remainingDepth === 0) {
    return stringified.replace("object ", "");
  }
  if (memoize(value)) {
    return "[Circular ~]";
  }
  const valueWithToJSON = value;
  if (valueWithToJSON && typeof valueWithToJSON.toJSON === "function") {
    try {
      const jsonValue = valueWithToJSON.toJSON();
      return visit("", jsonValue, remainingDepth - 1, maxProperties, memo);
    } catch {
    }
  }
  const normalized = Array.isArray(value) ? [] : {};
  let numAdded = 0;
  const visitable = convertToPlainObject(value);
  for (const visitKey in visitable) {
    if (!Object.prototype.hasOwnProperty.call(visitable, visitKey)) {
      continue;
    }
    if (numAdded >= maxProperties) {
      normalized[visitKey] = "[MaxProperties ~]";
      break;
    }
    const visitValue = visitable[visitKey];
    normalized[visitKey] = visit(visitKey, visitValue, remainingDepth - 1, maxProperties, memo);
    numAdded++;
  }
  unmemoize(value);
  return normalized;
}
__name(visit, "visit");
function stringifyValue(key, value) {
  try {
    if (stringifier) {
      const stringified = stringifier(value);
      if (stringified) {
        return stringified;
      }
    }
    if (typeof global !== "undefined" && value === global) {
      return "[Global]";
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return `[${value}]`;
    }
    if (typeof value === "function") {
      return `[Function: ${getFunctionName(value)}]`;
    }
    if (typeof value === "symbol") {
      return `[${String(value)}]`;
    }
    if (typeof value === "bigint") {
      return `[BigInt: ${String(value)}]`;
    }
    const objName = getConstructorName(value);
    return `[object ${objName}]`;
  } catch (err) {
    return `**non-serializable** (${err})`;
  }
}
__name(stringifyValue, "stringifyValue");
function getConstructorName(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype?.constructor ? prototype.constructor.name : "null prototype";
}
__name(getConstructorName, "getConstructorName");
function utf8Length(value) {
  return ~-encodeURI(value).split(/%..|./).length;
}
__name(utf8Length, "utf8Length");
function jsonSize(value) {
  return utf8Length(JSON.stringify(value));
}
__name(jsonSize, "jsonSize");
function memoBuilder() {
  const inner = /* @__PURE__ */ new WeakSet();
  function memoize(obj) {
    if (inner.has(obj)) {
      return true;
    }
    inner.add(obj);
    return false;
  }
  __name(memoize, "memoize");
  function unmemoize(obj) {
    inner.delete(obj);
  }
  __name(unmemoize, "unmemoize");
  return [memoize, unmemoize];
}
__name(memoBuilder, "memoBuilder");

// node_modules/@sentry/core/build/esm/utils/string.js
function stringify(value, fallback = "[unserializable]") {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return typeof fallback === "function" ? fallback(value) : fallback;
  }
}
__name(stringify, "stringify");
function truncate(str, max = 0) {
  if (typeof str !== "string" || max === 0) {
    return str;
  }
  return str.length <= max ? str : `${str.slice(0, max)}...`;
}
__name(truncate, "truncate");
function safeJoin(input, delimiter) {
  if (!Array.isArray(input)) {
    return "";
  }
  const output = [];
  for (let i = 0; i < input.length; i++) {
    const value = input[i];
    if (isPrimitive(value)) {
      output.push(String(value));
    } else if (value instanceof Error) {
      output.push(value.message ? `${value.name}: ${value.message}` : value.name);
    } else {
      output.push(stringifyValue(void 0, value));
    }
  }
  return output.join(delimiter);
}
__name(safeJoin, "safeJoin");
function isMatchingPattern(value, pattern, requireExactStringMatch = false) {
  if (!isString(value)) {
    return false;
  }
  if (isRegExp(pattern)) {
    return pattern.test(value);
  }
  if (isString(pattern)) {
    return requireExactStringMatch ? value === pattern : value.includes(pattern);
  }
  if (typeof pattern === "function") {
    return pattern(value);
  }
  return false;
}
__name(isMatchingPattern, "isMatchingPattern");
function stringMatchesSomePattern(testString, patterns = [], requireExactStringMatch = false) {
  for (const pattern of patterns) {
    if (isMatchingPattern(testString, pattern, requireExactStringMatch)) {
      return true;
    }
  }
  return false;
}
__name(stringMatchesSomePattern, "stringMatchesSomePattern");

// node_modules/@sentry/core/build/esm/utils/misc.js
function getCrypto() {
  const gbl = GLOBAL_OBJ;
  return gbl.crypto || gbl.msCrypto;
}
__name(getCrypto, "getCrypto");
var emptyUuid;
function getRandomByte() {
  return safeMathRandom() * 16;
}
__name(getRandomByte, "getRandomByte");
function uuid4(crypto2 = getCrypto()) {
  try {
    if (crypto2?.randomUUID) {
      return withRandomSafeContext(() => crypto2.randomUUID()).replace(/-/g, "");
    }
  } catch {
  }
  if (!emptyUuid) {
    emptyUuid = "10000000100040008000" + 1e11;
  }
  return emptyUuid.replace(
    /[018]/g,
    (c) => (
      // eslint-disable-next-line no-bitwise
      (c ^ (getRandomByte() & 15) >> c / 4).toString(16)
    )
  );
}
__name(uuid4, "uuid4");
function getFirstException(event) {
  return event.exception?.values?.[0];
}
__name(getFirstException, "getFirstException");
function getEventDescription(event) {
  const { message: message2, event_id: eventId } = event;
  if (message2) {
    return message2;
  }
  const firstException = getFirstException(event);
  if (firstException) {
    if (firstException.type && firstException.value) {
      return `${firstException.type}: ${firstException.value}`;
    }
    return firstException.type || firstException.value || eventId || "<unknown>";
  }
  return eventId || "<unknown>";
}
__name(getEventDescription, "getEventDescription");
function addExceptionTypeValue(event, value, type) {
  const exception = event.exception = event.exception || {};
  const values = exception.values = exception.values || [];
  const firstException = values[0] = values[0] || {};
  if (!firstException.value) {
    firstException.value = value || "";
  }
  if (!firstException.type) {
    firstException.type = type || "Error";
  }
}
__name(addExceptionTypeValue, "addExceptionTypeValue");
function addExceptionMechanism(event, newMechanism) {
  const firstException = getFirstException(event);
  if (!firstException) {
    return;
  }
  applyExceptionMechanism(firstException, newMechanism);
}
__name(addExceptionMechanism, "addExceptionMechanism");
function addExceptionMechanismToCapturedException(event, newMechanism) {
  const exceptions = event.exception?.values;
  const capturedException = exceptions?.find((exception) => exception.mechanism?.exception_id === 0) ?? exceptions?.[0];
  if (!capturedException) {
    return;
  }
  applyExceptionMechanism(capturedException, newMechanism);
}
__name(addExceptionMechanismToCapturedException, "addExceptionMechanismToCapturedException");
function applyExceptionMechanism(exception, newMechanism) {
  const defaultMechanism = { type: "generic", handled: true };
  const currentMechanism = exception.mechanism;
  exception.mechanism = { ...defaultMechanism, ...currentMechanism, ...newMechanism };
  if (newMechanism && "data" in newMechanism) {
    exception.mechanism.data = { ...currentMechanism?.data, ...newMechanism.data };
  }
}
__name(applyExceptionMechanism, "applyExceptionMechanism");
function checkOrSetAlreadyCaught(exception) {
  if (isAlreadyCaptured(exception)) {
    return true;
  }
  try {
    addNonEnumerableProperty(exception, "__sentry_captured__", true);
  } catch {
  }
  return false;
}
__name(checkOrSetAlreadyCaught, "checkOrSetAlreadyCaught");
function isAlreadyCaptured(exception) {
  try {
    return exception.__sentry_captured__;
  } catch {
  }
}
__name(isAlreadyCaptured, "isAlreadyCaptured");

// node_modules/@sentry/core/build/esm/utils/time.js
init_modules_watch_stub();
var ONE_SECOND_IN_MS = 1e3;
var CLOCK_DRIFT_THRESHOLD_MS = 1e3;
var MAX_TIME_ORIGIN_SEGMENTS = 100;
function dateTimestampInSeconds() {
  return safeDateNow() / ONE_SECOND_IN_MS;
}
__name(dateTimestampInSeconds, "dateTimestampInSeconds");
var _timeOriginSegments = [];
function createUnixTimestampInSecondsFunc() {
  const { performance } = GLOBAL_OBJ;
  if (!performance?.now || !performance.timeOrigin) {
    if (performance?.now) {
      _timeOriginSegments = [{ from: 0, origin: safeDateNow() - withRandomSafeContext(() => performance.now()) }];
    }
    return dateTimestampInSeconds;
  }
  let correctedTimeOrigin = performance.timeOrigin;
  _timeOriginSegments = [{ from: 0, origin: correctedTimeOrigin }];
  let isFirstCall = true;
  let lastCheckedPerformanceNow = 0;
  return () => {
    return withRandomSafeContext(() => {
      const performanceNow = performance.now();
      const dateNow = Date.now();
      if (Math.abs(correctedTimeOrigin + performanceNow - dateNow) > CLOCK_DRIFT_THRESHOLD_MS) {
        correctedTimeOrigin = dateNow - performanceNow;
        if (isFirstCall) {
          _timeOriginSegments = [{ from: 0, origin: correctedTimeOrigin }];
        } else {
          _timeOriginSegments.push({ from: lastCheckedPerformanceNow, origin: correctedTimeOrigin });
          if (_timeOriginSegments.length > MAX_TIME_ORIGIN_SEGMENTS) {
            _timeOriginSegments.splice(1, 1);
          }
        }
      }
      isFirstCall = false;
      lastCheckedPerformanceNow = performanceNow;
      return (correctedTimeOrigin + performanceNow) / ONE_SECOND_IN_MS;
    });
  };
}
__name(createUnixTimestampInSecondsFunc, "createUnixTimestampInSecondsFunc");
function safePerformanceNow() {
  const { performance } = GLOBAL_OBJ;
  return performance?.now ? withRandomSafeContext(() => performance.now()) : void 0;
}
__name(safePerformanceNow, "safePerformanceNow");
var _cachedTimestampInSecondsFn;
function timestampInSeconds() {
  const func = _cachedTimestampInSecondsFn ?? (_cachedTimestampInSecondsFn = createUnixTimestampInSecondsFunc());
  return func();
}
__name(timestampInSeconds, "timestampInSeconds");

// node_modules/@sentry/core/build/esm/session.js
function updateSession(session, context2 = {}) {
  if (context2.user) {
    if (!session.ipAddress && context2.user.ip_address) {
      session.ipAddress = context2.user.ip_address;
    }
    if (!session.did && !context2.did) {
      session.did = context2.user.id || context2.user.email || context2.user.username;
    }
  }
  session.timestamp = context2.timestamp || timestampInSeconds();
  if (context2.abnormal_mechanism) {
    session.abnormal_mechanism = context2.abnormal_mechanism;
  }
  if (context2.ignoreDuration) {
    session.ignoreDuration = context2.ignoreDuration;
  }
  if (context2.sid) {
    session.sid = context2.sid.length === 32 ? context2.sid : uuid4();
  }
  if (context2.init !== void 0) {
    session.init = context2.init;
  }
  if (!session.did && context2.did) {
    session.did = `${context2.did}`;
  }
  if (typeof context2.started === "number") {
    session.started = context2.started;
  }
  if (session.ignoreDuration) {
    session.duration = void 0;
  } else if (typeof context2.duration === "number") {
    session.duration = context2.duration;
  } else {
    const duration = session.timestamp - session.started;
    session.duration = duration >= 0 ? duration : 0;
  }
  if (context2.release) {
    session.release = context2.release;
  }
  if (context2.environment) {
    session.environment = context2.environment;
  }
  if (!session.ipAddress && context2.ipAddress) {
    session.ipAddress = context2.ipAddress;
  }
  if (!session.userAgent && context2.userAgent) {
    session.userAgent = context2.userAgent;
  }
  if (typeof context2.errors === "number") {
    session.errors = context2.errors;
  }
  if (context2.status) {
    session.status = context2.status;
  }
}
__name(updateSession, "updateSession");

// node_modules/@sentry/core/build/esm/utils/merge.js
init_modules_watch_stub();
function merge(initialObj, mergeObj, levels = 2) {
  if (!mergeObj || typeof mergeObj !== "object" || levels <= 0) {
    return mergeObj;
  }
  if (initialObj && Object.keys(mergeObj).length === 0) {
    return initialObj;
  }
  const output = { ...initialObj };
  for (const key in mergeObj) {
    if (Object.prototype.hasOwnProperty.call(mergeObj, key)) {
      output[key] = merge(output[key], mergeObj[key], levels - 1);
    }
  }
  return output;
}
__name(merge, "merge");

// node_modules/@sentry/core/build/esm/utils/propagationContext.js
init_modules_watch_stub();
function generateTraceId() {
  return uuid4();
}
__name(generateTraceId, "generateTraceId");
function generateSpanId() {
  return uuid4().substring(16);
}
__name(generateSpanId, "generateSpanId");

// node_modules/@sentry/core/build/esm/scope.js
var DEFAULT_MAX_BREADCRUMBS = 100;
var Scope = class _Scope {
  static {
    __name(this, "Scope");
  }
  // NOTE: Any field which gets added here should get added not only to the constructor but also to the `clone` method.
  constructor() {
    this._notifyingListeners = false;
    this._scopeListeners = [];
    this._eventProcessors = [];
    this._breadcrumbs = [];
    this._attachments = [];
    this._user = {};
    this._tags = {};
    this._attributes = {};
    this._extra = {};
    this._contexts = {};
    this._sdkProcessingMetadata = {};
    addNonEnumerableProperty(this, "refs", {});
    this._propagationContext = {
      traceId: generateTraceId(),
      sampleRand: safeMathRandom()
    };
  }
  /**
   * Clone all data from this scope into a new scope.
   */
  clone() {
    const newScope = new _Scope();
    newScope._breadcrumbs = [...this._breadcrumbs];
    newScope._tags = { ...this._tags };
    newScope._attributes = { ...this._attributes };
    newScope._extra = { ...this._extra };
    newScope._contexts = { ...this._contexts };
    if (this._contexts.flags) {
      newScope._contexts.flags = {
        values: [...this._contexts.flags.values]
      };
    }
    newScope._user = this._user;
    newScope._level = this._level;
    newScope._session = this._session;
    newScope._transactionName = this._transactionName;
    newScope._fingerprint = this._fingerprint;
    newScope._eventProcessors = [...this._eventProcessors];
    newScope._attachments = [...this._attachments];
    newScope._sdkProcessingMetadata = { ...this._sdkProcessingMetadata };
    newScope._propagationContext = { ...this._propagationContext };
    newScope._client = this._client;
    newScope._lastEventId = this._lastEventId;
    newScope._conversationId = this._conversationId;
    newScope.refs = { ...this.refs };
    return newScope;
  }
  /**
   * Update the client assigned to this scope.
   * Note that not every scope will have a client assigned - isolation scopes & the global scope will generally not have a client,
   * as well as manually created scopes.
   */
  setClient(client) {
    this._client = client;
  }
  /**
   * Set the ID of the last captured error event.
   * This is generally only captured on the isolation scope.
   */
  setLastEventId(lastEventId2) {
    this._lastEventId = lastEventId2;
  }
  /**
   * Get the client assigned to this scope.
   */
  getClient() {
    return this._client;
  }
  /**
   * Get the ID of the last captured error event.
   * This is generally only available on the isolation scope.
   */
  lastEventId() {
    return this._lastEventId;
  }
  /**
   * @inheritDoc
   */
  addScopeListener(callback) {
    this._scopeListeners.push(callback);
  }
  /**
   * Add an event processor that will be called before an event is sent.
   */
  addEventProcessor(callback) {
    this._eventProcessors.push(callback);
    return this;
  }
  /**
   * Set the user for this scope.
   * Set to `null` to unset the user.
   */
  setUser(user) {
    this._user = user || {
      email: void 0,
      id: void 0,
      ip_address: void 0,
      username: void 0
    };
    if (this._session) {
      updateSession(this._session, { user });
    }
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Get the user from this scope.
   */
  getUser() {
    return this._user;
  }
  /**
   * Set the conversation ID for this scope.
   * Set to `null` to unset the conversation ID.
   */
  setConversationId(conversationId) {
    this._conversationId = conversationId || void 0;
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Set an object that will be merged into existing tags on the scope,
   * and will be sent as tags data with the event.
   */
  setTags(tags) {
    this._tags = {
      ...this._tags,
      ...tags
    };
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Set a single tag that will be sent as tags data with the event.
   */
  setTag(key, value) {
    return this.setTags({ [key]: value });
  }
  /**
   * Sets attributes onto the scope.
   *
   * These attributes are applied to logs, metrics and streamed spans.
   *
   * Supported attribute value types are `string`, `number`, `boolean`, `string[]`, `number[]` and `boolean[]`.
   *
   * @param newAttributes - The attributes to set on the scope, as key-value pairs.
   *
   * @example
   * ```typescript
   * scope.setAttributes({
   *   is_admin: true,
   *   payment_selection: 'credit_card',
   *   render_duration: 150,
   * });
   * ```
   */
  setAttributes(newAttributes) {
    this._attributes = {
      ...this._attributes,
      ...newAttributes
    };
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Sets an attribute onto the scope.
   *
   * These attributes are applied to logs, metrics and streamed spans.
   *
   * Supported attribute value types are `string`, `number`, `boolean`, `string[]`, `number[]` and `boolean[]`.
   *
   * @param key - The attribute key.
   * @param value - The attribute value.
   *
   * @example
   * ```typescript
   * scope.setAttribute('is_admin', true);
   * scope.setAttribute('render_duration', 150);
   * ```
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setAttribute(key, value) {
    return this.setAttributes({ [key]: value });
  }
  /**
   * Removes the attribute with the given key from the scope.
   *
   * @param key - The attribute key.
   *
   * @example
   * ```typescript
   * scope.removeAttribute('is_admin');
   * ```
   */
  removeAttribute(key) {
    if (key in this._attributes) {
      delete this._attributes[key];
      this._notifyScopeListeners();
    }
    return this;
  }
  /**
   * Set an object that will be merged into existing extra on the scope,
   * and will be sent as extra data with the event.
   */
  setExtras(extras) {
    this._extra = {
      ...this._extra,
      ...extras
    };
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Set a single key:value extra entry that will be sent as extra data with the event.
   */
  setExtra(key, extra) {
    this._extra = { ...this._extra, [key]: extra };
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Sets the fingerprint on the scope to send with the events.
   * @param {string[]} fingerprint Fingerprint to group events in Sentry.
   */
  setFingerprint(fingerprint) {
    this._fingerprint = fingerprint;
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Sets the level on the scope for future events.
   */
  setLevel(level) {
    this._level = level;
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Sets the transaction name on the scope so that the name of e.g. taken server route or
   * the page location is attached to future events.
   *
   * IMPORTANT: Calling this function does NOT change the name of the currently active
   * root span. If you want to change the name of the active root span, use
   * `Sentry.updateSpanName(rootSpan, 'new name')` instead.
   *
   * By default, the SDK updates the scope's transaction name automatically on sensible
   * occasions, such as a page navigation or when handling a new request on the server.
   */
  setTransactionName(name) {
    this._transactionName = name;
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Sets context data with the given name.
   * Data passed as context will be normalized. You can also pass `null` to unset the context.
   * Note that context data will not be merged - calling `setContext` will overwrite an existing context with the same key.
   */
  setContext(key, context2) {
    if (context2 === null) {
      delete this._contexts[key];
    } else {
      this._contexts[key] = context2;
    }
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Set the session for the scope.
   */
  setSession(session) {
    if (!session) {
      delete this._session;
    } else {
      this._session = session;
    }
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Get the session from the scope.
   */
  getSession() {
    return this._session;
  }
  /**
   * Updates the scope with provided data. Can work in three variations:
   * - plain object containing updatable attributes
   * - Scope instance that'll extract the attributes from
   * - callback function that'll receive the current scope as an argument and allow for modifications
   */
  update(captureContext) {
    if (!captureContext) {
      return this;
    }
    const scopeToMerge = typeof captureContext === "function" ? captureContext(this) : captureContext;
    const scopeInstance = scopeToMerge instanceof _Scope ? scopeToMerge.getScopeData() : isPlainObject(scopeToMerge) ? captureContext : void 0;
    const {
      tags,
      attributes,
      extra,
      user,
      contexts,
      level,
      fingerprint = [],
      propagationContext,
      conversationId
    } = scopeInstance || {};
    this._tags = { ...this._tags, ...tags };
    this._attributes = { ...this._attributes, ...attributes };
    this._extra = { ...this._extra, ...extra };
    this._contexts = { ...this._contexts, ...contexts };
    if (user && Object.keys(user).length) {
      this._user = user;
    }
    if (level) {
      this._level = level;
    }
    if (fingerprint.length) {
      this._fingerprint = fingerprint;
    }
    if (propagationContext) {
      this._propagationContext = propagationContext;
    }
    if (conversationId) {
      this._conversationId = conversationId;
    }
    return this;
  }
  /**
   * Adds a breadcrumb to the scope.
   * By default, the last 100 breadcrumbs are kept.
   */
  addBreadcrumb(breadcrumb, maxBreadcrumbs) {
    const maxCrumbs = typeof maxBreadcrumbs === "number" ? maxBreadcrumbs : DEFAULT_MAX_BREADCRUMBS;
    if (maxCrumbs <= 0) {
      return this;
    }
    const mergedBreadcrumb = {
      timestamp: dateTimestampInSeconds(),
      ...breadcrumb,
      // Breadcrumb messages can theoretically be infinitely large and they're held in memory so we truncate them not to leak (too much) memory
      message: breadcrumb.message ? truncate(breadcrumb.message, 2048) : breadcrumb.message
    };
    this._breadcrumbs.push(mergedBreadcrumb);
    if (this._breadcrumbs.length > maxCrumbs) {
      this._breadcrumbs = this._breadcrumbs.slice(-maxCrumbs);
    }
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Get the last breadcrumb of the scope.
   */
  getLastBreadcrumb() {
    return this._breadcrumbs[this._breadcrumbs.length - 1];
  }
  /**
   * Clear all breadcrumbs from the scope.
   */
  clearBreadcrumbs() {
    this._breadcrumbs = [];
    this._notifyScopeListeners();
    return this;
  }
  /**
   * Add an attachment to the scope.
   */
  addAttachment(attachment) {
    this._attachments.push(attachment);
    return this;
  }
  /**
   * Clear all attachments from the scope.
   */
  clearAttachments() {
    this._attachments = [];
    return this;
  }
  /**
   * Get the data of this scope, which should be applied to an event during processing.
   */
  getScopeData() {
    return {
      breadcrumbs: this._breadcrumbs,
      attachments: this._attachments,
      contexts: this._contexts,
      tags: this._tags,
      attributes: this._attributes,
      extra: this._extra,
      user: this._user,
      level: this._level,
      fingerprint: this._fingerprint || [],
      eventProcessors: this._eventProcessors,
      propagationContext: this._propagationContext,
      sdkProcessingMetadata: this._sdkProcessingMetadata,
      transactionName: this._transactionName,
      conversationId: this._conversationId
    };
  }
  /**
   * Add data which will be accessible during event processing but won't get sent to Sentry.
   */
  setSDKProcessingMetadata(newData) {
    this._sdkProcessingMetadata = merge(this._sdkProcessingMetadata, newData, 2);
    return this;
  }
  /**
   * Add propagation context to the scope, used for distributed tracing
   */
  setPropagationContext(context2) {
    this._propagationContext = context2;
    return this;
  }
  /**
   * Get propagation context from the scope, used for distributed tracing
   */
  getPropagationContext() {
    return this._propagationContext;
  }
  /**
   * Capture an exception for this scope.
   *
   * @returns {string} The id of the captured Sentry event.
   */
  captureException(exception, hint) {
    const eventId = hint?.event_id || uuid4();
    if (!this._client) {
      DEBUG_BUILD && debug.warn("No client configured on scope - will not capture exception!");
      return eventId;
    }
    const syntheticException = new Error("Sentry syntheticException");
    this._client.captureException(
      exception,
      {
        originalException: exception,
        syntheticException,
        ...hint,
        event_id: eventId
      },
      this
    );
    return eventId;
  }
  /**
   * Capture a message for this scope.
   *
   * @returns {string} The id of the captured message.
   */
  captureMessage(message2, level, hint) {
    const eventId = hint?.event_id || uuid4();
    if (!this._client) {
      DEBUG_BUILD && debug.warn("No client configured on scope - will not capture message!");
      return eventId;
    }
    const syntheticException = hint?.syntheticException ?? new Error(message2);
    this._client.captureMessage(
      message2,
      level,
      {
        originalException: message2,
        syntheticException,
        ...hint,
        event_id: eventId
      },
      this
    );
    return eventId;
  }
  /**
   * Capture a Sentry event for this scope.
   *
   * @returns {string} The id of the captured event.
   */
  captureEvent(event, hint) {
    const eventId = event.event_id || hint?.event_id || uuid4();
    if (!this._client) {
      DEBUG_BUILD && debug.warn("No client configured on scope - will not capture event!");
      return eventId;
    }
    this._client.captureEvent(event, { ...hint, event_id: eventId }, this);
    return eventId;
  }
  /**
   * This will be called on every set call.
   */
  _notifyScopeListeners() {
    if (!this._notifyingListeners) {
      this._notifyingListeners = true;
      this._scopeListeners.forEach((callback) => {
        callback(this);
      });
      this._notifyingListeners = false;
    }
  }
};

// node_modules/@sentry/core/build/esm/defaultScopes.js
function getDefaultCurrentScope() {
  return getGlobalSingleton("defaultCurrentScope", () => new Scope());
}
__name(getDefaultCurrentScope, "getDefaultCurrentScope");
function getDefaultIsolationScope() {
  return getGlobalSingleton("defaultIsolationScope", () => new Scope());
}
__name(getDefaultIsolationScope, "getDefaultIsolationScope");

// node_modules/@sentry/core/build/esm/tracing/constants.js
init_modules_watch_stub();
var SUPPRESS_TRACING_KEY = "__SENTRY_SUPPRESS_TRACING__";

// node_modules/@sentry/core/build/esm/utils/chain-and-copy-promiselike.js
init_modules_watch_stub();
var isActualPromise = /* @__PURE__ */ __name((p2) => p2 instanceof Promise && !p2[kChainedCopy], "isActualPromise");
var kChainedCopy = /* @__PURE__ */ Symbol("chained PromiseLike");
var chainAndCopyPromiseLike = /* @__PURE__ */ __name((original, onSuccess, onError) => {
  const chained = original.then(
    (value) => {
      onSuccess(value);
      return value;
    },
    (err) => {
      onError(err);
      throw err;
    }
  );
  return isActualPromise(chained) && isActualPromise(original) ? chained : copyProps(original, chained);
}, "chainAndCopyPromiseLike");
var copyProps = /* @__PURE__ */ __name((original, chained) => {
  if (!chained) return original;
  let mutated = false;
  for (const key in original) {
    if (key in chained) continue;
    mutated = true;
    const value = original[key];
    if (typeof value === "function") {
      Object.defineProperty(chained, key, {
        value: /* @__PURE__ */ __name((...args) => value.apply(original, args), "value"),
        enumerable: true,
        configurable: true,
        writable: true
      });
    } else {
      chained[key] = value;
    }
  }
  if (mutated) Object.assign(chained, { [kChainedCopy]: true });
  return chained;
}, "copyProps");

// node_modules/@sentry/core/build/esm/asyncContext/stackStrategy.js
var AsyncContextStack = class {
  static {
    __name(this, "AsyncContextStack");
  }
  constructor(scope, isolationScope) {
    let assignedScope;
    if (!scope) {
      assignedScope = new Scope();
    } else {
      assignedScope = scope;
    }
    let assignedIsolationScope;
    if (!isolationScope) {
      assignedIsolationScope = new Scope();
    } else {
      assignedIsolationScope = isolationScope;
    }
    this._stack = [{ scope: assignedScope }];
    this._isolationScope = assignedIsolationScope;
  }
  /**
   * Fork a scope for the stack.
   */
  withScope(callback) {
    const scope = this._pushScope();
    let maybePromiseResult;
    try {
      maybePromiseResult = callback(scope);
    } catch (e) {
      this._popScope();
      throw e;
    }
    if (isThenable(maybePromiseResult)) {
      return chainAndCopyPromiseLike(
        maybePromiseResult,
        () => this._popScope(),
        () => this._popScope()
      );
    }
    this._popScope();
    return maybePromiseResult;
  }
  /**
   * Get the client of the stack.
   */
  getClient() {
    return this.getStackTop().client;
  }
  /**
   * Returns the scope of the top stack.
   */
  getScope() {
    return this.getStackTop().scope;
  }
  /**
   * Get the isolation scope for the stack.
   */
  getIsolationScope() {
    return this._isolationScope;
  }
  /**
   * Returns the topmost scope layer in the order domain > local > process.
   */
  getStackTop() {
    return this._stack[this._stack.length - 1];
  }
  /**
   * Push a scope to the stack.
   */
  _pushScope() {
    const scope = this.getScope().clone();
    this._stack.push({
      client: this.getClient(),
      scope
    });
    return scope;
  }
  /**
   * Pop a scope from the stack.
   */
  _popScope() {
    if (this._stack.length <= 1) return false;
    return !!this._stack.pop();
  }
};
function getAsyncContextStack() {
  const registry = getMainCarrier();
  const sentry = getSentryCarrier(registry);
  return sentry.stack = sentry.stack || new AsyncContextStack(getDefaultCurrentScope(), getDefaultIsolationScope());
}
__name(getAsyncContextStack, "getAsyncContextStack");
function withScope(callback) {
  return getAsyncContextStack().withScope(callback);
}
__name(withScope, "withScope");
function withSetScope(scope, callback) {
  const stack = getAsyncContextStack();
  return stack.withScope(() => {
    stack.getStackTop().scope = scope;
    return callback(scope);
  });
}
__name(withSetScope, "withSetScope");
function withIsolationScope(callback) {
  return getAsyncContextStack().withScope(() => {
    return callback(getAsyncContextStack().getIsolationScope());
  });
}
__name(withIsolationScope, "withIsolationScope");
function getStackAsyncContextStrategy() {
  return {
    suppressTracing: suppressTracingInStack,
    withIsolationScope,
    withScope,
    withSetScope,
    withSetIsolationScope: /* @__PURE__ */ __name((_isolationScope, callback) => {
      return withIsolationScope(callback);
    }, "withSetIsolationScope"),
    getCurrentScope: /* @__PURE__ */ __name(() => getAsyncContextStack().getScope(), "getCurrentScope"),
    getIsolationScope: /* @__PURE__ */ __name(() => getAsyncContextStack().getIsolationScope(), "getIsolationScope")
  };
}
__name(getStackAsyncContextStrategy, "getStackAsyncContextStrategy");
function suppressTracingInStack(callback) {
  return withScope((scope) => {
    scope.setSDKProcessingMetadata({ [SUPPRESS_TRACING_KEY]: true });
    const res = callback();
    scope.setSDKProcessingMetadata({ [SUPPRESS_TRACING_KEY]: void 0 });
    return res;
  });
}
__name(suppressTracingInStack, "suppressTracingInStack");

// node_modules/@sentry/core/build/esm/asyncContext/index.js
function setAsyncContextStrategy(strategy) {
  const registry = getMainCarrier();
  const sentry = getSentryCarrier(registry);
  sentry.acs = strategy;
}
__name(setAsyncContextStrategy, "setAsyncContextStrategy");
function getAsyncContextStrategy(carrier) {
  const sentry = getSentryCarrier(carrier);
  if (sentry.acs) {
    return sentry.acs;
  }
  return getStackAsyncContextStrategy();
}
__name(getAsyncContextStrategy, "getAsyncContextStrategy");

// node_modules/@sentry/core/build/esm/attributes.js
init_modules_watch_stub();
function isAttributeObject(maybeObj) {
  return typeof maybeObj === "object" && maybeObj != null && !Array.isArray(maybeObj) && Object.keys(maybeObj).includes("value");
}
__name(isAttributeObject, "isAttributeObject");
function attributeValueToTypedAttributeValue(rawValue, useFallback) {
  const { value, unit } = isAttributeObject(rawValue) ? rawValue : { value: rawValue, unit: void 0 };
  const attributeValue = getTypedAttributeValue(value);
  const checkedUnit = unit && typeof unit === "string" ? { unit } : {};
  if (attributeValue) {
    return { ...attributeValue, ...checkedUnit };
  }
  if (!useFallback || useFallback === "skip-undefined" && value === void 0) {
    return;
  }
  let stringValue = "";
  try {
    stringValue = JSON.stringify(value) ?? "";
  } catch {
  }
  return {
    value: stringValue,
    type: "string",
    ...checkedUnit
  };
}
__name(attributeValueToTypedAttributeValue, "attributeValueToTypedAttributeValue");
function serializeAttributes(attributes, fallback = false) {
  const serializedAttributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const typedValue = attributeValueToTypedAttributeValue(value, fallback);
    if (typedValue) {
      serializedAttributes[key] = typedValue;
    }
  }
  return serializedAttributes;
}
__name(serializeAttributes, "serializeAttributes");
function estimateTypedAttributesSizeInBytes(attributes) {
  if (!attributes) {
    return 0;
  }
  let weight = 0;
  for (const [key, attr] of Object.entries(attributes)) {
    weight += key.length * 2;
    weight += attr.type.length * 2;
    weight += (attr.unit?.length ?? 0) * 2;
    const val = attr.value;
    if (Array.isArray(val)) {
      weight += estimatePrimitiveSizeInBytes(val[0]) * val.length;
    } else if (isPrimitive(val)) {
      weight += estimatePrimitiveSizeInBytes(val);
    } else {
      weight += 100;
    }
  }
  return weight;
}
__name(estimateTypedAttributesSizeInBytes, "estimateTypedAttributesSizeInBytes");
function estimatePrimitiveSizeInBytes(value) {
  if (typeof value === "string") {
    return value.length * 2;
  } else if (typeof value === "boolean") {
    return 4;
  } else if (typeof value === "number") {
    return 8;
  }
  return 0;
}
__name(estimatePrimitiveSizeInBytes, "estimatePrimitiveSizeInBytes");
function getTypedAttributeValue(value) {
  if (Array.isArray(value)) {
    return { value, type: "array" };
  }
  const primitiveType = typeof value === "string" ? "string" : typeof value === "boolean" ? "boolean" : typeof value === "number" && !Number.isNaN(value) ? Number.isInteger(value) ? "integer" : "double" : null;
  if (primitiveType) {
    return { value, type: primitiveType };
  }
}
__name(getTypedAttributeValue, "getTypedAttributeValue");

// node_modules/@sentry/core/build/esm/currentScopes.js
init_modules_watch_stub();
function getExternalPropagationContext() {
  return getSentryCarrier(getMainCarrier()).externalPropagationContextProvider?.();
}
__name(getExternalPropagationContext, "getExternalPropagationContext");
function hasExternalPropagationContext() {
  return getSentryCarrier(getMainCarrier()).externalPropagationContextProvider !== void 0;
}
__name(hasExternalPropagationContext, "hasExternalPropagationContext");
function getCurrentScope() {
  const carrier = getMainCarrier();
  const acs = getAsyncContextStrategy(carrier);
  return acs.getCurrentScope();
}
__name(getCurrentScope, "getCurrentScope");
function getIsolationScope() {
  const carrier = getMainCarrier();
  const acs = getAsyncContextStrategy(carrier);
  return acs.getIsolationScope();
}
__name(getIsolationScope, "getIsolationScope");
function getGlobalScope() {
  return getGlobalSingleton("globalScope", () => new Scope());
}
__name(getGlobalScope, "getGlobalScope");
function withScope2(...rest) {
  const carrier = getMainCarrier();
  const acs = getAsyncContextStrategy(carrier);
  if (rest.length === 2) {
    const [scope, callback] = rest;
    if (!scope) {
      return acs.withScope(callback);
    }
    return acs.withSetScope(scope, callback);
  }
  return acs.withScope(rest[0]);
}
__name(withScope2, "withScope");
function withIsolationScope2(...rest) {
  const carrier = getMainCarrier();
  const acs = getAsyncContextStrategy(carrier);
  if (rest.length === 2) {
    const [isolationScope, callback] = rest;
    if (!isolationScope) {
      return acs.withIsolationScope(callback);
    }
    return acs.withSetIsolationScope(isolationScope, callback);
  }
  return acs.withIsolationScope(rest[0]);
}
__name(withIsolationScope2, "withIsolationScope");
function getClient() {
  return getCurrentScope().getClient();
}
__name(getClient, "getClient");
function getTraceContextFromScope(scope) {
  const externalContext = getExternalPropagationContext();
  if (externalContext) {
    return { trace_id: externalContext.traceId, span_id: externalContext.spanId };
  }
  const propagationContext = scope.getPropagationContext();
  const { traceId, parentSpanId, propagationSpanId } = propagationContext;
  const traceContext = {
    trace_id: traceId,
    span_id: propagationSpanId || generateSpanId()
  };
  if (parentSpanId) {
    traceContext.parent_span_id = parentSpanId;
  }
  return traceContext;
}
__name(getTraceContextFromScope, "getTraceContextFromScope");

// node_modules/@sentry/conventions/dist/attributes.mjs
init_modules_watch_stub();
var Ui = "cloudflare.r2.bucket";
var Gi = "cloudflare.r2.operation";
var zi = "cloudflare.r2.request.delimiter";
var Yi = "cloudflare.r2.request.key";
var Vi = "cloudflare.r2.request.part_number";
var Fi = "cloudflare.r2.request.prefix";
var la = "code.function.name";
var Ys = "faas.cron";
var Zs = "faas.time";
var $s = "faas.trigger";
var wr = "gen_ai.conversation.id";
var Lr = "gen_ai.embeddings.input";
var Mr = "gen_ai.input.messages";
var Fr = "gen_ai.operation.name";
var Br = "gen_ai.output.messages";
var Xr = "gen_ai.provider.name";
var $r = "gen_ai.request.frequency_penalty";
var en = "gen_ai.request.max_tokens";
var an = "gen_ai.request.model";
var sn = "gen_ai.request.presence_penalty";
var pn = "gen_ai.request.temperature";
var cn = "gen_ai.request.top_k";
var un = "gen_ai.request.top_p";
var mn = "gen_ai.response.finish_reasons";
var gn = "gen_ai.response.id";
var bn = "gen_ai.response.model";
var _n = "gen_ai.response.streaming";
var hn = "gen_ai.response.text";
var Tn = "gen_ai.response.tool_calls";
var En = "gen_ai.system_instructions";
var Ln = "gen_ai.usage.cache_creation.input_tokens";
var Mn = "gen_ai.usage.cache_read.input_tokens";
var zn = "gen_ai.usage.input_tokens";
var Fn = "gen_ai.usage.output_tokens";
var Wn = "gen_ai.usage.reasoning.output_tokens";
var Hn = "gen_ai.usage.total_tokens";
var Do = "http.request.method";
var Ho = "http.response.body.size";
var al = "http.route";
var Pc = "network.protocol.name";
var Dc = "network.protocol.version";
var Id = "sentry.description";
var Md = "sentry.environment";
var Vd = "sentry.exclusive_time";
var Jd = "sentry.is_localhost";
var Zd = "sentry.kind";
var $d = "sentry.link.type";
var mm = "sentry.op";
var gm = "sentry.origin";
var hm = "sentry.profile_id";
var km = "sentry.release";
var Om = "sentry.sdk.integrations";
var Im = "sentry.sdk.name";
var Am = "sentry.sdk.version";
var wm = "sentry.segment.id";
var Rm = "sentry.segment.name";
var Nm = "sentry.segment.name.source";
var Mm = "sentry.status.message";
var Fm = "sentry.trace_lifecycle";
var tg = "server.address";
var ag = "server.port";
var eb = "url.domain";
var tb = "url.fragment";
var ib = "url.full";
var ab = "url.path";
var lb = "url.port";
var pb = "url.query";
var ub = "url.scheme";
var db = "url.template";
var gb = "user.email";
var kb = "user.id";
var Tb = "user.ip_address";
var Sb = "user.name";

// node_modules/@sentry/core/build/esm/semanticAttributes.js
init_modules_watch_stub();
var SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE = "sentry.sample_rate";
var SEMANTIC_ATTRIBUTE_SENTRY_PREVIOUS_TRACE_SAMPLE_RATE = "sentry.previous_trace_sample_rate";
var SEMANTIC_ATTRIBUTE_SENTRY_MEASUREMENT_UNIT = "sentry.measurement_unit";
var SEMANTIC_ATTRIBUTE_SENTRY_MEASUREMENT_VALUE = "sentry.measurement_value";
var SEMANTIC_ATTRIBUTE_SENTRY_CUSTOM_SPAN_NAME = "sentry.custom_span_name";

// node_modules/@sentry/core/build/esm/tracing/spanstatus.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/types/spanStatus.js
init_modules_watch_stub();
var SPAN_STATUS_TYPES = [
  /** The operation completed successfully. */
  "ok",
  /** Deadline expired before operation could complete. */
  "deadline_exceeded",
  /** 401 Unauthorized (actually does mean unauthenticated according to RFC 7235) */
  "unauthenticated",
  /** 403 Forbidden */
  "permission_denied",
  /** 404 Not Found. Some requested entity (file or directory) was not found. */
  "not_found",
  /** 429 Too Many Requests */
  "resource_exhausted",
  /** Client specified an invalid argument. 4xx. */
  "invalid_argument",
  /** 501 Not Implemented */
  "unimplemented",
  /** 503 Service Unavailable */
  "unavailable",
  /** Other/generic 5xx. */
  "internal_error",
  /** Unknown. Any non-standard HTTP status code. */
  "unknown_error",
  /** The operation was cancelled (typically by the user). */
  "cancelled",
  /** Already exists (409) */
  "already_exists",
  /** Operation was rejected because the system is not in a state required for the operation's */
  "failed_precondition",
  /** The operation was aborted, typically due to a concurrency issue. */
  "aborted",
  /** Operation was attempted past the valid range. */
  "out_of_range",
  /** Unrecoverable data loss or corruption */
  "data_loss"
];

// node_modules/@sentry/core/build/esm/tracing/spanstatus.js
var SPAN_STATUS_UNSET = 0;
var SPAN_STATUS_OK = 1;
var SPAN_STATUS_ERROR = 2;
function isStatusErrorMessageValid(message2) {
  return message2 !== "ok" && SPAN_STATUS_TYPES.includes(message2);
}
__name(isStatusErrorMessageValid, "isStatusErrorMessageValid");
function getSpanStatusFromHttpCode(httpStatus) {
  if (httpStatus < 400 && httpStatus >= 100) {
    return { code: SPAN_STATUS_OK };
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    switch (httpStatus) {
      case 401:
        return { code: SPAN_STATUS_ERROR, message: "unauthenticated" };
      case 403:
        return { code: SPAN_STATUS_ERROR, message: "permission_denied" };
      case 404:
        return { code: SPAN_STATUS_ERROR, message: "not_found" };
      case 409:
        return { code: SPAN_STATUS_ERROR, message: "already_exists" };
      case 413:
        return { code: SPAN_STATUS_ERROR, message: "failed_precondition" };
      case 429:
        return { code: SPAN_STATUS_ERROR, message: "resource_exhausted" };
      case 499:
        return { code: SPAN_STATUS_ERROR, message: "cancelled" };
      default:
        return { code: SPAN_STATUS_ERROR, message: "invalid_argument" };
    }
  }
  if (httpStatus >= 500 && httpStatus < 600) {
    switch (httpStatus) {
      case 501:
        return { code: SPAN_STATUS_ERROR, message: "unimplemented" };
      case 503:
        return { code: SPAN_STATUS_ERROR, message: "unavailable" };
      case 504:
        return { code: SPAN_STATUS_ERROR, message: "deadline_exceeded" };
      default:
        return { code: SPAN_STATUS_ERROR, message: "internal_error" };
    }
  }
  return { code: SPAN_STATUS_ERROR, message: "internal_error" };
}
__name(getSpanStatusFromHttpCode, "getSpanStatusFromHttpCode");
function setHttpStatus(span, httpStatus) {
  span.setAttribute("http.response.status_code", httpStatus);
  const spanStatus = getSpanStatusFromHttpCode(httpStatus);
  if (spanStatus.message !== "unknown_error") {
    span.setStatus(spanStatus);
  }
}
__name(setHttpStatus, "setHttpStatus");

// node_modules/@sentry/core/build/esm/tracing/utils.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/weakRef.js
init_modules_watch_stub();
function makeWeakRef(value) {
  try {
    const WeakRefImpl = GLOBAL_OBJ.WeakRef;
    if (typeof WeakRefImpl === "function") {
      return new WeakRefImpl(value);
    }
  } catch {
  }
  return value;
}
__name(makeWeakRef, "makeWeakRef");
function derefWeakRef(ref) {
  if (!ref) {
    return void 0;
  }
  if (typeof ref === "object" && "deref" in ref && typeof ref.deref === "function") {
    try {
      return ref.deref();
    } catch {
      return void 0;
    }
  }
  return ref;
}
__name(derefWeakRef, "derefWeakRef");

// node_modules/@sentry/core/build/esm/tracing/utils.js
var SCOPE_ON_START_SPAN_FIELD = "_sentryScope";
var ISOLATION_SCOPE_ON_START_SPAN_FIELD = "_sentryIsolationScope";
var TRACER_PROVIDER_SPAN_FIELD = /* @__PURE__ */ Symbol.for("sentry.tracerProviderSpan");
function setCapturedScopesOnSpan(span, scope, isolationScope) {
  if (span) {
    addNonEnumerableProperty(span, ISOLATION_SCOPE_ON_START_SPAN_FIELD, makeWeakRef(isolationScope));
    addNonEnumerableProperty(span, SCOPE_ON_START_SPAN_FIELD, scope);
  }
}
__name(setCapturedScopesOnSpan, "setCapturedScopesOnSpan");
function getCapturedScopesOnSpan(span) {
  const spanWithScopes = span;
  return {
    scope: spanWithScopes[SCOPE_ON_START_SPAN_FIELD],
    isolationScope: derefWeakRef(spanWithScopes[ISOLATION_SCOPE_ON_START_SPAN_FIELD])
  };
}
__name(getCapturedScopesOnSpan, "getCapturedScopesOnSpan");
function markSpanAsTracerProviderSpan(span) {
  addNonEnumerableProperty(span, TRACER_PROVIDER_SPAN_FIELD, true);
}
__name(markSpanAsTracerProviderSpan, "markSpanAsTracerProviderSpan");
function spanIsTracerProviderSpan(span) {
  return span[TRACER_PROVIDER_SPAN_FIELD] === true;
}
__name(spanIsTracerProviderSpan, "spanIsTracerProviderSpan");

// node_modules/@sentry/core/build/esm/utils/tracing.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/baggage.js
init_modules_watch_stub();
var SENTRY_BAGGAGE_KEY_PREFIX = "sentry-";
var MAX_BAGGAGE_STRING_LENGTH = 8192;
function baggageHeaderToDynamicSamplingContext(baggageHeader) {
  const baggageObject = parseBaggageHeader(baggageHeader);
  if (!baggageObject) {
    return void 0;
  }
  const dynamicSamplingContext = Object.entries(baggageObject).reduce((acc, [key, value]) => {
    if (key.startsWith(SENTRY_BAGGAGE_KEY_PREFIX)) {
      const nonPrefixedKey = key.slice(SENTRY_BAGGAGE_KEY_PREFIX.length);
      acc[nonPrefixedKey] = value;
    }
    return acc;
  }, {});
  if (Object.keys(dynamicSamplingContext).length > 0) {
    return dynamicSamplingContext;
  } else {
    return void 0;
  }
}
__name(baggageHeaderToDynamicSamplingContext, "baggageHeaderToDynamicSamplingContext");
function dynamicSamplingContextToSentryBaggageHeader(dynamicSamplingContext) {
  if (!dynamicSamplingContext) {
    return void 0;
  }
  const sentryPrefixedDSC = Object.entries(dynamicSamplingContext).reduce(
    (acc, [dscKey, dscValue]) => {
      if (dscValue) {
        acc[`${SENTRY_BAGGAGE_KEY_PREFIX}${dscKey}`] = dscValue;
      }
      return acc;
    },
    {}
  );
  return objectToBaggageHeader(sentryPrefixedDSC);
}
__name(dynamicSamplingContextToSentryBaggageHeader, "dynamicSamplingContextToSentryBaggageHeader");
function parseBaggageHeader(baggageHeader) {
  if (!baggageHeader || !isString(baggageHeader) && !Array.isArray(baggageHeader)) {
    return void 0;
  }
  if (Array.isArray(baggageHeader)) {
    return baggageHeader.reduce((acc, curr) => {
      const currBaggageObject = baggageHeaderToObject(curr);
      Object.entries(currBaggageObject).forEach(([key, value]) => {
        acc[key] = value;
      });
      return acc;
    }, {});
  }
  return baggageHeaderToObject(baggageHeader);
}
__name(parseBaggageHeader, "parseBaggageHeader");
function baggageHeaderToObject(baggageHeader) {
  return baggageHeader.split(",").map((baggageEntry) => {
    const eqIdx = baggageEntry.indexOf("=");
    if (eqIdx === -1) {
      return [];
    }
    const key = baggageEntry.slice(0, eqIdx);
    const value = baggageEntry.slice(eqIdx + 1);
    return [key, value].map((keyOrValue) => {
      try {
        return decodeURIComponent(keyOrValue.trim());
      } catch {
        return;
      }
    });
  }).reduce((acc, [key, value]) => {
    if (key && value) {
      acc[key] = value;
    }
    return acc;
  }, {});
}
__name(baggageHeaderToObject, "baggageHeaderToObject");
function objectToBaggageHeader(object) {
  if (Object.keys(object).length === 0) {
    return void 0;
  }
  return Object.entries(object).reduce((baggageHeader, [objectKey, objectValue], currentIndex) => {
    const baggageEntry = `${encodeURIComponent(objectKey)}=${encodeURIComponent(objectValue)}`;
    const newBaggageHeader = currentIndex === 0 ? baggageEntry : `${baggageHeader},${baggageEntry}`;
    if (newBaggageHeader.length > MAX_BAGGAGE_STRING_LENGTH) {
      DEBUG_BUILD && debug.warn(
        `Not adding key: ${objectKey} with val: ${objectValue} to baggage header due to exceeding baggage size limits.`
      );
      return baggageHeader;
    } else {
      return newBaggageHeader;
    }
  }, "");
}
__name(objectToBaggageHeader, "objectToBaggageHeader");

// node_modules/@sentry/core/build/esm/utils/dsn.js
init_modules_watch_stub();
var ORG_ID_REGEX = /^o(\d+)\./;
var DSN_REGEX = /^(?:(\w+):)\/\/(?:(\w+)(?::(\w+)?)?@)((?:\[[:.%\w]+\]|[\w.-]+))(?::(\d+))?\/(.+)/;
function isValidProtocol(protocol) {
  return protocol === "http" || protocol === "https";
}
__name(isValidProtocol, "isValidProtocol");
function dsnToString(dsn, withPassword = false) {
  const { host, path, pass, port, projectId, protocol, publicKey } = dsn;
  return `${protocol}://${publicKey}${withPassword && pass ? `:${pass}` : ""}@${host}${port ? `:${port}` : ""}/${path ? `${path}/` : path}${projectId}`;
}
__name(dsnToString, "dsnToString");
function dsnFromString(str) {
  const match = DSN_REGEX.exec(str);
  if (!match) {
    consoleSandbox(() => {
      console.error(`Invalid Sentry Dsn: ${str}`);
    });
    return void 0;
  }
  const [protocol, publicKey, pass = "", host = "", port = "", lastPath = ""] = match.slice(1);
  let path = "";
  let projectId = lastPath;
  const split = projectId.split("/");
  if (split.length > 1) {
    path = split.slice(0, -1).join("/");
    projectId = split.pop();
  }
  if (projectId) {
    const projectMatch = projectId.match(/^\d+/);
    if (projectMatch) {
      projectId = projectMatch[0];
    }
  }
  return dsnFromComponents({ host, pass, path, projectId, port, protocol, publicKey });
}
__name(dsnFromString, "dsnFromString");
function dsnFromComponents(components) {
  return {
    protocol: components.protocol,
    publicKey: components.publicKey || "",
    pass: components.pass || "",
    host: components.host,
    port: components.port || "",
    path: components.path || "",
    projectId: components.projectId
  };
}
__name(dsnFromComponents, "dsnFromComponents");
function validateDsn(dsn) {
  if (!DEBUG_BUILD) {
    return true;
  }
  const { port, projectId, protocol } = dsn;
  const requiredComponents = ["protocol", "publicKey", "host", "projectId"];
  const hasMissingRequiredComponent = requiredComponents.find((component) => {
    if (!dsn[component]) {
      debug.error(`Invalid Sentry Dsn: ${component} missing`);
      return true;
    }
    return false;
  });
  if (hasMissingRequiredComponent) {
    return false;
  }
  if (!projectId.match(/^\d+$/)) {
    debug.error(`Invalid Sentry Dsn: Invalid projectId ${projectId}`);
    return false;
  }
  if (!isValidProtocol(protocol)) {
    debug.error(`Invalid Sentry Dsn: Invalid protocol ${protocol}`);
    return false;
  }
  if (port && isNaN(parseInt(port, 10))) {
    debug.error(`Invalid Sentry Dsn: Invalid port ${port}`);
    return false;
  }
  return true;
}
__name(validateDsn, "validateDsn");
function extractOrgIdFromDsnHost(host) {
  const match = host.match(ORG_ID_REGEX);
  return match?.[1];
}
__name(extractOrgIdFromDsnHost, "extractOrgIdFromDsnHost");
function extractOrgIdFromClient(client) {
  const options = client.getOptions();
  const { host } = client.getDsn() || {};
  let org_id;
  if (options.orgId) {
    org_id = String(options.orgId);
  } else if (host) {
    org_id = extractOrgIdFromDsnHost(host);
  }
  return org_id;
}
__name(extractOrgIdFromClient, "extractOrgIdFromClient");
function makeDsn(from) {
  const components = typeof from === "string" ? dsnFromString(from) : dsnFromComponents(from);
  if (!components || !validateDsn(components)) {
    return void 0;
  }
  return components;
}
__name(makeDsn, "makeDsn");

// node_modules/@sentry/core/build/esm/utils/parseSampleRate.js
init_modules_watch_stub();
function parseSampleRate(sampleRate) {
  if (typeof sampleRate === "boolean") {
    return Number(sampleRate);
  }
  const rate = typeof sampleRate === "string" ? parseFloat(sampleRate) : sampleRate;
  if (typeof rate !== "number" || isNaN(rate) || rate < 0 || rate > 1) {
    return void 0;
  }
  return rate;
}
__name(parseSampleRate, "parseSampleRate");

// node_modules/@sentry/core/build/esm/utils/tracing.js
var TRACEPARENT_REGEXP = new RegExp(
  "^[ \\t]*([0-9a-f]{32})?-?([0-9a-f]{16})?-?([01])?[ \\t]*$"
  // whitespace
);
function extractTraceparentData(traceparent) {
  if (!traceparent) {
    return void 0;
  }
  const matches = traceparent.match(TRACEPARENT_REGEXP);
  if (!matches) {
    return void 0;
  }
  let parentSampled;
  if (matches[3] === "1") {
    parentSampled = true;
  } else if (matches[3] === "0") {
    parentSampled = false;
  }
  return {
    traceId: matches[1],
    parentSampled,
    parentSpanId: matches[2]
  };
}
__name(extractTraceparentData, "extractTraceparentData");
function isContinuingTrace(propagationContext) {
  return !!propagationContext.parentSpanId || !!propagationContext.dsc;
}
__name(isContinuingTrace, "isContinuingTrace");
function propagationContextFromHeaders(sentryTrace, baggage) {
  const traceparentData = extractTraceparentData(sentryTrace);
  const dynamicSamplingContext = baggageHeaderToDynamicSamplingContext(baggage);
  if (!traceparentData?.traceId) {
    return {
      traceId: generateTraceId(),
      sampleRand: safeMathRandom()
    };
  }
  const sampleRand = getSampleRandFromTraceparentAndDsc(traceparentData, dynamicSamplingContext);
  if (dynamicSamplingContext) {
    dynamicSamplingContext.sample_rand = sampleRand.toString();
  }
  const { traceId, parentSpanId, parentSampled } = traceparentData;
  return {
    traceId,
    parentSpanId,
    sampled: parentSampled,
    dsc: dynamicSamplingContext || {},
    // If we have traceparent data but no DSC it means we are not head of trace and we must freeze it
    sampleRand
  };
}
__name(propagationContextFromHeaders, "propagationContextFromHeaders");
function generateSentryTraceHeader(traceId = generateTraceId(), spanId = generateSpanId(), sampled) {
  let sampledString = "";
  if (sampled !== void 0) {
    sampledString = sampled ? "-1" : "-0";
  }
  return `${traceId}-${spanId}${sampledString}`;
}
__name(generateSentryTraceHeader, "generateSentryTraceHeader");
function generateTraceparentHeader(traceId = generateTraceId(), spanId = generateSpanId(), sampled) {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}
__name(generateTraceparentHeader, "generateTraceparentHeader");
function getSampleRandFromTraceparentAndDsc(traceparentData, dsc) {
  const parsedSampleRand = parseSampleRate(dsc?.sample_rand);
  if (parsedSampleRand !== void 0) {
    return parsedSampleRand;
  }
  const parsedSampleRate = parseSampleRate(dsc?.sample_rate);
  if (parsedSampleRate && traceparentData?.parentSampled !== void 0) {
    return traceparentData.parentSampled ? (
      // Returns a sample rand with positive sampling decision [0, sampleRate)
      safeMathRandom() * parsedSampleRate
    ) : (
      // Returns a sample rand with negative sampling decision [sampleRate, 1)
      parsedSampleRate + safeMathRandom() * (1 - parsedSampleRate)
    );
  } else {
    return safeMathRandom();
  }
}
__name(getSampleRandFromTraceparentAndDsc, "getSampleRandFromTraceparentAndDsc");
function shouldContinueTrace(client, baggageOrgId) {
  const clientOrgId = extractOrgIdFromClient(client);
  if (baggageOrgId && clientOrgId && baggageOrgId !== clientOrgId) {
    debug.log(
      `Won't continue trace because org IDs don't match (incoming baggage: ${baggageOrgId}, SDK options: ${clientOrgId})`
    );
    return false;
  }
  const strictTraceContinuation = client.getOptions().strictTraceContinuation || false;
  if (strictTraceContinuation) {
    if (baggageOrgId && !clientOrgId || !baggageOrgId && clientOrgId) {
      debug.log(
        `Starting a new trace because strict trace continuation is enabled but one org ID is missing (incoming baggage: ${baggageOrgId}, Sentry client: ${clientOrgId})`
      );
      return false;
    }
  }
  return true;
}
__name(shouldContinueTrace, "shouldContinueTrace");

// node_modules/@sentry/core/build/esm/utils/spanOnScope.js
init_modules_watch_stub();
var SCOPE_SPAN_FIELD = "span";
function _setSpanForScope(scope, span) {
  if (span) {
    scope.refs[SCOPE_SPAN_FIELD] = makeWeakRef(span);
  } else {
    delete scope.refs[SCOPE_SPAN_FIELD];
  }
}
__name(_setSpanForScope, "_setSpanForScope");
function _getSpanForScope(scope) {
  return derefWeakRef(scope.refs[SCOPE_SPAN_FIELD]);
}
__name(_getSpanForScope, "_getSpanForScope");

// node_modules/@sentry/core/build/esm/utils/spanUtils.js
var TRACE_FLAG_NONE = 0;
var TRACE_FLAG_SAMPLED = 1;
function spanToTransactionTraceContext(span) {
  const { spanId: span_id, traceId: trace_id } = span.spanContext();
  const { data, op, parent_span_id, status, origin, links } = spanToStaticSpanJSON(span);
  return {
    parent_span_id,
    span_id,
    trace_id,
    data,
    op,
    status,
    origin,
    links
  };
}
__name(spanToTransactionTraceContext, "spanToTransactionTraceContext");
function spanToTraceContext(span) {
  const { spanId, traceId: trace_id, isRemote } = span.spanContext();
  const parent_span_id = isRemote ? spanId : spanToStaticSpanJSON(span).parent_span_id;
  const scope = getCapturedScopesOnSpan(span).scope;
  const span_id = isRemote ? scope?.getPropagationContext().propagationSpanId || generateSpanId() : spanId;
  return {
    parent_span_id,
    span_id,
    trace_id
  };
}
__name(spanToTraceContext, "spanToTraceContext");
function spanToTraceHeader(span) {
  const { traceId, spanId } = span.spanContext();
  const sampled = spanIsSampled(span);
  return generateSentryTraceHeader(traceId, spanId, sampled);
}
__name(spanToTraceHeader, "spanToTraceHeader");
function spanToTraceparentHeader(span) {
  const { traceId, spanId } = span.spanContext();
  const sampled = spanIsSampled(span);
  return generateTraceparentHeader(traceId, spanId, sampled);
}
__name(spanToTraceparentHeader, "spanToTraceparentHeader");
function convertSpanLinksForEnvelope(links) {
  if (links && links.length > 0) {
    return links.map(({ context: { spanId, traceId, traceFlags, ...restContext }, attributes }) => ({
      span_id: spanId,
      trace_id: traceId,
      sampled: traceFlags === TRACE_FLAG_SAMPLED,
      attributes,
      ...restContext
    }));
  } else {
    return void 0;
  }
}
__name(convertSpanLinksForEnvelope, "convertSpanLinksForEnvelope");
function getStreamedSpanLinks(links) {
  if (links?.length) {
    return links.map(({ context: { spanId, traceId, traceFlags }, attributes }) => ({
      span_id: spanId,
      trace_id: traceId,
      sampled: traceFlags === TRACE_FLAG_SAMPLED,
      attributes
    }));
  } else {
    return void 0;
  }
}
__name(getStreamedSpanLinks, "getStreamedSpanLinks");
function spanTimeInputToSeconds(input) {
  if (typeof input === "number") {
    return ensureTimestampInSeconds(input);
  }
  if (Array.isArray(input)) {
    return input[0] + input[1] / 1e9;
  }
  if (input instanceof Date) {
    return ensureTimestampInSeconds(input.getTime());
  }
  return timestampInSeconds();
}
__name(spanTimeInputToSeconds, "spanTimeInputToSeconds");
function ensureTimestampInSeconds(timestamp) {
  const isMs = timestamp > 9999999999;
  return isMs ? timestamp / 1e3 : timestamp;
}
__name(ensureTimestampInSeconds, "ensureTimestampInSeconds");
function spanToStaticSpanJSON(span) {
  if (spanIsSentrySpan(span)) {
    return span.getStaticSpanJSON();
  }
  const { spanId: span_id, traceId: trace_id } = span.spanContext();
  if (spanIsOpenTelemetrySdkTraceBaseSpan(span)) {
    const { attributes, startTime, name, endTime, status, links } = span;
    return {
      span_id,
      trace_id,
      data: attributes,
      description: name,
      parent_span_id: getOtelParentSpanId(span),
      start_timestamp: spanTimeInputToSeconds(startTime),
      // This is [0,0] by default in OTEL, in which case we want to interpret this as no end time
      timestamp: spanTimeInputToSeconds(endTime) || void 0,
      status: getStatusMessage(status),
      op: attributes[mm],
      origin: attributes[gm],
      links: convertSpanLinksForEnvelope(links)
    };
  }
  return {
    span_id,
    trace_id,
    start_timestamp: 0,
    status: "ok",
    data: {}
  };
}
__name(spanToStaticSpanJSON, "spanToStaticSpanJSON");
function spanToJSON(span) {
  if (spanIsSentrySpan(span)) {
    return span.getSpanJSON();
  }
  const { spanId: span_id, traceId: trace_id } = span.spanContext();
  if (spanIsOpenTelemetrySdkTraceBaseSpan(span)) {
    const { attributes, startTime, name, endTime, status, links } = span;
    return {
      name,
      span_id,
      trace_id,
      parent_span_id: getOtelParentSpanId(span),
      start_timestamp: spanTimeInputToSeconds(startTime),
      // This is [0,0] by default in OTEL, in which case we want to interpret this as no end time
      end_timestamp: spanTimeInputToSeconds(endTime) || void 0,
      is_segment: spanIsSegment(span),
      status: getSimpleStatus(status),
      attributes: addStatusMessageAttribute(attributes, status),
      links: getStreamedSpanLinks(links)
    };
  }
  return {
    span_id,
    trace_id,
    start_timestamp: 0,
    name: "",
    status: "ok",
    is_segment: spanIsSegment(span),
    attributes: {}
  };
}
__name(spanToJSON, "spanToJSON");
function getOtelParentSpanId(span) {
  return "parentSpanId" in span ? span.parentSpanId : "parentSpanContext" in span ? span.parentSpanContext?.spanId : void 0;
}
__name(getOtelParentSpanId, "getOtelParentSpanId");
function streamedSpanJsonToSerializedSpan(spanJson) {
  return {
    ...spanJson,
    // We only ever send ended spans, but fall back to the start time (i.e. duration 0) so that
    // sent spans always carry an end timestamp.
    end_timestamp: spanJson.end_timestamp ?? spanJson.start_timestamp,
    attributes: serializeAttributes(spanJson.attributes),
    links: spanJson.links?.map((link) => ({
      ...link,
      attributes: serializeAttributes(link.attributes)
    }))
  };
}
__name(streamedSpanJsonToSerializedSpan, "streamedSpanJsonToSerializedSpan");
function spanIsOpenTelemetrySdkTraceBaseSpan(span) {
  const castSpan = span;
  return !!castSpan.attributes && !!castSpan.startTime && !!castSpan.name && !!castSpan.endTime && !!castSpan.status;
}
__name(spanIsOpenTelemetrySdkTraceBaseSpan, "spanIsOpenTelemetrySdkTraceBaseSpan");
function spanIsSentrySpan(span) {
  return typeof span.getSpanJSON === "function";
}
__name(spanIsSentrySpan, "spanIsSentrySpan");
function spanIsSampled(span) {
  const { traceFlags } = span.spanContext();
  return traceFlags === TRACE_FLAG_SAMPLED;
}
__name(spanIsSampled, "spanIsSampled");
function getStatusMessage(status) {
  if (!status || status.code === SPAN_STATUS_UNSET) {
    return "ok";
  }
  if (status.code === SPAN_STATUS_OK) {
    return "ok";
  }
  return status.message && isStatusErrorMessageValid(status.message) ? status.message : "internal_error";
}
__name(getStatusMessage, "getStatusMessage");
function getSimpleStatus(status) {
  return !status || status.code === SPAN_STATUS_OK || status.code === SPAN_STATUS_UNSET || status.message === "cancelled" ? "ok" : "error";
}
__name(getSimpleStatus, "getSimpleStatus");
function addStatusMessageAttribute(attributes, status) {
  const statusMessage = getSimpleStatus(status) === "error" ? status?.message : void 0;
  return {
    ...statusMessage && { [Mm]: statusMessage },
    ...attributes
  };
}
__name(addStatusMessageAttribute, "addStatusMessageAttribute");
var CHILD_SPANS_FIELD = "_sentryChildSpans";
var ROOT_SPAN_FIELD = "_sentryRootSpan";
function addChildSpanToSpan(span, childSpan) {
  const rootSpan = span[ROOT_SPAN_FIELD] || span;
  addNonEnumerableProperty(childSpan, ROOT_SPAN_FIELD, rootSpan);
  childSpan.setAttribute(Nm, void 0);
  if (!spanIsSampled(span)) {
    return;
  }
  if (!span.isRecording() && !rootSpan.isRecording()) {
    return;
  }
  if (span[CHILD_SPANS_FIELD]) {
    span[CHILD_SPANS_FIELD].add(childSpan);
  } else {
    addNonEnumerableProperty(span, CHILD_SPANS_FIELD, /* @__PURE__ */ new Set([childSpan]));
  }
}
__name(addChildSpanToSpan, "addChildSpanToSpan");
function getSpanDescendants(span) {
  const resultSet = /* @__PURE__ */ new Set();
  function addSpanChildren(span2) {
    if (resultSet.has(span2)) {
      return;
    } else if (spanIsSampled(span2)) {
      resultSet.add(span2);
      const childSpans = span2[CHILD_SPANS_FIELD] ? Array.from(span2[CHILD_SPANS_FIELD]) : [];
      for (const childSpan of childSpans) {
        addSpanChildren(childSpan);
      }
    }
  }
  __name(addSpanChildren, "addSpanChildren");
  addSpanChildren(span);
  return Array.from(resultSet);
}
__name(getSpanDescendants, "getSpanDescendants");
var getRootSpan = INTERNAL_getSegmentSpan;
function INTERNAL_getSegmentSpan(span) {
  return span[ROOT_SPAN_FIELD] || span;
}
__name(INTERNAL_getSegmentSpan, "INTERNAL_getSegmentSpan");
function spanIsSegment(span) {
  return span === INTERNAL_getSegmentSpan(span);
}
__name(spanIsSegment, "spanIsSegment");
function getActiveSpan(scope) {
  const carrier = getMainCarrier();
  const acs = getAsyncContextStrategy(carrier);
  if (acs.getActiveSpan) {
    return acs.getActiveSpan(scope);
  }
  return _getSpanForScope(scope || getCurrentScope());
}
__name(getActiveSpan, "getActiveSpan");
function INTERNAL_setSegmentNameSourceIfSegment(span, source) {
  if (spanIsSegment(span)) {
    span.setAttribute(Nm, source);
  }
}
__name(INTERNAL_setSegmentNameSourceIfSegment, "INTERNAL_setSegmentNameSourceIfSegment");

// node_modules/@sentry/core/build/esm/utils/hasSpansEnabled.js
init_modules_watch_stub();
function hasSpansEnabled(maybeOptions) {
  if (typeof __SENTRY_TRACING__ === "boolean" && !__SENTRY_TRACING__) {
    return false;
  }
  const options = maybeOptions || getClient()?.getOptions();
  return !!options && // Note: This check is `!= null`, meaning "nullish". `0` is not "nullish", `undefined` and `null` are. (This comment was brought to you by 15 minutes of questioning life)
  (options.tracesSampleRate != null || !!options.tracesSampler);
}
__name(hasSpansEnabled, "hasSpansEnabled");

// node_modules/@sentry/core/build/esm/utils/should-ignore-span.js
init_modules_watch_stub();
function logIgnoredSpan(droppedSpan) {
  debug.log(`Ignoring span ${droppedSpan.op} - ${droppedSpan.description} because it matches \`ignoreSpans\`.`);
}
__name(logIgnoredSpan, "logIgnoredSpan");
function shouldIgnoreSpan(span, ignoreSpans) {
  if (!ignoreSpans?.length) {
    return false;
  }
  for (const pattern of ignoreSpans) {
    if (isStringOrRegExp(pattern)) {
      if (span.description && isMatchingPattern(span.description, pattern)) {
        DEBUG_BUILD && logIgnoredSpan(span);
        return true;
      }
      continue;
    }
    const hasAttributes = !!pattern.attributes && Object.keys(pattern.attributes).length > 0;
    if (!pattern.name && !pattern.op && !hasAttributes) {
      continue;
    }
    const nameMatches = pattern.name ? span.description && isMatchingPattern(span.description, pattern.name) : true;
    const opMatches = pattern.op ? span.op && isMatchingPattern(span.op, pattern.op) : true;
    const attrsMatch = pattern.attributes ? Object.entries(pattern.attributes).every(
      ([key, valuePattern]) => _matchesAttributeValue(span.attributes?.[key], valuePattern)
    ) : true;
    if (nameMatches && opMatches && attrsMatch) {
      DEBUG_BUILD && logIgnoredSpan(span);
      return true;
    }
  }
  return false;
}
__name(shouldIgnoreSpan, "shouldIgnoreSpan");
function _matchesAttributeValue(actual, pat) {
  if (typeof actual === "string" && (typeof pat === "string" || pat instanceof RegExp)) {
    return isMatchingPattern(actual, pat);
  }
  if (Array.isArray(actual) && Array.isArray(pat)) {
    return actual.length === pat.length && actual.every((v, i) => v === pat[i]);
  }
  return actual === pat;
}
__name(_matchesAttributeValue, "_matchesAttributeValue");
function reparentChildSpans(spans, dropSpan) {
  const droppedSpanParentId = dropSpan.parent_span_id;
  const droppedSpanId = dropSpan.span_id;
  if (!droppedSpanParentId) {
    return;
  }
  for (const span of spans) {
    if (span.parent_span_id === droppedSpanId) {
      span.parent_span_id = droppedSpanParentId;
    }
  }
}
__name(reparentChildSpans, "reparentChildSpans");
function isStringOrRegExp(value) {
  return typeof value === "string" || value instanceof RegExp;
}
__name(isStringOrRegExp, "isStringOrRegExp");

// node_modules/@sentry/core/build/esm/integrations/spanStreaming.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/integration.js
init_modules_watch_stub();
var installedIntegrations = [];
function filterDuplicates(integrations) {
  const integrationsByName = {};
  integrations.forEach((currentInstance) => {
    const { name } = currentInstance;
    const existingInstance = integrationsByName[name];
    if (existingInstance && !existingInstance.isDefaultInstance && currentInstance.isDefaultInstance) {
      return;
    }
    integrationsByName[name] = currentInstance;
  });
  return Object.values(integrationsByName);
}
__name(filterDuplicates, "filterDuplicates");
function getIntegrationsToSetup(options) {
  const defaultIntegrations = options.defaultIntegrations || [];
  const userIntegrations = options.integrations;
  defaultIntegrations.forEach((integration) => {
    integration.isDefaultInstance = true;
  });
  let integrations;
  if (Array.isArray(userIntegrations)) {
    integrations = [...defaultIntegrations, ...userIntegrations];
  } else if (typeof userIntegrations === "function") {
    const resolvedUserIntegrations = userIntegrations(defaultIntegrations);
    integrations = Array.isArray(resolvedUserIntegrations) ? resolvedUserIntegrations : [resolvedUserIntegrations];
  } else {
    integrations = defaultIntegrations;
  }
  return filterDuplicates(integrations);
}
__name(getIntegrationsToSetup, "getIntegrationsToSetup");
function setupIntegrations(client, integrations) {
  const integrationIndex = {};
  integrations.forEach((integration) => {
    if (integration?.beforeSetup) {
      integration.beforeSetup(client);
    }
  });
  integrations.forEach((integration) => {
    if (integration) {
      setupIntegration(client, integration, integrationIndex);
    }
  });
  return integrationIndex;
}
__name(setupIntegrations, "setupIntegrations");
function afterSetupIntegrations(client, integrations) {
  for (const integration of integrations) {
    if (integration?.afterAllSetup) {
      integration.afterAllSetup(client);
    }
  }
}
__name(afterSetupIntegrations, "afterSetupIntegrations");
function setupIntegration(client, integration, integrationIndex) {
  if (integrationIndex[integration.name]) {
    DEBUG_BUILD && debug.log(`Integration skipped because it was already installed: ${integration.name}`);
    return;
  }
  integrationIndex[integration.name] = integration;
  if (!installedIntegrations.includes(integration.name) && typeof integration.setupOnce === "function") {
    integration.setupOnce();
    installedIntegrations.push(integration.name);
  }
  if (integration.setup && typeof integration.setup === "function") {
    integration.setup(client);
  }
  if (typeof integration.preprocessEvent === "function") {
    const callback = integration.preprocessEvent.bind(integration);
    client.on("preprocessEvent", (event, hint) => callback(event, hint, client));
  }
  if (typeof integration.processEvent === "function") {
    const callback = integration.processEvent.bind(integration);
    const processor = Object.assign((event, hint) => callback(event, hint, client), {
      id: integration.name
    });
    client.addEventProcessor(processor);
  }
  ["processSpan", "processSegmentSpan"].forEach((hook) => {
    const callback = integration[hook];
    if (typeof callback === "function") {
      client.on(hook, (span) => callback.call(integration, span, client));
    }
  });
  DEBUG_BUILD && debug.log(`Integration installed: ${integration.name}`);
}
__name(setupIntegration, "setupIntegration");
function defineIntegration(fn) {
  return fn;
}
__name(defineIntegration, "defineIntegration");

// node_modules/@sentry/core/build/esm/tracing/spans/captureSpan.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/scopeData.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/tracing/dynamicSamplingContext.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/constants.js
init_modules_watch_stub();
var DEFAULT_ENVIRONMENT = "production";

// node_modules/@sentry/core/build/esm/tracing/sentryNonRecordingSpan.js
init_modules_watch_stub();
var NON_RECORDING_SPAN_FIELD = /* @__PURE__ */ Symbol.for("sentry.nonRecordingSpan");
var SentryNonRecordingSpan = class {
  static {
    __name(this, "SentryNonRecordingSpan");
  }
  constructor(spanContext = {}) {
    this._traceId = spanContext.traceId || generateTraceId();
    this._spanId = spanContext.spanId || generateSpanId();
    this.dropReason = spanContext.dropReason;
    addNonEnumerableProperty(this, NON_RECORDING_SPAN_FIELD, true);
  }
  /** @inheritdoc */
  spanContext() {
    return {
      spanId: this._spanId,
      traceId: this._traceId,
      traceFlags: TRACE_FLAG_NONE
    };
  }
  /** @inheritdoc */
  end(_timestamp) {
  }
  /** @inheritdoc */
  setAttribute(_key, _value) {
    return this;
  }
  /** @inheritdoc */
  setAttributes(_values) {
    return this;
  }
  /** @inheritdoc */
  setStatus(_status) {
    return this;
  }
  /** @inheritdoc */
  updateName(_name) {
    return this;
  }
  /** @inheritdoc */
  isRecording() {
    return false;
  }
  /** @inheritdoc */
  addEvent(_name, _attributesOrStartTime, _startTime) {
    return this;
  }
  /** @inheritDoc */
  addLink(_link) {
    return this;
  }
  /** @inheritDoc */
  addLinks(_links) {
    return this;
  }
  /**
   * This should generally not be used,
   * but we need it for being compliant with the OTEL Span interface.
   *
   * @hidden
   * @internal
   */
  recordException(_exception, _time) {
  }
};
function spanIsNonRecordingSpan(span) {
  return !!span && span[NON_RECORDING_SPAN_FIELD] === true;
}
__name(spanIsNonRecordingSpan, "spanIsNonRecordingSpan");

// node_modules/@sentry/core/build/esm/tracing/dynamicSamplingContext.js
var FROZEN_DSC_FIELD = "_frozenDsc";
function freezeDscOnSpan(span, dsc) {
  const spanWithMaybeDsc = span;
  addNonEnumerableProperty(spanWithMaybeDsc, FROZEN_DSC_FIELD, dsc);
}
__name(freezeDscOnSpan, "freezeDscOnSpan");
function getDynamicSamplingContextFromClient(trace_id, client) {
  const options = client.getOptions();
  const { publicKey: public_key } = client.getDsn() || {};
  const dsc = {
    environment: options.environment || DEFAULT_ENVIRONMENT,
    release: options.release,
    public_key,
    trace_id,
    org_id: extractOrgIdFromClient(client)
  };
  client.emit("createDsc", dsc);
  return dsc;
}
__name(getDynamicSamplingContextFromClient, "getDynamicSamplingContextFromClient");
function getDynamicSamplingContextFromScope(client, scope) {
  if (getExternalPropagationContext()) {
    return void 0;
  }
  const propagationContext = scope.getPropagationContext();
  return propagationContext.dsc || getDynamicSamplingContextFromClient(propagationContext.traceId, client);
}
__name(getDynamicSamplingContextFromScope, "getDynamicSamplingContextFromScope");
function getDynamicSamplingContextFromSpan(span) {
  const client = getClient();
  if (!client) {
    return {};
  }
  const rootSpan = getRootSpan(span);
  const rootSpanJson = spanToStaticSpanJSON(rootSpan);
  const rootSpanAttributes = rootSpanJson.data;
  const traceState = rootSpan.spanContext().traceState;
  const rootSpanSampleRate = traceState?.get("sentry.sample_rate") ?? rootSpanAttributes[SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE] ?? rootSpanAttributes[SEMANTIC_ATTRIBUTE_SENTRY_PREVIOUS_TRACE_SAMPLE_RATE];
  function applyLocalSampleRateToDsc(dsc2) {
    if (typeof rootSpanSampleRate === "number" || typeof rootSpanSampleRate === "string") {
      dsc2.sample_rate = `${rootSpanSampleRate}`;
    }
    return dsc2;
  }
  __name(applyLocalSampleRateToDsc, "applyLocalSampleRateToDsc");
  const frozenDsc = rootSpan[FROZEN_DSC_FIELD];
  if (frozenDsc) {
    return applyLocalSampleRateToDsc(frozenDsc);
  }
  const isNonRecordingRoot = spanIsNonRecordingSpan(rootSpan);
  const isIgnoredRoot = isNonRecordingRoot && rootSpan.dropReason === "ignored";
  if (isNonRecordingRoot && (!hasSpansEnabled(client.getOptions()) || isIgnoredRoot)) {
    const capturedScope = getCapturedScopesOnSpan(rootSpan).scope;
    const scopeDsc = capturedScope && getDynamicSamplingContextFromScope(client, capturedScope);
    if (scopeDsc) {
      const dsc2 = { ...scopeDsc };
      if (isIgnoredRoot) {
        dsc2.sampled = "false";
      }
      return applyLocalSampleRateToDsc(dsc2);
    }
  }
  const traceStateDsc = traceState?.get("sentry.dsc");
  const dscOnTraceState = traceStateDsc && baggageHeaderToDynamicSamplingContext(traceStateDsc);
  if (dscOnTraceState) {
    return applyLocalSampleRateToDsc(dscOnTraceState);
  }
  const dsc = getDynamicSamplingContextFromClient(span.spanContext().traceId, client);
  const source = rootSpanAttributes[Nm];
  const name = rootSpanJson.description;
  if (source !== "url" && name) {
    dsc.transaction = name;
  }
  if (hasSpansEnabled()) {
    dsc.sampled = String(spanIsSampled(rootSpan));
    dsc.sample_rand = // In OTEL we store the sample rand on the trace state because we cannot access scopes for NonRecordingSpans
    // The Sentry OTEL SpanSampler takes care of writing the sample rand on the root span
    traceState?.get("sentry.sample_rand") ?? // On all other platforms we can actually get the scopes from a root span (we use this as a fallback)
    getCapturedScopesOnSpan(rootSpan).scope?.getPropagationContext().sampleRand.toString();
  }
  applyLocalSampleRateToDsc(dsc);
  client.emit("createDsc", dsc, rootSpan);
  return dsc;
}
__name(getDynamicSamplingContextFromSpan, "getDynamicSamplingContextFromSpan");

// node_modules/@sentry/core/build/esm/utils/scopeData.js
function applyScopeDataToEvent(event, data) {
  const { fingerprint, breadcrumbs, sdkProcessingMetadata } = data;
  applyDataToEvent(event, data);
  applyFingerprintToEvent(event, fingerprint);
  applyBreadcrumbsToEvent(event, breadcrumbs);
  applySdkMetadataToEvent(event, sdkProcessingMetadata);
}
__name(applyScopeDataToEvent, "applyScopeDataToEvent");
function mergeScopeData(data, mergeData) {
  const {
    extra,
    tags,
    attributes,
    user,
    contexts,
    level,
    sdkProcessingMetadata,
    breadcrumbs,
    fingerprint,
    eventProcessors,
    attachments,
    propagationContext,
    transactionName
  } = mergeData;
  mergeAndOverwriteScopeData(data, "extra", extra);
  mergeAndOverwriteScopeData(data, "tags", tags);
  mergeAndOverwriteScopeData(data, "attributes", attributes);
  mergeAndOverwriteScopeData(data, "user", user);
  mergeAndOverwriteScopeData(data, "contexts", contexts);
  data.sdkProcessingMetadata = merge(data.sdkProcessingMetadata, sdkProcessingMetadata, 2);
  if (level) {
    data.level = level;
  }
  if (transactionName) {
    data.transactionName = transactionName;
  }
  if (breadcrumbs.length) {
    data.breadcrumbs = [...data.breadcrumbs, ...breadcrumbs];
  }
  if (fingerprint.length) {
    data.fingerprint = [...data.fingerprint, ...fingerprint];
  }
  if (eventProcessors.length) {
    data.eventProcessors = [...data.eventProcessors, ...eventProcessors];
  }
  if (attachments.length) {
    data.attachments = [...data.attachments, ...attachments];
  }
  data.propagationContext = { ...data.propagationContext, ...propagationContext };
}
__name(mergeScopeData, "mergeScopeData");
function mergeAndOverwriteScopeData(data, prop, mergeVal) {
  data[prop] = merge(data[prop], mergeVal, 1);
}
__name(mergeAndOverwriteScopeData, "mergeAndOverwriteScopeData");
function getCombinedScopeData(isolationScope, currentScope) {
  const scopeData = getGlobalScope().getScopeData();
  isolationScope && mergeScopeData(scopeData, isolationScope.getScopeData());
  currentScope && mergeScopeData(scopeData, currentScope.getScopeData());
  return scopeData;
}
__name(getCombinedScopeData, "getCombinedScopeData");
function applyDataToEvent(event, data) {
  const { extra, tags, user, contexts, level, transactionName } = data;
  if (Object.keys(extra).length) {
    event.extra = { ...extra, ...event.extra };
  }
  if (Object.keys(tags).length) {
    event.tags = { ...tags, ...event.tags };
  }
  if (Object.keys(user).length) {
    event.user = { ...user, ...event.user };
  }
  if (Object.keys(contexts).length) {
    event.contexts = { ...contexts, ...event.contexts };
  }
  if (level) {
    event.level = level;
  }
  if (transactionName && event.type !== "transaction") {
    event.transaction = transactionName;
  }
}
__name(applyDataToEvent, "applyDataToEvent");
function applyBreadcrumbsToEvent(event, breadcrumbs) {
  const mergedBreadcrumbs = [...event.breadcrumbs || [], ...breadcrumbs];
  event.breadcrumbs = mergedBreadcrumbs.length ? mergedBreadcrumbs : void 0;
}
__name(applyBreadcrumbsToEvent, "applyBreadcrumbsToEvent");
function applySdkMetadataToEvent(event, sdkProcessingMetadata) {
  event.sdkProcessingMetadata = {
    ...event.sdkProcessingMetadata,
    ...sdkProcessingMetadata
  };
}
__name(applySdkMetadataToEvent, "applySdkMetadataToEvent");
function applySpanToEvent(event, span) {
  event.contexts = {
    trace: spanToTraceContext(span),
    ...event.contexts
  };
  event.sdkProcessingMetadata = {
    dynamicSamplingContext: getDynamicSamplingContextFromSpan(span),
    ...event.sdkProcessingMetadata
  };
  const rootSpan = getRootSpan(span);
  const transactionName = spanToStaticSpanJSON(rootSpan).description;
  if (transactionName && !event.transaction && event.type === "transaction") {
    event.transaction = transactionName;
  }
}
__name(applySpanToEvent, "applySpanToEvent");
function applyFingerprintToEvent(event, fingerprint) {
  event.fingerprint = event.fingerprint ? Array.isArray(event.fingerprint) ? event.fingerprint : [event.fingerprint] : [];
  if (fingerprint) {
    event.fingerprint = event.fingerprint.concat(fingerprint);
  }
  if (!event.fingerprint.length) {
    delete event.fingerprint;
  }
}
__name(applyFingerprintToEvent, "applyFingerprintToEvent");

// node_modules/@sentry/core/build/esm/tracing/spans/beforeSendSpan.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/safeCallback.js
init_modules_watch_stub();
function safeCallback(message2, fn, fallback) {
  let result;
  try {
    result = fn();
  } catch (error2) {
    return recover(message2, error2, fallback);
  }
  if (isThenable(result)) {
    return result.then(void 0, (error2) => recover(message2, error2, fallback));
  }
  return result;
}
__name(safeCallback, "safeCallback");
function recover(message2, error2, fallback) {
  DEBUG_BUILD && debug.error(message2, error2);
  return fallback(error2);
}
__name(recover, "recover");

// node_modules/@sentry/core/build/esm/tracing/spans/beforeSendSpan.js
function isStaticBeforeSendSpanCallback(callback) {
  return !!callback && typeof callback === "function" && "_static" in callback && !!callback._static;
}
__name(isStaticBeforeSendSpanCallback, "isStaticBeforeSendSpanCallback");
function applyBeforeSendSpanCallback(span, beforeSendSpan) {
  const modifiedSpan = safeCallback(
    DEBUG_BUILD ? "The `beforeSendSpan` callback threw an error, sending the span unmodified:" : "",
    () => beforeSendSpan(span),
    () => span
  );
  return modifiedSpan || span;
}
__name(applyBeforeSendSpanCallback, "applyBeforeSendSpanCallback");

// node_modules/@sentry/core/build/esm/tracing/spans/spanJsonToStreamedSpan.js
init_modules_watch_stub();
function spanJsonToSerializedStreamedSpan(span) {
  const streamedSpan = {
    trace_id: span.trace_id,
    span_id: span.span_id,
    parent_span_id: span.parent_span_id,
    name: span.description || "",
    start_timestamp: span.start_timestamp,
    end_timestamp: span.timestamp,
    status: !span.status || span.status === "ok" || span.status === "cancelled" ? "ok" : "error",
    is_segment: false,
    attributes: { ...span.data },
    links: span.links
  };
  return streamedSpanJsonToSerializedSpan(streamedSpan);
}
__name(spanJsonToSerializedStreamedSpan, "spanJsonToSerializedStreamedSpan");

// node_modules/@sentry/core/build/esm/tracing/spans/scopeContextAttributes.js
init_modules_watch_stub();
function scopeContextsToSpanAttributes(contexts) {
  const attrs = {};
  const { response, profile, cloud_resource, culture, state } = contexts;
  if (response) {
    if (response.status_code != null) {
      attrs["http.response.status_code"] = response.status_code;
    }
    if (response.body_size != null) {
      attrs["http.response.body.size"] = response.body_size;
    }
  }
  if (profile) {
    if (profile.profile_id) {
      attrs["sentry.profile_id"] = profile.profile_id;
    }
    if (profile.profiler_id) {
      attrs["sentry.profiler_id"] = profile.profiler_id;
    }
  }
  if (cloud_resource) {
    for (const [key, value] of Object.entries(cloud_resource)) {
      if (value != null) {
        attrs[key] = value;
      }
    }
  }
  if (culture) {
    if (culture.locale) {
      attrs["culture.locale"] = culture.locale;
    }
    if (culture.timezone) {
      attrs["culture.timezone"] = culture.timezone;
    }
  }
  if (state?.state && typeof state.state.type === "string") {
    attrs["state.type"] = state.state.type;
  }
  const angular = contexts["angular"];
  if (angular) {
    const version = angular["version"];
    if (typeof version === "string" || typeof version === "number") {
      attrs["angular.version"] = version;
    }
  }
  const react = contexts["react"];
  if (react) {
    const version = react["version"];
    if (typeof version === "string" || typeof version === "number") {
      attrs["react.version"] = version;
    }
  }
  return attrs;
}
__name(scopeContextsToSpanAttributes, "scopeContextsToSpanAttributes");

// node_modules/@sentry/core/build/esm/tracing/spans/captureSpan.js
function captureSpan(span, client) {
  const spanJSON = spanToJSON(span);
  if (spanJSON.attributes) {
    delete spanJSON.attributes[SEMANTIC_ATTRIBUTE_SENTRY_CUSTOM_SPAN_NAME];
  }
  const segmentSpan = INTERNAL_getSegmentSpan(span);
  const serializedSegmentSpan = spanToJSON(segmentSpan);
  const { isolationScope: spanIsolationScope, scope: spanScope } = getCapturedScopesOnSpan(span);
  const finalScopeData = getCombinedScopeData(spanIsolationScope, spanScope);
  applyCommonSpanAttributes(spanJSON, serializedSegmentSpan, client, finalScopeData);
  client.emit("preprocessSpan", spanJSON);
  if (spanJSON.is_segment) {
    applyScopeToSegmentSpan(spanJSON, finalScopeData);
    applySdkMetadataToSegmentSpan(spanJSON, client);
    client.emit("processSegmentSpan", spanJSON);
  }
  client.emit("processSpan", spanJSON);
  const { beforeSendSpan, traceLifecycle } = client.getOptions();
  const processedSpan = (
    // check for traceLifecycle here because in static lifecycle,
    // captureSpan is called for INP spans. If an unmigrated beforeSendSpan
    // callback is run on these spans, it will throw an error.
    traceLifecycle !== "static" && beforeSendSpan && !isStaticBeforeSendSpanCallback(beforeSendSpan) ? applyBeforeSendSpanCallback(spanJSON, beforeSendSpan) : spanJSON
  );
  return {
    ...streamedSpanJsonToSerializedSpan(processedSpan),
    _segmentSpan: segmentSpan
  };
}
__name(captureSpan, "captureSpan");
function applyScopeToSegmentSpan(segmentSpanJSON, scopeData) {
  const contextAttributes = scopeContextsToSpanAttributes(scopeData.contexts);
  safeSetSpanJSONAttributes(segmentSpanJSON, contextAttributes);
}
__name(applyScopeToSegmentSpan, "applyScopeToSegmentSpan");
function safeSetSpanJSONAttributes(spanJSON, newAttributes) {
  const originalAttributes = spanJSON.attributes ?? (spanJSON.attributes = {});
  Object.entries(newAttributes).forEach(([key, value]) => {
    if (value != null && !(key in originalAttributes)) {
      originalAttributes[key] = value;
    }
  });
}
__name(safeSetSpanJSONAttributes, "safeSetSpanJSONAttributes");
function applySdkMetadataToSegmentSpan(segmentSpanJSON, client) {
  const integrationNames = client.getIntegrationNames();
  if (!integrationNames.length) return;
  safeSetSpanJSONAttributes(segmentSpanJSON, {
    [Om]: integrationNames
  });
}
__name(applySdkMetadataToSegmentSpan, "applySdkMetadataToSegmentSpan");
function commonSpanAttributes(serializedSegmentSpan, client, scopeData, includeScopeAttributes = true) {
  const sdk = client.getSdkMetadata();
  const { release, environment } = client.getOptions();
  return {
    [Fm]: "stream",
    [Rm]: serializedSegmentSpan.name,
    [wm]: serializedSegmentSpan.span_id,
    [Im]: sdk?.sdk?.name,
    [Am]: sdk?.sdk?.version,
    [km]: release,
    [Md]: environment || DEFAULT_ENVIRONMENT,
    [kb]: scopeData.user?.id,
    [gb]: scopeData.user?.email,
    [Tb]: scopeData.user?.ip_address,
    [Sb]: scopeData.user?.username,
    ...includeScopeAttributes ? scopeData.attributes : void 0
  };
}
__name(commonSpanAttributes, "commonSpanAttributes");
function applyCommonSpanAttributes(spanJSON, serializedSegmentSpan, client, scopeData) {
  safeSetSpanJSONAttributes(spanJSON, commonSpanAttributes(serializedSegmentSpan, client, scopeData));
}
__name(applyCommonSpanAttributes, "applyCommonSpanAttributes");
function captureStandaloneSpanWithStaticCallback(span, client, beforeSendSpan) {
  const spanJSON = spanToStaticSpanJSON(span);
  const segmentSpan = INTERNAL_getSegmentSpan(span);
  const serializedSegmentSpan = spanToJSON(segmentSpan);
  const { isolationScope: spanIsolationScope, scope: spanScope } = getCapturedScopesOnSpan(span);
  const finalScopeData = getCombinedScopeData(spanIsolationScope, spanScope);
  const commonAttributes = commonSpanAttributes(serializedSegmentSpan, client, finalScopeData, false);
  Object.entries(commonAttributes).forEach(([key, value]) => {
    if (value != null && !(key in spanJSON.data)) {
      spanJSON.data[key] = value;
    }
  });
  const processedSpan = applyBeforeSendSpanCallback(spanJSON, beforeSendSpan);
  return spanJsonToSerializedStreamedSpan(processedSpan);
}
__name(captureStandaloneSpanWithStaticCallback, "captureStandaloneSpanWithStaticCallback");

// node_modules/@sentry/core/build/esm/tracing/spans/hasSpanStreamingEnabled.js
init_modules_watch_stub();
function hasSpanStreamingEnabled(client) {
  return client.getOptions().traceLifecycle === "stream";
}
__name(hasSpanStreamingEnabled, "hasSpanStreamingEnabled");

// node_modules/@sentry/core/build/esm/tracing/spans/spanBuffer.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/timer.js
init_modules_watch_stub();
function safeUnref(timer) {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}
__name(safeUnref, "safeUnref");

// node_modules/@sentry/core/build/esm/tracing/spans/envelope.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/envelope.js
init_modules_watch_stub();
function createEnvelope(headers, items = []) {
  return [headers, items];
}
__name(createEnvelope, "createEnvelope");
function addItemToEnvelope(envelope, newItem) {
  const [headers, items] = envelope;
  return [headers, [...items, newItem]];
}
__name(addItemToEnvelope, "addItemToEnvelope");
function forEachEnvelopeItem(envelope, callback) {
  const envelopeItems = envelope[1];
  for (const envelopeItem of envelopeItems) {
    const envelopeItemType = envelopeItem[0].type;
    const result = callback(envelopeItem, envelopeItemType);
    if (result) {
      return true;
    }
  }
  return false;
}
__name(forEachEnvelopeItem, "forEachEnvelopeItem");
function envelopeContainsItemType(envelope, types) {
  return forEachEnvelopeItem(envelope, (_, type) => types.includes(type));
}
__name(envelopeContainsItemType, "envelopeContainsItemType");
function encodeUTF8(input) {
  const carrier = getSentryCarrier(GLOBAL_OBJ);
  return carrier.encodePolyfill ? carrier.encodePolyfill(input) : new TextEncoder().encode(input);
}
__name(encodeUTF8, "encodeUTF8");
function serializeEnvelope(envelope) {
  const [envHeaders, items] = envelope;
  let parts = JSON.stringify(envHeaders);
  function append(next) {
    if (typeof parts === "string") {
      parts = typeof next === "string" ? parts + next : [encodeUTF8(parts), next];
    } else {
      parts.push(typeof next === "string" ? encodeUTF8(next) : next);
    }
  }
  __name(append, "append");
  for (const item of items) {
    const [itemHeaders, payload] = item;
    append(`
${JSON.stringify(itemHeaders)}
`);
    if (typeof payload === "string" || payload instanceof Uint8Array) {
      append(payload);
    } else {
      let stringifiedPayload;
      try {
        stringifiedPayload = JSON.stringify(payload);
      } catch {
        stringifiedPayload = JSON.stringify(normalize(payload));
      }
      append(stringifiedPayload);
    }
  }
  return typeof parts === "string" ? parts : concatBuffers(parts);
}
__name(serializeEnvelope, "serializeEnvelope");
function concatBuffers(buffers) {
  const totalLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    merged.set(buffer, offset);
    offset += buffer.length;
  }
  return merged;
}
__name(concatBuffers, "concatBuffers");
function createAttachmentEnvelopeItem(attachment) {
  const buffer = typeof attachment.data === "string" ? encodeUTF8(attachment.data) : attachment.data;
  return [
    {
      type: "attachment",
      length: buffer.length,
      filename: attachment.filename,
      content_type: attachment.contentType,
      attachment_type: attachment.attachmentType
    },
    buffer
  ];
}
__name(createAttachmentEnvelopeItem, "createAttachmentEnvelopeItem");
var DATA_CATEGORY_OVERRIDES = {
  sessions: "session",
  event: "error",
  client_report: "internal",
  user_report: "default",
  profile_chunk: "profile",
  replay_event: "replay",
  replay_recording: "replay",
  check_in: "monitor",
  raw_security: "security",
  log: "log_item",
  trace_metric: "metric"
};
function _isOverriddenType(type) {
  return type in DATA_CATEGORY_OVERRIDES;
}
__name(_isOverriddenType, "_isOverriddenType");
function envelopeItemTypeToDataCategory(type) {
  return _isOverriddenType(type) ? DATA_CATEGORY_OVERRIDES[type] : type;
}
__name(envelopeItemTypeToDataCategory, "envelopeItemTypeToDataCategory");
function getSdkMetadataForEnvelopeHeader(metadataOrEvent) {
  if (!metadataOrEvent?.sdk) {
    return;
  }
  const { name, version } = metadataOrEvent.sdk;
  return { name, version };
}
__name(getSdkMetadataForEnvelopeHeader, "getSdkMetadataForEnvelopeHeader");
function createEventEnvelopeHeaders(event, sdkInfo, tunnel, dsn) {
  const dynamicSamplingContext = event.sdkProcessingMetadata?.dynamicSamplingContext;
  return {
    event_id: event.event_id,
    sent_at: new Date(safeDateNow()).toISOString(),
    ...sdkInfo && { sdk: sdkInfo },
    ...!!tunnel && dsn && { dsn: dsnToString(dsn) },
    ...dynamicSamplingContext && {
      trace: dynamicSamplingContext
    }
  };
}
__name(createEventEnvelopeHeaders, "createEventEnvelopeHeaders");
function getDataCategoryByType(type) {
  return type === "replay_event" ? "replay" : type || "error";
}
__name(getDataCategoryByType, "getDataCategoryByType");

// node_modules/@sentry/core/build/esm/utils/isBrowser.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/node.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/env.js
init_modules_watch_stub();
function isBrowserBundle() {
  return typeof __SENTRY_BROWSER_BUNDLE__ !== "undefined" && !!__SENTRY_BROWSER_BUNDLE__;
}
__name(isBrowserBundle, "isBrowserBundle");

// node_modules/@sentry/core/build/esm/utils/node.js
function isNodeEnv() {
  return !isBrowserBundle() && Object.prototype.toString.call(typeof process !== "undefined" ? process : 0) === "[object process]";
}
__name(isNodeEnv, "isNodeEnv");

// node_modules/@sentry/core/build/esm/utils/isBrowser.js
function isBrowser() {
  return typeof window !== "undefined" && (!isNodeEnv() || isElectronNodeRenderer());
}
__name(isBrowser, "isBrowser");
function isElectronNodeRenderer() {
  const process2 = GLOBAL_OBJ.process;
  return process2?.type === "renderer";
}
__name(isElectronNodeRenderer, "isElectronNodeRenderer");

// node_modules/@sentry/core/build/esm/tracing/spans/envelope.js
function createStreamedSpanEnvelope(serializedSpans, dsc, client) {
  const options = client.getOptions();
  const dsn = client.getDsn();
  const tunnel = options.tunnel;
  const sdk = getSdkMetadataForEnvelopeHeader(options._metadata);
  const headers = {
    sent_at: new Date(safeDateNow()).toISOString(),
    ...dscHasRequiredProps(dsc) && { trace: dsc },
    ...sdk && { sdk },
    ...!!tunnel && dsn && { dsn: dsnToString(dsn) }
  };
  return createEnvelope(headers, [createSpanContainerItem(serializedSpans, client)]);
}
__name(createStreamedSpanEnvelope, "createStreamedSpanEnvelope");
function createSpanContainerItem(serializedSpans, client) {
  const inferSetting = client.getDataCollectionOptions().userInfo ? "auto" : "never";
  return [
    { type: "span", item_count: serializedSpans.length, content_type: "application/vnd.sentry.items.span.v2+json" },
    {
      version: 2,
      ingest_settings: isBrowser() ? { infer_ip: inferSetting, infer_user_agent: inferSetting } : void 0,
      items: serializedSpans
    }
  ];
}
__name(createSpanContainerItem, "createSpanContainerItem");
function dscHasRequiredProps(dsc) {
  return !!dsc.trace_id && !!dsc.public_key;
}
__name(dscHasRequiredProps, "dscHasRequiredProps");

// node_modules/@sentry/core/build/esm/tracing/spans/estimateSize.js
init_modules_watch_stub();
function estimateSerializedSpanSizeInBytes(span) {
  let weight = 156;
  weight += span.name.length * 2;
  weight += estimateTypedAttributesSizeInBytes(span.attributes);
  if (span.links && span.links.length > 0) {
    const firstLink = span.links[0];
    const attributes = firstLink?.attributes;
    const linkWeight = 100 + (attributes ? estimateTypedAttributesSizeInBytes(attributes) : 0);
    weight += linkWeight * span.links.length;
  }
  return weight;
}
__name(estimateSerializedSpanSizeInBytes, "estimateSerializedSpanSizeInBytes");

// node_modules/@sentry/core/build/esm/tracing/spans/spanBuffer.js
var MAX_SPANS_PER_ENVELOPE = 1e3;
var MAX_TRACE_WEIGHT_IN_BYTES = 5e6;
var SpanBuffer = class {
  static {
    __name(this, "SpanBuffer");
  }
  constructor(client, options) {
    this._traceBuckets = /* @__PURE__ */ new Map();
    this._client = client;
    const { maxSpanLimit, flushInterval, maxTraceWeightInBytes } = options ?? {};
    this._maxSpanLimit = maxSpanLimit && maxSpanLimit > 0 && maxSpanLimit <= MAX_SPANS_PER_ENVELOPE ? maxSpanLimit : MAX_SPANS_PER_ENVELOPE;
    this._flushInterval = flushInterval && flushInterval > 0 ? flushInterval : 5e3;
    this._maxTraceWeight = maxTraceWeightInBytes && maxTraceWeightInBytes > 0 ? maxTraceWeightInBytes : MAX_TRACE_WEIGHT_IN_BYTES;
    this._client.on("flush", () => {
      this.drain();
    });
    this._client.on("close", () => {
      this._traceBuckets.forEach((bucket) => {
        clearTimeout(bucket.timeout);
      });
      this._traceBuckets.clear();
    });
  }
  /**
   * Add a span to the buffer.
   */
  add(spanJSON) {
    const traceId = spanJSON.trace_id;
    let bucket = this._traceBuckets.get(traceId);
    if (!bucket) {
      bucket = {
        spans: /* @__PURE__ */ new Set(),
        size: 0,
        timeout: safeUnref(
          setTimeout(() => {
            this.flush(traceId);
          }, this._flushInterval)
        )
      };
      this._traceBuckets.set(traceId, bucket);
    }
    bucket.spans.add(spanJSON);
    bucket.size += estimateSerializedSpanSizeInBytes(spanJSON);
    if (bucket.spans.size >= this._maxSpanLimit || bucket.size >= this._maxTraceWeight) {
      this.flush(traceId);
    }
  }
  /**
   * Drain and flush all buffered traces.
   */
  drain() {
    if (!this._traceBuckets.size) {
      return;
    }
    DEBUG_BUILD && debug.log(`Flushing span tree map with ${this._traceBuckets.size} traces`);
    this._traceBuckets.forEach((_, traceId) => {
      this.flush(traceId);
    });
  }
  /**
   * Flush spans of a specific trace.
   * In contrast to {@link SpanBuffer.drain}, this method does not flush all traces, but only the one with the given traceId.
   */
  flush(traceId) {
    const bucket = this._traceBuckets.get(traceId);
    if (!bucket) {
      return;
    }
    if (!bucket.spans.size) {
      this._removeTrace(traceId);
      return;
    }
    const spans = Array.from(bucket.spans);
    const segmentSpan = spans[0]?._segmentSpan;
    if (!segmentSpan) {
      DEBUG_BUILD && debug.warn("No segment span reference found on span JSON, cannot compute DSC");
      this._removeTrace(traceId);
      return;
    }
    const dsc = getDynamicSamplingContextFromSpan(segmentSpan);
    const cleanedSpans = spans.map((spanJSON) => {
      const { _segmentSpan, ...cleanSpanJSON } = spanJSON;
      return cleanSpanJSON;
    });
    const envelope = createStreamedSpanEnvelope(cleanedSpans, dsc, this._client);
    DEBUG_BUILD && debug.log(`Sending span envelope for trace ${traceId} with ${cleanedSpans.length} spans`);
    this._client.sendEnvelope(envelope).then(null, (reason) => {
      DEBUG_BUILD && debug.error("Error while sending streamed span envelope:", reason);
    });
    this._removeTrace(traceId);
  }
  _removeTrace(traceId) {
    const bucket = this._traceBuckets.get(traceId);
    if (bucket) {
      clearTimeout(bucket.timeout);
    }
    this._traceBuckets.delete(traceId);
  }
};

// node_modules/@sentry/core/build/esm/integrations/spanStreaming.js
var INTEGRATION_NAME = "SpanStreaming";
var spanStreamingIntegration = defineIntegration((options = {}) => {
  const flushOnSegmentEnd = options.flushOnSegmentEnd ?? true;
  return {
    name: INTEGRATION_NAME,
    setup(client) {
      if (!hasSpanStreamingEnabled(client)) {
        DEBUG_BUILD && debug.log(`[${INTEGRATION_NAME}] \`traceLifecycle\` is "static", skipping setup.`);
        return;
      }
      const buffer = new SpanBuffer(client);
      client.on("afterSpanEnd", (span) => {
        if (!spanIsSampled(span)) {
          return;
        }
        buffer.add(captureSpan(span, client));
      });
      client.on("flushTraceSpans", (traceId) => {
        buffer.flush(traceId);
      });
      if (flushOnSegmentEnd) {
        client.on("afterSegmentSpanEnd", (segmentSpan) => {
          const traceId = segmentSpan.spanContext().traceId;
          safeUnref(
            setTimeout(() => {
              buffer.flush(traceId);
            }, 500)
          );
        });
      }
    }
  };
});

// node_modules/@sentry/core/build/esm/tracing/trace.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/handleCallbackErrors.js
init_modules_watch_stub();
function handleCallbackErrors(fn, onError, onFinally = () => {
}, onSuccess = () => {
}) {
  let maybePromiseResult;
  try {
    maybePromiseResult = fn();
  } catch (e) {
    onError(e);
    onFinally();
    throw e;
  }
  return maybeHandlePromiseRejection(maybePromiseResult, onError, onFinally, onSuccess);
}
__name(handleCallbackErrors, "handleCallbackErrors");
function maybeHandlePromiseRejection(value, onError, onFinally, onSuccess) {
  if (isThenable(value)) {
    return chainAndCopyPromiseLike(
      value,
      (result) => {
        onFinally();
        onSuccess(result);
      },
      (err) => {
        onError(err);
        onFinally();
      }
    );
  }
  onFinally();
  onSuccess(value);
  return value;
}
__name(maybeHandlePromiseRejection, "maybeHandlePromiseRejection");

// node_modules/@sentry/core/build/esm/utils/errorSpanAttribution.js
init_modules_watch_stub();
var escapedSpanTraceContexts = /* @__PURE__ */ new WeakMap();
function toWeakMapKey(error2) {
  return isPrimitive(error2) ? void 0 : error2;
}
__name(toWeakMapKey, "toWeakMapKey");
function recordEscapedErrorSpan(error2, span) {
  const key = toWeakMapKey(error2);
  if (!key || !spanIsSampled(span) || escapedSpanTraceContexts.has(key)) {
    return;
  }
  escapedSpanTraceContexts.set(key, spanToTraceContext(span));
}
__name(recordEscapedErrorSpan, "recordEscapedErrorSpan");
function applyEscapedErrorSpanToEvent(event, hint, scope) {
  const key = toWeakMapKey(hint.originalException);
  const traceContext = key && escapedSpanTraceContexts.get(key);
  if (!traceContext) {
    return;
  }
  const eventTraceContext = event.contexts?.trace;
  const eventTraceId = eventTraceContext?.trace_id ?? (scope && getTraceContextFromScope(scope).trace_id);
  if (eventTraceId !== traceContext.trace_id) {
    return;
  }
  event.contexts = {
    ...event.contexts,
    trace: {
      ...eventTraceContext,
      ...traceContext
    }
  };
}
__name(applyEscapedErrorSpanToEvent, "applyEscapedErrorSpanToEvent");

// node_modules/@sentry/core/build/esm/tracing/logSpans.js
init_modules_watch_stub();
function logSpanStart(span) {
  if (!DEBUG_BUILD) return;
  const {
    description = "< unknown name >",
    op = "< unknown op >",
    parent_span_id: parentSpanId
  } = spanToStaticSpanJSON(span);
  const { spanId } = span.spanContext();
  const sampled = spanIsSampled(span);
  const rootSpan = getRootSpan(span);
  const isRootSpan = rootSpan === span;
  const header = `[Tracing] Starting ${sampled ? "sampled" : "unsampled"} ${isRootSpan ? "root " : ""}span`;
  const infoParts = [`op: ${op}`, `name: ${description}`, `ID: ${spanId}`];
  if (parentSpanId) {
    infoParts.push(`parent ID: ${parentSpanId}`);
  }
  if (!isRootSpan) {
    const { op: op2, description: description2 } = spanToStaticSpanJSON(rootSpan);
    infoParts.push(`root ID: ${rootSpan.spanContext().spanId}`);
    if (op2) {
      infoParts.push(`root op: ${op2}`);
    }
    if (description2) {
      infoParts.push(`root description: ${description2}`);
    }
  }
  debug.log(`${header}
  ${infoParts.join("\n  ")}`);
}
__name(logSpanStart, "logSpanStart");
function logSpanEnd(span) {
  if (!DEBUG_BUILD) return;
  const { description = "< unknown name >", op = "< unknown op >" } = spanToStaticSpanJSON(span);
  const { spanId } = span.spanContext();
  const rootSpan = getRootSpan(span);
  const isRootSpan = rootSpan === span;
  const msg = `[Tracing] Finishing "${op}" ${isRootSpan ? "root " : ""}span "${description}" with ID ${spanId}`;
  debug.log(msg);
}
__name(logSpanEnd, "logSpanEnd");

// node_modules/@sentry/core/build/esm/tracing/sampling.js
init_modules_watch_stub();
function sampleSpan(options, samplingContext, sampleRand) {
  if (!hasSpansEnabled(options)) {
    return [false];
  }
  const resolved = resolveSampleRate(options, samplingContext);
  if (!resolved) {
    return [false, void 0, void 0, "callback_error"];
  }
  const [sampleRate, localSampleRateWasApplied] = resolved;
  const parsedSampleRate = parseSampleRate(sampleRate);
  if (parsedSampleRate === void 0) {
    DEBUG_BUILD && debug.warn(
      `[Tracing] Discarding root span because of invalid sample rate. Sample rate must be a boolean or a number between 0 and 1. Got ${JSON.stringify(
        sampleRate
      )} of type ${JSON.stringify(typeof sampleRate)}.`
    );
    return [false];
  }
  if (!parsedSampleRate) {
    DEBUG_BUILD && debug.log(
      `[Tracing] Discarding transaction because ${typeof options.tracesSampler === "function" ? "tracesSampler returned 0 or false" : "a negative sampling decision was inherited or tracesSampleRate is set to 0"}`
    );
    return [false, parsedSampleRate, localSampleRateWasApplied];
  }
  const shouldSample = sampleRand < parsedSampleRate;
  if (!shouldSample) {
    DEBUG_BUILD && debug.log(
      `[Tracing] Discarding transaction because it's not included in the random sample (sampling rate = ${Number(
        sampleRate
      )})`
    );
  }
  return [shouldSample, parsedSampleRate, localSampleRateWasApplied];
}
__name(sampleSpan, "sampleSpan");
function resolveSampleRate(options, samplingContext) {
  const { tracesSampler, tracesSampleRate } = options;
  if (typeof tracesSampler === "function") {
    const samplerResult = safeCallback(
      DEBUG_BUILD ? "The `tracesSampler` callback threw an error, falling back to the parent sampling decision or `tracesSampleRate`:" : "",
      () => [
        tracesSampler({
          ...samplingContext,
          inheritOrSampleWith: /* @__PURE__ */ __name((fallbackSampleRate) => {
            if (typeof samplingContext.parentSampleRate === "number") {
              return samplingContext.parentSampleRate;
            }
            if (typeof samplingContext.parentSampled === "boolean") {
              return Number(samplingContext.parentSampled);
            }
            return fallbackSampleRate;
          }, "inheritOrSampleWith")
        }),
        true
      ],
      () => void 0
    );
    if (samplerResult) {
      return samplerResult;
    }
  }
  if (samplingContext.parentSampled !== void 0) {
    return [samplingContext.parentSampled];
  }
  if (typeof tracesSampleRate !== "undefined") {
    return [tracesSampleRate, true];
  }
  return void 0;
}
__name(resolveSampleRate, "resolveSampleRate");

// node_modules/@sentry/core/build/esm/tracing/sentrySpan.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/tracing/measurement.js
init_modules_watch_stub();
function timedEventsToMeasurements(events) {
  if (!events || events.length === 0) {
    return void 0;
  }
  const measurements = {};
  events.forEach((event) => {
    const attributes = event.attributes || {};
    const unit = attributes[SEMANTIC_ATTRIBUTE_SENTRY_MEASUREMENT_UNIT];
    const value = attributes[SEMANTIC_ATTRIBUTE_SENTRY_MEASUREMENT_VALUE];
    if (typeof unit === "string" && typeof value === "number") {
      measurements[event.name] = { value, unit };
    }
  });
  return measurements;
}
__name(timedEventsToMeasurements, "timedEventsToMeasurements");

// node_modules/@sentry/core/build/esm/tracing/segmentSpanCaptureStrategy.js
init_modules_watch_stub();
function getSegmentSpanCaptureStrategy() {
  return getSentryCarrier(getMainCarrier()).segmentSpanCaptureStrategy;
}
__name(getSegmentSpanCaptureStrategy, "getSegmentSpanCaptureStrategy");

// node_modules/@sentry/core/build/esm/tracing/sentrySpan.js
var MAX_SPAN_COUNT = 1e3;
var SentrySpan = class {
  static {
    __name(this, "SentrySpan");
  }
  /**
   * You should never call the constructor manually, always use `Sentry.startSpan()`
   * or other span methods.
   * @internal
   * @hideconstructor
   * @hidden
   */
  constructor(spanContext = {}) {
    this._traceId = spanContext.traceId || generateTraceId();
    this._spanId = spanContext.spanId || generateSpanId();
    if (spanContext.startTimestamp) {
      this._startTime = spanContext.startTimestamp;
    } else {
      this._startTime = timestampInSeconds();
      this._startPerformanceNow = safePerformanceNow();
    }
    this._links = spanContext.links;
    this._attributes = {};
    this.setAttributes({
      [gm]: "manual",
      [mm]: spanContext.op,
      ...spanContext.attributes
    });
    this._name = spanContext.name;
    if (spanContext.parentSpanId) {
      this._parentSpanId = spanContext.parentSpanId;
    }
    if ("sampled" in spanContext) {
      this._sampled = spanContext.sampled;
    }
    this._events = [];
    this._isStandaloneSpan = spanContext.isStandalone;
  }
  /** @inheritDoc */
  addLink(link) {
    if (this._frozen) {
      return this;
    }
    if (this._links) {
      this._links.push(link);
    } else {
      this._links = [link];
    }
    return this;
  }
  /** @inheritDoc */
  addLinks(links) {
    if (this._frozen) {
      return this;
    }
    if (this._links) {
      this._links.push(...links);
    } else {
      this._links = links;
    }
    return this;
  }
  /**
   * This should generally not be used,
   * but it is needed for being compliant with the OTEL Span interface.
   *
   * @hidden
   * @internal
   */
  recordException(_exception, _time) {
  }
  /** @inheritdoc */
  spanContext() {
    const { _spanId: spanId, _traceId: traceId, _sampled: sampled } = this;
    return {
      spanId,
      traceId,
      traceFlags: sampled ? TRACE_FLAG_SAMPLED : TRACE_FLAG_NONE
    };
  }
  /** @inheritdoc */
  setAttribute(key, value) {
    if (this._frozen) {
      return this;
    }
    if (key === Nm && value !== void 0 && !spanIsSegment(this)) {
      DEBUG_BUILD && debug.warn("[Tracing] Ignoring name source on a child span: this attribute is only valid on the root span.");
      return this;
    }
    if (value === void 0) {
      delete this._attributes[key];
    } else {
      this._attributes[key] = value;
    }
    return this;
  }
  /** @inheritdoc */
  setAttributes(attributes) {
    Object.keys(attributes).forEach((key) => this.setAttribute(key, attributes[key]));
    return this;
  }
  /**
   * This should generally not be used,
   * but we need it for browser tracing where we want to adjust the start time afterwards.
   * USE THIS WITH CAUTION!
   *
   * @hidden
   * @internal
   */
  updateStartTime(timeInput) {
    if (this._frozen) {
      return;
    }
    this._startTime = spanTimeInputToSeconds(timeInput);
    this._startPerformanceNow = void 0;
  }
  /**
   * @inheritDoc
   */
  setStatus(value) {
    if (this._frozen) {
      return this;
    }
    this._status = value;
    return this;
  }
  /**
   * @inheritDoc
   */
  updateName(name) {
    if (this._frozen) {
      return this;
    }
    this._name = name;
    INTERNAL_setSegmentNameSourceIfSegment(this, "custom");
    return this;
  }
  /** @inheritdoc */
  end(endTimestamp) {
    if (this._endTime) {
      return;
    }
    this._endTime = endTimestamp == null ? this._getEndTimeFromDuration() : spanTimeInputToSeconds(endTimestamp);
    logSpanEnd(this);
    this._onSpanEnded();
    this._frozen = spanIsTracerProviderSpan(this);
  }
  /**
   * Get JSON representation of this span.
   *
   * @hidden
   * @internal This method is purely for internal purposes and should not be used outside
   * of SDK code. If you need to get a JSON representation of a span,
   * use `spanToJSON(span)` instead.
   */
  getStaticSpanJSON() {
    return {
      data: this._attributes,
      description: this._name,
      op: this._attributes[mm],
      parent_span_id: this._parentSpanId,
      span_id: this._spanId,
      start_timestamp: this._startTime,
      status: getStatusMessage(this._status),
      timestamp: this._endTime,
      trace_id: this._traceId,
      origin: this._attributes[gm],
      profile_id: this._attributes[hm],
      exclusive_time: this._attributes[Vd],
      measurements: timedEventsToMeasurements(this._events),
      links: convertSpanLinksForEnvelope(this._links)
    };
  }
  /**
   * Get {@link StreamedSpanJSON} representation of this span.
   *
   * @hidden
   * @internal This method is purely for internal purposes and should not be used outside
   * of SDK code. If you need to get a JSON representation of a span,
   * use `spanToJSON(span)` instead.
   */
  getSpanJSON() {
    return {
      name: this._name ?? "",
      span_id: this._spanId,
      trace_id: this._traceId,
      parent_span_id: this._parentSpanId,
      start_timestamp: this._startTime,
      end_timestamp: this._endTime,
      is_segment: spanIsSegment(this),
      status: getSimpleStatus(this._status),
      attributes: addStatusMessageAttribute(this._attributes, this._status),
      links: getStreamedSpanLinks(this._links)
    };
  }
  /** @inheritdoc */
  isRecording() {
    return !this._endTime && !!this._sampled;
  }
  /**
   * @inheritdoc
   */
  addEvent(name, attributesOrStartTime, startTime) {
    if (this._frozen) {
      return this;
    }
    DEBUG_BUILD && debug.log("[Tracing] Adding an event to span:", name);
    const time = isSpanTimeInput(attributesOrStartTime) ? attributesOrStartTime : startTime || timestampInSeconds();
    const attributes = isSpanTimeInput(attributesOrStartTime) ? {} : attributesOrStartTime || {};
    const event = {
      name,
      time: spanTimeInputToSeconds(time),
      attributes
    };
    this._events.push(event);
    return this;
  }
  /**
   * Whether this span is sent on its own (as a v2 streamed span) rather than as part of a
   * transaction. Used internally; see `_isStandaloneSpan`.
   * @internal
   */
  isStandaloneSpan() {
    return !!this._isStandaloneSpan;
  }
  /**
   * Returns the start time plus the `performance.now()` time since the span started.
   *
   * This way, the duration is correct even if the time origin was corrected while the span was running (e.g. after the
   * device slept), and it can never be negative.
   */
  _getEndTimeFromDuration() {
    const performanceNow = safePerformanceNow();
    if (this._startPerformanceNow == null || performanceNow == null) {
      return timestampInSeconds();
    }
    return this._startTime + (performanceNow - this._startPerformanceNow) / 1e3;
  }
  /** Emit `spanEnd` when the span is ended. */
  _onSpanEnded() {
    const client = getClient();
    client?.emit("spanEnd", this);
    if (this._isStandaloneSpan) {
      if (!client) return;
      if (this._sampled) {
        sendStandaloneSpan(this, client);
        return;
      }
      DEBUG_BUILD && debug.log("[Tracing] Discarding standalone span because its trace was not chosen to be sampled.");
      return;
    }
    client?.emit("afterSpanEnd", this);
    const rootSpan = getRootSpan(this);
    if (rootSpan !== this) {
      const strategy2 = getSegmentSpanCaptureStrategy();
      if (strategy2) {
        const scope2 = getCapturedScopesOnSpan(this).scope || getCurrentScope();
        strategy2.onChildSpanEnded(this, rootSpan, (options) => this._convertSpanToTransaction(options), scope2);
      }
      return;
    }
    if (client && hasSpanStreamingEnabled(client)) {
      client.emit("afterSegmentSpanEnd", this);
      return;
    }
    const scope = getCapturedScopesOnSpan(this).scope || getCurrentScope();
    const strategy = getSegmentSpanCaptureStrategy();
    if (strategy) {
      strategy.onSegmentSpanEnded((options) => this._convertSpanToTransaction(options), scope);
    } else {
      const transactionEvent = this._convertSpanToTransaction();
      if (transactionEvent) {
        scope.captureEvent(transactionEvent);
      }
    }
  }
  /**
   * Finish the transaction & prepare the event to send to Sentry.
   */
  _convertSpanToTransaction(options = {}) {
    if (!isFullFinishedSpan(spanToStaticSpanJSON(this))) {
      return void 0;
    }
    if (!this._name) {
      DEBUG_BUILD && debug.warn("Transaction has no name, falling back to `<unlabeled transaction>`.");
      this._name = "<unlabeled transaction>";
    }
    const { scope: capturedSpanScope, isolationScope: capturedSpanIsolationScope } = getCapturedScopesOnSpan(this);
    const normalizedRequest = capturedSpanScope?.getScopeData().sdkProcessingMetadata?.normalizedRequest;
    if (this._sampled !== true) {
      return void 0;
    }
    options.onSpanCaptured?.(this);
    const spans = [];
    let droppedUnfinishedSpanCount = 0;
    for (const descendant of getSpanDescendants(this)) {
      if (descendant === this || isStandaloneSpan(descendant) || options.isSpanAlreadyCaptured?.(descendant)) {
        continue;
      }
      const spanJSON = spanToStaticSpanJSON(descendant);
      if (!isFullFinishedSpan(spanJSON)) {
        if (!options.onSpanCaptured) {
          droppedUnfinishedSpanCount++;
        }
        continue;
      }
      options.onSpanCaptured?.(descendant);
      spans.push(spanJSON);
    }
    const client = capturedSpanScope?.getClient() || getClient();
    if (droppedUnfinishedSpanCount) {
      client?.recordDroppedEvent("invalid", "span", droppedUnfinishedSpanCount);
    }
    if (spans.length > MAX_SPAN_COUNT) {
      client?.recordDroppedEvent("buffer_overflow", "span", spans.length - MAX_SPAN_COUNT);
    }
    const source = this._attributes[Nm];
    delete this._attributes[SEMANTIC_ATTRIBUTE_SENTRY_CUSTOM_SPAN_NAME];
    let hasGenAiSpans = false;
    spans.forEach((span) => {
      delete span.data[SEMANTIC_ATTRIBUTE_SENTRY_CUSTOM_SPAN_NAME];
      if (span.op?.startsWith("gen_ai.")) {
        hasGenAiSpans = true;
      }
    });
    const transaction = {
      contexts: {
        trace: spanToTransactionTraceContext(this)
      },
      spans: (
        // spans.sort() mutates the array, but `spans` is already a copy so we can safely do this here
        // we do not use spans anymore after this point
        spans.length > MAX_SPAN_COUNT ? spans.sort((a, b2) => a.start_timestamp - b2.start_timestamp).slice(0, MAX_SPAN_COUNT) : spans
      ),
      start_timestamp: this._startTime,
      timestamp: this._endTime,
      transaction: this._name,
      type: "transaction",
      sdkProcessingMetadata: {
        capturedSpanScope,
        capturedSpanIsolationScope,
        dynamicSamplingContext: getDynamicSamplingContextFromSpan(this),
        hasGenAiSpans
      },
      request: normalizedRequest,
      ...source && {
        transaction_info: {
          source
        }
      }
    };
    const measurements = timedEventsToMeasurements(this._events);
    const hasMeasurements = measurements && Object.keys(measurements).length;
    if (hasMeasurements) {
      DEBUG_BUILD && debug.log(
        "[Measurements] Adding measurements to transaction event",
        JSON.stringify(measurements, void 0, 2)
      );
      transaction.measurements = measurements;
    }
    return transaction;
  }
};
function isSpanTimeInput(value) {
  return value && typeof value === "number" || value instanceof Date || Array.isArray(value);
}
__name(isSpanTimeInput, "isSpanTimeInput");
function isFullFinishedSpan(input) {
  return !!input.start_timestamp && !!input.timestamp && !!input.span_id && !!input.trace_id;
}
__name(isFullFinishedSpan, "isFullFinishedSpan");
function isStandaloneSpan(span) {
  return span instanceof SentrySpan && span.isStandaloneSpan();
}
__name(isStandaloneSpan, "isStandaloneSpan");
function sendStandaloneSpan(span, client) {
  const { beforeSendSpan, traceLifecycle } = client.getOptions();
  if (traceLifecycle === "static" && isStaticBeforeSendSpanCallback(beforeSendSpan)) {
    const serializedSpan2 = captureStandaloneSpanWithStaticCallback(span, client, beforeSendSpan);
    const dsc2 = getDynamicSamplingContextFromSpan(span);
    client.sendEnvelope(createStreamedSpanEnvelope([serializedSpan2], dsc2, client));
    return;
  }
  const { _segmentSpan, ...serializedSpan } = captureSpan(span, client);
  const dsc = getDynamicSamplingContextFromSpan(_segmentSpan);
  client.sendEnvelope(createStreamedSpanEnvelope([serializedSpan], dsc, client));
}
__name(sendStandaloneSpan, "sendStandaloneSpan");

// node_modules/@sentry/core/build/esm/tracing/trace.js
function startSpan(options, callback) {
  const spanArguments = parseSentrySpanArguments(options);
  const { forceTransaction, parentSpan: customParentSpan, scope: customScope } = options;
  const customForkedScope = customScope?.clone();
  return withScope2(customForkedScope, () => {
    const wrapper = getActiveSpanWrapper(customParentSpan);
    return wrapper(() => {
      const scope = getCurrentScope();
      const parentSpan = getParentSpan(customScope ?? scope, customParentSpan);
      const client = getClient();
      const missingRequiredParent = options.onlyIfParent && !parentSpan;
      const activeSpan = missingRequiredParent ? startMissingRequiredParentSpan(scope, client) : createChildOrRootSpan({
        parentSpan,
        spanArguments,
        forceTransaction,
        scope
      });
      const makeSpanActive = !spanIsIgnored(activeSpan) || !parentSpan;
      return runCallback(
        activeSpan,
        makeSpanActive,
        () => callback(activeSpan),
        () => activeSpan.end()
      );
    });
  });
}
__name(startSpan, "startSpan");
function startSpanManual(options, callback) {
  const spanArguments = parseSentrySpanArguments(options);
  const { forceTransaction, parentSpan: customParentSpan, scope: customScope } = options;
  const customForkedScope = customScope?.clone();
  return withScope2(customForkedScope, () => {
    const wrapper = getActiveSpanWrapper(customParentSpan);
    return wrapper(() => {
      const scope = getCurrentScope();
      const parentSpan = getParentSpan(customScope ?? scope, customParentSpan);
      const missingRequiredParent = options.onlyIfParent && !parentSpan;
      const activeSpan = missingRequiredParent ? startMissingRequiredParentSpan(scope, getClient()) : createChildOrRootSpan({
        parentSpan,
        spanArguments,
        forceTransaction,
        scope
      });
      const makeSpanActive = !spanIsIgnored(activeSpan) || !parentSpan;
      return runCallback(activeSpan, makeSpanActive, () => callback(activeSpan, () => activeSpan.end()));
    });
  });
}
__name(startSpanManual, "startSpanManual");
function startInactiveSpan(options) {
  const spanArguments = parseSentrySpanArguments(options);
  const { forceTransaction, parentSpan: customParentSpan, scope: customScope } = options;
  const wrapper = customScope ? (callback) => withScope2(customScope, callback) : customParentSpan !== void 0 ? (callback) => withActiveSpan(customParentSpan, callback) : (callback) => callback();
  return wrapper(() => {
    const scope = getCurrentScope();
    const parentSpan = getParentSpan(customScope ?? scope, customParentSpan);
    const client = getClient();
    const missingRequiredParent = options.onlyIfParent && !parentSpan;
    if (missingRequiredParent) {
      return startMissingRequiredParentSpan(scope, client);
    }
    return createChildOrRootSpan({
      parentSpan,
      spanArguments,
      forceTransaction,
      scope
    });
  });
}
__name(startInactiveSpan, "startInactiveSpan");
var continueTrace = /* @__PURE__ */ __name((options, callback) => {
  const carrier = getMainCarrier();
  const acs = getAsyncContextStrategy(carrier);
  if (acs.continueTrace) {
    return acs.continueTrace(options, callback);
  }
  const { sentryTrace, baggage } = options;
  const client = getClient();
  const incomingDsc = baggageHeaderToDynamicSamplingContext(baggage);
  if (client && !shouldContinueTrace(client, incomingDsc?.org_id)) {
    return startNewTrace(callback);
  }
  return withScope2((scope) => {
    const propagationContext = propagationContextFromHeaders(sentryTrace, baggage);
    scope.setPropagationContext(propagationContext);
    return withActiveSpan(null, callback);
  });
}, "continueTrace");
function withActiveSpan(span, callback) {
  const acs = getAcs();
  if (acs.withActiveSpan) {
    return acs.withActiveSpan(span, callback);
  }
  return withScope2((scope) => {
    _setSpanForScope(scope, span || void 0);
    return callback(scope);
  });
}
__name(withActiveSpan, "withActiveSpan");
function suppressTracing(callback) {
  const acs = getAcs();
  if (acs.suppressTracing) {
    return acs.suppressTracing(callback);
  }
  return withScope2((scope) => {
    scope.setSDKProcessingMetadata({ [SUPPRESS_TRACING_KEY]: true });
    return callback();
  });
}
__name(suppressTracing, "suppressTracing");
function isTracingSuppressed(scope = getCurrentScope()) {
  const acs = getAcs();
  if (acs.isTracingSuppressed) {
    return acs.isTracingSuppressed(scope);
  }
  return scope.getScopeData().sdkProcessingMetadata[SUPPRESS_TRACING_KEY] === true;
}
__name(isTracingSuppressed, "isTracingSuppressed");
function startNewTrace(callback) {
  const acs = getAcs();
  if (acs.startNewTrace) {
    return acs.startNewTrace(callback);
  }
  return withActiveSpan(null, () => {
    return withScope2((scope) => {
      scope.setPropagationContext({
        traceId: generateTraceId(),
        sampleRand: safeMathRandom()
      });
      DEBUG_BUILD && debug.log(`Starting a new trace with id ${scope.getPropagationContext().traceId}`);
      return callback();
    });
  });
}
__name(startNewTrace, "startNewTrace");
function startMissingRequiredParentSpan(scope, client) {
  client?.recordDroppedEvent("no_parent_span", "span");
  const span = new SentryNonRecordingSpan({
    dropReason: "no_parent_span",
    traceId: scope.getPropagationContext().traceId
  });
  setCapturedScopesOnSpan(span, scope, getIsolationScope());
  return span;
}
__name(startMissingRequiredParentSpan, "startMissingRequiredParentSpan");
function createChildOrRootSpan({
  parentSpan: resolvedParentSpan,
  spanArguments,
  forceTransaction,
  scope: currentScope
}) {
  const isolationScope = getIsolationScope();
  const spanScope = {
    scope: currentScope,
    parentSpan: resolvedParentSpan
  };
  getClient()?.emit("prepareSpanScope", spanScope);
  const { scope, parentSpan } = spanScope;
  if (!hasSpansEnabled()) {
    const scopePropagationContext = scope.getPropagationContext();
    const traceId = parentSpan ? parentSpan.spanContext().traceId : scopePropagationContext.traceId;
    const span2 = new SentryNonRecordingSpan({ traceId });
    if (parentSpan && !forceTransaction) {
      addChildSpanToSpan(parentSpan, span2);
    }
    setCapturedScopesOnSpan(span2, scope, isolationScope);
    return span2;
  }
  const client = getClient();
  if (_shouldIgnoreStreamedSpan(client, spanArguments)) {
    if (!isTracingSuppressed(scope)) {
      client?.recordDroppedEvent("ignored", "span");
    }
    const ignoredSpan = new SentryNonRecordingSpan({
      dropReason: "ignored",
      traceId: parentSpan?.spanContext().traceId ?? scope.getPropagationContext().traceId
    });
    if (parentSpan && !forceTransaction) {
      addChildSpanToSpan(parentSpan, ignoredSpan);
    }
    setCapturedScopesOnSpan(ignoredSpan, scope, isolationScope);
    return ignoredSpan;
  }
  let span;
  if (parentSpan && !forceTransaction) {
    span = _startChildSpan(parentSpan, scope, spanArguments, isolationScope);
    addChildSpanToSpan(parentSpan, span);
  } else if (parentSpan) {
    const dsc = getDynamicSamplingContextFromSpan(parentSpan);
    const { traceId, spanId: parentSpanId } = parentSpan.spanContext();
    const parentSampled = spanIsSampled(parentSpan);
    span = _startRootSpan(
      {
        traceId,
        parentSpanId,
        ...spanArguments
      },
      scope,
      isolationScope,
      parentSampled
    );
    freezeDscOnSpan(span, dsc);
  } else {
    const { traceId, dsc, parentSpanId, sampled: parentSampled, sampleRand } = scope.getPropagationContext();
    span = _startRootSpan(
      {
        traceId,
        parentSpanId,
        ...spanArguments
      },
      scope,
      isolationScope,
      parentSampled
    );
    if (dsc) {
      const dscWithSampleRand = Object.keys(dsc).length === 0 && sampleRand !== void 0 ? { sample_rand: sampleRand.toString() } : dsc;
      freezeDscOnSpan(span, dscWithSampleRand);
    }
  }
  logSpanStart(span);
  return span;
}
__name(createChildOrRootSpan, "createChildOrRootSpan");
function parseSentrySpanArguments(options) {
  const initialCtx = {
    // TODO(standalone): remove once the static (transaction) trace lifecycle is dropped.
    // oxlint-disable-next-line typescript/no-deprecated
    isStandalone: options.experimental?.standalone,
    ...options
  };
  if (options.op) {
    initialCtx.attributes = {
      [mm]: options.op,
      ...options.attributes
    };
  }
  if (options.startTime) {
    const ctx = { ...initialCtx };
    ctx.startTimestamp = spanTimeInputToSeconds(options.startTime);
    delete ctx.startTime;
    return ctx;
  }
  return initialCtx;
}
__name(parseSentrySpanArguments, "parseSentrySpanArguments");
function getAcs() {
  const carrier = getMainCarrier();
  return getAsyncContextStrategy(carrier);
}
__name(getAcs, "getAcs");
function _startRootSpan(spanArguments, scope, isolationScope, parentSampled) {
  const client = getClient();
  const options = client?.getOptions() || {};
  const { name = "" } = spanArguments;
  const mutableSpanSamplingData = { spanAttributes: { ...spanArguments.attributes }, spanName: name, parentSampled };
  client?.emit("beforeSampling", mutableSpanSamplingData, { decision: false });
  const finalParentSampled = mutableSpanSamplingData.parentSampled ?? parentSampled;
  const finalAttributes = mutableSpanSamplingData.spanAttributes;
  const currentPropagationContext = scope.getPropagationContext();
  const _isTracingSuppressed = isTracingSuppressed(scope);
  const [sampled, sampleRate, localSampleRateWasApplied, dropReason] = _isTracingSuppressed ? [false] : sampleSpan(
    options,
    {
      name,
      parentSampled: finalParentSampled,
      attributes: finalAttributes,
      normalizedRequest: isolationScope.getScopeData().sdkProcessingMetadata.normalizedRequest,
      parentSampleRate: parseSampleRate(currentPropagationContext.dsc?.sample_rate)
    },
    currentPropagationContext.sampleRand
  );
  const rootSpan = new SentrySpan({
    ...spanArguments,
    attributes: {
      [Nm]: "custom",
      [SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE]: sampleRate !== void 0 && localSampleRateWasApplied ? sampleRate : void 0,
      ...finalAttributes
    },
    sampled
  });
  if (!sampled && client && !_isTracingSuppressed) {
    DEBUG_BUILD && debug.log("[Tracing] Discarding root span because its trace was not chosen to be sampled.");
    const outcomeReason = dropReason || "sample_rate";
    if (!hasSpanStreamingEnabled(client) && !spanArguments.isStandalone) {
      client.recordDroppedEvent(outcomeReason, "transaction");
    }
    client.recordDroppedEvent(outcomeReason, "span");
  }
  setCapturedScopesOnSpan(rootSpan, scope, isolationScope);
  if (client) {
    client.emit("spanStart", rootSpan);
  }
  return rootSpan;
}
__name(_startRootSpan, "_startRootSpan");
function _startChildSpan(parentSpan, scope, spanArguments, isolationScope) {
  const { spanId, traceId } = parentSpan.spanContext();
  const _isTracingSuppressed = isTracingSuppressed(scope);
  const sampled = _isTracingSuppressed ? false : spanIsSampled(parentSpan);
  const childSpan = sampled ? new SentrySpan({
    ...spanArguments,
    parentSpanId: spanId,
    traceId,
    sampled
  }) : new SentryNonRecordingSpan({ traceId });
  addChildSpanToSpan(parentSpan, childSpan);
  setCapturedScopesOnSpan(childSpan, scope, isolationScope);
  const client = getClient();
  if (!client) {
    return childSpan;
  }
  if (spanIsNonRecordingSpan(childSpan)) {
    if (spanIsNonRecordingSpan(parentSpan) && parentSpan.dropReason) {
      childSpan.dropReason = parentSpan.dropReason;
      client.recordDroppedEvent(parentSpan.dropReason, "span");
    } else if (!_isTracingSuppressed) {
      childSpan.dropReason = "sample_rate";
      client.recordDroppedEvent("sample_rate", "span");
    }
  }
  client.emit("spanStart", childSpan);
  return childSpan;
}
__name(_startChildSpan, "_startChildSpan");
function getParentSpan(scope, customParentSpan) {
  if (customParentSpan) {
    return customParentSpan;
  }
  if (customParentSpan === null) {
    return void 0;
  }
  const span = getActiveSpan(scope);
  if (!span) {
    return void 0;
  }
  const client = getClient();
  const options = client ? client.getOptions() : {};
  if (options.parentSpanIsAlwaysRootSpan) {
    return getRootSpan(span);
  }
  return span;
}
__name(getParentSpan, "getParentSpan");
function getActiveSpanWrapper(parentSpan) {
  return parentSpan !== void 0 ? (callback) => {
    return withActiveSpan(parentSpan, callback);
  } : (callback) => callback();
}
__name(getActiveSpanWrapper, "getActiveSpanWrapper");
function _shouldIgnoreStreamedSpan(client, spanArguments) {
  const ignoreSpans = client?.getOptions().ignoreSpans;
  if (!client || !hasSpanStreamingEnabled(client) || !ignoreSpans?.length) {
    return false;
  }
  return shouldIgnoreSpan(
    {
      description: spanArguments.name || "",
      op: spanArguments.attributes?.[mm] || spanArguments.op,
      attributes: spanArguments.attributes
    },
    ignoreSpans
  );
}
__name(_shouldIgnoreStreamedSpan, "_shouldIgnoreStreamedSpan");
function spanIsIgnored(span) {
  return spanIsNonRecordingSpan(span) && span.dropReason === "ignored";
}
__name(spanIsIgnored, "spanIsIgnored");
function runCallback(span, makeSpanActive, callback, finallyCallback) {
  const wrapper = makeSpanActive ? (callback2) => {
    return withActiveSpan(span, () => {
      const scope = getCurrentScope();
      const creationScope = getCapturedScopesOnSpan(span).scope;
      if (creationScope) {
        scope.setPropagationContext(creationScope.getPropagationContext());
      }
      setCapturedScopesOnSpan(span, scope, getIsolationScope());
      return callback2();
    });
  } : (callback2) => callback2();
  return wrapper(
    () => handleCallbackErrors(
      () => callback(),
      (error2) => {
        recordEscapedErrorSpan(error2, span);
        const { status } = spanToStaticSpanJSON(span);
        if (span.isRecording() && status === "ok") {
          span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
        }
      },
      finallyCallback
    )
  );
}
__name(runCallback, "runCallback");

// node_modules/@sentry/core/build/esm/tracing/spans/spanNames.js
init_modules_watch_stub();

// node_modules/@sentry/conventions/dist/op.mjs
init_modules_watch_stub();
var S = "browser.unload_event";
var l = "browser.redirect";
var L = "browser.dom_content_loaded_event";
var p = "browser.load_event";
var P = "browser.connect";
var d = "browser.tls_ssl";
var D = "browser.cache";
var b = "browser.dns";
var B = "browser.request";
var m = "browser.response";
var _e = "db";
var re = "db.query";
var te = "cache.get";
var Te = "cache.put";
var ue = "cache.remove";
var Oe = "gen_ai.chat";
var Ce = "gen_ai.embeddings";
var se = "gen_ai.decide";
var De = "function";
var Ge = "queue.publish";
var qe = "queue.process";
var ze = "object.get";
var Ze = "object.head";
var $e = "object.put";
var eE = "object.delete";
var EE = "object.list";
var _E = "object.upload_part";
var rE = "object.multipart_upload.abort";
var RE = "object.multipart_upload.create";
var tE = "object.multipart_upload.complete";
var UE = "http.client";
var IE = "http.server";
var OE = "rpc";

// node_modules/@sentry/core/build/esm/tracing/spans/spanNames.js
var HTTP_SPAN_NAME_FALLBACK = "HTTP";
var CACHE_OPERATION_NAMES = {
  [te]: "get",
  [Te]: "put",
  [ue]: "remove"
};
var BROWSER_NAVIGATION_TIMING_SPAN_NAMES = {
  [D]: "Cache lookup",
  [b]: "DNS lookup",
  [P]: "Connect",
  [d]: "TLS handshake",
  [l]: "Redirect",
  [B]: "Request",
  [m]: "Response",
  [S]: "Unload event",
  [L]: "DOMContentLoaded event",
  [p]: "Load event"
};

// node_modules/@sentry/core/build/esm/envelope.js
init_modules_watch_stub();
function _enhanceEventWithSdkInfo(event, newSdkInfo) {
  if (!newSdkInfo) {
    return event;
  }
  const eventSdkInfo = event.sdk || {};
  event.sdk = {
    ...eventSdkInfo,
    name: eventSdkInfo.name || newSdkInfo.name,
    version: eventSdkInfo.version || newSdkInfo.version,
    integrations: [...event.sdk?.integrations || [], ...newSdkInfo.integrations || []],
    packages: [...event.sdk?.packages || [], ...newSdkInfo.packages || []],
    settings: event.sdk?.settings || newSdkInfo.settings ? {
      ...event.sdk?.settings,
      ...newSdkInfo.settings
    } : void 0
  };
  return event;
}
__name(_enhanceEventWithSdkInfo, "_enhanceEventWithSdkInfo");
function createSessionEnvelope(session, dsn, metadata, tunnel) {
  const sdkInfo = getSdkMetadataForEnvelopeHeader(metadata);
  const envelopeHeaders = {
    sent_at: new Date(safeDateNow()).toISOString(),
    ...sdkInfo && { sdk: sdkInfo },
    ...!!tunnel && dsn && { dsn: dsnToString(dsn) }
  };
  const envelopeItem = "aggregates" in session ? [{ type: "sessions" }, session] : [{ type: "session" }, session.toJSON()];
  return createEnvelope(envelopeHeaders, [envelopeItem]);
}
__name(createSessionEnvelope, "createSessionEnvelope");
function createEventEnvelope(event, dsn, metadata, tunnel) {
  const sdkInfo = getSdkMetadataForEnvelopeHeader(metadata);
  const eventType = event.type && event.type !== "replay_event" ? event.type : "event";
  _enhanceEventWithSdkInfo(event, metadata?.sdk);
  const envelopeHeaders = createEventEnvelopeHeaders(event, sdkInfo, tunnel, dsn);
  delete event.sdkProcessingMetadata;
  const eventItem = [{ type: eventType }, event];
  return createEnvelope(envelopeHeaders, [eventItem]);
}
__name(createEventEnvelope, "createEventEnvelope");

// node_modules/@sentry/core/build/esm/exports.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/prepareEvent.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/eventProcessors.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/syncpromise.js
init_modules_watch_stub();
var STATE_PENDING = 0;
var STATE_RESOLVED = 1;
var STATE_REJECTED = 2;
function resolvedSyncPromise(value) {
  return new SyncPromise((resolve2) => {
    resolve2(value);
  });
}
__name(resolvedSyncPromise, "resolvedSyncPromise");
function rejectedSyncPromise(reason) {
  return new SyncPromise((_, reject) => {
    reject(reason);
  });
}
__name(rejectedSyncPromise, "rejectedSyncPromise");
var SyncPromise = class _SyncPromise {
  static {
    __name(this, "SyncPromise");
  }
  constructor(executor) {
    this._state = STATE_PENDING;
    this._handlers = [];
    this._runExecutor(executor);
  }
  /** @inheritdoc */
  then(onfulfilled, onrejected) {
    return new _SyncPromise((resolve2, reject) => {
      this._handlers.push([
        false,
        (result) => {
          if (!onfulfilled) {
            resolve2(result);
          } else {
            try {
              resolve2(onfulfilled(result));
            } catch (e) {
              reject(e);
            }
          }
        },
        (reason) => {
          if (!onrejected) {
            reject(reason);
          } else {
            try {
              resolve2(onrejected(reason));
            } catch (e) {
              reject(e);
            }
          }
        }
      ]);
      this._executeHandlers();
    });
  }
  /** @inheritdoc */
  catch(onrejected) {
    return this.then((val) => val, onrejected);
  }
  /** @inheritdoc */
  finally(onfinally) {
    return new _SyncPromise((resolve2, reject) => {
      let val;
      let isRejected;
      return this.then(
        (value) => {
          isRejected = false;
          val = value;
          if (onfinally) {
            onfinally();
          }
        },
        (reason) => {
          isRejected = true;
          val = reason;
          if (onfinally) {
            onfinally();
          }
        }
      ).then(() => {
        if (isRejected) {
          reject(val);
          return;
        }
        resolve2(val);
      });
    });
  }
  /** Excute the resolve/reject handlers. */
  _executeHandlers() {
    if (this._state === STATE_PENDING) {
      return;
    }
    const cachedHandlers = this._handlers.slice();
    this._handlers = [];
    cachedHandlers.forEach((handler) => {
      if (handler[0]) {
        return;
      }
      if (this._state === STATE_RESOLVED) {
        handler[1](this._value);
      }
      if (this._state === STATE_REJECTED) {
        handler[2](this._value);
      }
      handler[0] = true;
    });
  }
  /** Run the executor for the SyncPromise. */
  _runExecutor(executor) {
    const setResult = /* @__PURE__ */ __name((state, value) => {
      if (this._state !== STATE_PENDING) {
        return;
      }
      if (isThenable(value)) {
        void value.then(resolve2, reject);
        return;
      }
      this._state = state;
      this._value = value;
      this._executeHandlers();
    }, "setResult");
    const resolve2 = /* @__PURE__ */ __name((value) => {
      setResult(STATE_RESOLVED, value);
    }, "resolve");
    const reject = /* @__PURE__ */ __name((reason) => {
      setResult(STATE_REJECTED, reason);
    }, "reject");
    try {
      executor(resolve2, reject);
    } catch (e) {
      reject(e);
    }
  }
};

// node_modules/@sentry/core/build/esm/eventProcessors.js
function notifyEventProcessors(processors, event, hint, index = 0, onDrop) {
  try {
    const result = _notifyEventProcessors(event, hint, processors, index, onDrop);
    return isThenable(result) ? result : resolvedSyncPromise(result);
  } catch (error2) {
    return rejectedSyncPromise(error2);
  }
}
__name(notifyEventProcessors, "notifyEventProcessors");
function _notifyEventProcessors(event, hint, processors, index, onDrop) {
  const processor = processors[index];
  if (!event || !processor) {
    return event;
  }
  const processorName = `Event processor "${processor.id || "?"}"`;
  let callbackError = false;
  const result = safeCallback(
    DEBUG_BUILD ? `${processorName} threw an error, dropping event:` : "",
    () => processor({ ...event }, hint),
    () => {
      callbackError = true;
      return null;
    }
  );
  DEBUG_BUILD && result === null && debug.log(`${processorName} dropped event`);
  if (isThenable(result)) {
    return result.then((final) => {
      if (!final) {
        onDrop?.(callbackError ? "callback_error" : "event_processor");
        return null;
      }
      return _notifyEventProcessors(final, hint, processors, index + 1, onDrop);
    });
  }
  if (!result) {
    onDrop?.(callbackError ? "callback_error" : "event_processor");
    return null;
  }
  return _notifyEventProcessors(result, hint, processors, index + 1, onDrop);
}
__name(_notifyEventProcessors, "_notifyEventProcessors");

// node_modules/@sentry/core/build/esm/utils/debug-ids.js
init_modules_watch_stub();
var parsedStackResults;
var lastSentryKeysCount;
var lastNativeKeysCount;
var cachedFilenameDebugIds;
function getFilenameToDebugIdMap(stackParser) {
  const sentryDebugIdMap = GLOBAL_OBJ._sentryDebugIds;
  const nativeDebugIdMap = GLOBAL_OBJ._debugIds;
  if (!sentryDebugIdMap && !nativeDebugIdMap) {
    return {};
  }
  const sentryDebugIdKeys = sentryDebugIdMap ? Object.keys(sentryDebugIdMap) : [];
  const nativeDebugIdKeys = nativeDebugIdMap ? Object.keys(nativeDebugIdMap) : [];
  if (cachedFilenameDebugIds && sentryDebugIdKeys.length === lastSentryKeysCount && nativeDebugIdKeys.length === lastNativeKeysCount) {
    return cachedFilenameDebugIds;
  }
  lastSentryKeysCount = sentryDebugIdKeys.length;
  lastNativeKeysCount = nativeDebugIdKeys.length;
  cachedFilenameDebugIds = {};
  if (!parsedStackResults) {
    parsedStackResults = {};
  }
  const processDebugIds = /* @__PURE__ */ __name((debugIdKeys, debugIdMap) => {
    for (const key of debugIdKeys) {
      const debugId = debugIdMap[key];
      const result = parsedStackResults?.[key];
      if (result && cachedFilenameDebugIds && debugId) {
        cachedFilenameDebugIds[result[0]] = debugId;
        if (parsedStackResults) {
          parsedStackResults[key] = [result[0], debugId];
        }
      } else if (debugId) {
        const parsedStack = stackParser(key);
        for (let i = parsedStack.length - 1; i >= 0; i--) {
          const stackFrame = parsedStack[i];
          const filename = stackFrame?.filename;
          if (filename && cachedFilenameDebugIds && parsedStackResults) {
            cachedFilenameDebugIds[filename] = debugId;
            parsedStackResults[key] = [filename, debugId];
            break;
          }
        }
      }
    }
  }, "processDebugIds");
  if (sentryDebugIdMap) {
    processDebugIds(sentryDebugIdKeys, sentryDebugIdMap);
  }
  if (nativeDebugIdMap) {
    processDebugIds(nativeDebugIdKeys, nativeDebugIdMap);
  }
  return cachedFilenameDebugIds;
}
__name(getFilenameToDebugIdMap, "getFilenameToDebugIdMap");

// node_modules/@sentry/core/build/esm/utils/eventUtils.js
init_modules_watch_stub();
function isInternalException(hint) {
  return hint.data?.__sentry__ === true;
}
__name(isInternalException, "isInternalException");
function getPossibleEventMessages(event) {
  const possibleMessages = [];
  if (event.message) {
    possibleMessages.push(event.message);
  }
  try {
    const lastException = event.exception.values[event.exception.values.length - 1];
    if (lastException?.value) {
      possibleMessages.push(lastException.value);
      if (lastException.type) {
        possibleMessages.push(`${lastException.type}: ${lastException.value}`);
      }
    }
  } catch {
  }
  return possibleMessages;
}
__name(getPossibleEventMessages, "getPossibleEventMessages");

// node_modules/@sentry/core/build/esm/utils/prepareEvent.js
function prepareEvent(options, event, hint, scope, client, isolationScope) {
  const { normalizeDepth = 3, normalizeMaxBreadth = 1e3 } = options;
  const prepared = {
    ...event,
    event_id: event.event_id || hint.event_id || uuid4(),
    timestamp: event.timestamp || dateTimestampInSeconds()
  };
  const integrations = hint.integrations || options.integrations.map((i) => i.name);
  applyClientOptions(prepared, options);
  applyIntegrationsMetadata(prepared, integrations);
  if (client) {
    client.emit("applyFrameMetadata", event);
  }
  if (event.type === void 0) {
    applyDebugIds(prepared, options.stackParser);
  }
  const finalScope = getFinalScope(scope, hint.captureContext);
  if (hint.mechanism) {
    addExceptionMechanismToCapturedException(prepared, hint.mechanism);
  }
  const clientEventProcessors = client ? client.getEventProcessors() : [];
  const data = getCombinedScopeData(isolationScope, finalScope);
  const attachments = [...hint.attachments || [], ...data.attachments];
  if (attachments.length) {
    hint.attachments = attachments;
  }
  applyScopeDataToEvent(prepared, data);
  const span = getActiveSpan(finalScope);
  if (span) {
    applySpanToEvent(prepared, span);
  }
  applyEscapedErrorSpanToEvent(prepared, hint, finalScope);
  const eventProcessors = [
    ...clientEventProcessors,
    // Run scope event processors _after_ all other processors
    ...data.eventProcessors
  ];
  const isTransaction = event.type === "transaction";
  const spanCountBeforeProcessing = event.spans?.length || 0;
  const result = isInternalException(hint) ? resolvedSyncPromise(prepared) : notifyEventProcessors(eventProcessors, prepared, hint, 0, (reason) => {
    if (!client) {
      return;
    }
    client.recordDroppedEvent(reason, getDataCategoryByType(event.type));
    if (isTransaction) {
      client.recordDroppedEvent(reason, "span", 1 + spanCountBeforeProcessing);
    }
  });
  return result.then((evt) => {
    if (!evt) {
      return null;
    }
    if (isTransaction && client) {
      const droppedSpanCount = spanCountBeforeProcessing - (evt.spans?.length || 0);
      if (droppedSpanCount > 0) {
        client.recordDroppedEvent("event_processor", "span", droppedSpanCount);
      }
    }
    applyDebugMeta(evt);
    if (typeof normalizeDepth === "number" && normalizeDepth > 0) {
      return normalizeEvent(evt, normalizeDepth, normalizeMaxBreadth);
    }
    return evt;
  });
}
__name(prepareEvent, "prepareEvent");
function applyClientOptions(event, options) {
  const { environment, release, dist, maxValueLength } = options;
  event.environment = event.environment || environment || DEFAULT_ENVIRONMENT;
  if (!event.release && release) {
    event.release = release;
  }
  if (!event.dist && dist) {
    event.dist = dist;
  }
  const request = event.request;
  if (request?.url && maxValueLength) {
    request.url = truncate(request.url, maxValueLength);
  }
  if (maxValueLength) {
    event.exception?.values?.forEach((exception) => {
      if (exception.value) {
        exception.value = truncate(exception.value, maxValueLength);
      }
    });
  }
}
__name(applyClientOptions, "applyClientOptions");
function applyDebugIds(event, stackParser) {
  const filenameDebugIdMap = getFilenameToDebugIdMap(stackParser);
  event.exception?.values?.forEach((exception) => {
    exception.stacktrace?.frames?.forEach((frame) => {
      if (frame.filename) {
        frame.debug_id = filenameDebugIdMap[frame.filename];
      }
    });
  });
}
__name(applyDebugIds, "applyDebugIds");
function applyDebugMeta(event) {
  const filenameDebugIdMap = {};
  event.exception?.values?.forEach((exception) => {
    exception.stacktrace?.frames?.forEach((frame) => {
      if (frame.debug_id) {
        if (frame.abs_path) {
          filenameDebugIdMap[frame.abs_path] = frame.debug_id;
        } else if (frame.filename) {
          filenameDebugIdMap[frame.filename] = frame.debug_id;
        }
        delete frame.debug_id;
      }
    });
  });
  if (Object.keys(filenameDebugIdMap).length === 0) {
    return;
  }
  event.debug_meta = event.debug_meta || {};
  event.debug_meta.images = event.debug_meta.images || [];
  const images = event.debug_meta.images;
  Object.entries(filenameDebugIdMap).forEach(([filename, debug_id]) => {
    images.push({
      type: "sourcemap",
      code_file: filename,
      debug_id
    });
  });
}
__name(applyDebugMeta, "applyDebugMeta");
function applyIntegrationsMetadata(event, integrationNames) {
  if (integrationNames.length > 0) {
    event.sdk = event.sdk || {};
    event.sdk.integrations = [...event.sdk.integrations || [], ...integrationNames];
  }
}
__name(applyIntegrationsMetadata, "applyIntegrationsMetadata");
function normalizeEvent(event, depth, maxBreadth) {
  if (!event) {
    return null;
  }
  const normalized = {
    ...event,
    ...event.breadcrumbs && {
      breadcrumbs: event.breadcrumbs.map((b2) => ({
        ...b2,
        ...b2.data && {
          data: normalize(b2.data, depth, maxBreadth)
        }
      }))
    },
    ...event.user && {
      user: normalize(event.user, depth, maxBreadth)
    },
    ...event.contexts && {
      contexts: normalize(event.contexts, depth, maxBreadth)
    },
    ...event.extra && {
      extra: normalize(event.extra, depth, maxBreadth)
    }
  };
  if (event.contexts?.trace && normalized.contexts) {
    normalized.contexts.trace = event.contexts.trace;
    if (event.contexts.trace.data) {
      normalized.contexts.trace.data = normalize(event.contexts.trace.data, depth, maxBreadth);
    }
  }
  if (event.spans) {
    normalized.spans = event.spans.map((span) => {
      return {
        ...span,
        ...span.data && {
          data: normalize(span.data, depth, maxBreadth)
        }
      };
    });
  }
  if (event.contexts?.flags && normalized.contexts) {
    normalized.contexts.flags = normalize(event.contexts.flags, 3, maxBreadth);
  }
  return normalized;
}
__name(normalizeEvent, "normalizeEvent");
function getFinalScope(scope, captureContext) {
  if (!captureContext) {
    return scope;
  }
  const finalScope = scope ? scope.clone() : new Scope();
  finalScope.update(captureContext);
  return finalScope;
}
__name(getFinalScope, "getFinalScope");
function parseEventHintOrCaptureContext(hint) {
  if (!hint) {
    return void 0;
  }
  if (hintIsScopeOrFunction(hint)) {
    return { captureContext: hint };
  }
  if (hintIsScopeContext(hint)) {
    return {
      captureContext: hint
    };
  }
  return hint;
}
__name(parseEventHintOrCaptureContext, "parseEventHintOrCaptureContext");
function hintIsScopeOrFunction(hint) {
  return hint instanceof Scope || typeof hint === "function";
}
__name(hintIsScopeOrFunction, "hintIsScopeOrFunction");
var captureContextKeys = [
  "user",
  "level",
  "extra",
  "contexts",
  "tags",
  "fingerprint",
  "propagationContext"
];
function hintIsScopeContext(hint) {
  return Object.keys(hint).some((key) => captureContextKeys.includes(key));
}
__name(hintIsScopeContext, "hintIsScopeContext");

// node_modules/@sentry/core/build/esm/exports.js
function captureException(exception, hint) {
  return getCurrentScope().captureException(exception, parseEventHintOrCaptureContext(hint));
}
__name(captureException, "captureException");
async function flush(timeout) {
  const client = getClient();
  if (client) {
    return client.flush(timeout);
  }
  DEBUG_BUILD && debug.warn("Cannot flush events. No client defined.");
  return Promise.resolve(false);
}
__name(flush, "flush");
function isEnabled2() {
  const client = getClient();
  return client?.getOptions().enabled !== false && !!client?.getTransport();
}
__name(isEnabled2, "isEnabled");

// node_modules/@sentry/core/build/esm/api.js
init_modules_watch_stub();
var SENTRY_API_VERSION = "7";
function getBaseApiEndpoint(dsn) {
  const protocol = dsn.protocol ? `${dsn.protocol}:` : "";
  const port = dsn.port ? `:${dsn.port}` : "";
  return `${protocol}//${dsn.host}${port}${dsn.path ? `/${dsn.path}` : ""}/api/`;
}
__name(getBaseApiEndpoint, "getBaseApiEndpoint");
function _getIngestEndpoint(dsn) {
  return `${getBaseApiEndpoint(dsn)}${dsn.projectId}/envelope/`;
}
__name(_getIngestEndpoint, "_getIngestEndpoint");
function _encodedAuth(dsn, sdkInfo) {
  const params = {
    sentry_version: SENTRY_API_VERSION
  };
  if (dsn.publicKey) {
    params.sentry_key = dsn.publicKey;
  }
  if (sdkInfo) {
    params.sentry_client = `${sdkInfo.name}/${sdkInfo.version}`;
  }
  return new URLSearchParams(params).toString();
}
__name(_encodedAuth, "_encodedAuth");
function getEnvelopeEndpointWithUrlEncodedAuth(dsn, tunnel, sdkInfo) {
  return tunnel ? tunnel : `${_getIngestEndpoint(dsn)}?${_encodedAuth(dsn, sdkInfo)}`;
}
__name(getEnvelopeEndpointWithUrlEncodedAuth, "getEnvelopeEndpointWithUrlEncodedAuth");

// node_modules/@sentry/core/build/esm/client.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/logs/internal.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/trace-info.js
init_modules_watch_stub();
function _getTraceInfoFromScope(client, scope) {
  if (!scope) {
    return [void 0, void 0];
  }
  return withScope2(scope, () => {
    const span = getActiveSpan();
    const traceContext = span ? spanToTraceContext(span) : getTraceContextFromScope(scope);
    const dynamicSamplingContext = span ? getDynamicSamplingContextFromSpan(span) : getDynamicSamplingContextFromScope(client, scope);
    return [dynamicSamplingContext, traceContext];
  });
}
__name(_getTraceInfoFromScope, "_getTraceInfoFromScope");

// node_modules/@sentry/core/build/esm/logs/envelope.js
init_modules_watch_stub();
function createLogContainerEnvelopeItem(items, inferUserData) {
  const inferSetting = inferUserData ? "auto" : "never";
  return [
    {
      type: "log",
      item_count: items.length,
      content_type: "application/vnd.sentry.items.log+json"
    },
    {
      version: 2,
      ...isBrowser() && {
        ingest_settings: { infer_ip: inferSetting, infer_user_agent: inferSetting }
      },
      items
    }
  ];
}
__name(createLogContainerEnvelopeItem, "createLogContainerEnvelopeItem");
function createLogEnvelope(logs, metadata, tunnel, dsn, inferUserData) {
  const headers = {};
  if (metadata?.sdk) {
    headers.sdk = {
      name: metadata.sdk.name,
      version: metadata.sdk.version
    };
  }
  if (!!tunnel && !!dsn) {
    headers.dsn = dsnToString(dsn);
  }
  return createEnvelope(headers, [createLogContainerEnvelopeItem(logs, inferUserData)]);
}
__name(createLogEnvelope, "createLogEnvelope");

// node_modules/@sentry/core/build/esm/logs/internal.js
function _INTERNAL_flushLogsBuffer(client, maybeLogBuffer) {
  const logBuffer = maybeLogBuffer ?? _INTERNAL_getLogBuffer(client) ?? [];
  if (logBuffer.length === 0) {
    return;
  }
  const clientOptions = client.getOptions();
  const envelope = createLogEnvelope(
    logBuffer,
    clientOptions._metadata,
    clientOptions.tunnel,
    client.getDsn(),
    client.getDataCollectionOptions().userInfo
  );
  _getBufferMap().set(client, []);
  client.emit("flushLogs");
  client.sendEnvelope(envelope);
}
__name(_INTERNAL_flushLogsBuffer, "_INTERNAL_flushLogsBuffer");
function _INTERNAL_getLogBuffer(client) {
  return _getBufferMap().get(client);
}
__name(_INTERNAL_getLogBuffer, "_INTERNAL_getLogBuffer");
function _getBufferMap() {
  return getGlobalSingleton("clientToLogBufferMap", () => /* @__PURE__ */ new WeakMap());
}
__name(_getBufferMap, "_getBufferMap");

// node_modules/@sentry/core/build/esm/metrics/internal.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/metrics/envelope.js
init_modules_watch_stub();
function createMetricContainerEnvelopeItem(items, inferUserData) {
  const inferSetting = inferUserData ? "auto" : "never";
  return [
    {
      type: "trace_metric",
      item_count: items.length,
      content_type: "application/vnd.sentry.items.trace-metric+json"
    },
    {
      version: 2,
      ...isBrowser() && {
        ingest_settings: { infer_ip: inferSetting, infer_user_agent: inferSetting }
      },
      items
    }
  ];
}
__name(createMetricContainerEnvelopeItem, "createMetricContainerEnvelopeItem");
function createMetricEnvelope(metrics, metadata, tunnel, dsn, inferUserData) {
  const headers = {};
  if (metadata?.sdk) {
    headers.sdk = {
      name: metadata.sdk.name,
      version: metadata.sdk.version
    };
  }
  if (!!tunnel && !!dsn) {
    headers.dsn = dsnToString(dsn);
  }
  return createEnvelope(headers, [createMetricContainerEnvelopeItem(metrics, inferUserData)]);
}
__name(createMetricEnvelope, "createMetricEnvelope");

// node_modules/@sentry/core/build/esm/metrics/internal.js
function _INTERNAL_flushMetricsBuffer(client, maybeMetricBuffer) {
  const metricBuffer = maybeMetricBuffer ?? _INTERNAL_getMetricBuffer(client) ?? [];
  if (metricBuffer.length === 0) {
    return;
  }
  const clientOptions = client.getOptions();
  const envelope = createMetricEnvelope(
    metricBuffer,
    clientOptions._metadata,
    clientOptions.tunnel,
    client.getDsn(),
    client.getDataCollectionOptions().userInfo
  );
  _getBufferMap2().set(client, []);
  client.emit("flushMetrics");
  client.sendEnvelope(envelope);
}
__name(_INTERNAL_flushMetricsBuffer, "_INTERNAL_flushMetricsBuffer");
function _INTERNAL_getMetricBuffer(client) {
  return _getBufferMap2().get(client);
}
__name(_INTERNAL_getMetricBuffer, "_INTERNAL_getMetricBuffer");
function _getBufferMap2() {
  return getGlobalSingleton("clientToMetricBufferMap", () => /* @__PURE__ */ new WeakMap());
}
__name(_getBufferMap2, "_getBufferMap");

// node_modules/@sentry/core/build/esm/tracing/spans/extractGenAiSpans.js
init_modules_watch_stub();
function extractGenAiSpansFromEvent(event, client) {
  if (event.type !== "transaction" || !event.spans?.length || !event.sdkProcessingMetadata?.hasGenAiSpans || hasSpanStreamingEnabled(client)) {
    return void 0;
  }
  const genAiSpans = [];
  const remainingSpans = [];
  for (const span of event.spans) {
    if (span.op?.startsWith("gen_ai.")) {
      genAiSpans.push(spanJsonToSerializedStreamedSpan(span));
    } else {
      remainingSpans.push(span);
    }
  }
  if (genAiSpans.length === 0) {
    return void 0;
  }
  event.spans = remainingSpans;
  return createSpanContainerItem(genAiSpans, client);
}
__name(extractGenAiSpansFromEvent, "extractGenAiSpansFromEvent");

// node_modules/@sentry/core/build/esm/transports/base.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/promisebuffer.js
init_modules_watch_stub();
var SENTRY_BUFFER_FULL_ERROR = /* @__PURE__ */ Symbol.for("SentryBufferFullError");
function makePromiseBuffer(limit = 100) {
  const buffer = /* @__PURE__ */ new Set();
  function isReady() {
    return buffer.size < limit;
  }
  __name(isReady, "isReady");
  function remove(task) {
    buffer.delete(task);
  }
  __name(remove, "remove");
  function add(taskProducer) {
    if (!isReady()) {
      return rejectedSyncPromise(SENTRY_BUFFER_FULL_ERROR);
    }
    const task = taskProducer();
    buffer.add(task);
    void task.then(
      () => remove(task),
      () => remove(task)
    );
    return task;
  }
  __name(add, "add");
  function drain(timeout) {
    if (!buffer.size) {
      return resolvedSyncPromise(true);
    }
    const drainPromise = Promise.allSettled(Array.from(buffer)).then(() => true);
    if (!timeout) {
      return drainPromise;
    }
    const promises = [
      drainPromise,
      new Promise((resolve2) => safeUnref(setTimeout(() => resolve2(false), timeout)))
    ];
    return Promise.race(promises);
  }
  __name(drain, "drain");
  return {
    get $() {
      return Array.from(buffer);
    },
    add,
    drain
  };
}
__name(makePromiseBuffer, "makePromiseBuffer");

// node_modules/@sentry/core/build/esm/utils/ratelimit.js
init_modules_watch_stub();
var DEFAULT_RETRY_AFTER = 60 * 1e3;
function parseRetryAfterHeader(header, now = safeDateNow()) {
  const headerDelay = parseInt(`${header}`, 10);
  if (!isNaN(headerDelay)) {
    return headerDelay * 1e3;
  }
  const headerDate = Date.parse(`${header}`);
  if (!isNaN(headerDate)) {
    return headerDate - now;
  }
  return DEFAULT_RETRY_AFTER;
}
__name(parseRetryAfterHeader, "parseRetryAfterHeader");
function disabledUntil(limits, dataCategory) {
  return limits[dataCategory] || limits.all || 0;
}
__name(disabledUntil, "disabledUntil");
function isRateLimited(limits, dataCategory, now = safeDateNow()) {
  return disabledUntil(limits, dataCategory) > now;
}
__name(isRateLimited, "isRateLimited");
function updateRateLimits(limits, { statusCode, headers }, now = safeDateNow()) {
  const updatedRateLimits = {
    ...limits
  };
  const rateLimitHeader = headers?.["x-sentry-rate-limits"];
  const retryAfterHeader = headers?.["retry-after"];
  if (rateLimitHeader) {
    for (const limit of rateLimitHeader.trim().split(",")) {
      const [retryAfter, categories, , , namespaces] = limit.split(":", 5);
      const headerDelay = parseInt(retryAfter, 10);
      const delay = (!isNaN(headerDelay) ? headerDelay : 60) * 1e3;
      if (!categories) {
        updatedRateLimits.all = now + delay;
      } else {
        for (const category of categories.split(";")) {
          if (category === "metric_bucket") {
            if (!namespaces || namespaces.split(";").includes("custom")) {
              updatedRateLimits[category] = now + delay;
            }
          } else {
            updatedRateLimits[category] = now + delay;
          }
        }
      }
    }
  } else if (retryAfterHeader) {
    updatedRateLimits.all = now + parseRetryAfterHeader(retryAfterHeader, now);
  } else if (statusCode === 429) {
    updatedRateLimits.all = now + 60 * 1e3;
  }
  return updatedRateLimits;
}
__name(updateRateLimits, "updateRateLimits");

// node_modules/@sentry/core/build/esm/transports/base.js
var DEFAULT_TRANSPORT_BUFFER_SIZE = 64;
function createTransport(options, makeRequest, buffer = makePromiseBuffer(
  options.bufferSize || DEFAULT_TRANSPORT_BUFFER_SIZE
)) {
  let rateLimits = {};
  const flush2 = /* @__PURE__ */ __name((timeout) => buffer.drain(timeout), "flush");
  function recordItemLoss(reason, [headers, payload], type) {
    const dataCategory = envelopeItemTypeToDataCategory(type);
    if (type === "transaction") {
      options.recordDroppedEvent(reason, "span", (payload.spans?.length ?? 0) + 1);
    }
    options.recordDroppedEvent(reason, dataCategory, typeof headers.item_count === "number" ? headers.item_count : 1);
  }
  __name(recordItemLoss, "recordItemLoss");
  function send2(envelope) {
    const filteredEnvelopeItems = [];
    forEachEnvelopeItem(envelope, (item, type) => {
      if (isRateLimited(rateLimits, envelopeItemTypeToDataCategory(type))) {
        recordItemLoss("ratelimit_backoff", item, type);
      } else {
        filteredEnvelopeItems.push(item);
      }
    });
    if (filteredEnvelopeItems.length === 0) {
      return Promise.resolve({});
    }
    const filteredEnvelope = createEnvelope(envelope[0], filteredEnvelopeItems);
    const recordEnvelopeLoss = /* @__PURE__ */ __name((reason) => {
      if (envelopeContainsItemType(filteredEnvelope, ["client_report"])) {
        DEBUG_BUILD && debug.warn(`Dropping client report. Will not send outcomes (reason: ${reason}).`);
        return;
      }
      forEachEnvelopeItem(filteredEnvelope, (item, type) => {
        recordItemLoss(reason, item, type);
      });
    }, "recordEnvelopeLoss");
    const requestTask = /* @__PURE__ */ __name(() => makeRequest({ body: serializeEnvelope(filteredEnvelope) }).then(
      (response) => {
        if (response.statusCode === 413) {
          DEBUG_BUILD && debug.error(
            "Sentry responded with status code 413. Envelope was discarded due to exceeding size limits."
          );
          recordEnvelopeLoss("send_error");
          return response;
        }
        if (DEBUG_BUILD && response.statusCode !== void 0 && (response.statusCode < 200 || response.statusCode >= 300)) {
          debug.warn(`Sentry responded with status code ${response.statusCode} to sent event.`);
        }
        rateLimits = updateRateLimits(rateLimits, response);
        return response;
      },
      (error2) => {
        recordEnvelopeLoss("network_error");
        DEBUG_BUILD && debug.error("Encountered error running transport request:", error2);
        throw error2;
      }
    ), "requestTask");
    return buffer.add(requestTask).then(
      (result) => result,
      (error2) => {
        if (error2 === SENTRY_BUFFER_FULL_ERROR) {
          DEBUG_BUILD && debug.error("Skipped sending event because buffer is full.");
          recordEnvelopeLoss("queue_overflow");
          return Promise.resolve({});
        } else {
          throw error2;
        }
      }
    );
  }
  __name(send2, "send");
  return {
    send: send2,
    flush: flush2
  };
}
__name(createTransport, "createTransport");

// node_modules/@sentry/core/build/esm/utils/clientreport.js
init_modules_watch_stub();
function createClientReportEnvelope(discarded_events, dsn, timestamp) {
  const clientReportItem = [
    { type: "client_report" },
    {
      timestamp: timestamp || dateTimestampInSeconds(),
      discarded_events
    }
  ];
  return createEnvelope(dsn ? { dsn } : {}, [clientReportItem]);
}
__name(createClientReportEnvelope, "createClientReportEnvelope");

// node_modules/@sentry/core/build/esm/utils/transactionEvent.js
init_modules_watch_stub();
function convertTransactionEventToSpanJson(event) {
  const { trace_id, parent_span_id, span_id, status, origin, data, op } = event.contexts?.trace ?? {};
  return {
    data: data ?? {},
    description: event.transaction,
    op,
    parent_span_id,
    span_id: span_id ?? "",
    start_timestamp: event.start_timestamp ?? 0,
    status: status ?? "ok",
    timestamp: event.timestamp,
    trace_id: trace_id ?? "",
    origin,
    profile_id: data?.[hm],
    exclusive_time: data?.[Vd],
    measurements: event.measurements,
    is_segment: true
  };
}
__name(convertTransactionEventToSpanJson, "convertTransactionEventToSpanJson");
function convertSpanJsonToTransactionEvent(span) {
  return {
    type: "transaction",
    timestamp: span.timestamp,
    start_timestamp: span.start_timestamp,
    transaction: span.description,
    contexts: {
      trace: {
        trace_id: span.trace_id,
        span_id: span.span_id,
        parent_span_id: span.parent_span_id,
        op: span.op,
        status: span.status,
        origin: span.origin,
        data: {
          ...span.data,
          ...span.profile_id && { [hm]: span.profile_id },
          ...span.exclusive_time && { [Vd]: span.exclusive_time }
        }
      }
    },
    measurements: span.measurements
  };
}
__name(convertSpanJsonToTransactionEvent, "convertSpanJsonToTransactionEvent");

// node_modules/@sentry/core/build/esm/utils/warnAboutIgnoredTransactionOptions.js
init_modules_watch_stub();
function maybeWarnAboutIgnoredTransactionOptions(options) {
  if (options.traceLifecycle !== "stream" || // oxlint-disable-next-line typescript/no-deprecated
  !(options.beforeSendTransaction || options.ignoreTransactions?.length)) {
    return;
  }
  consoleSandbox(() => {
    console.warn(
      "[Sentry] `beforeSendTransaction` and `ignoreTransactions` are ignored with `traceLifecycle: 'stream'` (enabled by default). Use `beforeSendSpan` and `ignoreSpans` instead, or set `traceLifecycle: 'static'`."
    );
  });
}
__name(maybeWarnAboutIgnoredTransactionOptions, "maybeWarnAboutIgnoredTransactionOptions");

// node_modules/@sentry/core/build/esm/utils/data-collection/resolveDataCollectionOptions.js
init_modules_watch_stub();
var DEFAULTS = {
  userInfo: true,
  cookies: true,
  httpHeaders: { request: true, response: true },
  httpBodies: ["incomingRequest", "outgoingRequest", "incomingResponse", "outgoingResponse"],
  urlQueryParams: true,
  graphQL: { document: true, variables: true },
  genAI: { inputs: true, outputs: true },
  databaseQueryData: true,
  queues: true,
  stackFrameVariables: true,
  frameContextLines: 5
};
function isCollectBehavior(value) {
  return typeof value === "boolean" || "allow" in value || "deny" in value;
}
__name(isCollectBehavior, "isCollectBehavior");
function resolveHttpHeaders(httpHeaders) {
  if (httpHeaders === void 0) {
    return { ...DEFAULTS.httpHeaders };
  }
  if (isCollectBehavior(httpHeaders)) {
    return { request: httpHeaders, response: httpHeaders };
  }
  return {
    request: httpHeaders.request ?? DEFAULTS.httpHeaders.request,
    response: httpHeaders.response ?? DEFAULTS.httpHeaders.response
  };
}
__name(resolveHttpHeaders, "resolveHttpHeaders");
function resolveDataCollectionOptions(options) {
  const dc = options.dataCollection ?? {};
  return {
    userInfo: dc.userInfo ?? DEFAULTS.userInfo,
    cookies: dc.cookies ?? DEFAULTS.cookies,
    httpHeaders: resolveHttpHeaders(dc.httpHeaders),
    httpBodies: dc.httpBodies ?? DEFAULTS.httpBodies,
    urlQueryParams: dc.urlQueryParams ?? DEFAULTS.urlQueryParams,
    graphQL: {
      document: dc.graphQL?.document ?? DEFAULTS.graphQL.document,
      variables: dc.graphQL?.variables ?? DEFAULTS.graphQL.variables
    },
    genAI: {
      inputs: dc.genAI?.inputs ?? DEFAULTS.genAI.inputs,
      outputs: dc.genAI?.outputs ?? DEFAULTS.genAI.outputs
    },
    databaseQueryData: dc.databaseQueryData ?? DEFAULTS.databaseQueryData,
    queues: dc.queues ?? DEFAULTS.queues,
    stackFrameVariables: dc.stackFrameVariables ?? DEFAULTS.stackFrameVariables,
    frameContextLines: dc.frameContextLines ?? DEFAULTS.frameContextLines
  };
}
__name(resolveDataCollectionOptions, "resolveDataCollectionOptions");

// node_modules/@sentry/core/build/esm/client.js
var ALREADY_SEEN_ERROR = "Not capturing exception because it's already been captured.";
var MISSING_RELEASE_FOR_SESSION_ERROR = "Discarded session because of missing or non-string release";
var INTERNAL_ERROR_SYMBOL = /* @__PURE__ */ Symbol.for("SentryInternalError");
var DO_NOT_SEND_EVENT_SYMBOL = /* @__PURE__ */ Symbol.for("SentryDoNotSendEventError");
var DEFAULT_FLUSH_INTERVAL = 5e3;
var CLOSED_CLIENT_SYMBOL = /* @__PURE__ */ Symbol.for("SentryClosedClient");
function isClientClosed(client) {
  return CLOSED_CLIENT_SYMBOL in client;
}
__name(isClientClosed, "isClientClosed");
function _makeInternalError(message2) {
  return {
    message: message2,
    [INTERNAL_ERROR_SYMBOL]: true
  };
}
__name(_makeInternalError, "_makeInternalError");
function _makeDoNotSendEventError(message2) {
  return {
    message: message2,
    [DO_NOT_SEND_EVENT_SYMBOL]: true
  };
}
__name(_makeDoNotSendEventError, "_makeDoNotSendEventError");
function _isInternalError(error2) {
  return isObjectLike(error2) && INTERNAL_ERROR_SYMBOL in error2;
}
__name(_isInternalError, "_isInternalError");
function _isDoNotSendEventError(error2) {
  return isObjectLike(error2) && DO_NOT_SEND_EVENT_SYMBOL in error2;
}
__name(_isDoNotSendEventError, "_isDoNotSendEventError");
function setupWeightBasedFlushing(client, afterCaptureHook, flushHook, estimateSizeFn, flushFn) {
  let weight = 0;
  let flushTimeout;
  let isTimerActive = false;
  client.on(flushHook, () => {
    weight = 0;
    clearTimeout(flushTimeout);
    isTimerActive = false;
  });
  client.on(afterCaptureHook, (item) => {
    weight += estimateSizeFn(item);
    if (weight >= 8e5) {
      flushFn(client);
    } else if (!isTimerActive) {
      const flushInterval = client.getOptions()._flushInterval ?? DEFAULT_FLUSH_INTERVAL;
      if (flushInterval > 0) {
        isTimerActive = true;
        flushTimeout = safeUnref(
          setTimeout(() => {
            flushFn(client);
          }, flushInterval)
        );
      }
    }
  });
  client.on("flush", () => {
    flushFn(client);
  });
}
__name(setupWeightBasedFlushing, "setupWeightBasedFlushing");
var Client = class {
  static {
    __name(this, "Client");
  }
  /**
   * Initializes this client instance.
   *
   * @param options Options for the client.
   */
  constructor(options) {
    this._options = {
      attachStacktrace: true,
      ...options,
      traceLifecycle: options.traceLifecycle === "static" ? "static" : "stream"
    };
    this._integrations = {};
    this._numProcessing = 0;
    this._outcomes = {};
    this._hooks = {};
    this._eventProcessors = [];
    this._promiseBuffer = makePromiseBuffer(options.transportOptions?.bufferSize ?? DEFAULT_TRANSPORT_BUFFER_SIZE);
    this._dataCollection = resolveDataCollectionOptions(options);
    this._unhandledSessionStatus = "crashed";
    if (options.dsn) {
      this._dsn = makeDsn(options.dsn);
    } else {
      DEBUG_BUILD && debug.warn("No DSN provided, client will not send events.");
    }
    const { beforeSendSpan, traceLifecycle } = this._options;
    if (DEBUG_BUILD && beforeSendSpan && isStaticBeforeSendSpanCallback(beforeSendSpan) !== (traceLifecycle === "static")) {
      consoleSandbox(() => {
        console.warn(
          `Ignoring \`beforeSendSpan\`: ${traceLifecycle === "static" ? "wrap it with" : "remove"} \`Sentry.withStaticSpan\` to use it with \`traceLifecycle: "${traceLifecycle}"\`.`
        );
      });
    }
    if (this._dsn) {
      const url = getEnvelopeEndpointWithUrlEncodedAuth(
        this._dsn,
        options.tunnel,
        options._metadata ? options._metadata.sdk : void 0
      );
      this._transport = options.transport({
        tunnel: this._options.tunnel,
        recordDroppedEvent: this.recordDroppedEvent.bind(this),
        ...options.transportOptions,
        url
      });
    }
    setupWeightBasedFlushing(this, "afterCaptureLog", "flushLogs", estimateLogSizeInBytes, _INTERNAL_flushLogsBuffer);
    setupWeightBasedFlushing(
      this,
      "afterCaptureMetric",
      "flushMetrics",
      estimateMetricSizeInBytes,
      _INTERNAL_flushMetricsBuffer
    );
  }
  /**
   * Captures an exception event and sends it to Sentry.
   *
   * Unlike `captureException` exported from every SDK, this method requires that you pass it the current scope.
   */
  captureException(exception, hint, scope) {
    const eventId = uuid4();
    if (checkOrSetAlreadyCaught(exception)) {
      DEBUG_BUILD && debug.log(ALREADY_SEEN_ERROR);
      return eventId;
    }
    const hintWithEventId = {
      event_id: eventId,
      ...hint
    };
    this._process(
      () => this.eventFromException(exception, hintWithEventId).then((event) => this._captureEvent(event, hintWithEventId, scope)).then((res) => res),
      "error"
    );
    return hintWithEventId.event_id;
  }
  /**
   * Captures a message event and sends it to Sentry.
   *
   * Unlike `captureMessage` exported from every SDK, this method requires that you pass it the current scope.
   */
  captureMessage(message2, level, hint, currentScope) {
    const hintWithEventId = {
      event_id: uuid4(),
      ...hint
    };
    const eventMessage = isParameterizedString(message2) ? message2 : String(message2);
    const isMessage = isPrimitive(message2);
    const promisedEvent = isMessage ? this.eventFromMessage(eventMessage, level, hintWithEventId) : this.eventFromException(message2, hintWithEventId);
    this._process(
      () => promisedEvent.then((event) => this._captureEvent(event, hintWithEventId, currentScope)),
      isMessage ? "unknown" : "error"
    );
    return hintWithEventId.event_id;
  }
  /**
   * Captures a manually created event and sends it to Sentry.
   *
   * Unlike `captureEvent` exported from every SDK, this method requires that you pass it the current scope.
   */
  captureEvent(event, hint, currentScope) {
    const eventId = uuid4();
    if (hint?.originalException && checkOrSetAlreadyCaught(hint.originalException)) {
      DEBUG_BUILD && debug.log(ALREADY_SEEN_ERROR);
      return eventId;
    }
    const hintWithEventId = {
      event_id: eventId,
      ...hint
    };
    const sdkProcessingMetadata = event.sdkProcessingMetadata || {};
    const capturedSpanScope = sdkProcessingMetadata.capturedSpanScope;
    const capturedSpanIsolationScope = sdkProcessingMetadata.capturedSpanIsolationScope;
    const dataCategory = getDataCategoryByType(event.type);
    this._process(
      () => this._captureEvent(event, hintWithEventId, capturedSpanScope || currentScope, capturedSpanIsolationScope),
      dataCategory
    );
    return hintWithEventId.event_id;
  }
  /**
   * Captures a session.
   */
  captureSession(session) {
    this.sendSession(session);
    updateSession(session, { init: false });
  }
  /**
   * Get the current Dsn.
   */
  getDsn() {
    return this._dsn;
  }
  /**
   * Get the current options.
   */
  getOptions() {
    return this._options;
  }
  /**
   * Get the resolved data collection configuration.
   */
  getDataCollectionOptions() {
    return this._dataCollection;
  }
  /**
   * Get the SDK metadata.
   * @see SdkMetadata
   */
  getSdkMetadata() {
    return this._options._metadata;
  }
  /**
   * Returns the transport that is used by the client.
   * Please note that the transport gets lazy initialized so it will only be there once the first event has been sent.
   */
  getTransport() {
    return this._transport;
  }
  /**
   * Wait for all events to be sent or the timeout to expire, whichever comes first.
   *
   * @param timeout Maximum time in ms the client should wait for events to be flushed. Omitting this parameter will
   *   cause the client to wait until all events are sent before resolving the promise.
   * @returns A promise that will resolve with `true` if all events are sent before the timeout, or `false` if there are
   * still events in the queue when the timeout is reached.
   */
  // @ts-expect-error - PromiseLike is a subset of Promise
  async flush(timeout) {
    const transport = this._transport;
    this.emit("flush");
    if (!transport) {
      return true;
    }
    const clientFinished = await this._isClientDoneProcessing(timeout);
    const transportFlushed = await transport.flush(timeout);
    return clientFinished && transportFlushed;
  }
  /**
   * Flush the event queue and set the client to `enabled = false`. See {@link Client.flush}.
   *
   * @param {number} timeout Maximum time in ms the client should wait before shutting down. Omitting this parameter will cause
   *   the client to wait until all events are sent before disabling itself.
   * @returns {Promise<boolean>} A promise which resolves to `true` if the flush completes successfully before the timeout, or `false` if
   * it doesn't.
   */
  // @ts-expect-error - PromiseLike is a subset of Promise
  async close(timeout) {
    Object.defineProperty(this, CLOSED_CLIENT_SYMBOL, { value: true });
    const result = await this.flush(timeout);
    this.getOptions().enabled = false;
    this.emit("close");
    return result;
  }
  /**
   * Get all installed event processors.
   */
  getEventProcessors() {
    return this._eventProcessors;
  }
  /**
   * Adds an event processor that applies to any event processed by this client.
   */
  addEventProcessor(eventProcessor) {
    this._eventProcessors.push(eventProcessor);
  }
  /**
   * Initialize this client.
   * Call this after the client was set on a scope.
   */
  init() {
    if (this._isEnabled() || // Force integrations to be setup even if no DSN was set when we have
    // Spotlight enabled. This is particularly important for browser as we
    // don't support the `spotlight` option there and rely on the users
    // adding the `spotlightBrowserIntegration()` to their integrations which
    // wouldn't get initialized with the check below when there's no DSN set.
    this._options.integrations.some(({ name }) => name.startsWith("Spotlight"))) {
      this._setupIntegrations();
      maybeWarnAboutIgnoredTransactionOptions(this._options);
    }
  }
  /**
   * Gets an installed integration by its name.
   *
   * @returns {Integration|undefined} The installed integration or `undefined` if no integration with that `name` was installed.
   */
  getIntegrationByName(integrationName) {
    return this._integrations[integrationName];
  }
  /**
   * Returns the names of all installed integrations.
   */
  getIntegrationNames() {
    return Object.keys(this._integrations);
  }
  /**
   * Add an integration to the client.
   * This can be used to e.g. lazy load integrations.
   * In most cases, this should not be necessary,
   * and you're better off just passing the integrations via `integrations: []` at initialization time.
   * However, if you find the need to conditionally load & add an integration, you can use `addIntegration` to do so.
   */
  addIntegration(integration) {
    const isAlreadyInstalled = this._integrations[integration.name];
    if (!isAlreadyInstalled && integration.beforeSetup) {
      integration.beforeSetup(this);
    }
    setupIntegration(this, integration, this._integrations);
    if (!isAlreadyInstalled) {
      afterSetupIntegrations(this, [integration]);
    }
  }
  /**
   * Send a fully prepared event to Sentry.
   */
  sendEvent(event, hint = {}) {
    this.emit("beforeSendEvent", event, hint);
    const genAiSpanItem = extractGenAiSpansFromEvent(event, this);
    let env = createEventEnvelope(event, this._dsn, this._options._metadata, this._options.tunnel);
    if (!isInternalException(hint)) {
      for (const attachment of hint.attachments || []) {
        env = addItemToEnvelope(env, createAttachmentEnvelopeItem(attachment));
      }
    }
    if (genAiSpanItem) {
      env = addItemToEnvelope(env, genAiSpanItem);
    }
    this.sendEnvelope(env).then((sendResponse) => this.emit("afterSendEvent", event, sendResponse));
  }
  /**
   * Send a session or session aggregrates to Sentry.
   */
  sendSession(session) {
    const { release: clientReleaseOption, environment: clientEnvironmentOption = DEFAULT_ENVIRONMENT } = this._options;
    if ("aggregates" in session) {
      const sessionAttrs = session.attrs || {};
      if (!sessionAttrs.release && !clientReleaseOption) {
        DEBUG_BUILD && debug.warn(MISSING_RELEASE_FOR_SESSION_ERROR);
        return;
      }
      sessionAttrs.release = sessionAttrs.release || clientReleaseOption;
      sessionAttrs.environment = sessionAttrs.environment || clientEnvironmentOption;
      session.attrs = sessionAttrs;
    } else {
      if (!session.release && !clientReleaseOption) {
        DEBUG_BUILD && debug.warn(MISSING_RELEASE_FOR_SESSION_ERROR);
        return;
      }
      session.release = session.release || clientReleaseOption;
      session.environment = session.environment || clientEnvironmentOption;
    }
    this.emit("beforeSendSession", session);
    const env = createSessionEnvelope(session, this._dsn, this._options._metadata, this._options.tunnel);
    this.sendEnvelope(env);
  }
  /**
   * Record on the client that an event got dropped (ie, an event that will not be sent to Sentry).
   */
  recordDroppedEvent(reason, category, count = 1) {
    if (this._options.sendClientReports) {
      const key = `${reason}:${category}`;
      DEBUG_BUILD && debug.log(`Recording outcome: "${key}"${count > 1 ? ` (${count} times)` : ""}`);
      this._outcomes[key] = (this._outcomes[key] || 0) + count;
    }
  }
  /**
   * Register a hook on this client.
   */
  on(hook, callback) {
    const hookCallbacks = this._hooks[hook] = this._hooks[hook] || /* @__PURE__ */ new Set();
    const uniqueCallback = /* @__PURE__ */ __name((...args) => callback(...args), "uniqueCallback");
    hookCallbacks.add(uniqueCallback);
    return () => {
      hookCallbacks.delete(uniqueCallback);
    };
  }
  /**
   * Emit a hook that was previously registered via `on()`.
   */
  emit(hook, ...rest) {
    const callbacks = this._hooks[hook];
    if (callbacks) {
      callbacks.forEach((callback) => callback(...rest));
    }
  }
  /**
   * Send an envelope to Sentry.
   */
  // @ts-expect-error - PromiseLike is a subset of Promise
  async sendEnvelope(envelope) {
    this.emit("beforeEnvelope", envelope);
    if (this._isEnabled() && this._transport) {
      try {
        const result = await this._transport.send(envelope);
        this.emit("afterEnvelope", envelope);
        return result;
      } catch (reason) {
        DEBUG_BUILD && debug.error("Error while sending envelope:", reason);
        return {};
      }
    }
    DEBUG_BUILD && debug.error("Transport disabled");
    return {};
  }
  /**
   * Register a cleanup function to be called when the client is disposed.
   * This is useful for integrations that need to clean up global state.
   *
   * NOTE: This is a no-op in the base `Client` class. Subclasses like `ServerRuntimeClient`
   * override this method to actually register and execute cleanup callbacks.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  registerCleanup(callback) {
  }
  /**
   * Disposes of the client and releases all resources.
   *
   * Subclasses should override this method to clean up their own resources, including invoking
   * any callbacks registered via {@link Client.registerCleanup}. The base implementation is a
   * no-op and does NOT execute registered cleanup callbacks.
   *
   * After calling dispose(), the client should not be used anymore.
   */
  dispose() {
  }
  /* eslint-enable @typescript-eslint/unified-signatures */
  /** Setup integrations for this client. */
  _setupIntegrations() {
    const { integrations } = this._options;
    this._integrations = setupIntegrations(this, integrations);
    afterSetupIntegrations(this, integrations);
  }
  /** Updates existing session based on the provided event */
  _updateSessionFromEvent(session, event) {
    let unhandled = event.level === "fatal";
    let errored = false;
    const exceptions = event.exception?.values;
    if (exceptions) {
      errored = true;
      unhandled = false;
      for (const ex of exceptions) {
        if (ex.mechanism?.handled === false) {
          unhandled = true;
          break;
        }
      }
    }
    const sessionNonTerminal = session.status === "ok";
    const shouldUpdateAndSend = sessionNonTerminal && session.errors === 0 || sessionNonTerminal && unhandled;
    if (shouldUpdateAndSend) {
      updateSession(session, {
        ...unhandled && { status: this._unhandledSessionStatus },
        errors: session.errors || Number(errored || unhandled)
      });
      this.captureSession(session);
    }
  }
  /**
   * Determine if the client is finished processing. Returns a promise because it will wait `timeout` ms before saying
   * "no" (resolving to `false`) in order to give the client a chance to potentially finish first.
   *
   * @param timeout The time, in ms, after which to resolve to `false` if the client is still busy. Passing `0` (or not
   * passing anything) will make the promise wait as long as it takes for processing to finish before resolving to
   * `true`.
   * @returns A promise which will resolve to `true` if processing is already done or finishes before the timeout, and
   * `false` otherwise
   */
  async _isClientDoneProcessing(timeout) {
    let ticked = 0;
    while (!timeout || ticked < timeout) {
      await new Promise((resolve2) => setTimeout(resolve2, 1));
      if (!this._numProcessing) {
        return true;
      }
      ticked++;
    }
    return false;
  }
  /** Determines whether this SDK is enabled and a transport is present. */
  _isEnabled() {
    return this.getOptions().enabled !== false && this._transport !== void 0;
  }
  /**
   * Adds common information to events.
   *
   * The information includes release and environment from `options`,
   * breadcrumbs and context (extra, tags and user) from the scope.
   *
   * Information that is already present in the event is never overwritten. For
   * nested objects, such as the context, keys are merged.
   *
   * @param event The original event.
   * @param hint May contain additional information about the original exception.
   * @param currentScope A scope containing event metadata.
   * @returns A new event with more information.
   */
  _prepareEvent(event, hint, currentScope, isolationScope) {
    const options = this.getOptions();
    const integrations = this.getIntegrationNames();
    if (!hint.integrations && integrations.length) {
      hint.integrations = integrations;
    }
    this.emit("preprocessEvent", event, hint);
    if (!event.type) {
      isolationScope.setLastEventId(event.event_id || hint.event_id);
    }
    return prepareEvent(options, event, hint, currentScope, this, isolationScope).then((evt) => {
      if (evt === null) {
        return evt;
      }
      this.emit("postprocessEvent", evt, hint);
      evt.contexts = {
        trace: { ...evt.contexts?.trace, ...getTraceContextFromScope(currentScope) },
        ...evt.contexts
      };
      const dynamicSamplingContext = getDynamicSamplingContextFromScope(this, currentScope);
      evt.sdkProcessingMetadata = {
        dynamicSamplingContext,
        ...evt.sdkProcessingMetadata
      };
      return evt;
    });
  }
  /**
   * Processes the event and logs an error in case of rejection
   * @param event
   * @param hint
   * @param scope
   */
  _captureEvent(event, hint = {}, currentScope = getCurrentScope(), isolationScope = getIsolationScope()) {
    if (DEBUG_BUILD && isErrorEvent2(event)) {
      debug.log(`Captured error event \`${getPossibleEventMessages(event)[0] || "<unknown>"}\``);
    }
    return this._processEvent(event, hint, currentScope, isolationScope).then(
      (finalEvent) => {
        return finalEvent.event_id;
      },
      (reason) => {
        if (DEBUG_BUILD) {
          if (_isDoNotSendEventError(reason)) {
            debug.log(reason.message);
          } else if (_isInternalError(reason)) {
            debug.warn(reason.message);
          } else {
            debug.warn(reason);
          }
        }
        return void 0;
      }
    );
  }
  /**
   * Processes an event (either error or message) and sends it to Sentry.
   *
   * This also adds breadcrumbs and context information to the event. However,
   * platform specific meta data (such as the User's IP address) must be added
   * by the SDK implementor.
   *
   *
   * @param event The event to send to Sentry.
   * @param hint May contain additional information about the original exception.
   * @param currentScope A scope containing event metadata.
   * @returns A SyncPromise that resolves with the event or rejects in case event was/will not be send.
   */
  _processEvent(event, hint, currentScope, isolationScope) {
    const options = this.getOptions();
    const { sampleRate } = options;
    const isTransaction = isTransactionEvent(event);
    const isError2 = isErrorEvent2(event);
    const eventType = event.type || "error";
    const beforeSendLabel = `before send for type \`${eventType}\``;
    let beforeSendDropReason = "before_send";
    let ignoredSpanCount = 0;
    const parsedSampleRate = typeof sampleRate === "undefined" ? void 0 : parseSampleRate(sampleRate);
    const dataCategory = getDataCategoryByType(event.type);
    let preparedSpanCount = 0;
    return this._prepareEvent(event, hint, currentScope, isolationScope).then((prepared) => {
      if (prepared === null) {
        throw _makeDoNotSendEventError("An event processor returned `null`, will not send event.");
      }
      preparedSpanCount = prepared.spans?.length || 0;
      if (isInternalException(hint)) {
        return prepared;
      }
      return processBeforeSend(
        options,
        prepared,
        hint,
        (reason) => {
          beforeSendDropReason = reason;
        },
        (count) => {
          ignoredSpanCount = count;
        }
      );
    }).then((processedEvent) => {
      if (ignoredSpanCount) {
        this.recordDroppedEvent("ignored", "span", ignoredSpanCount);
      }
      const isValidEvent = isPlainObject(processedEvent);
      if (!isValidEvent || processedEvent === null) {
        this.recordDroppedEvent(beforeSendDropReason, dataCategory);
        if (isTransaction) {
          this.recordDroppedEvent(beforeSendDropReason, "span", 1 + preparedSpanCount - ignoredSpanCount);
        }
        if (processedEvent !== null) {
          throw _makeInternalError(`${beforeSendLabel} must return \`null\` or a valid event.`);
        }
        const dropMessage = beforeSendDropReason === "ignored" ? "Transaction matched `ignoreSpans`" : `${beforeSendLabel} ${beforeSendDropReason === "callback_error" ? "threw an error" : "returned `null`"}`;
        throw _makeDoNotSendEventError(`${dropMessage}, will not send event.`);
      }
      const session = currentScope.getSession() || isolationScope.getSession();
      if (isError2 && session) {
        this._updateSessionFromEvent(session, processedEvent);
      }
      if (isError2 && typeof parsedSampleRate === "number" && safeMathRandom() > parsedSampleRate) {
        this.recordDroppedEvent("sample_rate", "error");
        throw _makeDoNotSendEventError(
          `Discarding event because it's not included in the random sample (sampling rate = ${sampleRate})`
        );
      }
      if (isTransaction) {
        const droppedSpanCount = preparedSpanCount - ignoredSpanCount - (processedEvent.spans?.length || 0);
        if (droppedSpanCount > 0) {
          this.recordDroppedEvent("before_send", "span", droppedSpanCount);
        }
      }
      const transactionInfo = processedEvent.transaction_info;
      if (isTransaction && transactionInfo && processedEvent.transaction !== event.transaction) {
        const source = "custom";
        processedEvent.transaction_info = {
          ...transactionInfo,
          source
        };
      }
      this.sendEvent(processedEvent, hint);
      return processedEvent;
    }).then(null, (reason) => {
      if (_isDoNotSendEventError(reason) || _isInternalError(reason)) {
        throw reason;
      }
      this.captureException(reason, {
        mechanism: {
          handled: false,
          type: "internal"
        },
        data: {
          __sentry__: true
        },
        originalException: reason
      });
      throw _makeInternalError(
        `Event processing pipeline threw an error, original event will not be sent. Details have been sent as a new event.
Reason: ${reason}`
      );
    });
  }
  /**
   * Occupies the client with processing and event
   */
  _process(taskProducer, dataCategory) {
    this._numProcessing++;
    void this._promiseBuffer.add(taskProducer).then(
      (value) => {
        this._numProcessing--;
        return value;
      },
      (reason) => {
        this._numProcessing--;
        if (reason === SENTRY_BUFFER_FULL_ERROR) {
          this.recordDroppedEvent("queue_overflow", dataCategory);
        }
        return reason;
      }
    );
  }
  /**
   * Clears outcomes on this client and returns them.
   */
  _clearOutcomes() {
    const outcomes = this._outcomes;
    this._outcomes = {};
    return Object.entries(outcomes).map(([key, quantity]) => {
      const [reason, category] = key.split(":");
      return {
        reason,
        category,
        quantity
      };
    });
  }
  /**
   * Sends client reports as an envelope.
   */
  _flushOutcomes() {
    DEBUG_BUILD && debug.log("Flushing outcomes...");
    const outcomes = this._clearOutcomes();
    if (outcomes.length === 0) {
      DEBUG_BUILD && debug.log("No outcomes to send");
      return;
    }
    if (!this._dsn) {
      DEBUG_BUILD && debug.log("No dsn provided, will not send outcomes");
      return;
    }
    DEBUG_BUILD && debug.log("Sending outcomes:", outcomes);
    const envelope = createClientReportEnvelope(outcomes, this._options.tunnel && dsnToString(this._dsn));
    this.sendEnvelope(envelope);
  }
};
function processBeforeSend(options, event, hint, onDrop, onIgnoredSpans) {
  const {
    beforeSend,
    ignoreSpans,
    // oxlint-disable-next-line typescript/no-deprecated
    beforeSendTransaction
  } = options;
  const beforeSendSpan = isStaticBeforeSendSpanCallback(options.beforeSendSpan) && options.beforeSendSpan;
  let processedEvent = event;
  if (isErrorEvent2(processedEvent) && beforeSend) {
    const errorEvent = processedEvent;
    return safeCallback(
      DEBUG_BUILD ? "The `beforeSend` callback threw an error, dropping the event:" : "",
      () => beforeSend(errorEvent, hint),
      () => {
        onDrop("callback_error");
        return null;
      }
    );
  }
  if (isTransactionEvent(processedEvent)) {
    if (beforeSendSpan || ignoreSpans) {
      const rootSpanJson = convertTransactionEventToSpanJson(processedEvent);
      if (ignoreSpans?.length && shouldIgnoreSpan(
        { description: rootSpanJson.description, op: rootSpanJson.op, attributes: rootSpanJson.data },
        ignoreSpans
      )) {
        onDrop("ignored");
        return null;
      }
      if (beforeSendSpan) {
        const processedRootSpanJson = applyBeforeSendSpanCallback(rootSpanJson, beforeSendSpan);
        processedEvent = merge(event, convertSpanJsonToTransactionEvent(processedRootSpanJson));
      }
      if (processedEvent.spans) {
        const processedSpans = [];
        const initialSpans = processedEvent.spans;
        for (const span of initialSpans) {
          if (ignoreSpans?.length && shouldIgnoreSpan({ description: span.description, op: span.op, attributes: span.data }, ignoreSpans)) {
            reparentChildSpans(initialSpans, span);
            continue;
          }
          if (beforeSendSpan) {
            processedSpans.push(applyBeforeSendSpanCallback(span, beforeSendSpan));
          } else {
            processedSpans.push(span);
          }
        }
        onIgnoredSpans(initialSpans.length - processedSpans.length);
        processedEvent.spans = processedSpans;
      }
    }
    if (beforeSendTransaction) {
      return safeCallback(
        DEBUG_BUILD ? "The `beforeSendTransaction` callback threw an error, dropping the event:" : "",
        () => beforeSendTransaction(processedEvent, hint),
        () => {
          onDrop("callback_error");
          return null;
        }
      );
    }
  }
  return processedEvent;
}
__name(processBeforeSend, "processBeforeSend");
function isErrorEvent2(event) {
  return event.type === void 0;
}
__name(isErrorEvent2, "isErrorEvent");
function isTransactionEvent(event) {
  return event.type === "transaction";
}
__name(isTransactionEvent, "isTransactionEvent");
function estimateMetricSizeInBytes(metric) {
  let weight = 0;
  if (metric.name) {
    weight += metric.name.length * 2;
  }
  weight += 8;
  return weight + estimateAttributesSizeInBytes(metric.attributes);
}
__name(estimateMetricSizeInBytes, "estimateMetricSizeInBytes");
function estimateLogSizeInBytes(log2) {
  let weight = 0;
  if (log2.message) {
    weight += log2.message.length * 2;
  }
  return weight + estimateAttributesSizeInBytes(log2.attributes);
}
__name(estimateLogSizeInBytes, "estimateLogSizeInBytes");
function estimateAttributesSizeInBytes(attributes) {
  if (!attributes) {
    return 0;
  }
  let weight = 0;
  Object.values(attributes).forEach((value) => {
    if (Array.isArray(value)) {
      weight += value.length * estimatePrimitiveSizeInBytes2(value[0]);
    } else if (isPrimitive(value)) {
      weight += estimatePrimitiveSizeInBytes2(value);
    } else {
      weight += 100;
    }
  });
  return weight;
}
__name(estimateAttributesSizeInBytes, "estimateAttributesSizeInBytes");
function estimatePrimitiveSizeInBytes2(value) {
  if (typeof value === "string") {
    return value.length * 2;
  } else if (typeof value === "number") {
    return 8;
  } else if (typeof value === "boolean") {
    return 4;
  }
  return 0;
}
__name(estimatePrimitiveSizeInBytes2, "estimatePrimitiveSizeInBytes");

// node_modules/@sentry/core/build/esm/sdk.js
init_modules_watch_stub();
function initAndBind(clientClass, options) {
  if (options.debug === true) {
    if (DEBUG_BUILD) {
      debug.enable();
    } else {
      consoleSandbox(() => {
        console.warn("[Sentry] Cannot initialize SDK with `debug` option using a non-debug bundle.");
      });
    }
  }
  warnIfClientIsActive();
  const scope = getCurrentScope();
  scope.update(options.initialScope);
  const client = new clientClass(options);
  setCurrentClient(client);
  client.init();
  return client;
}
__name(initAndBind, "initAndBind");
function getActiveClient() {
  const client = getClient();
  return client && !isClientClosed(client) ? client : void 0;
}
__name(getActiveClient, "getActiveClient");
function warnIfClientIsActive() {
  if (getActiveClient()) {
    consoleSandbox(() => {
      console.warn(
        "[Sentry] `Sentry.init()` was called more than once. The new client replaces the active client, but the active client is not closed, so state from both can mix. Call `Sentry.init()` only once, or call `await Sentry.close()` before you call it again."
      );
    });
  }
}
__name(warnIfClientIsActive, "warnIfClientIsActive");
function setCurrentClient(client) {
  getCurrentScope().setClient(client);
}
__name(setCurrentClient, "setCurrentClient");

// node_modules/@sentry/core/build/esm/utils/ai/providerSkip.js
init_modules_watch_stub();
var SKIPPED_AI_PROVIDERS = /* @__PURE__ */ new Set();
function _INTERNAL_shouldSkipAiProviderWrapping(module2) {
  return SKIPPED_AI_PROVIDERS.has(module2);
}
__name(_INTERNAL_shouldSkipAiProviderWrapping, "_INTERNAL_shouldSkipAiProviderWrapping");
function _INTERNAL_clearAiProviderSkips() {
  SKIPPED_AI_PROVIDERS.clear();
  DEBUG_BUILD && debug.log("Cleared AI provider skip registrations");
}
__name(_INTERNAL_clearAiProviderSkips, "_INTERNAL_clearAiProviderSkips");

// node_modules/@sentry/core/build/esm/utils/data-collection/filterKeyValueData.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/data-collection/filtering-snippets.js
init_modules_watch_stub();
var FILTERED_VALUE = "[Filtered]";
var SENSITIVE_KEY_SNIPPETS = [
  "auth",
  "token",
  "secret",
  "session",
  // for the user_session cookie
  "password",
  "passwd",
  "pwd",
  "key",
  "jwt",
  "bearer",
  "sso",
  "saml",
  "csrf",
  "xsrf",
  "credentials",
  "sid",
  "identity",
  // Always treat cookie headers as sensitive in case individual key-value cookie pairs cannot properly be extracted
  "set-cookie",
  "cookie"
];
var SENSITIVE_COOKIE_NAME_SNIPPETS = [
  // Express / Connect default session cookie
  ".sid",
  // Opaque session ids (PHPSESSID, ASPSESSIONID*, BIGipServer*, *sessid*, …)
  "sessid",
  // Laravel etc. "remember me" tokens
  "remember",
  // OIDC / OAuth auxiliary (`oauth*` covered by header snippet `auth`)
  "oidc",
  "pkce",
  "nonce",
  // RFC 6265bis high-security cookie name prefixes
  "__secure-",
  "__host-",
  // Load balancer / CDN sticky-session cookies (opaque routing tokens)
  "awsalb",
  "awselb",
  "akamai",
  // BaaS / IdP session cookies (names often omit "session")
  "__stripe",
  "cognito",
  "firebase",
  "supabase",
  "sb-",
  // Step-up / MFA cookies
  "mfa",
  "2fa"
];

// node_modules/@sentry/core/build/esm/utils/data-collection/filterKeyValueData.js
function isSensitiveKey(lower, denySnippets) {
  return denySnippets.some((snippet) => lower.includes(snippet));
}
__name(isSensitiveKey, "isSensitiveKey");
function shouldFilterDataKey(key, behavior, additionalDenyTerms) {
  if (behavior === false) {
    return true;
  }
  const lowerKey = key.toLowerCase();
  const denySnippets = additionalDenyTerms != null ? [...SENSITIVE_KEY_SNIPPETS, ...additionalDenyTerms] : SENSITIVE_KEY_SNIPPETS;
  if (isSensitiveKey(lowerKey, denySnippets)) {
    return true;
  }
  if (behavior === true) {
    return false;
  }
  const terms = "deny" in behavior ? behavior.deny : behavior.allow;
  const matchesConfiguredTerm = terms.some((term) => lowerKey.includes(term.toLowerCase()));
  return "deny" in behavior ? matchesConfiguredTerm : !matchesConfiguredTerm;
}
__name(shouldFilterDataKey, "shouldFilterDataKey");
function filterKeyValueData(data, behavior, additionalDenyTerms) {
  if (behavior === false) {
    return {};
  }
  const result = {};
  for (const key of Object.keys(data)) {
    result[key] = shouldFilterDataKey(key, behavior, additionalDenyTerms) ? FILTERED_VALUE : data[key];
  }
  return result;
}
__name(filterKeyValueData, "filterKeyValueData");

// node_modules/@sentry/core/build/esm/utils/cookie.js
init_modules_watch_stub();
function parseCookieHeader(value, headerName) {
  const segments = (Array.isArray(value) ? value : [value]).flatMap((headerValue) => {
    if (typeof headerValue !== "string") {
      return [];
    }
    return headerName === "set-cookie" ? splitJoinedSetCookieHeader(headerValue).map((cookie) => cookie.split(";")[0]) : headerValue.split(";");
  });
  return segments.map((segment) => segment.trim()).filter((segment) => segment !== "" && segment !== "=").map((segment) => {
    const equalSignIndex = segment.indexOf("=");
    return equalSignIndex === -1 ? (
      // No "=": nameless cookie, the whole segment is the value
      ["", segment]
    ) : (
      // Trim both parts, so that "theme = dark" is named "theme", not "theme "
      [segment.slice(0, equalSignIndex).trim(), segment.slice(equalSignIndex + 1).trim()]
    );
  });
}
__name(parseCookieHeader, "parseCookieHeader");
function splitJoinedSetCookieHeader(headerValue) {
  return headerValue.split(/,(?=[^;=,]*=)/);
}
__name(splitJoinedSetCookieHeader, "splitJoinedSetCookieHeader");
function cookiePairsToRecord(pairs) {
  const record = {};
  for (const [name, value] of pairs) {
    if (record[name] === void 0) {
      record[name] = name === "" ? FILTERED_VALUE : decodeCookieValue(value);
    }
  }
  return record;
}
__name(cookiePairsToRecord, "cookiePairsToRecord");
function decodeCookieValue(value) {
  const unquoted = value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  try {
    return unquoted.indexOf("%") !== -1 ? decodeURIComponent(unquoted) : unquoted;
  } catch {
    return unquoted;
  }
}
__name(decodeCookieValue, "decodeCookieValue");

// node_modules/@sentry/core/build/esm/utils/data-collection/filterQueryParams.js
init_modules_watch_stub();
function filterQueryParams(queryString, behavior) {
  if (!queryString || behavior === false) {
    return void 0;
  }
  return queryString.split("&").map((pair) => {
    const separatorIndex = pair.indexOf("=");
    const encodedKey = separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
    const key = new URLSearchParams(`${encodedKey}=`).keys().next().value;
    return key !== void 0 && shouldFilterDataKey(key, behavior) ? `${encodedKey}=${FILTERED_VALUE}` : pair;
  }).join("&");
}
__name(filterQueryParams, "filterQueryParams");

// node_modules/@sentry/core/build/esm/utils/data-collection/filterCollectedUrl.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/data-collection/filterUrlQuery.js
init_modules_watch_stub();
function filterUrlQuery(url, behavior) {
  const fragmentStart = url.indexOf("#");
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
  const queryStart = url.indexOf("?");
  if (queryStart === -1 || queryStart > queryEnd) {
    return url;
  }
  const prefix = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1, queryEnd);
  const suffix = url.slice(queryEnd);
  const filtered = filterQueryParams(query, behavior);
  return filtered ? `${prefix}?${filtered}${suffix}` : `${prefix}${suffix}`;
}
__name(filterUrlQuery, "filterUrlQuery");

// node_modules/@sentry/core/build/esm/utils/data-collection/filterCollectedUrl.js
function urlQueryParamsBehavior(client) {
  return (client ?? getClient())?.getDataCollectionOptions().urlQueryParams ?? true;
}
__name(urlQueryParamsBehavior, "urlQueryParamsBehavior");
function filterCollectedUrl(url, client) {
  return url === void 0 ? void 0 : filterUrlQuery(url, urlQueryParamsBehavior(client));
}
__name(filterCollectedUrl, "filterCollectedUrl");
function filterCollectedUrlQuery(query, client) {
  return query ? filterQueryParams(query, urlQueryParamsBehavior(client)) : void 0;
}
__name(filterCollectedUrlQuery, "filterCollectedUrlQuery");

// node_modules/@sentry/core/build/esm/utils/envToBool.js
init_modules_watch_stub();
var FALSY_ENV_VALUES = /* @__PURE__ */ new Set(["false", "f", "n", "no", "off", "0"]);
var TRUTHY_ENV_VALUES = /* @__PURE__ */ new Set(["true", "t", "y", "yes", "on", "1"]);
function envToBool(value, options) {
  const normalized = String(value).toLowerCase();
  if (FALSY_ENV_VALUES.has(normalized)) {
    return false;
  }
  if (TRUTHY_ENV_VALUES.has(normalized)) {
    return true;
  }
  return options?.strict ? null : Boolean(value);
}
__name(envToBool, "envToBool");

// node_modules/@sentry/core/build/esm/checkin.js
init_modules_watch_stub();
function createCheckInEnvelope(checkIn, dynamicSamplingContext, metadata, tunnel, dsn) {
  const headers = {
    sent_at: new Date(safeDateNow()).toISOString()
  };
  if (metadata?.sdk) {
    headers.sdk = {
      name: metadata.sdk.name,
      version: metadata.sdk.version
    };
  }
  if (!!tunnel && !!dsn) {
    headers.dsn = dsnToString(dsn);
  }
  if (dynamicSamplingContext) {
    headers.trace = dynamicSamplingContext;
  }
  const item = createCheckInEnvelopeItem(checkIn);
  return createEnvelope(headers, [item]);
}
__name(createCheckInEnvelope, "createCheckInEnvelope");
function createCheckInEnvelopeItem(checkIn) {
  const checkInHeaders = {
    type: "check_in"
  };
  return [checkInHeaders, checkIn];
}
__name(createCheckInEnvelopeItem, "createCheckInEnvelopeItem");

// node_modules/@sentry/core/build/esm/utils/isSentryRequestUrl.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/url.js
init_modules_watch_stub();
var DEFAULT_BASE_URL = "thismessage:/";
function isURLObjectRelative(url) {
  return "isRelative" in url;
}
__name(isURLObjectRelative, "isURLObjectRelative");
function parseStringToURLObject(url, urlBase) {
  const isRelative = url.indexOf("://") <= 0 && url.indexOf("//") !== 0;
  const base = urlBase ?? (isRelative ? DEFAULT_BASE_URL : void 0);
  try {
    if ("canParse" in URL && !URL.canParse(url, base)) {
      return void 0;
    }
    const fullUrlObject = new URL(url, base);
    if (isRelative) {
      return {
        isRelative,
        pathname: fullUrlObject.pathname,
        search: fullUrlObject.search,
        hash: fullUrlObject.hash
      };
    }
    return fullUrlObject;
  } catch {
  }
  return void 0;
}
__name(parseStringToURLObject, "parseStringToURLObject");
function getSanitizedUrlStringFromUrlObject(url) {
  if (isURLObjectRelative(url)) {
    return url.pathname;
  }
  const newUrl = new URL(url);
  newUrl.search = "";
  newUrl.hash = "";
  if (["80", "443"].includes(newUrl.port)) {
    newUrl.port = "";
  }
  if (newUrl.password) {
    newUrl.password = "%filtered%";
  }
  if (newUrl.username) {
    newUrl.username = "%filtered%";
  }
  return newUrl.toString();
}
__name(getSanitizedUrlStringFromUrlObject, "getSanitizedUrlStringFromUrlObject");
function getUrlQuery(query) {
  return query?.replace(/^\?/, "") || void 0;
}
__name(getUrlQuery, "getUrlQuery");
function getUrlFragment(fragment) {
  return fragment?.replace(/^#/, "") || void 0;
}
__name(getUrlFragment, "getUrlFragment");
function getUrlDomain(url, base) {
  try {
    return new URL(url, base).hostname || void 0;
  } catch {
    return void 0;
  }
}
__name(getUrlDomain, "getUrlDomain");
function getHttpSpanNameFromUrlObject(urlObject, kind, request, routeName) {
  const method = request?.method?.toUpperCase() ?? "GET";
  const route = routeName ? routeName : urlObject ? kind === "client" ? getSanitizedUrlStringFromUrlObject(urlObject) : urlObject.pathname : "/";
  return `${method} ${route}`;
}
__name(getHttpSpanNameFromUrlObject, "getHttpSpanNameFromUrlObject");
function getHttpSpanDetailsFromUrlObject(urlObject, kind, spanOrigin, request, routeName, client) {
  const attributes = {
    [gm]: spanOrigin
  };
  let nameSource = "url";
  if (routeName) {
    attributes[kind === "server" ? al : db] = routeName;
    nameSource = "route";
  }
  if (request?.method) {
    attributes[Do] = request.method.toUpperCase();
  }
  if (urlObject) {
    attributes[ib] = filterCollectedUrl(
      isURLObjectRelative(urlObject) ? getSanitizedUrlStringFromUrlObject(urlObject) : urlObject.href,
      client
    );
    attributes[pb] = filterCollectedUrlQuery(getUrlQuery(urlObject.search), client);
    attributes[tb] = getUrlFragment(urlObject.hash);
    if (urlObject.pathname) {
      attributes[ab] = urlObject.pathname;
      if (urlObject.pathname === "/") {
        nameSource = "route";
      }
    }
    if (!isURLObjectRelative(urlObject)) {
      if (urlObject.port) {
        attributes[lb] = urlObject.port;
      }
      if (urlObject.protocol) {
        attributes[ub] = urlObject.protocol;
      }
      if (urlObject.hostname) {
        attributes[kind === "server" ? tg : eb] = urlObject.hostname;
      }
    }
  }
  if (kind === "server") {
    attributes[Nm] = nameSource;
  }
  return [getHttpSpanNameFromUrlObject(urlObject, kind, request, routeName), attributes];
}
__name(getHttpSpanDetailsFromUrlObject, "getHttpSpanDetailsFromUrlObject");
function parseUrl(url) {
  if (!url) {
    return {};
  }
  const match = url.match(/^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/);
  if (!match) {
    return {};
  }
  const query = match[6] || "";
  const fragment = match[8] || "";
  return {
    host: match[4],
    path: match[5],
    protocol: match[2],
    search: query,
    hash: fragment,
    relative: match[5] + query + fragment
    // everything minus origin
  };
}
__name(parseUrl, "parseUrl");
function getSanitizedUrlString(url) {
  const { protocol, host, path } = url;
  const filteredHost = host?.replace(/^.*@/, "[filtered]:[filtered]@").replace(/(:80)$/, "").replace(/(:443)$/, "") || "";
  return `${protocol ? `${protocol}://` : ""}${filteredHost}${path || ""}`;
}
__name(getSanitizedUrlString, "getSanitizedUrlString");
function stripDataUrlContent(url, includeDataPrefix = true) {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)/);
    const mimeType = match ? match[1] : "text/plain";
    const isBase64 = url.includes(";base64,");
    const dataStart = url.indexOf(",");
    let dataPrefix = "";
    if (includeDataPrefix && dataStart !== -1) {
      const data = url.slice(dataStart + 1);
      dataPrefix = data.length > 10 ? `${data.slice(0, 10)}... [truncated]` : data;
    }
    return `data:${mimeType}${isBase64 ? ",base64" : ""}${dataPrefix ? `,${dataPrefix}` : ""}`;
  }
  return url;
}
__name(stripDataUrlContent, "stripDataUrlContent");

// node_modules/@sentry/core/build/esm/utils/isSentryRequestUrl.js
function isSentryRequestUrl(url, client) {
  const dsn = client?.getDsn();
  const tunnel = client?.getOptions().tunnel;
  return checkDsn(url, dsn) || checkTunnel(url, tunnel);
}
__name(isSentryRequestUrl, "isSentryRequestUrl");
function checkTunnel(url, tunnel) {
  if (!tunnel) {
    return false;
  }
  return removeTrailingSlash(url) === removeTrailingSlash(tunnel);
}
__name(checkTunnel, "checkTunnel");
function checkDsn(url, dsn) {
  const urlParts = parseStringToURLObject(url);
  if (!urlParts || isURLObjectRelative(urlParts)) {
    return false;
  }
  if (!dsn) {
    return false;
  }
  return hostnameMatchesDsnHost(urlParts.hostname, dsn.host) && /(^|&|\?)sentry_key=/.test(urlParts.search);
}
__name(checkDsn, "checkDsn");
function hostnameMatchesDsnHost(hostname, dsnHost) {
  return hostname === dsnHost || dsnHost.length > 0 && hostname.endsWith(`.${dsnHost}`);
}
__name(hostnameMatchesDsnHost, "hostnameMatchesDsnHost");
function removeTrailingSlash(str) {
  return str[str.length - 1] === "/" ? str.slice(0, -1) : str;
}
__name(removeTrailingSlash, "removeTrailingSlash");

// node_modules/@sentry/core/build/esm/utils/sdkMetadata.js
init_modules_watch_stub();
function applySdkMetadata(options, name, names = [name], source = "npm") {
  const sdk = (options._metadata = options._metadata || {}).sdk = options._metadata.sdk || {};
  if (!sdk.name) {
    sdk.name = `sentry.javascript.${name}`;
    sdk.packages = names.map((name2) => ({
      name: `${source}:@sentry/${name2}`,
      version: SDK_VERSION
    }));
    sdk.version = SDK_VERSION;
  }
}
__name(applySdkMetadata, "applySdkMetadata");

// node_modules/@sentry/core/build/esm/utils/traceData.js
init_modules_watch_stub();
function getTraceData(options = {}) {
  const client = options.client || getClient();
  if (!isEnabled2() || !client) {
    return {};
  }
  const carrier = getMainCarrier();
  const acs = getAsyncContextStrategy(carrier);
  if (acs.getTraceData) {
    return acs.getTraceData(options);
  }
  const scope = options.scope || getCurrentScope();
  const span = options.span || getActiveSpan();
  const isTwpPlaceholder = spanIsNonRecordingSpan(span) && !hasSpansEnabled(client.getOptions());
  if (!span && hasExternalPropagationContext()) {
    return {};
  }
  const sentryTrace = span && !isTwpPlaceholder ? spanToTraceHeader(span) : scopeToTraceHeader(scope);
  const dsc = span ? getDynamicSamplingContextFromSpan(span) : getDynamicSamplingContextFromScope(client, scope);
  const baggage = dynamicSamplingContextToSentryBaggageHeader(dsc);
  const isValidSentryTraceHeader = TRACEPARENT_REGEXP.test(sentryTrace);
  if (!isValidSentryTraceHeader) {
    debug.warn("Invalid sentry-trace data. Cannot generate trace data");
    return {};
  }
  const traceData = {
    "sentry-trace": sentryTrace,
    baggage
  };
  if (options.propagateTraceparent) {
    traceData.traceparent = span && !isTwpPlaceholder ? spanToTraceparentHeader(span) : scopeToTraceparentHeader(scope);
  }
  return traceData;
}
__name(getTraceData, "getTraceData");
function scopeToTraceHeader(scope) {
  const { traceId, sampled, propagationSpanId } = scope.getPropagationContext();
  return generateSentryTraceHeader(traceId, propagationSpanId, sampled);
}
__name(scopeToTraceHeader, "scopeToTraceHeader");
function scopeToTraceparentHeader(scope) {
  const { traceId, sampled, propagationSpanId } = scope.getPropagationContext();
  return generateTraceparentHeader(traceId, propagationSpanId, sampled);
}
__name(scopeToTraceparentHeader, "scopeToTraceparentHeader");

// node_modules/@sentry/core/build/esm/utils/tracePropagationTargets.js
init_modules_watch_stub();
var NOT_PROPAGATED_MESSAGE = "[Tracing] Not injecting trace data for url because it does not match tracePropagationTargets:";
var NORMALIZED_REGEXP_CACHE = /* @__PURE__ */ new WeakMap();
function normalizeRegExpTarget(pattern) {
  const flags = `${pattern.flags.replace(/[gy]/g, "")}${pattern.ignoreCase ? "" : "i"}`;
  if (flags === pattern.flags) {
    return pattern;
  }
  const cached = NORMALIZED_REGEXP_CACHE.get(pattern);
  if (cached) {
    return cached;
  }
  const normalizedPattern = new RegExp(pattern.source, flags);
  NORMALIZED_REGEXP_CACHE.set(pattern, normalizedPattern);
  return normalizedPattern;
}
__name(normalizeRegExpTarget, "normalizeRegExpTarget");
function matchesTracePropagationTargets(value, tracePropagationTargets, requireExactStringMatch = false) {
  const lowerCaseValue = value.toLowerCase();
  for (const target of tracePropagationTargets) {
    if (isString(target)) {
      const lowerCaseTarget = target.toLowerCase();
      if (requireExactStringMatch ? lowerCaseValue === lowerCaseTarget : lowerCaseValue.includes(lowerCaseTarget)) {
        return true;
      }
    } else if (isRegExp(target) && normalizeRegExpTarget(target).test(value)) {
      return true;
    }
  }
  return false;
}
__name(matchesTracePropagationTargets, "matchesTracePropagationTargets");
function shouldPropagateTraceForUrl(url, tracePropagationTargets, decisionMap) {
  if (typeof url !== "string" || !tracePropagationTargets) {
    return true;
  }
  const cachedDecision = decisionMap?.get(url);
  if (cachedDecision !== void 0) {
    DEBUG_BUILD && !cachedDecision && debug.log(NOT_PROPAGATED_MESSAGE, url);
    return cachedDecision;
  }
  const decision = matchesTracePropagationTargets(url, tracePropagationTargets);
  decisionMap?.set(url, decision);
  DEBUG_BUILD && !decision && debug.log(NOT_PROPAGATED_MESSAGE, url);
  return decision;
}
__name(shouldPropagateTraceForUrl, "shouldPropagateTraceForUrl");

// node_modules/@sentry/core/build/esm/utils/request.js
init_modules_watch_stub();
var MAX_BODY_BYTE_LENGTH = 1024 * 1024;
var TEXT_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/x-www-form-urlencoded",
  "application/xml",
  "application/graphql"
];
function getMaxBodyByteLength(maxRequestBodySize) {
  if (maxRequestBodySize === "small") return 1e3;
  if (maxRequestBodySize === "medium") return 1e4;
  return MAX_BODY_BYTE_LENGTH;
}
__name(getMaxBodyByteLength, "getMaxBodyByteLength");
function winterCGHeadersToDict(winterCGHeaders) {
  const headers = {};
  try {
    winterCGHeaders.forEach((value, key) => {
      if (typeof value === "string") {
        headers[key] = value;
      }
    });
  } catch {
  }
  return headers;
}
__name(winterCGHeadersToDict, "winterCGHeadersToDict");
function winterCGRequestToRequestData(req) {
  const headers = winterCGHeadersToDict(req.headers);
  return {
    method: req.method,
    url: req.url,
    query_string: extractQueryParamsFromUrl(req.url),
    headers
    // TODO: Can we extract body data from the request?
  };
}
__name(winterCGRequestToRequestData, "winterCGRequestToRequestData");
function isTextualContentType(contentType) {
  if (!contentType) {
    return false;
  }
  const lowerContentType = contentType.toLowerCase();
  return TEXT_CONTENT_TYPES.some((type) => lowerContentType.includes(type));
}
__name(isTextualContentType, "isTextualContentType");
async function captureBodyFromWinterCGRequest(request, isolationScope, maxRequestBodySize) {
  try {
    const contentType = request.headers.get("content-type");
    if (!isTextualContentType(contentType)) {
      DEBUG_BUILD && debug.log("Skipping body capture for non-textual content type:", contentType);
      return;
    }
    if (!request.body) {
      return;
    }
    const contentLength = request.headers.get("content-length");
    const maxBodySize = getMaxBodyByteLength(maxRequestBodySize);
    if (contentLength) {
      const length = parseInt(contentLength, 10);
      if (!isNaN(length) && length > MAX_BODY_BYTE_LENGTH) {
        DEBUG_BUILD && debug.log("Skipping body capture: body too large", length);
        return;
      }
    }
    const clonedRequest = request.clone();
    const bodyPromise = clonedRequest.text();
    const timeoutPromise = new Promise((resolve2) => {
      safeUnref(setTimeout(() => resolve2(null), 2e3));
    });
    const body = await Promise.race([bodyPromise, timeoutPromise]);
    if (body === null) {
      DEBUG_BUILD && debug.log("Timeout reading request body");
      return;
    }
    if (!body) {
      return;
    }
    const encoder4 = new TextEncoder();
    const bytes = encoder4.encode(body);
    const bodyByteLength = bytes.length;
    let truncatedBody;
    if (bodyByteLength > maxBodySize) {
      const decoder2 = new TextDecoder();
      truncatedBody = `${decoder2.decode(bytes.slice(0, maxBodySize - 3))}...`;
    } else {
      truncatedBody = body;
    }
    isolationScope.setSDKProcessingMetadata({ normalizedRequest: { data: truncatedBody } });
    DEBUG_BUILD && debug.log("Captured request body:", bodyByteLength, "bytes");
  } catch (error2) {
    DEBUG_BUILD && debug.error("Error capturing request body:", error2);
  }
}
__name(captureBodyFromWinterCGRequest, "captureBodyFromWinterCGRequest");
function httpHeadersToSpanAttributes(headers, dataCollection, lifecycle = "request") {
  const headerBehavior = lifecycle === "request" ? dataCollection.httpHeaders.request : dataCollection.httpHeaders.response;
  const cookieBehavior = dataCollection.cookies;
  const prefix = `http.${lifecycle}.header.`;
  const spanAttributes = {};
  try {
    const regularHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) {
        continue;
      }
      const lowerKey = key.toLowerCase();
      const isCookieHeader = lowerKey === "cookie" || lowerKey === "set-cookie";
      if (isCookieHeader) {
        if (cookieBehavior === false) {
          continue;
        }
        const cookies = parseCookieHeader(value, lowerKey);
        spanAttributes[`${prefix}${lowerKey}`] = cookies.length ? filterCookiePairs(cookies, cookieBehavior) : [FILTERED_VALUE];
      } else {
        if (headerBehavior === false) {
          continue;
        }
        if (Array.isArray(value)) {
          regularHeaders[lowerKey] = value.filter((v) => v != null).map((v) => String(v));
        } else if (typeof value === "string") {
          regularHeaders[lowerKey] = [value];
        }
      }
    }
    if (headerBehavior !== false) {
      for (const [headerKey, headerValues] of Object.entries(regularHeaders)) {
        spanAttributes[`${prefix}${headerKey}`] = shouldFilterDataKey(headerKey, headerBehavior) ? [FILTERED_VALUE] : headerValues;
      }
    }
  } catch {
  }
  return spanAttributes;
}
__name(httpHeadersToSpanAttributes, "httpHeadersToSpanAttributes");
function filterCookiePairs(cookies, cookieBehavior) {
  return cookies.map(([cookieKey, cookieValue]) => {
    if (cookieKey === "") {
      return FILTERED_VALUE;
    }
    return shouldFilterDataKey(cookieKey, cookieBehavior, SENSITIVE_COOKIE_NAME_SNIPPETS) ? `${cookieKey}=${FILTERED_VALUE}` : `${cookieKey}=${cookieValue}`;
  });
}
__name(filterCookiePairs, "filterCookiePairs");
function extractQueryParamsFromUrl(url) {
  if (!url) {
    return;
  }
  try {
    return getUrlQuery(new URL(url, "http://s.io").search);
  } catch {
    return void 0;
  }
}
__name(extractQueryParamsFromUrl, "extractQueryParamsFromUrl");

// node_modules/@sentry/core/build/esm/spanKind.js
init_modules_watch_stub();
var SPAN_KIND_NUMBER_TO_NAME = {
  [0]: void 0,
  [1]: "server",
  [2]: "client",
  [3]: "producer",
  [4]: "consumer"
};
function spanKindToName(kind) {
  return SPAN_KIND_NUMBER_TO_NAME[kind];
}
__name(spanKindToName, "spanKindToName");

// node_modules/@sentry/core/build/esm/breadcrumbs.js
init_modules_watch_stub();
var DEFAULT_BREADCRUMBS = 100;
function addBreadcrumb(breadcrumb, hint) {
  const client = getClient();
  const isolationScope = getIsolationScope();
  if (!client) return;
  const { beforeBreadcrumb = null, maxBreadcrumbs = DEFAULT_BREADCRUMBS } = client.getOptions();
  if (maxBreadcrumbs <= 0) return;
  const timestamp = dateTimestampInSeconds();
  const mergedBreadcrumb = { timestamp, ...breadcrumb };
  const finalBreadcrumb = beforeBreadcrumb ? safeCallback(
    DEBUG_BUILD ? "The `beforeBreadcrumb` callback threw an error, dropping the breadcrumb:" : "",
    () => consoleSandbox(() => beforeBreadcrumb(mergedBreadcrumb, hint)),
    () => null
  ) : mergedBreadcrumb;
  if (finalBreadcrumb === null) return;
  if (client.emit) {
    client.emit("beforeAddBreadcrumb", finalBreadcrumb, hint);
  }
  isolationScope.addBreadcrumb(finalBreadcrumb, maxBreadcrumbs);
}
__name(addBreadcrumb, "addBreadcrumb");

// node_modules/@sentry/core/build/esm/integrations/functiontostring.js
init_modules_watch_stub();
var INTEGRATION_NAME2 = "FunctionToString";
var SETUP_CLIENTS = /* @__PURE__ */ new WeakMap();
var _functionToStringIntegration = /* @__PURE__ */ __name((() => {
  return {
    name: INTEGRATION_NAME2,
    setupOnce() {
      const originalFunctionToString = Function.prototype.toString;
      try {
        Function.prototype.toString = function(...args) {
          const originalFunction = getOriginalFunction(this);
          let unwrappedFunction;
          try {
            if (SETUP_CLIENTS.has(getClient()) && originalFunction !== void 0) {
              unwrappedFunction = originalFunction;
            }
          } catch {
          }
          return originalFunctionToString.apply(unwrappedFunction ?? this, args);
        };
      } catch {
      }
    },
    setup(client) {
      SETUP_CLIENTS.set(client, true);
    }
  };
}), "_functionToStringIntegration");
var functionToStringIntegration = defineIntegration(_functionToStringIntegration);

// node_modules/@sentry/core/build/esm/integrations/eventFilters.js
init_modules_watch_stub();
var DEFAULT_IGNORE_ERRORS = [
  /^Script error\.?$/,
  /^Javascript error: Script error\.? on line 0$/,
  /^ResizeObserver loop completed with undelivered notifications.$/,
  // The browser logs this when a ResizeObserver handler takes a bit longer. Usually this is not an actual issue though. It indicates slowness.
  /^Cannot redefine property: googletag$/,
  // This is thrown when google tag manager is used in combination with an ad blocker
  /^Can't find variable: gmo$/,
  // Error from Google Search App https://issuetracker.google.com/issues/396043331
  /^undefined is not an object \(evaluating 'a\.[A-Z]'\)$/,
  // Random error that happens but not actionable or noticeable to end-users.
  /can't redefine non-configurable property "solana"/,
  // Probably a browser extension or custom browser (Brave) throwing this error
  /vv\(\)\.getRestrictions is not a function/,
  // Error thrown by GTM, seemingly not affecting end-users
  /Can't find variable: _AutofillCallbackHandler/,
  // Unactionable error in instagram webview https://developers.facebook.com/community/threads/320013549791141/
  /Object Not Found Matching Id:\d+, MethodName:simulateEvent/,
  // unactionable error from CEFSharp, a .NET library that embeds chromium in .NET apps
  /Java exception was raised during method invocation$/,
  // error from Facebook Mobile browser (https://github.com/getsentry/sentry-javascript/issues/15065, https://github.com/getsentry/sentry-javascript/issues/23733)
  /Java object is gone$/
  // error from Facebook Mobile browser (https://github.com/getsentry/sentry-javascript/issues/15065, https://github.com/getsentry/sentry-javascript/issues/23733)
];
var INTEGRATION_NAME3 = "EventFilters";
var eventFiltersIntegration = defineIntegration((options = {}) => {
  let mergedOptions;
  return {
    name: INTEGRATION_NAME3,
    setup(client) {
      const clientOptions = client.getOptions();
      mergedOptions = _mergeOptions(options, clientOptions);
    },
    processEvent(event, _hint, client) {
      if (!mergedOptions) {
        const clientOptions = client.getOptions();
        mergedOptions = _mergeOptions(options, clientOptions);
      }
      return _shouldDropEvent(event, mergedOptions) ? null : event;
    }
  };
});
function _mergeOptions(internalOptions = {}, clientOptions = {}) {
  return {
    allowUrls: [...internalOptions.allowUrls || [], ...clientOptions.allowUrls || []],
    denyUrls: [...internalOptions.denyUrls || [], ...clientOptions.denyUrls || []],
    ignoreErrors: [
      ...internalOptions.ignoreErrors || [],
      ...clientOptions.ignoreErrors || [],
      ...internalOptions.disableErrorDefaults ? [] : DEFAULT_IGNORE_ERRORS
    ],
    ignoreTransactions: [...internalOptions.ignoreTransactions || [], ...clientOptions.ignoreTransactions || []]
  };
}
__name(_mergeOptions, "_mergeOptions");
function _shouldDropEvent(event, options) {
  if (!event.type) {
    if (_isIgnoredError(event, options.ignoreErrors)) {
      DEBUG_BUILD && debug.warn(
        `Event dropped due to being matched by \`ignoreErrors\` option.
Event: ${getEventDescription(event)}`
      );
      return true;
    }
    if (_isUselessError(event)) {
      DEBUG_BUILD && debug.warn(
        `Event dropped due to not having an error message, error type or stacktrace.
Event: ${getEventDescription(
          event
        )}`
      );
      return true;
    }
    if (_isDeniedUrl(event, options.denyUrls)) {
      DEBUG_BUILD && debug.warn(
        `Event dropped due to being matched by \`denyUrls\` option.
Event: ${getEventDescription(
          event
        )}.
Url: ${_getEventFilterUrl(event)}`
      );
      return true;
    }
    if (!_isAllowedUrl(event, options.allowUrls)) {
      DEBUG_BUILD && debug.warn(
        `Event dropped due to not being matched by \`allowUrls\` option.
Event: ${getEventDescription(
          event
        )}.
Url: ${_getEventFilterUrl(event)}`
      );
      return true;
    }
  } else if (event.type === "transaction") {
    if (_isIgnoredTransaction(event, options.ignoreTransactions)) {
      DEBUG_BUILD && debug.warn(
        `Event dropped due to being matched by \`ignoreTransactions\` option.
Event: ${getEventDescription(event)}`
      );
      return true;
    }
  }
  return false;
}
__name(_shouldDropEvent, "_shouldDropEvent");
function _isIgnoredError(event, ignoreErrors) {
  if (!ignoreErrors?.length) {
    return false;
  }
  return getPossibleEventMessages(event).some((message2) => stringMatchesSomePattern(message2, ignoreErrors));
}
__name(_isIgnoredError, "_isIgnoredError");
function _isIgnoredTransaction(event, ignoreTransactions) {
  if (!ignoreTransactions?.length) {
    return false;
  }
  const name = event.transaction;
  return name ? stringMatchesSomePattern(name, ignoreTransactions) : false;
}
__name(_isIgnoredTransaction, "_isIgnoredTransaction");
function _isDeniedUrl(event, denyUrls) {
  if (!denyUrls?.length) {
    return false;
  }
  const url = _getEventFilterUrl(event);
  return !url ? false : stringMatchesSomePattern(url, denyUrls);
}
__name(_isDeniedUrl, "_isDeniedUrl");
function _isAllowedUrl(event, allowUrls) {
  if (!allowUrls?.length) {
    return true;
  }
  const url = _getEventFilterUrl(event);
  return !url ? true : stringMatchesSomePattern(url, allowUrls);
}
__name(_isAllowedUrl, "_isAllowedUrl");
function _getLastValidUrl(frames = []) {
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    if (frame && frame.filename !== "<anonymous>" && frame.filename !== "[native code]") {
      return frame.filename || null;
    }
  }
  return null;
}
__name(_getLastValidUrl, "_getLastValidUrl");
function _getEventFilterUrl(event) {
  try {
    const rootException = [...event.exception?.values ?? []].reverse().find((value) => value.mechanism?.parent_id === void 0 && value.stacktrace?.frames?.length);
    const frames = rootException?.stacktrace?.frames;
    return frames ? _getLastValidUrl(frames) : null;
  } catch {
    DEBUG_BUILD && debug.error(`Cannot extract url for event ${getEventDescription(event)}`);
    return null;
  }
}
__name(_getEventFilterUrl, "_getEventFilterUrl");
function _isUselessError(event) {
  if (!event.exception?.values?.length) {
    return false;
  }
  return (
    // No top-level message
    !event.message && // There are no exception values that have a stacktrace, a non-generic-Error type or value
    !event.exception.values.some((value) => value.stacktrace || value.type && value.type !== "Error" || value.value)
  );
}
__name(_isUselessError, "_isUselessError");

// node_modules/@sentry/core/build/esm/integrations/linkederrors.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/aggregate-errors.js
init_modules_watch_stub();
function applyAggregateErrorsToEvent(exceptionFromErrorImplementation, parser, key, limit, event, hint) {
  if (!event.exception?.values || !hint || !isError(hint.originalException)) {
    return;
  }
  const originalException = event.exception.values.length > 0 ? event.exception.values[event.exception.values.length - 1] : void 0;
  if (originalException) {
    event.exception.values = aggregateExceptionsFromError(
      exceptionFromErrorImplementation,
      parser,
      limit,
      hint.originalException,
      key,
      event.exception.values,
      originalException,
      0
    );
  }
}
__name(applyAggregateErrorsToEvent, "applyAggregateErrorsToEvent");
function aggregateExceptionsFromError(exceptionFromErrorImplementation, parser, limit, error2, key, prevExceptions, exception, exceptionId) {
  if (prevExceptions.length >= limit + 1) {
    return prevExceptions;
  }
  let newExceptions = [...prevExceptions];
  if (isError(error2[key])) {
    applyExceptionGroupFieldsForParentException(exception, exceptionId, error2);
    const newException = exceptionFromErrorImplementation(parser, error2[key]);
    const newExceptionId = newExceptions.length;
    applyExceptionGroupFieldsForChildException(newException, key, newExceptionId, exceptionId);
    newExceptions = aggregateExceptionsFromError(
      exceptionFromErrorImplementation,
      parser,
      limit,
      error2[key],
      key,
      [newException, ...newExceptions],
      newException,
      newExceptionId
    );
  }
  if (isExceptionGroup(error2)) {
    error2.errors.forEach((childError, i) => {
      if (isError(childError)) {
        applyExceptionGroupFieldsForParentException(exception, exceptionId, error2);
        const newException = exceptionFromErrorImplementation(parser, childError);
        const newExceptionId = newExceptions.length;
        applyExceptionGroupFieldsForChildException(newException, `errors[${i}]`, newExceptionId, exceptionId);
        newExceptions = aggregateExceptionsFromError(
          exceptionFromErrorImplementation,
          parser,
          limit,
          childError,
          key,
          [newException, ...newExceptions],
          newException,
          newExceptionId
        );
      }
    });
  }
  return newExceptions;
}
__name(aggregateExceptionsFromError, "aggregateExceptionsFromError");
function isExceptionGroup(error2) {
  return Array.isArray(error2.errors);
}
__name(isExceptionGroup, "isExceptionGroup");
function applyExceptionGroupFieldsForParentException(exception, exceptionId, error2) {
  exception.mechanism = {
    handled: true,
    type: "auto.core.linked_errors",
    ...isExceptionGroup(error2) && { is_exception_group: true },
    ...exception.mechanism,
    exception_id: exceptionId
  };
}
__name(applyExceptionGroupFieldsForParentException, "applyExceptionGroupFieldsForParentException");
function applyExceptionGroupFieldsForChildException(exception, source, exceptionId, parentId) {
  exception.mechanism = {
    handled: true,
    ...exception.mechanism,
    type: "chained",
    source,
    exception_id: exceptionId,
    parent_id: parentId
  };
}
__name(applyExceptionGroupFieldsForChildException, "applyExceptionGroupFieldsForChildException");

// node_modules/@sentry/core/build/esm/utils/eventbuilder.js
init_modules_watch_stub();
function parseStackFrames(stackParser, error2) {
  return stackParser(error2.stack || "", 1);
}
__name(parseStackFrames, "parseStackFrames");
function hasSentryFetchUrlHost(error2) {
  return isError(error2) && "__sentry_fetch_url_host__" in error2 && typeof error2.__sentry_fetch_url_host__ === "string";
}
__name(hasSentryFetchUrlHost, "hasSentryFetchUrlHost");
function _enhanceErrorWithSentryInfo(error2) {
  if (hasSentryFetchUrlHost(error2)) {
    return `${error2.message} (${error2.__sentry_fetch_url_host__})`;
  }
  return error2.message;
}
__name(_enhanceErrorWithSentryInfo, "_enhanceErrorWithSentryInfo");
function exceptionFromError(stackParser, error2) {
  const exception = {
    type: error2.name || error2.constructor.name,
    value: _enhanceErrorWithSentryInfo(error2)
  };
  const frames = parseStackFrames(stackParser, error2);
  if (frames.length) {
    exception.stacktrace = { frames };
  }
  return exception;
}
__name(exceptionFromError, "exceptionFromError");
function getErrorPropertyFromObject(obj) {
  for (const prop in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, prop)) {
      const value = obj[prop];
      if (isError(value)) {
        return value;
      }
    }
  }
  return void 0;
}
__name(getErrorPropertyFromObject, "getErrorPropertyFromObject");
function getMessageForObject(exception) {
  if ("name" in exception && typeof exception.name === "string") {
    let message2 = `'${exception.name}' captured as exception`;
    if ("message" in exception && typeof exception.message === "string") {
      message2 += ` with message '${exception.message}'`;
    }
    return message2;
  } else if ("message" in exception && typeof exception.message === "string") {
    return exception.message;
  }
  const keys = extractExceptionKeysForMessage(exception);
  if (isErrorEvent(exception)) {
    return `Event \`ErrorEvent\` captured as exception with message \`${exception.message}\``;
  }
  const className = getObjectClassName(exception);
  return `${className && className !== "Object" ? `'${className}'` : "Object"} captured as exception with keys: ${keys}`;
}
__name(getMessageForObject, "getMessageForObject");
function getObjectClassName(obj) {
  try {
    const prototype = Object.getPrototypeOf(obj);
    return prototype ? prototype.constructor.name : void 0;
  } catch {
  }
}
__name(getObjectClassName, "getObjectClassName");
function getException(client, mechanism, exception, hint) {
  if (isError(exception)) {
    return [exception, void 0];
  }
  mechanism.synthetic = true;
  if (isPlainObject(exception)) {
    const normalizeDepth = client?.getOptions().normalizeDepth;
    const extras = { ["__serialized__"]: normalizeToSize(exception, normalizeDepth) };
    const errorFromProp = getErrorPropertyFromObject(exception);
    if (errorFromProp) {
      return [errorFromProp, extras];
    }
    const message2 = getMessageForObject(exception);
    const ex2 = hint?.syntheticException || new Error(message2);
    ex2.message = message2;
    return [ex2, extras];
  }
  const ex = hint?.syntheticException || new Error(exception);
  ex.message = `${exception}`;
  return [ex, void 0];
}
__name(getException, "getException");
function eventFromUnknownInput(client, stackParser, exception, hint) {
  const providedMechanism = hint?.data && hint.data.mechanism;
  const mechanism = providedMechanism || {
    handled: true,
    type: "generic"
  };
  const [ex, extras] = getException(client, mechanism, exception, hint);
  const event = {
    exception: {
      values: [exceptionFromError(stackParser, ex)]
    }
  };
  if (extras) {
    event.extra = extras;
  }
  addExceptionTypeValue(event, void 0, void 0);
  addExceptionMechanism(event, mechanism);
  return {
    ...event,
    event_id: hint?.event_id
  };
}
__name(eventFromUnknownInput, "eventFromUnknownInput");
function eventFromMessage(stackParser, message2, level = "info", hint, attachStacktrace) {
  const event = {
    event_id: hint?.event_id,
    level
  };
  if (attachStacktrace && hint?.syntheticException) {
    const frames = parseStackFrames(stackParser, hint.syntheticException);
    if (frames.length) {
      event.exception = {
        values: [
          {
            value: message2,
            stacktrace: { frames }
          }
        ]
      };
      addExceptionMechanism(event, { synthetic: true });
    }
  }
  if (isParameterizedString(message2)) {
    const { __sentry_template_string__, __sentry_template_values__ } = message2;
    event.logentry = {
      message: __sentry_template_string__,
      params: __sentry_template_values__
    };
    return event;
  }
  event.message = message2;
  return event;
}
__name(eventFromMessage, "eventFromMessage");

// node_modules/@sentry/core/build/esm/integrations/linkederrors.js
var DEFAULT_KEY = "cause";
var DEFAULT_LIMIT = 5;
var INTEGRATION_NAME4 = "LinkedErrors";
var _linkedErrorsIntegration = /* @__PURE__ */ __name(((options = {}) => {
  const limit = options.limit || DEFAULT_LIMIT;
  const key = options.key || DEFAULT_KEY;
  return {
    name: INTEGRATION_NAME4,
    preprocessEvent(event, hint, client) {
      const options2 = client.getOptions();
      applyAggregateErrorsToEvent(exceptionFromError, options2.stackParser, key, limit, event, hint);
    }
  };
}), "_linkedErrorsIntegration");
var linkedErrorsIntegration = defineIntegration(_linkedErrorsIntegration);

// node_modules/@sentry/core/build/esm/integrations/requestdata.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/localhost.js
init_modules_watch_stub();
var LOCAL_IPS = ["127.0.0.1", "::1"];
var LOCAL_DOMAINS = ["127.0.0.1", "localhost"];
var HOST_HEADERS = ["host", "x-forwarded-host"];
function isLocalhostRequest(request, ipAddress) {
  if (ipAddress && LOCAL_IPS.includes(ipAddress)) {
    return true;
  }
  const url = request?.url ? parseStringToURLObject(request.url) : void 0;
  if (url && !isURLObjectRelative(url)) {
    if (url.protocol === "file:") {
      return true;
    }
    if (LOCAL_DOMAINS.some((domain) => hostMatchesOrIsSubdomainOf(url.hostname, domain))) {
      return true;
    }
  }
  const headers = request?.headers;
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (!HOST_HEADERS.includes(name.toLowerCase())) {
        continue;
      }
      const host = value?.split(":")[0];
      if (host && LOCAL_DOMAINS.includes(host)) {
        return true;
      }
    }
  }
  return false;
}
__name(isLocalhostRequest, "isLocalhostRequest");
function hostMatchesOrIsSubdomainOf(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}
__name(hostMatchesOrIsSubdomainOf, "hostMatchesOrIsSubdomainOf");

// node_modules/@sentry/core/build/esm/utils/clientIPAddress.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/vendor/getIpAddress.js
init_modules_watch_stub();
var ipHeaderNames = [
  "X-Client-IP",
  "X-Forwarded-For",
  "Fly-Client-IP",
  "CF-Connecting-IP",
  "Fastly-Client-Ip",
  "True-Client-Ip",
  "X-Real-IP",
  "X-Cluster-Client-IP",
  "X-Forwarded",
  "Forwarded-For",
  "Forwarded",
  "X-Vercel-Forwarded-For"
];
function getClientIPAddress(headers) {
  const lowerCaseHeaders = {};
  for (const key of Object.keys(headers)) {
    lowerCaseHeaders[key.toLowerCase()] = headers[key];
  }
  const headerValues = ipHeaderNames.map((headerName) => {
    const rawValue = lowerCaseHeaders[headerName.toLowerCase()];
    const value = Array.isArray(rawValue) ? rawValue.join(";") : rawValue;
    if (headerName === "Forwarded") {
      return parseForwardedHeader(value);
    }
    return value?.split(",").map((v) => v.trim());
  });
  const flattenedHeaderValues = headerValues.reduce((acc, val) => {
    if (!val) {
      return acc;
    }
    return acc.concat(val);
  }, []);
  const ipAddress = flattenedHeaderValues.find((ip) => ip !== null && isIP(ip));
  return ipAddress || null;
}
__name(getClientIPAddress, "getClientIPAddress");
function parseForwardedHeader(value) {
  if (!value) {
    return null;
  }
  for (const part of value.split(";")) {
    if (part.startsWith("for=")) {
      return part.slice(4);
    }
  }
  return null;
}
__name(parseForwardedHeader, "parseForwardedHeader");
function isIP(str) {
  const regex = /(?:^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$)|(?:^(?:(?:[a-fA-F\d]{1,4}:){7}(?:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){6}(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){5}(?::(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,2}|:)|(?:[a-fA-F\d]{1,4}:){4}(?:(?::[a-fA-F\d]{1,4}){0,1}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,3}|:)|(?:[a-fA-F\d]{1,4}:){3}(?:(?::[a-fA-F\d]{1,4}){0,2}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,4}|:)|(?:[a-fA-F\d]{1,4}:){2}(?:(?::[a-fA-F\d]{1,4}){0,3}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,5}|:)|(?:[a-fA-F\d]{1,4}:){1}(?:(?::[a-fA-F\d]{1,4}){0,4}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,6}|:)|(?::(?:(?::[a-fA-F\d]{1,4}){0,5}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,7}|:)))(?:%[0-9a-zA-Z]{1,})?$)/;
  return regex.test(str);
}
__name(isIP, "isIP");

// node_modules/@sentry/core/build/esm/utils/clientIPAddress.js
var IP_HEADER_NAMES = new Set(ipHeaderNames.map((name) => name.toLowerCase()));
function getClientIPAddress2(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (value == null || !IP_HEADER_NAMES.has(name)) {
      continue;
    }
    const joined = Array.isArray(value) ? value.join(",") : value;
    normalized[key] = name === "forwarded" ? normalizeForwardedHeader(joined) : joined.split(",").map((ip) => stripPort(ip.trim())).join(",");
  }
  return getClientIPAddress(normalized);
}
__name(getClientIPAddress2, "getClientIPAddress");
function normalizeForwardedHeader(value) {
  const forPair = value.split(/[,;]/).map((part) => part.trim()).find((part) => part.slice(0, 4).toLowerCase() === "for=");
  return forPair ? `for=${stripPort(forPair.slice(4).replace(/^"(.*)"$/, "$1"))}` : "";
}
__name(normalizeForwardedHeader, "normalizeForwardedHeader");
function stripPort(ip) {
  return ip.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1] ?? ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)?.[1] ?? ip;
}
__name(stripPort, "stripPort");

// node_modules/@sentry/core/build/esm/integrations/requestdata.js
var INTEGRATION_NAME5 = "RequestData";
var _requestDataIntegration = /* @__PURE__ */ __name(((options = {}) => {
  function resolveRequestDataOptions(client) {
    const dataCollection = client.getDataCollectionOptions();
    const include = {
      // oxlint-disable-next-line typescript/no-deprecated
      cookies: options.include?.cookies ?? dataCollection.cookies !== false,
      // Always attach body data that's already on the scope — dataCollection.httpBodies gates write-time, not read-time
      // oxlint-disable-next-line typescript/no-deprecated
      data: options.include?.data ?? true,
      // oxlint-disable-next-line typescript/no-deprecated
      headers: options.include?.headers ?? dataCollection.httpHeaders.request !== false,
      // oxlint-disable-next-line typescript/no-deprecated
      ip: options.include?.ip ?? dataCollection.userInfo,
      // oxlint-disable-next-line typescript/no-deprecated
      query_string: options.include?.query_string ?? dataCollection.urlQueryParams !== false,
      // No dataCollection equivalent — URL is always included
      // oxlint-disable-next-line typescript/no-deprecated
      url: options.include?.url ?? true
    };
    return {
      include,
      dataCollection: {
        ...dataCollection,
        cookies: resolveFilteringBehavior(include.cookies, dataCollection.cookies),
        httpHeaders: {
          ...dataCollection.httpHeaders,
          request: resolveFilteringBehavior(include.headers, dataCollection.httpHeaders.request)
        },
        urlQueryParams: resolveFilteringBehavior(include.query_string, dataCollection.urlQueryParams)
      }
    };
  }
  __name(resolveRequestDataOptions, "resolveRequestDataOptions");
  return {
    name: INTEGRATION_NAME5,
    processEvent(event, _hint, client) {
      const { sdkProcessingMetadata = {} } = event;
      const { normalizedRequest, ipAddress } = sdkProcessingMetadata;
      if (!normalizedRequest) {
        return event;
      }
      const { include, dataCollection } = resolveRequestDataOptions(client);
      addNormalizedRequestDataToEvent(event, normalizedRequest, { ipAddress }, include, dataCollection);
      return event;
    },
    processSpan(span) {
      const { user, sdkProcessingMetadata } = getIsolationScope().getScopeData();
      safeSetSpanJSONAttributes(span, {
        [Jd]: isLocalhostSpan(sdkProcessingMetadata, user.ip_address)
      });
    },
    processSegmentSpan(span, client) {
      const { sdkProcessingMetadata = {} } = getIsolationScope().getScopeData();
      const { normalizedRequest, ipAddress } = sdkProcessingMetadata;
      if (!normalizedRequest) {
        return;
      }
      const { include, dataCollection } = resolveRequestDataOptions(client);
      addNormalizedRequestDataToSpan(span, normalizedRequest, ipAddress, include, dataCollection);
    }
  };
}), "_requestDataIntegration");
var localhostByRequest = /* @__PURE__ */ new WeakMap();
function isLocalhostSpan(sdkProcessingMetadata, scopeUserIpAddress) {
  const { normalizedRequest, ipAddress } = sdkProcessingMetadata;
  if (!normalizedRequest) {
    return isLocalhostRequest(void 0, ipAddress || scopeUserIpAddress);
  }
  const cached = localhostByRequest.get(normalizedRequest);
  if (cached !== void 0) {
    return cached;
  }
  const headers = normalizedRequest.headers;
  const clientIpAddress = headers && getClientIPAddress2(headers) || ipAddress || scopeUserIpAddress;
  const isLocalhost = isLocalhostRequest(normalizedRequest, clientIpAddress);
  localhostByRequest.set(normalizedRequest, isLocalhost);
  return isLocalhost;
}
__name(isLocalhostSpan, "isLocalhostSpan");
var requestDataIntegration = defineIntegration(_requestDataIntegration);
function addNormalizedRequestDataToEvent(event, req, additionalData, include, dataCollection) {
  const requestData = extractNormalizedRequestData(req, include);
  if (requestData.cookies) {
    requestData.cookies = filterKeyValueData(
      requestData.cookies,
      dataCollection.cookies,
      SENSITIVE_COOKIE_NAME_SNIPPETS
    );
  }
  if (requestData.headers) {
    requestData.headers = filterKeyValueData(requestData.headers, dataCollection.httpHeaders.request);
  }
  if (requestData.query_string) {
    requestData.query_string = normalizeAndFilterQueryString(requestData.query_string, dataCollection.urlQueryParams);
  }
  if (requestData.url) {
    requestData.url = filterUrlQuery(requestData.url, dataCollection.urlQueryParams);
  }
  event.request = {
    ...event.request,
    ...requestData
  };
  if (include.ip) {
    const ip = req.headers && getClientIPAddress2(req.headers) || additionalData.ipAddress;
    if (ip) {
      event.user = {
        ...event.user,
        ip_address: ip
      };
    }
  }
}
__name(addNormalizedRequestDataToEvent, "addNormalizedRequestDataToEvent");
function addNormalizedRequestDataToSpan(span, normalizedRequest, ipAddress, include, dataCollection) {
  const requestData = extractNormalizedRequestData(normalizedRequest, include);
  const attributes = {};
  if (requestData.url) {
    attributes[ib] = filterUrlQuery(requestData.url, dataCollection.urlQueryParams);
  }
  if (requestData.method) {
    attributes["http.request.method"] = requestData.method;
  }
  if (requestData.query_string) {
    attributes[pb] = normalizeAndFilterQueryString(requestData.query_string, dataCollection.urlQueryParams);
  }
  safeSetSpanJSONAttributes(span, attributes);
  if (include.cookies) {
    const cookieHeader = normalizedRequest.headers?.cookie;
    const cookiePairs = normalizedRequest.cookies ? Object.entries(normalizedRequest.cookies) : cookieHeader ? parseCookieHeader(cookieHeader, "cookie") : [];
    if (cookiePairs.length > 0) {
      safeSetSpanJSONAttributes(span, {
        "http.request.header.cookie": filterCookiePairs(cookiePairs, dataCollection.cookies)
      });
    }
  }
  if (requestData.headers) {
    const headerAttributes = httpHeadersToSpanAttributes(requestData.headers, dataCollection, "request");
    safeSetSpanJSONAttributes(span, headerAttributes);
  }
  if (requestData.data != null) {
    const serialized = typeof requestData.data === "string" ? requestData.data : JSON.stringify(requestData.data);
    if (serialized) {
      safeSetSpanJSONAttributes(span, { "http.request.body.data": serialized });
    }
  }
  if (include.ip) {
    const ip = normalizedRequest.headers && getClientIPAddress2(normalizedRequest.headers) || ipAddress || void 0;
    if (ip) {
      safeSetSpanJSONAttributes(span, { [Tb]: ip });
    }
  }
}
__name(addNormalizedRequestDataToSpan, "addNormalizedRequestDataToSpan");
function extractNormalizedRequestData(normalizedRequest, include) {
  const requestData = {};
  const headers = { ...normalizedRequest.headers };
  if (include.headers) {
    requestData.headers = headers;
    if (!include.cookies) {
      delete headers.cookie;
    }
    if (!include.ip) {
      const ipHeaderNamesLower = new Set(ipHeaderNames.map((name) => name.toLowerCase()));
      for (const key of Object.keys(headers)) {
        if (ipHeaderNamesLower.has(key.toLowerCase())) {
          delete headers[key];
        }
      }
    }
  }
  requestData.method = normalizedRequest.method;
  if (include.url) {
    requestData.url = normalizedRequest.url;
  }
  if (include.cookies) {
    const cookies = normalizedRequest.cookies || (headers?.cookie ? cookiePairsToRecord(parseCookieHeader(headers.cookie, "cookie")) : void 0);
    requestData.cookies = cookies || {};
  }
  if (include.query_string) {
    requestData.query_string = normalizedRequest.query_string;
  }
  if (include.data) {
    requestData.data = normalizedRequest.data;
  }
  return requestData;
}
__name(extractNormalizedRequestData, "extractNormalizedRequestData");
function resolveFilteringBehavior(isIncluded, behavior) {
  return isIncluded && behavior === false ? true : behavior;
}
__name(resolveFilteringBehavior, "resolveFilteringBehavior");
function normalizeAndFilterQueryString(queryString, behavior) {
  const normalized = normalizeQueryString(queryString);
  return normalized ? filterQueryParams(normalized, behavior) : void 0;
}
__name(normalizeAndFilterQueryString, "normalizeAndFilterQueryString");
function normalizeQueryString(queryString) {
  if (typeof queryString === "string") {
    return getUrlQuery(queryString);
  }
  const pairs = Array.isArray(queryString) ? queryString : Object.entries(queryString);
  const normalized = new URLSearchParams(pairs).toString();
  return normalized || void 0;
}
__name(normalizeQueryString, "normalizeQueryString");

// node_modules/@sentry/core/build/esm/instrument/console.js
init_modules_watch_stub();
var _filter = /* @__PURE__ */ new Set([]);
function addConsoleInstrumentationHandler(handler) {
  const type = "console";
  const removeHandler = addHandler(type, handler);
  maybeInstrument(type, instrumentConsole);
  return removeHandler;
}
__name(addConsoleInstrumentationHandler, "addConsoleInstrumentationHandler");
function addConsoleInstrumentationFilter(filter) {
  for (const f of filter) {
    _filter.add(f);
  }
  return () => {
    for (const f of filter) {
      _filter.delete(f);
    }
  };
}
__name(addConsoleInstrumentationFilter, "addConsoleInstrumentationFilter");
var instrumentedLevels = /* @__PURE__ */ new Set();
function instrumentConsole() {
  if (!("console" in GLOBAL_OBJ)) {
    return;
  }
  CONSOLE_LEVELS.forEach(function(level) {
    if (instrumentedLevels.has(level) || !(level in GLOBAL_OBJ.console)) {
      return;
    }
    instrumentedLevels.add(level);
    fill(GLOBAL_OBJ.console, level, function(originalConsoleMethod) {
      originalConsoleMethods[level] = originalConsoleMethod;
      return function(...args) {
        const firstArg = args[0];
        const log2 = originalConsoleMethods[level];
        const isFiltered = _filter.size && typeof firstArg === "string" && stringMatchesSomePattern(firstArg, _filter);
        if (!isFiltered) {
          triggerHandlers("console", { args, level });
        }
        if (!isFiltered || DEBUG_BUILD && debug.isEnabled()) {
          log2?.apply(GLOBAL_OBJ.console, args);
        }
      };
    });
  });
}
__name(instrumentConsole, "instrumentConsole");

// node_modules/@sentry/core/build/esm/utils/severity.js
init_modules_watch_stub();
function severityLevelFromString(level) {
  return level === "warn" ? "warning" : ["fatal", "error", "warning", "log", "info", "debug"].includes(level) ? level : "log";
}
__name(severityLevelFromString, "severityLevelFromString");

// node_modules/@sentry/core/build/esm/integrations/dedupe.js
init_modules_watch_stub();
var INTEGRATION_NAME6 = "Dedupe";
var _dedupeIntegration = /* @__PURE__ */ __name((() => {
  let previousEvent;
  return {
    name: INTEGRATION_NAME6,
    processEvent(currentEvent) {
      if (currentEvent.type) {
        return currentEvent;
      }
      try {
        if (_shouldDropEvent2(currentEvent, previousEvent)) {
          DEBUG_BUILD && debug.warn("Event dropped due to being a duplicate of previously captured event.");
          return null;
        }
      } catch {
      }
      return previousEvent = currentEvent;
    }
  };
}), "_dedupeIntegration");
var dedupeIntegration = defineIntegration(_dedupeIntegration);
function _shouldDropEvent2(currentEvent, previousEvent) {
  if (!previousEvent) {
    return false;
  }
  if (_isSameMessageEvent(currentEvent, previousEvent)) {
    return true;
  }
  if (_isSameExceptionEvent(currentEvent, previousEvent)) {
    return true;
  }
  return false;
}
__name(_shouldDropEvent2, "_shouldDropEvent");
function _isSameMessageEvent(currentEvent, previousEvent) {
  const currentMessage = currentEvent.message;
  const previousMessage = previousEvent.message;
  if (!currentMessage && !previousMessage) {
    return false;
  }
  if (currentMessage && !previousMessage || !currentMessage && previousMessage) {
    return false;
  }
  if (currentMessage !== previousMessage) {
    return false;
  }
  if (!_isSameFingerprint(currentEvent, previousEvent)) {
    return false;
  }
  if (!_isSameStacktrace(currentEvent, previousEvent)) {
    return false;
  }
  return true;
}
__name(_isSameMessageEvent, "_isSameMessageEvent");
function _isSameExceptionEvent(currentEvent, previousEvent) {
  const previousException = _getExceptionFromEvent(previousEvent);
  const currentException = _getExceptionFromEvent(currentEvent);
  if (!previousException || !currentException) {
    return false;
  }
  if (previousException.type !== currentException.type || previousException.value !== currentException.value) {
    return false;
  }
  if (!_isSameFingerprint(currentEvent, previousEvent)) {
    return false;
  }
  if (!_isSameStacktrace(currentEvent, previousEvent)) {
    return false;
  }
  return true;
}
__name(_isSameExceptionEvent, "_isSameExceptionEvent");
function _isSameStacktrace(currentEvent, previousEvent) {
  const currentFrames = getFramesFromEvent(currentEvent);
  const previousFrames = getFramesFromEvent(previousEvent);
  if (!currentFrames || !previousFrames) {
    return !currentFrames && !previousFrames;
  }
  if (previousFrames.length !== currentFrames.length) {
    return false;
  }
  for (let i = 0; i < previousFrames.length; i++) {
    const frameA = previousFrames[i];
    const frameB = currentFrames[i];
    if (frameA.filename !== frameB.filename || frameA.lineno !== frameB.lineno || frameA.colno !== frameB.colno || frameA.function !== frameB.function) {
      return false;
    }
  }
  return true;
}
__name(_isSameStacktrace, "_isSameStacktrace");
function _isSameFingerprint(currentEvent, previousEvent) {
  const currentFingerprint = currentEvent.fingerprint;
  const previousFingerprint = previousEvent.fingerprint;
  if (!currentFingerprint || !previousFingerprint) {
    return !currentFingerprint && !previousFingerprint;
  }
  try {
    return !!(currentFingerprint.join("") === previousFingerprint.join(""));
  } catch {
    return false;
  }
}
__name(_isSameFingerprint, "_isSameFingerprint");
function _getExceptionFromEvent(event) {
  return event.exception?.values?.[0];
}
__name(_getExceptionFromEvent, "_getExceptionFromEvent");

// node_modules/@sentry/core/build/esm/utils/path.js
init_modules_watch_stub();
var splitPathRe = /^(\S+:\\|\/?)([\s\S]*?)((?:\.{1,2}|[^/\\]+?|)(\.[^./\\]*|))(?:[/\\]*)$/;
function splitPath(filename) {
  const truncated = filename.length > 1024 ? `<truncated>${filename.slice(-1024)}` : filename;
  const parts = splitPathRe.exec(truncated);
  return parts ? parts.slice(1) : [];
}
__name(splitPath, "splitPath");
function basename(path, ext) {
  let f = splitPath(path)[2] || "";
  if (ext && f.slice(ext.length * -1) === ext) {
    f = f.slice(0, f.length - ext.length);
  }
  return f;
}
__name(basename, "basename");

// node_modules/@sentry/core/build/esm/integrations/console.js
init_modules_watch_stub();
var INTEGRATION_NAME7 = "Console";
var consoleIntegration = defineIntegration((options = {}) => {
  const levels = new Set(options.levels || CONSOLE_LEVELS);
  return {
    name: INTEGRATION_NAME7,
    setup(client) {
      const unsubscribe = addConsoleInstrumentationHandler(({ args, level }) => {
        if (getClient() !== client || !levels.has(level)) {
          return;
        }
        addConsoleBreadcrumb(level, args);
      });
      client.registerCleanup(unsubscribe);
      if (options.filter) {
        const unsubscribe2 = addConsoleInstrumentationFilter(options.filter);
        client.registerCleanup(unsubscribe2);
      }
    }
  };
});
function addConsoleBreadcrumb(level, args) {
  const breadcrumb = {
    category: "console",
    data: {
      arguments: args,
      logger: "console"
    },
    level: severityLevelFromString(level),
    message: formatConsoleArgs(args)
  };
  if (level === "assert") {
    if (args[0] === false) {
      const assertionArgs = args.slice(1);
      breadcrumb.message = assertionArgs.length > 0 ? `Assertion failed: ${formatConsoleArgs(assertionArgs)}` : "Assertion failed";
      breadcrumb.data.arguments = assertionArgs;
    } else {
      return;
    }
  }
  addBreadcrumb(breadcrumb, {
    input: args,
    level
  });
}
__name(addConsoleBreadcrumb, "addConsoleBreadcrumb");
function formatConsoleArgs(values) {
  return "util" in GLOBAL_OBJ && typeof GLOBAL_OBJ.util.format === "function" ? GLOBAL_OBJ.util.format(...values) : safeJoin(values, " ");
}
__name(formatConsoleArgs, "formatConsoleArgs");

// node_modules/@sentry/core/build/esm/integrations/conversationId.js
init_modules_watch_stub();
var INTEGRATION_NAME8 = "ConversationId";
var _conversationIdIntegration = /* @__PURE__ */ __name((() => {
  return {
    name: INTEGRATION_NAME8,
    setup(client) {
      client.on("spanStart", (span) => {
        const scopeData = getCurrentScope().getScopeData();
        const isolationScopeData = getIsolationScope().getScopeData();
        const conversationId = scopeData.conversationId || isolationScopeData.conversationId;
        if (conversationId) {
          const { op, data: attributes, description: name } = spanToStaticSpanJSON(span);
          if (!op?.startsWith("gen_ai.") && !attributes["ai.operationId"] && !name?.startsWith("ai.")) {
            return;
          }
          span.setAttribute(wr, conversationId);
        }
      });
    }
  };
}), "_conversationIdIntegration");
var conversationIdIntegration = defineIntegration(_conversationIdIntegration);

// node_modules/@sentry/core/build/esm/integrations/fetch.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/fetch.js
init_modules_watch_stub();
function instrumentFetchRequest(handlerData, shouldCreateSpan, shouldAttachHeaders, spans, instrumentFetchRequestOptions) {
  if (!handlerData.fetchData) {
    return void 0;
  }
  const { method, url } = handlerData.fetchData;
  const shouldCreateSpanResult = hasSpansEnabled() && shouldCreateSpan(url);
  if (handlerData.endTimestamp) {
    const spanId = handlerData.fetchData.__span;
    if (!spanId) return;
    const span2 = spans[spanId];
    if (span2) {
      if (shouldCreateSpanResult) {
        endSpan(span2, handlerData);
        _callOnRequestSpanEnd(span2, handlerData, instrumentFetchRequestOptions);
      }
      delete spans[spanId];
    }
    return void 0;
  }
  const {
    spanOrigin = "auto.http.browser",
    propagateTraceparent = false,
    urlBase
  } = instrumentFetchRequestOptions ?? {};
  const client = getClient();
  const hasParent = !!getActiveSpan();
  const shouldEmitSpan = hasParent || !!client && hasSpanStreamingEnabled(client);
  const span = shouldCreateSpanResult && shouldEmitSpan ? startInactiveSpan(getSpanStartOptions(url, method, spanOrigin, client, urlBase)) : new SentryNonRecordingSpan();
  const spanForTraceHeaders = spanIsIgnored(span) && hasParent ? void 0 : span;
  if (shouldCreateSpanResult && !shouldEmitSpan) {
    client?.recordDroppedEvent("no_parent_span", "span");
  }
  handlerData.fetchData.__span = span.spanContext().spanId;
  spans[span.spanContext().spanId] = span;
  if (shouldAttachHeaders(handlerData.fetchData.url)) {
    const request = handlerData.args[0];
    const options = { ...handlerData.args[1] || {} };
    const headers = _INTERNAL_getTracingHeadersForFetchRequest(
      request,
      options,
      // If performance is disabled (TWP) or there's no active root span (pageload/navigation/interaction),
      // we do not want to use the span as base for the trace headers,
      // which means that the headers will be generated from the scope and the sampling decision is deferred
      hasSpansEnabled() && shouldEmitSpan ? spanForTraceHeaders : void 0,
      propagateTraceparent
    );
    if (headers) {
      handlerData.args[1] = options;
      options.headers = headers;
    }
  }
  if (client) {
    const fetchHint = {
      input: handlerData.args,
      response: handlerData.response,
      startTimestamp: handlerData.startTimestamp,
      endTimestamp: handlerData.endTimestamp
    };
    client.emit("beforeOutgoingRequestSpan", span, fetchHint);
  }
  return span;
}
__name(instrumentFetchRequest, "instrumentFetchRequest");
function _callOnRequestSpanEnd(span, handlerData, instrumentFetchRequestOptions) {
  instrumentFetchRequestOptions?.onRequestSpanEnd?.(span, {
    headers: handlerData.response?.headers,
    error: handlerData.error
  });
}
__name(_callOnRequestSpanEnd, "_callOnRequestSpanEnd");
function _INTERNAL_getTracingHeadersForFetchRequest(request, fetchOptionsObj, span, propagateTraceparent) {
  const traceHeaders = getTraceData({ span, propagateTraceparent });
  const sentryTrace = traceHeaders["sentry-trace"];
  const baggage = traceHeaders.baggage;
  const traceparent = traceHeaders.traceparent;
  if (!sentryTrace) {
    return void 0;
  }
  const originalHeaders = fetchOptionsObj.headers || (isRequest(request) ? request.headers : void 0);
  if (!originalHeaders) {
    return {
      "sentry-trace": sentryTrace,
      ...baggage && { baggage },
      ...traceparent && { traceparent }
    };
  } else if (isHeaders(originalHeaders)) {
    const newHeaders = new Headers(originalHeaders);
    if (!newHeaders.get("sentry-trace")) {
      newHeaders.set("sentry-trace", sentryTrace);
    }
    if (propagateTraceparent && traceparent && !newHeaders.get("traceparent")) {
      newHeaders.set("traceparent", traceparent);
    }
    if (baggage) {
      const prevBaggageHeader = newHeaders.get("baggage");
      if (!prevBaggageHeader) {
        newHeaders.set("baggage", baggage);
      } else if (!baggageHeaderHasSentryBaggageValues(prevBaggageHeader)) {
        newHeaders.set("baggage", `${prevBaggageHeader},${baggage}`);
      }
    }
    return newHeaders;
  } else if (isHeadersInitTupleArray(originalHeaders)) {
    const newHeaders = [...originalHeaders];
    if (!newHeaders.find((header) => header[0] === "sentry-trace")) {
      newHeaders.push(["sentry-trace", sentryTrace]);
    }
    if (propagateTraceparent && traceparent && !newHeaders.find((header) => header[0] === "traceparent")) {
      newHeaders.push(["traceparent", traceparent]);
    }
    const prevBaggageHeaderWithSentryValues = originalHeaders.find(
      (header) => header[0] === "baggage" && typeof header[1] === "string" && baggageHeaderHasSentryBaggageValues(header[1])
    );
    if (baggage && !prevBaggageHeaderWithSentryValues) {
      newHeaders.push(["baggage", baggage]);
    }
    return newHeaders;
  } else {
    const existingSentryTraceHeader = "sentry-trace" in originalHeaders ? originalHeaders["sentry-trace"] : void 0;
    const existingTraceparentHeader = "traceparent" in originalHeaders ? originalHeaders.traceparent : void 0;
    const existingBaggageHeader = "baggage" in originalHeaders ? originalHeaders.baggage : void 0;
    const newBaggageHeaders = existingBaggageHeader ? Array.isArray(existingBaggageHeader) ? [...existingBaggageHeader] : [existingBaggageHeader] : [];
    const prevBaggageHeaderWithSentryValues = existingBaggageHeader && (Array.isArray(existingBaggageHeader) ? existingBaggageHeader.find((headerItem) => baggageHeaderHasSentryBaggageValues(headerItem)) : baggageHeaderHasSentryBaggageValues(existingBaggageHeader));
    if (baggage && !prevBaggageHeaderWithSentryValues) {
      newBaggageHeaders.push(baggage);
    }
    const newHeaders = Object.assign({}, originalHeaders, {
      "sentry-trace": existingSentryTraceHeader ?? sentryTrace,
      ...newBaggageHeaders.length > 0 && { baggage: newBaggageHeaders.join(",") }
    });
    if (propagateTraceparent && traceparent && !existingTraceparentHeader) {
      newHeaders.traceparent = traceparent;
    }
    return newHeaders;
  }
}
__name(_INTERNAL_getTracingHeadersForFetchRequest, "_INTERNAL_getTracingHeadersForFetchRequest");
function endSpan(span, handlerData) {
  if (handlerData.response) {
    setHttpStatus(span, handlerData.response.status);
    const contentLength = handlerData.response?.headers?.get("content-length");
    if (contentLength) {
      const contentLengthNum = parseInt(contentLength);
      if (contentLengthNum > 0) {
        span.setAttribute(Ho, contentLengthNum);
      }
    }
  } else if (handlerData.error) {
    span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
  }
  span.end();
}
__name(endSpan, "endSpan");
function baggageHeaderHasSentryBaggageValues(baggageHeader) {
  if (typeof baggageHeader !== "string") {
    return false;
  }
  return baggageHeader.split(",").some((baggageEntry) => baggageEntry.trim().startsWith(SENTRY_BAGGAGE_KEY_PREFIX));
}
__name(baggageHeaderHasSentryBaggageValues, "baggageHeaderHasSentryBaggageValues");
function isHeaders(headers) {
  return typeof Headers !== "undefined" && isInstanceOf(headers, Headers);
}
__name(isHeaders, "isHeaders");
function isHeadersInitTupleArray(headers) {
  if (!Array.isArray(headers)) {
    return false;
  }
  return headers.every(
    (item) => Array.isArray(item) && item.length === 2 && typeof item[0] === "string"
  );
}
__name(isHeadersInitTupleArray, "isHeadersInitTupleArray");
function getSpanStartOptions(url, method, spanOrigin, client, urlBase) {
  const isStreamed = !!client && hasSpanStreamingEnabled(client);
  const domain = getUrlDomain(url, urlBase);
  if (url.startsWith("data:")) {
    const sanitizedUrl2 = stripDataUrlContent(url);
    return {
      name: isStreamed ? method : `${method} ${sanitizedUrl2}`,
      attributes: getFetchSpanAttributes(url, void 0, method, spanOrigin, client, domain)
    };
  }
  const parsedUrl = parseStringToURLObject(url);
  const sanitizedUrl = parsedUrl ? getSanitizedUrlStringFromUrlObject(parsedUrl) : url;
  return {
    name: isStreamed ? domain ? `${method} ${domain}` : method : `${method} ${sanitizedUrl}`,
    attributes: getFetchSpanAttributes(url, parsedUrl, method, spanOrigin, client, domain)
  };
}
__name(getSpanStartOptions, "getSpanStartOptions");
function getFetchSpanAttributes(url, parsedUrl, method, spanOrigin, client, domain) {
  const attributes = {
    [ib]: filterCollectedUrl(stripDataUrlContent(url), client),
    type: "fetch",
    // oxlint-disable-next-line typescript/no-deprecated
    [Do]: method,
    [gm]: spanOrigin,
    [mm]: UE,
    [eb]: domain
  };
  if (parsedUrl) {
    if (!isURLObjectRelative(parsedUrl)) {
      attributes[ib] = filterCollectedUrl(stripDataUrlContent(parsedUrl.href), client);
      attributes[tg] = parsedUrl.hostname;
      attributes[ag] = parsedUrl.port ? Number(parsedUrl.port) : void 0;
    }
    attributes[pb] = filterCollectedUrlQuery(getUrlQuery(parsedUrl.search), client);
    attributes[tb] = getUrlFragment(parsedUrl.hash);
  }
  return attributes;
}
__name(getFetchSpanAttributes, "getFetchSpanAttributes");

// node_modules/@sentry/core/build/esm/instrument/fetch.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/utils/supports.js
init_modules_watch_stub();
var WINDOW = GLOBAL_OBJ;
function _isFetchSupported() {
  if (!("fetch" in WINDOW)) {
    return false;
  }
  try {
    new Headers();
    new Request("data:,");
    new Response();
    return true;
  } catch {
    return false;
  }
}
__name(_isFetchSupported, "_isFetchSupported");
function isNativeFunction(func) {
  return func && /^function\s+\w+\(\)\s+\{\s+\[native code\]\s+\}$/.test(func.toString());
}
__name(isNativeFunction, "isNativeFunction");
function supportsNativeFetch() {
  if (typeof EdgeRuntime === "string") {
    return true;
  }
  if (!_isFetchSupported()) {
    return false;
  }
  if (isNativeFunction(WINDOW.fetch)) {
    return true;
  }
  let result = false;
  const doc = WINDOW.document;
  if (doc && typeof doc.createElement === "function") {
    try {
      const sandbox = doc.createElement("iframe");
      sandbox.hidden = true;
      doc.head.appendChild(sandbox);
      if (sandbox.contentWindow?.fetch) {
        result = isNativeFunction(sandbox.contentWindow.fetch);
      }
      doc.head.removeChild(sandbox);
    } catch (err) {
      DEBUG_BUILD && debug.warn("Could not create sandbox iframe for pure fetch check, bailing to window.fetch: ", err);
    }
  }
  return result;
}
__name(supportsNativeFetch, "supportsNativeFetch");

// node_modules/@sentry/core/build/esm/instrument/fetch.js
function addFetchInstrumentationHandler(handler) {
  const type = "fetch";
  const removeHandler = addHandler(type, handler);
  maybeInstrument(type, () => instrumentFetch());
  return removeHandler;
}
__name(addFetchInstrumentationHandler, "addFetchInstrumentationHandler");
function instrumentFetch(onFetchResolved) {
  if (isBrowser() && !supportsNativeFetch()) {
    return;
  }
  fill(GLOBAL_OBJ, "fetch", function(originalFetch) {
    return new Proxy(originalFetch, {
      apply(target, _thisArg, args) {
        const virtualError = new Error();
        const { method, url } = parseFetchArgs(args);
        const handlerData = {
          args,
          fetchData: {
            method,
            url
          },
          startTimestamp: timestampInSeconds() * 1e3,
          // // Adding the error to be able to fingerprint the failed fetch event in HttpClient instrumentation
          virtualError,
          headers: getHeadersFromFetchArgs(args)
        };
        if (!onFetchResolved) {
          triggerHandlers("fetch", {
            ...handlerData
          });
        }
        return Reflect.apply(target, GLOBAL_OBJ, args).then(
          async (response) => {
            if (onFetchResolved) {
              onFetchResolved(response);
            } else {
              triggerHandlers("fetch", {
                ...handlerData,
                endTimestamp: timestampInSeconds() * 1e3,
                response
              });
            }
            return response;
          },
          (error2) => {
            triggerHandlers("fetch", {
              ...handlerData,
              endTimestamp: timestampInSeconds() * 1e3,
              error: error2
            });
            if (isError(error2) && error2.stack === void 0) {
              error2.stack = virtualError.stack;
              addNonEnumerableProperty(error2, "framesToPop", 1);
            }
            const client = getClient();
            const enhanceOption = client?.getOptions().enhanceFetchErrorMessages ?? "always";
            const shouldEnhance = enhanceOption !== false;
            if (shouldEnhance && isError(error2) && error2.name === "TypeError" && (error2.message === "Failed to fetch" || error2.message === "Load failed" || error2.message === "NetworkError when attempting to fetch resource.")) {
              try {
                const url2 = new URL(handlerData.fetchData.url);
                const hostname = url2.host;
                if (enhanceOption === "always") {
                  error2.message = `${error2.message} (${hostname})`;
                } else {
                  addNonEnumerableProperty(error2, "__sentry_fetch_url_host__", hostname);
                }
              } catch {
              }
            }
            throw error2;
          }
        );
      }
    });
  });
}
__name(instrumentFetch, "instrumentFetch");
function hasProp(obj, prop) {
  return isObjectLike(obj) && !!obj[prop];
}
__name(hasProp, "hasProp");
function getUrlFromResource(resource) {
  if (typeof resource === "string") {
    return resource;
  }
  if (!resource) {
    return "";
  }
  if (hasProp(resource, "url")) {
    return resource.url;
  }
  if (resource.toString) {
    return resource.toString();
  }
  return "";
}
__name(getUrlFromResource, "getUrlFromResource");
function parseFetchArgs(fetchArgs) {
  if (fetchArgs.length === 0) {
    return { method: "GET", url: "" };
  }
  if (fetchArgs.length === 2) {
    const [resource, options] = fetchArgs;
    return {
      url: getUrlFromResource(resource),
      method: hasProp(options, "method") ? String(options.method).toUpperCase() : (
        // Request object as first argument
        isRequest(resource) && hasProp(resource, "method") ? String(resource.method).toUpperCase() : "GET"
      )
    };
  }
  const arg = fetchArgs[0];
  return {
    url: getUrlFromResource(arg),
    method: hasProp(arg, "method") ? String(arg.method).toUpperCase() : "GET"
  };
}
__name(parseFetchArgs, "parseFetchArgs");
function getHeadersFromFetchArgs(fetchArgs) {
  const [requestArgument, optionsArgument] = fetchArgs;
  try {
    if (typeof optionsArgument === "object" && optionsArgument !== null && "headers" in optionsArgument && optionsArgument.headers) {
      return new Headers(optionsArgument.headers);
    }
    if (isRequest(requestArgument)) {
      return new Headers(requestArgument.headers);
    }
  } catch {
  }
  return;
}
__name(getHeadersFromFetchArgs, "getHeadersFromFetchArgs");

// node_modules/@sentry/core/build/esm/utils/breadcrumb-log-level.js
init_modules_watch_stub();
function getBreadcrumbLogLevelFromHttpStatusCode(statusCode) {
  if (statusCode === void 0) {
    return void 0;
  } else if (statusCode >= 400 && statusCode < 500) {
    return "warning";
  } else if (statusCode >= 500) {
    return "error";
  } else {
    return void 0;
  }
}
__name(getBreadcrumbLogLevelFromHttpStatusCode, "getBreadcrumbLogLevelFromHttpStatusCode");

// node_modules/@sentry/core/build/esm/utils/lru.js
init_modules_watch_stub();
var LRUMap = class {
  static {
    __name(this, "LRUMap");
  }
  constructor(_maxSize) {
    this._maxSize = _maxSize;
    this._cache = /* @__PURE__ */ new Map();
  }
  /** Get the current size of the cache */
  get size() {
    return this._cache.size;
  }
  /** Get an entry or undefined if it was not in the cache. Re-inserts to update the recently used order */
  get(key) {
    const value = this._cache.get(key);
    if (value === void 0) {
      return void 0;
    }
    this._cache.delete(key);
    this._cache.set(key, value);
    return value;
  }
  /** Insert an entry and evict an older entry if we've reached maxSize */
  set(key, value) {
    this._cache.delete(key);
    if (this._cache.size >= this._maxSize) {
      const nextKey = this._cache.keys().next().value;
      this._cache.delete(nextKey);
    }
    this._cache.set(key, value);
  }
  /** Remove an entry and return the entry if it was in the cache */
  remove(key) {
    const value = this._cache.get(key);
    if (value) {
      this._cache.delete(key);
    }
    return value;
  }
  /** Clear all entries */
  clear() {
    this._cache.clear();
  }
  /** Get all the keys */
  keys() {
    return Array.from(this._cache.keys());
  }
  /** Get all the values */
  values() {
    const values = [];
    this._cache.forEach((value) => values.push(value));
    return values;
  }
};

// node_modules/@sentry/core/build/esm/integrations/fetch.js
function createFetchIntegration({
  name,
  spanOrigin
}) {
  const spans = {};
  const configs = /* @__PURE__ */ new WeakMap();
  const integration = /* @__PURE__ */ __name(((options = {}) => {
    return {
      name,
      setupOnce() {
        addFetchInstrumentationHandler((handlerData) => {
          const client = getClient();
          const config = client && configs.get(client);
          if (!client || !config) {
            return;
          }
          if (isSentryRequestUrl(handlerData.fetchData.url, client)) {
            return;
          }
          const { propagateTraceparent } = client.getOptions();
          instrumentFetchRequest(handlerData, config.shouldCreateSpan, config.shouldAttachTraceData, spans, {
            spanOrigin,
            propagateTraceparent
          });
          if (config.breadcrumbs) {
            createBreadcrumb(handlerData, client);
          }
        });
      },
      setup(client) {
        configs.set(client, resolveConfig(client, options));
      }
    };
  }), "integration");
  return defineIntegration(integration);
}
__name(createFetchIntegration, "createFetchIntegration");
function resolveConfig(client, options) {
  const { breadcrumbs = true, shouldCreateSpanForRequest, tracePropagation = true } = options;
  const createSpanUrlMap = new LRUMap(100);
  const headersUrlMap = new LRUMap(100);
  return {
    breadcrumbs,
    shouldCreateSpan(url) {
      if (shouldCreateSpanForRequest === void 0) {
        return true;
      }
      const cachedDecision = createSpanUrlMap.get(url);
      if (cachedDecision !== void 0) {
        return cachedDecision;
      }
      const decision = shouldCreateSpanForRequest(url);
      createSpanUrlMap.set(url, decision);
      return decision;
    },
    shouldAttachTraceData(url) {
      if (!tracePropagation) {
        return false;
      }
      return shouldPropagateTraceForUrl(url, client.getOptions().tracePropagationTargets, headersUrlMap);
    }
  };
}
__name(resolveConfig, "resolveConfig");
function createBreadcrumb(handlerData, client) {
  const { startTimestamp, endTimestamp } = handlerData;
  if (!endTimestamp) {
    return;
  }
  const parsedUrl = parseUrl(handlerData.fetchData.url);
  const breadcrumbData = {
    method: handlerData.fetchData.method,
    url: getSanitizedUrlString(parsedUrl),
    [pb]: filterCollectedUrlQuery(getUrlQuery(parsedUrl.search), client),
    [tb]: getUrlFragment(parsedUrl.hash)
  };
  if (handlerData.error) {
    const hint = {
      data: handlerData.error,
      input: handlerData.args,
      startTimestamp,
      endTimestamp
    };
    addBreadcrumb(
      {
        category: "fetch",
        data: breadcrumbData,
        level: "error",
        type: "http"
      },
      hint
    );
  } else {
    const response = handlerData.response;
    breadcrumbData.request_body_size = handlerData.fetchData.request_body_size;
    breadcrumbData.response_body_size = handlerData.fetchData.response_body_size;
    breadcrumbData.status_code = response?.status;
    const hint = {
      input: handlerData.args,
      response,
      startTimestamp,
      endTimestamp
    };
    const level = getBreadcrumbLogLevelFromHttpStatusCode(breadcrumbData.status_code);
    addBreadcrumb(
      {
        category: "fetch",
        data: breadcrumbData,
        type: "http",
        level
      },
      hint
    );
  }
}
__name(createBreadcrumb, "createBreadcrumb");

// node_modules/@sentry/core/build/esm/server.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/server-runtime-client.js
init_modules_watch_stub();

// node_modules/@sentry/core/build/esm/transports/userAgent.js
init_modules_watch_stub();
function addUserAgentToTransportHeaders(options) {
  const sdkMetadata = options._metadata?.sdk;
  const sdkUserAgent = sdkMetadata?.name && sdkMetadata?.version ? `${sdkMetadata?.name}/${sdkMetadata?.version}` : void 0;
  options.transportOptions = {
    ...options.transportOptions,
    headers: {
      ...sdkUserAgent && { "user-agent": sdkUserAgent },
      ...options.transportOptions?.headers
    }
  };
}
__name(addUserAgentToTransportHeaders, "addUserAgentToTransportHeaders");

// node_modules/@sentry/core/build/esm/server-runtime-client.js
var ServerRuntimeClient = class extends Client {
  static {
    __name(this, "ServerRuntimeClient");
  }
  /**
   * Creates a new Edge SDK instance.
   * @param options Configuration options for this SDK.
   */
  constructor(options) {
    addUserAgentToTransportHeaders(options);
    if ((typeof __SENTRY_TRACING__ === "undefined" || __SENTRY_TRACING__) && options.traceLifecycle !== "static" && !options.integrations.some((i) => i.name === INTEGRATION_NAME)) {
      options.integrations.push(spanStreamingIntegration());
    }
    super(options);
    this._disposeCallbacks = [];
    this._setUpMetricsProcessing();
  }
  /**
   * @inheritDoc
   */
  eventFromException(exception, hint) {
    const event = eventFromUnknownInput(this, this._options.stackParser, exception, hint);
    event.level = "error";
    return resolvedSyncPromise(event);
  }
  /**
   * @inheritDoc
   */
  eventFromMessage(message2, level = "info", hint) {
    return resolvedSyncPromise(
      eventFromMessage(this._options.stackParser, message2, level, hint, this._options.attachStacktrace)
    );
  }
  /**
   * @inheritDoc
   */
  captureException(exception, hint, scope) {
    setCurrentRequestSessionErroredOrCrashed(hint);
    return super.captureException(exception, hint, scope);
  }
  /**
   * @inheritDoc
   */
  captureEvent(event, hint, scope) {
    const isException = !event.type && event.exception?.values && event.exception.values.length > 0;
    if (isException) {
      setCurrentRequestSessionErroredOrCrashed(hint);
    }
    return super.captureEvent(event, hint, scope);
  }
  /**
   * Create a cron monitor check in and send it to Sentry.
   *
   * @param checkIn An object that describes a check in.
   * @param upsertMonitorConfig An optional object that describes a monitor config. Use this if you want
   * to create a monitor automatically when sending a check in.
   */
  captureCheckIn(checkIn, monitorConfig, scope) {
    const id = "checkInId" in checkIn && checkIn.checkInId ? checkIn.checkInId : uuid4();
    if (!this._isEnabled()) {
      DEBUG_BUILD && debug.warn("SDK not enabled, will not capture check-in.");
      return id;
    }
    const options = this.getOptions();
    const { release, environment, tunnel } = options;
    const serializedCheckIn = {
      check_in_id: id,
      monitor_slug: checkIn.monitorSlug,
      status: checkIn.status,
      release,
      environment
    };
    if ("duration" in checkIn) {
      serializedCheckIn.duration = checkIn.duration;
    }
    if (monitorConfig) {
      serializedCheckIn.monitor_config = {
        schedule: monitorConfig.schedule,
        checkin_margin: monitorConfig.checkinMargin,
        max_runtime: monitorConfig.maxRuntime,
        timezone: monitorConfig.timezone,
        failure_issue_threshold: monitorConfig.failureIssueThreshold,
        recovery_threshold: monitorConfig.recoveryThreshold
      };
    }
    const [dynamicSamplingContext, traceContext] = _getTraceInfoFromScope(this, scope);
    if (traceContext) {
      serializedCheckIn.contexts = {
        trace: traceContext
      };
    }
    const envelope = createCheckInEnvelope(
      serializedCheckIn,
      dynamicSamplingContext,
      this.getSdkMetadata(),
      tunnel,
      this.getDsn()
    );
    DEBUG_BUILD && debug.log("Sending checkin:", checkIn.monitorSlug, checkIn.status);
    this.sendEnvelope(envelope);
    return id;
  }
  /**
   * @inheritDoc
   */
  registerCleanup(callback) {
    this._disposeCallbacks.push(callback);
  }
  /**
   * Disposes of the client and releases all resources.
   *
   * This method clears all internal state to allow the client to be garbage collected.
   * It clears hooks, event processors, integrations, transport, and other internal references.
   *
   * Call this method after flushing to allow the client to be garbage collected.
   * After calling dispose(), the client should not be used anymore.
   *
   * Subclasses should override this method to clean up their own resources and call `super.dispose()`.
   */
  dispose() {
    DEBUG_BUILD && debug.log("Disposing client...");
    for (const callback of this._disposeCallbacks) {
      try {
        callback();
      } catch {
      }
    }
    this._disposeCallbacks.length = 0;
    for (const hookName of Object.keys(this._hooks)) {
      this._hooks[hookName]?.clear();
    }
    this._hooks = {};
    this._eventProcessors.length = 0;
    this._integrations = {};
    this._outcomes = {};
    this._transport = void 0;
    this._promiseBuffer = makePromiseBuffer(DEFAULT_TRANSPORT_BUFFER_SIZE);
  }
  /**
   * @inheritDoc
   */
  _prepareEvent(event, hint, currentScope, isolationScope) {
    if (this._options.platform) {
      event.platform = event.platform || this._options.platform;
    }
    if (this._options.runtime) {
      event.contexts = {
        ...event.contexts,
        runtime: event.contexts?.runtime || this._options.runtime
      };
    }
    if (this._options.serverName) {
      event.server_name = event.server_name || this._options.serverName;
    }
    return super._prepareEvent(event, hint, currentScope, isolationScope);
  }
  /**
   * Process a server-side metric before it is captured.
   */
  _setUpMetricsProcessing() {
    this.on("processMetric", (metric) => {
      if (this._options.serverName) {
        metric.attributes = {
          "server.address": this._options.serverName,
          ...metric.attributes
        };
      }
    });
  }
};
function setCurrentRequestSessionErroredOrCrashed(eventHint) {
  const requestSession = getIsolationScope().getScopeData().sdkProcessingMetadata.requestSession;
  if (requestSession) {
    const isHandledException = eventHint?.mechanism?.handled ?? true;
    if (isHandledException && requestSession.status !== "crashed") {
      requestSession.status = "errored";
    } else if (!isHandledException) {
      requestSession.status = "crashed";
    }
  }
}
__name(setCurrentRequestSessionErroredOrCrashed, "setCurrentRequestSessionErroredOrCrashed");

// node_modules/@sentry/core/build/esm/utils/node-stack-trace.js
init_modules_watch_stub();
function filenameIsInApp(filename, isNative = false) {
  const isInternal = isNative || filename && // It's not internal if it's an absolute linux path
  !filename.startsWith("/") && // It's not internal if it's an absolute windows path
  !filename.match(/^[A-Z]:/) && // It's not internal if the path is starting with a dot
  !filename.startsWith(".") && // It's not internal if the frame has a protocol. In node, this is usually the case if the file got pre-processed with a bundler like webpack
  !filename.match(/^[a-zA-Z]([a-zA-Z0-9.\-+])*:\/\//);
  return !isInternal && filename !== void 0 && !filename.includes("node_modules/");
}
__name(filenameIsInApp, "filenameIsInApp");
function node(getModule2) {
  const FILENAME_MATCH = /^\s*[-]{4,}$/;
  const FULL_MATCH = /at (?:async )?(?:(.+?)\s+\()?(?:(.+):(\d+):(\d+)?|([^)]+))\)?/;
  const DATA_URI_MATCH = /at (?:async )?(.+?) \(data:(.*?),/;
  return (line) => {
    const dataUriMatch = line.match(DATA_URI_MATCH);
    if (dataUriMatch) {
      return {
        filename: `<data:${dataUriMatch[2]}>`,
        function: dataUriMatch[1]
      };
    }
    const lineMatch = line.match(FULL_MATCH);
    if (lineMatch) {
      let object;
      let method;
      let functionName;
      let typeName;
      let methodName;
      if (lineMatch[1]) {
        functionName = lineMatch[1];
        let methodStart = functionName.lastIndexOf(".");
        if (functionName[methodStart - 1] === ".") {
          methodStart--;
        }
        if (methodStart > 0) {
          object = functionName.slice(0, methodStart);
          method = functionName.slice(methodStart + 1);
          const objectEnd = object.indexOf(".Module");
          if (objectEnd > 0) {
            functionName = functionName.slice(objectEnd + 1);
            object = object.slice(0, objectEnd);
          }
        }
        typeName = void 0;
      }
      if (method) {
        typeName = object;
        methodName = method;
      }
      if (method === "<anonymous>") {
        methodName = void 0;
        functionName = void 0;
      }
      if (functionName === void 0) {
        methodName = methodName || UNKNOWN_FUNCTION;
        functionName = typeName ? `${typeName}.${methodName}` : methodName;
      }
      let filename = normalizeStackTracePath(lineMatch[2]);
      const isNative = lineMatch[5] === "native";
      if (!filename && lineMatch[5] && !isNative) {
        filename = lineMatch[5];
      }
      const maybeDecodedFilename = filename ? _safeDecodeURI(filename) : void 0;
      return {
        filename: maybeDecodedFilename ?? filename,
        module: maybeDecodedFilename && getModule2?.(maybeDecodedFilename),
        function: functionName,
        lineno: _parseIntOrUndefined(lineMatch[3]),
        colno: _parseIntOrUndefined(lineMatch[4]),
        in_app: filenameIsInApp(filename || "", isNative)
      };
    }
    if (line.match(FILENAME_MATCH)) {
      return {
        filename: line
      };
    }
    return void 0;
  };
}
__name(node, "node");
function nodeStackLineParser(getModule2) {
  return [90, node(getModule2)];
}
__name(nodeStackLineParser, "nodeStackLineParser");
function _parseIntOrUndefined(input) {
  return parseInt(input || "", 10) || void 0;
}
__name(_parseIntOrUndefined, "_parseIntOrUndefined");
function _safeDecodeURI(filename) {
  try {
    return decodeURI(filename);
  } catch {
    return void 0;
  }
}
__name(_safeDecodeURI, "_safeDecodeURI");

// node_modules/@sentry/core/build/esm/utils/responseStreaming.js
init_modules_watch_stub();
function classifyResponseStreaming(res) {
  if (!res.body) {
    return { isStreaming: false };
  }
  const contentType = res.headers.get("content-type") ?? "";
  const contentLength = res.headers.get("content-length");
  if (/^text\/event-stream\b/i.test(contentType) || /^application\/(x-)?ndjson\b/i.test(contentType) || /^application\/stream\+json\b/i.test(contentType) || /^text\/plain\b/i.test(contentType) && !contentLength) {
    return { isStreaming: true };
  }
  return { isStreaming: false };
}
__name(classifyResponseStreaming, "classifyResponseStreaming");

// node_modules/@sentry/server-utils/build/esm/index.js
init_modules_watch_stub();

// node_modules/@sentry/server-utils/build/esm/async-context.js
init_modules_watch_stub();
import { AsyncLocalStorage } from "node:async_hooks";
function setAsyncLocalStorageAsyncContextStrategy() {
  const existingAsyncStorage = getAsyncContextStrategy(getMainCarrier()).getTracingChannelBinding?.()?.asyncLocalStorage;
  const asyncStorage = existingAsyncStorage ?? new AsyncLocalStorage();
  function getScopes() {
    const scopes = asyncStorage.getStore();
    if (scopes) {
      return scopes;
    }
    return {
      scope: getDefaultCurrentScope(),
      isolationScope: getDefaultIsolationScope()
    };
  }
  __name(getScopes, "getScopes");
  function withScope3(callback) {
    const scope = getScopes().scope.clone();
    const isolationScope = getScopes().isolationScope;
    return asyncStorage.run({ scope, isolationScope }, () => {
      return callback(scope);
    });
  }
  __name(withScope3, "withScope");
  function withSetScope2(scope, callback) {
    const isolationScope = getScopes().isolationScope;
    return asyncStorage.run({ scope, isolationScope }, () => {
      return callback(scope);
    });
  }
  __name(withSetScope2, "withSetScope");
  function withIsolationScope3(callback) {
    const scope = getScopes().scope.clone();
    const isolationScope = getScopes().isolationScope.clone();
    if (!isContinuingTrace(scope.getPropagationContext())) {
      scope.setPropagationContext({
        traceId: generateTraceId(),
        sampleRand: safeMathRandom()
      });
    }
    return asyncStorage.run({ scope, isolationScope }, () => {
      return callback(isolationScope);
    });
  }
  __name(withIsolationScope3, "withIsolationScope");
  function withSetIsolationScope(isolationScope, callback) {
    const scope = getScopes().scope.clone();
    return asyncStorage.run({ scope, isolationScope }, () => {
      return callback(isolationScope);
    });
  }
  __name(withSetIsolationScope, "withSetIsolationScope");
  setAsyncContextStrategy({
    withScope: withScope3,
    withSetScope: withSetScope2,
    withIsolationScope: withIsolationScope3,
    withSetIsolationScope,
    getCurrentScope: /* @__PURE__ */ __name(() => getScopes().scope, "getCurrentScope"),
    getIsolationScope: /* @__PURE__ */ __name(() => getScopes().isolationScope, "getIsolationScope"),
    getTracingChannelBinding: /* @__PURE__ */ __name(() => {
      return {
        asyncLocalStorage: asyncStorage
      };
    }, "getTracingChannelBinding")
  });
  return asyncStorage;
}
__name(setAsyncLocalStorageAsyncContextStrategy, "setAsyncLocalStorageAsyncContextStrategy");

// node_modules/@sentry/server-utils/build/esm/ai/core/utils.js
init_modules_watch_stub();
function resolveAIRecordingOptions(options) {
  const genAI = getClient()?.getDataCollectionOptions().genAI;
  return {
    ...options,
    recordInputs: options?.recordInputs ?? genAI?.inputs ?? true,
    recordOutputs: options?.recordOutputs ?? genAI?.outputs ?? true
  };
}
__name(resolveAIRecordingOptions, "resolveAIRecordingOptions");
function isReadableStream(value) {
  return isObjectLike(value) && typeof value.pipeThrough === "function" && typeof value.getReader === "function";
}
__name(isReadableStream, "isReadableStream");
function getTokenUsageAttributes(promptTokens, completionTokens, cacheCreationInputTokens, cacheReadInputTokens, totalTokens) {
  const attributes = {};
  if (typeof promptTokens === "number") {
    attributes[zn] = promptTokens;
  }
  if (typeof cacheCreationInputTokens === "number") {
    attributes[Ln] = cacheCreationInputTokens;
  }
  if (typeof cacheReadInputTokens === "number") {
    attributes[Mn] = cacheReadInputTokens;
  }
  if (typeof completionTokens === "number") {
    attributes[Fn] = completionTokens;
  }
  if (typeof totalTokens === "number") {
    attributes[Hn] = totalTokens;
  } else if (typeof promptTokens === "number" || typeof completionTokens === "number") {
    attributes[Hn] = (typeof promptTokens === "number" ? promptTokens : 0) + (typeof completionTokens === "number" ? completionTokens : 0);
  }
  return attributes;
}
__name(getTokenUsageAttributes, "getTokenUsageAttributes");
function getEvaluationInputMessages(request) {
  return stringify([{ type: "evaluation", state: request.state, questions: request.questions }]);
}
__name(getEvaluationInputMessages, "getEvaluationInputMessages");
function getEvaluationOutputMessages(answers) {
  return stringify([{ type: "evaluation", answers }]);
}
__name(getEvaluationOutputMessages, "getEvaluationOutputMessages");
function setOutputMessagesAttribute(span, messages) {
  const serialized = (Array.isArray(messages) ? messages : [messages]).map(buildOutputMessage).filter((message2) => !!message2);
  if (serialized.length > 0) {
    span.setAttribute(Br, JSON.stringify(serialized));
  }
}
__name(setOutputMessagesAttribute, "setOutputMessagesAttribute");
function buildOutputMessage({
  responseText,
  toolCalls,
  finishReason
}) {
  const parts = [];
  if (typeof responseText === "string" && responseText.length > 0) {
    parts.push({ type: "text", content: responseText });
  }
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }
      const call = toolCall;
      const name = call.function?.name ?? call.name;
      const args = call.function?.arguments ?? call.arguments;
      parts.push({
        type: "tool_call",
        id: call.id,
        name,
        arguments: stringify(args ?? {}, String)
      });
    }
  }
  if (parts.length === 0) {
    return void 0;
  }
  return finishReason ? { role: "assistant", parts, finish_reason: finishReason } : { role: "assistant", parts };
}
__name(buildOutputMessage, "buildOutputMessage");
function endStreamSpan(span, state, recordOutputs) {
  if (!span.isRecording()) {
    return;
  }
  const attrs = {
    [_n]: true
  };
  if (state.responseId) attrs[gn] = state.responseId;
  if (state.responseModel) attrs[bn] = state.responseModel;
  Object.assign(
    attrs,
    getTokenUsageAttributes(
      state.promptTokens,
      state.completionTokens,
      state.cacheCreationInputTokens,
      state.cacheReadInputTokens,
      state.totalTokens
    )
  );
  if (typeof state.reasoningOutputTokens === "number") {
    attrs[Wn] = state.reasoningOutputTokens;
  }
  if (state.finishReasons.length) {
    attrs[mn] = JSON.stringify(state.finishReasons);
  }
  if (recordOutputs && state.responseTexts.length) {
    attrs[hn] = state.responseTexts.join("");
  }
  if (recordOutputs && state.toolCalls.length) {
    attrs[Tn] = JSON.stringify(state.toolCalls);
  }
  span.setAttributes(attrs);
  span.end();
}
__name(endStreamSpan, "endStreamSpan");
function extractSystemInstructions(messages) {
  if (!Array.isArray(messages)) {
    return { systemInstructions: void 0, filteredMessages: messages };
  }
  const systemMessageIndex = messages.findIndex(
    (msg) => msg && typeof msg === "object" && "role" in msg && msg.role === "system"
  );
  if (systemMessageIndex === -1) {
    return { systemInstructions: void 0, filteredMessages: messages };
  }
  const systemMessage = messages[systemMessageIndex];
  const systemContent = typeof systemMessage.content === "string" ? systemMessage.content : systemMessage.content !== void 0 ? JSON.stringify(systemMessage.content) : void 0;
  if (!systemContent) {
    return { systemInstructions: void 0, filteredMessages: messages };
  }
  const systemInstructions = JSON.stringify([{ type: "text", content: systemContent }]);
  const filteredMessages = [...messages.slice(0, systemMessageIndex), ...messages.slice(systemMessageIndex + 1)];
  return { systemInstructions, filteredMessages };
}
__name(extractSystemInstructions, "extractSystemInstructions");

// node_modules/@sentry/server-utils/build/esm/ai/core/gen-ai-attributes.js
init_modules_watch_stub();
var GEN_AI_REQUEST_STREAM_ATTRIBUTE = "gen_ai.request.stream";

// node_modules/@sentry/server-utils/build/esm/ai/typesafe/index.js
init_modules_watch_stub();
function addResponseAttributes(span, result, recordOutputs) {
  if (!isObjectLike(result)) {
    return;
  }
  if (typeof result.model === "string") {
    span.setAttribute(bn, result.model);
  }
  const usage = isObjectLike(result.usage) ? result.usage : void 0;
  const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : void 0;
  const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : void 0;
  if (inputTokens !== void 0) {
    span.setAttribute(zn, inputTokens);
  }
  if (outputTokens !== void 0) {
    span.setAttribute(Fn, outputTokens);
  }
  if (inputTokens !== void 0 && outputTokens !== void 0) {
    span.setAttribute(Hn, inputTokens + outputTokens);
  }
  if (recordOutputs && result.answers !== void 0) {
    span.setAttribute(Br, getEvaluationOutputMessages(result.answers));
  }
}
__name(addResponseAttributes, "addResponseAttributes");

// node_modules/@sentry/server-utils/build/esm/ai/workers-ai/index.js
init_modules_watch_stub();

// node_modules/@sentry/server-utils/build/esm/ai/workers-ai/constants.js
init_modules_watch_stub();
var WORKERS_AI_PROVIDER_NAME = "cloudflare.workers_ai";
var WORKERS_AI_ORIGIN = "auto.ai.cloudflare.workers_ai";
var WORKERS_AI_INTEGRATION_NAME = "WorkersAI";

// node_modules/@sentry/server-utils/build/esm/ai/workers-ai/streaming.js
init_modules_watch_stub();
function accumulateStreamingToolCalls(toolCalls, accumulator) {
  for (const toolCall of toolCalls) {
    const name = toolCall.function?.name ?? toolCall.name;
    const args = toolCall.function?.arguments ?? toolCall.arguments;
    if (name == null && args == null) {
      continue;
    }
    const index = toolCall.index ?? 0;
    const existing = accumulator[index];
    if (!existing) {
      accumulator[index] = {
        index,
        id: toolCall.id,
        type: toolCall.type,
        function: {
          name,
          arguments: args ?? ""
        }
      };
    } else if (existing.function) {
      if (name && !existing.function.name) {
        existing.function.name = name;
      }
      if (args) {
        existing.function.arguments = `${existing.function.arguments ?? ""}${args}`;
      }
    }
  }
}
__name(accumulateStreamingToolCalls, "accumulateStreamingToolCalls");
function processLine(line, state, recordOutputs, toolCallAccumulator) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return;
  }
  const data = trimmed.slice("data:".length).trim();
  if (!data || data === "[DONE]") {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (parsed.usage) {
    if (typeof parsed.usage.prompt_tokens === "number") {
      state.promptTokens = parsed.usage.prompt_tokens;
    }
    if (typeof parsed.usage.completion_tokens === "number") {
      state.completionTokens = parsed.usage.completion_tokens;
    }
    if (typeof parsed.usage.total_tokens === "number") {
      state.totalTokens = parsed.usage.total_tokens;
    }
  }
  if (recordOutputs && typeof parsed.response === "string") {
    state.responseTexts.push(parsed.response);
  }
  if (recordOutputs && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
    state.toolCalls.push(...parsed.tool_calls);
  }
  if (Array.isArray(parsed.choices)) {
    for (const choice of parsed.choices) {
      if (recordOutputs && typeof choice.delta?.content === "string" && choice.delta.content) {
        state.responseTexts.push(choice.delta.content);
      }
      if (recordOutputs && Array.isArray(choice.delta?.tool_calls)) {
        accumulateStreamingToolCalls(choice.delta.tool_calls, toolCallAccumulator);
      }
      if (typeof choice.finish_reason === "string") {
        state.finishReasons.push(choice.finish_reason);
      }
    }
  }
}
__name(processLine, "processLine");
function instrumentWorkersAiStream(stream, span, recordOutputs) {
  const reader = stream.getReader();
  const decoder2 = new TextDecoder();
  const state = {
    responseId: "",
    responseModel: "",
    finishReasons: [],
    responseTexts: [],
    toolCalls: [],
    promptTokens: void 0,
    completionTokens: void 0,
    totalTokens: void 0
  };
  const toolCallAccumulator = {};
  let buffer = "";
  let spanEnded = false;
  const finish = /* @__PURE__ */ __name(() => {
    if (spanEnded) {
      return;
    }
    spanEnded = true;
    if (recordOutputs) {
      const accumulatedToolCalls = Object.values(toolCallAccumulator);
      if (accumulatedToolCalls.length > 0) {
        state.toolCalls.push(...accumulatedToolCalls);
      }
      setOutputMessagesAttribute(span, {
        responseText: state.responseTexts.join(""),
        toolCalls: state.toolCalls
      });
    }
    endStreamSpan(span, state, recordOutputs);
  }, "finish");
  const flushBuffer = /* @__PURE__ */ __name((isDone) => {
    const lines = buffer.split("\n");
    buffer = isDone ? "" : lines.pop() ?? "";
    for (const line of lines) {
      processLine(line, state, recordOutputs, toolCallAccumulator);
    }
  }, "flushBuffer");
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder2.decode();
          flushBuffer(true);
          finish();
          controller.close();
          return;
        }
        buffer += decoder2.decode(value, { stream: true });
        flushBuffer(false);
        controller.enqueue(value);
      } catch (error2) {
        span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
        finish();
        controller.error(error2);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    }
  });
}
__name(instrumentWorkersAiStream, "instrumentWorkersAiStream");

// node_modules/@sentry/server-utils/build/esm/ai/workers-ai/utils.js
init_modules_watch_stub();
var WORKERS_AI_OPERATION_SPAN_OPS = {
  chat: Oe,
  embeddings: Ce,
  decide: se
};
var DECIDE_MODEL_PREFIXES = ["typesafe/jev", "@cf/cloudflare/clef"];
function getOperationName(model, inputs) {
  if (typeof model === "string" && DECIDE_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) {
    return "decide";
  }
  if (inputs && typeof inputs === "object") {
    if ("messages" in inputs || "prompt" in inputs) {
      return "chat";
    }
    if ("text" in inputs) {
      return "embeddings";
    }
  }
  return "chat";
}
__name(getOperationName, "getOperationName");
function extractRequestAttributes(model, inputs, operationName) {
  const attributes = {
    [Xr]: WORKERS_AI_PROVIDER_NAME,
    [Fr]: operationName,
    [gm]: WORKERS_AI_ORIGIN,
    [an]: typeof model === "string" ? model : "unknown"
  };
  if (inputs && typeof inputs === "object") {
    const params = inputs;
    if (typeof params.temperature === "number") {
      attributes[pn] = params.temperature;
    }
    if (typeof params.max_tokens === "number") {
      attributes[en] = params.max_tokens;
    }
    if (typeof params.top_p === "number") {
      attributes[un] = params.top_p;
    }
    if (typeof params.top_k === "number") {
      attributes[cn] = params.top_k;
    }
    if (typeof params.frequency_penalty === "number") {
      attributes[$r] = params.frequency_penalty;
    }
    if (typeof params.presence_penalty === "number") {
      attributes[sn] = params.presence_penalty;
    }
    if (params.stream === true) {
      attributes[GEN_AI_REQUEST_STREAM_ATTRIBUTE] = true;
    }
  }
  return attributes;
}
__name(extractRequestAttributes, "extractRequestAttributes");
function addRequestAttributes(span, inputs, operationName) {
  if (!inputs || typeof inputs !== "object") {
    return;
  }
  const params = inputs;
  if (operationName === "decide") {
    span.setAttribute(Mr, getEvaluationInputMessages(inputs));
    return;
  }
  if (operationName === "embeddings") {
    const text2 = params.text;
    if (text2 == null || typeof text2 === "string" && text2.length === 0 || Array.isArray(text2) && text2.length === 0) {
      return;
    }
    span.setAttribute(Lr, stringify(text2, String));
    return;
  }
  const src = params.messages ?? params.prompt;
  if (src == null || Array.isArray(src) && src.length === 0) {
    return;
  }
  const { systemInstructions, filteredMessages } = extractSystemInstructions(src);
  if (systemInstructions) {
    span.setAttribute(En, systemInstructions);
  }
  span.setAttribute(Mr, stringify(filteredMessages));
}
__name(addRequestAttributes, "addRequestAttributes");
function addResponseAttributes2(span, result, recordOutputs, operationName) {
  if (operationName === "decide") {
    const body = isObjectLike(result) && isObjectLike(result.result) ? result.result : result;
    addResponseAttributes(span, body, recordOutputs);
    return;
  }
  if (!result || typeof result !== "object" || // Raw `Response` objects (from `returnRawResponse`/`websocket`) cannot be introspected without consuming them.
  typeof Response !== "undefined" && result instanceof Response) {
    return;
  }
  const response = result;
  if (response.usage) {
    span.setAttributes(getTokenUsageAttributes(response.usage.prompt_tokens, response.usage.completion_tokens));
  }
  if (recordOutputs) {
    let responseText;
    if (typeof response.response === "string") {
      responseText = response.response;
      span.setAttribute(hn, response.response);
    } else if (response.response != null) {
      responseText = JSON.stringify(response.response);
      span.setAttribute(hn, responseText);
    }
    const toolCalls = Array.isArray(response.tool_calls) && response.tool_calls.length > 0 ? response.tool_calls : void 0;
    if (toolCalls) {
      span.setAttribute(Tn, JSON.stringify(toolCalls));
    }
    setOutputMessagesAttribute(span, { responseText, toolCalls });
  }
}
__name(addResponseAttributes2, "addResponseAttributes");

// node_modules/@sentry/server-utils/build/esm/ai/workers-ai/index.js
function instrumentRun(originalRun, context2, options) {
  return /* @__PURE__ */ __name(function instrumentedRun(...args) {
    if (_INTERNAL_shouldSkipAiProviderWrapping(WORKERS_AI_INTEGRATION_NAME)) {
      return originalRun.apply(context2, args);
    }
    const [model, inputs, runOptions] = args;
    const operationName = getOperationName(model, inputs);
    const requestAttributes = extractRequestAttributes(model, inputs, operationName);
    const modelName = typeof model === "string" && model ? model : "unknown";
    const client = getClient();
    const isStreamRequested = !!inputs && typeof inputs === "object" && inputs.stream === true;
    const returnsRawResponse = !!runOptions && typeof runOptions === "object" && (runOptions.returnRawResponse === true || runOptions.websocket === true);
    const spanConfig = {
      // With span streaming, omit the `'unknown'` model sentinel so the name stays low-cardinality.
      name: modelName !== "unknown" || !(client && hasSpanStreamingEnabled(client)) ? `${operationName} ${modelName}` : operationName,
      attributes: {
        [mm]: WORKERS_AI_OPERATION_SPAN_OPS[operationName],
        ...requestAttributes
      }
    };
    if (isStreamRequested && !returnsRawResponse) {
      return startSpanManual(spanConfig, (span) => {
        const handleError = /* @__PURE__ */ __name((error2) => {
          span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
          span.end();
          throw error2;
        }, "handleError");
        let originalResult;
        try {
          originalResult = originalRun.apply(context2, args);
        } catch (error2) {
          return handleError(error2);
        }
        if (options.recordInputs) {
          addRequestAttributes(span, inputs, operationName);
        }
        return originalResult.then((result) => {
          if (isReadableStream(result)) {
            return instrumentWorkersAiStream(result, span, options.recordOutputs);
          }
          addResponseAttributes2(span, result, options.recordOutputs, operationName);
          span.end();
          return result;
        }, handleError);
      });
    }
    return startSpan(spanConfig, (span) => {
      const originalResult = originalRun.apply(context2, args);
      if (options.recordInputs) {
        addRequestAttributes(span, inputs, operationName);
      }
      return originalResult.then((result) => {
        if (!returnsRawResponse) {
          addResponseAttributes2(span, result, options.recordOutputs, operationName);
        }
        return result;
      });
    });
  }, "instrumentedRun");
}
__name(instrumentRun, "instrumentRun");
function instrumentWorkersAiClient(client, options) {
  const resolvedOptions = resolveAIRecordingOptions(options);
  const instrumented2 = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "run" && typeof value === "function") {
        return instrumentRun(value, target, resolvedOptions);
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return instrumented2;
}
__name(instrumentWorkersAiClient, "instrumentWorkersAiClient");

// node_modules/@sentry/server-utils/build/esm/utils/sql.js
init_modules_watch_stub();
var MAX_SUMMARY_LENGTH = 255;
var IDENTIFIER = "(?:\"[^\"]*\"|'[^']*'|`[^`]*`|[^\\s(,;).'\"`]+)";
var TABLE_NAME = `${IDENTIFIER}(?:\\.${IDENTIFIER})*`;
var DDL_RE = new RegExp(
  `^\\s*(?<operation>(?:CREATE|DROP)\\s+(?:TABLE|INDEX)|ALTER\\s+TABLE)(?:\\s+IF\\s+(?:NOT\\s+)?EXISTS)?\\s+(?<table>${TABLE_NAME})`,
  "i"
);
var INSERT_RE = new RegExp(
  `^\\s*(?<operation>INSERT|REPLACE)(?:\\s+OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?\\s+INTO\\s+(?<table>${TABLE_NAME})`,
  "i"
);
var UPDATE_RE = new RegExp(
  `^\\s*(?<operation>UPDATE)(?:\\s+OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?\\s+(?<table>${TABLE_NAME})`,
  "i"
);
var DELETE_RE = new RegExp(`^\\s*(?<operation>DELETE)\\s+FROM\\s+(?<table>${TABLE_NAME})`, "i");
var SELECT_RE = /^\s*(?:\(\s*)?(?<operation>SELECT)\b/i;
var PRAGMA_RE = /^\s*(?<operation>PRAGMA)\s+(?<command>\S+)/i;
var TOKEN_RE = /\b(?:FROM|JOIN)\s+|\(\s*(SELECT)\b|\b(?:UNION|INTERSECT|EXCEPT|MINUS)\s+(?:ALL\s+)?(SELECT)\b/gi;
var TABLE_REF_RE = new RegExp(`^${TABLE_NAME}`);
var COMMA_TABLE_RE = new RegExp(`^\\s*,\\s*(${TABLE_NAME})`);
var SUBQUERY_SELECT_RE = /^\(\s*(SELECT)\b/i;
function getSqlQuerySummary(query) {
  if (!query) {
    return void 0;
  }
  const pragmaMatch = PRAGMA_RE.exec(query);
  if (pragmaMatch?.groups?.["operation"] && pragmaMatch.groups["command"]) {
    const operation = pragmaMatch.groups["operation"];
    const command = pragmaMatch.groups["command"];
    const parenIdx = command.indexOf("(");
    return truncate2(`${operation} ${parenIdx >= 0 ? command.substring(0, parenIdx) : command}`);
  }
  const ddlMatch = DDL_RE.exec(query);
  if (ddlMatch?.groups?.["operation"] && ddlMatch.groups["table"]) {
    return truncate2(`${ddlMatch.groups["operation"]} ${ddlMatch.groups["table"]}`);
  }
  const insertMatch = INSERT_RE.exec(query);
  if (insertMatch?.groups?.["operation"] && insertMatch.groups["table"]) {
    const parts = [insertMatch.groups["operation"], insertMatch.groups["table"]];
    const rest = query.slice(insertMatch[0].length);
    const subSelect = /\b(SELECT)\b/i.exec(rest);
    if (subSelect?.[1]) {
      parts.push(subSelect[1]);
      const selectTables = extractTableNames(rest.slice(subSelect.index));
      parts.push(...selectTables);
    }
    return truncate2(parts.join(" "));
  }
  const updateMatch = UPDATE_RE.exec(query);
  if (updateMatch?.groups?.["operation"] && updateMatch.groups["table"]) {
    return truncate2(`${updateMatch.groups["operation"]} ${updateMatch.groups["table"]}`);
  }
  const deleteMatch = DELETE_RE.exec(query);
  if (deleteMatch?.groups?.["operation"] && deleteMatch.groups["table"]) {
    return truncate2(`${deleteMatch.groups["operation"]} ${deleteMatch.groups["table"]}`);
  }
  const selectMatch = SELECT_RE.exec(query);
  if (selectMatch?.groups?.["operation"]) {
    const tables = extractTableNames(query.slice(selectMatch[0].length));
    if (tables.length > 0) {
      return truncate2(`${selectMatch.groups["operation"]} ${tables.join(" ")}`);
    }
    return selectMatch.groups["operation"];
  }
  return truncate2(query.trim().split(/\s+/)[0] ?? query);
}
__name(getSqlQuerySummary, "getSqlQuerySummary");
function extractTableNames(sql) {
  const tables = [];
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(sql)) !== null) {
    if (match[1] || match[2]) {
      tables.push(match[1] || match[2]);
      continue;
    }
    const rest = sql.slice(match.index + match[0].length);
    const subqueryMatch = SUBQUERY_SELECT_RE.exec(rest);
    if (subqueryMatch?.[1]) {
      tables.push(subqueryMatch[1]);
      TOKEN_RE.lastIndex = match.index + match[0].length + subqueryMatch[0].length;
      continue;
    }
    const tableMatch = TABLE_REF_RE.exec(rest);
    if (!tableMatch) continue;
    tables.push(tableMatch[0]);
    let afterTable = rest.slice(tableMatch[0].length);
    let commaMatch;
    while ((commaMatch = COMMA_TABLE_RE.exec(afterTable)) !== null) {
      if (!commaMatch[1]) break;
      tables.push(commaMatch[1]);
      afterTable = afterTable.slice(commaMatch[0].length);
    }
  }
  return tables;
}
__name(extractTableNames, "extractTableNames");
function truncate2(summary) {
  if (summary.length <= MAX_SUMMARY_LENGTH) {
    return summary;
  }
  const truncated = summary.substring(0, MAX_SUMMARY_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated;
}
__name(truncate2, "truncate");
var integerLiteralRE;
var mssqlIntegerLiteralRE;
function getIntegerLiteralRE(dialect) {
  if (dialect === "mssql") {
    if (!mssqlIntegerLiteralRE) {
      mssqlIntegerLiteralRE = new RegExp("(?<!\\?)-?\\b\\d+\\b", "g");
    }
    return mssqlIntegerLiteralRE;
  }
  if (!integerLiteralRE) {
    integerLiteralRE = new RegExp("(?<![$?])-?\\b\\d+\\b", "g");
  }
  return integerLiteralRE;
}
__name(getIntegerLiteralRE, "getIntegerLiteralRE");
var DOLLAR_QUOTE_RE = /\$(?:[A-Za-z_]\w*)?\$/y;
function findQuotedRunEnd(sql, start, delimiter, backslashEscapes) {
  for (let i = start + 1; i < sql.length; i++) {
    const char = sql[i];
    if (backslashEscapes && char === "\\") {
      i++;
    } else if (char === delimiter) {
      if (sql[i + 1] !== delimiter) {
        return i + 1;
      }
      i++;
    }
  }
  return -1;
}
__name(findQuotedRunEnd, "findQuotedRunEnd");
function stripLiteralsAndComments(sql, dialect) {
  const isMysql = dialect === "mysql";
  const out = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === "-" && next === "-" || isMysql && char === "#") {
      const lineEnd = sql.indexOf("\n", i);
      i = lineEnd === -1 ? sql.length : lineEnd;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = sql.indexOf("*/", i + 2);
      i = commentEnd === -1 ? sql.length : commentEnd + 2;
      continue;
    }
    if (dialect === "standard" && char === "$" && !isIdentifierChar(sql[i - 1])) {
      const tag2 = matchDollarQuoteTag(sql, i);
      if (tag2) {
        const bodyEnd = sql.indexOf(tag2, i + tag2.length);
        i = bodyEnd === -1 ? sql.length : bodyEnd + tag2.length;
        out.push("?");
        continue;
      }
    }
    const identifierCloser = getIdentifierCloser(char, dialect);
    if (identifierCloser) {
      const runEnd = findQuotedRunEnd(sql, i, identifierCloser, false);
      out.push(runEnd === -1 ? "?" : sql.slice(i, runEnd));
      i = runEnd === -1 ? sql.length : runEnd;
      continue;
    }
    if (char === "'" || char === '"' && isMysql) {
      const prefix = char === "'" ? getLiteralPrefix(out, dialect) : void 0;
      if (prefix) {
        out.pop();
      }
      const runEnd = findQuotedRunEnd(sql, i, char, isMysql || prefix === "E");
      i = runEnd === -1 ? sql.length : runEnd;
      out.push("?");
      continue;
    }
    out.push(char);
    i++;
  }
  return out.join("");
}
__name(stripLiteralsAndComments, "stripLiteralsAndComments");
function getIdentifierCloser(char, dialect) {
  if (char === "`") {
    return "`";
  }
  if (char === '"' && dialect !== "mysql") {
    return '"';
  }
  return char === "[" && dialect === "mssql" ? "]" : void 0;
}
__name(getIdentifierCloser, "getIdentifierCloser");
function isIdentifierChar(char) {
  return char !== void 0 && /[\w$]/.test(char);
}
__name(isIdentifierChar, "isIdentifierChar");
function matchDollarQuoteTag(sql, start) {
  DOLLAR_QUOTE_RE.lastIndex = start;
  return DOLLAR_QUOTE_RE.exec(sql)?.[0];
}
__name(matchDollarQuoteTag, "matchDollarQuoteTag");
function getLiteralPrefix(out, dialect) {
  const last = out[out.length - 1];
  if (last?.length !== 1 || isIdentifierChar(out[out.length - 2]?.slice(-1))) {
    return void 0;
  }
  const prefix = last.toUpperCase();
  if (prefix === "X" || prefix === "B" || prefix === "N") {
    return prefix;
  }
  return prefix === "E" && dialect === "standard" ? "E" : void 0;
}
__name(getLiteralPrefix, "getLiteralPrefix");
function sanitizeSqlQuery(sqlQuery, dialect = "standard") {
  if (!sqlQuery) {
    return "Unknown SQL Query";
  }
  return (
    // Strip comments and string literals first: everything below is a regex that cannot tell
    // whether it is looking at SQL syntax or at a user-supplied value.
    stripLiteralsAndComments(sqlQuery, dialect).replace(/;\s*$/, "").replace(/\s+/g, " ").trim().replace(/\b0x[0-9A-Fa-f]+/gi, "?").replace(/\b(?:TRUE|FALSE)\b/gi, "?").replace(/-?\b\d+\.?\d*[eE][+-]?\d+\b/g, "?").replace(/-?\b\d+\.\d+\b/g, "?").replace(/-?\.\d+\b/g, "?").replace(getIntegerLiteralRE(dialect), "?").replace(/\bIN\b\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, "IN (?)").replace(/\bIN\b\s*\(\s*\$\d+(?:\s*,\s*\$\d+)*\s*\)/gi, "IN ($?)")
  );
}
__name(sanitizeSqlQuery, "sanitizeSqlQuery");

// node_modules/@sentry/cloudflare/build/esm/prod/withSentry.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/utils/asyncContextStrategy.js
init_modules_watch_stub();

// node_modules/@sentry/server-utils/build/esm/index.no-diagnostic-channels.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/utils/asyncContextStrategy.js
function setAsyncLocalStorageAsyncContextStrategyForWorker() {
  if (!getAsyncContextStrategy(getMainCarrier()).withActiveSpan) {
    setAsyncLocalStorageAsyncContextStrategy();
  }
}
__name(setAsyncLocalStorageAsyncContextStrategyForWorker, "setAsyncLocalStorageAsyncContextStrategyForWorker");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentEmail.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/flush.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/debug-build.js
init_modules_watch_stub();
var DEBUG_BUILD2 = typeof __SENTRY_DEBUG__ === "undefined" || __SENTRY_DEBUG__;

// node_modules/@sentry/cloudflare/build/esm/prod/flush.js
var flushLockRegistries = /* @__PURE__ */ new WeakMap();
function getOriginalWaitUntil(context2) {
  const currentWaitUntil = context2.waitUntil;
  const original = flushLockRegistries.get(currentWaitUntil)?.originalWaitUntil;
  return original ?? currentWaitUntil;
}
__name(getOriginalWaitUntil, "getOriginalWaitUntil");
function makeFlushLock(context2) {
  const registry = getOrCreateFlushLockRegistry(context2);
  let resolveAllDone = /* @__PURE__ */ __name(() => void 0, "resolveAllDone");
  const allDone = new Promise((res) => {
    resolveAllDone = res;
  });
  let pending = 0;
  const lock = {
    ready: allDone,
    acquire: /* @__PURE__ */ __name(() => {
      pending++;
    }, "acquire"),
    release: /* @__PURE__ */ __name(() => {
      if (--pending === 0) {
        registry.locks.delete(lock);
        resolveAllDone();
      }
    }, "release"),
    finalize: /* @__PURE__ */ __name(() => {
      if (pending === 0) {
        registry.locks.delete(lock);
        resolveAllDone();
      }
      return allDone;
    }, "finalize")
  };
  registry.locks.add(lock);
  return Object.freeze(lock);
}
__name(makeFlushLock, "makeFlushLock");
function getOrCreateFlushLockRegistry(context2) {
  const waitUntil = context2.waitUntil;
  const existingRegistry = flushLockRegistries.get(waitUntil);
  if (existingRegistry) {
    return existingRegistry;
  }
  const originalWaitUntil = context2.waitUntil.bind(context2);
  const registry = { locks: /* @__PURE__ */ new Set(), originalWaitUntil };
  const instrumentedWaitUntil = /* @__PURE__ */ __name((promise) => {
    const locks = [...registry.locks];
    for (const lock of locks) {
      lock.acquire();
    }
    return originalWaitUntil(
      promise.finally(() => {
        for (const lock of locks) {
          lock.release();
        }
      })
    );
  }, "instrumentedWaitUntil");
  flushLockRegistries.set(instrumentedWaitUntil, registry);
  context2.waitUntil = instrumentedWaitUntil;
  return registry;
}
__name(getOrCreateFlushLockRegistry, "getOrCreateFlushLockRegistry");
async function flushAndDispose(client, timeout = 2e3) {
  try {
    if (!client) {
      await flush(timeout);
      return;
    }
    await client.flush(timeout);
  } catch (e) {
    DEBUG_BUILD2 && debug.warn("Failed to flush client", e);
  } finally {
    if (!client?.isCachedClient) {
      try {
        client?.dispose();
      } catch (e) {
        DEBUG_BUILD2 && debug.warn("Failed to dispose client", e);
      }
    }
  }
}
__name(flushAndDispose, "flushAndDispose");

// node_modules/@sentry/cloudflare/build/esm/prod/instrument.js
init_modules_watch_stub();
var GLOBAL_KEY = "__SENTRY_INSTRUMENTED_MAP__";
function getInstrumentedMap() {
  const globalObj = globalThis;
  if (!globalObj[GLOBAL_KEY]) {
    globalObj[GLOBAL_KEY] = /* @__PURE__ */ new WeakMap();
  }
  return globalObj[GLOBAL_KEY];
}
__name(getInstrumentedMap, "getInstrumentedMap");
function isWeakMapKey(value) {
  return isObjectLike(value) || typeof value === "function";
}
__name(isWeakMapKey, "isWeakMapKey");
function markAsInstrumented(original, instrumented2) {
  try {
    if (isWeakMapKey(original)) {
      getInstrumentedMap().set(original, instrumented2 ?? original);
    }
    if (isWeakMapKey(instrumented2) && instrumented2 !== original) {
      getInstrumentedMap().set(instrumented2, instrumented2);
    }
  } catch {
  }
}
__name(markAsInstrumented, "markAsInstrumented");
function getInstrumented(obj) {
  try {
    if (isWeakMapKey(obj)) {
      return getInstrumentedMap().get(obj);
    }
    return void 0;
  } catch {
    return void 0;
  }
}
__name(getInstrumented, "getInstrumented");
function ensureInstrumented(original, instrumentFn, noMark) {
  const existing = getInstrumented(original);
  if (existing) {
    return existing;
  }
  const instrumented2 = instrumentFn(original);
  if (!noMark) {
    markAsInstrumented(original, instrumented2);
  }
  return instrumented2;
}
__name(ensureInstrumented, "ensureInstrumented");

// node_modules/@sentry/cloudflare/build/esm/prod/options.js
init_modules_watch_stub();
function isVersionMetadata(value) {
  return isObjectLike(value) && "id" in value && typeof value.id === "string";
}
__name(isVersionMetadata, "isVersionMetadata");
function getEnvVar(env, varName) {
  return isObjectLike(env) && varName in env && typeof env[varName] === "string" ? env[varName] : void 0;
}
__name(getEnvVar, "getEnvVar");
function getFinalOptions(userOptions = {}, env) {
  if (!isObjectLike(env)) {
    return userOptions;
  }
  const release = "SENTRY_RELEASE" in env && typeof env.SENTRY_RELEASE === "string" ? env.SENTRY_RELEASE : "CF_VERSION_METADATA" in env && isVersionMetadata(env.CF_VERSION_METADATA) ? env.CF_VERSION_METADATA.id : void 0;
  const tracesSampleRate = userOptions.tracesSampleRate ?? parseFloat(getEnvVar(env, "SENTRY_TRACES_SAMPLE_RATE") ?? "");
  return {
    release,
    ...userOptions,
    dsn: userOptions.dsn ?? getEnvVar(env, "SENTRY_DSN"),
    environment: userOptions.environment ?? getEnvVar(env, "SENTRY_ENVIRONMENT"),
    tracesSampleRate: isFinite(tracesSampleRate) ? tracesSampleRate : void 0,
    debug: userOptions.debug ?? envToBool(getEnvVar(env, "SENTRY_DEBUG")),
    tunnel: userOptions.tunnel ?? getEnvVar(env, "SENTRY_TUNNEL"),
    traceLifecycle: userOptions.traceLifecycle ?? getTraceLifecycleFromEnv(getEnvVar(env, "SENTRY_TRACE_LIFECYCLE"))
  };
}
__name(getFinalOptions, "getFinalOptions");
function getTraceLifecycleFromEnv(envVar) {
  return envVar === "stream" || envVar === "static" ? envVar : void 0;
}
__name(getTraceLifecycleFromEnv, "getTraceLifecycleFromEnv");

// node_modules/@sentry/cloudflare/build/esm/prod/scope-utils.js
init_modules_watch_stub();
function addCloudResourceContext(scope) {
  scope.setContext("cloud_resource", {
    "cloud.provider": "cloudflare"
  });
}
__name(addCloudResourceContext, "addCloudResourceContext");
function addCultureContext(scope, cf) {
  scope.setContext("culture", {
    timezone: cf.timezone
  });
}
__name(addCultureContext, "addCultureContext");
function addRequest(scope, request) {
  scope.setSDKProcessingMetadata({ normalizedRequest: winterCGRequestToRequestData(request) });
}
__name(addRequest, "addRequest");

// node_modules/@sentry/cloudflare/build/esm/prod/sdk.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/baseSdk.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/client.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/utils/invocationContext.js
init_modules_watch_stub();
var INVOCATION_STATE = /* @__PURE__ */ Symbol("sentryInvocationState");
function getInvocationWaitUntil(state) {
  if (state.waitUntil === void 0) {
    const ctx = state.ctx;
    let resolved = null;
    try {
      const original = ctx && getOriginalWaitUntil(ctx);
      resolved = original ? original.bind(ctx) : null;
    } catch {
    }
    state.waitUntil = resolved;
  }
  return state.waitUntil ?? void 0;
}
__name(getInvocationWaitUntil, "getInvocationWaitUntil");
function setInvocationState(scope, state) {
  if (scope === getDefaultIsolationScope()) {
    DEBUG_BUILD2 && debug.warn(
      "[Sentry] Cannot track this invocation. Telemetry captured after the invocation ends may not be delivered."
    );
    return;
  }
  scope[INVOCATION_STATE] = state;
}
__name(setInvocationState, "setInvocationState");
function getInvocationState() {
  const isolationScope = getIsolationScope();
  if (isolationScope === getDefaultIsolationScope()) {
    return void 0;
  }
  return isolationScope[INVOCATION_STATE];
}
__name(getInvocationState, "getInvocationState");

// node_modules/@sentry/cloudflare/build/esm/prod/client.js
var CloudflareClient = class extends ServerRuntimeClient {
  static {
    __name(this, "CloudflareClient");
  }
  /**
   * Creates a new Cloudflare SDK instance.
   * @param options Configuration options for this SDK.
   */
  constructor(options) {
    applySdkMetadata(options, "cloudflare");
    options._metadata = options._metadata || {};
    const { flushLock, ...serverOptions } = options;
    const clientOptions = {
      ...serverOptions,
      platform: "javascript",
      // TODO: Grab version information
      runtime: { name: "cloudflare" },
      // TODO: Add server name
      _flushInterval: 0
    };
    super(clientOptions);
    this._pendingSpans = /* @__PURE__ */ new Set();
    this._spanCompletionPromise = null;
    this._resolveSpanCompletion = null;
    this._unsubscribeSpanStart = null;
    this._unsubscribeSpanEnd = null;
    this._inBoundaryFlush = false;
    this._flushLock = flushLock;
    this.isCachedClient = options.cacheClient === true;
    if (!this.isCachedClient) {
      this._unsubscribeSpanStart = this.on("spanStart", (span) => {
        const spanId = span.spanContext().spanId;
        DEBUG_BUILD2 && debug.log("[CloudflareClient] Span started:", spanId);
        if (!spanIsSampled(span)) {
          return;
        }
        this._pendingSpans.add(spanId);
        if (!this._spanCompletionPromise) {
          this._spanCompletionPromise = new Promise((resolve2) => {
            this._resolveSpanCompletion = resolve2;
          });
        }
      });
      this._unsubscribeSpanEnd = this.on("spanEnd", (span) => {
        const spanId = span.spanContext().spanId;
        DEBUG_BUILD2 && debug.log("[CloudflareClient] Span ended:", spanId);
        this._pendingSpans.delete(spanId);
        if (this._pendingSpans.size === 0 && this._resolveSpanCompletion) {
          DEBUG_BUILD2 && debug.log("[CloudflareClient] All spans completed, preparing to flush");
          this._resolveSpanCompletion();
          this._resetSpanCompletionPromise();
        }
      });
    }
  }
  /**
   * Flushes pending operations and ensures all data is processed.
   *
   * Each phase waits at most `timeout`: the flush lock of a per-invocation client, pending spans, event
   * processing and the transport drain. So a flush can take a small multiple of `timeout`, which stays well
   * below Cloudflare's 30 second `waitUntil` limit for the timeouts the SDK uses. Sends still pending when
   * the drain times out are aborted.
   *
   * @param {number} [timeout] - Maximum time in milliseconds for each phase of the flush.
   * @return {Promise<boolean>} A promise that resolves to a boolean indicating whether the flush operation was successful.
   */
  async flush(timeout) {
    if (this._flushLock) {
      let timer;
      await Promise.race([
        this._flushLock.finalize(),
        ...timeout ? [new Promise((resolve2) => timer = setTimeout(resolve2, timeout))] : []
      ]);
      clearTimeout(timer);
    }
    if (this._pendingSpans.size > 0 && this._spanCompletionPromise) {
      DEBUG_BUILD2 && debug.log("[CloudflareClient] Waiting for", this._pendingSpans.size, "pending spans to complete...");
      const timeoutMs = timeout ?? 5e3;
      const spanCompletionRace = Promise.race([
        this._spanCompletionPromise,
        new Promise(
          (resolve2) => setTimeout(() => {
            DEBUG_BUILD2 && debug.log("[CloudflareClient] Span completion timeout after", timeoutMs, "ms, flushing anyway");
            resolve2(void 0);
          }, timeoutMs)
        )
      ]);
      await spanCompletionRace;
    }
    this._inBoundaryFlush = true;
    try {
      return await super.flush(timeout);
    } finally {
      this._inBoundaryFlush = false;
    }
  }
  /**
   * Disposes of the client and releases all resources.
   *
   * This method clears all Cloudflare-specific state in addition to the base client cleanup.
   * It unsubscribes from span lifecycle events and clears pending span tracking.
   *
   * Call this method after flushing to allow the client to be garbage collected.
   * After calling dispose(), the client should not be used anymore.
   */
  dispose() {
    DEBUG_BUILD2 && debug.log("[CloudflareClient] Disposing client...");
    super.dispose();
    if (this._unsubscribeSpanStart) {
      this._unsubscribeSpanStart();
      this._unsubscribeSpanStart = null;
    }
    if (this._unsubscribeSpanEnd) {
      this._unsubscribeSpanEnd();
      this._unsubscribeSpanEnd = null;
    }
    this._resetSpanCompletionPromise();
    this._flushLock = void 0;
  }
  /** @inheritDoc */
  _setupIntegrations() {
    _INTERNAL_clearAiProviderSkips();
    super._setupIntegrations();
    if (this.isCachedClient) {
      this.on("flush", () => {
        const invocationState = getInvocationState();
        if (invocationState) {
          invocationState.flushPointReached = true;
        }
      });
      this._setupEagerEnvelopeDelivery();
      this._setupEagerBufferDelivery();
    }
  }
  /**
   * Resets the span completion promise and resolve function.
   */
  _resetSpanCompletionPromise() {
    this._pendingSpans.clear();
    this._spanCompletionPromise = null;
    this._resolveSpanCompletion = null;
  }
  /**
   * Drains the transport after an envelope has been accepted past the invocation's
   * flush point. The transport queues request producers until `flush()`; before the
   * flush point the boundary `flush()` drains everything, but envelopes created after
   * it (post-response `waitUntil` work, detached continuations) have no later flush to
   * ride. The drain is registered with the invocation's `waitUntil` to keep the fetch
   * alive; outside any instrumented invocation it always runs.
   */
  _setupEagerEnvelopeDelivery() {
    this.on("afterEnvelope", () => {
      const transport = this.getTransport();
      const invocationState = getInvocationState();
      if (!transport || this._inBoundaryFlush || invocationState && !invocationState.flushPointReached) {
        return;
      }
      this._registerWithInvocationWaitUntil(transport.flush(2e3));
    });
  }
  /**
   * Turns spans, logs and metrics captured past the invocation's flush point into
   * envelopes. Before the flush point the boundary `flush()` drains their buffers; after
   * it (or outside any instrumented invocation) nothing else would: the log/metric idle
   * timer is disabled for this runtime (`_flushInterval: 0`) and the span buffer's own 5s
   * timer fires outside any invocation, where the runtime suspends the send. Each capture
   * drains only its own bucket (the ended span's trace, the log buffer, the metric
   * buffer), so a fan-out of concurrent traces stays one envelope per trace. RPC method
   * spans never reach this path: `wrapMethodWithSentry` runs the boundary flush after the
   * method span has ended, so only work past that (e.g. detached continuations) lands here.
   */
  _setupEagerBufferDelivery() {
    this.on("afterSpanEnd", (span) => {
      const traceId = span.spanContext().traceId;
      this._eagerDrain(() => this.emit("flushTraceSpans", traceId));
    });
    this.on("afterCaptureLog", () => this._eagerDrain(() => _INTERNAL_flushLogsBuffer(this)));
    this.on("afterCaptureMetric", () => this._eagerDrain(() => _INTERNAL_flushMetricsBuffer(this)));
  }
  /**
   * Runs `drain` unless the owning invocation has not reached its flush point yet
   * (before it the boundary `flush()` delivers the buffers).
   */
  _eagerDrain(drain) {
    const invocationState = getInvocationState();
    if (invocationState && !invocationState.flushPointReached) {
      return;
    }
    drain();
  }
  /**
   * Attaches a promise to the `waitUntil` of the invocation that owns the current
   * async context, so the runtime keeps the send alive after the response is returned.
   * Outside any instrumented invocation (or where the context has no `waitUntil`,
   * e.g. Astro prerendering) the send is fire-and-forget.
   */
  _registerWithInvocationWaitUntil(promise) {
    const invocationState = getInvocationState();
    const waitUntil = invocationState && getInvocationWaitUntil(invocationState);
    if (!waitUntil) {
      return;
    }
    try {
      waitUntil(
        Promise.resolve(promise).then(
          () => void 0,
          () => void 0
        )
      );
    } catch {
    }
  }
};

// node_modules/@sentry/cloudflare/build/esm/prod/clientCache.js
init_modules_watch_stub();
var GLOBAL_CLIENT_KEY = "__SENTRY_CLOUDFLARE_CLIENT__";
function getCachedClient() {
  return GLOBAL_OBJ[GLOBAL_CLIENT_KEY];
}
__name(getCachedClient, "getCachedClient");
function cacheClient(client) {
  GLOBAL_OBJ[GLOBAL_CLIENT_KEY] = client;
}
__name(cacheClient, "cacheClient");

// node_modules/@sentry/cloudflare/build/esm/prod/integrations/fetch.js
init_modules_watch_stub();
var fetchIntegration = createFetchIntegration({
  name: "Fetch",
  spanOrigin: "auto.http.fetch"
});

// node_modules/@sentry/cloudflare/build/esm/prod/integrations/httpServer.js
init_modules_watch_stub();
var INTEGRATION_NAME9 = "HttpServer";
var _httpServerIntegration = /* @__PURE__ */ __name(((options = {}) => {
  return {
    name: INTEGRATION_NAME9,
    maxRequestBodySize: options.maxRequestBodySize,
    ignoreRequestBody: options.ignoreRequestBody
  };
}), "_httpServerIntegration");
var httpServerIntegration = defineIntegration(_httpServerIntegration);
async function captureIncomingRequestBody(client, request) {
  const integration = client.getIntegrationByName(INTEGRATION_NAME9);
  if (!integration) {
    return;
  }
  const configuredBodySize = integration.maxRequestBodySize;
  const effectiveBodySize = configuredBodySize ?? (client.getDataCollectionOptions().httpBodies.includes("incomingRequest") ? "medium" : "none");
  if (effectiveBodySize === "none") {
    return;
  }
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return;
  }
  if (integration.ignoreRequestBody?.(request.url, request)) {
    return;
  }
  const isolationScope = getIsolationScope();
  await captureBodyFromWinterCGRequest(request, isolationScope, effectiveBodySize);
}
__name(captureIncomingRequestBody, "captureIncomingRequestBody");

// node_modules/@sentry/cloudflare/build/esm/prod/transport.js
init_modules_watch_stub();
var DEFAULT_TRANSPORT_BUFFER_SIZE2 = 256;
var IsolatedPromiseBuffer = class {
  static {
    __name(this, "IsolatedPromiseBuffer");
  }
  constructor(_bufferSize = DEFAULT_TRANSPORT_BUFFER_SIZE2) {
    this.$ = [];
    this._taskProducers = [];
    this._bufferSize = _bufferSize;
  }
  /**
   * @inheritdoc
   */
  add(taskProducer) {
    if (this._taskProducers.length >= this._bufferSize) {
      return Promise.reject(SENTRY_BUFFER_FULL_ERROR);
    }
    this._taskProducers.push(taskProducer);
    return Promise.resolve({});
  }
  /**
   * @inheritdoc
   */
  drain(timeout) {
    const oldTaskProducers = [...this._taskProducers];
    this._taskProducers = [];
    const drainController = new AbortController();
    this.drainSignal = drainController.signal;
    let tasks;
    try {
      tasks = oldTaskProducers.map((taskProducer) => taskProducer());
    } finally {
      this.drainSignal = void 0;
    }
    return new Promise((resolve2) => {
      const timer = setTimeout(() => {
        if (timeout && timeout > 0) {
          drainController.abort();
          resolve2(false);
        }
      }, timeout);
      Promise.all(
        tasks.map(
          (task) => task.then(null, () => {
          })
        )
      ).then(() => {
        clearTimeout(timer);
        resolve2(true);
      });
    });
  }
};
function makeCloudflareTransport(options) {
  const buffer = new IsolatedPromiseBuffer(options.bufferSize);
  function makeRequest(request) {
    const drainSignal = buffer.drainSignal;
    const callerSignal = options.fetchOptions?.signal ?? void 0;
    const signal = drainSignal && callerSignal ? AbortSignal.any([drainSignal, callerSignal]) : drainSignal ?? callerSignal;
    const requestOptions = {
      body: request.body,
      method: "POST",
      headers: options.headers,
      ...options.fetchOptions,
      ...signal ? { signal } : {}
    };
    return suppressTracing(() => {
      return (options.fetch ?? fetch)(options.url, requestOptions).then(async (response) => {
        try {
          await response.text();
        } catch {
        }
        return {
          statusCode: response.status,
          headers: {
            "x-sentry-rate-limits": response.headers.get("X-Sentry-Rate-Limits"),
            "retry-after": response.headers.get("Retry-After")
          }
        };
      });
    });
  }
  __name(makeRequest, "makeRequest");
  return createTransport(options, makeRequest, buffer);
}
__name(makeCloudflareTransport, "makeCloudflareTransport");

// node_modules/@sentry/cloudflare/build/esm/prod/vendor/stacktrace.js
init_modules_watch_stub();
function workersStackLineParser(getModule2) {
  const [arg1, arg2] = nodeStackLineParser(getModule2);
  const fn = /* @__PURE__ */ __name((line) => {
    const result = arg2(line);
    if (result) {
      const filename = result.filename;
      result.abs_path = filename !== void 0 && !filename.startsWith("/") ? `/${filename}` : filename;
      result.in_app = filename !== void 0;
    }
    return result;
  }, "fn");
  return [arg1, fn];
}
__name(workersStackLineParser, "workersStackLineParser");
function getModule(filename) {
  if (!filename) {
    return;
  }
  return basename(filename, ".js");
}
__name(getModule, "getModule");
var defaultStackParser = createStackParser(workersStackLineParser(getModule));

// node_modules/@sentry/cloudflare/build/esm/prod/baseSdk.js
function getRegisteredChannelIntegrations() {
  const registered = GLOBAL_OBJ.__SENTRY_ORCHESTRION__?.integrations;
  return registered ? [...registered.values()].map((factory) => factory()) : [];
}
__name(getRegisteredChannelIntegrations, "getRegisteredChannelIntegrations");
function getBaseDefaultIntegrations(options) {
  return [
    // The Dedupe integration should not be used in workflows because we want to
    // capture all step failures, even if they are the same error.
    ...options.enableDedupe === false ? [] : [dedupeIntegration()],
    eventFiltersIntegration(),
    functionToStringIntegration(),
    conversationIdIntegration(),
    linkedErrorsIntegration(),
    fetchIntegration(),
    httpServerIntegration(),
    requestDataIntegration(),
    consoleIntegration(),
    // The orchestrion diagnostics-channel subscribers (mysql, pg, …). The
    // `@sentry/cloudflare/vite` plugin injects the channels at build time and,
    // next to each, a snippet that registers the matching subscriber factory on
    // the global marker. Read from there instead of importing them so bundles
    // built without the plugin — where the channels would never fire — don't
    // ship the code.
    ...getRegisteredChannelIntegrations()
  ];
}
__name(getBaseDefaultIntegrations, "getBaseDefaultIntegrations");
function initWithDefaultIntegrations(options, getDefaultIntegrationsImpl) {
  const cached = getCachedClient();
  const cacheEnabled = options.cacheClient !== false;
  if (cacheEnabled && cached && !isClientClosed(cached)) {
    if (DEBUG_BUILD2 && cached.getOptions().dsn !== options.dsn) {
      debug.warn(
        "[Sentry] init() was called with a different DSN than the cached client of this isolate; the cached client keeps its DSN. Pass `cacheClient: false` for per-invocation options."
      );
    }
    getCurrentScope().update(options.initialScope);
    setCurrentClient(cached);
    return cached;
  }
  if (options.defaultIntegrations === void 0) {
    options.defaultIntegrations = getDefaultIntegrationsImpl(options);
  }
  const invocationContext = options.ctx;
  const flushLock = !cacheEnabled && invocationContext ? makeFlushLock(invocationContext) : void 0;
  delete options.ctx;
  const clientOptions = {
    ...options,
    cacheClient: cacheEnabled,
    stackParser: stackParserFromStackParserOptions(options.stackParser || defaultStackParser),
    integrations: getIntegrationsToSetup(options),
    transport: options.transport || makeCloudflareTransport,
    flushLock
  };
  if (!cacheEnabled) {
    getCurrentScope().setClient(void 0);
  }
  const client = initAndBind(CloudflareClient, clientOptions);
  if (cacheEnabled && client) {
    cacheClient(client);
  }
  client.on("orchestrion.module-injected", (moduleName) => {
    const factory = GLOBAL_OBJ.__SENTRY_ORCHESTRION__?.integrations?.get(moduleName);
    if (factory) {
      client.addIntegration(factory());
    }
  });
  return client;
}
__name(initWithDefaultIntegrations, "initWithDefaultIntegrations");

// node_modules/@sentry/cloudflare/build/esm/prod/opentelemetry/tracer.js
init_modules_watch_stub();
var import_api3 = __toESM(require_src(), 1);

// node_modules/@sentry/opentelemetry/build/esm/index.js
init_modules_watch_stub();
var import_api2 = __toESM(require_src(), 1);
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
var SENTRY_SCOPES_CONTEXT_KEY = (0, import_api2.createContextKey)("sentry_scopes");
var SENTRY_FORK_ISOLATION_SCOPE_CONTEXT_KEY = (0, import_api2.createContextKey)("sentry_fork_isolation_scope");
var SENTRY_FORK_SET_SCOPE_CONTEXT_KEY = (0, import_api2.createContextKey)("sentry_fork_set_scope");
var SENTRY_FORK_SET_ISOLATION_SCOPE_CONTEXT_KEY = (0, import_api2.createContextKey)("sentry_fork_set_isolation_scope");
var SUPPRESS_TRACING_KEY2 = (0, import_api2.createContextKey)("OpenTelemetry SDK Context Key SUPPRESS_TRACING");
function isTracingSuppressed2(context2) {
  return context2.getValue(SUPPRESS_TRACING_KEY2) === true;
}
__name(isTracingSuppressed2, "isTracingSuppressed");
var SentryTracer = class {
  static {
    __name(this, "SentryTracer");
  }
  /** @inheritdoc */
  startSpan(name, options = {}, ctx) {
    const parentContext = ctx || import_api2.context.active();
    const parentSpanCandidate = options.root ? void 0 : import_api2.trace.getSpan(parentContext);
    const parentSpan = parentSpanCandidate && (0, import_api2.isSpanContextValid)(parentSpanCandidate.spanContext()) ? parentSpanCandidate : void 0;
    if (isTracingSuppressed2(parentContext)) {
      return this._createNonRecordingSpan(parentSpan);
    }
    const span = this._startSentrySpan(name, options, parentSpan, ctx !== void 0);
    markSpanAsTracerProviderSpan(span);
    return span;
  }
  startActiveSpan(name, optionsOrFn, contextOrFn, fn) {
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const explicitCtx = typeof contextOrFn === "function" || contextOrFn === void 0 ? void 0 : contextOrFn;
    const ctx = explicitCtx ?? import_api2.context.active();
    const callback = typeof optionsOrFn === "function" ? optionsOrFn : typeof contextOrFn === "function" ? contextOrFn : fn;
    const span = this.startSpan(name, options, explicitCtx);
    const capturedIsolationScope = getCapturedScopesOnSpan(span).isolationScope;
    const withCapturedIsolationScope = /* @__PURE__ */ __name((contextToFork) => capturedIsolationScope ? contextToFork.setValue(SENTRY_FORK_SET_ISOLATION_SCOPE_CONTEXT_KEY, capturedIsolationScope) : contextToFork, "withCapturedIsolationScope");
    if (spanIsIgnored(span) && this._hasParentSpan(options, explicitCtx)) {
      return import_api2.context.with(withCapturedIsolationScope(ctx), () => callback(span));
    }
    return import_api2.context.with(withCapturedIsolationScope(import_api2.trace.setSpan(ctx, span)), () => {
      if (import_api2.trace.getSpan(import_api2.context.active()) !== span) {
        return withScope2((scope) => {
          _setSpanForScope(scope, span);
          return callback(span);
        });
      }
      _setSpanForScope(getCurrentScope(), span);
      return callback(span);
    });
  }
  /**
   * Whether a span started with these arguments gets a parent. Mirrors the parent lookup in `startSpan`
   * plus core's fallback to the scope's active span, which is what parents the span on runtimes without an
   * OTel context manager.
   */
  _hasParentSpan(options, explicitCtx) {
    if (options.root) {
      return false;
    }
    const parentSpan = explicitCtx ? import_api2.trace.getSpan(explicitCtx) : getActiveSpan();
    return !!parentSpan && (0, import_api2.isSpanContextValid)(parentSpan.spanContext());
  }
  _startSentrySpan(name, options, parentSpan, hasExplicitContext) {
    const sentryOptions2 = {
      name,
      attributes: options.attributes || {},
      links: options.links,
      startTime: options.startTime
    };
    if (options.kind) {
      sentryOptions2.attributes[Zd] = spanKindToName(options.kind);
    }
    if (options.root) {
      return startNewTrace(() => startInactiveSpan({ ...sentryOptions2, parentSpan: null }));
    }
    if (parentSpan) {
      return startInactiveSpan({ ...sentryOptions2, parentSpan });
    }
    return startInactiveSpan({
      ...sentryOptions2,
      parentSpan: hasExplicitContext ? null : void 0
    });
  }
  _createNonRecordingSpan(parentSpan) {
    const traceId = parentSpan?.spanContext().traceId ?? getCurrentScope().getPropagationContext().traceId;
    const span = new SentryNonRecordingSpan({ traceId });
    if (parentSpan) {
      addChildSpanToSpan(parentSpan, span);
    }
    setCapturedScopesOnSpan(span, getCurrentScope(), getIsolationScope());
    return span;
  }
};
var SentryTracerProvider = class {
  static {
    __name(this, "SentryTracerProvider");
  }
  constructor() {
    this._tracers = /* @__PURE__ */ new Map();
  }
  /** @inheritdoc */
  getTracer(name, version, options) {
    const key = JSON.stringify([name, version, options]);
    const cachedTracer = this._tracers.get(key);
    if (cachedTracer) {
      return cachedTracer;
    }
    const tracer = new SentryTracer();
    this._tracers.set(key, tracer);
    return tracer;
  }
  /** Compatibility with SDK tracer providers. */
  forceFlush() {
    return Promise.resolve();
  }
  /** Compatibility with SDK tracer providers. */
  shutdown() {
    return Promise.resolve();
  }
};

// node_modules/@sentry/cloudflare/build/esm/prod/opentelemetry/tracer.js
function setupOpenTelemetryTracer() {
  import_api3.trace.setGlobalTracerProvider(new SentryTracerProvider());
}
__name(setupOpenTelemetryTracer, "setupOpenTelemetryTracer");

// node_modules/@sentry/cloudflare/build/esm/prod/wrapRequestHandlerWithInit.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/orchestrion-deferred-channels.js
init_modules_watch_stub();
var deferred = [];
function flushDeferredChannelEvents() {
  if (deferred.length === 0) {
    return;
  }
  const pending = deferred.splice(0, deferred.length);
  for (const { channel, ctx, hadError } of pending) {
    try {
      channel.start.publish(ctx);
      if (hadError) {
        channel.error.publish(ctx);
      }
      channel.end.publish(ctx);
    } catch (error2) {
      DEBUG_BUILD2 && debug.warn("[orchestrion] failed to emit a deferred channel event", error2);
    }
  }
}
__name(flushDeferredChannelEvents, "flushDeferredChannelEvents");

// node_modules/@sentry/cloudflare/build/esm/prod/utils/invocationScope.js
init_modules_watch_stub();
var constructionScopes = /* @__PURE__ */ new WeakSet();
function withInvocationIsolationScope(callback, context2) {
  const isolationScope = getIsolationScope();
  const isEntryPoint = isolationScope === getDefaultIsolationScope() || constructionScopes.has(isolationScope);
  const newIsolationScope = isEntryPoint ? isolationScope.clone() : isolationScope;
  if (isEntryPoint) {
    setInvocationState(newIsolationScope, { ctx: context2 });
  }
  return withIsolationScope2(newIsolationScope, () => callback(newIsolationScope));
}
__name(withInvocationIsolationScope, "withInvocationIsolationScope");

// node_modules/@sentry/cloudflare/build/esm/prod/wrapRequestHandlerWithInit.js
function getRequestErrorMechanismType(context2) {
  return context2 && "storage" in context2 ? "auto.faas.cloudflare.durable_object" : "auto.http.cloudflare";
}
__name(getRequestErrorMechanismType, "getRequestErrorMechanismType");
function wrapRequestHandlerWithInit(wrapperOptions, handler, initSdk) {
  return withInvocationIsolationScope(async (isolationScope) => {
    const { options, request, captureErrors = true } = wrapperOptions;
    const context2 = wrapperOptions.context;
    const invocationState = getInvocationState();
    const waitUntil = invocationState ? getInvocationWaitUntil(invocationState) : context2 ? getOriginalWaitUntil(context2).bind(context2) : void 0;
    const errorMechanismType = getRequestErrorMechanismType(context2);
    const client = initSdk({ ...options, ctx: context2 });
    isolationScope.setClient(client);
    flushDeferredChannelEvents();
    const urlObject = parseStringToURLObject(request.url);
    const [rawName, attributes] = getHttpSpanDetailsFromUrlObject(
      urlObject,
      "server",
      "auto.http.cloudflare",
      request,
      void 0,
      client
    );
    const name = attributes[Nm] === "route" || !client || !hasSpanStreamingEnabled(client) ? rawName : request.method?.toUpperCase() || HTTP_SPAN_NAME_FALLBACK;
    const contentLength = request.headers.get("content-length");
    if (contentLength) {
      attributes["http.request.body.size"] = parseInt(contentLength, 10);
    }
    const userAgentHeader = request.headers.get("user-agent");
    if (userAgentHeader) {
      attributes["user_agent.original"] = userAgentHeader;
    }
    if (client) {
      Object.assign(
        attributes,
        httpHeadersToSpanAttributes(winterCGHeadersToDict(request.headers), client.getDataCollectionOptions())
      );
    }
    attributes[mm] = IE;
    addCloudResourceContext(isolationScope);
    addRequest(isolationScope, request);
    if (request.cf) {
      addCultureContext(isolationScope, request.cf);
      if (typeof request.cf.httpProtocol === "string") {
        const [protocolName, protocolVersion] = request.cf.httpProtocol.toLowerCase().split("/");
        attributes[Pc] = protocolName;
        attributes[Dc] = protocolVersion;
      }
    }
    if (request.method === "OPTIONS" || request.method === "HEAD") {
      try {
        return await handler();
      } catch (e) {
        if (captureErrors) {
          captureException(e, { mechanism: { handled: false, type: errorMechanismType } });
        }
        throw e;
      } finally {
        waitUntil?.(flushAndDispose(client));
      }
    }
    if (client) {
      await captureIncomingRequestBody(client, request);
    }
    return continueTrace(
      { sentryTrace: request.headers.get("sentry-trace") || "", baggage: request.headers.get("baggage") },
      () => {
        return startSpanManual({ name, attributes }, async (span) => {
          let res;
          try {
            res = await handler();
            setHttpStatus(span, res.status);
          } catch (e) {
            span.end();
            if (captureErrors) {
              captureException(e, { mechanism: { handled: false, type: errorMechanismType } });
            }
            waitUntil?.(flushAndDispose(client));
            throw e;
          }
          const classification = classifyResponseStreaming(res);
          if (classification.isStreaming && res.body) {
            try {
              let ended = false;
              const endSpanOnce = /* @__PURE__ */ __name(() => {
                if (ended) return;
                ended = true;
                span.end();
                waitUntil?.(flushAndDispose(client));
              }, "endSpanOnce");
              const transform = new TransformStream({
                flush() {
                  endSpanOnce();
                },
                cancel() {
                  endSpanOnce();
                }
              });
              return new Response(res.body.pipeThrough(transform), {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers
              });
            } catch {
              span.end();
              waitUntil?.(flushAndDispose(client));
              return res;
            }
          }
          span.end();
          if (res.status === 101) {
            waitUntil?.(client?.flush(2e3));
          } else {
            waitUntil?.(flushAndDispose(client));
          }
          return res;
        });
      }
    );
  }, wrapperOptions.context);
}
__name(wrapRequestHandlerWithInit, "wrapRequestHandlerWithInit");

// node_modules/@sentry/cloudflare/build/esm/prod/sdk.js
function getDefaultIntegrations(options) {
  return getBaseDefaultIntegrations(options);
}
__name(getDefaultIntegrations, "getDefaultIntegrations");
function init(options) {
  options.enableOpenTelemetrySetup ?? (options.enableOpenTelemetrySetup = false);
  if (options.enableOpenTelemetrySetup) {
    setupOpenTelemetryTracer();
  }
  return initWithDefaultIntegrations(options, getDefaultIntegrations);
}
__name(init, "init");

// node_modules/@sentry/cloudflare/build/esm/prod/utils/instrumentContext.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/instrumentDurableObjectStorage.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/utils/internalStorageKey.js
init_modules_watch_stub();
function targetsCloudflareInternalKey(key, allowlist) {
  if (!key) {
    return false;
  }
  const isFrameworkKey = key.startsWith("cf_") || key.startsWith("cf:") || key.startsWith("__ps_") || key.startsWith("/");
  if (!isFrameworkKey) {
    return false;
  }
  return !allowlist?.length || !stringMatchesSomePattern(key, allowlist, true);
}
__name(targetsCloudflareInternalKey, "targetsCloudflareInternalKey");
function getStorageKeys(methodName, args) {
  const [first] = args;
  if (methodName === "get" || methodName === "delete") {
    if (typeof first === "string") {
      return [first];
    }
    if (Array.isArray(first)) {
      return first.filter((k) => typeof k === "string");
    }
    return void 0;
  }
  if (methodName === "put") {
    if (typeof first === "string") {
      return [first];
    }
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return Object.keys(first);
    }
    return void 0;
  }
  if (methodName === "list") {
    const prefix = first && typeof first === "object" ? first.prefix : void 0;
    return typeof prefix === "string" ? [prefix] : void 0;
  }
  return void 0;
}
__name(getStorageKeys, "getStorageKeys");

// node_modules/@sentry/cloudflare/build/esm/prod/utils/traceLinks.js
init_modules_watch_stub();
var import_api4 = __toESM(require_src(), 1);
var SENTRY_TRACE_LINK_KEY_PREFIX = "__SENTRY_TRACE_LINK__";
function getTraceLinkKey(methodName) {
  return `${SENTRY_TRACE_LINK_KEY_PREFIX}${methodName}`;
}
__name(getTraceLinkKey, "getTraceLinkKey");
function storeSpanContext(originalStorage, methodName) {
  try {
    const activeSpan = getActiveSpan();
    if (activeSpan) {
      const spanContext = activeSpan.spanContext();
      const storedContext = {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        sampled: spanIsSampled(activeSpan)
      };
      originalStorage.kv.put(getTraceLinkKey(methodName), storedContext);
    }
  } catch (error2) {
    DEBUG_BUILD2 && debug.log(`[CloudflareClient] Error storing span context for method ${methodName}`, error2);
  }
}
__name(storeSpanContext, "storeSpanContext");
function getStoredSpanContext(originalStorage, methodName) {
  try {
    return originalStorage.kv.get(getTraceLinkKey(methodName));
  } catch (error2) {
    DEBUG_BUILD2 && debug.log(`[CloudflareClient] Error retrieving span context for method ${methodName}`, error2);
    return void 0;
  }
}
__name(getStoredSpanContext, "getStoredSpanContext");
function buildSpanLinks(storedContext) {
  return [
    {
      context: {
        traceId: storedContext.traceId,
        spanId: storedContext.spanId,
        traceFlags: storedContext.sampled ? import_api4.TraceFlags.SAMPLED : import_api4.TraceFlags.NONE
      },
      attributes: {
        [$d]: "previous_trace"
      }
    }
  ];
}
__name(buildSpanLinks, "buildSpanLinks");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/instrumentDurableObjectSyncKvStorage.js
init_modules_watch_stub();
var SYNC_KV_METHODS_TO_INSTRUMENT = ["get", "put", "delete", "list"];
function instrumentDurableObjectSyncKvStorage(syncKv) {
  return new Proxy(syncKv, {
    get(target, prop, _receiver) {
      const original = Reflect.get(target, prop, target);
      if (typeof original !== "function") {
        return original;
      }
      const methodName = prop;
      if (!SYNC_KV_METHODS_TO_INSTRUMENT.includes(methodName)) {
        return original.bind(target);
      }
      return function(...args) {
        return startSpan(
          {
            name: `durable_object_storage_kv_${methodName}`,
            attributes: {
              [mm]: _e,
              [gm]: "auto.db.cloudflare.durable_object",
              // keeping the value as close as possible to the Cloudflare Worker KV instrumentation
              // https://github.com/cloudflare/workerd/blob/6b8b11787e2b2a800ab0edd0690bfab3857b0529/src/workerd/api/sync-kv.c%2B%2B#L19
              "db.system.name": "cloudflare-durable-object-sql",
              "db.operation.name": methodName
            }
          },
          () => {
            return original.apply(target, args);
          }
        );
      };
    }
  });
}
__name(instrumentDurableObjectSyncKvStorage, "instrumentDurableObjectSyncKvStorage");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/instrumentSqlStorage.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/utils/internalSqlQuery.js
init_modules_watch_stub();
function targetsCloudflareInternalTable(querySummary, allowlist, queryText) {
  if (!querySummary) {
    return false;
  }
  const indexedTable = queryText ? CREATE_INDEX_TABLE_RE.exec(queryText)?.groups?.["table"] : void 0;
  if (indexedTable) {
    return isCloudflareInternalTable(indexedTable, allowlist);
  }
  const [, ...tables] = querySummary.split(" ");
  return tables.some((table) => isCloudflareInternalTable(table, allowlist));
}
__name(targetsCloudflareInternalTable, "targetsCloudflareInternalTable");
function mayTargetCloudflareInternalTable(query) {
  return INTERNAL_PREFIX_RE.test(query);
}
__name(mayTargetCloudflareInternalTable, "mayTargetCloudflareInternalTable");
var INTERNAL_TABLE_PREFIXES = ["cf_", "pi_"];
var INTERNAL_PREFIX_RE = /\b(?:cf|pi)_/i;
var CREATE_INDEX_TABLE_RE = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+[^\s(,;)]+\s+ON\s+(?<table>[^\s(,;)]+)/i;
function isCloudflareInternalTable(table, allowlist) {
  const name = table.toLowerCase();
  if (!INTERNAL_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return false;
  }
  return !allowlist?.length || !stringMatchesSomePattern(table, allowlist, true);
}
__name(isCloudflareInternalTable, "isCloudflareInternalTable");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/instrumentSqlStorage.js
var SPAN_ATTRIBUTES = {
  [mm]: re,
  [gm]: "auto.db.cloudflare.durable_object.sql",
  "db.system.name": "cloudflare-durable-object-sql",
  "db.operation.name": "exec"
};
function instrumentSqlStorage(sql) {
  return new Proxy(sql, {
    get(target, prop, _receiver) {
      const original = Reflect.get(target, prop, target);
      if (prop !== "exec" || typeof original !== "function") {
        return original;
      }
      return function(...args) {
        const callOriginal = /* @__PURE__ */ __name(() => original.apply(target, args), "callOriginal");
        const [query, ...bindings] = args;
        if (childSpanWillNotBeRecorded() && !mayTargetCloudflareInternalTable(query)) {
          return startSpan({ name: "exec", attributes: SPAN_ATTRIBUTES }, callOriginal);
        }
        const sanitizedQuery = sanitizeSqlQuery(query);
        const querySummary = getSqlQuerySummary(sanitizedQuery);
        const allowlist = getClient()?.getOptions()?.durableObjectSqlSpanAllowlist;
        if (targetsCloudflareInternalTable(querySummary, allowlist, sanitizedQuery)) {
          return callOriginal();
        }
        return startSpan(
          {
            name: querySummary || sanitizedQuery,
            attributes: {
              ...SPAN_ATTRIBUTES,
              "db.query.text": sanitizedQuery,
              "db.query.summary": querySummary,
              "cloudflare.durable_object.query.bindings": bindings.length
            }
          },
          callOriginal
        );
      };
    }
  });
}
__name(instrumentSqlStorage, "instrumentSqlStorage");
function childSpanWillNotBeRecorded() {
  if (!hasSpansEnabled()) {
    return true;
  }
  const activeSpan = getActiveSpan();
  return !!activeSpan && !spanIsSampled(activeSpan);
}
__name(childSpanWillNotBeRecorded, "childSpanWillNotBeRecorded");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/instrumentDurableObjectStorage.js
var STORAGE_METHODS_TO_INSTRUMENT = ["get", "put", "delete", "list", "setAlarm", "getAlarm", "deleteAlarm"];
function instrumentDurableObjectStorage(storage, waitUntil) {
  return new Proxy(storage, {
    get(target, prop, _receiver) {
      const original = Reflect.get(target, prop, target);
      if (prop === "kv" && original != null && "get" in original && "put" in original) {
        return instrumentDurableObjectSyncKvStorage(original);
      }
      if (prop === "sql" && original != null && "databaseSize" in original && "exec" in original) {
        return instrumentSqlStorage(original);
      }
      if (typeof original !== "function") {
        return original;
      }
      const methodName = prop;
      if (!STORAGE_METHODS_TO_INSTRUMENT.includes(methodName)) {
        return original.bind(target);
      }
      return function(...args) {
        const allowlist = getClient()?.getOptions()?.durableObjectStorageSpanAllowlist;
        const keys = getStorageKeys(methodName, args);
        if (keys && keys.length > 0 && keys.every((key) => targetsCloudflareInternalKey(key, allowlist))) {
          return original.apply(target, args);
        }
        return startSpan(
          {
            // Use underscore naming to match Cloudflare's native instrumentation (e.g., "durable_object_storage_get")
            name: `durable_object_storage_${methodName}`,
            attributes: {
              [mm]: _e,
              [gm]: "auto.db.cloudflare.durable_object",
              "db.system.name": "cloudflare.durable_object.storage",
              "db.operation.name": methodName
            }
          },
          () => {
            const teardown = /* @__PURE__ */ __name(async () => {
              if (methodName === "setAlarm") {
                storeSpanContext(target, "alarm");
              }
            }, "teardown");
            const result = original.apply(target, args);
            if (!isThenable(result)) {
              waitUntil?.(teardown());
              return result;
            }
            return result.then(
              (res) => {
                waitUntil?.(teardown());
                return res;
              },
              (e) => {
                throw e;
              }
            );
          }
        );
      };
    }
  });
}
__name(instrumentDurableObjectStorage, "instrumentDurableObjectStorage");

// node_modules/@sentry/cloudflare/build/esm/prod/utils/instrumentContext.js
function instrumentContext(ctx) {
  if (!ctx) return ctx;
  const overrides = /* @__PURE__ */ new Map();
  const contextPrototype = Object.getPrototypeOf(ctx);
  const prototypeMethodNames = Object.getOwnPropertyNames(contextPrototype);
  const ownPropertyNames = Object.getOwnPropertyNames(ctx);
  const instrumented2 = /* @__PURE__ */ new Set(["constructor"]);
  const descriptors = {};
  for (const methodName of [...ownPropertyNames, ...prototypeMethodNames]) {
    if (instrumented2.has(methodName) || typeof ctx[methodName] !== "function") {
      continue;
    }
    instrumented2.add(methodName);
    descriptors[methodName] = makeOverridableDescriptor(overrides, ctx, methodName);
  }
  if ("storage" in ctx && ctx.storage) {
    const originalStorage = ctx.storage;
    const waitUntil = "waitUntil" in ctx && typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : void 0;
    let instrumentedStorage;
    descriptors.storage = {
      configurable: true,
      enumerable: true,
      get: /* @__PURE__ */ __name(() => {
        if (!instrumentedStorage) {
          instrumentedStorage = instrumentDurableObjectStorage(originalStorage, waitUntil);
        }
        return instrumentedStorage;
      }, "get")
    };
    descriptors.originalStorage = {
      configurable: true,
      enumerable: false,
      get: /* @__PURE__ */ __name(() => originalStorage, "get")
    };
  }
  return Object.create(ctx, descriptors);
}
__name(instrumentContext, "instrumentContext");
function makeOverridableDescriptor(store, ctx, method) {
  return {
    configurable: true,
    enumerable: true,
    set: /* @__PURE__ */ __name((newValue) => {
      if (typeof newValue == "function") {
        store.set(method, newValue);
        return;
      }
      Reflect.set(ctx, method, newValue);
    }, "set"),
    get: /* @__PURE__ */ __name(() => {
      if (store.has(method)) return store.get(method);
      const methodFunction = Reflect.get(ctx, method);
      if (typeof methodFunction !== "function") return methodFunction;
      return methodFunction.bind(ctx);
    }, "get")
  };
}
__name(makeOverridableDescriptor, "makeOverridableDescriptor");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentEnv.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/utils/isBinding.js
init_modules_watch_stub();
function isJSRPC(item) {
  try {
    return !!item[`__some_property_that_will_never_exist__${Math.random()}`];
  } catch {
    return false;
  }
}
__name(isJSRPC, "isJSRPC");
var isNotJSRPC = /* @__PURE__ */ __name((item) => !isJSRPC(item), "isNotJSRPC");
function isDurableObjectNamespace(item) {
  return item != null && isNotJSRPC(item) && typeof item.idFromName === "function";
}
__name(isDurableObjectNamespace, "isDurableObjectNamespace");
function isQueue(item) {
  return item != null && isNotJSRPC(item) && typeof item.send === "function" && typeof item.sendBatch === "function";
}
__name(isQueue, "isQueue");
function isD1Database(item) {
  return item != null && isNotJSRPC(item) && typeof item.prepare === "function" && typeof item.batch === "function" && typeof item.exec === "function";
}
__name(isD1Database, "isD1Database");
function isAiBinding(item) {
  return item != null && isNotJSRPC(item) && typeof item.run === "function" && typeof item.gateway === "function" && typeof item.toMarkdown === "function";
}
__name(isAiBinding, "isAiBinding");
function isR2Bucket(item) {
  return item != null && isNotJSRPC(item) && typeof item.head === "function" && typeof item.put === "function" && typeof item.createMultipartUpload === "function";
}
__name(isR2Bucket, "isR2Bucket");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentD1.js
init_modules_watch_stub();
var patchedStatement = /* @__PURE__ */ new WeakSet();
function instrumentD1PreparedStatementQueries(statement, query) {
  if (patchedStatement.has(statement)) {
    return statement;
  }
  const queryText = query ? sanitizeSqlQuery(query) : void 0;
  statement.first = new Proxy(statement.first, {
    apply(target, thisArg, args) {
      return startSpan(createStartSpanOptions(queryText, "first"), async () => {
        const res = await Reflect.apply(target, thisArg, args);
        createD1Breadcrumb(queryText, "first");
        return res;
      });
    }
  });
  statement.run = new Proxy(statement.run, {
    apply(target, thisArg, args) {
      return startSpan(createStartSpanOptions(queryText, "run"), async (span) => {
        const d1Response = await Reflect.apply(target, thisArg, args);
        applyD1ReturnObjectToSpan(span, d1Response);
        createD1Breadcrumb(queryText, "run", d1Response);
        return d1Response;
      });
    }
  });
  statement.all = new Proxy(statement.all, {
    apply(target, thisArg, args) {
      return startSpan(createStartSpanOptions(queryText, "all"), async (span) => {
        const d1Result = await Reflect.apply(target, thisArg, args);
        applyD1ReturnObjectToSpan(span, d1Result);
        createD1Breadcrumb(queryText, "all", d1Result);
        return d1Result;
      });
    }
  });
  statement.raw = new Proxy(statement.raw, {
    apply(target, thisArg, args) {
      return startSpan(createStartSpanOptions(queryText, "raw"), async () => {
        const res = await Reflect.apply(target, thisArg, args);
        createD1Breadcrumb(queryText, "raw");
        return res;
      });
    }
  });
  patchedStatement.add(statement);
  return statement;
}
__name(instrumentD1PreparedStatementQueries, "instrumentD1PreparedStatementQueries");
function instrumentD1PreparedStatement(statement, query) {
  statement.bind = new Proxy(statement.bind, {
    apply(target, thisArg, args) {
      return instrumentD1PreparedStatementQueries(Reflect.apply(target, thisArg, args), query);
    }
  });
  return instrumentD1PreparedStatementQueries(statement, query);
}
__name(instrumentD1PreparedStatement, "instrumentD1PreparedStatement");
function applyD1ReturnObjectToSpan(span, d1Result) {
  if (!d1Result.success) {
    span.setStatus({ code: SPAN_STATUS_ERROR });
  }
  span.setAttributes(getAttributesFromD1Response(d1Result));
}
__name(applyD1ReturnObjectToSpan, "applyD1ReturnObjectToSpan");
function getAttributesFromD1Response(d1Result) {
  return {
    "cloudflare.d1.duration": d1Result.meta.duration,
    "cloudflare.d1.rows_read": d1Result.meta.rows_read,
    "cloudflare.d1.rows_written": d1Result.meta.rows_written
  };
}
__name(getAttributesFromD1Response, "getAttributesFromD1Response");
function createD1Breadcrumb(message2, type, d1Result) {
  addBreadcrumb({
    category: "query",
    message: message2,
    data: {
      ...d1Result ? getAttributesFromD1Response(d1Result) : {},
      "db.operation.name": type
    }
  });
}
__name(createD1Breadcrumb, "createD1Breadcrumb");
function createStartSpanOptions(queryText, type) {
  const querySummary = queryText ? getSqlQuerySummary(queryText) : void 0;
  const client = getClient();
  const name = client && hasSpanStreamingEnabled(client) ? querySummary || "cloudflare-d1" : queryText ?? "cloudflare-d1";
  return {
    name,
    attributes: {
      [mm]: re,
      "db.system.name": "cloudflare-d1",
      "db.operation.name": type,
      "db.query.text": queryText,
      "db.query.summary": querySummary,
      [gm]: "auto.db.cloudflare.d1"
    }
  };
}
__name(createStartSpanOptions, "createStartSpanOptions");
function instrumentPrepare(prepare) {
  return new Proxy(prepare, {
    apply(target, thisArg, args) {
      const [query] = args;
      return instrumentD1PreparedStatement(Reflect.apply(target, thisArg, args), query);
    }
  });
}
__name(instrumentPrepare, "instrumentPrepare");
function instrumentBatch(batch) {
  return new Proxy(batch, {
    apply(target, thisArg, args) {
      const statements = args[0];
      const queryText = statements.map((statement) => statement.statement ?? "").filter(Boolean).map((statement) => sanitizeSqlQuery(statement)).join("\n");
      return startSpan(
        {
          name: "D1 batch",
          attributes: {
            [mm]: re,
            "db.system.name": "cloudflare-d1",
            "db.operation.name": "batch",
            "db.query.text": queryText || void 0,
            "db.operation.batch.size": statements.length,
            [gm]: "auto.db.cloudflare.d1"
          }
        },
        async () => {
          const res = await Reflect.apply(target, thisArg, args);
          createD1Breadcrumb("D1 batch", "batch");
          return res;
        }
      );
    }
  });
}
__name(instrumentBatch, "instrumentBatch");
function instrumentD1Session(session) {
  session.prepare = instrumentPrepare(session.prepare);
  session.batch = instrumentBatch(session.batch);
  return session;
}
__name(instrumentD1Session, "instrumentD1Session");
function _instrumentD1(db2) {
  db2.prepare = instrumentPrepare(db2.prepare);
  db2.batch = instrumentBatch(db2.batch);
  db2.exec = new Proxy(db2.exec, {
    apply(target, thisArg, args) {
      const [query] = args;
      const queryText = query ? sanitizeSqlQuery(query) : void 0;
      return startSpan(createStartSpanOptions(queryText, "exec"), async () => {
        const res = await Reflect.apply(target, thisArg, args);
        createD1Breadcrumb(queryText, "exec");
        return res;
      });
    }
  });
  if ("withSession" in db2 && typeof db2.withSession === "function") {
    db2.withSession = new Proxy(db2.withSession, {
      apply(target, thisArg, args) {
        return instrumentD1Session(Reflect.apply(target, thisArg, args));
      }
    });
  }
  return db2;
}
__name(_instrumentD1, "_instrumentD1");
function instrumentD1(db2) {
  return ensureInstrumented(db2, _instrumentD1);
}
__name(instrumentD1, "instrumentD1");

// node_modules/@sentry/cloudflare/build/esm/prod/utils/rpcMeta.js
init_modules_watch_stub();
var SENTRY_RPC_META_KEY = "__sentry_rpc_meta__";
function isSentryRpcMeta(value) {
  if (!isObjectLike(value) || !(SENTRY_RPC_META_KEY in value)) {
    return false;
  }
  return isObjectLike(value[SENTRY_RPC_META_KEY]);
}
__name(isSentryRpcMeta, "isSentryRpcMeta");
function appendRpcMeta(args) {
  const traceData = getTraceData();
  if (!traceData["sentry-trace"]) {
    return args;
  }
  return [...args, { [SENTRY_RPC_META_KEY]: traceData }];
}
__name(appendRpcMeta, "appendRpcMeta");
function extractRpcMeta(args) {
  if (args.length === 0) {
    return { args };
  }
  const last = args[args.length - 1];
  if (isSentryRpcMeta(last)) {
    return {
      args: args.slice(0, -1),
      rpcMeta: last.__sentry_rpc_meta__
    };
  }
  return { args };
}
__name(extractRpcMeta, "extractRpcMeta");

// node_modules/@sentry/cloudflare/build/esm/prod/utils/rpcPropagation.js
init_modules_watch_stub();
var PROPAGATE_TO_NONE = /* @__PURE__ */ __name(() => false, "PROPAGATE_TO_NONE");
function createRpcPropagationResolver(options) {
  const bindings = options?.rpcTracePropagationBindings;
  if (!bindings?.length) {
    return PROPAGATE_TO_NONE;
  }
  return (bindingName) => matchesTracePropagationTargets(bindingName, bindings, true);
}
__name(createRpcPropagationResolver, "createRpcPropagationResolver");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/instrumentDurableObjectNamespace.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentFetcher.js
init_modules_watch_stub();
function instrumentFetcher(fetchFn) {
  return function(input, init2) {
    const headers = _INTERNAL_getTracingHeadersForFetchRequest(input, { headers: init2?.headers });
    if (input instanceof Request && init2 === void 0) {
      if (!headers) {
        return fetchFn(input);
      }
      const requestWithTracing = new Request(input, { headers });
      return fetchFn(requestWithTracing);
    }
    const mergedInit = {
      ...init2,
      ...headers ? { headers } : {}
    };
    return fetchFn(input, mergedInit);
  };
}
__name(instrumentFetcher, "instrumentFetcher");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/instrumentDurableObjectNamespace.js
var STUB_NON_RPC_METHODS = /* @__PURE__ */ new Set(["fetch", "connect", "dup"]);
function instrumentDurableObjectNamespace(namespace, propagateRpcTrace = false) {
  return new Proxy(namespace, {
    get(target, prop, _receiver) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") {
        return value;
      }
      if (prop === "get" || prop === "getByName") {
        return function(...args) {
          const stub = Reflect.apply(value, target, args);
          return instrumentDurableObjectStub(stub, propagateRpcTrace);
        };
      }
      if (prop === "jurisdiction") {
        return function(...args) {
          const subnamespace = Reflect.apply(value, target, args);
          return instrumentDurableObjectNamespace(subnamespace, propagateRpcTrace);
        };
      }
      return value.bind(target);
    }
  });
}
__name(instrumentDurableObjectNamespace, "instrumentDurableObjectNamespace");
function instrumentDurableObjectStub(stub, propagateRpcTrace) {
  return new Proxy(stub, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "fetch" && typeof value === "function") {
        return instrumentFetcher((...args) => Reflect.apply(value, target, args));
      }
      if (prop === "connect" && typeof value === "function") {
        return (...args) => Reflect.apply(value, target, args);
      }
      if (propagateRpcTrace && typeof value === "function" && typeof prop === "string" && !STUB_NON_RPC_METHODS.has(prop)) {
        return (...args) => Reflect.apply(value, target, appendRpcMeta(args));
      }
      return value;
    }
  });
}
__name(instrumentDurableObjectStub, "instrumentDurableObjectStub");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentQueueProducer.js
init_modules_watch_stub();
var ORIGIN = "auto.faas.cloudflare.queue";
function startPublishSpan(options, callback) {
  const { bindingName, bodySize, messageCount } = options;
  return startSpan(
    {
      name: `send ${bindingName}`,
      attributes: {
        "messaging.system": "cloudflare",
        "messaging.destination.name": bindingName,
        "messaging.operation.type": "send",
        "messaging.operation.name": "send",
        ...messageCount !== void 0 && { "messaging.batch.message_count": messageCount },
        "messaging.message.body.size": bodySize,
        [mm]: Ge,
        [gm]: ORIGIN
      }
    },
    callback
  );
}
__name(startPublishSpan, "startPublishSpan");
function getBodySize(body) {
  if (body == null) {
    return void 0;
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(body)).byteLength;
  } catch {
    return void 0;
  }
}
__name(getBodySize, "getBodySize");
function instrumentQueueProducer(queue, bindingName) {
  return new Proxy(queue, {
    get(target, prop, receiver) {
      if (prop === "send") {
        const original = Reflect.get(target, prop, receiver);
        return function(message2, options) {
          return startPublishSpan(
            { bindingName, bodySize: getBodySize(message2) },
            () => Reflect.apply(original, target, [message2, options])
          );
        };
      }
      if (prop === "sendBatch") {
        const original = Reflect.get(target, prop, receiver);
        return function(messages, options) {
          const messageArray = Array.from(messages);
          const totalBodySize = messageArray.reduce((acc, m2) => {
            const size = getBodySize(m2.body);
            if (size === void 0) {
              return acc;
            }
            return (acc ?? 0) + size;
          }, void 0);
          return startPublishSpan(
            { bindingName, bodySize: totalBodySize, messageCount: messageArray.length },
            () => Reflect.apply(original, target, [messageArray, options])
          );
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
__name(instrumentQueueProducer, "instrumentQueueProducer");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentR2.js
init_modules_watch_stub();
var ORIGIN2 = "auto.faas.cloudflare.r2";
var R2_OPERATIONS = {
  get: { spanName: "r2_get", op: ze, operation: "GetObject" },
  head: { spanName: "r2_head", op: Ze, operation: "HeadObject" },
  put: { spanName: "r2_put", op: $e, operation: "PutObject" },
  delete: { spanName: "r2_delete", op: eE, operation: "DeleteObject" },
  list: { spanName: "r2_list", op: EE, operation: "ListObjects" },
  uploadPart: { spanName: "r2_uploadPart", op: _E, operation: "UploadPart" },
  abortMultipartUpload: {
    spanName: "r2_abortMultipartUpload",
    op: rE,
    operation: "AbortMultipartUpload"
  },
  createMultipartUpload: {
    spanName: "r2_createMultipartUpload",
    op: RE,
    operation: "CreateMultipartUpload"
  },
  completeMultipartUpload: {
    spanName: "r2_completeMultipartUpload",
    op: tE,
    operation: "CompleteMultipartUpload"
  }
};
function isR2ListOptions(key) {
  return isObjectLike(key) && !Array.isArray(key);
}
__name(isR2ListOptions, "isR2ListOptions");
function createSpanOptions(bindingName, r2Op, key) {
  const { spanName, op, operation } = R2_OPERATIONS[r2Op];
  const requestKey = Array.isArray(key) ? key.join(", ") : typeof key === "string" ? key : void 0;
  return {
    op,
    name: spanName,
    attributes: {
      [Gi]: operation,
      [Ui]: bindingName,
      ...requestKey !== void 0 && { [Yi]: requestKey },
      ...isR2ListOptions(key) && key.prefix !== void 0 && { [Fi]: key.prefix },
      ...isR2ListOptions(key) && key.delimiter !== void 0 && { [zi]: key.delimiter },
      [mm]: op,
      [gm]: ORIGIN2
    }
  };
}
__name(createSpanOptions, "createSpanOptions");
function instrumentR2MultipartUpload(upload, bindingName) {
  const { key } = upload;
  return new Proxy(upload, {
    get(target, prop, receiver) {
      if (prop === "uploadPart") {
        const original = Reflect.get(target, prop, receiver);
        return function(...args) {
          const [partNumber] = args;
          const spanOptions = createSpanOptions(bindingName, "uploadPart", key);
          return startSpan(
            {
              ...spanOptions,
              attributes: {
                ...spanOptions.attributes,
                [Vi]: partNumber
              }
            },
            () => Reflect.apply(original, target, args)
          );
        };
      }
      if (prop === "abort") {
        const original = Reflect.get(target, prop, receiver);
        return function() {
          return startSpan(
            createSpanOptions(bindingName, "abortMultipartUpload", key),
            () => Reflect.apply(original, target, [])
          );
        };
      }
      if (prop === "complete") {
        const original = Reflect.get(target, prop, receiver);
        return function(...args) {
          return startSpan(
            createSpanOptions(bindingName, "completeMultipartUpload", key),
            () => Reflect.apply(original, target, args)
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}
__name(instrumentR2MultipartUpload, "instrumentR2MultipartUpload");
function instrumentR2Bucket(bucket, bindingName) {
  return new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop === "get" || prop === "head" || prop === "put" || prop === "delete" || prop === "list") {
        const original = Reflect.get(target, prop, receiver);
        return function(...args) {
          const [key] = args;
          return startSpan(createSpanOptions(bindingName, prop, key), () => Reflect.apply(original, target, args));
        };
      }
      if (prop === "createMultipartUpload") {
        const original = Reflect.get(target, prop, receiver);
        return function(...args) {
          const [key] = args;
          return startSpan(createSpanOptions(bindingName, "createMultipartUpload", key), async () => {
            const upload = await Reflect.apply(original, target, args);
            return instrumentR2MultipartUpload(upload, bindingName);
          });
        };
      }
      if (prop === "resumeMultipartUpload") {
        const original = Reflect.get(target, prop, receiver);
        return function(...args) {
          const upload = Reflect.apply(original, target, args);
          return instrumentR2MultipartUpload(upload, bindingName);
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}
__name(instrumentR2Bucket, "instrumentR2Bucket");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentEnv.js
function isProxyable(item) {
  return isObjectLike(item) || typeof item === "function";
}
__name(isProxyable, "isProxyable");
var instrumentedBindings = /* @__PURE__ */ new WeakMap();
function instrumentEnv(env, options) {
  if (!env || typeof env !== "object") {
    return env;
  }
  const shouldPropagateRpcTrace = createRpcPropagationResolver(options);
  return new Proxy(env, {
    get(target, prop, receiver) {
      const item = Reflect.get(target, prop, receiver);
      if (!isProxyable(item)) {
        return item;
      }
      const cached = instrumentedBindings.get(item);
      if (cached) {
        return cached;
      }
      if (isD1Database(item)) {
        const instrumented2 = instrumentD1(item);
        instrumentedBindings.set(item, instrumented2);
        return instrumented2;
      }
      if (isQueue(item)) {
        const bindingName = typeof prop === "string" ? prop : String(prop);
        const instrumented2 = instrumentQueueProducer(item, bindingName);
        instrumentedBindings.set(item, instrumented2);
        return instrumented2;
      }
      if (isR2Bucket(item)) {
        const bindingName = typeof prop === "string" ? prop : String(prop);
        const instrumented2 = instrumentR2Bucket(item, bindingName);
        instrumentedBindings.set(item, instrumented2);
        return instrumented2;
      }
      if (isAiBinding(item)) {
        const instrumented2 = instrumentWorkersAiClient(item);
        instrumentedBindings.set(item, instrumented2);
        return instrumented2;
      }
      const propagateRpcTrace = shouldPropagateRpcTrace(String(prop));
      if (isDurableObjectNamespace(item)) {
        const instrumented2 = instrumentDurableObjectNamespace(item, propagateRpcTrace);
        instrumentedBindings.set(item, instrumented2);
        return instrumented2;
      }
      if (isJSRPC(item)) {
        const instrumented2 = new Proxy(item, {
          get(target2, p2) {
            const value = Reflect.get(target2, p2);
            if (p2 === "fetch" && typeof value === "function") {
              return instrumentFetcher((...args) => Reflect.apply(value, target2, args));
            }
            if (p2 === "connect" && typeof value === "function") {
              return (...args) => Reflect.apply(value, target2, args);
            }
            if (propagateRpcTrace && typeof value === "function" && typeof p2 === "string" && !STUB_NON_RPC_METHODS.has(p2)) {
              return (...args) => Reflect.apply(value, target2, appendRpcMeta(args));
            }
            return value;
          }
        });
        instrumentedBindings.set(item, instrumented2);
        return instrumented2;
      }
      return item;
    }
  });
}
__name(instrumentEnv, "instrumentEnv");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentEmail.js
function wrapEmailHandler(emailMessage, options, context2, fn) {
  return withIsolationScope2((isolationScope) => {
    const waitUntil = context2.waitUntil.bind(context2);
    setInvocationState(isolationScope, { ctx: context2 });
    const client = init({ ...options, ctx: context2 });
    isolationScope.setClient(client);
    addCloudResourceContext(isolationScope);
    return startSpan(
      {
        name: "email",
        attributes: {
          [mm]: De,
          [la]: "email",
          [$s]: "email",
          [gm]: "auto.faas.cloudflare.email",
          [Nm]: "task"
        }
      },
      async () => {
        try {
          return await fn();
        } catch (e) {
          captureException(e, { mechanism: { handled: false, type: "auto.faas.cloudflare.email" } });
          throw e;
        } finally {
          waitUntil(flushAndDispose(client));
        }
      }
    );
  });
}
__name(wrapEmailHandler, "wrapEmailHandler");
function instrumentExportedHandlerEmail(handler, optionsCallback) {
  if (!("email" in handler) || typeof handler.email !== "function") {
    return;
  }
  handler.email = ensureInstrumented(
    handler.email,
    (original) => new Proxy(original, {
      apply(target, thisArg, args) {
        const [emailMessage, env, ctx] = args;
        const context2 = instrumentContext(ctx);
        const options = getFinalOptions(optionsCallback(env), env);
        args[1] = instrumentEnv(env, options);
        args[2] = context2;
        return wrapEmailHandler(emailMessage, options, context2, () => target.apply(thisArg, args));
      }
    })
  );
}
__name(instrumentExportedHandlerEmail, "instrumentExportedHandlerEmail");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentFetch.js
init_modules_watch_stub();
function instrumentExportedHandlerFetch(handler, optionsCallback) {
  if (!("fetch" in handler) || typeof handler.fetch !== "function") {
    return;
  }
  handler.fetch = ensureInstrumented(
    handler.fetch,
    (original) => new Proxy(original, {
      apply(target, thisArg, args) {
        const [rawRequest, env, ctx] = args;
        const request = rawRequest;
        if (request.method === "OPTIONS" || request.method === "HEAD") {
          return target.apply(thisArg, args);
        }
        const context2 = instrumentContext(ctx);
        const options = getFinalOptions(optionsCallback(env), env);
        args[1] = instrumentEnv(env, options);
        args[2] = context2;
        return wrapRequestHandlerWithInit({ options, request, context: context2 }, () => target.apply(thisArg, args), init);
      }
    })
  );
}
__name(instrumentExportedHandlerFetch, "instrumentExportedHandlerFetch");
function instrumentWorkerEntrypointFetch(instance, options, context2) {
  if (!instance.fetch) {
    return;
  }
  const original = instance.fetch.bind(instance);
  instance.fetch = new Proxy(original, {
    apply(target, thisArg, args) {
      const [request] = args;
      if (request.method === "OPTIONS" || request.method === "HEAD") {
        return Reflect.apply(target, thisArg, args);
      }
      return wrapRequestHandlerWithInit(
        { options, request, context: context2 },
        () => Reflect.apply(target, thisArg, args),
        init
      );
    }
  });
}
__name(instrumentWorkerEntrypointFetch, "instrumentWorkerEntrypointFetch");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentQueue.js
init_modules_watch_stub();
function wrapQueueHandler(batch, options, context2, fn) {
  return withIsolationScope2((isolationScope) => {
    const waitUntil = context2.waitUntil.bind(context2);
    setInvocationState(isolationScope, { ctx: context2 });
    const client = init({ ...options, ctx: context2 });
    isolationScope.setClient(client);
    addCloudResourceContext(isolationScope);
    return startSpan(
      {
        name: `process ${batch.queue}`,
        attributes: {
          [mm]: qe,
          "faas.trigger": "pubsub",
          "messaging.destination.name": batch.queue,
          "messaging.system": "cloudflare",
          "messaging.operation.type": "process",
          "messaging.operation.name": "process",
          "messaging.batch.message_count": batch.messages.length,
          "messaging.message.retry.count": batch.messages.reduce((acc, message2) => acc + message2.attempts - 1, 0),
          [gm]: "auto.faas.cloudflare.queue",
          [Nm]: "task"
        }
      },
      async () => {
        try {
          return await fn();
        } catch (e) {
          captureException(e, { mechanism: { handled: false, type: "auto.faas.cloudflare.queue" } });
          throw e;
        } finally {
          waitUntil(flushAndDispose(client));
        }
      }
    );
  });
}
__name(wrapQueueHandler, "wrapQueueHandler");
function instrumentExportedHandlerQueue(handler, optionsCallback) {
  if (!("queue" in handler) || typeof handler.queue !== "function") {
    return;
  }
  handler.queue = ensureInstrumented(
    handler.queue,
    (original) => new Proxy(original, {
      apply(target, thisArg, args) {
        const [batch, env, ctx] = args;
        const context2 = instrumentContext(ctx);
        const options = getFinalOptions(optionsCallback(env), env);
        args[1] = instrumentEnv(env, options);
        args[2] = context2;
        return wrapQueueHandler(batch, options, context2, () => target.apply(thisArg, args));
      }
    })
  );
}
__name(instrumentExportedHandlerQueue, "instrumentExportedHandlerQueue");
function instrumentWorkerEntrypointQueue(instance, options, context2) {
  if (!instance.queue) {
    return;
  }
  const original = instance.queue.bind(instance);
  instance.queue = new Proxy(original, {
    apply(target, thisArg, args) {
      const [batch] = args;
      return wrapQueueHandler(batch, options, context2, () => Reflect.apply(target, thisArg, args));
    }
  });
}
__name(instrumentWorkerEntrypointQueue, "instrumentWorkerEntrypointQueue");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentScheduled.js
init_modules_watch_stub();
function wrapScheduledHandler(controller, options, context2, fn) {
  return withIsolationScope2((isolationScope) => {
    const waitUntil = context2.waitUntil.bind(context2);
    setInvocationState(isolationScope, { ctx: context2 });
    const client = init({ ...options, ctx: context2 });
    isolationScope.setClient(client);
    addCloudResourceContext(isolationScope);
    const description = `Scheduled Cron ${controller.cron}`;
    return startSpan(
      {
        name: client && hasSpanStreamingEnabled(client) ? "scheduled" : description,
        attributes: {
          [mm]: De,
          // override description inference by Relay to preserve the original (transaction-based) description.
          // sentry-conventions can't map the special case for the "Scheduled Cron" prefix and the chron string.
          [Id]: description,
          [la]: "scheduled",
          [Ys]: controller.cron,
          [Zs]: new Date(controller.scheduledTime).toISOString(),
          [$s]: "timer",
          [gm]: "auto.faas.cloudflare.scheduled",
          [Nm]: "task"
        }
      },
      async () => {
        let finishCheckIn;
        try {
          finishCheckIn = client?.getIntegrationByName("CronTriggers")?.startCheckIn(controller.cron);
          if (finishCheckIn) {
            waitUntil(Promise.resolve(client?.getTransport()?.flush(2e3)).catch(() => void 0));
          }
        } catch (e) {
          DEBUG_BUILD2 && debug.warn("Failed to send the in_progress cron check-in", e);
        }
        const finish = /* @__PURE__ */ __name((status) => {
          try {
            finishCheckIn?.(status);
          } catch (e) {
            DEBUG_BUILD2 && debug.warn(`Failed to send the ${status} cron check-in`, e);
          }
        }, "finish");
        try {
          const result = await fn();
          finish("ok");
          return result;
        } catch (e) {
          finish("error");
          captureException(e, { mechanism: { handled: false, type: "auto.faas.cloudflare.scheduled" } });
          throw e;
        } finally {
          waitUntil(flushAndDispose(client));
        }
      }
    );
  });
}
__name(wrapScheduledHandler, "wrapScheduledHandler");
function instrumentExportedHandlerScheduled(handler, optionsCallback) {
  if (!("scheduled" in handler) || typeof handler.scheduled !== "function") {
    return;
  }
  handler.scheduled = ensureInstrumented(
    handler.scheduled,
    (original) => new Proxy(original, {
      apply(target, thisArg, args) {
        const [controller, env, ctx] = args;
        const context2 = instrumentContext(ctx);
        const options = getFinalOptions(optionsCallback(env), env);
        args[1] = instrumentEnv(env, options);
        args[2] = context2;
        return wrapScheduledHandler(controller, options, context2, () => target.apply(thisArg, args));
      }
    })
  );
}
__name(instrumentExportedHandlerScheduled, "instrumentExportedHandlerScheduled");
function instrumentWorkerEntrypointScheduled(instance, options, context2) {
  if (!instance.scheduled) {
    return;
  }
  const original = instance.scheduled.bind(instance);
  instance.scheduled = new Proxy(original, {
    apply(target, thisArg, args) {
      const [controller] = args;
      return wrapScheduledHandler(controller, options, context2, () => Reflect.apply(target, thisArg, args));
    }
  });
}
__name(instrumentWorkerEntrypointScheduled, "instrumentWorkerEntrypointScheduled");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/worker/instrumentTail.js
init_modules_watch_stub();
function wrapTailHandler(options, context2, fn) {
  return withIsolationScope2(async (isolationScope) => {
    const waitUntil = context2.waitUntil.bind(context2);
    setInvocationState(isolationScope, { ctx: context2 });
    const client = init({ ...options, ctx: context2 });
    isolationScope.setClient(client);
    addCloudResourceContext(isolationScope);
    try {
      return await fn();
    } catch (e) {
      captureException(e, { mechanism: { handled: false, type: "auto.faas.cloudflare.tail" } });
      throw e;
    } finally {
      waitUntil(flushAndDispose(client));
    }
  });
}
__name(wrapTailHandler, "wrapTailHandler");
function instrumentExportedHandlerTail(handler, optionsCallback) {
  if (!("tail" in handler) || typeof handler.tail !== "function") {
    return;
  }
  handler.tail = ensureInstrumented(
    handler.tail,
    (original) => new Proxy(original, {
      apply(target, thisArg, args) {
        const [, env, ctx] = args;
        const context2 = instrumentContext(ctx);
        const options = getFinalOptions(optionsCallback(env), env);
        args[1] = instrumentEnv(env, options);
        args[2] = context2;
        return wrapTailHandler(options, context2, () => target.apply(thisArg, args));
      }
    })
  );
}
__name(instrumentExportedHandlerTail, "instrumentExportedHandlerTail");
function instrumentWorkerEntrypointTail(instance, options, context2) {
  if (!instance.tail) {
    return;
  }
  const original = instance.tail.bind(instance);
  instance.tail = new Proxy(original, {
    apply(target, thisArg, args) {
      return wrapTailHandler(options, context2, () => Reflect.apply(target, thisArg, args));
    }
  });
}
__name(instrumentWorkerEntrypointTail, "instrumentWorkerEntrypointTail");

// node_modules/@sentry/cloudflare/build/esm/prod/utils/isCloudflareClass.js
init_modules_watch_stub();
function isCloudflareClass(value, className) {
  if (!value || typeof value !== "function") {
    return false;
  }
  if (value.name === className) {
    return false;
  }
  let proto = value.prototype;
  while (proto) {
    const ctor = proto.constructor;
    const constructorName = ctor?.name;
    if (constructorName === className) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
__name(isCloudflareClass, "isCloudflareClass");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/instrumentWorkerEntrypoint.js
init_modules_watch_stub();

// node_modules/@sentry/cloudflare/build/esm/prod/wrapMethodWithSentry.js
init_modules_watch_stub();
function resolveOriginalStorage(context2, thisArg) {
  if (isObjectLike(thisArg) && "ctx" in thisArg) {
    const doCtx = thisArg.ctx;
    if (doCtx?.originalStorage) {
      return doCtx.originalStorage;
    }
  }
  if (context2 && "originalStorage" in context2 && context2.originalStorage) {
    return context2.originalStorage;
  }
  return void 0;
}
__name(resolveOriginalStorage, "resolveOriginalStorage");
function wrapMethodWithSentry(wrapperOptions, handler, callback, noMark) {
  return ensureInstrumented(
    handler,
    (original) => new Proxy(original, {
      apply(target, thisArg, rawArgs) {
        const { startNewTrace: startNewTrace$1, origin } = wrapperOptions;
        let args = rawArgs;
        let rpcMeta;
        if (wrapperOptions.spanOp === "rpc") {
          const extracted = extractRpcMeta(rawArgs);
          args = extracted.args;
          rpcMeta = extracted.rpcMeta;
        }
        const spanName = typeof wrapperOptions.spanName === "function" ? wrapperOptions.spanName(rpcMeta) : wrapperOptions.spanName;
        const wrappedFunction = /* @__PURE__ */ __name((scope) => {
          const context2 = wrapperOptions.context;
          const invocationState = getInvocationState();
          const waitUntil = invocationState ? getInvocationWaitUntil(invocationState) : context2 ? getOriginalWaitUntil(context2)?.bind(context2) : void 0;
          const storage = resolveOriginalStorage(context2, thisArg);
          let scopeClient = scope.getClient();
          if (startNewTrace$1 || !scopeClient?.getTransport()) {
            const client = init({
              ...wrapperOptions.options,
              ctx: context2
            });
            scope.setClient(client);
            scopeClient = client;
          }
          const clientToDispose = scopeClient;
          const methodName = spanName || "unknown";
          const teardown = /* @__PURE__ */ __name(async () => {
            if (startNewTrace$1 && storage) {
              storeSpanContext(storage, methodName);
            }
            await flushAndDispose(clientToDispose);
          }, "teardown");
          const onFulfilled = /* @__PURE__ */ __name((res) => {
            waitUntil?.(teardown());
            return res;
          }, "onFulfilled");
          const captureAndRethrow = /* @__PURE__ */ __name((e) => {
            captureException(e, {
              mechanism: {
                type: origin,
                handled: false
              }
            });
            throw e;
          }, "captureAndRethrow");
          const onRejected = /* @__PURE__ */ __name((e) => {
            try {
              return captureAndRethrow(e);
            } finally {
              waitUntil?.(teardown());
            }
          }, "onRejected");
          if (!spanName) {
            try {
              if (callback) {
                callback(...args);
              }
              const result = Reflect.apply(target, thisArg, args);
              if (isThenable(result)) {
                return result.then(onFulfilled, onRejected);
              } else {
                return onFulfilled(result);
              }
            } catch (e) {
              return onRejected(e);
            }
          }
          const attributes = wrapperOptions.spanOp ? {
            [mm]: wrapperOptions.spanOp,
            [gm]: origin,
            // `function` spans are already named like their function name, so we just set `code.function.name` here.
            ...wrapperOptions.spanOp === De && { [la]: methodName }
          } : {};
          const executeSpan = /* @__PURE__ */ __name(() => {
            return startSpan({ name: methodName, attributes }, (span) => {
              if (startNewTrace$1 && storage) {
                const storedContext = getStoredSpanContext(storage, methodName);
                if (storedContext) {
                  span.addLinks(buildSpanLinks(storedContext));
                  const sampledFlag = storedContext.sampled ? "1" : "0";
                  span.setAttribute(
                    "sentry.previous_trace",
                    `${storedContext.traceId}-${storedContext.spanId}-${sampledFlag}`
                  );
                }
              }
              try {
                const result = Reflect.apply(target, thisArg, args);
                if (isThenable(result)) {
                  return result.then(void 0, captureAndRethrow);
                }
                return result;
              } catch (e) {
                return captureAndRethrow(e);
              }
            });
          }, "executeSpan");
          const runWithTeardown = /* @__PURE__ */ __name((run) => {
            let out;
            try {
              out = run();
            } catch (e) {
              waitUntil?.(teardown());
              throw e;
            }
            if (isThenable(out)) {
              return out.then(
                (res) => {
                  waitUntil?.(teardown());
                  return res;
                },
                (e) => {
                  waitUntil?.(teardown());
                  throw e;
                }
              );
            }
            waitUntil?.(teardown());
            return out;
          }, "runWithTeardown");
          if (rpcMeta) {
            return runWithTeardown(
              () => continueTrace(
                { sentryTrace: rpcMeta["sentry-trace"] || "", baggage: rpcMeta.baggage || "" },
                executeSpan
              )
            );
          }
          if (startNewTrace$1) {
            return runWithTeardown(() => startNewTrace(() => executeSpan()));
          }
          return runWithTeardown(executeSpan);
        }, "wrappedFunction");
        return withInvocationIsolationScope(
          wrappedFunction,
          wrapperOptions.context
        );
      }
    }),
    noMark
  );
}
__name(wrapMethodWithSentry, "wrapMethodWithSentry");

// node_modules/@sentry/cloudflare/build/esm/prod/instrumentations/instrumentWorkerEntrypoint.js
var WORKER_ENTRYPOINT_ORIGIN = "auto.faas.cloudflare.worker_entrypoint";
var RESERVED_METHODS = /* @__PURE__ */ new Set([
  "connect",
  "constructor",
  "dup",
  "email",
  "fetch",
  "queue",
  "scheduled",
  "tail",
  "tailStream",
  "test",
  "trace"
]);
function isPrototypeMethod(instance, prop, method) {
  let prototype = Object.getPrototypeOf(instance);
  while (prototype && prototype !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, prop);
    if (descriptor) {
      return descriptor.value === method;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}
__name(isPrototypeMethod, "isPrototypeMethod");
function bindToInstance(instance, proxy, method) {
  return new Proxy(method, {
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg === proxy ? instance : thisArg, args);
    }
  });
}
__name(bindToInstance, "bindToInstance");
function instrumentMethod(instance, proxy, prop, method, options, context2) {
  const ownDescriptor = Object.getOwnPropertyDescriptor(instance, prop);
  if (ownDescriptor && "value" in ownDescriptor && !ownDescriptor.configurable && !ownDescriptor.writable) {
    return method;
  }
  const boundMethod = bindToInstance(instance, proxy, method);
  if (typeof prop !== "string" || RESERVED_METHODS.has(prop) || !isPrototypeMethod(instance, prop, method)) {
    return boundMethod;
  }
  return wrapMethodWithSentry(
    {
      options,
      context: context2,
      spanName: /* @__PURE__ */ __name((rpcMeta) => rpcMeta ? prop : void 0, "spanName"),
      spanOp: OE,
      origin: WORKER_ENTRYPOINT_ORIGIN
    },
    boundMethod,
    void 0,
    true
  );
}
__name(instrumentMethod, "instrumentMethod");
function instrumentWorkerEntrypoint(optionsCallback, WorkerEntrypointClass) {
  setAsyncLocalStorageAsyncContextStrategyForWorker();
  const InstrumentedClass = new Proxy(WorkerEntrypointClass, {
    construct(target, [ctx, env]) {
      const context2 = instrumentContext(ctx);
      const options = getFinalOptions(optionsCallback(env), env);
      const instrumentedEnv = instrumentEnv(env, options);
      const obj = new target(context2, instrumentedEnv);
      if ("ctx" in obj) {
        Object.defineProperty(obj, "ctx", {
          value: context2,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
      if ("env" in obj) {
        Object.defineProperty(obj, "env", {
          value: instrumentedEnv,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
      Object.defineProperty(obj, "__SENTRY_CONTEXT__", {
        value: context2,
        enumerable: false,
        writable: false,
        configurable: false
      });
      Object.defineProperty(obj, "__SENTRY_OPTIONS__", {
        value: options,
        enumerable: false,
        writable: false,
        configurable: false
      });
      const entrypoint = obj;
      instrumentWorkerEntrypointFetch(entrypoint, options, context2);
      instrumentWorkerEntrypointScheduled(entrypoint, options, context2);
      instrumentWorkerEntrypointQueue(entrypoint, options, context2);
      instrumentWorkerEntrypointTail(entrypoint, options, context2);
      const methodCache = /* @__PURE__ */ new Map();
      const proxy = new Proxy(obj, {
        get(instance, prop) {
          const value = Reflect.get(instance, prop, instance);
          if (typeof value !== "function") {
            return value;
          }
          const method = value;
          const cached = methodCache.get(prop);
          if (cached?.source === method) {
            return cached.wrapped;
          }
          const wrapped = instrumentMethod(instance, proxy, prop, method, options, context2);
          methodCache.set(prop, { source: method, wrapped });
          return wrapped;
        }
      });
      return proxy;
    }
  });
  markAsInstrumented(InstrumentedClass);
  return InstrumentedClass;
}
__name(instrumentWorkerEntrypoint, "instrumentWorkerEntrypoint");

// node_modules/@sentry/cloudflare/build/esm/prod/withSentry.js
function withSentry(optionsCallback, handler) {
  if (isCloudflareClass(handler, "WorkerEntrypoint")) {
    return instrumentWorkerEntrypoint(optionsCallback, handler);
  }
  setAsyncLocalStorageAsyncContextStrategyForWorker();
  try {
    instrumentExportedHandlerFetch(handler, optionsCallback);
    instrumentExportedHandlerScheduled(handler, optionsCallback);
    instrumentExportedHandlerEmail(handler, optionsCallback);
    instrumentExportedHandlerQueue(handler, optionsCallback);
    instrumentExportedHandlerTail(handler, optionsCallback);
  } catch {
  }
  return handler;
}
__name(withSentry, "withSentry");

// src/cloudflareTransient.ts
init_modules_watch_stub();
var TRANSIENT_KINDS = [
  [/Durable Object reset because its code was updated/, "durable-object-code-updated"],
  [/D1 DB is overloaded/, "d1-overloaded"],
  // Both wordings Cloudflare uses: "storage caused object to be reset" and
  // "storage operation exceeded timeout which caused object to be reset".
  [/D1 DB storage (?:operation exceeded timeout which )?caused object to be reset/, "d1-storage-reset"],
  [/D1_ERROR: internal error/, "d1-internal-error"],
  [/D1_ERROR:[^\n]*Durable Object instance is no longer active/, "d1-connection-closed"],
  [/Cannot resolve D1 DB due to transient issue/, "d1-transient"],
  // A migration or import running against the database (a deploy applying
  // its migrations): D1 refuses queries until it finishes, within seconds.
  [/D1_ERROR: Currently processing a long-running import/, "d1-import-in-progress"],
  [/Durable Object storage/, "durable-object-storage"],
  [/Durable Object instance is no longer active/, "durable-object-inactive"],
  [/Durable Object is overloaded/, "durable-object-overloaded"],
  [/internal error; reference =/i, "cloudflare-internal-error"],
  [/Network connection lost/, "network-connection-lost"]
];
function cloudflareTransientKindOfText(text2) {
  return TRANSIENT_KINDS.find(([pattern]) => pattern.test(text2))?.[1] ?? null;
}
__name(cloudflareTransientKindOfText, "cloudflareTransientKindOfText");
function cloudflareTransientKind(error2) {
  let current = error2;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current;
    if (candidate.overloaded === true) return "durable-object-overloaded";
    const kind = typeof candidate.message === "string" ? cloudflareTransientKindOfText(candidate.message) : null;
    if (kind) return kind;
    if (candidate.retryable === true) return "cloudflare-retryable";
    current = candidate.cause;
  }
  return null;
}
__name(cloudflareTransientKind, "cloudflareTransientKind");
function isRetryableCloudflareError(error2) {
  const kind = cloudflareTransientKind(error2);
  return kind != null && kind !== "durable-object-overloaded";
}
__name(isRetryableCloudflareError, "isRetryableCloudflareError");
var RETRY_ATTEMPTS = 3;
var RETRY_BASE_DELAY_MS = 100;
async function withCloudflareRetry(operation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error2) {
      if (attempt >= RETRY_ATTEMPTS || !isRetryableCloudflareError(error2)) throw error2;
      const base = RETRY_BASE_DELAY_MS * 4 ** (attempt - 1);
      await new Promise((resolve2) => setTimeout(resolve2, base + Math.random() * base));
    }
  }
}
__name(withCloudflareRetry, "withCloudflareRetry");
var READ_ONLY_SQL = /^\s*select\b/i;
var ReadRetryStatement = class _ReadRetryStatement {
  constructor(inner, readOnly) {
    this.inner = inner;
    this.readOnly = readOnly;
  }
  inner;
  readOnly;
  static {
    __name(this, "ReadRetryStatement");
  }
  bind(...values) {
    return new _ReadRetryStatement(this.inner.bind(...values), this.readOnly);
  }
  first(column) {
    return this.call(() => column === void 0 ? this.inner.first() : this.inner.first(column));
  }
  all() {
    return this.call(() => this.inner.all());
  }
  run() {
    return this.call(() => this.inner.run());
  }
  raw(options) {
    return this.call(() => this.inner.raw(options));
  }
  call(operation) {
    return this.readOnly ? withCloudflareRetry(operation) : operation();
  }
};
var unwrapStatement = /* @__PURE__ */ __name((statement) => statement instanceof ReadRetryStatement ? statement.inner : statement, "unwrapStatement");
var retryingDatabases = /* @__PURE__ */ new WeakMap();
var wrappers = /* @__PURE__ */ new WeakSet();
function retryD1Reads(db2) {
  if (!db2 || wrappers.has(db2)) return db2;
  const cached = retryingDatabases.get(db2);
  if (cached) return cached;
  const wrapped = {
    prepare: /* @__PURE__ */ __name((sql) => new ReadRetryStatement(db2.prepare(sql), READ_ONLY_SQL.test(sql)), "prepare"),
    batch: /* @__PURE__ */ __name((statements) => {
      const inner = statements.map(unwrapStatement);
      const readOnly = statements.every((statement) => statement instanceof ReadRetryStatement && statement.readOnly);
      return readOnly ? withCloudflareRetry(() => db2.batch(inner)) : db2.batch(inner);
    }, "batch"),
    exec: /* @__PURE__ */ __name((query) => db2.exec(query), "exec"),
    dump: /* @__PURE__ */ __name(() => db2.dump(), "dump"),
    withSession: /* @__PURE__ */ __name((constraintOrBookmark) => db2.withSession(constraintOrBookmark), "withSession")
  };
  wrappers.add(wrapped);
  retryingDatabases.set(db2, wrapped);
  return wrapped;
}
__name(retryD1Reads, "retryD1Reads");
var TRANSIENT_RETRY_AFTER_SECONDS = 5;
function transientUnavailableResponse(headers = {}) {
  return new Response(
    JSON.stringify({ ok: false, error: "temporarily unavailable", code: "cloudflare_transient" }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": String(TRANSIENT_RETRY_AFTER_SECONDS),
        ...headers
      }
    }
  );
}
__name(transientUnavailableResponse, "transientUnavailableResponse");
function logCloudflareTransient(worker, kind, path, error2) {
  const message2 = error2 instanceof Error ? error2.message : String(error2);
  console.warn(JSON.stringify({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    svc: worker,
    kind: "cloudflare_transient",
    transient: kind,
    path,
    message: message2.slice(0, 120)
  }));
}
__name(logCloudflareTransient, "logCloudflareTransient");

// src/relay.ts
init_modules_watch_stub();

// src/apns.ts
init_modules_watch_stub();
var APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com"
};
var JWT_REFRESH_AFTER_SECONDS = 45 * 60;
var APNS_REQUEST_TIMEOUT_MS = 1e4;
var TOKEN_INVALID_REASONS = /* @__PURE__ */ new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);
var encoder = new TextEncoder();
function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(base64UrlEncode, "base64UrlEncode");
function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
__name(base64ToBytes, "base64ToBytes");
function readPkcs8Der(keyPem) {
  const normalized = keyPem.replace(/\\n/g, "\n").trim();
  const match = normalized.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (!match) throw new Error("APNS_KEY must be the PKCS#8 PEM contents of the .p8 signing key.");
  const body = match[1]?.replace(/\s+/g, "") ?? "";
  return base64ToBytes(body).slice().buffer;
}
__name(readPkcs8Der, "readPkcs8Der");
var cachedJwt = null;
async function createApnsJwt(config, nowSeconds = Math.floor(Date.now() / 1e3)) {
  const cacheKey = `${config.teamId}:${config.keyId}`;
  if (cachedJwt && cachedJwt.cacheKey === cacheKey && nowSeconds - cachedJwt.issuedAtSeconds < JWT_REFRESH_AFTER_SECONDS) {
    return cachedJwt.token;
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    readPkcs8Der(config.keyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const payload = base64UrlEncode(JSON.stringify({ iss: config.teamId, iat: nowSeconds }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput)
  );
  const token = `${signingInput}.${base64UrlEncode(signature)}`;
  cachedJwt = { cacheKey, token, issuedAtSeconds: nowSeconds };
  return token;
}
__name(createApnsJwt, "createApnsJwt");
async function sendApnsPush(config, args) {
  const jwt = await createApnsJwt(config);
  const headers = {
    authorization: `bearer ${jwt}`,
    "apns-topic": args.topic,
    "apns-push-type": args.pushType,
    "apns-priority": String(args.priority),
    "apns-expiration": String(Math.max(0, Math.floor(args.expiration))),
    "content-type": "application/json"
  };
  if (args.collapseId) headers["apns-collapse-id"] = args.collapseId.slice(0, 64);
  let response;
  try {
    response = await fetch(`${APNS_HOSTS[args.environment]}/3/device/${encodeURIComponent(args.deviceToken)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args.payload),
      signal: AbortSignal.timeout(APNS_REQUEST_TIMEOUT_MS)
    });
  } catch (error2) {
    const reason2 = error2 instanceof Error && error2.name === "TimeoutError" ? "timeout" : "network_error";
    return { ok: false, status: 0, apnsId: null, reason: reason2, tokenInvalid: false };
  }
  const apnsId = response.headers.get("apns-id");
  if (response.ok) {
    return { ok: true, status: response.status, apnsId, reason: null, tokenInvalid: false };
  }
  let reason = null;
  try {
    const body = await response.json();
    reason = typeof body.reason === "string" ? body.reason : null;
  } catch {
    reason = null;
  }
  return {
    ok: false,
    status: response.status,
    apnsId,
    reason,
    tokenInvalid: response.status === 410 || reason != null && TOKEN_INVALID_REASONS.has(reason)
  };
}
__name(sendApnsPush, "sendApnsPush");

// src/attention.ts
init_modules_watch_stub();

// src/accountSettings.ts
init_modules_watch_stub();

// src/attentionShared.ts
init_modules_watch_stub();
var ACTIVITY_BOARD_COLUMNS = [
  "needs_you",
  "working",
  "waiting",
  "done"
];
function isActivityBoardColumn(value) {
  return typeof value === "string" && ACTIVITY_BOARD_COLUMNS.includes(value);
}
__name(isActivityBoardColumn, "isActivityBoardColumn");
function isActivityWaitingReason(value) {
  return value === "snoozed" || value === "ci" || value === "review" || value === "scheduled" || value === "subagent";
}
__name(isActivityWaitingReason, "isActivityWaitingReason");
var MAX_ID_LENGTH = 256;
var MAX_TITLE_LENGTH = 180;
var MAX_PREVIEW_LENGTH = 320;
var MAX_DETAIL_LENGTH = 1e3;
var LIVE_ACTIVITY_START_CLAIM_TTL_MS = 3e4;
function json(value, init2 = {}) {
  return new Response(JSON.stringify(value), {
    ...init2,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...init2.headers ?? {}
    }
  });
}
__name(json, "json");
var textEncoder = new TextEncoder();
function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(toHex, "toHex");
function constantTimeEqual(left, right) {
  const a = textEncoder.encode(left);
  const b2 = textEncoder.encode(right);
  let diff = a.length ^ b2.length;
  const length = Math.max(a.length, b2.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b2[index] ?? 0);
  }
  return diff === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
async function sha256Hex(value) {
  const data = typeof value === "string" ? textEncoder.encode(value) : value;
  return toHex(await crypto.subtle.digest("SHA-256", data));
}
__name(sha256Hex, "sha256Hex");
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
__name(isRecord, "isRecord");
function requiredString(value, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}
__name(requiredString, "requiredString");
function optionalIsoDate(value) {
  if (value === null || value === void 0) return null;
  const normalized = requiredString(value, 64);
  if (!normalized || Number.isNaN(Date.parse(normalized))) return void 0;
  return new Date(normalized).toISOString();
}
__name(optionalIsoDate, "optionalIsoDate");
function boundedText(value, maxLength) {
  const text2 = requiredString(value, maxLength * 4);
  if (!text2) return null;
  const sanitized = text2.replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/gi, "[redacted]").replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]").replace(/\s+/g, " ").trim();
  return sanitized.slice(0, maxLength);
}
__name(boundedText, "boundedText");
function apnsConfig(env) {
  const keyPem = env.APNS_KEY?.trim() ?? "";
  const keyId = env.APNS_KEY_ID?.trim() ?? "";
  const teamId = env.APNS_TEAM_ID?.trim() ?? "";
  return keyPem && keyId && teamId ? { keyPem, keyId, teamId } : null;
}
__name(apnsConfig, "apnsConfig");
function logAttentionDeliveryError(surface, deviceId, error2) {
  const reason = error2 instanceof Error ? error2.message : String(error2);
  try {
    console.error(JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      svc: "ade-push-relay",
      kind: "attention_delivery_error",
      surface,
      device: deviceId.slice(-6),
      reason: reason.slice(0, 500)
    }));
  } catch {
    console.error("ade-push-relay attention_delivery_error");
  }
}
__name(logAttentionDeliveryError, "logAttentionDeliveryError");
function readPreferences(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
__name(readPreferences, "readPreferences");
function preferenceBoolean(device, account, key, fallback) {
  if (typeof device[key] === "boolean") return device[key];
  if (typeof account[key] === "boolean") return account[key];
  return fallback;
}
__name(preferenceBoolean, "preferenceBoolean");
function preferenceNumber(device, account, key, fallback) {
  if (typeof device[key] === "number" && Number.isFinite(device[key])) return device[key];
  if (typeof account[key] === "number" && Number.isFinite(account[key])) return account[key];
  return fallback;
}
__name(preferenceNumber, "preferenceNumber");
var ACCOUNT_SCOPE_KEY_MAX_LENGTH = 512;
var WRITE_CONFLICT_TOLERANCE_MS = 5e3;
var NO_CONFLICT_CHECK = "9999-12-31T23:59:59.999Z";
function parseClientTime(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
__name(parseClientTime, "parseClientTime");
function writeClock(sentAt, nowMs = Date.now()) {
  const sent = parseClientTime(sentAt);
  return { nowMs, offsetMs: sent === null ? 0 : nowMs - sent };
}
__name(writeClock, "writeClock");
function staleWriteThreshold(clock, writtenAt) {
  const written = parseClientTime(writtenAt);
  if (written === null) return NO_CONFLICT_CHECK;
  const onWorkerClock = Math.min(clock.nowMs, written + clock.offsetMs);
  return new Date(onWorkerClock + WRITE_CONFLICT_TOLERANCE_MS).toISOString();
}
__name(staleWriteThreshold, "staleWriteThreshold");
function decodePathSegment(value) {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    return null;
  }
}
__name(decodePathSegment, "decodePathSegment");
function accountRefusalResult(verdict) {
  return verdict.ok ? { status: "written" } : { status: "rejected", reason: verdict.reason };
}
__name(accountRefusalResult, "accountRefusalResult");
function changesOf(outcome) {
  const changes = isRecord(outcome) && isRecord(outcome.meta) ? outcome.meta.changes : void 0;
  return typeof changes === "number" ? changes : 0;
}
__name(changesOf, "changesOf");
async function accountWriteResults(verdicts, outcomes, readCurrent) {
  const results = [];
  let written = 0;
  let parsedIndex = 0;
  for (const verdict of verdicts) {
    if (!verdict.ok) {
      results.push(accountRefusalResult(verdict));
      continue;
    }
    const index = parsedIndex;
    parsedIndex += 1;
    if (changesOf(outcomes[index]) > 0) {
      written += 1;
      results.push({ status: "written" });
      continue;
    }
    results.push({ status: "stale", current: await readCurrent(verdict.write) });
  }
  return { results, written };
}
__name(accountWriteResults, "accountWriteResults");
function parseAccountScopeKey(value) {
  const scope = requiredString(value, ACCOUNT_SCOPE_KEY_MAX_LENGTH);
  if (!scope) return null;
  if (scope === "all") return scope;
  if (scope.startsWith("repo:") && scope.length > "repo:".length) return scope;
  return null;
}
__name(parseAccountScopeKey, "parseAccountScopeKey");
function toBase64Url(text2) {
  let binary = "";
  const bytes = new TextEncoder().encode(text2);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(toBase64Url, "toBase64Url");
function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
__name(fromBase64Url, "fromBase64Url");
function encodeAccountCursor(cursor) {
  return toBase64Url(JSON.stringify({ v: 1, t: cursor.updatedAt, k: cursor.keys ?? [] }));
}
__name(encodeAccountCursor, "encodeAccountCursor");
function decodeAccountCursor(raw) {
  const value = raw?.trim();
  if (!value) return null;
  const decoded = fromBase64Url(value);
  if (decoded) {
    try {
      const parsed = JSON.parse(decoded);
      if (isRecord(parsed) && parsed.v === 1 && typeof parsed.t === "string" && !Number.isNaN(Date.parse(parsed.t)) && Array.isArray(parsed.k) && parsed.k.every((entry) => typeof entry === "string")) {
        return { updatedAt: new Date(parsed.t).toISOString(), keys: parsed.k };
      }
    } catch {
    }
  }
  if (Number.isNaN(Date.parse(value))) return null;
  return { updatedAt: new Date(value).toISOString(), keys: null };
}
__name(decodeAccountCursor, "decodeAccountCursor");
function parseSinceParam(url) {
  return decodeAccountCursor(url.searchParams.get("since"));
}
__name(parseSinceParam, "parseSinceParam");
function lexicographicallyAfter(columns, values) {
  const clauses = [];
  const bindings = [];
  for (let index = 0; index < columns.length; index += 1) {
    const terms = [];
    for (let prior = 0; prior < index; prior += 1) {
      terms.push(`${columns[prior]} = ?`);
      bindings.push(values[prior]);
    }
    terms.push(`${columns[index]} > ?`);
    bindings.push(values[index]);
    clauses.push(`(${terms.join(" and ")})`);
  }
  return { sql: `(${clauses.join(" or ")})`, bindings };
}
__name(lexicographicallyAfter, "lexicographicallyAfter");
function buildAccountPageQuery(options) {
  const { userId, cursor, scope, keyColumns, limit } = options;
  const conditions = ["user_id = ?"];
  const bindings = [userId];
  if (cursor) {
    if (cursor.keys && cursor.keys.length === keyColumns.length) {
      const after = lexicographicallyAfter(["updated_at", ...keyColumns], [
        cursor.updatedAt,
        ...cursor.keys
      ]);
      conditions.push(after.sql);
      bindings.push(...after.bindings);
    } else {
      conditions.push("updated_at > ?");
      bindings.push(cursor.updatedAt);
    }
  }
  if (scope) {
    conditions.push("scope_key = ?");
    bindings.push(scope);
  }
  bindings.push(limit + 1);
  return {
    where: conditions.join(" and "),
    orderBy: ["updated_at", ...keyColumns].join(" asc, ") + " asc",
    bindings
  };
}
__name(buildAccountPageQuery, "buildAccountPageQuery");
function accountPageResult(results, options) {
  const page = results.slice(0, options.limit);
  const last = page[page.length - 1];
  const next = last ? {
    updatedAt: String(last.updated_at),
    keys: options.keyColumns.map((column) => String(last[column] ?? ""))
  } : options.cursor;
  return {
    page,
    truncated: results.length > options.limit,
    cursor: next ? encodeAccountCursor(next) : null
  };
}
__name(accountPageResult, "accountPageResult");
async function countAndGuard(options) {
  const extra = options.extraWhere ?? "";
  const existing = await options.env.DB.prepare(`select count(*) as count from ${options.table} where user_id = ?${extra}`).bind(options.userId).first();
  return (existing?.count ?? 0) + options.adding > options.ceiling;
}
__name(countAndGuard, "countAndGuard");
async function accountChangeMarks(env, userId) {
  const row = await env.DB.prepare(`
    select
      (select newest || '#' || (select count(*) from account_settings
                                 where user_id = ? and updated_at = newest)
         from (select updated_at as newest from account_settings
                where user_id = ? order by updated_at desc limit 1)) as settings,
      (select newest || '#' || (select count(*) from account_vault_items
                                 where user_id = ? and updated_at = newest)
         from (select updated_at as newest from account_vault_items
                where user_id = ? order by updated_at desc limit 1)) as vault
  `).bind(userId, userId, userId, userId).first();
  return { accountUserId: userId, settings: row?.settings ?? null, vault: row?.vault ?? null };
}
__name(accountChangeMarks, "accountChangeMarks");

// src/accountSettings.ts
var MAX_SETTING_VALUE_BYTES = 16e3;
var MAX_SETTINGS_PER_ACCOUNT = 5e3;
var MAX_SETTINGS_PER_WRITE = 200;
var MAX_SETTINGS_PER_READ = 1e3;
var MAX_SETTING_KEY_LENGTH = 200;
var SETTING_KEY_COLUMNS = ["scope_key", "setting_key"];
function parseSettingKey(value) {
  const key = requiredString(value, MAX_SETTING_KEY_LENGTH);
  if (!key) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) ? key : null;
}
__name(parseSettingKey, "parseSettingKey");
function checkWriteItem(value) {
  if (!isRecord(value)) return { ok: false, reason: "invalid setting" };
  const scope = parseAccountScopeKey(value.scope);
  if (!scope) return { ok: false, reason: "invalid scope" };
  const key = parseSettingKey(value.key);
  if (!key) return { ok: false, reason: "invalid key" };
  if (value.value === void 0) return { ok: false, reason: "no value" };
  let valueJson;
  try {
    valueJson = JSON.stringify(value.value);
  } catch {
    return { ok: false, reason: "invalid value" };
  }
  if (typeof valueJson !== "string") return { ok: false, reason: "invalid value" };
  if (valueJson.length > MAX_SETTING_VALUE_BYTES) return { ok: false, reason: "value too large" };
  const changedAtRaw = typeof value.changedAt === "string" ? value.changedAt.trim() : "";
  const changedAt = changedAtRaw && !Number.isNaN(Date.parse(changedAtRaw)) ? new Date(changedAtRaw).toISOString() : null;
  return { ok: true, write: { scope, key, valueJson, changedAt, writtenAt: value.writtenAt } };
}
__name(checkWriteItem, "checkWriteItem");
async function readSettingRow(env, userId, scope, key) {
  return await env.DB.prepare(`
    select scope_key, setting_key, value_json, updated_at, changed_at, writer_device_id, deleted
    from account_settings
    where user_id = ? and scope_key = ? and setting_key = ?
  `).bind(userId, scope, key).first();
}
__name(readSettingRow, "readSettingRow");
function rowToSetting(row) {
  let value = null;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    value = null;
  }
  return {
    scope: row.scope_key,
    key: row.setting_key,
    value,
    updatedAt: row.updated_at,
    changedAt: row.changed_at,
    writerDeviceId: row.writer_device_id,
    ...row.deleted ? { deleted: true } : {}
  };
}
__name(rowToSetting, "rowToSetting");
async function handleRead(env, userId, url) {
  const cursor = parseSinceParam(url);
  const scope = url.searchParams.get("scope")?.trim() ? parseAccountScopeKey(url.searchParams.get("scope")) : null;
  if (url.searchParams.has("scope") && !scope) {
    return json({ ok: false, error: "invalid scope" }, { status: 400 });
  }
  const query = buildAccountPageQuery({
    userId,
    cursor,
    scope,
    keyColumns: SETTING_KEY_COLUMNS,
    limit: MAX_SETTINGS_PER_READ
  });
  const rows = await env.DB.prepare(`
    select scope_key, setting_key, value_json, updated_at, changed_at, writer_device_id, deleted
    from account_settings
    where ${query.where}
    order by ${query.orderBy}
    limit ?
  `).bind(...query.bindings).all();
  const paged = accountPageResult(rows.results, {
    limit: MAX_SETTINGS_PER_READ,
    keyColumns: SETTING_KEY_COLUMNS,
    cursor
  });
  return json({
    ok: true,
    settings: paged.page.map(rowToSetting),
    truncated: paged.truncated,
    cursor: paged.cursor
  });
}
__name(handleRead, "handleRead");
async function handleWrite(request, env, userId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(body) || !Array.isArray(body.settings)) {
    return json({ ok: false, error: "settings array required" }, { status: 400 });
  }
  if (body.settings.length > MAX_SETTINGS_PER_WRITE) {
    return json(
      { ok: false, error: "too many settings in one write" },
      { status: 413 }
    );
  }
  const writerDeviceId = requiredString(body.deviceId, 128);
  const itemResults = body.itemResults === true;
  const clock = writeClock(body.sentAt);
  const verdicts = body.settings.map(checkWriteItem);
  const firstRefusal = verdicts.find((verdict) => !verdict.ok);
  if (firstRefusal && !itemResults) {
    const index = verdicts.indexOf(firstRefusal);
    return json(
      { ok: false, error: "invalid setting", index, reason: firstRefusal.reason },
      { status: 400 }
    );
  }
  const parsed = verdicts.flatMap((verdict) => verdict.ok ? [verdict.write] : []);
  if (!parsed.length) {
    return json({
      ok: true,
      written: 0,
      updatedAt: null,
      ...itemResults ? { results: verdicts.map(accountRefusalResult) } : {}
    });
  }
  if (await countAndGuard({
    env,
    table: "account_settings",
    userId,
    adding: parsed.length,
    ceiling: MAX_SETTINGS_PER_ACCOUNT + MAX_SETTINGS_PER_WRITE,
    extraWhere: " and deleted = 0"
  })) {
    return json(
      { ok: false, error: "account settings limit reached" },
      { status: 507 }
    );
  }
  const updatedAt = new Date(clock.nowMs).toISOString();
  const outcomes = await env.DB.batch(parsed.map((write) => env.DB.prepare(`
    insert into account_settings(
      user_id, scope_key, setting_key, value_json, updated_at, changed_at, writer_device_id, deleted
    )
    values (?, ?, ?, ?, ?, ?, ?, 0)
    on conflict(user_id, scope_key, setting_key) do update set
      value_json = excluded.value_json,
      updated_at = excluded.updated_at,
      changed_at = excluded.changed_at,
      writer_device_id = excluded.writer_device_id,
      deleted = 0
    where account_settings.updated_at <= ? or account_settings.writer_device_id = ?
  `).bind(
    userId,
    write.scope,
    write.key,
    write.valueJson,
    updatedAt,
    write.changedAt,
    writerDeviceId,
    staleWriteThreshold(clock, itemResults ? write.writtenAt : null),
    writerDeviceId
  )));
  if (!itemResults) return json({ ok: true, written: parsed.length, updatedAt });
  const { results, written } = await accountWriteResults(verdicts, outcomes, async (write) => {
    const row = await readSettingRow(env, userId, write.scope, write.key);
    return row ? rowToSetting(row) : null;
  });
  return json({ ok: true, written, updatedAt: written > 0 ? updatedAt : null, results });
}
__name(handleWrite, "handleWrite");
async function handleDelete(env, userId, url, scopeRaw, keyRaw) {
  const scope = parseAccountScopeKey(scopeRaw);
  const key = parseSettingKey(keyRaw);
  if (!scope || !key) {
    return json({ ok: false, error: "invalid setting" }, { status: 400 });
  }
  const clock = writeClock(url.searchParams.get("sentAt"));
  const threshold = staleWriteThreshold(clock, url.searchParams.get("writtenAt"));
  const deviceId = requiredString(url.searchParams.get("deviceId"), 128);
  const updatedAt = new Date(clock.nowMs).toISOString();
  const result = await env.DB.prepare(`
    update account_settings
    set deleted = 1, value_json = 'null', updated_at = ?, writer_device_id = ?
    where user_id = ? and scope_key = ? and setting_key = ? and deleted = 0
      and (updated_at <= ? or writer_device_id = ?)
  `).bind(updatedAt, deviceId, userId, scope, key, threshold, deviceId).run();
  const deleted = (result.meta?.changes ?? 0) > 0;
  if (!deleted && url.searchParams.has("writtenAt")) {
    const row = await readSettingRow(env, userId, scope, key);
    if (row && !row.deleted && row.updated_at > threshold) {
      return json(
        { ok: false, error: "a newer value exists", code: "stale", current: rowToSetting(row) },
        { status: 409 }
      );
    }
  }
  return json({ ok: true, deleted });
}
__name(handleDelete, "handleDelete");
async function handleAccountSettingsRoute(request, env, url, userId, route) {
  if (route[0] !== "settings") return null;
  if (route.length === 1 && request.method === "GET") {
    return await handleRead(env, userId, url);
  }
  if (route.length === 1 && request.method === "PUT") {
    return await handleWrite(request, env, userId);
  }
  if (route.length === 3 && request.method === "DELETE") {
    return await handleDelete(
      env,
      userId,
      url,
      decodePathSegment(route[1]),
      decodePathSegment(route[2])
    );
  }
  return null;
}
__name(handleAccountSettingsRoute, "handleAccountSettingsRoute");

// src/accountVault.ts
init_modules_watch_stub();
var VAULT_AAD = new TextEncoder().encode("ade.account.vault.v1");
async function vaultKey(env) {
  const raw = env.VAULT_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  let bytes;
  try {
    bytes = fromBase64(raw);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt"
  ]);
}
__name(vaultKey, "vaultKey");
function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
__name(toBase64, "toBase64");
function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
__name(fromBase64, "fromBase64");
async function sealValue(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: VAULT_AAD },
    key,
    new TextEncoder().encode(value)
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}
__name(sealValue, "sealValue");
async function openValue(key, stored) {
  const parts = stored.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parts[1]), additionalData: VAULT_AAD },
      key,
      fromBase64(parts[2])
    );
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}
__name(openValue, "openValue");
function vaultUnavailable() {
  return json(
    {
      ok: false,
      error: "vault encryption is not configured",
      code: "vault_unavailable",
      recovery: "The ADE service owner must set VAULT_ENCRYPTION_KEY on the push relay."
    },
    { status: 503 }
  );
}
__name(vaultUnavailable, "vaultUnavailable");
var MAX_VALUE_CHARS = 6e3;
var MAX_VALUE_CHARS_BY_KIND = /* @__PURE__ */ new Map([["provider_login", 16e3]]);
var MAX_ITEMS_PER_ACCOUNT = 2e3;
var MAX_ITEMS_PER_WRITE = 100;
var MAX_ITEMS_PER_READ = 500;
var MAX_ITEM_KEY_LENGTH = 200;
var VAULT_KEY_COLUMNS = ["scope_key", "item_kind", "item_key"];
var ITEM_KINDS = /* @__PURE__ */ new Set([
  "secret",
  "provider_key",
  "integration",
  "provider_api_key",
  "linear_refresh_token",
  "project_secret",
  // ADE MCP's account secret and its connections (token hashes, never tokens).
  "ade_mcp",
  // A provider sign-in: the login a provider's CLI keeps on disk, carried to
  // the account's other computers and ADE Cloud. The brain's sign-in sync owns
  // the payload and the renewal rules.
  "provider_login"
]);
var VAULT_REVISION_ABSENT = "absent";
function parseIfRevision(value) {
  if (value === void 0 || value === null) return null;
  if (value === VAULT_REVISION_ABSENT) return VAULT_REVISION_ABSENT;
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) return void 0;
  return value;
}
__name(parseIfRevision, "parseIfRevision");
var NEXT_UPDATED_AT = "max(?, coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', account_vault_items.updated_at, '+0.001 seconds'), ?))";
var ITEM_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._:-]*)*$/;
function parseItemKey(value) {
  const key = requiredString(value, MAX_ITEM_KEY_LENGTH);
  if (!key) return null;
  return ITEM_KEY_PATTERN.test(key) ? key : null;
}
__name(parseItemKey, "parseItemKey");
function checkWriteItem2(value) {
  if (!isRecord(value)) return { ok: false, reason: "invalid item" };
  if ("ciphertext" in value) return { ok: false, reason: "invalid item" };
  const scope = parseAccountScopeKey(value.scope);
  if (!scope) return { ok: false, reason: "invalid scope" };
  const kind = requiredString(value.kind, 32);
  if (!kind || !ITEM_KINDS.has(kind)) return { ok: false, reason: "unknown kind" };
  const key = parseItemKey(value.key);
  if (!key) return { ok: false, reason: "invalid key" };
  const plaintext = typeof value.value === "string" ? value.value : "";
  if (!plaintext) return { ok: false, reason: "empty value" };
  if (plaintext.length > (MAX_VALUE_CHARS_BY_KIND.get(kind) ?? MAX_VALUE_CHARS)) {
    return { ok: false, reason: "value too large" };
  }
  const refreshOwner = requiredString(value.refreshOwner, 128);
  const ifRevision = parseIfRevision(value.ifRevision);
  if (ifRevision === void 0) return { ok: false, reason: "invalid revision" };
  return {
    ok: true,
    write: { scope, kind, key, value: plaintext, refreshOwner, writtenAt: value.writtenAt, ifRevision }
  };
}
__name(checkWriteItem2, "checkWriteItem");
var VAULT_ROW_COLUMNS = "scope_key, item_kind, item_key, ciphertext, updated_at, writer_device_id, refresh_owner, deleted";
async function rowToVaultItem(key, row) {
  if (row.deleted) {
    return {
      scope: row.scope_key,
      kind: row.item_kind,
      key: row.item_key,
      value: null,
      updatedAt: row.updated_at,
      writerDeviceId: row.writer_device_id,
      refreshOwner: row.refresh_owner,
      deleted: true
    };
  }
  return {
    scope: row.scope_key,
    kind: row.item_kind,
    key: row.item_key,
    value: await openValue(key, row.ciphertext),
    updatedAt: row.updated_at,
    writerDeviceId: row.writer_device_id,
    refreshOwner: row.refresh_owner
  };
}
__name(rowToVaultItem, "rowToVaultItem");
async function readVaultRow(env, userId, item) {
  return await env.DB.prepare(`
    select ${VAULT_ROW_COLUMNS}
    from account_vault_items
    where user_id = ? and scope_key = ? and item_kind = ? and item_key = ?
  `).bind(userId, item.scope, item.kind, item.key).first();
}
__name(readVaultRow, "readVaultRow");
async function handleRead2(env, userId, url) {
  const key = await vaultKey(env);
  if (!key) return vaultUnavailable();
  const cursor = parseSinceParam(url);
  const scopeParam = url.searchParams.get("scope");
  const scope = scopeParam?.trim() ? parseAccountScopeKey(scopeParam) : null;
  if (scopeParam != null && !scope) {
    return json({ ok: false, error: "invalid scope" }, { status: 400 });
  }
  const query = buildAccountPageQuery({
    userId,
    cursor,
    scope,
    keyColumns: VAULT_KEY_COLUMNS,
    limit: MAX_ITEMS_PER_READ
  });
  const rows = await env.DB.prepare(`
    select ${VAULT_ROW_COLUMNS}
    from account_vault_items
    where ${query.where}
    order by ${query.orderBy}
    limit ?
  `).bind(...query.bindings).all();
  const paged = accountPageResult(rows.results, {
    limit: MAX_ITEMS_PER_READ,
    keyColumns: VAULT_KEY_COLUMNS,
    cursor
  });
  const items = [];
  for (const row of paged.page) items.push(await rowToVaultItem(key, row));
  return json({
    ok: true,
    items,
    truncated: paged.truncated,
    cursor: paged.cursor
  });
}
__name(handleRead2, "handleRead");
function vaultWriteStatement(env, userId, write, sealedValue, updatedAt, writerDeviceId, itemResults, clock) {
  if (write.ifRevision === VAULT_REVISION_ABSENT) {
    return env.DB.prepare(`
      insert into account_vault_items(
        user_id, scope_key, item_kind, item_key, ciphertext, updated_at, writer_device_id, refresh_owner, deleted
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, 0)
      on conflict(user_id, scope_key, item_kind, item_key) do nothing
    `).bind(userId, write.scope, write.kind, write.key, sealedValue, updatedAt, writerDeviceId, write.refreshOwner);
  }
  if (write.ifRevision !== null) {
    return env.DB.prepare(`
      update account_vault_items
      set ciphertext = ?, updated_at = ${NEXT_UPDATED_AT}, writer_device_id = ?, refresh_owner = ?, deleted = 0
      where user_id = ? and scope_key = ? and item_kind = ? and item_key = ?
        and (updated_at = ? or writer_device_id = ?)
    `).bind(
      sealedValue,
      updatedAt,
      updatedAt,
      writerDeviceId,
      write.refreshOwner,
      userId,
      write.scope,
      write.kind,
      write.key,
      write.ifRevision,
      writerDeviceId
    );
  }
  return env.DB.prepare(`
    insert into account_vault_items(
      user_id, scope_key, item_kind, item_key, ciphertext, updated_at, writer_device_id, refresh_owner, deleted
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, 0)
    on conflict(user_id, scope_key, item_kind, item_key) do update set
      ciphertext = excluded.ciphertext,
      updated_at = ${NEXT_UPDATED_AT},
      writer_device_id = excluded.writer_device_id,
      refresh_owner = excluded.refresh_owner,
      deleted = 0
    where account_vault_items.updated_at <= ? or account_vault_items.writer_device_id = ?
  `).bind(
    userId,
    write.scope,
    write.kind,
    write.key,
    sealedValue,
    updatedAt,
    writerDeviceId,
    write.refreshOwner,
    updatedAt,
    updatedAt,
    itemResults ? staleWriteThreshold(clock, write.writtenAt) : staleWriteThreshold(clock, null),
    writerDeviceId
  );
}
__name(vaultWriteStatement, "vaultWriteStatement");
async function handleWrite2(request, env, userId) {
  const key = await vaultKey(env);
  if (!key) return vaultUnavailable();
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return json({ ok: false, error: "items array required" }, { status: 400 });
  }
  if (body.items.length > MAX_ITEMS_PER_WRITE) {
    return json({ ok: false, error: "too many items in one write" }, { status: 413 });
  }
  const writerDeviceId = requiredString(body.deviceId, 128);
  const clock = writeClock(body.sentAt);
  const verdicts = body.items.map(checkWriteItem2);
  const itemResults = body.itemResults === true || verdicts.some((verdict) => verdict.ok && verdict.write.ifRevision !== null);
  const firstRefusal = verdicts.find((verdict) => !verdict.ok);
  if (firstRefusal && !itemResults) {
    const index = verdicts.indexOf(firstRefusal);
    return json(
      { ok: false, error: "invalid item", index, reason: firstRefusal.reason },
      { status: 400 }
    );
  }
  const parsed = verdicts.flatMap((verdict) => verdict.ok ? [verdict.write] : []);
  if (!parsed.length) {
    return json({
      ok: true,
      written: 0,
      updatedAt: null,
      ...itemResults ? { results: verdicts.map(accountRefusalResult) } : {}
    });
  }
  if (await countAndGuard({
    env,
    table: "account_vault_items",
    userId,
    adding: parsed.length,
    ceiling: MAX_ITEMS_PER_ACCOUNT + MAX_ITEMS_PER_WRITE,
    extraWhere: " and deleted = 0"
  })) {
    return json({ ok: false, error: "account vault limit reached" }, { status: 507 });
  }
  const updatedAt = new Date(clock.nowMs).toISOString();
  const sealed = await Promise.all(parsed.map((write) => sealValue(key, write.value)));
  const outcomes = await env.DB.batch(parsed.map((write, index) => vaultWriteStatement(env, userId, write, sealed[index], updatedAt, writerDeviceId, itemResults, clock)));
  if (!itemResults) return json({ ok: true, written: parsed.length, updatedAt });
  const { results, written } = await accountWriteResults(verdicts, outcomes, async (write) => {
    const row = await readVaultRow(env, userId, write);
    return row ? await rowToVaultItem(key, row) : null;
  });
  return json({ ok: true, written, updatedAt: written > 0 ? updatedAt : null, results });
}
__name(handleWrite2, "handleWrite");
async function handleDelete2(env, userId, url, scopeRaw, kindRaw, keyRaw) {
  const scope = parseAccountScopeKey(scopeRaw);
  const key = parseItemKey(keyRaw);
  const kind = requiredString(kindRaw, 32);
  if (!scope || !key || !kind || !ITEM_KINDS.has(kind)) {
    return json({ ok: false, error: "invalid item" }, { status: 400 });
  }
  const ifRevision = parseIfRevision(url.searchParams.get("ifRevision"));
  if (ifRevision === void 0) return json({ ok: false, error: "invalid revision" }, { status: 400 });
  const clock = writeClock(url.searchParams.get("sentAt"));
  const threshold = staleWriteThreshold(clock, url.searchParams.get("writtenAt"));
  const deviceId = requiredString(url.searchParams.get("deviceId"), 128);
  const updatedAt = new Date(clock.nowMs).toISOString();
  let deleted = false;
  if (ifRevision !== VAULT_REVISION_ABSENT) {
    const result = await env.DB.prepare(`
      update account_vault_items
      set deleted = 1, ciphertext = '', updated_at = ${NEXT_UPDATED_AT}, writer_device_id = ?, refresh_owner = null
      where user_id = ? and scope_key = ? and item_kind = ? and item_key = ? and deleted = 0
        and (updated_at ${ifRevision === null ? "<=" : "="} ? or writer_device_id = ?)
    `).bind(
      updatedAt,
      updatedAt,
      deviceId,
      userId,
      scope,
      kind,
      key,
      ifRevision ?? threshold,
      deviceId
    ).run();
    deleted = (result.meta?.changes ?? 0) > 0;
  }
  const checked = ifRevision !== null || url.searchParams.has("writtenAt");
  if (!deleted && checked) {
    const row = await readVaultRow(env, userId, { scope, kind, key });
    const newer = ifRevision !== null || row !== null && row.updated_at > threshold;
    if (row && !row.deleted && newer) {
      const sealKey = await vaultKey(env);
      if (!sealKey) return vaultUnavailable();
      return json(
        { ok: false, error: "a newer value exists", code: "stale", current: await rowToVaultItem(sealKey, row) },
        { status: 409 }
      );
    }
  }
  return json({ ok: true, deleted });
}
__name(handleDelete2, "handleDelete");
async function handleAccountVaultRoute(request, env, url, userId, route) {
  if (route[0] !== "vault") return null;
  if (route.length === 1 && request.method === "GET") {
    return await handleRead2(env, userId, url);
  }
  if (route.length === 1 && request.method === "PUT") {
    return await handleWrite2(request, env, userId);
  }
  if (route.length >= 4 && request.method === "DELETE") {
    const keySegments = route.slice(3).map(decodePathSegment);
    return await handleDelete2(
      env,
      userId,
      url,
      decodePathSegment(route[1]),
      decodePathSegment(route[2]),
      keySegments.some((segment) => segment === null) ? null : keySegments.join("/")
    );
  }
  return null;
}
__name(handleAccountVaultRoute, "handleAccountVaultRoute");

// src/passwords.ts
init_modules_watch_stub();
var MAX_ITEMS_PER_READ2 = 500;
var MAX_ITEMS_PER_WRITE2 = 200;
var MAX_CIPHERTEXT_CHARS = 64 * 1024;
var ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
var DEVICE_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;
var MACHINE_KINDS = /* @__PURE__ */ new Set(["desktop", "phone", "cloud", "web", "cli"]);
var KEY_COLUMNS = ["item_id"];
var NEXT_UPDATED_AT2 = "max(?, coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', password_items.updated_at, '+0.001 seconds'), ?))";
var unavailable = /* @__PURE__ */ __name(() => json({ ok: false, error: "passwords unavailable", code: "passwords_unavailable" }, { status: 503 }), "unavailable");
var badRequest = /* @__PURE__ */ __name((error2) => json({ ok: false, error: error2 }, { status: 400 }), "badRequest");
async function readBody(request) {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
__name(readBody, "readBody");
async function keyService(env, path, body) {
  const auth = env.KEY_SERVICE_AUTH_SECRET?.trim();
  if (!env.PASSWORD_KEY_SERVICE || !auth) return null;
  try {
    const response = await env.PASSWORD_KEY_SERVICE.fetch(`https://password-key-service.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ade-key-service-auth": auth },
      body: JSON.stringify(body)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
__name(keyService, "keyService");
async function handleRead3(env, userId, url) {
  const cursor = parseSinceParam(url);
  const query = buildAccountPageQuery({ userId, cursor, scope: null, keyColumns: KEY_COLUMNS, limit: MAX_ITEMS_PER_READ2 });
  const rows = await env.DB.prepare(`
    select item_id, ciphertext, updated_at, deleted
    from password_items
    where ${query.where}
    order by ${query.orderBy}
    limit ?
  `).bind(...query.bindings).all();
  const paged = accountPageResult(rows.results, { limit: MAX_ITEMS_PER_READ2, keyColumns: KEY_COLUMNS, cursor });
  return json({
    ok: true,
    items: paged.page.map((row) => ({
      id: row.item_id,
      // A tombstone carries no ciphertext back.
      ciphertext: row.deleted ? null : row.ciphertext,
      revision: row.updated_at,
      deleted: Boolean(row.deleted)
    })),
    truncated: paged.truncated,
    cursor: paged.cursor
  });
}
__name(handleRead3, "handleRead");
async function handleWrite3(request, env, userId) {
  const body = await readBody(request);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) return badRequest("items required");
  if (items.length > MAX_ITEMS_PER_WRITE2) return badRequest("too many items");
  const deviceId = typeof body?.deviceId === "string" && DEVICE_ID_PATTERN.test(body.deviceId) ? body.deviceId : null;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const results = [];
  for (const raw of items) {
    const item = raw && typeof raw === "object" ? raw : {};
    const id = typeof item.id === "string" ? item.id : "";
    const deleted = item.deleted === true;
    const ciphertext = typeof item.ciphertext === "string" ? item.ciphertext : "";
    const ifRevision = typeof item.ifRevision === "string" ? item.ifRevision : null;
    if (!ITEM_ID_PATTERN.test(id) || !deleted && (!ciphertext || ciphertext.length > MAX_CIPHERTEXT_CHARS)) {
      results.push({ id, status: "invalid" });
      continue;
    }
    const stored = deleted ? "" : ciphertext;
    let statement;
    if (ifRevision === "absent") {
      statement = env.DB.prepare(`
        insert into password_items(user_id, item_id, ciphertext, updated_at, writer_device_id, deleted)
        values (?, ?, ?, ?, ?, ?)
        on conflict(user_id, item_id) do nothing
      `).bind(userId, id, stored, now, deviceId, deleted ? 1 : 0);
    } else if (ifRevision) {
      statement = env.DB.prepare(`
        update password_items
        set ciphertext = ?, updated_at = ${NEXT_UPDATED_AT2}, writer_device_id = ?, deleted = ?
        where user_id = ? and item_id = ? and updated_at = ?
      `).bind(stored, now, now, deviceId, deleted ? 1 : 0, userId, id, ifRevision);
    } else {
      statement = env.DB.prepare(`
        insert into password_items(user_id, item_id, ciphertext, updated_at, writer_device_id, deleted)
        values (?, ?, ?, ?, ?, ?)
        on conflict(user_id, item_id) do update set
          ciphertext = excluded.ciphertext,
          updated_at = ${NEXT_UPDATED_AT2},
          writer_device_id = excluded.writer_device_id,
          deleted = excluded.deleted
      `).bind(userId, id, stored, now, deviceId, deleted ? 1 : 0, now, now);
    }
    const outcome = await statement.run();
    const row = await env.DB.prepare(
      "select updated_at from password_items where user_id = ? and item_id = ?"
    ).bind(userId, id).first();
    const changed = (outcome.meta?.changes ?? 0) > 0;
    results.push({ id, status: changed ? "ok" : "stale", revision: row?.updated_at ?? null });
  }
  return json({ ok: true, results });
}
__name(handleWrite3, "handleWrite");
async function recordRelease(env, userId, deviceId, machineKind) {
  await env.DB.prepare(`
    insert into password_key_releases(user_id, device_id, machine_kind, released_at)
    values (?, ?, ?, ?)
  `).bind(userId, deviceId, machineKind, (/* @__PURE__ */ new Date()).toISOString()).run();
  await env.DB.prepare(`
    delete from password_key_releases
    where user_id = ? and rowid not in (
      select rowid from password_key_releases where user_id = ? order by released_at desc limit 200
    )
  `).bind(userId, userId).run();
}
__name(recordRelease, "recordRelease");
async function releaseKey(env, userId, body, reset) {
  const deviceId = typeof body?.deviceId === "string" && DEVICE_ID_PATTERN.test(body.deviceId) ? body.deviceId : null;
  const machineKind = typeof body?.machineKind === "string" && MACHINE_KINDS.has(body.machineKind) ? body.machineKind : null;
  if (!deviceId || !machineKind) return badRequest("deviceId and machineKind required");
  const existing = reset ? null : await env.DB.prepare("select wrapped_dek, epoch from password_keys where user_id = ?").bind(userId).first();
  let dek;
  let epoch2;
  if (existing) {
    const opened = await keyService(env, "/v1/unwrap", { accountId: userId, wrappedDek: existing.wrapped_dek });
    if (!opened?.dek) return unavailable();
    dek = opened.dek;
    epoch2 = existing.epoch;
  } else {
    const created = await keyService(env, "/v1/create", { accountId: userId });
    if (!created?.dek || !created.wrappedDek) return unavailable();
    const previous = await env.DB.prepare("select epoch from password_keys where user_id = ?").bind(userId).first();
    epoch2 = (previous?.epoch ?? 0) + 1;
    if (reset) {
      await env.DB.batch([
        env.DB.prepare(`
          insert into password_keys(user_id, wrapped_dek, epoch, created_at) values (?, ?, ?, ?)
          on conflict(user_id) do update set wrapped_dek = excluded.wrapped_dek, epoch = excluded.epoch, created_at = excluded.created_at
        `).bind(userId, created.wrappedDek, epoch2, (/* @__PURE__ */ new Date()).toISOString()),
        env.DB.prepare(`
          update password_items
          set ciphertext = '', deleted = 1, updated_at = ${NEXT_UPDATED_AT2}
          where user_id = ? and deleted = 0
        `).bind((/* @__PURE__ */ new Date()).toISOString(), (/* @__PURE__ */ new Date()).toISOString(), userId)
      ]);
      dek = created.dek;
    } else {
      await env.DB.prepare(`
        insert into password_keys(user_id, wrapped_dek, epoch, created_at) values (?, ?, ?, ?)
        on conflict(user_id) do nothing
      `).bind(userId, created.wrappedDek, epoch2, (/* @__PURE__ */ new Date()).toISOString()).run();
      const winner = await env.DB.prepare("select wrapped_dek, epoch from password_keys where user_id = ?").bind(userId).first();
      if (!winner) return unavailable();
      if (winner.wrapped_dek === created.wrappedDek) {
        dek = created.dek;
      } else {
        const opened = await keyService(env, "/v1/unwrap", { accountId: userId, wrappedDek: winner.wrapped_dek });
        if (!opened?.dek) return unavailable();
        dek = opened.dek;
      }
      epoch2 = winner.epoch;
    }
  }
  await recordRelease(env, userId, deviceId, machineKind);
  return json({ ok: true, dek, epoch: epoch2 });
}
__name(releaseKey, "releaseKey");
async function handleReleases(env, userId) {
  const rows = await env.DB.prepare(`
    select device_id, machine_kind, released_at from password_key_releases
    where user_id = ? order by released_at desc limit 100
  `).bind(userId).all();
  return json({
    ok: true,
    releases: rows.results.map((row) => ({ deviceId: row.device_id, machineKind: row.machine_kind, at: row.released_at }))
  });
}
__name(handleReleases, "handleReleases");
async function handlePasswordsRoute(request, env, url, userId, route) {
  if (route[0] !== "passwords") return null;
  const tail = route.slice(1).join("/");
  if (tail === "items" && request.method === "GET") return await handleRead3(env, userId, url);
  if (tail === "items" && request.method === "PUT") return await handleWrite3(request, env, userId);
  if (tail === "key" && request.method === "POST") return await releaseKey(env, userId, await readBody(request), false);
  if (tail === "reset" && request.method === "POST") {
    const body = await readBody(request);
    if (body?.confirm !== "reset") return badRequest("confirm required");
    return await releaseKey(env, userId, body, true);
  }
  if (tail === "releases" && request.method === "GET") return await handleReleases(env, userId);
  return null;
}
__name(handlePasswordsRoute, "handlePasswordsRoute");

// src/attentionAuth.ts
init_modules_watch_stub();

// node_modules/jose/dist/webapi/index.js
init_modules_watch_stub();

// node_modules/jose/dist/webapi/util/base64url.js
init_modules_watch_stub();

// node_modules/jose/dist/webapi/lib/buffer_utils.js
init_modules_watch_stub();
var encoder2 = new TextEncoder();
var decoder = new TextDecoder();
var MAX_INT32 = 2 ** 32;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0);
  const buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers) {
    buf.set(buffer, i);
    i += buffer.length;
  }
  return buf;
}
__name(concat, "concat");
function encode(string) {
  const bytes = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);
    if (code > 127) {
      throw new TypeError("non-ASCII string encountered in encode()");
    }
    bytes[i] = code;
  }
  return bytes;
}
__name(encode, "encode");

// node_modules/jose/dist/webapi/lib/base64.js
init_modules_watch_stub();
function decodeBase64(encoded) {
  if (Uint8Array.fromBase64) {
    return Uint8Array.fromBase64(encoded);
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
__name(decodeBase64, "decodeBase64");

// node_modules/jose/dist/webapi/util/base64url.js
function decode(input) {
  if (Uint8Array.fromBase64) {
    return Uint8Array.fromBase64(typeof input === "string" ? input : decoder.decode(input), {
      alphabet: "base64url"
    });
  }
  let encoded = input;
  if (encoded instanceof Uint8Array) {
    encoded = decoder.decode(encoded);
  }
  encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeBase64(encoded);
  } catch {
    throw new TypeError("The input to be decoded is not correctly encoded.");
  }
}
__name(decode, "decode");

// node_modules/jose/dist/webapi/lib/crypto_key.js
init_modules_watch_stub();
var unusable = /* @__PURE__ */ __name((name, prop = "algorithm.name") => new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`), "unusable");
var isAlgorithm = /* @__PURE__ */ __name((algorithm, name) => algorithm.name === name, "isAlgorithm");
function getHashLength(hash) {
  return parseInt(hash.name.slice(4), 10);
}
__name(getHashLength, "getHashLength");
function checkHashLength(algorithm, expected) {
  const actual = getHashLength(algorithm.hash);
  if (actual !== expected)
    throw unusable(`SHA-${expected}`, "algorithm.hash");
}
__name(checkHashLength, "checkHashLength");
function getNamedCurve(alg) {
  switch (alg) {
    case "ES256":
      return "P-256";
    case "ES384":
      return "P-384";
    case "ES512":
      return "P-521";
    default:
      throw new Error("unreachable");
  }
}
__name(getNamedCurve, "getNamedCurve");
function checkUsage(key, usage) {
  if (usage && !key.usages.includes(usage)) {
    throw new TypeError(`CryptoKey does not support this operation, its usages must include ${usage}.`);
  }
}
__name(checkUsage, "checkUsage");
function checkSigCryptoKey(key, alg, usage) {
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512": {
      if (!isAlgorithm(key.algorithm, "HMAC"))
        throw unusable("HMAC");
      checkHashLength(key.algorithm, parseInt(alg.slice(2), 10));
      break;
    }
    case "RS256":
    case "RS384":
    case "RS512": {
      if (!isAlgorithm(key.algorithm, "RSASSA-PKCS1-v1_5"))
        throw unusable("RSASSA-PKCS1-v1_5");
      checkHashLength(key.algorithm, parseInt(alg.slice(2), 10));
      break;
    }
    case "PS256":
    case "PS384":
    case "PS512": {
      if (!isAlgorithm(key.algorithm, "RSA-PSS"))
        throw unusable("RSA-PSS");
      checkHashLength(key.algorithm, parseInt(alg.slice(2), 10));
      break;
    }
    case "Ed25519":
    case "EdDSA": {
      if (!isAlgorithm(key.algorithm, "Ed25519"))
        throw unusable("Ed25519");
      break;
    }
    case "ML-DSA-44":
    case "ML-DSA-65":
    case "ML-DSA-87": {
      if (!isAlgorithm(key.algorithm, alg))
        throw unusable(alg);
      break;
    }
    case "ES256":
    case "ES384":
    case "ES512": {
      if (!isAlgorithm(key.algorithm, "ECDSA"))
        throw unusable("ECDSA");
      const expected = getNamedCurve(alg);
      const actual = key.algorithm.namedCurve;
      if (actual !== expected)
        throw unusable(expected, "algorithm.namedCurve");
      break;
    }
    default:
      throw new TypeError("CryptoKey does not support this operation");
  }
  checkUsage(key, usage);
}
__name(checkSigCryptoKey, "checkSigCryptoKey");

// node_modules/jose/dist/webapi/lib/invalid_key_input.js
init_modules_watch_stub();
function message(msg, actual, ...types) {
  types = types.filter(Boolean);
  if (types.length > 2) {
    const last = types.pop();
    msg += `one of type ${types.join(", ")}, or ${last}.`;
  } else if (types.length === 2) {
    msg += `one of type ${types[0]} or ${types[1]}.`;
  } else {
    msg += `of type ${types[0]}.`;
  }
  if (actual == null) {
    msg += ` Received ${actual}`;
  } else if (typeof actual === "function" && actual.name) {
    msg += ` Received function ${actual.name}`;
  } else if (typeof actual === "object" && actual != null) {
    if (actual.constructor?.name) {
      msg += ` Received an instance of ${actual.constructor.name}`;
    }
  }
  return msg;
}
__name(message, "message");
var invalidKeyInput = /* @__PURE__ */ __name((actual, ...types) => message("Key must be ", actual, ...types), "invalidKeyInput");
var withAlg = /* @__PURE__ */ __name((alg, actual, ...types) => message(`Key for the ${alg} algorithm must be `, actual, ...types), "withAlg");

// node_modules/jose/dist/webapi/util/errors.js
var errors_exports = {};
__export(errors_exports, {
  JOSEAlgNotAllowed: () => JOSEAlgNotAllowed,
  JOSEError: () => JOSEError,
  JOSENotSupported: () => JOSENotSupported,
  JWEDecryptionFailed: () => JWEDecryptionFailed,
  JWEInvalid: () => JWEInvalid,
  JWKInvalid: () => JWKInvalid,
  JWKSInvalid: () => JWKSInvalid,
  JWKSMultipleMatchingKeys: () => JWKSMultipleMatchingKeys,
  JWKSNoMatchingKey: () => JWKSNoMatchingKey,
  JWKSTimeout: () => JWKSTimeout,
  JWSInvalid: () => JWSInvalid,
  JWSSignatureVerificationFailed: () => JWSSignatureVerificationFailed,
  JWTClaimValidationFailed: () => JWTClaimValidationFailed,
  JWTExpired: () => JWTExpired,
  JWTInvalid: () => JWTInvalid
});
init_modules_watch_stub();
var JOSEError = class extends Error {
  static {
    __name(this, "JOSEError");
  }
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message2, options) {
    super(message2, options);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
};
var JWTClaimValidationFailed = class extends JOSEError {
  static {
    __name(this, "JWTClaimValidationFailed");
  }
  static code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } });
    this.claim = claim;
    this.reason = reason;
    this.payload = payload;
  }
};
var JWTExpired = class extends JOSEError {
  static {
    __name(this, "JWTExpired");
  }
  static code = "ERR_JWT_EXPIRED";
  code = "ERR_JWT_EXPIRED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } });
    this.claim = claim;
    this.reason = reason;
    this.payload = payload;
  }
};
var JOSEAlgNotAllowed = class extends JOSEError {
  static {
    __name(this, "JOSEAlgNotAllowed");
  }
  static code = "ERR_JOSE_ALG_NOT_ALLOWED";
  code = "ERR_JOSE_ALG_NOT_ALLOWED";
};
var JOSENotSupported = class extends JOSEError {
  static {
    __name(this, "JOSENotSupported");
  }
  static code = "ERR_JOSE_NOT_SUPPORTED";
  code = "ERR_JOSE_NOT_SUPPORTED";
};
var JWEDecryptionFailed = class extends JOSEError {
  static {
    __name(this, "JWEDecryptionFailed");
  }
  static code = "ERR_JWE_DECRYPTION_FAILED";
  code = "ERR_JWE_DECRYPTION_FAILED";
  constructor(message2 = "decryption operation failed", options) {
    super(message2, options);
  }
};
var JWEInvalid = class extends JOSEError {
  static {
    __name(this, "JWEInvalid");
  }
  static code = "ERR_JWE_INVALID";
  code = "ERR_JWE_INVALID";
};
var JWSInvalid = class extends JOSEError {
  static {
    __name(this, "JWSInvalid");
  }
  static code = "ERR_JWS_INVALID";
  code = "ERR_JWS_INVALID";
};
var JWTInvalid = class extends JOSEError {
  static {
    __name(this, "JWTInvalid");
  }
  static code = "ERR_JWT_INVALID";
  code = "ERR_JWT_INVALID";
};
var JWKInvalid = class extends JOSEError {
  static {
    __name(this, "JWKInvalid");
  }
  static code = "ERR_JWK_INVALID";
  code = "ERR_JWK_INVALID";
};
var JWKSInvalid = class extends JOSEError {
  static {
    __name(this, "JWKSInvalid");
  }
  static code = "ERR_JWKS_INVALID";
  code = "ERR_JWKS_INVALID";
};
var JWKSNoMatchingKey = class extends JOSEError {
  static {
    __name(this, "JWKSNoMatchingKey");
  }
  static code = "ERR_JWKS_NO_MATCHING_KEY";
  code = "ERR_JWKS_NO_MATCHING_KEY";
  constructor(message2 = "no applicable key found in the JSON Web Key Set", options) {
    super(message2, options);
  }
};
var JWKSMultipleMatchingKeys = class extends JOSEError {
  static {
    __name(this, "JWKSMultipleMatchingKeys");
  }
  [Symbol.asyncIterator];
  static code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  constructor(message2 = "multiple matching keys found in the JSON Web Key Set", options) {
    super(message2, options);
  }
};
var JWKSTimeout = class extends JOSEError {
  static {
    __name(this, "JWKSTimeout");
  }
  static code = "ERR_JWKS_TIMEOUT";
  code = "ERR_JWKS_TIMEOUT";
  constructor(message2 = "request timed out", options) {
    super(message2, options);
  }
};
var JWSSignatureVerificationFailed = class extends JOSEError {
  static {
    __name(this, "JWSSignatureVerificationFailed");
  }
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message2 = "signature verification failed", options) {
    super(message2, options);
  }
};

// node_modules/jose/dist/webapi/lib/is_key_like.js
init_modules_watch_stub();
var isCryptoKey = /* @__PURE__ */ __name((key) => {
  if (key?.[Symbol.toStringTag] === "CryptoKey")
    return true;
  try {
    return key instanceof CryptoKey;
  } catch {
    return false;
  }
}, "isCryptoKey");
var isKeyObject = /* @__PURE__ */ __name((key) => key?.[Symbol.toStringTag] === "KeyObject", "isKeyObject");
var isKeyLike = /* @__PURE__ */ __name((key) => isCryptoKey(key) || isKeyObject(key), "isKeyLike");

// node_modules/jose/dist/webapi/lib/helpers.js
init_modules_watch_stub();
function decodeBase64url(value, label, ErrorClass) {
  try {
    return decode(value);
  } catch {
    throw new ErrorClass(`Failed to base64url decode the ${label}`);
  }
}
__name(decodeBase64url, "decodeBase64url");

// node_modules/jose/dist/webapi/lib/type_checks.js
init_modules_watch_stub();
var isObjectLike2 = /* @__PURE__ */ __name((value) => typeof value === "object" && value !== null, "isObjectLike");
function isObject(input) {
  if (!isObjectLike2(input) || Object.prototype.toString.call(input) !== "[object Object]") {
    return false;
  }
  if (Object.getPrototypeOf(input) === null) {
    return true;
  }
  let proto = input;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(input) === proto;
}
__name(isObject, "isObject");
function isDisjoint(...headers) {
  const sources = headers.filter(Boolean);
  if (sources.length === 0 || sources.length === 1) {
    return true;
  }
  let acc;
  for (const header of sources) {
    const parameters = Object.keys(header);
    if (!acc || acc.size === 0) {
      acc = new Set(parameters);
      continue;
    }
    for (const parameter of parameters) {
      if (acc.has(parameter)) {
        return false;
      }
      acc.add(parameter);
    }
  }
  return true;
}
__name(isDisjoint, "isDisjoint");
var isJWK = /* @__PURE__ */ __name((key) => isObject(key) && typeof key.kty === "string", "isJWK");
var isPrivateJWK = /* @__PURE__ */ __name((key) => key.kty !== "oct" && (key.kty === "AKP" && typeof key.priv === "string" || typeof key.d === "string"), "isPrivateJWK");
var isPublicJWK = /* @__PURE__ */ __name((key) => key.kty !== "oct" && key.d === void 0 && key.priv === void 0, "isPublicJWK");
var isSecretJWK = /* @__PURE__ */ __name((key) => key.kty === "oct" && typeof key.k === "string", "isSecretJWK");

// node_modules/jose/dist/webapi/lib/signing.js
init_modules_watch_stub();
function checkKeyLength(alg, key) {
  if (alg.startsWith("RS") || alg.startsWith("PS")) {
    const { modulusLength } = key.algorithm;
    if (typeof modulusLength !== "number" || modulusLength < 2048) {
      throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
    }
  }
}
__name(checkKeyLength, "checkKeyLength");
function subtleAlgorithm(alg, algorithm) {
  const hash = `SHA-${alg.slice(-3)}`;
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512":
      return { hash, name: "HMAC" };
    case "PS256":
    case "PS384":
    case "PS512":
      return { hash, name: "RSA-PSS", saltLength: parseInt(alg.slice(-3), 10) >> 3 };
    case "RS256":
    case "RS384":
    case "RS512":
      return { hash, name: "RSASSA-PKCS1-v1_5" };
    case "ES256":
    case "ES384":
    case "ES512":
      return { hash, name: "ECDSA", namedCurve: algorithm.namedCurve };
    case "Ed25519":
    case "EdDSA":
      return { name: "Ed25519" };
    case "ML-DSA-44":
    case "ML-DSA-65":
    case "ML-DSA-87":
      return { name: alg };
    default:
      throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  }
}
__name(subtleAlgorithm, "subtleAlgorithm");
async function getSigKey(alg, key, usage) {
  if (key instanceof Uint8Array) {
    if (!alg.startsWith("HS")) {
      throw new TypeError(invalidKeyInput(key, "CryptoKey", "KeyObject", "JSON Web Key"));
    }
    return crypto.subtle.importKey("raw", key, { hash: `SHA-${alg.slice(-3)}`, name: "HMAC" }, false, [usage]);
  }
  checkSigCryptoKey(key, alg, usage);
  return key;
}
__name(getSigKey, "getSigKey");
async function verify(alg, key, signature, data) {
  const cryptoKey = await getSigKey(alg, key, "verify");
  checkKeyLength(alg, cryptoKey);
  const algorithm = subtleAlgorithm(alg, cryptoKey.algorithm);
  try {
    return await crypto.subtle.verify(algorithm, cryptoKey, signature, data);
  } catch {
    return false;
  }
}
__name(verify, "verify");

// node_modules/jose/dist/webapi/lib/normalize_key.js
init_modules_watch_stub();

// node_modules/jose/dist/webapi/lib/jwk_to_key.js
init_modules_watch_stub();
var unsupportedAlg = 'Invalid or unsupported JWK "alg" (Algorithm) Parameter value';
function subtleMapping(jwk) {
  let algorithm;
  let keyUsages;
  switch (jwk.kty) {
    case "AKP": {
      switch (jwk.alg) {
        case "ML-DSA-44":
        case "ML-DSA-65":
        case "ML-DSA-87":
          algorithm = { name: jwk.alg };
          keyUsages = jwk.priv ? ["sign"] : ["verify"];
          break;
        default:
          throw new JOSENotSupported(unsupportedAlg);
      }
      break;
    }
    case "RSA": {
      switch (jwk.alg) {
        case "PS256":
        case "PS384":
        case "PS512":
          algorithm = { name: "RSA-PSS", hash: `SHA-${jwk.alg.slice(-3)}` };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "RS256":
        case "RS384":
        case "RS512":
          algorithm = { name: "RSASSA-PKCS1-v1_5", hash: `SHA-${jwk.alg.slice(-3)}` };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "RSA-OAEP":
        case "RSA-OAEP-256":
        case "RSA-OAEP-384":
        case "RSA-OAEP-512":
          algorithm = {
            name: "RSA-OAEP",
            hash: `SHA-${parseInt(jwk.alg.slice(-3), 10) || 1}`
          };
          keyUsages = jwk.d ? ["decrypt", "unwrapKey"] : ["encrypt", "wrapKey"];
          break;
        default:
          throw new JOSENotSupported(unsupportedAlg);
      }
      break;
    }
    case "EC": {
      switch (jwk.alg) {
        case "ES256":
        case "ES384":
        case "ES512":
          algorithm = {
            name: "ECDSA",
            namedCurve: { ES256: "P-256", ES384: "P-384", ES512: "P-521" }[jwk.alg]
          };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ECDH-ES":
        case "ECDH-ES+A128KW":
        case "ECDH-ES+A192KW":
        case "ECDH-ES+A256KW":
          algorithm = { name: "ECDH", namedCurve: jwk.crv };
          keyUsages = jwk.d ? ["deriveBits"] : [];
          break;
        default:
          throw new JOSENotSupported(unsupportedAlg);
      }
      break;
    }
    case "OKP": {
      switch (jwk.alg) {
        case "Ed25519":
        case "EdDSA":
          algorithm = { name: "Ed25519" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ECDH-ES":
        case "ECDH-ES+A128KW":
        case "ECDH-ES+A192KW":
        case "ECDH-ES+A256KW":
          algorithm = { name: jwk.crv };
          keyUsages = jwk.d ? ["deriveBits"] : [];
          break;
        default:
          throw new JOSENotSupported(unsupportedAlg);
      }
      break;
    }
    default:
      throw new JOSENotSupported('Invalid or unsupported JWK "kty" (Key Type) Parameter value');
  }
  return { algorithm, keyUsages };
}
__name(subtleMapping, "subtleMapping");
async function jwkToKey(jwk) {
  if (!jwk.alg) {
    throw new TypeError('"alg" argument is required when "jwk.alg" is not present');
  }
  const { algorithm, keyUsages } = subtleMapping(jwk);
  const keyData = { ...jwk };
  if (keyData.kty !== "AKP") {
    delete keyData.alg;
  }
  delete keyData.use;
  return crypto.subtle.importKey("jwk", keyData, algorithm, jwk.ext ?? (jwk.d || jwk.priv ? false : true), jwk.key_ops ?? keyUsages);
}
__name(jwkToKey, "jwkToKey");

// node_modules/jose/dist/webapi/lib/normalize_key.js
var unusableForAlg = "given KeyObject instance cannot be used for this algorithm";
var cache;
var handleJWK = /* @__PURE__ */ __name(async (key, jwk, alg, freeze = false) => {
  cache ||= /* @__PURE__ */ new WeakMap();
  let cached = cache.get(key);
  if (cached?.[alg]) {
    return cached[alg];
  }
  const cryptoKey = await jwkToKey({ ...jwk, alg });
  if (freeze)
    Object.freeze(key);
  if (!cached) {
    cache.set(key, { [alg]: cryptoKey });
  } else {
    cached[alg] = cryptoKey;
  }
  return cryptoKey;
}, "handleJWK");
var handleKeyObject = /* @__PURE__ */ __name((keyObject, alg) => {
  cache ||= /* @__PURE__ */ new WeakMap();
  let cached = cache.get(keyObject);
  if (cached?.[alg]) {
    return cached[alg];
  }
  const isPublic = keyObject.type === "public";
  const extractable = isPublic ? true : false;
  let cryptoKey;
  if (keyObject.asymmetricKeyType === "x25519") {
    switch (alg) {
      case "ECDH-ES":
      case "ECDH-ES+A128KW":
      case "ECDH-ES+A192KW":
      case "ECDH-ES+A256KW":
        break;
      default:
        throw new TypeError(unusableForAlg);
    }
    cryptoKey = keyObject.toCryptoKey(keyObject.asymmetricKeyType, extractable, isPublic ? [] : ["deriveBits"]);
  }
  if (keyObject.asymmetricKeyType === "ed25519") {
    if (alg !== "EdDSA" && alg !== "Ed25519") {
      throw new TypeError(unusableForAlg);
    }
    cryptoKey = keyObject.toCryptoKey(keyObject.asymmetricKeyType, extractable, [
      isPublic ? "verify" : "sign"
    ]);
  }
  switch (keyObject.asymmetricKeyType) {
    case "ml-dsa-44":
    case "ml-dsa-65":
    case "ml-dsa-87": {
      if (alg !== keyObject.asymmetricKeyType.toUpperCase()) {
        throw new TypeError(unusableForAlg);
      }
      cryptoKey = keyObject.toCryptoKey(keyObject.asymmetricKeyType, extractable, [
        isPublic ? "verify" : "sign"
      ]);
    }
  }
  if (keyObject.asymmetricKeyType === "rsa") {
    let hash;
    switch (alg) {
      case "RSA-OAEP":
        hash = "SHA-1";
        break;
      case "RS256":
      case "PS256":
      case "RSA-OAEP-256":
        hash = "SHA-256";
        break;
      case "RS384":
      case "PS384":
      case "RSA-OAEP-384":
        hash = "SHA-384";
        break;
      case "RS512":
      case "PS512":
      case "RSA-OAEP-512":
        hash = "SHA-512";
        break;
      default:
        throw new TypeError(unusableForAlg);
    }
    if (alg.startsWith("RSA-OAEP")) {
      return keyObject.toCryptoKey({
        name: "RSA-OAEP",
        hash
      }, extractable, isPublic ? ["encrypt"] : ["decrypt"]);
    }
    cryptoKey = keyObject.toCryptoKey({
      name: alg.startsWith("PS") ? "RSA-PSS" : "RSASSA-PKCS1-v1_5",
      hash
    }, extractable, [isPublic ? "verify" : "sign"]);
  }
  if (keyObject.asymmetricKeyType === "ec") {
    const nist = /* @__PURE__ */ new Map([
      ["prime256v1", "P-256"],
      ["secp384r1", "P-384"],
      ["secp521r1", "P-521"]
    ]);
    const namedCurve = nist.get(keyObject.asymmetricKeyDetails?.namedCurve);
    if (!namedCurve) {
      throw new TypeError(unusableForAlg);
    }
    const expectedCurve = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };
    if (expectedCurve[alg] && namedCurve === expectedCurve[alg]) {
      cryptoKey = keyObject.toCryptoKey({
        name: "ECDSA",
        namedCurve
      }, extractable, [isPublic ? "verify" : "sign"]);
    }
    if (alg.startsWith("ECDH-ES")) {
      cryptoKey = keyObject.toCryptoKey({
        name: "ECDH",
        namedCurve
      }, extractable, isPublic ? [] : ["deriveBits"]);
    }
  }
  if (!cryptoKey) {
    throw new TypeError(unusableForAlg);
  }
  if (!cached) {
    cache.set(keyObject, { [alg]: cryptoKey });
  } else {
    cached[alg] = cryptoKey;
  }
  return cryptoKey;
}, "handleKeyObject");
async function normalizeKey(key, alg) {
  if (key instanceof Uint8Array) {
    return key;
  }
  if (isCryptoKey(key)) {
    return key;
  }
  if (isKeyObject(key)) {
    if (key.type === "secret") {
      return key.export();
    }
    if ("toCryptoKey" in key && typeof key.toCryptoKey === "function") {
      try {
        return handleKeyObject(key, alg);
      } catch (err) {
        if (err instanceof TypeError) {
          throw err;
        }
      }
    }
    let jwk = key.export({ format: "jwk" });
    return handleJWK(key, jwk, alg);
  }
  if (isJWK(key)) {
    if (key.k) {
      return decode(key.k);
    }
    return handleJWK(key, key, alg, true);
  }
  throw new Error("unreachable");
}
__name(normalizeKey, "normalizeKey");

// node_modules/jose/dist/webapi/key/import.js
init_modules_watch_stub();
async function importJWK(jwk, alg, options) {
  if (!isObject(jwk)) {
    throw new TypeError("JWK must be an object");
  }
  let ext;
  alg ??= jwk.alg;
  ext ??= options?.extractable ?? jwk.ext;
  switch (jwk.kty) {
    case "oct":
      if (typeof jwk.k !== "string" || !jwk.k) {
        throw new TypeError('missing "k" (Key Value) Parameter value');
      }
      return decode(jwk.k);
    case "RSA":
      if ("oth" in jwk && jwk.oth !== void 0) {
        throw new JOSENotSupported('RSA JWK "oth" (Other Primes Info) Parameter value is not supported');
      }
      return jwkToKey({ ...jwk, alg, ext });
    case "AKP": {
      if (typeof jwk.alg !== "string" || !jwk.alg) {
        throw new TypeError('missing "alg" (Algorithm) Parameter value');
      }
      if (alg !== void 0 && alg !== jwk.alg) {
        throw new TypeError("JWK alg and alg option value mismatch");
      }
      return jwkToKey({ ...jwk, ext });
    }
    case "EC":
    case "OKP":
      return jwkToKey({ ...jwk, alg, ext });
    default:
      throw new JOSENotSupported('Unsupported "kty" (Key Type) Parameter value');
  }
}
__name(importJWK, "importJWK");

// node_modules/jose/dist/webapi/lib/validate_crit.js
init_modules_watch_stub();
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0) {
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  }
  if (!protectedHeader || protectedHeader.crit === void 0) {
    return /* @__PURE__ */ new Set();
  }
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input !== "string" || input.length === 0)) {
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  }
  let recognized;
  if (recognizedOption !== void 0) {
    recognized = new Map([...Object.entries(recognizedOption), ...recognizedDefault.entries()]);
  } else {
    recognized = recognizedDefault;
  }
  for (const parameter of protectedHeader.crit) {
    if (!recognized.has(parameter)) {
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    }
    if (joseHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    }
    if (recognized.get(parameter) && protectedHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
    }
  }
  return new Set(protectedHeader.crit);
}
__name(validateCrit, "validateCrit");

// node_modules/jose/dist/webapi/lib/validate_algorithms.js
init_modules_watch_stub();
function validateAlgorithms(option, algorithms) {
  if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s !== "string"))) {
    throw new TypeError(`"${option}" option must be an array of strings`);
  }
  if (!algorithms) {
    return void 0;
  }
  return new Set(algorithms);
}
__name(validateAlgorithms, "validateAlgorithms");

// node_modules/jose/dist/webapi/lib/check_key_type.js
init_modules_watch_stub();
var tag = /* @__PURE__ */ __name((key) => key?.[Symbol.toStringTag], "tag");
var jwkMatchesOp = /* @__PURE__ */ __name((alg, key, usage) => {
  if (key.use !== void 0) {
    let expected;
    switch (usage) {
      case "sign":
      case "verify":
        expected = "sig";
        break;
      case "encrypt":
      case "decrypt":
        expected = "enc";
        break;
    }
    if (key.use !== expected) {
      throw new TypeError(`Invalid key for this operation, its "use" must be "${expected}" when present`);
    }
  }
  if (key.alg !== void 0 && key.alg !== alg) {
    throw new TypeError(`Invalid key for this operation, its "alg" must be "${alg}" when present`);
  }
  if (Array.isArray(key.key_ops)) {
    let expectedKeyOp;
    switch (true) {
      case (usage === "sign" || usage === "verify"):
      case alg === "dir":
      case alg.includes("CBC-HS"):
        expectedKeyOp = usage;
        break;
      case alg.startsWith("PBES2"):
        expectedKeyOp = "deriveBits";
        break;
      case /^A\d{3}(?:GCM)?(?:KW)?$/.test(alg):
        if (!alg.includes("GCM") && alg.endsWith("KW")) {
          expectedKeyOp = usage === "encrypt" ? "wrapKey" : "unwrapKey";
        } else {
          expectedKeyOp = usage;
        }
        break;
      case (usage === "encrypt" && alg.startsWith("RSA")):
        expectedKeyOp = "wrapKey";
        break;
      case usage === "decrypt":
        expectedKeyOp = alg.startsWith("RSA") ? "unwrapKey" : "deriveBits";
        break;
    }
    if (expectedKeyOp && key.key_ops?.includes?.(expectedKeyOp) === false) {
      throw new TypeError(`Invalid key for this operation, its "key_ops" must include "${expectedKeyOp}" when present`);
    }
  }
  return true;
}, "jwkMatchesOp");
var symmetricTypeCheck = /* @__PURE__ */ __name((alg, key, usage) => {
  if (key instanceof Uint8Array)
    return;
  if (isJWK(key)) {
    if (isSecretJWK(key) && jwkMatchesOp(alg, key, usage))
      return;
    throw new TypeError(`JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present`);
  }
  if (!isKeyLike(key)) {
    throw new TypeError(withAlg(alg, key, "CryptoKey", "KeyObject", "JSON Web Key", "Uint8Array"));
  }
  if (key.type !== "secret") {
    throw new TypeError(`${tag(key)} instances for symmetric algorithms must be of type "secret"`);
  }
}, "symmetricTypeCheck");
var asymmetricTypeCheck = /* @__PURE__ */ __name((alg, key, usage) => {
  if (isJWK(key)) {
    switch (usage) {
      case "decrypt":
      case "sign":
        if (isPrivateJWK(key) && jwkMatchesOp(alg, key, usage))
          return;
        throw new TypeError(`JSON Web Key for this operation must be a private JWK`);
      case "encrypt":
      case "verify":
        if (isPublicJWK(key) && jwkMatchesOp(alg, key, usage))
          return;
        throw new TypeError(`JSON Web Key for this operation must be a public JWK`);
    }
  }
  if (!isKeyLike(key)) {
    throw new TypeError(withAlg(alg, key, "CryptoKey", "KeyObject", "JSON Web Key"));
  }
  if (key.type === "secret") {
    throw new TypeError(`${tag(key)} instances for asymmetric algorithms must not be of type "secret"`);
  }
  if (key.type === "public") {
    switch (usage) {
      case "sign":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm signing must be of type "private"`);
      case "decrypt":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm decryption must be of type "private"`);
    }
  }
  if (key.type === "private") {
    switch (usage) {
      case "verify":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm verifying must be of type "public"`);
      case "encrypt":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm encryption must be of type "public"`);
    }
  }
}, "asymmetricTypeCheck");
function checkKeyType(alg, key, usage) {
  switch (alg.substring(0, 2)) {
    case "A1":
    case "A2":
    case "di":
    case "HS":
    case "PB":
      symmetricTypeCheck(alg, key, usage);
      break;
    default:
      asymmetricTypeCheck(alg, key, usage);
  }
}
__name(checkKeyType, "checkKeyType");

// node_modules/jose/dist/webapi/jws/compact/verify.js
init_modules_watch_stub();

// node_modules/jose/dist/webapi/jws/flattened/verify.js
init_modules_watch_stub();
async function flattenedVerify(jws, key, options) {
  if (!isObject(jws)) {
    throw new JWSInvalid("Flattened JWS must be an object");
  }
  if (jws.protected === void 0 && jws.header === void 0) {
    throw new JWSInvalid('Flattened JWS must have either of the "protected" or "header" members');
  }
  if (jws.protected !== void 0 && typeof jws.protected !== "string") {
    throw new JWSInvalid("JWS Protected Header incorrect type");
  }
  if (jws.payload === void 0) {
    throw new JWSInvalid("JWS Payload missing");
  }
  if (typeof jws.signature !== "string") {
    throw new JWSInvalid("JWS Signature missing or incorrect type");
  }
  if (jws.header !== void 0 && !isObject(jws.header)) {
    throw new JWSInvalid("JWS Unprotected Header incorrect type");
  }
  let parsedProt = {};
  if (jws.protected) {
    try {
      const protectedHeader = decode(jws.protected);
      parsedProt = JSON.parse(decoder.decode(protectedHeader));
    } catch {
      throw new JWSInvalid("JWS Protected Header is invalid");
    }
  }
  if (!isDisjoint(parsedProt, jws.header)) {
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  }
  const joseHeader = {
    ...parsedProt,
    ...jws.header
  };
  const extensions = validateCrit(JWSInvalid, /* @__PURE__ */ new Map([["b64", true]]), options?.crit, parsedProt, joseHeader);
  let b64 = true;
  if (extensions.has("b64")) {
    b64 = parsedProt.b64;
    if (typeof b64 !== "boolean") {
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    }
  }
  const { alg } = joseHeader;
  if (typeof alg !== "string" || !alg) {
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  }
  const algorithms = options && validateAlgorithms("algorithms", options.algorithms);
  if (algorithms && !algorithms.has(alg)) {
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  }
  if (b64) {
    if (typeof jws.payload !== "string") {
      throw new JWSInvalid("JWS Payload must be a string");
    }
  } else if (typeof jws.payload !== "string" && !(jws.payload instanceof Uint8Array)) {
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  }
  let resolvedKey = false;
  if (typeof key === "function") {
    key = await key(parsedProt, jws);
    resolvedKey = true;
  }
  checkKeyType(alg, key, "verify");
  const data = concat(jws.protected !== void 0 ? encode(jws.protected) : new Uint8Array(), encode("."), typeof jws.payload === "string" ? b64 ? encode(jws.payload) : encoder2.encode(jws.payload) : jws.payload);
  const signature = decodeBase64url(jws.signature, "signature", JWSInvalid);
  const k = await normalizeKey(key, alg);
  const verified = await verify(alg, k, signature, data);
  if (!verified) {
    throw new JWSSignatureVerificationFailed();
  }
  let payload;
  if (b64) {
    payload = decodeBase64url(jws.payload, "payload", JWSInvalid);
  } else if (typeof jws.payload === "string") {
    payload = encoder2.encode(jws.payload);
  } else {
    payload = jws.payload;
  }
  const result = { payload };
  if (jws.protected !== void 0) {
    result.protectedHeader = parsedProt;
  }
  if (jws.header !== void 0) {
    result.unprotectedHeader = jws.header;
  }
  if (resolvedKey) {
    return { ...result, key: k };
  }
  return result;
}
__name(flattenedVerify, "flattenedVerify");

// node_modules/jose/dist/webapi/jws/compact/verify.js
async function compactVerify(jws, key, options) {
  if (jws instanceof Uint8Array) {
    jws = decoder.decode(jws);
  }
  if (typeof jws !== "string") {
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  }
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3) {
    throw new JWSInvalid("Invalid Compact JWS");
  }
  const verified = await flattenedVerify({ payload, protected: protectedHeader, signature }, key, options);
  const result = { payload: verified.payload, protectedHeader: verified.protectedHeader };
  if (typeof key === "function") {
    return { ...result, key: verified.key };
  }
  return result;
}
__name(compactVerify, "compactVerify");

// node_modules/jose/dist/webapi/jwt/verify.js
init_modules_watch_stub();

// node_modules/jose/dist/webapi/lib/jwt_claims_set.js
init_modules_watch_stub();
var epoch = /* @__PURE__ */ __name((date) => Math.floor(date.getTime() / 1e3), "epoch");
var minute = 60;
var hour = minute * 60;
var day = hour * 24;
var week = day * 7;
var year = day * 365.25;
var REGEX = /^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$/i;
function secs(str) {
  const matched = REGEX.exec(str);
  if (!matched || matched[4] && matched[1]) {
    throw new TypeError("Invalid time period format");
  }
  const value = parseFloat(matched[2]);
  const unit = matched[3].toLowerCase();
  let numericDate;
  switch (unit) {
    case "sec":
    case "secs":
    case "second":
    case "seconds":
    case "s":
      numericDate = Math.round(value);
      break;
    case "minute":
    case "minutes":
    case "min":
    case "mins":
    case "m":
      numericDate = Math.round(value * minute);
      break;
    case "hour":
    case "hours":
    case "hr":
    case "hrs":
    case "h":
      numericDate = Math.round(value * hour);
      break;
    case "day":
    case "days":
    case "d":
      numericDate = Math.round(value * day);
      break;
    case "week":
    case "weeks":
    case "w":
      numericDate = Math.round(value * week);
      break;
    default:
      numericDate = Math.round(value * year);
      break;
  }
  if (matched[1] === "-" || matched[4] === "ago") {
    return -numericDate;
  }
  return numericDate;
}
__name(secs, "secs");
var normalizeTyp = /* @__PURE__ */ __name((value) => {
  if (value.includes("/")) {
    return value.toLowerCase();
  }
  return `application/${value.toLowerCase()}`;
}, "normalizeTyp");
var checkAudiencePresence = /* @__PURE__ */ __name((audPayload, audOption) => {
  if (typeof audPayload === "string") {
    return audOption.includes(audPayload);
  }
  if (Array.isArray(audPayload)) {
    return audOption.some(Set.prototype.has.bind(new Set(audPayload)));
  }
  return false;
}, "checkAudiencePresence");
function validateClaimsSet(protectedHeader, encodedPayload, options = {}) {
  let payload;
  try {
    payload = JSON.parse(decoder.decode(encodedPayload));
  } catch {
  }
  if (!isObject(payload)) {
    throw new JWTInvalid("JWT Claims Set must be a top-level JSON object");
  }
  const { typ } = options;
  if (typ && (typeof protectedHeader.typ !== "string" || normalizeTyp(protectedHeader.typ) !== normalizeTyp(typ))) {
    throw new JWTClaimValidationFailed('unexpected "typ" JWT header value', payload, "typ", "check_failed");
  }
  const { requiredClaims = [], issuer, subject, audience, maxTokenAge } = options;
  const presenceCheck = [...requiredClaims];
  if (maxTokenAge !== void 0)
    presenceCheck.push("iat");
  if (audience !== void 0)
    presenceCheck.push("aud");
  if (subject !== void 0)
    presenceCheck.push("sub");
  if (issuer !== void 0)
    presenceCheck.push("iss");
  for (const claim of new Set(presenceCheck.reverse())) {
    if (!(claim in payload)) {
      throw new JWTClaimValidationFailed(`missing required "${claim}" claim`, payload, claim, "missing");
    }
  }
  if (issuer && !(Array.isArray(issuer) ? issuer : [issuer]).includes(payload.iss)) {
    throw new JWTClaimValidationFailed('unexpected "iss" claim value', payload, "iss", "check_failed");
  }
  if (subject && payload.sub !== subject) {
    throw new JWTClaimValidationFailed('unexpected "sub" claim value', payload, "sub", "check_failed");
  }
  if (audience && !checkAudiencePresence(payload.aud, typeof audience === "string" ? [audience] : audience)) {
    throw new JWTClaimValidationFailed('unexpected "aud" claim value', payload, "aud", "check_failed");
  }
  let tolerance;
  switch (typeof options.clockTolerance) {
    case "string":
      tolerance = secs(options.clockTolerance);
      break;
    case "number":
      tolerance = options.clockTolerance;
      break;
    case "undefined":
      tolerance = 0;
      break;
    default:
      throw new TypeError("Invalid clockTolerance option type");
  }
  const { currentDate } = options;
  const now = epoch(currentDate || /* @__PURE__ */ new Date());
  if ((payload.iat !== void 0 || maxTokenAge) && typeof payload.iat !== "number") {
    throw new JWTClaimValidationFailed('"iat" claim must be a number', payload, "iat", "invalid");
  }
  if (payload.nbf !== void 0) {
    if (typeof payload.nbf !== "number") {
      throw new JWTClaimValidationFailed('"nbf" claim must be a number', payload, "nbf", "invalid");
    }
    if (payload.nbf > now + tolerance) {
      throw new JWTClaimValidationFailed('"nbf" claim timestamp check failed', payload, "nbf", "check_failed");
    }
  }
  if (payload.exp !== void 0) {
    if (typeof payload.exp !== "number") {
      throw new JWTClaimValidationFailed('"exp" claim must be a number', payload, "exp", "invalid");
    }
    if (payload.exp <= now - tolerance) {
      throw new JWTExpired('"exp" claim timestamp check failed', payload, "exp", "check_failed");
    }
  }
  if (maxTokenAge) {
    const age = now - payload.iat;
    const max = typeof maxTokenAge === "number" ? maxTokenAge : secs(maxTokenAge);
    if (age - tolerance > max) {
      throw new JWTExpired('"iat" claim timestamp check failed (too far in the past)', payload, "iat", "check_failed");
    }
    if (age < 0 - tolerance) {
      throw new JWTClaimValidationFailed('"iat" claim timestamp check failed (it should be in the past)', payload, "iat", "check_failed");
    }
  }
  return payload;
}
__name(validateClaimsSet, "validateClaimsSet");

// node_modules/jose/dist/webapi/jwt/verify.js
async function jwtVerify(jwt, key, options) {
  const verified = await compactVerify(jwt, key, options);
  if (verified.protectedHeader.crit?.includes("b64") && verified.protectedHeader.b64 === false) {
    throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
  }
  const payload = validateClaimsSet(verified.protectedHeader, verified.payload, options);
  const result = { payload, protectedHeader: verified.protectedHeader };
  if (typeof key === "function") {
    return { ...result, key: verified.key };
  }
  return result;
}
__name(jwtVerify, "jwtVerify");

// node_modules/jose/dist/webapi/jwks/local.js
init_modules_watch_stub();
function getKtyFromAlg(alg) {
  switch (typeof alg === "string" && alg.slice(0, 2)) {
    case "RS":
    case "PS":
      return "RSA";
    case "ES":
      return "EC";
    case "Ed":
      return "OKP";
    case "ML":
      return "AKP";
    default:
      throw new JOSENotSupported('Unsupported "alg" value for a JSON Web Key Set');
  }
}
__name(getKtyFromAlg, "getKtyFromAlg");
function isJWKSLike(jwks) {
  return jwks && typeof jwks === "object" && Array.isArray(jwks.keys) && jwks.keys.every(isJWKLike);
}
__name(isJWKSLike, "isJWKSLike");
function isJWKLike(key) {
  return isObject(key);
}
__name(isJWKLike, "isJWKLike");
var LocalJWKSet = class {
  static {
    __name(this, "LocalJWKSet");
  }
  #jwks;
  #cached = /* @__PURE__ */ new WeakMap();
  constructor(jwks) {
    if (!isJWKSLike(jwks)) {
      throw new JWKSInvalid("JSON Web Key Set malformed");
    }
    this.#jwks = structuredClone(jwks);
  }
  jwks() {
    return this.#jwks;
  }
  async getKey(protectedHeader, token) {
    const { alg, kid } = { ...protectedHeader, ...token?.header };
    const kty = getKtyFromAlg(alg);
    const candidates = this.#jwks.keys.filter((jwk2) => {
      let candidate = kty === jwk2.kty;
      if (candidate && typeof kid === "string") {
        candidate = kid === jwk2.kid;
      }
      if (candidate && (typeof jwk2.alg === "string" || kty === "AKP")) {
        candidate = alg === jwk2.alg;
      }
      if (candidate && typeof jwk2.use === "string") {
        candidate = jwk2.use === "sig";
      }
      if (candidate && Array.isArray(jwk2.key_ops)) {
        candidate = jwk2.key_ops.includes("verify");
      }
      if (candidate) {
        switch (alg) {
          case "ES256":
            candidate = jwk2.crv === "P-256";
            break;
          case "ES384":
            candidate = jwk2.crv === "P-384";
            break;
          case "ES512":
            candidate = jwk2.crv === "P-521";
            break;
          case "Ed25519":
          case "EdDSA":
            candidate = jwk2.crv === "Ed25519";
            break;
        }
      }
      return candidate;
    });
    const { 0: jwk, length } = candidates;
    if (length === 0) {
      throw new JWKSNoMatchingKey();
    }
    if (length !== 1) {
      const error2 = new JWKSMultipleMatchingKeys();
      const _cached = this.#cached;
      error2[Symbol.asyncIterator] = async function* () {
        for (const jwk2 of candidates) {
          try {
            yield await importWithAlgCache(_cached, jwk2, alg);
          } catch {
          }
        }
      };
      throw error2;
    }
    return importWithAlgCache(this.#cached, jwk, alg);
  }
};
async function importWithAlgCache(cache2, jwk, alg) {
  const cached = cache2.get(jwk) || cache2.set(jwk, {}).get(jwk);
  if (cached[alg] === void 0) {
    const key = await importJWK({ ...jwk, ext: true }, alg);
    if (key instanceof Uint8Array || key.type !== "public") {
      throw new JWKSInvalid("JSON Web Key Set members must be public keys");
    }
    cached[alg] = key;
  }
  return cached[alg];
}
__name(importWithAlgCache, "importWithAlgCache");
function createLocalJWKSet(jwks) {
  const set = new LocalJWKSet(jwks);
  const localJWKSet = /* @__PURE__ */ __name(async (protectedHeader, token) => set.getKey(protectedHeader, token), "localJWKSet");
  Object.defineProperties(localJWKSet, {
    jwks: {
      value: /* @__PURE__ */ __name(() => structuredClone(set.jwks()), "value"),
      enumerable: false,
      configurable: false,
      writable: false
    }
  });
  return localJWKSet;
}
__name(createLocalJWKSet, "createLocalJWKSet");

// node_modules/jose/dist/webapi/jwks/remote.js
init_modules_watch_stub();
function isCloudflareWorkers() {
  return typeof WebSocketPair !== "undefined" || typeof navigator !== "undefined" && true || typeof EdgeRuntime !== "undefined" && EdgeRuntime === "vercel";
}
__name(isCloudflareWorkers, "isCloudflareWorkers");
var USER_AGENT;
if (typeof navigator === "undefined" || !"Cloudflare-Workers"?.startsWith?.("Mozilla/5.0 ")) {
  const NAME = "jose";
  const VERSION = "v6.2.4";
  USER_AGENT = `${NAME}/${VERSION}`;
}
var customFetch = /* @__PURE__ */ Symbol();
async function fetchJwks(url, headers, signal, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "GET",
    signal,
    redirect: "manual",
    headers
  }).catch((err) => {
    if (err.name === "TimeoutError") {
      throw new JWKSTimeout();
    }
    throw err;
  });
  if (response.status !== 200) {
    throw new JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response");
  }
  try {
    return await response.json();
  } catch {
    throw new JOSEError("Failed to parse the JSON Web Key Set HTTP response as JSON");
  }
}
__name(fetchJwks, "fetchJwks");
var jwksCache = /* @__PURE__ */ Symbol();
function isFreshJwksCache(input, cacheMaxAge) {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  if (!("uat" in input) || typeof input.uat !== "number" || Date.now() - input.uat >= cacheMaxAge) {
    return false;
  }
  if (!("jwks" in input) || !isObject(input.jwks) || !Array.isArray(input.jwks.keys) || !Array.prototype.every.call(input.jwks.keys, isObject)) {
    return false;
  }
  return true;
}
__name(isFreshJwksCache, "isFreshJwksCache");
var RemoteJWKSet = class {
  static {
    __name(this, "RemoteJWKSet");
  }
  #url;
  #timeoutDuration;
  #cooldownDuration;
  #cacheMaxAge;
  #jwksTimestamp;
  #pendingFetch;
  #headers;
  #customFetch;
  #local;
  #cache;
  constructor(url, options) {
    if (!(url instanceof URL)) {
      throw new TypeError("url must be an instance of URL");
    }
    this.#url = new URL(url.href);
    this.#timeoutDuration = typeof options?.timeoutDuration === "number" ? options?.timeoutDuration : 5e3;
    this.#cooldownDuration = typeof options?.cooldownDuration === "number" ? options?.cooldownDuration : 3e4;
    this.#cacheMaxAge = typeof options?.cacheMaxAge === "number" ? options?.cacheMaxAge : 6e5;
    this.#headers = new Headers(options?.headers);
    if (USER_AGENT && !this.#headers.has("User-Agent")) {
      this.#headers.set("User-Agent", USER_AGENT);
    }
    if (!this.#headers.has("accept")) {
      this.#headers.set("accept", "application/json");
      this.#headers.append("accept", "application/jwk-set+json");
    }
    this.#customFetch = options?.[customFetch];
    if (options?.[jwksCache] !== void 0) {
      this.#cache = options?.[jwksCache];
      if (isFreshJwksCache(options?.[jwksCache], this.#cacheMaxAge)) {
        this.#jwksTimestamp = this.#cache.uat;
        this.#local = createLocalJWKSet(this.#cache.jwks);
      }
    }
  }
  pendingFetch() {
    return !!this.#pendingFetch;
  }
  coolingDown() {
    return typeof this.#jwksTimestamp === "number" ? Date.now() < this.#jwksTimestamp + this.#cooldownDuration : false;
  }
  fresh() {
    return typeof this.#jwksTimestamp === "number" ? Date.now() < this.#jwksTimestamp + this.#cacheMaxAge : false;
  }
  jwks() {
    return this.#local?.jwks();
  }
  async getKey(protectedHeader, token) {
    if (!this.#local || !this.fresh()) {
      await this.reload();
    }
    try {
      return await this.#local(protectedHeader, token);
    } catch (err) {
      if (err instanceof JWKSNoMatchingKey) {
        if (this.coolingDown() === false) {
          await this.reload();
          return this.#local(protectedHeader, token);
        }
      }
      throw err;
    }
  }
  async reload() {
    if (this.#pendingFetch && isCloudflareWorkers()) {
      this.#pendingFetch = void 0;
    }
    this.#pendingFetch ||= fetchJwks(this.#url.href, this.#headers, AbortSignal.timeout(this.#timeoutDuration), this.#customFetch).then((json3) => {
      this.#local = createLocalJWKSet(json3);
      if (this.#cache) {
        this.#cache.uat = Date.now();
        this.#cache.jwks = json3;
      }
      this.#jwksTimestamp = Date.now();
      this.#pendingFetch = void 0;
    }).catch((err) => {
      this.#pendingFetch = void 0;
      throw err;
    });
    await this.#pendingFetch;
  }
};
function createRemoteJWKSet(url, options) {
  const set = new RemoteJWKSet(url, options);
  const remoteJWKSet = /* @__PURE__ */ __name(async (protectedHeader, token) => set.getKey(protectedHeader, token), "remoteJWKSet");
  Object.defineProperties(remoteJWKSet, {
    coolingDown: {
      get: /* @__PURE__ */ __name(() => set.coolingDown(), "get"),
      enumerable: true,
      configurable: false
    },
    fresh: {
      get: /* @__PURE__ */ __name(() => set.fresh(), "get"),
      enumerable: true,
      configurable: false
    },
    reload: {
      value: /* @__PURE__ */ __name(() => set.reload(), "value"),
      enumerable: true,
      configurable: false,
      writable: false
    },
    reloading: {
      get: /* @__PURE__ */ __name(() => set.pendingFetch(), "get"),
      enumerable: true,
      configurable: false
    },
    jwks: {
      value: /* @__PURE__ */ __name(() => set.jwks(), "value"),
      enumerable: true,
      configurable: false,
      writable: false
    }
  });
  return remoteJWKSet;
}
__name(createRemoteJWKSet, "createRemoteJWKSet");

// node_modules/jose/dist/webapi/util/decode_jwt.js
init_modules_watch_stub();
function decodeJwt(jwt) {
  if (typeof jwt !== "string")
    throw new JWTInvalid("JWTs must use Compact JWS serialization, JWT must be a string");
  const { 1: payload, length } = jwt.split(".");
  if (length === 5)
    throw new JWTInvalid("Only JWTs using Compact JWS serialization can be decoded");
  if (length !== 3)
    throw new JWTInvalid("Invalid JWT");
  if (!payload)
    throw new JWTInvalid("JWTs must contain a payload");
  let decoded;
  try {
    decoded = decode(payload);
  } catch {
    throw new JWTInvalid("Failed to base64url decode the payload");
  }
  let result;
  try {
    result = JSON.parse(decoder.decode(decoded));
  } catch {
    throw new JWTInvalid("Failed to parse the decoded payload as JSON");
  }
  if (!isObject(result))
    throw new JWTInvalid("Invalid JWT Claims Set");
  return result;
}
__name(decodeJwt, "decodeJwt");

// src/attentionAuth.ts
var remoteJwksByUrl = /* @__PURE__ */ new Map();
var AttentionAuthVerificationUnavailableError = class extends Error {
  static {
    __name(this, "AttentionAuthVerificationUnavailableError");
  }
  constructor() {
    super("Clerk verification service unavailable");
    this.name = "AttentionAuthVerificationUnavailableError";
  }
};
function audienceIncludes(audience, expected) {
  return typeof audience === "string" ? audience === expected : Array.isArray(audience) && audience.includes(expected);
}
__name(audienceIncludes, "audienceIncludes");
function clerkConfiguration(values) {
  const [jwksUrl, issuer, oauthClientId] = values.map((value) => value?.trim() ?? "");
  const configured = Boolean(jwksUrl || issuer || oauthClientId);
  const complete = Boolean(jwksUrl && issuer && oauthClientId);
  let validUrl = false;
  if (complete) {
    try {
      validUrl = new URL(jwksUrl).protocol === "https:" && new URL(issuer).protocol === "https:";
    } catch {
      validUrl = false;
    }
  }
  return {
    configured,
    complete,
    validUrl,
    value: complete && validUrl ? { jwksUrl, issuer, oauthClientId } : null
  };
}
__name(clerkConfiguration, "clerkConfiguration");
function inspectAttentionAuthConfiguration(env) {
  const primary = clerkConfiguration([
    env.CLERK_JWKS_URL,
    env.CLERK_ISSUER,
    env.CLERK_OAUTH_CLIENT_ID
  ]);
  const secondary = clerkConfiguration([
    env.CLERK_SECONDARY_JWKS_URL,
    env.CLERK_SECONDARY_ISSUER,
    env.CLERK_SECONDARY_OAUTH_CLIENT_ID
  ]);
  const errors = [];
  if (!primary.complete) errors.push("primary_incomplete");
  else if (!primary.validUrl) errors.push("primary_invalid_url");
  if (secondary.configured && !secondary.complete) errors.push("secondary_incomplete");
  else if (secondary.complete && !secondary.validUrl) errors.push("secondary_invalid_url");
  if (primary.value && secondary.value && primary.value.issuer === secondary.value.issuer) {
    errors.push("issuers_not_distinct");
  }
  return {
    configured: errors.length === 0,
    primaryConfigured: primary.value != null,
    secondaryConfigured: secondary.value != null,
    errors
  };
}
__name(inspectAttentionAuthConfiguration, "inspectAttentionAuthConfiguration");
function configuredClerkVerifiers(env) {
  const primary = clerkConfiguration([
    env.CLERK_JWKS_URL,
    env.CLERK_ISSUER,
    env.CLERK_OAUTH_CLIENT_ID
  ]).value;
  const secondary = clerkConfiguration([
    env.CLERK_SECONDARY_JWKS_URL,
    env.CLERK_SECONDARY_ISSUER,
    env.CLERK_SECONDARY_OAUTH_CLIENT_ID
  ]).value;
  return [primary, secondary].filter(
    (configuration) => configuration != null
  );
}
__name(configuredClerkVerifiers, "configuredClerkVerifiers");
async function relayAccountKey(issuer, subject) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${issuer}\0${subject}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(relayAccountKey, "relayAccountKey");
async function relayAccountKeysForClerkUser(env, clerkUserId) {
  const subject = clerkUserId.trim();
  if (!subject) return [];
  return await Promise.all(configuredClerkVerifiers(env).map((config) => relayAccountKey(config.issuer, subject)));
}
__name(relayAccountKeysForClerkUser, "relayAccountKeysForClerkUser");
async function verifyAttentionBearerToken(request, env) {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)\s*$/i);
  const token = match?.[1];
  if (!token) return null;
  let tokenIssuer;
  try {
    const decoded = decodeJwt(token);
    tokenIssuer = typeof decoded.iss === "string" ? decoded.iss.trim() : "";
  } catch {
    return null;
  }
  const config = configuredClerkVerifiers(env).find(
    (candidate) => candidate.issuer === tokenIssuer
  );
  if (!config) return null;
  let jwks = remoteJwksByUrl.get(config.jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.jwksUrl));
    remoteJwksByUrl.set(config.jwksUrl, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      algorithms: ["RS256"],
      clockTolerance: 5
    });
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!subject || subject.length > 256) return null;
    if (payload.aud !== void 0 && !audienceIncludes(payload.aud, config.oauthClientId) && payload.azp !== config.oauthClientId) {
      return null;
    }
    return await relayAccountKey(config.issuer, subject);
  } catch (error2) {
    if (error2 instanceof TypeError || error2 instanceof errors_exports.JWKSTimeout || error2 instanceof errors_exports.JWKSInvalid || error2 instanceof errors_exports.JWKInvalid || error2 instanceof errors_exports.JOSEError && error2.constructor === errors_exports.JOSEError) {
      throw new AttentionAuthVerificationUnavailableError();
    }
    return null;
  }
}
__name(verifyAttentionBearerToken, "verifyAttentionBearerToken");

// src/liveActivity.ts
init_modules_watch_stub();
function resolveActivityDevicePreferences(device, preferences) {
  const registered = readPreferences(device.preferences_json);
  const accountPreferences = isRecord(preferences.account) ? preferences.account : {};
  const devicePreferences = isRecord(preferences.devices) ? preferences.devices : {};
  const accountOverride = isRecord(devicePreferences[device.device_id]) ? devicePreferences[device.device_id] : {};
  return { ...registered, ...accountPreferences, ...accountOverride };
}
__name(resolveActivityDevicePreferences, "resolveActivityDevicePreferences");
function activityBoardColumn(item) {
  if (item.kind !== "agent") return null;
  if (isActivityBoardColumn(item.boardColumn)) return item.boardColumn;
  if (item.phase === "needs_you" || item.phase === "failed") return "needs_you";
  if (item.activityTier === "idle") return "done";
  if (item.phase === "starting" || item.phase === "running" || item.phase === "stale") {
    return "working";
  }
  return "done";
}
__name(activityBoardColumn, "activityBoardColumn");
var LIVE_ACTIVITY_COUNT_REFRESH_MS = 5 * 60 * 1e3;
var ACTIVITY_STATE_GROUP_ORDER = [
  "needs_you",
  "failed",
  "planning",
  "working",
  "idle",
  "done"
];
function activityStateGroup(item) {
  if (item.activityTier === "idle") return "idle";
  switch (item.phase) {
    case "needs_you":
      return "needs_you";
    case "failed":
    case "checks_failing":
    case "changes_requested":
      return "failed";
    case "starting":
    case "running":
      return item.chatActivityMode === "planning" ? "planning" : "working";
    case "stale":
      return "idle";
    case "open":
    case "review_requested":
    case "merge_ready":
    case "blocked":
      return "working";
    default:
      return "done";
  }
}
__name(activityStateGroup, "activityStateGroup");
function activityPriority(item) {
  switch (item.phase) {
    case "needs_you":
      return 0;
    case "failed":
    case "checks_failing":
    case "changes_requested":
      return 1;
    case "review_requested":
    case "merge_ready":
    case "blocked":
      return 2;
    case "starting":
    case "running":
      return 3;
    case "open":
      return 4;
    case "stale":
      return 5;
    case "completed":
    case "merged":
      return 6;
    default:
      return 7;
  }
}
__name(activityPriority, "activityPriority");
function activityRun(item) {
  if (item.kind !== "agent" || !isRecord(item.destination)) return null;
  const sessionId = requiredString(item.destination.sessionId);
  if (!sessionId) return null;
  const actions = Array.isArray(item.actions) ? item.actions.filter(isRecord) : [];
  const approval = actions.some((action) => action.kind === "approve");
  const phase = item.phase === "needs_you" || item.phase === "blocked" ? approval ? "waiting_for_approval" : "waiting_for_input" : item.phase;
  const statusSinceRaw = typeof item.statusSince === "string" ? item.statusSince : typeof item.occurredAt === "string" ? item.occurredAt : "";
  const statusSinceMs = Date.parse(statusSinceRaw);
  return {
    id: sessionId,
    accountMachineKey: requiredString(item.machine.accountMachineKey, 128),
    title: boundedText(item.title, MAX_TITLE_LENGTH) ?? "Agent run",
    phase,
    model: boundedText(item.model, 120),
    lane: boundedText(item.laneName, 160),
    detail: boundedText(item.preview, MAX_PREVIEW_LENGTH),
    ...Number.isFinite(statusSinceMs) ? { statusSince: Math.floor(statusSinceMs / 1e3) } : {}
  };
}
__name(activityRun, "activityRun");
function activityPullRequest(item) {
  if (item.kind !== "pull_request" || !isRecord(item.destination)) return null;
  const number = Number(item.destination.number);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const phase = item.phase === "open" ? "opened" : item.phase;
  return {
    id: item.id,
    accountMachineKey: requiredString(item.machine.accountMachineKey, 128),
    prNumber: number,
    title: boundedText(item.title, MAX_TITLE_LENGTH) ?? `Pull request #${number}`,
    phase,
    lane: boundedText(item.laneName, 160),
    repoOwner: requiredString(item.destination.repoOwner),
    repoName: requiredString(item.destination.repoName),
    updatedAt: Date.parse(item.updatedAt) / 1e3
  };
}
__name(activityPullRequest, "activityPullRequest");
async function sha256Hex2(value) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex2, "sha256Hex");
async function accountActivityContentState(env, userId) {
  const rows = await env.DB.prepare(`
    select payload_json, seen_at, dismissed_at
    from attention_items
    where user_id = ?
      and dismissed_at is null
      and (expires_at is null or expires_at > ?)
    limit 512
  `).bind(userId, (/* @__PURE__ */ new Date()).toISOString()).all();
  const items = rows.results.flatMap((row) => {
    try {
      const item = JSON.parse(row.payload_json);
      if (item.phase === "closed" || item.phase === "open") return [];
      if ((item.phase === "completed" || item.phase === "merged") && row.seen_at && activityBoardColumn(item) !== "waiting") return [];
      return [item];
    } catch {
      return [];
    }
  }).sort((left, right) => {
    const priority = activityPriority(left) - activityPriority(right);
    if (priority !== 0) return priority;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
  const runCandidates = items.flatMap((item) => {
    const run = activityRun(item);
    return run ? [run] : [];
  });
  const runs = runCandidates.slice(0, 3);
  const prs = items.flatMap((item) => {
    const pr = activityPullRequest(item);
    return pr ? [pr] : [];
  }).slice(0, 2);
  const newestUpdate = items.reduce(
    (latest, item) => Math.max(latest, Date.parse(item.updatedAt)),
    0
  );
  const activeCount = items.filter((item) => item.kind === "agent" && activityStateGroup(item) !== "idle" && (item.phase === "starting" || item.phase === "running" || item.phase === "needs_you" || item.phase === "blocked")).length;
  const agentItems = items.filter((item) => item.kind === "agent");
  const tally = /* @__PURE__ */ new Map();
  for (const item of agentItems) {
    const group = activityStateGroup(item);
    tally.set(group, (tally.get(group) ?? 0) + 1);
  }
  const groups = ACTIVITY_STATE_GROUP_ORDER.map((group) => ({ group, count: tally.get(group) ?? 0 })).filter((entry) => entry.count > 0);
  const columns = { needsYou: 0, working: 0, waiting: 0, done: 0 };
  for (const item of agentItems) {
    switch (activityBoardColumn(item)) {
      case "needs_you":
        columns.needsYou += 1;
        break;
      case "working":
        columns.working += 1;
        break;
      case "waiting":
        columns.waiting += 1;
        break;
      case "done":
        columns.done += 1;
        break;
      default:
        break;
    }
  }
  const moreCount = Math.max(0, runCandidates.length - runs.length);
  const contentState = {
    updatedAt: Math.floor((newestUpdate || Date.now()) / 1e3),
    // Always present, zeros included: the four tiles read these directly.
    columns,
    activeCount,
    runs,
    prs,
    // Additive: omitted, never zero-filled. An older client ignores the keys,
    // and a newer client treats absence as "derive it locally from the roster".
    ...groups.length > 0 ? { groups } : {},
    ...moreCount > 0 ? { moreCount } : {}
  };
  return {
    contentState,
    transitionFingerprint: await sha256Hex2(
      JSON.stringify(activityTransitionSource(items, columns.needsYou))
    ),
    countsFingerprint: `${columns.needsYou}.${columns.working}.${columns.waiting}.${columns.done}`,
    // The activity lives while any agent needs you, works, or waits. Done
    // alone is not a reason to hold the Lock Screen.
    count: columns.needsYou + columns.working + columns.waiting
  };
}
__name(accountActivityContentState, "accountActivityContentState");
function activityTransitionSource(items, needsYouCount) {
  const alerting = items.filter((item) => activityBoardColumn(item) === "needs_you").map((item) => item.alertFingerprint).sort();
  const pullRequests = items.filter((item) => item.kind === "pull_request").map((item) => item.alertFingerprint).sort();
  return {
    needsYou: needsYouCount,
    alerting,
    pullRequests
  };
}
__name(activityTransitionSource, "activityTransitionSource");
function liveActivityStartSummary(contentState) {
  const columns = isRecord(contentState.columns) ? contentState.columns : {};
  const count = /* @__PURE__ */ __name((key) => {
    const value = Number(columns[key]);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }, "count");
  const parts = [
    count("needsYou") > 0 ? `${count("needsYou")} need${count("needsYou") === 1 ? "s" : ""} you` : null,
    count("working") > 0 ? `${count("working")} working` : null,
    count("waiting") > 0 ? `${count("waiting")} waiting` : null
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" \xB7 ") : "Agents are active";
}
__name(liveActivityStartSummary, "liveActivityStartSummary");
function privacyPreservingActivityContentState(contentState) {
  const runs = Array.isArray(contentState.runs) ? contentState.runs.filter(isRecord).map((run) => ({
    ...run,
    title: "Agent activity",
    model: null,
    lane: null,
    detail: null
  })) : [];
  const prs = Array.isArray(contentState.prs) ? contentState.prs.filter(isRecord).map((pr) => ({
    ...pr,
    title: Number.isSafeInteger(pr.prNumber) ? `Pull request #${String(pr.prNumber)}` : "Pull request",
    lane: null
  })) : [];
  return {
    ...contentState,
    runs,
    prs
  };
}
__name(privacyPreservingActivityContentState, "privacyPreservingActivityContentState");
async function claimAccountLiveActivityStart(env, userId, deviceId, activityId, generation) {
  const claim = `pending:${crypto.randomUUID()}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const staleBefore = new Date(
    Date.now() - LIVE_ACTIVITY_START_CLAIM_TTL_MS
  ).toISOString();
  const row = await env.DB.prepare(`
    insert into attention_activity_state(
      user_id, device_id, activity_id, started, fingerprint, updated_at
    )
    select ?, ?, ?, 0, ?, ?
    where exists (
      select 1
      from attention_devices
      where user_id = ? and device_id = ? and generation = ?
    )
    on conflict(user_id, device_id, activity_id) do update set
      started = 0,
      fingerprint = excluded.fingerprint,
      updated_at = excluded.updated_at
    where attention_activity_state.started = 0
      and attention_activity_state.updated_at <= ?
    returning fingerprint
  `).bind(
    userId,
    deviceId,
    activityId,
    claim,
    now,
    userId,
    deviceId,
    generation,
    staleBefore
  ).first();
  return row?.fingerprint === claim ? claim : null;
}
__name(claimAccountLiveActivityStart, "claimAccountLiveActivityStart");
async function releaseAccountLiveActivityStart(env, userId, deviceId, activityId, claim, generation) {
  await env.DB.prepare(`
      delete from attention_activity_state
      where user_id = ? and device_id = ? and activity_id = ?
        and started = 0 and fingerprint = ?
        and exists (
          select 1
          from attention_devices
          where user_id = ? and device_id = ? and generation = ?
        )
    `).bind(
    userId,
    deviceId,
    activityId,
    claim,
    userId,
    deviceId,
    generation
  ).run();
}
__name(releaseAccountLiveActivityStart, "releaseAccountLiveActivityStart");
async function deliverAccountLiveActivity(env, userId) {
  const config = apnsConfig(env);
  if (!config) return;
  const activityId = "agent-runs";
  const [
    { contentState, transitionFingerprint, countsFingerprint, count },
    devicesResult,
    preferencesRow
  ] = await Promise.all([
    accountActivityContentState(env, userId),
    // Each device's Live Activity state and update token ride along (both
    // keyed by user, device and activity, so at most one row each) instead
    // of two more reads per device.
    env.DB.prepare(`
        select device.device_id, device.apns_token, device.push_to_start_token,
          device.bundle_id, device.aps_environment, device.preferences_json,
          device.generation, ownership.ownership_epoch,
          state.started as activity_started,
          state.fingerprint as activity_fingerprint,
          state.updated_at as activity_updated_at,
          token.token as activity_token
        from attention_devices as device
        join attention_device_ownership as ownership
          on ownership.device_id = device.device_id
          and ownership.user_id = device.user_id
          and ownership.active = 1
        left join attention_activity_state as state
          on state.user_id = device.user_id
          and state.device_id = device.device_id
          and state.activity_id = ?
        left join attention_activity_tokens as token
          on token.user_id = device.user_id
          and token.device_id = device.device_id
          and token.activity_id = ?
        where device.user_id = ? and device.lease_expires_at > ?
      `).bind(activityId, activityId, userId, (/* @__PURE__ */ new Date()).toISOString()).all(),
    env.DB.prepare("select payload_json from attention_preferences where user_id = ? limit 1").bind(userId).first()
  ]);
  const preferences = readPreferences(preferencesRow?.payload_json);
  const accountPreferences = isRecord(preferences.account) ? preferences.account : {};
  const nowSeconds = Math.floor(Date.now() / 1e3);
  for (const device of devicesResult.results) {
    const ownershipEpoch = Number(device.ownership_epoch);
    if (!Number.isSafeInteger(ownershipEpoch) || ownershipEpoch <= 0) continue;
    const override = resolveActivityDevicePreferences(device, preferences);
    const started = device.activity_started === 1;
    const liveActivitiesEnabled = preferenceBoolean(
      override,
      accountPreferences,
      "liveActivitiesEnabled",
      true
    );
    const hideDetails = preferenceBoolean(
      override,
      accountPreferences,
      "hideDetails",
      false
    );
    const deviceCount = liveActivitiesEnabled ? count : 0;
    const visibleContentState = liveActivitiesEnabled ? hideDetails ? privacyPreservingActivityContentState(contentState) : contentState : {
      updatedAt: nowSeconds,
      activeCount: 0,
      runs: [],
      prs: []
    };
    const deviceContentState = {
      ...visibleContentState,
      ownershipEpoch
    };
    const urgentFingerprint = `${transitionFingerprint}:${hideDetails ? "private" : "public"}:owner:${ownershipEpoch}`;
    const deviceFingerprint = `${urgentFingerprint}|${countsFingerprint}`;
    if (deviceCount === 0 && !started) continue;
    if (deviceCount > 0 && started && device.activity_fingerprint === deviceFingerprint) continue;
    if (deviceCount > 0 && started && device.activity_fingerprint?.split("|")[0] === urgentFingerprint && Date.now() - Date.parse(device.activity_updated_at ?? "") < LIVE_ACTIVITY_COUNT_REFRESH_MS) {
      continue;
    }
    let event;
    let deviceToken;
    if (deviceCount === 0) {
      event = "end";
      deviceToken = device.activity_token;
    } else if (!started) {
      event = "start";
      deviceToken = device.push_to_start_token;
    } else {
      event = "update";
      deviceToken = device.activity_token;
    }
    if (!deviceToken) {
      if (event === "end") {
        await env.DB.prepare(`
            delete from attention_activity_state
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
          userId,
          device.device_id,
          activityId,
          userId,
          device.device_id,
          device.generation
        ).run();
      }
      continue;
    }
    const startClaim = event === "start" ? await claimAccountLiveActivityStart(
      env,
      userId,
      device.device_id,
      activityId,
      device.generation
    ) : null;
    if (event === "start" && !startClaim) continue;
    const aps = {
      timestamp: nowSeconds,
      event,
      "content-state": deviceContentState,
      "relevance-score": deviceCount > 0 ? 0.9 : 0
    };
    if (event !== "end") aps["stale-date"] = nowSeconds + 10 * 60;
    if (event === "start") {
      aps["input-push-token"] = 1;
      aps["attributes-type"] = "ADEAgentRunsAttributes";
      aps.attributes = {
        machineName: "All machines",
        accountWide: true,
        ownershipEpoch
      };
      aps.alert = {
        title: "ADE",
        body: liveActivityStartSummary(contentState)
      };
    }
    if (event === "end") aps["dismissal-date"] = nowSeconds + 60;
    let result;
    try {
      result = await sendApnsPush(config, {
        environment: device.aps_environment,
        deviceToken,
        topic: `${device.bundle_id}.push-type.liveactivity`,
        pushType: "liveactivity",
        priority: 10,
        expiration: nowSeconds + 24 * 60 * 60,
        collapseId: `attention:${activityId}`,
        payload: { aps }
      });
    } catch (error2) {
      if (startClaim) {
        await releaseAccountLiveActivityStart(
          env,
          userId,
          device.device_id,
          activityId,
          startClaim,
          device.generation
        );
      }
      logAttentionDeliveryError("live_activity", device.device_id, error2);
      continue;
    }
    if (result.ok) {
      if (event === "end") {
        await env.DB.batch([
          env.DB.prepare(`
            delete from attention_activity_state
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
            userId,
            device.device_id,
            activityId,
            userId,
            device.device_id,
            device.generation
          ),
          env.DB.prepare(`
            delete from attention_activity_tokens
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
            userId,
            device.device_id,
            activityId,
            userId,
            device.device_id,
            device.generation
          )
        ]);
      } else if (event === "start" && startClaim) {
        await env.DB.prepare(`
            update attention_activity_state
            set started = 1, fingerprint = ?, updated_at = ?
            where user_id = ? and device_id = ? and activity_id = ?
              and started = 0 and fingerprint = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
          deviceFingerprint,
          (/* @__PURE__ */ new Date()).toISOString(),
          userId,
          device.device_id,
          activityId,
          startClaim,
          userId,
          device.device_id,
          device.generation
        ).run();
      } else {
        await env.DB.prepare(`
          insert into attention_activity_state(
            user_id, device_id, activity_id, started, fingerprint, updated_at
          )
          select ?, ?, ?, 1, ?, ?
          where exists (
            select 1
            from attention_devices
            where user_id = ? and device_id = ? and generation = ?
          )
          on conflict(user_id, device_id, activity_id) do update set
            started = 1,
            fingerprint = excluded.fingerprint,
            updated_at = excluded.updated_at
        `).bind(
          userId,
          device.device_id,
          activityId,
          deviceFingerprint,
          (/* @__PURE__ */ new Date()).toISOString(),
          userId,
          device.device_id,
          device.generation
        ).run();
      }
    } else {
      if (startClaim) {
        await releaseAccountLiveActivityStart(
          env,
          userId,
          device.device_id,
          activityId,
          startClaim,
          device.generation
        );
      }
      if (result.tokenInvalid && event === "start") {
        await env.DB.prepare(`
            update attention_devices
            set push_to_start_token = null
            where user_id = ? and device_id = ? and generation = ?
          `).bind(userId, device.device_id, device.generation).run();
      } else if (result.tokenInvalid) {
        await env.DB.batch([
          env.DB.prepare(`
            delete from attention_activity_tokens
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
            userId,
            device.device_id,
            activityId,
            userId,
            device.device_id,
            device.generation
          ),
          env.DB.prepare(`
            delete from attention_activity_state
            where user_id = ? and device_id = ? and activity_id = ?
              and exists (
                select 1
                from attention_devices
                where user_id = ? and device_id = ? and generation = ?
              )
          `).bind(
            userId,
            device.device_id,
            activityId,
            userId,
            device.device_id,
            device.generation
          )
        ]);
      }
    }
  }
}
__name(deliverAccountLiveActivity, "deliverAccountLiveActivity");
var liveActivityTestInternals = Object.freeze({
  accountActivityContentState,
  activityPullRequest,
  activityBoardColumn,
  activityRun,
  activityStateGroup,
  privacyPreservingActivityContentState
});

// src/spendGuards.ts
init_modules_watch_stub();
var DEFAULT_DAILY_REQUEST_BUDGET = 75e4;
var DEFAULT_IP_RATE_LIMIT_PER_MIN = 120;
var DEFAULT_CLAIM_RATE_LIMIT_PER_MIN = 10;
var RATE_WINDOW_SECONDS = 60;
var ACCOUNT_NOTIFY_LIMIT_PER_HOUR = 60;
var ACCOUNT_NOTIFY_WINDOW_SECONDS = 60 * 60;
var ACCOUNT_NOTIFY_BUCKET_PREFIX = "notify:";
function positiveIntEnv(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
__name(positiveIntEnv, "positiveIntEnv");
async function checkRateLimit(env, bucket, limit, windowSeconds) {
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const row = await env.DB.prepare(
    `insert into rate_counters(bucket, window_start, count, updated_at)
       values (?1, ?2, 1, ?3)
       on conflict(bucket) do update set
         window_start = case when ?2 - window_start >= ?4 then ?2 else window_start end,
         count        = case when ?2 - window_start >= ?4 then 1  else count + 1 end,
         updated_at   = ?3
         where (?2 - window_start >= ?4) or (count < ?5)
       returning count`
  ).bind(bucket, nowSeconds, nowIso, windowSeconds, limit).first();
  if (!row) return { allowed: false, count: limit };
  return { allowed: true, count: row.count };
}
__name(checkRateLimit, "checkRateLimit");
async function checkAccountNotifyQuota(env, accountKey) {
  const bucket = `${ACCOUNT_NOTIFY_BUCKET_PREFIX}${accountKey}`;
  const gate = await checkRateLimit(env, bucket, ACCOUNT_NOTIFY_LIMIT_PER_HOUR, ACCOUNT_NOTIFY_WINDOW_SECONDS);
  if (gate.allowed) {
    return { allowed: true, remaining: Math.max(0, ACCOUNT_NOTIFY_LIMIT_PER_HOUR - gate.count) };
  }
  const row = await env.DB.prepare("select window_start from rate_counters where bucket = ?").bind(bucket).first();
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const reopensAt = Number(row?.window_start ?? nowSeconds) + ACCOUNT_NOTIFY_WINDOW_SECONDS;
  return { allowed: false, retryAfterSeconds: Math.max(1, reopensAt - nowSeconds) };
}
__name(checkAccountNotifyQuota, "checkAccountNotifyQuota");
var budgetTrippedUntilMs = 0;
var ipWindows = /* @__PURE__ */ new Map();
var MAX_TRACKED_IPS = 1e4;
var ipWindowsSweptAtSecond = 0;
var BUDGET_RESERVATION_FIRST = 1;
var BUDGET_RESERVATION_MAX = 50;
var budgetNextReservationSize = BUDGET_RESERVATION_FIRST;
var budgetDay = "";
var budgetReservedRemaining = 0;
var budgetReservedThrough = 0;
var budgetReservation = null;
function budgetTrippedNow() {
  return Date.now() < budgetTrippedUntilMs;
}
__name(budgetTrippedNow, "budgetTrippedNow");
function checkIpRateInMemory(ip, limit, windowSeconds) {
  const nowSeconds = Math.floor(Date.now() / 1e3);
  let entry = ipWindows.get(ip);
  if (!entry || nowSeconds - entry.windowStart >= windowSeconds) {
    if (!entry && ipWindows.size >= MAX_TRACKED_IPS) {
      if (nowSeconds !== ipWindowsSweptAtSecond) {
        ipWindowsSweptAtSecond = nowSeconds;
        for (const [key, value] of ipWindows) {
          if (nowSeconds - value.windowStart >= windowSeconds) ipWindows.delete(key);
        }
      }
      if (ipWindows.size >= MAX_TRACKED_IPS) {
        const oldest = ipWindows.keys().next();
        if (!oldest.done) ipWindows.delete(oldest.value);
      }
    }
    entry = { windowStart: nowSeconds, count: 0 };
    ipWindows.set(ip, entry);
  }
  if (entry.count >= limit) return { allowed: false, count: entry.count };
  entry.count += 1;
  return { allowed: true, count: entry.count };
}
__name(checkIpRateInMemory, "checkIpRateInMemory");
async function flushBudgetCount(env, day2, increment, nowMs) {
  const row = await withCloudflareRetry(() => env.DB.prepare(
    `insert into rate_counters(bucket, window_start, count, updated_at)
       values (?, ?, ?, ?)
       on conflict(bucket) do update set count = rate_counters.count + excluded.count,
                                         updated_at = excluded.updated_at
       returning count`
  ).bind(`budget:${day2}`, Math.floor(nowMs / 1e3), increment, new Date(nowMs).toISOString()).first());
  return row?.count ?? 0;
}
__name(flushBudgetCount, "flushBudgetCount");
async function reserveBudget(env, day2, nowMs) {
  const size = budgetNextReservationSize;
  const total2 = await flushBudgetCount(env, day2, size, nowMs);
  if (budgetDay !== day2) return;
  budgetReservedThrough = total2;
  budgetReservedRemaining = size;
  budgetNextReservationSize = Math.min(BUDGET_RESERVATION_MAX, size * 2);
}
__name(reserveBudget, "reserveBudget");
async function recordDailyBudget(env) {
  const nowMs = Date.now();
  const budget = positiveIntEnv(env.DAILY_REQUEST_BUDGET, DEFAULT_DAILY_REQUEST_BUDGET);
  const day2 = new Date(nowMs).toISOString().slice(0, 10);
  if (day2 !== budgetDay) {
    budgetDay = day2;
    budgetReservedRemaining = 0;
    budgetReservedThrough = 0;
    budgetReservation = null;
    budgetNextReservationSize = BUDGET_RESERVATION_FIRST;
  }
  for (; ; ) {
    if (budgetDay !== day2) return { allowed: true };
    if (budgetTrippedNow()) {
      return { allowed: false, day: day2, count: budgetReservedThrough, budget };
    }
    if (budgetReservedRemaining > 0) {
      budgetReservedRemaining -= 1;
      const count = budgetReservedThrough - budgetReservedRemaining;
      if (count > budget) {
        budgetTrippedUntilMs = Date.parse(`${day2}T23:59:59.999Z`);
        return { allowed: false, day: day2, count, budget };
      }
      return { allowed: true };
    }
    if (!budgetReservation || budgetReservation.day !== day2) {
      const promise = reserveBudget(env, day2, nowMs).finally(() => {
        if (budgetReservation?.promise === promise) budgetReservation = null;
      });
      budgetReservation = { day: day2, promise };
    }
    await budgetReservation.promise;
  }
}
__name(recordDailyBudget, "recordDailyBudget");

// src/attention.ts
var MAX_BODY_BYTES = 256 * 1024;
var MAX_ATTENTION_ITEMS = 64;
var MAX_ATTENTION_TOMBSTONES = 64;
var MAX_ATTENTION_DEVICES = 32;
var MAX_ATTENTION_MACHINE_PREFERENCES = 64;
var MAX_ACCOUNT_MUTED_SESSIONS = 500;
var ATTENTION_PUBLISH_FEATURES = ["message"];
var MAX_ACCOUNT_ATTENTION_ITEMS = 2e3;
var ATTENTION_DEVICE_LEASE_MS = 30 * 24 * 60 * 60 * 1e3;
var MAX_NOTIFICATION_ATTEMPTS_PER_PUBLISH = 64;
var APNS_TOKEN_PATTERN = /^[a-f0-9]{32,512}$/i;
var ACCOUNT_MACHINE_ONLINE_WINDOW_MS = 9e4;
var DEFAULT_DESKTOP_ESCALATION_DELAY_SECONDS = 120;
var DESKTOP_ESCALATION_DELAY_SECONDS_BEFORE_V3 = 30;
var DESKTOP_PRESENCE_WINDOW_MS = 45e3;
var TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1e3;
var MAX_OWNERSHIP_EPOCH_FUTURE_MS = 5 * 60 * 1e3;
var DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
var NOTIFICATION_DELIVERY_CLAIM_TTL_MS = 6e4;
var MAX_ALERT_AGE_MS = 15 * 6e4;
var ATTENTION_DELIVERY_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var ATTENTION_ALERT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;
var ORPHANED_MACHINE_ACTIVITY_MS = 14 * 24 * 60 * 60 * 1e3;
var MAX_SWEPT_ACCOUNTS_PER_PRUNE = 25;
var EVENT_KINDS = /* @__PURE__ */ new Set([
  "agent_running",
  "agent_needs_you",
  "agent_failed",
  "agent_completed",
  "pr_checks_failing",
  "pr_review_requested",
  "pr_changes_requested",
  "pr_merge_ready",
  "pr_merged",
  "pr_opened",
  "pr_closed",
  "agent_message"
]);
var PHASES = /* @__PURE__ */ new Set([
  "starting",
  "running",
  "needs_you",
  "blocked",
  "failed",
  "completed",
  "stale",
  "checks_failing",
  "review_requested",
  "changes_requested",
  "merge_ready",
  "open",
  "merged",
  "closed"
]);
var ACTION_KINDS = /* @__PURE__ */ new Set([
  "approve",
  "deny",
  "answer",
  "restart",
  "rerun_checks",
  "mark_seen",
  "dismiss",
  "open"
]);
var PR_TABS = /* @__PURE__ */ new Set(["overview", "activity", "checks", "files"]);
var DEFAULT_NOTIFY_EVENTS = /* @__PURE__ */ new Set([
  "agent_needs_you",
  "agent_failed",
  "pr_checks_failing"
]);
var EVENTS_DEMOTED_IN_POLICY_DEFAULTS_V2 = /* @__PURE__ */ new Set([
  "pr_review_requested",
  "pr_changes_requested",
  "pr_merge_ready"
]);
function effectiveEventPolicy(eventKind, eventPolicies, scope) {
  const saved = typeof eventPolicies[eventKind] === "string" ? eventPolicies[eventKind] : null;
  const defaultsVersion = Number(scope.eventPolicyDefaultsVersion);
  const savedUnderOldDefaults = !Number.isFinite(defaultsVersion) || defaultsVersion < 2;
  if (saved && !(savedUnderOldDefaults && saved === "notify" && EVENTS_DEMOTED_IN_POLICY_DEFAULTS_V2.has(eventKind))) {
    return saved;
  }
  return DEFAULT_NOTIFY_EVENTS.has(eventKind) ? "notify" : "ambient";
}
__name(effectiveEventPolicy, "effectiveEventPolicy");
function deepLinkForItem(item) {
  const destination = item.destination;
  if (!isRecord(destination)) return null;
  const accountMachineKey = requiredString(item.machine.accountMachineKey, 128);
  if (destination.kind === "session") {
    const sessionId = requiredString(destination.sessionId);
    if (!sessionId) return null;
    const query = new URLSearchParams();
    const itemId = requiredString(destination.itemId);
    const eventId = requiredString(destination.eventId);
    if (itemId) query.set("item", itemId);
    if (eventId) query.set("event", eventId);
    if (accountMachineKey) query.set("accountMachineKey", accountMachineKey);
    return `ade://session/${encodeURIComponent(sessionId)}${query.size ? `?${query}` : ""}`;
  }
  if (destination.kind === "pull_request") {
    const number = Number(destination.number);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    const owner = requiredString(destination.repoOwner);
    const repo = requiredString(destination.repoName);
    const tab = requiredString(destination.tab, 32);
    const query = new URLSearchParams();
    if (tab && tab !== "overview") query.set("tab", tab);
    if (accountMachineKey) query.set("accountMachineKey", accountMachineKey);
    const suffix = query.size ? `?${query}` : "";
    return owner && repo ? `ade://pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}${suffix}` : `ade://pr/${number}${suffix}`;
  }
  return null;
}
__name(deepLinkForItem, "deepLinkForItem");
function attentionAlertRoutingPayload(item, deepLink) {
  const accountMachineKey = requiredString(item.machine.accountMachineKey, 128);
  return {
    attentionItemId: item.id,
    eventKind: item.eventKind,
    ...accountMachineKey ? { accountMachineKey } : {},
    ...deepLink ? { deepLink } : {},
    ...isRecord(item.destination) && typeof item.destination.sessionId === "string" ? { sessionId: item.destination.sessionId } : {},
    ...isRecord(item.destination) && typeof item.destination.itemId === "string" ? { itemId: item.destination.itemId } : {}
  };
}
__name(attentionAlertRoutingPayload, "attentionAlertRoutingPayload");
function desktopEscalationDelayMs(accountPreferences) {
  const saved = Math.round(preferenceNumber(
    {},
    accountPreferences,
    "desktopFirstDelaySeconds",
    DEFAULT_DESKTOP_ESCALATION_DELAY_SECONDS
  ));
  const defaultsVersion = Number(accountPreferences.eventPolicyDefaultsVersion);
  const savedUnderOldDefault = saved === DESKTOP_ESCALATION_DELAY_SECONDS_BEFORE_V3 && (!Number.isFinite(defaultsVersion) || defaultsVersion < 3);
  const seconds = savedUnderOldDefault ? DEFAULT_DESKTOP_ESCALATION_DELAY_SECONDS : saved;
  return Math.max(0, Math.min(300, seconds)) * 1e3;
}
__name(desktopEscalationDelayMs, "desktopEscalationDelayMs");
function normalizedSnapshotCursor(requestedSince, headRevision, requestedStreamId, currentStreamId) {
  const requested = Math.max(0, Math.trunc(requestedSince) || 0);
  const head = Math.max(0, Math.trunc(headRevision) || 0);
  if (requestedStreamId && currentStreamId && requestedStreamId.trim() !== currentStreamId.trim()) {
    return 0;
  }
  return requested > head ? 0 : requested;
}
__name(normalizedSnapshotCursor, "normalizedSnapshotCursor");
function attentionFullSnapshotUnchanged(existing, incoming, tombstoneCount) {
  if (tombstoneCount > 0 || existing.length !== incoming.length) return false;
  const existingById = new Map(existing.map((item) => [item.item_id, item]));
  return incoming.every((item) => {
    const current = existingById.get(item.id);
    return current != null && Number(current.source_revision) === item.revision && current.fingerprint === item.fingerprint;
  });
}
__name(attentionFullSnapshotUnchanged, "attentionFullSnapshotUnchanged");
function implicitFullSnapshotTombstone(item, incomingItemCount) {
  return {
    id: item.item_id,
    revision: Math.max(0, Number(item.source_revision) || 0),
    // A full snapshot at the transport ceiling cannot distinguish a true
    // removal from an item displaced by a higher-priority row. Keep that
    // omission revivable until a later below-capacity snapshot confirms it.
    revivable: incomingItemCount === MAX_ATTENTION_ITEMS
  };
}
__name(implicitFullSnapshotTombstone, "implicitFullSnapshotTombstone");
function attentionTombstoneBlocksItem(tombstone, itemRevision) {
  return Number(tombstone.revivable) !== 1 && Number(tombstone.source_revision) >= itemRevision;
}
__name(attentionTombstoneBlocksItem, "attentionTombstoneBlocksItem");
function upsertAttentionTombstoneStatement(env, args) {
  return env.DB.prepare(`
    insert into attention_tombstones(
      user_id, item_id, source_revision, account_revision, revivable, deleted_at
    )
    values (
      ?, ?, ?,
      coalesce(
        ?,
        (select revision from attention_revisions where user_id = ?)
      ),
      ?, ?
    )
    on conflict(user_id, item_id) do update set
      source_revision = excluded.source_revision,
      account_revision = excluded.account_revision,
      revivable = case
        when excluded.source_revision > attention_tombstones.source_revision
          then excluded.revivable
        else min(attention_tombstones.revivable, excluded.revivable)
      end,
      deleted_at = excluded.deleted_at
    where excluded.source_revision >= attention_tombstones.source_revision
  `).bind(
    args.userId,
    args.itemId,
    args.sourceRevision,
    args.accountRevision,
    args.userId,
    args.revivable ? 1 : 0,
    args.deletedAt
  );
}
__name(upsertAttentionTombstoneStatement, "upsertAttentionTombstoneStatement");
async function upsertAttentionTombstone(env, args) {
  await upsertAttentionTombstoneStatement(env, args).run();
}
__name(upsertAttentionTombstone, "upsertAttentionTombstone");
function sealCapacityTombstonesStatement(env, userId, machineKey) {
  return env.DB.prepare(`
    update attention_tombstones
    set revivable = 0
    where user_id = ?
      and revivable = 1
      and (
        item_id like ?
        or item_id like ?
        or item_id like ?
      )
  `).bind(
    userId,
    `agent:${machineKey}:%`,
    `pull-request:${machineKey}:%`,
    `message:${machineKey}:%`
  );
}
__name(sealCapacityTombstonesStatement, "sealCapacityTombstonesStatement");
async function sealCapacityTombstones(env, userId, machineKey) {
  await sealCapacityTombstonesStatement(env, userId, machineKey).run();
}
__name(sealCapacityTombstones, "sealCapacityTombstones");
function attentionItemUpsertStatement(env, userId, machineKey, item, rosterEpoch) {
  return env.DB.prepare(`
    insert into attention_items(
      user_id, item_id, machine_key, source_revision, account_revision,
      fingerprint, content_fingerprint, alert_fingerprint, activity_tier,
      roster_epoch, event_kind, phase, payload_json, seen_at, dismissed_at,
      expires_at, updated_at
    )
    select ?, ?, ?, ?, revision, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?
    from attention_revisions
    where user_id = ?
      and not exists (
        select 1
        from attention_tombstones
        where user_id = ? and item_id = ?
          and revivable != 1
          and source_revision >= ?
      )
    on conflict(user_id, item_id) do update set
      machine_key = excluded.machine_key,
      source_revision = excluded.source_revision,
      account_revision = excluded.account_revision,
      fingerprint = excluded.fingerprint,
      content_fingerprint = excluded.content_fingerprint,
      alert_fingerprint = excluded.alert_fingerprint,
      activity_tier = excluded.activity_tier,
      roster_epoch = excluded.roster_epoch,
      event_kind = excluded.event_kind,
      phase = excluded.phase,
      payload_json = excluded.payload_json,
      seen_at = case
        when coalesce(attention_items.alert_fingerprint, attention_items.fingerprint)
          = excluded.alert_fingerprint
          then attention_items.seen_at
        else null
      end,
      dismissed_at = case
        when coalesce(attention_items.alert_fingerprint, attention_items.fingerprint)
          = excluded.alert_fingerprint
          then attention_items.dismissed_at
        else null
      end,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    where excluded.source_revision >= attention_items.source_revision
  `).bind(
    userId,
    item.id,
    machineKey,
    item.revision,
    item.contentFingerprint,
    item.contentFingerprint,
    item.alertFingerprint,
    item.activityTier ?? null,
    rosterEpoch,
    item.eventKind,
    item.phase,
    JSON.stringify(item),
    item.expiresAt,
    item.updatedAt,
    userId,
    userId,
    item.id,
    item.revision
  );
}
__name(attentionItemUpsertStatement, "attentionItemUpsertStatement");
function attentionItemTombstoneDeleteStatement(env, userId, item) {
  return env.DB.prepare(`
    delete from attention_tombstones
    where user_id = ? and item_id = ?
      and (revivable = 1 or source_revision < ?)
  `).bind(userId, item.id, item.revision);
}
__name(attentionItemTombstoneDeleteStatement, "attentionItemTombstoneDeleteStatement");
function attentionTombstoneUpsertForCurrentRevisionStatement(env, args) {
  return env.DB.prepare(`
    insert into attention_tombstones(
      user_id, item_id, source_revision, account_revision, revivable, deleted_at
    )
    select ?, ?, ?, revision, ?, ?
    from attention_revisions
    where user_id = ?
      and not exists (
        select 1
        from attention_items
        where user_id = ? and machine_key = ? and item_id = ?
          and source_revision > ?
      )
    on conflict(user_id, item_id) do update set
      source_revision = excluded.source_revision,
      account_revision = excluded.account_revision,
      revivable = case
        when excluded.source_revision > attention_tombstones.source_revision
          then excluded.revivable
        else min(attention_tombstones.revivable, excluded.revivable)
      end,
      deleted_at = excluded.deleted_at
    where excluded.source_revision >= attention_tombstones.source_revision
  `).bind(
    args.userId,
    args.itemId,
    args.sourceRevision,
    args.revivable ? 1 : 0,
    args.deletedAt,
    args.userId,
    args.userId,
    args.machineKey,
    args.itemId,
    args.sourceRevision
  );
}
__name(attentionTombstoneUpsertForCurrentRevisionStatement, "attentionTombstoneUpsertForCurrentRevisionStatement");
async function commitAttentionMachineChanges(env, args) {
  const statements = [];
  for (const item of args.items) {
    statements.push(
      attentionItemUpsertStatement(
        env,
        args.userId,
        args.machineKey,
        item,
        args.rosterEpoch ?? 0
      ),
      attentionItemTombstoneDeleteStatement(env, args.userId, item)
    );
  }
  if (args.sealCapacityTombstones) {
    statements.push(
      sealCapacityTombstonesStatement(env, args.userId, args.machineKey)
    );
  }
  for (const tombstone of args.tombstones) {
    statements.push(
      env.DB.prepare(`
          delete from attention_items
          where user_id = ? and machine_key = ? and item_id = ? and source_revision <= ?
        `).bind(args.userId, args.machineKey, tombstone.id, tombstone.revision),
      attentionTombstoneUpsertForCurrentRevisionStatement(env, {
        userId: args.userId,
        machineKey: args.machineKey,
        itemId: tombstone.id,
        sourceRevision: tombstone.revision,
        deletedAt: args.now,
        revivable: tombstone.revivable
      })
    );
  }
  return commitAttentionRevision(env, args.userId, statements, args.now);
}
__name(commitAttentionMachineChanges, "commitAttentionMachineChanges");
async function commitActivityReconcileFinal(env, args) {
  return commitAttentionRevision(env, args.userId, [
    env.DB.prepare(`
      insert into attention_tombstones(
        user_id, item_id, source_revision, account_revision, revivable, deleted_at
      )
      select user_id, item_id, source_revision,
        (select revision from attention_revisions where user_id = ?), 0, ?
      from attention_items
      where user_id = ? and machine_key = ? and roster_epoch < ?
      on conflict(user_id, item_id) do update set
        source_revision = excluded.source_revision,
        account_revision = excluded.account_revision,
        revivable = 0,
        deleted_at = excluded.deleted_at
      where excluded.source_revision >= attention_tombstones.source_revision
    `).bind(
      args.userId,
      args.now,
      args.userId,
      args.machineKey,
      args.rosterEpoch
    ),
    env.DB.prepare(`
      delete from attention_items
      where user_id = ? and machine_key = ? and roster_epoch < ?
    `).bind(args.userId, args.machineKey, args.rosterEpoch)
  ], args.now);
}
__name(commitActivityReconcileFinal, "commitActivityReconcileFinal");
function accountMachineActivityTombstoneStatement(env, args) {
  return env.DB.prepare(`
    insert into attention_tombstones(
      user_id, item_id, source_revision, account_revision, revivable, deleted_at
    )
    select user_id, item_id, source_revision,
      (select revision from attention_revisions where user_id = ?), 0, ?
    from attention_items
    where user_id = ? and machine_key = ?
    on conflict(user_id, item_id) do update set
      source_revision = excluded.source_revision,
      account_revision = excluded.account_revision,
      revivable = 0,
      deleted_at = excluded.deleted_at
    where excluded.source_revision >= attention_tombstones.source_revision
  `).bind(args.userId, args.now, args.userId, args.machineKey);
}
__name(accountMachineActivityTombstoneStatement, "accountMachineActivityTombstoneStatement");
function legacyMachineDeliveryPurgeStatements(env, machineKey) {
  return [
    env.DB.prepare("delete from device_registrations where machine_key = ?").bind(machineKey),
    env.DB.prepare("delete from live_activity_tokens where machine_key = ?").bind(machineKey),
    env.DB.prepare("delete from publish_suppression where machine_key = ?").bind(machineKey)
  ];
}
__name(legacyMachineDeliveryPurgeStatements, "legacyMachineDeliveryPurgeStatements");
async function purgeAccountMachineActivity(env, args) {
  const removedItemsRow = await env.DB.prepare(`
    select count(*) as count
    from attention_items
    where user_id = ? and machine_key = ?
  `).bind(args.userId, args.machineKey).first();
  const statements = [
    accountMachineActivityTombstoneStatement(env, args),
    env.DB.prepare("delete from attention_items where user_id = ? and machine_key = ?").bind(args.userId, args.machineKey),
    env.DB.prepare("delete from attention_machine_links where user_id = ? and machine_key = ?").bind(args.userId, args.machineKey)
  ];
  if (args.revoke) {
    statements.push(env.DB.prepare(`
      insert into attention_revoked_machines(user_id, machine_key, revoked_at)
      values (?, ?, ?)
      on conflict(user_id, machine_key) do update set
        revoked_at = excluded.revoked_at
    `).bind(args.userId, args.machineKey, args.now));
    statements.push(...legacyMachineDeliveryPurgeStatements(env, args.machineKey));
  }
  const revision = await commitAttentionRevision(
    env,
    args.userId,
    statements,
    args.now
  );
  const ownedDevices = await env.DB.prepare("select device_id from attention_devices where user_id = ? and source_machine_key = ?").bind(args.userId, args.machineKey).all();
  for (const device of ownedDevices.results) {
    await deleteAttentionDeviceOwnership(env, args.userId, device.device_id);
  }
  await deliverAccountLiveActivity(env, args.userId);
  return {
    revision,
    removedItems: Number(removedItemsRow?.count ?? 0)
  };
}
__name(purgeAccountMachineActivity, "purgeAccountMachineActivity");
async function accountMachineRevokedAt(env, userId, machineKey) {
  const row = await env.DB.prepare(`
      select revoked_at
      from attention_revoked_machines
      where user_id = ? and machine_key = ?
      limit 1
    `).bind(userId, machineKey).first();
  return row?.revoked_at ?? null;
}
__name(accountMachineRevokedAt, "accountMachineRevokedAt");
async function machineKeyRevokedAt(env, machineKey) {
  const row = await env.DB.prepare(`
      select revoked_at
      from attention_revoked_machines
      where machine_key = ?
      order by revoked_at desc
      limit 1
    `).bind(machineKey).first();
  return row?.revoked_at ?? null;
}
__name(machineKeyRevokedAt, "machineKeyRevokedAt");
async function enforceActivityAccountItemCap(env, userId, now) {
  const countRow = await env.DB.prepare(`
    select count(*) as count
    from attention_items
    where user_id = ?
  `).bind(userId).first();
  const overflow = Math.max(
    0,
    Number(countRow?.count ?? 0) - MAX_ACCOUNT_ATTENTION_ITEMS
  );
  if (overflow === 0) return { itemsTruncated: false, revision: null };
  const evictionEligibleCountRow = await env.DB.prepare(`
    select count(*) as count
    from attention_items
    where user_id = ?
      and (activity_tier = 'idle' or activity_tier is null)
  `).bind(userId).first();
  const rowsToRemove = Math.min(
    overflow,
    Number(evictionEligibleCountRow?.count ?? 0)
  );
  if (rowsToRemove === 0) return { itemsTruncated: true, revision: null };
  const revision = await commitAttentionRevision(env, userId, [
    env.DB.prepare(`
      insert into attention_tombstones(
        user_id, item_id, source_revision, account_revision, revivable, deleted_at
      )
      select user_id, item_id, source_revision,
        (select revision from attention_revisions where user_id = ?), 0, ?
      from attention_items
      where user_id = ?
        and (activity_tier = 'idle' or activity_tier is null)
      order by case when activity_tier = 'idle' then 0 else 1 end,
        updated_at asc
      limit ?
      on conflict(user_id, item_id) do update set
        source_revision = excluded.source_revision,
        account_revision = excluded.account_revision,
        revivable = 0,
        deleted_at = excluded.deleted_at
      where excluded.source_revision >= attention_tombstones.source_revision
    `).bind(userId, now, userId, rowsToRemove),
    env.DB.prepare(`
      delete from attention_items
      where user_id = ? and item_id in (
        select item_id
        from attention_items
        where user_id = ?
          and (activity_tier = 'idle' or activity_tier is null)
        order by case when activity_tier = 'idle' then 0 else 1 end,
          updated_at asc
        limit ?
      )
    `).bind(userId, userId, rowsToRemove)
  ], now);
  return { itemsTruncated: true, revision };
}
__name(enforceActivityAccountItemCap, "enforceActivityAccountItemCap");
function resolveScopedDeliveryPreferences(device, scope, preferences) {
  const registered = readPreferences(device.preferences_json);
  const account = isRecord(preferences.account) ? preferences.account : {};
  const projects = isRecord(preferences.projects) ? preferences.projects : {};
  const project = scope.projectId && isRecord(projects[scope.projectId]) ? projects[scope.projectId] : {};
  const machines = isRecord(preferences.machines) ? preferences.machines : {};
  const machine = scope.machineKey && isRecord(machines[scope.machineKey]) ? machines[scope.machineKey] : {};
  const devices = isRecord(preferences.devices) ? preferences.devices : {};
  const explicitDevice = isRecord(devices[device.device_id]) ? devices[device.device_id] : {};
  return { ...registered, ...account, ...project, ...machine, ...explicitDevice };
}
__name(resolveScopedDeliveryPreferences, "resolveScopedDeliveryPreferences");
function resolveActivityDeliveryPreferences(device, item, preferences) {
  return resolveScopedDeliveryPreferences(
    device,
    { projectId: item.project.projectId, machineKey: item.machine.machineKey },
    preferences
  );
}
__name(resolveActivityDeliveryPreferences, "resolveActivityDeliveryPreferences");
function resolvedMutedSessionIds(device, preferences, devicePreferences) {
  const explicitDevice = isRecord(devicePreferences[device.device_id]) ? devicePreferences[device.device_id] : {};
  const muted = [];
  for (const list of [
    preferences.mutedSessionIds,
    explicitDevice.mutedSessionIds,
    readPreferences(device.preferences_json).mutedSessionIds
  ]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string" && entry) muted.push(entry);
    }
  }
  return muted;
}
__name(resolvedMutedSessionIds, "resolvedMutedSessionIds");
function quietHoursActive(device, account, nowMs) {
  const raw = isRecord(device.quietHours) ? device.quietHours : isRecord(account.quietHours) ? account.quietHours : null;
  if (!raw) return false;
  if (raw.enabled === false || device.quietHoursEnabled === false) return false;
  let startMinute = Number(raw.startMinute);
  let endMinute = Number(raw.endMinute);
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) {
    const parseClock = /* @__PURE__ */ __name((value) => {
      if (typeof value !== "string") return null;
      const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
      if (!match) return null;
      const hour2 = Number(match[1]);
      const minute2 = Number(match[2]);
      if (hour2 < 0 || hour2 > 23 || minute2 < 0 || minute2 > 59) return null;
      return hour2 * 60 + minute2;
    }, "parseClock");
    const parsedStart = parseClock(raw.start);
    const parsedEnd = parseClock(raw.end);
    if (parsedStart === null || parsedEnd === null) return false;
    startMinute = parsedStart;
    endMinute = parsedEnd;
  }
  if (startMinute < 0 || startMinute >= 24 * 60 || endMinute < 0 || endMinute >= 24 * 60 || startMinute === endMinute) {
    return false;
  }
  const timeZone = requiredString(raw.timeZone ?? raw.timezone, 120) ?? "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date(nowMs));
    const hour2 = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
    const minute2 = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    const current = hour2 * 60 + minute2;
    return startMinute < endMinute ? current >= startMinute && current < endMinute : current >= startMinute || current < endMinute;
  } catch {
    return false;
  }
}
__name(quietHoursActive, "quietHoursActive");
function alertThreadId(item) {
  const sessionId = itemSessionId(item);
  return sessionId ? `session:${sessionId}` : item.id;
}
__name(alertThreadId, "alertThreadId");
function itemSessionId(item) {
  return item.destination.kind === "session" ? requiredString(item.destination.sessionId) : null;
}
__name(itemSessionId, "itemSessionId");
function stringListIncludes(value, target) {
  if (!target || !Array.isArray(value)) return false;
  return value.some((entry) => typeof entry === "string" && entry === target);
}
__name(stringListIncludes, "stringListIncludes");
async function recentDesktopAttention(env, userId, nowMs) {
  const cutoff = new Date(nowMs - DESKTOP_PRESENCE_WINDOW_MS).toISOString();
  const rows = await env.DB.prepare(`
    select payload_json
    from attention_presence
    where user_id = ? and observed_at >= ?
  `).bind(userId, cutoff).all();
  const visibleItemIds = /* @__PURE__ */ new Set();
  let attended = false;
  let userActive = false;
  for (const row of rows.results) {
    const presence = readPreferences(row.payload_json);
    if (presence.platform === "iOS") continue;
    if (presence.userActive === false) continue;
    if (presence.userActive === true) userActive = true;
    if (presence.appForeground === true) attended = true;
    if (presence.ambientSurfaceVisible !== true) continue;
    if (!Array.isArray(presence.visibleItemIds)) continue;
    for (const itemId of presence.visibleItemIds) {
      if (typeof itemId === "string" && itemId.trim()) visibleItemIds.add(itemId);
    }
  }
  return { visibleItemIds, attended, userActive };
}
__name(recentDesktopAttention, "recentDesktopAttention");
async function claimAttentionNotificationDelivery(env, args) {
  const claimState = `pending:${args.receiptState}`;
  const claimNowMs = Date.now();
  const claim = `${new Date(claimNowMs).toISOString()}|${crypto.randomUUID()}`;
  const staleBefore = new Date(
    claimNowMs - NOTIFICATION_DELIVERY_CLAIM_TTL_MS
  ).toISOString();
  const row = await env.DB.prepare(`
    insert into attention_delivery_receipts(
      user_id, item_id, device_id, state, delivered_at
    ) values (?, ?, ?, ?, ?)
    on conflict(user_id, item_id, device_id, state) do update set
      delivered_at = excluded.delivered_at
    where substr(attention_delivery_receipts.delivered_at, 1, 24) <= ?
    returning delivered_at
  `).bind(
    args.userId,
    args.itemId,
    args.deviceId,
    claimState,
    claim,
    staleBefore
  ).first();
  return row?.delivered_at === claim ? claim : null;
}
__name(claimAttentionNotificationDelivery, "claimAttentionNotificationDelivery");
async function releaseAttentionNotificationDelivery(env, args) {
  await env.DB.prepare(`
    delete from attention_delivery_receipts
    where user_id = ? and item_id = ? and device_id = ?
      and state = ? and delivered_at = ?
  `).bind(
    args.userId,
    args.itemId,
    args.deviceId,
    `pending:${args.receiptState}`,
    args.claim
  ).run();
}
__name(releaseAttentionNotificationDelivery, "releaseAttentionNotificationDelivery");
async function deliverAttentionNotifications(env, userId, items, sendPush = sendApnsPush) {
  const config = apnsConfig(env);
  if (!config || items.length === 0) return;
  const [devicesResult, preferencesRow] = await Promise.all([
    env.DB.prepare(`
      select device_id, apns_token, bundle_id, aps_environment, preferences_json
      from attention_devices
      where user_id = ? and apns_token is not null and lease_expires_at > ?
    `).bind(userId, (/* @__PURE__ */ new Date()).toISOString()).all(),
    env.DB.prepare("select payload_json from attention_preferences where user_id = ? limit 1").bind(userId).first()
  ]);
  if (devicesResult.results.length === 0) return;
  const preferences = readPreferences(preferencesRow?.payload_json);
  const accountPreferences = isRecord(preferences.account) ? preferences.account : {};
  const devicePreferences = isRecord(preferences.devices) ? preferences.devices : {};
  const nowMs = Date.now();
  const desktop = await recentDesktopAttention(env, userId, nowMs);
  const desktopFirstEnabled = preferenceBoolean(
    {},
    accountPreferences,
    "desktopFirstEnabled",
    true
  );
  const desktopFirstDelayMs = desktopEscalationDelayMs(accountPreferences);
  let notificationAttempts = 0;
  for (const item of items) {
    if (item.activityTier && item.activityTier !== "signal") continue;
    if (nowMs - Date.parse(item.updatedAt) > MAX_ALERT_AGE_MS) continue;
    const current = await env.DB.prepare(`
        select source_revision, fingerprint,
          coalesce(alert_fingerprint, fingerprint) as alert_fingerprint,
          seen_at, dismissed_at
        from attention_items
        where user_id = ? and item_id = ?
        limit 1
      `).bind(userId, item.id).first();
    if (!current || Number(current.source_revision) !== item.revision || current.fingerprint !== item.contentFingerprint || current.alert_fingerprint !== item.alertFingerprint || current.seen_at || current.dismissed_at) {
      continue;
    }
    if (desktopFirstEnabled && (desktop.userActive || (desktop.attended || desktop.visibleItemIds.has(item.id)) && nowMs - Date.parse(item.updatedAt) < desktopFirstDelayMs)) {
      continue;
    }
    const deepLink = deepLinkForItem(item);
    for (const device of devicesResult.results) {
      if (notificationAttempts >= MAX_NOTIFICATION_ATTEMPTS_PER_PUBLISH) return;
      if (!device.apns_token) continue;
      const override = resolveActivityDeliveryPreferences(
        device,
        item,
        preferences
      );
      const eventPolicies = isRecord(override.eventPolicies) ? override.eventPolicies : {};
      const policy = item.kind === "message" ? "notify" : effectiveEventPolicy(item.eventKind, eventPolicies, override);
      if (policy !== "notify") continue;
      const notificationsEnabled = preferenceBoolean(
        override,
        {},
        "notificationsEnabled",
        typeof override.enabled === "boolean" ? override.enabled : true
      );
      if (!notificationsEnabled || quietHoursActive(override, accountPreferences, nowMs) || stringListIncludes(
        resolvedMutedSessionIds(device, preferences, devicePreferences),
        itemSessionId(item)
      )) {
        continue;
      }
      const receiptState = `alert:${item.alertFingerprint.slice(0, 48)}`;
      const existing = await env.DB.prepare(`
        select 1 as found from (
          select 1
          from attention_delivery_receipts
          where user_id = ? and item_id = ? and device_id = ? and state = ?
          union all
          select 1
          from attention_alert_log
          where user_id = ? and alert_fingerprint = ? and device_id = ?
        )
        limit 1
      `).bind(
        userId,
        item.id,
        device.device_id,
        receiptState,
        userId,
        item.alertFingerprint,
        device.device_id
      ).first();
      if (existing?.found) continue;
      const deliveryClaim = await claimAttentionNotificationDelivery(env, {
        userId,
        itemId: item.id,
        deviceId: device.device_id,
        receiptState
      });
      if (!deliveryClaim) continue;
      const hideDetails = preferenceBoolean(override, accountPreferences, "hideDetails", false);
      const soundsEnabled = preferenceBoolean(override, accountPreferences, "soundsEnabled", false);
      const copy = attentionAlertCopy(item, hideDetails);
      const approvalCategory = item.kind === "agent" && Array.isArray(item.actions) && item.actions.some((action) => isRecord(action) && action.kind === "approve") && item.actions.some((action) => isRecord(action) && action.kind === "deny");
      let result;
      try {
        result = await sendPush(config, {
          environment: device.aps_environment,
          deviceToken: device.apns_token,
          topic: device.bundle_id || env.APNS_DEFAULT_TOPIC?.trim() || "",
          pushType: "alert",
          priority: 10,
          expiration: Math.floor(nowMs / 1e3) + 24 * 60 * 60,
          collapseId: item.id,
          payload: {
            aps: {
              alert: {
                title: copy.title,
                ...copy.body ? { body: copy.body } : {}
              },
              // Approve and Deny on the banner. The payload's
              // `accountMachineKey` tells the phone which machine to answer.
              ...approvalCategory ? { category: "ADE_APPROVAL" } : {},
              ...soundsEnabled ? { sound: "default" } : {},
              // Wakes the app for a background snapshot refresh alongside the
              // visible alert; foreground polling remains the guaranteed path.
              "content-available": 1,
              "thread-id": alertThreadId(item),
              "interruption-level": item.eventKind === "agent_needs_you" ? "time-sensitive" : "active"
            },
            ...attentionAlertRoutingPayload(item, deepLink)
          }
        });
      } catch (error2) {
        notificationAttempts += 1;
        await releaseAttentionNotificationDelivery(env, {
          userId,
          itemId: item.id,
          deviceId: device.device_id,
          receiptState,
          claim: deliveryClaim
        });
        logAttentionDeliveryError("notification", device.device_id, error2);
        continue;
      }
      notificationAttempts += 1;
      if (result.ok) {
        await env.DB.batch([
          env.DB.prepare(`
            insert into attention_delivery_receipts(
              user_id, item_id, device_id, state, delivered_at
            )
            values (?, ?, ?, ?, ?)
            on conflict(user_id, item_id, device_id, state) do nothing
          `).bind(
            userId,
            item.id,
            device.device_id,
            receiptState,
            new Date(nowMs).toISOString()
          ),
          env.DB.prepare(`
            insert into attention_alert_log(
              user_id, alert_fingerprint, device_id, delivered_at
            ) values (?, ?, ?, ?)
            on conflict(user_id, alert_fingerprint, device_id) do nothing
          `).bind(
            userId,
            item.alertFingerprint,
            device.device_id,
            new Date(nowMs).toISOString()
          ),
          env.DB.prepare(`
            delete from attention_delivery_receipts
            where user_id = ? and item_id = ? and device_id = ?
              and state = ? and delivered_at = ?
          `).bind(
            userId,
            item.id,
            device.device_id,
            `pending:${receiptState}`,
            deliveryClaim
          )
        ]);
      } else {
        await releaseAttentionNotificationDelivery(env, {
          userId,
          itemId: item.id,
          deviceId: device.device_id,
          receiptState,
          claim: deliveryClaim
        });
      }
      if (!result.ok && result.tokenInvalid) {
        await env.DB.prepare(`
          update attention_devices
          set apns_token = null, updated_at = ?
          where user_id = ? and device_id = ? and apns_token = ?
        `).bind(
          new Date(nowMs).toISOString(),
          userId,
          device.device_id,
          device.apns_token
        ).run();
      }
    }
  }
}
__name(deliverAttentionNotifications, "deliverAttentionNotifications");
var ALERT_LINE_MAX = 64;
var ALERT_STATE_LABEL = {
  agent_needs_you: "Needs you",
  agent_failed: "Failed",
  agent_completed: "Done",
  agent_running: "Working",
  pr_checks_failing: "Checks failing",
  pr_review_requested: "Review requested",
  pr_changes_requested: "Changes requested",
  pr_merge_ready: "Ready to merge",
  pr_merged: "Merged",
  pr_opened: "Opened",
  pr_closed: "Closed"
};
function alertLine(value, max = ALERT_LINE_MAX) {
  const text2 = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text2) return null;
  return text2.length > max ? `${text2.slice(0, max - 1).trimEnd()}\u2026` : text2;
}
__name(alertLine, "alertLine");
function attentionAlertCopy(item, hideDetails) {
  if (item.kind === "message") {
    const title = alertLine(item.title) ?? "ADE";
    const body = alertLine(item.preview, CUSTOM_NOTIFICATION_BODY_MAX);
    return { title, body: hideDetails || !body || body === title ? null : body };
  }
  const state = ALERT_STATE_LABEL[item.eventKind] ?? "Update";
  if (hideDetails) {
    return {
      title: item.kind === "pull_request" ? `Pull request: ${state}` : `Agent: ${state}`,
      body: null
    };
  }
  const project = alertLine(item.project?.name);
  const machine = alertLine(item.machine?.name);
  if (item.kind === "pull_request") {
    const number = isRecord(item.destination) ? Number(item.destination.number) : Number.NaN;
    const prTitle = alertLine(item.preview);
    const title = Number.isSafeInteger(number) && number > 0 ? alertLine(prTitle ? `#${number} ${prTitle}` : `Pull request #${number}`) : alertLine(item.title);
    return {
      title: title ?? "Pull request",
      body: alertLine([state, project].filter(Boolean).join(" \xB7 "))
    };
  }
  return {
    title: alertLine(item.title) ?? "ADE agent",
    body: alertLine([state, project, machine].filter(Boolean).join(" \xB7 "))
  };
}
__name(attentionAlertCopy, "attentionAlertCopy");
function secretsMatch(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
__name(secretsMatch, "secretsMatch");
function assertDirectoryProvenance(request, env) {
  const expected = env.DIRECTORY_AUTH_SECRET?.trim();
  if (!expected) {
    return {
      response: json({
        ok: false,
        error: "directory authentication unavailable",
        code: "directory_auth_unavailable",
        recovery: "DIRECTORY_AUTH_SECRET must be configured on the relay by the ADE service owner."
      }, { status: 503 })
    };
  }
  const presented = request.headers.get("x-ade-directory-auth")?.trim();
  if (!presented || !secretsMatch(presented, expected)) {
    return {
      response: json({
        ok: false,
        error: "directory provenance required",
        code: "directory_auth_required",
        recovery: "Pair this machine from ADE's account settings; a machine cannot restore its own pairing."
      }, { status: 403 })
    };
  }
  return { ok: true };
}
__name(assertDirectoryProvenance, "assertDirectoryProvenance");
async function authorizedUser(request, env) {
  const configuration = inspectAttentionAuthConfiguration(env);
  if (!configuration.configured) {
    return {
      response: json(
        {
          ok: false,
          error: "account authentication unavailable",
          code: "account_auth_unavailable",
          recovery: "Relay authentication must be configured by the ADE service owner."
        },
        { status: 503 }
      )
    };
  }
  let userId;
  try {
    userId = await verifyAttentionBearerToken(request, env);
  } catch (error2) {
    if (error2 instanceof AttentionAuthVerificationUnavailableError) {
      return {
        response: json(
          {
            ok: false,
            error: "account authentication unavailable",
            code: "account_auth_unavailable",
            recovery: "ADE's account verifier is temporarily unreachable. Retry shortly."
          },
          { status: 503 }
        )
      };
    }
    throw error2;
  }
  return userId ? { userId } : {
    response: json(
      {
        ok: false,
        error: "account token rejected",
        code: "account_token_rejected",
        recovery: "Refresh the ADE account session and try again."
      },
      { status: 401 }
    )
  };
}
__name(authorizedUser, "authorizedUser");
function parseAttentionItem(value, machineKey) {
  if (!isRecord(value) || value.contractVersion !== 1) return null;
  const id = requiredString(value.id);
  const revision = Number(value.revision);
  const fingerprint = requiredString(value.fingerprint);
  const contentFingerprint = value.contentFingerprint == null ? fingerprint : requiredString(value.contentFingerprint);
  const alertFingerprint = value.alertFingerprint == null ? fingerprint : requiredString(value.alertFingerprint);
  const activityTier = value.activityTier == null ? void 0 : value.activityTier;
  const chatActivityMode = value.chatActivityMode === "planning" ? "planning" : void 0;
  const boardColumn = value.kind === "agent" && isActivityBoardColumn(value.boardColumn) ? value.boardColumn : void 0;
  const waitingReason = boardColumn === "waiting" && isActivityWaitingReason(value.waitingReason) ? value.waitingReason : void 0;
  const kind = value.kind;
  const eventKind = requiredString(value.eventKind, 64);
  const phase = requiredString(value.phase, 64);
  const title = boundedText(value.title, MAX_TITLE_LENGTH);
  const preview = boundedText(value.preview, MAX_PREVIEW_LENGTH);
  const privacyPreview = boundedText(value.privacyPreview, MAX_PREVIEW_LENGTH);
  const updatedAt = optionalIsoDate(value.updatedAt);
  const occurredAt = optionalIsoDate(value.occurredAt);
  const statusSince = optionalIsoDate(value.statusSince);
  const expiresAt = optionalIsoDate(value.expiresAt);
  if (!id || !Number.isSafeInteger(revision) || revision < 0 || !fingerprint || !contentFingerprint || !alertFingerprint || activityTier !== void 0 && activityTier !== "signal" && activityTier !== "ambient" && activityTier !== "idle" || kind !== "agent" && kind !== "pull_request" && kind !== "message" || !eventKind || !EVENT_KINDS.has(eventKind) || kind === "agent" && (!eventKind.startsWith("agent_") || eventKind === "agent_message") || kind === "pull_request" && !eventKind.startsWith("pr_") || kind === "message" && eventKind !== "agent_message" || !phase || !PHASES.has(phase) || !title || !preview || !privacyPreview || !updatedAt || !occurredAt || statusSince === void 0 || expiresAt === void 0 || !isRecord(value.machine) || requiredString(value.machine.machineKey) !== machineKey) {
    return null;
  }
  const expectedIdPrefix = kind === "agent" ? `agent:${machineKey}:` : kind === "message" ? `message:${machineKey}:` : `pull-request:${machineKey}:`;
  if (!id.startsWith(expectedIdPrefix)) return null;
  const machineName = boundedText(value.machine.name, 120);
  const accountMachineKey = value.machine.accountMachineKey == null ? null : requiredString(value.machine.accountMachineKey, 128);
  const deviceId = value.machine.deviceId == null ? null : requiredString(value.machine.deviceId, 128);
  if (accountMachineKey !== null && !/^[a-f0-9]{32,64}$/i.test(accountMachineKey) || value.machine.deviceId != null && !deviceId) {
    return null;
  }
  if (!machineName || !isRecord(value.project) || !isRecord(value.destination)) return null;
  const projectId = requiredString(value.project.projectId);
  const projectName = boundedText(value.project.name, 160);
  const rootPath = value.project.rootPath == null ? null : boundedText(value.project.rootPath, 1e3);
  const canonicalId = value.project.canonicalId == null ? null : requiredString(value.project.canonicalId);
  if (!projectId || !projectName || value.project.rootPath != null && !rootPath) return null;
  let destination;
  if (kind === "agent" || kind === "message") {
    const sessionId = requiredString(value.destination.sessionId);
    const itemId = value.destination.itemId == null ? null : requiredString(value.destination.itemId);
    const eventId = value.destination.eventId == null ? null : requiredString(value.destination.eventId);
    if (value.destination.kind !== "session" || !sessionId || value.destination.itemId != null && !itemId || value.destination.eventId != null && !eventId) {
      return null;
    }
    destination = { kind: "session", sessionId, itemId, eventId };
  } else {
    const number = Number(value.destination.number);
    const prId = value.destination.prId == null ? null : requiredString(value.destination.prId);
    const repoOwner = value.destination.repoOwner == null ? null : requiredString(value.destination.repoOwner);
    const repoName = value.destination.repoName == null ? null : requiredString(value.destination.repoName);
    const tab = requiredString(value.destination.tab, 32);
    const eventId = value.destination.eventId == null ? null : requiredString(value.destination.eventId);
    if (value.destination.kind !== "pull_request" || !Number.isSafeInteger(number) || number <= 0 || !tab || !PR_TABS.has(tab) || value.destination.prId != null && !prId || value.destination.repoOwner != null && !repoOwner || value.destination.repoName != null && !repoName || value.destination.eventId != null && !eventId) {
      return null;
    }
    destination = {
      kind: "pull_request",
      prId,
      repoOwner,
      repoName,
      number,
      tab,
      eventId
    };
  }
  if (!Array.isArray(value.actions) || value.actions.length > 8) return null;
  const actions = value.actions.map((rawAction) => {
    if (!isRecord(rawAction)) return null;
    const actionId = requiredString(rawAction.id, 64);
    const actionKind = requiredString(rawAction.kind, 64);
    const label = boundedText(rawAction.label, 80);
    if (!actionId || !actionKind || !ACTION_KINDS.has(actionKind) || !label) return null;
    let payload;
    if (rawAction.payload !== void 0) {
      if (!isRecord(rawAction.payload) || Object.keys(rawAction.payload).length > 16) return null;
      payload = {};
      for (const [rawKey, rawValue] of Object.entries(rawAction.payload)) {
        const key = requiredString(rawKey, 64);
        if (!key) return null;
        if (typeof rawValue === "string") {
          const text2 = boundedText(rawValue, MAX_PREVIEW_LENGTH);
          if (!text2) return null;
          payload[key] = text2;
        } else if (rawValue === null || typeof rawValue === "boolean" || typeof rawValue === "number" && Number.isFinite(rawValue)) {
          payload[key] = rawValue;
        } else {
          return null;
        }
      }
    }
    return {
      id: actionId,
      kind: actionKind,
      label,
      ...rawAction.destructive === true ? { destructive: true } : {},
      ...payload ? { payload } : {}
    };
  });
  if (actions.some((action) => action === null)) return null;
  const recentActivity = Array.isArray(value.recentActivity) ? value.recentActivity.map((entry) => boundedText(entry, MAX_PREVIEW_LENGTH)).filter((entry) => Boolean(entry)).slice(0, 5) : void 0;
  const detail = value.detail == null ? null : boundedText(value.detail, MAX_DETAIL_LENGTH);
  if (value.detail != null && !detail) return null;
  const planProgress = value.planProgress == null ? null : isRecord(value.planProgress) ? {
    completed: Number(value.planProgress.completed),
    total: Number(value.planProgress.total),
    current: value.planProgress.current == null ? null : boundedText(value.planProgress.current, MAX_PREVIEW_LENGTH)
  } : void 0;
  if (planProgress === void 0 || planProgress !== null && (!Number.isSafeInteger(planProgress.completed) || !Number.isSafeInteger(planProgress.total) || planProgress.completed < 0 || planProgress.total < 0 || planProgress.total > 1e4 || planProgress.completed > planProgress.total || value.planProgress != null && isRecord(value.planProgress) && value.planProgress.current != null && !planProgress.current)) {
    return null;
  }
  const laneId = value.laneId == null ? null : requiredString(value.laneId);
  const laneName = value.laneName == null ? null : boundedText(value.laneName, 160);
  const provider = value.provider == null ? null : boundedText(value.provider, 120);
  const model = value.model == null ? null : boundedText(value.model, 160);
  if (value.laneId != null && !laneId || value.laneName != null && !laneName || value.provider != null && !provider || value.model != null && !model) {
    return null;
  }
  return {
    contractVersion: 1,
    id,
    revision,
    fingerprint: contentFingerprint,
    contentFingerprint,
    alertFingerprint,
    ...activityTier ? { activityTier } : {},
    ...chatActivityMode ? { chatActivityMode } : {},
    ...boardColumn ? { boardColumn } : {},
    ...waitingReason ? { waitingReason } : {},
    kind,
    eventKind,
    phase,
    title,
    preview,
    privacyPreview,
    detail,
    recentActivity,
    planProgress,
    laneId,
    laneName,
    provider,
    model,
    destination,
    actions,
    updatedAt,
    occurredAt,
    statusSince,
    // Idle roster rows used to have their expiry stripped here, which is how a
    // machine's ambient rows outlived the machine: nothing but that machine's
    // own reconcile could ever remove them. Honor whatever lifetime the
    // publisher stamps — `null` still means "until reconciled".
    expiresAt,
    seenAt: null,
    dismissedAt: null,
    machine: {
      machineKey,
      accountMachineKey,
      deviceId,
      name: machineName,
      online: true,
      lastSeenAt: null
    },
    project: {
      projectId,
      canonicalId,
      name: projectName,
      rootPath
    }
  };
}
__name(parseAttentionItem, "parseAttentionItem");
function attentionRevisionBumpStatement(env, userId, now) {
  return env.DB.prepare(`
    insert into attention_revisions(user_id, revision, updated_at)
    values (?, 1, ?)
    on conflict(user_id) do update set
      revision = attention_revisions.revision + 1,
      updated_at = excluded.updated_at
    returning revision
  `).bind(userId, now);
}
__name(attentionRevisionBumpStatement, "attentionRevisionBumpStatement");
async function commitAttentionRevision(env, userId, statements, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const [revisionResult, ...mutationResults] = await env.DB.batch([
    attentionRevisionBumpStatement(env, userId, now),
    ...statements
  ]);
  if (!revisionResult?.success || mutationResults.some((result) => !result.success)) {
    throw new Error("attention revision transaction failed");
  }
  const revision = Number(revisionResult.results[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("attention revision transaction did not return a revision");
  }
  return revision;
}
__name(commitAttentionRevision, "commitAttentionRevision");
function attentionDeviceOwnershipDeleteStatements(env, userId, deviceId) {
  return [
    env.DB.prepare("delete from attention_activity_tokens where user_id = ? and device_id = ?").bind(userId, deviceId),
    env.DB.prepare("delete from attention_activity_state where user_id = ? and device_id = ?").bind(userId, deviceId),
    env.DB.prepare("delete from attention_delivery_receipts where user_id = ? and device_id = ?").bind(userId, deviceId),
    env.DB.prepare("delete from attention_presence where user_id = ? and device_id = ?").bind(userId, deviceId),
    env.DB.prepare(`
        update attention_device_ownership
        set active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        where user_id = ? and device_id = ?
      `).bind(userId, deviceId),
    env.DB.prepare("delete from attention_devices where user_id = ? and device_id = ?").bind(userId, deviceId)
  ];
}
__name(attentionDeviceOwnershipDeleteStatements, "attentionDeviceOwnershipDeleteStatements");
function isAttentionDeviceLimitError(error2) {
  return error2 instanceof Error && error2.message.includes("attention account device limit reached");
}
__name(isAttentionDeviceLimitError, "isAttentionDeviceLimitError");
function isStaleAttentionDeviceOwnershipError(error2) {
  return error2 instanceof Error && error2.message.includes("stale attention device ownership");
}
__name(isStaleAttentionDeviceOwnershipError, "isStaleAttentionDeviceOwnershipError");
function parsedOwnershipEpoch(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= Date.now() + MAX_OWNERSHIP_EPOCH_FUTURE_MS ? value : null;
}
__name(parsedOwnershipEpoch, "parsedOwnershipEpoch");
async function attentionDeviceOwnershipRows(env, deviceId, apnsToken) {
  const result = apnsToken ? await env.DB.prepare(`
        select device_id, user_id, ownership_epoch, apns_token, device_key_hash,
          pending_device_key_hash
        from attention_device_ownership
        where device_id = ? or apns_token = ?
      `).bind(deviceId, apnsToken).all() : await env.DB.prepare(`
        select device_id, user_id, ownership_epoch, apns_token, device_key_hash,
          pending_device_key_hash
        from attention_device_ownership
        where device_id = ?
      `).bind(deviceId).all();
  return result.results;
}
__name(attentionDeviceOwnershipRows, "attentionDeviceOwnershipRows");
function staleAttentionDeviceOwnershipEpoch(rows, userId, ownershipEpoch) {
  const conflict = rows.some((row) => {
    const currentEpoch = Number(row.ownership_epoch);
    return currentEpoch > ownershipEpoch || currentEpoch === ownershipEpoch && row.user_id !== userId;
  });
  if (!conflict) return null;
  return rows.reduce(
    (latest, row) => Math.max(latest, Number(row.ownership_epoch) || 0),
    ownershipEpoch
  );
}
__name(staleAttentionDeviceOwnershipEpoch, "staleAttentionDeviceOwnershipEpoch");
function attentionDeviceOwnershipConflict(ownershipEpoch) {
  return json({
    ok: false,
    error: "stale device ownership",
    ownershipEpoch
  }, { status: 409 });
}
__name(attentionDeviceOwnershipConflict, "attentionDeviceOwnershipConflict");
function attentionDeviceOwnershipUnproven() {
  return json({ ok: false, error: "stale device ownership" }, { status: 409 });
}
__name(attentionDeviceOwnershipUnproven, "attentionDeviceOwnershipUnproven");
function mintDeviceKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(mintDeviceKey, "mintDeviceKey");
async function parsedDeviceKeyRequest(payload) {
  const presented = typeof payload.deviceKey === "string" && DEVICE_KEY_PATTERN.test(payload.deviceKey) ? payload.deviceKey : null;
  return {
    supported: payload.deviceKeySupported === true,
    presentedKeyHash: presented ? await sha256Hex(presented) : null
  };
}
__name(parsedDeviceKeyRequest, "parsedDeviceKeyRequest");
function deviceKeyHashMatches(storedHash, presentedKeyHash) {
  return Boolean(storedHash && presentedKeyHash && constantTimeEqual(storedHash, presentedKeyHash));
}
__name(deviceKeyHashMatches, "deviceKeyHashMatches");
function attentionDeviceOwnershipProven(row, userId, presentedKeyHash, presentedApnsToken) {
  if (!row || row.user_id === userId) return true;
  if (deviceKeyHashMatches(row.device_key_hash, presentedKeyHash) || deviceKeyHashMatches(row.pending_device_key_hash, presentedKeyHash)) {
    return true;
  }
  if (row.device_key_hash) return false;
  if (row.apns_token) {
    return presentedApnsToken !== null && constantTimeEqual(row.apns_token, presentedApnsToken);
  }
  return true;
}
__name(attentionDeviceOwnershipProven, "attentionDeviceOwnershipProven");
async function attentionDeviceKeyChange(row, deviceKey) {
  const matchesConfirmed = deviceKeyHashMatches(row?.device_key_hash, deviceKey.presentedKeyHash);
  if (!matchesConfirmed && deviceKey.presentedKeyHash && deviceKeyHashMatches(row?.pending_device_key_hash, deviceKey.presentedKeyHash)) {
    return { confirmedHash: deviceKey.presentedKeyHash, pendingHash: null, mintedKey: null };
  }
  if (matchesConfirmed || !deviceKey.supported) return null;
  const mintedKey = mintDeviceKey();
  return { confirmedHash: null, pendingHash: await sha256Hex(mintedKey), mintedKey };
}
__name(attentionDeviceKeyChange, "attentionDeviceKeyChange");
function attentionDeviceOwnershipUpsertStatement(env, args) {
  const keysUnchangedSinceRead = `
    ? = 1
    and attention_device_ownership.device_key_hash is ?
    and attention_device_ownership.pending_device_key_hash is ?
  `;
  const observedKeys = [
    args.keyChange ? 1 : 0,
    args.observed?.device_key_hash ?? null,
    args.observed?.pending_device_key_hash ?? null
  ];
  return env.DB.prepare(`
    insert into attention_device_ownership(
      device_id, user_id, ownership_epoch, apns_token, active, updated_at,
      device_key_hash, pending_device_key_hash
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(device_id) do update set
      user_id = excluded.user_id,
      ownership_epoch = excluded.ownership_epoch,
      apns_token = coalesce(excluded.apns_token, attention_device_ownership.apns_token),
      active = excluded.active,
      updated_at = excluded.updated_at,
      device_key_hash = case
        when ${keysUnchangedSinceRead}
          then coalesce(excluded.device_key_hash, attention_device_ownership.device_key_hash)
        else attention_device_ownership.device_key_hash
      end,
      pending_device_key_hash = case
        when ${keysUnchangedSinceRead}
          then excluded.pending_device_key_hash
        else attention_device_ownership.pending_device_key_hash
      end
    where (
        excluded.ownership_epoch > attention_device_ownership.ownership_epoch
        or (
          excluded.ownership_epoch = attention_device_ownership.ownership_epoch
          and excluded.user_id = attention_device_ownership.user_id
        )
      )
      and (
        excluded.user_id = attention_device_ownership.user_id
        or (
          attention_device_ownership.user_id is ?
          and attention_device_ownership.device_key_hash is ?
          and attention_device_ownership.apns_token is ?
        )
      )
    returning pending_device_key_hash
  `).bind(
    args.deviceId,
    args.userId,
    args.ownershipEpoch,
    args.apnsToken,
    args.active ? 1 : 0,
    args.updatedAt,
    args.keyChange?.confirmedHash ?? null,
    args.keyChange?.pendingHash ?? null,
    ...observedKeys,
    ...observedKeys,
    args.observed?.user_id ?? null,
    args.observed?.device_key_hash ?? null,
    args.observed?.apns_token ?? null
  );
}
__name(attentionDeviceOwnershipUpsertStatement, "attentionDeviceOwnershipUpsertStatement");
function attentionDeviceOwnershipAssertStatement(env, deviceId, userId, ownershipEpoch) {
  return env.DB.prepare(`
    update attention_device_ownership
    set ownership_epoch = 0
    where device_id = ?
      and not (user_id = ? and ownership_epoch = ?)
  `).bind(deviceId, userId, ownershipEpoch);
}
__name(attentionDeviceOwnershipAssertStatement, "attentionDeviceOwnershipAssertStatement");
function issuedDeviceKey(keyChange, upsertResult) {
  const storedHash = upsertResult?.results?.[0]?.pending_device_key_hash ?? null;
  return keyChange?.mintedKey && keyChange.pendingHash && storedHash === keyChange.pendingHash ? keyChange.mintedKey : null;
}
__name(issuedDeviceKey, "issuedDeviceKey");
function isAttentionDeviceOwnershipAssertError(error2) {
  return error2 instanceof Error && error2.message.includes("CHECK constraint failed") && error2.message.includes("ownership_epoch");
}
__name(isAttentionDeviceOwnershipAssertError, "isAttentionDeviceOwnershipAssertError");
function releasePriorApnsOwnershipStatement(env, args) {
  return env.DB.prepare(`
    update attention_device_ownership
    set apns_token = null, active = 0, updated_at = ?
    where apns_token = ?
      and device_id <> ?
      and (
        ownership_epoch < ?
        or (ownership_epoch = ? and user_id = ?)
      )
  `).bind(
    args.updatedAt,
    args.apnsToken,
    args.deviceId,
    args.ownershipEpoch,
    args.ownershipEpoch,
    args.userId
  );
}
__name(releasePriorApnsOwnershipStatement, "releasePriorApnsOwnershipStatement");
async function latestAttentionDeviceOwnershipEpoch(env, deviceId, apnsToken, fallback) {
  const rows = await attentionDeviceOwnershipRows(env, deviceId, apnsToken);
  return rows.reduce(
    (latest, row) => Math.max(latest, Number(row.ownership_epoch) || 0),
    fallback
  );
}
__name(latestAttentionDeviceOwnershipEpoch, "latestAttentionDeviceOwnershipEpoch");
async function linkMachineToAccount(env, userId, machineKey, machineName) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const previous = await env.DB.prepare(`
      select user_id, legacy_devices_imported_at
      from attention_machine_links
      where machine_key = ?
      limit 1
    `).bind(machineKey).first();
  const freshOwnership = !previous || previous.user_id !== userId;
  const priorClaim = previous ? null : await env.DB.prepare("select account_user_id from machines where machine_key = ? limit 1").bind(machineKey).first();
  const previousOwnerUserId = previous?.user_id ?? priorClaim?.account_user_id ?? null;
  const staleRevocations = await env.DB.prepare(`
      select user_id
      from attention_revoked_machines
      where machine_key = ? and user_id <> ?
    `).bind(machineKey, userId).all();
  const ownershipChanged = previousOwnerUserId != null && previousOwnerUserId !== userId;
  if (ownershipChanged || staleRevocations.results.length > 0) {
    await env.DB.batch([
      ...legacyMachineDeliveryPurgeStatements(env, machineKey),
      env.DB.prepare("delete from attention_revoked_machines where machine_key = ? and user_id <> ?").bind(machineKey, userId)
    ]);
  }
  if (previous?.user_id && previous.user_id !== userId) {
    const previousItems = await env.DB.prepare(`
        select item_id, source_revision
        from attention_items
        where machine_key = ? and user_id = ?
      `).bind(machineKey, previous.user_id).all();
    if (previousItems.results.length > 0) {
      const statements = [
        env.DB.prepare("delete from attention_items where machine_key = ? and user_id = ?").bind(machineKey, previous.user_id),
        ...previousItems.results.map((item) => attentionTombstoneUpsertForCurrentRevisionStatement(env, {
          userId: previous.user_id,
          machineKey,
          itemId: item.item_id,
          sourceRevision: Number(item.source_revision),
          deletedAt: now,
          revivable: false
        }))
      ];
      await commitAttentionRevision(env, previous.user_id, statements, now);
    }
    const previousDevices = await env.DB.prepare("select device_id from attention_devices where user_id = ? and source_machine_key = ?").bind(previous.user_id, machineKey).all();
    for (const device of previousDevices.results) {
      await deleteAttentionDeviceOwnership(env, previous.user_id, device.device_id);
    }
    if (previousItems.results.length > 0) {
      await deliverAccountLiveActivity(env, previous.user_id);
    }
  }
  if (freshOwnership) {
    await env.DB.prepare(`
      delete from attention_tombstones
      where user_id = ?
        and (
          item_id like ?
          or item_id like ?
          or item_id like ?
        )
    `).bind(
      userId,
      `agent:${machineKey}:%`,
      `pull-request:${machineKey}:%`,
      `message:${machineKey}:%`
    ).run();
  }
  await env.DB.prepare(`
    insert into attention_machine_links(
      machine_key, user_id, machine_name, last_seen_at, linked_at,
      legacy_devices_imported_at
    )
    values (?, ?, ?, ?, ?, null)
    on conflict(machine_key) do update set
      user_id = excluded.user_id,
      machine_name = excluded.machine_name,
      last_seen_at = excluded.last_seen_at
  `).bind(machineKey, userId, machineName, now, now).run();
  await env.DB.prepare("update machines set account_user_id = ? where machine_key = ? and account_user_id is not ?").bind(userId, machineKey, userId).run();
  if (previous?.legacy_devices_imported_at) return;
  const leaseExpiresAt = new Date(Date.now() + ATTENTION_DEVICE_LEASE_MS).toISOString();
  const existingDeviceCount = await env.DB.prepare("select count(*) as count from attention_devices where user_id = ?").bind(userId).first();
  const availableSlots = Math.max(
    0,
    MAX_ATTENTION_DEVICES - Number(existingDeviceCount?.count ?? 0)
  );
  await env.DB.batch([
    env.DB.prepare(`
      insert or ignore into attention_devices(
        user_id, device_id, source_machine_key, apns_token, push_to_start_token,
        bundle_id, aps_environment, platform, device_name, preferences_json,
        registered_at, updated_at, lease_expires_at, generation
      )
      select ?, legacy.device_id, ?, legacy.apns_token,
        legacy.push_to_start_token, legacy.bundle_id, aps_environment, platform,
        device_name, '{}', registered_at, updated_at, ?,
        lower(hex(randomblob(16)))
      from device_registrations as legacy
      where legacy.machine_key = ?
        and not exists (
          select 1
          from attention_devices as owned
          where owned.device_id = legacy.device_id
            or (
              legacy.apns_token is not null
              and owned.apns_token = legacy.apns_token
            )
        )
        and not exists (
          select 1
          from attention_device_ownership as ownership
          where ownership.device_id = legacy.device_id
            or (
              legacy.apns_token is not null
              and ownership.apns_token = legacy.apns_token
            )
        )
      limit ?
    `).bind(userId, machineKey, leaseExpiresAt, machineKey, availableSlots),
    env.DB.prepare(`
      insert or ignore into attention_device_ownership(
        device_id, user_id, ownership_epoch, apns_token, active, updated_at
      )
      select device.device_id, ?, 1, device.apns_token, 1, ?
      from attention_devices as device
      where device.user_id = ? and device.source_machine_key = ?
    `).bind(userId, now, userId, machineKey),
    env.DB.prepare(`
      insert or ignore into attention_activity_tokens(
        user_id, device_id, activity_id, token, updated_at
      )
      select ?, token.device_id, token.activity_id, token.token, token.updated_at
      from live_activity_tokens as token
      join attention_devices as device
        on device.user_id = ?
        and device.device_id = token.device_id
        and device.source_machine_key = ?
      where token.machine_key = ?
    `).bind(userId, userId, machineKey, machineKey),
    env.DB.prepare(`
      insert or ignore into attention_activity_state(
        user_id, device_id, activity_id, started, fingerprint, updated_at
      )
      select ?, token.device_id, token.activity_id, 1, null, token.updated_at
      from live_activity_tokens as token
      join attention_devices as device
        on device.user_id = ?
        and device.device_id = token.device_id
        and device.source_machine_key = ?
      where token.machine_key = ?
    `).bind(userId, userId, machineKey, machineKey),
    env.DB.prepare(`
      update attention_machine_links
      set legacy_devices_imported_at = ?
      where machine_key = ? and user_id = ?
    `).bind(now, machineKey, userId)
  ]);
}
__name(linkMachineToAccount, "linkMachineToAccount");
async function refreshActivityMachinePresence(env, args) {
  const touched = await withCloudflareRetry(() => env.DB.prepare(`
    update attention_machine_links
       set machine_name = ?, last_seen_at = ?
     where machine_key = ? and user_id = ?
  `).bind(args.machineName, args.now, args.machineKey, args.userId).run());
  if ((touched.meta?.changes ?? 0) > 0) return;
  await withCloudflareRetry(() => env.DB.prepare(`
    insert into attention_machine_links(
      machine_key, user_id, machine_name, last_seen_at, linked_at,
      legacy_devices_imported_at
    ) values (?, ?, ?, ?, ?, null)
    on conflict(machine_key) do update set
      user_id = excluded.user_id,
      machine_name = excluded.machine_name,
      last_seen_at = excluded.last_seen_at
    where excluded.last_seen_at >= attention_machine_links.last_seen_at
  `).bind(
    args.machineKey,
    args.userId,
    args.machineName,
    args.now,
    args.now
  ).run());
}
__name(refreshActivityMachinePresence, "refreshActivityMachinePresence");
async function activityItemsForMachine(env, userId, machineKey, now) {
  const rows = await env.DB.prepare(`
    select payload_json
    from attention_items
    where user_id = ? and machine_key = ?
      and seen_at is null and dismissed_at is null
      and (expires_at is null or expires_at > ?)
    order by updated_at desc
    limit ?
  `).bind(
    userId,
    machineKey,
    now,
    MAX_ACCOUNT_ATTENTION_ITEMS
  ).all();
  return rows.results.flatMap((row) => {
    try {
      return [JSON.parse(row.payload_json)];
    } catch {
      return [];
    }
  });
}
__name(activityItemsForMachine, "activityItemsForMachine");
async function activityPublishAcknowledgments(env, args) {
  const requestRows = args.requestItems.length > 0 ? await env.DB.prepare(`
        select item_id, seen_at, dismissed_at, source_revision, account_revision
        from attention_items
        where user_id = ? and machine_key = ?
          and item_id in (${args.requestItems.map(() => "?").join(", ")})
      `).bind(
    args.userId,
    args.machineKey,
    ...args.requestItems.map((item) => item.id)
  ).all() : { results: [] };
  const recentRows = await env.DB.prepare(`
    select item_id, seen_at, dismissed_at, source_revision, account_revision
    from attention_items
    where user_id = ? and machine_key = ?
      and (seen_at is not null or dismissed_at is not null)
    order by account_revision desc
    limit 64
  `).bind(args.userId, args.machineKey).all();
  const requestById = new Map(requestRows.results.map((row) => [row.item_id, row]));
  const acknowledgments = args.requestItems.map((item) => {
    const row = requestById.get(item.id);
    return {
      itemId: item.id,
      seenAt: row?.seen_at ?? null,
      dismissedAt: row?.dismissed_at ?? null,
      sourceRevision: Number(row?.source_revision ?? item.revision)
    };
  });
  const includedIds = new Set(acknowledgments.map((ack) => ack.itemId));
  for (const row of recentRows.results) {
    if (includedIds.has(row.item_id)) continue;
    acknowledgments.push({
      itemId: row.item_id,
      seenAt: row.seen_at,
      dismissedAt: row.dismissed_at,
      sourceRevision: Number(row.source_revision)
    });
  }
  return acknowledgments;
}
__name(activityPublishAcknowledgments, "activityPublishAcknowledgments");
async function optionalAccountChangeMarks(env, userId) {
  return await accountChangeMarks(env, userId).catch(() => void 0);
}
__name(optionalAccountChangeMarks, "optionalAccountChangeMarks");
async function handleAttentionMachinePublish(request, env, machineKey, body, verifiedMachine) {
  if (verifiedMachine.machineKey !== machineKey) {
    return json({
      ok: false,
      error: "machine key does not match the signed machine",
      code: "machine_key_unbound"
    }, { status: 403 });
  }
  const account = await authorizedUser(request, env);
  if ("response" in account) return account.response;
  const revokedAt = await accountMachineRevokedAt(env, account.userId, machineKey);
  if (revokedAt) {
    return json({
      ok: false,
      error: "machine removed from account",
      code: "machine_revoked",
      revokedAt,
      recovery: "This machine was removed from the ADE account. Pair it again to publish activity."
    }, { status: 403 });
  }
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return json({ ok: false, error: "invalid payload" }, { status: 400 });
  const machineName = boundedText(payload.machineName, 120) ?? "ADE machine";
  const mode = payload.mode === "delta" || payload.mode === "reconcile" || payload.mode === "presence" ? payload.mode : null;
  if (payload.mode != null && !mode) {
    return json({ ok: false, error: "invalid publish mode" }, { status: 400 });
  }
  const fullSnapshot = payload.fullSnapshot === true;
  const rosterEpoch = mode ? Number(payload.rosterEpoch) : 0;
  if (mode && (!Number.isSafeInteger(rosterEpoch) || rosterEpoch <= 0)) {
    return json({ ok: false, error: "invalid roster epoch" }, { status: 400 });
  }
  if (mode === "reconcile") {
    if (payload.page != null && (!Number.isSafeInteger(Number(payload.page)) || Number(payload.page) < 0)) {
      return json({ ok: false, error: "invalid reconcile page" }, { status: 400 });
    }
    if (payload.final != null && typeof payload.final !== "boolean") {
      return json({ ok: false, error: "invalid reconcile final flag" }, { status: 400 });
    }
  } else if (mode && (payload.page != null || payload.final != null)) {
    return json({ ok: false, error: "page and final require reconcile mode" }, { status: 400 });
  }
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const rawTombstones = Array.isArray(payload.tombstones) ? payload.tombstones : [];
  if (rawItems.length > MAX_ATTENTION_ITEMS || rawTombstones.length > MAX_ATTENTION_TOMBSTONES) {
    return json({ ok: false, error: "too many changes" }, { status: 400 });
  }
  if (mode === "presence" && (rawItems.length > 0 || rawTombstones.length > 0)) {
    return json({ ok: false, error: "presence cannot write items" }, { status: 400 });
  }
  const items = rawItems.map((entry) => parseAttentionItem(entry, machineKey));
  if (items.some((entry) => entry === null)) {
    return json({ ok: false, error: "invalid attention item" }, { status: 400 });
  }
  const parsedTombstones = rawTombstones.map((entry) => {
    if (!isRecord(entry)) return null;
    const id = requiredString(entry.id);
    const revision = Number(entry.revision);
    return id && Number.isSafeInteger(revision) && revision >= 0 ? { id, revision } : null;
  });
  if (parsedTombstones.some((entry) => entry === null)) {
    return json({ ok: false, error: "invalid attention tombstone" }, { status: 400 });
  }
  const ownsItemId = /* @__PURE__ */ __name((id) => id.startsWith(`agent:${machineKey}:`) || id.startsWith(`message:${machineKey}:`) || id.startsWith(`pull-request:${machineKey}:`), "ownsItemId");
  if (parsedTombstones.some((entry) => !ownsItemId(entry.id))) {
    return json({ ok: false, error: "foreign attention tombstone" }, { status: 403 });
  }
  const tombstonesById = new Map(
    parsedTombstones.map((entry) => [
      entry.id,
      { ...entry, revivable: false }
    ])
  );
  const publishedIds = new Set(
    items.map((item) => item.id)
  );
  if ([...tombstonesById.keys()].some((id) => publishedIds.has(id))) {
    return json({ ok: false, error: "an item cannot also be removed" }, { status: 400 });
  }
  let existingMachineItems = [];
  if (!mode && fullSnapshot) {
    const existing = await env.DB.prepare(`
      select item_id, source_revision, fingerprint
      from attention_items
      where user_id = ? and machine_key = ?
    `).bind(account.userId, machineKey).all();
    existingMachineItems = existing.results;
    for (const row of existing.results) {
      if (!publishedIds.has(row.item_id) && !tombstonesById.has(row.item_id)) {
        tombstonesById.set(
          row.item_id,
          implicitFullSnapshotTombstone(row, rawItems.length)
        );
      }
    }
  }
  const tombstones = [...tombstonesById.values()];
  const firstItem = items.find((entry) => entry !== null);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (mode === "presence") {
    await refreshActivityMachinePresence(env, {
      userId: account.userId,
      machineKey,
      machineName,
      now
    });
    const storedItems = await activityItemsForMachine(
      env,
      account.userId,
      machineKey,
      now
    );
    await deliverAttentionNotifications(env, account.userId, storedItems);
    await deliverAccountLiveActivity(env, account.userId);
    const [current, acks2, accountChanges2] = await Promise.all([
      env.DB.prepare("select revision from attention_revisions where user_id = ? limit 1").bind(account.userId).first(),
      activityPublishAcknowledgments(env, {
        userId: account.userId,
        machineKey,
        requestItems: []
      }),
      optionalAccountChangeMarks(env, account.userId)
    ]);
    return json({
      ok: true,
      protocol: 2,
      features: ATTENTION_PUBLISH_FEATURES,
      revision: Number(current?.revision ?? 0),
      acks: acks2,
      upserted: 0,
      removed: 0,
      unchanged: true,
      accountChanges: accountChanges2
    });
  }
  await linkMachineToAccount(
    env,
    account.userId,
    machineKey,
    firstItem?.machine.name ?? machineName
  );
  if (!mode && fullSnapshot && attentionFullSnapshotUnchanged(
    existingMachineItems,
    items,
    tombstones.length
  )) {
    await deliverAttentionNotifications(
      env,
      account.userId,
      items
    );
    await deliverAccountLiveActivity(env, account.userId);
    const [current, acks2, accountChanges2] = await Promise.all([
      env.DB.prepare("select revision from attention_revisions where user_id = ? limit 1").bind(account.userId).first(),
      activityPublishAcknowledgments(env, {
        userId: account.userId,
        machineKey,
        requestItems: items
      }),
      optionalAccountChangeMarks(env, account.userId)
    ]);
    return json({
      ok: true,
      protocol: 2,
      features: ATTENTION_PUBLISH_FEATURES,
      revision: Number(current?.revision ?? 0),
      acks: acks2,
      upserted: 0,
      removed: 0,
      unchanged: true,
      accountChanges: accountChanges2
    });
  }
  let accountRevision = await commitAttentionMachineChanges(env, {
    userId: account.userId,
    machineKey,
    items,
    tombstones,
    sealCapacityTombstones: !mode && fullSnapshot && rawItems.length < MAX_ATTENTION_ITEMS,
    rosterEpoch,
    now
  });
  if (mode === "reconcile" && payload.final === true) {
    accountRevision = await commitActivityReconcileFinal(env, {
      userId: account.userId,
      machineKey,
      rosterEpoch,
      now
    });
  }
  const cap = await enforceActivityAccountItemCap(env, account.userId, now);
  if (cap.revision !== null) accountRevision = cap.revision;
  await deliverAttentionNotifications(
    env,
    account.userId,
    items
  );
  await deliverAccountLiveActivity(env, account.userId);
  const [acks, accountChanges] = await Promise.all([
    activityPublishAcknowledgments(env, {
      userId: account.userId,
      machineKey,
      requestItems: items
    }),
    optionalAccountChangeMarks(env, account.userId)
  ]);
  return json({
    ok: true,
    protocol: 2,
    features: ATTENTION_PUBLISH_FEATURES,
    revision: accountRevision,
    acks,
    upserted: items.length,
    removed: tombstones.length,
    ...cap.itemsTruncated ? { itemsTruncated: true } : {},
    accountChanges
  });
}
__name(handleAttentionMachinePublish, "handleAttentionMachinePublish");
function snapshotIncludesMessages(url) {
  return (url.searchParams.get("include") ?? "").split(",").some((entry) => entry.trim() === "message");
}
__name(snapshotIncludesMessages, "snapshotIncludesMessages");
async function handleSnapshot(env, userId, url) {
  const pageSize = 512;
  const requestedSince = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
  const requestedStreamId = url.searchParams.get("streamId")?.trim() || null;
  const revisionRow = await env.DB.prepare("select revision from attention_revisions where user_id = ? limit 1").bind(userId).first();
  const headRevision = Number(revisionRow?.revision ?? 0);
  const since = normalizedSnapshotCursor(
    requestedSince,
    headRevision,
    requestedStreamId,
    userId
  );
  const now = Date.now();
  const itemRows = await env.DB.prepare(`
    select payload_json, seen_at, dismissed_at, account_revision
    from attention_items
    where user_id = ?
      and account_revision > ?
      and (expires_at is null or expires_at > ?)
    order by account_revision asc
    limit ?
  `).bind(userId, since, new Date(now).toISOString(), pageSize).all();
  const tombstoneRows = await env.DB.prepare(`
    select item_id, source_revision, account_revision, deleted_at
    from attention_tombstones
    where user_id = ? and account_revision > ?
    order by account_revision asc
    limit ?
  `).bind(userId, since, pageSize).all();
  const itemBoundary = itemRows.results.length === pageSize ? Math.max(since, Number(itemRows.results.at(-1)?.account_revision ?? since) - 1) : Number.POSITIVE_INFINITY;
  const tombstoneBoundary = tombstoneRows.results.length === pageSize ? Math.max(since, Number(tombstoneRows.results.at(-1)?.account_revision ?? since) - 1) : Number.POSITIVE_INFINITY;
  const boundary = Math.min(itemBoundary, tombstoneBoundary);
  const responseRevision = Number.isFinite(boundary) ? Math.min(headRevision, boundary) : headRevision;
  const responseItemRows = itemRows.results.filter(
    (row) => row.account_revision <= responseRevision
  );
  const responseTombstoneRows = tombstoneRows.results.filter(
    (row) => row.account_revision <= responseRevision
  );
  const accountItemCountRow = await env.DB.prepare(`
    select count(*) as count
    from attention_items
    where user_id = ?
  `).bind(userId).first();
  const itemsTruncated = Number(accountItemCountRow?.count ?? 0) > MAX_ACCOUNT_ATTENTION_ITEMS;
  const links = await env.DB.prepare(`
    select machine_key, machine_name, last_seen_at
    from attention_machine_links
    where user_id = ?
  `).bind(userId).all();
  const presenceByMachine = new Map(
    links.results.map((row) => [
      row.machine_key,
      {
        online: now - Date.parse(row.last_seen_at) <= ACCOUNT_MACHINE_ONLINE_WINDOW_MS,
        lastSeenAt: row.last_seen_at
      }
    ])
  );
  const includeMessages = snapshotIncludesMessages(url);
  const items = responseItemRows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload_json);
      if (payload.kind === "message" && !includeMessages) return [];
      return [{
        ...payload,
        machine: {
          ...payload.machine,
          online: presenceByMachine.get(payload.machine.machineKey)?.online ?? false,
          lastSeenAt: presenceByMachine.get(payload.machine.machineKey)?.lastSeenAt ?? null
        },
        seenAt: row.seen_at,
        dismissedAt: row.dismissed_at
      }];
    } catch {
      return [];
    }
  });
  return json({
    ok: true,
    contractVersion: 1,
    streamId: userId,
    revision: responseRevision,
    generatedAt: new Date(now).toISOString(),
    machines: links.results.map((row) => ({
      machineKey: row.machine_key,
      name: row.machine_name?.trim() || "ADE machine",
      online: now - Date.parse(row.last_seen_at) <= ACCOUNT_MACHINE_ONLINE_WINDOW_MS,
      lastSeenAt: row.last_seen_at
    })),
    items,
    itemsTruncated,
    tombstones: responseTombstoneRows.map((row) => ({
      id: row.item_id,
      revision: row.source_revision,
      deletedAt: row.deleted_at
    }))
  });
}
__name(handleSnapshot, "handleSnapshot");
async function handleAcknowledgment(request, env, userId) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload) || !Array.isArray(payload.itemIds) || payload.itemIds.length > 64) {
    return json({ ok: false, error: "invalid acknowledgment" }, { status: 400 });
  }
  if (Object.prototype.hasOwnProperty.call(payload, "expectedAccountOwnerId") && payload.expectedAccountOwnerId !== userId) {
    return json({ ok: false, error: "account owner changed" }, { status: 409 });
  }
  const itemIds = payload.itemIds.map((value) => requiredString(value));
  if (itemIds.some((value) => value === null)) {
    return json({ ok: false, error: "invalid item id" }, { status: 400 });
  }
  const seenAt = optionalIsoDate(payload.seenAt ?? (/* @__PURE__ */ new Date()).toISOString());
  const dismissedAt = optionalIsoDate(payload.dismissedAt);
  if (!seenAt || dismissedAt === void 0) {
    return json({ ok: false, error: "invalid timestamp" }, { status: 400 });
  }
  const rawAlertFingerprints = payload.alertFingerprints;
  const hasAlertFingerprints = rawAlertFingerprints !== void 0 && rawAlertFingerprints !== null;
  if (hasAlertFingerprints && !isRecord(rawAlertFingerprints)) {
    return json({ ok: false, error: "invalid alert fingerprints" }, { status: 400 });
  }
  const alertFingerprints = /* @__PURE__ */ new Map();
  if (hasAlertFingerprints) {
    const quoted = rawAlertFingerprints;
    const batch = new Set(itemIds);
    for (const [itemId, value] of Object.entries(quoted)) {
      if (!batch.has(itemId)) {
        return json({ ok: false, error: "invalid alert fingerprints" }, { status: 400 });
      }
      if (typeof value !== "string") {
        return json({ ok: false, error: "invalid alert fingerprints" }, { status: 400 });
      }
      const normalized = value.trim();
      if (!normalized || normalized.length > 1024) {
        return json({ ok: false, error: "invalid alert fingerprints" }, { status: 400 });
      }
      alertFingerprints.set(itemId, normalized);
    }
  }
  const fencedAlertFingerprint = /* @__PURE__ */ __name((itemId) => alertFingerprints.get(itemId) ?? null, "fencedAlertFingerprint");
  if (itemIds.length === 0) {
    const current = await env.DB.prepare("select revision from attention_revisions where user_id = ? limit 1").bind(userId).first();
    return json({
      ok: true,
      revision: Number(current?.revision ?? 0),
      itemIds,
      applied: [],
      stale: []
    });
  }
  const statements = itemIds.map((itemId) => {
    const fence = fencedAlertFingerprint(itemId);
    return env.DB.prepare(`
      update attention_items
      set seen_at = case
          when seen_at is null or seen_at > ? then ?
          else seen_at
        end,
        dismissed_at = case
          when ? is null then dismissed_at
          when dismissed_at is null or dismissed_at > ? then ?
          else dismissed_at
        end,
        account_revision = (
          select revision
          from attention_revisions
          where user_id = ?
        )
      where user_id = ? and item_id = ?
        ${fence === null ? "" : "and alert_fingerprint = ?"}
        and not exists (
          select 1
          from attention_tombstones
          where user_id = attention_items.user_id
            and item_id = attention_items.item_id
            and revivable != 1
            and source_revision >= attention_items.source_revision
        )
      returning item_id
    `).bind(
      seenAt,
      seenAt,
      dismissedAt,
      dismissedAt,
      dismissedAt,
      userId,
      userId,
      itemId,
      ...fence === null ? [] : [fence]
    );
  });
  const [revisionResult, ...mutationResults] = await env.DB.batch([
    attentionRevisionBumpStatement(env, userId, (/* @__PURE__ */ new Date()).toISOString()),
    ...statements
  ]);
  if (!revisionResult?.success || mutationResults.some((result) => !result.success)) {
    throw new Error("attention acknowledgment transaction failed");
  }
  const revision = Number(revisionResult.results[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("attention acknowledgment transaction did not return a revision");
  }
  const applied = itemIds.filter(
    (_itemId, index) => mutationResults[index]?.results.length === 1
  );
  const appliedIds = new Set(applied);
  const stale = itemIds.filter((itemId) => !appliedIds.has(itemId));
  await deliverAccountLiveActivity(env, userId);
  return json({ ok: true, revision, itemIds, applied, stale });
}
__name(handleAcknowledgment, "handleAcknowledgment");
async function handlePresence(request, env, userId) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return json({ ok: false, error: "invalid presence" }, { status: 400 });
  const deviceId = requiredString(payload.deviceId, 128);
  const reportedAt = optionalIsoDate(payload.observedAt ?? (/* @__PURE__ */ new Date()).toISOString());
  const nowMs = Date.now();
  const observedAt = reportedAt && Date.parse(reportedAt) > nowMs ? new Date(nowMs).toISOString() : reportedAt;
  const visibleItemIds = Array.isArray(payload.visibleItemIds) ? payload.visibleItemIds.map((value) => requiredString(value)).filter(Boolean).slice(0, 64) : [];
  if (!deviceId || !observedAt) {
    return json({ ok: false, error: "invalid presence" }, { status: 400 });
  }
  const platform = payload.platform === "macOS" || payload.platform === "iOS" || payload.platform === "web" || payload.platform === "unknown" ? payload.platform : "unknown";
  const stored = {
    deviceId,
    platform,
    appForeground: payload.appForeground === true,
    // Read by the desktop-first hold; dropping it left the "this item is on
    // screen" hold dead since presence was introduced.
    ambientSurfaceVisible: payload.ambientSurfaceVisible === true,
    // Absent from older desktops and the web client: unknown, not idle.
    ...typeof payload.userActive === "boolean" ? { userActive: payload.userActive } : {},
    observedAt,
    visibleItemIds
  };
  await env.DB.prepare(`
    insert into attention_presence(user_id, device_id, payload_json, observed_at)
    values (?, ?, ?, ?)
    on conflict(user_id, device_id) do update set
      payload_json = excluded.payload_json,
      observed_at = excluded.observed_at
  `).bind(userId, deviceId, JSON.stringify(stored), observedAt).run();
  return json({ ok: true, observedAt });
}
__name(handlePresence, "handlePresence");
async function handlePreferences(request, env, userId) {
  if (request.method === "GET") {
    const row = await env.DB.prepare("select payload_json, updated_at from attention_preferences where user_id = ? limit 1").bind(userId).first();
    let preferences = null;
    if (row) {
      try {
        const parsed = JSON.parse(row.payload_json);
        preferences = isRecord(parsed) ? parsed : null;
      } catch {
        preferences = null;
      }
    }
    return json({
      ok: true,
      preferences,
      updatedAt: row?.updated_at ?? null
    });
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return json({ ok: false, error: "invalid preferences" }, { status: 400 });
  const preservesDevices = !Object.prototype.hasOwnProperty.call(payload, "devices");
  const preservesMachines = !Object.prototype.hasOwnProperty.call(payload, "machines");
  const preservesProjects = !Object.prototype.hasOwnProperty.call(payload, "projects");
  const result = await mutateAttentionPreferences(env, userId, (current) => ({
    ...payload,
    // Only the per-chat route writes the account mute list. A whole-document
    // save carries whatever list that client loaded, and letting it through
    // would undo a mute made on another device in the meantime.
    mutedSessionIds: Array.isArray(current.mutedSessionIds) ? current.mutedSessionIds : [],
    ...preservesDevices && isRecord(current.devices) ? { devices: current.devices } : {},
    ...preservesMachines && isRecord(current.machines) ? { machines: current.machines } : {},
    ...preservesProjects && isRecord(current.projects) ? { projects: current.projects } : {}
  }));
  if ("response" in result) return result.response;
  await deliverAccountLiveActivity(env, userId);
  return json({
    ok: true,
    preferences: result.preferences,
    updatedAt: result.updatedAt
  });
}
__name(handlePreferences, "handlePreferences");
async function mutateAttentionPreferences(env, userId, mutate) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await env.DB.prepare("select payload_json from attention_preferences where user_id = ? limit 1").bind(userId).first();
    let current = {};
    if (row) {
      try {
        const parsed = JSON.parse(row.payload_json);
        if (isRecord(parsed)) current = parsed;
      } catch {
        current = {};
      }
    }
    const preferences = mutate(current);
    if (preferences.machines != null && (!isRecord(preferences.machines) || Object.keys(preferences.machines).length > MAX_ATTENTION_MACHINE_PREFERENCES)) {
      return {
        response: json(
          { ok: false, error: "invalid machine preferences" },
          { status: 400 }
        )
      };
    }
    const serialized = JSON.stringify(preferences);
    if (serialized.length > 32e3) {
      return {
        response: json(
          { ok: false, error: "preferences too large" },
          { status: 413 }
        )
      };
    }
    const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const committed = row ? await env.DB.prepare(`
          update attention_preferences
          set payload_json = ?, updated_at = ?
          where user_id = ? and payload_json = ?
          returning payload_json
        `).bind(serialized, updatedAt, userId, row.payload_json).first() : await env.DB.prepare(`
          insert into attention_preferences(user_id, payload_json, updated_at)
          values (?, ?, ?)
          on conflict(user_id) do nothing
          returning payload_json
        `).bind(userId, serialized, updatedAt).first();
    if (committed) return { preferences, updatedAt };
  }
  return {
    response: json(
      { ok: false, error: "preferences changed concurrently; retry" },
      { status: 409 }
    )
  };
}
__name(mutateAttentionPreferences, "mutateAttentionPreferences");
async function handleDevicePreferences(request, env, userId, deviceId) {
  if (!requiredString(deviceId, 128)) {
    return json({ ok: false, error: "invalid device id" }, { status: 400 });
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) {
    return json({ ok: false, error: "invalid device preferences" }, { status: 400 });
  }
  const result = await mutateAttentionPreferences(env, userId, (current) => {
    const devices = isRecord(current.devices) ? current.devices : {};
    const device = isRecord(devices[deviceId]) ? devices[deviceId] : {};
    return {
      ...current,
      devices: {
        ...devices,
        [deviceId]: {
          ...device,
          ...payload
        }
      }
    };
  });
  if ("response" in result) return result.response;
  await deliverAccountLiveActivity(env, userId);
  return json({
    ok: true,
    preferences: result.preferences,
    updatedAt: result.updatedAt
  });
}
__name(handleDevicePreferences, "handleDevicePreferences");
var CUSTOM_NOTIFICATION_TITLE_MAX = 64;
var CUSTOM_NOTIFICATION_BODY_MAX = 160;
var CUSTOM_NOTIFICATION_LINK_MAX = 1024;
function parseCustomNotification(payload) {
  if (!isRecord(payload)) return { error: "invalid notification" };
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title) return { error: "title is required" };
  if (title.length > CUSTOM_NOTIFICATION_TITLE_MAX) {
    return { error: `title is longer than ${CUSTOM_NOTIFICATION_TITLE_MAX} characters` };
  }
  let body = null;
  if (payload.body !== void 0 && payload.body !== null) {
    if (typeof payload.body !== "string") return { error: "body must be text" };
    body = payload.body.trim() || null;
    if (body && body.length > CUSTOM_NOTIFICATION_BODY_MAX) {
      return { error: `body is longer than ${CUSTOM_NOTIFICATION_BODY_MAX} characters` };
    }
  }
  let deepLink = null;
  if (payload.deepLink !== void 0 && payload.deepLink !== null) {
    const raw = typeof payload.deepLink === "string" ? payload.deepLink.trim() : "";
    let parsed = null;
    try {
      parsed = raw ? new URL(raw) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "ade:" || raw.length > CUSTOM_NOTIFICATION_LINK_MAX) {
      return { error: "deepLink must be an ade:// link" };
    }
    deepLink = raw;
  }
  let machineKey = null;
  if (payload.machineKey !== void 0 && payload.machineKey !== null) {
    machineKey = requiredString(payload.machineKey, 128);
    if (!machineKey) return { error: "invalid machine key" };
  }
  return { title, body, deepLink, machineKey };
}
__name(parseCustomNotification, "parseCustomNotification");
async function handleCustomNotification(request, env, userId, sendPush = sendApnsPush) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const parsed = parseCustomNotification(payload);
  if ("error" in parsed) return json({ ok: false, error: parsed.error }, { status: 400 });
  const config = apnsConfig(env);
  if (!config) {
    return json({ ok: false, error: "push notifications are not configured" }, { status: 503 });
  }
  const quota = await checkAccountNotifyQuota(env, userId);
  if (!quota.allowed) {
    return json(
      {
        ok: false,
        error: "rate limited",
        limit: ACCOUNT_NOTIFY_LIMIT_PER_HOUR,
        retryAfterSeconds: quota.retryAfterSeconds
      },
      { status: 429, headers: { "retry-after": String(quota.retryAfterSeconds) } }
    );
  }
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const [devicesResult, preferencesRow] = await Promise.all([
    env.DB.prepare(`
      select device_id, apns_token, bundle_id, aps_environment, preferences_json
      from attention_devices
      where user_id = ? and apns_token is not null and lease_expires_at > ?
      limit ?
    `).bind(userId, nowIso, MAX_ATTENTION_DEVICES).all(),
    env.DB.prepare("select payload_json from attention_preferences where user_id = ? limit 1").bind(userId).first()
  ]);
  const preferences = readPreferences(preferencesRow?.payload_json);
  const accountPreferences = isRecord(preferences.account) ? preferences.account : {};
  const collapseId = `ade-notify-${crypto.randomUUID()}`;
  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  for (const device of devicesResult.results) {
    if (!device.apns_token) continue;
    const override = resolveScopedDeliveryPreferences(
      device,
      { machineKey: parsed.machineKey },
      preferences
    );
    const notificationsEnabled = preferenceBoolean(
      override,
      {},
      "notificationsEnabled",
      typeof override.enabled === "boolean" ? override.enabled : true
    );
    if (!notificationsEnabled || quietHoursActive(override, accountPreferences, nowMs)) {
      skipped += 1;
      continue;
    }
    const soundsEnabled = preferenceBoolean(override, accountPreferences, "soundsEnabled", false);
    const hideDetails = preferenceBoolean(override, accountPreferences, "hideDetails", false);
    let result;
    try {
      result = await sendPush(config, {
        environment: device.aps_environment,
        deviceToken: device.apns_token,
        topic: device.bundle_id || env.APNS_DEFAULT_TOPIC?.trim() || "",
        pushType: "alert",
        priority: 10,
        expiration: Math.floor(nowMs / 1e3) + 24 * 60 * 60,
        collapseId,
        payload: {
          aps: {
            alert: {
              title: parsed.title,
              ...parsed.body && !hideDetails ? { body: parsed.body } : {}
            },
            ...soundsEnabled ? { sound: "default" } : {},
            "thread-id": "ade-notify",
            "interruption-level": "active"
          },
          customNotification: true,
          ...parsed.deepLink ? { deepLink: parsed.deepLink } : {}
        }
      });
    } catch (error2) {
      failed += 1;
      logAttentionDeliveryError("notification", device.device_id, error2);
      continue;
    }
    if (result.ok) {
      delivered += 1;
      continue;
    }
    failed += 1;
    if (result.tokenInvalid) {
      await env.DB.prepare(`
        update attention_devices
        set apns_token = null, updated_at = ?
        where user_id = ? and device_id = ? and apns_token = ?
      `).bind(nowIso, userId, device.device_id, device.apns_token).run();
    }
  }
  return json({
    ok: true,
    devices: devicesResult.results.length,
    delivered,
    skipped,
    failed,
    remaining: quota.remaining
  });
}
__name(handleCustomNotification, "handleCustomNotification");
async function handleSessionMutePreference(request, env, userId, sessionId) {
  const id = requiredString(sessionId, 256);
  if (!id) return json({ ok: false, error: "invalid session id" }, { status: 400 });
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload) || typeof payload.muted !== "boolean") {
    return json({ ok: false, error: "muted must be true or false" }, { status: 400 });
  }
  const muted = payload.muted;
  const result = await mutateAttentionPreferences(env, userId, (current) => {
    const existing = Array.isArray(current.mutedSessionIds) ? current.mutedSessionIds.filter(
      (entry) => typeof entry === "string" && entry !== id
    ) : [];
    const next = muted ? [...existing, id] : existing;
    return {
      ...current,
      mutedSessionIds: next.slice(-MAX_ACCOUNT_MUTED_SESSIONS)
    };
  });
  if ("response" in result) return result.response;
  return json({
    ok: true,
    preferences: result.preferences,
    updatedAt: result.updatedAt
  });
}
__name(handleSessionMutePreference, "handleSessionMutePreference");
async function handleActivityMachinePreferences(request, env, userId, machineKey) {
  if (!requiredString(machineKey, 128)) {
    return json({ ok: false, error: "invalid machine key" }, { status: 400 });
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) {
    return json({ ok: false, error: "invalid machine preferences" }, { status: 400 });
  }
  const result = await mutateAttentionPreferences(env, userId, (current) => {
    const machines = isRecord(current.machines) ? current.machines : {};
    const machine = isRecord(machines[machineKey]) ? machines[machineKey] : {};
    return {
      ...current,
      machines: {
        ...machines,
        [machineKey]: {
          ...machine,
          ...payload
        }
      }
    };
  });
  if ("response" in result) return result.response;
  await deliverAccountLiveActivity(env, userId);
  return json({
    ok: true,
    preferences: result.preferences,
    updatedAt: result.updatedAt
  });
}
__name(handleActivityMachinePreferences, "handleActivityMachinePreferences");
async function accountKnowsMachine(env, userId, machineKey) {
  const row = await env.DB.prepare(`
    select 1 as known
    where not exists (
        select 1 from attention_machine_links
         where machine_key = ? and user_id <> ?
      )
      and (
        exists (
          select 1 from attention_machine_links
           where user_id = ? and machine_key = ?
        )
        or exists (
          select 1 from attention_items
           where user_id = ? and machine_key = ?
        )
        or exists (
          select 1 from attention_devices
           where user_id = ? and source_machine_key = ?
        )
        or exists (
          select 1 from machines
           where machine_key = ? and account_user_id = ?
        )
      )
  `).bind(
    machineKey,
    userId,
    userId,
    machineKey,
    userId,
    machineKey,
    userId,
    machineKey,
    machineKey,
    userId
  ).first();
  return row != null;
}
__name(accountKnowsMachine, "accountKnowsMachine");
async function handleAccountMachineRemoval(env, userId, machineKey) {
  if (!requiredString(machineKey, 128)) {
    return json({ ok: false, error: "invalid machine key" }, { status: 400 });
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const knownMachine = await accountKnowsMachine(env, userId, machineKey);
  const purge = await purgeAccountMachineActivity(env, {
    userId,
    machineKey,
    now,
    revoke: knownMachine
  });
  return json({
    ok: true,
    machineKey,
    revision: purge.revision,
    removedItems: purge.removedItems,
    revokedAt: knownMachine ? now : null
  });
}
__name(handleAccountMachineRemoval, "handleAccountMachineRemoval");
async function handleAccountMachinePairingRestore(request, env, userId, machineKey) {
  const provenance = assertDirectoryProvenance(request, env);
  if ("response" in provenance) return provenance.response;
  if (!requiredString(machineKey, 128)) {
    return json({ ok: false, error: "invalid machine key" }, { status: 400 });
  }
  const revokedAt = await accountMachineRevokedAt(env, userId, machineKey);
  await env.DB.prepare("delete from attention_revoked_machines where user_id = ? and machine_key = ?").bind(userId, machineKey).run();
  return json({ ok: true, machineKey, restored: revokedAt !== null });
}
__name(handleAccountMachinePairingRestore, "handleAccountMachinePairingRestore");
async function handleDirectoryAccountPurge(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "directory" || parts[1] !== "accounts") return null;
  if (parts.length === 4 && parts[3] === "notify" && request.method === "POST") {
    return await handleDirectoryAccountNotify(request, env, decodePathSegment(parts[2]));
  }
  if (parts.length !== 3 || request.method !== "DELETE") return attentionRouteNotFound();
  const provenance = assertDirectoryProvenance(request, env);
  if ("response" in provenance) return provenance.response;
  const clerkUserId = requiredString(decodePathSegment(parts[2]), 256);
  if (!clerkUserId) return json({ ok: false, error: "invalid account" }, { status: 400 });
  const accountKeys = await relayAccountKeysForClerkUser(env, clerkUserId);
  if (accountKeys.length === 0) {
    return json({ ok: false, error: "account sign-in is not configured" }, { status: 503 });
  }
  const results = await env.DB.batch(accountKeys.flatMap((accountKey) => [
    env.DB.prepare("delete from account_vault_items where user_id = ?").bind(accountKey),
    env.DB.prepare("delete from account_settings where user_id = ?").bind(accountKey)
  ]));
  const changes = /* @__PURE__ */ __name((offset) => results.filter((_, index) => index % 2 === offset).reduce((sum, result) => sum + (result?.meta?.changes ?? 0), 0), "changes");
  return json({ ok: true, vaultItems: changes(0), settings: changes(1) });
}
__name(handleDirectoryAccountPurge, "handleDirectoryAccountPurge");
async function handleDirectoryAccountNotify(request, env, clerkUserIdRaw) {
  const provenance = assertDirectoryProvenance(request, env);
  if ("response" in provenance) return provenance.response;
  const clerkUserId = requiredString(clerkUserIdRaw, 256);
  if (!clerkUserId) return json({ ok: false, error: "invalid account" }, { status: 400 });
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const accountKeys = await relayAccountKeysForClerkUser(env, clerkUserId);
  if (accountKeys.length === 0) return json({ ok: false, error: "account sign-in is not configured" }, { status: 503 });
  let delivered = 0;
  for (const accountKey of accountKeys) {
    const response = await handleCustomNotification(
      new Request("https://relay.invalid/notify", { method: "POST", body: JSON.stringify(payload) }),
      env,
      accountKey
    );
    if (!response.ok) return response;
    const body = await response.json().catch(() => null);
    delivered += typeof body?.delivered === "number" ? body.delivered : 0;
  }
  return json({ ok: true, delivered });
}
__name(handleDirectoryAccountNotify, "handleDirectoryAccountNotify");
async function deleteAttentionDeviceOwnership(env, userId, deviceId) {
  await env.DB.batch(attentionDeviceOwnershipDeleteStatements(env, userId, deviceId));
}
__name(deleteAttentionDeviceOwnership, "deleteAttentionDeviceOwnership");
async function handleDeviceRegistration(request, env, userId, deviceId) {
  if (!requiredString(deviceId, 128)) {
    return json({ ok: false, error: "invalid device id" }, { status: 400 });
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isRecord(payload)) return json({ ok: false, error: "invalid device" }, { status: 400 });
  const ownershipEpoch = parsedOwnershipEpoch(payload.ownershipEpoch);
  if (ownershipEpoch === null) {
    return json({ ok: false, error: "invalid ownership epoch" }, { status: 400 });
  }
  const rawApnsToken = payload.apnsToken == null ? null : requiredString(payload.apnsToken, 512);
  if (rawApnsToken !== null && (!rawApnsToken || !APNS_TOKEN_PATTERN.test(rawApnsToken))) {
    return json({ ok: false, error: "invalid device routing" }, { status: 400 });
  }
  const deviceKey = await parsedDeviceKeyRequest(payload);
  if (request.method === "DELETE") {
    const deviceOwnership = await attentionDeviceOwnershipRows(env, deviceId, null);
    const observedOwnership2 = deviceOwnership.find((row) => row.device_id === deviceId);
    if (!attentionDeviceOwnershipProven(
      observedOwnership2,
      userId,
      deviceKey.presentedKeyHash,
      rawApnsToken
    )) {
      return attentionDeviceOwnershipUnproven();
    }
    const keyChange2 = await attentionDeviceKeyChange(observedOwnership2, deviceKey);
    const registeredDevice = await env.DB.prepare(`
      select apns_token
      from attention_devices
      where device_id = ?
      limit 1
    `).bind(deviceId).first();
    const apnsToken2 = deviceOwnership.find((row) => row.device_id === deviceId)?.apns_token ?? rawApnsToken ?? registeredDevice?.apns_token ?? null;
    const ownershipRows2 = apnsToken2 ? await attentionDeviceOwnershipRows(env, deviceId, apnsToken2) : deviceOwnership;
    const staleEpoch2 = staleAttentionDeviceOwnershipEpoch(
      ownershipRows2,
      userId,
      ownershipEpoch
    );
    if (staleEpoch2 !== null) {
      return attentionDeviceOwnershipConflict(staleEpoch2);
    }
    const conflicts2 = apnsToken2 ? await env.DB.prepare(`
          select user_id, device_id
          from attention_devices
          where device_id = ? or apns_token = ?
        `).bind(deviceId, apnsToken2).all() : await env.DB.prepare(`
          select user_id, device_id
          from attention_devices
          where device_id = ?
        `).bind(deviceId).all();
    const now2 = (/* @__PURE__ */ new Date()).toISOString();
    const statements = [];
    if (apnsToken2) {
      statements.push(releasePriorApnsOwnershipStatement(env, {
        deviceId,
        userId,
        ownershipEpoch,
        apnsToken: apnsToken2,
        updatedAt: now2
      }));
    }
    const upsertIndex2 = statements.length;
    statements.push(attentionDeviceOwnershipUpsertStatement(env, {
      deviceId,
      userId,
      ownershipEpoch,
      apnsToken: apnsToken2,
      active: false,
      updatedAt: now2,
      keyChange: keyChange2,
      observed: observedOwnership2
    }));
    statements.push(attentionDeviceOwnershipAssertStatement(env, deviceId, userId, ownershipEpoch));
    statements.push(...conflicts2.results.flatMap(
      (conflict) => attentionDeviceOwnershipDeleteStatements(env, conflict.user_id, conflict.device_id)
    ));
    let issuedKey2;
    try {
      const results = await env.DB.batch(statements);
      issuedKey2 = issuedDeviceKey(keyChange2, results[upsertIndex2]);
    } catch (error2) {
      if (isAttentionDeviceOwnershipAssertError(error2)) {
        return attentionDeviceOwnershipUnproven();
      }
      if (isStaleAttentionDeviceOwnershipError(error2)) {
        return attentionDeviceOwnershipConflict(
          await latestAttentionDeviceOwnershipEpoch(
            env,
            deviceId,
            apnsToken2,
            ownershipEpoch
          )
        );
      }
      throw error2;
    }
    return json({
      ok: true,
      deviceId,
      ownershipEpoch,
      ...issuedKey2 ? { deviceKey: issuedKey2 } : {}
    });
  }
  const bundleId = requiredString(payload.bundleId, 200);
  const apsEnvironment = payload.apsEnvironment;
  const apnsToken = rawApnsToken;
  const pushToStartToken = payload.pushToStartToken == null ? null : requiredString(payload.pushToStartToken, 512);
  const clearPushToStartToken = payload.clearPushToStartToken === true;
  if (!bundleId || apsEnvironment !== "sandbox" && apsEnvironment !== "production" || apnsToken !== null && (!apnsToken || !APNS_TOKEN_PATTERN.test(apnsToken)) || pushToStartToken !== null && (!pushToStartToken || !APNS_TOKEN_PATTERN.test(pushToStartToken)) || pushToStartToken !== null && clearPushToStartToken) {
    return json({ ok: false, error: "invalid device routing" }, { status: 400 });
  }
  const ownershipRows = await attentionDeviceOwnershipRows(env, deviceId, apnsToken);
  const observedOwnership = ownershipRows.find((row) => row.device_id === deviceId);
  if (!attentionDeviceOwnershipProven(
    observedOwnership,
    userId,
    deviceKey.presentedKeyHash,
    apnsToken
  )) {
    return attentionDeviceOwnershipUnproven();
  }
  const staleEpoch = staleAttentionDeviceOwnershipEpoch(
    ownershipRows,
    userId,
    ownershipEpoch
  );
  if (staleEpoch !== null) {
    return attentionDeviceOwnershipConflict(staleEpoch);
  }
  const keyChange = await attentionDeviceKeyChange(observedOwnership, deviceKey);
  const conflicts = apnsToken ? await env.DB.prepare(`
        select user_id, device_id
        from attention_devices
        where not (user_id = ? and device_id = ?)
          and (device_id = ? or apns_token = ?)
      `).bind(userId, deviceId, deviceId, apnsToken).all() : await env.DB.prepare(`
        select user_id, device_id
        from attention_devices
        where not (user_id = ? and device_id = ?)
          and device_id = ?
      `).bind(userId, deviceId, deviceId).all();
  const existingDevice = await env.DB.prepare("select 1 as found from attention_devices where user_id = ? and device_id = ? limit 1").bind(userId, deviceId).first();
  const existingOwnership = ownershipRows.find(
    (row) => row.user_id === userId && row.device_id === deviceId
  );
  const ownershipChanged = Boolean(
    existingDevice?.found && (!existingOwnership || existingOwnership.ownership_epoch !== ownershipEpoch)
  );
  const deviceCount = await env.DB.prepare("select count(*) as count from attention_devices where user_id = ?").bind(userId).first();
  const destinationConflicts = new Set(
    conflicts.results.filter((conflict) => conflict.user_id === userId).map((conflict) => conflict.device_id)
  ).size;
  const projectedDeviceCount = Number(deviceCount?.count ?? 0) - destinationConflicts + (existingDevice?.found ? 0 : 1);
  if (projectedDeviceCount > MAX_ATTENTION_DEVICES) {
    return json({ ok: false, error: "account device limit reached" }, { status: 409 });
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const leaseExpiresAt = new Date(Date.now() + ATTENTION_DEVICE_LEASE_MS).toISOString();
  const generation = crypto.randomUUID();
  const preferences = isRecord(payload.preferences) ? payload.preferences : {};
  const transferStatements = [];
  if (apnsToken) {
    transferStatements.push(releasePriorApnsOwnershipStatement(env, {
      deviceId,
      userId,
      ownershipEpoch,
      apnsToken,
      updatedAt: now
    }));
  }
  const upsertIndex = transferStatements.length;
  transferStatements.push(attentionDeviceOwnershipUpsertStatement(env, {
    deviceId,
    userId,
    ownershipEpoch,
    apnsToken,
    active: true,
    updatedAt: now,
    keyChange,
    observed: observedOwnership
  }));
  transferStatements.push(
    attentionDeviceOwnershipAssertStatement(env, deviceId, userId, ownershipEpoch)
  );
  transferStatements.push(...conflicts.results.flatMap(
    (conflict) => attentionDeviceOwnershipDeleteStatements(env, conflict.user_id, conflict.device_id)
  ));
  transferStatements.push(
    env.DB.prepare(`
      insert into attention_devices(
        user_id, device_id, source_machine_key, apns_token, push_to_start_token,
        bundle_id, aps_environment, platform, device_name, preferences_json,
        registered_at, updated_at, lease_expires_at, generation
      ) values (?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(user_id, device_id) do update set
        apns_token = coalesce(excluded.apns_token, attention_devices.apns_token),
        push_to_start_token = case
          when ? then null
          else coalesce(excluded.push_to_start_token, attention_devices.push_to_start_token)
        end,
        bundle_id = excluded.bundle_id,
        aps_environment = excluded.aps_environment,
        platform = excluded.platform,
        device_name = excluded.device_name,
        preferences_json = excluded.preferences_json,
        updated_at = excluded.updated_at,
        lease_expires_at = excluded.lease_expires_at,
        generation = case
          when ? then excluded.generation
          when excluded.apns_token is not null
            and excluded.apns_token is not attention_devices.apns_token
            then excluded.generation
          when excluded.push_to_start_token is not null
            and excluded.push_to_start_token is not attention_devices.push_to_start_token
            then excluded.generation
          when excluded.bundle_id is not attention_devices.bundle_id
            then excluded.generation
          when excluded.aps_environment is not attention_devices.aps_environment
            then excluded.generation
          else attention_devices.generation
        end
    `).bind(
      userId,
      deviceId,
      apnsToken,
      pushToStartToken,
      bundleId,
      apsEnvironment,
      requiredString(payload.platform, 32),
      boundedText(payload.deviceName, 120),
      JSON.stringify(preferences),
      now,
      now,
      leaseExpiresAt,
      generation,
      clearPushToStartToken ? 1 : 0,
      clearPushToStartToken || ownershipChanged ? 1 : 0
    )
  );
  if (!clearPushToStartToken) {
    transferStatements.push(
      env.DB.prepare(`
        delete from attention_activity_state
        where user_id = ? and device_id = ? and started = 0
          and exists (
            select 1
            from attention_devices
            where user_id = ? and device_id = ? and generation = ?
          )
      `).bind(userId, deviceId, userId, deviceId, generation)
    );
  }
  if (clearPushToStartToken) {
    transferStatements.push(
      env.DB.prepare("delete from attention_activity_tokens where user_id = ? and device_id = ?").bind(userId, deviceId),
      env.DB.prepare("delete from attention_activity_state where user_id = ? and device_id = ?").bind(userId, deviceId)
    );
  }
  let issuedKey;
  try {
    const results = await env.DB.batch(
      transferStatements
    );
    issuedKey = issuedDeviceKey(keyChange, results[upsertIndex]);
  } catch (error2) {
    if (isAttentionDeviceLimitError(error2)) {
      return json({ ok: false, error: "account device limit reached" }, { status: 409 });
    }
    if (isAttentionDeviceOwnershipAssertError(error2)) {
      return attentionDeviceOwnershipUnproven();
    }
    if (isStaleAttentionDeviceOwnershipError(error2)) {
      return attentionDeviceOwnershipConflict(
        await latestAttentionDeviceOwnershipEpoch(
          env,
          deviceId,
          apnsToken,
          ownershipEpoch
        )
      );
    }
    throw error2;
  }
  await deliverAccountLiveActivity(env, userId);
  return json({
    ok: true,
    deviceId,
    ownershipEpoch,
    updatedAt: now,
    ...issuedKey ? { deviceKey: issuedKey } : {}
  });
}
__name(handleDeviceRegistration, "handleDeviceRegistration");
async function handleActivityTokenRegistration(request, env, userId, deviceId, activityId) {
  if (!requiredString(deviceId, 128) || !requiredString(activityId, 128)) {
    return json({ ok: false, error: "invalid activity target" }, { status: 400 });
  }
  const device = await env.DB.prepare("select 1 as found from attention_devices where user_id = ? and device_id = ? and lease_expires_at > ? limit 1").bind(userId, deviceId, (/* @__PURE__ */ new Date()).toISOString()).first();
  if (!device?.found) {
    return json({ ok: false, error: "attention device is not registered" }, { status: 404 });
  }
  if (request.method === "DELETE") {
    const generation2 = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`
        update attention_devices
        set generation = ?, updated_at = ?
        where user_id = ? and device_id = ? and lease_expires_at > ?
      `).bind(
        generation2,
        (/* @__PURE__ */ new Date()).toISOString(),
        userId,
        deviceId,
        (/* @__PURE__ */ new Date()).toISOString()
      ),
      env.DB.prepare(`
        delete from attention_activity_tokens
        where user_id = ? and device_id = ? and activity_id = ?
          and exists (
            select 1
            from attention_devices
            where user_id = ? and device_id = ? and generation = ?
          )
      `).bind(userId, deviceId, activityId, userId, deviceId, generation2),
      env.DB.prepare(`
        delete from attention_activity_state
        where user_id = ? and device_id = ? and activity_id = ?
          and exists (
            select 1
            from attention_devices
            where user_id = ? and device_id = ? and generation = ?
          )
      `).bind(userId, deviceId, activityId, userId, deviceId, generation2)
    ]);
    await deliverAccountLiveActivity(env, userId);
    return json({ ok: true, removed: true });
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const token = isRecord(payload) ? requiredString(payload.token, 512) : null;
  if (!token || !APNS_TOKEN_PATTERN.test(token)) {
    return json({ ok: false, error: "invalid activity token" }, { status: 400 });
  }
  const generation = crypto.randomUUID();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      update attention_devices
      set generation = ?, updated_at = ?
      where user_id = ? and device_id = ? and lease_expires_at > ?
    `).bind(generation, now, userId, deviceId, now),
    env.DB.prepare(`
      insert into attention_activity_tokens(
        user_id, device_id, activity_id, token, updated_at
      )
      select ?, ?, ?, ?, ?
      where exists (
        select 1
        from attention_devices
        where user_id = ? and device_id = ? and generation = ?
      )
      on conflict(user_id, device_id, activity_id) do update set
        token = excluded.token,
        updated_at = excluded.updated_at
    `).bind(
      userId,
      deviceId,
      activityId,
      token,
      now,
      userId,
      deviceId,
      generation
    ),
    env.DB.prepare(`
      insert into attention_activity_state(
        user_id, device_id, activity_id, started, fingerprint, updated_at
      )
      select ?, ?, ?, 1, null, ?
      where exists (
        select 1
        from attention_devices
        where user_id = ? and device_id = ? and generation = ?
      )
      on conflict(user_id, device_id, activity_id) do update set
        started = 1,
        updated_at = excluded.updated_at
    `).bind(
      userId,
      deviceId,
      activityId,
      now,
      userId,
      deviceId,
      generation
    )
  ]);
  await deliverAccountLiveActivity(env, userId);
  return json({ ok: true, removed: false });
}
__name(handleActivityTokenRegistration, "handleActivityTokenRegistration");
async function handleAuthorizedAttentionAccountRequest(request, env, url, userId) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "attention" || parts[1] !== "account") return null;
  const route = parts.slice(2);
  const settings = await handleAccountSettingsRoute(request, env, url, userId, route);
  if (settings) return settings;
  const vault = await handleAccountVaultRoute(request, env, url, userId, route);
  if (vault) return vault;
  const passwords = await handlePasswordsRoute(request, env, url, userId, route);
  if (passwords) return passwords;
  if (route.length === 1 && route[0] === "snapshot" && request.method === "GET") {
    return await handleSnapshot(env, userId, url);
  }
  if (route.length === 1 && route[0] === "ack" && request.method === "POST") {
    return await handleAcknowledgment(request, env, userId);
  }
  if (route.length === 1 && route[0] === "presence" && request.method === "POST") {
    return await handlePresence(request, env, userId);
  }
  if (route.length === 1 && route[0] === "notify" && request.method === "POST") {
    return await handleCustomNotification(request, env, userId);
  }
  if (route.length === 1 && route[0] === "preferences" && (request.method === "GET" || request.method === "PUT")) {
    return await handlePreferences(request, env, userId);
  }
  if (route.length === 3 && route[0] === "preferences" && route[1] === "devices" && request.method === "PATCH") {
    const deviceId = decodePathSegment(route[2]);
    if (deviceId === null) return attentionRouteNotFound();
    return await handleDevicePreferences(
      request,
      env,
      userId,
      deviceId
    );
  }
  if (route.length === 3 && route[0] === "preferences" && route[1] === "sessions" && request.method === "PATCH") {
    const sessionId = decodePathSegment(route[2]);
    if (sessionId === null) return attentionRouteNotFound();
    return await handleSessionMutePreference(
      request,
      env,
      userId,
      sessionId
    );
  }
  if (route.length === 3 && route[0] === "preferences" && route[1] === "machines" && request.method === "PATCH") {
    const machineKey = decodePathSegment(route[2]);
    if (machineKey === null) return attentionRouteNotFound();
    return await handleActivityMachinePreferences(
      request,
      env,
      userId,
      machineKey
    );
  }
  if (route.length === 2 && route[0] === "machines" && request.method === "DELETE") {
    const machineKey = decodePathSegment(route[1]);
    if (machineKey === null) return attentionRouteNotFound();
    return await handleAccountMachineRemoval(
      env,
      userId,
      machineKey
    );
  }
  if (route.length === 3 && route[0] === "machines" && route[2] === "pairing" && request.method === "POST") {
    const machineKey = decodePathSegment(route[1]);
    if (machineKey === null) return attentionRouteNotFound();
    return await handleAccountMachinePairingRestore(
      request,
      env,
      userId,
      machineKey
    );
  }
  if (route.length === 2 && route[0] === "devices" && (request.method === "PUT" || request.method === "DELETE")) {
    const deviceId = decodePathSegment(route[1]);
    if (deviceId === null) return attentionRouteNotFound();
    return await handleDeviceRegistration(
      request,
      env,
      userId,
      deviceId
    );
  }
  if (route.length === 4 && route[0] === "devices" && route[2] === "activities" && (request.method === "PUT" || request.method === "DELETE")) {
    const deviceId = decodePathSegment(route[1]);
    if (deviceId === null) return attentionRouteNotFound();
    const activityId = decodePathSegment(route[3]);
    if (activityId === null) return attentionRouteNotFound();
    return await handleActivityTokenRegistration(
      request,
      env,
      userId,
      deviceId,
      activityId
    );
  }
  return attentionRouteNotFound();
}
__name(handleAuthorizedAttentionAccountRequest, "handleAuthorizedAttentionAccountRequest");
function attentionRouteNotFound() {
  return json({ ok: false, error: "not found" }, { status: 404 });
}
__name(attentionRouteNotFound, "attentionRouteNotFound");
async function handleAttentionAccountRequest(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "attention" || parts[1] !== "account") return null;
  const account = await authorizedUser(request, env);
  if ("response" in account) return account.response;
  return await handleAuthorizedAttentionAccountRequest(
    request,
    env,
    url,
    account.userId
  );
}
__name(handleAttentionAccountRequest, "handleAttentionAccountRequest");
async function sweepExpiredAttentionItems(env, now) {
  const accounts = await env.DB.prepare(`
    select distinct user_id
    from attention_items
    where expires_at is not null and expires_at <= ?
    limit ?
  `).bind(now, MAX_SWEPT_ACCOUNTS_PER_PRUNE).all();
  for (const account of accounts.results) {
    await commitAttentionRevision(env, account.user_id, [
      env.DB.prepare(`
        insert into attention_tombstones(
          user_id, item_id, source_revision, account_revision, revivable, deleted_at
        )
        select user_id, item_id, source_revision,
          (select revision from attention_revisions where user_id = ?), 0, ?
        from attention_items
        where user_id = ? and expires_at is not null and expires_at <= ?
        on conflict(user_id, item_id) do update set
          source_revision = excluded.source_revision,
          account_revision = excluded.account_revision,
          revivable = 0,
          deleted_at = excluded.deleted_at
        where excluded.source_revision >= attention_tombstones.source_revision
      `).bind(account.user_id, now, account.user_id, now),
      env.DB.prepare(`
        delete from attention_items
        where user_id = ? and expires_at is not null and expires_at <= ?
      `).bind(account.user_id, now)
    ], now);
  }
}
__name(sweepExpiredAttentionItems, "sweepExpiredAttentionItems");
async function sweepOrphanedMachineActivity(env, now) {
  const staleCutoff = new Date(
    Date.parse(now) - ORPHANED_MACHINE_ACTIVITY_MS
  ).toISOString();
  const orphans = await env.DB.prepare(`
    select item.user_id as user_id, item.machine_key as machine_key
    from attention_items as item
    left join attention_machine_links as link
      on link.user_id = item.user_id
      and link.machine_key = item.machine_key
    group by item.user_id, item.machine_key
    having coalesce(max(link.last_seen_at), max(item.updated_at)) <= ?
    limit ?
  `).bind(staleCutoff, MAX_SWEPT_ACCOUNTS_PER_PRUNE).all();
  for (const orphan of orphans.results) {
    await purgeAccountMachineActivity(env, {
      userId: orphan.user_id,
      machineKey: orphan.machine_key,
      now,
      revoke: false
    });
  }
}
__name(sweepOrphanedMachineActivity, "sweepOrphanedMachineActivity");
async function sweepAttentionState(env) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await sweepExpiredAttentionItems(env, now);
  await sweepOrphanedMachineActivity(env, now);
}
__name(sweepAttentionState, "sweepAttentionState");
async function pruneAttentionState(env) {
  const now = /* @__PURE__ */ new Date();
  const tombstoneCutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_MS).toISOString();
  const presenceCutoff = new Date(now.getTime() - 10 * 60 * 1e3).toISOString();
  const receiptCutoff = new Date(
    now.getTime() - ATTENTION_DELIVERY_RECEIPT_RETENTION_MS
  ).toISOString();
  const alertLogCutoff = new Date(
    now.getTime() - ATTENTION_ALERT_LOG_RETENTION_MS
  ).toISOString();
  const expiredDevices = await env.DB.prepare(`
    select user_id, device_id
    from attention_devices
    where lease_expires_at <= ?
  `).bind(now.toISOString()).all();
  for (const device of expiredDevices.results) {
    await deleteAttentionDeviceOwnership(env, device.user_id, device.device_id);
  }
  await Promise.all([
    env.DB.batch([
      env.DB.prepare(`
        delete from attention_delivery_receipts
        where delivered_at <= ?
      `).bind(receiptCutoff),
      env.DB.prepare(`
        delete from attention_alert_log
        where delivered_at <= ?
      `).bind(alertLogCutoff)
    ]),
    env.DB.prepare("delete from attention_tombstones where deleted_at <= ?").bind(tombstoneCutoff).run(),
    env.DB.prepare("delete from attention_presence where observed_at <= ?").bind(presenceCutoff).run()
  ]);
}
__name(pruneAttentionState, "pruneAttentionState");
var attentionTestInternals = Object.freeze({
  accountMachineRevokedAt,
  activityPublishAcknowledgments,
  attentionAlertRoutingPayload,
  attentionFullSnapshotUnchanged,
  attentionTombstoneBlocksItem,
  commitAttentionMachineChanges,
  commitActivityReconcileFinal,
  deepLinkForItem,
  deliverAccountLiveActivity,
  deliverAttentionNotifications,
  desktopEscalationDelayMs,
  handleAuthorizedAttentionAccountRequest,
  resolvedMutedSessionIds,
  implicitFullSnapshotTombstone,
  linkMachineToAccount,
  attentionAlertCopy,
  normalizedSnapshotCursor,
  parseAttentionItem,
  purgeAccountMachineActivity,
  refreshActivityMachinePresence,
  resolveActivityDeliveryPreferences,
  sealCapacityTombstones,
  upsertAttentionTombstone,
  MAX_ALERT_AGE_MS
});

// src/sentryScrub.ts
init_modules_watch_stub();
var REDACTED = "[redacted]";
var MESSAGE_LIMIT = 200;
var SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g,
  /\bsntrys_[A-Za-z0-9_=-]{20,}/g,
  /\b(?:xai-|gsk_|sk_live_|sk_test_|rk_live_)[A-Za-z0-9_-]{16,}/g,
  /\b(?:npm|hf)_[A-Za-z0-9]{30,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*\S+/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi
];
var URL_QUERY = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?"'<>]*)\?[^\s"'<>]*/gi;
var RELAY_KEY_PATH = /\/(host|connect|prewarm|machines)\/[^\s/?#"']+/g;
var RELAY_HOOK_PATH = /\/hooks\/(?!(?:register|events|ack|subscribe)(?:[/?#\s"']|$))[^\s/?#"']+\/[^\s/?#"']+/g;
var SENSITIVE_KEY = /token|secret|passw|authorization|cookie|api[_-]?key|credential|private[_-]?key|signature|payload|body|machine[_-]?key|pairing/i;
function scrubString(value) {
  let out = value.replace(URL_QUERY, "$1?[redacted]");
  out = out.replace(RELAY_KEY_PATH, "/$1/[key]").replace(RELAY_HOOK_PATH, "/hooks/[id]/[token]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
__name(scrubString, "scrubString");
function scrubValue(value, depth = 0) {
  if (typeof value === "string") return scrubString(value);
  if (!value || typeof value !== "object") return value;
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) && typeof item !== "number" ? REDACTED : scrubValue(item, depth + 1);
  }
  return out;
}
__name(scrubValue, "scrubValue");
function scrubEvent(event) {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
  }
  delete event.user;
  for (const exception of event.exception?.values ?? []) {
    if (exception.type === "SyntaxError") exception.value = REDACTED;
    else if (exception.value && exception.value.length > MESSAGE_LIMIT) exception.value = `${exception.value.slice(0, MESSAGE_LIMIT)}\u2026`;
  }
  if (event.message && event.message.length > MESSAGE_LIMIT) event.message = `${event.message.slice(0, MESSAGE_LIMIT)}\u2026`;
  return scrubValue(event);
}
__name(scrubEvent, "scrubEvent");
function scrubBreadcrumb(breadcrumb) {
  if (breadcrumb.category === "console") return null;
  return scrubValue(breadcrumb);
}
__name(scrubBreadcrumb, "scrubBreadcrumb");
function scrubSpan(span) {
  if (span.name) span.name = scrubString(span.name);
  if (span.attributes) span.attributes = scrubValue(span.attributes);
  return span;
}
__name(scrubSpan, "scrubSpan");
var PER_FAILURE_PER_HOUR = 5;
var TOTAL_PER_HOUR = 60;
var HOUR_MS = 60 * 60 * 1e3;
var windowStart = 0;
var total = 0;
var perFailure = /* @__PURE__ */ new Map();
var CLOUDFLARE_DEPLOY_RESET = "durable-object-code-updated";
function admitEvent(event, nowMs = Date.now()) {
  const text2 = event.exception?.values?.map((value) => value.value ?? "").join("\n") || event.message || "";
  const transient = cloudflareTransientKindOfText(text2);
  if (transient === CLOUDFLARE_DEPLOY_RESET) return false;
  if (transient && !event.fingerprint?.length) event.fingerprint = ["cloudflare", transient];
  if (nowMs - windowStart >= HOUR_MS) {
    windowStart = nowMs;
    total = 0;
    perFailure.clear();
  }
  const exception = event.exception?.values?.[event.exception.values.length - 1];
  const key = event.fingerprint?.join("|") ?? `${exception?.type ?? "message"}|${event.transaction ?? ""}|${(exception?.value ?? event.message ?? "").slice(0, 80)}`;
  const seen = perFailure.get(key) ?? 0;
  if (total >= TOTAL_PER_HOUR || seen >= PER_FAILURE_PER_HOUR) return false;
  perFailure.set(key, seen + 1);
  total += 1;
  return true;
}
__name(admitEvent, "admitEvent");

// src/relay.ts
var MACHINE_KEY_PATTERN = /^[a-f0-9]{32,64}$/i;
var DEVICE_ID_PATTERN2 = /^[a-zA-Z0-9._:-]{4,128}$/;
var APNS_TOKEN_PATTERN2 = /^[a-f0-9]{32,512}$/i;
var MAX_BODY_BYTES2 = 256 * 1024;
var MAX_PUBLISH_ITEMS = 32;
var MAX_SECRET_LENGTH = 128;
var MIN_SECRET_LENGTH = 32;
var SIGNATURE_TIMESTAMP_SKEW_SECONDS = 5 * 60;
var SUPPRESSION_RETENTION_HOURS = 48;
var DEFAULT_REGISTRATION_RETENTION_DAYS = 120;
var DEFAULT_MAX_DEVICES_PER_MACHINE = 16;
var MAX_ACTIVITY_ID_CHARS = 128;
var MAX_BUNDLE_ID_CHARS = 255;
var MAX_DEDUPE_KEY_CHARS = 256;
var MAX_DEVICE_NAME_CHARS = 120;
var MAX_PLATFORM_CHARS = 32;
var MAX_ACTIVITY_TOKENS_PER_MACHINE = 256;
var ACTIVITY_TOKEN_RETENTION_HOURS = 24;
var MACHINE_LAST_SEEN_STAMP_INTERVAL_MS = 60 * 60 * 1e3;
var RATE_COUNTER_RETENTION_MINUTES = 15;
var PHASE_TTL_SECONDS = {
  running: 2 * 60 * 60,
  waiting: 24 * 60 * 60,
  terminal: 24 * 60 * 60
};
var encoder3 = new TextEncoder();
function json2(value, init2 = {}) {
  return new Response(JSON.stringify(value), {
    ...init2,
    headers: {
      "content-type": "application/json",
      ...init2.headers ?? {}
    }
  });
}
__name(json2, "json");
function text(value, status = 200) {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
__name(text, "text");
function isRecord2(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
__name(isRecord2, "isRecord");
function readString(source, key) {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}
__name(readString, "readString");
function readOptionalString(source, key) {
  const value = readString(source, key);
  return value ? value : null;
}
__name(readOptionalString, "readOptionalString");
function readDedupeKey(source) {
  const value = readOptionalString(source, "dedupeKey");
  return value && value.length <= MAX_DEDUPE_KEY_CHARS ? value : null;
}
__name(readDedupeKey, "readDedupeKey");
function readNumber(source, key) {
  const raw = source?.[key];
  if (raw === null || raw === void 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
__name(readNumber, "readNumber");
async function hmacSha256Hex(secret, message2) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder3.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder3.encode(message2)));
}
__name(hmacSha256Hex, "hmacSha256Hex");
async function buildSignatureBase(args) {
  const bodyHash = await sha256Hex(args.body);
  return `${args.timestamp}.${args.method.toUpperCase()}.${args.pathname}.${bodyHash}`;
}
__name(buildSignatureBase, "buildSignatureBase");
async function signPushRelayRequest(secret, args) {
  return `sha256=${await hmacSha256Hex(secret, await buildSignatureBase(args))}`;
}
__name(signPushRelayRequest, "signPushRelayRequest");
function parseTimestampSeconds(raw) {
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return raw.length === 13 ? Math.floor(numeric / 1e3) : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1e3) : null;
}
__name(parseTimestampSeconds, "parseTimestampSeconds");
async function loadMachine(env, machineKey) {
  return await env.DB.prepare("select machine_key, secret, last_seen_at from machines where machine_key = ? limit 1").bind(machineKey).first();
}
__name(loadMachine, "loadMachine");
async function assertMachineAuthorized(request, env, machineKey, body) {
  const keyPrefix = machineKey.slice(0, 8);
  const machine = await loadMachine(env, machineKey);
  if (!machine) {
    logEvent("auth_failed", { reason: "unknown_machine", machineKey: keyPrefix, ip: clientIp(request) });
    return { response: json2({ ok: false, error: "unknown machine" }, { status: 401 }) };
  }
  const timestamp = request.headers.get("x-ade-push-timestamp")?.trim() || "";
  const signature = request.headers.get("x-ade-push-signature")?.trim() || "";
  if (!timestamp || !signature) {
    logEvent("auth_failed", { reason: "missing_signature", machineKey: keyPrefix, ip: clientIp(request) });
    return { response: json2({ ok: false, error: "missing signature headers" }, { status: 401 }) };
  }
  const timestampSeconds = parseTimestampSeconds(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1e3);
  if (timestampSeconds == null || Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TIMESTAMP_SKEW_SECONDS) {
    logEvent("auth_failed", { reason: "stale_timestamp", machineKey: keyPrefix, ip: clientIp(request) });
    return { response: json2({ ok: false, error: "stale or invalid timestamp" }, { status: 401 }) };
  }
  const expected = await signPushRelayRequest(machine.secret, {
    timestamp,
    method: request.method,
    pathname: new URL(request.url).pathname,
    body
  });
  if (!constantTimeEqual(expected, signature)) {
    logEvent("auth_failed", { reason: "bad_signature", machineKey: keyPrefix, ip: clientIp(request) });
    return { response: json2({ ok: false, error: "unauthorized" }, { status: 401 }) };
  }
  const lastSeenMs = machine.last_seen_at ? Date.parse(machine.last_seen_at) : Number.NaN;
  if (!Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs >= MACHINE_LAST_SEEN_STAMP_INTERVAL_MS) {
    await env.DB.prepare("update machines set last_seen_at = ? where machine_key = ?").bind((/* @__PURE__ */ new Date()).toISOString(), machineKey).run();
  }
  return { machine };
}
__name(assertMachineAuthorized, "assertMachineAuthorized");
function apnsConfig2(env) {
  const keyPem = env.APNS_KEY?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  if (!keyPem || !keyId || !teamId) return null;
  return { keyPem, keyId, teamId };
}
__name(apnsConfig2, "apnsConfig");
function parseBodyJson(body) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    return isRecord2(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
__name(parseBodyJson, "parseBodyJson");
function normalizeEnvironment(raw) {
  if (raw === "sandbox" || raw === "production") return raw;
  if (raw === "development") return "sandbox";
  return null;
}
__name(normalizeEnvironment, "normalizeEnvironment");
function normalizePhase(raw) {
  return raw === "running" || raw === "waiting" || raw === "terminal" ? raw : "waiting";
}
__name(normalizePhase, "normalizePhase");
function readDeviceIds(source) {
  const raw = source.deviceIds;
  if (!Array.isArray(raw)) return null;
  return raw.filter((value) => typeof value === "string").map((value) => value.trim()).filter((value) => DEVICE_ID_PATTERN2.test(value));
}
__name(readDeviceIds, "readDeviceIds");
function parseAlertItems(raw) {
  if (!Array.isArray(raw)) return [];
  const items = [];
  for (const entry of raw.slice(0, MAX_PUBLISH_ITEMS)) {
    if (!isRecord2(entry)) continue;
    const title = readString(entry, "title");
    const badgeRaw = readNumber(entry, "badge");
    const badge = badgeRaw != null && badgeRaw >= 0 ? Math.floor(badgeRaw) : null;
    if (!title && badge == null) continue;
    const interruption = readString(entry, "interruptionLevel");
    items.push({
      deviceIds: readDeviceIds(entry),
      title,
      subtitle: readOptionalString(entry, "subtitle"),
      body: readOptionalString(entry, "body"),
      deepLink: readOptionalString(entry, "deepLink"),
      threadId: readOptionalString(entry, "threadId"),
      sound: entry.sound === null ? null : readOptionalString(entry, "sound") ?? "default",
      interruptionLevel: interruption === "passive" || interruption === "active" || interruption === "time-sensitive" ? interruption : null,
      collapseId: readOptionalString(entry, "collapseId"),
      dedupeKey: readDedupeKey(entry),
      phase: normalizePhase(readString(entry, "phase")),
      sessionId: readOptionalString(entry, "sessionId"),
      itemId: readOptionalString(entry, "itemId"),
      category: readOptionalString(entry, "category"),
      badge
    });
  }
  return items;
}
__name(parseAlertItems, "parseAlertItems");
function parseLiveActivityItems(raw) {
  if (!Array.isArray(raw)) return [];
  const items = [];
  for (const entry of raw.slice(0, MAX_PUBLISH_ITEMS)) {
    if (!isRecord2(entry)) continue;
    const event = readString(entry, "event");
    const activityId = readString(entry, "activityId");
    const contentState = isRecord2(entry.contentState) ? entry.contentState : null;
    if (event !== "start" && event !== "update" && event !== "end" || !activityId || !contentState) continue;
    if (activityId.length > MAX_ACTIVITY_ID_CHARS) continue;
    const alert = isRecord2(entry.alert) && readString(entry.alert, "title") ? { title: readString(entry.alert, "title"), body: readOptionalString(entry.alert, "body") } : null;
    items.push({
      deviceIds: readDeviceIds(entry),
      event,
      activityId,
      attributesType: readOptionalString(entry, "attributesType"),
      attributes: isRecord2(entry.attributes) ? entry.attributes : null,
      contentState,
      staleDate: readNumber(entry, "staleDate"),
      dismissalDate: readNumber(entry, "dismissalDate"),
      relevanceScore: readNumber(entry, "relevanceScore"),
      alert,
      dedupeKey: readDedupeKey(entry),
      phase: normalizePhase(readString(entry, "phase"))
    });
  }
  return items;
}
__name(parseLiveActivityItems, "parseLiveActivityItems");
async function listMachineDevices(env, machineKey) {
  return (await env.DB.prepare(`
      select machine_key, device_id, apns_token, push_to_start_token, bundle_id,
             aps_environment, platform, device_name, registered_at, updated_at,
             generation
        from device_registrations
       where machine_key = ?
       order by updated_at desc
    `).bind(machineKey).all()).results ?? [];
}
__name(listMachineDevices, "listMachineDevices");
async function loadActivityTokens(env, machineKey, activityId) {
  return (await env.DB.prepare(`
      select device_id, activity_id, token
        from live_activity_tokens
       where machine_key = ? and activity_id = ?
    `).bind(machineKey, activityId).all()).results ?? [];
}
__name(loadActivityTokens, "loadActivityTokens");
async function loadSuppressions(env, machineKey, dedupeKeys) {
  const keys = [...new Set(dedupeKeys)];
  const suppressions = /* @__PURE__ */ new Map();
  if (keys.length === 0) return suppressions;
  const rows = (await env.DB.prepare(`
      select suppression_key, content_hash from publish_suppression
       where machine_key = ? and suppression_key in (${keys.map(() => "?").join(", ")})
    `).bind(machineKey, ...keys).all()).results ?? [];
  for (const row of rows) suppressions.set(row.suppression_key, row.content_hash);
  return suppressions;
}
__name(loadSuppressions, "loadSuppressions");
async function recordSuppression(env, machineKey, dedupeKey, contentHash) {
  await env.DB.prepare(`
      insert into publish_suppression(machine_key, suppression_key, content_hash, published_at)
      values (?, ?, ?, ?)
      on conflict(machine_key, suppression_key) do update set
        content_hash = excluded.content_hash,
        published_at = excluded.published_at
    `).bind(machineKey, dedupeKey, contentHash, (/* @__PURE__ */ new Date()).toISOString()).run();
}
__name(recordSuppression, "recordSuppression");
function liveActivitySuppressionPrefix(deviceId) {
  return `liveactivity:${deviceId.length}:${deviceId}:`;
}
__name(liveActivitySuppressionPrefix, "liveActivitySuppressionPrefix");
async function clearInvalidToken(env, machineKey, deviceId, column) {
  await env.DB.prepare(`update device_registrations set ${column} = null, updated_at = ? where machine_key = ? and device_id = ?`).bind((/* @__PURE__ */ new Date()).toISOString(), machineKey, deviceId).run();
}
__name(clearInvalidToken, "clearInvalidToken");
async function deleteActivityToken(env, machineKey, deviceId, activityId) {
  await env.DB.prepare("delete from live_activity_tokens where machine_key = ? and device_id = ? and activity_id = ?").bind(machineKey, deviceId, activityId).run();
}
__name(deleteActivityToken, "deleteActivityToken");
function logEvent(kind, fields = {}) {
  try {
    console.log(JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), svc: "ade-push-relay", ...fields, kind }));
  } catch {
    console.log(`ade-push-relay ${kind}`);
  }
}
__name(logEvent, "logEvent");
function clientIp(request) {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return ip && ip.length > 0 ? ip : "unknown";
}
__name(clientIp, "clientIp");
function rateLimitedResponse() {
  return json2({ ok: false, error: "rate limited" }, { status: 429, headers: { "retry-after": "60" } });
}
__name(rateLimitedResponse, "rateLimitedResponse");
function budgetExceededResponse() {
  return json2({ ok: false, error: "relay daily budget reached" }, { status: 429, headers: { "retry-after": "3600" } });
}
__name(budgetExceededResponse, "budgetExceededResponse");
async function sweepRelayState(env) {
  await sweepAttentionState(env);
}
__name(sweepRelayState, "sweepRelayState");
async function pruneRelayState(env) {
  const suppressionCutoff = new Date(Date.now() - SUPPRESSION_RETENTION_HOURS * 60 * 60 * 1e3).toISOString();
  await env.DB.prepare("delete from publish_suppression where published_at < ?").bind(suppressionCutoff).run();
  const days = Number(env.REGISTRATION_RETENTION_DAYS ?? DEFAULT_REGISTRATION_RETENTION_DAYS);
  const retentionDays = Number.isFinite(days) ? Math.max(7, Math.trunc(days)) : DEFAULT_REGISTRATION_RETENTION_DAYS;
  const registrationCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1e3).toISOString();
  await env.DB.prepare("delete from device_registrations where updated_at < ?").bind(registrationCutoff).run();
  const activityTokenCutoff = new Date(Date.now() - ACTIVITY_TOKEN_RETENTION_HOURS * 60 * 60 * 1e3).toISOString();
  await env.DB.prepare("delete from live_activity_tokens where updated_at < ?").bind(activityTokenCutoff).run();
  const rateCutoff = new Date(Date.now() - RATE_COUNTER_RETENTION_MINUTES * 60 * 1e3).toISOString();
  await env.DB.prepare("delete from rate_counters where bucket not like 'budget:%' and bucket not like 'notify:%' and updated_at < ?").bind(rateCutoff).run();
  const notifyCutoff = new Date(Date.now() - 2 * ACCOUNT_NOTIFY_WINDOW_SECONDS * 1e3).toISOString();
  await env.DB.prepare("delete from rate_counters where bucket like 'notify:%' and updated_at < ?").bind(notifyCutoff).run();
  const budgetCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1e3).toISOString();
  await env.DB.prepare("delete from rate_counters where bucket like 'budget:%' and updated_at < ?").bind(budgetCutoff).run();
  await pruneAttentionState(env);
}
__name(pruneRelayState, "pruneRelayState");
function phaseExpiration(phase, nowSeconds = Math.floor(Date.now() / 1e3)) {
  return nowSeconds + PHASE_TTL_SECONDS[phase];
}
__name(phaseExpiration, "phaseExpiration");
function alertApnsPayload(item) {
  const aps = {};
  if (item.title) {
    aps.alert = {
      title: item.title,
      ...item.subtitle ? { subtitle: item.subtitle } : {},
      ...item.body ? { body: item.body } : {}
    };
  }
  if (item.sound) aps.sound = item.sound;
  if (item.threadId) aps["thread-id"] = item.threadId;
  if (item.interruptionLevel) aps["interruption-level"] = item.interruptionLevel;
  if (item.category) aps.category = item.category;
  if (item.badge != null) aps.badge = item.badge;
  return {
    aps,
    ...item.deepLink ? { deepLink: item.deepLink } : {},
    ...item.sessionId ? { sessionId: item.sessionId } : {},
    ...item.itemId ? { itemId: item.itemId } : {}
  };
}
__name(alertApnsPayload, "alertApnsPayload");
var DEFAULT_STALE_AFTER_SECONDS = 10 * 60;
function liveActivityEndApnsPayload(item, nowSeconds) {
  const aps = {
    timestamp: nowSeconds,
    event: "end",
    "content-state": item.contentState
  };
  if (item.staleDate != null) aps["stale-date"] = Math.floor(item.staleDate);
  if (item.relevanceScore != null) aps["relevance-score"] = item.relevanceScore;
  if (item.dismissalDate != null) aps["dismissal-date"] = Math.floor(item.dismissalDate);
  return { aps };
}
__name(liveActivityEndApnsPayload, "liveActivityEndApnsPayload");
function liveActivityTopic(bundleId) {
  return `${bundleId}.push-type.liveactivity`;
}
__name(liveActivityTopic, "liveActivityTopic");
function selectTargets(devices, requested) {
  if (!requested) return devices;
  const wanted = new Set(requested);
  return devices.filter((device) => wanted.has(device.device_id));
}
__name(selectTargets, "selectTargets");
async function deliverAlertItem(env, config, machineKey, devices, item, defaultTopic, suppressions) {
  const outcomes = [];
  const targets = selectTargets(devices, item.deviceIds).filter((device) => device.apns_token);
  if (targets.length === 0) return outcomes;
  let suppressionHash = null;
  if (item.dedupeKey) {
    suppressionHash = await sha256Hex(JSON.stringify(alertApnsPayload(item)));
    if (suppressions.get(item.dedupeKey) === suppressionHash) {
      return targets.map((device) => ({
        deviceId: device.device_id,
        kind: "alert",
        delivered: false,
        suppressed: true,
        skipped: null,
        status: null,
        reason: null
      }));
    }
  }
  const expiration = phaseExpiration(item.phase);
  for (const device of targets) {
    const environment = normalizeEnvironment(device.aps_environment) ?? "production";
    const result = await sendApnsPush(config, {
      environment,
      deviceToken: device.apns_token,
      topic: device.bundle_id || defaultTopic,
      pushType: "alert",
      priority: 10,
      expiration,
      collapseId: item.collapseId,
      payload: alertApnsPayload(item)
    });
    if (result.tokenInvalid) {
      await clearInvalidToken(env, machineKey, device.device_id, "apns_token");
    }
    if (!result.ok) {
      logEvent("apns_error", { push: "alert", device: device.device_id.slice(-6), status: result.status, reason: result.reason, tokenInvalid: result.tokenInvalid });
    }
    outcomes.push({
      deviceId: device.device_id,
      kind: "alert",
      delivered: result.ok,
      suppressed: false,
      skipped: null,
      status: result.status,
      reason: result.reason
    });
  }
  if (item.dedupeKey && suppressionHash && outcomes.some((outcome) => outcome.delivered)) {
    await recordSuppression(env, machineKey, item.dedupeKey, suppressionHash);
    suppressions.set(item.dedupeKey, suppressionHash);
  }
  return outcomes;
}
__name(deliverAlertItem, "deliverAlertItem");
async function deliverLegacyLiveActivityEnd(env, config, machineKey, devices, item, defaultTopic) {
  const outcomes = [];
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const payload = liveActivityEndApnsPayload(item, nowSeconds);
  const expiration = phaseExpiration(item.phase, nowSeconds);
  const activityTokens = await loadActivityTokens(env, machineKey, item.activityId);
  const deviceById = new Map(devices.map((device) => [device.device_id, device]));
  const wanted = item.deviceIds ? new Set(item.deviceIds) : null;
  for (const tokenRow of activityTokens) {
    if (wanted && !wanted.has(tokenRow.device_id)) continue;
    const device = deviceById.get(tokenRow.device_id);
    if (!device) continue;
    const environment = normalizeEnvironment(device.aps_environment) ?? "production";
    const result = await sendApnsPush(config, {
      environment,
      deviceToken: tokenRow.token,
      topic: liveActivityTopic(device.bundle_id || defaultTopic),
      pushType: "liveactivity",
      priority: 10,
      expiration,
      collapseId: item.activityId,
      payload
    });
    if (result.ok || result.tokenInvalid) {
      await deleteActivityToken(env, machineKey, tokenRow.device_id, item.activityId);
    }
    if (!result.ok) {
      logEvent("apns_error", { push: "la_end", device: tokenRow.device_id.slice(-6), status: result.status, reason: result.reason, tokenInvalid: result.tokenInvalid });
    }
    outcomes.push({
      deviceId: tokenRow.device_id,
      kind: "liveactivity",
      delivered: result.ok,
      suppressed: false,
      skipped: null,
      status: result.status,
      reason: result.reason
    });
  }
  return outcomes;
}
__name(deliverLegacyLiveActivityEnd, "deliverLegacyLiveActivityEnd");
async function handleMachineClaim(request, env, machineKey) {
  if (request.method !== "POST") return text("method not allowed", 405);
  if (!MACHINE_KEY_PATTERN.test(machineKey)) {
    return json2({ ok: false, error: "machine key must be 32-64 hex characters" }, { status: 400 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES2) {
    return json2({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const payload = parseBodyJson(body);
  const secret = payload ? readString(payload, "secret") : "";
  if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
    return json2({ ok: false, error: `secret must be ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters` }, { status: 400 });
  }
  const existingBefore = await loadMachine(env, machineKey);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare("insert into machines(machine_key, secret, created_at, last_seen_at) values (?, ?, ?, ?) on conflict(machine_key) do nothing").bind(machineKey, secret, now, now).run();
  const stored = await loadMachine(env, machineKey);
  if (!stored) {
    return json2({ ok: false, error: "claim failed" }, { status: 500 });
  }
  if (!constantTimeEqual(stored.secret, secret)) {
    logEvent("claim_conflict", { machineKey: machineKey.slice(0, 8), ip: clientIp(request) });
    return json2({ ok: false, error: "machine key is already claimed" }, { status: 409 });
  }
  return existingBefore ? json2({ ok: true, claimed: false }) : json2({ ok: true, claimed: true }, { status: 201 });
}
__name(handleMachineClaim, "handleMachineClaim");
async function handleDeviceUpsert(request, env, machineKey, deviceId) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES2) {
    return json2({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const revokedAt = await machineKeyRevokedAt(env, machineKey);
  if (revokedAt) return machineRevokedResponse(revokedAt);
  if (!DEVICE_ID_PATTERN2.test(deviceId)) {
    return json2({ ok: false, error: "invalid device id" }, { status: 400 });
  }
  const payload = parseBodyJson(body);
  if (!payload) return json2({ ok: false, error: "invalid json" }, { status: 400 });
  const bundleId = readString(payload, "bundleId");
  const environment = normalizeEnvironment(readString(payload, "apsEnvironment"));
  if (!bundleId || !environment) {
    return json2({ ok: false, error: "bundleId and apsEnvironment (sandbox|production) are required" }, { status: 400 });
  }
  if (bundleId.length > MAX_BUNDLE_ID_CHARS) {
    return json2({ ok: false, error: "bundleId is too long" }, { status: 400 });
  }
  const apnsToken = readOptionalString(payload, "apnsToken");
  const pushToStartToken = readOptionalString(payload, "pushToStartToken");
  const clearPushToStartToken = payload.clearPushToStartToken === true;
  if (pushToStartToken && clearPushToStartToken) {
    return json2(
      { ok: false, error: "pushToStartToken cannot be set and cleared together" },
      { status: 400 }
    );
  }
  if (apnsToken && !APNS_TOKEN_PATTERN2.test(apnsToken)) {
    return json2({ ok: false, error: "invalid apnsToken" }, { status: 400 });
  }
  if (pushToStartToken && !APNS_TOKEN_PATTERN2.test(pushToStartToken)) {
    return json2({ ok: false, error: "invalid pushToStartToken" }, { status: 400 });
  }
  const devices = await listMachineDevices(env, machineKey);
  const maxDevicesRaw = Number(env.MAX_DEVICES_PER_MACHINE ?? DEFAULT_MAX_DEVICES_PER_MACHINE);
  const maxDevices = Number.isFinite(maxDevicesRaw) ? Math.max(1, Math.trunc(maxDevicesRaw)) : DEFAULT_MAX_DEVICES_PER_MACHINE;
  const isExisting = devices.some((device) => device.device_id === deviceId);
  if (!isExisting && devices.length >= maxDevices) {
    return json2({ ok: false, error: "device limit reached for this machine" }, { status: 409 });
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const generation = crypto.randomUUID();
  const registrationStatement = env.DB.prepare(`
      insert into device_registrations(
        machine_key, device_id, apns_token, push_to_start_token, bundle_id,
        aps_environment, platform, device_name, registered_at, updated_at,
        generation
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(machine_key, device_id) do update set
        apns_token = coalesce(excluded.apns_token, device_registrations.apns_token),
        push_to_start_token = case
          when ? then null
          else coalesce(excluded.push_to_start_token, device_registrations.push_to_start_token)
        end,
        bundle_id = excluded.bundle_id,
        aps_environment = excluded.aps_environment,
        platform = coalesce(excluded.platform, device_registrations.platform),
        device_name = coalesce(excluded.device_name, device_registrations.device_name),
        updated_at = excluded.updated_at,
        generation = excluded.generation
    `).bind(
    machineKey,
    deviceId,
    apnsToken,
    pushToStartToken,
    bundleId,
    environment,
    boundedText(payload.platform, MAX_PLATFORM_CHARS),
    boundedText(payload.deviceName, MAX_DEVICE_NAME_CHARS),
    now,
    now,
    generation,
    clearPushToStartToken ? 1 : 0
  );
  if (clearPushToStartToken) {
    const suppressionPrefix = liveActivitySuppressionPrefix(deviceId);
    await env.DB.batch([
      registrationStatement,
      env.DB.prepare(
        "delete from publish_suppression where machine_key = ? and substr(suppression_key, 1, ?) = ?"
      ).bind(machineKey, suppressionPrefix.length, suppressionPrefix),
      env.DB.prepare(
        "delete from live_activity_tokens where machine_key = ? and device_id = ?"
      ).bind(machineKey, deviceId)
    ]);
  } else {
    await registrationStatement.run();
  }
  await pruneRelayState(env);
  return json2({ ok: true, deviceId, updatedAt: now });
}
__name(handleDeviceUpsert, "handleDeviceUpsert");
async function handleDeviceDelete(request, env, machineKey, deviceId) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES2) {
    return json2({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const revokedAt = await machineKeyRevokedAt(env, machineKey);
  if (revokedAt) return machineRevokedResponse(revokedAt);
  await env.DB.prepare("delete from device_registrations where machine_key = ? and device_id = ?").bind(machineKey, deviceId).run();
  await env.DB.prepare("delete from live_activity_tokens where machine_key = ? and device_id = ?").bind(machineKey, deviceId).run();
  return json2({ ok: true, deviceId });
}
__name(handleDeviceDelete, "handleDeviceDelete");
async function handleDeviceList(request, env, machineKey) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES2) {
    return json2({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const revokedAt = await machineKeyRevokedAt(env, machineKey);
  if (revokedAt) return machineRevokedResponse(revokedAt);
  const devices = await listMachineDevices(env, machineKey);
  return json2({
    ok: true,
    devices: devices.map((device) => ({
      deviceId: device.device_id,
      hasApnsToken: Boolean(device.apns_token),
      hasPushToStartToken: Boolean(device.push_to_start_token),
      bundleId: device.bundle_id,
      apsEnvironment: device.aps_environment,
      platform: device.platform,
      deviceName: device.device_name,
      registeredAt: device.registered_at,
      updatedAt: device.updated_at
    }))
  });
}
__name(handleDeviceList, "handleDeviceList");
function machineRevokedResponse(revokedAt) {
  return json2({
    ok: false,
    error: "machine removed from account",
    code: "machine_revoked",
    revokedAt,
    recovery: "This machine was removed from the ADE account. Pair it again to publish activity."
  }, { status: 403 });
}
__name(machineRevokedResponse, "machineRevokedResponse");
async function handleActivityTokenUpsert(request, env, machineKey) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES2) {
    return json2({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const revokedAt = await machineKeyRevokedAt(env, machineKey);
  if (revokedAt) return machineRevokedResponse(revokedAt);
  const payload = parseBodyJson(body);
  if (!payload) return json2({ ok: false, error: "invalid json" }, { status: 400 });
  const deviceId = readString(payload, "deviceId");
  const activityId = readString(payload, "activityId");
  const token = readString(payload, "token");
  if (!DEVICE_ID_PATTERN2.test(deviceId) || !activityId) {
    return json2({ ok: false, error: "deviceId and activityId are required" }, { status: 400 });
  }
  if (activityId.length > MAX_ACTIVITY_ID_CHARS) {
    return json2({ ok: false, error: "activityId is too long" }, { status: 400 });
  }
  if (!token) {
    await deleteActivityToken(env, machineKey, deviceId, activityId);
    return json2({ ok: true, removed: true });
  }
  if (!APNS_TOKEN_PATTERN2.test(token)) {
    return json2({ ok: false, error: "invalid activity token" }, { status: 400 });
  }
  await env.DB.prepare(`
      insert into live_activity_tokens(machine_key, device_id, activity_id, token, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(machine_key, device_id, activity_id) do update set
        token = excluded.token,
        updated_at = excluded.updated_at
    `).bind(machineKey, deviceId, activityId, token, (/* @__PURE__ */ new Date()).toISOString()).run();
  await env.DB.prepare(`
      delete from live_activity_tokens
       where machine_key = ?
         and rowid not in (
           select rowid from live_activity_tokens
            where machine_key = ?
            order by updated_at desc
            limit ?
         )
    `).bind(machineKey, machineKey, MAX_ACTIVITY_TOKENS_PER_MACHINE).run();
  return json2({ ok: true, removed: false });
}
__name(handleActivityTokenUpsert, "handleActivityTokenUpsert");
async function handlePublish(request, env, machineKey) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES2) {
    return json2({ ok: false, error: "payload too large" }, { status: 413 });
  }
  const auth = await assertMachineAuthorized(request, env, machineKey, body);
  if ("response" in auth) return auth.response;
  const revokedAt = await machineKeyRevokedAt(env, machineKey);
  if (revokedAt) return machineRevokedResponse(revokedAt);
  const config = apnsConfig2(env);
  if (!config) {
    return json2({ ok: false, error: "APNs signing key is not configured on the relay" }, { status: 503 });
  }
  const payload = parseBodyJson(body);
  if (!payload) return json2({ ok: false, error: "invalid json" }, { status: 400 });
  const alerts = parseAlertItems(payload.notifications);
  const liveActivities = parseLiveActivityItems(payload.liveActivity);
  if (alerts.length === 0 && liveActivities.length === 0) {
    return json2({ ok: false, error: "nothing to publish" }, { status: 400 });
  }
  const devices = await listMachineDevices(env, machineKey);
  const defaultTopic = env.APNS_DEFAULT_TOPIC?.trim() || "";
  const outcomes = [];
  const suppressions = await loadSuppressions(
    env,
    machineKey,
    alerts.flatMap((item) => item.dedupeKey ? [item.dedupeKey] : [])
  );
  for (const item of alerts) {
    outcomes.push(...await deliverAlertItem(env, config, machineKey, devices, item, defaultTopic, suppressions));
  }
  for (const item of liveActivities) {
    if (item.event !== "end") {
      for (const device of devices) {
        if (item.deviceIds && !item.deviceIds.includes(device.device_id)) continue;
        outcomes.push({
          deviceId: device.device_id,
          kind: "liveactivity",
          delivered: false,
          suppressed: true,
          skipped: null,
          status: null,
          reason: "account_live_activity_only"
        });
      }
      continue;
    }
    outcomes.push(...await deliverLegacyLiveActivityEnd(env, config, machineKey, devices, item, defaultTopic));
  }
  await pruneRelayState(env);
  return json2({
    ok: true,
    delivered: outcomes.filter((outcome) => outcome.delivered).length,
    suppressed: outcomes.filter((outcome) => outcome.suppressed).length,
    failed: outcomes.filter((outcome) => !outcome.delivered && !outcome.suppressed && !outcome.skipped).length,
    outcomes
  });
}
__name(handlePublish, "handlePublish");
function routeMachine(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && parts[0] === "machines") {
    const machineKey = decodePathSegment(parts[1]);
    return machineKey === null ? null : { machineKey, rest: parts.slice(2) };
  }
  return null;
}
__name(routeMachine, "routeMachine");
function trustedWebClientOrigin(env) {
  const raw = env.WEB_CLIENT_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.origin !== raw || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}
__name(trustedWebClientOrigin, "trustedWebClientOrigin");
function withAccountCors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "Content-Type");
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
__name(withAccountCors, "withAccountCors");
async function handleRequest(request, env) {
  try {
    return await routeRequest(request, { ...env, DB: retryD1Reads(env.DB) });
  } catch (error2) {
    const kind = cloudflareTransientKind(error2);
    if (!kind) throw error2;
    const url = new URL(request.url);
    logCloudflareTransient("ade-push-relay", kind, scrubString(url.pathname), error2);
    const response = transientUnavailableResponse();
    const origin = request.headers.get("origin");
    return url.pathname.startsWith("/attention/account/") && origin && trustedWebClientOrigin(env) === origin ? withAccountCors(response, origin) : response;
  }
}
__name(handleRequest, "handleRequest");
async function routeRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    const accountAuth = inspectAttentionAuthConfiguration(env);
    return json2({
      ok: true,
      apnsConfigured: apnsConfig2(env) != null,
      accountAuthConfigured: accountAuth.configured,
      primaryAccountAuthConfigured: accountAuth.primaryConfigured,
      secondaryAccountAuthConfigured: accountAuth.secondaryConfigured,
      accountAuthConfigurationErrors: accountAuth.errors
    });
  }
  const accountAttentionRoute = url.pathname.startsWith("/attention/account/");
  const requestOrigin = request.headers.get("origin");
  const configuredWebOrigin = trustedWebClientOrigin(env);
  const corsOrigin = requestOrigin && configuredWebOrigin === requestOrigin ? requestOrigin : null;
  const withAllowedAccountCors = /* @__PURE__ */ __name((response) => accountAttentionRoute && corsOrigin ? withAccountCors(response, corsOrigin) : response, "withAllowedAccountCors");
  if (accountAttentionRoute && request.method === "OPTIONS") {
    if (!corsOrigin) return text("origin not allowed", 403);
    const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase();
    if (!requestedMethod || !["GET", "POST", "PUT"].includes(requestedMethod)) {
      return text("method not allowed", 405);
    }
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "").split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some(
      (header) => header !== "authorization" && header !== "content-type"
    )) {
      return text("headers not allowed", 403);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization, content-type",
        "access-control-expose-headers": "Content-Type",
        "access-control-allow-methods": `${requestedMethod}, OPTIONS`,
        "access-control-max-age": "600",
        vary: "Origin"
      }
    });
  }
  if (accountAttentionRoute && requestOrigin && !corsOrigin) {
    return text("origin not allowed", 403);
  }
  if (contentLengthExceeds(request.headers, MAX_BODY_BYTES2)) {
    return withAllowedAccountCors(
      json2({ ok: false, error: "payload too large" }, { status: 413 })
    );
  }
  if (budgetTrippedNow()) {
    return withAllowedAccountCors(budgetExceededResponse());
  }
  const budget = await recordDailyBudget(env);
  if (!budget.allowed) {
    logEvent("budget_exceeded", { day: budget.day, count: budget.count, budget: budget.budget });
    return withAllowedAccountCors(budgetExceededResponse());
  }
  const ip = clientIp(request);
  const ipLimit = positiveIntEnv(env.IP_RATE_LIMIT_PER_MIN, DEFAULT_IP_RATE_LIMIT_PER_MIN);
  const ipGate = checkIpRateInMemory(ip, ipLimit, RATE_WINDOW_SECONDS);
  if (!ipGate.allowed) {
    logEvent("rate_limited", { scope: "ip", ip, count: ipGate.count, limit: ipLimit, path: url.pathname });
    return withAllowedAccountCors(rateLimitedResponse());
  }
  const attentionAccountResponse = await handleAttentionAccountRequest(request, env, url);
  if (attentionAccountResponse) {
    return withAllowedAccountCors(attentionAccountResponse);
  }
  const directoryPurgeResponse = await handleDirectoryAccountPurge(request, env, url);
  if (directoryPurgeResponse) return directoryPurgeResponse;
  const route = routeMachine(url.pathname);
  if (!route || !MACHINE_KEY_PATTERN.test(route.machineKey)) return text("not found", 404);
  const { machineKey, rest } = route;
  if (rest.length === 1 && rest[0] === "claim") {
    const claimLimit = positiveIntEnv(env.CLAIM_RATE_LIMIT_PER_MIN, DEFAULT_CLAIM_RATE_LIMIT_PER_MIN);
    const claimGate = await checkRateLimit(env, `claim:${ip}`, claimLimit, RATE_WINDOW_SECONDS);
    if (!claimGate.allowed) {
      logEvent("rate_limited", { scope: "claim", ip, count: claimGate.count, limit: claimLimit });
      return rateLimitedResponse();
    }
    return await handleMachineClaim(request, env, machineKey);
  }
  if (rest.length === 1 && rest[0] === "devices" && request.method === "GET") {
    return await handleDeviceList(request, env, machineKey);
  }
  if (rest.length === 2 && rest[0] === "devices") {
    const deviceId = decodePathSegment(rest[1]);
    if (deviceId === null) return text("not found", 404);
    if (request.method === "PUT" || request.method === "POST") {
      return await handleDeviceUpsert(request, env, machineKey, deviceId);
    }
    if (request.method === "DELETE") {
      return await handleDeviceDelete(request, env, machineKey, deviceId);
    }
    return text("method not allowed", 405);
  }
  if (rest.length === 1 && rest[0] === "live-activity-tokens" && request.method === "POST") {
    return await handleActivityTokenUpsert(request, env, machineKey);
  }
  if (rest.length === 1 && rest[0] === "publish" && request.method === "POST") {
    return await handlePublish(request, env, machineKey);
  }
  if (rest.length === 1 && rest[0] === "attention" && request.method === "POST") {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES2) {
      return json2({ ok: false, error: "payload too large" }, { status: 413 });
    }
    const auth = await assertMachineAuthorized(request, env, machineKey, body);
    if ("response" in auth) return auth.response;
    return await handleAttentionMachinePublish(request, env, machineKey, body, {
      machineKey: auth.machine.machine_key
    });
  }
  return text("not found", 404);
}
__name(routeRequest, "routeRequest");
function contentLengthExceeds(headers, limit) {
  const value = headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) > BigInt(limit);
  } catch {
    return true;
  }
}
__name(contentLengthExceeds, "contentLengthExceeds");

// src/posthogLogs.ts
init_modules_watch_stub();
var PUBLIC_TOKEN = /^phc_[A-Za-z0-9_-]{8,}$/;
var DEFAULT_HOST = "https://us.i.posthog.com";
var SEVERITY = { info: 9, warn: 13, error: 17 };
var SAMPLE_OK = 0.02;
var SAMPLE_CLIENT_ERROR = 0.1;
var MAX_RECORDS_PER_MINUTE = 120;
var SEND_TIMEOUT_MS = 2e3;
var ROUTE_WORDS = /* @__PURE__ */ new Set([
  ".well-known",
  "a",
  "account",
  "ack",
  "activities",
  "admin",
  "agent",
  "agents",
  "approve",
  "attention",
  "bindings",
  "callback",
  "claim",
  "clerk",
  "code",
  "coding-agents",
  "connect",
  "cursor",
  "daily",
  "deliveries",
  "developer-token",
  "device",
  "devices",
  "diagnostics",
  "events",
  "github",
  "graphql",
  "heal",
  "health",
  "hooks",
  "host",
  "install",
  "installation",
  "integrations",
  "jev",
  "leaderboards",
  "linear",
  "m",
  "machines",
  "maintain",
  "mcp",
  "mcp-account",
  "members",
  "models",
  "music",
  "notify",
  "oauth",
  "oauth-authorization-server",
  "oauth-protected-resource",
  "openid-configuration",
  "orgs",
  "pairing",
  "pipe",
  "preferences",
  "presence",
  "prewarm",
  "projects",
  "reconcile",
  "register",
  "registry",
  "repos",
  "router",
  "runner",
  "session",
  "sessions",
  "settings",
  "snapshot",
  "start",
  "state",
  "status",
  "subscribe",
  "systemone",
  "token",
  "update",
  "upload",
  "usage-research",
  "user",
  "vault",
  "webhook",
  "webhooks"
]);
var KEY_CARRIERS = /* @__PURE__ */ new Set(["host", "connect", "prewarm", "machines", "hooks", "webhooks"]);
var MAX_SEGMENTS = 5;
function routeTemplate(pathname) {
  const out = [];
  for (const segment of pathname.split("/").slice(1, 1 + MAX_SEGMENTS)) {
    if (!segment) continue;
    if (!ROUTE_WORDS.has(segment)) {
      out.push(":id");
      continue;
    }
    out.push(segment);
    if (KEY_CARRIERS.has(segment)) {
      out.push(":id");
      break;
    }
  }
  return `/${out.join("/")}`;
}
__name(routeTemplate, "routeTemplate");
var windowStart2 = 0;
var windowCount = 0;
function admit(status, now) {
  const rate = status >= 500 ? 1 : status >= 400 ? SAMPLE_CLIENT_ERROR : SAMPLE_OK;
  if (rate < 1 && Math.random() >= rate) return false;
  if (now - windowStart2 >= 6e4) {
    windowStart2 = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_RECORDS_PER_MINUTE) return false;
  windowCount += 1;
  return true;
}
__name(admit, "admit");
function attributeList(attrs) {
  const list = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === void 0) continue;
    list.push({
      key,
      value: typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
    });
  }
  return list;
}
__name(attributeList, "attributeList");
function send(env, ctx, worker, level, event, attrs) {
  try {
    const token = env.POSTHOG_LOGS_TOKEN?.trim() || env.POSTHOG_PROJECT_TOKEN?.trim() || "";
    if (!PUBLIC_TOKEN.test(token)) return;
    const host = (env.POSTHOG_LOGS_HOST ?? env.POSTHOG_HOST ?? DEFAULT_HOST).trim().replace(/\/+$/, "");
    const body = JSON.stringify({
      resourceLogs: [{
        resource: {
          attributes: attributeList({
            "service.name": worker,
            "deployment.environment": env.SENTRY_ENVIRONMENT?.trim() || "development",
            ...env.SENTRY_RELEASE?.trim() ? { "service.version": env.SENTRY_RELEASE.trim().replace(/^ade@/, "") } : {}
          })
        },
        scopeLogs: [{
          scope: { name: "ade-worker-logs" },
          logRecords: [{
            timeUnixNano: `${Date.now()}000000`,
            severityNumber: SEVERITY[level],
            severityText: level.toUpperCase(),
            body: { stringValue: event },
            attributes: attributeList({ event, ...attrs })
          }]
        }]
      }]
    });
    const pending = fetch(`${host}/i/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    }).then(() => void 0, () => void 0);
    ctx?.waitUntil(pending);
  } catch {
  }
}
__name(send, "send");
function errorClass(error2) {
  const name = error2 instanceof Error ? error2.name : typeof error2;
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "Error";
}
__name(errorClass, "errorClass");
function reportRequest(env, ctx, worker, request, status, startedAt, error2) {
  try {
    const route = routeTemplate(new URL(request.url).pathname);
    if (route === "/health") return;
    const failed = error2 !== void 0;
    if (!admit(failed ? 500 : status, Date.now())) return;
    const level = failed || status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    send(env, ctx, worker, level, "request_completed", {
      method: request.method,
      route,
      status,
      duration_ms: Math.max(0, Date.now() - startedAt),
      error_class: failed ? errorClass(error2) : void 0
    });
  } catch {
  }
}
__name(reportRequest, "reportRequest");
function reportJobFailure(env, ctx, worker, job, error2) {
  if (!admit(500, Date.now())) return;
  send(env, ctx, worker, "error", "job_failed", { job: job.slice(0, 40), error_class: errorClass(error2) });
}
__name(reportJobFailure, "reportJobFailure");

// src/sentry.ts
init_modules_watch_stub();
var WORKER_NAME = "ade-push-relay";
function sentryOptions(env) {
  const environment = env.SENTRY_ENVIRONMENT?.trim() || "development";
  return {
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE,
    dist: `worker-${WORKER_NAME}`,
    environment,
    enabled: environment !== "development",
    initialScope: { tags: { worker: WORKER_NAME } },
    // About 750K requests a day. 5M spans a month on the free plan is about 167K a day, so sample at 0.1%.
    tracesSampleRate: 1e-3,
    // This Worker calls no other Worker. No trace headers on any outbound call (APNs, Clerk, ...).
    tracePropagationTargets: [],
    ignoreErrors: ["AbortError", "The operation was aborted", "Network connection lost"],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { allow: ["user-agent", "content-type", "content-length", "accept", "cf-ray"] },
        response: false
      },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false
    },
    beforeSend: /* @__PURE__ */ __name((event) => admitEvent(event) ? scrubEvent(event) : null, "beforeSend"),
    beforeSendSpan: /* @__PURE__ */ __name((span) => scrubSpan(span), "beforeSendSpan"),
    beforeBreadcrumb: /* @__PURE__ */ __name((breadcrumb) => scrubBreadcrumb(breadcrumb), "beforeBreadcrumb")
  };
}
__name(sentryOptions, "sentryOptions");

// src/index.ts
var WORKER_NAME2 = "ade-push-relay";
var src_default = withSentry(sentryOptions, {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    try {
      const response = await handleRequest(request, env);
      reportRequest(env, ctx, WORKER_NAME2, request, response.status, startedAt);
      return response;
    } catch (error2) {
      reportRequest(env, ctx, WORKER_NAME2, request, 500, startedAt, error2);
      throw error2;
    }
  },
  // Hourly cron. Two jobs, and the split matters:
  //
  // - `pruneRelayState` prunes expired suppression, registration, and rate-limit
  //   rows. Request handlers also prune opportunistically (after a signed
  //   publish/upsert), so pure /claim, 404, or unauthorized traffic never
  //   triggers cleanup — this keeps `rate_counters` (and the rest) bounded even
  //   under abuse from rotating IPs that never reach an authenticated path.
  // - `sweepRelayState` retires expired Attention items and orphaned machine
  //   Activity. Those sweeps fan out into per-account revision commits and
  //   outbound APNs pushes, so they run HERE ONLY and never inside a request.
  async scheduled(_event, env, ctx) {
    const cronEnv = { ...env, DB: retryD1Reads(env.DB) };
    ctx.waitUntil((async () => {
      await sweepRelayState(cronEnv);
      await pruneRelayState(cronEnv);
    })().catch((error2) => {
      captureException(error2);
      reportJobFailure(env, ctx, WORKER_NAME2, "hourly_sweep", error2);
      throw error2;
    }));
  }
});

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
init_modules_watch_stub();
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
init_modules_watch_stub();
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error2 = reduceError(e);
    return Response.json(error2, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-dtUgRt/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
init_modules_watch_stub();
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-dtUgRt/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init2) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init2.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init2) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init2.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
