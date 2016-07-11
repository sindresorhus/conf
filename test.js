import path from 'path';
import {serial as test} from 'ava';
import tempfile from 'tempfile';
import del from 'del';
import pkgUp from 'pkg-up';
import Conf from './';

const fixture = '🦄';

test.beforeEach(t => {
	t.context.conf = new Conf({cwd: tempfile()});
});

test('.get()', t => {
	t.is(t.context.conf.get('foo'), undefined);
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
		cwd: tempfile(),
		defaults: {
			foo: 'bar'
		}
	});

	t.is(conf.get('foo'), 'bar');
});

test('`configName` option', t => {
	const configName = 'alt-config';
	const conf = new Conf({
		cwd: tempfile(),
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
	const cwd = tempfile();
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

test('safely handle missing `project.json`', t => {
	const pkgUpSyncOrig = pkgUp.sync;
	pkgUp.sync = () => null;

	let conf;
	t.notThrows(() => {
		conf = new Conf({projectName: 'conf-fixture-project-name'});
	});
	del.sync(conf.path, {force: true});
	pkgUp.sync = pkgUpSyncOrig;
});
