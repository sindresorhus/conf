import fs from 'fs';
import path from 'path';
import {serial as test} from 'ava';
import tempy from 'tempy';
import del from 'del';
import pkgUp from 'pkg-up';
import clearModule from 'clear-module';
import Conf from '.';

const fixture = '🦄';

test.beforeEach(t => {
	t.context.conf = new Conf({cwd: tempy.directory()});
});

test('.get()', t => {
	t.is(t.context.conf.get('foo'), undefined);
	t.is(t.context.conf.get('foo', '🐴'), '🐴');
	t.context.conf.set('foo', fixture);
	t.is(t.context.conf.get('foo'), fixture);
});

test('.set()', t => {
	t.context.conf.set('foo', fixture);
	t.context.conf.set('baz.boo', fixture);
	t.is(t.context.conf.get('foo'), fixture);
	t.is(t.context.conf.get('baz.boo'), fixture);
});

test('.set() - with object', t => {
	t.context.conf.set({
		foo1: 'bar1',
		foo2: 'bar2',
		baz: {
			boo: 'foo',
			foo: {
				bar: 'baz'
			}
		}
	});
	t.is(t.context.conf.get('foo1'), 'bar1');
	t.is(t.context.conf.get('foo2'), 'bar2');
	t.deepEqual(t.context.conf.get('baz'), {boo: 'foo', foo: {bar: 'baz'}});
	t.is(t.context.conf.get('baz.boo'), 'foo');
	t.deepEqual(t.context.conf.get('baz.foo'), {bar: 'baz'});
	t.is(t.context.conf.get('baz.foo.bar'), 'baz');
});

test('.set() - with undefined', t => {
	t.throws(() => {
		t.context.conf.set('foo', undefined);
	}, 'Use `delete()` to clear values');
});

test('.set() - with unsupported values', t => {
	t.throws(() => {
		t.context.conf.set('a', () => {});
	}, /not supported by JSON/);

	t.throws(() => {
		t.context.conf.set('a', Symbol('a'));
	}, /not supported by JSON/);

	t.throws(() => {
		t.context.conf.set({
			a: undefined
		});
	}, /not supported by JSON/);

	t.throws(() => {
		t.context.conf.set({
			a: () => {}
		});
	}, /not supported by JSON/);

	t.throws(() => {
		t.context.conf.set({
			a: Symbol('a')
		});
	}, /not supported by JSON/);
});

test('.set() - invalid key', t => {
	t.throws(() => {
		t.context.conf.set(1, 'unicorn');
	}, 'Expected `key` to be of type `string` or `object`, got number');
});

test('.has()', t => {
	t.context.conf.set('foo', fixture);
	t.context.conf.set('baz.boo', fixture);
	t.true(t.context.conf.has('foo'));
	t.true(t.context.conf.has('baz.boo'));
	t.false(t.context.conf.has('missing'));
});

test('.delete()', t => {
	const {conf} = t.context;
	conf.set('foo', 'bar');
	conf.set('baz.boo', true);
	conf.set('baz.foo.bar', 'baz');
	conf.delete('foo');
	t.is(conf.get('foo'), undefined);
	conf.delete('baz.boo');
	t.not(conf.get('baz.boo'), true);
	conf.delete('baz.foo');
	t.not(conf.get('baz.foo'), {bar: 'baz'});
	conf.set('foo.bar.baz', {awesome: 'icecream'});
	conf.set('foo.bar.zoo', {awesome: 'redpanda'});
	conf.delete('foo.bar.baz');
	t.is(conf.get('foo.bar.zoo.awesome'), 'redpanda');
});

test('.clear()', t => {
	t.context.conf.set('foo', 'bar');
	t.context.conf.set('foo1', 'bar1');
	t.context.conf.set('baz.boo', true);
	t.context.conf.clear();
	t.is(t.context.conf.size, 0);
});

test('.size', t => {
	t.context.conf.set('foo', 'bar');
	t.is(t.context.conf.size, 1);
});

test('.store', t => {
	t.context.conf.set('foo', 'bar');
	t.context.conf.set('baz.boo', true);
	t.deepEqual(t.context.conf.store, {
		foo: 'bar',
		baz: {
			boo: true
		}
	});
});

test('`defaults` option', t => {
	const conf = new Conf({
		cwd: tempy.directory(),
		defaults: {
			foo: 'bar'
		}
	});

	t.is(conf.get('foo'), 'bar');
});

test('`configName` option', t => {
	const configName = 'alt-config';
	const conf = new Conf({
		cwd: tempy.directory(),
		configName
	});
	t.is(conf.get('foo'), undefined);
	conf.set('foo', fixture);
	t.is(conf.get('foo'), fixture);
	t.is(path.basename(conf.path, '.json'), configName);
});

test('no `suffix` option', t => {
	const conf = new Conf();
	t.true(conf.path.includes('-nodejs'));
});

test('with `suffix` option set to empty string', t => {
	const projectSuffix = '';
	const projectName = 'conf-temp1-project';
	const conf = new Conf({projectSuffix, projectName});
	const configPathSegments = conf.path.split(path.sep);
	const configRootIndex = configPathSegments.findIndex(segment => segment === projectName);
	t.true(configRootIndex >= 0 && configRootIndex < configPathSegments.length);
});

test('with `projectSuffix` option set to non-empty string', t => {
	const projectSuffix = 'new-projectSuffix';
	const projectName = 'conf-temp2-project';
	const conf = new Conf({projectSuffix, projectName});
	const configPathSegments = conf.path.split(path.sep);
	const expectedRootName = `${projectName}-${projectSuffix}`;
	const configRootIndex = configPathSegments.findIndex(segment => segment === expectedRootName);
	t.true(configRootIndex >= 0 && configRootIndex < configPathSegments.length);
});

test('`fileExtension` option', t => {
	const fileExtension = 'alt-ext';
	const conf = new Conf({
		cwd: tempy.directory(),
		fileExtension
	});
	t.is(conf.get('foo'), undefined);
	conf.set('foo', fixture);
	t.is(conf.get('foo'), fixture);
	t.is(path.extname(conf.path), `.${fileExtension}`);
});

test('`fileExtension` option = empty string', t => {
	const configName = 'unicorn';
	const conf = new Conf({
		cwd: tempy.directory(),
		fileExtension: '',
		configName
	});
	t.is(path.basename(conf.path), configName);
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

	const conf = new Conf({
		cwd: tempy.directory(),
		serialize,
		deserialize
	});
	t.deepEqual(conf.store, {});
	conf.store = deserialized;
	t.deepEqual(conf.store, deserialized);
});

test('`projectName` option', t => {
	const projectName = 'conf-fixture-project-name';
	const conf = new Conf({projectName});
	t.is(conf.get('foo'), undefined);
	conf.set('foo', fixture);
	t.is(conf.get('foo'), fixture);
	t.true(conf.path.includes(projectName));
	del.sync(conf.path, {force: true});
});

test('ensure `.store` is always an object', t => {
	const cwd = tempy.directory();
	const conf = new Conf({cwd});

	del.sync(cwd, {force: true});

	t.notThrows(() => {
		conf.get('foo');
	});
});

test('instance is iterable', t => {
	t.context.conf.set({
		foo: fixture,
		bar: fixture
	});
	t.deepEqual(
		[...t.context.conf],
		[['foo', fixture], ['bar', fixture]]
	);
});

test('automatic `projectName` inference', t => {
	const conf = new Conf();
	conf.set('foo', fixture);
	t.is(conf.get('foo'), fixture);
	t.true(conf.path.includes('conf'));
	del.sync(conf.path, {force: true});
});

test('`cwd` option overrides `projectName` option', t => {
	const cwd = tempy.directory();

	let conf;
	t.notThrows(() => {
		conf = new Conf({cwd, projectName: ''});
	});

	t.true(conf.path.startsWith(cwd));
	t.is(conf.get('foo'), undefined);
	conf.set('foo', fixture);
	t.is(conf.get('foo'), fixture);
	del.sync(conf.path, {force: true});
});

test('safely handle missing package.json', t => {
	const pkgUpSyncOrig = pkgUp.sync;
	pkgUp.sync = () => null;

	let conf;
	t.notThrows(() => {
		conf = new Conf({projectName: 'conf-fixture-project-name'});
	});

	del.sync(conf.path, {force: true});
	pkgUp.sync = pkgUpSyncOrig;
});

test('handle `cwd` being set and `projectName` not being set', t => {
	const pkgUpSyncOrig = pkgUp.sync;
	pkgUp.sync = () => null;

	let conf;
	t.notThrows(() => {
		conf = new Conf({cwd: 'conf-fixture-cwd'});
	});

	del.sync(path.dirname(conf.path));
	pkgUp.sync = pkgUpSyncOrig;
});

// See #11
test('fallback to cwd if `module.filename` is `null`', t => {
	const preservedFilename = module.filename;
	module.filename = null;
	clearModule('.');

	let conf;
	t.notThrows(() => {
		const Conf = require('.');
		conf = new Conf({cwd: 'conf-fixture-fallback-module-filename-null'});
	});

	module.filename = preservedFilename;
	del.sync(path.dirname(conf.path));
});

test('encryption', t => {
	const conf = new Conf({cwd: tempy.directory(), encryptionKey: 'abc123'});
	t.is(conf.get('foo'), undefined);
	t.is(conf.get('foo', '🐴'), '🐴');
	conf.set('foo', fixture);
	conf.set('baz.boo', fixture);
	t.is(conf.get('foo'), fixture);
	t.is(conf.get('baz.boo'), fixture);
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

test('onDidChange()', t => {
	const {conf} = t.context;

	t.plan(8);

	const checkFoo = (newValue, oldValue) => {
		t.is(newValue, '🐴');
		t.is(oldValue, fixture);
	};

	const checkBaz = (newValue, oldValue) => {
		t.is(newValue, '🐴');
		t.is(oldValue, fixture);
	};

	conf.set('foo', fixture);
	let unsubscribe = conf.onDidChange('foo', checkFoo);
	conf.set('foo', '🐴');
	unsubscribe();
	conf.set('foo', fixture);

	conf.set('baz.boo', fixture);
	unsubscribe = conf.onDidChange('baz.boo', checkBaz);
	conf.set('baz.boo', '🐴');
	unsubscribe();
	conf.set('baz.boo', fixture);

	const checkUndefined = (newValue, oldValue) => {
		t.is(oldValue, fixture);
		t.is(newValue, undefined);
	};

	const checkSet = (newValue, oldValue) => {
		t.is(oldValue, undefined);
		t.is(newValue, '🐴');
	};

	unsubscribe = conf.onDidChange('foo', checkUndefined);
	conf.delete('foo');
	unsubscribe();
	unsubscribe = conf.onDidChange('foo', checkSet);
	conf.set('foo', '🐴');
	unsubscribe();
	conf.set('foo', fixture);
});

// See #32
test('doesn\'t write to disk upon instanciation if and only if the store didn\'t change', t => {
	let exists = fs.existsSync(t.context.conf.path);
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
	const conf = new Conf({cwd: tempy.directory(), clearInvalidConfig: false});
	fs.writeFileSync(conf.path, '🦄');

	t.throws(() => {
		conf.store; // eslint-disable-line no-unused-expressions
	}, {instanceOf: SyntaxError});
});

test('`clearInvalidConfig` option - valid data', t => {
	const conf = new Conf({cwd: tempy.directory(), clearInvalidConfig: false});
	conf.set('foo', 'bar');
	t.deepEqual(conf.store, {foo: 'bar'});
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
	const conf = new Conf({cwd: tempy.directory(), schema});
	t.notThrows(() => {
		conf.set('foo', {bar: 1, foobar: 2});
	});
});

test('schema - one violation', t => {
	const schema = {
		foo: {
			type: 'string'
		}
	};
	const conf = new Conf({cwd: tempy.directory(), schema});
	t.throws(() => {
		conf.set('foo', 1);
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
	const conf = new Conf({cwd: tempy.directory(), schema});
	t.throws(() => {
		conf.set('foo', {bar: '1', foobar: 101});
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
	const conf = new Conf({cwd: tempy.directory(), schema});
	t.throws(() => {
		conf.set('foo', 'abca');
	}, 'Config schema violation: `foo` should NOT be longer than 3 characters; `foo` should match pattern "[def]+"');
	t.throws(() => {
		conf.set('bar', [1, 1, 2, 'a']);
	}, 'Config schema violation: `bar` should NOT have more than 3 items; `bar[3]` should be integer; `bar` should NOT have duplicate items (items ## 1 and 0 are identical)');
});

test('schema - invalid write to config file', t => {
	const schema = {
		foo: {
			type: 'string'
		}
	};
	const cwd = tempy.directory();

	const conf = new Conf({cwd, schema});
	fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({foo: 1}));
	t.throws(() => {
		conf.get('foo');
	}, 'Config schema violation: `foo` should be string');
});

test('schema - default', t => {
	const schema = {
		foo: {
			type: 'string',
			default: 'bar'
		}
	};
	const conf = new Conf({
		cwd: tempy.directory(),
		schema
	});
	t.is(conf.get('foo'), 'bar');
});

test('schema - Conf defaults overwrites schema default', t => {
	const schema = {
		foo: {
			type: 'string',
			default: 'bar'
		}
	};
	const conf = new Conf({
		cwd: tempy.directory(),
		defaults: {
			foo: 'foo'
		},
		schema
	});
	t.is(conf.get('foo'), 'foo');
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

test('migrates to the next version', t => {
	const cwd = tempy.directory();
	const conf1 = new Conf({cwd});

	conf1.clear();
	conf1.set('__packageVersion__', '0.0.4');
	conf1.set('old', 'old');

	const conf2 = new Conf({
		cwd,
		migrations: {
			'0.0.3': store => {
				store.set('03', 1);
			},
			'1.0.1': store => {
				const old = store.get('old');
				store.set('new', old);
				store.delete('old');
			},
			'1.9.9': store => {
				store.set('2', 1);
			},
			'20.0.0': store => {
				store.set('4', 1);
			}
		}
	});

	t.is(conf2.get('old'), undefined);
	t.is(conf2.get('03'), undefined);
	t.is(conf2.get('4'), undefined);
	t.is(conf2.get('new'), 'old');
	t.is(conf2.get('2'), 1);
	t.is(conf2.get('__packageVersion__'), require('./package.json').version);
});

test('packageVersion is set initially', t => {
	const conf = new Conf({cwd: tempy.directory(), migrations: {}});

	t.is(conf.get('__packageVersion__'), require('./package.json').version);
});

test('packageVersion is not set without migrations', t => {
	const {conf} = t.context;

	t.is(conf.get('__packageVersion__'), undefined);
});
