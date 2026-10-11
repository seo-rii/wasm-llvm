package descriptorbaseproof;

import java.util.*;
import org.jetbrains.kotlin.builtins.DefaultBuiltIns;
import org.jetbrains.kotlin.descriptors.*;
import org.jetbrains.kotlin.descriptors.impl.*;
import org.jetbrains.kotlin.descriptors.annotations.Annotations;
import org.jetbrains.kotlin.name.Name;
import org.jetbrains.kotlin.resolve.constants.ConstantValue;
import org.jetbrains.kotlin.types.*;
import org.jetbrains.kotlin.types.error.*;
import org.jetbrains.kotlin.portable.descriptorbases.*;

public final class DescriptorBaseOracle {
    static final List<String> calls = new ArrayList<>();
    static boolean common;
    static String text(String value) {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder();
        for (char c : value.toCharArray()) result.append(Integer.toHexString(c)).append(',');
        return result.toString();
    }
    static void record(String value) { System.out.println("record:" + value); }
    static void boundary(String value) { System.out.println("boundary:" + value); }
    interface Op { Object run() throws Throwable; }
    static String outcome(Op op) {
        try { Object value = op.run(); return value == null ? "null" : value.toString(); }
        catch (Throwable error) { return error.getClass().getName() + ':' + text(error.getMessage()); }
    }
    static final class Host implements DescriptorDebugHost {
        final String prefix; final boolean failIdentity; final boolean failName;
        Host(String prefix, boolean failIdentity, boolean failName) { this.prefix = prefix; this.failIdentity = failIdentity; this.failName = failName; }
        public String classSimpleName(DeclarationDescriptor descriptor) {
            calls.add("class"); if (failName) throw new IllegalArgumentException("name host failure");
            return prefix + descriptor.getClass().getSimpleName();
        }
        public int identityHashCode(DeclarationDescriptor descriptor) {
            calls.add("identity"); if (failIdentity) throw new IllegalArgumentException("identity host failure");
            return System.identityHashCode(descriptor);
        }
    }
    static String staticString(DeclarationDescriptor value) throws Exception {
        if (!common) return DeclarationDescriptorImpl.toString(value);
        Object companion = DeclarationDescriptorImpl.class.getField("Companion").get(null);
        return (String) companion.getClass().getMethod("toString", DeclarationDescriptor.class).invoke(companion, value);
    }
    static SimpleFunctionDescriptorImpl function(ModuleDescriptor module) {
        return SimpleFunctionDescriptorImpl.create(module, Annotations.Companion.getEMPTY(), Name.identifier("owner"), CallableMemberDescriptor.Kind.DECLARATION, SourceElement.NO_SOURCE);
    }
    static void run() throws Exception {
        DefaultBuiltIns builtins = DefaultBuiltIns.getInstance();
        SimpleFunctionDescriptorImpl owner = function(builtins.getBuiltInsModule());
        KotlinType[] types = { builtins.getIntType(), builtins.getStringType(), builtins.getNullableAnyType(), org.jetbrains.kotlin.types.error.ErrorUtils.createErrorType(ErrorTypeKind.UNRESOLVED_TYPE, "Missing") };
        for (int index = 0; index < types.length; index++) {
            Name name = Name.identifier("value" + index);
            ValueParameterDescriptorImpl value = new ValueParameterDescriptorImpl(owner, null, index, Annotations.Companion.getEMPTY(), name, types[index], false, false, false, null, SourceElement.NO_SOURCE);
            record(index + ":storage:" + (value.getName() == name) + ':' + (value.getContainingDeclaration() == owner) + ':' + (value.getSource() == SourceElement.NO_SOURCE) + ':' + (value.getOriginal() == value) + ':' + (value.getType() == types[index]) + ':' + (value.getReturnType() == types[index]));
            ValueParameterDescriptorImpl derived = new ValueParameterDescriptorImpl(owner, value, index, Annotations.Companion.getEMPTY(), name, types[index], false, false, false, null, SourceElement.NO_SOURCE);
            record(index + ":original-chain:" + (derived.getOriginal() == value));
            record(index + ":defaults:" + value.getValueParameters().size() + ':' + value.getTypeParameters().size() + ':' + value.getContextReceiverParameters().size() + ':' + value.getExtensionReceiverParameter() + ':' + value.getDispatchReceiverParameter() + ':' + value.hasStableParameterNames() + ':' + value.hasSynthesizedParameterNames() + ':' + value.isConst() + ':' + value.getUserData(null));
            final int[] visits = {0};
            value.acceptVoid(new DeclarationDescriptorVisitorEmptyBodies<Void,Void>() {
                @Override public Void visitValueParameterDescriptor(ValueParameterDescriptor actual, Void data) {
                    visits[0]++; record("visit:" + (actual == value) + ':' + data); return null;
                }
            });
            record(index + ":visits:" + visits[0]);
            record(index + ":visitor-throw:" + outcome(() -> { value.acceptVoid(new DeclarationDescriptorVisitorEmptyBodies<Void,Void>() {
                @Override public Void visitValueParameterDescriptor(ValueParameterDescriptor actual, Void data) { throw new IllegalStateException("visitor Ω"); }
            }); return null; }));
            String rendered = value.toString();
            String suffix = "[ValueParameterDescriptorImpl@" + Integer.toHexString(System.identityHashCode(value)) + "]";
            record(index + ":render:" + rendered.endsWith(suffix) + ':' + text(rendered.substring(0, rendered.length()-suffix.length())) + ':' + rendered.equals(value.toString()) + ':' + rendered.equals(staticString(value)));
            record(index + ":set:" + outcome(() -> { value.setOutType(types[1]); return value.getType() == types[1]; }));
        }
        SimpleFunctionDescriptorImpl overriddenOwner = function(builtins.getBuiltInsModule());
        ValueParameterDescriptorImpl overriddenValue = new ValueParameterDescriptorImpl(overriddenOwner, null, 0, Annotations.Companion.getEMPTY(), Name.identifier("overridden"), types[0], false, false, false, null, SourceElement.NO_SOURCE);
        overriddenOwner.initialize(null, null, Collections.emptyList(), Collections.singletonList(overriddenValue), types[0], Modality.FINAL, DescriptorVisibilities.PUBLIC);
        owner.setOverriddenDescriptors(Collections.singletonList(overriddenOwner));
        ValueParameterDescriptorImpl overridingValue = new ValueParameterDescriptorImpl(owner, null, 0, Annotations.Companion.getEMPTY(), Name.identifier("overriding"), types[0], false, false, false, null, SourceElement.NO_SOURCE);
        record("overridden-real-parameter:" + (overridingValue.getOverriddenDescriptors().iterator().next() == overriddenValue));
        Dynamic dynamic = new Dynamic(owner, types[0], Name.identifier("dynamic"));
        dynamic.current = types[1]; record("virtual-type:" + (dynamic.getReturnType() == types[1]) + ':' + dynamic.typeCalls + ':' + (dynamic.stored() == types[0]));
        String dynamicString = dynamic.toString(); record("host-real-identity:" + dynamicString.endsWith("[Dynamic@" + Integer.toHexString(System.identityHashCode(dynamic)) + "]"));
        dynamic.names = 0; dynamic.failFirstName = true;
        record("renderer-fallback:" + text(dynamic.toString()) + ':' + dynamic.names);
        dynamic.names = 0; dynamic.failAllNames = true;
        record("fallback-throw:" + outcome(dynamic::toString) + ':' + dynamic.names);
        dynamic.failAllNames = false; dynamic.failFirstName = false;
        ValueParameterDescriptorImpl deferred = new ValueParameterDescriptorImpl(owner, null, 0, Annotations.Companion.getEMPTY(), Name.identifier("deferred"), types[0], false, false, false, null, SourceElement.NO_SOURCE);
        java.lang.reflect.Field field = VariableDescriptorImpl.class.getDeclaredField("outType"); field.setAccessible(true); field.set(deferred, null);
        boundary("null-before-set:" + outcome(deferred::getType));
        deferred.setOutType(types[1]); record("null-initialized:" + (deferred.getType() == types[1]));
        boundary("raw-null-constructor:" + outcome(() -> new ValueParameterDescriptorImpl(owner, null, 0, Annotations.Companion.getEMPTY(), Name.identifier("null"), null, false, false, false, null, SourceElement.NO_SOURCE)));
        if (common) {
            DescriptorDebugHost outer = DescriptorDebugHostContext.INSTANCE.current();
            Host inner = new Host("inner-", false, false);
            boolean nested = DescriptorDebugHostContext.INSTANCE.withHost(inner, () -> DescriptorDebugHostContext.INSTANCE.current() == inner);
            record("nested-host:" + nested + ':' + (DescriptorDebugHostContext.INSTANCE.current() == outer));
            String thrown = outcome(() -> DescriptorDebugHostContext.INSTANCE.withHost(inner, () -> { throw new IllegalStateException("nested"); }));
            record("nested-throw:" + thrown + ':' + (DescriptorDebugHostContext.INSTANCE.current() == outer));
            calls.clear(); String fallback = DescriptorDebugHostContext.INSTANCE.withHost(new Host("", true, false), dynamic::toString);
            record("host-identity-fallback:" + text(fallback) + ':' + calls);
            calls.clear(); String failure = outcome(() -> DescriptorDebugHostContext.INSTANCE.withHost(new Host("", false, true), dynamic::toString));
            record("host-name-failure:" + failure + ':' + calls);
        }
    }
    public static void main(String[] args) throws Exception {
        common = args[0].equals("common");
        DescriptorDebugHostContext.INSTANCE.withHost(new Host("", false, false), () -> { try { run(); return null; } catch (Exception e) { throw new RuntimeException(e); } });
        if (common) record("host-cleared:" + outcome(() -> DescriptorDebugHostContext.INSTANCE.current()));
    }
}
