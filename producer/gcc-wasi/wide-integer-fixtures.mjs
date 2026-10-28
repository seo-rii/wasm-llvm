import {cases as builtins} from './wide-integer-builtins-fixtures.mjs';
import {cases as bitfields} from './wide-integer-bitfields-fixtures.mjs';

export const dependencies=['wide-integer-builtins-fixtures.mjs','wide-integer-bitfields-fixtures.mjs'];
export const cases=[...builtins,...bitfields];
