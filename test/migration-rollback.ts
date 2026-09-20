/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-empty-function, no-new */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {Buffer} from 'node:buffer';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createMigrationTest,
	createExistingConfig,
	createTempDirectory,
	resetTrackedConfs,
	getMigrationVersion,
	readConfigFile,
	createMigrationOrderTracker,
	runRegisteredCleanups,
	skipAsRoot,
} from './_utilities.js';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a migration step that leaves a file carrying the encrypted separator', () => {
	// The rollback is what the error message promises, and what a failed read found is not a reason to leave the failed step's writes in the file.
	it('rolls the step back over bytes that are not text', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: 1});
		const filePath = path.join(cwd, 'config.json');
		const before = readConfigFile(filePath) as Record<string, unknown>;
		const unreadable = Buffer.concat([
			Buffer.from('0123456789abcdef'),
			Buffer.from(':'),
			Buffer.from([0xFF, 0xFE, 0xFD, 0x00]),
		]);

		assert.throws(() => new Conf<Record<string, unknown>>({
			cwd,
			clearInvalidConfig: true,
			projectVersion: '2.0.0',
			migrations: {
				'1.5.0'(store) {
					fs.writeFileSync(store.path, unreadable);
					store.set('half', true);
					throw new Error('boom');
				},
			},
		}), {message: /^Something went wrong during the migration!/});

		const after = readConfigFile(filePath) as Record<string, unknown>;
		assert.deepStrictEqual(after, before, 'the store the step started from');
		assert.strictEqual(after.half, undefined, 'the step that failed');
	});
});

describe('a migration step that leaves a file the store cannot read', () => {
	// The rollback is what the error message promises, so it is written over a file the failed step left unreadable. The backup here is the one the caller was promised is put back.
	for (const [name, options] of [
		['a `serialize` that writes something unreadable', {
			serialize: (value: Record<string, unknown>) => ('half' in value ? 'not json at all' : JSON.stringify(value, undefined, '\t')),
		}],
		['a `deserialize` that refuses the store the step wrote', {
			deserialize(text: string) {
				const store = JSON.parse(text) as Record<string, unknown>;
				if ('half' in store) {
					throw new SyntaxError('cannot read a migrated store');
				}

				return store;
			},
		}],
	] as Array<[string, Record<string, unknown>]>) {
		for (const clearInvalidConfig of [false, true]) {
			it(`rolls the step back over one ${name}, with clearInvalidConfig: ${String(clearInvalidConfig)}`, () => {
				const cwd = createTempDirectory();
				createExistingConfig(cwd, {seed: 1});
				const before = fs.readFileSync(path.join(cwd, 'config.json'), 'utf8');

				assert.throws(() => new Conf<Record<string, unknown>>({
					cwd,
					clearInvalidConfig,
					projectVersion: '2.0.0',
					migrations: {
						'1.5.0'(store) {
							store.set('half', true);
							throw new Error('boom');
						},
					},
					...options,
				}), {message: /^Something went wrong during the migration!.*boom$/});

				// The store the step started from is what the file holds again, and it is the one the option left there.
				const conf = new Conf<Record<string, unknown>>({cwd, clearInvalidConfig: true, ...options});
				assert.strictEqual(conf.get('seed'), 1, 'the store the step started from');
				assert.strictEqual(conf.get('half'), undefined, 'the step that failed');
				assert.deepStrictEqual(fs.readFileSync(path.join(cwd, 'config.json'), 'utf8'), before, 'the file the store held before the step');
			});
		}
	}
});

describe('a store holding a value that cannot be cloned, over migrations', () => {
	// The backup that a failed step is rolled back to is the store as it was read, so a value a custom `deserialize` hands back that cannot be copied, such as a function, is held by the backup as it is. A store with such a value opens whether a step runs over it or not, and a step that fails is still rolled back.
	const deserializeWithAFunction = function (text: string) {
		return Object.assign(
			JSON.parse(text) as Record<string, unknown>,
			{
				handler() {},
			},
		);
	};

	const migrations = {
		'1.5.0'(store: Conf) {
			store.set('migrated', true);
		},
	};

	it('opens a store that has no step to run', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: 1, __internal__: {migrations: {version: '1.0.0'}}});

		const conf = new Conf<Record<string, unknown>>({
			cwd,
			projectVersion: '2.0.0',
			migrations,
			deserialize: deserializeWithAFunction,
		});
		assert.strictEqual(conf.get('seed'), 1);
		assert.strictEqual(getMigrationVersion(conf), '2.0.0');
	});

	it('runs a step over it, and writes the store JSON can hold', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: 1, __internal__: {migrations: {version: '1.0.0'}}});

		const conf = new Conf<Record<string, unknown>>({
			cwd,
			projectVersion: '2.0.0',
			migrations,
			deserialize: deserializeWithAFunction,
		});
		assert.strictEqual(conf.get('migrated'), true);
		assert.strictEqual(getMigrationVersion(conf), '2.0.0');

		// A function has no JSON form, so the file holds the store without it and the store the deserializer hands back is where it is read.
		assert.deepStrictEqual(readConfigFile(conf.path), {seed: 1, migrated: true, __internal__: {migrations: {version: '2.0.0'}}});
	});

	it('rolls a step that fails back over a store holding a value that cannot be cloned', () => {
		const cwd = createTempDirectory();
		const filePath = `${cwd}/config.json`;
		createExistingConfig(cwd, {seed: 1, __internal__: {migrations: {version: '1.0.0'}}});

		assert.throws(() => new Conf<Record<string, unknown>>({
			cwd,
			projectVersion: '2.0.0',
			deserialize: deserializeWithAFunction,
			migrations: {
				'1.5.0'(store: Conf) {
					store.set('half', true);
					throw new Error('boom');
				},
			},
		}), {message: /Something went wrong during the migration/});

		// The step that failed is rolled back, so the store is the one the file held.
		assert.deepStrictEqual(readConfigFile(filePath), {seed: 1, __internal__: {migrations: {version: '1.0.0'}}});
	});
});

describe('the recorded version after a failed step', () => {
	it('restores the recorded version a failed migration wrote over', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: 1});

		const migrations = {
			'1.0.0'(store: Conf) {
				store.set('one', true);
			},
			'2.0.0'(store: Conf) {
				// The bookkeeping is the module's own, and a store written whole during a migration writes over it, so it is the rollback below that puts the recorded version back.
				store.store = {__internal__: {migrations: {version: '0.0.1'}}, hacked: true};
				throw new Error('boom');
			},
		};

		assert.throws(() => new Conf({cwd, projectVersion: '2.0.0', migrations}), {message: /Something went wrong during the migration/});

		// The step that failed is rolled back, and the bookkeeping with it, so the version stays where the last step that succeeded left it.
		const conf = new Conf({cwd});
		assert.strictEqual(getMigrationVersion(conf), '1.0.0');
		assert.strictEqual(conf.get('one'), true);
		assert.strictEqual(conf.get('hacked'), undefined);
	});

	it('keeps the recorded version a failed migration did not reach', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: 1, __internal__: {migrations: {version: '0.5.0'}}});

		const migrations = {
			'1.0.0'(store: Conf) {
				store.store = {__internal__: {migrations: {version: '9.9.9'}}};
				throw new Error('boom');
			},
		};

		assert.throws(() => new Conf({cwd, projectVersion: '1.0.0', migrations}), {message: /Something went wrong during the migration/});

		const conf = new Conf({cwd});
		assert.strictEqual(getMigrationVersion(conf), '0.5.0');
	});
});

describe('a failed step and the file', () => {
	it('should not read the config file again just to take the rollback snapshot', () => {
		// Every step reads the file once to record the version it just ran. It must not read it a second time to take the rollback snapshot, because the file it just wrote is the snapshot.
		const countReadsForPass = (stepCount: number): number => {
			const directory = createTempDirectory();
			createExistingConfig(directory, {__internal__: {migrations: {version: '1.0.0'}}});

			const migrations: Record<string, () => void> = {};
			for (let index = 0; index < stepCount; index++) {
				migrations[`${index + 2}.0.0`] = () => {};
			}

			const original = fs.readFileSync;
			let reads = 0;
			fs.readFileSync = ((...arguments_: unknown[]) => {
				reads++;
				return Reflect.apply(original, fs, arguments_) as unknown;
			}) as unknown as typeof fs.readFileSync;

			try {
				new Conf({cwd: directory, projectVersion: '9.0.0', migrations});
			} finally {
				fs.readFileSync = original;
			}

			return reads;
		};

		// Two more steps, so two more reads.
		assert.strictEqual(countReadsForPass(3) - countReadsForPass(1), 2);
	});

	it('should keep the changes of a successful range step when a later step fails', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: true});

		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'>=1.0.0'(store) {
						store.set('fromRange', true);
					},
					'1.5.0'(store) {
						store.set('fromVersion', true);
						throw new Error('the later step failed');
					},
				},
			});
		}, /the later step failed/);

		const conf = new Conf({cwd, projectVersion: '2.0.0'});

		// The range step succeeded, so its changes stay.
		assert.strictEqual(conf.get('fromRange'), true);
		// The step that failed is rolled back.
		assert.strictEqual(conf.get('fromVersion'), undefined);
		// A range is never recorded, so there is nothing to resume from and the pass runs again.
		assert.strictEqual(getMigrationVersion(conf), undefined);
	});

	// The rollback puts back the file as the last step that succeeded left it, so a write another store made before that point is in the backup and stays, and a write it made while the failing step ran is not and goes back to where it was. The version goes with whichever of the two the file is left holding.
	it('should keep what another store wrote before the last successful step, and rewind the version to that step', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '0.5.0'}}});

		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '3.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('outer', true);
						// Another store writes the file while this step runs, so the write is in the backup taken after it.
						new Conf({
							cwd,
							projectVersion: '5.0.0',
							migrations: {
								'5.0.0'(inner) {
									inner.set('concurrent', 'before the backup');
								},
							},
						});
					},
					'2.0.0'() {
						throw new Error('the last step failed');
					},
				},
			});
		}, /the last step failed/);

		const data = readConfigFile(path.join(cwd, 'config.json')) as Record<string, unknown>;
		assert.strictEqual(data.concurrent, 'before the backup');
		// The version the write above recorded is kept with it, since it is what the file is left holding.
		assert.strictEqual(getMigrationVersion({path: path.join(cwd, 'config.json')}), '5.0.0');
	});

	it('should rewind what another store wrote while the failing step ran, and let its step run again', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '0.5.0'}}});

		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '3.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('outer', true);
					},
					'2.0.0'() {
						// Another store writes the file while THIS step runs, so the write is not in the backup.
						new Conf({
							cwd,
							projectVersion: '5.0.0',
							migrations: {
								'5.0.0'(inner) {
									inner.set('concurrent', 'during the failing step');
								},
							},
						});
						throw new Error('the last step failed');
					},
				},
			});
		}, /the last step failed/);

		const data = readConfigFile(path.join(cwd, 'config.json')) as Record<string, unknown>;
		assert.strictEqual(data.concurrent, undefined);
		// The version is the one the last step that succeeded recorded, not the one the write above recorded.
		assert.strictEqual(getMigrationVersion({path: path.join(cwd, 'config.json')}), '1.0.0');

		// The rewind is what puts that store's data back: its step runs again on the next open.
		const conf = new Conf({
			cwd,
			projectVersion: '5.0.0',
			migrations: {
				'5.0.0'(inner) {
					inner.set('concurrent', 'put back');
				},
			},
		});
		assert.strictEqual(conf.get('concurrent'), 'put back');
	});

	// The rollback writes the store the file held before the step, which is a write like any other and reports a change of its own. A listener that writes a whole store on that change is a write like any other too, and it keeps the bookkeeping the file holds, since the flag that tells a rollback to skip that read is about the write it was set for and not about the change that write reports.
	it('keeps the bookkeeping for a change listener that writes during the rollback', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {a: 1, __internal__: {migrations: {version: '0.5.0'}}});

		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'(store) {
						// Registered before the step's own write, so it is reached for that one and for the rollback's.
						let reached = 0;
						store.onDidAnyChange(() => {
							reached++;
							if (reached === 2) {
								store.store = {a: 1, fromListener: true};
							}
						});

						store.set('migrated', true);
						throw new Error('boom');
					},
				},
			});
		}, /boom/);

		// The file holds the version it held before the step, which is what the rollback puts back.
		assert.strictEqual(getMigrationVersion({path: path.join(cwd, 'config.json')}), '0.5.0');

		// A step from before the version the file recorded does not run again, since the rollback rewound to that version rather than to nothing.
		const ran: string[] = [];
		new Conf({
			cwd,
			projectVersion: '1.0.0',
			migrations: {
				'0.1.0'() {
					ran.push('0.1.0');
				},
				'0.6.0'() {
					ran.push('0.6.0');
				},
			},
		});

		assert.deepStrictEqual(ran, ['0.6.0']);
	});
});

describe('a failed step', () => {
	// A store that recorded a version below the range is one the range is entered from, which is not the store with no recorded version at all.
	it('does not repeat a range a later step failed after, with the store left outside the range', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {__internal__: {migrations: {version: '0.5.0'}}});

		let runs = 0;
		let shouldFail = true;
		const migrations = {
			'>=1.0.0'(store: Conf) {
				runs++;
				store.set('runs', runs);
			},
			'1.5.0'() {
				if (shouldFail) {
					throw new Error('the later step failed');
				}
			},
		};

		assert.throws(() => {
			new Conf({cwd, projectVersion: '2.0.0', migrations});
		}, /the later step failed/);

		assert.throws(() => {
			new Conf({cwd, projectVersion: '2.0.0', migrations});
		}, /the later step failed/);

		shouldFail = false;
		const conf = new Conf({cwd, projectVersion: '2.0.0', migrations});

		assert.strictEqual(runs, 1);
		assert.strictEqual(conf.get('runs'), 1);
	});

	it('migrations - error rollback behavior', () => {
		const {conf, cwd, configPath} = createMigrationTest({
			projectVersion: '1.0.0',
			initialData: {stable: 'data'},
			migrations: {
				'1.0.0'(store) {
					store.set('initial', true);
				},
			},
		});

		// Verify persisted data includes newly migrated fields
		const persisted = readConfigFile(configPath) as Record<string, unknown>;
		assert.strictEqual(persisted.initial, true);

		// Migration failure should preserve original state
		assert.throws(() => {
			createMigrationTest({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						store.set('initial', true);
					},
					'2.0.0'(store) {
						store.set('partial', true);
						store.delete('stable');
						throw new Error('Intentional failure');
					},
				},
			});
		}, /Intentional failure/);

		// Original data structure should be preserved, in the file and in a store opened on it afterwards
		assert.deepStrictEqual(readConfigFile(configPath), persisted);
		const reopened = new Conf({cwd});
		assert.strictEqual(reopened.get('stable'), 'data');
		assert.strictEqual(reopened.get('initial'), true);
		assert.strictEqual(reopened.has('partial'), false);
		assert.strictEqual(getMigrationVersion(conf), '1.0.0');
	});

	it('failed migration wraps the original message', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {});
		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'() {
						throw new Error('boom-original');
					},
				},
			});
		}, {message: /Something went wrong during the migration.*boom-original/});
	});

	it('wraps non-Error migration throws', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {});
		assert.throws(() => {
			new Conf({
				cwd,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'() {
					// eslint-disable-next-line @typescript-eslint/only-throw-error
						throw 'string-failure';
					},
				},
			});
		}, {message: /Something went wrong during the migration.*string-failure/});
	});

	it('migrations - should recover when the file holds a range version from an earlier failure', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(
			path.join(cwd, 'config.json'),
			JSON.stringify({__internal__: {migrations: {version: '>=1.0.0'}}}),
		);

		// This used to throw `Invalid Version: >=1.0.0`, leaving the store impossible to open.
		const conf = new Conf({
			cwd,
			projectVersion: '2.0.0',
			migrations: {
				'1.5.0'(store) {
					store.set('migrated', true);
				},
			},
		});

		assert.strictEqual(conf.get('migrated'), true);
		assert.strictEqual(getMigrationVersion(conf), '2.0.0');
	});

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

	it('does not repeat a successful range when a later migration fails', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd);
		let rangeMigrationRuns = 0;
		let laterMigrationShouldFail = true;

		const migrations = {
			'>=1.0.0'(store: Conf) {
				rangeMigrationRuns++;
				store.set('rangeMigrationRuns', (store.get('rangeMigrationRuns', 0) as number) + 1);
			},
			'1.5.0'() {
				if (laterMigrationShouldFail) {
					throw new Error('a later migration failed');
				}
			},
		};

		assert.throws(() => {
			new Conf({cwd, projectVersion: '2.0.0', migrations});
		}, /a later migration failed/);
		assert.strictEqual(new Conf({cwd}).get('rangeMigrationRuns'), 1);

		assert.throws(() => {
			new Conf({cwd, projectVersion: '2.0.0', migrations});
		}, /a later migration failed/);

		assert.strictEqual(rangeMigrationRuns, 1);
		assert.strictEqual(new Conf({cwd}).get('rangeMigrationRuns'), 1);
		assert.strictEqual(getMigrationVersion(new Conf({cwd, projectVersion: '2.0.0'})), undefined);

		laterMigrationShouldFail = false;
		const migrated = new Conf({cwd, projectVersion: '2.0.0', migrations});

		assert.strictEqual(rangeMigrationRuns, 1);
		assert.strictEqual(migrated.get('rangeMigrationRuns'), 1);
		assert.strictEqual(getMigrationVersion(migrated), '2.0.0');

		const data = readConfigFile(migrated.path) as {__internal__: {migrations: {completedRanges?: string[]}}};
		assert.deepStrictEqual(data.__internal__.migrations.completedRanges, ['>=1.0.0']);
	});

	it('keeps a completed range through a downgrade after a later failure', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd);
		let rangeMigrationRuns = 0;
		let laterMigrationShouldFail = true;
		const migrations = {
			'>=1.0.0'(store: Conf) {
				rangeMigrationRuns++;
				store.set('rangeMigrationRuns', rangeMigrationRuns);
			},
			'1.5.0'() {
				if (laterMigrationShouldFail) {
					throw new Error('a later migration failed');
				}
			},
		};

		assert.throws(() => {
			new Conf({cwd, projectVersion: '2.0.0', migrations});
		}, /a later migration failed/);

		new Conf({cwd, projectVersion: '0.5.0', migrations});
		laterMigrationShouldFail = false;
		const migrated = new Conf({cwd, projectVersion: '2.0.0', migrations});

		assert.strictEqual(rangeMigrationRuns, 1);
		assert.strictEqual(migrated.get('rangeMigrationRuns'), 1);
		assert.strictEqual(getMigrationVersion(migrated), '2.0.0');
	});
});

describe('a construction that fails', () => {
	it('migrations error handling - a construction that fails validation leaves the file as it was', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({seed: 1, port: 'oops'}));
		const before = fs.readFileSync(path.join(cwd, 'config.json'));

		const options = {
			cwd,
			projectVersion: '2.0.0',
			schema: {port: {type: 'number'}},
			defaults: {extra: 'present'},
			migrations: {
				'1.5.0'(store: Conf) {
					store.set('migrated', true);
				},
			},
		};

		// The defaults and the migration result are written, and the version is recorded with them, before the validator sees the store. A construction that cannot finish must not leave any of that behind, the way the branch without migrations already keeps the file when validation fails.
		assert.throws(() => {
			new Conf<Record<string, unknown>>(options);
		}, {message: /`port` must be number/});
		assert.deepStrictEqual(fs.readFileSync(path.join(cwd, 'config.json')), before);

		// A retry sees the file as the first attempt found it and fails the same way, since the failed attempt remembered nothing.
		assert.throws(() => {
			new Conf<Record<string, unknown>>(options);
		}, {message: /`port` must be number/});
		assert.deepStrictEqual(fs.readFileSync(path.join(cwd, 'config.json')), before);
	});

	it('migrations error handling - a construction that fails validation does not leave a new file behind', () => {
		const cwd = createTempDirectory();
		const options = {
			cwd,
			projectVersion: '1.0.0',
			rootSchema: {required: ['port']},
			schema: {port: {type: 'number'}},
			migrations: {
				'1.0.0'() {},
			},
		};

		// A store of its own has nothing to migrate, but the version still records itself in a file, which a construction that cannot finish takes back out.
		assert.throws(() => {
			new Conf<Record<string, unknown>>(options);
		}, /port/);
		assert.strictEqual(fs.existsSync(path.join(cwd, 'config.json')), false);
	});

	it('migrations error handling - a failed validation restores an encrypted store byte for byte', () => {
		const cwd = createTempDirectory();
		const options = {cwd, encryptionKey: 'secret', encryptionAlgorithm: 'aes-256-gcm'} as const;
		const conf = new Conf(options);
		conf.set('seed', 1);
		const before = fs.readFileSync(conf.path);

		const failing = {
			...options,
			schema: {seed: {type: 'string'}},
			migrations: {
				'1.0.0'(store: Conf) {
					store.set('migrated', true);
				},
			},
			projectVersion: '1.0.0',
		};

		assert.throws(() => {
			new Conf<Record<string, unknown>>(failing);
		}, {message: /`seed` must be string/});

		// What goes back is the encrypted bytes themselves, so a store with the same key still reads what it held before the failed attempt.
		assert.ok(before.equals(fs.readFileSync(conf.path)));
		assert.strictEqual(new Conf(options).get('seed'), 1);
	});
});

describe('a construction that cannot finish', () => {
	it('puts back a file the `configFileMode` option leaves read-only, and reports why it could not finish', {skip: process.platform === 'win32' || skipAsRoot}, () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		const original = JSON.stringify({a: 1, __internal__: {migrations: {version: '0.1.0'}}});
		fs.writeFileSync(configPath, original);

		assert.throws(() => {
			new Conf({
				cwd,
				configFileMode: 0o444,
				projectVersion: '1.0.0',
				schema: {a: {type: 'number'}},
				migrations: {
					'1.0.0'(store) {
						store.set('a', 'not a number');
					},
				},
			});
		}, {message: /Config schema violation: `a` must be number/});

		assert.equal(fs.readFileSync(configPath, 'utf8'), original);
	});
});
