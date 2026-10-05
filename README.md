# Codex Remote Web

自托管的 Codex 远程网页控制台。通过浏览器远程操控服务器上的 Codex CLI（`codex app-server`），支持多会话、实时流式输出、Codex Desktop/CLI 外部会话同步、文件管理和任务完成通知。

## 架构

```
浏览器 PWA  <--HTTP+SSE-->  总控端 server.js  <--Unix WebSocket-->  Codex Desktop 共享 app-server（本机）
                              |                    └─不可用时回退 stdio 独立进程
                              |
Android 语音 App <--HTTP+WS--> Live Voice 兼容层 <--WebRTC信令--> 共享 realtime app-server
                              |                                  └─恢复并持有网页当前 thread
                              |
                              +-- Web Push / 微信 -->  任务完成通知
```

- 后端：纯 Node.js（ESM），原生 `http` + `ws`，依赖 `web-push` + `ws`
- 前端：原生 HTML/CSS/JS（PWA），无构建步骤
- 模块化：`server.js` 入口 + `src/` 下按职责拆分的模块（router/runner/codex-server/store/live-voice/transport 等）
- 本机会话可并行执行：不同会话各用独立 app-server 客户端；同一会话的新消息仍按 `queue` / `steer` 设置处理。

## 其他电脑的会话

打开网页的会话面板，在「电脑 → 管理电脑」中添加连接，再选择该电脑查看线程。每台电脑的选择、草稿和实时事件独立；远端连接失败会显示错误，不会回退到本机执行。

连接方式：

- **SSH**：输入 `ssh://SSH别名`、`ssh://用户名@电脑地址` 或 `ssh://用户名@电脑地址:端口`。后端使用运行网页服务的系统用户的 SSH 配置和密钥；省略端口会沿用 SSH 配置。需要事先配置免密登录并验证主机密钥。远端 SSH 会话的 PATH 中必须能运行 `codex`；后端通过 SSH 启动 `codex app-server --listen stdio://`。
- **WebSocket**：输入 `wss://电脑地址:端口`，以及远端要求的 Bearer 令牌。已建立的 SSH 隧道也可填写 `ws://127.0.0.1:本地端口`。端点必须是 Codex app-server，不是本项目的网页地址。

例如，在 Windows 开启并配置 OpenSSH Server 后，先从网页服务器验证 `ssh Windows用户名@Tailscale地址` 能免密登录，再添加对应 `ssh://` 地址。Tailscale 提供网络连通性，不会自动开放 SSH 或 Codex 接口。桌面端保存的连接也不会自动导入。

支持远端会话列表、历史与工具输出、新建、继续对话、运行中的引导、`/stop`、网页发起任务的审批、重命名、删除，以及从网页修改模型和思考强度。列表最多读取 10 页 / 1000 条；不会加载归档会话。网页会为新建或需要写入的线程保持独立 SSH app-server 连接；如果目标线程正被另一 Codex 客户端占用写入锁，网页会提示先释放该客户端的线程。

远端文件管理、附件上传和后台排队暂未接入。Windows 本地图片在历史中显示为图片占位，不会误读网页服务器上同名路径。连接配置保存在 `data/remote-hosts.json`（权限 `0600`，认证令牌仅留在服务端）；选择和草稿保存在 `data/remote-host-state.json`。移除连接不删除远端会话。

## 要求

- Node.js 18+
- 服务器上已安装并登录 Codex CLI（`codex` 在 PATH 中，或用 `CODEX_BIN` 指定路径）
- （可选）反向代理如 Caddy / nginx，用于 HTTPS 和路径前缀

## 安装部署

### 1. 拉取代码

```sh
git clone https://github.com/<owner>/<repo>.git
cd <repo>
```

### 2. 安装依赖

```sh
npm install
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env` 并修改：

```sh
cp .env.example .env
```

关键配置项：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `5566` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `CODEX_BIN` | `/root/.local/bin/codex` | codex 可执行文件路径 |
| `CODEX_MODEL` | Codex CLI 当前配置 | 可选的模型覆盖值 |
| `CODEX_REASONING_EFFORT` | Codex CLI 当前配置 | 可选的推理强度覆盖值 |
| `CODEX_REMOTE_SHARED_APP_SERVER` | `1` | 优先连接本机 Codex Desktop 共享 app-server；设为 `0` 可禁用 |
| `CODEX_APP_SERVER_SOCKET` | `$CODEX_HOME/app-server-control/app-server-control.sock` | 可选的共享 Unix Socket 路径 |
| `CODEX_WORK_DIR` | 项目父目录 | 工作目录根（网页端文件管理限制在此目录下） |
| `CODEX_EXTERNAL_SESSION_POLL_MS` | `1000` | 本机 Codex Desktop/CLI 外部会话同步间隔 |
| `CODEX_EXTERNAL_SESSION_STALE_MS` | `7200000` | 无 `task_complete` 且长时间无文件活动时的故障兜底 |
| `CODEX_REMOTE_PASSWORD` | — | **必填**，网页登录密码 |
| `CODEX_REMOTE_VOICE_TOKEN` | =登录密码 | Android Live Voice Basic Auth 密码（建议按需单独设置） |
| `CODEX_REMOTE_LIVE_VOICE_ENABLED` | `1` | 是否启用 Android Live Voice 兼容接口 |
| `CODEX_REMOTE_LIVE_VOICE_VOICE` | `cove` | Live Voice v3 声音 |
| `CODEX_REMOTE_LIVE_VOICE_RECONNECT_GRACE_MS` | `60000` | 安卓断线后保留原实时运行时、等待重连的时间 |
| `CODEX_REMOTE_LIVE_VOICE_TASK_RETENTION_MS` | `1800000` | 音频关闭后，仍在执行的 Codex 回合最长保留时间 |
| `CODEX_REMOTE_ROUTE_PREFIX` | `/codex-remote` | 路由前缀，用于反向代理子路径 |
| `WEB_PUSH_SUBJECT` | `mailto:admin@...` | Web Push VAPID subject |
| `CODEX_REMOTE_NOTIFICATION_TOKEN` | — | WebToApp APK 原生 WebSocket 通知专用令牌 |
| `WECHAT_GATEWAY_URL` | — | 微信通知网关（可选） |
| `WECHAT_GATEWAY_TOKEN` | — | 微信网关 token |
| `WECHAT_TO` | — | 微信通知接收人 |

> Web Push 密钥（`WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY`）不填会自动生成并存到 `data/push-vapid.json`。

### 4. 启动

```sh
npm start
```

默认监听 `http://0.0.0.0:5566`，访问 `http://你的服务器:5566/codex-remote/`（注意路由前缀）。

### 5. 设为系统服务（推荐）

**Linux systemd**：

```ini
# /etc/systemd/system/codex-remote-web.service
[Unit]
Description=Codex Remote Web
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/repo
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=/path/to/repo/.env

[Install]
WantedBy=default.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now codex-remote-web
```

**或用 pm2**：

```sh
pm2 start server.js --name codex-remote-web
pm2 save
pm2 startup
```

### 6. 反向代理（HTTPS + 路径前缀）

**Caddy** 示例（自动 HTTPS）：

```
lempet.top {
  reverse_proxy /codex-remote/* localhost:5566 {
    header_up X-Forwarded-Prefix /codex-remote
  }
}
```

**nginx** 示例（需要同时透传 WebSocket Upgrade，APK 后台通知才可连接）：

```nginx
# 放在 nginx 的 http {} 中、server {} 外
map $http_upgrade $codex_connection_upgrade {
  default upgrade;
  ''      '';
}

location /codex-remote/ {
  proxy_pass http://127.0.0.1:5566/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Prefix /codex-remote;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $codex_connection_upgrade;
  proxy_buffering off;  # SSE 需要
  proxy_read_timeout 86400s;
}
```

> 反向代理用子路径时，`X-Forwarded-Prefix` 头要让后端知道前缀，否则静态资源路径会错。

## Android Codex Live Voice

本项目内置了与现有 HomeRail Android 语音 App 兼容的接口。无需修改或重新构建 APK，只需在 App 的连接设置中切换目标：

- 服务器：`https://你的域名/<CODEX_REMOTE_ROUTE_PREFIX>`，必须包含实际子路径。例如本机当前部署使用 `/codexremote` 时，地址应写成 `https://域名/codexremote`。
- 用户名：任意非空名称即可，建议保留现有值。
- 密码：`CODEX_REMOTE_VOICE_TOKEN`；没有单独设置时就是 `CODEX_REMOTE_PASSWORD`。

连接时，服务端会读取 Codex Remote 网页当前选择的本机会话，恢复同一个 Codex `threadId` 和工作目录，再启动 WebRTC Live Voice。关闭语音只释放实时连接，不删除 thread；之后的文字和语音仍会继续同一上下文。

网页文字端和 Live Voice 复用共享 app-server daemon，避免两个进程争抢同一线程的 writer。需要在 daemon 载入线程前启用实时能力：

```sh
codex features enable realtime_conversation
```

Codex 会在线程载入时确定实时能力。修改配置后，应等待任务结束再重启共享 daemon。共享连接不可用时，回退进程会用 `--enable realtime_conversation` 启动。

使用支持 Codex Live 协议的模型代理时，音频创建和后台控制 WebSocket 必须配套配置。在用户级 `~/.codex/config.toml` 顶部（所有表之前）设置，例如：

```toml
experimental_realtime_webrtc_call_base_url = "https://proxy.example.com/v1"
experimental_realtime_ws_base_url = "wss://proxy.example.com"
```

WebSocket 配置只包含协议和主机，不包含 `/v1` 路径；Codex 会追加控制连接路径。代理需要支持创建实时会话和附加后台控制连接，仅支持文字 Responses 不够。音频能播放但随后出现 `401 Unauthorized: realtime websocket handshake failed` 时，应检查这两个入口是否使用同一服务及匹配的凭据。以上为实验配置，需与所部署 Codex 版本一起验证。

协调规则：

- Android 网络短暂中断时，服务端默认保留原运行时 60 秒；自动重连会复用同一个 app-server 和 thread。
- 关闭语音时只停止 WebRTC 音频。如果已经委派了 Codex 任务，任务会继续在后台运行，完成后再释放会话。
- 网页选中同一 thread 时不会再显示成“其他客户端”；网页输入会发送到当前 Live Voice，或用 `turn/steer` 引导已委派的任务。网页输入 `/stop` 可以中断该任务。
- 真正由 Codex Desktop/其他 CLI 占用的同一 thread 仍保持只读同步，避免双写。

当前限制：

- 同一 thread 同时只允许一个 Live Voice 连接；第二台安卓设备不会抢占已有连接。
- Codex 的 `thread/realtime/*` 仍属于实验能力。兼容代码被隔离在 `src/live-voice/runtime.js`，以后 CLI 协议变化时只需替换这一层。
- 当前安卓端保存一个连接目标。切换 HomeRail 与 Codex Remote 时可直接修改 App 内的服务器地址；若需要一键切换多个目标，可在安卓端后续增加配置列表，不必改动语音核心。

兼容层目录按职责拆分：

```text
src/live-voice/
├── auth.js           # Android Basic Auth 与同源检查
├── tickets.js        # 60 秒、一次性 WebSocket 票据
├── leases.js         # 同一 Codex thread 的单写入租约
├── thread-adapter.js # 网页当前会话 <-> Android session 适配
├── runtime.js        # 唯一依赖实验 thread/realtime 协议的模块
├── gateway.js        # HTTP + WebSocket 协议网关
└── index.js          # 组装与对外入口
```

Android 使用的兼容端点为：

```text
GET  /api/voice-agent/current-session
POST /api/voice-agent/sessions
GET  /api/voice-agent/sessions/:threadId
GET  /api/voice-agent/sessions/:threadId/conversation
PUT  /api/voice-agent/current-session
POST /api/voice-agent/sessions/:threadId/live-ticket
WS   /api/voice-agent/sessions/:threadId/live
```

部署后可在服务器运行无音频的鉴权/信令自检（不会启动或消耗一段语音会话）：

```sh
npm run verify:live-voice
# 也可验证反向代理：
npm run verify:live-voice -- https://你的域名/codex-remote
```

## 自动语音朗读

网页实时语音：在本机空闲会话中输入 `/voice`，或在 `/` 菜单点击“实时语音对话”。允许麦克风权限后即可连接；面板支持静音、播放音频和结束，`/voice off` 也可结束。切换电脑、切换会话或离开页面会关闭麦克风。需要 HTTPS（本机 localhost 除外）及浏览器 WebRTC 支持；目前不支持远端电脑会话。

此入口复用 `src/live-voice` 的 Codex `thread/realtime/start` 通道和现有 Codex 登录状态。网页通过登录 Cookie 和一次性票据连接，安卓原有 Basic Auth 接口保留。Codex 实时语音接口仍属实验接口，是否能成功启动取决于当前 Codex 版本和账号支持。

在网页的 `/` 命令面板点击 `/tts` 可以开启或关闭自动语音朗读。开启后，每个完成的 Codex 助手气泡都会通过浏览器或 Android WebView 的系统 TTS 按顺序朗读；Markdown、链接和代码块会先转换成适合朗读的文字。同一消息在 SSE 重连后不会重复朗读，切换会话或关闭功能会停止当前队列。开关保存在当前浏览器本机。

也可以直接点击自己发送的消息气泡，朗读它后面、下一条用户消息之前的所有 Codex 回复。手动点击朗读不要求先开启 `/tts`；每次点击会先停止当前朗读队列。气泡内的文件或网页链接仍按原来的方式打开。

如果面板提示不支持，请确认 Android 已安装并启用中文 TTS 引擎，同时更新系统 WebView。该网页功能主要用于页面存活时的朗读，不保证锁屏或 APK 被系统彻底挂起后继续播放。

## WebToApp APK 后台通知

Android WebView 的标准 Web Push / `PushManager` 并不可靠。项目另外提供了与 WebToApp 原生前台服务兼容的 WebSocket 端点：

```text
wss://你的域名/<CODEX_REMOTE_ROUTE_PREFIX>/api/notifications/ws
```

例如前缀为默认的 `/codex-remote` 时，地址就是 `wss://你的域名/codex-remote/api/notifications/ws`；如果实际配置为 `/codexremote`，这里也必须使用 `/codexremote`。

配置步骤：

1. 在服务器生成一个独立令牌，并写入 `.env`：

   ```sh
   openssl rand -hex 32
   ```

   ```env
   CODEX_REMOTE_NOTIFICATION_TOKEN=上一步生成的令牌
   ```

2. 重启 Codex Remote 服务，使新令牌生效。
3. 在 WebToApp 中编辑这个应用，打开 APK 导出/构建配置里的“通知推送”：
   - 通知类型：`WebSocket`
   - WebSocket URL：`wss://你的域名/<CODEX_REMOTE_ROUTE_PREFIX>/api/notifications/ws`
   - 鉴权 Token：与 `CODEX_REMOTE_NOTIFICATION_TOKEN` 完全相同
   - 注册 URL：留空
   - 点击系统通知时会直接打开通知聚合 App，不需要填写点击 URL
4. 确保生成 APK 包含通知、前台服务、WakeLock 和开机恢复所需权限；重新构建并覆盖安装 APK。
5. 首次启动时允许系统通知，并在国产 ROM 的电池/后台设置中允许该 APK 后台运行和自启动。
6. 在网页命令菜单点击 `/notify`。连接正常时会立即收到“WebToApp 后台测试通知”。

不要选择只在页面存活时有效的 `Web API` 通知类型。使用 WebSocket 模式时也不需要依赖网页的 Service Worker Push；现有 Web Push 会继续服务普通 Chrome/桌面浏览器。

## 数据目录

运行时数据存在 `data/` 目录（已 gitignore）：

- `remote-state.json` — 本机会话状态
- `drafts.json` / `follow-modes.json` / `thread-model-settings.json` / `thread-names.json` / `message-meta.json`
- `push-vapid.json` / `push-subscriptions.json`
- `generated-images/` / `uploads/`

## 目录结构

```
.
├── server.js          # 入口
├── src/
│   ├── config.js      # 配置与路径常量
│   ├── router.js      # HTTP 路由
│   ├── runner.js      # 会话/任务/命令管理
│   ├── codex-server.js# Codex app-server 封装（transport 抽象）
│   ├── live-voice/    # Android Live Voice 模块化兼容层
│   ├── transport/     # 本机进程与共享 app-server 传输
│   ├── store.js       # 本机状态持久化
│   ├── sse.js         # SSE 广播
│   ├── files.js       # 本机文件管理
│   ├── threads.js     # 会话历史解析
│   ├── webpush.js     # Web Push + 微信通知
│   ├── auth.js / paths.js / utils.js
├── public/            # 前端 PWA
│   ├── remote.html / remote.js / styles.css
│   ├── login.html / pwa.js / sw.js / icon.svg / site.webmanifest
├── package.json
└── .env
```

## 常见问题

- **网页打不开 / 静态资源 404**：检查路由前缀 `CODEX_REMOTE_ROUTE_PREFIX` 和反向代理的 `X-Forwarded-Prefix` 是否一致。
- **登录提示"没有配置登录密码"**：`.env` 没设 `CODEX_REMOTE_PASSWORD`。
- **codex 命令找不到**：设 `CODEX_BIN` 指向 codex 完整路径。
