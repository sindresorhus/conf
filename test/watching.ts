import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {pEvent} from 'p-event';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	trackConf,
	runRegisteredCleanups,
	resetTrackedConfs,
	createNullProtoObject,
	skipAsRoot,
	skipWatching,
	nextChange,
	untilQuiet,
	settle,
	withPollingWatcher,
	untilWatching,
	createExistingConfig,
} from './_utilities.js';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a watching store', () => {
	it('a self-write with `watch` reports the change once', {skip: skipWatching}, async () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), watch: true, cache: true}));
		let changes = 0;
		conf.events.addEventListener('change', () => {
			changes++;
		});

		conf.set('foo', 0);
		// The watcher reports after a debounce, so a write from before it is settled must not be counted here.
		await untilQuiet(() => changes);
		changes = 0;

		// The `store` setter reports the write, so the watcher must not report the same file the instance itself wrote.
		conf.set('foo', 1);
		await untilQuiet(() => changes);
		assert.strictEqual(changes, 1);

		// A change another process made is still reported, which is also what shows the watcher was there to report the write above.
		const change = nextChange(conf);
		fs.writeFileSync(conf.path, JSON.stringify({foo: 2}));
		await change;
		await untilQuiet(() => changes);
		assert.strictEqual(changes, 2);
	});

	it('reports a change that comes back to what the instance last wrote', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const one = trackConf(new Conf({cwd, watch: true, cache: true}));
		const two = trackConf(new Conf({cwd, watch: true, cache: true}));

		let reported = 0;
		one.events.addEventListener('change', () => {
			reported++;
		});

		one.set('a', 1);
		await untilQuiet(() => reported);
		assert.strictEqual(reported, 1, 'the write of this store is reported once');

		let change = nextChange(one);
		two.set('a', 2);
		await change;
		await untilQuiet(() => reported);
		assert.strictEqual(reported, 2, 'the first change another store made is reported');

		// A change back to the exact bytes the instance last wrote is still a change, and the cache has to be dropped for it.
		change = nextChange(one);
		two.set('a', 1);
		await change;
		await untilQuiet(() => reported);
		assert.strictEqual(reported, 3, 'the change back to the same bytes is reported');
		assert.strictEqual(one.get('a'), 1);
		assert.deepStrictEqual({...one.store}, {a: 1});
	});

	it('reports a file that is deleted and written back with the same bytes', {skip: skipWatching}, async () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), watch: true, cache: true}));
		let reported = 0;
		conf.events.addEventListener('change', () => {
			reported++;
		});

		conf.set('a', 1);
		await untilQuiet(() => reported);
		assert.strictEqual(reported, 1, 'the write of this store is reported once');
		const written = fs.readFileSync(conf.path);

		let change = nextChange(conf);
		fs.rmSync(conf.path);
		await change;
		await untilQuiet(() => reported);
		assert.strictEqual(reported, 2, 'the deletion is reported');

		// The file comes back with the exact bytes this store last wrote, which is a change the watcher cannot leave unreported.
		change = nextChange(conf);
		fs.writeFileSync(conf.path, written);
		await change;
		await untilQuiet(() => reported);
		assert.strictEqual(reported, 3, 'the file written back with the same bytes is reported');
		assert.strictEqual(conf.get('a'), 1);
	});

	it('`watch` option watches for config file changes by another process', {skip: skipWatching}, async () => {
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

		await untilWatching();
		const changePromise = nextChange(conf1);

		conf2.set('foo', '🐴');

		await changePromise;
		assert.strictEqual(checks, 1);
	});

	it('`watch` option watches for config file changes by file write', {skip: skipWatching}, async () => {
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

		await untilWatching();
		const changePromise = nextChange(conf);

		const writePath = path.join(cwd, 'config.json');
		fs.writeFileSync(writePath, JSON.stringify({foo: '🦄'}));
		fs.statSync(writePath);

		await changePromise;
		assert.strictEqual(checks, 1);
	});

	it('`watch` option detects encrypted changes', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, watch: true, encryptionKey: 'secret-key'}));
		const writer = trackConf(new Conf({cwd, encryptionKey: 'secret-key'}));
		await untilWatching();
		const initialChange = nextChange(conf);
		writer.set('foo', 'bar');
		await initialChange;

		const changePromise = nextChange(conf);
		const history: Array<{newValue: unknown; oldValue: unknown}> = [];
		conf.onDidChange('foo', (newValue, oldValue) => {
			history.push({newValue, oldValue});
		});

		writer.set('foo', 'baz');
		await changePromise;

		assert.deepStrictEqual(history, [{newValue: 'baz', oldValue: 'bar'}]);
	});

	it('watch mode creates the file when missing and closes cleanly', () => {
		const cwd = createTempDirectory();
		const configPath = path.join(cwd, 'config.json');
		assert.strictEqual(fs.existsSync(configPath), false);
		const conf = new Conf({cwd, watch: true});
		try {
			assert.ok(fs.existsSync(configPath));
			assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		} finally {
			conf._closeWatcher();
		}
	});
});

describe('a self-write with a watcher open', () => {
	// The `store` setter reports the write this store made, so the watcher must not report it a second time. It must report every other change though, including one that comes back to the same bytes.
	it('reports the write right away, and only once', {skip: skipWatching}, async () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory(), watch: true}));
		const seen: unknown[] = [];
		conf.onDidChange('a', value => {
			seen.push(value);
		});
		// A listener of a key is not told about a report that leaves the value as it was, so the reports themselves are counted too.
		let reported = 0;
		conf.events.addEventListener('change', () => {
			reported++;
		});

		conf.set('a', 1);
		assert.deepStrictEqual(seen, [1], 'reported before the call returned');
		await settle();
		assert.deepStrictEqual(seen, [1], 'not reported a second time');
		assert.strictEqual(reported, 1, 'the write is reported once, by the write itself');

		// A change from elsewhere is reported, which shows the watcher was there to report the write above a second time.
		const change = nextChange(conf);
		fs.writeFileSync(conf.path, JSON.stringify({a: 2}));
		await change;
		await untilQuiet(() => reported);
		assert.deepStrictEqual(seen, [1, 2], 'the change from elsewhere is reported once');
		assert.strictEqual(reported, 2, 'the change from elsewhere is one report');
	});

	it('reports a change another process made, and a change back to the same bytes', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const one = trackConf(new Conf({cwd, watch: true}));
		const two = new Conf({cwd});
		const seen: unknown[] = [];
		one.onDidChange('a', value => {
			seen.push(value);
		});
		let reported = 0;
		one.events.addEventListener('change', () => {
			reported++;
		});

		one.set('a', 1);
		await untilQuiet(() => reported);
		assert.deepStrictEqual(seen, [1], 'the write of this store is reported once');
		assert.strictEqual(reported, 1, 'the write of this store is one report');

		let change = nextChange(one);
		two.set('a', 2);
		await change;
		await untilQuiet(() => reported);
		assert.deepStrictEqual(seen, [1, 2], 'the change another process made is reported');
		assert.strictEqual(reported, 2, 'the change another process made is one report');

		change = nextChange(one);
		two.set('a', 1);
		await change;
		await untilQuiet(() => reported);

		// Both changes are reported, and the store reads what the last one wrote.
		assert.deepStrictEqual(seen, [1, 2, 1], 'the change back to the same bytes is reported');
		assert.strictEqual(reported, 3, 'the change back to the same bytes is one report');
		assert.strictEqual(one.get('a'), 1);
		assert.deepStrictEqual({...one.store}, {a: 1});
	});
});

describe('a write that failed', () => {
	// The bytes a write was going to put in the file are what the watcher compares against, so that this store's own write is not reported as a change from elsewhere. Bytes that never reached the file are not what the file holds, so recording them leaves the watcher deaf to a later change that happens to write exactly those bytes.
	it('leaves nothing the watcher takes a change for', {skip: skipWatching || skipAsRoot}, async () => {
		for (const [name, breakTheWrite] of [
			['nothing between', false],
			['a write that could not be made', true],
		] as Array<[string, boolean]>) {
			const cwd = createTempDirectory();
			const conf = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true}));
			conf.set('a', 1);
			// eslint-disable-next-line no-await-in-loop -- each case is set up and watched on its own.
			await settle();

			let reported = 0;
			conf.onDidChange('a', () => {
				reported++;
			});

			if (breakTheWrite) {
				// A directory the file cannot be written in is the one failure a store cannot recover from on its own, and it happens with the store still holding what it had.
				fs.chmodSync(cwd, 0o500);
				try {
					assert.throws(() => {
						conf.set('a', 2);
					}, {code: 'EACCES'});
				} finally {
					fs.chmodSync(cwd, 0o700);
				}
			}

			// Another process writes the value the failed write was going to, so the bytes are the ones the store recorded and never wrote.
			const change = nextChange(conf);
			new Conf<Record<string, unknown>>({cwd}).set('a', 2);
			// eslint-disable-next-line no-await-in-loop -- each case is set up and watched on its own.
			await change;
			// eslint-disable-next-line no-await-in-loop -- each case is set up and watched on its own.
			await untilQuiet(() => reported);
			assert.strictEqual(reported, 1, `the changes reported with ${name}`);
		}
	});
});

describe('closing the watcher', () => {
	// A second store watches the same file and stays open, so the change it reports shows that the change reached the watchers, and the store that was closed is the only one that stays quiet.
	it('does not report a change that was already on its way', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, watch: true}));
		const other = trackConf(new Conf({cwd, watch: true}));
		let changes = 0;
		conf.events.addEventListener('change', () => {
			changes++;
		});

		// Give the file watcher time to start before another process writes the config file.
		await untilWatching();
		const reported = nextChange(other);
		fs.writeFileSync(conf.path, JSON.stringify({foo: 1}, undefined, '\t'));
		await delay(50);

		conf._closeWatcher();
		const changesWhenClosed = changes;
		await reported;
		await settle();

		assert.strictEqual(changes, changesWhenClosed);
	});

	it('stops reporting changes to the config file', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, watch: true}));
		const other = trackConf(new Conf({cwd, watch: true}));
		let changes = 0;
		conf.events.addEventListener('change', () => {
			changes++;
		});

		conf._closeWatcher();
		await untilWatching();
		const reported = nextChange(other);
		fs.writeFileSync(conf.path, JSON.stringify({foo: 1}, undefined, '\t'));
		await reported;
		await settle();

		assert.strictEqual(changes, 0);
	});

	it('closing a watcher that was not started does nothing', () => {
		const conf = trackConf(new Conf({cwd: createTempDirectory()}));

		// `watch` is off, so there is no watcher to close, and closing twice must be safe as well.
		assert.doesNotThrow(() => {
			conf._closeWatcher();
		});

		assert.doesNotThrow(() => {
			conf._closeWatcher();
		});
	});
});

describe('two stores, one of them watching, on the same file', () => {
	it('reports the change the other one made and not the write it made itself', {skip: skipWatching}, async () => {
		await withPollingWatcher(async () => {
			const cwd = createTempDirectory();
			const watching = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true}));
			const writing = trackConf(new Conf<Record<string, unknown>>({cwd}));

			// The watcher polls and debounces, so a change is reported a poll or two after it was made. The wait before the listener is registered is here so the writes the constructions made are not one the listener is reached for. The wait after this store's own write cannot wait for a change, since what is being tested is that none is reported for it, so it waits for the count to stop moving, and the change the other store makes below shows the watcher was there to report one.
			await delay(1500);

			let reported = 0;
			watching.events.addEventListener('change', () => {
				reported++;
			});

			watching.set('own', 1);
			await untilQuiet(() => reported);
			assert.strictEqual(reported, 1, 'the write of this store is reported once, by the write itself');

			const changed = nextChange(watching);
			writing.set('other', 1);
			await changed;
			assert.strictEqual(reported, 2, 'the change the other store made is reported too');
			assert.deepStrictEqual({...watching.store}, {own: 1, other: 1});
		});
	});

	it('reports a file that another process renamed over', {skip: skipWatching}, async () => {
		await withPollingWatcher(async () => {
			const cwd = createTempDirectory();
			const conf = trackConf(new Conf<Record<string, unknown>>({cwd, cache: true, watch: true}));
			conf.set('foo', 'before');

			// The watcher polls, so a change is reported a poll or two after it was made. The wait is here so the write of this store is not the one the change below is waited for.
			await delay(2000);

			const reported = nextChange(conf);
			const other = createTempDirectory();
			fs.writeFileSync(path.join(other, 'config.json'), JSON.stringify({replaced: true}));
			fs.renameSync(path.join(other, 'config.json'), conf.path);

			await reported;
			assert.deepStrictEqual({...conf.store}, {replaced: true}, 'the file that was renamed over the config file is reported and the cache is dropped for it');
		});
	});
});

describe('a watcher that polls the config file', () => {
	it('reports a change without waiting for the default `fs.watchFile` interval', async () => {
		await withPollingWatcher(async () => {
			const cwd = createTempDirectory();
			const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
			conf.set('foo', '🐴');

			// `fs.watchFile` polls with the interval it is given. Its own default of 5007 ms reports a change about six seconds late, so the wait for it is shorter than that, where a poll every 500 ms and a debounce of a second report it in about one and a half.
			const changePromise = pEvent(conf.events, 'change', {timeout: 4000});

			createExistingConfig(path.dirname(conf.path), {foo: '🦄'});
			fs.statSync(conf.path);

			await changePromise;
			assert.strictEqual(conf.get('foo'), '🦄');
		});
	});

	it('does not report a change that the watcher saw before it was closed', async () => {
		await withPollingWatcher(async () => {
			const cwd = createTempDirectory();
			const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
			// A second store watching the same path reports the change the closed one would have, which is what shows there was a report to drop.
			const control = trackConf(new Conf({cwd, cache: true, watch: true}));
			const settled = nextChange(control);
			conf.set('foo', '🐴');
			await settled;

			let changes = 0;
			conf.events.addEventListener('change', () => {
				changes++;
			});

			const controlChange = nextChange(control);
			createExistingConfig(path.dirname(conf.path), {foo: '🦄'});

			// The poll has seen the write by now, and the debounce is still waiting to report it. Closing the watcher has to drop that pending report as well, since the timer would otherwise outlive it and keep the process alive.
			await delay(700);
			conf._closeWatcher();

			await controlChange;
			await settle();
			assert.strictEqual(control.get('foo'), '🦄', 'the other store reports the change');
			assert.strictEqual(changes, 0);
		});
	});

	it('closing one watcher keeps another instance watching the same path', async () => {
		await withPollingWatcher(async () => {
			const cwd = createTempDirectory();
			const first = trackConf(new Conf({cwd, cache: true, watch: true}));
			const second = trackConf(new Conf({cwd, cache: true, watch: true}));
			first.set('foo', '🐴');

			// Both instances watch the same path, so closing one must leave the other one watching.
			first._closeWatcher();

			const changePromise = nextChange(second);

			createExistingConfig(path.dirname(second.path), {foo: '🦄'});
			fs.statSync(second.path);

			await changePromise;
			assert.strictEqual(second.get('foo'), '🦄');
		});
	});

	it('does not throw from the change listener when the config file becomes invalid', async () => {
		await withPollingWatcher(async () => {
			const cwd = createTempDirectory();
			const conf = trackConf(new Conf({cwd, watch: true}));
			conf.set('foo', '🐴');

			let callbacks = 0;
			conf.onDidChange('foo', () => {
				callbacks++;
			});

			// Another process writes a malformed file. The listener reads the store to get the new value, and this runs from the watcher, where nothing can catch the error.
			const changePromise = nextChange(conf);

			fs.writeFileSync(conf.path, '🦄');
			fs.statSync(conf.path);

			await changePromise;
			assert.strictEqual(callbacks, 0);
		});
	});
});
