# 重复知识检测

面向 Elasticsearch `entity` 索引的重复知识候选检测工具。按知识类型过滤后，通过 composite aggregation 分批扫描 `zhLabel.keyword`，仅持久化 `doc_count > 1` 的候选名称，不会自动删除、融合或修改知识。

## 启动

首次使用可通过 Docker 启动 Elasticsearch 并自动创建 `entity` 索引：

```bash
docker compose -f es/docker-compose.yml up -d
```

详细说明见 [`es/README.md`](es/README.md)。

随后启动检测服务：

```bash
bun run start
```

打开 <http://localhost:3000>。Elasticsearch 地址和索引可以在页面顶部配置，最近一次成功连接的配置会保存在当前浏览器中；服务端环境变量作为页面默认值。

## Docker 部署

服务器需安装 Docker Engine 和 Docker Compose 插件。镜像基于 [Bun 官方镜像](https://bun.sh/guides/ecosystem/docker)，固定为 `1.3.12`，以非 root 用户运行；只包含应用代码和静态资源，不包含本机数据库或 ES 凭据。

### 在服务器构建并启动

将项目复制到服务器，在项目目录执行：

```bash
cp .env.example .env
# 编辑 .env，设置 ES_URL、ES_INDEX 以及需要的凭据
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100 app
```

默认通过服务器本机 `http://127.0.0.1:3000` 访问。需要在可信内网通过服务器 IP 访问时，将 `.env` 中 `APP_BIND_ADDRESS` 改为 `0.0.0.0`，再执行 `docker compose up -d`。端口由 `APP_PORT` 控制。应用目前没有登录认证，且支持修改 ES 数据，公网部署应通过带身份认证的 HTTPS 反向代理访问。

`ES_URL` 必须是**容器可以访问的地址**，页面手动填写的地址也一样：

- ES 在其他服务器上：填写 `http://ES服务器内网IP:9200`。
- ES 在 Docker 宿主机上（包括本项目 `es/docker-compose.yml` 发布的 9200 端口）：使用 `http://host.docker.internal:9200`。Compose 已配置 Linux 宿主机网关；ES 需监听容器网关可访问的地址。
- 容器内的 `127.0.0.1` 指向应用容器自身，不能用于访问宿主机 ES。

### 在本机打包，传到服务器

例如服务器是常见的 Linux x86_64（amd64），在本机执行：

```bash
docker buildx build --platform linux/amd64 --load -t now-dedup:1.0.0 .
docker save -o now-dedup-1.0.0.tar now-dedup:1.0.0
scp now-dedup-1.0.0.tar compose.yaml .env.example 用户名@服务器IP:/目标目录/
```

如果服务器是 ARM64，将 `linux/amd64` 改为 `linux/arm64`。然后在服务器目标目录执行：

```bash
docker load -i now-dedup-1.0.0.tar
cp .env.example .env
# 编辑 .env 后启动，无需源码或 Bun 环境
docker compose up -d --no-build
```

### 数据和更新

SQLite 数据库及 WAL 文件保存在 `dedup-data` 命名卷中，重建容器不会丢失任务和处理记录。不要执行 `docker compose down -v`，它会删除该数据卷。保持部署目录名不变（或始终指定相同的 `docker compose -p` 项目名），以复用同一个卷。容器首次启动使用空数据库，不会自动导入本机 `data/`。

当前服务应以单实例运行，避免多个进程同时恢复并处理同一个任务。更新源码部署时执行 `docker compose up -d --build`；离线部署则加载新镜像后执行 `docker compose up -d --no-build --force-recreate`。健康检查只检查应用 HTTP 服务，不依赖 ES 是否在线。

停止服务：`docker compose down`（保留数据）。备份时先 `docker compose stop app`，完整备份卷内文件后再 `docker compose start app`；备份索引仍存储在 ES 中，需单独备份。

## 环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ES_URL` | `http://127.0.0.1:9200` | Elasticsearch 地址 |
| `ES_INDEX` | `entity` | 实体索引 |
| `ES_USERNAME` / `ES_PASSWORD` | 空 | Basic Auth 凭据 |
| `ES_TYPE_FIELD` | `type.keyword` | 知识类型精确字段；实际项目使用 `types` 或 `category` 时在此调整 |
| `ES_NAME_FIELD` | `zhLabel.keyword` | 名称精确字段 |
| `DEDUP_BATCH_SIZE` | `5000` | composite 每批桶数量（100–10000） |
| `ES_MAX_CONCURRENCY` | `2` | 全局 ES 最大并发请求数（1–8） |
| `DEDUP_DB_PATH` | `data/dedup.sqlite` | 任务、断点与候选结果数据库 |
| `PORT` | `3000` | HTTP 端口 |

例如：`ES_URL=http://localhost:9200 ES_INDEX=entity bun run start`。

## 接口

- `GET /api/dedup/config`：页面默认 ES 配置
- `GET /api/dedup/types?esUrl=...&esIndex=...`：指定 ES 的知识类型及数量
- `POST /api/dedup/tasks`：创建后台检测任务，JSON 为 `{ "type": "人物", "esUrl": "http://127.0.0.1:9200", "esIndex": "entity" }`
- `GET /api/dedup/tasks/:taskId`：任务状态及统计
- `GET /api/dedup/tasks/:taskId/groups?page=1&pageSize=20`：重复名称候选
- `GET /api/dedup/tasks/:taskId/entities?name=张三&page=1&pageSize=20`：候选知识详情
- `POST /api/dedup/tasks/:taskId/process`：检测完成后执行安全处理；创建同 mapping 的备份索引，保留所有 `id` 以 `Q` 开头的知识，并在其他知识中保留 `_source` JSON 字节数最大的一条，其余知识先备份再从原索引移除
- `GET /api/dedup/process-records`：最近 100 条处理任务记录
- `GET /api/dedup/tasks/:taskId/report?page=1&pageSize=20`：处理报告汇总及逐组选举明细

服务启动时会自动恢复 `pending` 或 `running` 状态的任务。扫描请求严格串行翻页，并在同一事务中保存候选、统计和 `after_key` 断点。
处理任务也会记录逐组进度。只有备份写入成功后才会删除原索引中的对应知识；服务中断后可继续未完成的分组。
