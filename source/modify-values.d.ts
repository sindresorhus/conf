declare module 'modify-values' {
	declare function modifyValues<KeyType extends PropertyKey, ValueType, ReturnValueType>(object: Record<KeyType, ValueType>, transformer: (value: ValueType, key: KeyType) => ReturnValueType): Record<KeyType, ReturnValueType>;

	export = modifyValues;
}
