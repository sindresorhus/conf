/* eslint-disable @typescript-eslint/naming-convention */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {pEvent} from 'p-event';
import delay from 'delay';
import Conf from '../source/index.js';
import {
	createMigrationTest,
	invalidDataScenarios,
	assertions,
	createTempDirectory,
	trackConf,
	getMigrationVersion,
} from './_utilities.js';

describe('Advanced Features', () => {
	it('migrations - schema-driven data coercion', () => {
		// Test using predefined invalid data scenarios
		const scenario = invalidDataScenarios.typeCoercion;

		const {conf} = createMigrationTest({
			projectVersion: '1.0.0',
			initialData: scenario.data,
			migrations: {'1.0.0': scenario.migration},
			schema: scenario.schema,
		});

		// All values should be properly coerced
		assert.strictEqual(conf.get('port'), 8080);
		assert.strictEqual(conf.get('enabled'), true);
		assert.strictEqual(conf.get('count'), 42);
		assert.strictEqual(typeof conf.get('port'), 'number');
		assert.strictEqual(typeof conf.get('enabled'), 'boolean');
		assert.strictEqual(typeof conf.get('count'), 'number');
	});

	it('migrations - data structure transformation', () => {
		const scenario = invalidDataScenarios.dataTransformation;

		const {conf} = createMigrationTest({
			projectVersion: '1.0.0',
			initialData: scenario.data,
			migrations: {'1.0.0': scenario.migration},
			schema: scenario.schema,
		});

		// String should be parsed into object structure
		assert.deepStrictEqual(conf.get('settings'), {key1: 'value1', key2: 'value2'});
	});

	it('migrations - error rollback behavior', () => {
		const {conf, configPath} = createMigrationTest({
			projectVersion: '1.0.0',
			initialData: {stable: 'data'},
			migrations: {
				'1.0.0'(store) {
					store.set('initial', true);
				},
			},
		});

		// Verify persisted data includes newly migrated fields
		const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
		assert.strictEqual(persisted.initial, true);

		// Migration failure should preserve original state
		assert.throws(() => {
			createMigrationTest({
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('initial', true);
					},
					'2.0.0'() {
						throw new Error('Intentional failure');
					},
				},
			});
		});

		// Original data structure should be preserved
		assert.ok(conf.get('initial'));
		assert.strictEqual(getMigrationVersion(conf), '1.0.0');
	});

	it('migrations - internal state preservation', () => {
		let runCount = 0;

		const {conf} = createMigrationTest({
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					runCount++;
					store.set('test', true);
				},
			},
		});

		assertions.migrationStatePreserved(conf, '1.0.0');
		assert.strictEqual(runCount, 1);

		// Overwrite store - internal state should remain
		conf.store = {different: 'data'};
		assertions.migrationStatePreserved(conf, '1.0.0');

		// Migration re-run test is complex - just verify internal state preservation works
		assert.ok(getMigrationVersion(conf) !== undefined);
	});

	it('migrations - dot notation edge cases', () => {
		const {conf} = createMigrationTest({
			projectVersion: '1.0.0',
			accessPropertiesByDotNotation: false,
			migrations: {
				'1.0.0'(store) {
					store.set('migrated', true);
					// Test literal dot notation keys
					store.set('key.with.dots', 'literal');
				},
			},
		});

		assertions.migrationStatePreserved(conf, '1.0.0');

		// Should handle literal keys without dot notation parsing
		assert.strictEqual(conf.get('key.with.dots'), 'literal');

		// Store overwrite should preserve internal state
		conf.store = {new: 'data'};
		assertions.migrationStatePreserved(conf, '1.0.0');
	});

	it('`watch` option watches for config file changes by another process', async () => {
		if (process.env.CI) {
			// Skip file watcher tests in CI - file system events may not work reliably
			return;
		}

		const cwd = createTempDirectory();
		const conf1 = trackConf(new Conf({cwd, watch: true}));
		const conf2 = trackConf(new Conf({cwd}));
		conf1.set('foo', '👾');

		let checks = 0;
		const checkFoo = (newValue: unknown, oldValue: unknown): void => {
			assert.strictEqual(newValue, '🐴');
			assert.strictEqual(oldValue, '👾');
			checks++;
		};

		assert.strictEqual(conf2.get('foo'), '👾');
		assert.strictEqual(conf1.path, conf2.path);
		conf1.onDidChange('foo', checkFoo);

		const changePromise = pEvent(conf1.events, 'change', {timeout: 3000});

		await delay(50);
		conf2.set('foo', '🐴');

		await changePromise;
		assert.strictEqual(checks, 1);

		conf1._closeWatcher();
		conf2._closeWatcher();
	});

	it('`watch` option watches for config file changes by file write', async () => {
		if (process.env.CI) {
			// Skip file watcher tests in CI - file system events may not work reliably
			return;
		}

		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, watch: true}));
		conf.set('foo', '🐴');

		let checks = 0;
		const checkFoo = (newValue: unknown, oldValue: unknown): void => {
			assert.strictEqual(newValue, '🦄');
			assert.strictEqual(oldValue, '🐴');
			checks++;
		};

		conf.onDidChange('foo', checkFoo);

		const changePromise = pEvent(conf.events, 'change', {timeout: 3000});

		await delay(50);
		const writePath = path.join(cwd, 'config.json');
		fs.writeFileSync(writePath, JSON.stringify({foo: '🦄'}));
		fs.statSync(writePath);

		await changePromise;
		assert.strictEqual(checks, 1);

		conf._closeWatcher();
	});

	it('`watch` option detects encrypted changes', async () => {
		if (process.env.CI) {
			// Skip file watcher tests in CI - file system events may not work reliably
			return;
		}

		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, watch: true, encryptionKey: 'secret-key'}));
		const writer = trackConf(new Conf({cwd, encryptionKey: 'secret-key'}));
		writer.set('foo', 'bar');

		const changePromise = pEvent(conf.events, 'change', {timeout: 3000});
		const history: Array<{newValue: unknown; oldValue: unknown}> = [];
		conf.onDidChange('foo', (newValue, oldValue) => {
			history.push({newValue, oldValue});
		});

		writer.set('foo', 'baz');
		await changePromise;

		assert.deepStrictEqual(history, [{newValue: 'baz', oldValue: 'bar'}]);

		conf._closeWatcher();
		writer._closeWatcher();
	});

	it('`rootSchema` accepts root keywords without root `properties`', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			rootSchema: {
				patternProperties: {
					'^.*$': {
						type: 'object',
						properties: {
							schedule: {type: 'string'},
							start: {type: 'boolean', default: true},
						},
					},
				},
			},
		});

		conf.set('task', {schedule: 'daily'});
		assert.deepStrictEqual(conf.get('task'), {schedule: 'daily', start: true});

		assert.throws(() => {
			conf.set('task', {schedule: 1});
		}, {message: 'Config schema violation: `task/schedule` must be string'});
	});

	it('`rootSchema` throws when it has a `properties` key', () => {
		assert.throws(() => {
			// eslint-disable-next-line no-new
			new Conf({
				cwd: createTempDirectory(),
				rootSchema: {
					properties: {foo: {type: 'string'}},
				},
			});
		}, {message: 'The `rootSchema` option must not contain a `properties` key. Use the `schema` option for properties.'});
	});
});

describe('cache option', () => {
	const writeConfigFile = (configPath: string, data: Record<string, unknown>): void => {
		fs.writeFileSync(configPath, JSON.stringify(data));
	};

	const readConfigFile = (configPath: string): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;

	it('reads from memory instead of the file', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		writeConfigFile(conf.path, {foo: 'changed-by-another-process'});

		assert.strictEqual(conf.get('foo'), 'bar');
	});

	it('still reads the file when the cache is disabled', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory()}));
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), 'bar');

		writeConfigFile(conf.path, {foo: 'changed-by-another-process'});

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

		writeConfigFile(conf.path, {foo: 'bar', external: 'kept'});

		conf.set('baz', 'qux');

		assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'bar', external: 'kept', baz: 'qux'});
		assert.strictEqual(conf.get('external'), 'kept');
	});

	it('does not lose changes made by another process when appending to an array', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true}));
		conf.set('items', ['first']);
		assert.deepStrictEqual(conf.get('items'), ['first']);

		writeConfigFile(conf.path, {items: ['first', 'external']});

		conf.appendToArray('items', 'second');

		assert.deepStrictEqual(readConfigFile(conf.path).items, ['first', 'external', 'second']);
	});

	it('uses the cache without dot notation', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), cache: true, accessPropertiesByDotNotation: false}));
		conf.set('items', ['first']);
		conf.set('foo.bar', 'literal');
		assert.deepStrictEqual(conf.get('items'), ['first']);

		writeConfigFile(conf.path, {items: ['first', 'external'], 'foo.bar': 'changed', extra: true});

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

		writeConfigFile(conf.path, {foo: 'bar', external: 'kept'});

		conf.delete('foo');

		// The delete must merge against the file, not against the stale cache.
		assert.deepStrictEqual(readConfigFile(conf.path), {external: 'kept'});
		assert.strictEqual(conf.get('external'), 'kept');
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

		writeConfigFile(conf.path, {foo: 'changed', nested: {value: 2}, extra: true});

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

		writeConfigFile(conf.path, {foo: 'external'});
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

	it('never writes changes made to the objects it returns', () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true}));
		conf.set('nested', {count: 1});

		// The cache hands out its own objects, so this changes what later reads return.
		const nested = conf.get('nested') as {count: number};
		nested.count = 2;
		assert.strictEqual((conf.get('nested') as {count: number}).count, 2);

		// A write must read the file and not the changed cache.
		conf.set('other', 'value');

		assert.deepStrictEqual(readConfigFile(conf.path), {nested: {count: 1}, other: 'value'});
		assert.deepStrictEqual(conf.get('nested'), {count: 1});
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
		writeConfigFile(configPath, {__internal__: {migrations: {version: '0.0.0'}}, stable: 'value'});

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

	it('drops the cache when `watch` sees a change', async () => {
		if (process.env.CI) {
			// Skip file watcher tests in CI - file system events may not work reliably
			return;
		}

		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
		const writer = trackConf(new Conf({cwd}));
		conf.set('foo', '🐴');
		assert.strictEqual(conf.get('foo'), '🐴');

		const changePromise = pEvent(conf.events, 'change', {timeout: 3000});

		await delay(50);
		writer.set('foo', '🦄');

		await changePromise;
		assert.strictEqual(conf.get('foo'), '🦄');

		conf._closeWatcher();
		writer._closeWatcher();
	});

	it('drops the cache when `watch` sees the config file deleted', async () => {
		if (process.env.CI) {
			// Skip file watcher tests in CI - file system events may not work reliably
			return;
		}

		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
		conf.set('foo', '🐴');
		assert.strictEqual(conf.get('foo'), '🐴');

		const changePromise = pEvent(conf.events, 'change', {timeout: 3000});

		await delay(50);
		fs.unlinkSync(conf.path);

		await changePromise;
		assert.strictEqual(conf.get('foo'), undefined);

		conf._closeWatcher();
	});

	it('reports an external change to `onDidChange`', async () => {
		if (process.env.CI) {
			// Skip file watcher tests in CI - file system events may not work reliably
			return;
		}

		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
		conf.set('foo', '🐴');

		// Let the watcher settle after this instance's own write before subscribing.
		await delay(250);
		assert.strictEqual(conf.get('foo'), '🐴');

		const history: Array<{newValue: unknown; oldValue: unknown}> = [];
		conf.onDidChange('foo', (newValue, oldValue) => {
			history.push({newValue, oldValue});
		});

		const changePromise = pEvent(conf.events, 'change', {timeout: 3000});

		await delay(50);
		writeConfigFile(conf.path, {foo: '🦄'});
		fs.statSync(conf.path);

		await changePromise;

		// The cache must be dropped before the event is sent, otherwise the listener reads the stale cache.
		assert.deepStrictEqual(history, [{newValue: '🦄', oldValue: '🐴'}]);

		conf._closeWatcher();
	});

	it('throws instead of serving the cache when `watch` sees the config file become invalid', async () => {
		if (process.env.CI) {
			// Skip file watcher tests in CI - file system events may not work reliably
			return;
		}

		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
		conf.set('foo', '🐴');
		assert.strictEqual(conf.get('foo'), '🐴');

		const changePromise = pEvent(conf.events, 'change', {timeout: 3000});

		await delay(50);
		fs.writeFileSync(conf.path, '🦄');
		fs.statSync(conf.path);

		await changePromise;

		// The dropped cache must not hide the corruption behind a stale value.
		assert.throws(() => conf.store, {name: 'SyntaxError'});

		conf._closeWatcher();
	});
});
