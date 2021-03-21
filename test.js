let inputElement = document.getElementById("input");
let bytecodeElement = document.getElementById("compiled");
let consoleElement = document.getElementById("console");
let outputElement = document.getElementById("output");
let compileElement = document.getElementById("compile");
let executeElement = document.getElementById("execute");

Globals.print = function(caller, args) {
	if (args.length === 0) return ml_resume(caller, MLNil);
	let state = {caller, index: 1, run: function(value) {
		consoleElement.appendChild(document.createTextNode(value.toString()));
		if (this.index === args.length) return ml_resume(this.caller, MLNil);
		ml_call(this, MLStringT.of, [args[this.index++]]);
	}};
	ml_call(state, MLStringT.of, [args[0]]);
}

compileElement.onclick = function() {
	let request = new XMLHttpRequest();	
	request.onreadystatechange = function() {
		if (request.readyState === XMLHttpRequest.DONE) {
			if (request.status === 200) {
				let json = request.responseText;
				bytecodeElement.textContent = json;
				window.main = ml_decode(JSON.parse(json), []);
			}
		}
	}
	bytecodeElement.textContext = "";
	request.open('POST', '/compile');
	request.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
	request.send('input=' + encodeURIComponent(input.value));
}

executeElement.onclick = function() {
	consoleElement.textContent = "";
	ml_call(EndState, window.main, []);
}