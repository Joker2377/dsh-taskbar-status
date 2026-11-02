#!/usr/bin/env node
/**
 * Standalone FFI probe for dsh-taskbar-status — no DSH, no plugin host.
 *
 * Finds the DeepSeek Harness window and walks the taskbar through every state
 * the plugin can produce, so the Win32/COM layer can be verified before the
 * plugin is installed and enabled.
 *
 *   node scripts/probe.mjs            # grey → amber+flash → red → clear
 *   node scripts/probe.mjs --detect   # only locate the window and print it
 *   node scripts/probe.mjs --pid 1234 # target an explicit Electron main pid
 *   node scripts/probe.mjs --ms 5000  # longer dwell per state
 *   node scripts/probe.mjs --delay 5  # wait before the first state, so a human can watch
 */
import { loadKoffi, bindWin32, findHarnessWindow, findWindowByTitle, listTopLevelWindows, TaskbarList3, flashTaskbar, TBPF } from '../lib/win32-taskbar.js';

const args = process.argv.slice(2);
/** @param {string} flag */
const flag = (name) => args.includes(`--${name}`);
/** @param {string} name @param {string} fallback */
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const dwellMs = Number(option('ms', '3000'));
const explicitPid = option('pid', '');
const explicitTitle = option('title', '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (label, value) => console.log(`${label.padEnd(22)} ${value}`);

const koffi = await loadKoffi();
line('koffi', koffi.version ?? '(version unknown)');
line('platform', `${process.platform} ${process.arch}`);
line('node', process.version);
line('probe pid / ppid', `${process.pid} / ${process.ppid}`);

const api = bindWin32(koffi);

if (flag('focus')) {
	// Diagnose the "clear the red bar when the user comes back" path: this prints
	// which process owns the foreground window and whether it is the DSH one.
	const target = findHarnessWindow(koffi, api, { pid: process.ppid }) ?? findWindowByTitle(koffi, api, /deepseek/i);
	if (!target) {
		console.error('No DeepSeek Harness window found.');
		process.exitCode = 1;
		process.exit(1);
	}
	const cell = koffi.alloc('uint32', 1);
	const foreground = api.GetForegroundWindow();
	api.GetWindowThreadProcessId(foreground, cell);
	const focusedPid = foreground ? koffi.decode(cell, 'uint32') : 0;
	line('window pid', String(target.pid));
	line('window hwnd', String(target.hwnd));
	line('foreground pid', focusedPid ? String(focusedPid) : '0 (none)');
	line('foreground is DSH', String(focusedPid === target.pid));
	console.log('\nThe latched red bar clears only after the window is seen in the background and then focused again.');
	process.exit(0);
}

if (flag('list')) {
	const windows = listTopLevelWindows(koffi, api)
		.filter((window) => window.visible && (window.owner === null || window.owner === 0))
		.sort((left, right) => left.pid - right.pid);
	console.log(`\n${windows.length} ownerless visible top-level window(s):`);
	for (const window of windows) {
		console.log(`  pid=${String(window.pid).padEnd(7)} hwnd=${String(window.hwnd).padEnd(18)} title=${JSON.stringify(window.title)}`);
	}
	process.exit(0);
}

/** @param {number} hr */
const hex = (hr) => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

const target = explicitTitle
	? findWindowByTitle(koffi, api, new RegExp(explicitTitle, 'u'))
	: findHarnessWindow(koffi, api, { pid: explicitPid ? Number(explicitPid) : process.ppid });
if (!target) {
	console.error('\nNo DeepSeek Harness main window found. Is the desktop app running?');
	console.error('Try: node scripts/probe.mjs --pid <electron-main-pid>');
	process.exitCode = 1;
} else {
	line('window hwnd', String(target.hwnd));
	line('window pid', String(target.pid));
	line('window title', JSON.stringify(target.title));
	line('found via', target.via === 'pid' ? 'process id match' : target.via === 'image' ? 'process image name fallback' : 'window title match');
}

if (target && flag('compare')) {
	// `INDETERMINATE` is a neutral grey animation; only `NORMAL` takes a colour,
	// and that colour is the system accent — not a value this API accepts.
	// This mode exists so a human can see what each state actually looks like.
	const delayMs = Number(option('delay', '0')) * 1000;
	if (delayMs > 0) {
		console.log(`\nstarting in ${delayMs / 1000}s — watch the taskbar button of that window`);
		await sleep(delayMs);
	}
	const taskbar = new TaskbarList3(koffi, api).create();
	const show = async (label, state, value) => {
		if (value !== undefined) {
			const valueHr = taskbar.setProgressValue(target.hwnd, value, 100);
			console.log(`\n[${label}] SetProgressValue(${value}/100) → ${hex(valueHr)}`);
		} else {
			console.log(`\n[${label}]`);
		}
		const stateHr = taskbar.setProgressState(target.hwnd, state);
		console.log(`[${label}] SetProgressState(${state}) → ${hex(stateHr)} — look for 4s`);
		await sleep(4000);
	};
	try {
		await show('A: NORMAL 60%', TBPF.NORMAL, 60);
		await show('B: INDETERMINATE (what the plugin uses now)', TBPF.INDETERMINATE);
		await show('C: NORMAL 100%', TBPF.NORMAL, 100);
		await show('D: PAUSED 100% (approval state)', TBPF.PAUSED, 100);
		await show('E: cleared', TBPF.NOPROGRESS);
	} finally {
		taskbar.setProgressState(target.hwnd, TBPF.NOPROGRESS);
		taskbar.dispose();
	}
	process.exit(0);
}

if (target && !flag('detect')) {
	const delayMs = Number(option('delay', '0')) * 1000;
	if (delayMs > 0) {
		console.log(`\nstarting in ${delayMs / 1000}s — watch the taskbar button of that window`);
		await sleep(delayMs);
	}
	const taskbar = new TaskbarList3(koffi, api).create();
	line('ITaskbarList3', 'created, HrInit ok');

	/** @param {string} name @param {number} state @param {number} [ms] */
	const apply = async (name, state, ms = dwellMs) => {
		const hr = taskbar.setProgressState(target.hwnd, state);
		console.log(`\n[${name}] SetProgressState(${state}) → ${hex(hr)} — ${ms}ms`);
		await sleep(ms);
	};

	try {
		await apply('running', TBPF.INDETERMINATE);
		const valueHr = taskbar.setProgressValue(target.hwnd, 100, 100);
		const pausedHr = taskbar.setProgressState(target.hwnd, TBPF.PAUSED);
		const flashOk = flashTaskbar(koffi, api, target.hwnd);
		console.log(`\n[approval] SetProgressValue(100/100) → ${hex(valueHr)}, SetProgressState(PAUSED) → ${hex(pausedHr)}, FlashWindowEx → ${flashOk ? 'true' : 'false'}`);
		await sleep(dwellMs);
		// Red only colours the filled part: set the value first or the shell draws an
		// empty ~1px track instead of a red bar.
		const errorValueHr = taskbar.setProgressValue(target.hwnd, 100, 100);
		const errorStateHr = taskbar.setProgressState(target.hwnd, TBPF.ERROR);
		console.log(`\n[error] SetProgressValue(100/100) → ${hex(errorValueHr)}, SetProgressState(ERROR) → ${hex(errorStateHr)} — ${dwellMs}ms`);
		await sleep(dwellMs);
		await apply('idle', TBPF.NOPROGRESS, 0);
	} finally {
		taskbar.setProgressState(target.hwnd, TBPF.NOPROGRESS);
		taskbar.dispose();
		line('\nreleased', 'progress cleared, ITaskbarList3 released');
	}
}
