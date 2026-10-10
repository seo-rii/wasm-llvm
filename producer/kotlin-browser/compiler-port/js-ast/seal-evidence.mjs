#!/usr/bin/env node
/** Publish a receipt only after rechecking current sources and all concrete runs. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, writeJson } from '../../scripts/source.mjs';
import { verifyEvidence } from './verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
assert.equal(process.argv.length, 3, 'Expected retained execution directory');
const output = path.resolve(process.argv[2]);
const receipt = JSON.parse(await readRegular(path.join(output, 'receipt.json')));
const result = await verifyEvidence(receipt, { artifactRoot: output });
await writeJson(path.join(HERE, 'evidence/receipt.json'), receipt);
console.log(JSON.stringify({ output, ...result }));
