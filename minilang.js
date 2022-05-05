const Trampolines = [];
const MethodsCache = {};
export const Globals = {};

const EndState = {run: function(_, value) {
	console.log("Result: ", value);
}}

let mlRunning = false;
export function ml_exec() {
	Trampolines.push(Array.prototype.slice.apply(arguments));
	if (!mlRunning) {
		mlRunning = true;
		try {
			while (Trampolines.length) {
				let trampoline = Trampolines.shift();
				let func = trampoline.shift();
				func.apply(null, trampoline);
			}
		} finally {
			mlRunning = false;
		}
	}
}

export function ml_resume(state, value) {
	ml_exec(state.run, state, value);
}

export function ml_typeof(self) {
	if (self == null) return MLNilT;
	if (self === undefined) return MLNilT;
	switch (typeof(self)) {
	case "boolean": return MLBooleanT;
	case "string": return MLStringT;
	case "number": return MLNumberT;
	case "function": return MLJSFunctionT;
	default: return self.ml_type;
	}
}

export function ml_hash(self) {
	return ml_typeof(self).ml_hash(self);
}

export function ml_deref(self) {
	return ml_typeof(self).ml_deref(self);
}

export function ml_assign(self, value) {
	return ml_typeof(self).ml_assign(self, value);
}

export function ml_call(caller, self, args) {
	ml_exec(ml_typeof(self).ml_call, caller || EndState, self, args);
}

export function ml_iterate(caller, self) {
	ml_exec(ml_typeof(self).iterate, caller, self);
}

export function ml_iter_next(caller, self) {
	ml_exec(ml_typeof(self).iter_next, caller, self);
}

export function ml_iter_key(caller, self) {
	ml_exec(ml_typeof(self).iter_key, caller, self);
}

export function ml_iter_value(caller, self) {
	ml_exec(ml_typeof(self).iter_value, caller, self);
}

export function ml_unpack(self, index) {
	return ml_typeof(self).unpack(self, index);
}

const DefaultMethods = {
	ml_hash: function(self) { return self.toString(); },
	ml_deref: function(self) { return self; },
	ml_assign: function(self, _) { return ml_error("TypeError", `<${ml_typeof(self).name}> is not assignable`); },
	ml_call: function(caller, self, args) {
		ml_call(caller, callMethod, [self].concat(args));
	},
	iterate: function(caller, self) {
		ml_resume(caller, ml_error("TypeError", `<${ml_typeof(self).name}> is not iteratable`));
	}
};

export const MLTypeT = {
	name: "type",
	prototype: {},
	rank: 2,
	exports: {},
	ml_hash: function(self) { return `<${ml_typeof(self).name}>`; },
	ml_deref: DefaultMethods.ml_deref,
	ml_assign: DefaultMethods.ml_assign,
	ml_call: function(caller, self, args) {
		ml_call(caller, self.of, args);
	},
	of: function(caller, args) {
		ml_resume(caller, ml_typeof(args[0]));
	}
};
MLTypeT.ml_type = MLTypeT;
Object.defineProperty(MLTypeT.prototype, "ml_type", {value: MLTypeT});
Globals.type = MLTypeT;

export function ml_type(name, parents, methods) {
	parents = parents || [];
	if (name !== 'any') parents.push(MLAnyT);
	const type = Object.assign(Object.create(MLTypeT.prototype), DefaultMethods, methods);
	type.name = name;
	type.parents = parents;
	let rank = 0;
	for (let i = 0; i < parents.length; ++i) {
		rank = Math.max(rank, parents[i].rank);
	}
	type.parents.unshift(type);
	type.rank = rank + 1;
	type.exports = {};
	type.prototype = {ml_type: type};
	Globals[name] = type;
	return type;
}

export function ml_value(type, fields) {
	return Object.assign(Object.create(type.prototype), fields);
}

export function ml_is(value, type) {
	let actual = ml_typeof(value);
	if (actual === type) return true;
	if (actual.parents.indexOf(type) > -1) return true;
	if (type === MLAnyT) return true;
	return false;
}

export const MLAnyT = ml_type("any");
MLTypeT.parents = [MLTypeT, MLAnyT];

export function ml_identity(caller, args) {
	ml_resume(caller, args[0]);
}

export const MLFunctionT = ml_type("function");
export const MLIteratableT = ml_type("iteratable");

export const MLNilT = ml_type("nil");
export const MLNil = null;

export const MLSomeT = ml_type("some");
export const MLSome = ml_value(MLSomeT);

export const MLBlankT = ml_type("blank", [], {
	ml_assign: function(_, value) { return value; }
});
export const MLBlank = ml_value(MLBlankT);

export const MLErrorT = ml_type("error");
export function ml_error(type, message) {
	return ml_value(MLErrorT, {type, message, stack: []});
}
export function ml_error_trace_add(error, source, line) {
	error.stack.push([source, line]);
}

export const MLErrorValueT = ml_type("error-value");
export function ml_error_value(error) {
	let type = error.type;
	let message = error.message;
	let stack = error.stack;
	return ml_value(MLErrorValueT, {type, message, stack});
}

export const MLMethodT = ml_type("method", [MLFunctionT], {
	ml_hash: function(self) { return ":" + self.name; },
	ml_call: function(caller, self, args) {
		let signature = "";
		for (let i = 0; i < args.length; ++i) {
			args[i] = ml_deref(args[i]);
			signature += "/" +ml_typeof(args[i]).name;
		}
		let func = self.signatures[signature];
		if (!func) {
			let bestScore = 0;
			let bestFunc = null;
			let count = args.length;
			for (let i = 0; i < self.definitions.length; ++i) {
				let definition = self.definitions[i];
				if (definition.count > count) continue;
				if (definition.count < count && !definition.variadic) continue;
				let score = score_definition(definition.types, args);
				if (score > bestScore) {
					bestScore = score;
					bestFunc = definition.func;
				}
			}
			if (!bestFunc) {
				signature = "";
				for (let i = 0; i < args.length; ++i) signature += ", " + ml_typeof(args[i]).name;
				signature = signature.substring(2);
				return ml_resume(caller, ml_error("MethodError", `no method found for ${self.name}(${signature})`));
			}
			func = self.signatures[signature] = bestFunc;
		}
		return ml_call(caller, func, args);

		function score_definition(types, args) {
			let score = 0;
			for (let i = 0; i < types.length; ++i) {
				let type = types[i];
				if (ml_typeof(args[i]).parents.indexOf(type) === -1) return -1;
				score += type.rank;
			}
			return score;
		}
	}
});
export function ml_method(name) {
	if (name == null) return ml_value(MLMethodT, {name});
	if (MethodsCache.hasOwnProperty(name)) return MethodsCache[name];
	return (MethodsCache[name] = ml_value(MLMethodT, {
		name,
		definitions: [],
		signatures: {}
	}));
}
export function ml_method_define(method, types, variadic, func) {
	if (typeof(method) === 'string') {
		method = ml_method(method);
	} else if (ml_typeof(method) === MLTypeT) {
		let type = method;
		method = type.of;
		if (method === undefined) {
			method = type.of = ml_method(type.name + "::of");
		}
	}
	let count = types.length;
	method.definitions.push({count, types, variadic, func});
	method.signatures = {};
}

let appendMethod = ml_method("append");
let callMethod = ml_method("()");
let symbolMethod = ml_method("::");

export const MLBooleanT = ml_type("boolean");
Object.defineProperty(Boolean.prototype, "ml_type", {value: MLBooleanT});

export const MLNumberT = ml_type("number", [MLFunctionT], {
	ml_call: function(caller, self, args) {
		let index = self - 1;
		if (index < 0) index += args.length + 1;
		if (index < 0) {
			ml_resume(caller, null);
		} else if (index >= args.length) {
			ml_resume(caller, null);
		} else {
			ml_resume(caller, args[index]);
		}
	}
});
Object.defineProperty(Number.prototype, "ml_type", {value: MLNumberT});

const MLRangeIterT = ml_type("range-iter", [], {
	iter_next: function(caller, self) {
		self.value += 1;
		if (self.value > self.max) {
			ml_resume(caller, null);
		} else {
			self.key += 1;
			ml_resume(caller, self);
		}
	},
	iter_key: function(caller, self) {
		ml_resume(caller, self.key);
	},
	iter_value: function(caller, self) {
		ml_resume(caller, self.value);
	}
});
export const MLRangeT = ml_type("range", [MLIteratableT], {
	iterate: function(caller, self) {
		ml_resume(caller, ml_value(MLRangeIterT, {max: self.max, key: 1, value: self.min}));
	}
});

export const MLStringT = ml_type("string", [MLIteratableT]);
Object.defineProperty(String.prototype, "ml_type", {value: MLStringT});

export const MLRegexT = ml_type("regex", []);
Object.defineProperty(RegExp.prototype, "ml_type", {value: MLRegexT});

const MLJSFunctionT = ml_type("function", [MLFunctionT], {
	ml_call: function(caller, self, args) {
		for (let i = 0; i < args.length; ++i) args[i] = ml_deref(args[i]);
		self(caller, args);
	}
});
Object.defineProperty(Function.prototype, "ml_type", {value: MLJSFunctionT});

const MLJSObjectIterT = ml_type("object-iter", [], {
	iter_next: function(caller, self) {
		let keys = self.keys;
		keys.shift();
		if (keys.length) {
			ml_resume(caller, self);
		} else {
			ml_resume(caller, null);
		}
	},
	iter_key: function(caller, self) {
		ml_resume(caller, self.keys[0]);
	},
	iter_value: function(caller, self) {
		ml_resume(caller, self.object[self.keys[0]]);
	}
});
export const MLJSObjectT = ml_type("object", [MLIteratableT], {
	iterate: function(caller, self) {
		let keys = Object.keys(self);
		if (keys.length) {
			ml_resume(caller, ml_value(MLJSObjectIterT, {keys: keys, object: self}));
		} else {
			ml_resume(caller, null);
		}
	}
});
Object.defineProperty(Object.prototype, "ml_type", {value: MLJSObjectT});

const MLPartialFunctionT = ml_type("partial-function", [MLFunctionT], {
	ml_call: function(caller, self, args) {
		let count = args.length;
		let combinedCount = count + self.set;
		if (combinedCount < self.count) combinedCount = self.count;
		let combinedArgs = new Array(combinedCount);
		let i = 0, j = 0;
		for (; i < self.count; ++i) {
			let arg = self.args[i];
			if (arg !== undefined) {
				combinedArgs[i] = arg;
			} else {
				combinedArgs[i] = (j < count) ? args[j++] : null;
			}
		}
		for (; i < combinedCount; ++i) {
			combinedArgs[i] = (j < count) ? args[j++] : null;
		}
		ml_call(caller, self.func, combinedArgs);
	}
});
export function ml_partial_function(func, count) {
	return ml_value(MLPartialFunctionT, {func, count: 0, set: 0, args: new Array(count)});
}
export function ml_partial_function_set(partial, index, value) {
	partial.set += 1;
	if (partial.count < index + 1) partial.count = index + 1;
	partial.args[index] = value;
}

const soloMethod = ml_method("->");
const duoMethod = ml_method("=>");
const filterSoloMethod = ml_method("->?");
const filterDuoMethod = ml_method("=>?");

const MLChainedFunctionT = ml_type("chained-function", [MLFunctionT, MLIteratableT], {
	ml_call: function(caller, self, args) {},
	iterate: function(caller, self) {
		let state = ml_value(MLChainedStateT, {
			caller,
			run: ml_chained_iterator_next,
			entries: self.entries
		});
		ml_iterate(state, self.entries[0]);
	}
});
const MLChainedStateT = ml_type("chained-state", [], {
	iter_next: function(caller, self) {
		self.caller = caller;
		self.run = ml_chained_iterator_next;
		ml_iter_next(self, self.iter);
	},
	iter_key: function(caller, self) {
		ml_resume(caller, self.key);
	},
	iter_value: function(caller, self) {
		ml_resume(caller, self.value);
	}
});
function ml_chained_iterator_continue(self, value) {
	self.value = value;
	let func = self.entries[self.index++];
	if (func === undefined) return ml_resume(self.caller, self);
	if (func === soloMethod) {
		func = self.entries[self.index++];
		if (func === undefined) return ml_resume(self.caller, ml_error("StateError", "Missing value function for chain"));
		self.run = ml_chained_iterator_value;
		ml_call(self, func, [value]);
	} else if (func === duoMethod) {
		func = self.entries[self.index++];
		if (func === undefined) return ml_resume(self.caller, ml_error("StateError", "Missing value function for chain"));
		self.run = ml_chained_iterator_duo_key;
		ml_call(self, func, [self.key, value]);
	} else if (func === filterSoloMethod) {
		func = self.entries[self.index++];
		if (func === undefined) return ml_resume(self.caller, ml_error("StateError", "Missing value function for chain"));
		self.run = ml_chained_iterator_filter;
		ml_call(self, func, [value]);
	} else if (func === filterDuoMethod) {
		func = self.entries[self.index++];
		if (func === undefined) return ml_resume(self.caller, ml_error("StateError", "Missing value function for chain"));
		self.run = ml_chained_iterator_filter;
		ml_call(self, func, [self.key, value]);
	} else {
		self.run = ml_chained_iterator_value;
		ml_call(self, func, [value]);
	}
}
function ml_chained_iterator_next(self, value) {
	if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
	if (value == null) return ml_resume(self.caller, value);
	self.run = ml_chained_iterator_key;
	self.index = 1;
	self.iter = value;
	ml_iter_key(self, value);
}
function ml_chained_iterator_key(self, value) {
	if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
	self.key = value;
	self.run = ml_chained_iterator_value;
	ml_iter_value(self, self.iter);
}
function ml_chained_iterator_filter(self, value) {
	value = ml_deref(value);
	if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
	if (value == null) {
		self.run = ml_chained_iterator_next;
		ml_iter_next(self, self.iter);
	} else {
		ml_chained_iterator_continue(self, value);
	}
}
function ml_chained_iterator_duo_key(self, value) {
	value = ml_deref(value);
	if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
	let func = self.entries[self.index++];
	if (func === undefined) return ml_resume(self.caller, ml_error("StateError", "Missing value function for chain"));
	self.run = ml_chained_iterator_value;
	let args = [self.key, self.value];
	self.key = value;
	ml_call(self, func, args);
}
function ml_chained_iterator_value(self, value) {
	value = ml_deref(value);
	if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
	ml_chained_iterator_continue(self, value);
}
export function ml_chained(entries) {
	if (entries.length === 1) return entries[0];
	return ml_value(MLChainedFunctionT, {entries});
}

export const MLTupleT = ml_type("tuple", [], {
	ml_assign: function(self, values) {
		let count = self.values.length;
		for (let i = 0; i < count; ++i) {
			let value = ml_deref(ml_unpack(values, i + 1));
			let ref = self.values[i];
			let result = ml_assign(ref, value);
			if (ml_typeof(result) === MLErrorT) return result;
		}
		return values;
	},
	unpack: function(self, index) {
		if (index > self.values.length) return null;
		return self.values[index - 1];
	}
});
export function ml_tuple(size) {
	return ml_value(MLTupleT, {values: new Array(size)});
}
export function ml_tuple_set(tuple, index, value) {
	tuple.values[index - 1] = value;
}

const MLListNodeT = ml_type("list-node", [], {
	ml_deref: function(self) { return self.list[self.index]; },
	ml_assign: function(self, value) { return self.list[self.index] = value; },
	iter_next: function(caller, self) {
		let list = self.list;
		let index = self.index + 1;
		if (index >= list.length) {
			ml_resume(caller, null);
		} else {
			ml_resume(caller, ml_value(MLListNodeT, {list, index}));
		}
	},
	iter_key: function(caller, self) {
		ml_resume(caller, self.index + 1);
	},
	iter_value: function(caller, self) {
		ml_resume(caller, self);
	}
});
export const MLListT = ml_type("list", [MLIteratableT], {
	iterate: function(caller, self) {
		if (!self.length) return ml_resume(caller, null);
		ml_resume(caller, ml_value(MLListNodeT, {list: self, index: 0}));
	},
	unpack: function(self, index) {
		if (index > self.length) return null;
		return self[index - 1];
	}
});
Object.defineProperty(Array.prototype, "ml_type", {value: MLListT});
export function ml_list() {
	return [];
}
export function ml_list_push(list, value) {
	list.unshift(value);
}
export function ml_list_put(list, value) {
	list.push(value);
}
export function ml_list_pop(list) {
	return list.shift();
}
export function ml_list_pull(list) {
	return list.pop();
}

export const MLNamesT = ml_type("names", [MLListT, MLIteratableT], {
	iterate: MLListT.iterate
});
export function ml_names() {
	let names = [];
	Object.defineProperty(names, "ml_type", {value: MLNamesT});
	return names;
}

const MLMapNodeT = ml_type("map-node", [], {
	ml_deref: function(self) { return self.value; },
	ml_assign: function(self, value) { return self.value = value; },
	iter_next: function(caller, self) {
		ml_resume(caller, self.next || null);
	},
	iter_key: function(caller, self) {
		ml_resume(caller, self.key);
	},
	iter_value: function(caller, self) {
		ml_resume(caller, self);
	}
});
export const MLMapT = ml_type("map", [MLIteratableT], {
	iterate: function(caller, self) {
		ml_resume(caller, self.head || null);
	}
});
MLMapT.prototype.forEach = function(callback) {
	for (let node = this.head; node; node = node.next) {
		callback(node.key, node.value);
	}
}
export function ml_map() {
	return ml_value(MLMapT, {nodes: {}, size: 0, head: null, tail: null});
}
export function ml_map_insert(map, key, value) {
	let hash = ml_hash(key);
	let nodes = map.nodes[hash];
	if (!nodes) {
		let node = ml_value(MLMapNodeT, {key, value});
		if (map.tail) {
			map.tail.next = node;
		} else {
			map.head = node;
		}
		node.prev = map.tail;
		map.tail = node;
		nodes = map.nodes[hash] = [node];
	} else {
		for (let i = 0; i < nodes.length; ++i) {
			let node = nodes[i];
			if (node.key === key) { // TODO: replace with Minilang comparison
				let old = node.value;
				node.value = value;
				return old;
			}
		}
		nodes.push(ml_value(MLMapNodeT, {key, value}));
	}
	++map.size;
	return null;
}
export function ml_map_delete(map, key) {
	let hash = ml_hash(key);
	let nodes = self.nodes[hash];
	if (nodes) for (let i = 0; i < nodes.length; ++i) {
		let node = nodes[i];
		if (node.key === key) {
			nodes.splice(i, 1);
			if (node.prev) {
				node.prev.next = node.next;
			} else {
				map.head = node.next;
			}
			if (node.next) {
				node.next.prev = node.prev;
			} else {
				map.tail = node.prev;
			}
			return node.value;
		}
	}
	return null;
}
export function ml_map_search(map, key) {
	let hash = ml_hash(key);
	let nodes = map.nodes[hash];
	if (nodes) for (let i = 0; i < nodes.length; ++i) {
		let node = nodes[i];
		if (node.key === key) return node;
	}
	return null;
}
const MLMapIndexT = ml_type("map-index", [], {
	ml_deref: function(_) { return null; },
	ml_assign: function(self, value) {
		ml_map_insert(self.map, self.key, value);
		return value;
	}
});

const MLVariableT = ml_type("variable", [], {
	ml_deref: function(self) { return self.value; },
	ml_assign: function(self, value) { return self.value = value; }
});

const MLUninitializedT = ml_type("uninitialized");
function ml_uninitialized(name) {
	return ml_value(MLUninitializedT, {name, uses: []});
}
function ml_uninitialized_use(uninitialized, target, index) {
	uninitialized.uses.push([target, index]);
}
function ml_uninitialized_set(uninitialized, value) {
	let uses = uninitialized.uses;
	for (let i = 0; i < uses.length; ++i) {
		let use = uses[i];
		use[0][use[1]] = value;
	}
}

export const MLStringBufferT = ml_type("stringbuffer");
export function ml_stringbuffer() {
	return ml_value(MLStringBufferT, {string: ""});
}

const MLGlobalT = ml_type("global", [], {
	ml_call: function(caller, self, args) {
		ml_call(caller, self.value, args);
	}
});
function ml_global(value) {
	return ml_value(MLGlobalT, {value});
}

const MLFrameT = ml_type("frame", [MLFunctionT], {
	iter_next: function(caller, self) {
		if (!self.suspend) return ml_resume(caller, null);
		self.caller = caller;
		ml_resume(self, null);
	},
	iter_key: function(caller, self) {
		if (!self.suspend) return ml_resume(caller, ml_error("StateError", "Function did not suspend"));
		let stack = self.stack;
		ml_resume(caller, stack[stack.length - 2]);
	},
	iter_value: function(caller, self) {
		if (!self.suspend) return ml_resume(caller, ml_error("StateError", "Function did not suspend"));
		let stack = self.stack;
		ml_resume(caller, stack[stack.length - 1]);
	}
});

const ML_BYTECODE_VERSION = 2;

const MLI_AND = 0;
const MLI_ASSIGN = 1;
const MLI_ASSIGN_LOCAL = 2;
const MLI_CALL = 3;
const MLI_CALL_CONST = 4;
const MLI_CALL_CONST_0 = 5;
const MLI_CALL_CONST_1 = 6;
const MLI_CALL_CONST_2 = 7;
const MLI_CALL_CONST_3 = 8;
const MLI_CALL_CONST_4 = 9;
const MLI_CALL_CONST_5 = 10;
const MLI_CALL_CONST_6 = 11;
const MLI_CALL_CONST_7 = 12;
const MLI_CALL_CONST_8 = 13;
const MLI_CALL_CONST_9 = 14;
const MLI_CALL_METHOD = 15;
const MLI_CALL_METHOD_0 = 16;
const MLI_CALL_METHOD_1 = 17;
const MLI_CALL_METHOD_2 = 18;
const MLI_CALL_METHOD_3 = 19;
const MLI_CALL_METHOD_4 = 20;
const MLI_CALL_METHOD_5 = 21;
const MLI_CALL_METHOD_6 = 22;
const MLI_CALL_METHOD_7 = 23;
const MLI_CALL_METHOD_8 = 24;
const MLI_CALL_METHOD_9 = 25;
const MLI_CATCH = 26;
const MLI_CATCH_TYPE = 27;
const MLI_CLOSURE = 28;
const MLI_CLOSURE_TYPED = 29;
const MLI_ENTER = 30;
const MLI_EXIT = 31;
const MLI_FOR = 32;
const MLI_GOTO = 33;
const MLI_IF_DEBUG = 34;
const MLI_ITER = 35;
const MLI_KEY = 36;
const MLI_LET = 37;
const MLI_LETI = 38;
const MLI_LETX = 39;
const MLI_LINK = 40;
const MLI_LIST_APPEND = 41;
const MLI_LIST_NEW = 42;
const MLI_LOAD = 43;
const MLI_LOAD_PUSH = 44;
const MLI_LOAD_VAR = 45;
const MLI_LOCAL = 46;
const MLI_LOCALI = 47;
const MLI_LOCAL_PUSH = 48;
const MLI_MAP_INSERT = 49;
const MLI_MAP_NEW = 50;
const MLI_NEXT = 51;
const MLI_NIL = 52;
const MLI_NIL_PUSH = 53;
const MLI_NOT = 54;
const MLI_OR = 55;
const MLI_PARAM_TYPE = 56;
const MLI_PARTIAL_NEW = 57;
const MLI_PARTIAL_SET = 58;
const MLI_POP = 59;
const MLI_PUSH = 60;
const MLI_REF = 61;
const MLI_REFI = 62;
const MLI_REFX = 63;
const MLI_RESOLVE = 64;
const MLI_RESUME = 65;
const MLI_RETRY = 66;
const MLI_RETURN = 67;
const MLI_STRING_ADD = 68;
const MLI_STRING_ADDS = 69;
const MLI_STRING_ADD_1 = 70;
const MLI_STRING_END = 71;
const MLI_STRING_NEW = 72;
const MLI_STRING_POP = 73;
const MLI_SUSPEND = 74;
const MLI_SWITCH = 75;
const MLI_TAIL_CALL = 76;
const MLI_TAIL_CALL_CONST = 77;
const MLI_TAIL_CALL_CONST_0 = 78;
const MLI_TAIL_CALL_CONST_1 = 79;
const MLI_TAIL_CALL_CONST_2 = 80;
const MLI_TAIL_CALL_CONST_3 = 81;
const MLI_TAIL_CALL_CONST_4 = 82;
const MLI_TAIL_CALL_CONST_5 = 83;
const MLI_TAIL_CALL_CONST_6 = 84;
const MLI_TAIL_CALL_CONST_7 = 85;
const MLI_TAIL_CALL_CONST_8 = 86;
const MLI_TAIL_CALL_CONST_9 = 87;
const MLI_TAIL_CALL_METHOD = 88;
const MLI_TAIL_CALL_METHOD_0 = 89;
const MLI_TAIL_CALL_METHOD_1 = 90;
const MLI_TAIL_CALL_METHOD_2 = 91;
const MLI_TAIL_CALL_METHOD_3 = 92;
const MLI_TAIL_CALL_METHOD_4 = 93;
const MLI_TAIL_CALL_METHOD_5 = 94;
const MLI_TAIL_CALL_METHOD_6 = 95;
const MLI_TAIL_CALL_METHOD_7 = 96;
const MLI_TAIL_CALL_METHOD_8 = 97;
const MLI_TAIL_CALL_METHOD_9 = 98;
const MLI_TRY = 99;
const MLI_TUPLE_NEW = 100;
const MLI_UPVALUE = 101;
const MLI_VALUE_1 = 102;
const MLI_VALUE_2 = 103;
const MLI_VAR = 104;
const MLI_VARX = 105;
const MLI_VAR_TYPE = 106;
const MLI_WITH = 107;
const MLI_WITHX = 108;

export const MLClosureT = ml_type("closure", [MLFunctionT, MLIteratableT], {
	ml_call: function(caller, self, args) {
		let info = self.info;
		let stack = [];
		let frame = ml_value(MLFrameT, {
			caller,
			run: ml_frame_run,
			source: info[2],
			line: info[3],
			ip: info[10],
			ep: info[11],
			code: info[13],
			stack,
			upvalues: self.upvalues
		});
		let numParams = info[5];
		let extraArgs = info[7];
		let namedArgs = info[8];
		if (extraArgs) --numParams;
		if (namedArgs) --numParams;
		let count = args.length;
		let min = Math.min(count, numParams);
		let i;
		for (i = 0; i < min; ++i) {
			let arg = args[i];
			if (ml_typeof(arg) === MLNamesT) break;
			stack.push(ml_deref(arg));
		}
		for (let j = i; j < numParams; ++j) stack.push(null);
		if (extraArgs) {
			let rest = [];
			for (; i < count; ++i) {
				let arg = args[i];
				if (ml_typeof(arg) === MLNamesT) break;
				rest.push(ml_deref(arg));
			}
			stack.push(rest);
		}
		if (namedArgs) {
			let options = {};
			for (; i < count; ++i) {
				let arg = args[i];
				if (ml_typeof(arg) === MLNamesT) {
					let params = info[9];
					for (let j = 0; j < arg.length; ++j) {
						let name = arg[j];
						let index = params.indexOf(name);
						if (index >= 0) {
							stack[index] = ml_deref(args[++i]);
						} else {
							options[name] = ml_deref(args[++i]);
						}
					}
					break;
				}
			}
			stack.push(options);
		} else {
			for (; i < count; ++i) {
				let arg = args[i];
				if (ml_typeof(arg) === MLNamesT) {
					let params = info[9];
					for (let j = 0; j < arg.length; ++j) {
						let name = arg[j];
						let index = params.indexOf(name);
						if (index >= 0) {
							stack[index] = ml_deref(args[++i]);
						} else {
							return ml_resume(caller, ml_error("NameError", `Unknown named parameter ${name}`));
						}
					}
					break;
				}
			}
		}
		ml_resume(frame, null);
	},
	iterate: function(caller, self) {
		MLClosureT.ml_call(caller, self, []);
	}
});
function ml_frame_run(self, result) {
	let ip = self.ip;
	if (ml_typeof(result) === MLErrorT) {
		ml_error_trace_add(result, self.source, self.line);
		ip = self.ep;
	}
	let code = self.code;
	let stack = self.stack;
	for (;;) switch (code[ip]) {
	case MLI_RETURN:
		return ml_resume(self.caller, result);
	case MLI_SUSPEND:
		self.suspend = true;
		self.ip = ip + 2;
		self.line = code[ip + 1];
		return ml_resume(self.	caller, self);
	case MLI_RESUME:
		delete self.suspend;
		stack.pop();
		stack.pop();
		ip += 2;
		break;
	case MLI_NIL:
		result = null;
		ip += 2;
		break;
	case MLI_NIL_PUSH:
		result = null;
		stack.push(result = null);
		ip += 2;
		break;
	case MLI_AND:
		if (ml_deref(result) == null) {
			ip = code[ip + 2];
		} else {
			ip += 3;
		}
		break;
	case MLI_OR:
		if (ml_deref(result) !== null) {
			ip = code[ip + 2];
		} else {
			ip += 3;
		}
		break;
	case MLI_NOT:
		if (ml_deref(result) == null) {
			result = MLSome;
		} else {
			result = null;
		}
		ip += 2;
		break;
	case MLI_PUSH:
		stack.push(result);
		ip += 2;
		break;
	case MLI_WITH:
		stack.push(result);
		ip += 3;
		break;
	case MLI_LOAD_VAR: {
		result = code[ip + 2];
		stack[stack.length + code[ip + 3]].value = result;
		ip += 4;
		break;
	}
	case MLI_WITHX: {
		let packed = result;
		let count = code[ip + 2];
		for (let i = 0; i < count; ++i) {
			result = ml_unpack(packed, i + 1);
			stack.push(result);
		}
		ip += 4;
		break;
	}
	case MLI_POP:
		result = stack.pop();
		ip += 2;
		break;
	case MLI_ENTER:
		for (let i = code[ip + 2]; --i >= 0;) {
			let variable = ml_value(MLVariableT, {value: null});
			stack.push(variable);
		}
		for (let i = code[ip + 3]; --i >= 0;) {
			stack.push(undefined);
		}
		ip += 5;
		break;
	case MLI_EXIT:
		for (let i = code[ip + 2]; --i >= 0;) stack.pop();
		ip += 4;
		break;
	case MLI_GOTO:
		ip = code[ip + 2];
		break;
	case MLI_TRY:
		self.ep = code[ip + 2];
		ip += 3;
		break;
	case MLI_CATCH_TYPE:
		if (ml_typeof(result) !== MLErrorT) {
			result = ml_error("InternalError", `expected error, not ${ml_typeof(result).name}`);
			ml_error_trace_add(result, self.source, code[ip + 1]);
			ip = self.ep;
		} else {
			if (code[ip + 3].indexOf(ml_typeof(result)) === -1) {
				ip = code[ip + 2];
			} else {
				ip += 4;
			}
		}
		break;
	case MLI_CATCH:
		self.ep = code[ip + 2];
		if (ml_typeof(result) !== MLErrorT) {
			result = ml_error("InternalError", `expected error, not ${ml_typeof(result).name}`);
			ml_error_trace_add(result, self.source, code[ip + 1]);
			ip = self.ep;
		} else {
			result = ml_error_value(result);
			let top = code[ip + 3];
			while (stack.length > top) stack.pop();
			stack.push(result);
			ip += 5;
		}
		break;
	case MLI_RETRY:
		ip = self.ep;
		break;
	case MLI_LOAD:
		result = code[ip + 2];
		ip += 3;
		break;
	case MLI_LOAD_PUSH:
		stack.push(result = code[ip + 2]);
		ip += 3;
		break;
	case MLI_VAR:
		result = ml_deref(result);
		stack[stack.length + code[ip + 2]].value = result;
		ip += 3;
		break;
	case MLI_VAR_TYPE:
		ip += 3;
		break;
	case MLI_VARX:
		let packed = ml_deref(result);
		let index = stack.length + code[ip + 2];
		let count = code[ip + 3];
		for (let i = 0; i < count; ++i) {
			result = ml_unpack(packed, i + 1);
			result = ml_deref(result);
			stack[index + i].value = result;
		}
		ip += 4;
		break;
	case MLI_LET:
		result = ml_deref(result);
		stack[stack.length + code[ip + 2]] = result;
		ip += 3;
		break;
	case MLI_LETI: {
		result = ml_deref(result);
		let index = stack.length + code[ip + 2];
		let uninitialized = stack[index];
		if (uninitialized !== undefined) {
			ml_uninitialized_set(uninitialized, result);
		}
		stack[index] = result;
		ip += 3;
		break;
	}
	case MLI_LETX: {
		let packed = ml_deref(result);
		let index = stack.length + code[ip + 2];
		let count = code[ip + 3];
		for (let i = 0; i < count; ++i) {
			result = ml_unpack(packed, i + 1);
			result = ml_deref(result);
			let uninitialized = stack[index + i];
			stack[index + i] = result;
			if (uninitialized !== undefined) {
				ml_uninitialized_set(uninitialized, result);
			}
		}
		ip += 4;
		break;
	}
	case MLI_REF:
	case MLI_REFI:
	case MLI_REFX:
	case MLI_FOR:
		result = ml_deref(result);
		self.line = code[ip + 1];
		self.ip = ip + 2;
		return ml_iterate(self, result);
	case MLI_ITER:
		if (result == null) {
			ip = code[ip + 2];
		} else {
			stack.push(result);
			ip += 3;
		}
		break;
	case MLI_NEXT:
		result = stack.pop();
		self.line = code[ip + 1];
		self.ip = code[ip + 2];
		return ml_iter_next(self, result);
	case MLI_VALUE_1:
		result = stack[stack.length - 1];
		self.line = code[ip + 1];
		self.ip = ip + 2;
		return ml_iter_value(self, result);
	case MLI_KEY:
		result = stack[stack.length - 1];
		self.line = code[ip + 1];
		self.ip = ip + 2;
		return ml_iter_key(self, result);
	case MLI_CALL: {
		let count = code[ip + 2];
		let args = stack.splice(stack.length - count, count);
		let func = ml_deref(stack.pop());
		let next = ip + 3;
		self.ip = next;
		self.line = code[ip + 1];
		return ml_call(self, func, args);
	}
	case MLI_TAIL_CALL: {
		let count = code[ip + 2];
		let args = stack.splice(stack.length - count, count);
		let func = ml_deref(stack.pop());
		return ml_call(self.caller, func, args);
	}
	case MLI_ASSIGN:
		result = ml_deref(result);
		result = ml_assign(stack.pop(), result);
		if (ml_typeof(result) === MLErrorT) {
			ip = self.ep;
		} else {
			ip += 2;
		}
		break;
	case MLI_LOCAL:
		result = stack[stack.length + code[ip + 2]];
		ip += 3;
		break;
	case MLI_LOCAL_PUSH:
		stack.push(result = stack[stack.length + code[ip + 2]]);
		ip += 3;
		break;
	case MLI_LOCALI: {
		let index = stack.length + code[ip + 2];
		result = stack[index];
		if (result === undefined) {
			result = stack[index] = ml_uninitialized(code[ip + 3]);
		}
		ip += 4;
		break;
	}
	case MLI_UPVALUE:
		result = self.upvalues[code[ip + 2]];
		ip += 3;
		break;
	case MLI_TUPLE_NEW: {
		let count = code[ip + 2];
		result = ml_value(MLTupleT, {values: stack.splice(stack.length - count, count)});
		ip += 3;
		break;
	}
	case MLI_VALUE_2:
		result = stack[stack.length - 2];
		self.line = code[ip + 1];
		self.ip = ip + 2;
		return ml_iter_value(self, result);
	case MLI_LIST_NEW:
		stack.push([]);
		ip += 2;
		break;
	case MLI_LIST_APPEND:
		stack[stack.length - 1].push(ml_deref(result));
		ip += 2;
		break;
	case MLI_MAP_NEW:
		stack.push(ml_map());
		ip += 2;
		break;
	case MLI_MAP_INSERT: {
		let key = stack.pop();
		ml_map_insert(stack[stack.length - 1], key, ml_deref(result));
		ip += 2;
		break;
	}
	case MLI_CLOSURE:
	case MLI_CLOSURE_TYPED: {
		let info = code[ip + 2];
		let upvalues = [];
		for (let i = 0; i < info[6]; ++i) {
			let index = code[ip + 3 + i];
			let value;
			if (index < 0) {
				value = self.upvalues[~index];
				if (value === undefined) {
					value = self.upvalues[~index] = ml_uninitialized("<upvalue>");
				}
			} else {
				value = stack[index];
				if (value === undefined) {
					value = stack[index] = ml_uninitialized("<upvalue>");
				}
			}
			if (ml_typeof(value) === MLUninitializedT) ml_uninitialized_use(value, upvalues, i);
			upvalues[i] = value;
		}
		result = ml_closure(info, upvalues);
		ip += 3 + upvalues.length;
		break;
	}
	case MLI_PARAM_TYPE:
		ip += 4;
		break;
	case MLI_PARTIAL_NEW:
		result = ml_deref(result);
		stack.push(ml_partial_function(result, code[ip + 2]));
		ip += 3;
		break;
	case MLI_PARTIAL_SET:
		result = ml_deref(result);
		ml_partial_function_set(stack[stack.length - 1], code[ip + 2], result);
		ip += 3;
		break;
	case MLI_STRING_NEW:
		stack.push(ml_stringbuffer());
		ip += 2;
		break;
	case MLI_STRING_ADD: {
		let count = code[ip + 2] + 1;
		let args = stack.splice(stack.length - count, count);
		stack.push(args[0]);
		self.line = code[ip + 1];
		self.ip = ip + 3;
		return ml_call(self, appendMethod, args);
	}
	case MLI_STRING_ADD_1: {
		let args = stack.splice(stack.length - 2, 2);
		stack.push(args[0]);
		self.line = code[ip + 1];
		self.ip = ip + 2;
		return ml_call(self, appendMethod, args);
	}
	case MLI_STRING_ADDS:
		stack[stack.length - 1].string += code[ip + 2];
		ip += 3;
		break;
	case MLI_STRING_POP:
		result = stack.pop().string;
		ip += 2;
		break;
	case MLI_STRING_END:
		result = stack.pop().string;
		stack.push(result);
		ip += 2;
		break;
	case MLI_RESOLVE:
		self.line = code[ip + 1];
		self.ip = ip + 3;
		return ml_call(self, symbolMethod, [result, code[ip + 2]]);
	case MLI_IF_DEBUG:
		ip += 3;
		break;
	case MLI_ASSIGN_LOCAL:
		result = ml_deref(result);
		result = ml_assign(stack[stack.length + code[ip + 2]], result);
		if (ml_typeof(result) === MLErrorT) {
			ip = self.ep;
		} else {
			ip += 3;
		}
		break;
	case MLI_SWITCH: {
		if (typeof(result) !== "number") {
			result = ml_error("TypeError", `expected integer, not ${ml_typeof(result).name}`);
			ml_error_trace_add(result, self.source, code[ip + 1]);
			ip = self.ep;
		} else {
			let count = code[ip + 2];
			if (result < 0 || result >= count) result = count - 1;
			ip = code[ip + 3][result];
		}
		break;
	}
	case MLI_CALL_CONST:
	case MLI_CALL_METHOD: {
		let count = code[ip + 3];
		let args = stack.splice(stack.length - count, count);
		let func = code[ip + 2];
		let next = ip + 4;
		self.ip = next;
		self.line = code[ip + 1];
		return ml_call(self, func, args);
	}
	case MLI_CALL_CONST_0:
	case MLI_CALL_CONST_1:
	case MLI_CALL_CONST_2:
	case MLI_CALL_CONST_3:
	case MLI_CALL_CONST_4:
	case MLI_CALL_CONST_5:
	case MLI_CALL_CONST_6:
	case MLI_CALL_CONST_7:
	case MLI_CALL_CONST_8:
	case MLI_CALL_CONST_9: {
		let count = code[ip] - MLI_CALL_CONST_0;
		let args = stack.splice(stack.length - count, count);
		let func = code[ip + 2];
		let next = ip + 3;
		self.ip = next;
		self.line = code[ip + 1];
		return ml_call(self, func, args);
	}
	case MLI_CALL_METHOD_0:
	case MLI_CALL_METHOD_1:
	case MLI_CALL_METHOD_2:
	case MLI_CALL_METHOD_3:
	case MLI_CALL_METHOD_4:
	case MLI_CALL_METHOD_5:
	case MLI_CALL_METHOD_6:
	case MLI_CALL_METHOD_7:
	case MLI_CALL_METHOD_8:
	case MLI_CALL_METHOD_9: {
		let count = code[ip] - MLI_CALL_METHOD_0;
		let args = stack.splice(stack.length - count, count);
		let func = code[ip + 2];
		let next = ip + 3;
		self.ip = next;
		self.line = code[ip + 1];
		return ml_call(self, func, args);
	}
	case MLI_TAIL_CALL_CONST:
	case MLI_TAIL_CALL_METHOD: {
		let count = code[ip + 3];
		let args = stack.splice(stack.length - count, count);
		let func = code[ip + 2];
		return ml_call(self.caller, func, args);
	}
	case MLI_TAIL_CALL_CONST_0:
	case MLI_TAIL_CALL_CONST_1:
	case MLI_TAIL_CALL_CONST_2:
	case MLI_TAIL_CALL_CONST_3:
	case MLI_TAIL_CALL_CONST_4:
	case MLI_TAIL_CALL_CONST_5:
	case MLI_TAIL_CALL_CONST_6:
	case MLI_TAIL_CALL_CONST_7:
	case MLI_TAIL_CALL_CONST_8:
	case MLI_TAIL_CALL_CONST_9: {
		let count = code[ip] - MLI_TAIL_CALL_CONST_0;
		let args = stack.splice(stack.length - count, count);
		let func = code[ip + 2];
		return ml_call(self.caller, func, args);
	}
	case MLI_TAIL_CALL_METHOD_0:
	case MLI_TAIL_CALL_METHOD_1:
	case MLI_TAIL_CALL_METHOD_2:
	case MLI_TAIL_CALL_METHOD_3:
	case MLI_TAIL_CALL_METHOD_4:
	case MLI_TAIL_CALL_METHOD_5:
	case MLI_TAIL_CALL_METHOD_6:
	case MLI_TAIL_CALL_METHOD_7:
	case MLI_TAIL_CALL_METHOD_8:
	case MLI_TAIL_CALL_METHOD_9: {
		let count = code[ip] - MLI_TAIL_CALL_METHOD_0;
		let args = stack.splice(stack.length - count, count);
		let func = code[ip + 2];
		return ml_call(self.caller, func, args);
	}
	}
}
export function ml_closure(info, upvalues) {
	return ml_value(MLClosureT, {info, upvalues});
}

export const MLModuleT = ml_type("module");
export function ml_module(name, exports) {
	exports = exports || {};
	return ml_value(MLModuleT, {name, exports});
}

export const MLArrayT = ml_type("array");
MLArrayT.exports.int8 = ml_type("array::int8", [MLArrayT], {base: Int8Array});
MLArrayT.exports.uint8 = ml_type("array::uint8", [MLArrayT], {base: Uint8Array});
MLArrayT.exports.int16 = ml_type("array::int16", [MLArrayT], {base: Int16Array});
MLArrayT.exports.uint16 = ml_type("array::uint16", [MLArrayT], {base: Uint16Array});
MLArrayT.exports.int32 = ml_type("array::int32", [MLArrayT], {base: Int32Array});
MLArrayT.exports.uint32 = ml_type("array::uint32", [MLArrayT], {base: Uint32Array});
MLArrayT.exports.int64 = ml_type("array::int64", [MLArrayT], {base: BigInt64Array});
MLArrayT.exports.uint64 = ml_type("array::uint64", [MLArrayT], {base: BigUint64Array});
MLArrayT.exports.float32 = ml_type("array::float32", [MLArrayT], {base: Float32Array});
MLArrayT.exports.float64 = ml_type("array::float64", [MLArrayT], {base: Float64Array});

function ml_array_of_shape(type, source, degree) {
	if (ml_is(source, MLListT)) {
		let size = source.length;
		if (!size) return ml_error("ValueError", "Empty dimension in array");
		let shape = ml_array_of_shape(type, source[0], degree + 1);
		if (ml_typeof(shape) === MLErrorT) return shape;
		shape[degree] = size;
		return shape;
	} else if (ml_is(source, MLTupleT)) {
		let size = source.values.length;
		if (!size) return ml_error("ValueError", "Empty dimension in array");
		let shape = ml_array_of_shape(type, source.values[0], degree + 1);
		if (ml_typeof(shape) === MLErrorT) return shape;
		shape[degree] = size;
		return shape;
	} else if (ml_is(source, MLArrayT)) {
		return new Array(degree).concat(source.shape);
	} else {
		return new Array(degree).concat([1]);
	}
}

export function ml_array(typename, shape) {
	let type = MLArrayT.exports[typename];
	if (!type) return ml_error("ArrayError", `Unknown array type: ${typename}`);
	let size = type.base.BYTES_PER_ELEMENT;
	let strides = new Array(shape.length);
	for (let i = shape.length; --i >= 0;) {
		strides[i] = size;
		size *= shape[i];
	}
	let bytes = new ArrayBuffer(size);
	let view = new DataView(bytes);
	return ml_value(type, {shape, strides, bytes, view});
}

Globals.print = function(caller, args) {
	if (args.length === 0) return ml_resume(caller, null);
	let buffer = ml_stringbuffer();
	let state = {caller, index: 1, run: function(self, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
		if (self.index === args.length) {
			console.log(value.string);
			return ml_resume(self.caller, null);
		}
		ml_call(self, appendMethod, [value, args[self.index++]]);
	}};
	ml_call(state, appendMethod, [buffer, args[0]]);
}

Globals.count = function(caller, args) {
	let state = {caller, count: 0, run: function(self, value) {
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(self.caller, value);
		} else if (value == null) {
			ml_resume(self.caller, self.count);
		} else {
			self.count++;
			ml_iter_next(self, value);
		}
	}};
	ml_iterate(state, args[0]);
}

Globals.first = function(caller, args) {
	let state = {caller, run: function(self, value) {
		self.run = function(self, value) {
			ml_resume(self.caller, value);
		}
		ml_iter_value(self, value);
	}};
	ml_iterate(state, args[0]);
}

Globals.first2 = function(caller, args) {
	let state = {caller, run: function(self, value) {
		if (ml_typeof(value) === MLErrorT) {
			return ml_resume(self.caller, value);
		} else if (value == null) {
			return ml_resume(self.caller, value);
		}
		self.iter = value;
		self.run = function(self, value) {
			self.key = value;
			self.run = function(self, value) {
				ml_resume(self.caller, ml_value(MLTupleT, [self.key, value]));
			}
			ml_iter_value(self, self.iter);
		}
		ml_iter_key(self, self.iter);
	}};
	ml_iterate(state, args[0]);
}

ml_method_define("append", [MLStringBufferT, MLTypeT], false, function(caller, args) {
	args[0].string += "<" + args[1].name + ">";
	ml_resume(caller, args[0]);
});
ml_method_define("append", [MLStringBufferT, MLNilT], false, function(caller, args) {
	args[0].string += "nil";
	ml_resume(caller, args[0]);
});
ml_method_define("append", [MLStringBufferT, MLSomeT], false, function(caller, args) {
	args[0].string += "some";
	ml_resume(caller, args[0]);
});

ml_method_define("=", [MLAnyT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, args[0] === args[1] ? args[1] : null);
});
ml_method_define("!=", [MLAnyT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, args[0] !== args[1] ? args[1] : null);
});

ml_method_define("->", [MLFunctionT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], args[1]]));
});
ml_method_define("->", [MLIteratableT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], args[1]]));
});
ml_method_define("=>", [MLIteratableT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], duoMethod, 1, args[1]]));
});
ml_method_define("=>", [MLIteratableT, MLFunctionT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], duoMethod, args[1], args[2]]));
});
ml_method_define("->", [MLChainedFunctionT, MLFunctionT], false, function(caller, args) {
	let entries = args[0].entries.slice();
	entries.push(args[1]);
	ml_resume(caller, ml_chained(entries));
});
ml_method_define("=>", [MLChainedFunctionT, MLFunctionT], false, function(caller, args) {
	let entries = args[0].entries.slice();
	entries.push(duoMethod);
	entries.push(1);
	entries.push(args[1]);
	ml_resume(caller, ml_chained(entries));
});
ml_method_define("=>", [MLChainedFunctionT, MLFunctionT, MLFunctionT], false, function(caller, args) {
	let entries = args[0].entries.slice();
	entries.push(duoMethod);
	entries.push(args[1]);
	entries.push(args[2]);
	ml_resume(caller, ml_chained(entries));
});
ml_method_define("->?", [MLIteratableT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], filterSoloMethod, args[1]]));
});
ml_method_define("=>?", [MLIteratableT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], filterDuoMethod, args[1]]));
});
ml_method_define("->?", [MLChainedFunctionT, MLFunctionT], false, function(caller, args) {
	let entries = args[0].entries.slice();
	entries.push(filterSoloMethod);
	entries.push(args[1]);
	ml_resume(caller, ml_chained(entries));
});
ml_method_define("=>?", [MLChainedFunctionT, MLFunctionT], false, function(caller, args) {
	let entries = args[0].entries.slice();
	entries.push(filterDuoMethod);
	entries.push(args[1]);
	ml_resume(caller, ml_chained(entries));
});

ml_method_define(MLBooleanT, [MLBooleanT], false, ml_identity);
ml_method_define("-", [MLBooleanT], false, function(caller, args) {
	ml_resume(caller, !args[0]);
});
ml_method_define("/\\", [MLBooleanT, MLBooleanT], false, function(caller, args) {
	ml_resume(caller, args[0] && args[1]);
});
ml_method_define("\\/", [MLBooleanT, MLBooleanT], false, function(caller, args) {
	ml_resume(caller, args[0] || args[1]);
});
ml_method_define("append", [MLStringBufferT, MLBooleanT], false, function(caller, args) {
	args[0].string += args[1].toString();
	ml_resume(caller, args[0]);
});

ml_method_define(MLNumberT, [MLNumberT], false, ml_identity);
ml_method_define(MLNumberT, [MLStringT], false, function(caller, args) {
	ml_resume(caller, parseFloat(args[0]));
});

ml_method_define("+", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] + args[1]);
});
ml_method_define("-", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] - args[1]);
});
ml_method_define("*", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] * args[1]);
});
ml_method_define("/", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] / args[1]);
});

ml_method_define("<", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] < args[1] ? args[1] : null);
});
ml_method_define(">", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] > args[1] ? args[1] : null);
});
ml_method_define("<=", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] <= args[1] ? args[1] : null);
});
ml_method_define(">=", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] >= args[1] ? args[1] : null);
});
ml_method_define("..", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, ml_value(MLRangeT, {min: args[0], max: args[1]}));
});

ml_method_define("append", [MLStringBufferT, MLNumberT], false, function(caller, args) {
	args[0].string += args[1].toString();
	ml_resume(caller, args[0]);
});
ml_method_define("append", [MLStringBufferT, MLNumberT, MLNumberT], false, function(caller, args) {
	let base = args[2];
	if (base < 2 || base > 36 || base !== Math.floor(base)) {
		return ml_resume(caller, ml_error("RangeError", "Invalid base"));
	}
	let value = args[1];
	if (value !== Math.floor(value)) {
		return ml_resume(caller, ml_error("UnsupportedError", "Base conversions of reals not supported yet"));
	}
	let string = "";
	if (value < 0) {
		args[0].string += "-";
		value = -value;
	}
	do {
		string = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[value % base] + string;
		value = Math.floor(value / base);
	} while (value);
	args[0].string += string;
	ml_resume(caller, args[0]);
});

ml_method_define(MLStringT, [MLStringT], false, ml_identity);
ml_method_define(MLStringT, [MLAnyT], false, function(caller, args) {
	let buffer = ml_stringbuffer();
	let state = {caller, run: function(self, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
		ml_resume(self.caller, value.string);
	}};
	ml_call(state, appendMethod, [buffer, args[0]]);
});
ml_method_define(MLStringT, [MLNilT], false, function(caller, _) {
	ml_resume(caller, "nil");
});
ml_method_define(MLStringT, [MLSomeT], false, function(caller, _) {
	ml_resume(caller, "some");
});
ml_method_define(MLStringT, [MLBooleanT], false, function(caller, args) {
	ml_resume(caller, args[0] ? "true" : "false");
});
ml_method_define(MLStringT, [MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0].toString());
});
ml_method_define(MLStringT, [MLNumberT, MLNumberT], false, function(caller, args) {
	let base = args[1];
	if (base < 2 || base > 36 || base !== Math.floor(base)) {
		return ml_resume(caller, ml_error("RangeError", "Invalid base"));
	}
	let value = args[0];
	if (value !== Math.floor(value)) {
		return ml_resume(caller, ml_error("UnsupportedError", "Base conversions of reals not supported yet"));
	}
	let string = "";
	let prefix = "";
	if (value < 0) {
		prefix = "-";
		value = -value;
	}
	do {
		string = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[value % base] + string;
		value = Math.floor(value / base);
	} while (value);
	ml_resume(caller, prefix + string);
});

ml_method_define("+", [MLStringT, MLStringT], false, function(caller, args) {
	ml_resume(caller, args[0] + args[1]);
});
ml_method_define("[]", [MLStringT, MLNumberT], false, function(caller, args) {
	let string = args[0];
	let index = Math.floor(args[1]) - 1;
	if (index < 0) index += string.length + 1;
	if (index < 0 || index >= string.length) {
		ml_resume(caller, null);
	} else {
		ml_resume(caller, string[index]);
	}
});
ml_method_define("[]", [MLStringT, MLNumberT, MLNumberT], false, function(caller, args) {
	let string = args[0];
	let start = Math.floor(args[1]) - 1;
	if (start < 0) start += string.length + 1;
	let end = Math.floor(args[2]) - 1;
	if (end < 0) end += string.length + 1;
	if (start < 0) {
		ml_resume(caller, null);
	} else if (end > string.length) {
		ml_resume(caller, null);
	} else if (end < start) {
		ml_resume(caller, null);
	} else {
		ml_resume(caller, string.substring(start, end));
	}
});
ml_method_define("trim", [MLStringT], false, function(caller, args) {
	ml_resume(caller, args[0].trim());
});
ml_method_define("length", [MLStringT], false, function(caller, args) {
	ml_resume(caller, args[0].length);
});
ml_method_define("count", [MLStringT], false, function(caller, args) {
	ml_resume(caller, args[0].length);
});
ml_method_define("upper", [MLStringT], false, function(caller, args) {
	ml_resume(caller, args[0].toUpperCase());
});
ml_method_define("lower", [MLStringT], false, function(caller, args) {
	ml_resume(caller, args[0].toLowerCase());
});
ml_method_define("find", [MLStringT, MLStringT], false, function(caller, args) {
	let index = args[0].indexOf(args[1]);
	ml_resume(caller, index < 0 ? null : index + 1);
});
ml_method_define("/", [MLStringT, MLStringT], false, function(caller, args) {
	ml_resume(caller, args[0].split(args[1]));
});
ml_method_define("/", [MLStringT, MLRegexT], false, function(caller, args) {
	ml_resume(caller, args[0].split(args[1]));
});
ml_method_define("%", [MLStringT, MLRegexT], false, function(caller, args) {
	let matches = args[0].match(args[1]);
	if (matches !== null) {
		ml_resume(caller, Array.prototype.slice.apply(matches));
	} else {
		ml_resume(caller, null);
	}
});
ml_method_define("/*", [MLStringT, MLStringT], false, function(caller, args) {
	let subject = args[0];
	let pattern = args[1];
	let index = subject.indexOf(pattern);
	if (index === -1) {
		ml_resume(caller, [subject, ""]);
	} else {
		ml_resume(caller, [subject.substring(0, index), subject.substring(index + pattern.length)]);
	}
});
ml_method_define("/*", [MLStringT, MLRegexT], false, function(caller, args) {
	let subject = args[0];
	let regex = args[1];
	let match = regex.exec(subject);
	if (match) {
		return ml_resume(caller, [subject.substring(0, match.index), subject.substring(match.index + match[0].length)]);
	}
	ml_resume(caller, [subject, ""]);
});
ml_method_define("*/", [MLStringT, MLStringT], false, function(caller, args) {
	let subject = args[0];
	let pattern = args[1];
	let index = subject.lastIndexOf(pattern);
	if (index === -1) {
		ml_resume(caller, [subject, ""]);
	} else {
		ml_resume(caller, [subject.substring(0, index), subject.substring(index + pattern.length)]);
	}
});
ml_method_define("*/", [MLStringT, MLRegexT], false, function(caller, args) {
	let subject = args[0];
	let regex = args[1];
	for (let i = subject.length; --i >= 0;) {
		let match = regex.exec(subject.substring(i))
		if (match) {
			return ml_resume(caller, [subject.substring(0, i), subject.substring(i + match[0].length)]);
		}
	}
	ml_resume(caller, [subject, ""]);
});
ml_method_define("after", [MLStringT, MLStringT], false, function(caller, args) {
	let haystack = args[0];
	let needle = args[1];
	let index = haystack.indexOf(needle);
	if (index >= 0) {
		return ml_resume(caller, haystack.substring(index + needle.length));
	} else {
		return ml_resume(caller, null);
	}
});
ml_method_define("before", [MLStringT, MLStringT], false, function(caller, args) {
	let haystack = args[0];
	let needle = args[1];
	let index = haystack.indexOf(needle);
	if (index >= 0) {
		return ml_resume(caller, haystack.substring(0, index));
	} else {
		return ml_resume(caller, null);
	}
});
ml_method_define("after", [MLStringT, MLStringT, MLNumberT], false, function(caller, args) {
	let haystack = args[0];
	let needle = args[1];
	let count = args[2];
	if (count > 0) {
		let index = 0;
		while (true) {
			index = haystack.indexOf(needle, index);
			if (index == -1) return ml_resume(caller, null);
			index += needle.length;
			if (--count <= 0) {
				return ml_resume(caller, haystack.substring(index));
			}
		}
	} else if (count < 0) {
		for (let i = haystack.length - needle.length; i >= 0; --i) {
			if (haystack.substring(i, i + needle.length) == needle) {
				if (++count < 0) {
					i -= needle.length;
				} else {
					return ml_resume(caller, haystack.substring(i + needle.length));
				}
			}
		}
		return ml_resume(caller, null);
	} else {
		return ml_resume(caller, haystack);
	}
});
ml_method_define("before", [MLStringT, MLStringT, MLNumberT], false, function(caller, args) {
	let haystack = args[0];
	let needle = args[1];
	let count = args[2];
	if (count > 0) {
		let index = 0;
		while (true) {
			index = haystack.indexOf(needle, index);
			if (index == -1) return ml_resume(caller, null);
			if (--count > 0) {
				index += needle.length;
			} else {
				return ml_resume(caller, haystack.substring(0, index));
			}
		}
	} else if (count < 0) {
		for (let i = haystack.length - needle.length; i >= 0; --i) {
			if (haystack.substring(i, i + needle.length) == needle) {
				if (++count < 0) {
					i -= needle.length;
				} else {
					return ml_resume(caller, haystack.substring(0, i));
				}
			}
		}
		return ml_resume(caller, null);
	} else {
		return ml_resume(caller, haystack);
	}
});
ml_method_define("starts", [MLStringT, MLStringT], false, function(caller, args) {
	if (args[0].startsWith(args[1])) {
		return ml_resume(caller, args[1])
	} else {
		return ml_resume(caller, null);
	}
});
ml_method_define("ends", [MLStringT, MLStringT], false, function(caller, args) {
	if (args[0].endsWith(args[1])) {
		return ml_resume(caller, args[1])
	} else {
		return ml_resume(caller, null);
	}
});
ml_method_define("append", [MLStringBufferT, MLStringT], false, function(caller, args) {
	args[0].string += args[1];
	ml_resume(caller, args[0]);
});

ml_method_define("append", [MLStringBufferT, MLTupleT], false, function(caller, args) {
	let buffer = args[0];
	let list = args[1].values;
	if (!list.length) {
		buffer.string += "()";
		return ml_resume(caller, args[0]);
	}
	let state = {caller, list, index: 1, run: function(self, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
		let list = self.list;
		if (self.index == list.length) {
			value.string += ")";
			ml_resume(self.caller, value);
		} else {
			value.string += ", ";
			ml_call(state, appendMethod, [value, list[self.index++]]);
		}
	}};
	buffer.string += "(";
	ml_call(state, appendMethod, [buffer, list[0]]);
});

ml_method_define(MLListT, [MLIteratableT], true, function(caller, args) {
	let list = [];
	let state = {caller, list, run: iter_next};
	ml_iterate(state, ml_chained(args));
	function iter_next(self, value) {
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(self.caller, value);
		} else if (value == null) {
			ml_resume(self.caller, self.list);
		} else {
			self.iter = value;
			self.run = iter_value;
			ml_iter_value(self, value);
		}
	}
	function iter_value(self, value) {
		value = ml_deref(value);
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(self.caller, value);
		} else {
			self.list.push(value);
			self.run = iter_next;
			ml_iter_next(self, self.iter);
		}
	}
});
ml_method_define("[]", [MLListT, MLNumberT], false, function(caller, args) {
	let list = args[0];
	let index = args[1] - 1;
	if (index < 0) index += list.length + 1;
	if (index < 0 || index >= list.length) return null;
	ml_resume(caller, ml_value(MLListNodeT, {list, index}));
});
ml_method_define("push", [MLListT, MLAnyT], true, function(caller, args) {
	let list = args[0];
	for (let i = 1; i < args.length; ++i) list.unshift(args[i]);
	ml_resume(caller, list);
});
ml_method_define("put", [MLListT, MLAnyT], true, function(caller, args) {
	let list = args[0];
	for (let i = 1; i < args.length; ++i) list.push(args[i]);
	ml_resume(caller, list);
});
ml_method_define("pop", [MLListT], false, function(caller, args) {
	let list = args[0];
	ml_resume(caller, list.length ? list.shift() : null);
});
ml_method_define("pull", [MLListT], false, function(caller, args) {
	let list = args[0];
	ml_resume(caller, list.length ? list.pop() : null);
});
ml_method_define("length", [MLListT], false, function(caller, args) {
	ml_resume(caller, args[0].length);
});
ml_method_define("count", [MLListT], false, function(caller, args) {
	ml_resume(caller, args[0].length);
});
ml_method_define("append", [MLStringBufferT, MLListT], false, function(caller, args) {
	let buffer = args[0];
	let list = args[1];
	if (!list.length) {
		buffer.string += "[]";
		return ml_resume(caller, args[0]);
	}
	let state = {caller, list, index: 1, run: function(self, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
		let list = self.list;
		if (self.index == list.length) {
			value.string += "]";
			ml_resume(self.caller, value);
		} else {
			value.string += ", ";
			ml_call(state, appendMethod, [value, list[self.index++]]);
		}
	}};
	buffer.string += "[";
	ml_call(state, appendMethod, [buffer, list[0]]);
});

ml_method_define(MLMapT, [MLIteratableT], true, function(caller, args) {
	let map = ml_map();
	let state = {caller, map, run: iter_next};
	ml_iterate(state, ml_chained(args));
	function iter_next(self, value) {
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(self.caller, value);
		} else if (value == null) {
			ml_resume(self.caller, self.map);
		} else {
			self.iter = value;
			self.run = iter_key;
			ml_iter_key(self, value);
		}
	}
	function iter_key(self, value) {
		value = ml_deref(value);
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(self.caller, value);
		} else {
			self.key = value;
			self.run = iter_value;
			ml_iter_value(self, self.iter);
		}
	}
	function iter_value(self, value) {
		value = ml_deref(value);
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(self.caller, value);
		} else {
			ml_map_insert(self.map, self.key, value);
			self.run = iter_next;
			ml_iter_next(self, self.iter);
		}
	}
});
ml_method_define("[]", [MLMapT, MLAnyT], false, function(caller, args) {
	let map = args[0];
	let key = args[1];
	let node = ml_map_search(map, key);
	if (node) return ml_resume(caller, node);
	ml_resume(caller, ml_value(MLMapIndexT, {map, key}));
});
ml_method_define("insert", [MLMapT, MLAnyT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, ml_map_insert(args[0], args[1], args[2]));
});
ml_method_define("delete", [MLMapT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, ml_map_delete(args[0], args[1]));
});
ml_method_define("append", [MLStringBufferT, MLMapT], false, function(caller, args) {
	let buffer = args[0];
	let node = args[1].head;
	if (!node) {
		buffer.string += "{}";
		return ml_resume(caller, args[0]);
	}
	let state = {caller, node, key: true, run: function(self, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
		if (self.key) {
			value.string += " is ";
			self.key = false;
			ml_call(state, appendMethod, [value, self.node.value]);
		} else {
			let node = self.node.next;
			if (!node) {
				value.string += "}";
				return ml_resume(self.caller, value);
			}
			self.key = true;
			self.node = node;
			value.string += ", ";
			ml_call(state, appendMethod, [value, node.key]);
		}
	}};
	buffer.string += "{";
	ml_call(state, appendMethod, [buffer, node.key]);
});


ml_method_define("append", [MLStringBufferT, MLJSObjectT], false, function(caller, args) {
	let buffer = args[0];
	let keys = Object.keys(args[1]);
	let key = keys.shift();
	if (!key) {
		buffer.string += "{}";
		return ml_resume(caller, args[0]);
	}
	let state = {caller, keys, object: args[1], run: function(self, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(self.caller, value);
		let key = self.keys.shift();
		if (!key) {
			value.string += "}";
			return ml_resume(self.caller, value);
		}
		value.string += ", " + key + ": ";
		ml_call(state, appendMethod, [value, self.object[key]]);
	}};
	buffer.string += "{" + key + ": ";
	ml_call(state, appendMethod, [buffer, args[1][key]]);
});

ml_method_define("::", [MLModuleT, MLStringT], false, function(caller, args) {
	let value = args[0].exports[args[1]];
	if (value === undefined) {
		ml_resume(caller, ml_error("NameError", `${args[1]} not exported from ${args[0].name}`));
	} else {
		ml_resume(caller, value);
	}
});

function array_append(type, buffer, degree, shape, strides, bytes) {
	if (degree == 0) {
		new type(buffer)
	}
}

ml_method_define("append", [MLStringBufferT, MLArrayT], false, function(caller, args) {
	let shape = args[1].shape;
	args[0].string += ml_typeof(args[1]).name + "[" + shape.join("x") + "]";
	ml_resume(caller, args[0]);
});

ml_method_define("type", [MLErrorValueT], false, function(caller, args) {
	ml_resume(caller, args[0].type);
});
ml_method_define("message", [MLErrorValueT], false, function(caller, args) {
	ml_resume(caller, args[0].message);
});

ml_method_define(MLJSObjectT, [], false, function(caller, args) {
	ml_resume(caller, {});
});
ml_method_define(MLJSObjectT, [MLNamesT], true, function(caller, args) {
	let object = {};
	let names = args[0];
	for (let i = 0; i < names.length; ++i) {
		object[names[i]] = ml_deref(args[i + 1]);
	}
	ml_resume(caller, object);
});
ml_method_define("[]", [MLJSObjectT, MLStringT], false, function(caller, args) {
	let object = args[0];
	let key = args[1];
	if (object.hasOwnProperty(key)) {
		ml_resume(caller, object[key]);
	} else {
		ml_resume(caller, null);
	}
});

export function ml_decode(value, cache) {
	switch (typeof(value)) {
	case 'boolean': return value;
	case 'number': return value;
	case 'string': return value;
	case 'object':
		if (typeof(value[0]) === 'number') {
			if (value.length === 1) return cache[value[0]];
			switch (value[1]) {
			case 'list': {
				let list = cache[value[0]] = [];
				for (let i = 2; i < value.length; ++i) {
					list.push(ml_decode(value[i], cache));
				}
				return list;
			}
			case 'map': {
				let map = cache[value[0]] = ml_map();
				for (let i = 2; i < value.length; i += 2) {
					map.insert(ml_decode(value[i], cache), ml_decode(value[i + 1], cache));
				}
				return map;
			}
			case 'global': return cache[value[0]] = ml_global(ml_decode(value[2], cache));
			case 'closure': {
				let closure = cache[value[0]] = ml_closure(ml_decode(value[2]), []);
				for (let i = 3; i < value.length; ++i) {
					closure.upvalues.push(ml_decode(value[i], cache));
				}
				return closure;
			}
			}
		} else {
			switch (value[0]) {
			case '_':
			case 'blank': return MLBlank;
			case 'r':
			case 'regex': return new RegExp(value[1]);
			case ':':
			case 'method': return ml_method(value[1]);
			case 'l':
			case 'list': {
				let list = [];
				for (let i = 1; i < value.length; ++i) {
					list.push(ml_decode(value[i], cache));
				}
				return list;
			}
			case 'n':
			case 'names': {
				let names = ml_names();
				for (let i = 1; i < value.length; ++i) {
					names.push(value[i].toString());
				}
				return names;
			}
			case 'm':
			case 'map': {
				let map = ml_map();
				for (let i = 1; i < value.length; i += 2) {
					map.insert(ml_decode(value[i], cache), ml_decode(value[i + 1], cache));
				}
				return map;
			}
			case 'global': return ml_global(ml_decode(value[1], cache));
			case 'z':
			case 'closure': {
				let closure = ml_closure(ml_decode(value[1]), []);
				for (let i = 2; i < value.length; ++i) {
					closure.upvalues.push(ml_decode(value[i], cache));
				}
				return closure;
			}
			case '!': {
				if (value[1] !== ML_BYTECODE_VERSION) throw 'Bytecode version mismatch';
				let code = value[13];
				for (let i = 0; i < code.length; ++i) {
					if (code[i] instanceof Array) code[i] = ml_decode(code[i], cache);
				}
				return value;
			}
			case '^': return Globals[value[1]];
			case "array": {
				let array = ml_array(value[1], value[2]);
				let values = new (ml_typeof(array).base)(array.bytes);
				if (value[1] === "int64" || value[1] === "uint64") {
					values.set(value[3].map(BigInt));
				} else {
					values.set(value[3]);
				}
				return array;
			}
			}
		}
	}
}

//let json = ["closure",["!","",0,8,0,0,0,0,[],0,72,[15,0,0,1,51,1,["!","",1,6,1,1,0,0,["N"],0,49,[42,2,0,23,2,2,39,2,2,["method","<"],7,2,18,22,3,1,1,3,42,5,0,43,5,0,10,5,42,5,0,23,5,1,39,5,2,["method","-"],10,5,38,5,1,10,5,39,5,2,["method","*"],1,5,1,7]],0,28,1,-1,23,9,1,23,9,10,39,9,2,["method",".."],33,9,34,9,69,36,9,-1,11,9,23,10,["^","print"],56,10,58,10,"fact(20) = ",42,10,0,23,10,20,38,10,1,10,10,57,10,1,58,10,"\n",59,10,10,10,38,10,1,16,9,1,35,9,23,16,11,1,1,11]]];
//let main = ml_decode(json, []);

//ml_call(EndState, main, []);
