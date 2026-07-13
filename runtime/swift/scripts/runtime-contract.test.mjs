import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	SWIFT_RUNTIME_CONTRACT_CASES,
	SWIFT_RUNTIME_CONTRACT_VERSION,
	createSwiftRuntimeContract,
	validateSwiftRuntimeContract
} from './runtime-contract.mjs';

test('defines required Swift browser runtime execution cases', () => {
	const contract = createSwiftRuntimeContract();

	assert.deepEqual(validateSwiftRuntimeContract(contract), []);
	assert.equal(contract.format, 'wasm-swift-runtime-contract-v1');
	assert.equal(contract.version, SWIFT_RUNTIME_CONTRACT_VERSION);
	assert.equal(contract.cases.length, 5);
	assert.deepEqual(
		contract.cases.map((testCase) => testCase.name),
		['stdin-readline', 'stdin-multiline', 'program-arguments', 'workspace-files', 'compile-error']
	);
	assert.ok(contract.requiredWorkerRequestFields.includes('run'));
	assert.ok(contract.requiredWorkerRequestFields.includes('stdin'));
	assert.ok(contract.requiredWorkerRequestFields.includes('workspaceFiles'));
	assert.ok(contract.requiredWorkerResponseFields.includes('results'));
});

test('keeps Swift contract cases aligned with the exported case list', () => {
	assert.deepEqual(createSwiftRuntimeContract().cases, SWIFT_RUNTIME_CONTRACT_CASES);
});

test('rejects malformed Swift browser runtime contract cases', () => {
	const errors = validateSwiftRuntimeContract({
		format: 'wrong',
		version: 0,
		requiredWorkerRequestFields: ['code'],
		requiredWorkerResponseFields: 'output',
		cases: [
			{
				name: 'bad name',
				description: 1,
				activePath: '../main.swift',
				code: 2,
				stdin: 3,
				args: [1],
				workspaceFiles: [{ path: '../escape.swift', content: 4 }],
				expectedStdout: 5,
				expectError: 'yes',
				expectedErrorPattern: 6
			}
		]
	});

	assert.deepEqual(errors, [
		'format must be wasm-swift-runtime-contract-v1',
		`version must be ${SWIFT_RUNTIME_CONTRACT_VERSION}`,
		'requiredWorkerRequestFields must exactly match run, baseUrl, manifestUrl, code, stdin, args, activePath, workspaceFiles',
		'requiredWorkerResponseFields must be an array',
		'cases[0].name must be a kebab-case string',
		'cases[0].description must be a string',
		'cases[0].code must be a string',
		'cases[0].stdin must be a string',
		'cases[0].expectedStdout must be a string',
		'cases[0].expectError must be a boolean when provided',
		'cases[0].expectedErrorPattern must be a string when provided',
		'cases[0].activePath must be a relative project path',
		'cases[0].args[0] must be a string',
		'cases[0].workspaceFiles[0].path must be a relative project path',
		'cases[0].workspaceFiles[0].content must be a string'
	]);

	assert.match(
		validateSwiftRuntimeContract({
			format: 'wasm-swift-runtime-contract-v1',
			version: SWIFT_RUNTIME_CONTRACT_VERSION,
			requiredWorkerRequestFields: [
				'run',
				'baseUrl',
				'manifestUrl',
				'code',
				'stdin',
				'args',
				'activePath',
				'workspaceFiles'
			],
			requiredWorkerResponseFields: ['output', 'results', 'error', 'progress'],
			cases: [
				{
					name: 'bad-args',
					description: 'invalid args',
					activePath: 'main.swift',
					code: 'print("bad")\n',
					stdin: '',
					args: 'not-array',
					workspaceFiles: [],
					expectedStdout: ''
				}
			]
		}).join('\n'),
		/cases\[0\]\.args must be an array/u
	);

	assert.match(
		validateSwiftRuntimeContract({
			format: 'wasm-swift-runtime-contract-v1',
			version: SWIFT_RUNTIME_CONTRACT_VERSION,
			requiredWorkerRequestFields: [
				'run',
				'baseUrl',
				'manifestUrl',
				'code',
				'stdin',
				'args',
				'activePath',
				'workspaceFiles'
			],
			requiredWorkerResponseFields: ['output', 'results', 'error', 'progress'],
			cases: [
				{
					name: 'bad-pattern',
					description: 'invalid error regex',
					activePath: 'main.swift',
					code: 'let =\n',
					stdin: '',
					args: [],
					workspaceFiles: [],
					expectedStdout: '',
					expectError: true,
					expectedErrorPattern: '['
				}
			]
		}).join('\n'),
		/cases\[0\]\.expectedErrorPattern must be a valid regular expression/u
	);
});

test('rejects malformed Swift browser runtime contract worker field lists', () => {
	const contract = createSwiftRuntimeContract();

	assert.deepEqual(
		validateSwiftRuntimeContract({
			...contract,
			requiredWorkerRequestFields: [
				'run',
				'baseUrl',
				'manifestUrl',
				'code',
				'args',
				'stdin',
				'activePath',
				'workspaceFiles'
			],
			requiredWorkerResponseFields: ['output', 'results', 'error']
		}),
		[
			'requiredWorkerRequestFields must exactly match run, baseUrl, manifestUrl, code, stdin, args, activePath, workspaceFiles',
			'requiredWorkerResponseFields must exactly match output, results, error, progress'
		]
	);
});

test('rejects absolute Swift browser runtime contract paths', () => {
	const errors = validateSwiftRuntimeContract({
		format: 'wasm-swift-runtime-contract-v1',
		version: SWIFT_RUNTIME_CONTRACT_VERSION,
		requiredWorkerRequestFields: [
			'run',
			'baseUrl',
			'manifestUrl',
			'code',
			'stdin',
			'args',
			'activePath',
			'workspaceFiles'
		],
		requiredWorkerResponseFields: ['output', 'results', 'error', 'progress'],
		cases: [
			{
				name: 'absolute-paths',
				description: 'invalid absolute paths',
				activePath: '/tmp/main.swift',
				code: 'print("bad")\n',
				stdin: '',
				args: [],
				workspaceFiles: [{ path: '/tmp/Helper.swift', content: '' }],
				expectedStdout: ''
			}
		]
	});

	assert.deepEqual(errors, [
		'cases[0].activePath must be a relative project path',
		'cases[0].workspaceFiles[0].path must be a relative project path'
	]);
});

test('rejects Windows absolute Swift browser runtime contract paths', () => {
	const errors = validateSwiftRuntimeContract({
		format: 'wasm-swift-runtime-contract-v1',
		version: SWIFT_RUNTIME_CONTRACT_VERSION,
		requiredWorkerRequestFields: [
			'run',
			'baseUrl',
			'manifestUrl',
			'code',
			'stdin',
			'args',
			'activePath',
			'workspaceFiles'
		],
		requiredWorkerResponseFields: ['output', 'results', 'error', 'progress'],
		cases: [
			{
				name: 'windows-absolute-paths',
				description: 'invalid Windows absolute paths',
				activePath: 'C:\\\\tmp\\\\main.swift',
				code: 'print("bad")\n',
				stdin: '',
				args: [],
				workspaceFiles: [{ path: 'C:\\\\tmp\\\\Helper.swift', content: '' }],
				expectedStdout: ''
			}
		]
	});

	assert.deepEqual(errors, [
		'cases[0].activePath must be a relative project path',
		'cases[0].workspaceFiles[0].path must be a relative project path'
	]);
});
