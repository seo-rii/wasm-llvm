import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { parseDoctorArgs, verifySwiftProducer } from './doctor.mjs';

test('validates the checked-in Swift producer manifest and patches', async () => {
	const report = await verifySwiftProducer();
	assert.equal(report.ready, true, report.errors.join('\n'));
	assert.equal(report.patches.length, 4);
});

test('parses producer-only doctor options', () => {
	assert.deepEqual(parseDoctorArgs(['--help']), { help: true });
	assert.deepEqual(parseDoctorArgs(['--plan', 'plan.json', '--bundle-dir', 'bundle', '--json']), {
		planPath: path.resolve('plan.json'),
		bundleDir: path.resolve('bundle'),
		probeToolchain: false,
		json: true
	});
	assert.throws(() => parseDoctorArgs(['--require-registered']), /Unknown option/u);
});
