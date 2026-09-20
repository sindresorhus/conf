/* eslint-disable no-new -- A store is often built only for the option it refuses. */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import envPaths from 'env-paths';
import Conf, {type Options} from '../source/index.js';
import {
	createTempDirectory,
	runRegisteredCleanups,
	registerCleanup,
	resetTrackedConfs,
	nextProjectName,
	createNullProtoObject,
	readConfigFile,
	createResolvedTempDirectory,
} from './_utilities.js';

const fixture = '🦄';

type Store = Record<string, any>;

// A name that holds half of a surrogate pair, which is what a string sliced between the two halves of an emoji holds, and what `JSON.parse` of an escaped lone surrogate holds. The name is written to the file system as a replacement character, since that is the only UTF-8 form of a character that is not one, and a name read back as text is a name that no longer equals the one that was written.
const loneSurrogateName = 'con\uD800fig';

// The bytes the name stands for on the file system, which is a replacement character where the string holds half of a surrogate pair.
const nameOnDisk = 'con�fig.json';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

/**
Takes away the config directory `env-paths` gives the project once the test is done, since a store with a `projectName` and no `cwd` makes it in the user's own config directory. The project name comes from `nextProjectName()`, so the directory is one the test made.
*/
const removeConfigDirectoryAfterwards = (projectName: string, projectSuffix = 'nodejs'): void => {
	const directory = envPaths(projectName, {suffix: projectSuffix}).config;
	registerCleanup(() => {
		fs.rmSync(directory, {recursive: true, force: true});
	});
};

describe('the path of the config file', () => {
	it('throws when neither projectName nor cwd is given', () => {
		assert.throws(() => {
			new Conf({});
		}, {message: 'Please specify the `projectName` option.'});
	});

	it('uses cwd when given without projectName', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd});
		assert.ok(conf.path.startsWith(cwd));
		assert.deepStrictEqual(conf.store, createNullProtoObject({}));
	});

	it('resolves path from cwd, configName and fileExtension', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, configName: 'my-app', fileExtension: 'alt-ext'});
		assert.strictEqual(conf.path, path.resolve(cwd, 'my-app.alt-ext'));
		assert.strictEqual(conf.get('foo'), undefined);
		conf.set('foo', fixture);
		assert.strictEqual(conf.get('foo'), fixture);
		assert.deepStrictEqual(readConfigFile(conf.path), {foo: fixture});
	});

	it('normalizes fileExtension with leading dots', () => {
		for (const fileExtension of ['json', '.json', '..json', '...json']) {
			const conf = new Conf({cwd: createTempDirectory(), fileExtension});
			assert.strictEqual(path.basename(conf.path), 'config.json');
		}
	});

	it('supports empty fileExtension (no extension)', () => {
		const conf = new Conf({cwd: createTempDirectory(), configName: 'myconfig', fileExtension: ''});
		assert.strictEqual(path.basename(conf.path), 'myconfig');
		assert.ok(!conf.path.endsWith('.'));
	});

	it('creates nested cwd directories on first write', () => {
		const base = createTempDirectory();
		const nested = path.join(base, 'a', 'b', 'c');
		const conf = new Conf({cwd: nested});
		conf.set('x', 1);
		assert.strictEqual(conf.get('x'), 1);
		assert.ok(fs.existsSync(conf.path));
	});

	it('missing projectName with cwd works, without cwd throws', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		assert.ok(conf.path.length > 0);
		assert.throws(() => {
			new Conf({projectName: ''});
		}, {name: 'Error', message: 'Please specify the `projectName` option.'});
	});
});

describe('the layout of the config file', () => {
	it('exposes an absolute path', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		assert.ok(path.isAbsolute(conf.path));
	});

	it('writes JSON with tab indentation by default', () => {
		const conf = new Conf({cwd: createTempDirectory()});
		conf.set('a', {b: 1});
		const raw = fs.readFileSync(conf.path, 'utf8');
		assert.ok(raw.includes('\t'));
		assert.deepStrictEqual(JSON.parse(raw), {a: {b: 1}});
	});

	it('keeps different configNames independent in one directory', () => {
		const cwd = createTempDirectory();
		const first = new Conf({cwd, configName: 'one'});
		const second = new Conf({cwd, configName: 'two'});
		assert.notStrictEqual(first.path, second.path);
		first.set('x', 1);
		second.set('y', 2);
		assert.deepStrictEqual(first.store, createNullProtoObject({x: 1}));
		assert.deepStrictEqual(second.store, createNullProtoObject({y: 2}));
	});

	it('supports a nested configName by creating directories', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, configName: path.join('sub', 'dir')});
		conf.set('a', 1);
		assert.ok(fs.existsSync(conf.path));
		assert.strictEqual(conf.get('a'), 1);
	});

	it('supports dotted configName values', () => {
		const conf = new Conf({cwd: createTempDirectory(), configName: 'my.config'});
		assert.strictEqual(path.basename(conf.path), 'my.config.json');
		conf.set('a', 1);
		assert.strictEqual(conf.get('a'), 1);
	});

	it('throws for missing projectName including explicit undefined', () => {
		assert.throws(() => {
			new Conf(undefined);
		}, {message: 'Please specify the `projectName` option.'});
		assert.throws(() => {
			new Conf({});
		}, {message: 'Please specify the `projectName` option.'});
	});

	it('explicit undefined options fall back to defaults', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			configName: undefined,
			fileExtension: undefined,
			accessPropertiesByDotNotation: undefined,
		});
		assert.strictEqual(path.basename(conf.path), 'config.json');
		conf.set('a.b', 1);
		assert.deepStrictEqual(conf.get('a'), {b: 1});
	});
});

describe('an option documented as an object that is not one', () => {
	// A falsy value that is not `null` is refused rather than taken for no option at all, so `schema: isDev && {…}` is told the flag was the wrong type.
	for (const name of ['schema', 'rootSchema', 'ajvOptions'] as const) {
		it(`refuses a \`${name}\` that is not an object`, () => {
			for (const value of [true, false, 1, 0, 'nope', '', Number.NaN, Symbol('x')]) {
				assert.throws(() => {
					new Conf<Store>({cwd: createTempDirectory(), [name]: value});
				}, {name: 'TypeError', message: `The \`${name}\` option must be an object.`}, `for ${String(value)}`);
			}
		});

		it(`takes a \`${name}\` of \`null\` for no option at all`, () => {
			const cwd = createTempDirectory();
			// No option means no validation, so a value of any type is taken.
			const conf = new Conf<Store>({cwd, [name]: null});
			conf.set('anything', 1);
			conf.set('anything', 'text');
			assert.strictEqual(new Conf<Store>({cwd}).get('anything'), 'text');
		});
	}
});

describe('an option the caller sets to nothing', () => {
	it('`fileExtension` still defaults to `json`', () => {
		const cwd = createTempDirectory();

		// An option set to `undefined` is the same as one not passed, and so is one set to `null`, which is how every option here is read.
		for (const fileExtension of [undefined, null]) {
			const config = new Conf({cwd, fileExtension} as Partial<Options<Record<string, unknown>>>);

			assert.equal(config.path, path.join(cwd, 'config.json'));
		}
	});

	it('`configName` still defaults to `config`', () => {
		const cwd = createTempDirectory();

		for (const configName of [undefined, null]) {
			const config = new Conf({cwd, configName} as Partial<Options<Record<string, unknown>>>);

			assert.equal(config.path, path.join(cwd, 'config.json'));
		}
	});

	it('`accessPropertiesByDotNotation` still defaults to `true`', () => {
		const cwd = createTempDirectory();

		for (const accessPropertiesByDotNotation of [undefined, null]) {
			const config = new Conf({cwd, accessPropertiesByDotNotation} as Partial<Options<Record<string, unknown>>>);
			config.set('foo.bar', 'baz');

			assert.deepEqual(config.store, createNullProtoObject({foo: {bar: 'baz'}}));
			assert.equal(config.get('foo.bar'), 'baz');
		}
	});

	it('`projectSuffix` still defaults to `nodejs`', () => {
		for (const projectSuffix of [undefined, null]) {
			const projectName = nextProjectName();
			removeConfigDirectoryAfterwards(projectName);
			const config = new Conf({projectName, projectSuffix} as Partial<Options<Record<string, unknown>>>);
			assert.ok(config.path.includes(`${projectName}-nodejs`), config.path);
		}
	});

	it('`defaults` itself set to `null` is the same as not passing it', () => {
		// The guard that copies the option asked only whether it was `undefined`, so a `null` went on to be read as the entries of an object and was refused with a message naming neither the option nor the value.
		const conf = new Conf({cwd: createTempDirectory(), defaults: null} as unknown as Partial<Options<Record<string, unknown>>>);

		assert.deepEqual(conf.store, createNullProtoObject({}));

		conf.set('foo', 'bar');

		assert.equal(conf.get('foo'), 'bar');
	});

	it('leaves a `defaults` value of `null` alone, since there `null` is a value', () => {
		const conf = new Conf({cwd: createTempDirectory(), defaults: {nothing: null, something: 1}});

		// The option drops the keys a caller set to `undefined` and not the ones set to `null`, since `null` is a value a store can hold here.
		assert.equal(conf.has('nothing'), true);
		assert.equal(conf.get('nothing'), null);
		assert.equal(conf.get('something'), 1);

		conf.clear();

		assert.equal(conf.get('nothing'), null);
		assert.equal(conf.get('something'), 1);
	});

	it('options that are explicitly `undefined` use their default', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: undefined,
			fileExtension: undefined,
		});

		// Both options have a default, so passing `undefined` must be the same as not passing them.
		assert.strictEqual(path.basename(conf.path), 'config.json');

		conf.set('foo.bar', true);
		assert.deepStrictEqual(conf.get('foo.bar'), true);
	});
});

describe('a `schema` that is not one', () => {
	it('is taken as no `schema` at all when it is `null`', () => {
		const cwd = createTempDirectory();
		const config = new Conf({cwd, schema: null, rootSchema: {additionalProperties: false}} as unknown as Partial<Options<Record<string, unknown>>>);

		// A `null` is the same as not passing one, which is how the option is read everywhere else, and a `rootSchema` on its own is the combination that is documented as legal.
		assert.deepEqual(config.store, createNullProtoObject({}));

		assert.throws(() => {
			config.set('foo', 'bar');
		}, {message: /Config schema violation/});
	});
});

describe('`configName` and `fileExtension`', () => {
	it('`configName` with a parent directory reference is refused', () => {
		const parent = createTempDirectory();
		const cwd = path.join(parent, 'config-directory');

		assert.throws(
			() => new Conf({cwd, configName: '../escaped', defaults: {foo: 'bar'}}),
			{message: /`configName`/},
		);

		assert.equal(fs.existsSync(path.join(parent, 'escaped.json')), false);
	});

	it('`configName` with a path separator is still allowed, since a nested name is supported', () => {
		const cwd = createTempDirectory();
		const config = new Conf({cwd, configName: path.join('sub', 'dir')});
		config.set('foo', 'bar');

		// The extension is appended to the whole name, so the file is `sub/dir.json` rather than a `config.json` below `sub/dir`.
		assert.equal(config.path, path.join(cwd, 'sub', 'dir.json'));
		assert.deepEqual(readConfigFile(config.path), {foo: 'bar'});
	});

	it('an absolute `configName` is refused', () => {
		const cwd = createTempDirectory();

		assert.throws(
			() => new Conf({cwd, configName: path.join(cwd, '..', 'escaped')}),
			{message: /`configName`/},
		);
	});

	it('`fileExtension` that reaches out of `cwd` is refused', () => {
		const parent = createTempDirectory();
		const cwd = path.join(parent, 'config-directory');

		assert.throws(
			() => new Conf({cwd, fileExtension: '/../../escaped', defaults: {foo: 'bar'}}),
			{message: /`fileExtension`/},
		);

		assert.equal(fs.existsSync(path.join(parent, 'escaped')), false);
	});

	it('a file name is still allowed to contain dots', () => {
		const cwd = createTempDirectory();
		const config = new Conf({cwd, configName: '.hidden', fileExtension: '.alt-ext'});

		assert.equal(config.path, path.join(cwd, '.hidden.alt-ext'));
	});

	it('a `fileExtension` of only dots is still allowed', () => {
		const cwd = createTempDirectory();
		const config = new Conf({cwd, fileExtension: '..'});

		assert.equal(config.path, path.join(cwd, 'config'));
	});

	it('a name that stays in `cwd` is still written where it says', () => {
		const cwd = createTempDirectory();
		const config = new Conf({cwd, configName: 'other'});
		config.set('foo', 'bar');

		assert.equal(config.path, path.join(cwd, 'other.json'));
		assert.deepEqual(readConfigFile(config.path), {foo: 'bar'});
	});
});

describe('`rootSchema` and `ajvOptions`', () => {
	it('a `rootSchema` that is not an object is refused', () => {
		const cwd = createTempDirectory();

		// `'properties' in rootSchema` refuses a primitive with a message about the `in` operator, which says nothing about which option was wrong. The type of the option is the keywords of a schema, so each value the runtime refuses is cast to reach it.
		for (const rootSchema of ['nope', 5, true]) {
			assert.throws(
				() => new Conf({cwd, rootSchema: rootSchema as never}),
				{name: 'TypeError', message: 'The `rootSchema` option must be an object.'},
			);
		}

		assert.deepEqual(fs.readdirSync(cwd), []);
	});

	it('an `ajvOptions` that is not an object is refused', () => {
		const cwd = createTempDirectory();

		// A string spread into the validator is a set of numbered keys it silently ignores, so a store that asks for one of them validates as though it were not given.
		for (const ajvOptions of ['nope', 5, true]) {
			assert.throws(
				() => new Conf({cwd, schema: {}, ajvOptions} as Partial<Options<Record<string, unknown>>>),
				{name: 'TypeError', message: 'The `ajvOptions` option must be an object.'},
			);
		}

		assert.deepEqual(fs.readdirSync(cwd), []);
	});

	it('a `rootSchema` is still honoured on its own', () => {
		const cwd = createTempDirectory();
		const config = new Conf({cwd, rootSchema: {additionalProperties: false}});

		assert.throws(() => {
			config.set('foo', 'bar');
		}, {message: /Config schema violation/});
	});
});

describe('a `configName` or `fileExtension` that is not a name', () => {
	it('refuses a NUL byte in either, rather than letting the file system report it', () => {
		// Every `fs` call refuses a path holding a NUL with an error from the engine that names neither option and not what is wrong with it, so it is refused where the other thing that is not a file name is.
		for (const [name, options] of [
			['a NUL in `configName`', {configName: 'a\u0000b'}],
			['a NUL in `fileExtension`', {fileExtension: '.js\u0000on'}],
		] as Array<[string, Record<string, unknown>]>) {
			assert.throws(
				() => new Conf({cwd: createTempDirectory(), ...options}),
				{name: 'TypeError', message: /must not hold a NUL byte/},
				name,
			);
		}
	});

	it('still takes a name holding the characters that are legal in one', () => {
		const cwd = createTempDirectory();
		const config = new Conf({cwd, configName: 'a.b c-d_e'});

		config.set('key', 'value');

		assert.equal(config.path, path.join(cwd, 'a.b c-d_e.json'));
		assert.equal(config.get('key'), 'value');
	});
});

describe('a config file name that is not the string the caller wrote', () => {
	afterEach(resetTrackedConfs);

	it('writes the file where `path` says even when the name does not survive a round trip through UTF-8', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd, configName: loneSurrogateName});

		conf.set('unicorn', 'rainbow');

		assert.strictEqual(conf.path, path.join(cwd, `${loneSurrogateName}.json`), 'the path names the file the options ask for');
		assert.ok(fs.existsSync(conf.path), 'the file the path names is there');
		assert.deepStrictEqual(fs.readdirSync(cwd), [nameOnDisk], 'the file is the one the name stands for on the file system');
		assert.deepStrictEqual(
			readConfigFile(conf.path),
			{unicorn: 'rainbow'},
			'the file holds what was written',
		);
		assert.strictEqual(conf.get('unicorn'), 'rainbow', 'the store reads it back');
	});
});

describe('a config file name that is legal but awkward', () => {
	// Each of these is a name the file system takes as it is, so the file the options name is the file the store has to write, read, clear and report a change to.
	for (const [description, configName] of [
		['a space in it', 'my config'],
		['an emoji in it', '🦄config'],
		['accented letters in it', 'Ünïcødé'],
		['a leading dot', '.config'],
		['nothing but dots', '...'],
		['a newline in it', 'con\nfig'],
		['a tab in it', 'con\tfig'],
		['a quote in it', 'con"fig'],
		['a backslash in it', String.raw`con\fig`],
		['brackets in it', 'con[fig]'],
		['an uppercase name', 'CONFIG'],
		['leading dashes', '--config'],
		['a directory below `cwd`', 'sub/config'],
	] as Array<[string, string]>) {
		it(`writes the file where \`path\` says with ${description}`, () => {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, unknown>>({cwd, configName});

			conf.set('unicorn', 'rainbow');

			assert.strictEqual(conf.path, path.join(cwd, `${configName}.json`), 'the path names the file the options ask for');
			assert.deepStrictEqual(
				readConfigFile(conf.path),
				{unicorn: 'rainbow'},
				'the file at that path holds what was written',
			);
			assert.strictEqual(conf.get('unicorn'), 'rainbow', 'the store reads it back');
		});

		it(`clears a damaged file with ${description}`, () => {
			const cwd = createTempDirectory();
			const conf = new Conf<Record<string, unknown>>({cwd, configName, clearInvalidConfig: true});
			conf.set('unicorn', 'rainbow');

			// Damaged behind the store's back, so that the read that finds it is the one that has to recognise it.
			fs.writeFileSync(conf.path, 'this is not JSON');

			assert.deepStrictEqual(Object.keys(conf.store), [], 'the damaged file is read as a store holding nothing');
			assert.deepStrictEqual(
				readConfigFile(conf.path),
				{},
				'the file is cleared rather than left damaged',
			);
		});
	}
});

describe('a `cwd` the caller gave', () => {
	it('is created where it is not there yet, as deep as it is named', () => {
		const cwd = path.join(createTempDirectory(), 'no-such-directory', 'deeper');
		const conf = new Conf<Record<string, unknown>>({cwd});

		conf.set('unicorn', 'rainbow');

		assert.strictEqual(conf.path, path.join(cwd, 'config.json'), 'the path is below the directory that was named');
		assert.strictEqual(conf.get('unicorn'), 'rainbow', 'the store reads back what it wrote');
	});

	it('is resolved from a relative path, and a trailing separator names the same directory', () => {
		const base = createTempDirectory();
		const relative = path.relative(process.cwd(), path.join(base, 'a-directory'));
		const conf = new Conf<Record<string, unknown>>({cwd: relative + path.sep});

		conf.set('unicorn', 'rainbow');

		assert.strictEqual(conf.path, path.join(base, 'a-directory', 'config.json'), 'the path is resolved out of the working directory');
		assert.strictEqual(conf.get('unicorn'), 'rainbow', 'the store reads back what it wrote');
	});

	it('is followed where it is a symlink to a directory, however many links deep', () => {
		const base = createResolvedTempDirectory();
		const target = path.join(base, 'target');
		fs.mkdirSync(target);
		fs.symlinkSync(target, path.join(base, 'link-to-target'));
		fs.symlinkSync(path.join(base, 'link-to-target'), path.join(base, 'link-to-link'));

		const conf = new Conf<Record<string, unknown>>({cwd: path.join(base, 'link-to-link')});

		conf.set('unicorn', 'rainbow');

		assert.strictEqual(conf.path, path.join(base, 'link-to-link', 'config.json'), 'the path is the one the caller named');
		assert.deepStrictEqual(fs.readdirSync(target), ['config.json'], 'the file is the one the links lead to');
		assert.strictEqual(conf.get('unicorn'), 'rainbow', 'the store reads back what it wrote');
	});

	it('is made again where it is deleted between two operations on the same store', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, unknown>>({cwd});
		conf.set('first', 1);

		fs.rmSync(cwd, {recursive: true, force: true});
		conf.set('second', 2);

		assert.deepStrictEqual(
			readConfigFile(conf.path),
			{second: 2},
			'the store is written where `path` says, in a directory made again',
		);
	});
});

describe('a name that would leave `cwd`', () => {
	// The two options together are refused before any file or directory is touched, so nothing is written outside the directory the caller named.
	for (const [description, options] of [
		['a `configName` that walks up', {configName: '../evil'}],
		['a `configName` that walks up twice', {configName: '../../evil'}],
		['a nested `configName` that walks up out of it', {configName: 'sub/../../evil'}],
		['an absolute `configName`', {configName: '/tmp/evil'}],
		['a leading slash in the `configName`', {configName: '/evil'}],
		['a `fileExtension` that walks up', {fileExtension: '/../../evil'}],
		['no name at all', {configName: '', fileExtension: ''}],
		['a `configName` that names the directory above it', {configName: '..', fileExtension: ''}],
	] as Array<[string, Record<string, string>]>) {
		it(`is refused with ${description}`, () => {
			const cwd = createTempDirectory();

			assert.throws(
				() => new Conf({cwd, ...options}),
				{message: /must name a file inside `cwd`/},
			);

			assert.deepStrictEqual(fs.readdirSync(cwd), [], 'nothing was written or made outside the directory');
		});
	}
});

describe('a `projectName` the config directory cannot hold', () => {
	// `env-paths` refuses a name that would reach out of the directory it chose, before any file or directory is touched.
	for (const [description, options] of [
		['a path separator in it', {projectName: 'a/b'}],
		['a walk up in it', {projectName: '../escape'}],
		['nothing but a space in it', {projectName: ' '}],
		['a path separator in the `projectSuffix`', {projectName: 'fine', projectSuffix: 'a/b'}],
	] as Array<[string, Record<string, string>]>) {
		it(`is refused with ${description}`, () => {
			assert.throws(() => new Conf(options), {message: /Unsafe filename/});
		});
	}

	it('takes the suffix off the directory when `projectSuffix` is an empty string', () => {
		// The directory is the one in the user's own config directory rather than a temporary one, so it is taken away again.
		const projectName = nextProjectName();
		removeConfigDirectoryAfterwards(projectName, '');
		const conf = new Conf({projectName, projectSuffix: ''});

		assert.strictEqual(path.basename(path.dirname(conf.path)), projectName, 'the directory carries the project name and no suffix');
	});
});

describe('options that name the config file', () => {
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
		const projectName = nextProjectName();
		removeConfigDirectoryAfterwards(projectName);
		const conf = new Conf({projectName});
		assert.ok(conf.path.includes('-nodejs'));
		conf.clear();
	});

	// The default config directory is the one `env-paths` gives the project name, with the suffix the `projectSuffix` option defaults to.
	it('puts the config file in the config directory `env-paths` gives the project name, with a `-nodejs` suffix', () => {
		const projectName = nextProjectName();
		removeConfigDirectoryAfterwards(projectName);
		const conf = new Conf({projectName});
		assert.strictEqual(conf.path, path.join(envPaths(projectName, {suffix: 'nodejs'}).config, 'config.json'));
	});

	it('with `suffix` option set to empty string', () => {
		const projectSuffix = '';
		const projectName = nextProjectName();
		removeConfigDirectoryAfterwards(projectName, projectSuffix);
		const conf = new Conf({projectSuffix, projectName});
		const configPathSegments = conf.path.split(path.sep);
		const configRootIndex = configPathSegments.indexOf(projectName);
		assert.ok(configRootIndex !== -1 && configRootIndex < configPathSegments.length);
	});

	it('with `projectSuffix` option set to non-empty string', () => {
		const projectSuffix = 'new-projectSuffix';
		const projectName = nextProjectName();
		removeConfigDirectoryAfterwards(projectName, projectSuffix);
		const conf = new Conf({projectSuffix, projectName});
		const configPathSegments = conf.path.split(path.sep);
		const expectedRootName = `${projectName}-${projectSuffix}`;
		const configRootIndex = configPathSegments.indexOf(expectedRootName);
		assert.ok(configRootIndex !== -1 && configRootIndex < configPathSegments.length);
	});

	it('`projectName` option', () => {
		const projectName = nextProjectName();
		removeConfigDirectoryAfterwards(projectName);
		const conf = new Conf({projectName});
		assert.strictEqual(conf.get('foo'), undefined);
		conf.set('foo', fixture);
		assert.strictEqual(conf.get('foo'), fixture);
		assert.ok(conf.path.includes(projectName));
		fs.rmSync(conf.path, {force: true});
	});

	it('`cwd` option overrides `projectName` option', () => {
		const cwd = createTempDirectory();
		const projectName = nextProjectName();
		const projectConfigDirectory = envPaths(projectName, {suffix: 'nodejs'}).config;

		const conf: Conf = new Conf({cwd, projectName});
		assert.strictEqual(conf.path, path.join(cwd, 'config.json'));
		assert.strictEqual(conf.get('foo'), undefined);
		conf.set('foo', fixture);
		assert.strictEqual(conf.get('foo'), fixture);
		assert.deepStrictEqual(readConfigFile(conf), {foo: fixture});
		// Nothing is made where the project name would have put the file. The project name is one no other run uses, so nothing is there before either.
		assert.strictEqual(fs.existsSync(projectConfigDirectory), false);

		// A `projectName` that is empty is not refused either, since `cwd` says where the file goes.
		assert.strictEqual(new Conf({cwd, projectName: ''}).path, path.join(cwd, 'config.json'));
	});

	it('handles a custom extension with leading dots and a custom name', () => {
		const cwd = createTempDirectory();
		const conf = new Conf({cwd, configName: 'prefs', fileExtension: '..toml'});
		assert.strictEqual(path.basename(conf.path), 'prefs.toml');
		conf.set('a', 1);
		assert.ok(fs.existsSync(path.join(cwd, 'prefs.toml')));
	});
});
