/* eslint-disable no-new, @typescript-eslint/naming-convention, @typescript-eslint/no-unsafe-assignment, unicorn/no-thenable -- A store is often built only for what its schema refuses, the keys here are the ones a schema names, including `then`, and a value read back is `any`. */
import fs from 'node:fs';
import path from 'node:path';
import {describe, it, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {Ajv2020} from 'ajv/dist/2020.js';
import Conf, {type Schema, type Options} from '../source/index.js';
import {
	createTempDirectory,
	runRegisteredCleanups,
	resetTrackedConfs,
	createNullProtoObject,
	readConfigFile,
	getMigrationVersion,
	configDirectoryHolding,
} from './_utilities.js';

const withRootSchema = <T extends Record<string, any>>(rootSchema: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
	new Conf<T>({cwd: createTempDirectory(), rootSchema, ...rest});

/**
Write a config file, so the store is one that already exists.
*/
const writeConfigFile = (cwd: string, contents: string): void => {
	fs.writeFileSync(path.join(cwd, 'config.json'), contents);
};

afterEach(() => {
	resetTrackedConfs();
	runRegisteredCleanups();
});

describe('a `schema` option', () => {
	it('refuses a `defaults` value for a key the schema prohibits with `false`', () => {
		assert.throws(
			() => new Conf({cwd: createTempDirectory(), schema: {legacy: false}, defaults: {legacy: 1}}),
			{message: /Config schema violation: `legacy`/},
		);
	});

	// A key of the `schema` option is looked at whatever the validator is asked to do, so the same schema is legal or illegal either way, and a key the module keeps its bookkeeping under is refused the way the `defaults` option refuses one, since the store hides it and a `clear()` would write a value over the bookkeeping.
	for (const useDefaults of [true, false]) {
		it(`refuses a key that names a path, with \`useDefaults: ${String(useDefaults)}\``, () => {
			const schema: Schema<Record<string, any>> = {
				'a.b': {type: 'number', default: 1},
			};

			assert.throws(() => new Conf({
				cwd: createTempDirectory(),
				schema,
				ajvOptions: {useDefaults},
			}), {name: 'TypeError', message: /The `schema` option must not contain the key `a\.b`, which is not a key of its own/});
		});

		it(`refuses the reserved key, with \`useDefaults: ${String(useDefaults)}\``, () => {
			assert.throws(() => new Conf({
				cwd: createTempDirectory(),
				schema: {__internal__: {type: 'number', default: 1}},
				ajvOptions: {useDefaults},
			}), {name: 'TypeError', message: /__internal__/});
		});

		// The bookkeeping is written at the top of the store and nothing below it, so a `__internal__` below the top is the caller's data, which cannot reach it. `set()` and the `defaults` option both take it there.
		it(`takes the reserved key below the top, with \`useDefaults: ${String(useDefaults)}\``, () => {
			const cwd = createTempDirectory();
			const schema = {a: {type: 'object', properties: {__internal__: {type: 'number', default: 3}}}} as unknown as Schema<Record<string, any>>;
			const conf = new Conf<Record<string, any>>({
				cwd,
				schema,
				ajvOptions: {useDefaults},
			});
			conf.set('a', {__internal__: 3});
			assert.deepStrictEqual({...conf.store}, {a: {__internal__: 3}});
		});
	}
});

describe('a `schema` property whose name is a number', () => {
	// The validator writes a property name as a key of an object. A numeric part of a dot-notation path the caller writes is an index into an array instead, so `reset()` of such a path, which writes the way `set()` does, is not supported.
	it('writes the default of a property the validator writes as a key', () => {
		const schema: Schema<Record<string, any>> = {
			parent: {
				type: 'object',
				properties: {
					0: {type: 'number', default: 7},
					name: {type: 'string', default: 'x'},
				},
			},
		};

		// A `default` below a key the store does not hold is not applied, since the validator never looks below it, so the key is set first.
		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema});
		assert.deepStrictEqual({...conf.store}, {});

		conf.set('parent', {});
		assert.deepStrictEqual({...conf.store}, {parent: {0: 7, name: 'x'}});
		assert.ok(!Array.isArray(conf.get('parent')), 'the parent is not an array');

		conf.reset('parent');
		assert.deepStrictEqual({...conf.store}, {parent: {0: 7, name: 'x'}});
	});

	it('leaves a number the store holds at the property as it is', () => {
		const schema: Schema<Record<string, any>> = {
			parent: {type: 'object', properties: {0: {type: 'number', default: 7}}},
		};

		const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema});
		conf.set('parent', {0: 1});
		conf.reset('parent.0');
		assert.deepStrictEqual({...conf.store}, {parent: {0: 7}});
	});
});

describe('the `schema` option a store is given', () => {
	it('is not written into by a `defaults` path that goes below it', () => {
		const schema: Schema<Record<string, any>> = {
			a: {
				type: 'object',
				additionalProperties: false,
				properties: {b: {type: 'string'}},
			},
		};
		const pristine = structuredClone(schema);

		const first = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema, defaults: {'a.c': 1}});
		assert.deepStrictEqual({...first.store}, {a: {c: 1}});
		assert.deepStrictEqual(schema, pristine, 'the schema the first store was given');

		// A second store given the same object accepts nothing the schema refuses, which it would not if the first store had written into it.
		const second = new Conf<Record<string, any>>({cwd: createTempDirectory(), schema});
		assert.throws(() => {
			second.set('a', {c: 'accepted'});
		}, {message: 'Config schema violation: `a/c` must NOT have additional properties'});
	});
});

describe('a store the validator changes below the top level', () => {
	// The copy the `defaults` are filled into is a shallow one, so a nested object the validator changes in place is shared with the file it came from, and the comparison that decides whether to write finds nothing to write.
	it('writes a default the validator inserts into a nested object', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		fs.writeFileSync(filePath, JSON.stringify({a: {}}));
		const conf = new Conf<{a: {b?: number}}>({
			cwd,
			schema: {a: {type: 'object', properties: {b: {type: 'number', default: 7}}}},
		});
		assert.deepStrictEqual(conf.get('a'), {b: 7});
		assert.deepStrictEqual(readConfigFile(filePath), {a: {b: 7}});
	});

	it('writes a value the validator coerces in a nested object', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		fs.writeFileSync(filePath, JSON.stringify({a: {n: '42'}}));
		const conf = new Conf<{a: {n?: number}}>({
			cwd,
			schema: {a: {type: 'object', properties: {n: {type: 'number'}}}},
			ajvOptions: {coerceTypes: true},
		});
		assert.strictEqual(conf.get('a.n'), 42);
		assert.deepStrictEqual(readConfigFile(filePath), {a: {n: 42}});
	});

	it('writes an additional key the validator takes out of a nested object', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		fs.writeFileSync(filePath, JSON.stringify({a: {x: 1, junk: 2}}));
		const conf = new Conf({
			cwd,
			schema: {a: {type: 'object', additionalProperties: false, properties: {x: {type: 'number'}}}},
			ajvOptions: {removeAdditional: true},
		});
		assert.deepStrictEqual(conf.get('a'), {x: 1});
		assert.deepStrictEqual(readConfigFile(filePath), {a: {x: 1}});
	});

	it('leaves a file the validator changes nothing in as it is', () => {
		const cwd = createTempDirectory();
		const filePath = path.join(cwd, 'config.json');
		const contents = JSON.stringify({a: {x: 1}}, undefined, '\t');
		fs.writeFileSync(filePath, contents);
		const conf = new Conf({cwd, schema: {a: {type: 'object', properties: {x: {type: 'number'}}}}});
		assert.strictEqual(fs.readFileSync(filePath, 'utf8'), contents);
		assert.deepStrictEqual(conf.get('a'), {x: 1});
	});
});

describe('the validator writing into a value the caller gave', () => {
	// A value is copied as the store takes it, so a `default` the validator adds and a value `coerceTypes` rewrites land in the copy, at any depth, and never in the value the caller gave.
	it('leaves a `default` below the top level off the value the caller gave', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {holder: {type: 'object', properties: {child: {default: 5}}}},
		});

		const nested: Record<string, unknown> = {};
		conf.set('holder', nested);
		assert.deepStrictEqual(nested, {});
		assert.deepStrictEqual(conf.get('holder'), {child: 5});
	});

	it('leaves a `default` for another key off the value the caller gave', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {
				count: {type: 'number', default: 1},
				holder: {type: 'object'},
			},
		});

		// The `default` for `count` is added to the copy the validator is given, so the value given for `holder` keeps only what it held.
		const value = {a: 1};
		conf.set('holder', value);
		assert.deepStrictEqual(value, {a: 1});
		assert.strictEqual(conf.get('count'), 1);
	});

	it('leaves the value the caller gave as it was where `coerceTypes` rewrote it and the schema then rejects it', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {holder: {type: 'object', properties: {count: {type: 'number', minimum: 100}}}},
			ajvOptions: {coerceTypes: true},
		});

		const nested = {count: '5'};
		assert.throws(() => {
			conf.set('holder', nested);
		}, {message: /Config schema violation/});
		assert.deepStrictEqual(nested, {count: '5'});
	});
});

describe('schema keywords', () => {
	it('enforces required properties', () => {
		// An empty store violates `required`, so construction itself throws.
		assert.throws(() => {
			new Conf({
				cwd: createTempDirectory(),
				schema: {name: {type: 'string'}},
				rootSchema: {required: ['name']},
			});
		}, {message: /must have required property 'name'/});

		// With a default the store starts valid and stays valid.
		const withDefaults = new Conf({
			cwd: createTempDirectory(),
			schema: {name: {type: 'string'}},
			rootSchema: {required: ['name']},
			defaults: {name: 'ada'},
		});
		assert.strictEqual(withDefaults.get('name'), 'ada');
		withDefaults.set('name', 'grace');
		assert.strictEqual(withDefaults.get('name'), 'grace');

		// Without defaults, replacing the store with an object that drops
		// the required key throws.
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({name: 'ada'}));
		const conf = new Conf({
			cwd,
			schema: {name: {type: 'string'}},
			rootSchema: {required: ['name']},
		});
		assert.strictEqual(conf.get('name'), 'ada');
		assert.throws(() => {
			conf.store = {} as any;
		}, {message: /Config schema violation/});
	});

	it('enforces enum values', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {color: {enum: ['red', 'green', 'blue']}},
		});
		conf.set('color', 'green');
		assert.throws(() => {
			conf.set('color', 'purple');
		}, {message: /Config schema violation/});
	});

	it('enforces numeric minimum and maximum', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {age: {type: 'integer', minimum: 0, maximum: 150}},
		});
		conf.set('age', 30);
		assert.throws(() => {
			conf.set('age', -1);
		}, {message: /Config schema violation/});
		assert.throws(() => {
			conf.set('age', 999);
		}, {message: /Config schema violation/});
	});

	it('enforces string length and pattern', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {
				code: {
					type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$',
				},
			},
		});
		conf.set('code', 'abc');
		assert.throws(() => {
			conf.set('code', 'a');
		}, {message: /Config schema violation/});
		assert.throws(() => {
			conf.set('code', 'ABC');
		}, {message: /Config schema violation/});
	});

	it('enforces array constraints', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {
				tags: {
					type: 'array', items: {type: 'string'}, minItems: 1, maxItems: 3, uniqueItems: true,
				},
			},
		});
		conf.set('tags', ['a', 'b']);
		assert.throws(() => {
			conf.set('tags', []);
		}, {message: /Config schema violation/});
		assert.throws(() => {
			conf.set('tags', ['a', 'a']);
		}, {message: /Config schema violation/});
	});

	it('validates string formats', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {
				email: {type: 'string', format: 'email'},
				when: {type: 'string', format: 'date-time'},
			},
		});
		conf.set('email', 'user@example.com');
		assert.throws(() => {
			conf.set('email', 'not-an-email');
		}, {message: /must match format "email"/});
		assert.throws(() => {
			conf.set('when', 'not-a-date');
		}, {message: /must match format "date-time"/});
	});

	it('supports anyOf', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {value: {anyOf: [{type: 'string'}, {type: 'number'}]}},
		});
		conf.set('value', 'text');
		conf.set('value', 12);
		assert.throws(() => {
			conf.set('value', true);
		}, {message: /Config schema violation/});
	});

	it('supports const', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {kind: {const: 'fixed'}},
		});
		conf.set('kind', 'fixed');
		assert.throws(() => {
			conf.set('kind', 'other');
		}, {message: /Config schema violation/});
	});

	it('invalid pre-existing file fails at construction without clearInvalidConfig', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({n: 'bad'}));
		assert.throws(() => {
			new Conf({cwd, schema: {n: {type: 'number'}}});
		}, {message: /Config schema violation/});
	});

	it('joins multiple errors with "; "', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {a: {type: 'string'}, b: {type: 'number'}},
		});
		assert.throws(() => {
			conf.store = {a: 1, b: 'x'};
		}, {message: /`a` must be string; `b` must be number/});
	});

	it('boolean false schema rejects the property', () => {
		const conf = new Conf({cwd: createTempDirectory(), schema: {banned: false}});
		assert.throws(() => {
			conf.set('banned', 1);
		}, {message: /Config schema violation/});
	});

	it('rootSchema additionalProperties false rejects unknown keys', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {known: {type: 'string'}},
			rootSchema: {additionalProperties: false},
		});
		conf.set('known', 'ok');
		assert.throws(() => {
			conf.set('unknown', 'nope');
		}, {message: /must NOT have additional properties/});
	});

	it('ajv removeAdditional strips unknown keys instead of throwing', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {known: {type: 'string'}},
			rootSchema: {additionalProperties: false},
			ajvOptions: {removeAdditional: true},
		});
		conf.set('known', 'ok');
		conf.set('unknown', 'stripped');
		assert.strictEqual(conf.get('known'), 'ok');
		assert.strictEqual(conf.get('unknown' as any), undefined);
	});

	// A key of the `defaults` option is given to the schema as a `properties` entry so the validator writes it, which is a property the `patternProperties` of the same schema already covers. Ajv refuses to compile a schema that says both, so a `patternProperties` the caller wrote and a default they wrote could not be used together at all.
	it('a `defaults` key a `patternProperties` covers is left to that pattern', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({
			cwd,
			schema: {},
			rootSchema: {patternProperties: {'^x-': {type: 'number'}}},
			defaults: {'x-1': 1, other: 'text'},
		});
		assert.deepStrictEqual({...conf.store}, {'x-1': 1, other: 'text'});
		assert.deepStrictEqual(readConfigFile(conf.path), {'x-1': 1, other: 'text'});
	});

	it('a `defaults` key a `patternProperties` covers is still checked against it', () => {
		const cwd = createTempDirectory();
		assert.throws(() => new Conf<Record<string, any>>({
			cwd,
			schema: {},
			rootSchema: {patternProperties: {'^x-': {type: 'number'}}},
			defaults: {'x-1': 'not a number'},
		}), {message: 'Config schema violation: `x-1` must be number'});
	});

	it('ajv coerceTypes converts compatible scalars', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({port: '8080'}));
		const conf = new Conf({
			cwd,
			schema: {port: {type: 'number'}},
			ajvOptions: {coerceTypes: true},
		});
		assert.strictEqual(conf.get('port'), 8080);
	});

	it('validation failure does not corrupt the previous file', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {n: {type: 'number'}},
		});
		conf.set('n', 1);
		const before = fs.readFileSync(conf.path, 'utf8');
		assert.throws(() => {
			conf.set('n', 'bad');
		}, {message: /Config schema violation/});
		assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), before);
		assert.strictEqual(conf.get('n'), 1);
	});
});

describe('schema combinators', () => {
	it('supports oneOf', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {value: {oneOf: [{type: 'string'}, {type: 'number'}]}},
		});
		conf.set('value', 'text');
		conf.set('value', 5);
		assert.throws(() => {
			conf.set('value', true);
		}, {message: /Config schema violation/});
	});

	it('supports allOf', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {n: {allOf: [{type: 'number'}, {minimum: 5}]}},
		});
		conf.set('n', 10);
		assert.throws(() => {
			conf.set('n', 2);
		}, {message: /Config schema violation/});
	});

	it('supports not', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {v: {not: {type: 'string'}}},
		});
		conf.set('v', 5);
		assert.throws(() => {
			conf.set('v', 'blocked');
		}, {message: /Config schema violation/});
	});

	it('supports if/then/else', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {
				country: {type: 'string'},
				postal: {
					type: 'string',
					if: {properties: {country: {const: 'US'}}},
					then: {pattern: '^[0-9]{5}$'},
				},
			},
		});
		conf.set('country', 'US');
		conf.set('postal', '12345');
		assert.strictEqual(conf.get('postal'), '12345');
	});

	it('supports dependentRequired at the root', () => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({card: '1234', cvv: '999'}));
		const conf = new Conf({
			cwd,
			schema: {card: {type: 'string'}, cvv: {type: 'string'}},
			rootSchema: {dependentRequired: {card: ['cvv']}},
		});
		assert.strictEqual(conf.get('cvv'), '999');
		conf.set('cvv', '000');
		assert.strictEqual(conf.get('cvv'), '000');
		assert.throws(() => {
			conf.store = {card: '1234'} as any;
		}, {message: /Config schema violation/});
	});

	it('supports propertyNames constraints', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {},
			rootSchema: {propertyNames: {pattern: '^[a-z]+$'}},
		});
		conf.set('lowercase', 1);
		assert.throws(() => {
			conf.set('UPPER', 1);
		}, {message: /Config schema violation/});
	});

	it('supports minProperties and maxProperties', () => {
		assert.throws(() => {
			new Conf({
				cwd: createTempDirectory(),
				schema: {},
				rootSchema: {minProperties: 1},
			});
		}, {message: /must NOT have fewer than 1 properties/});
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {},
			rootSchema: {maxProperties: 2},
		});
		conf.set('a', 1);
		conf.set('b', 2);
		assert.throws(() => {
			conf.set('c', 3);
		}, {message: /must NOT have more than 2 properties/});
	});

	it('supports additionalProperties as a schema', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {known: {type: 'string'}},
			rootSchema: {additionalProperties: {type: 'number'}},
		});
		conf.set('known', 'ok');
		conf.set('extra', 5);
		assert.throws(() => {
			conf.set('extra', 'bad');
		}, {message: /Config schema violation/});
	});

	it('supports patternProperties', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {fixed: {type: 'string'}},
			rootSchema: {patternProperties: {'^x-': {type: 'number'}}},
		});
		conf.set('x-count', 3);
		assert.throws(() => {
			conf.set('x-count', 'bad');
		}, {message: /Config schema violation/});
	});

	it('supports contains for arrays', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {list: {type: 'array', contains: {const: 'needle'}}},
		});
		conf.set('list', ['hay', 'needle']);
		assert.throws(() => {
			conf.set('list', ['hay']);
		}, {message: /Config schema violation/});
	});

	it('supports exclusiveMinimum and multipleOf', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {score: {type: 'number', exclusiveMinimum: 0, multipleOf: 0.5}},
		});
		conf.set('score', 2.5);
		assert.throws(() => {
			conf.set('score', 0);
		}, {message: /Config schema violation/});
		assert.throws(() => {
			conf.set('score', 2.3);
		}, {message: /Config schema violation/});
	});

	it('validates nested object requirements', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {
				server: {
					type: 'object',
					properties: {
						host: {type: 'string'},
						port: {type: 'integer', minimum: 1, maximum: 65_535},
					},
					required: ['host', 'port'],
				},
			},
		});
		conf.set('server', {host: 'example.com', port: 443});
		assert.throws(() => {
			conf.set('server', {host: 'example.com', port: 0});
		}, {message: /Config schema violation/});
		assert.throws(() => {
			conf.set('server', {host: 'example.com'});
		}, {message: /Config schema violation/});
	});
});

describe('schema property names', () => {
	// A property name is a key the validator writes into the store as it is, so one that is not a key of its own cannot be written back under the same name, and would be written twice or not at all.
	const notAKeyOfItsOwn: Array<[string, string]> = [
		['a key that names a path', 'a.b'],
		['a key that names an index', 'a[0]'],
		['a key `dot-prop` refuses', 'constructor'],
		['a key `dot-prop` refuses below the root', 'a.__proto__.b'],
		['an escaped key', String.raw`a\.b`],
	];

	for (const [name, key] of notAKeyOfItsOwn) {
		it(`refuses ${name}`, () => {
			assert.throws(() => new Conf({
				cwd: createTempDirectory(),
				schema: {[key]: {type: 'number', default: 1}},
			}), {name: 'TypeError', message: /`schema` option must not contain the key/});
		});
	}

	for (const key of ['foo', '0', 'a_b', 'a-b', 'a b']) {
		it(`takes \`${key}\` as a key of its own`, () => {
			const conf = new Conf<Record<string, any>>({
				cwd: createTempDirectory(),
				schema: {[key]: {type: 'number', default: 1}},
			});
			assert.strictEqual(conf.get(key), 1);
			assert.strictEqual(conf.size, 1);
		});
	}

	it('takes a key that names a path without dot notation', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			accessPropertiesByDotNotation: false,
			schema: {'a.b': {type: 'number', default: 1}},
		});
		assert.strictEqual(conf.get('a.b'), 1);
		assert.strictEqual(conf.size, 1);
	});
});

describe('nested schema property names', () => {
	it('refuses a property name that is not a key a value can be written to, at every level', () => {
		for (const key of ['constructor', '__proto__', 'prototype']) {
			assert.throws(() => new Conf({
				cwd: createTempDirectory(),
				schema: {parent: {type: 'object', properties: {[key]: {type: 'number'}}}},
			}), {name: 'TypeError', message: /must not contain the key `parent\./});
		}
	});

	it('takes a nested property name that is a key of its own', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {parent: {type: 'object', properties: {child: {type: 'number', default: 1}}}},
		});

		// A default below the root is applied to a value the store holds, since the validator never looks below a key it does not have.
		conf.set('parent', {});
		assert.deepStrictEqual(conf.get('parent'), {child: 1});
		assert.strictEqual(conf.get('parent.child'), 1);
	});
});

describe('a nested schema property name that holds a dot', () => {
	// A name below the root is a key of its own, so a name such as a domain is one the schema can describe, and its `default` is recorded under the escaped path to it.
	it('is taken, and its `default` is what `reset()` writes back', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {sites: {type: 'object', default: {}, properties: {'example.com': {type: 'boolean', default: true}}}},
		});

		assert.deepStrictEqual(conf.get('sites'), {'example.com': true});
		conf.set(String.raw`sites.example\.com`, false);
		assert.strictEqual(conf.get(String.raw`sites.example\.com`), false);
		assert.throws(() => {
			conf.set(String.raw`sites.example\.com`, 'yes');
		}, {message: /must be boolean/});
		conf.reset(String.raw`sites.example\.com`);
		assert.deepStrictEqual(conf.get('sites'), {'example.com': true});
	});
});

describe('a nested key the additional properties rules take out', () => {
	// A value is copied as the store takes it, so the key is taken out of what is written and never out of the object the caller passed.
	it('is taken out of what is written, and not out of the value `set()` was given', () => {
		const config = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			schema: {
				nested: {
					type: 'object',
					additionalProperties: false,
					properties: {kept: {type: 'number'}},
				},
			},
			ajvOptions: {removeAdditional: true},
		});

		const value = {nested: {kept: 1, extra: 2}};
		config.set(value);

		assert.deepStrictEqual(value, {nested: {kept: 1, extra: 2}});
		assert.deepStrictEqual(config.get('nested'), {kept: 1});
	});
});

describe('a `rootSchema` that is not an object', () => {
	// `rootSchema: isDev && {…}` is a falsy value in the build where the flag is false, and a falsy one is not one that is not passed, which is how a `schema` of the same shape is already refused. The check sat below the one that skips a validator altogether, so whether the same value was refused came to depend on an unrelated option.
	it('is refused where a `schema` of the same shape is, whether or not another option brings a validator', () => {
		for (const [name, options] of [
			['`rootSchema: false`', {rootSchema: false}],
			['`rootSchema: 0`', {rootSchema: 0}],
			['`rootSchema: \'\'`', {rootSchema: ''}],
			['`ajvOptions: false`', {ajvOptions: false}],
		] as Array<[string, Record<string, unknown>]>) {
			for (const [given, rest] of [['on its own', {}], ['beside a `schema`', {schema: {}}]] as Array<[string, Record<string, unknown>]>) {
				assert.throws(
					() => new Conf({cwd: createTempDirectory(), ...options, ...rest}),
					{name: 'TypeError', message: `The \`${Object.keys(options)[0]}\` option must be an object.`},
					`${name} ${given}`,
				);
			}
		}
	});

	it('is still the same as not passing it where it is nothing', () => {
		for (const [name, options] of [
			['`rootSchema: null`', {rootSchema: null}],
			['`rootSchema: undefined`', {rootSchema: undefined}],
			['`ajvOptions: null`', {ajvOptions: null}],
			['`ajvOptions: undefined`', {ajvOptions: undefined}],
		] as Array<[string, Record<string, unknown>]>) {
			const conf = new Conf<Record<string, any>>({cwd: createTempDirectory(), ...options} as Partial<Options<Record<string, any>>>);

			conf.set('anything', 'at all');
			assert.deepEqual({...conf.store}, {anything: 'at all'}, name);
		}
	});
});

describe('a `type` the `rootSchema` names', () => {
	// The `type` of the store is the module's to write, the same as its `properties`, since a config file holds an object and nothing else. A `type` the caller wrote is read after the module's own, so one that is not an object is dropped without a word and the store is validated as the object it is rather than as what the caller asked for.
	it('is refused where it names something the store is not', () => {
		for (const type of ['array', 'string', ['array', 'null'], 'null']) {
			assert.throws(
				() => withRootSchema({type}),
				{name: 'TypeError', message: `The \`rootSchema\` option must not name a \`type\` other than \`object\`, since a store is always an object, got \`${JSON.stringify(type)}\`.`},
			);
		}
	});

	it('is left alone where it names an object', () => {
		for (const type of ['object', ['object'], ['object', 'null']]) {
			const conf = withRootSchema({type});
			conf.set('name', 'ada');
			assert.deepEqual({...conf.store}, {name: 'ada'}, JSON.stringify(type));
		}
	});
});

describe('a `patternProperties` pattern the validator cannot read', () => {
	// The patterns are read before the schema is compiled, since a key of the `defaults` option a pattern covers is left to that pattern rather than named in the `properties` beside it. A pattern the validator would refuse anyway is refused before it is given the file, so the failure is the one it is for and nothing is left behind.
	const unterminatedCharacterClass = '[';

	it('leaves the store unable to open, and no file behind', () => {
		const cwd = createTempDirectory();

		assert.throws(
			() => new Conf({
				cwd,
				defaults: {foo: 1},
				rootSchema: {patternProperties: {[unterminatedCharacterClass]: {type: 'number'}}},
			}),
			{name: 'SyntaxError'},
		);

		assert.deepEqual(fs.readdirSync(cwd), []);
	});
});

describe('a `defaults` key a rule about what a value holds is left to', () => {
	// A rule written as `false` says which keys the store has, and a key the `defaults` option names is one it has, so it is named in the `properties` and the rule is satisfied. A rule written as a schema says what a value has to be, and the value the option gives the key is one that rule has to be asked about, the same way a `set()` of the same value is.
	const valueRules: Array<[string, Record<string, unknown>]> = [
		['`additionalProperties`', {additionalProperties: {type: 'number'}}],
		['`unevaluatedProperties`', {unevaluatedProperties: {type: 'number'}}],
	];

	const keyRules: Array<[string, Record<string, unknown>]> = [
		['`additionalProperties: false`', {additionalProperties: false}],
		['`unevaluatedProperties: false`', {unevaluatedProperties: false}],
	];

	// A path the option names is filled in by the option rather than by the validator, so the key above it is one a rule covering the keys the schema does not know would take for one of its own.
	const objectRules: Array<[string, Record<string, unknown>]> = [
		['`additionalProperties`', {additionalProperties: {type: 'object', properties: {name: {type: 'string'}}}}],
		['`unevaluatedProperties`', {unevaluatedProperties: {type: 'object', properties: {name: {type: 'string'}}}}],
	];

	it('is refused where a `set()` of the same value is refused', () => {
		for (const [name, rootSchema] of valueRules) {
			assert.throws(
				() => withRootSchema(rootSchema, {defaults: {count: 'text'}}),
				{message: 'Config schema violation: `count` must be number'},
				name,
			);
		}
	});

	it('is written the same as it is where a `set()` of it is written', () => {
		for (const [name, rootSchema] of valueRules) {
			const conf = withRootSchema(rootSchema, {defaults: {count: 3}});

			conf.set('other', 1);

			assert.deepEqual({...conf.store}, {count: 3, other: 1}, name);
			assert.deepEqual(readConfigFile(conf), {count: 3, other: 1}, name);
		}
	});

	it('is refused for a path, where the value under the key above it has to hold', () => {
		for (const [name, rootSchema] of objectRules) {
			assert.throws(
				() => withRootSchema(rootSchema, {defaults: {'section.name': 7}}),
				{message: 'Config schema violation: `section/name` must be string'},
				name,
			);
		}
	});

	it('is still written for a rule that says which keys there are rather than what they hold', () => {
		for (const [name, rootSchema] of keyRules) {
			const conf = withRootSchema(rootSchema, {schema: {}, defaults: {count: 'text', 'section.name': 7}});

			assert.deepEqual({...conf.store}, {count: 'text', section: {name: 7}}, name);
			assert.deepEqual(readConfigFile(conf), {count: 'text', section: {name: 7}}, name);
		}
	});
});

describe('the bookkeeping of a migration under a rule that takes keys away', () => {
	// The bookkeeping is taken out of the store before the validator is given it, so a rule that covers the keys the schema does not know does not see it, and it is put back before anything is read of the store.
	const storeOf = (rootSchema: Record<string, unknown>) => {
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			projectVersion: '1.0.0',
			migrations: {
				'1.0.0'(store) {
					store.set('name', 'ada');
				},
			},
			schema: {name: {type: 'string'}},
			rootSchema,
		});

		conf.set('name', 'grace');

		return conf;
	};

	it('is not refused by `additionalProperties: false` and is put back afterwards', () => {
		const conf = storeOf({additionalProperties: false});

		assert.deepEqual({...conf.store}, {name: 'grace'});
		assert.deepEqual(readConfigFile(conf), {name: 'grace', __internal__: {migrations: {version: '1.0.0'}}});
	});

	it('is not refused by a `patternProperties` that matches it either', () => {
		const conf = storeOf({patternProperties: {'^__internal__$': {type: 'object'}}, additionalProperties: false});

		assert.deepEqual({...conf.store}, {name: 'grace'});
		assert.deepEqual(Object.keys(readConfigFile(conf)), ['name', '__internal__']);
	});
});

describe('a `$ref` in a `rootSchema`', () => {
	// A `$ref` is resolved against the schema the validator was given, which is the `rootSchema` spread into the `properties` of the `schema` option, so `#/$defs/<name>` is a definition of the `rootSchema` and `#/properties/<key>` is a key of the `schema` option.
	const namedByRef = {
		$defs: {name: {type: 'string'}},
		allOf: [{patternProperties: {name: {$ref: '#/$defs/name'}}}],
	};

	it('checks a `defaults` key it names', () => {
		const conf = withRootSchema(namedByRef, {defaults: {name: 'ada'}});

		assert.deepEqual({...conf.store}, {name: 'ada'});
		assert.deepEqual(readConfigFile(conf), {name: 'ada'});

		assert.throws(
			() => withRootSchema(namedByRef, {defaults: {name: 7}}),
			{message: 'Config schema violation: `name` must be string'},
		);
	});

	it('reads a definition of the option it is in, wherever it is reached from', () => {
		const conf = new Conf<Record<string, any>>({
			cwd: configDirectoryHolding({name: 'ada', child: {name: 'grace'}}),
			rootSchema: {
				$defs: {
					node: {
						type: 'object',
						properties: {
							name: {type: 'string'},
							child: {$ref: '#/$defs/node'},
						},
					},
				},
				allOf: [{$ref: '#/$defs/node'}],
			},
		} as Partial<Options<Record<string, any>>>);

		assert.deepEqual({...conf.store}, {name: 'ada', child: {name: 'grace'}});

		assert.throws(
			() => {
				conf.set('child', {name: 7});
			},
			{message: 'Config schema violation: `child/name` must be string'},
		);
	});
});

describe('a `rootSchema` rule about keys the store holds', () => {
	// A rule about the root of the store rather than about a key of it names the level, which is the root, so there is no key to name. A reader is told the rule and which key the validator blamed, which for a `propertyNames` is the key itself.
	it('reports a root-level rule without a key of its own, and the key a `propertyNames` blames', () => {
		const conf = withRootSchema({propertyNames: {pattern: '^[a-z]+$'}});

		conf.set('name', 'ada');

		assert.throws(
			() => {
				conf.set('Name', 'ada');
			},
			{message: 'Config schema violation: `` must match pattern "^[a-z]+$"; `Name` property name must be valid'},
		);
	});

	// A rule at the root is about the root object, so a key it refuses below the top is one it is not asked about. The same rule stated at the level of that key is what refuses it, which is how JSON Schema reads it and what the validator does, so a store and a bare validator answer alike.
	it('reaches only the level it is stated at, for a `propertyNames`', () => {
		const atRoot = withRootSchema<Record<string, any>>({propertyNames: {pattern: '^[a-z]+$'}}, {schema: {a: {type: 'object'}}});
		atRoot.set('a.Bad', 1);
		assert.deepStrictEqual({...atRoot.store}, {a: {Bad: 1}}, 'a key below the top the rule was not stated at');

		assert.throws(
			() => {
				withRootSchema<Record<string, any>>(
					{propertyNames: {pattern: '^[a-z]+$'}},
					{schema: {a: {type: 'object', propertyNames: {pattern: '^[a-z]+$'}}}},
				).set('a.Bad', 1);
			},
			{message: 'Config schema violation: `a` must match pattern "^[a-z]+$"; `a/Bad` property name must be valid'},
		);
	});
});

describe('a `patternProperties` pattern', () => {
	// A pattern only a unicode-mode regular expression can read is one this module asks about the same way the validator does, and a key a pattern covers is left to that pattern rather than named, so a rule the caller wrote still sees it. Where a pattern is one neither can read, the validator is the one that says so: `ajv` reports it whether or not a store is built from the schema, which the tests below show with `ajv` on its own.
	const unicodeOnlyPattern = String.raw`[\u{1F600}-\u{1F601}]`;
	const patternProperties = {[unicodeOnlyPattern]: {type: 'number'}};

	it('leaves a key the pattern covers to the pattern, which refuses a value the pattern will not hold', () => {
		// A pattern that reads without unicode mode too, so that what is under test is who checks the value rather
		// than how the pattern is compiled.
		// The key is covered by the pattern, so it is not named, and the pattern's own type is what refuses it.
		assert.throws(() => {
			new Conf<Record<string, unknown>>({
				cwd: createTempDirectory(),
				rootSchema: {patternProperties: {'^x-': {type: 'number'}}},
				defaults: {'x-1': 'text'},
			});
		}, {message: /`x-1` must be number/});
	});

	it('leaves a key the pattern does not cover named, so a rule about values still sees it', () => {
		// The key is not covered by the pattern, so it is named, and the rule about values refuses the number.
		assert.throws(() => {
			new Conf<Record<string, unknown>>({
				cwd: createTempDirectory(),
				rootSchema: {patternProperties: {'^x-': {type: 'number'}}, additionalProperties: {type: 'string'}},
				defaults: {other: 1},
			});
		}, {message: /`other` must be string/});
	});

	it('leaves a pattern neither it nor the validator can read to the validator', () => {
		// `ajv` compiles a `patternProperties` pattern in unicode mode and checks a key named in `properties` against it without one, so a pattern only unicode mode can read is refused by `ajv` itself the moment a key is named beside it, which is `ajv` and not this module: the check below is `ajv` on its own.
		assert.doesNotThrow(() => {
			new Ajv2020({allErrors: true, useDefaults: true}).compile({type: 'object', properties: {}, patternProperties});
		});

		assert.throws(() => {
			new Ajv2020({allErrors: true, useDefaults: true}).compile({
				type: 'object',
				properties: {unicorn: {default: 1}},
				patternProperties,
			});
		}, {name: 'SyntaxError'});

		// Which is the error a store built from that schema gives, since the key it names for the `defaults` is what makes the validator's check run.
		assert.throws(() => {
			new Conf({cwd: createTempDirectory(), rootSchema: {patternProperties}, defaults: {unicorn: 1}});
		}, {name: 'SyntaxError'});
	});
});

describe('a key of `ajvOptions` set to `undefined`', () => {
	// An option set to `undefined` is the same as one that is not passed, the way it is for every other option of this module, so it must not turn off the two the validator starts from. Spreading the object as it was handed the last time did turn them off, while the module still recorded the `default`s the validator was then never asked to apply, so a `clear()` and a `reset()` gave a store a value a fresh store of the same options does not have.
	const schema: Schema<Record<string, any>> = {a: {type: 'number', default: 1}, b: {type: 'string', default: 'x'}};

	const stores = (ajvOptions: Record<string, unknown>): {fresh: unknown; cleared: unknown; reset: unknown} => {
		const make = (): Conf<Record<string, any>> => new Conf({cwd: createTempDirectory(), schema, ajvOptions});

		const fresh = make();
		const cleared = make();
		cleared.clear();

		const reset = make();
		reset.set('a', 9);
		reset.reset('a');
		reset.reset('b');

		return {fresh: {...fresh.store}, cleared: {...cleared.store}, reset: {...reset.store}};
	};

	it('is the same store as passing no `ajvOptions` at all', () => {
		assert.deepStrictEqual(stores({useDefaults: undefined}), stores({}));
	});

	it('leaves a `clear()` with what a fresh store has', () => {
		assert.deepStrictEqual(stores({useDefaults: undefined}).cleared, {a: 1, b: 'x'});
	});

	it('leaves a `reset()` with what a fresh store has', () => {
		assert.deepStrictEqual(stores({useDefaults: undefined}).reset, {a: 1, b: 'x'});
	});

	it('still reports every error `allErrors` reports', () => {
		const conf = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			schema: {a: {type: 'number'}, b: {type: 'number'}},
			ajvOptions: {allErrors: undefined},
		});

		assert.throws(() => {
			conf.store = {a: 'x', b: 'y'};
		}, {message: 'Config schema violation: `a` must be number; `b` must be number'});
	});
});

describe('`useDefaults: "empty"`', () => {
	// `ajv` applies a default with `"empty"` wherever it applies one with `true`, and to a `null` and to an empty string as well. It is not "only to an empty object": a key below an object that already holds something is filled in just the same, which is what `ajv/dist/compile/validate/defaults.js` generates. So the module records the `default`s for it exactly as it does for `true`, and a `clear()` and a `reset()` cannot write a default into a place the validator would have left alone.
	const schema: Schema<Record<string, any>> = {a: {type: 'string', default: 'x'}};

	const storeWith = (data: unknown, useDefaults: boolean | 'empty'): Conf<Record<string, any>> => {
		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify(data));
		return new Conf({cwd, schema, ajvOptions: {useDefaults}});
	};

	it('applies the default to a `null`, which `true` leaves as it is', () => {
		assert.strictEqual(storeWith({a: null}, 'empty').get('a'), 'x');
		assert.throws(() => storeWith({a: null}, true).get('a'), {message: 'Config schema violation: `a` must be string'});
	});

	it('applies the default to an empty string, which `true` leaves as it is', () => {
		assert.strictEqual(storeWith({a: ''}, 'empty').get('a'), 'x');
		assert.strictEqual(storeWith({a: ''}, true).get('a'), '');
	});

	it('applies a default below a key that already holds something, the way `true` does', () => {
		const nested: Schema<Record<string, any>> = {a: {type: 'object', properties: {b: {type: 'number', default: 7}, c: {type: 'number'}}}};

		for (const useDefaults of [true, 'empty'] as const) {
			const cwd = createTempDirectory();
			fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({a: {c: 1}}));
			const conf = new Conf<Record<string, any>>({cwd, schema: nested, ajvOptions: {useDefaults}});
			assert.deepStrictEqual({...conf.store}, {a: {c: 1, b: 7}}, `with \`useDefaults: ${JSON.stringify(useDefaults)}\``);
		}
	});

	// Every shape of `default` a `clear()` and a `reset()` write back has to give what a fresh store gives, since the module records the defaults for `"empty"` as it does for `true`.
	it('is recorded the same as `true`, so a `clear()` and a `reset()` agree with a fresh store', () => {
		const shapes: Array<Schema<Record<string, any>>> = [
			{a: {type: 'number', default: 5}},
			{a: {type: 'object', default: {}, properties: {b: {type: 'number', default: 2}}}},
			{a: {type: 'array', default: [], items: {type: 'number', default: 7}}},
			{a: {type: 'object', default: {b: 9}, properties: {b: {type: 'number', default: 2}}}},
		];

		for (const [index, shape] of shapes.entries()) {
			const make = (): Conf<Record<string, any>> => new Conf({cwd: createTempDirectory(), schema: shape, ajvOptions: {useDefaults: 'empty'}});
			const expected = {...make().store};

			const cleared = make();
			cleared.clear();
			assert.deepStrictEqual({...cleared.store}, expected, `the store after a clear() of shape ${index}`);

			const reset = make();
			reset.store = {};
			reset.reset('a');
			assert.deepStrictEqual({...reset.store}, expected, `the store after a reset() of shape ${index}`);
		}
	});
});

describe('`removeAdditional` and the bookkeeping key', () => {
	// The bookkeeping lives under a key the root of the schema does not name, so a rule that takes the keys the schema does not know away would take it out of every write, and every migration would run again on the next construction. `#validate()` takes the key out before the validator is asked to do anything and puts it back afterwards, so the validator never sees it at all.
	const schema: Schema<Record<string, any>> = {touched: {type: 'boolean'}};
	const rootSchema = {additionalProperties: false};

	for (const [name, removeAdditional] of [
		['`true`', true],
		['`"all"`', 'all'],
		['`"failing"`', 'failing'],
	] as Array<[string, boolean | 'all' | 'failing']>) {
		it(`keeps the recorded version in the file, with ${name}`, () => {
			const cwd = createTempDirectory();
			fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({}));

			let runs = 0;
			const make = (): Conf<Record<string, any>> => new Conf({
				cwd,
				projectVersion: '2.0.0',
				migrations: {
					'1.0.0'(store) {
						runs++;
						store.set('touched', true);
					},
				},
				schema,
				rootSchema,
				ajvOptions: {removeAdditional},
			});

			const conf = make();
			assert.strictEqual(runs, 1, 'the step runs once');
			assert.strictEqual(getMigrationVersion(conf), '2.0.0');

			// A key write and a whole store write each read the file for themselves, and each of them must leave the bookkeeping in it.
			conf.set('touched', false);
			assert.strictEqual(getMigrationVersion(conf), '2.0.0', 'the version after a key write');

			conf.store = {touched: true};
			assert.strictEqual(getMigrationVersion(conf), '2.0.0', 'the version after a whole store write');

			const reopened = make();
			assert.strictEqual(getMigrationVersion(reopened), '2.0.0', 'the version after reopening');
			assert.strictEqual(runs, 1, 'the step does not run again');
		});
	}

	// The bookkeeping is the caller's own key as far as the schema is concerned nowhere, and `set()` still refuses it.
	it('is not a key the store holds, and a write of it is refused', () => {
		const cwd = createTempDirectory();
		const conf = new Conf<Record<string, any>>({
			cwd,
			schema,
			rootSchema,
			ajvOptions: {removeAdditional: 'all'},
		});

		assert.deepStrictEqual({...conf.store}, {});
		assert.throws(() => {
			conf.set('__internal__', 1);
		}, {name: 'TypeError', message: /__internal__/});
	});
});

describe('`coerceTypes` and what a `clear()` and a `reset()` write back', () => {
	// The module records the `default`s as the caller wrote them, and a write goes through the validator, so a recorded value the validator rewrites is written back coerced. That is what the option says, and it is also what a fresh store of the same options has, so the file and a `clear()` and a `reset()` all agree.
	const agreed = (
		name: string,
		options: {schema: Schema<Record<string, any>>; ajvOptions: Record<string, unknown>; defaults?: Record<string, unknown>},
		expected: unknown,
		clobber: unknown,
	) => {
		const make = (): Conf<Record<string, any>> => new Conf({cwd: createTempDirectory(), ...options});
		const file = (conf: Conf<Record<string, any>>) => readConfigFile(conf.path);

		const fresh = make();
		assert.deepStrictEqual({...fresh.store}, expected, `a fresh store, ${name}`);
		assert.deepStrictEqual(file(fresh), expected, `the file of a fresh store, ${name}`);

		const cleared = make();
		cleared.clear();
		assert.deepStrictEqual({...cleared.store}, expected, `a clear(), ${name}`);
		assert.deepStrictEqual(file(cleared), expected, `the file after a clear(), ${name}`);

		const reset = make();
		reset.store = {};
		reset.set('a', clobber);
		reset.reset('a');
		assert.deepStrictEqual({...reset.store}, expected, `a reset(), ${name}`);
		assert.deepStrictEqual(file(reset), expected, `the file after a reset(), ${name}`);
	};

	it('writes back a `default` of the schema it coerced, and the file agrees with a fresh store', () => {
		agreed('a `default` of the schema', {
			schema: {a: {type: 'number', default: '1'}},
			ajvOptions: {coerceTypes: true},
		}, {a: 1}, 9);
	});

	it('writes back a `defaults` value it coerced, and the file agrees with a fresh store', () => {
		agreed('a `defaults` value', {
			schema: {a: {type: 'number'}},
			ajvOptions: {coerceTypes: true},
			defaults: {a: '1'},
		}, {a: 1}, 9);
	});

	it('writes back a `default` below another one it coerced', () => {
		agreed('a `default` below another one', {
			schema: {a: {type: 'object', default: {b: '1'}, properties: {b: {type: 'number'}}}},
			ajvOptions: {coerceTypes: true},
		}, {a: {b: 1}}, {b: 9});
	});

	// `'array'` wraps a value that is not a list in one, which is the one coercion a fresh store and a reset do not necessarily have to agree about, since the wrapped value is what the file holds and what the file is read back as.
	it('writes back a `default` it wrapped in a list', () => {
		agreed('a `default` of the schema', {
			schema: {a: {type: 'array', items: {type: 'number'}, default: 1}},
			ajvOptions: {coerceTypes: 'array'},
		}, {a: [1]}, 9);
	});

	it('writes back a `defaults` value it wrapped in a list', () => {
		agreed('a `defaults` value', {
			schema: {a: {type: 'array', items: {type: 'number'}}},
			ajvOptions: {coerceTypes: 'array'},
			defaults: {a: 1},
		}, {a: [1]}, 9);
	});
});

describe('a `defaults` key a `patternProperties` of the root covers', () => {
	// A `defaults` key is named as a property of the root so that a rule for the keys the schema does not know leaves it alone, and `removeAdditional` does not take it out. The one exception is a key a `patternProperties` already covers, which cannot be named as a property as well, so it is left to the pattern, which checks the value just the same. The module asks that with `new RegExp(pattern)`, which is what `ajv`'s own strict check asks with.
	it('is left to the pattern, whatever the value under it is', () => {
		const rootSchema = {
			patternProperties: {'^a$': {type: 'number'}},
			additionalProperties: false,
		};

		for (const ajvOptions of [{}, {unicodeRegExp: false}, {unicodeRegExp: true}]) {
			const conf = new Conf<Record<string, any>>({
				cwd: createTempDirectory(),
				rootSchema,
				defaults: {a: 1},
				ajvOptions,
			});
			assert.deepStrictEqual({...conf.store}, {a: 1}, `with ${JSON.stringify(ajvOptions)}`);
		}
	});

	it('is refused by the pattern where the value does not fit it', () => {
		const rootSchema = {
			patternProperties: {'^a$': {type: 'number'}},
			additionalProperties: false,
		};

		assert.throws(
			() => new Conf<Record<string, any>>({cwd: createTempDirectory(), rootSchema, defaults: {a: 'text'}}),
			{message: 'Config schema violation: `a` must be number'},
		);
	});

	it('is left to the pattern on the way down a `defaults` path, where the keys along it are named', () => {
		const rootSchema = {
			patternProperties: {'^a$': {type: 'object'}},
			additionalProperties: false,
		};
		const conf = new Conf<Record<string, any>>({
			cwd: createTempDirectory(),
			rootSchema,
			defaults: {'a.b': 1},
			ajvOptions: {removeAdditional: true},
		});

		assert.deepStrictEqual({...conf.store}, {a: {b: 1}});
	});
});

describe('a `schema` key that is not a key of its own', () => {
	it('tells a key that names a path to use the `properties` of a key', () => {
		assert.throws(() => new Conf({cwd: createTempDirectory(), schema: {'a.b': {type: 'string'}}}), {message: 'The `schema` option must not contain the key `a.b`, which is not a key of its own. Use the `properties` of a key for the keys below the root.'});
	});

	it('tells a name no value can be written to that it is one, rather than advice that does not apply to it', () => {
		assert.throws(() => new Conf({cwd: createTempDirectory(), schema: {constructor: {type: 'string'}}}), {message: 'The `schema` option must not contain the key `constructor`, which is not a key a value can be written to.'});
	});

	it('tells a name no value can be written to below the root that it is one', () => {
		// The `properties` of a key is where the caller already put it, so advice to use one is advice they have followed.
		assert.throws(() => new Conf({cwd: createTempDirectory(), schema: {a: {type: 'object', properties: {prototype: {type: 'string'}}}}}), {message: 'The `schema` option must not contain the key `a.prototype`, which is not a key a value can be written to.'});
	});
});

describe('a schema violation that is about a key', () => {
	it('names the key an additional property is refused for', () => {
		const cwd = createTempDirectory();
		writeConfigFile(cwd, JSON.stringify({old: true, other: 2}));

		assert.throws(() => new Conf({cwd, rootSchema: {additionalProperties: false}}), {message: 'Config schema violation: `old` must NOT have additional properties; `other` must NOT have additional properties'});
	});

	it('names the key an additional property is refused for below the root', () => {
		const cwd = createTempDirectory();
		writeConfigFile(cwd, JSON.stringify({nested: {x: 1, y: 2}}));

		assert.throws(() => new Conf({cwd, schema: {nested: {type: 'object', additionalProperties: false}}}), {message: 'Config schema violation: `nested/x` must NOT have additional properties; `nested/y` must NOT have additional properties'});
	});

	it('names the key an additional property is refused for under a key holding a slash', () => {
		const cwd = createTempDirectory();
		writeConfigFile(cwd, JSON.stringify({'a/b': {c: 1}}));

		// The validator writes the path as a JSON pointer, so the slash in the key is escaped there and read back here.
		assert.throws(() => new Conf({cwd, schema: {'a/b': {type: 'object', additionalProperties: false}}}), {message: 'Config schema violation: `a/b/c` must NOT have additional properties'});
	});

	it('names the key a property name is refused for', () => {
		const cwd = createTempDirectory();
		writeConfigFile(cwd, JSON.stringify({Bad: 1}));

		assert.throws(() => new Conf({cwd, rootSchema: {propertyNames: {pattern: '^[a-z]+$'}}, schema: {}}), {message: /`Bad`/});
	});

	it('names the key an unevaluated property is refused for', () => {
		const cwd = createTempDirectory();
		writeConfigFile(cwd, JSON.stringify({known: 1, extra: 2}));

		assert.throws(() => new Conf({cwd, rootSchema: {unevaluatedProperties: false}, schema: {known: {type: 'number'}}}), {message: /`extra`/});
	});

	it('names the key a missing property is reported for', () => {
		const cwd = createTempDirectory();
		writeConfigFile(cwd, JSON.stringify({}));

		assert.throws(() => new Conf({cwd, rootSchema: {required: ['needed']}, schema: {}}), {message: /must have required property 'needed'/});
	});
});

describe('the `schema` option', () => {
	it('schema - valid set', () => {
		const schema: Schema<{foo: {bar: number; foobar: number}}> = {
			foo: {
				type: 'object',
				properties: {
					bar: {
						type: 'number',
					},
					foobar: {
						type: 'number',
						maximum: 100,
					},
				},
			},
		};
		const conf = new Conf({cwd: createTempDirectory(), schema});
		assert.doesNotThrow(() => {
			conf.set('foo', {bar: 1, foobar: 2});
		});
		assert.deepStrictEqual(conf.get('foo'), {bar: 1, foobar: 2});

		// The same schema refuses a value past the maximum, so the set above passed because the value is valid.
		assert.throws(() => {
			conf.set('foo', {bar: 1, foobar: 101});
		}, {message: 'Config schema violation: `foo/foobar` must be <= 100'});
		assert.deepStrictEqual(conf.get('foo'), {bar: 1, foobar: 2});
	});

	it('schema - one violation', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {foo: {type: 'string'}},
		});
		assert.throws(() => {
			conf.set('foo', 1);
		}, {message: 'Config schema violation: `foo` must be string'});
	});

	it('schema - multiple violations', () => {
		const schema: Schema<{foo: {bar: number; foobar: number}}> = {
			foo: {
				type: 'object',
				properties: {
					bar: {
						type: 'number',
					},
					foobar: {
						type: 'number',
						maximum: 100,
					},
				},
			},
		};
		const conf = new Conf({cwd: createTempDirectory(), schema});
		assert.throws(() => {
			// A value the schema rejects is a value the type does not allow, which the test gives it to reach the check the runtime makes.
			conf.set('foo', {bar: '1', foobar: 101} as unknown as {bar: number; foobar: number});
		}, {message: 'Config schema violation: `foo/bar` must be number; `foo/foobar` must be <= 100'});
	});

	// The path the validator reports is a JSON pointer, which writes a `/` in a key as `~1` and a `~` as `~0`. The message names the key the caller wrote, so the pointer is read back into it.
	it('schema - names a key the JSON pointer of its path escapes', () => {
		const schema: Schema<Record<'a/b' | 'c~d' | 'e~1f' | 'g~0h', number>> = {
			'a/b': {type: 'number'},
			'c~d': {type: 'number'},
			'e~1f': {type: 'number'},
			'g~0h': {type: 'number'},
		};

		const cwd = createTempDirectory();
		fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({
			'a/b': 'x',
			'c~d': 'x',
			'e~1f': 'x',
			'g~0h': 'x',
		}));
		assert.throws(() => new Conf({
			cwd,
			schema,
		}), {message: 'Config schema violation: `a/b` must be number; `c~d` must be number; `e~1f` must be number; `g~0h` must be number'});
	});

	it('schema - names an escaped key below the top level', () => {
		const schema: Schema<{nested: Record<'a/b', number>}> = {
			nested: {type: 'object', properties: {'a/b': {type: 'number'}}},
		};

		const conf = new Conf({cwd: createTempDirectory(), schema});
		assert.throws(() => {
			// A value the schema rejects is a value the type does not allow, which the test gives it to reach the check the runtime makes.
			conf.set('nested', {'a/b': 'x'} as unknown as {'a/b': number});
		}, {message: 'Config schema violation: `nested/a/b` must be number'});
	});

	it('schema - complex schema', () => {
		const schema: Schema<{foo: string; bar: number[]}> = {
			foo: {
				type: 'string',
				maxLength: 3,
				pattern: '[def]+',
			},
			bar: {
				type: 'array',
				uniqueItems: true,
				maxItems: 3,
				items: {
					type: 'integer',
				},
			},
		};
		const conf = new Conf({cwd: createTempDirectory(), schema});
		assert.throws(() => {
			conf.set('foo', 'abca');
		}, {message: 'Config schema violation: `foo` must NOT have more than 3 characters; `foo` must match pattern "[def]+"'});
		assert.throws(() => {
			// A value the schema rejects is a value the type does not allow, which the test gives it to reach the check the runtime makes.
			conf.set('bar', [1, 1, 2, 'a'] as unknown as number[]);
		}, {message: 'Config schema violation: `bar` must NOT have more than 3 items; `bar/3` must be integer; `bar` must NOT have duplicate items (items ## 1 and 0 are identical)'});
	});

	it('schema - supports formats', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {foo: {type: 'string', format: 'uri'}},
		});
		assert.throws(() => {
			conf.set('foo', 'bar');
		}, {message: 'Config schema violation: `foo` must match format "uri"'});
	});

	it('schema - invalid write to config file', () => {
		const schema: Schema<{foo: string}> = {foo: {type: 'string'}};
		const cwd = createTempDirectory();

		const conf = new Conf({cwd, schema});
		const schemaPath = path.join(cwd, 'config.json');
		fs.writeFileSync(schemaPath, JSON.stringify({foo: 1}));
		fs.statSync(schemaPath);
		assert.throws(() => {
			conf.get('foo');
		}, {message: 'Config schema violation: `foo` must be string'});
	});

	it('schema - validate rootSchema', () => {
		assert.throws(() => {
			const conf = new Conf({
				cwd: createTempDirectory(),
				rootSchema: {
					additionalProperties: false,
				},
			});
			conf.set('foo', 'bar');
		}, {message: 'Config schema violation: `foo` must NOT have additional properties'});
	});

	it('rejects schema-invalid elements in appendToArray without touching the file', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {numbers: {type: 'array', items: {type: 'number'}}},
		});
		conf.set('numbers', [1, 2]);
		const before = fs.readFileSync(conf.path, 'utf8');
		assert.throws(() => {
			conf.appendToArray('numbers', 'bad');
		}, {message: /Config schema violation/});
		assert.strictEqual(fs.readFileSync(conf.path, 'utf8'), before);
		assert.deepStrictEqual(conf.get('numbers'), [1, 2]);
	});

	it('reports the nested index path for invalid appended elements', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			schema: {numbers: {type: 'array', items: {type: 'number'}}},
		});
		conf.set('numbers', [1, 2]);
		assert.throws(() => {
			conf.appendToArray('numbers', 'bad');
		}, {message: 'Config schema violation: `numbers/2` must be number'});
	});

	it('ignores a schema entry that has nothing to keep', () => {
		const store = new Conf<Record<string, unknown>>({
			cwd: createTempDirectory(),
			schema: {
				a: true,
				b: {type: 'number', default: undefined},
				c: {type: 'number', default: 1},
			},
		});

		store.set('a', 'anything');
		store.set('b', 2);

		// An entry that is not an object holds no `default`, and one set to `undefined` is the same as one that is not passed, so neither is kept for a reset.
		store.reset('a', 'b', 'c');
		assert.deepStrictEqual(store.store, createNullProtoObject({a: 'anything', b: 2, c: 1}));

		store.clear();
		assert.deepStrictEqual(store.store, createNullProtoObject({c: 1}));
	});
});

describe('the `rootSchema` option', () => {
	for (const key of ['constructor', 'a[x']) {
		it(`overrides the schema default for the literal key ${key}`, () => {
			const cwd = createTempDirectory();
			writeConfigFile(cwd, JSON.stringify({[key]: null}));
			const conf = new Conf({
				cwd,
				accessPropertiesByDotNotation: false,
				defaults: {[key]: 1},
				schema: {[key]: {type: 'number', default: 2}},
				ajvOptions: {useDefaults: 'empty'},
			});

			assert.equal(conf.get(key), 1);
			assert.deepStrictEqual(readConfigFile(conf), {[key]: 1});
		});

		for (const removeAdditional of [false, true]) {
			it(`keeps the literal default key ${key} with removeAdditional ${String(removeAdditional)}`, () => {
				const conf = new Conf({
					cwd: createTempDirectory(),
					accessPropertiesByDotNotation: false,
					defaults: {[key]: 1},
					schema: {},
					rootSchema: {additionalProperties: false},
					ajvOptions: {removeAdditional},
				});

				assert.equal(conf.get(key), 1);
				assert.deepStrictEqual(readConfigFile(conf), {[key]: 1});
			});
		}
	}

	it('`rootSchema` accepts root keywords without root `properties`', () => {
		const conf = new Conf({
			cwd: createTempDirectory(),
			rootSchema: {
				patternProperties: {
					'^.*$': {
						type: 'object',
						properties: {
							schedule: {type: 'string'},
							start: {type: 'boolean', default: true},
						},
					},
				},
			},
		});

		conf.set('task', {schedule: 'daily'});
		assert.deepStrictEqual(conf.get('task'), {schedule: 'daily', start: true});

		assert.throws(() => {
			conf.set('task', {schedule: 1});
		}, {message: 'Config schema violation: `task/schedule` must be string'});
	});

	it('`rootSchema` throws when it has a `properties` key', () => {
		assert.throws(() => {
			new Conf({
				cwd: createTempDirectory(),
				rootSchema: {
					properties: {foo: {type: 'string'}},
				},
			});
		}, {message: 'The `rootSchema` option must not contain a `properties` key. Use the `schema` option for properties.'});
	});

	it('refuses properties inside rootSchema', () => {
		assert.throws(() => {
			new Conf({cwd: createTempDirectory(), rootSchema: {properties: {a: {type: 'string'}}}});
		}, {message: /must not contain a `properties` key/});
	});
});
