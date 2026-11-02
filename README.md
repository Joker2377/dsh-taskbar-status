# dsh-taskbar-status

[![test](https://github.com/Joker2377/dsh-taskbar-status/actions/workflows/test.yml/badge.svg)](https://github.com/Joker2377/dsh-taskbar-status/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

*Agent status on your Windows taskbar — grey while a turn runs, amber when it needs you, red after a failure.*

把 agent 的狀態放上工作列：DeepSeek Harness Desktop 的工作列圖示會變成灰色跑動條（執行中）、琥珀色滿條並閃爍（等你決定）、或全紅（上一輪失敗）。純 host 端外掛，不改 `main.js`，不改 `app.asar`。

> [!NOTE]
> 需要 Windows 10/11 與 DeepSeek Harness Desktop `>=0.1.1-rc.2 <0.3.0`。其他平台會直接停用，不會載入原生 FFI。

## 功能

- **四種狀態一眼看穿。** 執行中、等待人工、出錯、閒置，不必把視窗拉到前景。
- **兩種阻塞都算「等你」。** 工具核准與 `ask_user_question` 提問都亮琥珀色，並各閃一次工作列按鈕。
- **多 session 取最強。** 同時跑多個 session 時，等待人工 > 執行中 > 出錯 > 閒置。
- **紅燈不會自己消失。** 出錯是未讀通知，會一直紅到你開始下一輪、或離開視窗再回來。
- **失敗不影響 agent。** 所有 Win32 呼叫都是 best-effort，出錯只寫 warn 記錄。

## 狀態一覽

| 狀態 | 工作列效果 | 進入條件 | 離開條件 |
| --- | --- | --- | --- |
| 執行中 | 灰色不定進度條（`TBPF_INDETERMINATE`） | `turn/start` | 該 session 的 turn 全部結束 |
| 等待人工 | 琥珀色滿條（`TBPF_PAUSED`）＋ 工作列閃爍 | `approval/asked`，或 `ask_user_question` 的 `tool/call` | 核准有結果、提問有回答，或 turn 結束 |
| 出錯 | 全紅（`TBPF_ERROR`） | `turn/end` 且 `reason.kind === 'error'` | 下一輪開始、或視窗離開前景後又回來 |
| 閒置 | 清除（`TBPF_NOPROGRESS`） | 沒有 turn、沒有等待、沒有未讀錯誤 | — |

## 安裝

### 需求

- Windows 10 或 11
- DeepSeek Harness Desktop（內附 koffi 3.1.1，不必另外安裝）
- Node.js `>=22.19`（只有要跑驗證腳本時需要）

### 步驟

1. 取得原始碼：

   ```bash
   git clone https://github.com/Joker2377/dsh-taskbar-status.git
   ```

2. 先確認找得到 DSH 視窗：

   ```bash
   node dsh-taskbar-status/scripts/probe.mjs --detect
   ```

3. 掛進 `desktop` profile：

   ```text
   plugin_manager  install_bundle  target = link:<clone>/dsh-taskbar-status
   ```

   `<clone>` 換成步驟 1 的目錄。這一步只會在 profile 的 `dependencies` 加一條 `link:`，不會複製檔案。

4. 重新載入 App（重開視窗或重啟），外掛就會生效。

> [!TIP]
> 想先確認工作列真的會變色，再決定要不要裝，可以直接跑 `node scripts/probe.mjs`：它不需要 DSH 外掛系統，只會找到視窗並依序示範灰 → 黃＋閃爍 → 紅 → 清除。

解除安裝＝移除該 `dependencies` 條目（或 `plugin_manager` 移除 bundle）後重新載入；停用瞬間外掛會清掉進度條並釋放 COM 物件。

## 使用

### 紅燈要怎麼消掉

紅燈是**閂鎖**，不是計時器。三種清除方式：

1. **開始下一輪** — 最直接的「我看到了」。
2. **離開 DSH 視窗再回來** — 每秒比對前景視窗的擁有者 pid。注意是「離開過再回來」：出錯時你正看著視窗，它不會立刻清掉，否則等於沒顯示。
3. **重載外掛。**

> [!WARNING]
> 如果你平常是**用瀏覽器**看 Web GUI，DSH 桌面視窗永遠不會取得前景，那就只剩第 1、3 條會清。這是預期行為。用 `node scripts/probe.mjs --focus` 可以看目前前景窗屬於哪個行程。

### 為什麼「執行中」是灰色

`TBPF_INDETERMINATE` 在 Windows 11 就是灰色跑動條，顏色不可指定。帶顏色的只有兩種：`TBPF_NORMAL` 跟隨系統強調色，`TBPF_ERROR`／`TBPF_PAUSED` 固定紅／黃。所以執行中刻意保留灰色——把系統強調色改掉確實能讓 `NORMAL` 變色，但那是全系統設定，不是這個外掛能決定的事。

用 `node scripts/probe.mjs --compare` 可以並排看到五種狀態的實際外觀。

### 多個 session

所有 session 共用同一個工作列按鈕，顯示最強的那個狀態。計數以 `session id + turn` 與各自的 approval／question id 為 key，重複事件不會重複計數。每個**新出現**的阻塞各閃一次；已經亮著琥珀色時再來第二個核准，仍然會閃。

## 疑難排解

| 症狀 | 可能原因 | 處理 |
| --- | --- | --- |
| 完全沒有進度條 | 找不到 DSH 視窗 | 跑 `probe.mjs --detect`；必要時用 `--pid <electron-main-pid>` 或 `--title <regex>` 指定 |
| 進度條一閃就消失 | 外掛沒載入或已停用 | 重載 App；檢查 App 日誌有沒有 `taskbar-status` 的 warn |
| 紅燈一直不消 | 你正在用瀏覽器看 GUI，視窗從未取得前景 | 開始下一輪，或重載外掛 |
| 出錯後工作列沒有反應 | `explorer.exe` 重啟過，COM 物件失效 | 下一次狀態變更時會自動重建 |
| 縮到系統匣後看不到 | 視窗不可見，工作列按鈕也不在 | 還原視窗後下一次更新會重新套用 |

## 運作原理

外掛訂閱 `@deepseek-ai/dsh-session` 發佈在事件匯流排上的 `session/event`，把事件換算成「有幾個 turn 在跑、有幾件事在等人」，再用 koffi 直接呼叫 Win32：

- **找視窗**：host 是 Electron 主程序的子行程，所以用 `process.ppid` 反查那個 pid 的 top-level 可見、無 owner 的視窗；視窗重建時自動重找。
- **不通知 main**：不使用 `process.send`。Electron main 的 IPC 是白名單制，收到不認得的訊息會直接終止 host。
- **COM 沒有 interop**：用 vtable 指標呼叫 `ITaskbarList3`（`HrInit` / `SetProgressValue` / `SetProgressState`），必要時加 `FlashWindowEx`。

## 開發

```bash
npm test                 # 32 個狀態機與渲染測試，不需要視窗、不需要 koffi
node scripts/probe.mjs   # 只驗 FFI：找到視窗，依序顯示灰 → 黃＋閃爍 → 紅 → 清除
node scripts/demo.mjs    # 端到端：用假 ctx 驅動真正的外掛碼跑完整事件序列
```

`probe.mjs` 另有 `--detect`、`--list`、`--compare`、`--focus`、`--pid`、`--title`、`--ms`、`--delay`。

CI 在 `windows-latest` 上跑 Node 22 與 24：先 `node --check` 四個入口檔，再跑測試。CI 不碰 FFI 層，那部分只能靠 `probe.mjs` 打在真視窗上驗證。

## 已知限制

- 只處理**一個**視窗；同時開多個 DSH 桌面實例時，作用在優先找到的那一個。
- 提問只追蹤**直接**的 `tool/call`。透過 code-mode 的 `tool/ptc-dispatch` 間接呼叫 `ask_user_question` 不會亮燈——那條路徑本身不阻塞，工具會立刻拿到 pending 結果。
- 只有 `reason.kind === 'error'` 會變紅；`aborted`、`interrupted`、`blocked` 都算正常結束。
- 執行中沒有顏色可選（見上文）。
- 視窗縮到系統匣、`explorer.exe` 重啟等情況靠下一次更新自癒，可能有一個狀態週期的延遲。
- 沒有 `tool/ptc-dispatch`、多視窗與 tray 狀態的自動化測試；這些靠 `probe.mjs` 人工驗證。
