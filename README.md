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

就一個連結。

1. 複製倉庫網址：

   ```text
   https://github.com/Joker2377/dsh-taskbar-status
   ```

2. 在 DSH 側邊欄打開 **Plugins**，把網址貼進安裝欄位，按 **Install**。
3. 安裝時若列出待核准的建置腳本 `koffi`，核准後重試一次；它的原生檔案本來就隨平台套件附上（`@koromix/koffi-win32-x64`），不跑那支腳本也能載入。
4. 重新載入 App（重開視窗或重啟），工作列就開始反映狀態。

DSH 會用你貼的連結跑一次 `pnpm add`，把 repo 抓進 profile。不需要先 `git clone`，也不用手動改 profile。

> [!IMPORTANT]
> 貼倉庫**首頁**網址。`https://github.com/.../tree/main` 這類頁面網址會被拒絕（`a URL must point at a git repository or a tarball`）。
>
> 要鎖定某一版，把 commit 接在後面：`https://github.com/Joker2377/dsh-taskbar-status#<commit>`。

> [!TIP]
> 想先確認工作列真的會變色，再決定要不要裝：取得原始碼後跑 `node scripts/probe.mjs`。它不走 DSH 外掛系統，只會找到視窗並依序示範灰 → 黃＋閃爍 → 紅 → 清除。

需求：Windows 10/11、DeepSeek Harness Desktop（koffi 也隨 DSH 內附，載入時兩邊都找）、Node.js `>=22.19`（只有跑驗證腳本時需要）。

解除安裝：在 **Plugins** 頁移除這個 bundle 後重新載入。停用瞬間外掛會清掉進度條並釋放 COM 物件。

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
| 工作列沒有反應（`explorer.exe` 重啟、遠端桌面重連後） | 工作列被重建，舊按鈕的進度條消失，舊的 COM 物件也可能失效 | 下一次狀態變更會比對 `Shell_TrayWnd`，handle 換了就丟掉 COM 物件重畫 |
| 縮到系統匣後看不到 | 視窗不可見，工作列按鈕也不在 | 還原視窗後下一次更新會重新套用 |

## 運作原理

外掛訂閱 `@deepseek-ai/dsh-session` 發佈在事件匯流排上的 `session/event`，把事件換算成「有幾個 turn 在跑、有幾件事在等人」，再用 koffi 直接呼叫 Win32：

- **找視窗**：host 是 Electron 主程序的子行程，所以用 `process.ppid` 反查那個 pid 的 top-level 可見、無 owner 的視窗。每次畫之前驗一次擁有者 pid，不只 `IsWindow`——HWND 被回收給別的行程時 `IsWindow` 仍為真，那樣會把燈畫到別的視窗上。
- **工作列重建**：每次 `render()` 讀一次 `Shell_TrayWnd` 的 handle。handle 變了代表整條工作列被重建（`explorer.exe` 重啟、遠端桌面切換顯示組態），舊按鈕的進度條與舊的 `ITaskbarList3` 都不能再用，於是清快取、釋放 COM 物件、重畫。
- **不通知 main**：不使用 `process.send`。Electron main 的 IPC 是白名單制，收到不認得的訊息會直接終止 host。
- **COM 沒有 interop**：用 vtable 指標呼叫 `ITaskbarList3`（`HrInit` / `SetProgressValue` / `SetProgressState`），必要時加 `FlashWindowEx`。

## 開發

```bash
npm test                 # 34 個狀態機與渲染測試，不需要視窗、不需要 koffi
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
- 工作列重建（`explorer.exe` 重啟、遠端桌面連線切換顯示組態）靠**下一次狀態變更**自癒：外掛在那次 `render()` 比對 `Shell_TrayWnd` 的 handle，換了就清快取、丟掉舊 COM 物件並重畫。沒有常駐心跳，所以從重連到你下一次開新一輪之間，燈不會主動回來。
- 沒有 `tool/ptc-dispatch`、多視窗與 tray 狀態的自動化測試；這些靠 `probe.mjs` 人工驗證。
