import fs from 'fs';
import path from 'path';
import {serial as test} from 'ava';
import tempy from 'tempy';
import del from 'del';
import pkgUp from 'pkg-up';
import clearModule from 'clear-module';
import pEvent from 'p-event';
import delay from 'delay';
import Conf from '.';

const fixture = '🦄';

test.beforeEach(t => {
	t.context.config = new Conf({cwd: tempy.directory()});
	t.context.configWithoutDotNotation = new Conf({cwd: tempy.directory(), accessPropertiesByDotNotation: false});
});

test('.get()', t => {
	t.is(t.context.config.get('foo'), undefined);
	t.is(t.context.config.get('foo', '🐴'), '🐴');
	t.context.config.set('foo', fixture);
	t.is(t.context.config.get('foo'), fixture);
});

test('.set()', t => {
	t.context.config.set('foo', fixture);
	t.context.config.set('baz.boo', fixture);
	t.is(t.context.config.get('foo'), fixture);
	t.is(t.context.config.get('baz.boo'), fixture);
});

test('.set() - with object', t => {
	t.context.config.set({
		foo1: 'bar1',
		foo2: 'bar2',
		baz: {
			boo: 'foo',
			foo: {
				bar: 'baz'
			}
		}
	});
	t.is(t.context.config.get('foo1'), 'bar1');
	t.is(t.context.config.get('foo2'), 'bar2');
	t.deepEqual(t.context.config.get('baz'), {boo: 'foo', foo: {bar: 'baz'}});
	t.is(t.context.config.get('baz.boo'), 'foo');
	t.deepEqual(t.context.config.get('baz.foo'), {bar: 'baz'});
	t.is(t.context.config.get('baz.foo.bar'), 'baz');
});

test('.set() - with undefined', t => {
	t.throws(() => {
		t.context.config.set('foo', undefined);
	}, 'Use `delete()` to clear values');
});

test('.set() - with unsupported values', t => {
	t.throws(() => {
		t.context.config.set('a', () => {});
	}, /not supported by JSON/);

	t.throws(() => {
		t.context.config.set('a', Symbol('a'));
	}, /not supported by JSON/);

	t.throws(() => {
		t.context.config.set({
			a: undefined
		});
	}, /not supported by JSON/);

	t.throws(() => {
		t.context.config.set({
			a: () => {}
		});
	}, /not supported by JSON/);

	t.throws(() => {
		t.context.config.set({
			a: Symbol('a')
		});
	}, /not supported by JSON/);
});

test('.set() - invalid key', t => {
	t.throws(() => {
		t.context.config.set(1, 'unicorn');
	}, 'Expected `key` to be of type `string` or `object`, got number');
});

test('.has()', t => {
	t.context.config.set('foo', fixture);
	t.context.config.set('baz.boo', fixture);
	t.true(t.context.config.has('foo'));
	t.true(t.context.config.has('baz.boo'));
	t.false(t.context.config.has('missing'));
});

test('.delete()', t => {
	const {config} = t.context;
	config.set('foo', 'bar');
	config.set('baz.boo', true);
	config.set('baz.foo.bar', 'baz');
	config.delete('foo');
	t.is(config.get('foo'), undefined);
	config.delete('baz.boo');
	t.not(config.get('baz.boo'), true);
	config.delete('baz.foo');
	t.not(config.get('baz.foo'), {bar: 'baz'});
	config.set('foo.bar.baz', {awesome: 'icecream'});
	config.set('foo.bar.zoo', {awesome: 'redpanda'});
	config.delete('foo.bar.baz');
	t.is(config.get('foo.bar.zoo.awesome'), 'redpanda');
});

test('.clear()', t => {
	t.context.config.set('foo', 'bar');
	t.context.config.set('foo1', 'bar1');
	t.context.config.set('baz.boo', true);
	t.context.config.clear();
	t.is(t.context.config.size, 0);
});

test('.size', t => {
	t.context.config.set('foo', 'bar');
	t.is(t.context.config.size, 1);
});

test('.store', t => {
	t.context.config.set('foo', 'bar');
	t.context.config.set('baz.boo', true);
	t.deepEqual(t.context.config.store, {
		foo: 'bar',
		baz: {
			boo: true
		}
	});
});

test('`defaults` option', t => {
	const config = new Conf({
		cwd: tempy.directory(),
		defaults: {
			foo: 'bar'
		}
	});

	t.is(config.get('foo'), 'bar');
});

test('`configName` option', t => {
	const configName = 'alt-config';
	const config = new Conf({
		cwd: tempy.directory(),
		configName
	});
	t.is(config.get('foo'), undefined);
	config.set('foo', fixture);
	t.is(config.get('foo'), fixture);
	t.is(path.basename(config.path, '.json'), configName);
});

test('no `suffix` option', t => {
	const config = new Conf();
	t.true(config.path.includes('-nodejs'));
});

test('with `suffix` option set to empty string', t => {
	const projectSuffix = '';
	const projectName = 'conf-temp1-project';
	const config = new Conf({projectSuffix, projectName});
	const configPathSegments = config.path.split(path.sep);
	const configRootIndex = configPathSegments.findIndex(segment => segment === projectName);
	t.true(configRootIndex >= 0 && configRootIndex < configPathSegments.length);
});

test('with `projectSuffix` option set to non-empty string', t => {
	const projectSuffix = 'new-projectSuffix';
	const projectName = 'conf-temp2-project';
	const config = new Conf({projectSuffix, projectName});
	const configPathSegments = config.path.split(path.sep);
	const expectedRootName = `${projectName}-${projectSuffix}`;
	const configRootIndex = configPathSegments.findIndex(segment => segment === expectedRootName);
	t.true(configRootIndex >= 0 && configRootIndex < configPathSegments.length);
});

test('`fileExtension` option', t => {
	const fileExtension = 'alt-ext';
	const config = new Conf({
		cwd: tempy.directory(),
		fileExtension
	});
	t.is(config.get('foo'), undefined);
	config.set('foo', fixture);
	t.is(config.get('foo'), fixture);
	t.is(path.extname(config.path), `.${fileExtension}`);
});

test('`fileExtension` option = empty string', t => {
	const configName = 'unicorn';
	const config = new Conf({
		cwd: tempy.directory(),
		fileExtension: '',
		configName
	});
	t.is(path.basename(config.path), configName);
});

test('`serialize` and `deserialize` options', t => {
	t.plan(4);
	const serialized = `foo:${fixture}`;
	const deserialized = {foo: fixture};
	const serialize = value => {
		t.is(value, deserialized);
		return serialized;
	};

	const deserialize = value => {
		t.is(value, serialized);
		return deserialized;
	};

	const config = new Conf({
		cwd: tempy.directory(),
		serialize,
		deserialize
	});
	t.deepEqual(config.store, {});
	config.store = deserialized;
	t.deepEqual(config.store, deserialized);
});

test('`projectName` option', t => {
	const projectName = 'conf-fixture-project-name';
	const config = new Conf({projectName});
	t.is(config.get('foo'), undefined);
	config.set('foo', fixture);
	t.is(config.get('foo'), fixture);
	t.true(config.path.includes(projectName));
	del.sync(config.path, {force: true});
});

test('ensure `.store` is always an object', t => {
	const cwd = tempy.directory();
	const config = new Conf({cwd});

	del.sync(cwd, {force: true});

	t.notThrows(() => {
		config.get('foo');
	});
});

test('instance is iterable', t => {
	t.context.config.set({
		foo: fixture,
		bar: fixture
	});
	t.deepEqual(
		[...t.context.config],
		[['foo', fixture], ['bar', fixture]]
	);
});

test('automatic `projectName` inference', t => {
	const config = new Conf();
	config.set('foo', fixture);
	t.is(config.get('foo'), fixture);
	t.true(config.path.includes('conf'));
	del.sync(config.path, {force: true});
});

test('`cwd` option overrides `projectName` option', t => {
	const cwd = tempy.directory();

	let config;
	t.notThrows(() => {
		config = new Conf({cwd, projectName: ''});
	});

	t.true(config.path.startsWith(cwd));
	t.is(config.get('foo'), undefined);
	config.set('foo', fixture);
	t.is(config.get('foo'), fixture);
	del.sync(config.path, {force: true});
});

test('safely handle missing package.json', t => {
	const pkgUpSyncOrig = pkgUp.sync;
	pkgUp.sync = () => null;

	let config;
	t.notThrows(() => {
		config = new Conf({projectName: 'conf-fixture-project-name'});
	});

	del.sync(config.path, {force: true});
	pkgUp.sync = pkgUpSyncOrig;
});

test('handle `cwd` being set and `projectName` not being set', t => {
	const pkgUpSyncOrig = pkgUp.sync;
	pkgUp.sync = () => null;

	let config;
	t.notThrows(() => {
		config = new Conf({cwd: 'conf-fixture-cwd'});
	});

	del.sync(path.dirname(config.path));
	pkgUp.sync = pkgUpSyncOrig;
});

// See #11
test('fallback to cwd if `module.filename` is `null`', t => {
	const preservedFilename = module.filename;
	module.filename = null;
	clearModule('.');

	let config;
	t.notThrows(() => {
		const Conf = require('.');
		config = new Conf({cwd: 'conf-fixture-fallback-module-filename-null'});
	});

	module.filename = preservedFilename;
	del.sync(path.dirname(config.path));
});

test('encryption', t => {
	const config = new Conf({cwd: tempy.directory(), encryptionKey: 'abc123'});
	t.is(config.get('foo'), undefined);
	t.is(config.get('foo', '🐴'), '🐴');
	config.set('foo', fixture);
	config.set('baz.boo', fixture);
	t.is(config.get('foo'), fixture);
	t.is(config.get('baz.boo'), fixture);
});

test('encryption - upgrade', t => {
	const cwd = tempy.directory();

	const before = new Conf({cwd});
	before.set('foo', fixture);
	t.is(before.get('foo'), fixture);

	const after = new Conf({cwd, encryptionKey: 'abc123'});
	t.is(after.get('foo'), fixture);
});

test('encryption - corrupt file', t => {
	const cwd = tempy.directory();

	const before = new Conf({cwd, encryptionKey: 'abc123'});
	before.set('foo', fixture);
	t.is(before.get('foo'), fixture);

	fs.appendFileSync(path.join(cwd, 'config.json'), 'corrupt file');

	const after = new Conf({cwd, encryptionKey: 'abc123'});
	t.is(after.get('foo'), undefined);
});

test('decryption - migration to initialization vector', t => {
	// The `test/config-encrypted-with-conf-4-1-0.json` file contains `{"unicorn": "🦄"}` JSON data which is encrypted with conf@4.1.0 and password `abcd1234`
	const config = new Conf({
		cwd: 'test',
		encryptionKey: 'abcd1234',
		configName: 'config-encrypted-with-conf-4-1-0'
	});

	t.deepEqual(config.store, {unicorn: '🦄'});
});

test('onDidChange()', t => {
	const {config} = t.context;

	t.plan(8);

	const checkFoo = (newValue, oldValue) => {
		t.is(newValue, '🐴');
		t.is(oldValue, fixture);
	};

	const checkBaz = (newValue, oldValue) => {
		t.is(newValue, '🐴');
		t.is(oldValue, fixture);
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

	const checkUndefined = (newValue, oldValue) => {
		t.is(oldValue, fixture);
		t.is(newValue, undefined);
	};

	const checkSet = (newValue, oldValue) => {
		t.is(oldValue, undefined);
		t.is(newValue, '🐴');
	};

	unsubscribe = config.onDidChange('foo', checkUndefined);
	config.delete('foo');
	unsubscribe();
	unsubscribe = config.onDidChange('foo', checkSet);
	config.set('foo', '🐴');
	unsubscribe();
	config.set('foo', fixture);
});

test('onDidAnyChange()', t => {
	const {config} = t.context;

	t.plan(8);

	const checkFoo = (newValue, oldValue) => {
		t.deepEqual(newValue, {foo: '🐴'});
		t.deepEqual(oldValue, {foo: fixture});
	};

	const checkBaz = (newValue, oldValue) => {
		t.deepEqual(newValue, {
			foo: fixture,
			baz: {boo: '🐴'}
		});
		t.deepEqual(oldValue, {
			foo: fixture,
			baz: {boo: fixture}
		});
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

	const checkUndefined = (newValue, oldValue) => {
		t.deepEqual(oldValue, {
			foo: '🦄',
			baz: {boo: '🦄'}
		});

		t.deepEqual(newValue, {
			baz: {boo: fixture}
		});
	};

	const checkSet = (newValue, oldValue) => {
		t.deepEqual(oldValue, {
			baz: {boo: fixture}
		});

		t.deepEqual(newValue, {
			baz: {boo: '🦄'},
			foo: '🐴'
		});
	};

	unsubscribe = config.onDidAnyChange(checkUndefined);
	config.delete('foo');
	unsubscribe();
	unsubscribe = config.onDidAnyChange(checkSet);
	config.set('foo', '🐴');
	unsubscribe();
	config.set('foo', fixture);
});

// See #32
test('doesn\'t write to disk upon instanciation if and only if the store didn\'t change', t => {
	let exists = fs.existsSync(t.context.config.path);
	t.is(exists, false);

	const conf = new Conf({
		cwd: tempy.directory(),
		defaults: {
			foo: 'bar'
		}
	});
	exists = fs.existsSync(conf.path);
	t.is(exists, true);
});

test('`clearInvalidConfig` option - invalid data', t => {
	const config = new Conf({cwd: tempy.directory(), clearInvalidConfig: false});
	fs.writeFileSync(config.path, '🦄');

	t.throws(() => {
		config.store; // eslint-disable-line no-unused-expressions
	}, {instanceOf: SyntaxError});
});

test('`clearInvalidConfig` option - valid data', t => {
	const config = new Conf({cwd: tempy.directory(), clearInvalidConfig: false});
	config.set('foo', 'bar');
	t.deepEqual(config.store, {foo: 'bar'});
});

test('schema - should be an object', t => {
	const schema = 'object';
	t.throws(() => {
		new Conf({cwd: tempy.directory(), schema}); // eslint-disable-line no-new
	}, 'The `schema` option must be an object.');
});

test('schema - valid set', t => {
	const schema = {
		foo: {
			type: 'object',
			properties: {
				bar: {
					type: 'number'
				},
				foobar: {
					type: 'number',
					maximum: 100
				}
			}
		}
	};
	const config = new Conf({cwd: tempy.directory(), schema});
	t.notThrows(() => {
		config.set('foo', {bar: 1, foobar: 2});
	});
});

test('schema - one violation', t => {
	const schema = {
		foo: {
			type: 'string'
		}
	};
	const config = new Conf({cwd: tempy.directory(), schema});
	t.throws(() => {
		config.set('foo', 1);
	}, 'Config schema violation: `foo` should be string');
});

test('schema - multiple violations', t => {
	const schema = {
		foo: {
			type: 'object',
			properties: {
				bar: {
					type: 'number'
				},
				foobar: {
					type: 'number',
					maximum: 100
				}
			}
		}
	};
	const config = new Conf({cwd: tempy.directory(), schema});
	t.throws(() => {
		config.set('foo', {bar: '1', foobar: 101});
	}, 'Config schema violation: `foo.bar` should be number; `foo.foobar` should be <= 100');
});

test('schema - complex schema', t => {
	const schema = {
		foo: {
			type: 'string',
			maxLength: 3,
			pattern: '[def]+'
		},
		bar: {
			type: 'array',
			uniqueItems: true,
			maxItems: 3,
			items: {
				type: 'integer'
			}
		}
	};
	const config = new Conf({cwd: tempy.directory(), schema});
	t.throws(() => {
		config.set('foo', 'abca');
	}, 'Config schema violation: `foo` should NOT be longer than 3 characters; `foo` should match pattern "[def]+"');
	t.throws(() => {
		config.set('bar', [1, 1, 2, 'a']);
	}, 'Config schema violation: `bar` should NOT have more than 3 items; `bar[3]` should be integer; `bar` should NOT have duplicate items (items ## 1 and 0 are identical)');
});

test('schema - invalid write to config file', t => {
	const schema = {
		foo: {
			type: 'string'
		}
	};
	const cwd = tempy.directory();

	const config = new Conf({cwd, schema});
	fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({foo: 1}));
	t.throws(() => {
		config.get('foo');
	}, 'Config schema violation: `foo` should be string');
});

test('schema - default', t => {
	const schema = {
		foo: {
			type: 'string',
			default: 'bar'
		}
	};
	const config = new Conf({
		cwd: tempy.directory(),
		schema
	});
	t.is(config.get('foo'), 'bar');
});

test('schema - Conf defaults overwrites schema default', t => {
	const schema = {
		foo: {
			type: 'string',
			default: 'bar'
		}
	};
	const config = new Conf({
		cwd: tempy.directory(),
		defaults: {
			foo: 'foo'
		},
		schema
	});
	t.is(config.get('foo'), 'foo');
});

test('schema - validate Conf default', t => {
	const schema = {
		foo: {
			type: 'string'
		}
	};
	t.throws(() => {
		new Conf({ // eslint-disable-line no-new
			cwd: tempy.directory(),
			defaults: {
				foo: 1
			},
			schema
		});
	}, 'Config schema violation: `foo` should be string');
});

test('.get() - without dot notation', t => {
	t.is(t.context.configWithoutDotNotation.get('foo'), undefined);
	t.is(t.context.configWithoutDotNotation.get('foo', '🐴'), '🐴');
	t.context.configWithoutDotNotation.set('foo', fixture);
	t.is(t.context.configWithoutDotNotation.get('foo'), fixture);
});

test('.set() - without dot notation', t => {
	t.context.configWithoutDotNotation.set('foo', fixture);
	t.context.configWithoutDotNotation.set('baz.boo', fixture);
	t.is(t.context.configWithoutDotNotation.get('foo'), fixture);
	t.is(t.context.configWithoutDotNotation.get('baz.boo'), fixture);
});

test('.set() - with object - without dot notation', t => {
	t.context.configWithoutDotNotation.set({
		foo1: 'bar1',
		foo2: 'bar2',
		baz: {
			boo: 'foo',
			foo: {
				bar: 'baz'
			}
		}
	});
	t.is(t.context.configWithoutDotNotation.get('foo1'), 'bar1');
	t.is(t.context.configWithoutDotNotation.get('foo2'), 'bar2');
	t.deepEqual(t.context.configWithoutDotNotation.get('baz'), {boo: 'foo', foo: {bar: 'baz'}});
	t.is(t.context.configWithoutDotNotation.get('baz.boo'), undefined);
	t.is(t.context.configWithoutDotNotation.get('baz.foo.bar'), undefined);
});

test('.has() - without dot notation', t => {
	t.context.configWithoutDotNotation.set('foo', fixture);
	t.context.configWithoutDotNotation.set('baz.boo', fixture);
	t.true(t.context.configWithoutDotNotation.has('foo'));
	t.true(t.context.configWithoutDotNotation.has('baz.boo'));
	t.false(t.context.configWithoutDotNotation.has('missing'));
});

test('.delete() - without dot notation', t => {
	const {configWithoutDotNotation} = t.context;
	configWithoutDotNotation.set('foo', 'bar');
	configWithoutDotNotation.set('baz.boo', true);
	configWithoutDotNotation.set('baz.foo.bar', 'baz');
	configWithoutDotNotation.delete('foo');
	t.is(configWithoutDotNotation.get('foo'), undefined);
	configWithoutDotNotation.delete('baz.boo');
	t.not(configWithoutDotNotation.get('baz.boo'), true);
	configWithoutDotNotation.delete('baz.foo');
	t.not(configWithoutDotNotation.get('baz.foo'), {bar: 'baz'});
	configWithoutDotNotation.set('foo.bar.baz', {awesome: 'icecream'});
	configWithoutDotNotation.set('foo.bar.zoo', {awesome: 'redpanda'});
	configWithoutDotNotation.delete('foo.bar.baz');
	t.deepEqual(configWithoutDotNotation.get('foo.bar.zoo'), {awesome: 'redpanda'});
});

test('`watch` option watches for config file changes by another process', async t => {
	if (process.platform === 'darwin' && process.version.split('.')[0] === 'v8') {
		t.plan(0);
		return;
	}

	const cwd = tempy.directory();
	const conf1 = new Conf({cwd, watch: true});
	const conf2 = new Conf({cwd});
	conf1.set('foo', '👾');

	t.plan(4);

	const checkFoo = (newValue, oldValue) => {
		t.is(newValue, '🐴');
		t.is(oldValue, '👾');
	};

	t.is(conf2.get('foo'), '👾');
	t.is(conf1.path, conf2.path);
	conf1.onDidChange('foo', checkFoo);

	(async () => {
		await delay(50);
		conf2.set('foo', '🐴');
	})();

	await pEvent(conf1.events, 'change');
});

test('`watch` option watches for config file changes by file write', async t => {
	// TODO: Remove this when targeting Node.js 10.
	if (process.platform === 'darwin' && process.version.split('.')[0] === 'v8') {
		t.plan(0);
		return;
	}

	const cwd = tempy.directory();
	const conf = new Conf({cwd, watch: true});
	conf.set('foo', '🐴');

	t.plan(2);

	const checkFoo = (newValue, oldValue) => {
		t.is(newValue, '🦄');
		t.is(oldValue, '🐴');
	};

	conf.onDidChange('foo', checkFoo);

	(async () => {
		await delay(50);
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({foo: '🦄'}));
	})();

	await pEvent(conf.events, 'change');
});
