import assert from 'node:assert/strict';
import { units, cases as nativeCases } from './rtti-fixtures.mjs';

const byId = new Map(units.map(unit => [unit.id, unit]));

function publicFixture(fixture, { sdkDefault = false } = {}) {
  const selected = fixture.units.map(id => byId.get(id));
  const mains = selected.filter(unit => ['main.c', 'main.cc'].includes(unit.file));
  assert.equal(mains.length, 1);
  const main = mains[0], providers = selected.filter(unit => unit !== main);
  const headers = new Map();
  for (const unit of selected) for (const [name, code] of Object.entries(unit.headers)) {
    if (headers.has(name)) assert.equal(headers.get(name), code);
    headers.set(name, code);
  }
  const sources = providers.map((unit, index) => ({ path: `provider${index}.${unit.language === 'cpp' ? 'cc' : 'c'}`, contents: unit.code }));
  const files = [...headers].map(([path, contents]) => ({ path, contents })).concat(sources);
  return {
    id: fixture.id.replaceAll(':', '-') + (sdkDefault ? '-sdk-default' : ''),
    request: { language: main.language, standard: main.standard, optimization: String(main.optimization),
      emit: 'executable', simd: false, code: main.code,
      ...(!sdkDefault && main.language === 'cpp' ? { rtti: main.rtti === 'enabled' } : {}),
      ...(files.length ? { files, sources: sources.map(file => file.path) } : {}) },
    stdin: fixture.stdin, stdout: fixture.stdout,
    rtti: { nativeCase: fixture.id, units: fixture.units,
      profile: fixture.profile, mode: sdkDefault ? 'sdk-default-off' : main.rtti }
  };
}

// The raw matrix separately preserves exact per-unit native flags and mixed
// compiler objects. Public requests use one GCC profile for all their units.
const selected = nativeCases.filter(fixture => !fixture.expectedLinkRejection
  && fixture.units.every(id => {
    const unit = byId.get(id);
    return unit.compiler === 'gcc' && unit.rtti !== 'default' && unit.flags.length === 0;
  }));
const omitted = selected.filter(fixture => fixture.profile === 'frontend-profile'
  && byId.get(fixture.units[0]).rtti === 'disabled');

export const cases = [
  ...selected.map(fixture => publicFixture(fixture)),
  // Native flag omission enables RTTI. SDK omission explicitly selects the
  // disabled profile, so use the native disabled source/output for this check.
  ...omitted.map(fixture => publicFixture(fixture, { sdkDefault: true })),
  {
    id: 'rtti-streambuf-print',
    request: { language: 'cpp', standard: 'gnu++23', optimization: '0', emit: 'executable', simd: false, rtti: true,
      code: '#include <iostream>\n#include <print>\n#include <sstream>\n#ifndef __GXX_RTTI\n#error Streambuf printing must exercise the RTTI-enabled runtime\n#endif\nint main(){int n;if(!(std::cin>>n))return 2;std::ostringstream text;\nstd::print(text,"stream {}",n+1);std::println(std::cout,"{}",text.str());}\n' },
    stdin: '23\n', stdout: 'stream 24\n',
    rtti: { gnuCase: 'rtti-streambuf-print', profile: 'gnu-streambuf', mode: 'enabled' }
  }
];
