# 清理精灵 (fnclearup)

> 智能扫描系统，精准识别已卸载应用、网盘挂载和 Docker 的残留目录，一键安全清理

- **应用名**: fnclearup
- **版本**: v0.7.0
- **作者**: 一零一二
- **主页**: [Gitee](https://gitee.com/wyf1015) | [GitHub](https://github.com/Wyf841015/FnDepot)

## 功能

| Tab | 功能 | 说明 |
|-----|------|------|
| 📦 应用 | 应用残留扫描 | 识别已卸载应用的残留目录，支持批量删除 |
| 💿 网盘 | 网盘挂载状态 | 扫描 /vol02 目录，标识已卸载的网盘目录 |
| 🐳 Docker | Docker 清理 | 扫描孤立卷、未使用网络、悬空镜像 |
| 🕐 tmp | 临时文件清理 | 扫描 /tmp 和 /var/tmp 中 24h+ 未访问的文件 |
| 📋 去重 | 文件去重 | SHA-256 哈希扫描重复文件（支持音乐 ID3 标签分析） |

## 去重功能

### 文件去重
- SHA-256 流式哈希（256KB 分块），适配大文件（>500MB 使用 4MB 分块）
- 基于文件大小预分组，唯一大小文件跳过哈希，大幅提升性能
- 4 线程 Worker Pool 并行哈希，自动容错
- 单文件哈希进度百分比显示
- 哈希失败文件自动跳过并在完成后汇总提示
- 支持暂停/继续/停止（后台扫描控制）
- 批量删除（移到回收站或永久删除）
- 导出报告（CSV + README）

### 音乐去重
- 支持 MP3/FLAC/WAV/AAC/OGG/M4A/WMA/ALAC/APE/DSF 格式
- ID3 标签（艺术家/标题/专辑）元数据展示
- 其余同文件去重

## v0.7.0 更新说明

### 🎯 新增功能
- **目录浏览选择**：路径输入框旁添加"📁 浏览"按钮，弹出目录树弹窗，支持逐级导航和选择
- **版本号显示**：顶部栏右侧显示当前版本号
- **版本检查**：启动时自动从 FnDepot 检查更新，有新版本时版本号变红脉冲闪烁
- **哈希进度**：大文件哈希时显示实时百分比进度
- **哈希失败提示**：失败文件自动跳过，完成后 toast 汇总显示

### 🐛 Bug 修复
- **去重展示"扫描失败"**：`renderDupList` 中 `const body` 声明在 IIFE 之后导致 TDZ ReferenceError
- **暂停按钮无效**：`handleDupPause` 未更新 status；`checkPause` 读的是过时内存值而非同步文件
- **弹窗按钮失效**：`$()` 函数用 `getElementById` 但多处传了 `#id` 前缀 → 返回 null
- **赞助放大图片不显示**：`this` 在 onclick→addEventListener 转换中变成字符串
- **回收站路径错误**：双重 1000 路径问题 `/volX/1000/.@#local/trash/1000/...`
- **组删除选了原始文件**：`querySelectorAll` 未排除 `:disabled` 的 checkbox
- **文件大小显示(undefined)**：`group.sizeHuman` 不存在，改为 `file.sizeHuman`
- **删除无错误提示**：API 返回失败时前端只显示"已删除 0 个"
- **移动端长截断**：自适应布局文本换行修复
- **扫描状态文件并发**：`writeFileSync` 非原子→rename 原子写入

### ⚡ 性能优化
- 流式哈希（256KB 分块），大文件 O(1) 内存开销
- 大小预分组，唯一大小文件跳过 SHA-256
- 4 线程 Worker Pool，自动容错和超时处理
- 自适应分块大小（≤100MB/256KB, 100-500MB/1MB, >500MB/4MB）

### 🔧 其他
- 去重 tab 标签精简：重复→去重，音乐重复/文件重复→音乐/文件
- 去重模块移除暂停/继续按钮，仅保留停止
- 移动端工具栏图标化布局

## 安装

通过 FnDepot 应用中心安装：
```
appcenter-cli install FnDepot/fnclearup
```

或下载 FPK 手动安装：
```
appcenter-cli install-local /path/to/fnclearup.fpk
```
