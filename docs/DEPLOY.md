# 部署 AsaBot

AsaBot 支持 OneBot 11 协议，可以连接已有的 OneBot 11 服务；NapCat、Lagrange.OneBot、LLOneBot 等都是实现该协议的服务示例。AsaBot 与这些服务可运行在同一台机器、不同容器或不同主机上。

## 直接用 Node.js 运行

需要 Node.js 24 或更高版本及 pnpm。以下命令在仓库根目录执行，Windows PowerShell 的复制命令为 `Copy-Item asabot.config.example.yaml asabot.config.yaml`。

也可以先安装依赖、构建面板并直接运行 `pnpm start`，由首次运行向导生成配置。配置文件不存在，或者面板密码和适配器均为空时，控制台 stderr 会显示一次性设置码；打开 `http://127.0.0.1:5140`，输入设置码并设置至少 8 位的面板密码、超管和可选连接。设置码只在当前进程有效，重启后会重新生成。向导将密码明文写入配置文件；之后建议将 `server.panelPassword` 改成 `${ASABOT_PANEL_PASSWORD}`，并通过环境变量或 `.env` 提供密码。

首次生成配置时可用 `ASABOT_HOST` 和 `ASABOT_PORT` 设置监听地址和端口，默认是 `127.0.0.1` 和 `5140`；这两个变量不会覆盖已有配置。

```sh
pnpm install --frozen-lockfile
cp asabot.config.example.yaml asabot.config.yaml
pnpm --filter web build
```

编辑配置文件，根据实际接入方式配置 `adapters.onebot11`。默认面板只监听 `127.0.0.1:5140`。设置面板密码、按需设置 API token 及连接 token，然后以生产模式启动：

```sh
export NODE_ENV=production
export ASABOT_PANEL_PASSWORD='填写强密码'
export ASABOT_API_TOKEN='填写API令牌'
export ONEBOT_TOKEN='填写正向连接令牌'
node src/main.ts
```

PowerShell 可用 `$env:NODE_ENV = 'production'`、`$env:ASABOT_PANEL_PASSWORD = '填写强密码'` 等设置同名变量。也可在工作目录的 `.env` 中填写 `变量名=值`，启动时会自动加载；生产模式默认关闭插件热重载。`ASABOT_API_TOKEN` 为空时对外 API 关闭。`ASABOT_CONFIG` 可指定其他配置文件。

访问 `http://127.0.0.1:5140` 登录面板。只要面板、对外 API 或反向连接之一已启用，HTTP 服务就会监听；运行后可通过无需登录的 `GET /healthz` 检查，响应包含 `ok` 和在线/全部 Bot 数量。面板、对外 API 与反向连接均未启用时，HTTP 服务不会启动。

## Docker 和 Compose

使用首次运行向导时，准备可写的 `config`、`data` 目录和 Compose 所需的 `.env` 文件，不必先复制配置。启动后运行 `docker compose logs -f asabot` 查看本次设置码，访问 `http://127.0.0.1:5140` 完成设置。镜像在生成配置时默认监听 `0.0.0.0`，Compose 默认只发布到宿主机的 `127.0.0.1`。也可以按下面的步骤预先准备完整配置。

在仓库根目录准备配置及环境变量：

```sh
mkdir -p config data
cp asabot.config.docker.yaml config/asabot.config.yaml
```

创建 `.env`，至少设置非空的 `ASABOT_PANEL_PASSWORD`。按需设置 `ASABOT_API_TOKEN`、`ONEBOT_TOKEN` 和 `ONEBOT_REVERSE_TOKEN`，连接 token 要与对应 OneBot 服务一致。使用较长的随机值，并限制 `.env` 的读取权限，不要提交该文件。Docker 示例配置在容器内监听 `0.0.0.0:5140`，Compose 默认只把端口发布到宿主机的 `127.0.0.1:5140`。

Compose 的 `TZ` 默认为 `Asia/Shanghai`，可在 `.env` 中设置其他 IANA 时区，例如 `TZ=Europe/London`。配置文件中的 `timezone` 优先于 `TZ`；两者都未设置时使用系统时区。cron 和面板的“今日”统计使用该时区，单个 cron 任务也可单独指定时区。直接使用 `docker run` 时可通过 `-e TZ=Asia/Shanghai` 设置。

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f asabot
curl http://127.0.0.1:5140/healthz
```

Compose 只启动 AsaBot；OneBot 服务需要自行准备。`/healthz` 检查 HTTP 服务是否运行，Bot 离线时也会返回成功，可结合响应中的 `bots.online` 查看连接状态。停止服务使用 `docker compose stop`。

也可直接构建和运行容器（示例为 Linux/macOS shell）：

```sh
docker build -t asabot .
docker run -d --name asabot --restart unless-stopped \
  -p 127.0.0.1:5140:5140 --env-file .env \
  --mount type=bind,src="$(pwd)/data",dst=/app/data \
  --mount type=bind,src="$(pwd)/plugins",dst=/app/plugins \
  --mount type=bind,src="$(pwd)/config",dst=/app/config \
  asabot
```

镜像内置仓库的示例插件；挂载宿主机插件目录后，目录中的文件会覆盖镜像中该路径的内容。首次使用可直接挂载仓库自带的 `plugins` 目录。容器以 `node` 用户运行；在 Linux 上应确保挂载的 `data` 和 `config` 目录对容器 UID 1000 可写，插件目录可读。例如可执行 `sudo chown -R 1000:1000 ./data ./config`，其他平台按宿主机的文件权限机制设置。

插件包默认安装在数据目录的 `packages` 子目录，包含 npm 缓存和已安装包；持久化整个 `/app/data` 即可在重建容器后保留它们。如果配置了其他 `packages.dir`，需要单独持久化该目录。面板上传文件插件时，`pluginLoader.uploadDir` 对容器用户也必须可写。可将 `packages.registry` 改为可访问的 registry 镜像，例如 `https://registry.npmmirror.com`；框架查询和 npm 安装都会使用该地址。

### 配置文件写回

镜像通过 `ASABOT_CONFIG=/app/config/asabot.config.yaml` 读取配置，Compose 挂载的是整个 `config` 目录。框架在面板或聊天命令中修改插件全局开关、插件配置时，会先在同一目录写临时文件再原子替换，结果直接保存到宿主机的 `config/asabot.config.yaml`，注释和 `${VAR}` 原文都会保留。请不要改成只挂载单个配置文件：Linux 上单文件挂载不能被原子替换，写回会失败。按群开关和访问控制保存在数据目录的 SQLite 中。

## 连接 OneBot 11 服务

两种连接方式可以同时配置；所有 token 都建议通过环境变量提供。在宿主机修改配置后执行 `docker compose restart asabot` 使其生效。

### 正向 WebSocket

OneBot 实现开启 OneBot 11 WebSocket 服务端，AsaBot 主动连接。将 Docker 示例中的 `connections: []` 替换为：

```yaml
connections:
  - type: forward
    url: ws://host.docker.internal:3001
    accessToken: ${ONEBOT_TOKEN}
```

直接运行 Node 且服务在本机时，地址可用 `ws://127.0.0.1:3001`。在容器中 `127.0.0.1` 指向容器自身；Docker Desktop 的宿主机可用 `host.docker.internal`，本仓库 Compose 也为 Linux 配置了 `host-gateway`。宿主机服务还需监听容器能访问的地址并允许相应连接。如果服务在远程主机，填写其可达地址，优先使用 `wss://`。

服务在另一个容器时，可以使用双方所在 Docker 网络中的服务名或容器名及内部监听端口。不同 Compose 项目可以先运行 `docker network create asabot-onebot`，然后在双方项目中将网络声明为 `external: true`、名称设为 `asabot-onebot`，并让两个服务都加入该网络；本仓库 `compose.yaml` 中提供了可取消注释的示例。地址例如 `ws://<对方服务名>:3001`。

### 反向 WebSocket

AsaBot 接收连接，OneBot 实现主动连接。配置：

```yaml
adapters:
  onebot11:
    connections: []
    reverse:
      enabled: true
      accessToken: ${ONEBOT_REVERSE_TOKEN}
```

在 OneBot 实现中配置 OneBot 11 Universal WebSocket 客户端，地址填 `ws://<host>:5140/onebot/v11/ws`，token 与 `ONEBOT_REVERSE_TOKEN` 一致。对端需发送 `X-Self-ID`；多个账号可以连接同一地址。Compose 默认只在宿主机本地发布端口，远程客户端需通过反向代理访问，或将端口发布到受控网络接口。在 TLS 代理后使用 `wss://<域名>/onebot/v11/ws`。

## HTTPS 反向代理

面板对外开放时，务必通过 HTTPS 反向代理访问，并只将 AsaBot 端口暴露给代理或可信网络。代理要保留原始 `Host`（包括非默认端口），以通过面板的 Origin 检查；同时使用 HTTP/1.1 转发 `Upgrade` 和 `Connection`，让面板实时推送及反向 WebSocket 正常工作。下面是 Nginx 配置要点，证书、域名和监听地址需按实际环境替换：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name bot.example.com;
    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5140;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 75s;
    }
}
```

面板登录限流使用 AsaBot 看到的直接连接 IP，不读取 `X-Forwarded-For`。通过同一个代理访问时，所有访客会共享代理 IP 的每分钟 10 次登录尝试额度；代理自己的按客户端 IP 限流可以增加一层保护，但不会改变应用内的共享额度。可配合 VPN、访问控制和代理限流收紧入口。

## 数据、备份和升级

数据目录包含 `asabot.db`、SQLite 的 WAL 文件以及插件数据。备份前先停止 AsaBot，再备份整个数据目录、用户插件和实际使用的配置文件；环境变量和 `.env` 应单独安全保存。恢复时使用对应的数据、插件和配置，并确保容器用户有正确的读写权限。

升级前先停止服务并完成备份。更新仓库代码后，直接运行方式执行 `pnpm install --frozen-lockfile` 和 `pnpm --filter web build` 再启动；Compose 方式执行 `docker compose up -d --build`。升级后检查日志、`/healthz`、面板和 OneBot 连接。升级时保留原有数据挂载，不要清理数据卷。
