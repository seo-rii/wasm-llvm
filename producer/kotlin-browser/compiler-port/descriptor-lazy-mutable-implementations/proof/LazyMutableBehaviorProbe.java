package lazymutabledescriptorproof;

import java.util.*;
import org.jetbrains.kotlin.builtins.DefaultBuiltIns;
import org.jetbrains.kotlin.descriptors.*;
import org.jetbrains.kotlin.descriptors.annotations.Annotations;
import org.jetbrains.kotlin.descriptors.impl.*;
import org.jetbrains.kotlin.name.Name;
import org.jetbrains.kotlin.resolve.scopes.MemberScope;
import org.jetbrains.kotlin.storage.*;
import org.jetbrains.kotlin.types.*;
import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner;
import org.jetbrains.kotlin.types.error.*;
import org.jetbrains.kotlin.types.error.ErrorUtils;
import org.jetbrains.kotlin.portable.descriptorbases.DescriptorDebugHost;
import org.jetbrains.kotlin.portable.descriptorbases.DescriptorDebugHostContext;

/** The same outside-package observer runs against full original and common bodies. */
public final class LazyMutableBehaviorProbe {
    static final Annotations A = Annotations.Companion.getEMPTY();
    static final SourceElement S = SourceElement.NO_SOURCE;
    static final StorageManager STORAGE = LockBasedStorageManager.NO_LOCKS;
    static DefaultBuiltIns builtins;
    interface Op { Object run() throws Throwable; }
    static String outcome(Op op) {
        try { return String.valueOf(op.run()); }
        catch (Throwable failure) { return failure.getClass().getName(); }
    }
    static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static void record(String name, Object... values) {
        StringJoiner line = new StringJoiner(":", "record:" + name + ":", "");
        for (Object value : values) line.add(String.valueOf(value)); System.out.println(line);
    }
    static final class Lazy extends AbstractLazyTypeParameterDescriptor {
        int boundsReads, varianceReads, reifiedReads, nameReads;
        final Variance variance;
        final boolean reified;
        Lazy(Variance variance, boolean reified) {
            super(STORAGE, builtins.getBuiltInsModule(), A, Name.identifier("LazyT"), variance, reified, 7, S, SupertypeLoopChecker.EMPTY.INSTANCE);
            this.variance = variance; this.reified = reified;
        }
        @Override public Variance getVariance() { varianceReads++; return variance; }
        @Override public boolean isReified() { reifiedReads++; return reified; }
        @Override public Name getName() { nameReads++; return super.getName(); }
        @Override protected List<KotlinType> resolveUpperBounds() { boundsReads++; return Collections.singletonList(builtins.getAnyType()); }
        @Override protected void reportSupertypeLoopError(KotlinType type) { throw new AssertionError("Unexpected type-parameter cycle"); }
    }
    static class Mutable extends MutableClassDescriptor {
        int modalitySets, visibilitySets, constructorsReads, defaultTypeReads;
        Set<ClassConstructorDescriptor> constructors = Collections.emptySet();
        Mutable(String name) {
            super(builtins.getBuiltInsModule(), ClassKind.CLASS, true, true, Name.identifier(name), S, STORAGE);
        }
        @Override public void setModality(Modality modality) { modalitySets++; super.setModality(modality); }
        @Override public void setVisibility(DescriptorVisibility visibility) { visibilitySets++; super.setVisibility(visibility); }
        @Override public Set<ClassConstructorDescriptor> getConstructors() { constructorsReads++; return constructors; }
        @Override public SimpleType getDefaultType() { defaultTypeReads++; return super.getDefaultType(); }
    }
    static Mutable initialized(String name, List<TypeParameterDescriptor> parameters) {
        Mutable value = new Mutable(name); value.setModality(Modality.OPEN); value.setVisibility(DescriptorVisibilities.PUBLIC);
        value.setTypeParameterDescriptors(parameters); return value;
    }
    static String typeNames(Collection<KotlinType> types) {
        List<String> names = new ArrayList<>();
        for (KotlinType type : types) names.add(type.getConstructor().getDeclarationDescriptor().getName().asString());
        return String.join(",", names);
    }
    static void observe() {
        builtins = DefaultBuiltIns.Companion.getInstance();
        for (Variance variance : Variance.values()) for (boolean reified : new boolean[] { false, true }) {
            Lazy value = new Lazy(variance, reified);
            String text = value.toString();
            record("lazy-text-" + variance.name() + "-" + reified, text, value.boundsReads, value.reifiedReads, value.varianceReads, value.nameReads);
            require(value.boundsReads == 0, "Lazy text forced bounds");
            require(value.varianceReads == (variance == Variance.INVARIANT ? 1 : 2), "Variance evaluation order changed");
            record("lazy-forwarding-" + variance.name() + "-" + reified, value.getContainingDeclaration() == builtins.getBuiltInsModule(),
                value.getIndex(), value.getSource() == S, value.getStorageManager() == STORAGE, value.getAnnotations() == A);
        }
        Lazy lazy = new Lazy(Variance.INVARIANT, false);
        List<KotlinType> first = lazy.getUpperBounds(); List<KotlinType> second = lazy.getUpperBounds();
        record("lazy-bounds", typeNames(first), first == second, lazy.boundsReads, lazy.getOriginal() == lazy);
        SimpleType defaultType = lazy.getDefaultType();
        record("lazy-default", defaultType == lazy.getDefaultType(), defaultType.getConstructor().getDeclarationDescriptor() == lazy, lazy.boundsReads);

        // Builtins instantiates the freshly compiled complete DeserializedTypeParameterDescriptor.
        TypeParameterDescriptor deserialized = builtins.getList().getDeclaredTypeParameters().get(0);
        require(deserialized.getClass().getName().equals("org.jetbrains.kotlin.serialization.deserialization.descriptors.DeserializedTypeParameterDescriptor"), "Genuine deserialization consumer missing");
        record("real-deserialized-parameter", deserialized.getName().asString(), deserialized.getVariance(), deserialized.toString(),
            deserialized.getUpperBounds().size(), deserialized.getDefaultType().getConstructor().getDeclarationDescriptor() == deserialized);

        Mutable value = initialized("MutableT", Collections.emptyList());
        record("mutable-flags", value.getKind(), value.isInner(), value.isExternal(), value.isData(), value.isInline(), value.isFun(), value.isValue(),
            value.isCompanionObject(), value.isExpect(), value.isActual());
        record("mutable-basic", value.getModality(), value.getVisibility().getInternalDisplayName(), value.modalitySets, value.visibilitySets,
            value.getAnnotations() == A, value.getCompanionObjectDescriptor() == null, value.getUnsubstitutedPrimaryConstructor() == null,
            value.getSealedSubclasses().isEmpty(), value.getValueClassRepresentation() == null);
        value.addSupertype(builtins.getAnyType()); value.addSupertype(lazy.getDefaultType());
        value.createTypeConstructor();
        record("mutable-supertype-filter", typeNames(value.getTypeConstructor().getSupertypes()), value.getTypeConstructor().getDeclarationDescriptor() == value,
            value.getTypeConstructor().isDenotable(), value.constructorsReads);
        record("mutable-scopes", value.getUnsubstitutedMemberScope(KotlinTypeRefiner.Default.INSTANCE) == MemberScope.Empty.INSTANCE,
            value.getUnsubstitutedMemberScope() == MemberScope.Empty.INSTANCE, value.getStaticScope() == MemberScope.Empty.INSTANCE);
        record("mutable-default", value.getDefaultType() == value.getDefaultType(), value.getDefaultType().getConstructor() == value.getTypeConstructor(),
            value.getThisAsReceiverParameter().getType().getConstructor() == value.getTypeConstructor());

        ArrayList<TypeParameterDescriptor> carrier = new ArrayList<>(); carrier.add(lazy);
        Mutable copied = initialized("Copied", carrier); carrier.clear();
        record("mutable-parameter-copy", copied.getDeclaredTypeParameters().size(), copied.getDeclaredTypeParameters().get(0) == lazy,
            outcome(() -> { copied.setTypeParameterDescriptors(Collections.emptyList()); return "accepted"; }));
        copied.addSupertype(builtins.getAnyType()); copied.createTypeConstructor();
        copied.addSupertype(builtins.getStringType());
        record("mutable-live-supertype-before-lazy", typeNames(copied.getTypeConstructor().getSupertypes()), copied.getTypeConstructor().getParameters().size());

        Mutable constructorOwner = initialized("WithConstructor", Collections.emptyList());
        constructorOwner.addSupertype(builtins.getAnyType());
        ClassConstructorDescriptorImpl constructor = ClassConstructorDescriptorImpl.create(constructorOwner, A, true, S);
        constructor.initialize(Collections.emptyList(), DescriptorVisibilities.PUBLIC);
        constructorOwner.constructors = Collections.singleton(constructor);
        constructorOwner.createTypeConstructor();
        record("mutable-virtual-constructor-loop", constructorOwner.constructorsReads, constructorOwner.defaultTypeReads,
            constructor.getReturnType() == constructorOwner.getDefaultType(), constructor.getReturnType().getConstructor() == constructorOwner.getTypeConstructor());

        ClassDescriptor continuation = org.jetbrains.kotlin.builtins.SuspendFunctionTypesKt.getFAKE_CONTINUATION_CLASS_DESCRIPTOR();
        record("real-suspend-function-consumer", continuation.getName().asString(), continuation.getModality(), continuation.getVisibility().getInternalDisplayName(),
            continuation.getDeclaredTypeParameters().size(), continuation.getDeclaredTypeParameters().get(0).getVariance(),
            continuation.getTypeConstructor().getDeclarationDescriptor() == continuation);
        record("mutable-assertions", outcome(() -> { new MutableClassDescriptor(builtins.getBuiltInsModule(), ClassKind.OBJECT, false, false, Name.identifier("Object"), S, STORAGE); return "accepted"; }),
            outcome(() -> { value.setModality(Modality.SEALED); return "accepted"; }),
            outcome(() -> { value.createTypeConstructor(); return "accepted"; }),
            outcome(() -> { value.addSupertype(ErrorUtils.INSTANCE.createErrorType(ErrorTypeKind.CYCLIC_UPPER_BOUNDS, new String[0])); return "accepted"; }));
        Mutable cold = new Mutable("Cold");
        System.out.println("boundary:raw-nonnull-before-initialization:" + outcome(cold::getModality) + ":" + outcome(cold::getVisibility) + ":" + outcome(cold::getTypeConstructor) + ":" + outcome(cold::getDeclaredTypeParameters));
        try { value.setModality(Modality.SEALED); }
        catch (AssertionError failure) { System.out.println("boundary:host-specific-class-diagnostic:" + failure.getMessage()); }
    }
    public static void main(String[] args) {
        DescriptorDebugHost host = new DescriptorDebugHost() {
            @Override public String classSimpleName(DeclarationDescriptor descriptor) { return descriptor.getClass().getSimpleName(); }
            @Override public int identityHashCode(DeclarationDescriptor descriptor) { return System.identityHashCode(descriptor); }
        };
        DescriptorDebugHostContext.INSTANCE.withHost(host, () -> { observe(); return null; });
    }
}
