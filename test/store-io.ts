/* eslint-disable @typescript-eslint/naming-convention, no-new, @typescript-eslint/no-unsafe-assignment -- A store is often built only for what it does to the file, the keys here are the ones a caller writes, and a value read back is `any`. */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Buffer} from 'node:buffer';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	createNullProtoObject,
	runRegisteredCleanups,
	resetTrackedConfs,
	readConfigFile,
	skipAsRoot,
	dateReviving,
	createResolvedTempDirectory,
	withSnap,
	price,
	createExistingConfig,
} from './_utilities.js';

type Store = Record<string, any>;

/**
Write a config file, so the store is one that already exists.
*/
const writeConfigFile = (cwd: string, contents: string): void => {
	fs.writeFileSync(path.join(cwd, 'config.json'), contents);
};

// A store the schema cannot accept once cleared either, so a construction cannot finish whichever way the schema violation is handled.
const refuseEveryStore = {required: ['needed']};

const flagMigrations = {
	'1.0.0'(store: Conf) {
		store.set('migrated', true);
	},
};

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a value written under a key reads back as the same value', () => {
	// The round trip a store owes, checked over values and keys chosen at random rather than one at a time. A value written under a key is what a read of that key answers with, and what a store built later on the same file reads, so a write that loses either is a bug whatever the value happens to be.
	//
	// A key no later write covered is the only one to check: a write of a key replaces what is at it, and a write of a path above it replaces the branch it is in, so a key either covered answers with what the later write put there rather than with what it was given. A value the file cannot hold is not a round trip either, since a `set()` of one is refused outright.
	let state = 20_260_929;
	const random = () => {
		// eslint-disable-next-line no-bitwise -- a 32-bit PRNG needs the wraparound.
		state = ((state * 1_664_525) + 1_013_904_223) >>> 0;
		return state / 4_294_967_296;
	};

	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

	const makeValue = (depth: number): unknown => {
		if (depth > 2 || random() < 0.35) {
			return pick([1, -1, 0, 1.5, 1e10, '', 'text', 'ünïcödé 🦄', true, false, null]);
		}

		if (random() < 0.5) {
			return Array.from({length: Math.floor(random() * 4)}, () => makeValue(depth + 1));
		}

		const object: Record<string, unknown> = {};
		for (let index = 0, size = Math.floor(random() * 4); index < size; index++) {
			object[pick(['a', 'b', 'key with space', 'ünïcödé', '0', '1'])] = makeValue(depth + 1);
		}

		return object;
	};

	const keys = ['a', 'b', 'c', 'a.b', 'a.b.c', 'b.c', 'key with space', 'ünïcödé', '0', 'a.0', 'list.0', 'nested.deep.key'];

	for (const accessPropertiesByDotNotation of [true, false]) {
		it(`holds for values and keys chosen at random, with dot notation: ${String(accessPropertiesByDotNotation)}`, () => {
			for (let run = 0; run < 60; run++) {
				const cwd = createTempDirectory();
				const conf = new Conf<Record<string, any>>({cwd, accessPropertiesByDotNotation});

				const written: Array<[string, unknown]> = [];
				for (let index = 0, count = 1 + Math.floor(random() * 5); index < count; index++) {
					const key = pick(keys);
					const value = makeValue(0);
					try {
						conf.set(key, value);
						written.push([key, value]);
					} catch {
						// A key this store refuses, or a value it cannot hold, is not a round trip to check.
					}
				}

				// A key no later write covered, and only the last write where the same key was written twice.
				const lastWrite = new Map<string, number>();
				for (const [index, [key]] of written.entries()) {
					lastWrite.set(key, index);
				}

				for (const [key, value] of written) {
					const index = written.findIndex(([name]) => name === key);
					if (lastWrite.get(key) !== index) {
						continue;
					}

					// A later write covers a key when it is the same key, a path above it, or a path below it: the last of those extends the value the key holds rather than replacing it, and a read answers with the value as it stands rather than as it was written.
					const coveredLater = written.some(([other], otherIndex) => otherIndex > index
						&& other !== key
						&& accessPropertiesByDotNotation
						&& (key.startsWith(`${other}.`) || other.startsWith(`${key}.`)));
					if (coveredLater) {
						continue;
					}

					const label = `run ${run}, key ${JSON.stringify(key)}`;
					assert.deepStrictEqual(conf.get(key), value, `the store reads back what it wrote for ${label}`);
				}

				// A store built on the file answers with the same thing, which is the file round trip.
				const later = new Conf<Record<string, any>>({cwd, accessPropertiesByDotNotation});
				assert.deepStrictEqual({...later.store}, {...conf.store}, `a store built later reads the same, run ${run}`);

				fs.rmSync(cwd, {recursive: true, force: true});
			}
		});
	}
});

// The file is what every later reader of the store sees, so a write that leaves the two holding different things is a write whose effect is not what the caller sees through the store. What a store owes its caller is checked as a set, after one operation on a fresh store of each shape, against what that operation leaves in a store kept in memory.
describe('what a store owes its caller', () => {
	const refusedPath = {name: 'Error', message: 'Config schema violation: `a` must be number'};

	// The store each shape starts from, which is what its `defaults` option gives, and the operation it refuses, which is a path written below a key its schema says is a number.
	const optionShapes: Array<{options: Record<string, unknown>; holds?: Store; refuses?: string}> = [
		{options: {}},
		{options: {accessPropertiesByDotNotation: false}},
		{options: {defaults: {a: 1}}, holds: {a: 1}},
		{options: {defaults: {'a.b': 1}}, holds: {a: {b: 1}}},
		{options: {schema: {a: {type: 'number'}}}, refuses: 'set of a path'},
		{options: {schema: {list: {type: 'array', items: {type: 'number'}}}}},
		{options: {schema: {a: {type: 'number'}}, defaults: {a: 1}}, holds: {a: 1}, refuses: 'set of a path'},
		{options: {clearInvalidConfig: true}},
		{options: {cache: true}},
		{options: {clearInvalidConfig: true, cache: true}},
		{options: {schema: {a: {type: 'number'}}, clearInvalidConfig: true}, refuses: 'set of a path'},
		{options: {defaults: {a: 1}, accessPropertiesByDotNotation: false}, holds: {a: 1}},
		{options: {schema: {}, rootSchema: {patternProperties: {'^x': {type: 'number'}}}}},
		{options: {schema: {a: {type: 'number'}}, ajvOptions: {coerceTypes: true}}, refuses: 'set of a path'},
		{options: {encryptionKey: 'a-key-that-is-long-enough'}},
		{
			options: {
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store: Conf<Record<string, any>>) {
						store.set('migrated', true);
					},
				},
			},
		},
	];

	// Each operation, with what it leaves in an empty store, and what it leaves there without dot notation where that is different.
	const operations: Array<[string, (conf: Conf<Record<string, any>>) => void, Store, Store?]> = [
		['set of a key', conf => {
			conf.set('a', 1);
		}, {a: 1}],
		['set of a path', conf => {
			conf.set('a.b.c', 1);
		}, {a: {b: {c: 1}}}, {'a.b.c': 1}],
		['set of an object', conf => {
			conf.set({x: 1, 'y.z': 2});
		}, {x: 1, y: {z: 2}}, {x: 1, 'y.z': 2}],
		['whole-store write', conf => {
			conf.store = {a: 1, list: [1, 2]};
		}, {a: 1, list: [1, 2]}],
		['delete of a key', conf => {
			conf.delete('a');
		}, {}],
		['clear', conf => {
			conf.clear();
		}, {}],
		['reset', conf => {
			conf.reset('a');
		}, {}],
		['append to an array', conf => {
			conf.appendToArray('list', 1);
		}, {list: [1]}],
	];

	for (const {options, holds = {}, refuses} of optionShapes) {
		for (const [operation, body, leaves, leavesWithoutDotNotation = leaves] of operations) {
			const where = `${JSON.stringify(options)}, after a ${operation}`;

			it(where, () => {
				const cwd = createTempDirectory();
				const conf = new Conf<Record<string, any>>({cwd, ...options});

				// A shape that refuses this operation is not one to hold the invariants for, so the refusal is what is checked instead.
				if (operation === refuses) {
					assert.throws(() => {
						body(conf);
					}, refusedPath);
					return;
				}

				body(conf);

				const store = {...conf.store};
				const held = Object.keys(store).sort();

				// What the operation leaves in an empty store, where a key it leaves out is the one the `defaults` option gives, since the defaults are part of the store.
				const expected = {...holds, ...(options.accessPropertiesByDotNotation === false ? leavesWithoutDotNotation : leaves)};
				assert.deepStrictEqual(store, expected, `the store after ${where}`);

				// The file is what a later reader sees, so where it is text it holds the same.
				if (!options.encryptionKey && fs.existsSync(conf.path)) {
					const {__internal__: _bookkeeping, ...inFile} = readConfigFile(conf.path) as Record<string, unknown>;
					assert.deepStrictEqual(inFile, expected, `the file after ${where}`);
				}

				// A store built on the same file answers the same way, which is the file round trip.
				assert.deepStrictEqual({...new Conf<Record<string, any>>({cwd, ...options}).store}, store, `a store built later, ${where}`);

				// The size counts the keys the store holds, and iteration gives them.
				assert.strictEqual(conf.size, held.length, `the size, ${where}`);
				assert.deepStrictEqual([...conf].map(([key]) => key).sort(), held, `what iteration gives, ${where}`);

				// A key the store holds reads as its own value and is one it has.
				for (const [key, value] of Object.entries(store)) {
					assert.deepStrictEqual(conf.get(key), value, `get ${JSON.stringify(key)}, ${where}`);
					assert.strictEqual(conf.has(key), true, `has ${JSON.stringify(key)}, ${where}`);
				}
			});
		}
	}
});

describe('the store and the file it was written from', () => {
	it('hold the same thing after every operation of a run of them', () => {
		const keys = ['a', 'b', 'a.b', 'a.b.c', 'list', 'list.0', 'c'];
		const values = [1, 'text', true, null, {x: 1}, [1, 2], 0, ''];

		// The operations are taken in turn rather than chosen at random, so the pair is compared in the states a run of them reaches and not only in the ones any single one of them leaves behind.
		const operations: Array<[string, (conf: Conf<Record<string, any>>) => void]> = [
			['set of a key', conf => {
				conf.set(keys[operations.length % keys.length]!, values[operations.length % values.length]);
			}],
			['delete of a key', conf => {
				conf.delete(keys[operations.length % keys.length]!);
			}],
			['whole-store write', conf => {
				conf.store = {a: 1, list: [1, 2]};
			}],
			['clear', conf => {
				conf.clear();
			}],
			['reset of a key', conf => {
				conf.reset('a');
			}],
			['append to an array', conf => {
				conf.appendToArray('list', operations.length);
			}],
		];

		for (const accessPropertiesByDotNotation of [true, false]) {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, any>>({cwd, accessPropertiesByDotNotation});

			for (let step = 0; step < 60; step++) {
				const [name, operation] = operations[step % operations.length]!;
				operation(conf);

				// A store that has written nothing has no file, which is a store not yet written to rather than one whose file went missing, so there is nothing to compare until something has been written.
				if (!fs.existsSync(conf.path)) {
					continue;
				}

				assert.deepStrictEqual(
					readConfigFile(conf.path),
					{...conf.store},
					`the file after a ${name}, with dot notation: ${String(accessPropertiesByDotNotation)}`,
				);
			}

			fs.rmSync(cwd, {recursive: true, force: true});
		}
	});
});

describe('a whole-store write of a number JSON writes as something else', () => {
	// A whole-store write writes what `JSON.stringify` writes, the way `set()` does.
	it('writes it as `null`, the way `set()` does', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		conf.store = {a: Number.NaN, b: {c: Number.POSITIVE_INFINITY}};
		assert.deepStrictEqual(readConfigFile(conf), {a: null, b: {c: null}});
	});

	it('still takes a `coerceTypes` that turned the text into a number the file can hold', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), schema: {a: {type: 'number'}}, ajvOptions: {coerceTypes: true}});

		conf.store = {a: '1'};

		assert.equal(readConfigFile(conf).a, 1);
	});
});

describe('the `store` setter', () => {
	it('drops a value JSON cannot hold rather than refusing the write, which is how a `deserialize` path relies on it', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {a: 'the default'}});

		// A `set()` of a function, a symbol or a `bigint` for a key is refused, since what the file would end up holding is not what was asked for. A whole-store write is a different case and is not refused: a `deserialize` of the caller's can hand back a store that holds a value with no JSON form, and the write drops it the way it always has, which is what `test/migration-rollback.ts` pins. Refusing here would take that away.
		conf.store = {
			a: 'written',
			handler() {
				return 'a value JSON cannot hold';
			},
			symbol: Symbol('a symbol'),
		};

		assert.deepStrictEqual({...conf.store}, {a: 'written'});
		assert.strictEqual(conf.has('handler'), false);
		assert.strictEqual(conf.has('symbol'), false);
	});

	it('takes a key set to `undefined` to mean the default is written back, which is the one answer that differs from `set()`', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {a: 'the default'}});
		conf.set('a', 'written');

		// A `set()` of `undefined` is refused because a store cannot hold it, while a whole-store write takes it to mean the key is left to the default, so it is the one value the two paths answer differently about.
		conf.store = {a: undefined};

		assert.strictEqual(conf.get('a'), 'the default');
	});

	it('does not add the `default` of a schema to the object it was given', () => {
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			schema: {
				bar: {type: 'boolean', default: true},
			},
		});

		const value: Record<string, unknown> = {foo: 'x'};
		conf.store = value;

		assert.deepStrictEqual(value, {foo: 'x'});
		assert.deepStrictEqual(conf.store, createNullProtoObject({foo: 'x', bar: true}));
	});

	it('writes what a `toJSON` the value inherits answers with', () => {
		class Settings {
			theme = 'dark';

			toJSON() {
				return {theme: this.theme, written: true};
			}
		}

		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), schema: {}});
		conf.store = new Settings() as never;

		assert.deepStrictEqual(readConfigFile(conf), {theme: 'dark', written: true});
	});

	it('keeps the bookkeeping of a store it writes that was read from the file', () => {
		const cwd = createTempDirectory();
		const options = {
			cwd,
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'() {
					// Only here so that the store holds bookkeeping.
				},
			},
		};

		const conf = new Conf(options);
		conf.set('foo', 'bar');
		conf.appendToArray('items', 'a');
		conf.delete('foo');
		conf.set('foo', 'baz');

		assert.ok((readConfigFile(conf) as {__internal__?: unknown}).__internal__);
		assert.deepStrictEqual(Object.keys(new Conf(options).store), ['items', 'foo']);
	});
});

describe('reading and writing the config file', () => {
	it('starts empty when no file exists and writes lazily', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		assert.strictEqual(fs.existsSync(configPath), false);
		const conf = new Conf({cwd});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		// Reading alone does not create the file.
		assert.strictEqual(fs.existsSync(configPath), false);
		conf.set('a', 1);
		assert.ok(fs.existsSync(configPath));
	});

	it('throws SyntaxError on corrupted JSON without clearInvalidConfig', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		fs.writeFileSync(conf.path, '{not-json');
		assert.throws(() => conf.get('a'), {name: 'SyntaxError'});
		assert.throws(() => conf.store, {name: 'SyntaxError'});
		assert.throws(() => conf.size, {name: 'SyntaxError'});
	});

	it('clears corrupted JSON with clearInvalidConfig', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{not-json');
		const conf = new Conf({cwd, clearInvalidConfig: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.strictEqual(conf.get('anything'), undefined);
		conf.set('recovered', true);
		assert.strictEqual(conf.get('recovered'), true);
	});

	it('treats a file containing null as an empty store', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), 'null');
		const conf = new Conf({cwd});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.strictEqual(conf.size, 0);
	});

	it('recreates the directory if deleted between writes', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		conf.set('a', 1);
		fs.rmSync(cwd, {recursive: true, force: true});
		// The deleted file cannot be recovered, but the directory is
		// recreated and the new write succeeds.
		conf.set('b', 2);
		assert.strictEqual(conf.get('b'), 2);
		assert.ok(fs.existsSync(conf.path));
	});

	it('custom serialize/deserialize round-trip', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({
			cwd,
			serialize: value => JSON.stringify(value, null, 2),
			deserialize: text => JSON.parse(text) as Record<string, unknown>,
		});
		conf.set('a', {b: [1, 2]});
		assert.deepStrictEqual(conf.get('a'), {b: [1, 2]});
		const raw = fs.readFileSync(conf.path, 'utf8');
		assert.ok(raw.includes('\n'));
		const second = new Conf({
			cwd,
			serialize: value => JSON.stringify(value, null, 2),
			deserialize: text => JSON.parse(text) as Record<string, unknown>,
		});
		assert.deepStrictEqual(second.get('a'), {b: [1, 2]});
	});

	it('a serialize failure leaves the previous file intact', () => {
		let shouldFail = false;
		const conf = new Conf({
			cwd: createTempDirectory(),
			serialize(value) {
				if (shouldFail) {
					throw new Error('boom');
				}

				return JSON.stringify(value);
			},
		});
		conf.set('good', 1);
		const before = fs.readFileSync(conf.path, 'utf8');
		shouldFail = true;
		assert.throws(() => {
			conf.set('bad', 2);
		}, {message: 'boom'});
		shouldFail = false;
		assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), before);
		assert.strictEqual(conf.get('good'), 1);
	});

	it('a deserialize failure surfaces on read', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({
			cwd,
			deserialize() {
				throw new SyntaxError('custom parse failed');
			},
		});
		conf.set('a', 1);
		assert.throws(() => conf.get('a'), {message: 'custom parse failed'});
	});

	it('supports a frozen object returned from deserialize', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({seed: 1}));
		const conf = new Conf({
			cwd,
			deserialize: text => Object.freeze(JSON.parse(text)) as Record<string, unknown>,
		});
		assert.strictEqual(conf.get('seed'), 1);
		conf.set('seed', 2);
		assert.strictEqual(conf.get('seed'), 2);
	});
});

describe('a whole-store write over a file the store cannot read', () => {
	// The setter reads the file only to keep the bookkeeping the module keeps there, so a file it cannot read has none to keep.
	const encryptedBy = (key: string, value: Record<string, unknown>): Uint8Array => {
		const initializationVector = crypto.randomBytes(16);
		const password = crypto.pbkdf2Sync(key, initializationVector, 10_000, 32, 'sha512');
		const cipher = crypto.createCipheriv('aes-256-cbc', password, initializationVector);
		const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value, undefined, '\t'))), cipher.final()]);
		return Buffer.concat([initializationVector, Buffer.from(':'), encrypted]);
	};

	// A whole-store write replaces what the file holds, so it writes over a file another key wrote, while a `set()` reads the file first and reports it.
	it('writes over a file another key wrote, where a `set()` reports it', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd, encryptionKey: 'this-key'});
		conf.set('writtenByThisKey', 'value');

		// The same store, the same file, written with a key that is not the one it reads it with.
		fs.writeFileSync(conf.path, encryptedBy('another-key', {writtenByAnotherKey: 'value'}));
		const before = fs.readFileSync(conf.path);

		assert.throws(() => {
			conf.set('another', 'value');
		}, {name: 'SyntaxError', message: `The config file \`${conf.path}\` is not valid JSON.`});
		assert.deepStrictEqual(fs.readFileSync(conf.path), before, 'the file after a `set()`');

		conf.store = {replaced: 'value'};
		assert.deepStrictEqual({...conf.store}, {replaced: 'value'});
	});
});

describe('a config file that is gone while the store holds a rule nothing satisfies', () => {
	// A store there is no file for is read as the store its `defaults` option and the `default`s of its schema make, and the schema is not enforced on it: there is no store to enforce it on, and enforcing it would make every read of it fail, and with it every write, since a write reads the file first.
	it('is read as the store its defaults make, and can be written to', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: 1}));

		const conf = new Conf<Record<string, unknown>>({
			cwd,
			clearInvalidConfig: true,
			schema: {a: {type: 'number'}, b: {type: 'number', default: 5}},
			rootSchema: {required: ['a']},
		});
		assert.strictEqual(conf.get('a'), 1, 'the value the file held');

		// `a` is required and nothing gives it a default, so the store there is no file for is not one the schema accepts, and enforcing it would make every read of it fail.
		fs.rmSync(conf.path);
		assert.strictEqual(conf.get('a'), undefined, 'a key the schema requires and nothing defaults');
		assert.strictEqual(conf.get('b'), 5, 'the default of the schema');

		conf.set('a', 2);
		assert.deepStrictEqual({...conf.store}, {a: 2, b: 5}, 'the store a write leaves');
	});
});

describe('a config file that is not there at all', () => {
	// There is no file, so a write brings it into being.
	it('is written by a whole-store write and a `clear()` after a read that could not', () => {
		const cwd = createTempDirectory();
		const writer = new Conf<Record<string, unknown>>({cwd, encryptionKey: 'the-key'});
		writer.set('secret', 'value');

		const noKey = new Conf<Record<string, unknown>>({cwd, clearInvalidConfig: true});
		assert.deepStrictEqual(noKey.get('secret'), undefined, 'the store read without the key');

		fs.rmSync(noKey.path);
		noKey.store = {a: 1};
		assert.deepStrictEqual(readConfigFile(noKey.path), {a: 1}, 'the file after a whole-store write');

		fs.rmSync(noKey.path);
		noKey.clear();
		assert.deepStrictEqual(readConfigFile(noKey.path), {}, 'the file after a clear()');
	});
});

describe('a file the store could not read and then could', () => {
	// A file that has become readable again is written the way any other file is.
	const makeRecovered = (): {conf: Conf; before: Uint8Array} => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd, clearInvalidConfig: true});
		conf.set('foo', 1);
		const before = fs.readFileSync(conf.path);

		// A file that is not text is one the store cannot read, the same as a file a key does not read.
		fs.writeFileSync(conf.path, crypto.randomBytes(48));
		assert.deepStrictEqual(conf.get('foo'), undefined, 'the store while the file cannot be read');

		fs.writeFileSync(conf.path, before);
		return {conf, before};
	};

	it('is written by a `set()`', () => {
		const {conf} = makeRecovered();
		conf.set('bar', 2);
		assert.deepStrictEqual({...conf.store}, {foo: 1, bar: 2});
	});

	it('is written by a whole-store write', () => {
		const {conf, before} = makeRecovered();
		conf.store = {bar: 2};
		assert.deepStrictEqual(readConfigFile(conf.path), {bar: 2});
		assert.notDeepStrictEqual(fs.readFileSync(conf.path), before);
	});

	it('is written by a `clear()`', () => {
		const {conf} = makeRecovered();
		conf.clear();
		assert.deepStrictEqual({...conf.store}, {});
	});
});

describe('a store whose file is gone', () => {
	// A store that does not exist is read as the store the `defaults` option and the schema make, the same as one that exists and holds nothing, so that a read and the write that follows it agree.
	it('reads the store the defaults make, the same as a file holding nothing', () => {
		const cwd = createTempDirectory();
		const options = {
			schema: {a: {type: 'number', default: 5}},
			defaults: {b: 6},
		};

		const gone = new Conf<Record<string, unknown>>({cwd, ...options});
		const before = gone.store;
		fs.rmSync(gone.path);

		assert.deepStrictEqual({...gone.store}, {...before}, 'the store read while the file is gone');
		assert.strictEqual(gone.get('a'), 5, 'the `default` of the schema read while the file is gone');
		assert.strictEqual(gone.get('b'), 6, 'the `defaults` option read while the file is gone');
		assert.strictEqual(gone.size, 2, 'the item count read while the file is gone');
		assert.deepStrictEqual([...gone].toSorted(([first], [second]) => String(first) < String(second) ? -1 : 1), [['a', 5], ['b', 6]], 'the iteration read while the file is gone');
		assert.strictEqual(gone.has('a'), true, '`has()` read while the file is gone');

		// A read does not bring the file back, which is the write that does.
		assert.strictEqual(fs.existsSync(gone.path), false);
		gone.set('c', 7);
		assert.deepStrictEqual({...gone.store}, {b: 6, a: 5, c: 7}, 'the store after a write');
	});
});

describe('config file that does not hold an object', () => {
	// The `store` setter takes a value that is not a whole object as an empty store, so a file holding one reads back as an empty store too, instead of an object made of its characters or indices.
	const notWholeObjects = [
		['a string', '"hello"'],
		['a number', '123'],
		['a boolean', 'true'],
		['null', 'null'],
		['an array', '[1,2,3]'],
	] as const;

	for (const [name, content] of notWholeObjects) {
		it(`reads a file that holds ${name} as an empty store`, () => {
			const cwd = createTempDirectory();
			fs.writeFileSync(path.join(cwd, 'config.json'), content);
			const conf = new Conf({cwd});
			assert.deepStrictEqual(conf.store, createNullProtoObject({}));
			assert.strictEqual(conf.size, 0);
			assert.deepStrictEqual([...conf], []);
			assert.strictEqual(conf.get('0'), undefined);
		});
	}

	it('keeps reading the file as an empty store on every read', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		fs.writeFileSync(filePath, '"hello"');
		const conf = new Conf({cwd, cache: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		conf.set('foo', 'bar');
		assert.deepStrictEqual(conf.store, createNullProtoObject({foo: 'bar'}));
		assert.deepStrictEqual(readConfigFile(filePath), {foo: 'bar'});
	});
});

describe('a value the store is written with that writes itself', () => {
	// The `store` setter has to leave a file the store can be read from, and a value that writes itself as text would leave a file that is a bare JSON value instead. A value set at a key is written as itself, which is where such a value belongs.
	it('writes an empty store instead of a bare JSON value', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		conf.set('kept', 'me');
		const before = fs.readFileSync(conf.path);

		const store = new Conf({cwd});
		store.store = new Date(0) as any;

		assert.deepStrictEqual(readConfigFile(store.path), {});
		assert.deepStrictEqual(store.store, createNullProtoObject({}));
		assert.ok(before.length > 0);
	});

	it('writes an empty store for a class whose `toJSON` answers with text', () => {
		class Text {
			toJSON(): string {
				return 'not a store';
			}
		}

		const store = new Conf({cwd: createTempDirectory()});
		store.store = new Text() as any;
		assert.deepStrictEqual(readConfigFile(store.path), {});
	});

	it('still writes a value that writes itself as text at a key', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		conf.set('when', new Date(0));
		assert.strictEqual(conf.get('when'), '1970-01-01T00:00:00.000Z');
	});

	// What a `toJSON` answers with is asked for, since a value that answers with text would leave a file that is a bare JSON value, while one that answers with an object is a store.
	it('writes what a `toJSON` answers with, where that is a store', () => {
		for (const [name, value, expected] of [
			['a plain object', {toJSON: () => ({a: 1})}, {a: 1}],
			['a class', new (class Settings {
				theme = 'dark';
				toJSON() {
					return {theme: this.theme};
				}
			})(), {theme: 'dark'}],
		] as Array<[string, unknown, Record<string, unknown>]>) {
			const store = new Conf({cwd: createTempDirectory()});
			store.store = value as Record<string, unknown>;
			const written: unknown = readConfigFile(store.path);
			assert.deepStrictEqual(written, expected, `the store a ${name} wrote`);
		}
	});

	it('writes an empty store where a `toJSON` answers with something that is not one', () => {
		for (const [name, value] of [
			['text', {toJSON: () => 'text'}],
			['a number', {toJSON: () => 5}],
			['null', {toJSON: () => null}],
			['nothing at all', {toJSON: () => undefined}],
			['an array', {toJSON: () => [1, 2]}],
		] as Array<[string, unknown]>) {
			const store = new Conf({cwd: createTempDirectory()});
			store.store = value as Record<string, unknown>;
			const written: unknown = readConfigFile(store.path);
			assert.deepStrictEqual(written, {}, `the store for a \`toJSON\` answering with ${name} is not empty`);
		}
	});

	// What a `toJSON` answers with is taken as the store before anything copies it, so it is written whatever the options, with the `defaults` filled in.
	it('writes what a `toJSON` answers with, whatever the options', () => {
		class Settings {
			theme = 'dark';
			toJSON() {
				return {theme: this.theme, written: true};
			}
		}

		for (const [name, options] of [
			['a `schema`', {schema: {}}],
			['a `rootSchema`', {rootSchema: {}}],
			['an `ajvOptions`', {ajvOptions: {}}],
			['a `defaults`', {defaults: {unrelated: 1}}],
			['a `defaults` without dot notation', {accessPropertiesByDotNotation: false, defaults: {unrelated: 1}}],
			['the bookkeeping of a migration', {projectVersion: '1.0.0', migrations: {}}],
		] as Array<[string, Record<string, unknown>]>) {
			const store = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), ...options});
			store.store = new Settings() as never;
			assert.deepStrictEqual({...store.store}, {theme: 'dark', written: true, ...options.defaults as Record<string, unknown>}, `the store written where there is ${name}`);
		}
	});

	// What a `toJSON` answers with is what the file gets, so it is what the validator is asked about and what the bookkeeping and the `defaults` option are kept in.
	it('validates what a `toJSON` answers with, and keeps the bookkeeping and the `defaults` in it', () => {
		const value = {
			toJSON: () => ({a: 'not a number'}),
		};

		const cwd = createTempDirectory();
		createExistingConfig(cwd, {});
		const store = new Conf<Record<string, unknown>>({
			cwd,
			schema: {a: {type: 'number'}},
			defaults: {kept: 1},
			projectVersion: '1.0.0',
			migrations: {},
		});

		assert.throws(() => {
			store.store = value;
		}, {message: /`a` must be number/});

		store.store = {toJSON: () => ({a: 2})};
		assert.deepStrictEqual(readConfigFile(store), {a: 2, kept: 1, __internal__: {migrations: {version: '1.0.0'}}});
	});

	it('writes a plain object that holds a value which writes itself', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		conf.store = {when: new Date(0)};
		assert.deepStrictEqual(readConfigFile(conf.path), {when: '1970-01-01T00:00:00.000Z'});
	});
});

describe('a write that did not happen', () => {
	it('leaves the cache answering from the file it did not change', {skip: skipAsRoot}, () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd, cache: true});
		conf.set('a', 1);

		// A directory the file cannot be written in is the one failure a store cannot recover from on its own.
		fs.chmodSync(cwd, 0o500);
		try {
			assert.throws(() => {
				conf.set('a', 2);
			}, {code: 'EACCES'});
		} finally {
			fs.chmodSync(cwd, 0o700);
		}

		assert.strictEqual(conf.get('a'), 1, 'the value the file still holds');
		assert.deepStrictEqual(readConfigFile(conf.path), {a: 1}, 'the file');
	});

	it('leaves a `serialize` that throws the file it did not change', () => {
		const cwd = createTempDirectory();
		let fail = false;
		const conf = new Conf<Record<string, unknown>>({
			cwd,
			serialize(value) {
				if (fail) {
					throw new Error('cannot write');
				}

				return JSON.stringify(value);
			},
		});

		conf.set('a', 1);
		const before = fs.readFileSync(conf.path);
		fail = true;
		assert.throws(() => {
			conf.set('a', 2);
		}, {message: 'cannot write'});
		assert.deepStrictEqual(fs.readFileSync(conf.path), before);
		assert.strictEqual(conf.get('a'), 1);
	});
});

describe('a read, which does not create the file', () => {
	it('get() does not create the file', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		conf.get('missing');
		assert.strictEqual(fs.existsSync(path.join(cwd, 'config.json')), false);
	});

	it('has() does not create the file', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		conf.has('missing');
		assert.strictEqual(fs.existsSync(path.join(cwd, 'config.json')), false);
	});

	it('size does not create the file', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		assert.strictEqual(conf.size, 0);
		assert.strictEqual(fs.existsSync(path.join(cwd, 'config.json')), false);
	});

	it('store getter does not create the file', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.strictEqual(fs.existsSync(path.join(cwd, 'config.json')), false);
	});

	it('iteration does not create the file', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		assert.deepStrictEqual([...conf], []);
		assert.strictEqual(fs.existsSync(path.join(cwd, 'config.json')), false);
	});
});

describe('a key below a value that writes itself', () => {
	// A `set()` writes on the store the config file holds, where a `Date` is the text it writes and a class instance is what its `toJSON` answers with, so the refusal the readme describes is for a store that holds the value itself.
	it('is written in place of a `Date` the file holds as its text', () => {
		const config = new Conf<Store>({cwd: createTempDirectory()});
		config.set('when', new Date(0));

		assert.strictEqual(config.get('when'), '1970-01-01T00:00:00.000Z', 'the file holds the text the `Date` writes');

		config.set('when.minute', 1);

		assert.deepStrictEqual({...config.store}, {when: {minute: 1}});
	});

	it('is written in place of a class instance the file holds as what its `toJSON` answers with', () => {
		const prototype = {
			toJSON(this: {cents: number}) {
				return `$${(this.cents / 100).toFixed(2)}`;
			},
		};
		const price = (cents: number) => Object.assign(Object.create(prototype) as {cents: number}, {cents});

		const config = new Conf<Store>({cwd: createTempDirectory()});
		config.set('price', price(500));

		assert.strictEqual(config.get('price'), '$5.00', 'the file holds what the `toJSON` answers with');

		config.set('price.cents', 900);

		assert.deepStrictEqual({...config.store}, {price: {cents: 900}});
	});

	it('is written in place of a `defaults` value that writes itself', () => {
		const config = new Conf<Store>({cwd: createTempDirectory(), defaults: {when: new Date(0)}});

		assert.strictEqual(config.get('when'), '1970-01-01T00:00:00.000Z');

		config.set('when.minute', 1);

		assert.deepStrictEqual({...config.store}, {when: {minute: 1}});
	});

	it('is refused where a `deserialize` of the caller holds the value itself', () => {
		const config = new Conf<Store>({cwd: createTempDirectory(), ...dateReviving});
		config.set('when', new Date(0));

		assert.ok(config.get('when') instanceof Date, 'the store holds a `Date`');

		assert.throws(() => {
			config.set('when.minute', 1);
		}, {name: 'TypeError', message: 'The key `when.minute` cannot be set, since the value the store holds for it cannot be written through.'});

		assert.ok(config.get('when') instanceof Date, 'the `Date` is left as it was');
		assert.doesNotMatch(fs.readFileSync(config.path, 'utf8'), /minute/);
	});
});

describe('a value a store cannot hold below the key', () => {
	// A `bigint` has no JSON form at all, and `JSON.stringify` refuses it with an error from deep inside the serializer, which names neither the key nor the type. It is refused wherever in the value it is.
	it('refuses a `bigint` below the key with a message that names the key and the path', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set('kept', 'value');
		const before = fs.readFileSync(conf.path);

		for (const [key, value, at] of [
			['v', {a: 1n}, 'a'],
			['v', {a: {b: 1n}}, 'a.b'],
			['v', {a: [1n]}, 'a.0'],
			['v', [1n], '0'],
		] as Array<[string, unknown, string]>) {
			assert.throws(() => {
				conf.set(key, value);
			}, {
				name: 'TypeError',
				message: `Setting a value of type \`bigint\` for key \`${key}\` at \`${at}\` is not allowed as it's not supported by JSON`,
			});
		}

		assert.deepStrictEqual(fs.readFileSync(conf.path), before);
	});

	it('refuses it as a `defaults` value and an appended item', () => {
		assert.throws(() => new Conf({
			cwd: createTempDirectory(),
			defaults: {a: {b: 1n}},
		}), {name: 'TypeError', message: 'Setting a value of type `bigint` for key `a` at `b` is not allowed as it\'s not supported by JSON'});

		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		assert.throws(() => {
			conf.appendToArray('list', {a: 1n});
		}, {name: 'TypeError', message: 'Setting a value of type `bigint` for key `list` at `a` is not allowed as it\'s not supported by JSON'});
		assert.strictEqual(conf.has('list'), false);
	});

	// A `default` of the schema is compiled into the validator before the module reads it, and a `bigint` in one is what the compiler refuses over, which the suite already takes for what reports it. Nothing is written either way, and the store never opens.
	it('is refused while the schema is compiled, before anything is written', () => {
		const cwd = createTempDirectory();
		assert.throws(() => new Conf({
			cwd,
			schema: {a: {type: 'object', default: {b: 1n}}},
		}), {name: 'TypeError'});
		assert.strictEqual(fs.existsSync(path.join(cwd, 'config.json')), false);
	});

	// `JSON.stringify` drops a value it has no form for out of an object and writes it as `null` in an array, and the store has always done the same rather than refuse it, so a walk for what JSON cannot write leaves those alone.
	it('keeps writing a nested `undefined`, `symbol` and `function` the way `JSON.stringify` does', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set({
			a: {b: undefined},
			s: {v: Symbol('x')},
			f: {v: () => 1},
			h: [undefined, Symbol('x'), () => 1],
		});
		assert.deepStrictEqual(readConfigFile(conf), {
			a: {},
			s: {},
			f: {},
			h: [null, null, null],
		});
	});

	// A value that writes itself is written as whatever it writes rather than as the keys below it, so what is below one is not what the file holds and nothing in it is a value the caller set.
	it('does not look below a value that writes itself', () => {
		class Settings {
			theme = 'dark';
			kept = 1n;
			toJSON(): Record<string, unknown> {
				return {theme: this.theme};
			}
		}

		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set('v', new Settings());
		assert.deepStrictEqual(readConfigFile(conf), {v: {theme: 'dark'}});
	});

	it('does not walk a value that holds itself forever', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		const value: Record<string, unknown> = {a: 1};
		value.self = value;

		// The walk stops at a value it is already inside rather than running out of stack first, and reports the circle itself, naming the key and the edge that closes the loop, where the serializer's own error names neither and its wording is the engine's to change.
		assert.throws(() => {
			conf.set('v', value);
		}, {name: 'TypeError', message: /for key `v` at `self` is not allowed as a value that holds itself/});
	});
});

describe('a config file that is not valid JSON', () => {
	// The error from `JSON.parse` quotes the part of the file around the failure, which is where a config file keeps whatever the caller did not mean to put in a log or a crash report.
	const secret = 'TOPSECRET';
	const damaged = `{"a":1,"key":${secret}}`;

	it('is reported without the part of the file that is around the failure', () => {
		const cwd = createTempDirectory();
		writeConfigFile(cwd, damaged);

		assert.throws(() => new Conf({cwd}), (error: unknown) => {
			assert.equal((error as Error).message.includes(secret), false);
			return true;
		});
	});

	it('is reported for the file it is about, as a `SyntaxError`', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		writeConfigFile(cwd, damaged);

		assert.throws(() => new Conf({cwd}), {name: 'SyntaxError', message: `The config file \`${configPath}\` is not valid JSON.`});
	});
});

describe('a config directory that is behind a symlink', () => {
	// A write goes to the file a link at the config path points at, so the directory that file goes in is one the write has to make. A directory behind a link of its own is that directory only once the link is followed, and a link standing where the directory belongs is nothing the write can make one under.
	it('makes a directory that is behind a link of its own', () => {
		const base = createResolvedTempDirectory();
		const cwd = path.join(base, 'cwd');
		fs.mkdirSync(cwd);
		// The link at the config path names a file in a directory that is itself a link, and that directory is not there yet.
		fs.symlinkSync(path.join(base, 'real'), path.join(cwd, 'linkdir'));
		fs.symlinkSync('linkdir/config.json', path.join(cwd, 'config.json'));

		const conf = new Conf<Record<string, unknown>>({cwd});
		conf.set('a', 1);

		assert.ok(fs.lstatSync(path.join(cwd, 'config.json')).isSymbolicLink(), 'the link at the config path is still a link');
		assert.ok(fs.lstatSync(path.join(cwd, 'linkdir')).isSymbolicLink(), 'the link to the directory is still a link');
		assert.deepStrictEqual(readConfigFile(path.join(base, 'real', 'config.json')), {a: 1}, 'the file where the links lead holds the store');
		assert.strictEqual(conf.get('a'), 1, 'the store reads back');
	});

	// The same where the link at the config path goes through another link on its way, so the directory is behind every link of the way to it.
	it('makes a directory that is behind a chain of links of its own', () => {
		const base = createResolvedTempDirectory();
		const cwd = path.join(base, 'cwd');
		fs.mkdirSync(cwd);
		fs.symlinkSync(path.join(base, 'real'), path.join(cwd, 'linkdir'));
		fs.symlinkSync('linkdir/config.json', path.join(cwd, 'first.json'));
		fs.symlinkSync('first.json', path.join(cwd, 'config.json'));

		const conf = new Conf<Record<string, unknown>>({cwd});
		conf.set('a', 1);

		assert.deepStrictEqual(readConfigFile(path.join(base, 'real', 'config.json')), {a: 1}, 'the file where the links lead holds the store');
		assert.strictEqual(conf.get('a'), 1, 'the store reads back');
	});

	// The directory is where the links lead whether or not it was there before, so a store that finds it writes into the one the caller has rather than one of its own making beside it.
	it('keeps writing into a directory that is behind a link and is already there', () => {
		const base = createResolvedTempDirectory();
		const cwd = path.join(base, 'cwd');
		fs.mkdirSync(cwd);
		fs.mkdirSync(path.join(base, 'real'));
		fs.symlinkSync(path.join(base, 'real'), path.join(cwd, 'linkdir'));
		fs.symlinkSync('linkdir/config.json', path.join(cwd, 'config.json'));

		const conf = new Conf<Record<string, unknown>>({cwd});
		conf.set('a', 1);

		assert.deepStrictEqual(fs.readdirSync(cwd).sort(), ['config.json', 'linkdir'], 'nothing is made where the link is');
		assert.deepStrictEqual(readConfigFile(path.join(base, 'real', 'config.json')), {a: 1}, 'the file where the links lead holds the store');
		assert.strictEqual(conf.get('a'), 1, 'the store reads back');
	});

	// The kernel resolves a `..` in a relative link from the directory the link is really in, so a `cwd` that is itself a link must not make the write climb out of the link instead.
	it('follows a dangling relative link with `..` from inside a `cwd` that is a link', () => {
		const base = createResolvedTempDirectory();
		fs.mkdirSync(path.join(base, 'real', 'nested'), {recursive: true});
		const cwd = path.join(base, 'cwd');
		fs.symlinkSync(path.join(base, 'real', 'nested'), cwd);
		fs.symlinkSync('../config-target.json', path.join(cwd, 'config.json'));

		const conf = new Conf<Record<string, unknown>>({cwd});
		conf.set('a', 1);

		assert.deepStrictEqual(readConfigFile(path.join(base, 'real', 'config-target.json')), {a: 1}, 'the file the kernel resolves the link to holds the store');
		assert.ok(!fs.existsSync(path.join(base, 'config-target.json')), 'nothing is written beside the link to `cwd`');
		assert.strictEqual(conf.get('a'), 1, 'the store reads back');
	});
});

describe('a config path that is a symlink', () => {
	// A write follows a link at the config path, so the file a construction leaves behind is the one the link points at. Putting the file back has to put back that one, where taking the path away instead leaves the file the write made behind and takes the link the caller put there with it.
	it('leaves the link and the file a construction that cannot finish made', () => {
		const cwd = createTempDirectory();
		const link = path.join(cwd, 'config.json');
		fs.symlinkSync('shared.json', link);

		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: flagMigrations,
				rootSchema: refuseEveryStore,
			});
		}, {message: /must have required property/});

		assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link');
		assert.deepEqual(fs.readdirSync(cwd), ['config.json'], 'nothing is left where the write put the file');
	});

	// A store that is cleared is written as well, so the same file is left behind the same way and has to be taken away the same way.
	it('leaves the link and the file a store a migration cannot write made', () => {
		const cwd = createTempDirectory();
		const link = path.join(cwd, 'config.json');
		fs.symlinkSync('shared.json', link);

		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: flagMigrations,
				rootSchema: refuseEveryStore,
				clearInvalidConfig: true,
			});
		}, {message: /must have required property/});

		assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link');
		assert.deepEqual(fs.readdirSync(cwd), ['config.json'], 'nothing is left where the write put the file');
	});

	// A link that points at a file that is there is put back the way it was found, which is through the link, so the file itself is what is written.
	it('puts a file a link resolves to back the way it was', () => {
		const cwd = createTempDirectory();
		const target = path.join(cwd, 'shared.json');
		fs.writeFileSync(target, JSON.stringify({before: true}, undefined, '\t'));
		fs.symlinkSync('shared.json', path.join(cwd, 'config.json'));

		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: flagMigrations,
				rootSchema: refuseEveryStore,
			});
		}, {message: /must have required property/});

		assert.ok(fs.lstatSync(path.join(cwd, 'config.json')).isSymbolicLink(), 'the link is still a link');
		assert.deepEqual(readConfigFile(target), {before: true}, 'the file holds what it held');
	});

	// A file that is there is put back the way it was found, whatever the migrations did to it.
	it('puts a plain config file back the way it was', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({before: true}, undefined, '\t'));

		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: flagMigrations,
				rootSchema: refuseEveryStore,
			});
		}, {message: /must have required property/});

		assert.deepEqual(readConfigFile(path.join(cwd, 'config.json')), {before: true}, 'the file holds what it held');
	});

	// The same for a store that is not there yet, which is the case the file goes back to being absent in.
	it('leaves no file where a store that is not there yet failed to open', () => {
		const cwd = createTempDirectory();

		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: flagMigrations,
				rootSchema: refuseEveryStore,
			});
		}, {message: /must have required property/});

		assert.deepEqual(fs.readdirSync(cwd), [], 'the directory is as it was');
	});

	// A link that points nowhere is a file the write makes where it points, so the store reads back what it wrote through the link.
	it('keeps a link that points nowhere and writes where it points', () => {
		const cwd = createTempDirectory();
		const link = path.join(cwd, 'config.json');
		fs.symlinkSync('shared.json', link);

		const conf = new Conf<Record<string, unknown>>({cwd, projectVersion: '1.0.0', migrations: flagMigrations});
		conf.set('added', true);

		assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link');
		assert.deepEqual(readConfigFile(path.join(cwd, 'shared.json')), {added: true, __internal__: {migrations: {version: '1.0.0'}}});
		assert.strictEqual(conf.get('added'), true);
	});

	// A chain of links is followed to the end of it, since a read follows the whole of it and the file the write belongs in is the one at the end.
	for (const [name, file, before] of [
		['resolves', 'shared.json', {kept: true}],
		['points nowhere', 'nowhere.json', undefined],
	] as Array<[string, string, Record<string, unknown> | undefined]>) {
		it(`keeps every link of a chain that ${name}`, () => {
			const cwd = createTempDirectory();
			if (before) {
				fs.writeFileSync(path.join(cwd, file), JSON.stringify(before));
			}

			// The config path points at the first link, which points at the second, which points at the file the store is written to.
			fs.symlinkSync('second.json', path.join(cwd, 'first.json'));
			fs.symlinkSync(file, path.join(cwd, 'second.json'));
			fs.symlinkSync('first.json', path.join(cwd, 'config.json'));

			const conf = new Conf<Record<string, unknown>>({cwd});
			conf.set('a', 1);

			for (const link of ['config.json', 'first.json', 'second.json']) {
				assert.ok(fs.lstatSync(path.join(cwd, link)).isSymbolicLink(), `${link} is still a link`);
			}

			assert.deepEqual(readConfigFile(path.join(cwd, file)), {...before, a: 1}, 'the file at the end of the chain holds the store');
			assert.strictEqual(conf.get('a'), 1);
		});
	}

	it('follows a link put in place after the store was built', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd});
		conf.set('a', 1);

		const target = path.join(cwd, 'elsewhere.json');
		fs.writeFileSync(target, JSON.stringify({b: 2}));
		fs.renameSync(conf.path, path.join(cwd, 'backup.json'));
		fs.symlinkSync(target, conf.path);

		// The store reads and writes where the link points, which is where it has been reading and writing all along.
		assert.strictEqual(conf.get('a'), undefined, 'a key the target does not hold');
		assert.strictEqual(conf.get('b'), 2, 'a key the target holds');
		conf.set('c', 3);
		assert.deepStrictEqual(readConfigFile(target), {b: 2, c: 3});
		assert.deepStrictEqual(readConfigFile(path.join(cwd, 'backup.json')), {a: 1});
	});

	// A read and the in-place write both follow the link, so the atomic write does too. Renaming over the link itself would leave the config the caller pointed at as a file of its own that nothing else reads, and the data the other reader of the target still holds would be the only copy left of it.
	for (const [name, resolves] of [
		['a link that points nowhere', false],
		['a link that resolves', true],
	] as Array<[string, boolean]>) {
		it(`keeps and follows ${name}`, () => {
			const base = createTempDirectory();
			const cwd = path.join(base, 'cwd');
			fs.mkdirSync(cwd);
			const target = path.join(base, 'shared.json');
			if (resolves) {
				fs.writeFileSync(target, JSON.stringify({kept: true}));
			}

			fs.symlinkSync(target, path.join(cwd, 'config.json'));
			const conf = new Conf<Record<string, unknown>>({cwd});
			conf.set('a', 1);

			assert.ok(fs.lstatSync(conf.path).isSymbolicLink(), 'the link is still a link');
			assert.deepStrictEqual(readConfigFile(target), resolves ? {kept: true, a: 1} : {a: 1}, 'the target holds the store');
			assert.strictEqual(conf.get('a'), 1, 'the store reads back');
		});
	}
});

describe('a config file that is written in place', () => {
	// The inode of the file says which write ran: a write in place keeps the file, and the atomic write renames a new file over it. Windows has no inode `fs.stat` reports, so it cannot tell the two apart.
	it('is written in place under Snap, and atomically otherwise', {skip: process.platform === 'win32' ? 'no inode to compare' : false}, () => {
		for (const [snap, keepsTheFile] of [[true, true], [false, false]] as Array<[boolean, boolean]>) {
			withSnap(snap, () => {
				const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
				conf.set('a', 1);
				const before = fs.statSync(conf.path).ino;

				conf.set('a', 2);

				assert.strictEqual(fs.statSync(conf.path).ino === before, keepsTheFile, `the file keeps its inode with SNAP ${snap ? 'set' : 'unset'}`);
				assert.deepStrictEqual(readConfigFile(conf), {a: 2});
			});
		}
	});

	// The Snap workaround and the `EXDEV` fallback write the file itself where the atomic write renames a temporary file over it, so the directory the file goes in is one this write has to make itself. A link at the config path points at a directory that is not there yet, and the atomic write makes the one the link points at, so this one has to as well or the two do not agree on where a store with such a link can be written.
	for (const [name, snap] of [
		['written in place', true],
		['written atomically', false],
	] as Array<[string, boolean]>) {
		it(`makes the directory a link at the config path points at, ${name}`, () => {
			withSnap(snap, () => {
				const cwd = createTempDirectory();
				fs.symlinkSync(path.join('gone', 'config.json'), path.join(cwd, 'config.json'));

				const conf = new Conf<Record<string, unknown>>({cwd});
				conf.set('a', 1);

				assert.ok(fs.lstatSync(path.join(cwd, 'config.json')).isSymbolicLink(), 'the link is still a link');
				assert.deepEqual(readConfigFile(path.join(cwd, 'gone', 'config.json')), {a: 1}, 'the file where the link points holds the store');
				assert.strictEqual(conf.get('a'), 1);
			});
		});
	}

	// A store that is not behind a link is written in the directory the path is in either way, which the store makes for itself.
	it('makes the directory the config path is in', () => {
		withSnap(true, () => {
			const base = createTempDirectory();
			const cwd = path.join(base, 'not', 'there', 'yet');

			const conf = new Conf<Record<string, unknown>>({cwd});
			conf.set('a', 1);

			assert.deepEqual(readConfigFile(conf.path), {a: 1});
			assert.strictEqual(conf.get('a'), 1);
		});
	});
});

describe('a key written below a value that writes itself', () => {
	it('leaves a `defaults` path below a value that writes itself to the value the store holds', () => {
		const cwd = createTempDirectory();
		writeConfigFile(cwd, JSON.stringify({when: new Date(0)}));

		const conf = new Conf<Record<string, any>>({cwd, defaults: {'when.minute': 1}, ...dateReviving});

		assert.deepStrictEqual(conf.get('when'), new Date(0));
		assert.strictEqual(conf.has('when.minute'), false);
	});

	it('refuses a `set()` of a key below a `Date` instead of losing it', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({cwd, ...dateReviving});
		conf.set('when', new Date(0));
		assert.ok(conf.get('when') instanceof Date, 'the store holds a `Date`');

		assert.throws(() => {
			conf.set('when.minute', 1);
		}, {name: 'TypeError', message: /The key `when\.minute` cannot be set/});

		assert.deepStrictEqual(conf.get('when'), new Date(0), 'the `Date` is left as it was');
		assert.strictEqual(fs.readFileSync(conf.path, 'utf8').includes('minute'), false, 'nothing was written');
	});

	it('refuses a `set()` of a key below a value that writes itself in an array', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({cwd, ...dateReviving});
		conf.set('list', [new Date(0)]);
		assert.ok(conf.get('list.0') instanceof Date, 'the store holds a `Date` in an array');

		assert.throws(() => {
			conf.set('list.0.minute', 1);
		}, {name: 'TypeError', message: /The key `list\.0\.minute` cannot be set/});

		assert.deepStrictEqual(conf.get('list'), [new Date(0)], 'the array is left as it was');
	});

	it('refuses an `appendToArray()` below a value that writes itself instead of losing it', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({cwd, ...dateReviving});
		conf.set('when', new Date(0));

		assert.throws(() => {
			conf.appendToArray('when.list', 'first');
		}, {name: 'TypeError', message: /The key `when\.list` cannot be set/});

		assert.deepStrictEqual(conf.get('when'), new Date(0), 'the `Date` is left as it was');
	});
});

describe('a store written whole out of a value that writes itself', () => {
	/**
	A value that writes itself as an object out of a property of its own, which a copy carries and which is the ordinary way such a class is written.
	*/
	class Settings {
		theme = 'dark';

		toJSON(): Record<string, unknown> {
			return {theme: this.theme, written: true};
		}
	}

	it('is written as what its `toJSON` answered with, with the `defaults` and the bookkeeping kept', () => {
		// What the value writes is taken as the store, so the `defaults` option is filled into it and the bookkeeping of a migration is kept, the way they are for a plain object.
		for (const [name, options, expected] of [
			['a `schema`', {schema: {}}, {}],
			['a `rootSchema`', {rootSchema: {}}, {}],
			['an `ajvOptions`', {ajvOptions: {}}, {}],
			['a `defaults`', {defaults: {unrelated: 1}}, {unrelated: 1}],
			['the bookkeeping of a migration', {projectVersion: '1.0.0', migrations: {}}, {__internal__: {migrations: {version: '1.0.0'}}}],
		] as Array<[string, Record<string, unknown>, Record<string, unknown>]>) {
			const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), ...options});

			conf.store = new Settings() as unknown as Record<string, unknown>;

			assert.deepStrictEqual(readConfigFile(conf.path), {theme: 'dark', written: true, ...expected}, name);
		}
	});

	it('leaves the value the caller gave unaltered, so a schema cannot write into it', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), schema: {other: {type: 'number', default: 1}}});
		const given = new Settings() as unknown as Record<string, unknown>;

		conf.store = given;

		// The validator writes into a copy, so the `other` its `default` gives is not written into the value the caller gave.
		assert.ok(given instanceof Settings, 'the value the caller gave is the value it was');
		assert.deepStrictEqual(Object.keys(given), ['theme'], 'nothing was written into the value the caller gave');
	});

	// What the value writes is taken before anything copies it, so a `toJSON` that needs a private field is asked while the value still has it.
	it('can be written whole where its `toJSON` needs a private field', () => {
		class PrivateSettings {
			readonly #theme: string;

			constructor(theme: string) {
				this.#theme = theme;
			}

			toJSON(): Record<string, string> {
				return {theme: this.#theme};
			}
		}

		for (const options of [{}, {schema: {other: {type: 'number'}}}, {defaults: {other: 1}}]) {
			const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), ...options});
			conf.store = new PrivateSettings('dark') as unknown as Record<string, unknown>;
			assert.strictEqual(conf.get('theme'), 'dark');
		}
	});
});

describe('a value that holds itself', () => {
	/**
	A value whose object graph comes back to itself, which JSON refuses with an error naming neither the key nor what to do about it.
	*/
	const cyclic = (): Record<string, unknown> => {
		const value: Record<string, unknown> = {name: 'loop'};
		value.self = value;
		return value;
	};

	it('is refused with a message naming the key, wherever it is in the value', () => {
		// A `bigint`, a `symbol` and a function are all refused in this module's own words. A value that holds itself is the last of what JSON cannot write, and it was the one reaching the caller as the serializer's own error.
		for (const [name, value] of [
			['at the key', cyclic()],
			['one level down', {inner: cyclic()}],
			['inside an array', {items: [cyclic()]}],
			['three levels down', {a: {b: {c: cyclic()}}}],
		] as Array<[string, unknown]>) {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});

			assert.throws(
				() => {
					conf.set('a', value as Record<string, unknown>);
				},
				{name: 'TypeError', message: /for key `a`.*holds itself.*refuses one as a circular structure/},
				name,
			);
		}
	});

	it('names the path of the edge that closes the loop, which is where a reader starts', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});

		// The path named is where the walk comes back to a value it is already inside, which is the edge that closes the loop and so where a reader of the store starts looking.
		assert.throws(() => {
			conf.set('a', {one: {two: cyclic()}});
		}, {message: /at `one\.two\.self`/});

		assert.throws(() => {
			conf.set('a', {first: cyclic(), second: {nested: cyclic()}});
		}, {message: /at `first\.self`/});
	});

	it('is refused for a `defaults` value too, which the constructor reads', () => {
		assert.throws(
			() => new Conf({cwd: createTempDirectory(), defaults: {a: cyclic()}}),
			{name: 'TypeError', message: /holds itself/},
		);
	});

	it('leaves a value that appears twice without holding itself, which JSON writes', () => {
		// The same object under two keys is not a cycle, and refusing it would refuse a value JSON holds fine.
		const shared = {x: 1};
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});

		conf.set('a', {p: shared, q: shared});
		conf.set('b', {p: shared, q: shared});

		assert.deepStrictEqual({...conf.get('a')}, {p: {x: 1}, q: {x: 1}});
		assert.deepStrictEqual({...conf.get('b')}, {p: {x: 1}, q: {x: 1}});
	});

	it('leaves a value that holds the same object at two depths without a path between them', () => {
		const shared = {x: 1};
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});

		// The same object twice in a row, and a value that refers to a sibling of its own parent.
		conf.set('a', [shared, shared]);
		conf.set('b', {p: {q: shared}, r: shared});

		assert.deepStrictEqual(conf.get('a'), [{x: 1}, {x: 1}]);
		assert.deepStrictEqual({...conf.get('b')}, {p: {q: {x: 1}}, r: {x: 1}});
	});
});

describe('a getter in a value that is written', () => {
	// A getter is read by each walk that looks for a value JSON cannot write, so a getter that answers differently each time is a value the file holds that the caller never passed. The value is walked once to ask whether it is one the store can hold and once more to write it, and a walk that asks is a read of every getter in it. What the file holds is therefore the answer the last read gave, which is the same for a getter that answers the same each time and is not for one that does not.
	//
	// A write the validator had a say in walks the value once more, since the value the validator was given is the one that is written, so only a walk after the validator says whether the validator made it one the file has no form of. A whole-store write is not walked a third time, since `checkWrittenValueTypes()` asks about every value in the store it was given rather than about the one a key names.
	it('reads a getter no more than twice for a write, and no more than three where a validator had a say in it', () => {
		for (const [name, options, write, bound] of [
			['set', {}, (conf: Conf<Record<string, any>>, value: unknown) => {
				conf.set('v', value);
			}, 2],
			['set, a validator in hand', {schema: {other: {type: 'number'}}}, (conf: Conf<Record<string, any>>, value: unknown) => {
				conf.set('v', value);
			}, 3],
			['appendToArray', {}, (conf: Conf<Record<string, any>>, value: unknown) => {
				conf.set('list', []);
				conf.appendToArray('list', value);
			}, 2],
			['appendToArray, a validator in hand', {schema: {other: {type: 'number'}}}, (conf: Conf<Record<string, any>>, value: unknown) => {
				conf.set('list', []);
				conf.appendToArray('list', value);
			}, 3],
			['a whole-store write', {}, (conf: Conf<Record<string, any>>, value: unknown) => {
				conf.store = {v: value};
			}, 2],
			['a whole-store write, a validator in hand', {schema: {other: {type: 'number'}}}, (conf: Conf<Record<string, any>>, value: unknown) => {
				conf.store = {v: value};
			}, 2],
		] as Array<[string, Record<string, unknown>, (conf: Conf<Record<string, any>>, value: unknown) => void, number]>) {
			let calls = 0;
			const value = {
				get n() {
					calls++;
					return calls;
				},
			};

			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), ...options});
			write(conf, value);

			assert.ok(calls <= bound, `the getter is read at most ${String(bound)} time(s) for a ${name}, it was read ${String(calls)} times`);
		}
	});

	it('writes a getter that answers the same each time as the value the caller gave', () => {
		// A getter that answers the same each time is read as many times as the walks run and is the same value every time, so what the file holds is the value the caller handed over.
		for (const [name, write, expected] of [
			['set', (conf: Conf<Record<string, any>>, value: unknown) => {
				conf.set('v', value);
			}, {v: {n: 'the same'}}],
			['appendToArray', (conf: Conf<Record<string, any>>, value: unknown) => {
				conf.set('list', []);
				conf.appendToArray('list', value);
			}, {list: [{n: 'the same'}]}],
			['a whole-store write', (conf: Conf<Record<string, any>>, value: unknown) => {
				conf.store = {v: value};
			}, {v: {n: 'the same'}}],
		] as Array<[string, (conf: Conf<Record<string, any>>, value: unknown) => void, Record<string, unknown>]>) {
			const value = {
				get n() {
					return 'the same';
				},
			};
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
			write(conf, value);

			assert.deepStrictEqual(
				readConfigFile(conf.path),
				expected,
				`the file holds the value handed over for a ${name}`,
			);
		}
	});
});

describe('a value nested deep', () => {
	// The walk that finds these edges is a recursion over the value, one level of it per level of nesting, and a value nested a few thousand levels deep takes the stack past what it has. The caller is told the value is one the store cannot hold, the same as any other value it refuses, rather than the recursion running out.
	it('refuses a value nested too deep for the walk, instead of running the stack out', () => {
		const build = (depth: number): Record<string, unknown> => {
			const root: Record<string, unknown> = {leaf: true};
			let current = root;
			for (let index = 0; index < depth; index++) {
				const next: Record<string, unknown> = {level: index};
				current.nested = next;
				current = next;
			}

			return root;
		};

		for (const depth of [5000, 20_000]) {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
			conf.set('kept', 'the value the store already held');

			assert.throws(
				() => {
					conf.set('a', build(depth));
				},
				{name: 'TypeError', message: /nested/},
				`a value ${depth} levels deep`,
			);

			// A refused write leaves the store as it was, which is what every other refused value here does too.
			assert.strictEqual(conf.get('kept'), 'the value the store already held', `the store after a refusal at ${depth}`);
			assert.strictEqual(conf.get('a'), undefined, `no value written at ${depth}`);
		}
	});

	it('refuses a value nested too deep that a whole-store write is given', () => {
		const build = (depth: number): Record<string, unknown> => {
			const root: Record<string, unknown> = {leaf: true};
			let current = root;
			for (let index = 0; index < depth; index++) {
				const next: Record<string, unknown> = {level: index};
				current.nested = next;
				current = next;
			}

			return root;
		};

		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set('kept', 'the value the store already held');

		assert.throws(
			() => {
				conf.store = {deep: build(20_000)};
			},
			{name: 'TypeError', message: /nested/},
		);

		assert.strictEqual(conf.get('kept'), 'the value the store already held');
	});

	it('refuses a value nested too deep that a `defaults` value is', () => {
		const build = (depth: number): Record<string, unknown> => {
			const root: Record<string, unknown> = {leaf: true};
			let current = root;
			for (let index = 0; index < depth; index++) {
				const next: Record<string, unknown> = {level: index};
				current.nested = next;
				current = next;
			}

			return root;
		};

		assert.throws(
			() => new Conf({cwd: createTempDirectory(), defaults: {a: build(20_000)}}),
			{name: 'TypeError', message: /nested/},
		);
	});

	// A `defaults` key names a path, and the containers that path needs are made before the value at the end of it is looked at, so a key naming a very long path is a value nested as deep as the path is. The copy the constructor takes of it is a walk of its own, and one deep enough took the stack out before this module could say anything about the value.
	it('refuses a `defaults` key naming a path too deep for the copies taken of it', () => {
		for (const depth of [5000, 20_000]) {
			const key = Array.from({length: depth}, (_, index) => `k${index}`).join('.');
			const cwd = createTempDirectory();

			assert.throws(
				() => new Conf({cwd, defaults: {[key]: 1}}),
				{name: 'TypeError', message: /nested more than/},
				`a defaults key ${depth} parts`,
			);

			fs.rmSync(cwd, {recursive: true, force: true});
		}
	});

	// A key naming a path is a key a caller can write, and the value at the end of it is what the walk looks through, so the length of the key is not what counts against the value. The containers the path needs are real nesting in the store, so a path within what the walk holds reads back what the option gave.
	it('leaves a `defaults` key naming a long path where the value at the end is shallow', () => {
		for (const depth of [100, 1000]) {
			const key = Array.from({length: depth}, (_, index) => `k${index}`).join('.');
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, any>>({cwd, defaults: {[key]: 1}});

			conf.set('kept', 1);
			assert.strictEqual(conf.get(key), 1, `a defaults key ${depth} parts reads back the value the option gave`);

			fs.rmSync(cwd, {recursive: true, force: true});
		}
	});

	it('leaves a value nested as deep as any file holds', () => {
		// The depth the walk gives up at is far past anything a config file holds, so a value a reader could write by hand is written rather than refused.
		const build = (depth: number): Record<string, unknown> => {
			const root: Record<string, unknown> = {level: depth};
			let current = root;
			for (let index = 0; index < depth; index++) {
				const next: Record<string, unknown> = {level: index};
				current.nested = next;
				current = next;
			}

			return root;
		};

		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set('a', build(200));

		// The store is typed as `any` so that a value of any shape can be written to it, so the value is read as the shape this test built rather than as whatever the store's type says.
		const {a: value} = conf.store;
		let walked: Record<string, unknown> = value as Record<string, unknown>;
		const top = walked.level;
		let levels = 0;
		while (walked.nested !== undefined) {
			walked = walked.nested as Record<string, unknown>;
			levels++;
		}

		assert.strictEqual(top, 200, 'the top of the value is what the value holds');
		assert.strictEqual(levels, 200, 'every level below it is still there');
	});
});

describe('a config file a text editor wrote', () => {
	it('reads a config file that a text editor gave a byte order mark', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), `\uFEFF${JSON.stringify({foo: 'bar'})}`);

		// A byte order mark is not part of the JSON, so `JSON.parse` refuses it. The store skips it, so a file a text editor saved that way is read as the store it holds, and `clearInvalidConfig` does not take it for a damaged one.
		assert.strictEqual(new Conf({cwd}).get('foo'), 'bar');
		assert.strictEqual(new Conf({cwd, clearInvalidConfig: true}).get('foo'), 'bar');
	});
});
