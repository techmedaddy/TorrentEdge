const { decode, encode } = require('../src/server/torrentEngine/bencode');

describe('Bencode Decode', () => {
  describe('Integers', () => {
    it('should decode positive integer', () => {
      const result = decode(Buffer.from('i42e'));
      expect(result).toBe(42);
    });

    it('should decode negative integer', () => {
      const result = decode(Buffer.from('i-7e'));
      expect(result).toBe(-7);
    });

    it('should decode zero', () => {
      const result = decode(Buffer.from('i0e'));
      expect(result).toBe(0);
    });

    it('should throw on integer with leading zero', () => {
      expect(() => decode(Buffer.from('i042e'))).toThrow('no leading zeros');
    });

    it('should throw on negative zero', () => {
      expect(() => decode(Buffer.from('i-0e'))).toThrow('no leading zeros');
    });

    it('should throw on missing end marker', () => {
      expect(() => decode(Buffer.from('i42'))).toThrow('missing end marker');
    });

    it('should throw on invalid integer', () => {
      expect(() => decode(Buffer.from('iABCe'))).toThrow('Invalid integer');
    });
  });

  describe('Byte Strings', () => {
    it('should decode string as Buffer', () => {
      const result = decode(Buffer.from('4:spam'));
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('spam');
    });

    it('should decode empty string', () => {
      const result = decode(Buffer.from('0:'));
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should throw on string with leading zero in length', () => {
      expect(() => decode(Buffer.from('04:spam'))).toThrow('no leading zeros');
    });

    it('should throw on incomplete string', () => {
      expect(() => decode(Buffer.from('5:abc'))).toThrow('exceeds buffer');
    });

    it('should throw on missing colon', () => {
      expect(() => decode(Buffer.from('4spam'))).toThrow('missing colon');
    });
  });

  describe('Lists', () => {
    it('should decode list with string and integer', () => {
      const result = decode(Buffer.from('l4:spami42ee'));
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0].toString()).toBe('spam');
      expect(result[1]).toBe(42);
    });

    it('should decode empty list', () => {
      const result = decode(Buffer.from('le'));
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should decode nested list', () => {
      const result = decode(Buffer.from('ll4:spamee'));
      expect(Array.isArray(result)).toBe(true);
      expect(Array.isArray(result[0])).toBe(true);
      expect(result[0][0].toString()).toBe('spam');
    });

    it('should throw on missing end marker', () => {
      expect(() => decode(Buffer.from('l4:spam'))).toThrow('missing end marker');
    });
  });

  describe('Dictionaries', () => {
    it('should decode simple dictionary', () => {
      const result = decode(Buffer.from('d3:bar4:spam3:fooi42ee'));
      expect(typeof result).toBe('object');
      expect(result.bar.toString()).toBe('spam');
      expect(result.foo).toBe(42);
    });

    it('should decode empty dictionary', () => {
      const result = decode(Buffer.from('de'));
      expect(typeof result).toBe('object');
      expect(Object.keys(result).length).toBe(0);
    });

    it('should decode nested dictionary', () => {
      const result = decode(Buffer.from('d4:dictd3:key5:valueee'));
      expect(result.dict).toBeDefined();
      expect(result.dict.key.toString()).toBe('value');
    });

    it('should decode dictionary with list value', () => {
      const result = decode(Buffer.from('d4:listl1:a1:bee'));
      expect(Array.isArray(result.list)).toBe(true);
      expect(result.list[0].toString()).toBe('a');
      expect(result.list[1].toString()).toBe('b');
    });

    it('should throw on non-string key', () => {
      expect(() => decode(Buffer.from('di42e5:valuee'))).toThrow('key must be a byte string');
    });

    it('should throw on missing value', () => {
      expect(() => decode(Buffer.from('d3:keye'))).toThrow('has no value');
    });
  });

  describe('Complex Nested Structures', () => {
    it('should decode complex nested structure', () => {
      const input = 'd4:listl1:a1:bi42ee6:numberi123e6:stringd3:key5:valueee';
      const result = decode(Buffer.from(input));
      
      expect(result.list).toBeDefined();
      expect(Array.isArray(result.list)).toBe(true);
      expect(result.list.length).toBe(3);
      expect(result.number).toBe(123);
      expect(result.string.key.toString()).toBe('value');
    });

    it('should decode deeply nested structure', () => {
      const input = 'd1:ad1:bd1:cd1:di1eeeeee';
      const result = decode(Buffer.from(input));
      
      expect(result.a.b.c.d).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should throw on non-Buffer input', () => {
      expect(() => decode('i42e')).toThrow('Input must be a Buffer');
    });

    it('should throw on unexpected end of buffer', () => {
      expect(() => decode(Buffer.from('d'))).toThrow('Unexpected end of buffer');
    });

    it('should throw on unexpected data after structure', () => {
      expect(() => decode(Buffer.from('i42ei1e'))).toThrow('Unexpected data after');
    });

    it('should throw on invalid byte', () => {
      expect(() => decode(Buffer.from('x42e'))).toThrow('unexpected byte');
    });
  });
});

describe('Bencode Encode', () => {
  describe('Integers', () => {
    it('should encode positive integer', () => {
      const result = encode(42);
      expect(result.toString()).toBe('i42e');
    });

    it('should encode negative integer', () => {
      const result = encode(-7);
      expect(result.toString()).toBe('i-7e');
    });

    it('should encode zero', () => {
      const result = encode(0);
      expect(result.toString()).toBe('i0e');
    });

    it('should throw on non-integer number', () => {
      expect(() => encode(3.14)).toThrow('non-integer');
    });
  });

  describe('Byte Strings', () => {
    it('should encode string', () => {
      const result = encode('spam');
      expect(result.toString()).toBe('4:spam');
    });

    it('should encode empty string', () => {
      const result = encode('');
      expect(result.toString()).toBe('0:');
    });

    it('should encode Buffer', () => {
      const result = encode(Buffer.from('spam'));
      expect(result.toString()).toBe('4:spam');
    });

    it('should encode string with special characters', () => {
      const result = encode('hello world');
      expect(result.toString()).toBe('11:hello world');
    });
  });

  describe('Lists', () => {
    it('should encode array with mixed types', () => {
      const result = encode(['a', 1]);
      expect(result.toString()).toBe('l1:ai1ee');
    });

    it('should encode empty array', () => {
      const result = encode([]);
      expect(result.toString()).toBe('le');
    });

    it('should encode nested array', () => {
      const result = encode([['spam']]);
      expect(result.toString()).toBe('ll4:spamee');
    });

    it('should encode array with multiple elements', () => {
      const result = encode(['spam', 42, 'eggs']);
      expect(result.toString()).toBe('l4:spami42e4:eggse');
    });
  });

  describe('Dictionaries', () => {
    it('should encode simple object', () => {
      const result = encode({ foo: 42 });
      expect(result.toString()).toBe('d3:fooi42ee');
    });

    it('should encode empty object', () => {
      const result = encode({});
      expect(result.toString()).toBe('de');
    });

    it('should sort keys alphabetically', () => {
      const result = encode({ z: 1, a: 2, m: 3 });
      expect(result.toString()).toBe('d1:ai2e1:mi3e1:zi1ee');
    });

    it('should encode object with various value types', () => {
      const result = encode({ bar: 'spam', foo: 42 });
      expect(result.toString()).toBe('d3:bar4:spam3:fooi42ee');
    });

    it('should encode nested object', () => {
      const result = encode({ dict: { key: 'value' } });
      expect(result.toString()).toBe('d4:dictd3:key5:valueee');
    });
  });

  describe('Error Handling', () => {
    it('should throw on null', () => {
      expect(() => encode(null)).toThrow('null or undefined');
    });

    it('should throw on undefined', () => {
      expect(() => encode(undefined)).toThrow('null or undefined');
    });

    it('should throw on boolean', () => {
      expect(() => encode(true)).toThrow('Cannot encode type');
    });

    it('should throw on function', () => {
      expect(() => encode(() => {})).toThrow('Cannot encode type');
    });
  });
});

describe('Round-Trip Encoding/Decoding', () => {
  it('should round-trip integer', () => {
    const original = 42;
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(decoded).toBe(original);
  });

  it('should round-trip string', () => {
    const original = 'hello world';
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(decoded.toString()).toBe(original);
  });

  it('should round-trip array', () => {
    const original = ['spam', 42, 'eggs'];
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(decoded.length).toBe(3);
    expect(decoded[0].toString()).toBe('spam');
    expect(decoded[1]).toBe(42);
    expect(decoded[2].toString()).toBe('eggs');
  });

  it('should round-trip object', () => {
    const original = { foo: 42, bar: 'spam' };
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(decoded.foo).toBe(42);
    expect(decoded.bar.toString()).toBe('spam');
  });

  it('should round-trip complex nested structure', () => {
    const original = {
      announce: 'http://tracker.example.com:8080/announce',
      info: {
        name: 'example.txt',
        length: 12345,
        'piece length': 16384,
        pieces: Buffer.from('abcdef1234567890'),
        files: [
          { length: 100, path: ['dir', 'file1.txt'] },
          { length: 200, path: ['dir', 'file2.txt'] }
        ]
      },
      'creation date': 1234567890,
      comment: 'Test torrent'
    };
    
    const encoded = encode(original);
    const decoded = decode(encoded);
    
    expect(decoded.announce.toString()).toBe(original.announce);
    expect(decoded.info.name.toString()).toBe(original.info.name);
    expect(decoded.info.length).toBe(original.info.length);
    expect(decoded.info['piece length']).toBe(original.info['piece length']);
    expect(decoded['creation date']).toBe(original['creation date']);
    expect(decoded.comment.toString()).toBe(original.comment);
  });

  it('should round-trip deeply nested structure', () => {
    const original = {
      level1: {
        level2: {
          level3: {
            level4: ['a', 'b', 'c', { deep: 'value' }]
          }
        }
      },
      array: [1, [2, [3, [4, [5]]]]]
    };
    
    const encoded = encode(original);
    const decoded = decode(encoded);
    
    expect(decoded.level1.level2.level3.level4[3].deep.toString()).toBe('value');
    expect(decoded.array[1][1][1][1][0]).toBe(5);
  });

  it('should produce identical encoding for valid bencode', () => {
    const validBencode = Buffer.from('d3:bar4:spam3:fooi42ee');
    const decoded = decode(validBencode);
    const reencoded = encode(decoded);
    expect(reencoded.toString()).toBe(validBencode.toString());
  });
});
