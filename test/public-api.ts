/* eslint-disable @typescript-eslint/naming-convention */
import fs from 'node:fs';
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	resetTrackedConfs,
	runRegisteredCleanups,
	readConfigFile,
} from './_utilities.js';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('public API', () => {
	afterEach(() => {
		resetTrackedConfs();
		runRegisteredCleanups();
	});
	describe('.set()', () => {
		it('throws the key type error for a `null` key', () => {
			const conf = new Conf({cwd: createTempDirectory()});

			// `null` is named in the message as itself rather than as the object its `typeof` gives, which would read wrong next to a list of accepted types.
			for (const [key, type] of [[null, 'null'], [undefined, 'undefined'], [1, 'number'], [true, 'boolean']] as Array<[unknown, string]>) {
				assert.throws(() => {
					// @ts-expect-error: Testing the runtime check for an invalid key.
					conf.set(key, 'value');
				}, {message: 'Expected `key` to be of type `string` or `object`, got ' + type});
			}

			assert.strictEqual(conf.size, 0);
		});

		it('writes `NaN` inside an object as `null`, the way `JSON.stringify` does', () => {
			const conf = new Conf({cwd: createTempDirectory()});
			conf.set({foo: Number.NaN});
			assert.strictEqual(conf.get('foo'), null);
		});

		it('stores every value type JSON can hold', () => {
			const conf = new Conf({cwd: createTempDirectory()});
			const values: Record<string, unknown> = {
				string: '🦄',
				emptyString: '',
				number: 1.5,
				negativeNumber: -1,
				zero: 0,
				big: Number.MAX_SAFE_INTEGER,
				boolean: false,
				null: null,
				array: [1, 'two', {three: 3}],
				emptyArray: [],
				object: {nested: {value: true}},
				emptyObject: {},
			};

			for (const [key, value] of Object.entries(values)) {
				conf.set(key, value);
			}

			assert.deepStrictEqual(readConfigFile(conf), values);
			assert.deepStrictEqual([...conf], Object.entries(values));
			assert.strictEqual(conf.size, Object.keys(values).length);
		});

		it('does not change the object it is given', () => {
			const conf = new Conf({cwd: createTempDirectory()});
			const object = {foo: 'bar', nested: {count: 1}};

			conf.set(object);

			assert.deepStrictEqual(object, {foo: 'bar', nested: {count: 1}});
		});

		it('does not let a later change to a value reach the store', () => {
			const conf = new Conf({cwd: createTempDirectory()});
			const value = {nested: {count: 1}};
			conf.set('value', value);

			value.nested.count = 2;

			assert.deepStrictEqual(conf.get('value'), {nested: {count: 1}});
		});

		it('does not let a change to the value `get()` returned reach the store', () => {
			const conf = new Conf({cwd: createTempDirectory()});
			conf.set('value', {nested: {count: 1}});
			const value = conf.get('value') as {nested: {count: number}};

			value.nested.count = 2;

			assert.deepStrictEqual(conf.get('value'), {nested: {count: 1}});
			assert.deepStrictEqual(readConfigFile(conf), {value: {nested: {count: 1}}});
		});

		it('sets several items from one object with a single write', () => {
			const conf = new Conf({cwd: createTempDirectory()});

			conf.set({foo: 'bar', nested: {count: 1}});

			assert.deepStrictEqual(readConfigFile(conf), {foo: 'bar', nested: {count: 1}});
		});
	});

	describe('an object argument whose keys name each other', () => {
		// A key that names a path has to be written after a key it is a prefix of, or it replaces what that key filled in. And a write into a container has to be a write into a copy of it, or it lands on an object the caller still holds. The `defaults` option does both already, through the same two helpers.
		it('keeps both keys, whichever order the caller wrote them in', () => {
			for (const [name, given] of [
				['the path first', {'a.c': 2, a: {b: 1}}],
				['the value first', {a: {b: 1}, 'a.c': 2}],
			] as Array<[string, Record<string, unknown>]>) {
				const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});

				conf.set(given);

				assert.deepStrictEqual({...conf.store}, {a: {b: 1, c: 2}}, name);
			}
		});

		it('leaves the value the caller gave alone, since the store holds a copy of it', () => {
			const inner = {b: 1};
			const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});

			conf.set({a: inner, 'a.c': 2});

			assert.deepStrictEqual(inner, {b: 1}, 'the object the caller still holds is not the one the path was written into');
			assert.deepStrictEqual({...conf.store}, {a: {b: 1, c: 2}});
			assert.notStrictEqual(conf.get('a'), inner, 'the store holds a copy rather than the caller value');
		});

		it('leaves the value the caller gave alone even when the write is then refused', () => {
			// The refusal happens after the store has been written into, so a write that landed on the caller own object would have changed it even though the call said the value was not written.
			const inner = {b: 1};
			const conf = new Conf<Record<string, unknown>>({
				cwd: createTempDirectory(),
				schema: {a: {type: 'object', additionalProperties: false}},
			});

			assert.throws(() => {
				conf.set({a: inner, 'a.c': 2});
			}, {name: 'Error', message: /Config schema violation/});

			assert.deepStrictEqual(inner, {b: 1}, 'a refused write does not change the object the caller gave');
		});

		it('writes an object argument of whole keys as it is', () => {
			const given = {x: {y: 1}, z: 2};
			const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});

			conf.set(given);

			assert.deepStrictEqual({...conf.store}, {x: {y: 1}, z: 2});
			assert.deepStrictEqual(given, {x: {y: 1}, z: 2}, 'and the object the caller gave is not written into');
		});
	});

	describe('.has()', () => {
		it('agrees with `get()` and `.size` for every value', () => {
			const conf = new Conf({cwd: createTempDirectory()});
			conf.set({
				null: null,
				false: false,
				zero: 0,
				emptyString: '',
				list: [],
				object: {},
			});

			for (const key of ['null', 'false', 'zero', 'emptyString', 'list', 'object']) {
				assert.ok(conf.has(key), key);
				assert.notStrictEqual(conf.get(key), undefined, key);
			}

			assert.ok(!conf.has('missing'));
			assert.strictEqual(conf.get('missing', 'default'), 'default');
			assert.strictEqual(conf.size, 6);
		});

		it('is false for a nested key the store does not hold', () => {
			const conf = new Conf({cwd: createTempDirectory()});
			conf.set('nested.value', 1);

			assert.ok(conf.has('nested'));
			assert.ok(conf.has('nested.value'));
			assert.ok(!conf.has('nested.missing'));
			assert.ok(!conf.has('missing.value'));
		});

		it('is false for the reserved key, which the store does not expose', () => {
			const cwd = createTempDirectory();
			fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({__internal__: {migrations: {version: '1.0.0'}}, foo: 1}, undefined, '\t'));
			const conf = new Conf({cwd});

			assert.ok(!conf.has('__internal__'));
			assert.ok(!conf.has('__internal__.migrations.version'));
			assert.strictEqual(conf.get('__internal__'), undefined);
			assert.strictEqual(conf.get('__internal__', 'default'), 'default');
			assert.strictEqual(conf.size, 1);
			assert.deepStrictEqual([...conf], [['foo', 1]]);
			assert.deepStrictEqual(Object.keys(conf.store), ['foo']);
		});
	});

	describe('.delete()', () => {
		it('throws for the reserved key instead of rewriting the store with it intact', () => {
			const cwd = createTempDirectory();
			// The store keeps its own bookkeeping under a key it reserves for itself, so deleting any part of it would make the next run start over.
			fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({__internal__: {migrations: {version: '1.0.0'}}, foo: 1}, undefined, '\t'));
			const conf = new Conf({cwd});

			for (const key of ['__internal__', '__internal__.migrations', '__internal__.migrations.version']) {
				assert.throws(() => {
					conf.delete(key);
				}, {message: /Please don't use the __internal__ key/});
			}

			assert.deepStrictEqual(readConfigFile(conf), {__internal__: {migrations: {version: '1.0.0'}}, foo: 1});
			assert.strictEqual(conf.get('foo'), 1);
		});

		it('deletes a nested key and leaves its siblings alone', () => {
			const conf = new Conf({cwd: createTempDirectory()});
			conf.set('nested', {value: 1, other: 2});

			conf.delete('nested.value');

			assert.deepStrictEqual(readConfigFile(conf), {nested: {other: 2}});
			assert.ok(!conf.has('nested.value'));
			assert.ok(conf.has('nested.other'));
		});

		it('leaves an empty store behind after deleting the last key', () => {
			const conf = new Conf({cwd: createTempDirectory()});
			conf.set('foo', {nested: 1});

			conf.delete('foo');

			assert.deepStrictEqual(readConfigFile(conf), {});
			assert.strictEqual(conf.size, 0);
			assert.deepStrictEqual([...conf], []);
			assert.ok(fs.existsSync(conf.path));
		});

		it('deletes a key that holds a whole key with dot notation off', () => {
			const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
			conf.set({'nested.value': 1, other: 2});

			conf.delete('nested.value');

			assert.deepStrictEqual(readConfigFile(conf), {other: 2});
			assert.ok(!conf.has('nested.value'));
			assert.ok(!conf.has('nested'));
		});
	});

	describe('.clear()', () => {
		it('leaves the same store a newly constructed instance would', () => {
			const cwd = createTempDirectory();
			const conf = new Conf({cwd, defaults: {'foo.bar': 1, baz: 2}});
			const asConstructed = readConfigFile(conf);
			const asConstructedGet = conf.get('foo.bar');

			conf.set('extra', true);
			conf.clear();

			assert.deepStrictEqual(readConfigFile(conf), asConstructed);
			assert.strictEqual(conf.get('foo.bar'), asConstructedGet);
			assert.deepStrictEqual(conf.store, new Conf({cwd, defaults: {'foo.bar': 1, baz: 2}}).store);
		});

		it('leaves the same store a newly constructed instance would, with dot notation off', () => {
			const cwd = createTempDirectory();
			const conf = new Conf({cwd, accessPropertiesByDotNotation: false, defaults: {'foo.bar': 1, baz: 2}});

			conf.set('extra', true);
			conf.clear();

			assert.deepStrictEqual(readConfigFile(conf), {'foo.bar': 1, baz: 2});
		});

		it('resets a nested `defaults` value', () => {
			const cwd = createTempDirectory();
			const conf = new Conf({cwd, defaults: {foo: {bar: 1}, baz: 2}});

			conf.set('foo.bar', 5);
			conf.set('extra', true);
			conf.clear();

			assert.deepStrictEqual(readConfigFile(conf), {foo: {bar: 1}, baz: 2});
			assert.deepStrictEqual(conf.store, new Conf({cwd, defaults: {foo: {bar: 1}, baz: 2}}).store);
		});

		it('resets a `schema` default', () => {
			const cwd = createTempDirectory();
			const conf = new Conf({cwd, schema: {foo: {type: 'number', default: 1}}});

			conf.set('foo', 5);
			conf.set('extra', true);
			conf.clear();

			assert.deepStrictEqual(readConfigFile(conf), {foo: 1});
			assert.strictEqual(conf.size, 1);
			assert.deepStrictEqual([...conf], [['foo', 1]]);
		});
	});

	describe('.reset()', () => {
		it('resets a whole key that holds a dot with dot notation off', () => {
			const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false, defaults: {'nested.value': 1}});
			conf.set('nested.value', 5);

			conf.reset('nested.value');

			assert.deepStrictEqual(readConfigFile(conf), {'nested.value': 1});
		});
	});
	// A read is a write when the file is one `clearInvalidConfig` clears, so anything refused after a read has already put the store that was there out of the file. Every refusal `set()` makes that does not need the store is therefore made before the read, the way `appendToArray()` and `delete()` already make theirs.
	describe('a refused set leaves the config file as it was', () => {
		const buildWithADamagedFile = (): Conf => {
			const conf = new Conf({cwd: createTempDirectory(), clearInvalidConfig: true});
			conf.set('important', 'data');
			// Damaged after the store is built, so the clearing is the one this call triggers rather than the one the build did.
			fs.writeFileSync(conf.path, '{"important": "data"');
			return conf;
		};

		const unreadableKey = {name: 'TypeError', message: 'The key `a[x` is not a key a value can be written to.'};

		const refusals: Array<[string, (conf: Conf) => void, {name: string; message: string}]> = [
			['a value JSON cannot hold', conf => {
				conf.set('a', {b: BigInt(1)});
			}, {name: 'TypeError', message: 'Setting a value of type `bigint` for key `a` at `b` is not allowed as it\'s not supported by JSON'}],
			['a value of `undefined`', conf => {
				conf.set('a', undefined as never);
			}, {name: 'TypeError', message: 'Use `delete()` to clear values'}],
			['one key of an object argument among others', conf => {
				conf.set({fine: 1, broken: {b: BigInt(1)}});
			}, {name: 'TypeError', message: 'Setting a value of type `bigint` for key `broken` at `b` is not allowed as it\'s not supported by JSON'}],
			// A key the path parser cannot read is a question about the key and not about the store, so it is asked before the read rather than by the write below, which had already cleared the file.
			['a key the path parser cannot read', conf => {
				conf.set('a[x', 1);
			}, unreadableKey],
			['one key the path parser cannot read among others', conf => {
				conf.set({fine: 1, 'a[x': 1});
			}, unreadableKey],
		];

		for (const [name, refuse, refusal] of refusals) {
			it(name, () => {
				const conf = buildWithADamagedFile();
				const before = fs.readFileSync(conf.path, 'utf8');

				assert.throws(() => {
					refuse(conf);
				}, refusal);

				assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), before, 'the file is as it was before the refused call');
			});
		}
	});
});
