/**
 * Priority and counting rules for dsh-taskbar-status.
 *
 * These run without a display: the Win32 side is skipped entirely while the
 * monitor has no koffi binding, so the counters are exercised in isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	TaskbarMonitor,
	observeSessionEvent,
	resolveFocusWatch,
	selectFlash,
	selectState,
} from '../lib/index.js';
import { TBPF } from '../lib/win32-taskbar.js';

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

test('blocked items are identified individually, not by their count', () => {
	const target = monitor();
	feed(target, 'approval/asked', { id: 'a1' });
	feed(target, 'tool/call', { turn: 1, callId: 'q1', name: 'ask_user_question' });
	assert.deepEqual(target.waitingKeys().sort(), ['approval:a1', 'question:q1']);
	target.shutdown();
});

test('a question without a callId is still cleared when its turn ends', () => {
	const target = monitor();
	feed(target, 'turn/start', { turn: 1 });
	feed(target, 'tool/call', { turn: 1, name: 'ask_user_question' });
	assert.equal(target.waitingCount(), 1, 'an unattributable question still blocks the bar');
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
	assert.equal(target.waitingCount(), 0);
	target.shutdown();
});

test('a tool/result for another call never clears a pending question', () => {
	const target = monitor();
	feed(target, 'tool/call', { turn: 1, callId: 'q1', name: 'ask_user_question' });
	feed(target, 'tool/result', { turn: 1, message: { toolCallId: 'bash-9' } });
	assert.equal(target.waitingCount(), 1);
	target.shutdown();
});

test('session/disposed also drops that session questions', () => {
	const target = monitor();
	feed(target, 'tool/call', { turn: 1, callId: 'q1', name: 'ask_user_question' }, 'session-a');
	feed(target, 'tool/call', { turn: 1, callId: 'q2', name: 'ask_user_question' }, 'session-b');
	target.forgetSession('session-a');
	assert.deepEqual([...target.questions.keys()], ['q2']);
	target.shutdown();
});

test('resolveFocusWatch always reports a boolean seenBackground', () => {
	assert.deepEqual(resolveFocusWatch({ focusedPid: 0, windowPid: 100 }), {
		seenBackground: false,
		acknowledge: false,
	});
});

// --- flash bookkeeping ----------------------------------------------------

test('selectFlash announces a blocking item exactly once', () => {
	assert.deepEqual(selectFlash({ waitingKeys: [], flashedKeys: new Set() }), {
		flash: false,
		flashedKeys: new Set(),
	});

	const first = selectFlash({ waitingKeys: ['approval:a1'], flashedKeys: new Set() });
	assert.equal(first.flash, true);
	assert.deepEqual(first.flashedKeys, new Set(['approval:a1']));

	// A re-render of the same blocked item (or a burst of events) is not news.
	assert.equal(selectFlash({ waitingKeys: ['approval:a1'], flashedKeys: first.flashedKeys }).flash, false);

	// A second item arriving while the first is still pending *is* news.
	const second = selectFlash({ waitingKeys: ['approval:a1', 'question:q1'], flashedKeys: first.flashedKeys });
	assert.equal(second.flash, true);
	assert.deepEqual(second.flashedKeys, new Set(['approval:a1', 'question:q1']));

	// Losing one item must not re-announce the survivor.
	assert.equal(selectFlash({ waitingKeys: ['question:q1'], flashedKeys: second.flashedKeys }).flash, false);

	// Once nothing is blocked the set is empty, so a later ask flashes again.
	const cleared = selectFlash({ waitingKeys: [], flashedKeys: second.flashedKeys });
	assert.equal(cleared.flash, false);
	assert.equal(cleared.flashedKeys.size, 0);
	assert.equal(selectFlash({ waitingKeys: ['question:q1'], flashedKeys: cleared.flashedKeys }).flash, true);
});

// --- rendering ------------------------------------------------------------

/**
 * A `TaskbarList3` stand-in that records what the monitor asks the shell to do,
 * plus the minimum Win32 surface `render()` touches. This is the seam that lets
 * the rendering rules be tested without a window.
 * @param {{failOnState?: number, shell?: string, ownerPid?: number}} [options]
 */
function attachFakeWin32(target, options = {}) {
	const calls = [];
	/** @type {any} */
	const fake = {
		calls,
		flashes: 0,
		/** Shell_TrayWnd handle the fake shell reports; mutate it to simulate a rebuild. */
		shell: options.shell ?? 'tray-1',
		setProgressValue(hwnd, completed, total) {
			calls.push(['value', completed, total]);
			return 0;
		},
		setProgressState(hwnd, state) {
			if (options.failOnState === state) return 0x80004005;
			calls.push(['state', state]);
			return 0;
		},
		dispose() {
			calls.push(['dispose']);
		},
	};
	target.taskbar = fake;
	target.hwnd = 'hwnd-1';
	target.api = {
		IsWindow: () => true,
		FindWindowW: () => fake.shell,
		GetWindowThreadProcessId: (hwnd, cell) => {
			cell.value = options.ownerPid ?? 0;
			return 0;
		},
		types: { FLASHWINFO: 32 },
		FlashWindowEx: () => {
			fake.flashes += 1;
			return true;
		},
	};
	target.koffi = {
		sizeof: () => 32,
		alloc: () => ({ value: 0 }),
		decode: (cell) => cell.value ?? 0,
		encode: (cell, _type, value) => {
			cell.value = value;
		},
		register: (callback) => callback,
		unregister: () => {},
		pointer: () => 'callback',
	};
	return fake;
}

test('a failure fills the bar before switching it red', () => {
	const target = monitor();
	const fake = attachFakeWin32(target);
	feed(target, 'turn/start', { turn: 1 });
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN' } } });
	target.render();
	// TBPF_ERROR only colours the filled part; the value must land first.
	assert.deepEqual(fake.calls, [
		['value', 100, 100],
		['state', TBPF.ERROR],
	]);
	target.shutdown();
});

test('a pending approval fills the bar, turns it amber and flashes once', () => {
	const target = monitor();
	const fake = attachFakeWin32(target);
	feed(target, 'approval/asked', { id: 'a1', toolName: 'bash' });
	target.render();
	assert.deepEqual(fake.calls, [
		['value', 100, 100],
		['state', TBPF.PAUSED],
	]);
	assert.equal(fake.flashes, 1);
	target.shutdown();
});

test('a second blocked item flashes even while the bar is already amber', () => {
	const target = monitor();
	const fake = attachFakeWin32(target);
	feed(target, 'approval/asked', { id: 'a1' });
	target.render();
	feed(target, 'approval/asked', { id: 'a2' });
	target.render();
	assert.equal(fake.flashes, 2, 'each newly blocked item gets its own flash');
	target.render();
	assert.equal(fake.flashes, 2, 'a re-render of the same items is not news');
	target.shutdown();
});

test('an answered question re-arms the flash for the next one', () => {
	const target = monitor();
	const fake = attachFakeWin32(target);
	feed(target, 'tool/call', { turn: 1, callId: 'q1', name: 'ask_user_question' });
	target.render();
	assert.equal(fake.flashes, 1);

	feed(target, 'tool/result', { turn: 1, message: { toolCallId: 'q1' } });
	target.render();
	assert.equal(fake.flashes, 1);

	feed(target, 'tool/call', { turn: 1, callId: 'q2', name: 'ask_user_question' });
	target.render();
	assert.equal(fake.flashes, 2);
	target.shutdown();
});

test('running and idle map to the shell flags the plugin documents', () => {
	const target = monitor();
	const fake = attachFakeWin32(target);
	feed(target, 'turn/start', { turn: 1 });
	target.render();
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
	target.render();
	assert.deepEqual(fake.calls, [
		['state', TBPF.INDETERMINATE],
		['state', TBPF.NOPROGRESS],
	]);
	target.shutdown();
});

test('an unchanged state is not pushed to the shell twice', () => {
	const target = monitor();
	const fake = attachFakeWin32(target);
	feed(target, 'turn/start', { turn: 1 });
	target.render();
	const afterFirst = fake.calls.length;
	target.render();
	target.render();
	assert.equal(fake.calls.length, afterFirst);
	target.shutdown();
});

test('a rebuilt taskbar is repainted even though the desired state did not change', () => {
	const target = monitor();
	const fake = attachFakeWin32(target);
	feed(target, 'turn/start', { turn: 1 });
	target.render();
	assert.deepEqual(fake.calls, [['state', TBPF.INDETERMINATE]]);
	assert.equal(target.shellTray, 'tray-1');

	// Same desired state, same shell: the cache keeps the shell call out.
	target.render();
	assert.equal(fake.calls.length, 1);

	// Explorer rebuilt the taskbar (its own restart, or the display change an RDP
	// reconnect performs): every button lost its bar, so the cached state is
	// worthless and the object created against the old shell must not be trusted.
	fake.shell = 'tray-2';
	target.render();
	assert.deepEqual(fake.calls, [['state', TBPF.INDETERMINATE], ['dispose']]);
	assert.equal(target.applied, null, 'the cache is invalidated');
	assert.equal(target.taskbar, null, 'the old ITaskbarList3 is dropped');
	assert.equal(target.shellTray, 'tray-2');

	// The next render builds a new object against the new shell and repaints.
	const fresh = attachFakeWin32(target, { shell: 'tray-2' });
	target.render();
	assert.deepEqual(fresh.calls, [['state', TBPF.INDETERMINATE]]);
	target.shutdown();
});

test('a recycled HWND is rejected instead of painting on another process window', () => {
	const target = monitor();
	attachFakeWin32(target, { ownerPid: 4242 });
	target.windowPid = 111;
	assert.equal(target.windowBelongsTo('hwnd-1', 111), false);
	assert.equal(target.hwnd, 'hwnd-1', 'the predicate itself has no side effects');

	// render() must not paint on a window it no longer owns, and must drop the
	// cached handle so a later render resolves the real one.
	target.api.EnumWindows = () => {};
	target.render();
	assert.equal(target.hwnd, null, 'a handle owned by another process is not reused');
	assert.equal(target.applied, null);

	// Once the owner matches again the cached window is kept as-is.
	attachFakeWin32(target, { ownerPid: 111 });
	target.windowPid = 111;
	assert.equal(target.windowBelongsTo('hwnd-1', 111), true);
	target.shutdown();
});

test('a rejected SetProgressState releases the shell object for the next render', () => {
	const target = monitor();
	const fake = attachFakeWin32(target, { failOnState: TBPF.ERROR });
	feed(target, 'turn/start', { turn: 1 });
	feed(target, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN' } } });
	target.render();
	assert.equal(target.taskbar, null, 'a broken object must be dropped, not reused');
	assert.deepEqual(fake.calls, [['value', 100, 100], ['dispose']]);

	attachFakeWin32(target);
	target.render();
	assert.notEqual(target.taskbar, null);
	assert.equal(target.applied?.state, 'error', 'the next render rebuilds and repaints');
	target.shutdown();
});

test('a missing window is a no-op rather than an exception', () => {
	const target = monitor();
	attachFakeWin32(target);
	target.hwnd = null;
	target.api = {
		IsWindow: () => false,
		EnumWindows: () => {
			throw new Error('no window');
		},
	};
	assert.doesNotThrow(() => target.render());
	target.shutdown();
});

test('shutdown stops further rendering', () => {
	const target = monitor();
	const fake = attachFakeWin32(target);
	feed(target, 'turn/start', { turn: 1 });
	target.shutdown();
	const afterShutdown = fake.calls.length;
	feed(target, 'turn/start', { turn: 2 });
	target.render();
	assert.equal(target.disabled, true);
	assert.equal(fake.calls.length, afterShutdown, 'a disposed monitor must not paint the bar');
});
