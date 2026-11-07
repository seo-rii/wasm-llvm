// The annotated assembler's TLS ABI, independently of GCC code generation.
const memory = '(import "env" "memory" (memory 1))';
const base = '(import "env" "__tls_base" (global $__tls_base (@sym (name "__tls_base")) (mut i32)))';
const address = (name, addend = '') => `(i32.add (global.get $__tls_base) (i32.const 0 (@reloc data tls $${name}${addend})))`;
export const watTlsCases = [
  { id: 'initialized', wat: `(module ${memory} ${base}
    (data (@sym tls (name ".tdata.value") (align 4)) (i32.const 0)
      (@sym $value tls (name "value") (size 4)) "\\0d\\00\\00\\00")
    (data (@sym tls (name ".tdata.array") (align 8)) (i32.const 0)
      (@sym $array tls (name "array") (size 8)) "\\11\\00\\00\\00\\1d\\00\\00\\00")
    (func $read_value (@sym (name "read_value")) (result i32)
      (i32.load ${address('value')}))
    (func $write_value (@sym (name "write_value")) (param $v i32)
      (i32.store ${address('value')} (local.get $v))))`,
    symbols: ['value', 'array'], segmentFlags: [2, 2], relocations: [0, 0] },
  { id: 'external-addend', wat: `(module ${memory} ${base}
    (@sym.import.data $array tls (name "array"))
    (func $read_external (@sym (name "read_external")) (result i32)
      (i32.load ${address('array', ' +4')})))`,
    symbols: ['array'], segmentFlags: [], relocations: [4] },
  { id: 'aligned-zero', wat: `(module ${memory} ${base}
    (data (@sym tls (name ".tbss.zero") (align 32)) (i32.const 0)
      (@sym $zero tls local (name "zero") (size 4)) "\\00\\00\\00\\00")
    (func $read_zero (@sym (name "read_zero")) (result i32)
      (i32.load ${address('zero')}))
    (func $address_zero (@sym (name "address_zero")) (result i32)
      ${address('zero')}))`,
    symbols: ['zero'], segmentFlags: [2], relocations: [0, 0] },
  { id: 'weak-hidden', wat: `(module ${memory}
    (data (@sym tls (align 4)) (i32.const 0)
      (@sym $weak_tls tls weak hidden (name "weak_tls") (size 4)) "\\07\\00\\00\\00"))`,
    symbols: ['weak_tls'], segmentFlags: [2], relocations: [] },
  { id: 'tls-data-alias', wat: `(module ${memory} ${base}
    (@sym.alias $alias (data $value) (@sym tls (name "tls_alias")))
    (data (@sym tls (align 4)) (i32.const 0)
      (@sym $value tls (name "aliased_value") (size 4)) "\\0d\\00\\00\\00")
    (func $read_alias (@sym (name "read_alias")) (result i32)
      (i32.load ${address('alias')})))`,
    symbols: ['aliased_value', 'tls_alias'], segmentFlags: [2], relocations: [0] },
  ...[31, 47].map(value => ({ id: `weak-function-alias-${value}`, wat: `(module ${memory}
    (@sym.alias $alias (func $target) (@sym weak (name "tls_init_alias")))
    (func $target (@sym local (name "local_init")) (result i32) i32.const ${value})
    (func $caller (@sym (name "call_alias_${value}")) (result i32) call $alias)
    (data (@sym tls (align 4)) (i32.const 0)
      (@sym $value tls weak (name "inline_tls") (size 4)) "\\07\\00\\00\\00"))`,
    symbols: ['inline_tls'], segmentFlags: [2], relocations: [] })),
  { id: 'strong-function-override', wat: `(module
    (func $target (@sym (name "tls_init_alias")) (result i32) i32.const 88))`,
    symbols: [], segmentFlags: [], relocations: [], baselineIdentical: true },
  { id: 'scalar', wat: `(module (memory 1)
    (data (@sym (align 4)) (i32.const 0)
      (@sym $plain (name "plain") (size 4)) "\\2a\\00\\00\\00")
    (func $read_plain (@sym (name "read_plain")) (result i32)
      (i32.load (i32.const 0 (@reloc data $plain)))))`,
    symbols: [], segmentFlags: [0], relocations: [], baselineIdentical: true },
  { id: 'reject-tls-function', wat: '(module (func $f (@sym tls (name "f"))))', reject: /Cannot specify tls/ },
  { id: 'reject-tls-global', wat: '(module (global $g (@sym tls (name "g")) i32 (i32.const 0)))', reject: /Cannot specify tls/ },
  { id: 'reject-tls-table', wat: '(module (table $t (@sym tls (name "t")) 0 funcref))', reject: /Cannot specify tls/ },
  { id: 'reject-duplicate-tls', wat: '(module (@sym.import.data $x tls tls (name "x")))', reject: /tls already specified/ },
  { id: 'reject-tls-symbol-in-ordinary-segment', wat: `(module (memory 1)
    (data (@sym (align 4)) (i32.const 0) (@sym $x tls (name "x") (size 1)) "x"))`, reject: /TLS symbol and segment flags must agree/ },
  { id: 'reject-ordinary-symbol-in-tls-segment', wat: `(module (memory 1)
    (data (@sym tls (align 4)) (i32.const 0) (@sym $x (name "x") (size 1)) "x"))`, reject: /TLS symbol and segment flags must agree/ },
  { id: 'reject-tls-alias-of-ordinary-symbol', wat: `(module (memory 1)
    (@sym.alias $a (data $x) (@sym tls (name "a")))
    (data (@sym (align 4)) (i32.const 0) (@sym $x (name "x") (size 1)) "x"))`, reject: /TLS alias and target flags must agree/ },
  { id: 'reject-ordinary-alias-of-tls-symbol', wat: `(module (memory 1)
    (@sym.alias $a (data $x) (@sym (name "a")))
    (data (@sym tls (align 4)) (i32.const 0) (@sym $x tls (name "x") (size 1)) "x"))`, reject: /TLS alias and target flags must agree/ },
  ...['atomics', 'bulk-memory'].map(name => ({ id: `reject-tls-${name}-prohibition`,
    wat: `(module (@custom "target_features" "\\01-\\${name.length.toString(16).padStart(2, '0')}${name}")
      (@sym.import.data $external tls (name "external")))`, reject: /target_features:/ })),
];
