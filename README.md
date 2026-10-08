# 清理精灵 FnClearup

> 智能扫描系统，精准识别已卸载应用、网盘挂载和 Docker 的残留目录及重复文件，一键安全清理 - Node.js 版。

![清理精灵 FnClearup](ICON_256.png)

## v0.12.0 更新

本版是**前端信息架构重构**：15 个平铺 tab 收敛为 4 组 + 7 个 tab，并把功能重叠的入口合并。
**业务逻辑一行未删** —— 全部是导航层重组 + 两处真实缺陷修复。

### 导航分组：15 个 tab → 4 组

原先 15 个 tab 一行平铺，移动端必须横向滚动才能看全，且排列按开发时间堆砌而非用户心智。
现在按使用场景归组，**每组记忆上次停留的 tab**，切走再切回不会跳回组内第一个：

| 分组 | tab |
|---|---|
| **清理回收** | 应用 · 网盘 · Docker · 系统垃圾 |
| **查找问题** | 文件体检 |
| **空间分析** | 空间 |
| **自动化** | 定时 |

响应式要点：组按钮用 `flex-wrap` 自适应，**不依赖 `max-width` 媒体查询** ——
fnOS 移动 WebView 常以桌面 UA + 980 viewport 渲染，断点根本不触发。

### Docker 清理并入 Docker（消除同图标同名的歧义）

原先「Docker」与「清理」两个 tab **图标都是 `container`**，都在操作镜像/容器/卷，用户无法分辨。
现在合并为单 tab 的 5 个二级分区：**镜像 · 容器 · 卷 · 网络 · 缓存**。

- 容器分区即原「已停止的容器」区（含**预览模式 dry_run** 默认开关）
- 缓存分区即原「Build Cache」区（`docker builder prune -af` 高危警告保留）
- Docker 不可用时：提示卡显示，并把「容器 / 缓存」两个入口隐藏，自动退回镜像分区

### 系统 + 临时文件 + 回收站 → 「系统垃圾」

三者都是「扫临时垃圾 → 分级清理」，语义高度重叠。合并为单 tab 3 个二级分区：
**系统缓存 · 临时文件 · 回收站**，每个分区保留各自独立的 KPI 卡片。

### 六个扫描型 → 「文件体检」

`去重 / 相似 / 异常 / 重名 / 空目录 / 大文件` 六者的 API 三段式
（scan → status 轮询 → stop）与 UI 组件本就同构，合并为单 tab 6 个二级分区，**结果区各自独立**。

### 🐛 修复：20 条 CSS 选择器随合并静默失效

合并只搬了 HTML，CSS 里 `.tab-panel[data-panel="trash"]` 等 **13 + 6 + 1 条**规则仍指向已删除的
panel。这类失效**不报错、只是样式消失** —— 回收站整套移动端 KPI 布局（固定 2 列 + 第 5 张跨列）
差点报废。已全部改为 `.inner-panel[data-inner-panel="recycle"]` 等，并新增一条测试扫描所有
`[data-panel=]` 选择器，不允许指向已不存在的 panel。

### 🐛 修复：二级分区互相抹除 + 位置丢失

- **互相抹除** — `switchInnerTab` 原用全局 `.inner-tab-btn` 选择器。出现第二组 inner-tab 后，
  切一次 Docker 会把系统垃圾的激活态一起清掉。已限定到 `.tab-panel.active` 内。
- **位置丢失** — `switchTab('scan')` 里写死默认分区，用户在「大文件」分区切走再切回会被弹回第一个。
  新增 `panelInnerLastTab`，三个多分区 tab 各自记忆上次停留的分区。

### 兼容性

**10 个旧 tab 名全部保留别名重定向**，旧书签与历史调度任务不会失效：

```
dup/simdup/broken/namematch/empty/bigfiles  → 文件体检的对应分区
sysclean/temp/trash                          → 系统垃圾的对应分区
dockercleanup                                → Docker / 容器
```

### 测试

`269 passed / 0 failed`（较上一版 +24 项）。新增分组与合并回归测试覆盖：组/分区归属一致性、
每个功能 id 唯一且未丢失、两组 inner-tab 互不重叠、CSS 不得指向已删除 panel、
二级分区记忆、全局 modal 未被卷入或丢失。

## v0.11.2 更新

本版聚焦**性能对齐行业基线**、**删除安全**、**多目录选择**与**移动端可用性**。

### 性能：哈希并发按介质自适应

- **问题** — 哈希 worker 原硬编码 4 个。本机是 **Intel Celeron J3355 双核** +
  `sda`/`sdb` **机械盘 RAID1**(WD43PURZ) + `sdc` 固态盘，固定 4 既是 2 倍 CPU 超订，
  又让机械盘多线程随机读产生寻道竞争。fclones 官方文档明确建议机械盘用
  `--threads 1`，并报告过 2x~10x 的性能差异。
- **修复** — 新增 `app/storage_profile.js`，读 `/sys/block/<dev>/queue/rotational`
  判定扫描目标所在卷的介质类型（自动穿透 LVM / device-mapper）：
  **机械盘降为单线程 / 固态盘取 `min(4, CPU 核数)` / 介质无法确定时保守按机械盘处理 /
  多路径混合时取更保守的一侧**。推导结果写入任务状态并输出日志：
  `[dup_scan] 哈希并发度=1 · 机械盘(/vol2) — 单线程避免寻道竞争`

### 性能：partial 预筛采样量 4KB → 32KB

- 每段 4KB 区分度不足，MP4/MOV/ISO/压缩包文件头高度雷同，大量文件被迫进入全量哈希。
- 改为**头尾各 32KB（合计 64KB）**，对齐 file-deduplicator 的头尾 64KiB 水平。
- **只加大单段读取、保持 seek 次数恒为 2** —— 机械盘上多一次 seek 的成本（数毫秒）
  远高于多读几十 KB，因此**不加**中段采样点。

### 🔒 安全：保护 fnOS 系统目录与卷内回收站（P0）

- **问题** — 删除校验的白名单只到卷粒度（`/vol*`），导致
  `/vol3/@appcenter`（**所有应用的安装目录**）、`@appdata`、`@appmeta`、`@apphome`、
  `@appconf`、`@appshare`、`@apptemp`、`@sysappmeta`，以及 `/volN/<uid>/.@#local`
  （**卷内回收站**）**全部通过校验**。重复扫描命中各应用的同名 LICENSE/图标后勾选删除，
  会**误删其他应用文件导致应用起不来**。
- **修复** — 用**精确名单**（非 `@` 前缀正则，避免误伤用户自建的 `/vol1/1000/@我的相册`）
  拦截上述 8 个系统目录 + 回收站；删除/大文件/空目录三个端点接入并回传**拦截数量与逐条原因**，
  前端明确提示「N 个受保护未删除」。
- **刻意不接入应用卸载器**(`app.js`) —— 它的语义就是卸载应用（删除目标本就是 `@appcenter`），
  接入会废掉卸载能力；只读端点不接入（仍可「看到」系统目录里的重复文件，只是删不掉）。
- **自身数据目录差异化豁免** — 读写场景豁免（要写哈希缓存/manifest/导出），
  删除场景**一律不豁免**（否则清理工具会把自己的缓存和审计清单一起删）。

### 🚀 扫描排除规则（可自定义）

- **问题** — 原先扫描除最小体积外无任何路径排除，每次扫 `/vol1` 都要把 `@appdata`
  的 SQLite、`node_modules`、`.git`、Docker overlay 全走一遍；哈希缓存虽能跳过重复计算，
  但 `walk + statSync` 的元数据开销跑不掉，且系统目录里发现的"重复文件"多半是各应用
  共用的 LICENSE/图标，对清理没有价值。对标 fclones 的 `.hashignore`。
- **修复** — 新增零依赖 `app/exclude_rules.js`，`dup_scan` 与 `simdup_scan`
  在 **readdir 之后、stat 之前**剪枝（目录整棵跳过）；规则落盘
  `<TRM_PKGVAR>/data/scan_exclude.json`，`GET/POST /api/dup/exclude-rules` 读写，
  重复文件面板提供折叠式编辑区（展开时才懒加载）。
- **匹配语义** — 不含 `/` 的规则按**路径段**匹配（任意层级，支持 `*` `?`）；
  含 `/` 的按路径模式匹配（`**` 任意层、`*` 单层）；`/` 开头为绝对路径前缀。
  空规则 = 不排除任何内容；文件缺失或损坏时**回落到默认规则，绝不中断扫描**。
- **默认 18 条** — `@app*` / `@sysapp*`（覆盖 fnOS 全部 8 个系统目录）、
  `node_modules`、`.git`、`__pycache__`、`lost+found`、`overlay2` 等。
  刻意**不用** `@*` —— 那会误伤用户自建的 `/vol1/1000/@我的相册`。
  注意这是"跳过扫描"（性能），与删除保护（安全）是两回事，后者用精确名单、从严。

### 🚀 哈希缓存命中统计可见化

统计区新增「缓存命中 · 新哈希 N」与「预筛已排除」卡片，命中率 ≥80% 为常规色、<80% 走告警色。
实测（机械盘 `/vol2`，100 文件/30 组重复）：**冷启动 0 命中 / 60 哈希 / 0%**，
**二次扫描 60 命中 / 0 哈希 / 100%** —— 缓存确实是有效的，只是以前看不见。

### 🚀 相似文件显示相似度并支持并排对比

- **相似度透出** — 此前 dHash 距离算完就丢掉了。现在每文件输出 `minDist`、每组输出
  `minDist` + 最相近的 5 对，**按相似度升序排列**（最像的组排最前），前端新增「相似度」列并分档着色。
  实测同源 3 张：`a0~a2=2 (97%)`、`a0~a1=5 (92%)`、`a1~a2=7 (89%)`；异源 2 张未误聚。
- **并排对比** — 新增 `GET /api/simdup/thumb` 缩略图 API（320px JPEG，ffmpeg 抽帧取第 1 秒避免黑屏），
  缓存于 `<TRM_PKGVAR>/data/thumbs/`（键含 `size+mtime`，文件一变即失效）；
  组号改为可点击按钮，点开用**原生 `<dialog>`** 并排展示该组全部缩略图 + 名称 + 大小 + 各自相似度。
  选型说明：原生 `<dialog>` 而非自定义 modal —— fnOS WebView/CEF 下自定义 overlay 常出现
  `getComputedStyle` 显示正常但视觉层不渲染的问题。

### 🚀 四个 Tab 统一为去重风格的多目录选择

**相似 / 异常 / 重名 / 大文件** 原先都是单个文本框（大小文件还是下拉），只能选一个目录。
现全部改为与去重一致的**目录标签列表 + 「📁 添加目录」**，可一次添加多个目录。

- `simdup` / `broken` / `namematch` 后端本就接受 `paths` 数组，属**纯前端改造**；
  `bigfiles` 后端只接受单个 `path`，改为 `getAll('path')` 读重复参数并累积去重 `roots`，
  **保留单 path 与不传（= `/vol*`）的旧行为**兼容旧调用方。
- 现有 `renderDupPaths` / `removeDupPath` / `showDupBrowseModal` 三个组件本就只依赖
  `tab + 'PathList'` 这个 DOM id 与 `DupState[tab].paths`，因此**组件代码一行未改**。

### 🐛 修复：全站按钮点击无反应（P0 回归）

- **根因** — 插入 `blockedNotice` 时锚点只取到 `showToast` 里的 `setTimeout` 那一行，
  **把 `showToast` 的闭合 `}` 吞掉了**，导致其后插入的所有函数都落在 `showToast` 的**函数体内**。
  模块作用域的 `exports` 块引用它们时抛 `ReferenceError`，`init()` 中断，
  `Object.assign(window, exports)` 从未执行 → **全站按钮无任何绑定**。
- **为什么没被拦住** — 这类错误**语法完全合法**，`node --check` 通过；字符串断言类测试也查不出
  （它们只检查"这段文字在不在"）。必须**真把 main.js 跑起来**。
- **防回归** — 新增 `tests/test_main_js_loadable.js`：用 DOM stub **真实加载 main.js**，
  断言 `init()` 不抛错、`window` 上挂出函数；另有精确断言 `showToast` 在 8 行内闭合。

### 🎨 移动端布局修复（据真机截图）

- **回收站 KPI 卡片** — 原硬编码 `repeat(5,1fr)`，移动端也强制 5 列 →
  数值被截成 `3._`、标签完全消失、第 3 张卡被屏幕右边缘裁掉。
  改为**固定 2 列 + 第 5 张跨列收尾**，通栏卡内标签贴左、数值贴右。
  验证方式：抽出真实 CSS 组成预览页，用 CDP 把视口设为 **360×780** 模拟 fnOS WebView，
  逐卡读取 `getBoundingClientRect` 与 `scrollWidth` 确认无截断无溢出，并截图肉眼复核。
- **回收站列表卡片** — `.trash-card-path` 原用 `word-break:break-all`，长路径被**逐字符**折成竖条
  （这正是"叠在一起"的观感来源）；改为 `overflow-wrap:anywhere` + 限 3 行，完整路径用 `title` 查看。
  容器改用 `grid auto-fit`，**不依赖媒体查询** —— fnOS 移动 WebView 常以桌面 UA 渲染，
  `max-width` 断点根本不触发，写进媒体查询等于没写。
- **回收站按钮区** — 原基础规则里没定 `display`，宽度逻辑全在媒体查询里，导致窄屏下
  「浏览内容」半宽左对齐、与上方全宽按钮和 2 列网格宽度不一致。统一为 grid，
  高危的「全部清空」独占一行并加红色边框，与可逆的分级清理拉开层级。

### 测试

**245 passed / 0 failed**（基线 171 → +74）

## v0.11.0 更新

- 🐛 **CSRF 安全校验** — 新增 POST 写操作跨站请求防护（P0-2 审计修复）：有 `X-Trim-Userid`（fnOS 网关认证）的请求直接放行，无认证请求按 `Sec-Fetch-Site: cross-site` 判断，本地直连不受影响
- 🐛 **sysclean 路径安全加固** — 裸目标 id（如 `syslog-gz`）不再能直接执行清理，必须通过子项 id（`syslog-gz:syslog.1.gz`）操作；glob 路径（`/vol*/@appcenter`）清理功能恢复正常
- 🐛 **所有扫描页面统一目录浏览** — 空间/相似/异常/重名页面均添加 🔍 目录浏览器按钮，与去重页面一致
- 🚀 **P2-3 去重双段预哈希** — 去重预筛升级为首尾双段 4KB（Czkawka 风格，替代原 jdupes 单段头部）：
  - 先哈希文件**头 4KB + 尾 4KB**，头部相同但尾部不同的文件（截断/剪切不完整副本）直接被预筛排除，**不再做全文件哈希**
  - 实测：4 个同大小文件中 2 个"头同尾不同"被正确跳过，仅 2 个真重复走全量哈希
  - 与大小分组 + 哈希缓存叠加，大幅减少大文件全量读取
- 🚀 **P2-2 重名冲突检测（新增「重名」Tab）** — 找出散落在**不同目录**下的同名文件（不区分大小写）：
  - 扫描目录内 80,000 个文件，按文件名分组，仅报告跨目录重名的组
  - 每组显示文件名、份数、总大小、各副本位置，按占用从大到小排序
  - 纯目录遍历 worker，无 ffmpeg 依赖，可停止
- 🚀 **P2-1 下载残留检测（异常 Tab 新增类别）** — 识别半截下载文件：`.part` / `.crdownload` / `.download` / `.partial` / `.aria2`，第 5 类 KPI + 分类切换
- 🚀 **系统清理分类分组（P1-1）** — 系统缓存清理从单一列表升级为标准分类浏览（对齐 MangoDisk）：
  - **5 类分组** — 系统 / 日志 / 开发 / 浏览器 / 应用，每项带分类徽标（彩色 badge）+ 分类筛选单选
  - 释义：开发缓存（npm/pip/uv/Playwright）、浏览器缓存、应用缓存、系统缓存、日志轮转
  - **修复 syslog 历史日志 regex 损坏** — `/\\.1$/` 历史日志匹配因转义损坏从未生效，现已修复（`syslog.1` 等正确识别）
- 🚀 **P0-3 异常文件检测（新增「异常」Tab）** — 检测三类异常文件：
  - **空文件** — size=0 的占位/损坏文件
  - **无效软链接** — 指向不存在 target 的失效符号链接
  - **损坏媒体文件** — 用 ffmpeg 解码探测（可选开关），识别损坏/不可解码的图片视频
  - 分类切换查看 + 扫描进度 + 子进程隔离 + 可停止
- 🚀 **P0-2 相似图片/视频检测（新增「相似」Tab）** — 感知哈希（dHash）识别"相似但不完全相同"的文件：
  - **相似图片** — 差分感知哈希 + 汉明距离聚类，能识别同图不同分辨率/水印/亮度/格式（比 SHA-256 更强的视觉相似）；基于 ffmpeg 解码缩放（fnOS 自带 ffmpeg，纯 Node 零 npm 依赖）
  - **相似视频** — 抽首/中/尾 3 帧做 dHash 综合比对，识别同一视频的不同转码/分辨率版本
  - **三档阈值** — 严格(≤6) / 标准(≤10) / 宽松(≤16) 可调
  - **子进程隔离扫描** — worker 进程 + stateFile + 轮询进度，可停止，不阻塞 server
  - 安全白名单（仅 `/vol*`），真实环境验证（复制对识别 100% / 不同内容不误报）
- 🚀 **P0-1 磁盘空间分析（新增「空间」Tab）** — 全新磁盘占用分析模块，帮你快速看清空间去哪了：
  - **卷用量总览** — 基于 statfs 瞬时返回每个 `/vol*` 卷的已用/可用/总容量（无需慢扫描），带用量进度条（≥90% 红 / ≥70% 黄 / 其余蓝），KPI 显示总已用、总容量、最大卷
  - **目录下钻排行** — 分析任意卷/目录，递归统计占用最大的子目录 Top-40，带占比条 + 可一键继续下钻
  - **文件类型分布** — 按 8 类（视频/音频/图片/压缩/文档/安装包/代码/其他）统计字节数与数量，横向堆叠条 + 图例呈现
  - **顶层大文件** — 同步列出当前目录最大 Top-20 文件
  - 纯 Node 遍历 + BFS 可中断（`/api/diskanalysis/stop`），安全白名单（仅 `/vol*`）
  - **测试覆盖：6/6**（statfs 字段 / 类型分布 / maxDepth / 白名单安全 / stop）

## v0.9.8 更新

- **🚀 去重引擎三阶段优化**（参照 jdupes 算法）— 文件去重从「全量 SHA-256」升级为「size → 部分头哈希预筛 → 全量哈希」三级流水线：
  - **部分哈希预筛** — 先只读每个文件头部 4096B 做哈希，头部不同的文件直接排除，大幅减少大文件（视频/图片/压缩包）的全量读取
  - **持久哈希缓存** — 扫描结果按 `(大小 + 修改时间)` 持久化到 `dup_hash_cache.json`，未变文件跨运行直接复用哈希、跳过读取，二次扫描速度大幅提升
  - **智能保留策略** — 每组重复文件默认保留**路径最深**的一份（最有可能是有意保存的版本），可选「最新修改/路径最早」；前端去重面板新增保留策略 + 最小文件大小筛选
- **🔗 硬链接去重** — 删除弹窗新增「硬链接去重」模式：把重复文件原地替换为指向原始文件的硬链接，删除重复数据块但文件仍可访问，同卷即刻释放空间（不在回收站，无恢复需求）
- **📁 去重后空目录联动** — 删除/硬链接后自动检测变为空的目录，toast 提示用「去空」一并清理
- **测试覆盖：106/106**（+9：三阶段专项 5 项 + hardlink/emptyDirs 4 项）

## v0.9.7 更新

- **全面功能检测** — 97/97 测试通过；完整 API 冒烟验证（应用/网盘/Docker/temp/dup/empty_dir/bigfiles/trash/sysclean/schedule/quick-summary 全部 200 闭环）
- **优化**：header 工具栏按钮垂直居中对齐（`align-items:center`）
- 修复已包含：同步删除关联系统用户失效、应用残余卸载失败、去重浏览弹窗 ENOENT、根路径卷条目不可点击

## v0.9.6 更新

- 修复：同步删除关联系统用户失效（`@app\d+` 正则无法匹配 `@appcenter`/`@appstore` 字母目录，用户永远不删）——改为匹配任意 `@app*` 目录，并增加 uid≥900 守护（不误删系统保留用户）
- 修复：应用残余卸载失败（`@appcenter` 路径不匹配回收站 regex，改为永久删除）

- **修复：去重浏览弹窗 ENOENT 报错** — `showDupBrowseModal` 默认从 `DupState.paths` 最后一个路径开始浏览，当路径不存在（如 `/vol1/1000/music`）时 API 返回 500 ENOENT，弹窗显示错误。改为从 `/` 根目录开始浏览
- **修复：根路径卷条目不可点击** — 根路径 `/` 浏览返回的卷条目缺少 `isDirectory:true`，前端渲染为不可点击的 📄 文件图标，导致只能添加 vol1 下目录无法添加 vol2/vol3
- **测试覆盖：87**

## v0.9.2 更新

- **新增：去重多目录扫描** — 目录浏览支持选择多个目录同时查重，音乐/文件去重面板均可添加多个扫描路径
- **修复：去重扫描后端** — `handleDupScan` 接受 `paths` 数组替代单 `path`，遍历所有路径收集文件
- **修复：外部分支扫描脚本** — `dup_scan.js` 支持逗号分隔多路径参数
- **测试覆盖：84**

## v0.9.1 更新

- **修复：P0 文件名截断损坏** — `app.js` / `empty_dir.js` / `temp.js` 三处 trash 重命名用 `slice(0, ext.length)` 保留 stem 前 N 字符（例：`data.bin.gz` → `dat_1.gz`），改为 `slice(0, -ext.length)` 正确去掉扩展名
  - `app.js` 删 29 行重复 `moveToTrash`，统一 import from `trash.js`
- **修复：execCmd 超时不杀进程** — `spawn({timeout})` 超时后只发 SIGTERM 不强杀，`rm -rf` 在 fuse 挂载点挂死后事件循环永久阻塞。改为 SIGTERM → 5s 宽限期 → SIGKILL 兜底
- **修复：bigfiles sibling threshold 测试假阳性** — 原测试永远不触发阈值（fixture 只有 1 文件），断言 `typeof === 'boolean'` 空通过。新增独立测试 `tests/test_bigfiles_sibling_threshold.js`：环境变量 `TRM_FNCLEARUP_SIBLING_THRESHOLD=5` + 7 entry fixture + 断言 `skipped_subtree===true`
- **测试覆盖：84 → 85**（含 standalone sibling threshold 测试）

## v0.9.0 更新

- **🐳 新增：Docker 清理 Tab** — 一键清理已停止容器 (`exited`/`created`/`dead` 状态) 和 Docker Build Cache
  - 容器 ID 严格 regex 校验（`^[a-f0-9]{12,64}$`），防止参数注入
  - `dry_run: true` 默认强制预览，删除前必显式确认
  - `/var/run/docker.sock` 不存在 → 干净降级到「Docker 未检测到」独立 panel
- **🐘 新增：大文件查找器 Tab** — 跨 `/vol*` 卷扫描 ≥ 100 MB 文件 Top 100，支持 minSize/topN/depth 三档过滤，5min hard timeout + setImmediate yield 可在 ~1s 内停止
- **🧹 修复：sysclean HOME 硬编码**（P0 真 bug）— `root` 跑只清 root 缓存，多用户 NAS 漏清理其他用户的 npm/pip/uv/Chromium 等
  - `getUserHomes()` 自动发现所有 `/vol<N>/<UID>` 数字 UID 目录
  - USER_CACHE_TEMPLATES × N 用户展开成独立清理项
  - `excludeSingleChildNames` 防重复
- **测试覆盖：60 → 78**（+18 新增，含恶意 ID 注入防护测试）

## v0.8.1 更新

- **修复：定时清理全面代码审计** — 审查发现并修复 8 项 P1 问题，涵盖 API 字段不匹配、路径提取错误、HTML 属性注入等

  - **应用残余不清理** — `/api/scan` 返回 `orphan` 对象数组未取 `.path`，全被 `isSafePath` 过滤
  - **Docker 清理不工作** — `imgRes.data?.unused` 路径错误（应为 `?.images?.unused`），`volRes.data?.orphans` 路径错误（应为 `?.volumes?.orphan`），`netRes.data?.networks` 是对象不是数组 → 崩溃
  - **Temp 清理不工作** — 用 `f.atime` 过滤但 API 返 `age_hours`，`delRes.data?.deleted` 是数组当数字
  - **Trash 清理不工作** — `data.totalItems/size` 不存在（实际在 `data.totals`），`cleanRes.data?.cleaned` 不存在（实际是 `deleted.length`）
  - **镜像删除计数为 0** — 读 `deleted` 但 API 返 `total`
  - **磁盘清理死代码** — 读 `orphans` 但 API 返 `vol02_dirs`
  - **🧾 文件清单按钮无反应** — `JSON.stringify` 双引号闭合 HTML `onclick` 属性
  - **3 处非原子写入** — `writeFileSync` 直接写，崩溃丢数据
  - **mkdirSync 无异常保护** — 磁盘满时崩溃
  - **isRunning 锁无 finally** — 异常时永久锁死定时器

- **新增：定时清理计划** — 支持 5 种清理类型（应用残余/网盘挂载/Docker/tmp/回收站），可配置时间、间隔，自动执行并生成清理报告
- **新增：定时清理前端配置** — 独立设置面板，各清理类型可独立启停，支持子选项（Docker 镜像/卷/网络分别控制）
- **新增：定时清理执行报告** — 每次清理自动生成详细报告（清理项/错误/耗时），保留历史记录与报告文件
- **密码和配置的0.7.x遗留问题修复** — 代码审计 14 项 P0/P1/P2 全面修复

## v0.7.12 更新

- **新增：去重结果前端分页** — 大量重复文件时分批加载，新增「加载更多」按钮
- **优化：去重 KPI 卡片显示总数** — 后端返回总匹配组数，前端实时展示

## v0.7.11 更新

- **修复：系统清理忽略 `/boot` 目录** — 移除 SCAN_TARGETS 中的 `old-kernels` 项（vmlinuz/initrd.img/System.map 等关键内核文件），避免误删导致系统无法启动。内核清理应通过 `apt` 单独处理

## v0.7.10 更新

- **新增「🗑 回收站」Tab** — 批量清理 `/vol<N>/<UID>/.@#local/trash/`，按 mtime 30/90/365 天分级清理
- **KPI 五联** — 30 天+ / 90 天+ / 1 年+ / 总占用 / 顶级目录数（颜色梯度从浅到深绿）
- **5 档清理按钮** — `30 天+` / `90 天+` / `1 年+` / `🔥 全部清空`（二次确认）/ `👁 浏览内容`（只读）
- **多 vol × 多 UID 扫描** — 自动扫 `/vol1-10` + `/vol01-09` + `/vol02`（fnOS 网盘 fuse mount）× 所有数字 UID
- **路径遍历防护** — `isTrashPath` 严格白名单 + `..` 段直接拒
- **Manifest 备份** — 清理前自动写 JSON 到 `data/manifests/`，记录 path/size/mtime/note「回收站删除后无法恢复」
- **root 权限包含所有用户** — fnclearup 以 root 跑，扫描全设备 trash 目录，单表展示（vol + UID + 路径 + 文件数 + 目录数 + 大小 + 最老 mtime）
- **回收站清理预览按 mtime 过滤** — 弹窗只列实际会被删的目录（之前 bug：列了全部 4 个 trash 目录不管 mtime）
- **回收站 Tab 移动端自适应** — 5 个 KPI 保持全局 3 列布局（跟其他面板一致），移动端 480px 下按钮变 2 列网格 + 表格切卡片布局 + 2 个 modal 全屏
- **新增「🧹 系统清理」Tab** — 17 项扫描目标：APT 缓存/列表、syslog .gz/.1、journal、npm/pip/uv/node-gyp/typescript 缓存、4 个浏览器缓存、Playwright、其它 ~/.cache、应用日志 (>50MB)、旧内核（危险默认不勾）
- **系统清理风险过滤** — 全部 / 仅低 / 中+低 三档 radio，KPI 实时显示可清理项 / 总可释放 / 已选中
- **「✅ 推荐清理」一键按钮** — 自动勾选 10 项 100% 无风险的（apt / syslog / npm / pip / uv / node-gyp / typescript），其他项系统自动重建
- **清理前自动备份 manifest** — 开关默认 ON（localStorage 持久化），清理前写 JSON 到 `data/manifests/`
- **「📜 历史清单」按钮** — 弹窗列出所有历史 manifest（mtime 倒序），支持「👁 查看」+「⬇ 下载」

## v0.7.9 更新

- **修复：扫描期间点击其他功能（如目录浏览）无响应** — 根因是空目录扫描的 `walk()` 是同步递归调用，会**阻塞整个 Node.js 事件循环**。扫描运行时整个 server 停止响应所有 HTTP，浏览/stop 请求排队等扫描完才被处理
- **修复：walk/collect 改为 async，每 200 目录 `await setImmediate()` 让出事件循环** — 这样扫描期间 server 仍能响应 browse/stop
- **修复：emptyDirJobs 在 setTimeout 前先注册** — 这样 stop 请求**立即**能找到 job（之前要等 runScan 整个 promise 链完成后才注册）
- **新增 stop 提前到达的处理** — 用 `aborted_flag.early` 标记 stop 比 scan 早到的情况，runScan 解析后检查并立即退出
- **测试 60/60 通过** — 新增用例：扫描 500 目录中途并发发 stop + browse，验证两者都在 5s 内响应

## v0.7.8 更新

- **新增启动警告弹窗** — 每次打开应用立即弹出「⚠️ 清理有风险，确认需谨慎！！！」，必须阅读 3 秒后才能点「✅ 我已知晓风险」（防止用户没读就点）
- **弹窗内容** — 红底警示框列出 3 条强制确认项（已备份/了解目录含义/勾选前再次确认）+ 强推荐「清理前写 manifest」开关提示 + 回收站恢复路径说明
- **关闭行为** — 「我已知晓风险」关闭弹窗 + toast 提示；「稍后再说」也关闭弹窗（每次重新进入应用都会再弹）

## v0.7.7 更新

- **Manifest 目录调整** — 改写到 `<TRM_PKGVAR>/data/manifests/`，跟 `info.log`、`app.pid` 在同一个父目录（fnOS 标准 `data/` 子目录组织）。不再写到 `/vol*/UID/.@#local/`
- **删除 UI 提示** — 开关旁"写到 .@#local/，仅记路径不复制文件"那句删了，确认弹窗和 toast 文案同步更新
- **`getSafeTrashDir` → `getManifestDir` 重命名** — 旧函数保留为 alias，避免破坏其他引用
- **测试 58/58 通过** — 新增 2 个用例验证 `base_dir` 和 `backup_path` 都在 `/data/manifests/` 下

## v0.7.6 更新

- **🧹 新增「系统缓存清理」Tab** — 14 项可清理：APT 缓存/列表、系统日志轮转、NPM/PIP/UV/Node-gyp/TypeScript 缓存、浏览器缓存、Playwright 浏览器、其它 `~/.cache` 自动发现、应用日志、旧内核
- **✅ 「推荐清理」一键勾选** — 10 项低风险、auto-rebuild 的安全项（apt/npm/pip/uv/.gz 等），最常用的"无感清理"
- **📦 清理前备份 manifest** — 每次清理前先写一份元数据（路径/size/mtime/时间戳/工具版本/主机/用户）到 `<TRM_PKGVAR>/data/manifests/fnclearup_pre_clean_manifest_<时间>.json`（仅记录，不复制文件）。跟 `info.log`、`app.pid` 在同一个父目录（`<TRM_PKGVAR>`），按 fnOS 标准 `data/` 子目录组织
- **📜 历史清单弹窗** — 「📜 历史清单」按钮列出所有历史 manifest，可下载查看（审计/回溯用）
- **新 API 端点** — `GET /api/sysclean/manifests` 列出、`GET /api/sysclean/manifest?path=...` 下载
- **安全加固** — `handleSysCleanGetManifest` 白名单（必须位于 `getSafeTrashDir()` 下 + 文件名 `fnclearup_pre_clean_manifest_` 前缀 + `.json` 后缀）拒绝路径遍历
- **风险过滤 UI** — 「全部 / 仅低风险 / 中+低」radio 切换即时刷新列表
- **getSafeTrashDir() 工具函数** — 按优先级返回 `getSafeTrashDir()`：用户 vol1-vol10 → `/var/fnclearup` → 测试模式 `/tmp/fnclearup_test/manifests`
- **测试 56/56 通过** — 新增 6 个用例：备份写入、不备份、清单列表、清单下载、路径遍历拒、缺参拒

## v0.7.5 更新

- **5 个 modal「确认删除」按钮修复** — 之前调错函数（`confirmXxx` 而非 `doXxx`），点击只重开 modal 不执行删除
- **安全加固 (P0/P1)** — 4 个删除端点加 `isSafePath` 白名单，handleBrowse 加 `/vol*` 白名单，dup export 加 CSV 注入防护
- **删除用户强警告** — 双重 `confirm()` 弹窗 + ⚠️ 红色警告
- **Docker 删除确认** — 3 个 docker 删除（卷/网络/镜像）加 modal-overlay 确认弹窗
- **empty_dir 重写** — 加 stop API、跳过 `@app*` 系统目录、流式扫描 + state file 保留（修复 complete 状态提前消失 bug）
- **数据隐私清理** — 删除 `app/data/` 4 个测试 JSON（含真实扫描路径）
- **CORS 环境变量** — 改用 `CORS_ORIGINS` 逗号分隔
- **删除冗余代码** — `app/ui/utils.js` 3 个未使用函数清理
- **测试 39/39 通过** — 新增路径遍历、CSV 注入、HTML onclick 契约测试

## v0.7.2 更新

- **空目录清理** — 新增「去空」选项卡，扫描目录下的空目录，一键清理（单删/批量删/回收站/永久删）
- **实时扫描进度** — 扫描中实时显示当前正在扫描的目录路径，每 10 个目录更新一次
- **移动端适配** — 空目录列表支持水平滚动和路径自动换行
- **错误防护升级** — 加入 `uncaughtException` 和进程退出码检测，子进程崩溃不再静默消失
- **忽略 .@#local** — 空目录扫描跳过 fnOS 回收站目录
- **版本号统一为 0.7.2**

## 功能特性

- **自动扫描** — 动态发现系统中所有 vol 卷（`/vol1` ~ `/vol10` 及 `@app*` 目录）
- **孤立目录检测** — 交叉比对已安装应用列表与实际文件目录，精准识别残留孤立目录
- **多选删除** — 支持批量勾选，一键清理，附确认弹窗与路径预览
- **明暗主题** — 支持手动切换（深色/浅色）
- **Tab 切换** — 应用 / 网盘 / Docker / tmp / 去重 / 去空 / 系统清理 / 回收站 独立展示
- **KPI 卡片** — 显示卷总数、已挂载数量、未挂载数量
- **Docker 卷管理** — 查看在用卷/残余卷，一键批量删除
- **Docker 网络管理** — 扫描未使用网络，一键批量删除
- **Docker 镜像管理** — 查看未使用镜像，一键批量删除
- **tmp 清理** — 扫描 `/tmp` 和 `/var/tmp` 下 24h+ 未访问的文件，一键清理
- **文件去重** — SHA-256 哈希比对，智能分组显示重复文件
- **音乐去重** — 基于元数据（ID3/FLAC）的智能重复音乐识别
- **去重多线程哈希** — 10 线程并行计算文件哈希，动态调度；**首尾双段 4KB 预哈希**（Czkawka 风格）跳过头同尾不同文件
- **空目录清理** — 扫描指定目录下的空目录（全空目录合并显示），支持回收站/永久删除
- **目录浏览选择** — 内置文件选择器，支持浏览并选择扫描目录
- **系统清理** — 17 项扫描目标（apt / syslog / journal / 包管理器缓存 / 浏览器 / Playwright / 旧内核），三档风险过滤 + 一键推荐清理 + 清理前 manifest 备份 + **5 类分类浏览**（系统/日志/开发/浏览器/应用）
- **回收站批量清理** — 扫描所有 vol × 所有 UID 的 `.@#local/trash/`，按 mtime 30/90/365 天分级清理，root 权限包含全部用户
- **启动警告弹窗** — 每次进入应用立即弹「⚠️ 清理有风险」红底警示（3 秒倒计时）
- **响应式布局** — 适配桌面端与移动端
- **磁盘空间分析** — 卷用量总览 + 目录下钻排行 + 文件类型分布 + 顶层大文件（P0-1）
- **相似图片/视频检测** — 感知哈希识别同图不同分辨率/水印、同视频不同转码（P0-2）
- **异常文件检测** — 空文件/无效软链接/损坏媒体/下载残留识别（P0-3 + P2-1）
- **重名冲突检测** — 找出跨目录同名文件分组（不区分大小写，P2-2）
- **轻量架构** — 纯 Node.js ESM 实现，零 npm 依赖

## 技术架构

```
清理精灵 FnClearup (Node.js)
├── app/ui/                # 前端界面（HTML/CSS/JS）
│   ├── index.html        # 主页面
│   ├── main.js           # 前端逻辑
│   ├── server.js         # HTTP + UNIX Socket 服务器
│   ├── api/              # API 路由处理器
│   │   ├── app.js        # 应用扫描/删除
│   │   ├── disk.js       # 网盘扫描
│   │   ├── docker.js     # Docker 资源管理
│   │   ├── temp.js       # 临时文件清理
│   │   ├── dup.js        # 去重引擎
│   │   ├── empty_dir.js  # 空目录扫描/删除
│   │   ├── sysclean.js   # 系统清理（apt/syslog/缓存/旧内核）
│   │   └── trash.js      # 回收站批量清理
│   ├── lib/              # 通用工具
│   │   ├── config.js     # 全局常量（版本、目录等）
│   │   └── util.js       # 工具函数
│   ├── styles/           # 样式文件
│   └── images/           # 图片资源
├── app/empty_dir_scan.js # 空目录扫描（独立运行用）
├── app/dup_scan.js       # 去重扫描子进程
├── app/dup_hash_pool.js  # 10线程哈希计算池
├── app/dup_hash_worker.js# 哈希计算工作线程
├── data/manifests/       # 清理前备份（PKGVAR 下）
├── cmd/                  # FnOS 生命周期脚本
├── config/               # 权限配置
└── wizard/               # 安装向导
```

- **后端**：Node.js ESM（零 npm 依赖，仅用内置模块）
- **前端**：原生 HTML/CSS/JS，无框架依赖
- **通信**：HTTP API 请求 + UNIX Socket（fnOS Gateway 转发）
- **数据存储**：JSON 文件状态 + 去重结果持久化
- **fnOS Gateway**：自动挂载 `/app/fnclearup` 前缀
- **依赖**：需 Node.js v24 运行时

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/version` | GET | 获取版本号 |
| `/api/ping` | GET/POST | 健康检查 |
| `/api/scan` | POST | 扫描孤立目录 |
| `/api/delete` | POST | 删除目录/用户 |
| `/api/mounts` | GET | 获取网盘挂载列表 |
| `/api/vol02` | GET | 获取 vol02 目录 |
| `/api/volumes` | GET | 获取 Docker 卷 |
| `/api/volumes/delete` | POST | 删除 Docker 卷 |
| `/api/networks` | GET | 扫描 Docker 网络 |
| `/api/networks/delete` | POST | 删除 Docker 网络 |
| `/api/images` | GET | 获取 Docker 镜像 |
| `/api/images/delete` | POST | 删除 Docker 镜像 |
| `/api/system` | GET | 系统资源概览 |
| `/api/temp/scan` | GET | 扫描临时文件 |
| `/api/temp/delete` | POST | 删除临时文件 |
| `/api/dup/scan` | POST | 开始去重扫描 |
| `/api/dup/status` | GET | 获取去重扫描状态 |
| `/api/dup/delete` | POST | 删除去重结果 |
| `/api/dup/stop` | POST | 停止去重扫描 |
| `/api/dup/pause` | POST | 暂停去重扫描 |
| `/api/dup/resume` | POST | 继续去重扫描 |
| `/api/dup/export` | POST | 导出去重结果 |
| `/api/jobs` | GET | 获取去重任务列表 |
| `/api/browse` | GET | 目录浏览（参数：path） |
| `/api/empty_dir/scan` | POST | 开始空目录扫描 |
| `/api/empty_dir/status` | GET | 获取空目录扫描状态 |
| `/api/empty_dir/delete` | POST | 删除空目录 |
| `/api/sysclean/scan` | GET | 扫描系统清理目标（17 项） |
| `/api/sysclean/clean` | POST | 清理选中的项（写 manifest + 删除） |
| `/api/sysclean/manifests` | GET | 列出历史 manifest |
| `/api/sysclean/manifest` | GET | 下载/查看单个 manifest |
| `/api/trash/scan` | GET | 扫描所有 vol × UID 的 trash 目录 |
| `/api/trash/browse` | GET | 浏览某 trash 目录的文件树（只读） |
| `/api/trash/clean` | POST | 清理 trash（按 mtime 阈值 + manifest 备份） |
| `/api/diskanalysis/volumes` | GET | 各 /vol* 卷用量总览（statfs 瞬时） |
| `/api/diskanalysis/tree` | POST | 目录下钻（子目录排行 + 类型分布 + Top 文件） |
| `/api/diskanalysis/stop` | POST | 停止空间分析扫描 |
| `/api/simdup/scan` | POST | 启动相似图片/视频扫描（type/paths/threshold） |
| `/api/simdup/status` | GET | 查询相似扫描进度与结果 |
| `/api/simdup/stop` | POST | 停止相似扫描 |
| `/api/broken/scan` | POST | 启动异常文件扫描（空/无效链接/损坏媒体/下载残留） |
| `/api/broken/status` | GET | 查询异常扫描进度与结果 |
| `/api/broken/stop` | POST | 停止异常扫描 |
| `/api/namematch/scan` | POST | 启动重名冲突扫描 |
| `/api/namematch/status` | GET | 查询重名扫描进度与结果 |
| `/api/namematch/stop` | POST | 停止重名扫描 |

## 版本历史

**扫描排除规则(可自定义)**

- 问题: 原先扫描除最小体积外没有任何路径排除, 每次扫 /vol1 都要把 @appdata 的 SQLite、
  node_modules、.git、Docker overlay 全走一遍; 哈希缓存能跳过重复计算, 但 walk+statSync
  的元数据开销跑不掉, 且系统目录里发现的"重复文件"多半是各应用共用的 LICENSE/图标。
- 修复: 新增零依赖 app/exclude_rules.js, dup_scan 与 simdup_scan 在 readdir 之后 stat 之前
  剪枝(目录整棵跳过); 规则落盘 TRM_PKGVAR/data/scan_exclude.json,
  GET/POST /api/dup/exclude-rules 读写, 面板提供折叠式编辑区(展开时懒加载)。
- 默认 18 条含 @app*/@sysapp*(覆盖 fnOS 全部 8 个系统目录)与 node_modules/.git/__pycache__/
  lost+found/overlay2 等。刻意不用 @* —— 会误伤用户自建的 /vol1/1000/@我的相册。

**哈希缓存命中统计可见化**

- 统计区新增「缓存命中 · 新哈希 N」与「预筛已排除」卡片, 命中率 ≥80% 为常规色、<80% 走告警色。
- 实测(/vol2, 100 文件/30 组重复): 冷 0 命中/60 哈希/0%; 热 60 命中/0 哈希/100%。

**保护 fnOS 系统目录与卷内回收站(删除安全, P0)**

- 问题: 删除校验白名单只到卷粒度(/vol*), 导致 @appcenter(所有应用安装目录)、@appdata、
  @appmeta、@apphome、@appconf、@appshare、@apptemp、@sysappmeta 与卷内回收站
  (/volN/<uid>/.@#local) 全部通过校验 —— 勾选删除会误删其他应用文件导致应用起不来。
- 修复: 用精确名单(非 @ 前缀正则, 避免误伤 /vol1/1000/@我的相册)拦截 8 个系统目录 + 回收站,
  删除/大文件/空目录三端点接入并回传拦截数量与逐条原因。
- 刻意不接入 app.js(应用卸载器) —— 它的语义就是卸载应用, 接入会废掉卸载能力。
- 自身数据目录差异化豁免: 读写豁免, 删除不豁免(否则会删掉自己的缓存和审计清单)。

**相似文件显示相似度并支持并排对比**

- 相似度: 每文件输出 minDist、每组输出 minDist + 最相近 5 对, 按相似度升序(最像的排最前),
  前端新增「相似度」列并分档着色。实测同源 3 张: 距离 2 (97%) / 5 (92%) / 7 (89%)。
- 对比视图: 新增 GET /api/simdup/thumb 缩略图 API(320px JPEG, ffmpeg 抽帧取第 1 秒避免黑屏),
  缓存于 TRM_PKGVAR/data/thumbs(键含 size+mtime, 文件一变即失效); 组号改为可点击,
  点开用原生 <dialog> 并排展示缩略图 + 名称 + 大小 + 各自相似度。
- 安全: 须过 isSafePath 且扩展名在图片/视频白名单(.js/.sh/.exe 等拒绝)。

**相似/异常/重名/大文件统一为多目录选择**

- 四个 tab 原为单文本框(大小文件还是下拉), 现改为与去重一致的目录标签列表, 可多选。
- simdup/broken/namematch 后端本就接受 paths 数组(纯前端改造);
  bigfiles 后端改为 getAll('path') 读重复参数并累积去重 roots, 保留单 path 与不传(=/vol*)的旧行为。
- 实测: 单根 /vol3 -> /vol3; 多根 -> /vol3,/vol2; 四根含重复 -> 去重为 2 个;
  不传 path -> /vol1,/vol2,/vol3; /etc 与 /vol99 -> 403。

**修复全站按钮失效(showToast 闭合花括号被吞, P0 回归)**

- 根因: 插入 blockedNotice 时锚点只取到 setTimeout 那一行, 把 showToast 的闭合 } 吞掉了,
  导致其后插入的所有函数都落在 showToast 的函数体内; 模块作用域 exports 块引用它们时抛
  ReferenceError, init() 中断, Object.assign(window,exports) 从未执行, 全站按钮无任何绑定。
- 为什么没被拦住: 这类错误语法完全合法, node --check 通过; 字符串断言类测试也查不出
  (只检查"这段文字在不在")。必须真把 main.js 跑起来。
- 防回归: 新增 tests/test_main_js_loadable.js, 用 DOM stub 真实加载 main.js 并断言 init() 不抛错。

**移动端布局修复(据真机截图)**

- 回收站 KPI: 原硬编码 repeat(5,1fr), 移动端也强制 5 列 → 数值截成 3._、标签消失、
  第 3 张卡被屏幕右边缘裁掉。改为固定 2 列 + 第 5 张跨列收尾, 通栏卡内标签贴左数值贴右。
- 回收站列表卡片: .trash-card-path 原用 word-break:break-all, 长路径被逐字符折成竖条
  (正是"叠在一起"的观感来源); 改为 overflow-wrap:anywhere + 限 3 行, 完整路径用 title 查看。
- 全部改用 grid auto-fit 而非媒体查询 —— fnOS 移动 WebView 常以桌面 UA 渲染,
  max-width 断点根本不触发, 写进媒体查询等于没写。

### v0.11.2

**哈希并发按介质自适应(不再固定 4 worker)**

- 问题: 哈希 worker 原硬编码为 4 个。本机是 Intel Celeron J3355 **双核** +
  `sda`/`sdb` **机械盘 RAID1**(WD43PURZ) + `sdc` 固态盘,固定 4 既是 2 倍 CPU
  超订,又让机械盘多线程随机读产生寻道竞争。fclones 官方文档明确建议机械盘用
  `--threads 1`,并报告过 2x~10x 的性能差异。
- 修复: 新增 `app/storage_profile.js`,读 `/sys/block/<dev>/queue/rotational`
  判定扫描目标所在卷的介质类型(自动穿透 LVM / device-mapper),
  机械盘降为单线程、固态盘取 `min(4, CPU 核数)`、介质无法确定时保守按机械盘处理、
  多路径混合时取更保守的一侧。推导结果写入任务状态 `storageProfile` 并输出日志:
  `[dup_scan] 哈希并发度=1 · 机械盘(/vol2) — 单线程避免寻道竞争`

**partial 预筛采样量 4KB → 32KB(头尾各一段)**

- 问题: 每段仅取 4KB,区分度不足,MP4/MOV/ISO/压缩包这类文件头高度雷同,
  大量文件被迫进入全量 SHA-256。
- 修复: 每段 4KB → 32KB(头尾合计 8KB → 64KB),对齐 file-deduplicator 的
  头尾 64KiB 水平。**只加大单段读取、保持 seek 次数恒为 2** —— 机械盘上多一次
  seek 的成本(数毫秒)远高于多读几十 KB,因此不加中段采样点。

**保护 fnOS 系统目录与卷内回收站(删除安全)**

- 问题: 删除白名单 `isSafePath` 只到 `/vol*` 粒度,而 fnOS 的系统与应用目录
  全部位于 `/volN/@xxx` 之下,**全部通过校验**:
  `@appcenter`(所有应用的安装目录,含代码与二进制)、`@appdata`(运行数据)、
  `@appmeta`、`@apphome`、`@appconf`、`@appshare`、`@apptemp`、`@sysappmeta`,
  以及 `/volN/<uid>/.@#local`(卷内回收站,删掉会绕过二次恢复)。
  各应用之间常存在同名文件(各家的 LICENSE、图标、依赖),重复文件扫描极易命中,
  用户勾选删除即会**误删其他应用的文件,导致对应应用无法启动**。
- 修复: `util.js` 新增 `FNOS_SYSTEM_DIRS` 精确名单 + `protectedReason()` /
  `isDeletablePath()` / `partitionDeletable()`;`dup` / `bigfiles` / `empty_dir`
  三个**文件清理**端点接入,响应新增 `blockedCount` 与逐条 `blocked` 明细,
  前端 `blockedNotice()` 把原因显示到 toast 与状态栏。
- 采用**精确名单**而非 `/@[^/]+/` 正则: 用户自己的 `/vol1/1000/@我的照片`
  这类目录不会被误伤。
- 刻意**不**接入的两类端点:
  - `app.js` 是应用卸载器(删除目标本就是 `@appcenter`/`@appshare`),套用会废掉卸载能力;
  - `simdup` / `broken` / `namematch` / `diskanalysis` 是只读端点,仍可"看到"
    系统目录里的重复文件,只是删不掉。
- 应用自身数据目录(`TRM_PKGVAR`)采用差异化豁免: 读写场景豁免(要能写哈希缓存、
  manifest、导出),**删除场景不豁免**(否则清理工具会把自己的缓存和审计清单一起删掉)。
- 验证: 真实 server + 真实删除请求,混合提交"正常文件 + @appcenter 诱饵 + 回收站路径",
  结果 `实际删除=1  blockedCount=2`,诱饵文件确认未被删除。
- 测试: 新增 `tests/test_protected_paths.js` (9 项),全量 245 passed / 0 failed。

**扫描排除规则(可自定义)**

- 背景: 原先扫描除最小体积外没有任何路径排除, 每次扫 `/vol1` 都要把 `@appdata`
  的 SQLite、`node_modules`、`.git`、Docker overlay 全走一遍; 哈希缓存虽能跳过
  重复计算, 但 `walk + statSync` 的元数据开销跑不掉, 而且系统目录里发现的
  "重复文件"多半是各应用共用的 LICENSE/图标, 对清理没有价值。
  对标 fclones 的 `.hashignore` / dupeGuru 的 exclude 列表。
- 修复: 新增零依赖的 `app/exclude_rules.js`,`dup_scan.js` 与 `simdup_scan.js`
  在 **readdir 之后、stat 之前**剪枝(目录整棵跳过), 省掉后续元数据开销;
  规则落盘于 `<TRM_PKGVAR>/data/scan_exclude.json`,`GET/POST /api/dup/exclude-rules`
  读写,重复文件面板提供折叠式规则编辑区(展开时才懒加载)。
- 匹配语义: 不含 `/` 的规则按**路径段**匹配(任意层级,支持 `*` `?`);
  含 `/` 的按路径模式匹配(`**` 任意层、`*` 单层);`/` 开头为绝对路径前缀。
  空规则 = 不排除任何内容;文件缺失或损坏时回落到默认规则,绝不中断扫描。
- 默认规则: `@app*` / `@sysapp*`(覆盖 fnOS 全部 8 个系统目录)、
  `node_modules`、`.git`、`__pycache__`、`lost+found`、`overlay2` 等 18 条。
  刻意**不用** `@*` —— 那会误伤用户自建的 `/vol1/1000/@我的相册`。
  注意这是"跳过扫描"(性能),与 `isDeletablePath` 的删除保护(安全)是两回事,
  后者用精确名单、从严。
- 结果可观测: 统计卡新增「排除跳过」,`stats.excluded` / `stats.scanned` 上报。
- 测试: 新增 `tests/test_exclude_rules.js` (12 项),含一条**全项目相对 import
  可解析性**检查(曾因 `../../../exclude_rules.js` 多写一级导致 server 启动即崩,
  而 `node --check` 不校验 import 路径)。全量 245 passed / 0 failed。

**相似文件并排对比(眼见为实)**

- 背景: 有了相似度百分比仍不够 —— 用户要看到图才能决定删哪张
  (dupeGuru Picture mode / Czkawka side-by-side 都是这个思路)。
- 修复: 新增 `GET /api/simdup/thumb?path=<文件>`,按需生成 320px 宽 JPEG
  缩略图(ffmpeg 抽帧;视频取第 1 秒避免黑屏片头),落盘缓存于
  `<TRM_PKGVAR>/data/thumbs/`,缓存键含 `size+mtime`,文件一变即自动失效。
  相似结果表的组号改为可点击按钮,点开用原生 `<dialog>` 并排展示该组全部
  缩略图 + 名称 + 大小 + 各自相似度,点击图片可在新标签打开原图。
- 安全: 路径须过 `isSafePath` 且扩展名在图片/视频白名单内
  (`.js`/`.sh`/`.exe` 等一律拒绝),失败返回明确的 403/400/404/500。
- 选型说明: 用原生 `<dialog>` 而非自定义 modal —— fnOS WebView/CEF 下自定义
  overlay 常出现 `getComputedStyle` 显示正常但视觉层不渲染的问题;
  按钮绑定用 `addEventListener` 事件委托而非 inline `onclick`(后者在 CEF 下常静默失效)。
- 实测: 真实图片 → `200 image/jpeg 320x213`;真实视频 → `200 image/jpeg 320x180`;
  伪装的坏文件 → 500;`.js` 文件 → 400;`/etc/passwd` → 403;目录 → 400;
  不存在 → 404;重复请求命中缓存,未重复生成。

**相似图片/视频: 显示相似度并按相似度排序**

- 背景: dHash 汉明距离此前只在 `cluster()` 内部用于判定,用完就丢。界面上
  "这两张图相似"却看不出**有多相似**,用户无法判断优先级先删哪张 ——
  这是 dupeGuru 的招牌能力(按匹配百分比分组)。
- 修复: `simdup_scan.js` 新增 `pairDist()`(口径与 `cluster()` 完全一致:
  图片取 dHash 距离、视频取各抽帧组合的最小值)与 `topPairs()`(组内最相近的
  5 对);每个文件输出 `minDist`(与组内最相似者的距离)、每组输出
  `minDist` + `pairs`,并按 `minDist` 升序排列(最像的组排最前)。
  前端表格新增「相似度」列,按 64 位 dHash 换算百分比并分档着色
  (≥95% 绿 / 80~95% 主色 / <80% 橙),结果区上方点明「最相似的一对」。
- 附带修复: `simhash.js` 的 `FFMPEG` 路径硬编码 `/usr/bin/ffmpeg`,
  改为 `process.env.FFMPEG_PATH || '/usr/bin/ffmpeg'`,便于非标准路径安装。
- 实测(ffmpeg 真实解码, 3 张同源图 + 2 张异源图):
  同源 3 张正确聚为一组,2 张异源图未被误聚;组内距离
  `a0~a2=2 (97%)`、`a0~a1=5 (92%)`、`a1~a2=7 (89%)`,量级区分清晰。

**哈希缓存命中统计可见化**

- 背景: 重复文件扫描一直带持久化哈希缓存(`path → {size, mtimeMs, hash, ext, id3}`,
  对标 `jdupes --hash-db`),二次扫描几乎不读盘 —— 但界面上没有任何数字体现,
  用户只能靠"感觉这次好像快了点"来判断。这是 Czkawka 的招牌卖点
  (官方 benchmark: 363,215 文件首次 8s → 二次 7s; 相似图片 54s → 1s)。
- 修复: `dup_scan.js` 的 `stats` 新增 `cacheHits` / `hashed` / `cacheHitRate` /
  `partialSkipped` / `sizeSkipped`;统计区新增「缓存命中 · 新哈希 N」卡片
  (命中率 ≥80% 用默认样式,<80% 走 warning 色),预筛排除数 >0 时追加一张
  「预筛已排除」卡。未进入哈希阶段(如完全无重复)时不占位显示。
- 实测(机械盘 `/vol2`,100 文件 30 组重复,同一目录连扫两次):
  | | 缓存命中 | 实际哈希 | 命中率 | 预筛排除 |
  |---|---|---|---|---|
  | 第一次(冷) | 0 | 60 | 0% | 40 |
  | 第二次(热) | 60 | 0 | **100%** | 40 |

**修复介质判定的一个隐蔽错误**

- `statSync(path).toString()` 得到的是 `fs.Stats` 对象的字符串(恒为
  `"[object Object]"`),不是文件内容,导致所有介质都被误判为固态盘。
  已改用 `readFileSync`,并有回归测试锁死(`test_storage_profile.js`)。

- 测试: 新增 `tests/test_storage_profile.js` (9 项),全量 245 passed / 0 failed。

### v0.11.1 (2026-09-26)
- 🔴 **P0 修复「应用清理删除用户」守护失效** — 旧守护只判 `uid < 900`，但实测 fnOS 上 `admin` uid=1000、`polkitd` 995、`systemd-network` 998 全部 ≥900，守护形同虚设；且路径 `/volX/@appmeta|@appconf|@appdata|@apphome/<name>` 全部匹配 `@app[^/]+` 正则，第二段被直接当 username 传给 `userdel -r`，最坏可删掉用户全部数据或导致断网。修复为三层判据：**uid ∈ [900,1000) + gid == 901（fnOS 应用账号组）+ 核心组件黑名单**（应用商店/权限/包管理/运行时/网络等）
- 🐛 **修复「QQ群号复制按钮点了没反应」** — 两层根因：① `copyQQNumber` 未 export 到 window，IIFE 闭包导致 inline onclick 静默 ReferenceError；② fnOS WebView 走 http（非安全上下文）时 `navigator.clipboard` 为 `undefined`，旧 fallback 的 `ta.select()` 未先 `focus()` 导致 CEF 下 select 失败，且失败时无任何 UI 反馈。修复：补 export + 三级降级链（clipboard → execCommand 带 focus → 手动选中文本）+ 成功/失败双路可见反馈
- 🔧 **inline onclick 绑定方式改为 DOM-0** — fnOS WebView (CEF) 对动态重渲元素的 `addEventListener` 可能不触发，改用 `el.onclick=`（最可靠），并加 `__rewired` 幂等标记防重复绑定
- 🧪 测试加固 — 移除导出检查里的 `isBuiltin` 白名单（正是它掩盖了漏导出），新增守卫一次性比对全部 inline onclick 函数 vs exports 块；新增删用户守护 26 项 + 复制降级链 14 项测试

### v0.9.6 (2026-08-20)
- 修复：同步删除关联系统用户失效（@app\d+ 正则无法匹配 @appcenter/@appstore，用户永远不删）——改为匹配任意 @app* 目录 + uid≥900 守护
- 修复：应用残余卸载失败（@appcenter 路径不匹配回收站 regex，改为永久删除）

### v0.9.5 (2026-08-12)

- 修复：去重浏览弹窗默认路径不存在时报 ENOENT
- 修复：根路径卷条目缺少 isDirectory:true 不可点击
- 测试覆盖：87

### v0.8.0 (2026-06-15)

- 新增：定时清理计划 — 支持 5 种清理类型（应用残余/网盘挂载/Docker/tmp/回收站），可配置时间、间隔，自动执行并生成清理报告
- 新增：定时清理前端配置面板，各清理类型独立启停
- 新增：定时清理执行报告（清理项/错误/耗时），保留历史记录
- 修复：代码审计 14 项 P0/P1/P2 全面修复

### v0.7.12 (2026-06-08)

- 新增：去重结果前端分页渲染 + 加载更多
- 优化：去重 KPI 卡片显示总数

### v0.7.11 (2026-06-04)

- 修复：系统清理忽略 `/boot` 目录 — 移除 SCAN_TARGETS 中的 `old-kernels` 项，避免误删内核文件

### v0.7.10 (2026-06-03)

- 新增「🗑 回收站」Tab — 批量清理 `/vol<N>/<UID>/.@#local/trash/`，按 mtime 30/90/365 天分级清理，root 权限包含全部用户
- 新增「🧹 系统清理」Tab — 17 项扫描目标（apt/syslog/journal/包管理器缓存/浏览器/Playwright/旧内核），三档风险过滤 + 一键推荐清理 + 清理前 manifest 备份
- 回收站清理预览按 mtime 阈值过滤（之前 bug：列了全部 trash 目录不管 mtime）
- 回收站 Tab 移动端自适应（480px：按钮 2 列 + 表格切卡片 + modal 全屏）
- 修：API 调用 `apiFetch` → `API.get/post`（fnclearup 用的是 `API.base` 模式）
- 修：API.base 末尾斜杠导致双斜杠路径 404
- 修：诊断 BUILD 版本号 + 时间戳（防止 fnOS 僵尸旧 server 进程）
- 修：trash 不区分用户，root 包含所有用户的 trash（撤销 otherTrash 灰化）
- 测试 60/60 通过

### v0.7.9 (2026-06-02)

- 修复：空目录扫描期间浏览/stop 无响应（walk 同步阻塞事件循环）
- 修复：emptyDirJobs 注册时机（stop 提前到达能立即被处理）
- walk/collect 改为 async，每 200 目录 yield 一次
- 测试 60/60 通过

### v0.7.8 (2026-06-02)

- 新增启动警告弹窗（每次打开应用强制阅读 3 秒，红底警示 + 强制确认项 + manifest 开关推荐）
- 防止用户没看清就点删除

### v0.7.7 (2026-06-02)

- Manifest 写入位置改到 `<TRM_PKGVAR>/data/manifests/`（与 info.log 同父目录，fnOS 标准 data/ 子目录）
- `getSafeTrashDir` → `getManifestDir` 重命名（保留旧名 alias）
- 删除 UI 上的"写到 .@#local/"提示文案
- 测试 58/58 通过（+2 路径验证）

### v0.7.6 (2026-06-02)

- 新增「系统缓存清理」Tab（14 项可清理：APT/系统日志/NPM/PIP/UV/TypeScript/浏览器缓存/应用日志/旧内核等）
- 「✅ 推荐清理」一键勾选 10 项低风险 auto-rebuild 安全项
- 「📦 清理前备份 manifest」开关（默认 ON，写到 `<TRM_PKGVAR>/data/manifests/fnclearup_pre_clean_manifest_<时间>.json`，与 info.log 同父目录）
- 「📜 历史清单」弹窗，列出/下载历史 manifest（审计用）
- 新增 `getManifestDir()` 工具函数（按 `TRM_PKGVAR`/test/fallback 优先级返回 `<PKGVAR>/data/manifests`，与 `info.log` 同父目录）
- 新增 API：`GET /api/sysclean/manifests`、`GET /api/sysclean/manifest?path=...`
- 路径遍历防护：manifest 下载端点强制白名单
- 测试 58/58 通过（+6 个新用例：备份写入/不写/列表/下载/路径遍历拒/缺参拒 + 2 个路径验证）

### v0.7.5 (2026-06-02)

- 修复 5 个 modal「确认」按钮 onclick 调错函数（confirmXxx → doXxx）
- P0/P1 安全修复：4 个删除端点 isSafePath 白名单、handleBrowse /vol* 白名单、CSV 注入防护
- 删除用户强警告（双重 confirm）+ 3 个 docker 删除加 modal 确认
- empty_dir 重写：stop API、跳过 @app*、流式扫描、state file 修复 complete 状态保留
- 删除 app/data/ 隐私数据 + app/ui/utils.js 冗余代码
- CORS 改 CORS_ORIGINS 环境变量
- 测试 39/39 通过（新增路径遍历、CSV 注入、HTML onclick 契约测试）

### v0.7.2 (2026-05-30)

- 新增「去空」选项卡 — 扫描空目录，支持批量/单个删除（回收站/永久删除）
- 实时扫描目录显示 + 进度条
- 移动端自适应（空目录列表水平滚动 + 路径自动换行）
- 单遍遍历算法优化 + 符号链接安全（lstatSync）
- uncaughtException + 进程退出码检测，错误写到状态文件
- 跳过 `.@#local` 回收站目录
- 版本号统一为 0.7.2

### v0.7.1 (2026-05-29)

- 新增 tmp 选项卡（独立版本前已有，版本号对齐）

### v0.7.0 (2026-05-26)

- 新增文件去重模块（SHA-256 哈希比对，10 线程并行计算）
- 新增音乐去重模块（基于元数据的智能重复识别）
- 新增目录浏览选择按钮（内置文件选择器）
- 新增顶部版本号显示，启动时自动检查 FnDepot 是否有新版本
- 去重模块移除暂停/继续按钮，仅保留停止按钮
- 去重 Tab 标签精简：重复 → 去重，音乐重复 → 音乐，文件重复 → 文件
- 回收站路径纠正为 `/volX/UID/.@#local/trash/`
- 删除失败时显示具体错误信息
- 修复：组删除排除 disabled 原始文件
- 修复：暂停/继续功能完善（checkPause 先同步文件再检查）
- 修复：赞助图片放大 onclick 自动转换导致 this 丢失
- 修复：状态文件写入改为原子操作，避免并发读导致 JSON 解析失败
- 修复：移动端长内容截断

### v0.6.0 (2026-05-05)

- Docker 网络清理功能完善（tab 头部删除按钮恢复）
- 新增系统资源概览 `/api/system` 端点（磁盘分区、内存状态、Docker 基础信息）
- 应用/网盘选项卡合并表格：状态列+badge，参照 docker 表格样式
- 移动端 KPI 卡片保持 3 列自适应，缩小图标和文字
- 修复：每次打开强制重新加载 main.js（添加时间戳参数避免缓存）
- 修复：应用 tab 和网络 tab 状态文字格式优化

### v0.5.6 (2026-05-03)

- 移动端 KPI 响应式布局（768px 以上 3 列，480px 以下堆叠为 3 行）

### v0.5.5 (2026-05-03)

- 移动端 KPI 恢复 3 列布局

### v0.5.4 (2026-05-03)

- 修复 main.js 语法错误（JS 执行失败导致按钮无效）
- 修复展开按钮初始无箭头问题
- 修复数据无法加载问题

### v0.3.0 (2026-05-01)

- 前端全面优化：无障碍修复（aria-label、role="dialog"）、模态框标注、alert 阻塞修复
- 新增：网盘 Tab 新增"目录总数"KPI 卡片
- 修复：do_volumes 中 orphan_json 缺少 [] 包裹导致前端 "not iterable" 错误

### v0.2.0 (2026-04-30)

- 新增 Tab 切换：网盘挂载目录 / data/vol02 未挂载目录独立展示
- 新增 KPI 卡片：显示已挂载数量和未挂载数量

### v0.1.5 (2026-04-30)

- 前端审计修复: XSS防护(innerHTML转义)、label for属性、WCAG AA对比度优化

## 维护者

- 作者：[@再见一零一二](https://gitee.com/wyf1015)

---

> 如果这个项目对您有帮助，欢迎赞助支持 ❤️
