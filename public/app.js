const $ = (id) => document.getElementById(id);
const state = { taskId: localStorage.getItem("dedupTaskId"), task: null, types: [], filteredTypes: [], page: 1, pageSize: 20, total: 0, detailName: "", detailPage: 1, detailTotal: 0, reportRecords: [], reportTaskId: "", reportPage: 1, reportTotal: 0, poll: null };
const fmt = (n) => new Intl.NumberFormat("zh-CN").format(n || 0);
const text = (value) => value === undefined || value === null || value === "" ? "—" : Array.isArray(value) ? value.join("、") : String(value);
async function request(url, options) { const r = await fetch(url, options); const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || "请求失败"); return data; }
function notice(message, kind = "error") {
  $("message").querySelector("span").textContent = message;
  $("message").classList.toggle("hidden", !message);
  $("message").classList.toggle("success", kind === "success");
}
function setButtonLabel(id, label) { $(id).querySelector("span").textContent = label; }
function connection(connected) {
  $("connectionState").classList.toggle("connected", connected);
  $("connectionState").lastChild.textContent = connected ? " 已连接" : " 等待连接";
}
async function loadTypes() {
  const esUrl = $("esUrl").value.trim(); const esIndex = $("esIndex").value.trim();
  if (!esUrl || !esIndex) { notice("请填写 Elasticsearch 地址和索引"); return; }
  notice(""); connection(false); closeTypeDropdown(); $("connect").disabled = true; setButtonLabel("connect", "正在连接…"); $("typeTrigger").disabled = true; $("type").value = ""; $("start").disabled = true;
  try {
    const data = await request(`/api/dedup/types?esUrl=${encodeURIComponent(esUrl)}&esIndex=${encodeURIComponent(esIndex)}`);
    state.types = data.items; $("typeSearch").value = ""; $("typeTrigger").disabled = !data.items.length; selectType(data.items[0] ?? null); connection(true);
    localStorage.setItem("dedupEsUrl", esUrl); localStorage.setItem("dedupEsIndex", esIndex);
  } catch (e) { state.types = []; $("typeValue").textContent = "加载失败"; notice(`无法读取知识类型：${e.message}`); }
  finally { $("connect").disabled = false; setButtonLabel("connect", "连接并加载类型"); }
}
function renderTypes() {
  const query = $("typeSearch").value.trim().toLocaleLowerCase("zh-CN");
  state.filteredTypes = state.types.filter((item) => item.type.toLocaleLowerCase("zh-CN").includes(query));
  $("typeOptions").innerHTML = state.filteredTypes.length ? state.filteredTypes.map((item, index) => `<button type="button" class="type-option${item.type === $("type").value ? " active" : ""}" role="option" aria-selected="${item.type === $("type").value}" data-type-index="${index}"><span>${escapeHtml(item.type)}</span><span>${fmt(item.count)} 条</span></button>`).join("") : '<div class="type-empty">未找到匹配的知识类型</div>';
}
function selectType(item) {
  $("type").value = item?.type ?? ""; $("typeValue").textContent = item?.type ?? "暂无类型";
  $("typeCount").textContent = item ? `该类型共 ${fmt(item.count)} 条知识` : "暂无可选知识类型";
  $("start").disabled = !item; closeTypeDropdown();
}
function openTypeDropdown() {
  if ($("typeTrigger").disabled) return;
  $("typeDropdown").classList.remove("hidden"); $("typeTrigger").setAttribute("aria-expanded", "true");
  $("typeSearch").value = ""; renderTypes(); requestAnimationFrame(() => $("typeSearch").focus());
}
function closeTypeDropdown() {
  $("typeDropdown").classList.add("hidden"); $("typeTrigger").setAttribute("aria-expanded", "false");
}
async function start() {
  notice(""); $("start").disabled = true; setButtonLabel("start", "正在创建任务…");
  try {
    const task = await request("/api/dedup/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: $("type").value, esUrl: $("esUrl").value.trim(), esIndex: $("esIndex").value.trim() }) });
    state.taskId = task.taskId; state.page = 1; localStorage.setItem("dedupTaskId", state.taskId); $("results").classList.add("hidden"); await poll();
  } catch (e) { notice(e.message); } finally { $("start").disabled = false; setButtonLabel("start", "开始检测"); }
}
async function poll() {
  if (!state.taskId) return;
  clearTimeout(state.poll);
  try {
    const task = await request(`/api/dedup/tasks/${state.taskId}`); state.task = task;
    $("status").classList.remove("hidden", "failed", "completed"); $("status").classList.add(task.status);
    const labels = { pending: "等待检测", running: "正在检测", completed: "检测完成", failed: "检测失败" };
    $("statusText").textContent = labels[task.status] || task.status; $("taskType").textContent = `索引：${task.esIndex} · 类型：${task.type}`;
    $("scanned").textContent = fmt(task.scannedNameCount); $("groupCount").textContent = fmt(task.duplicateGroupCount); $("entityCount").textContent = fmt(task.duplicateEntityCount);
    renderProcessing(task);
    if (task.status === "failed") notice(task.error || "检测任务失败");
    if (task.status === "running" || task.status === "pending" || task.processing?.status === "running") state.poll = setTimeout(poll, 1500);
    await loadGroups();
  } catch (e) { notice(e.message); }
}
function renderProcessing(task) {
  const visible = task.status === "completed" && task.duplicateGroupCount > 0;
  $("processPanel").classList.toggle("hidden", !visible);
  if (!visible) return;
  const process = task.processing ?? {};
  const running = process.status === "running"; const done = process.status === "completed";
  $("processPanel").classList.toggle("processing", running); $("processPanel").classList.toggle("done", done);
  $("process").disabled = running || done; setButtonLabel("process", running ? "正在安全处理…" : done ? "处理已完成" : process.status === "failed" ? "重试处理" : "开始安全处理");
  $("processHint").textContent = process.status === "failed" ? `处理失败：${process.error}` : done ? "选举和迁移已安全完成" : running ? "请勿关闭服务，处理中断后可继续" : "此操作会改变原索引，请确认后执行";
  const showResult = Boolean(process.backupIndex || running || done || process.status === "failed");
  $("processResult").classList.toggle("hidden", !showResult);
  $("backupIndex").textContent = process.backupIndex || "正在创建…"; $("processedGroups").textContent = fmt(process.processedGroupCount);
  $("keptEntities").textContent = fmt(process.keptEntityCount); $("movedEntities").textContent = fmt(process.movedEntityCount);
}
async function processDuplicates() {
  if (!state.task || !confirm(`即将处理索引“${state.task.esIndex}”中的重复知识。\n\n系统会先创建备份索引；备份写入成功后，选举失败的知识将从原索引移除。是否继续？`)) return;
  notice(""); $("process").disabled = true; setButtonLabel("process", "正在启动…");
  try { await request(`/api/dedup/tasks/${state.taskId}/process`, { method: "POST" }); await poll(); }
  catch (e) { notice(e.message); $("process").disabled = false; setButtonLabel("process", "重试处理"); }
}
function reportDate(value) {
  if (!value) return "处理中";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
async function openReports() {
  $("reportMask").classList.remove("hidden"); $("reportModal").classList.remove("hidden");
  $("reportEmpty").classList.remove("hidden"); $("reportEmpty").textContent = "正在加载处理记录…"; $("reportView").classList.add("hidden");
  try {
    const data = await request("/api/dedup/process-records"); state.reportRecords = data.items; $("recordCount").textContent = fmt(data.items.length);
    $("recordList").innerHTML = data.items.map((item, index) => `<button class="record-item" data-record-index="${index}"><strong>${escapeHtml(item.type)}</strong><span>${escapeHtml(item.esIndex)} · ${fmt(item.processing.movedEntityCount)} 条已迁移</span><small>${reportDate(item.processing.processedAt ?? item.createdAt)}</small></button>`).join("") || '<div class="type-empty">暂无处理记录</div>';
    if (!data.items.length) { $("reportEmpty").textContent = "暂无处理记录"; return; }
    const initial = data.items.find((item) => item.taskId === state.taskId) ?? data.items[0]; await loadReport(initial.taskId, 1);
  } catch (e) { $("reportEmpty").textContent = `处理记录加载失败：${e.message}`; }
}
async function loadReport(taskId, page = 1) {
  state.reportTaskId = taskId; state.reportPage = page;
  const data = await request(`/api/dedup/tasks/${taskId}/report?page=${page}&pageSize=12`); const process = data.task.processing;
  state.reportTotal = data.total; $("reportEmpty").classList.add("hidden"); $("reportView").classList.remove("hidden");
  for (const item of $("recordList").querySelectorAll(".record-item")) item.classList.toggle("active", state.reportRecords[Number(item.dataset.recordIndex)]?.taskId === taskId);
  const statusLabels = { completed: "处理完成", running: "处理中", failed: "处理失败" };
  $("reportStatus").textContent = statusLabels[process.status] || "等待处理"; $("reportTaskType").textContent = `${data.task.type} · 重复知识处理`;
  $("reportIndex").textContent = `源索引：${data.task.esIndex}`; $("reportTime").textContent = reportDate(process.processedAt ?? data.task.createdAt);
  $("reportGroups").textContent = fmt(process.processedGroupCount); $("reportKept").textContent = fmt(process.keptEntityCount); $("reportMoved").textContent = fmt(process.movedEntityCount); $("reportBackup").textContent = process.backupIndex || "—";
  const outcomeTotal = process.keptEntityCount + process.movedEntityCount; const keptRate = outcomeTotal ? process.keptEntityCount / outcomeTotal * 100 : 0;
  $("reportRate").textContent = `${keptRate.toFixed(1)}% 保留`; $("keptBar").style.width = `${keptRate}%`; $("movedBar").style.width = `${100 - keptRate}%`;
  $("keptLegend").textContent = fmt(process.keptEntityCount); $("movedLegend").textContent = fmt(process.movedEntityCount); $("reportGroupTotal").textContent = `共 ${fmt(data.total)} 组`;
  $("reportGroupsList").innerHTML = data.groups.map((group) => {
    const decisions = [
      ...group.details.wikidata.map((item) => `<span class="decision wikidata">Wikidata 保留 · ${escapeHtml(item.id)}</span>`),
      ...group.details.elected.map((item) => `<span class="decision">选举保留 · ${escapeHtml(item.id)} · ${fmt(item.sourceBytes)} B</span>`),
      ...group.details.moved.map((item) => `<span class="decision removed">迁移 · ${escapeHtml(item.id)} · ${fmt(item.sourceBytes)} B</span>`),
    ].join("") || '<span class="decision">历史记录无明细</span>';
    return `<article class="report-group"><strong>${escapeHtml(group.name)}</strong><div class="report-counts">保留 ${fmt(group.keptCount)}<span class="moved-text">迁移 ${fmt(group.movedCount)}</span></div><div class="report-decisions">${decisions}</div></article>`;
  }).join("") || '<div class="type-empty">暂无分组处理明细</div>';
  const pages = Math.max(1, Math.ceil(data.total / 12)); $("reportPageInfo").textContent = `${page} / ${pages}`; $("reportPrev").disabled = page <= 1; $("reportNext").disabled = page >= pages;
}
function closeReports() { $("reportMask").classList.add("hidden"); $("reportModal").classList.add("hidden"); }
async function loadGroups() {
  if (!state.taskId) return;
  const data = await request(`/api/dedup/tasks/${state.taskId}/groups?page=${state.page}&pageSize=${state.pageSize}`);
  state.total = data.total; const pages = Math.max(1, Math.ceil(data.total / state.pageSize));
  if (state.page > pages) { state.page = pages; return loadGroups(); }
  $("results").classList.remove("hidden"); $("total").textContent = `共 ${fmt(data.total)} 组`;
  $("groups").innerHTML = data.items.map((x) => `<tr><td>${escapeHtml(x.name)}</td><td>${fmt(x.docCount)}</td><td><button class="link" data-name="${escapeHtml(x.name)}">查看</button></td></tr>`).join("");
  $("empty").classList.toggle("hidden", data.items.length > 0); $("pageInfo").textContent = `${state.page} / ${pages}`; $("prev").disabled = state.page <= 1; $("next").disabled = state.page >= pages;
}
async function openDetail(name) { state.detailName = name; state.detailPage = 1; $("detailName").textContent = name; $("drawerMask").classList.remove("hidden"); $("drawer").classList.add("open"); $("drawer").setAttribute("aria-hidden", "false"); await loadDetail(); }
async function loadDetail() {
  $("detailList").innerHTML = '<div class="empty">正在加载…</div>';
  try {
    const data = await request(`/api/dedup/tasks/${state.taskId}/entities?name=${encodeURIComponent(state.detailName)}&page=${state.detailPage}&pageSize=20`); state.detailTotal = data.total;
    const pages = Math.max(1, Math.ceil(data.total / 20)); $("detailTotal").textContent = `共 ${fmt(data.total)} 条知识`;
    $("detailList").innerHTML = data.items.map((x) => `<article class="detail"><div class="detail-title"><span>${escapeHtml(text(x.zhLabel))}</span><span class="badge">${escapeHtml(text(x.type ?? x.types))}</span></div><div class="meta"><span>ID：${escapeHtml(text(x.id ?? x._id))}</span><span>分类：${escapeHtml(text(x.category))}</span><span>领域：${escapeHtml(text(x.domain))}</span><span>来源：${escapeHtml(text(x.geneSource))}</span></div><p class="desc">${escapeHtml(text(x.zhDesc))}</p></article>`).join("") || '<div class="empty">暂无详情</div>';
    $("detailPageInfo").textContent = `${state.detailPage} / ${pages}`; $("detailPrev").disabled = state.detailPage <= 1; $("detailNext").disabled = state.detailPage >= pages;
  } catch (e) { $("detailList").innerHTML = `<div class="message">${escapeHtml(e.message)}</div>`; }
}
function closeDetail() { $("drawerMask").classList.add("hidden"); $("drawer").classList.remove("open"); $("drawer").setAttribute("aria-hidden", "true"); }
function escapeHtml(value) { const d = document.createElement("div"); d.textContent = String(value); return d.innerHTML; }
$("start").addEventListener("click", start);
$("process").addEventListener("click", processDuplicates);
$("history").addEventListener("click", openReports); $("reportClose").addEventListener("click", closeReports); $("reportMask").addEventListener("click", closeReports);
$("recordList").addEventListener("click", (event) => { const item = event.target.closest("[data-record-index]"); if (item) loadReport(state.reportRecords[Number(item.dataset.recordIndex)].taskId, 1); });
$("reportPrev").addEventListener("click", () => loadReport(state.reportTaskId, state.reportPage - 1)); $("reportNext").addEventListener("click", () => loadReport(state.reportTaskId, state.reportPage + 1));
$("typeTrigger").addEventListener("click", () => $("typeDropdown").classList.contains("hidden") ? openTypeDropdown() : closeTypeDropdown());
$("typeSearch").addEventListener("input", renderTypes);
$("typeOptions").addEventListener("click", (event) => { const option = event.target.closest("[data-type-index]"); if (option) selectType(state.filteredTypes[Number(option.dataset.typeIndex)]); });
$("connect").addEventListener("click", loadTypes);
for (const id of ["esUrl", "esIndex"]) $(id).addEventListener("input", () => { connection(false); closeTypeDropdown(); $("typeTrigger").disabled = true; $("type").value = ""; $("start").disabled = true; $("typeCount").textContent = "配置已变化，请重新连接"; });
$("prev").addEventListener("click", () => { state.page--; loadGroups(); }); $("next").addEventListener("click", () => { state.page++; loadGroups(); });
$("groups").addEventListener("click", (e) => { const button = e.target.closest("[data-name]"); if (button) openDetail(button.dataset.name); });
$("close").addEventListener("click", closeDetail); $("drawerMask").addEventListener("click", closeDetail);
document.addEventListener("click", (event) => { if (!$("typeCombobox").contains(event.target)) closeTypeDropdown(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!$("reportModal").classList.contains("hidden")) closeReports(); else if (!$("typeDropdown").classList.contains("hidden")) { closeTypeDropdown(); $("typeTrigger").focus(); } else if ($("drawer").classList.contains("open")) closeDetail(); } });
$("detailPrev").addEventListener("click", () => { state.detailPage--; loadDetail(); }); $("detailNext").addEventListener("click", () => { state.detailPage++; loadDetail(); });
async function init() {
  try {
    const defaults = await request("/api/dedup/config");
    $("esUrl").value = localStorage.getItem("dedupEsUrl") || defaults.esUrl;
    $("esIndex").value = localStorage.getItem("dedupEsIndex") || defaults.esIndex;
    await loadTypes();
  } catch (e) { notice(`读取配置失败：${e.message}`); }
  poll();
}
init();
