// Assembler fixtures only; C++ feature qualification uses actual GCC output.
const imported = name => `(import "env" "${name}" (tag $${name} (@sym (name "${name}")) (param i32)))`;
const defined = name => `(tag $${name} (@sym (name "${name}")) (param i32))`;
const prohibition = name => `(@custom "target_features" "\\01-\\${name.length.toString(16).padStart(2, '0')}${name}")`;
const modern = `${imported('blue')} ${imported('red')}
  (func $run (@sym (name "run")) (param $which i32) (result i32)
    (block $red (result i32)
      (block $blue (result i32)
        (try_table (catch $red $red) (catch $blue $blue)
          local.get $which
          if
            i32.const 37
            throw $red
          else
            i32.const 41
            throw $blue
          end)
        unreachable)
      i32.const 100
      i32.add))`;
const modernRef = `${imported('blue')} ${imported('red')}
  (func $run_ref (@sym (name "run_ref")) (result i32) (local $e exnref)
    (block $done (result i32)
      (try_table (catch $red $done)
        (block $caught (result i32 exnref)
          (try_table (catch_ref $blue $caught) (catch_ref $red $caught)
            i32.const 53
            throw $red)
          unreachable)
        local.set $e
        drop
        local.get $e
        throw_ref)
      unreachable))`;
const modernCatchAll = `${imported('red')}
  (func $all_ref (@sym (name "all_ref")) (result i32) (local $e exnref)
    (block $done (result i32)
      (try_table (catch $red $done)
        (block $caught (result exnref)
          (try_table (catch_all_ref $caught) i32.const 61 throw $red)
          unreachable)
        local.set $e
        local.get $e
        throw_ref)
      unreachable))
  (func $all (@sym (name "all")) (result i32)
    (block $caught (try_table (catch_all $caught) i32.const 79 throw $red))
    i32.const 67)`;
const crossProvider = `${defined('red')} ${defined('blue')}
  (func $raise_red (@sym (name "raise_red")) i32.const 89 throw $red)
  (func $raise_blue (@sym (name "raise_blue")) i32.const 97 throw $blue)`;
const crossCatch = `${imported('blue')} ${imported('red')}
  (import "env" "raise_red" (func $raise_red (@sym (name "raise_red"))))
  (import "env" "raise_blue" (func $raise_blue (@sym (name "raise_blue"))))
  (func $cross_run (@sym (name "cross_run")) (param $which i32) (result i32)
    (block $red (result i32)
      (block $blue (result i32)
        (try_table (catch $red $red) (catch $blue $blue)
          local.get $which
          if call $raise_red else call $raise_blue end)
        unreachable)
      i32.const 1000
      i32.add))`;
const legacyTags = Array.from({ length: 32 }, (_, i) => `legacy${i}`);
const legacy = `${legacyTags.map(imported).join('\n')}
  (func $legacy (@sym (name "legacy")) (result i32)
    (try (result i32) (do i32.const 83 throw $legacy31)
      ${legacyTags.map((name, i) => `(catch $${name} drop i32.const ${i})`).join('\n')}))`;

export const watEhCases = [
  { id: 'scalar', wat: '(module (func $plain (@sym (name "plain")) (result i32) i32.const 7))',
    tags: [], features: {}, baselineIdentical: true },
  { id: 'tag-definitions', wat: `(module ${defined('red')} ${defined('blue')})`,
    tags: [], features: { 'exception-handling': '+' } },
  { id: 'tag-import-only', wat: `(module ${imported('red')})`,
    tags: [], features: { 'exception-handling': '+' } },
  { id: 'modern-catch', wat: `(module ${modern})`,
    tags: ['red', 'blue', 'red', 'blue'], features: { 'exception-handling': '+' } },
  { id: 'modern-catch-ref', wat: `(module ${modernRef})`,
    tags: ['red', 'blue', 'red', 'red'], features: { 'exception-handling': '+', multivalue: '+' } },
  { id: 'modern-catch-all', wat: `(module ${modernCatchAll})`,
    tags: ['red', 'red', 'red'], features: { 'exception-handling': '+' } },
  { id: 'cross-tag-provider', wat: `(module ${crossProvider})`,
    tags: ['red', 'blue'], features: { 'exception-handling': '+' } },
  { id: 'modern-cross-catch', wat: `(module ${crossCatch})`,
    tags: ['red', 'blue'], features: { 'exception-handling': '+' } },
  { id: 'legacy-vector-growth', wat: `(module ${legacy})`,
    tags: ['legacy31', ...legacyTags], features: { 'exception-handling': '+' } },
  { id: 'legacy-tag-definitions', wat: `(module ${legacyTags.toReversed().map(defined).join('\n')})`,
    tags: [], features: { 'exception-handling': '+' } },
  { id: 'exnref-only', wat: '(module (func $reference (@sym (name "reference")) (local exnref)))',
    tags: [], features: { 'exception-handling': '+' } },
  { id: 'multivalue-only', wat: '(module (func $multi (@sym (name "multi")) (result i32 i64) i32.const 1 i64.const 2))',
    tags: [], features: { multivalue: '+' } },
  { id: 'reject-modern-prohibition', wat: `(module ${prohibition('exception-handling')} ${modern})`, reject: /target_features:/ },
  { id: 'reject-tag-prohibition', wat: `(module ${prohibition('exception-handling')} ${defined('red')})`, reject: /target_features:/ },
  { id: 'reject-exnref-prohibition', wat: `(module ${prohibition('exception-handling')} (func (local exnref)))`, reject: /target_features:/ },
  { id: 'reject-multivalue-prohibition', wat: `(module ${prohibition('multivalue')} ${modernRef})`, reject: /target_features:/ },
];

export const ehLinkCases = [
  { id: 'modern-reordered-tags', objects: ['cross-tag-provider', 'modern-catch', 'modern-catch-ref', 'modern-catch-all', 'modern-cross-catch'],
    calls: [['run', [1], 37], ['run', [0], 141], ['run_ref', [], 53], ['all_ref', [], 61], ['all', [], 67],
      ['cross_run', [1], 89], ['cross_run', [0], 1097]], modern: true },
  { id: 'legacy-reordered-tags', objects: ['legacy-tag-definitions', 'legacy-vector-growth'],
    calls: [['legacy', [], 31]], modern: false },
];
