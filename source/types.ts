import {type JSONSchema as TypedJSONSchema} from 'json-schema-typed';
// eslint-disable unicorn/import-index
import type {Options as AjvOptions_} from 'ajv';
import type Conf from './index.js';

export type AjvOptions = AjvOptions_;

// The exported types below are written against `Record<string, any>` for the same reason the dot-notation types are, so a config type spelled with `interface` is a type they take, the way it is one `Conf` takes.
export type Options<T extends Record<string, any>> = {
	/**
	Default values for the config items.

	**Note:** The values in `defaults` will overwrite the `default` key in the `schema` option.

	**Note:** The values are copied when the store is created, so changing the object you passed afterwards has no effect. A value with a `toJSON` method, such as a `Date`, is stored as what it serializes to.

	**Note:** A key covered by `defaults` cannot be deleted, since the default is written back. With dot notation, a key below it can be deleted, and `reset()` puts it back.

	**Note:** A value must be JSON serializable, like for `set()`. A key set to `undefined` is ignored.
	*/
	defaults?: Readonly<DefaultsOf<T>>;

	/**
	[JSON Schema](https://json-schema.org) to validate your config data.

	This will be the [`properties`](https://json-schema.org/understanding-json-schema/reference/object.html#properties) object of the JSON schema. That is, define `schema` as an object where each key is the name of your data's property and each value is a JSON schema used to validate that property.

	**Note:** The ajv dependency may cause CSP violations. See the readme FAQ: Can I use `conf` with strict Content Security Policy (CSP)?

	@example
	```
	import Conf from 'conf';

	const schema = {
		foo: {
			type: 'number',
			maximum: 100,
			minimum: 1,
			default: 50
		},
		bar: {
			type: 'string',
			format: 'url'
		}
	};

	const config = new Conf({
		projectName: 'foo',
		schema
	});

	console.log(config.get('foo'));
	//=> 50

	config.set('foo', '1');
	// [Error: Config schema violation: `foo` must be number]
	```

	**Note:** The `default` value will be overwritten by the `defaults` option if set.

	**Note:** A `default` must be JSON serializable, like a `set()` value. With dot notation, a `schema` key must be a plain property name, so describe nested keys with `properties`. A name inside `properties` can contain a dot, such as `example.com`. Escape the dot to read or write it, such as `sites.example\.com` (in JavaScript, `'sites.example\\.com'`).

	To have `get()` return the right types, annotate the schema with `Schema<T>`:

	@example
	```
	import Conf, {type Schema} from 'conf';

	type Store = {
		isEnabled: boolean;
		interval: number;
	};

	const schema: Schema<Store> = {
		isEnabled: {type: 'boolean'},
		interval: {type: 'number'}
	};

	const config = new Conf({projectName: 'foo', schema});

	console.log(config.get('isEnabled'));
	//=> typed as boolean
	```

	Without the annotation, TypeScript cannot tell the value types from the schema, so `get()` returns `unknown`. If you also pass `defaults`, the schema still wins the inference, so a key that is only in `defaults` is an error.
	*/
	schema?: Schema<T>;

	/**
	Root-level [JSON Schema keywords](https://json-schema.org/understanding-json-schema/reference) for the schema, such as `additionalProperties` or `patternProperties`. This is useful when you do not know the key names in advance.

	The `properties` keyword comes from the `schema` option. Do not put `properties` in `rootSchema`, as it will throw.

	@example
	```
	import Conf from 'conf';

	const store = new Conf({
		projectName: 'foo',
		schema: {},
		rootSchema: {
			additionalProperties: false
		}
	});
	```

	@example
	```
	import Conf from 'conf';

	const store = new Conf({
		projectName: 'foo',
		rootSchema: {
			patternProperties: {
				'^.*$': {
					type: 'object',
					properties: {
						schedule: {type: 'string'}
					}
				}
			}
		}
	});
	```
	*/
	rootSchema?: RootSchema;

	/**
	[Options passed to AJV](https://ajv.js.org/options.html).

	Under the hood, the JSON Schema validator [ajv](https://ajv.js.org/json-schema.html) is used to validate your config. We use [JSON Schema draft-2020-12](https://json-schema.org/draft/2020-12/release-notes) and support all validation keywords and formats.

	**Note:** By default, `allErrors` and `useDefaults` are both set to `true`, but can be overridden.

	@example
	```
	import Conf from 'conf';

	const store = new Conf({
		projectName: 'foo',
		schema: {},
		rootSchema: {
			additionalProperties: false
		},
		ajvOptions: {
			removeAdditional: true
		}
	});
	```
	*/
	ajvOptions?: AjvOptions;

	/**
	Name of the config file (without extension).

	It may include a subdirectory of `cwd`, such as `sub/config`, but it must not point outside `cwd`.

	Useful if you need multiple config files for your app or module. For example, different config files between two major versions.

	@default 'config'
	*/
	configName?: string;

	/**
	__Required unless you specify the `cwd` option.__

	You can fetch the `name` field from package.json:

	@example
	```
	import Conf from 'conf';
	import packageJson from './package.json' with {type: 'json'};

	const config = new Conf({projectName: packageJson.name});
	```
	*/
	projectName?: string;

	/**
	__Required if you specify the `migrations` option.__

	You can fetch the `version` field from package.json.

	With `migrations`, it must be a full semantic version, such as `1.0.0`.
	*/
	projectVersion?: string;

	/**
	**Important: I cannot provide support for this feature. It has some known bugs. I have no plans to work on it, but pull requests are welcome.**

	You can use migrations to perform operations to the store whenever a **project version** is upgraded.

	The `migrations` object should consist of key-value pairs of `'version': handler`. The `version` can also be a [semver range](https://github.com/npm/node-semver#ranges). Migrations run in version order, whatever order they are defined in.

	A migration must not create another `Conf` instance with `migrations` for the same config file.

	A migration sees the keys the config file holds and the values of the `defaults` option. The `default` values of the `schema` option are added after the migrations have run, since a migration may repair a value the schema rejects.

	The store keeps its migration bookkeeping in the config file under a reserved `__internal__` key. It is not exposed through `.store`, `.get()`, `.has()` or iteration, and `.set()` and `.delete()` reject it.

	The recorded version never moves backwards, so running an older `projectVersion` than the store was migrated with does not run those migrations again.

	Migrations do not run for a config file that does not exist yet. There is no old data to migrate, so the store starts at the current project version. A config file that exists but has no recorded version is still migrated, which covers an app that shipped before it had migrations.

	@example
	```
	import Conf from 'conf';

	const store = new Conf({
		projectName: 'foo',
		projectVersion: '2.0.0',
		migrations: {
			'0.0.1': store => {
				store.set('debugPhase', true);
			},
			'1.0.0': store => {
				store.delete('debugPhase');
				store.set('phase', '1.0.0');
			},
			'1.0.2': store => {
				store.set('phase', '1.0.2');
			},
			'>=2.0.0': store => {
				store.set('phase', '>=2.0.0');
			}
		}
	});
	```

	**Note:** The migration versions are compared with the `projectVersion` option.

	If a migration throws, the changes it made are rolled back, and an error that includes its message is thrown. The migrations before it are kept.
	*/
	migrations?: Migrations<T>;

	/**
	The given callback function will be called before each migration step.

	The function receives the store as the first argument and a context object as the second argument with the following properties:

	- `fromVersion` - The version the migration step is being migrated from.
	- `toVersion` - The version the migration step is being migrated to. For a range, this is the version it runs at.
	- `finalVersion` - The final version after all the migrations are applied.
	- `versions` - The versions that will run in this migration pass.

	This can be useful for logging purposes, preparing migration data, etc.

	@default undefined

	@example
	```
	import Conf from 'conf';

	console.log = someLogger.log;

	// Migrations do not run for a config file that does not exist yet, so these log for an app that has run before.

	const mainConfig = new Conf({
		projectName: 'foo1',
		projectVersion: '0.4.0',
		beforeEachMigration: (store, context) => {
			console.log(`[main-config] migrate from ${context.fromVersion} → ${context.toVersion}`);
		},
		migrations: {
			'0.4.0': store => {
				store.set('debugPhase', true);
			},
		}
	});

	const secondConfig = new Conf({
		projectName: 'foo2',
		projectVersion: '1.0.1',
		beforeEachMigration: (store, context) => {
			console.log(`[second-config] migrate from ${context.fromVersion} → ${context.toVersion}`);
		},
		migrations: {
			'1.0.1': store => {
				store.set('debugPhase', true);
			},
		}
	});
	```
	*/
	beforeEachMigration?: BeforeEachMigrationCallback<T>;

	/**
	__You most likely don't need this. Please don't use it unless you really have to. By default, it will pick the optimal location by adhering to system conventions. You are very likely to get this wrong and annoy users.__

	Default: System default user [config directory](https://github.com/sindresorhus/env-paths#pathsconfig).

	Overrides `projectName`.

	By default the config is stored in the [system user's config directory](https://github.com/sindresorhus/env-paths#pathsconfig); running under another user reads a different store. Set `cwd` to share across users.

	The only use case I can think of is having the config located in the app directory or on some external storage.
	*/
	cwd?: string;

	/**
	Note that this is __not intended for security purposes__, since the encryption key would be easily found inside a plaintext Node.js app.

	Its main use is for obscurity. If a user looks through the config directory and finds the config file, since it's just a JSON file, they may be tempted to modify it. By providing an encryption key, the file will be obfuscated, which should hopefully deter any users from doing so.

	When using `aes-256-gcm`, the config file is authenticated. If the file is changed in any way, the decryption will fail. With `aes-256-cbc` and `aes-256-ctr`, tampering can go undetected.

	When specified, the store will be encrypted using the `encryptionAlgorithm` option (defaults to `aes-256-cbc`). An empty string is refused.

	@default undefined
	*/
	encryptionKey?: string | Uint8Array | NodeJS.TypedArray | DataView;

	/**
	Encryption algorithm to use when `encryptionKey` is set.

	Use `aes-256-gcm` if you want authentication, otherwise use `aes-256-cbc` or `aes-256-ctr`.

	Changing `encryptionAlgorithm` will make existing encrypted data unreadable.

	When using `aes-256-gcm` or `aes-256-ctr`, existing plaintext config files are not supported. Delete the config file or migrate it before enabling encryption. With `aes-256-cbc`, existing plaintext config files are still readable for backward compatibility.

	@default 'aes-256-cbc'
	*/
	encryptionAlgorithm?: 'aes-256-cbc' | 'aes-256-gcm' | 'aes-256-ctr';

	/**
	Extension of the config file.

	You would usually not need this, but it could be useful if you want to interact with a file with a custom file extension that can be associated with your app. These might be simple save/export/preference files that are intended to be shareable or saved outside of the app.

	@default 'json'
	*/
	fileExtension?: string;

	/**
	The config is cleared if reading the config file causes a `SyntaxError` (malformed JSON, also when thrown by your own `deserialize`), a schema validation error when using the `schema` option, or a decryption failure when using `encryptionKey`, and the cleared store is written over the file. This is a good behavior for unimportant data, as the config file is not intended to be hand-edited, so it usually means the config is corrupt and there's nothing the user can do about it anyway. However, if you let the user edit the config file directly, mistakes might happen and it could be more useful to throw an error when the config is invalid instead of clearing.

	A decryption failure includes a changed `encryptionKey` or `encryptionAlgorithm`, and a plaintext config file read with the `aes-256-gcm` or `aes-256-ctr` algorithm (for example, after adding encryption to an existing store). With your own `deserialize` and the `aes-256-cbc` or `aes-256-ctr` algorithm, a changed `encryptionKey` or `encryptionAlgorithm` is cleared only when your `deserialize` throws a `SyntaxError` for the data it cannot read, since those algorithms cannot tell a wrong key apart from damaged data. Any other error thrown by your own `deserialize` is thrown as is.

	@default false
	*/
	clearInvalidConfig?: boolean;

	/**
	Function to serialize the config object to a UTF-8 string, or to a `Uint8Array`, when writing the config file.

	You would usually not need this, but it could be useful if you want to use a format other than JSON.

	@default value => JSON.stringify(value, null, '\t')
	*/
	readonly serialize?: Serialize<T>;

	/**
	Function to deserialize the config object from a UTF-8 string when reading the config file.

	You would usually not need this, but it could be useful if you want to use a format other than JSON.

	@default `JSON.parse`, ignoring a leading byte order mark
	*/
	readonly deserialize?: Deserialize<T>;

	/**
	__You most likely don't need this. Please don't use it unless you really have to.__

	Suffix appended to `projectName` during config file creation to avoid name conflicts with native apps.

	You can pass an empty string to remove the suffix.

	For example, on macOS, the config file will be stored in the `~/Library/Preferences/foo-nodejs` directory, where `foo` is the `projectName`.

	@default 'nodejs'
	*/
	readonly projectSuffix?: string;

	/**
	Access nested properties by dot notation. For example:

	@default true

	@example
	```
	import Conf from 'conf';

	const config = new Conf({projectName: 'foo'});

	config.set({
		foo: {
			bar: {
				foobar: '🦄'
			}
		}
	});

	console.log(config.get('foo.bar.foobar'));
	//=> '🦄'
	```

	Alternatively, you can set this option to `false` so the whole string is treated as one key.

	@example
	```
	import Conf from 'conf';

	const config = new Conf({
		projectName: 'foo',
		accessPropertiesByDotNotation: false
	});

	config.set({
		'foo.bar.foobar': '🦄'
	});

	console.log(config.get('foo.bar.foobar'));
	//=> '🦄'
	```

	With this option on, `__proto__`, `constructor` and `prototype` cannot be used in a key: `set()` ignores such a key, `get()` returns the default value for it, and the `defaults` and `schema` options throw for it. Set this option to `false` to use them as keys.

	A key that is not a valid path, such as `a[x`, throws a `TypeError`.
	*/
	readonly accessPropertiesByDotNotation?: boolean;

	/**
	Watch for any changes in the config file and call the callback for `onDidChange` or `onDidAnyChange` if set. This is useful if there are multiple processes changing the same config file.

	If the config file is a symlink, the file it points to when the store is created is watched.

	@default false
	*/
	readonly watch?: boolean;

	/**
	Keep the store in memory, so reading a value does not read and parse the config file each time. This makes reads much faster, in particular when the config file is large.

	The cache is dropped on every write and whenever the `watch` option reports a change to the config file. Writes read the config file first, so changes made by another process are not lost, but reads only see them when `watch` is enabled or after a write.

	The objects returned by `.store`, `.get()` and iteration, and the values passed to the `onDidChange` and `onDidAnyChange` callbacks, are the cache itself, so the plain objects and arrays in them are frozen. Changing one throws a `TypeError`. Use `.set()` and `.delete()` to write, and copy a value first if you want to change it, for example with `structuredClone()`.

	@default false
	*/
	readonly cache?: boolean;

	/**
	The [mode](https://en.wikipedia.org/wiki/File-system_permissions#Numeric_notation) used when creating the config file.

	The mode is modified by the [process umask](https://en.wikipedia.org/wiki/Umask), whether it is the default or given by this option. With the typical umask of `0o022`, the default results in `0o644`. Config files are also stored in a location that is typically protected already, so the default is usually fine.

	When this option is given, the mode is also applied to an existing config file on every write. Otherwise, an existing config file keeps its mode. A mode given by this option that, after the umask, leaves the file unreadable by its owner throws.

	You would usually not need this, but it could be useful if you use a custom `cwd`. Setting `0o600` would make the file only readable by the owner.

	Note that setting restrictive permissions can cause problems if different users need to read the file. A common problem is a user running your tool with and without `sudo` and then not being able to access the config the second time.

	@default 0o666, reduced by the process umask
	*/
	readonly configFileMode?: number;
};

export type Migrations<T extends Record<string, any>> = Record<string, (store: Conf<T>) => void>;

export type BeforeEachMigrationContext = {
	fromVersion: string;
	toVersion: string;
	finalVersion: string;
	versions: string[];
};
export type BeforeEachMigrationCallback<T extends Record<string, any>> = (store: Conf<T>, context: BeforeEachMigrationContext) => void;

// Every property is optional, since the validator applies the keys the schema names and leaves the rest of the store to the file, so a schema that covers only some of the items is its normal use. A key that is not one of `T` is still refused.
export type Schema<T> = {[Property in keyof T]?: ValueSchema};
export type ValueSchema = TypedJSONSchema;

// The object form of a JSON schema, which is the root of a schema rather than a level of one. `TypedJSONSchema` is the object form of a schema or `true` or `false`, and `Exclude` leaves out `true` and `false`, since neither is an object and the runtime refuses one that is not. Any other keyword is taken, since a plugin of `ajv` such as `ajv-errors` adds keywords of its own. The `properties` keyword is not taken out, so a schema object typed as one is taken whole, and the runtime refuses it, since the `schema` option is where that keyword is read from.
type RootSchema = Exclude<TypedJSONSchema, boolean> & Record<string, unknown>;

// The text or the bytes a `serialize` answers with. A `deserialize` is given text whatever the `serialize` answered with, since the bytes of a file are decoded as text before it sees them, so a format that is not UTF-8 has to be read by a `serialize` and a `deserialize` of your own that both use text.
export type Serialize<T> = (value: T) => string | Uint8Array;
export type Deserialize<T> = (text: string) => T;

export type OnDidChangeCallback<T> = (newValue?: T, oldValue?: T) => void;
export type OnDidAnyChangeCallback<T> = (newValue: Readonly<T>, oldValue?: Readonly<T>) => void;

/**
The items an array a value can hold holds. A value that is an array, or `undefined` beside one as an optional key is, holds those items, and a value that is not an array at all is an array of anything, since a key that does not exist is created as one by `appendToArray()`.
*/
export type ArrayItemsOf<Value> = Extract<NonNullable<Value>, readonly unknown[]> extends ReadonlyArray<infer Item> ? Item : unknown;

export type Unsubscribe = () => void;

// A value the store holds as itself and not as the keys of an object, so a path into one of them names a member of that value and not a key of the store. Each of them satisfies `Record<string, any>` through the members its prototype has, so the keys under one would be every member of that type rather than the ones a caller wrote. An array is one of them, and so is a union of them, such as `string[] | Date`, which as a whole is neither an array nor one of the other types.
// `Error` is left out on purpose: every one of its members is data, so an ordinary object with a `name`, a `message` and a `stack` is one, and a path into it names a key of the store and not a member of a value.
type OpaqueValue = readonly unknown[] | Date | RegExp | URL | URLSearchParams
	// eslint-disable-next-line @typescript-eslint/no-restricted-types -- `object` is what `WeakMap` and `WeakSet` take a key as, and a narrower type here would refuse a `WeakMap` a caller built over a class.
	| ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | WeakMap<object, unknown> | WeakSet<object>
	| Promise<unknown>
	| ArrayBuffer | DataView
	| Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array
	| Float32Array | Float64Array | BigInt64Array | BigUint64Array;

// The recursion below and in `DotNotationValueOf` is written against `Record<string, any>` rather than `Record<string, unknown>`, since a type spelled with `interface` has no implicit index signature and would stop the recursion at the first level. An array and a value the store holds as itself are left out of it, since each of them satisfies `Record<string, any>` through the members its prototype has, which would widen the keys below it to every string.
// The paths stop ten levels down, so a type that holds itself, such as a tree, has a finite set of them. A deeper path is still taken by `get()` and `set(key, value)`, which fall back to any key. `set(object)`, the `defaults` option, `has()`, `delete()`, `reset()`, `appendToArray()` and `onDidChange()` have no such fallback, so a path more than ten levels deep is refused by them.
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- The empty tuple is the counter at the top, which the recursion adds an element to per level.
export type DotNotationKeyOf<T extends Record<string, any>, Depth extends unknown[] = []> = Depth['length'] extends 10 ? never : {
	[K in keyof Required<T>]: K extends string
		? Required<T>[K] extends OpaqueValue
			? K
			: Required<T>[K] extends Record<string, any>
				? K | `${K}.${DotNotationKeyOf<Required<T>[K], [...Depth, unknown]>}`
				: K
		: never
}[keyof T];

export type DotNotationValueOf<T extends Record<string, any>, K extends DotNotationKeyOf<T>> =
	K extends `${infer Head}.${infer Tail}`
		? Head extends keyof T
			? T[Head] extends Record<string, any>
				? Tail extends DotNotationKeyOf<T[Head]>
					// Type of objects for required properties
					? DotNotationValueOf<T[Head], Tail>
					: never
				: Required<T>[Head] extends Record<string, any>
					? Tail extends DotNotationKeyOf<Required<T>[Head]>
						// Type of objects for optional properties
						? DotNotationValueOf<Required<T>[Head], Tail> | undefined
						: never
					: never
			: never
		: K extends keyof T
			? T[K]
			: never;

// The keys the `defaults` option and `set(object)` take, which are the keys the store holds and the paths into it, since the option names a key the way `get()` and `set()` do and a path it gives is written to the place it names. A key of the store itself is left to `Partial<T>`, so only the paths the store does not hold as a key of its own are here, each of them given the value the store holds at it.
export type DefaultsOf<T extends Record<string, any>> = Partial<T> & {[Key in Exclude<DotNotationKeyOf<T>, keyof T>]?: DotNotationValueOf<T, Key>};

