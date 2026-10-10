/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
import java.lang.reflect.*;
import java.util.*;
import org.jetbrains.kotlin.js.backend.ast.*;
import org.jetbrains.kotlin.js.commentprobe.*;
import org.jetbrains.kotlin.js.portable.JsCommentTypeNameReporter;

/** Complete genuine Serializer objects and genuine AST receiver hierarchies. */
public class Oracle {
    static final String PKG="org.jetbrains.kotlin.ir.backend.js.utils.serialization.";
    static Object field(Object owner,String name)throws Exception{Field f=owner.getClass().getDeclaredField(name);f.setAccessible(true);return f.get(owner);}
    static Object make(Class<?> c)throws Exception{Constructor<?> k=c.getDeclaredConstructor();k.setAccessible(true);return k.newInstance();}
    static byte[] bytes(Object writer)throws Exception{Object data=field(writer,"data");return (byte[])data.getClass().getMethod("toByteArray").invoke(data);}
    static String hex(byte[] b){StringBuilder r=new StringBuilder();for(byte v:b)r.append(String.format("%02x",v&255));return r.toString();}
    static String text(String s){if(s==null)return "null";StringBuilder r=new StringBuilder();for(char c:s.toCharArray())r.append(String.format("%04x",(int)c));return r.toString();}
    static String snapshot(Object serializer,Object writer)throws Exception {
        return hex(bytes(writer))+"\t"+hex(bytes(field(serializer,"fragmentSerializer")))+"\t"+hex(bytes(field(serializer,"nameSerializer")))+"\t"+hex(bytes(field(serializer,"stringSerializer")))+"\t"+((Map<?,?>)field(serializer,"nameMap")).size()+":"+((Map<?,?>)field(serializer,"stringMap")).size();
    }
    static void observe(String id,boolean common,boolean reporterThrows,int kind,String body,boolean failRead,int position)throws Exception {
        CommentState state=new CommentState(body,failRead);JsComment comment=kind==-2?new JsSingleLineComment(body):kind==-1?new JsMultiLineComment(body):CommentFixturesKt.customComment(kind,state);
        Object writer=make(Class.forName(PKG+"DataWriter"));Object[] serializer={null};List<String> calls=new ArrayList<>();
        JsCommentTypeNameReporter reporter=value->{try{if(value!=comment)throw new AssertionError("wrong reporter receiver");calls.add("receiver-identical:"+snapshot(serializer[0],writer));}catch(ReflectiveOperationException e){throw new AssertionError(e);}catch(Exception e){throw new AssertionError(e);}
            if(reporterThrows)throw new IllegalArgumentException("reporter Ω");return value.getClass().getName();};
        Class<?> cls=Class.forName(PKG+"JsIrAstSerializer");
        if(common){Constructor<?> k=cls.getDeclaredConstructor(JsCommentTypeNameReporter.class);k.setAccessible(true);serializer[0]=k.newInstance(reporter);}else serializer[0]=make(cls);
        String method=position<0?"writeComment":"writeStatement";Object node=comment;
        if(position>=0){JsExpressionStatement statement=new JsExpressionStatement(new JsIntLiteral(7));
            if(position==0)statement.setCommentsBeforeNode(new ArrayList<>(List.of(comment)));
            else if(position==1)statement.setCommentsAfterNode(new ArrayList<>(List.of(comment)));
            else {statement.setCommentsBeforeNode(new ArrayList<>(List.of(new JsSingleLineComment("beforeΩ"))));statement.setCommentsAfterNode(new ArrayList<>(List.of(comment)));}node=statement;}
        Method m=cls.getDeclaredMethod(method,writer.getClass(),position<0?JsComment.class:JsStatement.class);m.setAccessible(true);Throwable failure=null;
        try{m.invoke(serializer[0],writer,node);}catch(InvocationTargetException e){failure=e.getCause();}
        System.out.println("core\t"+id+"\t"+(failure==null?"ok":failure.getClass().getName())+"\t"+text(failure==null?null:failure.getMessage())+"\t"+snapshot(serializer[0],writer)+"\t"+String.join(",",state.getTextEvents()));
        if(common){int expected=kind>=0&&!failRead?1:0;if(calls.size()!=expected)throw new AssertionError("reporter count "+id+" "+calls.size());
            System.out.println("reporter\t"+id+"\t"+calls.size()+"\t"+String.join("|",calls));
            if(expected==1&&!calls.get(0).equals("receiver-identical:"+snapshot(serializer[0],writer)))throw new AssertionError("writer changed after reporter failure "+id);
        }
    }
    public static void main(String[] args)throws Exception {
        boolean common=args[0].equals("common"),throwsReporter=args.length>1;
        String[] strings={"","ASCII\0","Ω中\ud83d\ude00","\ud800","\udc00","x".repeat(1025)};
        for(int k=-2;k<=6;k++)for(int t=0;t<strings.length;t++)observe("direct:"+k+":"+t,common,throwsReporter,k,strings[t],false,-1);
        for(int k=0;k<=6;k++)observe("text-failure:"+k,common,throwsReporter,k,"Ω",true,-1);
        for(int position=0;position<3;position++)for(int k=-2;k<=6;k++)observe("node:"+position+":"+k,common,throwsReporter,k,"attachedΩ\ud800",false,position);
    }
}
