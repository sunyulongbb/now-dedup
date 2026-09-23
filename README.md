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

## 配置

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
