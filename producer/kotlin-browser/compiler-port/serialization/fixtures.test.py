#!/usr/bin/env python3
"""Fixture extractor guards, not compiler conformance evidence."""
import struct
import unittest
from fixtures import table, varint

class IrFixtureTableTests(unittest.TestCase):
    def test_fixed_width_sizes_are_big_endian(self):
        self.assertEqual(table(struct.pack('>iii',2,1,2)+b'abc'),[b'a',b'bc'])
    def test_official_negative_count_uses_unsigned_leb_sizes(self):
        data=struct.pack('>i',-3)+varint(0)+varint(127)+varint(128)+b'a'*127+b'b'*128
        self.assertEqual(table(data),[b'',b'a'*127,b'b'*128])
    def test_empty_table(self):
        self.assertEqual(table(struct.pack('>i',0)),[])
    def test_truncated_and_invalid_tables_are_rejected(self):
        invalid=[b'',struct.pack('>i',2),struct.pack('>ii',1,-1),struct.pack('>ii',1,10)+b'one',struct.pack('>i',0)+b'padding',struct.pack('>i',-1)+b'\x80'*6,struct.pack('>i',-2147483648)]
        for data in invalid:
            with self.subTest(data=data),self.assertRaises(ValueError):table(data)
    def test_varint_64_bit_boundaries(self):
        self.assertEqual(varint(0),b'\0')
        self.assertEqual(varint(127),b'\x7f')
        self.assertEqual(varint(128),b'\x80\x01')
        self.assertEqual(varint(-1),b'\xff'*9+b'\x01')
        self.assertEqual(varint(1<<63),b'\x80'*9+b'\x01')

if __name__=='__main__':unittest.main()
