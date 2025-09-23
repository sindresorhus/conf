import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {temporaryDirectory} from 'tempy';
import {deleteSync} from 'del';
import Conf from '../source/index.js';

const scheduledCleanups = new Set<string>();
const pendingCleanups = new Set<() => void>();
const trackedConfs = new Set<Conf>();
let projectNameSequence = 0;

process.on('exit', () => {
	for (const directory of scheduledCleanups) {
		deleteSync(directory, {force: true});
	}

	scheduledCleanups.clear();
});

/**
Test utilities for reducing duplication in migration tests.
*/

export type MigrationTestOptions = {
	projectVersion: string;
	migrations?: Record<string, (store: Conf) => void>;
	schema?: Record<string, unknown>;
	defaults?: Record<string, unknown>;
	beforeEachMigration?: (store: Conf, context: any) => void;
	initialData?: Record<string, unknown>;
	clearInvalidConfig?: boolean;
	accessPropertiesByDotNotation?: boolean;
	cwd?: string;
	configName?: string;
	fileExtension?: string;
};

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

	// Write initial data if provided
	if (options.initialData) {
		fs.writeFileSync(configPath, JSON.stringify(options.initialData, null, '\t'));
		fs.statSync(configPath);
	}

	const confOptions: Record<string, unknown> = {
		cwd,
		projectVersion: options.projectVersion,
		migrations: options.migrations,
	};

	// Only add optional properties if they are defined
	if (options.schema !== undefined) {
		confOptions.schema = options.schema;
	}

	if (options.defaults !== undefined) {
		confOptions.defaults = options.defaults;
	}

	if (options.beforeEachMigration !== undefined) {
		confOptions.beforeEachMigration = options.beforeEachMigration;
	}

	if (options.clearInvalidConfig !== undefined) {
		confOptions.clearInvalidConfig = options.clearInvalidConfig;
	}

	if (options.accessPropertiesByDotNotation !== undefined) {
		confOptions.accessPropertiesByDotNotation = options.accessPropertiesByDotNotation;
	}

	if (options.configName !== undefined) {
		confOptions.configName = options.configName;
	}

	if (options.fileExtension !== undefined) {
		confOptions.fileExtension = options.fileExtension;
	}

	const conf = new Conf(confOptions);

	return {conf, cwd, configPath};
}

export const nextProjectName = (): string => {
	projectNameSequence++;
	return `conf-project-${projectNameSequence}`;
};

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

export const trackConf = <T extends Conf>(instance: T): T => {
	trackedConfs.add(instance);
	return instance;
};

export const resetTrackedConfs = (): void => {
	trackedConfs.clear();
};

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
Utility for testing version range satisfaction.
*/
export function createVersionTest(versions: string[]): Record<string, (store: Conf) => void> {
	const migrations: Record<string, (store: Conf) => void> = {};

	for (const version of versions) {
		migrations[version] = (store: Conf) => {
			store.set(`migrated_${version.replaceAll(/\W/g, '_')}`, true);
		};
	}

	return migrations;
}

export const getMigrationVersion = (conf: Conf): string | undefined => {
	const direct = conf.get('__internal__.migrations.version') as string | undefined;
	if (direct !== undefined) {
		return direct;
	}

	const internal = conf.get('__internal__') as Record<string, unknown> | undefined;
	if (!internal || typeof internal !== 'object') {
		return undefined;
	}

	const migrations = internal.migrations as Record<string, unknown> | undefined;
	const version = migrations?.version;
	return typeof version === 'string' ? version : undefined;
};

/**
Creates invalid data scenarios for schema testing.
*/
export const invalidDataScenarios = {
	typeCoercion: {
		data: {port: '8080', enabled: 'true', count: '42'},
		schema: {
			port: {type: 'number'},
			enabled: {type: 'boolean'},
			count: {type: 'number'},
		},
		migration(store: Conf) {
			const port = store.get('port');
			const enabled = store.get('enabled');
			const count = store.get('count');

			if (typeof port === 'string') {
				store.set('port', Number(port));
			}

			if (typeof enabled === 'string') {
				store.set('enabled', enabled === 'true');
			}

			if (typeof count === 'string') {
				store.set('count', Number(count));
			}
		},
	},
	dataTransformation: {
		data: {settings: 'key1=value1,key2=value2'},
		schema: {
			settings: {
				type: 'object',
				properties: {
					key1: {type: 'string'},
					key2: {type: 'string'},
				},
			},
		},
		migration(store: Conf) {
			const settings = store.get('settings');

			if (typeof settings === 'string') {
				const parsed: Record<string, string> = {};
				for (const pair of settings.split(',')) {
					const [key, value] = pair.split('=');
					if (key && value) {
						parsed[key] = value;
					}
				}

				store.set('settings', parsed);
			}
		},
	},
} as const;

/**
Test data with special characters for encoding tests.
*/
export const specialCharacterData = {
	unicode: '🦄✨🌈 Unicode test',
	emojiKey: '🔑',
	mixedScripts: 'Hello 世界 🌍 مرحبا',
	controlChars: 'before\u0000\u0001\u0002after',
	rtlText: 'العربية עברית',
	mathematical: '∑∞≠≤≥∆π√',
	quotesAndEscapes: '"\'`\\n\\t\\r\\\\',
	zeroWidth: 'invisible\u200B\u200C\u200Dchars',
} as const;

/**
Performance test helper for large data.
*/
export function generateLargeDataset(itemCount: number, fieldsPerItem = 10): Record<string, any> {
	const data: Record<string, any> = {};

	for (let index = 0; index < itemCount; index++) {
		data[`item${index}`] = {
			id: index,
			name: `Item ${index}`,
			metadata: Array.from({length: fieldsPerItem}, (_, j) => ({
				key: `field${j}`,
				value: `data-${index}-${j}`,
				timestamp: Date.now() + (index * j),
			})),
		};
	}

	return data;
}

/**
Assertion helpers for common test patterns.
*/
export const assertions = {
	/**
	 Assert that migration internal state is preserved.
	*/
	migrationStatePreserved(conf: Conf, expectedVersion: string) {
		const migrationVersion = getMigrationVersion(conf);
		if (migrationVersion !== expectedVersion) {
			throw new Error(`Expected migration version ${expectedVersion}, got ${String(migrationVersion)}`);
		}
	},

	/**
	Assert that all expected migrations ran.
	*/
	migrationsCompleted(conf: Conf, expectedMigrations: string[]) {
		for (const migration of expectedMigrations) {
			const key = migration.replaceAll(/\W/g, '_');
			if (!conf.has(`migrated_${key}`) && !conf.get(migration)) {
				throw new Error(`Migration ${migration} did not run`);
			}
		}
	},

	/**
	Assert performance characteristics.
	*/
	performanceWithinBounds(startTime: number, maxDurationMs: number) {
		const duration = Date.now() - startTime;
		if (duration > maxDurationMs) {
			throw new Error(`Operation took ${duration}ms, expected under ${maxDurationMs}ms`);
		}
	},
};
