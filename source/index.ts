/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-return */
import {Buffer} from 'node:buffer';
import {isDeepStrictEqual} from 'node:util';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parsePath} from 'dot-prop';
import envPaths from 'env-paths';
import {writeFileSync as atomicWriteFileSync} from 'atomically';
import {Ajv2020 as Ajv, type ErrorObject as AjvErrorObject, type ValidateFunction as AjvValidateFunction} from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';
import debounceFn from 'debounce-fn';
import semver from 'semver';
import {type JSONSchema} from 'json-schema-typed';
import {
	concatUint8Arrays,
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
	type DefaultsOf,
	type Schema,
	type ValueSchema,
	type ArrayItemsOf,
} from './types.js';

type EncryptionAlgorithm = NonNullable<Options<Record<string, unknown>>['encryptionAlgorithm']>;

const defaultEncryptionAlgorithm: EncryptionAlgorithm = 'aes-256-cbc';

// The bits the kernel stores in a file mode, which are the setuid, setgid and sticky bits on top of the nine permission bits.
const maxConfigFileMode = 0o7777;

/**
The `configFileMode` option as the number it stands for.

`fs` reads a mode given as a string as an octal number and stops at the first character that is not one, so `0o644` reaches it as `0` and leaves a config file that nobody can read back. Only a string of octal digits is read here, and anything of another type is refused, since a mode nobody asked for is worse than a report. The option is typed as a number, so a string takes a cast to reach this.
*/
const readConfigFileMode = (mode: unknown): number | undefined => {
	if (mode === undefined || mode === null) {
		return undefined;
	}

	if (typeof mode === 'number') {
		// A number the file system does not take a mode from leaves a file nobody asked for, since the bitwise umask arithmetic in the constructor silently truncates a value that is not a whole number.
		if (!Number.isInteger(mode) || mode < 0 || mode > maxConfigFileMode) {
			throw new TypeError(`The \`configFileMode\` option must be a whole number between 0 and ${maxConfigFileMode}, got ${mode}`);
		}

		return mode;
	}

	if (typeof mode === 'string' && /^[0-7]+$/.test(mode)) {
		const parsed = Number.parseInt(mode, 8);

		// A string is held to the same range a number is, since a mode outside it is not a mode a file can be given either.
		if (parsed > maxConfigFileMode) {
			throw new TypeError(`The \`configFileMode\` option must be a whole number between 0 and ${maxConfigFileMode}, got \`${mode}\``);
		}

		return parsed;
	}

	throw new TypeError(`The \`configFileMode\` option must be a number or a string of octal digits, got ${typeof mode === 'string' ? `\`${mode}\`` : typeof mode}`);
};

/**
Refuse an option that is documented as an object and that is not one, so a caller is told which of its options is wrong rather than what the operation on it happens to report. `'properties' in rootSchema` refuses a primitive with a message about the `in` operator, and spreading a primitive `ajvOptions` into the validator hands it a set of numbered keys that is silently ignored. A `null` is the same as not passing the option, which is how every option here is read.
*/
const assertObjectOption = (name: string, value: unknown): void => {
	if (value !== undefined && value !== null && typeof value !== 'object') {
		throw new TypeError(`The \`${name}\` option must be an object.`);
	}
};

/**
Refuse a `migrations` option that is not an object of steps, so a caller is told which of its options is wrong rather than what one of its steps did. A key is read as the version it names, so a list of steps is an option whose keys name no version and none of which runs, and a step that is not a function is one the engine refuses to call, which blames the step rather than the option it came from. A key that is neither a version nor a range is left alone, since that is a spelling of a key and not the shape of the option.
*/
const assertMigrations = (migrations: unknown): void => {
	if (migrations === undefined || migrations === null) {
		return;
	}

	if (typeof migrations !== 'object' || Array.isArray(migrations)) {
		throw new TypeError('The `migrations` option must be an object whose keys are the versions to migrate and whose values are the steps to run.');
	}

	for (const [version, step] of Object.entries(migrations)) {
		if (typeof step !== 'function') {
			throw new TypeError(`The \`migrations\` option must be an object of steps, got ${step === null ? 'null' : typeof step} for the version \`${version}\`.`);
		}
	}
};

const supportedEncryptionAlgorithms = new Set<EncryptionAlgorithm>([
	'aes-256-cbc',
	'aes-256-gcm',
	'aes-256-ctr',
]);

/**
The error a file comes down to when the key does not decrypt it, and nothing else.

A type of its own rather than a message a read matches, since a `deserialize` of the caller can throw an error of the same text, which is the caller's own and says nothing about a file this store could not decrypt. Telling the two apart is what keeps such an error from being taken for a decryption failure, which `clearInvalidConfig` clears the file for.
*/
class DecryptionError extends Error {}

/**
The error a store the schema rejects is reported with, which is what `clearInvalidConfig` clears a config file for. A type of its own for the reason `DecryptionError` is one.
*/
class SchemaViolationError extends Error {}

const createPlainObject = <T = Record<string, unknown>>(): T => Object.create(null);

/**
A copy of a store that has to be changed before it is written, so a write below it cannot reach the value the caller gave. The prototype is kept, since `JSON.stringify` uses a `toJSON` the value inherits from it, and a copy that is a plain object would write the own properties of a class instance rather than what its `toJSON` answers with.
*/
const copyStore = <T>(value: T): T => {
	const prototype: unknown = Object.getPrototypeOf(value);
	const copy: Record<string, unknown> = Object.assign(createPlainObject(), value);
	// A copy starts out as a plain object with no prototype, so only a prototype that is there is put back.
	if (prototype !== null) {
		Object.setPrototypeOf(copy, prototype as Record<string, unknown>);
	}

	return copy as T;
};

/**
A copy of an object without the keys whose value is `undefined`. An option or a key that is set to `undefined` is the same as one that is not passed, so such a key is dropped rather than carried along. The copy has no prototype, so a key named for a member of `Object.prototype` is a key the caller wrote and not one the copy answers for.
*/
const omitUndefined = <T extends Record<string, any>>(object: T): Partial<T> => Object.assign(createPlainObject(), Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))) as Partial<T>;

/**
A value that is not a whole object cannot hold items, so it is taken as an empty store, the way an array or `null` reads back as one. JSON writes a string as its characters and a number as itself, which would otherwise read back as the items `0`, `1`, … rather than as an empty store.
*/
const asStore = <T>(value: unknown): T => (value === null || typeof value !== 'object' || Array.isArray(value) ? createPlainObject<T>() : value as T);

/**
Whether what a key of the store holds is an item of it. An own key holding `undefined`, which a custom deserializer can hand back where JSON cannot, counts as missing for `get()` and `has()`, so it is no item either.
*/
const isItem = (value: unknown): boolean => value !== undefined;

/**
The store a read makes of a config file, which is a plain object of its own rather than the value a deserializer returned.

A `toJSON` that value carries is not the store's own, and `JSON.stringify` writes the whole store as whatever it answers with, which is what makes every write after the one that read it hold nothing at all. A `toJSON` that is not a function is a key of the store, which the file does hold and is written as itself, so it is left alone.
*/
const storeFromDeserialized = <T>(deserialized: unknown): T => {
	const store = Object.assign(createPlainObject(), asStore<T>(deserialized));

	if (typeof (store as {toJSON?: unknown}).toJSON === 'function') {
		delete (store as Record<string, unknown>).toJSON;
	}

	return store;
};

/**
The items a store holds, one at a time. A generator rather than a list of them, since an iteration that stops early must not have made the items past where it stopped, and there is nothing to gain from making the ones before it up front.
*/
function * storeItems<T>(store: T): Generator<[keyof T, T[keyof T]]> {
	for (const key of Object.keys(store as Record<string, unknown>)) {
		const value = (store as Record<string, unknown>)[key];
		if (isItem(value)) {
			yield [key as keyof T, value as T[keyof T]];
		}
	}
}

// The types no serializer is given a key for, which `set()` refuses whatever the format, and the same answer for every value the module checks, so it is worked out once here rather than once per key. `checkValueType()` is called for every key of a `set(object)` and for every key of the `defaults` option.
const nonJsonTypes = new Set([
	'undefined',
	'symbol',
	'function',
]);

// How deep the walk below goes before it gives a value up as one the store cannot hold. The walk is a recursion one level of it per level of the value, and a walk of that shape runs the stack out at a depth of a few thousand, so this leaves a margin over that rather than sitting on it.
const maximumWalkedDepth = 1000;

/**
The item inside a value that JSON cannot write as itself, with the path from the top of the value down to it, or nothing where the value holds none.

A `bigint` has no JSON form at all, so `JSON.stringify` refuses it with an error from deep inside the serializer that names neither the key nor the type. It is refused at the key already, and the same is true of one below it, so a value is looked through rather than only at. A number JSON has no form of, such as `NaN`, is written as the `null` JSON writes it as, like `JSON.stringify` does.

A value that writes itself is not looked through, since JSON writes what it writes rather than the keys below it, and a cycle inside one is therefore not a cycle in the file. What is left on the path once a value is looked through is a value that reaches itself, where a value still to come that is on no path is the same object in two places, which JSON writes twice. A value JSON drops out of what it holds, which is what it does to an `undefined`, a `symbol` and a function in an object, is left to it, since that is what the store has always written.
*/
const unwritableItem = (value: unknown, path: readonly string[], onPath: Set<unknown>, depth = 0): {at: string; type: 'bigint' | 'cycle' | 'deep'; value: unknown} | undefined => {
	// A value nested deeper than this is refused before the walk goes on, since the walk is a recursion one level of it per level of the value and a value a few thousand levels deep takes the stack past what it has, which reaches the caller as a `RangeError` about the stack rather than as this module saying what is wrong with the value. The depth is far past anything a config file holds: a file nested this deep is a megabyte of it as this module writes it, so nothing a reader wrote by hand is refused for it.
	//
	// The nesting of the value and not the length of the key is what is counted, since a key naming a path of any length is a key a caller can write and the value at the end of it is what the walk is looking through.
	if (depth > maximumWalkedDepth) {
		return {at: path.join('.'), type: 'deep', value};
	}

	if (typeof value === 'bigint') {
		return {at: path.join('.'), type: 'bigint', value};
	}

	if (value === null || typeof value !== 'object') {
		return undefined;
	}

	if (!holdsKeysOfItsOwn(value)) {
		return undefined;
	}

	// A value already on the path is one the walk came to through itself, which is what `JSON.stringify` calls a circular structure and refuses with an error that names neither the key nor the store.
	if (onPath.has(value)) {
		return {at: path.join('.'), type: 'cycle', value};
	}

	onPath.add(value);

	try {
		for (const [key, item] of Object.entries(value)) {
			const found = unwritableItem(item, [...path, key], onPath, depth + 1);
			if (found !== undefined) {
				return found;
			}
		}
	} finally {
		// The value is off the path again, so that the same object reached from two places is those two places rather than a path back to itself.
		onPath.delete(value);
	}

	return undefined;
};

/**
Refuse a value the store cannot hold. A `serialize` of the caller writes a format of its own, which can hold a `bigint`, a number JSON has no form of, or a value that holds itself, so only what no serializer is given a key for, which is `undefined`, a function and a symbol, is refused for it.
*/
const checkValueType = (key: string, value: unknown, writesJson: boolean): void => {
	const type = typeof value;

	if (nonJsonTypes.has(type)) {
		throw new TypeError(`Setting a value of type \`${type}\` for key \`${key}\` is not allowed as it's not supported by JSON`);
	}

	if (!writesJson) {
		return;
	}

	const unwritable = unwritableItem(value, [], new Set());
	if (unwritable !== undefined) {
		throwUnwritableType(key, unwritable);
	}
};

/**
Refuse a value nested deeper than a whole-store write can walk, which is the same depth limit `checkValueType()` uses for a key.

A `bigint` and a value that holds itself are left to `JSON.stringify`, which throws for both, so neither can put a value in the file that the caller did not write.
*/
const checkWrittenValueTypes = (store: unknown): void => {
	// A value that is not a whole object is taken as an empty store further down, and there is nothing to walk.
	if (store === null || typeof store !== 'object') {
		return;
	}

	for (const [key, value] of Object.entries(store as Record<string, unknown>)) {
		// The walk starts at the value itself rather than at the key, so a value at the key is reported the way `set()` of that value for that key reports it.
		const unwritable = unwritableItem(value, [], new Set());
		if (unwritable?.type === 'deep') {
			throwUnwritableType(key, unwritable);
		}
	}
};

const throwUnwritableType = (key: string, unwritable: {at: string; type: string; value: unknown}): never => {
	// The path is left out where the item is the value itself, so the message is the one above, for a value at the key.
	const at = unwritable.at === '' ? '' : ` at \`${unwritable.at}\``;

	if (unwritable.type === 'bigint') {
		throw new TypeError(`Setting a value of type \`bigint\` for key \`${key}\`${at} is not allowed as it's not supported by JSON`);
	}

	if (unwritable.type === 'deep') {
		// The path is left out, since a value nested this deep has a thousand names in it and the depth the value is refused at is in the message, which is the part a reader needs.
		throw new TypeError(`Setting a value for key \`${key}\` is not allowed as a value nested more than \`${maximumWalkedDepth}\` levels deep is not one the store can hold`);
	}

	throw new TypeError(`Setting a value for key \`${key}\`${at} is not allowed as a value that holds itself is not supported by JSON, which refuses one as a circular structure`);
};

/**
Throw for a key that is not a string, the way `get()` has always reported it. Every method that takes a key reports it the same way, so neither the method a caller used nor dot notation changes the error for the same input.
*/
const assertStringKey = (key: unknown): void => {
	if (typeof key !== 'string') {
		throw new TypeError(`Expected \`key\` to be of type \`string\`, got ${typeof key}`);
	}
};

const INTERNAL_KEY = '__internal__';
const MIGRATION_KEY = `${INTERNAL_KEY}.migrations.version`;
// Prevents completed range migrations from repeating after failures or downgrades. A disjunction is recorded with its migration key and the branch the step ran for, so distinct steps stay distinct and a store that enters a later branch still runs the step.
const COMPLETED_RANGE_MIGRATIONS_KEY = `${INTERNAL_KEY}.migrations.completedRanges`;

// The separator between the initialization vector and the data in a file this module encrypted, which is the one byte of it a read can look for.
const separatorCodePoint = ':'.codePointAt(0)!;

// Tells a key that does not exist apart from a key that holds any value.
const missingKey = Symbol('missingKey');

/**
The path the atomic write renames over, which is where a symlink at the config path points. A read and the in-place write both follow the link, so the atomic write does too. A link that points nowhere is followed by the walk below, since renaming over the link itself would lose it and leave what it was for nowhere.

A chain of links that resolves is followed in one go by `fs.realpathSync()`. One that does not is walked a link at a time, since the file a write belongs in is the one at the end of the chain and the links ahead of it are the caller's to keep, where stopping at the first one would take one of them for the file. A chain that leads back to itself has no end to it, so a link that is already behind the walk is where the walk stops.
*/
const atomicWritePath = (filePath: string): string => {
	if (!fs.lstatSync(filePath, {throwIfNoEntry: false})?.isSymbolicLink()) {
		return filePath;
	}

	try {
		return fs.realpathSync(filePath);
	} catch {
		let target = filePath;
		const walked = new Set<string>();

		while (!walked.has(target)) {
			walked.add(target);

			if (!fs.lstatSync(target, {throwIfNoEntry: false})?.isSymbolicLink()) {
				break;
			}

			// A relative target is resolved by the kernel from the directory the link is really in, so a `..` in it climbs out of that directory and not out of a link along the path to it.
			const destination = fs.readlinkSync(target);
			target = path.resolve(fs.realpathSync(path.dirname(target)), destination);
		}

		// The file at the end of the walk is not there, which is what `realpathSync` refused above, and a directory leading to it can be a link of its own that leads nowhere the write can make one, since a link standing where a directory belongs is not a directory. The directory is asked for on its own, so the file is put back in the one the links lead to, and the write makes that one.
		return fs.existsSync(target)
			? target
			: path.join(atomicWritePath(path.dirname(target)), path.basename(target));
	}
};

/**
A value of a store, copied, so a write into the copy cannot reach the value it was taken from.

A plain object and an array are copied, with or without a prototype, since those are what a path is written through. Anything else is taken as it is, since a value that writes itself is written as what it writes and a copy of it would be of nothing. An object reached twice is copied once, so a value that reaches itself is copied as one that reaches its copy rather than for ever, and the same object in two places is one copy in two places.

A value nested deeper than `maximumWalkedDepth` is handed back as it is below that depth, since the copy is a recursion one level of it per level of the value, and one a few thousand levels deep takes the stack out. A file nested that deep is a megabyte of it as this module writes it, so this is the shape a `deserialize` of the caller brings rather than one a file has.
*/
const copyStoreValue = (value: unknown, copies = new Map<unknown, unknown>(), depth = 0): unknown => {
	if (typeof value !== 'object' || value === null || depth > maximumWalkedDepth) {
		return value;
	}

	if (copies.has(value)) {
		return copies.get(value);
	}

	if (Array.isArray(value)) {
		// A hole a `deserialize` of the caller left in an array is kept a hole, so the copy is equal to what it was taken from.
		const copy: unknown[] = [];
		copy.length = value.length;
		copies.set(value, copy);
		for (const [index, item] of value.entries()) {
			if (index in value) {
				copy[index] = copyStoreValue(item, copies, depth + 1);
			}
		}

		return copy;
	}

	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return value;
	}

	// Written key by key rather than through `Object.fromEntries(Object.entries(...))`, which builds an array of pairs and reads it back for every value copied.
	const copy: Record<string, unknown> = prototype === null ? createPlainObject() : {};
	copies.set(value, copy);
	for (const key of Object.keys(value)) {
		const item = copyStoreValue((value as Record<string, unknown>)[key], copies, depth + 1);

		// A `__proto__` key is a key of its own that a JSON file can hold, and a copy with `Object.prototype` inherits a setter for that one name, so writing it as any other key is written sets the prototype of the copy instead of adding the key to it, which drops the key from the copy and from every later write of it. It is written as a key of its own the way `Object.fromEntries()` writes one, which is the one way of adding a key that does not go through a setter.
		if (key === '__proto__') {
			Object.defineProperty(copy, key, {
				value: item,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else {
			copy[key] = item;
		}
	}

	return copy;
};

/**
A value of a store, frozen, which is what a read of a store that keeps itself in memory hands back. A plain object and an array are frozen, with or without a prototype, for the reason `copyStoreValue()` copies only those, and the walk stops at the depth it does for the same reason. A frozen value can still hold mutable descendants, so visited values are tracked separately to avoid walking shared values and cycles again.
*/
const freezeStoreValue = <Value>(value: Value, depth = 0, visited = new Set<unknown>()): Value => {
	if (typeof value !== 'object' || value === null || depth > maximumWalkedDepth || visited.has(value)) {
		return value;
	}

	const prototype: unknown = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		return value;
	}

	visited.add(value);
	Object.freeze(value);
	for (const item of Object.values(value)) {
		freezeStoreValue(item, depth + 1, visited);
	}

	return value;
};

/**
Whether a value holds a key the store can keep.

An item is an enumerable own property, since that is what a JSON file holds. An array answers for `length`, which is neither an item nor written to the file, and a value that a custom deserializer added as a hidden property is not one either.
*/
const hasStoreKey = (value: unknown, key: string | number): boolean => {
	if (value === null || typeof value !== 'object') {
		return false;
	}

	return Object.prototype.propertyIsEnumerable.call(value, key);
};

/**
A default as the config file holds it, which is a copy taken through JSON where the store writes JSON. The copy is the store's own, so a write below it cannot reach the object it was taken from, and a value with a `toJSON` at any depth, such as a `Date`, is what it writes, which is what the validator is asked about and what a reset of the key writes back. A value JSON writes as nothing, or cannot write at all, is copied by hand instead, which leaves what the write makes of it to the write.
*/
const ownValue = (value: unknown, writesJson: boolean): unknown => {
	if (value === null || typeof value !== 'object') {
		return value;
	}

	// A `serialize` of the caller writes a format of its own, which JSON is not the measure of, so the value is copied by hand.
	if (!writesJson) {
		return copyStoreValue(value);
	}

	let written: string | undefined;
	try {
		written = JSON.stringify(value);
	} catch {
		return copyStoreValue(value);
	}

	return written === undefined ? copyStoreValue(value) : JSON.parse(written) as unknown;
};

/**
The key a path of the validator names, which is a JSON pointer. A pointer writes a `/` inside one key as `~1` and a `~` as `~0`, so a key the caller wrote with either of them in it comes back escaped and cannot be found anywhere, and the two are read back here.
*/
const keyFromInstancePath = (instancePath: string): string => instancePath.slice(1).replaceAll(/~([01])/g, (_match, code: string) => code === '0' ? '~' : '/');

/**
The key an error of the validator is about. A rule about a value names it in the path, as a JSON pointer, and a rule about the keys of a level names it in the parameters of the error instead, since the key is not a value below the level it is in. The path is the whole of the key where there is no rule about a key, and an error that puts a key in the parameters and the path is only the level it is in, so the two are read together.
*/
const keyFromError = ({instancePath, params}: AjvErrorObject): string => {
	// The parameters of an error are typed as anything, and each of these three is the name of a key.
	const {additionalProperty, unevaluatedProperty, propertyName} = params as {additionalProperty?: string; unevaluatedProperty?: string; propertyName?: string};
	const key = additionalProperty ?? unevaluatedProperty ?? propertyName;
	const level = keyFromInstancePath(instancePath);

	if (key === undefined) {
		return level;
	}

	return level === '' ? key : `${level}/${key}`;
};

/**
A path written back as the key it stands for, where a part that is a name of its own is escaped and a part that is an index is written as one.

A path is joined back into a key to name the value a key above it was recorded under, and a name holding a `.` of its own becomes a path again the moment it is joined. Reading the key back therefore has to give the same parts, which is what escaping the characters a path is written with is for, and a part that is an index is left as one so that a path into an array stays one.
*/
const keyOfPath = (parts: ReadonlyArray<string | number>): string => parts
	.map(part => typeof part === 'number'
		? String(part)
		: part
			// All four in one pass, so that a backslash put in front of one of the other three is not escaped in turn. A template literal cannot hold a single backslash to search for, since it would escape the backtick that ends it, and a search for a PAIR of them leaves a name holding one of them unescaped.
			.replaceAll(/[\\.[\]]/g, String.raw`\$&`))
	.join('.');

/**
The parts of a key's path, for a caller that reports a key the parser cannot read at all.

A key the parser names no parts for, such as `__proto__`, is left to the caller, which is the same answer every write gives it. A key the parser throws for is reported with a message that names the key, where the parser's own error names neither the key nor what the store was asked to do with it.
*/
const keyPathOrReport = (key: string): Array<string | number> | undefined => {
	try {
		const path = parsePath(key);
		return path.length > 0 ? path : undefined;
	} catch {
		throw new TypeError(`The key \`${key}\` is not a key a value can be written to.`);
	}
};

/**
The parts of a key's path, or nothing for a key `dot-prop` refuses. It refuses some keys by naming no parts for them, such as `__proto__`, and refuses others by throwing, such as one with an index it never closes. The two are not the same to this module: the first is a key a write leaves alone, and the second is one a caller is told about. A caller that tells is written against `keyPathOrReport()`.
*/
const keyPath = (key: string): Array<string | number> | undefined => {
	try {
		return keyPathOrReport(key);
	} catch {
		return undefined;
	}
};

const unwritableKeyReason = 'which is not a key a value can be written to.';

/**
What a key of the `schema` option is refused for, for a key the validator writes into the store under the name it is given, which only a key of its own is read back by. There is nothing wrong with a key that is one, which is what nothing here means.

A key that names a path into the root is held by the `properties` of the key above it instead. A name `dot-prop` refuses, such as `constructor` or one with an index it never closes, is a key nothing can be written to, and the `properties` of a key do not apply to it. A name below the root is only asked the second question, since it is a key of its own whatever it holds.
*/
const whyKeyIsRefused = (key: string): string | undefined => {
	const path = keyPath(key);

	// A key that is one the store holds is named as itself, which is what the validator writes it back under.
	if (path?.length === 1 && String(path[0]) === key) {
		return undefined;
	}

	if (path === undefined) {
		return unwritableKeyReason;
	}

	return 'which is not a key of its own. Use the `properties` of a key for the keys below the root.';
};

/**
Whether a value is a container the rest of a path can be written into.

A value that writes itself is not one. A `Date` writes itself as its ISO string, and `copyStore()` copying one along a path is what left a `Date` with nothing behind it, which made writing the store fail inside `JSON.stringify` with an error from the engine rather than one from this module. A class instance is one, since `JSON.stringify` writes the keys of its own.
*/
const holdsKeysOfItsOwn = (value: unknown): boolean => {
	if (value === null || typeof value !== 'object') {
		return false;
	}

	return typeof (value as {toJSON?: unknown}).toJSON !== 'function';
};

/**
The part of a key's path that a value the store holds there cannot be written into, and nothing where the store can take the path the key names. An array along the path holds nothing but its elements, a value that is not an object holds nothing at all, and a value that writes itself is not held as a container at all, so none of them can take the place the rest of the path needs. The store keeps what it has there, instead of a default replacing it.

It is a part of the path and never the key itself, since the key is what a write puts the value under and nothing stands in the way of that, so a reader of a refused write is told where to look rather than which key is at fault.

`from` is the part of the path the given value is the container of, which is past the top of the path for the part of a path that goes below a key a `default` is written into, since that value is the one the rest of the path goes into. A walk that starts there names the part above it, since the value it was given is what that part holds.
*/
const whereWriteIsBlocked = (store: unknown, key: string, from = 0): string | number | undefined => {
	const path = keyPath(key);

	// A key no value can be written to has no path to walk, and nothing in the store stands in the way of a write through it, which is what the caller is told when it reaches the write.
	if (path === undefined) {
		return undefined;
	}

	let value = store;
	// The part of the path the value in hand is the store's own, which is the part a refusal names. An array is named for the part before the key it cannot take, since it is the array itself and not the key that nothing can be written below.
	let heldAt: string | number | undefined = from > 0 ? path[from - 1] : undefined;

	for (const [index, part] of path.entries()) {
		if (index < from) {
			continue;
		}

		// An array holds nothing but its elements, so a key such as `length` cannot be set on one, and setting it would resize the array instead.
		if (Array.isArray(value) && typeof part !== 'number') {
			return heldAt;
		}

		if (index === path.length - 1) {
			return undefined;
		}

		// A key the store does not hold is the container the rest of the path needs, which the write creates.
		if (!hasStoreKey(value, part)) {
			return undefined;
		}

		heldAt = part;
		value = (value as Record<string | number, unknown>)[part];

		if (!holdsKeysOfItsOwn(value)) {
			return heldAt;
		}
	}

	// The loop answers for every part of a path that has one, and a path that has none was answered above.
	return undefined;
};

/**
A copy of a store and of every plain object and array in it, so a write anywhere below it lands in the copy and never in an object the caller still holds. The top keeps its prototype, for the reason `copyStore()` gives.
*/
const copyStoreDeep = <T>(value: T): T => {
	const copy = copyStore(value) as Record<string, unknown>;
	const copies = new Map<unknown, unknown>();
	for (const key of Object.keys(copy)) {
		copy[key] = copyStoreValue(copy[key], copies);
	}

	return copy as T;
};

/**
The regular expressions the patterns of a `patternProperties` have been compiled into, kept between stores so that a pattern is compiled once rather than once for every key of every `defaults` path it is checked against, and once per store that has the same schema. A pattern is a key of the caller's schema, so the number of them is the number of distinct patterns a process has stores with, which is the number of keys its schemas have and is nothing that grows with what a store holds. Each is compiled without flags and is neither global nor sticky, which leaves nothing on it that testing it would carry into the next test. Nothing is ever removed, so a process that builds stores from schemas assembled at runtime grows this by every pattern it ever used.
*/
const compiledPatterns = new Map<string, RegExp>();

/**
Whether a key is one the `patternProperties` of a schema covers, so that a key the `defaults` option adds that a pattern covers is left to the pattern, which checks the value just the same.

A key that is named in `properties` AND covered by a pattern is what this is here to avoid: `ajv` refuses to compile a schema that says both for one key (`property <name> matches pattern <pattern> (use allowMatchingProperties)`), so a `defaults` key a pattern covers must not also be given a `properties` entry of its own. A schema that already names a key in `properties` and also matches it with a pattern is one the caller wrote and `ajv` refuses, which is the caller's to fix rather than this module's to work around.
*/
const matchesPatternProperty = (definition: unknown, key: string): boolean => {
	const patterns = (definition as {patternProperties?: unknown} | undefined)?.patternProperties;
	if (!patterns || typeof patterns !== 'object') {
		return false;
	}

	return Object.keys(patterns).some(pattern => {
		let regExp = compiledPatterns.get(pattern);
		if (!regExp) {
			regExp = new RegExp(pattern);
			compiledPatterns.set(pattern, regExp);
		}

		return regExp.test(key);
	});
};

/**
Whether a level of the schema says what a value held under a key the `schema` option does not name has to be, which is what the value the `defaults` option gives that key is left to be checked against rather than named in the `properties` for it.

An `additionalProperties` or an `unevaluatedProperties` written as a schema is one, and so is a pattern of a `patternProperties` that covers the key. The same two keywords written as `false` are not: they say which keys there are rather than what they hold, and a key the `defaults` option names is one the store has, so it is named in the `properties` and the rule is satisfied. A key left to a rule that is about the value is checked by the same rule a `set()` of that value is checked by.
*/
const holdsValueRule = (definition: unknown, key: string): boolean => {
	const {additionalProperties, unevaluatedProperties} = (definition as {additionalProperties?: unknown; unevaluatedProperties?: unknown} | undefined) ?? {};

	return matchesPatternProperty(definition, key)
		|| (additionalProperties !== undefined && additionalProperties !== false)
		|| (unevaluatedProperties !== undefined && unevaluatedProperties !== false);
};

/**
The branch of a range the project version matches, or the range itself where it has only one branch. A branch is written back in the text `semver` parses it from.
*/
const rangeBranchFor = (range: string, version: string): string => {
	const branches = new semver.Range(range).set.map(comparators => comparators.map(String).join(' '));

	if (branches.length < 2) {
		return range;
	}

	return branches.find(branch => semver.satisfies(version, branch)) ?? range;
};

/**
The completion marker of a range migration. A single branch keeps the migration key itself, while a disjunction records both the key and the branch so another migration matching the same branch is not marked as completed and a later branch can still run.
*/
const completedRangeFor = (range: string, version: string): string => {
	const branch = rangeBranchFor(range, version);
	return branch === range ? range : JSON.stringify([range, branch]);
};

/**
The entries of the `defaults` option in the order they are written into the store. A key that names a path is written after a key it is a prefix of, so the more specific of the two lands on the place the more general one filled in, rather than replacing it and losing what the specific key said.
*/
const orderedDefaults = (defaults: Readonly<Record<string, unknown>>, dotNotation: boolean | undefined): Array<[string, unknown]> => {
	const entries = Object.entries(defaults);

	// Without dot notation a key is the whole key, so no key is a prefix of another and the order they are defined in is kept.
	if (!dotNotation) {
		return entries;
	}

	// How many parts the path of each key has is read here, once for each key, rather than in the comparison below, which is handed the same two keys again for every comparison it makes and so would read each key as many times as there are comparisons.
	const pathLengths = new Map<string, number>();
	for (const [key] of entries) {
		// A key the parser refuses has no path to order by, and is reported by `#applyDefaultValues()` where the option is read.
		pathLengths.set(key, keyPath(key)?.length ?? 0);
	}

	return entries.toSorted(([first], [second]) => pathLengths.get(first)! - pathLengths.get(second)!);
};

/**
Whether two paths are one file, which is what asks a volume that spells a name its own way whether a change it reported under a spelling of its own is a change to the config file.

A volume that keeps names apart does not have to spell them the way the caller wrote them, since macOS spells a name with a case and a form of its own, and a file reached under one spelling is a file the volume holds and reports under the other. A watcher that answers only from the bytes the name stands for is then watching a name no event is ever reported under, and every change to the file goes unseen. The file system is the one that keeps the names apart, so it is the one asked.

A path is asked for through itself rather than through what a link points at, since a watcher is made both for the config path and for the file a link there points at, and the two have to stay apart for a change to one of them to be a change to the config alone.
*/
const isSameFile = (one: string, other: string): boolean => {
	try {
		const oneStat = fs.lstatSync(one);
		const otherStat = fs.lstatSync(other);
		return oneStat.dev === otherStat.dev && oneStat.ino === otherStat.ino;
	} catch {
		// A path that names no file is not a change to one.
		return false;
	}
};

/**
Whether a version is one the recorded version in the file moves forward to, which is what keeps the recorded version from ever moving backwards. A file that holds no version, or one that holds a range where an earlier version of this module left one, is not a version to compare with, so any version moves it forward.
*/
const movesForward = (version: string, recorded: string | undefined): boolean => recorded === undefined || isVersionInRangeFormat(recorded) || semver.gt(version, recorded);

/**
The version a key of the `migrations` option names, which is a version a hook can compare. A range names the lowest version of the branch of it the project version is in, which is where the store enters it, so `1.x || 3.x` runs at `3.0.0` for a store moving from `2.0.0` to `3.1.0`. A concrete version is already one to compare, so it is passed on as the option writes it, which keeps the build metadata `semver` leaves out of a version it reports.
*/
const versionToCompare = (version: string, versionToMigrate: string): string => {
	if (!isVersionInRangeFormat(version)) {
		return version;
	}

	// A step only runs for a range the project version matches, so that version is one the range matches, and it is the answer where there is no lower one for `semver` to name, which is what a range whose upper bound is a prerelease is.
	return semver.minVersion(rangeBranchFor(version, versionToMigrate))?.version ?? versionToMigrate;
};

// `semver.clean()` accepts more than the comparisons this classification guards against, such as `=1.0.0`, and those would throw when compared as a version.
const isVersionInRangeFormat = (version: string): boolean => semver.valid(version) === null;

const shouldPerformMigration = (candidateVersion: string, previousMigratedVersion: string | undefined, versionToMigrate: string): boolean => {
	if (isVersionInRangeFormat(candidateVersion)) {
		// The migration runs when an upgrade enters its range. Checking each endpoint independently also handles disjunctive ranges, where the store can enter a later branch after being between branches.
		if (!semver.satisfies(versionToMigrate, candidateVersion)) {
			return false;
		}

		if (previousMigratedVersion === undefined) {
			return true;
		}

		return semver.gt(versionToMigrate, previousMigratedVersion) && !semver.satisfies(previousMigratedVersion, candidateVersion);
	}

	if (previousMigratedVersion !== undefined && semver.lte(candidateVersion, previousMigratedVersion)) {
		return false;
	}

	if (semver.gt(candidateVersion, versionToMigrate)) {
		return false;
	}

	return true;
};

/**
Whether the file says the step for this range has already run, which is what an entry among the completed ranges says. A disjunction is recorded with its key and the branch the step ran for, so a store that enters a later branch is a branch the record does not name and the step runs there the way it runs for any other store that enters the range.
*/
const isCompletedRange = (version: string, versionToMigrate: string, completedRanges: ReadonlySet<string>): boolean => isVersionInRangeFormat(version) && completedRanges.has(completedRangeFor(version, versionToMigrate));

/**
Read a key written in dot notation, following own properties only. `getProperty()` from `dot-prop` also follows the prototype chain of nested values, so it would answer for the members `Object.prototype` has, such as `toString`, which a store of JSON data must not do. `defaultValue` is returned when the key does not exist, and when the value it holds is `undefined`, which a custom deserializer can hand back where JSON cannot.
*/
const getOwnProperty = (target: unknown, key: string, defaultValue?: unknown): unknown => {
	const path = keyPathOrReport(key);

	// A key `dot-prop` names no parts for, such as `__proto__`, is a key the store holds nothing under, so it is a key it does not have.
	if (path === undefined) {
		return defaultValue;
	}

	let value: unknown = target;

	for (const part of path) {
		if (!hasStoreKey(value, part)) {
			return defaultValue;
		}

		value = (value as Record<string | number, unknown>)[part];
	}

	// An own key can hold `undefined`, which a custom deserializer can hand back where JSON cannot, and that counts as missing.
	return value === undefined ? defaultValue : value;
};

/**
Set a key written in dot notation, creating the objects and arrays the rest of the path needs.

Only own properties are followed. `setProperty()` from `dot-prop` follows the prototype chain of nested values, so a key such as `a.valueOf.polluted` would write onto the function `valueOf` on `Object.prototype` instead of into the store, which loses the value and changes a shared built-in.

`asKeys` is for a path whose parts are the names of the keys of an object rather than the parts of a path the caller wrote, which is what the `properties` of a schema is: a name in a schema is a key and never an index, so a numeric one is a key and not an array.
*/
const setOwnProperty = (store: Record<string, unknown>, key: string, value: unknown, asKeys = false): void => {
	const path = keyPathOrReport(key);

	// A key `dot-prop` names no parts for is a key nothing can be written to, which is where the silent skip of such a key comes from.
	if (path === undefined) {
		return;
	}

	const lastIndex = path.length - 1;

	let object = store;

	for (const [index, part] of path.entries()) {
		// An array holds nothing but its elements, so a key such as `length` cannot be set on one, and setting it would resize the array instead.
		if (Array.isArray(object) && typeof part !== 'number') {
			throw new TypeError(`The key \`${key}\` only holds the elements of an array, so \`${part}\` cannot be set on it`);
		}

		if (index === lastIndex) {
			object[part] = value;
			return;
		}

		const child = hasStoreKey(object, part) ? object[part] : undefined;

		if (child !== null && typeof child === 'object') {
			// A value that writes itself, such as a `Date` a `deserialize` of the caller handed back, is written as what it writes rather than as the keys below it, so a key below one is written to nothing, which is reported here rather than left to a `get()` that finds none of it.
			if (!holdsKeysOfItsOwn(child)) {
				throw new TypeError(`The key \`${key}\` cannot be set, since the value the store holds for it cannot be written through.`);
			}

			object = child as Record<string, unknown>;
			continue;
		}

		// A value that is missing or is not an object is replaced by the container the rest of the path needs, where an inherited member such as `valueOf` is not one of them.
		const nextPart = path[index + 1];
		const container: Record<string, unknown> | unknown[] = !asKeys && typeof nextPart === 'number' ? [] : {};
		object[part] = container;
		object = container as Record<string, unknown>;
	}
};

/**
Delete a key written in dot notation.

Only own properties are followed, for the same reason as `getOwnProperty()`. An element of an array is taken out of the array, since JSON cannot hold the hole a plain delete would leave, and writing that hole turns it into an element that holds `null`.
*/
const deleteOwnProperty = (store: Record<string, unknown>, key: string): void => {
	const path = keyPathOrReport(key);

	// A key `dot-prop` names no parts for is a key the store holds nothing under, so there is nothing to take out of it.
	if (path === undefined) {
		return;
	}

	const lastIndex = path.length - 1;

	let object = store;

	for (const [index, part] of path.entries()) {
		if (index === lastIndex) {
			if (Array.isArray(object)) {
				// An index is the only key an array can hold that JSON writes back as it is. A key such as `length` is not an item, and a plain delete throws for it.
				if (typeof part === 'number') {
					object.splice(part, 1);
				}

				return;
			}

			if (!hasStoreKey(object, part)) {
				return;
			}

			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete object[part];
			return;
		}

		const child = hasStoreKey(object, part) ? object[part] : undefined;

		if (child === null || typeof child !== 'object') {
			return;
		}

		object = child as Record<string, unknown>;
	}
};

/**
Take away a value along the path of a bookkeeping key that is an array, which is the one value that is an object and holds no key of its own. A file can hold an array under the key this module reserves, and the bookkeeping is read out of it as nothing, so the write below puts the object the bookkeeping lives in there instead of failing on a value nothing can be read out of. A value that is not an object is left alone, since the write replaces it with the container the rest of the path needs anyway, and the walk stops there since nothing is left below it to look at.
*/
const detachUnwritableBookkeeping = (store: Record<string, unknown>, path: ReadonlyArray<string | number>): void => {
	let container = store as Record<string | number, unknown>;

	for (const part of path.slice(0, -1)) {
		const child = container[part];

		if (child === null || typeof child !== 'object') {
			return;
		}

		if (Array.isArray(child)) {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- A key of a store is deleted with a computed name elsewhere as well.
			delete container[part];
			return;
		}

		container = child as Record<string | number, unknown>;
	}
};

export default class Conf<T extends Record<string, any> = Record<string, unknown>> implements Iterable<[keyof T, T[keyof T]]> {
	/**
	Get the path to the config file.
	*/
	readonly path: string;
	/**
	Dispatches a `change` event on every write of this instance, and when the `watch` option reports a change to the config file. `onDidChange()` and `onDidAnyChange()` listen on it, and you can also listen to it directly.
	*/
	readonly events: EventTarget;
	#validator?: AjvValidateFunction;
	readonly #encryptionKey?: string | Uint8Array | NodeJS.TypedArray | DataView;
	readonly #encryptionAlgorithm: EncryptionAlgorithm;
	readonly #options: Readonly<Partial<Options<T>>>;
	// The entries of the `defaults` option in the order they are written, which every write fills in, so they are ordered once rather than on every write. An option set to `undefined` is the same as one that is not passed, so a key set to it is not among them, and what the store holds stands for it.
	readonly #orderedDefaults: ReadonlyArray<[string, unknown]>;
	/**
	The mode the config file is given, with the process umask already applied to it. Absent when the caller gives no mode, which leaves the mode of a file the write creates to the kernel.
	*/
	readonly #configFileMode?: number;
	// A plain object would answer for the names `Object.prototype` has, such as `toString`, so `reset()` would read a function as the default.
	readonly #defaultValues: Partial<T> = createPlainObject();
	#cachedStore?: T;
	#isInMigration = false;
	// A watcher for the directory a file is in, keyed by the file. One watcher for a directory is told about the events of every file in it and answers for the name of one of them, so the config path and the file a link at it points at are each given one.
	readonly #watchers = new Map<string, fs.FSWatcher>();
	// The bytes the config file is last known to hold, which the watcher gives up on every change it sees, so a write of this store is the only change it does not report.
	#knownFileData?: string | Uint8Array;
	#watchFileListener?: (current: fs.Stats, previous: fs.Stats) => void;
	#debouncedChangeHandler?: {(): void; cancel(): void};
	// Whether a clearing of a damaged config file is in hand, which is the state a read made while the write that made it, the change it dispatched and the read that followed it are in flight finds, so that read reports the file rather than clearing it again.
	#isClearing = false;

	constructor(partialOptions: Readonly<Partial<Options<T>>> = {}) {
		const options = this.#prepareOptions(partialOptions);
		this.#options = options;
		this.#orderedDefaults = orderedDefaults(options.defaults ?? {}, options.accessPropertiesByDotNotation);
		this.#setupValidator(options);
		this.#configureSerialization(options);
		this.events = new EventTarget();
		this.#encryptionKey = options.encryptionKey;
		this.#encryptionAlgorithm = options.encryptionAlgorithm ?? defaultEncryptionAlgorithm;

		// A mode that is given is set with `chmod()`, which the umask does not apply to, since the kernel only reduces the mode it creates a file with. Reduce it here instead, once, so the mode the option names is the mode the file gets, the same as for a file the kernel creates. A mode that is not given is left out, and the write creates the file with the mode `fs` gives it, which the kernel reduces.
		const configFileMode = readConfigFileMode(options.configFileMode);
		if (configFileMode !== undefined) {
			// Reading the umask sets it to `0` and back (DEP0139), so a file another part of the process creates in between gets no umask. It is only read when a mode is given, which is the only time it is needed.
			// eslint-disable-next-line @typescript-eslint/no-deprecated -- There is no other API for the umask.
			const umask = process.umask();
			// eslint-disable-next-line no-bitwise
			this.#configFileMode = configFileMode & ~umask;

			// A file its owner cannot read is not one the store that wrote it can read back, not even by its owner, so a store written one cannot be read again and every later write fails with `EACCES`. A mode that is not `0` is not enough of a check: the umask above reduces one to nothing, and a mode with no owner read bit is one the owner cannot read either.
			// eslint-disable-next-line no-bitwise
			if ((this.#configFileMode & 0o400) === 0) {
				throw new TypeError(`The \`configFileMode\` option must give the file a mode its owner can read, since a file its owner cannot read is not one the store that wrote it can read back. ${JSON.stringify(options.configFileMode)} leaves the file at mode \`0o${this.#configFileMode.toString(8)}\`, which has no owner read bit.`);
			}
		}

		this.path = this.#resolvePath(options);
		this.#initializeStore(options);

		if (options.watch) {
			this.#watch();
		}
	}

	/**
	Get an item.

	@param key - The key of the item to get.
	@param defaultValue - The default value if the item does not exist.

	Tip: To get all items, see `.store`.
	*/
	get<Key extends keyof T>(key: Key): T[Key];
	get<Key extends keyof T>(key: Key, defaultValue: Exclude<T[Key], undefined>): Exclude<T[Key], undefined>;
	get<Key extends DotNotationKeyOf<T>>(key: Key): DotNotationValueOf<T, Key>;
	get<Key extends DotNotationKeyOf<T>>(key: Key, defaultValue: Exclude<DotNotationValueOf<T, Key>, undefined>): Exclude<DotNotationValueOf<T, Key>, undefined>;
	// This overload is used for dot-notation access.
	// We exclude `keyof T` and `DotNotationKeyOf<T>` as an incorrect type for the default value should not fall through to this overload.
	get<Key extends string, Value = unknown>(key: Exclude<Key, DotNotationKeyOf<T>>, defaultValue?: Value): Value;
	get(key: string, defaultValue?: unknown): unknown {
		assertStringKey(key);

		return this.#getItem(this.#readableStore(), key, defaultValue);
	}

	/**
	Set an item or multiple items at once.

	@param key - The key of the item to set. You can use [dot-notation](https://github.com/sindresorhus/dot-prop) in a key to access nested properties. Or an object of items to set at once, where each key replaces the whole value it names, and with dot notation a key can be a path, such as `{'foo.bar': 1}`.
	@param value - Must be JSON serializable. Trying to set a value of type `undefined`, `function`, or `symbol` will result in a `TypeError`, and so will a `bigint` unless you use a custom `serialize`.
	*/
	// The value is required, since a key given no value is refused at runtime, where `delete()` clears one.
	// A value of `undefined` is refused, since it is the one a store cannot hold, so an optional key is written with a value of the type it holds rather than with nothing.
	set<Key extends keyof T>(key: Key, value: Exclude<T[Key], undefined>): void;
	set<Key extends DotNotationKeyOf<T>>(key: Key, value: Exclude<DotNotationValueOf<T, Key>, undefined>): void;
	// Fallback for dynamic dot-notation paths that can't be statically typed. A key the store names is excluded, as a value of the wrong type for it should not fall through to here.
	set<Key extends string>(key: Key & (string extends Key ? Key : Exclude<Key, DotNotationKeyOf<T>>), value: unknown): void;
	set(object: DefaultsOf<T>): void;
	set<Key extends keyof T>(key: DefaultsOf<T> | string, value?: unknown): void {
		// `null` passes the `typeof` check as an object but cannot be enumerated, so it reports as itself rather than the type its `typeof` gives, which would read wrong next to a list of accepted types.
		if (key === null || (typeof key !== 'string' && typeof key !== 'object')) {
			throw new TypeError(`Expected \`key\` to be of type \`string\` or \`object\`, got ${key === null ? 'null' : typeof key}`);
		}

		if (typeof key !== 'object' && value === undefined) {
			throw new TypeError('Use `delete()` to clear values');
		}

		this.#throwIfReservedKey(key);

		// Every value and every key is checked before the file is read, which is the same order `appendToArray()` and `delete()` use, and the same one `reset()` uses for a key the parser cannot read. A read is a write when the file is one `clearInvalidConfig` clears, so a value or a key refused after the read has already put the store that was there out of the file, and the refusal is then the only thing the caller is told about a config it has just lost.
		//
		// The refusals left below the read are the two that are questions about the store and so about what the read answers: a key written below a value the store holds that writes itself, and a key written through an array with a name in it rather than an index. Both are narrow. The store holds a value that writes itself only where a `deserialize` of the caller put one there, since a file holds what that value writes, and it holds an array only where the file or the `defaults` option put one there.
		if (typeof key === 'object') {
			for (const [objectKey, objectValue] of Object.entries(key)) {
				this.#throwIfKeyCannotBeWritten(objectKey);
				checkValueType(objectKey, objectValue, this.#writesJson);
			}
		} else {
			this.#throwIfKeyCannotBeWritten(key);
			checkValueType(key, value, this.#writesJson);
		}

		// Read from the file instead of the cache so that changes made by another process are not lost when writing.
		const store = this.#readStore();

		if (typeof key === 'object') {
			// The keys are ordered and the containers a path passes through are copied for the reasons the `defaults` option does both. A key that names a path is written after a key it is a prefix of, or it replaces what that key filled in and the more specific of the two is lost, and a write into a container has to be a write into a copy of it, or it lands on an object the caller still holds, which it still held when the write below was refused, so the caller's value was changed by a call that said it had not been written.
			for (const [objectKey, objectValue] of orderedDefaults(key, this.#options.accessPropertiesByDotNotation)) {
				this.#setValue(store, objectKey, copyStoreValue(objectValue));
			}
		} else {
			this.#setValue(store, key, copyStoreValue(value));
		}

		this.#writeStore(store, true);
	}

	/**
	Check if an item exists.

	@param key - The key of the item to check.
	*/
	has<Key extends keyof T>(key: Key): boolean;
	has<Key extends DotNotationKeyOf<T>>(key: Key): boolean;
	has(key: string): boolean {
		assertStringKey(key);

		return this.#getItem(this.#readableStore(), key, missingKey) !== missingKey;
	}

	/**
	Append an item to an array.

	If the key doesn't exist, it will be created as an array. If the key exists and is not an array, a `TypeError` will be thrown.

	The `value` must be JSON serializable. Trying to set a value of type `undefined`, `function`, or `symbol` will result in a `TypeError`, and so will a `bigint` unless you use a custom `serialize`.

	@param key - The key of the array to append to. You can use [dot-notation](https://github.com/sindresorhus/dot-prop) to access nested properties.
	@param value - The item to append. Must be JSON serializable.

	@example
	```
	config.set('items', [{name: 'foo'}]);
	config.appendToArray('items', {name: 'bar'});
	console.log(config.get('items'));
	//=> [{name: 'foo'}, {name: 'bar'}]

	// Creates array if key doesn't exist
	config.appendToArray('newItems', 'first');
	console.log(config.get('newItems'));
	//=> ['first']
	```
	*/
	appendToArray<Key extends keyof T>(key: Key, value: ArrayItemsOf<T[Key]>): void;
	appendToArray<Key extends DotNotationKeyOf<T>>(key: Key, value: ArrayItemsOf<DotNotationValueOf<T, Key>>): void;
	appendToArray(key: string, value: unknown): void {
		assertStringKey(key);
		checkValueType(key, value, this.#writesJson);
		// Deleting or replacing the bookkeeping would run every migration again on the next start.
		this.#throwIfReservedKey(key);
		// Asked before the file is read, the way `set()` asks it, since a read is a write where the file is one `clearInvalidConfig` clears, and a key the parser cannot read is a question about the key and not about the store.
		this.#throwIfKeyCannotBeWritten(key);
		const store = this.#readStore();
		const array = this.#getItem(store, key, []);

		if (!Array.isArray(array)) {
			throw new TypeError(`The key \`${key}\` is already set to a non-array value`);
		}

		// The array the store already holds is the store's own rather than the caller's, so it is written as the file has for whatever a `deserialize` of the caller handed back in it, which is what a `set()` of another key does with the same store. Refusing it here would make a store the whole-store write handles into one nothing can append to, so the value above is the only one this asks about.
		//
		// The array is written into the store this read gave, so a second read cannot answer with an array the one appended to is not part of.
		this.#setValue(store, key, [...(array as unknown[]), copyStoreValue(value)]);
		this.#writeStore(store, true);
	}

	/**
	Reset items to their default values, as defined by the `defaults` or `schema` option. The `default` values of the `schema` option are not used when `ajvOptions.useDefaults` is `false`.

	With dot notation, schema defaults below an optional object with no default of its own are unavailable to `reset()` when a parent default omits that object. Include the object in the parent default to reset its descendants individually.

	@see `clear()` to reset all items.

	@param keys - The keys of the items to reset.
	*/
	reset<Key extends keyof T>(...keys: Key[]): void;
	reset<Key extends DotNotationKeyOf<T>>(...keys: Key[]): void;
	reset(...keys: string[]): void {
		// Every key is checked before any of them is reset, so a key that is refused leaves the store as it was, rather than being reported once the keys before it are reset.
		for (const key of keys) {
			assertStringKey(key);
			this.#throwIfKeyCannotBeWritten(key);
		}

		for (const key of keys) {
			const defaultValue = this.#getItem(this.#defaultValues, key);

			if (isItem(defaultValue)) {
				this.set(key, defaultValue);
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
		assertStringKey(key);

		// Deleting the bookkeeping would run every migration again on the next start.
		this.#throwIfReservedKey(key);
		// Asked before the file is read, the way `set()` asks it, since a read is a write where the file is one `clearInvalidConfig` clears, and a key the parser cannot read is a question about the key and not about the store.
		this.#throwIfKeyCannotBeWritten(key);

		const store = this.#readStore();
		if (this.#options.accessPropertiesByDotNotation) {
			deleteOwnProperty(store, key);
		} else {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete store[key];
		}

		this.#writeStore(store, true);
	}

	/**
	Delete all items.

	This resets known items to their default values, if defined by the `defaults` or `schema` option. The `default` values of the `schema` option are not used when `ajvOptions.useDefaults` is `false`.
	*/
	clear(): void {
		// The store the `defaults` option and the `default`s of the schema make out of nothing, which is what a fresh store holds, since a whole-store write fills in the one and validates for the other.
		this.store = createPlainObject<T>();
	}

	/**
	Watches the given `key`, calling `callback` on any changes.

	A change noticed while the config file cannot be read, for example while another process is writing it, is not reported.

	@param key - The key to watch.
	@param callback - A callback function that is called on any changes. When a key is first set, `oldValue` will be `undefined`, and when a key is deleted, `newValue` will be `undefined`.
	@returns A function that unsubscribes when called.

	@example
	```
	const unsubscribe = config.onDidChange(key, callback);

	unsubscribe();
	```
	*/
	onDidChange<Key extends keyof T>(key: Key, callback: OnDidChangeCallback<T[Key]>): Unsubscribe;
	onDidChange<Key extends DotNotationKeyOf<T>>(key: Key, callback: OnDidChangeCallback<DotNotationValueOf<T, Key>>): Unsubscribe;
	onDidChange<Key extends string>(key: Key, callback: OnDidChangeCallback<any>): Unsubscribe {
		assertStringKey(key);

		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		return this.#handleValueChange(() => this.get(key), callback);
	}

	/**
	Watches the whole config object, calling `callback` on any changes.

	A change noticed while the config file cannot be read, for example while another process is writing it, is not reported.

	`oldValue` and `newValue` will be the config object before and after the change, respectively. You must compare `oldValue` to `newValue` to find out what changed.

	@param callback - A callback function that is called on any changes.
	@returns A function that unsubscribes when called.

	@example
	```
	const unsubscribe = config.onDidAnyChange(callback);

	unsubscribe();
	```
	*/
	onDidAnyChange(callback: OnDidAnyChangeCallback<T>): Unsubscribe {
		if (typeof callback !== 'function') {
			throw new TypeError(`Expected \`callback\` to be of type \`function\`, got ${typeof callback}`);
		}

		return this.#handleValueChange(() => this.store, callback);
	}

	/**
	Get the item count.
	*/
	get size(): number {
		const store = this.#readableStore() as Record<string, unknown>;
		let count = 0;

		// Counted from the keys the store holds rather than from a list of every key and value pair of it, of which all but the count is thrown away.
		for (const key of Object.keys(store)) {
			if (isItem(store[key])) {
				count++;
			}
		}

		return count;
	}

	/**
	Get all the config as an object or replace the current config with an object.

	@example
	```
	console.log(config.store);
	//=> [Object: null prototype] {name: 'John', age: 30}
	```

	Unlike `set()`, a whole-store write drops a function or a symbol, like `JSON.stringify` does, instead of throwing. A `bigint` still throws, unless you use a custom `serialize`.

	@example
	```
	config.store = {
		hello: 'world'
	};
	```
	*/
	get store(): T {
		return this.#readableStore();
	}

	set store(value: T) {
		this.#writeStore(value, false);
	}

	* [Symbol.iterator](): IterableIterator<[keyof T, T[keyof T]]> {
		yield * storeItems(this.#readableStore());
	}

	/**
	Close the file watcher if one exists. This is useful in tests to prevent the process from hanging.
	*/
	_closeWatcher(): void {
		for (const watcher of this.#watchers.values()) {
			watcher.close();
		}

		this.#watchers.clear();

		if (this.#watchFileListener) {
			// `fs.unwatchFile()` without a listener also drops the watchers other instances registered for the same path.
			fs.unwatchFile(this.path, this.#watchFileListener);
			this.#watchFileListener = undefined;
		}

		// A change the watcher saw is reported after a debounce. That timer outlives the watcher and keeps the process alive, so the pending report is dropped with it.
		this.#debouncedChangeHandler?.cancel();
		this.#debouncedChangeHandler = undefined;

		// A change the watcher had already seen is a report that is never made once the pending one is dropped, and the cache is dropped for a change the watcher reports, so it is dropped here for one that is not. A read with no watcher is a read that goes to the file anyway.
		this.#cachedStore = undefined;
	}

	/**
	Write the store to the config file.

	`isFromFile` says the value was read from the config file, so the bookkeeping it holds is the file's own, which is neither taken off it nor looked up in the file again. A write reads the file for itself, so that a change made by another process is not lost, and reading it once more only to bring back the bookkeeping it already has is a second parse of the whole file, and for an encrypted store a second key derivation, on every single write.
	*/
	#writeStore(value: T, isFromFile: boolean): void {
		this.#ensureDirectory();

		// A value that is not a whole object cannot hold items, so it is taken as an empty store, the way an array or `null` already reads back as one.
		value = asStore<T>(value);

		// A value that writes itself is written as whatever it chooses, and for a `Date` or a class whose `toJSON` answers with text that is not a store, which would leave a file that is a bare JSON value. What it writes is taken as the store, so the bookkeeping, the `defaults` option and the validator below see the keys the file gets, and a value that is not a store is taken as an empty one. A `serialize` of the caller writes a format of its own, so the value is left to it.
		if (this.#writesJson && typeof (value as {toJSON?: unknown}).toJSON === 'function') {
			const written = JSON.stringify(value);
			value = asStore<T>(written === undefined ? undefined : JSON.parse(written));
		}

		// The bookkeeping is the module's own, and a migration writes the store as it is, so the value keeps the key then. Any other value gives up what it carries under that name, which the file is read again for below, since writing the caller's would replace the bookkeeping, and every migration would run again.
		if (!isFromFile && !this.#isInMigration && this.#containsReservedKey(value)) {
			value = copyStore(value);
			this.#detachReservedKeys(value);
		}

		// Preserve existing internal data if it exists and the new value doesn't contain it.
		if (!isFromFile && !hasStoreKey(value, INTERNAL_KEY)) {
			try {
				// Read directly from file to avoid recursion during migration
				const currentStore = this.#readConfigFile();

				if (hasStoreKey(currentStore, INTERNAL_KEY)) {
					// Copy first. The caller's object must not be changed, and it may be the same object the `store` getter handed out, which must never contain the internal key.
					value = copyStore(value);
					setOwnProperty(value, INTERNAL_KEY, (currentStore as Record<string, unknown>)[INTERNAL_KEY]);
				}
			} catch {
				// A whole-store write replaces what the file holds, so a file it cannot read, one that is damaged, encrypted with another key, or not there, has no bookkeeping to keep, and the write repairs it.
			}
		}

		// The `defaults` option is part of the store, so a store that is written whole keeps the keys it covers, the way a `default` of the schema is kept by the validator.
		value = this.#fillInDefaults(value);

		// The validator writes the `default` of the schema it applies into the store it is given, and takes the keys the additional properties rules cover out of it, at any depth, so a whole-store write gives it a copy of the plain objects and arrays of the store rather than the ones the caller passed. A keyed write is made on a store read from the file, which the caller's value was copied into on the way in, so there is nothing of the caller's in it to copy.
		if (!this.#isInMigration && this.#validator) {
			if (!isFromFile) {
				value = copyStoreDeep(value);
			}

			this.#validate(value);
		}

		// A store read from the file, a rollback included, puts back what the file already held.
		if (!isFromFile && this.#writesJson) {
			checkWrittenValueTypes(value);
		}

		this.#write(value);
		this.events.dispatchEvent(new Event('change'));
	}

	/**
	The item a store holds under a key, or `fallback` where it holds none. A key is read the way the mode writes it: as the path it names with dot notation, and as the key itself without it, which is also how the defaults a key is reset to are recorded.

	An own key can hold `undefined`, which a custom deserializer can hand back where JSON cannot, and that counts as missing in both modes.
	*/
	#getItem(store: Partial<T>, key: string, fallback?: unknown): unknown {
		if (this.#options.accessPropertiesByDotNotation) {
			return getOwnProperty(store, key, fallback);
		}

		const value: unknown = store[key];
		return value === undefined ? fallback : value;
	}

	/**
	The store a read of the config file makes, which is a store the `defaults` option and the `default`s of its schema make where there is no file to read.

	A read made while a clearing is in hand does not clear the file again, whichever method made it, since the write of the cleared store can leave it as unreadable as the read that cleared it found it, which is what a `serialize` of the caller's that a `deserialize` does not read back does. Clearing it again would be a store that is written and cleared over and over until the stack runs out, so the read reports what it cannot read instead.
	*/
	#readStore(shouldValidate = true): T {
		// Kept for the clearing below, which needs the bookkeeping of a store it could parse and only failed to validate.
		let parsedStore: T | undefined;

		try {
			// Copy before validating, since validation changes the store in place and a custom deserializer can return an object that cannot be changed.
			const store = storeFromDeserialized<T>(this.#readConfigFile());
			parsedStore = store;

			if (shouldValidate && !this.#isInMigration) {
				this.#validate(store);
			}

			return store;
		} catch (error: unknown) {
			if ((error as any)?.code === 'ENOENT') {
				this.#ensureDirectory();

				// A store that does not exist is read as the store its `defaults` option and the `default`s of its schema make, which is what a write of it would make, so that a read and the write that follows it agree. The validator is run to write its `default`s in and is not asked to enforce the schema: there is no store to enforce it on, and enforcing it would make every read of a store whose file is gone fail, and with it every write, since a write reads the file first. A read that asks for the file as it is is given nothing, the same as one that is given a file that is there, and the file is not brought back, which is the write that does that.
				if (!shouldValidate || this.#isInMigration) {
					return createPlainObject<T>();
				}

				const store = this.#fillInDefaults(createPlainObject<T>());
				this.#validator?.(store);
				return store;
			}

			// A file that is not the format the store reads, whichever `deserialize` says so, one the key does not decrypt, and one the schema rejects are all cleared. Any other error, such as one a `deserialize` of the caller throws because a service it reads from is down, says the store cannot read the file right now rather than that the file is damaged, so it is thrown.
			if (this.#options.clearInvalidConfig && !this.#isClearing && (error instanceof SchemaViolationError || error instanceof DecryptionError || (error as Error)?.name === 'SyntaxError')) {
				return this.#clearStore(parsedStore);
			}

			throw error;
		}
	}

	/**
	The store as the user sees it. The keys this module keeps for its own bookkeeping are removed, so they never reach the public API.
	*/
	#readUserStore(): T {
		const store = this.#readStore();

		// The store is a fresh object, so it can be stripped in place.
		this.#detachReservedKeys(store);

		return store;
	}

	/**
	Remove the keys this module reserves for its own bookkeeping and return them, so the schema validator and the public API never see them. The passed store is changed in place, and every caller passes an object.
	*/
	#detachReservedKeys(store: T): T {
		const reservedData = createPlainObject<T>();

		for (const key of Object.keys(store)) {
			if (this.#isReservedKey(key)) {
				(reservedData as Record<string, unknown>)[key] = (store as Record<string, unknown>)[key];
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete (store as Record<string, unknown>)[key];
			}
		}

		return reservedData;
	}

	/**
	The plaintext of an encrypted config file. Only the legacy key salt is tried when `legacySaltOnly` is set, which `#readConfigFile()` uses for its second attempt.
	*/
	#decryptData(data: Uint8Array, encryptionKey: NonNullable<Options<T>['encryptionKey']>, legacySaltOnly = false): string {
		// Check if an initialization vector has been used to encrypt the data.
		const encryptionAlgorithm = this.#encryptionAlgorithm;
		if (data[16] !== separatorCodePoint) {
			if (encryptionAlgorithm === 'aes-256-cbc') {
				return uint8ArrayToString(data);
			}

			throw new DecryptionError('Failed to decrypt config data.');
		}

		const initializationVector = data.slice(0, 16);
		let ciphertext = data.slice(17);
		let authenticationTag: Uint8Array | undefined;

		if (encryptionAlgorithm === 'aes-256-gcm') {
			const authenticationTagStart = ciphertext.length - 16;
			if (authenticationTagStart < 0) {
				throw new DecryptionError('Failed to decrypt config data.');
			}

			authenticationTag = ciphertext.slice(authenticationTagStart);
			ciphertext = ciphertext.slice(0, authenticationTagStart);
		}

		// The second one is the legacy scheme (iv.toString() as salt)
		const salts: Array<string | Uint8Array> = legacySaltOnly
			? [initializationVector.toString()]
			: [initializationVector, initializationVector.toString()];

		for (const salt of salts) {
			try {
				const password = crypto.pbkdf2Sync(encryptionKey, salt, 10_000, 32, 'sha512');
				const decipher = crypto.createDecipheriv(encryptionAlgorithm, password, initializationVector);

				if (authenticationTag) {
					(decipher as crypto.DecipherGCM).setAuthTag(authenticationTag);
				}

				return uint8ArrayToString(concatUint8Arrays([decipher.update(ciphertext), decipher.final()]));
			} catch {}
		}

		if (encryptionAlgorithm === 'aes-256-cbc') {
			return uint8ArrayToString(data);
		}

		throw new DecryptionError('Failed to decrypt config data.');
	}

	#handleValueChange<Value>(
		getter: () => Value,
		callback: (newValue: Value, oldValue: Value | undefined) => void,
	): Unsubscribe {
		// The store may not be readable at this moment, for example while another process is writing it, and the caller is only setting up a listener, so the first change it reports has no value to compare with.
		let currentValue: Value | undefined;
		try {
			currentValue = getter();
		} catch {}

		const onChange = (): void => {
			// The store may not be readable at this moment, for example when another process is halfway through writing it, and this runs from the file watcher, where nothing can catch the error. A caller that reads the store itself still gets the error, and a later change is reported as usual.
			let newValue: Value;
			try {
				newValue = getter();
			} catch {
				return;
			}

			// What this listener last reported is read after the store, since a read that dispatches a change of its own, which is what a read that clears a damaged config file does, is reported by that dispatch, and reading it before would have this call report the same change a second time, or the older of the two values as the newer one.
			const oldValue = currentValue;

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

	// A text editor can save a file with a byte order mark, which is not part of the JSON. `JSON.parse` refuses it, while a JSON reader that takes a file is expected to skip it, so it is skipped here.
	#deserialize: Deserialize<T> = value => {
		const text = value.replace(/^\uFEFF/, '');

		try {
			return JSON.parse(text);
		} catch {
			// The error from `JSON.parse` quotes the part of the file around the failure, which is where a config file keeps whatever the caller did not mean to put in a log or a crash report, so what went wrong is reported as the file it is a part of.
			throw new SyntaxError(`The config file \`${this.path}\` is not valid JSON.`);
		}
	};

	#serialize: Serialize<T> = value => JSON.stringify(value, undefined, '\t');

	#validate(store: T): void {
		if (!this.#validator) {
			return;
		}

		// The keys this module reserves for its own bookkeeping are not part of the user's data, so the schema must not see them. It would otherwise reject them, or drop them when `removeAdditional` is set.
		const reservedData = this.#detachReservedKeys(store);

		const valid = this.#validator(store);
		const {errors} = this.#validator;

		Object.assign(store, reservedData);

		if (valid || !errors) {
			return;
		}

		const messages = errors
			.map(error => `\`${keyFromError(error)}\` ${error.message ?? ''}`);
		throw new SchemaViolationError('Config schema violation: ' + messages.join('; '));
	}

	#ensureDirectory(): void {
		// Ensure the directory exists as it could have been deleted in the meantime.
		fs.mkdirSync(path.dirname(this.path), {recursive: true});
	}

	#write(value: T): void {
		// The file is about to change, so any cached read is no longer trustworthy.
		this.#cachedStore = undefined;

		const serialized: unknown = this.#serialize(value);

		// A `serialize` that answers with neither text nor bytes would leave the file holding something no store can be read from, so it is refused before the file is touched.
		if (typeof serialized !== 'string' && !(serialized instanceof Uint8Array)) {
			throw new TypeError(`The \`serialize\` option must return a string or a \`Uint8Array\`, got ${serialized === null ? 'null' : typeof serialized}`);
		}

		let data: string | Uint8Array = serialized;

		const encryptionKey = this.#encryptionKey;
		if (encryptionKey) {
			const initializationVector = crypto.randomBytes(16);
			const password = crypto.pbkdf2Sync(encryptionKey, initializationVector, 10_000, 32, 'sha512');
			const cipher = crypto.createCipheriv(this.#encryptionAlgorithm, password, initializationVector);
			// A `serialize` that answers with bytes instead of a string is written as they are, the same way the read side takes them.
			const encryptedData = concatUint8Arrays([cipher.update(data), cipher.final()]);
			const encryptedParts = [initializationVector, Uint8Array.of(separatorCodePoint), encryptedData];

			if (this.#encryptionAlgorithm === 'aes-256-gcm') {
				encryptedParts.push((cipher as crypto.CipherGCM).getAuthTag());
			}

			data = concatUint8Arrays(encryptedParts);
		}

		this.#writeFile(data, this.#configFileMode);

		// What the file holds, which is what the watcher compares against so that this store's own write is not reported as a change from elsewhere. It is set only once the write has happened, since bytes that never reached the file are not what the file holds, and a later change that writes exactly those bytes is then reported like any other. Without a watcher nothing compares against it, so it is not kept.
		if (this.#options.watch) {
			this.#knownFileData = data;
		}
	}

	/**
	Write the given bytes to the config file, atomically where the platform allows it. A `mode` is given to the file, and without one a file that is already there keeps the mode it has.
	*/
	#writeFile(data: string | Uint8Array, mode: number | undefined): void {
		// Temporary workaround for Conf being packaged in an Ubuntu Snap app. See https://github.com/sindresorhus/conf/pull/82
		if (process.env.SNAP) {
			this.#writeInPlace(data, mode);
		} else {
			try {
				// No mode means the file is created with the mode `fs` gives a file, and a file that is already there keeps the mode it has.
				atomicWriteFileSync(atomicWritePath(this.path), data, {mode});
			} catch (error: unknown) {
				// Fix for https://github.com/sindresorhus/electron-store/issues/106. Sometimes on Windows, an atomic write fails with `EXDEV` (even though the temporary file is in the same directory), so we fall back to a write that is not atomic.
				if ((error as any)?.code !== 'EXDEV') {
					throw error;
				}

				this.#writeInPlace(data, mode);
			}
		}
	}

	/**
	Write the store without the temporary file and the rename, which the Snap workaround and the `EXDEV` fallback do.

	The write gives the mode to a file it creates, where the kernel reduces it, and leaves the mode of a file that is already there alone. A mode the caller gives is set on the second as well, since the option names the mode the file is given.
	*/
	#writeInPlace(data: string | Uint8Array, mode: number | undefined): void {
		// The atomic write makes the directory the file goes in, since the temporary file it writes first has to be put somewhere. This one has no temporary file, so the directory is made here instead, which for a link at the config path is the one it points at, since the write follows it as the atomic write does.
		fs.mkdirSync(path.dirname(atomicWritePath(this.path)), {recursive: true});

		// The write opens the file it writes, which a mode without the owner write bit refuses, and the atomic write renames a temporary file over the file instead, so the mode of the file that is there never comes into it. The write bit is given back for the write and put back afterwards, so that a file that is already there ends at the mode it had or the one the option names, whichever that is, and a store with no mode is in the same position as one whose mode leaves it read-only.
		const before = fs.statSync(this.path, {throwIfNoEntry: false})?.mode;
		// The file the write opens is the one that is there, so the mode that refuses it is the mode that file has and not the one the option names. A file that is not there yet is created with the mode the write opens it with, which the kernel reduces and never refuses.
		// eslint-disable-next-line no-bitwise
		const wasUnwritable = before !== undefined && (before & 0o200) === 0;

		if (wasUnwritable) {
			// eslint-disable-next-line no-bitwise
			fs.chmodSync(this.path, before | 0o200);
		}

		// The mode the option names is the mode the file is given on every write that goes in, a file already there included, which is what the option is for. A write that throws is not a write that went in, so it leaves the path behind as it is rather than naming a mode for it, which for a path that is not a file the write was making would be the mode of a directory the caller made.
		let written = false;

		try {
			fs.writeFileSync(this.path, data, {mode});
			written = true;
		} finally {
			// A file that is not there has no mode to put back, and a `chmod` of it would be the error a caller reads in place of the write's own, so the write's error is the one that says what happened.
			if (fs.existsSync(this.path)) {
				// A file that was left read-only goes back to the mode it had, which a temporary file would have been given, whether the write went in or not, since the write bit given for it is given back with it either way.
				if (written && mode !== undefined) {
					fs.chmodSync(this.path, mode);
				} else if (wasUnwritable) {
					fs.chmodSync(this.path, before);
				}
			}
		}
	}

	#watch(): void {
		this.#ensureDirectory();

		if (!fs.existsSync(this.path)) {
			this.#write(createPlainObject<T>());
		}

		// Both watchers report a change the same way, once a debounce has let a burst of events settle.
		const reportChange = (): void => {
			this.#cachedStore = undefined;

			// This store already dispatched a change for its own write, so the watcher only reports a change the file holds something else for. What the file was last known to hold is given up here, so a change that comes back to the same bytes is reported too.
			const knownData = this.#knownFileData;
			this.#knownFileData = undefined;
			if (knownData !== undefined && this.#fileHolds(knownData)) {
				return;
			}

			this.events.dispatchEvent(new Event('change'));
		};

		// Use fs.watch on Windows and macOS, fs.watchFile on Linux for better reliability
		if (process.platform === 'win32' || process.platform === 'darwin') {
			// An event is reported as the file is written, so the report is gathered for a moment to let a burst of them settle.
			this.#debouncedChangeHandler = debounceFn(reportChange, {wait: 100});

			// Watch the directory instead of the file to handle atomic writes (rename events). A write goes to the directory the config path resolves into, which is the one the path is in unless it is a symlink pointing somewhere else, so both are watched. A link that is repointed after this is not followed.
			this.#watchFile(atomicWritePath(this.path));
			this.#watchFile(this.path);

			return;
		}

		// `fs.watchFile` polls, and its default interval of 5007 ms would report a change to the caller about six seconds later.
		this.#debouncedChangeHandler = debounceFn(reportChange, {wait: 1000});

		this.#watchFileListener = () => {
			this.#debouncedChangeHandler?.();
		};

		fs.watchFile(this.path, {persistent: false, interval: 500}, this.#watchFileListener);
	}

	/**
	Watch the directory one of the files the config is read from is in, so that a change to either of them is reported however the file itself was written. A file that already has a watcher is left as it is, since one watcher for a directory is told about the events of every file in it and answers for the name of only one of them.

	The name the watcher reports is compared as the bytes it stands for rather than as text, since a name holding half of a surrogate pair is written to the file system as a replacement character and read back as one, so the string that comes back is not the string the file was written under and every change to the file is then taken for a change to a file beside it.

	A name that is not the bytes the path was written with is still a name the file system may be holding this file under, since a volume is free to spell a name with a case and a form of its own, so the file system is asked whether the two are one file.
	*/
	#watchFile(file: string): void {
		if (this.#watchers.has(file)) {
			return;
		}

		const directory = path.dirname(file);
		const basename = Buffer.from(path.basename(file));
		fs.mkdirSync(directory, {recursive: true});
		this.#watchers.set(file, fs.watch(directory, {persistent: false, encoding: 'buffer'}, (_eventType, filename) => {
			if (filename && !filename.equals(basename) && !isSameFile(path.join(directory, filename.toString('utf8')), file)) {
				return;
			}

			this.#debouncedChangeHandler?.();
		}));
	}

	/**
	Run the steps the store has not run yet. `storedData` is the store as the file holds it, bookkeeping included, which the caller has just read.
	*/
	#migrate(migrations: Migrations<T>, versionToMigrate: string, beforeEachMigration: BeforeEachMigrationCallback<T> | undefined, storedData: T): void {
		// A store that holds no version has to be told apart from one that records `0.0.0`, since the migrations run for the first and not for the second.
		const storedVersion = getOwnProperty(storedData, MIGRATION_KEY) as string | undefined;
		const storedCompletedRanges = getOwnProperty(storedData, COMPLETED_RANGE_MIGRATIONS_KEY);
		const completedRanges = new Set(Array.isArray(storedCompletedRanges) ? storedCompletedRanges.filter(item => typeof item === 'string') : []);

		// An earlier version of this module could leave a range in the file when a migration failed partway through. A range cannot be compared as a version, so it counts as no version at all and the migrations run again.
		const previousMigratedVersion = storedVersion === undefined || isVersionInRangeFormat(storedVersion) ? undefined : storedVersion;

		// A hook compares the versions it is told, so it is told versions. A step that runs for a range runs at the lowest version the branch of the range the project version is in matches.
		// Sort by version, since the order the migrations are defined in is not necessarily the order they have to run in. A range is ordered by the version it runs at, so `>=2.0.0` runs after `1.5.0`.
		const steps = Object.keys(migrations)
			.filter(candidateVersion => shouldPerformMigration(candidateVersion, previousMigratedVersion, versionToMigrate) && !isCompletedRange(candidateVersion, versionToMigrate, completedRanges))
			.map(version => ({version, toVersion: versionToCompare(version, versionToMigrate)}))
			.sort((first, second) => semver.compare(first.toVersion, second.toVersion));

		const versionsToRun = steps.map(({toVersion}) => toVersion);

		// The version a step is migrated from is the one the step before it reached, so a step that runs for a range is followed by a step that is migrated from the version that range reached.
		let fromVersion = previousMigratedVersion ?? '0.0.0';

		// The bookkeeping is part of what a step changes, so the backup holds it as well as the items. A backup of the items alone would put back the file the failed step left the bookkeeping in. Each read is a store of its own, and nothing writes into one once it is read, so the backup is the store as it was read.
		let storeBackup = storedData;

		for (const {version, toVersion} of steps) {
			// The store this step leaves in the file, which is what the snapshot below is taken from, so a step reads the file once rather than once for the version it records and once more to read back what it has just written.
			let snapshot: T;

			try {
				if (beforeEachMigration) {
					beforeEachMigration(this, {
						fromVersion,
						toVersion,
						finalVersion: versionToMigrate,
						// A copy, since the context is the hook's own and a hook that changes the list it is given is not telling the step after it something the pass does not run, the same way a change it makes to `fromVersion` or `toVersion` is not one.
						versions: [...versionsToRun],
					});
				}

				const migration = migrations[version];
				migration?.(this);

				fromVersion = toVersion;

				if (isVersionInRangeFormat(version)) {
					completedRanges.add(completedRangeFor(version, versionToMigrate));
					snapshot = this.#setBookkeeping(COMPLETED_RANGE_MIGRATIONS_KEY, [...completedRanges], this.#readStore());
				} else {
					const store = this.#readStore();
					// The recorded version never moves backwards, which is what keeps a store opened at an older project version from running the steps a newer one already ran. A step of another store in the middle of this pass can have moved it further than the pass is at, so what the file holds is what this step is compared against. A file can hold a range where an earlier version of this module left one, which is no version to compare with and is what this step replaces.
					const recorded = getOwnProperty(store, MIGRATION_KEY) as string | undefined;
					snapshot = movesForward(version, recorded) ? this.#setBookkeeping(MIGRATION_KEY, version, store) : store;
				}

				storeBackup = snapshot;
			} catch (error: unknown) {
				// Restore the backup, which is skipped during a migration because the store is validated when it is read rather than on the way in. The file holds the failed step's writes, and a step that left a file the store cannot read is no reason to leave them in it: the write puts back the store the file held before the step, so there is nothing of another key's in it to throw away.
				//
				// Another store CAN write the file while a migration runs, and what it wrote while the failing step ran goes back to where it was, with the recorded version rewound to what the last step that succeeded had recorded, since the backup is the file as that step left it and a step this pass already ran is not run again over changes that were kept. A write that landed before that point is in the backup and stays. That is the self-healing answer rather than the careful one: which keys in the file this pass put there is not knowable, so any merge is a guess, and a rewind makes the other store's step run again on the next open, which is what puts its data back. Keeping the version forward instead would leave that step permanently lost, since the version would say it ran while what it wrote has been rolled back.
				// The backup was read from this file and carries the bookkeeping already, so it is written as a store read from the file.
				this.#writeStore(storeBackup, true);

				const errorMessage = error instanceof Error ? error.message : String(error);
				throw new Error(`Something went wrong during the migration! Changes applied to the store until this failed migration will be restored. ${errorMessage}`);
			}
		}

		// Record the version a store with no version has reached, and only ever move the recorded one forward. An app that runs an older `projectVersion` than the store was migrated with must not rewrite the recorded version, since the migrations would then run again on the next upgrade.

		// What the file holds is what it is compared against only where a step of this pass ran, since a step of another store in the middle of the pass can have moved the recorded version further than this pass is at, which is what a step that opens a second store on the same file does. A pass that ran no step wrote nothing and there is no other step in the middle of it, so what this pass started from is what the file holds, and the file is not read for it: a store whose recorded version already matches would otherwise pay a read of the whole config file, and a key derivation for an encrypted one, on every single construction.
		const store = steps.length > 0 ? this.#readStore() : storedData;

		if (movesForward(versionToMigrate, getOwnProperty(store, MIGRATION_KEY) as string | undefined)) {
			this.#setBookkeeping(MIGRATION_KEY, versionToMigrate, store);
		}
	}

	#throwIfReservedKey(key: unknown): void {
		if (this.#containsReservedKey(key)) {
			throw new TypeError(`Please don't use the ${INTERNAL_KEY} key, as it's used to manage this module internal operations.`);
		}
	}

	#containsReservedKey(key: unknown): boolean {
		if (typeof key === 'string') {
			return this.#isReservedKey(key);
		}

		if (!key || typeof key !== 'object') {
			return false;
		}

		// Only the keys at the top level are the module's own. A `__internal__` deeper in the object is the caller's data, which cannot reach the reserved key.
		return Object.keys(key).some(candidateKey => this.#isReservedKey(candidateKey));
	}

	/**
	Whether a key that is passed to `set()` or `delete()` reaches the key this module keeps its bookkeeping under, which both refuse, and whether a key of the store is that bookkeeping itself, which `#detachReservedKeys()` takes out of the caller's view. `dot-prop` normalizes a dot-notation key before it writes, so a key such as `\__internal__` or `__internal__[0]` reaches it as well. Without dot notation the key is used as it is, so only the exact key is the module's own there, and a literal `__internal__.foo` is the caller's data.
	*/
	#isReservedKey(key: string): boolean {
		if (!this.#options.accessPropertiesByDotNotation) {
			return key === INTERNAL_KEY;
		}

		// `dot-prop` reads a key as a path only for a `.`, a `[`, a `]` and a `\`, so a key with none of the four is a key of its own, and it is the bookkeeping only when it spells the bookkeeping. Answered without parsing, since a read asks this of every key the store holds and a store with many keys would otherwise have each of them parsed on every read.
		if (!key.includes('.') && !key.includes('[') && !key.includes(']') && !key.includes('\\')) {
			return key === INTERNAL_KEY;
		}

		const path = keyPath(key);

		// A key that cannot be parsed is reported by the write or the delete itself.
		if (path === undefined) {
			return false;
		}

		// A key that spells itself with a backslash is a key of its own, so the name behind the backslash is what the store holds, and that name is asked the same question the path is. A key that reaches the bookkeeping by either spelling reaches it, so `__internal__.foo` is refused where the spelling that writes the same name is.
		const [first] = path;
		return first === INTERNAL_KEY || keyPath(String(first))?.[0] === INTERNAL_KEY;
	}

	/**
	Write a key of the module's own bookkeeping into a store the caller has read, and put that store in the file. The store is taken as an argument so that a caller which has already read the file does not read it again only to write back what it has. The store it returns is the one the write was given, which is what the file holds afterwards except where the `defaults` option filled a key into it and the write filled that into a copy instead.

	A file can hold anything under the key this module reserves for itself, and an array along the path of a bookkeeping key cannot hold the key. Such a value is no bookkeeping at all, since it holds neither the `migrations` nor the `version` to read it out of, so it is taken away first rather than refusing every write for the rest of the life of the file.
	*/
	#setBookkeeping(key: string, value: unknown, store: T): T {
		detachUnwritableBookkeeping(store, parsePath(key));

		setOwnProperty(store, key, value);

		this.#writeStore(store, true);
		return store;
	}

	/**
	Write one key into a store the caller has already read and is going to write back. It is what `set()` and `appendToArray()` both write through, so that the array an append reads and the one it writes are the same store rather than two reads of a file that another process can change in between.
	*/
	#setValue(store: T, key: string, value: unknown): void {
		// The value is not asked about here, since both methods that reach this one have already asked whether it is one the store can hold. Asking again walks the value a second time, which reads every getter in it a second time, so a value whose getters answer differently is a value the file holds that the caller never passed.
		if (this.#options.accessPropertiesByDotNotation) {
			setOwnProperty(store, key, value);
			return;
		}

		// The store has no prototype to write through, so a key such as `__proto__` becomes an ordinary own key here. With dot notation the same keys are refused when `dot-prop` parses the path, which is where the silent skip of that mode comes from.
		store[key as keyof T] = value as T[keyof T];
	}

	/**
	Refuse a key the path parser cannot read, which is a question about the key and not about the store, so `set()` asks it before the file is read rather than leaving it to the write below, which has already read a file that a read may have cleared. `reset()`, `delete()` and `appendToArray()` ask the same question the same way, for the same reason. Without dot notation no key is read as a path, so there is no path for the parser to refuse.
	*/
	#throwIfKeyCannotBeWritten(key: string): void {
		if (this.#options.accessPropertiesByDotNotation) {
			keyPathOrReport(key);
		}
	}

	/**
	The store as it is held in the config file. A wrong key salt does not always throw, since the cipher can also decrypt to data with valid padding, so a plaintext that does not deserialize is tried again with the legacy key salt.
	*/
	#readConfigFile(): T {
		const encryptionKey = this.#encryptionKey;
		if (!encryptionKey) {
			return this.#deserialize(fs.readFileSync(this.path, 'utf8'));
		}

		const data = fs.readFileSync(this.path);
		// A file the key does not decrypt with either salt is reported as it is, since the retries below are for a plaintext that decrypted but does not deserialize.
		const plaintext = this.#decryptData(data, encryptionKey);

		try {
			return this.#deserialize(plaintext);
		} catch (error) {
			try {
				return this.#deserialize(this.#decryptData(data, encryptionKey, true));
			} catch {
				// `aes-256-cbc` reads a config file that is not encrypted for backward compatibility, and a wrong key salt can decrypt to data with valid padding, which is then not readable. The file is read as it is where that is a store.
				if (this.#encryptionAlgorithm === 'aes-256-cbc') {
					try {
						return this.#deserialize(uint8ArrayToString(data));
					} catch {}
				}

				// Report the first failure, which is the more likely cause.
				throw error;
			}
		}
	}

	/**
	Whether the store is written as JSON, which is what the checks of a value against what JSON can hold are for.
	*/
	get #writesJson(): boolean {
		return !this.#options.serialize;
	}

	/**
	The store the reads answer from, which is the cache itself where the `cache` option keeps one. The cache is frozen, so a caller that changes what it was handed is told so rather than changing the cache, which every later read would then be wrong about. Freezing it once costs about what one read of the file does, where a copy on every read would cost that on every read.
	*/
	#readableStore(): T {
		if (!this.#options.cache) {
			return this.#readUserStore();
		}

		this.#cachedStore ??= freezeStoreValue(this.#readUserStore());
		return this.#cachedStore;
	}

	/**
	Whether the config file still holds the given bytes, which is what a write of this store put in it and already dispatched a change for.
	*/
	#fileHolds(data: string | Uint8Array): boolean {
		try {
			const file = fs.readFileSync(this.path);
			return file.length === Buffer.byteLength(data) && file.equals(Buffer.from(data));
		} catch {
			// A file that cannot be read is a change to report.
			return false;
		}
	}

	/**
	An empty store, written over a file that is damaged, so the damage is not read as an empty store again on every read and the file is left as a store. Nothing is written from a migration, where the file is what the migrations repair.
	*/
	#clearStore(parsedStore?: T): T {
		const store = this.#fillInDefaults(createPlainObject<T>());

		// A store the schema still rejects cannot be written, since that would leave the file in the state it was cleared from, and it would be read and cleared again on every read. During migrations, fill in schema defaults without enforcing the schema, since the migrations may repair the cleared store before construction validates it.
		if (this.#isInMigration) {
			this.#validator?.(store);
		} else {
			this.#validate(store);
		}

		// The bookkeeping the file holds is kept, the way a store written whole keeps it, so a migration is not run again over a store that was cleared. A file that could not be parsed has none to keep.
		const bookkeeping = (parsedStore as Record<string, unknown> | undefined)?.[INTERNAL_KEY];
		if (bookkeeping !== undefined) {
			(store as Record<string, unknown>)[INTERNAL_KEY] = bookkeeping;
		}

		if (!this.#isInMigration) {
			this.#ensureDirectory();

			// The file is the config, so writing it is a change to the config, and it is reported the way a write through the `store` setter is. A listener reads the cleared store, which is what the file now holds, so the read it makes does not clear anything again: a `serialize` of the caller's that writes a file the store cannot read back is one a clearing does not repair, and a read that cleared it here would write and clear over and over, once for the read each listener makes, until the stack runs out.
			//
			// A listener the change reached may also have written in it, which the write this read was part of is made on top of, so the file is read again for what it holds now. Handing the caller the store that was written above would have a write of its own, or a read that becomes the cache, take the value the listener wrote with it.
			// The read does not clear the file, since the write above left it as unreadable as this read found it where a `serialize` of the caller's is not one a `deserialize` reads back.
			//
			// The clearing is in hand for the write as well as the change and the read, since a `serialize` of the caller's is given the store and may read the config to make its answer. That read finds the file as damaged as the one that led here, and a clearing it made would write and clear over and over, once for the read each `serialize` makes, until the stack runs out.
			this.#isClearing = true;
			try {
				this.#write(store);
				this.events.dispatchEvent(new Event('change'));
				return this.#readStore();
			} finally {
				this.#isClearing = false;
			}
		}

		return store;
	}

	#prepareOptions(partialOptions: Readonly<Partial<Options<T>>>): Partial<Options<T>> {
		// An option that is explicitly set to `undefined` means the same as not passing it at all, so it must not override the default below.
		const definedOptions = omitUndefined(partialOptions) as Partial<Options<T>>;

		// The defaults are applied after the options rather than before them, so that an option the caller set to `undefined` or to `null` gets the default instead of overwriting it. `omitUndefined()` above has already dropped the options set to `undefined`, and `??` gives the default to an option set to `null`.
		const options: Partial<Options<T>> = {
			...definedOptions,
			configName: definedOptions.configName ?? 'config',
			fileExtension: definedOptions.fileExtension ?? 'json',
			projectSuffix: definedOptions.projectSuffix ?? 'nodejs',
			clearInvalidConfig: definedOptions.clearInvalidConfig ?? false,
			accessPropertiesByDotNotation: definedOptions.accessPropertiesByDotNotation ?? true,
		};

		// The keys of the `defaults` option are read again on every write, and the option is the caller's own object, so its key set is taken as a copy here. Without this a key the caller ADDS afterwards would be written in, since the two halves of the same object would disagree about what the option names, and two stores built from one object would each write a key neither of them was given.
		//
		// Its values are copied the same way, and for the same reason. A key the store does not hold is filled in by the write from the option rather than from what `#applyDefaultValues()` recorded of it, so a value the caller CHANGES afterwards would be written in there while a `reset()` and a `clear()` write back the value this store recorded, and the one key would have two different defaults. The value is taken the way `#applyDefaultValues()` takes it, so the two are the same value, and it is checked on the value the caller gave before that copy is made, since a copy of a value that holds itself names a different edge of the loop than the value does.
		// A `null` is the same as not passing the option, which is how every option here is read.
		if (options.defaults !== undefined && options.defaults !== null) {
			// A key set to `undefined` is the same as one that is not passed, so it is left out of the copy, and nothing that reads the option has to skip it.
			const definedDefaults = Object.entries(omitUndefined(options.defaults));
			for (const [key, value] of definedDefaults) {
				checkValueType(key, value, !options.serialize);
			}

			options.defaults = Object.fromEntries(definedDefaults.map(([key, value]) => [key, ownValue(value, !options.serialize)])) as NonNullable<Options<T>['defaults']>;
		}

		options.encryptionAlgorithm ??= defaultEncryptionAlgorithm;

		if (!supportedEncryptionAlgorithms.has(options.encryptionAlgorithm)) {
			throw new TypeError(`The \`encryptionAlgorithm\` option must be one of: ${[...supportedEncryptionAlgorithms].join(', ')}`);
		}

		// Every use of the key asks whether it is there, so an empty key means no encryption at all, which is what leaving the option out means. Refuse it rather than write a store the option says is encrypted in plain text. An empty `Uint8Array` is not nothing, since the encryption asks for it and applies it both ways, and a `null` is the same as not passing the option, which is how every option here is read.
		if ('encryptionKey' in options && options.encryptionKey !== null && !options.encryptionKey) {
			throw new TypeError('The `encryptionKey` option must not be empty, since an empty key leaves the store in plain text.');
		}

		assertMigrations(options.migrations);

		if (!options.cwd) {
			if (!options.projectName) {
				throw new Error('Please specify the `projectName` option.');
			}

			options.cwd = envPaths(options.projectName, {suffix: options.projectSuffix}).config;
		}

		return options;
	}

	#setupValidator(options: Partial<Options<T>>): void {
		// A `schema` that is not an object is refused, falsy or not, so `schema: isDev && {…}` is told the flag was the wrong type rather than taken for no schema at all.
		assertObjectOption('schema', options.schema);
		// The same for the other two, which are asked before the check that skips a validator altogether, so a falsy one is not taken for none.
		assertObjectOption('rootSchema', options.rootSchema);
		assertObjectOption('ajvOptions', options.ajvOptions);

		if (!(options.schema ?? options.ajvOptions ?? options.rootSchema)) {
			this.#applyDefaultValues(options);
			return;
		}

		// The `properties` keyword belongs to the `schema` option. The type does not exclude it from `rootSchema`, so a schema object typed as a whole is taken, and it would otherwise be dropped without a word.
		if (options.rootSchema && 'properties' in options.rootSchema) {
			throw new TypeError('The `rootSchema` option must not contain a `properties` key. Use the `schema` option for properties.');
		}

		// The `type` of the store is the module's to write, the way its `properties` are, since a config file holds an object and nothing else. The schema below is built with `type` after the `rootSchema` is spread into it, so a `type` the caller wrote that is not an object is dropped without a word and the store is validated as the object it is rather than as what the caller asked for.
		const namedType = (options.rootSchema as {type?: unknown} | undefined)?.type;
		if (namedType !== undefined && !(Array.isArray(namedType) ? namedType : [namedType]).includes('object')) {
			throw new TypeError(`The \`rootSchema\` option must not name a \`type\` other than \`object\`, since a store is always an object, got \`${JSON.stringify(namedType)}\`.`);
		}

		// A key of `ajvOptions` set to `undefined` is the same as one that is not passed, the way it is for every other option of this module, so it is taken out before the object is spread into the validator. Otherwise `{useDefaults: undefined}` would turn off one of the two defaults below.
		const ajvOptions = omitUndefined(options.ajvOptions ?? {});

		// Workaround for https://github.com/ajv-validator/ajv/issues/2047
		const ajvFormats = ajvFormatsModule.default;

		const ajv = new Ajv({
			allErrors: true,
			useDefaults: true,
			...ajvOptions,
		});
		ajvFormats(ajv);

		// Every key of the `schema` option is looked at whatever the validator is asked to do, so the same schema is legal or illegal either way. A `default` the validator is not asked to apply is not recorded, or `clear()` and `reset()` would give a store a value a fresh store of the same options does not have.
		// `useDefaults` is `true`, `false` or `'empty'`, where the last applies a default not only where a value is missing but where one is `null` or the empty string, which is what `ajv` counts as empty for the purpose. All three apply the defaults, so all three are recorded here, and only `false` turns them off.
		//
		// The `default`s are recorded, and so refused where a store cannot hold one, BEFORE the schema is compiled, because the compiler writes each of them into the code it generates and so stringifies a value the store cannot hold, which is where a caller would otherwise meet `ajv`'s own error rather than this module's. The record needs no validator, so nothing here waits on one.
		this.#captureSchemaDefaults(options.schema as Record<string, ValueSchema> | undefined, '', ajvOptions.useDefaults !== false);

		this.#applyDefaultValues(options);
		// A parent option default replaces the captured value, so fill its missing schema defaults back into the private tree used by reset and ancestor overrides.
		this.#captureSchemaDefaults(options.schema as Record<string, ValueSchema> | undefined, '', ajvOptions.useDefaults !== false);

		const schema: JSONSchema = {
			...options.rootSchema,
			type: 'object',
			properties: this.#propertiesWithOverriddenDefaults(options.schema),
		};

		this.#validator = ajv.compile(schema);
	}

	/**
	The keys along a `defaults` path, named in the `properties` of the schema so a rule that covers the keys the schema does not know does not take the path for one of them. Naming a key says nothing about the value it holds, which is what keeps a store that holds something else there from being reported over a default the store could not write, and only the keys on the way to the one the path names are named, since those are the ones such a rule would take. The path is filled in by the `defaults` option and not by the validator, so none of the keys on the way is given a `default`, and a key the schema already names keeps what it says about it. The last key is given the value the option gives it as its `default`, so a `default` the schema gives it does not win where the validator fills one in. A key a rule of the level says what the value under it has to be is left to that rule instead, which checks it the way it checks a `set()` of the same value.
	*/
	#declareDefaultsPath(level: ValueSchema | undefined, properties: Record<string, ValueSchema>, path: ReadonlyArray<string | number>, value: unknown): void {
		for (const [index, part] of path.entries()) {
			const key = String(part);

			if (properties[key] === undefined) {
				if (holdsValueRule(level, key)) {
					return;
				}

				properties[key] = true;
			}

			// Nothing below the last key is named, since a level the schema says nothing about the keys of has no rule that could take one for the rest of the path.
			let definition = properties[key];
			if (index === path.length - 1) {
				// The value the option gives is the `default` of the last key, the way it is for a key at the root, so a `default` the schema gives the same key does not win over it where the validator fills it in. A false schema prohibits the value, so its default must not bypass that rule.
				if (definition !== false) {
					properties[key] = definition === true ? {default: value} : {...definition, default: value};
				}

				return;
			}

			// A level the schema says nothing about the keys of is a level where nothing below it is named, so a `properties` is made for the rest of the path to be named in when the level has a rule that would take one, and it is left alone when it does not. A level that is not an object at all takes no keys.
			if (typeof definition !== 'object' || definition === null) {
				return;
			}

			// The validator inserts an ancestor's default before looking at its children, so use the complete private defaults tree, which already holds the option overrides and nested schema defaults. Copy it first so the schema and validator never share mutable defaults with reset.
			if (definition.default !== undefined) {
				const parentKey = keyOfPath(path.slice(0, index + 1));
				definition = {...definition, default: ownValue(this.#getItem(this.#defaultValues, parentKey), this.#writesJson)};
				properties[key] = definition;
			}

			const existing = typeof definition.properties === 'object' && definition.properties !== null && !Array.isArray(definition.properties) ? definition.properties as Record<string, ValueSchema> : undefined;
			// The two rules are read as they are rather than through the type of the schema, which writes them as the ones it allows rather than the ones it refuses.
			const {additionalProperties, unevaluatedProperties} = definition as {additionalProperties?: unknown; unevaluatedProperties?: unknown};
			const takesUnknownKeys = additionalProperties === false || unevaluatedProperties === false;

			if (existing === undefined && !takesUnknownKeys) {
				return;
			}

			// The definition below a key of the schema is the caller's and the keys the rest of the path is named in are written into it, so the one they are written into is a copy of it.
			const nested = Object.assign(createPlainObject<Record<string, ValueSchema>>(), existing);
			level = {...definition, properties: nested};
			properties[key] = level;
			properties = nested;
		}
	}

	/**
	The `properties` of the schema, where the `default` of a key the `defaults` option covers is the value the option gives it.

	The option overwrites the `default` of the schema, and the validator inserts that default for a key the store does not hold, which happens before the option is merged in. The option's value is what it inserts instead, so that key reads as the option says. The default is given a value rather than taken away, since the validator applies it before it checks a rule the default satisfies, such as `required`.
	*/
	#propertiesWithOverriddenDefaults(schema: Schema<T> | undefined): Record<string, ValueSchema> | undefined {
		if (!this.#options.defaults) {
			// A `schema` of `null` is the same as none, which is what the check above takes it for, and handing the validator `properties: null` is a schema it refuses to compile rather than one that validates nothing.
			return (schema ?? undefined) as Record<string, ValueSchema> | undefined;
		}

		const properties: Record<string, ValueSchema> = omitUndefined(schema ?? {});

		for (const [key, value] of this.#orderedDefaults) {
			const path = this.#options.accessPropertiesByDotNotation ? keyPath(key) : [key];

			// With dot notation, a key the parser refuses is left to `#applyDefaultValues()`, which reports it, so that it is reported once and with a message that names the option it came from.
			if (path === undefined) {
				continue;
			}

			// A key that names a path with dot notation is stored as that path, so the validator must not be given a property of the same name spelled literally, which it would write beside the path. The `defaults` option fills the path in instead, the way it is read and reset, and the keys along it are named so a rule covering the keys the schema does not know does not take the path for one of them.
			if (this.#options.accessPropertiesByDotNotation && path.length > 1) {
				this.#declareDefaultsPath(this.#options.rootSchema, properties, path, value);
				continue;
			}

			// A key that spells itself with a backslash is a key of its own, so the name behind the backslash is the key the store holds and the one the validator writes, and giving the validator the spelling would add a second key that nothing can reach.
			const name = this.#options.accessPropertiesByDotNotation ? String(path[0]) : key;

			// A false schema expressly prohibits the value, so its default must not bypass that rule.
			if (properties[name] === false) {
				continue;
			}

			// A key that is not in the schema yet and a rule of the `rootSchema` says what the value under it has to be is left to that rule, which checks the value the same way it checks one a `set()` wrote. Naming it here as well would take it out of the reach of every rule but this one, and a value the option gave it would then reach the file whatever that rule says about it.
			if (properties[name] === undefined && holdsValueRule(this.#options.rootSchema, name)) {
				continue;
			}

			const definition = properties[name];
			properties[name] = definition === true || definition === undefined ? {default: value} : {...definition, default: value};
		}

		return properties;
	}

	/**
	The `default` of every key of the schema, which is what a `reset()` or a `clear()` writes back for it.

	With dot notation the properties below the root are known by the path to them, so a `default` that sits below the root is captured under that path and a reset of it restores the value, the same as for a `default` at the root. An optional object omitted from a parent default must have a default of its own for its descendants to be captured. Without dot notation a key below the root has no key of its own to be reset through, so only the root is looked at.
	*/
	#captureSchemaDefaults(schemaConfig: Record<string, ValueSchema> | undefined, prefix: string, recordDefaults: boolean): void {
		const parentDefault = prefix === '' ? missingKey : this.#getItem(this.#defaultValues, prefix, missingKey);
		const schemaEntries = Object.entries(schemaConfig ?? {}) as Array<[string, JSONSchema | undefined]>;
		for (const [key, schemaDefinition] of schemaEntries) {
			if (!schemaDefinition || typeof schemaDefinition !== 'object') {
				continue;
			}

			// A name below the root is a key of its own whatever it holds, such as `example.com`, so it is escaped where it becomes a part of the path a `default` is recorded under.
			const dotKey = prefix === '' ? key : `${prefix}.${keyOfPath([key])}`;

			// The bookkeeping is written at the top of the store and nothing below it, so only a key at the top is the module's own. A `__internal__` below the top is the caller's data, which cannot reach it, the same as a `__internal__` below the top of a `set()` or of the `defaults` option. A `default` for one at the top is written by a `clear()` where nothing ever reads it, over the bookkeeping itself, so it is refused the way the `defaults` option refuses one.
			if (prefix === '' && this.#isReservedKey(key)) {
				throw new TypeError(`The \`schema\` option must not contain the key \`${dotKey}\`, which is the one this module keeps its bookkeeping under.`);
			}

			// A property name is a key the validator writes into the store as it is, at the level it is given, so a root name that is not a key of its own could not be written back under that name. The `properties` of a key are what holds the keys below the root, and a name there only has to be one a value can be written to.
			if (this.#options.accessPropertiesByDotNotation) {
				const refusedFor = prefix === '' ? whyKeyIsRefused(key) : (keyPath(dotKey) === undefined ? unwritableKeyReason : undefined);
				if (refusedFor !== undefined) {
					throw new TypeError(`The \`schema\` option must not contain the key \`${dotKey}\`, ${refusedFor}`);
				}
			}

			// An entry set to `undefined` is the same as one without a `default`.
			const {default: defaultValue, properties} = schemaDefinition as {default?: unknown; properties?: unknown};
			const hasDefault = Object.hasOwn(schemaDefinition, 'default') && defaultValue !== undefined;

			if (hasDefault && this.#options.ajvOptions?.useDefaults !== false) {
				// A `default` a store cannot hold is refused where the option is read, the same as one the `defaults` option gives, rather than written as whatever JSON makes of it and left failing every later `clear()` and `reset()`. It is checked even when its optional container is absent, so capturing only reachable defaults does not change which schema values are allowed.
				checkValueType(dotKey, defaultValue, this.#writesJson);
				if (recordDefaults) {
					this.#storeSchemaDefault(dotKey, defaultValue);
				}
			}

			// The properties below are only reached where a value can hold them: a `default` that is not an object is what the key reads as, and the validator never looks below it.
			const effectiveDefault = this.#getItem(this.#defaultValues, dotKey, missingKey);
			const canHoldChildren = effectiveDefault === missingKey || (typeof effectiveDefault === 'object' && effectiveDefault !== null);
			if (this.#options.accessPropertiesByDotNotation && typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
				// Extend containers a default supplies, without creating optional objects absent from that default. A parent with no default still records its descendants for resetting individual paths.
				const recordChildren = recordDefaults && canHoldChildren && (parentDefault === missingKey || effectiveDefault !== missingKey);
				this.#captureSchemaDefaults(properties as Record<string, ValueSchema>, dotKey, recordChildren);
			}
		}
	}

	/**
	A `default` of the schema stored under the key the item is known by.

	With dot notation the key names a path, and a path write below it, from a `defaults` key such as `a.b`, merges into an object stored here, so an object is stored as its own copy and the write cannot reach into the schema the caller gave.
	*/
	#storeSchemaDefault(dotKey: string, defaultValue: unknown): void {
		// Keep a default already supplied by an ancestor or the options in either access mode.
		if (this.#getItem(this.#defaultValues, dotKey, missingKey) !== missingKey) {
			return;
		}

		if (!this.#options.accessPropertiesByDotNotation) {
			(this.#defaultValues as Record<string, unknown>)[dotKey] = ownValue(defaultValue, this.#writesJson);
			return;
		}

		// A `default` the place already holds is the one the validator keeps, since it inserts the value above it as it is and only writes a default below it where that value does not name the key. A path the `default` above it cannot take is left unrecorded, since what the value above it is recorded as is not a container and a key written into it is one the file never holds.
		if (whereWriteIsBlocked(this.#defaultValues, dotKey) !== undefined) {
			return;
		}

		// A `default` of the schema sits at a property name the validator writes as a key of an object, so it is recorded as one, which a numeric part of the path would otherwise have made an index into an array.
		setOwnProperty(this.#defaultValues, dotKey, ownValue(defaultValue, this.#writesJson), true);
	}

	#applyDefaultValues(options: Partial<Options<T>>): void {
		if (!options.defaults) {
			return;
		}

		// A key set to `undefined` is the same as one that is not passed, so the `default` of the schema is kept for it, and a reset restores that default. `#prepareOptions()` has already left such a key out.
		// A default is written to the file under the key it names, so the reserved key is refused here as well, the way `set()` refuses it.
		this.#throwIfReservedKey(options.defaults);

		if (this.#options.accessPropertiesByDotNotation) {
			// The key names a path, so it is stored where a read or a reset of that path looks for it, and a value that writes itself is stored as what it writes, which is what the validator writes the `default` of the schema as and therefore what a reset has to write back for it to be one the store accepts. The containers the path passes through are copied first, so a key that names a path below another is written into a copy and not into the object the caller gave. The store these are written into is this module's own, so only the containers below its top are copied.
			for (const [key, value] of this.#orderedDefaults) {
				// A key `dot-prop` refuses is a key nothing can be written to, so there is nowhere to write it. It is reported here the way the reserved key is, instead of being dropped without a word.
				if (keyPath(key) === undefined) {
					throw new TypeError(`The \`defaults\` option cannot hold the key \`${key}\`, ${unwritableKeyReason}`);
				}

				// A path the default of the key above it cannot take, such as `a.b` beside an `a` of `1`, is left unrecorded, the way a `default` of the schema is, since the value above it is not a container and a key written into it is one the file never holds. The store keeps the default above it.
				if (whereWriteIsBlocked(this.#defaultValues, key) !== undefined) {
					continue;
				}

				setOwnProperty(this.#defaultValues, key, ownValue(value, this.#writesJson));
			}

			return;
		}

		// The value is taken as a copy, the way a `default` of the schema is, so a change the caller makes to the object the option holds afterwards is not what a `reset()` or a `clear()` writes back.
		Object.assign(this.#defaultValues, Object.fromEntries(this.#orderedDefaults.map(([key, value]) => [key, ownValue(value, this.#writesJson)])));
	}

	/**
	A copy of the given value with the `defaults` option applied for the keys it covers that the value does not hold, which is what a store that is written whole looks like.

	With dot notation the key of a default names a path, so it is looked for and written the way `get()` and `set()` take it. The copy is only made when a default is filled in, and it keeps the prototype of the value, since `JSON.stringify` uses a `toJSON` the value inherits from it. The given value is never changed, but it is returned as it is when no default is filled in, so a caller that validates the result, which writes into it, and still needs the original passes a copy in.
	*/
	#fillInDefaults(value: T): T {
		const dotNotation = this.#options.accessPropertiesByDotNotation;
		let filled: T | undefined;

		for (const [key, defaultValue] of this.#orderedDefaults) {
			const missing = dotNotation
				? getOwnProperty(value, key, missingKey) === missingKey
				: !hasStoreKey(value, key) || (value as Record<string, unknown>)[key] === undefined;

			if (!missing) {
				continue;
			}

			const target = filled ?? value;

			// The store is copied once, the first time a key is filled in, so the value given is left as it was, and every value written in is a copy of the default, so the validator never writes into the object the caller passed to the option.
			if (dotNotation) {
				// The store keeps what it has where the path would go, so a value that is not an object is not replaced by the containers the rest of the path needs. It is checked against the store as it is, since the default of the key above written into the copy below would make a path the store cannot take look like one it can.
				if (whereWriteIsBlocked(target, key) !== undefined) {
					continue;
				}

				filled ??= copyStoreDeep(value);
				if (!this.#seedDefaultPath(filled, key)) {
					continue;
				}

				setOwnProperty(filled, key, ownValue(defaultValue, this.#writesJson));
			} else {
				// The key is the whole key in this mode, so only the top of the store is written into.
				filled ??= copyStore(value);

				// A key such as `__proto__` is a key the file can hold, and a store is written as its own keys, so it is written as one rather than through the setter its prototype has for that name, which would make the value the prototype of the store and leave the key out of the file and out of every later read of it. `copyStore()` keeps the prototype for the `toJSON` a class instance inherits, so the copy is not a store of no prototype the way a plain assignment would need.
				Object.defineProperty(filled, key, {
					value: ownValue(defaultValue, this.#writesJson),
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
		}

		return filled ?? value;
	}

	/**
	Prepare the given store for a `defaults` key, and say whether the key can be written into it.

	A path below a key the schema gives a `default` to is written into that default, since the validator skips a key the store already holds and would leave the rest of the default out. The rest of the path is asked of that default on its own, rather than the default being written in first, so a path the default cannot take leaves the store exactly as it was. During migrations, only the `defaults` option is applied, since schema defaults are added after the migrations have run.
	*/
	#seedDefaultPath(store: T, key: string): boolean {
		if (this.#isInMigration) {
			return true;
		}

		// A key the parser refuses was refused by the caller before this, so the path is the one the caller was given.
		const path = keyPath(key) ?? [];

		for (const [index, part] of path.entries()) {
			if (index === 0) {
				continue;
			}

			// The parts of a path are written back into a key, which is the key the value the schema gives was recorded under. A part is escaped rather than joined as it stands, since a name holding a `.` of its own would become a path again.
			const parentKey = keyOfPath(path.slice(0, index));

			// A key the store already holds is not one the validator would skip, so the default of the schema for it does not apply.
			if (getOwnProperty(store, parentKey, missingKey) !== missingKey) {
				continue;
			}

			const parentDefault = getOwnProperty(this.#defaultValues, parentKey, missingKey);
			if (parentDefault === missingKey) {
				continue;
			}

			// The `default` the key above gives is what the path is written into, and that is a place the path may not be writable either, which is only known now that the key above is there. Everything above it in the path is what the store already holds, which the check the caller made has been through, so the rest of the path is asked of the default on its own.
			const own = ownValue(parentDefault, this.#writesJson);

			// A default that is not an object holds nothing a path can be written through, so the walk below would read the key it holds for a container the write creates and answer that nothing stands in the way. It does stand in the way, and the store keeps the default rather than losing it to a value the key above it gave.
			if (own === null || typeof own !== 'object' || whereWriteIsBlocked(own, key, index) !== undefined) {
				return false;
			}

			setOwnProperty(store, parentKey, own);
			return true;
		}

		return true;
	}

	#configureSerialization(options: Partial<Options<T>>): void {
		if (options.serialize) {
			this.#serialize = options.serialize;
		}

		if (options.deserialize) {
			this.#deserialize = options.deserialize;
		}
	}

	#resolvePath(options: Partial<Options<T>>): string {
		const cwd = path.resolve(options.cwd!);
		const extension = typeof options.fileExtension === 'string' ? options.fileExtension.replace(/^\.+/, '') : '';
		const fileExtension = extension === '' ? '' : `.${extension}`;
		const name = `${options.configName ?? 'config'}${fileExtension}`;
		const resolved = path.resolve(cwd, name);

		// A NUL byte is where a name stops being a name, and every `fs` call refuses one with an error from the engine that names neither option. It is refused here, where the other thing that is not a file name is.
		if (name.includes('\0')) {
			throw new TypeError(`The \`configName\` and \`fileExtension\` options must not hold a NUL byte, got \`${name.replaceAll('\0', String.raw`\0`)}\`.`);
		}

		// The two options name a file inside the directory the caller gave, which is what a nested `configName` and a `cwd` that is itself relative both rely on, so a name that leaves it is refused before any file or directory is touched. A name built from anything a caller takes from elsewhere, a profile name or a command-line argument, is otherwise a way to write anywhere the process can reach.
		const relative = path.relative(cwd, resolved);
		if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new TypeError(`The \`configName\` and \`fileExtension\` options must name a file inside \`cwd\`, got \`${name}\`, which resolves to \`${resolved}\`.`);
		}

		return resolved;
	}

	/**
	What the config file holds, so it can be put back after a construction that cannot finish. `'absent'` is a file that does not exist yet, and `undefined` is one that cannot be read, which is left alone rather than replaced with something else.
	*/
	#snapshotFile(): Uint8Array | 'absent' | undefined {
		try {
			return fs.readFileSync(this.path);
		} catch {
			return fs.existsSync(this.path) ? undefined : 'absent';
		}
	}

	/**
	The config file put back to the state `#snapshotFile()` found it in.
	*/
	#restoreFile(snapshot: Uint8Array | 'absent' | undefined): void {
		if (snapshot === 'absent') {
			// A write follows a link at the config path, so the file it made is the one the link points at. Taking the path away instead would leave that file behind and remove the link the caller put there.
			fs.rmSync(atomicWritePath(this.path), {force: true});
			return;
		}

		// Written the way every write is, so a mode that leaves the file read-only does not refuse it. No mode is given, so the file keeps the mode it was found with.
		if (snapshot !== undefined) {
			this.#writeFile(snapshot, undefined);
		}
	}

	#initializeStore(options: Partial<Options<T>>): void {
		// The defaults and the migration result are written, and the version records itself with them, before the validator sees the store. A construction that cannot finish puts the file back to the state it was found in, the way a construction without migrations leaves it alone when validation fails. A migration that fails has its own idea of what to keep, so only the validation is undone.
		const snapshot = options.migrations ? this.#snapshotFile() : undefined;
		this.#runMigrations(options);

		// The store is read as it is, since reading it the usual way reads a store the schema rejects as an empty one where `clearInvalidConfig` is set. The defaults are filled into a copy of it, since the validator writes into the store it is given, and what the file holds is what the result is compared against.
		const fileStore = this.#readStore(false);
		const storeWithDefaults = this.#fillInDefaults(copyStoreValue(fileStore) as T);

		try {
			this.#validate(storeWithDefaults);
		} catch (error: unknown) {
			if (!options.clearInvalidConfig || !(error instanceof SchemaViolationError)) {
				this.#restoreFile(snapshot);
				throw error;
			}

			// A store the schema cannot accept once cleared is no store to write, so the file goes back to where it was found the way a construction that cannot finish does. The migrations have already written to it, so without that it would be left behind as a file the same construction without migrations never creates.
			try {
				const clearedStore = this.#fillInDefaults(createPlainObject<T>());
				this.#validate(clearedStore);
				this.store = clearedStore;
			} catch (clearError: unknown) {
				this.#restoreFile(snapshot);
				throw clearError;
			}

			return;
		}

		// The store the defaults and the validator produced is written where it differs from the file, so a `default` the schema adds below the top level is written too. It is written the way a whole-store write is, which fills in the defaults and validates again, and asks about the values the defaults and the validator put in. The comparison is strict, so a value the validator coerced is a change to write.
		if (!isDeepStrictEqual(fileStore, storeWithDefaults)) {
			this.store = fileStore;
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

		// The version is recorded in the config file, and a value such as `1.0` cannot be read back as a version, which leaves the store unable to open. Reject it before it is written.
		if (semver.valid(projectVersion) === null) {
			throw new Error(`The \`projectVersion\` option must be a valid semantic version, got \`${projectVersion}\``);
		}

		this.#isInMigration = true;
		try {
			// A store that does not exist yet has nothing to migrate, so it starts at the current project version instead of running every migration against the new defaults. Checked before the store is read, since reading it may create the file.
			const isNewStore = !fs.existsSync(this.path);

			const fileStore = this.#readStore();

			// The file stays as it was, since the defaults only copy it when they fill a key in, which is the difference the comparison below looks for. A new store is written here once, with the version it starts at.
			const storeWithDefaults = this.#fillInDefaults(fileStore);
			if (isNewStore) {
				this.#setBookkeeping(MIGRATION_KEY, projectVersion, storeWithDefaults);
				return;
			}

			if (!isDeepStrictEqual(fileStore, storeWithDefaults)) {
				this.#write(storeWithDefaults);
			}

			this.#migrate(migrations, projectVersion, options.beforeEachMigration, storeWithDefaults);
		} finally {
			this.#isInMigration = false;
		}
	}
}

export type {Options, Schema} from './types.js';
