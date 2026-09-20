/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/no-unsafe-call -- A listener here often does nothing, and a value read back from the store is `any`. */
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	trackConf,
	resetTrackedConfs,
	runRegisteredCleanups,
	skipWatching,
	nextChange,
	untilQuiet,
	readConfigFile,
	settle,
	createExistingConfig,
	createNullProtoObject,
} from './_utilities.js';

const readConfigText = (conf: Conf<any>): string => fs.readFileSync(conf.path, 'utf8');

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('the value a change listener is told a key had', () => {
	// The value a key had is read out of the file, and a key the file does not hold is one with no value, which the readme says is `undefined` and not `null`. The two are told apart by a callback, so the answer is pinned here rather than left to which of them a report happens to carry.
	it('is `undefined` where the key had no value, not `null`', () => {
		const conf = trackConf(new Conf<Record<string, unknown>>({cwd: createTempDirectory()}));

		const reported: Array<{oldValue: unknown; newValue: unknown}> = [];
		conf.onDidChange('watched', (newValue, oldValue) => {
			reported.push({oldValue, newValue});
		});

		// The config file is not there yet, which reads as an empty store, so the first change a listener reports has no old value.
		conf.set('watched', 'first');
		assert.deepStrictEqual(reported, [{oldValue: undefined, newValue: 'first'}]);
		assert.strictEqual('oldValue' in reported[0]!, true);

		// A key the file does not hold any more has no new value, for the same reason.
		conf.delete('watched');
		assert.deepStrictEqual(reported, [
			{oldValue: undefined, newValue: 'first'},
			{oldValue: 'first', newValue: undefined},
		]);
		assert.strictEqual(reported[1]!.newValue, undefined);
	});

	it('does not throw when a listener is set while the config file cannot be read', () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf({cwd}));
		conf.set('foo', '🐴');

		// A listener reads the store to have a value to compare the next change against, and another process can be halfway through writing the file at that moment. There is no value to compare against then, so the first change a listener sees reports none.
		fs.writeFileSync(conf.path, '🦄');

		const history: Array<[unknown, unknown]> = [];
		const unsubscribe = conf.onDidChange('foo', (newValue, oldValue) => {
			history.push([newValue, oldValue]);
		});

		const stores: Array<[unknown, unknown]> = [];
		const unsubscribeFromStore = conf.onDidAnyChange((newValue, oldValue) => {
			stores.push([newValue, oldValue]);
		});

		createExistingConfig(path.dirname(conf.path), {foo: '🐴'});
		conf.set('foo', 'bar');
		unsubscribe();
		unsubscribeFromStore();

		assert.deepStrictEqual(history, [['bar', undefined]]);
		assert.deepStrictEqual(stores, [[createNullProtoObject({foo: 'bar'}), undefined]]);
	});
});

describe('a change listener whose read dispatches a change of its own', () => {
	// A read that clears a damaged config file writes it and dispatches a change of its own, which reaches a listener that is in the middle of reporting a change. What that read produced is a value the store has moved on from by the time it would be reported, since the change it dispatched reported a newer one.
	const createStoreWithClearInvalidConfig = (): Conf => {
		const conf = trackConf(new Conf({
			cwd: createTempDirectory(),
			clearInvalidConfig: true,
		}));

		conf.set('a', 1);

		return conf;
	};

	it('is not told the store changed back to a value it has left', () => {
		const conf = createStoreWithClearInvalidConfig();

		const reported: Array<{oldValue: unknown; newValue: unknown}> = [];
		let reports = 0;

		conf.onDidAnyChange(() => {
			reports++;

			if (reports === 1) {
				// A change that puts a damaged file where the store reads it, which is what another process writing it looks like.
				fs.writeFileSync(conf.path, '{corrupt');
				return;
			}

			// A write in the change the read below dispatched, so the store moves on from the value that read produced.
			conf.set('c', 3);
		});

		conf.onDidAnyChange((newValue, oldValue) => {
			reported.push({oldValue: {...oldValue!}, newValue: {...newValue}});
		});

		conf.set('b', 2);

		assert.deepStrictEqual(reported, [
			{oldValue: {a: 1}, newValue: {c: 3}},
		]);
		assert.deepStrictEqual({...conf.store}, {c: 3});
	});

	it('is not told a key changed back to a value it has left', () => {
		const conf = createStoreWithClearInvalidConfig();
		conf.set('watched', 'before');

		const reported: Array<{oldValue: unknown; newValue: unknown}> = [];
		let reports = 0;

		conf.onDidChange('watched', () => {
			reports++;

			if (reports === 1) {
				fs.writeFileSync(conf.path, '{corrupt');
				return;
			}

			conf.set('watched', 'written');
		});

		conf.onDidChange('watched', (newValue, oldValue) => {
			reported.push({oldValue, newValue});
		});

		conf.set('watched', 'changed');

		assert.deepStrictEqual(reported, [
			{oldValue: 'before', newValue: 'written'},
		]);
		assert.strictEqual(conf.get('watched'), 'written');
	});

	it('reports a change the read of a damaged file made once', () => {
		const conf = trackConf(new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			clearInvalidConfig: true,
		}));

		conf.set('a', 1);

		const reported: Array<{oldValue: unknown; newValue: unknown}> = [];
		conf.onDidAnyChange((newValue, oldValue) => {
			reported.push({oldValue: {...oldValue!}, newValue: {...newValue}});
		});

		// The store is read while the file is damaged, so the read clears it and dispatches the change that made.
		fs.writeFileSync(conf.path, '{corrupt');
		conf.get('a');

		assert.deepStrictEqual(reported, [
			{oldValue: {a: 1}, newValue: {}},
		]);
	});
});

describe('events and subscriptions', () => {
	it('events fires on set, delete, clear and store assignment', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		let fires = 0;
		conf.events.addEventListener('change', () => {
			fires++;
		});
		conf.set('a', 1);
		conf.delete('a');
		conf.set('b', 2);
		conf.clear();
		conf.store = {c: 3};
		assert.strictEqual(fires, 5);
	});

	it('events fires even when the value did not change, onDidChange does not', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', 1);
		let events = 0;
		let changes = 0;
		conf.events.addEventListener('change', () => {
			events++;
		});
		const unsubscribe = conf.onDidChange('a', () => {
			changes++;
		});
		conf.set('a', 1);
		assert.strictEqual(events, 1);
		assert.strictEqual(changes, 0);
		unsubscribe();
	});

	it('onDidChange reports creation, update and deletion', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		const seen: Array<{newValue: unknown; oldValue: unknown}> = [];
		const unsubscribe = conf.onDidChange('k', (newValue, oldValue) => {
			seen.push({newValue, oldValue});
		});
		conf.set('k', 'one');
		conf.set('k', 'two');
		conf.delete('k');
		unsubscribe();
		conf.set('k', 'after-unsub');
		assert.deepStrictEqual(seen, [
			{newValue: 'one', oldValue: undefined},
			{newValue: 'two', oldValue: 'one'},
			{newValue: undefined, oldValue: 'two'},
		]);
	});

	it('onDidChange ignores unrelated keys', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		let calls = 0;
		const unsubscribe = conf.onDidChange('watched', () => {
			calls++;
		});
		conf.set('other', 1);
		conf.set('watched', 1);
		conf.set('other', 2);
		assert.strictEqual(calls, 1);
		unsubscribe();
	});

	it('onDidAnyChange sees every mutation', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		let calls = 0;
		const unsubscribe = conf.onDidAnyChange(() => {
			calls++;
		});
		conf.set('a', 1);
		conf.set('b', 2);
		conf.delete('a');
		conf.clear();
		assert.strictEqual(calls, 4);
		unsubscribe();
		conf.set('z', 1);
		assert.strictEqual(calls, 4);
	});

	it('multiple subscribers all fire and unsubscribe is independent', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		let first = 0;
		let second = 0;
		const unsubFirst = conf.onDidChange('k', () => {
			first++;
		});
		const unsubSecond = conf.onDidChange('k', () => {
			second++;
		});
		conf.set('k', 1);
		assert.strictEqual(first, 1);
		assert.strictEqual(second, 1);
		unsubFirst();
		conf.set('k', 2);
		assert.strictEqual(first, 1);
		assert.strictEqual(second, 2);
		unsubSecond();
	});

	it('unsubscribe can be called more than once safely', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		let keyCalls = 0;
		let anyCalls = 0;
		const unsubscribe = conf.onDidChange('k', () => {
			keyCalls++;
		});
		const unsubscribeAny = conf.onDidAnyChange(() => {
			anyCalls++;
		});

		conf.set('k', 1);
		assert.strictEqual(keyCalls, 1);
		assert.strictEqual(anyCalls, 1);

		// A listener for the same key that stays subscribed, so a second unsubscribe that took away another listener would show.
		let otherCalls = 0;
		conf.onDidChange('k', () => {
			otherCalls++;
		});

		unsubscribe();
		unsubscribe();
		unsubscribeAny();
		unsubscribeAny();
		conf.set('k', 2);

		assert.strictEqual(keyCalls, 1, 'the listener taken away does not run again');
		assert.strictEqual(anyCalls, 1, 'the store listener taken away does not run again');
		assert.strictEqual(otherCalls, 1, 'the listener that stayed still runs');
	});

	it('watching a nested key works', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		const seen: unknown[] = [];
		const unsubscribe = conf.onDidChange('a.b', newValue => {
			seen.push(newValue);
		});
		conf.set('a.b', 1);
		conf.set('a.b', 2);
		conf.set('a.other', 'no-fire');
		assert.deepStrictEqual(seen, [1, 2]);
		unsubscribe();
	});

	it('throws for invalid subscription arguments', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		assert.throws(() => {
			(conf as any).onDidChange(1, () => {});
		}, {message: 'Expected `key` to be of type `string`, got number'});
		assert.throws(() => {
			(conf as any).onDidChange('k', 'not-fn');
		}, {message: 'Expected `callback` to be of type `function`, got string'});
		assert.throws(() => {
			(conf as any).onDidAnyChange('not-fn');
		}, {message: 'Expected `callback` to be of type `function`, got string'});
	});

	it('binds subscription callbacks to the instance', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		let isBound = false;
		const unsubscribe = conf.onDidChange('k', function (this: Conf) {
			isBound = this === conf;
		});
		conf.set('k', 1);
		assert.strictEqual(isBound, true);
		unsubscribe();
	});
});

describe('events for writes that change nothing', () => {
	it('does not notify on deep-equal object replacement', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('o', {a: 1, nested: [1, 2]});
		let calls = 0;
		const unsubscribe = conf.onDidChange('o', () => {
			calls++;
		});
		conf.set('o', {a: 1, nested: [1, 2]});
		assert.strictEqual(calls, 0);
		conf.set('o', {a: 1, nested: [1, 3]});
		assert.strictEqual(calls, 1);
		unsubscribe();
	});

	it('set({}) writes and fires events but no value callbacks', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		let events = 0;
		let changes = 0;
		conf.events.addEventListener('change', () => {
			events++;
		});
		const unsubscribe = conf.onDidAnyChange(() => {
			changes++;
		});
		conf.set({});
		assert.strictEqual(events, 1);
		assert.strictEqual(changes, 0);
		unsubscribe();
	});

	it('clear() on an empty store still fires events but no value callbacks', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		let events = 0;
		let changes = 0;
		conf.events.addEventListener('change', () => {
			events++;
		});
		const unsubscribe = conf.onDidAnyChange(() => {
			changes++;
		});
		conf.clear();
		assert.strictEqual(events, 1);
		assert.strictEqual(changes, 0);
		unsubscribe();
	});

	it('watches literal dotted keys when dot-notation is off', () => {
		const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
		const seen: unknown[] = [];
		const unsubscribe = conf.onDidChange('a.b', newValue => {
			seen.push(newValue);
		});
		conf.set('a.b', 1);
		conf.set('a', 2);
		assert.deepStrictEqual(seen, [1]);
		unsubscribe();
	});

	it('watches array indices', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('list', ['a', 'b']);
		const seen: unknown[] = [];
		const unsubscribe = conf.onDidChange('list.0', newValue => {
			seen.push(newValue);
		});
		conf.delete('list.0');
		assert.deepStrictEqual(seen, ['b']);
		unsubscribe();
	});

	it('reports no change for a write that changes nothing', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('foo', 'bar');

		const history: Array<[unknown, unknown]> = [];
		const unsubscribe = conf.onDidChange('foo', (newValue, oldValue) => {
			history.push([newValue, oldValue]);
		});

		// The store is written again each time, and the change listener reports what the store holds, so a write of the same value and a delete of a key that is not there are not changes.
		conf.set('foo', 'bar');
		conf.delete('missing');
		assert.deepStrictEqual(history, []);

		// A write that does change the value is reported, so the listener above was listening.
		conf.set('foo', 'baz');
		unsubscribe();

		assert.deepStrictEqual(history, [['baz', 'bar']]);
	});
});

describe('a change a callback makes itself', () => {
	// A write dispatches a change of its own while the dispatch that led to it is in hand, and a dispatch runs the listeners it has in the order they were registered, so a callback registered before the writing one is reached before the ones registered after it.
	it('reaches the callbacks registered before the writing one first', () => {
		const config = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		const reported: string[] = [];

		config.onDidChange('key', (newValue, oldValue) => {
			reported.push(`first ${String(newValue)} <- ${String(oldValue)}`);
			if (newValue === 'a') {
				config.set('key', 'b');
			}
		});

		config.onDidChange('key', (newValue, oldValue) => {
			reported.push(`second ${String(newValue)} <- ${String(oldValue)}`);
		});

		config.set('key', 'start');
		reported.length = 0;
		config.set('key', 'a');

		assert.deepStrictEqual(reported, [
			'first a <- start',
			'first b <- a',
			'second b <- start',
		]);
	});

	it('reaches the callbacks registered after the writing one last', () => {
		const config = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		const reported: string[] = [];

		config.onDidChange('key', (newValue, oldValue) => {
			reported.push(`first ${String(newValue)} <- ${String(oldValue)}`);
		});

		config.onDidChange('key', (newValue, oldValue) => {
			reported.push(`second ${String(newValue)} <- ${String(oldValue)}`);
			if (newValue === 'a') {
				config.set('key', 'b');
			}
		});

		config.set('key', 'start');
		reported.length = 0;
		config.set('key', 'a');

		assert.deepStrictEqual(reported, [
			'first a <- start',
			'second a <- start',
			'first b <- a',
			'second b <- a',
		]);
	});

	it('reaches the listeners of the whole store in the order they were registered too', () => {
		const config = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		const reported: string[] = [];

		config.onDidAnyChange(newValue => {
			reported.push(`first ${String(newValue.first)}`);
			if (newValue.first === 'a') {
				config.set('first', 'b');
			}
		});

		config.onDidAnyChange(newValue => {
			reported.push(`second ${String(newValue.first)}`);
		});

		config.set('key', 'start');
		reported.length = 0;
		config.set('first', 'a');

		assert.deepStrictEqual(reported, [
			'first a',
			'first b',
			'second b',
		]);
	});
});

describe('a `change` listener', () => {
	// The file is written before the change is dispatched, so a listener is reached for a store that already holds what the write reported, and one that throws cannot leave the caller looking at a store that does not. A throw is the process's own business: an `EventTarget` reports it as an uncaught exception rather than out of the call that dispatched the event, so `set()` is not reported as failed by a callback of the caller's own. That half is not pinned here, since a test whose callback produces an uncaught exception fails, whatever handles it.
	it('reaches a store that already holds the value the write reported', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		const fileAtDispatch: string[] = [];

		conf.events.addEventListener('change', () => {
			fileAtDispatch.push(readConfigText(conf));
		});

		conf.set('a', 1);
		conf.set('a', 2);

		assert.deepStrictEqual(fileAtDispatch.map(text => JSON.parse(text) as Record<string, number>), [{a: 1}, {a: 2}]);
		assert.deepStrictEqual({...conf.store}, {a: 2});
	});
});

describe('the `events` of a store', () => {
	it('dispatches a change event for a write and not for a read', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		const changes: unknown[][] = [];
		conf.events.addEventListener('change', () => {
			changes.push([...conf]);
		});

		conf.get('foo');
		conf.has('foo');
		assert.strictEqual(conf.size, 0);
		assert.deepStrictEqual([...conf], []);
		assert.strictEqual(changes.length, 0);

		conf.set('foo', 1);

		assert.strictEqual(changes.length, 1);
		assert.deepStrictEqual(changes[0], [['foo', 1]]);
	});

	it('dispatches a change event for `clear()`', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		let changes = 0;
		conf.events.addEventListener('change', () => {
			changes++;
		});

		conf.set('foo', 1);
		conf.clear();

		assert.strictEqual(changes, 2);
		assert.strictEqual(conf.size, 0);
	});

	it('exposes events as an EventTarget', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		assert.ok(conf.events instanceof EventTarget);
	});
});

describe('options that meet', () => {
	it('tells a listener the value the config file holds when a change listener writes while a damaged file is cleared', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf<Record<string, unknown>>({
			cwd,
			cache: true,
			watch: true,
			clearInvalidConfig: true,
		}));

		conf.set('a', 1);
		await settle();

		// A listener that writes, which is what the `onDidChange` documentation describes.
		conf.onDidAnyChange(() => {
			conf.set('c', 3);
		});

		// What the file holds at the moment a listener is told the store changed, so a value that is not what the file holds is the store reporting a change it did not make.
		const told: Array<{value: Record<string, unknown>; file: Record<string, unknown>}> = [];
		conf.onDidAnyChange(newValue => {
			told.push({
				value: {...newValue},
				file: readConfigFile(conf.path) as Record<string, unknown>,
			});
		});

		// A damaged config file is what another process that wrote a partial file looks like.
		const change = nextChange(conf);
		fs.writeFileSync(conf.path, '{corrupt');
		await change;
		await untilQuiet(() => told.length);

		assert.ok(told.length > 0, 'the listener is told about the change');
		assert.deepStrictEqual(told.filter(entry => !isDeepStrictEqual(entry.value, entry.file)), []);
	});

	it('keeps a write a change listener made in the change a read that cleared a damaged file dispatched', () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf<Record<string, unknown>>({
			cwd,
			clearInvalidConfig: true,
		}));

		conf.set('a', 1);

		// A change listener that writes, which is what the `onDidChange` documentation describes. It is told about the change a read that clears a damaged config file dispatches, and its write is the one the read is left behind.
		let written = false;
		conf.onDidAnyChange(() => {
			if (written) {
				return;
			}

			written = true;
			conf.set('fromListener', 'yes');
		});

		// A damaged config file is what another process that wrote a partial file looks like, and this write is the one that reads it.
		fs.writeFileSync(conf.path, '{corrupt');
		conf.set('b', 2);

		assert.strictEqual(conf.get('fromListener'), 'yes');
		assert.deepStrictEqual({...conf.store}, {fromListener: 'yes', b: 2});
	});
});

describe('the listener a subscription is given', () => {
	it('refuses a listener that is not a function', () => {
		const conf = new Conf({cwd: createTempDirectory()});

		assert.throws(() => {
			conf.onDidChange('foo', 'not a function' as unknown as () => void);
		}, {message: 'Expected `callback` to be of type `function`, got string'});

		assert.throws(() => {
			conf.onDidAnyChange('not a function' as unknown as () => void);
		}, {message: 'Expected `callback` to be of type `function`, got string'});
	});
});
