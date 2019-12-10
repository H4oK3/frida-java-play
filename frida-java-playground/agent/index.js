const Java = require('frida-java-bridge');
var linebreak = "\n"

function miniLog(methodname, arg_type, arg_dump, ret_type, retvar) {
    console.log('[+]' + methodname + "(" + arg_type + ")")
    console.log("Return: (" + ret_type + ")" + retvar)
    console.log(arg_dump)
}

Java.perform(() => {
    console.log("In da house..hook_tpl.js")

    var DexClassLoader = Java.use("dalvik.system.DexClassLoader");
    DexClassLoader.loadClass.overload('java.lang.String').implementation = function() {
        var ret_class = this.loadClass.apply(this, arguments);
        if (String(this).includes("/data/local/tmp/dyhello.dex")) {
            var active_classloader = ret_class.getClassLoader();
            var orig_cl = Java.classFactory.loader;
            Java.classFactory.loader = active_classloader;
            var c_DyHello_hook = Java.use("com.hao.hello.DyHello", {useLoaderCache : 'enable'});
            console.log(c_DyHello_hook.$classWrapper.__name__)
            var overloadz_DyHello_hook = eval("c_DyHello_hook.hello.overloads");
            var ovl_count_DyHello_hook = overloadz_DyHello_hook.length;
            var c_DyHello_hook_hello_hook = null

            for (var i = 0; i < ovl_count_DyHello_hook; i++) {
                var c_DyHello_hook_hello_hook = eval('c_DyHello_hook.hello.overloads[i]')
                c_DyHello_hook_hello_hook.implementation = function() {
                    var sendback = ''
                    var hook_signature = '-hoo00ook-'

                    var arg_dump = ''
                    var arg_type = ''
                    var ret_type = String(c_DyHello_hook_hello_hook.returnType['className'])
                    var retval = null
                    for (var index = 0; index < arguments.length; index++) {
                        arg_type += ('argType' + index.toString() + " : " + String(typeof(arguments[index])) + ' ')
                        arg_dump += ("arg" + index.toString() + ": " + String(arguments[index]) + linebreak)
                    }

                    try {
                        retval = eval('this.hello.apply(this, arguments)')
                    } catch (err) {
                        retval = null
                        console.log("Exception - cannot compute retval.." + String(err))
                    }

                    miniLog("com.hao.hello.DyHello.hello", String(arg_type), String(arg_dump), String(ret_type), String(retval))
                    return retval;
                }
            }

            Java.classFactory.loader = orig_cl
        }
        return ret_class
    };
});