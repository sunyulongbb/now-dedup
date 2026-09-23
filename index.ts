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

type TaskRow = {
  id: string; type: string; es_url: string; es_index: string; status: string; duplicate_group_count: number;
  duplicate_entity_count: number; scanned_name_count: number; after_key: string | null;
  error: string | null; created_at: string; finished_at: string | null;
};
const taskSelect = `SELECT id, type, es_url, es_index, status, duplicate_group_count, duplicate_entity_count,
  scanned_name_count, after_key, error, created_at, finished_at FROM dedup_tasks`;
const running = new Set<string>();
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
  };
}
async function es(esUrl: string, esIndex: string, path: string, body: unknown): Promise<any> {
  if (activeEsRequests >= config.esConcurrency) await new Promise<void>((resolve) => esWaiters.push(resolve));
  activeEsRequests++;
  const headers: Record<string, string> = { "content-type": "application/json" };
  try {
    if (config.esUsername) headers.authorization = `Basic ${btoa(`${config.esUsername}:${config.esPassword ?? ""}`)}`;
    const response = await fetch(`${esUrl}/${encodeURIComponent(esIndex)}/${path}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Elasticsearch ${response.status}: ${(await response.text()).slice(0, 1200)}`);
    return response.json();
  } finally {
    activeEsRequests--;
    esWaiters.shift()?.();
  }
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
console.log(`重复知识检测服务已启动: http://localhost:${server.port}`);
