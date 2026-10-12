package descriptorpropertyproof;

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
public final class PropertyConstructorOracle {
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
    static PropertyDescriptorImpl property(Klass owner, boolean isVar, boolean isConst) {
        PropertyDescriptorImpl p = PropertyDescriptorImpl.create(owner, A, Modality.OPEN, DescriptorVisibilities.PRIVATE, isVar, Name.identifier("p"), CallableMemberDescriptor.Kind.DECLARATION, S, true, isConst, true, true, true, true);
        p.setType(i, Collections.emptyList(), null, null, Collections.emptyList());
        PropertyGetterDescriptorImpl g = DescriptorFactory.createDefaultGetter(p, A); g.initialize(null);
        PropertySetterDescriptorImpl set = isVar ? DescriptorFactory.createDefaultSetter(p, A, A) : null;
        p.initialize(g, set, new FieldDescriptorImpl(A, p), new FieldDescriptorImpl(A, p));
        return p;
    }
    static final class VirtualBuilder extends PropertyDescriptorImpl.CopyConfiguration {
        int owners, builds;
        VirtualBuilder(PropertyDescriptorImpl property) { property.super(); }
        public PropertyDescriptorImpl.CopyConfiguration setOwner(DeclarationDescriptor owner) { owners++; return super.setOwner(owner); }
        public PropertyDescriptor build() { builds++; return super.build(); }
    }
    static final class Constructor extends ClassConstructorDescriptorImpl {
        Constructor(ClassDescriptor owner) { super(owner, null, A, true, CallableMemberDescriptor.Kind.DECLARATION, S); }
        public String toString() { return "proof-constructor"; }
        ClassConstructorDescriptorImpl explicit(DeclarationDescriptor owner, CallableMemberDescriptor.Kind kind, Name name) {
            return createSubstitutedCopy(owner, null, kind, name, A, S);
        }
    }
    static void properties() {
        Klass owner = new Klass(b.getBuiltInsModule(), ClassKind.CLASS);
        PropertyDescriptorImpl p = property(owner, true, false);
        record("property-state", p.isVar(),p.isConst(),p.isLateInit(),p.isExpect(),p.isActual(),p.isExternal(),p.isDelegated(),p.getType()==i,p.getReturnType()==i,p.getInType()==i,p.getTypeParameters().size(),p.getAccessors().size(),p.getGetter().getCorrespondingVariable()==p,p.getBackingField().getCorrespondingProperty()==p,p.getDelegateField().getCorrespondingProperty()==p,p.getOriginal()==p,p.getUserData(null));
        PropertyGetterDescriptorImpl g = p.getGetter(); PropertySetterDescriptorImpl set = (PropertySetterDescriptorImpl)p.getSetter();
        record("accessor-state",g.getName(),set.getName(),g.getTypeParameters().size(),g.getValueParameters().size(),g.isOperator(),g.isInfix(),g.isTailrec(),g.isSuspend(),g.isExpect(),g.isActual(),g.hasStableParameterNames(),g.hasSynthesizedParameterNames(),g.isHiddenToOvercomeSignatureClash(),g.isHiddenForResolutionEverywhereBesideSupercalls(),g.getUserData(null));
        record("accessor-empty-substitution",g.substitute(substitution(Variance.INVARIANT))==g,set.substitute(substitution(Variance.INVARIANT))==set);
        record("accessor-copy-rejection",result(()->g.newCopyBuilder()),result(()->set.copy(owner,Modality.FINAL,DescriptorVisibilities.PUBLIC,CallableMemberDescriptor.Kind.DECLARATION,false)));
        record("accessor-override-rejection",result(()->{g.setOverriddenDescriptors(Collections.singletonList(p));return null;}),result(()->{g.setOverriddenDescriptors(Collections.emptyList());return "ok";}));
        g.setDefault(false);g.setVisibility(DescriptorVisibilities.INTERNAL);g.setInitialSignatureDescriptor(new Owner());
        record("accessor-mutation",g.isDefault(),g.getVisibility()==DescriptorVisibilities.INTERNAL,g.getInitialSignatureDescriptor()!=null);
        PropertyGetterDescriptorImpl delayed = DescriptorFactory.createDefaultGetter(p,A);
        record("getter-delayed",delayed.getReturnType());delayed.initialize(null);record("getter-fallback",delayed.getReturnType()==i);
        PropertySetterDescriptorImpl uninitialized = new PropertySetterDescriptorImpl(p,A,Modality.FINAL,DescriptorVisibilities.PUBLIC,true,false,false,CallableMemberDescriptor.Kind.DECLARATION,null,S);
        record("setter-delayed",result(()->uninitialized.getValueParameters()));uninitialized.initializeDefault();
        record("setter-default",uninitialized.getValueParameters().get(0).getName(),uninitialized.getReturnType()==b.getUnitType(),uninitialized.getValueParameters().get(0).getIndex());
        record("setter-double-init",result(()->{uninitialized.initializeDefault();return null;}));
        record("empty-property-substitution",p.substitute(TypeSubstitutor.EMPTY)==p);
        for(Variance variance:Variance.values()) {
            PropertyDescriptor replacement=p.substitute(substitution(variance));
            record("property-projection-"+variance.name(),replacement==null?"null":replacement.getType(),replacement==null?"null":replacement.isSetterProjectedOut(),replacement==null?"null":replacement.getSetter().getValueParameters().get(0).getType(),replacement==null?"null":replacement.getGetter().getReturnType(),replacement==null?"null":replacement.getOriginal()==p);
        }
        PropertyDescriptor cp=p.newCopyBuilder().setOwner(owner).setModality(Modality.FINAL).setVisibility(DescriptorVisibilities.PUBLIC).setKind(CallableMemberDescriptor.Kind.FAKE_OVERRIDE).setTypeParameters(Collections.emptyList()).setDispatchReceiverParameter(null).setSubstitution(TypeSubstitution.EMPTY).setCopyOverrides(false).setName(Name.identifier("renamed")).setOriginal(p).setPreserveSourceElement().setReturnType(t).build();
        record("all-property-builder-methods",cp.getName(),cp.getType()==t,cp.getModality(),cp.getVisibility()==DescriptorVisibilities.PUBLIC,cp.getKind(),cp.getOriginal()==p,cp.getSource()==S,cp.getGetter().getVisibility()==DescriptorVisibilities.INTERNAL,cp.getSetter().getVisibility()==DescriptorVisibilities.INVISIBLE_FAKE,cp.getBackingField().getCorrespondingProperty()==cp,cp.getDelegateField().getCorrespondingProperty()==cp);
        PropertyDescriptor ordinary=p.copy(owner,Modality.FINAL,DescriptorVisibilities.PUBLIC,CallableMemberDescriptor.Kind.DECLARATION,false);
        record("property-copy",ordinary!=p,ordinary.getOriginal()==ordinary,ordinary.getSource()==S,ordinary.getType()==i);
        VirtualBuilder vb = new VirtualBuilder(p);
        CallableMemberDescriptor.CopyBuilder<? extends PropertyDescriptor> virtual = vb;
        PropertyDescriptor virtualCopy = virtual.setOwner(owner).setReturnType(t).build();
        record("virtual-property-builder",vb.owners,vb.builds,virtualCopy.getType()==t,virtualCopy.getContainingDeclaration()==owner);
        PropertyDescriptorImpl parent=property(owner,true,false);p.setOverriddenDescriptors(Collections.singletonList(parent));
        record("accessor-overrides",p.getGetter().getOverriddenDescriptors().size(),p.getGetter().getOverriddenDescriptors().iterator().next()==parent.getGetter(),p.getSetter().getOverriddenDescriptors().iterator().next()==parent.getSetter());
        PropertyDescriptor copiedOverrides=p.newCopyBuilder().setCopyOverrides(true).build();
        record("copied-property-overrides",copiedOverrides.getOverriddenDescriptors().size(),copiedOverrides.getOverriddenDescriptors().iterator().next()==parent);
        String v=p.accept(new DeclarationDescriptorVisitorEmptyBodies<String,Integer>(){public String visitPropertyDescriptor(PropertyDescriptor d,Integer n){return (d==p)+"/"+n;}},42);
        String vg=g.accept(new DeclarationDescriptorVisitorEmptyBodies<String,Integer>(){public String visitPropertyGetterDescriptor(PropertyGetterDescriptor d,Integer n){return (d==g)+"/"+n;}},43);
        String vs=set.accept(new DeclarationDescriptorVisitorEmptyBodies<String,Integer>(){public String visitPropertySetterDescriptor(PropertySetterDescriptor d,Integer n){return (d==set)+"/"+n;}},44);
        record("property-visitors",v,vg,vs);
        PropertyDescriptorImpl constant=property(owner,false,true);java.util.concurrent.atomic.AtomicInteger factories=new java.util.concurrent.atomic.AtomicInteger(), values=new java.util.concurrent.atomic.AtomicInteger();
        constant.setCompileTimeInitializerFactory(()->{factories.incrementAndGet();return LockBasedStorageManager.NO_LOCKS.createNullableLazyValue(()->new org.jetbrains.kotlin.resolve.constants.IntValue(values.incrementAndGet()));});
        record("initializer-lazy",factories.get(),values.get(),constant.getCompileTimeInitializer().getValue(),constant.getCompileTimeInitializer().getValue(),values.get());
        PropertyDescriptor constantCopy=constant.newCopyBuilder().build();record("initializer-copy-cache",constantCopy.getCompileTimeInitializer()==constant.getCompileTimeInitializer(),factories.get(),values.get());
        constant.cleanCompileTimeInitializerCache();record("initializer-reset",factories.get(),values.get(),constant.getCompileTimeInitializer().getValue(),values.get(),constantCopy.getCompileTimeInitializer().getValue());
        record("mutable-initializer-rejection",result(()->{p.setCompileTimeInitializerFactory(()->LockBasedStorageManager.NO_LOCKS.createNullableLazyValue(()->null));return null;}));
        Constructor delayedConstructor=new Constructor(owner);delayedConstructor.initialize(Collections.emptyList(),DescriptorVisibilities.PUBLIC);
        System.out.println("boundary:constructor-before-return-getter:"+result(()->delayedConstructor.getReturnType()));
        System.out.println("boundary:constructor-before-return-builder:"+result(()->delayedConstructor.newCopyBuilder().setReturnType(owner.getDefaultType()).build()!=null));
        Constructor ctor=new Constructor(owner);ctor.initialize(Collections.emptyList(),DescriptorVisibilities.PUBLIC);ctor.setReturnType(owner.getDefaultType());
        record("constructor-state",ctor.getContainingDeclaration()==owner,ctor.getConstructedClass()==owner,ctor.getOriginal()==ctor,ctor.isPrimary(),ctor.getKind(),ctor.getModality(),ctor.getTypeParameters().size(),ctor.getValueParameters().size(),ctor.calculateDispatchReceiverParameter(),ctor.getContextReceiverParameters().size(),ctor.getOverriddenDescriptors().size(),ctor.substitute(TypeSubstitutor.EMPTY)==ctor);
        ClassConstructorDescriptor cc=ctor.copy(owner,Modality.OPEN,DescriptorVisibilities.INTERNAL,CallableMemberDescriptor.Kind.SYNTHESIZED,false);
        record("constructor-copy",cc.getKind(),cc.isPrimary(),cc.getContainingDeclaration()==owner,cc.getOriginal()==cc,cc.getModality(),cc.getVisibility()==DescriptorVisibilities.INTERNAL);
        record("constructor-kind-rejection",result(()->ctor.explicit(owner,CallableMemberDescriptor.Kind.FAKE_OVERRIDE,null)),result(()->ctor.explicit(owner,CallableMemberDescriptor.Kind.DELEGATION,null)));
        record("constructor-rename-rejection",result(()->ctor.explicit(owner,CallableMemberDescriptor.Kind.DECLARATION,Name.identifier("renamed"))));
        record("constructor-override-rejection",result(()->{ctor.setOverriddenDescriptors(Collections.singletonList(p));return null;}));
        record("constructor-synthesized",ClassConstructorDescriptorImpl.createSynthesized(owner,A,false,S).getKind());
    }
    public static void main(String[] args) {
        DescriptorDebugHost host = new DescriptorDebugHost() {
            public String classSimpleName(DeclarationDescriptor d) { return d.getClass().getSimpleName(); }
            public int identityHashCode(DeclarationDescriptor d) { return System.identityHashCode(d); }
        };
        DescriptorDebugHostContext.INSTANCE.withHost(host, () -> { run(); properties(); return null; });
    }
}
