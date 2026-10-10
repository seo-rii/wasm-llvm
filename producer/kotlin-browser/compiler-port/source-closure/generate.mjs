import assert from 'node:assert/strict';

export const WEB_MODULE = 'compiler/fir/checkers/checkers.web.common';
export const WEB_FACTORY = WEB_MODULE + '/gen/org/jetbrains/kotlin/fir/analysis/diagnostics/web/common/FirWebCommonErrors.kt';
export const CLI_CONFIGURATION = 'compiler/cli/cli-base/gen/org/jetbrains/kotlin/cli/common/CLIConfigurationKeys.kt';
export const CLI_REPORTING = 'compiler/cli/cli-base/src/org/jetbrains/kotlin/cli/CliDiagnosticReporting.kt';
export const CLI_DIAGNOSTICS = 'compiler/cli/cli-base/src/org/jetbrains/kotlin/cli/CliDiagnostics.kt';
export const CLI_KEYS = [
    ['DIAGNOSTICS_COLLECTOR', 'diagnosticsCollector'],
    ['ALLOW_KOTLIN_PACKAGE', 'allowKotlinPackage'],
    ['TEST_ENVIRONMENT', 'testEnvironment'],
];

function only(text, pattern, label) {
    const matches = [...text.matchAll(pattern)];
    assert.equal(matches.length, 1, 'Selected CLI declaration changed: ' + label);
    return matches[0][0];
}

/** Exact selected declarations from the generated JVM-coupled CLI configuration source. */
export function configurationSplit(bytes) {
    const text = bytes.toString('utf8');
    const fields = CLI_KEYS.map(([key]) => only(text,
        new RegExp('^    @JvmField\\n    val ' + key + ' = CompilerConfigurationKey\\.create<[^\\n]+>\\("' + key + '"\\)\\n', 'gm'), key));
    const properties = CLI_KEYS.map(([, name]) => only(text,
        new RegExp('^var CompilerConfiguration\\.' + name + ': [^\\n]+\\n    get\\(\\) = [^\\n]+\\n    set\\(value\\) \\{ [^\\n]+ \\}\\n', 'gm'), name));
    const header = text.slice(0, text.indexOf('package '));
    const imports = ['org.jetbrains.kotlin.config.CompilerConfiguration', 'org.jetbrains.kotlin.config.CompilerConfigurationKey',
        'org.jetbrains.kotlin.diagnostics.impl.BaseDiagnosticsCollector'];
    for (const name of imports) assert(text.includes('\nimport ' + name + '\n'));
    return { fragments: [...fields, ...properties].map(value => Buffer.from(value)),
        bytes: Buffer.from(header + 'package org.jetbrains.kotlin.cli.common\n\nimport kotlin.jvm.JvmField\n' +
            imports.map(name => 'import ' + name + '\n').join('') + '\nobject CLIConfigurationKeys {\n' +
            fields.join('\n') + '}\n\n' + properties.join('\n')) };
}

/** Preserve the actual sourceless diagnostic report path, without JVM exception/PSI reporting overloads. */
export function reportingSplit(bytes) {
    const text = bytes.toString('utf8');
    const start = text.indexOf('fun CompilerConfiguration.report(\n');
    const end = text.indexOf('\n@OptIn(MessageCollectorAccess::class)', start);
    assert(start >= 0 && end > start && text.split('fun CompilerConfiguration.report(\n').length === 2);
    const body = text.slice(start, end);
    const imports = ['org.jetbrains.kotlin.KtSourceFile', 'org.jetbrains.kotlin.cli.common.diagnosticsCollector',
        'org.jetbrains.kotlin.cli.common.messages.CompilerMessageSourceLocation', 'org.jetbrains.kotlin.config.CompilerConfiguration',
        'org.jetbrains.kotlin.config.LanguageVersionSettings', 'org.jetbrains.kotlin.config.languageVersionSettings',
        'org.jetbrains.kotlin.diagnostics.DiagnosticContext', 'org.jetbrains.kotlin.diagnostics.KtDiagnostic',
        'org.jetbrains.kotlin.diagnostics.KtSourcelessDiagnosticFactory', 'org.jetbrains.kotlin.diagnostics.report'];
    for (const name of imports) assert(text.includes('\nimport ' + name + '\n'));
    return { fragments: [Buffer.from(body)], bytes: Buffer.from(text.slice(0, text.indexOf('package ')) +
        'package org.jetbrains.kotlin.cli\n\n' + imports.map(name => 'import ' + name + '\n').join('') + '\n' + body + '\n') };
}
