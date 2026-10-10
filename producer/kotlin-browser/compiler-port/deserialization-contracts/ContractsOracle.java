/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package contractsproof;

import java.util.*;
import kotlin.jvm.functions.Function1;
import org.jetbrains.kotlin.builtins.DefaultBuiltIns;
import org.jetbrains.kotlin.descriptors.*;
import org.jetbrains.kotlin.incremental.components.NoLookupLocation;
import org.jetbrains.kotlin.metadata.ProtoBuf;
import org.jetbrains.kotlin.metadata.deserialization.NameResolverImpl;
import org.jetbrains.kotlin.metadata.builtins.BuiltInsBinaryVersion;
import org.jetbrains.kotlin.name.*;
import org.jetbrains.kotlin.serialization.deserialization.*;

public final class ContractsOracle {
    private static void record(String key, Object value) {
        System.out.println("record:" + key + "=" + value);
    }
    private static String caught(Runnable action) {
        try { action.run(); return "ok"; }
        catch (Throwable error) { return error.getClass().getName() + ":" + error.getMessage(); }
    }
    public static void main(String[] args) {
        ProtoBuf.StringTable.Builder strings = ProtoBuf.StringTable.newBuilder().addString("proof");
        ProtoBuf.QualifiedNameTable.Builder names = ProtoBuf.QualifiedNameTable.newBuilder();
        names.addQualifiedName(ProtoBuf.QualifiedNameTable.QualifiedName.newBuilder()
                .setShortName(0).setKind(ProtoBuf.QualifiedNameTable.QualifiedName.Kind.PACKAGE));
        ProtoBuf.PackageFragment.Builder fragment = ProtoBuf.PackageFragment.newBuilder();
        List<ProtoBuf.Class> protos = new ArrayList<>();
        for (int index = 0; index < 128; index++) {
            strings.addString("C" + index);
            names.addQualifiedName(ProtoBuf.QualifiedNameTable.QualifiedName.newBuilder()
                    .setShortName(index + 1).setParentQualifiedName(0)
                    .setKind(ProtoBuf.QualifiedNameTable.QualifiedName.Kind.CLASS));
            ProtoBuf.Class proto = ProtoBuf.Class.newBuilder().setFqName(index + 1).setFlags(index).build();
            protos.add(proto); fragment.addClass_(proto);
        }
        // The genuine associateBy keeps the last proto for a duplicate class id.
        ProtoBuf.Class replacement = ProtoBuf.Class.newBuilder().setFqName(1).setFlags(999).build();
        fragment.addClass_(replacement); protos.set(0, replacement);
        NameResolverImpl resolver = new NameResolverImpl(strings.build(), names.build());
        BuiltInsBinaryVersion version = new BuiltInsBinaryVersion(1, 0, 7);
        List<ClassId> requests = new ArrayList<>();
        RuntimeException sentinel = new IllegalStateException("source-sentinel");
        SourceElement source = SourceElement.NO_SOURCE;
        Function1<ClassId, SourceElement> sourceCallback = classId -> {
            requests.add(classId);
            if (classId.getShortClassName().asString().equals("C127")) throw sentinel;
            return source;
        };
        ProtoBasedClassDataFinder implementation = new ProtoBasedClassDataFinder(fragment.build(), resolver, version, sourceCallback);
        ClassDataFinder finder = implementation;
        record("all-count", implementation.getAllClassIds().size());
        record("all-order", implementation.getAllClassIds());
        for (int index = 0; index < 127; index++) {
            ClassId classId = ClassId.topLevel(new FqName("proof.C" + index));
            ClassData data = finder.findClassData(classId);
            record("lookup-" + index, data.getNameResolver() == resolver && data.getClassProto() == protos.get(index)
                    && data.getMetadataVersion() == version && data.getSourceElement() == source);
            record("callback-" + index, requests.get(requests.size() - 1) == classId);
            record("repeat-" + index, finder.findClassData(classId).equals(data));
        }
        int before = requests.size();
        record("missing", finder.findClassData(ClassId.topLevel(new FqName("proof.Absent"))) == null);
        record("missing-callbacks", requests.size() - before);
        Throwable seen = null;
        try { finder.findClassData(ClassId.topLevel(new FqName("proof.C127"))); } catch (Throwable error) { seen = error; }
        record("source-failure-identity", seen == sentinel);
        record("source-failure-callbacks", requests.size() - before);
        ClassId marker = ClassId.topLevel(new FqName("proof.C42"));
        ClassData expected = finder.findClassData(marker);
        ClassDataFinder custom = classId -> classId == marker ? expected : null;
        record("sam-dispatch", custom.findClassData(marker) == expected);
        record("sam-null", custom.findClassData(ClassId.topLevel(new FqName("proof.Missing"))) == null);

        ClassDescriptor descriptor = DefaultBuiltIns.getInstance().getAny();
        CallableMemberDescriptor callable = descriptor.getUnsubstitutedMemberScope()
                .getContributedFunctions(Name.identifier("toString"), NoLookupLocation.FROM_TEST).iterator().next();
        List<String> values = new ArrayList<>(Arrays.asList("A", "B"));
        List<Object> effects = new ArrayList<>();
        ErrorReporter reporting = new ErrorReporter() {
            public void reportIncompleteHierarchy(ClassDescriptor target, List<String> unresolved) {
                effects.add(target); effects.add(unresolved); unresolved.add("C");
            }
            public void reportCannotInferVisibility(CallableMemberDescriptor target) { effects.add(target); }
        };
        reporting.reportIncompleteHierarchy(descriptor, values);
        reporting.reportCannotInferVisibility(callable);
        record("report-identity", effects.get(0) == descriptor && effects.get(1) == values && effects.get(2) == callable);
        record("report-list-alias", values);
        ErrorReporter noop = ErrorReporter.DO_NOTHING;
        record("singleton", noop == ErrorReporter.DO_NOTHING);
        for (int index = 0; index < 128; index++) {
            values.add("item-" + index); List<String> copy = new ArrayList<>(values);
            noop.reportIncompleteHierarchy(descriptor, values); noop.reportCannotInferVisibility(callable);
            record("noop-" + index, values.equals(copy));
        }
        List<String> unreadable = new AbstractList<>() {
            public String get(int index) { throw new AssertionError("get called"); }
            public int size() { throw new AssertionError("size called"); }
        };
        record("noop-does-not-inspect", caught(() -> noop.reportIncompleteHierarchy(descriptor, unreadable)));
        List<String> nullable = new ArrayList<>(Arrays.asList("A", null, "B"));
        TypedUsageKt.reportNullableElements(noop, descriptor, nullable);
        record("nullable-noop", nullable.equals(Arrays.asList("A", null, "B")));
        int priorEffects = effects.size();
        TypedUsageKt.reportNullableElements(reporting, descriptor, nullable);
        record("nullable-identity", effects.get(priorEffects) == descriptor && effects.get(priorEffects + 1) == nullable);
        record("nullable-values", nullable);
        // Java bytecode does not enforce @NotNull. Keep raw out-of-contract differences.
        System.out.println("invalid:descriptor=" + caught(() -> noop.reportIncompleteHierarchy(null, values)));
        System.out.println("invalid:list=" + caught(() -> noop.reportIncompleteHierarchy(descriptor, null)));
        System.out.println("invalid:callable=" + caught(() -> noop.reportCannotInferVisibility(null)));
    }
}
