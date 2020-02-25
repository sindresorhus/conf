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
import {Deserialize, Migrations, OnDidChangeCallback, Options, Serialize, Unsubscribe, Schema, OnDidAnyChangeCallback} from './types';
import {JSONSchema} from 'json-schema-typed';

const encryptionAlgorithm = 'aes-256-cbc';

const createPlainObject = <T = unknown>(): T => {
	return Object.create(null);
};

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

export class Conf<T extends { [key: string]: any } = any> implements Iterable<[keyof T, T[keyof T]]> {
	readonly path: string;
	readonly events: EventEmitter;
	readonly #validator?: Ajv.ValidateFunction;
	readonly #encryptionKey?: string | Buffer | NodeJS.TypedArray | DataView;
	readonly #options: Readonly<Partial<Options<T>>>;
	readonly #defaultValues: Partial<T> = {};

	constructor(partialOptions: Readonly<Partial<Options<T>>> = {}) {
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

			return packageData ?? {};
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

		this.#options = options;

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

			const schema: JSONSchema = {
				type: 'object',
				properties: options.schema
			};

			this.#validator = ajv.compile(schema);

			for (const [key, value] of Object.entries<JSONSchema>(options.schema)) {
				if (value?.default) {
					this.#defaultValues[key as keyof T] = value.default;
				}
			}
		}

		if (options.defaults) {
			this.#defaultValues = {
				...this.#defaultValues,
				...options.defaults
			};
		}

		if (options.serialize) {
			this._serialize = options.serialize;
		}

		if (options.deserialize) {
			this._deserialize = options.deserialize;
		}

		this.events = new EventEmitter();
		this.#encryptionKey = options.encryptionKey;

		const fileExtension = options.fileExtension ? `.${options.fileExtension}` : '';
		this.path = path.resolve(options.cwd, `${options.configName ?? 'config'}${fileExtension}`);

		const fileStore = this.store;
		const store = Object.assign(createPlainObject<T>(), options.defaults, fileStore);
		this._validate(store);

		try {
			assert.deepEqual(fileStore, store);
		} catch {
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

	/**
    Get an item.

	@param key - The key of the item to get.
	@param defaultValue - The default value if the item does not exist.
	*/
	get<Key extends keyof T>(key: Key | string): T[Key] | undefined;
	get<Key extends keyof T, Default = unknown>(key: Key | string, defaultValue?: Default): T[Key] | Default;
	get<Key extends keyof T, Default = unknown>(key: Key | string, defaultValue?: Default): T[Key] | Default | undefined {
		if (this.#options.accessPropertiesByDotNotation) {
			return this._get(key, defaultValue);
		}

		return key in this.store ? this.store[key] : defaultValue;
	}

	/**
    Set an item or multiple items at once.

	@param {key|object} - You can use [dot-notation](https://github.com/sindresorhus/dot-prop) in a key to access nested properties. Or a hashmap of items to set at once.
	@param value - Must be JSON serializable. Trying to set the type `undefined`, `function`, or `symbol` will result in a `TypeError`.
    */
	set<Key extends keyof T>(key: Key | string, value: T[Key] | unknown): void;
	set(object: Partial<T>): void;
	set<Key extends keyof T>(key: Partial<T> | Key | string, value?: T[Key] | unknown): void {
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

		const set = (key: string, value?: T[Key] | T | unknown): void => {
			checkValueType(key, value);
			if (this.#options.accessPropertiesByDotNotation) {
				dotProp.set(store, key, value);
			} else {
				store[key as Key] = value as T[Key];
			}
		};

		if (typeof key === 'object') {
			const object = key;
			for (const [key, value] of Object.entries(object)) {
				set(key, value);
			}
		} else {
			set(key, value);
		}

		this.store = store;
	}

	/**
	Check if an item exists.

	@param key - The key of the item to check.
	*/
	has<Key extends keyof T>(key: Key | string): boolean {
		if (this.#options.accessPropertiesByDotNotation) {
			return dotProp.has(this.store, key as string);
		}

		return key in this.store;
	}

	/**
	Reset items to their default values, as defined by the `defaults` or `schema` option.

	@param keys - The keys of the items to reset.
	*/
	reset<Key extends keyof T>(...keys: Key[]): void {
		for (const key of keys) {
			if (this.#defaultValues[key]) {
				this.set(key, this.#defaultValues[key]);
			}
		}
	}

	/**
	Delete an item.

	@param key - The key of the item to delete.
	*/
	delete<Key extends keyof T>(key: Key): void {
		const {store} = this;
		if (this.#options.accessPropertiesByDotNotation) {
			dotProp.delete(store, key as string);
		} else {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete store[key];
		}

		this.store = store;
	}

	/**
	Delete all items.
	*/
	clear(): void {
		this.store = createPlainObject();
	}

	/**
    Watches the given `key`, calling `callback` on any changes.

	@param key - The key wo watch.
	@param callback - A callback function that is called on any changes. When a `key` is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.
	@returns A function, that when called, will unsubscribe.
	*/
	onDidChange<Key extends keyof T>(
		key: Key,
		callback: OnDidChangeCallback<T[Key]>
	): Unsubscribe {
		if (typeof key !== 'string') {
			throw new TypeError(`Expected \`key\` to be of type \`string\`, got ${typeof key}`);
		}

		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		return this._handleChange(() => this.get(key), callback);
	}

	/**
    Watches the whole config object, calling `callback` on any changes.

	@param callback - A callback function that is called on any changes. When a `key` is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.
	@returns A function, that when called, will unsubscribe.
	*/
	onDidAnyChange(
		callback: OnDidAnyChangeCallback<T>
	): Unsubscribe {
		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		return this._handleChange(() => this.store, callback);
	}

	get size(): number {
		return Object.keys(this.store).length;
	}

	get store(): T {
		try {
			const data = fs.readFileSync(this.path, this.#encryptionKey ? null : 'utf8');
			const dataString = this._encryptData(data);
			const deserializedData = this._deserialize(dataString);
			this._validate(deserializedData);
			return Object.assign(createPlainObject(), deserializedData) as T;
		} catch (error) {
			if (error.code === 'ENOENT') {
				this._ensureDirectory();
				return createPlainObject();
			}

			if (this.#options.clearInvalidConfig && error.name === 'SyntaxError') {
				return createPlainObject();
			}

			throw error;
		}
	}

	set store(value: T) {
		this._ensureDirectory();

		this._validate(value);
		this._write(value);

		this.events.emit('change');
	}

	* [Symbol.iterator](): IterableIterator<[keyof T, T[keyof T]]> {
		for (const [key, value] of Object.entries(this.store)) {
			yield [key, value];
		}
	}

	private _encryptData(data: string | Buffer): string {
		if (!this.#encryptionKey) {
			return data.toString();
		}

		try {
			// Check if an initialization vector has been used to encrypt the data
			if (this.#encryptionKey) {
				try {
					if (data.slice(16, 17).toString() === ':') {
						const initializationVector = data.slice(0, 16);
						const password = crypto.pbkdf2Sync(this.#encryptionKey, initializationVector.toString(), 10000, 32, 'sha512');
						const decipher = crypto.createDecipheriv(encryptionAlgorithm, password, initializationVector);
						data = Buffer.concat([decipher.update(Buffer.from(data.slice(17))), decipher.final()]).toString('utf8');
					} else {
						const decipher = crypto.createDecipher(encryptionAlgorithm, this.#encryptionKey);
						data = Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]).toString('utf8');
					}
				} catch (_) { }
			}
		} catch {
		}

		return data.toString();
	}

	private _handleChange<Key extends keyof T>(
		getter: () => T | T[Key] | undefined,
		callback: OnDidAnyChangeCallback<any> | OnDidChangeCallback<any>
	): Unsubscribe {
		let currentValue = getter();

		const onChange = (): void => {
			const oldValue = currentValue;
			const newValue = getter();

			try {
				// TODO: Use `util.isDeepStrictEqual` when targeting Node.js 10
				assert.deepEqual(newValue, oldValue);
			} catch {
				currentValue = newValue;
				callback.call(this, newValue, oldValue);
			}
		};

		this.events.on('change', onChange);
		return () => this.events.removeListener('change', onChange);
	}

	private readonly _deserialize: Deserialize<T> = value => JSON.parse(value);
	private readonly _serialize: Serialize<T> = value => JSON.stringify(value, null, '\t');

	private _validate(data: T | unknown): void {
		if (!this.#validator) {
			return;
		}

		const valid = this.#validator(data);
		if (valid || !this.#validator.errors) {
			return;
		}

		const errors = this.#validator.errors.reduce((error, {dataPath, message = ''}) =>
			error + ` \`${dataPath.slice(1)}\` ${message};`, '');
		throw new Error('Config schema violation:' + errors.slice(0, -1));
	}

	private _ensureDirectory(): void {
		// TODO: Use `fs.mkdirSync` `recursive` option when targeting Node.js 12.
		// Ensure the directory exists as it could have been deleted in the meantime.
		makeDir.sync(path.dirname(this.path));
	}

	private _write(value: T): void {
		let data: string | Buffer = this._serialize(value);

		if (this.#encryptionKey) {
			const initializationVector = crypto.randomBytes(16);
			const password = crypto.pbkdf2Sync(this.#encryptionKey, initializationVector.toString(), 10000, 32, 'sha512');
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

	private _watch(): void {
		this._ensureDirectory();

		if (!fs.existsSync(this.path)) {
			this._write(createPlainObject<T>());
		}

		fs.watch(this.path, {persistent: false}, debounceFn(() => {
			// On Linux and Windows, writing to the config file emits a `rename` event, so we skip checking the event type.
			this.events.emit('change');
		}, {wait: 100}));
	}

	private _migrate(migrations: Migrations<T>, versionToMigrate: string): void {
		let previousMigratedVersion = this._get(MIGRATION_KEY, '0.0.0');

		const newerVersions = Object.keys(migrations)
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

	private _containsReservedKey(key: string | Partial<T>): boolean {
		if (typeof key === 'object') {
			const firsKey = Object.keys(key)[0];

			if (firsKey === INTERNAL_KEY) {
				return true;
			}
		}

		if (typeof key !== 'string') {
			return false;
		}

		if (this.#options.accessPropertiesByDotNotation) {
			if (key.startsWith(`${INTERNAL_KEY}.`)) {
				return true;
			}

			return false;
		}

		return false;
	}

	private _isVersionInRangeFormat(version: string): boolean {
		return semver.clean(version) === null;
	}

	private _shouldPerformMigration(candidateVersion: string, previousMigratedVersion: string, versionToMigrate: string): boolean {
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

	private _get<Key extends keyof T>(key: Key): T[Key] | undefined;
	private _get<Key extends keyof T, Default = unknown>(key: Key, defaultValue?: Default): T[Key]| Default;
	private _get<Key extends keyof T, Default = unknown>(key: Key, defaultValue?: Default): T[Key] | Default | undefined {
		return dotProp.get<T[Key] | Default | undefined>(this.store, key as string, defaultValue);
	}

	private _set(key: string, value: unknown): void {
		const {store} = this;
		dotProp.set(store, key, value);

		this.store = store;
	}
}

export {Schema};

export default Conf;

// For CommonJS default export support
module.exports = Conf;
module.exports.default = Conf;
