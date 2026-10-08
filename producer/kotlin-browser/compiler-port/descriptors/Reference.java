import java.lang.reflect.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;

/** Reads real compiled contracts in an isolated class loader; no descriptor implementations. */
public final class Reference {
  static String signature(Method method) {
    return method.getName()+"("+String.join(",",Arrays.stream(method.getParameterTypes()).map(Class::getName).toList())+"):"+method.getReturnType().getName();
  }
  public static void main(String[] args)throws Exception {
    URL[] urls=Arrays.stream(args[0].split(java.io.File.pathSeparator)).map(name->{try{return Path.of(name).toUri().toURL();}catch(Exception failure){throw new IllegalArgumentException(failure);}}).toArray(URL[]::new);
    try(URLClassLoader loader=new URLClassLoader(urls,ClassLoader.getPlatformClassLoader())) {
      for(int i=1;i<args.length;i++) {
        Class<?> type=Class.forName(args[i],false,loader);
        List<String> methods=Arrays.stream(type.getDeclaredMethods()).filter(method->!method.isBridge()&&!method.isSynthetic()).map(Reference::signature).sorted().toList();
        System.out.println(type.getName()+"\t"+(type.isInterface()?"interface":type.isEnum()?"enum":"other")+"\t"+type.getTypeParameters().length+"\t"+String.join(";",methods));
        if(type.isEnum()) for(Object value:type.getEnumConstants()) System.out.println(type.getName()+"."+value+".isReal="+type.getMethod("isReal").invoke(value));
      }
    }
  }
}
