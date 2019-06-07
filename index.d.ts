/// <reference types="node"/>
import {JSONSchema} from 'json-schema-typed';

declare namespace Conf {
	interface Options<T> {
		/**
		Config used if there are no existing config.

		**Note:** The values in `defaults` will overwrite the `default` key in the `schema` option.
		*/
		readonly defaults?: {[key: string]: T};

		/**
		[JSON Schema](https://json-schema.org) to validate your config data.

		Under the hood, the JSON Schema validator [ajv](https://github.com/epoberezkin/ajv) is used to validate your config. We use [JSON Schema draft-07](http://json-schema.org/latest/json-schema-validation.html) and support all [validation keywords](https://github.com/epoberezkin/ajv/blob/master/KEYWORDS.md) and [formats](https://github.com/epoberezkin/ajv#formats).

		You should define your schema as an object where each key is the name of your data's property and each value is a JSON schema used to validate that property. See more [here](https://json-schema.org/understanding-json-schema/reference/object.html#properties).

		@example
		```
		import Conf = require('conf');

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
		*/
		readonly schema?: {[key: string]: JSONSchema};

		/**
		Name of the config file (without extension).

		Useful if you need multiple config files for your app or module. For example, different config files between two major versions.

		@default 'config'
		*/
		readonly configName?: string;

		/**
		You only need to specify this if you don't have a `package.json` file in your project. Default: The name field in the `package.json` closest to where `conf` is imported.
		*/
		readonly projectName?: string;

		/**
		__You most likely don't need this. Please don't use it unless you really have to.__

		The only use-case I can think of is having the config located in the app directory or on some external storage. Default: System default user [config directory](https://github.com/sindresorhus/env-paths#pathsconfig).
		*/
		readonly cwd?: string;

		/**
		Note that this is __not intended for security purposes__, since the encryption key would be easily found inside a plain-text Node.js app.

		Its main use is for obscurity. If a user looks through the config directory and finds the config file, since it's just a JSON file, they may be tempted to modify it. By providing an encryption key, the file will be obfuscated, which should hopefully deter any users from doing so.

		It also has the added bonus of ensuring the config file's integrity. If the file is changed in any way, the decryption will not work, in which case the store will just reset back to its default state.

		When specified, the store will be encrypted using the [`aes-256-cbc`](https://en.wikipedia.org/wiki/Block_cipher_mode_of_operation) encryption algorithm.
		*/
		readonly encryptionKey?: string | Buffer | NodeJS.TypedArray | DataView;

		/**
		Extension of the config file.

		You would usually not need this, but could be useful if you want to interact with a file with a custom file extension that can be associated with your app. These might be simple save/export/preference files that are intended to be shareable or saved outside of the app.

		@default 'json'
		*/
		readonly fileExtension?: string;

		/**
		The config is cleared if reading the config file causes a `SyntaxError`. This is a good default, as the config file is not intended to be hand-edited, so it usually means the config is corrupt and there's nothing the user can do about it anyway. However, if you let the user edit the config file directly, mistakes might happen and it could be more useful to throw an error when the config is invalid instead of clearing. Disabling this option will make it throw a `SyntaxError` on invalid config instead of clearing.

		@default true
		*/
		readonly clearInvalidConfig?: boolean;

		/**
		Function to serialize the config object to a UTF-8 string when writing the config file.

		You would usually not need this, but it could be useful if you want to use a format other than JSON.

		@default value => JSON.stringify(value, null, '\t')
		*/
		readonly serialize?: (value: {[key: string]: T}) => string;

		/**
		Function to deserialize the config object from a UTF-8 string when reading the config file.

		You would usually not need this, but it could be useful if you want to use a format other than JSON.

		@default JSON.parse
		*/
		readonly deserialize?: (text: string) => {[key: string]: T};

		/**
		__You most likely don't need this. Please don't use it unless you really have to.__

		Suffix appended to `projectName` during config file creation to avoid name conflicts with native apps.

		You can pass an empty string to remove the suffix.

		For example, on macOS, the config file will be stored in the `~/Library/Preferences/foo-nodejs` directory, where `foo` is the `projectName`.

		@default 'nodejs'
		*/
		readonly projectSuffix?: string;

		/**
		Access nested properties by dot notation.

		@default true

		@example
		```
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

		@example
		```
		const config = new Conf({accessPropertiesByDotNotation: false});

		config.set({
			`foo.bar.foobar`: '🦄'
		});

		console.log(config.get('foo.bar.foobar'));
		//=> '🦄'
		```

		*/
		readonly accessPropertiesByDotNotation?: boolean;
	}
}

/**
Simple config handling for your app or module.
*/
declare class Conf<T> implements Iterable<[string, T]> {
	store: {[key: string]: T};
	readonly path: string;
	readonly size: number;

	/**
	@example
	```
	import Conf = require('conf');

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
	*/
	constructor(options?: Conf.Options<T>);

	/**
	Set an item.

	@param key - You can use [dot-notation](https://github.com/sindresorhus/dot-prop) in a key to access nested properties.
	@param value - Must be JSON serializable. Trying to set the type `undefined`, `function`, or `symbol` will result in a `TypeError`.
	*/
	set(key: string, value: T): void;

	/**
	Set multiple items at once.

	@param object - A hashmap of items to set at once.
	*/
	set(object: {[key: string]: T}): void;

	/**
	Get an item.

	@param key - The key of the item to get.
	@param defaultValue - The default value if the item does not exist.
	*/
	get(key: string, defaultValue?: T): T;

	/**
	Check if an item exists.

	@param key - The key of the item to check.
	*/
	has(key: string): boolean;

	/**
	Delete an item.

	@param key - The key of the item to delete.
	*/
	delete(key: string): void;

	/**
	Delete all items.
	*/
	clear(): void;

	/**
	Watches the given `key`, calling `callback` on any changes.

	@param key - The key wo watch.
	@param callback - A callback function that is called on any changes. When a `key` is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.
	*/
	onDidChange(
		key: string,
		callback: (newValue: T | undefined, oldValue: T | undefined) => void
	): () => void;

	/**
	Watches the whole config object, calling `callback` on any changes.

	@param callback - A callback function that is called on any changes. When a `key` is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.
	*/
	onDidAnyChange(
		callback: (oldValue: {[key: string]: T} | undefined, newValue: {[key: string]: T} | undefined) => void
	): () => void;

	[Symbol.iterator](): IterableIterator<[string, T]>;
}

export = Conf;
