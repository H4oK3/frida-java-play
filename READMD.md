## Problem to solve:

`invokeDex`: Every time user clicks the button; it loads dynamic dex and load a class from it.

`invokeDexOnce`: Classloader get initiated only once.

~~~JAVA
public void invokeDex(View view) {
    DexClassLoader dcl = new DexClassLoader("/data/local/tmp/dyhello.dex",
            getExternalCacheDir().getAbsolutePath(), null, getClassLoader());
    try {
        Class clazz = dcl.loadClass("com.hao.hello.DyHello");
        Object ins = clazz.newInstance();
        Method method = clazz.getMethod("hello");
        String s = (String) method.invoke(ins);
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    } catch (ClassNotFoundException e) {
        e.printStackTrace();
    } catch (IllegalAccessException e) {
        e.printStackTrace();
    } catch (InstantiationException e) {
        e.printStackTrace();
    } catch (NoSuchMethodException e) {
        e.printStackTrace();
    } catch (InvocationTargetException e) {
        e.printStackTrace();
    }
}

public void invokeDexOnce(View view) {
    if (dcl_static == null) {
        dcl_static = new DexClassLoader("/data/local/tmp/dyhello.dex",
                getExternalCacheDir().getAbsolutePath(), null, getClassLoader());
    }
    try {
        Class clazz = dcl_static.loadClass("com.hao.hello.DyHello");
        Object ins = clazz.newInstance();
        Method method = clazz.getMethod("hello");
        String s = (String) method.invoke(ins);
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show();
    } catch (ClassNotFoundException e) {
        e.printStackTrace();
    } catch (IllegalAccessException e) {
        e.printStackTrace();
    } catch (InstantiationException e) {
        e.printStackTrace();
    } catch (NoSuchMethodException e) {
        e.printStackTrace();
    } catch (InvocationTargetException e) {
        e.printStackTrace();
    }
}
~~~


## Test case:
Install the overloads.apk 
Put `dyhello.dex` file under /data/local/tmp

## Experimental patch:
https://github.com/H4oK3/frida-java-bridge/commit/47b8cae7c33b05692fd1f2300ea7308068740233

## Existing problem:
- invokeDexOnce -> invokeDexOnce -> invokeDexOnce: Works as designed
- invokeDexOnce -> invokeDex -> invokeDexOnce : the 2nd invokeDexOnce has more than one patches 
    ~~~
    [+]com.hao.hello.DyHello.hello()
    Return: (java.lang.String)Hello from DyHello! 10:58:22.193

    [+]com.hao.hello.DyHello.hello()
    Return: (java.lang.String)Hello from DyHello! 10:58:22.193
    ~~~
    + It applies patches over patched classes?

- invokeDexOnce -> detach/%reload -> invokeDexOnce : Crashes the process
    + Clean up failed?