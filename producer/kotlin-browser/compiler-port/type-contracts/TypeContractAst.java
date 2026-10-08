import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.nio.file.Path;
import java.util.*;
import javax.tools.*;

/** Build-time only. Uses the actual JDK type resolver with genuine, verified reference classes. */
public final class TypeContractAst {
  static final Map<ClassTree,List<? extends Tree>> originalMembers=new IdentityHashMap<>();
  static void capture(ClassTree declaration) {
    originalMembers.put(declaration,List.copyOf(declaration.getMembers()));
    for(Tree member:declaration.getMembers())if(member instanceof ClassTree nested)capture(nested);
  }
  static String resolved(Trees trees,CompilationUnitTree unit,Tree tree) {
    if(tree==null)return null;
    var type=trees.getTypeMirror(TreePath.getPath(unit,tree));
    if(type==null||type.getKind()==javax.lang.model.type.TypeKind.ERROR)throw new IllegalArgumentException("Unresolved original Java type: "+tree);
    return type.toString();
  }
  @SuppressWarnings("unchecked")
  static void enrich(Map<String,Object> declaration,ClassTree tree,Trees trees,CompilationUnitTree unit) {
    declaration.put("resolvedInterfaces",tree.getImplementsClause().stream().map(t->resolved(trees,unit,t)).toList());
    List<Map<String,Object>> members=(List<Map<String,Object>>)declaration.get("members");int index=0;
    for(Tree member:originalMembers.get(tree)) {
      if(member.getKind()==Tree.Kind.EMPTY_STATEMENT)continue;
      Map<String,Object> data=members.get(index++);
      if(member instanceof ClassTree nested)enrich(data,nested,trees,unit);
      else if(member instanceof MethodTree method) {
        data.put("resolvedReturnType",resolved(trees,unit,method.getReturnType()));
        List<Map<String,Object>> parameters=(List<Map<String,Object>>)data.get("parameters");
        for(int i=0;i<parameters.size();i++)parameters.get(i).put("resolvedType",resolved(trees,unit,method.getParameters().get(i).getType()));
      }
      else if(member instanceof VariableTree variable) ((Map<String,Object>)data.get("declaration")).put("resolvedType",resolved(trees,unit,variable.getType()));
    }
    if(index!=members.size())throw new IllegalArgumentException("Java AST changed during resolution");
  }
  @SuppressWarnings("unchecked")
  public static void main(String[] args)throws Exception {
    if(args.length<2)throw new IllegalArgumentException("Usage: TypeContractAst REAL_CLASSPATH SOURCE...");
    JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();if(compiler==null)throw new IllegalStateException("A real JDK is required");
    DiagnosticCollector<JavaFileObject> diagnostics=new DiagnosticCollector<>();
    try(StandardJavaFileManager files=compiler.getStandardFileManager(diagnostics,null,java.nio.charset.StandardCharsets.UTF_8)) {
      JavacTask task=(JavacTask)compiler.getTask(null,files,diagnostics,List.of("-proc:none","-classpath",args[0]),null,files.getJavaFileObjectsFromStrings(Arrays.asList(args).subList(1,args.length)));
      List<CompilationUnitTree> parsed=new ArrayList<>();List<Map<String,Object>> units=new ArrayList<>();
      for(CompilationUnitTree unit:task.parse()) {
        parsed.add(unit);Map<String,Object> data=new LinkedHashMap<>();data.put("path",Path.of(unit.getSourceFile().toUri()).toString());data.put("package",unit.getPackageName().toString());
        data.put("imports",unit.getImports().stream().map(i->Map.of("name",i.getQualifiedIdentifier().toString(),"static",i.isStatic())).toList());
        List<Object> declarations=new ArrayList<>();for(Tree declaration:unit.getTypeDecls())if(declaration instanceof ClassTree tree){capture(tree);declarations.add(DescriptorAst.declaration(tree));}
        data.put("declarations",declarations);units.add(data);
      }
      task.analyze();
      if(diagnostics.getDiagnostics().stream().anyMatch(d->d.getKind()==Diagnostic.Kind.ERROR))throw new IllegalArgumentException("Original Java symbol resolution failed: "+diagnostics.getDiagnostics());
      Trees trees=Trees.instance(task);
      for(int i=0;i<parsed.size();i++) {
        List<Map<String,Object>> declarations=(List<Map<String,Object>>)units.get(i).get("declarations");int index=0;
        for(Tree declaration:parsed.get(i).getTypeDecls())if(declaration instanceof ClassTree tree)enrich(declarations.get(index++),tree,trees,parsed.get(i));
      }
      System.out.println(DescriptorAst.json(units));
    }
  }
}
