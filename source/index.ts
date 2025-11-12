/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-return */
import {isDeepStrictEqual} from 'node:util';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {
	getProperty,
	hasProperty,
	setProperty,
	deleteProperty,
} from 'dot-prop';
import envPaths from 'env-paths';
import {writeFileSync as atomicWriteFileSync} from 'atomically';
import {Ajv2020 as Ajv, type ValidateFunction as AjvValidateFunction} from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';
import debounceFn from 'debounce-fn';
import semver from 'semver';
import {type JSONSchema} from 'json-schema-typed';
import {
	concatUint8Arrays,
	stringToUint8Array,
	uint8ArrayToString,
} from 'uint8array-extras';
import {
	type Deserialize,
	type Migrations,
	type OnDidChangeCallback,
	type Options,
	type Serialize,
	type Unsubscribe,
	type OnDidAnyChangeCallback,
	type BeforeEachMigrationCallback,
	type DotNotationKeyOf,
	type DotNotationValueOf,
	type PartialObjectDeep,
	type Schema,
} from './types.js';

const encryptionAlgorithm = 'aes-256-cbc';

const createPlainObject = <T = Record<string, unknown>>(): T => Object.create(null);

// Minimal wrapper: clone and assign to null-prototype object
const cloneWithNullProto = <T>(value: T): T =>
	Object.assign(createPlainObject(), structuredClone(value));

const isExist = <T = unknown>(data: T): boolean => data !== undefined;

const checkValueType = (key: string, value: unknown): void => {
	const nonJsonTypes = new Set([
		'undefined',
		'symbol',
		'function',
	]);

	const type = typeof value;

	if (nonJsonTypes.has(type)) {
		throw new TypeError(`Setting a value of type \`${type}\` for key \`${key}\` is not allowed as it's not supported by JSON`);
	}
};

const INTERNAL_KEY = '__internal__';
const MIGRATION_KEY = `${INTERNAL_KEY}.migrations.version`;

export default class Conf<T extends Record<string, any> = Record<string, unknown>> implements Iterable<[keyof T, T[keyof T]]> {
	readonly path: string;
	readonly events: EventTarget;
	#validator?: AjvValidateFunction;
	readonly #encryptionKey?: string | Uint8Array | NodeJS.TypedArray | DataView;
	readonly #options: Readonly<Partial<Options<T>>>;
	readonly #defaultValues: Partial<T> = createPlainObject();
	#isInMigration = false;
	#watcher?: fs.FSWatcher;
	#watchFile?: boolean;
	#debouncedChangeHandler?: () => void;

	#cache?: T;
	#writePending = false;
	#writeTimer?: NodeJS.Timeout;
	#ignoreChangeEvents = false;

	ignoreChangeEvents = false;

	constructor(partialOptions: Readonly<Partial<Options<T>>> = {}) {
		const options = this.#prepareOptions(partialOptions);
		this.#options = options;
		this.#setupValidator(options);
		this.#applyDefaultValues(options);
		this.#configureSerialization(options);
		this.events = new EventTarget();
		this.#encryptionKey = options.encryptionKey;
		this.path = this.#resolvePath(options);
		this.#initializeStore(options);

		if (options.watch) {
			this._watch();
		}
	}

	clearCache(): void {
		if (this.#writePending) {
			return;
		}

		this.#cache &&= undefined;
		this._read();
	}

	/**
	Get an item.

	@param key - The key of the item to get.
	@param defaultValue - The default value if the item does not exist.

	Tip: To get all items, see `.store`.
	*/
	get<Key extends keyof T>(key: Key): T[Key];
	get<Key extends keyof T>(key: Key, defaultValue: Required<T>[Key]): Required<T>[Key];
	get<Key extends DotNotationKeyOf<T>>(key: Key): DotNotationValueOf<T, Key>;
	get<Key extends DotNotationKeyOf<T>>(key: Key, defaultValue: NonNullable<DotNotationValueOf<T, Key>>): NonNullable<DotNotationValueOf<T, Key>>;
	// This overload is used for dot-notation access.
	// We exclude `keyof T` and `DotNotationKeyOf<T>` as an incorrect type for the default value should not fall through to this overload.
	get<Key extends string, Value = unknown>(key: Exclude<Key, DotNotationKeyOf<T>>, defaultValue?: Value): Value;
	get(key: string, defaultValue?: unknown): unknown {
		if (this.#options.accessPropertiesByDotNotation) {
			return this._get(key, defaultValue);
		}

		const {store} = this;
		return key in store ? store[key] : defaultValue;
	}

	/**
	Set an item or multiple items at once.

	@param {key|object} - You can use [dot-notation](https://github.com/sindresorhus/dot-prop) in a key to access nested properties. Or a hashmap of items to set at once.
	@param value - Must be JSON serializable. Trying to set the type `undefined`, `function`, or `symbol` will result in a `TypeError`.
	*/
	set<Key extends keyof T>(key: Key, value?: T[Key]): void;
	set<Key extends DotNotationKeyOf<T>>(key: Key, Value?: DotNotationValueOf<T, Key>): void;
	// Fallback for dynamic dot-notation paths that can't be statically typed
	set(key: string, value: unknown): void;
	set(object: PartialObjectDeep<T>): void;
	set<Key extends keyof T>(key: PartialObjectDeep<T> | string, value?: unknown): void {
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
				setProperty(store, key, value);
			} else {
				if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
					return;
				}

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
	has<Key extends keyof T>(key: Key): boolean;
	has<Key extends DotNotationKeyOf<T>>(key: Key): boolean;
	has(key: string): boolean {
		if (this.#options.accessPropertiesByDotNotation) {
			return hasProperty(this.store, key);
		}

		return key in this.store;
	}

	/**
	Append an item to an array.

	If the key doesn't exist, it will be created as an array.
	If the key exists and is not an array, a `TypeError` will be thrown.

	@param key - The key of the array to append to. You can use [dot-notation](https://github.com/sindresorhus/dot-prop) to access nested properties.
	@param value - The item to append. Must be JSON serializable.

	@example
	```
	config.set('items', [{name: 'foo'}]);
	config.appendToArray('items', {name: 'bar'});
	console.log(config.get('items'));
	//=> [{name: 'foo'}, {name: 'bar'}]
	```
	*/
	appendToArray<Key extends keyof T>(key: Key, value: T[Key] extends ReadonlyArray<infer U> ? U : unknown): void;
	appendToArray<Key extends DotNotationKeyOf<T>>(key: Key, value: DotNotationValueOf<T, Key> extends ReadonlyArray<infer U> ? U : unknown): void;
	appendToArray(key: string, value: unknown): void {
		checkValueType(key, value);
		const array = this.#options.accessPropertiesByDotNotation
			? this._get(key, [])
			: (key in this.store ? this.store[key] as unknown : []);

		if (!Array.isArray(array)) {
			throw new TypeError(`The key \`${key}\` is already set to a non-array value`);
		}

		this.set(key, [...(array as unknown[]), value]);
	}

	/**
	Calls supplied mutation on the item and replaces it with its result.

	@param key - The key of the item to mutate.
	@param mutation - Function which returns new derived value
	@returns new value
	*/
	mutate<Key extends keyof T>(key: Key, mutation: (currentValue: T[Key]) => T[Key]): void;
	mutate<Key extends DotNotationKeyOf<T>>(key: Key, mutation: (currentValue: DotNotationValueOf<T, Key>) => DotNotationValueOf<T, Key>): void;
	mutate(key: string, mutation: unknown): void {
		if (typeof mutation !== 'function') {
			throw new TypeError(`Expected type of mutation to be of type \`function\`, is ${typeof mutation}`);
		}

		this.set(key, mutation.call(this, this.get(key)));
	}

	/**
	Merge an object into the item at `key`
	@throws {TypeError} when the current value at `key` or the `value` to merge is not an object.
	@param {key} - You can use [dot-notation](https://github.com/sindresorhus/dot-prop) in a key to access nested properties.
	@param value - Must be JSON serializable. Trying to set the type `undefined`, `function`, or `symbol` will result in a `TypeError`.
	*/
	merge<Key extends keyof T>(key: Key, value?: T[Key]): void;
	merge<Key extends DotNotationKeyOf<T>>(key: Key, Value?: DotNotationValueOf<T, Key>): void;
	// Fallback for dynamic dot-notation paths that can't be statically typed
	merge(key: string, value: unknown): void;
	merge<Key extends keyof T>(key: string, value?: unknown): void {
		const current = this.get(key);

		if (typeof current !== 'object' || current === null) {
			throw new TypeError(`Cannot merge into non-object value at key \`${String(key)}\``);
		}

		if (typeof value !== 'object' || value === null) {
			throw new TypeError(`Cannot merge non-object value into key \`${String(key)}\``);
		}

		this.set(key, cloneWithNullProto({...current, ...value}));
	}

	/**
	Reset items to their default values, as defined by the `defaults` or `schema` option.

	@see `clear()` to reset all items.

	@param keys - The keys of the items to reset.
	*/
	reset<Key extends keyof T>(...keys: Key[]): void {
		for (const key of keys) {
			if (isExist(this.#defaultValues[key])) {
				this.set(key, this.#defaultValues[key]);
			}
		}
	}

	/**
	Delete an item.

	@param key - The key of the item to delete.
	*/
	delete<Key extends keyof T>(key: Key): void;
	delete<Key extends DotNotationKeyOf<T>>(key: Key): void;
	delete(key: string): void {
		const {store} = this;
		if (this.#options.accessPropertiesByDotNotation) {
			deleteProperty(store, key);
		} else {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete store[key];
		}

		this.store = store;
	}

	/**
	Delete all items.

	This resets known items to their default values, if defined by the `defaults` or `schema` option.
	*/
	clear(): void {
		const newStore = createPlainObject<T>();

		for (const key of Object.keys(this.#defaultValues)) {
			if (isExist(this.#defaultValues[key])) {
				// No need to validate - defaults are already validated in #applyDefaultValues
				if (this.#options.accessPropertiesByDotNotation) {
					setProperty(newStore as Record<string, any>, key, this.#defaultValues[key]);
				} else {
					(newStore as any)[key] = this.#defaultValues[key];
				}
			}
		}

		this.store = newStore;
	}

	/**
	Watches the given `key`, calling `callback` on any changes.

	@param key - The key to watch.
	@param callback - A callback function that is called on any changes. When a `key` is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.
	@returns A function, that when called, will unsubscribe.
	*/
	onDidChange<Key extends keyof T>(key: Key, callback: OnDidChangeCallback<T[Key]>): Unsubscribe;
	onDidChange<Key extends DotNotationKeyOf<T>>(key: Key, callback: OnDidChangeCallback<DotNotationValueOf<T, Key>>): Unsubscribe;
	onDidChange<Key extends string>(key: Key, callback: OnDidChangeCallback<any>): Unsubscribe {
		if (typeof key !== 'string') {
			throw new TypeError(`Expected \`key\` to be of type \`string\`, got ${typeof key}`);
		}

		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		return this._handleValueChange(() => this.get(key), callback);
	}

	/**
	Watches the whole config object, calling `callback` on any changes.

	@param callback - A callback function that is called on any changes. When a `key` is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.
	@returns A function, that when called, will unsubscribe.
	*/
	onDidAnyChange(callback: OnDidAnyChangeCallback<T>): Unsubscribe {
		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		return this._handleStoreChange(callback);
	}

	get size(): number {
		const entries = Object.keys(this.store);
		return entries.filter(key => !this._isReservedKeyPath(key)).length;
	}

	/**
	Get all the config as an object or replace the current config with an object.

	@example
	```
	console.log(config.store);
	//=> {name: 'John', age: 30}
	```

	@example
	```
	config.store = {
		hello: 'world'
	};
	```
	*/
	get store(): T {
		if (!this.#cache) {
			this._read();
		}

		return cloneWithNullProto(this.#cache!);
	}

	set store(value: T) {
		this._ensureDirectory();

		// Preserve existing internal data if it exists and the new value doesn't contain it
		if (!hasProperty(value, INTERNAL_KEY)) {
			try {
				// Read directly from file to avoid recursion during migration
				const data = fs.readFileSync(this.path, this.#encryptionKey ? null : 'utf8');
				const dataString = this._decryptData(data);
				const currentStore = this._deserialize(dataString);
				if (hasProperty(currentStore, INTERNAL_KEY)) {
					setProperty(value, INTERNAL_KEY, getProperty(currentStore, INTERNAL_KEY));
				}
			} catch {
				// Silently ignore errors when trying to preserve internal data
				// This could happen if the file doesn't exist yet or is corrupted
				// In these cases, we just proceed without preserving internal data
			}
		}

		if (!this.#isInMigration) {
			this._validate(value);
		}

		this._write(value);
		this.triggerChangeEvent();
	}

	* [Symbol.iterator](): IterableIterator<[keyof T, T[keyof T]]> {
		for (const [key, value] of Object.entries(this.store)) {
			if (!this._isReservedKeyPath(key)) {
				yield [key, value];
			}
		}
	}

	async runWithoutChangeEvents(handler: () => void | Promise<void>): Promise<void> {
		try {
			this.#ignoreChangeEvents = true;
			await handler.call(this);
		} finally {
			this.#ignoreChangeEvents = this.ignoreChangeEvents;
			this.triggerChangeEvent();
		}
	}

	/**
	Close the file watcher if one exists. This is useful in tests to prevent the process from hanging.
	*/
	_closeWatcher(): void {
		if (this.#watcher) {
			this.#watcher.close();
			this.#watcher = undefined;
		}

		if (this.#watchFile) {
			fs.unwatchFile(this.path);
			this.#watchFile = false;
		}

		this.#debouncedChangeHandler = undefined;
	}

	triggerChangeEvent(): void {
		if (!this.#ignoreChangeEvents) {
			this.events.dispatchEvent(new Event('change'));
		}
	}

	private _decryptData(data: string | Uint8Array): string {
		if (!this.#encryptionKey) {
			return typeof data === 'string' ? data : uint8ArrayToString(data);
		}

		// Check if an initialization vector has been used to encrypt the data.
		try {
			const initializationVector = data.slice(0, 16);
			const password = crypto.pbkdf2Sync(this.#encryptionKey, initializationVector, 10_000, 32, 'sha512');
			const decipher = crypto.createDecipheriv(encryptionAlgorithm, password, initializationVector);
			const slice = data.slice(17);
			const dataUpdate = typeof slice === 'string' ? stringToUint8Array(slice) : slice;
			return uint8ArrayToString(concatUint8Arrays([decipher.update(dataUpdate), decipher.final()]));
		} catch {
			try {
				// Fallback to legacy scheme (iv.toString() as salt)
				const initializationVector = data.slice(0, 16);
				const password = crypto.pbkdf2Sync(this.#encryptionKey, initializationVector.toString(), 10_000, 32, 'sha512');
				const decipher = crypto.createDecipheriv(encryptionAlgorithm, password, initializationVector);
				const slice = data.slice(17);
				const dataUpdate = typeof slice === 'string' ? stringToUint8Array(slice) : slice;
				return uint8ArrayToString(concatUint8Arrays([decipher.update(dataUpdate), decipher.final()]));
			} catch {}
		}

		return typeof data === 'string' ? data : uint8ArrayToString(data);
	}

	private _handleStoreChange(callback: OnDidAnyChangeCallback<T>): Unsubscribe {
		let currentValue = this.store;

		const onChange = (): void => {
			const oldValue = currentValue;
			const newValue = this.store;

			if (isDeepStrictEqual(newValue, oldValue)) {
				return;
			}

			currentValue = newValue;
			callback.call(this, newValue, oldValue);
		};

		this.events.addEventListener('change', onChange);

		return () => {
			this.events.removeEventListener('change', onChange);
		};
	}

	private _handleValueChange<Value>(
		getter: () => Value | undefined,
		callback: OnDidChangeCallback<Value>,
	): Unsubscribe {
		let currentValue = getter();

		const onChange = (): void => {
			const oldValue = currentValue;
			const newValue = getter();

			if (isDeepStrictEqual(newValue, oldValue)) {
				return;
			}

			currentValue = newValue;
			callback.call(this, newValue, oldValue);
		};

		this.events.addEventListener('change', onChange);

		return () => {
			this.events.removeEventListener('change', onChange);
		};
	}

	private readonly _deserialize: Deserialize<T> = value => {
		const {deserialize, encryption} = this.#options;
		const data = encryption ? encryption.decrypt(Uint8Array.from(value)) : value;

		return deserialize ? deserialize(data) : JSON.parse(data);
	};

	private readonly _serialize: Serialize<T> = value => {
		const {serialize, encryption} = this.#options;

		const data = serialize ? serialize(value) : JSON.stringify(value, undefined, '\t');

		return encryption ? encryption.encrypt(data).toString() : data;
	};

	private _validate(data: T | unknown): void {
		if (!this.#validator) {
			return;
		}

		const valid = this.#validator(data);
		if (valid || !this.#validator.errors) {
			return;
		}

		const errors = this.#validator.errors
			.map(({instancePath, message = ''}) => `\`${instancePath.slice(1)}\` ${message}`);
		throw new Error('Config schema violation: ' + errors.join('; '));
	}

	private _ensureDirectory(): void {
		// Ensure the directory exists as it could have been deleted in the meantime.
		fs.mkdirSync(path.dirname(this.path), {recursive: true});
	}

	private _read(): void {
		try {
			const data = fs.readFileSync(this.path, this.#encryptionKey ? null : 'utf8');
			const dataString = this._decryptData(data);
			const deserializedData = this._deserialize(dataString);

			if (!this.#isInMigration) {
				this._validate(deserializedData);
			}

			this.#cache = Object.assign(createPlainObject(), deserializedData);
		} catch (error: unknown) {
			if ((error as any)?.code === 'ENOENT') {
				this._ensureDirectory();
				this.#cache = createPlainObject();
				return;
			}

			if (this.#options.clearInvalidConfig) {
				const errorInstance = error as Error;
				// Handle JSON parsing errors (existing behavior)
				if (errorInstance.name === 'SyntaxError') {
					this.#cache = createPlainObject();
					return;
				}

				// Handle schema validation errors (new behavior)
				if (errorInstance.message?.startsWith('Config schema violation:')) {
					this.#cache = createPlainObject();
					return;
				}
			}

			throw error;
		}
	}

	private _write(value: T): void {
		// Write change to memory right away
		// Deep clone with regular prototype, convert to null-prototype only when returning via getter
		this.#cache = structuredClone(value);

		if (this.#writeTimer) {
			this.#writePending = true;
		} else {
			this._forceWrite();
			this._startWriteTimeout();
		}
	}

	private _forceWrite(): void {
		this._cancelWriteTimeout();

		let data: string | Uint8Array = this._serialize(this.#cache!);

		if (this.#encryptionKey) {
			const initializationVector = crypto.randomBytes(16);
			const password = crypto.pbkdf2Sync(this.#encryptionKey, initializationVector, 10_000, 32, 'sha512');
			const cipher = crypto.createCipheriv(encryptionAlgorithm, password, initializationVector);
			data = concatUint8Arrays([initializationVector, stringToUint8Array(':'), cipher.update(stringToUint8Array(data)), cipher.final()]);
		}

		// Temporary workaround for Conf being packaged in a Ubuntu Snap app.
		// See https://github.com/sindresorhus/conf/pull/82
		if (process.env.SNAP) {
			fs.writeFileSync(this.path, data, {mode: this.#options.configFileMode});
		} else {
			try {
				atomicWriteFileSync(this.path, data, {mode: this.#options.configFileMode});
			} catch (error: unknown) {
				// Fix for https://github.com/sindresorhus/electron-store/issues/106
				// Sometimes on Windows, we will get an EXDEV error when atomic writing
				// (even though to the same directory), so we fall back to non atomic write
				if ((error as any)?.code === 'EXDEV') {
					fs.writeFileSync(this.path, data, {mode: this.#options.configFileMode});
					return;
				}

				throw error;
			}
		}
	}

	private _startWriteTimeout() {
		this._cancelWriteTimeout();

		if (this.#options?.writeTimeout) {
			this.#writeTimer = setTimeout(() => {
				this.#writeTimer = undefined;

				if (this.#writePending) {
					this.#writePending = false;
					this._forceWrite();
				}
			}, this.#options.writeTimeout);
		}
	}

	private _cancelWriteTimeout() {
		if (this.#writeTimer) {
			clearTimeout(this.#writeTimer);
			this.#writeTimer = undefined;
			this.#writePending = false;
		}
	}

	private _watch(): void {
		this._ensureDirectory();

		if (!fs.existsSync(this.path)) {
			this._write(createPlainObject<T>());
		}

		// Use fs.watch on Windows and macOS, fs.watchFile on Linux for better reliability
		if (process.platform === 'win32' || process.platform === 'darwin') {
			this.#debouncedChangeHandler ??= debounceFn(() => {
				this.clearCache();
				this.triggerChangeEvent();
			}, {wait: 100});

			// Watch the directory instead of the file to handle atomic writes (rename events)
			const directory = path.dirname(this.path);
			const basename = path.basename(this.path);

			this.#watcher = fs.watch(directory, {persistent: false, encoding: 'utf8'}, (_eventType, filename) => {
				if (filename && filename !== basename) {
					return;
				}

				if (typeof this.#debouncedChangeHandler === 'function') {
					this.#debouncedChangeHandler();
				}
			});
		} else {
			// Fs.watchFile is used on Linux for better cross-platform reliability
			this.#debouncedChangeHandler ??= debounceFn(() => {
				this.clearCache();
				this.triggerChangeEvent();
			}, {wait: 1000});

			fs.watchFile(this.path, {persistent: false}, (_current, _previous) => {
				if (typeof this.#debouncedChangeHandler === 'function') {
					this.#debouncedChangeHandler();
				}
			});
			this.#watchFile = true;
		}
	}

	private _migrate(migrations: Migrations<T>, versionToMigrate: string, beforeEachMigration?: BeforeEachMigrationCallback<T>): void {
		let previousMigratedVersion = this._get(MIGRATION_KEY, '0.0.0');

		const newerVersions = Object.keys(migrations)
			.filter(candidateVersion => this._shouldPerformMigration(candidateVersion, previousMigratedVersion, versionToMigrate));

		let storeBackup = cloneWithNullProto(this.store);

		for (const version of newerVersions) {
			try {
				if (beforeEachMigration) {
					beforeEachMigration(this, {
						fromVersion: previousMigratedVersion,
						toVersion: version,
						finalVersion: versionToMigrate,
						versions: newerVersions,
					});
				}

				const migration = migrations[version];
				migration?.(this);

				this._set(MIGRATION_KEY, version);

				previousMigratedVersion = version;
				storeBackup = cloneWithNullProto(this.store);
			} catch (error: unknown) {
				// Restore backup (validation is skipped during migration)
				this.store = storeBackup;
				// Try to write the restored state to disk to ensure rollback persists
				// If write fails (e.g., read-only file), we still throw the original error
				try {
					this._write(storeBackup);
				} catch {}

				const errorMessage = error instanceof Error ? error.message : String(error);
				throw new Error(`Something went wrong during the migration! Changes applied to the store until this failed migration will be restored. ${errorMessage}`);
			}
		}

		if (this._isVersionInRangeFormat(previousMigratedVersion) || !semver.eq(previousMigratedVersion, versionToMigrate)) {
			this._set(MIGRATION_KEY, versionToMigrate);
		}
	}

	private _containsReservedKey(key: string | PartialObjectDeep<T>): boolean {
		if (typeof key === 'string') {
			return this._isReservedKeyPath(key);
		}

		if (!key || typeof key !== 'object') {
			return false;
		}

		return this._objectContainsReservedKey(key);
	}

	private _objectContainsReservedKey(value: unknown): boolean {
		if (!value || typeof value !== 'object') {
			return false;
		}

		for (const [candidateKey, candidateValue] of Object.entries(value)) {
			if (this._isReservedKeyPath(candidateKey)) {
				return true;
			}

			if (this._objectContainsReservedKey(candidateValue)) {
				return true;
			}
		}

		return false;
	}

	private _isReservedKeyPath(candidate: string): boolean {
		return candidate === INTERNAL_KEY || candidate.startsWith(`${INTERNAL_KEY}.`);
	}

	private _isVersionInRangeFormat(version: string): boolean {
		return semver.clean(version) === null;
	}

	private _shouldPerformMigration(candidateVersion: string, previousMigratedVersion: string, versionToMigrate: string): boolean {
		if (!previousMigratedVersion) {
			return false;
		}

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
	private _get<Key extends keyof T, Default = unknown>(key: Key, defaultValue: Default): T[Key] | Default;
	private _get<Key extends keyof T, Default = unknown>(key: Key | string, defaultValue?: Default): T[Key] | Default | undefined {
		return getProperty(this.store, key as string, defaultValue as T[Key]);
	}

	private _set(key: string, value: unknown): void {
		const {store} = this;
		setProperty(store, key, value);

		this.store = store;
	}

	#prepareOptions(partialOptions: Readonly<Partial<Options<T>>>): Partial<Options<T>> {
		const options: Partial<Options<T>> = {
			configName: 'config',
			fileExtension: 'json',
			projectSuffix: 'nodejs',
			clearInvalidConfig: false,
			accessPropertiesByDotNotation: true,
			configFileMode: 0o666,
			writeTimeout: 0,
			...partialOptions,
		};

		if (!options.cwd) {
			if (!options.projectName) {
				throw new Error('Please specify the `projectName` option.');
			}

			options.cwd = envPaths(options.projectName, {suffix: options.projectSuffix}).config;
		}

		if (typeof options.fileExtension === 'string') {
			options.fileExtension = options.fileExtension.replace(/^\.+/, '');
		}

		return options;
	}

	#setupValidator(options: Partial<Options<T>>): void {
		if (!(options.schema ?? options.ajvOptions ?? options.rootSchema)) {
			return;
		}

		if (options.schema && typeof options.schema !== 'object') {
			throw new TypeError('The `schema` option must be an object.');
		}

		// Workaround for https://github.com/ajv-validator/ajv/issues/2047
		const ajvFormats = ajvFormatsModule.default;

		const ajv = new Ajv({
			allErrors: true,
			useDefaults: true,
			...options.ajvOptions,
		});
		ajvFormats(ajv);

		const schema: JSONSchema = {
			...options.rootSchema,
			type: 'object',
			properties: options.schema,
		};

		this.#validator = ajv.compile(schema);
		this.#captureSchemaDefaults(options.schema);
	}

	#captureSchemaDefaults(schemaConfig: Schema<T> | undefined): void {
		const schemaEntries = Object.entries(schemaConfig ?? {}) as Array<[keyof T, JSONSchema | undefined]>;
		for (const [key, schemaDefinition] of schemaEntries) {
			if (!schemaDefinition || typeof schemaDefinition !== 'object') {
				continue;
			}

			if (!Object.hasOwn(schemaDefinition, 'default')) {
				continue;
			}

			const {default: defaultValue} = schemaDefinition as {default: unknown};
			if (defaultValue === undefined) {
				continue;
			}

			this.#defaultValues[key] = defaultValue as T[keyof T];
		}
	}

	#applyDefaultValues(options: Partial<Options<T>>): void {
		if (options.defaults) {
			// Validate defaults by attempting to structuredClone them
			// This will throw if they contain invalid types like functions
			try {
				structuredClone(options.defaults);
			} catch (error) {
				throw new TypeError(`Invalid defaults: ${(error as Error).message}`);
			}

			Object.assign(this.#defaultValues, options.defaults);
		}
	}

	#configureSerialization(options: Partial<Options<T>>): void {
		// Nothing to do
	}

	#resolvePath(options: Partial<Options<T>>): string {
		const normalizedFileExtension = typeof options.fileExtension === 'string' ? options.fileExtension : undefined;
		const fileExtension = normalizedFileExtension ? `.${normalizedFileExtension}` : '';
		return path.resolve(options.cwd!, `${options.configName ?? 'config'}${fileExtension}`);
	}

	#initializeStore(options: Partial<Options<T>>): void {
		if (options.migrations) {
			this.#runMigrations(options);
			this._validate(this.store);
			return;
		}

		const fileStore = this.store;
		const storeWithDefaults = Object.assign(createPlainObject(), this.#defaultValues, fileStore);
		this._validate(storeWithDefaults);
		try {
			assert.deepEqual(fileStore, storeWithDefaults);
		} catch {
			this.store = storeWithDefaults;
		}
	}

	#runMigrations(options: Partial<Options<T>>): void {
		const {migrations, projectVersion} = options;
		if (!migrations) {
			return;
		}

		if (!projectVersion) {
			throw new Error('Please specify the `projectVersion` option.');
		}

		this.#isInMigration = true;
		try {
			const fileStore = this.store;
			const storeWithDefaults = Object.assign(createPlainObject(), this.#defaultValues, fileStore);
			try {
				assert.deepEqual(fileStore, storeWithDefaults);
			} catch {
				this._write(storeWithDefaults);
			}

			this._migrate(migrations, projectVersion, options.beforeEachMigration);
		} finally {
			this.#isInMigration = false;
		}
	}
}

export type {Options, Schema} from './types.js';
