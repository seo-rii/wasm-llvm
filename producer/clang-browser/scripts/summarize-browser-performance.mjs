#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VARIANTS = {
	compiler: ['baseline', 'raw-oz', 'baseline-o3', 'narrow-oz', 'narrow-o3'],
	clangd: ['shipped', 'streaming-embedded', 'separated']
};
const PROFILES = ['unconstrained', 'constrained'];
const PHASES = ['empty-cache', 'persistent-reload', 'warm'];
const WORKLOADS = ['c.c', 'stdcpp.cpp', 'templates.cpp'];
const EXPECTED_SAMPLES = 144;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function number(value, label) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
		throw new Error(`Invalid ${label}`);
	return value;
}

function statistics(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return {
		count: sorted.length,
		median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
		min: sorted[0],
		max: sorted.at(-1)
	};
}

/** Retain raw numeric samples; exclude repeated diagnostic text and non-request trace entries. */
export function summarizeBrowserPerformance(report, { partial = false, source } = {}) {
	if (!report || !Array.isArray(report.samples) || report.runs !== 3)
		throw new Error('Expected a three-repeat browser report');
	const seen = new Set();
	const groups = new Map();
	for (const sample of report.samples) {
		if (
			!VARIANTS[sample.family]?.includes(sample.name) ||
			!PROFILES.includes(sample.profile) ||
			!PHASES.includes(sample.phase) ||
			!Number.isInteger(sample.run) ||
			sample.run < 0 ||
			sample.run >= 3
		)
			throw new Error('Unexpected browser matrix cell');
		const key = [sample.family, sample.name, sample.profile, sample.phase].join('/');
		const identity = `${key}/${sample.run}`;
		if (seen.has(identity)) throw new Error(`Duplicate browser matrix cell: ${identity}`);
		seen.add(identity);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(sample);
		number(sample.transferPayloadBytes, 'payload bytes');
		number(sample.requests, 'request count');
		if (!sample.result || !Array.isArray(sample.result.stages))
			throw new Error('Missing preparation stages');
		for (const stage of sample.result.stages) {
			if (typeof stage.stage !== 'string') throw new Error('Invalid preparation stage name');
			number(stage.ms, 'preparation stage time');
		}
	}
	const complete = seen.size === EXPECTED_SAMPLES;
	if (!complete && !partial)
		throw new Error(
			`Incomplete browser matrix: ${seen.size}/${EXPECTED_SAMPLES}; use --partial true for an explicit partial summary`
		);
	const missing = [];
	for (const [family, names] of Object.entries(VARIANTS)) {
		for (const name of names)
			for (const profile of PROFILES)
				for (const phase of PHASES)
					for (let run = 0; run < 3; run++) {
						const cell = `${family}/${name}/${profile}/${phase}/${run}`;
						if (!seen.has(cell)) missing.push(cell);
					}
	}
	const summaries = [];
	for (const samples of groups.values()) {
		samples.sort((a, b) => a.run - b.run);
		const { family, name, profile, phase } = samples[0];
		const raw = [];
		for (const sample of samples) {
			const result = sample.result;
			const entry = {
				run: sample.run,
				transferPayloadBytes: sample.transferPayloadBytes,
				requests: sample.requests,
				stages: result.stages,
				stageSequenceOrigin:
					family === 'compiler' && phase === 'warm'
						? 'preceding runtime initialization, retained by the worker'
						: 'current phase'
			};
			if (family === 'compiler') {
				entry.preparationMs = number(result.preparationMs, 'compiler preparation');
				entry.totalMs = number(result.totalMs, 'compiler total');
				if (
					!Array.isArray(result.results) ||
					result.results.length !== WORKLOADS.length ||
					new Set(result.results.map((value) => value.name)).size !== WORKLOADS.length
				)
					throw new Error('Incomplete compiler workloads');
				entry.workloads = Object.fromEntries(
					WORKLOADS.map((workload) => {
						const value = result.results.find((item) => item.name === workload);
						if (!value || typeof value.stdout !== 'string')
							throw new Error(`Missing workload ${workload}`);
						const output = { stdout: value.stdout };
						for (const metric of [
							'compileLinkMs',
							'executeMs',
							'firstOutputMs',
							'elapsedMs',
							'emittedBytes'
						])
							output[metric] = number(value[metric], `${workload} ${metric}`);
						return [workload, output];
					})
				);
			} else {
				entry.readyMs = number(result.readyMs, 'clangd ready');
				if (
					!Array.isArray(result.diagnostics) ||
					result.diagnostics.length !== 2 ||
					new Set(result.diagnostics.map((value) => value.languageId)).size !== 2
				)
					throw new Error('Incomplete C/C++ diagnostics');
				entry.diagnostics = Object.fromEntries(
					['cpp', 'c'].map((language) => {
						const value = result.diagnostics.find(
							(item) => item.languageId === language
						);
						if (!value || !Array.isArray(value.diagnostics))
							throw new Error(`Missing ${language} diagnostics`);
						return [
							language,
							{
								fromStartMs: number(
									value.fromStartMs,
									`${language} diagnostics from phase start`
								),
								afterOpenMs: number(
									value.afterOpenMs,
									`${language} diagnostics after document open`
								),
								messageCount: value.diagnostics.length,
								messagesSha256: sha256(JSON.stringify(value.diagnostics))
							}
						];
					})
				);
				if (!Array.isArray(result.completion) || result.completion.length !== 3)
					throw new Error('Expected three completion requests in each repeat');
				entry.completion = result.completion.map((value) => ({
					ms: number(value.ms, 'completion time'),
					count: number(value.count, 'completion item count')
				}));
				if (result.capabilities !== undefined) entry.capabilities = result.capabilities;
				if (result.trace !== undefined) {
					if (!Array.isArray(result.trace)) throw new Error('Invalid request trace');
					entry.traceProvenance = {
						totalEntries: result.trace.length,
						sha256: sha256(JSON.stringify(result.trace))
					};
					entry.requestTrace = result.trace.filter(
						(value) => value.requestId !== undefined
					);
				}
			}
			raw.push(entry);
		}
		const summary = {
			family,
			name,
			profile,
			phase,
			repeats: raw.length,
			transferPayloadBytes: statistics(raw.map((value) => value.transferPayloadBytes)),
			requests: statistics(raw.map((value) => value.requests)),
			metrics: {},
			samples: raw
		};
		if (family === 'compiler') {
			for (const metric of ['preparationMs', 'totalMs'])
				summary.metrics[metric] = statistics(raw.map((value) => value[metric]));
			summary.metrics.firstCOutputMs = statistics(
				raw.map((value) => value.workloads['c.c'].firstOutputMs)
			);
			summary.metrics.firstCppOutputMs = statistics(
				raw.map((value) => value.workloads['stdcpp.cpp'].firstOutputMs)
			);
			summary.metrics.workloads = Object.fromEntries(
				WORKLOADS.map((workload) => [
					workload,
					Object.fromEntries(
						[
							'compileLinkMs',
							'executeMs',
							'firstOutputMs',
							'elapsedMs',
							'emittedBytes'
						].map((metric) => [
							metric,
							statistics(raw.map((value) => value.workloads[workload][metric]))
						])
					)
				])
			);
		} else {
			summary.metrics.readyMs = statistics(raw.map((value) => value.readyMs));
			for (const [language, label] of [
				['cpp', 'Cpp'],
				['c', 'C']
			]) {
				summary.metrics[`first${label}DiagnosticsMs`] = statistics(
					raw.map((value) => value.diagnostics[language].fromStartMs)
				);
				summary.metrics[`${language}DiagnosticsAfterOpenMs`] = statistics(
					raw.map((value) => value.diagnostics[language].afterOpenMs)
				);
			}
			summary.metrics.completionFirstRequestMs = statistics(
				raw.map((value) => value.completion[0].ms)
			);
			summary.metrics.completionAllRequestsMs = statistics(
				raw.flatMap((value) => value.completion.map((item) => item.ms))
			);
			summary.metrics.completionBatchTotalMs = statistics(
				raw.map((value) => value.completion.reduce((total, item) => total + item.ms, 0))
			);
			summary.metrics.completionBatchMaxMs = statistics(
				raw.map((value) => Math.max(...value.completion.map((item) => item.ms)))
			);
		}
		summaries.push(summary);
	}
	const metadata = { ...report };
	delete metadata.samples;
	return {
		format: 'wasm-llvm-browser-performance-summary-v1',
		complete,
		...(source ? { source } : {}),
		metadata,
		matrix: {
			observedSamples: seen.size,
			expectedSamples: EXPECTED_SAMPLES,
			runs: 3,
			profiles: PROFILES,
			phases: PHASES,
			variants: VARIANTS,
			missingCells: missing
		},
		timingInterpretation: {
			compiler:
				'First output is measured from phase start. Workloads run sequentially: C, bits/stdc++ C++, then templates C++. Compile/link metrics isolate each workload.',
			clangd: 'Diagnostics run sequentially: C++ then C. fromStartMs includes startup for cold/reload; afterOpenMs isolates document analysis. Warm measurements start at the operation batch.',
			completion:
				'First-request statistics use one request per repeat. All-request statistics use three requests per repeat, nine in a complete group. Batch-total and batch-max statistics use the summed and largest measured request duration in each three-request repeat; they preserve slow work displaced to a later request. Summed request time excludes document-open and inter-request overhead.',
			stages: 'Compiler warm stage sequences describe the preceding initialization retained by the worker. All sequences remain unmodified.',
			transfer:
				'Payload bytes and requests count benchmark asset responses; document/tooling transfer is excluded.'
		},
		groups: summaries
	};
}

async function main() {
	const args = new Map();
	const allowed = new Set(['--input', '--output', '--partial']);
	for (let index = 2; index < process.argv.length; index += 2) {
		const name = process.argv[index];
		if (
			!allowed.has(name) ||
			!process.argv[index + 1] ||
			process.argv[index + 1].startsWith('--') ||
			args.has(name)
		)
			throw new Error(`Unexpected, duplicate or incomplete option: ${name}`);
		args.set(name, process.argv[index + 1]);
	}
	if (
		!args.get('--input') ||
		!args.get('--output') ||
		(args.has('--partial') && !['true', 'false'].includes(args.get('--partial')))
	)
		throw new Error('--input and --output are required; --partial accepts true or false');
	const input = path.resolve(args.get('--input'));
	const output = path.resolve(args.get('--output'));
	if (input === output) throw new Error('Output must differ from the raw report');
	const bytes = await readFile(input);
	const summary = summarizeBrowserPerformance(JSON.parse(bytes.toString('utf8')), {
		partial: args.get('--partial') === 'true',
		source: { path: input, bytes: bytes.length, sha256: sha256(bytes) }
	});
	await writeFile(output, JSON.stringify(summary) + '\n');
	console.log(
		`Summarized ${summary.matrix.observedSamples}/${EXPECTED_SAMPLES} samples (${summary.complete ? 'complete' : 'partial'}): ${output}`
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
