import fs from 'node:fs';
import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import Conf from '../source/index.js';
import {
	createTempDirectory,
	trackConf,
	resetTrackedConfs,
	runRegisteredCleanups,
} from './_utilities.js';

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('deserializeComplexTypes', () => {
	let config: Conf;

	beforeEach(() => {
		config = trackConf(new Conf({cwd: createTempDirectory(), deserializeComplexTypes: true}));
	});

	it('round-trips a Date value', () => {
		const date = new Date('2024-06-15T12:30:00.000Z');
		config.set('timestamp', date);
		const result = config.get('timestamp');
		assert.ok(result instanceof Date);
		assert.strictEqual(result.toISOString(), date.toISOString());
	});

	it('round-trips a Date value with dot-notation key', () => {
		const date = new Date('2024-01-01T00:00:00.000Z');
		config.set('nested.createdAt', date);
		const result = config.get('nested.createdAt');
		assert.ok(result instanceof Date);
		assert.strictEqual(result.toISOString(), date.toISOString());
	});

	it('round-trips Date values inside a nested object', () => {
		const now = new Date();
		config.set('user', {
			name: 'test',
			createdAt: now,
			profile: {
				updatedAt: now,
			},
		});

		const user = config.get('user') as Record<string, unknown>;
		assert.ok(user.createdAt instanceof Date);
		assert.strictEqual((user.createdAt as Date).toISOString(), now.toISOString());

		const profile = user.profile as Record<string, unknown>;
		assert.ok(profile.updatedAt instanceof Date);
		assert.strictEqual((profile.updatedAt as Date).toISOString(), now.toISOString());
	});

	it('round-trips Date values inside arrays', () => {
		const dates = [
			new Date('2024-01-01T00:00:00.000Z'),
			new Date('2024-06-15T00:00:00.000Z'),
			new Date('2024-12-31T00:00:00.000Z'),
		];
		config.set('dates', dates);
		const result = config.get('dates') as Date[];
		assert.strictEqual(result.length, 3);
		for (const [index, date] of result.entries()) {
			assert.ok(date instanceof Date, `dates[${index}] should be a Date`);
			assert.strictEqual(date.toISOString(), dates[index].toISOString());
		}
	});

	it('round-trips mixed arrays containing Date and non-Date values', () => {
		const date = new Date('2024-03-15T10:00:00.000Z');
		config.set('mixed', ['hello', date, 42, null, true]);
		const result = config.get('mixed') as unknown[];
		assert.strictEqual(result[0], 'hello');
		assert.ok(result[1] instanceof Date);
		assert.strictEqual((result[1] as Date).toISOString(), date.toISOString());
		assert.strictEqual(result[2], 42);
		assert.strictEqual(result[3], null);
		assert.strictEqual(result[4], true);
	});

	it('does not convert non-Date values', () => {
		config.set('str', 'hello');
		config.set('num', 42);
		config.set('bool', true);
		config.set('nil', null);
		config.set('obj', {a: 1, b: 'two'});
		config.set('arr', [1, 2, 3]);

		assert.strictEqual(config.get('str'), 'hello');
		assert.strictEqual(config.get('num'), 42);
		assert.strictEqual(config.get('bool'), true);
		assert.strictEqual(config.get('nil'), null);
		assert.deepStrictEqual(config.get('obj'), {a: 1, b: 'two'});
		assert.deepStrictEqual(config.get('arr'), [1, 2, 3]);
	});

	it('does not falsely revive objects with $$type but extra keys', () => {
		const value = {$$type: 'Date', $$value: '2024-01-01T00:00:00.000Z', extra: true};
		config.set('notADate', value);
		const result = config.get('notADate') as Record<string, unknown>;
		assert.ok(!(result instanceof Date));
		assert.strictEqual(result.$$type, 'Date');
		assert.strictEqual(result.extra, true);
	});

	it('does not falsely revive objects with only $$type', () => {
		const value = {$$type: 'Date'};
		config.set('partial', value);
		const result = config.get('partial') as Record<string, unknown>;
		assert.ok(!(result instanceof Date));
		assert.strictEqual(result.$$type, 'Date');
	});

	it('does not falsely revive objects with unknown $$type', () => {
		const value = {$$type: 'RegExp', $$value: '.*'};
		config.set('unknownType', value);
		const result = config.get('unknownType') as Record<string, unknown>;
		assert.ok(!(result instanceof Date));
		assert.strictEqual(result.$$type, 'RegExp');
		assert.strictEqual(result.$$value, '.*');
	});

	it('persists tagged format in the JSON file', () => {
		const date = new Date('2024-06-15T12:00:00.000Z');
		config.set('myDate', date);

		const raw = fs.readFileSync(config.path, 'utf8');
		const parsed = JSON.parse(raw);
		assert.deepStrictEqual(parsed.myDate, {
			$$type: 'Date',
			$$value: '2024-06-15T12:00:00.000Z',
		});
	});

	it('works with .store getter', () => {
		const date1 = new Date('2024-01-01T00:00:00.000Z');
		const date2 = new Date('2024-12-31T00:00:00.000Z');
		config.set('start', date1);
		config.set('end', date2);
		config.set('name', 'test');

		const store = config.store;
		assert.ok(store.start instanceof Date);
		assert.ok(store.end instanceof Date);
		assert.strictEqual(store.name, 'test');
	});

	it('works with .store setter', () => {
		const date = new Date('2024-06-15T00:00:00.000Z');
		config.store = {
			timestamp: date,
			label: 'hello',
		} as any;

		assert.ok(config.get('timestamp') instanceof Date);
		assert.strictEqual(config.get('label'), 'hello');
	});

	it('handles Date.now() timestamps', () => {
		const date = new Date();
		config.set('now', date);
		const result = config.get('now');
		assert.ok(result instanceof Date);
		assert.strictEqual((result as Date).getTime(), date.getTime());
	});

	it('handles invalid Date gracefully', () => {
		const invalidDate = new Date('not-a-date');
		config.set('invalid', invalidDate);
		const result = config.get('invalid');
		assert.ok(result instanceof Date);
		assert.ok(Number.isNaN((result as Date).getTime()));
	});

	it('works with encryption', () => {
		const encConfig = trackConf(new Conf({
			cwd: createTempDirectory(),
			deserializeComplexTypes: true,
			encryptionKey: 'secret123',
		}));

		const date = new Date('2024-06-15T12:00:00.000Z');
		encConfig.set('secure', date);
		const result = encConfig.get('secure');
		assert.ok(result instanceof Date);
		assert.strictEqual((result as Date).toISOString(), date.toISOString());
	});

	it('deeply nested objects with multiple Date fields', () => {
		const data = {
			level1: {
				level2: {
					level3: {
						created: new Date('2024-01-01T00:00:00.000Z'),
						modified: new Date('2024-06-15T00:00:00.000Z'),
					},
					items: [
						{date: new Date('2024-03-01T00:00:00.000Z'), value: 'a'},
						{date: new Date('2024-04-01T00:00:00.000Z'), value: 'b'},
					],
				},
			},
		};

		config.set('deep', data);
		const result = config.get('deep') as typeof data;
		assert.ok(result.level1.level2.level3.created instanceof Date);
		assert.ok(result.level1.level2.level3.modified instanceof Date);
		assert.ok(result.level1.level2.items[0].date instanceof Date);
		assert.ok(result.level1.level2.items[1].date instanceof Date);
		assert.strictEqual(result.level1.level2.items[0].value, 'a');
	});
});

describe('deserializeComplexTypes disabled (default)', () => {
	it('does not restore Date objects when option is not set', () => {
		const config = trackConf(new Conf({cwd: createTempDirectory()}));
		const date = new Date('2024-06-15T12:00:00.000Z');
		config.set('timestamp', date);

		// Without the option, Date is stored as ISO string by JSON.stringify
		const result = config.get('timestamp');
		assert.strictEqual(typeof result, 'string');
		assert.strictEqual(result, date.toISOString());
	});

	it('ignores deserializeComplexTypes when custom serialize is provided', () => {
		const config = trackConf(new Conf({
			cwd: createTempDirectory(),
			deserializeComplexTypes: true,
			serialize: value => JSON.stringify(value),
		}));

		const date = new Date('2024-06-15T12:00:00.000Z');
		config.set('timestamp', date);

		// Custom serialize overrides: both replacer and reviver are disabled
		const result = config.get('timestamp');
		assert.strictEqual(typeof result, 'string');
	});

	it('ignores deserializeComplexTypes when custom deserialize is provided', () => {
		const config = trackConf(new Conf({
			cwd: createTempDirectory(),
			deserializeComplexTypes: true,
			deserialize: value => JSON.parse(value),
		}));

		const date = new Date('2024-06-15T12:00:00.000Z');
		config.set('timestamp', date);

		// Custom deserialize overrides: both replacer and reviver are disabled
		const result = config.get('timestamp');
		assert.strictEqual(typeof result, 'string');
	});
});

describe('deserializeComplexTypes with accessPropertiesByDotNotation: false', () => {
	it('round-trips Date values without dot-notation', () => {
		const config = trackConf(new Conf({
			cwd: createTempDirectory(),
			deserializeComplexTypes: true,
			accessPropertiesByDotNotation: false,
		}));

		const date = new Date('2024-06-15T12:00:00.000Z');
		config.set('timestamp', date);
		const result = config.get('timestamp');
		assert.ok(result instanceof Date);
		assert.strictEqual(result.toISOString(), date.toISOString());
	});
});
