package descriptorfunctionproof;

import java.util.*;
import org.jetbrains.kotlin.builtins.DefaultBuiltIns;
import org.jetbrains.kotlin.descriptors.*;
import org.jetbrains.kotlin.descriptors.CallableDescriptor.UserDataKey;
import org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind;
import org.jetbrains.kotlin.descriptors.annotations.Annotations;
import org.jetbrains.kotlin.descriptors.impl.*;
import org.jetbrains.kotlin.name.Name;
import org.jetbrains.kotlin.resolve.DescriptorFactory;
import org.jetbrains.kotlin.resolve.scopes.receivers.ExtensionReceiver;
import org.jetbrains.kotlin.types.*;
import org.jetbrains.kotlin.portable.descriptorbases.*;

/** The same compiled Java observer runs against fresh full Java and common classes.
 * Every descriptor, type, parameter and receiver is the genuine implementation. */
public final class FunctionOracle {
    static final Annotations A = Annotations.Companion.getEMPTY();
    static DefaultBuiltIns builtins;
    static ModuleDescriptor module;
    static KotlinType intType, stringType;
    static final UserDataKey<String> K1 = new UserDataKey<String>() {};
    static final UserDataKey<String> K2 = new UserDataKey<String>() {};
    static final SourceElement SOURCE = new SourceElement() {
        public SourceFile getContainingFile() { return SourceFile.NO_SOURCE_FILE; }
        public String toString() { return "function-source"; }
    };
    interface Op { Object run() throws Throwable; }
    static String result(Op action) {
        try { Object v = action.run(); return v == null ? "null" : String.valueOf(v); }
        catch (Throwable e) { return e.getClass().getName(); }
    }
    static void record(String name, Object... values) {
        StringJoiner line = new StringJoiner(":", "record:" + name + ":", "");
        for (Object value : values) line.add(String.valueOf(value));
        System.out.println(line);
    }
    static SimpleFunctionDescriptorImpl raw(String name) {
        return SimpleFunctionDescriptorImpl.create(module, A, Name.identifier(name), Kind.DECLARATION, SOURCE);
    }
    static SimpleFunctionDescriptorImpl function(String name) {
        return raw(name).initialize(null, null, Collections.emptyList(), Collections.emptyList(), Collections.emptyList(), intType, Modality.OPEN, DescriptorVisibilities.PUBLIC);
    }
    static ValueParameterDescriptorImpl parameter(FunctionDescriptor owner, int index, KotlinType type, KotlinType vararg) {
        return new ValueParameterDescriptorImpl(owner, null, index, A, Name.identifier("p" + index), type, true, true, true, vararg, SOURCE);
    }
    static TypeSubstitution substitution() {
        return TypeConstructorSubstitution.createByConstructorsMap(Collections.singletonMap(intType.getConstructor(), new TypeProjectionImpl(stringType)));
    }
    static final class Counting extends SimpleFunctionDescriptorImpl {
        int substitutions, copies;
        boolean returnNull;
        Counting(String name) { super(module, null, A, Name.identifier(name), Kind.DECLARATION, SOURCE);
            initialize(null, null, Collections.emptyList(), Collections.emptyList(), Collections.emptyList(), intType, Modality.OPEN, DescriptorVisibilities.PUBLIC); }
        @Override public FunctionDescriptor substitute(TypeSubstitutor s) { substitutions++; return returnNull ? null : super.substitute(s); }
        @Override protected FunctionDescriptorImpl createSubstitutedCopy(DeclarationDescriptor owner, FunctionDescriptor original, Kind kind, Name name, Annotations a, SourceElement source) {
            copies++; return super.createSubstitutedCopy(owner, original, kind, name, a, source);
        }
        Map<UserDataKey<?>, Object> data() { return userDataMap; }
    }
    static void run() {
        builtins = DefaultBuiltIns.getInstance(); module = builtins.getBuiltInsModule(); intType = builtins.getIntType(); stringType = builtins.getStringType();
        SimpleFunctionDescriptorImpl f = function("original");
        record("identity", f.getOriginal() == f, f.getContainingDeclaration() == module, f.getSource() == SOURCE, f.getReturnType() == intType, f.substitute(TypeSubstitutor.EMPTY) == f);
        record("defaults", f.getKind(), f.getModality(), f.getVisibility() == DescriptorVisibilities.PUBLIC, f.getTypeParameters().size(), f.getValueParameters().size(), f.getContextReceiverParameters().size(), f.getOverriddenDescriptors().size(), f.getInitialSignatureDescriptor(), f.hasStableParameterNames(), f.hasSynthesizedParameterNames());
        f.setOperator(true); f.setInfix(true); f.setInline(true); f.setExternal(true); f.setTailrec(true); f.setSuspend(true); f.setExpect(true); f.setActual(true);
        f.setHasStableParameterNames(false); f.setHasSynthesizedParameterNames(true);
        FunctionDescriptor copy = f.copy(module, Modality.FINAL, DescriptorVisibilities.PRIVATE, Kind.SYNTHESIZED, false);
        record("copy-flags", copy != f, copy.getOriginal() == copy, copy.getSource() == SourceElement.NO_SOURCE, copy.getKind(), copy.getModality(), copy.getVisibility() == DescriptorVisibilities.PRIVATE,
            copy.isOperator(), copy.isInfix(), copy.isInline(), copy.isExternal(), copy.isTailrec(), copy.isSuspend(), copy.isExpect(), copy.isActual(), copy.hasStableParameterNames(), copy.hasSynthesizedParameterNames());
        FunctionDescriptor renamed = f.newCopyBuilder().setName(Name.identifier("renamed")).setOriginal(f).setPreserveSourceElement().build();
        record("renamed", renamed.getName(), renamed.getOriginal() == f, renamed.getSource() == SOURCE);
        FunctionDescriptor hidden = f.newCopyBuilder().setHiddenToOvercomeSignatureClash().setHiddenForResolutionEverywhereBesideSupercalls().build();
        SimpleFunctionDescriptorImpl overriding = function("overriding"); overriding.setOverriddenDescriptors(Collections.singletonList(hidden));
        record("hidden", hidden.isHiddenToOvercomeSignatureClash(), hidden.isHiddenForResolutionEverywhereBesideSupercalls(), overriding.isHiddenToOvercomeSignatureClash(), overriding.isHiddenForResolutionEverywhereBesideSupercalls(), overriding.isOperator(), overriding.isInfix());
        record("hidden-copy", overriding.newCopyBuilder().build().isHiddenForResolutionEverywhereBesideSupercalls());
        f.setReturnType(stringType); f.setVisibility(DescriptorVisibilities.INTERNAL);
        record("setters", f.getReturnType() == stringType, f.getVisibility() == DescriptorVisibilities.INTERNAL);
        final int[] visits = {0};
        String answer = f.accept(new DeclarationDescriptorVisitorEmptyBodies<String, Integer>() {
            @Override public String visitFunctionDescriptor(FunctionDescriptor d, Integer n) { visits[0]++; return (d == f) + "/" + n; }
        }, 19);
        record("visitor", answer, visits[0], result(() -> f.accept(null, 0)));
        List<TypeParameterDescriptor> tp = new ArrayList<>();
        List<ValueParameterDescriptor> vp = new ArrayList<>();
        List<ReceiverParameterDescriptor> contexts = new ArrayList<>();
        SimpleFunctionDescriptorImpl storage = raw("storage");
        ValueParameterDescriptor p = parameter(storage, 0, intType, intType); vp.add(p);
        storage.initialize(null, null, contexts, tp, vp, intType, Modality.FINAL, DescriptorVisibilities.PUBLIC);
        vp.clear(); tp.clear(); contexts.add(DescriptorFactory.createContextReceiverParameterForCallable(storage, intType, Name.identifier("ctx"), A, 0));
        record("storage", storage.getValueParameters().size(), storage.getContextReceiverParameters() == contexts, storage.getContextReceiverParameters().size());
        SimpleFunctionDescriptorImpl wrong = raw("wrong");
        record("wrong-value-index", result(() -> wrong.initialize(null, null, Collections.emptyList(), Collections.emptyList(), Collections.singletonList(parameter(wrong, 2, intType, null)), intType, Modality.FINAL, DescriptorVisibilities.PUBLIC)));
        TypeParameterDescriptor wrongType = TypeParameterDescriptorImpl.createWithDefaultBound(wrong, A, false, Variance.INVARIANT, Name.identifier("T"), 2, org.jetbrains.kotlin.storage.LockBasedStorageManager.NO_LOCKS);
        record("wrong-type-index", result(() -> wrong.initialize(null, null, Collections.emptyList(), Collections.singletonList(wrongType), Collections.emptyList(), intType, Modality.FINAL, DescriptorVisibilities.PUBLIC)));
        f.putInUserDataMap(K1, "old"); f.putInUserDataMap(null, "null-key");
        FunctionDescriptor data = f.newCopyBuilder().putUserData(K1, "new").putUserData(K2, null).build();
        record("data-merge", data.getUserData(K1), data.getUserData(K2), data.getUserData(null), f.getUserData(K1));
        SimpleFunctionDescriptorImpl one = function("one"); one.putInUserDataMap(K1, "value");
        SimpleFunctionDescriptorImpl single = (SimpleFunctionDescriptorImpl) one.newCopyBuilder().build();
        record("single-map-put", single.getUserData(K1), result(() -> { single.putInUserDataMap(K1, "changed"); return null; }), single.getUserData(K1));
        SimpleFunctionDescriptorImpl many = (SimpleFunctionDescriptorImpl) one.newCopyBuilder().putUserData(K2, "v2").build(); many.putInUserDataMap(K1, "changed");
        record("many-map-put", many.getUserData(K1), many.getUserData(K2));
        Map<UserDataKey<?>, Object> initial = new LinkedHashMap<>(); initial.put(K1, "initial");
        SimpleFunctionDescriptorImpl initialized = raw("dataInit").initialize(null, null, Collections.emptyList(), Collections.emptyList(), Collections.emptyList(), intType, Modality.OPEN, DescriptorVisibilities.PUBLIC, initial);
        initial.put(K1, "mutated"); initialized.initialize(null, null, Collections.emptyList(), Collections.emptyList(), Collections.emptyList(), intType, Modality.OPEN, DescriptorVisibilities.PUBLIC, Collections.emptyMap());
        record("initialize-map-copy-and-empty-preserve", initialized.getUserData(K1));
        TypeSubstitutor substitutor = TypeSubstitutor.create(substitution());
        FunctionDescriptor substituted = storage.substitute(substitutor);
        record("substitution", substituted != storage, substituted.getOriginal() == storage, substituted.getSource() == SOURCE,
            substituted.getReturnType() == stringType, substituted.getValueParameters().get(0).getType() == stringType,
            substituted.getValueParameters().get(0).getVarargElementType() == stringType,
            substituted.getContextReceiverParameters().get(0).getType() == stringType);
        ValueParameterDescriptor pv = substituted.getValueParameters().get(0);
        record("parameter-flags", pv.getOriginal() == p, pv.getContainingDeclaration() == substituted, pv.getIndex(), pv.getName(), pv.declaresDefaultValue(), pv.isCrossinline(), pv.isNoinline(), pv.getSource() == SOURCE);
        List<ValueParameterDescriptor> ordinary = FunctionDescriptorImpl.getSubstitutedValueParameters(f, storage.getValueParameters(), TypeSubstitutor.EMPTY);
        boolean[] changed = {false};
        List<ValueParameterDescriptor> dropped = FunctionDescriptorImpl.getSubstitutedValueParameters(f, storage.getValueParameters(), substitutor, true, true, changed);
        record("static-parameters", ordinary.get(0).getOriginal() == p, ordinary.get(0).getSource() == SourceElement.NO_SOURCE,
            dropped.get(0).getOriginal() == dropped.get(0), dropped.get(0).getSource() == SOURCE, changed[0]);
        Counting noChange = new Counting("noChange"); noChange.setReturnType(stringType);
        record("unchanged-substitute", noChange.substitute(substitutor) == noChange, noChange.copies);
        Counting base = new Counting("base");
        SimpleFunctionDescriptorImpl lazy = function("lazy"); lazy.setOverriddenDescriptors(Collections.singletonList(base));
        FunctionDescriptor delayed = lazy.newCopyBuilder().setSubstitution(substitution()).build();
        record("lazy-before", base.substitutions);
        Collection<? extends FunctionDescriptor> first = delayed.getOverriddenDescriptors();
        record("lazy-after", base.substitutions, first.size(), first == delayed.getOverriddenDescriptors(), base.substitutions, first.iterator().next().getReturnType() == stringType);
        Counting nullBase = new Counting("nullBase"); nullBase.returnNull = true;
        SimpleFunctionDescriptorImpl nullableLazy = function("nullableLazy"); nullableLazy.setOverriddenDescriptors(Collections.singletonList(nullBase));
        FunctionDescriptor nullableCopy = nullableLazy.newCopyBuilder().setSubstitution(substitution()).build();
        record("lazy-null-element", nullableCopy.getOverriddenDescriptors().iterator().next() == null, nullBase.substitutions);
        FunctionDescriptor signature = storage.newCopyBuilder().setSignatureChange().build();
        record("initial-signature", signature.getInitialSignatureDescriptor() == storage);
        SimpleFunctionDescriptorImpl receiver = function("receiver");
        ReceiverParameterDescriptor extension = new ReceiverParameterDescriptorImpl(receiver, new ExtensionReceiver(receiver, intType, null), A);
        receiver.setExtensionReceiverParameter(extension);
        FunctionDescriptor receiverCopy = receiver.substitute(substitutor);
        record("extension", receiverCopy.getExtensionReceiverParameter().getType() == stringType,
            receiverCopy.getExtensionReceiverParameter().getContainingDeclaration() == receiverCopy);
        final int[] destructuringCalls = {0};
        List<VariableDescriptor> variables = Collections.singletonList(parameter(receiver, 0, stringType, null));
        ValueParameterDescriptor destructuring = ValueParameterDescriptorImpl.createWithDestructuringDeclarations(receiver, null, 0, A,
            Name.identifier("tuple"), intType, false, false, false, null, SOURCE, () -> { destructuringCalls[0]++; return variables; });
        record("destructuring-lazy-before", destructuringCalls[0]);
        List<ValueParameterDescriptor> ds = FunctionDescriptorImpl.getSubstitutedValueParameters(f, Collections.singletonList(destructuring), substitutor);
        record("destructuring-evaluated-on-copy", destructuringCalls[0], ds.get(0) instanceof ValueParameterDescriptorImpl.WithDestructuringDeclaration);
        record("destructuring-captured-list", ValueParameterDescriptorImpl.getDestructuringVariablesOrNull(ds.get(0)) == variables,
            ValueParameterDescriptorImpl.getDestructuringVariablesOrNull(ds.get(0)) == variables, destructuringCalls[0]);
        ReceiverParameterDescriptor dispatch = builtins.getString().getThisAsReceiverParameter();
        FunctionDescriptor dispatchCopy = receiver.newCopyBuilder().setDispatchReceiverParameter(dispatch).build();
        record("dispatch-preserved", dispatchCopy.getDispatchReceiverParameter() == dispatch, dispatchCopy.getDispatchReceiverParameter().getType() == dispatch.getType());
        TypeSubstitutor incompatible = TypeSubstitutor.create(TypeConstructorSubstitution.createByConstructorsMap(
            Collections.singletonMap(intType.getConstructor(), new TypeProjectionImpl(Variance.OUT_VARIANCE, stringType))));
        record("parameter-substitution-failure", FunctionDescriptorImpl.getSubstitutedValueParameters(f, storage.getValueParameters(), incompatible) == null,
            storage.substitute(incompatible) == null, receiver.substitute(incompatible) == null);
        record("typed-flag-consumer", FlagConsumerKt.assignFlags(function("flags")));
        SimpleFunctionDescriptorImpl deferredReturn = raw("deferredReturn").initialize(null, null, Collections.emptyList(), Collections.emptyList(), Collections.emptyList(), null, Modality.FINAL, DescriptorVisibilities.PUBLIC);
        FunctionDescriptor deferredCopy = deferredReturn.newCopyBuilder().setReturnType(stringType).build();
        record("nullable-return-initialize-then-builder-set", deferredCopy.getReturnType() == stringType, deferredReturn.getReturnType() == null);
        SimpleFunctionDescriptorImpl deferredModality = raw("deferredModality").initialize(null, null, Collections.emptyList(), Collections.emptyList(), Collections.emptyList(), intType, null, DescriptorVisibilities.PUBLIC);
        System.out.println("boundary:initialized-null-modality-builder:" + result(() -> deferredModality.newCopyBuilder().setModality(Modality.FINAL).build().getModality() == Modality.FINAL));
        System.out.println("boundary:initialized-null-modality-copy:" + result(() -> deferredModality.copy(module, Modality.FINAL, DescriptorVisibilities.PUBLIC, Kind.DECLARATION, false).getModality() == Modality.FINAL));
        SimpleFunctionDescriptorImpl pending = raw("pending");
        for (String method : new String[] {"getContextReceiverParameters", "getModality", "getValueParameters", "getReturnType"}) {
            System.out.println("boundary:" + method + ":" + result(() -> { try { return FunctionDescriptorImpl.class.getMethod(method).invoke(pending); } catch (java.lang.reflect.InvocationTargetException e) { throw e.getCause(); } }));
        }
        record("pending-type-parameters", result(pending::getTypeParameters));
    }
    public static void main(String[] args) {
        DescriptorDebugHost host = new DescriptorDebugHost() {
            public String classSimpleName(DeclarationDescriptor d) { return d.getClass().getSimpleName(); }
            public int identityHashCode(DeclarationDescriptor d) { return System.identityHashCode(d); }
        };
        DescriptorDebugHostContext.INSTANCE.withHost(host, () -> { run(); return null; });
    }
}
