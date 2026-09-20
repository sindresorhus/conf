/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/naming-convention -- A value read back is `any`, and a step of a migration is keyed by its version. */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {
	describe,
	it,
	afterEach,
	mock,
} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	skipAsRoot,
	permissionBits,
	withUmask,
	withSnap,
	resetTrackedConfs,
	createResolvedTempDirectory,
	runRegisteredCleanups,
	createExistingConfig,
	trackConf,
} from './_utilities.js';

// The two write paths put the mode on differently, one by creating a temporary file with it and one by a `chmod` after the write, so the same file has to end at the same mode either way.
const writePaths = [
	['a write through a temporary file', false],
	['a write in place', true],
] as Array<[string, boolean]>;

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('the mode of the config file', () => {
	for (const [name, snap] of writePaths) {
		it(`is the mode the option names with ${name}, whatever mode the file already had`, () => {
			withUmask(0o022, () => {
				withSnap(snap, () => {
					for (const configFileMode of [0o400, 0o600, 0o640, 0o644, 0o700, 0o755]) {
						for (const alreadyThere of [undefined, 0o444, 0o600, 0o644, 0o666]) {
							const cwd = createTempDirectory();
							const file = path.join(cwd, 'config.json');
							if (alreadyThere !== undefined) {
								fs.writeFileSync(file, '{"kept":true}');
								fs.chmodSync(file, alreadyThere);
							}

							const conf = new Conf<Record<string, unknown>>({cwd, configFileMode});
							// Two writes, since the second one is the one that opens a file the first one left at the mode the option names.
							conf.set('added', true);
							conf.set('added', false);

							const where = `configFileMode: 0o${configFileMode.toString(8)}, already: ${alreadyThere === undefined ? '-' : `0o${alreadyThere.toString(8)}`}`;
							assert.strictEqual(permissionBits(file), configFileMode, where);
							// A fresh store reads the file back, which is what a mode the owner cannot read is not able to do.
							assert.strictEqual(new Conf<Record<string, unknown>>({cwd}).get('added'), false, where);
						}
					}
				});
			});
		});

		it(`is what the umask leaves of the mode the option names with ${name}`, () => {
			for (const umask of [0, 0o002, 0o022, 0o077]) {
				withUmask(umask, () => {
					withSnap(snap, () => {
						for (const configFileMode of [0o400, 0o600, 0o644, 0o666, 0o777, 0o7777]) {
							const cwd = createTempDirectory();
							const conf = new Conf<Record<string, unknown>>({cwd, configFileMode});
							conf.set('a', 1);

							// eslint-disable-next-line no-bitwise
							const expected = configFileMode & ~umask;
							const where = `umask: 0o${umask.toString(8)}, configFileMode: 0o${configFileMode.toString(8)}`;
							// eslint-disable-next-line no-bitwise
							assert.notStrictEqual(expected & 0o400, 0, `${where} reduces to a mode the owner cannot read`);
							assert.strictEqual(permissionBits(conf.path), expected, where);
							assert.strictEqual(new Conf<Record<string, unknown>>({cwd}).get('a'), 1, where);
						}
					});
				});
			}
		});

		// The umask has no bit for the three above the nine permission bits, so it cannot reduce one of them and the mode the option names is the mode the file gets.
		it(`keeps the setuid, setgid and sticky bits the option names with ${name}`, () => {
			withUmask(0o022, () => {
				withSnap(snap, () => {
					for (const configFileMode of [0o4755, 0o2755, 0o1755, 0o6755]) {
						const cwd = createTempDirectory();
						const conf = new Conf<Record<string, unknown>>({cwd, configFileMode});
						conf.set('a', 1);

						assert.strictEqual(permissionBits(conf.path), configFileMode, `configFileMode: 0o${configFileMode.toString(8)}`);
					}
				});
			});
		});

		// A string of octal digits is read as the number it stands for, which puts the string form and the number form in the same place rather than one of them reaching a mode the other refuses. The umask reduces it the way it reduces the number, so `7777` is the highest mode a string can name and loses the group and other write bits.
		it(`takes a mode given as a string of octal digits as the number it stands for with ${name}`, () => {
			withUmask(0o022, () => {
				withSnap(snap, () => {
					for (const [asString, asNumber] of [['600', 0o600], ['400', 0o400], ['644', 0o644], ['0644', 0o644], ['4755', 0o4755], ['7777', 0o7755]] as Array<[string, number]>) {
						const cwd = createTempDirectory();
						const conf = new Conf<Record<string, unknown>>({cwd, configFileMode: asString as unknown as number});
						conf.set('a', 1);

						assert.strictEqual(permissionBits(conf.path), asNumber, `\`${asString}\``);
					}
				});
			});
		});

		it(`is left as it was with ${name} when no mode is given`, () => {
			withUmask(0o022, () => {
				withSnap(snap, () => {
					const cwd = createTempDirectory();
					const file = path.join(cwd, 'config.json');
					fs.writeFileSync(file, '{"kept":true}');
					fs.chmodSync(file, 0o600);

					const conf = new Conf<Record<string, unknown>>({cwd});
					conf.set('added', true);

					assert.strictEqual(permissionBits(file), 0o600);
				});
			});
		});
	}

	// A construction that cannot finish and wrote nothing leaves the file as it found it, so the mode the option names is not given to a file the store never wrote. A migration that wrote the file has already given it that mode, which the restore does not take back.
	it('leaves the mode of a file a construction that cannot finish puts back', () => {
		for (const [name, snap] of writePaths) {
			withSnap(snap, () => {
				const cwd = createTempDirectory();
				createExistingConfig(cwd, {a: 'not a number', __internal__: {migrations: {version: '2.0.0'}}});
				const file = path.join(cwd, 'config.json');
				fs.chmodSync(file, 0o644);

				assert.throws(() => new Conf({
					cwd,
					configFileMode: 0o600,
					projectVersion: '2.0.0',
					migrations: {},
					schema: {a: {type: 'number'}},
				}), {message: /`a` must be number/}, name);

				assert.strictEqual(permissionBits(file), 0o644, name);
			});
		}
	});

	// Reading the umask sets it to `0` for a moment, so a file another part of the process creates then is created without it. A store with no `configFileMode` has no use for the umask, so it does not read it.
	it('does not read the process umask without the `configFileMode` option', () => {
		const umask = mock.method(process, 'umask');
		try {
			const conf = new Conf({cwd: createTempDirectory()});
			conf.set('a', 1);
			assert.strictEqual(umask.mock.callCount(), 0);
		} finally {
			umask.mock.restore();
		}
	});

	// A umask that leaves the owner read bit alone is the one the file is created with, and the store reads the file back.
	it('takes a process umask that leaves the owner read bit in the file', () => {
		for (const [umask, expected] of [[0, 0o666], [0o002, 0o664], [0o022, 0o644], [0o077, 0o600], [0o027, 0o640]] as Array<[number, number]>) {
			withUmask(umask, () => {
				for (const [name, snap] of writePaths) {
					withSnap(snap, () => {
						const cwd = createTempDirectory();
						const conf = new Conf<Record<string, unknown>>({cwd});
						conf.set('a', 1);

						assert.strictEqual(permissionBits(conf.path), expected, `umask: 0o${umask.toString(8)}, ${name}`);
						assert.strictEqual(new Conf<Record<string, unknown>>({cwd}).get('a'), 1, `umask: 0o${umask.toString(8)}, ${name}`);

						// A mode given as `null` is one that is not given.
						const nullMode = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), configFileMode: null as unknown as number});
						nullMode.set('a', 1);
						assert.strictEqual(permissionBits(nullMode.path), expected, `configFileMode: null, umask: 0o${umask.toString(8)}, ${name}`);
					});
				}
			});
		}
	});
	// The umask belongs to the process, not to a store, so a store that reads it to work out the mode of its file leaves it as it found it. `process.umask()` answers with the umask and `process.umask(mask)` sets one, so a store that passed the umask it read back would change the umask of the whole process.
	for (const [name, snap] of writePaths) {
		it(`leaves the umask of the process alone with ${name}`, () => {
			for (const umask of [0, 0o022, 0o077]) {
				withUmask(umask, () => {
					withSnap(snap, () => {
						const cwd = createTempDirectory();
						const conf = new Conf<Record<string, unknown>>({cwd, configFileMode: 0o600});
						conf.set('a', 1);

						// eslint-disable-next-line @typescript-eslint/no-deprecated -- The same call the constructor makes, and the point is that it is this one and does not change it.
						assert.strictEqual(process.umask(), umask, `umask: 0o${umask.toString(8)}`);

						// A file the process creates afterwards is one the umask it still has decides the mode of.
						const probe = path.join(cwd, 'probe');
						fs.writeFileSync(probe, 'x');
						// eslint-disable-next-line no-bitwise
						assert.strictEqual(permissionBits(probe), 0o666 & ~umask, `umask: 0o${umask.toString(8)}`);
					});
				});
			}
		});
	}

	// The option names the mode the file is given on every write, so a second store over the same file with a mode of its own leaves the mode it names rather than the one the first store did.
	for (const [name, snap] of writePaths) {
		it(`leaves the mode the second of two stores names with ${name}`, () => {
			withUmask(0o022, () => {
				withSnap(snap, () => {
					const cwd = createTempDirectory();
					const first = new Conf<Record<string, unknown>>({cwd, configFileMode: 0o600});
					first.set('fromFirst', true);
					assert.strictEqual(permissionBits(first.path), 0o600);

					const second = new Conf<Record<string, unknown>>({cwd, configFileMode: 0o640});
					second.set('fromSecond', true);

					assert.strictEqual(permissionBits(second.path), 0o640);
					// The first store's data is still there, since the second write read the file before it wrote over it.
					assert.strictEqual(new Conf<Record<string, unknown>>({cwd}).get('fromFirst'), true);
					assert.strictEqual(new Conf<Record<string, unknown>>({cwd}).get('fromSecond'), true);
				});
			});
		});
	}
});

describe('a write that goes wrong', () => {
	// A write that throws leaves the path it was going to write behind as it is. The mode the option names is the mode a write that goes in gives the file, so a write that did not go in has no mode of its own to put on anything, and a `chmod` of a path that is not the file the write was making changes the mode of a directory the caller made.
	it('leaves a directory standing at the config path at the mode the caller made it at', () => {
		withSnap(true, () => {
			const cwd = createTempDirectory();
			const file = path.join(cwd, 'config.json');
			// The `serialize` option is the caller's own code and runs between the read the write does first and the write itself, which is where the file the write opens stops being one it can be written to.
			let replaceWithDirectory = false;
			const conf = new Conf<Record<string, unknown>>({
				cwd,
				configFileMode: 0o600,
				serialize(value) {
					if (replaceWithDirectory) {
						fs.rmSync(file, {recursive: true});
						fs.mkdirSync(file, {mode: 0o500});
					}

					return JSON.stringify(value, undefined, '\t');
				},
			});

			conf.set('kept', true);
			replaceWithDirectory = true;

			assert.throws(() => {
				conf.set('added', true);
			}, {code: 'EISDIR'});

			assert.strictEqual(permissionBits(file), 0o500, 'the mode the directory was left at');
		});
	});

	it('leaves no temporary file behind and no file damaged when the write throws', {skip: skipAsRoot}, () => {
		withSnap(false, () => {
			const cwd = createTempDirectory();
			const file = path.join(cwd, 'config.json');
			fs.writeFileSync(file, '{"kept":true}');
			// A directory the process cannot write a temporary file into is the one thing a write through a temporary file cannot do, and the write fails before the file it was writing is touched.
			fs.chmodSync(cwd, 0o500);

			try {
				const conf = new Conf<Record<string, unknown>>({cwd});
				assert.throws(() => {
					conf.set('added', true);
				}, {code: 'EACCES'});

				assert.deepStrictEqual(fs.readdirSync(cwd), ['config.json']);
				assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"kept":true}');
			} finally {
				fs.chmodSync(cwd, 0o700);
			}
		});
	});
});

describe('a write in place that throws', () => {
	// The write opens the file it writes, and a mode without the owner write bit refuses that, so the write bit is given back for the write and the mode the file had is given back to it afterwards. A write that throws leaves the file it was going to write behind as it is, so the write bit given for it is taken back with it rather than left on a file nobody asked for it to be more writable.
	it('gives the mode a file was widened to back when the write throws', () => {
		withSnap(true, () => {
			const cwd = createResolvedTempDirectory();
			const configPath = path.join(cwd, 'config.json');
			// The `serialize` option is the caller's own code and runs between the read the write does first and the write itself, which is where the file the write opens stops being one it can be written to. A directory a caller left without the write bit is the one thing a write cannot go into on any platform, whatever the user it runs as.
			let breakTheFile = false;
			const conf = new Conf<Record<string, unknown>>({
				cwd,
				serialize(value) {
					if (breakTheFile) {
						fs.rmSync(configPath, {recursive: true});
						fs.mkdirSync(configPath, {mode: 0o500});
					}

					return JSON.stringify(value, undefined, '\t');
				},
			});

			conf.set('kept', true);
			fs.chmodSync(configPath, 0o444);
			breakTheFile = true;

			assert.throws(() => {
				conf.set('added', true);
			}, {code: 'EISDIR'});

			assert.strictEqual(permissionBits(configPath), 0o500, 'the mode the file was left at');
		});
	});
});

describe('a `configFileMode` that is not a mode', () => {
	it('refuses a `configFileMode` that is not a number or a string of octal digits', () => {
		// `fs` reads a string as an octal number and stops at the first character that is not one, so `0o644` would reach it as `0`. Only a string of octal digits is read, and a value of another type is refused with it.
		const refusedModes: unknown[] = ['128', '0o644', 'nope', {}, true];
		for (const configFileMode of refusedModes) {
			assert.throws(() => {
				// eslint-disable-next-line no-new
				new Conf({cwd: createTempDirectory(), configFileMode: configFileMode as number});
			}, {message: /`configFileMode` option/}, `configFileMode: ${JSON.stringify(configFileMode)}`);
		}
	});

	it('refuses invalid configFileMode values', () => {
		// A number that is not a mode the file system takes would leave a file nobody asked for, and one that names a mode outside what the kernel stores is not a mode at all.
		for (const bad of ['999', '0o644', 'abc', {}, true, Number.NaN, Infinity, -Infinity, -1, 0o7_7777, 420.5] as any[]) {
			assert.throws(() => {
				// eslint-disable-next-line no-new
				new Conf({cwd: createTempDirectory(), configFileMode: bad});
			}, {message: /configFileMode/});
		}
	});

	it('refuses a mode that is not a whole number before the file is written', () => {
		for (const bad of [Number.NaN, Infinity, -1, 0o7_7777, 420.5, '10000', '77777777777', '99999999999999999999999999'] as any[]) {
			assert.throws(() => new Conf({cwd: createTempDirectory(), configFileMode: bad}), {name: 'TypeError', message: /configFileMode/});
		}
	});

	// A file the owner cannot read is not one the store that wrote it can read back, not even by its owner, so a store written one cannot be read again and every later write fails with `EACCES`. There is nothing such a mode can be for, so it is refused where it can be reported rather than left to fail on the first read after the first write.
	it('refuses a `configFileMode` that leaves the file unreadable by its owner', () => {
		withUmask(0o022, () => {
			for (const configFileMode of [
				0,
				'0',
				'000',
				// A mode the umask reduces to nothing at all.
				0o020,
				'020',
				0o002,
				// A mode that is not nothing but has no owner read bit either.
				0o200,
				'200',
				0o222,
				0o040,
			]) {
				assert.throws(() => {
					// eslint-disable-next-line no-new
					new Conf({cwd: createTempDirectory(), configFileMode: configFileMode as number});
				}, {name: 'TypeError', message: /`configFileMode` option must give the file a mode its owner can read/}, `configFileMode: ${JSON.stringify(configFileMode)}`);
			}
		});
	});
});

describe('a write in place over a file an earlier run left', () => {
	// The in-place write opens the file it is writing, so a mode that leaves the owner without the write bit stops the second write, where the atomic write renames a temporary file over it and the mode of the file that is there does not come into it.
	// A file left read-only by an earlier run refuses the write that opens it, where the atomic write renames a temporary file over it and never does. A store with no `configFileMode` is in the same position as one whose mode it has, since the file is the one the earlier run left.
	it('writes in place over a file an earlier run left read-only', () => {
		withSnap(true, () => {
			const cwd = createTempDirectory();
			const seeded = new Conf<Record<string, unknown>>({cwd, configFileMode: 0o400});
			seeded.set('kept', 'value');

			const second = new Conf<Record<string, unknown>>({cwd});
			second.set('added', 'value');
			assert.strictEqual(second.get('kept'), 'value');
			assert.strictEqual(second.get('added'), 'value');

			// The mode the file had is the one a temporary file is given, which is what the atomic write leaves it at and what the in-place write has to match.
			assert.strictEqual(permissionBits(second.path), 0o400);
		});
	});
});

describe('the mode a file is given, beside a key and a pass of migrations', () => {
	it('leaves the mode the option names on every write, of an encrypted file that is already there', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {old: true});
		const file = path.join(cwd, 'config.json');
		fs.chmodSync(file, 0o644);

		const ran: string[] = [];
		const migrations: Record<string, (store: Conf) => void> = {
			'1.0.0'(store) {
				ran.push('1.0.0');
				store.set('one', 1);
			},
			'2.0.0'(store) {
				ran.push('2.0.0');
				store.set('two', 2);
			},
		};

		const conf = trackConf(new Conf({
			cwd,
			configFileMode: 0o600,
			encryptionKey: 'a key',
			projectVersion: '2.0.0',
			migrations,
		}));

		assert.strictEqual(permissionBits(file), 0o600);
		assert.deepStrictEqual([...conf], [
			['old', true],
			['one', 1],
			['two', 2],
		]);

		conf.set('three', 3);
		assert.strictEqual(permissionBits(file), 0o600);

		// The bookkeeping is inside the encrypted file, so a later start is the one that says whether it was kept.
		const later = trackConf(new Conf<Record<string, unknown>>({
			cwd,
			configFileMode: 0o600,
			encryptionKey: 'a key',
			projectVersion: '2.0.0',
			migrations,
		}));

		assert.deepStrictEqual(ran, ['1.0.0', '2.0.0']);
		assert.strictEqual(later.get('three'), 3);
		assert.strictEqual(permissionBits(file), 0o600);
	});
});
