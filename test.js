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

test('.set() with object', t => {
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

test('.set() invalid key', t => {
	t.throws(() => t.context.conf.set(1, 'unicorn'), 'Expected `key` to be of type `string` or `object`, got number');
});

test('.has()', t => {
	t.context.conf.set('foo', fixture);
	t.context.conf.set('baz.boo', fixture);
	t.true(t.context.conf.has('foo'));
	t.true(t.context.conf.has('baz.boo'));
	t.false(t.context.conf.has('missing'));
});

test('.delete()', t => {
	const conf = t.context.conf;
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
	t.notThrows(() => conf.get('foo'));
});

test('instance is iterable', t => {
	t.context.conf.set({
		foo: fixture,
		bar: fixture
	});
	t.deepEqual(Array.from(t.context.conf), [['foo', fixture], ['bar', fixture]]);
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
	const conf = t.context.conf;

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
