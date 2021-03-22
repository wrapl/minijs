export {
	ml_call, ml_resume, ml_is,
	ml_iterate, ml_iter_next, ml_iter_key, ml_iter_value,
	ml_value, ml_type, ml_method, ml_list, ml_map, ml_tuple,
	ml_stringbuffer, ml_error, ml_error_trace_add,
	ml_method_define, ml_identity, ml_decode, Globals,
	ml_map_insert, ml_map_delete, ml_map_search,
	MLAnyT, MLNil, MLNilT, MLSome, MLSomeT, MLErrorT,
	MLBooleanT, MLNumberT, MLStringT, MLListT, MLMapT,
	MLMethodT, MLTupleT, MLFunctionT, MLIteratableT,
	MLClosureT
};

const Trampolines = [];
const MethodsCache = {};
const Globals = {};

const EndState = {run: function(value) {
	console.log("Result: ", value);
}}

var mlRunning = false;
function ml_exec() {
	function ml_loop() {
		while (Trampolines.length) {
			let trampoline = Trampolines.shift();
			let func = trampoline.shift()
			func.apply(null, trampoline);
		}
		mlRunning = false;
	}
	Trampolines.push(Array.prototype.slice.apply(arguments));
	if (!mlRunning) {
		mlRunning = true;
		setTimeout(ml_loop);
	}
}

function ml_resume(state, value) {
	ml_exec(state.run.bind(state), value);
}
function ml_call(caller, value, args) {
	caller = caller || EndState;
	ml_exec(value.invoke.bind(value), caller, args);
}
function ml_iterate(caller, value) {
	ml_exec(value.iterate.bind(value), caller);
}
function ml_iter_next(caller, value) {
	ml_exec(value.iter_next.bind(value), caller);
}
function ml_iter_key(caller, value) {
	ml_exec(value.iter_key.bind(value), caller);
}
function ml_iter_value(caller, value) {
	ml_exec(value.iter_value.bind(value), caller);
}

const DefaultMethods = {
	hash: function() { return this.type.name; },
	deref: function() { return this; },
	assign: function(value) {},
	invoke: function(caller, args) {}
};

const MLTypeT = {
	name: "type",
	parents: [],
	prototype: {},
	rank: 2,
	hash: function() {},
	deref: function() { return this; },
	assign: function(value) {},
	invoke: function(caller, args) {}
};
MLTypeT.type = MLTypeT;
MLTypeT.prototype.type = MLTypeT;
MLTypeT.prototype.deref = DefaultMethods.deref;
MLTypeT.prototype.invoke = function(caller, args) {
	return ml_call(caller, this.of, args);
}
MLTypeT.of = function(caller, args) {
	ml_resume(caller, args[0].type);
}

function ml_type(name, parents, methods) {
	parents = parents || [];
	if (name !== 'any') parents.push(MLAnyT);
	const type = Object.create(MLTypeT.prototype);
	type.name = name;
	type.parents = parents;
	var rank = 0;
	for (var i = 0; i < parents.length; ++i) {
		rank = Math.max(rank, parents[i].rank);
	}
	type.rank = rank + 1;
	type.parents.unshift(type);
	type.prototype = Object.assign({type}, DefaultMethods, methods);
	Globals[name] = type;
	return type;
}

function ml_value(type, fields) {
	return Object.assign(Object.create(type.prototype), fields);
}

function ml_is(value, type) {
	if (value.type === type) return true;
	if (value.type.parents.indexOf(type) > -1) return true;
	if (type === MLAnyT) return true;
	return false;
}

const MLAnyT = ml_type("any");

function ml_identity(caller, args) {
	ml_resume(caller, args[0]);
}

const MLFunctionT = ml_type("function");
const MLIteratableT = ml_type("iteratable");

const MLNilT = ml_type("nil");
const MLNil = ml_value(MLNilT);

const MLSomeT = ml_type("some");
const MLSome = ml_value(MLSomeT);

const MLErrorT = ml_type("error");
function ml_error(short, message) {
	return ml_value(MLErrorT, {short, message, stack: []});
}
function ml_error_trace_add(error, source, line) {
	error.stack.push([source, line]);
}

const MLMethodT = ml_type("method", [MLFunctionT], {
	hash: function() { return ":" + this.name; },
	invoke: ml_method_invoke
});
function ml_method(name) {
	if (name === null) return ml_value(MLMethodT, {name});
	let value = MethodsCache[name];
	if (value) return value;
	return (MethodsCache[name] = ml_value(MLMethodT, {
		name,
		definitions: [],
		signatures: {}
	})); 
}
function ml_method_invoke(caller, args) {
	var signature = "";
	for (var i = 0; i < args.length; ++i) {
		args[i] = args[i].deref();
		signature += "/" + args[i].type.name;
	}
	var func = this.signatures[signature];
	if (!func) {
		var bestScore = 0;
		var bestFunc = null;
		let count = args.length;
		for (var i = 0; i < this.definitions.length; ++i) {
			let definition = this.definitions[i];
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
			for (var i = 0; i < args.length; ++i) signature += ", " + args[i].type.name;
			signature = signature.substring(2);
			return ml_resume(caller, ml_error("MethodError", `no method found for ${this.name}(${signature})`));
		}
		func = this.signatures[signature] = bestFunc;
	}
	return ml_call(caller, func, args);
	
	function score_definition(types, args) {
		var score = 0;
		for (var i = 0; i < types.length; ++i) {
			let type = types[i];
			if (args[i].type.parents.indexOf(type) === -1) return -1;
			score += type.rank;
		}
		return score;
	}
}
function ml_method_define(method, types, variadic, func) {
	if (typeof(method) === 'string') method = ml_method(method);
	let count = types.length;
	method.definitions.push({count, types, variadic, func});
	method.signatures = {};
}

const MLBooleanT = ml_type("boolean", [], {
	hash: function() { return this.toString(); }
});
MLBooleanT.of = ml_method("number::of");
Boolean.prototype.type = MLBooleanT;
Boolean.prototype.deref = DefaultMethods.deref;

const MLNumberT = ml_type("number", [MLFunctionT]);
MLNumberT.of = ml_method("number::of");
Number.prototype.type = MLNumberT;
Number.prototype.hash = function() { return this.toString(); };
Number.prototype.deref = function() { return +this; };
Number.prototype.invoke = function(caller, args) {
	var index = this - 1;
	if (index < 0) index += args.length + 1;
	if (index < 0) {	
		ml_resume(caller, MLNil);
	} else if (index >= args.length) {
		ml_resume(caller, MLNil);
	} else {
		ml_resume(caller, args[index]);
	}
}

const MLRangeIterT = ml_type("range-iter");
MLRangeIterT.prototype.iter_next = function(caller) {
	this.value += 1;
	if (this.value > this.max) {
		ml_resume(caller, MLNil);
	} else {
		this.key += 1;
		ml_resume(caller, this);
	}
}
MLRangeIterT.prototype.iter_key = function(caller) {
	ml_resume(caller, this.key);
}
MLRangeIterT.prototype.iter_value = function(caller) {
	ml_resume(caller, this.value);
}
const MLRangeT = ml_type("range", [MLIteratableT]);
MLRangeT.prototype.iterate = function(caller) {
	ml_resume(caller, ml_value(MLRangeIterT, {max: this.max, key: 1, value: this.min}));
}

const MLStringT = ml_type("string", [MLIteratableT], {
	hash: function() { return this; }
});
MLStringT.of = ml_method("string::of");
String.prototype.type = MLStringT;
String.prototype.deref = DefaultMethods.deref;

const MLJFunctionT = ml_type("function");
Function.prototype.type = MLJFunctionT;
Function.prototype.deref = DefaultMethods.deref;
Function.prototype.invoke = function(caller, args) {
	for (var i = 0; i < args.length; ++i) args[i] = args[i].deref();
	this(caller, args);
}

const MLPartialFunctionT = ml_type("partial-function", [MLFunctionT], {
	invoke: function(caller, args) {
		let count = args.length;
		var combinedCount = count + this.set;
		if (combinedCount < this.count) combinedCount = this.count;
		let combinedArgs = new Array(combinedCount);
		var i = 0, j = 0;
		for (; i < this.count; ++i) {
			let arg = this.args[i];
			if (arg !== undefined) {
				combinedArgs[i] = arg;
			} else {
				combinedArgs[i] = (j < count) ? args[j++] : MLNil;
			} 
		}
		for (; i < combinedCount; ++i) {
			combinedArgs[i] = (j < count) ? args[j++] : MLNil;
		}
		ml_call(caller, this.func, combinedArgs);
	}
});
function ml_partial_function(func, count) {
	return ml_value(MLPartialFunctionT, {func, count: 0, set: 0, args: new Array(count)});
}
function ml_partial_function_set(partial, index, value) {
	partial.set += 1;
	if (partial.count < index + 1) partial.count = index + 1;
	partial.args[index] = value;
}

const soloMethod = ml_method("->");
const duoMethod = ml_method("=>");
const filterSoloMethod = ml_method("->?");
const filterDuoMethod = ml_method("=>?");

const MLChainedFunctionT = ml_type("chained-function", [MLFunctionT, MLIteratableT], {
	invoke: function(caller, args) {}
});
const MLChainedStateT = ml_type("chained-state");
function ml_chained_iterator_next(value) {
	if (value.type === MLErrorT) return ml_resume(this.caller, value);
	if (value === MLNil) return ml_resume(this.caller, value);
	this.run = ml_chained_iterator_key;
	this.index = 1;
	this.iter = value;
	ml_iter_key(this, value);
}
function ml_chained_iterator_key(value) {
	if (value.type === MLErrorT) return ml_resume(this.caller, value);
	this.key = value;
	this.run = ml_chained_iterator_value;
	ml_iter_value(this, this.iter);
}
function ml_chained_iterator_filter(value) {
	value = value.deref();
	if (value.type === MLErrorT) return ml_resume(this.caller, value);
	if (value === MLNil) {
		this.run = ml_chained_iterator_next;
		ml_iter_next(this, this.iter);
	} else {
		this.next(value);
	}
}
function ml_chained_iterator_duo_key(value) {
	value = value.deref();
	if (value.type === MLErrorT) return ml_resume(this.caller, value);
	let func = this.entries[this.index++];
	if (func === undefined) return ml_resume(this.caller, ml_error("StateError", "Missing value function for chain"));
	this.run = ml_chained_iterator_value;
	let args = [this.key, this.value];
	this.key = value;
	ml_call(this, func, args);
}
function ml_chained_iterator_value(value) {
	value = value.deref();
	if (value.type === MLErrorT) return ml_resume(this.caller, value);
	this.next(value);
}
MLChainedFunctionT.prototype.iterate = function(caller) {
	let state = ml_value(MLChainedStateT, {caller,
		run: ml_chained_iterator_next,
		entries: this.entries,
		next: function(value) {
			this.value = value;
			let func = this.entries[this.index++];
			if (func === undefined) return ml_resume(this.caller, this);
			if (func === soloMethod) {
				func = this.entries[this.index++];
				if (func === undefined) return ml_resume(this.caller, ml_error("StateError", "Missing value function for chain"));
				this.run = ml_chained_iterator_value;
				ml_call(this, func, [value]);
			} else if (func === duoMethod) {
				func = this.entries[this.index++];
				if (func === undefined) return ml_resume(this.caller, ml_error("StateError", "Missing value function for chain"));
				this.run = ml_chained_iterator_duo_key;
				ml_call(this, func, [this.key, value]);
			} else if (func === filterSoloMethod) {
				func = this.entries[this.index++];
				if (func === undefined) return ml_resume(this.caller, ml_error("StateError", "Missing value function for chain"));
				this.run = ml_chained_iterator_filter;
				ml_call(this, func, [value]);
			} else if (func === filterDuoMethod) {
				func = this.entries[this.index++];
				if (func === undefined) return ml_resume(this.caller, ml_error("StateError", "Missing value function for chain"));
				this.run = ml_chained_iterator_filter;
				ml_call(this, func, [this.key, value]);
			} else {
				this.run = ml_chained_iterator_value;
				ml_call(this, func, [value]);
			}
		}
	});
	ml_iterate(state, this.entries[0]);
}
MLChainedStateT.prototype.iter_next = function(caller) {
	this.run = ml_chained_iterator_next;
	ml_iter_next(this, this.iter);
}
MLChainedStateT.prototype.iter_key = function(caller) {
	ml_resume(caller, this.key);
}
MLChainedStateT.prototype.iter_value = function(caller) {
	ml_resume(caller, this.value);
}
function ml_chained(entries) {
	if (entries.length === 1) return entries[0];
	return ml_value(MLChainedFunctionT, {entries});
}

const MLTupleT = ml_type("tuple");
function ml_tuple(size) {
	return ml_value(MLTupleT, {values: new Array(size)});
}

const MLListNodeT = ml_type("list-node", [], {
	deref: function() { return this.list[this.index]; },
	assign: function(value) { return this.list[this.index] = value; } 
});
MLListNodeT.prototype.iter_next = function(caller) {
	let list = this.list;
	let index = this.index + 1;
	if (index >= list.length) return ml_resume(caller, MLNil);
	ml_resume(caller, ml_value(MLListNodeT, {list, index}));
}
MLListNodeT.prototype.iter_key = function(caller) {
	ml_resume(caller, this.index + 1);
}
MLListNodeT.prototype.iter_value = function(caller) {
	ml_resume(caller, this);
}
const MLListT = ml_type("list", [MLIteratableT]);
MLListT.of = ml_method("list::of");
MLListT.prototype.iterate = function(caller) {
	if (!this.length) return ml_resume(caller, MLNil);
	ml_resume(caller, ml_value(MLListNodeT, {list: this, index: 0}));
}
Array.prototype.type = MLListT;
Array.prototype.deref = DefaultMethods.deref;
function ml_list() {
	return [];
}

const MLMapNodeT = ml_type("map-node", [], {
	deref: function() { return this.value; },
	assign: function(value) { return this.value = value; }
});
MLMapNodeT.prototype.iter_next = function(caller) {
	ml_resume(caller, this.next || MLNil);
}
MLMapNodeT.prototype.iter_key = function(caller) {
	ml_resume(caller, this.key);
}
MLMapNodeT.prototype.iter_value = function(caller) {
	ml_resume(caller, this);
}
const MLMapT = ml_type("map", [MLIteratableT]);
MLMapT.of = ml_method("map::of");
MLMapT.prototype.iterate = function(caller) {
	ml_resume(caller, this.head || MLNil);
}
function ml_map() {
	return ml_value(MLMapT, {nodes: {}, size: 0, head: null, tail: null});
}
function ml_map_insert(map, key, value) {
	let hash = key.hash();
	var nodes = map.nodes[hash];
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
		for (var i = 0; i < nodes.length; ++i) {
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
	return MLNil;
}
function ml_map_delete(map, key) {
	let hash = key.hash();
	let nodes = this.nodes[hash];
	if (nodes) for (var i = 0; i < nodes.length; ++i) {
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
	return MLNil;
}
function ml_map_search(map, key) {
	let hash = key.hash();
	let nodes = this.nodes[hash];
	if (nodes) for (var i = 0; i < nodes.length; ++i) {
		let node = nodes[i];
		if (node.key === key) return node;
	}
	return null;
}
const MLMapIndexT = ml_type("map-index", [], {
	deref: function() { return MLNil; },
	assign: function(value) {
		ml_map_insert(this.map, this.key, value);
		return value;
	}
});

const MLVariableT = ml_type("variable", [], {
	deref: function() { return this.value; },
	assign: function(value) { return this.value = value; }
});

const MLUninitializedT = ml_type("uninitialized", [], {
	assign: function(value) {}
});
function ml_uninitialized(name) {
	return ml_value(MLUninitializedT, {name, uses: []});
}
function ml_uninitialized_use(uninitialized, target, index) {
	uninitialized.uses.push([target, index]);
}
function ml_uninitialized_set(uninitialized, value) {
	let uses = uninitialized.uses;
	for (var i = 0; i < uses.length; ++i) {
		let use = uses[i];
		use[0][use[1]] = value;
	}
}

const MLStringBufferT = ml_type("stringbuffer");
MLStringBufferT.prototype.add = function(string) {
	this.string += string;
	return this;
}
function ml_stringbuffer() {
	return ml_value(MLStringBufferT, {string: ""});
}
let appendMethod = ml_method("append");

const MLGlobalT = ml_type("global", [], {
	invoke: function(caller, args) {
		ml_call(caller, this.value, args);
	}
});
function ml_global(value) {
	return ml_value(MLGlobalT, {value});
}

const MLFrameT = ml_type("frame", [MLFunctionT], {
});

const MLClosureT = ml_type("closure", [MLFunctionT], {
	invoke: ml_closure_invoke
});
function ml_closure(info, upvalues) {
	return ml_value(MLClosureT, {info, upvalues});
}
function ml_closure_invoke(caller, args) {
	let info = this.info;
	let stack = [];
	let frame = ml_value(MLFrameT, {
		caller,
		run: ml_frame_run,
		source: info[1],
		line: info[2],
		ip: info[9],
		ep: info[10],
		code: info[11],
		stack,
		upvalues: this.upvalues
	});
	for (var i = 0; i < info[4]; ++i) {
		stack.push(args[i] || MLNil);
	}
	ml_resume(frame, MLNil);
}
function ml_frame_run(result) {
	var ip = this.ip;
	if (result.type === MLErrorT) {
		ml_error_trace_add(result, this.source, this.line);
		ip = this.ep;
	}
	let code = this.code;
	let stack = this.stack;
	for (;;) switch (code[ip]) {
	case 1: //MLI_RETURN,
		return ml_resume(this.caller, result);
	case 2: //MLI_SUSPEND,
		this.line = code[ip + 1];
		return ml_resume(this.	caller, this);
	case 3: //MLI_RESUME,
		stack.pop();
		stack.pop();
		ip += 2;
		break;
	case 4: //MLI_NIL,
		result = MLNil;
		ip += 2;
		break;
	case 5: //MLI_NIL_PUSH,
		result = MLNil;
		stack.push(result = MLNil);
		ip += 2;
		break;
	case 6: //MLI_SOME,
		result = MLSome;
		ip += 2;
		break;
	case 7: //MLI_AND,
		if (result.deref() === MLNil) {
			ip = code[ip + 2];
		} else {
			ip += 3;
		}
		break;
	case 8: //MLI_OR,
		if (result.deref() !== MLNil) {
			ip = code[ip + 2];
		} else {
			ip += 3;
		}
		break;
	case 9: //MLI_NOT,
		if (result.deref() === MLNil) {
			result = MLSome;
		} else {
			result = MLNil;
		}
		break;
	case 10: //MLI_PUSH,
		stack.push(result);
		ip += 2;
		break;
	case 11: //MLI_WITH,
		stack.push(result);
		ip += 2;
		break;
	case 12: { //MLI_WITH_VAR,
		let variable = ml_value(MLVariableT, {value: result});
		stack.push(variable);
		ip += 3;
		break;
	}
	case 13: { //MLI_WITHX,
		let packed = result;
		let count = code[ip + 2];
		for (var i = 0; i < count; ++i) {
			result = ml_unpack(packed, i + 1);
			stack.push(result);
		}
		ip += 4;
		break;
	}
	case 14: //MLI_POP,
		result = stack.pop();
		ip += 2;
		break;
	case 15: //MLI_ENTER,
		for (var i = code[ip + 2]; --i >= 0;) {
			let variable = ml_value(MLVariableT, {value: MLNil});
			stack.push(variable);
		}
		for (var i = code[ip + 3]; --i >= 0;) {
			stack.push(null);
		}
		ip += 4;
		break;
	case 16: //MLI_EXIT,
		for (var i = code[ip + 2]; --i >= 0;) stack.pop();
		ip += 3;
		break;
	case 17: //MLI_GOTO,
		ip = code[ip + 2];
		break;
	case 18: //MLI_TRY,
		this.ep = code[ip + 2];
		ip += 3;
		break;
	case 19: //MLI_CATCH_TYPE,
		if (result.type !== MLErrorT) {
			result = ml_error("InternalError", `expected error, not ${result.type.name}`);
			ml_error_trace_add(result, this.source, code[ip + 1]);
			ip = this.ep;
		} else {
			if (code[ip + 3].indexOf(result.type) === -1) {
				ip = code[ip + 2];
			} else {
				ip += 4;
			}
		}
		break;
	case 20: //MLI_CATCH,
		if (result.type !== MLErrorT) {
			result = ml_error("InternalError", `expected error, not ${result.type.name}`);
			ml_error_trace_add(result, this.source, code[ip + 1]);
			ip = this.ep;
		} else {
			result = ml_error_value(result);
			let top = code[ip + 2];
			while (stack.length > top) stack.pop();
			stack.push(result);
			ip += 3;
		}
		break;
	case 21: //MLI_RETRY,
		ip = this.ep;
		break;
	case 22: //MLI_LOAD,
		result = code[ip + 2];
		ip += 3;
		break;
	case 23: //MLI_LOAD_PUSH,
		stack.push(result = code[ip + 2]);
		ip += 3;
		break;
	case 24: //MLI_VAR,
		result = result.deref();
		stack[stack.length + code[ip + 2]].value = result;
		ip += 3;
		break;
	case 25: //MLI_VAR_TYPE,
		ip += 3;
		break;
	case 26: //MLI_VARX,
		break;
	case 27: //MLI_LET,
		result = result.deref();
		stack[stack.length + code[ip + 2]] = result;
		ip += 3;
		break;
	case 28: {//MLI_LETI,
		result = result.deref();
		let index = stack.length + code[ip + 2];
		let uninitialized = stack[index];
		if (uninitialized !== null) {
			ml_uninitialized_set(uninitialized, result);
		}
		stack[index] = result;
		ip += 3;
		break;
	}
	case 29: //MLI_LETX,
	case 30: //MLI_REF,
	case 31: //MLI_REFI,
	case 32: //MLI_REFX,
	case 33: //MLI_FOR,
		result = result.deref();
		this.line = code[ip + 1];
		this.ip = ip + 2;
		return ml_iterate(this, result);
	case 34: //MLI_ITER,
		if (result === MLNil) {
			ip = code[ip + 2];
		} else {
			stack.push(result);
			ip += 3;
		}
		break;
	case 35: //MLI_NEXT,
		result = stack.pop();
		this.line = code[ip + 1];
		this.ip = code[ip + 2];
		return ml_iter_next(this, result);
	case 36: //MLI_VALUE,
		result = stack[stack.length + code[ip + 2]];
		this.line = code[ip + 1];
		this.ip = ip + 3;
		return ml_iter_value(this, result);
	case 37: //MLI_KEY,
		result = stack[stack.length + code[ip + 2]];
		this.line = code[ip + 1];
		this.ip = ip + 3;
		return ml_iter_key(this, result);
	case 38: {//MLI_CALL,
		let count = code[ip + 2];
		let args = stack.splice(stack.length - count, count);
		let func = stack.pop();
		let next = ip + 3;
		if (code[next] === 1) { // MLI_RETURN
			return ml_call(this.caller, func, args);
		} else {
			this.ip = next;
			this.line = code[ip + 1];
			return ml_call(this, func, args);
		}
	}
	case 39: {//MLI_CONST_CALL,
		let count = code[ip + 2];
		let args = stack.splice(stack.length - count, count);
		let func = code[ip + 3];
		let next = ip + 4;
		if (code[next] === 1) { // MLI_RETURN
			return ml_call(this.caller, func, args);
		} else {
			this.ip = next;
			this.line = code[ip + 1];
			return ml_call(this, func, args);
		}
	}
	case 40: //MLI_ASSIGN,
		result = result.deref();
		result = stack.pop().assign(result);
		if (result.type === MLErrorT) {
			ip = this.ep;
		} else {
			ip += 2;
		}
		break;
	case 41: //MLI_LOCAL,
		result = stack[code[ip + 2]];
		ip += 3;
		break;
	case 42: //MLI_LOCAL_PUSH,
		stack.push(result = stack[code[ip + 2]]);
		ip += 3;
		break;
	case 43: //MLI_UPVALUE,
		result = this.upvalues[code[ip + 2]];
		ip += 3;
		break;
	case 44: {//MLI_LOCALX,
		let index = code[ip + 2];
		result = stack[index];
		if (result === null) {
			result = stack[index] = ml_uninitialized("let");
		}
		ip += 3;
		break;
	}
	case 45: //MLI_TUPLE_NEW,
		stack.push(ml_tuple(code[ip + 2]));
		ip += 3;
		break;
	case 46: //MLI_TUPLE_SET,
		stack[stack.length - 1].values[code[ip + 2]] = result;
		ip += 3;
		break;
	case 47: //MLI_LIST_NEW,
		stack.push([]);
		ip += 2;
		break;
	case 48: //MLI_LIST_APPEND,
		stack[stack.length - 1].push(result.deref());
		ip += 2;
		break;
	case 49: //MLI_MAP_NEW,
		stack.push(ml_map());
		ip += 2;
		break;
	case 50: {//MLI_MAP_INSERT,
		let key = stack.pop();
		stack[stack.length - 1].insert(key, result.deref());
		ip += 2;
		break;
	}
	case 51:
	case 52: {//MLI_CLOSURE, MLI_CLOSURE_TYPED,
		let info = code[ip + 2];
		let upvalues = [];
		for (var i = 0; i < info[5]; ++i) {
			let index = code[ip + 3 + i];
			var value;
			if (index < 0) {
				value = this.upvalues[~index];
				if (value === null) {
					value = this.upvalues[~index] = ml_uninitialized("<upvalue>");
				}
			} else {
				value = stack[index];
				if (value === null) {
					value = stack[index] = ml_uninitialized("<upvalue>");
				}
			}
			if (value.type === MLUninitializedT) ml_uninitialized_use(value, upvalues, i);
			upvalues[i] = value;
		}
		result = ml_closure(info, upvalues);
		ip += 3 + upvalues.length;
		break;
	}
	case 53: //MLI_PARAM_TYPE,
		ip += 4;
		break;
	case 54: //MLI_PARTIAL_NEW,
		result = result.deref();
		stack.push(ml_partial_function(result, code[ip + 2]));
		ip += 3;
		break;
	case 55: //MLI_PARTIAL_SET,
		result = result.deref();
		ml_partial_function_set(stack[stack.length - 1], code[ip + 2], result);
		ip += 3;
		break;
	case 56: //MLI_STRING_NEW,
		stack.push(ml_stringbuffer());
		ip += 2;
		break;
	case 57: {//MLI_STRING_ADD,
		let count = code[ip + 2] + 1;
		let args = stack.splice(stack.length - count, count);
		stack.push(args[0]);
		this.line = code[ip + 1];
		this.ip = ip + 3;
		return ml_call(this, appendMethod, args);
	}
	case 58: //MLI_STRING_ADDS,
		stack[stack.length - 1].add(code[ip + 2]);
		ip += 3;
		break;
	case 59: //MLI_STRING_END,
		result = stack.pop().string;
		ip += 2;
		break;
	case 60: //MLI_RESOLVE,
		break;
	case 61: //MLI_IF_DEBUG
		break;
	}
}

Globals.print = function(caller, args) {
	if (args.length === 0) return ml_resume(caller, MLNil);
	let buffer = ml_stringbuffer();
	let state = {caller, index: 1, run: function(value) {
		if (value.type === MLErrorT) return ml_resume(this.caller, value);
		if (this.index === args.length) {
			console.log(value.string);
			return ml_resume(this.caller, MLNil);
		}
		ml_call(this, appendMethod, [value, args[this.index++]]);
	}};
	ml_call(state, appendMethod, [buffer, args[0]]);
}

Globals.count = function(caller, args) {
	let state = {caller, count: 0, run: function(value) {
		if (value.type === MLErrorT) {
			ml_resume(this.caller, value);
		} else if (value === MLNil) {
			ml_resume(this.caller, this.count);
		} else {
			this.count++;
			ml_iter_next(this, value);
		}
	}};
	ml_iterate(state, args[0]);
}

ml_method_define("=", [MLAnyT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, args[0] === args[1] ? args[1] : MLNil);
});
ml_method_define("!=", [MLAnyT, MLAnyT], false, function(caller, args) {
	ml_resume(caller, args[0] !== args[1] ? args[1] : MLNil);
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

ml_method_define(MLBooleanT.of, [MLBooleanT], false, ml_identity);
ml_method_define("-", [MLBooleanT], false, function(caller, args) {
	ml_resume(caller, !args[0]);
});
ml_method_define("/\\", [MLBooleanT, MLBooleanT], false, function(caller, args) {
	ml_resume(caller, args[0] && args[1]);
});
ml_method_define("\\/", [MLBooleanT, MLBooleanT], false, function(caller, args) {
	ml_resume(caller, args[0] || args[1]);
});

ml_method_define(MLNumberT.of, [MLNumberT], false, ml_identity);
ml_method_define(MLNumberT.of, [MLStringT], false, function(caller, args) {
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
	ml_resume(caller, args[0] < args[1] ? args[1] : MLNil);
});
ml_method_define(">", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] > args[1] ? args[1] : MLNil);
});
ml_method_define("<=", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] <= args[1] ? args[1] : MLNil);
});
ml_method_define(">=", [MLNumberT, MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0] >= args[1] ? args[1] : MLNil);
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
	var value = args[1];
	if (value !== Math.floor(value)) {
		return ml_resume(caller, ml_error("UnsupportedError", "Base conversions of reals not supported yet"));
	}
	var string = "";
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

ml_method_define(MLStringT.of, [MLStringT], false, ml_identity);
ml_method_define(MLStringT.of, [MLAnyT], false, function(caller, args) {
	let buffer = ml_stringbuffer();
	let state = {caller, run: function(value) {
		if (value.type === MLErrorT) return ml_resume(this.caller, value);
		ml_resume(this.caller, value.string);
	}};
	ml_call(state, appendMethod, [buffer, args[0]]);
});
ml_method_define(MLStringT.of, [MLNilT], false, function(caller, args) {
	ml_resume(caller, "nil");
});
ml_method_define(MLStringT.of, [MLSomeT], false, function(caller, args) {
	ml_resume(caller, "some");
});
ml_method_define(MLStringT.of, [MLBooleanT], false, function(caller, args) {
	ml_resume(caller, args[0] ? "true" : "false");
});
ml_method_define(MLStringT.of, [MLNumberT], false, function(caller, args) {
	ml_resume(caller, args[0].toString());
});
ml_method_define(MLStringT.of, [MLNumberT, MLNumberT], false, function(caller, args) {
	let base = args[1];
	if (base < 2 || base > 36 || base !== Math.floor(base)) {
		return ml_resume(caller, ml_error("RangeError", "Invalid base"));
	}
	var value = args[0];
	if (value !== Math.floor(value)) {
		return ml_resume(caller, ml_error("UnsupportedError", "Base conversions of reals not supported yet"));
	}
	var string = "";
	var prefix = "";
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
		ml_resume(caller, MLNil);
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
		ml_resume(caller, MLNil);
	} else if (end > string.length) {
		ml_resume(caller, MLNil);
	} else if (end < start) {
		ml_resume(caller, MLNil);
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
ml_method_define("append", [MLStringBufferT, MLStringT], false, function(caller, args) {
	args[0].string += args[1];
	ml_resume(caller, args[0]);
});

ml_method_define(MLListT.of, [MLIteratableT], true, function(caller, args) {
	let list = [];
	let state = {caller, list, run: iter_next};
	ml_iterate(state, args[0]);
	function iter_next(value) {
		if (value.type === MLErrorT) {
			ml_resume(this.caller, value);
		} else if (value === MLNil) {
			ml_resume(this.caller, this.list);
		} else {
			this.iter = value;
			this.run = iter_value;
			ml_iter_value(this, value);
		}
	}
	function iter_value(value) {
		value = value.deref();
		if (value.type === MLErrorT) {
			ml_resume(this.caller, value);
		} else {
			this.list.push(value);
			this.run = iter_next;
			ml_iter_next(this, this.iter);
		}
	}
});
ml_method_define("[]", [MLListT, MLNumberT], false, function(caller, args) {
	let list = args[0];
	var index = args[1] - 1;
	if (index < 0) index += list.length + 1;
	if (index < 0 || index >= list.length) return MLNil;
	ml_resume(caller, ml_value(MLListNodeT, {list, index}));
});
ml_method_define("push", [MLListT, MLAnyT], true, function(caller, args) {
	let list = args[0];
	for (var i = 1; i < args.length; ++i) list.unshift(args[i]);
	ml_resume(caller, list);
});
ml_method_define("put", [MLListT, MLAnyT], true, function(caller, args) {
	let list = args[0];
	for (var i = 1; i < args.length; ++i) list.push(args[i]);
	ml_resume(caller, list);
});
ml_method_define("pop", [MLListT], false, function(caller, args) {
	let list = args[0];
	ml_resume(caller, list.length ? list.shift() : MLNil);
});
ml_method_define("pull", [MLListT], false, function(caller, args) {
	let list = args[0];
	ml_resume(caller, list.length ? list.pop() : MLNil);
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
	if (!list.length) return ml_resume(caller, "[]");
	let state = {caller, list, index: 1, run: function(value) {
		if (value.type === MLErrorT) return ml_resume(this.caller, value);
		let list = this.list;
		if (this.index == list.length) {
			value.string += "]";
			ml_resume(this.caller, value);
		} else {
			value.string += ", ";
			ml_call(state, appendMethod, [value, list[this.index++]]);
		}
	}};
	buffer.string += "[";
	ml_call(state, appendMethod, [buffer, list[0]]);
});

ml_method_define(MLMapT.of, [MLIteratableT], true, function(caller, args) {
	let map = ml_map();
	let state = {caller, map, run: iter_next};
	ml_iterate(state, args[0]);
	function iter_next(value) {
		if (value.type === MLErrorT) {
			ml_resume(this.caller, value);
		} else if (value === MLNil) {
			ml_resume(this.caller, this.map);
		} else {
			this.iter = value;
			this.run = iter_key;
			ml_iter_key(this, value);
		}
	}
	function iter_key(value) {
		value = value.deref();
		if (value.type === MLErrorT) {
			ml_resume(this.caller, value);
		} else {
			this.key = value;
			this.run = iter_value;
			ml_iter_value(this, this.iter);
		}
	}
	function iter_value(value) {
		value = value.deref();
		if (value.type === MLErrorT) {
			ml_resume(this.caller, value);
		} else {
			ml_map_insert(this.map, this.key, value);
			this.run = iter_next;
			ml_iter_next(this, this.iter);
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
	if (!node) return ml_resume(caller, "{}");
	let state = {caller, node, key: true, run: function(value) {
		if (value.type === MLErrorT) return ml_resume(this.caller, value);
		if (this.key) {
			value.string += " is ";
			this.key = false;
			ml_call(state, appendMethod, [value, this.node.value]);
		} else {
			let node = this.node.next;
			if (!node) {
				value.string += "}";
				return ml_resume(this.caller, value);
			}
			this.key = true;
			this.node = node;
			value.string += ", ";
			ml_call(state, appendMethod, [value, node.key]);
		}
	}};
	buffer.string += "{";
	ml_call(state, appendMethod, [buffer, node.key]);
});

function ml_decode(value, cache) {
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
				for (var i = 2; i < value.length; ++i) {
					list.push(ml_decode(value[i], cache));
				}
				return list;
			}
			case 'map': {
				let map = cache[value[0]] = ml_map();
				for (var i = 2; i < value.length; i += 2) {
					map.insert(ml_decode(value[i], cache), ml_decode(value[i + 1], cache));
				}
				return map;
			}
			case 'global': return cache[value[0]] = ml_global(ml_decode(value[2], cache));
			case 'closure': {
				let closure = cache[value[0]] = ml_closure(ml_decode(value[2]), []);
				for (var i = 3; i < value.length; ++i) {
					closure.upvalues.push(ml_decode(value[i], cache));
				}
				return closure;
			}
			}
		} else {
			switch (value[0]) {
			case 'method': return ml_method(value[1]);
			case 'list': {
				let list = [];
				for (var i = 1; i < value.length; ++i) {
					list.push(ml_decode(value[i], cache));
				}
				return list;
			}
			case 'map': {
				let map = ml_map();
				for (var i = 1; i < value.length; i += 2) {
					map.insert(ml_decode(value[i], cache), ml_decode(value[i + 1], cache));
				}
				return map;
			}
			case 'global': return ml_global(ml_decode(value[1], cache));
			case 'closure': {
				let closure = ml_closure(ml_decode(value[1]), []);
				for (var i = 2; i < value.length; ++i) {
					closure.upvalues.push(ml_decode(value[i], cache));
				}
				return closure;
			}
			case '!': {
				let code = value[11];
				for (var i = 0; i < code.length; ++i) {
					if (code[i] instanceof Array) code[i] = ml_decode(code[i], cache);
				}
				return value;
			}
			case '^': return Globals[value[1]];
			}
		}
	}
}

//let json = ["closure",["!","",0,8,0,0,0,0,[],0,72,[15,0,0,1,51,1,["!","",1,6,1,1,0,0,["N"],0,49,[42,2,0,23,2,2,39,2,2,["method","<"],7,2,18,22,3,1,1,3,42,5,0,43,5,0,10,5,42,5,0,23,5,1,39,5,2,["method","-"],10,5,38,5,1,10,5,39,5,2,["method","*"],1,5,1,7]],0,28,1,-1,23,9,1,23,9,10,39,9,2,["method",".."],33,9,34,9,69,36,9,-1,11,9,23,10,["^","print"],56,10,58,10,"fact(20) = ",42,10,0,23,10,20,38,10,1,10,10,57,10,1,58,10,"\n",59,10,10,10,38,10,1,16,9,1,35,9,23,16,11,1,1,11]]];
//let main = ml_decode(json, []);

//ml_call(EndState, main, []);
