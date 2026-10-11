package descriptorreceiverproof;

import java.util.*;
import org.jetbrains.kotlin.builtins.DefaultBuiltIns;
import org.jetbrains.kotlin.descriptors.*;
import org.jetbrains.kotlin.descriptors.annotations.Annotations;
import org.jetbrains.kotlin.descriptors.impl.*;
import org.jetbrains.kotlin.name.Name;
import org.jetbrains.kotlin.resolve.*;
import org.jetbrains.kotlin.resolve.scopes.MemberScope;
import org.jetbrains.kotlin.resolve.scopes.receivers.*;
import org.jetbrains.kotlin.storage.LockBasedStorageManager;
import org.jetbrains.kotlin.types.*;
import org.jetbrains.kotlin.types.error.*;
import org.jetbrains.kotlin.portable.descriptorbases.*;

/** One observer executes the complete freshly built original and common classes. */
public final class ReceiverFactoryOracle {
    static final Annotations A = Annotations.Companion.getEMPTY();
    static final SourceElement S = SourceElement.NO_SOURCE;
    static DefaultBuiltIns b;
    static KotlinType i, t;
    interface Op { Object run() throws Throwable; }
    static String result(Op op) { try { return String.valueOf(op.run()); } catch (Throwable x) { return x.getClass().getName(); } }
    static void record(String name, Object... values) {
        StringJoiner line = new StringJoiner(":", "record:" + name + ":", "");
        for (Object v : values) line.add(String.valueOf(v)); System.out.println(line);
    }
    static final class Owner extends SimpleFunctionDescriptorImpl {
        Owner() { super(b.getBuiltInsModule(), null, A, Name.identifier("owner"), CallableMemberDescriptor.Kind.DECLARATION, S);
            initialize(null, null, Collections.emptyList(), Collections.emptyList(), Collections.emptyList(), i, Modality.FINAL, DescriptorVisibilities.PUBLIC); }
        public String toString() { return "proof-owner"; }
    }
    static final class Klass extends ClassDescriptorImpl {
        Klass(DeclarationDescriptor owner, ClassKind kind) {
            super(owner, Name.identifier("ProofClass"), Modality.FINAL, kind, Collections.singletonList(b.getAnyType()), S, false, LockBasedStorageManager.NO_LOCKS);
            initialize(MemberScope.Empty.INSTANCE, Collections.emptySet(), null);
        }
        public String toString() { return "proof-class"; }
    }
    static ReceiverParameterDescriptor receiver(DeclarationDescriptor owner, KotlinType type) {
        return new ReceiverParameterDescriptorImpl(owner, new TransientReceiver(type), A, Name.identifier("custom"));
    }
    static final class VirtualReceiver extends ReceiverParameterDescriptorImpl {
        int updates;
        VirtualReceiver(DeclarationDescriptor owner, KotlinType type) { super(owner, new TransientReceiver(type), A); }
        public void setOutType(KotlinType type) { updates++; super.setOutType(type); }
    }
    static String info(ReceiverParameterDescriptor r) {
        return r == null ? "null" : r.getName() + "/" + r.getType() + "/" + r.getValue().getClass().getSimpleName();
    }
    static TypeSubstitutor substitution(Variance variance) {
        return TypeSubstitutor.create(TypeConstructorSubstitution.createByConstructorsMap(Collections.singletonMap(i.getConstructor(), new TypeProjectionImpl(variance, t))));
    }
    static void run() {
        b = DefaultBuiltIns.getInstance(); i = b.getIntType(); t = b.getStringType();
        Owner f = new Owner(), f2 = new Owner(); Klass c = new Klass(b.getBuiltInsModule(), ClassKind.CLASS);
        ExtensionReceiver e = new ExtensionReceiver(f, i, null);
        ReceiverValue e2 = e.replaceType(t), e3 = e2.replaceType(i);
        record("extension", e.getType() == i, e.getOriginal() == e, e.getDeclarationDescriptor() == f, e.toString(), e2.getOriginal() == e, e3.getOriginal() == e, ((ImplicitReceiver)e2).getDeclarationDescriptor() == f, e3.getType() == i);
        TransientReceiver tr = new TransientReceiver(i); ReceiverValue tr2 = tr.replaceType(t), tr3 = tr2.replaceType(i);
        record("transient", tr.getOriginal() == tr, tr.toString(), tr2.getType() == t, tr2.getOriginal() == tr, tr3.getOriginal() == tr);
        ExtensionReceiver previous = new ExtensionReceiver(f2, t, tr);
        record("explicit-original", previous.getOriginal() == tr, previous.replaceType(i).getOriginal() == tr);
        ReceiverParameterDescriptor r = receiver(f, i);
        record("receiver", r.getContainingDeclaration() == f, r.getName(), r.getAnnotations() == A, r.getType() == i, r.getReturnType() == i, r.getOriginal() == r,
            r.getSource() == S, r.getVisibility() == DescriptorVisibilities.LOCAL, r.getContextReceiverParameters().size(), r.getExtensionReceiverParameter(), r.getDispatchReceiverParameter(),
            r.getTypeParameters().size(), r.getValueParameters().size(), r.getOverriddenDescriptors().size(), r.hasStableParameterNames(), r.hasSynthesizedParameterNames(), r.getUserData(null));
        ReceiverParameterDescriptor cp = r.copy(c);
        record("copy", cp != r, cp.getContainingDeclaration() == c, cp.getValue() == r.getValue(), cp.getName(), cp.getOriginal() == cp, cp.getAnnotations() == A);
        record("empty-substitution", r.substitute(TypeSubstitutor.EMPTY) == r);
        ReceiverParameterDescriptor unchanged = receiver(f, t);
        record("identity-substitution", unchanged.substitute(substitution(Variance.INVARIANT)) == unchanged);
        ReceiverParameterDescriptor substituted = r.substitute(substitution(Variance.INVARIANT));
        record("changed-substitution", info(substituted), substituted.getContainingDeclaration() == f, substituted.getAnnotations() == A, substituted.getValue().getOriginal() == substituted.getValue());
        for (Variance v : Variance.values()) {
            record("substitution-variance-" + v.name(), info(r.substitute(substitution(v))), info(receiver(c, i).substitute(substitution(v))));
        }
        String visited = r.accept(new DeclarationDescriptorVisitorEmptyBodies<String, Integer>() {
            public String visitReceiverParameterDescriptor(ReceiverParameterDescriptor d, Integer n) { return (d == r) + "/" + n; }
        }, 31);
        record("visitor", visited);
        record("out-type-regular-assertion", result(() -> { ((ReceiverParameterDescriptorImpl)r).setOutType(t); return null; }));
        ReceiverParameterDescriptorImpl error = (ReceiverParameterDescriptorImpl) receiver(f, org.jetbrains.kotlin.types.error.ErrorUtils.createErrorType(ErrorTypeKind.UNRESOLVED_TYPE, "proof"));
        ReceiverValue oldError = error.getValue(); error.setOutType(t);
        record("out-type-error", error.getType() == t, error.getValue() != oldError, error.getValue().getOriginal() == oldError);
        VirtualReceiver virtual = new VirtualReceiver(f, org.jetbrains.kotlin.types.error.ErrorUtils.createErrorType(ErrorTypeKind.UNRESOLVED_TYPE, "virtual"));
        ((ReceiverParameterDescriptorImpl)virtual).setOutType(t);
        record("out-type-virtual-dispatch", virtual.updates, virtual.getType() == t);
        record("null-receiver-factories", DescriptorFactory.createExtensionReceiverParameterForCallable(f, null, A),
            DescriptorFactory.createContextReceiverParameterForCallable(f, null, null, A, 0), DescriptorFactory.createContextReceiverParameterForClass(c, null, null, A, 0));
        ReceiverParameterDescriptor extension = DescriptorFactory.createExtensionReceiverParameterForCallable(f, i, A);
        record("extension-factory", info(extension), extension.getContainingDeclaration() == f, ((ImplicitReceiver)extension.getValue()).getDeclarationDescriptor() == f);
        for (int index : new int[] { -1, 0, 1, 12, Integer.MAX_VALUE }) {
            ReceiverParameterDescriptor context = DescriptorFactory.createContextReceiverParameterForCallable(f, i, Name.identifier("label"), A, index);
            ReceiverParameterDescriptor contextClass = DescriptorFactory.createContextReceiverParameterForClass(c, t, null, A, index);
            record("context-factory-" + index, info(context), context.getContainingDeclaration() == f, ((ImplicitContextReceiver)context.getValue()).getCustomLabelName(),
                info(contextClass), ((ImplicitContextReceiver)contextClass.getValue()).getCustomLabelName(), contextClass.getContainingDeclaration() == c);
        }
        PropertyDescriptorImpl property = PropertyDescriptorImpl.create(c, A, Modality.OPEN, DescriptorVisibilities.PRIVATE, true, Name.identifier("property"), CallableMemberDescriptor.Kind.DECLARATION, S,
            false, false, false, false, false, false);
        property.setType(i, Collections.emptyList(), null, null, Collections.emptyList());
        PropertySetterDescriptorImpl ds = DescriptorFactory.createDefaultSetter(property, A, A);
        record("default-setter", ds.getCorrespondingProperty() == property, ds.isDefault(), ds.isExternal(), ds.isInline(), ds.getVisibility() == DescriptorVisibilities.PRIVATE,
            ds.getKind(), ds.getSource() == S, ds.getValueParameters().get(0).getContainingDeclaration() == ds, ds.getValueParameters().get(0).getType() == i);
        PropertySetterDescriptorImpl setter = DescriptorFactory.createSetter(property, A, A, false, true, true, S);
        PropertySetterDescriptorImpl custom = DescriptorFactory.createSetter(property, A, A, true, true, false, DescriptorVisibilities.INTERNAL, S);
        record("setter-overloads", setter.isDefault(), setter.isExternal(), setter.isInline(), setter.getVisibility() == property.getVisibility(), custom.getVisibility() == DescriptorVisibilities.INTERNAL, custom.isDefault(), custom.isInline());
        PropertyGetterDescriptorImpl dg = DescriptorFactory.createDefaultGetter(property, A);
        PropertyGetterDescriptorImpl getter = DescriptorFactory.createGetter(property, A, false, true, true);
        PropertyGetterDescriptorImpl gs = DescriptorFactory.createGetter(property, A, true, false, true, S);
        record("getter-overloads", dg.getCorrespondingProperty() == property, dg.isDefault(), dg.isExternal(), dg.isInline(), dg.getModality(), dg.getVisibility() == DescriptorVisibilities.PRIVATE,
            getter.isDefault(), getter.isExternal(), getter.isInline(), gs.getSource() == S, gs.isInline());
        Klass object = new Klass(b.getBuiltInsModule(), ClassKind.OBJECT);
        ClassConstructorDescriptorImpl ctor = DescriptorFactory.createPrimaryConstructorForObject(object, S);
        record("object-constructor", ctor.getContainingDeclaration() == object, ctor.isPrimary(), ctor.getValueParameters().size(), ctor.getKind(), ctor.getVisibility() == DescriptorVisibilities.PRIVATE, ctor.getSource() == S);
        Klass en = new Klass(b.getBuiltInsModule(), ClassKind.ENUM_CLASS);
        SimpleFunctionDescriptor values = DescriptorFactory.createEnumValuesMethod(en), valueOf = DescriptorFactory.createEnumValueOfMethod(en);
        record("enum-values", values.getName(), values.getContainingDeclaration() == en, values.getKind(), values.getModality(), values.getVisibility() == DescriptorVisibilities.PUBLIC,
            values.getReturnType(), values.getValueParameters().size(), DescriptorFactory.isEnumValuesMethod(values), DescriptorFactory.isEnumValueOfMethod(values));
        ValueParameterDescriptor p = valueOf.getValueParameters().get(0);
        record("enum-valueof", valueOf.getName(), valueOf.getReturnType() == en.getDefaultType(), p.getName(), p.getIndex(), p.getType() == t, p.getContainingDeclaration() == valueOf,
            p.declaresDefaultValue(), p.isCrossinline(), p.isNoinline(), DescriptorFactory.isEnumValueOfMethod(valueOf), DescriptorFactory.isEnumValuesMethod(valueOf));
        record("enum-predicates", DescriptorFactory.isEnumValuesMethod(DescriptorFactory.createEnumValuesMethod(c)), DescriptorFactory.isEnumValueOfMethod(f));
        record("enum-entries-default", DescriptorFactory.createEnumEntriesProperty(en));
        // The builtins module has no stdlib EnumEntries. Exercise the factory's configurable
        // class-finder capability with its genuine Array class (one type parameter).
        Map<ModuleCapability<?>, Object> available = new HashMap<>();
        available.put(StdlibClassFinderKt.getSTDLIB_CLASS_FINDER_CAPABILITY(), (StdlibClassFinder)(m -> b.getArray()));
        ModuleDescriptorImpl entriesModule = new ModuleDescriptorImpl(Name.special("<entries-capability>"), LockBasedStorageManager.NO_LOCKS, b, null, available);
        PropertyDescriptor entries = DescriptorFactory.createEnumEntriesProperty(new Klass(entriesModule, ClassKind.ENUM_CLASS));
        record("enum-entries", entries != null, entries.getName(), entries.getKind(), entries.isVar(), entries.getType(), entries.getGetter().getReturnType() == entries.getType(),
            entries.getGetter().isDefault(), entries.getGetter().getKind(), entries.getSetter(), entries.getSource() == S);
        Map<ModuleCapability<?>, Object> capabilities = new HashMap<>();
        capabilities.put(StdlibClassFinderKt.getSTDLIB_CLASS_FINDER_CAPABILITY(), (StdlibClassFinder)(m -> null));
        ModuleDescriptorImpl noEntries = new ModuleDescriptorImpl(Name.special("<no-entries>"), LockBasedStorageManager.NO_LOCKS, b, null, capabilities);
        record("enum-entries-missing", DescriptorFactory.createEnumEntriesProperty(new Klass(noEntries, ClassKind.ENUM_CLASS)));
    }
    public static void main(String[] args) {
        DescriptorDebugHost host = new DescriptorDebugHost() {
            public String classSimpleName(DeclarationDescriptor d) { return d.getClass().getSimpleName(); }
            public int identityHashCode(DeclarationDescriptor d) { return System.identityHashCode(d); }
        };
        DescriptorDebugHostContext.INSTANCE.withHost(host, () -> { run(); return null; });
    }
}
