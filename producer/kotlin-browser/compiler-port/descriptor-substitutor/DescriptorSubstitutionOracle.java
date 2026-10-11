package descriptorsubstitutionproof;

import java.util.*;
import kotlin.Unit;
import kotlin.jvm.functions.Function1;
import org.jetbrains.kotlin.builtins.DefaultBuiltIns;
import org.jetbrains.kotlin.descriptors.*;
import org.jetbrains.kotlin.descriptors.annotations.Annotations;
import org.jetbrains.kotlin.descriptors.impl.*;
import org.jetbrains.kotlin.name.Name;
import org.jetbrains.kotlin.storage.LockBasedStorageManager;
import org.jetbrains.kotlin.types.*;
import org.jetbrains.kotlin.types.error.ErrorTypeKind;
import org.jetbrains.kotlin.types.error.ErrorUtils;
import org.jetbrains.kotlin.portable.descriptorbases.*;

/** Identical observer of genuine original Java and complete common classes. */
public final class DescriptorSubstitutionOracle {
    static final Annotations A = Annotations.Companion.getEMPTY();
    static DefaultBuiltIns builtins;
    static ModuleDescriptor owner;
    static KotlinType intType, stringType;
    interface Op { Object run() throws Throwable; }
    static String outcome(Op op) {
        try { return String.valueOf(op.run()); }
        catch (Throwable error) { return error.getClass().getName() + "/" + error.getMessage(); }
    }
    static void record(String name, Object... values) {
        StringJoiner row = new StringJoiner(":", "record:" + name + ":", "");
        for (Object value : values) row.add(String.valueOf(value));
        System.out.println(row);
    }
    static TypeParameterDescriptorImpl raw(String name, int index) {
        return TypeParameterDescriptorImpl.createForFurtherModification(owner, A, true, Variance.OUT_VARIANCE,
            Name.identifier(name), index, SourceElement.NO_SOURCE, LockBasedStorageManager.NO_LOCKS);
    }
    static TypeParameterDescriptorImpl parameter(String name, int index, KotlinType... bounds) {
        TypeParameterDescriptorImpl result = raw(name, index);
        for (KotlinType bound : bounds) result.addUpperBound(bound);
        result.setInitialized();
        return result;
    }
    static final class TracingSubstitution extends TypeSubstitution {
        int approximations;
        @Override public TypeProjection get(KotlinType key) { return null; }
        @Override public boolean approximateCapturedTypes() { approximations++; return true; }
    }
    static void run() {
        builtins = DefaultBuiltIns.getInstance(); owner = builtins.getBuiltInsModule();
        intType = builtins.getIntType(); stringType = builtins.getStringType();
        TypeParameterDescriptorImpl pending = raw("Pending", 9);
        TypeConstructor constructor = pending.getTypeConstructor();
        SimpleType pendingDefault = pending.getDefaultType();
        record("lazy-before-initialization", pending.isInitialized(), constructor == pending.getTypeConstructor(),
            pendingDefault == pending.getDefaultType(), pendingDefault.getConstructor() == constructor);
        TypeParameterDescriptorImpl uninitialized = raw("Uninitialized", 0);
        record("uninitialized-upper-bounds", outcome(uninitialized::getUpperBounds));
        uninitialized.setInitialized();
        record("cached-initialization-failure", outcome(uninitialized::getUpperBounds));
        pending.addUpperBound(intType); pending.addUpperBound(intType);
        pending.addUpperBound(ErrorUtils.createErrorType(ErrorTypeKind.UNRESOLVED_TYPE, "Missing"));
        pending.addDefaultUpperBound(); pending.setInitialized();
        record("metadata", pending.getName(), pending.getIndex(), pending.getVariance(), pending.isReified(),
            pending.getOriginal() == pending, pending.getContainingDeclaration() == owner,
            pending.getSource() == SourceElement.NO_SOURCE, pending.getStorageManager() == LockBasedStorageManager.NO_LOCKS,
            pending.isCapturedFromOuterDeclaration());
        record("upper-bounds", pending.getUpperBounds().size(), pending.getUpperBounds().get(0) == intType,
            pending.getUpperBounds().get(1) == intType, pending.getUpperBounds() == pending.getUpperBounds());
        record("mutation-after-initialization", outcome(() -> { pending.addUpperBound(stringType); return null; }),
            outcome(() -> { pending.addDefaultUpperBound(); return null; }), outcome(() -> { pending.setInitialized(); return null; }));
        record("constructor-metadata", constructor.getDeclarationDescriptor() == pending, constructor.getParameters().size(),
            constructor.isDenotable(), constructor.isFinal(), constructor.getBuiltIns() == builtins, constructor.toString());
        final int[] visits = {0};
        String visited = pending.accept(new DeclarationDescriptorVisitorEmptyBodies<String, Integer>() {
            @Override public String visitTypeParameterDescriptor(TypeParameterDescriptor d, Integer value) {
                visits[0]++; return (d == pending) + "/" + value;
            }
        }, 3);
        record("visitor", visited, visits[0]);
        TypeParameterDescriptorImpl empty = raw("Empty", 0); empty.setInitialized();
        record("empty-upper-bounds-cycle-type", empty.getUpperBounds().size(), KotlinTypeKt.isError(empty.getUpperBounds().get(0)));
        TypeParameterDescriptorImpl defaulted = raw("Defaulted", 1); defaulted.addDefaultUpperBound(); defaulted.addDefaultUpperBound(); defaulted.setInitialized();
        TypeParameterDescriptor factory = TypeParameterDescriptorImpl.createWithDefaultBound(owner, A, false,
            Variance.INVARIANT, Name.identifier("Factory"), 4, LockBasedStorageManager.NO_LOCKS);
        record("default-upper-bound", defaulted.getUpperBounds().size(), defaulted.getUpperBounds().get(0) == builtins.getDefaultBound(),
            factory.getUpperBounds().get(0) == builtins.getDefaultBound(), factory.getIndex(), factory.isReified(), factory.getVariance());

        List<TypeParameterDescriptor> result = new ArrayList<>(); result.add(pending);
        boolean[] noChange = {false};
        TypeParameterDescriptorImpl first = parameter("First", 7, intType);
        TypeParameterDescriptorImpl second = parameter("Second", 2, first.getDefaultType());
        TypeSubstitutor plain = DescriptorSubstitutor.substituteTypeParameters(Arrays.asList(first, second), TypeSubstitution.EMPTY, owner, result, noChange);
        TypeParameterDescriptor newFirst = result.get(1), newSecond = result.get(2);
        record("two-pass-copy", result.size(), result.get(0) == pending, newFirst.getIndex(), newSecond.getIndex(),
            newFirst.getName(), newSecond.getName(), newFirst.getUpperBounds().get(0) == intType,
            newSecond.getUpperBounds().get(0).getConstructor() == newFirst.getTypeConstructor(), noChange[0],
            plain.substitute(first.getDefaultType(), Variance.OUT_VARIANCE).getConstructor() == newFirst.getTypeConstructor());
        boolean[] unchanged = {true};
        List<TypeParameterDescriptor> simpleResult = new ArrayList<>();
        DescriptorSubstitutor.substituteTypeParameters(Collections.singletonList(first), TypeSubstitution.EMPTY, owner, simpleResult, unchanged);
        record("change-flag-never-cleared", unchanged[0]);
        List<TypeParameterDescriptor> zeroResult = new ArrayList<>();
        record("empty-substitution", DescriptorSubstitutor.substituteTypeParameters(Collections.emptyList(), TypeSubstitution.EMPTY, owner, zeroResult).isEmpty(), zeroResult.size());
        TypeSubstitution replacement = TypeConstructorSubstitution.createByConstructorsMap(Collections.singletonMap(intType.getConstructor(), new TypeProjectionImpl(stringType)));
        boolean[] changed = {false};
        List<TypeParameterDescriptor> changedResult = new ArrayList<>();
        DescriptorSubstitutor.substituteTypeParameters(Collections.singletonList(first), replacement, owner, changedResult, changed);
        record("bound-substitution", changed[0], changedResult.get(0).getUpperBounds().get(0) == stringType,
            changedResult.get(0).isReified(), changedResult.get(0).getVariance(), changedResult.get(0).getAnnotations() == first.getAnnotations());
        TracingSubstitution nonRecursiveTrace = new TracingSubstitution();
        DescriptorSubstitutor.substituteTypeParameters(Collections.singletonList(first), nonRecursiveTrace, owner, new ArrayList<>(), null);
        TypeParameterDescriptorImpl recursive = raw("Recursive", 0);
        recursive.addUpperBound(recursive.getDefaultType()); recursive.setInitialized();
        TracingSubstitution recursiveTrace = new TracingSubstitution();
        List<TypeParameterDescriptor> recursiveResult = new ArrayList<>();
        DescriptorSubstitutor.substituteTypeParameters(Collections.singletonList(recursive), recursiveTrace, owner, recursiveResult, null);
        record("recursive-approximation-choice", nonRecursiveTrace.approximations, recursiveTrace.approximations,
            recursiveResult.get(0).getUpperBounds().get(0).getConstructor() == recursiveResult.get(0).getTypeConstructor());
        SimpleType conflicting = KotlinTypeFactory.simpleType(TypeAttributes.Companion.getEmpty(), builtins.getMutableList().getTypeConstructor(),
            Collections.singletonList(new TypeProjectionImpl(Variance.IN_VARIANCE, intType)), false);
        TypeParameterDescriptorImpl failing = parameter("Failing", 0, intType, conflicting);
        TypeSubstitution incompatible = TypeConstructorSubstitution.createByConstructorsMap(Collections.singletonMap(intType.getConstructor(), new TypeProjectionImpl(Variance.OUT_VARIANCE, stringType)));
        boolean[] partialChanges = {false}; List<TypeParameterDescriptor> partial = new ArrayList<>();
        TypeSubstitutor failed = DescriptorSubstitutor.substituteTypeParameters(Collections.singletonList(failing), incompatible, owner, partial, partialChanges);
        record("nullable-failure-partial-state", failed == null, partial.size(), partialChanges[0], ((TypeParameterDescriptorImpl) partial.get(0)).isInitialized());
        record("non-null-overload-failure", outcome(() -> DescriptorSubstitutor.substituteTypeParameters(Collections.singletonList(failing), incompatible, owner, new ArrayList<>())));
        final int[] cycleReports = {0};
        SupertypeLoopChecker loopChecker = new SupertypeLoopChecker() {
            @Override public Collection<KotlinType> findLoopsInSupertypesAndDisconnect(TypeConstructor current, Collection<? extends KotlinType> bounds,
                Function1<? super TypeConstructor, ? extends Iterable<? extends KotlinType>> neighbors, Function1<? super KotlinType, Unit> report) {
                for (KotlinType bound : bounds) report.invoke(bound);
                return Collections.emptyList();
            }
        };
        TypeParameterDescriptorImpl cycle = TypeParameterDescriptorImpl.createForFurtherModification(owner, A, false, Variance.INVARIANT,
            Name.identifier("Cycle"), 0, SourceElement.NO_SOURCE, type -> { cycleReports[0]++; return null; }, loopChecker, LockBasedStorageManager.NO_LOCKS);
        cycle.addUpperBound(intType); cycle.setInitialized();
        record("cycle-callback-and-default", cycle.getUpperBounds().size(), cycleReports[0], KotlinTypeKt.isError(cycle.getUpperBounds().get(0)),
            cycle.getUpperBounds() == cycle.getUpperBounds(), cycleReports[0]);
        List<TypeParameterDescriptor> duplicateResult = new ArrayList<>();
        String duplicateOutcome = outcome(() -> DescriptorSubstitutor.substituteTypeParameters(Arrays.asList(first, first), TypeSubstitution.EMPTY, owner, duplicateResult, null));
        record("duplicate-descriptor-map", duplicateOutcome, duplicateResult.size(), ((TypeParameterDescriptorImpl) duplicateResult.get(0)).isInitialized(),
            ((TypeParameterDescriptorImpl) duplicateResult.get(1)).isInitialized());
    }
    public static void main(String[] args) {
        DescriptorDebugHost host = new DescriptorDebugHost() {
            public String classSimpleName(DeclarationDescriptor d) { return d.getClass().getSimpleName(); }
            public int identityHashCode(DeclarationDescriptor d) { return System.identityHashCode(d); }
        };
        DescriptorDebugHostContext.INSTANCE.withHost(host, () -> { run(); return null; });
    }
}
