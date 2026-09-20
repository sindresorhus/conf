/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- A callback a test does not care about is an empty function, the keys here are the ones a caller writes, and a value read back is `any`. */
import fs from 'node:fs';
import path from 'node:path';
import {
	describe,
	it,
	before,
	after,
	beforeEach,
	afterEach,
} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	trackConf,
	runRegisteredCleanups,
	resetTrackedConfs,
	createNullProtoObject,
	readConfigFile,
	getMigrationVersion,
} from './_utilities.js';

const fixture = '🦄';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

it('.get() - `schema` option - default', () => {
	const store = new Conf({
		cwd: createTempDirectory(),
		schema: {
			foo: {
				type: 'boolean',
				default: true,
			},
			nested: {
				type: 'object',
				properties: {
					bar: {
						type: 'number',
						default: 55,
					},
				},
			},
		},
	});

	assert.strictEqual(store.get('foo'), true);
	// A `default` below an object the store does not hold is not applied, since the validator only fills in the properties of an object that is there. See: https://github.com/sindresorhus/electron-store/issues/102
	assert.strictEqual(store.get('nested.bar'), undefined);
	assert.deepStrictEqual(store.store, createNullProtoObject({foo: true}));
});

describe('Conf', () => {
	let config: Conf;
	let configWithoutDotNotation: Conf;
	let keepAliveTimer: NodeJS.Timeout;

	// Workaround for Node.js test runner bug
	// See: https://github.com/nodejs/node/issues/49952
	before(() => {
		keepAliveTimer = setInterval(() => {}, 100_000);
	});

	after(() => {
		clearInterval(keepAliveTimer);
	});

	beforeEach(() => {
		config = trackConf(new Conf({cwd: createTempDirectory()}));
		configWithoutDotNotation = trackConf(new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false}));
	});

	it('.get()', () => {
		assert.strictEqual(config.get('foo'), undefined);
		assert.strictEqual(config.get('foo', '🐴'), '🐴');
		config.set('foo', fixture);
		assert.strictEqual(config.get('foo'), fixture);
	});

	it('.get() - `defaults` option', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				foo: 42,
				nested: {
					bar: 55,
				},
			},
		});

		assert.strictEqual(store.get('foo'), 42);
		assert.strictEqual(store.get('nested.bar'), 55);
	});

	it('.get() - invalid key', () => {
		config.set('foo', fixture);

		assert.throws(() => {
			// For our tests to fail and TypeScript to compile, we'll ignore this TS error.
			// @ts-expect-error
			config.get(undefined);
		}, {message: 'Expected `key` to be of type `string`, got undefined'});

		assert.throws(() => {
			// @ts-expect-error
			config.get(null);
		}, {message: 'Expected `key` to be of type `string`, got object'});

		assert.throws(() => {
			// @ts-expect-error
			config.get(1);
		}, {message: 'Expected `key` to be of type `string`, got number'});

		// The store is unchanged.
		assert.strictEqual(config.get('foo'), fixture);
	});

	it('.set()', () => {
		config.set('foo', fixture);
		config.set('baz.boo', fixture);
		assert.strictEqual(config.get('foo'), fixture);
		assert.strictEqual(config.get('baz.boo'), fixture);
	});

	it('.set() - with object', () => {
		config.set({
			foo1: 'bar1',
			foo2: 'bar2',
			baz: {
				boo: 'foo',
				foo: {
					bar: 'baz',
				},
			},
		});
		assert.strictEqual(config.get('foo1'), 'bar1');
		assert.strictEqual(config.get('foo2'), 'bar2');
		assert.deepStrictEqual(config.get('baz'), {boo: 'foo', foo: {bar: 'baz'}});
		assert.strictEqual(config.get('baz.boo'), 'foo');
		assert.deepStrictEqual(config.get('baz.foo'), {bar: 'baz'});
		assert.strictEqual(config.get('baz.foo.bar'), 'baz');
	});

	it('.set() - with undefined', () => {
		assert.throws(() => {
			config.set('foo', undefined);
		}, {message: 'Use `delete()` to clear values'});
	});

	it('.set() - with unsupported values', () => {
		assert.throws(() => {
			config.set('a', () => {});
		}, {message: /not supported by JSON/});

		assert.throws(() => {
			config.set('a', Symbol('a'));
		}, {message: /not supported by JSON/});

		assert.throws(() => {
			config.set({
				a: undefined,
			});
		}, {message: /not supported by JSON/});

		assert.throws(() => {
			config.set({
				a() {},
			});
		}, {message: /not supported by JSON/});

		assert.throws(() => {
			config.set({
				a: Symbol('a'),
			});
		}, {message: /not supported by JSON/});
	});

	it('.set() - invalid key', () => {
		assert.throws(() => {
			// For our tests to fail and TypeScript to compile, we'll ignore this TS error.
			// @ts-expect-error
			config.set(1, 'unicorn');
		}, {message: 'Expected `key` to be of type `string` or `object`, got number'});
	});

	it('.has()', () => {
		config.set('foo', fixture);
		config.set('baz.boo', fixture);
		assert.ok(config.has('foo'));
		assert.ok(config.has('baz.boo'));
		assert.ok(!config.has('missing'));
	});

	it('.appendToArray()', () => {
		// Test appending to non-existent key creates array
		config.appendToArray('newArray', 'first');
		assert.deepStrictEqual(config.get('newArray'), ['first']);

		// Test appending to existing array
		config.set('items', ['a', 'b']);
		config.appendToArray('items', 'c');
		assert.deepStrictEqual(config.get('items'), ['a', 'b', 'c']);

		// Test appending objects
		config.set('objects', [{id: 1}, {id: 2}]);
		config.appendToArray('objects', {id: 3});
		assert.deepStrictEqual(config.get('objects'), [{id: 1}, {id: 2}, {id: 3}]);

		// Test with nested arrays using dot notation
		config.set('nested.items', [1, 2]);
		config.appendToArray('nested.items', 3);
		assert.deepStrictEqual(config.get('nested.items'), [1, 2, 3]);

		// Test creating nested array that doesn't exist
		config.appendToArray('deeply.nested.array', 'value');
		assert.deepStrictEqual(config.get('deeply.nested.array'), ['value']);
	});

	it('.appendToArray() - error when key is not array', () => {
		// Test error when existing value is not an array
		config.set('notArray', 'string value');
		assert.throws(() => {
			config.appendToArray('notArray', 'item');
		}, {message: /already set to a non-array value/});

		// Test with number
		config.set('numberValue', 42);
		assert.throws(() => {
			config.appendToArray('numberValue', 'item');
		}, {message: /already set to a non-array value/});

		// Test with object
		config.set('objectValue', {foo: 'bar'});
		assert.throws(() => {
			config.appendToArray('objectValue', 'item');
		}, {message: /already set to a non-array value/});

		// Test with nested non-array
		config.set('nested.notArray', false);
		assert.throws(() => {
			config.appendToArray('nested.notArray', 'item');
		}, {message: /already set to a non-array value/});
	});

	it('.appendToArray() - without dot notation', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
		});

		// Test basic functionality without dot notation
		store.appendToArray('items', 'first');
		assert.deepStrictEqual(store.get('items'), ['first']);

		// Dot notation key should be treated as literal
		store.appendToArray('nested.items', 'value');
		assert.deepStrictEqual(store.get('nested.items'), ['value']);
	});

	it('.appendToArray() - value validation', () => {
		// Test that unsupported JSON types throw appropriate errors
		config.set('items', ['valid']);

		assert.throws(() => {
			config.appendToArray('items', () => {});
		}, {message: /not supported by JSON/});

		assert.throws(() => {
			config.appendToArray('items', Symbol('test'));
		}, {message: /not supported by JSON/});

		assert.throws(() => {
			config.appendToArray('items', undefined);
		}, {message: /not supported by JSON/});
	});

	it('.appendToArray() - change events', () => {
		let changeCallCount = 0;
		let lastNewValue;
		let lastOldValue;

		const unsubscribe = config.onDidChange('items', (newValue, oldValue) => {
			changeCallCount++;
			lastNewValue = newValue;
			lastOldValue = oldValue;
		});

		// First append should create array and fire change event
		config.appendToArray('items', 'first');
		assert.strictEqual(changeCallCount, 1);
		assert.deepStrictEqual(lastNewValue, ['first']);
		assert.strictEqual(lastOldValue, undefined);

		// Second append should fire change event with updated array
		config.appendToArray('items', 'second');
		assert.strictEqual(changeCallCount, 2);
		assert.deepStrictEqual(lastNewValue, ['first', 'second']);
		assert.deepStrictEqual(lastOldValue, ['first']);

		unsubscribe();
	});

	it('.appendToArray() - empty arrays', () => {
		// Test appending to explicitly set empty array
		config.set('empty', []);
		config.appendToArray('empty', 'item');
		assert.deepStrictEqual(config.get('empty'), ['item']);

		// Test multiple appends to empty array
		config.set('multi', []);
		config.appendToArray('multi', 'a');
		config.appendToArray('multi', 'b');
		config.appendToArray('multi', 'c');
		assert.deepStrictEqual(config.get('multi'), ['a', 'b', 'c']);
	});

	it('.reset() - `defaults` option', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				foo: 42,
				bar: 99,
			},
		});

		store.set('foo', 77);
		store.set('bar', 0);
		store.reset('foo', 'bar');
		assert.strictEqual(store.get('foo'), 42);
		assert.strictEqual(store.get('bar'), 99);
	});

	it('.reset() - dot notation', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				options: {
					items: [1, 2],
					nested: {
						value: 'default',
					},
				},
			},
		});

		store.set('options.items', [9, 9]);
		store.set('options.nested.value', 'changed');

		store.reset('options.items', 'options.nested.value');

		assert.deepStrictEqual(store.get('options.items'), [1, 2]);
		assert.strictEqual(store.get('options.nested.value'), 'default');

		// A nested key with no default is left alone.
		store.set('options.other', 'kept');
		// @ts-expect-error - `options.other` is added at runtime, so it is not part of the inferred type
		store.reset('options.other');
		assert.strictEqual(store.get('options.other'), 'kept');
	});

	it('.reset() - falsy `defaults` option', () => {
		const defaultsValue: {
			foo: number;
			bar: string;
			fox: boolean;
			bax: boolean;
		} = {
			foo: 0,
			bar: '',
			fox: false,
			bax: true,
		};
		const store = new Conf({
			cwd: createTempDirectory(),
			defaults: defaultsValue,
		});

		store.set('foo', 5);
		store.set('bar', 'exist');
		store.set('fox', true);
		store.set('fox', false);

		store.reset('foo', 'bar', 'fox', 'bax');

		assert.strictEqual(store.get('foo'), 0);
		assert.strictEqual(store.get('bar'), '');
		assert.strictEqual(store.get('fox'), false);
		assert.strictEqual(store.get('bax'), true);
	});

	it('.reset() - `schema` option', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			schema: {
				foo: {
					default: 42,
				},
				bar: {
					default: 99,
				},
			},
		});

		store.set('foo', 77);
		store.set('bar', 0);
		store.reset('foo', 'bar');
		assert.strictEqual(store.get('foo'), 42);
		assert.strictEqual(store.get('bar'), 99);
	});

	it('.reset() - nested `default` of the `schema` option', () => {
		const conf = new Conf<{a: {b: number}}>({
			cwd: createTempDirectory(),
			schema: {
				a: {
					type: 'object',
					properties: {
						b: {type: 'number', default: 7},
					},
				},
			},
		});

		conf.set('a.b', 1);
		assert.strictEqual(conf.get('a.b'), 1);

		// The `default` sits below the root, but it is the known value of the path all the same, so a reset writes it back the way it does for a `default` at the root.
		conf.reset('a.b');
		assert.strictEqual(conf.get('a.b'), 7);

		// `clear()` leaves the store a fresh store has, and the validator writes the `default` below `a` only where the store holds `a`.
		conf.set('a.b', 2);
		conf.clear();
		assert.deepStrictEqual(readConfigFile(conf.path), {});
		assert.strictEqual(conf.get('a.b'), undefined);
	});

	it('.reset() - a nested `default` below the root with several segments', () => {
		const deep = new Conf<{a: {b: {c: number}}}>({
			cwd: createTempDirectory(),
			schema: {a: {type: 'object', properties: {b: {type: 'object', properties: {c: {type: 'number', default: 3}}}}}},
		});

		deep.set('a.b.c', 1);
		deep.reset('a.b.c');
		assert.strictEqual(deep.get('a.b.c'), 3);
	});

	it('.reset() - a `default` on the parent covers what is nested below it', () => {
		const schema = {
			a: {
				type: 'object' as const,
				default: {x: 1},
				properties: {
					b: {type: 'number' as const, default: 7},
				},
			},
		};
		const conf = new Conf<{a: {x: number; b: number}}>({cwd: createTempDirectory(), schema});

		// The validator gives the parent its `default` and fills the nested one below it, so both are what a fresh instance reads.
		assert.deepStrictEqual(conf.get('a'), {x: 1, b: 7});

		// A reset of the parent writes back both parts, the same shape a fresh instance reads.
		conf.set('a', {x: 9, b: 9});
		conf.reset('a');
		assert.deepStrictEqual(conf.get('a'), {x: 1, b: 7});

		// The schema is the caller's object, and the reset wrote a store's own copy rather than reaching into it.
		assert.deepStrictEqual(schema.a.default, {x: 1});
	});

	it('.reset() - the `defaults` option wins over a nested `default` of the schema', () => {
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			schema: {a: {type: 'object', properties: {b: {type: 'number', default: 7}}}},
			defaults: {'a.b': 5},
		});

		// The option overwrites the `default` of the schema, for a fresh read and for a reset alike.
		assert.strictEqual(conf.get('a.b'), 5);
		conf.set('a.b', 1);
		conf.reset('a.b');
		assert.strictEqual(conf.get('a.b'), 5);
	});

	it('.reset() - a nested `default` of the schema without dot notation has no key to be reset through', () => {
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
			schema: {a: {type: 'object', properties: {b: {type: 'number', default: 7}}}},
		});

		// The key is the key itself without dot notation, and nothing below the root has one, so a reset of the parent leaves it as it is instead of writing a key of dots beside it.
		assert.strictEqual(conf.get('a'), undefined);
		conf.set('a', {b: 1});
		conf.reset('a');
		assert.deepStrictEqual(conf.get('a'), {b: 1});
		assert.strictEqual(conf.has('a.b'), false);
	});

	it('.delete()', () => {
		config.set('foo', 'bar');
		config.set('baz.boo', true);
		config.set('baz.foo.bar', 'baz');
		config.delete('foo');
		assert.strictEqual(config.get('foo'), undefined);
		config.delete('baz.boo');
		assert.notStrictEqual(config.get('baz.boo'), true);
		config.delete('baz.foo');
		assert.notDeepStrictEqual(config.get('baz.foo'), {bar: 'baz'});
		config.set('foo.bar.baz', {awesome: 'icecream'});
		config.set('foo.bar.zoo', {awesome: 'redpanda'});
		config.delete('foo.bar.baz');
		assert.strictEqual(config.get('foo.bar.zoo.awesome'), 'redpanda');
	});

	it('.clear()', () => {
		config.set('foo', 'bar');
		config.set('foo1', 'bar1');
		config.set('baz.boo', true);
		config.clear();
		assert.strictEqual(config.size, 0);
	});

	it('.clear() - `defaults` option', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				foo: 42,
				bar: 99,
			},
		});

		store.set('foo', 2);
		store.clear();
		assert.strictEqual(store.get('foo'), 42);
		assert.strictEqual(store.get('bar'), 99);
	});

	it('.clear() - `schema` option', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			schema: {
				foo: {
					default: 42,
				},
				bar: {
					default: 99,
				},
			},
		});

		store.set('foo', 2);
		store.clear();
		assert.strictEqual(store.get('foo'), 42);
		assert.strictEqual(store.get('bar'), 99);
	});

	it('.clear() - change events', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				foo: 42,
				bar: 'hello',
			},
		});

		// Set some values and extra keys
		store.set('foo', 100);
		store.set('baz', 'extra');

		// Track change events during clear
		const events: Array<{newValue: any; oldValue: any}> = [];
		const unsubscribe = store.onDidAnyChange((newValue, oldValue) => {
			events.push({
				newValue: structuredClone(newValue),
				oldValue: structuredClone(oldValue),
			});
		});

		// Clear should emit exactly one change event with final state
		store.clear();

		unsubscribe();

		assert.strictEqual(events.length, 1, 'Should emit exactly one change event');
		assert.deepStrictEqual(events[0]!.newValue, {foo: 42, bar: 'hello'}, 'Should emit final state with defaults');
		assert.deepStrictEqual(events[0]!.oldValue, {foo: 100, bar: 'hello', baz: 'extra'}, 'Should emit correct old state');
	});

	it('.clear() - without dot notation', () => {
		const store = new Conf({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
			defaults: {
				foo: 42,
				'nested.key': 'value',
			},
		});

		// Set some values
		store.set('foo', 100);
		store.set('other', 'test');

		// Clear should restore defaults correctly without dot notation
		store.clear();

		assert.strictEqual(store.get('foo'), 42);
		assert.strictEqual(store.get('nested.key'), 'value'); // Should be literal key, not nested
		assert.strictEqual(store.get('other'), undefined);
		assert.strictEqual(store.size, 2);
	});

	it('.clear() - validation error', () => {
		// A default `set()` refuses is refused at construction too, so a store is never left holding one that `clear()` and `reset()` would then fail on.
		assert.throws(() => new Conf({
			cwd: createTempDirectory(),
			defaults: {
				foo: 42,
				bad() {}, // Invalid JSON type
			},
		}), {message: 'Setting a value of type `function` for key `bad` is not allowed as it\'s not supported by JSON'});

		// A store whose defaults are all writable is cleared to them.
		const store = new Conf({cwd: createTempDirectory(), defaults: {foo: 42}});
		store.set('other', true);
		store.clear();
		assert.strictEqual(store.get('foo'), 42);
		assert.strictEqual(store.get('other'), undefined);
	});

	it('.size', () => {
		config.set('foo', 'bar');
		assert.strictEqual(config.size, 1);
	});

	it('.store', () => {
		config.set('foo', 'bar');
		config.set('baz.boo', true);
		assert.deepStrictEqual(config.store, createNullProtoObject({
			foo: 'bar',
			baz: {
				boo: true,
			},
		}));
	});

	it('ensure `.store` is always an object', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});

		fs.rmSync(cwd, {force: true, recursive: true});

		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.strictEqual(conf.get('foo'), undefined);
	});

	it('instance is iterable', () => {
		config.set({
			foo: fixture,
			bar: fixture,
		});
		assert.deepStrictEqual(
			[...config],
			[['foo', fixture], ['bar', fixture]],
		);
	});

	it('onDidChange()', () => {
		let fooChecks = 0;
		let bazChecks = 0;

		const checkFoo = (newValue: unknown, oldValue: unknown): void => {
			assert.strictEqual(newValue, '🐴');
			assert.strictEqual(oldValue, fixture);
			fooChecks++;
		};

		const checkBaz = (newValue: unknown, oldValue: unknown): void => {
			assert.strictEqual(newValue, '🐴');
			assert.strictEqual(oldValue, fixture);
			bazChecks++;
		};

		config.set('foo', fixture);
		let unsubscribe = config.onDidChange('foo', checkFoo);
		config.set('foo', '🐴');
		unsubscribe();
		config.set('foo', fixture);

		config.set('baz.boo', fixture);
		unsubscribe = config.onDidChange('baz.boo', checkBaz);
		config.set('baz.boo', '🐴');
		unsubscribe();
		config.set('baz.boo', fixture);

		let undefinedChecks = 0;
		const checkUndefined = (newValue: unknown, oldValue: unknown): void => {
			assert.strictEqual(oldValue, fixture);
			assert.strictEqual(newValue, undefined);
			undefinedChecks++;
		};

		let setChecks = 0;
		const checkSet = (newValue: unknown, oldValue: unknown): void => {
			assert.strictEqual(oldValue, undefined);
			assert.strictEqual(newValue, '🐴');
			setChecks++;
		};

		unsubscribe = config.onDidChange('foo', checkUndefined);
		config.delete('foo');
		unsubscribe();
		unsubscribe = config.onDidChange('foo', checkSet);
		config.set('foo', '🐴');
		unsubscribe();
		config.set('foo', fixture);

		assert.strictEqual(fooChecks, 1);
		assert.strictEqual(bazChecks, 1);
		assert.strictEqual(undefinedChecks, 1);
		assert.strictEqual(setChecks, 1);
	});

	it('onDidAnyChange()', () => {
		let checkFooCount = 0;
		let checkBazCount = 0;

		const checkFoo = (newValue: unknown, oldValue: unknown): void => {
			assert.deepStrictEqual(newValue, createNullProtoObject({foo: '🐴'}));
			assert.deepStrictEqual(oldValue, createNullProtoObject({foo: fixture}));
			checkFooCount++;
		};

		const checkBaz = (newValue: unknown, oldValue: unknown): void => {
			assert.deepStrictEqual(newValue, createNullProtoObject({
				foo: fixture,
				baz: {boo: '🐴'},
			}));
			assert.deepStrictEqual(oldValue, createNullProtoObject({
				foo: fixture,
				baz: {boo: fixture},
			}));
			checkBazCount++;
		};

		config.set('foo', fixture);
		let unsubscribe = config.onDidAnyChange(checkFoo);
		config.set('foo', '🐴');
		unsubscribe();
		config.set('foo', fixture);

		config.set('baz.boo', fixture);
		unsubscribe = config.onDidAnyChange(checkBaz);
		config.set('baz.boo', '🐴');
		unsubscribe();
		config.set('baz.boo', fixture);

		let checkUndefinedCount = 0;
		const checkUndefined = (newValue: unknown, oldValue: unknown): void => {
			assert.deepStrictEqual(oldValue, createNullProtoObject({
				foo: fixture,
				baz: {boo: fixture},
			}));

			assert.deepStrictEqual(newValue, createNullProtoObject({
				baz: {boo: fixture},
			}));
			checkUndefinedCount++;
		};

		let checkSetCount = 0;
		const checkSet = (newValue: unknown, oldValue: unknown): void => {
			assert.deepStrictEqual(oldValue, createNullProtoObject({
				baz: {boo: fixture},
			}));

			assert.deepStrictEqual(newValue, createNullProtoObject({
				baz: {boo: fixture},
				foo: '🐴',
			}));
			checkSetCount++;
		};

		unsubscribe = config.onDidAnyChange(checkUndefined);
		config.delete('foo');
		unsubscribe();
		unsubscribe = config.onDidAnyChange(checkSet);
		config.set('foo', '🐴');
		unsubscribe();
		config.set('foo', fixture);

		assert.strictEqual(checkFooCount, 1);
		assert.strictEqual(checkBazCount, 1);
		assert.strictEqual(checkUndefinedCount, 1);
		assert.strictEqual(checkSetCount, 1);
	});

	// See #32
	it('doesn\'t write to disk upon instantiation if and only if the store didn\'t change', () => {
		let exists = fs.existsSync(config.path);
		assert.strictEqual(exists, false);

		const conf = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				foo: 'bar',
			},
		});
		exists = fs.existsSync(conf.path);
		assert.strictEqual(exists, true);
	});

	it('.get() - without dot notation', () => {
		assert.strictEqual(configWithoutDotNotation.get('foo'), undefined);
		assert.strictEqual(configWithoutDotNotation.get('foo', '🐴'), '🐴');
		configWithoutDotNotation.set('foo', fixture);
		assert.strictEqual(configWithoutDotNotation.get('foo'), fixture);
	});

	it('.set() - without dot notation', () => {
		configWithoutDotNotation.set('foo', fixture);
		configWithoutDotNotation.set('baz.boo', fixture);
		assert.strictEqual(configWithoutDotNotation.get('foo'), fixture);
		assert.strictEqual(configWithoutDotNotation.get('baz.boo'), fixture);
	});

	it('.set() - with object - without dot notation', () => {
		configWithoutDotNotation.set({
			foo1: 'bar1',
			foo2: 'bar2',
			baz: {
				boo: 'foo',
				foo: {
					bar: 'baz',
				},
			},
		});
		assert.strictEqual(configWithoutDotNotation.get('foo1'), 'bar1');
		assert.strictEqual(configWithoutDotNotation.get('foo2'), 'bar2');
		assert.deepStrictEqual(configWithoutDotNotation.get('baz'), {boo: 'foo', foo: {bar: 'baz'}});
		assert.strictEqual(configWithoutDotNotation.get('baz.boo'), undefined);
		assert.strictEqual(configWithoutDotNotation.get('baz.foo.bar'), undefined);
	});

	it('.has() - without dot notation', () => {
		configWithoutDotNotation.set('foo', fixture);
		configWithoutDotNotation.set('baz.boo', fixture);
		assert.ok(configWithoutDotNotation.has('foo'));
		assert.ok(configWithoutDotNotation.has('baz.boo'));
		assert.ok(!configWithoutDotNotation.has('missing'));
	});

	it('.delete() - without dot notation', () => {
		configWithoutDotNotation.set('foo', 'bar');
		configWithoutDotNotation.set('baz.boo', true);
		configWithoutDotNotation.set('baz.foo.bar', 'baz');
		configWithoutDotNotation.delete('foo');
		assert.strictEqual(configWithoutDotNotation.get('foo'), undefined);
		configWithoutDotNotation.delete('baz.boo');
		assert.notStrictEqual(configWithoutDotNotation.get('baz.boo'), true);
		configWithoutDotNotation.delete('baz.foo');
		assert.notDeepStrictEqual(configWithoutDotNotation.get('baz.foo'), {bar: 'baz'});
		configWithoutDotNotation.set('foo.bar.baz', {awesome: 'icecream'});
		configWithoutDotNotation.set('foo.bar.zoo', {awesome: 'redpanda'});
		configWithoutDotNotation.delete('foo.bar.baz');
		assert.deepStrictEqual(configWithoutDotNotation.get('foo.bar.zoo'), {awesome: 'redpanda'});
	});
});

describe('get()', () => {
	it('returns undefined for missing keys and defaultValue when given', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		assert.strictEqual(conf.get('missing'), undefined);
		assert.strictEqual(conf.get('missing', 'fallback'), 'fallback');
		assert.strictEqual(conf.get('missing', 42), 42);
		assert.deepStrictEqual(conf.get('missing', {a: 1}), {a: 1});
		assert.strictEqual(conf.get('missing', undefined), undefined);
		assert.strictEqual(conf.get('missing', null), null);
		assert.strictEqual(conf.get('missing', false), false);
		assert.strictEqual(conf.get('missing', 0), 0);
		assert.strictEqual(conf.get('missing', ''), '');
	});

	it('returns stored falsy values instead of the default', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('zero', 0);
		conf.set('empty', '');
		conf.set('no', false);
		conf.set('nil', null);
		assert.strictEqual(conf.get('zero', 999), 0);
		assert.strictEqual(conf.get('empty', 'fallback'), '');
		assert.strictEqual(conf.get('no', true), false);
		assert.strictEqual(conf.get('nil', 'fallback'), null);
	});

	it('returns defaultValue for missing nested paths', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', {b: 1});
		assert.strictEqual(conf.get('a.missing', 'dflt'), 'dflt');
		assert.strictEqual(conf.get('missing.deep.path', 7), 7);
		assert.strictEqual(conf.get('a.b.c', 'x'), 'x');
		assert.strictEqual(conf.get('a.b', 'dflt'), 1);
	});

	it('treats keys literally when dot-notation is disabled', () => {
		const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
		conf.set('a.b', 1);
		assert.strictEqual(conf.get('a.b'), 1);
		assert.strictEqual(conf.get('a'), undefined);
		assert.strictEqual(conf.get('a', 'default'), 'default');
		conf.set('a', {b: 2});
		assert.deepStrictEqual(conf.get('a'), {b: 2});
		// The literal 'a.b' key is untouched by the write to 'a'.
		assert.strictEqual(conf.get('a.b'), 1);
	});

	it('treats an own `undefined` value as missing in both modes', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({seed: 1}));

		// JSON cannot hold a value of `undefined`, but a custom deserializer can hand one back. An own key that holds it counts as missing, so a read gives the default and `has()` reports false, with or without dot notation.
		const deserialize = (text: string): Record<string, unknown> => {
			const value = JSON.parse(text) as Record<string, unknown>;
			if (!('explicitUndefined' in value)) {
				value.explicitUndefined = undefined;
			}

			return value;
		};

		for (const accessPropertiesByDotNotation of [false, true]) {
			const conf = new Conf({cwd, accessPropertiesByDotNotation, deserialize});
			const mode = `dot notation: ${String(accessPropertiesByDotNotation)}`;
			assert.strictEqual(conf.has('explicitUndefined'), false, `has(), ${mode}`);
			assert.strictEqual(conf.get('explicitUndefined', 'fallback'), 'fallback', `get(), ${mode}`);
		}

		// It is missing, so the key is created as an array instead of reporting a key that holds a non-array value.
		const conf = new Conf({cwd, accessPropertiesByDotNotation: false, deserialize});
		conf.appendToArray('explicitUndefined', 'first');
		assert.deepStrictEqual(conf.get('explicitUndefined'), ['first']);
	});

	it('leaves an own `undefined` value out of the count and the iteration', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({seed: 1}));

		const deserialize = (text: string): Record<string, unknown> => {
			const value = JSON.parse(text) as Record<string, unknown>;
			value.explicitUndefined = undefined;
			return value;
		};

		// A key `get()` and `has()` report as missing is not an item, so it is not counted and not iterated either.
		for (const accessPropertiesByDotNotation of [false, true]) {
			const conf = new Conf({cwd, accessPropertiesByDotNotation, deserialize});
			const mode = `dot notation: ${String(accessPropertiesByDotNotation)}`;
			assert.strictEqual(conf.size, 1, `size, ${mode}`);
			assert.deepStrictEqual([...conf], [['seed', 1]], `iteration, ${mode}`);
		}
	});

	it('returns undefined for prototype names that are not own keys', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', {b: 1});
		assert.strictEqual(conf.get('a.toString'), undefined);
		assert.strictEqual(conf.get('a.toString', 'fallback'), 'fallback');
		assert.strictEqual(conf.get('toString'), undefined);
		assert.strictEqual(conf.has('a.toString'), false);
	});

	it('reads array elements by index path', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('list', ['a', 'b', 'c']);
		assert.strictEqual(conf.get('list.0'), 'a');
		assert.strictEqual(conf.get('list[1]'), 'b');
		assert.strictEqual(conf.get('list.2'), 'c');
		assert.strictEqual(conf.get('list.9', 'missing'), 'missing');
	});

	it('throws for non-string keys', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		for (const bad of [undefined, null, 1, true, {}, []] as any[]) {
			assert.throws(() => {
				(conf as any).get(bad);
			}, {message: 'Expected `key` to be of type `string`, got ' + typeof bad});
		}
	});
});

describe('set()', () => {
	it('creates intermediate objects for deep paths', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a.b.c.d', 1);
		assert.deepStrictEqual(conf.get('a'), {b: {c: {d: 1}}});
	});

	it('creates intermediate arrays when the next segment is numeric', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a.0', 'x');
		assert.deepStrictEqual(conf.get('a'), ['x']);
	});

	it('grows arrays with null-filled gaps when setting a far index', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('list.3', 'x');
		assert.deepStrictEqual(conf.get('list'), [null, null, null, 'x']);
	});

	it('replaces a primitive with an object when setting deeper', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', 'primitive');
		conf.set('a.b', 1);
		assert.deepStrictEqual(conf.get('a'), {b: 1});
	});

	it('replaces an object with a primitive', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', {b: 1});
		conf.set('a', 'now-primitive');
		assert.strictEqual(conf.get('a'), 'now-primitive');
	});

	it('writes nothing when a batched object contains an invalid value', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('keep', 'yes');
		assert.throws(() => {
			conf.set({good: 1, bad: undefined as any});
		}, {message: /not supported by JSON/});
		assert.strictEqual(conf.get('keep'), 'yes');
		assert.strictEqual(conf.get('good'), undefined);
	});

	it('preserves unrelated keys written by another instance (read-modify-write)', () => {
		const cwd = createTempDirectory();
		const first = new Conf({cwd});
		const second = new Conf({cwd});
		first.set('a', 1);
		second.set('b', 2);
		assert.strictEqual(first.get('b'), 2);
		assert.strictEqual(second.get('a'), 1);
		assert.deepStrictEqual(first.store, createNullProtoObject({a: 1, b: 2}));
	});

	it('stores all JSON primitives and compounds', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('str', 'hello');
		conf.set('num', 3.14);
		conf.set('int', -42);
		conf.set('bool', true);
		conf.set('nil', null);
		conf.set('arr', [1, 'two', null, {three: 3}]);
		conf.set('obj', {nested: {deep: [1, 2]}});
		assert.strictEqual(conf.get('str'), 'hello');
		assert.strictEqual(conf.get('num'), 3.14);
		assert.deepStrictEqual(conf.get('arr'), [1, 'two', null, {three: 3}]);
		assert.deepStrictEqual(conf.get('obj'), {nested: {deep: [1, 2]}});
	});

	it('round-trips unicode keys and values', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('emoji-🦄', 'value-🌈');
		conf.set('日本語.key', '値');
		assert.strictEqual(conf.get('emoji-🦄'), 'value-🌈');
		// Dotted unicode key is a nested path.
		assert.strictEqual(conf.get('日本語.key'), '値');
	});

	it('supports keys with spaces and slashes', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('key with spaces', 1);
		conf.set('a/b/c', 2);
		assert.strictEqual(conf.get('key with spaces'), 1);
		// Slashes are literal; dots still split.
		assert.strictEqual(conf.get('a/b/c'), 2);
	});

	it('serializes Date instances to ISO strings', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		const date = new Date('2020-01-02T03:04:05.000Z');
		conf.set('when', date);
		assert.strictEqual(conf.get('when'), date.toISOString());
	});

	it('throws for invalid key types', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		for (const bad of [1, true] as any[]) {
			assert.throws(() => {
				(conf as any).set(bad, 'x');
			}, {message: /Expected `key` to be of type `string` or `object`/});
		}

		// `null` is an object to `typeof` but cannot be enumerated, so it reports like the other invalid keys instead of failing later, deep in the write.
		for (const bad of [null, undefined] as any[]) {
			assert.throws(() => {
				(conf as any).set(bad, 'x');
			}, {name: 'TypeError', message: `Expected \`key\` to be of type \`string\` or \`object\`, got ${String(bad)}`});
		}
	});

	it('reports a non-string key the same way in every method, in both modes', () => {
		for (const accessPropertiesByDotNotation of [true, false]) {
			const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation});
			conf.set('1', 'one');

			const mode = `dot notation: ${String(accessPropertiesByDotNotation)}`;

			for (const bad of [1, true, {}, [], null, undefined] as unknown[]) {
				const message = {message: `Expected \`key\` to be of type \`string\`, got ${typeof bad}`};
				const label = `got ${String(bad)}, ${mode}`;

				assert.throws(() => {
					conf.get(bad as any);
				}, message, `get(), ${label}`);
				assert.throws(() => {
					conf.has(bad as any);
				}, message, `has(), ${label}`);
				assert.throws(() => {
					conf.delete(bad as any);
				}, message, `delete(), ${label}`);
				assert.throws(() => {
					conf.reset(bad as any);
				}, message, `reset(), ${label}`);
				assert.throws(() => {
					conf.appendToArray(bad as any, 'x');
				}, message, `appendToArray(), ${label}`);
				assert.throws(() => conf.onDidChange(bad as any, () => {}), message, `onDidChange(), ${label}`);
			}

			// `set()` also takes an object of items, so its message names both accepted types, and `null` reports as itself rather than the `object` its typeof gives, which would read wrong next to a list of accepted types.
			for (const bad of [1, true, null, undefined] as unknown[]) {
				const reported = bad === null ? 'null' : typeof bad;
				assert.throws(() => {
					conf.set(bad as any, 'x');
				}, {message: `Expected \`key\` to be of type \`string\` or \`object\`, got ${reported}`}, `set(), got ${String(bad)}, ${mode}`);
			}

			// The rejected keys report before any of them changes the store.
			assert.strictEqual(conf.get('1'), 'one');
		}
	});

	it('throws when setting undefined without delete()', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		assert.throws(() => {
			conf.set('a', undefined);
		}, {message: 'Use `delete()` to clear values'});
	});
});

describe('has() and delete()', () => {
	it('has() reflects nested existence', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', {b: {c: 1}});
		assert.strictEqual(conf.has('a'), true);
		assert.strictEqual(conf.has('a.b'), true);
		assert.strictEqual(conf.has('a.b.c'), true);
		assert.strictEqual(conf.has('a.b.missing'), false);
		assert.strictEqual(conf.has('missing'), false);
	});

	it('has() is false through primitive intermediates', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', 'str');
		assert.strictEqual(conf.has('a.b'), false);
		conf.set('n', 5);
		assert.strictEqual(conf.has('n.x'), false);
		conf.set('nil', null);
		assert.strictEqual(conf.has('nil.x'), false);
	});

	it('delete() of a missing key is a no-op that still writes', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set({a: 1, nested: {value: 2}});
		const asSet = readConfigFile(conf);

		let writes = 0;
		conf.events.addEventListener('change', () => {
			writes++;
		});

		// A key no one holds is nothing to delete, and neither is a path that runs into a value that is not an object.
		conf.delete('does-not-exist');
		conf.delete('a.b.c');
		conf.delete('nested.missing');

		assert.strictEqual(writes, 3, 'each delete writes the store');
		assert.deepStrictEqual(conf.store, createNullProtoObject({a: 1, nested: {value: 2}}));
		assert.deepStrictEqual(readConfigFile(conf), asSet);
		assert.strictEqual(conf.size, 2);
	});

	it('delete() removes array elements and shifts the rest', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('items', ['a', 'b', 'c']);
		conf.delete('items.0');
		assert.deepStrictEqual(conf.get('items'), ['b', 'c']);
		conf.delete('items[1]');
		assert.deepStrictEqual(conf.get('items'), ['b']);
	});

	it('delete() preserves siblings', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', 1);
		conf.set('b', 2);
		conf.delete('a');
		assert.strictEqual(conf.get('a'), undefined);
		assert.strictEqual(conf.get('b'), 2);
	});

	it('delete() restores top-level defaults', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {foo: 'default', bar: 1}});
		conf.set('foo', 'changed');
		conf.delete('foo');
		assert.strictEqual(conf.get('foo'), 'default');
	});

	it('delete() removes nested defaults without restoring them', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {nested: {a: 1, b: 2}}});
		conf.delete('nested.a');
		assert.deepStrictEqual(conf.get('nested'), {b: 2});
	});

	it('delete() treats keys literally without dot-notation', () => {
		const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
		conf.set('a.b', 1);
		conf.set('a', 2);
		conf.delete('a.b');
		assert.strictEqual(conf.get('a.b'), undefined);
		assert.strictEqual(conf.get('a'), 2);
	});

	it('a literal `__internal__.*` key is the caller\'s data without dot-notation', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, accessPropertiesByDotNotation: false});

		// Only the exact `__internal__` key holds the bookkeeping. Without dot notation the key is used as it is, so a key that merely looks like a path into it is an ordinary key, readable, countable and deletable like any other.
		conf.set('__internal__.foo', 1);
		assert.strictEqual(conf.get('__internal__.foo'), 1);
		assert.strictEqual(conf.has('__internal__.foo'), true);
		assert.strictEqual(conf.size, 1);
		assert.deepStrictEqual(conf.store, createNullProtoObject({'__internal__.foo': 1}));

		conf.delete('__internal__.foo');
		assert.strictEqual(conf.has('__internal__.foo'), false);

		// The exact key is still the module's own.
		assert.throws(() => {
			conf.set('__internal__', 1);
		}, {message: /used to manage this module internal operations/});

		// A file another process wrote holds such a key the same way, and writing the store whole keeps it.
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({'__internal__.foo': 2, seed: 3}));
		assert.strictEqual(conf.get('__internal__.foo'), 2);
		assert.strictEqual(conf.size, 2);

		conf.store = {'__internal__.foo': 4};
		assert.strictEqual(conf.get('__internal__.foo'), 4);
		assert.deepStrictEqual(readConfigFile(path.join(cwd, 'config.json')), {'__internal__.foo': 4});

		// The `defaults` option names ordinary keys the same way.
		const withDefaults = new Conf({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
			defaults: {'__internal__.foo': 5},
		});
		assert.strictEqual(withDefaults.get('__internal__.foo'), 5);
	});
});

describe('clear() and reset()', () => {
	it('clear() empties the store and sets size to 0', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', 1);
		conf.set('b.c', 2);
		conf.clear();
		assert.strictEqual(conf.size, 0);
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
	});

	it('clear() restores defaults', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {a: 1, b: 2}});
		conf.set('a', 99);
		conf.set('extra', true);
		conf.clear();
		assert.deepStrictEqual(conf.store, createNullProtoObject({a: 1, b: 2}));
	});

	it('reset() with an unknown key does nothing', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {a: 1}});
		conf.set({a: 2, b: 3});
		conf.reset('unknown-key');
		assert.strictEqual(conf.get('a'), 2);
		assert.strictEqual(conf.get('unknown-key'), undefined);
		assert.deepStrictEqual(readConfigFile(conf), {a: 2, b: 3});
	});

	it('reset() without keys does nothing', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {a: 1}});
		conf.set({a: 5, b: 3});

		// Only the keys it is given are reset, so a call without one leaves the store alone.
		conf.reset();

		assert.deepStrictEqual({...conf.store}, {a: 5, b: 3});
		assert.deepStrictEqual(readConfigFile(conf), {a: 5, b: 3});
	});

	it('reset() restores multiple keys at once', () => {
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			defaults: {
				foo: 'foo',
				bar: 'bar',
				zero: 0,
				empty: '',
			},
		});
		conf.set({
			foo: 'x',
			bar: 'x',
			zero: 1,
			empty: 'x',
			extra: 'x',
		});

		conf.reset('foo', 'zero', 'empty');

		assert.deepStrictEqual(readConfigFile(conf), {
			foo: 'foo',
			bar: 'x',
			zero: 0,
			empty: '',
			extra: 'x',
		});
	});

	it('reset() checks every key before it resets any of them', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {a: 1}});
		conf.set('a', 2);

		// The keys are checked as a group, so a rejected one reports without the keys beside it having been reset first.
		assert.throws(() => {
			conf.reset('a', 1 as any);
		}, {message: 'Expected `key` to be of type `string`, got number'});
		assert.strictEqual(conf.get('a'), 2);
	});

	it('reset() restores nested defaults via dot-notation', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {obj: {x: 'orig', y: 'orig2'}}});
		conf.set('obj.x', 'changed');
		conf.reset('obj.x');
		assert.strictEqual(conf.get('obj.x'), 'orig');
		assert.strictEqual(conf.get('obj.y'), 'orig2');
	});
});

describe('appendToArray()', () => {
	for (const accessPropertiesByDotNotation of [true, false]) {
		it(`refuses to append to a key that holds \`null\`, with dot notation ${accessPropertiesByDotNotation ? 'on' : 'off'}`, () => {
			const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation});
			conf.set('items', null);

			assert.throws(() => {
				conf.appendToArray('items', 'first');
			}, {name: 'TypeError', message: 'The key `items` is already set to a non-array value'});

			assert.strictEqual(conf.get('items'), null);
		});
	}

	it('creates the array when missing, including nested paths', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.appendToArray('fresh', 'a');
		assert.deepStrictEqual(conf.get('fresh'), ['a']);
		conf.appendToArray('deep.nested.list', 1);
		assert.deepStrictEqual(conf.get('deep.nested.list'), [1]);
	});

	it('appends null, numbers and booleans', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.appendToArray('list', null);
		conf.appendToArray('list', 0);
		conf.appendToArray('list', false);
		assert.deepStrictEqual(conf.get('list'), [null, 0, false]);
	});

	it('appends an array as a single nested element', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('list', [1]);
		conf.appendToArray('list', [2, 3]);
		assert.deepStrictEqual(conf.get('list'), [1, [2, 3]]);
	});

	it('throws when the existing value is not an array', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		for (const value of ['str', 42, true, {x: 1}, null] as any[]) {
			conf.set('key', value);
			assert.throws(() => {
				conf.appendToArray('key', 'item');
			}, {message: /already set to a non-array value/});
		}
	});

	it('rejects non-JSON values', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('list', []);
		for (const bad of [undefined, () => {}, Symbol('s')] as any[]) {
			assert.throws(() => {
				conf.appendToArray('list', bad);
			}, {message: /not supported by JSON/});
		}
	});

	it('works with literal dotted keys when dot-notation is off', () => {
		const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
		conf.appendToArray('a.b', 'x');
		conf.appendToArray('a.b', 'y');
		assert.deepStrictEqual(conf.get('a.b'), ['x', 'y']);
	});

	it('creates the array for a key the store does not hold', () => {
		const config = new Conf({cwd: createTempDirectory()});

		config.appendToArray('items', 'first');

		assert.deepStrictEqual(readConfigFile(config), {items: ['first']});
		assert.deepEqual(config.get('items'), ['first']);
	});

	it('appends to a key of a path with dot notation', () => {
		const config = new Conf({cwd: createTempDirectory()});
		config.set('a.b', ['first']);

		config.appendToArray('a.b', 'second');

		assert.deepStrictEqual(readConfigFile(config), {a: {b: ['first', 'second']}});
		assert.deepEqual(config.get('a.b'), ['first', 'second']);
	});

	it('appends to a key that spells a path with dot notation, when dot notation is off', () => {
		const config = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});

		config.appendToArray('a.b', 'first');
		config.appendToArray('a.b', 'second');

		assert.deepStrictEqual(readConfigFile(config), {'a.b': ['first', 'second']});
		assert.deepEqual(config.get('a.b'), ['first', 'second']);
	});

	it('keeps the other keys of the store', () => {
		const config = new Conf({cwd: createTempDirectory()});
		config.set({a: 1, b: {c: 2}});

		config.appendToArray('items', 'first');

		assert.deepStrictEqual(readConfigFile(config), {a: 1, b: {c: 2}, items: ['first']});
	});

	it('keeps the bookkeeping of a store that holds it', () => {
		const cwd = createTempDirectory();
		const config = new Conf({
			cwd,
			configName: 'append-migrated',
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('seed', 0);
				},
			},
		});

		config.appendToArray('items', 'first');

		assert.equal(getMigrationVersion(config), '1.0.0');
		assert.deepEqual(config.get('items'), ['first']);
	});

	it('reports a key that holds a value that is not an array', () => {
		const config = new Conf({cwd: createTempDirectory()});
		config.set('items', 'not an array');

		assert.throws(
			() => {
				config.appendToArray('items', 'first');
			},
			{message: 'The key `items` is already set to a non-array value'},
		);
		assert.deepStrictEqual(readConfigFile(config), {items: 'not an array'});
	});

	it('refuses the key the bookkeeping is kept under, and leaves the store as it was', () => {
		const config = new Conf({cwd: createTempDirectory()});
		config.set('items', ['first']);

		assert.throws(
			() => {
				config.appendToArray('__internal__.items', 'second');
			},
			{message: /__internal__/},
		);
		assert.deepStrictEqual(readConfigFile(config), {items: ['first']});
	});
});

describe('the store, its size and iterating it', () => {
	it('store setter replaces the whole config', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('old', 1);
		conf.store = {fresh: true};
		assert.deepStrictEqual(conf.store, createNullProtoObject({fresh: true}));
		assert.strictEqual(conf.get('old'), undefined);
	});

	it('store setter merges missing defaults', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {a: 1, b: 2}});
		conf.store = {b: 20} as any;
		assert.deepStrictEqual(conf.store, createNullProtoObject({a: 1, b: 20}));
	});

	it('store setter drops a caller-supplied __internal__ key', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		conf.set('real', 1);
		conf.store = {__internal__: {hacked: true}, injected: 2};
		assert.strictEqual(conf.get('injected'), 2);
		assert.strictEqual(conf.has('__internal__'), false);
		assert.strictEqual(conf.get('__internal__' as any), undefined);
		assert.deepStrictEqual(readConfigFile(conf), {injected: 2}, 'the file holds no `__internal__` key the caller gave');
	});

	it('size counts only top-level keys', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		assert.strictEqual(conf.size, 0);
		conf.set('a.b.c', 1);
		assert.strictEqual(conf.size, 1);
		conf.set('second', 2);
		assert.strictEqual(conf.size, 2);
		conf.delete('a');
		assert.strictEqual(conf.size, 1);
	});

	it('iteration yields top-level entries', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set({b: 2, a: 1});
		const entries = [...conf].sort(([k1], [k2]) => (k1 < k2 ? -1 : 1));
		assert.deepStrictEqual(entries, [['a', 1], ['b', 2]]);
	});

	it('iteration works with for..of and reflects clear()', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('x', 1);
		let count = 0;
		for (const [key, value] of conf) {
			count++;
			assert.strictEqual(key, 'x');
			assert.strictEqual(value, 1);
		}

		assert.strictEqual(count, 1);
		conf.clear();
		assert.deepStrictEqual([...conf], []);
	});

	it('second instance reads persisted store', () => {
		const cwd = createTempDirectory();
		const first = new Conf({cwd});
		first.set('k', 'v');
		const second = new Conf({cwd});
		assert.deepStrictEqual(second.store, createNullProtoObject({k: 'v'}));
		assert.strictEqual(second.size, 1);
	});

	it('counts the keys the store holds, and not the keys the bookkeeping is kept under', () => {
		const cwd = createTempDirectory();
		const config = new Conf({
			cwd,
			configName: 'size-migrated',
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'() {
					// The file does not exist yet, so no migration runs and the store holds nothing but what is set below.
				},
			},
		});
		config.set('a', 1);

		// The bookkeeping is in the file, and is not an item of the store.
		assert.equal(getMigrationVersion(config), '1.0.0');
		assert.equal(config.size, 1);
		assert.deepEqual([...config], [['a', 1]]);
	});

	it('counts nothing for a store that holds nothing', () => {
		const config = new Conf({cwd: createTempDirectory(), cache: true});

		assert.equal(config.size, 0);
		assert.deepEqual([...config], []);
	});
});

describe('what JSON makes of a value that is written', () => {
	it('splits dotted keys in batched set() with dot-notation on', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set({'x.y': 1, z: 2});
		assert.strictEqual(conf.get('x.y'), 1);
		assert.deepStrictEqual(conf.get('x'), {y: 1});
		assert.strictEqual(conf.get('z'), 2);
	});

	it('keeps dotted keys literal in batched set() with dot-notation off', () => {
		const conf = new Conf({cwd: createTempDirectory(), accessPropertiesByDotNotation: false});
		conf.set({'x.y': 1, z: 2});
		assert.strictEqual(conf.get('x.y'), 1);
		assert.strictEqual(conf.get('x'), undefined);
	});

	it('drops nested undefined values when writing', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set({a: {b: undefined}});
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {}});
		assert.deepStrictEqual(conf.get('a'), {});
	});

	it('drops nested functions and symbols when writing', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set({a: {b() {}}});
		assert.deepStrictEqual(readConfigFile(conf.path), {a: {}});
		conf.set({s: {v: Symbol('x')}});
		assert.deepStrictEqual(conf.get('s'), {});
	});

	it('throws for nested BigInt values', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		assert.throws(() => {
			conf.set({a: {b: 1n}});
		}, {name: 'TypeError', message: 'Setting a value of type `bigint` for key `a` at `b` is not allowed as it\'s not supported by JSON'});
	});

	it('writes null for unserializable array holes', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('arr', [undefined, () => {}, Symbol('s')]);
		assert.deepStrictEqual(readConfigFile(conf.path), {arr: [null, null, null]});
	});

	it('supports explicit null vs missing distinctly', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('n', null);
		assert.strictEqual(conf.has('n'), true);
		assert.strictEqual(conf.get('n', 'fallback'), null);
		assert.strictEqual(conf.get('missing', 'fallback'), 'fallback');
	});
});

describe('the store setter given something that is not a store', () => {
	it('assigning an array yields an empty user store', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('seed', 1);
		conf.store = [] as any;
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.strictEqual(conf.size, 0);
	});

	it('assigning null yields an empty user store', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.store = null as any;
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
	});

	it('assigning a value that is not an object yields an empty user store', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		conf.set('seed', 1);

		// A value that is not a whole object cannot hold items, so it is taken as an empty store, the way an array or `null` already is. JSON writes a string as its characters, which would read back as the items `0`, `1`, … instead of an empty store.
		conf.store = 'hello' as any;
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.strictEqual(conf.size, 0);
		assert.deepStrictEqual(readConfigFile(conf.path), {});

		// Another instance reads the same empty store back.
		assert.deepStrictEqual(new Conf({cwd}).store, createNullProtoObject({}));

		for (const value of [5, true, (() => {}) as unknown]) {
			conf.store = value as any;
			assert.deepStrictEqual(conf.store, createNullProtoObject({}), `store = ${String(value)}`);
			assert.deepStrictEqual(readConfigFile(conf.path), {}, `file after store = ${String(value)}`);
		}
	});

	it('assigning null or a non-object to a store with defaults applies the defaults', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, defaults: {a: 1}});

		// The value is taken as an empty store, so the defaults are the items of it, instead of the merge failing on a value that has no keys to merge.
		conf.store = null as any;
		assert.deepStrictEqual(conf.store, createNullProtoObject({a: 1}));

		conf.store = 'hello' as any;
		assert.deepStrictEqual(conf.store, createNullProtoObject({a: 1}));

		assert.deepStrictEqual(readConfigFile(conf.path), {a: 1});
		assert.deepStrictEqual(new Conf({cwd, defaults: {a: 1}}).store, createNullProtoObject({a: 1}));
	});

	it('store assignment fires change but deep-equal listeners stay silent', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', 1);
		let events = 0;
		let changes = 0;
		conf.events.addEventListener('change', () => {
			events++;
		});
		const unsubscribe = conf.onDidAnyChange(() => {
			changes++;
		});
		conf.store = {a: 1};
		assert.strictEqual(events, 1);
		assert.strictEqual(changes, 0);
		unsubscribe();
	});

	it('store assignment notifies key watchers when a value changes', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('k', 'before');
		const seen: unknown[] = [];
		const unsubscribe = conf.onDidChange('k', newValue => {
			seen.push(newValue);
		});
		conf.store = {k: 'after'};
		assert.deepStrictEqual(seen, ['after']);
		unsubscribe();
	});

	it('applies schema defaults when assigning a partial store', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {a: {type: 'number', default: 10}, b: {type: 'string'}},
		});
		conf.store = {b: 'hi'} as any;
		assert.deepStrictEqual(conf.store, createNullProtoObject({b: 'hi', a: 10}));
	});
});

describe('numbers and deep structures', () => {
	it('persists large safe integers and exponents', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		conf.set('big', 9_007_199_254_740_991);
		conf.set('float', 1e21);
		const reread = new Conf({cwd});
		assert.strictEqual(reread.get('big'), 9_007_199_254_740_991);
		assert.strictEqual(reread.get('float'), 1e21);
	});

	it('reads ten levels of nesting', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('l1.l2.l3.l4.l5.l6.l7.l8.l9.l10', 'deep');
		assert.strictEqual(conf.get('l1.l2.l3.l4.l5.l6.l7.l8.l9.l10'), 'deep');
		assert.deepStrictEqual(conf.get('l1.l2.l3'), {l4: {l5: {l6: {l7: {l8: {l9: {l10: 'deep'}}}}}}});
	});

	it('updates objects inside arrays by index path', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('users', [{name: 'a'}, {name: 'b'}]);
		assert.strictEqual(conf.get('users.1.name'), 'b');
		conf.set('users.0.age', 30);
		assert.deepStrictEqual(conf.get('users'), [{name: 'a', age: 30}, {name: 'b'}]);
		conf.delete('users.0');
		assert.deepStrictEqual(conf.get('users'), [{name: 'b'}]);
		assert.strictEqual(conf.has('users.5'), false);
		conf.appendToArray('users', {name: 'c'});
		assert.deepStrictEqual(conf.get('users'), [{name: 'b'}, {name: 'c'}]);
	});

	it('returns defaultValue for deep missing paths', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		assert.strictEqual(conf.get('a.b.c', 'dflt'), 'dflt');
		conf.set('a', 1);
		assert.strictEqual(conf.get('a.b.c', 'dflt'), 'dflt');
	});
});

describe('falsy and unicode values across instances', () => {
	it('persists falsy values across instances', () => {
		const cwd = createTempDirectory();
		const writer = new Conf({cwd});
		writer.set('zero', 0);
		writer.set('empty', '');
		writer.set('no', false);
		writer.set('nil', null);
		const reader = new Conf({cwd});
		assert.strictEqual(reader.get('zero'), 0);
		assert.strictEqual(reader.get('empty'), '');
		assert.strictEqual(reader.get('no'), false);
		assert.strictEqual(reader.get('nil'), null);
		assert.deepStrictEqual(reader.store, createNullProtoObject({
			zero: 0, empty: '', no: false, nil: null,
		}));
	});

	it('persists emoji keys and values across instances', () => {
		const cwd = createTempDirectory();
		const writer = new Conf({cwd});
		writer.set('🦄', '🌈');
		writer.set('plain', 'héllo wörld 日本語');
		const reader = new Conf({cwd});
		assert.strictEqual(reader.get('🦄'), '🌈');
		assert.strictEqual(reader.get('plain'), 'héllo wörld 日本語');
	});

	it('later mutation of a nested defaults object does not rewrite the file', () => {
		const nested: Record<string, unknown> = {x: 1};
		const conf = new Conf({cwd: createTempDirectory(), defaults: {n: nested as any}, cache: true});
		(nested as any).x = 999;
		assert.deepStrictEqual(conf.get('n'), {x: 1});

		// A reset and a clear write the defaults again, which is where the option is read after construction.
		conf.set('n', {x: 2});
		conf.reset('n');
		assert.deepStrictEqual(conf.get('n'), {x: 1});
		conf.clear();
		assert.deepStrictEqual(conf.get('n'), {x: 1});
		assert.deepStrictEqual(readConfigFile(conf.path), {n: {x: 1}});
	});
});

describe('the store as the user sees it', () => {
	it('has no prototype, so it answers for no name beyond the keys it holds', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('foo', 'bar');
		assert.strictEqual(Object.getPrototypeOf(conf.store), null);
		assert.strictEqual((conf.store as any).hasOwnProperty, undefined);
		assert.strictEqual((conf.store as any).toString, undefined);
		assert.deepStrictEqual({...conf.store}, {foo: 'bar'});
	});
});

describe('a value JSON cannot hold', () => {
	// Every value the check refuses reports the key and the type the value has, the way the others do. A `bigint` has no JSON form at all, so it is one of them rather than an error from deep inside the serializer.
	for (const [name, value, type] of [
		['a `symbol`', Symbol('x'), 'symbol'],
		['a function', () => 1, 'function'],
		['a `bigint`', 1n, 'bigint'],
	] as Array<[string, unknown, string]>) {
		it(`refuses ${name} with a message that names the key and the type`, () => {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, any>>({cwd});
			conf.set('kept', 'value');
			const before = fs.readFileSync(conf.path);

			assert.throws(() => {
				conf.set('target', value);
			}, {
				name: 'TypeError',
				message: `Setting a value of type \`${type}\` for key \`target\` is not allowed as it's not supported by JSON`,
			});
			assert.deepStrictEqual(fs.readFileSync(conf.path), before);
		});
	}
});

describe('a value that is not a number', () => {
	// `JSON.stringify` writes a number that is not a number as `null`, and the store writes what `JSON.stringify` writes.
	for (const [name, value] of [
		['`NaN`', Number.NaN],
		['`Infinity`', Number.POSITIVE_INFINITY],
		['`-Infinity`', Number.NEGATIVE_INFINITY],
		['a number too large for a float', 1e308 * 10],
	] as Array<[string, number]>) {
		it(`writes ${name} as \`null\`, the way \`JSON.stringify\` does`, () => {
			const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
			conf.set('target', value);
			conf.set('nested', {value});
			assert.deepStrictEqual(readConfigFile(conf.path), {target: null, nested: {value: null}});
			assert.strictEqual(conf.get('target'), null);
		});
	}

	it('takes a number JSON writes as itself', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		for (const value of [0, 1.5, -1.5, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, 1e-300]) {
			conf.set('a', value);
			assert.ok(Object.is(conf.get('a'), value), `${String(value)} reads back`);
		}
	});
});

describe('corners of the API', () => {
	it('reads a file that holds a byte order mark as text, and clears it as damaged', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), '﻿{corrupt');

		// A byte order mark is a text file, so it is one that got damaged and not one whose bytes are something else.
		const conf = new Conf({cwd, clearInvalidConfig: true});
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		assert.deepStrictEqual(readConfigFile(conf.path), {});
	});

	it('has nothing and iterates nothing after a `clear()`', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		conf.set({a: 1, b: 2});
		conf.clear();
		assert.strictEqual(conf.size, 0);
		assert.deepStrictEqual([...conf], []);
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
	});

	it('holds a `defaults` key that is an empty string', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory(), defaults: {'': 1}});
		assert.strictEqual(conf.get(''), 1);
		assert.strictEqual(conf.has(''), true);
		assert.strictEqual(conf.size, 1);
		conf.delete('');
		assert.strictEqual(conf.get(''), 1);
	});

	it('appends to an array that is empty', () => {
		const conf = new Conf<Record<string, unknown>>({cwd: createTempDirectory()});
		conf.set('items', []);
		conf.appendToArray('items', 1);
		assert.deepStrictEqual(conf.get('items'), [1]);
	});

	it('reads the store its defaults make again when the file is gone, with the cache on', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd, cache: true, defaults: {a: 1}});
		assert.strictEqual(conf.get('a'), 1);

		fs.rmSync(conf.path);
		assert.strictEqual(conf.get('a'), 1, 'the cached store');
		assert.strictEqual(new Conf<Record<string, unknown>>({cwd, cache: true, defaults: {a: 1}}).get('a'), 1, 'a store built while the file is gone');
	});

	it('refuses a key that is not a string', () => {
		const conf = new Conf({cwd: createTempDirectory()});

		assert.throws(() => {
			conf.onDidChange(5 as unknown as string, () => {});
		}, {message: 'Expected `key` to be of type `string`, got number'});
	});
});

describe('an `appendToArray()` of a key the store cannot take the path of', () => {
	// `set()` writes through a path by replacing whatever is in the way, which is what the container the rest of the path needs is made of. `appendToArray()` writes the same value through the same path with the same writer, so the key it appends to is created where the path says and the value the key above held is replaced the same way. Refusing it here alone would be a third answer for one store.
	it('replaces a value that is not a container, the way `set()` does', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set('a', 'text');
		conf.set('a[0]', 1);
		assert.deepStrictEqual(conf.get('a'), [1]);
	});

	it('appends below a value that is not a container', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set('a', 'text');
		conf.appendToArray('a[0]', 1);
		assert.deepStrictEqual(conf.get('a'), [[1]]);
	});

	it('still refuses a key that holds a value that is not an array', () => {
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory()});
		conf.set('a', {b: 'text'});

		assert.throws(() => {
			conf.appendToArray('a.b', 'appended');
		}, {name: 'TypeError', message: 'The key `a.b` is already set to a non-array value'});
		assert.deepStrictEqual({...conf.store}, {a: {b: 'text'}});
	});
});

describe('large stores', () => {
	it('round-trips 500 keys', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		const payload: Record<string, number> = {};
		for (let index = 0; index < 500; index++) {
			payload[`key-${index}`] = index;
		}

		conf.store = payload;
		assert.strictEqual(conf.size, 500);
		assert.strictEqual(conf.get('key-0'), 0);
		assert.strictEqual(conf.get('key-499'), 499);
	});

	it('round-trips a 100KB string', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		const big = 'x'.repeat(100 * 1024);
		conf.set('big', big);
		assert.strictEqual((conf.get('big') as string).length, big.length);
		assert.strictEqual(conf.get('big'), big);
	});

	it('round-trips 2000 small keys', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		const payload: Record<string, number> = {};
		for (let index = 0; index < 2000; index++) {
			payload[`k${index}`] = index;
		}

		conf.store = payload;
		assert.strictEqual(conf.size, 2000);
		assert.strictEqual(conf.get('k0'), 0);
		assert.strictEqual(conf.get('k1999'), 1999);
	});
});

describe('a subclass of `Conf`', () => {
	// `electron-store` is a subclass, which gives the options defaults of its own before it calls `super` and adds methods of its own, so a subclass has to be able to do both and still be a store.
	it('passes its options to `super` and adds methods of its own', () => {
		class CounterStore extends Conf<{count: number}> {
			constructor(options: {cwd: string}) {
				super({...options, configName: 'counter', defaults: {count: 0}});
			}

			increment(): number {
				const count = this.get('count') + 1;
				this.set('count', count);
				return count;
			}
		}

		const cwd = createTempDirectory();
		const store = new CounterStore({cwd});
		assert.ok(store instanceof Conf);
		assert.strictEqual(store.path, path.join(cwd, 'counter.json'));
		assert.strictEqual(store.get('count'), 0);
		assert.strictEqual(store.increment(), 1);

		let told: unknown;
		store.onDidChange('count', newValue => {
			told = newValue;
		});
		assert.strictEqual(new CounterStore({cwd}).increment(), 2, 'another instance reads what the first wrote');
		assert.strictEqual(store.increment(), 3);
		assert.strictEqual(told, 3);
		assert.deepStrictEqual(readConfigFile(store), {count: 3});
	});
});
