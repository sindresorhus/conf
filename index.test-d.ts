import { expectType, expectError } from "tsd";
import Conf = require(".");

type UnicornFoo = {
	foo: string;
	unicorn: boolean;
	hello?: number;
};

const conf = new Conf<UnicornFoo>();
new Conf<UnicornFoo>({
	defaults: {
		foo: "bar",
		unicorn: false
	}
});
new Conf<UnicornFoo>({ configName: "" });
new Conf<UnicornFoo>({ projectName: "foo" });
new Conf<UnicornFoo>({ cwd: "" });
new Conf<UnicornFoo>({ encryptionKey: "" });
new Conf<UnicornFoo>({ encryptionKey: new Buffer("") });
new Conf<UnicornFoo>({ encryptionKey: new Uint8Array([1]) });
new Conf<UnicornFoo>({ encryptionKey: new DataView(new ArrayBuffer(2)) });
new Conf<UnicornFoo>({ fileExtension: ".foo" });
new Conf<UnicornFoo>({ clearInvalidConfig: false });
new Conf<UnicornFoo>({ serialize: value => "foo" });
new Conf<UnicornFoo>({ deserialize: string => ({}) });
new Conf<UnicornFoo>({ projectSuffix: "foo" });

new Conf<UnicornFoo>({
	schema: {
		foo: { type: "string" },
		unicorn: { type: "boolean" },
		hello: { type: "number" }
	}
});
expectError(
	new Conf<UnicornFoo>({
		schema: {
			foo: { type: "nope" },
			unicorn: { type: "nope" },
			hello: { type: "nope" }
		}
	})
);

conf.set("foo", "bar");
conf.set("hello", 1);
conf.set("unicorn", false);

expectType<string>(conf.get("foo"));
expectType<string>(conf.get("foo", "bar"));
conf.delete("foo");
expectType<boolean>(conf.has("foo"));
conf.clear();
const off = conf.onDidChange("foo", (oldValue, newValue) => {
	expectType<string | number | boolean | undefined>(oldValue);
	expectType<string | number | boolean | undefined>(newValue);
});

expectType<() => void>(off);
off();

conf.store = {
	foo: "bar",
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
