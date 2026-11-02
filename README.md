# dsh-taskbar-status

[![test](https://github.com/Joker2377/dsh-taskbar-status/actions/workflows/test.yml/badge.svg)](https://github.com/Joker2377/dsh-taskbar-status/actions/workflows/test.yml)

在 Windows 工作列的 **DeepSeek Harness Desktop** 圖示上顯示 agent 狀態。純 host 端外掛，不改 `main.js`、不改 `app.asar`。

> A host-only DSH plugin that paints the agent state — running, waiting for a human, failed — onto the taskbar button of DeepSeek Harness Desktop.
>
> Requires Windows 10/11, DeepSeek Harness Desktop `>=0.1.1-rc.2 <0.3.0`, Node `>=22.19`.

## 這是什麼

一個 DSH host 外掛：它訂閱 session 事件，算出「現在該顯示什麼」，然後直接呼叫 Win32 把結果畫在桌面版主視窗的工作列按鈕上。agent 出錯、跑很久、或跳出核准等待時，你不必盯著視窗也知道。

| 狀態 | 工作列效果 | 觸發事件 |
| --- | --- | --- |
| 執行中 | 灰色不定進度條（`TBPF_INDETERMINATE` = `0x1`）——**灰色不是 bug**，見下方說明 | `turn/start` |
| 等待人工 | 黃色（`TBPF_PAUSED` = `0x8`，value 100/100）＋ `FlashWindowEx`（`FLASHW_TRAY \| FLASHW_TIMERNOFG`） | `approval/asked`，或 `ask_user_question` 的 `tool/call` |
| 出錯 | 全紅（`TBPF_ERROR` = `0x4`，value 100/100）——**閂鎖**，見下方清除規則 | `turn/end` 且 `reason.kind === 'error'` |
| 閒置 | 清除（`TBPF_NOPROGRESS` = `0x0`） | 最後一個 turn 結束 |

多個 session 同時存在時，優先序是 **等待人工 > 執行中 > 出錯 > 閒置**。turn、approval 與提問各用一個計數器（turn 以「session id + turn」為 key，approval 與提問以其 id 為 key），重複事件不會重複計數。

「等待人工」涵蓋**兩種**阻塞：工具核准（`approval/asked`／`approval/decided`）與 `ask_user_question` 提問。後者不是 approval，而是普通的工具呼叫：`tool/call` 的 `data.name === 'ask_user_question'` 開啟，`tool/result` 的 `data.message.toolCallId` 關閉；若等待逾時而繼續（`continued`），則由 `user/message` 的 `source.kind === 'user-question-reply'` 關閉。

`TBPF_INDETERMINATE` 在 Windows 11 是**灰色跑動條**，綠色只出現在 `TBPF_NORMAL`——而那個顏色跟隨系統強調色，不是外掛能指定的常數。要把「執行中」弄成綠色，得先把 Windows 的強調色設成綠色；否則 `NORMAL` 會是別的顏色（深色強調色下會幾乎看不見）。所以執行中刻意保留 `INDETERMINATE`：它至少一定看得見。

紅色是**閂鎖（latched）**狀態，不是計時器。它會在下列任一情況清除：

1. **下一個 turn 開始** —— 這是最直接的「已讀」。
2. **DSH 視窗離開前景後又回到前景** —— 每 1 秒比對 `GetForegroundWindow` 的擁有者 pid。注意條件是「離開過再回來」：如果出錯時你就正看著那個視窗，紅燈不會被立刻清掉（否則等於沒顯示），要等你切走再切回來。這個輪詢只在紅燈亮著時存在，閒置時沒有任何計時器。
3. 重載外掛。

若你平常是**用瀏覽器看 Web GUI**，DSH 桌面視窗永遠不會取得前景，那就只剩第 1、3 條會清 —— 這是預期行為，不是故障；可用 `node scripts/probe.mjs --focus` 看目前前景窗屬於哪個行程。

> 兩種狀態都必須先 `SetProgressValue(100, 100)` 再 `SetProgressState`。`TBPF_ERROR`／`TBPF_PAUSED` 只會為**已填滿的部分**上色：只設狀態而值為 0 時，Shell 畫出的是一條空的 1px 細線，看起來像渲染破圖，而不是紅燈。

## 安裝

外掛本身**不安裝任何東西到使用者目錄**，安裝動作是把它掛進 `desktop` profile：

```bash
git clone https://github.com/Joker2377/dsh-taskbar-status.git
node dsh-taskbar-status/scripts/probe.mjs --detect   # 先確認找得到視窗
```

```text
plugin_manager  install_bundle  target = link:<clone>/dsh-taskbar-status
```

`<clone>` 換成上面 clone 出來的目錄；安裝後 profile 的 `dependencies` 會多一條 `"dsh-taskbar-status": "link:<clone>/dsh-taskbar-status"`。

**注意：pnpm 不會為 `link:` 依賴安裝它自己的 `dependencies`**，所以 profile 的 `node_modules` 裡不會出現 koffi；外掛載入 koffi 的順序是：`import('koffi')`（若你在外掛目錄自己 `pnpm install` 就會走這條）→ `DSH_KOFFI_PATH` → 由 `process.execPath` 推導的 `<app>/resources/app/dsh/node_modules/koffi` → `%LOCALAPPDATA%` 的同一路徑。桌面 runtime 內附 3.1.1，因此不裝也能跑。裝完需要讓 host 重新載入（重開 App 或重載視窗）才會生效。

不想用 `plugin_manager` 時，也可以只在 profile 的 `package.json` 加一行 `"dsh-taskbar-status": "link:<clone>/dsh-taskbar-status"`，但那是直接改 profile 檔，屬於需要 `danger-full-access` 的操作，超出本外掛的範圍。

卸載＝移除該 `dependencies` 條目（或 `plugin_manager` 移除 bundle）後重新載入；停用時外掛會主動清掉進度條並釋放 COM 物件。

## 驗證

三段，由外到內，都不需要真的開一次對話：

```bash
npm test                 # 17 個狀態／計數規則測試，不需要視窗，不需要 koffi
node scripts/probe.mjs   # 只驗 FFI：找到視窗，依序顯示灰→黃+閃爍→紅→清除
node scripts/demo.mjs    # 端到端：用假 ctx 驅動真正的外掛碼演一次完整事件序列
```

`probe.mjs` 的選項：`--detect`（只找視窗並印出 hwnd/pid/標題）、`--list`（列出所有可見 top-level 視窗）、`--compare`（A `NORMAL` 60%／B `INDETERMINATE`／C `NORMAL` 100%／D `PAUSED`／E 清除，每態 4 秒，用來目視比對顏色）、`--focus`（印出目前前景窗所屬 pid，診斷紅燈清除條件）、`--pid <n>`、`--title <regex>`、`--ms <n>`（每態停留毫秒）、`--delay <秒>`。

`demo.mjs` 會照這個順序跑：灰（`demo-a` turn 1）→ 黃＋閃爍（核准）→ `demo-b` 開 turn（仍是黃，驗優先序）→ 核准通過（回灰）→ `demo-b` 的 `ask_user_question`（黃＋閃爍）→ 回答（回灰）→ 兩個 turn 結束（清除）→ `demo-a` turn 2 以 `reason.kind === 'error'` 結束（**全紅並留住**，不會自己消失）。

## 實作要點

- **不通知 Electron main。** host 是 `ELECTRON_RUN_AS_NODE` 子程序，`main.js` 的 `child.on('message')` 只接受白名單事件，收到不認得的訊息會直接殺掉 host。程式碼中沒有 `process.send`。
- **找視窗。** `process.ppid` 就是 Electron 主程序；用 `EnumWindows` + `GetWindowThreadProcessId` 找屬於它、`IsWindowVisible` 為真、`GetWindow(h, GW_OWNER) == 0` 的 top-level 視窗。視窗可能重建（縮到系統匣再還原），所以每次更新前都用 `IsWindow` 確認，失效就重找；找不到時退回「行程映像檔名含 DeepSeek Harness」的比對。
- **COM 沒有 interop。** 用 koffi 依 vtable 呼叫：`CoInitializeEx`(STA) → `CoCreateInstance`(CLSID `56FDF344-FD6D-11d0-958A-006097C9A090` / IID `ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf`) → `HrInit`（槽位 3）→ `SetProgressValue`（9）／`SetProgressState`（10），`Release` 在槽位 2。
- **GUID 佈局。** 是 Data1、Data2/Data3 兩個 uint16 併成一個 word、再兩個 word——不是文字順序。順序寫反會得到一個「看起來很合理但反轉」的 CLSID，COM 回 `REGDB_E_CLASSNOTREG` (`0x80040154`)。
- **struct 傳參。** 宣告成 `GUID *` 的參數要直接傳 struct 值（koffi 會傳暫存副本的位址）；`koffi.as(struct, 'GUID *')` 對 struct 無效。
- **狀態來源。** `@deepseek-ai/dsh-session` 每 append 一筆事件就對全域事件匯流排發 `session/event`，外掛 `ctx.on('session/event', (session, event) => …)` 即可。用到的 `event.data`：`turn/start{turn}`、`turn/end{turn, reason:{kind}}`、`approval/asked{id, toolName, callId?, reason?}`、`approval/decided{id, outcome}`；另有 `session/disposed(session)`。`reason.kind` 可能是 `completed | blocked | max-tokens | aborted | interrupted | error`，只有 `error` 算異常結束。
- **`approval/asked` 沒有 turn 欄位。** 所以清理規則不是「比對 turn」，而是：某 session 已無未結束的 turn 時，它所有未決核准一律視為失效（核准本來就只能在 turn 內決定）。

## 已知限制

- 只處理**一個**視窗。同時開多個 DSH 桌面實例時，會作用在優先找到的那一個。
- 視窗縮到系統匣後 `IsWindow` 仍為真但視窗不可見，工作列按鈕也不在，此時設定進度條可能沒有視覺效果；還原後下一次更新會重新套用。
- `explorer.exe` 重啟會讓 `ITaskbarList3` 失效：`SetProgressState` 回非 0 時外掛會釋放並重建，下一次更新恢復。
- `FlashWindowEx` 的回傳值只表示「呼叫前視窗是否在前景」，不是成功與否。
- 非 Windows 平台 `apply()` 直接 return，且不會載入 koffi。
- 工作列功能任何失敗都只寫 `warn` 記錄，不影響 agent 執行。
- 提問只追蹤**直接**的 `tool/call`。若某個 session 透過 code-mode 的 `tool/ptc-dispatch` 間接呼叫 `ask_user_question`，該次提問不會亮黃燈（那條路徑本身就是不阻塞的，工具會立刻拿到 pending 結果）。
- 執行中的顏色不可選：`INDETERMINATE` 固定灰色，`NORMAL` 跟隨系統強調色，`ERROR`／`PAUSED` 才是固定的紅／黃。
- `npm test` 只覆蓋狀態機（事件 → 顯示決策）。Win32/COM 那層沒有自動化測試，靠 `scripts/probe.mjs` 打在真視窗上目視驗證。

## 檔案

- `lib/index.js` — 外掛入口：事件訂閱、計數、優先序、去抖、生命週期。
- `lib/win32-taskbar.js` — FFI 層：koffi 載入、視窗搜尋、`ITaskbarList3`、`FlashWindowEx`。
- `scripts/probe.mjs` / `scripts/demo.mjs` — 上述兩段驗證。
- `test/taskbar-state.test.mjs` — 純邏輯測試。

## 授權

MIT — 見 [LICENSE](LICENSE)。
