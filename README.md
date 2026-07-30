# Codex Remote Web（总控端）

自托管的 Codex 远程网页控制台。通过浏览器远程操控服务器上的 Codex CLI（`codex app-server`），支持多会话、实时流式输出、Codex Desktop/CLI 外部会话同步、文件管理、被控端远程控制、任务完成通知。

被控端 agent 是另一个独立仓库：[codex-remote-connector](./)。

## 架构

```
浏览器 PWA  <--HTTP+SSE-->  总控端 server.js  <--Unix WebSocket-->  Codex Desktop 共享 app-server（本机）
                              |                    └─不可用时回退 stdio 独立进程
                              |
Android 语音 App <--HTTP+WS--> Live Voice 兼容层 <--WebRTC信令--> 专用 realtime app-server
                              |                                  └─恢复并持有网页当前 thread
                              |
                              +--<WebSocket 隧道>-->  被控端 connector  -->  被控端 codex app-server
                              |
                              +-- Web Push / 微信 -->  任务完成通知
```

- 后端：纯 Node.js（ESM），原生 `http` + `ws`，依赖 `ssh2` + `web-push` + `ws`
- 前端：原生 HTML/CSS/JS（PWA），无构建步骤
- 模块化：`server.js` 入口 + `src/` 下按职责拆分的模块（router/runner/codex-server/connectors/store/live-voice/transport 等）
- 本机会话可并行执行：不同会话各用独立 app-server 客户端；同一会话的新消息仍按 `queue` / `steer` 设置处理。被控端 connector 当前只有一个执行通道，因此仍按设备串行。

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
| `CODEX_EXTERNAL_SESSION_POLL_MS` | `1000` | 本机/被控端 Codex Desktop/CLI 外部会话同步间隔 |
| `CODEX_EXTERNAL_SESSION_STALE_MS` | `7200000` | 无 `task_complete` 且长时间无文件活动时的故障兜底 |
| `CODEX_REMOTE_PASSWORD` | — | **必填**，网页登录密码 |
| `CODEX_REMOTE_CONNECTOR_TOKEN` | =登录密码 | 被控端配对令牌（建议单独设置，与登录密码不同） |
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

网页文字端可以继续使用共享 app-server daemon；Live Voice 则由兼容层启动并持有一个专用、明确启用实时能力的 app-server：

```sh
codex features enable realtime_conversation
```

这是因为 Codex 会在线程载入时确定它是否支持 Realtime。即使旧的共享 daemon 后来修改了配置，它已经载入的 thread 仍可能拒绝 `thread/realtime/start`。专用进程会用 `--enable realtime_conversation` 启动，避开这个旧线程状态；兼容层的租约仍保证网页和 Android 不会同时写入同一个 thread。

协调规则：

- Android 网络短暂中断时，服务端默认保留原运行时 60 秒；自动重连会复用同一个 app-server 和 thread。
- 关闭语音时只停止 WebRTC 音频。如果已经委派了 Codex 任务，任务会继续在后台运行，完成后再释放会话。
- 网页选中同一 thread 时不会再显示成“其他客户端”；网页输入会发送到当前 Live Voice，或用 `turn/steer` 引导已委派的任务。网页输入 `/stop` 可以中断该任务。
- 真正由 Codex Desktop/其他 CLI 占用的同一 thread 仍保持只读同步，避免双写。

当前限制：

- 只支持总控服务器的“本机”会话；网页若切换到 connector/SSH 被控端，接口会明确返回 `409`，不会误连到别的目录。
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

## 接入被控端

控制总控端所在的本机不需要安装被控端：服务会直接连接本机 Codex Desktop/CLI。只有控制其他电脑时才需要安装被控端 agent。

1. 在 `.env` 设置 `CODEX_REMOTE_CONNECTOR_TOKEN`（与登录密码不同更安全）
2. 在被控电脑上安装被控端 agent（见被控端仓库 README），安装时填总控端 URL + 配对令牌
3. 被控端注册成功后会出现在网页的「PC 被控电脑」面板，点击切换即可像控制本机一样控制它

## 纯控制中心模式（服务器不跑 codex）

如果服务器只作为控制中心、不在服务器上跑 Codex（例如迁移到一台没装 codex CLI 的服务器），在 `.env` 设置：

```
CODEX_REMOTE_DISABLE_LOCAL=1
```

效果：

- 网页「PC 被控电脑」面板**不显示"本机"选项**
- 必须先添加被控端并切换过去才能使用，避免误用本机报错
- 没有被控端时面板提示"请安装被控端"

适合：一台服务器管理多台被控电脑，服务器本身不参与 Codex 执行。

## 数据目录

运行时数据存在 `data/` 目录（已 gitignore）：

- `remote-state.json` — 本机会话状态
- `remote-state-<connectorId>.json` — 各被控端会话状态
- `connectors.json` — 被控端设备注册信息
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
│   ├── transport/     # local(spawn) / remote(ws 隧道)
│   ├── connectors.js  # 被控端设备 + WebSocket 隧道
│   ├── store.js       # 持久化（按 connectorId 隔离）
│   ├── sse.js         # SSE 广播
│   ├── files.js       # 本机文件管理
│   ├── ssh.js         # SSH/SFTP 远程文件
│   ├── threads.js     # 会话历史解析
│   ├── webpush.js     # Web Push + 微信通知
│   ├── auth.js / paths.js / utils.js
├── public/            # 前端 PWA
│   ├── remote.html / remote.js / styles.css
│   ├── login.html / pwa.js / sw.js / icon.svg / site.webmanifest
├── package.json
└── .env
```

## 与被控端的关系

本仓库只包含总控端。被控端 agent（装在被控制电脑上）是另一个独立仓库，代码零相互依赖。迁移服务器拉本仓库，新增被控端拉被控端仓库。

## 常见问题

- **网页打不开 / 静态资源 404**：检查路由前缀 `CODEX_REMOTE_ROUTE_PREFIX` 和反向代理的 `X-Forwarded-Prefix` 是否一致。
- **登录提示"没有配置登录密码"**：`.env` 没设 `CODEX_REMOTE_PASSWORD`。
- **被控端连不上**：确认被控端 `config.json` 的 `serverUrl` 含完整前缀（如 `https://host:5566/codex-remote`），且 `CODEX_REMOTE_CONNECTOR_TOKEN` 与总控端一致。
- **codex 命令找不到**：设 `CODEX_BIN` 指向 codex 完整路径。
