# nanobot Desktop

Mac 桌面壳：把 nanobot 的 WebUI 从浏览器中"解放"出来，变成独立桌面 App（Dock 图标、独立窗口、关闭不退出、常驻后台）。

> 基于官方 nanobot Electron 壳二次开发的本地适配版。设计文档与验收记录存于 nanobot 开发库的研发分区（本地维护，不入 git）。

## 项目定位

- **纯壳**：不打包 Python 引擎、不管理 gateway 生命周期。网关由本机系统服务托管，壳只负责"开窗口 + 连网关 + 转发请求"。
- **体验目标**：日常聊天/切换会话不用再翻浏览器标签页；窗口关闭只隐藏（Dock 常驻，Cmd+Q 才退出）；消息提醒走 macOS 系统通知。
- **与官方版的核心差异**：

| 项 | 官方版 | 本适配版 |
|---|---|---|
| 引擎生命周期 | Electron 自己启动内置 Python | 外部服务托管，壳不碰 |
| 网关连接 | 私有 Unix socket | 本机 TCP 端口 |
| 认证 | — | 读取本地 nanobot 配置中的 WS 认证密钥，请求头注入 |
| 构建工具 | bun | npm / npx |
| 打包 | dmg + 引擎 bundle | 本地自用只打 app 目录 |

## 开发与打包

```sh
# 编译（tsc → build/）
npm run build

# 打包 app 目录（本地自用；需走镜像源，GitHub 直连下载 Electron 会超时）
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npx electron-builder --mac dir --arm64

# 安装：退出正在运行的壳后，将 dist/mac-arm64/nanobot.app 复制到 /Applications/
```

> 踩坑记录：electron-builder 需用 24.13.0（26.x 在 packaging 阶段挂起）；手动替换 app.asar 不可行（Electron 校验完整性），必须走 electron-builder 正规打包。

## 已知事项

- 遗留：GPU 进程空闲空转（Electron 42/43 均存在，不影响交互、仅空闲耗电），待更新 Electron 版本验证。
- 独立仓库，不与 nanobot 主仓库混用。
