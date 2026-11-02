#!/usr/bin/env node
/**
 * End-to-end demo of the plugin without DSH.
 *
 * Loads `lib/index.js`, registers it on a fake cordis context that only provides
 * `logger`, `on` and `effect`, then plays a session event sequence exactly like
 * the one `@deepseek-ai/dsh-session` emits. Everything else — window lookup,
 * ITaskbarList3, the priority counters, the debounce — is the real plugin code.
 *
 *   node scripts/demo.mjs
 */
import { apply } from '../lib/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @type {Map<string, Array<(...args: any[]) => void>>} */
const listeners = new Map();
/** @type {Array<() => void>} */
const disposers = [];

const ctx = {
	logger: {
		debug: (message) => console.log(`         · ${message}`),
		warn: (message) => console.log(`         ! ${message}`),
		info: (message) => console.log(`         · ${message}`),
	},
	on(event, handler) {
		const bucket = listeners.get(event) ?? [];
		bucket.push(handler);
		listeners.set(event, bucket);
		return () => {
			const current = listeners.get(event) ?? [];
			listeners.set(event, current.filter((entry) => entry !== handler));
		};
	},
	effect(execute) {
		const disposer = execute();
		if (typeof disposer === 'function') disposers.push(disposer);
	},
};

/** @param {string} type @param {unknown} data @param {string} sessionId */
function emit(type, data, sessionId) {
	const session = { id: sessionId };
	for (const handler of listeners.get('session/event') ?? []) handler(session, { type, data });
}

const step = async (label, waitMs) => {
	console.log(`\n=== ${label}`);
	await sleep(waitMs);
};

apply(ctx);
// Let the lazily imported koffi binding settle before the first event.
await sleep(400);

emit('turn/start', { turn: 1 }, 'demo-a');
await step('session demo-a: turn 1 running → expect a grey indeterminate bar', 2500);

emit('approval/asked', { id: 'approval-1', toolName: 'bash' }, 'demo-a');
await step('session demo-a: approval pending → expect amber 100/100 + taskbar flash', 2500);

// A second session must not outrank a pending approval.
emit('turn/start', { turn: 1 }, 'demo-b');
await step('session demo-b: turn 1 also running → the amber approval still wins', 1500);

emit('approval/decided', { id: 'approval-1', outcome: 'allowed-once' }, 'demo-a');
await step('approval decided → back to grey (two turns are still open)', 2000);

// An `ask_user_question` call also blocks on a human: same amber, no approval event.
emit('tool/call', { turn: 1, step: 1, callId: 'question-1', name: 'ask_user_question', arguments: '{}' }, 'demo-b');
await step('session demo-b: ask_user_question open → expect amber 100/100 + flash', 2500);

emit('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'question-1', content: [] } }, 'demo-b');
await step('question answered → back to grey', 1500);

emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 'demo-a');
emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 'demo-b');
await step('both turns completed → expect the bar to disappear', 2000);

emit('turn/start', { turn: 2 }, 'demo-a');
emit('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'demo failure' } } }, 'demo-a');
await step('turn 2 failed (reason.kind === "error") → expect a FULL red bar that stays', 4000);

console.log('\n=== releasing');
for (const dispose of disposers.reverse()) {
	try {
		dispose();
	} catch (error) {
		console.log(`disposer failed: ${error?.message ?? String(error)}`);
	}
}
await sleep(300);
console.log('done — the bar must be cleared now.');
