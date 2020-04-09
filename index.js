/* eslint-disable node/no-deprecated-api */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const EventEmitter = require('events');
const dotProp = require('dot-prop');
const makeDir = require('make-dir');
const pkgUp = require('pkg-up');
const envPaths = require('env-paths');
const writeFileAtomic = require('write-file-atomic');
const Ajv = require('ajv');
const debounceFn = require('debounce-fn');
const semver = require('semver');
const onetime = require('onetime');

const plainObject = () => Object.create(null);
const encryptionAlgorithm = 'aes-256-cbc';

// Prevent caching of this module so module.parent is always accurate
delete require.cache[__filename];
const parentDir = path.dirname((module.parent && module.parent.filename) || '.');

const checkValueType = (key, value) => {
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

class Conf {
	constructor(options) {
		options = {
			configName: 'config',
			fileExtension: 'json',
			projectSuffix: 'nodejs',
			clearInvalidConfig: true,
			serialize: value => JSON.stringify(value, null, '\t'),
			deserialize: JSON.parse,
			accessPropertiesByDotNotation: true,
			...options
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
		this._defaultValues = {};

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
		this.serialize = options.serialize;
		this.deserialize = options.deserialize;

		const fileExtension = options.fileExtension ? `.${options.fileExtension}` : '';
		this.path = path.resolve(options.cwd, `${options.configName}${fileExtension}`);

		const fileStore = this.store;
		const store = Object.assign(plainObject(), options.defaults, fileStore);
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

	_validate(data) {
		if (!this._validator) {
			return;
		}

		const valid = this._validator(data);
		if (!valid) {
			const errors = this._validator.errors.reduce((error, {dataPath, message}) =>
				error + ` \`${dataPath.slice(1)}\` ${message};`, '');
			throw new Error('Config schema violation:' + errors.slice(0, -1));
		}
	}

	_ensureDirectory() {
		// TODO: Use `fs.mkdirSync` `recursive` option when targeting Node.js 12.
		// Ensure the directory exists as it could have been deleted in the meantime.
		makeDir.sync(path.dirname(this.path));
	}

	_write(value) {
		let data = this.serialize(value);

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
			try {
				writeFileAtomic.sync(this.path, data);
			} catch (error) {
				// Fix for https://github.com/sindresorhus/electron-store/issues/106
				// Sometimes on Windows, we will get an EXDEV error when atomic writing
				// (even though to the same directory), so we fall back to non atomic write
				if (error.code === 'EXDEV') {
					fs.writeFileSync(this.path, data);
					return;
				}

				throw error;
			}
		}
	}

	_watch() {
		this._ensureDirectory();

		if (!fs.existsSync(this.path)) {
			this._write({});
		}

		fs.watch(this.path, {persistent: false}, debounceFn(() => {
			// On Linux and Windows, writing to the config file emits a `rename` event, so we skip checking the event type.
			this.events.emit('change');
		}, {wait: 100}));
	}

	_migrate(migrations, versionToMigrate) {
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
					`Something went wrong during the migration! Changes applied to the store until this failed migration will be restored. ${error}`
				);
			}
		}

		if (this._isVersionInRangeFormat(previousMigratedVersion) || !semver.eq(previousMigratedVersion, versionToMigrate)) {
			this._set(MIGRATION_KEY, versionToMigrate);
		}
	}

	_containsReservedKey(key) {
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

	_isVersionInRangeFormat(version) {
		return semver.clean(version) === null;
	}

	_shouldPerformMigration(candidateVersion, previousMigratedVersion, versionToMigrate) {
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

	_get(key, defaultValue) {
		return dotProp.get(this.store, key, defaultValue);
	}

	_set(key, value) {
		const {store} = this;
		dotProp.set(store, key, value);

		this.store = store;
	}

	get(key, defaultValue) {
		if (this._options.accessPropertiesByDotNotation) {
			return dotProp.get(this.store, key, defaultValue);
		}

		return key in this.store ? this.store[key] : defaultValue;
	}

	set(key, value) {
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

		const set = (key, value) => {
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
			set(key, value);
		}

		this.store = store;
	}

	has(key) {
		if (this._options.accessPropertiesByDotNotation) {
			return dotProp.has(this.store, key);
		}

		return key in this.store;
	}

	reset(...keys) {
		for (const key of keys) {
			if (this._defaultValues[key]) {
				this.set(key, this._defaultValues[key]);
			}
		}
	}

	delete(key) {
		const {store} = this;
		if (this._options.accessPropertiesByDotNotation) {
			dotProp.delete(store, key);
		} else {
			delete store[key];
		}

		this.store = store;
	}

	clear() {
		this.store = plainObject();
	}

	onDidChange(key, callback) {
		if (typeof key !== 'string') {
			throw new TypeError(`Expected \`key\` to be of type \`string\`, got ${typeof key}`);
		}

		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		const getter = () => this.get(key);

		return this.handleChange(getter, callback);
	}

	onDidAnyChange(callback) {
		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		const getter = () => this.store;

		return this.handleChange(getter, callback);
	}

	handleChange(getter, callback) {
		let currentValue = getter();

		const onChange = () => {
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

		this.events.on('change', onChange);
		return () => this.events.removeListener('change', onChange);
	}

	get size() {
		return Object.keys(this.store).length;
	}

	get store() {
		try {
			let data = fs.readFileSync(this.path, this.encryptionKey ? null : 'utf8');

			if (this.encryptionKey) {
				try {
					// Check if an initialization vector has been used to encrypt the data
					if (data.slice(16, 17).toString() === ':') {
						const initializationVector = data.slice(0, 16);
						const password = crypto.pbkdf2Sync(this.encryptionKey, initializationVector.toString(), 10000, 32, 'sha512');
						const decipher = crypto.createDecipheriv(encryptionAlgorithm, password, initializationVector);
						data = Buffer.concat([decipher.update(data.slice(17)), decipher.final()]);
					} else {
						const decipher = crypto.createDecipher(encryptionAlgorithm, this.encryptionKey);
						data = Buffer.concat([decipher.update(data), decipher.final()]);
					}
				} catch (_) {}
			}

			data = this.deserialize(data);
			this._validate(data);
			return Object.assign(plainObject(), data);
		} catch (error) {
			if (error.code === 'ENOENT') {
				this._ensureDirectory();
				return plainObject();
			}

			if (this._options.clearInvalidConfig && error.name === 'SyntaxError') {
				return plainObject();
			}

			throw error;
		}
	}

	set store(value) {
		this._ensureDirectory();

		this._validate(value);
		this._write(value);

		this.events.emit('change');
	}

	* [Symbol.iterator]() {
		for (const [key, value] of Object.entries(this.store)) {
			yield [key, value];
		}
	}
}

module.exports = Conf;
