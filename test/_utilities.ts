import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Buffer} from 'node:buffer';
import {setTimeout as delay} from 'node:timers/promises';
import {pEvent} from 'p-event';
import {temporaryDirectory} from 'tempy';
import {deleteSync} from 'del';
import Conf from '../source/index.js';

const scheduledCleanups = new Set<string>();
const pendingCleanups = new Set<() => void>();
const trackedConfs = new Set<Conf<any>>();
const encryptionInitializationVectorLength = 16;
const encryptionSeparatorCharacter = ':';

process.on('exit', () => {
	for (const directory of scheduledCleanups) {
		deleteSync(directory, {force: true});
	}

	scheduledCleanups.clear();
});

/**
Test utilities for reducing duplication in migration tests.
*/

type MigrationTestOptions = {
	projectVersion: string;
	migrations?: Record<string, (store: Conf) => void>;
	schema?: Record<string, unknown>;
	ajvOptions?: Record<string, unknown>;
	defaults?: Record<string, unknown>;
	beforeEachMigration?: (store: Conf, context: any) => void;
	initialData?: Record<string, unknown>;
	clearInvalidConfig?: boolean;
	accessPropertiesByDotNotation?: boolean;
	cache?: boolean;
	cwd?: string;
	configName?: string;
	fileExtension?: string;
};

/**
Creates the config file, so the store is treated as one that already exists. A store that does not exist yet skips its migrations.
*/
export const createExistingConfig = (cwd: string, data: unknown = {}, fileName = 'config.json'): void => {
	fs.writeFileSync(path.join(cwd, fileName), JSON.stringify(data, null, '\t'));
};

/**
Reads a config file, or the config file of a store, as JSON.
*/
export const readConfigFile = (file: string | {readonly path: string}): Record<string, any> => JSON.parse(fs.readFileSync(typeof file === 'string' ? file : file.path, 'utf8')) as Record<string, any>;

/**
Creates a temporary Conf instance with migrations for testing.
*/
export function createMigrationTest(options: MigrationTestOptions): {
	conf: Conf;
	cwd: string;
	configPath: string;
} {
	const cwd = options.cwd ?? temporaryDirectory();

	if (!options.cwd) {
		scheduledCleanups.add(cwd);
	}

	const sanitizedExtension = (options.fileExtension ?? 'json').replace(/^\.+/, '');
	const extensionSuffix = sanitizedExtension ? `.${sanitizedExtension}` : '';
	const fileName = `${options.configName ?? 'config'}${extensionSuffix}`;
	const configPath = path.join(cwd, fileName);

	if (options.initialData) {
		createExistingConfig(cwd, options.initialData, fileName);
	} else if (!fs.existsSync(configPath)) {
		// A migration test is always about a store that already exists, and a store that does not exist yet skips its migrations. A file the test already wrote is left alone.
		createExistingConfig(cwd, {}, fileName);
	}

	// An option that is set to `undefined` is the same as one that is not passed, so every option is passed on as the test gives it.
	const confOptions: Record<string, unknown> = {
		cwd,
		projectVersion: options.projectVersion,
		migrations: options.migrations,
		schema: options.schema,
		ajvOptions: options.ajvOptions,
		defaults: options.defaults,
		beforeEachMigration: options.beforeEachMigration,
		clearInvalidConfig: options.clearInvalidConfig,
		accessPropertiesByDotNotation: options.accessPropertiesByDotNotation,
		cache: options.cache,
		configName: options.configName,
		fileExtension: options.fileExtension,
	};

	const conf = new Conf(confOptions);

	return {conf, cwd, configPath};
}

export const writeLegacyEncryptedConfig = ({
	filePath,
	encryptionKey,
	value,
}: {
	filePath: string;
	encryptionKey: string;
	value: Record<string, unknown>;
}): void => {
	const initializationVector = crypto.randomBytes(encryptionInitializationVectorLength);
	const password = crypto.pbkdf2Sync(encryptionKey, initializationVector.toString(), 10_000, 32, 'sha512');
	const cipher = crypto.createCipheriv('aes-256-cbc', password, initializationVector);
	const serialized = JSON.stringify(value, undefined, '\t');
	const encryptedData = Buffer.concat([cipher.update(Buffer.from(serialized)), cipher.final()]);
	const data = Buffer.concat([initializationVector, Buffer.from(encryptionSeparatorCharacter), encryptedData]);
	fs.writeFileSync(filePath, data);
};

/**
The `skip` option of a test that needs a file permission to refuse the process, which it never does for the root user.
*/
export const skipAsRoot = process.getuid?.() === 0 ? 'the root user is not refused by file permissions' : false;

/**
A project name no other run of the suite uses, so a store made in the user's own config directory never finds a directory an earlier or a concurrent run left there.
*/
export const nextProjectName = (): string => `conf-project-${crypto.randomUUID()}`;

/**
Runs the given cleanup once the test is done, which every test file does from `afterEach()` through `runRegisteredCleanups()`.
*/
export const registerCleanup = (cleanup: () => void): void => {
	pendingCleanups.add(cleanup);
};

export const runRegisteredCleanups = (): void => {
	for (const cleanup of pendingCleanups) {
		cleanup();
	}

	pendingCleanups.clear();
};

export const createTempDirectory = (): string => {
	const directory = temporaryDirectory();
	registerCleanup(() => {
		deleteSync(directory, {force: true});
	});
	scheduledCleanups.add(directory);
	return directory;
};

/**
Tracks a store so that `resetTrackedConfs()` closes its watcher, which a test that fails before it closes the watcher itself would otherwise leave open.
*/
export const trackConf = <T extends Conf<any>>(instance: T): T => {
	trackedConfs.add(instance);
	return instance;
};

/**
Closes the watcher of every store `trackConf()` tracked. A file that tracks stores calls it from `afterEach()`.
*/
export const resetTrackedConfs = (): void => {
	for (const conf of trackedConfs) {
		conf._closeWatcher();
	}

	trackedConfs.clear();
};

/**
How long a test waits for a watcher to report a change. A watcher reports a change after a debounce, and a file system event can take a while to arrive on a machine that is busy running the rest of the suite beside it. Every wait on a change event goes through this, so a slow run fails on the behaviour it is testing and not on how long the machine took to deliver an event.
*/
export const changeEventTimeout = 20_000;

/**
Waits longer than a watcher takes to report a change, so a change that was not reported by then is one that is not going to be. `fs.watch` reports a change once a debounce of 100 ms has let the events of a write settle, and the polling watcher Linux uses polls every 500 ms and reports a change a second after it.

A wait like this proves nothing on its own, since a watcher that is not running reports nothing either, so a test that checks a change is not reported also checks that a change is reported.
*/
export const settle = async (): Promise<void> => {
	await delay(process.platform === 'linux' ? 2000 : 300);
};

/**
Waits for the watchers a test just made to start. On macOS every `fs.watch` of a process shares one FSEvents stream, which is started again whenever a watcher is made or closed, so a change made right after that can be missed, and a test that waits for it would wait in vain.
*/
export const untilWatching = async (): Promise<void> => {
	await delay(process.platform === 'darwin' ? 300 : 0);
};

/**
Waits for the next change the watcher of the given store reports. It is called before the change is made, so that a report that comes at once is not missed.
*/
export const nextChange = async (conf: Conf<any>): Promise<void> => {
	await pEvent(conf.events, 'change', {timeout: changeEventTimeout});
};

/**
Waits until a count of reported changes stops moving, which is what a fixed wait cannot promise while the machine is busy.

A report the debounce had already started is made as soon as the event loop has room for it, so a wait that ends before the machine gives that room reads a count the report has not reached yet, and counts that report against whatever the test does next. Waiting for the count to hold still for a whole wait reports everything that was on its way and still notices a report that comes twice, since the count moves once more.
*/
export const untilQuiet = async (reported: () => number): Promise<void> => {
	let previous = reported();

	for (let round = 0; round < 10; round++) {
		// eslint-disable-next-line no-await-in-loop -- each round is a wait for a count to stop moving, which is what the loop is.
		await settle();

		const current = reported();
		if (current === previous) {
			return;
		}

		previous = current;
	}
};

/**
The `skip` option of a test that needs the file system to deliver change events, which it does not do reliably in CI.
*/
export const skipWatching = process.env.CI ? 'file system events are not reliable in CI' : false;

/**
Runs the test with the polling watcher, which is the one Linux uses, so a watcher test does not depend on `fs.watch` events. `#watch()` picks the watcher by platform, so the stores are made inside the body.
*/
export const withPollingWatcher = async (body: () => Promise<void>): Promise<void> => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', {value: 'linux'});

	try {
		await body();
	} finally {
		Object.defineProperty(process, 'platform', platformDescriptor!);
	}
};

/**
A temporary directory with a config file holding the given data in it.
*/
export const configDirectoryHolding = (data: unknown): string => {
	const cwd = createTempDirectory();
	createExistingConfig(cwd, data);
	return cwd;
};

/**
A temporary directory reached by the path it really has. A path with a link of its own in it is a path the two are different spellings of, which is what a temporary directory on macOS is and what any other one is not, and a test that compares paths or watches one needs the path and the file to be one and the same.
*/
export const createResolvedTempDirectory = (): string => fs.realpathSync(createTempDirectory());

/**
A link at the config path and a file for it to point at, `first/shared.json`, each in a directory of its own.
*/
export const linkedConfig = (): {cwd: string; first: string} => {
	const base = createResolvedTempDirectory();
	const cwd = path.join(base, 'cwd');
	const first = path.join(base, 'first');
	fs.mkdirSync(cwd);
	fs.mkdirSync(first);
	fs.symlinkSync(path.join(first, 'shared.json'), path.join(cwd, 'config.json'));

	return {cwd, first};
};

/**
The permission bits of the mode of a file, which is what a test reads a file back with, since `stat` answers with the type of the file above them.
*/
// eslint-disable-next-line no-bitwise
export const permissionBits = (filePath: string): number => fs.statSync(filePath).mode & 0o7777;

/**
Runs the body with the given process umask. Setting the umask gives back the one it was, which is put back afterwards so that the rest of the suite reads the default of `0o022`.
*/
export const withUmask = (umask: number, body: () => void): void => {
	const before = process.umask(umask);
	try {
		body();
	} finally {
		process.umask(before);
	}
};

/**
Runs the body with or without the Snap workaround, which is what takes a write off the atomic path and onto the one that writes the file in place.
*/
export const withSnap = (snap: boolean, body: () => void): void => {
	const before = process.env.SNAP;
	try {
		if (snap) {
			process.env.SNAP = '1';
		} else {
			delete process.env.SNAP;
		}

		body();
	} finally {
		if (before === undefined) {
			delete process.env.SNAP;
		} else {
			process.env.SNAP = before;
		}
	}
};

const isoDate = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/**
A `deserialize` that brings back the `Date`s the store was written with, which is what puts a value that writes itself back into a store.
*/
export const dateReviving = {
	deserialize: ((text: string) => JSON.parse(text, (key, value: unknown) => (typeof value === 'string' && isoDate.test(value) ? new Date(value) : value)) as Record<string, unknown>) as never,
};

/**
A price that writes itself as text and keeps what it needs for it in a private field, which a copy cannot carry and a value that writes itself is never written below.
*/
export class Money {
	readonly #cents: number;

	constructor(cents: number) {
		this.#cents = cents;
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention -- `toJSON` is the name JSON gives a value that writes itself.
	toJSON(): string {
		return `$${(this.#cents / 100).toFixed(2)}`;
	}
}

/**
The prototype of a `price()`, which writes it as text from a property of its own, which a copy does carry.
*/
export const pricePrototype = {
	// eslint-disable-next-line @typescript-eslint/naming-convention -- `toJSON` is the name JSON gives a value that writes itself.
	toJSON(this: {cents: number}) {
		return `$${(this.cents / 100).toFixed(2)}`;
	},
};

/**
A price in cents that writes itself as text, so that a copy of it which has lost the prototype it inherits `toJSON` from writes its own properties instead.
*/
export const price = (cents: number): {cents: number} => Object.assign(Object.create(pricePrototype) as {cents: number}, {cents});

export const createNullProtoObject = <T extends Record<string, unknown>>(obj: T): T =>
	Object.assign(Object.create(null), obj) as T;

/**
Creates a test that tracks migration execution order.
*/
export function createMigrationOrderTracker(): {
	tracker: string[];
	createMigration: (name: string) => (store: Conf) => void;
} {
	const tracker: string[] = [];

	const createMigration = (name: string) => (store: Conf) => {
		tracker.push(name);
		store.set(name, true);
	};

	return {tracker, createMigration};
}

/**
Reads the migration version from the config file of the given store, or of a config file at `{path}` where there is no store to ask. The version is kept under the key this module reserves for itself, which is deliberately not exposed through the public API, so it has to be read from the file.

This reads the file as plaintext JSON, so it cannot be used with a store that has the `encryptionKey` or `serialize` option set.
*/
export const getMigrationVersion = (conf: {readonly path: string}): string | undefined => {
	const data = JSON.parse(fs.readFileSync(conf.path, 'utf8')) as {
		__internal__?: {migrations?: {version?: unknown}};
	};
	const version = data.__internal__?.migrations?.version;
	return typeof version === 'string' ? version : undefined;
};
