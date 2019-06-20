# conf [![Build Status](https://travis-ci.org/sindresorhus/conf.svg?branch=master)](https://travis-ci.org/sindresorhus/conf)

> Simple config handling for your app or module

All you have to care about is what to persist. This module will handle all the dull details like where and how.

*If you need this for Electron, check out [`electron-store`](https://github.com/sindresorhus/electron-store) instead.*


## Install

```
$ npm install conf
```


## Usage

```js
const Conf = require('conf');

const config = new Conf();

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

Or [create a subclass](https://github.com/sindresorhus/electron-store/blob/master/index.js).


## API

Changes are written to disk atomically, so if the process crashes during a write, it will not corrupt the existing config.

### Conf([options])

Returns a new instance.

### options

Type: `Object`

#### defaults

Type: `Object`

Default values for the config items.

**Note:** The values in `defaults` will overwrite the `default` key in the `schema` option.

#### schema

Type: `Object`

[JSON Schema](https://json-schema.org) to validate your config data.

Under the hood, the JSON Schema validator [ajv](https://github.com/epoberezkin/ajv) is used to validate your config. We use [JSON Schema draft-07](http://json-schema.org/latest/json-schema-validation.html) and support all [validation keywords](https://github.com/epoberezkin/ajv/blob/master/KEYWORDS.md) and [formats](https://github.com/epoberezkin/ajv#formats).

You should define your schema as an object where each key is the name of your data's property and each value is a JSON schema used to validate that property. See more [here](https://json-schema.org/understanding-json-schema/reference/object.html#properties).

Example:

```js
const Conf = require('conf');

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

const config = new Conf({schema});

console.log(config.get('foo'));
//=> 50

config.set('foo', '1');
// [Error: Config schema violation: `foo` should be number]
```

**Note:** The `default` value will be overwritten by the `defaults` option if set.

#### configName

Type: `string`<br>
Default: `config`

Name of the config file (without extension).

Useful if you need multiple config files for your app or module. For example, different config files between two major versions.

#### projectName

Type: `string`<br>
Default: The `name` field in the package.json closest to where `conf` is imported.

You only need to specify this if you don't have a package.json file in your project.

#### cwd

Type: `string`<br>
Default: System default [user config directory](https://github.com/sindresorhus/env-paths#pathsconfig)

**You most likely don't need this. Please don't use it unless you really have to.**

Overrides `projectName`.

The only use-case I can think of is having the config located in the app directory or on some external storage.

#### encryptionKey

Type: `string` `Buffer` `TypedArray` `DataView`<br>
Default: `undefined`

This can be used to secure sensitive data **if** the encryption key is stored in a secure manner (not plain-text) in the Node.js app. For example, by using [`node-keytar`](https://github.com/atom/node-keytar) to store the encryption key securely, or asking the encryption key from the user (a password) and then storing it in a variable.

In addition to security, this could be used for obscurity. If a user looks through the config directory and finds the config file, since it's just a JSON file, they may be tempted to modify it. By providing an encryption key, the file will be obfuscated, which should hopefully deter any users from doing so.

It also has the added bonus of ensuring the config file's integrity. If the file is changed in any way, the decryption will not work, in which case the store will just reset back to its default state.

When specified, the store will be encrypted using the [`aes-256-cbc`](https://en.wikipedia.org/wiki/Block_cipher_mode_of_operation) encryption algorithm.

#### fileExtension

Type: `string`<br>
Default: `json`

Extension of the config file.

You would usually not need this, but could be useful if you want to interact with a file with a custom file extension that can be associated with your app. These might be simple save/export/preference files that are intended to be shareable or saved outside of the app.

#### clearInvalidConfig

Type: `boolean`<br>
Default: `true`

The config is cleared if reading the config file causes a `SyntaxError`. This is a good default, as the config file is not intended to be hand-edited, so it usually means the config is corrupt and there's nothing the user can do about it anyway. However, if you let the user edit the config file directly, mistakes might happen and it could be more useful to throw an error when the config is invalid instead of clearing. Disabling this option will make it throw a `SyntaxError` on invalid config instead of clearing.

#### serialize

Type: `Function`<br>
Default: `value => JSON.stringify(value, null, '\t')`

Function to serialize the config object to a UTF-8 string when writing the config file.

You would usually not need this, but it could be useful if you want to use a format other than JSON.

#### deserialize

Type: `Function`<br>
Default: `JSON.parse`

Function to deserialize the config object from a UTF-8 string when reading the config file.

You would usually not need this, but it could be useful if you want to use a format other than JSON.

#### projectSuffix

Type: `string`<br>
Default: `nodejs`

**You most likely don't need this. Please don't use it unless you really have to.**

Suffix appended to `projectName` during config file creation to avoid name conflicts with native apps.

You can pass an empty string to remove the suffix.

For example, on macOS, the config file will be stored in the `~/Library/Preferences/foo-nodejs` directory, where `foo` is the `projectName`.

#### accessPropertiesByDotNotation

Type: `boolean`<br>
Default: `true`

Accessing nested properties by dot notation. For example:

```js
const config = new Conf();

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

Alternatively, you can set this option to `false` so the whole string would be treated as one key.

```js
const config = new Conf({accessPropertiesByDotNotation: false});

config.set({
	`foo.bar.foobar`: '🦄'
});

console.log(config.get('foo.bar.foobar'));
//=> '🦄'
```

### Instance

You can use [dot-notation](https://github.com/sindresorhus/dot-prop) in a `key` to access nested properties.

The instance is [`iterable`](https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Iteration_protocols) so you can use it directly in a [`for…of`](https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Statements/for...of) loop.

#### .set(key, value)

Set an item.

The `value` must be JSON serializable. Trying to set the type `undefined`, `function`, or `symbol` will result in a TypeError.

#### .set(object)

Set multiple items at once.

#### .get(key, [defaultValue])

Get an item or `defaultValue` if the item does not exist.

#### .has(key)

Check if an item exists.

#### .delete(key)

Delete an item.

#### .clear()

Delete all items.

#### .onDidChange(key, callback)

`callback`: `(newValue, oldValue) => {}`

Watches the given `key`, calling `callback` on any changes. When a key is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.

#### .onDidAnyChange(callback)

`callback`: `(newValue, oldValue) => {}`

Watches the whole config object, calling `callback` on any changes. `oldValue` and `newValue` will be the config object before and after the change, respectively. You must compare `oldValue` to `newValue` to find out what changed.

#### .size

Get the item count.

#### .store

Get all the config as an object or replace the current config with an object:

```js
conf.store = {
	hello: 'world'
};
```

#### .path

Get the path to the config file.



## FAQ

### How is this different from [`configstore`](https://github.com/yeoman/configstore)?

I'm also the author of `configstore`. While it's pretty good, I did make some mistakes early on that are hard to change at this point. This module is the result of everything I learned from making `configstore`. Mainly where the config is stored. In `configstore`, the config is stored in `~/.config` (which is mainly a Linux convention) on all systems, while `conf` stores config in the system default [user config directory](https://github.com/sindresorhus/env-paths#pathsconfig). The `~/.config` directory, it turns out, often have an incorrect permission on macOS and Windows, which has caused a lot of grief for users.

### Can I use YAML or another serialization format?

The `serialize` and `deserialize` options can be used to customize the format of the config file, as long as the representation is compatible with `utf8` encoding.

Example using YAML:

```js
const Conf = require('conf');
const yaml = require('js-yaml');

const config = new Conf({
	fileExtension: 'yaml',
	serialize: yaml.safeDump,
	deserialize: yaml.safeLoad
});
```


## Related

- [electron-store](https://github.com/sindresorhus/electron-store) - Simple data persistence for your Electron app or module
- [cache-conf](https://github.com/SamVerschueren/cache-conf) - Simple cache config handling for your app or module


## License

MIT © [Sindre Sorhus](https://sindresorhus.com)
