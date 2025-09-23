/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-empty-function, no-new */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {Buffer} from 'node:buffer';
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createMigrationTest,
	createMigrationOrderTracker,
	createVersionTest,
	specialCharacterData,
	generateLargeDataset,
	assertions,
	invalidDataScenarios,
	createTempDirectory,
	getMigrationVersion,
} from './_utilities.js';

describe('Migrations', () => {
	// Edge case tests for migrations
	describe('Edge Cases', () => {
		it('migrations - semver range evaluation', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			const {conf} = createMigrationTest({
				projectVersion: '1.8.0',
				migrations: {
					'>=1.0.0 <2.0.0': createMigration('range1'),
					'>=1.5.0': createMigration('range2'), // Should run
					'1.8.0': createMigration('exact'), // Exact match
					'>2.0.0': createMigration('future'), // Should not run
				},
			});

			// Should run applicable migrations
			assert.deepStrictEqual(tracker, ['range1', 'range2', 'exact']);
			assert.ok(!conf.get('future'));
		});

		it('migrations - execution order', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			const {conf} = createMigrationTest({
				projectVersion: '3.0.0',
				migrations: {
					'1.0.0': createMigration('v1'),
					'1.5.0': createMigration('v1.5'),
					'2.0.0': createMigration('v2'),
					'3.0.0': createMigration('v3'),
				},
			});

			// Should execute all applicable migrations
			assert.deepStrictEqual(tracker, ['v1', 'v1.5', 'v2', 'v3']);
		});

		it('migrations - version skipping behavior', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			// Start with version 1.0.0
			const {cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0': createMigration('v1'),
				},
			});

			assert.deepStrictEqual(tracker, ['v1']);

			// Jump directly to 3.0.0 (skip 2.0.0)
			tracker.length = 0;
			const conf2 = new Conf({
				cwd,
				projectVersion: '3.0.0',
				migrations: {
					'1.0.0': createMigration('v1'), // Won't run again
					'2.0.0': createMigration('v2'), // Should run
					'3.0.0': createMigration('v3'), // Should run
				},
			});

			assert.deepStrictEqual(tracker, ['v2', 'v3']);
		});

		it('migrations - idempotency and state consistency', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			// First migration run
			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0': createMigration('v1'),
					'2.0.0': createMigration('v2'),
				},
			});

			const firstRunTracker = [...tracker];

			// Second run with same version
			tracker.length = 0;
			const conf2 = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0': createMigration('v1'),
					'2.0.0': createMigration('v2'),
				},
			});

			// Should not run migrations again
			assert.deepStrictEqual(tracker, []);
			assert.deepStrictEqual(firstRunTracker, ['v1', 'v2']);
		});

		it('migrations - error handling and hook integration', () => {
			const hooks: Array<{version: string; phase: string}> = [];

			assert.throws(() => {
				createMigrationTest({
					projectVersion: '2.0.0',
					beforeEachMigration(store, context) {
						hooks.push({version: context.toVersion, phase: 'before'});
						if (context.toVersion === '1.5.0') {
							throw new Error('Hook prevented migration');
						}
					},
					migrations: {
						'1.0.0'(store) {
							store.set('v1', true);
						},
						'1.5.0'(store) {
							store.set('v1.5', true); // Should not execute
						},
						'2.0.0'(store) {
							store.set('v2', true); // Should not execute
						},
					},
				});
			}, /Hook prevented migration/);

			// Hook should have been called for first two migrations only
			assert.deepStrictEqual(hooks, [
				{version: '1.0.0', phase: 'before'},
				{version: '1.5.0', phase: 'before'},
			]);
		});

		it('migrations - character encoding preservation', () => {
			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('special', specialCharacterData);
					},
				},
			});

			// Verify special characters survive migration
			const special = conf1.get('special') as typeof specialCharacterData;
			assert.strictEqual(special.unicode, '🦄✨🌈 Unicode test');
			assert.strictEqual(special.mixedScripts, 'Hello 世界 🌍 مرحبا');
			assert.strictEqual(special.rtlText, 'العربية עברית');

			// Load again with new migration
			const conf2 = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'() {},
					'2.0.0'(store) {
						const special = store.get('special') as typeof specialCharacterData;
						store.set('combined', Object.values(special).join(' '));
					},
				},
			});

			// Verify characters still intact after second migration
			assert.ok((conf2.get('combined') as string | undefined)?.includes('🦄✨🌈'));
		});

		it('migrations - should save the project version as the initial migrated version', () => {
			const cwd = createTempDirectory();

			const conf = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'2.0.0'(store) {
						store.set('foo', 'bar');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bar');
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');
		});

		it('migrations - should save the project version when a migration occurs', () => {
			const cwd = createTempDirectory();

			let conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('foo', 'bar');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bar');
			assert.strictEqual(getMigrationVersion(conf), '1.0.0');

			conf = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('foo', 'bar');
					},
					'1.0.1'(store) {
						store.set('foo', 'baz');
					},
					'2.0.0'(store) {
						store.set('foo', 'bazel');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bazel');
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');
		});

		it('migrations - should NOT run the migration when the version does not change', () => {
			const cwd = createTempDirectory();

			let conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('foo', 'bar');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bar');

			conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('foo', 'baz');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bar');
		});

		it('migrations - should cleanup migrations with range conditions', () => {
			const cwd = createTempDirectory();

			let conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'>=1.0.0'(store) {
						store.set('foo', 'bar');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bar');
			assert.strictEqual(getMigrationVersion(conf), '1.0.0');

			conf = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'>=1.0.0 <2.0.0'(store) {
						store.set('foo', 'baz');
					},
					'>=2.0.0'(store) {
						store.set('foo', 'bazel');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bazel');
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');
		});

		it('migrations - should cleanup migrations with non-numeric values', () => {
			const cwd = createTempDirectory();

			let conf = new Conf({
				cwd,
				projectVersion: '1.0.0-alpha',
				migrations: {
					'1.0.0-alpha'(store) {
						store.set('foo', 'bar');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bar');
			assert.strictEqual(getMigrationVersion(conf), '1.0.0-alpha');

			conf = new Conf({
				cwd,
				projectVersion: '1.0.0-beta',
				migrations: {
					'1.0.0-alpha'(store) {
						store.set('foo', 'baz');
					},
					'1.0.0-beta'(store) {
						store.set('foo', 'bazel');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bazel');
			assert.strictEqual(getMigrationVersion(conf), '1.0.0-beta');
		});

		it('migrations - should NOT throw when project version is unspecified and there are no migrations', () => {
			const cwd = createTempDirectory();

			assert.doesNotThrow(() => {
				const conf = new Conf({cwd});
				conf.set('foo', 'bar');
				assert.strictEqual(conf.get('foo'), 'bar');
			});
		});

		it('migrations - should not create migration metadata when migrations are not needed', () => {
			const cwd = createTempDirectory();
			const conf = new Conf({cwd, projectVersion: '1.0.0'});
			assert.ok(!conf.has('__internal__'));
		});

		it('migrations error handling - should rollback changes if a migration failed', () => {
			const cwd = createTempDirectory();

			const conf1 = new Conf({
				cwd,
				projectVersion: '1.0.0',
			});
			conf1.set('foo', 'bar');

			assert.throws(() => {
				new Conf({
					cwd,
					projectVersion: '2.0.0',
					migrations: {
						'1.5.0'(store) {
							store.set('foo', 'baz');
						},
						'2.0.0'() {
							throw new Error('Oops! This migration failed');
						},
					},
				});
			}, /Oops! This migration failed/);

			// Verify that successful migration 1.5.0 was preserved
			// but failed migration 2.0.0 was rolled back
			const conf2 = new Conf({
				cwd,
				projectVersion: '1.0.0',
			});

			assert.strictEqual(conf2.get('foo'), 'baz'); // 1.5.0 succeeded, so its changes persist
			assert.strictEqual(getMigrationVersion(conf2), '1.5.0'); // Version should reflect last successful migration
		});

		it('migrations - should preserve internal data when store is overwritten', () => {
			const cwd = createTempDirectory();

			// Create initial config with migration
			const conf1 = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('test', 'value1');
					},
				},
			});

			assert.strictEqual(getMigrationVersion(conf1), '1.0.0');

			// Overwrite the entire store
			conf1.store = {newData: 'test'} as any;

			// Verify internal data was preserved
			const internal = conf1.get('__internal__') as any;
			assert.strictEqual(internal.migrations.version, '1.0.0');
		});

		it('migrations - should preserve internal data when store is set to empty object', () => {
			const cwd = createTempDirectory();

			const conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('foo', 'bar');
					},
				},
			});

			assert.strictEqual(getMigrationVersion(conf), '1.0.0');

			// Clear the store
			conf.store = {} as any;

			// Verify internal data was preserved
			const internal = conf.get('__internal__') as any;
			assert.strictEqual(internal.migrations.version, '1.0.0');
		});

		it('migrations - should preserve internal data without dot notation access', () => {
			const cwd = createTempDirectory();

			const conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				accessPropertiesByDotNotation: false,
				migrations: {
					'1.0.0'(store) {
						store.set('test', 'value');
					},
				},
			});

			// Set the entire store
			conf.store = {newData: 'test'} as any;

			// Verify internal data was preserved
			const internal2 = conf.get('__internal__') as any;
			assert.strictEqual(internal2.migrations.version, '1.0.0');
		});
	});

	// Critical edge cases that could cause real-world failures
	describe('Critical Edge Cases', () => {
		it('migrations - atomic rollback on mid-migration failure', () => {
			const {createMigration} = createMigrationOrderTracker();
			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {'1.0.0': createMigration('initial')},
			});

			assert.ok(conf1.get('initial'));

			// Test rollback on failure during multi-step migration
			assert.throws(() => {
				new Conf({
					cwd,
					projectVersion: '3.0.0',
					migrations: {
						'1.5.0': createMigration('v1.5'),
						'2.0.0'(store) {
							store.set('beforeError', 'value');
							throw new Error('Critical failure at v2.0.0');
						},
						'3.0.0': createMigration('v3'),
					},
				});
			}, /Critical failure at v2\.0\.0/);

			// Verify partial rollback - successful migrations are kept
			const conf2 = new Conf({cwd, projectVersion: '1.0.0'});
			assert.ok(conf2.has('v1.5')); // 1.5.0 succeeded, should be kept
			assert.ok(!conf2.has('beforeError')); // 2.0.0 failed, should be rolled back
			assert.ok(!conf2.has('v3')); // 3.0.0 never ran
			assert.strictEqual(getMigrationVersion(conf2), '1.5.0'); // Last successful migration
		});

		it('migrations - complex version predicates with pre-release', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			const {conf} = createMigrationTest({
				projectVersion: '2.0.0-beta.3',
				migrations: {
					'1.0.0': createMigration('stable1'),
					'2.0.0-alpha': createMigration('alpha'),
					'2.0.0-beta.1': createMigration('beta1'),
					'2.0.0-beta.2': createMigration('beta2'),
					'2.0.0-beta.3': createMigration('beta3'),
					'2.0.0-rc': createMigration('rc'), // Should not run
					'2.0.0': createMigration('stable2'), // Should not run
				},
			});

			assert.deepStrictEqual(tracker, ['stable1', 'alpha', 'beta1', 'beta2', 'beta3']);
			assert.ok(!conf.get('rc'));
			assert.ok(!conf.get('stable2'));
		});

		it('migrations - data corruption recovery', () => {
			// Test recovery from malformed JSON
			const cwd = createTempDirectory();
			const configPath = path.join(cwd, 'config.json');

			// Write corrupted JSON directly
			fs.writeFileSync(configPath, '{"test": "value", invalid json}');

			// Should handle corrupted data gracefully with clearInvalidConfig
			const conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				clearInvalidConfig: true,
				migrations: {
					'1.0.0'(store) {
						store.set('recovered', true);
					},
				},
			});

			assert.ok(conf.get('recovered'), 'Should recover from corrupted JSON');
		});

		it('migrations - concurrent modification detection', () => {
			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('counter', 0);
					},
				},
			});

			// Simulate concurrent modifications during migration
			const results: number[] = [];
			const instances = Array.from({length: 3}, (_, index) => {
				try {
					const conf = new Conf({
						cwd,
						projectVersion: '2.0.0',
						migrations: {
							'2.0.0'(store) {
								const current = store.get('counter') as number;
								// Simulate processing delay
								const start = Date.now();
								while (Date.now() - start < 10) {/* Delay */}
								store.set('counter', current + 1);
								store.set(`instance${index}`, true);
							},
						},
					});
					results.push(conf.get('counter') as number);
					return conf;
				} catch {
					results.push(-1);
					return null;
				}
			}).filter(Boolean);

			// At least one instance should have succeeded
			assert.ok(instances.length > 0, 'At least one instance should succeed');

			// The successful instance should have consistent state
			const successfulConf = instances[0]!;
			assert.ok(successfulConf.has('counter'));
			assert.strictEqual(getMigrationVersion(successfulConf), '2.0.0');
		});

		it('migrations - memory pressure with large datasets', () => {
			if (process.env.CI) {
				// Skip memory-intensive test in CI
				return;
			}

			const largeData = generateLargeDataset(10_000); // 10k entries

			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('largeData', largeData);
					},
				},
			});

			const memBefore = process.memoryUsage().heapUsed;

			// Migration that processes large dataset
			const conf2 = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'2.0.0'(store) {
						const data = store.get('largeData') as typeof largeData;
						const transformed = Object.fromEntries(Object.entries(data).map(([key, value]) => [
							`new_${key}`,
							{...value, processed: true},
						]));
						store.set('transformedData', transformed);
						store.delete('largeData');
					},
				},
			});

			const memAfter = process.memoryUsage().heapUsed;
			const memIncrease = (memAfter - memBefore) / 1024 / 1024; // MB

			// Memory increase should be reasonable (< 200MB for 10k items)
			// Note: Node.js memory management can vary, especially with large object transformations
			assert.ok(memIncrease < 200, `Memory increase too high: ${memIncrease.toFixed(2)}MB`);

			// Verify transformation completed
			assert.ok(!conf2.has('largeData'));
			assert.ok(conf2.has('transformedData'));
			const transformed = conf2.get('transformedData') as any;
			assert.ok(Object.keys(transformed).every(key => key.startsWith('new_')));
		});

		it('migrations - schema evolution with breaking changes', () => {
			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('user', {
							name: 'John Doe',
							email: 'john@example.com',
							age: 30,
						});
					},
				},
			});

			// Migration with breaking schema changes
			const conf2 = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'2.0.0'(store) {
						const user = store.get('user') as any;
						// Breaking change: split name, change age to birthYear
						const [firstName = '', lastName = ''] = (user.name as string).split(' ');
						store.set('user', {
							firstName,
							lastName,
							email: user.email,
							birthYear: new Date().getFullYear() - (user.age as number),
						});
					},
				},
				schema: {
					user: {
						type: 'object',
						properties: {
							firstName: {type: 'string'},
							lastName: {type: 'string'},
							email: {type: 'string', format: 'email'},
							birthYear: {type: 'integer'},
						},
						required: ['firstName', 'lastName', 'email', 'birthYear'],
					},
				},
			});

			const user = conf2.get('user') as any;
			assert.strictEqual(user.firstName, 'John');
			assert.strictEqual(user.lastName, 'Doe');
			assert.strictEqual(user.email, 'john@example.com');
			assert.strictEqual(user.birthYear, new Date().getFullYear() - 30);
		});

		it('migrations - encoding stability across platforms', () => {
			const binaryData = Buffer.from([0xFF, 0xFE, 0x00, 0x01, 0xDE, 0xAD, 0xBE, 0xEF]);
			const base64Data = binaryData.toString('base64');

			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('binary', base64Data);
						store.set('newlines', 'line1\r\nline2\nline3\r');
						store.set('unicode', '\u0000\uFFFF\uD800\uDC00'); // Null, max BMP, surrogate pair
					},
				},
			});

			// Verify data integrity after migration
			const conf2 = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'2.0.0'(store) {
						const binary = store.get('binary') as string;
						const decoded = Buffer.from(binary, 'base64');
						assert.deepStrictEqual(decoded, binaryData, 'Binary data corrupted');

						const newlines = store.get('newlines');
						assert.ok((newlines as string).includes('\r\n'), 'CRLF lost');
						assert.ok((newlines as string).includes('\n'), 'LF lost');

						store.set('migrated', true);
					},
				},
			});

			assert.ok(conf2.get('migrated'));
		});

		it('migrations - file system edge cases', () => {
			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('test', 'initial');
					},
				},
			});

			const configPath = path.join(cwd, 'config.json');

			// Note: Atomic writes can succeed even on read-only files by writing to temp and renaming
			// So we test that migrations work even with read-only files (which is actually good behavior)
			if (process.platform !== 'win32' && process.getuid?.() !== 0) {
				fs.chmodSync(configPath, 0o444); // Read-only

				// Should NOT throw - atomic writes work around read-only files
				const conf2 = new Conf({
					cwd,
					projectVersion: '2.0.0',
					migrations: {
						'2.0.0'(store) {
							store.set('test', 'modified');
						},
					},
				});

				assert.strictEqual(conf2.get('test'), 'modified', 'Migration should succeed despite read-only file');

				fs.chmodSync(configPath, 0o644); // Restore write permission
			}

			// Test missing directory recovery
			fs.rmSync(cwd, {recursive: true, force: true});

			const conf3 = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'2.0.0'(store) {
						store.set('recovered', true);
					},
				},
			});

			assert.ok(conf3.get('recovered'), 'Should recover from missing directory');
		});

		it('migrations - version normalization edge cases', () => {
			const versions = [
				'1.0.0',
				'1.0.0-alpha',
				'1.0.0-alpha.1',
				'1.0.0-0.3.7',
				'1.0.0-x.7.z.92',
				'1.0.0+20130313144700',
				'1.0.0-beta+exp.sha.5114f85',
			];

			for (const version of versions) {
				const {conf} = createMigrationTest({
					projectVersion: version,
					migrations: {
						[version](store) {
							store.set('version', version);
						},
					},
				});

				assert.strictEqual(conf.get('version'), version);
				assert.strictEqual(getMigrationVersion(conf), version);
			}
		});

		it('migrations - recovery from partial migration state', () => {
			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('step1', true);
					},
				},
			});

			// Simulate partial migration by manually setting version
			const configPath = path.join(cwd, 'config.json');
			const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			data.__internal__ = {migrations: {version: '1.5.0'}}; // Manually set to intermediate version
			fs.writeFileSync(configPath, JSON.stringify(data, null, '\t'));

			// Should recover and continue from partial state
			const conf2 = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('step1_retry', true); // Should not run
					},
					'1.5.0'(store) {
						store.set('step2', true); // Should not run again
					},
					'2.0.0'(store) {
						store.set('step3', true); // Should run
					},
				},
			});

			assert.ok(conf2.get('step1'));
			assert.ok(!conf2.get('step1_retry'));
			assert.ok(!conf2.get('step2')); // Wasn't run initially
			assert.ok(conf2.get('step3'));
			assertions.migrationStatePreserved(conf2, '2.0.0');
		});
	});
});

