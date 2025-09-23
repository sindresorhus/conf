/* eslint-disable no-new, @typescript-eslint/naming-convention */
import {stringToUint8Array} from 'uint8array-extras';
import {expectTypeOf} from 'expect-type';
import Conf from '../source/index.js';

type UnicornFoo = {
	foo: string;
	unicorn: boolean;
	nested?: {
		prop: number;
	};
	hello?: number;
	items?: string[];
};

const typeTestProjectName = 'conf-type-tests';

const conf = new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	accessPropertiesByDotNotation: true,
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	defaults: {
		foo: 'bar',
		unicorn: false,
	},
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	configName: '',
});
new Conf<UnicornFoo>({projectName: 'foo'});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: '',
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	encryptionKey: '',
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	encryptionKey: stringToUint8Array(''),
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	encryptionKey: new Uint8Array([1]),
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	encryptionKey: new DataView(new ArrayBuffer(2)),
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	fileExtension: '.foo',
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	configFileMode: 0o600,
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	clearInvalidConfig: false,
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	serialize: () => 'foo',
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	deserialize: () => ({foo: 'foo', unicorn: true}),
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	projectSuffix: 'foo',
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	watch: true,
});

new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	schema: {
		foo: {
			type: 'string',
			default: 'foobar',
		},
		unicorn: {
			type: 'boolean',
		},
		hello: {
			type: 'number',
		},
		nested: {
			type: 'object',
			properties: {
				prop: {
					type: 'number',
				},
			},
		},
	},
});

conf.set('hello', 1);
conf.set('unicorn', false);
conf.set({foo: 'nope'});

conf.appendToArray('items', 'a');

conf.set('nested.prop', 3);

conf.set({
	nested: {
		prop: 3,
	},
});

expectTypeOf(conf.get('foo')).toEqualTypeOf<string>();
expectTypeOf(conf.get('foo', 'bar')).toEqualTypeOf<string>();
expectTypeOf(conf.get('nested.prop')).toEqualTypeOf<number | undefined>();
expectTypeOf(conf.get('nested.prop', 5)).toEqualTypeOf<number>();
conf.delete('foo');
expectTypeOf(conf.has('foo')).toEqualTypeOf<boolean>();
conf.delete('nested.prop');
expectTypeOf(conf.has('nested.prop')).toEqualTypeOf<boolean>();
conf.clear();
const off = conf.onDidChange('foo', (newValue, oldValue) => {
	expectTypeOf(newValue).toExtend<UnicornFoo[keyof UnicornFoo]>();
	expectTypeOf(oldValue).toExtend<UnicornFoo[keyof UnicornFoo]>();
});

expectTypeOf(off).toEqualTypeOf<() => void>();
off();

const offForNestedProp = conf.onDidChange('nested.prop', (newValue, oldValue) => {
	expectTypeOf(newValue).toEqualTypeOf<number | undefined>();
	expectTypeOf(oldValue).toEqualTypeOf<number | undefined>();
});

expectTypeOf(offForNestedProp).toEqualTypeOf<() => void>();
offForNestedProp();

conf.store = {
	foo: 'bar',
	unicorn: false,
};
expectTypeOf(conf.path).toEqualTypeOf<string>();
expectTypeOf(conf.size).toEqualTypeOf<number>();

expectTypeOf(conf[Symbol.iterator]()).toEqualTypeOf<IterableIterator<[keyof UnicornFoo, UnicornFoo[keyof UnicornFoo]]>>();
for (const [key, value] of conf) {
	expectTypeOf(key).toEqualTypeOf<keyof UnicornFoo>();
	expectTypeOf(value).toEqualTypeOf<UnicornFoo[keyof UnicornFoo]>();
}

// -- Docs examples --

type StoreType = {
	isRainbow: boolean;
	unicorn?: string;
};

const config = new Conf<StoreType>({
	projectName: typeTestProjectName,
	defaults: {
		isRainbow: true,
	},
});

config.get('isRainbow');
//=> true

expectTypeOf(conf.get('foo', 'bar')).toEqualTypeOf<string>();

config.set('unicorn', '🦄');
console.log(config.get('unicorn'));
//=> '🦄'

config.delete('unicorn');
console.log(config.get('unicorn'));
//=> undefined

// Should be stored type or default
expectTypeOf(config.get('isRainbow')).toEqualTypeOf<boolean>();
expectTypeOf(config.get('isRainbow', false)).toEqualTypeOf<boolean>();

expectTypeOf(config.get('unicorn')).toEqualTypeOf<string | undefined>();
expectTypeOf(config.get('unicorn', 'rainbow')).toEqualTypeOf<string>();
// @ts-expect-error - Type 'number' is not assignable to type 'string'
expectTypeOf(config.get('unicorn', 1)).toEqualTypeOf<string>();

// --

// -- Migrations --
new Conf({
	projectName: typeTestProjectName,
	projectVersion: '1.0.0',
	beforeEachMigration(store, context) {
		console.log(`[main-config] migrate from ${context.fromVersion} → ${context.toVersion}`);
		console.log(`[main-config] final migration version ${context.finalVersion}, all migrations that were run or will be ran: ${context.versions.toString()}`);
		console.log(`[main-config] phase ${(store.get('phase') ?? 'none') as string}`);
	},
	migrations: {
		'0.0.1'(store) {
			store.set('debug phase', true);
		},
		'1.0.0'(store) {
			store.delete('debug phase');
			store.set('phase', '1.0');
		},
		'1.0.2'(store) {
			store.set('phase', '>1.0');
		},
	},
});
// --
