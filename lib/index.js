/**
 * dsh-taskbar-status — put the agent's activity on the Windows taskbar button of
 * DeepSeek Harness Desktop.
 *
 * Host-only plugin: it never talks to the Electron main process (that IPC is
 * whitelisted and would kill the host), it drives Win32 directly against the
 * window the Electron main process owns.
 *
 * | agent state                    | taskbar                                   |
 * | ------------------------------ | ----------------------------------------- |
 * | a turn is running              | indeterminate progress (grey on Win11)    |
 * | an approval or question waits  | amber, 100/100, plus taskbar flash        |
 * | a turn ended with an error     | full red, latched until a new turn starts |
 * | idle                           | cleared                                   |
 *
 * Across sessions the strongest state wins: waiting > running > error > idle.
 *
 * @module dsh-taskbar-status
 */
import {
	TBPF,
	TaskbarList3,
	bindWin32,
	findHarnessWindow,
	flashTaskbar,
	loadKoffi,
} from './win32-taskbar.js';

export const name = 'dsh-taskbar-status';

/** Coalesce bursts of session events into one taskbar update. */
const DEBOUNCE_MS = 100;
/** The tool the model calls when it blocks on a human answer. */
const ASK_USER_QUESTION = 'ask_user_question';
/** Separator that cannot appear in a session id, so `session + turn` cannot collide. */
const KEY_SEPARATOR = '\u0000';

/**
 * Decide which state the taskbar should show.
 *
 * Pure and exported so the priority rules can be tested without a display.
 *
 * A failure is **latched**: it stays red until a later turn starts (that start is
 * the acknowledgement) or the plugin is reloaded — it is deliberately not timed.
 *
 * @param {object} input
 * @param {number} input.turns count of turns that have started and not ended
 * @param {number} input.waiting count of things blocked on a human decision:
 *   tool approvals plus open `ask_user_question` calls
 * @param {boolean} input.errorLatched whether a failed turn is still unacknowledged
 * @returns {'waiting' | 'running' | 'error' | 'idle'}
 */
export function selectState({ turns, waiting, errorLatched }) {
	if (waiting > 0) return 'waiting';
	if (turns > 0) return 'running';
	if (errorLatched) return 'error';
	return 'idle';
}

/** @param {string} sessionId @param {unknown} turn */
function turnKey(sessionId, turn) {
	return `${sessionId}${KEY_SEPARATOR}${String(turn)}`;
}

/**
 * One step of the "you came back to the window" detector.
 *
 * A failure is acknowledged only when the window was **seen in the background
 * first and then returned to the foreground**. Clearing on "foreground" alone
 * would erase the red bar in the case that matters most — the user was already
 * watching the window when the turn failed — so an error raised while the window
 * is focused keeps its red bar until the next turn.
 *
 * Pure and exported for tests.
 *
 * @param {object} input
 * @param {number} input.focusedPid pid owning the foreground window, 0 when unknown
 * @param {number|null} input.windowPid pid owning the DSH window, null before it is found
 * @param {boolean} input.seenBackground whether the window has been seen unfocused since the failure
 * @returns {{seenBackground: boolean, acknowledge: boolean}}
 */
export function resolveFocusWatch({ focusedPid, windowPid, seenBackground }) {
	const seen = seenBackground === true;
	if (!focusedPid || !windowPid) return { seenBackground: seen, acknowledge: false };
	if (focusedPid === windowPid) return { seenBackground: seen, acknowledge: seen };
	return { seenBackground: true, acknowledge: false };
}

/**
 * Decide whether the taskbar button should flash, given which approvals and
 * questions are blocked right now and which ones were already announced.
 *
 * Keyed by item rather than by count: two approvals can overlap while the bar is
 * already amber, and a count alone would swallow the second one.
 *
 * @param {object} input
 * @param {string[]} input.waitingKeys identifiers of the currently blocked items
 * @param {Set<string>} input.flashedKeys identifiers already announced
 * @returns {{flash: boolean, flashedKeys: Set<string>}}
 */
export function selectFlash({ waitingKeys, flashedKeys }) {
	const current = new Set(waitingKeys);
	if (current.size === 0) return { flash: false, flashedKeys: current };
	const announced = flashedKeys instanceof Set ? flashedKeys : new Set(flashedKeys ?? []);
	let flash = false;
	for (const key of current) {
		if (!announced.has(key)) {
			flash = true;
			break;
		}
	}
	return { flash, flashedKeys: current };
}

/**
 * Wrap `ctx.logger` so a broken/unavailable logger can never break the plugin.
 * @param {any} ctx
 */
function createLog(ctx) {
	const emit = (level, message) => {
		try {
			const logger = ctx.logger;
			if (typeof logger?.[level] === 'function') {
				logger[level](`[taskbar-status] ${message}`);
				return;
			}
			if (level === 'warn') console.warn(`[taskbar-status] ${message}`);
		} catch {
			/* logging is best-effort */
		}
	};
	return {
		debug: (message) => emit('debug', message),
		warn: (message) => emit('warn', message),
	};
}

/**
 * Turn one session event into counter updates. Kept separate from the taskbar
 * so an unexpected payload shape can only ever be a no-op.
 *
 * Exported for tests.
 * @param {any} monitor
 * @param {any} session
 * @param {any} event
 */
export function observeSessionEvent(monitor, session, event) {
	const sessionId = String(session?.id ?? 'unknown');
	const data = event?.data ?? {};
	switch (event?.type) {
		case 'turn/start': {
			// Keyed by session + turn so a replayed/duplicated event cannot inflate
			// the count; `turn/end` removes exactly the same key.
			// Starting a new turn acknowledges an earlier failure, so a latched red
			// bar clears itself once the agent is working again.
			monitor.errorLatched = false;
			monitor.errorSeenBackground = false;
			monitor.stopFocusWatch();
			monitor.turns.set(turnKey(sessionId, data.turn), data.turn);
			monitor.refresh();
			break;
		}
		case 'turn/end': {
			monitor.turns.delete(turnKey(sessionId, data.turn));
			// `approval/asked` carries no turn, and an approval cannot be decided
			// outside an open turn, so once a session has no open turn left its
			// pending decisions can never resolve: drop them instead of leaking.
			if (monitor.openTurnCount(sessionId) === 0) monitor.dropWaiting(sessionId);
			if (data.reason?.kind === 'error') monitor.noteError(data.reason);
			monitor.refresh();
			break;
		}
		case 'approval/asked': {
			monitor.approvals.set(String(data.id), { sessionId });
			monitor.refresh();
			break;
		}
		case 'approval/decided': {
			monitor.approvals.delete(String(data.id));
			monitor.refresh();
			break;
		}
		case 'tool/call': {
			// `ask_user_question` is a normal tool call, not an approval: the turn is
			// blocked on a human answer from this event until its `tool/result`.
			if (data.name !== ASK_USER_QUESTION) break;
			monitor.questions.set(String(data.callId ?? ''), { sessionId });
			monitor.refresh();
			break;
		}
		case 'tool/result': {
			const callId = data.message?.toolCallId ?? data.message?.source?.callId;
			if (callId === undefined) break;
			if (monitor.questions.delete(String(callId))) monitor.refresh();
			break;
		}
		case 'user/message': {
			// The answer can also arrive after the call returned (`continued` timed
			// waits), so close by the reply's own callId as well.
			if (data.source?.kind !== 'user-question-reply') break;
			if (monitor.questions.delete(String(data.source.callId))) monitor.refresh();
			break;
		}
		default:
			break;
	}
}

/**
 * Owns the counters, the debounce timer and the Win32 side effects.
 *
 * Exported for tests: the constructor does nothing by itself, and every Win32
 * call is skipped while `koffiModule` is unset.
 */
export class TaskbarMonitor {
	constructor(log) {
		this.log = log;
		/** @type {Map<string, true>} turns started and not ended */
		this.turns = new Map();
		/** @type {Map<string, {sessionId: string}>} approvals asked and not decided */
		this.approvals = new Map();
		/** @type {Map<string, {sessionId: string}>} open `ask_user_question` calls by callId */
		this.questions = new Map();

		this.state = 'idle';
		this.applied = null; // { hwnd, state } actually pushed to the shell
		this.hwnd = null;
		this.taskbar = null;
		this.koffi = null;
		this.api = null;
		/** A failed turn stays red until a new turn starts (that start acknowledges it). */
		this.errorLatched = false;
		/** Whether the window has been seen unfocused since the failure was latched. */
		this.errorSeenBackground = false;
		/** Blocked items already announced by a taskbar flash, so one flash per item. */
		this.flashedKeys = new Set();

		/** pid owning the DSH window, once it has been located. */
		this.windowPid = null;
		/** Reusable out-parameter cell for `GetWindowThreadProcessId`. */
		this.pidCell = null;
		/** 1s foreground poll, alive only while a failure is latched. */
		this.focusTimer = null;

		this.debounceTimer = null;
		this.disabled = false;
	}

	// --- lifecycle ---------------------------------------------------------

	/** Attach to the session event stream; returns the disposer. */
	start() {
		const onEvent = (session, event) => {
			try {
				observeSessionEvent(this, session, event);
			} catch (error) {
				this.log.warn(`session/event handler failed: ${error?.message ?? String(error)}`);
			}
		};
		const onDisposed = (session) => {
			try {
				this.forgetSession(String(session?.id ?? 'unknown'));
				this.refresh();
			} catch (error) {
				this.log.warn(`session/disposed handler failed: ${error?.message ?? String(error)}`);
			}
		};

		const stopEvent = this.ctxOn('session/event', onEvent);
		const stopDisposed = this.ctxOn('session/disposed', onDisposed);
		// Start from a clean bar: a previous run may have died with one visible.
		this.refresh();

		return () => {
			stopEvent?.();
			stopDisposed?.();
			this.shutdown();
		};
	}

	/** @param {string} event @param {(...args: any[]) => void} handler */
	ctxOn(event, handler) {
		if (!this.ctx || typeof this.ctx.on !== 'function') return undefined;
		const off = this.ctx.on(event, handler);
		return typeof off === 'function' ? off : () => this.ctx?.off?.(event, handler);
	}

	/** Clear the bar, drop timers, release COM. Never throws. */
	shutdown() {
		// A late `loadKoffi()` resolution or a stray event must not paint a bar on
		// a window this plugin no longer owns.
		this.disabled = true;
		clearTimeout(this.debounceTimer);
		this.debounceTimer = null;
		this.stopFocusWatch();
		this.flashedKeys.clear();
		try {
			if (this.taskbar && this.hwnd) this.taskbar.setProgressState(this.hwnd, TBPF.NOPROGRESS);
		} catch {
			/* the window or COM object may already be gone */
		}
		try {
			this.taskbar?.dispose();
		} catch {
			/* nothing left to release */
		}
		this.taskbar = null;
		this.hwnd = null;
		this.applied = null;
	}

	// --- counters ----------------------------------------------------------

	/**
	 * How many turns of `sessionId` are still open.
	 * @param {string} sessionId
	 */
	openTurnCount(sessionId) {
		const prefix = `${sessionId}${KEY_SEPARATOR}`;
		let count = 0;
		for (const key of this.turns.keys()) if (key.startsWith(prefix)) count += 1;
		return count;
	}

		/** Things currently blocked on a human: approvals plus open questions. */
	waitingCount() {
		return this.approvals.size + this.questions.size;
	}

	/**
	 * Stable identity for every blocked item, so a flash can be tied to *which*
	 * approval or question is new instead of to how many are pending.
	 * @returns {string[]}
	 */
	waitingKeys() {
		const keys = [];
		for (const id of this.approvals.keys()) keys.push(`approval:${id}`);
		for (const id of this.questions.keys()) keys.push(`question:${id}`);
		return keys;
	}

	/**
	 * Forget everything a session was waiting on. Used when the session can no
	 * longer decide it.
	 * @param {string} sessionId
	 */
	dropWaiting(sessionId) {
		for (const [id, owner] of this.approvals) {
			if (owner.sessionId === sessionId) this.approvals.delete(id);
		}
		for (const [id, owner] of this.questions) {
			if (owner.sessionId === sessionId) this.questions.delete(id);
		}
	}

	/** @param {string} sessionId */
	forgetSession(sessionId) {
		const prefix = `${sessionId}${KEY_SEPARATOR}`;
		for (const key of [...this.turns.keys()]) {
			if (key.startsWith(prefix)) this.turns.delete(key);
		}
		this.dropWaiting(sessionId);
	}

	/**
	 * Latch the failed state. Deliberately untimed: the red bar is an unread
	 * notification, and it goes away when the next turn starts.
	 * @param {any} reason the `turn/end` reason
	 */
	noteError(reason) {
		this.errorLatched = true;
		this.errorSeenBackground = false;
		this.startFocusWatch();
		this.log.debug(`turn failed (${reason?.error?.code ?? reason?.kind ?? 'error'}); red until acknowledged`);
	}

	// --- focus watch -------------------------------------------------------

	/** pid owning the current foreground window, or 0 when it cannot be read. */
	foregroundPid() {
		const foreground = this.api.GetForegroundWindow();
		if (!foreground) return 0;
		this.pidCell ??= this.koffi.alloc('uint32', 1);
		this.api.GetWindowThreadProcessId(foreground, this.pidCell);
		return this.koffi.decode(this.pidCell, 'uint32');
	}

	/**
	 * Start the 1s poll that clears a latched failure once the user comes back to
	 * the window. It only runs while a failure is latched, so an idle agent costs
	 * nothing.
	 */
	startFocusWatch() {
		if (this.focusTimer || this.disabled) return;
		this.focusTimer = setInterval(() => this.pollFocus(), 1000);
		this.focusTimer.unref?.();
	}

	stopFocusWatch() {
		if (!this.focusTimer) return;
		clearInterval(this.focusTimer);
		this.focusTimer = null;
	}

	/** One poll of the foreground window; acknowledges the failure when warranted. */
	pollFocus() {
		if (!this.errorLatched) {
			this.stopFocusWatch();
			return;
		}
		try {
			if (!this.ensureBinding()) {
				this.stopFocusWatch();
				return;
			}
			const hwnd = this.ensureWindow();
			if (!hwnd) return;
			const next = resolveFocusWatch({
				focusedPid: this.foregroundPid(),
				windowPid: this.windowPid,
				seenBackground: this.errorSeenBackground,
			});
			this.errorSeenBackground = next.seenBackground;
			if (!next.acknowledge) return;
			this.errorLatched = false;
			this.errorSeenBackground = false;
			this.stopFocusWatch();
			this.log.debug('window came back to the foreground; clearing the latched failure');
			this.refresh();
		} catch (error) {
			this.stopFocusWatch();
			this.log.warn(`foreground watch failed: ${error?.message ?? String(error)}`);
		}
	}

	// --- rendering ---------------------------------------------------------

	/** Debounced re-render. */
	refresh() {
		if (this.disabled) return;
		if (this.debounceTimer) return;
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.render();
		}, DEBOUNCE_MS);
		if (this.debounceTimer.unref) this.debounceTimer.unref();
	}

	/** Bind koffi/Win32 once. @returns {boolean} whether the taskbar is usable. */
	ensureBinding() {
		if (this.taskbar) return true;
		if (this.disabled) return false;
		try {
			// Required lazily: on any non-Windows platform `apply` returns before this.
			const koffi = this.koffiModule;
			if (!koffi) return false;
			this.koffi = koffi;
			this.api = bindWin32(koffi);
			return true;
		} catch (error) {
			this.disabled = true;
			this.log.warn(`Win32 binding unavailable, taskbar indicator disabled: ${error?.message ?? String(error)}`);
			return false;
		}
	}

	/** Current HWND, re-locating it when the window was recreated. */
	ensureWindow() {
		if (this.hwnd && this.api.IsWindow(this.hwnd)) return this.hwnd;
		this.hwnd = null;
		const found = findHarnessWindow(this.koffi, this.api, { pid: process.ppid });
		if (!found) return null;
		this.hwnd = found.hwnd;
		this.windowPid = found.pid;
		// A new HWND starts with no progress bar; forget what we had pushed.
		this.applied = null;
		this.log.debug(`window ${found.pid}/${found.hwnd} (${found.via}${found.title ? `, ${JSON.stringify(found.title)}` : ''})`);
		return this.hwnd;
	}

	/** Ensure the COM object exists, creating it on first use. */
	ensureTaskbar() {
		if (this.taskbar) return this.taskbar;
		const taskbar = new TaskbarList3(this.koffi, this.api).create();
		this.taskbar = taskbar;
		return taskbar;
	}

	/** Push the current state to the taskbar. Never throws. */
	render() {
		if (!this.ensureBinding()) return;
		const desired = selectState({
			turns: this.turns.size,
			waiting: this.waitingCount(),
			errorLatched: this.errorLatched,
		});
		try {
			const hwnd = this.ensureWindow();
			if (!hwnd) return;

			// The flash is a channel of its own: a second approval can arrive while
			// the bar already shows amber, and that one must still reach the user.
			// Doing it before the "nothing changed" shortcut below keeps it alive.
			if (desired === 'waiting') this.flashWhenNewWaiting();
			else this.flashedKeys.clear();

			if (this.applied?.hwnd === hwnd && this.applied.state === desired) return;

			const taskbar = this.ensureTaskbar();
			const hr = this.applyState(taskbar, hwnd, desired);
			if (hr !== 0) {
				// The shell object can go bad when the taskbar restarts (explorer.exe
				// crash); drop it once so the next render recreates it.
				this.log.warn(`SetProgressState(${desired}) failed: 0x${(hr >>> 0).toString(16)}; releasing ITaskbarList3`);
				this.taskbar = null;
				taskbar.dispose();
				return;
			}
			this.applied = { hwnd, state: desired };
			if (desired !== this.state) this.log.debug(`state ${this.state} → ${desired}`);
			this.state = desired;
		} catch (error) {
			this.log.warn(`taskbar update failed: ${error?.message ?? String(error)}`);
		}
	}

	/**
	 * Flash the taskbar button once per newly blocked item, not once per render.
	 */
	flashWhenNewWaiting() {
		const next = selectFlash({ waitingKeys: this.waitingKeys(), flashedKeys: this.flashedKeys });
		this.flashedKeys = next.flashedKeys;
		if (!next.flash) return;
		try {
			flashTaskbar(this.koffi, this.api, this.hwnd);
		} catch (error) {
			this.log.warn(`FlashWindowEx failed: ${error?.message ?? String(error)}`);
		}
	}

	/** @param {TaskbarList3} taskbar @param {any} hwnd @param {string} state */
	applyState(taskbar, hwnd, state) {
		switch (state) {
			case 'waiting': {
				// Fill first, then show: the amber bar reads as "complete, waiting on you".
				const valueHr = taskbar.setProgressValue(hwnd, 100, 100);
				if (valueHr !== 0) return valueHr;
				return taskbar.setProgressState(hwnd, TBPF.PAUSED);
			}
			case 'running':
				return taskbar.setProgressState(hwnd, TBPF.INDETERMINATE);
			case 'error': {
				// TBPF_ERROR only colours the *filled* part of the bar. Without a value
				// the shell draws an empty ~1px track, which reads like a rendering
				// glitch instead of a failure, so fill it completely first.
				const valueHr = taskbar.setProgressValue(hwnd, 100, 100);
				if (valueHr !== 0) return valueHr;
				return taskbar.setProgressState(hwnd, TBPF.ERROR);
			}
			case 'idle':
			default:
				return taskbar.setProgressState(hwnd, TBPF.NOPROGRESS);
		}
	}
}

/**
 * Register the plugin.
 * @param {any} ctx cordis plugin context
 */
export function apply(ctx) {
	// The whole feature is Windows-only. Returning before any dynamic import keeps
	// koffi out of the process on every other platform.
	if (process.platform !== 'win32') {
		ctx.logger?.debug?.('[taskbar-status] not on Windows; taskbar indicator stays off');
		return;
	}

	const monitor = new TaskbarMonitor(createLog(ctx));
	monitor.ctx = ctx;
	ctx.effect(
		() => {
			// koffi is imported lazily so a missing native binding is a warning, not a
			// load failure: the plugin must never stop the agent from starting.
			loadKoffi()
				.then((koffi) => {
					monitor.koffiModule = koffi;
					monitor.refresh();
				})
				.catch((error) => {
					monitor.disabled = true;
					monitor.log.warn(`koffi unavailable; taskbar indicator disabled: ${error?.message ?? String(error)}`);
				});
			return monitor.start();
		},
		'taskbar-status: Windows taskbar indicator',
	);
}
