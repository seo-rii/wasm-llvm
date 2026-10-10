/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
import java.io.*;
import java.lang.reflect.*;
import java.util.*;
import org.jetbrains.kotlin.js.backend.ast.*;
import org.jetbrains.kotlin.js.portable.CompilerByteSink;
import org.jetbrains.kotlin.ir.backend.js.transformers.irToJs.*;

/** Observes genuine complete source classes; only the request byte sink is a test host. */
public class TransportOracle {
 static final String PKG="org.jetbrains.kotlin.ir.backend.js.utils.serialization.";
 static class State {
  final ByteArrayOutputStream bytes=new ByteArrayOutputStream();final List<String> events=new ArrayList<>();
  final int failWrite;final boolean failFlush,failClose;int writes;
  State(int w,boolean f,boolean c){failWrite=w;failFlush=f;failClose=c;}
  void write(byte[] b,int o,int n){events.add("write:"+o+":"+n);if(++writes==failWrite)throw new IllegalStateException("write:"+writes);bytes.write(b,o,n);}
  void flush(){events.add("flush");if(failFlush)throw new IllegalStateException("flush");}
  void close(){events.add("close");if(failClose)throw new IllegalStateException("close");}
 }
 static class NativeSink extends OutputStream {
  final State s;NativeSink(State s){this.s=s;}
  public void write(int b){s.write(new byte[]{(byte)b},0,1);}
  public void write(byte[] b,int o,int n){s.write(b,o,n);}
  public void flush(){s.flush();}public void close(){s.close();}
 }
 static class CommonSink implements CompilerByteSink {
  final State s;CommonSink(State s){this.s=s;}
  public void write(byte[] b,int o,int n){s.write(b,o,n);}public void flush(){s.flush();}public void close(){s.close();}
 }
 static String hex(byte[] b){StringBuilder r=new StringBuilder();for(byte v:b)r.append(String.format("%02x",v&255));return r.toString();}
 static String text(String s){if(s==null)return "null";StringBuilder r=new StringBuilder();for(char c:s.toCharArray())r.append(String.format("%04x",(int)c));return r.toString();}
 static String failure(Throwable t){if(t==null)return "ok";StringBuilder r=new StringBuilder(t.getClass().getName()+":"+text(t.getMessage()));for(Throwable s:t.getSuppressed())r.append("["+failure(s)+"]");return r.toString();}
 static Throwable unwrap(Throwable t){return t instanceof InvocationTargetException?t.getCause():t;}
 static Object make(Class<?> c)throws Exception{Constructor<?> k=c.getDeclaredConstructor();k.setAccessible(true);return k.newInstance();}
 static byte[] data(Object writer)throws Exception{Field f=writer.getClass().getDeclaredField("data");f.setAccessible(true);Object d=f.get(writer);return (byte[])d.getClass().getMethod("toByteArray").invoke(d);}
 static void primitive(String id,String method,Class<?> parameter,Object value)throws Exception{
  Object writer=make(Class.forName(PKG+"DataWriter"));Method m=writer.getClass().getDeclaredMethod(method,parameter);m.setAccessible(true);Throwable t=null;
  try{m.invoke(writer,value);}catch(Throwable caught){t=unwrap(caught);}
  System.out.println("primitive:"+id+"\t"+failure(t)+"\t"+hex(data(writer)));
 }
 static JsIrProgramFragments fragments(int fixture){
  JsIrProgramFragment main=new JsIrProgramFragment("mainΩ","packageΩ");
  if(fixture>=2){
   main.getDeclarations().getStatements().add(new JsExpressionStatement(new JsStringLiteral("NUL\0Ω\ud800A\udc00\ud83d\ude00")));
   main.getDeclarations().getStatements().add(new JsExpressionStatement(new JsDoubleLiteral(-0.0)));
   main.getDeclarations().getStatements().add(new JsExpressionStatement(new JsDoubleLiteral(Double.longBitsToDouble(0x7ff8000000000001L))));
   JsName n=new JsName("nameΩ",false);main.getNameBindings().put("bindingΩ",n);
   main.getDefinitions().add("definitionΩ");main.getOptionalCrossModuleImports().add("optionalΩ");
   main.getInitializers().getStatements().add(new JsThrow(new JsIntLiteral(7)));
   main.getExports().getStatements().add(new JsExpressionStatement(new JsNameRef(n)));
   JsIntLiteral left=new JsIntLiteral(11),right=new JsIntLiteral(13);
   left.setSource(new JsLocation("nestedΩ.kt",3,7,null));right.setSource(new JsLocation("otherΩ.kt",5,9,null));
   JsBinaryOperation operation=new JsBinaryOperation(JsBinaryOperator.ADD,left,right);
   operation.setSource(new JsLocation("nestedΩ.kt",2,4,null));
   JsExpressionStatement located=new JsExpressionStatement(operation);
   JsBlock block=new JsBlock();block.setSource(new JsLocation("outerΩ.kt",0,0,null));
   block.getStatements().add(located);block.getStatements().add(new JsExpressionStatement(new JsIntLiteral(17)));
   main.getDeclarations().getStatements().add(block);
  }
  if(fixture==3)main.getDeclarations().getStatements().add(new JsThrow());
  return new JsIrProgramFragments(main,fixture==1||fixture==2?new JsIrProgramFragment("exportΩ","exportsΩ"):null);
 }
 static void serialize(String id,boolean common,boolean override,int fixture,int write,boolean flush,boolean close)throws Exception{
  State s=new State(write,flush,close);Object sink=common?new CommonSink(s):new NativeSink(s);Class<?> boundary=common?CompilerByteSink.class:OutputStream.class;JsIrProgramFragments f=fragments(fixture);Throwable t=null;
  try{if(override)f.getClass().getMethod("serialize",boundary).invoke(f,sink);
   else Class.forName(PKG+"JsIrAstSerializerKt").getDeclaredMethod("serializeTo",JsIrProgramFragments.class,boundary).invoke(null,f,sink);
  }catch(Throwable caught){t=unwrap(caught);}
  System.out.println(id+"\t"+failure(t)+"\t"+hex(s.bytes.toByteArray())+"\t"+String.join(",",s.events));
 }
 public static void main(String[] args)throws Exception{
  boolean common=args[0].equals("common");
  for(int v:new int[]{Integer.MIN_VALUE,-1,0,1,126,127,128,255,Integer.MAX_VALUE})primitive("byte:"+v,"writeByte",int.class,v);
  for(int v:new int[]{Integer.MIN_VALUE,-123456789,-1,0,1,123456789,Integer.MAX_VALUE})primitive("int:"+v,"writeInt",int.class,v);
  for(long bits:new long[]{0L,Long.MIN_VALUE,1L,0x0010000000000000L,0x3ff0000000000000L,0x7ff0000000000000L,0xfff0000000000000L,0x7ff8000000000001L,0xfff123456789abcdL})primitive("double:"+Long.toUnsignedString(bits,16),"writeDouble",double.class,Double.longBitsToDouble(bits));
  for(boolean v:new boolean[]{false,true})primitive("boolean:"+v,"writeBoolean",boolean.class,v);
  String[] strings={"","ASCII\0","Ω中\ud83d\ude00","\ud800","\udc00","\ud800\ud800\udc00\udc00","x".repeat(1025)};
  for(int i=0;i<strings.length;i++)primitive("string:"+i,"writeString",String.class,strings[i]);
  for(byte[] b:new byte[][]{new byte[0],new byte[]{0,127,-128,-1},new byte[65]})primitive("array:"+b.length,"writeByteArray",byte[].class,b);
  for(boolean override:new boolean[]{false,true})for(int fixture=0;fixture<4;fixture++){
   String prefix=(override?"override":"extension")+":"+fixture;
   for(int w=0;w<=6;w++)serialize(prefix+":write:"+w,common,override,fixture,w,false,false);
   serialize(prefix+":flush",common,override,fixture,0,true,false);serialize(prefix+":close",common,override,fixture,0,false,true);serialize(prefix+":both",common,override,fixture,0,true,true);
   serialize(prefix+":action-close",common,override,fixture,3,true,true);
  }
 }
}
