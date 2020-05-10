/* eslint-disable no-new */
import {expectType, expectError, expectAssignable} from 'tsd';
import {Conf} from '../source';

type UnicornFoo = {
	foo: string;
	unicorn: boolean;
	nested?: {
		prop: number;
	};
	hello?: number;
};

const conf = new Conf<UnicornFoo>({accessPropertiesByDotNotation: true});
new Conf<UnicornFoo>({
	defaults: {
		foo: 'bar',
		unicorn: false
	}
});
new Conf<UnicornFoo>({configName: ''});
new Conf<UnicornFoo>({projectName: 'foo'});
new Conf<UnicornFoo>({cwd: ''});
new Conf<UnicornFoo>({encryptionKey: ''});
new Conf<UnicornFoo>({encryptionKey: Buffer.from('')});
new Conf<UnicornFoo>({encryptionKey: new Uint8Array([1])});
new Conf<UnicornFoo>({encryptionKey: new DataView(new ArrayBuffer(2))});
new Conf<UnicornFoo>({fileExtension: '.foo'});
new Conf<UnicornFoo>({clearInvalidConfig: false});
new Conf<UnicornFoo>({serialize: () => 'foo'});
new Conf<UnicornFoo>({deserialize: () => ({foo: 'foo', unicorn: true})});
new Conf<UnicornFoo>({projectSuffix: 'foo'});
new Conf<UnicornFoo>({watch: true});

new Conf<UnicornFoo>({
	schema: {
		foo: {
			type: 'string',
			default: 'foobar'
		},
		unicorn: {
			type: 'boolean'
		},
		hello: {
			type: 'number'
		}
	}
});

expectError(
	new Conf<UnicornFoo>({
		schema: {
			foo: {
				// @ts-ignore
				type: 'nope'
			},
			unicorn: {
				// @ts-ignore
				type: 'nope'
			},
			hello: {
				// @ts-ignore
				type: 'nope'
			}
		}
	})
);

conf.set('hello', 1);
conf.set('unicorn', false);
conf.set({foo: 'nope'});

conf.set('nested.prop', 3);

conf.set({
	nested: {
		prop: 3
	}
});

expectType<string | undefined>(conf.get('foo'));
expectType<void>(conf.reset('foo', 'unicorn'));
expectType<string>(conf.get('foo', 'bar'));
conf.delete('foo');
expectType<boolean>(conf.has('foo'));
conf.clear();
const off = conf.onDidChange('foo', (oldValue, newValue) => {
	expectAssignable<UnicornFoo[keyof UnicornFoo]>(oldValue);
	expectAssignable<UnicornFoo[keyof UnicornFoo]>(newValue);
});

expectType<() => void>(off);
off();

conf.store = {
	foo: 'bar',
	unicorn: false
};
expectType<string>(conf.path);
expectType<number>(conf.size);

expectType<IterableIterator<[keyof UnicornFoo, UnicornFoo[keyof UnicornFoo]]>>(
	conf[Symbol.iterator]()
);
for (const [key, value] of conf) {
	expectType<keyof UnicornFoo>(key);
	expectType<UnicornFoo[keyof UnicornFoo]>(value);
}

// -- Docs examples --

type StoreType = {
	isRainbow: boolean;
	unicorn?: string;
};

const config = new Conf<StoreType>({
	defaults: {
		isRainbow: true
	}
});

config.get('isRainbow');
//=> true

config.set('unicorn', '🦄');
console.log(config.get('unicorn'));
//=> '🦄'

config.delete('unicorn');
console.log(config.get('unicorn'));
//=> undefined

// --

// -- Migrations --
new Conf({
	migrations: {
		'0.0.1': store => {
			store.set('debug phase', true);
		},
		'1.0.0': store => {
			store.delete('debug phase');
			store.set('phase', '1.0');
		},
		'1.0.2': store => {
			store.set('phase', '>1.0');
		}
	}
});
// --