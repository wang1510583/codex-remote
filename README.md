# Codex Remote Web（总控端）

自托管的 Codex 远程网页控制台。通过浏览器远程操控服务器上的 Codex CLI（`codex app-server`），支持多会话、实时流式输出、文件管理、被控端远程控制、任务完成通知。

被控端 agent 是另一个独立仓库：[codex-remote-connector](./)。

## 架构

```
浏览器 PWA  <--HTTP+SSE-->  总控端 server.js  <--stdio JSON-RPC-->  codex app-server（本机）
                              |
                              +--<WebSocket 隧道>-->  被控端 connector  -->  被控端 codex app-server
                              |
                              +-- Web Push / 微信 -->  任务完成通知
```

- 后端：纯 Node.js（ESM），原生 `http` + `ws`，依赖 `ssh2` + `web-push` + `ws`
- 前端：原生 HTML/CSS/JS（PWA），无构建步骤
- 模块化：`server.js` 入口 + `src/` 下 13 个模块（router/runner/codex-server/connectors/store/sse/files/ssh/webpush/threads/transport 等）

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
| `CODEX_MODEL` | `gpt-5.5` | 默认模型 |
| `CODEX_REASONING_EFFORT` | `medium` | 推理强度 |
| `CODEX_WORK_DIR` | 项目父目录 | 工作目录根（网页端文件管理限制在此目录下） |
| `CODEX_REMOTE_PASSWORD` | — | **必填**，网页登录密码 |
| `CODEX_REMOTE_CONNECTOR_TOKEN` | =登录密码 | 被控端配对令牌（建议单独设置，与登录密码不同） |
| `CODEX_REMOTE_ROUTE_PREFIX` | `/codex-remote` | 路由前缀，用于反向代理子路径 |
| `WEB_PUSH_SUBJECT` | `mailto:admin@...` | Web Push VAPID subject |
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

**nginx** 示例：

```nginx
location /codex-remote/ {
  proxy_pass http://127.0.0.1:5566/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Prefix /codex-remote;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;  # SSE 需要
  proxy_read_timeout 86400s;
}
```

> 反向代理用子路径时，`X-Forwarded-Prefix` 头要让后端知道前缀，否则静态资源路径会错。

## 接入被控端

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
- `drafts.json` / `follow-modes.json` / `thread-names.json` / `message-meta.json`
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
