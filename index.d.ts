/// <reference types="node"/>

export interface Options<T> {
	/**
	 * Config used if there are no existing config.
	 */
	readonly defaults?: {[key: string]: T};

	/**
	 * Name of the config file (without extension).
	 *
	 * Useful if you need multiple config files for your app or module. For example, different config files between two major versions.
	 *
	 * @default 'config'
	 */
	readonly configName?: string;

	/**
	 * You only need to specify this if you don't have a `package.json` file in your project. Default: The name field in the `package.json` closest to where `conf` is imported.
	 */
	readonly projectName?: string;

	/**
	 * **You most likely don't need this. Please don't use it unless you really have to.**
	 *
	 * The only use-case I can think of is having the config located in the app directory or on some external storage. Default: System default user [config directory](https://github.com/sindresorhus/env-paths#pathsconfig).
	 */
	readonly cwd?: string;

	/**
	 * Note that this is **not intended for security purposes**, since the encryption key would be easily found inside a plain-text Node.js app.
	 *
	 * Its main use is for obscurity. If a user looks through the config directory and finds the config file, since it's just a JSON file, they may be tempted to modify it. By providing an encryption key, the file will be obfuscated, which should hopefully deter any users from doing so.
	 *
	 * It also has the added bonus of ensuring the config file's integrity. If the file is changed in any way, the decryption will not work, in which case the store will just reset back to its default state.
	 *
	 * When specified, the store will be encrypted using the [`aes-256-cbc`](https://en.wikipedia.org/wiki/Block_cipher_mode_of_operation) encryption algorithm.
	 */
	readonly encryptionKey?: string | Buffer | NodeJS.TypedArray | DataView;

	/**
	 * Extension of the config file.
	 *
	 * You would usually not need this, but could be useful if you want to interact with a file with a custom file extension that can be associated with your app. These might be simple save/export/preference files that are intended to be shareable or saved outside of the app.
	 *
	 * @default 'json'
	 */
	readonly fileExtension?: string;

	/**
	 * The config is cleared if reading the config file causes a `SyntaxError`. This is a good default, as the config file is not intended to be hand-edited, so it usually means the config is corrupt and there's nothing the user can do about it anyway. However, if you let the user edit the config file directly, mistakes might happen and it could be more useful to throw an error when the config is invalid instead of clearing. Disabling this option will make it throw a `SyntaxError` on invalid config instead of clearing.
	 *
	 * @default true
	 */
	readonly clearInvalidConfig?: boolean;

	/**
	 * Function to serialize the config object to a UTF-8 string when writing the config file.
	 *
	 * You would usually not need this, but it could be useful if you want to use a format other than JSON.
	 *
	 * @default value => JSON.stringify(value, null, '\t')
	 */
	readonly serialize?: (value: {[key: string]: T}) => string;

	/**
	 * Function to deserialize the config object from a UTF-8 string when reading the config file.
	 *
	 * You would usually not need this, but it could be useful if you want to use a format other than JSON.
	 *
	 * @default JSON.parse
	 */
	readonly deserialize?: (text: string) => {[key: string]: T};

	/**
	 * **You most likely don't need this. Please don't use it unless you really have to.**
	 *
	 * Suffix appended to `projectName` during config file creation to avoid name conflicts with native apps.
	 *
	 * You can pass an empty string to remove the suffix.
	 *
	 * For example, on macOS, the config file will be stored in the `~/Library/Preferences/foo-nodejs` directory, where `foo` is the `projectName`.
	 *
	 * @default 'nodejs'
	 */
	readonly projectSuffix?: string;
}

/**
 * Simple config handling for your app or module.
 */
export default class Conf<T = unknown> implements Iterable<[string, T]> {
	store: {[key: string]: T};
	readonly path: string;
	readonly size: number;

	constructor(options?: Options<T>);

	/**
	 * Set an item.
	 *
	 * @param key - You can use [dot-notation](https://github.com/sindresorhus/dot-prop) in a key to access nested properties.
	 * @param value - Must be JSON serializable. Trying to set the type `undefined`, `function`, or `symbol` will result in a `TypeError`.
	 */
	set(key: string, value: T): void;

	/**
	 * Set multiple items at once.
	 *
	 * @param object - A hashmap of items to set at once.
	 */
	set(object: {[key: string]: T}): void;

	/**
	 * Get an item.
	 *
	 * @param key - The key of the item to get.
	 * @param defaultValue - The default value if the item does not exist.
	 */
	get(key: string, defaultValue?: T): T;

	/**
	 * Check if an item exists.
	 *
	 * @param key - The key of the item to check.
	 */
	has(key: string): boolean;

	/**
	 * Delete an item.
	 *
	 * @param key - The key of the item to delete.
	 */
	delete(key: string): void;

	/**
	 * Delete all items.
	 */
	clear(): void;

	/**
	 * Watches the given `key`, calling `callback` on any changes.
	 *
	 * @param key - The key wo watch.
	 * @param callback - A callback function that is called on any changes. When a `key` is first set `oldValue` will be `undefined`, and when a key is deleted `newValue` will be `undefined`.
	 */
	onDidChange(
		key: string,
		callback: (oldValue: T | undefined, newValue: T | undefined) => void
	): void;

	[Symbol.iterator](): IterableIterator<[string, T]>;
}
