package descriptorclassproof;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.*;
import kotlin.jvm.functions.Function0;
import kotlin.jvm.functions.Function1;
import org.jetbrains.kotlin.builtins.DefaultBuiltIns;
import org.jetbrains.kotlin.descriptors.*;
import org.jetbrains.kotlin.descriptors.annotations.Annotations;
import org.jetbrains.kotlin.descriptors.impl.*;
import org.jetbrains.kotlin.incremental.components.LookupLocation;
import org.jetbrains.kotlin.incremental.components.NoLookupLocation;
import org.jetbrains.kotlin.name.Name;
import org.jetbrains.kotlin.name.ClassId;
import org.jetbrains.kotlin.portable.descriptorbases.DescriptorDebugHost;
import org.jetbrains.kotlin.portable.descriptorbases.DescriptorDebugHostContext;
import org.jetbrains.kotlin.resolve.DescriptorFactory;
import org.jetbrains.kotlin.resolve.scopes.*;
import org.jetbrains.kotlin.resolve.scopes.receivers.*;
import org.jetbrains.kotlin.storage.*;
import org.jetbrains.kotlin.types.*;
import org.jetbrains.kotlin.types.checker.KotlinTypeRefiner;
import org.jetbrains.kotlin.types.error.*;
import org.jetbrains.kotlin.types.model.KotlinTypeMarker;
import org.jetbrains.kotlin.utils.Printer;

/** The same observer runs against freshly built genuine Java and common families. */
public final class ClassBehaviorProbe {
    static final Annotations A = Annotations.Companion.getEMPTY();
    static final SourceElement S = SourceElement.NO_SOURCE;
    static final StorageManager STORAGE = LockBasedStorageManager.NO_LOCKS;
    static final KotlinTypeRefiner REFINER = KotlinTypeRefiner.Default.INSTANCE;
    static final LookupLocation LOOKUP = NoLookupLocation.FOR_NON_TRACKED_SCOPE;
    static DefaultBuiltIns builtins;
    interface Op { Object run() throws Throwable; }
    static String result(Op op) {
        try { return String.valueOf(op.run()); }
        catch (Throwable failure) { return failure.getClass().getName(); }
    }
    static void record(String name, Object... values) {
        StringJoiner line = new StringJoiner(":", "record:" + name + ":", "");
        for (Object value : values) line.add(String.valueOf(value));
        System.out.println(line);
    }
    static void require(boolean condition, String reason) { if (!condition) throw new AssertionError(reason); }
    static List<String> names(Collection<? extends DeclarationDescriptor> descriptors) {
        List<String> names = new ArrayList<>();
        for (DeclarationDescriptor descriptor : descriptors) {
            String suffix = descriptor instanceof CallableMemberDescriptor
                ? "/" + ((CallableMemberDescriptor) descriptor).getKind() + "/" + ((CallableMemberDescriptor) descriptor).getVisibility().getInternalDisplayName()
                : "";
            names.add(descriptor.getName().asString() + suffix);
        }
        Collections.sort(names); return names;
    }
    static class Klass extends ClassDescriptorImpl {
        ClassDescriptor companion;
        Klass(DeclarationDescriptor owner, String name, ClassKind kind, Modality modality) {
            super(owner, Name.identifier(name), modality, kind, Collections.singletonList(builtins.getAnyType()), S, false, STORAGE);
            initialize(MemberScope.Empty.INSTANCE, Collections.emptySet(), null);
        }
        @Override public ClassDescriptor getCompanionObjectDescriptor() { return companion; }
    }
    static final class CountingClass extends Klass {
        final List<String> calls = new ArrayList<>();
        CountingClass(String name) { super(builtins.getBuiltInsModule(), name, ClassKind.CLASS, Modality.OPEN); }
        @Override public TypeConstructor getTypeConstructor() { calls.add("constructor"); return super.getTypeConstructor(); }
        @Override public MemberScope getUnsubstitutedMemberScope(KotlinTypeRefiner refiner) {
            calls.add("scope"); return super.getUnsubstitutedMemberScope(refiner);
        }
        String takeCalls() { String value = String.join(",", calls); calls.clear(); return value; }
    }
    static final class GenericClass extends Klass {
        final List<String> calls = new ArrayList<>();
        final TypeParameterDescriptor parameter;
        final TypeConstructor constructor;
        GenericClass(String name) {
            super(builtins.getBuiltInsModule(), name, ClassKind.CLASS, Modality.OPEN);
            parameter = TypeParameterDescriptorImpl.createWithDefaultBound(this, A, false, Variance.INVARIANT, Name.identifier("T"), 0, STORAGE);
            constructor = new ClassTypeConstructorImpl(this, Collections.singletonList(parameter), Collections.singletonList(builtins.getAnyType()), STORAGE) {
                @Override public List<TypeParameterDescriptor> getParameters() { calls.add("parameters"); return super.getParameters(); }
            };
        }
        @Override public TypeConstructor getTypeConstructor() { calls.add("constructor"); return constructor; }
        @Override public Annotations getAnnotations() { calls.add("annotations"); return super.getAnnotations(); }
        @Override public MemberScope getUnsubstitutedMemberScope(KotlinTypeRefiner refiner) { calls.add("scope"); return super.getUnsubstitutedMemberScope(refiner); }
        @Override public List<TypeParameterDescriptor> getDeclaredTypeParameters() { return Collections.singletonList(parameter); }
    }
    static final class InspectConstructor extends ClassTypeConstructorImpl {
        int declarationReads;
        InspectConstructor(ClassDescriptor descriptor, List<TypeParameterDescriptor> parameters, Collection<KotlinType> supers) {
            super(descriptor, parameters, supers, STORAGE);
        }
        Collection<KotlinType> computed() { return computeSupertypes(); }
        Collection<KotlinType> neighbours(boolean companions) { return getAdditionalNeighboursInSupertypeGraph(companions); }
        KotlinType emptyFallback() { return defaultSupertypeIfEmpty(); }
        boolean sameClassifier(ClassifierDescriptor descriptor) { return isSameClassifier(descriptor); }
        @Override public ClassDescriptor getDeclarationDescriptor() { declarationReads++; return super.getDeclarationDescriptor(); }
    }
    static final class Refiner extends KotlinTypeRefiner {
        final ClassifierDescriptor target;
        final List<String> calls = new ArrayList<>();
        Refiner(ClassifierDescriptor target) { this.target = target; }
        @Override public KotlinType refineType(KotlinTypeMarker type) { calls.add("type"); return (KotlinType) type; }
        @Override public Collection<KotlinType> refineSupertypes(ClassDescriptor descriptor) {
            calls.add("supertypes:" + descriptor.getName()); return descriptor.getTypeConstructor().getSupertypes();
        }
        @Override public ClassifierDescriptor refineDescriptor(DeclarationDescriptor descriptor) {
            calls.add("descriptor:" + descriptor.getName()); return target;
        }
        @Override public ClassDescriptor findClassAcrossModuleDependencies(ClassId id) { return null; }
        @Override public boolean isRefinementNeededForModule(ModuleDescriptor module) { return true; }
        @Override public boolean isRefinementNeededForTypeConstructor(TypeConstructor constructor) { return true; }
        @Override public <M extends MemberScope> M getOrPutScopeForClass(ClassDescriptor descriptor, Function0<? extends M> compute) { return compute.invoke(); }
    }
    static final class RefinedClass extends Klass {
        final MemberScope refinedScope = new Scope();
        final List<KotlinTypeRefiner> scopeRefiners = new ArrayList<>();
        RefinedClass() { super(builtins.getBuiltInsModule(), "RefinedTarget", ClassKind.CLASS, Modality.OPEN); }
        @Override public MemberScope getUnsubstitutedMemberScope(KotlinTypeRefiner refiner) {
            scopeRefiners.add(refiner); return refinedScope;
        }
    }
    // Real initialized bootstrap descriptor; fixture overrides stay outside compiler packages.
    static final class Alias extends AbstractTypeAliasDescriptor {
        SimpleType defaultType;
        Alias() { super(STORAGE, builtins.getBuiltInsModule(), A, Name.identifier("StringAlias"), S, DescriptorVisibilities.PUBLIC); initialize(Collections.emptyList()); }
        @Override public SimpleType getUnderlyingType() { return builtins.getStringType(); }
        @Override public SimpleType getExpandedType() { return builtins.getStringType(); }
        @Override public ClassDescriptor getClassDescriptor() { return builtins.getString(); }
        @Override public SimpleType getDefaultType() { if (defaultType == null) defaultType = computeDefaultType(); return defaultType; }
        @Override protected List<TypeParameterDescriptor> getTypeConstructorTypeParameters() { return Collections.emptyList(); }
        @Override public TypeAliasDescriptor substitute(TypeSubstitutor substitutor) {
            require(substitutor.isEmpty(), "Unused nonempty alias fixture substitution"); return this;
        }
    }
    static final class Scope extends MemberScopeImpl {
        int functionQueries, propertyQueries;
        final Map<Name, Collection<SimpleFunctionDescriptor>> functions = new LinkedHashMap<>();
        final Map<Name, Collection<PropertyDescriptor>> properties = new LinkedHashMap<>();
        @Override public Collection<SimpleFunctionDescriptor> getContributedFunctions(Name name, LookupLocation location) {
            functionQueries++; return functions.getOrDefault(name, Collections.emptyList());
        }
        @Override public Collection<PropertyDescriptor> getContributedVariables(Name name, LookupLocation location) {
            propertyQueries++; return properties.getOrDefault(name, Collections.emptyList());
        }
        @Override public Set<Name> getFunctionNames() { return functions.keySet(); }
        @Override public Set<Name> getVariableNames() { return properties.keySet(); }
        @Override public Set<Name> getClassifierNames() { return Collections.emptySet(); }
        @Override public void printScopeStructure(Printer printer) { printer.println("behavior source scope"); }
    }
    static SimpleFunctionDescriptorImpl function(ClassDescriptor owner, String name, KotlinType returnType) {
        SimpleFunctionDescriptorImpl function = SimpleFunctionDescriptorImpl.create(owner, A, Name.identifier(name), CallableMemberDescriptor.Kind.DECLARATION, S);
        function.initialize(null, owner.getThisAsReceiverParameter(), Collections.emptyList(), Collections.emptyList(), Collections.emptyList(), returnType,
            Modality.OPEN, DescriptorVisibilities.PUBLIC);
        return function;
    }
    static PropertyDescriptorImpl property(ClassDescriptor owner, String name, KotlinType type) {
        PropertyDescriptorImpl property = PropertyDescriptorImpl.create(owner, A, Modality.OPEN, DescriptorVisibilities.PUBLIC, false,
            Name.identifier(name), CallableMemberDescriptor.Kind.DECLARATION, S, false, false, false, false, false, false);
        property.setType(type, Collections.emptyList(), owner.getThisAsReceiverParameter(), null, Collections.emptyList());
        PropertyGetterDescriptorImpl getter = DescriptorFactory.createDefaultGetter(property, A); getter.initialize(null);
        property.initialize(getter, null, null, null); return property;
    }
    static ClassConstructorDescriptorImpl constructor(Klass owner) {
        ClassConstructorDescriptorImpl constructor = ClassConstructorDescriptorImpl.create(owner, A, true, S);
        constructor.initialize(Collections.emptyList(), DescriptorVisibilities.PUBLIC);
        constructor.setReturnType(owner.getDefaultType());
        owner.initialize(owner.getUnsubstitutedMemberScope(REFINER), Collections.singleton(constructor), constructor);
        return constructor;
    }
    static TypeSubstitutor substitution(KotlinType from, KotlinType to) {
        return TypeSubstitutor.create(TypeConstructorSubstitution.createByConstructorsMap(
            Collections.singletonMap(from.getConstructor(), new TypeProjectionImpl(Variance.INVARIANT, to))));
    }
    // The common bridge is invoked as shipped. The original has direct Java package
    // access and uses its public subclass overload. Reflection stays in this observer.
    static MemberScope bridge(CountingClass owner) throws Throwable {
        try {
            Class<?> holder = Class.forName("org.jetbrains.kotlin.descriptors.impl.ModuleAwareClassDescriptorKt");
            Method bridge = holder.getMethod("getClassPortRefinedMemberScope", ModuleAwareClassDescriptor.class, List.class, KotlinTypeRefiner.class);
            try { return (MemberScope) bridge.invoke(null, owner, Collections.emptyList(), REFINER); }
            catch (InvocationTargetException failure) { throw failure.getCause(); }
        } catch (ClassNotFoundException | NoSuchMethodException absentOriginalBridge) {
            return owner.getMemberScope(Collections.emptyList(), REFINER);
        }
    }
    static void basic() throws Throwable {
        CountingClass owner = new CountingClass("Behavior");
        record("class-state", owner.getName(), owner.getKind(), owner.getModality(), owner.getVisibility().getInternalDisplayName(),
            owner.getOriginal() == owner, owner.getContainingDeclaration() == builtins.getBuiltInsModule(), owner.getSource() == S,
            owner.getAnnotations() == A, owner.isData(), owner.isInline(), owner.isFun(), owner.isValue(), owner.isInner(), owner.isExternal(),
            owner.isCompanionObject(), owner.isExpect(), owner.isActual(), owner.getContextReceivers().size(), owner.getDeclaredTypeParameters().size(),
            owner.getSealedSubclasses().size(), owner.getValueClassRepresentation(), owner.getDefaultFunctionTypeForSamInterface(), owner.isDefinitelyNotSamInterface(), owner.toString());
        owner.takeCalls();
        MemberScope scope = owner.getMemberScope(Collections.emptyList(), REFINER);
        String order = owner.takeCalls(); require(order.equals("constructor,scope"), "Argument-list getter dispatch/order changed");
        record("argument-scope-order", scope == MemberScope.Empty.INSTANCE, order);
        scope = owner.getMemberScope(TypeSubstitution.EMPTY, REFINER);
        record("empty-substitution-scope-order", scope == MemberScope.Empty.INSTANCE, owner.takeCalls());
        scope = bridge(owner); record("protected-list-bridge-order", scope == MemberScope.Empty.INSTANCE, owner.takeCalls());
        String badArguments = result(() -> owner.getMemberScope(Collections.singletonList(new TypeProjectionImpl(builtins.getIntType())), REFINER));
        record("argument-count-assertion", badArguments, owner.takeCalls());
        SimpleType defaultType = owner.getDefaultType(); String firstDefault = owner.takeCalls();
        record("default-type-cache", defaultType == owner.getDefaultType(), defaultType.getConstructor() == owner.getTypeConstructor(),
            defaultType.getMemberScope() == MemberScope.Empty.INSTANCE, defaultType.getArguments().size(), defaultType.isMarkedNullable());
        owner.takeCalls(); record("first-default-getters", firstDefault);
        ReceiverParameterDescriptor receiver = owner.getThisAsReceiverParameter();
        ReceiverValue value = receiver.getValue();
        record("receiver-cache", receiver == owner.getThisAsReceiverParameter(), value == receiver.getValue(),
            receiver.getContainingDeclaration() == owner, receiver.getType() == defaultType, receiver.getOriginal() == receiver,
            receiver.getAnnotations() == A, value instanceof ImplicitClassReceiver, ((ImplicitClassReceiver) value).getClassDescriptor() == owner,
            value.getOriginal() == value, receiver.toString(), result(() -> receiver.copy(owner)));
        record("receiver-replace", result(() -> value.replaceType(builtins.getStringType())));
        MemberScope inner = owner.getUnsubstitutedInnerClassesScope();
        record("inner-scope-cache", inner == owner.getUnsubstitutedInnerClassesScope(), inner.getFunctionNames().size(), inner.getVariableNames().size());
        record("visitor", owner.accept(new DeclarationDescriptorVisitorEmptyBodies<String, Integer>() {
            @Override public String visitClassDescriptor(ClassDescriptor descriptor, Integer data) { return (descriptor == owner) + "/" + data; }
        }, 41));
        record("empty-class-substitution", owner.substitute(TypeSubstitutor.EMPTY) == owner);
        ClassConstructorDescriptorImpl ctor = constructor(owner);
        record("initialized-constructor", owner.getConstructors().size(), owner.getUnsubstitutedPrimaryConstructor() == ctor,
            ctor.getContainingDeclaration() == owner, ctor.getReturnType() == defaultType, ctor.isPrimary());
        LazySubstitutingClassDescriptor passthrough = new LazySubstitutingClassDescriptor(owner, TypeSubstitutor.EMPTY);
        record("empty-lazy-type-constructor", passthrough.getTypeConstructor() == owner.getTypeConstructor(), passthrough.getOriginal() == owner,
            passthrough.getStaticScope() == owner.getStaticScope(), passthrough.getUnsubstitutedMemberScope(REFINER) == scope,
            passthrough.getContextReceivers().size(), passthrough.getUnsubstitutedPrimaryConstructor() == ctor,
            result(() -> passthrough.getThisAsReceiverParameter()), result(() -> { passthrough.acceptVoid(null); return null; }));
        owner.takeCalls(); passthrough.getMemberScope(Collections.emptyList(), REFINER);
        record("lazy-protected-list-dispatch", owner.takeCalls());
        System.out.println("boundary:empty-lazy-declared-parameters:" + result(() -> passthrough.getDeclaredTypeParameters()));
    }
    static void typesAndSubstitution() {
        GenericClass generic = new GenericClass("GenericBehavior");
        List<TypeParameterDescriptor> parameters = new ArrayList<>(generic.getDeclaredTypeParameters());
        List<KotlinType> supers = new ArrayList<>(Collections.singletonList(builtins.getIntType()));
        InspectConstructor inspected = new InspectConstructor(generic, parameters, supers);
        parameters.clear(); supers.clear(); supers.add(builtins.getStringType());
        record("type-constructor-carriers", inspected.getParameters().size(), inspected.getParameters().get(0) == generic.parameter,
            inspected.computed().iterator().next() == builtins.getStringType(), inspected.getDeclarationDescriptor() == generic,
            inspected.isDenotable(), inspected.getBuiltIns() == builtins, inspected.isFinal(), inspected.toString());
        InspectConstructor finalConstructor = new InspectConstructor(
            new Klass(builtins.getBuiltInsModule(), "FinalGetterBehavior", ClassKind.CLASS, Modality.FINAL),
            Collections.emptyList(), Collections.singletonList(builtins.getAnyType()));
        finalConstructor.declarationReads = 0;
        boolean finality = finalConstructor.isFinal();
        require(finality && finalConstructor.declarationReads == 1, "isFinal must capture its virtual declaration getter exactly once across both operands");
        record("type-constructor-virtual-declaration-once", finality, finalConstructor.declarationReads);
        record("type-constructor-classifiers", inspected.sameClassifier(generic), inspected.sameClassifier(new GenericClass("GenericBehavior")),
            inspected.sameClassifier(new GenericClass("DifferentBehavior")), inspected.sameClassifier(generic.parameter), inspected.emptyFallback() == builtins.getAnyType());
        Klass outer = new Klass(builtins.getBuiltInsModule(), "OuterBehavior", ClassKind.CLASS, Modality.FINAL);
        outer.companion = new Klass(outer, "Companion", ClassKind.OBJECT, Modality.FINAL);
        Klass nested = new Klass(outer, "Nested", ClassKind.CLASS, Modality.FINAL);
        InspectConstructor nestedConstructor = new InspectConstructor(nested, Collections.emptyList(), Collections.singletonList(builtins.getAnyType()));
        record("supertype-neighbours", inspected.neighbours(false).size(), nestedConstructor.neighbours(false).size(), nestedConstructor.neighbours(true).size(),
            nestedConstructor.neighbours(false).iterator().next() == outer.getDefaultType(),
            new ArrayList<>(nestedConstructor.neighbours(true)).get(1) == outer.companion.getDefaultType(), nestedConstructor.isFinal());
        SimpleType before = generic.getDefaultType();
        TypeSubstitutor substitutor = substitution(generic.parameter.getDefaultType(), builtins.getStringType());
        ClassDescriptor changed = generic.substitute(substitutor);
        TypeConstructor changedConstructor = changed.getTypeConstructor();
        record("nonempty-lazy-substitution", changed instanceof LazySubstitutingClassDescriptor, changed != generic, changed.getOriginal() == generic,
            changedConstructor == changed.getTypeConstructor(), changedConstructor.getDeclarationDescriptor() == changed,
            changedConstructor.getParameters().size(), changed.getDeclaredTypeParameters().size(), changed.getDeclaredTypeParameters().get(0).getContainingDeclaration() == changed,
            changed.getContainingDeclaration() == generic.getContainingDeclaration(), changed.getSource() == S, changed.getName(), changed.getKind(), changed.getModality(),
            changed.getVisibility().getInternalDisplayName(), changed.getAnnotations() == A, changed.getUnsubstitutedMemberScope() instanceof SubstitutingScope,
            changed.getMemberScope(TypeSubstitution.EMPTY) instanceof SubstitutingScope, changed.substitute(TypeSubstitutor.EMPTY) == changed,
            changed.getDefaultFunctionTypeForSamInterface(), changed.getValueClassRepresentation(), changed.getSealedSubclasses().size());
        record("generic-default-types", before.getArguments().size(), before.getArguments().get(0).getType() == generic.parameter.getDefaultType(),
            changed.getDefaultType().getArguments().size(), changed.getDefaultType().getConstructor() == changedConstructor,
            changed.getConstructors().size(), changed.getUnsubstitutedPrimaryConstructor());
        GenericClass defaultOrder = new GenericClass("DefaultOrderBehavior");
        LazySubstitutingClassDescriptor freshDefault = new LazySubstitutingClassDescriptor(defaultOrder,
            substitution(defaultOrder.parameter.getDefaultType(), builtins.getStringType()));
        defaultOrder.calls.clear();
        SimpleType freshType = freshDefault.getDefaultType();
        int parameterPosition = defaultOrder.calls.indexOf("parameters"), annotationPosition = defaultOrder.calls.indexOf("annotations");
        require(parameterPosition >= 0 && annotationPosition > parameterPosition, "Default type projections must precede virtual annotations");
        record("lazy-default-type-getter-order", String.join(",", defaultOrder.calls), freshType.getArguments().size());
        Klass nongeneric = new Klass(builtins.getBuiltInsModule(), "ConstructedBehavior", ClassKind.CLASS, Modality.OPEN);
        ClassConstructorDescriptorImpl ctor = constructor(nongeneric);
        ClassDescriptor copied = nongeneric.substitute(substitution(builtins.getIntType(), builtins.getStringType()));
        ClassConstructorDescriptor copiedCtor = copied.getConstructors().iterator().next();
        record("lazy-constructor-copy", copied.getConstructors().size(), copiedCtor != ctor, copiedCtor.getOriginal() == ctor,
            copiedCtor.getContainingDeclaration() == nongeneric, copiedCtor.getReturnType().equals(ctor.getReturnType()), copiedCtor.getKind(), copiedCtor.getVisibility().getInternalDisplayName(), copiedCtor.isPrimary());
        System.out.println("boundary:parameter-output-java-mutation:" + result(() -> { inspected.getParameters().clear(); return true; }));
        System.out.println("boundary:supertype-output-java-mutation:" + result(() -> { inspected.computed().clear(); return true; }));
    }
    static void enumEntry() {
        Klass parent = new Klass(builtins.getBuiltInsModule(), "EnumBehavior", ClassKind.ENUM_CLASS, Modality.FINAL);
        Scope source = new Scope(); parent.initialize(source, Collections.emptySet(), null);
        Name functionName = Name.identifier("function"), propertyName = Name.identifier("property"), absent = Name.identifier("absent");
        SimpleFunctionDescriptorImpl function = function(parent, "function", builtins.getIntType());
        PropertyDescriptorImpl property = property(parent, "property", builtins.getStringType());
        source.functions.put(functionName, Collections.singletonList(function)); source.properties.put(propertyName, Collections.singletonList(property));
        LinkedHashSet<Name> declaredNames = new LinkedHashSet<>(Arrays.asList(functionName, propertyName, absent));
        final int[] namesComputations = { 0 };
        NotNullLazyValue<Set<Name>> lazyNames = STORAGE.createLazyValue(() -> { namesComputations[0]++; return declaredNames; });
        EnumEntrySyntheticClassDescriptor entry = EnumEntrySyntheticClassDescriptor.create(STORAGE, parent, Name.identifier("Entry"), lazyNames, A, S);
        MemberScope scope = entry.getUnsubstitutedMemberScope(REFINER);
        Collection<? extends SimpleFunctionDescriptor> first = scope.getContributedFunctions(functionName, LOOKUP);
        SimpleFunctionDescriptor fakeFunction = first.iterator().next();
        Collection<? extends PropertyDescriptor> firstProperty = scope.getContributedVariables(propertyName, LOOKUP);
        PropertyDescriptor fakeProperty = firstProperty.iterator().next();
        record("enum-fake-function", first.size(), first == scope.getContributedFunctions(functionName, LOOKUP), names(first),
            fakeFunction.getContainingDeclaration() == entry, fakeFunction.getOverriddenDescriptors().contains(function), fakeFunction.getReturnType() == builtins.getIntType(), source.functionQueries);
        record("enum-fake-property", firstProperty.size(), firstProperty == scope.getContributedVariables(propertyName, LOOKUP), names(firstProperty),
            fakeProperty.getContainingDeclaration() == entry, fakeProperty.getOverriddenDescriptors().contains(property), fakeProperty.getType() == builtins.getStringType(), source.propertyQueries);
        Collection<? extends DeclarationDescriptor> all = scope.getContributedDescriptors(DescriptorKindFilter.ALL, name -> true);
        record("enum-full-cache", names(all), all == scope.getContributedDescriptors(DescriptorKindFilter.FUNCTIONS, name -> false),
            source.functionQueries, source.propertyQueries, namesComputations[0], scope.getFunctionNames() == declaredNames,
            scope.getVariableNames() == declaredNames, scope.getClassifierNames().size());
        int functionQueries = source.functionQueries, propertyQueries = source.propertyQueries;
        record("enum-empty-memoization", scope.getContributedFunctions(absent, LOOKUP).size(), scope.getContributedVariables(absent, LOOKUP).size(),
            source.functionQueries == functionQueries, source.propertyQueries == propertyQueries);
        record("enum-descriptor-state", entry.getContainingDeclaration() == parent, entry.getKind(), entry.getModality(), entry.getVisibility().getInternalDisplayName(),
            entry.getAnnotations() == A, entry.getSource() == S, entry.getConstructors().size(), entry.getDeclaredTypeParameters().size(),
            entry.getUnsubstitutedPrimaryConstructor(), entry.getCompanionObjectDescriptor(), entry.getValueClassRepresentation(), entry.getStaticScope() == MemberScope.Empty.INSTANCE,
            entry.getTypeConstructor().getSupertypes().size(), entry.getTypeConstructor().getSupertypes().iterator().next() == parent.getDefaultType(), entry.toString());
    }
    static void refinementCallbacks() {
        Klass source = new Klass(builtins.getBuiltInsModule(), "RefinementSource", ClassKind.CLASS, Modality.OPEN);
        SimpleType cached = source.getDefaultType();
        Refiner missing = new Refiner(null);
        SimpleType missingFirst = cached.refine(missing), missingSecond = cached.refine(missing);
        require(missingFirst == cached && missingSecond == cached, "Nil descriptor refinement must retain the cached default type");
        record("default-refinement-nil-cache", missingFirst == cached, missingSecond == cached, String.join(",", missing.calls));
        RefinedClass target = new RefinedClass();
        Refiner classes = new Refiner(target);
        SimpleType refined = cached.refine(classes);
        require(refined.getMemberScope() == target.refinedScope && target.scopeRefiners.size() == 1 && target.scopeRefiners.get(0) == classes,
            "Class refinement must dispatch the genuine protected refiner scope");
        record("default-refinement-class-scope", refined != cached, refined.getConstructor().getDeclarationDescriptor() == target,
            refined.getMemberScope() == target.refinedScope, target.scopeRefiners.size(), target.scopeRefiners.get(0) == classes,
            refined.getArguments().size(), String.join(",", classes.calls));
        Alias alias = new Alias();
        Refiner aliases = new Refiner(alias);
        SimpleType expanded = cached.refine(aliases);
        require(expanded.getConstructor() == builtins.getStringType().getConstructor(), "Typealias refinement must genuinely expand the String alias");
        record("default-refinement-typealias-expansion", expanded.equals(builtins.getStringType()), expanded.getConstructor() == alias.getExpandedType().getConstructor(),
            expanded.getArguments().size(), alias.getDeclaredTypeParameters().size(), alias.getUnderlyingType() == builtins.getStringType(),
            alias.getExpandedType() == builtins.getStringType(), String.join(",", aliases.calls));
        GenericClass parameterOwner = new GenericClass("FallbackParameterOwner");
        Refiner parameters = new Refiner(parameterOwner.parameter);
        SimpleType parameterDefault = cached.refine(parameters);
        require(parameterDefault == parameterOwner.parameter.getDefaultType(), "Other classifier refinement must retain its genuine default type");
        record("default-refinement-parameter-fallback", parameterDefault == parameterOwner.parameter.getDefaultType(),
            parameterDefault.getConstructor().getDeclarationDescriptor() == parameterOwner.parameter, String.join(",", parameters.calls));
    }
    static void errorConsumer() {
        ErrorClassDescriptor error = new ErrorClassDescriptor(Name.special("<behavior-error>"));
        ClassConstructorDescriptor primary = error.getUnsubstitutedPrimaryConstructor();
        record("full-error-consumer-writable-constructor", error.getConstructors().size(), error.getConstructors().contains(primary), primary.isPrimary(),
            primary.getContainingDeclaration() == error, primary.getReturnType() instanceof ErrorType, primary.getVisibility().getInternalDisplayName(),
            error.substitute(TypeSubstitutor.EMPTY) == error, error.substitute(substitution(builtins.getIntType(), builtins.getStringType())) == error,
            error.getMemberScope(Collections.emptyList(), REFINER) instanceof ErrorScope, error.getMemberScope(TypeSubstitution.EMPTY, REFINER) instanceof ErrorScope, error.toString());
        ClassDescriptorImpl cold = new ClassDescriptorImpl(builtins.getBuiltInsModule(), Name.identifier("ColdBehavior"), Modality.OPEN, ClassKind.CLASS,
            Collections.singletonList(builtins.getAnyType()), S, false, STORAGE);
        System.out.println("boundary:cold-class-constructors:" + result(() -> cold.getConstructors()));
        System.out.println("boundary:cold-class-scope:" + result(() -> cold.getUnsubstitutedMemberScope(REFINER)));
    }
    public static void main(String[] ignored) throws Throwable {
        DescriptorDebugHost host = new DescriptorDebugHost() {
            @Override public String classSimpleName(DeclarationDescriptor descriptor) { return descriptor.getClass().getSimpleName(); }
            @Override public int identityHashCode(DeclarationDescriptor descriptor) { return System.identityHashCode(descriptor); }
        };
        DescriptorDebugHostContext.INSTANCE.withHost(host, () -> {
            builtins = DefaultBuiltIns.getInstance();
            try { basic(); typesAndSubstitution(); enumEntry(); refinementCallbacks(); errorConsumer(); }
            catch (RuntimeException | Error failure) { throw failure; }
            catch (Throwable failure) { throw new AssertionError("Observer bridge failed", failure); }
            return null;
        });
    }
}
