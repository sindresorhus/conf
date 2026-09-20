/* eslint-disable @typescript-eslint/naming-convention -- The keys of a `patternProperties` and the versions a `migrations` option is keyed by are the ones the caller wrote, and neither is a name in this module. */
import fs from 'node:fs';
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	trackConf,
	runRegisteredCleanups,
	resetTrackedConfs,
	skipWatching,
	nextChange,
	untilQuiet,
	getMigrationVersion,
	settle,
} from './_utilities.js';

/**
A store that watches the config file in a directory of its own, one that writes the same file without watching it, and a count of the changes the watching store has been told about.

The two are kept apart because the properties this file checks are about what one store does while another is changing the file underneath it, and a store that watches and writes at the same time is told about its own writes by the `store` setter rather than by the watcher.
*/
const watchingPair = (options: Readonly<Record<string, unknown>> = {}) => {
	const cwd = createTempDirectory();
	const watcher = trackConf(new Conf<Record<string, unknown>>({
		...options, cwd, watch: true, cache: true,
	}));
	const writer = new Conf<Record<string, unknown>>({...options, cwd});
	let reported = 0;

	watcher.events.addEventListener('change', () => {
		reported++;
	});

	return {
		watcher,
		writer,
		reported: () => reported,
	};
};

/**
The three things a store that watches its config file has to do for a change it did not make, run for one set of options: report it exactly once, leave a change of its own unreported as one from elsewhere, and be left reading what the file holds.

`changeFromOutside` is what makes the change the writing store does not make. It is a plain file write for a store this module can read, and a write through the other store for one it cannot, since a file this module encrypted is bytes only a key reads.
*/
const checkThreeProperties = async (
	options: Readonly<Record<string, unknown>>,
	changeFromOutside: (configPath: string, writer: Conf) => void,
	own: unknown,
): Promise<void> => {
	const {watcher, writer, reported} = watchingPair(options);

	// A write the store makes itself is reported by the `store` setter, so the watcher has to leave it at that.
	watcher.set('own', 1);
	await untilQuiet(reported);
	assert.strictEqual(reported(), 1, 'the write of this store is reported once, by the setter');

	const change = nextChange(watcher);
	changeFromOutside(watcher.path, writer);
	await change;
	await untilQuiet(reported);

	assert.strictEqual(reported(), 2, 'the change from outside is reported once, by the watcher');
	assert.strictEqual(watcher.get('own'), own, 'the store reads what the file holds');
};

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

// Every case below is one where the file system has to deliver an event for the watcher to report, so a case that runs where the events do not arrive would pass without showing anything. Each case has a directory of its own.
describe('`watch` with every other option', {skip: skipWatching}, () => {
	it('reports a change once with `schema`', async () => {
		await checkThreeProperties(
			{schema: {own: {type: 'number'}, other: {type: 'string'}}},
			configPath => {
				fs.writeFileSync(configPath, JSON.stringify({own: 2, other: 'a string'}, undefined, '\t'));
			},
			2,
		);
	});

	it('reports a change once with `rootSchema`', async () => {
		await checkThreeProperties(
			{
				rootSchema: {
					patternProperties: {
						'^own$': {type: 'number'},
						'^thing$': {type: 'object', properties: {inner: {type: 'string'}}},
					},
				},
			},
			configPath => {
				fs.writeFileSync(configPath, JSON.stringify({own: 2, thing: {inner: 'a string'}}, undefined, '\t'));
			},
			2,
		);
	});

	it('reports a change once with `ajvOptions`', async () => {
		await checkThreeProperties(
			{schema: {own: {type: 'number'}}, ajvOptions: {coerceTypes: true, useDefaults: false}},
			configPath => {
				fs.writeFileSync(configPath, JSON.stringify({own: 2}, undefined, '\t'));
			},
			2,
		);
	});

	it('reports a change once with `defaults`', async () => {
		await checkThreeProperties(
			{defaults: {filled: 'from the option'}, schema: {own: {type: 'number'}}},
			configPath => {
				fs.writeFileSync(configPath, JSON.stringify({own: 2, filled: 'from the file'}, undefined, '\t'));
			},
			2,
		);
	});

	for (const encryptionAlgorithm of ['aes-256-cbc', 'aes-256-gcm', 'aes-256-ctr'] as const) {
		it(`reports a change once with \`encryptionKey\` and ${encryptionAlgorithm}`, async () => {
			await checkThreeProperties(
				{encryptionKey: 'a key', encryptionAlgorithm},
				// The bytes of a file this module encrypted are made fresh on every write, so the change is one only a key can make and the other store is the one that makes it.
				(_configPath, writer) => {
					writer.set('own', 2);
				},
				2,
			);
		});
	}

	it('reports a change once with a `serialize` and a `deserialize` of the caller', async () => {
		await checkThreeProperties(
			{
				serialize: (value: unknown) => JSON.stringify(value, undefined, '\t'),
				deserialize: (text: string) => JSON.parse(text) as Record<string, unknown>,
			},
			configPath => {
				fs.writeFileSync(configPath, JSON.stringify({own: 2}, undefined, '\t'));
			},
			2,
		);
	});

	it('reports a change once with `configFileMode`', async () => {
		await checkThreeProperties(
			{configFileMode: 0o600},
			configPath => {
				fs.writeFileSync(configPath, JSON.stringify({own: 2}, undefined, '\t'));
			},
			2,
		);
	});

	it('reports a change once with a `configName` below `cwd`', async () => {
		await checkThreeProperties(
			{configName: 'nested/config'},
			configPath => {
				fs.writeFileSync(configPath, JSON.stringify({own: 2}, undefined, '\t'));
			},
			2,
		);
	});

	it('reports a change once with a `fileExtension` of its own', async () => {
		await checkThreeProperties(
			{fileExtension: 'yaml'},
			configPath => {
				fs.writeFileSync(configPath, JSON.stringify({own: 2}, undefined, '\t'));
			},
			2,
		);
	});

	it('reports a change once with `accessPropertiesByDotNotation: false`', async () => {
		await checkThreeProperties(
			{accessPropertiesByDotNotation: false, schema: {own: {type: 'number'}}},
			configPath => {
				fs.writeFileSync(configPath, JSON.stringify({own: 2}, undefined, '\t'));
			},
			2,
		);
	});

	it('reports a change once with a `serialize` that writes a file the store cannot read back', async () => {
		const cwd = createTempDirectory();
		// The `serialize` is the caller's own code and can answer with something a read of this module cannot make a store of, which is the case a watcher has to leave alone the same way it leaves any other write of this store alone.
		let answerWithSomethingElse = false;
		const conf = trackConf(new Conf<Record<string, unknown>>({
			cwd,
			watch: true,
			cache: true,
			serialize: value => answerWithSomethingElse ? 'not a store at all' : JSON.stringify(value, undefined, '\t'),
		}));
		let reported = 0;
		conf.events.addEventListener('change', () => {
			reported++;
		});

		conf.set('own', 1);
		await untilQuiet(() => reported);
		assert.strictEqual(reported, 1, 'the write of this store is reported once, by the setter');

		answerWithSomethingElse = true;
		conf.set('own', 2);
		await untilQuiet(() => reported);
		// Only the `store` setter has reported, since the write of this store is the only change the watcher leaves alone, whatever the write left in the file.
		assert.strictEqual(reported, 2, 'a write the store cannot read back is left alone by the watcher');
		assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), 'not a store at all', 'the file holds what the write put there');
		assert.throws(() => conf.get('own'), {name: 'SyntaxError'}, 'the store cannot read back what it wrote');

		answerWithSomethingElse = false;
		const change = nextChange(conf);
		fs.writeFileSync(conf.path, JSON.stringify({own: 3}, undefined, '\t'));
		await change;
		await untilQuiet(() => reported);

		assert.strictEqual(reported, 3, 'the change from outside is reported once');
		assert.strictEqual(conf.get('own'), 3, 'the store reads what the file holds');
	});

	it('reports a change once with `clearInvalidConfig`', async () => {
		const {watcher, reported} = watchingPair({clearInvalidConfig: true, schema: {own: {type: 'number'}}});

		watcher.set('own', 1);
		await untilQuiet(reported);
		assert.strictEqual(reported(), 1, 'the write of this store is reported once, by the setter');

		// A file damaged behind the store's back is a change that clears the file rather than a change that is read, so what the store is told about is the store the file is left holding.
		const change = nextChange(watcher);
		fs.writeFileSync(watcher.path, 'this is not JSON');
		await change;
		await untilQuiet(reported);

		assert.strictEqual(reported(), 2, 'the damage is reported once');
		assert.deepStrictEqual({...watcher.store}, {}, 'the file is cleared and the store reads what it is left holding');
	});

	// A file damaged behind the store's back with nothing set to clear it is a change the watcher cannot read, and a read that throws from the watcher has nothing above it to catch it, so it would take the process down rather than leave the store as it is. A listener is not told of a change it could not read either, which is what the readme says of a change noticed while the file cannot be read.
	it('survives a file damaged behind its back with nothing set to clear it', async () => {
		const cwd = createTempDirectory();
		const watcher = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, schema: {own: {type: 'number'}}}));

		// The count is of what a listener is told, since the watcher dispatches an event of its own for a change it could not read, which is not a change it is reporting to anyone.
		const reported: unknown[][] = [];
		watcher.onDidChange('own', (newValue, oldValue) => {
			reported.push([newValue, oldValue]);
		});

		watcher.set('own', 1);
		await settle();
		assert.deepStrictEqual(reported, [[1, undefined]], 'the write of this store is reported once');

		// The event the watcher dispatches for the damage is waited for, and a listener is reached for it within the same dispatch, so it has been reached for the change it could not read by the time it is checked.
		let change = nextChange(watcher);
		fs.writeFileSync(watcher.path, 'this is not JSON');
		await change;

		// The file is where it was put, since nothing here clears it, and the store reads the error rather than a value, which is what a caller reading an unreadable file is given.
		assert.strictEqual(fs.readFileSync(watcher.path, 'utf8'), 'this is not JSON', 'the file is left as it was put');
		assert.throws(() => watcher.get('own'), {name: 'SyntaxError'}, 'and the store cannot read it');
		assert.deepStrictEqual(reported, [[1, undefined]], 'a change nothing could read is not reported');

		// The watcher is still there after the change it could not read, and reports the next one.
		change = nextChange(watcher);
		fs.writeFileSync(watcher.path, JSON.stringify({own: 2}, undefined, '\t'));
		await change;
		assert.deepStrictEqual(reported, [[1, undefined], [2, 1]], 'the change after it is reported');
	});

	// A read the watcher makes has nothing above it to catch what it throws, since it runs from a `nextTick` in the event target, so a file it cannot read would take the process down rather than leave the store as it is. Every option that changes what happens to an unreadable file is in this one test, since the difference is in whether the read is guarded and not in which option is set.
	for (const [name, companion] of [
		['nothing', {}],
		['cache', {cache: true}],
		['a schema', {schema: {a: {type: 'number'}}}],
		['a schema with defaults', {schema: {a: {type: 'number'}}, defaults: {a: 1}}],
		['clearInvalidConfig', {clearInvalidConfig: true}],
	] as Array<[string, Record<string, unknown>]>) {
		it(`survives a file it cannot read, with ${name}`, async () => {
			const cwd = createTempDirectory();
			const conf = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, ...companion}));
			conf.set('a', 1);

			// A listener that reads nothing, which is the case where there is nothing to catch a throw.
			conf.onDidAnyChange(() => {
				// Nothing is read, which is the point of it.
			});

			await settle();

			// The change is waited for, so the watcher has been through the read it could not make by the time the store is checked.
			let change = nextChange(conf);
			fs.writeFileSync(conf.path, '{ damaged');
			await change;

			// The process is still here, which is the whole of what this holds. A read the caller makes of a file the store could not read is still refused, since a caller can catch that and a watcher cannot, and a file the option clears is a file the store can read.
			if (companion.clearInvalidConfig) {
				assert.deepStrictEqual({...conf.store}, {}, `the damaged file is cleared, with ${name}`);
			} else {
				assert.throws(() => conf.get('a'), {name: 'SyntaxError'}, `a caller still reads the error, with ${name}`);
			}

			// The watcher is still there after the change it could not read, and reports the next one.
			change = nextChange(conf);
			fs.writeFileSync(conf.path, JSON.stringify({a: 2}, undefined, '\t'));
			await change;
			assert.strictEqual(conf.get('a'), 2, `the store reads the change after it, with ${name}`);
		});
	}

	it('reports a change once with `cache: false`', async () => {
		const cwd = createTempDirectory();
		const watcher = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: false}));
		const writer = new Conf<Record<string, unknown>>({cwd});
		let reported = 0;
		watcher.events.addEventListener('change', () => {
			reported++;
		});

		watcher.set('own', 1);
		await untilQuiet(() => reported);
		assert.strictEqual(reported, 1, 'the write of this store is reported once, by the setter');

		const change = nextChange(watcher);
		writer.set('own', 2);
		await change;
		await untilQuiet(() => reported);

		assert.strictEqual(reported, 2, 'the change the other store made is reported once');
		assert.strictEqual(watcher.get('own'), 2, 'the store reads what the file holds');
	});
});

describe('`watch` with `migrations`', {skip: skipWatching}, () => {
	it('leaves a migration write unreported and keeps the version it records', async () => {
		const cwd = createTempDirectory();
		// A store that does not exist yet skips its migrations, so the file is made the way one that has been opened before leaves it.
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({old: true}, undefined, '\t'));

		let reported = 0;
		const conf = trackConf(new Conf<Record<string, unknown>>({
			cwd,
			watch: true,
			cache: true,
			projectVersion: '2.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('migrated', true);
				},
			},
		}));
		conf.events.addEventListener('change', () => {
			reported++;
		});

		// The migrations run before the watcher is made, so none of their writes is a change the watcher has to leave alone, and a change that arrives afterwards is still reported.
		await untilQuiet(() => reported);
		assert.strictEqual(reported, 0, 'the writes of the migrations are not reported');
		assert.strictEqual(conf.get('migrated'), true, 'the store holds what the migration wrote');
		assert.strictEqual(getMigrationVersion(conf), '2.0.0', 'the version the migration recorded survived');

		const change = nextChange(conf);
		fs.writeFileSync(conf.path, JSON.stringify({old: true, migrated: true, added: 1}, undefined, '\t'));
		await change;
		await untilQuiet(() => reported);

		assert.strictEqual(reported, 1, 'the change from outside is reported once');
		assert.strictEqual(conf.get('added'), 1, 'the store reads what the file holds');
	});
});
