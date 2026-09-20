/* eslint-disable @typescript-eslint/naming-convention, no-new -- The keys here are the ones a config file was written with, including `toJSON`, and a store is often built only for what it reads. */
import fs from 'node:fs';
import path from 'node:path';
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
} from './_utilities.js';

const fixture = '🦄';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a config file the store cannot read after clearing it', () => {
	// A `serialize` with no `deserialize` to read it back, which is what a store whose own writes it cannot read looks like.
	const serialize = (value: Record<string, number>): string => `a=${value.a ?? 0}`;

	it('reports the file instead of clearing it over and over', () => {
		const cwd = createTempDirectory();
		new Conf({cwd, serialize}).set('a', 1);

		// `clearInvalidConfig` writes the cleared store over the file and reads it back for what it holds now, and the read finds what the write left there, so it clears again, and again.
		assert.throws(() => {
			new Conf({cwd, serialize, clearInvalidConfig: true});
		}, {name: 'SyntaxError', message: /is not valid JSON/});

		assert.strictEqual(fs.readFileSync(path.join(cwd, 'config.json'), 'utf8'), 'a=0', 'the file was cleared once');
	});

	it('is not cleared again by the read a change listener makes while the clearing is in hand', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		let writes = 0;
		const countWrites = (value: Record<string, number>): string => {
			writes++;
			return `a=${value.a ?? 0}`;
		};

		// The store is built on a file that is not there, so the build has no clearing to make, and a listener is there for the one a later call triggers.
		const conf = new Conf({cwd, serialize: countWrites, clearInvalidConfig: true});
		conf.set('a', 1);

		// A listener reads the store to see what the change is, which is what the clearing dispatches a change for.
		const read: unknown[] = [];
		conf.onDidAnyChange(() => {
			read.push(conf.store);
		});

		writes = 0;
		// Damaged after the store is built, so the clearing is the one this call triggers rather than the one the build did.
		fs.writeFileSync(configPath, 'a=2');

		assert.throws(() => {
			conf.get('a');
		}, {name: 'SyntaxError', message: /is not valid JSON/});

		assert.strictEqual(writes, 1, 'the file was written once, not once for the read each listener makes');
		assert.deepStrictEqual(read, [], 'the change the clearing dispatched is reported to nobody, since the read it needs is the one the file cannot answer');
		assert.strictEqual(fs.readFileSync(configPath, 'utf8'), 'a=0', 'the file was cleared to the store the defaults make');
	});

	it('is not cleared again by a read a `serialize` makes while the clearing is in hand', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		let writes = 0;
		const read: unknown[] = [];

		// The `serialize` is given the store while the store is still being built, so the read it makes goes through a holder the store is put in once there is one.
		const built: {conf?: Conf<Record<string, number>>} = {};

		// A `serialize` that reads the store it is writing, which is a read made while the clearing that called it is in hand, the same as the read a change listener makes.
		const conf = new Conf<Record<string, number>>({
			cwd,
			clearInvalidConfig: true,
			serialize(value) {
				writes++;
				// The read is what runs the stack out, so it is held rather than reported, and the write count below is what says how many times it was reached.
				read.push(built.conf?.store);
				return `a=${value.a ?? 0}`;
			},
		});

		built.conf = conf;

		// Damaged after the store is built, so the clearing is the one this call triggers rather than the one the build did.
		fs.writeFileSync(configPath, 'a=2');

		assert.throws(() => {
			conf.get('a');
		}, {name: 'SyntaxError', message: /is not valid JSON/});

		assert.strictEqual(writes, 1, 'the file was written once, not once for the read the `serialize` makes');
		assert.deepStrictEqual(read, [], 'the read reports nothing, since the file it asks about is the one the write is clearing');
	});
});

describe('an error a `deserialize` of your own throws', () => {
	it('is reported as yours, and the file is left as it is, even where the message is the one of a decryption failure', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		fs.writeFileSync(configPath, JSON.stringify({a: 1}));

		// The message is the one this module writes for a file it could not decrypt, which is not a file this store is looking at.
		assert.throws(() => {
			new Conf({
				cwd,
				clearInvalidConfig: true,
				deserialize() {
					throw new Error('Failed to decrypt config data.');
				},
			});
		}, {name: 'Error', message: 'Failed to decrypt config data.'});

		assert.strictEqual(fs.readFileSync(configPath, 'utf8'), JSON.stringify({a: 1}), 'the file was left as it is');
	});

	// The other of the two: the error is this module's own, so a `deserialize` of the caller being there does not stop a file no key reads from being cleared the way a damaged one is.
	it('still clears a file no key reads, whatever `deserialize` you gave', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), 'a file no key reads');

		const config = new Conf<Record<string, unknown>>({
			cwd,
			encryptionKey: 'k',
			encryptionAlgorithm: 'aes-256-gcm',
			clearInvalidConfig: true,
			deserialize: text => JSON.parse(text) as Record<string, unknown>,
		});

		assert.deepStrictEqual(config.store, createNullProtoObject({}));
		assert.strictEqual(fs.readFileSync(config.path, 'utf8').includes('no key reads'), false, 'the file was cleared');
	});
});

describe('a value a `serialize` and a `deserialize` of your own write and read', () => {
	const json = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

	// The forms a `serialize` can be given that lose nothing, since a form that does is a form the caller asked for.
	const forms = [
		['the default', undefined, undefined],
		['JSON with options', (value: unknown) => JSON.stringify(value, undefined, 2), json],
		['compact JSON', (value: unknown) => JSON.stringify(value), json],
		['bytes', (value: unknown) => new TextEncoder().encode(JSON.stringify(value)), json],
		['a store of its own', (value: unknown) => JSON.stringify(value), (text: string) => createNullProtoObject(json(text))],
	] as Array<[string, ((value: unknown) => string | Uint8Array) | undefined, ((text: string) => Record<string, unknown>) | undefined]>;

	const values = [
		['text', 'hello'],
		['an empty string', ''],
		['zero', 0],
		['false', false],
		['null', null],
		['a number with a fraction', 3.5],
		['an array', [1, 'two', null, false]],
		['a nested object', {a: {b: ['c', {d: 1}]}}],
		['a key with a dot in it', {'a.b': 1}],
		['a key that spells a member of `Object.prototype`', {toString: 'not the one on the prototype'}],
		['unicode', {'🦄': 'мир 🌍'}],
		['control characters and escapes', 'before\u0000\u001F"\'`\\\n\t\r\\ after'],
		['a long string', 'x'.repeat(50_000)],
		['an empty object', {}],
	] as Array<[string, unknown]>;

	it('comes back the way it was set, through every form', () => {
		for (const [formName, serialize, deserialize] of forms) {
			for (const [valueName, value] of values) {
				const cwd = createTempDirectory();
				const options = {cwd, serialize: serialize as never, deserialize: deserialize as never};

				// A second store, so the value is read back out of the file rather than out of the store that set it.
				new Conf<Record<string, unknown>>(options).set('key', value);
				assert.deepStrictEqual(new Conf<Record<string, unknown>>(options).get('key'), value, `${formName}: ${valueName}`);
			}
		}
	});

	it('gives a `deserialize` text, whatever the `serialize` answered with', () => {
		// The bytes of a file are decoded as text before a `deserialize` sees them, so a format that is not UTF-8 has to be read by a pair that both use text.
		const given: unknown[] = [];
		const options = {
			serialize: (value: unknown) => new TextEncoder().encode(JSON.stringify(value)),
			deserialize(text: string) {
				given.push(text);
				return json(text);
			},
		};

		const cwd = createTempDirectory();
		const config = new Conf<Record<string, unknown>>({cwd, ...options});
		config.set('key', 'value');
		assert.strictEqual(config.get('key'), 'value');

		assert.deepStrictEqual(given, ['{"key":"value"}'], 'the deserialize was given the text of the file');
	});

	it('asks a `serialize` once for a write, wherever the write came from', () => {
		let asked = 0;
		const config = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			defaults: {a: 'A'},
			serialize(value) {
				asked++;
				return JSON.stringify(value);
			},
		});

		const writes = [
			['a `set()`', () => {
				config.set('b', 1);
			}],
			['a `delete()`', () => {
				config.delete('b');
			}],
			['an `appendToArray()`', () => {
				config.appendToArray('list', 'x');
			}],
			['the `store` setter', () => {
				config.store = {a: 'A'};
			}],
			['a `reset()`', () => {
				config.reset('a');
			}],
			['a `clear()`', () => {
				config.clear();
			}],
		] as Array<[string, () => void]>;

		for (const [name, write] of writes) {
			asked = 0;
			write();
			assert.strictEqual(asked, 1, name);
		}
	});

	it('reads back what it wrote where a `serialize` writes keys of its own', () => {
		// A `serialize` that writes keys of its own is how a format the store does not use underneath is written, so the store is asked about the keys it holds and not the ones the file happens to have.
		const readAlpha: (text: string) => Record<string, unknown> = text => ({a: json(text).alpha});
		const cwd = createTempDirectory();
		const options = {
			cwd,
			serialize: (value: Record<string, unknown>) => JSON.stringify({alpha: value.a}),
			deserialize: readAlpha,
			schema: {a: {type: 'number'}, b: {type: 'string', default: 'B'}, c: {type: 'string'}},
		};
		const config = new Conf<Record<string, any>>(options);

		config.set('a', 1);
		config.set('b', 'mine');
		config.set('c', 'dropped');

		assert.deepStrictEqual(json(fs.readFileSync(config.path, 'utf8')), {alpha: 1}, 'the file holds what the `serialize` wrote of it');
		assert.strictEqual(config.get('a'), 1, 'the store reads back what the `serialize` wrote');
		assert.strictEqual(config.get('b'), 'B', 'a `schema` default is filled in for a key the `serialize` dropped');
		assert.strictEqual(config.get('c'), undefined, 'a key the `serialize` wrote nothing for and the schema gives no default for is not in the store');
	});
});

describe('serialize', () => {
	const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
	const decode = (text: string | Uint8Array): Record<string, unknown> => {
		const json: unknown = JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(text));
		return json as Record<string, unknown>;
	};

	// The readme allows any representation that is compatible with utf8, which a `Uint8Array` is, and the write has to take it the same way with and without a key.
	for (const encryptionAlgorithm of ['aes-256-cbc', 'aes-256-gcm', 'aes-256-ctr'] as const) {
		it(`round-trips a \`Uint8Array\` from \`serialize\` with \`${encryptionAlgorithm}\``, () => {
			const cwd = createTempDirectory();
			const options = {
				cwd,
				serialize: encode as never,
				deserialize: decode as never,
				encryptionKey: 'key',
				encryptionAlgorithm,
			};
			const conf = new Conf<Record<string, unknown>>(options);
			conf.set('foo', 'bar 🦄');
			// The file is the bytes the store was written as and not the text, and a second store reads them back.
			assert.notStrictEqual(fs.readFileSync(conf.path, 'utf8'), JSON.stringify({foo: 'bar 🦄'}));
			assert.deepStrictEqual(new Conf<Record<string, unknown>>(options).get('foo'), 'bar 🦄');
		});
	}

	// A value that is neither text nor bytes leaves the file with something no store can be read from, so it is refused before the file is touched.
	for (const [name, serialize] of [
		['undefined', () => undefined],
		['null', () => null],
		['a number', () => 42],
		['an object', () => ({})],
		['a `DataView`', () => new DataView(new ArrayBuffer(4))],
	] as Array<[string, () => unknown]>) {
		it(`refuses a \`serialize\` that answers with ${name}, and leaves the file as it is`, () => {
			const cwd = createTempDirectory();
			const seed = new Conf({cwd});
			seed.set('foo', 'bar');
			const before = fs.readFileSync(seed.path);

			const config = new Conf({cwd, serialize: serialize as never});
			assert.throws(() => {
				config.set('foo', 'changed');
			}, {
				name: 'TypeError',
				message: /The `serialize` option must return a string or a `Uint8Array`/,
			});
			assert.deepStrictEqual(fs.readFileSync(seed.path), before);
			assert.strictEqual(seed.get('foo'), 'bar');
		});
	}

	it('refuses a `serialize` that answers with neither text nor bytes under a key too', () => {
		const cwd = createTempDirectory();
		const options = {cwd, encryptionKey: 'key', encryptionAlgorithm: 'aes-256-gcm'} as const;
		const conf = new Conf(options);
		conf.set('foo', 'bar');
		const before = fs.readFileSync(conf.path);

		const bad = new Conf({...options, serialize: (() => 42) as never});
		assert.throws(() => {
			bad.set('foo', 'changed');
		}, {name: 'TypeError', message: /The `serialize` option must return a string or a `Uint8Array`/});
		assert.deepStrictEqual(fs.readFileSync(conf.path), before);
		assert.strictEqual(conf.get('foo'), 'bar');
	});

	it('takes what a `toJSON` writes as it is under a `serialize` of the caller', () => {
		// A `serialize` of the caller answers in its own format, so the store is not asked whether what a value writes is a store.
		const cwd = createTempDirectory();
		const options = {
			cwd,
			serialize: ((value: unknown) => `store:${JSON.stringify(value)}`) as never,
			deserialize: ((text: string) => JSON.parse(text.slice('store:'.length)) as Record<string, unknown>) as never,
		};
		const conf = new Conf<Record<string, unknown>>(options);
		conf.store = {when: new Date(0)};
		assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), 'store:{"when":"1970-01-01T00:00:00.000Z"}');
		assert.deepStrictEqual({...new Conf<Record<string, unknown>>(options).store}, {when: '1970-01-01T00:00:00.000Z'});
	});

	it('round-trips a `Buffer` from `serialize`', () => {
		const cwd = createTempDirectory();
		const options = {
			cwd,
			serialize: ((value: unknown) => Buffer.from(JSON.stringify(value))) as never,
			deserialize: ((text: string | Uint8Array) => {
				const json: unknown = JSON.parse(Buffer.from(text).toString());
				return json as Record<string, unknown>;
			}) as never,
		};
		const conf = new Conf<Record<string, unknown>>(options);
		conf.set('foo', 'bar');
		assert.strictEqual(new Conf<Record<string, unknown>>(options).get('foo'), 'bar');
	});

	it('round-trips a `Uint8Array` from `serialize` without a key', () => {
		const cwd = createTempDirectory();
		const options = {
			cwd,
			serialize: encode as never,
			deserialize: decode as never,
		};
		const conf = new Conf<Record<string, unknown>>(options);
		conf.set('foo', 'bar');
		assert.deepStrictEqual(new Conf<Record<string, unknown>>(options).get('foo'), 'bar');
	});
});

describe('a `toJSON` a `deserialize` hands back with the store', () => {
	// The store the module builds is a plain object of its own, and a `toJSON` the value the deserializer returned carries is not the store's own. `JSON.stringify` writes the whole store as whatever it answers with, so every write after the one that read it holds nothing, and the value a caller set is in no file.
	it('leaves it out of the store, so a later write keeps what the store holds', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({
			cwd,
			deserialize: text => ({...JSON.parse(text) as Record<string, unknown>, toJSON: () => 'not a store'}),
		});

		conf.set('a', 1);
		conf.set('b', 2);
		assert.deepStrictEqual(readConfigFile(conf), {a: 1, b: 2});
		assert.deepStrictEqual({...conf.store}, {a: 1, b: 2});
	});

	// A `toJSON` that is not a function is a key of the store the caller put there, and `JSON.stringify` writes it as itself, so it is left alone.
	it('keeps a `toJSON` of the caller that is not a function', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({toJSON: 'data'}));

		const conf = new Conf<Record<string, any>>({
			cwd,
			deserialize: text => JSON.parse(text) as Record<string, unknown>,
		});
		assert.strictEqual(conf.get('toJSON'), 'data');
		conf.set('a', 1);
		assert.deepStrictEqual(readConfigFile(conf), {toJSON: 'data', a: 1});
	});
});

describe('the `serialize` and `deserialize` options', () => {
	it('`serialize` and `deserialize` options', () => {
		const serialized = `foo:${fixture}`;
		const deserialized = {foo: fixture};
		let serializeCallCount = 0;
		let deserializeCallCount = 0;

		const serialize = (value: unknown): string => {
			serializeCallCount++;
			assert.deepStrictEqual(value, deserialized);
			return serialized;
		};

		const deserialize = (value: unknown) => {
			deserializeCallCount++;
			assert.strictEqual(value, serialized);
			return deserialized;
		};

		const conf = new Conf({
			cwd: createTempDirectory(),
			serialize,
			deserialize,
		});

		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		conf.store = deserialized;
		assert.deepStrictEqual(conf.store, createNullProtoObject(deserialized));
		assert.strictEqual(serializeCallCount, 1);
		assert.strictEqual(deserializeCallCount, 1);
	});
});

describe('a `serialize` of your own', () => {
	// A format other than JSON can hold what JSON cannot, so only what no format is given a key for is refused.
	const options = {
		serialize: (value: Record<string, unknown>) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? `${item}n` : (typeof item === 'number' && !Number.isFinite(item) ? String(item) : item)),
		deserialize: (text: string) => JSON.parse(text, (_key, item: unknown) => typeof item === 'string' && /^\d+n$/.test(item) ? BigInt(item.slice(0, -1)) : (item === 'Infinity' ? Number.POSITIVE_INFINITY : item)) as Record<string, unknown>,
	};

	it('writes a `bigint` and a number JSON has no form of', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), ...options});
		conf.set('count', 10n);
		conf.set('limit', Number.POSITIVE_INFINITY);

		assert.equal(conf.get('count'), 10n);
		assert.equal(conf.get('limit'), Number.POSITIVE_INFINITY);
	});

	it('takes a default JSON has no form of', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), ...options, defaults: {limit: Number.POSITIVE_INFINITY}});
		assert.equal(conf.get('limit'), Number.POSITIVE_INFINITY);
	});

	it('still refuses a function', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), ...options});
		assert.throws(() => {
			conf.set('callback', () => 1);
		}, {name: 'TypeError', message: /`function`/});
	});
});
