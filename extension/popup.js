import * as pdfjsLib from "./lib/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdf.worker.min.mjs";

// ====== DOM ======
const projectSelect = document.getElementById("projectSelect");
const btnNewProject = document.getElementById("btnNewProject");
const btnDelProject = document.getElementById("btnDelProject");
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
  name: "Default",
  globalInstruction: "",
  enableReview: true,
  passScore: 80,
  maxRetries: 2,
  reviewPromptTemplate: "",
};

// ====== Project management ======
async function loadProjects() {
  const data = await chrome.storage.local.get(["projects", "activeProject"]);
  projects = data.projects || { default: { ...DEFAULT_PROJECT } };
  if (!projects["default"]) projects["default"] = { ...DEFAULT_PROJECT };
  activeProject = data.activeProject || "default";
  if (!projects[activeProject]) activeProject = "default";

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
}

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

// ====== Project events ======
projectSelect.addEventListener("change", () => {
  saveActiveProject();
  activeProject = projectSelect.value;
  loadActiveProject();
  chrome.storage.local.set({ activeProject });
  // Reset parsed state
  imageRequests = [];
  resultSection.style.display = "none";
  btnStart.disabled = true;
  pdfFileInput.value = "";
  pdfStatusEl.innerHTML = "";
  updateProgress();
});

btnNewProject.addEventListener("click", () => {
  const name = prompt("Project name:");
  if (!name || !name.trim()) return;
  const id = name.trim().toLowerCase().replace(/\s+/g, "_");
  if (projects[id]) { alert("Project already exists"); return; }
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
  if (activeProject === "default") { alert("Cannot delete default project"); return; }
  if (!confirm(`Delete project "${projects[activeProject]?.name}"?`)) return;
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

// Auto-save on any setting change
[globalInstruction, enableReview, maxRetries, passScore, reviewPromptTemplate].forEach(el =>
  el.addEventListener("change", saveActiveProject)
);

// ====== ChatGPT connection check ======
async function checkChatGPT() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (tabs.length > 0) {
      const resp = await chrome.tabs.sendMessage(tabs[0].id, { type: "ping" });
      if (resp?.ok) {
        gptStatusEl.textContent = `Connected (${tabs.length} tabs)`;
        gptStatusEl.className = "status status-ok";
        return tabs[0].id;
      }
    }
    gptStatusEl.textContent = "Open chatgpt.com first";
    gptStatusEl.className = "status status-warn";
    return null;
  } catch {
    gptStatusEl.textContent = "Not connected";
    gptStatusEl.className = "status status-err";
    return null;
  }
}

// ====== PDF parsing ======
btnParse.addEventListener("click", async () => {
  const file = pdfFileInput.files[0];
  if (!file) {
    pdfStatusEl.innerHTML = "<span class='status status-err'>Select a PDF file</span>";
    return;
  }
  pdfStatusEl.innerHTML = "<span class='status status-warn'>Parsing...</span>";
  imageRequests = [];

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let globalIdx = 0;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join("");
      let searchFrom = 0;

      while (true) {
        // Support both [illustration: xxx] and 【插图：xxx】
        let startIdx = -1, prefixLen = 0, endChar = "";
        for (const [prefix, len] of [["[illustration:", 13], ["【插图：", 5], ["【插图:", 5]]) {
          const idx = pageText.indexOf(prefix, searchFrom);
          if (idx !== -1 && (startIdx === -1 || idx < startIdx)) {
            startIdx = idx; prefixLen = len;
            endChar = prefix[0] === "[" ? "]" : "】";
          }
        }
        if (startIdx === -1) break;

        const endIdx = pageText.indexOf(endChar, startIdx + prefixLen);
        let desc;
        if (endIdx === -1) {
          desc = pageText.slice(startIdx + prefixLen, startIdx + prefixLen + 100).trim();
          searchFrom = startIdx + prefixLen;
        } else {
          desc = pageText.slice(startIdx + prefixLen, endIdx).trim();
          searchFrom = endIdx + 1;
        }
        if (desc && desc.length > 2) {
          globalIdx++;
          imageRequests.push({ index: globalIdx, page: pageNum, description: desc });
        }
      }
    }

    if (imageRequests.length === 0) {
      pdfStatusEl.innerHTML = "<span class='status status-warn'>No [illustration: xxx] markers found in PDF</span>";
      resultSection.style.display = "none";
      btnStart.disabled = true;
      return;
    }

    pdfStatusEl.innerHTML = `<span class='status status-ok'>Parsed: ${pdf.numPages} pages, ${imageRequests.length} markers</span>`;
    resultSection.style.display = "block";
    btnStart.disabled = false;
    renderTaskList();
  } catch (e) {
    pdfStatusEl.innerHTML = `<span class='status status-err'>Parse error: ${e.message}</span>`;
  }
});

// ====== Rendering ======
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
  progressText.textContent = `${done + err}/${total} (${done} ok, ${err} fail)`;
}

function markTaskDone(idx, info = "") {
  imageRequests[idx]._done = true;
  const el = document.getElementById(`task-${idx}`);
  if (el) {
    el.classList.add("done");
    el.querySelector(".num").textContent = "OK";
    if (info) el.querySelector(".info").textContent += ` [${info}]`;
  }
  updateProgress();
}

function markTaskError(idx, msg) {
  imageRequests[idx]._error = msg;
  const el = document.getElementById(`task-${idx}`);
  if (el) {
    el.style.background = "#3a1a1a";
    el.querySelector(".num").textContent = "ERR";
    el.querySelector(".info").textContent += ` [${msg}]`;
  }
  updateProgress();
}

function markTaskRetrying(idx, attempt) {
  const el = document.getElementById(`task-${idx}`);
  if (el) {
    el.style.background = "#3a3a1a";
    el.querySelector(".num").textContent = "R" + attempt;
    el.querySelector(".info").textContent = el.querySelector(".info").textContent.replace(/ \[R\d+\]/, "") + ` [R${attempt}]`;
  }
}

// ====== Start ======
btnStart.addEventListener("click", async () => {
  if (imageRequests.length === 0) return;
  const tabId = await checkChatGPT();
  if (!tabId) { alert("Please open and login to chatgpt.com first"); return; }

  const instruction = globalInstruction.value.trim();
  if (!instruction) { alert("Please fill in the style prompt"); return; }

  // Reset progress
  imageRequests.forEach(r => { r._done = false; r._error = null; r._retries = 0; });
  updateProgress();
  renderTaskList();

  btnStart.disabled = true;
  btnStart.textContent = "Running...";
  btnParse.disabled = true;

  const useReview = enableReview.checked;
  const retries = parseInt(maxRetries.value) || 2;
  const threshold = parseInt(passScore.value) || 80;
  const reviewTmpl = reviewPromptTemplate.value.trim();

  const tasks = imageRequests.map((r) => ({
    id: `P${r.page}_${r.index}`,
    prompt: `${instruction}\n\nSpecific request: ${r.description}`,
    _originalRequirements: `${instruction}\n\nSpecific request: ${r.description}`,
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
    alert(enqueueResp?.error || "Failed to enqueue");
    btnStart.disabled = false;
    btnStart.textContent = "Start Auto Generate";
    btnParse.disabled = false;
    return;
  }

  progressText.textContent = `${tasks.length} tasks queued${useReview ? " (review mode)" : ""}`;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollProgress, 2000);
});

// ====== Progress polling ======
async function pollProgress() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "getProgress" });
    if (!resp) return;

    const { total, completed, errors, running, current } = resp;
    const done = completed + errors;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    progressBar.style.width = pct + "%";
    progressText.textContent = running
      ? `${done}/${total} (${completed} ok, ${errors} fail) - ${current?.id || ""}`
      : `${done}/${total} (${completed} ok, ${errors} fail)`;

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
      btnStart.textContent = "All Done";
      btnParse.disabled = false;
      progressText.textContent = `Complete! ${completed} ok, ${errors} fail`;
      setTimeout(() => { btnStart.disabled = false; btnStart.textContent = "Start Auto Generate"; }, 3000);
      updateTaskListFromStorage();
    }
  } catch {}
}

// ====== Final results ======
async function updateTaskListFromStorage() {
  const data = await chrome.storage.local.get("taskProgress");
  const results = data?.taskProgress?.taskResults || {};
  imageRequests.forEach((r, i) => {
    const taskId = `P${r.page}_${r.index}`;
    const result = results[taskId];
    if (result?.status === "error") {
      const extra = result.score ? ` ${result.score}pts` : "";
      markTaskError(i, (result.error || "Failed") + extra);
    } else if (result?.status === "done") {
      const scoreStr = result.score ? ` ${result.score}pts` : "";
      const retryStr = result.retries > 0 ? ` R${result.retries}` : "";
      markTaskDone(i, scoreStr + retryStr);
    }
  });
}

// ====== Init ======
loadProjects();
checkChatGPT();
setInterval(checkChatGPT, 5000);
