import fs from 'node:fs';
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createExistingConfig,
	createTempDirectory,
	trackConf,
	runRegisteredCleanups,
	resetTrackedConfs,
	skipWatching,
	nextChange,
	settle,
	untilWatching,
} from './_utilities.js';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a caching store that watches', () => {
	it('drops the cache when `watch` sees a change', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
		const writer = trackConf(new Conf({cwd}));
		conf.set('foo', '🐴');
		assert.strictEqual(conf.get('foo'), '🐴');

		await untilWatching();
		const changePromise = nextChange(conf);

		writer.set('foo', '🦄');

		await changePromise;
		assert.strictEqual(conf.get('foo'), '🦄');
	});

	// The watcher reports a change some time after it sees one, and `_closeWatcher()` drops a report that has not been made yet. A change it had already seen is not reported then, and the cache kept answering with the value before it, so closing the watcher leaves a read that cannot recover the file.
	it('drops the cache when the watcher is closed with a change it has not reported', () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));
		conf.set('a', 1);
		assert.strictEqual(conf.get('a'), 1, 'the cached value');

		// The file changes and the watcher is closed before the report is made, which is what closing it right after another process wrote is.
		fs.writeFileSync(conf.path, JSON.stringify({a: 2}));
		conf._closeWatcher();

		assert.strictEqual(conf.get('a'), 2, 'the value the file holds');
		assert.deepStrictEqual({...conf.store}, {a: 2}, 'the store');
	});

	it('drops the cache when the watcher is closed with nothing seen', () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));
		conf.set('a', 1);
		assert.strictEqual(conf.get('a'), 1);
		conf._closeWatcher();

		// Nothing watches the file any more, so a change made to it now is one the store reads from the file rather than from a cache it kept from before the watcher was closed.
		fs.writeFileSync(conf.path, JSON.stringify({a: 2}));
		assert.strictEqual(conf.get('a'), 2, 'the value the file holds after the watcher is closed');
	});

	it('drops the cache when `watch` sees the config file deleted', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
		conf.set('foo', '🐴');
		assert.strictEqual(conf.get('foo'), '🐴');

		await untilWatching();
		const changePromise = nextChange(conf);

		fs.unlinkSync(conf.path);

		await changePromise;
		assert.strictEqual(conf.get('foo'), undefined);
	});

	it('reports an external change to `onDidChange`', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
		conf.set('foo', '🐴');

		// Let the watcher settle after this instance's own write before subscribing.
		await settle();
		assert.strictEqual(conf.get('foo'), '🐴');

		const history: Array<{newValue: unknown; oldValue: unknown}> = [];
		conf.onDidChange('foo', (newValue, oldValue) => {
			history.push({newValue, oldValue});
		});

		const changePromise = nextChange(conf);

		createExistingConfig(path.dirname(conf.path), {foo: '🦄'});
		fs.statSync(conf.path);

		await changePromise;

		// The cache must be dropped before the event is sent, otherwise the listener reads the stale cache.
		assert.deepStrictEqual(history, [{newValue: '🦄', oldValue: '🐴'}]);
	});

	it('throws instead of serving the cache when `watch` sees the config file become invalid', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd, cache: true, watch: true}));
		conf.set('foo', '🐴');
		assert.strictEqual(conf.get('foo'), '🐴');

		await untilWatching();
		const changePromise = nextChange(conf);

		fs.writeFileSync(conf.path, '🦄');
		fs.statSync(conf.path);

		await changePromise;

		// The dropped cache must not hide the corruption behind a stale value.
		assert.throws(() => conf.store, {name: 'SyntaxError'});
	});
});
