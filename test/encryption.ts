/* eslint-disable no-new, @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-assignment */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Buffer} from 'node:buffer';
import {
	describe,
	it,
	afterEach,
	before,
	after,
} from 'node:test';
import assert from 'node:assert/strict';
import Conf, {type Schema} from '../source/index.js';
import {
	createTempDirectory,
	createNullProtoObject,
	runRegisteredCleanups,
	resetTrackedConfs,
	writeLegacyEncryptedConfig,
	readConfigFile,
} from './_utilities.js';

const fixture = '🦄';

const separatorCodePoint = ':'.codePointAt(0);

const initializationVectorLength = 16;

const authenticationTagLength = 16;

const algorithms = ['aes-256-cbc', 'aes-256-gcm', 'aes-256-ctr'] as const;

const otherAlgorithmsThan = (algorithm: string) => algorithms.filter(candidate => candidate !== algorithm);

const encryptionInitializationVectorLength = 16;

const encryptionSeparatorCharacter = ':';

const decryptEncryptedConfig = ({
	filePath,
	encryptionKey,
	encryptionAlgorithm,
}: {
	filePath: string;
	encryptionKey: string;
	encryptionAlgorithm: 'aes-256-cbc' | 'aes-256-gcm' | 'aes-256-ctr';
}): string => {
	const data = fs.readFileSync(filePath);
	const initializationVector = data.subarray(0, encryptionInitializationVectorLength);
	const separatorByte = data[encryptionInitializationVectorLength];
	const separatorCodePoint = encryptionSeparatorCharacter.codePointAt(0);
	assert.ok(separatorCodePoint !== undefined);
	assert.strictEqual(separatorByte, separatorCodePoint);

	const password = crypto.pbkdf2Sync(encryptionKey, initializationVector, 10_000, 32, 'sha512');

	if (encryptionAlgorithm === 'aes-256-gcm') {
		const authenticationTagLength = 16;
		const authenticationTagStart = data.length - authenticationTagLength;
		const ciphertext = data.subarray(encryptionInitializationVectorLength + 1, authenticationTagStart);
		const authenticationTag = data.subarray(authenticationTagStart);
		const decipher = crypto.createDecipheriv(encryptionAlgorithm, password, initializationVector);
		decipher.setAuthTag(authenticationTag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString();
	}

	const ciphertext = data.subarray(encryptionInitializationVectorLength + 1);
	const decipher = crypto.createDecipheriv(encryptionAlgorithm, password, initializationVector);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString();
};

/**
Asserts that the config file holds none of the given texts as they are, which a store that wrote it without encrypting it would. Each text is long enough that random ciphertext does not hold it by chance.
*/
const assertEncrypted = (filePath: string, ...texts: string[]): void => {
	const data = fs.readFileSync(filePath);
	for (const text of texts) {
		assert.ok(!data.includes(text), `the file holds \`${text}\` in plain text`);
	}
};

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('encryption', () => {
	it('refuses an empty string key, and encrypts with an empty byte key', () => {
		const refusedCwd = createTempDirectory();

		// Every use of the key asks whether it is there, so a key of `0` or `false` means no encryption at all, the same as an empty string does, and it is refused rather than leaving the store in plain text under the claim it is encrypted.
		for (const encryptionKey of ['', 0, false] as unknown[]) {
			assert.throws(() => {
				new Conf({cwd: refusedCwd, encryptionKey: encryptionKey as any});
			}, {name: 'TypeError', message: /`encryptionKey` option must not be empty/}, `encryptionKey: ${JSON.stringify(encryptionKey)}`);
		}

		// A `null` is the same as not passing the option, the way every option is read.
		const plainCwd = createTempDirectory();
		new Conf({cwd: plainCwd, encryptionKey: null as any}).set('foo', fixture);
		assert.deepStrictEqual(readConfigFile(path.join(plainCwd, 'config.json')), {foo: fixture});

		// An empty `Uint8Array` is a key, since the encryption asks for it and applies it both ways.
		const keptCwd = createTempDirectory();
		const config = new Conf({cwd: keptCwd, encryptionKey: new Uint8Array(0)});
		config.set('foo', fixture);

		assert.ok(!fs.readFileSync(config.path, 'utf8').includes('foo'));
		assert.strictEqual(new Conf({cwd: keptCwd, encryptionKey: new Uint8Array(0)}).get('foo'), fixture);
	});

	for (const algorithm of algorithms) {
		it(`round-trips a store whose serialized form is empty with \`${algorithm}\``, () => {
			const cwd = createTempDirectory();
			const serialize = (value: Record<string, unknown>): string => Object.keys(value).length === 0 ? '' : JSON.stringify(value);
			const deserialize = (value: string): Record<string, unknown> => {
				if (value === '') {
					return createNullProtoObject({});
				}

				return JSON.parse(value) as Record<string, unknown>;
			};

			const options = {
				cwd,
				encryptionKey: 'k',
				encryptionAlgorithm: algorithm,
				serialize,
				deserialize,
			};

			new Conf(options).store = {};

			assert.deepStrictEqual(new Conf(options).store, createNullProtoObject({}));
		});
	}

	it('reads a store another algorithm wrote as nothing the store holds', () => {
		for (const writtenWith of algorithms) {
			for (const readWith of otherAlgorithmsThan(writtenWith)) {
				const cwd = createTempDirectory();
				new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: writtenWith}).set('writtenWith', writtenWith);

				assert.throws(() => {
					const config = new Conf<Record<string, unknown>>({cwd, encryptionKey: 'k', encryptionAlgorithm: readWith});
					// A store another algorithm wrote never holds what the one reading it wrote, whatever the bytes decrypt to.
					assert.notStrictEqual(config.get('writtenWith'), writtenWith);
				}, error => error instanceof Error, `a store written with ${writtenWith} was read as ${readWith}`);
			}
		}
	});

	it('keeps reading a plaintext file with `aes-256-cbc` whether or not byte 16 is the separator', () => {
		// Byte 16 is the one byte of the encrypted format a read can look for, so a plaintext file has to be read as plaintext with a `:` there and without one.
		const separatorStatesSeen = new Set<boolean>();

		for (const keyLength of [1, 11]) {
			const cwd = createTempDirectory();
			const configPath = path.join(cwd, 'config.json');
			const json = JSON.stringify({['a'.repeat(keyLength)]: 'value', foo: fixture}, undefined, '\t');
			fs.writeFileSync(configPath, json);
			separatorStatesSeen.add(json.codePointAt(initializationVectorLength) === separatorCodePoint);

			assert.strictEqual(new Conf({cwd, encryptionKey: 'k'}).get('foo'), fixture, `a file whose first key is ${keyLength} characters long`);
		}

		assert.ok(separatorStatesSeen.has(false) && separatorStatesSeen.has(true), 'both shapes of byte 16 were covered');
	});

	it('reports a decryption failure for an `aes-256-gcm` store that stops before its authentication tag', () => {
		const cwd = createTempDirectory();
		new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'}).set('foo', fixture);

		const file = fs.readFileSync(path.join(cwd, 'config.json'));
		// The initialization vector and the separator are what a read looks for, and the tag is what makes the data readable.
		for (const length of [initializationVectorLength, initializationVectorLength + 1, file.length - authenticationTagLength]) {
			fs.writeFileSync(path.join(cwd, 'config.json'), file.subarray(0, length));

			assert.throws(() => {
				new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'});
			}, {message: 'Failed to decrypt config data.'}, `a file of ${length} bytes`);
		}
	});

	it('rejects an `aes-256-gcm` store that was changed in any part of it', () => {
		const cwd = createTempDirectory();
		new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'}).set('foo', fixture);
		new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'}).set('bar', fixture);

		const configPath = path.join(cwd, 'config.json');
		const original = fs.readFileSync(configPath);
		// The initialization vector, the separator, the ciphertext and the authentication tag.
		const positions = [0, initializationVectorLength - 1, initializationVectorLength, initializationVectorLength + 1, original.length - authenticationTagLength - 1, original.length - 1];

		for (const position of positions) {
			for (const replacement of [0x00, 0xFF]) {
				if (original[position] === replacement) {
					continue;
				}

				const changed = Buffer.from(original);
				changed[position] = replacement;
				fs.writeFileSync(configPath, changed);

				assert.throws(() => {
					new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'});
				}, error => error instanceof Error, `a change at byte ${position} to 0x${replacement.toString(16)} was not detected`);
			}
		}
	});

	it('reads a store an older version wrote, then writes it the current way', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		writeLegacyEncryptedConfig({filePath: configPath, encryptionKey: 'k', value: {foo: fixture}});

		const config = new Conf({cwd, encryptionKey: 'k'});
		assert.strictEqual(config.get('foo'), fixture);

		config.set('bar', 'baz');

		// The salt the store holds is the one the file is read with, which is the initialization vector itself for anything written from here on.
		const file = fs.readFileSync(configPath);
		const initializationVector = file.subarray(0, initializationVectorLength);
		const password = crypto.pbkdf2Sync('k', initializationVector, 10_000, 32, 'sha512');
		const decipher = crypto.createDecipheriv('aes-256-cbc', password, initializationVector);
		const rewritten = Buffer.concat([decipher.update(file.subarray(initializationVectorLength + 1)), decipher.final()]).toString();

		assert.deepStrictEqual(JSON.parse(rewritten), {foo: fixture, bar: 'baz'});
	});

	// A file written with an algorithm an older version did not have is one that version cannot read, and it says so rather than reading the bytes as text, which is what a store that found it would otherwise do.
	for (const algorithm of ['aes-256-gcm', 'aes-256-ctr'] as const) {
		it(`writes a file with \`${algorithm}\` that an older version cannot read, and says so`, () => {
			const cwd = createTempDirectory();
			const config = new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: algorithm});
			config.set('foo', fixture);

			// An older version knows only `aes-256-cbc`, so it reads the bytes as the text they are not.
			assert.throws(() => new Conf({cwd, encryptionKey: 'k'}), {name: 'SyntaxError'});

			// The store that wrote it still reads it, which is the direction that matters.
			assert.deepStrictEqual({...new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: algorithm}).store}, {foo: fixture});
		});
	}

	for (const encryptionKey of [undefined, 'k'] as Array<string | undefined>) {
		it(`writes through a symlink at the config path${encryptionKey ? ' with a key' : ''}`, () => {
			const cwd = createTempDirectory();
			const target = path.join(cwd, 'target.json');
			fs.writeFileSync(target, JSON.stringify({before: true}, undefined, '\t'));
			fs.symlinkSync(target, path.join(cwd, 'config.json'));
			const options = {cwd, ...encryptionKey ? {encryptionKey} : {}};

			new Conf<Record<string, unknown>>(options).set('after', true);

			// The link is followed rather than renamed over, since what it points at is the file the store reads back.
			assert.ok(fs.lstatSync(path.join(cwd, 'config.json')).isSymbolicLink());
			assert.deepStrictEqual({...new Conf<Record<string, unknown>>(options).store}, {before: true, after: true});
		});
	}
});

describe('a file the store cannot read', () => {
	// A file the key does not decrypt is one the store cannot read, so the `clearInvalidConfig` option clears it, which is what lets a store whose key changed recover.
	for (const encryptionAlgorithm of ['aes-256-cbc', 'aes-256-gcm', 'aes-256-ctr'] as const) {
		it(`clears an \`${encryptionAlgorithm}\` file a wrong key cannot read, and writes after it`, () => {
			const cwd = createTempDirectory();
			const right = {cwd, encryptionKey: 'right', encryptionAlgorithm} as const;
			new Conf(right).set('userData', 'lost');

			const wrong = new Conf({
				...right,
				encryptionKey: 'wrong',
				clearInvalidConfig: true,
				defaults: {appSetting: 'default'},
			});
			assert.deepStrictEqual(wrong.store, createNullProtoObject({appSetting: 'default'}));
			wrong.set('written', 1);
			assert.deepStrictEqual({...new Conf({...right, encryptionKey: 'wrong'}).store}, {appSetting: 'default', written: 1});
		});

		it(`clears a damaged \`${encryptionAlgorithm}\` file`, () => {
			const cwd = createTempDirectory();
			const options = {cwd, encryptionKey: 'key', encryptionAlgorithm} as const;
			const seed = new Conf(options);
			seed.set('userData', 'lost');
			fs.writeFileSync(seed.path, fs.readFileSync(seed.path).subarray(0, 17));

			const cleared = new Conf({...options, clearInvalidConfig: true});
			assert.deepStrictEqual(cleared.store, createNullProtoObject({}));
			assert.deepStrictEqual(new Conf(options).store, createNullProtoObject({}));
		});
	}

	// A cleared store holds no recorded version, so the migrations run over it the way they run over any store that has none.
	it('runs the migrations over the store it cleared', () => {
		const cwd = createTempDirectory();
		const right = {cwd, encryptionKey: 'right', encryptionAlgorithm: 'aes-256-gcm'} as const;
		new Conf(right).set('userData', 'lost');

		const wrong = new Conf({
			...right,
			encryptionKey: 'wrong',
			clearInvalidConfig: true,
			projectVersion: '2.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('migrated', true);
				},
			},
		});

		assert.deepStrictEqual({...wrong.store}, {migrated: true});
	});
});

describe('a plaintext config file read with a key', () => {
	// `aes-256-cbc` reads a plaintext config file for backward compatibility, and a wrong key salt can decrypt to data with valid padding, so what the decrypt leaves behind is not always the file.
	it('reads a plaintext file the decrypt turns into something else', () => {
		const cwd = createTempDirectory();
		// The `:` of an 11-character key is the 17th byte, and the file is a whole number of AES blocks, so the wrong key salt decrypts without complaint.
		fs.writeFileSync(path.join(cwd, 'config.json'), '{"aaaaaaaaaaaaa":"aa00000000273"}');

		assert.deepStrictEqual({...new Conf<Record<string, unknown>>({cwd, encryptionKey: 'a-key'}).store}, {aaaaaaaaaaaaa: 'aa00000000273'});
	});

	it('still reports a file that is not a store, encrypted or not', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), 'not a store at all');
		assert.throws(() => new Conf({cwd, encryptionKey: 'a-key'}), {name: 'SyntaxError'});
	});
});

describe('key types and formats', () => {
	it('round-trips with a Buffer key', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionKey: Buffer.from('buffer-secret-key')});
		conf.set('secret', 'value');
		assert.strictEqual(conf.get('secret'), 'value');
		assertEncrypted(conf.path, '"secret"', '"value"');
		const second = new Conf({cwd, encryptionKey: Buffer.from('buffer-secret-key')});
		assert.strictEqual(second.get('secret'), 'value');
	});

	it('round-trips with a Uint8Array key', () => {
		const cwd = createTempDirectory();
		const key = new TextEncoder().encode('uint8-secret');
		const conf = new Conf({cwd, encryptionKey: key});
		conf.set('k', {nested: [1, 2]});
		assertEncrypted(conf.path, '"nested"');
		assert.deepStrictEqual(new Conf({cwd, encryptionKey: key}).get('k'), {nested: [1, 2]});
	});

	it('encrypted file is not plaintext and has IV plus separator', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionKey: 'obsidian'});
		conf.set('foo', 'bar');
		const raw = fs.readFileSync(conf.path);
		assert.ok(!raw.toString('utf8').includes('"foo"'));
		assert.strictEqual(raw[16], ':'.codePointAt(0));
		assert.ok(raw.length > 17);
	});

	it('each algorithm round-trips independently', () => {
		for (const encryptionAlgorithm of ['aes-256-cbc', 'aes-256-gcm', 'aes-256-ctr'] as const) {
			const cwd = createTempDirectory();
			const conf = new Conf({cwd, encryptionKey: 'algo-key', encryptionAlgorithm});
			conf.set('value', 'hello');
			assertEncrypted(conf.path, '"value"', '"hello"');
			const reread = new Conf({cwd, encryptionKey: 'algo-key', encryptionAlgorithm});
			assert.strictEqual(reread.get('value'), 'hello', encryptionAlgorithm);
		}
	});

	it('changing the algorithm makes old data unreadable', () => {
		const cwd = createTempDirectory();
		const writer = new Conf({cwd, encryptionKey: 'same-key', encryptionAlgorithm: 'aes-256-cbc'});
		writer.set('a', 1);
		assert.throws(() => {
			new Conf({cwd, encryptionKey: 'same-key', encryptionAlgorithm: 'aes-256-gcm'});
		}, {name: 'Error', message: 'Failed to decrypt config data.'});
	});

	it('a wrong key fails to decrypt', () => {
		const cwd = createTempDirectory();
		const writer = new Conf({cwd, encryptionKey: 'right-key', encryptionAlgorithm: 'aes-256-gcm'});
		writer.set('a', 1);
		assert.throws(() => {
			new Conf({cwd, encryptionKey: 'wrong-key', encryptionAlgorithm: 'aes-256-gcm'});
		}, {message: 'Failed to decrypt config data.'});

		// The right key reads the same file, so it is the key that failed above and not the file.
		assert.strictEqual(new Conf({cwd, encryptionKey: 'right-key', encryptionAlgorithm: 'aes-256-gcm'}).get('a'), 1);
	});

	// A plain text file is not one `aes-256-gcm` decrypts, so a key added with that algorithm reports the file, and the `clearInvalidConfig` option clears it.
	it('reports a file this module wrote in plain text, where a key cannot read it, and clears it with `clearInvalidConfig`', () => {
		const cwd = createTempDirectory();
		const plain = new Conf<Record<string, any>>({cwd});
		plain.set('data', 'the setting');
		const before = fs.readFileSync(plain.path);
		const options = {cwd, encryptionKey: 'a-key-that-is-long-enough', encryptionAlgorithm: 'aes-256-gcm'} as const;

		assert.throws(() => new Conf(options), {message: 'Failed to decrypt config data.'});
		assert.deepStrictEqual(fs.readFileSync(plain.path), before);

		const withKey = new Conf<Record<string, any>>({...options, clearInvalidConfig: true});
		assert.deepStrictEqual({...withKey.store}, {});
		withKey.set('other', true);
		assert.deepStrictEqual({...new Conf<Record<string, any>>(options).store}, {other: true});
	});

	it('encryption without a key option still stores plaintext', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionAlgorithm: 'aes-256-gcm'});
		conf.set('plain', true);
		assert.deepStrictEqual(readConfigFile(conf.path), {plain: true});
	});

	it('round-trips unicode payloads under encryption', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionKey: 'unicode-key'});
		conf.set('emoji', '🦄🌈');
		conf.set('text', 'Hello 世界');
		assertEncrypted(conf.path, '🦄🌈', 'Hello 世界');
		const reread = new Conf({cwd, encryptionKey: 'unicode-key'});
		assert.strictEqual(reread.get('emoji'), '🦄🌈');
		assert.strictEqual(reread.get('text'), 'Hello 世界');
	});

	it('supports encrypted appendToArray, delete and has', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionKey: 'ops-key'});
		conf.appendToArray('list', 'a');
		conf.appendToArray('list', 'b');
		assert.deepStrictEqual(conf.get('list'), ['a', 'b']);
		assert.strictEqual(conf.has('list'), true);
		conf.delete('list.0');
		assert.deepStrictEqual(conf.get('list'), ['b']);
	});

	it('an encryption key that is an empty typed array still encrypts', () => {
		const cwd = createTempDirectory();
		const options = {cwd, encryptionKey: new Uint8Array(0), encryptionAlgorithm: 'aes-256-gcm'} as const;

		// A typed array is key material whatever its length and is derived, so an empty one still writes ciphertext the way a short string does, while the refusals above cover the values the module would take as no key at all.
		const conf = new Conf(options);
		conf.set('foo', 'bar');
		assert.notStrictEqual(fs.readFileSync(conf.path, 'utf8'), JSON.stringify({foo: 'bar'}));
		assert.strictEqual(new Conf(options).get('foo'), 'bar');
	});
});

describe('encryption with other options', () => {
	it('combines encryption with defaults', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionKey: 'k', defaults: {theme: 'light'}});
		assert.strictEqual(conf.get('theme'), 'light');
		conf.set('theme', 'dark');
		assert.strictEqual(new Conf({cwd, encryptionKey: 'k', defaults: {theme: 'light'}}).get('theme'), 'dark');
		assert.ok(!fs.readFileSync(conf.path, 'utf8').includes('dark'));
	});

	it('combines encryption with schema validation', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionKey: 'k', schema: {n: {type: 'number'}}});
		conf.set('n', 1);
		assert.strictEqual(new Conf({cwd, encryptionKey: 'k', schema: {n: {type: 'number'}}}).get('n'), 1);
		assert.throws(() => {
			conf.set('n', 'bad');
		}, {message: /Config schema violation/});
	});

	it('combines encryption with custom serialization', () => {
		const cwd = createTempDirectory();
		const options = {
			cwd,
			encryptionKey: 'k',
			serialize: (value: unknown) => JSON.stringify(value),
			deserialize: (text: string) => JSON.parse(text) as Record<string, unknown>,
		};
		const conf = new Conf(options);
		conf.set('a', {b: 1});
		assert.deepStrictEqual(new Conf(options).get('a'), {b: 1});
	});

	it('supports TypedArray keys beyond Uint8Array', () => {
		const cwd = createTempDirectory();
		const key = new Uint16Array([10, 20, 30, 40, 50, 60, 70, 80]);
		const conf = new Conf({cwd, encryptionKey: key});
		conf.set('t', 'value');
		assertEncrypted(conf.path, '"value"');
		assert.strictEqual(new Conf({cwd, encryptionKey: key}).get('t'), 'value');
	});

	it('supports DataView keys with a byte offset', () => {
		const bytes = new Uint8Array([0, 0, 5, 6, 7, 8, 9, 10, 11]);
		const key = new DataView(bytes.buffer, 2);
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionKey: key});
		conf.set('dataView', 'value');
		assertEncrypted(conf.path, '"dataView"');

		// The key is the bytes from the offset on, so the same bytes in a key of their own read the store, which they would not if the bytes before the offset were part of it.
		assert.strictEqual(new Conf({cwd, encryptionKey: new Uint8Array([5, 6, 7, 8, 9, 10, 11])}).get('dataView'), 'value');
	});

	it('round-trips an empty store under aes-256-gcm', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'});
		conf.clear();
		assert.deepStrictEqual(new Conf({cwd, encryptionKey: 'k', encryptionAlgorithm: 'aes-256-gcm'}).store, createNullProtoObject({}));
	});
});

describe('an encrypted store', () => {
	it('encrypts the store and reads it back', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			encryptionKey: 'abc123',
		});

		assert.strictEqual(conf.get('foo'), undefined);
		assert.strictEqual(conf.get('foo', '🐴'), '🐴');
		conf.set('foo', fixture);
		conf.set('baz.boo', fixture);
		assert.strictEqual(conf.get('foo'), fixture);
		assert.strictEqual(conf.get('baz.boo'), fixture);
		assertEncrypted(conf.path, '"foo"', '"boo"', fixture);
	});

	it('encryption - aes-256-gcm', () => {
		const cwd = createTempDirectory();
		const encryptionKey = 'abc123';
		const conf = new Conf({
			cwd,
			encryptionKey,
			encryptionAlgorithm: 'aes-256-gcm',
		});

		conf.set('foo', fixture);

		const data = decryptEncryptedConfig({
			filePath: path.join(cwd, 'config.json'),
			encryptionKey,
			encryptionAlgorithm: 'aes-256-gcm',
		});

		assert.strictEqual(JSON.parse(data).foo, fixture);
	});

	it('encryption - aes-256-gcm - empty serialized payload', () => {
		const cwd = createTempDirectory();
		const encryptionKey = 'abc123';
		const serialize = (value: Record<string, unknown>): string => {
			if (Object.keys(value).length === 0) {
				return '';
			}

			return JSON.stringify(value);
		};

		const deserialize = (value: string): Record<string, unknown> => {
			if (value === '') {
				return {};
			}

			const parsed: Record<string, unknown> = JSON.parse(value) as Record<string, unknown>;
			return parsed;
		};

		const conf = new Conf({
			cwd,
			encryptionKey,
			encryptionAlgorithm: 'aes-256-gcm',
			serialize,
			deserialize,
		});

		conf.store = {};

		const reloaded = new Conf({
			cwd,
			encryptionKey,
			encryptionAlgorithm: 'aes-256-gcm',
			serialize,
			deserialize,
		});

		assert.deepStrictEqual(reloaded.store, createNullProtoObject({}));
	});

	it('encryption - schema violation preserves error', () => {
		const cwd = createTempDirectory();
		const encryptionKey = 'abc123';
		const writer = new Conf({
			cwd,
			encryptionKey,
		});

		writer.store = {foo: 'not-boolean'};

		assert.throws(() => {
			new Conf({
				cwd,
				encryptionKey,
				schema: {
					foo: {
						type: 'boolean',
					},
				},
			});
		}, {message: 'Config schema violation: `foo` must be boolean'});
	});

	it('encryption - aes-256-gcm - plaintext upgrade fails', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		fs.writeFileSync(configPath, JSON.stringify({foo: fixture}, null, '\t'));

		assert.throws(() => {
			new Conf({
				cwd,
				encryptionKey: 'abc123',
				encryptionAlgorithm: 'aes-256-gcm',
			});
		}, {message: 'Failed to decrypt config data.'});
	});

	it('encryption - legacy initialization vector salt', () => {
		const cwd = createTempDirectory();
		const encryptionKey = 'abc123';
		const configPath = path.join(cwd, 'config.json');

		writeLegacyEncryptedConfig({
			filePath: configPath,
			encryptionKey,
			value: {foo: fixture},
		});

		const conf = new Conf({cwd, encryptionKey});
		assert.strictEqual(conf.get('foo'), fixture);
	});

	it('encryption - aes-256-ctr', () => {
		const cwd = createTempDirectory();
		const encryptionKey = 'abc123';
		const conf = new Conf({
			cwd,
			encryptionKey,
			encryptionAlgorithm: 'aes-256-ctr',
		});

		conf.set('foo', fixture);

		const data = decryptEncryptedConfig({
			filePath: path.join(cwd, 'config.json'),
			encryptionKey,
			encryptionAlgorithm: 'aes-256-ctr',
		});

		assert.strictEqual(JSON.parse(data).foo, fixture);
	});

	it('encryption - aes-256-ctr - plaintext upgrade fails', () => {
		const cwd = createTempDirectory();

		const config = new Conf({cwd});
		config.set('foo', fixture);

		assert.throws(() => {
			new Conf({
				cwd,
				encryptionKey: 'abc123',
				encryptionAlgorithm: 'aes-256-ctr',
			});
		}, {name: 'Error', message: 'Failed to decrypt config data.'});
	});

	it('encryption - aes-256-cbc - plaintext upgrade succeeds', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');

		fs.writeFileSync(configPath, JSON.stringify({foo: fixture}, null, '\t'));

		const config = new Conf({cwd, encryptionKey: 'abc123'});
		assert.strictEqual(config.get('foo'), fixture);
	});

	it('encryption - corrupt file', () => {
		const cwd = createTempDirectory();

		const before = new Conf({
			cwd,
			encryptionKey: 'abc123',
			clearInvalidConfig: true,
		});

		before.set('foo', fixture);
		assert.strictEqual(before.get('foo'), fixture);

		fs.appendFileSync(path.join(cwd, 'config.json'), 'corrupt file');

		const after = new Conf({
			cwd,
			encryptionKey: 'abc123',
			clearInvalidConfig: true,
		});

		assert.strictEqual(after.get('foo'), undefined);
	});

	it('encryption - invalid separator fails', () => {
		const cwd = createTempDirectory();
		const encryptionKey = 'abc123';
		const configPath = path.join(cwd, 'config.json');

		const before = new Conf({
			cwd,
			encryptionKey,
		});

		before.set('foo', fixture);

		const data = fs.readFileSync(configPath);
		data[encryptionInitializationVectorLength] = 'x'.codePointAt(0) ?? 0;
		fs.writeFileSync(configPath, data);

		assert.throws(() => {
			new Conf({
				cwd,
				encryptionKey,
			});
		}, {name: 'SyntaxError'});
	});

	it('encryption - corrupt file with schema clears data', () => {
		const cwd = createTempDirectory();
		const schema: Schema<{enabled: boolean}> = {enabled: {type: 'boolean'}};

		const before = new Conf({
			cwd,
			encryptionKey: 'enc-schema',
			schema,
			clearInvalidConfig: true,
		});

		before.set('enabled', true);
		const corruptedPath = path.join(cwd, 'config.json');
		fs.writeFileSync(corruptedPath, 'corrupt-data');
		fs.statSync(corruptedPath);

		const after = new Conf({
			cwd,
			encryptionKey: 'enc-schema',
			schema,
			clearInvalidConfig: true,
		});

		assert.strictEqual(after.get('enabled'), undefined);
		// The file is plain text that does not parse, which is damage, so it is written over with an encrypted empty store.
		assert.notStrictEqual(fs.readFileSync(corruptedPath, 'utf8'), 'corrupt-data');
		assert.deepStrictEqual({...new Conf({cwd, encryptionKey: 'enc-schema'}).store}, {});
	});

	it('uses a fresh random IV per file (ciphertexts differ)', () => {
		const first = new Conf({cwd: createTempDirectory(), encryptionKey: 'k'});
		const second = new Conf({cwd: createTempDirectory(), encryptionKey: 'k'});
		first.set('v', 'same');
		second.set('v', 'same');
		assert.ok(!fs.readFileSync(first.path).equals(fs.readFileSync(second.path)));
		assert.strictEqual(first.get('v'), 'same');
		assert.strictEqual(second.get('v'), 'same');
	});

	it('reads a legacy encrypted config file when the first decryption is not readable', () => {
		const cwd = createTempDirectory();
		writeLegacyEncryptedConfig({
			filePath: path.join(cwd, 'config.json'),
			encryptionKey: 'abc123',
			value: {foo: '🦄'},
		});

		// A wrong key salt throws in `aes-256-cbc` only about 99.5% of the time: it can also decrypt to data with valid padding, which is then not readable. A deserializer that fails once stands in for that, since the chance cannot be forced.
		let calls = 0;
		const store = new Conf({
			cwd,
			encryptionKey: 'abc123',
			deserialize(value: string) {
				calls++;
				if (calls === 1) {
					throw new SyntaxError('Not readable');
				}

				return JSON.parse(value) as Record<string, unknown>;
			},
		});

		assert.strictEqual(store.get('foo'), '🦄');
	});

	it('refuses an `encryptionAlgorithm` that is not supported', () => {
		assert.throws(() => {
			new Conf({
				cwd: createTempDirectory(),
				encryptionKey: 'secret',
				encryptionAlgorithm: 'aes-128-cbc' as unknown as 'aes-256-cbc',
			});
		}, {message: /`encryptionAlgorithm` option/});
	});

	it('clears a store that cannot be decrypted', () => {
		const cwd = createTempDirectory();
		const options = {cwd, encryptionKey: 'secret', encryptionAlgorithm: 'aes-256-gcm'} as const;
		const conf = new Conf(options);
		conf.set('foo', 'bar');

		// The authentication tag covers the data, so a file that was changed cannot be decrypted.
		fs.appendFileSync(conf.path, 'corrupt file');

		assert.throws(() => {
			new Conf(options);
		}, {message: 'Failed to decrypt config data.'});

		assert.deepStrictEqual(new Conf({...options, clearInvalidConfig: true}).store, createNullProtoObject({}));
		assert.deepStrictEqual(new Conf(options).store, createNullProtoObject({}));
	});

	it('clears an encrypted store whose payload is cut short', () => {
		const cwd = createTempDirectory();
		const options = {cwd, encryptionKey: 'secret', encryptionAlgorithm: 'aes-256-gcm'} as const;
		const conf = new Conf(options);
		conf.set('foo', 'bar');

		// A file that stops before the authentication tag holds no tag to check the data against.
		fs.writeFileSync(conf.path, fs.readFileSync(conf.path).subarray(0, 17));

		assert.throws(() => {
			new Conf(options);
		}, {message: 'Failed to decrypt config data.'});

		assert.deepStrictEqual(new Conf({...options, clearInvalidConfig: true}).store, createNullProtoObject({}));
		assert.deepStrictEqual(new Conf(options).store, createNullProtoObject({}));
	});
});

describe('a store encrypted with another key', () => {
	it('derives the key once per salt when it reads the file', () => {
		const cwd = createTempDirectory();
		new Conf({cwd, encryptionKey: 'right', encryptionAlgorithm: 'aes-256-gcm'}).set('a', 1);
		const wrong = new Conf({
			cwd: createTempDirectory(),
			encryptionKey: 'wrong',
			encryptionAlgorithm: 'aes-256-gcm',
		});
		fs.copyFileSync(path.join(cwd, 'config.json'), wrong.path);

		const realDerive = crypto.pbkdf2Sync;
		let derivations = 0;
		crypto.pbkdf2Sync = ((...arguments_: Parameters<typeof crypto.pbkdf2Sync>) => {
			derivations++;
			return realDerive(...arguments_);
		});

		try {
			assert.throws(() => wrong.store, {message: 'Failed to decrypt config data.'});
		} finally {
			crypto.pbkdf2Sync = realDerive;
		}

		assert.equal(derivations, 2);
	});
});
