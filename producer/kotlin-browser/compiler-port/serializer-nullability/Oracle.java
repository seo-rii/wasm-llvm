/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
import java.lang.reflect.*;
import java.util.*;
import org.jetbrains.kotlin.js.backend.ast.*;

/** Executes the genuine complete Serializer with genuine AST receivers. */
public class Oracle {
    static final String PACKAGE = "org.jetbrains.kotlin.ir.backend.js.utils.serialization.";
    interface Build { Object make() throws Exception; }
    static Object field(Object owner, String name) throws Exception {
        Field f = owner.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(owner);
    }
    static byte[] bytes(Object writer) throws Exception {
        Object data = field(writer, "data"); Method m = data.getClass().getMethod("toByteArray"); return (byte[])m.invoke(data);
    }
    static String hex(byte[] bytes) { StringBuilder s = new StringBuilder(); for(byte b:bytes)s.append(String.format("%02x",b&255)); return s.toString(); }
    static String text(String value) { if(value==null)return "null"; StringBuilder s=new StringBuilder();for(char c:value.toCharArray())s.append(String.format("%04x",(int)c));return s.toString(); }
    static Object create(Class<?> c) throws Exception { Constructor<?> k=c.getDeclaredConstructor();k.setAccessible(true);return k.newInstance(); }
    static void observe(String id, String operation, Build fixture) throws Exception {
        Object node=fixture.make(), serializer=create(Class.forName(PACKAGE+"JsIrAstSerializer")), writer=create(Class.forName(PACKAGE+"DataWriter"));
        Throwable failure=null;
        try {
            if(operation.equals("visitNamedDeclarable")) {
                Class<?> v=Class.forName(PACKAGE+"JsIrAstSerializer$writeExpression$visitor$1");
                Constructor<?> k=v.getDeclaredConstructors()[0]; k.setAccessible(true);
                Object visitor=k.newInstance(writer,serializer);Method m=v.getDeclaredMethod(operation,JsDeclarable.Named.class);m.setAccessible(true);m.invoke(visitor,node);
            } else {
                Class<?> nodeType=operation.equals("writeStatement")?JsStatement.class:operation.equals("writeDeclarable")?JsDeclarable.class:operation.equals("writeFunction")?JsFunction.class:JsExpression.class;
                Method m=serializer.getClass().getDeclaredMethod(operation,writer.getClass(),nodeType);m.setAccessible(true);m.invoke(serializer,writer,node);
            }
        } catch(InvocationTargetException e) {failure=e.getCause();}
        System.out.println(id+"\t"+(failure==null?"ok":failure.getClass().getName())+"\t"+text(failure==null?null:failure.getMessage())+"\t"+hex(bytes(writer))+"\t"+hex(bytes(field(serializer,"fragmentSerializer")))+"\t"+hex(bytes(field(serializer,"nameSerializer")))+"\t"+hex(bytes(field(serializer,"stringSerializer")))+"\t"+((Map<?,?>)field(serializer,"nameMap")).size()+":"+((Map<?,?>)field(serializer,"stringMap")).size());
        if(failure!=null) System.err.println(id+" @ "+failure.getStackTrace()[0]);
    }
    static JsIntLiteral expression(){return new JsIntLiteral(7);}
    static JsName name(){return new JsName("nameΩ",false);}
    static JsFunction function(){return new JsFunction(new JsProgram().getScope(),"fixture");}
    public static void main(String[] args) throws Exception {
        observe("throw:null","writeStatement",()->new JsThrow());observe("throw:valid","writeStatement",()->new JsThrow(expression()));
        observe("label:name-null","writeStatement",()->new JsLabel(null,new JsBlock()));observe("label:statement-null","writeStatement",()->new JsLabel(name()));observe("label:valid","writeStatement",()->new JsLabel(name(),new JsBlock()));
        observe("switch:null","writeStatement",()->new JsSwitch());observe("switch:valid","writeStatement",()->new JsSwitch(expression(),new ArrayList<>()));
        observe("case:null","writeStatement",()->new JsSwitch(expression(),Arrays.asList(new JsCase())));observe("case:valid","writeStatement",()->{JsCase c=new JsCase();c.setCaseExpression(expression());return new JsSwitch(expression(),Arrays.asList(c));});
        observe("while:condition-null","writeStatement",()->new JsWhile());observe("while:body-null","writeStatement",()->new JsWhile(expression(),null));observe("while:valid","writeStatement",()->new JsWhile(expression(),new JsBlock()));
        observe("do:condition-null","writeStatement",()->new JsDoWhile());observe("do:body-null","writeStatement",()->new JsDoWhile(expression(),null));observe("do:valid","writeStatement",()->new JsDoWhile(expression(),new JsBlock()));
        observe("try:null","writeStatement",()->new JsTry());observe("try:valid","writeStatement",()->new JsTry(new JsBlock(),new ArrayList<JsCatch>(),null));
        observe("catch:null","writeStatement",()->new JsTry(new JsBlock(),Arrays.asList(new JsCatch(new JsDeclarable.Named(name()))),null));observe("catch:valid","writeStatement",()->{JsCatch c=new JsCatch(new JsDeclarable.Named(name()));c.setBody(new JsBlock());return new JsTry(new JsBlock(),Arrays.asList(c),null);});
        observe("regexp:null","writeExpression",()->new JsRegExp());observe("regexp:valid","writeExpression",()->{JsRegExp r=new JsRegExp();r.setPattern("aΩ");return r;});
        observe("binary:first-null","writeExpression",()->new JsBinaryOperation(JsBinaryOperator.ADD,null,expression()));observe("binary:second-null","writeExpression",()->new JsBinaryOperation(JsBinaryOperator.ADD,expression(),null));observe("binary:valid","writeExpression",()->new JsBinaryOperation(JsBinaryOperator.ADD,expression(),expression()));
        observe("prefix:null","writeExpression",()->new JsPrefixOperation(JsUnaryOperator.NOT,null));observe("prefix:valid","writeExpression",()->new JsPrefixOperation(JsUnaryOperator.NOT,expression()));
        observe("postfix:null","writeExpression",()->new JsPostfixOperation(JsUnaryOperator.INC,null));observe("postfix:valid","writeExpression",()->new JsPostfixOperation(JsUnaryOperator.INC,expression()));
        observe("conditional:test-null","writeExpression",()->new JsConditional(null,expression(),expression()));observe("conditional:then-null","writeExpression",()->new JsConditional(expression(),null,expression()));observe("conditional:else-null","writeExpression",()->new JsConditional(expression(),expression(),null));observe("conditional:valid","writeExpression",()->new JsConditional(expression(),expression(),expression()));
        observe("array:array-null","writeExpression",()->new JsArrayAccess(null,expression()));observe("array:index-null","writeExpression",()->new JsArrayAccess(expression(),null));observe("array:valid","writeExpression",()->new JsArrayAccess(expression(),expression()));
        observe("nameref:null","writeExpression",()->{JsNameRef n=new JsNameRef("unused");n.resolve(null);return n;});observe("nameref:valid","writeExpression",()->new JsNameRef("propertyΩ"));
        observe("new:null","writeExpression",()->new JsNew(null,new ArrayList<JsExpression>()));observe("new:valid","writeExpression",()->new JsNew(expression(),new ArrayList<JsExpression>()));
        observe("function:body-null","writeFunction",Oracle::function);observe("function:computed-null","writeFunction",()->{JsFunction f=function();f.setBody(new JsBlock());return f;});observe("function:computed-valid","writeFunction",()->{JsFunction f=function();f.setBody(new JsBlock());f.setComputedName(expression());return f;});
        observe("named:visitor","visitNamedDeclarable",()->new JsDeclarable.Named(name()));observe("named:private","writeDeclarable",()->new JsDeclarable.Named(name()));
        for(Object value:new Object[]{null,9,true,new Object(),"textΩ",new JsNameRef("property")}){
            String kind=value==null?"null":value.getClass().getSimpleName();
            observe("metadata:"+kind,"writeExpression",()->{Map<String,Object> tags=new LinkedHashMap<>();tags.put("tagΩ",value);return new JsDocComment(tags);});
        }
    }
}
