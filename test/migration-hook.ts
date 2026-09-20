/* eslint-disable no-new, @typescript-eslint/no-empty-function, @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- A store is built for the migrations it runs, a step is keyed by its version and often does nothing, and the context a hook is given is read as `any`. */
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import Conf from '../source/index.js';
import {
	createExistingConfig,
	createTempDirectory,
	runRegisteredCleanups,
	resetTrackedConfs,
	readConfigFile,
	createMigrationTest,
	getMigrationVersion,
	trackConf,
} from './_utilities.js';

type Store = Record<string, any>;

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a `beforeEachMigration` that throws', () => {
	it('leaves the store the file held', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: 1, __internal__: {migrations: {version: '1.0.0'}}});
		const before = readConfigFile(path.join(cwd, 'config.json'));

		assert.throws(() => new Conf<Record<string, unknown>>({
			cwd,
			projectVersion: '2.0.0',
			beforeEachMigration() {
				throw new Error('hook boom');
			},
			migrations: {
				'1.5.0'(store) {
					store.set('migrated', true);
				},
			},
		}), {message: /Something went wrong during the migration/});

		assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), before);
	});
});

describe('beforeEachMigration versions', () => {
	it('reports the version a range step reached as the next step it migrated from', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '1.0.0'}}});
		const context: Array<{fromVersion: string; toVersion: string}> = [];

		new Conf({
			cwd,
			projectVersion: '4.0.0',
			beforeEachMigration(_store, migrationContext) {
				context.push({
					fromVersion: migrationContext.fromVersion,
					toVersion: migrationContext.toVersion,
				});
			},
			migrations: {
				'1.5.0'(store) {
					store.set('phase', '1.5.0');
				},
				'>=2.0.0'(store) {
					store.set('phase', '>=2.0.0');
				},
				'3.0.0'(store) {
					store.set('phase', '3.0.0');
				},
			},
		});

		// A step that runs for a range is migrated to the lowest version the range matches, so the step after it is migrated from that version.
		assert.deepStrictEqual(context, [
			{
				fromVersion: '1.0.0',
				toVersion: '1.5.0',
			},
			{
				fromVersion: '1.5.0',
				toVersion: '2.0.0',
			},
			{
				fromVersion: '2.0.0',
				toVersion: '3.0.0',
			},
		]);
	});

	it('reports no recorded version as the first step it migrated from', () => {
		const cwd = createTempDirectory();
		// A config file that exists without a recorded version is still migrated.
		createExistingConfig(cwd, {});
		const context: Array<{fromVersion: string; toVersion: string; finalVersion: string; versions: string[]}> = [];

		new Conf({
			cwd,
			projectVersion: '2.0.0',
			beforeEachMigration(_store, migrationContext) {
				context.push(migrationContext);
			},
			migrations: {
				'1.0.0'(store) {
					store.set('one', true);
				},
				'2.0.0'(store) {
					store.set('two', true);
				},
			},
		});

		assert.deepStrictEqual(context, [
			{
				fromVersion: '0.0.0',
				toVersion: '1.0.0',
				finalVersion: '2.0.0',
				versions: ['1.0.0', '2.0.0'],
			},
			{
				fromVersion: '1.0.0',
				toVersion: '2.0.0',
				finalVersion: '2.0.0',
				versions: ['1.0.0', '2.0.0'],
			},
		]);
	});
});

describe('a migration step for a range that matches every version', () => {
	// A hook compares the versions it is told, so every step must be told one for a range too, `*` among them, which has no lowest version of its own.
	it('tells a hook a version it can compare', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {});
		const context: Array<{fromVersion: string; toVersion: string}> = [];

		new Conf({
			cwd,
			projectVersion: '2.0.0',
			beforeEachMigration(_store, migrationContext) {
				context.push({
					fromVersion: migrationContext.fromVersion,
					toVersion: migrationContext.toVersion,
				});
			},
			migrations: {
				'1.0.0'(store) {
					store.set('one', true);
				},
				'*'(store) {
					store.set('star', true);
				},
				'2.0.0'(store) {
					store.set('two', true);
				},
			},
		});

		assert.deepStrictEqual(context, [
			{
				fromVersion: '0.0.0',
				toVersion: '0.0.0',
			},
			{
				fromVersion: '0.0.0',
				toVersion: '1.0.0',
			},
			{
				fromVersion: '1.0.0',
				toVersion: '2.0.0',
			},
		]);
		for (const {fromVersion, toVersion} of context) {
			assert.notStrictEqual(semver.valid(fromVersion), null, `fromVersion is not a version: ${fromVersion}`);
			assert.notStrictEqual(semver.valid(toVersion), null, `toVersion is not a version: ${toVersion}`);
		}
	});
});

describe('the context a `beforeEachMigration` hook is given', () => {
	it('tells every step of a pass the same versions, where one step changes the list it is given', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd);

		const told: string[][] = [];
		const versions = ['1.0.0', '2.0.0'];

		assert.doesNotThrow(() => new Conf<Store>({
			cwd,
			projectVersion: '3.0.0',
			// The steps do nothing of their own, since it is the hooks that are told the versions.
			migrations: {
				'1.0.0'(store) {
					store.has('a');
				},
				'2.0.0'(store) {
					store.has('a');
				},
			},
			beforeEachMigration(_store, context) {
				told.push([...context.versions]);
				context.versions.push('2.0.0');
			},
		}));

		assert.deepStrictEqual(told, [versions, versions]);
	});
});

describe('the `beforeEachMigration` hook', () => {
	it('does not call beforeEachMigration for a fresh store', () => {
		const cwd = createTempDirectory();
		let calls = 0;
		const conf = new Conf({
			cwd,
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('x', 1);
				},
			},
			beforeEachMigration() {
				calls++;
			},
		});
		assert.strictEqual(calls, 0);
		assert.strictEqual(conf.get('x'), undefined);
	});

	it('beforeEachMigration receives from/to/final/versions', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {});
		const seen: Array<{fromVersion: string; toVersion: string; finalVersion: string; versions: string[]}> = [];

		new Conf({
			cwd,
			projectVersion: '2.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('a', 1);
				},
				'2.0.0'(store) {
					store.set('b', 2);
				},
			},
			beforeEachMigration(_store, context) {
				seen.push({...context});
			},
		});
		assert.strictEqual(seen.length, 2);
		assert.deepStrictEqual(seen[0]!.versions, ['1.0.0', '2.0.0']);
		assert.strictEqual(seen[0]!.finalVersion, '2.0.0');
		assert.strictEqual(seen[0]!.fromVersion, '0.0.0');
		assert.strictEqual(seen[0]!.toVersion, '1.0.0');
		assert.strictEqual(seen[1]!.toVersion, '2.0.0');
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

	it('migrations - the hook is told a version it can compare', () => {
		const fromVersions: string[] = [];

		const {conf} = createMigrationTest({
			projectVersion: '3.0.0',
			beforeEachMigration(_store, context) {
				fromVersions.push(context.fromVersion);
			},
			migrations: {
				'1.0.0'(store) {
					store.set('a', 1);
				},
				'>=1.5.0'(store) {
					store.set('b', 1);
				},
				'2.0.0'(store) {
					store.set('c', 1);
				},
			},
		});

		// A migration can run for a range of versions, and a range is not a version, so a step that runs for one is told the lowest version the range matches as its own, which the step after it is migrated from.
		assert.deepStrictEqual(fromVersions, ['0.0.0', '1.0.0', '1.5.0']);
		assert.strictEqual(conf.get('c'), 1);
		assert.strictEqual(getMigrationVersion(conf), '3.0.0');
	});

	it('migrations - the hook is told the version a range step runs at', () => {
		const versions: Array<[string, string]> = [];
		const passes: string[][] = [];

		const {conf} = createMigrationTest({
			projectVersion: '3.0.0',
			beforeEachMigration(_store, context) {
				// A hook compares the version it is told, which a range cannot be compared as.
				assert.notStrictEqual(semver.valid(context.toVersion), null, `\`toVersion\` is not a version: ${context.toVersion}`);
				versions.push([context.fromVersion, context.toVersion]);
				passes.push([...context.versions]);
			},
			migrations: {
				'1.0.0'(store) {
					store.set('a', 1);
				},
				'>=1.5.0'(store) {
					store.set('b', 1);
				},
				'2.0.0'(store) {
					store.set('c', 1);
				},
			},
		});

		// A range runs at the lowest version it matches, which is the version the step migrates to and the one the step after it is migrated from.
		assert.deepStrictEqual(versions, [
			['0.0.0', '1.0.0'],
			['1.0.0', '1.5.0'],
			['1.5.0', '2.0.0'],
		]);

		// The versions a pass will run are versions too.
		assert.deepStrictEqual(passes, [
			['1.0.0', '1.5.0', '2.0.0'],
			['1.0.0', '1.5.0', '2.0.0'],
			['1.0.0', '1.5.0', '2.0.0'],
		]);

		assert.strictEqual(conf.get('c'), 1);
		assert.strictEqual(getMigrationVersion(conf), '3.0.0');
	});

	it('migrations - the hook is told a concrete version as the key writes it', () => {
		const versions: string[] = [];

		const {conf} = createMigrationTest({
			projectVersion: '1.0.0+build',
			beforeEachMigration(_store, context) {
				versions.push(`${context.fromVersion} -> ${context.toVersion}`);
			},
			migrations: {
				'1.0.0+build'(store) {
					store.set('migrated', true);
				},
			},
		});

		// A concrete version is already one to compare, so the key is reported as it writes it. `semver.minVersion()` leaves the build metadata out of the version it reports, which would tell the hook about a version the store never recorded.
		assert.deepStrictEqual(versions, ['0.0.0 -> 1.0.0+build']);
		assert.strictEqual(conf.get('migrated'), true);
		assert.strictEqual(getMigrationVersion(conf), '1.0.0+build');
	});

	it('should not report a semver range as the from version of the next step', () => {
		const fromVersions: string[] = [];

		createMigrationTest({
			projectVersion: '2.0.0',
			beforeEachMigration(_store, context) {
				fromVersions.push(context.fromVersion);
			},
			migrations: {
				'>=1.0.0'() {},
				'1.5.0'() {},
			},
		});

		// The hook is documented to receive the version each step migrates from. A range is not a version, so any `semver` call a hook makes with it throws. A step that follows a range step migrates from the lowest version that range matched, which is the version the step before it reached.
		for (const fromVersion of fromVersions) {
			assert.ok(semver.valid(fromVersion), `${fromVersion} is not a valid version`);
		}

		assert.deepStrictEqual(fromVersions, ['0.0.0', '1.0.0']);
	});

	it('should report the lowest version a range step reached as the from version of the next step', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '1.0.0'}}});

		const fromVersions: string[] = [];

		new Conf({
			cwd,
			projectVersion: '2.0.0',
			beforeEachMigration(_store, context) {
				fromVersions.push(context.fromVersion);
			},
			migrations: {
				'>=1.5.0'() {},
				'1.8.0'() {},
			},
		});

		// The range step is recorded under no version at all, so the step after it is told the version the range reached rather than the version the file still records.
		assert.deepStrictEqual(fromVersions, ['1.0.0', '1.5.0']);
	});

	it('should report the whole context for a step that follows a range step', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '1.0.0'}}});

		const contexts: Array<Record<string, unknown>> = [];

		new Conf({
			cwd,
			projectVersion: '2.0.0',
			beforeEachMigration(_store, context) {
				contexts.push({...context});
			},
			migrations: {
				'>=1.5.0'() {},
				'1.8.0'() {},
			},
		});

		// A hook compares versions, so every field of the context is a version and never the range a step is named by.
		const pass = ['1.5.0', '1.8.0'];

		assert.deepStrictEqual(contexts, [
			{
				fromVersion: '1.0.0',
				toVersion: '1.5.0',
				finalVersion: '2.0.0',
				versions: pass,
			},
			{
				fromVersion: '1.5.0',
				toVersion: '1.8.0',
				finalVersion: '2.0.0',
				versions: pass,
			},
		]);
	});

	// `semver.minVersion()` answers with nothing when any branch of a disjunction matches nothing, even when another branch matches every version, so the hook was handed the range itself where a version is documented. A branch that matches nothing is not a version a step can run at, and the lowest version the range does match is.
	it('tells the hook the lowest version a range with a branch that matches nothing reaches', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '1.0.0'}}});

		const range = '^2 || >1.0.0 <1.0.0';
		const contexts: Array<Record<string, unknown>> = [];
		const conf = new Conf({
			cwd,
			projectVersion: '2.0.0',
			beforeEachMigration(_store, context) {
				contexts.push({...context});
			},
			migrations: {
				'1.5.0'(store) {
					store.set('phase', '1.5.0');
				},
				[range](store) {
					store.set('phase', range);
				},
			},
		});

		assert.deepStrictEqual(contexts.map(({toVersion}) => toVersion), ['1.5.0', '2.0.0']);
		assert.deepStrictEqual(contexts[1]!.versions, ['1.5.0', '2.0.0']);
		assert.strictEqual(conf.get('phase'), range);
		assert.strictEqual(getMigrationVersion(conf), '2.0.0');
	});

	// A range can match a version and still have no lowest version semver can name, which is what a range whose upper bound is a prerelease is: the prerelease above it is the only version it matches, so there is nothing lower to name and the version the project is at is the answer.
	it('tells the hook a version for a range that has no lowest one', () => {
		const range = '>1.0.0 <=1.0.1-0';
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '0.5.0'}}});

		const contexts: Array<Record<string, unknown>> = [];
		const conf = new Conf({
			cwd,
			projectVersion: '1.0.1-0',
			beforeEachMigration(_store, context) {
				contexts.push({...context});
			},
			migrations: {
				'1.0.0'(store) {
					store.set('first', true);
				},
				[range](store) {
					store.set('second', true);
				},
			},
		});

		assert.deepStrictEqual(contexts.map(({toVersion}) => toVersion), ['1.0.0', '1.0.1-0']);
		assert.strictEqual(conf.get('first'), true);
		assert.strictEqual(conf.get('second'), true);
	});
});

describe('a hook, the cache, the defaults and the schema together', () => {
	// A `defaults` option given a type of its own, since a value of one key is otherwise what names the store type, and a type named for that key has no room for the `schema` keys beside it.
	const defaults: Record<string, unknown> = {a: 'from-defaults'};

	const openWithHook = (cache: boolean): {conf: Conf; told: unknown[]; seenByStep: unknown[]} => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {old: true});

		const told: unknown[] = [];
		const seenByStep: unknown[] = [];
		let written = false;

		const conf = trackConf(new Conf({
			cwd,
			cache,
			projectVersion: '2.0.0',
			defaults,
			schema: {b: {type: 'string', default: 'from-schema'}},
			beforeEachMigration(_store, context) {
				told.push({...context});

				// A hook that writes, which is what it is given a store for, and once only so the second step is not handed it again.
				if (!written) {
					written = true;
					_store.set('fromHook', 'yes');
				}
			},
			migrations: {
				'1.0.0'(store) {
					store.set('first', true);
				},
				'2.0.0'(store) {
					seenByStep.push({fromHook: store.get('fromHook'), a: store.get('a'), b: store.get('b')});
					store.set('fromStep', store.get('fromHook') === 'yes');
				},
			},
		}));

		return {conf, told, seenByStep};
	};

	it('tells the hook and the step the same thing, whether the store is cached or not', () => {
		const withoutCache = openWithHook(false);
		const withCache = openWithHook(true);

		assert.deepStrictEqual(withCache.told, withoutCache.told);
		assert.deepStrictEqual(withCache.seenByStep, withoutCache.seenByStep);

		// The step sees what the hook wrote and what the `defaults` option gives, but not a `default` of the schema, which the store is validated with once the pass has run.
		assert.deepStrictEqual(withoutCache.seenByStep, [
			{fromHook: 'yes', a: 'from-defaults', b: undefined},
		]);
		assert.strictEqual(withoutCache.conf.get('fromStep'), true);
		assert.deepStrictEqual({...withoutCache.conf.store}, {
			old: true,
			a: 'from-defaults',
			fromHook: 'yes',
			first: true,
			fromStep: true,
			b: 'from-schema',
		});
		assert.deepStrictEqual({...withCache.conf.store}, {...withoutCache.conf.store});
	});
});
