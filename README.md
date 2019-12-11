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

## Remaining problems:
`.hashCode()` is in use; chances that classloaders with same name and same hash are low;
However if a custom classloaer with custom `.hashCode()` func is in use; then it might fail;
I was not able to find a better solution to generate unique class identifier yet