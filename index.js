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
const semver = require('semver');
const memoizeOne = require('memoize-one');

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

		const getPackageData = memoizeOne(() => {
			const packagePath = pkgUp.sync(parentDir);
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

	_migrate(migrations, versionToMigrate) {
		const MIGRATION_KEY = '__internal__.version';

		let previousMigratedVersion = this.get(MIGRATION_KEY, '0.0.0');

		const newerVersions = Object.keys(migrations)
			.filter(candidateVersion => this._shouldPerformMigration(candidateVersion, previousMigratedVersion, versionToMigrate))
			.sort(semver.compare);

		newerVersions.forEach(version => {
			try {
				const migration = migrations[version];
				migration(this);

				this.set(MIGRATION_KEY, version);
				previousMigratedVersion = version;
			} catch (error) {
				console.error('Something went wrong during the migration!');
				console.error('Changes applied to the store until this point will be persisted.');
				throw error;
			}
		});

		if (!semver.eq(previousMigratedVersion, versionToMigrate)) {
			this.set(MIGRATION_KEY, versionToMigrate);
		}
	}

	/**
	 * Specifies if a version is suitable to run its migrations.
	 * To be suitable, a version should be comprehended between the previous migrated version and the version desired to migrate.
	 *
	 * @param {string} candidateVersion The version that's being tested to be suitable or not.
	 * @param {string} previousMigratedVersion The version matching the last migration that ocurred.
	 * @param {string} versionToMigrate The version that specifies what to migrate to (a.k.a the current version).
	 * @returns {boolean} If the version is suitable or not.
	 */
	_shouldPerformMigration(candidateVersion, previousMigratedVersion, versionToMigrate) {
		if (semver.lte(candidateVersion, previousMigratedVersion)) {
			return false;
		}

		if (semver.gt(candidateVersion, versionToMigrate)) {
			return false;
		}

		return true;
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
				// TODO: Use `fs.mkdirSync` `recursive` option when targeting Node.js 12
				makeDir.sync(path.dirname(this.path));
				return plainObject();
			}

			if (this._options.clearInvalidConfig && error.name === 'SyntaxError') {
				return plainObject();
			}

			throw error;
		}
	}

	set store(value) {
		// Ensure the directory exists as it could have been deleted in the meantime
		makeDir.sync(path.dirname(this.path));

		this._validate(value);
		let data = this.serialize(value);

		if (this.encryptionKey) {
			const initializationVector = crypto.randomBytes(16);
			const password = crypto.pbkdf2Sync(this.encryptionKey, initializationVector.toString(), 10000, 32, 'sha512');
			const cipher = crypto.createCipheriv(encryptionAlgorithm, password, initializationVector);
			data = Buffer.concat([initializationVector, Buffer.from(':'), cipher.update(Buffer.from(data)), cipher.final()]);
		}

		writeFileAtomic.sync(this.path, data);
		this.events.emit('change');
	}

	* [Symbol.iterator]() {
		for (const [key, value] of Object.entries(this.store)) {
			yield [key, value];
		}
	}
}

module.exports = Conf;
