#!/usr/bin/env python3
"""Pin original version bodies, small common adaptations and the host policy data."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
MAVEN = 'core/language.version-settings/src/org/jetbrains/kotlin/config/MavenComparableVersion.java'
COMPILER = 'compiler/compiler.version/src/org/jetbrains/kotlin/config/KotlinCompilerVersion.java'
TOOLING = 'libraries/tools/kotlin-tooling-core/src/main/kotlin/org/jetbrains/kotlin/tooling/core/KotlinToolingVersion.kt'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def pin_file(filename, name):
    data = filename.read_bytes()
    return {'path': name, 'bytes': len(data), 'sha256': digest(data)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, default=REPO / 'out/kotlin-compiler-port/sources')
    parser.add_argument('--additional-source-root', type=Path, default=REPO / 'out/kotlin-versions-reference-inputs')
    args = parser.parse_args()
    closure = json.loads((HERE.parent / 'closure.lock.json').read_text())
    maven = next(pin for pin in closure['files'] if pin['path'] == MAVEN)
    original = (args.source_root / MAVEN).read_bytes()
    assert digest(original) == maven['sha256']
    references = json.loads((args.additional_source_root / 'reference-pins.json').read_text())
    for pin in references:
        data = (args.additional_source_root / pin['path']).read_bytes()
        assert len(data) == pin['bytes'] and digest(data) == pin['sha256']
        assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == pin['gitBlob']
    source_pins = [dict(maven, location='closure')]
    for name in [COMPILER, TOOLING]:
        source_pins.append(dict(next(pin for pin in references if pin['path'] == name), location='additional'))
    portable = []
    for name in ['MavenComparableVersion.kt', 'KotlinCompilerVersion.kt', 'KotlinToolingVersion.kt', 'VersionUnicode.kt']:
        portable.append(dict(pin_file(HERE / name, name), outputPath='compiler-port-versions/' + name))
    original_tooling = (args.additional_source_root / TOOLING).read_text()
    transformed = original_tooling.replace('import java.io.Serializable',
        'import org.jetbrains.kotlin.portable.versions.versionIntOrNull\nimport org.jetbrains.kotlin.portable.versions.versionLowercase')
    transformed = transformed.replace('Comparable<KotlinToolingVersion>, Serializable', 'Comparable<KotlinToolingVersion>')
    transformed = transformed.replace('.toIntOrNull()', '.let { versionIntOrNull(it) }').replace('.lowercase()', '.let { versionLowercase(it) }')
    transformed = transformed.replace('(.+?)', '([^\\n\\r\\u0085\\u2028\\u2029]+?)')
    assert transformed == (HERE / 'KotlinToolingVersion.kt').read_text(), 'Unreviewed tooling body mutation'
    patch = ''.join(difflib.unified_diff(original_tooling.splitlines(True), transformed.splitlines(True),
        fromfile='a/' + TOOLING, tofile='b/' + TOOLING)).encode()
    (HERE / 'patches').mkdir(exist_ok=True)
    (HERE / 'patches/tooling-host-boundaries.patch').write_bytes(patch)
    policy = json.loads((HERE / 'unicode-policy.json').read_text())
    jdk = Path('/usr/lib/jvm/java-17-openjdk-amd64')
    policy_origin = {'kind': 'actual-reference-jdk-runtime-data', 'jdkRuntimeVersion': policy['jdkRuntimeVersion'],
        'generator': pin_file(HERE / 'GenerateUnicodePolicy.java', 'GenerateUnicodePolicy.java'),
        'command': ['java', '-Xmx256m', '--add-opens', 'java.base/sun.text=ALL-UNNAMED', 'GenerateUnicodePolicy.java'],
        'runtimeFiles': [pin_file(jdk / name, name) for name in ['bin/java', 'lib/modules', 'release']],
        'generatorWrapperPid': 3721587, 'generatorChildPid': 3721622, 'exitCode': 0,
        'log': '/home/seorii/logs/kotlin-version-unicode-policy-final-xkrs_g_2.log',
        'coverage': {'codePoints': 0x110000, 'bmpDigitCharacters': len(policy['digitPairs']) // 2,
            'simpleLowercaseMappings': len(policy['lowercasePairs']) // 2,
            'wordCategoryRanges': len(policy['wordCategoryRanges']) // 2,
            'englishAndRootWordTablesEqual': True}}
    lock = {'schemaVersion': 1, 'kind': 'official-version-algorithms-common-source-port', 'source': closure['source'],
        'sources': source_pins, 'references': [pin for pin in references if pin['path'] not in [COMPILER, TOOLING]],
        'replacedOriginalPaths': [MAVEN, COMPILER, TOOLING], 'portableFiles': portable,
        'patch': pin_file(HERE / 'patches/tooling-host-boundaries.patch', 'patches/tooling-host-boundaries.patch'),
        'generator': pin_file(HERE / 'update-recipe.py', 'update-recipe.py'),
        'unicodePolicy': pin_file(HERE / 'unicode-policy.json', 'unicode-policy.json'), 'unicodePolicyOrigin': policy_origin,
        'unicodeAlgorithmReferences': json.loads((args.additional_source_root / 'openjdk/reference-pins.json').read_text()),
        'versionInput': {'required': True, 'trustRoot': 'explicit caller-supplied SHA-256 of producer input JSON',
            'template': 'compiler/compiler.version/resources/META-INF/compiler.version',
            'tokenRule': 'compiler/compiler.version/build.gradle.kts',
            'propertyRule': 'repo/kotlin-build-helpers/src/BuildProperties.kt',
            'order': "present deployVersion: default.snapshot selects defaultSnapshotVersion; otherwise deployVersion; absent deployVersion selects present buildNumber, otherwise defaultSnapshotVersion"},
        'semantics': {'maven': 'Actual item tree, alias qualifiers, normalization and comparison; arbitrary decimal magnitude replaces non-negative BigInteger only.',
            'tooling': 'All selected function/property bodies kept; JVM-only Serializable marker excluded. Case-sensitive hash and arithmetic overflow remain exactly upstream.',
            'unicode': 'SHA-bound reference JDK17 character/casing and real English/ROOT word DFA; no browser locale or browser Unicode data.',
            'compilerVersion': 'Actual fixed IS_PRE_RELEASE=false; explicit legitimate producer resource and explicit test override replace resource/classloader/System property access.',
            'excludedEntry': 'Maven static main console demonstration is a JVM-only CLI shell; no compiler caller is removed.'},
        'fullCompilerBuilt': False, 'readiness': False}
    (HERE / 'sources.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
    print(json.dumps({'sources': len(source_pins), 'portable': len(portable), 'unicodePolicyBytes': lock['unicodePolicy']['bytes'], 'readiness': False}))

if __name__ == '__main__':
    main()
