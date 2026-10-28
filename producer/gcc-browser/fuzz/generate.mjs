// Deterministic, grammar-based differential fuzzing, not coverage-guided fuzzing.
// All arithmetic operands are uint32_t; the independent oracle uses BigInt.
import assert from 'node:assert/strict';

export const GENERATOR_VERSION = 1;
const MASK = 0xffffffffn;
const u32 = value => value & MASK;

function randomFor(seed, index) {
	let state = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), state | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return (value ^ (value >>> 14)) >>> 0;
	};
}

function expression(next, depth) {
	if (depth === 0 || next() % 4 === 0) {
		return next() % 3 === 0 ? { constant: next() } : { variable: ['x', 'y', 'z', 'i'][next() % 4] };
	}
	const op = ['add', 'sub', 'mul', 'xor', 'and', 'or', 'shl', 'shr', 'div', 'mod', 'select'][next() % 11];
	return { op, left: expression(next, depth - 1), right: expression(next, depth - 1),
		...(op === 'select' ? { otherwise: expression(next, depth - 1) } : {}) };
}

// BigInt arithmetic deliberately avoids the JavaScript Number/bitwise path
// used by the PRNG and the C emitter. Reduce every unsigned operation modulo 2^32.
export function evaluateExpression(node, variables) {
	if ('constant' in node) return BigInt(node.constant);
	if ('variable' in node) return variables[node.variable];
	const a = evaluateExpression(node.left, variables), b = evaluateExpression(node.right, variables);
	switch (node.op) {
		case 'add': return u32(a + b);
		case 'sub': return u32(a - b);
		case 'mul': return u32(a * b);
		case 'xor': return a ^ b;
		case 'and': return a & b;
		case 'or': return a | b;
		case 'shl': return u32(a << (b & 31n));
		case 'shr': return a >> (b & 31n);
		case 'div': return a / (b | 1n);
		case 'mod': return a % (b | 1n);
		case 'select': return a < b ? a : evaluateExpression(node.otherwise, variables);
		default: throw new Error(`Unknown expression operation ${node.op}`);
	}
}

function emitExpression(node) {
	if ('constant' in node) return `${node.constant}u`;
	if ('variable' in node) return node.variable;
	const a = emitExpression(node.left), b = emitExpression(node.right);
	const operators = { add: '+', sub: '-', mul: '*', xor: '^', and: '&', or: '|' };
	if (node.op in operators) return `(${a} ${operators[node.op]} ${b})`;
	if (node.op === 'shl' || node.op === 'shr') return `(${a} ${node.op === 'shl' ? '<<' : '>>'} (${b} & 31u))`;
	if (node.op === 'div' || node.op === 'mod') return `(${a} ${node.op === 'div' ? '/' : '%'} (${b} | 1u))`;
	return `((${a} < ${b}) ? ${a} : ${emitExpression(node.otherwise)})`;
}

function kernel(next) {
	const nodes = Array.from({ length: 7 }, () => expression(next, 2 + next() % 2));
	const salt = next();
	const rounds = 3 + next() % 10;
	const source = `static __attribute__((noinline)) uint32_t mix(uint32_t x, uint32_t y, uint32_t z) {
    uint32_t cells[8];
    for (uint32_t i = 0u; i < 8u; ++i) cells[i] = x ^ (y + i * ${salt}u);
    for (uint32_t i = 0u; i < ${rounds}u + (z & 3u); ++i) {
        x = ${emitExpression(nodes[0])};
        if ((x ^ y ^ i) & 1u) y = ${emitExpression(nodes[1])};
        else z = ${emitExpression(nodes[2])};
        switch ((y + i) & 3u) {
            case 0u: x ^= ${emitExpression(nodes[3])}; break;
            case 1u: y += ${emitExpression(nodes[4])}; break;
            case 2u: z -= ${emitExpression(nodes[5])}; break;
            default: x += ${emitExpression(nodes[6])}; break;
        }
        cells[(x ^ i) & 7u] += y ^ z;
    }
    for (uint32_t i = 0u; i < 8u; ++i) x = (x + cells[i]) ^ (y >> i);
    return x ^ y ^ z;
}`;
	const evaluate = (x, y, z) => {
		const vars = { x: BigInt(x), y: BigInt(y), z: BigInt(z), i: 0n };
		const cells = Array.from({ length: 8 }, (_, i) => vars.x ^ u32(vars.y + BigInt(i) * BigInt(salt)));
		for (let i = 0n; i < BigInt(rounds) + (vars.z & 3n); i++) {
			vars.i = i;
			vars.x = evaluateExpression(nodes[0], vars);
			if ((vars.x ^ vars.y ^ i) & 1n) vars.y = evaluateExpression(nodes[1], vars);
			else vars.z = evaluateExpression(nodes[2], vars);
			switch ((vars.y + i) & 3n) {
				case 0n: vars.x ^= evaluateExpression(nodes[3], vars); break;
				case 1n: vars.y = u32(vars.y + evaluateExpression(nodes[4], vars)); break;
				case 2n: vars.z = u32(vars.z - evaluateExpression(nodes[5], vars)); break;
				default: vars.x = u32(vars.x + evaluateExpression(nodes[6], vars)); break;
			}
			const slot = Number((vars.x ^ i) & 7n);
			cells[slot] = u32(cells[slot] + (vars.y ^ vars.z));
		}
		for (let i = 0; i < 8; i++) vars.x = u32(vars.x + cells[i]) ^ (vars.y >> BigInt(i));
		return vars.x ^ vars.y ^ vars.z;
	};
	return { source, evaluate };
}

function scalarCase(next, cpp) {
	const mix = kernel(next);
	const inputs = Array.from({ length: 3 }, () => next());
	const result = mix.evaluate(...inputs);
	const reverse = mix.evaluate(inputs[2], inputs[0], inputs[1]);
	return { request: {
		language: cpp ? 'cpp' : 'c', cpu: 'x86-64', emit: 'executable', optimization: ['0', '1', '2', '3', 's'][next() % 5],
		standard: cpp ? (next() % 2 ? 'gnu++17' : 'gnu++20') : 'gnu17',
		code: `#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <limits.h>
#if UINT_MAX != 4294967295U
#error This corpus requires 32-bit unsigned int
#endif
${mix.source}
int main(void) {
    uint32_t a, b, c;
    if (scanf("%" SCNu32 " %" SCNu32 " %" SCNu32, &a, &b, &c) != 3) return 2;
    printf("%" PRIu32 " %" PRIu32 "\\n", mix(a, b, c), mix(c, a, b));
    return 0;
}
` }, stdin: `${inputs.join(' ')}\n`, expectedStdout: `${result} ${reverse}\n`, family: cpp ? 'cpp-unsigned-control' : 'c-unsigned-control' };
}

function libraryCase(next) {
	const mix = kernel(next);
	const count = 4 + next() % 12;
	const inputs = Array.from({ length: count + 1 }, () => next());
	const token = inputs[0], salt = next(), parity = next() & 1;
	const values = inputs.slice(1).map((x, index) => mix.evaluate(x, token, index));
	const sorted = [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
	const rank = sorted.filter(x => x < BigInt(token)).length;
	const kth = sorted[token % sorted.length];
	let sum = values.reduce((a, b) => u32(a + b), 0n);
	const throws = ((token ^ salt) & 1) === parity;
	const payload = u32(BigInt(token) ^ BigInt(salt));
	sum = u32(sum + (throws ? payload : 7n));
	return { family: 'cpp-stl-pbds-exceptions', request: {
		language: 'cpp', cpu: 'x86-64', emit: 'executable', optimization: ['0', '1', '2', '3', 's'][next() % 5],
		standard: next() % 2 ? 'gnu++17' : 'gnu++20',
		code: `#include <bits/stdc++.h>
#include <ext/pb_ds/assoc_container.hpp>
#include <ext/pb_ds/tree_policy.hpp>
static_assert(UINT_MAX == 4294967295U);
${mix.source}
using ordered = __gnu_pbds::tree<uint32_t, __gnu_pbds::null_type, std::less<uint32_t>,
    __gnu_pbds::rb_tree_tag, __gnu_pbds::tree_order_statistics_node_update>;
struct marker { uint32_t &count; ~marker() { ++count; } };
struct fault : std::runtime_error { uint32_t value; explicit fault(uint32_t v) : std::runtime_error("generated"), value(v) {} };
int main() {
    uint32_t token, input;
    if (!(std::cin >> token)) return 2;
    std::vector<uint32_t> values;
    for (uint32_t i = 0; i < ${count}u; ++i) {
        if (!(std::cin >> input)) return 2;
        values.push_back(mix(input, token, i));
    }
    std::sort(values.begin(), values.end());
    ordered tree(values.begin(), values.end());
    std::map<uint32_t, uint32_t> counts;
    for (uint32_t value : values) ++counts[value];
    uint32_t sum = std::accumulate(values.begin(), values.end(), 0u);
    uint32_t destroyed = 0;
    try {
        marker guard{destroyed};
        if (((token ^ ${salt}u) & 1u) == ${parity}u) throw fault(token ^ ${salt}u);
        sum += 7u;
    } catch (const fault &error) { sum += error.value; }
    std::cout << sum << ' ' << tree.order_of_key(token) << ' '
              << *tree.find_by_order(token % tree.size()) << ' ' << destroyed << ' ' << counts.size() << '\\n';
}
` }, stdin: `${inputs.join(' ')}\n`, expectedStdout: `${sum} ${rank} ${kth} 1 ${sorted.length}\n` };
}

function simdCase(next) {
	const loop = 3 + next() % 10, offset = next() % 4 * 8;
	const cpu = next() % 2 ? 'x86-64' : 'avx2-fma';
	const assemblyChecks = [
		{ function: 'fuzz_avx2', require: ['\\bvpaddd\\b', '%ymm\\d+'], forbid: [] },
		{ function: 'fuzz_fma', require: ['\\bvfmadd(?:132|213|231)ps\\b', '%ymm\\d+'], forbid: [] },
		{ function: 'fuzz_optimized', require: [], forbid: ['\\bj[a-z]+\\s'] },
		{ function: 'fuzz_restored', require: ['\\bj[a-z]+\\s'], forbid: [] },
		...(cpu === 'x86-64' ? [{ function: 'fuzz_baseline', require: ['\\bpaddd\\b'], forbid: ['%[yz]mm\\d+', '\\bv(?:padd|mov|fmadd)\\w*\\b'] }] : [])
	];
	return { family: 'cpp-target-optimize-push-pop', check: 'avx2-fma', assemblyChecks,
		request: { language: 'cpp', cpu, emit: 'assembly', optimization: '0', standard: 'gnu++20',
			code: `#include <immintrin.h>
#pragma GCC push_options
#pragma GCC target("avx2,fma")
#pragma GCC optimize("O3")
extern "C" __attribute__((noinline,used))
void fuzz_avx2(unsigned *out, const unsigned *a, const unsigned *b) {
    _mm256_storeu_si256((__m256i *)(out + ${offset}), _mm256_add_epi32(
        _mm256_loadu_si256((const __m256i *)(a + ${offset})),
        _mm256_loadu_si256((const __m256i *)(b + ${offset}))));
}
extern "C" __attribute__((noinline,used))
void fuzz_fma(float *out, const float *a, const float *b, const float *c) {
    _mm256_storeu_ps(out + ${offset}, _mm256_fmadd_ps(_mm256_loadu_ps(a + ${offset}),
        _mm256_loadu_ps(b + ${offset}), _mm256_loadu_ps(c + ${offset})));
}
extern "C" __attribute__((noinline,used))
unsigned fuzz_optimized(unsigned x) { unsigned sum=x; for(unsigned i=0; i<${loop}u; ++i) sum+=x; return sum; }
#pragma GCC pop_options
extern "C" __attribute__((noinline,used))
unsigned fuzz_restored(unsigned x) { unsigned sum=x; for(unsigned i=0; i<${loop}u; ++i) sum+=x; return sum; }
#pragma GCC push_options
#pragma GCC optimize("O3")
extern "C" __attribute__((noinline,used))
void fuzz_baseline(unsigned *__restrict out, const unsigned *__restrict a, const unsigned *__restrict b) {
    for (unsigned i=0; i<64u; ++i) out[i]=a[i]+b[i];
}
#pragma GCC pop_options
` }, stdin: '', expectedStdout: '' };
}

export function generateCorpus({ seed, count = 24, caseIndex } = {}) {
	assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'seed must be uint32');
	assert(Number.isInteger(count) && count >= 1 && count <= 1000, 'case count must be 1..1000');
	assert(caseIndex === undefined || (Number.isInteger(caseIndex) && caseIndex >= 0 && caseIndex <= 999999), 'case index must be 0..999999');
	const indices = caseIndex === undefined ? Array.from({ length: count }, (_, i) => i) : [caseIndex];
	return { schemaVersion: 1, kind: 'gcc-generated-fuzz-corpus', generatorVersion: GENERATOR_VERSION, seed,
		caseCount: indices.length, cases: indices.map(index => {
			const next = randomFor(seed, index);
			const kind = index % 6;
			const item = kind === 5 ? simdCase(next) : kind === 2 || kind === 4 ? libraryCase(next) : scalarCase(next, kind === 1);
			return { id: `case-${String(index).padStart(6, '0')}`, index, ...item };
		}) };
}
