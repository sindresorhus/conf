/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-empty-function, no-new -- A step is keyed by its version and often does nothing, a store is often built only for the migrations it runs, and a value read back is `any`. */
import fs from 'node:fs';
import path from 'node:path';
import {Buffer} from 'node:buffer';
import {
	describe,
	it,
	afterEach,
	test,
} from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import Conf, {type Options} from '../source/index.js';
import {
	createMigrationTest,
	createMigrationOrderTracker,
	createTempDirectory,
	createNullProtoObject,
	createExistingConfig,
	getMigrationVersion,
	skipAsRoot,
	readConfigFile,
	runRegisteredCleanups,
	resetTrackedConfs,
	trackConf,
} from './_utilities.js';

type Store = Record<string, any>;

/**
Creates invalid data scenarios for schema testing.
*/
const invalidDataScenarios = {
	dataTransformation: {
		data: {settings: 'key1=value1,key2=value2'},
		schema: {
			settings: {
				type: 'object',
				properties: {
					key1: {type: 'string'},
					key2: {type: 'string'},
				},
			},
		},
		migration(store: Conf) {
			const settings = store.get('settings');

			if (typeof settings === 'string') {
				const parsed: Record<string, string> = {};
				for (const pair of settings.split(',')) {
					const [key, value] = pair.split('=');
					if (key && value) {
						parsed[key] = value;
					}
				}

				store.set('settings', parsed);
			}
		},
	},
} as const;

/**
Test data with special characters for encoding tests.
*/
const specialCharacterData = {
	unicode: '🦄✨🌈 Unicode test',
	emojiKey: '🔑',
	mixedScripts: 'Hello 世界 🌍 مرحبا',
	controlChars: 'before\u0000\u0001\u0002after',
	rtlText: 'العربية עברית',
	mathematical: '∑∞≠≤≥∆π√',
	quotesAndEscapes: '"\'`\\n\\t\\r\\\\',
	zeroWidth: 'invisible\u200B\u200C\u200Dchars',
} as const;

/**
Performance test helper for large data.
*/
function generateLargeDataset(itemCount: number, fieldsPerItem = 10): Record<string, any> {
	const data: Record<string, any> = {};

	for (let index = 0; index < itemCount; index++) {
		data[`item${index}`] = {
			id: index,
			name: `Item ${index}`,
			metadata: Array.from({length: fieldsPerItem}, (_, j) => ({
				key: `field${j}`,
				value: `data-${index}-${j}`,
				timestamp: Date.now() + (index * j),
			})),
		};
	}

	return data;
}

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('Migrations', () => {
	// Edge case tests for migrations
	describe('the order of the steps, the recorded version and the reserved key', () => {
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

		it('migrations - run in version order, not definition order', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			createMigrationTest({
				projectVersion: '2.0.0',
				migrations: {
					'2.0.0': createMigration('v2'),
					'1.0.0': createMigration('v1'),
				},
			});

			// A store that ran the migrations in definition order would end up with the state of 1.0.0.
			assert.deepStrictEqual(tracker, ['v1', 'v2']);
		});

		it('migrations - order a range by the lowest version it matches', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			createMigrationTest({
				projectVersion: '2.5.0',
				migrations: {
					'>=2.0.0': createMigration('range'),
					'1.0.0': createMigration('v1'),
					'1.5.0': createMigration('v1.5'),
				},
			});

			assert.deepStrictEqual(tracker, ['v1', 'v1.5', 'range']);
		});

		it('migrations - refuses a `projectVersion` that is not a version', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd);

			// A value such as `1.0` cannot be compared later, so it must not reach the config file. The error has to name the option, since semver's own error names neither it nor this module.
			assert.throws(() => {
				new Conf({
					cwd,
					projectVersion: '1.0',
					migrations: {
						'1.0.0'() {},
					},
				});
			}, {message: /`projectVersion` option must be a valid semantic version/});

			assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), {});
		});

		it('migrations - a migration key written as a range is treated as a range', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'=1.0.0': createMigration('exact'),
				},
			});

			// `=1.0.0` is a range, and comparing it as a version crashes the constructor.
			assert.deepStrictEqual(tracker, ['exact']);
		});

		it('migrations - a key that is neither a version nor a range does not run', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			const {cwd} = createMigrationTest({
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0': createMigration('v1'),
				},
			});

			// A store with a recorded version, since a range is only compared when the stored version is known.
			assert.deepStrictEqual(tracker, ['v1']);

			tracker.length = 0;
			new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0': createMigration('v1'),
					notAVersion: createMigration('invalid'),
				},
			});

			assert.deepStrictEqual(tracker, []);
		});

		it('migrations - does not run a range migration on a store that is past it', () => {
			const {tracker, createMigration} = createMigrationOrderTracker();

			const {cwd} = createMigrationTest({
				projectVersion: '3.0.0',
				migrations: {
					'2.0.0': createMigration('v2'),
				},
			});

			assert.deepStrictEqual(tracker, ['v2']);

			// The store is at 3.0.0 now, so a migration for a range that is already behind it must not run again, and the recorded version must stay put.
			tracker.length = 0;
			const downgraded = new Conf({
				cwd,
				projectVersion: '2.5.0',
				migrations: {
					'2.0.0': createMigration('v2'),
					'<3.0.0': createMigration('legacy'),
				},
			});

			assert.deepStrictEqual(tracker, []);
			assert.strictEqual(getMigrationVersion(downgraded), '3.0.0');
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

		it('migrations - a store that records version 0.0.0 runs a range migration only once', () => {
			const migrations: Record<string, (store: Conf) => void> = {
				'>=0.0.0'(store) {
					store.set('runs', ((store.get('runs') as number | undefined) ?? 0) + 1);
				},
			};

			const {conf: first, cwd} = createMigrationTest({projectVersion: '0.0.0', migrations});
			assert.strictEqual(first.get('runs'), 1);
			assert.strictEqual(getMigrationVersion(first), '0.0.0');

			// `0.0.0` is a version like any other once it is recorded, so a second start must run nothing.
			const {conf: second} = createMigrationTest({cwd, projectVersion: '0.0.0', migrations});
			assert.strictEqual(second.get('runs'), 1);
			assert.strictEqual(getMigrationVersion(second), '0.0.0');
		});

		it('migrations - a migration sees the values of the `defaults` option', () => {
			const seen: unknown[] = [];

			createMigrationTest({
				projectVersion: '1.0.0',
				defaults: {fromDefaults: 'default'},
				initialData: {stored: 'value'},
				migrations: {
					'1.0.0'(store) {
						seen.push([store.get('fromDefaults'), store.get('stored')]);
					},
				},
			});

			// The defaults are part of the store, so a migration sees them next to the keys the file holds. A `default` of the `schema` option is only written when the store is validated, which is after the migrations, since a migration repairs a value the schema rejects.
			assert.deepStrictEqual(seen, [['default', 'value']]);
		});

		it('migrations - clearing the store keeps the recorded version', () => {
			const cwd = createTempDirectory();
			const conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('migrated', true);
					},
				},
			});

			conf.clear();

			// Every item is gone, and the bookkeeping is not an item, so it stays.
			assert.deepStrictEqual(conf.store, createNullProtoObject({}));
			assert.strictEqual(getMigrationVersion(conf), '1.0.0');

			// The recorded version is what keeps the migrations from running again on the next start.
			const reopened = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('ranAgain', true);
					},
				},
			});

			assert.strictEqual(reopened.get('ranAgain'), undefined);
		});

		it('migrations - a reserved key that holds something else is repaired', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {__internal__: 'not an object', legacy: 'value'});

			const conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('migrated', true);
					},
				},
			});

			// A value that a hand edit or an older version left in the bookkeeping's place holds no version to compare, so the migrations run and the recorded version is written over it.
			assert.strictEqual(conf.get('migrated'), true);
			assert.strictEqual(conf.get('legacy'), 'value');
			assert.strictEqual(getMigrationVersion(conf), '1.0.0');
		});

		it('migrations - an encrypted store records the version it reached', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd);

			const encryptionKey = 'secret-key';
			const first = new Conf({
				cwd,
				encryptionKey,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('phase', '1.0.0');
					},
				},
			});

			assert.strictEqual(first.get('phase'), '1.0.0');

			// The bookkeeping is part of the payload, so it has to survive the encryption round trip for a later start to skip the migrations.
			const second = new Conf({
				cwd,
				encryptionKey,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('ranAgain', true);
					},
				},
			});

			assert.strictEqual(second.get('ranAgain'), undefined);
			assert.strictEqual(second.get('phase'), '1.0.0');

			// The version cannot be read from the file itself, which is why it is read through the store. What `JSON.parse` says depends on the random bytes the file starts with, and every message it gives names JSON.
			assert.throws(() => readConfigFile(first.path), {name: 'SyntaxError', message: /JSON/});
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

			// The store does not exist yet, so there is nothing to migrate and it starts at the current project version.
			const conf = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'2.0.0'(store) {
						store.set('foo', 'bar');
					},
				},
			});

			assert.strictEqual(conf.get('foo'), undefined);
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');
		});

		it('migrations - should not run migrations for a store that does not exist yet', () => {
			const cwd = createTempDirectory();
			const ran: string[] = [];

			const conf = new Conf({
				cwd,
				projectVersion: '2.0.0',
				defaults: {fromDefaults: true},
				migrations: {
					'1.0.0'() {
						ran.push('1.0.0');
					},
					'>=2.0.0'() {
						ran.push('>=2.0.0');
					},
				},
			});

			// There is no old data, so nothing may run against the new defaults.
			assert.deepStrictEqual(ran, []);
			assert.strictEqual(conf.get('fromDefaults'), true);
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');
		});

		it('migrations - should run migrations for a store that exists without a recorded version', () => {
			const cwd = createTempDirectory();

			// An app that shipped before it had migrations leaves a config file without a version.
			createExistingConfig(cwd, {legacy: 'value'});

			const conf = new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'2.0.0'(store) {
						store.set('migrated', true);
					},
				},
			});

			assert.strictEqual(conf.get('migrated'), true);
			assert.strictEqual(conf.get('legacy'), 'value');
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');
		});

		it('migrations - should save the project version when a migration occurs', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd);

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

		it('migrations - should cleanup migrations with range conditions', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd);

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
			createExistingConfig(cwd);

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

			const conf = new Conf({cwd});
			conf.set('foo', 'bar');
			assert.strictEqual(conf.get('foo'), 'bar');
			// No migration ran, so no version is recorded.
			assert.deepStrictEqual(readConfigFile(conf.path), {foo: 'bar'});
		});

		it('migrations - should not create migration metadata when migrations are not needed', () => {
			const cwd = createTempDirectory();
			const conf = new Conf({cwd, projectVersion: '1.0.0'});
			assert.ok(!conf.has('__internal__'));
			// The public view never shows the bookkeeping, so the file is what says whether it was written.
			assert.strictEqual(fs.existsSync(conf.path), false);
		});

		it('migrations - should not expose the internal key', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd);

			const store = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('foo', 'bar');
					},
				},
			});

			assert.deepStrictEqual(store.store, createNullProtoObject({foo: 'bar'}));
			assert.strictEqual(store.get('__internal__'), undefined);
			assert.strictEqual(store.has('__internal__'), false);
			assert.strictEqual(store.size, 1);
			assert.deepStrictEqual([...store], [['foo', 'bar']]);

			// The version is still persisted.
			assert.strictEqual(getMigrationVersion(store), '1.0.0');
		});

		it('migrations - should preserve internal data when store is overwritten', () => {
			const cwd = createTempDirectory();

			// Create initial config with migration
			const conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('test', 'value1');
					},
				},
			});

			assert.strictEqual(getMigrationVersion(conf), '1.0.0');
			conf.set('a', 1);

			// Overwrite the entire store
			conf.store = {newData: 'test'};

			// Verify internal data was preserved
			assert.strictEqual(getMigrationVersion(conf), '1.0.0');
			assert.deepStrictEqual({...conf.store}, {newData: 'test'});

			// A `clear()` is a whole-store write of the defaults, so it keeps the bookkeeping too.
			conf.clear();
			assert.strictEqual(getMigrationVersion(conf), '1.0.0');
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
			conf.store = {};

			// Verify internal data was preserved
			assert.strictEqual(getMigrationVersion(conf), '1.0.0');
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
			conf.store = {newData: 'test'};

			// Verify internal data was preserved
			assert.strictEqual(getMigrationVersion(conf), '1.0.0');
		});

		it('migrations - a deserializer that freezes its result still reads', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {seed: 1});

			// The reserved key has to be detached before the schema runs, which needs a copy when the deserializer returns an object that cannot be changed.
			const store = new Conf({
				cwd,
				projectVersion: '1.0.0',
				schema: {
					seed: {type: 'number'},
				},
				deserialize: value => Object.freeze(JSON.parse(value)) as Record<string, unknown>,
				migrations: {
					'1.0.0'(store) {
						store.set('seed', 2);
					},
				},
			});

			assert.strictEqual(store.get('seed'), 2);
		});

		it('migrations - refuses to delete the reserved key', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {seed: 1});

			const store = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'() {},
				},
			});

			// The recorded version is not part of the user's data, and deleting it would run every migration again.
			assert.throws(() => {
				store.delete('__internal__');
			}, {message: /used to manage this module internal operations/});

			assert.throws(() => {
				store.delete('__internal__.migrations.version');
			}, {message: /used to manage this module internal operations/});

			assert.strictEqual(getMigrationVersion(store), '1.0.0');
			assert.strictEqual(store.get('seed'), 1);
		});

		it('migrations - refuses the reserved key written in another way', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {seed: 1});

			const store = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'() {},
				},
			});

			// `dot-prop` normalizes the key before it writes, so escaping a character or writing the index form reaches the reserved key just the same.
			for (const key of [String.raw`\__internal__`, String.raw`_\_internal__`, '__internal__[0]', String.raw`\__internal__.migrations`]) {
				assert.throws(() => {
					store.set(key, {});
				}, {message: /used to manage this module internal operations/}, `set(\`${key}\`)`);

				assert.throws(() => {
					store.delete(key);
				}, {message: /used to manage this module internal operations/}, `delete(\`${key}\`)`);
			}

			assert.strictEqual(getMigrationVersion(store), '1.0.0');
			assert.strictEqual(store.get('seed'), 1);

			// A key that only starts with the name is the user's own, and it is written as an own key.
			store.set('__internal__extra', 2);
			assert.strictEqual(store.get('__internal__extra'), 2);
		});

		it('migrations - a nested `__internal__` key is the caller\'s data', () => {
			const conf = new Conf({cwd: createTempDirectory()});

			// Only the key at the top level is the module's own. One deeper down can never reach the bookkeeping, so it is stored like any other key, through an object and through a path.
			conf.set({document: {__internal__: {title: 'user data'}}});
			assert.deepStrictEqual(conf.get('document'), {__internal__: {title: 'user data'}});

			conf.set('other.__internal__', 1);
			assert.strictEqual(conf.get('other.__internal__'), 1);
		});

		it('migrations - refuses the reserved key through `appendToArray()`', () => {
			const conf = new Conf({cwd: createTempDirectory()});

			assert.throws(() => {
				conf.appendToArray('__internal__', 1);
			}, {message: /used to manage this module internal operations/});
		});

		it('migrations - a store that carries the reserved key keeps the bookkeeping', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {seed: 1});

			const conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'() {},
				},
			});

			// Writing the store whole does not take the reserved key from the caller, since that would replace the bookkeeping, and a store without a recorded version runs every migration again.
			for (const key of ['__internal__', '__internal__.migrations']) {
				conf.store = {[key]: {version: '9.9.9'}, other: 1};

				assert.strictEqual(getMigrationVersion(conf), '1.0.0', `store = {${key}: …}`);
				assert.deepStrictEqual(conf.store, createNullProtoObject({other: 1}));
			}

			// The value replaces the store, and the key it carries under the module's own name is dropped from it.
			assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), {
				other: 1,
				__internal__: {migrations: {version: '1.0.0'}},
			});
		});

		it('migrations - refuses the reserved key through the `defaults` option', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {seed: 1});

			// A default the module's own key covers is written to the file like any other key, where nothing reads it back, and the bookkeeping it holds is lost.
			for (const key of ['__internal__', '__internal__.migrations']) {
				assert.throws(() => {
					new Conf({
						cwd,
						projectVersion: '1.0.0',
						migrations: {
							'1.0.0'() {},
						},
						defaults: {[key]: {version: '9.9.9'}},
					});
				}, {message: /used to manage this module internal operations/}, `defaults: {${key}: …}`);
			}

			// The option is refused before the store is read or written, so the file it names is untouched.
			assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), {seed: 1});
		});

		it('migrations - a `defaults` key set to `undefined` is a key the option does not name', () => {
			// A key that is set to `undefined` is the same as one that is not passed, so the reserved key it names is not one the option uses.
			assert.doesNotThrow(() => {
				new Conf({cwd: createTempDirectory(), defaults: {__internal__: undefined}});
			});
		});

		it('migrations - the internal key does not take part in schema validation', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {foo: 1});

			const store = new Conf({
				cwd,
				projectVersion: '1.0.0',
				schema: {
					foo: {type: 'number'},
				},
				rootSchema: {
					additionalProperties: false,
				},
				migrations: {
					'1.0.0'(store) {
						store.set('foo', 2);
					},
				},
			});

			assert.strictEqual(store.get('foo'), 2);

			// Reading and writing must keep working now that the file holds the internal key.
			store.set('foo', 3);
			assert.strictEqual(store.get('foo'), 3);

			store.clear();
			assert.strictEqual(store.get('foo'), undefined);
		});

		it('migrations - the reserved key survives schema validation with `removeAdditional`', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {foo: 1});

			const store = new Conf({
				cwd,
				projectVersion: '1.0.0',
				schema: {
					foo: {type: 'number'},
				},
				rootSchema: {
					additionalProperties: false,
				},
				ajvOptions: {
					removeAdditional: true,
				},
				migrations: {
					'1.0.0'(store) {
						store.set('foo', 2);
					},
				},
			});

			// The internal key is not part of the user's data, so validation must not remove it as an additional property.
			store.set('foo', 3);

			assert.strictEqual(store.get('foo'), 3);
			assert.strictEqual(getMigrationVersion(store), '1.0.0');
		});
	});

	// Critical edge cases that could cause real-world failures
	describe('steps over stores and files that are out of the ordinary', () => {
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

		it('migrations - transforms a large dataset', () => {
			const largeData = generateLargeDataset(2000);

			const {conf: conf1, cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('largeData', largeData);
					},
				},
			});

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

			// Verify transformation completed
			assert.ok(!conf2.has('largeData'));
			assert.ok(conf2.has('transformedData'));
			const transformed = conf2.get('transformedData') as any;
			assert.strictEqual(Object.keys(transformed).length, 2000);
			assert.ok(Object.keys(transformed).every(key => key.startsWith('new_')));
			assert.deepStrictEqual(transformed.new_item1999, {...largeData.item1999, processed: true});
			assert.deepStrictEqual(new Conf({cwd}).get('transformedData'), transformed);
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

		it('migrations - run for a read-only config file', {skip: skipAsRoot}, () => {
			const {cwd, configPath} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('test', 'initial');
					},
				},
			});

			// Atomic writes can succeed even on read-only files by writing to temp and renaming, so migrations work even with read-only files (which is actually good behavior)
			fs.chmodSync(configPath, 0o444);

			try {
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
				assert.strictEqual(new Conf({cwd}).get('test'), 'modified');
				assert.strictEqual(getMigrationVersion(conf2), '2.0.0');
			} finally {
				fs.chmodSync(configPath, 0o644);
			}
		});

		it('migrations - a missing config directory is made again and usable', () => {
			const {cwd} = createMigrationTest({
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('test', 'initial');
					},
				},
			});

			// The store does not exist, so no migration runs, but it still has to be created and be usable.
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

			assert.strictEqual(getMigrationVersion(conf3), '2.0.0', 'Should recover from missing directory');
			assert.strictEqual(conf3.has('recovered'), false);
			assert.strictEqual(conf3.has('test'), false);

			conf3.set('usable', true);
			assert.strictEqual(new Conf({cwd}).get('usable'), true, 'Should be usable after recovering from a missing directory');
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
			const data = readConfigFile(configPath);
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
			assert.strictEqual(getMigrationVersion(conf2), '2.0.0');
		});
	});
});

describe('a reserved key the caller spells with a backslash', () => {
	// A key that spells itself with a backslash is a key of its own, so the name behind the backslash is what the store holds, and the store takes a name that parses to a path below the bookkeeping for the bookkeeping itself. `set()` accepted the escaped spelling, since the path it parses to is a key of the caller's, and the write then dropped the value with nothing to say so. A key that reaches the bookkeeping by either spelling is refused instead.
	for (const key of [String.raw`__internal__\.foo`, String.raw`__internal__\[0]`, String.raw`__internal__\.migrations`]) {
		it(`refuses the key ${JSON.stringify(key)}, which reaches the bookkeeping as the name behind it`, () => {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, unknown>>({cwd});
			conf.set('kept', 'value');

			for (const [name, write] of [
				['set()', () => {
					conf.set(key, 1);
				}],
				['delete()', () => {
					conf.delete(key);
				}],
			] as Array<[string, () => void]>) {
				assert.throws(() => {
					write();
				}, {name: 'TypeError', message: /__internal__/}, `${name} with ${JSON.stringify(key)}`);
			}

			// A whole-store write carries a name, and a name the bookkeeping is under is taken out of it, the way it is for the spelling without a backslash.
			conf.store = {[key]: 1, other: 2};
			assert.deepStrictEqual({...conf.store}, {other: 2}, `the store after a whole-store write with ${JSON.stringify(key)}`);
			assert.strictEqual(conf.get('kept'), undefined, 'the whole-store write replaced the store');
		});
	}

	it('still takes a name that only looks like the bookkeeping', () => {
		for (const [key, name] of [
			['__internal__extra', '__internal__extra'],
			[String.raw`a\.__internal__`, 'a.__internal__'],
		] as Array<[string, string]>) {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, unknown>>({cwd});
			conf.set(key, 1);
			assert.strictEqual(conf.get(key), 1, `the value read back for ${JSON.stringify(key)}`);
			assert.deepStrictEqual({...conf.store}, {[name]: 1}, `the store for ${JSON.stringify(key)}`);
		}
	});
});

describe('a schema `default` and migrations', () => {
	it('does not seed schema defaults into a defaults path during migrations', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {});
		const observed: unknown[] = [];
		const conf = new Conf<Store>({
			cwd,
			defaults: {'settings.enabled': true},
			schema: {
				settings: {
					type: 'object',
					default: {version: 'current'},
					properties: {version: {type: 'string', default: 'current'}},
				},
			},
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					observed.push(store.get('settings'));
					store.set('migrated', !store.has('settings.version'));
					observed.push(store.get('settings'));
				},
			},
		});

		assert.deepStrictEqual(observed, [{enabled: true}, {enabled: true}]);
		assert.equal(conf.get('migrated'), true);
		assert.deepStrictEqual(conf.get('settings'), {enabled: true, version: 'current'});
	});

	// The store the validator produces is written whether or not migrations ran, so the file a store leaves does not depend on whether it has migrations.
	type MigrationsFixture = Record<string, (store: Conf<Record<string, any>>) => void>;
	const withAndWithoutMigrations = (test: (cwd: string, migrations: MigrationsFixture | undefined) => void): void => {
		for (const withMigrations of [false, true]) {
			const cwd = createTempDirectory();
			fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({}));
			const migrations = {
				'1.0.0'(store: Conf<Record<string, any>>) {
					store.set('migrated', true);
				},
			};
			test(cwd, withMigrations ? migrations : undefined);
		}
	};

	it('writes a `default` for a key of its own', () => {
		withAndWithoutMigrations((cwd, migrations) => {
			const conf = new Conf<Record<string, any>>({
				cwd,
				projectVersion: '1.0.0',
				migrations,
				schema: {foo: {type: 'number', default: 42}},
			});
			assert.strictEqual(conf.get('foo'), 42);
			assert.strictEqual(readConfigFile(conf.path).foo, 42, `with migrations: ${String(Boolean(migrations))}`);
		});
	});

	it('writes a `default` the validator adds below the top level', () => {
		withAndWithoutMigrations((cwd, migrations) => {
			const schema = {a: {type: 'object', properties: {b: {type: 'number', default: 7}}}};
			const seed = new Conf<Record<string, any>>({cwd, schema});
			seed.set('a', {});
			seed.set('unrelated', true);
			fs.writeFileSync(path.join(cwd, 'config.json'), fs.readFileSync(seed.path));

			const conf = new Conf<Record<string, any>>({
				cwd,
				projectVersion: '1.0.0',
				migrations,
				schema,
			});
			assert.deepStrictEqual(conf.get('a'), {b: 7});
			assert.deepStrictEqual(readConfigFile(conf.path).a, {b: 7}, `with migrations: ${String(Boolean(migrations))}`);
		});
	});
});

describe('the recorded version', () => {
	it('should record the project version after a pass whose last step is a range', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '1.0.0'}}});

		new Conf({
			cwd,
			projectVersion: '2.0.0',
			migrations: {
				'>=1.5.0'() {},
			},
		});

		assert.strictEqual(getMigrationVersion(new Conf({cwd, projectVersion: '2.0.0'})), '2.0.0');
	});

	it('should not run a range step again after the pass that ran it', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '1.0.0'}}});

		const ran: string[] = [];
		const migrations = {
			'>=1.5.0'() {
				ran.push('>=1.5.0');
			},
			'1.8.0'() {
				ran.push('1.8.0');
			},
		};

		new Conf({cwd, projectVersion: '2.0.0', migrations});
		assert.deepStrictEqual(ran, ['>=1.5.0', '1.8.0']);

		ran.length = 0;
		new Conf({cwd, projectVersion: '2.0.0', migrations});
		assert.deepStrictEqual(ran, []);
	});

	it('should not move the recorded version backwards when an older project version opens the store', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: true});

		const ran: string[] = [];

		new Conf({
			cwd,
			projectVersion: '2.0.0',
			migrations: {
				'2.0.0'(store) {
					ran.push('2.0.0');
					store.set('phase', 'two');
				},
			},
		});

		assert.deepStrictEqual(ran, ['2.0.0']);
		new Conf({cwd}).set('user', 'kept');

		// An older app opens the same file. Nothing may run, and it must not claim the store is at its own version.
		new Conf({
			cwd,
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'() {
					ran.push('1.0.0');
				},
				'2.0.0'() {
					ran.push('2.0.0');
				},
			},
		});

		assert.deepStrictEqual(ran, ['2.0.0']);
		assert.strictEqual(getMigrationVersion(new Conf({cwd, projectVersion: '1.0.0'})), '2.0.0');
		assert.strictEqual(new Conf({cwd, projectVersion: '1.0.0'}).get('phase'), 'two');
		assert.strictEqual(new Conf({cwd, projectVersion: '1.0.0'}).get('user'), 'kept');

		// Opening with the newer version again must not run the migration a second time.
		new Conf({
			cwd,
			projectVersion: '2.0.0',
			migrations: {
				'2.0.0'() {
					ran.push('2.0.0');
				},
			},
		});

		assert.deepStrictEqual(ran, ['2.0.0']);
		assert.strictEqual(new Conf({cwd, projectVersion: '2.0.0'}).get('user'), 'kept');
	});

	it('should not move the recorded version backwards when a downgrade runs a range migration', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '2.0.0'}}});

		const ran: string[] = [];

		new Conf({
			cwd,
			projectVersion: '1.0.0',
			migrations: {
				'>=1.0.0'() {
					ran.push('>=1.0.0');
				},
			},
		});

		assert.deepStrictEqual(ran, []);
		assert.strictEqual(getMigrationVersion(new Conf({cwd, projectVersion: '1.0.0'})), '2.0.0');
	});

	it('should run the steps between two versions exactly once across a downgrade and an upgrade', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: true});

		const ran: string[] = [];
		const migrations = {
			'1.5.0'() {
				ran.push('1.5.0');
			},
			'2.0.0'() {
				ran.push('2.0.0');
			},
			'3.0.0'() {
				ran.push('3.0.0');
			},
		};

		new Conf({cwd, projectVersion: '3.0.0', migrations});
		assert.deepStrictEqual(ran, ['1.5.0', '2.0.0', '3.0.0']);

		ran.length = 0;
		new Conf({cwd, projectVersion: '2.0.0', migrations});
		assert.deepStrictEqual(ran, []);

		ran.length = 0;
		new Conf({cwd, projectVersion: '3.0.0', migrations});
		assert.deepStrictEqual(ran, []);
	});

	it('should not run a step the recorded version already covers when the project version is older', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '2.0.0'}}});

		const ran: string[] = [];

		const conf = new Conf({
			cwd,
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'() {
					ran.push('1.0.0');
				},
				'2.0.0'() {
					ran.push('2.0.0');
				},
			},
		});

		assert.deepStrictEqual(ran, []);
		assert.strictEqual(getMigrationVersion(conf), '2.0.0');
	});

	it('should record the current project version for a store that has none', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: true});

		new Conf({cwd, projectVersion: '2.0.0', migrations: {'2.0.0'() {}}});
		assert.strictEqual(getMigrationVersion(new Conf({cwd, projectVersion: '2.0.0'})), '2.0.0');
	});

	it('should record the current project version when no step runs', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: true, __internal__: {migrations: {version: '1.0.0'}}});

		let runs = 0;
		new Conf({
			cwd,
			projectVersion: '2.0.0',
			migrations: {
				'1.0.0'() {
					runs++;
				},
			},
		});
		assert.strictEqual(runs, 0);
		assert.strictEqual(getMigrationVersion(new Conf({cwd, projectVersion: '2.0.0'})), '2.0.0');
	});
});

describe('migration ranges', () => {
	it('does not re-enter a disjunctive range that the previous version matched', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '1.5.0'}}});

		const conf = new Conf({
			cwd,
			projectVersion: '3.0.0',
			migrations: {
				'1.x || 3.x'(store) {
					store.set('migrationRan', true);
				},
			},
		});

		assert.strictEqual(conf.get('migrationRan'), undefined);
		assert.strictEqual(getMigrationVersion(conf), '3.0.0');
	});

	it('does not enter a disjunctive range during a downgrade', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '4.0.0'}}});

		const conf = new Conf({
			cwd,
			projectVersion: '3.0.0',
			migrations: {
				'1.x || 3.x'(store) {
					store.set('migrationRan', true);
				},
			},
		});

		assert.strictEqual(conf.get('migrationRan'), undefined);
		assert.strictEqual(getMigrationVersion(conf), '4.0.0');
	});

	// A step for a range runs at the lowest version the range matches, and the steps are run in the order of those versions, so a range whose `minVersion` is nothing is ordered by the branch of it that does match.
	it('orders steps around a range with a branch that matches nothing', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '1.0.0'}}});

		const ran: string[] = [];
		const conf = new Conf({
			cwd,
			projectVersion: '3.0.0',
			migrations: {
				// Defined before the step that runs first, and a sort that leaves the ranges where they were defined would run this one first.
				'^3 || >1.0.0 <1.0.0'(store) {
					ran.push('^3 || >1.0.0 <1.0.0');
					store.set('second', true);
				},
				'1.5.0'(store) {
					ran.push('1.5.0');
					store.set('first', true);
				},
			},
		});

		assert.deepStrictEqual(ran, ['1.5.0', '^3 || >1.0.0 <1.0.0']);
		assert.strictEqual(conf.get('first'), true);
		assert.strictEqual(conf.get('second'), true);
	});
});

describe('migration bookkeeping', () => {
	describe('a reserved key of the wrong shape', () => {
		it('opens a store whose reserved key is an array and records the version it reached', () => {
			const cwd = createTempDirectory();

			const {conf} = createMigrationTest({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('migrated', true);
					},
				},
				initialData: {foo: 'bar', __internal__: []},
			});

			assert.strictEqual(conf.get('foo'), 'bar');
			assert.strictEqual(conf.get('migrated'), true);
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');
		});

		it('does not run the migrations again on the next launch', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {foo: 'bar', __internal__: []});

			const runs: string[] = [];
			new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						runs.push('1.0.0');
						store.set('migrated', true);
					},
				},
			});

			new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						runs.push('1.0.0');
						store.set('migrated', 'twice');
					},
				},
			});

			assert.deepStrictEqual(runs, ['1.0.0']);
			assert.strictEqual(new Conf({cwd}).get('migrated'), true);
		});

		it('opens a store whose recorded migrations are an array', () => {
			const cwd = createTempDirectory();

			const {conf} = createMigrationTest({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('migrated', true);
					},
				},
				initialData: {__internal__: {migrations: []}},
			});

			assert.strictEqual(conf.get('migrated'), true);
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');
		});

		it('opens a store with a schema and `clearInvalidConfig` whose reserved key is an array', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {foo: 'bar', __internal__: []});

			const conf = new Conf({
				cwd,
				projectVersion: '2.0.0',
				clearInvalidConfig: true,
				schema: {foo: {type: 'string'}},
				migrations: {
					'1.0.0'(store) {
						store.set('migrated', true);
					},
				},
			});

			assert.strictEqual(conf.get('foo'), 'bar');
			assert.strictEqual(conf.get('migrated'), true);
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');
		});
	});

	describe('a range recorded as completed', () => {
		it('retries a failed migration whose branch another migration completed', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {initial: true});
			const runs: string[] = [];
			let shouldFail = true;
			const migrations = {
				'1.x || 3.x'(store: Conf) {
					runs.push('first');
					store.set('first', true);
				},
				'3.x || 5.x'(store: Conf) {
					runs.push('second');
					store.set('second', true);
					if (shouldFail) {
						throw new Error('retry this migration');
					}
				},
			};

			assert.throws(() => new Conf({cwd, migrations, projectVersion: '3.1.0'}), /retry this migration/);
			assert.strictEqual(new Conf({cwd}).get('first'), true);
			assert.strictEqual(new Conf({cwd}).has('second'), false);

			shouldFail = false;
			const conf = new Conf({cwd, migrations, projectVersion: '3.1.0'});
			assert.deepStrictEqual(runs, ['first', 'second', 'second']);
			assert.deepStrictEqual({...conf.store}, {initial: true, first: true, second: true});
			assert.strictEqual(getMigrationVersion(conf), '3.1.0');

			new Conf({cwd, migrations, projectVersion: '3.1.0'});
			assert.deepStrictEqual(runs, ['first', 'second', 'second']);
		});

		it('runs the step again when the store enters a later branch of a disjunction', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {__internal__: {migrations: {version: '0.5.0'}}});

			const runs: string[] = [];
			const migrations = {
				'1.x || 3.x'(store: Conf) {
					runs.push((store.get('phase') as string | undefined) ?? 'unset');
					store.set('phase', 'entered');
				},
			};

			// The store enters the first branch, leaves the range, and enters the second one.
			for (const projectVersion of ['1.5.0', '2.0.0', '3.0.0']) {
				new Conf({cwd, projectVersion, migrations});
			}

			assert.deepStrictEqual(runs, ['unset', 'entered']);
			assert.strictEqual(getMigrationVersion(new Conf({cwd})), '3.0.0');
		});

		it('does not run the step again for a branch it has already run for', () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {__internal__: {migrations: {version: '0.5.0'}}});

			const runs: string[] = [];
			const migrations = {
				'1.x || 3.x'(store: Conf) {
					runs.push((store.get('phase') as string | undefined) ?? 'unset');
					store.set('phase', 'entered');
				},
			};

			// The store enters the first branch, leaves the range, and enters the same branch again.
			for (const projectVersion of ['1.5.0', '2.0.0', '1.8.0']) {
				new Conf({cwd, projectVersion, migrations});
			}

			assert.deepStrictEqual(runs, ['unset']);
		});

		// A range with one branch is recorded the way the option writes it, since that is what an earlier version of this module wrote into a file and still reads out of one, and a file this version writes is read by it the same way.
		it('records a range with one branch the way the option writes it', () => {
			const cwd = createTempDirectory();

			const {conf} = createMigrationTest({
				cwd,
				projectVersion: '1.5.0',
				migrations: {
					'1.x'(store) {
						store.set('ran', true);
					},
				},
				initialData: {__internal__: {migrations: {version: '0.5.0'}}},
			});

			const data = readConfigFile(path.join(cwd, 'config.json')) as {__internal__: {migrations: {completedRanges?: string[]}}};
			assert.deepStrictEqual(data.__internal__.migrations.completedRanges, ['1.x']);
			assert.strictEqual(conf.get('ran'), true);
		});
	});
	// The backup a failed step is rolled back to is the store as it was read, so a value whose object graph comes back to itself is held by it as it is, with or without a value beside it that cannot be cloned.
	describe('a value a `deserialize` hands back that holds itself', () => {
		const withACycle = (extra: unknown): Record<string, unknown> => {
			const value: Record<string, unknown> = {seed: 1, extra};
			value.self = value;
			return value;
		};

		/**
		Opens a store over a migration whose `deserialize` hands back a value holding itself and the given extra value, and returns the store and the number of times the step ran.
		*/
		const overAMigration = (extra: unknown, value = withACycle(extra)): {conf: Conf; ran: number} => {
			const cwd = createTempDirectory();
			// A store that is not new is one the migrations run over, which is what takes the copy.
			createExistingConfig(cwd, {seed: 1});
			let ran = 0;
			const conf = new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store: Conf) {
						ran++;
						store.set('touched', true);
					},
				},
				serialize: () => '{}',
				deserialize: () => value,
			});
			return {conf, ran};
		};

		it('opens a store whose backup is a value holding itself and a function', () => {
			const {conf, ran} = overAMigration(() => 'x');
			assert.strictEqual(ran, 1);
			assert.strictEqual(conf.get('seed'), 1);
			assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), '{}');
		});

		it('opens a store whose backup is a value holding itself and a symbol', () => {
			const {conf, ran} = overAMigration(Symbol('s'));
			assert.strictEqual(ran, 1);
			assert.strictEqual(conf.get('seed'), 1);
			assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), '{}');
		});

		it('opens a store whose backup holds itself and nothing else', () => {
			// A cycle with nothing beside it, so the two cases above are told apart from a cycle alone.
			const value: Record<string, unknown> = {seed: 1};
			value.self = value;

			const {conf, ran} = overAMigration(undefined, value);
			assert.strictEqual(ran, 1);
			assert.strictEqual(conf.get('seed'), 1);
			assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), '{}');
		});
	});
});

describe('the `migrations` option', () => {
	it('refuses a step that is not a function, where the version names a step that would run', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd);

		assert.throws(
			() => new Conf({cwd, projectVersion: '2.0.0', migrations: {'1.0.0': 'nope'}} as unknown as Partial<Options<Store>>),
			{name: 'TypeError', message: 'The `migrations` option must be an object of steps, got string for the version `1.0.0`.'},
		);
	});

	it('refuses a step that is not a function, where the version names a step that would not run', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd);

		assert.throws(
			() => new Conf({cwd, projectVersion: '1.0.0', migrations: {'5.0.0': 'nope'}} as unknown as Partial<Options<Store>>),
			{name: 'TypeError', message: 'The `migrations` option must be an object of steps, got string for the version `5.0.0`.'},
		);
	});

	it('refuses an array of steps, whose keys name no version at all', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd);

		assert.throws(
			() => new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: [(store: Conf<Store>) => {
					store.set('a', 1);
				}],
			} as unknown as Partial<Options<Store>>),
			{name: 'TypeError', message: /The `migrations` option must be/},
		);
	});

	it('refuses a `migrations` option that is not an object of steps', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd);

		for (const migrations of ['nope', 1, true]) {
			assert.throws(
				() => new Conf({cwd, projectVersion: '2.0.0', migrations} as unknown as Partial<Options<Store>>),
				{name: 'TypeError', message: /The `migrations` option must be/},
				`for ${typeof migrations}`,
			);
		}
	});

	it('leaves the file as it was where a step is refused', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {a: 1});

		assert.throws(
			() => new Conf({cwd, projectVersion: '2.0.0', migrations: {'1.0.0': 'nope'}} as unknown as Partial<Options<Store>>),
			{name: 'TypeError'},
		);

		assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), {a: 1});
	});

	it('takes a `migrations` option that is not passed, or set to nothing, for no migrations', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd);

		for (const migrations of [undefined, null]) {
			const conf = new Conf({cwd, projectVersion: '2.0.0', migrations} as Partial<Options<Store>>);
			assert.deepStrictEqual({...conf.store}, {});
			// No migration ran, so no version is recorded and the file is as it was.
			assert.deepStrictEqual(readConfigFile(conf.path), {});
		}
	});

	it('refuses `migrations` without a `projectVersion`', () => {
		assert.throws(() => {
			new Conf({
				cwd: createTempDirectory(),
				migrations: {
					'1.0.0'() {},
				},
			});
		}, {message: 'Please specify the `projectVersion` option.'});
	});
});

describe('a `migrations` option that is not an object of steps', () => {
	it('refuses one whose keys are not versions', () => {
		assert.throws(() => {
			new Conf({
				cwd: createTempDirectory(),
				projectVersion: '1.0.0',
				migrations: [(store: Conf<Store>) => {
					store.has('a');
				}],
			} as unknown as Partial<Options<Store>>);
		}, {name: 'TypeError', message: 'The `migrations` option must be an object whose keys are the versions to migrate and whose values are the steps to run.'});
	});
});

describe('migration steps', () => {
	it('migrations - validation should not prevent migrations from running', () => {
		const temporaryDirectoryPath = createTempDirectory();
		const configPath = path.join(temporaryDirectoryPath, 'config.json');

		// Create config with data that violates schema but can be fixed by migration
		fs.writeFileSync(configPath, JSON.stringify({
			age: '25', // String instead of number - violates schema
			active: 'true', // String instead of boolean - violates schema
		}, null, '\t'));

		// Migration should run BEFORE validation, allowing it to fix the invalid data
		const conf = new Conf({
			cwd: temporaryDirectoryPath,
			projectVersion: '1.0.0',
			schema: {age: {type: 'number'}, active: {type: 'boolean'}},
			migrations: {
				'1.0.0'(store) {
					// Fix the schema violations
					const age = store.get('age');
					if (typeof age === 'string') {
						store.set('age', Number.parseInt(age, 10));
					}

					const active = store.get('active');
					if (typeof active === 'string') {
						store.set('active', active === 'true');
					}
				},
			},
		});

		// Should successfully migrate and validate
		assert.strictEqual(conf.get('age'), 25);
		assert.strictEqual(typeof conf.get('age'), 'number');
		assert.strictEqual(conf.get('active'), true);
		assert.strictEqual(typeof conf.get('active'), 'boolean');
	});

	it('supports append, rename and delete inside migrations', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({old: 'x', array: [1]}));
		const conf = new Conf({
			cwd,
			projectVersion: '2.0.0',
			migrations: {
				'1.0.0'(store) {
					store.appendToArray('array', 2);
				},
				'2.0.0'(store) {
					store.set('renamed', store.get('old'));
					store.delete('old');
				},
			},
		});
		assert.deepStrictEqual(conf.get('array'), [1, 2]);
		assert.strictEqual(conf.get('renamed'), 'x');
		assert.strictEqual(conf.get('old'), undefined);
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

		assert.strictEqual(getMigrationVersion(conf), '1.0.0');
		assert.strictEqual(runCount, 1);

		// Overwrite store - internal state should remain
		conf.store = {different: 'data'};
		assert.strictEqual(getMigrationVersion(conf), '1.0.0');

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

		assert.strictEqual(getMigrationVersion(conf), '1.0.0');

		// Should handle literal keys without dot notation parsing
		assert.strictEqual(conf.get('key.with.dots'), 'literal');

		// Store overwrite should preserve internal state
		conf.store = {new: 'data'};
		assert.strictEqual(getMigrationVersion(conf), '1.0.0');
	});

	it('runs an empty migrations object and records the version', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {legacy: true});
		const conf = new Conf({cwd, projectVersion: '1.2.3', migrations: {}});
		assert.strictEqual(conf.get('legacy'), true);
		assert.strictEqual(getMigrationVersion(conf), '1.2.3');
	});

	it('migration works with dot-notation disabled via literal keys', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {});
		const conf = new Conf({
			cwd,
			projectVersion: '1.0.0',
			accessPropertiesByDotNotation: false,
			migrations: {
				'1.0.0'(store) {
					store.set('dotted.key', 'literal');
				},
			},
		});
		assert.strictEqual(conf.get('dotted.key'), 'literal');
	});

	it('runs each applicable version exactly once across upgrades', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {});
		const seen: string[] = [];
		const migrations = {
			'1.0.0'(store: Conf) {
				seen.push('1.0.0');
				store.set('phase', '1.0.0');
			},
			'2.0.0'(store: Conf) {
				seen.push('2.0.0');
				store.set('phase', '2.0.0');
			},
		};

		new Conf({cwd, projectVersion: '1.0.0', migrations});
		assert.deepStrictEqual(seen, ['1.0.0']);

		new Conf({cwd, projectVersion: '2.0.0', migrations});
		assert.deepStrictEqual(seen, ['1.0.0', '2.0.0']);
		new Conf({cwd}).set('phase', 'changed by the user');
		const conf = new Conf({cwd, projectVersion: '2.0.0', migrations});
		assert.deepStrictEqual(seen, ['1.0.0', '2.0.0']);
		// A step that does not run again leaves what the store holds alone.
		assert.strictEqual(conf.get('phase'), 'changed by the user');
	});

	it('orders prereleases before the release', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {});
		const seen: string[] = [];

		new Conf({
			cwd,
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'() {
					seen.push('release');
				},
				'1.0.0-beta'() {
					seen.push('beta');
				},
				'1.0.0-alpha'() {
					seen.push('alpha');
				},
			},
		});
		assert.deepStrictEqual(seen, ['alpha', 'beta', 'release']);
	});
});

describe('a disjunctive range', () => {
	it('runs at the start of the branch the store enters, in order with the other steps', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '2.0.0'}}});

		const hookCalls: string[] = [];
		const ran: string[] = [];
		new Conf({
			cwd,
			projectVersion: '3.1.0',
			beforeEachMigration(_store, context) {
				hookCalls.push(`${context.fromVersion} → ${context.toVersion} of ${context.versions.join(', ')}`);
			},
			migrations: {
				'1.x || 3.x'() {
					ran.push('1.x || 3.x');
				},
				'2.5.0'() {
					ran.push('2.5.0');
				},
			},
		});

		assert.deepStrictEqual(ran, ['2.5.0', '1.x || 3.x']);
		assert.deepStrictEqual(hookCalls, ['2.0.0 → 2.5.0 of 2.5.0, 3.0.0', '2.5.0 → 3.0.0 of 2.5.0, 3.0.0']);
	});
});

describe('a migration step that opens a store on another file', () => {
	it('still runs a step of a second store opened on another file with the same steps', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {old: true});
		const otherCwd = createTempDirectory();
		createExistingConfig(otherCwd, {old: true});

		let opened = false;
		const ran: number[] = [];
		const migrations: Record<string, (store: Conf) => void> = {
			'2.0.0'(store) {
				ran.push(1);

				if (!opened) {
					opened = true;
					trackConf(new Conf({cwd: otherCwd, projectVersion: '2.0.0', migrations}));
				}

				store.set('a', 1);
			},
		};

		const conf = trackConf(new Conf({cwd, projectVersion: '2.0.0', migrations}));
		const other = trackConf(new Conf({cwd: otherCwd, projectVersion: '2.0.0', migrations}));

		assert.strictEqual(ran.length, 2);
		assert.strictEqual(conf.get('a'), 1);
		assert.strictEqual(other.get('a'), 1);
	});
});
