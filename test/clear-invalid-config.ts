/* eslint-disable no-new, @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-call -- A store is often built only for what it does to the file, the keys here are the ones a caller writes, and a value read back is `any`. */
import fs from 'node:fs';
import path from 'node:path';
import {Buffer} from 'node:buffer';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	trackConf,
	runRegisteredCleanups,
	resetTrackedConfs,
	createNullProtoObject,
	skipWatching,
	nextChange,
	untilQuiet,
	readConfigFile,
	untilWatching,
	getMigrationVersion,
	createExistingConfig,
} from './_utilities.js';

const encryptedOptions = (cwd: string) => ({cwd, encryptionKey: 'key', encryptionAlgorithm: 'aes-256-gcm' as const});

type Store = Record<string, any>;

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a construction that cannot clear the config it migrated', () => {
	// A store the schema cannot accept once cleared is no store to write, so the file is left as it was found. The migrations had already written to it, so without putting it back a construction that fails left behind a file the same construction without migrations never creates.
	const migrated = {
		projectVersion: '1.0.0',
		migrations: {
			'1.0.0'(store: any) {
				store.set('migrated', true);
			},
		},
	};

	for (const [name, options] of [
		['with migrations', migrated],
		['without migrations', {}],
	] as Array<[string, Record<string, unknown>]>) {
		it(`leaves no file behind, ${name}`, () => {
			const cwd = createTempDirectory();
			assert.throws(() => new Conf<Record<string, any>>({
				cwd,
				clearInvalidConfig: true,
				schema: {a: {type: 'string'}},
				rootSchema: {required: ['a']},
				...options,
			}), {message: 'Config schema violation: `` must have required property \'a\''});
			assert.strictEqual(fs.existsSync(path.join(cwd, 'config.json')), false, `the file after a construction ${name}`);
		});
	}

	it('still clears a config the schema can accept once cleared', () => {
		const cwd = createTempDirectory();
		// A store the schema rejects, so there is a config to clear.
		createExistingConfig(cwd, {a: 1});
		const conf = new Conf<Record<string, any>>({
			cwd,
			clearInvalidConfig: true,
			schema: {a: {type: 'string', default: 'x'}},
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store: any) {
					store.set('migrated', true);
				},
			},
		});
		// The file is read first, since a read through the store clears a file the schema rejects by itself, and would hide a construction that did not.
		assert.deepStrictEqual(readConfigFile(conf.path), {
			a: 'x',
			__internal__: {migrations: {version: '1.0.0'}},
		});
		assert.deepStrictEqual({...conf.store}, {a: 'x'});
	});
});

describe('a damaged config file whose bytes carry the encrypted separator', () => {
	// The separator is the one byte of the encrypted format a read can look for, and a store in plain text can have it, so it only counts where the bytes are not text, which is what this module made them when it encrypted a store. A store in plain text is text however a byte of it was lost, so a damaged one is cleared the way `clearInvalidConfig` says it is.
	it('is cleared, since a store in plain text is text', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		const damaged = Buffer.from('{"abcdefghijklm": tru');
		assert.strictEqual(damaged[16], 0x3A, 'the seventeenth byte is the separator the encrypted format puts there');

		fs.writeFileSync(filePath, damaged);
		const conf = new Conf<Record<string, unknown>>({cwd, clearInvalidConfig: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.deepStrictEqual(readConfigFile(filePath), {});

		conf.set('a', 1);
		assert.deepStrictEqual({...conf.store}, {a: 1});
	});

	it('clears an encrypted file that was cut short, whatever bytes it has', () => {
		for (const cutOff of [1, 20, 40]) {
			const cwd = createTempDirectory();
			const writer = new Conf<Record<string, unknown>>({cwd, encryptionKey: 'the-key', encryptionAlgorithm: 'aes-256-gcm'});
			writer.set('secret', 'value');
			const whole = fs.readFileSync(writer.path);
			const length = whole.length - cutOff;
			fs.writeFileSync(writer.path, whole.subarray(0, length));

			const conf = new Conf<Record<string, unknown>>({
				cwd,
				encryptionKey: 'the-key',
				encryptionAlgorithm: 'aes-256-gcm',
				clearInvalidConfig: true,
			});
			assert.deepStrictEqual({...conf.store}, {}, `the store read from ${length} bytes`);
			conf.set('a', 1);
			assert.strictEqual(conf.get('a'), 1, `${length} bytes`);
		}
	});
});

describe('a config file that was damaged', () => {
	// A store written in plain text and then damaged by a lost byte is not a file this module encrypted, whatever its bytes are now, so it is cleared the way a store that cannot be parsed at all is.
	it('is cleared where the damage took a byte out of a character', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		const damaged = Buffer.from(JSON.stringify({greeting: '🦄'}, undefined, '\t'), 'utf8');
		damaged[13] = 0x9F;

		fs.writeFileSync(filePath, damaged);
		const conf = new Conf<Record<string, unknown>>({cwd, clearInvalidConfig: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.deepStrictEqual(readConfigFile(filePath), {});

		conf.set('a', 1);
		assert.deepStrictEqual({...conf.store}, {a: 1});
	});

	it('is cleared where the file is a lone character, which is valid text', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '🦄');

		const conf = new Conf<Record<string, unknown>>({cwd, clearInvalidConfig: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.deepStrictEqual(readConfigFile(conf.path), {});
	});
});

describe('a damaged config file that carries the encrypted separator', () => {
	// The algorithm asked for decides how a file this module encrypted cannot be read, and a file it never encrypted is not one of those however the bytes come out. A damaged file is cleared whichever algorithm is asked for.
	for (const encryptionAlgorithm of ['aes-256-cbc', 'aes-256-gcm', 'aes-256-ctr'] as const) {
		for (const [name, file] of [
			['a file that is not JSON at all', Buffer.from('{corrupt')],
			[
				'a file that is short enough to be no initialization vector',
				Buffer.from('{"abcdefghijklm": tru'),
			],
		] as Array<[string, Uint8Array]>) {
			it(`is cleared with \`${encryptionAlgorithm}\`, where the file holds ${name}`, () => {
				const cwd = createTempDirectory();
				const filePath = path.join(cwd, 'config.json');
				fs.writeFileSync(filePath, file);

				const conf = new Conf<Record<string, unknown>>({
					cwd,
					encryptionKey: 'the-key',
					encryptionAlgorithm,
					clearInvalidConfig: true,
				});
				conf.set('a', 1);
				assert.deepStrictEqual({...conf.store}, {a: 1});
			});
		}
	}
});

describe('a read that clears the config file', () => {
	// Clearing the file is a write of the config, and the file is the config, so it is reported the way a write through the `store` setter is.
	it('reports the change it made to the file', () => {
		for (const [name, options, contents] of [
			['malformed JSON', {}, '{corrupt'],
			['a schema violation', {schema: {a: {type: 'number'}}}, JSON.stringify({a: 'not a number'})],
		] as Array<[string, Record<string, unknown>, string]>) {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, unknown>>({cwd, clearInvalidConfig: true, ...options});

			let events = 0;
			conf.events.addEventListener('change', () => {
				events++;
			});

			// What the store reads as is the same before and after, since a file it could not read is the empty store the file is cleared to, so there is nothing for a value listener to be told about. The file is what changed.
			const anyChanges: unknown[] = [];
			conf.onDidAnyChange(newValue => {
				anyChanges.push({...newValue});
			});

			fs.writeFileSync(conf.path, contents);
			conf.get('a');

			assert.strictEqual(events, 1, `the events reported for ${name}`);
			assert.deepStrictEqual(anyChanges, [], `the value changes reported for ${name}`);
		}
	});

	// A read that clears the file dispatches a change of its own, which reaches this listener while it is in the middle of reporting the change that made the read happen. Reading what this listener last reported before the store would have it report that one change twice.
	it('reports a clear driven by a change it was told about once', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf<Record<string, unknown>>({
			cwd,
			watch: true,
			cache: true,
			clearInvalidConfig: true,
		}));
		conf.set('a', 1);

		const changes: Array<[Record<string, unknown>, Record<string, unknown> | undefined]> = [];
		conf.onDidAnyChange((newValue, oldValue) => {
			changes.push([{...newValue}, oldValue && {...oldValue}]);
		});

		await untilWatching();
		const change = nextChange(conf);
		fs.writeFileSync(conf.path, '{corrupt');
		await change;
		await untilQuiet(() => changes.length);

		assert.deepStrictEqual(changes, [[{}, {a: 1}]]);
	});

	it('reports nothing when there was nothing to clear', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd, clearInvalidConfig: true});

		let events = 0;
		conf.events.addEventListener('change', () => {
			events++;
		});

		conf.get('a');
		conf.set('a', 1);
		conf.get('a');

		assert.strictEqual(events, 1, 'the events reported');
	});
});

describe('clearInvalidConfig', () => {
	it('writes the cleared store over a file with malformed JSON', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		fs.writeFileSync(filePath, '{corrupt');
		const conf = new Conf({cwd, clearInvalidConfig: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.deepStrictEqual(readConfigFile(filePath), {});

		// The file is a store now, so a store opened without the option reads it rather than reporting the corruption again.
		assert.deepStrictEqual(new Conf({cwd}).store, createNullProtoObject({}));
	});

	// A file the key does not decrypt is one the store cannot read, so it is cleared like any other, which is what lets a store whose key changed recover.
	it('clears a file it cannot decrypt', () => {
		const cwd = createTempDirectory();
		const options = {cwd, encryptionKey: 'key', encryptionAlgorithm: 'aes-256-gcm'} as const;
		const conf = new Conf(options);
		conf.set('foo', 'bar');

		const wrongKey = new Conf({...options, encryptionKey: 'other', clearInvalidConfig: true});
		assert.deepStrictEqual(wrongKey.store, createNullProtoObject({}));
		wrongKey.set('foo', 'replaced');
		assert.strictEqual(new Conf({...options, encryptionKey: 'other'}).get('foo'), 'replaced');
	});

	it('clears a file that is cut short of what a decrypt needs', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionKey: 'key', encryptionAlgorithm: 'aes-256-gcm'});
		conf.set('foo', 'bar');
		fs.writeFileSync(conf.path, fs.readFileSync(conf.path).subarray(0, 17));

		const cleared = new Conf({...encryptedOptions(cwd), clearInvalidConfig: true});
		assert.deepStrictEqual(cleared.store, createNullProtoObject({}));
		assert.deepStrictEqual(new Conf(encryptedOptions(cwd)).store, createNullProtoObject({}));
	});

	// A `SyntaxError` says the file is not the format the store reads, whichever `deserialize` throws it.
	it('clears a file a `deserialize` of the caller throws a `SyntaxError` for', () => {
		for (const deserialize of [JSON.parse, (text: string) => JSON.parse(text) as unknown]) {
			const cwd = createTempDirectory();
			const filePath = path.join(cwd, 'config.json');
			fs.writeFileSync(filePath, '{corrupt');

			const conf = new Conf({cwd, clearInvalidConfig: true, deserialize: deserialize as (text: string) => Record<string, unknown>});
			assert.deepStrictEqual({...conf.store}, {});
			assert.deepStrictEqual(readConfigFile(filePath), {});
		}
	});

	// Any other error says the store cannot read the file right now, such as a service the `deserialize` reads from being down, so it is thrown and the file is left alone.
	it('throws an error of another kind a `deserialize` of the caller throws, and leaves the file alone', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		fs.writeFileSync(filePath, 'MYCUSTOMFORMAT');

		assert.throws(() => new Conf({
			cwd,
			clearInvalidConfig: true,
			deserialize() {
				throw new Error('The settings backend is down');
			},
		}), {message: 'The settings backend is down'});
		assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'MYCUSTOMFORMAT');
	});

	it('writes the defaults into the cleared store', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{corrupt');
		const conf = new Conf<{foo: number}>({
			cwd,
			clearInvalidConfig: true,
			defaults: {foo: 1},
		});
		assert.strictEqual(conf.get('foo'), 1);
		assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), {foo: 1});
	});

	it('leaves a file it must not clear alone', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{corrupt');
		assert.throws(() => new Conf({cwd}), {name: 'SyntaxError'});
		assert.strictEqual(fs.readFileSync(path.join(cwd, 'config.json'), 'utf8'), '{corrupt');
	});

	it('clears an encrypted file a key was not given for', () => {
		for (const encryptionAlgorithm of ['aes-256-cbc', 'aes-256-gcm', 'aes-256-ctr'] as const) {
			const cwd = createTempDirectory();
			const conf = new Conf<{foo: string}>({cwd, encryptionKey: 'key', encryptionAlgorithm});
			conf.set('foo', 'bar');

			const noKey = new Conf<{foo: string}>({cwd, clearInvalidConfig: true});
			assert.deepStrictEqual(noKey.store, createNullProtoObject({}), `the store read without the key of an \`${encryptionAlgorithm}\` file`);
			assert.deepStrictEqual(readConfigFile(conf.path), {}, `the file of an \`${encryptionAlgorithm}\` store`);
			noKey.set('foo', 'replaced');
			assert.strictEqual(noKey.get('foo'), 'replaced');
		}
	});

	// `aes-256-cbc` reads a plaintext file, so a key that is set does not mean the file is encrypted, and a plaintext file that got damaged is cleared as one.
	it('clears a malformed plaintext file the `aes-256-cbc` key reads', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		fs.writeFileSync(filePath, '{corrupt');

		const conf = new Conf<{foo: number}>({cwd, encryptionKey: 'key', clearInvalidConfig: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		conf.set('foo', 1);
		assert.deepStrictEqual(new Conf<{foo: number}>({cwd, encryptionKey: 'key'}).store, createNullProtoObject({foo: 1}));
	});

	it('clears a file that holds no store at all', () => {
		for (const contents of ['', '   \n\t']) {
			const cwd = createTempDirectory();
			const filePath = path.join(cwd, 'config.json');
			fs.writeFileSync(filePath, contents);

			const conf = new Conf({cwd, clearInvalidConfig: true});
			assert.deepStrictEqual(conf.store, createNullProtoObject({}), `the store cleared from ${JSON.stringify(contents)}`);
			assert.deepStrictEqual(readConfigFile(filePath), {}, `the file cleared from ${JSON.stringify(contents)}`);
		}
	});
});

describe('clearing a config the schema cannot accept once cleared', () => {
	it('reports the schema and leaves the file as it was', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{corrupt');

		// A required key with no `default` of its own cannot be there once the config is cleared, so there is no store to write and the file is left as it is.
		assert.throws(() => new Conf<Record<string, any>>({
			cwd,
			clearInvalidConfig: true,
			schema: {a: {type: 'string'}},
			rootSchema: {required: ['b']},
		}), {message: 'Config schema violation: `` must have required property \'b\''});
		assert.strictEqual(fs.readFileSync(path.join(cwd, 'config.json'), 'utf8'), '{corrupt');
	});

	it('writes the store the defaults make valid, where the schema can accept one', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{corrupt');

		const conf = new Conf<Record<string, any>>({
			cwd,
			clearInvalidConfig: true,
			schema: {
				a: {type: 'string'},
				b: {type: 'string', default: 'x'},
			},
			rootSchema: {required: ['b']},
		});
		assert.deepStrictEqual({...conf.store}, {b: 'x'});
		assert.deepStrictEqual(readConfigFile(conf.path), {b: 'x'});
	});
});

describe('clearing a config file', () => {
	it('clears a schema violation and applies defaults', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({n: 'bad'}));
		const conf = new Conf({
			cwd, schema: {n: {type: 'number'}}, defaults: {n: 7}, clearInvalidConfig: true,
		});
		assert.strictEqual(conf.get('n'), 7);
	});

	it('clears a file that was changed after it was encrypted with aes-256-gcm', () => {
		const cwd = createTempDirectory();
		const writer = new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'});
		writer.set('a', 1);
		fs.appendFileSync(writer.path, 'tamper');
		const conf = new Conf({
			cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm', clearInvalidConfig: true,
		});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.deepStrictEqual(new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'}).store, createNullProtoObject({}));
	});

	it('without the flag, a decryption failure throws', () => {
		const cwd = createTempDirectory();
		const writer = new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'});
		writer.set('a', 1);
		fs.appendFileSync(writer.path, 'tamper');
		assert.throws(() => {
			new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'});
		}, {message: 'Failed to decrypt config data.'});
	});

	it('clears whitespace-only files', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '   \n');
		const conf = new Conf({cwd, clearInvalidConfig: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
	});
});

describe('clearing a config file with other options', () => {
	it('recovers a corrupt file when migrations are also configured', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{corrupt');
		const conf = new Conf({
			cwd,
			projectVersion: '1.0.0',
			clearInvalidConfig: true,
			migrations: {
				'1.0.0'(store) {
					store.set('migrated', true);
				},
			},
		});
		assert.strictEqual(conf.get('migrated'), true);
	});

	it('clears invalid schema data back to defaults', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({n: 'bad'}));
		const conf = new Conf({
			cwd,
			clearInvalidConfig: true,
			defaults: {n: 3},
			schema: {n: {type: 'number'}},
		});
		assert.strictEqual(conf.get('n'), 3);
	});

	it('keeps a valid file untouched when the flag is on', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({keep: 'me'}));
		const conf = new Conf({cwd, clearInvalidConfig: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({keep: 'me'}));
	});
});

describe('a config file a read could not read', () => {
	it('writes a whole store over a file the `clearInvalidConfig` option clears, where a read of it clears the file', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Store>({
			cwd,
			encryptionKey: 'key',
			encryptionAlgorithm: 'aes-256-gcm',
			clearInvalidConfig: true,
		});

		// A file that is not text a store could read back, which is a file that got damaged rather than one this module wrote in plain text, and a write over it is what the option is for.
		fs.writeFileSync(conf.path, 'not a config file at all');

		assert.doesNotThrow(() => {
			conf.store = {b: 2};
		});
		assert.deepStrictEqual({...conf.store}, {b: 2});

		// The same file is one a read clears, which is what makes it a file the option clears.
		fs.writeFileSync(conf.path, 'not a config file at all');
		assert.deepStrictEqual({...conf.store}, {});
		assert.deepStrictEqual({...new Conf<Store>({cwd, encryptionKey: 'key', encryptionAlgorithm: 'aes-256-gcm'}).store}, {}, 'the file after the read, read without the option');
	});

	// A whole-store write replaces what the file holds, so it writes over a file a read cannot read, while a keyed write reads the file first and reports it.
	it('writes a whole store over a file a read cannot read, where the `clearInvalidConfig` option is not set', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Store>({cwd, encryptionKey: 'key', encryptionAlgorithm: 'aes-256-gcm'});
		fs.writeFileSync(conf.path, JSON.stringify({a: 1}));

		assert.throws(() => {
			conf.set('b', 2);
		}, {message: 'Failed to decrypt config data.'});
		conf.store = {b: 2};
		assert.deepStrictEqual({...conf.store}, {b: 2});
	});

	// A plain text file is not one `aes-256-gcm` decrypts, so adding a key with that algorithm to a store that had none clears it, which is what the option says of a file the store cannot read.
	it('clears a plain text file an `aes-256-gcm` key cannot read', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: 1}));
		const conf = new Conf<Store>({
			cwd,
			encryptionKey: 'key',
			encryptionAlgorithm: 'aes-256-gcm',
			clearInvalidConfig: true,
		});

		assert.deepStrictEqual({...conf.store}, {});
		conf.set('b', 2);
		assert.deepStrictEqual({...conf.store}, {b: 2});
	});
});

describe('a damaged config file the `clearInvalidConfig` option clears', () => {
	it('allows a migration to supply a required field after clearing a corrupt file', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{corrupt');
		let runs = 0;
		const conf = new Conf<{port: number}>({
			cwd,
			clearInvalidConfig: true,
			schema: {port: {type: 'number'}},
			rootSchema: {required: ['port']},
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					runs++;
					store.set('port', 3000);
				},
			},
		});
		assert.strictEqual(runs, 1);
		assert.strictEqual(conf.get('port'), 3000);
		assert.deepStrictEqual(readConfigFile(conf.path), {port: 3000, __internal__: {migrations: {version: '1.0.0'}}});
	});

	it('rejects a cleared store the migrations leave without a required field', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		fs.writeFileSync(configPath, '{corrupt');
		let runs = 0;
		assert.throws(() => new Conf<{port: number}>({
			cwd,
			clearInvalidConfig: true,
			schema: {port: {type: 'number'}},
			rootSchema: {required: ['port']},
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'() {
					runs++;
				},
			},
		}), {message: 'Config schema violation: `` must have required property \'port\''});
		assert.strictEqual(runs, 1);
		assert.strictEqual(fs.readFileSync(configPath, 'utf8'), '{corrupt');
	});

	// A file that cannot be parsed holds no bookkeeping to keep, and the store the option leaves behind is an existing file with no recorded version, which is migrated the way any other one is. The migrations run once over the store that was cleared, which holds what the `defaults` option and the `default`s of the schema give it and nothing of what the file held, and the version the pass reached is recorded as any other one is.
	it('runs the migrations again over the store it cleared, and records the version', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		fs.writeFileSync(configPath, JSON.stringify({__internal__: {migrations: {version: '1.0.0'}}, foo: 'bar'}));

		const runs: string[] = [];
		const migrations = {
			'1.0.0'(store: Conf) {
				runs.push('1.0.0');
				store.set('migrated', true);
			},
		};

		// A file that is plain text that no longer parses is cleared.
		fs.writeFileSync(configPath, '{ this is not JSON');

		new Conf({
			cwd,
			projectVersion: '1.0.0',
			migrations,
			clearInvalidConfig: true,
		});
		assert.deepStrictEqual(runs, ['1.0.0']);
		assert.deepStrictEqual(readConfigFile(configPath), {
			migrated: true,
			__internal__: {migrations: {version: '1.0.0'}},
		});

		// The version the pass reached is in the file, so the step does not run a second time.

		new Conf({
			cwd,
			projectVersion: '1.0.0',
			migrations,
			clearInvalidConfig: true,
		});
		assert.deepStrictEqual(runs, ['1.0.0']);
	});

	it('runs them over a store the `defaults` and the `schema` option have filled in, which is not an empty one', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{ this is not JSON');

		let seen: unknown;

		new Conf<{a: number; b: number}>({
			cwd,
			defaults: {a: 1},
			schema: {b: {type: 'number', default: 2}},
			projectVersion: '1.0.0',
			clearInvalidConfig: true,
			migrations: {
				'1.0.0'(store) {
					seen = {...store.store};
				},
			},
		});

		assert.deepStrictEqual(seen, {a: 1, b: 2});
	});
});

describe('clearing an invalid config that has migrations', () => {
	it('keeps the recorded version when a read clears a file the schema rejects', () => {
		const conf = new Conf<Store>({cwd: createTempDirectory(), clearInvalidConfig: true, schema: {port: {type: 'number'}}});
		fs.writeFileSync(conf.path, JSON.stringify({port: 'oops', __internal__: {migrations: {version: '2.0.0'}}}));

		assert.strictEqual(conf.get('port'), undefined);
		assert.strictEqual(getMigrationVersion(conf), '2.0.0');
	});

	const schema = {port: {type: 'number'}};

	it('clears a config the schema still rejects after the migrations', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({port: 'oops'}));
		const conf = new Conf({
			cwd,
			clearInvalidConfig: true,
			schema,
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('migrated', true);
				},
			},
		});
		assert.deepStrictEqual({...conf.store}, {});
		assert.deepStrictEqual(readConfigFile(conf.path).port, undefined);
	});

	it('leaves a config the migrations repaired alone', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({port: '8080'}));
		const conf = new Conf({
			cwd,
			clearInvalidConfig: true,
			schema,
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('port', 8080);
				},
			},
		});
		assert.deepStrictEqual({...conf.store}, {port: 8080});
	});

	it('still reports a config the schema rejects when the config is not cleared', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({port: 'oops'}));
		assert.throws(() => new Conf({
			cwd,
			schema,
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('migrated', true);
				},
			},
		}), {message: /Config schema violation/});
		assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), {port: 'oops'});
	});

	it('keeps the recorded version, so a migration is not run again', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {port: 'oops', __internal__: {migrations: {version: '1.0.0'}}});
		let runs = 0;
		const options = {
			cwd,
			clearInvalidConfig: true,
			schema: {port: {type: 'number'}},
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store: Conf<Record<string, any>>) {
					runs++;
				},
			},
		};

		// The config the schema rejects is cleared, and the bookkeeping the file held is kept the way a store written whole keeps it.
		const conf = new Conf<Record<string, any>>(options);
		assert.deepStrictEqual({...conf.store}, {});
		assert.strictEqual(getMigrationVersion(conf), '1.0.0');

		new Conf<Record<string, any>>(options);
		assert.strictEqual(runs, 0);
	});
});

describe('the `clearInvalidConfig` option', () => {
	it('`clearInvalidConfig` option - invalid data', () => {
		const conf = new Conf({cwd: createTempDirectory(), clearInvalidConfig: false});
		fs.writeFileSync(conf.path, '🦄');
		fs.statSync(conf.path);

		assert.throws(() => {
			// eslint-disable-next-line @typescript-eslint/no-unused-expressions
			conf.store;
		}, {name: 'SyntaxError'});
	});

	it('`clearInvalidConfig` option - valid data', () => {
		const conf = new Conf({cwd: createTempDirectory(), clearInvalidConfig: false});
		conf.set('foo', 'bar');
		assert.deepStrictEqual(conf.store, createNullProtoObject({foo: 'bar'}));
	});

	it('`clearInvalidConfig` option - schema validation error', () => {
		const temporaryDirectoryPath = createTempDirectory();
		const configPath = path.join(temporaryDirectoryPath, 'config.json');

		// Create config file with invalid schema data
		fs.writeFileSync(configPath, JSON.stringify({myKey: 'invalid-type'}, null, '\t'));
		fs.statSync(configPath);

		// Without clearInvalidConfig, should throw
		assert.throws(() => {
			new Conf({
				cwd: temporaryDirectoryPath,
				clearInvalidConfig: false,
				schema: {myKey: {type: 'boolean'}},
			});
		}, {message: /Config schema violation/});

		// With clearInvalidConfig, should clear the invalid data and create empty config
		const conf = new Conf({
			cwd: temporaryDirectoryPath,
			clearInvalidConfig: true,
			schema: {myKey: {type: 'boolean'}},
		});

		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
	});
});

describe('a damaged config file with the default options', () => {
	it('is written over by `clear()`, which is how a caller recovers from it', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {kept: true}});
		fs.writeFileSync(conf.path, '{"a": 1,');

		assert.throws(() => conf.get('a'), {name: 'SyntaxError'});
		conf.clear();
		assert.deepEqual(readConfigFile(conf), {kept: true});
	});

	it('is written over by a whole-store write', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		fs.writeFileSync(conf.path, 'not json');

		conf.store = {b: 2};
		assert.deepEqual(readConfigFile(conf), {b: 2});
	});

	it('is written over by a whole-store write where another key encrypted it', () => {
		const cwd = createTempDirectory();
		const encrypted = new Conf<Record<string, unknown>>({cwd, encryptionKey: 'right', encryptionAlgorithm: 'aes-256-gcm'});
		encrypted.set('secret', 1);

		const wrong = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), encryptionKey: 'wrong', encryptionAlgorithm: 'aes-256-gcm'});
		fs.writeFileSync(wrong.path, fs.readFileSync(encrypted.path));

		wrong.store = {};
		assert.deepEqual({...wrong.store}, {});
	});

	it('is written over by `clear()` where a `deserialize` of your own cannot read it', () => {
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults: {kept: true},
			deserialize(text: string) {
				return JSON.parse(text) as Record<string, unknown>;
			},
		});
		fs.writeFileSync(conf.path, '{"a": 1,');

		assert.throws(() => conf.get('a'), {name: 'SyntaxError'});
		conf.clear();
		assert.deepEqual(readConfigFile(conf), {kept: true});
	});
});
