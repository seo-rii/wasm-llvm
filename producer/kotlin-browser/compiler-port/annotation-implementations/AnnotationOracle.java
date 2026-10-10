package annotationproof;

import java.util.*;
import org.jetbrains.kotlin.builtins.DefaultBuiltIns;
import org.jetbrains.kotlin.descriptors.SourceElement;
import org.jetbrains.kotlin.descriptors.annotations.*;
import org.jetbrains.kotlin.name.Name;
import org.jetbrains.kotlin.resolve.constants.*;
import org.jetbrains.kotlin.types.KotlinType;
import org.jetbrains.kotlin.types.error.ErrorTypeKind;
import org.jetbrains.kotlin.types.error.ErrorUtils;

public final class AnnotationOracle {
    static String text(String value) {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder();
        for (char c : value.toCharArray()) result.append(Integer.toHexString(c)).append(',');
        return result.toString();
    }
    static void record(String value) { System.out.println("record:" + value); }
    static final class Dynamic extends AnnotationDescriptorImpl {
        KotlinType currentType;
        final Map<Name, ConstantValue<?>> currentValues = new LinkedHashMap<>();
        final List<String> calls = new ArrayList<>();
        Dynamic(KotlinType type) { super(type, Collections.emptyMap(), SourceElement.NO_SOURCE); currentType = type; }
        @Override public KotlinType getType() { calls.add("type"); return currentType; }
        @Override public Map<Name, ConstantValue<?>> getAllValueArguments() { calls.add("values"); return currentValues; }
        @Override public SourceElement getSource() { calls.add("source"); return SourceElement.NO_SOURCE; }
    }
    static final class DynamicAnnotated extends AnnotatedImpl {
        Annotations current;
        DynamicAnnotated(Annotations annotations) { super(annotations); current = annotations; }
        @Override public Annotations getAnnotations() { return current; }
    }
    interface Construction { Object run(); }
    static void invalid(String name, Construction construction) {
        try { construction.run(); System.out.println("invalid:" + name + ":constructed"); }
        catch (Throwable failure) { System.out.println("invalid:" + name + ':' + failure.getClass().getName() + ':' + text(failure.getMessage())); }
    }
    public static void main(String[] args) {
        DefaultBuiltIns builtins = DefaultBuiltIns.getInstance();
        KotlinType[] types = { builtins.getIntType(), builtins.getStringType(), builtins.getBooleanType(), builtins.getAnyType(),
            builtins.getNullableAnyType(), ErrorUtils.createErrorType(ErrorTypeKind.UNRESOLVED_TYPE, "MissingAnnotation") };
        for (int i = 0; i < 256; i++) {
            KotlinType type = types[i % types.length];
            Map<Name, ConstantValue<?>> values = new LinkedHashMap<>();
            AnnotationDescriptorImpl annotation = new AnnotationDescriptorImpl(type, values, SourceElement.NO_SOURCE);
            record(i + ":empty:" + (annotation.getType() == type) + ':' + (annotation.getAllValueArguments() == values) + ':' +
                (annotation.getSource() == SourceElement.NO_SOURCE) + ':' + text(String.valueOf(annotation.getFqName())) + ':' + text(annotation.toString()));
            values.put(Name.identifier("number"), new IntValue(i * 173 - 19));
            values.put(Name.identifier("text"), new StringValue("a\n\u0000\uD800\uDC00" + (char)(i + 0xD700)));
            values.put(Name.identifier("truth"), new BooleanValue(i % 2 == 0));
            if (i % 3 == 0) values.put(Name.identifier("nullable"), new NullValue());
            record(i + ":mutated:" + (annotation.getAllValueArguments() == values) + ':' + text(annotation.toString()));
            values.remove(Name.identifier("number"));
            record(i + ":removed:" + text(annotation.toString()));
            List<AnnotationDescriptor> list = new ArrayList<>(); list.add(annotation);
            Annotations annotations = Annotations.Companion.create(list);
            AnnotatedImpl annotated = new AnnotatedImpl(annotations);
            record(i + ":annotations:" + (annotated.getAnnotations() == annotations) + ':' +
                (annotated.getAnnotations().iterator().next() == annotation));
        }
        Dynamic dynamic = new Dynamic(types[0]);
        for (int i = 0; i < types.length; i++) {
            dynamic.currentType = types[i]; dynamic.currentValues.put(Name.identifier("value"), new IntValue(i));
            dynamic.calls.clear(); String fqName = String.valueOf(dynamic.getFqName());
            record("virtual-fq:" + i + ':' + text(fqName) + ':' + dynamic.calls);
            dynamic.calls.clear(); String rendered = dynamic.toString();
            record("virtual-render:" + i + ':' + text(rendered) + ':' + dynamic.calls);
        }
        DynamicAnnotated annotated = new DynamicAnnotated(Annotations.Companion.getEMPTY());
        Annotations nonempty = Annotations.Companion.create(Collections.singletonList(dynamic));
        for (int i = 0; i < 16; i++) {
            annotated.current = i % 2 == 0 ? nonempty : Annotations.Companion.getEMPTY();
            record("virtual-annotations:" + i + ':' + (annotated.getAnnotations() == annotated.current));
        }
        invalid("annotations", () -> new AnnotatedImpl(null));
        invalid("type", () -> new AnnotationDescriptorImpl(null, Collections.emptyMap(), SourceElement.NO_SOURCE));
        invalid("values", () -> new AnnotationDescriptorImpl(types[0], null, SourceElement.NO_SOURCE));
        invalid("source", () -> new AnnotationDescriptorImpl(types[0], Collections.emptyMap(), null));
    }
}
