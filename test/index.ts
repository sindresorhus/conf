/* eslint-disable no-new, @typescript-eslint/no-empty-function, @typescript-eslint/naming-convention */
import fs from 'node:fs';
import path from 'node:path';
import {
	describe,
	it,
	before,
	after,
	beforeEach,
	afterEach,
	test,
} from 'node:test';
import assert from 'node:assert/strict';
import Conf, {type Schema} from '../source/index.js';
import {
	createTempDirectory,
	trackConf,
	runRegisteredCleanups,
	resetTrackedConfs,
	nextProjectName,
	createNullProtoObject,
} from './_utilities.js';

const fixture = '🦄';

const failingTest = (title: string, fn: () => void | Promise<void>): void => {
	test(title, async () => {
		try {
			await fn();
		} catch {
			return;
		}

		throw new Error('Expected test to fail');
	});
};

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

failingTest('.get() - `schema` option - default', () => {
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
	assert.strictEqual(store.get('nested.bar'), 55); // See: https://github.com/sindresorhus/electron-store/issues/102
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

	it('.mutate()', () => {
		config.set('count', 10);
		// @ts-ignore
		config.mutate('count', (current: number) => current + 5);
		assert.strictEqual(config.get('count'), 15);
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
		// Test that invalid defaults cause an error during construction
		assert.throws(() => {
			new Conf({
				cwd: createTempDirectory(),
				defaults: {
					foo: 42,
					bad() {}, // Invalid JSON type
				},
			});
		}, {message: /Invalid defaults/});
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

	it('`defaults` option', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				foo: 'bar',
			},
		});

		assert.strictEqual(conf.get('foo'), 'bar');
	});

	it('`configName` option', () => {
		const configName = 'alt-config';
		const conf = new Conf<{foo: string | undefined}>({
			cwd: createTempDirectory(),
			configName,
		});
		assert.strictEqual(conf.get('foo'), undefined);
		conf.set('foo', fixture);
		assert.strictEqual(conf.get('foo'), fixture);
		assert.strictEqual(path.basename(conf.path, '.json'), configName);
		assert.ok(fs.existsSync(conf.path));
	});

	it('no `suffix` option', () => {
		const conf = new Conf({projectName: nextProjectName()});
		assert.ok(conf.path.includes('-nodejs'));
		conf.clear();
	});

	it('with `suffix` option set to empty string', () => {
		const projectSuffix = '';
		const projectName = 'conf-temp1-project';
		const conf = new Conf({projectSuffix, projectName});
		const configPathSegments = conf.path.split(path.sep);
		const configRootIndex = configPathSegments.indexOf(projectName);
		assert.ok(configRootIndex !== -1 && configRootIndex < configPathSegments.length);
	});

	it('with `projectSuffix` option set to non-empty string', () => {
		const projectSuffix = 'new-projectSuffix';
		const projectName = 'conf-temp2-project';
		const conf = new Conf({projectSuffix, projectName});
		const configPathSegments = conf.path.split(path.sep);
		const expectedRootName = `${projectName}-${projectSuffix}`;
		const configRootIndex = configPathSegments.indexOf(expectedRootName);
		assert.ok(configRootIndex !== -1 && configRootIndex < configPathSegments.length);
	});

	it('`fileExtension` option', () => {
		const fileExtension = 'alt-ext';
		const conf = new Conf({
			cwd: createTempDirectory(),
			fileExtension,
		});
		assert.strictEqual(conf.get('foo'), undefined);
		conf.set('foo', fixture);
		assert.strictEqual(conf.get('foo'), fixture);
		assert.strictEqual(path.extname(conf.path), `.${fileExtension}`);
	});

	it('`fileExtension` option = empty string', () => {
		const configName = 'unicorn';
		const conf = new Conf({
			cwd: createTempDirectory(),
			fileExtension: '',
			configName,
		});
		assert.strictEqual(path.basename(conf.path), configName);
	});

	it('`serialize` and `deserialize` options', () => {
		const serialized = `foo:${fixture}`;
		const deserialized = {foo: fixture};
		let serializeCallCount = 0;
		let deserializeCallCount = 0;

		const serialize = (value: unknown): string => {
			serializeCallCount++;
			assert.deepStrictEqual(value, deserialized);
			return serialized;
		};

		const deserialize = (value: unknown) => {
			deserializeCallCount++;
			assert.strictEqual(value, serialized);
			return deserialized;
		};

		const conf = new Conf({
			cwd: createTempDirectory(),
			serialize,
			deserialize,
		});

		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
		conf.store = deserialized;
		assert.deepStrictEqual(conf.store, createNullProtoObject(deserialized));
		conf.clearCache(); // Reload to trigger deserialize
		assert.strictEqual(serializeCallCount, 1);
		assert.strictEqual(deserializeCallCount, 1);
	});

	it('`projectName` option', () => {
		const projectName = 'conf-fixture-project-name';
		const conf = new Conf({projectName});
		assert.strictEqual(conf.get('foo'), undefined);
		conf.set('foo', fixture);
		assert.strictEqual(conf.get('foo'), fixture);
		assert.ok(conf.path.includes(projectName));
		fs.rmSync(conf.path, {force: true});
	});

	it('ensure `.store` is always an object', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});

		fs.rmSync(cwd, {force: true, recursive: true});

		assert.doesNotThrow(() => {
			conf.get('foo');
		});
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

	it('`cwd` option overrides `projectName` option', () => {
		const cwd = createTempDirectory();

		assert.doesNotThrow(() => {
			const conf: Conf = new Conf({cwd, projectName: ''});
			assert.ok(conf.path.startsWith(cwd));
			assert.strictEqual(conf.get('foo'), undefined);
			conf.set('foo', fixture);
			assert.strictEqual(conf.get('foo'), fixture);
			fs.rmSync(conf.path, {force: true});
		});
	});

	it('encryption', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			encryptionKey: 'abc123',
		});

		assert.strictEqual(conf.get('foo'), undefined);
		assert.strictEqual(conf.get('foo', '🐴'), '🐴');
		conf.set('foo', fixture);
		conf.set('baz.boo', fixture);
		assert.strictEqual(conf.get('foo'), fixture);
		assert.strictEqual(conf.get('baz.boo'), fixture);
	});

	it('encryption - upgrade', () => {
		const cwd = createTempDirectory();

		const before = new Conf({cwd});
		before.set('foo', fixture);
		assert.strictEqual(before.get('foo'), fixture);

		const after = new Conf({cwd, encryptionKey: 'abc123'});
		assert.strictEqual(after.get('foo'), fixture);
	});

	it('encryption - corrupt file', () => {
		const cwd = createTempDirectory();

		const before = new Conf({
			cwd,
			encryptionKey: 'abc123',
			clearInvalidConfig: true,
		});

		before.set('foo', fixture);
		assert.strictEqual(before.get('foo'), fixture);

		fs.appendFileSync(path.join(cwd, 'config.json'), 'corrupt file');

		const after = new Conf({
			cwd,
			encryptionKey: 'abc123',
			clearInvalidConfig: true,
		});

		assert.strictEqual(after.get('foo'), undefined);
	});

	it('encryption - corrupt file with schema clears data', () => {
		const cwd = createTempDirectory();
		const schema: Schema<{enabled: boolean}> = {
			enabled: {type: 'boolean'},
		};

		const before = new Conf({
			cwd,
			encryptionKey: 'enc-schema',
			schema,
			clearInvalidConfig: true,
		});

		before.set('enabled', true);
		const corruptedPath = path.join(cwd, 'config.json');
		fs.writeFileSync(corruptedPath, 'corrupt-data');
		fs.statSync(corruptedPath);

		const after = new Conf({
			cwd,
			encryptionKey: 'enc-schema',
			schema,
			clearInvalidConfig: true,
		});

		assert.strictEqual(after.get('enabled'), undefined);
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

		const checkUndefined = (newValue: unknown, oldValue: unknown): void => {
			assert.strictEqual(oldValue, fixture);
			assert.strictEqual(newValue, undefined);
		};

		const checkSet = (newValue: unknown, oldValue: unknown): void => {
			assert.strictEqual(oldValue, undefined);
			assert.strictEqual(newValue, '🐴');
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

		const checkUndefined = (newValue: unknown, oldValue: unknown): void => {
			assert.deepStrictEqual(oldValue, createNullProtoObject({
				foo: '🦄',
				baz: {boo: '🦄'},
			}));

			assert.deepStrictEqual(newValue, createNullProtoObject({
				baz: {boo: fixture},
			}));
		};

		const checkSet = (newValue: unknown, oldValue: unknown): void => {
			assert.deepStrictEqual(oldValue, createNullProtoObject({
				baz: {boo: fixture},
			}));

			assert.deepStrictEqual(newValue, createNullProtoObject({
				baz: {boo: '🦄'},
				foo: '🐴',
			}));
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
	});

	// See #32
	it('doesn\'t write to disk upon instanciation if and only if the store didn\'t change', () => {
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

	it('`clearInvalidConfig` option - invalid data', () => {
		const conf = new Conf({cwd: createTempDirectory(), clearInvalidConfig: false});
		fs.writeFileSync(conf.path, '🦄');
		fs.statSync(conf.path);

		assert.throws(() => {
			// eslint-disable-next-line @typescript-eslint/no-unused-expressions
			conf.clearCache();
		}, {name: 'SyntaxError'});
	});

	it('`clearInvalidConfig` option - valid data', () => {
		const conf = new Conf({cwd: createTempDirectory(), clearInvalidConfig: false});
		conf.set('foo', 'bar');
		assert.deepStrictEqual(conf.store, createNullProtoObject({foo: 'bar'}));
	});

	it('`clearInvalidConfig` option - schema validation error', () => {
		const temporaryDirectoryPath = createTempDirectory();
		const configPath = path.join(temporaryDirectoryPath, 'config.json');

		// Create config file with invalid schema data
		fs.writeFileSync(configPath, JSON.stringify({myKey: 'invalid-type'}, null, '\t'));
		fs.statSync(configPath);

		// Without clearInvalidConfig, should throw
		assert.throws(() => {
			new Conf({
				cwd: temporaryDirectoryPath,
				clearInvalidConfig: false,
				schema: {
					myKey: {type: 'boolean'},
				},
			});
		}, {message: /Config schema violation/});

		// With clearInvalidConfig, should clear the invalid data and create empty config
		const conf = new Conf({
			cwd: temporaryDirectoryPath,
			clearInvalidConfig: true,
			schema: {
				myKey: {type: 'boolean'},
			},
		});

		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
	});

	it('migrations - fix invalid schema data', () => {
		const temporaryDirectoryPath = createTempDirectory();
		const configPath = path.join(temporaryDirectoryPath, 'config.json');

		// Create config file with data that doesn't match current schema
		fs.writeFileSync(configPath, JSON.stringify({myKey: 'true'}, null, '\t'));
		fs.statSync(configPath);

		// Migrations should be able to fix invalid data
		const conf = new Conf({
			cwd: temporaryDirectoryPath,
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					// Fix the invalid data by converting string to boolean
					const value = store.get('myKey');
					if (typeof value === 'string') {
						store.set('myKey', value === 'true');
					}
				},
			},
			schema: {
				myKey: {type: 'boolean'},
			},
		});

		// Should successfully create the store with migrated data
		assert.strictEqual(conf.get('myKey'), true);
		assert.strictEqual(typeof conf.get('myKey'), 'boolean');
	});

	it('migrations - handle multiple schema violations', () => {
		const temporaryDirectoryPath = createTempDirectory();
		const coercionPath = path.join(temporaryDirectoryPath, 'config.json');
		fs.writeFileSync(coercionPath, JSON.stringify({
			enabled: 'yes', // Should be boolean
			count: '42', // Should be number
		}, null, '\t'));
		fs.statSync(coercionPath);

		const conf = new Conf({
			cwd: temporaryDirectoryPath,
			projectVersion: '2.0.0',
			migrations: {
				'2.0.0'(store) {
					store.set('enabled', store.get('enabled') === 'yes');
					store.set('count', Number.parseInt(store.get('count') as string, 10));
				},
			},
			schema: {
				enabled: {type: 'boolean'},
				count: {type: 'number'},
			},
		});

		assert.strictEqual(conf.get('enabled'), true);
		assert.strictEqual(conf.get('count'), 42);
	});

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
			schema: {
				age: {type: 'number'},
				active: {type: 'boolean'},
			},
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

	it('migrations - rollback on error', () => {
		const temporaryDirectoryPath = createTempDirectory();
		const configPath = path.join(temporaryDirectoryPath, 'config.json');
		const originalData = {myKey: 'invalid'};
		fs.writeFileSync(configPath, JSON.stringify(originalData, null, '\t'));
		fs.statSync(configPath);

		assert.throws(() => {
			new Conf({
				cwd: temporaryDirectoryPath,
				projectVersion: '1.0.0',
				migrations: {
					'1.0.0'() {
						throw new Error('Migration failed');
					},
				},
			});
		}, {message: /Migration failed/});

		// Original data should be preserved after rollback
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), originalData);
	});

	it('schema - should be an object', () => {
		const schema: any = 'object';
		assert.throws(() => {
			new Conf({cwd: createTempDirectory(), schema}); // eslint-disable-line @typescript-eslint/no-unsafe-assignment
		}, {message: 'The `schema` option must be an object.'});
	});

	it('schema - valid set', () => {
		const schema: Schema<{foo: {bar: number; foobar: number}}> = {
			foo: {
				type: 'object',
				properties: {
					bar: {
						type: 'number',
					},
					foobar: {
						type: 'number',
						maximum: 100,
					},
				},
			},
		};
		const conf = new Conf({cwd: createTempDirectory(), schema});
		assert.doesNotThrow(() => {
			conf.set('foo', {bar: 1, foobar: 2});
		});
	});

	it('schema - one violation', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {
				foo: {
					type: 'string',
				},
			},
		});
		assert.throws(() => {
			conf.set('foo', 1);
		}, {message: 'Config schema violation: `foo` must be string'});
	});

	it('schema - multiple violations', () => {
		const schema: Schema<{foo: {bar: number; foobar: number}}> = {
			foo: {
				type: 'object',
				properties: {
					bar: {
						type: 'number',
					},
					foobar: {
						type: 'number',
						maximum: 100,
					},
				},
			},
		};
		const conf = new Conf({cwd: createTempDirectory(), schema});
		assert.throws(() => {
			conf.set('foo', {bar: '1', foobar: 101});
		}, {message: 'Config schema violation: `foo/bar` must be number; `foo/foobar` must be <= 100'});
	});

	it('schema - complex schema', () => {
		const schema: Schema<{foo: string; bar: number[]}> = {
			foo: {
				type: 'string',
				maxLength: 3,
				pattern: '[def]+',
			},
			bar: {
				type: 'array',
				uniqueItems: true,
				maxItems: 3,
				items: {
					type: 'integer',
				},
			},
		};
		const conf = new Conf({cwd: createTempDirectory(), schema});
		assert.throws(() => {
			conf.set('foo', 'abca');
		}, {message: 'Config schema violation: `foo` must NOT have more than 3 characters; `foo` must match pattern "[def]+"'});
		assert.throws(() => {
			conf.set('bar', [1, 1, 2, 'a']);
		}, {message: 'Config schema violation: `bar` must NOT have more than 3 items; `bar/3` must be integer; `bar` must NOT have duplicate items (items ## 1 and 0 are identical)'});
	});

	it('schema - supports formats', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {
				foo: {
					type: 'string',
					format: 'uri',
				},
			},
		});
		assert.throws(() => {
			conf.set('foo', 'bar');
		}, {message: 'Config schema violation: `foo` must match format "uri"'});
	});

	it('schema - invalid write to config file', () => {
		const schema: Schema<{foo: string}> = {
			foo: {
				type: 'string',
			},
		};
		const cwd = createTempDirectory();

		const conf = new Conf({cwd, schema});
		const schemaPath = path.join(cwd, 'config.json');
		fs.writeFileSync(schemaPath, JSON.stringify({foo: 1}));
		fs.statSync(schemaPath);
		assert.throws(() => {
			conf.clearCache();
		}, {message: 'Config schema violation: `foo` must be string'});
	});

	it('schema - default', () => {
		const schema: Schema<{foo: string}> = {
			foo: {
				type: 'string',
				default: 'bar',
			},
		};
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema,
		});

		const foo: string = conf.get('foo', '');
		assert.strictEqual(foo, 'bar');
	});

	it('schema - Conf defaults overwrites schema default', () => {
		const schema: Schema<{foo: string}> = {
			foo: {
				type: 'string',
				default: 'bar',
			},
		};
		const conf = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				foo: 'foo',
			},
			schema,
		});
		assert.strictEqual(conf.get('foo'), 'foo');
	});

	it('schema - nested defaults are replaced by Conf defaults', () => {
		const schema: Schema<{appearance?: {theme?: string; layout?: string}}> = {
			appearance: {
				type: 'object',
				default: {
					theme: 'light',
					layout: 'grid',
				},
			},
		};

		const conf = new Conf({
			cwd: createTempDirectory(),
			defaults: {
				appearance: {
					layout: 'list',
				},
			},
			schema,
		});

		assert.deepStrictEqual(conf.get('appearance'), {layout: 'list'});
	});

	it('schema - validate Conf default', () => {
		const schema: Schema<{foo: string}> = {
			foo: {
				type: 'string',
			},
		};
		assert.throws(() => {
			new Conf({
				cwd: createTempDirectory(),
				defaults: {
					// For our tests to fail and typescript to compile, we'll ignore this ts error.
					// This error is not bad and means the package is well typed.
					// @ts-expect-error
					foo: 1,
				},
				schema,
			});
		}, {message: 'Config schema violation: `foo` must be string'});
	});

	it('schema - validate rootSchema', () => {
		assert.throws(() => {
			const conf = new Conf({
				cwd: createTempDirectory(),
				rootSchema: {
					additionalProperties: false,
				},
			});
			conf.set('foo', 'bar');
		}, {message: 'Config schema violation: `` must NOT have additional properties'});
	});

	it('AJV - validate AJV options', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			ajvOptions: {
				removeAdditional: true,
			},
			rootSchema: {
				additionalProperties: false,
			},
		});
		conf.set('foo', 'bar');
		assert.strictEqual(conf.get('foo'), undefined);
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
