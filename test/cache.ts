/* eslint-disable @typescript-eslint/naming-convention */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createMigrationTest,
	createExistingConfig,
	createTempDirectory,
	trackConf,
	resetTrackedConfs,
	createNullProtoObject,
	readConfigFile,
	runRegisteredCleanups,
	dateReviving,
} from './_utilities.js';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('the `cache` option', () => {
	it('reads from memory instead of the file', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		createExistingConfig(path.dirname(conf.path), {foo: 'changed-by-another-process'});

		assert.strictEqual(conf.get('foo'), 'bar');
	});

	it('still reads the file when the cache is disabled', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory()}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		createExistingConfig(path.dirname(conf.path), {foo: 'changed-by-another-process'});

		assert.strictEqual(conf.get('foo'), 'changed-by-another-process');
	});

	it('reads from memory when the config file cannot be read', () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		const uncached = trackConf(new Conf({cwd}));
		assert.strictEqual(uncached.get('foo'), 'bar');

		// Replace the file with a directory so that reading the path fails. Only the cached instance can still read.
		fs.rmSync(conf.path);
		fs.mkdirSync(conf.path);

		assert.strictEqual(conf.get('foo'), 'bar');
		assert.throws(() => uncached.get('foo'), {code: 'EISDIR'});
	});

	it('does not share the cache between instances', () => {
		const cwd = createTempDirectory();
		const first = trackConf(new Conf({cwd, cache: true}));
		first.set('foo', 'first');

		// A second instance on the same path must read the file rather than another instance's cache.
		const second = trackConf(new Conf({cwd, cache: true}));
		assert.strictEqual(second.get('foo'), 'first');
		assert.strictEqual(second.size, 1);

		// Instances on different paths must never see each other.
		const other = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		assert.strictEqual(other.get('foo'), undefined);
		assert.strictEqual(other.size, 0);

		first.set('bar', 'second');

		assert.strictEqual(first.get('bar'), 'second');
		assert.strictEqual(other.get('bar'), undefined);
	});

	it('drops the cache when an item is set', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		conf.set('baz', 'qux');
		assert.strictEqual(conf.get('baz'), 'qux');
	});

	it('does not lose changes made by another process when setting an item', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		createExistingConfig(path.dirname(conf.path), {foo: 'bar', external: 'kept'});

		conf.set('baz', 'qux');

		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'bar', external: 'kept', baz: 'qux'});
		assert.strictEqual(conf.get('external'), 'kept');
	});

	it('does not lose changes made by another process when appending to an array', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('items', ['first']);
		assert.deepStrictEqual(conf.get('items'), ['first']);

		createExistingConfig(path.dirname(conf.path), {items: ['first', 'external']});

		conf.appendToArray('items', 'second');

		assert.deepStrictEqual(readConfigFile(conf.path).items, ['first', 'external', 'second']);
	});

	it('uses the cache without dot notation', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true, accessPropertiesByDotNotation: false}));
		conf.set('items', ['first']);
		conf.set('foo.bar', 'literal');
		assert.deepStrictEqual(conf.get('items'), ['first']);

		createExistingConfig(path.dirname(conf.path), {items: ['first', 'external'], 'foo.bar': 'changed', extra: true});

		// Every read API must serve the cache when keys are used as literal strings.
		assert.strictEqual(conf.get('foo.bar'), 'literal');
		assert.deepStrictEqual(conf.get('items'), ['first']);
		assert.ok(!conf.has('extra'));
		assert.strictEqual(conf.size, 2);

		conf.appendToArray('items', 'second');

		assert.deepStrictEqual(readConfigFile(conf.path).items, ['first', 'external', 'second']);
	});

	it('does not lose changes made by another process when deleting an item', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		createExistingConfig(path.dirname(conf.path), {foo: 'bar', external: 'kept'});

		conf.delete('foo');

		// The delete must merge against the file, not against the stale cache.
		assert.deepStrictEqual(readConfigFile(conf.path), {external: 'kept'});
		assert.strictEqual(conf.get('external'), 'kept');
	});

	// A `reset` writes the one key it is given, so it is a write of that key and keeps what the file holds around it, the way a `set()` of the same key does.
	it('does not lose changes made by another process when resetting an item', () => {
		const conf = trackConf(new Conf<Record<string, any>>({cwd: createTempDirectory(), cache: true, defaults: {foo: 'default'}}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		createExistingConfig(path.dirname(conf.path), {foo: 'bar', external: 'kept'});

		conf.reset('foo');

		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'default', external: 'kept'});
		assert.strictEqual(conf.get('external'), 'kept');
	});

	// A `clear()` is the one write that is not of a key: it leaves the store holding the defaults, so a key another process added is not one of them and does not survive. The readme says two processes writing at once are not supported, and this is what that looks like from the side that is written.
	it('drops a key another process added, since a `clear()` leaves only the defaults', () => {
		const conf = trackConf(new Conf<Record<string, any>>({cwd: createTempDirectory(), cache: true, defaults: {foo: 'default'}}));
		conf.set('foo', 'bar');

		createExistingConfig(path.dirname(conf.path), {foo: 'bar', external: 'dropped'});

		conf.clear();

		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'default'});
	});

	it('drops the cache when the store is cleared', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		conf.clear();
		assert.strictEqual(conf.get('foo'), undefined);
	});

	it('uses the cache for every read API', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set({foo: 'bar', nested: {value: 1}});
		// Populate the cache.
		assert.strictEqual(conf.size, 2);

		createExistingConfig(path.dirname(conf.path), {foo: 'changed', nested: {value: 2}, extra: true});

		assert.deepStrictEqual(Object.keys(conf.store), ['foo', 'nested']);
		assert.strictEqual(conf.get('foo'), 'bar');
		assert.deepStrictEqual(conf.get('nested'), {value: 1});
		assert.ok(conf.has('foo'));
		assert.ok(!conf.has('extra'));
		assert.strictEqual(conf.size, 2);
		assert.deepStrictEqual([...conf], [['foo', 'bar'], ['nested', {value: 1}]]);
	});

	it('reports the changed value to `onDidChange`', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		const history: Array<{newValue: unknown; oldValue: unknown}> = [];
		conf.onDidChange('foo', (newValue, oldValue) => {
			history.push({newValue, oldValue});
		});

		conf.set('foo', 'baz');

		assert.deepStrictEqual(history, [{newValue: 'baz', oldValue: 'bar'}]);
	});

	it('reports the changed store to `onDidAnyChange`', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		const history: Array<Record<string, unknown>> = [];
		conf.onDidAnyChange(newValue => {
			history.push({...newValue});
		});

		conf.set('baz', 'qux');

		assert.deepStrictEqual(history, [{foo: 'bar', baz: 'qux'}]);
	});

	it('applies the `defaults` option', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, cache: true, defaults: {foo: 'default'}});

		assert.strictEqual(conf.get('foo'), 'default');
		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'default'});

		createExistingConfig(path.dirname(conf.path), {foo: 'external'});
		assert.strictEqual(conf.get('foo'), 'default');
	});

	it('drops the cache when the store is replaced', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		conf.store = {baz: 'qux'};

		assert.strictEqual(conf.get('foo'), undefined);
		assert.strictEqual(conf.get('baz'), 'qux');
		assert.deepStrictEqual(readConfigFile(conf.path), {baz: 'qux'});
	});

	it('hands out the frozen cache, so what a caller does to what it read is refused', () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true}));
		conf.set('nested', {count: 1});

		// What a read hands back is the cache itself, which is frozen, so changing it throws rather than changing what the store reports.
		const nested = conf.get('nested') as {count: number};
		assert.throws(() => {
			nested.count = 2;
		}, TypeError);
		assert.throws(() => {
			conf.store.added = true;
		}, TypeError);
		assert.deepStrictEqual(conf.get('nested'), {count: 1});
		assert.strictEqual(conf.get('nested'), conf.get('nested'), 'two reads are the same value');

		// A write reads the file, so what is in it is what is written.
		conf.set('other', 'value');
		assert.deepStrictEqual(readConfigFile(conf.path), {nested: {count: 1}, other: 'value'});
		assert.deepStrictEqual(conf.get('nested'), {count: 1});
	});

	// The values a change listener is told about are the frozen cache too, which is what the readme says of them.
	it('hands a change listener the frozen cache', () => {
		const conf = trackConf(new Conf<Record<string, any>>({cwd: createTempDirectory(), cache: true}));
		conf.set('nested', {count: 1});
		// The cache holds the store before the change is made, so the old value a listener is told about is read from it.
		assert.deepStrictEqual(conf.get('nested'), {count: 1});

		const frozen: boolean[] = [];
		conf.onDidChange('nested', (newValue: any, oldValue: any) => {
			frozen.push(Object.isFrozen(newValue), Object.isFrozen(oldValue));
		});
		conf.onDidAnyChange((newValue: any, oldValue: any) => {
			frozen.push(Object.isFrozen(newValue), Object.isFrozen(newValue.nested), Object.isFrozen(oldValue));
		});

		conf.set('nested', {count: 2});
		assert.deepStrictEqual(frozen, [true, true, true, true, true], 'both listeners were told about the change, with frozen values');
		assert.deepStrictEqual(conf.get('nested'), {count: 2});
		assert.deepStrictEqual({...conf.store}, {nested: {count: 2}});
	});

	it('keeps a key named `__proto__` that the file holds', () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true}));

		// A key a JSON file can hold and that a store writes back out, so a copy of the store has to keep it as a key of its own rather than as the prototype of the copy.
		conf.set('nested', JSON.parse('{"__proto__": {"x": 1}, "y": 2}'));
		conf.set('listed', [JSON.parse('{"__proto__": {"x": 1}, "y": 2}')]);

		assert.deepStrictEqual(Object.getOwnPropertyNames(conf.get('nested')), ['__proto__', 'y']);
		assert.deepStrictEqual(Object.getOwnPropertyNames((conf.get('listed') as unknown[])[0]), ['__proto__', 'y']);

		// A whole-store write of what a read hands back writes what the file holds. The expected value is parsed rather than written as a literal, since `__proto__` in a literal is the prototype of the object and not a key of it.
		const readBack = conf.store;
		conf.store = readBack;
		assert.deepStrictEqual(readConfigFile(conf.path), JSON.parse('{"nested": {"__proto__": {"x": 1}, "y": 2}, "listed": [{"__proto__": {"x": 1}, "y": 2}]}'));
	});

	it('never writes changes made to the objects it returns', () => {
		// The same promise without the cache, where a read parses the file and so hands back a value of its own.
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: false}));
		conf.set('nested', {count: 1});

		const nested = conf.get('nested') as {count: number};
		nested.count = 2;
		assert.deepStrictEqual(conf.get('nested'), {count: 1});

		conf.set('other', 'value');
		assert.deepStrictEqual(readConfigFile(conf.path), {nested: {count: 1}, other: 'value'});
	});

	it('deserializes once for many reads', () => {
		let deserializeCallCount = 0;

		const conf = new Conf({
			cwd: createTempDirectory(),
			cache: true,
			serialize: (value: unknown): string => `foo=${(value as {foo: string}).foo}`,
			deserialize(value: string): Record<string, unknown> {
				deserializeCallCount++;
				return {foo: value.slice('foo='.length)};
			},
		});

		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');
		assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), 'foo=bar');

		const callsBeforeRepeatedReads = deserializeCallCount;
		assert.ok(callsBeforeRepeatedReads > 0);

		for (let index = 0; index < 10; index++) {
			assert.strictEqual(conf.get('foo'), 'bar');
		}

		assert.strictEqual(deserializeCallCount, callsBeforeRepeatedReads);
	});

	it('is not poisoned by a serialization failure', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		// `JSON.stringify()` cannot serialize a BigInt, so this write fails after the value was accepted.
		assert.throws(() => {
			conf.set('foo', 1n);
		}, {name: 'TypeError'});

		assert.strictEqual(conf.get('foo'), 'bar');
		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'bar'});
	});

	it('caches an empty store when the config file is invalid', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '🦄');

		const conf = trackConf(new Conf({cwd, cache: true, clearInvalidConfig: true}));
		assert.strictEqual(conf.size, 0);
		assert.strictEqual(conf.get('foo'), undefined);

		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');
	});

	it('caches decrypted data', () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true, encryptionKey: 'secret-key'}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		const writer = trackConf(new Conf({cwd, encryptionKey: 'secret-key'}));
		writer.set('foo', 'changed');

		assert.strictEqual(conf.get('foo'), 'bar');
	});

	it('applies schema defaults when the file is already migrated', () => {
		// The file is already at the project version, so no migration step runs.
		const {conf} = createMigrationTest({
			cache: true,
			projectVersion: '1.0.0',
			initialData: {__internal__: {migrations: {version: '1.0.0'}}},
			migrations: {
				'1.0.0'(store) {
					store.set('migrated', true);
				},
			},
			schema: {foo: {type: 'number', default: 42}},
		});

		assert.strictEqual(conf.get('foo'), 42);
		assert.ok(conf.has('foo'));
	});

	it('applies schema type coercion when the file is already migrated', () => {
		// The file is already at the project version, so no migration step runs.
		const {conf} = createMigrationTest({
			cache: true,
			projectVersion: '1.0.0',
			initialData: {__internal__: {migrations: {version: '1.0.0'}}, port: '8080'},
			migrations: {
				'1.0.0'(store) {
					store.set('migrated', true);
				},
			},
			schema: {port: {type: 'number'}},
			ajvOptions: {coerceTypes: true},
		});

		assert.strictEqual(conf.get('port'), 8080);
		assert.strictEqual(typeof conf.get('port'), 'number');
	});

	it('sees the result of a migration that ran', () => {
		const {conf, configPath} = createMigrationTest({
			cache: true,
			projectVersion: '1.0.0',
			initialData: {__internal__: {migrations: {version: '0.0.0'}}, legacy: 'value'},
			migrations: {
				'1.0.0'(store) {
					store.set('renamed', store.get('legacy'));
					store.delete('legacy');
				},
			},
		});

		assert.strictEqual(conf.get('renamed'), 'value');
		assert.strictEqual(conf.get('legacy'), undefined);

		// The internal key stays out of `size` and iteration even when the store is cached.
		assert.strictEqual(conf.size, 1);
		assert.deepStrictEqual([...conf], [['renamed', 'value']]);

		const persisted = readConfigFile(configPath);
		assert.strictEqual(persisted.renamed, 'value');
		assert.strictEqual(persisted.legacy, undefined);
		assert.deepStrictEqual(persisted.__internal__, {migrations: {version: '1.0.0'}});
	});

	it('sees its own writes during a migration', () => {
		const observed: unknown[] = [];

		const {conf} = createMigrationTest({
			cache: true,
			projectVersion: '1.0.0',
			initialData: {__internal__: {migrations: {version: '0.0.0'}}},
			migrations: {
				'1.0.0'(store) {
					store.set('step', 'first');
					observed.push(store.get('step'));
					store.set('step', 'second');
					observed.push(store.get('step'));
				},
			},
		});

		assert.deepStrictEqual(observed, ['first', 'second']);
		assert.strictEqual(conf.get('step'), 'second');
	});

	it('leaves no cached data behind when a migration fails', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		createExistingConfig(path.dirname(configPath), {__internal__: {migrations: {version: '0.0.0'}}, stable: 'value'});

		assert.throws(() => {
			createMigrationTest({
				cache: true,
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('partial', true);
						throw new Error('Intentional failure');
					},
				},
			});
		}, {message: /Something went wrong during the migration/});

		// The rollback is written to the file and the cache is dropped, so a new instance reads the rolled-back store.
		const recovered = trackConf(new Conf({cwd, cache: true}));
		assert.strictEqual(recovered.get('stable'), 'value');
		assert.strictEqual(recovered.get('partial'), undefined);
	});

	it('is not poisoned by a schema violation', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			cache: true,
			schema: {
				foo: {type: 'string'},
			},
		});
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		assert.throws(() => {
			conf.set('foo', 42);
		}, {message: 'Config schema violation: `foo` must be string'});

		assert.strictEqual(conf.get('foo'), 'bar');
		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'bar'});
	});

	it('is not poisoned by a failed multi-item set', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		assert.throws(() => {
			conf.set({foo: 'changed', invalid: undefined});
		}, {message: 'Setting a value of type `undefined` for key `invalid` is not allowed as it\'s not supported by JSON'});

		assert.strictEqual(conf.get('foo'), 'bar');
		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'bar'});
	});

	it('does not leak the internal key to the object it was given when an assignment fails', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			cache: true,
			projectVersion: '1.0.0',
			schema: {a: {type: 'number', default: 1}},
			migrations: {
				'1.0.0'() {
					// Only here so the config has an internal key.
				},
			},
		});

		// The setter does not add the internal key to the object it was given, which with a cache would be the cached store itself, and so on every read surface. A refused write leaves what the file holds exactly as it was.
		const handedBack = {...conf.store, a: 'not-a-number'};

		assert.throws(() => {
			conf.store = handedBack;
		}, {message: 'Config schema violation: `a` must be number'});

		assert.deepStrictEqual(Object.keys(conf.store), ['a']);
		assert.strictEqual(conf.size, 1);
		assert.deepStrictEqual([...conf], [['a', 1]], 'the store reports what the file holds, not what the caller did to its copy');
	});

	it('does not write the defaults of the schema into the object it was given', () => {
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			schema: {
				a: {type: 'number'},
				b: {type: 'string', default: 'default'},
			},
		});

		// The validator writes the defaults it applies into the store it is given, which must not be the object the caller passed.
		const store = {a: 1};
		conf.store = store;

		assert.deepStrictEqual(store, {a: 1});
		assert.deepStrictEqual(conf.store, createNullProtoObject({a: 1, b: 'default'}));
	});

	it('does not take the keys the additional properties rules cover out of the object it was given', () => {
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			schema: {
				a: {type: 'number'},
			},
			rootSchema: {additionalProperties: false},
			ajvOptions: {removeAdditional: true},
		});

		// A key the rules cover is taken out of the store the validator is given, which must not be the caller's object.
		const store = {a: 1, extra: true};
		conf.store = store;

		assert.deepStrictEqual(store, {a: 1, extra: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({a: 1}));
	});
});

describe('a cached store and the file', () => {
	it('sees external changes when cache is off, stale when on', () => {
		const cwd = createTempDirectory();
		const cached = new Conf({cwd, cache: true});
		cached.set('v', 'one');
		// Populate the cache before the external write.
		assert.strictEqual(cached.get('v'), 'one');
		fs.writeFileSync(cached.path, JSON.stringify({v: 'external'}));
		assert.strictEqual(cached.get('v'), 'one');
		const uncached = new Conf({cwd: createTempDirectory(), cache: false});
		uncached.set('v', 'one');
		fs.writeFileSync(uncached.path, JSON.stringify({v: 'external'}));
		assert.strictEqual(uncached.get('v'), 'external');
	});

	it('a write drops the cache and merges external keys', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, cache: true});
		conf.set('a', 1);
		fs.writeFileSync(conf.path, JSON.stringify({a: 1, external: true}));
		conf.set('b', 2);
		assert.strictEqual(conf.get('external'), true);
		assert.strictEqual(conf.get('b'), 2);
	});

	it('delete and clear drop the cache', () => {
		const conf = new Conf({cwd: createTempDirectory(), cache: true});
		conf.set('a', 1);
		conf.set('b', 2);
		conf.delete('a');
		assert.strictEqual(conf.get('a'), undefined);
		conf.clear();
		assert.strictEqual(conf.size, 0);
	});

	it('caches do not leak between instances', () => {
		const cwd = createTempDirectory();
		const first = new Conf({cwd, cache: true});
		first.set('only-first', 1);
		// The first store fills its cache before the second one is made, so a cache the two shared would already hold the key.
		assert.strictEqual(first.get('only-first'), 1);
		const second = new Conf({cwd: createTempDirectory(), cache: true});
		assert.strictEqual(second.get('only-first'), undefined);
		assert.deepStrictEqual({...second.store}, {});
	});

	it('counts one deserialize for many cached reads', () => {
		let calls = 0;
		const conf = new Conf({
			cwd: createTempDirectory(),
			cache: true,
			deserialize(text) {
				calls++;
				return JSON.parse(text) as Record<string, unknown>;
			},
		});
		conf.set('a', 1);
		// Warm the cache with a first read, then repeated reads are free.
		assert.strictEqual(conf.get('a'), 1);
		const before = calls;
		assert.ok(before > 0);
		for (let index = 0; index < 5; index++) {
			conf.get('a');
		}

		assert.strictEqual(calls, before);
	});
});

describe('a cached store with other options', () => {
	it('returns stale data after the file is deleted when cached', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, cache: true});
		conf.set('a', 1);
		assert.strictEqual(conf.get('a'), 1);
		fs.rmSync(conf.path, {force: true});
		assert.strictEqual(conf.get('a'), 1);
		assert.strictEqual(conf.size, 1);
	});

	it('sees the deletion when not cached', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		conf.set('a', 1);
		fs.rmSync(conf.path, {force: true});
		assert.strictEqual(conf.get('a'), undefined);
		assert.strictEqual(conf.size, 0);
	});

	it('works with encryption', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, cache: true, encryptionKey: 'secret'});
		conf.set('s', 'value');
		assert.strictEqual(conf.get('s'), 'value');
		conf.set('t', 'other');
		assert.strictEqual(conf.get('s'), 'value');
		assert.strictEqual(conf.get('t'), 'other');
	});

	it('works with schema defaults', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			cache: true,
			schema: {theme: {type: 'string', default: 'light'}},
		});
		assert.strictEqual(conf.get('theme'), 'light');
		conf.set('theme', 'dark');
		assert.strictEqual(conf.get('theme'), 'dark');
	});

	it('drop the cache on store assignment', () => {
		const conf = new Conf({cwd: createTempDirectory(), cache: true});
		conf.set('a', 1);
		assert.strictEqual(conf.get('a'), 1);
		conf.store = {b: 2};
		assert.strictEqual(conf.get('a'), undefined);
		assert.strictEqual(conf.get('b'), 2);
	});
});

describe('a cached read', () => {
	for (const array of [false, true]) {
		it(`freezes descendants of a shallow-frozen ${array ? 'array' : 'object'}`, () => {
			const cwd = createTempDirectory();
			const nested = {value: 1};
			const parent = array ? [nested] : {nested};
			createExistingConfig(cwd, {parent});
			const conf = new Conf<Record<string, unknown>>({
				cwd,
				cache: true,
				deserialize(text) {
					const store = JSON.parse(text) as {parent: Record<string, unknown> | unknown[]};
					Object.freeze(store.parent);
					return store;
				},
			});
			const key = array ? 'parent.0' : 'parent.nested';
			const descendant = conf.get(key) as {value: number};

			assert.throws(() => {
				descendant.value = 9;
			}, TypeError);
			assert.equal(conf.get(`${key}.value`), 1);
			assert.deepStrictEqual(readConfigFile(conf), {parent});
		});
	}

	it('freezes the plain objects of the store and not a value a `deserialize` revived', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {event: {when: new Date(0)}});
		const conf = new Conf<Record<string, any>>({cwd, cache: true, ...dateReviving});

		assert.strictEqual(Object.isFrozen(conf.get('event')), true);
		assert.strictEqual(Object.isFrozen(conf.get('event.when')), false);
	});

	it('reads one key without touching the rest of the store once the cache is filled', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{}');

		let touches = 0;
		const watched = new Proxy({nested: true}, {
			ownKeys(target) {
				touches++;
				return Reflect.ownKeys(target);
			},
			getPrototypeOf(target) {
				touches++;
				return Reflect.getPrototypeOf(target);
			},
		});

		const conf = new Conf<Record<string, unknown>>({
			cwd,
			cache: true,
			deserialize: () => ({a: {value: 1}, b: watched}),
		});

		// The cache is frozen once, when it is filled, and not on every read.
		conf.get('a');
		touches = 0;
		for (let index = 0; index < 10; index++) {
			assert.deepEqual(conf.get('a'), {value: 1});
			assert.ok(conf.has('a'));
			assert.equal(conf.size, 2);
		}

		assert.equal(touches, 0);
	});

	it('reads a store that reaches itself', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{}');

		const node: Record<string, unknown> = {name: 'node'};
		node.left = node;
		node.right = node;

		const conf = new Conf<Record<string, unknown>>({
			cwd,
			cache: true,
			deserialize: () => ({node}),
		});

		const read = conf.get('node') as Record<string, unknown>;
		assert.ok(Object.isFrozen(read));
		assert.equal(read.left, read);
		assert.equal(read.right, read);
		assert.equal(conf.get('node.left.right.name'), 'node');
	});

	it('hands out the same object in two places as one frozen object', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{}');

		const shared = {value: 1};
		const conf = new Conf<Record<string, unknown>>({
			cwd,
			cache: true,
			deserialize: () => ({first: shared, second: shared}),
		});

		const {store} = conf;
		assert.ok(Object.isFrozen(store.first));
		assert.equal(store.first, store.second);
	});

	it('hands out the frozen cache from the iterator', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), cache: true});
		conf.set('list', [1, 2]);

		for (const [, value] of conf) {
			assert.throws(() => {
				(value as number[]).push(3);
			}, TypeError);
		}

		assert.deepEqual(conf.get('list'), [1, 2]);
	});

	it('keeps a hole a `deserialize` left in an array, so opening the store again writes nothing', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '{}');

		let writes = 0;
		const options = {
			cwd,
			cache: true,
			// eslint-disable-next-line no-sparse-arrays
			deserialize: () => ({list: [1, , 3]}),
			serialize(value: unknown) {
				writes++;
				return JSON.stringify(value);
			},
		};

		const conf = new Conf<Record<string, unknown>>(options);
		assert.equal(writes, 0);
		assert.equal(1 in (conf.get('list') as unknown[]), false);
	});
});
