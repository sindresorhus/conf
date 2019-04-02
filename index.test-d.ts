import {expectType, expectError} from 'tsd';
import Conf = require('.');

const conf = new Conf<string | number | boolean>();
new Conf<string>({
	defaults: {
		foo: 'bar',
		unicorn: 'rainbow'
	}
});
new Conf<string>({configName: ''});
new Conf<string>({projectName: 'foo'});
new Conf<string>({cwd: ''});
new Conf<string>({encryptionKey: ''});
new Conf<string>({encryptionKey: new Buffer('')});
new Conf<string>({encryptionKey: new Uint8Array([1])});
new Conf<string>({encryptionKey: new DataView(new ArrayBuffer(2))});
new Conf<string>({fileExtension: '.foo'});
new Conf<string>({clearInvalidConfig: false});
new Conf<string>({serialize: value => 'foo'});
new Conf<string>({deserialize: string => ({})});
new Conf<string>({projectSuffix: 'foo'});

new Conf<string>({schema: {foo: {type: 'string'}}});
expectError(new Conf<string>({schema: {foo: {type: 'nope'}}}));

conf.set('foo', 'bar');
conf.set('hello', 1);
conf.set('unicorn', false);

expectType<string | number | boolean>(conf.get('foo'));
expectType<string | number | boolean>(conf.get('foo', 'bar'));
conf.delete('foo');
expectType<boolean>(conf.has('foo'));
conf.clear();
conf.onDidChange('foo', (oldValue, newValue) => {
	expectType<string | number | boolean | undefined>(oldValue);
	expectType<string | number | boolean | undefined>(newValue);
});

conf.store = {
	foo: 'bar',
	unicorn: 'rainbow'
};
expectType<string>(conf.path);
expectType<number>(conf.size);

expectType<IterableIterator<[string, string | number | boolean]>>(
	conf[Symbol.iterator]()
);
for (const [key, value] of conf) {
	expectType<string>(key);
	expectType<string | number | boolean>(value);
}
