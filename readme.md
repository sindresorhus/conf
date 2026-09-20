# conf

> Simple config handling for your app or module

All you have to care about is what to persist. This module will handle all the dull details like where and how.

**It does not support two processes writing to the same store at the same moment.**\
A write reads the config file first, so a change made by another process is not lost unless the two writes overlap. A whole-store write (`config.store = …`) replaces everything the file holds.\
I initially made this tool to let command-line tools persist some data.

*If you need this for Electron, check out [`electron-store`](https://github.com/sindresorhus/electron-store) instead.*

> [!NOTE]
> This is not a database. The entire JSON file is read and written on every change, so it's best suited for small data like user settings that change occasionally. For large data, or for a high rate of changes, use [`node:sqlite`](https://nodejs.org/api/sqlite.html) or similar.

## Install

```sh
npm install conf
```

## Usage

```js
import Conf from 'conf';

const config = new Conf({projectName: 'foo'});

config.set('unicorn', '🦄');
console.log(config.get('unicorn'));
//=> '🦄'

// Use dot-notation to access nested properties
config.set('foo.bar', true);
console.log(config.get('foo'));
//=> {bar: true}

config.delete('unicorn');
console.log(config.get('unicorn'));
//=> undefined
```

Or [create a subclass](https://github.com/sindresorhus/electron-store/blob/main/index.js).

## API

Changes are written to disk atomically, so if the process crashes during a write, it will not corrupt the existing config.

### Conf(options?)

Returns a new instance.

### options

Type: `object`

#### defaults

Type: `object`

Default values for the config items.

> [!NOTE]
> The values in `defaults` will overwrite the `default` key in the `schema` option.

> [!NOTE]
> The values are copied when the store is created, so changing the object you passed afterwards has no effect. A value with a `toJSON` method, such as a `Date`, is stored as what it serializes to.

> [!NOTE]
> A key covered by `defaults` cannot be deleted, since the default is written back. With dot notation, a key below it can be deleted, and `.reset()` puts it back.

> [!NOTE]
> A value must be JSON serializable, like for [`.set()`](#setkey-value). A key set to `undefined` is ignored.

#### schema

Type: `object`

[JSON Schema](https://json-schema.org) to validate your config data.

This will be the [`properties`](https://json-schema.org/understanding-json-schema/reference/object.html#properties) object of the JSON schema. That is, define `schema` as an object where each key is the name of your data's property and each value is a JSON schema used to validate that property.

> [!NOTE]
> The ajv dependency may cause CSP violations. See [Can I use `conf` with strict Content Security Policy (CSP)?](#can-i-use-conf-with-strict-content-security-policy-csp).

Example:

```js
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

> [!NOTE]
> The `default` value will be overwritten by the `defaults` option if set.

> [!NOTE]
> A `default` must be JSON serializable, like a [`.set()`](#setkey-value) value. With [dot notation](#accesspropertiesbydotnotation), a `schema` key must be a plain property name, so describe nested keys with `properties`. A name inside `properties` can contain a dot, such as `example.com`. Escape the dot to read or write it, such as `sites.example\.com` (in JavaScript, `'sites.example\\.com'`).

To have `get()` return the right types, annotate the schema with `Schema<T>`:

```ts
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

#### rootSchema

Type: `object`

Root-level [JSON Schema keywords](https://json-schema.org/understanding-json-schema/reference) for the schema, such as `additionalProperties` or `patternProperties`.

The `properties` keyword comes from the `schema` option. Do not put `properties` in `rootSchema`, as it will throw.

Example:

```js
import Conf from 'conf';

const store = new Conf({
	projectName: 'foo',
	schema: { /* … */ },
	rootSchema: {
		additionalProperties: false
	}
});
```

Example with `patternProperties`, for when you do not know the key names in advance:

```js
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

#### ajvOptions

Type: `object`

[Options passed to AJV](https://ajv.js.org/options.html).

Under the hood, the JSON Schema validator [ajv](https://ajv.js.org/json-schema.html) is used to validate your config. We use [JSON Schema draft-2020-12](https://json-schema.org/draft/2020-12/release-notes) and support all validation keywords and formats.

> [!NOTE]
> By default, `allErrors` and `useDefaults` are both set to `true`, but can be overridden.

Example:

```js
import Conf from 'conf';

const store = new Conf({
	projectName: 'foo',
	schema: { /* … */ },
	rootSchema: {
		additionalProperties: false
	},
	ajvOptions: {
		removeAdditional: true
	}
});
```

#### migrations

Type: `object`

**Important: I cannot provide support for this feature. It has some known bugs. I have no plans to work on it, but pull requests are welcome.**

You can use migrations to perform operations to the store whenever a **project version** is upgraded.

The `migrations` object should consist of key-value pairs of `'version': handler`. The `version` can also be a [semver range](https://github.com/npm/node-semver#ranges). Migrations run in version order, whatever order they are defined in.

A migration must not create another `Conf` instance with `migrations` for the same config file.

A migration sees the keys the config file holds and the values of the `defaults` option. The `default` values of the `schema` option are added after the migrations have run, since a migration may repair a value the schema rejects.

The store keeps its migration bookkeeping in the config file under a reserved `__internal__` key. It is not exposed through `.store`, `.get()`, `.has()` or iteration, and `.set()` and `.delete()` reject it.

The recorded version never moves backwards, so running an older `projectVersion` than the store was migrated with does not run those migrations again.

Migrations do not run for a config file that does not exist yet. There is no old data to migrate, so the store starts at the current project version. A config file that exists but has no recorded version is still migrated, which covers an app that shipped before it had migrations.

Example:

```js
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

> [!NOTE]
> The migration versions are compared with the [`projectVersion`](#projectversion) option.

If a migration throws, the changes it made are rolled back, and an error that includes its message is thrown. The migrations before it are kept.

#### beforeEachMigration

Type: `Function`\
Default: `undefined`

The given callback function will be called before each migration step.

The function receives the store as the first argument and a context object as the second argument with the following properties:

- `fromVersion` - The version the migration step is being migrated from.
- `toVersion` - The version the migration step is being migrated to. For a range, this is the version it runs at.
- `finalVersion` - The final version after all the migrations are applied.
- `versions` - The versions that will run in this migration pass.

This can be useful for logging purposes, preparing migration data, etc.

Example:

```js
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

#### configName

Type: `string`\
Default: `'config'`

Name of the config file (without extension).

It may include a subdirectory of `cwd`, such as `sub/config`, but it must not point outside `cwd`.

Useful if you need multiple config files for your app or module. For example, different config files between two major versions.

#### projectName

Type: `string`

**Required unless you specify the `cwd` option.**

You can fetch the `name` field from package.json:

```js
import Conf from 'conf';
import packageJson from './package.json' with {type: 'json'};

const config = new Conf({projectName: packageJson.name});
```

#### projectVersion

Type: `string`

**Required if you specify the `migrations` option.**

You can fetch the `version` field from package.json.

With [`migrations`](#migrations), it must be a full semantic version, such as `1.0.0`.

#### cwd

Type: `string`\
Default: System default [user config directory](https://github.com/sindresorhus/env-paths#pathsconfig)

**You most likely don't need this. Please don't use it unless you really have to. By default, it will pick the optimal location by adhering to system conventions. You are very likely to get this wrong and annoy users.**

Overrides `projectName`.

By default the config is stored in the [system user's config directory](https://github.com/sindresorhus/env-paths#pathsconfig); running under another user reads a different store. Set `cwd` to share across users.

The only use case I can think of is having the config located in the app directory or on some external storage.

#### encryptionKey

Type: `string | Uint8Array | TypedArray | DataView`\
Default: `undefined`

> [!CAUTION]
> This is **not intended for security purposes**, since the encryption key would be easily found inside a plaintext Node.js app.

Its main use is for obscurity. If a user looks through the config directory and finds the config file, since it's just a JSON file, they may be tempted to modify it. By providing an encryption key, the file will be obfuscated, which should hopefully deter any users from doing so.

When using `aes-256-gcm`, the config file is authenticated. If the file is changed in any way, the decryption will fail. With `aes-256-cbc` and `aes-256-ctr`, tampering can go undetected.

When specified, the store will be encrypted using the `encryptionAlgorithm` option (defaults to `aes-256-cbc`). An empty string is refused.

#### encryptionAlgorithm

Type: `'aes-256-cbc' | 'aes-256-gcm' | 'aes-256-ctr'`\
Default: `'aes-256-cbc'`

Encryption algorithm to use when `encryptionKey` is set.

Use `aes-256-gcm` if you want authentication, otherwise use `aes-256-cbc` or `aes-256-ctr`.

Changing `encryptionAlgorithm` will make existing encrypted data unreadable.

When using `aes-256-gcm` or `aes-256-ctr`, existing plaintext config files are not supported. Delete the config file or migrate it before enabling encryption. With `aes-256-cbc`, existing plaintext config files are still readable for backward compatibility.

#### fileExtension

Type: `string`\
Default: `'json'`

Extension of the config file.

You would usually not need this, but it could be useful if you want to interact with a file with a custom file extension that can be associated with your app. These might be simple save/export/preference files that are intended to be shareable or saved outside of the app.

#### clearInvalidConfig

Type: `boolean`\
Default: `false`

The config is cleared if reading the config file causes a `SyntaxError` (malformed JSON, also when thrown by your own [`deserialize`](#deserialize)), a schema validation error when using the `schema` option, or a decryption failure when using `encryptionKey`, and the cleared store is written over the file. This is a good behavior for unimportant data, as the config file is not intended to be hand-edited, so it usually means the config is corrupt and there's nothing the user can do about it anyway. However, if you let the user edit the config file directly, mistakes might happen and it could be more useful to throw an error when the config is invalid instead of clearing.

A decryption failure includes a changed `encryptionKey` or `encryptionAlgorithm`, and a plaintext config file read with the `aes-256-gcm` or `aes-256-ctr` algorithm (for example, after adding encryption to an existing store). With your own `deserialize` and the `aes-256-cbc` or `aes-256-ctr` algorithm, a changed `encryptionKey` or `encryptionAlgorithm` is cleared only when your `deserialize` throws a `SyntaxError` for the data it cannot read, since those algorithms cannot tell a wrong key apart from damaged data. Any other error thrown by your own [`deserialize`](#deserialize) is thrown as is.

#### serialize

Type: `Function`\
Default: `value => JSON.stringify(value, null, '\t')`

Function to serialize the config object to a UTF-8 string, or to a `Uint8Array`, when writing the config file.

You would usually not need this, but it could be useful if you want to use a format other than JSON.

#### deserialize

Type: `Function`\
Default: `JSON.parse`, ignoring a leading byte order mark

Function to deserialize the config object from a UTF-8 string when reading the config file.

You would usually not need this, but it could be useful if you want to use a format other than JSON.

#### projectSuffix

Type: `string`\
Default: `'nodejs'`

**You most likely don't need this. Please don't use it unless you really have to.**

Suffix appended to `projectName` during config file creation to avoid name conflicts with native apps.

You can pass an empty string to remove the suffix.

For example, on macOS, the config file will be stored in the `~/Library/Preferences/foo-nodejs` directory, where `foo` is the `projectName`.

#### accessPropertiesByDotNotation

Type: `boolean`\
Default: `true`

Access nested properties by dot notation. For example:

```js
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

```js
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

With this option on, `__proto__`, `constructor` and `prototype` cannot be used in a key: [`.set()`](#setkey-value) ignores such a key, [`.get()`](#getkey-defaultvalue) returns the default value for it, and the `defaults` and `schema` options throw for it. Set this option to `false` to use them as keys.

A key that is not a valid path, such as `a[x`, throws a `TypeError`.

#### watch

Type: `boolean`\
Default: `false`

Watch for any changes in the config file and call the callback for `onDidChange` or `onDidAnyChange` if set. This is useful if there are multiple processes changing the same config file.

If the config file is a symlink, the file it points to when the store is created is watched.

#### cache

Type: `boolean`\
Default: `false`

Keep the store in memory, so reading a value does not read and parse the config file each time. This makes reads much faster, in particular when the config file is large.

The cache is dropped on every write and whenever the [`watch`](#watch) option reports a change to the config file. Writes read the config file first, so changes made by another process are not lost, but reads only see them when `watch` is enabled or after a write.

The objects returned by [`.store`](#store), `.get()` and iteration, and the values passed to the `onDidChange` and `onDidAnyChange` callbacks, are the cache itself, so the plain objects and arrays in them are frozen. Changing one throws a `TypeError`. Use [`.set()`](#setkey-value) and [`.delete()`](#deletekey) to write, and copy a value first if you want to change it, for example with [`structuredClone()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/structuredClone).

#### configFileMode

Type: `number`\
Default: `0o666`, reduced by the process umask

The [mode](https://en.wikipedia.org/wiki/File-system_permissions#Numeric_notation) used when creating the config file.

The mode is modified by the [process umask](https://en.wikipedia.org/wiki/Umask), whether it is the default or given by this option. With the typical umask of `0o022`, the default results in `0o644`. Config files are also stored in a location that is typically protected already, so the default is usually fine.

When this option is given, the mode is also applied to an existing config file on every write. Otherwise, an existing config file keeps its mode. A mode given by this option that, after the umask, leaves the file unreadable by its owner throws.

You would usually not need this, but it could be useful if you use a custom `cwd`. Setting `0o600` would make the file only readable by the owner.

> [!NOTE]
> Setting restrictive permissions can cause problems if different users need to read the file. A common problem is a user running your tool with and without `sudo` and then not being able to access the config the second time.

### Instance

You can use [dot-notation](https://github.com/sindresorhus/dot-prop) in a `key` to access nested properties. A number addresses an element of an array. Setting an index past the end fills the gap with `null`, and `.delete()` removes the element, so the later elements move down.

The instance is [`iterable`](https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Iteration_protocols) so you can use it directly in a [`for…of`](https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Statements/for...of) loop.

#### .set(key, value)

Set an item.

The `value` must be JSON serializable. Trying to set a value of type `undefined`, `function`, or `symbol` will result in a `TypeError`, and so will a `bigint` unless you use a custom `serialize`.

#### .set(object)

Set multiple items at once.

Each key replaces the whole value it names, so a nested object is not merged into the one the store holds. With dot notation, a key can be a path, such as `{'foo.bar': 1}`, which sets only that nested property.

#### .get(key, defaultValue?)

Get an item or `defaultValue` if the item does not exist.

Tip: To get all items, see [`.store`](#store).

#### .reset(...keys)

Reset items to their default values, as defined by the `defaults` or `schema` option. The `default` values of the `schema` option are not used when `ajvOptions.useDefaults` is `false`.

With dot notation, schema defaults below an optional object with no default of its own are unavailable to `reset()` when a parent default omits that object. Include the object in the parent default to reset its descendants individually.

Use `.clear()` to reset all items.

#### .has(key)

Check if an item exists.

#### .appendToArray(key, value)

Append an item to an array.

If the key doesn't exist, it will be created as an array. If the key exists and is not an array, a `TypeError` will be thrown.

The `value` must be JSON serializable. Trying to set a value of type `undefined`, `function`, or `symbol` will result in a `TypeError`, and so will a `bigint` unless you use a custom `serialize`.

```js
config.set('items', [{name: 'foo'}]);
config.appendToArray('items', {name: 'bar'});
console.log(config.get('items'));
//=> [{name: 'foo'}, {name: 'bar'}]

// Creates array if key doesn't exist
config.appendToArray('newItems', 'first');
console.log(config.get('newItems'));
//=> ['first']
```

#### .delete(key)

Delete an item.

#### .clear()

Delete all items.

This resets known items to their default values, if defined by the `defaults` or `schema` option. The `default` values of the `schema` option are not used when `ajvOptions.useDefaults` is `false`.

#### .onDidChange(key, callback)

`callback`: `(newValue, oldValue) => {}`

Watches the given `key`, calling `callback` on any changes.

A change noticed while the config file cannot be read, for example while another process is writing it, is not reported.

When a key is first set, `oldValue` will be `undefined`, and when a key is deleted, `newValue` will be `undefined`.

Returns a function that unsubscribes when called:

```js
const unsubscribe = config.onDidChange(key, callback);

unsubscribe();
```

#### .onDidAnyChange(callback)

`callback`: `(newValue, oldValue) => {}`

Watches the whole config object, calling `callback` on any changes.

A change noticed while the config file cannot be read, for example while another process is writing it, is not reported.

`oldValue` and `newValue` will be the config object before and after the change, respectively. You must compare `oldValue` to `newValue` to find out what changed.

Returns a function that unsubscribes when called:

```js
const unsubscribe = config.onDidAnyChange(callback);

unsubscribe();
```

#### .events

An [`EventTarget`](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget) that dispatches a `change` event on every write of this instance, and when the [`watch`](#watch) option reports a change to the config file. This is what `.onDidChange()` and `.onDidAnyChange()` listen on, and it is there if you want to listen directly:

```js
config.events.addEventListener('change', () => {
	console.log('The config changed');
});
```

#### .size

Get the item count.

#### .store

Get all the config as an object or replace the current config with an object:

```js
console.log(config.store);
//=> [Object: null prototype] {name: 'John', age: 30}
```

Unlike [`.set()`](#setkey-value), a whole-store write drops a function or a symbol, like `JSON.stringify` does, instead of throwing. A `bigint` still throws, unless you use a custom `serialize`.

```js
config.store = {
	hello: 'world'
};
```

#### .path

Get the path to the config file.

## FAQ

### How is this different from [`configstore`](https://github.com/yeoman/configstore)?

I'm also the author of `configstore`. While it's pretty good, I did make some mistakes early on that are hard to change at this point. This module is the result of everything I learned from making `configstore`. Mainly where the config is stored. In `configstore`, the config is stored in `~/.config` (which is mainly a Linux convention) on all systems, while `conf` stores config in the system default [user config directory](https://github.com/sindresorhus/env-paths#pathsconfig). The `~/.config` directory, it turns out, often has incorrect permissions on macOS and Windows, which has caused a lot of grief for users.

### Can I use YAML or another serialization format?

The `serialize` and `deserialize` options can be used to customize the format of the config file, as long as the representation is compatible with UTF-8.

Example using YAML:

```js
import Conf from 'conf';
import yaml from 'js-yaml';

const config = new Conf({
	projectName: 'foo',
	fileExtension: 'yaml',
	serialize: yaml.dump,
	deserialize: yaml.load
});
```

### Can I use `conf` with strict Content Security Policy (CSP)?

`conf` depends on [`ajv`](https://ajv.js.org) for the `schema` option, which uses `unsafe-eval`. Even without using the `schema` option, `ajv` is still bundled and may cause CSP errors. As a workaround, you could configure your bundler to replace `ajv` with a stub:

```js
// webpack.config.js
module.exports = {
	resolve: {
		alias: {
			'ajv': false,
			'ajv-formats': false
		}
	}
};
```

### Can I use async operations in migrations?

Conf is synchronous by design, so this is not possible. As a workaround, you could use [`make-synchronous`](https://github.com/sindresorhus/make-synchronous) to convert asynchronous functions to synchronous (with caveats):

```js
import Conf from 'conf';
import makeSynchronous from 'make-synchronous';

const config = new Conf({
	projectName: 'foo',
	projectVersion: '0.0.1',
	migrations: {
		'0.0.1': store => {
			const syncAsyncFunction = makeSynchronous(asyncFunction);
			const result = syncAsyncFunction();
			store.set('migrated', result);
		}
	}
});
```

## Related

- [electron-store](https://github.com/sindresorhus/electron-store) - Simple data persistence for your Electron app or module
- [cache-conf](https://github.com/SamVerschueren/cache-conf) - Simple cache config handling for your app or module
