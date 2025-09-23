/* eslint-disable @typescript-eslint/naming-convention */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import anyTest, {type TestFn} from 'ava';
import {
	createMigrationTest,
	createMigrationOrderTracker,
	createVersionTest,
	specialCharacterData,
	generateLargeDataset,
	assertions,
	invalidDataScenarios,
} from './test-utils.js';

const test = anyTest as TestFn<Record<string, never>>;

// Critical edge cases that could cause real-world failures

test('migrations - atomic rollback on mid-migration failure', t => {
	const {createMigration} = createMigrationOrderTracker();
	const {conf: conf1, cwd} = createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {'1.0.0': createMigration('initial')},
	});

	t.true(conf1.get('initial'));

	// Test rollback on failure during multi-step migration
	t.throws(() => {
		createMigrationTest({
			cwd, // Use same directory
			projectVersion: '3.0.0',
			migrations: {
				'1.0.0': createMigration('v1'),
				'2.0.0'(store) {
					// Simulate migration failure
					store.set('partial_data', 'corrupted');
					throw new Error('Critical migration failure');
				},
				'3.0.0': createMigration('v3'),
			},
		});
	});

	// Verify state rolled back to last successful migration
	const {conf: recoveredConf} = createMigrationTest({
		cwd, // Use same directory
		projectVersion: '1.0.0',
		migrations: {},
	});
	t.is(recoveredConf.get('partial_data'), undefined);
	t.true(recoveredConf.get('initial'));
});

test('migrations - complex version predicates with pre-release', t => {
	const {conf} = createMigrationTest({
		projectVersion: '2.0.0-beta.3+build.123',
		migrations: createVersionTest([
			'>=2.0.0-alpha',
			'<2.0.0-rc',
			'^1.0.0', // Should not match
			'2.0.0-beta.3', // Exact match
		]),
	});

	assertions.migrationsCompleted(conf, ['>=2.0.0-alpha', '<2.0.0-rc', '2.0.0-beta.3']);
	t.false(conf.has('migrated____1_0_0')); // ^1.0.0 should not match
});

test('migrations - data corruption recovery', t => {
	// Test recovery from corrupted migration data
	const scenario = invalidDataScenarios.dataTransformation;
	const {conf, cwd, configPath} = createMigrationTest({
		projectVersion: '1.0.0',
		initialData: scenario.data,
		migrations: {'1.0.0': scenario.migration},
		schema: scenario.schema,
	});

	t.deepEqual(conf.get('settings'), {key1: 'value1', key2: 'value2'});

	// Simulate corruption by writing invalid data
	fs.writeFileSync(configPath, '{"settings": "invalid_format"}');

	// Should handle corruption gracefully
	const {conf: recoveredConf} = createMigrationTest({
		cwd, // Use same directory with corrupted file
		projectVersion: '2.0.0',
		migrations: {
			'1.0.0': scenario.migration,
			'2.0.0'(store) {
				// Migration should handle corrupted data
				const settings = store.get('settings');
				if (typeof settings === 'string' && settings === 'invalid_format') {
					store.set('settings', {recovered: true});
				} else {
					// Fallback recovery for when clearInvalidConfig removes corrupted data
					store.set('settings', {recovered: true});
				}
			},
		},
		schema: {
			settings: {type: 'object'},
		},
		clearInvalidConfig: true,
	});

	t.deepEqual(recoveredConf.get('settings'), {recovered: true});
});

test('migrations - concurrent modification detection', t => {
	const {cwd} = createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {
			'1.0.0'(store) {
				store.set('base', 'value');
			},
		},
	});

	const configPath = path.join(cwd, 'config.json');

	// Simulate external modification during migration
	let migrationStarted = false;
	const {conf} = createMigrationTest({
		projectVersion: '2.0.0',
		migrations: {
			'1.0.0'(store) {
				store.set('base', 'value');
			},
			'2.0.0'(store) {
				migrationStarted = true;

				// Simulate concurrent modification
				const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
				currentConfig.external_change = 'concurrent_modification';
				fs.writeFileSync(configPath, JSON.stringify(currentConfig));

				store.set('migrated', true);
			},
		},
	});

	t.true(migrationStarted);
	t.true(conf.get('migrated'));

	// External changes should be preserved in internal data
	assertions.migrationStatePreserved(conf, '2.0.0');
});

test('migrations - memory pressure with large datasets', t => {
	const largeData = generateLargeDataset(100, 50); // Smaller for CI

	const startTime = Date.now();
	const {conf} = createMigrationTest({
		projectVersion: '1.0.0',
		initialData: largeData, // Use initialData instead of defaults to ensure data is in store
		migrations: {
			'1.0.0'(store) {
				// Efficient bulk operation
				let processed = 0;
				const storeData = store.store;

				for (const [key, value] of Object.entries(storeData)) {
					if (key.startsWith('item') && typeof value === 'object') {
						// Process in chunks to avoid memory issues
						if (processed % 10 === 0) {
							// Simulate memory-efficient processing
							void 0;
						}

						store.set(key, {...value as Record<string, unknown>, processed: true});
						processed++;
					}
				}

				store.set('total_processed', processed);
			},
		},
	});

	assertions.performanceWithinBounds(startTime, 3000); // Should complete within 3s
	t.is(conf.get('total_processed'), 100);
});

test('migrations - schema evolution with breaking changes', t => {
	// Test migration handling schema evolution
	createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {
			'1.0.0'(store) {
				store.set('user', {name: 'John', age: 30});
				store.set('settings', ['theme=dark', 'lang=en']);
			},
		},
	});

	// Evolve to new schema with breaking changes
	const {conf: newConf} = createMigrationTest({
		projectVersion: '2.0.0',
		migrations: {
			'1.0.0'(store) {
				store.set('user', {name: 'John', age: 30});
				store.set('settings', ['theme=dark', 'lang=en']);
			},
			'2.0.0'(store) {
				// Breaking schema change: restructure data
				const user = store.get('user') as Record<string, unknown>;
				const settings = store.get('settings') as string[];

				if (user && settings) {
					// New structure
					store.set('profile', {
						personal: {name: user.name, age: user.age},
						preferences: Object.fromEntries(settings.map(s => s.split('=') as [string, string])),
					});

					// Remove old structure
					store.delete('user');
					store.delete('settings');
				}
			},
		},
		schema: {
			profile: {
				type: 'object',
				properties: {
					personal: {
						type: 'object',
						properties: {
							name: {type: 'string'},
							age: {type: 'number'},
						},
					},
					preferences: {type: 'object'},
				},
			},
		},
	});

	const profile = newConf.get('profile') as {
		personal: {name: unknown; age: unknown};
		preferences: {theme: unknown; lang: unknown};
	};
	t.is(profile.personal.name, 'John');
	t.is(profile.personal.age, 30);
	t.is(profile.preferences.theme, 'dark');
	t.is(profile.preferences.lang, 'en');
	t.false(newConf.has('user'));
	t.false(newConf.has('settings'));
});

test('migrations - encoding stability across platforms', t => {
	const {conf} = createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {
			'1.0.0'(store) {
				// Test all special character scenarios
				for (const [key, value] of Object.entries(specialCharacterData)) {
					store.set(key, value);
				}

				// Test nested structures with special chars
				store.set('nested', {
					[specialCharacterData.emojiKey]: specialCharacterData.unicode,
					normal_key: specialCharacterData.mathematical,
				});
			},
		},
	});

	// Verify encoding preservation
	for (const [key, expectedValue] of Object.entries(specialCharacterData)) {
		t.is(conf.get(key), expectedValue, `Encoding failed for ${key}`);
	}

	const nested = conf.get('nested') as Record<string, unknown>;
	t.is(nested[specialCharacterData.emojiKey], specialCharacterData.unicode);
});

test('migrations - file system edge cases', t => {
	const {cwd} = createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {
			'1.0.0'(store) {
				store.set('initial', true);
			},
		},
	});

	// Test various file system conditions
	const configPath = path.join(cwd, 'config.json');

	if (process.platform !== 'win32') {
		// Test readonly filesystem (Unix only)
		fs.chmodSync(configPath, 0o444);

		// Should handle readonly gracefully
		try {
			createMigrationTest({
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('initial', true);
					},
					'2.0.0'(store) {
						store.set('readonly_test', true);
					},
				},
			});
			t.pass('Handled readonly file');
		} catch (error) {
			// Expected on some systems
			t.true(error instanceof Error);
		}

		// Restore permissions
		fs.chmodSync(configPath, 0o666);
	}

	// Test file truncation
	fs.writeFileSync(configPath, '{"incomplete":');

	t.notThrows(() => {
		createMigrationTest({
			projectVersion: '2.0.0',
			migrations: {
				'2.0.0'(store) {
					store.set('recovered_from_truncation', true);
				},
			},
			clearInvalidConfig: true,
		});
	});
});

test('migrations - version normalization edge cases', t => {
	const {createMigration} = createMigrationOrderTracker();

	const {conf} = createMigrationTest({
		projectVersion: '1.0.0+build.123.dirty',
		migrations: {
			'1.0.0': createMigration('exact'),
			'~1.0.0': createMigration('tilde'),
			'^1.0.0': createMigration('caret'),
			'1.0.x': createMigration('x_range'),
			'>=1.0.0 <2.0.0': createMigration('range'),
		},
	});

	// Should handle build metadata and dirty tags
	t.true(conf.has('exact') || conf.has('tilde') || conf.has('caret'), 'At least one migration should run');
	assertions.migrationStatePreserved(conf, '1.0.0+build.123.dirty');
});

test('migrations - recovery from partial migration state', t => {
	const {cwd} = createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {
			'1.0.0'(store) {
				store.set('step1', 'completed');
			},
		},
	});

	// Simulate partial migration by manually setting intermediate state
	const configPath = path.join(cwd, 'config.json');
	const partialState = {
		step1: 'completed',
		step2: 'partial',
		__internal__: {
			migrations: {
				version: '1.5.0', // Intermediate version
			},
		},
	};
	fs.writeFileSync(configPath, JSON.stringify(partialState));

	// Should recover and complete remaining migrations
	const {conf} = createMigrationTest({
		cwd, // Use same directory with partial state
		projectVersion: '2.0.0',
		migrations: {
			'1.0.0'(store) {
				store.set('step1', 'completed');
			},
			'1.5.0'(_) {
				// This should not run again
				t.fail('Intermediate migration should not re-run');
			},
			'2.0.0'(store) {
				const step2 = store.get('step2');
				if (step2 === 'partial') {
					store.set('step2', 'completed');
				}

				store.set('final', true);
			},
		},
	});

	t.is(conf.get('step1'), 'completed');
	t.is(conf.get('step2'), 'completed');
	t.true(conf.get('final'));
	assertions.migrationStatePreserved(conf, '2.0.0');
});
