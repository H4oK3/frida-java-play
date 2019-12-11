(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
"use strict";

var _interopRequireDefault = require("@babel/runtime-corejs2/helpers/interopRequireDefault");

var _defineProperty = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/define-property"));

var getApi = require('./lib/api');

var _require = require('./lib/android'),
    getAndroidVersion = _require.getAndroidVersion,
    withAllArtThreadsSuspended = _require.withAllArtThreadsSuspended,
    withRunnableArtThread = _require.withRunnableArtThread,
    makeArtClassVisitor = _require.makeArtClassVisitor,
    makeArtClassLoaderVisitor = _require.makeArtClassLoaderVisitor,
    deoptimizeEverything = _require.deoptimizeEverything;

var ClassFactory = require('./lib/class-factory');

var Env = require('./lib/env');

var VM = require('./lib/vm');

var _require2 = require('./lib/result'),
    JNI_OK = _require2.JNI_OK,
    checkJniResult = _require2.checkJniResult;

var pointerSize = Process.pointerSize;

function Runtime() {
  var _this = this;

  var initialized = false;
  var api = null;
  var apiError = null;
  var vm = null;
  var classFactory = null;
  var pending = [];
  var cachedIsAppProcess = null;

  function tryInitialize() {
    if (initialized) {
      return true;
    }

    if (apiError !== null) {
      throw apiError;
    }

    try {
      api = getApi();
    } catch (e) {
      apiError = e;
      throw e;
    }

    if (api === null) {
      return false;
    }

    vm = new VM(api);
    classFactory = new ClassFactory(vm);
    initialized = true;
    return true;
  }

  WeakRef.bind(Runtime, function dispose() {
    if (api !== null) {
      vm.perform(function () {
        var env = vm.getEnv();
        classFactory.dispose(env);
        Env.dispose(env);
      });
    }
  });
  (0, _defineProperty["default"])(this, 'available', {
    enumerable: true,
    get: function get() {
      return tryInitialize();
    }
  });
  (0, _defineProperty["default"])(this, 'androidVersion', {
    enumerable: true,
    get: function get() {
      return getAndroidVersion(classFactory);
    }
  });

  var assertJavaApiIsAvailable = function assertJavaApiIsAvailable() {
    if (!_this.available) {
      throw new Error('Java API not available');
    }
  };

  this["synchronized"] = function (obj, fn) {
    var objHandle = obj.hasOwnProperty('$handle') ? obj.$handle : obj;

    if (!(objHandle instanceof NativePointer)) {
      throw new Error('Java.synchronized: the first argument `obj` must be either a pointer or a Java instance');
    }

    var env = vm.getEnv();
    checkJniResult('VM::MonitorEnter', env.monitorEnter(objHandle));

    try {
      fn();
    } finally {
      env.monitorExit(objHandle);
    }
  };

  (0, _defineProperty["default"])(this, 'enumerateLoadedClasses', {
    enumerable: true,
    value: function value(callbacks) {
      assertJavaApiIsAvailable();

      if (api.flavor === 'art') {
        enumerateLoadedClassesArt(callbacks);
      } else {
        enumerateLoadedClassesDalvik(callbacks);
      }
    }
  });
  (0, _defineProperty["default"])(this, 'enumerateLoadedClassesSync', {
    enumerable: true,
    value: function value() {
      assertJavaApiIsAvailable();
      var classes = [];
      this.enumerateLoadedClasses({
        onMatch: function onMatch(c) {
          classes.push(c);
        },
        onComplete: function onComplete() {}
      });
      return classes;
    }
  });
  (0, _defineProperty["default"])(this, 'enumerateClassLoaders', {
    enumerable: true,
    value: function value(callbacks) {
      assertJavaApiIsAvailable();

      if (api.flavor === 'art') {
        enumerateClassLoadersArt(callbacks);
      } else {
        throw new Error('Enumerating class loaders is only supported on ART');
      }
    }
  });
  (0, _defineProperty["default"])(this, 'enumerateClassLoadersSync', {
    enumerable: true,
    value: function value() {
      assertJavaApiIsAvailable();
      var loaders = [];
      this.enumerateClassLoaders({
        onMatch: function onMatch(c) {
          loaders.push(c);
        },
        onComplete: function onComplete() {}
      });
      return loaders;
    }
  });

  function enumerateLoadedClassesArt(callbacks) {
    var env = vm.getEnv();
    var classHandles = [];
    var addGlobalReference = api['art::JavaVMExt::AddGlobalRef'];
    var vmHandle = api.vm;
    withRunnableArtThread(vm, env, function (thread) {
      var collectClassHandles = makeArtClassVisitor(function (klass) {
        classHandles.push(addGlobalReference(vmHandle, thread, klass));
        return true;
      });
      api['art::ClassLinker::VisitClasses'](api.artClassLinker, collectClassHandles);
    });

    try {
      classHandles.forEach(function (handle) {
        var className = env.getClassName(handle);
        callbacks.onMatch(className);
      });
    } finally {
      classHandles.forEach(function (handle) {
        env.deleteGlobalRef(handle);
      });
    }

    callbacks.onComplete();
  }

  function enumerateClassLoadersArt(callbacks) {
    var visitClassLoaders = api['art::ClassLinker::VisitClassLoaders'];

    if (visitClassLoaders === undefined) {
      throw new Error('This API is only available on Nougat and above');
    }

    var env = vm.getEnv();
    var ClassLoader = classFactory.use('java.lang.ClassLoader');
    var loaderHandles = [];
    var addGlobalReference = api['art::JavaVMExt::AddGlobalRef'];
    var vmHandle = api.vm;
    withRunnableArtThread(vm, env, function (thread) {
      var collectLoaderHandles = makeArtClassLoaderVisitor(function (loader) {
        loaderHandles.push(addGlobalReference(vmHandle, thread, loader));
        return true;
      });
      withAllArtThreadsSuspended(function () {
        visitClassLoaders(api.artClassLinker, collectLoaderHandles);
      });
    });

    try {
      loaderHandles.forEach(function (handle) {
        var loader = classFactory.cast(handle, ClassLoader);
        callbacks.onMatch(loader);
      });
    } finally {
      loaderHandles.forEach(function (handle) {
        env.deleteGlobalRef(handle);
      });
    }

    callbacks.onComplete();
  }

  function enumerateLoadedClassesDalvik(callbacks) {
    var HASH_TOMBSTONE = ptr('0xcbcacccd');
    var loadedClassesOffset = 172;
    var hashEntrySize = 8;
    var ptrLoadedClassesHashtable = api.gDvm.add(loadedClassesOffset);
    var hashTable = ptrLoadedClassesHashtable.readPointer();
    var tableSize = hashTable.readS32();
    var ptrpEntries = hashTable.add(12);
    var pEntries = ptrpEntries.readPointer();
    var end = tableSize * hashEntrySize;

    for (var offset = 0; offset < end; offset += hashEntrySize) {
      var pEntryPtr = pEntries.add(offset);
      var dataPtr = pEntryPtr.add(4).readPointer();

      if (!(HASH_TOMBSTONE.equals(dataPtr) || dataPtr.isNull())) {
        var descriptionPtr = dataPtr.add(24).readPointer();
        var description = descriptionPtr.readCString();
        callbacks.onMatch(description);
      }
    }

    callbacks.onComplete();
  }

  this.scheduleOnMainThread = function (fn) {
    var ActivityThread = classFactory.use('android.app.ActivityThread');
    var Handler = classFactory.use('android.os.Handler');
    var Looper = classFactory.use('android.os.Looper');
    var looper = Looper.getMainLooper();
    var handler = Handler.$new.overload('android.os.Looper').call(Handler, looper);
    var message = handler.obtainMessage();

    Handler.dispatchMessage.implementation = function (msg) {
      var sameHandler = this.$isSameObject(handler);

      if (sameHandler) {
        var app = ActivityThread.currentApplication();

        if (app !== null) {
          Handler.dispatchMessage.implementation = null;
          fn();
        }
      } else {
        this.dispatchMessage(msg);
      }
    };

    message.sendToTarget();
  };

  this.perform = function (fn) {
    assertJavaApiIsAvailable();

    if (!isAppProcess() || classFactory.loader !== null) {
      try {
        vm.perform(fn);
      } catch (e) {
        setTimeout(function () {
          throw e;
        }, 0);
      }
    } else {
      pending.push(fn);

      if (pending.length === 1) {
        vm.perform(function () {
          var ActivityThread = classFactory.use('android.app.ActivityThread');
          var app = ActivityThread.currentApplication();

          if (app !== null) {
            var _Process = classFactory.use('android.os.Process');

            classFactory.loader = app.getClassLoader();

            if (_Process.myUid() === _Process.SYSTEM_UID.value) {
              classFactory.cacheDir = '/data/system';
            } else {
              classFactory.cacheDir = app.getCacheDir().getCanonicalPath();
            }

            performPending(); // already initialized, continue
          } else {
            var _initialized = false;
            var hookpoint = 'early';
            var handleBindApplication = ActivityThread.handleBindApplication;

            handleBindApplication.implementation = function (data) {
              if (data.instrumentationName.value !== null) {
                hookpoint = 'late';
                var LoadedApk = classFactory.use('android.app.LoadedApk');
                var makeApplication = LoadedApk.makeApplication;

                makeApplication.implementation = function (forceDefaultAppClass, instrumentation) {
                  if (!_initialized) {
                    _initialized = true;
                    classFactory.loader = this.getClassLoader();
                    classFactory.cacheDir = classFactory.use('java.io.File').$new(this.getDataDir() + '/cache').getCanonicalPath();
                    performPending();
                  }

                  return makeApplication.apply(this, arguments);
                };
              }

              handleBindApplication.apply(this, arguments);
            };

            var getPackageInfoNoCheck = ActivityThread.getPackageInfoNoCheck;

            getPackageInfoNoCheck.implementation = function (appInfo) {
              var apk = getPackageInfoNoCheck.apply(this, arguments);

              if (!_initialized && hookpoint === 'early') {
                _initialized = true;
                classFactory.loader = apk.getClassLoader();
                classFactory.cacheDir = classFactory.use('java.io.File').$new(appInfo.dataDir.value + '/cache').getCanonicalPath();
                performPending();
              }

              return apk;
            };
          }
        });
      }
    }
  };

  function performPending() {
    while (pending.length > 0) {
      var fn = pending.shift();

      try {
        vm.perform(fn);
      } catch (e) {
        setTimeout(function () {
          throw e;
        }, 0);
      }
    }
  }

  this.performNow = function (fn) {
    assertJavaApiIsAvailable();

    if (isAppProcess() && classFactory.loader === null) {
      vm.perform(function () {
        var ActivityThread = classFactory.use('android.app.ActivityThread');
        var app = ActivityThread.currentApplication();

        if (app !== null) {
          classFactory.loader = app.getClassLoader();
        }
      });
    }

    vm.perform(fn);
  };

  this.use = function (className, options) {
    return classFactory.use(className, options);
  };

  this.openClassFile = function (filePath) {
    return classFactory.openClassFile(filePath);
  };

  this.choose = function (specifier, callbacks) {
    classFactory.choose(specifier, callbacks);
  };

  this.retain = function (obj) {
    return classFactory.retain(obj);
  };

  this.cast = function (obj, C) {
    return classFactory.cast(obj, C);
  };

  this.array = function (type, elements) {
    return classFactory.array(type, elements);
  }; // Reference: http://stackoverflow.com/questions/2848575/how-to-detect-ui-thread-on-android


  this.isMainThread = function () {
    var Looper = classFactory.use('android.os.Looper');
    var mainLooper = Looper.getMainLooper();
    var myLooper = Looper.myLooper();

    if (myLooper === null) {
      return false;
    }

    return mainLooper.$isSameObject(myLooper);
  };

  this.registerClass = function (spec) {
    return classFactory.registerClass(spec);
  };

  (0, _defineProperty["default"])(this, 'deoptimizeEverything', {
    enumerable: true,
    value: function value() {
      return deoptimizeEverything(vm, vm.getEnv());
    }
  });
  (0, _defineProperty["default"])(this, 'vm', {
    enumerable: false,
    get: function get() {
      return vm;
    }
  });
  (0, _defineProperty["default"])(this, 'classFactory', {
    enumerable: false,
    get: function get() {
      return classFactory;
    }
  });

  function isAppProcess() {
    if (cachedIsAppProcess === null) {
      var readlink = new NativeFunction(Module.findExportByName(null, 'readlink'), 'pointer', ['pointer', 'pointer', 'pointer'], {
        exceptions: 'propagate'
      });
      var pathname = Memory.allocUtf8String('/proc/self/exe');
      var bufferSize = 1024;
      var buffer = Memory.alloc(bufferSize);
      var size = readlink(pathname, buffer, ptr(bufferSize)).toInt32();

      if (size !== -1) {
        var exe = buffer.readUtf8String(size);
        cachedIsAppProcess = [/^\/system\/bin\/app_process/.test(exe)];
      } else {
        cachedIsAppProcess = [true];
      }
    }

    return cachedIsAppProcess[0];
  }

  tryInitialize();
}

module.exports = new Runtime();
/* global console, Memory, Module, NativePointer, NativeFunction, ptr, Process, WeakRef */

},{"./lib/android":2,"./lib/api":3,"./lib/class-factory":4,"./lib/env":5,"./lib/result":7,"./lib/vm":8,"@babel/runtime-corejs2/core-js/object/define-property":19,"@babel/runtime-corejs2/helpers/interopRequireDefault":44}],2:[function(require,module,exports){
(function (global){
"use strict";

var _interopRequireDefault = require("@babel/runtime-corejs2/helpers/interopRequireDefault");

var _possibleConstructorReturn2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/possibleConstructorReturn"));

var _getPrototypeOf2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/getPrototypeOf"));

var _inherits2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/inherits"));

var _slicedToArray2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/slicedToArray"));

var _regenerator = _interopRequireDefault(require("@babel/runtime-corejs2/regenerator"));

var _construct2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/construct"));

var _createClass2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/createClass"));

var _classCallCheck2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/classCallCheck"));

var _parseInt2 = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/parse-int"));

var _keys = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/keys"));

var _set = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/set"));

var _require = require('./result'),
    checkJniResult = _require.checkJniResult;

var VM = require('./vm');

var jsizeSize = 4;
var pointerSize = Process.pointerSize;
var kAccPublic = 0x0001;
var kAccStatic = 0x0008;
var kAccFinal = 0x0010;
var kAccNative = 0x0100;
var kAccPublicApi = 0x10000000;
var ENV_VTABLE_OFFSET_EXCEPTION_CLEAR = 17 * pointerSize;
var ENV_VTABLE_OFFSET_FATAL_ERROR = 18 * pointerSize;
var STD_STRING_SIZE = 3 * pointerSize;
var STD_VECTOR_SIZE = 3 * pointerSize;
var AF_UNIX = 1;
var SOCK_STREAM = 1;
var getArtRuntimeSpec = memoize(_getArtRuntimeSpec);
var getArtInstrumentationSpec = memoize(_getArtInstrumentationSpec);
var getArtClassLinkerSpec = memoize(_getArtClassLinkerSpec);
var getArtMethodSpec = memoize(_getArtMethodSpec);
var getArtThreadSpec = memoize(_getArtThreadSpec);
var getArtThreadStateTransitionImpl = memoize(_getArtThreadStateTransitionImpl);
var getAndroidVersion = memoize(_getAndroidVersion);
var getAndroidApiLevel = memoize(_getAndroidApiLevel);
var getArtQuickFrameInfoGetterThunk = memoize(_getArtQuickFrameInfoGetterThunk);
var makeCxxMethodWrapperReturningPointerByValue = Process.arch === 'ia32' ? makeCxxMethodWrapperReturningPointerByValueInFirstArg : makeCxxMethodWrapperReturningPointerByValueGeneric;
var nativeFunctionOptions = {
  exceptions: 'propagate'
};
var artThreadStateTransitions = {};
var cachedApi = null;
var thunkPage = null;
var thunkOffset = 0;
var taughtArtAboutHookedMethods = false;
var jdwpSession = null;
var socketpair = null;

function getApi() {
  if (cachedApi === null) {
    cachedApi = _getApi();
  }

  return cachedApi;
}

function _getApi() {
  var vmModules = Process.enumerateModules().filter(function (m) {
    return /^lib(art|dvm).so$/.test(m.name);
  }).filter(function (m) {
    return !/\/system\/fake-libs/.test(m.path);
  });

  if (vmModules.length === 0) {
    return null;
  }

  var vmModule = vmModules[0];
  var flavor = vmModule.name.indexOf('art') !== -1 ? 'art' : 'dalvik';
  var isArt = flavor === 'art';
  var temporaryApi = {
    addLocalReference: null,
    flavor: flavor
  };
  var pending = isArt ? [{
    module: vmModule.path,
    functions: {
      'JNI_GetCreatedJavaVMs': ['JNI_GetCreatedJavaVMs', 'int', ['pointer', 'int', 'pointer']],
      // Android < 7
      'artInterpreterToCompiledCodeBridge': function artInterpreterToCompiledCodeBridge(address) {
        this.artInterpreterToCompiledCodeBridge = address;
      },
      // Android >= 8
      '_ZN3art9JavaVMExt12AddGlobalRefEPNS_6ThreadENS_6ObjPtrINS_6mirror6ObjectEEE': ['art::JavaVMExt::AddGlobalRef', 'pointer', ['pointer', 'pointer', 'pointer']],
      // Android >= 6
      '_ZN3art9JavaVMExt12AddGlobalRefEPNS_6ThreadEPNS_6mirror6ObjectE': ['art::JavaVMExt::AddGlobalRef', 'pointer', ['pointer', 'pointer', 'pointer']],
      // Android < 6: makeAddGlobalRefFallbackForAndroid5() needs these:
      '_ZN3art17ReaderWriterMutex13ExclusiveLockEPNS_6ThreadE': ['art::ReaderWriterMutex::ExclusiveLock', 'void', ['pointer', 'pointer']],
      '_ZN3art17ReaderWriterMutex15ExclusiveUnlockEPNS_6ThreadE': ['art::ReaderWriterMutex::ExclusiveUnlock', 'void', ['pointer', 'pointer']],
      // Android <= 7
      '_ZN3art22IndirectReferenceTable3AddEjPNS_6mirror6ObjectE': function _ZN3art22IndirectReferenceTable3AddEjPNS_6mirror6ObjectE(address) {
        this['art::IndirectReferenceTable::Add'] = new NativeFunction(address, 'pointer', ['pointer', 'uint', 'pointer'], nativeFunctionOptions);
      },
      // Android > 7
      '_ZN3art22IndirectReferenceTable3AddENS_15IRTSegmentStateENS_6ObjPtrINS_6mirror6ObjectEEE': function _ZN3art22IndirectReferenceTable3AddENS_15IRTSegmentStateENS_6ObjPtrINS_6mirror6ObjectEEE(address) {
        this['art::IndirectReferenceTable::Add'] = new NativeFunction(address, 'pointer', ['pointer', 'uint', 'pointer'], nativeFunctionOptions);
      },
      // Android >= 7
      '_ZN3art9JavaVMExt12DecodeGlobalEPv': function _ZN3art9JavaVMExt12DecodeGlobalEPv(address) {
        var decodeGlobal;

        if (getAndroidApiLevel() >= 26) {
          // Returns ObjPtr<mirror::Object>
          decodeGlobal = makeCxxMethodWrapperReturningPointerByValue(address, ['pointer', 'pointer']);
        } else {
          // Returns mirror::Object *
          decodeGlobal = new NativeFunction(address, 'pointer', ['pointer', 'pointer'], nativeFunctionOptions);
        }

        this['art::JavaVMExt::DecodeGlobal'] = function (vm, thread, ref) {
          return decodeGlobal(vm, ref);
        };
      },
      // Android >= 6
      '_ZN3art9JavaVMExt12DecodeGlobalEPNS_6ThreadEPv': ['art::JavaVMExt::DecodeGlobal', 'pointer', ['pointer', 'pointer', 'pointer']],
      // Android < 6: makeDecodeGlobalFallbackForAndroid5() fallback uses:
      '_ZNK3art6Thread13DecodeJObjectEP8_jobject': ['art::Thread::DecodeJObject', 'pointer', ['pointer', 'pointer']],
      // Android >= 6
      '_ZN3art10ThreadList10SuspendAllEPKcb': ['art::ThreadList::SuspendAll', 'void', ['pointer', 'pointer', 'bool']],
      // or fallback:
      '_ZN3art10ThreadList10SuspendAllEv': function _ZN3art10ThreadList10SuspendAllEv(address) {
        var suspendAll = new NativeFunction(address, 'void', ['pointer'], nativeFunctionOptions);

        this['art::ThreadList::SuspendAll'] = function (threadList, cause, longSuspend) {
          return suspendAll(threadList);
        };
      },
      '_ZN3art10ThreadList9ResumeAllEv': ['art::ThreadList::ResumeAll', 'void', ['pointer']],
      // Android >= 7
      '_ZN3art11ClassLinker12VisitClassesEPNS_12ClassVisitorE': ['art::ClassLinker::VisitClasses', 'void', ['pointer', 'pointer']],
      // Android < 7
      '_ZN3art11ClassLinker12VisitClassesEPFbPNS_6mirror5ClassEPvES4_': function _ZN3art11ClassLinker12VisitClassesEPFbPNS_6mirror5ClassEPvES4_(address) {
        var visitClasses = new NativeFunction(address, 'void', ['pointer', 'pointer', 'pointer'], nativeFunctionOptions);

        this['art::ClassLinker::VisitClasses'] = function (classLinker, visitor) {
          visitClasses(classLinker, visitor, NULL);
        };
      },
      '_ZNK3art11ClassLinker17VisitClassLoadersEPNS_18ClassLoaderVisitorE': ['art::ClassLinker::VisitClassLoaders', 'void', ['pointer', 'pointer']],
      '_ZN3art2gc4Heap12VisitObjectsEPFvPNS_6mirror6ObjectEPvES5_': ['art::gc::Heap::VisitObjects', 'void', ['pointer', 'pointer', 'pointer']],
      '_ZN3art2gc4Heap12GetInstancesERNS_24VariableSizedHandleScopeENS_6HandleINS_6mirror5ClassEEEiRNSt3__16vectorINS4_INS5_6ObjectEEENS8_9allocatorISB_EEEE': ['art::gc::Heap::GetInstances', 'void', ['pointer', 'pointer', 'pointer', 'int', 'pointer']],
      // Android >= 9
      '_ZN3art2gc4Heap12GetInstancesERNS_24VariableSizedHandleScopeENS_6HandleINS_6mirror5ClassEEEbiRNSt3__16vectorINS4_INS5_6ObjectEEENS8_9allocatorISB_EEEE': function _ZN3art2gc4Heap12GetInstancesERNS_24VariableSizedHandleScopeENS_6HandleINS_6mirror5ClassEEEbiRNSt3__16vectorINS4_INS5_6ObjectEEENS8_9allocatorISB_EEEE(address) {
        var getInstances = new NativeFunction(address, 'void', ['pointer', 'pointer', 'pointer', 'bool', 'int', 'pointer'], nativeFunctionOptions);

        this['art::gc::Heap::GetInstances'] = function (instance, scope, hClass, maxCount, instances) {
          var useIsAssignableFrom = 0;
          getInstances(instance, scope, hClass, useIsAssignableFrom, maxCount, instances);
        };
      },
      '_ZN3art12StackVisitorC2EPNS_6ThreadEPNS_7ContextENS0_13StackWalkKindEmb': ['art::StackVisitor::StackVisitor', 'void', ['pointer', 'pointer', 'pointer', 'uint', 'pointer', 'bool']],
      '_ZN3art12StackVisitor9WalkStackILNS0_16CountTransitionsE0EEEvb': ['art::StackVisitor::WalkStack', 'void', ['pointer', 'bool']],
      '_ZNK3art12StackVisitor9GetMethodEv': ['art::StackVisitor::GetMethod', 'pointer', ['pointer']],
      '_ZNK3art12StackVisitor16DescribeLocationEv': function _ZNK3art12StackVisitor16DescribeLocationEv(address) {
        this['art::StackVisitor::DescribeLocation'] = makeCxxMethodWrapperReturningStdStringByValue(address, ['pointer']);
      },
      '_ZNK3art12StackVisitor24GetCurrentQuickFrameInfoEv': function _ZNK3art12StackVisitor24GetCurrentQuickFrameInfoEv(address) {
        this['art::StackVisitor::GetCurrentQuickFrameInfo'] = makeArtQuickFrameInfoGetter(address);
      },
      '_ZN3art6Thread18GetLongJumpContextEv': ['art::Thread::GetLongJumpContext', 'pointer', ['pointer']],
      '_ZN3art9ArtMethod12PrettyMethodEb': function _ZN3art9ArtMethod12PrettyMethodEb(address) {
        this['art::ArtMethod::PrettyMethod'] = makeCxxMethodWrapperReturningStdStringByValue(address, ['pointer', 'bool']);
      },
      // Android < 6 for cloneArtMethod()
      '_ZN3art6Thread14CurrentFromGdbEv': ['art::Thread::CurrentFromGdb', 'pointer', []],
      '_ZN3art6mirror6Object5CloneEPNS_6ThreadE': function _ZN3art6mirror6Object5CloneEPNS_6ThreadE(address) {
        this['art::mirror::Object::Clone'] = new NativeFunction(address, 'pointer', ['pointer', 'pointer'], nativeFunctionOptions);
      },
      '_ZN3art6mirror6Object5CloneEPNS_6ThreadEm': function _ZN3art6mirror6Object5CloneEPNS_6ThreadEm(address) {
        var clone = new NativeFunction(address, 'pointer', ['pointer', 'pointer', 'pointer'], nativeFunctionOptions);

        this['art::mirror::Object::Clone'] = function (thisPtr, threadPtr) {
          var numTargetBytes = NULL;
          return clone(thisPtr, threadPtr, numTargetBytes);
        };
      },
      '_ZN3art6mirror6Object5CloneEPNS_6ThreadEj': function _ZN3art6mirror6Object5CloneEPNS_6ThreadEj(address) {
        var clone = new NativeFunction(address, 'pointer', ['pointer', 'pointer', 'uint'], nativeFunctionOptions);

        this['art::mirror::Object::Clone'] = function (thisPtr, threadPtr) {
          var numTargetBytes = 0;
          return clone(thisPtr, threadPtr, numTargetBytes);
        };
      },
      '_ZN3art3Dbg14SetJdwpAllowedEb': ['art::Dbg::SetJdwpAllowed', 'void', ['bool']],
      '_ZN3art3Dbg13ConfigureJdwpERKNS_4JDWP11JdwpOptionsE': ['art::Dbg::ConfigureJdwp', 'void', ['pointer']],
      '_ZN3art31InternalDebuggerControlCallback13StartDebuggerEv': ['art::InternalDebuggerControlCallback::StartDebugger', 'void', ['pointer']],
      '_ZN3art3Dbg9StartJdwpEv': ['art::Dbg::StartJdwp', 'void', []],
      '_ZN3art3Dbg8GoActiveEv': ['art::Dbg::GoActive', 'void', []],
      '_ZN3art3Dbg21RequestDeoptimizationERKNS_21DeoptimizationRequestE': ['art::Dbg::RequestDeoptimization', 'void', ['pointer']],
      '_ZN3art3Dbg20ManageDeoptimizationEv': ['art::Dbg::ManageDeoptimization', 'void', []],
      '_ZN3art15instrumentation15Instrumentation20EnableDeoptimizationEv': ['art::Instrumentation::EnableDeoptimization', 'void', ['pointer']],
      // Android >= 6
      '_ZN3art15instrumentation15Instrumentation20DeoptimizeEverythingEPKc': ['art::Instrumentation::DeoptimizeEverything', 'void', ['pointer', 'pointer']],
      // Android < 6
      '_ZN3art15instrumentation15Instrumentation20DeoptimizeEverythingEv': function _ZN3art15instrumentation15Instrumentation20DeoptimizeEverythingEv(address) {
        var deoptimize = new NativeFunction(address, 'void', ['pointer'], nativeFunctionOptions);

        this['art::Instrumentation::DeoptimizeEverything'] = function (instrumentation, key) {
          deoptimize(instrumentation);
        };
      }
    },
    variables: {
      '_ZN3art3Dbg9gRegistryE': function _ZN3art3Dbg9gRegistryE(address) {
        this.isJdwpStarted = function () {
          return !address.readPointer().isNull();
        };
      },
      '_ZN3art3Dbg15gDebuggerActiveE': function _ZN3art3Dbg15gDebuggerActiveE(address) {
        this.isDebuggerActive = function () {
          return !!address.readU8();
        };
      }
    },
    optionals: ['artInterpreterToCompiledCodeBridge', '_ZN3art9JavaVMExt12AddGlobalRefEPNS_6ThreadENS_6ObjPtrINS_6mirror6ObjectEEE', '_ZN3art9JavaVMExt12AddGlobalRefEPNS_6ThreadEPNS_6mirror6ObjectE', '_ZN3art9JavaVMExt12DecodeGlobalEPv', '_ZN3art9JavaVMExt12DecodeGlobalEPNS_6ThreadEPv', '_ZN3art10ThreadList10SuspendAllEPKcb', '_ZN3art10ThreadList10SuspendAllEv', '_ZN3art11ClassLinker12VisitClassesEPNS_12ClassVisitorE', '_ZN3art11ClassLinker12VisitClassesEPFbPNS_6mirror5ClassEPvES4_', '_ZNK3art11ClassLinker17VisitClassLoadersEPNS_18ClassLoaderVisitorE', '_ZN3art6mirror6Object5CloneEPNS_6ThreadE', '_ZN3art6mirror6Object5CloneEPNS_6ThreadEm', '_ZN3art6mirror6Object5CloneEPNS_6ThreadEj', '_ZN3art22IndirectReferenceTable3AddEjPNS_6mirror6ObjectE', '_ZN3art22IndirectReferenceTable3AddENS_15IRTSegmentStateENS_6ObjPtrINS_6mirror6ObjectEEE', '_ZN3art2gc4Heap12VisitObjectsEPFvPNS_6mirror6ObjectEPvES5_', '_ZN3art2gc4Heap12GetInstancesERNS_24VariableSizedHandleScopeENS_6HandleINS_6mirror5ClassEEEiRNSt3__16vectorINS4_INS5_6ObjectEEENS8_9allocatorISB_EEEE', '_ZN3art2gc4Heap12GetInstancesERNS_24VariableSizedHandleScopeENS_6HandleINS_6mirror5ClassEEEbiRNSt3__16vectorINS4_INS5_6ObjectEEENS8_9allocatorISB_EEEE', '_ZN3art12StackVisitorC2EPNS_6ThreadEPNS_7ContextENS0_13StackWalkKindEmb', '_ZN3art12StackVisitor9WalkStackILNS0_16CountTransitionsE0EEEvb', '_ZNK3art12StackVisitor9GetMethodEv', '_ZNK3art12StackVisitor16DescribeLocationEv', '_ZNK3art12StackVisitor24GetCurrentQuickFrameInfoEv', '_ZN3art6Thread18GetLongJumpContextEv', '_ZN3art9ArtMethod12PrettyMethodEb', '_ZN3art3Dbg13ConfigureJdwpERKNS_4JDWP11JdwpOptionsE', '_ZN3art31InternalDebuggerControlCallback13StartDebuggerEv', '_ZN3art3Dbg15gDebuggerActiveE', '_ZN3art15instrumentation15Instrumentation20DeoptimizeEverythingEPKc', '_ZN3art15instrumentation15Instrumentation20DeoptimizeEverythingEv']
  }] : [{
    module: vmModule.path,
    functions: {
      /*
       * Converts an indirect reference to to an object reference.
       */
      '_Z20dvmDecodeIndirectRefP6ThreadP8_jobject': ['dvmDecodeIndirectRef', 'pointer', ['pointer', 'pointer']],
      '_Z15dvmUseJNIBridgeP6MethodPv': ['dvmUseJNIBridge', 'void', ['pointer', 'pointer']],

      /*
       * Returns the base of the HeapSource.
       */
      '_Z20dvmHeapSourceGetBasev': ['dvmHeapSourceGetBase', 'pointer', []],

      /*
       * Returns the limit of the HeapSource.
       */
      '_Z21dvmHeapSourceGetLimitv': ['dvmHeapSourceGetLimit', 'pointer', []],

      /*
       *  Returns true if the pointer points to a valid object.
       */
      '_Z16dvmIsValidObjectPK6Object': ['dvmIsValidObject', 'uint8', ['pointer']],
      'JNI_GetCreatedJavaVMs': ['JNI_GetCreatedJavaVMs', 'int', ['pointer', 'int', 'pointer']]
    },
    variables: {
      'gDvmJni': function gDvmJni(address) {
        this.gDvmJni = address;
      },
      'gDvm': function gDvm(address) {
        this.gDvm = address;
      }
    }
  }];
  var missing = [];
  var total = 0;
  pending.forEach(function (api) {
    var functions = api.functions || {};
    var variables = api.variables || {};
    var optionals = new _set["default"](api.optionals || []);
    total += (0, _keys["default"])(functions).length + (0, _keys["default"])(variables).length;
    var exportByName = Module.enumerateExportsSync(api.module).reduce(function (result, exp) {
      result[exp.name] = exp;
      return result;
    }, {});
    (0, _keys["default"])(functions).forEach(function (name) {
      var exp = exportByName[name];

      if (exp !== undefined && exp.type === 'function') {
        var signature = functions[name];

        if (typeof signature === 'function') {
          signature.call(temporaryApi, exp.address);
        } else {
          temporaryApi[signature[0]] = new NativeFunction(exp.address, signature[1], signature[2], nativeFunctionOptions);
        }
      } else {
        if (!optionals.has(name)) {
          missing.push(name);
        }
      }
    });
    (0, _keys["default"])(variables).forEach(function (name) {
      var exp = exportByName[name];

      if (exp !== undefined && exp.type === 'variable') {
        var handler = variables[name];
        handler.call(temporaryApi, exp.address);
      } else {
        if (!optionals.has(name)) {
          missing.push(name);
        }
      }
    });
  });

  if (missing.length > 0) {
    throw new Error('Java API only partially available; please file a bug. Missing: ' + missing.join(', '));
  }

  var vms = Memory.alloc(pointerSize);
  var vmCount = Memory.alloc(jsizeSize);
  checkJniResult('JNI_GetCreatedJavaVMs', temporaryApi.JNI_GetCreatedJavaVMs(vms, 1, vmCount));

  if (vmCount.readInt() === 0) {
    return null;
  }

  temporaryApi.vm = vms.readPointer();

  if (isArt) {
    var artRuntime = temporaryApi.vm.add(pointerSize).readPointer();
    temporaryApi.artRuntime = artRuntime;
    var runtimeOffset = getArtRuntimeSpec(temporaryApi).offset;
    var instrumentationOffset = runtimeOffset.instrumentation;
    temporaryApi.artInstrumentation = instrumentationOffset !== null ? artRuntime.add(instrumentationOffset) : null;
    temporaryApi.artHeap = artRuntime.add(runtimeOffset.heap).readPointer();
    temporaryApi.artThreadList = artRuntime.add(runtimeOffset.threadList).readPointer();
    /*
     * We must use the *correct* copy (or address) of art_quick_generic_jni_trampoline
     * in order for the stack trace to recognize the JNI stub quick frame.
     *
     * For ARTs for Android 6.x we can just use the JNI trampoline built into ART.
     */

    var classLinker = artRuntime.add(runtimeOffset.classLinker).readPointer();
    temporaryApi.artClassLinker = classLinker;
    temporaryApi.artQuickGenericJniTrampoline = classLinker.add(getArtClassLinkerSpec(temporaryApi).offset.quickGenericJniTrampoline).readPointer();

    if (temporaryApi['art::JavaVMExt::AddGlobalRef'] === undefined) {
      temporaryApi['art::JavaVMExt::AddGlobalRef'] = makeAddGlobalRefFallbackForAndroid5(temporaryApi);
    }

    if (temporaryApi['art::JavaVMExt::DecodeGlobal'] === undefined) {
      temporaryApi['art::JavaVMExt::DecodeGlobal'] = makeDecodeGlobalFallbackForAndroid5(temporaryApi);
    }

    fixupArtQuickDeliverExceptionBug(temporaryApi);
  }

  var cxxImports = Module.enumerateImports(vmModule.path).filter(function (imp) {
    return imp.name.indexOf('_Z') === 0;
  }).reduce(function (result, imp) {
    result[imp.name] = imp.address;
    return result;
  }, {});
  temporaryApi['$new'] = new NativeFunction(cxxImports['_Znwm'] || cxxImports['_Znwj'], 'pointer', ['ulong'], nativeFunctionOptions);
  temporaryApi['$delete'] = new NativeFunction(cxxImports['_ZdlPv'], 'void', ['pointer'], nativeFunctionOptions);
  return temporaryApi;
}

function ensureClassInitialized(env, classRef) {
  var api = getApi();

  if (api.flavor !== 'art') {
    return;
  }

  env.getFieldId(classRef, 'x', 'Z');
  env.exceptionClear();
}

function getArtVMSpec(api) {
  return {
    offset: pointerSize === 4 ? {
      globalsLock: 32,
      globals: 72
    } : {
      globalsLock: 64,
      globals: 112
    }
  };
}

function _getArtRuntimeSpec(api) {
  /*
   * class Runtime {
   * ...
   * gc::Heap* heap_;                <-- we need to find this
   * std::unique_ptr<ArenaPool> jit_arena_pool_;     <----- API level >= 24
   * std::unique_ptr<ArenaPool> arena_pool_;             __
   * std::unique_ptr<ArenaPool> low_4gb_arena_pool_; <--|__ API level >= 23
   * std::unique_ptr<LinearAlloc> linear_alloc_;         \_
   * size_t max_spins_before_thin_lock_inflation_;
   * MonitorList* monitor_list_;
   * MonitorPool* monitor_pool_;
   * ThreadList* thread_list_;        <--- and these
   * InternTable* intern_table_;      <--/
   * ClassLinker* class_linker_;      <-/
   * SignalCatcher* signal_catcher_;
   * bool use_tombstoned_traces_;     <-------------------- API level 27/28
   * std::string stack_trace_file_;   <-------------------- API level <= 28
   * JavaVMExt* java_vm_;             <-- so we find this then calculate our way backwards
   * ...
   * }
   */
  var vm = api.vm;
  var runtime = api.artRuntime;
  var startOffset = pointerSize === 4 ? 200 : 384;
  var endOffset = startOffset + 100 * pointerSize;
  var apiLevel = getAndroidApiLevel();
  var spec = null;

  for (var offset = startOffset; offset !== endOffset; offset += pointerSize) {
    var value = runtime.add(offset).readPointer();

    if (value.equals(vm)) {
      var classLinkerOffset = void 0;

      if (apiLevel >= 29) {
        classLinkerOffset = offset - 2 * pointerSize;
      } else if (apiLevel >= 27) {
        classLinkerOffset = offset - STD_STRING_SIZE - 3 * pointerSize;
      } else {
        classLinkerOffset = offset - STD_STRING_SIZE - 2 * pointerSize;
      }

      var internTableOffset = classLinkerOffset - pointerSize;
      var threadListOffset = internTableOffset - pointerSize;
      var heapOffset = void 0;

      if (apiLevel >= 24) {
        heapOffset = threadListOffset - 8 * pointerSize;
      } else if (apiLevel >= 23) {
        heapOffset = threadListOffset - 7 * pointerSize;
      } else {
        heapOffset = threadListOffset - 4 * pointerSize;
      }

      spec = {
        offset: {
          heap: heapOffset,
          threadList: threadListOffset,
          internTable: internTableOffset,
          classLinker: classLinkerOffset
        }
      };
      break;
    }
  }

  if (spec === null) {
    throw new Error('Unable to determine Runtime field offsets');
  }

  spec.offset.instrumentation = tryDetectInstrumentationOffset();
  return spec;
}

var instrumentationOffsetParsers = {
  ia32: parsex86InstrumentationOffset,
  x64: parsex86InstrumentationOffset,
  arm: parseArmInstrumentationOffset,
  arm64: parseArm64InstrumentationOffset
};

function tryDetectInstrumentationOffset() {
  var cur = Module.findExportByName('libart.so', '_ZN3art3Dbg22RequiresDeoptimizationEv');

  if (cur === null) {
    return null;
  }

  var tryParse = instrumentationOffsetParsers[Process.arch];

  for (var i = 0; i !== 20; i++) {
    var insn = Instruction.parse(cur);
    var offset = tryParse(insn);

    if (offset !== null) {
      return offset - getArtInstrumentationSpec().offset.forcedInterpretOnly;
    }

    cur = insn.next;
  }

  throw new Error('Unable to determine Runtime.instrumentation_ offset');
}

function parsex86InstrumentationOffset(insn) {
  var mnemonic = insn.mnemonic;

  if (insn.mnemonic === 'cmp') {
    return insn.operands[0].value.disp;
  }

  if (mnemonic === 'movzx') {
    return insn.operands[1].value.disp;
  }

  return null;
}

function parseArmInstrumentationOffset(insn) {
  if (insn.mnemonic === 'ldrb.w') {
    return insn.operands[1].value.disp;
  }

  return null;
}

function parseArm64InstrumentationOffset(insn) {
  if (insn.mnemonic === 'ldrb') {
    return insn.operands[1].value.disp;
  }

  return null;
}

function _getArtInstrumentationSpec() {
  var deoptimizationEnabledOffsets = {
    '4-21': 136,
    '4-22': 136,
    '4-23': 172,
    '4-24': 196,
    '4-25': 196,
    '4-26': 196,
    '4-27': 196,
    '4-28': 212,
    '4-29': 172,
    '8-21': 224,
    '8-22': 224,
    '8-23': 296,
    '8-24': 344,
    '8-25': 344,
    '8-26': 352,
    '8-27': 352,
    '8-28': 392,
    '8-29': 328
  };
  var apiLevel = getAndroidApiLevel();
  var deoptEnabledOffset = deoptimizationEnabledOffsets["".concat(Process.pointerSize, "-").concat(getAndroidApiLevel())];

  if (deoptEnabledOffset === undefined) {
    throw new Error('Unable to determine Instrumentation field offsets');
  }

  return {
    offset: {
      forcedInterpretOnly: 4,
      deoptimizationEnabled: deoptEnabledOffset
    }
  };
}

function _getArtClassLinkerSpec(api) {
  /*
   * On Android 5.x:
   *
   * class ClassLinker {
   * ...
   * InternTable* intern_table_;                          <-- We find this then calculate our way forwards
   * const void* portable_resolution_trampoline_;
   * const void* quick_resolution_trampoline_;
   * const void* portable_imt_conflict_trampoline_;
   * const void* quick_imt_conflict_trampoline_;
   * const void* quick_generic_jni_trampoline_;           <-- ...to this
   * const void* quick_to_interpreter_bridge_trampoline_;
   * ...
   * }
   *
   * On Android 6.x and above:
   *
   * class ClassLinker {
   * ...
   * InternTable* intern_table_;                          <-- We find this then calculate our way forwards
   * const void* quick_resolution_trampoline_;
   * const void* quick_imt_conflict_trampoline_;
   * const void* quick_generic_jni_trampoline_;           <-- ...to this
   * const void* quick_to_interpreter_bridge_trampoline_;
   * ...
   * }
   */
  var runtime = api.artRuntime;
  var runtimeSpec = getArtRuntimeSpec(api);
  var classLinker = runtime.add(runtimeSpec.offset.classLinker).readPointer();
  var internTable = runtime.add(runtimeSpec.offset.internTable).readPointer();
  var startOffset = pointerSize === 4 ? 100 : 200;
  var endOffset = startOffset + 100 * pointerSize;
  var apiLevel = getAndroidApiLevel();
  var spec = null;

  for (var offset = startOffset; offset !== endOffset; offset += pointerSize) {
    var value = classLinker.add(offset).readPointer();

    if (value.equals(internTable)) {
      var delta = void 0;

      if (apiLevel >= 29) {
        delta = 4;
      } else if (apiLevel >= 23) {
        delta = 3;
      } else {
        delta = 5;
      }

      spec = {
        offset: {
          quickGenericJniTrampoline: offset + delta * pointerSize
        }
      };
      break;
    }
  }

  if (spec === null) {
    throw new Error('Unable to determine ClassLinker field offsets');
  }

  return spec;
}

function _getArtMethodSpec(vm) {
  var api = getApi();
  var spec;
  vm.perform(function () {
    var env = vm.getEnv();
    var process = env.findClass('android/os/Process');
    var setArgV0 = env.getStaticMethodId(process, 'setArgV0', '(Ljava/lang/String;)V');
    var runtimeModule = Process.getModuleByName('libandroid_runtime.so');
    var runtimeStart = runtimeModule.base;
    var runtimeEnd = runtimeStart.add(runtimeModule.size);
    var apiLevel = getAndroidApiLevel();
    var entrypointFieldSize = apiLevel <= 21 ? 8 : pointerSize;
    var expectedAccessFlags = kAccPublic | kAccStatic | kAccFinal | kAccNative;
    var allFlagsExceptPublicApi = ~kAccPublicApi >>> 0;
    var jniCodeOffset = null;
    var accessFlagsOffset = null;
    var remaining = 2;

    for (var offset = 0; offset !== 64 && remaining !== 0; offset += 4) {
      var field = setArgV0.add(offset);

      if (jniCodeOffset === null) {
        var address = field.readPointer();

        if (address.compare(runtimeStart) >= 0 && address.compare(runtimeEnd) < 0) {
          jniCodeOffset = offset;
          remaining--;
        }
      }

      if (accessFlagsOffset === null) {
        var flags = field.readU32();

        if ((flags & allFlagsExceptPublicApi) === expectedAccessFlags) {
          accessFlagsOffset = offset;
          remaining--;
        }
      }
    }

    if (remaining !== 0) {
      throw new Error('Unable to determine ArtMethod field offsets');
    }

    var quickCodeOffset = jniCodeOffset + entrypointFieldSize;
    var size = apiLevel <= 21 ? quickCodeOffset + 32 : quickCodeOffset + pointerSize;
    spec = {
      size: size,
      offset: {
        jniCode: jniCodeOffset,
        quickCode: quickCodeOffset,
        accessFlags: accessFlagsOffset
      }
    };

    if ('artInterpreterToCompiledCodeBridge' in api) {
      spec.offset.interpreterCode = jniCodeOffset - entrypointFieldSize;
    }
  });
  return spec;
}

function _getArtThreadSpec(vm) {
  /*
   * bool32_t is_exception_reported_to_instrumentation_; <-- We need this on API level <= 22
   * ...
   * mirror::Throwable* exception;                       <-- ...and this on all versions
   * uint8_t* stack_end;
   * ManagedStack managed_stack;
   * uintptr_t* suspend_trigger;
   * JNIEnvExt* jni_env;                                 <-- We find this then calculate our way backwards/forwards
   * JNIEnvExt* tmp_jni_env;                             <-- API level >= 23
   * Thread* self;
   * mirror::Object* opeer;
   * jobject jpeer;
   * uint8_t* stack_begin;
   * size_t stack_size;
   * ThrowLocation throw_location;                       <-- ...and this on API level <= 22
   * union DepsOrStackTraceSample {
   *   DepsOrStackTraceSample() {
   *     verifier_deps = nullptr;
   *     stack_trace_sample = nullptr;
   *   }
   *   std::vector<ArtMethod*>* stack_trace_sample;
   *   verifier::VerifierDeps* verifier_deps;
   * } deps_or_stack_trace_sample;
   * Thread* wait_next;
   * mirror::Object* monitor_enter_object;
   * BaseHandleScope* top_handle_scope;                  <-- ...and to this on all versions
   */
  var api = getApi();
  var apiLevel = getAndroidApiLevel();
  var spec;
  vm.perform(function () {
    var env = vm.getEnv();
    var threadHandle = getArtThreadFromEnv(env);
    var envHandle = env.handle;
    var isExceptionReportedOffset = null;
    var exceptionOffset = null;
    var throwLocationOffset = null;
    var topHandleScopeOffset = null;

    for (var offset = 144; offset !== 256; offset += pointerSize) {
      var field = threadHandle.add(offset);
      var value = field.readPointer();

      if (value.equals(envHandle)) {
        exceptionOffset = offset - 6 * pointerSize;

        if (apiLevel <= 22) {
          exceptionOffset -= pointerSize;
          isExceptionReportedOffset = exceptionOffset - pointerSize - 9 * 8 - 3 * 4;
          throwLocationOffset = offset + 6 * pointerSize;
        }

        topHandleScopeOffset = offset + 9 * pointerSize;

        if (apiLevel <= 22) {
          topHandleScopeOffset += 2 * pointerSize + 4;

          if (pointerSize === 8) {
            topHandleScopeOffset += 4;
          }
        }

        if (apiLevel >= 23) {
          topHandleScopeOffset += pointerSize;
        }

        break;
      }
    }

    if (topHandleScopeOffset === null) {
      throw new Error('Unable to determine ArtThread field offsets');
    }

    spec = {
      offset: {
        isExceptionReportedToInstrumentation: isExceptionReportedOffset,
        exception: exceptionOffset,
        throwLocation: throwLocationOffset,
        topHandleScope: topHandleScopeOffset
      }
    };
  });
  return spec;
}

function getArtThreadFromEnv(env) {
  return env.handle.add(pointerSize).readPointer();
}

function _getAndroidVersion() {
  return getAndroidSystemProperty('ro.build.version.release');
}

function _getAndroidApiLevel() {
  return (0, _parseInt2["default"])(getAndroidSystemProperty('ro.build.version.sdk'), 10);
}

var systemPropertyGet = null;
var PROP_VALUE_MAX = 92;

function getAndroidSystemProperty(name) {
  if (systemPropertyGet === null) {
    systemPropertyGet = new NativeFunction(Module.findExportByName('libc.so', '__system_property_get'), 'int', ['pointer', 'pointer'], nativeFunctionOptions);
  }

  var buf = Memory.alloc(PROP_VALUE_MAX);
  systemPropertyGet(Memory.allocUtf8String(name), buf);
  return buf.readUtf8String();
}

function withRunnableArtThread(vm, env, fn) {
  var perform = getArtThreadStateTransitionImpl(vm, env);
  var id = getArtThreadFromEnv(env).toString();
  artThreadStateTransitions[id] = fn;
  perform(env.handle);

  if (artThreadStateTransitions[id] !== undefined) {
    delete artThreadStateTransitions[id];
    throw new Error('Unable to perform state transition; please file a bug at https://github.com/frida/frida-java-bridge');
  }
}

function onThreadStateTransitionComplete(thread) {
  var id = thread.toString();
  var fn = artThreadStateTransitions[id];
  delete artThreadStateTransitions[id];
  fn(thread);
}

function withAllArtThreadsSuspended(fn) {
  var api = getApi();
  var threadList = api.artThreadList;
  var longSuspend = false;
  api['art::ThreadList::SuspendAll'](threadList, Memory.allocUtf8String('frida'), longSuspend ? 1 : 0);

  try {
    fn();
  } finally {
    api['art::ThreadList::ResumeAll'](threadList);
  }
}

var ArtClassVisitor = function ArtClassVisitor(visit) {
  (0, _classCallCheck2["default"])(this, ArtClassVisitor);
  var visitor = Memory.alloc(4 * pointerSize);
  var vtable = visitor.add(pointerSize);
  visitor.writePointer(vtable);
  var onVisit = new NativeCallback(function (self, klass) {
    return visit(klass) === true ? 1 : 0;
  }, 'bool', ['pointer', 'pointer']);
  vtable.add(2 * pointerSize).writePointer(onVisit);
  this.handle = visitor;
  this._onVisit = onVisit;
};

function makeArtClassVisitor(visit) {
  var api = getApi();

  if (api['art::ClassLinker::VisitClasses'] instanceof NativeFunction) {
    return new ArtClassVisitor(visit);
  }

  return new NativeCallback(function (klass) {
    return visit(klass) === true ? 1 : 0;
  }, 'bool', ['pointer', 'pointer']);
}

var ArtClassLoaderVisitor = function ArtClassLoaderVisitor(visit) {
  (0, _classCallCheck2["default"])(this, ArtClassLoaderVisitor);
  var visitor = Memory.alloc(4 * pointerSize);
  var vtable = visitor.add(pointerSize);
  visitor.writePointer(vtable);
  var onVisit = new NativeCallback(function (self, klass) {
    visit(klass);
  }, 'void', ['pointer', 'pointer']);
  vtable.add(2 * pointerSize).writePointer(onVisit);
  this.handle = visitor;
  this._onVisit = onVisit;
};

function makeArtClassLoaderVisitor(visit) {
  return new ArtClassLoaderVisitor(visit);
}

var WalkKind = {
  'include-inlined-frames': 0,
  'skip-inlined-frames': 1
};

var ArtStackVisitor =
/*#__PURE__*/
function () {
  function ArtStackVisitor(thread, context, walkKind) {
    var numFrames = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : 0;
    var checkSuspended = arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : true;
    (0, _classCallCheck2["default"])(this, ArtStackVisitor);
    var api = getApi();
    var baseSize = 512;
    /* Up to 488 bytes on 64-bit Android Q. */

    var vtableSize = 3 * pointerSize;
    var visitor = Memory.alloc(baseSize + vtableSize);
    api['art::StackVisitor::StackVisitor'](visitor, thread, context, WalkKind[walkKind], ptr(numFrames), checkSuspended ? 1 : 0);
    var vtable = visitor.add(baseSize);
    visitor.writePointer(vtable);
    var onVisitFrame = new NativeCallback(this._visitFrame.bind(this), 'bool', ['pointer']);
    vtable.add(2 * pointerSize).writePointer(onVisitFrame);
    this.handle = visitor;
    this._onVisitFrame = onVisitFrame;
    var curShadowFrame = visitor.add(pointerSize === 4 ? 12 : 24);
    this._curShadowFrame = curShadowFrame;
    this._curQuickFrame = curShadowFrame.add(pointerSize);
    this._curQuickFramePc = curShadowFrame.add(2 * pointerSize);
    this._curOatQuickMethodHeader = curShadowFrame.add(3 * pointerSize);
    this._getMethodImpl = api['art::StackVisitor::GetMethod'];
    this._descLocImpl = api['art::StackVisitor::DescribeLocation'];
    this._getCQFIImpl = api['art::StackVisitor::GetCurrentQuickFrameInfo'];
  }

  (0, _createClass2["default"])(ArtStackVisitor, [{
    key: "walkStack",
    value: function walkStack() {
      var includeTransitions = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : false;
      getApi()['art::StackVisitor::WalkStack'](this.handle, includeTransitions ? 1 : 0);
    }
  }, {
    key: "_visitFrame",
    value: function _visitFrame() {
      return this.visitFrame() ? 1 : 0;
    }
  }, {
    key: "visitFrame",
    value: function visitFrame() {
      throw new Error('Subclass must implement visitFrame');
    }
  }, {
    key: "getMethod",
    value: function getMethod() {
      var methodHandle = this._getMethodImpl(this.handle);

      if (methodHandle.isNull()) {
        return null;
      }

      return new ArtMethod(methodHandle);
    }
  }, {
    key: "getCurrentQuickFramePc",
    value: function getCurrentQuickFramePc() {
      return this._curQuickFramePc.readPointer();
    }
  }, {
    key: "getCurrentQuickFrame",
    value: function getCurrentQuickFrame() {
      return this._curQuickFrame.readPointer();
    }
  }, {
    key: "getCurrentShadowFrame",
    value: function getCurrentShadowFrame() {
      return this._curShadowFrame.readPointer();
    }
  }, {
    key: "describeLocation",
    value: function describeLocation() {
      var result = new StdString();

      this._descLocImpl(result, this.handle);

      return result.disposeToString();
    }
  }, {
    key: "getCurrentOatQuickMethodHeader",
    value: function getCurrentOatQuickMethodHeader() {
      return this._curOatQuickMethodHeader.readPointer();
    }
  }, {
    key: "getCurrentQuickFrameInfo",
    value: function getCurrentQuickFrameInfo() {
      return this._getCQFIImpl(this.handle);
    }
  }]);
  return ArtStackVisitor;
}();

var ArtMethod =
/*#__PURE__*/
function () {
  function ArtMethod(handle) {
    (0, _classCallCheck2["default"])(this, ArtMethod);
    this.handle = handle;
  }

  (0, _createClass2["default"])(ArtMethod, [{
    key: "prettyMethod",
    value: function prettyMethod() {
      var withSignature = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : true;
      var result = new StdString();
      getApi()['art::ArtMethod::PrettyMethod'](result, this.handle, withSignature ? 1 : 0);
      return result.disposeToString();
    }
  }, {
    key: "toString",
    value: function toString() {
      return "ArtMethod(handle=".concat(this.handle, ")");
    }
  }]);
  return ArtMethod;
}();

function makeArtQuickFrameInfoGetter(impl) {
  if (Process.arch !== 'arm64') {
    return function () {
      throw new Error('Only supported on arm64 for now');
    };
  }

  return function (self) {
    var result = Memory.alloc(12);
    getArtQuickFrameInfoGetterThunk(impl)(result, self);
    return {
      frameSizeInBytes: result.readU32(),
      coreSpillMask: result.add(4).readU32(),
      fpSpillMask: result.add(8).readU32()
    };
  };
}

function _getArtQuickFrameInfoGetterThunk(impl) {
  var thunk = makeThunk(64, function (writer) {
    writer.putPushRegReg('x0', 'lr');
    writer.putCallAddressWithArguments(impl, ['x1']);
    writer.putPopRegReg('x2', 'lr');
    writer.putStrRegRegOffset('x0', 'x2', 0);
    writer.putStrRegRegOffset('w1', 'x2', 8);
    writer.putRet();
  });
  return new NativeFunction(thunk, 'void', ['pointer', 'pointer'], nativeFunctionOptions);
}

var thunkWriters = {
  ia32: global.X86Writer,
  x64: global.X86Writer,
  arm: global.ThumbWriter,
  arm64: global.Arm64Writer
};

function makeThunk(size, write) {
  if (thunkPage === null) {
    thunkPage = Memory.alloc(Process.pageSize);
  }

  var thunk = thunkPage.add(thunkOffset);
  var arch = Process.arch;
  var Writer = thunkWriters[arch];
  Memory.patchCode(thunk, size, function (code) {
    var writer = new Writer(code, {
      pc: thunk
    });
    write(writer);
    writer.flush();

    if (writer.offset > size) {
      throw new Error("Wrote ".concat(writer.offset, ", exceeding maximum of ").concat(size));
    }
  });
  thunkOffset += size;
  return arch === 'arm' ? thunk.or(1) : thunk;
}

function notifyArtMethodHooked(method) {
  ensureArtKnowsHowToHandleHookedMethods();
}

var LIBFFI_CLOSURE_MAGIC_X64 = uint64('0xfffffffff9158d4c');
var LIBFFI_CLOSURE_MAGIC_ARM = uint64('0xe51ff004e24fc008');
var LIBFFI_CLOSURE_MAGIC_ARM64 = uint64('0x10fffff158000090');
var libffiClosureEntrypointParsers = {
  ia32: parseLibffiClosureEntrypointForIA32,
  x64: parseLibffiClosureEntrypointForX64,
  arm: parseLibffiClosureEntrypointForArm,
  arm64: parseLibffiClosureEntrypointForArm64
};
var goqmhFilterFuncGenerators = {
  ia32: makeGoqmhFilterFuncForIA32,
  x64: makeGoqmhFilterFuncForX64,
  arm: makeGoqmhFilterFuncForArm,
  arm64: makeGoqmhFilterFuncForArm64
};

function ensureArtKnowsHowToHandleHookedMethods() {
  if (taughtArtAboutHookedMethods) {
    return;
  }

  taughtArtAboutHookedMethods = true;
  var api = getApi();
  var methodOffsets = getArtMethodSpec(api.vm).offset;
  var jniCodeOffset = methodOffsets.jniCode;
  var getOatQuickMethodHeaderImpl = Module.findExportByName('libart.so', pointerSize === 4 ? '_ZN3art9ArtMethod23GetOatQuickMethodHeaderEj' : '_ZN3art9ArtMethod23GetOatQuickMethodHeaderEm');

  if (getOatQuickMethodHeaderImpl === null) {
    return;
  }

  var signature = ['pointer', ['pointer', 'pointer']];
  var original = (0, _construct2["default"])(NativeFunction, [getOatQuickMethodHeaderImpl].concat(signature));
  var arch = Process.arch;
  var parseClosure = libffiClosureEntrypointParsers[arch];
  var fridaLibffiClosureEntrypoint = parseClosure(new NativeCallback(function () {}, 'void', []));
  var replacement = (0, _construct2["default"])(NativeCallback, [function (method, pc) {
    var jniImpl = method.add(jniCodeOffset).readPointer();
    var entrypoint = parseClosure(jniImpl);
    var isHookedMethod = entrypoint.equals(fridaLibffiClosureEntrypoint);

    if (isHookedMethod) {
      return NULL;
    }

    return original(method, pc);
  }].concat(signature));
  var generateFilterFunc = goqmhFilterFuncGenerators[arch];
  var filter = generateFilterFunc(original, replacement, methodOffsets.quickCode, api.artQuickGenericJniTrampoline);
  filter._replacement = replacement;

  try {
    Interceptor.replace(original, filter);
  } catch (e) {
    /*
     * Already replaced by another script. For now we count on the other script
     * not getting unloaded before ours.
     */
  }
}

function parseLibffiClosureEntrypointForIA32(closure) {
  if (closure.readU8() !== 0xb8 || closure.add(5).readU8() !== 0xe9) {
    return NULL;
  }

  var offset = closure.add(6).readS32();
  return closure.add(10).add(offset);
}

function parseLibffiClosureEntrypointForX64(closure) {
  if (!closure.readU64().equals(LIBFFI_CLOSURE_MAGIC_X64)) {
    return NULL;
  }

  if (closure.add(8).readU8() !== 0x25 || closure.add(9).readS32() !== 3) {
    return NULL;
  }

  return closure.add(16).readPointer();
}

function parseLibffiClosureEntrypointForArm(closure) {
  if (!closure.readU64().equals(LIBFFI_CLOSURE_MAGIC_ARM)) {
    return NULL;
  }

  return closure.add(8).readPointer();
}

function parseLibffiClosureEntrypointForArm64(closure) {
  if (!closure.readU64().equals(LIBFFI_CLOSURE_MAGIC_ARM64)) {
    return NULL;
  }

  return closure.add(16).readPointer();
}

function makeGoqmhFilterFuncForIA32(original, replacement, quickCodeOffset, quickJniTrampoline) {
  return makeThunk(32, function (writer) {
    writer.putMovRegRegOffsetPtr('eax', 'esp', 4);
    writer.putMovRegRegOffsetPtr('eax', 'eax', quickCodeOffset);
    writer.putCmpRegI32('eax', quickJniTrampoline.toInt32());
    writer.putJccShortLabel('je', 'potentially_hooked', 'unlikely');
    writer.putJmpAddress(original);
    writer.putLabel('potentially_hooked');
    writer.putJmpAddress(replacement);
  });
}

function makeGoqmhFilterFuncForX64(original, replacement, quickCodeOffset, quickJniTrampoline) {
  return makeThunk(48, function (writer) {
    writer.putMovRegAddress('rdx', quickJniTrampoline);
    writer.putCmpRegOffsetPtrReg('rdi', quickCodeOffset, 'rdx');
    writer.putJccShortLabel('je', 'potentially_hooked', 'unlikely');
    writer.putJmpAddress(original);
    writer.putLabel('potentially_hooked');
    writer.putJmpAddress(replacement);
  });
}

function makeGoqmhFilterFuncForArm(original, replacement, quickCodeOffset, quickJniTrampoline) {
  return makeThunk(32, function (writer) {
    writer.putLdrRegRegOffset('r2', 'r0', quickCodeOffset);
    writer.putLdrRegAddress('r3', quickJniTrampoline);
    writer.putSubRegRegReg('r2', 'r2', 'r3');
    writer.putCbzRegLabel('r2', 'potentially_hooked');
    writer.putLdrRegAddress('r2', original);
    writer.putBxReg('r2');
    writer.putLabel('potentially_hooked');
    writer.putLdrRegAddress('r2', replacement);
    writer.putBxReg('r2');
  });
}

function makeGoqmhFilterFuncForArm64(original, replacement, quickCodeOffset, quickJniTrampoline) {
  return makeThunk(64, function (writer) {
    writer.putLdrRegRegOffset('x2', 'x0', quickCodeOffset);
    writer.putLdrRegAddress('x3', quickJniTrampoline);
    writer.putCmpRegReg('x2', 'x3');
    writer.putBCondLabel('eq', 'potentially_hooked');
    writer.putLdrRegAddress('x2', original);
    writer.putBrReg('x2');
    writer.putLabel('potentially_hooked');
    writer.putLdrRegAddress('x2', replacement);
    writer.putBrReg('x2');
  });
}

function cloneArtMethod(method) {
  var api = getApi();

  if (getAndroidApiLevel() < 23) {
    var thread = api['art::Thread::CurrentFromGdb']();
    return api['art::mirror::Object::Clone'](method, thread);
  }

  return Memory.dup(method, getArtMethodSpec(api.vm).size);
}

function deoptimizeEverything(vm, env) {
  var api = getApi();

  if (getAndroidApiLevel() < 24) {
    throw new Error('This API is only available on Nougat and above');
  }

  withRunnableArtThread(vm, env, function (thread) {
    if (!api.isJdwpStarted()) {
      jdwpSession = startJdwp(api);
    }

    if (!api.isDebuggerActive()) {
      api['art::Dbg::GoActive']();
    }

    var kFullDeoptimization = 3;
    var request = Memory.alloc(8 + pointerSize);
    request.writeU32(kFullDeoptimization);
    api['art::Dbg::RequestDeoptimization'](request);
    api['art::Dbg::ManageDeoptimization']();
  });
}

var JdwpSession =
/*#__PURE__*/
function () {
  function JdwpSession() {
    (0, _classCallCheck2["default"])(this, JdwpSession);

    /*
     * We partially stub out the ADB JDWP transport to ensure we always
     * succeed in starting JDWP. Failure will crash the process.
     */
    var acceptImpl = Module.getExportByName('libart.so', '_ZN3art4JDWP12JdwpAdbState6AcceptEv');
    var receiveClientFdImpl = Module.getExportByName('libart.so', '_ZN3art4JDWP12JdwpAdbState15ReceiveClientFdEv');
    var controlPair = makeSocketPair();
    var clientPair = makeSocketPair();
    this._controlFd = controlPair[0];
    this._clientFd = clientPair[0];
    var acceptListener = null;
    acceptListener = Interceptor.attach(acceptImpl, function (args) {
      var state = args[0];
      var controlSockPtr = Memory.scanSync(state.add(8252), 256, '00 ff ff ff ff 00')[0].address.add(1);
      /*
       * This will make JdwpAdbState::Accept() skip the control socket() and connect(),
       * and skip right to calling ReceiveClientFd(), replaced below.
       */

      controlSockPtr.writeS32(controlPair[1]);
      acceptListener.detach();
    });
    Interceptor.replace(receiveClientFdImpl, new NativeCallback(function (state) {
      Interceptor.revert(receiveClientFdImpl);
      return clientPair[1];
    }, 'int', ['pointer']));
    Interceptor.flush();
    this._handshakeRequest = this._performHandshake();
  }

  (0, _createClass2["default"])(JdwpSession, [{
    key: "_performHandshake",
    value: function _performHandshake() {
      var input, output, handshakePacket;
      return _regenerator["default"].async(function _performHandshake$(_context) {
        while (1) {
          switch (_context.prev = _context.next) {
            case 0:
              input = new UnixInputStream(this._clientFd, {
                autoClose: false
              });
              output = new UnixOutputStream(this._clientFd, {
                autoClose: false
              });
              handshakePacket = [0x4a, 0x44, 0x57, 0x50, 0x2d, 0x48, 0x61, 0x6e, 0x64, 0x73, 0x68, 0x61, 0x6b, 0x65];
              _context.prev = 3;
              _context.next = 6;
              return _regenerator["default"].awrap(output.writeAll(handshakePacket));

            case 6:
              _context.next = 8;
              return _regenerator["default"].awrap(input.readAll(handshakePacket.length));

            case 8:
              _context.next = 12;
              break;

            case 10:
              _context.prev = 10;
              _context.t0 = _context["catch"](3);

            case 12:
            case "end":
              return _context.stop();
          }
        }
      }, null, this, [[3, 10]]);
    }
  }]);
  return JdwpSession;
}();

function startJdwp(api) {
  var session = new JdwpSession();
  api['art::Dbg::SetJdwpAllowed'](1);
  var options = makeJdwpOptions();
  api['art::Dbg::ConfigureJdwp'](options);
  var startDebugger = api['art::InternalDebuggerControlCallback::StartDebugger'];

  if (startDebugger !== undefined) {
    startDebugger(NULL);
  } else {
    api['art::Dbg::StartJdwp']();
  }

  return session;
}

function makeJdwpOptions() {
  var kJdwpTransportAndroidAdb = 3;
  var kJdwpPortFirstAvailable = 0;
  var transport = kJdwpTransportAndroidAdb;
  var server = true;
  var suspend = false;
  var port = kJdwpPortFirstAvailable;
  var size = 8 + STD_STRING_SIZE + 2;
  var result = Memory.alloc(size);
  result.writeU32(transport).add(4).writeU8(server ? 1 : 0).add(1).writeU8(suspend ? 1 : 0).add(1).add(STD_STRING_SIZE) // We leave `host` zeroed, i.e. empty string
  .writeU16(port);
  return result;
}

function makeSocketPair() {
  if (socketpair === null) {
    socketpair = new NativeFunction(Module.getExportByName('libc.so', 'socketpair'), 'int', ['int', 'int', 'int', 'pointer']);
  }

  var buf = Memory.alloc(8);

  if (socketpair(AF_UNIX, SOCK_STREAM, 0, buf) === -1) {
    throw new Error('Unable to create socketpair for JDWP');
  }

  return [buf.readS32(), buf.add(4).readS32()];
}

function makeAddGlobalRefFallbackForAndroid5(api) {
  var offset = getArtVMSpec().offset;
  var lock = api.vm.add(offset.globalsLock);
  var table = api.vm.add(offset.globals);
  var add = api['art::IndirectReferenceTable::Add'];
  var acquire = api['art::ReaderWriterMutex::ExclusiveLock'];
  var release = api['art::ReaderWriterMutex::ExclusiveUnlock'];
  var IRT_FIRST_SEGMENT = 0;
  return function (vm, thread, obj) {
    acquire(lock, thread);

    try {
      return add(table, IRT_FIRST_SEGMENT, obj);
    } finally {
      release(lock, thread);
    }
  };
}

function makeDecodeGlobalFallbackForAndroid5(api) {
  var decode = api['art::Thread::DecodeJObject'];
  return function (vm, thread, ref) {
    return decode(thread, ref);
  };
}
/*
 * In order to call internal ART APIs we need to transition our native thread's
 * art::Thread to the proper state. The ScopedObjectAccess (SOA) helper that ART
 * uses internally is what we would like to use to accomplish this goal.
 *
 * There is however a challenge. The SOA implementation is fully inlined, so
 * we cannot just allocate a chunk of memory and call its constructor and
 * destructor to get the desired setup and teardown.
 *
 * We could however precompile such code using a C++ compiler, but considering
 * how many versions of ART we would need to compile it for, multiplied by the
 * number of supported architectures, we really don't want to go there.
 *
 * Reimplementing it in JavaScript is not desirable either, as we would need
 * to keep track of even more internals prone to change as ART evolves.
 *
 * So our least terrible option is to find a really simple C++ method in ART
 * that sets up a SOA object, performs as few and distinct operations as
 * possible, and then returns. If we clone that implementation we can swap
 * out the few/distinct operations with our own.
 *
 * We can accomplish this by using Frida's relocator API, and detecting the
 * few/distinct operations happening between setup and teardown of the scope.
 * We skip those when making our copy and instead put a call to a NativeCallback
 * there. Our NativeCallback is thus able to call internal ART APIs safely.
 *
 * The ExceptionClear() implementation that's part of the JNIEnv's vtable is
 * a perfect fit, as all it does is clear one field of the art::Thread.
 * (Except on older versions where it also clears a bit more... but still
 * pretty simple.)
 *
 * However, checked JNI might be enabled, making ExceptionClear() a bit more
 * complex, and essentially a wrapper around the unchecked version.
 *
 * One last thing to note is that we also look up the address of FatalError(),
 * as ExceptionClear() typically ends with a __stack_chk_fail() noreturn call
 * that's followed by the next JNIEnv vtable method, FatalError(). We don't want
 * to recompile its code as well, so we try to detect it. There might however be
 * padding between the two functions, which we need to ignore. Ideally we would
 * know that the call is to __stack_chk_fail(), so we can stop at that point,
 * but detecting that isn't trivial.
 */


var threadStateTransitionRecompilers = {
  ia32: recompileExceptionClearForX86,
  x64: recompileExceptionClearForX86,
  arm: recompileExceptionClearForArm,
  arm64: recompileExceptionClearForArm64
};

function _getArtThreadStateTransitionImpl(vm, env) {
  var envVtable = env.handle.readPointer();
  var exceptionClearImpl = envVtable.add(ENV_VTABLE_OFFSET_EXCEPTION_CLEAR).readPointer();
  var nextFuncImpl = envVtable.add(ENV_VTABLE_OFFSET_FATAL_ERROR).readPointer();
  var recompile = threadStateTransitionRecompilers[Process.arch];

  if (recompile === undefined) {
    throw new Error('Not yet implemented for ' + Process.arch);
  }

  var perform = null;
  var callback = new NativeCallback(onThreadStateTransitionComplete, 'void', ['pointer']);
  var threadOffsets = getArtThreadSpec(vm).offset;
  var exceptionOffset = threadOffsets.exception;
  var neuteredOffsets = new _set["default"]();
  var isReportedOffset = threadOffsets.isExceptionReportedToInstrumentation;

  if (isReportedOffset !== null) {
    neuteredOffsets.add(isReportedOffset);
  }

  var throwLocationStartOffset = threadOffsets.throwLocation;

  if (throwLocationStartOffset !== null) {
    neuteredOffsets.add(throwLocationStartOffset);
    neuteredOffsets.add(throwLocationStartOffset + pointerSize);
    neuteredOffsets.add(throwLocationStartOffset + 2 * pointerSize);
  }

  var codeSize = 65536;
  var code = Memory.alloc(codeSize);
  Memory.patchCode(code, codeSize, function (buffer) {
    perform = recompile(buffer, code, exceptionClearImpl, nextFuncImpl, exceptionOffset, neuteredOffsets, callback);
  });
  perform._code = code;
  perform._callback = callback;
  return perform;
}

function recompileExceptionClearForX86(buffer, pc, exceptionClearImpl, nextFuncImpl, exceptionOffset, neuteredOffsets, callback) {
  var blocks = {};
  var blockByInstruction = {};
  var branchTargets = new _set["default"]();
  var pending = [exceptionClearImpl];

  var _loop = function _loop() {
    var current = pending.shift();
    var blockAddressKey = current.toString();

    if (blockByInstruction[blockAddressKey] !== undefined) {
      return "continue";
    }

    var block = {
      begin: current
    };
    var instructionAddressIds = [];
    var lastInstructionSize = 0;
    var reachedEndOfBlock = false;

    do {
      if (current.equals(nextFuncImpl)) {
        reachedEndOfBlock = true;
        break;
      }

      var insn = Instruction.parse(current);
      var insnAddressId = insn.address.toString();
      var mnemonic = insn.mnemonic;
      instructionAddressIds.push(insnAddressId);
      lastInstructionSize = insn.size;
      var existingBlock = blocks[insnAddressId];

      if (existingBlock !== undefined) {
        delete blocks[existingBlock.begin.toString()];
        blocks[blockAddressKey] = existingBlock;
        existingBlock.begin = block.begin;
        block = null;
        break;
      }

      var branchTarget = null;

      switch (mnemonic) {
        case 'jmp':
          branchTarget = ptr(insn.operands[0].value);
          reachedEndOfBlock = true;
          break;

        case 'je':
        case 'jg':
        case 'jle':
        case 'jne':
        case 'js':
          branchTarget = ptr(insn.operands[0].value);
          break;

        case 'ret':
          reachedEndOfBlock = true;
          break;
      }

      if (branchTarget !== null) {
        branchTargets.add(branchTarget.toString());
        pending.push(branchTarget);
        pending.sort(function (a, b) {
          return a.compare(b);
        });
      }

      current = insn.next;
    } while (!reachedEndOfBlock);

    if (block !== null) {
      block.end = ptr(instructionAddressIds[instructionAddressIds.length - 1]).add(lastInstructionSize);
      blocks[blockAddressKey] = block;
      instructionAddressIds.forEach(function (id) {
        blockByInstruction[id] = block;
      });
    }
  };

  while (pending.length > 0) {
    var _ret = _loop();

    if (_ret === "continue") continue;
  }

  var blocksOrdered = (0, _keys["default"])(blocks).map(function (key) {
    return blocks[key];
  });
  blocksOrdered.sort(function (a, b) {
    return a.begin.compare(b.begin);
  });
  var entryBlock = blocks[exceptionClearImpl.toString()];
  blocksOrdered.splice(blocksOrdered.indexOf(entryBlock), 1);
  blocksOrdered.unshift(entryBlock);
  var writer = new X86Writer(buffer, {
    pc: pc
  });
  var foundCore = false;
  var threadReg = null;
  blocksOrdered.forEach(function (block) {
    var size = block.end.sub(block.begin).toInt32();
    var relocator = new X86Relocator(block.begin, writer);
    var offset;

    while ((offset = relocator.readOne()) !== 0) {
      var insn = relocator.input;
      var mnemonic = insn.mnemonic;
      var insnAddressId = insn.address.toString();

      if (branchTargets.has(insnAddressId)) {
        writer.putLabel(insnAddressId);
      }

      var keep = true;

      switch (mnemonic) {
        case 'jmp':
          writer.putJmpNearLabel(branchLabelFromOperand(insn.operands[0]));
          keep = false;
          break;

        case 'je':
        case 'jg':
        case 'jle':
        case 'jne':
        case 'js':
          writer.putJccNearLabel(mnemonic, branchLabelFromOperand(insn.operands[0]), 'no-hint');
          keep = false;
          break;

        /*
         * JNI::ExceptionClear(), when checked JNI is off.
         */

        case 'mov':
          {
            var _insn$operands = (0, _slicedToArray2["default"])(insn.operands, 2),
                dst = _insn$operands[0],
                src = _insn$operands[1];

            if (dst.type === 'mem' && src.type === 'imm') {
              var dstValue = dst.value;
              var dstOffset = dstValue.disp;

              if (dstOffset === exceptionOffset && src.value.valueOf() === 0) {
                threadReg = dstValue.base;
                writer.putPushfx();
                writer.putPushax();
                writer.putMovRegReg('xbp', 'xsp');

                if (pointerSize === 4) {
                  writer.putAndRegU32('esp', 0xfffffff0);
                } else {
                  writer.putMovRegU64('rax', uint64('0xfffffffffffffff0'));
                  writer.putAndRegReg('rsp', 'rax');
                }

                writer.putCallAddressWithAlignedArguments(callback, [threadReg]);
                writer.putMovRegReg('xsp', 'xbp');
                writer.putPopax();
                writer.putPopfx();
                foundCore = true;
                keep = false;
              } else if (neuteredOffsets.has(dstOffset) && dstValue.base === threadReg) {
                keep = false;
              }
            }

            break;
          }

        /*
         * CheckJNI::ExceptionClear, when checked JNI is on. Wrapper that calls JNI::ExceptionClear().
         */

        case 'call':
          {
            var target = insn.operands[0];

            if (target.type === 'mem' && target.value.disp === ENV_VTABLE_OFFSET_EXCEPTION_CLEAR) {
              /*
               * Get art::Thread * from JNIEnv *
               */
              if (pointerSize === 4) {
                writer.putPopReg('eax');
                writer.putMovRegRegOffsetPtr('eax', 'eax', 4);
                writer.putPushReg('eax');
              } else {
                writer.putMovRegRegOffsetPtr('rdi', 'rdi', 8);
              }

              writer.putCallAddressWithArguments(callback, []);
              foundCore = true;
              keep = false;
            }

            break;
          }
      }

      if (keep) {
        relocator.writeAll();
      } else {
        relocator.skipOne();
      }

      if (offset === size) {
        break;
      }
    }

    relocator.dispose();
  });
  writer.dispose();

  if (!foundCore) {
    throwThreadStateTransitionParseError();
  }

  return new NativeFunction(pc, 'void', ['pointer'], nativeFunctionOptions);
}

function recompileExceptionClearForArm(buffer, pc, exceptionClearImpl, nextFuncImpl, exceptionOffset, neuteredOffsets, callback) {
  var blocks = {};
  var blockByInstruction = {};
  var branchTargets = new _set["default"]();
  var thumbBitRemovalMask = ptr(1).not();
  var pending = [exceptionClearImpl];

  var _loop2 = function _loop2() {
    var current = pending.shift();
    var begin = current.and(thumbBitRemovalMask);
    var blockId = begin.toString();
    var thumbBit = current.and(1);

    if (blockByInstruction[blockId] !== undefined) {
      return "continue";
    }

    var block = {
      begin: begin
    };
    var instructionAddressIds = [];
    var lastInstructionSize = 0;
    var reachedEndOfBlock = false;
    var ifThenBlockRemaining = 0;

    do {
      if (current.equals(nextFuncImpl)) {
        reachedEndOfBlock = true;
        break;
      }

      var insn = Instruction.parse(current);
      var mnemonic = insn.mnemonic;
      var currentAddress = current.and(thumbBitRemovalMask);
      var insnId = currentAddress.toString();
      instructionAddressIds.push(insnId);
      lastInstructionSize = insn.size;
      var existingBlock = blocks[insnId];

      if (existingBlock !== undefined) {
        delete blocks[existingBlock.begin.toString()];
        blocks[blockId] = existingBlock;
        existingBlock.begin = block.begin;
        block = null;
        break;
      }

      var isOutsideIfThenBlock = ifThenBlockRemaining === 0;
      var branchTarget = null;

      switch (mnemonic) {
        case 'b':
          branchTarget = ptr(insn.operands[0].value);
          reachedEndOfBlock = isOutsideIfThenBlock;
          break;

        case 'beq.w':
        case 'beq':
        case 'bne':
        case 'bgt':
          branchTarget = ptr(insn.operands[0].value);
          break;

        case 'cbz':
        case 'cbnz':
          branchTarget = ptr(insn.operands[1].value);
          break;

        case 'pop.w':
          if (isOutsideIfThenBlock) {
            reachedEndOfBlock = insn.operands.filter(function (op) {
              return op.value === 'pc';
            }).length === 1;
          }

          break;
      }

      switch (mnemonic) {
        case 'it':
          ifThenBlockRemaining = 1;
          break;

        case 'itt':
          ifThenBlockRemaining = 2;
          break;

        case 'ittt':
          ifThenBlockRemaining = 3;
          break;

        case 'itttt':
          ifThenBlockRemaining = 4;
          break;

        default:
          if (ifThenBlockRemaining > 0) {
            ifThenBlockRemaining--;
          }

          break;
      }

      if (branchTarget !== null) {
        branchTargets.add(branchTarget.toString());
        pending.push(branchTarget.or(thumbBit));
        pending.sort(function (a, b) {
          return a.compare(b);
        });
      }

      current = insn.next;
    } while (!reachedEndOfBlock);

    if (block !== null) {
      block.end = ptr(instructionAddressIds[instructionAddressIds.length - 1]).add(lastInstructionSize);
      blocks[blockId] = block;
      instructionAddressIds.forEach(function (id) {
        blockByInstruction[id] = block;
      });
    }
  };

  while (pending.length > 0) {
    var _ret2 = _loop2();

    if (_ret2 === "continue") continue;
  }

  var blocksOrdered = (0, _keys["default"])(blocks).map(function (key) {
    return blocks[key];
  });
  blocksOrdered.sort(function (a, b) {
    return a.begin.compare(b.begin);
  });
  var entryBlock = blocks[exceptionClearImpl.and(thumbBitRemovalMask).toString()];
  blocksOrdered.splice(blocksOrdered.indexOf(entryBlock), 1);
  blocksOrdered.unshift(entryBlock);
  var writer = new ThumbWriter(buffer, {
    pc: pc
  });
  var foundCore = false;
  var threadReg = null;
  var realImplReg = null;
  blocksOrdered.forEach(function (block) {
    var relocator = new ThumbRelocator(block.begin, writer);
    var address = block.begin;
    var end = block.end;
    var size = 0;

    do {
      var offset = relocator.readOne();

      if (offset === 0) {
        throw new Error('Unexpected end of block');
      }

      var insn = relocator.input;
      address = insn.address;
      size = insn.size;
      var mnemonic = insn.mnemonic;
      var insnAddressId = address.toString();

      if (branchTargets.has(insnAddressId)) {
        writer.putLabel(insnAddressId);
      }

      var keep = true;

      switch (mnemonic) {
        case 'b':
          writer.putBLabel(branchLabelFromOperand(insn.operands[0]));
          keep = false;
          break;

        case 'beq.w':
          writer.putBCondLabelWide('eq', branchLabelFromOperand(insn.operands[0]));
          keep = false;
          break;

        case 'beq':
        case 'bne':
        case 'bgt':
          writer.putBCondLabelWide(mnemonic.substr(1), branchLabelFromOperand(insn.operands[0]));
          keep = false;
          break;

        case 'cbz':
          {
            var ops = insn.operands;
            writer.putCbzRegLabel(ops[0].value, branchLabelFromOperand(ops[1]));
            keep = false;
            break;
          }

        case 'cbnz':
          {
            var _ops = insn.operands;
            writer.putCbnzRegLabel(_ops[0].value, branchLabelFromOperand(_ops[1]));
            keep = false;
            break;
          }

        /*
         * JNI::ExceptionClear(), when checked JNI is off.
         */

        case 'str':
        case 'str.w':
          {
            var dstValue = insn.operands[1].value;
            var dstOffset = dstValue.disp;

            if (dstOffset === exceptionOffset) {
              threadReg = dstValue.base;
              var nzcvqReg = threadReg !== 'r4' ? 'r4' : 'r5';
              var clobberedRegs = ['r0', 'r1', 'r2', 'r3', nzcvqReg, 'r9', 'r12', 'lr'];
              writer.putPushRegs(clobberedRegs);
              writer.putMrsRegReg(nzcvqReg, 'apsr-nzcvq');
              writer.putCallAddressWithArguments(callback, [threadReg]);
              writer.putMsrRegReg('apsr-nzcvq', nzcvqReg);
              writer.putPopRegs(clobberedRegs);
              foundCore = true;
              keep = false;
            } else if (neuteredOffsets.has(dstOffset) && dstValue.base === threadReg) {
              keep = false;
            }

            break;
          }

        /*
         * CheckJNI::ExceptionClear, when checked JNI is on. Wrapper that calls JNI::ExceptionClear().
         */

        case 'ldr':
          {
            var _insn$operands2 = (0, _slicedToArray2["default"])(insn.operands, 2),
                dstOp = _insn$operands2[0],
                srcOp = _insn$operands2[1];

            if (srcOp.type === 'mem') {
              var src = srcOp.value;

              if (src.base[0] === 'r' && src.disp === ENV_VTABLE_OFFSET_EXCEPTION_CLEAR) {
                realImplReg = dstOp.value;
              }
            }

            break;
          }

        case 'blx':
          if (insn.operands[0].value === realImplReg) {
            writer.putLdrRegRegOffset('r0', 'r0', 4); // Get art::Thread * from JNIEnv *

            writer.putCallAddressWithArguments(callback, ['r0']);
            foundCore = true;
            realImplReg = null;
            keep = false;
          }

          break;
      }

      if (keep) {
        relocator.writeAll();
      } else {
        relocator.skipOne();
      }
    } while (!address.add(size).equals(end));

    relocator.dispose();
  });
  writer.dispose();

  if (!foundCore) {
    throwThreadStateTransitionParseError();
  }

  return new NativeFunction(pc.or(1), 'void', ['pointer'], nativeFunctionOptions);
}

function recompileExceptionClearForArm64(buffer, pc, exceptionClearImpl, nextFuncImpl, exceptionOffset, neuteredOffsets, callback) {
  var blocks = {};
  var blockByInstruction = {};
  var branchTargets = new _set["default"]();
  var pending = [exceptionClearImpl];

  var _loop3 = function _loop3() {
    var current = pending.shift();
    var blockAddressKey = current.toString();

    if (blockByInstruction[blockAddressKey] !== undefined) {
      return "continue";
    }

    var block = {
      begin: current
    };
    var instructionAddressIds = [];
    var reachedEndOfBlock = false;

    do {
      if (current.equals(nextFuncImpl) || current.readU32() === 0x00000000) {
        reachedEndOfBlock = true;
        break;
      }

      var insn = Instruction.parse(current);
      var insnAddressId = insn.address.toString();
      var mnemonic = insn.mnemonic;
      instructionAddressIds.push(insnAddressId);
      var existingBlock = blocks[insnAddressId];

      if (existingBlock !== undefined) {
        delete blocks[existingBlock.begin.toString()];
        blocks[blockAddressKey] = existingBlock;
        existingBlock.begin = block.begin;
        block = null;
        break;
      }

      var branchTarget = null;

      switch (mnemonic) {
        case 'b':
          branchTarget = ptr(insn.operands[0].value);
          reachedEndOfBlock = true;
          break;

        case 'b.eq':
        case 'b.ne':
        case 'b.le':
        case 'b.gt':
          branchTarget = ptr(insn.operands[0].value);
          break;

        case 'cbz':
        case 'cbnz':
          branchTarget = ptr(insn.operands[1].value);
          break;

        case 'tbz':
        case 'tbnz':
          branchTarget = ptr(insn.operands[2].value);
          break;

        case 'ret':
          reachedEndOfBlock = true;
          break;
      }

      if (branchTarget !== null) {
        branchTargets.add(branchTarget.toString());
        pending.push(branchTarget);
        pending.sort(function (a, b) {
          return a.compare(b);
        });
      }

      current = insn.next;
    } while (!reachedEndOfBlock);

    if (block !== null) {
      block.end = ptr(instructionAddressIds[instructionAddressIds.length - 1]).add(4);
      blocks[blockAddressKey] = block;
      instructionAddressIds.forEach(function (id) {
        blockByInstruction[id] = block;
      });
    }
  };

  while (pending.length > 0) {
    var _ret3 = _loop3();

    if (_ret3 === "continue") continue;
  }

  var blocksOrdered = (0, _keys["default"])(blocks).map(function (key) {
    return blocks[key];
  });
  blocksOrdered.sort(function (a, b) {
    return a.begin.compare(b.begin);
  });
  var entryBlock = blocks[exceptionClearImpl.toString()];
  blocksOrdered.splice(blocksOrdered.indexOf(entryBlock), 1);
  blocksOrdered.unshift(entryBlock);
  var writer = new Arm64Writer(buffer, {
    pc: pc
  });
  writer.putBLabel('performTransition');
  var invokeCallback = pc.add(writer.offset);
  writer.putPushAllXRegisters();
  writer.putCallAddressWithArguments(callback, ['x0']);
  writer.putPopAllXRegisters();
  writer.putRet();
  writer.putLabel('performTransition');
  var foundCore = false;
  var threadReg = null;
  var realImplReg = null;
  blocksOrdered.forEach(function (block) {
    var size = block.end.sub(block.begin).toInt32();
    var relocator = new Arm64Relocator(block.begin, writer);
    var offset;

    while ((offset = relocator.readOne()) !== 0) {
      var insn = relocator.input;
      var mnemonic = insn.mnemonic;
      var insnAddressId = insn.address.toString();

      if (branchTargets.has(insnAddressId)) {
        writer.putLabel(insnAddressId);
      }

      var keep = true;

      switch (mnemonic) {
        case 'b':
          writer.putBLabel(branchLabelFromOperand(insn.operands[0]));
          keep = false;
          break;

        case 'b.eq':
        case 'b.ne':
        case 'b.le':
        case 'b.gt':
          writer.putBCondLabel(mnemonic.substr(2), branchLabelFromOperand(insn.operands[0]));
          keep = false;
          break;

        case 'cbz':
          {
            var ops = insn.operands;
            writer.putCbzRegLabel(ops[0].value, branchLabelFromOperand(ops[1]));
            keep = false;
            break;
          }

        case 'cbnz':
          {
            var _ops2 = insn.operands;
            writer.putCbnzRegLabel(_ops2[0].value, branchLabelFromOperand(_ops2[1]));
            keep = false;
            break;
          }

        case 'tbz':
          {
            var _ops3 = insn.operands;
            writer.putTbzRegImmLabel(_ops3[0].value, _ops3[1].value.valueOf(), branchLabelFromOperand(_ops3[2]));
            keep = false;
            break;
          }

        case 'tbnz':
          {
            var _ops4 = insn.operands;
            writer.putTbnzRegImmLabel(_ops4[0].value, _ops4[1].value.valueOf(), branchLabelFromOperand(_ops4[2]));
            keep = false;
            break;
          }

        /*
         * JNI::ExceptionClear(), when checked JNI is off.
         */

        case 'str':
          {
            var _ops5 = insn.operands;
            var srcReg = _ops5[0].value;
            var dstValue = _ops5[1].value;
            var dstOffset = dstValue.disp;

            if (srcReg === 'xzr' && dstOffset === exceptionOffset) {
              threadReg = dstValue.base;
              writer.putPushRegReg('x0', 'lr');
              writer.putMovRegReg('x0', threadReg);
              writer.putBlImm(invokeCallback);
              writer.putPopRegReg('x0', 'lr');
              foundCore = true;
              keep = false;
            } else if (neuteredOffsets.has(dstOffset) && dstValue.base === threadReg) {
              keep = false;
            }

            break;
          }

        /*
         * CheckJNI::ExceptionClear, when checked JNI is on. Wrapper that calls JNI::ExceptionClear().
         */

        case 'ldr':
          {
            var _ops6 = insn.operands;
            var src = _ops6[1].value;

            if (src.base[0] === 'x' && src.disp === ENV_VTABLE_OFFSET_EXCEPTION_CLEAR) {
              realImplReg = _ops6[0].value;
            }

            break;
          }

        case 'blr':
          if (insn.operands[0].value === realImplReg) {
            writer.putLdrRegRegOffset('x0', 'x0', 8); // Get art::Thread * from JNIEnv *

            writer.putCallAddressWithArguments(callback, ['x0']);
            foundCore = true;
            realImplReg = null;
            keep = false;
          }

          break;
      }

      if (keep) {
        relocator.writeAll();
      } else {
        relocator.skipOne();
      }

      if (offset === size) {
        break;
      }
    }

    relocator.dispose();
  });
  writer.dispose();

  if (!foundCore) {
    throwThreadStateTransitionParseError();
  }

  return new NativeFunction(pc, 'void', ['pointer'], nativeFunctionOptions);
}

function throwThreadStateTransitionParseError() {
  throw new Error('Unable to parse ART internals; please file a bug at https://github.com/frida/frida-java-bridge');
}

function fixupArtQuickDeliverExceptionBug(api) {
  var prettyMethod = api['art::ArtMethod::PrettyMethod'];

  if (prettyMethod === undefined) {
    return;
  }
  /*
   * There is a bug in art::Thread::QuickDeliverException() where it assumes
   * there is a Java stack frame present on the art::Thread's stack. This is
   * not the case if a native thread calls a throwing method like FindClass().
   *
   * We work around this bug here by detecting when method->PrettyMethod()
   * happens with method == nullptr.
   */


  var thisArgIndex = Process.arch === 'arm64' ? 0 : 1;
  var lastSeenArtMethod = null;
  Interceptor.attach(ptr(prettyMethod), function (args) {
    var method = args[thisArgIndex];

    if (method.isNull()) {
      args[thisArgIndex] = lastSeenArtMethod;
    } else {
      lastSeenArtMethod = method;
    }
  });
  Interceptor.flush();
}

function branchLabelFromOperand(op) {
  return ptr(op.value).toString();
}

function memoize(compute) {
  var value = null;
  var computed = false;
  return function () {
    if (!computed) {
      value = compute.apply(void 0, arguments);
      computed = true;
    }

    return value;
  };
}

function makeCxxMethodWrapperReturningPointerByValueGeneric(address, argTypes) {
  return new NativeFunction(address, 'pointer', argTypes, nativeFunctionOptions);
}

function makeCxxMethodWrapperReturningPointerByValueInFirstArg(address, argTypes) {
  var impl = new NativeFunction(address, 'void', ['pointer'].concat(argTypes), nativeFunctionOptions);
  return function () {
    var resultPtr = Memory.alloc(pointerSize);
    impl.apply(void 0, [resultPtr].concat(Array.prototype.slice.call(arguments)));
    return resultPtr.readPointer();
  };
}

function makeCxxMethodWrapperReturningStdStringByValue(impl, argTypes) {
  if (Process.arch === 'arm64') {
    var thunk = makeThunk(32, function (writer) {
      writer.putMovRegReg('x8', 'x0');
      argTypes.forEach(function (t, i) {
        writer.putMovRegReg('x' + i, 'x' + (i + 1));
      });
      writer.putLdrRegAddress('x7', impl);
      writer.putBrReg('x7');
    });
    var invokeThunk = new NativeFunction(thunk, 'void', ['pointer'].concat(argTypes), nativeFunctionOptions);

    var wrapper = function wrapper() {
      invokeThunk.apply(void 0, arguments);
    };

    wrapper.handle = impl;
    return wrapper;
  }

  return new NativeFunction(impl, 'void', ['pointer'].concat(argTypes), nativeFunctionOptions);
}

var StdString =
/*#__PURE__*/
function () {
  function StdString() {
    (0, _classCallCheck2["default"])(this, StdString);
    this.handle = Memory.alloc(STD_STRING_SIZE);
  }

  (0, _createClass2["default"])(StdString, [{
    key: "dispose",
    value: function dispose() {
      var _this$_getData = this._getData(),
          _this$_getData2 = (0, _slicedToArray2["default"])(_this$_getData, 2),
          data = _this$_getData2[0],
          isTiny = _this$_getData2[1];

      if (!isTiny) {
        getApi().$delete(data);
      }
    }
  }, {
    key: "disposeToString",
    value: function disposeToString() {
      var result = this.toString();
      this.dispose();
      return result;
    }
  }, {
    key: "toString",
    value: function toString() {
      var _this$_getData3 = this._getData(),
          _this$_getData4 = (0, _slicedToArray2["default"])(_this$_getData3, 1),
          data = _this$_getData4[0];

      return data.readUtf8String();
    }
  }, {
    key: "_getData",
    value: function _getData() {
      var str = this.handle;
      var isTiny = (str.readU8() & 1) === 0;
      var data = isTiny ? str.add(1) : str.add(2 * pointerSize).readPointer();
      return [data, isTiny];
    }
  }]);
  return StdString;
}();

var StdVector =
/*#__PURE__*/
function () {
  (0, _createClass2["default"])(StdVector, [{
    key: "$delete",
    value: function $delete() {
      this.dispose();
      getApi().$delete(this);
    }
  }]);

  function StdVector(storage, elementSize) {
    (0, _classCallCheck2["default"])(this, StdVector);
    this.handle = storage;
    this._begin = storage;
    this._end = storage.add(pointerSize);
    this._storage = storage.add(2 * pointerSize);
    this._elementSize = elementSize;
  }

  (0, _createClass2["default"])(StdVector, [{
    key: "init",
    value: function init() {
      this.begin = NULL;
      this.end = NULL;
      this.storage = NULL;
    }
  }, {
    key: "dispose",
    value: function dispose() {
      getApi().$delete(this.begin);
    }
  }, {
    key: "begin",
    get: function get() {
      return this._begin.readPointer();
    },
    set: function set(value) {
      this._begin.writePointer(value);
    }
  }, {
    key: "end",
    get: function get() {
      return this._end.readPointer();
    },
    set: function set(value) {
      this._end.writePointer(value);
    }
  }, {
    key: "storage",
    get: function get() {
      return this._storage.readPointer();
    },
    set: function set(value) {
      this._storage.writePointer(value);
    }
  }, {
    key: "size",
    get: function get() {
      return this.end.sub(this.begin).toInt32() / this._elementSize;
    }
  }]);
  return StdVector;
}();

var HandleVector =
/*#__PURE__*/
function (_StdVector) {
  (0, _inherits2["default"])(HandleVector, _StdVector);
  (0, _createClass2["default"])(HandleVector, null, [{
    key: "$new",
    value: function $new() {
      var vector = new HandleVector(getApi().$new(STD_VECTOR_SIZE));
      vector.init();
      return vector;
    }
  }]);

  function HandleVector(storage) {
    (0, _classCallCheck2["default"])(this, HandleVector);
    return (0, _possibleConstructorReturn2["default"])(this, (0, _getPrototypeOf2["default"])(HandleVector).call(this, storage, pointerSize));
  }

  (0, _createClass2["default"])(HandleVector, [{
    key: "handles",
    get: function get() {
      var result = [];
      var cur = this.begin;
      var end = this.end;

      while (!cur.equals(end)) {
        result.push(cur.readPointer());
        cur = cur.add(pointerSize);
      }

      return result;
    }
  }]);
  return HandleVector;
}(StdVector);

module.exports = {
  getApi: getApi,
  ensureClassInitialized: ensureClassInitialized,
  getAndroidVersion: getAndroidVersion,
  getAndroidApiLevel: getAndroidApiLevel,
  getArtMethodSpec: getArtMethodSpec,
  getArtThreadSpec: getArtThreadSpec,
  getArtThreadFromEnv: getArtThreadFromEnv,
  withRunnableArtThread: withRunnableArtThread,
  withAllArtThreadsSuspended: withAllArtThreadsSuspended,
  makeArtClassVisitor: makeArtClassVisitor,
  makeArtClassLoaderVisitor: makeArtClassLoaderVisitor,
  ArtStackVisitor: ArtStackVisitor,
  ArtMethod: ArtMethod,
  notifyArtMethodHooked: notifyArtMethodHooked,
  cloneArtMethod: cloneArtMethod,
  HandleVector: HandleVector,
  deoptimizeEverything: deoptimizeEverything
};
/* global Memory, Module, NativeCallback, NativeFunction, NULL, Process */

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./result":7,"./vm":8,"@babel/runtime-corejs2/core-js/object/keys":23,"@babel/runtime-corejs2/core-js/parse-int":25,"@babel/runtime-corejs2/core-js/set":29,"@babel/runtime-corejs2/helpers/classCallCheck":38,"@babel/runtime-corejs2/helpers/construct":39,"@babel/runtime-corejs2/helpers/createClass":40,"@babel/runtime-corejs2/helpers/getPrototypeOf":42,"@babel/runtime-corejs2/helpers/inherits":43,"@babel/runtime-corejs2/helpers/interopRequireDefault":44,"@babel/runtime-corejs2/helpers/possibleConstructorReturn":49,"@babel/runtime-corejs2/helpers/slicedToArray":51,"@babel/runtime-corejs2/regenerator":55}],3:[function(require,module,exports){
"use strict";

module.exports = require('./android').getApi;

},{"./android":2}],4:[function(require,module,exports){
"use strict";

var _interopRequireDefault = require("@babel/runtime-corejs2/helpers/interopRequireDefault");

var _parseInt2 = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/parse-int"));

var _typeof2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/typeof"));

var _isInteger = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/number/is-integer"));

var _construct2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/construct"));

var _assign = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/assign"));

var _isArray = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/array/is-array"));

var _toConsumableArray2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/toConsumableArray"));

var _getPrototypeOf2 = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/get-prototype-of"));

var _getOwnPropertyNames = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/get-own-property-names"));

var _defineProperties = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/define-properties"));

var _keys = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/keys"));

var _slicedToArray2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/slicedToArray"));

var _possibleConstructorReturn2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/possibleConstructorReturn"));

var _getPrototypeOf3 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/getPrototypeOf"));

var _get2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/get"));

var _inherits2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/inherits"));

var _classCallCheck2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/classCallCheck"));

var _createClass2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/createClass"));

var _getIterator2 = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/get-iterator"));

var _defineProperty = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/define-property"));

var _from = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/array/from"));

var _symbol = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/symbol"));

var _set = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/set"));

var Env = require('./env'); // eslint-disable-line


var getApi = require('./api');

var _require = require('./android'),
    ensureClassInitialized = _require.ensureClassInitialized,
    getAndroidApiLevel = _require.getAndroidApiLevel,
    getAndroidVersion = _require.getAndroidVersion,
    getArtMethodSpec = _require.getArtMethodSpec,
    getArtThreadSpec = _require.getArtThreadSpec,
    withRunnableArtThread = _require.withRunnableArtThread,
    notifyArtMethodHooked = _require.notifyArtMethodHooked,
    cloneArtMethod = _require.cloneArtMethod,
    HandleVector = _require.HandleVector;

var mkdex = require('./mkdex');

var _require2 = require('./result'),
    JNI_OK = _require2.JNI_OK;

var pointerSize = Process.pointerSize;
var CONSTRUCTOR_METHOD = 1;
var STATIC_METHOD = 2;
var INSTANCE_METHOD = 3;
var STATIC_FIELD = 1;
var INSTANCE_FIELD = 2;
var DVM_JNI_ENV_OFFSET_SELF = 12;
var DVM_CLASS_OBJECT_OFFSET_VTABLE_COUNT = 112;
var DVM_CLASS_OBJECT_OFFSET_VTABLE = 116;
var DVM_OBJECT_OFFSET_CLAZZ = 0;
var DVM_METHOD_SIZE = 56;
var DVM_METHOD_OFFSET_ACCESS_FLAGS = 4;
var DVM_METHOD_OFFSET_METHOD_INDEX = 8;
var DVM_METHOD_OFFSET_REGISTERS_SIZE = 10;
var DVM_METHOD_OFFSET_OUTS_SIZE = 12;
var DVM_METHOD_OFFSET_INS_SIZE = 14;
var DVM_METHOD_OFFSET_SHORTY = 28;
var DVM_METHOD_OFFSET_JNI_ARG_INFO = 36;
var DALVIK_JNI_RETURN_VOID = 0;
var DALVIK_JNI_RETURN_FLOAT = 1;
var DALVIK_JNI_RETURN_DOUBLE = 2;
var DALVIK_JNI_RETURN_S8 = 3;
var DALVIK_JNI_RETURN_S4 = 4;
var DALVIK_JNI_RETURN_S2 = 5;
var DALVIK_JNI_RETURN_U2 = 6;
var DALVIK_JNI_RETURN_S1 = 7;
var DALVIK_JNI_NO_ARG_INFO = 0x80000000;
var DALVIK_JNI_RETURN_MASK = 0x70000000;
var DALVIK_JNI_RETURN_SHIFT = 28;
var DALVIK_JNI_COUNT_MASK = 0x0f000000;
var DALVIK_JNI_COUNT_SHIFT = 24;
var kAccNative = 0x0100;
var kAccFastNative = 0x00080000;
var kAccXposedHookedMethod = 0x10000000;
var JNILocalRefType = 1;

function ClassFactory(vm) {
  var factory = this;
  var api = null;
  var classes = {};
  var classes_loaders = {};
  var patchedClasses = {};
  var patchedMethods = new _set["default"]();
  var ignoredThreads = {};
  var xposedIsSupported = getAndroidApiLevel() < 28;
  var loader = null;
  var cachedLoaderInvoke = null;
  var cachedLoaderMethod = null;
  var cacheDir = '/data/local/tmp';
  var tempFileNaming = {
    prefix: 'frida',
    suffix: 'dat'
  };
  var PENDING_CALLS = (0, _symbol["default"])('PENDING_CALLS');
  var PENDING_USE = (0, _symbol["default"])('PENDING_USE');

  function initialize() {
    api = getApi();
  }

  this.dispose = function (env) {
    (0, _from["default"])(patchedMethods).forEach(function (method) {
      method.implementation = null;
    });
    patchedMethods.clear();

    for (var entryId in patchedClasses) {
      if (patchedClasses.hasOwnProperty(entryId)) {
        var entry = patchedClasses[entryId];
        entry.vtablePtr.writePointer(entry.vtable);
        entry.vtableCountPtr.writeS32(entry.vtableCount);
        var targetMethods = entry.targetMethods;

        for (var methodId in targetMethods) {
          if (targetMethods.hasOwnProperty(methodId)) {
            targetMethods[methodId].implementation = null;
            delete targetMethods[methodId];
          }
        }

        delete patchedClasses[entryId];
      }
    }

    classes = {};
    classes_loaders = {};
  };

  (0, _defineProperty["default"])(this, 'classes_loaders', {
    enumerable: true,
    get: function get() {
      return classes_loaders;
    },
    set: function set(value) {
      classes_loaders = value;
    }
  });
  (0, _defineProperty["default"])(this, 'loader', {
    enumerable: true,
    get: function get() {
      return loader;
    },
    set: function set(value) {
      loader = value;
    }
  });
  (0, _defineProperty["default"])(this, 'cacheDir', {
    enumerable: true,
    get: function get() {
      return cacheDir;
    },
    set: function set(value) {
      cacheDir = value;
    }
  });
  (0, _defineProperty["default"])(this, 'tempFileNaming', {
    enumerable: true,
    get: function get() {
      return tempFileNaming;
    },
    set: function set(value) {
      tempFileNaming = value;
    }
  });

  this.use = function (className) {
    var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
    var allowCached = options.cache !== 'skip';
    var useLoaderCache = options.useLoaderCache === "enable";
    var C = undefined;

    if (useLoaderCache && loader !== null) {
      C = allowCached ? getUsedClassWithLoader(className, loader.hashCode()) : undefined;
    } else {
      C = allowCached ? getUsedClass(className) : undefined;
    }

    if (C === undefined) {
      var env = vm.getEnv();

      if (loader !== null) {
        var usedLoader = loader;

        if (cachedLoaderMethod === null) {
          cachedLoaderInvoke = env.vaMethod('pointer', ['pointer']);
          cachedLoaderMethod = loader.loadClass.overload('java.lang.String').handle;
        }

        var getClassHandle = function getClassHandle(env) {
          var classNameValue = env.newStringUtf(className);
          var tid = Process.getCurrentThreadId();
          ignore(tid);

          try {
            return cachedLoaderInvoke(env.handle, usedLoader.$handle, cachedLoaderMethod, classNameValue);
          } finally {
            unignore(tid);
            env.deleteLocalRef(classNameValue);
          }
        };

        try {
          C = ensureClass(getClassHandle, className);
        } finally {
          if (allowCached) {
            setUsedClass(className, C);

            if (useLoaderCache) {
              setUsedClassWithLoader(className, C, loader.hashCode());
            }
          }
        }
      } else {
        var canonicalClassName = className.replace(/\./g, '/');

        var _getClassHandle = function _getClassHandle(env) {
          var tid = Process.getCurrentThreadId();
          ignore(tid);

          try {
            return env.findClass(canonicalClassName);
          } finally {
            unignore(tid);
          }
        };

        try {
          C = ensureClass(_getClassHandle, className);
        } finally {
          if (allowCached) {
            setUsedClass(className, C);
          }
        }
      }
    }

    return new C(null);
  };

  function getUsedClass(className) {
    var kclass;

    while ((kclass = classes[className]) === PENDING_USE) {
      Thread.sleep(0.05);
    }

    if (kclass === undefined) {
      classes[className] = PENDING_USE;
    }

    return kclass;
  }

  function getUsedClassWithLoader(className, classLoaderHash) {
    var kclass;

    while ((kclass = classes_loaders[className] === undefined ? undefined : classes_loaders[className][classLoaderHash]) === PENDING_USE) {
      Thread.sleep(0.05);
    }

    if (kclass === undefined) {
      classes_loaders[className] = classes_loaders[className] === undefined ? {} : classes_loaders[className];
      classes_loaders[className][classLoaderHash] = PENDING_USE;
    }

    return kclass;
  }

  function setUsedClass(className, kclass) {
    if (kclass !== undefined) {
      classes[className] = kclass;
    } else {
      delete classes[className];
    }
  }

  function setUsedClassWithLoader(className, kclass, classLoaderHash) {
    if (kclass !== undefined) {
      if (classes_loaders[className] === undefined) {
        classes_loaders[className] = {
          classLoaderHash: kclass
        };
      } else {
        classes_loaders[className][classLoaderHash] = kclass;
      }
    } else {
      if (classes_loaders[className] != undefined) {
        delete classes_loaders[className][classLoaderHash];
      }
    }
  }

  function DexFile(path) {
    var file = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
    this.path = path;
    this.file = file;
  }

  DexFile.fromBuffer = function (buffer) {
    var fileValue = createTemporaryDex();
    var filePath = fileValue.getCanonicalPath().toString();
    var file = new File(filePath, 'w');
    file.write(buffer.buffer);
    file.close();
    return new DexFile(filePath, fileValue);
  };

  DexFile.prototype = {
    load: function load() {
      var DexClassLoader = factory.use('dalvik.system.DexClassLoader');
      var file = this.file;

      if (file === null) {
        file = factory.use('java.io.File').$new(this.path);
      }

      if (!file.exists()) {
        throw new Error('File not found');
      }

      loader = DexClassLoader.$new(file.getCanonicalPath(), cacheDir, null, loader);
      vm.preventDetachDueToClassLoader();
    },
    getClassNames: function getClassNames() {
      var DexFile = factory.use('dalvik.system.DexFile');
      var optimizedDex = createTemporaryDex();
      var dx = DexFile.loadDex(this.path, optimizedDex.getCanonicalPath(), 0);
      var classNames = [];
      var enumeratorClassNames = dx.entries();

      while (enumeratorClassNames.hasMoreElements()) {
        classNames.push(enumeratorClassNames.nextElement().toString());
      }

      return classNames;
    }
  };

  function createTemporaryDex() {
    var JFile = factory.use('java.io.File');
    var cacheDirValue = JFile.$new(cacheDir);
    cacheDirValue.mkdirs();
    return JFile.createTempFile(tempFileNaming.prefix, tempFileNaming.suffix, cacheDirValue);
  }

  this.openClassFile = function (filePath) {
    return new DexFile(filePath);
  };

  this.choose = function (specifier, callbacks) {
    if (api.flavor === 'art') {
      var env = vm.getEnv();
      withRunnableArtThread(vm, env, function (thread) {
        if (api['art::gc::Heap::VisitObjects'] === undefined) {
          chooseObjectsArtModern(env, thread, specifier, callbacks);
        } else {
          chooseObjectsArtLegacy(env, thread, specifier, callbacks);
        }
      });
    } else {
      chooseObjectsDalvik(specifier, callbacks);
    }
  };

  function chooseObjectsArtModern(env, thread, className, callbacks) {
    var klass = factory.use(className);
    var scope = VariableSizedHandleScope.$new(thread);
    var localClassHandle = klass.$getClassHandle(env);
    var globalClassHandle = env.newGlobalRef(localClassHandle);
    var object = api['art::JavaVMExt::DecodeGlobal'](api.vm, thread, globalClassHandle);
    var needle = scope.newHandle(object);
    env.deleteGlobalRef(globalClassHandle);
    env.deleteLocalRef(localClassHandle);
    var maxCount = 0;
    var instances = HandleVector.$new();
    api['art::gc::Heap::GetInstances'](api.artHeap, scope, needle, maxCount, instances);
    var instanceHandles = instances.handles.map(function (handle) {
      return env.newGlobalRef(handle);
    });
    instances.$delete();
    scope.$delete();

    try {
      var _iteratorNormalCompletion = true;
      var _didIteratorError = false;
      var _iteratorError = undefined;

      try {
        for (var _iterator = (0, _getIterator2["default"])(instanceHandles), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
          var handle = _step.value;
          var instance = factory.cast(handle, klass);
          var result = callbacks.onMatch(instance);

          if (result === 'stop') {
            break;
          }
        }
      } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion && _iterator["return"] != null) {
            _iterator["return"]();
          }
        } finally {
          if (_didIteratorError) {
            throw _iteratorError;
          }
        }
      }

      callbacks.onComplete();
    } finally {
      instanceHandles.forEach(function (handle) {
        env.deleteGlobalRef(handle);
      });
    }
  }

  var BHS_OFFSET_LINK = 0;
  var BHS_OFFSET_NUM_REFS = pointerSize;
  var BHS_SIZE = BHS_OFFSET_NUM_REFS + 4;
  var kNumReferencesVariableSized = -1;

  var BaseHandleScope =
  /*#__PURE__*/
  function () {
    (0, _createClass2["default"])(BaseHandleScope, [{
      key: "$delete",
      value: function $delete() {
        this.dispose();
        api.$delete(this);
      }
    }]);

    function BaseHandleScope(storage) {
      (0, _classCallCheck2["default"])(this, BaseHandleScope);
      this.handle = storage;
      this._link = storage.add(BHS_OFFSET_LINK);
      this._numberOfReferences = storage.add(BHS_OFFSET_NUM_REFS);
    }

    (0, _createClass2["default"])(BaseHandleScope, [{
      key: "init",
      value: function init(link, numberOfReferences) {
        this.link = link;
        this.numberOfReferences = numberOfReferences;
      }
    }, {
      key: "dispose",
      value: function dispose() {}
    }, {
      key: "link",
      get: function get() {
        return new BaseHandleScope(this._link.readPointer());
      },
      set: function set(value) {
        this._link.writePointer(value);
      }
    }, {
      key: "numberOfReferences",
      get: function get() {
        return this._numberOfReferences.readS32();
      },
      set: function set(value) {
        this._numberOfReferences.writeS32(value);
      }
    }]);
    return BaseHandleScope;
  }();

  var VSHS_OFFSET_SELF = alignPointerOffset(BHS_SIZE);
  var VSHS_OFFSET_CURRENT_SCOPE = VSHS_OFFSET_SELF + pointerSize;
  var VSHS_SIZE = VSHS_OFFSET_CURRENT_SCOPE + pointerSize;

  var VariableSizedHandleScope =
  /*#__PURE__*/
  function (_BaseHandleScope) {
    (0, _inherits2["default"])(VariableSizedHandleScope, _BaseHandleScope);
    (0, _createClass2["default"])(VariableSizedHandleScope, null, [{
      key: "$new",
      value: function $new(thread) {
        var scope = new VariableSizedHandleScope(api.$new(VSHS_SIZE));
        scope.init(thread);
        return scope;
      }
    }]);

    function VariableSizedHandleScope(storage) {
      var _this;

      (0, _classCallCheck2["default"])(this, VariableSizedHandleScope);
      _this = (0, _possibleConstructorReturn2["default"])(this, (0, _getPrototypeOf3["default"])(VariableSizedHandleScope).call(this, storage));
      _this._self = storage.add(VSHS_OFFSET_SELF);
      _this._currentScope = storage.add(VSHS_OFFSET_CURRENT_SCOPE);
      var kLocalScopeSize = 64;
      var kSizeOfReferencesPerScope = kLocalScopeSize - pointerSize - 4 - 4;
      var kNumReferencesPerScope = kSizeOfReferencesPerScope / 4;
      _this._scopeLayout = FixedSizeHandleScope.layoutForCapacity(kNumReferencesPerScope);
      _this._topHandleScopePtr = null;
      return _this;
    }

    (0, _createClass2["default"])(VariableSizedHandleScope, [{
      key: "init",
      value: function init(thread) {
        var topHandleScopePtr = thread.add(getArtThreadSpec(vm).offset.topHandleScope);
        this._topHandleScopePtr = topHandleScopePtr;
        (0, _get2["default"])((0, _getPrototypeOf3["default"])(VariableSizedHandleScope.prototype), "init", this).call(this, topHandleScopePtr.readPointer(), kNumReferencesVariableSized);
        this.self = thread;
        this.currentScope = FixedSizeHandleScope.$new(this._scopeLayout);
        topHandleScopePtr.writePointer(this);
      }
    }, {
      key: "dispose",
      value: function dispose() {
        this._topHandleScopePtr.writePointer(this.link);

        var scope;

        while ((scope = this.currentScope) !== null) {
          var next = scope.link;
          scope.$delete();
          this.currentScope = next;
        }
      }
    }, {
      key: "newHandle",
      value: function newHandle(object) {
        return this.currentScope.newHandle(object);
      }
    }, {
      key: "self",
      get: function get() {
        return this._self.readPointer();
      },
      set: function set(value) {
        this._self.writePointer(value);
      }
    }, {
      key: "currentScope",
      get: function get() {
        var storage = this._currentScope.readPointer();

        if (storage.isNull()) {
          return null;
        }

        return new FixedSizeHandleScope(storage, this._scopeLayout);
      },
      set: function set(value) {
        this._currentScope.writePointer(value);
      }
    }]);
    return VariableSizedHandleScope;
  }(BaseHandleScope);

  var FixedSizeHandleScope =
  /*#__PURE__*/
  function (_BaseHandleScope2) {
    (0, _inherits2["default"])(FixedSizeHandleScope, _BaseHandleScope2);
    (0, _createClass2["default"])(FixedSizeHandleScope, null, [{
      key: "$new",
      value: function $new(layout) {
        var scope = new FixedSizeHandleScope(api.$new(layout.size), layout);
        scope.init();
        return scope;
      }
    }]);

    function FixedSizeHandleScope(storage, layout) {
      var _this2;

      (0, _classCallCheck2["default"])(this, FixedSizeHandleScope);
      _this2 = (0, _possibleConstructorReturn2["default"])(this, (0, _getPrototypeOf3["default"])(FixedSizeHandleScope).call(this, storage));
      var offset = layout.offset;
      _this2._refsStorage = storage.add(offset.refsStorage);
      _this2._pos = storage.add(offset.pos);
      _this2._layout = layout;
      return _this2;
    }

    (0, _createClass2["default"])(FixedSizeHandleScope, [{
      key: "init",
      value: function init() {
        (0, _get2["default"])((0, _getPrototypeOf3["default"])(FixedSizeHandleScope.prototype), "init", this).call(this, NULL, this._layout.numberOfReferences);
        this.pos = 0;
      }
    }, {
      key: "newHandle",
      value: function newHandle(object) {
        var pos = this.pos;

        var handle = this._refsStorage.add(pos * 4);

        handle.writeS32(object.toInt32());
        this.pos = pos + 1;
        return handle;
      }
    }, {
      key: "pos",
      get: function get() {
        return this._pos.readU32();
      },
      set: function set(value) {
        this._pos.writeU32(value);
      }
    }], [{
      key: "layoutForCapacity",
      value: function layoutForCapacity(numRefs) {
        var refsStorage = BHS_SIZE;
        var pos = refsStorage + numRefs * 4;
        return {
          size: pos + 4,
          numberOfReferences: numRefs,
          offset: {
            refsStorage: refsStorage,
            pos: pos
          }
        };
      }
    }]);
    return FixedSizeHandleScope;
  }(BaseHandleScope);

  function chooseObjectsArtLegacy(env, thread, className, callbacks) {
    var klass = factory.use(className);
    var instanceHandles = [];
    var addGlobalReference = api['art::JavaVMExt::AddGlobalRef'];
    var vmHandle = api.vm;
    var localClassHandle = klass.$getClassHandle(env);
    var globalClassHandle = env.newGlobalRef(localClassHandle);
    var needle = api['art::JavaVMExt::DecodeGlobal'](api.vm, thread, globalClassHandle).toInt32();
    env.deleteGlobalRef(globalClassHandle);
    env.deleteLocalRef(localClassHandle);
    var collectMatchingInstanceHandles = makeObjectVisitorPredicate(needle, function (object) {
      instanceHandles.push(addGlobalReference(vmHandle, thread, object));
    });
    api['art::gc::Heap::VisitObjects'](api.artHeap, collectMatchingInstanceHandles, NULL);

    try {
      for (var _i = 0, _instanceHandles = instanceHandles; _i < _instanceHandles.length; _i++) {
        var handle = _instanceHandles[_i];
        var instance = factory.cast(handle, klass);
        var result = callbacks.onMatch(instance);

        if (result === 'stop') {
          break;
        }
      }
    } finally {
      instanceHandles.forEach(function (handle) {
        env.deleteGlobalRef(handle);
      });
    }

    callbacks.onComplete();
  }

  var objectVisitorPredicateFactories = {
    arm: function arm(needle, onMatch) {
      var size = Process.pageSize;
      var predicate = Memory.alloc(size);
      Memory.protect(predicate, size, 'rwx');
      var onMatchCallback = new NativeCallback(onMatch, 'void', ['pointer']);
      predicate._onMatchCallback = onMatchCallback;
      var instructions = [0x6801, // ldr r1, [r0]
      0x4a03, // ldr r2, =needle
      0x4291, // cmp r1, r2
      0xd101, // bne mismatch
      0x4b02, // ldr r3, =onMatch
      0x4718, // bx r3
      0x4770, // bx lr
      0xbf00 // nop
      ];
      var needleOffset = instructions.length * 2;
      var onMatchOffset = needleOffset + 4;
      var codeSize = onMatchOffset + 4;
      Memory.patchCode(predicate, codeSize, function (address) {
        instructions.forEach(function (instruction, index) {
          address.add(index * 2).writeU16(instruction);
        });
        address.add(needleOffset).writeS32(needle);
        address.add(onMatchOffset).writePointer(onMatchCallback);
      });
      return predicate.or(1);
    },
    arm64: function arm64(needle, onMatch) {
      var size = Process.pageSize;
      var predicate = Memory.alloc(size);
      Memory.protect(predicate, size, 'rwx');
      var onMatchCallback = new NativeCallback(onMatch, 'void', ['pointer']);
      predicate._onMatchCallback = onMatchCallback;
      var instructions = [0xb9400001, // ldr w1, [x0]
      0x180000c2, // ldr w2, =needle
      0x6b02003f, // cmp w1, w2
      0x54000061, // b.ne mismatch
      0x58000083, // ldr x3, =onMatch
      0xd61f0060, // br x3
      0xd65f03c0 // ret
      ];
      var needleOffset = instructions.length * 4;
      var onMatchOffset = needleOffset + 4;
      var codeSize = onMatchOffset + 8;
      Memory.patchCode(predicate, codeSize, function (address) {
        instructions.forEach(function (instruction, index) {
          address.add(index * 4).writeU32(instruction);
        });
        address.add(needleOffset).writeS32(needle);
        address.add(onMatchOffset).writePointer(onMatchCallback);
      });
      return predicate;
    }
  };

  function makeObjectVisitorPredicate(needle, onMatch) {
    var factory = objectVisitorPredicateFactories[Process.arch] || makeGenericObjectVisitorPredicate;
    return factory(needle, onMatch);
  }

  function makeGenericObjectVisitorPredicate(needle, onMatch) {
    return new NativeCallback(function (object) {
      var klass = object.readS32();

      if (klass === needle) {
        onMatch(object);
      }
    }, 'void', ['pointer', 'pointer']);
  }

  function chooseObjectsDalvik(className, callbacks) {
    var klass = factory.use(className);

    var enumerateInstances = function enumerateInstances(className, callbacks) {
      var env = vm.getEnv();
      var thread = env.handle.add(DVM_JNI_ENV_OFFSET_SELF).readPointer();
      var classHandle = klass.$getClassHandle(env);
      var ptrClassObject = api.dvmDecodeIndirectRef(thread, classHandle);
      env.deleteLocalRef(classHandle);
      var pattern = ptrClassObject.toMatchPattern();
      var heapSourceBase = api.dvmHeapSourceGetBase();
      var heapSourceLimit = api.dvmHeapSourceGetLimit();
      var size = heapSourceLimit.sub(heapSourceBase).toInt32();
      Memory.scan(heapSourceBase, size, pattern, {
        onMatch: function onMatch(address, size) {
          if (api.dvmIsValidObject(address)) {
            vm.perform(function () {
              var env = vm.getEnv();
              var thread = env.handle.add(DVM_JNI_ENV_OFFSET_SELF).readPointer();
              var instance;
              var localReference = api.addLocalReference(thread, address);

              try {
                instance = factory.cast(localReference, klass);
              } finally {
                env.deleteLocalRef(localReference);
              }

              var result = callbacks.onMatch(instance);

              if (result === 'stop') {
                return 'stop';
              }
            });
          }
        },
        onError: function onError(reason) {},
        onComplete: function onComplete() {
          callbacks.onComplete();
        }
      });
    };

    if (api.addLocalReference === null) {
      var libdvm = Process.getModuleByName('libdvm.so');
      var pattern;

      if (getAndroidVersion(factory).indexOf('4.2.') === 0) {
        // Verified with 4.2.2
        pattern = 'F8 B5 06 46 0C 46 31 B3 43 68 00 F1 A8 07 22 46';
      } else {
        // Verified with 4.3.1 and 4.4.4
        pattern = '2D E9 F0 41 05 46 15 4E 0C 46 7E 44 11 B3 43 68';
      }

      Memory.scan(libdvm.base, libdvm.size, pattern, {
        onMatch: function onMatch(address, size) {
          if (Process.arch === 'arm') {
            address = address.or(1); // Thumb
          }

          api.addLocalReference = new NativeFunction(address, 'pointer', ['pointer', 'pointer']);
          vm.perform(function () {
            enumerateInstances(className, callbacks);
          });
          return 'stop';
        },
        onError: function onError(reason) {},
        onComplete: function onComplete() {}
      });
    } else {
      enumerateInstances(className, callbacks);
    }
  }

  this.retain = function (obj) {
    var C = obj.$classWrapper;
    return new C(obj.$handle);
  };

  this.cast = function (obj, klass) {
    var env = vm.getEnv();
    var handle = obj.hasOwnProperty('$handle') ? obj.$handle : obj;
    var classHandle = klass.$getClassHandle(env);

    try {
      var isValidCast = env.isInstanceOf(handle, classHandle);

      if (!isValidCast) {
        throw new Error("Cast from '" + env.getObjectClassName(handle) + "' to '" + env.getClassName(classHandle) + "' isn't possible");
      }
    } finally {
      env.deleteLocalRef(classHandle);
    }

    var C = klass.$classWrapper;
    return new C(handle);
  };

  this.array = function (type, elements) {
    var env = vm.getEnv();
    var primitiveType = getPrimitiveType(type);

    if (primitiveType !== undefined) {
      type = primitiveType.name;
    }

    var arrayType = getArrayType('[' + type, false, this);
    var rawArray = arrayType.toJni(elements, env);
    return arrayType.fromJni(rawArray, env);
  };

  this.registerClass = registerClass;

  function ensureClass(getClassHandle, name) {
    var env = vm.getEnv();
    var classHandle = getClassHandle(env);
    env.checkForExceptionAndThrowIt();
    var superKlass;
    var superHandle = env.getSuperclass(classHandle);

    if (!superHandle.isNull()) {
      var getSuperClassHandle = function getSuperClassHandle(env) {
        var classHandle = getClassHandle(env);
        var superHandle = env.getSuperclass(classHandle);
        env.deleteLocalRef(classHandle);
        return superHandle;
      };

      var superClassName = env.getClassName(superHandle);
      superKlass = getUsedClass(superClassName);

      if (superKlass === undefined) {
        try {
          superKlass = ensureClass(getSuperClassHandle, superClassName);
        } finally {
          setUsedClass(superClassName, superKlass);
          env.deleteLocalRef(superHandle);
        }
      }
    } else {
      superKlass = null;
    }

    superHandle = null;
    ensureClassInitialized(env, classHandle);
    var klass;
    eval('klass = function (handle) {' + // eslint-disable-line
    'var env = vm.getEnv();' + 'this.$classWrapper = klass;' + 'this.$getClassHandle = getClassHandle;' + 'if (handle !== null) {' + '  this.$handle = env.newGlobalRef(handle);' + '  this.$weakRef = WeakRef.bind(this, makeHandleDestructor(vm, this.$handle));' + '}' + '};');
    (0, _defineProperty["default"])(klass, 'className', {
      enumerable: true,
      value: basename(name)
    });

    function initializeClass() {
      klass.__name__ = name;
      var ctor = null;

      var getCtor = function getCtor(type) {
        if (ctor === null) {
          vm.perform(function () {
            var env = vm.getEnv();
            var classHandle = getClassHandle(env);

            try {
              ctor = makeConstructor(classHandle, env);
            } finally {
              env.deleteLocalRef(classHandle);
            }
          });
        }

        if (!ctor[type]) throw new Error('assertion !ctor[type] failed');
        return ctor[type];
      };

      (0, _defineProperty["default"])(klass.prototype, '$new', {
        get: function get() {
          return getCtor('allocAndInit');
        }
      });
      (0, _defineProperty["default"])(klass.prototype, '$alloc', {
        get: function get() {
          return function () {
            var env = vm.getEnv();
            var classHandle = this.$getClassHandle(env);

            try {
              var obj = env.allocObject(classHandle);
              return factory.cast(obj, this);
            } finally {
              env.deleteLocalRef(classHandle);
            }
          };
        }
      });
      (0, _defineProperty["default"])(klass.prototype, '$init', {
        get: function get() {
          return getCtor('initOnly');
        }
      });
      klass.prototype.$dispose = dispose;

      klass.prototype.$isSameObject = function (obj) {
        var env = vm.getEnv();
        return env.isSameObject(obj.$handle, this.$handle);
      };

      (0, _defineProperty["default"])(klass.prototype, 'class', {
        get: function get() {
          var env = vm.getEnv();
          var classHandle = this.$getClassHandle(env);

          try {
            return factory.cast(classHandle, factory.use('java.lang.Class'));
          } finally {
            env.deleteLocalRef(classHandle);
          }
        }
      });
      (0, _defineProperty["default"])(klass.prototype, '$className', {
        get: function get() {
          var env = vm.getEnv();
          var handle = this.$handle;
          if (handle !== undefined) return env.getObjectClassName(this.$handle);
          var classHandle = this.$getClassHandle(env);

          try {
            return env.getClassName(classHandle);
          } finally {
            env.deleteLocalRef(classHandle);
          }
        }
      });
      addMethodsAndFields();
    }

    function dispose() {
      /* jshint validthis: true */
      var ref = this.$weakRef;

      if (ref !== undefined) {
        delete this.$weakRef;
        WeakRef.unbind(ref);
      }
    }

    function makeConstructor(classHandle, env) {
      var Constructor = env.javaLangReflectConstructor();
      var invokeObjectMethodNoArgs = env.vaMethod('pointer', []);
      var jsCtorMethods = [];
      var jsInitMethods = [];
      var jsRetType = getTypeFromJniTypeName(name, false);
      var jsVoidType = getTypeFromJniTypeName('void', false);
      var constructors = invokeObjectMethodNoArgs(env.handle, classHandle, env.javaLangClass().getDeclaredConstructors);

      try {
        var numConstructors = env.getArrayLength(constructors);

        for (var constructorIndex = 0; constructorIndex !== numConstructors; constructorIndex++) {
          var _constructor = env.getObjectArrayElement(constructors, constructorIndex);

          try {
            var methodId = env.fromReflectedMethod(_constructor);
            var types = invokeObjectMethodNoArgs(env.handle, _constructor, Constructor.getGenericParameterTypes);
            var jsArgTypes = readTypeNames(env, types).map(function (name) {
              return getTypeFromJniTypeName(name);
            });
            env.deleteLocalRef(types);
            jsCtorMethods.push(makeMethod(basename(name), CONSTRUCTOR_METHOD, methodId, jsRetType, jsArgTypes, env));
            jsInitMethods.push(makeMethod(basename(name), INSTANCE_METHOD, methodId, jsVoidType, jsArgTypes, env));
          } finally {
            env.deleteLocalRef(_constructor);
          }
        }
      } finally {
        env.deleteLocalRef(constructors);
      }

      if (jsInitMethods.length === 0) {
        throw new Error('no supported overloads');
      }

      return {
        'allocAndInit': makeMethodDispatcher('<init>', jsCtorMethods),
        'initOnly': makeMethodDispatcher('<init>', jsInitMethods)
      };
    }

    function makeField(name, params, classHandle, env) {
      var invokeObjectMethodNoArgs = env.vaMethod('pointer', []);

      var _env$javaLangReflectF = env.javaLangReflectField(),
          getGenericType = _env$javaLangReflectF.getGenericType;

      var _params = (0, _slicedToArray2["default"])(params, 2),
          fieldId = _params[0],
          jsType = _params[1];

      var jsFieldType;
      var isStatic = jsType === STATIC_FIELD ? 1 : 0;
      var handle = env.toReflectedField(classHandle, fieldId, isStatic);

      try {
        var fieldType = invokeObjectMethodNoArgs(env.handle, handle, getGenericType);

        try {
          jsFieldType = getTypeFromJniTypeName(env.getTypeName(fieldType));
        } finally {
          env.deleteLocalRef(fieldType);
        }
      } catch (e) {
        return null;
      } finally {
        env.deleteLocalRef(handle);
      }

      return createField(name, jsType, fieldId, jsFieldType, env);
    }

    function createField(name, type, targetFieldId, fieldType, env) {
      var rawFieldType = fieldType.type;
      var invokeTarget = null; // eslint-disable-line

      if (type === STATIC_FIELD) {
        invokeTarget = env.getStaticField(rawFieldType);
      } else if (type === INSTANCE_FIELD) {
        invokeTarget = env.getField(rawFieldType);
      }

      var frameCapacity = 3;
      var callArgs = ['env.handle', type === INSTANCE_FIELD ? 'this.$handle' : 'this.$getClassHandle(env)', 'targetFieldId'];
      var returnCapture, returnStatements;

      if (fieldType.fromJni) {
        frameCapacity++;
        returnCapture = 'rawResult = ';
        returnStatements = 'try {' + 'result = fieldType.fromJni.call(this, rawResult, env);' + '} finally {' + 'env.popLocalFrame(NULL);' + '} ' + 'return result;';
      } else {
        returnCapture = 'result = ';
        returnStatements = 'env.popLocalFrame(NULL);' + 'return result;';
      }

      var getter;
      eval('getter = function () {' + // eslint-disable-line
      'var isInstance = this.$handle !== undefined;' + 'if (type === INSTANCE_FIELD && !isInstance) { ' + "throw new Error('getter of ' + name + ': cannot get an instance field without an instance.');" + '}' + 'var env = vm.getEnv();' + 'if (env.pushLocalFrame(' + frameCapacity + ') !== JNI_OK) {' + 'env.exceptionClear();' + 'throw new Error("Out of memory");' + '}' + 'var result, rawResult;' + 'try {' + returnCapture + 'invokeTarget(' + callArgs.join(', ') + ');' + '} catch (e) {' + 'env.popLocalFrame(NULL);' + 'throw e;' + '}' + 'try {' + 'env.checkForExceptionAndThrowIt();' + '} catch (e) {' + 'env.popLocalFrame(NULL); ' + 'throw e;' + '}' + returnStatements + '}');
      var setFunction = null; // eslint-disable-line

      if (type === STATIC_FIELD) {
        setFunction = env.setStaticField(rawFieldType);
      } else if (type === INSTANCE_FIELD) {
        setFunction = env.setField(rawFieldType);
      }

      var inputStatement;

      if (fieldType.toJni) {
        inputStatement = 'var input = fieldType.toJni.call(this, value, env);';
      } else {
        inputStatement = 'var input = value;';
      }

      var setter;
      eval('setter = function (value) {' + // eslint-disable-line
      'var isInstance = this.$handle !== undefined;' + 'if (type === INSTANCE_FIELD && !isInstance) { ' + "throw new Error('setter of ' + name + ': cannot set an instance field without an instance');" + '}' + 'if (!fieldType.isCompatible(value)) {' + 'throw new Error(\'Field "\' + name + \'" expected value compatible with ' + fieldType.className + ".');" + '}' + 'var env = vm.getEnv();' + 'if (env.pushLocalFrame(' + frameCapacity + ') !== JNI_OK) {' + 'env.exceptionClear();' + 'throw new Error("Out of memory");' + '}' + 'try {' + inputStatement + 'setFunction(' + callArgs.join(', ') + ', input);' + '} catch (e) {' + 'throw e;' + '} finally {' + 'env.popLocalFrame(NULL);' + '}' + 'env.checkForExceptionAndThrowIt();' + '}');
      var f = {};
      (0, _defineProperty["default"])(f, 'value', {
        enumerable: true,
        get: function get() {
          return getter.call(this.$holder);
        },
        set: function set(value) {
          setter.call(this.$holder, value);
        }
      });
      (0, _defineProperty["default"])(f, 'holder', {
        enumerable: true,
        value: klass
      });
      (0, _defineProperty["default"])(f, 'fieldType', {
        enumerable: true,
        value: type
      });
      (0, _defineProperty["default"])(f, 'fieldReturnType', {
        enumerable: true,
        value: fieldType
      });
      return [f, getter, setter];
    }

    function addMethodsAndFields() {
      var Modifier = env.javaLangReflectModifier();
      var getMethodModifiers = env.javaLangReflectMethod().getModifiers;
      var getFieldModifiers = env.javaLangReflectField().getModifiers;
      var invokeObjectMethodNoArgs = env.vaMethod('pointer', []);
      var invokeIntMethodNoArgs = env.vaMethod('int32', []);
      var methodGetName = env.javaLangReflectMethod().getName;
      var fieldGetName = env.javaLangReflectField().getName;
      var jsMethods = {};
      var jsFields = {};
      var methods = invokeObjectMethodNoArgs(env.handle, classHandle, env.javaLangClass().getDeclaredMethods);

      try {
        var numMethods = env.getArrayLength(methods);

        for (var methodIndex = 0; methodIndex !== numMethods; methodIndex++) {
          var method = env.getObjectArrayElement(methods, methodIndex);

          try {
            var methodName = invokeObjectMethodNoArgs(env.handle, method, methodGetName);

            try {
              var methodJsName = env.stringFromJni(methodName);
              var methodId = env.fromReflectedMethod(method);
              var modifiers = invokeIntMethodNoArgs(env.handle, method, getMethodModifiers);
              var jsOverloads = void 0;

              if (!jsMethods.hasOwnProperty(methodJsName)) {
                jsOverloads = [];
                jsMethods[methodJsName] = jsOverloads;
              } else {
                jsOverloads = jsMethods[methodJsName];
              }

              jsOverloads.push([methodId, modifiers]);
            } finally {
              env.deleteLocalRef(methodName);
            }
          } finally {
            env.deleteLocalRef(method);
          }
        }
      } finally {
        env.deleteLocalRef(methods);
      }

      var fields = invokeObjectMethodNoArgs(env.handle, classHandle, env.javaLangClass().getDeclaredFields);

      try {
        var numFields = env.getArrayLength(fields);

        for (var fieldIndex = 0; fieldIndex !== numFields; fieldIndex++) {
          var field = env.getObjectArrayElement(fields, fieldIndex);

          try {
            var fieldName = invokeObjectMethodNoArgs(env.handle, field, fieldGetName);

            try {
              var fieldJsName = env.stringFromJni(fieldName);

              while (jsMethods.hasOwnProperty(fieldJsName)) {
                fieldJsName = '_' + fieldJsName;
              }

              var fieldId = env.fromReflectedField(field);

              var _modifiers = invokeIntMethodNoArgs(env.handle, field, getFieldModifiers);

              var jsType = (_modifiers & Modifier.STATIC) !== 0 ? STATIC_FIELD : INSTANCE_FIELD;
              jsFields[fieldJsName] = [fieldId, jsType];
            } finally {
              env.deleteLocalRef(fieldName);
            }
          } finally {
            env.deleteLocalRef(field);
          }
        }
      } finally {
        env.deleteLocalRef(fields);
      }

      (0, _keys["default"])(jsMethods).forEach(function (name) {
        var overloads = jsMethods[name];
        var v = null;
        (0, _defineProperty["default"])(klass.prototype, name, {
          get: function get() {
            if (v === null) {
              vm.perform(function () {
                var env = vm.getEnv();
                var classHandle = getClassHandle(env);

                try {
                  v = makeMethodFromOverloads(name, overloads, classHandle, env);
                } finally {
                  env.deleteLocalRef(classHandle);
                }
              });
            }

            return v;
          }
        });
      });
      (0, _keys["default"])(jsFields).forEach(function (name) {
        var params = jsFields[name];
        var jsType = params[1];
        var v = null;
        (0, _defineProperty["default"])(klass.prototype, name, {
          get: function get() {
            var _this3 = this;

            if (v === null) {
              vm.perform(function () {
                var env = vm.getEnv();
                var classHandle = getClassHandle(env);

                try {
                  v = makeField(name, params, classHandle, env);
                } finally {
                  env.deleteLocalRef(classHandle);
                }

                if (jsType === STATIC_FIELD) {
                  v[0].$holder = _this3;
                }
              });
            }

            var _v = v,
                _v2 = (0, _slicedToArray2["default"])(_v, 3),
                protoField = _v2[0],
                getter = _v2[1],
                setter = _v2[2];

            if (jsType === STATIC_FIELD) return protoField;
            var field = {};
            (0, _defineProperties["default"])(field, {
              value: {
                enumerable: true,
                get: function get() {
                  return getter.call(_this3);
                },
                set: function set(value) {
                  setter.call(_this3, value);
                }
              },
              holder: {
                enumerable: true,
                value: protoField.holder
              },
              fieldType: {
                enumerable: true,
                value: protoField.fieldType
              },
              fieldReturnType: {
                enumerable: true,
                value: protoField.fieldReturnType
              }
            });
            (0, _defineProperty["default"])(this, name, {
              enumerable: false,
              value: field
            });
            return field;
          }
        });
      });
    }

    function makeMethodFromOverloads(name, overloads, classHandle, env) {
      var Method = env.javaLangReflectMethod();
      var Modifier = env.javaLangReflectModifier();
      var invokeObjectMethodNoArgs = env.vaMethod('pointer', []);
      var invokeUInt8MethodNoArgs = env.vaMethod('uint8', []);
      var methods = overloads.map(function (params) {
        var _params2 = (0, _slicedToArray2["default"])(params, 2),
            methodId = _params2[0],
            modifiers = _params2[1];

        var isStatic = (modifiers & Modifier.STATIC) === 0 ? 0 : 1;
        var jsType = isStatic ? STATIC_METHOD : INSTANCE_METHOD;
        var jsRetType;
        var jsArgTypes = [];
        var handle = env.toReflectedMethod(classHandle, methodId, isStatic);

        try {
          var isVarArgs = !!invokeUInt8MethodNoArgs(env.handle, handle, Method.isVarArgs);
          var retType = invokeObjectMethodNoArgs(env.handle, handle, Method.getGenericReturnType);
          env.checkForExceptionAndThrowIt();

          try {
            jsRetType = getTypeFromJniTypeName(env.getTypeName(retType));
          } finally {
            env.deleteLocalRef(retType);
          }

          var argTypes = invokeObjectMethodNoArgs(env.handle, handle, Method.getParameterTypes);
          env.checkForExceptionAndThrowIt();

          try {
            var numArgTypes = env.getArrayLength(argTypes);

            for (var argTypeIndex = 0; argTypeIndex !== numArgTypes; argTypeIndex++) {
              var t = env.getObjectArrayElement(argTypes, argTypeIndex);

              try {
                var argClassName = isVarArgs && argTypeIndex === numArgTypes - 1 ? env.getArrayTypeName(t) : env.getTypeName(t);
                var argType = getTypeFromJniTypeName(argClassName);
                jsArgTypes.push(argType);
              } finally {
                env.deleteLocalRef(t);
              }
            }
          } finally {
            env.deleteLocalRef(argTypes);
          }
        } catch (e) {
          return null;
        } finally {
          env.deleteLocalRef(handle);
        }

        return makeMethod(name, jsType, methodId, jsRetType, jsArgTypes, env);
      }).filter(function (m) {
        return m !== null;
      });

      if (methods.length === 0) {
        throw new Error('No supported overloads');
      }

      if (name === 'valueOf') {
        var hasDefaultValueOf = methods.some(function implementsDefaultValueOf(m) {
          return m.type === INSTANCE_METHOD && m.argumentTypes.length === 0;
        });

        if (!hasDefaultValueOf) {
          var defaultValueOf = function defaultValueOf() {
            return this;
          };

          (0, _defineProperty["default"])(defaultValueOf, 'holder', {
            enumerable: true,
            value: klass
          });
          (0, _defineProperty["default"])(defaultValueOf, 'type', {
            enumerable: true,
            value: INSTANCE_METHOD
          });
          (0, _defineProperty["default"])(defaultValueOf, 'returnType', {
            enumerable: true,
            value: getTypeFromJniTypeName('int')
          });
          (0, _defineProperty["default"])(defaultValueOf, 'argumentTypes', {
            enumerable: true,
            value: []
          });
          (0, _defineProperty["default"])(defaultValueOf, 'canInvokeWith', {
            enumerable: true,
            value: function value(args) {
              return args.length === 0;
            }
          });
          methods.push(defaultValueOf);
        }
      }

      return makeMethodDispatcher(name, methods);
    }

    function makeMethodDispatcher(name, methods) {
      var candidates = {};
      methods.forEach(function (m) {
        var numArgs = m.argumentTypes.length;
        var group = candidates[numArgs];

        if (!group) {
          group = [];
          candidates[numArgs] = group;
        }

        group.push(m);
      });

      function f() {
        /* jshint validthis: true */
        var isInstance = this.$handle !== undefined;

        for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
          args[_key] = arguments[_key];
        }

        var group = candidates[args.length];

        if (!group) {
          throwOverloadError(name, methods, "argument count of ".concat(args.length, " does not match any of:"));
        }

        for (var i = 0; i !== group.length; i++) {
          var method = group[i];

          if (method.canInvokeWith(args)) {
            if (method.type === INSTANCE_METHOD && !isInstance) {
              if (name === 'toString') {
                return '<' + this.$classWrapper.__name__ + '>';
              }

              throw new Error(name + ': cannot call instance method without an instance');
            }

            return method.apply(this, args);
          }
        }

        throwOverloadError(name, methods, 'argument types do not match any of:');
      }

      (0, _defineProperty["default"])(f, 'overloads', {
        enumerable: true,
        value: methods
      });
      (0, _defineProperty["default"])(f, 'overload', {
        enumerable: true,
        value: function value() {
          for (var _len2 = arguments.length, args = new Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
            args[_key2] = arguments[_key2];
          }

          var group = candidates[args.length];

          if (!group) {
            throwOverloadError(name, methods, "argument count of ".concat(args.length, " does not match any of:"));
          }

          var signature = args.join(':');

          for (var i = 0; i !== group.length; i++) {
            var method = group[i];
            var s = method.argumentTypes.map(function (t) {
              return t.className;
            }).join(':');

            if (s === signature) {
              return method;
            }
          }

          throwOverloadError(name, methods, 'specified argument types do not match any of:');
        }
      });
      (0, _defineProperty["default"])(f, 'holder', {
        enumerable: true,
        get: methods[0].holder
      });
      (0, _defineProperty["default"])(f, 'type', {
        enumerable: true,
        value: methods[0].type
      });

      if (methods.length === 1) {
        (0, _defineProperty["default"])(f, 'implementation', {
          enumerable: true,
          get: function get() {
            return methods[0].implementation;
          },
          set: function set(imp) {
            methods[0].implementation = imp;
          }
        });
        (0, _defineProperty["default"])(f, 'returnType', {
          enumerable: true,
          value: methods[0].returnType
        });
        (0, _defineProperty["default"])(f, 'argumentTypes', {
          enumerable: true,
          value: methods[0].argumentTypes
        });
        (0, _defineProperty["default"])(f, 'canInvokeWith', {
          enumerable: true,
          value: methods[0].canInvokeWith
        });
        (0, _defineProperty["default"])(f, 'handle', {
          enumerable: true,
          value: methods[0].handle
        });
      } else {
        var throwAmbiguousError = function throwAmbiguousError() {
          throwOverloadError(name, methods, 'has more than one overload, use .overload(<signature>) to choose from:');
        };

        (0, _defineProperty["default"])(f, 'implementation', {
          enumerable: true,
          get: throwAmbiguousError,
          set: throwAmbiguousError
        });
        (0, _defineProperty["default"])(f, 'returnType', {
          enumerable: true,
          get: throwAmbiguousError
        });
        (0, _defineProperty["default"])(f, 'argumentTypes', {
          enumerable: true,
          get: throwAmbiguousError
        });
        (0, _defineProperty["default"])(f, 'canInvokeWith', {
          enumerable: true,
          get: throwAmbiguousError
        });
        (0, _defineProperty["default"])(f, 'handle', {
          enumerable: true,
          get: throwAmbiguousError
        });
      }

      return f;
    }

    function makeMethod(methodName, type, methodId, retType, argTypes, env) {
      var dalvikTargetMethodId = methodId;
      var dalvikOriginalMethod = null;
      var artHookedMethodId = methodId;
      var artOriginalMethodInfo = null;
      var rawRetType = retType.type;
      var rawArgTypes = argTypes.map(function (t) {
        return t.type;
      });
      var invokeTargetVirtually, invokeTargetDirectly; // eslint-disable-line

      if (type === CONSTRUCTOR_METHOD) {
        invokeTargetVirtually = env.constructor(rawArgTypes);
        invokeTargetDirectly = invokeTargetVirtually;
      } else if (type === STATIC_METHOD) {
        invokeTargetVirtually = env.staticVaMethod(rawRetType, rawArgTypes);
        invokeTargetDirectly = invokeTargetVirtually;
      } else if (type === INSTANCE_METHOD) {
        invokeTargetVirtually = env.vaMethod(rawRetType, rawArgTypes);
        invokeTargetDirectly = env.nonvirtualVaMethod(rawRetType, rawArgTypes);
      }

      var frameCapacity = 2;
      var argVariableNames = argTypes.map(function (t, i) {
        return 'a' + (i + 1);
      });
      var callArgsVirtual = ['env.handle', type === INSTANCE_METHOD ? 'this.$handle' : 'this.$getClassHandle(env)', api.flavor === 'art' ? 'resolveArtTargetMethodId()' : 'dalvikTargetMethodId'].concat(argTypes.map(function (t, i) {
        if (t.toJni) {
          frameCapacity++;
          return ['argTypes[', i, '].toJni.call(this, ', argVariableNames[i], ', env)'].join('');
        } else {
          return argVariableNames[i];
        }
      }));
      var callArgsDirect;

      if (type === INSTANCE_METHOD) {
        callArgsDirect = callArgsVirtual.slice();
        callArgsDirect.splice(2, 0, 'this.$getClassHandle(env)');
      } else {
        callArgsDirect = callArgsVirtual;
      }

      var returnCapture, returnStatements;

      if (rawRetType === 'void') {
        returnCapture = '';
        returnStatements = 'env.popLocalFrame(NULL);';
      } else {
        if (retType.fromJni) {
          frameCapacity++;
          returnCapture = 'rawResult = ';
          returnStatements = 'try {' + 'result = retType.fromJni.call(this, rawResult, env);' + '} finally {' + 'env.popLocalFrame(NULL);' + '}' + 'return result;';
        } else {
          returnCapture = 'result = ';
          returnStatements = 'env.popLocalFrame(NULL);' + 'return result;';
        }
      }

      var f;
      var pendingCalls = new _set["default"]();
      eval('f = function (' + argVariableNames.join(', ') + ') {' + // eslint-disable-line
      'var env = vm.getEnv();' + 'if (env.pushLocalFrame(' + frameCapacity + ') !== JNI_OK) {' + 'env.exceptionClear();' + 'throw new Error("Out of memory");' + '}' + 'var result, rawResult;' + 'try {' + (api.flavor === 'dalvik' ? 'synchronizeDalvikVtable.call(this, env, type === INSTANCE_METHOD);' + returnCapture + 'invokeTargetVirtually(' + callArgsVirtual.join(', ') + ');' : 'if (pendingCalls.has(Process.getCurrentThreadId())) {' + returnCapture + 'invokeTargetDirectly(' + callArgsDirect.join(', ') + ');' + '} else {' + returnCapture + 'invokeTargetVirtually(' + callArgsVirtual.join(', ') + ');' + '}') + '} catch (e) {' + 'env.popLocalFrame(NULL);' + 'throw e;' + '}' + 'try {' + 'env.checkForExceptionAndThrowIt();' + '} catch (e) {' + 'env.popLocalFrame(NULL); ' + 'throw e;' + '}' + returnStatements + '};');
      (0, _defineProperty["default"])(f, 'methodName', {
        enumerable: true,
        value: methodName
      });
      (0, _defineProperty["default"])(f, 'holder', {
        enumerable: true,
        value: klass
      });
      (0, _defineProperty["default"])(f, 'type', {
        enumerable: true,
        value: type
      });
      (0, _defineProperty["default"])(f, 'handle', {
        enumerable: true,
        value: methodId
      });

      function fetchMethod(methodId) {
        var artMethodSpec = getArtMethodSpec(vm);
        var artMethodOffset = artMethodSpec.offset;
        return ['jniCode', 'accessFlags', 'quickCode', 'interpreterCode'].reduce(function (original, name) {
          var offset = artMethodOffset[name];

          if (offset === undefined) {
            return original;
          }

          var address = methodId.add(offset);
          var suffix = name === 'accessFlags' ? 'U32' : 'Pointer';
          original[name] = Memory['read' + suffix](address);
          return original;
        }, {});
      }

      function patchMethod(methodId, patches) {
        var artMethodSpec = getArtMethodSpec(vm);
        var artMethodOffset = artMethodSpec.offset;
        (0, _keys["default"])(patches).forEach(function (name) {
          var offset = artMethodOffset[name];

          if (offset === undefined) {
            return;
          }

          var address = methodId.add(offset);
          var suffix = name === 'accessFlags' ? 'U32' : 'Pointer';
          Memory['write' + suffix](address, patches[name]);
        });
      }

      var implementation = null;

      function resolveArtTargetMethodId() {
        // eslint-disable-line
        if (artOriginalMethodInfo === null) {
          return methodId;
        }

        var target = cloneArtMethod(artHookedMethodId);
        patchMethod(target, artOriginalMethodInfo);
        return target;
      }

      function replaceArtImplementation(fn) {
        if (fn === null && artOriginalMethodInfo === null) {
          return;
        }

        var artMethodSpec = getArtMethodSpec(vm);
        var artMethodOffset = artMethodSpec.offset;

        if (artOriginalMethodInfo === null) {
          artOriginalMethodInfo = fetchMethod(methodId);

          if (xposedIsSupported && (artOriginalMethodInfo.accessFlags & kAccXposedHookedMethod) !== 0) {
            var hookInfo = artOriginalMethodInfo.jniCode;
            artHookedMethodId = hookInfo.add(2 * pointerSize).readPointer();
            artOriginalMethodInfo = fetchMethod(artHookedMethodId);
          }
        }

        if (fn !== null) {
          implementation = implement(f, fn); // kAccFastNative so that the VM doesn't get suspended while executing JNI
          // (so that we can modify the ArtMethod on the fly)

          patchMethod(artHookedMethodId, {
            'jniCode': implementation,
            'accessFlags': (artHookedMethodId.add(artMethodOffset.accessFlags).readU32() | kAccNative | kAccFastNative) >>> 0,
            'quickCode': api.artQuickGenericJniTrampoline,
            'interpreterCode': api.artInterpreterToCompiledCodeBridge
          });
          notifyArtMethodHooked(artHookedMethodId);
          patchedMethods.add(f);
        } else {
          patchedMethods["delete"](f);
          patchMethod(artHookedMethodId, artOriginalMethodInfo);
          implementation = null;
        }
      }

      function replaceDalvikImplementation(fn) {
        if (fn === null && dalvikOriginalMethod === null) {
          return;
        }

        if (dalvikOriginalMethod === null) {
          dalvikOriginalMethod = Memory.dup(methodId, DVM_METHOD_SIZE);
          dalvikTargetMethodId = Memory.dup(methodId, DVM_METHOD_SIZE);
        }

        if (fn !== null) {
          implementation = implement(f, fn);
          var argsSize = argTypes.reduce(function (acc, t) {
            return acc + t.size;
          }, 0);

          if (type === INSTANCE_METHOD) {
            argsSize++;
          }
          /*
           * make method native (with kAccNative)
           * insSize and registersSize are set to arguments size
           */


          var accessFlags = (methodId.add(DVM_METHOD_OFFSET_ACCESS_FLAGS).readU32() | kAccNative) >>> 0;
          var registersSize = argsSize;
          var outsSize = 0;
          var insSize = argsSize;
          methodId.add(DVM_METHOD_OFFSET_ACCESS_FLAGS).writeU32(accessFlags);
          methodId.add(DVM_METHOD_OFFSET_REGISTERS_SIZE).writeU16(registersSize);
          methodId.add(DVM_METHOD_OFFSET_OUTS_SIZE).writeU16(outsSize);
          methodId.add(DVM_METHOD_OFFSET_INS_SIZE).writeU16(insSize);
          methodId.add(DVM_METHOD_OFFSET_JNI_ARG_INFO).writeU32(computeDalvikJniArgInfo(methodId));
          api.dvmUseJNIBridge(methodId, implementation);
          patchedMethods.add(f);
        } else {
          patchedMethods["delete"](f);
          Memory.copy(methodId, dalvikOriginalMethod, DVM_METHOD_SIZE);
          implementation = null;
        }
      }

      function synchronizeDalvikVtable(env, instance) {
        // eslint-disable-line

        /* jshint validthis: true */
        if (dalvikOriginalMethod === null) {
          return; // nothing to do -- implementation hasn't been replaced
        }

        var thread = env.handle.add(DVM_JNI_ENV_OFFSET_SELF).readPointer();
        var objectPtr = api.dvmDecodeIndirectRef(thread, instance ? this.$handle : this.$getClassHandle(env));
        var classObject;

        if (instance) {
          classObject = objectPtr.add(DVM_OBJECT_OFFSET_CLAZZ).readPointer();
        } else {
          classObject = objectPtr;
        }

        var key = classObject.toString(16);
        var entry = patchedClasses[key];

        if (!entry) {
          var vtablePtr = classObject.add(DVM_CLASS_OBJECT_OFFSET_VTABLE);
          var vtableCountPtr = classObject.add(DVM_CLASS_OBJECT_OFFSET_VTABLE_COUNT);
          var vtable = vtablePtr.readPointer();
          var vtableCount = vtableCountPtr.readS32();
          var vtableSize = vtableCount * pointerSize;
          var shadowVtable = Memory.alloc(2 * vtableSize);
          Memory.copy(shadowVtable, vtable, vtableSize);
          vtablePtr.writePointer(shadowVtable);
          entry = {
            classObject: classObject,
            vtablePtr: vtablePtr,
            vtableCountPtr: vtableCountPtr,
            vtable: vtable,
            vtableCount: vtableCount,
            shadowVtable: shadowVtable,
            shadowVtableCount: vtableCount,
            targetMethods: {}
          };
          patchedClasses[key] = entry;
        }

        key = methodId.toString(16);
        var method = entry.targetMethods[key];

        if (!method) {
          var methodIndex = entry.shadowVtableCount++;
          entry.shadowVtable.add(methodIndex * pointerSize).writePointer(dalvikTargetMethodId);
          dalvikTargetMethodId.add(DVM_METHOD_OFFSET_METHOD_INDEX).writeU16(methodIndex);
          entry.vtableCountPtr.writeS32(entry.shadowVtableCount);
          entry.targetMethods[key] = f;
        }
      }

      (0, _defineProperty["default"])(f, 'implementation', {
        enumerable: true,
        get: function get() {
          return implementation;
        },
        set: type === CONSTRUCTOR_METHOD ? function () {
          throw new Error('Reimplementing $new is not possible. Please replace implementation of $init instead.');
        } : api.flavor === 'art' ? replaceArtImplementation : replaceDalvikImplementation
      });
      (0, _defineProperty["default"])(f, 'returnType', {
        enumerable: true,
        value: retType
      });
      (0, _defineProperty["default"])(f, 'argumentTypes', {
        enumerable: true,
        value: argTypes
      });
      (0, _defineProperty["default"])(f, 'canInvokeWith', {
        enumerable: true,
        value: function value(args) {
          if (args.length !== argTypes.length) {
            return false;
          }

          return argTypes.every(function (t, i) {
            return t.isCompatible(args[i]);
          });
        }
      });
      (0, _defineProperty["default"])(f, PENDING_CALLS, {
        enumerable: true,
        value: pendingCalls
      });
      return f;
    }

    if (superKlass !== null) {
      var Surrogate = function Surrogate() {
        this.constructor = klass;
      };

      Surrogate.prototype = superKlass.prototype;
      klass.prototype = new Surrogate();
      klass.__super__ = superKlass.prototype;
    } else {
      klass.__super__ = null;
    }

    initializeClass(); // Guard against use-after-"free"

    env.deleteLocalRef(classHandle);
    classHandle = null;
    env = null;
    return klass;
  }

  function registerClass(spec) {
    var env = vm.getEnv();
    var localHandles = [];

    try {
      var placeholder = function placeholder() {
        for (var _len4 = arguments.length, args = new Array(_len4), _key4 = 0; _key4 < _len4; _key4++) {
          args[_key4] = arguments[_key4];
        }

        return (0, _construct2["default"])(C, args);
      };

      var Class = factory.use('java.lang.Class');
      var Method = env.javaLangReflectMethod();
      var invokeObjectMethodNoArgs = env.vaMethod('pointer', []);
      var className = spec.name;
      var interfaces = spec["implements"] || [];
      var superClass = spec.superClass || factory.use('java.lang.Object');
      var dexFields = [];
      var dexMethods = [];
      var dexSpec = {
        name: makeJniObjectTypeName(className),
        sourceFileName: makeSourceFileName(className),
        superClass: makeJniObjectTypeName(superClass.$classWrapper.__name__),
        interfaces: interfaces.map(function (iface) {
          return makeJniObjectTypeName(iface.$classWrapper.__name__);
        }),
        fields: dexFields,
        methods: dexMethods
      };
      var allInterfaces = interfaces.slice();
      interfaces.forEach(function (iface) {
        Array.prototype.slice.call(iface["class"].getInterfaces()).forEach(function (baseIface) {
          var baseIfaceName = factory.cast(baseIface, Class).getCanonicalName();
          allInterfaces.push(factory.use(baseIfaceName));
        });
      });
      var fields = spec.fields || {};
      (0, _getOwnPropertyNames["default"])(fields).forEach(function (name) {
        var fieldType = getTypeFromJniTypeName(fields[name]);
        dexFields.push([name, fieldType.name]);
      });
      var baseMethods = {};
      var pendingOverloads = {};
      allInterfaces.forEach(function (iface) {
        var ifaceHandle = iface.$getClassHandle(env);
        localHandles.push(ifaceHandle);
        var ifaceProto = (0, _getPrototypeOf2["default"])(iface);
        (0, _getOwnPropertyNames["default"])(ifaceProto).filter(function (name) {
          return name[0] !== '$' && name !== 'constructor' && name !== 'class' && iface[name].overloads !== undefined;
        }).forEach(function (name) {
          var method = iface[name];
          var overloads = method.overloads;
          var overloadIds = overloads.map(function (overload) {
            return makeOverloadId(name, overload.returnType, overload.argumentTypes);
          });
          baseMethods[name] = [method, overloadIds, ifaceHandle];
          overloads.forEach(function (overload, index) {
            var id = overloadIds[index];
            pendingOverloads[id] = [overload, ifaceHandle];
          });
        });
      });
      var methods = spec.methods || {};
      var methodNames = (0, _keys["default"])(methods);
      var methodEntries = methodNames.reduce(function (result, name) {
        var entry = methods[name];
        var rawName = name === '$init' ? '<init>' : name;

        if (entry instanceof Array) {
          result.push.apply(result, (0, _toConsumableArray2["default"])(entry.map(function (e) {
            return [rawName, e];
          })));
        } else {
          result.push([rawName, entry]);
        }

        return result;
      }, []);
      var numMethods = methodEntries.length;
      var nativeMethods = [];
      var temporaryHandles = [];
      var methodElements = null;

      if (numMethods > 0) {
        var methodElementSize = 3 * pointerSize;
        methodElements = Memory.alloc(numMethods * methodElementSize);
        methodEntries.forEach(function (_ref, index) {
          var _ref2 = (0, _slicedToArray2["default"])(_ref, 2),
              name = _ref2[0],
              methodValue = _ref2[1];

          var method = null;
          var returnType;
          var argumentTypes;
          var thrownTypeNames = [];
          var impl;

          if (typeof methodValue === 'function') {
            var m = baseMethods[name];

            if (m !== undefined && (0, _isArray["default"])(m)) {
              var _m = (0, _slicedToArray2["default"])(m, 3),
                  baseMethod = _m[0],
                  overloadIds = _m[1],
                  parentTypeHandle = _m[2];

              if (overloadIds.length > 1) {
                throw new Error("More than one overload matching '".concat(name, "': signature must be specified"));
              }

              delete pendingOverloads[overloadIds[0]];
              var overload = baseMethod.overloads[0];
              method = (0, _assign["default"])({}, overload, {
                holder: placeholder
              });
              returnType = overload.returnType;
              argumentTypes = overload.argumentTypes;
              impl = methodValue;
              var reflectedMethod = env.toReflectedMethod(parentTypeHandle, overload.handle, 0);
              var thrownTypes = invokeObjectMethodNoArgs(env.handle, reflectedMethod, Method.getGenericExceptionTypes);
              thrownTypeNames = readTypeNames(env, thrownTypes).map(makeJniObjectTypeName);
              env.deleteLocalRef(thrownTypes);
            } else {
              returnType = getTypeFromJniTypeName('void');
              argumentTypes = [];
              impl = methodValue;
            }
          } else {
            returnType = getTypeFromJniTypeName(methodValue.returnType || 'void');
            argumentTypes = (methodValue.argumentTypes || []).map(function (name) {
              return getTypeFromJniTypeName(name);
            });
            impl = methodValue.implementation;

            if (typeof impl !== 'function') {
              throw new Error('Expected a function implementation for method: ' + name);
            }

            var id = makeOverloadId(name, returnType, argumentTypes);
            var pendingOverload = pendingOverloads[id];

            if (pendingOverload !== undefined) {
              var _pendingOverload = (0, _slicedToArray2["default"])(pendingOverload, 2),
                  _overload = _pendingOverload[0],
                  _parentTypeHandle = _pendingOverload[1];

              delete pendingOverloads[id];
              method = (0, _assign["default"])({}, _overload, {
                holder: placeholder
              });

              var _reflectedMethod = env.toReflectedMethod(_parentTypeHandle, _overload.handle, 0);

              var _thrownTypes = invokeObjectMethodNoArgs(env.handle, _reflectedMethod, Method.getGenericExceptionTypes);

              thrownTypeNames = readTypeNames(env, _thrownTypes).map(makeJniObjectTypeName);
              env.deleteLocalRef(_thrownTypes);
            }
          }

          if (method === null) {
            method = {
              methodName: name,
              type: INSTANCE_METHOD,
              returnType: returnType,
              argumentTypes: argumentTypes,
              holder: placeholder
            };
            method[PENDING_CALLS] = new _set["default"]();
          }

          var returnTypeName = returnType.name;
          var argumentTypeNames = argumentTypes.map(function (t) {
            return t.name;
          });
          dexMethods.push([name, returnTypeName, argumentTypeNames, thrownTypeNames]);
          var signature = '(' + argumentTypeNames.join('') + ')' + returnTypeName;
          var rawName = Memory.allocUtf8String(name);
          var rawSignature = Memory.allocUtf8String(signature);
          var rawImpl = implement(method, impl);
          methodElements.add(index * methodElementSize).writePointer(rawName);
          methodElements.add(index * methodElementSize + pointerSize).writePointer(rawSignature);
          methodElements.add(index * methodElementSize + 2 * pointerSize).writePointer(rawImpl);
          temporaryHandles.push(rawName, rawSignature);
          nativeMethods.push(rawImpl);
        });
        var unimplementedMethodIds = (0, _keys["default"])(pendingOverloads);

        if (unimplementedMethodIds.length > 0) {
          throw new Error('Missing implementation for: ' + unimplementedMethodIds.join(', '));
        }
      }

      var dex = DexFile.fromBuffer(mkdex(dexSpec));

      try {
        dex.load();
      } finally {
        dex.file["delete"]();
      }

      var Klass = factory.use(spec.name);
      Klass.$classWrapper.$nativeMethods = nativeMethods;

      if (numMethods > 0) {
        var classHandle = Klass.$getClassHandle(env);
        localHandles.push(classHandle);
        env.registerNatives(classHandle, methodElements, numMethods);
        env.checkForExceptionAndThrowIt();
      }

      if (spec.superClass) {
        (0, _defineProperty["default"])(Klass.$classWrapper.prototype, '$super', {
          enumerable: true,
          get: function get() {
            var superInstance = factory.cast(this, superClass);
            return new Proxy(superInstance, {
              get: function get(target, property, receiver) {
                var prop = superInstance[property];

                if (prop === undefined || prop.overloads === undefined) {
                  return prop;
                }

                function makeProxy(method) {
                  return new Proxy(method, {
                    apply: function apply(target, thisArg, args) {
                      var tid = Process.getCurrentThreadId();

                      try {
                        method[PENDING_CALLS].add(tid);
                        return method.apply(superInstance, args);
                      } finally {
                        method[PENDING_CALLS]["delete"](tid);
                      }
                    }
                  });
                }

                return new Proxy(prop, {
                  apply: function apply(target, thisArg, args) {
                    for (var i = 0; i !== prop.overloads.length; i++) {
                      var method = prop.overloads[i];

                      if (method.canInvokeWith(args)) {
                        return makeProxy(method).apply(target, args);
                      }
                    }

                    throwOverloadError(property, prop.overloads, 'argument types do not match any of:');
                  },
                  get: function get(target, property, receiver) {
                    switch (property) {
                      case 'overloads':
                        return prop.overloads.map(makeProxy);

                      case 'overload':
                        return function () {
                          for (var _len3 = arguments.length, args = new Array(_len3), _key3 = 0; _key3 < _len3; _key3++) {
                            args[_key3] = arguments[_key3];
                          }

                          return makeProxy(prop.overload.apply(superInstance, args));
                        };

                      default:
                        return prop[property];
                    }
                  }
                });
              }
            });
          }
        });
      }

      var C = classes[spec.name];
      return Klass;
    } finally {
      localHandles.forEach(function (handle) {
        env.deleteLocalRef(handle);
      });
    }
  }

  function implement(method, fn) {
    if (method.hasOwnProperty('overloads')) {
      throw new Error('Only re-implementing a concrete (specific) method is possible, not a method "dispatcher"');
    }

    var C = method.holder; // eslint-disable-line

    var type = method.type;
    var retType = method.returnType;
    var argTypes = method.argumentTypes;
    var methodName = method.methodName;
    var rawRetType = retType.type;
    var rawArgTypes = argTypes.map(function (t) {
      return t.type;
    });
    var pendingCalls = method[PENDING_CALLS]; // eslint-disable-line

    var frameCapacity = 2;
    var argVariableNames = argTypes.map(function (t, i) {
      return 'a' + (i + 1);
    });
    var callArgs = argTypes.map(function (t, i) {
      if (t.fromJni) {
        frameCapacity++;
        return ['argTypes[', i, '].fromJni.call(self, ', argVariableNames[i], ', env)'].join('');
      } else {
        return argVariableNames[i];
      }
    });
    var returnCapture, returnStatements, returnNothing;

    if (rawRetType === 'void') {
      returnCapture = '';
      returnStatements = 'env.popLocalFrame(NULL);';
      returnNothing = 'return;';
    } else {
      if (retType.toJni) {
        frameCapacity++;
        returnCapture = 'result = ';
        returnStatements = 'var rawResult;' + 'try {' + 'if (retType.isCompatible.call(this, result)) {' + 'rawResult = retType.toJni.call(this, result, env);' + '} else {' + 'throw new Error("Implementation for " + methodName + " expected return value compatible with \'" + retType.className + "\'.");' + '}';

        if (retType.type === 'pointer') {
          returnStatements += '} catch (e) {' + 'env.popLocalFrame(NULL);' + 'throw e;' + '}' + 'return env.popLocalFrame(rawResult);';
          returnNothing = 'return NULL;';
        } else {
          returnStatements += '} finally {' + 'env.popLocalFrame(NULL);' + '}' + 'return rawResult;';
          returnNothing = 'return 0;';
        }
      } else {
        returnCapture = 'result = ';
        returnStatements = 'env.popLocalFrame(NULL);' + 'return result;';
        returnNothing = 'return 0;';
      }
    }

    var f;
    eval('f = function (' + ['envHandle', 'thisHandle'].concat(argVariableNames).join(', ') + ') {' + // eslint-disable-line
    'var env = new Env(envHandle, vm);' + 'if (env.pushLocalFrame(' + frameCapacity + ') !== JNI_OK) {' + 'return;' + '}' + 'var self = ' + (type === INSTANCE_METHOD ? 'new C(thisHandle);' : 'new C(null);') + 'var result;' + 'var tid = Process.getCurrentThreadId();' + 'try {' + 'pendingCalls.add(tid);' + 'if (ignoredThreads[tid] === undefined) {' + returnCapture + 'fn.call(' + ['self'].concat(callArgs).join(', ') + ');' + '} else {' + returnCapture + 'method.call(' + ['self'].concat(callArgs).join(', ') + ');' + '}' + '} catch (e) {' + 'env.popLocalFrame(NULL);' + "if (typeof e === 'object' && e.hasOwnProperty('$handle')) {" + 'env.throw(e.$handle);' + returnNothing + '} else {' + 'throw e;' + '}' + '} finally {' + 'pendingCalls.delete(tid);' + 'self.$dispose();' + '}' + returnStatements + '};');
    (0, _defineProperty["default"])(f, 'methodName', {
      enumerable: true,
      value: methodName
    });
    (0, _defineProperty["default"])(f, 'type', {
      enumerable: true,
      value: type
    });
    (0, _defineProperty["default"])(f, 'returnType', {
      enumerable: true,
      value: retType
    });
    (0, _defineProperty["default"])(f, 'argumentTypes', {
      enumerable: true,
      value: argTypes
    });
    (0, _defineProperty["default"])(f, 'canInvokeWith', {
      enumerable: true,
      value: function value(args) {
        if (args.length !== argTypes.length) {
          return false;
        }

        return argTypes.every(function (t, i) {
          return t.isCompatible(args[i]);
        });
      }
    });
    return new NativeCallback(f, rawRetType, ['pointer', 'pointer'].concat(rawArgTypes));
  }

  function getTypeFromJniTypeName(typeName) {
    var unbox = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : true;
    return getType(typeName, unbox, factory);
  }

  function ignore(threadId) {
    var count = ignoredThreads[threadId];

    if (count === undefined) {
      count = 0;
    }

    count++;
    ignoredThreads[threadId] = count;
  }

  function unignore(threadId) {
    var count = ignoredThreads[threadId];

    if (count === undefined) {
      throw new Error("Thread ".concat(threadId, " is not ignored"));
    }

    count--;

    if (count === 0) {
      delete ignoredThreads[threadId];
    } else {
      ignoredThreads[threadId] = count;
    }
  }

  initialize.call(this);
}

function basename(className) {
  return className.slice(className.lastIndexOf('.') + 1);
}

function makeJniObjectTypeName(typeName) {
  return 'L' + typeName.replace(/\./g, '/') + ';';
}

function readTypeNames(env, types) {
  var names = [];
  var numTypes = env.getArrayLength(types);

  for (var typeIndex = 0; typeIndex !== numTypes; typeIndex++) {
    var t = env.getObjectArrayElement(types, typeIndex);

    try {
      names.push(env.getTypeName(t));
    } finally {
      env.deleteLocalRef(t);
    }
  }

  return names;
}

function makeOverloadId(name, returnType, argumentTypes) {
  return "".concat(returnType.className, " ").concat(name, "(").concat(argumentTypes.map(function (t) {
    return t.className;
  }).join(', '), ")");
}

function throwOverloadError(name, methods, message) {
  var methodsSortedByArity = methods.slice().sort(function (a, b) {
    return a.argumentTypes.length - b.argumentTypes.length;
  });
  var overloads = methodsSortedByArity.map(function (m) {
    var argTypes = m.argumentTypes;

    if (argTypes.length > 0) {
      return '.overload(\'' + m.argumentTypes.map(function (t) {
        return t.className;
      }).join('\', \'') + '\')';
    } else {
      return '.overload()';
    }
  });
  throw new Error("".concat(name, "(): ").concat(message, "\n\t").concat(overloads.join('\n\t')));
}
/*
 * http://docs.oracle.com/javase/6/docs/technotes/guides/jni/spec/types.html#wp9502
 * http://www.liaohuqiu.net/posts/android-object-size-dalvik/
 */


function getType(typeName, unbox, factory) {
  var type = getPrimitiveType(typeName);

  if (!type) {
    if (typeName.indexOf('[') === 0) {
      type = getArrayType(typeName, unbox, factory);
    } else {
      if (typeName[0] === 'L' && typeName[typeName.length - 1] === ';') {
        typeName = typeName.substring(1, typeName.length - 1);
      }

      type = getObjectType(typeName, unbox, factory);
    }
  }

  var result = {
    className: typeName
  };

  for (var key in type) {
    if (type.hasOwnProperty(key)) {
      result[key] = type[key];
    }
  }

  return result;
}

var primitiveTypes = {
  "boolean": {
    name: 'Z',
    type: 'uint8',
    size: 1,
    byteSize: 1,
    isCompatible: function isCompatible(v) {
      return typeof v === 'boolean';
    },
    fromJni: function fromJni(v) {
      return !!v;
    },
    toJni: function toJni(v) {
      return v ? 1 : 0;
    },
    read: function read(address) {
      return address.readU8();
    },
    write: function write(address, value) {
      address.writeU8(value);
    }
  },
  "byte": {
    name: 'B',
    type: 'int8',
    size: 1,
    byteSize: 1,
    isCompatible: function isCompatible(v) {
      return (0, _isInteger["default"])(v) && v >= -128 && v <= 127;
    },
    read: function read(address) {
      return address.readS8();
    },
    write: function write(address, value) {
      address.writeS8(value);
    }
  },
  "char": {
    name: 'C',
    type: 'uint16',
    size: 1,
    byteSize: 2,
    isCompatible: function isCompatible(v) {
      if (typeof v === 'string' && v.length === 1) {
        var charCode = v.charCodeAt(0);
        return charCode >= 0 && charCode <= 65535;
      } else {
        return false;
      }
    },
    fromJni: function fromJni(c) {
      return String.fromCharCode(c);
    },
    toJni: function toJni(s) {
      return s.charCodeAt(0);
    },
    read: function read(address) {
      return address.readU16();
    },
    write: function write(address, value) {
      address.writeU16(value);
    }
  },
  "short": {
    name: 'S',
    type: 'int16',
    size: 1,
    byteSize: 2,
    isCompatible: function isCompatible(v) {
      return (0, _isInteger["default"])(v) && v >= -32768 && v <= 32767;
    },
    read: function read(address) {
      return address.readS16();
    },
    write: function write(address, value) {
      address.writeS16(value);
    }
  },
  "int": {
    name: 'I',
    type: 'int32',
    size: 1,
    byteSize: 4,
    isCompatible: function isCompatible(v) {
      return (0, _isInteger["default"])(v) && v >= -2147483648 && v <= 2147483647;
    },
    read: function read(address) {
      return address.readS32();
    },
    write: function write(address, value) {
      address.writeS32(value);
    }
  },
  "long": {
    name: 'J',
    type: 'int64',
    size: 2,
    byteSize: 8,
    isCompatible: function isCompatible(v) {
      return typeof v === 'number' || v instanceof Int64;
    },
    read: function read(address) {
      return address.readS64();
    },
    write: function write(address, value) {
      address.writeS64(value);
    }
  },
  "float": {
    name: 'F',
    type: 'float',
    size: 1,
    byteSize: 4,
    isCompatible: function isCompatible(v) {
      // TODO
      return typeof v === 'number';
    },
    read: function read(address) {
      return address.readFloat();
    },
    write: function write(address, value) {
      address.writeFloat(value);
    }
  },
  "double": {
    name: 'D',
    type: 'double',
    size: 2,
    byteSize: 8,
    isCompatible: function isCompatible(v) {
      // TODO
      return typeof v === 'number';
    },
    read: function read(address) {
      return address.readDouble();
    },
    write: function write(address, value) {
      address.writeDouble(value);
    }
  },
  "void": {
    name: 'V',
    type: 'void',
    size: 0,
    byteSize: 0,
    isCompatible: function isCompatible(v) {
      return v === undefined;
    }
  }
};

function getPrimitiveType(name) {
  return primitiveTypes[name];
}

var cachedObjectTypesWithUnbox = {};
var cachedObjectTypesWithoutUnbox = {};

function getObjectType(typeName, unbox, factory) {
  var cache = unbox ? cachedObjectTypesWithUnbox : cachedObjectTypesWithoutUnbox;
  var type = cache[typeName];

  if (type !== undefined) {
    return type;
  }

  if (typeName === 'java.lang.Object') {
    type = getJavaLangObjectType(factory);
  } else {
    type = getAnyObjectType(typeName, unbox, factory);
  }

  cache[typeName] = type;
  return type;
}

function getJavaLangObjectType(factory) {
  return {
    name: 'Ljava/lang/Object;',
    type: 'pointer',
    size: 1,
    isCompatible: function isCompatible(v) {
      if (v === null) {
        return true;
      }

      var jsType = (0, _typeof2["default"])(v);

      if (jsType === 'string') {
        return true;
      }

      return jsType === 'object' && v.hasOwnProperty('$handle');
    },
    fromJni: function fromJni(h, env) {
      if (h.isNull()) {
        return null;
      }

      if (this && this.$handle !== undefined && env.isSameObject(h, this.$handle)) {
        return factory.retain(this);
      }

      return factory.cast(h, factory.use('java.lang.Object'));
    },
    toJni: function toJni(o, env) {
      if (o === null) {
        return NULL;
      }

      if (typeof o === 'string') {
        return env.newStringUtf(o);
      }

      return o.$handle;
    }
  };
}

function getAnyObjectType(typeName, unbox, factory) {
  var cachedClass = null;
  var cachedIsInstance = null;
  var cachedIsDefaultString = null;

  function getClass() {
    if (cachedClass === null) {
      cachedClass = factory.use(typeName)["class"];
    }

    return cachedClass;
  }

  function isInstance(v) {
    var klass = getClass();

    if (cachedIsInstance === null) {
      cachedIsInstance = klass.isInstance.overload('java.lang.Object');
    }

    return cachedIsInstance.call(klass, v);
  }

  function typeIsDefaultString() {
    if (cachedIsDefaultString === null) {
      cachedIsDefaultString = factory.use('java.lang.String')["class"].isAssignableFrom(getClass());
    }

    return cachedIsDefaultString;
  }

  return {
    name: makeJniObjectTypeName(typeName),
    type: 'pointer',
    size: 1,
    isCompatible: function isCompatible(v) {
      if (v === null) {
        return true;
      }

      var jsType = (0, _typeof2["default"])(v);

      if (jsType === 'string' && typeIsDefaultString()) {
        return true;
      }

      var isWrapper = jsType === 'object' && v.hasOwnProperty('$handle');

      if (!isWrapper) {
        return false;
      }

      return isInstance(v);
    },
    fromJni: function fromJni(h, env) {
      if (h.isNull()) {
        return null;
      }

      if (typeIsDefaultString() && unbox) {
        return env.stringFromJni(h);
      }

      if (this && this.$handle !== undefined && env.isSameObject(h, this.$handle)) {
        return factory.retain(this);
      }

      return factory.cast(h, factory.use(typeName));
    },
    toJni: function toJni(o, env) {
      if (o === null) {
        return NULL;
      }

      if (typeof o === 'string') {
        return env.newStringUtf(o);
      }

      return o.$handle;
    }
  };
}

var primitiveArrayTypes = [['Z', 'boolean'], ['B', 'byte'], ['C', 'char'], ['D', 'double'], ['F', 'float'], ['I', 'int'], ['J', 'long'], ['S', 'short']].reduce(function (result, _ref3) {
  var _ref4 = (0, _slicedToArray2["default"])(_ref3, 2),
      shorty = _ref4[0],
      name = _ref4[1];

  result['[' + shorty] = makePrimitiveArrayType('[' + shorty, name);
  return result;
}, {});

function makePrimitiveArrayType(shorty, name) {
  var envProto = Env.prototype;
  var nameTitled = toTitleCase(name);
  var spec = {
    typeName: name,
    newArray: envProto['new' + nameTitled + 'Array'],
    setRegion: envProto['set' + nameTitled + 'ArrayRegion'],
    getElements: envProto['get' + nameTitled + 'ArrayElements'],
    releaseElements: envProto['release' + nameTitled + 'ArrayElements']
  };
  return {
    name: shorty,
    type: 'pointer',
    size: 1,
    isCompatible: function isCompatible(v) {
      return isCompatiblePrimitiveArray(v, name);
    },
    fromJni: function fromJni(h, env) {
      return fromJniPrimitiveArray(h, spec, env);
    },
    toJni: function toJni(arr, env) {
      return toJniPrimitiveArray(arr, spec, env);
    }
  };
}

function getArrayType(typeName, unbox, factory) {
  var primitiveType = primitiveArrayTypes[typeName];

  if (primitiveType !== undefined) {
    return primitiveType;
  }

  if (typeName.indexOf('[') !== 0) {
    throw new Error('Unsupported type: ' + typeName);
  }

  var elementTypeName = typeName.substring(1);
  var elementType = getType(elementTypeName, unbox, factory);

  if (elementTypeName[0] === 'L' && elementTypeName[elementTypeName.length - 1] === ';') {
    elementTypeName = elementTypeName.substring(1, elementTypeName.length - 1);
  }

  return {
    name: typeName.replace(/\./g, '/'),
    type: 'pointer',
    size: 1,
    isCompatible: function isCompatible(v) {
      if (v === null) {
        return true;
      } else if ((0, _typeof2["default"])(v) !== 'object' || !v.hasOwnProperty('length')) {
        return false;
      }

      return v.every(function (element) {
        return elementType.isCompatible(element);
      });
    },
    fromJni: function fromJni(arr, env) {
      return fromJniObjectArray.call(this, arr, env, function (self, elem) {
        return elementType.fromJni.call(self, elem, env);
      });
    },
    toJni: function toJni(elements, env) {
      var klassObj = factory.use(elementTypeName);
      var classHandle = klassObj.$getClassHandle(env);

      try {
        return toJniObjectArray(elements, env, classHandle, function (i, result) {
          var handle = elementType.toJni.call(this, elements[i], env);

          try {
            env.setObjectArrayElement(result, i, handle);
          } finally {
            if (elementType.type === 'pointer' && env.getObjectRefType(handle) === JNILocalRefType) {
              env.deleteLocalRef(handle);
            }
          }
        });
      } finally {
        env.deleteLocalRef(classHandle);
      }
    }
  };
}

function fromJniObjectArray(arr, env, convertFromJniFunc) {
  if (arr.isNull()) {
    return null;
  }

  var result = [];
  var length = env.getArrayLength(arr);

  for (var i = 0; i !== length; i++) {
    var elemHandle = env.getObjectArrayElement(arr, i); // Maybe ArrayIndexOutOfBoundsException: if 'i' does not specify a valid index in the array - should not be the case

    env.checkForExceptionAndThrowIt();

    try {
      /* jshint validthis: true */
      result.push(convertFromJniFunc(this, elemHandle));
    } finally {
      env.deleteLocalRef(elemHandle);
    }
  }

  return result;
}

function toJniObjectArray(arr, env, classHandle, setObjectArrayFunc) {
  if (arr === null) {
    return NULL;
  }

  if (!(arr instanceof Array)) {
    throw new Error("Expected an array.");
  }

  var length = arr.length;
  var result = env.newObjectArray(length, classHandle, NULL);
  env.checkForExceptionAndThrowIt();

  if (result.isNull()) {
    return NULL;
  }

  for (var i = 0; i !== length; i++) {
    setObjectArrayFunc.call(env, i, result);
    env.checkForExceptionAndThrowIt();
  }

  return result;
}

var PrimitiveArray = function PrimitiveArray(handle, type, length) {
  (0, _classCallCheck2["default"])(this, PrimitiveArray);
  this.$handle = handle;
  this.type = type;
  this.length = length;
};

function fromJniPrimitiveArray(arr, spec, env) {
  if (arr.isNull()) {
    return null;
  }

  var typeName = spec.typeName;
  var type = getPrimitiveType(typeName);
  var elementSize = type.byteSize;
  var readElement = type.read;
  var writeElement = type.write;
  var parseElementValue = type.fromJni || identity;
  var unparseElementValue = type.toJni || identity;
  var handle = env.newGlobalRef(arr);
  var length = env.getArrayLength(handle);
  var vm = env.vm;
  var storage = new PrimitiveArray(handle, typeName, length);
  var wrapper = new Proxy(storage, {
    has: function has(target, property) {
      return hasProperty.call(target, property);
    },
    get: function get(target, property, receiver) {
      switch (property) {
        case 'hasOwnProperty':
          return hasProperty.bind(target);

        case 'toJSON':
          return toJSON;

        default:
          if ((0, _typeof2["default"])(property) === 'symbol') {
            return target[property];
          }

          var index = tryParseIndex(property);

          if (index === null) {
            return target[property];
          }

          return withElements(function (elements) {
            return parseElementValue.call(type, readElement.call(type, elements.add(index * elementSize)));
          });
      }
    },
    set: function set(target, property, value, receiver) {
      var index = tryParseIndex(property);

      if (index === null) {
        target[property] = value;
        return true;
      }

      var env = vm.getEnv();
      var element = Memory.alloc(elementSize);
      writeElement.call(type, element, unparseElementValue(value));
      spec.setRegion.call(env, handle, index, 1, element);
      return true;
    },
    ownKeys: function ownKeys(target) {
      var keys = ['$handle', 'type', 'length'];

      for (var index = 0; index !== length; index++) {
        keys.push(index.toString());
      }

      return keys;
    },
    getOwnPropertyDescriptor: function getOwnPropertyDescriptor(target, property) {
      return {
        writable: false,
        configurable: true,
        enumerable: true
      };
    }
  });
  WeakRef.bind(wrapper, makeHandleDestructor(vm, handle));
  Script.nextTick(function () {
    wrapper = null;
  });
  env = null;
  return wrapper;

  function tryParseIndex(rawIndex) {
    var index = (0, _parseInt2["default"])(rawIndex);

    if (isNaN(index) || index < 0 || index >= length) {
      return null;
    }

    return index;
  }

  function withElements(perform) {
    var env = vm.getEnv();
    var elements = spec.getElements.call(env, handle);

    if (elements.isNull()) {
      throw new Error('Unable to get array elements');
    }

    try {
      return perform(elements);
    } finally {
      spec.releaseElements.call(env, handle, elements);
    }
  }

  function hasProperty(property) {
    var index = tryParseIndex(property);

    if (index === null) {
      return this.hasOwnProperty(property);
    }

    return true;
  }

  function toJSON() {
    return withElements(function (elements) {
      var values = [];

      for (var index = 0; index !== length; index++) {
        var value = parseElementValue.call(type, readElement.call(type, elements.add(index * elementSize)));
        values.push(value);
      }

      return values;
    });
  }
}

function toJniPrimitiveArray(arr, spec, env) {
  if (arr === null) {
    return NULL;
  }

  var handle = arr.$handle;

  if (handle !== undefined) {
    return handle;
  }

  var length = arr.length;
  var type = getPrimitiveType(spec.typeName);
  var result = spec.newArray.call(env, length);

  if (result.isNull()) {
    throw new Error('Unable to construct array');
  }

  if (length > 0) {
    var elementSize = type.byteSize;
    var writeElement = type.write;
    var unparseElementValue = type.toJni || identity;
    var elements = Memory.alloc(length * type.byteSize);

    for (var index = 0; index !== length; index++) {
      writeElement.call(type, elements.add(index * elementSize), unparseElementValue(arr[index]));
    }

    spec.setRegion.call(env, result, 0, length, elements);
    env.checkForExceptionAndThrowIt();
  }

  return result;
}

function isCompatiblePrimitiveArray(value, typeName) {
  if (value === null) {
    return true;
  }

  if (value instanceof PrimitiveArray) {
    return value.type === typeName;
  }

  var isArrayLike = (0, _typeof2["default"])(value) === 'object' && value.hasOwnProperty('length');

  if (!isArrayLike) {
    return false;
  }

  var elementType = getPrimitiveType(typeName);
  return Array.prototype.every.call(value, function (element) {
    return elementType.isCompatible(element);
  });
}

function makeSourceFileName(className) {
  var tokens = className.split('.');
  return tokens[tokens.length - 1] + '.java';
}

function toTitleCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function makeHandleDestructor(vm, handle) {
  return function () {
    vm.perform(function () {
      var env = vm.getEnv();
      env.deleteGlobalRef(handle);
    });
  };
}

function alignPointerOffset(offset) {
  var remainder = offset % pointerSize;

  if (remainder !== 0) {
    return offset + pointerSize - remainder;
  }

  return offset;
}

function identity(value) {
  return value;
}

function computeDalvikJniArgInfo(methodId) {
  if (Process.arch !== 'ia32') return DALVIK_JNI_NO_ARG_INFO; // For the x86 ABI, valid hints should always be generated.

  var shorty = methodId.add(DVM_METHOD_OFFSET_SHORTY).readPointer().readCString();
  if (shorty === null || shorty.length === 0 || shorty.length > 0xffff) return DALVIK_JNI_NO_ARG_INFO;
  var returnType;

  switch (shorty[0]) {
    case 'V':
      returnType = DALVIK_JNI_RETURN_VOID;
      break;

    case 'F':
      returnType = DALVIK_JNI_RETURN_FLOAT;
      break;

    case 'D':
      returnType = DALVIK_JNI_RETURN_DOUBLE;
      break;

    case 'J':
      returnType = DALVIK_JNI_RETURN_S8;
      break;

    case 'Z':
    case 'B':
      returnType = DALVIK_JNI_RETURN_S1;
      break;

    case 'C':
      returnType = DALVIK_JNI_RETURN_U2;
      break;

    case 'S':
      returnType = DALVIK_JNI_RETURN_S2;
      break;

    default:
      returnType = DALVIK_JNI_RETURN_S4;
      break;
  }

  var hints = 0;

  for (var i = shorty.length - 1; i > 0; i--) {
    var ch = shorty[i];
    hints += ch === 'D' || ch === 'J' ? 2 : 1;
  }

  return returnType << DALVIK_JNI_RETURN_SHIFT | hints;
}

module.exports = ClassFactory;
/* global Int64, Memory, NativeCallback, NativeFunction, NULL, Process, WeakRef */

},{"./android":2,"./api":3,"./env":5,"./mkdex":6,"./result":7,"@babel/runtime-corejs2/core-js/array/from":11,"@babel/runtime-corejs2/core-js/array/is-array":12,"@babel/runtime-corejs2/core-js/get-iterator":13,"@babel/runtime-corejs2/core-js/number/is-integer":15,"@babel/runtime-corejs2/core-js/object/assign":16,"@babel/runtime-corejs2/core-js/object/define-properties":18,"@babel/runtime-corejs2/core-js/object/define-property":19,"@babel/runtime-corejs2/core-js/object/get-own-property-names":21,"@babel/runtime-corejs2/core-js/object/get-prototype-of":22,"@babel/runtime-corejs2/core-js/object/keys":23,"@babel/runtime-corejs2/core-js/parse-int":25,"@babel/runtime-corejs2/core-js/set":29,"@babel/runtime-corejs2/core-js/symbol":30,"@babel/runtime-corejs2/helpers/classCallCheck":38,"@babel/runtime-corejs2/helpers/construct":39,"@babel/runtime-corejs2/helpers/createClass":40,"@babel/runtime-corejs2/helpers/get":41,"@babel/runtime-corejs2/helpers/getPrototypeOf":42,"@babel/runtime-corejs2/helpers/inherits":43,"@babel/runtime-corejs2/helpers/interopRequireDefault":44,"@babel/runtime-corejs2/helpers/possibleConstructorReturn":49,"@babel/runtime-corejs2/helpers/slicedToArray":51,"@babel/runtime-corejs2/helpers/toConsumableArray":53,"@babel/runtime-corejs2/helpers/typeof":54}],5:[function(require,module,exports){
"use strict";

function Env(handle, vm) {
  this.handle = handle;
  this.vm = vm;
}

var pointerSize = Process.pointerSize;
var JNI_ABORT = 2;
var CALL_CONSTRUCTOR_METHOD_OFFSET = 28;
var CALL_OBJECT_METHOD_OFFSET = 34;
var CALL_BOOLEAN_METHOD_OFFSET = 37;
var CALL_BYTE_METHOD_OFFSET = 40;
var CALL_CHAR_METHOD_OFFSET = 43;
var CALL_SHORT_METHOD_OFFSET = 46;
var CALL_INT_METHOD_OFFSET = 49;
var CALL_LONG_METHOD_OFFSET = 52;
var CALL_FLOAT_METHOD_OFFSET = 55;
var CALL_DOUBLE_METHOD_OFFSET = 58;
var CALL_VOID_METHOD_OFFSET = 61;
var CALL_NONVIRTUAL_OBJECT_METHOD_OFFSET = 64;
var CALL_NONVIRTUAL_BOOLEAN_METHOD_OFFSET = 67;
var CALL_NONVIRTUAL_BYTE_METHOD_OFFSET = 70;
var CALL_NONVIRTUAL_CHAR_METHOD_OFFSET = 73;
var CALL_NONVIRTUAL_SHORT_METHOD_OFFSET = 76;
var CALL_NONVIRTUAL_INT_METHOD_OFFSET = 79;
var CALL_NONVIRTUAL_LONG_METHOD_OFFSET = 82;
var CALL_NONVIRTUAL_FLOAT_METHOD_OFFSET = 85;
var CALL_NONVIRTUAL_DOUBLE_METHOD_OFFSET = 88;
var CALL_NONVIRTUAL_VOID_METHOD_OFFSET = 91;
var CALL_STATIC_OBJECT_METHOD_OFFSET = 114;
var CALL_STATIC_BOOLEAN_METHOD_OFFSET = 117;
var CALL_STATIC_BYTE_METHOD_OFFSET = 120;
var CALL_STATIC_CHAR_METHOD_OFFSET = 123;
var CALL_STATIC_SHORT_METHOD_OFFSET = 126;
var CALL_STATIC_INT_METHOD_OFFSET = 129;
var CALL_STATIC_LONG_METHOD_OFFSET = 132;
var CALL_STATIC_FLOAT_METHOD_OFFSET = 135;
var CALL_STATIC_DOUBLE_METHOD_OFFSET = 138;
var CALL_STATIC_VOID_METHOD_OFFSET = 141;
var GET_OBJECT_FIELD_OFFSET = 95;
var GET_BOOLEAN_FIELD_OFFSET = 96;
var GET_BYTE_FIELD_OFFSET = 97;
var GET_CHAR_FIELD_OFFSET = 98;
var GET_SHORT_FIELD_OFFSET = 99;
var GET_INT_FIELD_OFFSET = 100;
var GET_LONG_FIELD_OFFSET = 101;
var GET_FLOAT_FIELD_OFFSET = 102;
var GET_DOUBLE_FIELD_OFFSET = 103;
var SET_OBJECT_FIELD_OFFSET = 104;
var SET_BOOLEAN_FIELD_OFFSET = 105;
var SET_BYTE_FIELD_OFFSET = 106;
var SET_CHAR_FIELD_OFFSET = 107;
var SET_SHORT_FIELD_OFFSET = 108;
var SET_INT_FIELD_OFFSET = 109;
var SET_LONG_FIELD_OFFSET = 110;
var SET_FLOAT_FIELD_OFFSET = 111;
var SET_DOUBLE_FIELD_OFFSET = 112;
var GET_STATIC_OBJECT_FIELD_OFFSET = 145;
var GET_STATIC_BOOLEAN_FIELD_OFFSET = 146;
var GET_STATIC_BYTE_FIELD_OFFSET = 147;
var GET_STATIC_CHAR_FIELD_OFFSET = 148;
var GET_STATIC_SHORT_FIELD_OFFSET = 149;
var GET_STATIC_INT_FIELD_OFFSET = 150;
var GET_STATIC_LONG_FIELD_OFFSET = 151;
var GET_STATIC_FLOAT_FIELD_OFFSET = 152;
var GET_STATIC_DOUBLE_FIELD_OFFSET = 153;
var SET_STATIC_OBJECT_FIELD_OFFSET = 154;
var SET_STATIC_BOOLEAN_FIELD_OFFSET = 155;
var SET_STATIC_BYTE_FIELD_OFFSET = 156;
var SET_STATIC_CHAR_FIELD_OFFSET = 157;
var SET_STATIC_SHORT_FIELD_OFFSET = 158;
var SET_STATIC_INT_FIELD_OFFSET = 159;
var SET_STATIC_LONG_FIELD_OFFSET = 160;
var SET_STATIC_FLOAT_FIELD_OFFSET = 161;
var SET_STATIC_DOUBLE_FIELD_OFFSET = 162;
var callMethodOffset = {
  'pointer': CALL_OBJECT_METHOD_OFFSET,
  'uint8': CALL_BOOLEAN_METHOD_OFFSET,
  'int8': CALL_BYTE_METHOD_OFFSET,
  'uint16': CALL_CHAR_METHOD_OFFSET,
  'int16': CALL_SHORT_METHOD_OFFSET,
  'int32': CALL_INT_METHOD_OFFSET,
  'int64': CALL_LONG_METHOD_OFFSET,
  'float': CALL_FLOAT_METHOD_OFFSET,
  'double': CALL_DOUBLE_METHOD_OFFSET,
  'void': CALL_VOID_METHOD_OFFSET
};
var callNonvirtualMethodOffset = {
  'pointer': CALL_NONVIRTUAL_OBJECT_METHOD_OFFSET,
  'uint8': CALL_NONVIRTUAL_BOOLEAN_METHOD_OFFSET,
  'int8': CALL_NONVIRTUAL_BYTE_METHOD_OFFSET,
  'uint16': CALL_NONVIRTUAL_CHAR_METHOD_OFFSET,
  'int16': CALL_NONVIRTUAL_SHORT_METHOD_OFFSET,
  'int32': CALL_NONVIRTUAL_INT_METHOD_OFFSET,
  'int64': CALL_NONVIRTUAL_LONG_METHOD_OFFSET,
  'float': CALL_NONVIRTUAL_FLOAT_METHOD_OFFSET,
  'double': CALL_NONVIRTUAL_DOUBLE_METHOD_OFFSET,
  'void': CALL_NONVIRTUAL_VOID_METHOD_OFFSET
};
var callStaticMethodOffset = {
  'pointer': CALL_STATIC_OBJECT_METHOD_OFFSET,
  'uint8': CALL_STATIC_BOOLEAN_METHOD_OFFSET,
  'int8': CALL_STATIC_BYTE_METHOD_OFFSET,
  'uint16': CALL_STATIC_CHAR_METHOD_OFFSET,
  'int16': CALL_STATIC_SHORT_METHOD_OFFSET,
  'int32': CALL_STATIC_INT_METHOD_OFFSET,
  'int64': CALL_STATIC_LONG_METHOD_OFFSET,
  'float': CALL_STATIC_FLOAT_METHOD_OFFSET,
  'double': CALL_STATIC_DOUBLE_METHOD_OFFSET,
  'void': CALL_STATIC_VOID_METHOD_OFFSET
};
var getFieldOffset = {
  'pointer': GET_OBJECT_FIELD_OFFSET,
  'uint8': GET_BOOLEAN_FIELD_OFFSET,
  'int8': GET_BYTE_FIELD_OFFSET,
  'uint16': GET_CHAR_FIELD_OFFSET,
  'int16': GET_SHORT_FIELD_OFFSET,
  'int32': GET_INT_FIELD_OFFSET,
  'int64': GET_LONG_FIELD_OFFSET,
  'float': GET_FLOAT_FIELD_OFFSET,
  'double': GET_DOUBLE_FIELD_OFFSET
};
var setFieldOffset = {
  'pointer': SET_OBJECT_FIELD_OFFSET,
  'uint8': SET_BOOLEAN_FIELD_OFFSET,
  'int8': SET_BYTE_FIELD_OFFSET,
  'uint16': SET_CHAR_FIELD_OFFSET,
  'int16': SET_SHORT_FIELD_OFFSET,
  'int32': SET_INT_FIELD_OFFSET,
  'int64': SET_LONG_FIELD_OFFSET,
  'float': SET_FLOAT_FIELD_OFFSET,
  'double': SET_DOUBLE_FIELD_OFFSET
};
var getStaticFieldOffset = {
  'pointer': GET_STATIC_OBJECT_FIELD_OFFSET,
  'uint8': GET_STATIC_BOOLEAN_FIELD_OFFSET,
  'int8': GET_STATIC_BYTE_FIELD_OFFSET,
  'uint16': GET_STATIC_CHAR_FIELD_OFFSET,
  'int16': GET_STATIC_SHORT_FIELD_OFFSET,
  'int32': GET_STATIC_INT_FIELD_OFFSET,
  'int64': GET_STATIC_LONG_FIELD_OFFSET,
  'float': GET_STATIC_FLOAT_FIELD_OFFSET,
  'double': GET_STATIC_DOUBLE_FIELD_OFFSET
};
var setStaticFieldOffset = {
  'pointer': SET_STATIC_OBJECT_FIELD_OFFSET,
  'uint8': SET_STATIC_BOOLEAN_FIELD_OFFSET,
  'int8': SET_STATIC_BYTE_FIELD_OFFSET,
  'uint16': SET_STATIC_CHAR_FIELD_OFFSET,
  'int16': SET_STATIC_SHORT_FIELD_OFFSET,
  'int32': SET_STATIC_INT_FIELD_OFFSET,
  'int64': SET_STATIC_LONG_FIELD_OFFSET,
  'float': SET_STATIC_FLOAT_FIELD_OFFSET,
  'double': SET_STATIC_DOUBLE_FIELD_OFFSET
};
var nativeFunctionOptions = {
  exceptions: 'propagate'
};
var cachedVtable = null;
var globalRefs = [];

Env.dispose = function (env) {
  globalRefs.forEach(env.deleteGlobalRef, env);
  globalRefs = [];
};

function register(globalRef) {
  globalRefs.push(globalRef);
  return globalRef;
}

function vtable(instance) {
  if (cachedVtable === null) {
    cachedVtable = instance.handle.readPointer();
  }

  return cachedVtable;
}

function proxy(offset, retType, argTypes, wrapper) {
  var impl = null;
  return function () {
    if (impl === null) {
      impl = new NativeFunction(vtable(this).add(offset * pointerSize).readPointer(), retType, argTypes, nativeFunctionOptions);
    }

    var args = [impl];
    args = args.concat.apply(args, arguments);
    return wrapper.apply(this, args);
  };
}

Env.prototype.findClass = proxy(6, 'pointer', ['pointer', 'pointer'], function (impl, name) {
  var result = impl(this.handle, Memory.allocUtf8String(name));
  this.checkForExceptionAndThrowIt();
  return result;
});

Env.prototype.checkForExceptionAndThrowIt = function () {
  var throwable = this.exceptionOccurred();

  if (!throwable.isNull()) {
    try {
      this.exceptionClear();
      var description = this.vaMethod('pointer', [])(this.handle, throwable, this.javaLangObject().toString);

      try {
        var descriptionStr = this.stringFromJni(description);
        var error = new Error(descriptionStr);
        var handle = this.newGlobalRef(throwable);
        error.$handle = handle;
        WeakRef.bind(error, makeErrorHandleDestructor(this.vm, handle));
        throw error;
      } finally {
        this.deleteLocalRef(description);
      }
    } finally {
      this.deleteLocalRef(throwable);
    }
  }
};

function makeErrorHandleDestructor(vm, handle) {
  return function () {
    vm.perform(function () {
      var env = vm.getEnv();
      env.deleteGlobalRef(handle);
    });
  };
}

Env.prototype.fromReflectedMethod = proxy(7, 'pointer', ['pointer', 'pointer'], function (impl, method) {
  return impl(this.handle, method);
});
Env.prototype.fromReflectedField = proxy(8, 'pointer', ['pointer', 'pointer'], function (impl, method) {
  return impl(this.handle, method);
});
Env.prototype.toReflectedMethod = proxy(9, 'pointer', ['pointer', 'pointer', 'pointer', 'uint8'], function (impl, klass, methodId, isStatic) {
  return impl(this.handle, klass, methodId, isStatic);
});
Env.prototype.getSuperclass = proxy(10, 'pointer', ['pointer', 'pointer'], function (impl, klass) {
  return impl(this.handle, klass);
});
Env.prototype.isAssignableFrom = proxy(11, 'uint8', ['pointer', 'pointer', 'pointer'], function (impl, klass1, klass2) {
  return !!impl(this.handle, klass1, klass2);
});
Env.prototype.toReflectedField = proxy(12, 'pointer', ['pointer', 'pointer', 'pointer', 'uint8'], function (impl, klass, fieldId, isStatic) {
  return impl(this.handle, klass, fieldId, isStatic);
});
Env.prototype["throw"] = proxy(13, 'int32', ['pointer', 'pointer'], function (impl, obj) {
  return impl(this.handle, obj);
});
Env.prototype.exceptionOccurred = proxy(15, 'pointer', ['pointer'], function (impl) {
  return impl(this.handle);
});
Env.prototype.exceptionDescribe = proxy(16, 'void', ['pointer'], function (impl) {
  impl(this.handle);
});
Env.prototype.exceptionClear = proxy(17, 'void', ['pointer'], function (impl) {
  impl(this.handle);
});
Env.prototype.pushLocalFrame = proxy(19, 'int32', ['pointer', 'int32'], function (impl, capacity) {
  return impl(this.handle, capacity);
});
Env.prototype.popLocalFrame = proxy(20, 'pointer', ['pointer', 'pointer'], function (impl, result) {
  return impl(this.handle, result);
});
Env.prototype.newGlobalRef = proxy(21, 'pointer', ['pointer', 'pointer'], function (impl, obj) {
  return impl(this.handle, obj);
});
Env.prototype.deleteGlobalRef = proxy(22, 'void', ['pointer', 'pointer'], function (impl, globalRef) {
  impl(this.handle, globalRef);
});
Env.prototype.deleteLocalRef = proxy(23, 'void', ['pointer', 'pointer'], function (impl, localRef) {
  impl(this.handle, localRef);
});
Env.prototype.isSameObject = proxy(24, 'uint8', ['pointer', 'pointer', 'pointer'], function (impl, ref1, ref2) {
  return !!impl(this.handle, ref1, ref2);
});
Env.prototype.allocObject = proxy(27, 'pointer', ['pointer', 'pointer'], function (impl, clazz) {
  return impl(this.handle, clazz);
});
Env.prototype.getObjectClass = proxy(31, 'pointer', ['pointer', 'pointer'], function (impl, obj) {
  return impl(this.handle, obj);
});
Env.prototype.isInstanceOf = proxy(32, 'uint8', ['pointer', 'pointer', 'pointer'], function (impl, obj, klass) {
  return !!impl(this.handle, obj, klass);
});
Env.prototype.getMethodId = proxy(33, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer'], function (impl, klass, name, sig) {
  return impl(this.handle, klass, Memory.allocUtf8String(name), Memory.allocUtf8String(sig));
});
Env.prototype.getFieldId = proxy(94, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer'], function (impl, klass, name, sig) {
  return impl(this.handle, klass, Memory.allocUtf8String(name), Memory.allocUtf8String(sig));
});
Env.prototype.getIntField = proxy(100, 'int32', ['pointer', 'pointer', 'pointer'], function (impl, obj, fieldId) {
  return impl(this.handle, obj, fieldId);
});
Env.prototype.getStaticMethodId = proxy(113, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer'], function (impl, klass, name, sig) {
  return impl(this.handle, klass, Memory.allocUtf8String(name), Memory.allocUtf8String(sig));
});
Env.prototype.getStaticFieldId = proxy(144, 'pointer', ['pointer', 'pointer', 'pointer', 'pointer'], function (impl, klass, name, sig) {
  return impl(this.handle, klass, Memory.allocUtf8String(name), Memory.allocUtf8String(sig));
});
Env.prototype.getStaticIntField = proxy(150, 'int32', ['pointer', 'pointer', 'pointer'], function (impl, obj, fieldId) {
  return impl(this.handle, obj, fieldId);
});
Env.prototype.newStringUtf = proxy(167, 'pointer', ['pointer', 'pointer'], function (impl, str) {
  var utf = Memory.allocUtf8String(str);
  return impl(this.handle, utf);
});
Env.prototype.getStringUtfChars = proxy(169, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, str) {
  return impl(this.handle, str, NULL);
});
Env.prototype.releaseStringUtfChars = proxy(170, 'void', ['pointer', 'pointer', 'pointer'], function (impl, str, utf) {
  impl(this.handle, str, utf);
});
Env.prototype.getArrayLength = proxy(171, 'int32', ['pointer', 'pointer'], function (impl, array) {
  return impl(this.handle, array);
});
Env.prototype.newObjectArray = proxy(172, 'pointer', ['pointer', 'int32', 'pointer', 'pointer'], function (impl, length, elementClass, initialElement) {
  return impl(this.handle, length, elementClass, initialElement);
});
Env.prototype.getObjectArrayElement = proxy(173, 'pointer', ['pointer', 'pointer', 'int32'], function (impl, array, index) {
  return impl(this.handle, array, index);
});
Env.prototype.setObjectArrayElement = proxy(174, 'void', ['pointer', 'pointer', 'int32', 'pointer'], function (impl, array, index, value) {
  impl(this.handle, array, index, value);
});
Env.prototype.newBooleanArray = proxy(175, 'pointer', ['pointer', 'int32'], function (impl, length) {
  return impl(this.handle, length);
});
Env.prototype.newByteArray = proxy(176, 'pointer', ['pointer', 'int32'], function (impl, length) {
  return impl(this.handle, length);
});
Env.prototype.newCharArray = proxy(177, 'pointer', ['pointer', 'int32'], function (impl, length) {
  return impl(this.handle, length);
});
Env.prototype.newShortArray = proxy(178, 'pointer', ['pointer', 'int32'], function (impl, length) {
  return impl(this.handle, length);
});
Env.prototype.newIntArray = proxy(179, 'pointer', ['pointer', 'int32'], function (impl, length) {
  return impl(this.handle, length);
});
Env.prototype.newLongArray = proxy(180, 'pointer', ['pointer', 'int32'], function (impl, length) {
  return impl(this.handle, length);
});
Env.prototype.newFloatArray = proxy(181, 'pointer', ['pointer', 'int32'], function (impl, length) {
  return impl(this.handle, length);
});
Env.prototype.newDoubleArray = proxy(182, 'pointer', ['pointer', 'int32'], function (impl, length) {
  return impl(this.handle, length);
});
Env.prototype.getBooleanArrayElements = proxy(183, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, array) {
  return impl(this.handle, array, NULL);
});
Env.prototype.getByteArrayElements = proxy(184, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, array) {
  return impl(this.handle, array, NULL);
});
Env.prototype.getCharArrayElements = proxy(185, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, array) {
  return impl(this.handle, array, NULL);
});
Env.prototype.getShortArrayElements = proxy(186, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, array) {
  return impl(this.handle, array, NULL);
});
Env.prototype.getIntArrayElements = proxy(187, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, array) {
  return impl(this.handle, array, NULL);
});
Env.prototype.getLongArrayElements = proxy(188, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, array) {
  return impl(this.handle, array, NULL);
});
Env.prototype.getFloatArrayElements = proxy(189, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, array) {
  return impl(this.handle, array, NULL);
});
Env.prototype.getDoubleArrayElements = proxy(190, 'pointer', ['pointer', 'pointer', 'pointer'], function (impl, array) {
  return impl(this.handle, array, NULL);
});
Env.prototype.releaseBooleanArrayElements = proxy(191, 'pointer', ['pointer', 'pointer', 'pointer', 'int32'], function (impl, array, cArray) {
  impl(this.handle, array, cArray, JNI_ABORT);
});
Env.prototype.releaseByteArrayElements = proxy(192, 'pointer', ['pointer', 'pointer', 'pointer', 'int32'], function (impl, array, cArray) {
  impl(this.handle, array, cArray, JNI_ABORT);
});
Env.prototype.releaseCharArrayElements = proxy(193, 'pointer', ['pointer', 'pointer', 'pointer', 'int32'], function (impl, array, cArray) {
  impl(this.handle, array, cArray, JNI_ABORT);
});
Env.prototype.releaseShortArrayElements = proxy(194, 'pointer', ['pointer', 'pointer', 'pointer', 'int32'], function (impl, array, cArray) {
  impl(this.handle, array, cArray, JNI_ABORT);
});
Env.prototype.releaseIntArrayElements = proxy(195, 'pointer', ['pointer', 'pointer', 'pointer', 'int32'], function (impl, array, cArray) {
  impl(this.handle, array, cArray, JNI_ABORT);
});
Env.prototype.releaseLongArrayElements = proxy(196, 'pointer', ['pointer', 'pointer', 'pointer', 'int32'], function (impl, array, cArray) {
  impl(this.handle, array, cArray, JNI_ABORT);
});
Env.prototype.releaseFloatArrayElements = proxy(197, 'pointer', ['pointer', 'pointer', 'pointer', 'int32'], function (impl, array, cArray) {
  impl(this.handle, array, cArray, JNI_ABORT);
});
Env.prototype.releaseDoubleArrayElements = proxy(198, 'pointer', ['pointer', 'pointer', 'pointer', 'int32'], function (impl, array, cArray) {
  impl(this.handle, array, cArray, JNI_ABORT);
});
Env.prototype.setBooleanArrayRegion = proxy(207, 'void', ['pointer', 'pointer', 'int32', 'int32', 'pointer'], function (impl, array, start, length, cArray) {
  impl(this.handle, array, start, length, cArray);
});
Env.prototype.setByteArrayRegion = proxy(208, 'void', ['pointer', 'pointer', 'int32', 'int32', 'pointer'], function (impl, array, start, length, cArray) {
  impl(this.handle, array, start, length, cArray);
});
Env.prototype.setCharArrayRegion = proxy(209, 'void', ['pointer', 'pointer', 'int32', 'int32', 'pointer'], function (impl, array, start, length, cArray) {
  impl(this.handle, array, start, length, cArray);
});
Env.prototype.setShortArrayRegion = proxy(210, 'void', ['pointer', 'pointer', 'int32', 'int32', 'pointer'], function (impl, array, start, length, cArray) {
  impl(this.handle, array, start, length, cArray);
});
Env.prototype.setIntArrayRegion = proxy(211, 'void', ['pointer', 'pointer', 'int32', 'int32', 'pointer'], function (impl, array, start, length, cArray) {
  impl(this.handle, array, start, length, cArray);
});
Env.prototype.setLongArrayRegion = proxy(212, 'void', ['pointer', 'pointer', 'int32', 'int32', 'pointer'], function (impl, array, start, length, cArray) {
  impl(this.handle, array, start, length, cArray);
});
Env.prototype.setFloatArrayRegion = proxy(213, 'void', ['pointer', 'pointer', 'int32', 'int32', 'pointer'], function (impl, array, start, length, cArray) {
  impl(this.handle, array, start, length, cArray);
});
Env.prototype.setDoubleArrayRegion = proxy(214, 'void', ['pointer', 'pointer', 'int32', 'int32', 'pointer'], function (impl, array, start, length, cArray) {
  impl(this.handle, array, start, length, cArray);
});
Env.prototype.registerNatives = proxy(215, 'int32', ['pointer', 'pointer', 'pointer', 'int32'], function (impl, klass, methods, numMethods) {
  return impl(this.handle, klass, methods, numMethods);
});
Env.prototype.monitorEnter = proxy(217, 'int32', ['pointer', 'pointer'], function (impl, obj) {
  return impl(this.handle, obj);
});
Env.prototype.monitorExit = proxy(218, 'int32', ['pointer', 'pointer'], function (impl, obj) {
  return impl(this.handle, obj);
});
Env.prototype.getObjectRefType = proxy(232, 'int32', ['pointer', 'pointer'], function (impl, ref) {
  return impl(this.handle, ref);
});
var cachedPlainMethods = {};
var cachedVaMethods = {};

function plainMethod(offset, retType, argTypes) {
  var key = offset + 'v' + retType + '|' + argTypes.join(':');
  var m = cachedPlainMethods[key];

  if (!m) {
    /* jshint validthis: true */
    m = new NativeFunction(vtable(this).add(offset * pointerSize).readPointer(), retType, ['pointer', 'pointer', 'pointer'].concat(argTypes), nativeFunctionOptions);
    cachedPlainMethods[key] = m;
  }

  return m;
}

function vaMethod(offset, retType, argTypes) {
  var key = offset + 'v' + retType + '|' + argTypes.join(':');
  var m = cachedVaMethods[key];

  if (!m) {
    /* jshint validthis: true */
    m = new NativeFunction(vtable(this).add(offset * pointerSize).readPointer(), retType, ['pointer', 'pointer', 'pointer', '...'].concat(argTypes), nativeFunctionOptions);
    cachedVaMethods[key] = m;
  }

  return m;
}

function nonvirtualVaMethod(offset, retType, argTypes) {
  var key = offset + 'n' + retType + '|' + argTypes.join(':');
  var m = cachedVaMethods[key];

  if (!m) {
    /* jshint validthis: true */
    m = new NativeFunction(vtable(this).add(offset * pointerSize).readPointer(), retType, ['pointer', 'pointer', 'pointer', 'pointer', '...'].concat(argTypes), nativeFunctionOptions);
    cachedVaMethods[key] = m;
  }

  return m;
}

Env.prototype.constructor = function (argTypes) {
  return vaMethod.call(this, CALL_CONSTRUCTOR_METHOD_OFFSET, 'pointer', argTypes);
};

Env.prototype.vaMethod = function (retType, argTypes) {
  var offset = callMethodOffset[retType];

  if (offset === undefined) {
    throw new Error('Unsupported type: ' + retType);
  }

  return vaMethod.call(this, offset, retType, argTypes);
};

Env.prototype.nonvirtualVaMethod = function (retType, argTypes) {
  var offset = callNonvirtualMethodOffset[retType];

  if (offset === undefined) {
    throw new Error('Unsupported type: ' + retType);
  }

  return nonvirtualVaMethod.call(this, offset, retType, argTypes);
};

Env.prototype.staticVaMethod = function (retType, argTypes) {
  var offset = callStaticMethodOffset[retType];

  if (offset === undefined) {
    throw new Error('Unsupported type: ' + retType);
  }

  return vaMethod.call(this, offset, retType, argTypes);
};

Env.prototype.getField = function (fieldType) {
  var offset = getFieldOffset[fieldType];

  if (offset === undefined) {
    throw new Error('Unsupported type: ' + fieldType);
  }

  return plainMethod.call(this, offset, fieldType, []);
};

Env.prototype.getStaticField = function (fieldType) {
  var offset = getStaticFieldOffset[fieldType];

  if (offset === undefined) {
    throw new Error('Unsupported type: ' + fieldType);
  }

  return plainMethod.call(this, offset, fieldType, []);
};

Env.prototype.setField = function (fieldType) {
  var offset = setFieldOffset[fieldType];

  if (offset === undefined) {
    throw new Error('Unsupported type: ' + fieldType);
  }

  return plainMethod.call(this, offset, 'void', [fieldType]);
};

Env.prototype.setStaticField = function (fieldType) {
  var offset = setStaticFieldOffset[fieldType];

  if (offset === undefined) {
    throw new Error('Unsupported type: ' + fieldType);
  }

  return plainMethod.call(this, offset, 'void', [fieldType]);
};

var javaLangClass = null;

Env.prototype.javaLangClass = function () {
  if (javaLangClass === null) {
    var handle = this.findClass('java/lang/Class');

    try {
      javaLangClass = {
        handle: register(this.newGlobalRef(handle)),
        getName: this.getMethodId(handle, 'getName', '()Ljava/lang/String;'),
        getSimpleName: this.getMethodId(handle, 'getSimpleName', '()Ljava/lang/String;'),
        getGenericSuperclass: this.getMethodId(handle, 'getGenericSuperclass', '()Ljava/lang/reflect/Type;'),
        getDeclaredConstructors: this.getMethodId(handle, 'getDeclaredConstructors', '()[Ljava/lang/reflect/Constructor;'),
        getDeclaredMethods: this.getMethodId(handle, 'getDeclaredMethods', '()[Ljava/lang/reflect/Method;'),
        getDeclaredFields: this.getMethodId(handle, 'getDeclaredFields', '()[Ljava/lang/reflect/Field;'),
        isArray: this.getMethodId(handle, 'isArray', '()Z'),
        isPrimitive: this.getMethodId(handle, 'isPrimitive', '()Z'),
        getComponentType: this.getMethodId(handle, 'getComponentType', '()Ljava/lang/Class;')
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangClass;
};

var javaLangObject = null;

Env.prototype.javaLangObject = function () {
  if (javaLangObject === null) {
    var handle = this.findClass('java/lang/Object');

    try {
      javaLangObject = {
        toString: this.getMethodId(handle, 'toString', '()Ljava/lang/String;'),
        getClass: this.getMethodId(handle, 'getClass', '()Ljava/lang/Class;')
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangObject;
};

var javaLangReflectConstructor = null;

Env.prototype.javaLangReflectConstructor = function () {
  if (javaLangReflectConstructor === null) {
    var handle = this.findClass('java/lang/reflect/Constructor');

    try {
      javaLangReflectConstructor = {
        getGenericParameterTypes: this.getMethodId(handle, 'getGenericParameterTypes', '()[Ljava/lang/reflect/Type;')
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangReflectConstructor;
};

var javaLangReflectMethod = null;

Env.prototype.javaLangReflectMethod = function () {
  if (javaLangReflectMethod === null) {
    var handle = this.findClass('java/lang/reflect/Method');

    try {
      javaLangReflectMethod = {
        getName: this.getMethodId(handle, 'getName', '()Ljava/lang/String;'),
        getGenericParameterTypes: this.getMethodId(handle, 'getGenericParameterTypes', '()[Ljava/lang/reflect/Type;'),
        getParameterTypes: this.getMethodId(handle, 'getParameterTypes', '()[Ljava/lang/Class;'),
        getGenericReturnType: this.getMethodId(handle, 'getGenericReturnType', '()Ljava/lang/reflect/Type;'),
        getGenericExceptionTypes: this.getMethodId(handle, 'getGenericExceptionTypes', '()[Ljava/lang/reflect/Type;'),
        getModifiers: this.getMethodId(handle, 'getModifiers', '()I'),
        isVarArgs: this.getMethodId(handle, 'isVarArgs', '()Z')
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangReflectMethod;
};

var javaLangReflectField = null;

Env.prototype.javaLangReflectField = function () {
  if (javaLangReflectField === null) {
    var handle = this.findClass('java/lang/reflect/Field');

    try {
      javaLangReflectField = {
        getName: this.getMethodId(handle, 'getName', '()Ljava/lang/String;'),
        getType: this.getMethodId(handle, 'getType', '()Ljava/lang/Class;'),
        getGenericType: this.getMethodId(handle, 'getGenericType', '()Ljava/lang/reflect/Type;'),
        getModifiers: this.getMethodId(handle, 'getModifiers', '()I'),
        toString: this.getMethodId(handle, 'toString', '()Ljava/lang/String;')
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangReflectField;
};

var javaLangReflectModifier = null;

Env.prototype.javaLangReflectModifier = function () {
  if (javaLangReflectModifier === null) {
    var handle = this.findClass('java/lang/reflect/Modifier');

    try {
      javaLangReflectModifier = {
        PUBLIC: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'PUBLIC', 'I')),
        PRIVATE: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'PRIVATE', 'I')),
        PROTECTED: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'PROTECTED', 'I')),
        STATIC: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'STATIC', 'I')),
        FINAL: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'FINAL', 'I')),
        SYNCHRONIZED: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'SYNCHRONIZED', 'I')),
        VOLATILE: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'VOLATILE', 'I')),
        TRANSIENT: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'TRANSIENT', 'I')),
        NATIVE: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'NATIVE', 'I')),
        INTERFACE: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'INTERFACE', 'I')),
        ABSTRACT: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'ABSTRACT', 'I')),
        STRICT: this.getStaticIntField(handle, this.getStaticFieldId(handle, 'STRICT', 'I'))
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangReflectModifier;
};

var javaLangReflectTypeVariable = null;

Env.prototype.javaLangReflectTypeVariable = function () {
  if (javaLangReflectTypeVariable === null) {
    var handle = this.findClass('java/lang/reflect/TypeVariable');

    try {
      javaLangReflectTypeVariable = {
        handle: register(this.newGlobalRef(handle)),
        getName: this.getMethodId(handle, 'getName', '()Ljava/lang/String;'),
        getBounds: this.getMethodId(handle, 'getBounds', '()[Ljava/lang/reflect/Type;'),
        getGenericDeclaration: this.getMethodId(handle, 'getGenericDeclaration', '()Ljava/lang/reflect/GenericDeclaration;')
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangReflectTypeVariable;
};

var javaLangReflectWildcardType = null;

Env.prototype.javaLangReflectWildcardType = function () {
  if (javaLangReflectWildcardType === null) {
    var handle = this.findClass('java/lang/reflect/WildcardType');

    try {
      javaLangReflectWildcardType = {
        handle: register(this.newGlobalRef(handle)),
        getLowerBounds: this.getMethodId(handle, 'getLowerBounds', '()[Ljava/lang/reflect/Type;'),
        getUpperBounds: this.getMethodId(handle, 'getUpperBounds', '()[Ljava/lang/reflect/Type;')
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangReflectWildcardType;
};

var javaLangReflectGenericArrayType = null;

Env.prototype.javaLangReflectGenericArrayType = function () {
  if (javaLangReflectGenericArrayType === null) {
    var handle = this.findClass('java/lang/reflect/GenericArrayType');

    try {
      javaLangReflectGenericArrayType = {
        handle: register(this.newGlobalRef(handle)),
        getGenericComponentType: this.getMethodId(handle, 'getGenericComponentType', '()Ljava/lang/reflect/Type;')
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangReflectGenericArrayType;
};

var javaLangReflectParameterizedType = null;

Env.prototype.javaLangReflectParameterizedType = function () {
  if (javaLangReflectParameterizedType === null) {
    var handle = this.findClass('java/lang/reflect/ParameterizedType');

    try {
      javaLangReflectParameterizedType = {
        handle: register(this.newGlobalRef(handle)),
        getActualTypeArguments: this.getMethodId(handle, 'getActualTypeArguments', '()[Ljava/lang/reflect/Type;'),
        getRawType: this.getMethodId(handle, 'getRawType', '()Ljava/lang/reflect/Type;'),
        getOwnerType: this.getMethodId(handle, 'getOwnerType', '()Ljava/lang/reflect/Type;')
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangReflectParameterizedType;
};

var javaLangString = null;

Env.prototype.javaLangString = function () {
  if (javaLangString === null) {
    var handle = this.findClass('java/lang/String');

    try {
      javaLangString = {
        handle: register(this.newGlobalRef(handle))
      };
    } finally {
      this.deleteLocalRef(handle);
    }
  }

  return javaLangString;
};

Env.prototype.getClassName = function (classHandle) {
  var name = this.vaMethod('pointer', [])(this.handle, classHandle, this.javaLangClass().getName);

  try {
    return this.stringFromJni(name);
  } finally {
    this.deleteLocalRef(name);
  }
};

Env.prototype.getObjectClassName = function (objHandle) {
  var jklass = this.getObjectClass(objHandle);

  try {
    return this.getClassName(jklass);
  } finally {
    this.deleteLocalRef(jklass);
  }
};

Env.prototype.getActualTypeArgument = function (type) {
  var actualTypeArguments = this.vaMethod('pointer', [])(this.handle, type, this.javaLangReflectParameterizedType().getActualTypeArguments);
  this.checkForExceptionAndThrowIt();

  if (!actualTypeArguments.isNull()) {
    try {
      return this.getTypeNameFromFirstTypeElement(actualTypeArguments);
    } finally {
      this.deleteLocalRef(actualTypeArguments);
    }
  }
};

Env.prototype.getTypeNameFromFirstTypeElement = function (typeArray) {
  var length = this.getArrayLength(typeArray);

  if (length > 0) {
    var typeArgument0 = this.getObjectArrayElement(typeArray, 0);

    try {
      return this.getTypeName(typeArgument0);
    } finally {
      this.deleteLocalRef(typeArgument0);
    }
  } else {
    // TODO
    return 'java.lang.Object';
  }
};

Env.prototype.getTypeName = function (type, getGenericsInformation) {
  var invokeObjectMethodNoArgs = this.vaMethod('pointer', []);

  if (this.isInstanceOf(type, this.javaLangClass().handle)) {
    return this.getClassName(type);
  } else if (this.isInstanceOf(type, this.javaLangReflectGenericArrayType().handle)) {
    return this.getArrayTypeName(type);
  } else if (this.isInstanceOf(type, this.javaLangReflectParameterizedType().handle)) {
    var rawType = invokeObjectMethodNoArgs(this.handle, type, this.javaLangReflectParameterizedType().getRawType);
    this.checkForExceptionAndThrowIt();
    var result;

    try {
      result = this.getTypeName(rawType);
    } finally {
      this.deleteLocalRef(rawType);
    }

    if (getGenericsInformation) {
      result += '<' + this.getActualTypeArgument(type) + '>';
    }

    return result;
  } else if (this.isInstanceOf(type, this.javaLangReflectTypeVariable().handle)) {
    // TODO
    return 'java.lang.Object';
  } else if (this.isInstanceOf(type, this.javaLangReflectWildcardType().handle)) {
    // TODO
    return 'java.lang.Object';
  } else {
    return 'java.lang.Object';
  }
};

Env.prototype.getArrayTypeName = function (type) {
  var invokeObjectMethodNoArgs = this.vaMethod('pointer', []);

  if (this.isInstanceOf(type, this.javaLangClass().handle)) {
    return this.getClassName(type);
  } else if (this.isInstanceOf(type, this.javaLangReflectGenericArrayType().handle)) {
    var componentType = invokeObjectMethodNoArgs(this.handle, type, this.javaLangReflectGenericArrayType().getGenericComponentType); // check for TypeNotPresentException and MalformedParameterizedTypeException

    this.checkForExceptionAndThrowIt();

    try {
      return '[L' + this.getTypeName(componentType) + ';';
    } finally {
      this.deleteLocalRef(componentType);
    }
  } else {
    return '[Ljava.lang.Object;';
  }
};

Env.prototype.stringFromJni = function (str) {
  var utf = this.getStringUtfChars(str);

  if (utf.isNull()) {
    throw new Error("Can't access the string.");
  }

  try {
    return utf.readUtf8String();
  } finally {
    this.releaseStringUtfChars(str, utf);
  }
};

module.exports = Env;
/* global Memory, NativeFunction, NULL, Process, WeakRef */

},{}],6:[function(require,module,exports){
(function (Buffer){
"use strict";

var _interopRequireDefault = require("@babel/runtime-corejs2/helpers/interopRequireDefault");

var _keys = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/keys"));

var _from = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/array/from"));

var _set = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/set"));

var _slicedToArray2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/slicedToArray"));

var _classCallCheck2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/classCallCheck"));

var _createClass2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/createClass"));

var _assign = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/assign"));

module.exports = mkdex;

var SHA1 = require('jssha/src/sha1');

var kAccPublic = 0x0001;
var kAccNative = 0x0100;
var kAccConstructor = 0x00010000;
var kEndianTag = 0x12345678;
var kClassDefSize = 32;
var kProtoIdSize = 12;
var kFieldIdSize = 8;
var kMethodIdSize = 8;
var kTypeIdSize = 4;
var kStringIdSize = 4;
var kMapItemSize = 12;
var TYPE_HEADER_ITEM = 0;
var TYPE_STRING_ID_ITEM = 1;
var TYPE_TYPE_ID_ITEM = 2;
var TYPE_PROTO_ID_ITEM = 3;
var TYPE_FIELD_ID_ITEM = 4;
var TYPE_METHOD_ID_ITEM = 5;
var TYPE_CLASS_DEF_ITEM = 6;
var TYPE_MAP_LIST = 0x1000;
var TYPE_TYPE_LIST = 0x1001;
var TYPE_ANNOTATION_SET_ITEM = 0x1003;
var TYPE_CLASS_DATA_ITEM = 0x2000;
var TYPE_CODE_ITEM = 0x2001;
var TYPE_STRING_DATA_ITEM = 0x2002;
var TYPE_DEBUG_INFO_ITEM = 0x2003;
var TYPE_ANNOTATION_ITEM = 0x2004;
var TYPE_ANNOTATIONS_DIRECTORY_ITEM = 0x2006;
var VALUE_TYPE = 0x18;
var VALUE_ARRAY = 0x1c;
var VISIBILITY_SYSTEM = 2;
var kDefaultConstructorSize = 24;
var kDefaultConstructorDebugInfo = Buffer.from([0x03, 0x00, 0x07, 0x0e, 0x00]);
var kDalvikAnnotationTypeThrows = 'Ldalvik/annotation/Throws;';
var kNullTerminator = Buffer.from([0]);

function mkdex(spec) {
  var builder = new DexBuilder();
  var fullSpec = (0, _assign["default"])({}, spec);
  builder.addClass(fullSpec);
  return builder.build();
}

var DexBuilder =
/*#__PURE__*/
function () {
  function DexBuilder() {
    (0, _classCallCheck2["default"])(this, DexBuilder);
    this.classes = [];
  }

  (0, _createClass2["default"])(DexBuilder, [{
    key: "addClass",
    value: function addClass(spec) {
      this.classes.push(spec);
    }
  }, {
    key: "build",
    value: function build() {
      var model = computeModel(this.classes);
      var classes = model.classes,
          interfaces = model.interfaces,
          fields = model.fields,
          methods = model.methods,
          protos = model.protos,
          parameters = model.parameters,
          annotationDirectories = model.annotationDirectories,
          annotationSets = model.annotationSets,
          throwsAnnotations = model.throwsAnnotations,
          types = model.types,
          strings = model.strings;
      var offset = 0;
      var headerOffset = 0;
      var checksumOffset = 8;
      var signatureOffset = 12;
      var signatureSize = 20;
      var headerSize = 0x70;
      offset += headerSize;
      var stringIdsOffset = offset;
      var stringIdsSize = strings.length * kStringIdSize;
      offset += stringIdsSize;
      var typeIdsOffset = offset;
      var typeIdsSize = types.length * kTypeIdSize;
      offset += typeIdsSize;
      var protoIdsOffset = offset;
      var protoIdsSize = protos.length * kProtoIdSize;
      offset += protoIdsSize;
      var fieldIdsOffset = offset;
      var fieldIdsSize = fields.length * kFieldIdSize;
      offset += fieldIdsSize;
      var methodIdsOffset = offset;
      var methodIdsSize = methods.length * kMethodIdSize;
      offset += methodIdsSize;
      var classDefsOffset = offset;
      var classDefsSize = classes.length * kClassDefSize;
      offset += classDefsSize;
      var dataOffset = offset;
      var annotationSetOffsets = annotationSets.map(function (set) {
        var setOffset = offset;
        set.offset = setOffset;
        offset += 4 + set.items.length * 4;
        return setOffset;
      });
      var javaCodeItems = classes.reduce(function (result, klass) {
        var constructorMethods = klass.classData.constructorMethods;
        constructorMethods.forEach(function (method) {
          var _method = (0, _slicedToArray2["default"])(method, 3),
              accessFlags = _method[1],
              superConstructor = _method[2];

          if ((accessFlags & kAccNative) === 0 && superConstructor >= 0) {
            method.push(offset);
            result.push({
              offset: offset,
              superConstructor: superConstructor
            });
            offset += kDefaultConstructorSize;
          }
        });
        return result;
      }, []);
      annotationDirectories.forEach(function (dir) {
        dir.offset = offset;
        offset += 16 + dir.methods.length * 8;
      });
      var interfaceOffsets = interfaces.map(function (iface) {
        offset = align(offset, 4);
        var ifaceOffset = offset;
        iface.offset = ifaceOffset;
        offset += 4 + 2 * iface.types.length;
        return ifaceOffset;
      });
      var parameterOffsets = parameters.map(function (param) {
        offset = align(offset, 4);
        var paramOffset = offset;
        param.offset = paramOffset;
        offset += 4 + 2 * param.types.length;
        return paramOffset;
      });
      var stringChunks = [];
      var stringOffsets = strings.map(function (str) {
        var strOffset = offset;
        var header = Buffer.from(createUleb128(str.length));
        var data = Buffer.from(str, 'utf8');
        var chunk = Buffer.concat([header, data, kNullTerminator]);
        stringChunks.push(chunk);
        offset += chunk.length;
        return strOffset;
      });
      var debugInfoOffsets = javaCodeItems.map(function (codeItem) {
        var debugOffset = offset;
        offset += kDefaultConstructorDebugInfo.length;
        return debugOffset;
      });
      var throwsAnnotationBlobs = throwsAnnotations.map(function (annotation) {
        var blob = makeThrowsAnnotation(annotation);
        annotation.offset = offset;
        offset += blob.length;
        return blob;
      });
      var classDataBlobs = classes.map(function (klass, index) {
        klass.classData.offset = offset;
        var blob = makeClassData(klass);
        offset += blob.length;
        return blob;
      });
      var linkSize = 0;
      var linkOffset = 0;
      offset = align(offset, 4);
      var mapOffset = offset;
      var typeListLength = interfaces.length + parameters.length;
      var mapNumItems = 4 + (fields.length > 0 ? 1 : 0) + 2 + annotationSets.length + javaCodeItems.length + annotationDirectories.length + (typeListLength > 0 ? 1 : 0) + 1 + debugInfoOffsets.length + throwsAnnotations.length + classes.length + 1;
      var mapSize = 4 + mapNumItems * kMapItemSize;
      offset += mapSize;
      var dataSize = offset - dataOffset;
      var fileSize = offset;
      var dex = Buffer.alloc(fileSize);
      dex.write('dex\n035');
      dex.writeUInt32LE(fileSize, 0x20);
      dex.writeUInt32LE(headerSize, 0x24);
      dex.writeUInt32LE(kEndianTag, 0x28);
      dex.writeUInt32LE(linkSize, 0x2c);
      dex.writeUInt32LE(linkOffset, 0x30);
      dex.writeUInt32LE(mapOffset, 0x34);
      dex.writeUInt32LE(strings.length, 0x38);
      dex.writeUInt32LE(stringIdsOffset, 0x3c);
      dex.writeUInt32LE(types.length, 0x40);
      dex.writeUInt32LE(typeIdsOffset, 0x44);
      dex.writeUInt32LE(protos.length, 0x48);
      dex.writeUInt32LE(protoIdsOffset, 0x4c);
      dex.writeUInt32LE(fields.length, 0x50);
      dex.writeUInt32LE(fields.length > 0 ? fieldIdsOffset : 0, 0x54);
      dex.writeUInt32LE(methods.length, 0x58);
      dex.writeUInt32LE(methodIdsOffset, 0x5c);
      dex.writeUInt32LE(classes.length, 0x60);
      dex.writeUInt32LE(classDefsOffset, 0x64);
      dex.writeUInt32LE(dataSize, 0x68);
      dex.writeUInt32LE(dataOffset, 0x6c);
      stringOffsets.forEach(function (offset, index) {
        dex.writeUInt32LE(offset, stringIdsOffset + index * kStringIdSize);
      });
      types.forEach(function (id, index) {
        dex.writeUInt32LE(id, typeIdsOffset + index * kTypeIdSize);
      });
      protos.forEach(function (proto, index) {
        var _proto = (0, _slicedToArray2["default"])(proto, 3),
            shortyIndex = _proto[0],
            returnTypeIndex = _proto[1],
            params = _proto[2];

        var protoOffset = protoIdsOffset + index * kProtoIdSize;
        dex.writeUInt32LE(shortyIndex, protoOffset);
        dex.writeUInt32LE(returnTypeIndex, protoOffset + 4);
        dex.writeUInt32LE(params !== null ? params.offset : 0, protoOffset + 8);
      });
      fields.forEach(function (field, index) {
        var _field = (0, _slicedToArray2["default"])(field, 3),
            classIndex = _field[0],
            typeIndex = _field[1],
            nameIndex = _field[2];

        var fieldOffset = fieldIdsOffset + index * kFieldIdSize;
        dex.writeUInt16LE(classIndex, fieldOffset);
        dex.writeUInt16LE(typeIndex, fieldOffset + 2);
        dex.writeUInt32LE(nameIndex, fieldOffset + 4);
      });
      methods.forEach(function (method, index) {
        var _method2 = (0, _slicedToArray2["default"])(method, 3),
            classIndex = _method2[0],
            protoIndex = _method2[1],
            nameIndex = _method2[2];

        var methodOffset = methodIdsOffset + index * kMethodIdSize;
        dex.writeUInt16LE(classIndex, methodOffset);
        dex.writeUInt16LE(protoIndex, methodOffset + 2);
        dex.writeUInt32LE(nameIndex, methodOffset + 4);
      });
      classes.forEach(function (klass, index) {
        var interfaces = klass.interfaces,
            annotationsDirectory = klass.annotationsDirectory;
        var interfacesOffset = interfaces !== null ? interfaces.offset : 0;
        var annotationsOffset = annotationsDirectory !== null ? annotationsDirectory.offset : 0;
        var staticValuesOffset = 0;
        var classOffset = classDefsOffset + index * kClassDefSize;
        dex.writeUInt32LE(klass.index, classOffset);
        dex.writeUInt32LE(klass.accessFlags, classOffset + 4);
        dex.writeUInt32LE(klass.superClassIndex, classOffset + 8);
        dex.writeUInt32LE(interfacesOffset, classOffset + 12);
        dex.writeUInt32LE(klass.sourceFileIndex, classOffset + 16);
        dex.writeUInt32LE(annotationsOffset, classOffset + 20);
        dex.writeUInt32LE(klass.classData.offset, classOffset + 24);
        dex.writeUInt32LE(staticValuesOffset, classOffset + 28);
      });
      annotationSets.forEach(function (set, index) {
        var items = set.items;
        var setOffset = annotationSetOffsets[index];
        dex.writeUInt32LE(items.length, setOffset);
        items.forEach(function (item, index) {
          dex.writeUInt32LE(item.offset, setOffset + 4 + index * 4);
        });
      });
      javaCodeItems.forEach(function (codeItem, index) {
        var offset = codeItem.offset,
            superConstructor = codeItem.superConstructor;
        var registersSize = 1;
        var insSize = 1;
        var outsSize = 1;
        var triesSize = 0;
        var insnsSize = 4;
        dex.writeUInt16LE(registersSize, offset);
        dex.writeUInt16LE(insSize, offset + 2);
        dex.writeUInt16LE(outsSize, offset + 4);
        dex.writeUInt16LE(triesSize, offset + 6);
        dex.writeUInt32LE(debugInfoOffsets[index], offset + 8);
        dex.writeUInt32LE(insnsSize, offset + 12);
        dex.writeUInt16LE(0x1070, offset + 16);
        dex.writeUInt16LE(superConstructor, offset + 18);
        dex.writeUInt16LE(0x0000, offset + 20);
        dex.writeUInt16LE(0x000e, offset + 22);
      });
      annotationDirectories.forEach(function (dir) {
        var dirOffset = dir.offset;
        var classAnnotationsOffset = 0;
        var fieldsSize = 0;
        var annotatedMethodsSize = dir.methods.length;
        var annotatedParametersSize = 0;
        dex.writeUInt32LE(classAnnotationsOffset, dirOffset);
        dex.writeUInt32LE(fieldsSize, dirOffset + 4);
        dex.writeUInt32LE(annotatedMethodsSize, dirOffset + 8);
        dex.writeUInt32LE(annotatedParametersSize, dirOffset + 12);
        dir.methods.forEach(function (method, index) {
          var entryOffset = dirOffset + 16 + index * 8;

          var _method3 = (0, _slicedToArray2["default"])(method, 2),
              methodIndex = _method3[0],
              annotationSet = _method3[1];

          dex.writeUInt32LE(methodIndex, entryOffset);
          dex.writeUInt32LE(annotationSet.offset, entryOffset + 4);
        });
      });
      interfaces.forEach(function (iface, index) {
        var ifaceOffset = interfaceOffsets[index];
        dex.writeUInt32LE(iface.types.length, ifaceOffset);
        iface.types.forEach(function (type, typeIndex) {
          dex.writeUInt16LE(type, ifaceOffset + 4 + typeIndex * 2);
        });
      });
      parameters.forEach(function (param, index) {
        var paramOffset = parameterOffsets[index];
        dex.writeUInt32LE(param.types.length, paramOffset);
        param.types.forEach(function (type, typeIndex) {
          dex.writeUInt16LE(type, paramOffset + 4 + typeIndex * 2);
        });
      });
      stringChunks.forEach(function (chunk, index) {
        chunk.copy(dex, stringOffsets[index]);
      });
      debugInfoOffsets.forEach(function (debugInfoOffset) {
        kDefaultConstructorDebugInfo.copy(dex, debugInfoOffset);
      });
      throwsAnnotationBlobs.forEach(function (annotationBlob, index) {
        annotationBlob.copy(dex, throwsAnnotations[index].offset);
      });
      classDataBlobs.forEach(function (classDataBlob, index) {
        classDataBlob.copy(dex, classes[index].classData.offset);
      });
      dex.writeUInt32LE(mapNumItems, mapOffset);
      var mapItems = [[TYPE_HEADER_ITEM, 1, headerOffset], [TYPE_STRING_ID_ITEM, strings.length, stringIdsOffset], [TYPE_TYPE_ID_ITEM, types.length, typeIdsOffset], [TYPE_PROTO_ID_ITEM, protos.length, protoIdsOffset]];

      if (fields.length > 0) {
        mapItems.push([TYPE_FIELD_ID_ITEM, fields.length, fieldIdsOffset]);
      }

      mapItems.push([TYPE_METHOD_ID_ITEM, methods.length, methodIdsOffset]);
      mapItems.push([TYPE_CLASS_DEF_ITEM, classes.length, classDefsOffset]);
      annotationSets.forEach(function (set, index) {
        mapItems.push([TYPE_ANNOTATION_SET_ITEM, set.items.length, annotationSetOffsets[index]]);
      });
      javaCodeItems.forEach(function (codeItem) {
        mapItems.push([TYPE_CODE_ITEM, 1, codeItem.offset]);
      });
      annotationDirectories.forEach(function (dir) {
        mapItems.push([TYPE_ANNOTATIONS_DIRECTORY_ITEM, 1, dir.offset]);
      });

      if (typeListLength > 0) {
        mapItems.push([TYPE_TYPE_LIST, typeListLength, interfaceOffsets.concat(parameterOffsets)[0]]);
      }

      mapItems.push([TYPE_STRING_DATA_ITEM, strings.length, stringOffsets[0]]);
      debugInfoOffsets.forEach(function (debugInfoOffset) {
        mapItems.push([TYPE_DEBUG_INFO_ITEM, 1, debugInfoOffset]);
      });
      throwsAnnotations.forEach(function (annotation) {
        mapItems.push([TYPE_ANNOTATION_ITEM, 1, annotation.offset]);
      });
      classes.forEach(function (klass) {
        mapItems.push([TYPE_CLASS_DATA_ITEM, 1, klass.classData.offset]);
      });
      mapItems.push([TYPE_MAP_LIST, 1, mapOffset]);
      mapItems.forEach(function (item, index) {
        var _item = (0, _slicedToArray2["default"])(item, 3),
            type = _item[0],
            size = _item[1],
            offset = _item[2];

        var itemOffset = mapOffset + 4 + index * kMapItemSize;
        dex.writeUInt16LE(type, itemOffset);
        dex.writeUInt32LE(size, itemOffset + 4);
        dex.writeUInt32LE(offset, itemOffset + 8);
      });
      var hash = new SHA1('SHA-1', 'ARRAYBUFFER');
      hash.update(dex.slice(signatureOffset + signatureSize));
      Buffer.from(hash.getHash('ARRAYBUFFER')).copy(dex, signatureOffset);
      dex.writeUInt32LE(adler32(dex, signatureOffset), checksumOffset);
      return dex;
    }
  }]);
  return DexBuilder;
}();

function makeClassData(klass) {
  var _klass$classData = klass.classData,
      instanceFields = _klass$classData.instanceFields,
      constructorMethods = _klass$classData.constructorMethods,
      virtualMethods = _klass$classData.virtualMethods;
  var staticFieldsSize = 0;
  return Buffer.from([staticFieldsSize].concat(createUleb128(instanceFields.length)).concat(createUleb128(constructorMethods.length)).concat(createUleb128(virtualMethods.length)).concat(instanceFields.reduce(function (result, _ref) {
    var _ref2 = (0, _slicedToArray2["default"])(_ref, 2),
        indexDiff = _ref2[0],
        accessFlags = _ref2[1];

    return result.concat(createUleb128(indexDiff)).concat(createUleb128(accessFlags));
  }, [])).concat(constructorMethods.reduce(function (result, _ref3) {
    var _ref4 = (0, _slicedToArray2["default"])(_ref3, 4),
        indexDiff = _ref4[0],
        accessFlags = _ref4[1],
        codeOffset = _ref4[3];

    return result.concat(createUleb128(indexDiff)).concat(createUleb128(accessFlags)).concat(createUleb128(codeOffset || 0));
  }, [])).concat(virtualMethods.reduce(function (result, _ref5) {
    var _ref6 = (0, _slicedToArray2["default"])(_ref5, 2),
        indexDiff = _ref6[0],
        accessFlags = _ref6[1];

    var codeOffset = 0;
    return result.concat(createUleb128(indexDiff)).concat(createUleb128(accessFlags)).concat([codeOffset]);
  }, [])));
}

function makeThrowsAnnotation(annotation) {
  var thrownTypes = annotation.thrownTypes;
  return Buffer.from([VISIBILITY_SYSTEM].concat(createUleb128(annotation.type)).concat([1]).concat(createUleb128(annotation.value)).concat([VALUE_ARRAY, thrownTypes.length]).concat(thrownTypes.reduce(function (result, type) {
    result.push(VALUE_TYPE, type);
    return result;
  }, [])));
}

function computeModel(classes) {
  var strings = new _set["default"]();
  var types = new _set["default"]();
  var protos = {};
  var fields = [];
  var methods = [];
  var throwsAnnotations = {};
  var javaConstructors = new _set["default"]();
  var superConstructors = new _set["default"]();
  classes.forEach(function (klass) {
    var name = klass.name,
        superClass = klass.superClass,
        sourceFileName = klass.sourceFileName;
    strings.add('this');
    strings.add(name);
    types.add(name);
    strings.add(superClass);
    types.add(superClass);
    strings.add(sourceFileName);
    klass.interfaces.forEach(function (iface) {
      strings.add(iface);
      types.add(iface);
    });
    klass.fields.forEach(function (field) {
      var _field2 = (0, _slicedToArray2["default"])(field, 2),
          fieldName = _field2[0],
          fieldType = _field2[1];

      strings.add(fieldName);
      strings.add(fieldType);
      types.add(fieldType);
      fields.push([klass.name, fieldType, fieldName]);
    });

    if (!klass.methods.some(function (_ref7) {
      var _ref8 = (0, _slicedToArray2["default"])(_ref7, 1),
          methodName = _ref8[0];

      return methodName === '<init>';
    })) {
      klass.methods.unshift(['<init>', 'V', []]);
      javaConstructors.add(name);
    }

    klass.methods.forEach(function (method) {
      var _method4 = (0, _slicedToArray2["default"])(method, 4),
          methodName = _method4[0],
          retType = _method4[1],
          argTypes = _method4[2],
          _method4$ = _method4[3],
          thrownTypes = _method4$ === void 0 ? [] : _method4$;

      strings.add(methodName);
      var protoId = addProto(retType, argTypes);
      var throwsAnnotationId = null;

      if (thrownTypes.length > 0) {
        var typesNormalized = thrownTypes.slice();
        typesNormalized.sort();
        throwsAnnotationId = typesNormalized.join('|');
        var throwsAnnotation = throwsAnnotations[throwsAnnotationId];

        if (throwsAnnotation === undefined) {
          throwsAnnotation = {
            id: throwsAnnotationId,
            types: typesNormalized
          };
          throwsAnnotations[throwsAnnotationId] = throwsAnnotation;
        }

        strings.add(kDalvikAnnotationTypeThrows);
        types.add(kDalvikAnnotationTypeThrows);
        thrownTypes.forEach(function (type) {
          strings.add(type);
          types.add(type);
        });
        strings.add('value');
      }

      methods.push([klass.name, protoId, methodName, throwsAnnotationId]);

      if (methodName === '<init>') {
        superConstructors.add(name + '|' + protoId);
        var superConstructorId = superClass + '|' + protoId;

        if (javaConstructors.has(name) && !superConstructors.has(superConstructorId)) {
          methods.push([superClass, protoId, methodName, null]);
          superConstructors.add(superConstructorId);
        }
      }
    });
  });

  function addProto(retType, argTypes) {
    var signature = [retType].concat(argTypes);
    var id = signature.join('|');

    if (protos[id] !== undefined) {
      return id;
    }

    strings.add(retType);
    types.add(retType);
    argTypes.forEach(function (argType) {
      strings.add(argType);
      types.add(argType);
    });
    var shorty = signature.map(typeToShorty).join('');
    strings.add(shorty);
    protos[id] = [id, shorty, retType, argTypes];
    return id;
  }

  var stringItems = (0, _from["default"])(strings);
  stringItems.sort();
  var stringToIndex = stringItems.reduce(function (result, string, index) {
    result[string] = index;
    return result;
  }, {});
  var typeItems = (0, _from["default"])(types).map(function (name) {
    return stringToIndex[name];
  });
  typeItems.sort(compareNumbers);
  var typeToIndex = typeItems.reduce(function (result, stringIndex, typeIndex) {
    result[stringItems[stringIndex]] = typeIndex;
    return result;
  }, {});
  var literalProtoItems = (0, _keys["default"])(protos).map(function (id) {
    return protos[id];
  });
  literalProtoItems.sort(compareProtoItems);
  var parameters = {};
  var protoItems = literalProtoItems.map(function (item) {
    var _item2 = (0, _slicedToArray2["default"])(item, 4),
        shorty = _item2[1],
        retType = _item2[2],
        argTypes = _item2[3];

    var params;

    if (argTypes.length > 0) {
      var argTypesSig = argTypes.join('|');
      params = parameters[argTypesSig];

      if (params === undefined) {
        params = {
          types: argTypes.map(function (type) {
            return typeToIndex[type];
          }),
          offset: -1
        };
        parameters[argTypesSig] = params;
      }
    } else {
      params = null;
    }

    return [stringToIndex[shorty], typeToIndex[retType], params];
  });
  var protoToIndex = literalProtoItems.reduce(function (result, item, index) {
    var _item3 = (0, _slicedToArray2["default"])(item, 1),
        id = _item3[0];

    result[id] = index;
    return result;
  }, {});
  var parameterItems = (0, _keys["default"])(parameters).map(function (id) {
    return parameters[id];
  });
  var fieldItems = fields.map(function (field) {
    var _field3 = (0, _slicedToArray2["default"])(field, 3),
        klass = _field3[0],
        fieldType = _field3[1],
        fieldName = _field3[2];

    return [typeToIndex[klass], typeToIndex[fieldType], stringToIndex[fieldName]];
  });
  var methodItems = methods.map(function (method) {
    var _method5 = (0, _slicedToArray2["default"])(method, 4),
        klass = _method5[0],
        protoId = _method5[1],
        name = _method5[2],
        annotationsId = _method5[3];

    return [typeToIndex[klass], protoToIndex[protoId], stringToIndex[name], annotationsId];
  });
  methodItems.sort(compareMethodItems);
  var throwsAnnotationItems = (0, _keys["default"])(throwsAnnotations).map(function (id) {
    return throwsAnnotations[id];
  }).map(function (item) {
    return {
      id: item.id,
      type: typeToIndex[kDalvikAnnotationTypeThrows],
      value: stringToIndex['value'],
      thrownTypes: item.types.map(function (type) {
        return typeToIndex[type];
      }),
      offset: -1
    };
  });
  var annotationSetItems = throwsAnnotationItems.map(function (item) {
    return {
      id: item.id,
      items: [item],
      offset: -1
    };
  });
  var annotationSetIdToIndex = annotationSetItems.reduce(function (result, item, index) {
    result[item.id] = index;
    return result;
  }, {});
  var interfaceLists = {};
  var annotationDirectories = [];
  var classItems = classes.map(function (klass) {
    var classIndex = typeToIndex[klass.name];
    var accessFlags = kAccPublic;
    var superClassIndex = typeToIndex[klass.superClass];
    var ifaceList;
    var ifaces = klass.interfaces.map(function (type) {
      return typeToIndex[type];
    });

    if (ifaces.length > 0) {
      ifaces.sort(compareNumbers);
      var ifacesId = ifaces.join('|');
      ifaceList = interfaceLists[ifacesId];

      if (ifaceList === undefined) {
        ifaceList = {
          types: ifaces,
          offset: -1
        };
        interfaceLists[ifacesId] = ifaceList;
      }
    } else {
      ifaceList = null;
    }

    var sourceFileIndex = stringToIndex[klass.sourceFileName];
    var classMethods = methodItems.reduce(function (result, method, index) {
      var _method6 = (0, _slicedToArray2["default"])(method, 4),
          holder = _method6[0],
          protoIndex = _method6[1],
          name = _method6[2],
          annotationsId = _method6[3];

      if (holder === classIndex) {
        result.push([index, name, annotationsId, protoIndex]);
      }

      return result;
    }, []);
    var annotationsDirectory = null;
    var methodAnnotations = classMethods.filter(function (_ref9) {
      var _ref10 = (0, _slicedToArray2["default"])(_ref9, 3),
          annotationsId = _ref10[2];

      return annotationsId !== null;
    }).map(function (_ref11) {
      var _ref12 = (0, _slicedToArray2["default"])(_ref11, 3),
          index = _ref12[0],
          annotationsId = _ref12[2];

      return [index, annotationSetItems[annotationSetIdToIndex[annotationsId]]];
    });

    if (methodAnnotations.length > 0) {
      annotationsDirectory = {
        methods: methodAnnotations,
        offset: -1
      };
      annotationDirectories.push(annotationsDirectory);
    }

    var instanceFields = fieldItems.reduce(function (result, field, index) {
      var _field4 = (0, _slicedToArray2["default"])(field, 1),
          holder = _field4[0];

      if (holder === classIndex) {
        result.push([index, kAccPublic]);
      }

      return result;
    }, []);
    var constructorNameIndex = stringToIndex['<init>'];
    var constructorMethods = classMethods.filter(function (_ref13) {
      var _ref14 = (0, _slicedToArray2["default"])(_ref13, 2),
          name = _ref14[1];

      return name === constructorNameIndex;
    }).map(function (_ref15) {
      var _ref16 = (0, _slicedToArray2["default"])(_ref15, 4),
          index = _ref16[0],
          protoIndex = _ref16[3];

      if (javaConstructors.has(klass.name)) {
        var superConstructor = -1;
        var numMethodItems = methodItems.length;

        for (var i = 0; i !== numMethodItems; i++) {
          var _methodItems$i = (0, _slicedToArray2["default"])(methodItems[i], 3),
              methodClass = _methodItems$i[0],
              methodProto = _methodItems$i[1],
              methodName = _methodItems$i[2];

          if (methodClass === superClassIndex && methodName === constructorNameIndex && methodProto === protoIndex) {
            superConstructor = i;
            break;
          }
        }

        return [index, kAccPublic | kAccConstructor, superConstructor];
      } else {
        return [index, kAccPublic | kAccConstructor | kAccNative, -1];
      }
    });
    var virtualMethods = compressClassMethodIndexes(classMethods.filter(function (_ref17) {
      var _ref18 = (0, _slicedToArray2["default"])(_ref17, 2),
          name = _ref18[1];

      return name !== constructorNameIndex;
    }).map(function (_ref19) {
      var _ref20 = (0, _slicedToArray2["default"])(_ref19, 1),
          index = _ref20[0];

      return [index, kAccPublic | kAccNative];
    }));
    var classData = {
      instanceFields: instanceFields,
      constructorMethods: constructorMethods,
      virtualMethods: virtualMethods,
      offset: -1
    };
    return {
      index: classIndex,
      accessFlags: accessFlags,
      superClassIndex: superClassIndex,
      interfaces: ifaceList,
      sourceFileIndex: sourceFileIndex,
      annotationsDirectory: annotationsDirectory,
      classData: classData
    };
  });
  var interfaceItems = (0, _keys["default"])(interfaceLists).map(function (id) {
    return interfaceLists[id];
  });
  return {
    classes: classItems,
    interfaces: interfaceItems,
    fields: fieldItems,
    methods: methodItems,
    protos: protoItems,
    parameters: parameterItems,
    annotationDirectories: annotationDirectories,
    annotationSets: annotationSetItems,
    throwsAnnotations: throwsAnnotationItems,
    types: typeItems,
    strings: stringItems
  };
}

function compressClassMethodIndexes(items) {
  var previousIndex = 0;
  return items.map(function (_ref21, elementIndex) {
    var _ref22 = (0, _slicedToArray2["default"])(_ref21, 2),
        index = _ref22[0],
        accessFlags = _ref22[1];

    var result;

    if (elementIndex === 0) {
      result = [index, accessFlags];
    } else {
      result = [index - previousIndex, accessFlags];
    }

    previousIndex = index;
    return result;
  });
}

function compareNumbers(a, b) {
  return a - b;
}

function compareProtoItems(a, b) {
  var _a = (0, _slicedToArray2["default"])(a, 4),
      aRetType = _a[2],
      aArgTypes = _a[3];

  var _b = (0, _slicedToArray2["default"])(b, 4),
      bRetType = _b[2],
      bArgTypes = _b[3];

  if (aRetType < bRetType) {
    return -1;
  }

  if (aRetType > bRetType) {
    return 1;
  }

  var aArgTypesSig = aArgTypes.join('|');
  var bArgTypesSig = bArgTypes.join('|');

  if (aArgTypesSig < bArgTypesSig) {
    return -1;
  }

  if (aArgTypesSig > bArgTypesSig) {
    return 1;
  }

  return 0;
}

function compareMethodItems(a, b) {
  var _a2 = (0, _slicedToArray2["default"])(a, 3),
      aClass = _a2[0],
      aProto = _a2[1],
      aName = _a2[2];

  var _b2 = (0, _slicedToArray2["default"])(b, 3),
      bClass = _b2[0],
      bProto = _b2[1],
      bName = _b2[2];

  if (aClass !== bClass) {
    return aClass - bClass;
  }

  if (aName !== bName) {
    return aName - bName;
  }

  return aProto - bProto;
}

function typeToShorty(type) {
  var firstCharacter = type[0];
  return firstCharacter === 'L' || firstCharacter === '[' ? 'L' : type;
}

function createUleb128(value) {
  if (value <= 0x7f) {
    return [value];
  }

  var result = [];
  var moreSlicesNeeded = false;

  do {
    var slice = value & 0x7f;
    value >>= 7;
    moreSlicesNeeded = value !== 0;

    if (moreSlicesNeeded) {
      slice |= 0x80;
    }

    result.push(slice);
  } while (moreSlicesNeeded);

  return result;
}

function align(value, alignment) {
  var alignmentDelta = value % alignment;

  if (alignmentDelta === 0) {
    return value;
  }

  return value + alignment - alignmentDelta;
}

function adler32(buffer, offset) {
  var a = 1;
  var b = 0;
  var length = buffer.length;

  for (var i = offset; i < length; i++) {
    a = (a + buffer[i]) % 65521;
    b = (b + a) % 65521;
  }

  return (b << 16 | a) >>> 0;
}

}).call(this,require("buffer").Buffer)

},{"@babel/runtime-corejs2/core-js/array/from":11,"@babel/runtime-corejs2/core-js/object/assign":16,"@babel/runtime-corejs2/core-js/object/keys":23,"@babel/runtime-corejs2/core-js/set":29,"@babel/runtime-corejs2/helpers/classCallCheck":38,"@babel/runtime-corejs2/helpers/createClass":40,"@babel/runtime-corejs2/helpers/interopRequireDefault":44,"@babel/runtime-corejs2/helpers/slicedToArray":51,"buffer":204,"jssha/src/sha1":9}],7:[function(require,module,exports){
"use strict";

var JNI_OK = 0;

function checkJniResult(name, result) {
  if (result !== JNI_OK) {
    throw new Error(name + ' failed: ' + result);
  }
}

module.exports = {
  checkJniResult: checkJniResult,
  JNI_OK: 0
};

},{}],8:[function(require,module,exports){
"use strict";

var Env = require('./env');

var _require = require('./result'),
    JNI_OK = _require.JNI_OK,
    checkJniResult = _require.checkJniResult;

var JNI_VERSION_1_6 = 0x00010006;
var pointerSize = Process.pointerSize;

function VM(api) {
  var handle = null;
  var attachCurrentThread = null;
  var detachCurrentThread = null;
  var getEnv = null;
  var attachedThreads = {};

  function initialize() {
    handle = api.vm;
    var vtable = handle.readPointer();
    var options = {
      exceptions: 'propagate'
    };
    attachCurrentThread = new NativeFunction(vtable.add(4 * pointerSize).readPointer(), 'int32', ['pointer', 'pointer', 'pointer'], options);
    detachCurrentThread = new NativeFunction(vtable.add(5 * pointerSize).readPointer(), 'int32', ['pointer'], options);
    getEnv = new NativeFunction(vtable.add(6 * pointerSize).readPointer(), 'int32', ['pointer', 'pointer', 'int32'], options);
  }

  this.perform = function (fn) {
    var threadId = null;
    var env = this.tryGetEnv();
    var alreadyAttached = env !== null;

    if (!alreadyAttached) {
      env = this.attachCurrentThread();
      threadId = Process.getCurrentThreadId();
      attachedThreads[threadId] = true;
    }

    try {
      fn();
    } finally {
      if (!alreadyAttached) {
        var allowedToDetach = attachedThreads[threadId];
        delete attachedThreads[threadId];

        if (allowedToDetach) {
          this.detachCurrentThread();
        }
      }
    }
  };

  this.attachCurrentThread = function () {
    var envBuf = Memory.alloc(pointerSize);
    checkJniResult('VM::AttachCurrentThread', attachCurrentThread(handle, envBuf, NULL));
    return new Env(envBuf.readPointer(), this);
  };

  this.detachCurrentThread = function () {
    checkJniResult('VM::DetachCurrentThread', detachCurrentThread(handle));
  };

  this.preventDetachDueToClassLoader = function () {
    var threadId = Process.getCurrentThreadId();

    if (threadId in attachedThreads) {
      attachedThreads[threadId] = false;
    }
  };

  this.getEnv = function () {
    var envBuf = Memory.alloc(pointerSize);
    var result = getEnv(handle, envBuf, JNI_VERSION_1_6);

    if (result === -2) {
      throw new Error('Current thread is not attached to the Java VM; please move this code inside a Java.perform() callback');
    }

    checkJniResult('VM::GetEnv', result);
    return new Env(envBuf.readPointer(), this);
  };

  this.tryGetEnv = function () {
    var envBuf = Memory.alloc(pointerSize);
    var result = getEnv(handle, envBuf, JNI_VERSION_1_6);

    if (result !== JNI_OK) {
      return null;
    }

    return new Env(envBuf.readPointer(), this);
  };

  initialize.call(this);
}

module.exports = VM;
/* global Memory, NativeFunction, NULL, Process */

},{"./env":5,"./result":7}],9:[function(require,module,exports){
/*
 A JavaScript implementation of the SHA family of hashes, as
 defined in FIPS PUB 180-4 and FIPS PUB 202, as well as the corresponding
 HMAC implementation as defined in FIPS PUB 198a

 Copyright Brian Turek 2008-2017
 Distributed under the BSD License
 See http://caligatio.github.com/jsSHA/ for more information

 Several functions taken from Paul Johnston
*/
'use strict';

var _interopRequireDefault = require("@babel/runtime-corejs2/helpers/interopRequireDefault");

var _parseInt2 = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/parse-int"));

(function (G) {
  function r(d, b, c) {
    var h = 0,
        a = [],
        f = 0,
        g,
        m,
        k,
        e,
        l,
        p,
        q,
        t,
        w = !1,
        n = [],
        u = [],
        v,
        r = !1;
    c = c || {};
    g = c.encoding || "UTF8";
    v = c.numRounds || 1;
    if (v !== (0, _parseInt2["default"])(v, 10) || 1 > v) throw Error("numRounds must a integer >= 1");
    if ("SHA-1" === d) l = 512, p = z, q = H, e = 160, t = function t(a) {
      return a.slice();
    };else throw Error("Chosen SHA variant is not supported");
    k = A(b, g);
    m = x(d);

    this.setHMACKey = function (a, f, b) {
      var c;
      if (!0 === w) throw Error("HMAC key already set");
      if (!0 === r) throw Error("Cannot set HMAC key after calling update");
      g = (b || {}).encoding || "UTF8";
      f = A(f, g)(a);
      a = f.binLen;
      f = f.value;
      c = l >>> 3;
      b = c / 4 - 1;

      if (c < a / 8) {
        for (f = q(f, a, 0, x(d), e); f.length <= b;) {
          f.push(0);
        }

        f[b] &= 4294967040;
      } else if (c > a / 8) {
        for (; f.length <= b;) {
          f.push(0);
        }

        f[b] &= 4294967040;
      }

      for (a = 0; a <= b; a += 1) {
        n[a] = f[a] ^ 909522486, u[a] = f[a] ^ 1549556828;
      }

      m = p(n, m);
      h = l;
      w = !0;
    };

    this.update = function (b) {
      var e,
          g,
          c,
          d = 0,
          q = l >>> 5;
      e = k(b, a, f);
      b = e.binLen;
      g = e.value;
      e = b >>> 5;

      for (c = 0; c < e; c += q) {
        d + l <= b && (m = p(g.slice(c, c + q), m), d += l);
      }

      h += d;
      a = g.slice(d >>> 5);
      f = b % l;
      r = !0;
    };

    this.getHash = function (b, g) {
      var c, k, l, p;
      if (!0 === w) throw Error("Cannot call getHash after setting HMAC key");
      l = B(g);

      switch (b) {
        case "HEX":
          c = function c(a) {
            return C(a, e, l);
          };

          break;

        case "B64":
          c = function c(a) {
            return D(a, e, l);
          };

          break;

        case "BYTES":
          c = function c(a) {
            return E(a, e);
          };

          break;

        case "ARRAYBUFFER":
          try {
            k = new ArrayBuffer(0);
          } catch (I) {
            throw Error("ARRAYBUFFER not supported by this environment");
          }

          c = function c(a) {
            return F(a, e);
          };

          break;

        default:
          throw Error("format must be HEX, B64, BYTES, or ARRAYBUFFER");
      }

      p = q(a.slice(), f, h, t(m), e);

      for (k = 1; k < v; k += 1) {
        p = q(p, e, 0, x(d), e);
      }

      return c(p);
    };

    this.getHMAC = function (b, g) {
      var c, k, n, r;
      if (!1 === w) throw Error("Cannot call getHMAC without first setting HMAC key");
      n = B(g);

      switch (b) {
        case "HEX":
          c = function c(a) {
            return C(a, e, n);
          };

          break;

        case "B64":
          c = function c(a) {
            return D(a, e, n);
          };

          break;

        case "BYTES":
          c = function c(a) {
            return E(a, e);
          };

          break;

        case "ARRAYBUFFER":
          try {
            c = new ArrayBuffer(0);
          } catch (I) {
            throw Error("ARRAYBUFFER not supported by this environment");
          }

          c = function c(a) {
            return F(a, e);
          };

          break;

        default:
          throw Error("outputFormat must be HEX, B64, BYTES, or ARRAYBUFFER");
      }

      k = q(a.slice(), f, h, t(m), e);
      r = p(u, x(d));
      r = q(k, e, l, r, e);
      return c(r);
    };
  }

  function C(d, b, c) {
    var h = "";
    b /= 8;
    var a, f;

    for (a = 0; a < b; a += 1) {
      f = d[a >>> 2] >>> 8 * (3 + a % 4 * -1), h += "0123456789abcdef".charAt(f >>> 4 & 15) + "0123456789abcdef".charAt(f & 15);
    }

    return c.outputUpper ? h.toUpperCase() : h;
  }

  function D(d, b, c) {
    var h = "",
        a = b / 8,
        f,
        g,
        m;

    for (f = 0; f < a; f += 3) {
      for (g = f + 1 < a ? d[f + 1 >>> 2] : 0, m = f + 2 < a ? d[f + 2 >>> 2] : 0, m = (d[f >>> 2] >>> 8 * (3 + f % 4 * -1) & 255) << 16 | (g >>> 8 * (3 + (f + 1) % 4 * -1) & 255) << 8 | m >>> 8 * (3 + (f + 2) % 4 * -1) & 255, g = 0; 4 > g; g += 1) {
        8 * f + 6 * g <= b ? h += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charAt(m >>> 6 * (3 - g) & 63) : h += c.b64Pad;
      }
    }

    return h;
  }

  function E(d, b) {
    var c = "",
        h = b / 8,
        a,
        f;

    for (a = 0; a < h; a += 1) {
      f = d[a >>> 2] >>> 8 * (3 + a % 4 * -1) & 255, c += String.fromCharCode(f);
    }

    return c;
  }

  function F(d, b) {
    var c = b / 8,
        h,
        a = new ArrayBuffer(c),
        f;
    f = new Uint8Array(a);

    for (h = 0; h < c; h += 1) {
      f[h] = d[h >>> 2] >>> 8 * (3 + h % 4 * -1) & 255;
    }

    return a;
  }

  function B(d) {
    var b = {
      outputUpper: !1,
      b64Pad: "=",
      shakeLen: -1
    };
    d = d || {};
    b.outputUpper = d.outputUpper || !1;
    !0 === d.hasOwnProperty("b64Pad") && (b.b64Pad = d.b64Pad);
    if ("boolean" !== typeof b.outputUpper) throw Error("Invalid outputUpper formatting option");
    if ("string" !== typeof b.b64Pad) throw Error("Invalid b64Pad formatting option");
    return b;
  }

  function A(d, b) {
    var c;

    switch (b) {
      case "UTF8":
      case "UTF16BE":
      case "UTF16LE":
        break;

      default:
        throw Error("encoding must be UTF8, UTF16BE, or UTF16LE");
    }

    switch (d) {
      case "HEX":
        c = function c(b, a, f) {
          var g = b.length,
              c,
              d,
              e,
              l,
              p;
          if (0 !== g % 2) throw Error("String of HEX type must be in byte increments");
          a = a || [0];
          f = f || 0;
          p = f >>> 3;

          for (c = 0; c < g; c += 2) {
            d = (0, _parseInt2["default"])(b.substr(c, 2), 16);
            if (isNaN(d)) throw Error("String of HEX type contains invalid characters");
            l = (c >>> 1) + p;

            for (e = l >>> 2; a.length <= e;) {
              a.push(0);
            }

            a[e] |= d << 8 * (3 + l % 4 * -1);
          }

          return {
            value: a,
            binLen: 4 * g + f
          };
        };

        break;

      case "TEXT":
        c = function c(_c, a, f) {
          var g,
              d,
              k = 0,
              e,
              l,
              p,
              q,
              t,
              n;
          a = a || [0];
          f = f || 0;
          p = f >>> 3;
          if ("UTF8" === b) for (n = 3, e = 0; e < _c.length; e += 1) {
            for (g = _c.charCodeAt(e), d = [], 128 > g ? d.push(g) : 2048 > g ? (d.push(192 | g >>> 6), d.push(128 | g & 63)) : 55296 > g || 57344 <= g ? d.push(224 | g >>> 12, 128 | g >>> 6 & 63, 128 | g & 63) : (e += 1, g = 65536 + ((g & 1023) << 10 | _c.charCodeAt(e) & 1023), d.push(240 | g >>> 18, 128 | g >>> 12 & 63, 128 | g >>> 6 & 63, 128 | g & 63)), l = 0; l < d.length; l += 1) {
              t = k + p;

              for (q = t >>> 2; a.length <= q;) {
                a.push(0);
              }

              a[q] |= d[l] << 8 * (n + t % 4 * -1);
              k += 1;
            }
          } else if ("UTF16BE" === b || "UTF16LE" === b) for (n = 2, d = "UTF16LE" === b && !0 || "UTF16LE" !== b && !1, e = 0; e < _c.length; e += 1) {
            g = _c.charCodeAt(e);
            !0 === d && (l = g & 255, g = l << 8 | g >>> 8);
            t = k + p;

            for (q = t >>> 2; a.length <= q;) {
              a.push(0);
            }

            a[q] |= g << 8 * (n + t % 4 * -1);
            k += 2;
          }
          return {
            value: a,
            binLen: 8 * k + f
          };
        };

        break;

      case "B64":
        c = function c(b, a, f) {
          var c = 0,
              d,
              k,
              e,
              l,
              p,
              q,
              n;
          if (-1 === b.search(/^[a-zA-Z0-9=+\/]+$/)) throw Error("Invalid character in base-64 string");
          k = b.indexOf("=");
          b = b.replace(/\=/g, "");
          if (-1 !== k && k < b.length) throw Error("Invalid '=' found in base-64 string");
          a = a || [0];
          f = f || 0;
          q = f >>> 3;

          for (k = 0; k < b.length; k += 4) {
            p = b.substr(k, 4);

            for (e = l = 0; e < p.length; e += 1) {
              d = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(p[e]), l |= d << 18 - 6 * e;
            }

            for (e = 0; e < p.length - 1; e += 1) {
              n = c + q;

              for (d = n >>> 2; a.length <= d;) {
                a.push(0);
              }

              a[d] |= (l >>> 16 - 8 * e & 255) << 8 * (3 + n % 4 * -1);
              c += 1;
            }
          }

          return {
            value: a,
            binLen: 8 * c + f
          };
        };

        break;

      case "BYTES":
        c = function c(b, a, _c2) {
          var d, m, k, e, l;
          a = a || [0];
          _c2 = _c2 || 0;
          k = _c2 >>> 3;

          for (m = 0; m < b.length; m += 1) {
            d = b.charCodeAt(m), l = m + k, e = l >>> 2, a.length <= e && a.push(0), a[e] |= d << 8 * (3 + l % 4 * -1);
          }

          return {
            value: a,
            binLen: 8 * b.length + _c2
          };
        };

        break;

      case "ARRAYBUFFER":
        try {
          c = new ArrayBuffer(0);
        } catch (h) {
          throw Error("ARRAYBUFFER not supported by this environment");
        }

        c = function c(b, a, _c3) {
          var d, m, k, e, l;
          a = a || [0];
          _c3 = _c3 || 0;
          m = _c3 >>> 3;
          l = new Uint8Array(b);

          for (d = 0; d < b.byteLength; d += 1) {
            e = d + m, k = e >>> 2, a.length <= k && a.push(0), a[k] |= l[d] << 8 * (3 + e % 4 * -1);
          }

          return {
            value: a,
            binLen: 8 * b.byteLength + _c3
          };
        };

        break;

      default:
        throw Error("format must be HEX, TEXT, B64, BYTES, or ARRAYBUFFER");
    }

    return c;
  }

  function n(d, b) {
    return d << b | d >>> 32 - b;
  }

  function u(d, b) {
    var c = (d & 65535) + (b & 65535);
    return ((d >>> 16) + (b >>> 16) + (c >>> 16) & 65535) << 16 | c & 65535;
  }

  function y(d, b, c, h, a) {
    var f = (d & 65535) + (b & 65535) + (c & 65535) + (h & 65535) + (a & 65535);
    return ((d >>> 16) + (b >>> 16) + (c >>> 16) + (h >>> 16) + (a >>> 16) + (f >>> 16) & 65535) << 16 | f & 65535;
  }

  function x(d) {
    var b = [];
    if ("SHA-1" === d) b = [1732584193, 4023233417, 2562383102, 271733878, 3285377520];else throw Error("No SHA variants supported");
    return b;
  }

  function z(d, b) {
    var c = [],
        h,
        a,
        f,
        g,
        m,
        k,
        e;
    h = b[0];
    a = b[1];
    f = b[2];
    g = b[3];
    m = b[4];

    for (e = 0; 80 > e; e += 1) {
      c[e] = 16 > e ? d[e] : n(c[e - 3] ^ c[e - 8] ^ c[e - 14] ^ c[e - 16], 1), k = 20 > e ? y(n(h, 5), a & f ^ ~a & g, m, 1518500249, c[e]) : 40 > e ? y(n(h, 5), a ^ f ^ g, m, 1859775393, c[e]) : 60 > e ? y(n(h, 5), a & f ^ a & g ^ f & g, m, 2400959708, c[e]) : y(n(h, 5), a ^ f ^ g, m, 3395469782, c[e]), m = g, g = f, f = n(a, 30), a = h, h = k;
    }

    b[0] = u(h, b[0]);
    b[1] = u(a, b[1]);
    b[2] = u(f, b[2]);
    b[3] = u(g, b[3]);
    b[4] = u(m, b[4]);
    return b;
  }

  function H(d, b, c, h) {
    var a;

    for (a = (b + 65 >>> 9 << 4) + 15; d.length <= a;) {
      d.push(0);
    }

    d[b >>> 5] |= 128 << 24 - b % 32;
    b += c;
    d[a] = b & 4294967295;
    d[a - 1] = b / 4294967296 | 0;
    b = d.length;

    for (a = 0; a < b; a += 16) {
      h = z(d.slice(a, a + 16), h);
    }

    return h;
  }

  "function" === typeof define && define.amd ? define(function () {
    return r;
  }) : "undefined" !== typeof exports ? ("undefined" !== typeof module && module.exports && (module.exports = r), exports = r) : G.jsSHA = r;
})(void 0);

},{"@babel/runtime-corejs2/core-js/parse-int":25,"@babel/runtime-corejs2/helpers/interopRequireDefault":44}],10:[function(require,module,exports){
"use strict";

var _interopRequireDefault = require("@babel/runtime-corejs2/helpers/interopRequireDefault");

var _typeof2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/typeof"));

var _keys = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/keys"));

var Java = require('frida-java-bridge');

var linebreak = "\n";

function miniLog(methodname, arg_type, arg_dump, ret_type, retvar) {
  console.log('[+]' + methodname + "(" + arg_type + ")");
  console.log("Return: (" + ret_type + ")" + retvar);
  console.log(arg_dump);
}

function dumpObject(obj) {
  for (var cn in obj) {
    console.log(String(cn) + " : " + (0, _keys["default"])(obj[cn]));
  }
}

Java.perform(function () {
  console.log("In da house..hook_tpl.js");
  var DexClassLoader = Java.use("dalvik.system.DexClassLoader");

  DexClassLoader.loadClass.overload('java.lang.String').implementation = function () {
    var ret_class = this.loadClass.apply(this, arguments);

    if (String(this).includes("/data/local/tmp/dyhello.dex")) {
      var active_classloader = ret_class.getClassLoader();
      var orig_cl = Java.classFactory.loader;
      Java.classFactory.loader = active_classloader; // console.log("++++++++++++++++++++++++++++++++++")
      // if(Java.classFactory.classes_loaders !== undefined){
      //     dumpObject(Java.classFactory.classes_loaders)
      // }
      // else{
      //     console.log("Empty classes_loaders..")
      // }
      // console.log("++++++++++++++++++++++++++++++++++")

      var c_DyHello_hook = Java.use("com.hao.hello.DyHello", {
        useLoaderCache: 'enable'
      }); // console.log(c_DyHello_hook.$classWrapper.__name__)

      var overloadz_DyHello_hook = eval("c_DyHello_hook.hello.overloads");
      var ovl_count_DyHello_hook = overloadz_DyHello_hook.length;
      var c_DyHello_hook_hello_hook = null;

      for (var i = 0; i < ovl_count_DyHello_hook; i++) {
        var c_DyHello_hook_hello_hook = eval('c_DyHello_hook.hello.overloads[i]');

        c_DyHello_hook_hello_hook.implementation = function () {
          var sendback = '';
          var hook_signature = '-hoo00ook-';
          var arg_dump = '';
          var arg_type = '';
          var ret_type = String(c_DyHello_hook_hello_hook.returnType['className']);
          var retval = null;

          for (var index = 0; index < arguments.length; index++) {
            arg_type += 'argType' + index.toString() + " : " + String((0, _typeof2["default"])(arguments[index])) + ' ';
            arg_dump += "arg" + index.toString() + ": " + String(arguments[index]) + linebreak;
          }

          try {
            retval = eval('this.hello.apply(this, arguments)');
          } catch (err) {
            retval = null;
            console.log("Exception - cannot compute retval.." + String(err));
          }

          console.log("[+] com.hao.hello.DyHello.hello invoked.." + String(retval)); // miniLog("com.hao.hello.DyHello.hello", String(arg_type), String(arg_dump), String(ret_type), String(retval))

          return retval;
        };
      }

      Java.classFactory.loader = orig_cl;
    }

    return ret_class;
  };
});

},{"@babel/runtime-corejs2/core-js/object/keys":23,"@babel/runtime-corejs2/helpers/interopRequireDefault":44,"@babel/runtime-corejs2/helpers/typeof":54,"frida-java-bridge":1}],11:[function(require,module,exports){
module.exports = require("core-js/library/fn/array/from");
},{"core-js/library/fn/array/from":58}],12:[function(require,module,exports){
module.exports = require("core-js/library/fn/array/is-array");
},{"core-js/library/fn/array/is-array":59}],13:[function(require,module,exports){
module.exports = require("core-js/library/fn/get-iterator");
},{"core-js/library/fn/get-iterator":60}],14:[function(require,module,exports){
module.exports = require("core-js/library/fn/is-iterable");
},{"core-js/library/fn/is-iterable":61}],15:[function(require,module,exports){
module.exports = require("core-js/library/fn/number/is-integer");
},{"core-js/library/fn/number/is-integer":62}],16:[function(require,module,exports){
module.exports = require("core-js/library/fn/object/assign");
},{"core-js/library/fn/object/assign":63}],17:[function(require,module,exports){
module.exports = require("core-js/library/fn/object/create");
},{"core-js/library/fn/object/create":64}],18:[function(require,module,exports){
module.exports = require("core-js/library/fn/object/define-properties");
},{"core-js/library/fn/object/define-properties":65}],19:[function(require,module,exports){
module.exports = require("core-js/library/fn/object/define-property");
},{"core-js/library/fn/object/define-property":66}],20:[function(require,module,exports){
module.exports = require("core-js/library/fn/object/get-own-property-descriptor");
},{"core-js/library/fn/object/get-own-property-descriptor":67}],21:[function(require,module,exports){
module.exports = require("core-js/library/fn/object/get-own-property-names");
},{"core-js/library/fn/object/get-own-property-names":68}],22:[function(require,module,exports){
module.exports = require("core-js/library/fn/object/get-prototype-of");
},{"core-js/library/fn/object/get-prototype-of":69}],23:[function(require,module,exports){
module.exports = require("core-js/library/fn/object/keys");
},{"core-js/library/fn/object/keys":70}],24:[function(require,module,exports){
module.exports = require("core-js/library/fn/object/set-prototype-of");
},{"core-js/library/fn/object/set-prototype-of":71}],25:[function(require,module,exports){
module.exports = require("core-js/library/fn/parse-int");
},{"core-js/library/fn/parse-int":72}],26:[function(require,module,exports){
module.exports = require("core-js/library/fn/promise");
},{"core-js/library/fn/promise":73}],27:[function(require,module,exports){
module.exports = require("core-js/library/fn/reflect/construct");
},{"core-js/library/fn/reflect/construct":74}],28:[function(require,module,exports){
module.exports = require("core-js/library/fn/reflect/get");
},{"core-js/library/fn/reflect/get":75}],29:[function(require,module,exports){
module.exports = require("core-js/library/fn/set");
},{"core-js/library/fn/set":76}],30:[function(require,module,exports){
module.exports = require("core-js/library/fn/symbol");
},{"core-js/library/fn/symbol":78}],31:[function(require,module,exports){
module.exports = require("core-js/library/fn/symbol/for");
},{"core-js/library/fn/symbol/for":77}],32:[function(require,module,exports){
module.exports = require("core-js/library/fn/symbol/iterator");
},{"core-js/library/fn/symbol/iterator":79}],33:[function(require,module,exports){
module.exports = require("core-js/library/fn/symbol/species");
},{"core-js/library/fn/symbol/species":80}],34:[function(require,module,exports){
module.exports = require("core-js/library/fn/symbol/to-primitive");
},{"core-js/library/fn/symbol/to-primitive":81}],35:[function(require,module,exports){
var _Array$isArray = require("../core-js/array/is-array");

function _arrayWithHoles(arr) {
  if (_Array$isArray(arr)) return arr;
}

module.exports = _arrayWithHoles;
},{"../core-js/array/is-array":12}],36:[function(require,module,exports){
var _Array$isArray = require("../core-js/array/is-array");

function _arrayWithoutHoles(arr) {
  if (_Array$isArray(arr)) {
    for (var i = 0, arr2 = new Array(arr.length); i < arr.length; i++) {
      arr2[i] = arr[i];
    }

    return arr2;
  }
}

module.exports = _arrayWithoutHoles;
},{"../core-js/array/is-array":12}],37:[function(require,module,exports){
function _assertThisInitialized(self) {
  if (self === void 0) {
    throw new ReferenceError("this hasn't been initialised - super() hasn't been called");
  }

  return self;
}

module.exports = _assertThisInitialized;
},{}],38:[function(require,module,exports){
function _classCallCheck(instance, Constructor) {
  if (!(instance instanceof Constructor)) {
    throw new TypeError("Cannot call a class as a function");
  }
}

module.exports = _classCallCheck;
},{}],39:[function(require,module,exports){
var _Reflect$construct = require("../core-js/reflect/construct");

var setPrototypeOf = require("./setPrototypeOf");

function isNativeReflectConstruct() {
  if (typeof Reflect === "undefined" || !_Reflect$construct) return false;
  if (_Reflect$construct.sham) return false;
  if (typeof Proxy === "function") return true;

  try {
    Date.prototype.toString.call(_Reflect$construct(Date, [], function () {}));
    return true;
  } catch (e) {
    return false;
  }
}

function _construct(Parent, args, Class) {
  if (isNativeReflectConstruct()) {
    module.exports = _construct = _Reflect$construct;
  } else {
    module.exports = _construct = function _construct(Parent, args, Class) {
      var a = [null];
      a.push.apply(a, args);
      var Constructor = Function.bind.apply(Parent, a);
      var instance = new Constructor();
      if (Class) setPrototypeOf(instance, Class.prototype);
      return instance;
    };
  }

  return _construct.apply(null, arguments);
}

module.exports = _construct;
},{"../core-js/reflect/construct":27,"./setPrototypeOf":50}],40:[function(require,module,exports){
var _Object$defineProperty = require("../core-js/object/define-property");

function _defineProperties(target, props) {
  for (var i = 0; i < props.length; i++) {
    var descriptor = props[i];
    descriptor.enumerable = descriptor.enumerable || false;
    descriptor.configurable = true;
    if ("value" in descriptor) descriptor.writable = true;

    _Object$defineProperty(target, descriptor.key, descriptor);
  }
}

function _createClass(Constructor, protoProps, staticProps) {
  if (protoProps) _defineProperties(Constructor.prototype, protoProps);
  if (staticProps) _defineProperties(Constructor, staticProps);
  return Constructor;
}

module.exports = _createClass;
},{"../core-js/object/define-property":19}],41:[function(require,module,exports){
var _Object$getOwnPropertyDescriptor = require("../core-js/object/get-own-property-descriptor");

var _Reflect$get = require("../core-js/reflect/get");

var superPropBase = require("./superPropBase");

function _get(target, property, receiver) {
  if (typeof Reflect !== "undefined" && _Reflect$get) {
    module.exports = _get = _Reflect$get;
  } else {
    module.exports = _get = function _get(target, property, receiver) {
      var base = superPropBase(target, property);
      if (!base) return;

      var desc = _Object$getOwnPropertyDescriptor(base, property);

      if (desc.get) {
        return desc.get.call(receiver);
      }

      return desc.value;
    };
  }

  return _get(target, property, receiver || target);
}

module.exports = _get;
},{"../core-js/object/get-own-property-descriptor":20,"../core-js/reflect/get":28,"./superPropBase":52}],42:[function(require,module,exports){
var _Object$getPrototypeOf = require("../core-js/object/get-prototype-of");

var _Object$setPrototypeOf = require("../core-js/object/set-prototype-of");

function _getPrototypeOf(o) {
  module.exports = _getPrototypeOf = _Object$setPrototypeOf ? _Object$getPrototypeOf : function _getPrototypeOf(o) {
    return o.__proto__ || _Object$getPrototypeOf(o);
  };
  return _getPrototypeOf(o);
}

module.exports = _getPrototypeOf;
},{"../core-js/object/get-prototype-of":22,"../core-js/object/set-prototype-of":24}],43:[function(require,module,exports){
var _Object$create = require("../core-js/object/create");

var setPrototypeOf = require("./setPrototypeOf");

function _inherits(subClass, superClass) {
  if (typeof superClass !== "function" && superClass !== null) {
    throw new TypeError("Super expression must either be null or a function");
  }

  subClass.prototype = _Object$create(superClass && superClass.prototype, {
    constructor: {
      value: subClass,
      writable: true,
      configurable: true
    }
  });
  if (superClass) setPrototypeOf(subClass, superClass);
}

module.exports = _inherits;
},{"../core-js/object/create":17,"./setPrototypeOf":50}],44:[function(require,module,exports){
function _interopRequireDefault(obj) {
  return obj && obj.__esModule ? obj : {
    "default": obj
  };
}

module.exports = _interopRequireDefault;
},{}],45:[function(require,module,exports){
var _Array$from = require("../core-js/array/from");

var _isIterable = require("../core-js/is-iterable");

function _iterableToArray(iter) {
  if (_isIterable(Object(iter)) || Object.prototype.toString.call(iter) === "[object Arguments]") return _Array$from(iter);
}

module.exports = _iterableToArray;
},{"../core-js/array/from":11,"../core-js/is-iterable":14}],46:[function(require,module,exports){
var _getIterator = require("../core-js/get-iterator");

var _isIterable = require("../core-js/is-iterable");

function _iterableToArrayLimit(arr, i) {
  if (!(_isIterable(Object(arr)) || Object.prototype.toString.call(arr) === "[object Arguments]")) {
    return;
  }

  var _arr = [];
  var _n = true;
  var _d = false;
  var _e = undefined;

  try {
    for (var _i = _getIterator(arr), _s; !(_n = (_s = _i.next()).done); _n = true) {
      _arr.push(_s.value);

      if (i && _arr.length === i) break;
    }
  } catch (err) {
    _d = true;
    _e = err;
  } finally {
    try {
      if (!_n && _i["return"] != null) _i["return"]();
    } finally {
      if (_d) throw _e;
    }
  }

  return _arr;
}

module.exports = _iterableToArrayLimit;
},{"../core-js/get-iterator":13,"../core-js/is-iterable":14}],47:[function(require,module,exports){
function _nonIterableRest() {
  throw new TypeError("Invalid attempt to destructure non-iterable instance");
}

module.exports = _nonIterableRest;
},{}],48:[function(require,module,exports){
function _nonIterableSpread() {
  throw new TypeError("Invalid attempt to spread non-iterable instance");
}

module.exports = _nonIterableSpread;
},{}],49:[function(require,module,exports){
var _typeof = require("../helpers/typeof");

var assertThisInitialized = require("./assertThisInitialized");

function _possibleConstructorReturn(self, call) {
  if (call && (_typeof(call) === "object" || typeof call === "function")) {
    return call;
  }

  return assertThisInitialized(self);
}

module.exports = _possibleConstructorReturn;
},{"../helpers/typeof":54,"./assertThisInitialized":37}],50:[function(require,module,exports){
var _Object$setPrototypeOf = require("../core-js/object/set-prototype-of");

function _setPrototypeOf(o, p) {
  module.exports = _setPrototypeOf = _Object$setPrototypeOf || function _setPrototypeOf(o, p) {
    o.__proto__ = p;
    return o;
  };

  return _setPrototypeOf(o, p);
}

module.exports = _setPrototypeOf;
},{"../core-js/object/set-prototype-of":24}],51:[function(require,module,exports){
var arrayWithHoles = require("./arrayWithHoles");

var iterableToArrayLimit = require("./iterableToArrayLimit");

var nonIterableRest = require("./nonIterableRest");

function _slicedToArray(arr, i) {
  return arrayWithHoles(arr) || iterableToArrayLimit(arr, i) || nonIterableRest();
}

module.exports = _slicedToArray;
},{"./arrayWithHoles":35,"./iterableToArrayLimit":46,"./nonIterableRest":47}],52:[function(require,module,exports){
var getPrototypeOf = require("./getPrototypeOf");

function _superPropBase(object, property) {
  while (!Object.prototype.hasOwnProperty.call(object, property)) {
    object = getPrototypeOf(object);
    if (object === null) break;
  }

  return object;
}

module.exports = _superPropBase;
},{"./getPrototypeOf":42}],53:[function(require,module,exports){
var arrayWithoutHoles = require("./arrayWithoutHoles");

var iterableToArray = require("./iterableToArray");

var nonIterableSpread = require("./nonIterableSpread");

function _toConsumableArray(arr) {
  return arrayWithoutHoles(arr) || iterableToArray(arr) || nonIterableSpread();
}

module.exports = _toConsumableArray;
},{"./arrayWithoutHoles":36,"./iterableToArray":45,"./nonIterableSpread":48}],54:[function(require,module,exports){
var _Symbol$iterator = require("../core-js/symbol/iterator");

var _Symbol = require("../core-js/symbol");

function _typeof(obj) {
  if (typeof _Symbol === "function" && typeof _Symbol$iterator === "symbol") {
    module.exports = _typeof = function _typeof(obj) {
      return typeof obj;
    };
  } else {
    module.exports = _typeof = function _typeof(obj) {
      return obj && typeof _Symbol === "function" && obj.constructor === _Symbol && obj !== _Symbol.prototype ? "symbol" : typeof obj;
    };
  }

  return _typeof(obj);
}

module.exports = _typeof;
},{"../core-js/symbol":30,"../core-js/symbol/iterator":32}],55:[function(require,module,exports){
module.exports = require("regenerator-runtime");

},{"regenerator-runtime":206}],56:[function(require,module,exports){
'use strict';

exports.byteLength = byteLength;
exports.toByteArray = toByteArray;
exports.fromByteArray = fromByteArray;
var lookup = [];
var revLookup = [];
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array;
var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i];
  revLookup[code.charCodeAt(i)] = i;
} // Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications


revLookup['-'.charCodeAt(0)] = 62;
revLookup['_'.charCodeAt(0)] = 63;

function getLens(b64) {
  var len = b64.length;

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4');
  } // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42


  var validLen = b64.indexOf('=');
  if (validLen === -1) validLen = len;
  var placeHoldersLen = validLen === len ? 0 : 4 - validLen % 4;
  return [validLen, placeHoldersLen];
} // base64 is 4/3 + up to two characters of the original data


function byteLength(b64) {
  var lens = getLens(b64);
  var validLen = lens[0];
  var placeHoldersLen = lens[1];
  return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
}

function _byteLength(b64, validLen, placeHoldersLen) {
  return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
}

function toByteArray(b64) {
  var tmp;
  var lens = getLens(b64);
  var validLen = lens[0];
  var placeHoldersLen = lens[1];
  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));
  var curByte = 0; // if there are placeholders, only get up to the last complete 4 chars

  var len = placeHoldersLen > 0 ? validLen - 4 : validLen;
  var i;

  for (i = 0; i < len; i += 4) {
    tmp = revLookup[b64.charCodeAt(i)] << 18 | revLookup[b64.charCodeAt(i + 1)] << 12 | revLookup[b64.charCodeAt(i + 2)] << 6 | revLookup[b64.charCodeAt(i + 3)];
    arr[curByte++] = tmp >> 16 & 0xFF;
    arr[curByte++] = tmp >> 8 & 0xFF;
    arr[curByte++] = tmp & 0xFF;
  }

  if (placeHoldersLen === 2) {
    tmp = revLookup[b64.charCodeAt(i)] << 2 | revLookup[b64.charCodeAt(i + 1)] >> 4;
    arr[curByte++] = tmp & 0xFF;
  }

  if (placeHoldersLen === 1) {
    tmp = revLookup[b64.charCodeAt(i)] << 10 | revLookup[b64.charCodeAt(i + 1)] << 4 | revLookup[b64.charCodeAt(i + 2)] >> 2;
    arr[curByte++] = tmp >> 8 & 0xFF;
    arr[curByte++] = tmp & 0xFF;
  }

  return arr;
}

function tripletToBase64(num) {
  return lookup[num >> 18 & 0x3F] + lookup[num >> 12 & 0x3F] + lookup[num >> 6 & 0x3F] + lookup[num & 0x3F];
}

function encodeChunk(uint8, start, end) {
  var tmp;
  var output = [];

  for (var i = start; i < end; i += 3) {
    tmp = (uint8[i] << 16 & 0xFF0000) + (uint8[i + 1] << 8 & 0xFF00) + (uint8[i + 2] & 0xFF);
    output.push(tripletToBase64(tmp));
  }

  return output.join('');
}

function fromByteArray(uint8) {
  var tmp;
  var len = uint8.length;
  var extraBytes = len % 3; // if we have 1 byte left, pad 2 bytes

  var parts = [];
  var maxChunkLength = 16383; // must be multiple of 3
  // go through the array every three bytes, we'll deal with trailing stuff later

  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, i + maxChunkLength > len2 ? len2 : i + maxChunkLength));
  } // pad the end with zeros, but make sure to not forget the extra bytes


  if (extraBytes === 1) {
    tmp = uint8[len - 1];
    parts.push(lookup[tmp >> 2] + lookup[tmp << 4 & 0x3F] + '==');
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1];
    parts.push(lookup[tmp >> 10] + lookup[tmp >> 4 & 0x3F] + lookup[tmp << 2 & 0x3F] + '=');
  }

  return parts.join('');
}

},{}],57:[function(require,module,exports){
(function (Buffer){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */

/* eslint-disable no-proto */
'use strict';

var _interopRequireDefault = require("@babel/runtime-corejs2/helpers/interopRequireDefault");

var _parseInt2 = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/parse-int"));

var _isArray = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/array/is-array"));

var _toPrimitive = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/symbol/to-primitive"));

var _typeof2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/typeof"));

var _species = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/symbol/species"));

var _defineProperty = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/define-property"));

var _setPrototypeOf = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/set-prototype-of"));

var _for = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/symbol/for"));

var _symbol = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/symbol"));

var base64 = require('base64-js');

var ieee754 = require('ieee754');

var customInspectSymbol = typeof _symbol["default"] === 'function' && typeof _for["default"] === 'function' ? (0, _for["default"])('nodejs.util.inspect.custom') : null;
exports.Buffer = Buffer;
exports.SlowBuffer = SlowBuffer;
exports.INSPECT_MAX_BYTES = 50;
var K_MAX_LENGTH = 0x7fffffff;
exports.kMaxLength = K_MAX_LENGTH;
/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */

Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport();

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' && typeof console.error === 'function') {
  console.error('This browser lacks typed array (Uint8Array) support which is required by ' + '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.');
}

function typedArraySupport() {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1);
    var proto = {
      foo: function foo() {
        return 42;
      }
    };
    (0, _setPrototypeOf["default"])(proto, Uint8Array.prototype);
    (0, _setPrototypeOf["default"])(arr, proto);
    return arr.foo() === 42;
  } catch (e) {
    return false;
  }
}

(0, _defineProperty["default"])(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function get() {
    if (!Buffer.isBuffer(this)) return undefined;
    return this.buffer;
  }
});
(0, _defineProperty["default"])(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function get() {
    if (!Buffer.isBuffer(this)) return undefined;
    return this.byteOffset;
  }
});

function createBuffer(length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"');
  } // Return an augmented `Uint8Array` instance


  var buf = new Uint8Array(length);
  (0, _setPrototypeOf["default"])(buf, Buffer.prototype);
  return buf;
}
/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */


function Buffer(arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError('The "string" argument must be of type string. Received type number');
    }

    return allocUnsafe(arg);
  }

  return from(arg, encodingOrOffset, length);
} // Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97


if (typeof _symbol["default"] !== 'undefined' && _species["default"] != null && Buffer[_species["default"]] === Buffer) {
  (0, _defineProperty["default"])(Buffer, _species["default"], {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  });
}

Buffer.poolSize = 8192; // not used by this implementation

function from(value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset);
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value);
  }

  if (value == null) {
    throw new TypeError('The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' + 'or Array-like Object. Received type ' + (0, _typeof2["default"])(value));
  }

  if (isInstance(value, ArrayBuffer) || value && isInstance(value.buffer, ArrayBuffer)) {
    return fromArrayBuffer(value, encodingOrOffset, length);
  }

  if (typeof value === 'number') {
    throw new TypeError('The "value" argument must not be of type number. Received type number');
  }

  var valueOf = value.valueOf && value.valueOf();

  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length);
  }

  var b = fromObject(value);
  if (b) return b;

  if (typeof _symbol["default"] !== 'undefined' && _toPrimitive["default"] != null && typeof value[_toPrimitive["default"]] === 'function') {
    return Buffer.from(value[_toPrimitive["default"]]('string'), encodingOrOffset, length);
  }

  throw new TypeError('The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' + 'or Array-like Object. Received type ' + (0, _typeof2["default"])(value));
}
/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/


Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length);
}; // Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148


(0, _setPrototypeOf["default"])(Buffer.prototype, Uint8Array.prototype);
(0, _setPrototypeOf["default"])(Buffer, Uint8Array);

function assertSize(size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number');
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"');
  }
}

function alloc(size, fill, encoding) {
  assertSize(size);

  if (size <= 0) {
    return createBuffer(size);
  }

  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string' ? createBuffer(size).fill(fill, encoding) : createBuffer(size).fill(fill);
  }

  return createBuffer(size);
}
/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/


Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding);
};

function allocUnsafe(size) {
  assertSize(size);
  return createBuffer(size < 0 ? 0 : checked(size) | 0);
}
/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */


Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size);
};
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */


Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size);
};

function fromString(string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8';
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding);
  }

  var length = byteLength(string, encoding) | 0;
  var buf = createBuffer(length);
  var actual = buf.write(string, encoding);

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual);
  }

  return buf;
}

function fromArrayLike(array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0;
  var buf = createBuffer(length);

  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255;
  }

  return buf;
}

function fromArrayBuffer(array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds');
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds');
  }

  var buf;

  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array);
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset);
  } else {
    buf = new Uint8Array(array, byteOffset, length);
  } // Return an augmented `Uint8Array` instance


  (0, _setPrototypeOf["default"])(buf, Buffer.prototype);
  return buf;
}

function fromObject(obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0;
    var buf = createBuffer(len);

    if (buf.length === 0) {
      return buf;
    }

    obj.copy(buf, 0, 0, len);
    return buf;
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0);
    }

    return fromArrayLike(obj);
  }

  if (obj.type === 'Buffer' && (0, _isArray["default"])(obj.data)) {
    return fromArrayLike(obj.data);
  }
}

function checked(length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' + 'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes');
  }

  return length | 0;
}

function SlowBuffer(length) {
  if (+length != length) {
    // eslint-disable-line eqeqeq
    length = 0;
  }

  return Buffer.alloc(+length);
}

Buffer.isBuffer = function isBuffer(b) {
  return b != null && b._isBuffer === true && b !== Buffer.prototype; // so Buffer.isBuffer(Buffer.prototype) will be false
};

Buffer.compare = function compare(a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength);
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength);

  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array');
  }

  if (a === b) return 0;
  var x = a.length;
  var y = b.length;

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i];
      y = b[i];
      break;
    }
  }

  if (x < y) return -1;
  if (y < x) return 1;
  return 0;
};

Buffer.isEncoding = function isEncoding(encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true;

    default:
      return false;
  }
};

Buffer.concat = function concat(list, length) {
  if (!(0, _isArray["default"])(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers');
  }

  if (list.length === 0) {
    return Buffer.alloc(0);
  }

  var i;

  if (length === undefined) {
    length = 0;

    for (i = 0; i < list.length; ++i) {
      length += list[i].length;
    }
  }

  var buffer = Buffer.allocUnsafe(length);
  var pos = 0;

  for (i = 0; i < list.length; ++i) {
    var buf = list[i];

    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf);
    }

    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers');
    }

    buf.copy(buffer, pos);
    pos += buf.length;
  }

  return buffer;
};

function byteLength(string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length;
  }

  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength;
  }

  if (typeof string !== 'string') {
    throw new TypeError('The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' + 'Received type ' + (0, _typeof2["default"])(string));
  }

  var len = string.length;
  var mustMatch = arguments.length > 2 && arguments[2] === true;
  if (!mustMatch && len === 0) return 0; // Use a for loop to avoid recursion

  var loweredCase = false;

  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len;

      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length;

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2;

      case 'hex':
        return len >>> 1;

      case 'base64':
        return base64ToBytes(string).length;

      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length; // assume utf8
        }

        encoding = ('' + encoding).toLowerCase();
        loweredCase = true;
    }
  }
}

Buffer.byteLength = byteLength;

function slowToString(encoding, start, end) {
  var loweredCase = false; // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.
  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.

  if (start === undefined || start < 0) {
    start = 0;
  } // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.


  if (start > this.length) {
    return '';
  }

  if (end === undefined || end > this.length) {
    end = this.length;
  }

  if (end <= 0) {
    return '';
  } // Force coersion to uint32. This will also coerce falsey/NaN values to 0.


  end >>>= 0;
  start >>>= 0;

  if (end <= start) {
    return '';
  }

  if (!encoding) encoding = 'utf8';

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end);

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end);

      case 'ascii':
        return asciiSlice(this, start, end);

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end);

      case 'base64':
        return base64Slice(this, start, end);

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end);

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding);
        encoding = (encoding + '').toLowerCase();
        loweredCase = true;
    }
  }
} // This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154


Buffer.prototype._isBuffer = true;

function swap(b, n, m) {
  var i = b[n];
  b[n] = b[m];
  b[m] = i;
}

Buffer.prototype.swap16 = function swap16() {
  var len = this.length;

  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits');
  }

  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1);
  }

  return this;
};

Buffer.prototype.swap32 = function swap32() {
  var len = this.length;

  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits');
  }

  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3);
    swap(this, i + 1, i + 2);
  }

  return this;
};

Buffer.prototype.swap64 = function swap64() {
  var len = this.length;

  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits');
  }

  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7);
    swap(this, i + 1, i + 6);
    swap(this, i + 2, i + 5);
    swap(this, i + 3, i + 4);
  }

  return this;
};

Buffer.prototype.toString = function toString() {
  var length = this.length;
  if (length === 0) return '';
  if (arguments.length === 0) return utf8Slice(this, 0, length);
  return slowToString.apply(this, arguments);
};

Buffer.prototype.toLocaleString = Buffer.prototype.toString;

Buffer.prototype.equals = function equals(b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer');
  if (this === b) return true;
  return Buffer.compare(this, b) === 0;
};

Buffer.prototype.inspect = function inspect() {
  var str = '';
  var max = exports.INSPECT_MAX_BYTES;
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim();
  if (this.length > max) str += ' ... ';
  return '<Buffer ' + str + '>';
};

if (customInspectSymbol) {
  Buffer.prototype[customInspectSymbol] = Buffer.prototype.inspect;
}

Buffer.prototype.compare = function compare(target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength);
  }

  if (!Buffer.isBuffer(target)) {
    throw new TypeError('The "target" argument must be one of type Buffer or Uint8Array. ' + 'Received type ' + (0, _typeof2["default"])(target));
  }

  if (start === undefined) {
    start = 0;
  }

  if (end === undefined) {
    end = target ? target.length : 0;
  }

  if (thisStart === undefined) {
    thisStart = 0;
  }

  if (thisEnd === undefined) {
    thisEnd = this.length;
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index');
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0;
  }

  if (thisStart >= thisEnd) {
    return -1;
  }

  if (start >= end) {
    return 1;
  }

  start >>>= 0;
  end >>>= 0;
  thisStart >>>= 0;
  thisEnd >>>= 0;
  if (this === target) return 0;
  var x = thisEnd - thisStart;
  var y = end - start;
  var len = Math.min(x, y);
  var thisCopy = this.slice(thisStart, thisEnd);
  var targetCopy = target.slice(start, end);

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i];
      y = targetCopy[i];
      break;
    }
  }

  if (x < y) return -1;
  if (y < x) return 1;
  return 0;
}; // Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf


function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1; // Normalize byteOffset

  if (typeof byteOffset === 'string') {
    encoding = byteOffset;
    byteOffset = 0;
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff;
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000;
  }

  byteOffset = +byteOffset; // Coerce to Number.

  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : buffer.length - 1;
  } // Normalize byteOffset: negative offsets start from the end of the buffer


  if (byteOffset < 0) byteOffset = buffer.length + byteOffset;

  if (byteOffset >= buffer.length) {
    if (dir) return -1;else byteOffset = buffer.length - 1;
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0;else return -1;
  } // Normalize val


  if (typeof val === 'string') {
    val = Buffer.from(val, encoding);
  } // Finally, search either indexOf (if dir is true) or lastIndexOf


  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1;
    }

    return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
  } else if (typeof val === 'number') {
    val = val & 0xFF; // Search for a byte value [0-255]

    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
      }
    }

    return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
  }

  throw new TypeError('val must be string, number or Buffer');
}

function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
  var indexSize = 1;
  var arrLength = arr.length;
  var valLength = val.length;

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase();

    if (encoding === 'ucs2' || encoding === 'ucs-2' || encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1;
      }

      indexSize = 2;
      arrLength /= 2;
      valLength /= 2;
      byteOffset /= 2;
    }
  }

  function read(buf, i) {
    if (indexSize === 1) {
      return buf[i];
    } else {
      return buf.readUInt16BE(i * indexSize);
    }
  }

  var i;

  if (dir) {
    var foundIndex = -1;

    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i;
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize;
      } else {
        if (foundIndex !== -1) i -= i - foundIndex;
        foundIndex = -1;
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength;

    for (i = byteOffset; i >= 0; i--) {
      var found = true;

      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false;
          break;
        }
      }

      if (found) return i;
    }
  }

  return -1;
}

Buffer.prototype.includes = function includes(val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1;
};

Buffer.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
};

Buffer.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
};

function hexWrite(buf, string, offset, length) {
  offset = Number(offset) || 0;
  var remaining = buf.length - offset;

  if (!length) {
    length = remaining;
  } else {
    length = Number(length);

    if (length > remaining) {
      length = remaining;
    }
  }

  var strLen = string.length;

  if (length > strLen / 2) {
    length = strLen / 2;
  }

  for (var i = 0; i < length; ++i) {
    var parsed = (0, _parseInt2["default"])(string.substr(i * 2, 2), 16);
    if (numberIsNaN(parsed)) return i;
    buf[offset + i] = parsed;
  }

  return i;
}

function utf8Write(buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
}

function asciiWrite(buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length);
}

function latin1Write(buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length);
}

function base64Write(buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length);
}

function ucs2Write(buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
}

Buffer.prototype.write = function write(string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8';
    length = this.length;
    offset = 0; // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset;
    length = this.length;
    offset = 0; // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0;

    if (isFinite(length)) {
      length = length >>> 0;
      if (encoding === undefined) encoding = 'utf8';
    } else {
      encoding = length;
      length = undefined;
    }
  } else {
    throw new Error('Buffer.write(string, encoding, offset[, length]) is no longer supported');
  }

  var remaining = this.length - offset;
  if (length === undefined || length > remaining) length = remaining;

  if (string.length > 0 && (length < 0 || offset < 0) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds');
  }

  if (!encoding) encoding = 'utf8';
  var loweredCase = false;

  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length);

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length);

      case 'ascii':
        return asciiWrite(this, string, offset, length);

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length);

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length);

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length);

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding);
        encoding = ('' + encoding).toLowerCase();
        loweredCase = true;
    }
  }
};

Buffer.prototype.toJSON = function toJSON() {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  };
};

function base64Slice(buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf);
  } else {
    return base64.fromByteArray(buf.slice(start, end));
  }
}

function utf8Slice(buf, start, end) {
  end = Math.min(buf.length, end);
  var res = [];
  var i = start;

  while (i < end) {
    var firstByte = buf[i];
    var codePoint = null;
    var bytesPerSequence = firstByte > 0xEF ? 4 : firstByte > 0xDF ? 3 : firstByte > 0xBF ? 2 : 1;

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint;

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte;
          }

          break;

        case 2:
          secondByte = buf[i + 1];

          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | secondByte & 0x3F;

            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint;
            }
          }

          break;

        case 3:
          secondByte = buf[i + 1];
          thirdByte = buf[i + 2];

          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | thirdByte & 0x3F;

            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint;
            }
          }

          break;

        case 4:
          secondByte = buf[i + 1];
          thirdByte = buf[i + 2];
          fourthByte = buf[i + 3];

          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | fourthByte & 0x3F;

            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint;
            }
          }

      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD;
      bytesPerSequence = 1;
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000;
      res.push(codePoint >>> 10 & 0x3FF | 0xD800);
      codePoint = 0xDC00 | codePoint & 0x3FF;
    }

    res.push(codePoint);
    i += bytesPerSequence;
  }

  return decodeCodePointsArray(res);
} // Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety


var MAX_ARGUMENTS_LENGTH = 0x1000;

function decodeCodePointsArray(codePoints) {
  var len = codePoints.length;

  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints); // avoid extra slice()
  } // Decode in chunks to avoid "call stack size exceeded".


  var res = '';
  var i = 0;

  while (i < len) {
    res += String.fromCharCode.apply(String, codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH));
  }

  return res;
}

function asciiSlice(buf, start, end) {
  var ret = '';
  end = Math.min(buf.length, end);

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F);
  }

  return ret;
}

function latin1Slice(buf, start, end) {
  var ret = '';
  end = Math.min(buf.length, end);

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i]);
  }

  return ret;
}

function hexSlice(buf, start, end) {
  var len = buf.length;
  if (!start || start < 0) start = 0;
  if (!end || end < 0 || end > len) end = len;
  var out = '';

  for (var i = start; i < end; ++i) {
    out += hexSliceLookupTable[buf[i]];
  }

  return out;
}

function utf16leSlice(buf, start, end) {
  var bytes = buf.slice(start, end);
  var res = '';

  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
  }

  return res;
}

Buffer.prototype.slice = function slice(start, end) {
  var len = this.length;
  start = ~~start;
  end = end === undefined ? len : ~~end;

  if (start < 0) {
    start += len;
    if (start < 0) start = 0;
  } else if (start > len) {
    start = len;
  }

  if (end < 0) {
    end += len;
    if (end < 0) end = 0;
  } else if (end > len) {
    end = len;
  }

  if (end < start) end = start;
  var newBuf = this.subarray(start, end); // Return an augmented `Uint8Array` instance

  (0, _setPrototypeOf["default"])(newBuf, Buffer.prototype);
  return newBuf;
};
/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */


function checkOffset(offset, ext, length) {
  if (offset % 1 !== 0 || offset < 0) throw new RangeError('offset is not uint');
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length');
}

Buffer.prototype.readUIntLE = function readUIntLE(offset, byteLength, noAssert) {
  offset = offset >>> 0;
  byteLength = byteLength >>> 0;
  if (!noAssert) checkOffset(offset, byteLength, this.length);
  var val = this[offset];
  var mul = 1;
  var i = 0;

  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul;
  }

  return val;
};

Buffer.prototype.readUIntBE = function readUIntBE(offset, byteLength, noAssert) {
  offset = offset >>> 0;
  byteLength = byteLength >>> 0;

  if (!noAssert) {
    checkOffset(offset, byteLength, this.length);
  }

  var val = this[offset + --byteLength];
  var mul = 1;

  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul;
  }

  return val;
};

Buffer.prototype.readUInt8 = function readUInt8(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 1, this.length);
  return this[offset];
};

Buffer.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 2, this.length);
  return this[offset] | this[offset + 1] << 8;
};

Buffer.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 2, this.length);
  return this[offset] << 8 | this[offset + 1];
};

Buffer.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 4, this.length);
  return (this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16) + this[offset + 3] * 0x1000000;
};

Buffer.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 4, this.length);
  return this[offset] * 0x1000000 + (this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3]);
};

Buffer.prototype.readIntLE = function readIntLE(offset, byteLength, noAssert) {
  offset = offset >>> 0;
  byteLength = byteLength >>> 0;
  if (!noAssert) checkOffset(offset, byteLength, this.length);
  var val = this[offset];
  var mul = 1;
  var i = 0;

  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul;
  }

  mul *= 0x80;
  if (val >= mul) val -= Math.pow(2, 8 * byteLength);
  return val;
};

Buffer.prototype.readIntBE = function readIntBE(offset, byteLength, noAssert) {
  offset = offset >>> 0;
  byteLength = byteLength >>> 0;
  if (!noAssert) checkOffset(offset, byteLength, this.length);
  var i = byteLength;
  var mul = 1;
  var val = this[offset + --i];

  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul;
  }

  mul *= 0x80;
  if (val >= mul) val -= Math.pow(2, 8 * byteLength);
  return val;
};

Buffer.prototype.readInt8 = function readInt8(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 1, this.length);
  if (!(this[offset] & 0x80)) return this[offset];
  return (0xff - this[offset] + 1) * -1;
};

Buffer.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 2, this.length);
  var val = this[offset] | this[offset + 1] << 8;
  return val & 0x8000 ? val | 0xFFFF0000 : val;
};

Buffer.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 2, this.length);
  var val = this[offset + 1] | this[offset] << 8;
  return val & 0x8000 ? val | 0xFFFF0000 : val;
};

Buffer.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 4, this.length);
  return this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16 | this[offset + 3] << 24;
};

Buffer.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 4, this.length);
  return this[offset] << 24 | this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3];
};

Buffer.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 4, this.length);
  return ieee754.read(this, offset, true, 23, 4);
};

Buffer.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 4, this.length);
  return ieee754.read(this, offset, false, 23, 4);
};

Buffer.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 8, this.length);
  return ieee754.read(this, offset, true, 52, 8);
};

Buffer.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
  offset = offset >>> 0;
  if (!noAssert) checkOffset(offset, 8, this.length);
  return ieee754.read(this, offset, false, 52, 8);
};

function checkInt(buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance');
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds');
  if (offset + ext > buf.length) throw new RangeError('Index out of range');
}

Buffer.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength, noAssert) {
  value = +value;
  offset = offset >>> 0;
  byteLength = byteLength >>> 0;

  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1;
    checkInt(this, value, offset, byteLength, maxBytes, 0);
  }

  var mul = 1;
  var i = 0;
  this[offset] = value & 0xFF;

  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = value / mul & 0xFF;
  }

  return offset + byteLength;
};

Buffer.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength, noAssert) {
  value = +value;
  offset = offset >>> 0;
  byteLength = byteLength >>> 0;

  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1;
    checkInt(this, value, offset, byteLength, maxBytes, 0);
  }

  var i = byteLength - 1;
  var mul = 1;
  this[offset + i] = value & 0xFF;

  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = value / mul & 0xFF;
  }

  return offset + byteLength;
};

Buffer.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0);
  this[offset] = value & 0xff;
  return offset + 1;
};

Buffer.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0);
  this[offset] = value & 0xff;
  this[offset + 1] = value >>> 8;
  return offset + 2;
};

Buffer.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0);
  this[offset] = value >>> 8;
  this[offset + 1] = value & 0xff;
  return offset + 2;
};

Buffer.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0);
  this[offset + 3] = value >>> 24;
  this[offset + 2] = value >>> 16;
  this[offset + 1] = value >>> 8;
  this[offset] = value & 0xff;
  return offset + 4;
};

Buffer.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0);
  this[offset] = value >>> 24;
  this[offset + 1] = value >>> 16;
  this[offset + 2] = value >>> 8;
  this[offset + 3] = value & 0xff;
  return offset + 4;
};

Buffer.prototype.writeIntLE = function writeIntLE(value, offset, byteLength, noAssert) {
  value = +value;
  offset = offset >>> 0;

  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1);
    checkInt(this, value, offset, byteLength, limit - 1, -limit);
  }

  var i = 0;
  var mul = 1;
  var sub = 0;
  this[offset] = value & 0xFF;

  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1;
    }

    this[offset + i] = (value / mul >> 0) - sub & 0xFF;
  }

  return offset + byteLength;
};

Buffer.prototype.writeIntBE = function writeIntBE(value, offset, byteLength, noAssert) {
  value = +value;
  offset = offset >>> 0;

  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1);
    checkInt(this, value, offset, byteLength, limit - 1, -limit);
  }

  var i = byteLength - 1;
  var mul = 1;
  var sub = 0;
  this[offset + i] = value & 0xFF;

  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1;
    }

    this[offset + i] = (value / mul >> 0) - sub & 0xFF;
  }

  return offset + byteLength;
};

Buffer.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80);
  if (value < 0) value = 0xff + value + 1;
  this[offset] = value & 0xff;
  return offset + 1;
};

Buffer.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000);
  this[offset] = value & 0xff;
  this[offset + 1] = value >>> 8;
  return offset + 2;
};

Buffer.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000);
  this[offset] = value >>> 8;
  this[offset + 1] = value & 0xff;
  return offset + 2;
};

Buffer.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
  this[offset] = value & 0xff;
  this[offset + 1] = value >>> 8;
  this[offset + 2] = value >>> 16;
  this[offset + 3] = value >>> 24;
  return offset + 4;
};

Buffer.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
  value = +value;
  offset = offset >>> 0;
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
  if (value < 0) value = 0xffffffff + value + 1;
  this[offset] = value >>> 24;
  this[offset + 1] = value >>> 16;
  this[offset + 2] = value >>> 8;
  this[offset + 3] = value & 0xff;
  return offset + 4;
};

function checkIEEE754(buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range');
  if (offset < 0) throw new RangeError('Index out of range');
}

function writeFloat(buf, value, offset, littleEndian, noAssert) {
  value = +value;
  offset = offset >>> 0;

  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38);
  }

  ieee754.write(buf, value, offset, littleEndian, 23, 4);
  return offset + 4;
}

Buffer.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert);
};

Buffer.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert);
};

function writeDouble(buf, value, offset, littleEndian, noAssert) {
  value = +value;
  offset = offset >>> 0;

  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308);
  }

  ieee754.write(buf, value, offset, littleEndian, 52, 8);
  return offset + 8;
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert);
};

Buffer.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert);
}; // copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)


Buffer.prototype.copy = function copy(target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer');
  if (!start) start = 0;
  if (!end && end !== 0) end = this.length;
  if (targetStart >= target.length) targetStart = target.length;
  if (!targetStart) targetStart = 0;
  if (end > 0 && end < start) end = start; // Copy 0 bytes; we're done

  if (end === start) return 0;
  if (target.length === 0 || this.length === 0) return 0; // Fatal error conditions

  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds');
  }

  if (start < 0 || start >= this.length) throw new RangeError('Index out of range');
  if (end < 0) throw new RangeError('sourceEnd out of bounds'); // Are we oob?

  if (end > this.length) end = this.length;

  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start;
  }

  var len = end - start;

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end);
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start];
    }
  } else {
    Uint8Array.prototype.set.call(target, this.subarray(start, end), targetStart);
  }

  return len;
}; // Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])


Buffer.prototype.fill = function fill(val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start;
      start = 0;
      end = this.length;
    } else if (typeof end === 'string') {
      encoding = end;
      end = this.length;
    }

    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string');
    }

    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding);
    }

    if (val.length === 1) {
      var code = val.charCodeAt(0);

      if (encoding === 'utf8' && code < 128 || encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code;
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255;
  } else if (typeof val === 'boolean') {
    val = Number(val);
  } // Invalid ranges are not set to a default, so can range check early.


  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index');
  }

  if (end <= start) {
    return this;
  }

  start = start >>> 0;
  end = end === undefined ? this.length : end >>> 0;
  if (!val) val = 0;
  var i;

  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val;
    }
  } else {
    var bytes = Buffer.isBuffer(val) ? val : Buffer.from(val, encoding);
    var len = bytes.length;

    if (len === 0) {
      throw new TypeError('The value "' + val + '" is invalid for argument "value"');
    }

    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len];
    }
  }

  return this;
}; // HELPER FUNCTIONS
// ================


var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;

function base64clean(str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]; // Node strips out invalid characters like \n and \t from the string, base64-js does not

  str = str.trim().replace(INVALID_BASE64_RE, ''); // Node converts strings with length < 2 to ''

  if (str.length < 2) return ''; // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not

  while (str.length % 4 !== 0) {
    str = str + '=';
  }

  return str;
}

function utf8ToBytes(string, units) {
  units = units || Infinity;
  var codePoint;
  var length = string.length;
  var leadSurrogate = null;
  var bytes = [];

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i); // is surrogate component

    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD);
          continue;
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD);
          continue;
        } // valid lead


        leadSurrogate = codePoint;
        continue;
      } // 2 leads in a row


      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD);
        leadSurrogate = codePoint;
        continue;
      } // valid surrogate pair


      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000;
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD);
    }

    leadSurrogate = null; // encode utf8

    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break;
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break;
      bytes.push(codePoint >> 0x6 | 0xC0, codePoint & 0x3F | 0x80);
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break;
      bytes.push(codePoint >> 0xC | 0xE0, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break;
      bytes.push(codePoint >> 0x12 | 0xF0, codePoint >> 0xC & 0x3F | 0x80, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
    } else {
      throw new Error('Invalid code point');
    }
  }

  return bytes;
}

function asciiToBytes(str) {
  var byteArray = [];

  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF);
  }

  return byteArray;
}

function utf16leToBytes(str, units) {
  var c, hi, lo;
  var byteArray = [];

  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break;
    c = str.charCodeAt(i);
    hi = c >> 8;
    lo = c % 256;
    byteArray.push(lo);
    byteArray.push(hi);
  }

  return byteArray;
}

function base64ToBytes(str) {
  return base64.toByteArray(base64clean(str));
}

function blitBuffer(src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if (i + offset >= dst.length || i >= src.length) break;
    dst[i + offset] = src[i];
  }

  return i;
} // ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166


function isInstance(obj, type) {
  return obj instanceof type || obj != null && obj.constructor != null && obj.constructor.name != null && obj.constructor.name === type.name;
}

function numberIsNaN(obj) {
  // For IE11 support
  return obj !== obj; // eslint-disable-line no-self-compare
} // Create lookup table for `toString('hex')`
// See: https://github.com/feross/buffer/issues/219


var hexSliceLookupTable = function () {
  var alphabet = '0123456789abcdef';
  var table = new Array(256);

  for (var i = 0; i < 16; ++i) {
    var i16 = i * 16;

    for (var j = 0; j < 16; ++j) {
      table[i16 + j] = alphabet[i] + alphabet[j];
    }
  }

  return table;
}();

}).call(this,require("buffer").Buffer)

},{"@babel/runtime-corejs2/core-js/array/is-array":12,"@babel/runtime-corejs2/core-js/object/define-property":19,"@babel/runtime-corejs2/core-js/object/set-prototype-of":24,"@babel/runtime-corejs2/core-js/parse-int":25,"@babel/runtime-corejs2/core-js/symbol":30,"@babel/runtime-corejs2/core-js/symbol/for":31,"@babel/runtime-corejs2/core-js/symbol/species":33,"@babel/runtime-corejs2/core-js/symbol/to-primitive":34,"@babel/runtime-corejs2/helpers/interopRequireDefault":44,"@babel/runtime-corejs2/helpers/typeof":54,"base64-js":56,"buffer":204,"ieee754":205}],58:[function(require,module,exports){
require('../../modules/es6.string.iterator');
require('../../modules/es6.array.from');
module.exports = require('../../modules/_core').Array.from;

},{"../../modules/_core":97,"../../modules/es6.array.from":175,"../../modules/es6.string.iterator":194}],59:[function(require,module,exports){
require('../../modules/es6.array.is-array');
module.exports = require('../../modules/_core').Array.isArray;

},{"../../modules/_core":97,"../../modules/es6.array.is-array":176}],60:[function(require,module,exports){
require('../modules/web.dom.iterable');
require('../modules/es6.string.iterator');
module.exports = require('../modules/core.get-iterator');

},{"../modules/core.get-iterator":173,"../modules/es6.string.iterator":194,"../modules/web.dom.iterable":203}],61:[function(require,module,exports){
require('../modules/web.dom.iterable');
require('../modules/es6.string.iterator');
module.exports = require('../modules/core.is-iterable');

},{"../modules/core.is-iterable":174,"../modules/es6.string.iterator":194,"../modules/web.dom.iterable":203}],62:[function(require,module,exports){
require('../../modules/es6.number.is-integer');
module.exports = require('../../modules/_core').Number.isInteger;

},{"../../modules/_core":97,"../../modules/es6.number.is-integer":178}],63:[function(require,module,exports){
require('../../modules/es6.object.assign');
module.exports = require('../../modules/_core').Object.assign;

},{"../../modules/_core":97,"../../modules/es6.object.assign":179}],64:[function(require,module,exports){
require('../../modules/es6.object.create');
var $Object = require('../../modules/_core').Object;
module.exports = function create(P, D) {
  return $Object.create(P, D);
};

},{"../../modules/_core":97,"../../modules/es6.object.create":180}],65:[function(require,module,exports){
require('../../modules/es6.object.define-properties');
var $Object = require('../../modules/_core').Object;
module.exports = function defineProperties(T, D) {
  return $Object.defineProperties(T, D);
};

},{"../../modules/_core":97,"../../modules/es6.object.define-properties":181}],66:[function(require,module,exports){
require('../../modules/es6.object.define-property');
var $Object = require('../../modules/_core').Object;
module.exports = function defineProperty(it, key, desc) {
  return $Object.defineProperty(it, key, desc);
};

},{"../../modules/_core":97,"../../modules/es6.object.define-property":182}],67:[function(require,module,exports){
require('../../modules/es6.object.get-own-property-descriptor');
var $Object = require('../../modules/_core').Object;
module.exports = function getOwnPropertyDescriptor(it, key) {
  return $Object.getOwnPropertyDescriptor(it, key);
};

},{"../../modules/_core":97,"../../modules/es6.object.get-own-property-descriptor":183}],68:[function(require,module,exports){
require('../../modules/es6.object.get-own-property-names');
var $Object = require('../../modules/_core').Object;
module.exports = function getOwnPropertyNames(it) {
  return $Object.getOwnPropertyNames(it);
};

},{"../../modules/_core":97,"../../modules/es6.object.get-own-property-names":184}],69:[function(require,module,exports){
require('../../modules/es6.object.get-prototype-of');
module.exports = require('../../modules/_core').Object.getPrototypeOf;

},{"../../modules/_core":97,"../../modules/es6.object.get-prototype-of":185}],70:[function(require,module,exports){
require('../../modules/es6.object.keys');
module.exports = require('../../modules/_core').Object.keys;

},{"../../modules/_core":97,"../../modules/es6.object.keys":186}],71:[function(require,module,exports){
require('../../modules/es6.object.set-prototype-of');
module.exports = require('../../modules/_core').Object.setPrototypeOf;

},{"../../modules/_core":97,"../../modules/es6.object.set-prototype-of":187}],72:[function(require,module,exports){
require('../modules/es6.parse-int');
module.exports = require('../modules/_core').parseInt;

},{"../modules/_core":97,"../modules/es6.parse-int":189}],73:[function(require,module,exports){
require('../modules/es6.object.to-string');
require('../modules/es6.string.iterator');
require('../modules/web.dom.iterable');
require('../modules/es6.promise');
require('../modules/es7.promise.finally');
require('../modules/es7.promise.try');
module.exports = require('../modules/_core').Promise;

},{"../modules/_core":97,"../modules/es6.object.to-string":188,"../modules/es6.promise":190,"../modules/es6.string.iterator":194,"../modules/es7.promise.finally":196,"../modules/es7.promise.try":197,"../modules/web.dom.iterable":203}],74:[function(require,module,exports){
require('../../modules/es6.reflect.construct');
module.exports = require('../../modules/_core').Reflect.construct;

},{"../../modules/_core":97,"../../modules/es6.reflect.construct":191}],75:[function(require,module,exports){
require('../../modules/es6.reflect.get');
module.exports = require('../../modules/_core').Reflect.get;

},{"../../modules/_core":97,"../../modules/es6.reflect.get":192}],76:[function(require,module,exports){
require('../modules/es6.object.to-string');
require('../modules/es6.string.iterator');
require('../modules/web.dom.iterable');
require('../modules/es6.set');
require('../modules/es7.set.to-json');
require('../modules/es7.set.of');
require('../modules/es7.set.from');
module.exports = require('../modules/_core').Set;

},{"../modules/_core":97,"../modules/es6.object.to-string":188,"../modules/es6.set":193,"../modules/es6.string.iterator":194,"../modules/es7.set.from":198,"../modules/es7.set.of":199,"../modules/es7.set.to-json":200,"../modules/web.dom.iterable":203}],77:[function(require,module,exports){
require('../../modules/es6.symbol');
module.exports = require('../../modules/_core').Symbol['for'];

},{"../../modules/_core":97,"../../modules/es6.symbol":195}],78:[function(require,module,exports){
require('../../modules/es6.symbol');
require('../../modules/es6.object.to-string');
require('../../modules/es7.symbol.async-iterator');
require('../../modules/es7.symbol.observable');
module.exports = require('../../modules/_core').Symbol;

},{"../../modules/_core":97,"../../modules/es6.object.to-string":188,"../../modules/es6.symbol":195,"../../modules/es7.symbol.async-iterator":201,"../../modules/es7.symbol.observable":202}],79:[function(require,module,exports){
require('../../modules/es6.string.iterator');
require('../../modules/web.dom.iterable');
module.exports = require('../../modules/_wks-ext').f('iterator');

},{"../../modules/_wks-ext":170,"../../modules/es6.string.iterator":194,"../../modules/web.dom.iterable":203}],80:[function(require,module,exports){
module.exports = require('../../modules/_wks-ext').f('species');

},{"../../modules/_wks-ext":170}],81:[function(require,module,exports){
module.exports = require('../../modules/_wks-ext').f('toPrimitive');

},{"../../modules/_wks-ext":170}],82:[function(require,module,exports){
module.exports = function (it) {
  if (typeof it != 'function') throw TypeError(it + ' is not a function!');
  return it;
};

},{}],83:[function(require,module,exports){
module.exports = function () { /* empty */ };

},{}],84:[function(require,module,exports){
module.exports = function (it, Constructor, name, forbiddenField) {
  if (!(it instanceof Constructor) || (forbiddenField !== undefined && forbiddenField in it)) {
    throw TypeError(name + ': incorrect invocation!');
  } return it;
};

},{}],85:[function(require,module,exports){
var isObject = require('./_is-object');
module.exports = function (it) {
  if (!isObject(it)) throw TypeError(it + ' is not an object!');
  return it;
};

},{"./_is-object":118}],86:[function(require,module,exports){
var forOf = require('./_for-of');

module.exports = function (iter, ITERATOR) {
  var result = [];
  forOf(iter, false, result.push, result, ITERATOR);
  return result;
};

},{"./_for-of":107}],87:[function(require,module,exports){
// false -> Array#indexOf
// true  -> Array#includes
var toIObject = require('./_to-iobject');
var toLength = require('./_to-length');
var toAbsoluteIndex = require('./_to-absolute-index');
module.exports = function (IS_INCLUDES) {
  return function ($this, el, fromIndex) {
    var O = toIObject($this);
    var length = toLength(O.length);
    var index = toAbsoluteIndex(fromIndex, length);
    var value;
    // Array#includes uses SameValueZero equality algorithm
    // eslint-disable-next-line no-self-compare
    if (IS_INCLUDES && el != el) while (length > index) {
      value = O[index++];
      // eslint-disable-next-line no-self-compare
      if (value != value) return true;
    // Array#indexOf ignores holes, Array#includes - not
    } else for (;length > index; index++) if (IS_INCLUDES || index in O) {
      if (O[index] === el) return IS_INCLUDES || index || 0;
    } return !IS_INCLUDES && -1;
  };
};

},{"./_to-absolute-index":160,"./_to-iobject":162,"./_to-length":163}],88:[function(require,module,exports){
// 0 -> Array#forEach
// 1 -> Array#map
// 2 -> Array#filter
// 3 -> Array#some
// 4 -> Array#every
// 5 -> Array#find
// 6 -> Array#findIndex
var ctx = require('./_ctx');
var IObject = require('./_iobject');
var toObject = require('./_to-object');
var toLength = require('./_to-length');
var asc = require('./_array-species-create');
module.exports = function (TYPE, $create) {
  var IS_MAP = TYPE == 1;
  var IS_FILTER = TYPE == 2;
  var IS_SOME = TYPE == 3;
  var IS_EVERY = TYPE == 4;
  var IS_FIND_INDEX = TYPE == 6;
  var NO_HOLES = TYPE == 5 || IS_FIND_INDEX;
  var create = $create || asc;
  return function ($this, callbackfn, that) {
    var O = toObject($this);
    var self = IObject(O);
    var f = ctx(callbackfn, that, 3);
    var length = toLength(self.length);
    var index = 0;
    var result = IS_MAP ? create($this, length) : IS_FILTER ? create($this, 0) : undefined;
    var val, res;
    for (;length > index; index++) if (NO_HOLES || index in self) {
      val = self[index];
      res = f(val, index, O);
      if (TYPE) {
        if (IS_MAP) result[index] = res;   // map
        else if (res) switch (TYPE) {
          case 3: return true;             // some
          case 5: return val;              // find
          case 6: return index;            // findIndex
          case 2: result.push(val);        // filter
        } else if (IS_EVERY) return false; // every
      }
    }
    return IS_FIND_INDEX ? -1 : IS_SOME || IS_EVERY ? IS_EVERY : result;
  };
};

},{"./_array-species-create":90,"./_ctx":99,"./_iobject":114,"./_to-length":163,"./_to-object":164}],89:[function(require,module,exports){
var isObject = require('./_is-object');
var isArray = require('./_is-array');
var SPECIES = require('./_wks')('species');

module.exports = function (original) {
  var C;
  if (isArray(original)) {
    C = original.constructor;
    // cross-realm fallback
    if (typeof C == 'function' && (C === Array || isArray(C.prototype))) C = undefined;
    if (isObject(C)) {
      C = C[SPECIES];
      if (C === null) C = undefined;
    }
  } return C === undefined ? Array : C;
};

},{"./_is-array":116,"./_is-object":118,"./_wks":171}],90:[function(require,module,exports){
// 9.4.2.3 ArraySpeciesCreate(originalArray, length)
var speciesConstructor = require('./_array-species-constructor');

module.exports = function (original, length) {
  return new (speciesConstructor(original))(length);
};

},{"./_array-species-constructor":89}],91:[function(require,module,exports){
'use strict';
var aFunction = require('./_a-function');
var isObject = require('./_is-object');
var invoke = require('./_invoke');
var arraySlice = [].slice;
var factories = {};

var construct = function (F, len, args) {
  if (!(len in factories)) {
    for (var n = [], i = 0; i < len; i++) n[i] = 'a[' + i + ']';
    // eslint-disable-next-line no-new-func
    factories[len] = Function('F,a', 'return new F(' + n.join(',') + ')');
  } return factories[len](F, args);
};

module.exports = Function.bind || function bind(that /* , ...args */) {
  var fn = aFunction(this);
  var partArgs = arraySlice.call(arguments, 1);
  var bound = function (/* args... */) {
    var args = partArgs.concat(arraySlice.call(arguments));
    return this instanceof bound ? construct(fn, args.length, args) : invoke(fn, args, that);
  };
  if (isObject(fn.prototype)) bound.prototype = fn.prototype;
  return bound;
};

},{"./_a-function":82,"./_invoke":113,"./_is-object":118}],92:[function(require,module,exports){
// getting tag from 19.1.3.6 Object.prototype.toString()
var cof = require('./_cof');
var TAG = require('./_wks')('toStringTag');
// ES3 wrong here
var ARG = cof(function () { return arguments; }()) == 'Arguments';

// fallback for IE11 Script Access Denied error
var tryGet = function (it, key) {
  try {
    return it[key];
  } catch (e) { /* empty */ }
};

module.exports = function (it) {
  var O, T, B;
  return it === undefined ? 'Undefined' : it === null ? 'Null'
    // @@toStringTag case
    : typeof (T = tryGet(O = Object(it), TAG)) == 'string' ? T
    // builtinTag case
    : ARG ? cof(O)
    // ES3 arguments fallback
    : (B = cof(O)) == 'Object' && typeof O.callee == 'function' ? 'Arguments' : B;
};

},{"./_cof":93,"./_wks":171}],93:[function(require,module,exports){
var toString = {}.toString;

module.exports = function (it) {
  return toString.call(it).slice(8, -1);
};

},{}],94:[function(require,module,exports){
'use strict';
var dP = require('./_object-dp').f;
var create = require('./_object-create');
var redefineAll = require('./_redefine-all');
var ctx = require('./_ctx');
var anInstance = require('./_an-instance');
var forOf = require('./_for-of');
var $iterDefine = require('./_iter-define');
var step = require('./_iter-step');
var setSpecies = require('./_set-species');
var DESCRIPTORS = require('./_descriptors');
var fastKey = require('./_meta').fastKey;
var validate = require('./_validate-collection');
var SIZE = DESCRIPTORS ? '_s' : 'size';

var getEntry = function (that, key) {
  // fast case
  var index = fastKey(key);
  var entry;
  if (index !== 'F') return that._i[index];
  // frozen object case
  for (entry = that._f; entry; entry = entry.n) {
    if (entry.k == key) return entry;
  }
};

module.exports = {
  getConstructor: function (wrapper, NAME, IS_MAP, ADDER) {
    var C = wrapper(function (that, iterable) {
      anInstance(that, C, NAME, '_i');
      that._t = NAME;         // collection type
      that._i = create(null); // index
      that._f = undefined;    // first entry
      that._l = undefined;    // last entry
      that[SIZE] = 0;         // size
      if (iterable != undefined) forOf(iterable, IS_MAP, that[ADDER], that);
    });
    redefineAll(C.prototype, {
      // 23.1.3.1 Map.prototype.clear()
      // 23.2.3.2 Set.prototype.clear()
      clear: function clear() {
        for (var that = validate(this, NAME), data = that._i, entry = that._f; entry; entry = entry.n) {
          entry.r = true;
          if (entry.p) entry.p = entry.p.n = undefined;
          delete data[entry.i];
        }
        that._f = that._l = undefined;
        that[SIZE] = 0;
      },
      // 23.1.3.3 Map.prototype.delete(key)
      // 23.2.3.4 Set.prototype.delete(value)
      'delete': function (key) {
        var that = validate(this, NAME);
        var entry = getEntry(that, key);
        if (entry) {
          var next = entry.n;
          var prev = entry.p;
          delete that._i[entry.i];
          entry.r = true;
          if (prev) prev.n = next;
          if (next) next.p = prev;
          if (that._f == entry) that._f = next;
          if (that._l == entry) that._l = prev;
          that[SIZE]--;
        } return !!entry;
      },
      // 23.2.3.6 Set.prototype.forEach(callbackfn, thisArg = undefined)
      // 23.1.3.5 Map.prototype.forEach(callbackfn, thisArg = undefined)
      forEach: function forEach(callbackfn /* , that = undefined */) {
        validate(this, NAME);
        var f = ctx(callbackfn, arguments.length > 1 ? arguments[1] : undefined, 3);
        var entry;
        while (entry = entry ? entry.n : this._f) {
          f(entry.v, entry.k, this);
          // revert to the last existing entry
          while (entry && entry.r) entry = entry.p;
        }
      },
      // 23.1.3.7 Map.prototype.has(key)
      // 23.2.3.7 Set.prototype.has(value)
      has: function has(key) {
        return !!getEntry(validate(this, NAME), key);
      }
    });
    if (DESCRIPTORS) dP(C.prototype, 'size', {
      get: function () {
        return validate(this, NAME)[SIZE];
      }
    });
    return C;
  },
  def: function (that, key, value) {
    var entry = getEntry(that, key);
    var prev, index;
    // change existing entry
    if (entry) {
      entry.v = value;
    // create new entry
    } else {
      that._l = entry = {
        i: index = fastKey(key, true), // <- index
        k: key,                        // <- key
        v: value,                      // <- value
        p: prev = that._l,             // <- previous entry
        n: undefined,                  // <- next entry
        r: false                       // <- removed
      };
      if (!that._f) that._f = entry;
      if (prev) prev.n = entry;
      that[SIZE]++;
      // add to index
      if (index !== 'F') that._i[index] = entry;
    } return that;
  },
  getEntry: getEntry,
  setStrong: function (C, NAME, IS_MAP) {
    // add .keys, .values, .entries, [@@iterator]
    // 23.1.3.4, 23.1.3.8, 23.1.3.11, 23.1.3.12, 23.2.3.5, 23.2.3.8, 23.2.3.10, 23.2.3.11
    $iterDefine(C, NAME, function (iterated, kind) {
      this._t = validate(iterated, NAME); // target
      this._k = kind;                     // kind
      this._l = undefined;                // previous
    }, function () {
      var that = this;
      var kind = that._k;
      var entry = that._l;
      // revert to the last existing entry
      while (entry && entry.r) entry = entry.p;
      // get next entry
      if (!that._t || !(that._l = entry = entry ? entry.n : that._t._f)) {
        // or finish the iteration
        that._t = undefined;
        return step(1);
      }
      // return step by kind
      if (kind == 'keys') return step(0, entry.k);
      if (kind == 'values') return step(0, entry.v);
      return step(0, [entry.k, entry.v]);
    }, IS_MAP ? 'entries' : 'values', !IS_MAP, true);

    // add [@@species], 23.1.2.2, 23.2.2.2
    setSpecies(NAME);
  }
};

},{"./_an-instance":84,"./_ctx":99,"./_descriptors":101,"./_for-of":107,"./_iter-define":121,"./_iter-step":123,"./_meta":126,"./_object-create":130,"./_object-dp":131,"./_redefine-all":146,"./_set-species":151,"./_validate-collection":168}],95:[function(require,module,exports){
// https://github.com/DavidBruant/Map-Set.prototype.toJSON
var classof = require('./_classof');
var from = require('./_array-from-iterable');
module.exports = function (NAME) {
  return function toJSON() {
    if (classof(this) != NAME) throw TypeError(NAME + "#toJSON isn't generic");
    return from(this);
  };
};

},{"./_array-from-iterable":86,"./_classof":92}],96:[function(require,module,exports){
'use strict';
var global = require('./_global');
var $export = require('./_export');
var meta = require('./_meta');
var fails = require('./_fails');
var hide = require('./_hide');
var redefineAll = require('./_redefine-all');
var forOf = require('./_for-of');
var anInstance = require('./_an-instance');
var isObject = require('./_is-object');
var setToStringTag = require('./_set-to-string-tag');
var dP = require('./_object-dp').f;
var each = require('./_array-methods')(0);
var DESCRIPTORS = require('./_descriptors');

module.exports = function (NAME, wrapper, methods, common, IS_MAP, IS_WEAK) {
  var Base = global[NAME];
  var C = Base;
  var ADDER = IS_MAP ? 'set' : 'add';
  var proto = C && C.prototype;
  var O = {};
  if (!DESCRIPTORS || typeof C != 'function' || !(IS_WEAK || proto.forEach && !fails(function () {
    new C().entries().next();
  }))) {
    // create collection constructor
    C = common.getConstructor(wrapper, NAME, IS_MAP, ADDER);
    redefineAll(C.prototype, methods);
    meta.NEED = true;
  } else {
    C = wrapper(function (target, iterable) {
      anInstance(target, C, NAME, '_c');
      target._c = new Base();
      if (iterable != undefined) forOf(iterable, IS_MAP, target[ADDER], target);
    });
    each('add,clear,delete,forEach,get,has,set,keys,values,entries,toJSON'.split(','), function (KEY) {
      var IS_ADDER = KEY == 'add' || KEY == 'set';
      if (KEY in proto && !(IS_WEAK && KEY == 'clear')) hide(C.prototype, KEY, function (a, b) {
        anInstance(this, C, KEY);
        if (!IS_ADDER && IS_WEAK && !isObject(a)) return KEY == 'get' ? undefined : false;
        var result = this._c[KEY](a === 0 ? 0 : a, b);
        return IS_ADDER ? this : result;
      });
    });
    IS_WEAK || dP(C.prototype, 'size', {
      get: function () {
        return this._c.size;
      }
    });
  }

  setToStringTag(C, NAME);

  O[NAME] = C;
  $export($export.G + $export.W + $export.F, O);

  if (!IS_WEAK) common.setStrong(C, NAME, IS_MAP);

  return C;
};

},{"./_an-instance":84,"./_array-methods":88,"./_descriptors":101,"./_export":105,"./_fails":106,"./_for-of":107,"./_global":108,"./_hide":110,"./_is-object":118,"./_meta":126,"./_object-dp":131,"./_redefine-all":146,"./_set-to-string-tag":152}],97:[function(require,module,exports){
var core = module.exports = { version: '2.6.11' };
if (typeof __e == 'number') __e = core; // eslint-disable-line no-undef

},{}],98:[function(require,module,exports){
'use strict';
var $defineProperty = require('./_object-dp');
var createDesc = require('./_property-desc');

module.exports = function (object, index, value) {
  if (index in object) $defineProperty.f(object, index, createDesc(0, value));
  else object[index] = value;
};

},{"./_object-dp":131,"./_property-desc":145}],99:[function(require,module,exports){
// optional / simple context binding
var aFunction = require('./_a-function');
module.exports = function (fn, that, length) {
  aFunction(fn);
  if (that === undefined) return fn;
  switch (length) {
    case 1: return function (a) {
      return fn.call(that, a);
    };
    case 2: return function (a, b) {
      return fn.call(that, a, b);
    };
    case 3: return function (a, b, c) {
      return fn.call(that, a, b, c);
    };
  }
  return function (/* ...args */) {
    return fn.apply(that, arguments);
  };
};

},{"./_a-function":82}],100:[function(require,module,exports){
// 7.2.1 RequireObjectCoercible(argument)
module.exports = function (it) {
  if (it == undefined) throw TypeError("Can't call method on  " + it);
  return it;
};

},{}],101:[function(require,module,exports){
// Thank's IE8 for his funny defineProperty
module.exports = !require('./_fails')(function () {
  return Object.defineProperty({}, 'a', { get: function () { return 7; } }).a != 7;
});

},{"./_fails":106}],102:[function(require,module,exports){
var isObject = require('./_is-object');
var document = require('./_global').document;
// typeof document.createElement is 'object' in old IE
var is = isObject(document) && isObject(document.createElement);
module.exports = function (it) {
  return is ? document.createElement(it) : {};
};

},{"./_global":108,"./_is-object":118}],103:[function(require,module,exports){
// IE 8- don't enum bug keys
module.exports = (
  'constructor,hasOwnProperty,isPrototypeOf,propertyIsEnumerable,toLocaleString,toString,valueOf'
).split(',');

},{}],104:[function(require,module,exports){
// all enumerable object keys, includes symbols
var getKeys = require('./_object-keys');
var gOPS = require('./_object-gops');
var pIE = require('./_object-pie');
module.exports = function (it) {
  var result = getKeys(it);
  var getSymbols = gOPS.f;
  if (getSymbols) {
    var symbols = getSymbols(it);
    var isEnum = pIE.f;
    var i = 0;
    var key;
    while (symbols.length > i) if (isEnum.call(it, key = symbols[i++])) result.push(key);
  } return result;
};

},{"./_object-gops":136,"./_object-keys":139,"./_object-pie":140}],105:[function(require,module,exports){
var global = require('./_global');
var core = require('./_core');
var ctx = require('./_ctx');
var hide = require('./_hide');
var has = require('./_has');
var PROTOTYPE = 'prototype';

var $export = function (type, name, source) {
  var IS_FORCED = type & $export.F;
  var IS_GLOBAL = type & $export.G;
  var IS_STATIC = type & $export.S;
  var IS_PROTO = type & $export.P;
  var IS_BIND = type & $export.B;
  var IS_WRAP = type & $export.W;
  var exports = IS_GLOBAL ? core : core[name] || (core[name] = {});
  var expProto = exports[PROTOTYPE];
  var target = IS_GLOBAL ? global : IS_STATIC ? global[name] : (global[name] || {})[PROTOTYPE];
  var key, own, out;
  if (IS_GLOBAL) source = name;
  for (key in source) {
    // contains in native
    own = !IS_FORCED && target && target[key] !== undefined;
    if (own && has(exports, key)) continue;
    // export native or passed
    out = own ? target[key] : source[key];
    // prevent global pollution for namespaces
    exports[key] = IS_GLOBAL && typeof target[key] != 'function' ? source[key]
    // bind timers to global for call from export context
    : IS_BIND && own ? ctx(out, global)
    // wrap global constructors for prevent change them in library
    : IS_WRAP && target[key] == out ? (function (C) {
      var F = function (a, b, c) {
        if (this instanceof C) {
          switch (arguments.length) {
            case 0: return new C();
            case 1: return new C(a);
            case 2: return new C(a, b);
          } return new C(a, b, c);
        } return C.apply(this, arguments);
      };
      F[PROTOTYPE] = C[PROTOTYPE];
      return F;
    // make static versions for prototype methods
    })(out) : IS_PROTO && typeof out == 'function' ? ctx(Function.call, out) : out;
    // export proto methods to core.%CONSTRUCTOR%.methods.%NAME%
    if (IS_PROTO) {
      (exports.virtual || (exports.virtual = {}))[key] = out;
      // export proto methods to core.%CONSTRUCTOR%.prototype.%NAME%
      if (type & $export.R && expProto && !expProto[key]) hide(expProto, key, out);
    }
  }
};
// type bitmap
$export.F = 1;   // forced
$export.G = 2;   // global
$export.S = 4;   // static
$export.P = 8;   // proto
$export.B = 16;  // bind
$export.W = 32;  // wrap
$export.U = 64;  // safe
$export.R = 128; // real proto method for `library`
module.exports = $export;

},{"./_core":97,"./_ctx":99,"./_global":108,"./_has":109,"./_hide":110}],106:[function(require,module,exports){
module.exports = function (exec) {
  try {
    return !!exec();
  } catch (e) {
    return true;
  }
};

},{}],107:[function(require,module,exports){
var ctx = require('./_ctx');
var call = require('./_iter-call');
var isArrayIter = require('./_is-array-iter');
var anObject = require('./_an-object');
var toLength = require('./_to-length');
var getIterFn = require('./core.get-iterator-method');
var BREAK = {};
var RETURN = {};
var exports = module.exports = function (iterable, entries, fn, that, ITERATOR) {
  var iterFn = ITERATOR ? function () { return iterable; } : getIterFn(iterable);
  var f = ctx(fn, that, entries ? 2 : 1);
  var index = 0;
  var length, step, iterator, result;
  if (typeof iterFn != 'function') throw TypeError(iterable + ' is not iterable!');
  // fast case for arrays with default iterator
  if (isArrayIter(iterFn)) for (length = toLength(iterable.length); length > index; index++) {
    result = entries ? f(anObject(step = iterable[index])[0], step[1]) : f(iterable[index]);
    if (result === BREAK || result === RETURN) return result;
  } else for (iterator = iterFn.call(iterable); !(step = iterator.next()).done;) {
    result = call(iterator, f, step.value, entries);
    if (result === BREAK || result === RETURN) return result;
  }
};
exports.BREAK = BREAK;
exports.RETURN = RETURN;

},{"./_an-object":85,"./_ctx":99,"./_is-array-iter":115,"./_iter-call":119,"./_to-length":163,"./core.get-iterator-method":172}],108:[function(require,module,exports){
// https://github.com/zloirock/core-js/issues/86#issuecomment-115759028
var global = module.exports = typeof window != 'undefined' && window.Math == Math
  ? window : typeof self != 'undefined' && self.Math == Math ? self
  // eslint-disable-next-line no-new-func
  : Function('return this')();
if (typeof __g == 'number') __g = global; // eslint-disable-line no-undef

},{}],109:[function(require,module,exports){
var hasOwnProperty = {}.hasOwnProperty;
module.exports = function (it, key) {
  return hasOwnProperty.call(it, key);
};

},{}],110:[function(require,module,exports){
var dP = require('./_object-dp');
var createDesc = require('./_property-desc');
module.exports = require('./_descriptors') ? function (object, key, value) {
  return dP.f(object, key, createDesc(1, value));
} : function (object, key, value) {
  object[key] = value;
  return object;
};

},{"./_descriptors":101,"./_object-dp":131,"./_property-desc":145}],111:[function(require,module,exports){
var document = require('./_global').document;
module.exports = document && document.documentElement;

},{"./_global":108}],112:[function(require,module,exports){
module.exports = !require('./_descriptors') && !require('./_fails')(function () {
  return Object.defineProperty(require('./_dom-create')('div'), 'a', { get: function () { return 7; } }).a != 7;
});

},{"./_descriptors":101,"./_dom-create":102,"./_fails":106}],113:[function(require,module,exports){
// fast apply, http://jsperf.lnkit.com/fast-apply/5
module.exports = function (fn, args, that) {
  var un = that === undefined;
  switch (args.length) {
    case 0: return un ? fn()
                      : fn.call(that);
    case 1: return un ? fn(args[0])
                      : fn.call(that, args[0]);
    case 2: return un ? fn(args[0], args[1])
                      : fn.call(that, args[0], args[1]);
    case 3: return un ? fn(args[0], args[1], args[2])
                      : fn.call(that, args[0], args[1], args[2]);
    case 4: return un ? fn(args[0], args[1], args[2], args[3])
                      : fn.call(that, args[0], args[1], args[2], args[3]);
  } return fn.apply(that, args);
};

},{}],114:[function(require,module,exports){
// fallback for non-array-like ES3 and non-enumerable old V8 strings
var cof = require('./_cof');
// eslint-disable-next-line no-prototype-builtins
module.exports = Object('z').propertyIsEnumerable(0) ? Object : function (it) {
  return cof(it) == 'String' ? it.split('') : Object(it);
};

},{"./_cof":93}],115:[function(require,module,exports){
// check on default Array iterator
var Iterators = require('./_iterators');
var ITERATOR = require('./_wks')('iterator');
var ArrayProto = Array.prototype;

module.exports = function (it) {
  return it !== undefined && (Iterators.Array === it || ArrayProto[ITERATOR] === it);
};

},{"./_iterators":124,"./_wks":171}],116:[function(require,module,exports){
// 7.2.2 IsArray(argument)
var cof = require('./_cof');
module.exports = Array.isArray || function isArray(arg) {
  return cof(arg) == 'Array';
};

},{"./_cof":93}],117:[function(require,module,exports){
// 20.1.2.3 Number.isInteger(number)
var isObject = require('./_is-object');
var floor = Math.floor;
module.exports = function isInteger(it) {
  return !isObject(it) && isFinite(it) && floor(it) === it;
};

},{"./_is-object":118}],118:[function(require,module,exports){
module.exports = function (it) {
  return typeof it === 'object' ? it !== null : typeof it === 'function';
};

},{}],119:[function(require,module,exports){
// call something on iterator step with safe closing on error
var anObject = require('./_an-object');
module.exports = function (iterator, fn, value, entries) {
  try {
    return entries ? fn(anObject(value)[0], value[1]) : fn(value);
  // 7.4.6 IteratorClose(iterator, completion)
  } catch (e) {
    var ret = iterator['return'];
    if (ret !== undefined) anObject(ret.call(iterator));
    throw e;
  }
};

},{"./_an-object":85}],120:[function(require,module,exports){
'use strict';
var create = require('./_object-create');
var descriptor = require('./_property-desc');
var setToStringTag = require('./_set-to-string-tag');
var IteratorPrototype = {};

// 25.1.2.1.1 %IteratorPrototype%[@@iterator]()
require('./_hide')(IteratorPrototype, require('./_wks')('iterator'), function () { return this; });

module.exports = function (Constructor, NAME, next) {
  Constructor.prototype = create(IteratorPrototype, { next: descriptor(1, next) });
  setToStringTag(Constructor, NAME + ' Iterator');
};

},{"./_hide":110,"./_object-create":130,"./_property-desc":145,"./_set-to-string-tag":152,"./_wks":171}],121:[function(require,module,exports){
'use strict';
var LIBRARY = require('./_library');
var $export = require('./_export');
var redefine = require('./_redefine');
var hide = require('./_hide');
var Iterators = require('./_iterators');
var $iterCreate = require('./_iter-create');
var setToStringTag = require('./_set-to-string-tag');
var getPrototypeOf = require('./_object-gpo');
var ITERATOR = require('./_wks')('iterator');
var BUGGY = !([].keys && 'next' in [].keys()); // Safari has buggy iterators w/o `next`
var FF_ITERATOR = '@@iterator';
var KEYS = 'keys';
var VALUES = 'values';

var returnThis = function () { return this; };

module.exports = function (Base, NAME, Constructor, next, DEFAULT, IS_SET, FORCED) {
  $iterCreate(Constructor, NAME, next);
  var getMethod = function (kind) {
    if (!BUGGY && kind in proto) return proto[kind];
    switch (kind) {
      case KEYS: return function keys() { return new Constructor(this, kind); };
      case VALUES: return function values() { return new Constructor(this, kind); };
    } return function entries() { return new Constructor(this, kind); };
  };
  var TAG = NAME + ' Iterator';
  var DEF_VALUES = DEFAULT == VALUES;
  var VALUES_BUG = false;
  var proto = Base.prototype;
  var $native = proto[ITERATOR] || proto[FF_ITERATOR] || DEFAULT && proto[DEFAULT];
  var $default = $native || getMethod(DEFAULT);
  var $entries = DEFAULT ? !DEF_VALUES ? $default : getMethod('entries') : undefined;
  var $anyNative = NAME == 'Array' ? proto.entries || $native : $native;
  var methods, key, IteratorPrototype;
  // Fix native
  if ($anyNative) {
    IteratorPrototype = getPrototypeOf($anyNative.call(new Base()));
    if (IteratorPrototype !== Object.prototype && IteratorPrototype.next) {
      // Set @@toStringTag to native iterators
      setToStringTag(IteratorPrototype, TAG, true);
      // fix for some old engines
      if (!LIBRARY && typeof IteratorPrototype[ITERATOR] != 'function') hide(IteratorPrototype, ITERATOR, returnThis);
    }
  }
  // fix Array#{values, @@iterator}.name in V8 / FF
  if (DEF_VALUES && $native && $native.name !== VALUES) {
    VALUES_BUG = true;
    $default = function values() { return $native.call(this); };
  }
  // Define iterator
  if ((!LIBRARY || FORCED) && (BUGGY || VALUES_BUG || !proto[ITERATOR])) {
    hide(proto, ITERATOR, $default);
  }
  // Plug for library
  Iterators[NAME] = $default;
  Iterators[TAG] = returnThis;
  if (DEFAULT) {
    methods = {
      values: DEF_VALUES ? $default : getMethod(VALUES),
      keys: IS_SET ? $default : getMethod(KEYS),
      entries: $entries
    };
    if (FORCED) for (key in methods) {
      if (!(key in proto)) redefine(proto, key, methods[key]);
    } else $export($export.P + $export.F * (BUGGY || VALUES_BUG), NAME, methods);
  }
  return methods;
};

},{"./_export":105,"./_hide":110,"./_iter-create":120,"./_iterators":124,"./_library":125,"./_object-gpo":137,"./_redefine":147,"./_set-to-string-tag":152,"./_wks":171}],122:[function(require,module,exports){
var ITERATOR = require('./_wks')('iterator');
var SAFE_CLOSING = false;

try {
  var riter = [7][ITERATOR]();
  riter['return'] = function () { SAFE_CLOSING = true; };
  // eslint-disable-next-line no-throw-literal
  Array.from(riter, function () { throw 2; });
} catch (e) { /* empty */ }

module.exports = function (exec, skipClosing) {
  if (!skipClosing && !SAFE_CLOSING) return false;
  var safe = false;
  try {
    var arr = [7];
    var iter = arr[ITERATOR]();
    iter.next = function () { return { done: safe = true }; };
    arr[ITERATOR] = function () { return iter; };
    exec(arr);
  } catch (e) { /* empty */ }
  return safe;
};

},{"./_wks":171}],123:[function(require,module,exports){
module.exports = function (done, value) {
  return { value: value, done: !!done };
};

},{}],124:[function(require,module,exports){
module.exports = {};

},{}],125:[function(require,module,exports){
module.exports = true;

},{}],126:[function(require,module,exports){
var META = require('./_uid')('meta');
var isObject = require('./_is-object');
var has = require('./_has');
var setDesc = require('./_object-dp').f;
var id = 0;
var isExtensible = Object.isExtensible || function () {
  return true;
};
var FREEZE = !require('./_fails')(function () {
  return isExtensible(Object.preventExtensions({}));
});
var setMeta = function (it) {
  setDesc(it, META, { value: {
    i: 'O' + ++id, // object ID
    w: {}          // weak collections IDs
  } });
};
var fastKey = function (it, create) {
  // return primitive with prefix
  if (!isObject(it)) return typeof it == 'symbol' ? it : (typeof it == 'string' ? 'S' : 'P') + it;
  if (!has(it, META)) {
    // can't set metadata to uncaught frozen object
    if (!isExtensible(it)) return 'F';
    // not necessary to add metadata
    if (!create) return 'E';
    // add missing metadata
    setMeta(it);
  // return object ID
  } return it[META].i;
};
var getWeak = function (it, create) {
  if (!has(it, META)) {
    // can't set metadata to uncaught frozen object
    if (!isExtensible(it)) return true;
    // not necessary to add metadata
    if (!create) return false;
    // add missing metadata
    setMeta(it);
  // return hash weak collections IDs
  } return it[META].w;
};
// add metadata on freeze-family methods calling
var onFreeze = function (it) {
  if (FREEZE && meta.NEED && isExtensible(it) && !has(it, META)) setMeta(it);
  return it;
};
var meta = module.exports = {
  KEY: META,
  NEED: false,
  fastKey: fastKey,
  getWeak: getWeak,
  onFreeze: onFreeze
};

},{"./_fails":106,"./_has":109,"./_is-object":118,"./_object-dp":131,"./_uid":166}],127:[function(require,module,exports){
var global = require('./_global');
var macrotask = require('./_task').set;
var Observer = global.MutationObserver || global.WebKitMutationObserver;
var process = global.process;
var Promise = global.Promise;
var isNode = require('./_cof')(process) == 'process';

module.exports = function () {
  var head, last, notify;

  var flush = function () {
    var parent, fn;
    if (isNode && (parent = process.domain)) parent.exit();
    while (head) {
      fn = head.fn;
      head = head.next;
      try {
        fn();
      } catch (e) {
        if (head) notify();
        else last = undefined;
        throw e;
      }
    } last = undefined;
    if (parent) parent.enter();
  };

  // Node.js
  if (isNode) {
    notify = function () {
      process.nextTick(flush);
    };
  // browsers with MutationObserver, except iOS Safari - https://github.com/zloirock/core-js/issues/339
  } else if (Observer && !(global.navigator && global.navigator.standalone)) {
    var toggle = true;
    var node = document.createTextNode('');
    new Observer(flush).observe(node, { characterData: true }); // eslint-disable-line no-new
    notify = function () {
      node.data = toggle = !toggle;
    };
  // environments with maybe non-completely correct, but existent Promise
  } else if (Promise && Promise.resolve) {
    // Promise.resolve without an argument throws an error in LG WebOS 2
    var promise = Promise.resolve(undefined);
    notify = function () {
      promise.then(flush);
    };
  // for other environments - macrotask based on:
  // - setImmediate
  // - MessageChannel
  // - window.postMessag
  // - onreadystatechange
  // - setTimeout
  } else {
    notify = function () {
      // strange IE + webpack dev server bug - use .call(global)
      macrotask.call(global, flush);
    };
  }

  return function (fn) {
    var task = { fn: fn, next: undefined };
    if (last) last.next = task;
    if (!head) {
      head = task;
      notify();
    } last = task;
  };
};

},{"./_cof":93,"./_global":108,"./_task":159}],128:[function(require,module,exports){
'use strict';
// 25.4.1.5 NewPromiseCapability(C)
var aFunction = require('./_a-function');

function PromiseCapability(C) {
  var resolve, reject;
  this.promise = new C(function ($$resolve, $$reject) {
    if (resolve !== undefined || reject !== undefined) throw TypeError('Bad Promise constructor');
    resolve = $$resolve;
    reject = $$reject;
  });
  this.resolve = aFunction(resolve);
  this.reject = aFunction(reject);
}

module.exports.f = function (C) {
  return new PromiseCapability(C);
};

},{"./_a-function":82}],129:[function(require,module,exports){
'use strict';
// 19.1.2.1 Object.assign(target, source, ...)
var DESCRIPTORS = require('./_descriptors');
var getKeys = require('./_object-keys');
var gOPS = require('./_object-gops');
var pIE = require('./_object-pie');
var toObject = require('./_to-object');
var IObject = require('./_iobject');
var $assign = Object.assign;

// should work with symbols and should have deterministic property order (V8 bug)
module.exports = !$assign || require('./_fails')(function () {
  var A = {};
  var B = {};
  // eslint-disable-next-line no-undef
  var S = Symbol();
  var K = 'abcdefghijklmnopqrst';
  A[S] = 7;
  K.split('').forEach(function (k) { B[k] = k; });
  return $assign({}, A)[S] != 7 || Object.keys($assign({}, B)).join('') != K;
}) ? function assign(target, source) { // eslint-disable-line no-unused-vars
  var T = toObject(target);
  var aLen = arguments.length;
  var index = 1;
  var getSymbols = gOPS.f;
  var isEnum = pIE.f;
  while (aLen > index) {
    var S = IObject(arguments[index++]);
    var keys = getSymbols ? getKeys(S).concat(getSymbols(S)) : getKeys(S);
    var length = keys.length;
    var j = 0;
    var key;
    while (length > j) {
      key = keys[j++];
      if (!DESCRIPTORS || isEnum.call(S, key)) T[key] = S[key];
    }
  } return T;
} : $assign;

},{"./_descriptors":101,"./_fails":106,"./_iobject":114,"./_object-gops":136,"./_object-keys":139,"./_object-pie":140,"./_to-object":164}],130:[function(require,module,exports){
// 19.1.2.2 / 15.2.3.5 Object.create(O [, Properties])
var anObject = require('./_an-object');
var dPs = require('./_object-dps');
var enumBugKeys = require('./_enum-bug-keys');
var IE_PROTO = require('./_shared-key')('IE_PROTO');
var Empty = function () { /* empty */ };
var PROTOTYPE = 'prototype';

// Create object with fake `null` prototype: use iframe Object with cleared prototype
var createDict = function () {
  // Thrash, waste and sodomy: IE GC bug
  var iframe = require('./_dom-create')('iframe');
  var i = enumBugKeys.length;
  var lt = '<';
  var gt = '>';
  var iframeDocument;
  iframe.style.display = 'none';
  require('./_html').appendChild(iframe);
  iframe.src = 'javascript:'; // eslint-disable-line no-script-url
  // createDict = iframe.contentWindow.Object;
  // html.removeChild(iframe);
  iframeDocument = iframe.contentWindow.document;
  iframeDocument.open();
  iframeDocument.write(lt + 'script' + gt + 'document.F=Object' + lt + '/script' + gt);
  iframeDocument.close();
  createDict = iframeDocument.F;
  while (i--) delete createDict[PROTOTYPE][enumBugKeys[i]];
  return createDict();
};

module.exports = Object.create || function create(O, Properties) {
  var result;
  if (O !== null) {
    Empty[PROTOTYPE] = anObject(O);
    result = new Empty();
    Empty[PROTOTYPE] = null;
    // add "__proto__" for Object.getPrototypeOf polyfill
    result[IE_PROTO] = O;
  } else result = createDict();
  return Properties === undefined ? result : dPs(result, Properties);
};

},{"./_an-object":85,"./_dom-create":102,"./_enum-bug-keys":103,"./_html":111,"./_object-dps":132,"./_shared-key":153}],131:[function(require,module,exports){
var anObject = require('./_an-object');
var IE8_DOM_DEFINE = require('./_ie8-dom-define');
var toPrimitive = require('./_to-primitive');
var dP = Object.defineProperty;

exports.f = require('./_descriptors') ? Object.defineProperty : function defineProperty(O, P, Attributes) {
  anObject(O);
  P = toPrimitive(P, true);
  anObject(Attributes);
  if (IE8_DOM_DEFINE) try {
    return dP(O, P, Attributes);
  } catch (e) { /* empty */ }
  if ('get' in Attributes || 'set' in Attributes) throw TypeError('Accessors not supported!');
  if ('value' in Attributes) O[P] = Attributes.value;
  return O;
};

},{"./_an-object":85,"./_descriptors":101,"./_ie8-dom-define":112,"./_to-primitive":165}],132:[function(require,module,exports){
var dP = require('./_object-dp');
var anObject = require('./_an-object');
var getKeys = require('./_object-keys');

module.exports = require('./_descriptors') ? Object.defineProperties : function defineProperties(O, Properties) {
  anObject(O);
  var keys = getKeys(Properties);
  var length = keys.length;
  var i = 0;
  var P;
  while (length > i) dP.f(O, P = keys[i++], Properties[P]);
  return O;
};

},{"./_an-object":85,"./_descriptors":101,"./_object-dp":131,"./_object-keys":139}],133:[function(require,module,exports){
var pIE = require('./_object-pie');
var createDesc = require('./_property-desc');
var toIObject = require('./_to-iobject');
var toPrimitive = require('./_to-primitive');
var has = require('./_has');
var IE8_DOM_DEFINE = require('./_ie8-dom-define');
var gOPD = Object.getOwnPropertyDescriptor;

exports.f = require('./_descriptors') ? gOPD : function getOwnPropertyDescriptor(O, P) {
  O = toIObject(O);
  P = toPrimitive(P, true);
  if (IE8_DOM_DEFINE) try {
    return gOPD(O, P);
  } catch (e) { /* empty */ }
  if (has(O, P)) return createDesc(!pIE.f.call(O, P), O[P]);
};

},{"./_descriptors":101,"./_has":109,"./_ie8-dom-define":112,"./_object-pie":140,"./_property-desc":145,"./_to-iobject":162,"./_to-primitive":165}],134:[function(require,module,exports){
// fallback for IE11 buggy Object.getOwnPropertyNames with iframe and window
var toIObject = require('./_to-iobject');
var gOPN = require('./_object-gopn').f;
var toString = {}.toString;

var windowNames = typeof window == 'object' && window && Object.getOwnPropertyNames
  ? Object.getOwnPropertyNames(window) : [];

var getWindowNames = function (it) {
  try {
    return gOPN(it);
  } catch (e) {
    return windowNames.slice();
  }
};

module.exports.f = function getOwnPropertyNames(it) {
  return windowNames && toString.call(it) == '[object Window]' ? getWindowNames(it) : gOPN(toIObject(it));
};

},{"./_object-gopn":135,"./_to-iobject":162}],135:[function(require,module,exports){
// 19.1.2.7 / 15.2.3.4 Object.getOwnPropertyNames(O)
var $keys = require('./_object-keys-internal');
var hiddenKeys = require('./_enum-bug-keys').concat('length', 'prototype');

exports.f = Object.getOwnPropertyNames || function getOwnPropertyNames(O) {
  return $keys(O, hiddenKeys);
};

},{"./_enum-bug-keys":103,"./_object-keys-internal":138}],136:[function(require,module,exports){
exports.f = Object.getOwnPropertySymbols;

},{}],137:[function(require,module,exports){
// 19.1.2.9 / 15.2.3.2 Object.getPrototypeOf(O)
var has = require('./_has');
var toObject = require('./_to-object');
var IE_PROTO = require('./_shared-key')('IE_PROTO');
var ObjectProto = Object.prototype;

module.exports = Object.getPrototypeOf || function (O) {
  O = toObject(O);
  if (has(O, IE_PROTO)) return O[IE_PROTO];
  if (typeof O.constructor == 'function' && O instanceof O.constructor) {
    return O.constructor.prototype;
  } return O instanceof Object ? ObjectProto : null;
};

},{"./_has":109,"./_shared-key":153,"./_to-object":164}],138:[function(require,module,exports){
var has = require('./_has');
var toIObject = require('./_to-iobject');
var arrayIndexOf = require('./_array-includes')(false);
var IE_PROTO = require('./_shared-key')('IE_PROTO');

module.exports = function (object, names) {
  var O = toIObject(object);
  var i = 0;
  var result = [];
  var key;
  for (key in O) if (key != IE_PROTO) has(O, key) && result.push(key);
  // Don't enum bug & hidden keys
  while (names.length > i) if (has(O, key = names[i++])) {
    ~arrayIndexOf(result, key) || result.push(key);
  }
  return result;
};

},{"./_array-includes":87,"./_has":109,"./_shared-key":153,"./_to-iobject":162}],139:[function(require,module,exports){
// 19.1.2.14 / 15.2.3.14 Object.keys(O)
var $keys = require('./_object-keys-internal');
var enumBugKeys = require('./_enum-bug-keys');

module.exports = Object.keys || function keys(O) {
  return $keys(O, enumBugKeys);
};

},{"./_enum-bug-keys":103,"./_object-keys-internal":138}],140:[function(require,module,exports){
exports.f = {}.propertyIsEnumerable;

},{}],141:[function(require,module,exports){
// most Object methods by ES6 should accept primitives
var $export = require('./_export');
var core = require('./_core');
var fails = require('./_fails');
module.exports = function (KEY, exec) {
  var fn = (core.Object || {})[KEY] || Object[KEY];
  var exp = {};
  exp[KEY] = exec(fn);
  $export($export.S + $export.F * fails(function () { fn(1); }), 'Object', exp);
};

},{"./_core":97,"./_export":105,"./_fails":106}],142:[function(require,module,exports){
var $parseInt = require('./_global').parseInt;
var $trim = require('./_string-trim').trim;
var ws = require('./_string-ws');
var hex = /^[-+]?0[xX]/;

module.exports = $parseInt(ws + '08') !== 8 || $parseInt(ws + '0x16') !== 22 ? function parseInt(str, radix) {
  var string = $trim(String(str), 3);
  return $parseInt(string, (radix >>> 0) || (hex.test(string) ? 16 : 10));
} : $parseInt;

},{"./_global":108,"./_string-trim":157,"./_string-ws":158}],143:[function(require,module,exports){
module.exports = function (exec) {
  try {
    return { e: false, v: exec() };
  } catch (e) {
    return { e: true, v: e };
  }
};

},{}],144:[function(require,module,exports){
var anObject = require('./_an-object');
var isObject = require('./_is-object');
var newPromiseCapability = require('./_new-promise-capability');

module.exports = function (C, x) {
  anObject(C);
  if (isObject(x) && x.constructor === C) return x;
  var promiseCapability = newPromiseCapability.f(C);
  var resolve = promiseCapability.resolve;
  resolve(x);
  return promiseCapability.promise;
};

},{"./_an-object":85,"./_is-object":118,"./_new-promise-capability":128}],145:[function(require,module,exports){
module.exports = function (bitmap, value) {
  return {
    enumerable: !(bitmap & 1),
    configurable: !(bitmap & 2),
    writable: !(bitmap & 4),
    value: value
  };
};

},{}],146:[function(require,module,exports){
var hide = require('./_hide');
module.exports = function (target, src, safe) {
  for (var key in src) {
    if (safe && target[key]) target[key] = src[key];
    else hide(target, key, src[key]);
  } return target;
};

},{"./_hide":110}],147:[function(require,module,exports){
module.exports = require('./_hide');

},{"./_hide":110}],148:[function(require,module,exports){
'use strict';
// https://tc39.github.io/proposal-setmap-offrom/
var $export = require('./_export');
var aFunction = require('./_a-function');
var ctx = require('./_ctx');
var forOf = require('./_for-of');

module.exports = function (COLLECTION) {
  $export($export.S, COLLECTION, { from: function from(source /* , mapFn, thisArg */) {
    var mapFn = arguments[1];
    var mapping, A, n, cb;
    aFunction(this);
    mapping = mapFn !== undefined;
    if (mapping) aFunction(mapFn);
    if (source == undefined) return new this();
    A = [];
    if (mapping) {
      n = 0;
      cb = ctx(mapFn, arguments[2], 2);
      forOf(source, false, function (nextItem) {
        A.push(cb(nextItem, n++));
      });
    } else {
      forOf(source, false, A.push, A);
    }
    return new this(A);
  } });
};

},{"./_a-function":82,"./_ctx":99,"./_export":105,"./_for-of":107}],149:[function(require,module,exports){
'use strict';
// https://tc39.github.io/proposal-setmap-offrom/
var $export = require('./_export');

module.exports = function (COLLECTION) {
  $export($export.S, COLLECTION, { of: function of() {
    var length = arguments.length;
    var A = new Array(length);
    while (length--) A[length] = arguments[length];
    return new this(A);
  } });
};

},{"./_export":105}],150:[function(require,module,exports){
// Works with __proto__ only. Old v8 can't work with null proto objects.
/* eslint-disable no-proto */
var isObject = require('./_is-object');
var anObject = require('./_an-object');
var check = function (O, proto) {
  anObject(O);
  if (!isObject(proto) && proto !== null) throw TypeError(proto + ": can't set as prototype!");
};
module.exports = {
  set: Object.setPrototypeOf || ('__proto__' in {} ? // eslint-disable-line
    function (test, buggy, set) {
      try {
        set = require('./_ctx')(Function.call, require('./_object-gopd').f(Object.prototype, '__proto__').set, 2);
        set(test, []);
        buggy = !(test instanceof Array);
      } catch (e) { buggy = true; }
      return function setPrototypeOf(O, proto) {
        check(O, proto);
        if (buggy) O.__proto__ = proto;
        else set(O, proto);
        return O;
      };
    }({}, false) : undefined),
  check: check
};

},{"./_an-object":85,"./_ctx":99,"./_is-object":118,"./_object-gopd":133}],151:[function(require,module,exports){
'use strict';
var global = require('./_global');
var core = require('./_core');
var dP = require('./_object-dp');
var DESCRIPTORS = require('./_descriptors');
var SPECIES = require('./_wks')('species');

module.exports = function (KEY) {
  var C = typeof core[KEY] == 'function' ? core[KEY] : global[KEY];
  if (DESCRIPTORS && C && !C[SPECIES]) dP.f(C, SPECIES, {
    configurable: true,
    get: function () { return this; }
  });
};

},{"./_core":97,"./_descriptors":101,"./_global":108,"./_object-dp":131,"./_wks":171}],152:[function(require,module,exports){
var def = require('./_object-dp').f;
var has = require('./_has');
var TAG = require('./_wks')('toStringTag');

module.exports = function (it, tag, stat) {
  if (it && !has(it = stat ? it : it.prototype, TAG)) def(it, TAG, { configurable: true, value: tag });
};

},{"./_has":109,"./_object-dp":131,"./_wks":171}],153:[function(require,module,exports){
var shared = require('./_shared')('keys');
var uid = require('./_uid');
module.exports = function (key) {
  return shared[key] || (shared[key] = uid(key));
};

},{"./_shared":154,"./_uid":166}],154:[function(require,module,exports){
var core = require('./_core');
var global = require('./_global');
var SHARED = '__core-js_shared__';
var store = global[SHARED] || (global[SHARED] = {});

(module.exports = function (key, value) {
  return store[key] || (store[key] = value !== undefined ? value : {});
})('versions', []).push({
  version: core.version,
  mode: require('./_library') ? 'pure' : 'global',
  copyright: '© 2019 Denis Pushkarev (zloirock.ru)'
});

},{"./_core":97,"./_global":108,"./_library":125}],155:[function(require,module,exports){
// 7.3.20 SpeciesConstructor(O, defaultConstructor)
var anObject = require('./_an-object');
var aFunction = require('./_a-function');
var SPECIES = require('./_wks')('species');
module.exports = function (O, D) {
  var C = anObject(O).constructor;
  var S;
  return C === undefined || (S = anObject(C)[SPECIES]) == undefined ? D : aFunction(S);
};

},{"./_a-function":82,"./_an-object":85,"./_wks":171}],156:[function(require,module,exports){
var toInteger = require('./_to-integer');
var defined = require('./_defined');
// true  -> String#at
// false -> String#codePointAt
module.exports = function (TO_STRING) {
  return function (that, pos) {
    var s = String(defined(that));
    var i = toInteger(pos);
    var l = s.length;
    var a, b;
    if (i < 0 || i >= l) return TO_STRING ? '' : undefined;
    a = s.charCodeAt(i);
    return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff
      ? TO_STRING ? s.charAt(i) : a
      : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
  };
};

},{"./_defined":100,"./_to-integer":161}],157:[function(require,module,exports){
var $export = require('./_export');
var defined = require('./_defined');
var fails = require('./_fails');
var spaces = require('./_string-ws');
var space = '[' + spaces + ']';
var non = '\u200b\u0085';
var ltrim = RegExp('^' + space + space + '*');
var rtrim = RegExp(space + space + '*$');

var exporter = function (KEY, exec, ALIAS) {
  var exp = {};
  var FORCE = fails(function () {
    return !!spaces[KEY]() || non[KEY]() != non;
  });
  var fn = exp[KEY] = FORCE ? exec(trim) : spaces[KEY];
  if (ALIAS) exp[ALIAS] = fn;
  $export($export.P + $export.F * FORCE, 'String', exp);
};

// 1 -> String#trimLeft
// 2 -> String#trimRight
// 3 -> String#trim
var trim = exporter.trim = function (string, TYPE) {
  string = String(defined(string));
  if (TYPE & 1) string = string.replace(ltrim, '');
  if (TYPE & 2) string = string.replace(rtrim, '');
  return string;
};

module.exports = exporter;

},{"./_defined":100,"./_export":105,"./_fails":106,"./_string-ws":158}],158:[function(require,module,exports){
module.exports = '\x09\x0A\x0B\x0C\x0D\x20\xA0\u1680\u180E\u2000\u2001\u2002\u2003' +
  '\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u2028\u2029\uFEFF';

},{}],159:[function(require,module,exports){
var ctx = require('./_ctx');
var invoke = require('./_invoke');
var html = require('./_html');
var cel = require('./_dom-create');
var global = require('./_global');
var process = global.process;
var setTask = global.setImmediate;
var clearTask = global.clearImmediate;
var MessageChannel = global.MessageChannel;
var Dispatch = global.Dispatch;
var counter = 0;
var queue = {};
var ONREADYSTATECHANGE = 'onreadystatechange';
var defer, channel, port;
var run = function () {
  var id = +this;
  // eslint-disable-next-line no-prototype-builtins
  if (queue.hasOwnProperty(id)) {
    var fn = queue[id];
    delete queue[id];
    fn();
  }
};
var listener = function (event) {
  run.call(event.data);
};
// Node.js 0.9+ & IE10+ has setImmediate, otherwise:
if (!setTask || !clearTask) {
  setTask = function setImmediate(fn) {
    var args = [];
    var i = 1;
    while (arguments.length > i) args.push(arguments[i++]);
    queue[++counter] = function () {
      // eslint-disable-next-line no-new-func
      invoke(typeof fn == 'function' ? fn : Function(fn), args);
    };
    defer(counter);
    return counter;
  };
  clearTask = function clearImmediate(id) {
    delete queue[id];
  };
  // Node.js 0.8-
  if (require('./_cof')(process) == 'process') {
    defer = function (id) {
      process.nextTick(ctx(run, id, 1));
    };
  // Sphere (JS game engine) Dispatch API
  } else if (Dispatch && Dispatch.now) {
    defer = function (id) {
      Dispatch.now(ctx(run, id, 1));
    };
  // Browsers with MessageChannel, includes WebWorkers
  } else if (MessageChannel) {
    channel = new MessageChannel();
    port = channel.port2;
    channel.port1.onmessage = listener;
    defer = ctx(port.postMessage, port, 1);
  // Browsers with postMessage, skip WebWorkers
  // IE8 has postMessage, but it's sync & typeof its postMessage is 'object'
  } else if (global.addEventListener && typeof postMessage == 'function' && !global.importScripts) {
    defer = function (id) {
      global.postMessage(id + '', '*');
    };
    global.addEventListener('message', listener, false);
  // IE8-
  } else if (ONREADYSTATECHANGE in cel('script')) {
    defer = function (id) {
      html.appendChild(cel('script'))[ONREADYSTATECHANGE] = function () {
        html.removeChild(this);
        run.call(id);
      };
    };
  // Rest old browsers
  } else {
    defer = function (id) {
      setTimeout(ctx(run, id, 1), 0);
    };
  }
}
module.exports = {
  set: setTask,
  clear: clearTask
};

},{"./_cof":93,"./_ctx":99,"./_dom-create":102,"./_global":108,"./_html":111,"./_invoke":113}],160:[function(require,module,exports){
var toInteger = require('./_to-integer');
var max = Math.max;
var min = Math.min;
module.exports = function (index, length) {
  index = toInteger(index);
  return index < 0 ? max(index + length, 0) : min(index, length);
};

},{"./_to-integer":161}],161:[function(require,module,exports){
// 7.1.4 ToInteger
var ceil = Math.ceil;
var floor = Math.floor;
module.exports = function (it) {
  return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
};

},{}],162:[function(require,module,exports){
// to indexed object, toObject with fallback for non-array-like ES3 strings
var IObject = require('./_iobject');
var defined = require('./_defined');
module.exports = function (it) {
  return IObject(defined(it));
};

},{"./_defined":100,"./_iobject":114}],163:[function(require,module,exports){
// 7.1.15 ToLength
var toInteger = require('./_to-integer');
var min = Math.min;
module.exports = function (it) {
  return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0; // pow(2, 53) - 1 == 9007199254740991
};

},{"./_to-integer":161}],164:[function(require,module,exports){
// 7.1.13 ToObject(argument)
var defined = require('./_defined');
module.exports = function (it) {
  return Object(defined(it));
};

},{"./_defined":100}],165:[function(require,module,exports){
// 7.1.1 ToPrimitive(input [, PreferredType])
var isObject = require('./_is-object');
// instead of the ES6 spec version, we didn't implement @@toPrimitive case
// and the second argument - flag - preferred type is a string
module.exports = function (it, S) {
  if (!isObject(it)) return it;
  var fn, val;
  if (S && typeof (fn = it.toString) == 'function' && !isObject(val = fn.call(it))) return val;
  if (typeof (fn = it.valueOf) == 'function' && !isObject(val = fn.call(it))) return val;
  if (!S && typeof (fn = it.toString) == 'function' && !isObject(val = fn.call(it))) return val;
  throw TypeError("Can't convert object to primitive value");
};

},{"./_is-object":118}],166:[function(require,module,exports){
var id = 0;
var px = Math.random();
module.exports = function (key) {
  return 'Symbol('.concat(key === undefined ? '' : key, ')_', (++id + px).toString(36));
};

},{}],167:[function(require,module,exports){
var global = require('./_global');
var navigator = global.navigator;

module.exports = navigator && navigator.userAgent || '';

},{"./_global":108}],168:[function(require,module,exports){
var isObject = require('./_is-object');
module.exports = function (it, TYPE) {
  if (!isObject(it) || it._t !== TYPE) throw TypeError('Incompatible receiver, ' + TYPE + ' required!');
  return it;
};

},{"./_is-object":118}],169:[function(require,module,exports){
var global = require('./_global');
var core = require('./_core');
var LIBRARY = require('./_library');
var wksExt = require('./_wks-ext');
var defineProperty = require('./_object-dp').f;
module.exports = function (name) {
  var $Symbol = core.Symbol || (core.Symbol = LIBRARY ? {} : global.Symbol || {});
  if (name.charAt(0) != '_' && !(name in $Symbol)) defineProperty($Symbol, name, { value: wksExt.f(name) });
};

},{"./_core":97,"./_global":108,"./_library":125,"./_object-dp":131,"./_wks-ext":170}],170:[function(require,module,exports){
exports.f = require('./_wks');

},{"./_wks":171}],171:[function(require,module,exports){
var store = require('./_shared')('wks');
var uid = require('./_uid');
var Symbol = require('./_global').Symbol;
var USE_SYMBOL = typeof Symbol == 'function';

var $exports = module.exports = function (name) {
  return store[name] || (store[name] =
    USE_SYMBOL && Symbol[name] || (USE_SYMBOL ? Symbol : uid)('Symbol.' + name));
};

$exports.store = store;

},{"./_global":108,"./_shared":154,"./_uid":166}],172:[function(require,module,exports){
var classof = require('./_classof');
var ITERATOR = require('./_wks')('iterator');
var Iterators = require('./_iterators');
module.exports = require('./_core').getIteratorMethod = function (it) {
  if (it != undefined) return it[ITERATOR]
    || it['@@iterator']
    || Iterators[classof(it)];
};

},{"./_classof":92,"./_core":97,"./_iterators":124,"./_wks":171}],173:[function(require,module,exports){
var anObject = require('./_an-object');
var get = require('./core.get-iterator-method');
module.exports = require('./_core').getIterator = function (it) {
  var iterFn = get(it);
  if (typeof iterFn != 'function') throw TypeError(it + ' is not iterable!');
  return anObject(iterFn.call(it));
};

},{"./_an-object":85,"./_core":97,"./core.get-iterator-method":172}],174:[function(require,module,exports){
var classof = require('./_classof');
var ITERATOR = require('./_wks')('iterator');
var Iterators = require('./_iterators');
module.exports = require('./_core').isIterable = function (it) {
  var O = Object(it);
  return O[ITERATOR] !== undefined
    || '@@iterator' in O
    // eslint-disable-next-line no-prototype-builtins
    || Iterators.hasOwnProperty(classof(O));
};

},{"./_classof":92,"./_core":97,"./_iterators":124,"./_wks":171}],175:[function(require,module,exports){
'use strict';
var ctx = require('./_ctx');
var $export = require('./_export');
var toObject = require('./_to-object');
var call = require('./_iter-call');
var isArrayIter = require('./_is-array-iter');
var toLength = require('./_to-length');
var createProperty = require('./_create-property');
var getIterFn = require('./core.get-iterator-method');

$export($export.S + $export.F * !require('./_iter-detect')(function (iter) { Array.from(iter); }), 'Array', {
  // 22.1.2.1 Array.from(arrayLike, mapfn = undefined, thisArg = undefined)
  from: function from(arrayLike /* , mapfn = undefined, thisArg = undefined */) {
    var O = toObject(arrayLike);
    var C = typeof this == 'function' ? this : Array;
    var aLen = arguments.length;
    var mapfn = aLen > 1 ? arguments[1] : undefined;
    var mapping = mapfn !== undefined;
    var index = 0;
    var iterFn = getIterFn(O);
    var length, result, step, iterator;
    if (mapping) mapfn = ctx(mapfn, aLen > 2 ? arguments[2] : undefined, 2);
    // if object isn't iterable or it's array with default iterator - use simple case
    if (iterFn != undefined && !(C == Array && isArrayIter(iterFn))) {
      for (iterator = iterFn.call(O), result = new C(); !(step = iterator.next()).done; index++) {
        createProperty(result, index, mapping ? call(iterator, mapfn, [step.value, index], true) : step.value);
      }
    } else {
      length = toLength(O.length);
      for (result = new C(length); length > index; index++) {
        createProperty(result, index, mapping ? mapfn(O[index], index) : O[index]);
      }
    }
    result.length = index;
    return result;
  }
});

},{"./_create-property":98,"./_ctx":99,"./_export":105,"./_is-array-iter":115,"./_iter-call":119,"./_iter-detect":122,"./_to-length":163,"./_to-object":164,"./core.get-iterator-method":172}],176:[function(require,module,exports){
// 22.1.2.2 / 15.4.3.2 Array.isArray(arg)
var $export = require('./_export');

$export($export.S, 'Array', { isArray: require('./_is-array') });

},{"./_export":105,"./_is-array":116}],177:[function(require,module,exports){
'use strict';
var addToUnscopables = require('./_add-to-unscopables');
var step = require('./_iter-step');
var Iterators = require('./_iterators');
var toIObject = require('./_to-iobject');

// 22.1.3.4 Array.prototype.entries()
// 22.1.3.13 Array.prototype.keys()
// 22.1.3.29 Array.prototype.values()
// 22.1.3.30 Array.prototype[@@iterator]()
module.exports = require('./_iter-define')(Array, 'Array', function (iterated, kind) {
  this._t = toIObject(iterated); // target
  this._i = 0;                   // next index
  this._k = kind;                // kind
// 22.1.5.2.1 %ArrayIteratorPrototype%.next()
}, function () {
  var O = this._t;
  var kind = this._k;
  var index = this._i++;
  if (!O || index >= O.length) {
    this._t = undefined;
    return step(1);
  }
  if (kind == 'keys') return step(0, index);
  if (kind == 'values') return step(0, O[index]);
  return step(0, [index, O[index]]);
}, 'values');

// argumentsList[@@iterator] is %ArrayProto_values% (9.4.4.6, 9.4.4.7)
Iterators.Arguments = Iterators.Array;

addToUnscopables('keys');
addToUnscopables('values');
addToUnscopables('entries');

},{"./_add-to-unscopables":83,"./_iter-define":121,"./_iter-step":123,"./_iterators":124,"./_to-iobject":162}],178:[function(require,module,exports){
// 20.1.2.3 Number.isInteger(number)
var $export = require('./_export');

$export($export.S, 'Number', { isInteger: require('./_is-integer') });

},{"./_export":105,"./_is-integer":117}],179:[function(require,module,exports){
// 19.1.3.1 Object.assign(target, source)
var $export = require('./_export');

$export($export.S + $export.F, 'Object', { assign: require('./_object-assign') });

},{"./_export":105,"./_object-assign":129}],180:[function(require,module,exports){
var $export = require('./_export');
// 19.1.2.2 / 15.2.3.5 Object.create(O [, Properties])
$export($export.S, 'Object', { create: require('./_object-create') });

},{"./_export":105,"./_object-create":130}],181:[function(require,module,exports){
var $export = require('./_export');
// 19.1.2.3 / 15.2.3.7 Object.defineProperties(O, Properties)
$export($export.S + $export.F * !require('./_descriptors'), 'Object', { defineProperties: require('./_object-dps') });

},{"./_descriptors":101,"./_export":105,"./_object-dps":132}],182:[function(require,module,exports){
var $export = require('./_export');
// 19.1.2.4 / 15.2.3.6 Object.defineProperty(O, P, Attributes)
$export($export.S + $export.F * !require('./_descriptors'), 'Object', { defineProperty: require('./_object-dp').f });

},{"./_descriptors":101,"./_export":105,"./_object-dp":131}],183:[function(require,module,exports){
// 19.1.2.6 Object.getOwnPropertyDescriptor(O, P)
var toIObject = require('./_to-iobject');
var $getOwnPropertyDescriptor = require('./_object-gopd').f;

require('./_object-sap')('getOwnPropertyDescriptor', function () {
  return function getOwnPropertyDescriptor(it, key) {
    return $getOwnPropertyDescriptor(toIObject(it), key);
  };
});

},{"./_object-gopd":133,"./_object-sap":141,"./_to-iobject":162}],184:[function(require,module,exports){
// 19.1.2.7 Object.getOwnPropertyNames(O)
require('./_object-sap')('getOwnPropertyNames', function () {
  return require('./_object-gopn-ext').f;
});

},{"./_object-gopn-ext":134,"./_object-sap":141}],185:[function(require,module,exports){
// 19.1.2.9 Object.getPrototypeOf(O)
var toObject = require('./_to-object');
var $getPrototypeOf = require('./_object-gpo');

require('./_object-sap')('getPrototypeOf', function () {
  return function getPrototypeOf(it) {
    return $getPrototypeOf(toObject(it));
  };
});

},{"./_object-gpo":137,"./_object-sap":141,"./_to-object":164}],186:[function(require,module,exports){
// 19.1.2.14 Object.keys(O)
var toObject = require('./_to-object');
var $keys = require('./_object-keys');

require('./_object-sap')('keys', function () {
  return function keys(it) {
    return $keys(toObject(it));
  };
});

},{"./_object-keys":139,"./_object-sap":141,"./_to-object":164}],187:[function(require,module,exports){
// 19.1.3.19 Object.setPrototypeOf(O, proto)
var $export = require('./_export');
$export($export.S, 'Object', { setPrototypeOf: require('./_set-proto').set });

},{"./_export":105,"./_set-proto":150}],188:[function(require,module,exports){

},{}],189:[function(require,module,exports){
var $export = require('./_export');
var $parseInt = require('./_parse-int');
// 18.2.5 parseInt(string, radix)
$export($export.G + $export.F * (parseInt != $parseInt), { parseInt: $parseInt });

},{"./_export":105,"./_parse-int":142}],190:[function(require,module,exports){
'use strict';
var LIBRARY = require('./_library');
var global = require('./_global');
var ctx = require('./_ctx');
var classof = require('./_classof');
var $export = require('./_export');
var isObject = require('./_is-object');
var aFunction = require('./_a-function');
var anInstance = require('./_an-instance');
var forOf = require('./_for-of');
var speciesConstructor = require('./_species-constructor');
var task = require('./_task').set;
var microtask = require('./_microtask')();
var newPromiseCapabilityModule = require('./_new-promise-capability');
var perform = require('./_perform');
var userAgent = require('./_user-agent');
var promiseResolve = require('./_promise-resolve');
var PROMISE = 'Promise';
var TypeError = global.TypeError;
var process = global.process;
var versions = process && process.versions;
var v8 = versions && versions.v8 || '';
var $Promise = global[PROMISE];
var isNode = classof(process) == 'process';
var empty = function () { /* empty */ };
var Internal, newGenericPromiseCapability, OwnPromiseCapability, Wrapper;
var newPromiseCapability = newGenericPromiseCapability = newPromiseCapabilityModule.f;

var USE_NATIVE = !!function () {
  try {
    // correct subclassing with @@species support
    var promise = $Promise.resolve(1);
    var FakePromise = (promise.constructor = {})[require('./_wks')('species')] = function (exec) {
      exec(empty, empty);
    };
    // unhandled rejections tracking support, NodeJS Promise without it fails @@species test
    return (isNode || typeof PromiseRejectionEvent == 'function')
      && promise.then(empty) instanceof FakePromise
      // v8 6.6 (Node 10 and Chrome 66) have a bug with resolving custom thenables
      // https://bugs.chromium.org/p/chromium/issues/detail?id=830565
      // we can't detect it synchronously, so just check versions
      && v8.indexOf('6.6') !== 0
      && userAgent.indexOf('Chrome/66') === -1;
  } catch (e) { /* empty */ }
}();

// helpers
var isThenable = function (it) {
  var then;
  return isObject(it) && typeof (then = it.then) == 'function' ? then : false;
};
var notify = function (promise, isReject) {
  if (promise._n) return;
  promise._n = true;
  var chain = promise._c;
  microtask(function () {
    var value = promise._v;
    var ok = promise._s == 1;
    var i = 0;
    var run = function (reaction) {
      var handler = ok ? reaction.ok : reaction.fail;
      var resolve = reaction.resolve;
      var reject = reaction.reject;
      var domain = reaction.domain;
      var result, then, exited;
      try {
        if (handler) {
          if (!ok) {
            if (promise._h == 2) onHandleUnhandled(promise);
            promise._h = 1;
          }
          if (handler === true) result = value;
          else {
            if (domain) domain.enter();
            result = handler(value); // may throw
            if (domain) {
              domain.exit();
              exited = true;
            }
          }
          if (result === reaction.promise) {
            reject(TypeError('Promise-chain cycle'));
          } else if (then = isThenable(result)) {
            then.call(result, resolve, reject);
          } else resolve(result);
        } else reject(value);
      } catch (e) {
        if (domain && !exited) domain.exit();
        reject(e);
      }
    };
    while (chain.length > i) run(chain[i++]); // variable length - can't use forEach
    promise._c = [];
    promise._n = false;
    if (isReject && !promise._h) onUnhandled(promise);
  });
};
var onUnhandled = function (promise) {
  task.call(global, function () {
    var value = promise._v;
    var unhandled = isUnhandled(promise);
    var result, handler, console;
    if (unhandled) {
      result = perform(function () {
        if (isNode) {
          process.emit('unhandledRejection', value, promise);
        } else if (handler = global.onunhandledrejection) {
          handler({ promise: promise, reason: value });
        } else if ((console = global.console) && console.error) {
          console.error('Unhandled promise rejection', value);
        }
      });
      // Browsers should not trigger `rejectionHandled` event if it was handled here, NodeJS - should
      promise._h = isNode || isUnhandled(promise) ? 2 : 1;
    } promise._a = undefined;
    if (unhandled && result.e) throw result.v;
  });
};
var isUnhandled = function (promise) {
  return promise._h !== 1 && (promise._a || promise._c).length === 0;
};
var onHandleUnhandled = function (promise) {
  task.call(global, function () {
    var handler;
    if (isNode) {
      process.emit('rejectionHandled', promise);
    } else if (handler = global.onrejectionhandled) {
      handler({ promise: promise, reason: promise._v });
    }
  });
};
var $reject = function (value) {
  var promise = this;
  if (promise._d) return;
  promise._d = true;
  promise = promise._w || promise; // unwrap
  promise._v = value;
  promise._s = 2;
  if (!promise._a) promise._a = promise._c.slice();
  notify(promise, true);
};
var $resolve = function (value) {
  var promise = this;
  var then;
  if (promise._d) return;
  promise._d = true;
  promise = promise._w || promise; // unwrap
  try {
    if (promise === value) throw TypeError("Promise can't be resolved itself");
    if (then = isThenable(value)) {
      microtask(function () {
        var wrapper = { _w: promise, _d: false }; // wrap
        try {
          then.call(value, ctx($resolve, wrapper, 1), ctx($reject, wrapper, 1));
        } catch (e) {
          $reject.call(wrapper, e);
        }
      });
    } else {
      promise._v = value;
      promise._s = 1;
      notify(promise, false);
    }
  } catch (e) {
    $reject.call({ _w: promise, _d: false }, e); // wrap
  }
};

// constructor polyfill
if (!USE_NATIVE) {
  // 25.4.3.1 Promise(executor)
  $Promise = function Promise(executor) {
    anInstance(this, $Promise, PROMISE, '_h');
    aFunction(executor);
    Internal.call(this);
    try {
      executor(ctx($resolve, this, 1), ctx($reject, this, 1));
    } catch (err) {
      $reject.call(this, err);
    }
  };
  // eslint-disable-next-line no-unused-vars
  Internal = function Promise(executor) {
    this._c = [];             // <- awaiting reactions
    this._a = undefined;      // <- checked in isUnhandled reactions
    this._s = 0;              // <- state
    this._d = false;          // <- done
    this._v = undefined;      // <- value
    this._h = 0;              // <- rejection state, 0 - default, 1 - handled, 2 - unhandled
    this._n = false;          // <- notify
  };
  Internal.prototype = require('./_redefine-all')($Promise.prototype, {
    // 25.4.5.3 Promise.prototype.then(onFulfilled, onRejected)
    then: function then(onFulfilled, onRejected) {
      var reaction = newPromiseCapability(speciesConstructor(this, $Promise));
      reaction.ok = typeof onFulfilled == 'function' ? onFulfilled : true;
      reaction.fail = typeof onRejected == 'function' && onRejected;
      reaction.domain = isNode ? process.domain : undefined;
      this._c.push(reaction);
      if (this._a) this._a.push(reaction);
      if (this._s) notify(this, false);
      return reaction.promise;
    },
    // 25.4.5.1 Promise.prototype.catch(onRejected)
    'catch': function (onRejected) {
      return this.then(undefined, onRejected);
    }
  });
  OwnPromiseCapability = function () {
    var promise = new Internal();
    this.promise = promise;
    this.resolve = ctx($resolve, promise, 1);
    this.reject = ctx($reject, promise, 1);
  };
  newPromiseCapabilityModule.f = newPromiseCapability = function (C) {
    return C === $Promise || C === Wrapper
      ? new OwnPromiseCapability(C)
      : newGenericPromiseCapability(C);
  };
}

$export($export.G + $export.W + $export.F * !USE_NATIVE, { Promise: $Promise });
require('./_set-to-string-tag')($Promise, PROMISE);
require('./_set-species')(PROMISE);
Wrapper = require('./_core')[PROMISE];

// statics
$export($export.S + $export.F * !USE_NATIVE, PROMISE, {
  // 25.4.4.5 Promise.reject(r)
  reject: function reject(r) {
    var capability = newPromiseCapability(this);
    var $$reject = capability.reject;
    $$reject(r);
    return capability.promise;
  }
});
$export($export.S + $export.F * (LIBRARY || !USE_NATIVE), PROMISE, {
  // 25.4.4.6 Promise.resolve(x)
  resolve: function resolve(x) {
    return promiseResolve(LIBRARY && this === Wrapper ? $Promise : this, x);
  }
});
$export($export.S + $export.F * !(USE_NATIVE && require('./_iter-detect')(function (iter) {
  $Promise.all(iter)['catch'](empty);
})), PROMISE, {
  // 25.4.4.1 Promise.all(iterable)
  all: function all(iterable) {
    var C = this;
    var capability = newPromiseCapability(C);
    var resolve = capability.resolve;
    var reject = capability.reject;
    var result = perform(function () {
      var values = [];
      var index = 0;
      var remaining = 1;
      forOf(iterable, false, function (promise) {
        var $index = index++;
        var alreadyCalled = false;
        values.push(undefined);
        remaining++;
        C.resolve(promise).then(function (value) {
          if (alreadyCalled) return;
          alreadyCalled = true;
          values[$index] = value;
          --remaining || resolve(values);
        }, reject);
      });
      --remaining || resolve(values);
    });
    if (result.e) reject(result.v);
    return capability.promise;
  },
  // 25.4.4.4 Promise.race(iterable)
  race: function race(iterable) {
    var C = this;
    var capability = newPromiseCapability(C);
    var reject = capability.reject;
    var result = perform(function () {
      forOf(iterable, false, function (promise) {
        C.resolve(promise).then(capability.resolve, reject);
      });
    });
    if (result.e) reject(result.v);
    return capability.promise;
  }
});

},{"./_a-function":82,"./_an-instance":84,"./_classof":92,"./_core":97,"./_ctx":99,"./_export":105,"./_for-of":107,"./_global":108,"./_is-object":118,"./_iter-detect":122,"./_library":125,"./_microtask":127,"./_new-promise-capability":128,"./_perform":143,"./_promise-resolve":144,"./_redefine-all":146,"./_set-species":151,"./_set-to-string-tag":152,"./_species-constructor":155,"./_task":159,"./_user-agent":167,"./_wks":171}],191:[function(require,module,exports){
// 26.1.2 Reflect.construct(target, argumentsList [, newTarget])
var $export = require('./_export');
var create = require('./_object-create');
var aFunction = require('./_a-function');
var anObject = require('./_an-object');
var isObject = require('./_is-object');
var fails = require('./_fails');
var bind = require('./_bind');
var rConstruct = (require('./_global').Reflect || {}).construct;

// MS Edge supports only 2 arguments and argumentsList argument is optional
// FF Nightly sets third argument as `new.target`, but does not create `this` from it
var NEW_TARGET_BUG = fails(function () {
  function F() { /* empty */ }
  return !(rConstruct(function () { /* empty */ }, [], F) instanceof F);
});
var ARGS_BUG = !fails(function () {
  rConstruct(function () { /* empty */ });
});

$export($export.S + $export.F * (NEW_TARGET_BUG || ARGS_BUG), 'Reflect', {
  construct: function construct(Target, args /* , newTarget */) {
    aFunction(Target);
    anObject(args);
    var newTarget = arguments.length < 3 ? Target : aFunction(arguments[2]);
    if (ARGS_BUG && !NEW_TARGET_BUG) return rConstruct(Target, args, newTarget);
    if (Target == newTarget) {
      // w/o altered newTarget, optimization for 0-4 arguments
      switch (args.length) {
        case 0: return new Target();
        case 1: return new Target(args[0]);
        case 2: return new Target(args[0], args[1]);
        case 3: return new Target(args[0], args[1], args[2]);
        case 4: return new Target(args[0], args[1], args[2], args[3]);
      }
      // w/o altered newTarget, lot of arguments case
      var $args = [null];
      $args.push.apply($args, args);
      return new (bind.apply(Target, $args))();
    }
    // with altered newTarget, not support built-in constructors
    var proto = newTarget.prototype;
    var instance = create(isObject(proto) ? proto : Object.prototype);
    var result = Function.apply.call(Target, instance, args);
    return isObject(result) ? result : instance;
  }
});

},{"./_a-function":82,"./_an-object":85,"./_bind":91,"./_export":105,"./_fails":106,"./_global":108,"./_is-object":118,"./_object-create":130}],192:[function(require,module,exports){
// 26.1.6 Reflect.get(target, propertyKey [, receiver])
var gOPD = require('./_object-gopd');
var getPrototypeOf = require('./_object-gpo');
var has = require('./_has');
var $export = require('./_export');
var isObject = require('./_is-object');
var anObject = require('./_an-object');

function get(target, propertyKey /* , receiver */) {
  var receiver = arguments.length < 3 ? target : arguments[2];
  var desc, proto;
  if (anObject(target) === receiver) return target[propertyKey];
  if (desc = gOPD.f(target, propertyKey)) return has(desc, 'value')
    ? desc.value
    : desc.get !== undefined
      ? desc.get.call(receiver)
      : undefined;
  if (isObject(proto = getPrototypeOf(target))) return get(proto, propertyKey, receiver);
}

$export($export.S, 'Reflect', { get: get });

},{"./_an-object":85,"./_export":105,"./_has":109,"./_is-object":118,"./_object-gopd":133,"./_object-gpo":137}],193:[function(require,module,exports){
'use strict';
var strong = require('./_collection-strong');
var validate = require('./_validate-collection');
var SET = 'Set';

// 23.2 Set Objects
module.exports = require('./_collection')(SET, function (get) {
  return function Set() { return get(this, arguments.length > 0 ? arguments[0] : undefined); };
}, {
  // 23.2.3.1 Set.prototype.add(value)
  add: function add(value) {
    return strong.def(validate(this, SET), value = value === 0 ? 0 : value, value);
  }
}, strong);

},{"./_collection":96,"./_collection-strong":94,"./_validate-collection":168}],194:[function(require,module,exports){
'use strict';
var $at = require('./_string-at')(true);

// 21.1.3.27 String.prototype[@@iterator]()
require('./_iter-define')(String, 'String', function (iterated) {
  this._t = String(iterated); // target
  this._i = 0;                // next index
// 21.1.5.2.1 %StringIteratorPrototype%.next()
}, function () {
  var O = this._t;
  var index = this._i;
  var point;
  if (index >= O.length) return { value: undefined, done: true };
  point = $at(O, index);
  this._i += point.length;
  return { value: point, done: false };
});

},{"./_iter-define":121,"./_string-at":156}],195:[function(require,module,exports){
'use strict';
// ECMAScript 6 symbols shim
var global = require('./_global');
var has = require('./_has');
var DESCRIPTORS = require('./_descriptors');
var $export = require('./_export');
var redefine = require('./_redefine');
var META = require('./_meta').KEY;
var $fails = require('./_fails');
var shared = require('./_shared');
var setToStringTag = require('./_set-to-string-tag');
var uid = require('./_uid');
var wks = require('./_wks');
var wksExt = require('./_wks-ext');
var wksDefine = require('./_wks-define');
var enumKeys = require('./_enum-keys');
var isArray = require('./_is-array');
var anObject = require('./_an-object');
var isObject = require('./_is-object');
var toObject = require('./_to-object');
var toIObject = require('./_to-iobject');
var toPrimitive = require('./_to-primitive');
var createDesc = require('./_property-desc');
var _create = require('./_object-create');
var gOPNExt = require('./_object-gopn-ext');
var $GOPD = require('./_object-gopd');
var $GOPS = require('./_object-gops');
var $DP = require('./_object-dp');
var $keys = require('./_object-keys');
var gOPD = $GOPD.f;
var dP = $DP.f;
var gOPN = gOPNExt.f;
var $Symbol = global.Symbol;
var $JSON = global.JSON;
var _stringify = $JSON && $JSON.stringify;
var PROTOTYPE = 'prototype';
var HIDDEN = wks('_hidden');
var TO_PRIMITIVE = wks('toPrimitive');
var isEnum = {}.propertyIsEnumerable;
var SymbolRegistry = shared('symbol-registry');
var AllSymbols = shared('symbols');
var OPSymbols = shared('op-symbols');
var ObjectProto = Object[PROTOTYPE];
var USE_NATIVE = typeof $Symbol == 'function' && !!$GOPS.f;
var QObject = global.QObject;
// Don't use setters in Qt Script, https://github.com/zloirock/core-js/issues/173
var setter = !QObject || !QObject[PROTOTYPE] || !QObject[PROTOTYPE].findChild;

// fallback for old Android, https://code.google.com/p/v8/issues/detail?id=687
var setSymbolDesc = DESCRIPTORS && $fails(function () {
  return _create(dP({}, 'a', {
    get: function () { return dP(this, 'a', { value: 7 }).a; }
  })).a != 7;
}) ? function (it, key, D) {
  var protoDesc = gOPD(ObjectProto, key);
  if (protoDesc) delete ObjectProto[key];
  dP(it, key, D);
  if (protoDesc && it !== ObjectProto) dP(ObjectProto, key, protoDesc);
} : dP;

var wrap = function (tag) {
  var sym = AllSymbols[tag] = _create($Symbol[PROTOTYPE]);
  sym._k = tag;
  return sym;
};

var isSymbol = USE_NATIVE && typeof $Symbol.iterator == 'symbol' ? function (it) {
  return typeof it == 'symbol';
} : function (it) {
  return it instanceof $Symbol;
};

var $defineProperty = function defineProperty(it, key, D) {
  if (it === ObjectProto) $defineProperty(OPSymbols, key, D);
  anObject(it);
  key = toPrimitive(key, true);
  anObject(D);
  if (has(AllSymbols, key)) {
    if (!D.enumerable) {
      if (!has(it, HIDDEN)) dP(it, HIDDEN, createDesc(1, {}));
      it[HIDDEN][key] = true;
    } else {
      if (has(it, HIDDEN) && it[HIDDEN][key]) it[HIDDEN][key] = false;
      D = _create(D, { enumerable: createDesc(0, false) });
    } return setSymbolDesc(it, key, D);
  } return dP(it, key, D);
};
var $defineProperties = function defineProperties(it, P) {
  anObject(it);
  var keys = enumKeys(P = toIObject(P));
  var i = 0;
  var l = keys.length;
  var key;
  while (l > i) $defineProperty(it, key = keys[i++], P[key]);
  return it;
};
var $create = function create(it, P) {
  return P === undefined ? _create(it) : $defineProperties(_create(it), P);
};
var $propertyIsEnumerable = function propertyIsEnumerable(key) {
  var E = isEnum.call(this, key = toPrimitive(key, true));
  if (this === ObjectProto && has(AllSymbols, key) && !has(OPSymbols, key)) return false;
  return E || !has(this, key) || !has(AllSymbols, key) || has(this, HIDDEN) && this[HIDDEN][key] ? E : true;
};
var $getOwnPropertyDescriptor = function getOwnPropertyDescriptor(it, key) {
  it = toIObject(it);
  key = toPrimitive(key, true);
  if (it === ObjectProto && has(AllSymbols, key) && !has(OPSymbols, key)) return;
  var D = gOPD(it, key);
  if (D && has(AllSymbols, key) && !(has(it, HIDDEN) && it[HIDDEN][key])) D.enumerable = true;
  return D;
};
var $getOwnPropertyNames = function getOwnPropertyNames(it) {
  var names = gOPN(toIObject(it));
  var result = [];
  var i = 0;
  var key;
  while (names.length > i) {
    if (!has(AllSymbols, key = names[i++]) && key != HIDDEN && key != META) result.push(key);
  } return result;
};
var $getOwnPropertySymbols = function getOwnPropertySymbols(it) {
  var IS_OP = it === ObjectProto;
  var names = gOPN(IS_OP ? OPSymbols : toIObject(it));
  var result = [];
  var i = 0;
  var key;
  while (names.length > i) {
    if (has(AllSymbols, key = names[i++]) && (IS_OP ? has(ObjectProto, key) : true)) result.push(AllSymbols[key]);
  } return result;
};

// 19.4.1.1 Symbol([description])
if (!USE_NATIVE) {
  $Symbol = function Symbol() {
    if (this instanceof $Symbol) throw TypeError('Symbol is not a constructor!');
    var tag = uid(arguments.length > 0 ? arguments[0] : undefined);
    var $set = function (value) {
      if (this === ObjectProto) $set.call(OPSymbols, value);
      if (has(this, HIDDEN) && has(this[HIDDEN], tag)) this[HIDDEN][tag] = false;
      setSymbolDesc(this, tag, createDesc(1, value));
    };
    if (DESCRIPTORS && setter) setSymbolDesc(ObjectProto, tag, { configurable: true, set: $set });
    return wrap(tag);
  };
  redefine($Symbol[PROTOTYPE], 'toString', function toString() {
    return this._k;
  });

  $GOPD.f = $getOwnPropertyDescriptor;
  $DP.f = $defineProperty;
  require('./_object-gopn').f = gOPNExt.f = $getOwnPropertyNames;
  require('./_object-pie').f = $propertyIsEnumerable;
  $GOPS.f = $getOwnPropertySymbols;

  if (DESCRIPTORS && !require('./_library')) {
    redefine(ObjectProto, 'propertyIsEnumerable', $propertyIsEnumerable, true);
  }

  wksExt.f = function (name) {
    return wrap(wks(name));
  };
}

$export($export.G + $export.W + $export.F * !USE_NATIVE, { Symbol: $Symbol });

for (var es6Symbols = (
  // 19.4.2.2, 19.4.2.3, 19.4.2.4, 19.4.2.6, 19.4.2.8, 19.4.2.9, 19.4.2.10, 19.4.2.11, 19.4.2.12, 19.4.2.13, 19.4.2.14
  'hasInstance,isConcatSpreadable,iterator,match,replace,search,species,split,toPrimitive,toStringTag,unscopables'
).split(','), j = 0; es6Symbols.length > j;)wks(es6Symbols[j++]);

for (var wellKnownSymbols = $keys(wks.store), k = 0; wellKnownSymbols.length > k;) wksDefine(wellKnownSymbols[k++]);

$export($export.S + $export.F * !USE_NATIVE, 'Symbol', {
  // 19.4.2.1 Symbol.for(key)
  'for': function (key) {
    return has(SymbolRegistry, key += '')
      ? SymbolRegistry[key]
      : SymbolRegistry[key] = $Symbol(key);
  },
  // 19.4.2.5 Symbol.keyFor(sym)
  keyFor: function keyFor(sym) {
    if (!isSymbol(sym)) throw TypeError(sym + ' is not a symbol!');
    for (var key in SymbolRegistry) if (SymbolRegistry[key] === sym) return key;
  },
  useSetter: function () { setter = true; },
  useSimple: function () { setter = false; }
});

$export($export.S + $export.F * !USE_NATIVE, 'Object', {
  // 19.1.2.2 Object.create(O [, Properties])
  create: $create,
  // 19.1.2.4 Object.defineProperty(O, P, Attributes)
  defineProperty: $defineProperty,
  // 19.1.2.3 Object.defineProperties(O, Properties)
  defineProperties: $defineProperties,
  // 19.1.2.6 Object.getOwnPropertyDescriptor(O, P)
  getOwnPropertyDescriptor: $getOwnPropertyDescriptor,
  // 19.1.2.7 Object.getOwnPropertyNames(O)
  getOwnPropertyNames: $getOwnPropertyNames,
  // 19.1.2.8 Object.getOwnPropertySymbols(O)
  getOwnPropertySymbols: $getOwnPropertySymbols
});

// Chrome 38 and 39 `Object.getOwnPropertySymbols` fails on primitives
// https://bugs.chromium.org/p/v8/issues/detail?id=3443
var FAILS_ON_PRIMITIVES = $fails(function () { $GOPS.f(1); });

$export($export.S + $export.F * FAILS_ON_PRIMITIVES, 'Object', {
  getOwnPropertySymbols: function getOwnPropertySymbols(it) {
    return $GOPS.f(toObject(it));
  }
});

// 24.3.2 JSON.stringify(value [, replacer [, space]])
$JSON && $export($export.S + $export.F * (!USE_NATIVE || $fails(function () {
  var S = $Symbol();
  // MS Edge converts symbol values to JSON as {}
  // WebKit converts symbol values to JSON as null
  // V8 throws on boxed symbols
  return _stringify([S]) != '[null]' || _stringify({ a: S }) != '{}' || _stringify(Object(S)) != '{}';
})), 'JSON', {
  stringify: function stringify(it) {
    var args = [it];
    var i = 1;
    var replacer, $replacer;
    while (arguments.length > i) args.push(arguments[i++]);
    $replacer = replacer = args[1];
    if (!isObject(replacer) && it === undefined || isSymbol(it)) return; // IE8 returns string on undefined
    if (!isArray(replacer)) replacer = function (key, value) {
      if (typeof $replacer == 'function') value = $replacer.call(this, key, value);
      if (!isSymbol(value)) return value;
    };
    args[1] = replacer;
    return _stringify.apply($JSON, args);
  }
});

// 19.4.3.4 Symbol.prototype[@@toPrimitive](hint)
$Symbol[PROTOTYPE][TO_PRIMITIVE] || require('./_hide')($Symbol[PROTOTYPE], TO_PRIMITIVE, $Symbol[PROTOTYPE].valueOf);
// 19.4.3.5 Symbol.prototype[@@toStringTag]
setToStringTag($Symbol, 'Symbol');
// 20.2.1.9 Math[@@toStringTag]
setToStringTag(Math, 'Math', true);
// 24.3.3 JSON[@@toStringTag]
setToStringTag(global.JSON, 'JSON', true);

},{"./_an-object":85,"./_descriptors":101,"./_enum-keys":104,"./_export":105,"./_fails":106,"./_global":108,"./_has":109,"./_hide":110,"./_is-array":116,"./_is-object":118,"./_library":125,"./_meta":126,"./_object-create":130,"./_object-dp":131,"./_object-gopd":133,"./_object-gopn":135,"./_object-gopn-ext":134,"./_object-gops":136,"./_object-keys":139,"./_object-pie":140,"./_property-desc":145,"./_redefine":147,"./_set-to-string-tag":152,"./_shared":154,"./_to-iobject":162,"./_to-object":164,"./_to-primitive":165,"./_uid":166,"./_wks":171,"./_wks-define":169,"./_wks-ext":170}],196:[function(require,module,exports){
// https://github.com/tc39/proposal-promise-finally
'use strict';
var $export = require('./_export');
var core = require('./_core');
var global = require('./_global');
var speciesConstructor = require('./_species-constructor');
var promiseResolve = require('./_promise-resolve');

$export($export.P + $export.R, 'Promise', { 'finally': function (onFinally) {
  var C = speciesConstructor(this, core.Promise || global.Promise);
  var isFunction = typeof onFinally == 'function';
  return this.then(
    isFunction ? function (x) {
      return promiseResolve(C, onFinally()).then(function () { return x; });
    } : onFinally,
    isFunction ? function (e) {
      return promiseResolve(C, onFinally()).then(function () { throw e; });
    } : onFinally
  );
} });

},{"./_core":97,"./_export":105,"./_global":108,"./_promise-resolve":144,"./_species-constructor":155}],197:[function(require,module,exports){
'use strict';
// https://github.com/tc39/proposal-promise-try
var $export = require('./_export');
var newPromiseCapability = require('./_new-promise-capability');
var perform = require('./_perform');

$export($export.S, 'Promise', { 'try': function (callbackfn) {
  var promiseCapability = newPromiseCapability.f(this);
  var result = perform(callbackfn);
  (result.e ? promiseCapability.reject : promiseCapability.resolve)(result.v);
  return promiseCapability.promise;
} });

},{"./_export":105,"./_new-promise-capability":128,"./_perform":143}],198:[function(require,module,exports){
// https://tc39.github.io/proposal-setmap-offrom/#sec-set.from
require('./_set-collection-from')('Set');

},{"./_set-collection-from":148}],199:[function(require,module,exports){
// https://tc39.github.io/proposal-setmap-offrom/#sec-set.of
require('./_set-collection-of')('Set');

},{"./_set-collection-of":149}],200:[function(require,module,exports){
// https://github.com/DavidBruant/Map-Set.prototype.toJSON
var $export = require('./_export');

$export($export.P + $export.R, 'Set', { toJSON: require('./_collection-to-json')('Set') });

},{"./_collection-to-json":95,"./_export":105}],201:[function(require,module,exports){
require('./_wks-define')('asyncIterator');

},{"./_wks-define":169}],202:[function(require,module,exports){
require('./_wks-define')('observable');

},{"./_wks-define":169}],203:[function(require,module,exports){
require('./es6.array.iterator');
var global = require('./_global');
var hide = require('./_hide');
var Iterators = require('./_iterators');
var TO_STRING_TAG = require('./_wks')('toStringTag');

var DOMIterables = ('CSSRuleList,CSSStyleDeclaration,CSSValueList,ClientRectList,DOMRectList,DOMStringList,' +
  'DOMTokenList,DataTransferItemList,FileList,HTMLAllCollection,HTMLCollection,HTMLFormElement,HTMLSelectElement,' +
  'MediaList,MimeTypeArray,NamedNodeMap,NodeList,PaintRequestList,Plugin,PluginArray,SVGLengthList,SVGNumberList,' +
  'SVGPathSegList,SVGPointList,SVGStringList,SVGTransformList,SourceBufferList,StyleSheetList,TextTrackCueList,' +
  'TextTrackList,TouchList').split(',');

for (var i = 0; i < DOMIterables.length; i++) {
  var NAME = DOMIterables[i];
  var Collection = global[NAME];
  var proto = Collection && Collection.prototype;
  if (proto && !proto[TO_STRING_TAG]) hide(proto, TO_STRING_TAG, NAME);
  Iterators[NAME] = Iterators.Array;
}

},{"./_global":108,"./_hide":110,"./_iterators":124,"./_wks":171,"./es6.array.iterator":177}],204:[function(require,module,exports){
(function (global){
"use strict";

/*
 * Short-circuit auto-detection in the buffer module to avoid a Duktape
 * compatibility issue with __proto__.
 */
global.TYPED_ARRAY_SUPPORT = true;
module.exports = require('buffer/');

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"buffer/":57}],205:[function(require,module,exports){
"use strict";

exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m;
  var eLen = nBytes * 8 - mLen - 1;
  var eMax = (1 << eLen) - 1;
  var eBias = eMax >> 1;
  var nBits = -7;
  var i = isLE ? nBytes - 1 : 0;
  var d = isLE ? -1 : 1;
  var s = buffer[offset + i];
  i += d;
  e = s & (1 << -nBits) - 1;
  s >>= -nBits;
  nBits += eLen;

  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & (1 << -nBits) - 1;
  e >>= -nBits;
  nBits += mLen;

  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias;
  } else if (e === eMax) {
    return m ? NaN : (s ? -1 : 1) * Infinity;
  } else {
    m = m + Math.pow(2, mLen);
    e = e - eBias;
  }

  return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
};

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c;
  var eLen = nBytes * 8 - mLen - 1;
  var eMax = (1 << eLen) - 1;
  var eBias = eMax >> 1;
  var rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0;
  var i = isLE ? 0 : nBytes - 1;
  var d = isLE ? 1 : -1;
  var s = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
  value = Math.abs(value);

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0;
    e = eMax;
  } else {
    e = Math.floor(Math.log(value) / Math.LN2);

    if (value * (c = Math.pow(2, -e)) < 1) {
      e--;
      c *= 2;
    }

    if (e + eBias >= 1) {
      value += rt / c;
    } else {
      value += rt * Math.pow(2, 1 - eBias);
    }

    if (value * c >= 2) {
      e++;
      c /= 2;
    }

    if (e + eBias >= eMax) {
      m = 0;
      e = eMax;
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen);
      e = e + eBias;
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
      e = 0;
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = e << mLen | m;
  eLen += mLen;

  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128;
};

},{}],206:[function(require,module,exports){
"use strict";

var _interopRequireDefault = require("@babel/runtime-corejs2/helpers/interopRequireDefault");

var _promise = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/promise"));

var _typeof2 = _interopRequireDefault(require("@babel/runtime-corejs2/helpers/typeof"));

var _setPrototypeOf = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/set-prototype-of"));

var _getPrototypeOf = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/get-prototype-of"));

var _create = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/object/create"));

var _symbol = _interopRequireDefault(require("@babel/runtime-corejs2/core-js/symbol"));

/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var runtime = function (exports) {
  "use strict";

  var Op = Object.prototype;
  var hasOwn = Op.hasOwnProperty;
  var undefined; // More compressible than void 0.

  var $Symbol = typeof _symbol["default"] === "function" ? _symbol["default"] : {};
  var iteratorSymbol = $Symbol.iterator || "@@iterator";
  var asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator";
  var toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag";

  function wrap(innerFn, outerFn, self, tryLocsList) {
    // If outerFn provided and outerFn.prototype is a Generator, then outerFn.prototype instanceof Generator.
    var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator;
    var generator = (0, _create["default"])(protoGenerator.prototype);
    var context = new Context(tryLocsList || []); // The ._invoke method unifies the implementations of the .next,
    // .throw, and .return methods.

    generator._invoke = makeInvokeMethod(innerFn, self, context);
    return generator;
  }

  exports.wrap = wrap; // Try/catch helper to minimize deoptimizations. Returns a completion
  // record like context.tryEntries[i].completion. This interface could
  // have been (and was previously) designed to take a closure to be
  // invoked without arguments, but in all the cases we care about we
  // already have an existing method we want to call, so there's no need
  // to create a new function object. We can even get away with assuming
  // the method takes exactly one argument, since that happens to be true
  // in every case, so we don't have to touch the arguments object. The
  // only additional allocation required is the completion record, which
  // has a stable shape and so hopefully should be cheap to allocate.

  function tryCatch(fn, obj, arg) {
    try {
      return {
        type: "normal",
        arg: fn.call(obj, arg)
      };
    } catch (err) {
      return {
        type: "throw",
        arg: err
      };
    }
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed"; // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.

  var ContinueSentinel = {}; // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.

  function Generator() {}

  function GeneratorFunction() {}

  function GeneratorFunctionPrototype() {} // This is a polyfill for %IteratorPrototype% for environments that
  // don't natively support it.


  var IteratorPrototype = {};

  IteratorPrototype[iteratorSymbol] = function () {
    return this;
  };

  var getProto = _getPrototypeOf["default"];
  var NativeIteratorPrototype = getProto && getProto(getProto(values([])));

  if (NativeIteratorPrototype && NativeIteratorPrototype !== Op && hasOwn.call(NativeIteratorPrototype, iteratorSymbol)) {
    // This environment has a native %IteratorPrototype%; use it instead
    // of the polyfill.
    IteratorPrototype = NativeIteratorPrototype;
  }

  var Gp = GeneratorFunctionPrototype.prototype = Generator.prototype = (0, _create["default"])(IteratorPrototype);
  GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
  GeneratorFunctionPrototype.constructor = GeneratorFunction;
  GeneratorFunctionPrototype[toStringTagSymbol] = GeneratorFunction.displayName = "GeneratorFunction"; // Helper for defining the .next, .throw, and .return methods of the
  // Iterator interface in terms of a single ._invoke method.

  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function (method) {
      prototype[method] = function (arg) {
        return this._invoke(method, arg);
      };
    });
  }

  exports.isGeneratorFunction = function (genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor ? ctor === GeneratorFunction || // For the native GeneratorFunction constructor, the best we can
    // do is to check its .name property.
    (ctor.displayName || ctor.name) === "GeneratorFunction" : false;
  };

  exports.mark = function (genFun) {
    if (_setPrototypeOf["default"]) {
      (0, _setPrototypeOf["default"])(genFun, GeneratorFunctionPrototype);
    } else {
      genFun.__proto__ = GeneratorFunctionPrototype;

      if (!(toStringTagSymbol in genFun)) {
        genFun[toStringTagSymbol] = "GeneratorFunction";
      }
    }

    genFun.prototype = (0, _create["default"])(Gp);
    return genFun;
  }; // Within the body of any async function, `await x` is transformed to
  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test
  // `hasOwn.call(value, "__await")` to determine if the yielded value is
  // meant to be awaited.


  exports.awrap = function (arg) {
    return {
      __await: arg
    };
  };

  function AsyncIterator(generator) {
    function invoke(method, arg, resolve, reject) {
      var record = tryCatch(generator[method], generator, arg);

      if (record.type === "throw") {
        reject(record.arg);
      } else {
        var result = record.arg;
        var value = result.value;

        if (value && (0, _typeof2["default"])(value) === "object" && hasOwn.call(value, "__await")) {
          return _promise["default"].resolve(value.__await).then(function (value) {
            invoke("next", value, resolve, reject);
          }, function (err) {
            invoke("throw", err, resolve, reject);
          });
        }

        return _promise["default"].resolve(value).then(function (unwrapped) {
          // When a yielded Promise is resolved, its final value becomes
          // the .value of the Promise<{value,done}> result for the
          // current iteration.
          result.value = unwrapped;
          resolve(result);
        }, function (error) {
          // If a rejected Promise was yielded, throw the rejection back
          // into the async generator function so it can be handled there.
          return invoke("throw", error, resolve, reject);
        });
      }
    }

    var previousPromise;

    function enqueue(method, arg) {
      function callInvokeWithMethodAndArg() {
        return new _promise["default"](function (resolve, reject) {
          invoke(method, arg, resolve, reject);
        });
      }

      return previousPromise = // If enqueue has been called before, then we want to wait until
      // all previous Promises have been resolved before calling invoke,
      // so that results are always delivered in the correct order. If
      // enqueue has not been called before, then it is important to
      // call invoke immediately, without waiting on a callback to fire,
      // so that the async generator function has the opportunity to do
      // any necessary setup in a predictable way. This predictability
      // is why the Promise constructor synchronously invokes its
      // executor callback, and why async functions synchronously
      // execute code before the first await. Since we implement simple
      // async functions in terms of async generators, it is especially
      // important to get this right, even though it requires care.
      previousPromise ? previousPromise.then(callInvokeWithMethodAndArg, // Avoid propagating failures to Promises returned by later
      // invocations of the iterator.
      callInvokeWithMethodAndArg) : callInvokeWithMethodAndArg();
    } // Define the unified helper method that is used to implement .next,
    // .throw, and .return (see defineIteratorMethods).


    this._invoke = enqueue;
  }

  defineIteratorMethods(AsyncIterator.prototype);

  AsyncIterator.prototype[asyncIteratorSymbol] = function () {
    return this;
  };

  exports.AsyncIterator = AsyncIterator; // Note that simple async functions are implemented on top of
  // AsyncIterator objects; they just return a Promise for the value of
  // the final result produced by the iterator.

  exports.async = function (innerFn, outerFn, self, tryLocsList) {
    var iter = new AsyncIterator(wrap(innerFn, outerFn, self, tryLocsList));
    return exports.isGeneratorFunction(outerFn) ? iter // If outerFn is a generator, return the full iterator.
    : iter.next().then(function (result) {
      return result.done ? result.value : iter.next();
    });
  };

  function makeInvokeMethod(innerFn, self, context) {
    var state = GenStateSuspendedStart;
    return function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        if (method === "throw") {
          throw arg;
        } // Be forgiving, per 25.3.3.3.3 of the spec:
        // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume


        return doneResult();
      }

      context.method = method;
      context.arg = arg;

      while (true) {
        var delegate = context.delegate;

        if (delegate) {
          var delegateResult = maybeInvokeDelegate(delegate, context);

          if (delegateResult) {
            if (delegateResult === ContinueSentinel) continue;
            return delegateResult;
          }
        }

        if (context.method === "next") {
          // Setting context._sent for legacy support of Babel's
          // function.sent implementation.
          context.sent = context._sent = context.arg;
        } else if (context.method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw context.arg;
          }

          context.dispatchException(context.arg);
        } else if (context.method === "return") {
          context.abrupt("return", context.arg);
        }

        state = GenStateExecuting;
        var record = tryCatch(innerFn, self, context);

        if (record.type === "normal") {
          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done ? GenStateCompleted : GenStateSuspendedYield;

          if (record.arg === ContinueSentinel) {
            continue;
          }

          return {
            value: record.arg,
            done: context.done
          };
        } else if (record.type === "throw") {
          state = GenStateCompleted; // Dispatch the exception by looping back around to the
          // context.dispatchException(context.arg) call above.

          context.method = "throw";
          context.arg = record.arg;
        }
      }
    };
  } // Call delegate.iterator[context.method](context.arg) and handle the
  // result, either by returning a { value, done } result from the
  // delegate iterator, or by modifying context.method and context.arg,
  // setting context.delegate to null, and returning the ContinueSentinel.


  function maybeInvokeDelegate(delegate, context) {
    var method = delegate.iterator[context.method];

    if (method === undefined) {
      // A .throw or .return when the delegate iterator has no .throw
      // method always terminates the yield* loop.
      context.delegate = null;

      if (context.method === "throw") {
        // Note: ["return"] must be used for ES3 parsing compatibility.
        if (delegate.iterator["return"]) {
          // If the delegate iterator has a return method, give it a
          // chance to clean up.
          context.method = "return";
          context.arg = undefined;
          maybeInvokeDelegate(delegate, context);

          if (context.method === "throw") {
            // If maybeInvokeDelegate(context) changed context.method from
            // "return" to "throw", let that override the TypeError below.
            return ContinueSentinel;
          }
        }

        context.method = "throw";
        context.arg = new TypeError("The iterator does not provide a 'throw' method");
      }

      return ContinueSentinel;
    }

    var record = tryCatch(method, delegate.iterator, context.arg);

    if (record.type === "throw") {
      context.method = "throw";
      context.arg = record.arg;
      context.delegate = null;
      return ContinueSentinel;
    }

    var info = record.arg;

    if (!info) {
      context.method = "throw";
      context.arg = new TypeError("iterator result is not an object");
      context.delegate = null;
      return ContinueSentinel;
    }

    if (info.done) {
      // Assign the result of the finished delegate to the temporary
      // variable specified by delegate.resultName (see delegateYield).
      context[delegate.resultName] = info.value; // Resume execution at the desired location (see delegateYield).

      context.next = delegate.nextLoc; // If context.method was "throw" but the delegate handled the
      // exception, let the outer generator proceed normally. If
      // context.method was "next", forget context.arg since it has been
      // "consumed" by the delegate iterator. If context.method was
      // "return", allow the original .return call to continue in the
      // outer generator.

      if (context.method !== "return") {
        context.method = "next";
        context.arg = undefined;
      }
    } else {
      // Re-yield the result returned by the delegate method.
      return info;
    } // The delegate iterator is finished, so forget it and continue with
    // the outer generator.


    context.delegate = null;
    return ContinueSentinel;
  } // Define Generator.prototype.{next,throw,return} in terms of the
  // unified ._invoke helper method.


  defineIteratorMethods(Gp);
  Gp[toStringTagSymbol] = "Generator"; // A Generator should always return itself as the iterator object when the
  // @@iterator function is called on it. Some browsers' implementations of the
  // iterator prototype chain incorrectly implement this, causing the Generator
  // object to not be returned from this call. This ensures that doesn't happen.
  // See https://github.com/facebook/regenerator/issues/274 for more details.

  Gp[iteratorSymbol] = function () {
    return this;
  };

  Gp.toString = function () {
    return "[object Generator]";
  };

  function pushTryEntry(locs) {
    var entry = {
      tryLoc: locs[0]
    };

    if (1 in locs) {
      entry.catchLoc = locs[1];
    }

    if (2 in locs) {
      entry.finallyLoc = locs[2];
      entry.afterLoc = locs[3];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryLocsList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{
      tryLoc: "root"
    }];
    tryLocsList.forEach(pushTryEntry, this);
    this.reset(true);
  }

  exports.keys = function (object) {
    var keys = [];

    for (var key in object) {
      keys.push(key);
    }

    keys.reverse(); // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.

    return function next() {
      while (keys.length) {
        var key = keys.pop();

        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      } // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.


      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable) {
      var iteratorMethod = iterable[iteratorSymbol];

      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1,
            next = function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;
          return next;
        };

        return next.next = next;
      }
    } // Return an iterator with no values.


    return {
      next: doneResult
    };
  }

  exports.values = values;

  function doneResult() {
    return {
      value: undefined,
      done: true
    };
  }

  Context.prototype = {
    constructor: Context,
    reset: function reset(skipTempReset) {
      this.prev = 0;
      this.next = 0; // Resetting context._sent for legacy support of Babel's
      // function.sent implementation.

      this.sent = this._sent = undefined;
      this.done = false;
      this.delegate = null;
      this.method = "next";
      this.arg = undefined;
      this.tryEntries.forEach(resetTryEntry);

      if (!skipTempReset) {
        for (var name in this) {
          // Not sure about the optimal order of these conditions:
          if (name.charAt(0) === "t" && hasOwn.call(this, name) && !isNaN(+name.slice(1))) {
            this[name] = undefined;
          }
        }
      }
    },
    stop: function stop() {
      this.done = true;
      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;

      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },
    dispatchException: function dispatchException(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;

      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;

        if (caught) {
          // If the dispatched exception was caught by a catch block,
          // then let that catch block handle the exception normally.
          context.method = "next";
          context.arg = undefined;
        }

        return !!caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }
          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }
          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }
          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },
    abrupt: function abrupt(type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];

        if (entry.tryLoc <= this.prev && hasOwn.call(entry, "finallyLoc") && this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }

      if (finallyEntry && (type === "break" || type === "continue") && finallyEntry.tryLoc <= arg && arg <= finallyEntry.finallyLoc) {
        // Ignore the finally entry if control is not jumping to a
        // location outside the try/catch block.
        finallyEntry = null;
      }

      var record = finallyEntry ? finallyEntry.completion : {};
      record.type = type;
      record.arg = arg;

      if (finallyEntry) {
        this.method = "next";
        this.next = finallyEntry.finallyLoc;
        return ContinueSentinel;
      }

      return this.complete(record);
    },
    complete: function complete(record, afterLoc) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" || record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = this.arg = record.arg;
        this.method = "return";
        this.next = "end";
      } else if (record.type === "normal" && afterLoc) {
        this.next = afterLoc;
      }

      return ContinueSentinel;
    },
    finish: function finish(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];

        if (entry.finallyLoc === finallyLoc) {
          this.complete(entry.completion, entry.afterLoc);
          resetTryEntry(entry);
          return ContinueSentinel;
        }
      }
    },
    "catch": function _catch(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];

        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;

          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry);
          }

          return thrown;
        }
      } // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.


      throw new Error("illegal catch attempt");
    },
    delegateYield: function delegateYield(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      if (this.method === "next") {
        // Deliberately forget the last sent value so that we don't
        // accidentally pass it on to the delegate.
        this.arg = undefined;
      }

      return ContinueSentinel;
    }
  }; // Regardless of whether this script is executing as a CommonJS module
  // or not, return the runtime object so that we can declare the variable
  // regeneratorRuntime in the outer scope, which allows this module to be
  // injected easily by `bin/regenerator --include-runtime script.js`.

  return exports;
}( // If this script is executing as a CommonJS module, use module.exports
// as the regeneratorRuntime namespace. Otherwise create a new empty
// object. Either way, the resulting object will be used to initialize
// the regeneratorRuntime variable at the top of this file.
(typeof module === "undefined" ? "undefined" : (0, _typeof2["default"])(module)) === "object" ? module.exports : {});

try {
  regeneratorRuntime = runtime;
} catch (accidentalStrictMode) {
  // This module should not be running in strict mode, so the above
  // assignment should always work unless something is misconfigured. Just
  // in case runtime.js accidentally runs in strict mode, we can escape
  // strict mode using a global Function call. This could conceivably fail
  // if a Content Security Policy forbids using Function, but in that case
  // the proper solution is to fix the accidental strict mode problem. If
  // you've misconfigured your bundler to force strict mode and applied a
  // CSP to forbid Function, and you're not willing to fix either of those
  // problems, please detail your unique predicament in a GitHub issue.
  Function("r", "regeneratorRuntime = r")(runtime);
}

},{"@babel/runtime-corejs2/core-js/object/create":17,"@babel/runtime-corejs2/core-js/object/get-prototype-of":22,"@babel/runtime-corejs2/core-js/object/set-prototype-of":24,"@babel/runtime-corejs2/core-js/promise":26,"@babel/runtime-corejs2/core-js/symbol":30,"@babel/runtime-corejs2/helpers/interopRequireDefault":44,"@babel/runtime-corejs2/helpers/typeof":54}]},{},[10])
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIuLi9mcmlkYS1qYXZhLWJyaWRnZS9pbmRleC5qcyIsIi4uL2ZyaWRhLWphdmEtYnJpZGdlL2xpYi9hbmRyb2lkLmpzIiwiLi4vZnJpZGEtamF2YS1icmlkZ2UvbGliL2FwaS5qcyIsIi4uL2ZyaWRhLWphdmEtYnJpZGdlL2xpYi9jbGFzcy1mYWN0b3J5LmpzIiwiLi4vZnJpZGEtamF2YS1icmlkZ2UvbGliL2Vudi5qcyIsIi4uL2ZyaWRhLWphdmEtYnJpZGdlL2xpYi9ta2RleC5qcyIsIi4uL2ZyaWRhLWphdmEtYnJpZGdlL2xpYi9yZXN1bHQuanMiLCIuLi9mcmlkYS1qYXZhLWJyaWRnZS9saWIvdm0uanMiLCIuLi9mcmlkYS1qYXZhLWJyaWRnZS9ub2RlX21vZHVsZXMvanNzaGEvc3JjL3NoYTEuanMiLCJhZ2VudC9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvYXJyYXkvZnJvbS5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvYXJyYXkvaXMtYXJyYXkuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL2dldC1pdGVyYXRvci5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvaXMtaXRlcmFibGUuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL251bWJlci9pcy1pbnRlZ2VyLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9vYmplY3QvYXNzaWduLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9vYmplY3QvY3JlYXRlLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9vYmplY3QvZGVmaW5lLXByb3BlcnRpZXMuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL29iamVjdC9kZWZpbmUtcHJvcGVydHkuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL29iamVjdC9nZXQtb3duLXByb3BlcnR5LWRlc2NyaXB0b3IuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL29iamVjdC9nZXQtb3duLXByb3BlcnR5LW5hbWVzLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9vYmplY3QvZ2V0LXByb3RvdHlwZS1vZi5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvb2JqZWN0L2tleXMuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL29iamVjdC9zZXQtcHJvdG90eXBlLW9mLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9wYXJzZS1pbnQuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3Byb21pc2UuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3JlZmxlY3QvY29uc3RydWN0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9yZWZsZWN0L2dldC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvc2V0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9zeW1ib2wuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3N5bWJvbC9mb3IuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3N5bWJvbC9pdGVyYXRvci5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvc3ltYm9sL3NwZWNpZXMuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3N5bWJvbC90by1wcmltaXRpdmUuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL2FycmF5V2l0aEhvbGVzLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9hcnJheVdpdGhvdXRIb2xlcy5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvYXNzZXJ0VGhpc0luaXRpYWxpemVkLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9jbGFzc0NhbGxDaGVjay5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvY29uc3RydWN0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9jcmVhdGVDbGFzcy5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvZ2V0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9nZXRQcm90b3R5cGVPZi5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvaW5oZXJpdHMuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL2ludGVyb3BSZXF1aXJlRGVmYXVsdC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvaXRlcmFibGVUb0FycmF5LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9pdGVyYWJsZVRvQXJyYXlMaW1pdC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvbm9uSXRlcmFibGVSZXN0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9ub25JdGVyYWJsZVNwcmVhZC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvcG9zc2libGVDb25zdHJ1Y3RvclJldHVybi5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvc2V0UHJvdG90eXBlT2YuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL3NsaWNlZFRvQXJyYXkuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL3N1cGVyUHJvcEJhc2UuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL3RvQ29uc3VtYWJsZUFycmF5LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy90eXBlb2YuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9yZWdlbmVyYXRvci9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9iYXNlNjQtanMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvYnVmZmVyL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9hcnJheS9mcm9tLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9hcnJheS9pcy1hcnJheS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vZ2V0LWl0ZXJhdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9pcy1pdGVyYWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vbnVtYmVyL2lzLWludGVnZXIuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL29iamVjdC9hc3NpZ24uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL29iamVjdC9jcmVhdGUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL29iamVjdC9kZWZpbmUtcHJvcGVydGllcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vb2JqZWN0L2RlZmluZS1wcm9wZXJ0eS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vb2JqZWN0L2dldC1vd24tcHJvcGVydHktZGVzY3JpcHRvci5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vb2JqZWN0L2dldC1vd24tcHJvcGVydHktbmFtZXMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL29iamVjdC9nZXQtcHJvdG90eXBlLW9mLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9vYmplY3Qva2V5cy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vb2JqZWN0L3NldC1wcm90b3R5cGUtb2YuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL3BhcnNlLWludC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vcHJvbWlzZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vcmVmbGVjdC9jb25zdHJ1Y3QuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL3JlZmxlY3QvZ2V0LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9zZXQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL3N5bWJvbC9mb3IuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL3N5bWJvbC9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vc3ltYm9sL2l0ZXJhdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9zeW1ib2wvc3BlY2llcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vc3ltYm9sL3RvLXByaW1pdGl2ZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYS1mdW5jdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYWRkLXRvLXVuc2NvcGFibGVzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19hbi1pbnN0YW5jZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYW4tb2JqZWN0LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19hcnJheS1mcm9tLWl0ZXJhYmxlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19hcnJheS1pbmNsdWRlcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYXJyYXktbWV0aG9kcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYXJyYXktc3BlY2llcy1jb25zdHJ1Y3Rvci5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYXJyYXktc3BlY2llcy1jcmVhdGUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2JpbmQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2NsYXNzb2YuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2NvZi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fY29sbGVjdGlvbi1zdHJvbmcuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2NvbGxlY3Rpb24tdG8tanNvbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fY29sbGVjdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fY29yZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fY3JlYXRlLXByb3BlcnR5LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19jdHguanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2RlZmluZWQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2Rlc2NyaXB0b3JzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19kb20tY3JlYXRlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19lbnVtLWJ1Zy1rZXlzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19lbnVtLWtleXMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2V4cG9ydC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fZmFpbHMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2Zvci1vZi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fZ2xvYmFsLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19oYXMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2hpZGUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2h0bWwuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2llOC1kb20tZGVmaW5lLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pbnZva2UuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2lvYmplY3QuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2lzLWFycmF5LWl0ZXIuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2lzLWFycmF5LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pcy1pbnRlZ2VyLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pcy1vYmplY3QuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2l0ZXItY2FsbC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9faXRlci1jcmVhdGUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2l0ZXItZGVmaW5lLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pdGVyLWRldGVjdC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9faXRlci1zdGVwLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pdGVyYXRvcnMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2xpYnJhcnkuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX21ldGEuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX21pY3JvdGFzay5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fbmV3LXByb21pc2UtY2FwYWJpbGl0eS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWFzc2lnbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWNyZWF0ZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWRwLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19vYmplY3QtZHBzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19vYmplY3QtZ29wZC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWdvcG4tZXh0LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19vYmplY3QtZ29wbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWdvcHMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX29iamVjdC1ncG8uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX29iamVjdC1rZXlzLWludGVybmFsLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19vYmplY3Qta2V5cy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LXBpZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LXNhcC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fcGFyc2UtaW50LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19wZXJmb3JtLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19wcm9taXNlLXJlc29sdmUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3Byb3BlcnR5LWRlc2MuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3JlZGVmaW5lLWFsbC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fcmVkZWZpbmUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3NldC1jb2xsZWN0aW9uLWZyb20uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3NldC1jb2xsZWN0aW9uLW9mLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zZXQtcHJvdG8uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3NldC1zcGVjaWVzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zZXQtdG8tc3RyaW5nLXRhZy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fc2hhcmVkLWtleS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fc2hhcmVkLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zcGVjaWVzLWNvbnN0cnVjdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zdHJpbmctYXQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3N0cmluZy10cmltLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zdHJpbmctd3MuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3Rhc2suanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3RvLWFic29sdXRlLWluZGV4LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL190by1pbnRlZ2VyLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL190by1pb2JqZWN0LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL190by1sZW5ndGguanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3RvLW9iamVjdC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fdG8tcHJpbWl0aXZlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL191aWQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3VzZXItYWdlbnQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3ZhbGlkYXRlLWNvbGxlY3Rpb24uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3drcy1kZWZpbmUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3drcy1leHQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3drcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9jb3JlLmdldC1pdGVyYXRvci1tZXRob2QuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvY29yZS5nZXQtaXRlcmF0b3IuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvY29yZS5pcy1pdGVyYWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYuYXJyYXkuZnJvbS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYuYXJyYXkuaXMtYXJyYXkuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM2LmFycmF5Lml0ZXJhdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5udW1iZXIuaXMtaW50ZWdlci5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LmFzc2lnbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LmNyZWF0ZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LmRlZmluZS1wcm9wZXJ0aWVzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5vYmplY3QuZGVmaW5lLXByb3BlcnR5LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5vYmplY3QuZ2V0LW93bi1wcm9wZXJ0eS1kZXNjcmlwdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5vYmplY3QuZ2V0LW93bi1wcm9wZXJ0eS1uYW1lcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LmdldC1wcm90b3R5cGUtb2YuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM2Lm9iamVjdC5rZXlzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5vYmplY3Quc2V0LXByb3RvdHlwZS1vZi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LnRvLXN0cmluZy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYucGFyc2UtaW50LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5wcm9taXNlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5yZWZsZWN0LmNvbnN0cnVjdC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYucmVmbGVjdC5nZXQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM2LnNldC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYuc3RyaW5nLml0ZXJhdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5zeW1ib2wuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM3LnByb21pc2UuZmluYWxseS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczcucHJvbWlzZS50cnkuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM3LnNldC5mcm9tLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNy5zZXQub2YuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM3LnNldC50by1qc29uLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNy5zeW1ib2wuYXN5bmMtaXRlcmF0b3IuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM3LnN5bWJvbC5vYnNlcnZhYmxlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL3dlYi5kb20uaXRlcmFibGUuanMiLCJub2RlX21vZHVsZXMvZnJpZGEtYnVmZmVyL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL2llZWU3NTQvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcmVnZW5lcmF0b3ItcnVudGltZS9ydW50aW1lLmpzIl0sIm5hbWVz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QUNBOztBQ05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7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QUNBOztBQ0ZBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7O0FDRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1JBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTs7QUNEQTtBQUNBOztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTs7QUNEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNUQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0RBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDZkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1JBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ05BO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDYkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdEJBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7O0FDREE7QUFDQTs7QUNEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDYkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNQQTtBQUNBOztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDYkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7O0FDREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNWQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNUQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNSQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7O0FDREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUJBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7O0FDREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNSQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNUQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNUQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOVJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNkQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNB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RyxLQUFLLFVBQUwsQ0FBZ0IsQ0FBaEIsQ0FBWjs7QUFDQSxZQUFJLEtBQUssQ0FBQyxVQUFOLEtBQXFCLFVBQXpCLEVBQXFDO0FBQ25DLGVBQUssUUFBTCxDQUFjLEtBQUssQ0FBQyxVQUFwQixFQUFnQyxLQUFLLENBQUMsUUFBdEM7QUFDQSxVQUFBLGFBQWEsQ0FBQyxLQUFELENBQWI7QUFDQSxpQkFBTyxnQkFBUDtBQUNEO0FBQ0Y7QUFDRixLQW5LaUI7QUFxS2xCLGFBQVMsZ0JBQVMsTUFBVCxFQUFpQjtBQUN4QixXQUFLLElBQUksQ0FBQyxHQUFHLEtBQUssVUFBTCxDQUFnQixNQUFoQixHQUF5QixDQUF0QyxFQUF5QyxDQUFDLElBQUksQ0FBOUMsRUFBaUQsRUFBRSxDQUFuRCxFQUFzRDtBQUNwRCxZQUFJLEtBQUssR0FBRyxLQUFLLFVBQUwsQ0FBZ0IsQ0FBaEIsQ0FBWjs7QUFDQSxZQUFJLEtBQUssQ0FBQyxNQUFOLEtBQWlCLE1BQXJCLEVBQTZCO0FBQzNCLGNBQUksTUFBTSxHQUFHLEtBQUssQ0FBQyxVQUFuQjs7QUFDQSxjQUFJLE1BQU0sQ0FBQyxJQUFQLEtBQWdCLE9BQXBCLEVBQTZCO0FBQzNCLGdCQUFJLE1BQU0sR0FBRyxNQUFNLENBQUMsR0FBcEI7QUFDQSxZQUFBLGFBQWEsQ0FBQyxLQUFELENBQWI7QUFDRDs7QUFDRCxpQkFBTyxNQUFQO0FBQ0Q7QUFDRixPQVh1QixDQWF4QjtBQUNBOzs7QUFDQSxZQUFNLElBQUksS0FBSixDQUFVLHVCQUFWLENBQU47QUFDRCxLQXJMaUI7QUF1TGxCLElBQUEsYUFBYSxFQUFFLHVCQUFTLFFBQVQsRUFBbUIsVUFBbkIsRUFBK0IsT0FBL0IsRUFBd0M7QUFDckQsV0FBSyxRQUFMLEdBQWdCO0FBQ2QsUUFBQSxRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQUQsQ0FERjtBQUVkLFFBQUEsVUFBVSxFQUFFLFVBRkU7QUFHZCxRQUFBLE9BQU8sRUFBRTtBQUhLLE9BQWhCOztBQU1BLFVBQUksS0FBSyxNQUFMLEtBQWdCLE1BQXBCLEVBQTRCO0FBQzFCO0FBQ0E7QUFDQSxhQUFLLEdBQUwsR0FBVyxTQUFYO0FBQ0Q7O0FBRUQsYUFBTyxnQkFBUDtBQUNEO0FBck1pQixHQUFwQixDQTNlZ0MsQ0FtckJoQztBQUNBO0FBQ0E7QUFDQTs7QUFDQSxTQUFPLE9BQVA7QUFFRCxDQXpyQmMsRUEwckJiO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsUUFBTyxNQUFQLDBEQUFPLE1BQVAsT0FBa0IsUUFBbEIsR0FBNkIsTUFBTSxDQUFDLE9BQXBDLEdBQThDLEVBOXJCakMsQ0FBZjs7QUFpc0JBLElBQUk7QUFDRixFQUFBLGtCQUFrQixHQUFHLE9BQXJCO0FBQ0QsQ0FGRCxDQUVFLE9BQU8sb0JBQVAsRUFBNkI7QUFDN0I7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsRUFBQSxRQUFRLENBQUMsR0FBRCxFQUFNLHdCQUFOLENBQVIsQ0FBd0MsT0FBeEM7QUFDRCIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIn0=
