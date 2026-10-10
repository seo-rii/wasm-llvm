import java.lang.reflect.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;

/** Observes selected original APIs and their genuine default factory behavior. */
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
        System.out.println(type.getName()+"\t"+(type.isInterface()?"interface":type.isEnum()?"enum":"class")+"\t"+type.getTypeParameters().length+"\t"+String.join(";",methods));
        if(type.isEnum())System.out.println(type.getName()+".values="+String.join(",",Arrays.stream(type.getEnumConstants()).map(Object::toString).toList()));
      }
      Class<?> builtinsClass=loader.loadClass("org.jetbrains.kotlin.builtins.DefaultBuiltIns");Object builtins=builtinsClass.getMethod("getInstance").invoke(null);
      Class<?> descriptor=loader.loadClass("org.jetbrains.kotlin.descriptors.ClassDescriptor");Object any=builtinsClass.getMethod("getAny").invoke(builtins);
      Class<?> mapper=loader.loadClass("org.jetbrains.kotlin.builtins.PlatformToKotlinClassMapper$Default");Object defaultMapper=mapper.getConstructor().newInstance();
      Collection<?> result=(Collection<?>)mapper.getMethod("mapPlatformClass",descriptor).invoke(defaultMapper,any);
      System.out.println("mapper.empty="+result.isEmpty()+",iterator="+result.iterator().hasNext()+",equalsEmpty="+result.equals(List.of()));
      Class<?> checker=loader.loadClass("org.jetbrains.kotlin.types.checker.KotlinTypeChecker");Object defaultChecker=checker.getField("DEFAULT").get(null);
      Class<?> newChecker=loader.loadClass("org.jetbrains.kotlin.types.checker.NewKotlinTypeChecker");Object companion=newChecker.getField("Companion").get(null);
      System.out.println("checker.default.sameFactory="+(defaultChecker==companion.getClass().getMethod("getDefault").invoke(companion)));
      Class<?> kotlinType=loader.loadClass("org.jetbrains.kotlin.types.KotlinType");Object intType=builtinsClass.getMethod("getIntType").invoke(builtins),longType=builtinsClass.getMethod("getLongType").invoke(builtins),anyType=builtinsClass.getMethod("getAnyType").invoke(builtins);
      System.out.println("checker.intEqualsInt="+checker.getMethod("equalTypes",kotlinType,kotlinType).invoke(defaultChecker,intType,intType));
      System.out.println("checker.intEqualsLong="+checker.getMethod("equalTypes",kotlinType,kotlinType).invoke(defaultChecker,intType,longType));
      System.out.println("checker.intSubtypeAny="+checker.getMethod("isSubtypeOf",kotlinType,kotlinType).invoke(defaultChecker,intType,anyType));
      System.out.println("checker.anySubtypeInt="+checker.getMethod("isSubtypeOf",kotlinType,kotlinType).invoke(defaultChecker,anyType,intType));
      Class<?> defaultAnnotation=loader.loadClass("org.jetbrains.kotlin.container.DefaultImplementation");
      @SuppressWarnings("unchecked") Class<? extends java.lang.annotation.Annotation> annotationType=(Class<? extends java.lang.annotation.Annotation>)defaultAnnotation;
      Object annotation=loader.loadClass("org.jetbrains.kotlin.builtins.PlatformToKotlinClassMapper").getAnnotation(annotationType);
      System.out.println("mapper.annotation.impl="+((Class<?>)defaultAnnotation.getMethod("impl").invoke(annotation)).getName());
    }
  }
}
