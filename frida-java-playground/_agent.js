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
var Default_ClassLoader_Hash = "DEFAULTCLASSLOADERHASH";

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
    var useLoaderCache = options.useLoaderCache == "enable";
    var C = null;

    if (useLoaderCache & loader !== null) {
      C = allowCached ? getUsedClass(className, loader.hashCode()) : undefined;
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

  function getUsedClass(className, classLoader_Hash) {
    var kclass;
    classLoader_Hash = classLoader_Hash === undefined ? Default_ClassLoader_Hash : classLoader_Hash;

    while ((kclass = classes_loaders[className] === undefined ? undefined : classes_loaders[className][classLoader_Hash]) === PENDING_USE) {
      Thread.sleep(0.05);
    }

    if (kclass === undefined) {
      classes_loaders[className] = {
        classLoader_Hash: PENDING_USE
      };
      classes[className] = PENDING_USE;
    } // while ((kclass = classes[className]) === PENDING_USE) {
    //   Thread.sleep(0.05);
    // }
    // if (kclass === undefined) {
    //   classes[className] = PENDING_USE;
    // }


    return kclass;
  }

  function setUsedClass(className, kclass, classLoader_Hash) {
    classLoader_Hash = classLoader_Hash === undefined ? Default_ClassLoader_Hash : classLoader_Hash;

    if (kclass !== undefined) {
      classes[className] = kclass;

      if (classes_loaders[className] === undefined) {
        classes_loaders[className] = {
          classLoader_Hash: kclass
        };
      } else {
        classes_loaders[className][classLoader_Hash] = kclass;
      }
    } else {
      delete classes[className];

      if (classes_loaders[className] != undefined) {
        delete classes_loaders[className][classLoader_Hash];
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

var Java = require('frida-java-bridge');

var linebreak = "\n";

function miniLog(methodname, arg_type, arg_dump, ret_type, retvar) {
  console.log('[+]' + methodname + "(" + arg_type + ")");
  console.log("Return: (" + ret_type + ")" + retvar);
  console.log(arg_dump);
}

Java.perform(function () {
  console.log("In da house..hook_tpl.js");
  var DexClassLoader = Java.use("dalvik.system.DexClassLoader");

  DexClassLoader.loadClass.overload('java.lang.String').implementation = function () {
    var ret_class = this.loadClass.apply(this, arguments);

    if (String(this).includes("/data/local/tmp/dyhello.dex")) {
      var active_classloader = ret_class.getClassLoader();
      var orig_cl = Java.classFactory.loader;
      Java.classFactory.loader = active_classloader;
      var c_DyHello_hook = Java.use("com.hao.hello.DyHello", {
        useLoaderCache: 'enable'
      });
      console.log(c_DyHello_hook.$classWrapper.__name__);
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

          miniLog("com.hao.hello.DyHello.hello", String(arg_type), String(arg_dump), String(ret_type), String(retval));
          return retval;
        };
      }

      Java.classFactory.loader = orig_cl;
    }

    return ret_class;
  };
});

},{"@babel/runtime-corejs2/helpers/interopRequireDefault":44,"@babel/runtime-corejs2/helpers/typeof":54,"frida-java-bridge":1}],11:[function(require,module,exports){
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIuLi9mcmlkYS1qYXZhLWJyaWRnZS9pbmRleC5qcyIsIi4uL2ZyaWRhLWphdmEtYnJpZGdlL2xpYi9hbmRyb2lkLmpzIiwiLi4vZnJpZGEtamF2YS1icmlkZ2UvbGliL2FwaS5qcyIsIi4uL2ZyaWRhLWphdmEtYnJpZGdlL2xpYi9jbGFzcy1mYWN0b3J5LmpzIiwiLi4vZnJpZGEtamF2YS1icmlkZ2UvbGliL2Vudi5qcyIsIi4uL2ZyaWRhLWphdmEtYnJpZGdlL2xpYi9ta2RleC5qcyIsIi4uL2ZyaWRhLWphdmEtYnJpZGdlL2xpYi9yZXN1bHQuanMiLCIuLi9mcmlkYS1qYXZhLWJyaWRnZS9saWIvdm0uanMiLCIuLi9mcmlkYS1qYXZhLWJyaWRnZS9ub2RlX21vZHVsZXMvanNzaGEvc3JjL3NoYTEuanMiLCJhZ2VudC9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvYXJyYXkvZnJvbS5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvYXJyYXkvaXMtYXJyYXkuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL2dldC1pdGVyYXRvci5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvaXMtaXRlcmFibGUuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL251bWJlci9pcy1pbnRlZ2VyLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9vYmplY3QvYXNzaWduLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9vYmplY3QvY3JlYXRlLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9vYmplY3QvZGVmaW5lLXByb3BlcnRpZXMuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL29iamVjdC9kZWZpbmUtcHJvcGVydHkuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL29iamVjdC9nZXQtb3duLXByb3BlcnR5LWRlc2NyaXB0b3IuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL29iamVjdC9nZXQtb3duLXByb3BlcnR5LW5hbWVzLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9vYmplY3QvZ2V0LXByb3RvdHlwZS1vZi5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvb2JqZWN0L2tleXMuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL29iamVjdC9zZXQtcHJvdG90eXBlLW9mLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9wYXJzZS1pbnQuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3Byb21pc2UuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3JlZmxlY3QvY29uc3RydWN0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9yZWZsZWN0L2dldC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvc2V0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvY29yZS1qcy9zeW1ib2wuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3N5bWJvbC9mb3IuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3N5bWJvbC9pdGVyYXRvci5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2NvcmUtanMvc3ltYm9sL3NwZWNpZXMuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9jb3JlLWpzL3N5bWJvbC90by1wcmltaXRpdmUuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL2FycmF5V2l0aEhvbGVzLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9hcnJheVdpdGhvdXRIb2xlcy5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvYXNzZXJ0VGhpc0luaXRpYWxpemVkLmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9jbGFzc0NhbGxDaGVjay5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvY29uc3RydWN0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9jcmVhdGVDbGFzcy5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvZ2V0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9nZXRQcm90b3R5cGVPZi5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvaW5oZXJpdHMuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL2ludGVyb3BSZXF1aXJlRGVmYXVsdC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvaXRlcmFibGVUb0FycmF5LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9pdGVyYWJsZVRvQXJyYXlMaW1pdC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvbm9uSXRlcmFibGVSZXN0LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy9ub25JdGVyYWJsZVNwcmVhZC5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvcG9zc2libGVDb25zdHJ1Y3RvclJldHVybi5qcyIsIm5vZGVfbW9kdWxlcy9AYmFiZWwvcnVudGltZS1jb3JlanMyL2hlbHBlcnMvc2V0UHJvdG90eXBlT2YuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL3NsaWNlZFRvQXJyYXkuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL3N1cGVyUHJvcEJhc2UuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9oZWxwZXJzL3RvQ29uc3VtYWJsZUFycmF5LmpzIiwibm9kZV9tb2R1bGVzL0BiYWJlbC9ydW50aW1lLWNvcmVqczIvaGVscGVycy90eXBlb2YuanMiLCJub2RlX21vZHVsZXMvQGJhYmVsL3J1bnRpbWUtY29yZWpzMi9yZWdlbmVyYXRvci9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9iYXNlNjQtanMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvYnVmZmVyL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9hcnJheS9mcm9tLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9hcnJheS9pcy1hcnJheS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vZ2V0LWl0ZXJhdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9pcy1pdGVyYWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vbnVtYmVyL2lzLWludGVnZXIuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL29iamVjdC9hc3NpZ24uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL29iamVjdC9jcmVhdGUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL29iamVjdC9kZWZpbmUtcHJvcGVydGllcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vb2JqZWN0L2RlZmluZS1wcm9wZXJ0eS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vb2JqZWN0L2dldC1vd24tcHJvcGVydHktZGVzY3JpcHRvci5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vb2JqZWN0L2dldC1vd24tcHJvcGVydHktbmFtZXMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL29iamVjdC9nZXQtcHJvdG90eXBlLW9mLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9vYmplY3Qva2V5cy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vb2JqZWN0L3NldC1wcm90b3R5cGUtb2YuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL3BhcnNlLWludC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vcHJvbWlzZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vcmVmbGVjdC9jb25zdHJ1Y3QuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL3JlZmxlY3QvZ2V0LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9zZXQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL3N5bWJvbC9mb3IuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L2ZuL3N5bWJvbC9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vc3ltYm9sL2l0ZXJhdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9mbi9zeW1ib2wvc3BlY2llcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvZm4vc3ltYm9sL3RvLXByaW1pdGl2ZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYS1mdW5jdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYWRkLXRvLXVuc2NvcGFibGVzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19hbi1pbnN0YW5jZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYW4tb2JqZWN0LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19hcnJheS1mcm9tLWl0ZXJhYmxlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19hcnJheS1pbmNsdWRlcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYXJyYXktbWV0aG9kcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYXJyYXktc3BlY2llcy1jb25zdHJ1Y3Rvci5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fYXJyYXktc3BlY2llcy1jcmVhdGUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2JpbmQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2NsYXNzb2YuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2NvZi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fY29sbGVjdGlvbi1zdHJvbmcuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2NvbGxlY3Rpb24tdG8tanNvbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fY29sbGVjdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fY29yZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fY3JlYXRlLXByb3BlcnR5LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19jdHguanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2RlZmluZWQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2Rlc2NyaXB0b3JzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19kb20tY3JlYXRlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19lbnVtLWJ1Zy1rZXlzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19lbnVtLWtleXMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2V4cG9ydC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fZmFpbHMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2Zvci1vZi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fZ2xvYmFsLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19oYXMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2hpZGUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2h0bWwuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2llOC1kb20tZGVmaW5lLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pbnZva2UuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2lvYmplY3QuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2lzLWFycmF5LWl0ZXIuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2lzLWFycmF5LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pcy1pbnRlZ2VyLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pcy1vYmplY3QuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2l0ZXItY2FsbC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9faXRlci1jcmVhdGUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2l0ZXItZGVmaW5lLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pdGVyLWRldGVjdC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9faXRlci1zdGVwLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19pdGVyYXRvcnMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX2xpYnJhcnkuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX21ldGEuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX21pY3JvdGFzay5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fbmV3LXByb21pc2UtY2FwYWJpbGl0eS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWFzc2lnbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWNyZWF0ZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWRwLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19vYmplY3QtZHBzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19vYmplY3QtZ29wZC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWdvcG4tZXh0LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19vYmplY3QtZ29wbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LWdvcHMuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX29iamVjdC1ncG8uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX29iamVjdC1rZXlzLWludGVybmFsLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19vYmplY3Qta2V5cy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LXBpZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fb2JqZWN0LXNhcC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fcGFyc2UtaW50LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19wZXJmb3JtLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19wcm9taXNlLXJlc29sdmUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3Byb3BlcnR5LWRlc2MuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3JlZGVmaW5lLWFsbC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fcmVkZWZpbmUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3NldC1jb2xsZWN0aW9uLWZyb20uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3NldC1jb2xsZWN0aW9uLW9mLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zZXQtcHJvdG8uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3NldC1zcGVjaWVzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zZXQtdG8tc3RyaW5nLXRhZy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fc2hhcmVkLWtleS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fc2hhcmVkLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zcGVjaWVzLWNvbnN0cnVjdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zdHJpbmctYXQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3N0cmluZy10cmltLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL19zdHJpbmctd3MuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3Rhc2suanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3RvLWFic29sdXRlLWluZGV4LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL190by1pbnRlZ2VyLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL190by1pb2JqZWN0LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL190by1sZW5ndGguanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3RvLW9iamVjdC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9fdG8tcHJpbWl0aXZlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL191aWQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3VzZXItYWdlbnQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3ZhbGlkYXRlLWNvbGxlY3Rpb24uanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3drcy1kZWZpbmUuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3drcy1leHQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvX3drcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9jb3JlLmdldC1pdGVyYXRvci1tZXRob2QuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvY29yZS5nZXQtaXRlcmF0b3IuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvY29yZS5pcy1pdGVyYWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYuYXJyYXkuZnJvbS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYuYXJyYXkuaXMtYXJyYXkuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM2LmFycmF5Lml0ZXJhdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5udW1iZXIuaXMtaW50ZWdlci5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LmFzc2lnbi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LmNyZWF0ZS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LmRlZmluZS1wcm9wZXJ0aWVzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5vYmplY3QuZGVmaW5lLXByb3BlcnR5LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5vYmplY3QuZ2V0LW93bi1wcm9wZXJ0eS1kZXNjcmlwdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5vYmplY3QuZ2V0LW93bi1wcm9wZXJ0eS1uYW1lcy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LmdldC1wcm90b3R5cGUtb2YuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM2Lm9iamVjdC5rZXlzLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5vYmplY3Quc2V0LXByb3RvdHlwZS1vZi5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYub2JqZWN0LnRvLXN0cmluZy5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYucGFyc2UtaW50LmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5wcm9taXNlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5yZWZsZWN0LmNvbnN0cnVjdC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYucmVmbGVjdC5nZXQuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM2LnNldC5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczYuc3RyaW5nLml0ZXJhdG9yLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNi5zeW1ib2wuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM3LnByb21pc2UuZmluYWxseS5qcyIsIm5vZGVfbW9kdWxlcy9jb3JlLWpzL2xpYnJhcnkvbW9kdWxlcy9lczcucHJvbWlzZS50cnkuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM3LnNldC5mcm9tLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNy5zZXQub2YuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM3LnNldC50by1qc29uLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL2VzNy5zeW1ib2wuYXN5bmMtaXRlcmF0b3IuanMiLCJub2RlX21vZHVsZXMvY29yZS1qcy9saWJyYXJ5L21vZHVsZXMvZXM3LnN5bWJvbC5vYnNlcnZhYmxlLmpzIiwibm9kZV9tb2R1bGVzL2NvcmUtanMvbGlicmFyeS9tb2R1bGVzL3dlYi5kb20uaXRlcmFibGUuanMiLCJub2RlX21vZHVsZXMvZnJpZGEtYnVmZmVyL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL2llZWU3NTQvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcmVnZW5lcmF0b3ItcnVudGltZS9ydW50aW1lLmpzIl0sIm5hbWVz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QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNOQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNaQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDM0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25CQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7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Q0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7O0FDRkE7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7O0FDRkE7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBOztBQ0RBO0FBQ0E7O0FDREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBOztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzREE7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNSQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNmQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOURBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUkE7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNSQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTkE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNiQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0QkE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTs7QUNEQTtBQUNBOztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNiQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25CQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7O0FDREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNiQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDakJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTs7QUNEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTs7QUNEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNaQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDZEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5QkE7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNaQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTs7QUNEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDUEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNWQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNUQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBOztBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5UkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9DQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdFBBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDWkE7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7O0FDREE7QUFDQTs7QUNEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFD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
