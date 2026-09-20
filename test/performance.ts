/* eslint-disable no-new, @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import fs from 'node:fs';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf, {type Options} from '../source/index.js';
import {
	createExistingConfig,
	createTempDirectory,
	runRegisteredCleanups,
	getMigrationVersion,
	readConfigFile,
	configDirectoryHolding,
	resetTrackedConfs,
} from './_utilities.js';

/**
A `deserialize` of its own counts the reads of the config file, since the file is parsed once for every read that succeeds. A store without a `deserialize` of its own is not measured, since the counter would not see it.
*/
const countingDeserializer = (): {deserialize(text: string): any; reads(): number} => {
	let count = 0;

	return {
		deserialize(text: string) {
			count++;
			return JSON.parse(text);
		},
		reads() {
			return count;
		},
	};
};

/**
A `Conf` whose config file reads are counted through a `deserialize` of its own. The counting option cannot be combined with a `deserialize` of the caller's, so none is given here.
*/
const countedStore = <T extends Record<string, any> = Record<string, any>>(options: Partial<Options<T>> & {configName: string}): {config: Conf<T>; cwd: string; reads(): number} => {
	const cwd = createTempDirectory();
	const counter = countingDeserializer();
	const config = new Conf<T>({...options, cwd, deserialize: counter.deserialize});
	return {config, cwd, reads: counter.reads};
};

/**
The number of times this module compiles a regular expression from one of the given patterns while the given work runs. It is what a test uses to see that a pattern of a `patternProperties` of the caller's is not compiled again for every key it is checked against. Only the compilations this module makes are counted, since the validator compiles the same patterns itself while the schema is compiled, which is its own work and happens once per store either way.
*/
const patternsCompiled = (work: () => void, patterns: string[]): number => {
	const realRegExp = globalThis.RegExp;
	let count = 0;

	(globalThis as any).RegExp = class extends realRegExp {
		constructor(pattern: string, flags?: string) {
			super(pattern, flags);
			if (patterns.includes(pattern) && new Error('compiled a pattern').stack?.includes('matchesPatternProperty')) {
				count++;
			}
		}
	};

	try {
		work();
	} finally {
		(globalThis as any).RegExp = realRegExp;
	}

	return count;
};

/**
The number of strings this module reads character by character while the given work runs, which is what parsing a key into the parts of a path does. A key that is a key of its own is answered without being parsed, so this is what a test uses to see that reading a key of a store does not parse every key the store holds.
*/
const keysParsed = (work: () => void): number => {
	const realIterator = String.prototype[Symbol.iterator];
	let count = 0;
	(String.prototype as any)[Symbol.iterator] = function * (this: string, ...args: any[]) {
		count++;
		yield * (realIterator as any).apply(this, args);
	};

	try {
		work();
	} finally {
		(String.prototype as any)[Symbol.iterator] = realIterator;
	}

	return count;
};

/**
A `rootSchema` whose `patternProperties` are named for the given prefix, so that each test that counts the compilations of a pattern uses patterns no other test has, and does not depend on the order the tests run in.
*/
const patternRootSchema = (prefix: string) => ({
	additionalProperties: false,
	patternProperties: {
		[`^x-${prefix}`]: {type: 'string'},
		[`^y-${prefix}`]: {type: 'string'},
		[`^z-${prefix}`]: {type: 'string'},
	},
});

/**
The number of plain stores this module makes while the given work runs, since a store is made by `Object.create(null)`. A copy of a store is a copy of every key it holds, so this is what a test uses to see that a store is copied once for a `defaults` option rather than once for every key of it, which is a square number of copies for an option of many keys.
*/
const storesMade = (work: () => void): number => {
	const realCreate = Object.create;
	let count = 0;

	(Object as any).create = (prototype: Record<string, unknown>) => {
		// A store is a plain object with no prototype, which is what every copy of one this module makes is made with.
		if (prototype === null) {
			count++;
		}

		return realCreate(prototype);
	};

	try {
		work();
	} finally {
		(Object as any).create = realCreate;
	}

	return count;
};

/**
The keys of a `defaults` option of the given count, each one a path of its own, so that no two of them pass through the same container and the number of stores made for them is the number of the keys alone.
*/
const defaultsOfPaths = (count: number): Record<string, unknown> => {
	const defaults: Record<string, unknown> = {};

	for (let index = 0; index < count; index++) {
		defaults[`group${index}.key${'.'.repeat(index % 3)}leaf`] = `value${index}`;
	}

	return defaults;
};

/**
The same values as the keys of the given option name, as a config file holds them once the store has been opened, so that opening a store with them leaves nothing to write.
*/
const asAConfigFileHoldsThem = (defaults: Readonly<Record<string, unknown>>): Record<string, unknown> => {
	const data: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(defaults)) {
		const parts = key.split('.');
		let object = data;

		for (const [index, part] of parts.entries()) {
			if (index === parts.length - 1) {
				object[part] = value;
				break;
			}

			object[part] ??= {};
			object = object[part] as Record<string, unknown>;
		}
	}

	return data;
};

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('Reads of the config file', () => {
	it('reads the config file once for a change to one key', () => {
		const {config, reads} = countedStore({configName: 'set'});
		config.set('a', 1);

		const before = reads();
		config.set('a', 2);

		assert.equal(reads() - before, 1, 'reads of the config file for one `set()`');
		assert.deepStrictEqual(readConfigFile(config), {a: 2});
	});

	it('reads the config file once for a change to several keys at once', () => {
		const {config, reads} = countedStore({configName: 'set-object'});
		config.set('a', 1);

		const before = reads();
		config.set({b: 2, c: 3});

		assert.equal(reads() - before, 1, 'reads of the config file for one `set()` of several keys');
		assert.deepStrictEqual(readConfigFile(config), {a: 1, b: 2, c: 3});
	});

	it('reads the config file once for a deletion', () => {
		const {config, reads} = countedStore({configName: 'delete'});
		config.set({a: 1, b: 2});

		const before = reads();
		config.delete('a');

		assert.equal(reads() - before, 1, 'reads of the config file for one `delete()`');
		assert.deepStrictEqual(readConfigFile(config), {b: 2});
	});

	it('reads the config file once for a key of a store that holds the bookkeeping', () => {
		const cwd = createTempDirectory();
		const counter = countingDeserializer();
		const config = new Conf({
			cwd,
			configName: 'migrated',
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('seed', 0);
				},
			},
			deserialize: counter.deserialize,
		});
		assert.equal(getMigrationVersion(config), '1.0.0');
		config.set('a', 1);

		const before = counter.reads();
		config.set('a', 2);

		assert.equal(counter.reads() - before, 1, 'reads of the config file for one `set()`');
		// The bookkeeping survives the change, which is what the read that is no longer made was there to keep.
		assert.equal(getMigrationVersion(config), '1.0.0');
		assert.equal(config.get('a'), 2);
	});

	it('appends to the array of the store it writes, so the config file is read once', () => {
		const {config, reads} = countedStore({configName: 'append'});
		config.appendToArray('items', 'first');

		const before = reads();
		config.appendToArray('items', 'second');

		assert.equal(reads() - before, 1, 'reads of the config file for one `appendToArray()`');
		assert.deepStrictEqual(readConfigFile(config), {items: ['first', 'second']});
	});

	it('reads the config file for a store written whole, since it knows nothing about the file', () => {
		let deserializeCallCount = 0;

		const conf = new Conf({
			cwd: createTempDirectory(),
			deserialize(text) {
				deserializeCallCount++;
				return JSON.parse(text) as Record<string, unknown>;
			},
		});

		conf.set('foo', 'bar');

		// The value given to the store setter holds no bookkeeping of its own, so the file is where the bookkeeping comes from.
		deserializeCallCount = 0;
		conf.store = {foo: 'baz'};
		assert.strictEqual(deserializeCallCount, 1);

		deserializeCallCount = 0;
		conf.clear();
		assert.strictEqual(deserializeCallCount, 1);
	});

	it('reads the config file once for each key it writes back, and not for a check', () => {
		const cwd = createTempDirectory();
		let reads = 0;
		const conf = new Conf<Record<string, any>>({
			cwd,
			defaults: {
				a: 'A',
				b: 'B',
				c: 'C',
				d: 'D',
			},
			// Every read of the config file asks the deserializer for the store, so this counts them.
			deserialize(text: string) {
				reads++;
				return JSON.parse(text) as Record<string, unknown>;
			},
		});

		conf.set('written', true);
		reads = 0;
		conf.reset('a', 'b', 'c', 'd');

		// One read for each `set()` that writes a key back.
		assert.strictEqual(reads, 4);
	});
});

describe('The patterns of a `patternProperties`', () => {
	const defaultsAlongPaths = (): Record<string, unknown> => {
		const defaults: Record<string, unknown> = {};
		for (let index = 0; index < 200; index++) {
			defaults[`section${index}.sub.key`] = index;
		}

		return defaults;
	};

	it('compiles a pattern once, not once for every key it is checked against', () => {
		const cwd = createTempDirectory();
		const rootSchema = patternRootSchema('once');
		const patterns = Object.keys(rootSchema.patternProperties);

		const compiled = patternsCompiled(() => {
			new Conf({
				cwd,
				configName: 'patterns',
				defaults: defaultsAlongPaths(),
				rootSchema,
			});
		}, patterns);

		assert.equal(compiled, patterns.length, 'regular expressions compiled from the patterns of a `patternProperties`');
	});

	it('reuses the pattern it compiled for the next store, rather than compiling it again', () => {
		const rootSchema = patternRootSchema('again');
		const patterns = Object.keys(rootSchema.patternProperties);

		const patternsCompiledForAStore = (): number => patternsCompiled(() => {
			new Conf({
				cwd: createTempDirectory(),
				configName: 'patterns-again',
				defaults: defaultsAlongPaths(),
				rootSchema,
			});
		}, patterns);

		// The first of the two stores with these options compiles each pattern once, and the second compiles none of them again.
		assert.equal(patternsCompiledForAStore(), patterns.length);
		assert.equal(patternsCompiledForAStore(), 0);
	});
});

describe('The bookkeeping key on a read', () => {
	const storeOfKeysOfItsOwn = (count: number): Record<string, unknown> => {
		const data: Record<string, unknown> = {};
		for (let index = 0; index < count; index++) {
			data[`item${index}`] = index;
		}

		return data;
	};

	it('does not parse a key that is a key of its own, so a read does not parse every key the store holds', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(`${cwd}/config.json`, JSON.stringify(storeOfKeysOfItsOwn(500)));
		const config = new Conf<Record<string, unknown>>({cwd});

		assert.equal(config.size, 500);
		// Only the key that is read is parsed, where a store of 500 keys of its own would otherwise have each of them parsed twice.
		assert.equal(keysParsed(() => config.get('item0')), 1);
	});

	it('still parses a key that names a path, since that is how such a key reaches the bookkeeping', () => {
		const cwd = createTempDirectory();
		const config = new Conf<Record<string, unknown>>({cwd});
		// A key that spells the dot with a backslash is a key of the store's own top level that has a dot in it, so it is not a key of its own.
		const key = String.raw`item0\.sub`;
		config.set(key, 1);

		// The store holds a key of its own that has a dot in it, so the dot does not make it a path.
		assert.deepEqual(Object.keys(readConfigFile(config)), ['item0.sub']);
		assert.equal(config.get(key), 1);
		// The key of the store is parsed to be asked whether it reaches the bookkeeping, and the key read is parsed as well.
		assert.ok(keysParsed(() => config.get(key)) > 1);
	});
});

describe('The order of the `defaults` option', () => {
	/**
	Defaults whose keys have paths of mixed depth, which is what keeps the order of them from being a single run of already ordered keys. A key that names a path of more than one part is written after a key it is a prefix of, so the more specific of the two lands on the place the more general one filled in.
	*/
	const defaultsOfMixedDepth = (count: number): Record<string, unknown> => {
		const defaults: Record<string, unknown> = {};
		const depths = [1, 2, 3, 2, 1, 3];

		for (let index = 0; index < count; index++) {
			const depth = depths[index % depths.length]!;
			defaults[`key${index}${'.'.repeat(depth - 1)}sub`] = `value${index}`;
		}

		return defaults;
	};

	it('orders the defaults once, rather than on every write', () => {
		const count = 1000;
		const defaults = defaultsOfMixedDepth(count);
		const {config} = countedStore({configName: 'ordered-defaults', defaults});

		// Every default is written once, so the write below finds all of them where they belong, and it has nothing to order.
		config.set(defaults);

		let comparisons = 0;
		let parsed = 0;
		const realToSorted = Array.prototype.toSorted;
		(Array.prototype as any).toSorted = function (this: unknown[], compare: (first: unknown, second: unknown) => number) {
			return (realToSorted as any).call(this, (first: unknown, second: unknown) => {
				comparisons++;
				return compare(first, second);
			});
		};

		try {
			parsed = keysParsed(() => {
				config.set('other', 1);
			});
		} finally {
			(Array.prototype as any).toSorted = realToSorted;
		}

		// The defaults are ordered once, when the store is made, so a write sorts nothing.
		assert.strictEqual(comparisons, 0);
		// Every default is parsed at least once to find where it belongs, which is what shows the count sees the parsing at all.
		assert.ok(parsed >= count, `keys parsed for a write, got ${parsed} for ${count} defaults`);
		// A key is parsed once to find where it belongs and never to order the defaults, so fewer than two parses for each of them.
		assert.ok(parsed < (2 * count), `keys parsed for a write, got ${parsed} for ${count} defaults`);
		assert.deepStrictEqual(config.get('other'), 1);
	});
});

describe('opening a store whose migrations have all run', () => {
	it('does not read the config file again for a pass that ran no step', () => {
		// The pass records the version it reached by comparing against what the file holds, which is what stops a step of another store from being rewound. A pass that ran no step wrote nothing and has no other step in the middle of it, so the read is one the up-to-date store would pay on every construction, and an encrypted one would pay a key derivation for it.
		const migrations = {
			'1.0.0'(store: Conf) {
				store.set('one', true);
			},
			'2.0.0'(store: Conf) {
				store.set('two', true);
			},
		};

		const countReadsForOpening = (projectVersion: string, cwd: string): number => {
			const realRead = fs.readFileSync;
			let reads = 0;
			fs.readFileSync = ((...arguments_: unknown[]) => {
				reads++;
				return Reflect.apply(realRead, fs, arguments_);
			}) as never;

			try {
				new Conf({cwd, projectVersion, migrations});
			} finally {
				fs.readFileSync = realRead;
			}

			return reads;
		};

		// A store already at the project version, so the pass finds no step to run and no version to record. A store that is behind costs a read for the store the step changes and another for the version it records. A store with no file is not one the steps run against, so the file is written first.
		const upToDate = createTempDirectory();
		createExistingConfig(upToDate, {seed: true});
		const behind = new Conf({cwd: upToDate, projectVersion: '1.0.0', migrations});
		assert.strictEqual(behind.get('one'), true, 'the step below the version ran');
		const opened = new Conf({cwd: upToDate, projectVersion: '2.0.0', migrations});
		assert.strictEqual(opened.get('two'), true, 'the store is at the version the pass records');

		// The reads this makes are: `#snapshotFile()` taking the file as it was found, `#runMigrations()` reading the store the pass starts from, which `#migrate()` is handed rather than reading it again, and `#initializeStore()` reading the store it validates. There is no read for the version at the end of the pass, which is the one this pins: with it the count is four.
		assert.strictEqual(countReadsForOpening('2.0.0', upToDate), 3);
	});
});

describe('Opening a store with a large `defaults` option', () => {
	const keys = 300;

	/**
	The number of stores made to open a store with a `defaults` option of the given number of keys. A copy for every key of the option is a number of copies that grows with the option, so a test compares this for a small option and a large one, and the stores made for the small one show that the count sees the copies at all.
	*/
	const storesMadeForKeys = (open: (keys: number) => void): {small: number; large: number} => ({
		small: storesMade(() => {
			open(keys / 10);
		}),
		large: storesMade(() => {
			open(keys);
		}),
	});

	it('records the option without copying the store once for every key of it', () => {
		// The config file already holds what the option gives, so what is left for the construction is to record the option and to find the store as it is.
		// A copy of a store is a copy of every key written into it before that one, so a copy for every key of the option is a number of copies that grows with the option. A key is recorded into a store this module keeps to itself, and the top of that store is the only part of it a caller could reach, which is not the part a write below the top goes through.
		const {small, large} = storesMadeForKeys(count => {
			const defaults = defaultsOfPaths(count);
			const cwd = configDirectoryHolding(asAConfigFileHoldsThem(defaults));
			new Conf({cwd, defaults});
		});

		assert.ok(small > 0, 'the count sees the stores made');
		assert.equal(large, small, `store copies for ${keys} keys compared with ${keys / 10} keys`);
	});

	it('fills the option in without copying the store once for every key of it', () => {
		// There is no config file, so every key of the option is one the store does not hold yet, which is where filling it in copies the store.
		const {small, large} = storesMadeForKeys(count => {
			new Conf({cwd: createTempDirectory(), defaults: defaultsOfPaths(count)});
		});

		assert.ok(small > 0, 'the count sees the stores made');
		assert.equal(large, small, `store copies for ${keys} keys compared with ${keys / 10} keys`);
	});

	it('fills the option in without copying the store once for every key of it without dot notation either', () => {
		// Without dot notation a key is the whole key, so the top of the store is the only container a write goes through, and it is made a copy of once for the whole option rather than once for every key of it, which is a copy of every key written into it before that one.
		const {small, large} = storesMadeForKeys(count => {
			const defaults: Record<string, unknown> = {};
			for (let index = 0; index < count; index++) {
				defaults[`key${index}`] = index;
			}

			new Conf({cwd: createTempDirectory(), defaults, accessPropertiesByDotNotation: false});
		});

		assert.ok(small > 0, 'the count sees the stores made');
		assert.equal(large, small, `store copies for ${keys} keys compared with ${keys / 10} keys`);
	});
});

describe('the constructor', () => {
	it('reads an existing config file once', () => {
		const cwd = createTempDirectory();
		new Conf({cwd, encryptionKey: 'key', defaults: {a: 1}});

		const realRead = fs.readFileSync;
		let reads = 0;
		fs.readFileSync = ((...arguments_: unknown[]) => {
			reads++;
			return Reflect.apply(realRead, fs, arguments_) as unknown;
		}) as typeof fs.readFileSync;

		try {
			new Conf({cwd, encryptionKey: 'key', defaults: {a: 1}});
		} finally {
			fs.readFileSync = realRead;
		}

		assert.equal(reads, 1);
	});

	it('writes a new store with migrations once, with its defaults and the version it starts at', () => {
		let writes = 0;
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			projectVersion: '1.0.0',
			defaults: {a: 1},
			migrations: {
				'1.0.0'(store) {
					store.set('ran', true);
				},
			},
			serialize(value) {
				writes++;
				return JSON.stringify(value);
			},
		});

		assert.equal(writes, 1);
		assert.deepEqual(readConfigFile(conf), {a: 1, __internal__: {migrations: {version: '1.0.0'}}});
	});
});

describe('many keys below one parent', () => {
	// Every key below the same parent was once written into a fresh copy of that parent, so the work grew with the square of the number of keys, and 20 000 of them took most of a minute.
	it('are written and filled in at a cost that grows with their number', () => {
		const count = 20_000;
		const keys = Object.fromEntries(Array.from({length: count}, (_, index) => [`parent.key${index}`, index]));

		const start = performance.now();
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), defaults: keys});
		conf.set(keys);
		const duration = performance.now() - start;

		assert.equal(Object.keys(conf.get('parent') as Record<string, unknown>).length, count);
		// A bound far above what the linear work takes, and far below what the square of it took.
		assert.ok(duration < 10_000, `took ${Math.round(duration)} ms`);
	});
});
