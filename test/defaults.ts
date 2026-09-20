/* eslint-disable no-new, @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-assignment -- A store is often built only for what it reports, the keys here are the ones a caller writes, including `toJSON`, and a value read back is `any`. */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf, {type Schema} from '../source/index.js';
import {
	createTempDirectory,
	runRegisteredCleanups,
	resetTrackedConfs,
	createNullProtoObject,
	readConfigFile,
	Money,
	price,
} from './_utilities.js';

type Store = Record<string, any>;

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a `default` of the schema the store can hold', () => {
	it('takes one the store can hold', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {a: {default: 0}, b: {type: 'array', default: []}, c: {type: 'object', default: {}}},
		});
		assert.deepStrictEqual({...conf.store}, {a: 0, b: [], c: {}});
		conf.clear();
		assert.deepStrictEqual({...conf.store}, {a: 0, b: [], c: {}});
	});
});

describe('a `default` of the schema that cannot be copied', () => {
	// A default holding something `structuredClone` cannot copy is still a value the store writes paths into, so the containers a path passes through are copies of their own, the way a copyable default is.
	it('leaves the object the schema gave as the caller gave it', () => {
		const schemaDefault = {
			keep: 1,
			fn() {
				return 'not cloneable';
			},
		};
		const snapshot = Object.keys(schemaDefault);

		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {
				parent: {
					type: 'object',
					default: schemaDefault,
					properties: {nested: {default: 'NESTED'}},
				},
			},
		});

		assert.deepStrictEqual(Object.keys(schemaDefault), snapshot);
		assert.deepStrictEqual(conf.get('parent'), {keep: 1, nested: 'NESTED'});
	});

	it('leaves an object with no prototype the schema gave as the caller gave it', () => {
		const schemaDefault: Record<string, unknown> = Object.create(null);
		schemaDefault.keep = 1;
		schemaDefault.fn = () => 'not cloneable';

		const snapshot = Object.keys(schemaDefault);

		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {
				parent: {
					type: 'object',
					default: schemaDefault,
					properties: {nested: {default: 'NESTED'}},
				},
			},
		});

		assert.deepStrictEqual(Object.keys(schemaDefault), snapshot);
		assert.deepStrictEqual(conf.get('parent'), {keep: 1, nested: 'NESTED'});
		assert.strictEqual(Object.getPrototypeOf(schemaDefault), null);
	});

	it('takes a `default` of the schema for a reset as a copy as well', () => {
		const schemaDefault = {
			keep: 1,
			fn() {
				return 'not cloneable';
			},
		};

		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {
				parent: {
					type: 'object',
					default: schemaDefault,
					properties: {nested: {default: 'NESTED'}},
				},
			},
		});
		conf.set('other', true);
		conf.reset('parent');

		assert.deepStrictEqual(Object.keys(schemaDefault), ['keep', 'fn']);
		assert.deepStrictEqual(conf.get('parent'), {keep: 1, nested: 'NESTED'});
	});
});

describe('a `defaults` key that spells itself with a backslash, and a schema', () => {
	// The key is a key of its own, so the validator is given it under the name without the backslash, the way the option records it and the store holds it. It was given it under the spelling with the backslash, which no `set()`, `get()` or `defaults` entry can name, so the store ended up with a second key and a schema that refuses unknown keys refused the one the option asked for.
	const key = String.raw`a\.b`;

	it('is the same store with a schema as without one', () => {
		const without = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {[key]: 1}});
		const with_ = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {[key]: 1}, schema: {other: {type: 'string'}}});
		assert.deepStrictEqual({...with_.store}, {...without.store}, 'the store');
		assert.strictEqual(with_.size, without.size, 'the item count');
		assert.deepStrictEqual(readConfigFile(with_.path), {'a.b': 1}, 'the file');
	});

	// The `properties` of a schema is a copy of the caller's, and a copy with a prototype answers for `toString` and the rest, which is a key of the schema the copy is not holding.
	it('names a key the copy of the schema would otherwise answer for', () => {
		for (const key of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, any>>({
				cwd,
				schema: {},
				rootSchema: {additionalProperties: false},
				ajvOptions: {removeAdditional: true},
				defaults: {[`${key}.x`]: 1},
			});
			assert.deepStrictEqual({...conf.store}, {[key]: {x: 1}}, `the store for a default under ${key}`);
		}
	});

	it('is a key the schema knows, the way every key of `defaults` is', () => {
		// A key the `defaults` option names is a key the store is declared to have, so a rule that covers the keys the schema does not know leaves it alone, and `removeAdditional` does not take it out. A key nothing names is not one of those.
		const known = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults: {[key]: 1},
			rootSchema: {additionalProperties: false},
			ajvOptions: {removeAdditional: true},
		});
		assert.deepStrictEqual({...known.store}, {'a.b': 1});

		const unknown = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			rootSchema: {additionalProperties: false},
			ajvOptions: {removeAdditional: true},
		});
		unknown.set(key, 1);
		assert.deepStrictEqual({...unknown.store}, {});
	});
});

describe('a `defaults` path the schema does not know the keys of', () => {
	for (const key of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
		it(`keeps nested value validation for a default named ${key}`, () => {
			const schema = {parent: {type: 'object', properties: {}, additionalProperties: {type: 'number'}}};
			const violation = {message: `Config schema violation: \`parent/${key}\` must be number`};
			assert.throws(() => new Conf<Store>({
				cwd: createTempDirectory(),
				schema,
				defaults: {[`parent.${key}`]: 'invalid'},
			}), violation);

			const conf = new Conf<Store>({cwd: createTempDirectory(), schema, defaults: {[`parent.${key}`]: 5}});
			assert.strictEqual(conf.get(`parent.${key}`), 5);
			assert.throws(() => {
				conf.set(`parent.${key}`, 'invalid');
			}, violation);
			assert.deepStrictEqual(readConfigFile(conf.path), {parent: {[key]: 5}});
		});
	}

	// A key that names a path is left out of the `properties` of the schema, so a rule that covers the keys the schema does not know takes the whole path for one of them, and the default the option fills in through it never reaches the file.
	const pathDefault = {'a.b': 1};

	it('is filled in where the root takes no key the schema does not know', () => {
		for (const [name, rootSchema] of [
			['`additionalProperties: false`', {additionalProperties: false}],
			['`unevaluatedProperties: false`', {unevaluatedProperties: false}],
		] as Array<[string, Record<string, unknown>]>) {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, any>>({
				cwd,
				schema: {},
				rootSchema,
				defaults: pathDefault,
			});
			assert.deepStrictEqual({...conf.store}, {a: {b: 1}}, `the store with ${name}`);
			assert.deepStrictEqual(readConfigFile(conf.path), {a: {b: 1}}, `the file with ${name}`);
		}
	});

	it('is filled in where the root takes a key the schema does not know away', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({
			cwd,
			schema: {},
			rootSchema: {additionalProperties: false},
			ajvOptions: {removeAdditional: true},
			defaults: pathDefault,
		});
		assert.deepStrictEqual({...conf.store}, {a: {b: 1}});
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {b: 1}});
	});

	// A `reset()` that leaves the store as it was says nothing about it, so the default it wrote has to be one the schema keeps.
	it('is written back by a `reset()` of the path', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({
			cwd,
			schema: {},
			rootSchema: {additionalProperties: false},
			ajvOptions: {removeAdditional: true},
			defaults: pathDefault,
		});
		conf.reset('a.b');
		assert.strictEqual(conf.get('a.b'), 1);
		assert.deepStrictEqual({...conf.store}, {a: {b: 1}});
	});

	it('is checked against a rule the schema already has for a key on the way to it', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({
			cwd,
			schema: {a: {type: 'object', additionalProperties: false, properties: {other: {type: 'number'}}}},
			defaults: pathDefault,
		});
		assert.deepStrictEqual({...conf.store}, {a: {b: 1}});
	});

	// A level the schema says nothing about the keys of can still have a rule that would take one, and the path stops being named there, so the default it writes is reported as a key the schema does not know.
	for (const [name, definition] of [
		['`additionalProperties: false`', {type: 'object', additionalProperties: false}],
		['`unevaluatedProperties: false`', {type: 'object', unevaluatedProperties: false}],
		[
			'a `patternProperties` with `additionalProperties: false`',
			{type: 'object', patternProperties: {'^z$': {type: 'number'}}, additionalProperties: false},
		],
		['`additionalProperties: false` with `properties`', {type: 'object', additionalProperties: false, properties: {z: {type: 'number'}}}],
	] as Array<[string, Record<string, unknown>]>) {
		it(`is filled in below a level with ${name}`, () => {
			const cwd = createTempDirectory();
			const schema = {a: definition} as unknown as Schema<Record<string, any>>;
			const conf = new Conf<Record<string, any>>({
				cwd,
				schema,
				defaults: {'a.b': 1},
			});
			assert.deepStrictEqual({...conf.store}, {a: {b: 1}}, `the store with ${name}`);
		});
	}

	it('is still refused where a key on the way to it cannot hold properties', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: 'a value the path cannot go into'}));
		const conf = new Conf<Record<string, any>>({cwd, schema: {a: {type: 'string'}}, defaults: pathDefault});
		assert.deepStrictEqual({...conf.store}, {a: 'a value the path cannot go into'});
	});
});

describe('a `defaults` key that spells itself with a backslash, and a `clear()`', () => {
	// A key with a backslash in it is a key of its own, which is the key the option names and the key the store holds, and the path the option writes it under is a path of one part. A `clear()` that parsed it a second time would turn the one part into a path of two and invent a key the store never held.
	const key = String.raw`a\.b`;

	it('is the same store a `clear()` gives as a fresh one', () => {
		const defaults = {[key]: 1};

		const fresh = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults});
		assert.deepStrictEqual({...fresh.store}, {'a.b': 1});

		const cleared = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults});
		cleared.set('other', 2);
		cleared.clear();
		assert.deepStrictEqual({...cleared.store}, {...fresh.store});
		assert.strictEqual(cleared.get(key), 1);
		assert.strictEqual(cleared.size, 1);
	});

	it('is written under the key it is named by, without dot notation too', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), accessPropertiesByDotNotation: false, defaults: {[key]: 1}});
		conf.clear();
		assert.deepStrictEqual({...conf.store}, {[key]: 1});
	});
});

describe('filling in the `defaults` option', () => {
	it('writes defaults to a fresh file', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, defaults: {a: 1}});
		assert.deepStrictEqual(readConfigFile(conf.path), {a: 1});
		assert.strictEqual(conf.get('a'), 1);
	});

	it('stored values win over defaults', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: 99}));
		const conf = new Conf({cwd, defaults: {a: 1, b: 2}});
		assert.strictEqual(conf.get('a'), 99);
		assert.strictEqual(conf.get('b'), 2);
	});

	it('ignores undefined defaults', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {a: undefined as any, b: 2}});
		assert.strictEqual(conf.has('a'), false);
		assert.strictEqual(conf.get('b'), 2);
	});

	it('does not let later mutation of the defaults object leak in', () => {
		const defaults: Record<string, unknown> = {a: 1};
		const conf = new Conf({cwd: createTempDirectory(), defaults, cache: true});
		defaults.a = 999;
		assert.strictEqual(conf.get('a'), 1);

		// A reset and a clear write the defaults again, which is where the option is read after construction.
		conf.set('a', 2);
		conf.reset('a');
		assert.strictEqual(conf.get('a'), 1);
		conf.clear();
		assert.strictEqual(conf.get('a'), 1);
	});

	it('supports falsy defaults', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {zero: 0, empty: '', no: false}});
		assert.strictEqual(conf.get('zero'), 0);
		assert.strictEqual(conf.get('empty'), '');
		assert.strictEqual(conf.get('no'), false);
		conf.set('zero', 5);
		conf.reset('zero');
		assert.strictEqual(conf.get('zero'), 0);
	});

	it('refuses reserved keys in defaults', () => {
		assert.throws(() => {
			new Conf({cwd: createTempDirectory(), defaults: {__internal__: 1}});
		}, {message: /__internal__/});
	});

	it('a dotted `defaults` key names a path with dot notation', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, defaults: {'a.b': 1}});

		// The key names a path, the same one `get()`, `set()` and `clear()` take for it, so the default is what a read of the path gives back before anything else touches it, and the file holds one nested path rather than a second key spelled with dots.
		assert.strictEqual(conf.get('a.b'), 1);
		assert.strictEqual(conf.has('a.b'), true);
		assert.deepStrictEqual(conf.get('a'), {b: 1});
		assert.strictEqual(conf.size, 1);
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {b: 1}});

		// Two defaults under one path share the parent instead of one replacing the other.
		const shared = new Conf({cwd: createTempDirectory(), defaults: {'a.b': 1, 'a.c': 2}});
		assert.deepStrictEqual(shared.get('a'), {b: 1, c: 2});
		assert.strictEqual(shared.get('a.b'), 1);
		assert.strictEqual(shared.get('a.c'), 2);

		// A write through the path leaves one representation of it.
		conf.set('a.b', 5);
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {b: 5}});

		// The default is written back for a key that is deleted, and a reset restores it.
		conf.delete('a.b');
		assert.strictEqual(conf.get('a.b'), 1);
		conf.set('a.b', 7);
		conf.reset('a.b');
		assert.strictEqual(conf.get('a.b'), 1);

		// And `clear()` ends with it as well.
		conf.clear();
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {b: 1}});
		assert.strictEqual(conf.get('a.b'), 1);

		// Without dot notation the key is literal, the same as any other key.
		const literal = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false, defaults: {'a.b': 1}});
		assert.strictEqual(literal.get('a.b'), 1);
		assert.deepStrictEqual(readConfigFile(literal.path), {'a.b': 1});
	});

	it('records no default for a `defaults` path the value the option gives the key above it cannot hold', () => {
		// The value of `a` is a number, which the path below it cannot be written through, so the store keeps `a` and the path is not a default at all, the way a `default` of the schema below a value is not.
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {a: 1, 'a.b': 2}});
		assert.deepStrictEqual({...conf.store}, {a: 1});

		conf.set('a.b', 99);
		conf.reset('a.b');
		assert.deepStrictEqual(conf.get('a'), {b: 99});

		conf.clear();
		assert.deepStrictEqual({...conf.store}, {a: 1});
	});

	it('records no default at all for a `defaults` path set to `undefined`', () => {
		// A key set to `undefined` is the same as one that is not passed, so there is no default for it to write back and a reset of it leaves what the store holds.
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {a: 1, 'a.b': undefined}});
		assert.deepStrictEqual({...conf.store}, {a: 1});

		conf.set('a.b', 5);
		conf.reset('a.b');
		assert.deepStrictEqual(conf.get('a'), {b: 5});
	});

	it('fills a dotted `defaults` key as a path into a store that already exists', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({seed: 1}));

		const conf = new Conf({cwd, defaults: {'a.b': 1}});
		assert.deepStrictEqual(conf.get('a'), {b: 1});
		assert.deepStrictEqual(readConfigFile(conf.path), {seed: 1, a: {b: 1}});

		// Writing the store whole fills the path beside what it holds, rather than adding a key of dots beside a nested copy of it.
		conf.store = {seed: 2} as any;
		assert.deepStrictEqual(conf.store, createNullProtoObject({seed: 2, a: {b: 1}}));
		assert.strictEqual(conf.get('a.b'), 1);
		assert.deepStrictEqual(readConfigFile(conf.path), {seed: 2, a: {b: 1}});
	});

	it('a dotted `defaults` key with a schema is stored as the path alone', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({
			cwd,
			schema: {a: {type: 'object', properties: {b: {type: 'number', default: 9}}}},
			defaults: {'a.b': 1},
		});

		// The option overwrites the `default` of the schema, and the validator must not write a second, literal key of dots beside the path.
		assert.strictEqual(conf.get('a.b'), 1);
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {b: 1}});

		// A store that already holds the value keeps it, the way the schema sees it.
		conf.store = {a: {b: 5}};
		assert.strictEqual(conf.get('a.b'), 5);
	});

	it('a dotted `defaults` key covers its parent when the parent goes', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {top: 3, 'a.b': 1}});
		conf.set('a.b', 5);
		conf.set('a.c', 9);

		// The parent holds the covered part, so a delete writes that part back beside the keys the option does not cover, and the rest of the deleted path stays gone.
		conf.delete('a');
		assert.deepStrictEqual(conf.get('a'), {b: 1});
		assert.strictEqual(conf.get('top'), 3);

		// A reset of the parent writes the path back the way the option defines it, and leaves the other keys alone.
		conf.set('a.c', 9);
		conf.reset('a');
		assert.deepStrictEqual(conf.get('a'), {b: 1});
		assert.deepStrictEqual(readConfigFile(conf.path), {top: 3, a: {b: 1}});
	});

	it('a bracket-index `defaults` key is an element with dot notation and a literal key without', () => {
		// The bracket names an index of the path, so the default lands in the array the path writes, and no key of brackets is left beside it.
		const dot = new Conf({cwd: createTempDirectory(), defaults: {'list[0]': 'first'}});
		assert.strictEqual(dot.get('list[0]'), 'first');
		assert.strictEqual(dot.size, 1);
		assert.deepStrictEqual(readConfigFile(dot.path), {list: ['first']});

		// Without dot notation the key is the key itself, brackets included.
		const literal = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false, defaults: {'list[0]': 'first'}});
		assert.strictEqual(literal.get('list[0]'), 'first');
		assert.deepStrictEqual(readConfigFile(literal.path), {'list[0]': 'first'});
	});
});

describe('a default that writes itself, where the schema names its type', () => {
	// A `clear()` writes the defaults back through the whole-store write, which checks them against the schema on a path of its own, where a `reset()` goes through `set()`.
	it('writes a `schema` default that writes itself back after `clear()` where the schema names the type', () => {
		const conf = new Conf<{price: string}>({
			cwd: createTempDirectory(),
			schema: {price: {type: 'string', default: new Money(500)}},
		});

		conf.set('price', '$9.00');
		conf.clear();
		assert.strictEqual(conf.get('price'), '$5.00');
	});

	it('gives the same store for a value given by `defaults` as for the same value given as a `default` of the schema', () => {
		const throughDefaults = new Conf<{price: string}>({
			cwd: createTempDirectory(),
			schema: {price: {type: 'string'}},
			defaults: {price: new Money(500) as unknown as string},
		});
		const throughSchema = new Conf<{price: string}>({
			cwd: createTempDirectory(),
			schema: {price: {type: 'string', default: new Money(500)}},
		});

		assert.deepStrictEqual(throughDefaults.store, throughSchema.store);
		assert.strictEqual(throughDefaults.get('price'), '$5.00');
	});

	it('writes a `schema` default that writes itself back after `reset()` where the schema names the type', () => {
		const conf = new Conf<{price: string}>({
			cwd: createTempDirectory(),
			schema: {price: {type: 'string', default: new Money(500)}},
		});

		conf.set('price', '$9.00');
		conf.reset('price');
		assert.strictEqual(conf.get('price'), '$5.00');
	});

	it('writes a value that writes itself below a `defaults` key as the writing gives it, not as the value is', () => {
		const conf = new Conf<Store>({
			cwd: createTempDirectory(),
			schema: {price: {type: 'string'}},
			defaults: {price: new Money(500)},
		});

		assert.deepStrictEqual({...conf.store}, {price: '$5.00'});
		assert.strictEqual(readConfigFile(conf.path).price, '$5.00');
	});
});

describe('a value the `defaults` and `schema` options cannot hold', () => {
	// The options are read the way `set()` reads what it is given, so a value JSON cannot write is refused there as well.
	it('refuses a `defaults` value of a type JSON cannot write', () => {
		assert.throws(() => {
			new Conf<Store>({cwd: createTempDirectory(), defaults: {count: 1n}});
		}, {name: 'TypeError', message: 'Setting a value of type `bigint` for key `count` is not allowed as it\'s not supported by JSON'});
	});

	// A number JSON has no form of is written as the `null` JSON writes it as, the way `JSON.stringify` does.
	it('writes a `defaults` value JSON has no number for as `null`', () => {
		const conf = new Conf<Store>({cwd: createTempDirectory(), defaults: {timeout: Number.POSITIVE_INFINITY, nested: {count: Number.NaN}}});
		assert.deepStrictEqual(readConfigFile(conf.path), {timeout: null, nested: {count: null}});
		conf.clear();
		assert.deepStrictEqual(readConfigFile(conf.path), {timeout: null, nested: {count: null}});
	});

	it('refuses a `defaults` value that holds itself, wherever it is in the value', () => {
		const value: Record<string, unknown> = {};
		value.self = value;

		assert.throws(() => {
			new Conf<Store>({cwd: createTempDirectory(), defaults: {value}});
		}, {name: 'TypeError', message: /a value that holds itself is not supported by JSON/});
	});

	it('refuses a `schema` `default` of a type JSON cannot write', () => {
		assert.throws(() => {
			new Conf<Store>({cwd: createTempDirectory(), schema: {count: {default: 1n}}});
		}, {name: 'TypeError', message: 'Setting a value of type `bigint` for key `count` is not allowed as it\'s not supported by JSON'});
	});
});

describe('a `defaults` object that is frozen and shared', () => {
	// A value the option gives is copied into the store, so what the validator writes into the store is written into the copy and not into the object the caller passed.
	it('is not written to by the validator', () => {
		const schema = {
			nested: {
				type: 'object',
				properties: {
					added: {type: 'string', default: 'x'},
				},
			},
		};
		const defaults = Object.freeze({nested: Object.freeze({kept: 1})});
		const first = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults, schema});
		const second = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults, schema});

		first.set('unrelated', true);
		first.store = {unrelated: true};
		first.clear();

		assert.deepStrictEqual(defaults, {nested: {kept: 1}});
		assert.deepStrictEqual(first.get('nested'), {kept: 1, added: 'x'});
		assert.deepStrictEqual(second.get('nested'), {kept: 1, added: 'x'});
	});
});

describe('a `defaults` key an external write dropped', () => {
	// A read reports what the file holds, and a `defaults` value is written into the file when the store is constructed and on every write, so a file another process wrote without one is a file that does not hold it. Writing it back on a change from elsewhere would be a write on every such change, and the value the caller gave is the one the file is written with.
	it('is reported as missing, and a `reset()` puts it back', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		fs.writeFileSync(configPath, JSON.stringify({a: 1}));

		const conf = new Conf<Record<string, any>>({cwd, defaults: {b: 'the default'}});
		assert.deepStrictEqual(readConfigFile(configPath), {a: 1, b: 'the default'});

		fs.writeFileSync(configPath, JSON.stringify({a: 2}));
		assert.deepStrictEqual({...conf.store}, {a: 2});
		assert.strictEqual(conf.has('b'), false);
		assert.strictEqual(conf.get('b'), undefined);

		conf.reset('b');
		assert.deepStrictEqual(readConfigFile(configPath), {a: 2, b: 'the default'});
	});
});

describe('a dotted `defaults` key a nested `default` of the schema covers', () => {
	it('overrides an ancestor schema default after an external write', () => {
		const schema = {
			parent: {
				type: 'object',
				default: {child: 1, sibling: 'kept'},
				properties: {child: {type: 'number', default: 2}},
			},
		};
		const conf = new Conf<Store>({cwd: createTempDirectory(), schema, defaults: {'parent.child': 5}});
		assert.deepStrictEqual(conf.get('parent'), {child: 5, sibling: 'kept'});

		fs.writeFileSync(conf.path, '{}');
		assert.deepStrictEqual(conf.get('parent'), {child: 5, sibling: 'kept'});
		conf.set('other', true);
		assert.deepStrictEqual(readConfigFile(conf.path), {parent: {child: 5, sibling: 'kept'}, other: true});
		assert.deepStrictEqual(schema.parent.default, {child: 1, sibling: 'kept'});
	});

	for (const parentDefault of [{}, {child: 4}]) {
		it(`resets a nested schema default with parent option default ${JSON.stringify(parentDefault)}`, () => {
			const conf = new Conf<Store>({
				cwd: createTempDirectory(),
				schema: {parent: {type: 'object', properties: {child: {type: 'number', default: 2}}}},
				defaults: {parent: parentDefault},
			});
			const expected = 'child' in parentDefault ? parentDefault.child : 2;
			assert.strictEqual(conf.get('parent.child'), expected);
			conf.set('parent.child', 9);
			conf.reset('parent.child');
			assert.strictEqual(conf.get('parent.child'), expected);
			conf.set('parent', {child: 9});
			conf.reset('parent');
			assert.strictEqual(conf.get('parent.child'), expected);
		});
	}

	it('resets nested defaults when validation stops at a missing required key', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({required: 'present'}));
		const conf = new Conf<Store>({
			cwd,
			schema: {parent: {type: 'object', properties: {child: {type: 'number', default: 2}}}},
			rootSchema: {required: ['required']},
			defaults: {parent: {}},
			ajvOptions: {allErrors: false},
		});
		assert.strictEqual(conf.get('parent.child'), 2);
		conf.set('parent.child', 9);
		conf.reset('parent.child');
		assert.strictEqual(conf.get('parent.child'), 2);
	});

	it('keeps intermediate schema defaults after an external write', () => {
		const conf = new Conf<Store>({
			cwd: createTempDirectory(),
			schema: {
				parent: {
					type: 'object',
					default: {},
					properties: {
						child: {
							type: 'object',
							default: {sibling: 1},
							properties: {value: {type: 'number', default: 2}},
						},
					},
				},
			},
			defaults: {'parent.child.value': 5},
		});
		const expected = {child: {sibling: 1, value: 5}};
		assert.deepStrictEqual(conf.get('parent'), expected);
		fs.writeFileSync(conf.path, '{}');
		assert.deepStrictEqual(conf.get('parent'), expected);
		conf.set('other', true);
		assert.deepStrictEqual(readConfigFile(conf.path), {parent: expected, other: true});
	});

	it('keeps every dotted override in the ancestor schema default', () => {
		const conf = new Conf<Store>({
			cwd: createTempDirectory(),
			schema: {parent: {type: 'object', default: {first: 1, second: 2}}},
			defaults: {'parent.first': 3, 'parent.second': 4},
		});
		assert.deepStrictEqual(conf.get('parent'), {first: 3, second: 4});
		fs.writeFileSync(conf.path, '{}');
		assert.deepStrictEqual(conf.get('parent'), {first: 3, second: 4});
		conf.set('other', true);
		assert.deepStrictEqual(readConfigFile(conf.path), {parent: {first: 3, second: 4}, other: true});
	});

	it('keeps literal option defaults when recording schema defaults', () => {
		const conf = new Conf<Store>({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
			schema: {foo: {type: 'number', default: 2}},
			defaults: {foo: 5},
		});
		assert.strictEqual(conf.get('foo'), 5);
		conf.set('foo', 9);
		conf.reset('foo');
		assert.strictEqual(conf.get('foo'), 5);
	});

	it('records nested defaults after an option replaces a nullable parent default', () => {
		const conf = new Conf<Store>({
			cwd: createTempDirectory(),
			schema: {parent: {type: ['object', 'null'], default: null, properties: {child: {type: 'number', default: 2}}}},
			defaults: {parent: {}},
		});
		assert.strictEqual(conf.get('parent.child'), 2);
		conf.set('parent.child', 9);
		conf.reset('parent.child');
		assert.strictEqual(conf.get('parent.child'), 2);
	});

	// The `defaults` option overwrites the `default` of the schema, so it does at a path the same as at the root, also where the validator fills the key in for a file another process wrote.
	it('wins over the `default` of the schema', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Store>({
			cwd,
			schema: {a: {type: 'object', properties: {b: {type: 'number', default: 1}}}},
			defaults: {'a.b': 5},
		});
		assert.strictEqual(conf.get('a.b'), 5);

		fs.writeFileSync(conf.path, JSON.stringify({a: {}}));
		assert.strictEqual(conf.get('a.b'), 5);

		conf.set('x', 1);
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {b: 5}, x: 1});

		conf.set('a.b', 7);
		conf.reset('a.b');
		assert.strictEqual(conf.get('a.b'), 5);
		conf.clear();
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {b: 5}});
	});
});

describe('the `defaults` option and the schema', () => {
	it('a `defaults` key set to `undefined` does not rewrite an unchanged store', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{}');
		let writes = 0;

		const conf = new Conf({
			cwd,
			defaults: {a: undefined},
			serialize(value) {
				writes++;
				return JSON.stringify(value);
			},
		});

		assert.strictEqual(conf.has('a'), false);
		assert.strictEqual(writes, 0);
	});

	it('validates a required `defaults` key before an existing store', () => {
		const schema: Schema<{a: number}> = {a: {type: 'number'}};
		const cwd = createTempDirectory();

		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({keepMe: 'important'}));

		const conf = new Conf({
			cwd,
			clearInvalidConfig: true,
			defaults: {a: 1},
			schema,
			rootSchema: {required: ['a']},
		});

		assert.strictEqual(conf.get('a'), 1);
		assert.strictEqual(conf.get('keepMe'), 'important');
	});

	it('writes injected defaults back to an existing validated store', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		fs.writeFileSync(configPath, '{}');

		const conf = new Conf({
			cwd,
			defaults: {a: 1},
			schema: {a: {type: 'number'}},
		});

		assert.strictEqual(conf.get('a'), 1);
		assert.deepStrictEqual(readConfigFile(configPath), {a: 1});
	});

	it('validates a required `defaults` key with only a root schema', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({keepMe: 'important'}));

		const conf = new Conf({
			cwd,
			defaults: {a: 1},
			rootSchema: {required: ['a']},
		});

		assert.strictEqual(conf.get('a'), 1);
		assert.strictEqual(conf.get('keepMe'), 'important');
	});

	it('validates a required `defaults` key with a boolean property schema', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({keepMe: 'important'}));

		const conf = new Conf({
			cwd,
			defaults: {a: 1},
			schema: {a: true},
			rootSchema: {required: ['a']},
		});

		assert.strictEqual(conf.get('a'), 1);
		assert.strictEqual(conf.get('keepMe'), 'important');
	});

	it('validates `defaults` before an existing store when AJV defaults are disabled', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({keepMe: 'important'}));

		const conf = new Conf({
			cwd,
			defaults: {a: 1},
			schema: {a: {type: 'number'}},
			rootSchema: {required: ['a']},
			ajvOptions: {useDefaults: false},
		});

		assert.strictEqual(conf.get('a'), 1);
		assert.strictEqual(conf.get('keepMe'), 'important');
	});

	it('clears invalid data before applying defaults when AJV defaults are disabled', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: 'invalid'}));

		const conf = new Conf({
			cwd,
			clearInvalidConfig: true,
			defaults: {a: 1},
			schema: {a: {type: 'number'}},
			ajvOptions: {useDefaults: false},
		});

		assert.strictEqual(conf.get('a'), 1);
	});
});

describe('defaults never write into the objects the caller owns', () => {
	it('leaves the `defaults` option as the caller gave it', () => {
		const defaults: Record<string, unknown> = {a: {b: 1}, 'a.c': 2};
		const snapshot = structuredClone(defaults);
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults});
		conf.set('unrelated', true);
		conf.store = {unrelated: true};
		conf.clear();
		assert.deepStrictEqual(defaults, snapshot);
		assert.deepStrictEqual(conf.get('a'), {b: 1, c: 2});
	});

	it('leaves the value `set()` was given as the caller gave it', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.c': 2}});
		const value = {b: 9};
		conf.set('a', value);
		assert.deepStrictEqual(value, {b: 9});
		assert.deepStrictEqual(conf.get('a'), {b: 9, c: 2});
	});

	it('leaves the value the `store` setter was given as the caller gave it', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.c': 2}});
		const value = {a: {b: 9}, z: 1};
		conf.store = value;
		assert.deepStrictEqual(value, {a: {b: 9}, z: 1});
		assert.deepStrictEqual(conf.get('a'), {b: 9, c: 2});
	});

	it('leaves a value a nested default is written into alone', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.b.c': 3}});
		const value = {a: {b: {d: 4}}};
		conf.store = value;
		assert.deepStrictEqual(value, {a: {b: {d: 4}}});
		assert.deepStrictEqual(conf.get('a'), {b: {c: 3, d: 4}});
	});

	it('keeps both defaults where one key names a path below the other', () => {
		// The value the path is written into is a copy, so the object the option holds is not written into and is what the copy is observed on.
		const defaults: Record<string, unknown> = {'a.c': 2, a: {b: 1}};
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults});
		assert.deepStrictEqual(conf.get('a'), {b: 1, c: 2});
		assert.deepStrictEqual(defaults.a, {b: 1}, 'the object the option holds was written into');

		// The path default is written after the key it is a path below, so a store that is written whole keeps it too.
		conf.store = {unrelated: true};
		assert.deepStrictEqual(conf.get('a'), {b: 1, c: 2});

		conf.reset('a.c');
		assert.deepStrictEqual(conf.get('a'), {b: 1, c: 2});
		assert.deepStrictEqual(defaults.a, {b: 1}, 'the object the option holds was written into');
	});

	it('leaves a value held by the store alone when a default is filled in', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.c': 2}});
		const held = {b: 1};
		conf.set('a', held);
		conf.set('unrelated', true);
		assert.deepStrictEqual(held, {b: 1}, 'the value the caller gave was written into');
		assert.deepStrictEqual(conf.get('a'), {b: 1, c: 2});
	});
});

describe('a default whose path the store cannot take', () => {
	// An array holds nothing but its elements, so the path cannot be written into it. The store keeps the value it has there, instead of every write failing on a default the store cannot hold.
	it('leaves the array the store holds, and keeps every write working', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.b': 1}});
		conf.set('a', [1, 2]);
		assert.deepStrictEqual(conf.get('a'), [1, 2]);

		conf.set('z', 1);
		assert.strictEqual(conf.get('z'), 1);

		// Deleting a key the defaults cover brings it back, which is what the option documents.
		conf.delete('a');
		assert.deepStrictEqual(conf.get('a'), {b: 1});
	});

	it('leaves a value the store holds where a default cannot be written into it', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.b': 1}});
		conf.set('a', 5);
		assert.strictEqual(conf.get('a'), 5);
		assert.strictEqual(conf.get('a.b'), undefined);

		conf.set('a', 'text');
		assert.strictEqual(conf.get('a'), 'text');

		conf.set('a', null);
		assert.strictEqual(conf.get('a'), null);
	});

	it('leaves a value an existing file holds where a default cannot be written into it', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: 5, other: 'keep'}));
		const conf = new Conf<Record<string, any>>({cwd, defaults: {'a.b': 1}});
		assert.strictEqual(conf.get('a'), 5);
		assert.strictEqual(conf.get('other'), 'keep');
		assert.deepStrictEqual(readConfigFile(conf.path), {a: 5, other: 'keep'});
	});

	it('applies the default again once the array is gone', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.b': 1}});
		conf.set('a', [1, 2]);
		conf.set('a', {c: 2});
		assert.deepStrictEqual(conf.get('a'), {c: 2, b: 1});
	});

	it('leaves the array the store is written with as the caller gave it', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.b': 1}});
		const value = {a: [1, 2], z: 1};
		conf.store = value;
		assert.deepStrictEqual(value, {a: [1, 2], z: 1});
		assert.deepStrictEqual(conf.get('a'), [1, 2]);
	});

	it('writes the array into the file as it is', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({cwd, defaults: {'a.b': 1}});
		conf.set('a', [1, 2]);
		assert.deepStrictEqual(readConfigFile(conf.path), {a: [1, 2]});
	});
});

describe('a `defaults` key the store cannot hold', () => {
	// A key `dot-prop` refuses is a path of no parts, so there is nowhere to write it. The reserved key is already refused in the same place, so one the store silently throws away is reported the same way.
	for (const key of ['constructor', 'prototype', '__proto__', 'a.__proto__.b', 'a.constructor']) {
		it(`refuses \`${key}\``, () => {
			assert.throws(() => new Conf({
				cwd: createTempDirectory(),
				defaults: {[key]: 'DEFAULT'},
			}), {name: 'TypeError', message: /`defaults` option cannot hold the key/});
		});
	}

	for (const key of ['foo', 'a.b', 'a[0]', '0']) {
		it(`takes \`${key}\``, () => {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {[key]: 'DEFAULT'}});
			assert.strictEqual(conf.get(key), 'DEFAULT');
		});
	}

	it('takes a key `dot-prop` refuses without dot notation, where the key is the whole key', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
			defaults: {constructor: 'DEFAULT'},
		});
		assert.strictEqual(conf.get('constructor'), 'DEFAULT');
	});
});

describe('a `defaults` key below a key the schema gives a `default` to', () => {
	// The `defaults` key names the path below the parent, so the `default` the schema gives the parent fills the rest of it, the way a read and a `reset()` of the parent both do.
	const schema = {
		parent: {
			type: 'object',
			default: {x: 1},
			properties: {child: {type: 'number'}},
		},
	};

	it('keeps the `default` of the key the path is below', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults: {'parent.child': 2}});
		assert.deepStrictEqual(conf.get('parent'), {x: 1, child: 2});
	});

	it('agrees with a `reset()` of the key the path is below', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults: {'parent.child': 2}});
		conf.reset('parent');
		assert.deepStrictEqual(conf.get('parent'), {x: 1, child: 2});
		assert.deepStrictEqual(conf.get('parent.child'), 2);
	});

	it('agrees with a `clear()`', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults: {'parent.child': 2}});
		conf.set('other', true);
		conf.clear();
		assert.deepStrictEqual(conf.get('parent'), {x: 1, child: 2});
	});

	it('writes the whole value to the file', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({cwd, schema, defaults: {'parent.child': 2}});
		assert.deepStrictEqual(readConfigFile(conf.path), {parent: {x: 1, child: 2}});
	});

	it('satisfies a `required` the `default` of the key the path is below is there for', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({
			cwd,
			schema: {
				parent: {
					type: 'object',
					default: {x: 1},
					required: ['x'],
					properties: {x: {type: 'number'}, child: {type: 'number'}},
				},
			},
			defaults: {'parent.child': 2},
		});
		assert.deepStrictEqual(conf.get('parent'), {x: 1, child: 2});
	});

	it('reports a value the property the path names refuses', () => {
		assert.throws(() => new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {parent: {type: 'object', properties: {child: false}}},
			defaults: {'parent.child': 2},
		}), {message: 'Config schema violation: `parent/child` boolean schema is false'});
	});

	it('still fills in a path below a key the schema gives no `default` to', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {parent: {type: 'object', properties: {child: {type: 'number'}}}},
			defaults: {'parent.child': 2},
		});
		assert.deepStrictEqual(conf.get('parent'), {child: 2});
		conf.set('other', true);
		assert.deepStrictEqual(conf.get('parent'), {child: 2});
	});
});

describe('a `defaults` value the store could never write', () => {
	// A default that `set()` refuses would be dropped without a word here, and make `clear()` and `reset()` fail later, so it is reported at construction the way `set()` reports it.
	for (const accessPropertiesByDotNotation of [true, false]) {
		for (const [name, key] of [['a flat key', 'a'], ['a path', 'a.b']] as Array<[string, string]>) {
			it(`refuses ${name}, with dot notation: ${String(accessPropertiesByDotNotation)}`, () => {
				assert.throws(() => new Conf({
					cwd: createTempDirectory(),
					accessPropertiesByDotNotation,
					defaults: {[key]: () => 1},
				}), {name: 'TypeError', message: 'Setting a value of type `function` for key `' + key + '` is not allowed as it\'s not supported by JSON'});
			});
		}
	}

	it('takes a default the store can write', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {a: 1, 'b.c': 2}});
		assert.strictEqual(conf.get('a'), 1);
		assert.strictEqual(conf.get('b.c'), 2);
		conf.clear();
		assert.strictEqual(conf.get('a'), 1);
	});
});

describe('a `defaults` path the store cannot take', () => {
	// The store keeps what it has where the path would go, so a `defaults` value below a value that is not an object is left out of the store rather than replacing it. A path of more than one part is checked against the store before the default of the key above it is written into a copy, or a path the store cannot take would look like one it can.
	for (const key of ['a.b.c', 'a.b.c.d']) {
		it(`keeps a value at \`a\` the path ${key} cannot go into`, () => {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {[key]: 3}});
			conf.set('a', 5);
			assert.deepStrictEqual({...conf.store}, {a: 5});
		});
	}

	it('keeps an array at `a` the path cannot go into', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.b.c': 3}});

		for (const [name, put] of [
			['the file holds it', (store: Conf<Record<string, any>>) => {
				store.store = {a: [1, 2]};
			}],
			['a key holds it', (store: Conf<Record<string, any>>) => {
				store.set('a', [1, 2]);
			}],
		] as Array<[string, (store: Conf<Record<string, any>>) => void]>) {
			try {
				put(conf);
				assert.deepStrictEqual({...conf.store}, {a: [1, 2]}, `the store where ${name}`);
			} catch (error: any) {
				assert.fail(`the store where ${name} threw ${error.name}: ${error.message}`);
			}
		}
	});

	it('still fills a path the store has nothing in the way of', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.b.c': 3, a: {other: 1}}});
		assert.deepStrictEqual({...conf.store}, {a: {other: 1, b: {c: 3}}});
	});

	it('leaves a key that names a path alone where the key above holds a value the path cannot go into', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {'a.b': 'specific', a: 'general'}});

		// A value that is not an object is not something a path can be written into, and the store keeps what it holds there.
		assert.strictEqual(conf.get('a'), 'general');
		assert.strictEqual(conf.get('a.b'), undefined);
	});
});

describe('`useDefaults` turned off', () => {
	// A `default` the validator is not asked to apply is not one to write back either, so `clear()` and `reset()` do not give a store a value a fresh store of the same options does not have.
	const schema = {a: {type: 'number', default: 5}};
	const options = {schema, ajvOptions: {useDefaults: false}};

	it('leaves a fresh store without the default', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), ...options});
		assert.deepStrictEqual({...conf.store}, {});
		assert.strictEqual(fs.existsSync(conf.path), false, 'the file');
	});

	it('leaves a `clear()` without the default', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), ...options});
		conf.set('b', 1);
		conf.clear();
		assert.deepStrictEqual({...conf.store}, {});
		assert.deepStrictEqual(readConfigFile(conf.path), {});
	});

	it('leaves a `reset()` without the default', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), ...options});
		conf.set('a', 9);
		conf.reset('a');
		assert.deepStrictEqual({...conf.store}, {a: 9});
	});

	it('still fills in the `defaults` option, which is not a `default` of the schema', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), ...options, defaults: {b: 6}});
		assert.deepStrictEqual({...conf.store}, {b: 6});
		conf.clear();
		assert.deepStrictEqual({...conf.store}, {b: 6});
	});
});

describe('clear() and reset() agree with a fresh store', () => {
	for (const defaultSource of ['schema', 'options']) {
		it(`does not create an absent optional object when resetting a parent with ${defaultSource} defaults`, () => {
			const conf = new Conf<Store>({
				cwd: createTempDirectory(),
				schema: {
					parent: {
						type: 'object',
						...(defaultSource === 'schema' ? {default: {}} : {}),
						properties: {
							optional: {
								type: 'object',
								required: ['name'],
								properties: {
									name: {type: 'string'},
									enabled: {type: 'boolean', default: true},
								},
							},
						},
					},
				},
				...(defaultSource === 'options' ? {defaults: {parent: {}}} : {}),
			});
			assert.deepStrictEqual(conf.get('parent'), {});
			conf.set('parent', {changed: true});
			conf.reset('parent');
			assert.deepStrictEqual(conf.get('parent'), {});
			assert.deepStrictEqual(readConfigFile(conf.path), {parent: {}});
			conf.set('parent.optional', {name: 'Ada', enabled: false});
			conf.reset('parent.optional.enabled');
			assert.strictEqual(conf.get('parent.optional.enabled'), false);
			conf.reset('parent');
			assert.deepStrictEqual(conf.get('parent'), {});
			conf.clear();
			assert.deepStrictEqual(conf.get('parent'), {});
		});

		it(`fills defaults inside an optional object supplied by ${defaultSource} defaults`, () => {
			const parent = {optional: {name: 'Ada'}};
			const conf = new Conf<Store>({
				cwd: createTempDirectory(),
				schema: {
					parent: {
						type: 'object',
						...(defaultSource === 'schema' ? {default: parent} : {}),
						properties: {
							optional: {
								type: 'object',
								required: ['name'],
								properties: {
									name: {type: 'string'},
									enabled: {type: 'boolean', default: true},
								},
							},
						},
					},
				},
				...(defaultSource === 'options' ? {defaults: {parent}} : {}),
			});
			const expected = {optional: {name: 'Ada', enabled: true}};
			assert.deepStrictEqual(conf.get('parent'), expected);
			conf.set('parent', {});
			conf.reset('parent');
			assert.deepStrictEqual(conf.get('parent'), expected);
			conf.set('parent.optional.enabled', false);
			conf.reset('parent.optional.enabled');
			assert.deepStrictEqual(conf.get('parent'), expected);
			conf.clear();
			assert.deepStrictEqual(conf.get('parent'), expected);
			assert.deepStrictEqual(parent, {optional: {name: 'Ada'}});
		});
	}

	// The validator inserts the value a `default` gives as it is, so a default below it is only written where that value does not already hold the key. What `clear()` and `reset()` write back is the same.
	it('restores the value the schema gives a key, not a default it already names', () => {
		const schema = {
			parent: {
				type: 'object',
				default: {x: 8},
				properties: {x: {type: 'number', default: 4}},
			},
		};

		const fresh = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema});
		assert.deepStrictEqual(fresh.get('parent'), {x: 8});

		const cleared = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema});
		cleared.clear();
		assert.deepStrictEqual(cleared.get('parent'), {x: 8});

		const reset = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema});
		reset.set('parent', {p: 1});
		reset.reset('parent');
		assert.deepStrictEqual(reset.get('parent'), {x: 8});
	});

	it('still writes a default below a value the schema gives that the value does not name', () => {
		const schema = {
			parent: {
				type: 'object',
				default: {y: 1},
				properties: {x: {type: 'number', default: 4}},
			},
		};

		const fresh = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema});
		assert.deepStrictEqual(fresh.get('parent'), {y: 1, x: 4});

		const cleared = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema});
		cleared.clear();
		assert.deepStrictEqual(cleared.get('parent'), {y: 1, x: 4});
	});

	// A path default whose place the store already holds a value for is left to the store, the way a write leaves it, so what is recorded for a reset is what a fresh store gives.
	it('keeps the flat default where a path default names a path below it', () => {
		const schema = {a: {type: 'string'}};
		const defaults = {a: 'y', 'a.b': true};

		const fresh = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults});
		assert.deepStrictEqual(fresh.get('a'), 'y');

		const cleared = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults});
		cleared.clear();
		assert.deepStrictEqual(cleared.get('a'), 'y');

		const reset = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults});
		reset.set('a', 'zzz');
		reset.reset('a');
		assert.deepStrictEqual(reset.get('a'), 'y');
	});

	it('keeps a value a path default cannot reach, without dot notation too', () => {
		const defaults = {a: false, 'a.c': {p: 1}};

		const fresh = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults});
		assert.deepStrictEqual(fresh.get('a'), false);

		const cleared = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults});
		cleared.clear();
		assert.deepStrictEqual(cleared.get('a'), false);
	});
});

describe('a `defaults` value the caller changes afterwards', () => {
	// The value is taken as a copy, the way a `default` of the schema is, so a change the caller makes to the object the option holds afterwards is not what a `reset()` or a `clear()` writes back.
	for (const accessPropertiesByDotNotation of [true, false]) {
		it(`is written back as the option gave it, with dot notation: ${String(accessPropertiesByDotNotation)}`, () => {
			const nested = {x: 1};
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), accessPropertiesByDotNotation, defaults: {n: nested}});
			assert.deepStrictEqual(conf.get('n'), {x: 1});

			nested.x = 999;
			conf.set('unrelated', true);
			conf.reset('n');
			assert.deepStrictEqual(conf.get('n'), {x: 1});

			nested.x = 1000;
			conf.clear();
			assert.deepStrictEqual(conf.get('n'), {x: 1});
		});
	}

	// A `defaults` key the store does not hold is filled in by the write, which is the one path that reads the option rather than what this store recorded of it, so it is the one a change the caller makes afterwards reaches. Left alone, the same key has two different defaults: the one this store recorded, which a `reset()` and a `clear()` write back, and the one the option holds now.
	it('is not filled in either, by a write that finds the store without the key', () => {
		for (const accessPropertiesByDotNotation of [true, false]) {
			const label = `, with dot notation: ${String(accessPropertiesByDotNotation)}`;
			const nested = {x: 1};
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), accessPropertiesByDotNotation, defaults: {n: nested}});
			conf.set('unrelated', true);

			nested.x = 999;

			conf.store = {unrelated: true};
			assert.deepStrictEqual(conf.get('n'), {x: 1}, `a whole-store write${label}`);

			// The key is taken out of the file rather than with `delete()`, which is a write and would fill it in itself.
			fs.writeFileSync(conf.path, JSON.stringify({unrelated: true}));
			conf.set('unrelated', false);
			assert.deepStrictEqual(conf.get('n'), {x: 1}, `a set of another key${label}`);

			conf.reset('n');
			assert.deepStrictEqual(conf.get('n'), {x: 1}, `a reset agrees with the writes${label}`);
		}
	});
});

describe('a `default` of the schema without dot notation', () => {
	// The value is taken as a copy the way it is with dot notation, so the validator writing into the value a `reset()` or a `clear()` writes back does not reach the schema the caller gave, and a change the caller makes to it afterwards is not written back.
	it('leaves the object the schema gave as the caller gave it, without dot notation', () => {
		const schemaDefault = {keep: 1};
		const schema = {
			a: {type: 'object', default: schemaDefault, properties: {nested: {type: 'number', default: 5}}},
		};

		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), accessPropertiesByDotNotation: false, schema});
		conf.reset('a');
		assert.deepStrictEqual(Object.keys(schemaDefault), ['keep']);
		assert.deepStrictEqual(conf.get('a'), {keep: 1, nested: 5});
	});

	it('writes the value the schema gave, not a later change to it', () => {
		const schemaDefault = {keep: 1};
		const schema = {a: {type: 'object', default: schemaDefault}};

		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), accessPropertiesByDotNotation: false, schema});
		schemaDefault.keep = 999;
		conf.clear();
		assert.deepStrictEqual(conf.get('a'), {keep: 1});
	});
});

describe('a `defaults` path into a value the schema gives a `default` to', () => {
	// The default the schema gives the key the path is below is what the path is written into, an index included, the way it is for a key.
	it('writes an index into the array the schema gives, and every write agrees', () => {
		const schema = {a: {type: 'array', default: [1, 2]}};
		const defaults = {'a[0]': 9};

		const fresh = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults});
		const expected = {a: [9, 2]};
		assert.deepStrictEqual({...fresh.store}, expected);

		const cleared = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults});
		cleared.clear();
		assert.deepStrictEqual({...cleared.store}, expected);

		const resetIndex = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults});
		resetIndex.delete('a');
		resetIndex.reset('a[0]');
		assert.deepStrictEqual({...resetIndex.store}, expected);

		const resetKey = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults});
		resetKey.delete('a');
		resetKey.reset('a');
		assert.deepStrictEqual({...resetKey.store}, expected);
	});

	it('leaves the array the schema gives where the path is not an index of it', () => {
		const schema = {a: {type: 'array', default: [1, 2]}};

		// An array holds nothing but its elements, so the default cannot be written there and the store keeps the value, the way it does for a value from the file.
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults: {'a.x': 1}});
		assert.deepStrictEqual(conf.get('a'), [1, 2]);
		assert.deepStrictEqual({...conf.store}, {a: [1, 2]});
	});
});

describe('a `defaults` key without dot notation', () => {
	// The key is the whole key in this mode, so nothing on a path is copied, and a value whose JSON form comes from its prototype or its internal slots is not flattened by the copy.
	it('leaves a value the JSON form of comes from its prototype', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
			defaults: {'a.b': 1},
		});

		conf.store = {a: new Date(0)};
		assert.deepStrictEqual(readConfigFile(conf.path), {a: '1970-01-01T00:00:00.000Z', 'a.b': 1});
		assert.deepStrictEqual(conf.get('a'), '1970-01-01T00:00:00.000Z');
	});

	it('leaves a class instance the store holds as it is', () => {
		class Settings {
			theme = 'dark';
		}

		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
			defaults: {unrelated: 1},
		});

		conf.set('settings', new Settings());
		assert.deepStrictEqual(conf.get('settings'), {theme: 'dark'});
	});
});

describe('the `defaults` object the caller passed, after the store is built', () => {
	// The keys of the `defaults` option are read on every write, and the option is the caller's own object, so a key the caller adds to it afterwards would be written into the store as though the option had always named it. A value the caller CHANGES is not picked up, because a value is taken as a copy, which makes the two halves of the same object disagree with each other.
	it('does not write a key the caller added to the `defaults` object after the store was built', () => {
		const defaults: Record<string, unknown> = {a: {inner: 1}};
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd, defaults});

		defaults.b = {inner: 2};
		defaults.a = {inner: 999};

		conf.set('written', true);

		assert.deepStrictEqual({...conf.store}, {a: {inner: 1}, written: true}, 'neither the added key nor the changed value is written');
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {inner: 1}, written: true}, 'and neither is in the file');
	});

	it('does not write a key the caller added into a `defaults` object two stores share', () => {
		// The two stores are built from one object, and the key is added after both are built, so neither of them was given it. One of them writing it into its file is a key the caller never asked either for.
		const shared: Record<string, unknown> = {a: 1};
		const oneDirectory = createTempDirectory();
		const twoDirectory = createTempDirectory();
		const one = new Conf<Record<string, unknown>>({cwd: oneDirectory, defaults: shared});
		const two = new Conf<Record<string, unknown>>({cwd: twoDirectory, defaults: shared});

		shared.b = 2;

		one.set('touchedOne', true);
		two.set('touchedTwo', true);
		one.clear();

		assert.deepStrictEqual({...one.store}, {a: 1}, 'the store the key was never given does not hold it');
		assert.deepStrictEqual({...two.store}, {a: 1, touchedTwo: true}, 'nor does the other');
		assert.deepStrictEqual(readConfigFile(oneDirectory + '/config.json'), {a: 1}, 'and neither file holds it');
	});

	it('still writes a `defaults` key the store does not have, which is what the option is for', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd, defaults: {a: 1, b: 2}});

		conf.set('c', 3);
		conf.delete('a');

		// A write fills in a key the store is missing, and a `.delete()` is a write, which is why a key the option covers cannot be deleted.
		assert.deepStrictEqual({...conf.store}, {b: 2, c: 3, a: 1});
	});
});

describe('`schema` and `defaults`', () => {
	// A copy of a value that has lost the prototype it inherits drops the `toJSON` that `JSON.stringify` uses, so the copy is written as the own properties of a class instance rather than as what its `toJSON` answers with. A default is copied so that a write below it cannot reach the object the caller gave, so the copy has to write what the value wrote.
	describe('a default that writes itself', () => {
		it('writes a `defaults` value that writes itself the same way after `reset()`', () => {
			const store = new Conf<{price: unknown}>({cwd: createTempDirectory(), defaults: {price: price(500)}});

			assert.strictEqual(store.get('price'), '$5.00');

			store.set('price', price(900));
			assert.strictEqual(store.get('price'), '$9.00');

			store.reset('price');
			assert.strictEqual(store.get('price'), '$5.00');
		});

		it('writes a `defaults` value that writes itself the same way after `clear()`', () => {
			const store = new Conf<{price: unknown}>({cwd: createTempDirectory(), defaults: {price: price(500)}});

			store.set('price', price(900));
			store.clear();

			assert.strictEqual(store.get('price'), '$5.00');
		});

		it('writes a `default` in the `schema` that writes itself the same way after `clear()`', () => {
			const store = new Conf<{price: unknown}>({cwd: createTempDirectory(), schema: {price: {default: price(500)}}});

			assert.strictEqual(store.get('price'), '$5.00');

			store.set('price', '$9.00');
			store.clear();

			assert.strictEqual(store.get('price'), '$5.00');
		});

		it('keeps writing a `defaults` value that writes itself when a default of the schema is filled in beside it', () => {
			const store = new Conf<{price: unknown; other: {filledIn?: number}}>({
				cwd: createTempDirectory(),
				defaults: {price: price(500), other: {}},
				schema: {
					price: true,
					other: {type: 'object', properties: {filledIn: {type: 'number', default: 1}}},
				},
			});

			assert.deepStrictEqual(store.store, createNullProtoObject({price: '$5.00', other: {filledIn: 1}}));

			store.clear();

			assert.deepStrictEqual(store.store, createNullProtoObject({price: '$5.00', other: {filledIn: 1}}));
		});
	});

	// The validator writes the `default` of the schema into the data it is given, so a `defaults` value the store is built from has to be a copy of the one the caller gave. Otherwise the object the caller kept is the one the store fills its defaults in, and the caller's own object is what changes.
	describe('a `defaults` object the caller kept', () => {
		it('does not write a default of the schema into the `defaults` object the caller passed in', () => {
			const defaults = {nested: {}};
			const store = new Conf<{nested: {filledIn?: number}}>({
				cwd: createTempDirectory(),
				defaults,
				schema: {nested: {type: 'object', properties: {filledIn: {type: 'number', default: 42}}}},
			});

			assert.deepStrictEqual(defaults, {nested: {}});
			assert.deepStrictEqual(store.get('nested'), {filledIn: 42});
		});

		it('does not let a default of the schema leak from one store into another that share a `defaults` object', () => {
			const defaults = {nested: {}};

			const first = new Conf<{nested: {first?: number}}>({
				cwd: createTempDirectory(),
				defaults,
				schema: {nested: {type: 'object', properties: {first: {type: 'number', default: 1}}}},
			});
			const second = new Conf<{nested: {second?: number}}>({
				cwd: createTempDirectory(),
				defaults,
				schema: {nested: {type: 'object', properties: {second: {type: 'number', default: 2}}}},
			});

			assert.deepStrictEqual(defaults, {nested: {}});
			assert.deepStrictEqual(first.get('nested'), {first: 1});
			assert.deepStrictEqual(second.get('nested'), {second: 2});
		});

		it('does not write a default of the schema into a `defaults` value held below the root', () => {
			const defaults = {a: {inner: {}}};
			const store = new Conf<{a: {inner: {filledIn?: number}}}>({
				cwd: createTempDirectory(),
				defaults,
				schema: {a: {type: 'object', properties: {inner: {type: 'object', properties: {filledIn: {type: 'number', default: 7}}}}}},
			});

			assert.deepStrictEqual(defaults, {a: {inner: {}}});
			assert.deepStrictEqual(store.get('a.inner'), {filledIn: 7});
		});

		it('does not write a default of the schema into an array a `defaults` value holds', () => {
			const defaults = {list: [{}]};
			const store = new Conf<{list: Array<{filledIn?: number}>}>({
				cwd: createTempDirectory(),
				defaults,
				schema: {list: {type: 'array', items: {type: 'object', properties: {filledIn: {type: 'number', default: 3}}}}},
			});

			assert.deepStrictEqual(defaults, {list: [{}]});
			assert.deepStrictEqual(store.get('list'), [{filledIn: 3}]);
		});

		it('does not write a default of the schema into the `defaults` object the caller passed in, without dot notation', () => {
			const defaults = {nested: {}};
			const store = new Conf<{nested: {filledIn?: number}}>({
				cwd: createTempDirectory(),
				accessPropertiesByDotNotation: false,
				defaults,
				schema: {nested: {type: 'object', properties: {filledIn: {type: 'number', default: 42}}}},
			});

			assert.deepStrictEqual(defaults, {nested: {}});
			assert.deepStrictEqual(store.get('nested'), {filledIn: 42});
		});
	});
});

describe('a `defaults` key below a `default` of the schema', () => {
	// The path is written into whatever the key above it holds, so a key above that is a value nothing can be written below leaves the store as it was, rather than losing the default to a value written over it.
	const notAContainer: Array<[string, unknown]> = [
		['a string', 'text'],
		['a number', 5],
		['a boolean', true],
		['`null`', null],
	];

	it('leaves a `default` that is not an object where it is, and the store open', () => {
		for (const [name, value] of notAContainer) {
			const conf = new Conf<Record<string, any>>({
				cwd: createTempDirectory(),
				schema: {a: {default: value}},
				defaults: {'a.b': 1},
			});

			assert.deepStrictEqual({...conf.store}, {a: value}, name);
		}
	});

	it('leaves a `default` the schema names a type for where it is, so a store the schema rejects is not made', () => {
		for (const [name, type, value] of [
			['a string', 'string', 'text'],
			['a number', 'number', 5],
			['a boolean', 'boolean', true],
		] as Array<[string, string, string | number | boolean]>) {
			const conf = new Conf<Record<string, unknown>>({
				cwd: createTempDirectory(),
				schema: {a: {type, default: value}},
				defaults: {'a.b': 1},
			});

			// A `defaults` key below it is written nowhere, so the schema still holds and the store still opens.
			assert.deepStrictEqual({...conf.store}, {a: value}, name);
		}
	});

	it('still writes a `defaults` key below a `default` that is an object', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {a: {type: 'object', default: {x: 1}}},
			defaults: {'a.b': 2},
		});

		assert.deepStrictEqual({...conf.store}, {a: {x: 1, b: 2}});
	});

	it('still writes a `defaults` key below a `defaults` key that is an object', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {a: {x: 1}, 'a.b': 2}});

		assert.deepStrictEqual({...conf.store}, {a: {x: 1, b: 2}});
	});

	it('leaves a `defaults` key below a `default` that is a value rather than a container where it is', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {a: {type: 'string', default: 'text'}},
			defaults: {'a.b': 1},
		});

		conf.set('a', 'changed');
		conf.reset('a');

		assert.strictEqual(conf.get('a'), 'text');
		assert.strictEqual(conf.has('a.b'), false);
	});
});

describe('a `default` of the `schema` that a store cannot hold', () => {
	/**
	A value whose object graph comes back to itself, which `ajv` refuses while it compiles the schema, before the module has looked at the `default` at all.
	*/
	const cyclic = (): Record<string, unknown> => {
		const value: Record<string, unknown> = {
			name: 'loop',
			fn() {
				return 'something JSON cannot write';
			},
		};

		value.self = value;
		return value;
	};

	it('is reported by this module rather than by the schema compiler', () => {
		// `ajv` writes a `default` into the code it generates, so it stringifies the value while the schema is compiled. That is before the module looks at any `default`, so a value the store cannot hold reached the caller as `ajv`'s own error, which names neither the key nor what the store was asked to do.
		for (const [name, options] of [
			['no type', {schema: {a: {default: cyclic()}}}],
			['`type: object`', {schema: {a: {type: 'object', default: cyclic()}}}],
			['a `bigint` in it', {schema: {a: {default: {n: 1n}}}}],
		] as Array<[string, Record<string, unknown>]>) {
			assert.throws(
				() => new Conf({cwd: createTempDirectory(), ...options}),
				{name: 'TypeError', message: /for key `a`/},
				name,
			);
		}
	});

	it('is refused the same way a `defaults` value of the same shape is', () => {
		const viaDefaultsOption = (): void => {
			new Conf({cwd: createTempDirectory(), defaults: {a: cyclic()}});
		};

		const viaSchemaDefault = (): void => {
			new Conf({cwd: createTempDirectory(), schema: {a: {default: cyclic()}}});
		};

		let fromDefaultsOption: unknown;
		let fromSchemaDefault: unknown;
		// The message names the key, which is what tells this module's refusal apart from the one `JSON.stringify` makes of the same value.
		assert.throws(viaDefaultsOption, (error: Error) => {
			fromDefaultsOption = error.message;
			return error instanceof TypeError && error.message.includes('for key `a`');
		});

		assert.throws(viaSchemaDefault, (error: Error) => {
			fromSchemaDefault = error.message;
			return error instanceof TypeError && error.message.includes('for key `a`');
		});

		assert.strictEqual(fromSchemaDefault, fromDefaultsOption);
	});

	it('is not written at all when `useDefaults` is off, so there is nothing to refuse', () => {
		// A `default` the validator is not asked to apply is neither recorded nor inserted, so a value the store cannot hold is in no file and there is nothing for the store to refuse it for.
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			schema: {a: {default: cyclic()}},
			ajvOptions: {useDefaults: false},
		});

		assert.strictEqual(conf.has('a'), false);
		assert.deepStrictEqual({...conf.store}, {});

		// And a write still succeeds, since nothing of it is in the store.
		conf.set('b', 1);

		assert.strictEqual(conf.get('b'), 1);
	});
});

describe('a key another process took out of the file', () => {
	// The `defaults` option is filled in on a write, which is what `.delete()` is, and a read takes the file as it is. A `default` of the schema is filled in on both, because the validator does it as it reads.
	const takeTheKeyOut = (cwd: string): void => {
		fs.writeFileSync(`${cwd}/config.json`, JSON.stringify({kept: true}));
	};

	it('is put back by a read for a `default` of the schema, and not for the `defaults` option', () => {
		const withSchemaDefault = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			schema: {a: {type: 'number', default: 1}},
		});

		const withDefaultsOption = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults: {a: 1},
		});

		takeTheKeyOut(withSchemaDefault.path.replace(/\/config\.json$/, ''));
		takeTheKeyOut(withDefaultsOption.path.replace(/\/config\.json$/, ''));

		assert.strictEqual(withSchemaDefault.get('a'), 1, 'a `default` of the schema is filled in as the store is read');
		assert.strictEqual(withDefaultsOption.get('a'), undefined, 'the `defaults` option is filled in by a write, and a read is not one');
	});

	it('is put back for the `defaults` option by the next write', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {a: 1}});
		takeTheKeyOut(conf.path.replace(/\/config\.json$/, ''));
		assert.strictEqual(conf.get('a'), undefined);

		conf.set('written', true);

		assert.strictEqual(conf.get('a'), 1);
	});
});

describe('a `defaults` key that spells itself with a backslash', () => {
	// `a\.b.c` is a path of two parts, the first of which is a key of its own whose NAME holds a dot. Joining the parts back with a dot turns that name into a path again, so the value above the key is looked for and written under a path rather than under the name, which invents the key `a` and loses the `default` the schema has for it, because the validator now finds that key already there.
	const schema = {
		a: {
			type: 'object',
			default: {fromSchema: true},
			properties: {b: {type: 'object', default: {nested: 1}}},
		},
	};

	it('is written under the name the key spells itself with, and not under a path', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults: {[String.raw`a\.b.c`]: 1}});

		assert.deepStrictEqual({...conf.store}, {'a.b': {c: 1}, a: {fromSchema: true, b: {nested: 1}}});
		assert.strictEqual(conf.get(String.raw`a\.b.c`), 1, 'the key reads back as the value it was given');
		assert.strictEqual(conf.get('a.b.c'), undefined, 'and the two parts under it are not the key the value is at');
	});

	it('leaves the `default` of the schema for a key the validator is not given', () => {
		// The bug: joining the parts made the store hold an `a` the `defaults` option never named, so the schema's own `default` for `a` was skipped and `fromSchema` was lost with nothing said about it.
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults: {[String.raw`a\.b.c`]: 1}});

		assert.deepStrictEqual(conf.get('a'), {fromSchema: true, b: {nested: 1}});
	});

	it('writes into the path the schema names for a key that is not escaped', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults: {'a.b.c': 1}});

		assert.deepStrictEqual({...conf.store}, {a: {fromSchema: true, b: {nested: 1, c: 1}}});
	});

	it('round-trips a name holding every character a path is written with', () => {
		// A name holding a `.`, a `[`, a `]` and a `\\` is a name of its own only where each is escaped, and a key that names a value BELOW one is read as a path, so the first part is the name and the rest is a path into it. Writing the name back out has to escape all four again, or reading it back is a different key.
		const name = String.raw`has.a.dot[and]a\backslash`;
		const escaped = String.raw`has\.a\.dot\[and\]a\\backslash`;
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {[`${escaped}.c`]: 1}});

		assert.deepStrictEqual({...conf.store}, {[name]: {c: 1}});
		assert.strictEqual(conf.get(`${escaped}.c`), 1);
	});

	it('round-trips a name holding a single `\\` beside a bracket, which the case above keeps in the last part', () => {
		// The name above holds a `\\` too, but it is the LAST part of the key, and only the parts before the last are written back out. A name that is a part of its own and holds a `\\` is written back as a key that the parser cannot read at all, which is a `defaults` option the store is built from and cannot open.
		const name = String.raw`a\[b]`;
		const escaped = String.raw`a\\\[b\]`;
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: {[`${escaped}.c`]: 1}});

		assert.deepStrictEqual({...conf.store}, {[name]: {c: 1}});
		assert.strictEqual(conf.get(`${escaped}.c`), 1);
	});
});

describe('a default that writes itself from a private field', () => {
	it('reads back a `defaults` value whose `toJSON` needs a private field', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {price: new Money(500)}});
		assert.strictEqual(conf.get('price'), '$5.00');
	});

	it('writes a `defaults` value whose `toJSON` needs a private field back after `reset()`', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {price: new Money(500)}});
		conf.set('price', '$9.00');
		conf.reset('price');
		assert.strictEqual(conf.get('price'), '$5.00');
	});

	it('writes a `defaults` value whose `toJSON` needs a private field back after `clear()`', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {price: new Money(500)}});
		conf.set('price', '$9.00');
		conf.clear();
		assert.strictEqual(conf.get('price'), '$5.00');
	});

	it('writes a `schema` default whose `toJSON` needs a private field back after `reset()`', () => {
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			schema: {price: {default: new Money(500)}},
		});

		conf.set('price', '$9.00');
		conf.reset('price');
		assert.strictEqual(conf.get('price'), '$5.00');
	});

	it('does not write a `schema` default below a default that writes itself into the object the caller gave', () => {
		const given = price(500);
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			// The validator writes what the default's `toJSON` answered with, so the type the store holds is the one the writing gives it rather than the one the value is. The strict type check is off, so a `properties` beside it is not a warning.
			schema: {a: {default: given, properties: {b: {default: 1}}}},
			ajvOptions: {strictTypes: false},
		});

		assert.deepStrictEqual(Object.keys(given), ['cents'], 'the value the caller gave was written into');
		assert.strictEqual(conf.get('a'), '$5.00');
	});
});

describe('`defaults` and the `schema`', () => {
	it('schema - nested defaults are replaced by Conf defaults', () => {
		const schema: Schema<{appearance?: {theme?: string; layout?: string}}> = {
			appearance: {
				type: 'object',
				default: {
					theme: 'light',
					layout: 'grid',
				},
			},
		};

		const conf = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				appearance: {
					layout: 'list',
				},
			},
			schema,
		});

		assert.deepStrictEqual(conf.get('appearance'), {layout: 'list'});
	});

	it('schema - validate Conf default', () => {
		const schema: Schema<{foo: string}> = {
			foo: {
				type: 'string',
			},
		};
		assert.throws(() => {
			new Conf({
				cwd: createTempDirectory(),
				defaults: {
					// For our tests to fail and typescript to compile, we'll ignore this ts error.
					// This error is not bad and means the package is well typed.
					// @ts-expect-error
					foo: 1,
				},
				schema,
			});
		}, {message: 'Config schema violation: `foo` must be string'});
	});

	it('`defaults` option - a key the file does not hold reads as its default', () => {
		const cwd = createTempDirectory();
		const options: {cwd: string; defaults: Record<string, unknown>} = {cwd, defaults: {foo: 'default'}};
		const conf = new Conf(options);

		// The stored value wins over the default.
		conf.set('foo', 'stored');
		assert.strictEqual(conf.get('foo'), 'stored');

		// The defaults are part of the store, so a store that is replaced still holds the keys they cover, and every instance reads the same value for the file.
		conf.store = {bar: 1};
		assert.strictEqual(conf.get('foo'), 'default');
		assert.strictEqual(new Conf(options).get('foo'), 'default');

		// A key a default covers cannot be deleted, since the default is part of the store either way.
		conf.delete('foo');
		assert.strictEqual(conf.get('foo'), 'default');

		// The option names a key at the top level. A nested key is not part of the merge, so it is removed and a reset puts it back.
		const nested = new Conf({cwd: createTempDirectory(), defaults: {list: {a: 1, b: 2}}});
		nested.delete('list.a');
		assert.deepStrictEqual(nested.get('list'), {b: 2});
		nested.reset('list.a');
		assert.deepStrictEqual(nested.get('list'), {a: 1, b: 2});
	});

	it('`defaults` option - a key name `Object.prototype` has', () => {
		const cwd = createTempDirectory();
		const options: {cwd: string; defaults: Record<string, unknown>} = {cwd, defaults: {toString: 'value'}};
		const conf = new Conf(options);

		assert.strictEqual(conf.get('toString'), 'value');

		// Every instance has to read the same value for the file, so the key the option covers is kept when the store is written whole.
		conf.store = {bar: 1};
		assert.strictEqual(conf.get('toString'), 'value');
		assert.strictEqual(new Conf(options).get('toString'), 'value');
	});

	it('schema - Conf defaults overwrites schema default for a store that already exists', () => {
		const schema: Schema<{foo: string}> = {foo: {type: 'string', default: 'bar'}};
		const cwd = createTempDirectory();

		// A store that has run before is read from its config file, and the default inserted for a key the file does not hold has to be the value the option gives rather than the one the schema gives.
		fs.writeFileSync(path.join(cwd, 'config.json'), '{}');

		const conf = new Conf({cwd, defaults: {foo: 'foo'}, schema});
		assert.strictEqual(conf.get('foo'), 'foo');
		assert.strictEqual(new Conf({cwd, defaults: {foo: 'foo'}, schema}).get('foo'), 'foo');

		// The value the option gives is written back so other readers see the same store.
		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'foo'});

		// A value the store holds wins over both defaults, and it is the one that is written.
		conf.set('foo', 'stored');
		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'stored'});
		assert.strictEqual(new Conf({cwd, defaults: {foo: 'foo'}, schema}).get('foo'), 'stored');
	});

	it('applies schema defaults for missing keys', () => {
		const schema: Schema<{theme: string; count: number}> = {
			theme: {type: 'string', default: 'light'},
			count: {type: 'number', default: 5},
		};
		const conf = new Conf({cwd: createTempDirectory(), schema});
		assert.strictEqual(conf.get('theme'), 'light');
		assert.strictEqual(conf.get('count'), 5);
		// A key the schema gives a `default` to is one the store holds, so the fallback of a read is not what it gets.
		assert.strictEqual(conf.get('theme', ''), 'light');
	});

	it('defaults option wins over schema defaults', () => {
		const schema: Schema<{theme: string}> = {theme: {type: 'string', default: 'light'}};
		const conf = new Conf({cwd: createTempDirectory(), schema, defaults: {theme: 'dark'}});
		assert.strictEqual(conf.get('theme'), 'dark');
	});
});

describe('a `defaults` key set to `undefined`', () => {
	it('a `defaults` key set to `undefined` keeps the `default` of the schema', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			defaults: {a: undefined},
			schema: {
				a: {type: 'number', default: 5},
			},
		});

		// A key set to `undefined` is the same as one that is not passed, so the `default` of the schema is kept for it, and a reset restores that default rather than reading nothing.
		assert.strictEqual(store.get('a'), 5);

		store.set('a', 9);
		store.reset('a');
		assert.strictEqual(store.get('a'), 5);

		store.clear();
		assert.strictEqual(store.get('a'), 5);
	});

	it('keeps a key the `defaults` option covers when the store is given it as `undefined`', () => {
		const cwd = createTempDirectory();
		const store = new Conf<Record<string, unknown>>({cwd, defaults: {a: 1}});

		// A key that is set to `undefined` is the same as one that is not set, so the default is written back for it, and the file holds what a new instance reads.
		store.store = {a: undefined, b: 2};

		assert.deepStrictEqual(store.store, createNullProtoObject({a: 1, b: 2}));
		assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), {a: 1, b: 2});
	});
});

describe('a default with a `toJSON` below the top of it', () => {
	it('is held as what it writes, which is what the schema is asked about', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {object: {type: 'object', properties: {when: {type: 'string'}}}},
			defaults: {object: {when: new Date(0)}},
		});

		assert.deepEqual(conf.get('object'), {when: '1970-01-01T00:00:00.000Z'});
		conf.set('object.when', 'later');
		conf.reset('object');
		assert.deepEqual(conf.get('object'), {when: '1970-01-01T00:00:00.000Z'});
	});
});

describe('the `defaults` object the caller gave, which no write changes', () => {
	const schema = {
		nested: {
			type: 'object',
			properties: {
				added: {type: 'string', default: 'x'},
			},
		},
	};

	it('is not changed by the `default` of a schema when the store is created', () => {
		const defaults = {nested: {kept: 1}};
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults,
			schema,
		});

		assert.deepStrictEqual(defaults, {nested: {kept: 1}});
		assert.deepStrictEqual(conf.get('nested'), {kept: 1, added: 'x'});
	});

	it('is not changed by the `default` of a schema when the store is written whole', () => {
		const defaults = {nested: {kept: 1}};
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults,
			schema,
		});

		conf.store = {other: 'value'};

		assert.deepStrictEqual(defaults, {nested: {kept: 1}});
		assert.deepStrictEqual(conf.get('nested'), {kept: 1, added: 'x'});
	});

	it('is not changed by the `default` of a schema when the store is cleared', () => {
		const defaults = {nested: {kept: 1}};
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults,
			schema,
		});

		conf.set('other', 'value');
		conf.clear();

		assert.deepStrictEqual(defaults, {nested: {kept: 1}});
		assert.deepStrictEqual(conf.get('nested'), {kept: 1, added: 'x'});
	});

	it('is not changed by the `default` of a schema below a path', () => {
		const defaults = {'nested.deep': {kept: 1}};
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults,
			schema: {
				nested: {
					type: 'object',
					properties: {
						deep: {
							type: 'object',
							properties: {
								added: {type: 'string', default: 'x'},
							},
						},
					},
				},
			},
		});

		conf.store = {other: 'value'};

		assert.deepStrictEqual(defaults, {'nested.deep': {kept: 1}});
		assert.deepStrictEqual(conf.get('nested.deep'), {kept: 1, added: 'x'});
	});

	it('is not changed by the `default` of a schema without dot notation', () => {
		const defaults = {nested: {kept: 1}};
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults,
			schema,
			accessPropertiesByDotNotation: false,
		});

		conf.set('other', 'value');
		conf.store = {other: 'value'};
		conf.clear();

		assert.deepStrictEqual(defaults, {nested: {kept: 1}});
		assert.deepStrictEqual(conf.get('nested'), {kept: 1, added: 'x'});
	});

	it('is not changed by a change the store makes to a value it holds', () => {
		const defaults = {nested: {kept: 1}};
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults,
		});

		// A store whose file is gone is read as the store its `defaults` make, so the write below is a write into a value the store filled in from them.
		fs.rmSync(conf.path);
		conf.set('nested.kept', 2);

		assert.deepStrictEqual(defaults, {nested: {kept: 1}});
		assert.deepStrictEqual(conf.get('nested'), {kept: 2});

		conf.clear();
		assert.deepStrictEqual(conf.get('nested'), {kept: 1}, 'a `clear()` writes back the default the store recorded');
	});

	it('is not changed by a change the caller makes to it after the store was built', () => {
		// The keys of the option are copied where they are read, and so are its values, so that one key does not have two different defaults: the write fills a key the store is missing in from the option, while `reset()` and `clear()` write back what the store recorded. A value changed in the object after that is neither.
		const defaults: Record<string, unknown> = {a: {b: 1}, c: 2};
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults});

		(defaults.a as {b: number}).b = 99;
		defaults.c = 888;

		conf.set('other', 1);
		assert.deepStrictEqual({...conf.store}, {a: {b: 1}, c: 2, other: 1}, 'a write fills the key from what the store recorded');

		conf.reset('a');
		assert.deepStrictEqual(conf.get('a'), {b: 1}, 'and a reset writes back that same value');
	});

	it('is not seen by a second store built from the same object after the first was built', () => {
		const defaults: Record<string, unknown> = {a: 1};
		const one = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults});
		const two = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults});

		defaults.b = 2;

		one.set('written', true);
		two.set('written', true);

		assert.strictEqual(one.get('b'), undefined, 'the key the caller added after both were built');
		assert.strictEqual(two.get('b'), undefined);
	});
});
