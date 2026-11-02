/**
 * Priority and counting rules for dsh-taskbar-status.
 *
 * These run without a display: the Win32 side is skipped entirely while the
 * monitor has no koffi binding, so the counters are exercised in isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskbarMonitor, observeSessionEvent, resolveFocusWatch, selectState } from '../lib/index.js';

const silent = { debug() {}, warn() {} };

/** @returns {TaskbarMonitor} a monitor with no Win32 binding attached */
function monitor() {
	return new TaskbarMonitor(silent);
}

/** @param {TaskbarMonitor} target @param {string} type @param {unknown} data @param {string} sessionId */
function feed(target, type, data, sessionId = 'session-a') {
	observeSessionEvent(target, { id: sessionId }, { type, data });
}

test('waiting outranks running, running outranks a latched error', () => {
	const base = { turns: 0, waiting: 0, errorLatched: false };
	assert.equal(selectState(base), 'idle');
	assert.equal(selectState({ ...base, turns: 2 }), 'running');
	assert.equal(selectState({ ...base, waiting: 1 }), 'waiting');
	assert.equal(selectState({ ...base, turns: 1, waiting: 1 }), 'waiting');
	assert.equal(selectState({ ...base, errorLatched: true }), 'error');
	assert.equal(selectState({ ...base, turns: 1, errorLatched: true }), 'running');
	assert.equal(selectState({ ...base, waiting: 1, errorLatched: true }), 'waiting');
});

test('a duplicated turn/start is counted once and turn/end clears it', () => {
	const target = monitor();
	feed(target, 'turn/start', { turn: 1 });
	feed(target, 'turn/start', { turn: 1 });
	assert.equal(target.turns.size, 1);
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
	assert.equal(target.turns.size, 0);
	target.shutdown();
});

test('turns from different sessions accumulate independently', () => {
	const target = monitor();
	feed(target, 'turn/start', { turn: 1 }, 'session-a');
	feed(target, 'turn/start', { turn: 1 }, 'session-b');
	assert.equal(target.turns.size, 2);
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 'session-a');
	assert.equal(target.turns.size, 1);
	target.shutdown();
});

test('approvals are counted by id and removed on decision', () => {
	const target = monitor();
	feed(target, 'approval/asked', { id: 'a1', toolName: 'bash' });
	feed(target, 'approval/asked', { id: 'a1', toolName: 'bash' });
	assert.equal(target.approvals.size, 1);
	feed(target, 'approval/decided', { id: 'a1', outcome: 'allowed-once' });
	assert.equal(target.approvals.size, 0);
	target.shutdown();
});

test('only reason.kind === "error" latches the red state', () => {
	const target = monitor();
	for (const kind of ['completed', 'blocked', 'max-tokens', 'aborted', 'interrupted']) {
		feed(target, 'turn/start', { turn: 1 });
		feed(target, 'turn/end', { turn: 1, reason: { kind } });
		assert.equal(target.errorLatched, false, `${kind} must not show an error`);
	}
	feed(target, 'turn/start', { turn: 2 });
	feed(target, 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN' } } });
	assert.equal(target.errorLatched, true, 'an error must latch');
	assert.equal(
		selectState({ turns: target.turns.size, waiting: target.waitingCount(), errorLatched: target.errorLatched }),
		'error',
	);
	target.shutdown();
});

test('a latched error persists until the next turn starts', () => {
	const target = monitor();
	const readState = () =>
		selectState({ turns: target.turns.size, waiting: target.waitingCount(), errorLatched: target.errorLatched });

	feed(target, 'turn/start', { turn: 1 });
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'TIMEOUT' } } });
	// No timer may clear it: the red bar is an unread notification, not a flash.
	assert.equal(readState(), 'error');

	feed(target, 'approval/asked', { id: 'a1' });
	assert.equal(readState(), 'waiting', 'an approval still outranks the failure');
	feed(target, 'approval/decided', { id: 'a1', outcome: 'rejected' });
	assert.equal(readState(), 'error', 'and the failure is still there afterwards');

	feed(target, 'turn/start', { turn: 2 });
	assert.equal(readState(), 'running');
	feed(target, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
	assert.equal(readState(), 'idle', 'a successful turn acknowledges the failure');
	target.shutdown();
});

test('a pending approval cannot outlive its turn', () => {
	const target = monitor();
	feed(target, 'turn/start', { turn: 3 });
	feed(target, 'approval/asked', { id: 'a1', toolName: 'bash' });
	assert.equal(target.approvals.size, 1);
	// `approval/asked` carries no turn, so the abort path still has to drop it
	// when the turn it belonged to ends without a decision.
	feed(target, 'turn/end', { turn: 3, reason: { kind: 'aborted' } });
	assert.equal(target.turns.size, 0);
	assert.equal(target.approvals.size, 0, 'an undecided approval must not outlive its last open turn');
	target.shutdown();
});

test('session/disposed forgets that session only', () => {
	const target = monitor();
	feed(target, 'turn/start', { turn: 1 }, 'session-a');
	feed(target, 'turn/start', { turn: 1 }, 'session-b');
	feed(target, 'approval/asked', { id: 'a1' }, 'session-a');
	feed(target, 'approval/asked', { id: 'b1' }, 'session-b');
	target.forgetSession('session-a');
	assert.equal(target.turns.size, 1);
	assert.equal(target.approvals.size, 1);
	assert.equal(target.approvals.has('b1'), true);
	target.shutdown();
});

test('unknown or malformed events are ignored instead of throwing', () => {
	const target = monitor();
	assert.doesNotThrow(() => {
		observeSessionEvent(target, undefined, undefined);
		observeSessionEvent(target, { id: 'session-a' }, { type: 'tool/call', data: null });
		observeSessionEvent(target, { id: 'session-a' }, { type: 'turn/end' });
	});
	assert.equal(target.turns.size, 0);
	target.shutdown();
});

test('a failure is acknowledged only after the window was seen in the background', () => {
	// The window was already focused when the turn failed: clearing here would
	// erase the red bar exactly when the user is looking at it.
	assert.deepEqual(resolveFocusWatch({ focusedPid: 100, windowPid: 100, seenBackground: false }), {
		seenBackground: false,
		acknowledge: false,
	});
	// The user switched to something else...
	assert.deepEqual(resolveFocusWatch({ focusedPid: 200, windowPid: 100, seenBackground: false }), {
		seenBackground: true,
		acknowledge: false,
	});
	// ...and came back: that is the acknowledgement.
	assert.deepEqual(resolveFocusWatch({ focusedPid: 100, windowPid: 100, seenBackground: true }), {
		seenBackground: true,
		acknowledge: true,
	});
});

test('an unreadable foreground window or unknown window pid never acknowledges', () => {
	assert.deepEqual(resolveFocusWatch({ focusedPid: 0, windowPid: 100, seenBackground: true }), {
		seenBackground: true,
		acknowledge: false,
	});
	assert.deepEqual(resolveFocusWatch({ focusedPid: 100, windowPid: null, seenBackground: true }), {
		seenBackground: true,
		acknowledge: false,
	});
});

test('a latched failure starts the focus watch and clearing it stops the watch', () => {
	const target = monitor();
	feed(target, 'turn/start', { turn: 1 });
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN' } } });
	assert.equal(target.errorLatched, true);
	// No Win32 binding here, so the timer is the only observable side effect.
	assert.notEqual(target.focusTimer, null, 'a latched failure must arm the foreground watch');

	feed(target, 'turn/start', { turn: 2 });
	assert.equal(target.errorLatched, false);
	assert.equal(target.focusTimer, null, 'acknowledging the failure must disarm the watch');
	target.shutdown();
});

test('shutdown disarms the foreground watch', () => {
	const target = monitor();
	feed(target, 'turn/start', { turn: 1 });
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN' } } });
	target.shutdown();
	assert.equal(target.focusTimer, null);
	assert.equal(target.errorLatched, true, 'shutdown does not fabricate an acknowledgement');
});

test('ask_user_question shows the waiting state until its tool/result lands', () => {
	const target = monitor();
	feed(target, 'turn/start', { turn: 1 });
	assert.equal(target.waitingCount(), 0);

	feed(target, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'ask_user_question', arguments: '{}' });
	assert.equal(target.questions.size, 1);
	assert.equal(selectState({ turns: target.turns.size, waiting: target.waitingCount(), errorLatched: false }), 'waiting');

	feed(target, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [] } });
	assert.equal(target.questions.size, 0);
	assert.equal(selectState({ turns: target.turns.size, waiting: target.waitingCount(), errorLatched: false }), 'running');
	target.shutdown();
});

test('other tool calls never look like a question', () => {
	const target = monitor();
	feed(target, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' });
	assert.equal(target.waitingCount(), 0);
	target.shutdown();
});

test('a continued question is closed by the later user reply', () => {
	const target = monitor();
	feed(target, 'tool/call', { turn: 1, callId: 'call-2', name: 'ask_user_question' });
	assert.equal(target.waitingCount(), 1);
	// A timed wait returns a pending result, so the answer arrives as its own event.
	feed(target, 'user/message', { source: { kind: 'user-question-reply', callId: 'call-2' } });
	assert.equal(target.waitingCount(), 0);
	target.shutdown();
});

test('a question does not outlive the last open turn', () => {
	const target = monitor();
	feed(target, 'turn/start', { turn: 1 });
	feed(target, 'tool/call', { turn: 1, callId: 'call-3', name: 'ask_user_question' });
	assert.equal(target.waitingCount(), 1);
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'aborted' } });
	assert.equal(target.waitingCount(), 0, 'the turn ended without an answer');
	target.shutdown();
});
