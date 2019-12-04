import fs = require('fs');
import path = require('path');
import crypto = require('crypto');
import assert = require('assert');
import EventEmitter = require('events');
import dotProp = require('dot-prop');
import makeDir = require('make-dir');
import pkgUp = require('pkg-up');
import envPaths = require('env-paths');
import writeFileAtomic = require('write-file-atomic');
import Ajv = require('ajv');
import debounceFn = require('debounce-fn');
import semver = require('semver');
import onetime = require('onetime');

const encryptionAlgorithm = 'aes-256-cbc';

// Prevent caching of this module so module.parent is always accurate
// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
delete require.cache[__filename];
const parentDir = path.dirname((module.parent && module.parent.filename) || '.');

const checkValueType = (key: string, value: unknown): void => {
	const nonJsonTypes = [
		'undefined',
		'symbol',
		'function'
	];

	const type = typeof value;

	if (nonJsonTypes.includes(type)) {
		throw new TypeError(`Setting a value of type \`${type}\` for key \`${key}\` is not allowed as it's not supported by JSON`);
	}
};

const INTERNAL_KEY = '__internal__';
const MIGRATION_KEY = `${INTERNAL_KEY}.migrations.version`;

export default class Conf<T = unknown> implements Iterable<[string, T]> {
	_options: Partial<Options<T>>;

	_defaultValues: {[key: string]: T} = {};

	_validator?: Ajv.ValidateFunction;

	encryptionKey: string | undefined;

	events: EventEmitter;

	serialize: (value: {[key: string]: T}) => string;

	deserialize: (text: string) => T;

	path: string;

	/**
	Simple config handling for your app or module.
	*/
	constructor(partialOptions?: Partial<Options<T>>) {
		const options: Partial<Options<T>> = {
			configName: 'config',
			fileExtension: 'json',
			projectSuffix: 'nodejs',
			clearInvalidConfig: true,
			accessPropertiesByDotNotation: true,
			...partialOptions
		};

		const getPackageData = onetime(() => {
			const packagePath = pkgUp.sync({cwd: parentDir});
			// Can't use `require` because of Webpack being annoying:
			// https://github.com/webpack/webpack/issues/196
			const packageData = packagePath && JSON.parse(fs.readFileSync(packagePath, 'utf8'));

			return packageData || {};
		});

		if (!options.cwd) {
			if (!options.projectName) {
				options.projectName = getPackageData().name;
			}

			if (!options.projectName) {
				throw new Error('Project name could not be inferred. Please specify the `projectName` option.');
			}

			options.cwd = envPaths(options.projectName, {suffix: options.projectSuffix}).config;
		}

		this._options = options;

		if (options.schema) {
			if (typeof options.schema !== 'object') {
				throw new TypeError('The `schema` option must be an object.');
			}

			const ajv = new Ajv({
				allErrors: true,
				format: 'full',
				useDefaults: true,
				errorDataPath: 'property'
			});
			const schema = {
				type: 'object',
				properties: options.schema
			};

			this._validator = ajv.compile(schema);

			for (const [key, value] of Object.entries(options.schema)) {
				if (value && value.default) {
					this._defaultValues[key] = value.default;
				}
			}
		}

		if (options.defaults) {
			this._defaultValues = {
				...this._defaultValues,
				...options.defaults
			};
		}

		this.events = new EventEmitter();
		this.encryptionKey = options.encryptionKey;
		this.serialize = options.serialize ? options.serialize : value => JSON.stringify(value, null, '\t');
		this.deserialize = options.deserialize ? options.deserialize : (arg: string): T => JSON.parse(arg);

		const fileExtension = options.fileExtension ? `.${options.fileExtension}` : '';
		this.path = path.resolve(options.cwd, `${options.configName || 'config'}${fileExtension}`);

		const fileStore = this.store;
		const store = Object.assign(this.createPlainObject(), options.defaults, fileStore);
		this._validate(store);

		try {
			assert.deepEqual(fileStore, store);
		} catch (_) {
			this.store = store;
		}

		if (options.watch) {
			this._watch();
		}

		if (options.migrations) {
			if (!options.projectVersion) {
				options.projectVersion = getPackageData().version;
			}

			if (!options.projectVersion) {
				throw new Error('Project version could not be inferred. Please specify the `projectVersion` option.');
			}

			this._migrate(options.migrations, options.projectVersion);
		}
	}

	_validate(data: unknown): boolean {
		if (!this._validator) {
			return false;
		}

		const valid = this._validator(data);
		if (valid) {
			return true;
		}

		if (!this._validator.errors) {
			return false;
		}

		const errors = this._validator.errors.reduce((error, {dataPath, message = ''}) =>
			error + ` \`${dataPath.slice(1)}\` ${message};`, '');
		throw new Error('Config schema violation:' + errors.slice(0, -1));
	}

	_ensureDirectory(): void {
		// TODO: Use `fs.mkdirSync` `recursive` option when targeting Node.js 12.
		// Ensure the directory exists as it could have been deleted in the meantime.
		makeDir.sync(path.dirname(this.path));
	}

	_write(value: {[key: string]: T}): void {
		let data: string | Buffer = this.serialize(value);

		if (this.encryptionKey) {
			const initializationVector = crypto.randomBytes(16);
			const password = crypto.pbkdf2Sync(this.encryptionKey, initializationVector.toString(), 10000, 32, 'sha512');
			const cipher = crypto.createCipheriv(encryptionAlgorithm, password, initializationVector);
			data = Buffer.concat([initializationVector, Buffer.from(':'), cipher.update(Buffer.from(data)), cipher.final()]);
		}

		// Temporary workaround for Conf being packaged in a Ubuntu Snap app.
		// See https://github.com/sindresorhus/conf/pull/82
		if (process.env.SNAP) {
			fs.writeFileSync(this.path, data);
		} else {
			writeFileAtomic.sync(this.path, data);
		}
	}

	_watch(): void {
		this._ensureDirectory();

		if (!fs.existsSync(this.path)) {
			this._write({});
		}

		fs.watch(this.path, {persistent: false}, debounceFn(() => {
			// On Linux and Windows, writing to the config file emits a `rename` event, so we skip checking the event type.
			this.events?.emit('change');
		}, {wait: 100}));
	}

	_migrate(migrations: Migrations, versionToMigrate: string): void {
		let previousMigratedVersion: string = this._get(MIGRATION_KEY, '0.0.0') as string;

		const newerVersions: string[] = Object.keys(migrations)
			.filter(candidateVersion => this._shouldPerformMigration(candidateVersion, previousMigratedVersion, versionToMigrate));

		let storeBackup = {...this.store};

		for (const version of newerVersions) {
			try {
				const migration = migrations[version];
				migration(this);

				this._set(MIGRATION_KEY, version);

				previousMigratedVersion = version;
				storeBackup = {...this.store};
			} catch (error) {
				this.store = storeBackup;

				throw new Error(
					`Something went wrong during the migration! Changes applied to the store until this failed migration will be restored. ${error as string}`
				);
			}
		}

		if (this._isVersionInRangeFormat(previousMigratedVersion) || !semver.eq(previousMigratedVersion, versionToMigrate)) {
			this._set(MIGRATION_KEY, versionToMigrate);
		}
	}

	_containsReservedKey(key: string | {[key: string]: unknown}): boolean {
		if (typeof key === 'object') {
			const firstKey = Object.keys(key)[0];

			if (firstKey === INTERNAL_KEY) {
				return true;
			}
		}

		if (typeof key !== 'string') {
			return false;
		}

		if (this._options.accessPropertiesByDotNotation) {
			if (key.startsWith(`${INTERNAL_KEY}.`)) {
				return true;
			}

			return false;
		}

		return false;
	}

	_isVersionInRangeFormat(version: string): boolean {
		return semver.clean(version) === null;
	}

	_shouldPerformMigration(candidateVersion: string, previousMigratedVersion: string, versionToMigrate: string): boolean {
		if (this._isVersionInRangeFormat(candidateVersion)) {
			if (previousMigratedVersion !== '0.0.0' && semver.satisfies(previousMigratedVersion, candidateVersion)) {
				return false;
			}

			return semver.satisfies(versionToMigrate, candidateVersion);
		}

		if (semver.lte(candidateVersion, previousMigratedVersion)) {
			return false;
		}

		if (semver.gt(candidateVersion, versionToMigrate)) {
			return false;
		}

		return true;
	}

	_get(key: string, defaultValue?: unknown): unknown {
		return dotProp.get(this.store, key, defaultValue);
	}

	_set(key: string, value?: unknown): void {
		const {store} = this;
		dotProp.set(store, key, value);

		this.store = store;
	}

	/**
	Get an item.

	@param key - The key of the item to get.
	@param defaultValue - The default value if the item does not exist.
	*/
	get(key: string, defaultValue?: unknown): unknown {
		if (this._options.accessPropertiesByDotNotation) {
			return dotProp.get(this.store, key, defaultValue);
		}

		return key in this.store ? this.store[key] : defaultValue;
	}

	/**
	Set an item.

	@param key - You can use [dot-notation](https://github.com/sindresorhus/dot-prop) in a key to access nested properties.
	@param value - Must be JSON serializable. Trying to set the type `undefined`, `function`, or `symbol` will result in a `TypeError`.
	*/
	set(key: string | {[key: string]: T}, value?: T): void {
		if (typeof key !== 'string' && typeof key !== 'object') {
			throw new TypeError(`Expected \`key\` to be of type \`string\` or \`object\`, got ${typeof key}`);
		}

		if (typeof key !== 'object' && value === undefined) {
			throw new TypeError('Use `delete()` to clear values');
		}

		if (this._containsReservedKey(key)) {
			throw new TypeError(`Please don't use the ${INTERNAL_KEY} key, as it's used to manage this module internal operations.`);
		}

		const {store} = this;

		const set = (key: string, value: T): void => {
			checkValueType(key, value);
			if (this._options.accessPropertiesByDotNotation) {
				dotProp.set(store, key, value);
			} else {
				store[key] = value;
			}
		};

		if (typeof key === 'object') {
			const object = key;
			for (const [key, value] of Object.entries(object)) {
				set(key, value);
			}
		} else {
			set(key, value as T);
		}

		this.store = store;
	}

	/**
	Check if an item exists.

	@param key - The key of the item to check.
	*/
	has(key: string): boolean {
		if (this._options.accessPropertiesByDotNotation) {
			return dotProp.has(this.store, key);
		}

		return key in this.store;
	}

	/**
	Reset items to their default values, as defined by the `defaults` or `schema` option.

	@param keys - The keys of the items to reset.
	*/
	reset(...keys: string[]): void {
		for (const key of keys) {
			if (this._defaultValues[key]) {
				this.set(key, this._defaultValues[key]);
			}
		}
	}

	/**
	Delete an item.

	@param key - The key of the item to delete.
	*/
	delete(key: string): void {
		const {store} = this;
		if (this._options.accessPropertiesByDotNotation) {
			dotProp.delete(store, key);
		} else {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete store[key];
		}

		this.store = store;
	}

	/**
	Delete all items.
	*/
	clear(): void{
		this.store = this.createPlainObject();
	}

	/**
	Watches the given `key`, calling `callback` on any changes.

	@param key - The key wo watch.
	@param callback - A callback function that is called on any changes. When a `key` is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.
	*/
	onDidChange(key: string, callback: (...args: unknown[]) => void): () => unknown {
		if (typeof key !== 'string') {
			throw new TypeError(`Expected \`key\` to be of type \`string\`, got ${typeof key}`);
		}

		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		const getter: () => unknown = () => this.get(key);

		return this.handleChange(getter, callback);
	}

	/**
	Watches the whole config object, calling `callback` on any changes.

	@param callback - A callback function that is called on any changes. When a `key` is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.
	*/
	onDidAnyChange(callback: (newValue: unknown, oldValue: unknown) => void): () => unknown {
		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		const getter: () => unknown = () => this.store;

		return this.handleChange(getter, callback);
	}

	handleChange(getter: () => unknown, callback: (newValue: unknown, oldValue: unknown) => void): () => unknown {
		let currentValue = getter();

		const onChange: () => unknown = () => {
			const oldValue = currentValue;
			const newValue = getter();

			try {
				// TODO: Use `util.isdeepEqual` when targeting Node.js 10
				assert.deepEqual(newValue, oldValue);
			} catch (_) {
				currentValue = newValue;
				callback.call(this, newValue, oldValue);
			}
		};

		this.events?.on('change', onChange);
		return () => this.events?.removeListener('change', onChange);
	}

	encryptData(data: string | Buffer): string | Buffer {
		if (!this.encryptionKey) {
			return data;
		}

		try {
			// Check if an initialization vector has been used to encrypt the data
			if (data.slice(16, 17).toString() === ':') {
				const initializationVector = data.slice(0, 16);
				const password = crypto.pbkdf2Sync(this.encryptionKey, initializationVector.toString(), 10000, 32, 'sha512');
				const decipher = crypto.createDecipheriv(encryptionAlgorithm, password, initializationVector);
				const slicedData: any = data.slice(17);
				return Buffer.concat([decipher.update(slicedData), decipher.final()]);
			}

			// Legacy decryption without initialization vector
			const decipher = crypto.createDecipher(encryptionAlgorithm, this.encryptionKey);
			const legacyData: any = data;
			return Buffer.concat([decipher.update(legacyData), decipher.final()]);
		} catch (_) {
			return data;
		}
	}

	createPlainObject(): {[key: string]: T} {
		return Object.create(null);
	}

	get size(): number {
		return Object.keys(this.store).length;
	}

	get store(): {[key: string]: T} {
		try {
			const data: string | Buffer = fs.readFileSync(this.path, this.encryptionKey ? null : 'utf8');
			const dataString = this.encryptData(data) as string;
			const deserializedData = this.deserialize && this.deserialize(dataString);
			this._validate(deserializedData);
			return Object.assign(this.createPlainObject(), deserializedData);
		} catch (error) {
			if (error.code === 'ENOENT') {
				this._ensureDirectory();
				return this.createPlainObject();
			}

			if (this._options.clearInvalidConfig && error.name === 'SyntaxError') {
				return this.createPlainObject();
			}

			throw error;
		}
	}

	set store(value: {[key: string]: T}) {
		this._ensureDirectory();

		this._validate(value);
		this._write(value);

		this.events?.emit('change');
	}

	* [Symbol.iterator](): IterableIterator<[string, T]> {
		for (const [key, value] of Object.entries(this.store)) {
			yield [key, value];
		}
	}
}

export type Migrations = {
	[key: string]: (store: unknown) => void;
};

export type Schema = object | boolean;

export interface Options<T> {
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
	accessPropertiesByDotNotation?: boolean;

	/**
		The config is cleared if reading the config file causes a `SyntaxError`. This is a good default, as the config file is not intended to be hand-edited, so it usually means the config is corrupt and there's nothing the user can do about it anyway. However, if you let the user edit the config file directly, mistakes might happen and it could be more useful to throw an error when the config is invalid instead of clearing. Disabling this option will make it throw a `SyntaxError` on invalid config instead of clearing.

		@default true
	*/
	clearInvalidConfig?: boolean;

	/**
		Name of the config file (without extension).

		Useful if you need multiple config files for your app or module. For example, different config files between two major versions.

		@default 'config'
	*/
	configName: string;

	/**
		__You most likely don't need this. Please don't use it unless you really have to.__

		The only use-case I can think of is having the config located in the app directory or on some external storage. Default: System default user [config directory](https://github.com/sindresorhus/env-paths#pathsconfig).
	*/
	cwd?: string;

	/**
		Config used if there are no existing config.
		** Note: The values in `defaults` will overwrite the `default` key in the `schema` option.
	*/
	defaults?: Readonly<object>;

	/**
		Note that this is __not intended for security purposes__, since the encryption key would be easily found inside a plain-text Node.js app.

		Its main use is for obscurity. If a user looks through the config directory and finds the config file, since it's just a JSON file, they may be tempted to modify it. By providing an encryption key, the file will be obfuscated, which should hopefully deter any users from doing so.

		It also has the added bonus of ensuring the config file's integrity. If the file is changed in any way, the decryption will not work, in which case the store will just reset back to its default state.

		When specified, the store will be encrypted using the [`aes-256-cbc`](https://en.wikipedia.org/wiki/Block_cipher_mode_of_operation) encryption algorithm.
	*/
	encryptionKey?: string;

	/**
		Extension of the config file.

		You would usually not need this, but could be useful if you want to interact with a file with a custom file extension that can be associated with your app. These might be simple save/export/preference files that are intended to be shareable or saved outside of the app.

		@default 'json'
	*/
	fileExtension?: string;

	/*
		_Don't use this feature until [this issue](https://github.com/sindresorhus/conf/issues/92) has been fixed._

		You can use migrations to perform operations to the store whenever a version is changed.

		The `migrations` object should consist of a key-value pair of `'version': handler`. The `version` can also be a [semver range](https://github.com/npm/node-semver#ranges).

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
	migrations?: Migrations;

	/**
		You only need to specify this if you don't have a package.json file in your project or if it doesn't have a name defined within it.

		Default: The name field in the `package.json` closest to where `conf` is imported.
	*/
	projectName?: string;

	/**
		__You most likely don't need this. Please don't use it unless you really have to.__

		Suffix appended to `projectName` during config file creation to avoid name conflicts with native apps.

		You can pass an empty string to remove the suffix.

		For example, on macOS, the config file will be stored in the `~/Library/Preferences/foo-nodejs` directory, where `foo` is the `projectName`.

		@default 'nodejs'
	*/
	projectSuffix?: string;

	/**
		You only need to specify this if you don't have a package.json file in your project or if it doesn't have a version defined within it.

		Default: The name field in the `package.json` closest to where `conf` is imported.
	*/
	projectVersion?: string;

	/**
		* [JSON Schema](https://json-schema.org) to validate your config data.
		* Under the hood, the JSON Schema validator [ajv](https://github.com/epoberezkin/ajv) is used to validate your config. We use [JSON Schema draft-07](http://json-schema.org/latest/json-schema-validation.html) and support all [validation keywords](https://github.com/epoberezkin/ajv/blob/master/KEYWORDS.md) and [formats](https://github.com/epoberezkin/ajv#formats)
		* You should define your schema as an object where each key is the name of your data's property and each value is a JSON schema used to validate that property. See more [here](https://json-schema.org/understanding-json-schema/reference/object.html#properties)

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
		** Note: The `default` value will be overwritten by the `defaults` option if set.
	*/
	schema?: Schema;

	/**
		Watch for any changes in the config file and call the callback for `onDidChange` if set. This is useful if there are multiple processes changing the same config file.

		__Currently this option doesn't work on Node.js 8 on macOS.__

		@default false
	*/
	watch?: boolean;

	/**
		Function to serialize the config object to a UTF-8 string when writing the config file.

		You would usually not need this, but it could be useful if you want to use a format other than JSON.

		@default value => JSON.stringify(value, null, '\t')
	*/
	serialize?: (value: {[key: string]: T}) => string;

	/**
		Function to deserialize the config object from a UTF-8 string when reading the config file.

		You would usually not need this, but it could be useful if you want to use a format other than JSON.

		@default JSON.parse
	*/
	deserialize?: (text: string) => T;
}
