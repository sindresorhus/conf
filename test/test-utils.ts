import fs from 'node:fs';
import path from 'node:path';
import {temporaryDirectory} from 'tempy';
import Conf from '../source/index.js';

/**
Test utilities for reducing duplication in migration tests.
*/

export type MigrationTestOptions = {
	projectVersion: string;
	migrations?: Record<string, (store: Conf) => void>;
	schema?: Record<string, any>;
	defaults?: Record<string, any>;
	beforeEachMigration?: (store: Conf, context: any) => void;
	initialData?: Record<string, any>;
	clearInvalidConfig?: boolean;
	accessPropertiesByDotNotation?: boolean;
	cwd?: string;
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
	const configPath = path.join(cwd, 'config.json');

	// Write initial data if provided
	if (options.initialData) {
		fs.writeFileSync(configPath, JSON.stringify(options.initialData, null, '\t'));
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

	const conf = new Conf(confOptions);

	return {conf, cwd, configPath};
}

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
		// Try dot notation first (works when accessPropertiesByDotNotation is true)
		let migrationVersion = conf.get('__internal__.migrations.version');

		// If that doesn't work, try accessing via nested object (for when accessPropertiesByDotNotation is false)
		if (migrationVersion === undefined) {
			const internal = conf.get('__internal__') as Record<string, Record<string, unknown>>;
			migrationVersion = internal?.migrations?.version as string;
		}

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
