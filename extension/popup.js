let pdfjsLib = null;
const pdfjsReady = (async function init() {
  const mod = await import("./lib/pdf.min.mjs");
  pdfjsLib = mod;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdf.worker.min.mjs";
})();

// ====== DOM ======
const projectSelect = document.getElementById("projectSelect");
const btnNewProject = document.getElementById("btnNewProject");
const btnDelProject = document.getElementById("btnDelProject");
const btnSelectRoot = document.getElementById("btnSelectRoot");
const btnScanProjects = document.getElementById("btnScanProjects");
const rootPathEl = document.getElementById("rootPath");
const projectPathHint = document.getElementById("projectPathHint");
const pdfFileInput = document.getElementById("pdfFile");
const btnParse = document.getElementById("btnParse");
const btnStart = document.getElementById("btnStart");
const globalInstruction = document.getElementById("globalInstruction");
const enableReview = document.getElementById("enableReview");
const maxRetries = document.getElementById("maxRetries");
const passScore = document.getElementById("passScore");
const reviewPromptTemplate = document.getElementById("reviewPromptTemplate");
const taskListEl = document.getElementById("taskList");
const resultSection = document.getElementById("resultSection");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const gptStatusEl = document.getElementById("gptStatus");
const pdfStatusEl = document.getElementById("pdfStatus");

// ====== State ======
let imageRequests = [];
let pollTimer = null;
let projects = {};
let activeProject = "default";

const DEFAULT_PROJECT = {
  name: "默认项目",
  globalInstruction: "",
  enableReview: true,
  passScore: 80,
  maxRetries: 2,
  reviewPromptTemplate: "",
};

// ====== 项目管理 ======
async function loadProjects() {
  const data = await chrome.storage.local.get(["projects", "activeProject", "projectRootPath"]);
  projects = data.projects || { default: { ...DEFAULT_PROJECT } };
  if (!projects["default"]) projects["default"] = { ...DEFAULT_PROJECT };
  activeProject = data.activeProject || "default";
  if (!projects[activeProject]) activeProject = "default";

  // 恢复文件夹路径
  if (data.projectRootPath) {
    rootPathEl.textContent = data.projectRootPath;
    btnScanProjects.style.display = "";
    projectPathHint.textContent = `📁 ${data.projectRootPath}\\${activeProject}\\materials\\`;
  }

  renderProjectList();
  loadActiveProject();
}

function renderProjectList() {
  projectSelect.innerHTML = Object.entries(projects).map(([id, p]) =>
    `<option value="${id}" ${id === activeProject ? "selected" : ""}>${p.name || id}</option>`
  ).join("");
}

function loadActiveProject() {
  const p = projects[activeProject] || DEFAULT_PROJECT;
  globalInstruction.value = p.globalInstruction || "";
  enableReview.checked = p.enableReview !== false;
  passScore.value = p.passScore || 80;
  maxRetries.value = p.maxRetries || 2;
  reviewPromptTemplate.value = p.reviewPromptTemplate || "";
  updateProjectPathHint();
}

function updateProjectPathHint() {
  const rootPath = rootPathEl.textContent;
  if (rootPath && rootPath !== "未选择") {
    projectPathHint.textContent = `📁 ${rootPath}\\${activeProject}\\materials\\`;
  }
}

// ====== 文件夹选择（对接本地文件系统） ======
btnSelectRoot.addEventListener("click", async () => {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: "read" });
    const rootPath = dirHandle.name; // 只拿到文件夹名，拿不到完整路径

    // 扫描子目录
    const discoveredProjects = { default: { ...DEFAULT_PROJECT } };
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === "directory" && name !== "default") {
        discoveredProjects[name] = {
          name: name,
          globalInstruction: "",
          enableReview: true,
          passScore: 80,
          maxRetries: 2,
          reviewPromptTemplate: "",
        };
      }
    }

    // 合并到现有项目（不覆盖已有设置）
    for (const [id, cfg] of Object.entries(discoveredProjects)) {
      if (!projects[id]) projects[id] = cfg;
    }

    // 保存
    const displayPath = `projects 文件夹（${Object.keys(discoveredProjects).length - 1} 个子项目）`;
    await chrome.storage.local.set({ projects, projectRootPath: displayPath });

    rootPathEl.textContent = displayPath;
    btnScanProjects.style.display = "";
    projectPathHint.textContent = `📁 projects\\${activeProject}\\materials\\`;
    renderProjectList();

    pdfStatusEl.innerHTML = `<span class='status status-ok'>✅ 已对接，发现 ${Object.keys(discoveredProjects).length - 1} 个项目文件夹</span>`;
  } catch (e) {
    if (e.name !== "AbortError") {
      pdfStatusEl.innerHTML = `<span class='status status-err'>❌ ${e.message}</span>`;
    }
  }
});

// 重新扫描
btnScanProjects.addEventListener("click", async () => {
  btnSelectRoot.click();
});

function saveActiveProject() {
  projects[activeProject] = {
    ...projects[activeProject],
    name: projects[activeProject]?.name || activeProject,
    globalInstruction: globalInstruction.value,
    enableReview: enableReview.checked,
    passScore: parseInt(passScore.value) || 80,
    maxRetries: parseInt(maxRetries.value) || 2,
    reviewPromptTemplate: reviewPromptTemplate.value,
  };
  chrome.storage.local.set({ projects, activeProject });
}

// ====== 项目事件 ======
projectSelect.addEventListener("change", () => {
  saveActiveProject();
  activeProject = projectSelect.value;
  loadActiveProject();
  chrome.storage.local.set({ activeProject });
  updateProjectPathHint();
  imageRequests = [];
  resultSection.style.display = "none";
  btnStart.disabled = true;
  pdfFileInput.value = "";
  pdfStatusEl.innerHTML = "";
  updateProgress();
});

btnNewProject.addEventListener("click", () => {
  const name = prompt("请输入项目名称：");
  if (!name || !name.trim()) return;
  const id = name.trim().replace(/\s+/g, "_");
  if (projects[id]) { alert("项目已存在"); return; }
  saveActiveProject();
  projects[id] = { ...DEFAULT_PROJECT, name: name.trim() };
  activeProject = id;
  chrome.storage.local.set({ projects, activeProject });
  renderProjectList();
  loadActiveProject();
  imageRequests = [];
  resultSection.style.display = "none";
  btnStart.disabled = true;
  pdfFileInput.value = "";
  pdfStatusEl.innerHTML = "";
  updateProgress();
});

btnDelProject.addEventListener("click", () => {
  if (activeProject === "default") { alert("不能删除默认项目"); return; }
  if (!confirm(`确定删除项目「${projects[activeProject]?.name}」？`)) return;
  delete projects[activeProject];
  activeProject = "default";
  chrome.storage.local.set({ projects, activeProject });
  renderProjectList();
  loadActiveProject();
  imageRequests = [];
  resultSection.style.display = "none";
  btnStart.disabled = true;
  pdfFileInput.value = "";
  pdfStatusEl.innerHTML = "";
  updateProgress();
});

// 设置变更自动保存
[globalInstruction, enableReview, maxRetries, passScore, reviewPromptTemplate].forEach(el =>
  el.addEventListener("change", saveActiveProject)
);

// ====== ChatGPT 连接检查 ======
async function checkChatGPT() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (tabs.length > 0) {
      const resp = await chrome.tabs.sendMessage(tabs[0].id, { type: "ping" });
      if (resp?.ok) {
        gptStatusEl.textContent = `✅ 已连接 (${tabs.length}个标签页)`;
        gptStatusEl.className = "status status-ok";
        return tabs[0].id;
      }
    }
    gptStatusEl.textContent = "⚠ 请先打开 chatgpt.com 并登录";
    gptStatusEl.className = "status status-warn";
    return null;
  } catch {
    gptStatusEl.textContent = "❌ 未连接";
    gptStatusEl.className = "status status-err";
    return null;
  }
}

// ====== 提取标记文本 ======
function extractMarkers(pageText, pageNum, startIdx) {
  const results = [];
  let searchFrom = startIdx || 0;

  while (true) {
    let matchIdx = -1, prefixLen = 0, endChar = "";
    for (const [prefix, len] of [["[illustration:", 13], ["【插图：", 5], ["【插图:", 5]]) {
      const idx = pageText.indexOf(prefix, searchFrom);
      if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
        matchIdx = idx; prefixLen = len;
        endChar = prefix[0] === "[" ? "]" : "】";
      }
    }
    if (matchIdx === -1) break;

    const endIdx = pageText.indexOf(endChar, matchIdx + prefixLen);
    let desc;
    if (endIdx === -1) {
      desc = pageText.slice(matchIdx + prefixLen, matchIdx + prefixLen + 100).trim();
      searchFrom = matchIdx + prefixLen;
    } else {
      desc = pageText.slice(matchIdx + prefixLen, endIdx).trim();
      searchFrom = endIdx + 1;
    }
    if (desc && desc.length > 2) {
      results.push({ page: pageNum, description: desc });
    }
  }
  return results;
}

// ====== PDF 解析 ======
async function parsePDF(file) {
  await pdfjsReady;
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const markers = [];
  const pageTexts = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join("");
    markers.push(...extractMarkers(pageText, pageNum));
    pageTexts.push({ page: pageNum, text: pageText.slice(0, 300) });
  }

  return { markers, extra: `${pdf.numPages} 页`, pageTexts };
}

// ====== PPTX 解析 ======
async function parsePPTX(file) {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const markers = [];

  // 获取所有 slide 文件，排序
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)[1]);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)[1]);
      return na - nb;
    });

  let slideNum = 0;
  const pageTexts = [];
  for (const slidePath of slideFiles) {
    slideNum++;
    const xmlText = await zip.files[slidePath].async("string");
    const texts = [];
    const regex = /<a:t[^>]*>([^<]*)<\/a:t>/g;
    let match;
    while ((match = regex.exec(xmlText)) !== null) {
      if (match[1]) texts.push(match[1]);
    }
    const slideText = texts.join("");
    markers.push(...extractMarkers(slideText, slideNum));
    pageTexts.push({ page: slideNum, text: slideText.slice(0, 300) });
  }

  return { markers, extra: `${slideNum} 张幻灯片`, pageTexts };
}

// ====== DOCX 解析 ======
async function parseDOCX(file) {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const xmlText = await zip.files["word/document.xml"].async("string");
  const texts = [];
  const regex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let match;
  while ((match = regex.exec(xmlText)) !== null) {
    if (match[1]) texts.push(match[1]);
  }
  const fullText = texts.join("");
  const markers = extractMarkers(fullText, 1);
  const pageTexts = [{ page: 1, text: fullText.slice(0, 500) }];
  return { markers, extra: `1 个文档`, pageTexts };
}

// ====== XLSX 解析 ======
async function parseXLSX(file) {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 先读共享字符串表
  let sharedStrings = [];
  if (zip.files["xl/sharedStrings.xml"]) {
    const ssXml = await zip.files["xl/sharedStrings.xml"].async("string");
    const regex = /<si[^>]*>[\s\S]*?<t[^>]*>([^<]*)<\/t>[\s\S]*?<\/si>/g;
    let match;
    while ((match = regex.exec(ssXml)) !== null) {
      sharedStrings.push(match[1]);
    }
    // 简化版：直接提取所有 <t> 标签
    if (sharedStrings.length === 0) {
      const tRegex = /<t[^>]*>([^<]+)<\/t>/g;
      let tm;
      while ((tm = tRegex.exec(ssXml)) !== null) {
        sharedStrings.push(tm[1]);
      }
    }
  }

  // 读取所有 sheet
  const sheetFiles = Object.keys(zip.files)
    .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();

  let allTexts = [];
  for (const sheetPath of sheetFiles) {
    const sheetXml = await zip.files[sheetPath].async("string");
    // 提取共享字符串引用
    const cellRegex = /<c[^>]*t="s"[^>]*>[\s\S]*?<v>(\d+)<\/v>[\s\S]*?<\/c>/g;
    let cm;
    while ((cm = cellRegex.exec(sheetXml)) !== null) {
      const idx = parseInt(cm[1]);
      if (sharedStrings[idx]) allTexts.push(sharedStrings[idx]);
    }
    // 也提取内联字符串
    const inlineRegex = /<t[^>]*>([^<]+)<\/t>/g;
    let im;
    while ((im = inlineRegex.exec(sheetXml)) !== null) {
      if (im[1] && isNaN(im[1])) allTexts.push(im[1]);
    }
  }

  const fullText = allTexts.join(" ");
  const markers = extractMarkers(fullText, 1);
  const pageTexts = [{ page: 1, text: fullText.slice(0, 500) }];
  return { markers, extra: `${sheetFiles.length} 个工作表`, pageTexts };
}

// ====== TXT 解析 ======
async function parseTXT(file) {
  const text = await file.text();
  const markers = extractMarkers(text, 1);
  const pageTexts = [{ page: 1, text: text.slice(0, 500) }];
  return { markers, extra: `${text.length} 字符`, pageTexts };
}

// ====== 统一解析入口 ======
async function parseFile() {
  const file = pdfFileInput.files[0];
  if (!file) {
    pdfStatusEl.innerHTML = "<span class='status status-err'>请先选择文件</span>";
    return;
  }

  pdfStatusEl.innerHTML = "<span class='status status-warn'>⏳ 解析中...</span>";
  imageRequests = [];

  try {
    const ext = file.name.split(".").pop().toLowerCase();
    let result;

    if (ext === "pdf") {
      result = await parsePDF(file);
    } else if (ext === "pptx") {
      result = await parsePPTX(file);
    } else if (ext === "ppt") {
      pdfStatusEl.innerHTML = "<span class='status status-warn'>⚠ 旧版 .ppt 不支持，请另存为 .pptx</span>";
      return;
    } else if (ext === "docx") {
      result = await parseDOCX(file);
    } else if (ext === "doc") {
      pdfStatusEl.innerHTML = "<span class='status status-warn'>⚠ 旧版 .doc 不支持，请另存为 .docx</span>";
      return;
    } else if (ext === "xlsx") {
      result = await parseXLSX(file);
    } else if (ext === "xls") {
      pdfStatusEl.innerHTML = "<span class='status status-warn'>⚠ 旧版 .xls 不支持，请另存为 .xlsx</span>";
      return;
    } else if (ext === "txt" || ext === "md" || ext === "csv") {
      result = await parseTXT(file);
    } else {
      pdfStatusEl.innerHTML = "<span class='status status-err'>不支持的格式，支持：PDF / PPTX / DOCX / XLSX / TXT</span>";
      return;
    }

    const { markers, extra, pageTexts } = result;

    if (markers.length === 0) {
      // 无标记 → 自动整页生成
      if (!pageTexts || pageTexts.length === 0) {
        pdfStatusEl.innerHTML = `<span class='status status-warn'>⚠ 未找到任何内容（${extra}）</span>`;
        resultSection.style.display = "none";
        btnStart.disabled = true;
        return;
      }
      imageRequests = pageTexts.map((pt, i) => ({
        index: i + 1,
        page: pt.page,
        description: `根据这一页的内容生成配图。页面文字：${pt.text || "（无文字内容，请根据上下文生成合适的插图）"}`,
        _autoGenerated: true,
      }));
      pdfStatusEl.innerHTML = `<span class='status status-ok'>✅ 自动整页模式：${extra}，每页/每张幻灯片生成 1 张图（共 ${imageRequests.length} 张）</span>`;
    } else {
      // 有标记 → 用标记
      imageRequests = markers.map((m, i) => ({
        index: i + 1,
        page: m.page,
        description: m.description,
      }));
      pdfStatusEl.innerHTML = `<span class='status status-ok'>✅ 标记模式：${extra}，找到 ${imageRequests.length} 个【插图：xxx】标记</span>`;
    }
    resultSection.style.display = "block";
    btnStart.disabled = false;
    renderTaskList();
  } catch (e) {
    pdfStatusEl.innerHTML = `<span class='status status-err'>❌ 解析失败: ${e.message}</span>`;
  }
}

// 自动解析（选文件即解析）
pdfFileInput.addEventListener("change", parseFile);
btnParse.addEventListener("click", parseFile);

// ====== 任务列表渲染 ======
function renderTaskList() {
  taskListEl.innerHTML = imageRequests.map((r, i) => `
    <div class="task-item" id="task-${i}">
      <span class="num">${r.index}</span>
      <span class="info">P${r.page} - ${r.description.slice(0, 55)}</span>
    </div>
  `).join("");
  updateProgress();
}

function updateProgress() {
  const done = imageRequests.filter(r => r._done).length;
  const err = imageRequests.filter(r => r._error).length;
  const total = imageRequests.length;
  const pct = total > 0 ? Math.round(((done + err) / total) * 100) : 0;
  progressBar.style.width = pct + "%";
  progressText.textContent = `${done + err}/${total}（${done}✅ ${err}❌）`;
}

function markTaskDone(idx, info = "") {
  imageRequests[idx]._done = true;
  const el = document.getElementById(`task-${idx}`);
  if (el) {
    el.classList.add("done");
    el.querySelector(".num").textContent = "✅";
    if (info) el.querySelector(".info").textContent += ` [${info}]`;
  }
  updateProgress();
}

function markTaskError(idx, msg) {
  imageRequests[idx]._error = msg;
  const el = document.getElementById(`task-${idx}`);
  if (el) {
    el.style.background = "#3a1a1a";
    el.querySelector(".num").textContent = "❌";
    el.querySelector(".info").textContent += ` [${msg}]`;
  }
  updateProgress();
}

function markTaskRetrying(idx, attempt) {
  const el = document.getElementById(`task-${idx}`);
  if (el) {
    el.style.background = "#3a3a1a";
    el.querySelector(".num").textContent = "🔄";
    el.querySelector(".info").textContent = el.querySelector(".info").textContent.replace(/ \[重试\d+\]/, "") + ` [重试${attempt}]`;
  }
}

// ====== 开始生成 ======
btnStart.addEventListener("click", async () => {
  if (imageRequests.length === 0) return;
  const tabId = await checkChatGPT();
  if (!tabId) { alert("请先在浏览器打开 https://chatgpt.com 并登录"); return; }

  const instruction = globalInstruction.value.trim();
  if (!instruction) { alert("请先填写提示词 / 风格要求"); return; }

  imageRequests.forEach(r => { r._done = false; r._error = null; r._retries = 0; });
  updateProgress();
  renderTaskList();

  btnStart.disabled = true;
  btnStart.textContent = "⏳ 后台运行中...";
  btnParse.disabled = true;

  const useReview = enableReview.checked;
  const retries = parseInt(maxRetries.value) || 2;
  const threshold = parseInt(passScore.value) || 80;
  const reviewTmpl = reviewPromptTemplate.value.trim();

  const tasks = imageRequests.map((r) => ({
    id: `P${r.page}_${r.index}`,
    prompt: `${instruction}\n\n具体需求：${r.description}\n\n重要规则：画面中的文字必须清晰可读，不能出现乱码、扭曲、拼写错误或无法辨认的字符。`,
    _originalRequirements: `${instruction}\n\n具体需求：${r.description}`,
    outputName: `P${r.page}_${r.index}_${r.description.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}.png`,
    page: r.page,
    index: r.index,
  }));

  const enqueueResp = await chrome.runtime.sendMessage({
    type: "enqueueTasks",
    tasks,
    enableReview: useReview,
    maxRetries: retries,
    passScore: threshold,
    reviewPromptTemplate: useReview ? reviewTmpl : "",
  });

  if (!enqueueResp?.ok) {
    alert(enqueueResp?.error || "入队失败");
    btnStart.disabled = false;
    btnStart.textContent = "▶ 开始自动生成";
    btnParse.disabled = false;
    return;
  }

  progressText.textContent = `${tasks.length} 个任务已入队${useReview ? "（审核模式）" : ""}`;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollProgress, 2000);
});

// ====== 轮询进度 ======
async function pollProgress() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "getProgress" });
    if (!resp) return;

    const { total, completed, errors, running, current } = resp;
    const done = completed + errors;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    progressBar.style.width = pct + "%";
    progressText.textContent = running
      ? `⏳ ${done}/${total}（${completed}✅ ${errors}❌）- ${current?.id || ""}`
      : `${done}/${total}（${completed}✅ ${errors}❌）`;

    if (current) {
      const idx = imageRequests.findIndex(r => r.page === current.page && r.index === current.index);
      if (idx >= 0) {
        if (current._retries > 0) markTaskRetrying(idx, current._retries);
        const el = document.getElementById(`task-${idx}`);
        if (el) el.style.background = current._retries > 0 ? "#3a3a1a" : "#e9456044";
      }
    }

    if (!running && done >= total && total > 0) {
      clearInterval(pollTimer);
      pollTimer = null;
      btnStart.textContent = "✅ 全部完成";
      btnParse.disabled = false;
      progressText.textContent = `完成！${completed}✅ ${errors}❌`;
      setTimeout(() => { btnStart.disabled = false; btnStart.textContent = "▶ 开始自动生成"; }, 3000);
      updateTaskListFromStorage();
    }
  } catch {}
}

// ====== 从 storage 读取最终结果 ======
async function updateTaskListFromStorage() {
  const data = await chrome.storage.local.get("taskProgress");
  const results = data?.taskProgress?.taskResults || {};
  imageRequests.forEach((r, i) => {
    const taskId = `P${r.page}_${r.index}`;
    const result = results[taskId];
    if (result?.status === "error") {
      markTaskError(i, (result.error || "失败") + (result.score ? ` ${result.score}分` : ""));
    } else if (result?.status === "done") {
      const info = (result.score ? `${result.score}分` : "") + (result.retries > 0 ? ` 重试${result.retries}次` : "");
      markTaskDone(i, info);
    }
  });
}

// ====== 初始化 ======
loadProjects();
checkChatGPT();
setInterval(checkChatGPT, 5000);
