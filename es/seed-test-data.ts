const esUrl = (Bun.env.ES_URL ?? "http://127.0.0.1:9200").replace(/\/$/, "");
const indexName = Bun.env.ES_INDEX ?? "entity";
const documentCount = 1000;
const batchSize = 250;
const types = ["人物", "机构", "地点", "事件", "产品"] as const;

function testDocument(sequence: number) {
  const typeIndex = (sequence - 1) % types.length;
  const group = Math.floor((sequence - 1) / 10) + 1;
  const type = types[typeIndex]!;
  return {
    id: `test-${String(sequence).padStart(4, "0")}`,
    zhLabel: `测试${type}${String(group).padStart(3, "0")}`,
    type,
    types: [type, "测试数据"],
    category: "自动生成",
    domain: `测试领域${(group % 4) + 1}`,
    geneSource: "seed-test-data.ts",
    zhDesc: `用于重复知识检测的第 ${sequence} 条测试实体。`,
  };
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${esUrl}/${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`Elasticsearch ${response.status}: ${await response.text()}`);
  return response.json();
}

for (let start = 1; start <= documentCount; start += batchSize) {
  const lines: string[] = [];
  const end = Math.min(start + batchSize - 1, documentCount);
  for (let sequence = start; sequence <= end; sequence++) {
    const document = testDocument(sequence);
    lines.push(JSON.stringify({ index: { _index: indexName, _id: document.id } }));
    lines.push(JSON.stringify(document));
  }

  const result = await request("_bulk?refresh=false", {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: `${lines.join("\n")}\n`,
  });
  if (result.errors) {
    const failures = result.items
      .filter((item: any) => item.index?.error)
      .slice(0, 5)
      .map((item: any) => item.index.error);
    throw new Error(`批量写入失败: ${JSON.stringify(failures)}`);
  }
  console.log(`已写入 ${end}/${documentCount} 条测试数据`);
}

await request(`${encodeURIComponent(indexName)}/_refresh`, { method: "POST", body: "" });
const count = await request(`${encodeURIComponent(indexName)}/_count`, { method: "POST", body: "{}" });
console.log(`完成：索引 ${indexName} 当前共有 ${count.count} 条文档。`);
