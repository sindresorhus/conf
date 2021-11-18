import {JSONSchema as TypedJSONSchema} from 'json-schema-typed';
// eslint-disable unicorn/import-index
import Conf from '.';
import {EventEmitter} from 'events';

export interface Options<T> {
	/**
	Config used if there are no existing config.

	**Note:** The values in `defaults` will overwrite the `default` key in the `schema` option.
	*/
	defaults?: Readonly<T>;

	/**
	[JSON Schema](https://json-schema.org) to validate your config data.

	Under the hood, the JSON Schema validator [ajv](https://github.com/epoberezkin/ajv) is used to validate your config. We use [JSON Schema draft-07](https://json-schema.org/latest/json-schema-validation.html) and support all [validation keywords](https://github.com/epoberezkin/ajv/blob/master/KEYWORDS.md) and [formats](https://github.com/epoberezkin/ajv#formats).

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
	schema?: Schema<T>;

	/**
	Name of the config file (without extension).

	Useful if you need multiple config files for your app or module. For example, different config files between two major versions.

	@default 'config'
	*/
	configName?: string;

	/**
	You only need to specify this if you don't have a package.json file in your project or if it doesn't have a name defined within it.

	Default: The name field in the `package.json` closest to where `conf` is imported.
	*/
	projectName?: string;

	/**
	You only need to specify this if you don't have a package.json file in your project or if it doesn't have a version defined within it.

	Default: The name field in the `package.json` closest to where `conf` is imported.
	*/
	projectVersion?: string;

	/**
	You can use migrations to perform operations to the store whenever a version is changed.

	The `migrations` object should consist of a key-value pair of `'version': handler`. The `version` can also be a [semver range](https://github.com/npm/node-semver#ranges).

	Note: The version the migrations use refers to the __project version__ by default. If you want to change this behavior, specify the `projectVersion` option.

	@example
	```
	import Conf = require('conf');

	const store = new Conf({
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
	*/
	migrations?: Migrations<T>;

	/**
	__You most likely don't need this. Please don't use it unless you really have to.__

	The only use-case I can think of is having the config located in the app directory or on some external storage. Default: System default user [config directory](https://github.com/sindresorhus/env-paths#pathsconfig).
	*/
	cwd?: string;

	/**
	Note that this is __not intended for security purposes__, since the encryption key would be easily found inside a plain-text Node.js app.

	Its main use is for obscurity. If a user looks through the config directory and finds the config file, since it's just a JSON file, they may be tempted to modify it. By providing an encryption key, the file will be obfuscated, which should hopefully deter any users from doing so.

	It also has the added bonus of ensuring the config file's integrity. If the file is changed in any way, the decryption will not work, in which case the store will just reset back to its default state.

	When specified, the store will be encrypted using the [`aes-256-cbc`](https://en.wikipedia.org/wiki/Block_cipher_mode_of_operation) encryption algorithm.
	*/
	encryptionKey?: string | Buffer | NodeJS.TypedArray | DataView;

	/**
	Extension of the config file.

	You would usually not need this, but could be useful if you want to interact with a file with a custom file extension that can be associated with your app. These might be simple save/export/preference files that are intended to be shareable or saved outside of the app.

	@default 'json'
	*/
	fileExtension?: string;

	/**
	The config is cleared if reading the config file causes a `SyntaxError`. This is a good behavior for unimportant data, as the config file is not intended to be hand-edited, so it usually means the config is corrupt and there's nothing the user can do about it anyway. However, if you let the user edit the config file directly, mistakes might happen and it could be more useful to throw an error when the config is invalid instead of clearing.

	@default false
	*/
	clearInvalidConfig?: boolean;

	/**
	The [mode](https://en.wikipedia.org/wiki/File-system_permissions#Numeric_notation) that will be used for the config file.

	You would usually not need this, but it could be useful if you want to restrict the permissions of the configuration file. Setting a permission such as 0o600 would result in a configuration file that can only be accessed by the user running the program.

	Note that setting restrictive permissions can cause problems if multiple different users need to read the file.

	@default 0o666
	*/
	configFileMode: number;

	/**
	Function to serialize the config object to a UTF-8 string when writing the config file.

	You would usually not need this, but it could be useful if you want to use a format other than JSON.

	@default value => JSON.stringify(value, null, '\t')
	*/
	readonly serialize?: Serialize<T>;

	/**
	Function to deserialize the config object from a UTF-8 string when reading the config file.

	You would usually not need this, but it could be useful if you want to use a format other than JSON.

	@default JSON.parse
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

	/**
	Watch for any changes in the config file and call the callback for `onDidChange` or `onDidAnyChange` if set. This is useful if there are multiple processes changing the same config file.

	@default false
	*/
	readonly watch?: boolean;
}

export type Migrations<T> = Record<string, (store: Conf<T>) => void>;

export type Schema<T> = {[Property in keyof T]: ValueSchema};
export type ValueSchema = TypedJSONSchema;

export type Serialize<T> = (value: T) => string;
export type Deserialize<T> = (text: string) => T;

export type OnDidChangeCallback<T> = (newValue?: T, oldValue?: T) => void;
export type OnDidAnyChangeCallback<T> = (newValue?: Readonly<T>, oldValue?: Readonly<T>) => void;

export type Unsubscribe = () => EventEmitter;
