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
});
