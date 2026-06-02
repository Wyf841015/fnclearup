# 清理精灵 FnClearup

> 智能扫描系统，精准识别已卸载应用、网盘挂载和 Docker 的残留目录及重复文件，一键安全清理 - Node.js 版。

![清理精灵 FnClearup](ICON_256.png)

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
- **飞书推送重构** — 抽 `cmd/lib/feishu_push.sh` 公共库，install/upgrade_callback 各自从 65 行简化为 12 行
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
- **Tab 切换** — 应用 / 网盘 / Docker / tmp / 去重 / 去空 独立展示
- **KPI 卡片** — 显示卷总数、已挂载数量、未挂载数量
- **Docker 卷管理** — 查看在用卷/残余卷，一键批量删除
- **Docker 网络管理** — 扫描未使用网络，一键批量删除
- **Docker 镜像管理** — 查看未使用镜像，一键批量删除
- **tmp 清理** — 扫描 `/tmp` 和 `/var/tmp` 下 24h+ 未访问的文件，一键清理
- **文件去重** — SHA-256 哈希比对，智能分组显示重复文件
- **音乐去重** — 基于元数据（ID3/FLAC）的智能重复音乐识别
- **去重多线程哈希** — 10 线程并行计算文件哈希，动态调度
- **空目录清理** — 扫描指定目录下的空目录（全空目录合并显示），支持回收站/永久删除
- **目录浏览选择** — 内置文件选择器，支持浏览并选择扫描目录
- **响应式布局** — 适配桌面端与移动端
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
│   │   └── empty_dir.js  # 空目录扫描/删除
│   ├── lib/              # 通用工具
│   │   ├── config.js     # 全局常量（版本、目录等）
│   │   └── util.js       # 工具函数
│   ├── styles/           # 样式文件
│   └── images/           # 图片资源
├── app/empty_dir_scan.js # 空目录扫描（独立运行用）
├── app/dup_scan.js       # 去重扫描子进程
├── app/dup_hash_pool.js  # 10线程哈希计算池
├── app/dup_hash_worker.js# 哈希计算工作线程
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

## 版本历史

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
- 飞书推送重构为 cmd/lib/feishu_push.sh 公共库
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
