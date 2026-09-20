/* eslint-disable no-new, @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/consistent-type-assertions -- A store is often built only for what it reports, the keys here are the ones a caller writes, a key is cast to a type a method refuses, and a value read back is `any`. */
import fs from 'node:fs';
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	trackConf,
	runRegisteredCleanups,
	resetTrackedConfs,
	createNullProtoObject,
	readConfigFile,
	dateReviving,
	getMigrationVersion,
} from './_utilities.js';

type Store = Record<string, any>;

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('keys the prototype has', () => {
	it('ignores top-level prototype keys via set and delete', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		for (const key of ['__proto__', 'constructor', 'prototype']) {
			conf.set(key, {polluted: true});
			conf.delete(key);
		}

		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.strictEqual(({} as any).polluted, undefined);
	});

	it('does not pollute via nested __proto__ paths', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('__proto__.polluted', 'yes');
		conf.set({['__proto__']: {polluted: 'yes'}});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.strictEqual(({} as any).polluted, undefined);
	});

	it('keeps nested __internal__ data as user data', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('doc.__internal__', 'user-value');
		assert.strictEqual(conf.get('doc.__internal__'), 'user-value');
	});

	it('get/has for __proto__ report missing', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('real', 1);
		assert.strictEqual(conf.get('__proto__' as any), undefined);
		assert.strictEqual(conf.has('__proto__'), false);
	});

	it('stores top-level prototype keys literally without dot-notation', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, accessPropertiesByDotNotation: false});

		// Without dot notation the key reaches the store as it is, and the store has no prototype to write through, so these are ordinary keys, the same ones `delete()`, `has()` and a file that already holds them treat as ordinary.
		for (const key of ['__proto__', 'constructor', 'prototype']) {
			conf.set(key, {polluted: true});
			assert.strictEqual(conf.has(key), true, `has(\`${key}\`)`);
			assert.deepStrictEqual(conf.get(key), {polluted: true}, `get(\`${key}\`)`);
		}

		assert.strictEqual(conf.size, 3);

		// JSON holds them as own keys, so another instance reads them back the same way.
		const file = JSON.parse(fs.readFileSync(conf.path, 'utf8'));
		assert.strictEqual(Object.getOwnPropertyDescriptor(file, '__proto__')?.value?.polluted, true);
		assert.strictEqual(file.constructor.polluted, true);

		const second = new Conf({cwd, accessPropertiesByDotNotation: false});
		assert.deepStrictEqual(second.get('constructor'), {polluted: true});
		assert.deepStrictEqual(second.get('__proto__'), {polluted: true});

		// Nothing of it reaches the shared prototypes.
		assert.strictEqual(Object.hasOwn(Object.prototype, 'polluted'), false);
		assert.strictEqual(({} as any).polluted, undefined);
	});

	it('does not let a key reach the prototype', () => {
		const conf = new Conf({cwd: createTempDirectory()});

		conf.set('__proto__.polluted', 'yes');
		conf.set('constructor.prototype.polluted', 'yes');
		conf.set({['__proto__']: {polluted: 'yes'}});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));

		// A config file that holds the key must not pollute either, and the key is kept as plain data.
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{"__proto__": {"polluted": "yes"}}');
		const fromFile = new Conf({cwd});
		assert.deepStrictEqual(Object.keys(fromFile.store), ['__proto__']);

		// `Object.prototype` is untouched by any of it.
		const plain: Record<string, unknown> = {};
		assert.strictEqual(plain.polluted, undefined);
	});

	// The readme says that with dot notation off these names are keys like any other, so a `defaults` entry under one of them is a key of the store. A literal cannot express the key — `__proto__` in an object literal sets the prototype instead — so it is read the two ways a caller can actually supply one, and both must keep it.
	it('keeps a `defaults` key of a name the prototype has, with dot notation off', () => {
		for (const [name, defaults] of [
			['a JSON parse', JSON.parse('{"__proto__": {"kept": true}, "other": 1}')],
			['a null-prototype object', Object.assign(Object.create(null) as Record<string, unknown>, JSON.parse('{"__proto__": {"kept": true}, "other": 1}'))],
		] as Array<[string, Record<string, unknown>]>) {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, any>>({cwd, accessPropertiesByDotNotation: false, defaults: defaults as never});

			conf.set('written', true);

			assert.deepStrictEqual(
				Object.keys(readConfigFile(conf.path) as Record<string, unknown>).sort(),
				['__proto__', 'other', 'written'],
				`the key is in the file, given ${name}`,
			);
			assert.deepStrictEqual(Object.keys({...conf.store}).sort(), ['__proto__', 'other', 'written'], `and in the store, given ${name}`);

			// The prototype of anything in this process is untouched by having held the key.
			const plain: Record<string, unknown> = {};
			assert.strictEqual(plain.kept, undefined, `no prototype was polluted, given ${name}`);
		}
	});

	// The readme says the same of a whole-store write, which is given the caller's own object rather than a store read from the file, and which is the ordinary way a caller replaces the whole store.
	it('keeps a `defaults` key of a name the prototype has through a whole-store write, with dot notation off', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({cwd, accessPropertiesByDotNotation: false, defaults: JSON.parse('{"__proto__": {"kept": true}, "other": 1}')});

		// A store the caller built rather than one read from the file, which is the object a whole-store write copies.
		conf.store = {other: 2};

		assert.deepStrictEqual(
			Object.keys(readConfigFile(conf.path) as Record<string, unknown>).sort(),
			['__proto__', 'other'],
			'the key is still in the file after a write of a store the caller built',
		);
		assert.deepStrictEqual(Object.keys({...conf.store}).sort(), ['__proto__', 'other'], 'and in the store');

		// The value the option gave the key, read the way a caller reads it. The expected value is parsed rather than written as a literal, since `__proto__` in a literal is the prototype of the object and not a key of it.
		assert.deepStrictEqual(conf.get('__proto__'), {kept: true}, 'and it holds the default the option gave it');

		// The default is not written as the prototype of the store either, since a store is written as its own keys.
		const plain: Record<string, unknown> = {};
		assert.strictEqual(plain.kept, undefined, 'no prototype was polluted');
	});

	it('does not write a nested key through the prototype', () => {
		const conf = new Conf({cwd: createTempDirectory()});

		// These names hold functions on `Object.prototype`, so a write that followed one would set a property on a shared built-in and store nothing.
		const names = ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__'];
		for (const name of names) {
			conf.set(`a.${name}.polluted`, 'yes');
		}

		for (const name of names) {
			assert.deepStrictEqual(conf.get(`a.${name}`), {polluted: 'yes'});
		}

		assert.strictEqual(Object.hasOwn(Object.prototype.valueOf, 'polluted'), false);

		// `Object.prototype` is untouched by any of it.
		const plain: Record<string, unknown> = {};
		assert.strictEqual(plain.polluted, undefined);
	});

	it('does not write a nested key through the prototype with `set()` or `appendToArray()`', () => {
		const conf = new Conf({cwd: createTempDirectory()});

		conf.set({'a.valueOf.nested': 1});
		conf.appendToArray('b.hasOwnProperty.list', 'first');

		assert.deepStrictEqual(conf.get('a.valueOf'), {nested: 1});
		assert.deepStrictEqual(conf.get('b.hasOwnProperty.list'), ['first']);
		assert.strictEqual(Object.hasOwn(Object.prototype.valueOf, 'nested'), false);
		assert.strictEqual(Object.hasOwn(Object.prototype.hasOwnProperty, 'list'), false);
	});

	it('does not write a nested default through the prototype', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {'a.valueOf.polluted': 'yes'}});

		conf.clear();

		assert.strictEqual(Object.hasOwn(Object.prototype.valueOf, 'polluted'), false);
		assert.deepStrictEqual(conf.get('a.valueOf'), {polluted: 'yes'});
	});

	it('.reset() - key name that `Object.prototype` has', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
		});

		const names = ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__'];

		// None of these has a default, so a reset must do nothing instead of reading the value `Object.prototype` has for the name. `constructor` is reset with them, and it is stored like any other key.
		for (const name of [...names, 'constructor']) {
			store.reset(name);
		}

		for (const name of names) {
			store.set(name, name);
			store.reset(name);
			assert.strictEqual(store.get(name), name);
		}
	});

	it('.reset() - key name that `Object.prototype` has, nested with dot notation', () => {
		const store = new Conf({cwd: createTempDirectory()});
		store.set('a', {b: 1});

		const names = ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__'];

		// A nested value is a plain JSON object, so it answers for the members `Object.prototype` has. None of these keys exists in the store.
		for (const name of [...names, 'constructor']) {
			assert.strictEqual(store.has(`a.${name}`), false, `has(\`a.${name}\`)`);
			assert.strictEqual(store.get(`a.${name}`), undefined, `get(\`a.${name}\`)`);
			assert.strictEqual(store.get(`a.${name}`, 'fallback'), 'fallback', `get(\`a.${name}\`, 'fallback')`);
		}

		// The value `Object.prototype` has for `toString` is a function, which cannot be stored, so reading it as a default must not turn into an error.
		for (const name of names) {
			store.reset(`a.${name}`);
		}

		assert.deepStrictEqual(store.get('a'), {b: 1});

		// The key does not exist, so this must create the array instead of reporting a key that holds a value which is not an array.
		store.appendToArray('a.toString', 'first');
		assert.deepStrictEqual(store.get('a.toString'), ['first']);
	});
});

describe('keys and values JSON is happy to hold but rarely sees', () => {
	const controlKey = `a${String.fromCodePoint(0)}b`;

	it('holds a key with a control character in it', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		conf.set(controlKey, 1);
		assert.strictEqual(conf.get(controlKey), 1);
		assert.deepStrictEqual({...conf.store}, {[controlKey]: 1});
		assert.deepStrictEqual(readConfigFile(conf.path), {[controlKey]: 1});
	});

	it('holds a key that is a lone surrogate', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		conf.set('\uD800', 1);
		assert.strictEqual(conf.get('\uD800'), 1);
		assert.deepStrictEqual({...conf.store}, {'\uD800': 1});
	});

	it('holds a value that is a lone surrogate', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		conf.set('a', '\uD800');
		assert.strictEqual(conf.get('a'), '\uD800');
	});
});

describe('a key the `defaults` and `schema` options cannot name', () => {
	// `__proto__`, `constructor` and `prototype` are the names the `accessPropertiesByDotNotation` option writes about, and a key the parser cannot read at all is refused the same way.
	it('refuses a `defaults` key the path parser cannot read', () => {
		assert.throws(() => {
			new Conf<Store>({cwd: createTempDirectory(), defaults: {'a[x': 1}});
		}, {name: 'TypeError', message: 'The `defaults` option cannot hold the key `a[x`, which is not a key a value can be written to.'});
	});

	it('refuses a `schema` key the path parser cannot read', () => {
		assert.throws(() => {
			new Conf<Store>({cwd: createTempDirectory(), schema: {'a[x': {type: 'number'}}});
		}, {name: 'TypeError', message: 'The `schema` option must not contain the key `a[x`, which is not a key a value can be written to.'});
	});

	// The bookkeeping is written at the top of the store, so a `__internal__` below it is the caller's own data, which cannot reach it.
	it('refuses a `schema` key that is the one the bookkeeping is kept under, at the top only', () => {
		assert.throws(() => {
			new Conf<Store>({cwd: createTempDirectory(), schema: {__internal__: {type: 'object'}}});
		}, {name: 'TypeError', message: 'The `schema` option must not contain the key `__internal__`, which is the one this module keeps its bookkeeping under.'});

		const nested = new Conf<Store>({
			cwd: createTempDirectory(),
			schema: {a: {type: 'object', properties: {__internal__: {type: 'object'}}}},
		});
		assert.deepStrictEqual({...nested.store}, {});

		const nestedDefault = new Conf<Store>({cwd: createTempDirectory(), defaults: {'a.__internal__': 1}});
		assert.deepStrictEqual({...nestedDefault.store}, {a: {__internal__: 1}});
	});
});

describe('an index in a key', () => {
	// An index addresses an element of an array, and an index past the last element grows the array, since a JSON file holds the gap between the elements as `null` and there is no other way to hold it.
	it('grows the array it addresses past the last element, and writes the gap as `null`', () => {
		const config = new Conf<Store>({cwd: createTempDirectory()});
		config.set('items', ['a', 'b']);

		assert.deepStrictEqual(config.get('items.0'), 'a');

		config.set('items.3', 'd');

		const expected = {items: ['a', 'b', null, 'd']};
		assert.deepStrictEqual({...config.store}, expected);
		assert.deepStrictEqual(readConfigFile(config.path) as Store, expected, 'the file holds the gap as `null`');
	});
});

describe('reset() of a path through a value the store holds', () => {
	// A reset writes the default the way `set()` writes a value, so a value in the way of the path is replaced where `set()` replaces it, and refused where `set()` refuses it.
	it('replaces a value that holds no keys, the way `set()` does', () => {
		const config = trackConf(new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {'a.b': 1}}));
		config.set('a', 'text');

		config.reset('a.b');
		assert.deepStrictEqual(config.get('a'), {b: 1});
	});

	it('refuses a name below an array, the way `set()` does', () => {
		const config = trackConf(new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {'a.length.b': 1}}));
		config.set('a', [1, 2]);

		assert.throws(() => {
			config.reset('a.length.b');
		}, {name: 'TypeError', message: /only holds the elements of an array/});
		assert.deepStrictEqual(config.get('a'), [1, 2]);
	});
});

describe('dot notation', () => {
	it('an escaped dot is a key of its own', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a.b', 1);
		conf.set(String.raw`a\.b`, 2);

		assert.strictEqual(conf.get('a.b'), 1);
		assert.strictEqual(conf.get(String.raw`a\.b`), 2);

		// Deleting one leaves the other.
		conf.delete(String.raw`a\.b`);
		assert.strictEqual(conf.get(String.raw`a\.b`), undefined);
		assert.strictEqual(conf.get('a.b'), 1);
	});

	it('an index written in another form reaches the same element', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('list.0', 'a');
		conf.set('list[1]', 'b');

		assert.deepStrictEqual(conf.get('list'), ['a', 'b']);
		assert.strictEqual(conf.get('list[0]'), 'a');
		assert.strictEqual(conf.get('list[1]'), 'b');
		assert.strictEqual(conf.has('list[1]'), true);

		// An index past the last element is not a key.
		assert.strictEqual(conf.has('list[2]'), false);

		conf.delete('list[0]');
		assert.deepStrictEqual(conf.get('list'), ['b']);

		// A segment with a leading zero is a name, not an index, so the path creates an object.
		conf.set('nums.01', 'leading zero');
		assert.deepStrictEqual(conf.get('nums'), {'01': 'leading zero'});
		assert.strictEqual(conf.get('nums.01'), 'leading zero');

		// A bracket reaches an element of an array the path creates as well.
		conf.set('matrix[0]', []);
		conf.appendToArray('matrix[0]', 1);
		assert.deepStrictEqual(conf.get('matrix'), [[1]]);
	});

	it('.delete() - a key of an array that is not an element', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('list', ['x', 'y']);

		// An index past the last element, and a name an array cannot hold, are both keys it does not have.
		conf.delete('list.5');
		conf.delete('list.notAnIndex');
		assert.deepStrictEqual(conf.get('list'), ['x', 'y']);

		// Deleting the last element leaves an empty array.
		conf.set('items', ['only']);
		conf.delete('items.0');
		assert.deepStrictEqual(conf.get('items'), []);
	});

	it('.delete() - an element of an array', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		conf.set('items', ['a', 'b', 'c']);

		// An array cannot hold the hole a plain delete leaves. It is written as `null`, which adds an element the store never held, and `has()` then reports it as an item.
		conf.delete('items.1');
		assert.deepStrictEqual(conf.get('items'), ['a', 'c']);
		assert.strictEqual(conf.get('items.1'), 'c');
		assert.strictEqual(conf.get('items.2'), undefined);
		assert.strictEqual(conf.has('items.2'), false);

		// The bracket form reaches the same element.
		conf.delete('items[0]');
		assert.deepStrictEqual(conf.get('items'), ['c']);

		// A second instance reads the same array back.
		assert.deepStrictEqual(new Conf({cwd}).get('items'), ['c']);
	});

	it('a member of an array that is not an element is not an item', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('items', ['a', 'b']);

		// An array answers for `length`, but an item is a value the store holds, and a JSON file holds only the elements.
		assert.strictEqual(conf.has('items.length'), false);
		assert.strictEqual(conf.get('items.length'), undefined);

		// It cannot be written either, since an array holds nothing but its elements. Writing an index on the array grows it, and the gap is written as `null`.
		assert.throws(() => {
			conf.set('items.length', 4);
		}, {message: /only holds the elements of an array/});
		assert.throws(() => {
			conf.set('items.other', 'x');
		}, {message: /only holds the elements of an array/});

		// Nor deleted, where a plain delete throws a raw error for `length`.
		conf.delete('items.length');
		assert.deepStrictEqual(conf.get('items'), ['a', 'b']);
	});

	it('an empty key is an item', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('', 'empty');

		assert.strictEqual(conf.get(''), 'empty');
		assert.strictEqual(conf.has(''), true);
		assert.deepStrictEqual(Object.keys(conf.store), ['']);

		conf.delete('');
		assert.strictEqual(conf.has(''), false);
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
	});
});

describe('refused keys', () => {
	it('ignores a key `dot-prop` refuses', () => {
		const store = new Conf({cwd: createTempDirectory()});

		// A path that holds one of these names could reach the prototype, so `dot-prop` refuses it, and a write or a delete of one is left alone.
		for (const key of ['__proto__', 'constructor', 'prototype']) {
			store.set(key, 1);
			store.delete(key);
		}

		assert.deepStrictEqual(store.store, createNullProtoObject({}));
	});

	it('reports a key that cannot be parsed', () => {
		const store = new Conf({cwd: createTempDirectory()});

		// A key that cannot be read as a path is reported by the write or the delete itself, which is where the path is used, and the report names the key rather than leaving the parser to describe what it choked on.
		const runs = [
			() => {
				store.set('a[0', 1);
			},
			() => {
				store.delete('a[0');
			},
			() => {
				store.get('a[0');
			},
			() => {
				store.has('a[0');
			},
			() => {
				store.appendToArray('a[0', 1);
			},
		];

		for (const run of runs) {
			assert.throws(run, {name: 'TypeError', message: 'The key `a[0` is not a key a value can be written to.'});
		}

		assert.deepStrictEqual(store.store, createNullProtoObject({}));
	});
});

describe('reset', () => {
	// Every key is checked before any of them is reset, so a key the store cannot take leaves the store as it was, which the keys reset before it would break.
	it('leaves the store as it was when a later key cannot be written', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {good: 'DEFAULT', other: 'OTHER'}});
		conf.set('good', 'user value');
		conf.set('other', 'user value');

		assert.throws(() => {
			conf.reset('good', 'a[0');
		}, {name: 'TypeError', message: 'The key `a[0` is not a key a value can be written to.'});

		assert.deepStrictEqual(conf.store, createNullProtoObject({good: 'user value', other: 'user value'}));
		assert.strictEqual(fs.readFileSync(conf.path, 'utf8').includes('DEFAULT'), false);
	});
});

describe('a literal key that names a path', () => {
	// An escaped dot writes a key of its own, which is how a key that looks like a path is written as a literal one. It is reachable through the same spelling, the way it was written.
	it('is reachable through the escaped spelling, the way `set()` writes it', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set(String.raw`a\.b`, 1);
		assert.strictEqual(conf.get(String.raw`a\.b`), 1);
		assert.strictEqual(conf.get('a.b'), undefined);
		assert.strictEqual(conf.has(String.raw`a\.b`), true);

		conf.delete(String.raw`a\.b`);
		assert.strictEqual(conf.has(String.raw`a\.b`), false);
	});

	it('survives a whole-store write unchanged', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set(String.raw`a\.b`, 1);
		conf.set('other', 2);
		assert.deepStrictEqual({...conf.store}, {'a.b': 1, other: 2});
		assert.strictEqual(conf.get(String.raw`a\.b`), 1);
	});

	it('keeps a literal key that names a path without dot notation', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
		conf.store = {'a.b': 1};
		assert.strictEqual(conf.get('a.b'), 1);
		assert.strictEqual(conf.has('a.b'), true);
	});
});

describe('reset() of a path the store holds a value in the way of', () => {
	for (const held of ['a string', 5, null, true]) {
		it(`replaces a parent that holds ${JSON.stringify(held)}`, () => {
			const cwd = createTempDirectory();
			fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: held}));
			const conf = new Conf<Record<string, any>>({cwd, defaults: {'a.b': 'the default'}});

			conf.reset('a.b');
			assert.deepStrictEqual({...conf.store}, {a: {b: 'the default'}});
		});
	}

	it('still resets a path the store can take', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: {c: 1}}));
		const conf = new Conf<Record<string, any>>({cwd, defaults: {'a.b': 'the default'}});

		conf.delete('a.b');
		conf.reset('a.b');
		assert.deepStrictEqual(conf.get('a'), {c: 1, b: 'the default'});
	});
});

describe('reset() of a key with nothing to reset', () => {
	it('leaves a key that has no default alone however the store holds its path', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: 'text', kept: true}));
		const conf = new Conf<Record<string, any>>({cwd, defaults: {other: 'DEFAULT'}});

		// There is nothing to write for `a.b`, so the value the store holds at `a` is not a path that has to be written through.
		conf.reset('a.b');
		assert.deepStrictEqual({...conf.store}, {a: 'text', kept: true, other: 'DEFAULT'});
	});
});

describe('a reserved key', () => {
	afterEach(() => {
		// A leak would reach every plain object in the process, so the check is made on one of them.
		assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
		assert.strictEqual(Object.getPrototypeOf({}), Object.prototype);
	});

	it('cannot be written through a path that names it', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});

		// A path with one of these names in it could reach the prototype, so `dot-prop` refuses it and a write or a delete of one is left alone. A key that spells itself with a backslash is the name behind the backslash, so that spelling reaches the bookkeeping as well and is refused too.
		for (const key of ['__proto__', 'a.__proto__', 'a.constructor.prototype.polluted', 'constructor', 'prototype', String.raw`\__proto__`]) {
			conf.set(key, {polluted: true});
			conf.delete(key);
		}

		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
	});

	it('is refused by a `defaults` key that reaches it, the way `set()` refuses one', () => {
		assert.throws(() => new Conf({
			cwd: createTempDirectory(),
			defaults: {'__internal__.migrations.version': '9.9.9'},
		}), {name: 'TypeError', message: /Please don't use the __internal__ key/});
	});

	it('below the top of the store belongs to the caller', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {a: {__internal__: 'DEFAULT'}}});

		// The bookkeeping is written at the top of the store, so the same name below it is an ordinary key, whichever of the ways to write it the caller uses.
		assert.deepStrictEqual({...conf.store}, {a: {__internal__: 'DEFAULT'}});
		assert.strictEqual(conf.get('a.__internal__'), 'DEFAULT');
		assert.strictEqual(conf.size, 1);

		conf.set('b.__internal__', 'set as a path');
		conf.set({c: {__internal__: 'set with an object'}});
		assert.strictEqual(conf.get('b.__internal__'), 'set as a path');
		assert.strictEqual(conf.get('c.__internal__'), 'set with an object');

		// It is not the bookkeeping, so nothing that reads the store treats it as one.
		assert.strictEqual((conf.store as Record<string, unknown>).__internal__, undefined);
		assert.strictEqual(conf.size, 3);
	});

	it('below the top of a `schema` belongs to the caller', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			// The `defaults` option is what brings `a` into being, which is what lets the `default` of the schema below it apply.
			defaults: {a: {}},
			schema: {a: {type: 'object', properties: {__internal__: {type: 'number', default: 1}}}},
		});

		assert.deepStrictEqual({...conf.store}, {a: {__internal__: 1}});
		assert.strictEqual(conf.get('a.__internal__'), 1);
		assert.strictEqual((conf.store as Record<string, unknown>).__internal__, undefined);
	});

	it('refuses a key that reaches the bookkeeping, and leaves one beside it alone', () => {
		const reserved = [
			'__internal__',
			'__internal__.migrations.version',
			'__internal__[0]',
			String.raw`\__internal__`,
			String.raw`\__internal__.migrations.version`,
			String.raw`__internal__\.migrations`,
		];

		const allowed = [
			'__internal__x',
			'x__internal__',
			'a.__internal__',
			'__internal_',
			'internal',
			String.raw`\a`,
			String.raw`a\\`,
		];

		for (const key of reserved) {
			const config = new Conf({cwd: createTempDirectory()});
			assert.throws(
				() => {
					config.set(key, 1);
				},
				{message: /__internal__/},
				`the key ${JSON.stringify(key)} reaches the bookkeeping and is refused`,
			);
		}

		for (const key of allowed) {
			const config = new Conf({cwd: createTempDirectory()});
			config.set(key, 1);
			assert.equal(config.get(key), 1, `the key ${JSON.stringify(key)} is the caller's own and is written`);
		}
	});

	it('refuses the bookkeeping key of a store that holds the bookkeeping, and leaves one beside it alone', () => {
		const cwd = createTempDirectory();
		const config = new Conf({
			cwd,
			configName: 'reserved-delete',
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'() {
					// Nothing runs, since the file does not exist yet and the store only records the version.
				},
			},
		});
		config.set('a', 1);

		assert.throws(
			() => {
				config.delete('__internal__');
			},
			{message: /__internal__/},
		);

		// A key beside the bookkeeping is the caller's own, and the bookkeeping is untouched by writing it.
		config.set('__internal__x', 1);
		assert.equal(getMigrationVersion(config), '1.0.0');
		assert.equal(config.get('__internal__x'), 1);
	});
});

describe('a key whose value a store cannot hold', () => {
	it('is not an item when it holds `undefined`', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			serialize: value => JSON.stringify(value),
			// A custom deserializer can hand back a value JSON cannot, and an own key holding it counts as missing the same way a key that is not there does.
			deserialize: () => ({missing: undefined, shown: 1}),
		});
		conf.store = {trigger: 1};

		assert.strictEqual(conf.get('missing'), undefined);
		assert.strictEqual(conf.get('missing', 'the fallback'), 'the fallback');
		assert.strictEqual(conf.has('missing'), false);
		assert.strictEqual(conf.has('shown'), true);
		assert.strictEqual(conf.size, 1);
		assert.deepStrictEqual([...conf].map(([key]) => key), ['shown']);
	});

	it('is refused by `appendToArray()`, which cannot append to it', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set('a', {b: 'text'});

		assert.throws(() => {
			conf.appendToArray('a.b', 'appended');
		}, {name: 'TypeError', message: 'The key `a.b` is already set to a non-array value'});

		// The key is missing rather than an array, so the value is created as one.
		conf.appendToArray('a.c', 'appended');
		assert.deepStrictEqual({...conf.store}, {a: {b: 'text', c: ['appended']}});
	});
});

describe('a `defaults` key that spells itself', () => {
	it('is written, reset, and cleared under the name behind the backslash', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {[String.raw`a\.b`]: 'DEFAULT'}});

		// The defaults are recorded under the name the store holds the item as, which is not a path.
		assert.deepStrictEqual({...conf.store}, {'a.b': 'DEFAULT'});
		assert.strictEqual(conf.get(String.raw`a\.b`), 'DEFAULT');
		assert.strictEqual(conf.get('a.b'), undefined);

		conf.set(String.raw`a\.b`, 'USER');
		conf.reset(String.raw`a\.b`);
		assert.strictEqual(conf.get(String.raw`a\.b`), 'DEFAULT');

		conf.set('other', 1);
		conf.clear();
		assert.deepStrictEqual({...conf.store}, {'a.b': 'DEFAULT'});
		assert.strictEqual(conf.get(String.raw`a\.b`), 'DEFAULT');
	});
});

describe('a path through a value that writes itself', () => {
	// A `Date` writes itself as its ISO string, so it holds no keys as far as the config file is concerned. Copying one along the path is what left a `Date` with nothing behind it, and writing the store then failed inside `JSON.stringify` with an error from the engine rather than one from this module.
	it('leaves a `Date` the `defaults` option holds as it is', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			defaults: {a: new Date(0), 'a.b': 'DEFAULT'},
		});

		// The path below it is left alone, the way a path below a string is, and the store keeps the value the file holds for it.
		assert.deepStrictEqual({...conf.store}, {a: '1970-01-01T00:00:00.000Z'});
		assert.strictEqual(conf.get('a.b'), undefined);
	});

	it('refuses to reset a path through a `Date` the store holds, the way `set()` does', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			serialize: value => JSON.stringify(value),
			// A custom deserializer is the other way a value the file does not hold as a container reaches a store, since the file itself is read back as JSON.
			deserialize: () => ({a: new Date(0)}),
			defaults: {'a.b': 'the default'},
		});

		assert.throws(() => {
			conf.reset('a.b');
		}, {name: 'TypeError', message: /cannot be set, since the value the store holds for it cannot be written through/});

		assert.deepStrictEqual(conf.get('a'), new Date(0));
	});
});

describe('reset()', () => {
	it('leaves a key it resets alone when a key after it is not a valid path', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			defaults: {a: 'A'},
		});
		conf.set('a', 'user');

		// `a` is reset first, so it can only be left as it was if `b[x` is refused before it.
		assert.throws(() => {
			conf.reset('a', 'b[x');
		}, {name: 'TypeError', message: /not a key a value can be written to/});

		assert.deepStrictEqual({...conf.store}, {a: 'user'});
	});
});

describe('a key the path parser refuses', () => {
	// `dot-prop` refuses some keys by answering with no parts at all, such as `__proto__`, and others by throwing, such as an index it never closes. Both are a key no value can be written through, and neither may reach a caller as the parser's own error.
	const unparseableKeys = ['a[x', 'a[', '[', 'a[-1]', 'a[1.5]', 'a[[0]]', 'a[0'];

	it('is refused in the `defaults` option with a message of this module\'s own', () => {
		for (const key of unparseableKeys) {
			assert.throws(
				() => new Conf({cwd: createTempDirectory(), defaults: {[key]: 'a value'}}),
				{name: 'TypeError', message: /`defaults` option cannot hold the key/},
				key,
			);
		}
	});

	it('is refused in a `schema` as a key of its own that is not one', () => {
		for (const key of unparseableKeys) {
			assert.throws(
				() => new Conf({cwd: createTempDirectory(), schema: {[key]: {type: 'number'}}}),
				{name: 'TypeError', message: /`schema` option must not contain the key/},
				key,
			);
		}
	});

	it('is reported by every method that takes a key, with a message naming the key', () => {
		// The parser's own error names neither the key nor what the store was asked to do with it, so a caller is told which key of theirs the store could not read.
		for (const key of unparseableKeys) {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
			conf.set('a', {b: 1});

			const attempts: Array<[string, () => void]> = [
				['get', () => {
					conf.get(key);
				}],
				['has', () => {
					conf.has(key);
				}],
				['set', () => {
					conf.set(key, 1);
				}],
				['delete', () => {
					conf.delete(key);
				}],
				['appendToArray', () => {
					conf.appendToArray(key, 1);
				}],
				['reset', () => {
					conf.reset(key);
				}],
			];

			for (const [name, run] of attempts) {
				assert.throws(run, {name: 'TypeError', message: `The key \`${key}\` is not a key a value can be written to.`}, `${name} for ${key}`);
			}

			assert.deepStrictEqual({...conf.store}, {a: {b: 1}}, `store after ${key}`);
		}
	});

	it('is left alone where a key the parser names no parts for is, since the two are not the same', () => {
		// A key a path could reach the prototype through is one a write skips, so a key the parser simply cannot read is reported rather than skipped.
		for (const key of ['__proto__', 'constructor', 'prototype']) {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
			conf.set('a', {b: 1});

			assert.strictEqual(conf.get(key, 'the default'), 'the default', `get for ${key}`);
			assert.strictEqual(conf.has(key), false, `has for ${key}`);

			conf.set(key, 1);
			conf.appendToArray(key, 1);
			conf.delete(key);
			conf.reset(key);

			assert.deepStrictEqual({...conf.store}, {a: {b: 1}}, `store after writing ${key}`);
		}
	});

	it('is a key the store holds nothing under without dot notation too, where a key is the whole key', () => {
		for (const key of unparseableKeys) {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
			conf.set('a', {b: 1});

			// Without dot notation a key is written as it is, so the key is an ordinary one, the same as every other method already treats it.
			conf.set(key, 1);

			assert.strictEqual(conf.get(key), 1, `get for ${key}`);
			assert.deepStrictEqual({...conf.store}, {a: {b: 1}, [key]: 1}, `store after writing ${key}`);

			conf.delete(key);

			assert.deepStrictEqual({...conf.store}, {a: {b: 1}}, `store after deleting ${key}`);
		}
	});

	it('is a key a `defaults` value cannot be written to, which is reported where the option is read', () => {
		for (const key of unparseableKeys) {
			// Without dot notation a key is a key of its own, so the option takes it as one and the store holds it.
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), accessPropertiesByDotNotation: false, defaults: {[key]: 'the default'}});

			assert.strictEqual(conf.get(key), 'the default', `get for ${key}`);

			conf.set(key, 'disturbed');
			conf.reset(key);

			assert.strictEqual(conf.get(key), 'the default', `reset for ${key}`);
		}
	});

	// A read is a write where the file is one `clearInvalidConfig` clears, so a key the write refuses is asked about before the file is read, the way `set()` asks it. A key the caller got wrong is a question about the key and not about the store, so it is asked first by every method that takes one.
	it('leaves a file the `clearInvalidConfig` option would clear as it is', () => {
		const attempts: Array<[string, string, (config: Store) => void]> = [
			['set', 'a[x', config => {
				config.set('a[x', 1);
			}],
			['set(object)', 'b[y', config => {
				config.set({ok: 1, 'b[y': 2});
			}],
			['reset', 'a[x', config => {
				config.reset('a[x');
			}],
			['delete', 'a[x', config => {
				config.delete('a[x');
			}],
			['appendToArray', 'a[x', config => {
				config.appendToArray('a[x', 1);
			}],
		];

		for (const [name, key, run] of attempts) {
			const cwd = createTempDirectory();
			const config = new Conf<Store>({cwd, clearInvalidConfig: true});
			config.set('seed', 1);

			// A file cut in the middle, which is what a crash part-way through the in-place write leaves behind, and what a text editor saving over it can leave.
			const configPath = path.join(cwd, 'config.json');
			fs.writeFileSync(configPath, '{"seed": 1');
			const before = fs.readFileSync(configPath, 'utf8');

			assert.throws(() => {
				run(config);
			}, {name: 'TypeError', message: `The key \`${key}\` is not a key a value can be written to.`}, name);

			assert.strictEqual(fs.readFileSync(configPath, 'utf8'), before, `the file after ${name}`);
		}
	});
});

describe('a name `dot-prop` refuses', () => {
	// `dot-prop` refuses these because a path that holds one could reach the prototype, and it cannot know that the store it writes has no prototype to reach. A key that ends in a dot, and a key with an index it never closes, are refused as well, and the first are left alone where the second are reported.
	const refusedNames = ['__proto__', 'constructor', 'prototype'];

	it('is left alone by every method that takes a key with dot notation on', () => {
		for (const key of refusedNames) {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
			conf.set('a', {b: 1});

			// The value is dropped without a word, so a caller who writes one of these names has to be told about it.
			assert.strictEqual(conf.get(key, 'the default'), 'the default', `get for ${key}`);
			assert.strictEqual(conf.has(key), false, `has for ${key}`);

			conf.set(key, 'written');
			conf.appendToArray(key, 'written');
			conf.delete(key);
			conf.reset(key);

			assert.deepStrictEqual({...conf.store}, {a: {b: 1}}, `store after writing ${key}`);
		}
	});

	it('is a key of its own without dot notation, where no path is read', () => {
		for (const key of refusedNames) {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});

			// The store has no prototype to reach, so the name the parser refuses for is a name the store can hold, and it is held under exactly that name.
			conf.set(key, 'written');

			assert.strictEqual(conf.get(key), 'written', `get for ${key}`);
			assert.strictEqual(conf.has(key), true, `has for ${key}`);

			conf.delete(key);

			assert.strictEqual(conf.has(key), false, `has for ${key} after delete`);
		}
	});

	it('is refused by the `defaults` option and by a `schema` with a message that names the option', () => {
		for (const key of refusedNames) {
			assert.throws(
				() => new Conf({cwd: createTempDirectory(), defaults: {[key]: 'a value'}}),
				{name: 'TypeError', message: /`defaults` option cannot hold the key/},
				key,
			);

			assert.throws(
				() => new Conf({cwd: createTempDirectory(), schema: {[key]: {type: 'number'}}}),
				{name: 'TypeError', message: /`schema` option must not contain the key/},
				key,
			);
		}
	});
});

describe('a name `dot-prop` refuses without dot notation', () => {
	// With dot notation off nothing is read as a path, so the names a path cannot hold are keys of their own in the options too, which is what the paragraph of the readme about them now says rather than the opposite.
	it('is a key the `defaults` and `schema` options take without dot notation, as they do with it on', () => {
		for (const key of ['__proto__', 'constructor', 'prototype']) {
			const conf = new Conf<Record<string, any>>({
				cwd: createTempDirectory(),
				accessPropertiesByDotNotation: false,
				defaults: {[key]: 'the default'},
				schema: {[key]: {type: 'string'}},
			});

			assert.strictEqual(conf.get(key), 'the default', `get for ${key}`);

			conf.set(key, 'written');
			conf.reset(key);

			assert.strictEqual(conf.get(key), 'the default', `reset for ${key}`);
		}
	});
});

describe('keys without dot notation', () => {
	it('round-trips keys with newlines and tabs literally without dot-notation', () => {
		const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
		conf.set('line1\nline2', 1);
		conf.set('col1\tcol2', 2);
		assert.strictEqual(conf.get('line1\nline2'), 1);
		assert.strictEqual(conf.get('col1\tcol2'), 2);
	});

	it('delete() with dot-notation false leaves nested objects alone', () => {
		const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
		conf.set('a', {b: 1});
		conf.delete('a.b');
		assert.deepStrictEqual(conf.get('a'), {b: 1});
		assert.strictEqual(conf.has('a.b'), false);
	});

	it('has() with dot-notation false is literal', () => {
		const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
		conf.set('a', {b: 1});
		assert.strictEqual(conf.has('a.b'), false);
		conf.set('a.b', 'literal');
		assert.strictEqual(conf.has('a.b'), true);
	});
});

describe('a key with a dot in it without dot notation', () => {
	it('is written beside a `Date` the store holds under its first part, the same through `set(object)` as through `set(key, value)`', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), accessPropertiesByDotNotation: false, ...dateReviving});
		conf.set('lastRun', new Date('2020-01-01T00:00:00.000Z'));

		conf.set('lastRun.note', 'one key');
		conf.set({'lastRun.note': 'an object'});

		assert.ok(conf.get('lastRun') instanceof Date);
		assert.strictEqual(conf.get('lastRun.note'), 'an object');
	});
});
