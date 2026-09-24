import { serve } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const config = {
  port: Number(Bun.env.PORT ?? 3000),
  esUrl: (Bun.env.ES_URL ?? "http://127.0.0.1:9200").replace(/\/$/, ""),
  esIndex: Bun.env.ES_INDEX ?? "entity",
  esUsername: Bun.env.ES_USERNAME,
  esPassword: Bun.env.ES_PASSWORD,
  typeField: Bun.env.ES_TYPE_FIELD ?? "type.keyword",
  nameField: Bun.env.ES_NAME_FIELD ?? "zhLabel.keyword",
  batchSize: Math.min(10_000, Math.max(100, Number(Bun.env.DEDUP_BATCH_SIZE ?? 5000))),
  esConcurrency: Math.min(8, Math.max(1, Number(Bun.env.ES_MAX_CONCURRENCY ?? 2))),
  dbPath: Bun.env.DEDUP_DB_PATH ?? "data/dedup.sqlite",
};

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS dedup_tasks (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, es_url TEXT NOT NULL, es_index TEXT NOT NULL, status TEXT NOT NULL,
    duplicate_group_count INTEGER NOT NULL DEFAULT 0,
    duplicate_entity_count INTEGER NOT NULL DEFAULT 0,
    scanned_name_count INTEGER NOT NULL DEFAULT 0,
    after_key TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS dedup_groups (
    task_id TEXT NOT NULL, name TEXT NOT NULL, doc_count INTEGER NOT NULL,
    PRIMARY KEY (task_id, name),
    FOREIGN KEY (task_id) REFERENCES dedup_tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_groups_task_count ON dedup_groups(task_id, doc_count DESC, name);
  CREATE TABLE IF NOT EXISTS dedup_processed_groups (
    task_id TEXT NOT NULL, name TEXT NOT NULL, kept_count INTEGER NOT NULL, moved_count INTEGER NOT NULL,
    status TEXT NOT NULL, processed_at TEXT NOT NULL,
    PRIMARY KEY (task_id, name),
    FOREIGN KEY (task_id) REFERENCES dedup_tasks(id) ON DELETE CASCADE
  );
`);
const taskColumns = new Set((db.query("PRAGMA table_info(dedup_tasks)").all() as Array<{ name: string }>).map((item) => item.name));
if (!taskColumns.has("es_url")) {
  db.exec("ALTER TABLE dedup_tasks ADD COLUMN es_url TEXT");
  db.query("UPDATE dedup_tasks SET es_url = ? WHERE es_url IS NULL").run(config.esUrl);
}
if (!taskColumns.has("es_index")) {
  db.exec("ALTER TABLE dedup_tasks ADD COLUMN es_index TEXT");
  db.query("UPDATE dedup_tasks SET es_index = ? WHERE es_index IS NULL").run(config.esIndex);
}
for (const [name, definition] of [
  ["processing_status", "TEXT"], ["backup_index", "TEXT"],
  ["processed_group_count", "INTEGER NOT NULL DEFAULT 0"], ["kept_entity_count", "INTEGER NOT NULL DEFAULT 0"],
  ["moved_entity_count", "INTEGER NOT NULL DEFAULT 0"], ["process_error", "TEXT"], ["processed_at", "TEXT"],
] as const) {
  if (!taskColumns.has(name)) db.exec(`ALTER TABLE dedup_tasks ADD COLUMN ${name} ${definition}`);
}
const processedGroupColumns = new Set((db.query("PRAGMA table_info(dedup_processed_groups)").all() as Array<{ name: string }>).map((item) => item.name));
if (!processedGroupColumns.has("detail_json")) db.exec("ALTER TABLE dedup_processed_groups ADD COLUMN detail_json TEXT");

type TaskRow = {
  id: string; type: string; es_url: string; es_index: string; status: string; duplicate_group_count: number;
  duplicate_entity_count: number; scanned_name_count: number; after_key: string | null;
  error: string | null; created_at: string; finished_at: string | null;
  processing_status: string | null; backup_index: string | null; processed_group_count: number;
  kept_entity_count: number; moved_entity_count: number; process_error: string | null; processed_at: string | null;
};
const taskSelect = `SELECT id, type, es_url, es_index, status, duplicate_group_count, duplicate_entity_count,
  scanned_name_count, after_key, error, created_at, finished_at, processing_status, backup_index,
  processed_group_count, kept_entity_count, moved_entity_count, process_error, processed_at FROM dedup_tasks`;
const running = new Set<string>();
const processing = new Set<string>();
let activeEsRequests = 0;
const esWaiters: Array<() => void> = [];
class RequestError extends Error {}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
function taskJson(row: TaskRow) {
  return {
    taskId: row.id, type: row.type, esUrl: row.es_url, esIndex: row.es_index, status: row.status,
    duplicateGroupCount: row.duplicate_group_count,
    duplicateEntityCount: row.duplicate_entity_count,
    scannedNameCount: row.scanned_name_count,
    afterKey: row.after_key ? JSON.parse(row.after_key) : null,
    error: row.error, createdAt: row.created_at, finishedAt: row.finished_at,
    processing: {
      status: row.processing_status, backupIndex: row.backup_index,
      processedGroupCount: row.processed_group_count, keptEntityCount: row.kept_entity_count,
      movedEntityCount: row.moved_entity_count, error: row.process_error, processedAt: row.processed_at,
    },
  };
}
async function esRequest(esUrl: string, path: string, method: "GET" | "POST" | "PUT" | "HEAD" | "DELETE", body?: unknown): Promise<any> {
  if (activeEsRequests >= config.esConcurrency) await new Promise<void>((resolve) => esWaiters.push(resolve));
  activeEsRequests++;
  const headers: Record<string, string> = { "content-type": typeof body === "string" ? "application/x-ndjson" : "application/json" };
  try {
    if (config.esUsername) headers.authorization = `Basic ${btoa(`${config.esUsername}:${config.esPassword ?? ""}`)}`;
    const response = await fetch(`${esUrl}/${path}`, {
      method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Elasticsearch ${response.status}: ${(await response.text()).slice(0, 1200)}`);
    return response.json();
  } finally {
    activeEsRequests--;
    esWaiters.shift()?.();
  }
}
async function es(esUrl: string, esIndex: string, path: string, body: unknown): Promise<any> {
  return esRequest(esUrl, `${encodeURIComponent(esIndex)}/${path}`, "POST", body);
}

async function runTask(taskId: string) {
  if (running.has(taskId)) return;
  running.add(taskId);
  try {
    db.query("UPDATE dedup_tasks SET status = 'running', error = NULL WHERE id = ?").run(taskId);
    while (true) {
      const task = db.query(`${taskSelect} WHERE id = ?`).get(taskId) as TaskRow | null;
      if (!task) return;
      const composite: Record<string, unknown> = {
        size: config.batchSize,
        sources: [{ name: { terms: { field: config.nameField } } }],
      };
      if (task.after_key) composite.after = JSON.parse(task.after_key);
      const result = await es(task.es_url, task.es_index, "_search", {
        size: 0, query: { term: { [config.typeField]: task.type } },
        aggs: { names: { composite } },
      });
      const names = result.aggregations?.names;
      const buckets: Array<{ key: { name: string }; doc_count: number }> = names?.buckets ?? [];
      const duplicates = buckets.filter((bucket) => bucket.doc_count > 1);
      const done = !names?.after_key || buckets.length === 0;
      db.transaction(() => {
        const insert = db.query(`INSERT INTO dedup_groups(task_id, name, doc_count) VALUES (?, ?, ?)
          ON CONFLICT(task_id, name) DO UPDATE SET doc_count = excluded.doc_count`);
        for (const bucket of duplicates) insert.run(taskId, bucket.key.name, bucket.doc_count);
        db.query(`UPDATE dedup_tasks SET duplicate_group_count = duplicate_group_count + ?,
          duplicate_entity_count = duplicate_entity_count + ?, scanned_name_count = scanned_name_count + ?,
          after_key = ? WHERE id = ?`).run(
            duplicates.length, duplicates.reduce((sum, item) => sum + item.doc_count, 0), buckets.length,
            names?.after_key ? JSON.stringify(names.after_key) : null, taskId,
          );
        if (done) db.query("UPDATE dedup_tasks SET status = 'completed', finished_at = ? WHERE id = ?")
          .run(new Date().toISOString(), taskId);
      })();
      if (done) break;
    }
  } catch (error) {
    db.query("UPDATE dedup_tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(error instanceof Error ? error.message : String(error), new Date().toISOString(), taskId);
  } finally { running.delete(taskId); }
}

type EntityHit = { _id: string; _index: string; _routing?: string; _source: Record<string, unknown> };

function sourceSize(hit: EntityHit) {
  return Buffer.byteLength(JSON.stringify(hit._source), "utf8");
}

async function duplicateEntities(task: TaskRow, name: string): Promise<EntityHit[]> {
  const result = await es(task.es_url, task.es_index, "_search", {
    size: 10_000, track_total_hits: true,
    query: { bool: { filter: [{ term: { [config.typeField]: task.type } }, { term: { [config.nameField]: name } }] } },
  });
  const hits = (result.hits?.hits ?? []) as EntityHit[];
  const total = typeof result.hits?.total === "number" ? result.hits.total : result.hits?.total?.value ?? 0;
  if (total > hits.length) throw new Error(`重复组“${name}”超过 10000 条，已停止处理以避免遗漏数据`);
  return hits;
}

async function ensureBackupIndex(task: TaskRow) {
  const backupIndex = task.backup_index ?? `${task.es_index.slice(0, 200)}-dedup-backup-${task.id.slice(0, 8)}`;
  if (!task.backup_index) {
    const indexResponse = await esRequest(task.es_url, encodeURIComponent(task.es_index), "GET");
    const sourceDefinition = indexResponse[task.es_index];
    const mappings = sourceDefinition?.mappings;
    if (!mappings) throw new Error("无法读取原索引 mapping");
    const sourceSettings = sourceDefinition.settings?.index ?? {};
    const settings = Object.fromEntries([
      "number_of_shards", "number_of_replicas", "analysis", "similarity", "mapping", "sort",
      "codec", "routing", "refresh_interval", "max_ngram_diff", "max_shingle_diff", "max_result_window",
    ].filter((key) => sourceSettings[key] !== undefined).map((key) => [key, sourceSettings[key]]));
    try {
      await esRequest(task.es_url, encodeURIComponent(backupIndex), "PUT", { settings, mappings });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("resource_already_exists_exception")) throw error;
    }
    db.query("UPDATE dedup_tasks SET backup_index = ? WHERE id = ?").run(backupIndex, task.id);
  }
  return backupIndex;
}

async function bulkMove(esUrl: string, sourceIndex: string, backupIndex: string, hits: EntityHit[]) {
  if (!hits.length) return;
  const copyLines: string[] = [];
  for (const hit of hits) {
    const metadata: Record<string, unknown> = { _index: backupIndex, _id: hit._id };
    if (hit._routing) metadata.routing = hit._routing;
    copyLines.push(JSON.stringify({ index: metadata }), JSON.stringify(hit._source));
  }
  const copied = await esRequest(esUrl, "_bulk?refresh=wait_for", "POST", `${copyLines.join("\n")}\n`);
  if (copied.errors) {
    const failure = copied.items?.find((item: any) => item.index?.error)?.index?.error;
    throw new Error(`写入备份索引失败：${JSON.stringify(failure ?? "未知错误")}`);
  }

  const deleteLines = hits.map((hit) => {
    const metadata: Record<string, unknown> = { _index: sourceIndex, _id: hit._id };
    if (hit._routing) metadata.routing = hit._routing;
    return JSON.stringify({ delete: metadata });
  });
  const deleted = await esRequest(esUrl, "_bulk?refresh=wait_for", "POST", `${deleteLines.join("\n")}\n`);
  if (deleted.errors) {
    const failure = deleted.items?.find((item: any) => item.delete?.error)?.delete?.error;
    throw new Error(`从原索引移除失败：${JSON.stringify(failure ?? "未知错误")}`);
  }
}

async function processTask(taskId: string) {
  if (processing.has(taskId)) return;
  processing.add(taskId);
  try {
    let task = db.query(`${taskSelect} WHERE id = ?`).get(taskId) as TaskRow | null;
    if (!task || task.status !== "completed") throw new Error("仅检测完成的任务可以执行处理");
    db.query("UPDATE dedup_tasks SET processing_status = 'running', process_error = NULL WHERE id = ?").run(taskId);
    const backupIndex = await ensureBackupIndex(task);
    task = db.query(`${taskSelect} WHERE id = ?`).get(taskId) as TaskRow;
    const groups = db.query(`SELECT name FROM dedup_groups WHERE task_id = ? AND name NOT IN
      (SELECT name FROM dedup_processed_groups WHERE task_id = ? AND status = 'completed') ORDER BY name`).all(taskId, taskId) as Array<{ name: string }>;

    for (const group of groups) {
      const hits = await duplicateEntities(task, group.name);
      const wikidata = hits.filter((hit) => typeof hit._source.id === "string" && hit._source.id.startsWith("Q"));
      const candidates = hits.filter((hit) => !wikidata.includes(hit));
      candidates.sort((a, b) => sourceSize(b) - sourceSize(a) || a._id.localeCompare(b._id));
      const elected = candidates[0] ? [candidates[0]] : [];
      const losers = candidates.slice(1);
      await bulkMove(task.es_url, task.es_index, backupIndex, losers);
      const keptCount = wikidata.length + elected.length;
      const auditItem = (hit: EntityHit) => ({
        id: typeof hit._source.id === "string" ? hit._source.id : hit._id,
        documentId: hit._id, sourceBytes: sourceSize(hit),
      });
      const detail = JSON.stringify({
        wikidata: wikidata.map(auditItem), elected: elected.map(auditItem), moved: losers.map(auditItem),
      });
      db.transaction(() => {
        db.query(`INSERT INTO dedup_processed_groups(task_id, name, kept_count, moved_count, status, processed_at, detail_json)
          VALUES (?, ?, ?, ?, 'completed', ?, ?) ON CONFLICT(task_id, name) DO UPDATE SET
          kept_count = excluded.kept_count, moved_count = excluded.moved_count,
          status = excluded.status, processed_at = excluded.processed_at, detail_json = excluded.detail_json`)
          .run(taskId, group.name, keptCount, losers.length, new Date().toISOString(), detail);
        db.query(`UPDATE dedup_tasks SET processed_group_count = processed_group_count + 1,
          kept_entity_count = kept_entity_count + ?, moved_entity_count = moved_entity_count + ? WHERE id = ?`)
          .run(keptCount, losers.length, taskId);
      })();
    }
    db.query("UPDATE dedup_tasks SET processing_status = 'completed', processed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), taskId);
  } catch (error) {
    db.query("UPDATE dedup_tasks SET processing_status = 'failed', process_error = ? WHERE id = ?")
      .run(error instanceof Error ? error.message : String(error), taskId);
  } finally { processing.delete(taskId); }
}

async function listTypes(esUrl: string, esIndex: string) {
  const items: Array<{ type: string; count: number }> = [];
  let after: Record<string, unknown> | undefined;
  do {
    const composite: Record<string, unknown> = {
      size: 1000, sources: [{ type: { terms: { field: config.typeField } } }],
    };
    if (after) composite.after = after;
    const result = await es(esUrl, esIndex, "_search", { size: 0, aggs: { types: { composite } } });
    const aggregation = result.aggregations?.types;
    for (const item of aggregation?.buckets ?? []) items.push({ type: String(item.key.type), count: Number(item.doc_count) });
    after = aggregation?.after_key;
  } while (after);
  return items.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type, "zh-CN"));
}
function positive(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
function target(esUrlValue: unknown, esIndexValue: unknown) {
  if (typeof esUrlValue !== "string" || typeof esIndexValue !== "string") throw new RequestError("请填写 Elasticsearch 地址和索引");
  let parsed: URL;
  try { parsed = new URL(esUrlValue.trim()); } catch { throw new RequestError("Elasticsearch 地址格式不正确"); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new RequestError("Elasticsearch 地址仅支持不含凭据的 HTTP/HTTPS 地址");
  const esUrl = parsed.toString().replace(/\/$/, "");
  const esIndex = esIndexValue.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(esIndex) || esIndex === "." || esIndex === "..") throw new RequestError("索引名称格式不正确");
  return { esUrl, esIndex };
}

async function api(request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/dedup/config") {
    return json({ esUrl: config.esUrl, esIndex: config.esIndex, fields: { type: config.typeField, name: config.nameField } });
  }
  if (request.method === "GET" && url.pathname === "/api/dedup/types") {
    const { esUrl, esIndex } = target(url.searchParams.get("esUrl"), url.searchParams.get("esIndex"));
    return json({ items: await listTypes(esUrl, esIndex), fields: { type: config.typeField, name: config.nameField } });
  }
  if (request.method === "GET" && url.pathname === "/api/dedup/process-records") {
    const items = (db.query(`${taskSelect} WHERE processing_status IS NOT NULL ORDER BY COALESCE(processed_at, created_at) DESC LIMIT 100`).all() as TaskRow[])
      .map(taskJson);
    return json({ items });
  }
  if (request.method === "POST" && url.pathname === "/api/dedup/tasks") {
    const body = await request.json().catch(() => null) as { type?: unknown; esUrl?: unknown; esIndex?: unknown } | null;
    const type = typeof body?.type === "string" ? body.type.trim() : "";
    if (!type || type.length > 200) return json({ error: "请选择有效的知识类型" }, 400);
    const { esUrl, esIndex } = target(body?.esUrl, body?.esIndex);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    db.query("INSERT INTO dedup_tasks(id, type, es_url, es_index, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(id, type, esUrl, esIndex, createdAt);
    void runTask(id);
    return json({ taskId: id, type, esUrl, esIndex, status: "pending", createdAt }, 202);
  }
  const processMatch = url.pathname.match(/^\/api\/dedup\/tasks\/([^/]+)\/process$/);
  if (request.method === "POST" && processMatch) {
    const task = db.query(`${taskSelect} WHERE id = ?`).get(processMatch[1]!) as TaskRow | null;
    if (!task) return json({ error: "任务不存在" }, 404);
    if (task.status !== "completed") return json({ error: "检测完成后才能处理重复知识" }, 409);
    if (task.processing_status === "completed") return json({ error: "该任务已经处理完成" }, 409);
    if (processing.has(task.id)) return json({ taskId: task.id, processing: taskJson(task).processing }, 202);
    void processTask(task.id);
    return json({ taskId: task.id, processing: { ...taskJson(task).processing, status: "running" } }, 202);
  }
  const reportMatch = url.pathname.match(/^\/api\/dedup\/tasks\/([^/]+)\/report$/);
  if (request.method === "GET" && reportMatch) {
    const task = db.query(`${taskSelect} WHERE id = ?`).get(reportMatch[1]!) as TaskRow | null;
    if (!task) return json({ error: "处理记录不存在" }, 404);
    const page = positive(url.searchParams.get("page"), 1, 1_000_000);
    const pageSize = positive(url.searchParams.get("pageSize"), 20, 100);
    const total = Number((db.query("SELECT COUNT(*) count FROM dedup_processed_groups WHERE task_id = ?").get(task.id) as any).count);
    const groups = (db.query(`SELECT name, kept_count, moved_count, status, processed_at, detail_json
      FROM dedup_processed_groups WHERE task_id = ? ORDER BY name LIMIT ? OFFSET ?`)
      .all(task.id, pageSize, (page - 1) * pageSize) as Array<any>).map((group) => ({
        name: group.name, keptCount: group.kept_count, movedCount: group.moved_count,
        status: group.status, processedAt: group.processed_at,
        details: group.detail_json ? JSON.parse(group.detail_json) : { wikidata: [], elected: [], moved: [] },
      }));
    return json({ task: taskJson(task), groups, total, page, pageSize });
  }
  const statusMatch = url.pathname.match(/^\/api\/dedup\/tasks\/([^/]+)$/);
  if (request.method === "GET" && statusMatch) {
    const row = db.query(`${taskSelect} WHERE id = ?`).get(statusMatch[1]!) as TaskRow | null;
    return row ? json(taskJson(row)) : json({ error: "任务不存在" }, 404);
  }
  const resultsMatch = url.pathname.match(/^\/api\/dedup\/tasks\/([^/]+)\/groups$/);
  if (request.method === "GET" && resultsMatch) {
    const taskId = resultsMatch[1]!;
    const page = positive(url.searchParams.get("page"), 1, 1_000_000);
    const pageSize = positive(url.searchParams.get("pageSize"), 20, 100);
    if (!db.query("SELECT 1 FROM dedup_tasks WHERE id = ?").get(taskId)) return json({ error: "任务不存在" }, 404);
    const total = Number((db.query("SELECT COUNT(*) count FROM dedup_groups WHERE task_id = ?").get(taskId) as any).count);
    const items = db.query(`SELECT name, doc_count AS docCount FROM dedup_groups
      WHERE task_id = ? ORDER BY doc_count DESC, name ASC LIMIT ? OFFSET ?`)
      .all(taskId, pageSize, (page - 1) * pageSize);
    return json({ items, total, page, pageSize });
  }
  const detailMatch = url.pathname.match(/^\/api\/dedup\/tasks\/([^/]+)\/entities$/);
  if (request.method === "GET" && detailMatch) {
    const taskId = detailMatch[1]!;
    const name = url.searchParams.get("name");
    if (!name) return json({ error: "缺少重复名称" }, 400);
    const task = db.query("SELECT type, es_url, es_index FROM dedup_tasks WHERE id = ?").get(taskId) as Pick<TaskRow, "type" | "es_url" | "es_index"> | null;
    if (!task) return json({ error: "任务不存在" }, 404);
    const page = positive(url.searchParams.get("page"), 1, 1_000_000);
    const pageSize = positive(url.searchParams.get("pageSize"), 20, 100);
    const result = await es(task.es_url, task.es_index, "_search", {
      from: (page - 1) * pageSize, size: pageSize, track_total_hits: true,
      query: { bool: { filter: [{ term: { [config.typeField]: task.type } }, { term: { [config.nameField]: name } }] } },
      _source: ["id", "zhLabel", "type", "types", "category", "domain", "geneSource", "zhDesc"],
    });
    const items = (result.hits?.hits ?? []).map((hit: any) => ({ _id: hit._id, ...hit._source }));
    const total = typeof result.hits?.total === "number" ? result.hits.total : result.hits?.total?.value ?? 0;
    return json({ items, total, page, pageSize, name });
  }
  return json({ error: "接口不存在" }, 404);
}

const server = serve({
  hostname: "0.0.0.0",
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, url);
      const assets: Record<string, [string, string]> = {
        "/": ["public/index.html", "text/html; charset=utf-8"], "/dedup": ["public/index.html", "text/html; charset=utf-8"],
        "/app.css": ["public/app.css", "text/css; charset=utf-8"], "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
      };
      const asset = assets[url.pathname];
      return asset ? new Response(Bun.file(asset[0]), { headers: { "content-type": asset[1] } }) : new Response("Not found", { status: 404 });
    } catch (error) { return json({ error: error instanceof Error ? error.message : "服务器内部错误" }, error instanceof RequestError ? 400 : 500); }
  },
});
for (const row of db.query(`${taskSelect} WHERE status IN ('pending', 'running')`).all() as TaskRow[]) void runTask(row.id);
for (const row of db.query(`${taskSelect} WHERE processing_status = 'running'`).all() as TaskRow[]) void processTask(row.id);
console.log(`重复知识检测服务已启动: http://localhost:${server.port}`);
