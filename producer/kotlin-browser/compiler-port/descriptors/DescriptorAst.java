import com.sun.source.tree.*;
import com.sun.source.util.JavacTask;
import java.nio.file.Path;
import java.util.*;
import javax.tools.*;

/** Build-time only: reads actual Java declarations through the JDK parser. */
public final class DescriptorAst {
  static Object typeParameters(List<? extends TypeParameterTree> input) {
    List<Object> result=new ArrayList<>();
    for(TypeParameterTree p:input)result.add(Map.of("name",p.getName().toString(),"bounds",p.getBounds().stream().map(Object::toString).toList()));
    return result;
  }
  static Object modifiers(ModifiersTree input) {
    return Map.of("flags",input.getFlags().stream().map(Object::toString).sorted().toList(),"annotations",input.getAnnotations().stream().map(Object::toString).toList());
  }
  static Object variable(VariableTree input) {
    Map<String,Object> data=new LinkedHashMap<>();data.put("name",input.getName().toString());data.put("type",input.getType().toString());data.put("modifiers",modifiers(input.getModifiers()));
    data.put("initializer",input.getInitializer()==null?null:input.getInitializer().toString());
    if(input.getInitializer() instanceof NewClassTree c)data.put("constructorArguments",c.getArguments().stream().map(Object::toString).toList());
    return data;
  }
  static Object declaration(ClassTree input) {
    Map<String,Object> data=new LinkedHashMap<>();data.put("kind",input.getKind().toString());data.put("name",input.getSimpleName().toString());data.put("modifiers",modifiers(input.getModifiers()));
    data.put("typeParameters",typeParameters(input.getTypeParameters()));data.put("extends",input.getExtendsClause()==null?null:input.getExtendsClause().toString());
    data.put("interfaces",input.getImplementsClause().stream().map(Object::toString).toList());List<Object> members=new ArrayList<>();
    for(Tree member:input.getMembers()){
      if(member instanceof ClassTree c)members.add(declaration(c));
      else if(member instanceof VariableTree v){Map<String,Object> d=new LinkedHashMap<>();d.put("kind","VARIABLE");d.put("declaration",variable(v));members.add(d);}
      else if(member instanceof MethodTree m){Map<String,Object> d=new LinkedHashMap<>();d.put("kind","METHOD");d.put("name",m.getName().toString());d.put("returnType",m.getReturnType()==null?null:m.getReturnType().toString());d.put("typeParameters",typeParameters(m.getTypeParameters()));d.put("modifiers",modifiers(m.getModifiers()));d.put("parameters",m.getParameters().stream().map(DescriptorAst::variable).toList());d.put("body",m.getBody()==null?null:m.getBody().toString());d.put("throws",m.getThrows().stream().map(Object::toString).toList());members.add(d);}
      else if(member.getKind()!=Tree.Kind.EMPTY_STATEMENT)throw new IllegalArgumentException("Unsupported actual Java member: "+member.getKind());
    }
    data.put("members",members);return data;
  }
  static String json(Object value){
    if(value==null)return "null";
    if(value instanceof String s){StringBuilder out=new StringBuilder("\"");for(char c:s.toCharArray()){switch(c){case '"'->out.append("\\\"");case '\\'->out.append("\\\\");case '\n'->out.append("\\n");case '\r'->out.append("\\r");case '\t'->out.append("\\t");default->{if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c);}}}return out.append('"').toString();}
    if(value instanceof List<?> l)return "["+String.join(",",l.stream().map(DescriptorAst::json).toList())+"]";
    if(value instanceof Map<?,?> m){List<String> parts=new ArrayList<>();List<Map.Entry<?,?>> entries=new ArrayList<>(m.entrySet());entries.sort(Comparator.comparing(e->e.getKey().toString()));for(Map.Entry<?,?> entry:entries)parts.add(json(entry.getKey().toString())+":"+json(entry.getValue()));return "{"+String.join(",",parts)+"}";}
    if(value instanceof Boolean||value instanceof Number)return value.toString();throw new IllegalArgumentException("Unsupported JSON object");
  }
  public static void main(String[] args)throws Exception{
    JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();if(compiler==null)throw new IllegalStateException("A real JDK parser is required");
    DiagnosticCollector<JavaFileObject> diagnostics=new DiagnosticCollector<>();
    try(StandardJavaFileManager files=compiler.getStandardFileManager(diagnostics,null,java.nio.charset.StandardCharsets.UTF_8)){
      JavacTask task=(JavacTask)compiler.getTask(null,files,diagnostics,List.of("-proc:none"),null,files.getJavaFileObjectsFromStrings(Arrays.asList(args)));
      List<Object> units=new ArrayList<>();for(CompilationUnitTree unit:task.parse()){
        Map<String,Object> data=new LinkedHashMap<>();data.put("path",Path.of(unit.getSourceFile().toUri()).toString());data.put("package",unit.getPackageName().toString());data.put("imports",unit.getImports().stream().map(i->Map.of("name",i.getQualifiedIdentifier().toString(),"static",i.isStatic())).toList());data.put("declarations",unit.getTypeDecls().stream().filter(t->t instanceof ClassTree).map(t->declaration((ClassTree)t)).toList());units.add(data);
      }
      if(diagnostics.getDiagnostics().stream().anyMatch(d->d.getKind()==Diagnostic.Kind.ERROR))throw new IllegalArgumentException("Selected Java syntax did not parse: "+diagnostics.getDiagnostics());
      System.out.println(json(units));
    }
  }
}
