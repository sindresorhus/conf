/* eslint-disable @typescript-eslint/naming-convention */
import anyTest, {type TestFn} from 'ava';
import {
	createMigrationTest,
	createMigrationOrderTracker,
	specialCharacterData,
	assertions,
} from './test-utils.js';

const test = anyTest as TestFn<Record<string, never>>;

// Edge case tests for migrations
test('migrations - semver range evaluation', t => {
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
	t.deepEqual(tracker, ['range1', 'range2', 'exact']);
	t.false(conf.has('future'), 'Future migrations should not run');
	assertions.migrationsCompleted(conf, ['range1', 'range2', 'exact']);
});

test('migrations - execution order independence', t => {
	const {tracker, createMigration} = createMigrationOrderTracker();

	// Test that migration logic is independent of declaration order
	const {conf} = createMigrationTest({
		projectVersion: '2.1.0',
		migrations: {
			'2.0.0': createMigration('v2'),
			'1.0.0': createMigration('v1'),
			'1.5.0': createMigration('v1_5'),
		},
	});

	// All should complete regardless of order
	assertions.migrationsCompleted(conf, ['v2', 'v1', 'v1_5']);
	t.is(tracker.length, 3);
});

test('migrations - version skipping behavior', t => {
	const {createMigration} = createMigrationOrderTracker();

	// Setup initial state at v1.0.0
	createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {'1.0.0': createMigration('base')},
	});

	// Jump to v3.0.0, should only run intermediate migrations
	const {conf} = createMigrationTest({
		projectVersion: '3.0.0',
		migrations: {
			'1.0.0': createMigration('v1_rerun'), // Should not re-run
			'2.5.0': createMigration('middle'), // Should run
			'4.0.0': createMigration('future'), // Should not run
		},
	});

	// Only middle migration should run
	t.true(conf.has('middle'));
	t.false(conf.has('future'));
	assertions.migrationStatePreserved(conf, '3.0.0');
});

test('migrations - idempotency and state consistency', t => {
	createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {
			'1.0.0'(store) {
				store.set('counter', 1);
				store.set('initialized', true);
			},
		},
	});

	// Multiple instances should have consistent behavior
	const instances = Array.from({length: 3}, () =>
		createMigrationTest({
			projectVersion: '1.1.0',
			migrations: {
				'1.0.0'(store) {
					store.set('counter', 1);
					store.set('initialized', true);
				},
				'1.1.0'(store) {
					// Idempotent operation
					const current = store.get('counter') as number || 0;
					store.set('counter', Math.max(current, 2));
					store.set('v1_1_migrated', true);
				},
			},
		}).conf);

	// All instances should have identical final state
	const finalStates = instances.map(conf => ({
		counter: conf.get('counter'),
		initialized: conf.get('initialized'),
		migrated: conf.get('v1_1_migrated'),
		version: conf.get('__internal__.migrations.version'),
	}));

	const firstState = finalStates[0];
	t.true(finalStates.every(state => JSON.stringify(state) === JSON.stringify(firstState)));
});

test('migrations - error handling and hook integration', t => {
	const hookCalls: string[] = [];

	createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {
			'1.0.0'(store) {
				store.set('base', true);
			},
		},
	});

	// Test hook error propagation
	t.throws(() => {
		createMigrationTest({
			projectVersion: '2.0.0',
			beforeEachMigration(_, context) {
				hookCalls.push(`${context.fromVersion}→${context.toVersion}`);
				if (context.toVersion === '2.0.0') {
					throw new Error('Hook failure');
				}
			},
			migrations: {
				'1.0.0'(store) {
					store.set('base', true);
				},
				'1.5.0'(store) {
					store.set('intermediate', true);
				},
				'2.0.0'(store) {
					store.set('final', true);
				},
			},
		});
	}, {message: /Hook failure/});

	// Should have attempted hook calls before failure
	t.true(hookCalls.length > 0);
});

test('migrations - character encoding preservation', t => {
	const {conf} = createMigrationTest({
		projectVersion: '1.0.0',
		migrations: {
			'1.0.0'(store) {
				// Test comprehensive character encoding
				for (const [key, value] of Object.entries(specialCharacterData)) {
					store.set(key, value);
				}

				// Test nested structures with special characters
				store.set('complex_nested', {
					[specialCharacterData.emojiKey]: {
						nested: specialCharacterData.unicode,
						array: [specialCharacterData.rtlText, specialCharacterData.mathematical],
					},
				});
			},
		},
	});

	// Verify encoding preservation through serialization cycle
	for (const [key, expectedValue] of Object.entries(specialCharacterData)) {
		t.is(conf.get(key), expectedValue, `Character encoding failed for ${key}`);
	}

	const complex = conf.get('complex_nested') as Record<string, any>;
	t.is(complex[specialCharacterData.emojiKey].nested, specialCharacterData.unicode);
});
