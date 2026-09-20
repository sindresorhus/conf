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
	settle,
	createResolvedTempDirectory,
	linkedConfig,
	untilWatching,
} from './_utilities.js';

// A name that holds half of a surrogate pair, which is what a string sliced between the two halves of an emoji holds, and what `JSON.parse` of an escaped lone surrogate holds. The name is written to the file system as a replacement character, since that is the only UTF-8 form of a character that is not one, and a name read back as text is a name that no longer equals the one that was written.
const loneSurrogateName = 'con\uD800fig';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a watched symlink at the config path', () => {
	// The write follows the link, so the file can be in a directory the watcher is not watching, and a link that is put in place or repointed is itself a change in the directory the path is in. Watching only one of the two loses a change the other holds.
	for (const [name, replace] of [
		['replaced by a file', (cwd: string) => {
			fs.rmSync(path.join(cwd, 'config.json'));
			fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({v: 9}));
		}],
		['repointed at a file beside the link', (cwd: string) => {
			fs.rmSync(path.join(cwd, 'config.json'));
			fs.symlinkSync(path.join(cwd, 'other.json'), path.join(cwd, 'config.json'));
			fs.writeFileSync(path.join(cwd, 'other.json'), JSON.stringify({v: 7}));
		}],
	] as Array<[string, (cwd: string) => void]>) {
		it(`reports a change to a link that is ${name}`, {skip: skipWatching}, async () => {
			const base = createTempDirectory();
			const cwd = path.join(base, 'cwd');
			fs.mkdirSync(cwd);
			fs.mkdirSync(path.join(base, 'elsewhere'));
			fs.symlinkSync(path.join(base, 'elsewhere', 'shared.json'), path.join(cwd, 'config.json'));

			const writer = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));
			const watcher = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));
			await untilWatching();
			let change = nextChange(watcher);
			writer.set('v', 1);
			await change;
			assert.strictEqual(watcher.get('v'), 1, 'the value before the change');

			let reported = 0;
			watcher.onDidChange('v', () => {
				reported++;
			});

			change = nextChange(watcher);
			replace(cwd);
			await change;
			await untilQuiet(() => reported);
			assert.strictEqual(reported, 1, `the changes reported with the link ${name}`);
			assert.notStrictEqual(watcher.get('v'), 1, 'the value the watcher reads after the change');
		});
	}
});

describe('watching a config path that is a symlink', () => {
	// The file a link points at is watched as well as the link, and a link beside the file it points at is the one case where the two are in the same directory. The directory is watched once for each of the two files, since one watcher for a directory is told about the events of every file in it and answers for the name of only one of them.
	for (const [name, target] of [
		['in the same directory', 'shared.json'],
		['in another directory', path.join('..', 'elsewhere', 'shared.json')],
	] as Array<[string, string]>) {
		it(`reports a change to the file a link points at, ${name}`, {skip: skipWatching}, async () => {
			// A path with a link of its own in it is a path the two are different spellings of, which is what a temporary directory on macOS is and what any other one is not.
			const base = createResolvedTempDirectory();
			const cwd = path.join(base, 'cwd');
			fs.mkdirSync(cwd);
			const targetPath = path.resolve(cwd, target);
			fs.mkdirSync(path.dirname(targetPath), {recursive: true});
			fs.symlinkSync(targetPath, path.join(cwd, 'config.json'));

			const writer = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));
			const watcher = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));
			await untilWatching();
			let change = nextChange(watcher);
			writer.set('v', 1);
			await change;
			assert.strictEqual(watcher.get('v'), 1, 'the value before the change');

			let fired = 0;
			watcher.onDidChange('v', () => {
				fired++;
			});

			change = nextChange(watcher);
			writer.set('v', 2);
			await change;
			await untilQuiet(() => fired);
			assert.strictEqual(fired, 1, 'the changes reported');
			assert.strictEqual(watcher.get('v'), 2, 'the value the watching store reads');
		});
	}

	// A link beside the file it points at is watched for both of its own changes, since a link is put in place, repointed and taken away in the directory it is in, whichever file the config is at that moment.
	it('reports a link that is repointed at a file beside it', {skip: skipWatching}, async () => {
		const base = createResolvedTempDirectory();
		const cwd = path.join(base, 'cwd');
		fs.mkdirSync(cwd);
		fs.symlinkSync('shared.json', path.join(cwd, 'config.json'));

		const writer = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));
		const watcher = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));
		await untilWatching();
		let change = nextChange(watcher);
		writer.set('v', 1);
		await change;

		let fired = 0;
		watcher.onDidChange('v', () => {
			fired++;
		});

		// The link is repointed at a file beside it, which is a change in the directory the link is in rather than in the one the file it pointed at was in.
		change = nextChange(watcher);
		fs.rmSync(path.join(cwd, 'config.json'));
		fs.symlinkSync('other.json', path.join(cwd, 'config.json'));
		fs.writeFileSync(path.join(cwd, 'other.json'), JSON.stringify({v: 2}, undefined, '\t'));
		await change;
		await untilQuiet(() => fired);
		assert.strictEqual(fired, 1, 'the changes reported');
		assert.strictEqual(watcher.get('v'), 2, 'the value the watching store reads');
	});

	// One watcher is enough for a file that is not behind a link, and a change to a file beside it is not a change to the config.
	it('reports nothing for a change to a file beside the config', {skip: skipWatching}, async () => {
		const cwd = createTempDirectory();
		const watcher = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));
		// The watcher has to see the write below, which is what lets go of the bytes the store wrote, or the change beside the config is held back by those bytes rather than by its name.
		await untilWatching();
		watcher.set('v', 1);
		await settle();

		// The events are counted as the store dispatches them, since a listener that compares values would not tell a change it was wrongly told about from no change at all.
		let fired = 0;
		watcher.events.addEventListener('change', () => {
			fired++;
		});

		fs.writeFileSync(path.join(cwd, 'beside.json'), JSON.stringify({other: true}));
		await settle();
		assert.strictEqual(fired, 0, 'the changes reported');

		// A change to the config itself is still reported, so the watcher was there to report the one above.
		const change = nextChange(watcher);
		fs.writeFileSync(watcher.path, JSON.stringify({v: 2}));
		await change;
		await untilQuiet(() => fired);
		assert.strictEqual(fired, 1, 'the change to the config is reported');
		assert.strictEqual(watcher.get('v'), 2);
	});
});

describe('`watch` with a symlink at the config path', {skip: skipWatching}, () => {
	it('reports a change to a config file reached through a link in its own path', async () => {
		// The path of a store is the one the caller wrote and is never made absolute past a link, so a `cwd` that is itself a link leaves a path with a link of its own in it, and a watcher is made for the directory the path resolves into rather than for the path.
		const base = createResolvedTempDirectory();
		const real = path.join(base, 'real');
		const link = path.join(base, 'link');
		fs.mkdirSync(real);
		fs.symlinkSync(real, link);

		const watcher = trackConf(new Conf<Record<string, unknown>>({cwd: link, watch: true, cache: true}));
		const writer = new Conf<Record<string, unknown>>({cwd: link});

		assert.ok(watcher.path.includes(link), 'the path is the one the caller wrote');
		// A watcher that was just made can miss an event that comes at once, since the file system takes a moment to start delivering them, so the store is left alone for a moment first.
		await settle();
		let change = nextChange(watcher);
		writer.set('own', 1);
		await change;
		assert.strictEqual(watcher.get('own'), 1, 'the store reads what the file behind the link holds');

		let reported = 0;
		watcher.events.addEventListener('change', () => {
			reported++;
		});

		// A report of the first write that is still on its way is let through before the count starts.
		await untilQuiet(() => reported);
		reported = 0;

		change = nextChange(watcher);
		writer.set('own', 2);
		await change;
		await untilQuiet(() => reported);

		assert.strictEqual(reported, 1, 'the change to the file behind the link is reported once');
		assert.strictEqual(watcher.get('own'), 2, 'the store reads what the file holds');
	});

	it('reports the link at the config path being taken away', async () => {
		const {cwd} = linkedConfig();
		const conf = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));

		conf.set('own', 1);
		await settle();
		assert.strictEqual(conf.get('own'), 1, 'the value before the link is taken away');

		// The link is resolved once, when watching starts, and the directory it is in is watched along with the one it points into, so taking the link away is a change there. A read goes through the config path, which then holds nothing, so the store reads as one that is not there.
		const change = nextChange(conf);
		fs.rmSync(path.join(cwd, 'config.json'));
		await change;

		assert.strictEqual(conf.get('own'), undefined, 'the store reads a store with no config file in it');
	});

	it('reports the file a link pointed at coming to stand for a directory', async () => {
		const {cwd, first: target} = linkedConfig();
		const conf = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));

		conf.set('own', 1);
		await settle();

		// A directory where the config file was is not a file a write can be made into either, and the change that put it there is reported rather than left for a write to find.
		const change = nextChange(conf);
		fs.rmSync(path.join(target, 'shared.json'));
		fs.mkdirSync(path.join(target, 'shared.json'));
		await change;

		assert.throws(() => conf.get('own'), {code: 'EISDIR'}, 'the store reports the read that cannot be made rather than answering with what is there');
	});
});

describe('`watch` with a config name the file system spells its own way', {skip: skipWatching}, () => {
	// The same name written two ways: `caf\u00E9`, which is the accent baked into the letter, and `cafe\u0301`, which is a combining accent after it, and `config` in a case of its own. A volume that keeps a name apart without a form or a case holds one file under both spellings and reports a change to it under the one it holds, which is not the one the path was written with, so the two are written out rather than typed where a reader would see the same name twice.
	for (const [spelling, first, second] of [
		['normalization', 'caf\u00E9', 'cafe\u0301'],
		['case', 'config', 'CONFIG'],
	] as Array<[string, string, string]>) {
		it(`reports a change to a config file the file system spells with a ${spelling} of its own`, async t => {
			const base = createResolvedTempDirectory();
			const cwd = path.join(base, 'cwd');
			fs.mkdirSync(cwd);
			// The file is made under one spelling and the store that watches it is opened at the other, which is the case a watcher can only answer by asking the file system.
			fs.writeFileSync(path.join(cwd, `${first}.json`), JSON.stringify({v: 0}, undefined, '\t'));

			// A volume that keeps the two spellings apart holds two files, and which volume this is says nothing about the module, so the case is one that runs only where the volume holds one file under both.
			if (!fs.existsSync(path.join(cwd, `${second}.json`))) {
				t.skip(`the volume keeps names apart by ${spelling}`);
				return;
			}

			const writer = new Conf<Record<string, unknown>>({cwd, configName: first});
			const watcher = trackConf(new Conf<Record<string, unknown>>({
				cwd, configName: second, watch: true, cache: true,
			}));

			assert.deepStrictEqual(fs.readdirSync(cwd), [`${first}.json`], 'the two spellings are one file');

			// A watcher that was just made can miss an event that comes at once, since the file system takes a moment to start delivering them, so the store is left alone for a moment first.
			await settle();
			let change = nextChange(watcher);
			writer.set('v', 1);
			await change;
			assert.strictEqual(watcher.get('v'), 1, 'the store reads the file the other spelling names');

			let reported = 0;
			watcher.events.addEventListener('change', () => {
				reported++;
			});

			// A report of the first write that is still on its way is let through before the count starts.
			await untilQuiet(() => reported);
			reported = 0;

			change = nextChange(watcher);
			writer.set('v', 2);
			await change;
			await untilQuiet(() => reported);

			assert.strictEqual(reported, 1, 'the change to the file is reported once');
			assert.strictEqual(watcher.get('v'), 2, 'the store reads what the file holds');
		});
	}
});

describe('`watch` with a config directory that is taken away and made again', {skip: skipWatching}, () => {
	it('reports a change to a file in a directory that was made again', async () => {
		const cwd = createTempDirectory();
		const conf = trackConf(new Conf<Record<string, unknown>>({cwd, watch: true, cache: true}));

		conf.set('v', 1);
		await settle();
		assert.strictEqual(conf.get('v'), 1, 'the value before the directory is taken away');

		// A directory the store made for itself is taken away whole, which is what a tool that clears a directory it was given does. Nothing is reported for the taking away, since a watcher made for a directory is not told that the directory itself is gone, and the store reads what the file holds again as soon as the directory is there.
		fs.rmSync(cwd, {recursive: true, force: true});
		await settle();
		fs.mkdirSync(cwd, {recursive: true});

		const change = nextChange(conf);
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({v: 2}, undefined, '\t'));
		await change;

		assert.strictEqual(conf.get('v'), 2, 'the store reads what the file the new directory holds');
	});
});

describe('a watched config file with an awkward name', () => {
	it('reports a change to a file whose name does not survive a round trip through UTF-8', {skip: skipWatching}, async () => {
		// A temporary directory on macOS is reached through a link, which is what any other one is not, and a watcher is made for the directory the path is in rather than for the path.
		const base = createResolvedTempDirectory();
		const cwd = path.join(base, 'cwd');
		fs.mkdirSync(cwd);

		const options = {
			cwd,
			configName: loneSurrogateName,
			watch: true,
			cache: true,
		};
		const writer = trackConf(new Conf<Record<string, unknown>>(options));
		const watcher = trackConf(new Conf<Record<string, unknown>>(options));
		await untilWatching();
		let change = nextChange(watcher);
		writer.set('v', 1);
		await change;
		assert.strictEqual(watcher.get('v'), 1, 'the value before the change');

		let fired = 0;
		watcher.onDidChange('v', () => {
			fired++;
		});

		change = nextChange(watcher);
		writer.set('v', 2);
		await change;
		await untilQuiet(() => fired);

		assert.strictEqual(fired, 1, 'the change is reported');
		assert.strictEqual(watcher.get('v'), 2, 'the value the watching store reads');
	});
});
