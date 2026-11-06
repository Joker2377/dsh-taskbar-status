/**
 * Minimal Win32 taskbar FFI for DeepSeek Harness Desktop.
 *
 * Everything here is best-effort: no call may throw out of a caller that only
 * wants a progress bar. The module is only ever loaded on `win32` and koffi is
 * imported lazily, so importing this file on another platform is harmless.
 *
 * Two capabilities live here:
 *   1. locate the top-level DSH window owned by the Electron main process;
 *   2. drive `ITaskbarList3` (progress bar) and `FlashWindowEx` (taskbar button
 *      attention) against that window from the host process.
 *
 * @module dsh-taskbar-status/win32-taskbar
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** `TBPFLAG` values (shellapi.h). */
export const TBPF = {
	NOPROGRESS: 0x0,
	INDETERMINATE: 0x1,
	NORMAL: 0x2,
	ERROR: 0x4,
	PAUSED: 0x8,
};

/** `FLASHW_*` values (winuser.h). */
export const FLASHW = {
	CAPTION: 0x1,
	TRAY: 0x2,
	ALL: 0x3,
	STOP: 0x4,
	TIMER: 0x0,
	TIMERNOFG: 0xC,
};

/** `GW_OWNER`: an owner window marks a dialog/utility window, not the main one. */
const GW_OWNER = 4;
/** `PROCESS_QUERY_LIMITED_INFORMATION`. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** `CLSCTX_INPROC_SERVER`. */
const CLSCTX_INPROC_SERVER = 0x1;
/** `COINIT_APARTMENTTHREADED`. */
const COINIT_APARTMENTTHREADED = 0x2;
/** `RPC_E_CHANGED_MODE`: the thread already joined another apartment; COM still works. */
const RPC_E_CHANGED_MODE = -2147417850;

/** `CLSID_TaskbarList` = {56FDF344-FD6D-11d0-958A-006097C9A090}. */
const CLSID_TASKBAR_LIST = {
	data1: 0x56fdf344,
	data2: 0xfd6d,
	data3: 0x11d0,
	data4: [0x95, 0x8a, 0x00, 0x60, 0x97, 0xc9, 0xa0, 0x90],
};
/** `IID_ITaskbarList3` = {ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf}. */
const IID_ITASKBARLIST3 = {
	data1: 0xea1afb91,
	data2: 0x9e28,
	data3: 0x4b86,
	data4: [0x90, 0xe9, 0x9e, 0x9f, 0x8a, 0x5e, 0xef, 0xaf],
};

let cachedKoffi;
/**
 * Resolution for the absolute candidates. `require` reads a path inside
 * `app.asar`; the ESM loader does not.
 */
const requireHere = createRequire(import.meta.url);
/** Survives a plugin hot reload; see `bindWin32`. */
const BINDING_KEY = Symbol.for('dsh-taskbar-status.win32-binding');

/** @param {unknown} value @returns {boolean} whether it looks like koffi */
function isKoffi(value) {
	return typeof (value?.default ?? value)?.load === 'function';
}

/**
 * Import koffi from the plugin's own dependencies, then from the copy shipped
 * inside the desktop runtime, so a `link:` checkout without `node_modules` still
 * works and `scripts/probe.mjs` needs no install step.
 *
 * The runtime layout is not stable across DSH releases: 0.2.x packs the host
 * into `resources/app.asar`, while earlier builds shipped it unpacked under
 * `resources/app`. Resolution tries, in order: the bare specifier,
 * `DSH_KOFFI_PATH`, the host's own module graph, then both known layouts.
 *
 * @returns {Promise<any>} the koffi module namespace.
 */
export async function loadKoffi() {
	if (cachedKoffi) return cachedKoffi;
	const failures = [];
	/** @type {Array<{label: string, load: () => unknown}>} */
	const attempts = [{ label: 'koffi', load: () => import('koffi') }];

	const candidates = koffiCandidatePaths();
	const asFile = (candidate) => ({
		label: candidate.label,
		load: () => requireHere(candidate.path),
	});
	attempts.push(...candidates.filter((candidate) => candidate.source === 'env').map(asFile));

	// Before the hardcoded layouts: whatever the running build actually ships
	// wins, so a future move of the runtime cannot break resolution again.
	const hostEntry = process.argv[1];
	if (hostEntry) attempts.push({ label: `host:${hostEntry}`, load: () => koffiFromHost(hostEntry) });

	attempts.push(...candidates.filter((candidate) => candidate.source !== 'env').map(asFile));

	for (const attempt of attempts) {
		try {
			const namespace = await attempt.load();
			if (isKoffi(namespace)) {
				cachedKoffi = namespace?.default ?? namespace;
				return cachedKoffi;
			}
			failures.push(`${attempt.label}: not a koffi module`);
		} catch (error) {
			failures.push(`${attempt.label}: ${error?.message ?? String(error)}`);
		}
	}
	throw new Error(`koffi is not available (${failures.join('; ')})`);
}

/**
 * Resolve `koffi` through the entry script's own module graph. The host already
 * depends on koffi, so this finds whatever the shipped build contains, wherever
 * it lives.
 * @param {string} hostEntry path of the running host's entry script
 */
function koffiFromHost(hostEntry) {
	const hostRequire = createRequire(hostEntry);
	return hostRequire(hostRequire.resolve('koffi'));
}

/**
 * Absolute koffi entry points shipped with the desktop runtime, plus
 * `DSH_KOFFI_PATH`. Pure apart from `exists`, so the layout rules are testable
 * on any platform.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.execPath]
 * @param {(path: string) => boolean} [options.exists]
 * @returns {Array<{source: 'env' | 'runtime', label: string, path: string}>}
 */
export function koffiCandidatePaths({ env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
	/** @type {Array<{source: 'env' | 'runtime', label: string, path: string}>} */
	const candidates = [];
	const add = (source, label, entry) => {
		if (!entry || !exists(entry)) return;
		if (candidates.some((candidate) => candidate.path === entry)) return;
		candidates.push({ source, label, path: entry });
	};

	const explicit = env.DSH_KOFFI_PATH;
	if (explicit) {
		const entry = /\.(?:c|m)?js$/u.test(explicit) ? explicit : join(explicit, 'index.js');
		add('env', 'DSH_KOFFI_PATH', entry);
	}

	for (const resources of runtimeRoots(env, execPath)) {
		// Newest layout first: 0.2.x packs the host into app.asar, and only the
		// older builds have a real `app` directory.
		for (const layout of ['app.asar', 'app']) {
			add('runtime', `${layout}:dsh`, join(resources, layout, 'dsh', 'node_modules', 'koffi', 'index.js'));
		}
	}
	return candidates;
}

/**
 * Candidate `resources` directories: the default install location and the
 * running executable's own directory. Deduplicated, because both describe the
 * same tree when the app is installed where `LOCALAPPDATA` says it is.
 * @param {Record<string, string | undefined>} env
 * @param {string} execPath
 * @returns {string[]}
 */
function runtimeRoots(env, execPath) {
	const roots = [];
	if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources'));
	// `dirname`, not `join(execPath, '..')`: execPath names a file.
	if (execPath) roots.push(join(dirname(execPath), 'resources'));
	return roots.filter((root, index) => roots.indexOf(root) === index);
}

/**
 * Declare a 16-byte GUID as four little-endian uint32 words. Array members are
 * avoided on purpose: passing a plain struct value where koffi declared a
 * `GUID *` parameter is the marshalling path that actually works
 * (`koffi.as(struct, 'GUID *')` is rejected for structs).
 * @param {any} koffi
 * @param {string} name koffi type name.
 */
function guidStruct(koffi, name) {
	return koffi.struct(name, { w0: 'uint32', w1: 'uint32', w2: 'uint32', w3: 'uint32' });
}

/**
 * Lay a GUID out the way Windows stores it: Data1, then Data2/Data3 as two
 * little-endian uint16 halves of one word, then the eight Data4 bytes as two
 * words. Getting this order wrong yields a registered-looking but reversed
 * CLSID, and COM answers `REGDB_E_CLASSNOTREG` (0x80040154).
 * @param {{data1: number, data2: number, data3: number, data4: number[]}} guid
 * @returns {{w0: number, w1: number, w2: number, w3: number}}
 */
export function guidWords(guid) {
	const [b8, b9, b10, b11, b12, b13, b14, b15] = guid.data4;
	return {
		w0: guid.data1 >>> 0,
		w1: (((guid.data2 & 0xffff) | ((guid.data3 & 0xffff) << 16)) >>> 0),
		w2: ((b8 | (b9 << 8) | (b10 << 16) | (b11 << 24)) >>> 0),
		w3: ((b12 | (b13 << 8) | (b14 << 16) | (b15 << 24)) >>> 0),
	};
}

/**
 * Resolve every DLL/prototype/struct this module needs. Throws on a genuinely
 * unusable binding (missing DLL, koffi layout mismatch); callers treat that as
 * "taskbar feature off".
 *
 * koffi type names are process-wide and cannot be redefined, while DSH hot-reloads
 * plugins inside a live host: a second bind throws `Duplicate type name`. The
 * result lives on `globalThis` because a reload may re-evaluate this module.
 * @param {any} koffi loaded koffi module.
 */
export function bindWin32(koffi) {
	return (globalThis[BINDING_KEY] ??= createBinding(koffi));
}

/** @param {any} koffi */
function createBinding(koffi) {
	const user32 = koffi.load('user32.dll');
	const ole32 = koffi.load('ole32.dll');
	const kernel32 = koffi.load('kernel32.dll');

	const GUID = guidStruct(koffi, 'DSH_TS_GUID');
	const GUID_PTR = koffi.pointer(GUID);

	const FLASHWINFO = koffi.struct('DSH_TS_FLASHWINFO', {
		cbSize: 'uint32',
		hwnd: 'void *',
		dwFlags: 'uint32',
		uCount: 'uint32',
		dwTimeout: 'uint32',
	});
	// x64: cbSize(4) + pad(4) + hwnd(8) + dwFlags(4) + uCount(4) + dwTimeout(4) + pad(4).
	if (FLASHWINFO.size !== 32) throw new Error(`FLASHWINFO layout mismatch: ${FLASHWINFO.size} bytes, expected 32`);

	const ITASKBARLIST3_VTBL = koffi.struct('DSH_TS_ITASKBARLIST3_VTBL', {
		queryInterface: 'void *', // 0
		addRef: 'void *', // 1
		release: 'void *', // 2
		hrInit: 'void *', // 3
		addTab: 'void *', // 4
		deleteTab: 'void *', // 5
		activateTab: 'void *', // 6
		setActiveAlt: 'void *', // 7
		markFullscreenWindow: 'void *', // 8
		setProgressValue: 'void *', // 9
		setProgressState: 'void *', // 10
	});

	const EnumWindowsProc = koffi.proto('bool __stdcall DSH_TS_EnumWindowsProc(void *hwnd, long lParam)');

	const api = {
		EnumWindows: user32.func('bool EnumWindows(DSH_TS_EnumWindowsProc *callback, long lParam)'),
		GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(void *hwnd, uint32 *pid)'),
		IsWindow: user32.func('bool IsWindow(void *hwnd)'),
		IsWindowVisible: user32.func('bool IsWindowVisible(void *hwnd)'),
		FindWindowW: user32.func('void *FindWindowW(str16 className, str16 windowName)'),
		GetWindow: user32.func('void *GetWindow(void *hwnd, uint32 command)'),
		GetWindowTextW: user32.func('int GetWindowTextW(void *hwnd, uint16 *buffer, int maximum)'),
		GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
		FlashWindowEx: user32.func('bool FlashWindowEx(DSH_TS_FLASHWINFO *info)'),
		CoInitializeEx: ole32.func('long CoInitializeEx(void *reserved, uint32 coinit)'),
		CoUninitialize: ole32.func('void CoUninitialize()'),
		CoCreateInstance: ole32.func('long CoCreateInstance(DSH_TS_GUID *clsid, void *outer, uint32 context, DSH_TS_GUID *iid, void **out)'),
		OpenProcess: kernel32.func('void *OpenProcess(uint32 access, bool inherit, uint32 pid)'),
		QueryFullProcessImageNameW: kernel32.func('bool QueryFullProcessImageNameW(void *process, uint32 flags, uint16 *buffer, uint32 *size)'),
		CloseHandle: kernel32.func('bool CloseHandle(void *handle)'),
	};

	return {
		...api,
		/** @type {any} */ types: { GUID, GUID_PTR, FLASHWINFO, ITASKBARLIST3_VTBL },
		/** @type {any} */ protos: {
			hrInit: koffi.proto('int32 DSH_TS_HrInit(void *self)'),
			setProgressState: koffi.proto('int32 DSH_TS_SetProgressState(void *self, void *hwnd, int32 state)'),
			setProgressValue: koffi.proto('int32 DSH_TS_SetProgressValue(void *self, void *hwnd, uint64 completed, uint64 total)'),
			release: koffi.proto('uint32 DSH_TS_Release(void *self)'),
		},
		EnumWindowsProc,
		GUID_INSTANCES: {
			clsid: guidWords(CLSID_TASKBAR_LIST),
			iid: guidWords(IID_ITASKBARLIST3),
		},
	};
}

/**
 * Split an enumerated window into something a caller can reason about.
 * @param {any} api
 * @param {any} koffi
 * @param {any} hwnd
 * @param {any} pidCell reusable uint32 cell for the out-parameter.
 */
function describeWindow(api, koffi, hwnd, pidCell, titleCell) {
	api.GetWindowThreadProcessId(hwnd, pidCell);
	return {
		hwnd,
		pid: koffi.decode(pidCell, 'uint32'),
		visible: api.IsWindowVisible(hwnd) === true, // koffi maps `bool` to a JS boolean
		owner: api.GetWindow(hwnd, GW_OWNER),
		title: readTitle(api, koffi, hwnd, titleCell),
	};
}

/** @returns {string} the window title, or `''` when it cannot be read. */
function readTitle(api, koffi, hwnd, titleCell) {
	try {
		const length = api.GetWindowTextW(hwnd, titleCell, 512);
		if (length <= 0) return '';
		return koffi.decode.string16(titleCell, length);
	} catch {
		return '';
	}
}

/**
 * Whether a window is a plausible "main window": visible, unowned, top level.
 * @param {{visible: boolean, owner: any}} window
 */
function isMainWindow(window) {
	return window.visible === true && (window.owner === null || window.owner === 0);
}

/**
 * Enumerate every top-level window with its pid, visibility, owner and title.
 * @param {any} koffi
 * @param {any} api
 * @param {{limit?: number}} [options]
 */
export function listTopLevelWindows(koffi, api, options = {}) {
	const limit = options.limit ?? 512;
	const collected = [];
	const pidCell = koffi.alloc('uint32', 1);
	const titleCell = koffi.alloc('uint16', 512);
	const callback = koffi.register((hwnd) => {
		if (collected.length < limit) collected.push(describeWindow(api, koffi, hwnd, pidCell, titleCell));
		return true;
	}, koffi.pointer(api.EnumWindowsProc));
	try {
		api.EnumWindows(callback, 0);
	} finally {
		koffi.unregister(callback);
	}
	return collected;
}

/** @returns {string} full image path of `pid`, or `''`. */
function processImagePath(api, koffi, pid) {
	const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
	if (!handle) return '';
	const sizeCell = koffi.alloc('uint32', 1);
	const buffer = koffi.alloc('uint16', 1024);
	try {
		// `lpdwSize` is in/out: it must carry the buffer length in characters on the
		// way in, otherwise the call fails with a zero-sized buffer.
		koffi.encode(sizeCell, 'uint32', 1024);
		if (!api.QueryFullProcessImageNameW(handle, 0, buffer, sizeCell)) return '';
		const length = koffi.decode(sizeCell, 'uint32');
		return length > 0 ? koffi.decode.string16(buffer, length) : '';
	} finally {
		api.CloseHandle(handle);
	}
}

/**
 * Find the DSH main window.
 *
 * Primary strategy is the documented one: the host is a direct child of the
 * Electron main process, so the window belongs to `process.ppid`. When an
 * explicit `pid` is given (the probe), that pid is used instead. If no window
 * of that pid qualifies, fall back to the first ownerless visible window whose
 * process image looks like DeepSeek Harness — this keeps the feature alive if
 * the host is ever launched one level deeper.
 *
 * @param {any} koffi
 * @param {any} api
 * @param {{pid?: number, allowImageFallback?: boolean}} [options]
 * @returns {{hwnd: any, pid: number, title: string, via: 'pid'|'image'} | null}
 */
export function findHarnessWindow(koffi, api, options = {}) {
	const pid = options.pid ?? process.ppid;
	const windows = listTopLevelWindows(koffi, api);
	const mains = windows.filter(isMainWindow);

	const preferred = mains.filter((window) => window.pid === pid);
	const byPid = pickBest(preferred);
	if (byPid) return { hwnd: byPid.hwnd, pid: byPid.pid, title: byPid.title, via: 'pid' };
	if (options.allowImageFallback === false) return null;

	for (const window of mains) {
		if (window.pid === process.pid) continue;
		const image = processImagePath(api, koffi, window.pid);
		if (!image) continue;
		const name = image.toLowerCase();
		if (name.includes('deepseek harness') || name.includes('deepseek-harness')) {
			return { hwnd: window.hwnd, pid: window.pid, title: window.title, via: 'image' };
		}
	}
	return null;
}

/** Prefer a titled window that mentions DeepSeek, else the first candidate. */
function pickBest(windows) {
	if (windows.length === 0) return null;
	const titled = windows.find((window) => /deepseek/i.test(window.title));
	return titled ?? windows[0];
}

/**
 * Find an ownerless visible top-level window whose title matches `pattern`.
 * The probe uses this when the Electron main pid is unknown (for example when
 * the probe is run from a sandboxed shell that cannot query other processes).
 * @param {any} koffi
 * @param {any} api
 * @param {RegExp} pattern
 * @returns {{hwnd: any, pid: number, title: string, via: 'title'} | null}
 */
export function findWindowByTitle(koffi, api, pattern) {
	const windows = listTopLevelWindows(koffi, api).filter(isMainWindow);
	const match = windows.find((window) => pattern.test(window.title));
	if (!match) return null;
	return { hwnd: match.hwnd, pid: match.pid, title: match.title, via: 'title' };
}

/**
 * Wrap a live `ITaskbarList3` created in this process's apartment.
 *
 * koffi has no COM interop, so the interface is reached the way C does it: read
 * the vtable pointer out of the object, read the slot, then call the slot with
 * the interface pointer as `this`.
 */
export class TaskbarList3 {
	/**
	 * @param {any} koffi
	 * @param {ReturnType<typeof bindWin32>} api
	 */
	constructor(koffi, api) {
		this.koffi = koffi;
		this.api = api;
		/** @type {any} */ this.instance = null;
		/** @type {Record<string, any> | null} */ this.vtable = null;
		this.coInitialized = false;
	}

	/** Create and initialise the shell COM object. @returns {this} */
	create() {
		if (this.instance) return this;
		const { api, koffi } = this;
		const hr = api.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
		// S_OK, S_FALSE (already initialised) and RPC_E_CHANGED_MODE are all usable;
		// an in-process shell handler does not need our apartment to match.
		this.coInitialized = hr === 0 || hr === 1;
		if (hr !== 0 && hr !== 1 && hr !== RPC_E_CHANGED_MODE) throw new Error(`CoInitializeEx failed: 0x${hr.toString(16)}`);

		const out = koffi.alloc('void *', 1);
		const { clsid, iid } = api.GUID_INSTANCES;
		// Plain struct values: koffi passes the address of a temporary copy for a
		// `GUID *` parameter. `koffi.as(struct, 'GUID *')` does not do this.
		const createHr = api.CoCreateInstance(clsid, null, CLSCTX_INPROC_SERVER, iid, out);
		if (createHr !== 0) throw new Error(`CoCreateInstance(ITaskbarList3) failed: 0x${(createHr >>> 0).toString(16)}`);

		const instance = koffi.decode(out, 'void *');
		if (!instance) throw new Error('CoCreateInstance(ITaskbarList3) returned a null interface');

		const vtablePointer = koffi.decode(instance, 'void *');
		const vtable = koffi.decode(vtablePointer, api.types.ITASKBARLIST3_VTBL);

		const initHr = koffi.call(vtable.hrInit, api.protos.hrInit, instance);
		if (initHr !== 0) throw new Error(`ITaskbarList3::HrInit failed: 0x${(initHr >>> 0).toString(16)}`);

		this.instance = instance;
		this.vtable = vtable;
		return this;
	}

	/**
	 * Set the taskbar progress state for one window.
	 * @param {any} hwnd
	 * @param {number} state a `TBPF` value
	 * @returns {number} the HRESULT
	 */
	setProgressState(hwnd, state) {
		const { koffi, api } = this;
		return koffi.call(this.vtable.setProgressState, api.protos.setProgressState, this.instance, hwnd, state);
	}

	/**
	 * Set the taskbar progress value (used to fill the amber bar completely).
	 * @param {any} hwnd
	 * @param {number} completed
	 * @param {number} total
	 * @returns {number} the HRESULT
	 */
	setProgressValue(hwnd, completed, total) {
		const { koffi, api } = this;
		return koffi.call(this.vtable.setProgressValue, api.protos.setProgressValue, this.instance, hwnd, completed, total);
	}

	/** Release the interface and leave the apartment. */
	dispose() {
		if (!this.instance) return;
		try {
			this.koffi.call(this.vtable.release, this.api.protos.release, this.instance);
		} finally {
			this.instance = null;
			this.vtable = null;
			if (this.coInitialized) {
				try {
					this.api.CoUninitialize();
				} catch {
					/* the apartment is gone either way */
				}
				this.coInitialized = false;
			}
		}
	}
}

/**
 * Flash the taskbar button of `hwnd` until the window is brought forward.
 * @param {any} koffi
 * @param {any} api
 * @param {any} hwnd
 * @param {{count?: number, timeout?: number}} [options]
 */
export function flashTaskbar(koffi, api, hwnd, options = {}) {
	const info = {
		cbSize: koffi.sizeof(api.types.FLASHWINFO),
		hwnd,
		dwFlags: FLASHW.TRAY | FLASHW.TIMERNOFG,
		uCount: options.count ?? 3,
		dwTimeout: options.timeout ?? 0,
	};
	return api.FlashWindowEx(info);
}
