'use strict';
const fs = require('fs');
const path = require('path');
const dotProp = require('dot-prop');
const mkdirp = require('mkdirp');
const pkgUp = require('pkg-up');
const envPaths = require('env-paths');

const obj = () => Object.create(null);

// Prevent caching of this module so module.parent is always accurate
delete require.cache[__filename];
const parentDir = path.dirname(module.parent.filename);

class Conf {
	constructor(opts) {
		const pkgPath = pkgUp.sync(parentDir);

		opts = Object.assign({
			// If the package.json was not found, avoid breaking with `require(null)`
			projectName: pkgPath && require(pkgPath).name // eslint-disable-line import/no-dynamic-require
		}, opts);

		if (!opts.projectName && !opts.cwd) {
			throw new Error('Project name could not be inferred. Please specify the `projectName` option.');
		}

		opts = Object.assign({
			configName: 'config'
		}, opts);

		if (!opts.cwd) {
			opts.cwd = envPaths(opts.projectName).config;
		}

		this.path = path.resolve(opts.cwd, `${opts.configName}.json`);
		this.store = Object.assign(obj(), opts.defaults, this.store);
	}
	get(key) {
		return dotProp.get(this.store, key);
	}
	set(key, val) {
		if (typeof key !== 'string' && typeof key !== 'object') {
			throw new TypeError(`Expected \`key\` to be of type \`string\` or \`object\`, got ${typeof key}`);
		}

		const store = this.store;

		if (typeof key === 'object') {
			Object.keys(key).forEach(k => {
				dotProp.set(store, k, key[k]);
			});
		} else {
			dotProp.set(store, key, val);
		}

		this.store = store;
	}
	has(key) {
		return dotProp.has(this.store, key);
	}
	delete(key) {
		const store = this.store;
		dotProp.delete(store, key);
		this.store = store;
	}
	clear() {
		this.store = obj();
	}
	get size() {
		return Object.keys(this.store).length;
	}
	get store() {
		try {
			return Object.assign(obj(), JSON.parse(fs.readFileSync(this.path, 'utf8')));
		} catch (err) {
			if (err.code === 'ENOENT') {
				mkdirp.sync(path.dirname(this.path));
				return obj();
			}

			if (err.name === 'SyntaxError') {
				return obj();
			}

			throw err;
		}
	}
	set store(val) {
		// Ensure the directory exists as it could have been deleted in the meantime
		mkdirp.sync(path.dirname(this.path));

		fs.writeFileSync(this.path, JSON.stringify(val, null, '\t'));
	}
	// TODO: Use `Object.entries()` here at some point
	* [Symbol.iterator]() {
		const store = this.store;

		for (const key of Object.keys(store)) {
			yield [key, store[key]];
		}
	}
}

module.exports = Conf;
