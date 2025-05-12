const Trampolines = [];
const MethodsCache = {};
export const Globals = {};
export const ObjectTypes = {};

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
	case "number": return Number.isInteger(self) ? MLIntegerT : MLRealT;
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

export function ml_callx(caller, self, args, run) {
	ml_exec(ml_typeof(self).ml_call, {caller, run}, self, args);
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
	let unpack = ml_typeof(self).unpack;
	if (unpack) return unpack(self, index);
	self = ml_deref(self);
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

export const MLTypeT = Globals["type"] = {
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

export const MLAnyT = Globals["any"] = ml_type("any");
MLTypeT.parents = [MLTypeT, MLAnyT];

const MLTypeSwitchT = ml_type("type-switch", [], {
	ml_call: function(caller, self, args) {
		let value = ml_deref(args[0]);
		ml_resume(caller, self.cases.findIndex(c => c.some(x => {
			return ml_is(value, x);
		})));
	}
});
ObjectTypes["type-switch"] = function(args) {
	return ml_value(MLTypeSwitchT, {cases: args});
}

export function ml_identity(caller, args) {
	ml_resume(caller, args[0]);
}

export const MLFunctionT = Globals["function"] = ml_type("function");
export const MLSequenceT = ml_type("sequence");

function ml_sequence_reduce(caller, sequence, callback, finish) {
	function next_fn(state, iter) {
		if (ml_typeof(iter) === MLErrorT) return ml_resume(caller, iter);
		if (iter === null) return finish(caller);
		state.iter = iter;
		state.run = key_fn;
		ml_iter_key(state, iter);
	}
	function key_fn(state, key) {
		if (ml_typeof(key) === MLErrorT) return ml_resume(caller, key);
		state.key = ml_deref(key);
		state.run = value_fn;
		ml_iter_value(state, state.iter);
	}
	function value_fn(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(caller, value);
		callback(state.key, ml_deref(value));
		state.run = next_fn;
		ml_iter_next(state, state.iter);
	}
	ml_iterate({caller, run: next_fn}, sequence);
}

export const MLNilT = ml_type("nil", [], {
	ml_hash: function(self) { return ""; },
	unpack: function(self, index) {
		return null;
	}
});
export const MLNil = null;

export const MLSomeT = ml_type("some", [], {
	ml_call: function(caller, self, args) {
		function next(state, iter) {
			if (ml_typeof(iter) === MLErrorT) {
				return ml_resume(self.caller, iter);
			} else if (iter === null) {
				return ml_resume(state.caller, iter);
			}
			state.iter = iter;
			state.run = function(state, value) {
				if (value !== null) return ml_resume(state.caller, value);
				state.run = next;
				ml_iter_next(state, state.iter);
			}
			ml_iter_value(state, iter);
		}
		ml_iterate({caller, run: next, iter: null}, ml_chained(args));
	}
});
export const MLSome = Globals["some"] = ml_value(MLSomeT);

export const MLBlankT = ml_type("blank", [], {
	ml_assign: function(_, value) { return value; }
});
export const MLBlank = ml_value(MLBlankT);

export const MLErrorT = Globals["error"] = ml_type("error");
export function ml_error(type, message) {
	return ml_value(MLErrorT, {type, message, stack: []});
}
export function ml_error_trace_add(error, source, line) {
	error.stack.push([source, line]);
}
Globals["error"] = function(caller, args) {
	ml_resume(caller, ml_error(args[0], args[1]));
};
Globals["raise"] = function(caller, args) {
	let type = args[0];
	let message = "";
	let value = args[1];
	ml_resume(caller, ml_value(MLErrorT, {type, message, value, stack: []}));
};

export const MLErrorValueT = ml_type("error-value");
export function ml_error_value(error) {
	let type = error.type;
	let message = error.message;
	let stack = error.stack;
	return ml_value(MLErrorValueT, {type, message, stack});
}

export const MLMethodT = Globals["method"] = ml_type("method", [MLFunctionT], {
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
			for (let i = 0; i < self.definitions.length; ++i) {
				let definition = self.definitions[i];
				let score = score_definition(definition, args);
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

		function score_definition(definition, args) {
			let types = definition.types;
			let numtypes = types.length;
			let numargs = args.length;
			if (numtypes > numargs) return 0;
			let score = 1;
			if (numtypes < numargs) {
				if (!definition.variadic) return 0;
			} else {
				score = 2;
			}
			for (let i = 0; i < numtypes; ++i) {
				let type = types[i];
				if (ml_typeof(args[i]).parents.indexOf(type) === -1) return 0;
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

export const MLBooleanT = Globals["boolean"] = ml_type("boolean");
Object.defineProperty(Boolean.prototype, "ml_type", {value: MLBooleanT});

export const MLNumberT = Globals["number"] = ml_type("number", []);

export const MLRealT = Globals["real"] = MLNumberT;

export const MLIntegerT = Globals["integer"] = ml_type("integer", [MLRealT, MLFunctionT], {
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

Object.defineProperty(Number.prototype, "ml_type", {get: function() {
	return Number.isInteger(this) ? MLIntegerT : MLRealT;
}});

const MLNumberSwitchT = ml_type("number-switch", [], {
	ml_call: function(caller, self, args) {
		let value = ml_deref(args[0]);
		if (!ml_is(value, MLNumberT)) return ml_error("TypeError", `Expected number, not ${ml_typeof(value).name}`);
		ml_resume(caller, self.cases.findIndex(c => c.some(x => {
			return x[0] <= value && value <= x[1];
		})));
	}
});
ObjectTypes["integer-switch"] = ObjectTypes["real-switch"] = function(args) {
	return ml_value(MLNumberSwitchT, {cases: args});
}

const MLRangeIterT = ml_type("range-iter", [], {
	iter_next: function(caller, self) {
		self.value += self.step;
		if (self.step > 0 && self.value > self.max) {
			ml_resume(caller, null);
		} else if (self.step < 0 && self.value < self.max) {
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
export const MLRangeT = ml_type("range", [MLSequenceT], {
	iterate: function(caller, self) {
		if (self.step > 0 && self.min > self.max) {
			ml_resume(caller, null);
		} else if (self.step < 0 && self.min < self.max) {
			ml_resume(caller, null);
		} else {
			ml_resume(caller, ml_value(MLRangeIterT, {max: self.max, step: self.step, key: 1, value: self.min}));
		}
	}
});

const MLStringIterT = ml_type("string-iter", [], {
	iter_next: function(caller, self) {
		if (self.pos >= self.string.length) {
			ml_resume(caller, null);
		} else {
			self.pos += 1;
			ml_resume(caller, self);
		}
	},
	iter_key: function(caller, self) {
		ml_resume(caller, self.pos);
	},
	iter_value: function(caller, self) {
		ml_resume(caller, self.string.charAt(self.pos - 1));
	}
});
export const MLStringT = Globals["string"] = ml_type("string", [MLSequenceT], {
	iterate: function(caller, self) {
		if (self.length) {
			ml_resume(caller, ml_value(MLStringIterT, {string: self, pos: 1}));
		} else {
			ml_resume(caller, null);
		}
	}
});
Object.defineProperty(String.prototype, "ml_type", {value: MLStringT});

export const MLRegexT = Globals["regex"] = ml_type("regex", []);
Object.defineProperty(RegExp.prototype, "ml_type", {value: MLRegexT});

const MLJSFunctionT = ml_type("function", [MLFunctionT], {
	ml_call: function(caller, self, args) {
		for (let i = 0; i < args.length; ++i) args[i] = ml_deref(args[i]);
		try {
			self(caller, args);
		} catch (error) {
			ml_resume(caller, ml_error("JSError", error.toString()));
		}
	}
});
Object.defineProperty(Function.prototype, "ml_type", {value: MLJSFunctionT});

const MLStringSwitchT = ml_type("string-switch", [], {
	ml_call: function(caller, self, args) {
		let value = ml_deref(args[0]);
		if (!ml_is(value, MLStringT)) return ml_error("TypeError", `Expected string, not ${ml_typeof(value).name}`);
		ml_resume(caller, self.cases.findIndex(c => c.some(x => {
			if (x instanceof RegExp) {
				return x.test(value);
			} else {
				return x === value;
			}
		})));
	}
});
ObjectTypes["string-switch"] = function(args) {
	return ml_value(MLStringSwitchT, {cases: args});
}

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
export const MLJSObjectT = Globals["json"] = ml_type("object", [MLSequenceT], {
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

const MLChainedFunctionT = ml_type("chained-function", [MLFunctionT, MLSequenceT], {
	ml_call: function(caller, self, args) {
		let state = {caller, index: 1, entries: self.entries, run: function(state, value) {
			if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
			let index = state.index;
			let fn = state.entries[index++];
			if (fn == undefined) return ml_resume(state.caller, value);
			if (fn === soloMethod) {
				fn = state.entries[index++];
				if (fn == undefined) return ml_resume(state.caller, ml_error("StateError", "Missing value function for chain"));
			}
			state.index = index;
			ml_call(state, fn, [value]);
		}};
		ml_call(state, self.entries[0], args);
	},
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
		ml_chained_iterator_continue(self, self.value);
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

export const MLTupleT = Globals["tuple"] = ml_type("tuple", [], {
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
export const MLListT = Globals["list"] = ml_type("list", [MLSequenceT], {
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

export const MLNamesT = ml_type("names", [MLListT, MLSequenceT], {
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
export const MLMapT = Globals["map"] = ml_type("map", [MLSequenceT], {
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
		nodes = map.nodes[hash] = [];
	} else for (let i = 0; i < nodes.length; ++i) {
		let node = nodes[i];
		if (node.key === key) { // TODO: replace with Minilang comparison
			let old = node.value;
			node.value = value;
			if (ml_typeof(value) === MLUninitializedT) ml_uninitialized_use(value, node, "value");
			return old;
		}
	}
	let node = ml_value(MLMapNodeT, {key, value});
	if (ml_typeof(value) === MLUninitializedT) ml_uninitialized_use(value, node, "value");
	nodes.push(node);
	if (map.tail) {
		map.tail.next = node;
	} else {
		map.head = node;
	}
	node.prev = map.tail;
	map.tail = node;
	++map.size;
	return null;
}
export function ml_map_delete(map, key) {
	let hash = ml_hash(key);
	let nodes = map.nodes[hash];
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
			--map.size;
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

const MLMapTemplateT = ml_type("map::template", [MLFunctionT], {
	ml_call: function(caller, self, args) {
		let map = ml_map();
		let template = self.template;
		for (let i = 0; i < template.length; i += 2) {
			ml_map_insert(map, template[i], ml_deref(args[template[i + 1]]));
		}
		return ml_resume(caller, map);
	}
});
ObjectTypes["map::template"] = function(args) {
	return ml_value(MLMapTemplateT, {template: args});
};

const MLVariableT = ml_type("variable", [], {
	ml_deref: function(self) { return self.value; },
	ml_assign: function(self, value) { return self.value = value; }
});

const MLUninitializedT = ml_type("uninitialized", [], {
	ml_call: function(caller, self, args) {
		ml_resume(caller, ml_error("ValueError", self.name + " is uninitialized"));
	}
});
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

export const MLStringBufferT = MLStringT.exports.buffer = ml_type("stringbuffer");
export function ml_stringbuffer() {
	return ml_value(MLStringBufferT, {string: ""});
}
MLStringBufferT.of = function(caller, args) {
	ml_resume(caller, ml_stringbuffer());
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

const ML_BYTECODE_VERSION = 5;

const MLI_AND = 0;
const MLI_AND_POP = 1;
const MLI_ASSIGN = 2;
const MLI_ASSIGN_LOCAL = 3;
const MLI_CALL = 4;
const MLI_CALL_CONST = 5;
const MLI_CALL_METHOD = 6;
const MLI_CATCH = 7;
const MLI_CATCHX = 8;
const MLI_CLOSURE = 9;
const MLI_CLOSURE_TYPED = 10;
const MLI_ENTER = 11;
const MLI_EXIT = 12;
const MLI_FOR = 13;
const MLI_GOTO = 14;
const MLI_IF_CONFIG = 15;
const MLI_ITER = 16;
const MLI_KEY = 17;
const MLI_LET = 18;
const MLI_LETI = 19;
const MLI_LETX = 20;
const MLI_LINK = 21;
const MLI_LIST_APPEND = 22;
const MLI_LIST_NEW = 23;
const MLI_LOAD = 24;
const MLI_LOAD_PUSH = 25;
const MLI_LOAD_VAR = 26;
const MLI_LOCAL = 27;
const MLI_LOCALI = 28;
const MLI_LOCAL_PUSH = 29;
const MLI_MAP_INSERT = 30;
const MLI_MAP_NEW = 31;
const MLI_NEXT = 32;
const MLI_NIL = 33;
const MLI_NIL_PUSH = 34;
const MLI_NOT = 35;
const MLI_OR = 36;
const MLI_PARAM_TYPE = 37;
const MLI_PARTIAL_NEW = 38;
const MLI_PARTIAL_SET = 39;
const MLI_POP = 40;
const MLI_PUSH = 41;
const MLI_REF = 42;
const MLI_REFI = 43;
const MLI_REFX = 44;
const MLI_RESOLVE = 45;
const MLI_RESUME = 46;
const MLI_RETRY = 47;
const MLI_RETURN = 48;
const MLI_STRING_ADD = 49;
const MLI_STRING_ADDS = 50;
const MLI_STRING_ADD_1 = 51;
const MLI_STRING_END = 52;
const MLI_STRING_NEW = 53;
const MLI_STRING_POP = 54;
const MLI_SUSPEND = 55;
const MLI_SWITCH = 56;
const MLI_TAIL_CALL = 57;
const MLI_TAIL_CALL_CONST = 58;
const MLI_TAIL_CALL_METHOD = 59;
const MLI_TRY = 60;
const MLI_TUPLE_NEW = 61;
const MLI_UPVALUE = 62;
const MLI_VALUE_1 = 63;
const MLI_VALUE_2 = 64;
const MLI_VAR = 65;
const MLI_VARX = 66;
const MLI_VAR_TYPE = 67;
const MLI_WITH = 68;
const MLI_WITHX = 69;

export const MLClosureT = ml_type("closure", [MLFunctionT, MLSequenceT], {
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
			decls: info[14],
			stack,
			upvalues: self.upvalues
		});
		if (self.debugger) {
			frame.debugger = self.debugger;
			frame.run = ml_frame_debug_run;
			frame.decl = frame.decls[info[12]];
			frame.breakpoints = self.debugger.breakpoints(frame.source);
		}
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
	for (;;) {
		switch (code[ip]) {
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
		case MLI_AND_POP:
			if (ml_deref(result) == null) {
				result = null;
				for (let i = code[ip + 3]; --i >= 0;) stack.pop();
				ip = code[ip + 2];
			} else {
				ip += 4;
			}
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
		case MLI_CATCHX:
			self.ep = code[ip + 2];
			if (ml_typeof(result) !== MLErrorT) {
				result = ml_error("InternalError", `expected error, not ${ml_typeof(result).name}`);
				ml_error_trace_add(result, self.source, code[ip + 1]);
				ip = self.ep;
			} else {
				let top = code[ip + 3];
				while (stack.length > top) stack.pop();
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
				result = stack[index] = ml_uninitialized(self.decls[code[ip + 3]].name);
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
		case MLI_IF_CONFIG:
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
				result = ml_error("TypeError", `Expected integer, not ${ml_typeof(result).name}`);
				ml_error_trace_add(result, self.source, code[ip + 1]);
				ip = self.ep;
			} else {
				let insts = code[ip + 2];
				if (result < 0 || result >= insts.length) result = insts.length - 1;
				ip = insts[result];
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
		case MLI_TAIL_CALL_CONST:
		case MLI_TAIL_CALL_METHOD: {
			let count = code[ip + 3];
			let args = stack.splice(stack.length - count, count);
			let func = code[ip + 2];
			return ml_call(self.caller, func, args);
		}
		default: throw `Invalid opcode ${code[ip]}`
		}
	}
}
function ml_frame_debug_run(self, result) {
	let ip = self.ip;
	if (ml_typeof(result) === MLErrorT) {
		if (self.reentry) {
			self.reentry = false;
		} else {
			self.reentry = true;
			return ml_exec(self.debugger.run, self, result);
		}
		ml_error_trace_add(result, self.source, self.line);
		ip = self.ep;
	}
	let code = self.code;
	let stack = self.stack;
	let line = self.line;
	for (;;) {
		if (self.reentry) {
			self.reentry = false;
		} else if (code[ip + 1] != line) {
			line = code[ip + 1];
			if (self.debugger.step_in || self.step_over || self.breakpoints[line]) {
				self.ip = ip;
				self.line = line;
				self.reentry = true;
				return ml_exec(self.debugger.run, self, result);
			}
		}
		switch (code[ip]) {
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
			self.decl = self.decls[code[ip + 2]];
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
			self.decl = self.decls[code[ip + 3]];
			ip += 4;
			break;
		}
		case MLI_POP:
			result = stack.pop();
			ip += 2;
			break;
		case MLI_AND_POP:
			if (ml_deref(result) == null) {
				result = null;
				for (let i = code[ip + 3]; --i >= 0;) stack.pop();
				ip = code[ip + 2];
			} else {
				ip += 4;
			}
			break;
		case MLI_ENTER:
			for (let i = code[ip + 2]; --i >= 0;) {
				let variable = ml_value(MLVariableT, {value: null});
				stack.push(variable);
			}
			for (let i = code[ip + 3]; --i >= 0;) {
				stack.push(undefined);
			}
			self.decl = self.decls[code[ip + 4]];
			ip += 5;
			break;
		case MLI_EXIT:
			for (let i = code[ip + 2]; --i >= 0;) stack.pop();
			self.decl = self.decls[code[ip + 3]];
			ip += 4;
			break;
		case MLI_GOTO:
			ip = code[ip + 2];
			break;
		case MLI_TRY:
			self.ep = code[ip + 2];
			ip += 3;
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
				self.decl = self.decls[code[ip + 4]];
				ip += 5;
			}
			break;
		case MLI_CATCHX:
			self.ep = code[ip + 2];
			if (ml_typeof(result) !== MLErrorT) {
				result = ml_error("InternalError", `expected error, not ${ml_typeof(result).name}`);
				ml_error_trace_add(result, self.source, code[ip + 1]);
				ip = self.ep;
			} else {
				let top = code[ip + 3];
				while (stack.length > top) stack.pop();
				self.decl = self.decls[code[ip + 4]];
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
			let next = code.length - 2;
			self.ip = next;
			self.line = code[ip + 1];
			return ml_call(self, func, args);
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
				result = stack[index] = ml_uninitialized(self.decls[code[ip + 3]].name);
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
			result = ml_closure(info, upvalues, self.debugger);
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
		case MLI_IF_CONFIG:
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
				result = ml_error("TypeError", `Expected integer, not ${ml_typeof(result).name}`);
				ml_error_trace_add(result, self.source, code[ip + 1]);
				ip = self.ep;
			} else {
				let insts = code[ip + 2];
				if (result < 0 || result >= insts.length) result = insts.length - 1;
				ip = insts[result];
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
		case MLI_TAIL_CALL_CONST:
		case MLI_TAIL_CALL_METHOD: {
			let count = code[ip + 3];
			let args = stack.splice(stack.length - count, count);
			let func = code[ip + 2];
			let next = code.length - 2;
			self.ip = next;
			self.line = code[ip + 1];
			return ml_call(self, func, args);
		}
		default: throw `Invalid opcode ${code[ip]}`
		}
	}
}
export function ml_closure(info, upvalues, _debugger) {
	return ml_value(MLClosureT, {info, upvalues, "debugger": _debugger});
}

export const MLModuleT = ml_type("module");
export function ml_module(name, exports) {
	exports = exports || {};
	return ml_value(MLModuleT, {name, exports});
}

function ml_array_copy(target, target_offset, source, source_offset, degree) {
	let target_stride = target.strides[degree + (target.degree - source.degree)];
	let source_stride = source.strides[degree];
	if (degree === source.degree - 1) {
		for (let i = 0; i < source.shape[degree]; ++i) {
			target.values[target_offset] = source.values[source_offset];
			target_offset += target_stride;
			source_offset += source_stride;
		}
	} else {
		for (let i = 0; i < source.shape[degree]; ++i) {
			ml_array_copy(target, target_offset, source, source_offset, degree + 1);
			target_offset += target_stride;
			source_offset += source_stride;
		}
	}
}

function ml_array_assign_array(target, offset, source, degree) {
	if (degree === (target.degree - source.degree)) {
		ml_array_copy(target, offset, source, source.offset, 0);
	} else {
		let stride = target.strides[degree];
		for (let i = 0; i < target.shape[degree]; ++i) {
			ml_array_assign_array(target, offset, source, degree + 1);
			offset += stride;
		}
	}
}

function ml_array_assign_value(target, offset, source, degree) {
	if (degree === target.degree) {
		target.values[offset] = source;
	} else {
		let stride = target.strides[degree];
		for (let i = 0; i < target.shape[degree]; ++i) {
			ml_array_assign_value(target, offset, source, degree + 1);
			offset += stride;
		}
	}
}

function ml_array_deref(self) {
	if (self.degree === 0) return self.values[self.offset];
	return self;
}

function ml_array_assign(self, value) {
	if (ml_is(value, MLNumberT)) {
		ml_array_assign_value(self, self.offset, value, 0);
		return value;
	} else if (ml_is(value, MLArrayT)) {
		if (value.degree > self.degree) return ml_error("ShapeError", "Incompatible array assignment");
		for (let i = 1; i < value.degree; ++i) {
			if (value.shape[value.degree - i] !== self.shape[self.degree - i]) return ml_error("ShapeError", "Incompatible array assignment");
		}
		ml_array_assign_array(self, self.offset, value, 0);
		return value;
	} else {
		return ml_error("TypeError", "Unsupported value for array assignment");
	}
}

export const MLArrayT = Globals["array"] = ml_type("array");
MLArrayT.exports.uint8 = ml_type("array::uint8", [MLArrayT], {
	base: Uint8Array, index: 1,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.int8 = ml_type("array::int8", [MLArrayT], {
	base: Int8Array, index: 2,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.uint16 = ml_type("array::uint16", [MLArrayT], {
	base: Uint16Array, index: 3,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.int16 = ml_type("array::int16", [MLArrayT], {
	base: Int16Array, index: 4,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.uint32 = ml_type("array::uint32", [MLArrayT], {
	base: Uint32Array, index: 5,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.int32 = ml_type("array::int32", [MLArrayT], {
	base: Int32Array, index: 6,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.uint64 = ml_type("array::uint64", [MLArrayT], {
	base: BigUint64Array, index: 7,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.int64 = ml_type("array::int64", [MLArrayT], {
	base: BigInt64Array, index: 8,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.float32 = ml_type("array::float32", [MLArrayT], {
	base: Float32Array, index: 9,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.float64 = ml_type("array::float64", [MLArrayT], {
	base: Float64Array, index: 10,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});
MLArrayT.exports.any = ml_type("array::any", [MLArrayT], {
	base: Array, index: 11,
	ml_deref: ml_array_deref,
	ml_assign: ml_array_assign
});

export function ml_array(type, shape) {
	if (typeof(type) === "string") {
		let actual = MLArrayT.exports[type];
		if (!actual) return ml_error("ArrayError", `Unknown array type: ${type}`);
		type = actual;
	}
	let size = 1;
	let degree = shape.length;
	let strides = new Array(degree);
	for (let i = degree; --i >= 0;) {
		strides[i] = size;
		size *= shape[i];
	}
	let values = new (type.base)(size);
	return ml_value(type, {degree, shape, strides, values, offset: 0});
}

Globals.error = function(caller, args) {
	ml_resume(caller, ml_error(args[0].toString(), args[1].toString()));
}

Globals.print = function(caller, args) {
	if (args.length === 0) return ml_resume(caller, null);
	let buffer = ml_stringbuffer();
	let state = {caller, index: 1, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		if (state.index === args.length) {
			console.log(value.string);
			return ml_resume(state.caller, null);
		}
		ml_call(state, appendMethod, [value, args[state.index++]]);
	}};
	ml_call(state, appendMethod, [buffer, args[0]]);
}

ml_method_define("!", [MLFunctionT, MLListT], false, function(caller, args) {
	let values = [];
	args[1].forEach(value => values.push(value));
	return ml_call(caller, args[0], values);
});

ml_method_define("!", [MLFunctionT, MLMapT], false, function(caller, args) {
	let names = ml_names();
	let values = [names];
	args[1].forEach((key, value) => {
		names.push(key);
		values.push(value);
	});
	return ml_call(caller, args[0], values);
});

ml_method_define("!", [MLFunctionT, MLListT, MLMapT], false, function(caller, args) {
	let values = [];
	args[1].forEach(value => values.push(value));
	let names = ml_names();
	values.push(names);
	args[2].forEach((key, value) => {
		names.push(key);
		values.push(value);
	});
	return ml_call(caller, args[0], values);
});

ml_method_define("count", [MLSequenceT], true, function(caller, args) {
	let state = {caller, count: 0, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(state.caller, value);
		} else if (value == null) {
			ml_resume(state.caller, state.count);
		} else {
			state.count++;
			ml_iter_next(state, value);
		}
	}};
	ml_iterate(state, ml_chained(args));
});

Globals.count2 = function(caller, args) {
	function iter_next(state, value) {
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(state.caller, value);
		} else if (value == null) {
			ml_resume(state.caller, state.counts);
		} else {
			state.run = iter_value;
			ml_iter_value(state, state.iter = value);
		}
	}
	function iter_value(state, value) {
		if (ml_typeof(value) === MLErrorT) {
			return ml_resume(state.caller, value);
		}
		value = ml_deref(value);
		let node = ml_map_search(state.counts, value);
		if (node) {
			node.value++;
		} else {
			ml_map_insert(state.counts, value, 1);
		}
		state.run = iter_next;
		ml_iter_next(state, state.iter);
	}
	let state = {caller, counts: ml_map(), run: iter_next};
	ml_iterate(state, ml_chained(args));
};

ml_method_define("first", [MLSequenceT], true, function(caller, args) {
	function next(state, iter) {
		if (ml_typeof(iter) === MLErrorT) {
			return ml_resume(state.caller, iter);
		} else if (iter == null) {
			return ml_resume(state.caller, iter);
		}
		ml_iter_value(state.caller, iter);
	}
	ml_iterate({caller, run: next}, args[0]);
});

ml_method_define("first2", [MLSequenceT], true, function(caller, args) {
	let state = {caller, run: function(state, iter) {
		if (ml_typeof(iter) === MLErrorT) {
			return ml_resume(state.caller, iter);
		} else if (iter == null) {
			return ml_resume(state.caller, iter);
		}
		state.iter = iter;
		state.run = function(state, value) {
			state.key = value;
			state.run = function(state, value) {
				ml_resume(state.caller, ml_value(MLTupleT, {values: [state.key, value]}));
			}
			ml_iter_value(state, state.iter);
		}
		ml_iter_key(state, iter);
	}};
	ml_iterate(state, ml_chained(args));
});

function ml_sequence_extremum(compare, caller, args) {
	let state = {caller, run: function(state, iter) {
		if (ml_typeof(iter) === MLErrorT) {
			return ml_resume(state.caller, iter);
		} else if (iter == null) {
			return ml_resume(state.caller, null);
		}
		state.iter = iter;
		state.run = function(state, value) {
			if (ml_typeof(value) === MLErrorT) {
				return ml_resume(state.caller, iter);
			}
			state.value = value;
			state.run = next_fn;
			ml_iter_next(state, state.iter);
		};
		ml_iter_value(state, iter);
	}};
	function next_fn(state, iter) {
		if (ml_typeof(iter) === MLErrorT) {
			return ml_resume(state.caller, iter);
		} else if (iter == null) {
			return ml_resume(state.caller, state.value);
		}
		state.iter = iter;
		state.run = value_fn;
		ml_iter_value(state, iter);
	}
	function value_fn(state, value) {
		if (ml_typeof(value) === MLErrorT) {
			return ml_resume(state.caller, iter);
		}
		state.run = call_fn;
		ml_call(state, compare, [state.value, value]);
	}
	function call_fn(state, value) {
		if (ml_typeof(value) === MLErrorT) {
			return ml_resume(state.caller, iter);
		} else if (value != null) {
			state.value = value;
		}
		state.run = next_fn;
		ml_iter_next(state, state.iter);
	}
	ml_iterate(state, ml_chained(args));
}

Globals.min = ml_sequence_extremum.bind(null, ml_method(">"));
Globals.max = ml_sequence_extremum.bind(null, ml_method("<"));

ml_method_define("join", [MLSequenceT, MLStringT], false, function(caller, args) {
	let buffer = ml_stringbuffer();
	let separator = args[1];
	let state = {caller, run: join_first};
	ml_iterate(state, args[0]);
	function join_first(state, iter) {
		if (ml_typeof(iter) === MLErrorT) return ml_resume(state.caller, iter);
		if (iter === null) return ml_resume(state.caller, buffer.string);
		state.iter = iter;
		state.run = join_value;
		ml_iter_value(state, iter);
	}
	function join_value(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		state.run = join_append;
		ml_call(state, appendMethod, [buffer, value]);
	}
	function join_append(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		state.run = join_next;
		ml_iter_next(state, state.iter);
	}
	function join_next(state, iter) {
		if (ml_typeof(iter) === MLErrorT) return ml_resume(state.caller, iter);
		if (iter === null) return ml_resume(state.caller, buffer.string);
		buffer.string += separator;
		state.iter = iter;
		state.run = join_value;
		ml_iter_value(state, iter);
	}
});

const MLLimitedIterT = ml_type("limited-iter", [], {
	iter_next: function(caller, self) {
		if (--self.limit === 0) return ml_resume(caller, null);
		return ml_iter_next(self, self.iter);
	},
	iter_key: function(caller, self) {
		return ml_iter_key(caller, self.iter);
	},
	iter_value: function(caller, self) {
		return ml_iter_value(caller, self.iter);
	}
});

const MLLimitedT = ml_type("limited", [MLSequenceT], {
	iterate: function(caller, self) {
		if (self.limit == 0) return ml_resume(caller, null);
		let state = ml_value(MLLimitedIterT, {
			caller, limit: self.limit,
			run: function(state, iter) {
				if (ml_typeof(iter) === MLErrorT) return ml_resume(caller, iter);
				if (iter === null) return ml_resume(caller, iter);
				state.iter = iter;
				ml_resume(caller, state);
			}
		});
		return ml_iterate(state, self.sequence);
	}
});

ml_method_define("limit", [MLSequenceT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, ml_value(MLLimitedT, {sequence: args[0], limit: args[1]}));
});

const MLSkippedT = ml_type("skipped", [MLSequenceT], {
	iterate: function(caller, self) {
		if (self.skip === 0) return ml_iterate(caller, self.sequence);
		let state = {
			caller, skip: self.skip + 1,
			run: function(state, iter) {
				if (ml_typeof(iter) === MLErrorT) return ml_resume(caller, iter);
				if (iter === null) return ml_resume(caller, iter);
				if (--state.skip === 0) return ml_resume(caller, iter);
				return ml_iter_next(state, iter);
			}
		};
		return ml_iterate(state, self.sequence);
	}
});

ml_method_define("skip", [MLSequenceT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, ml_value(MLSkippedT, {sequence: args[0], skip: args[1]}));
});

const MLUniqueIterT = ml_type("unique-iter", [], {
	iter_next: function(caller, self) {
		let state = {
			caller,
			run: function(state, iter) {
				if (ml_typeof(iter) === MLErrorT) return ml_resume(caller, iter);
				if (iter === null) return ml_resume(caller, null);
				self.iter = iter;
				let state2 = {
					caller,
					run: function(state2, value) {
						value = ml_deref(value);
						if (ml_typeof(value) === MLErrorT) return ml_resume(caller, value);
						if (ml_map_insert(self.history, value, MLSome) === null) {
							self.value = value;
							return ml_resume(caller, self);
						}
						return ml_iter_next(state, iter);
					}
				}
				return ml_iter_value(state2, iter);
			}
		};
		return ml_iter_next(state, self.iter);
	},
	iter_key: function(caller, self) {
		return ml_iter_key(caller, self.iter);
	},
	iter_value: function(caller, self) {
		return ml_resume(caller, self.value);
	}
});

const MLUniqueT = ml_type("unique", [MLSequenceT], {
	iterate: function(caller, self) {
		let state = {
			caller,
			run: function(state, iter) {
				if (ml_typeof(iter) === MLErrorT) return ml_resume(caller, iter);
				if (iter === null) return ml_resume(caller, null);
				state.run = function(state, value) {
					value = ml_deref(value);
					if (ml_typeof(value) === MLErrorT) return ml_resume(caller, value);
					let history = ml_map();
					ml_map_insert(history, value, MLSome);
					return ml_resume(caller, ml_value(MLUniqueIterT, {iter, history, value}));
				};
				return ml_iter_value(state, iter);
			}
		};
		return ml_iterate(state, self.sequence);
	}
});

Globals.unique = function(caller, args) {
	ml_resume(caller, ml_value(MLUniqueT, {sequence: ml_chained(args)}));
};

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
ml_method_define("<", [MLAnyT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, args[0] < args[1] ? args[1] : null);
});
ml_method_define(">", [MLAnyT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, args[0] > args[1] ? args[1] : null);
});
ml_method_define("<=", [MLAnyT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, args[0] <= args[1] ? args[1] : null);
});
ml_method_define(">=", [MLAnyT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, args[0] >= args[1] ? args[1] : null);
});

["=", "!=", "<", ">", "<=", ">="].forEach(function(op) {
	ml_method_define(op, [MLNilT, MLAnyT], false, function(caller, args) {
		ml_resume(caller, null);
	});
	ml_method_define(op, [MLAnyT, MLNilT], false, function(caller, args) {
		ml_resume(caller, null);
	});
});

ml_method_define("->", [MLFunctionT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], args[1]]));
});
ml_method_define("->", [MLSequenceT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], args[1]]));
});
ml_method_define("=>", [MLSequenceT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], duoMethod, 1, args[1]]));
});
ml_method_define("=>", [MLSequenceT, MLFunctionT, MLFunctionT], false, function(caller, args) {
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
ml_method_define("->?", [MLSequenceT, MLFunctionT], false, function(caller, args) {
	ml_resume(caller, ml_chained([args[0], filterSoloMethod, args[1]]));
});
ml_method_define("=>?", [MLSequenceT, MLFunctionT], false, function(caller, args) {
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

function ml_parse_number(caller, args) {
	let string = args[0];
	let result;
	if (string === "") {
		result = ml_error("ValueError", "Error parsing number");
	} else if (string === "NaN") {
		result = NaN;
	} else {
		result = Number(string);
		if (isNaN(result)) result = ml_error("ValueError", "Error parsing number");
	}
	ml_resume(caller, result);
}

ml_method_define(MLNumberT, [MLNumberT], false, ml_identity);
ml_method_define(MLNumberT, [MLStringT], false, ml_parse_number);

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
ml_method_define("%", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] % args[1]);
});

ml_method_define(MLIntegerT, [MLNumberT], false, function(caller, args) {
	ml_resume(caller, Math.floor(args[0]));
});
ml_method_define(MLIntegerT, [MLStringT], false, ml_parse_number);

ml_method_define(MLRealT, [MLNumberT], false, ml_identity);
ml_method_define(MLRealT, [MLStringT], false, ml_parse_number);

[
	"acos", "acosh", "asin", "asinh", "atan", "atanh",
	"cos", "cosh", "sin", "sinh", "tan", "tanh",
	"exp", "expm1", "log", "log1p", "log10", "sqrt", "cbrt",
	"floor", "ceil", "round"
].forEach(name => {
	let fn = Math[name];
	if (!fn) throw "Math." + name + " not found";
	ml_method_define("math::" + name, [MLNumberT], false, function(caller, args) {
		ml_resume(caller, fn(args[0]));
	});
});

ml_method_define("..", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, ml_value(MLRangeT, {min: args[0], max: args[1], step: 1}));
});
ml_method_define("..", [MLRangeT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, ml_value(MLRangeT, {min: args[0].min, max: args[0].max, step: args[1]}));
});
ml_method_define("by", [MLRangeT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, ml_value(MLRangeT, {min: args[0].min, max: args[0].max, step: args[1]}));
});

ml_method_define("append", [MLStringBufferT, MLNumberT], false, function(caller, args) {
	args[0].string += args[1].toString();
	ml_resume(caller, args[0]);
});

function intToBase(value, base) {
	let chars = [];
	let sign = "";
	if (value < 0) {
		sign = "-";
		value = -value;
	}
	do {
		chars.unshift("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[value % base]);
		value = Math.floor(value / base);
	} while (value);
	return sign + chars.join("");
}

ml_method_define("append", [MLStringBufferT, MLNumberT, MLNumberT], false, function(caller, args) {
	let base = args[2];
	if (base < 2 || base > 36 || base !== Math.floor(base)) {
		return ml_resume(caller, ml_error("RangeError", "Invalid base"));
	}
	let value = args[1];
	if (value !== Math.floor(value)) {
		return ml_resume(caller, ml_error("UnsupportedError", "Base conversions of reals not supported yet"));
	}
	args[0].string += intToBase(value, base);
	ml_resume(caller, args[0]);
});
ml_method_define("append", [MLStringBufferT, MLNumberT, MLStringT], false, function(caller, args) {
	let format = /^(\s*)%(-)?([+ ])?(#)?(')?(0)?([1-9][0-9]*)?(\.[0-9]+)?l?([diouxXaefgAEG])(\s*)$/.exec(args[2]);
	console.log("format", format);
	if (format === null) return ml_resume(caller, ml_error("FormatError", "Invalid format string"));
	let alwaysPoint = !!format[4];
	let separators = !!format[5];
	let width = parseInt(format[7]);
	let precision = format[8] ? parseInt(format[8].substring(1)) : 6;
	let type = format[9];
	let value = args[1];
	let sign = "";
	if (value < 0) {
		sign = "-";
		value = -value;
	} else if (format[3] === "+") {
		sign = "+";
	} else if (format[3] === " ") {
		sign = " ";
	}
	let base = "";
	switch (type) {
	case "d": case "i": case "u":
		base = Math.floor(value).toString();
		break;
	case "o":
		base = intToBase(Math.floor(value), 8);
		break;
	case "x": case "X":
		base = intToBase(Math.floor(value), 16);
		if (type === "x") base = base.toLowerCase();
		break;
	case "a": case "A":
		return ml_resume(caller, ml_error("FormatError", "Unsupported format string"));
	case "e": case "E":
		base = value.toExponential(precision);
		if (type === "E") base = base.toUpperCase();
		break;
	case "f": case "F":
		base = value.toFixed(precision);
		if (type === "F") base = base.toUpperCase();
		break;
	case "g": case "G":
		let exp = Math.log10(value);
		if ((exp < -4) || (exp >= precision)) {
			base = value.toExponential(precision);
		} else {
			base = value.toFixed(precision);
		}
		if (type === "G") base = base.toUpperCase();
		break;
	}
	console.log("sign", sign);
	console.log("base", base);
	if (width !== undefined) {
		let count = width - (base.length + sign.length);
		if (count > 0) {
			if (!!format[2]) {
				base += " ".repeat(count);
			} else {
				let padding = format[6] ? "0" : " ";
				base = padding.repeat(count) + base;
			}
		}
	}
	console.log("base", base);
	args[0].string += format[1] + sign + base + format[10];
	return ml_resume(caller, args[0]);
});

ml_method_define(MLStringT, [MLStringT], false, ml_identity);
ml_method_define(MLStringT, [MLAnyT], true, function(caller, args) {
	let buffer = ml_stringbuffer();
	let state = {caller, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		ml_resume(state.caller, value.string);
	}};
	ml_call(state, appendMethod, [buffer].concat(args));
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
ml_method_define("trim", [MLStringT, MLStringT], false, function(caller, args) {
	let subject = args[0];
	let trim = args[1];
	let start = 0, end = subject.length;
	while (start < end && trim.indexOf(subject[start]) > -1) ++start;
	while (start < end && trim.indexOf(subject[end - 1]) > -1) --end;
	console.log(subject, subject.length, start, end);
	ml_resume(caller, subject.substring(start, end));
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
	ml_resume(caller, args[0].split(args[1]).filter(Boolean));
});
ml_method_define("/", [MLStringT, MLRegexT], false, function(caller, args) {
	ml_resume(caller, args[0].split(args[1]).filter(Boolean));
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
		return ml_resume(caller, args[0])
	} else {
		return ml_resume(caller, null);
	}
});
ml_method_define("ends", [MLStringT, MLStringT], false, function(caller, args) {
	if (args[0].endsWith(args[1])) {
		return ml_resume(caller, args[0])
	} else {
		return ml_resume(caller, null);
	}
});
ml_method_define("replace", [MLStringT, MLStringT, MLStringT], false, function(caller, args) {
	ml_resume(caller, args[0].replaceAll(args[1], args[2]));
});
ml_method_define("replace", [MLStringT, MLRegexT, MLStringT], false, function(caller, args) {
	ml_resume(caller, args[0].replaceAll(new RegExp(args[1], "g"), args[2]));
});
ml_method_define("append", [MLStringBufferT, MLStringT], false, function(caller, args) {
	args[0].string += args[1];
	ml_resume(caller, args[0]);
});

ml_method_define("write", [MLStringBufferT, MLAnyT], true, function(caller, args) {
	let start = args[0].string.length;
	let state = {caller, index: 1, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		if (++state.index === args.length) return ml_resume(state.caller, value.string.length - start);
		ml_call(state, appendMethod, [value, args[state.index]]);
	}};
	ml_call(state, appendMethod, [args[0], args[1]]);
});
ml_method_define("rest", [MLStringBufferT], false, function(caller, args) {
	let rest = args[0].string;
	args[0].string = "";
	ml_resume(caller, rest);
});

ml_method_define("[]", [MLTupleT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0].values[args[1] - 1]);
});
ml_method_define("append", [MLStringBufferT, MLTupleT], false, function(caller, args) {
	let buffer = args[0];
	let list = args[1].values;
	if (!list.length) {
		buffer.string += "()";
		return ml_resume(caller, args[0]);
	}
	let state = {caller, list, index: 1, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		let list = state.list;
		if (state.index == list.length) {
			value.string += ")";
			ml_resume(state.caller, value);
		} else {
			value.string += ", ";
			ml_call(state, appendMethod, [value, list[state.index++]]);
		}
	}};
	buffer.string += "(";
	ml_call(state, appendMethod, [buffer, list[0]]);
});

ml_method_define(MLListT, [MLSequenceT], true, function(caller, args) {
	let list = [];
	let state = {caller, list, run: iter_next};
	ml_iterate(state, ml_chained(args));
	function iter_next(state, value) {
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(state.caller, value);
		} else if (value == null) {
			ml_resume(state.caller, state.list);
		} else {
			state.iter = value;
			state.run = iter_value;
			ml_iter_value(state, value);
		}
	}
	function iter_value(state, value) {
		value = ml_deref(value);
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(state.caller, value);
		} else {
			state.list.push(value);
			state.run = iter_next;
			ml_iter_next(state, state.iter);
		}
	}
});
ml_method_define("[]", [MLListT, MLNumberT], false, function(caller, args) {
	let list = args[0];
	let index = args[1] - 1;
	if (index < 0) index += list.length + 1;
	if (index < 0 || index >= list.length) return ml_resume(caller, null);
	ml_resume(caller, ml_value(MLListNodeT, {list, index}));
});
ml_method_define("[]", [MLListT, MLNumberT, MLNumberT], false, function(caller, args) {
	let list = args[0];
	let index1 = args[1] - 1;
	if (index1 < 0) index1 += list.length + 1;
	if (index1 < 0 || index1 >= list.length) return ml_resume(caller, null);
	let index2 = args[2] - 1;
	if (index2 < 0) index2 += list.length + 1;
	if (index2 < 0 || index2 > list.length) return ml_resume(caller, null);
	if (index1 >= index2) return ml_resume(caller, null);
	ml_resume(caller, list.slice(index1, index2));
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
ml_method_define("+", [MLListT, MLListT], false, function(caller, args) {
	ml_resume(caller, args[0].concat(args[1]));
});
ml_method_define("insert", [MLListT, MLNumberT, MLAnyT], false, function(caller, args) {
	let list = args[0];
	let index = args[1] - 1;
	if (index < 0) index += list.length + 1;
	if (index < 0 || index > list.length) return ml_resume(caller, null);
	list.splice(index, 0, args[2]);
	ml_resume(caller, list);
});
ml_method_define("delete", [MLListT, MLNumberT], false, function(caller, args) {
	let list = args[0];
	let index = args[1] - 1;
	if (index < 0) index += list.length + 1;
	if (index < 0 || index >= list.length) return ml_resume(caller, null);
	ml_resume(caller, list.splice(index, 1)[0]);
});
ml_method_define("splice", [MLListT], false, function(caller, args) {
	let list = args[0];
	ml_resume(caller, list.splice(0));
});
ml_method_define("splice", [MLListT, MLNumberT, MLNumberT], false, function(caller, args) {
	let list = args[0];
	let start = args[1] - 1;
	if (start < 0) start += list.length + 1;
	if (start < 0) return ml_resume(caller, null);
	let count = args[2];
	if (count < 0) return ml_resume(caller, null);
	if (start + count > list.length) return ml_resume(caller, null);
	if (count == 0) return ml_resume(caller, []);
	ml_resume(caller, list.splice(start, count));
});
ml_method_define("splice", [MLListT, MLNumberT, MLNumberT, MLListT], false, function(caller, args) {
	let list = args[0];
	let start = args[1] - 1;
	if (start < 0) start += list.length + 1;
	if (start < 0) return ml_resume(caller, null);
	let count = args[2];
	if (count < 0) return ml_resume(caller, null);
	if (start + count > list.length) return ml_resume(caller, null);
	let other = args[3];
	ml_resume(caller, list.splice(start, count, ...other.splice(0)));
});
ml_method_define("grow", [MLListT, MLSequenceT], true, function(caller, args) {
	let list = args[0];
	ml_sequence_reduce(caller, ml_chained(args.slice(1)), function(key, value) {
		ml_list_put(list, value);
	}, function(caller) {
		ml_resume(caller, list);
	});
});

let equalMethod = ml_method("=");
ml_method_define("find", [MLListT, MLAnyT], false, function(caller, args) {
	let list = args[0];
	if (list.length === 0) return ml_resume(caller, null);
	let value = args[1];
	let node = list[0];
	let state = {caller, list, value, index: 1, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		if (value != null) return ml_resume(state.caller, state.index);
		if (state.list.length < state.index) return ml_resume(state.caller, null);
		let node = state.list[state.index++];
		if (node == undefined) return ml_resume(state.caller, null);
		ml_call(state, equalMethod, [state.value, node]);
	}};
	ml_call(state, equalMethod, [value, node]);
});

function ml_list_sort_run(state, value) {
	if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
	let list = state.list, i = state.i, j = state.j, k;
	if (value !== null) {
		list[i++] = state.t;
		k = state.i = i;
	} else {
		list[j--] = state.t;
		k = state.j = j;
	}
	if (i < j) {
		let t = state.t = list[k];
		return ml_call(state, state.compare, [t, state.p]);
	}
	list[k] = state.p;
	let a = state.a, b = state.b, stack = state.stack;
	if (a < i - 1) stack.push(a, i - 1);
	if (j + 1 < b) stack.push(j + 1, b);
	if (!stack.length) return ml_resume(state.caller, list);
	b = state.b = stack.pop();
	a = state.a = stack.pop();
	state.p = list[state.j = b];
	state.t = list[state.i = a];
	return ml_call(state, state.compare, [state.t, state.p]);
}
ml_method_define("sort", [MLListT], false, function(caller, args) {
	let list = args[0];
	if (!list.length) return ml_resume(caller, list);
	let compare = ml_method("<");
	let a = 0, b = list.length - 1;
	let i = a, j = b;
	let p = list[i], t = list[j];
	let state = {caller, list, compare, a, b, i, j, p, t, stack: [], run: ml_list_sort_run};
	return ml_call(state, compare, [t, p]);
});
ml_method_define("sort", [MLListT, MLFunctionT], false, function(caller, args) {
	let list = args[0];
	if (!list.length) return ml_resume(caller, list);
	let compare = args[1];
	let a = 0, b = list.length - 1;
	let i = a, j = b;
	let p = list[i], t = list[j];
	let state = {caller, list, compare, a, b, i, j, p, t, stack: [], run: ml_list_sort_run};
	return ml_call(state, compare, [t, p]);
});

ml_method_define("append", [MLStringBufferT, MLListT], false, function(caller, args) {
	let buffer = args[0];
	let list = args[1];
	if (!list.length) {
		buffer.string += "[]";
		return ml_resume(caller, args[0]);
	}
	let state = {caller, list, index: 1, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		let list = state.list;
		if (state.index == list.length) {
			value.string += "]";
			ml_resume(state.caller, value);
		} else {
			value.string += ", ";
			ml_call(state, appendMethod, [value, list[state.index++]]);
		}
	}};
	buffer.string += "[";
	ml_call(state, appendMethod, [buffer, list[0]]);
});

ml_method_define(MLMapT, [MLSequenceT], true, function(caller, args) {
	let map = ml_map();
	let state = {caller, map, run: iter_next};
	ml_iterate(state, ml_chained(args));
	function iter_next(state, value) {
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(state.caller, value);
		} else if (value == null) {
			ml_resume(state.caller, state.map);
		} else {
			state.iter = value;
			state.run = iter_key;
			ml_iter_key(state, value);
		}
	}
	function iter_key(state, value) {
		value = ml_deref(value);
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(state.caller, value);
		} else {
			state.key = value;
			state.run = iter_value;
			ml_iter_value(state, state.iter);
		}
	}
	function iter_value(state, value) {
		value = ml_deref(value);
		if (ml_typeof(value) === MLErrorT) {
			ml_resume(state.caller, value);
		} else {
			ml_map_insert(state.map, state.key, value);
			state.run = iter_next;
			ml_iter_next(state, state.iter);
		}
	}
});
ml_method_define("::", [MLMapT, MLStringT], false, function(caller, args) {
	let map = args[0];
	let key = args[1];
	let node = ml_map_search(map, key);
	if (node) return ml_resume(caller, node);
	ml_resume(caller, ml_value(MLMapIndexT, {map, key}));
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
ml_method_define("size", [MLMapT], false, function(caller, args) {
	ml_resume(caller, args[0].size);
});
ml_method_define("count", [MLMapT], false, function(caller, args) {
	ml_resume(caller, args[0].size);
});
ml_method_define("+", [MLMapT, MLMapT], false, function(caller, args) {
	let map = ml_map();
	for (let node = args[0].head; node; node = node.next) {
		ml_map_insert(map, node.key, node.value);
	}
	for (let node = args[1].head; node; node = node.next) {
		ml_map_insert(map, node.key, node.value);
	}
	ml_resume(caller, map);
});
ml_method_define("\\/", [MLMapT, MLMapT], false, function(caller, args) {
	let map = ml_map();
	for (let node = args[0].head; node; node = node.next) {
		ml_map_insert(map, node.key, node.value);
	}
	for (let node = args[1].head; node; node = node.next) {
		ml_map_insert(map, node.key, node.value);
	}
	ml_resume(caller, map);
});
ml_method_define("/", [MLMapT, MLMapT], false, function(caller, args) {
	let map = ml_map();
	for (let node = args[0].head; node; node = node.next) {
		if (!ml_map_search(args[1], node.key)) {
			ml_map_insert(map, node.key, node.value);
		}
	}
	ml_resume(caller, map);
});
ml_method_define("*", [MLMapT, MLMapT], false, function(caller, args) {
	let map = ml_map();
	for (let node = args[1].head; node; node = node.next) {
		if (ml_map_search(args[0], node.key)) {
			ml_map_insert(map, node.key, node.value);
		}
	}
	ml_resume(caller, map);
});
ml_method_define("/\\", [MLMapT, MLMapT], false, function(caller, args) {
	let map = ml_map();
	for (let node = args[1].head; node; node = node.next) {
		if (ml_map_search(args[0], node.key)) {
			ml_map_insert(map, node.key, node.value);
		}
	}
	ml_resume(caller, map);
});
ml_method_define("grow", [MLMapT, MLSequenceT], true, function(caller, args) {
	let map = args[0];
	ml_sequence_reduce(caller, ml_chained(args.slice(1)), function(key, value) {
		ml_map_insert(map, key, value);
	}, function(caller) {
		ml_resume(caller, map);
	});
});
ml_method_define("append", [MLStringBufferT, MLMapT], false, function(caller, args) {
	let buffer = args[0];
	let node = args[1].head;
	if (!node) {
		buffer.string += "{}";
		return ml_resume(caller, args[0]);
	}
	let state = {caller, node, key: true, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		if (state.key) {
			value.string += " is ";
			state.key = false;
			ml_call(state, appendMethod, [value, state.node.value]);
		} else {
			let node = state.node.next;
			if (!node) {
				value.string += "}";
				return ml_resume(state.caller, value);
			}
			state.key = true;
			state.node = node;
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
	let state = {caller, keys, object: args[1], run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(state.caller, value);
		let key = state.keys.shift();
		if (!key) {
			value.string += "}";
			return ml_resume(state.caller, value);
		}
		value.string += ", " + key + ": ";
		ml_call(state, appendMethod, [value, state.object[key]]);
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

ml_method_define("type", [MLErrorValueT], false, function(caller, args) {
	ml_resume(caller, args[0].type);
});
ml_method_define("message", [MLErrorValueT], false, function(caller, args) {
	ml_resume(caller, args[0].message);
});
ml_method_define("raise", [MLErrorValueT], false, function(caller, args) {
	ml_resume(caller, ml_value(MLErrorT, args[0]));
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
ml_method_define(MLJSObjectT, [MLMapT], false, function(caller, args) {
	let object = {};
	args[0].forEach((key, value) => object[key] = value);
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

function ml_array_of_type(source, type) {
	if (ml_is(source, MLListT)) {
		source.forEach(value => {
			type = ml_array_of_type(value, type);
		});
	} else if (ml_is(source, MLTupleT)) {
		source.values.forEach(value => {
			type = ml_array_of_type(value, type);
		});
	} else if (ml_is(source, MLNumberT)) {
		if (type.index < MLArrayT.exports.float64.index) type = MLArrayT.exports.float64;
	} else if (ml_is(source, MLRangeT)) {
		if (type.index < MLArrayT.exports.float64.index) type = MLArrayT.exports.float64;
	} else {
		if (type.index < MLArrayT.exports.any.index) type = MLArrayT.exports.any;
	}
	return type;
}

function ml_array_of_shape(source, degree) {
	if (ml_is(source, MLListT)) {
		let size = source.length;
		if (!size) return ml_error("ValueError", "Empty dimension in array");
		let shape = ml_array_of_shape(source[0], degree + 1);
		if (ml_typeof(shape) === MLErrorT) return shape;
		shape[degree] = size;
		return shape;
	} else if (ml_is(source, MLTupleT)) {
		let size = source.values.length;
		if (!size) return ml_error("ValueError", "Empty dimension in array");
		let shape = ml_array_of_shape(source.values[0], degree + 1);
		if (ml_typeof(shape) === MLErrorT) return shape;
		shape[degree] = size;
		return shape;
	} else if (ml_is(source, MLArrayT)) {
		return new Array(degree).concat(source.shape);
	} else if (ml_is(source, MLRangeT)) {
		let count = Math.floor((source.max - source.min) / source.step) + 1;
		if (count <= 0) return ml_error("ValueError", "Empty dimension in array");
		return new Array(degree).concat([count]);
	} else {
		return new Array(degree);
	}
}

function ml_array_of_fill(array, source, degree, offset) {
	if (ml_is(source, MLListT)) {
		if (array.degree == degree) return ml_error("ValueError", "Inconsistent depth in array");
		let size = source.length;
		if (size != array.shape[degree]) return ml_error("ValueError", "Inconsistent lengths in array");
		let stride = array.strides[degree];
		for (var i = 0; i < size; ++i) {
			let error = ml_array_of_fill(array, source[i], degree + 1, offset);
			if (error) return error;
			offset += stride;
		}
	} else if (ml_is(source, MLTupleT)) {
		if (array.degree == degree) return ml_error("ValueError", "Inconsistent depth in array");
		let size = source.values.length;
		if (size != array.shape[degree]) return ml_error("ValueError", "Inconsistent lengths in array");
		let stride = array.strides[degree];
		for (var i = 0; i < size; ++i) {
			let error = ml_array_of_fill(array, source.values[i], degree + 1, offset);
			if (error) return error;
			offset += stride;
		}
	} else if (ml_is(source, MLArrayT)) {
		if (array.degree == degree) return ml_error("ValueError", "Inconsistent depth in array");
		if (source.degree !== array.degree - degree) return ml_error("ArrayError", "Incompatible assignment");
		for (let i = 0; i < source.degree; ++i) {
			if (source.shape[i] !== array.degree[degree + i]) return ml_error("ArrayError", "Incompatible assignment");
		}
		ml_array_copy(array, offset, source, source.offset, 0);
	} else if (ml_is(source, MLRangeT)) {
		if (array.degree == degree) return ml_error("ValueError", "Inconsistent depth in array");
		let step = source.step;
		let count = Math.floor((source.max - source.min) / step) + 1;
		if (count !== array.shape[degree]) return ml_error("ValueError", "Inconsistent lengths in array");
		let values = array.values;
		let stride = array.strides[degree];
		if (source.step > 0) {
			for (let value = source.min; value <= source.max; value += step) {
				values[offset] = value;
				offset += stride;
			}
		} else if (source.step < 0) {
			for (let value = source.min; value >= source.max; value += step) {
				values[offset] = value;
				offset += stride;
			}
		}
	} else {
		console.log(array, offset, source);
		array.values[offset] = source;
	}
	return null;
}

ml_method_define(MLArrayT, [MLAnyT], false, function(caller, args) {
	let type = ml_array_of_type(args[0], MLArrayT.exports.float64);
	let shape = ml_array_of_shape(args[0], 0);
	let array = ml_array(type, shape);
	let error = ml_array_of_fill(array, args[0], 0, 0);
	ml_resume(caller, error || array);
});

ml_method_define("[]", [MLArrayT], true, function(caller, args) {
	let array = args[0], j = 0;
	let shape = [], strides = [], offset = array.offset;
	for (let i = 1; i < args.length; ++i) {
		let index = args[i];
		if (index == null) {
			shape.push(array.shape[j]);
			strides.push(array.strides[j]);
			j += 1;
		} else if (ml_is(index, MLNumberT)) {
			if (index <= 0) index += array.shape[j] + 1;
			if (index < 1 || index > array.shape[j]) return ml_resume(caller, null);
			offset += (index - 1) * array.strides[j];
			j += 1;
		} else if (ml_is(index, MLRangeT)) {
			let min = index.min, max = index.max, step = index.step;
			if (min <= 0) min += array.shape[j] + 1;
			if (min < 1 || min > array.shape[j]) return ml_resume(caller, null);
			if (max <= 0) max += array.shape[j] + 1;
			if (max < 1 || max > array.shape[j]) return ml_resume(caller, null);
			let count = Math.floor((max - min) / step) + 1;
			if (count <= 0) return ml_resume(caller, null);
			shape.push(count);
			strides.push(step * array.strides[j]);
			offset += (min - 1) * array.strides[j];
			j += 1;
		} else {
			return ml_resume(caller, ml_error("TypeError", "Unsupported type for array index"));
		}
	}
	while (j < array.degree) {
		shape.push(array.shape[j]);
		strides.push(array.strides[j]);
		j += 1;
	}
	let degree = shape.length;
	let values = array.values;
	ml_resume(caller, ml_value(ml_typeof(array), {degree, shape, strides, values, offset}));
});

function ml_array_append(buffer, array, degree, offset) {
	if (!array.shape[degree]) {
		buffer.string += "<>";
		return;
	}
	buffer.string += "<";
	let stride = array.strides[degree];
	if (degree === array.degree - 1) {
		let values = array.values;
		buffer.string += values.at(offset).toString();
		for (let i = array.shape[degree]; --i > 0;) {
			buffer.string += " ";
			offset += stride;
			buffer.string += values.at(offset).toString();
		}
	} else {
		ml_array_append(buffer, array, degree + 1, offset);
		for (let i = array.shape[degree]; --i > 0;) {
			buffer.string += " ";
			offset += stride;
			ml_array_append(buffer, array, degree + 1, offset);
		}
	}
	buffer.string += ">";
}

ml_method_define("append", [MLStringBufferT, MLArrayT], false, function(caller, args) {
	let buffer = args[0];
	let array = args[1];
	ml_array_append(buffer, array, 0, array.offset);
	ml_resume(caller, buffer);
});

export const MLTimeT = Globals["time"] = ml_type("time");
Object.defineProperty(Date.prototype, "ml_type", {value: MLTimeT});

ml_method_define(MLTimeT, [], false, function(caller, args) {
	ml_resume(caller, new Date());
});
ml_method_define(MLTimeT, [MLStringT], false, function(caller, args) {
	let result = new Date(args[0]);
	if (isNaN(result)) {
		ml_resume(caller, ml_error("ValueError", "Invalid time string"));
	} else {
		ml_resume(caller, result);
	}
});
ml_method_define("append", [MLStringBufferT, MLTimeT], false, function(caller, args) {
	let buffer = args[0];
	let time = args[1];
	buffer.string += time.toISOString();
	ml_resume(caller, buffer);
});
ml_method_define("+", [MLTimeT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, new Date(args[0].getTime() + args[1] * 1000));
});
ml_method_define("-", [MLTimeT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, new Date(args[0].getTime() - args[1] * 1000));
});
ml_method_define("-", [MLTimeT, MLTimeT], false, function(caller, args) {
	ml_resume(caller, (args[0].getTime() - args[1].getTime()) / 1000);
});
ml_method_define("offset", [MLTimeT], false, function(caller, args) {
	ml_resume(caller, args[0].getTimezoneOffset());
});

export const MLVisitorT = Globals["visitor"] = ml_type("visitor", [], {
	ml_call: function(caller, self, args) {
		let value = ml_deref(args[0]);
		let cache = self.cache;
		if (args.length > 1) {
			let result = ml_deref(args[1]);
			cache.set(value, result);
			return ml_resume(caller, result);
		} else if (cache.has(value)) {
			return ml_resume(caller, cache.get(value));
		} else {
			cache.set(value, self.error);
			return ml_call(caller, self.fn, [self, value]);
		}
	}
});

Globals["copy"] = function(caller, args) {
	let visitor = ml_value(MLVisitorT, {
		cache: new Map(),
		error: ml_error("CallError", "Recursive visit detected"),
		fn: args.length > 1 ? args[1] : ml_method("copy")
	});
	return ml_call(caller, visitor.fn, [visitor, args[0]]);
}

ml_method_define("copy", [MLVisitorT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, args[1]);
});

ml_method_define("copy", [MLVisitorT, MLListT], false, function(caller, args) {
	let visitor = args[0];
	let list = args[1];
	let copy = [];
	visitor.cache.set(list, copy);
	if (!list.length) return ml_resume(caller, copy);
	let index = 0;
	let state = {caller, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(caller, value);
		copy[index++] = value;
		if (index >= list.length) return ml_resume(caller, copy);
		ml_call(state, visitor, [list[index]]);
	}};
	return ml_call(state, visitor, [list[0]]);
});

ml_method_define("copy", [MLVisitorT, MLMapT], false, function(caller, args) {
	let visitor = args[0];
	let map = args[1];
	let copy = ml_map();
	visitor.cache.set(map, copy);
	if (!map.size) return ml_resume(caller, copy);
	let node = map.head;
	let state = {caller, run: function(state, value) {
		if (ml_typeof(value) === MLErrorT) return ml_resume(caller, value);
		ml_map_insert(copy, node.key, value);
		node = node.next;
		if (!node) return ml_resume(caller, copy);
		ml_call(state, visitor, [node.value]);
	}};
	return ml_call(state, visitor, [node.value]);
});

export const XmlT = Globals["xml"] = ml_type("xml", [MLJSObjectT]);

Object.defineProperty(Node.prototype, "ml_type", {value: XmlT});

const XmlElementT = ml_type("xml::element", [MLJSObjectT]);
XmlT.exports["element"] = XmlElementT;
Object.defineProperty(Element.prototype, "ml_type", {value: XmlElementT});

ml_method_define(XmlElementT, [MLStringT], true, function(caller, args) {
	let element = document.createElement(args[0]);
	function append(value) {
		if (ml_is(value, MLMapT)) {
			value.forEach((key, value) => element.setAttribute(key, value));
		} else if (ml_is(value, MLStringT)) {
			element.appendChild(document.createTextNode(value));
		} else if (ml_is(value, XmlElementT)) {
			element.appendChild(value);
		} else {
			value.forEach(append);
		}
	}
	for (let i = 1; i < args.length; ++i) append(args[i]);
	ml_resume(caller, element);
});

ml_method_define("append", [MLStringBufferT, XmlElementT], false, function(caller, args) {
	args[0].string += args[1].outerHTML;
	ml_resume(caller, args[0]);
});

window.Globals = Globals;

function ml_decode_global(globals, name, source, line) {
	let value = globals[name];
	if (value !== undefined) return value;
	let index = name.lastIndexOf("::");
	if (index !== -1) {
		let parent = ml_decode_global(globals, name.substring(0, index), source, line);
		if (parent && parent.exports) {
			return parent.exports[name.substring(index + 2)];
		}
	}
	throw `identifier ${name} not declared at ${source}:${line}`;
	//return ml_uninitialized(name);
}

export function ml_decode(value, globals, _debugger, cache) {
	globals = globals || Globals;
	cache = cache || [];
	switch (typeof(value)) {
	case 'boolean': return value;
	case 'number': return value;
	case 'string': return value;
	case 'object': {
		let tag = value[0];
		if (typeof(tag) === 'number') {
			if (value.length === 1) return cache[tag];
			switch (value[1]) {
			case 'l':
			case 'list': {
				let list = cache[tag] = [];
				for (let i = 2; i < value.length; ++i) list.push(ml_decode(value[i], globals, _debugger, cache));
				return list;
			}
			case 'm':
			case 'map': {
				let map = cache[tag] = ml_map();
				for (let i = 2; i < value.length; i += 2) {
					ml_map_insert(map,
						ml_decode(value[i], globals, _debugger, cache),
						ml_decode(value[i + 1], globals, _debugger, cache)
					);
				}
				return map;
			}
			case 'global': return cache[tag] = ml_global(ml_decode(value[2], globals, _debugger, cache));
			case 'v':
			case 'variable': {
				let variable = cache[tag] = ml_value(MLVariableT, {value: null});
				variable.value = ml_decode(value[2], globals, _debugger, cache);
				return variable;
			}
			case 'z':
			case 'closure': {
				let upvalues = [];
				let closure = cache[tag] = ml_value(MLClosureT, {upvalues, "debugger": _debugger});
				closure.info = ml_decode(value[2], globals, _debugger, cache);
				for (let i = 3; i < value.length; ++i) upvalues.push(ml_decode(value[i], globals, _debugger, cache));
				return closure;
			}
			default: throw `Error decoding value: ${value}`;
			}
		} else {
			switch (tag) {
			case '_':
			case 'blank': return MLBlank;
			case 'some': return MLSome;
			case 'r': case 'regex': {
				let pattern = value[1];
				if (pattern.startsWith("(?i)")) {
					return new RegExp(pattern.substring(4), 'i');
				} else {
					return new RegExp(pattern);
				}
			}
			case ':': case 'method': return ml_method(value[1]);
			case "x": case "tuple": return ml_value(MLTupleT, {values: value.slice(1)});
			case 'l': case 'list': {
				let list = [];
				for (let i = 1; i < value.length; ++i) list.push(ml_decode(value[i], globals, _debugger, cache));
				return list;
			}
			case 'n': case 'names': {
				let names = ml_names();
				for (let i = 1; i < value.length; ++i) names.push(value[i].toString());
				return names;
			}
			case 'm': case 'map': {
				let map = ml_map();
				for (let i = 1; i < value.length; i += 2) {
					ml_map_insert(map, ml_decode(value[i], globals, _debugger, cache), ml_decode(value[i + 1], globals, _debugger, cache));
				}
				return map;
			}
			case 'global': return ml_global(ml_decode(value[1], globals, _debugger, cache));
			case 'v': case 'variable': return ml_value(MLVariableT, {value: ml_decode(value[1], globals, _debugger, cache)});
			case 'z': case 'closure': {
				let closure = ml_closure(ml_decode(value[1], globals, _debugger, cache), [], _debugger);
				for (let i = 2; i < value.length; ++i) {
					closure.upvalues.push(ml_decode(value[i], globals, _debugger, cache));
				}
				return closure;
			}
			case '!': {
				if (value[1] !== ML_BYTECODE_VERSION) throw 'Bytecode version mismatch';
				let code = value[13];
				for (let i = 0; i < code.length; ++i) {
					if (code[i] instanceof Array) code[i] = ml_decode(code[i], globals, _debugger, cache);
				}
				let decls = value[14].map(() => { return {}; });
				for (let i = 0; i < value[14].length; ++i) {
					let decl = value[14][i];
					decls[i] = {name: decl[1], line: decl[2], index: decl[3], flags: decl[4]};
					if (decl[0] >= 0) decls[i].next = decls[decl[0]];
				}
				value[14] = decls;
				return value;
			}
			case '^': return ml_decode_global(globals, value[1], value[2], value[3]);
			case "a": case "array": {
				let array = ml_array(value[1], value[2]);
				if (value[1] === "int64" || value[1] === "uint64") {
					array.values.set(value[3].map(BigInt));
				} else {
					array.values.set(value[3]);
				}
				return array;
			}
			case "o": case "object": {
				let fn = ObjectTypes[value[1]];
				if (!fn) throw `Unknown object type ${value[1]}`;
				let args = [];
				for (let i = 2; i < value.length; ++i) args.push(ml_decode(value[i], globals, _debugger, cache));
				return fn(args);
			}
			case "t": case "type": {
				if (value[1] === "nil") return MLNilT;
				throw `Unknown type ${value[1]}`;
			}
			default: throw `Error decoding value: ${value}`;
			}
		}
	}
	}
}

//let json = ["closure",["!","",0,8,0,0,0,0,[],0,72,[15,0,0,1,51,1,["!","",1,6,1,1,0,0,["N"],0,49,[42,2,0,23,2,2,39,2,2,["method","<"],7,2,18,22,3,1,1,3,42,5,0,43,5,0,10,5,42,5,0,23,5,1,39,5,2,["method","-"],10,5,38,5,1,10,5,39,5,2,["method","*"],1,5,1,7]],0,28,1,-1,23,9,1,23,9,10,39,9,2,["method",".."],33,9,34,9,69,36,9,-1,11,9,23,10,["^","print"],56,10,58,10,"fact(20) = ",42,10,0,23,10,20,38,10,1,10,10,57,10,1,58,10,"\n",59,10,10,10,38,10,1,16,9,1,35,9,23,16,11,1,1,11]]];
//let main = ml_decode(json, Globals, null, []);

//ml_call(EndState, main, []);
