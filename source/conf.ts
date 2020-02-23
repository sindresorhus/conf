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
import {JSONSchema} from 'json-schema-typed';
import {Deserialize, Migrations, OnDidChangeCallback, Options, Serialize} from './types';

const encryptionAlgorithm = 'aes-256-cbc';

const createPlainObject = <T = any>(): T => {
	return Object.create(null);
};

// Prevent caching of this module so module.parent is always accurate
delete require.cache[__filename];
const parentDir = path.dirname((module.parent && module.parent.filename) || '.');

const checkValueType = <TKey = any>(key: string, value: TKey): void => {
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

export class Conf<T extends any = {} | any> implements Iterable<[keyof T, T[keyof T]]> {
	readonly path: string;
	readonly _events: EventEmitter;
	private readonly _validator?: Ajv.ValidateFunction;
	private readonly _encryptionKey?: string | Buffer | NodeJS.TypedArray | DataView;
	private readonly _options: Partial<Options<T>>;
	private readonly _defaultValues: any = {};

	constructor(partialOptions: Partial<Options<T>> = {}) {
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

			const schema: JSONSchema = {
				type: 'object',
				properties: options.schema
			};

			this._validator = ajv.compile(schema);

			for (const [key, value] of Object.entries<JSONSchema>(options.schema)) {
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

		if (options.serialize) {
			this._serialize = options.serialize;
		}

		if (options.deserialize) {
			this._deserialize = options.deserialize;
		}

		this._events = new EventEmitter();
		this._encryptionKey = options.encryptionKey;

		const fileExtension = options.fileExtension ? `.${options.fileExtension}` : '';
		this.path = path.resolve(options.cwd, `${options.configName || 'config'}${fileExtension}`);

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
	get<TKey extends keyof T>(key: TKey | string, defaultValue?: T[TKey] | any): T[TKey] | undefined {
		if (this._options.accessPropertiesByDotNotation) {
			return this._get(key, defaultValue);
		}

		return key in this.store ? this.store[key] : defaultValue;
	}

	set<TKey extends keyof T>(key: Partial<T> | TKey | string, value?: T[TKey] | any): void {
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

		const set = (key: string, value?: T[TKey] | T): void => {
			checkValueType(key, value);
			if (this._options.accessPropertiesByDotNotation) {
				dotProp.set(store, key, value);
			} else {
				store[key] = value as T;
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
	has<Tkey extends keyof T>(key: Tkey | string): boolean {
		if (this._options.accessPropertiesByDotNotation) {
			return dotProp.has(this.store, key as string);
		}

		return key in this.store;
	}

	/**
	Reset items to their default values, as defined by the `defaults` or `schema` option.

	@param keys - The keys of the items to reset.
	*/
	reset<TKey extends keyof T>(...keys: Array<TKey | string>): void {
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
	delete<TKey extends keyof T>(key: TKey): void {
		const {store} = this;
		if (this._options.accessPropertiesByDotNotation) {
			dotProp.delete(store, key as string);
		} else {
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
	*/
	onDidChange<TKey extends keyof T>(
		key: TKey,
		callback: OnDidChangeCallback<T[TKey]>
	): () => void {
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
	*/
	onDidAnyChange(
		callback: OnDidChangeCallback<T>
	): () => void {
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
			const data = fs.readFileSync(this.path, this._encryptionKey ? null : 'utf8');
			const dataString = this._encryptData(data);
			const deserializedData = this._deserialize(dataString);
			this._validate(deserializedData);
			return Object.assign(createPlainObject(), deserializedData);
		} catch (error) {
			if (error.code === 'ENOENT') {
				this._ensureDirectory();
				return createPlainObject();
			}

			if (this._options.clearInvalidConfig && error.name === 'SyntaxError') {
				return createPlainObject();
			}

			throw error;
		}
	}

	set store(value: T) {
		this._ensureDirectory();

		this._validate(value);
		this._write(value);

		this._events.emit('change');
	}

	* [Symbol.iterator](): Iterator<[keyof T, T[keyof T]]> {
		for (const [key, value] of Object.entries(this.store)) {
			yield [key, value];
		}
	}

	private _encryptData(data: string | Buffer): string {
		if (!this._encryptionKey) {
			return data.toString();
		}

		try {
			// Check if an initialization vector has been used to encrypt the data
			if (this._encryptionKey) {
				try {
					if (data.slice(16, 17).toString() === ':') {
						const initializationVector = data.slice(0, 16);
						const password = crypto.pbkdf2Sync(this._encryptionKey, initializationVector.toString(), 10000, 32, 'sha512');
						const decipher = crypto.createDecipheriv(encryptionAlgorithm, password, initializationVector);
						data = Buffer.concat([decipher.update(Buffer.from(data.slice(17))), decipher.final()]).toString('utf8');
					} else {
						const decipher = crypto.createDecipher(encryptionAlgorithm, this._encryptionKey);
						data = Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]).toString('utf8');
					}
				} catch (_) { }
			}
		} catch {
		}

		return data.toString();
	}

	private _handleChange<TKey extends keyof T>(
		getter: () => T | T[TKey] | undefined,
		callback: OnDidChangeCallback<any>
	): () => EventEmitter {
		let currentValue = getter();

		const onChange = (): void => {
			const oldValue = currentValue;
			const newValue = getter();

			try {
				// TODO: Use `util.isDeepStrictEqual` when targeting Node.js 10
				assert.deepEqual(newValue, oldValue);
			} catch (_) {
				currentValue = newValue;
				callback.call(this, newValue, oldValue);
			}
		};

		this._events.on('change', onChange);
		return () => this._events.removeListener('change', onChange);
	}

	private readonly _deserialize: Deserialize<T> = value => JSON.parse(value);
	private readonly _serialize: Serialize<T> = value => JSON.stringify(value, null, '\t');

	private _validate(data: T): void {
		if (!this._validator) {
			return;
		}

		const valid = this._validator(data);
		if (valid || !this._validator.errors) {
			return;
		}

		const errors = this._validator.errors.reduce((error, {dataPath, message = ''}) =>
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

		if (this._encryptionKey) {
			const initializationVector = crypto.randomBytes(16);
			const password = crypto.pbkdf2Sync(this._encryptionKey, initializationVector.toString(), 10000, 32, 'sha512');
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
			this._events.emit('change');
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

	private _get<TKey extends keyof T>(key: TKey, defaultValue?: T[TKey] | string): T[TKey] {
		return dotProp.get<T[TKey]>(this.store, key as string, defaultValue);
	}

	private _set(key: string, value: any): void {
		const {store} = this;
		dotProp.set(store, key, value);

		this.store = store;
	}
}

export default Conf;
