# Margin

**Margin** 是一款 100% 从零自研（Clean-Room）、轻量克制的 Chrome Manifest V3 双语阅读与全场景 AI 翻译扩展。

- **仓库主页**：<https://github.com/bjcdeshu/Margin>
- **历史版本归档**：旧版维护分支（`myAItranslate 1.29.1-maint.2`）已完整归档保留于远端分支 [`v1-maint`](https://github.com/bjcdeshu/Margin/tree/v1-maint) 与标签 [`v1.29.1-maint.2`](https://github.com/bjcdeshu/Margin/releases/tag/v1.29.1-maint.2)。

它采用 **Quiet Paper / Unbow Warm Editorial** 暖纸墨色设计体系，彻底告别传统翻译扩展 ~30MB 混淆包与重型本地 OCR WASM 膨胀，剔除页面悬浮球与冗余侧边栏干扰，专注于**网页受控富文本对照翻译、输入框三击空格极速译写、YouTube 字幕时间轴修复与原生双语画中画（Document PiP）、无页数上限双栏 PDF 精读、以及防盗链多模态图片翻译**。

---

## 核心特性

### 1. 网页受控富文本翻译与编辑部纸感样式
- **零 `innerHTML` 受控富文本（`<mN>` 占位符重建）**：在双语对照与仅译文模式下均默认保护段内超链接（`<a>`）、强调格式与行内公式/代码（KaTeX / MathJax / `<math>` / `<code>`），绝不切碎含公式句子；若某段模型漏标占位符，仅对该段自动降级纯文本，绝不弹出全屏报错框或清空整页重翻。
- **四种译文呈现样式**：原生支持 **无样式（None）**、**模糊遮罩（Mask，悬停/聚焦或按 `Alt+M` 清晰显影）**、**淡化（Opacity）** 与 **弱化（Weakening）**，支持按域名规则自动切换样式与 `lineBreakMaxTextCount`（如 `280` 字阈值）。
- **SPA 与虚拟列表零闪烁**：自忽略 `MutationObserver` + 视口 `IntersectionObserver` 分批调度 + 2000 段内存 LRU 缓存，在 Discourse（如 `linux.do`）、X、Reddit 等动态站点流畅滚动不丢译文；支持通配符排除规则（如 `https://linux.do/*`）与局域网地址跳过。

### 2. 输入框极速译写（Input-Box Quick Translate）
- 在网页任意 `<input>`、`<textarea>`、`[contenteditable]` 富文本编辑器（ProseMirror / Lexical / Discourse / GitHub / X / Gmail 等）乃至开放 Shadow DOM 输入框中，**连续按 3 次空格（Triple-Space）** 或按下 **`Alt+I`** 即可原位替换为目标译文。
- **智能语向识别**：输入含中文自动译为英文（可自定义目标语言），已是目标语言则反向互译。
- **原生撤销保护**：优先通过浏览器编辑事务写入，既同步更新 React/Vue 受控状态，又完整保留 **`Ctrl+Z` / `Cmd+Z` 一键撤回原文草稿**。

### 3. 协议解耦渠道引擎与四重 `temperature` 防呆自愈
- **原生多协议支持**：
  - `openai-chat`：OpenAI 及任意兼容 `/v1/chat/completions` 聚合网关（支持域名根目录或 `/v1` 自动补全请求路径而不篡改用户保存配置）、DeepSeek、智谱清言 Zhipu GLM（`glm-4-air` / `glm-4.6` / `glm-4.7` 等，无隐藏 `0.01` 覆盖）。
  - `anthropic-messages`：原生 `/v1/messages` 协议（含多模态图片块与思考模式控制）。
  - `deeplx`：支持多节点 URL 轮询与可选鉴权。
  - `google-web`：内置免配置 `google-free` 免费翻译渠道，开箱即用。
- **多密钥池轮询与限流**：支持逗号或换行配置多把 API Key，遇 HTTP `429` 自动单把冷却 30 秒切换其余可用密钥。
- **四重 `temperature` 根治机制**：
  1. **安全默认 `omit`**：默认完全不发送 `temperature` 字段（彻底根除旧版默认硬塞 `temperature: 0` 与清空输入框 `"" -> NaN` 反复横跳问题）。
  2. **拼写自愈与透明继承**：导入配置时自动修复历史 `"temperatre": 0.3` 拼写并在渠道页实时预览最终生效温度。
  3. **无尾锚推理模型守卫**：对 `gpt-5*`、`gpt-6*`（如 `gpt-6-luna`、`gpt-5.6-luna`）、`*codex*`（如 `gpt-5.3-codex-spark`）、`o1`/`o3`/`o4`、`*reasoner*`、`*thinking*` 自动省略 `temperature`，同时在普通对话模型（`glm-4.7`、`deepseek-chat`、`gpt-4.1-mini` 等）上正常保留助手设定的 `0.3`。
  4. **HTTP 400 自动剥离重试 + 能力记忆**：若任意上游渠道返回 `400`/`422` 提示不支持 `temperature`，立即剥离参数透明重试 1 次（用户无感零中断），并将 `(origin, model)` 写入本地能力缓存，后续请求直通不报错。

### 4. 可插拔提示词编解码器与原词保护术语库
- **Aloxaf `<yaml>` 结构化编解码器**：完整支持 `id`、`thinking`、`trans` 字段、`env` 双遍变量插值、空上下文段落自动裁剪，内置 `yaml` 标准解析 + 容错行状态机双保险，**严格按数字 `id` 对齐回填**，单条缺失绝不导致后续段落或字幕错位。
- **`%%` 流式分隔符编解码器**：兼容经典 `%%` 提示词，支持 SSE 流式边收边渲染，首段上屏延迟极低。
- **术语库原词保留**：支持全局与按域名生效术语；当目标词留空（`v: ""`，如 `LLM`、`LLMs`）时强制保留英文原词不翻译（AI 渠道自动注入提示词，DeepLX / Google Free 自动包裹占位符保护）。

### 5. 视频双语字幕与 YouTube 原生双语画中画（Document PiP）
- **YouTube JSON3 六步时间轴清洗与对齐**：保留零时长/增量字幕、合并 `aAppend` 滚动词块、去重、自动推断并裁剪重叠时长（`[100ms, 30000ms]`），对双轨字幕执行 `±1000ms` 单调最近邻时间戳对齐。
- **独立字幕分批与防串行**：字幕使用独立批次上限（`maxSubtitleBatchCount`，如 `17`），播放点窗口优先极速翻译 + 后台顺延预翻（`preTranslate`），严格按 `id` 锁定时间轴防止句尾词串入下一句。
- **原生双语画中画（Document PiP）**：在 YouTube 播放器控制栏一键开启置顶画中画窗口，直接订阅内部字幕状态总线（零重复请求、零 DOM 抓取），优先通过 `video.captureStream()` 镜像画面（自动回退节点搬运并在关闭时无损归位），内置播放/快进退/静音控制条与键盘快捷键（`Space`/`K`、`←`/`→`、`M`、`Esc`）；在不支持 Document PiP 的环境自动回退原生视频画中画并给出清晰提示。

### 6. 双栏双语 PDF 阅读器与防盗链多模态图片翻译
- **无页数上限双栏 PDF 精读（`pdf.html`）**：按需懒加载 `pdfjs-dist`（浏览普通网页零内存开销），支持本地 `.pdf` 选择、拖拽打开、右键链接打开及在线 URL 加载；自动修复跨行连字符并保护行内公式，对扫描页/纯图页提供一键「视觉模型翻译扫描页」。
- **三级防盗链多模态图片/漫画翻译**：右键图片或悬停大图一键识图翻译；采用 **`Canvas 零网络抓图 → Content Script 带凭据同源请求 → 后台 DNR 动态注入 Referer`** 三级抓取彻底解决 Pixiv 等站点 `403` 防盗链问题，直接复用已配置的多模态大模型识别横竖排对白并渲染 Shadow DOM 原位译文气泡覆盖层。

---

## 安装与加载（Chrome / Edge 开发者模式）

1. 在项目根目录安装依赖并执行构建：
   ```bash
   npm install
   npm run build
   ```
2. 打开 Chrome 或 Edge 扩展管理页：`chrome://extensions`
3. 开启右上角 **开发者模式（Developer mode）**
4. 点击 **加载已解压的扩展程序（Load unpacked）**，选择构建生成的 **`C:\workspace\Antigravity\Margin\dist`** 目录。

> **固定扩展 ID 保障**：`public/manifest.json` 已固化公开的 RSA-2048 SPKI `"key"`（生成时私钥已在内存中即刻销毁，仓库不含任何私钥），固定扩展 ID 为 **`gdkbmfndollgfmblnielgfdpeoabekbf`**。无论后续重装、更新代码还是迁移文件夹路径，`chrome.storage.local` 中的配置永不丢失。

---

## 一键迁移旧版配置（Immersive Translate / `myAItranslate` v1）

1. 点击浏览器工具栏 **Margin** 图标 → 右上角 **⚙（设置）** 打开设置工作台。
2. 切换到左侧 **「配置迁移与诊断」** 页签。
3. 选择旧版导出的 `immersive-translate-config*.json` 文件（或直接粘贴 JSON 文本），点击 **「解析并预览迁移报告」**：
   - 自动识别并优先采用底部 **`userTranslationServices`** 路由（保留 `input`、`subtitle`、`hover`、`image` 的实时 `inherit` 跟随主服务关系，避免误落入顶层陈旧字段）；
   - 自动迁移所有自定义 OpenAI / DeepSeek / Zhipu / Anthropic / DeepLX 渠道、多 Key 密钥池、Aloxaf `<yaml>` 与 `%%` 自定义助手、术语表（含 `v: ""` 原词保留）、`mask` 遮罩主题与 `excludeMatches` 排除列表；
   - 自动修复 `"temperatre"` 历史拼写错误并清理已废弃的悬浮球/侧边栏字段。
4. 核对审计摘要无误后，点击 **「确认应用导入配置」** 即刻生效。
5. **备份与脱敏分享**：在同页导出配置时，默认剥离全部密钥与私有路径 Token（安全可分享）；勾选「包含 API 密钥用于本机备份」即可导出完整无损备份；遇到上游网关异常时可一键复制零密钥「脱敏诊断报告 JSON」。

---

## 快捷键一览

| 动作 | 默认快捷键 / 触发方式 | 说明 |
| :--- | :--- | :--- |
| 切换当前网页双语翻译 | `Alt + A` | 开启或无损还原当前页译文（可在 `chrome://extensions/shortcuts` 自定义） |
| 立即翻译整页全文 | `Alt + W` | 不等待滚动视口，立即批量翻译整页段落 |
| 显隐模糊遮罩（Mask） | `Alt + M` | 在 `mask` 样式下全局切换译文清晰/模糊状态 |
| 输入框极速翻译 | **连按 3 次空格** 或 `Alt + I` | 原位翻译当前焦点输入框，按 `Ctrl + Z` / `Cmd + Z` 可随时撤回原文 |
| 段落悬停翻译 | 按住修饰键（如 `Ctrl`）悬停段落 | 在「输入·字幕·站点规则」开启悬停翻译后生效 |
| YouTube 双语画中画 | 播放器右下角 **Margin PiP 按钮** | 画中画窗内支持 `Space`/`K` 播放暂停、`←`/`→` 快退快进 5 秒、`M` 静音、`Esc` 关闭 |

---

## 开发与测试命令

本项目统一使用 **`npm`** 管理依赖与构建（Node.js `>= 22`）：

```bash
# 安装依赖
npm install

# TypeScript 全量严格类型检查 (tsc --noEmit)
npm run typecheck

# 运行 Vitest 单元与 DOM 集成测试套件
npm test

# 构建生产级 Chrome MV3 扩展包至 dist/
npm run build
```

### 目录结构概览

```text
Margin/
├── public/                 # MV3 manifest.json（含固定公钥 key）、静态规则与 Quiet Paper 图标
├── scripts/                # Vite + esbuild 多入口构建脚本、公钥 ID 与 PNG 图标生成器
├── src/
│   ├── shared/             # 品牌常量、TypeScript 核心契约、四重温度引擎、存储/IPC 与暖纸设计变量
│   ├── core/
│   │   ├── providers/      # P0-1 端点补全、5 大协议适配器、多 Key 池/限流、400 自动剥离重试引擎
│   │   ├── prompts/        # Aloxaf <yaml>、%% 流式分隔符、严格 ID JSON、单句 MT 编解码器与术语保护
│   │   ├── diagnostics/    # schemaVersion:1 零密钥脱敏诊断快照生成与敏感信息擦除
│   │   └── migration/      # 旧版 v1 JSON 一键导入器（inherit 路由优先）与脱敏/全量导出器
│   ├── background/         # MV3 Service Worker：统一 RPC 路由、SSE 流式端口、右键菜单与 DNR 防盗链抓取
│   ├── content/            # 智能段落提取、零 innerHTML 富文本重建、4 种样式渲染、三击空格输入翻译、悬停与划词
│   ├── youtube/            # P0-3 JSON3 时间轴修复、±1000ms 对齐、P0-2 独立字幕分批与双语 Document PiP
│   ├── media/              # 三级防 403 抓图与多模态视觉模型原位气泡覆盖层
│   ├── pdf/                # 双栏纸面双语 PDF 阅读器（懒加载 pdfjs-dist + 扫描页视觉模型翻译）
│   └── ui/                 # Quiet Paper 组件原语、工具栏 Popup 与五栏设置工作台 Options Studio
└── tests/                  # 覆盖核心协议、温度自愈、提示词解析、配置迁移、富文本 DOM、字幕画中画与 UI 的测试集
```
