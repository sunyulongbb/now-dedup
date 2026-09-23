# Elasticsearch

此目录使用 Docker Compose 启动单节点 Elasticsearch，并自动创建 `entity` 索引。配置面向本地开发，安全认证默认关闭，不应直接用于公网环境。

## 启动

请先安装并启动 Docker Desktop，然后在项目根目录执行：

```bash
docker compose -f es/docker-compose.yml up -d
```

首次启动需要拉取镜像。Elasticsearch 健康后，`es-init` 容器会按 `entity-index.json` 创建索引；如果索引已经存在则直接成功退出，不会覆盖索引或数据。

验证服务和索引：

```bash
curl http://localhost:9200
curl http://localhost:9200/entity/_mapping
```

然后启动本项目：

```bash
bun run start
```

## 创建测试数据

Elasticsearch 启动且 `entity` 索引创建完成后，在项目根目录执行：

```bash
bun run seed:es
```

脚本会通过 Bulk API 写入 1000 条固定 ID 的测试实体，分为人物、机构、地点、事件和产品 5 种类型。每种类型有 100 组重复名称、每组 2 条数据，可直接用于验证重复检测。脚本使用相同 ID 覆盖写入，因此重复执行不会增加文档数量。

如需写入其他 Elasticsearch 地址或索引：

```bash
ES_URL=http://localhost:9200 ES_INDEX=entity bun run seed:es
```

## 常用命令

```bash
# 查看容器状态
docker compose -f es/docker-compose.yml ps

# 查看初始化日志
docker compose -f es/docker-compose.yml logs es-init

# 停止服务（保留数据）
docker compose -f es/docker-compose.yml down

# 停止服务并删除 Elasticsearch 数据卷
docker compose -f es/docker-compose.yml down -v
```

`down -v` 会永久删除本地 Elasticsearch 索引数据，请谨慎执行。
