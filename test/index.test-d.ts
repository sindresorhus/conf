/* eslint-disable no-new, @typescript-eslint/naming-convention, @typescript-eslint/consistent-type-definitions -- the config types below are spelled with `interface` on purpose, since a type the dot-notation types must not depend on an implicit index signature is what they are for */
import {stringToUint8Array} from 'uint8array-extras';
import {expectTypeOf} from 'expect-type';
import {type JSONSchema} from 'json-schema-typed';
import {temporaryDirectory} from 'tempy';
import Conf, {type Options, type Schema} from '../source/index.js';

type UnicornFoo = {
	foo: string;
	unicorn: boolean;
	nested?: {
		prop: number;
	};
	hello?: number;
	items?: string[];
};

// A config type spelled with `interface` has no implicit index signature, which the dot-notation types must not depend on, so a path into it is typed the same as for a type alias.
interface UnicornNested {
	prop: number;
}

interface UnicornInterface {
	foo: string;
	nested: UnicornNested;
}

const typeTestProjectName = 'conf-type-tests';
const typeTestDirectory = temporaryDirectory();

const conf = new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: typeTestDirectory,
	accessPropertiesByDotNotation: true,
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	defaults: {
		foo: 'bar',
		unicorn: false,
	},
});
// The runtime applies the keys the option gives and leaves the rest to the file, so defaults that cover only some of the items are the option's normal use.
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	defaults: {
		foo: 'bar',
	},
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	defaults: {
		// @ts-expect-error -- a partial set of defaults still types every value it does give
		unicorn: 'nope',
	},
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	configName: '',
});
new Conf<UnicornFoo>({
	projectName: 'foo',
	cwd: temporaryDirectory(),
});
// Never called, since an empty `cwd` puts the store in the user's own config directory.
const emptyCwdTypeChecks = (): void => {
	new Conf<UnicornFoo>({
		projectName: typeTestProjectName,
		cwd: '',
	});
};

new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	encryptionKey: 'secret',
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	encryptionKey: stringToUint8Array(''),
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	encryptionKey: new Uint8Array([1]),
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	encryptionKey: new DataView(new ArrayBuffer(2)),
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	encryptionKey: 'secret',
	encryptionAlgorithm: 'aes-256-gcm',
});
type EncryptionAlgorithmOption = Options<UnicornFoo>['encryptionAlgorithm'];
// @ts-expect-error - `encryptionAlgorithm` must be a supported value
const invalidEncryptionAlgorithm: EncryptionAlgorithmOption = 'aes-256-foo';
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	fileExtension: '.foo',
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	configFileMode: 0o600,
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	clearInvalidConfig: false,
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	serialize: () => 'foo',
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	deserialize: () => ({foo: 'foo', unicorn: true}),
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	projectSuffix: 'foo',
});
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	watch: true,
});

new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
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

// The calls below are about the types, so they are in a function that is never run, since the runtime refuses each of them.
const setTypeChecks = (): void => {
	// @ts-expect-error - a key needs a value, since a key given no value is refused
	conf.set('foo');
	// @ts-expect-error - the value is checked against the key the store names it by
	conf.set('foo', 123);
	// @ts-expect-error - a path the store names is checked the same way
	conf.set('nested.prop', 'not a number');
	// @ts-expect-error - `undefined` is refused, so an optional key is still written with a value
	conf.set('hello', undefined);
	// @ts-expect-error - the same goes for a path below an optional key
	conf.set('nested.prop', undefined);
};

conf.appendToArray('items', 'a');

// The items a value can hold come from the array it is, so an optional key, whose type is the array next to `undefined`, holds the same items as a required one does. Appending to a key that is not an array is its normal use, since a key that does not exist is created as an array, so anything goes there.
const appendToArrayTypeChecks = (): void => {
	// @ts-expect-error - a number is not a string
	conf.appendToArray('items', 123);

	const optionalParent = new Conf<{parent?: {list: number[]}}>({
		projectName: typeTestProjectName,
		cwd: typeTestDirectory,
	});
	// @ts-expect-error - a string is not a number, the same as under a key the store names itself
	optionalParent.appendToArray('parent.list', 'not a number');
	optionalParent.appendToArray('parent.list', 1);

	// A key that is not an array is created as one when it does not exist, so anything goes there.
	conf.appendToArray('nested.prop', 'anything');
};

conf.set('nested.prop', 3);

// A value that is a function is one the store cannot hold, so it is kept as it is in the type of an object written at once. A function of a parameter is not a function of `unknown` parameters, so it used to fall through to the object branch, where the type of a function resolves to the empty object, which takes any value.
declare const confWithAFunction: Conf<{
	callback: (value: number) => string;
	nested: {callback: (value: number) => string};
	list: Array<(value: number) => string>;
}>;

const functionTypeChecks = (): void => {
	// @ts-expect-error - a number is not a function of a number for the key `callback`
	confWithAFunction.set({callback: 123});
	// @ts-expect-error - the same below a key
	confWithAFunction.set({nested: {callback: 123}});
	// @ts-expect-error - the same as an element of a list
	confWithAFunction.set({list: [123]});
};

conf.set({
	nested: {
		prop: 3,
	},
});

expectTypeOf(conf.get('foo')).toEqualTypeOf<string>();
expectTypeOf(conf.get('foo', 'bar')).toEqualTypeOf<string>();
expectTypeOf(conf.get('nested.prop')).toEqualTypeOf<number | undefined>();
expectTypeOf(conf.get('nested.prop', 5)).toEqualTypeOf<number>();

// The runtime validates the keys the schema names and leaves the rest to the file, so a schema that covers only some of the items is its normal use.
const partialSchema: Schema<UnicornFoo> = {
	foo: {type: 'string'},
};
new Conf<UnicornFoo>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	schema: partialSchema,
});

const schemaWithAKeyThatIsNotOneOfTheStore: Schema<UnicornFoo> = {
	// @ts-expect-error - a key the store does not name cannot be validated for it
	notAKeyOfTheStore: {type: 'string'},
};

// The `defaults` option names a key the way `get()` and `set()` do, so it takes a path into the store as well as a key of it, which is what the option's own note says. The value a path is given is the one the store holds at it, so it is checked the same as the value of a key.
type NestedStore = {nested: {prop: number; other: string}};

new Conf<NestedStore>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	defaults: {
		nested: {prop: 1, other: 'two'},
		'nested.prop': 5,
	},
});

const defaultsWithAValueAPathDoesNotHold: Options<NestedStore>['defaults'] = {
	// @ts-expect-error - a path is checked against the value the store holds at it, the same as a key is
	'nested.prop': 'not a number',
};

new Conf({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	schema: {},
	rootSchema: {
		additionalProperties: false,
	},
});
new Conf({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	rootSchema: {
		patternProperties: {
			'^.*$': {
				type: 'object',
				// The `properties` of a level below the root are read as keys of it, the same as they are under the `schema` option.
				properties: {
					schedule: {type: 'string'},
				},
			},
		},
	},
});

// The `rootSchema` option is an object of root-level keywords, so a schema of `true` or `false` is not one of them, and neither is a string. A schema object typed as one is taken whole, and so is a custom keyword a plugin of `ajv` adds. The runtime refuses a `properties` keyword in it.
type RootSchemaOption = Options<UnicornFoo>['rootSchema'];
// @ts-expect-error - the option is an object of root-level keywords, so a string is not one
const rootSchemaThatIsNotAnObject: RootSchemaOption = 'nope';
const rootSchemaWithCustomKeyword: RootSchemaOption = {additionalProperties: false, errorMessage: 'Unknown key'};
const rootSchemaFromSchemaObject = (schema: Exclude<JSONSchema, boolean>): RootSchemaOption => schema;
expectTypeOf(rootSchemaWithCustomKeyword).not.toBeUndefined();
expectTypeOf(rootSchemaFromSchemaObject).toBeFunction();

const interfaceConf = new Conf<UnicornInterface>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
});
expectTypeOf(interfaceConf.get('foo')).toEqualTypeOf<string>();
expectTypeOf(interfaceConf.get('nested.prop')).toEqualTypeOf<number>();
expectTypeOf(interfaceConf.get('nested.prop', 5)).toEqualTypeOf<number>();

// The calls below are about the types, so they are in a function that is never run, since the runtime refuses each of them.
const interfaceTypeChecks = (): void => {
	// @ts-expect-error - a path the store names is checked the same as for a type alias
	interfaceConf.set('nested.prop', 'not a number');
};

// A config type spelled with `interface` has no implicit index signature, so every type a caller spells out for one has to be written the way the dot-notation types are, or the type a store already takes is refused by the types around it.
const interfaceOptions: Options<UnicornInterface> = {
	projectName: typeTestProjectName,
	cwd: typeTestDirectory,
};
new Conf<UnicornInterface>(interfaceOptions);

// A key is left out of an object written at once, the same as for a type alias.
interfaceConf.set({foo: 'bar'});
expectTypeOf(interfaceConf.get('nested')).toEqualTypeOf<UnicornNested>();

conf.delete('foo');
expectTypeOf(conf.has('foo')).toEqualTypeOf<boolean>();
conf.delete('nested.prop');
expectTypeOf(conf.has('nested.prop')).toEqualTypeOf<boolean>();
conf.clear();
const off = conf.onDidChange('foo', (newValue, oldValue) => {
	expectTypeOf(newValue).toEqualTypeOf<string | undefined>();
	expectTypeOf(oldValue).toEqualTypeOf<string | undefined>();
});

expectTypeOf(off).toEqualTypeOf<() => void>();
off();

const offForNestedProp = conf.onDidChange('nested.prop', (newValue, oldValue) => {
	expectTypeOf(newValue).toEqualTypeOf<number | undefined>();
	expectTypeOf(oldValue).toEqualTypeOf<number | undefined>();
});

expectTypeOf(offForNestedProp).toEqualTypeOf<() => void>();
offForNestedProp();

const offForAnyChange = conf.onDidAnyChange((newValue, oldValue) => {
	expectTypeOf(newValue).toEqualTypeOf<Readonly<UnicornFoo>>();
	expectTypeOf(oldValue).toEqualTypeOf<Readonly<UnicornFoo> | undefined>();
});

expectTypeOf(offForAnyChange).toEqualTypeOf<() => void>();
offForAnyChange();

// `get()` takes the types of a store from a schema annotated with `Schema<T>`, with no type argument given, which is what the readme shows.
type ReadmeStore = {
	isEnabled: boolean;
	interval: number;
};

const readmeSchema: Schema<ReadmeStore> = {
	isEnabled: {type: 'boolean'},
	interval: {type: 'number'},
};

const typedBySchema = new Conf({projectName: typeTestProjectName, cwd: temporaryDirectory(), schema: readmeSchema});
expectTypeOf(typedBySchema.get('isEnabled')).toEqualTypeOf<boolean>();
expectTypeOf(typedBySchema.get('interval')).toEqualTypeOf<number>();

// Without the annotation the schema says nothing about the types of the values, so a value is `unknown`.
const untypedSchema = new Conf({projectName: typeTestProjectName, cwd: temporaryDirectory(), schema: {isEnabled: {type: 'boolean'}}});
expectTypeOf(untypedSchema.get('isEnabled')).toEqualTypeOf<unknown>();

// The keys of the `defaults` option are the keys of the store, so they give the types with no type argument either.
const typedByDefaults = new Conf({projectName: typeTestProjectName, cwd: temporaryDirectory(), defaults: {isRainbow: true, count: 1}});
expectTypeOf(typedByDefaults.get('isRainbow')).toEqualTypeOf<boolean>();
expectTypeOf(typedByDefaults.get('count')).toEqualTypeOf<number>();

// The file also runs as a test, so a write the types refuse is only checked, never made.
const inferredTypeChecks = (): void => {
	// @ts-expect-error - a value is checked against the type the schema gives the key
	typedBySchema.set('interval', 'not a number');
	// @ts-expect-error - a value is checked against the type the default gives the key
	typedByDefaults.set('count', 'not a number');
};

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
	cwd: temporaryDirectory(),
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
	cwd: temporaryDirectory(),
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

// A store with an array among its items does not widen the keys the dot-notation types allow, since an array satisfies the recursion through the members `Array.prototype` has.
type WithArray = {
	title: string;
	items: string[];
};

const arrayConf = new Conf<WithArray>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
});

expectTypeOf(arrayConf.get('title')).toEqualTypeOf<string>();
expectTypeOf(arrayConf.get('items')).toEqualTypeOf<string[]>();

// A key the store does not name reads as `unknown`, which no item can be read as, rather than as `never`, which fits anything. An array among the items is what would widen the keys below it, since one satisfies the recursion through the members `Array.prototype` has.
expectTypeOf(arrayConf.get('typo')).toBeUnknown();

const keysAreNotWidened = (): void => {
	// @ts-expect-error - a key the store does not name is refused
	arrayConf.has('typo');
	// @ts-expect-error - a key the store does not name is refused
	arrayConf.delete('typo');
	// @ts-expect-error - a key the store does not name is refused
	arrayConf.reset('typo');
};

// A value the store holds as itself and not as the keys of an object, the way an array is, since each of them satisfies the recursion through the members its prototype has and would widen the keys below it to every string.
type WithOpaqueValues = {
	when: Date;
	lookup: Map<string, number>;
	pattern: RegExp;
	where: URL;
	plain: {inner: number};
};

const opaqueConf = new Conf<WithOpaqueValues>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
});

expectTypeOf(opaqueConf.get('when')).toEqualTypeOf<Date>();
expectTypeOf(opaqueConf.get('plain.inner')).toEqualTypeOf<number>();
// A member of one of them is not a key of the store, so a method that has to name one refuses it, the way one below an array is refused.
const opaqueKeysAreRefused = (): void => {
	// @ts-expect-error - a `Date` holds no key of the store
	opaqueConf.has('when.getTime');
	// @ts-expect-error - a `Map` holds no key of the store
	opaqueConf.delete('lookup.size');
	// @ts-expect-error - a `RegExp` holds no key of the store
	opaqueConf.reset('pattern.source');
};

// Every member of an `Error` is data, so an ordinary object with a `name`, a `message` and a `stack` is one, and a path into it names a key of the store and not a member of a value.
type WithErrorShapedData = {meta: {name: string; message: string; stack?: string}; other: {inner: number}};

const errorShapedConf = new Conf<WithErrorShapedData>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
});

expectTypeOf(errorShapedConf.get('meta.name')).toEqualTypeOf<string>();
expectTypeOf(errorShapedConf.get('other.inner')).toEqualTypeOf<number>();

// A readonly array holds the same items, and the same keys below it are not widened by it.
type WithReadonlyArray = {items: ReadonlyArray<{inner: number}>};

const readonlyArrayConf = new Conf<WithReadonlyArray>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
});

expectTypeOf(readonlyArrayConf.get('items')).toEqualTypeOf<ReadonlyArray<{inner: number}>>();
readonlyArrayConf.appendToArray('items', {inner: 1});
// @ts-expect-error - a string is not an object with an `inner` number
readonlyArrayConf.appendToArray('items', {inner: 'not a number'});
// @ts-expect-error - a key below an array is not a key of the store
readonlyArrayConf.has('items.0.inner');

// A store type that declares a numeric key reaches it by the name the store holds it under, and the whole of what a store with a string key can do keeps working.
const stringKeyedNumericConf = new Conf<{1: string} & Record<string, string>>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
});

stringKeyedNumericConf.get('1');
stringKeyedNumericConf.set('1', 'a value');
stringKeyedNumericConf.has('1');
stringKeyedNumericConf.delete('1');
stringKeyedNumericConf.reset('1');
stringKeyedNumericConf.appendToArray('1', 'a value');
stringKeyedNumericConf.onDidChange('1', () => false);

// A store type that holds itself, such as a tree, has paths that stop at a depth, so the `defaults` option still types the keys and the paths it gives.
type TreeNode = {label: string; parent?: TreeNode; left?: TreeNode; right?: TreeNode};
const treeConf = new Conf<{last?: TreeNode}>({
	projectName: typeTestProjectName,
	cwd: temporaryDirectory(),
	defaults: {last: {label: 'root'}, 'last.parent.label': 'parent'},
});
expectTypeOf(treeConf.get('last.left.right.label')).toEqualTypeOf<string | undefined>();
// A path deeper than the paths go is still taken, as a key the store type does not name.
expectTypeOf(treeConf.get('last.left.left.left.left.left.left.left.left.left.left.label')).toEqualTypeOf<unknown>();
const treeDefaultsWithTheWrongValue: Options<{last?: TreeNode}>['defaults'] = {
	// @ts-expect-error - a path into a store type that holds itself is still checked against the value it holds
	'last.label': 1,
};
expectTypeOf(treeDefaultsWithTheWrongValue).not.toBeUndefined();

// A wrapper that is generic over the store type passes its keys on.
class StoreWrapper<S extends Record<string, any>> {
	constructor(private readonly conf: Conf<S>) {}

	get<K extends keyof S>(key: K): S[K] {
		return this.conf.get(key);
	}

	set<K extends keyof S>(key: K, value: Exclude<S[K], undefined>): void {
		this.conf.set(key, value);
	}

	has<K extends keyof S>(key: K): boolean {
		return this.conf.has(key);
	}

	delete<K extends keyof S>(key: K): void {
		this.conf.delete(key);
	}
}

expectTypeOf(new StoreWrapper(treeConf).get('last')).toEqualTypeOf<TreeNode | undefined>();

// An object written at once replaces the value of each key it gives, the way `set(key, value)` does, so a nested object is written whole, and a path writes the place it names, the same as for the `defaults` option.
declare const nestedConf: Conf<NestedStore>;
declare const bytesConf: Conf<{bytes: Uint8Array}>;
conf.set({'nested.prop': 3});
const setObjectTypeChecks = (): void => {
	// @ts-expect-error - a nested object replaces the one the store holds, so it is written whole
	nestedConf.set({nested: {prop: 1}});
	// @ts-expect-error - a value the store holds as itself is not written as some of its members
	bytesConf.set({bytes: {}});
	// @ts-expect-error - a readonly array holds no `undefined` items
	readonlyArrayConf.set({items: [undefined]});
};

// The default is used only when the value is `undefined`, so a `null` the store holds is still read as itself.
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- A `null` is what the default must not replace.
declare const nullableConf: Conf<{nested: {value: string | null}; top: string | undefined}>;
const nullableTypeChecks = (): void => {
	// eslint-disable-next-line @typescript-eslint/no-restricted-types -- See above.
	expectTypeOf(nullableConf.get('nested.value', 'fallback')).toEqualTypeOf<string | null>();
	expectTypeOf(nullableConf.get('top', 'fallback')).toEqualTypeOf<string>();
};

// A union of an array and a value the store holds as itself has no keys below it either.
declare const unionConf: Conf<{value: string[] | Date}>;
const unionKeysAreNotWidened = (): void => {
	// @ts-expect-error - a member both of them have is not a key of the store
	unionConf.has('value.toString');
};

const defaultsWithAPathTheStoreDoesNotName: Options<NestedStore>['defaults'] = {
	// @ts-expect-error - a path the store does not name is refused
	'nested.typo': 1,
};

expectTypeOf(interfaceConf.has('nested.prop')).toEqualTypeOf<boolean>();
interfaceConf.delete('nested.prop');
interfaceConf.onDidChange('nested.prop', newValue => {
	expectTypeOf(newValue).toEqualTypeOf<number | undefined>();
});
