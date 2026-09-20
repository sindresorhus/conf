/* eslint-disable @typescript-eslint/naming-convention, no-new -- The keys here are the ones a caller writes, and a store is often built only for what it does to the file. */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	createExistingConfig,
	getMigrationVersion,
	nextChange,
	resetTrackedConfs,
	runRegisteredCleanups,
	skipWatching,
	trackConf,
	withPollingWatcher,
	readConfigFile,
	createNullProtoObject,
} from './_utilities.js';

type Store = Record<string, any>;

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('two stores on the same file', () => {
	it('builds the second write of a store on the change the other one made', () => {
		const cwd = createTempDirectory();
		const first = trackConf(new Conf<Record<string, unknown>>({cwd}));
		const second = trackConf(new Conf<Record<string, unknown>>({cwd}));

		first.set('first', 1);
		second.set('second', 1);
		first.set('third', 1);

		assert.deepStrictEqual(readConfigFile(first.path), {first: 1, second: 1, third: 1});
	});

	it('deletes and appends on top of the change the other one made', () => {
		const cwd = createTempDirectory();
		const first = trackConf(new Conf<Record<string, unknown>>({cwd}));
		const second = trackConf(new Conf<Record<string, unknown>>({cwd}));

		first.set('kept', 1);
		second.set('dropped', 1);
		first.delete('dropped');
		second.set('kept', 2);
		first.appendToArray('list', 'a');
		second.appendToArray('list', 'b');
		first.appendToArray('list', 'c');

		assert.deepStrictEqual(readConfigFile(first.path), {kept: 2, list: ['a', 'b', 'c']});
	});

	it('replaces the whole file for a `clear()` and for a whole-store write', () => {
		// A whole-store write is the one write that is not built on a read of the file, since replacing the store is what it is for. A `clear()` is one of them, since a store that clears knows only its own defaults.
		const cwd = createTempDirectory();
		const first = trackConf(new Conf<Record<string, unknown>>({cwd, defaults: {mine: 'first'}}));
		const second = trackConf(new Conf<Record<string, unknown>>({cwd, defaults: {mine: 'second'}}));

		first.set('fromFirst', 1);
		second.set('fromSecond', 1);
		first.clear();
		assert.deepStrictEqual(readConfigFile(first.path), {mine: 'first'});

		second.set('fromSecond', 1);
		first.store = {mine: 'first'};
		assert.deepStrictEqual(readConfigFile(first.path), {mine: 'first'});
	});

	it('resets a key on top of the change the other one made', () => {
		const cwd = createTempDirectory();
		const first = trackConf(new Conf<Record<string, unknown>>({cwd, defaults: {resettable: 'default'}}));
		const second = trackConf(new Conf<Record<string, unknown>>({cwd}));

		first.set('fromFirst', 1);
		second.set('fromSecond', 1);
		first.reset('resettable');

		assert.deepStrictEqual(readConfigFile(first.path), {fromFirst: 1, fromSecond: 1, resettable: 'default'});
	});
});

describe('two stores with a cache on the same file', () => {
	// The cache is a read of the file that is kept, and the readme says a read only sees another store's change when the watcher reports it or this store writes. A write reads the file for itself, so the change is never lost.
	it('does not see the other store\'s change until this store writes or its watcher reports it', () => {
		const cwd = createTempDirectory();
		const first = trackConf(new Conf<Record<string, unknown>>({cwd, cache: true}));
		first.set('foo', 'first');
		assert.strictEqual(first.get('foo'), 'first');

		const second = trackConf(new Conf<Record<string, unknown>>({cwd, cache: true}));
		second.set('foo', 'second');

		assert.strictEqual(first.get('foo'), 'first', 'the cached value');
		assert.strictEqual(second.get('foo'), 'second');

		// The write reads the file for itself, so the change the other store made is in the file the write leaves.
		first.set('bar', 1);
		assert.deepStrictEqual(readConfigFile(first.path), {foo: 'second', bar: 1});
		assert.strictEqual(first.get('foo'), 'second');
	});

	it('sees the other store\'s change as soon as the watcher reports it', {skip: skipWatching}, async () => {
		await withPollingWatcher(async () => {
			const cwd = createTempDirectory();
			const watching = trackConf(new Conf<Record<string, unknown>>({cwd, cache: true, watch: true}));
			const writing = trackConf(new Conf<Record<string, unknown>>({cwd, cache: true}));

			// The watcher polls, so a change is reported a poll or two after it was made. The wait is here so the change below is not the one the read after it picks up, rather than the one the watcher reported.
			await delay(1500);
			assert.strictEqual(watching.get('foo'), undefined, 'the cache is what the store holds before the other one writes');

			const reported = nextChange(watching);
			writing.set('foo', 'from the other store');
			assert.strictEqual(watching.get('foo'), undefined, 'the cache still holds what it held before the change was reported');

			await reported;
			assert.strictEqual(watching.get('foo'), 'from the other store', 'the change the watcher reported');
		});
	});
});

describe('a store with migrations and a store without, on the same file', () => {
	const migrations = {
		'1.5.0'(store: Conf) {
			store.set('migrated', true);
		},
	};

	const withMigrations = (cwd: string) => trackConf(new Conf<Record<string, unknown>>({cwd, projectVersion: '2.0.0', migrations}));

	// The store without migrations is given defaults, so its construction writes the file, and that write is what would strip the bookkeeping the store with migrations recorded. A `cache` is given as well, so a read of the store without it would not notice the file has changed under it.
	const withDefaults = (cwd: string) => trackConf(new Conf<Record<string, unknown>>({cwd, cache: true, defaults: {added: 'by the store without migrations'}}));

	for (const [name, [openFirst, openSecond]] of [
		['the store with migrations opened first', [withMigrations, withDefaults]],
		['the store without migrations opened first', [withDefaults, withMigrations]],
	] as Array<[string, [(cwd: string) => Conf, (cwd: string) => Conf]]>) {
		it(`keeps the bookkeeping a write of the store without migrations would strip, with ${name}`, () => {
			const cwd = createTempDirectory();
			createExistingConfig(cwd, {seed: 1, __internal__: {migrations: {version: '1.0.0'}}});

			openFirst(cwd);
			const plain = openSecond(cwd);
			plain.set('written', 1);

			assert.strictEqual(getMigrationVersion(plain), '2.0.0', 'the bookkeeping is kept');
			assert.strictEqual(plain.get('migrated'), true, 'the step that ran for the store with migrations is still in the file');
			assert.strictEqual(plain.get('added'), 'by the store without migrations', 'the default the store without migrations added is still in the file');

			// Nothing runs again, since the store the steps ran in recorded where they got to.
			const again: string[] = [];
			new Conf<Record<string, unknown>>({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.5.0'() {
						again.push('1.5.0');
					},
				},
			});
			assert.deepStrictEqual(again, []);
		});
	}

	it('keeps the bookkeeping a `clear()` and a whole-store write of the store without migrations would strip', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: 1, __internal__: {migrations: {version: '1.0.0'}}});
		withMigrations(cwd);

		const plain = trackConf(new Conf<Record<string, unknown>>({cwd, defaults: {added: 'by the store without migrations'}}));
		plain.clear();
		assert.strictEqual(getMigrationVersion(plain), '2.0.0', 'the bookkeeping survives a `clear()`');

		plain.store = {only: 'this'};
		assert.strictEqual(getMigrationVersion(plain), '2.0.0', 'the bookkeeping survives a whole-store write');
	});
});

describe('a migration that fails while another store writes to the same file', () => {
	// The rollback puts the store the file held before the pass back, so what the other store wrote while the pass was in hand goes with it. The error message promises the changes the failed migration applied are restored, which is what the write does, and there is nothing that says which of the keys in the file the pass put there.
	it('puts the file back to the store the pass started from, undoing the other store\'s write', () => {
		const cwd = createTempDirectory();
		createExistingConfig(cwd, {seed: 1, __internal__: {migrations: {version: '1.0.0'}}});

		assert.throws(() => new Conf<Record<string, unknown>>({
			cwd,
			projectVersion: '2.0.0',
			migrations: {
				'1.5.0'(store) {
					// A newer app writes to the same file while this pass is in hand.
					new Conf<Record<string, unknown>>({
						cwd,
						projectVersion: '3.0.0',
						migrations: {
							'2.5.0'(inner) {
								inner.set('fromInner', true);
							},
						},
					});

					throw new Error('boom');
				},
			},
		}), {message: /^Something went wrong during the migration!.*boom$/});

		assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), {seed: 1, __internal__: {migrations: {version: '1.0.0'}}});
	});
});

describe('a store whose key is not the one the file was encrypted with', () => {
	it('throws without `clearInvalidConfig`, and leaves the file alone', () => {
		const cwd = createTempDirectory();
		const encrypting = trackConf(new Conf<Record<string, unknown>>({cwd, encryptionKey: 'the right one'}));
		encrypting.set('secret', 'value');
		const before = fs.readFileSync(encrypting.path);

		assert.throws(() => new Conf<Record<string, unknown>>({cwd, encryptionKey: 'the wrong one', encryptionAlgorithm: 'aes-256-gcm'}), {message: 'Failed to decrypt config data.'});
		assert.deepStrictEqual(fs.readFileSync(encrypting.path), before);
	});

	// A file the key does not decrypt is one the store cannot read, which is what `clearInvalidConfig` clears, so a store whose key changed recovers rather than staying stuck.
	it('clears the file with `clearInvalidConfig`, and writes after it', () => {
		const cwd = createTempDirectory();
		const encrypting = trackConf(new Conf<Record<string, unknown>>({cwd, encryptionKey: 'the right one'}));
		encrypting.set('secret', 'value');

		const wrongKey = trackConf(new Conf<Record<string, unknown>>({cwd, encryptionKey: 'the wrong one', clearInvalidConfig: true}));
		assert.deepStrictEqual({...wrongKey.store}, {});
		wrongKey.set('written', 1);
		assert.strictEqual(wrongKey.get('written'), 1);
		assert.deepStrictEqual({...new Conf<Record<string, unknown>>({cwd, encryptionKey: 'the wrong one'}).store}, {written: 1});
	});
});

describe('writes of two stores that interleave', () => {
	it('interleaved set and delete preserve the union', () => {
		const cwd = createTempDirectory();
		const first = new Conf({cwd});
		const second = new Conf({cwd});
		first.set('k1', 1);
		first.set('k2', 2);
		second.delete('k1');
		second.set('k3', 3);
		assert.deepStrictEqual(first.store, createNullProtoObject({k2: 2, k3: 3}));
		assert.deepStrictEqual(second.store, createNullProtoObject({k2: 2, k3: 3}));
	});

	it('second writer keeps first writer’s nested keys', () => {
		const cwd = createTempDirectory();
		const first = new Conf({cwd});
		first.set('a.b', 1);
		const second = new Conf({cwd});
		second.set('c.d', 2);
		assert.deepStrictEqual(first.get('a'), {b: 1});
		assert.deepStrictEqual(first.get('c'), {d: 2});
	});

	it('two writers preserve each other keys', () => {
		const cwd = createTempDirectory();
		const first = new Conf({cwd});
		const second = new Conf({cwd});
		first.set('from-first', 1);
		second.set('from-second', 2);
		assert.deepStrictEqual(first.store, createNullProtoObject({'from-first': 1, 'from-second': 2}));
		assert.deepStrictEqual(second.store, createNullProtoObject({'from-first': 1, 'from-second': 2}));
	});
});

describe('a change another process made to the same config file', () => {
	// A key is written on the store the file holds, so nothing of the other process is lost. A whole-store write is the one that replaces what the file holds, which is what the readme says of it.
	it('survives a `set()` of another store', () => {
		const cwd = createTempDirectory();
		const first = new Conf<Store>({cwd});
		const second = new Conf<Store>({cwd});
		second.set('fromSecond', 1);
		first.set('fromFirst', 1);

		first.set('fromFirst', 2);

		assert.deepStrictEqual({...first.store}, {fromSecond: 1, fromFirst: 2});
	});

	it('is lost to a whole-store write', () => {
		const cwd = createTempDirectory();
		const first = new Conf<Store>({cwd});
		const second = new Conf<Store>({cwd});
		second.set('fromSecond', 1);
		first.set('fromFirst', 1);

		first.store = {fromFirst: 2};

		assert.deepStrictEqual({...first.store}, {fromFirst: 2});
	});
});
