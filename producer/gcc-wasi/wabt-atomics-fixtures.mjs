// Real WAT inputs for instruction/type-driven feature metadata, not byte scans.
const feature = (name, prefix = '-') => `(@custom "target_features" "\\01${prefix}\\${name.length.toString(16).padStart(2, '0')}${name}")`;
const run = body => `(func $run (export "run") (@sym (name "run")) (result i32) ${body} i32.const 42)`;
const make = (id, body, features = {}, extra = {}) => ({ id, wat: `(module ${body})`, features, flags: ['--enable-threads'], ...extra });
const atomic = { atomics: '+' }, bulk = { 'bulk-memory': '+' }, bulkOpt = { ...bulk, 'bulk-memory-opt': '+' };

export const watAtomicsCases = [
  make('scalar-enabled', run(''), {}, { baselineIdentical: true }),
  make('opaque-data-fe', `(memory 1) (data (i32.const 0) "\\fe\\00\\fc\\08") ${run('')}`, {}, { baselineIdentical: true, containsFe: true }),
  make('opaque-custom-fe', `(@custom "probe" "\\fe\\1e\\fc\\0a") ${run('')}`, {}, { baselineIdentical: true, containsFe: true }),
  make('integer-fe', run('i32.const 254 drop'), {}, { baselineIdentical: true, containsFe: true }),
  make('shared-memory-type', `(memory 1 1 shared) ${run('')}`, atomic),
  make('atomic-fence', run('atomic.fence'), atomic),
  ...[
    ['i32', '', '', ''], ['i32', '8_u', '8', '8'], ['i32', '16_u', '16', '16'],
    ['i64', '', '', ''], ['i64', '8_u', '8', '8'], ['i64', '16_u', '16', '16'], ['i64', '32_u', '32', '32'],
  ].flatMap(([type, load, store, rmw]) => {
    const suffix = rmw ? '_u' : '';
    const prefix = `(memory 1) `;
    return [
      make(`${type}-load${load}`, prefix + run(`i32.const 0 ${type}.atomic.load${load} drop`), atomic),
      make(`${type}-store${store}`, prefix + run(`i32.const 0 ${type}.const 7 ${type}.atomic.store${store}`), atomic),
      ...['add', 'sub', 'and', 'or', 'xor', 'xchg', 'cmpxchg'].map(op => make(`${type}-rmw${rmw}-${op}`, prefix + run(
        `i32.const 0 ${type}.const 7 ${op === 'cmpxchg' ? type + '.const 9' : ''} ${type}.atomic.rmw${rmw}.${op}${suffix} drop`), atomic)),
    ];
  }),
  make('memory-notify', `(memory 1) ${run('i32.const 0 i32.const 0 memory.atomic.notify drop')}`, atomic),
  // Mismatched value returns immediately; neither wait can block the host.
  make('memory-wait32', `(memory 1 1 shared) ${run('i32.const 0 i32.const 1 i64.const 0 memory.atomic.wait32 drop')}`, atomic),
  make('memory-wait64', `(memory 1 1 shared) ${run('i32.const 0 i64.const 1 i64.const 0 memory.atomic.wait64 drop')}`, atomic),
  make('memory-init', `(memory 1) (data $bytes "x") ${run('i32.const 0 i32.const 0 i32.const 1 memory.init $bytes')}`, bulk),
  make('data-drop', `(memory 1) (data $bytes "x") ${run('data.drop $bytes')}`, bulk),
  make('memory-copy', `(memory 1) ${run('i32.const 8 i32.const 0 i32.const 4 memory.copy')}`, bulkOpt),
  make('memory-fill', `(memory 1) ${run('i32.const 0 i32.const 7 i32.const 4 memory.fill')}`, bulkOpt),
  make('mixed-atomic-bulk', `(memory 1 1 shared) (data $bytes "x") ${run('i32.const 0 i32.const 0 i32.const 1 memory.init $bytes data.drop $bytes atomic.fence')}`, { ...atomic, ...bulk }),
  make('preserve-atomics-prohibition', `${feature('atomics')} ${run('')}`, { atomics: '-' }, { baselineIdentical: true }),
  make('reject-atomic-prohibition', `${feature('atomics')} ${run('atomic.fence')}`, {}, { reject: /target_features:/ }),
  make('reject-shared-prohibition', `${feature('atomics')} (memory 1 1 shared) ${run('')}`, {}, { reject: /target_features:/ }),
  make('reject-bulk-prohibition', `${feature('bulk-memory')} (memory 1) (data $bytes "x") ${run('data.drop $bytes')}`, {}, { reject: /target_features:/ }),
  make('reject-copy-bulk-prohibition', `${feature('bulk-memory')} (memory 1) ${run('i32.const 0 i32.const 0 i32.const 0 memory.copy')}`, {}, { reject: /target_features:/ }),
  make('reject-copy-opt-prohibition', `${feature('bulk-memory-opt')} (memory 1) ${run('i32.const 0 i32.const 0 i32.const 0 memory.copy')}`, {}, { reject: /target_features:/ }),
  make('reject-without-threads', run('atomic.fence'), {}, { flags: [], reject: /not allowed/ }),
  make('reject-over-aligned-atomic', `(memory 1) ${run('i32.const 0 i32.atomic.load align=8 drop')}`, {}, { reject: /align/ }),
  make('reject-under-aligned-atomic', `(memory 1) ${run('i32.const 0 i32.atomic.load align=1 drop')}`, {}, { reject: /align/ }),
  make('reject-shared-without-maximum', `(memory 1 shared) ${run('')}`, {}, { reject: /maximum|max/ }),
];
