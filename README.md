# nanobot Desktop（本地自用改造版）

Mac 桌面壳：把 nanobot 的 WebUI 从浏览器里"解放"出来，变成独立桌面 App（Dock 图标、独立窗口、关闭不退出、常驻后台）。

> 本仓库是**本地自用改造版**，基于官方 nanobot Electron 壳（HKUDS/nanobot `desktop/`）二次开发，与本机 nanobot 网关深度适配。相关设计文档、验收记录在 `~/Desktop/AI/13_nanobot-dev/Yuanyi-研发/06_nanobot桌面端/`（本地维护，不入 git）。

## 这个项目是干什么的

- **纯壳**：不打包 Python 引擎、不管理 gateway 生命周期。网关由本机 launchd 服务 `ai.nanobot.gateway` 托管（监听 18790，WebUI/WS 8765），壳只负责"开窗口 + 连网关 + 转发请求"。
- **体验目标**：日常聊天/切会话不用再翻浏览器标签页；窗口关闭只隐藏（Dock 常驻，Cmd+Q 才退出）；消息提醒走 macOS 系统通知。
- **与官方版的核心差异**（改造 D1~D6）：

| 项 | 官方版 | 本改造版 |
|---|---|---|
| 引擎生命周期 | Electron 自己启动 bundled Python | 外部 launchd gateway，壳不碰 |
| 网关连接 | 私有 Unix socket | TCP `127.0.0.1:8765` |
| 认证 | — | 读 `~/.nanobot/config.json` 的 `channels.websocket.tokenIssueSecret`，请求注入 `X-Nanobot-Auth` 头 |
| 构建工具 | bun | npm / npx（本机未装 bun）|
| 打包 | dmg + 引擎 bundle | 本地自用只打 app 目录（`--mac dir`）|

## 开发与打包

```sh
# 编译（tsc → build/）
npm run build

# 打包 app 目录（本地自用；必须走镜像源，GitHub 直连下载 Electron 会超时）
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npx electron-builder --mac dir --arm64

# 安装（替换 /Applications 里的旧版）
# 退出正在运行的壳后，把 dist/mac-arm64/nanobot.app 复制到 /Applications/
```

> 踩坑记录（打包必读）：electron-builder 必须用 **24.13.0**（26.x 在 packaging 阶段挂起）；Electron 版本 43.4.0（Chromium 150，交互渲染更顺）；手动替换 app.asar 不可行（Electron 校验完整性），必须走 electron-builder 正规打包。

## 已知事项

- 遗留：GPU 进程空闲空转 ~45%（Electron 42/43 均存在，不影响交互、仅空闲耗电），待 Electron 44 stable（2026-08-25，Chromium 151，与 Codex 同款内核）升级验证。
- 仓库地址：https://github.com/yuanyi1415/Yuanyi-nanobot-desktop.git（独立仓库，不与 nanobot 主仓库混用）
