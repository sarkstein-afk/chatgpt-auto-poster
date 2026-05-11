// ====== Background Service Worker ======
// 双Tab编排 + 审核重试 + 队列持久化

const STORAGE_KEY = "taskProgress";
const DOWNLOAD_DIR = "chatgpt-posters";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_PASS_SCORE = 80;

let taskQueue = [];
let isRunning = false;
let completedCount = 0;
let errorCount = 0;
let taskResults = {};
let generatorTabId = null;
let reviewerTabId = null;

// ====== 持久化 ======
async function persistQueue() {
  const payload = {
    [STORAGE_KEY]: {
      total: taskQueue.length + completedCount + errorCount,
      completed: completedCount,
      errors: errorCount,
      current: taskQueue[0] || null,
      queue: taskQueue.slice(0, 50),
      queuePreview: taskQueue.slice(0, 30).map(t => ({
        id: t.id, outputName: t.outputName, retries: t._retries
      })),
      taskResults: taskResults,
      running: isRunning,
      lastUpdate: Date.now(),
    }
  };
  await chrome.storage.local.set(payload).catch(() => {});
}

// ====== SW 启动恢复 ======
async function restoreQueue() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY];
  if (saved && saved.queue && saved.queue.length > 0 && saved.running) {
    taskQueue = saved.queue;
    completedCount = saved.completed || 0;
    errorCount = saved.errors || 0;
    taskResults = saved.taskResults || {};
    isRunning = false;
    console.log(`Restored queue: ${taskQueue.length} tasks, auto-resuming`);
    startProcessing();
  }
}
restoreQueue();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ====== 消息路由 ======
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "enqueueTasks": {
      if (isRunning && taskQueue.length > 0) {
        sendResponse({ ok: false, error: "A queue is already running" });
        break;
      }
      // If there's a stale restored queue not running, warn and replace
      if (taskQueue.length > 0 && !isRunning) {
        console.log(`Replacing stale restored queue (${taskQueue.length} tasks)`);
      }
      const enableReview = msg.enableReview !== false;
      const maxRetries = enableReview ? (msg.maxRetries ?? DEFAULT_MAX_RETRIES) : 0;
      const passScore = msg.passScore ?? DEFAULT_PASS_SCORE;
      const reviewPromptTemplate = msg.reviewPromptTemplate || "";
      taskQueue = msg.tasks.map(t => ({
        ...t,
        _enableReview: enableReview,
        _maxRetries: maxRetries,
        _passScore: passScore,
        _retries: 0,
        _reviewTemplate: reviewPromptTemplate,
      }));
      completedCount = 0;
      errorCount = 0;
      taskResults = {};
      persistQueue();
      sendResponse({ ok: true, total: taskQueue.length });
      if (!isRunning) startProcessing();
      break;
    }

    case "getProgress": {
      sendResponse({
        total: taskQueue.length + completedCount + errorCount,
        completed: completedCount,
        errors: errorCount,
        running: isRunning,
        current: taskQueue[0] || null,
      });
      break;
    }

    case "clearQueue": {
      taskQueue = [];
      isRunning = false;
      completedCount = 0;
      errorCount = 0;
      taskResults = {};
      generatorTabId = null;
      reviewerTabId = null;
      persistQueue();
      sendResponse({ ok: true });
      break;
    }

    case "download": {
      chrome.downloads.download({
        url: msg.url,
        filename: DOWNLOAD_DIR + "/" + msg.filename,
        saveAs: false,
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, id: downloadId });
        }
      });
      return true;
    }
  }
});

// ====== 任务引擎 ======
async function startProcessing() {
  if (isRunning) return;
  isRunning = true;
  await persistQueue();

  while (taskQueue.length > 0) {
    const task = taskQueue[0];
    await persistQueue();

    generatorTabId = await ensureTab(generatorTabId, "generator");
    if (!generatorTabId) { markTaskFailed(task, "Cannot open ChatGPT tab"); continue; }

    let passed = false;
    let currentPrompt = task.prompt;
    const enableReview = task._enableReview !== false;
    const maxRetries = enableReview ? (task._maxRetries || DEFAULT_MAX_RETRIES) : 0;

    // --- Review/retry loop ---
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      task._retries = attempt;
      await persistQueue();

      console.log(`[${task.id}] Round ${attempt + 1}/${maxRetries + 1}${enableReview ? " (review)" : ""}`);

      // 1. Generate
      const genResult = await sendWithRetry(generatorTabId, {
        type: "generate",
        prompt: currentPrompt,
        outputName: task.outputName,
      }, 2);

      if (!genResult?.success) {
        task._error = genResult?.error || "Generation failed";
        console.log(`[${task.id}] FAIL: ${task._error}`);
        break;
      }

      const imageUrl = genResult.imageUrl;
      task._lastImageUrl = imageUrl;

      // 2. No review? Done
      if (!enableReview || !imageUrl) {
        passed = true;
        break;
      }

      // 3. Review
      reviewerTabId = await ensureTab(reviewerTabId, "reviewer");
      if (!reviewerTabId) {
        console.log(`[${task.id}] Reviewer tab unavailable, skipping review`);
        passed = true;
        break;
      }

      const reviewPrompt = buildReviewPrompt(task, currentPrompt);
      const reviewResult = await sendWithRetry(reviewerTabId, {
        type: "review",
        imageUrl: imageUrl,
        reviewPrompt: reviewPrompt,
      }, 2);

      if (!reviewResult?.success) {
        console.log(`[${task.id}] Review comm failed: ${reviewResult?.error}`);
        passed = true;
        break;
      }

      const score = reviewResult.score || 0;
      const threshold = task._passScore || DEFAULT_PASS_SCORE;
      task._lastScore = score;

      if (score >= threshold) {
        console.log(`[${task.id}] PASS (${score} >= ${threshold})`);
        passed = true;
        break;
      }

      const feedback = reviewResult.suggestions || reviewResult.feedback || "Improve quality";
      console.log(`[${task.id}] FAIL (${score} < ${threshold}): ${feedback.slice(0, 60)}`);

      if (attempt < maxRetries) {
        currentPrompt = revisePrompt(currentPrompt, feedback);
        task.outputName = task.outputName.replace(/\.png$/, `_r${attempt + 1}.png`);
      }
    }

    // --- Done with this task ---
    if (passed) {
      completedCount++;
      taskResults[task.id] = { status: "done", retries: task._retries, score: task._lastScore };
    } else {
      errorCount++;
      taskResults[task.id] = { status: "error", error: task._error || "Review failed", retries: task._retries, score: task._lastScore };
    }

    taskQueue.shift();
    await persistQueue();

    if (taskQueue.length > 0) await sleep(5000);
  }

  isRunning = false;
  await persistQueue();
  console.log("All tasks complete");
}

// ====== Review prompt builder ======
function buildReviewPrompt(task, generationPrompt) {
  const template = task._reviewTemplate;
  if (template) {
    return template
      .replace(/\{requirements\}/g, task._originalRequirements || generationPrompt)
      .replace(/\{prompt\}/g, generationPrompt);
  }

  return `You are a strict professional image reviewer. Rate this generated image.

[Original Requirements]
${task._originalRequirements || generationPrompt}

[Scoring Criteria - 100 points total]
1. Content accuracy (40pts): Does the image accurately match the requirements?
2. Style consistency (25pts): Does it match the requested style?
3. Quality (20pts): Sharpness, composition, overall polish?
4. Defects (15pts): Any visible AI artifacts (deformed limbs, garbled text, unnatural seams)?

Reply in JSON only:
{"score": <0-100 integer>, "feedback": "<one line>", "suggestions": "<specific changes for the AI to fix, if score < ${task._passScore || DEFAULT_PASS_SCORE}>"}`;
}

// ====== Prompt revision ======
function revisePrompt(originalPrompt, feedback) {
  return `${originalPrompt}

[CRITICAL REVISION]
The previous image was rejected. Fix these issues:
${feedback}

You MUST address all of the above problems.`;
}

// ====== Fail fast ======
function markTaskFailed(task, error) {
  errorCount++;
  taskResults[task.id] = { status: "error", error };
  task._error = error;
  taskQueue.shift();
  persistQueue();
}

// ====== Tab management ======
async function ensureTab(existingTabId, label) {
  if (existingTabId) {
    try { await chrome.tabs.get(existingTabId); return existingTabId; } catch {}
  }
  const [tab] = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  if (tab) {
    try { await chrome.tabs.get(tab.id); return tab.id; } catch {}
  }
  const newTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
  await waitForTabLoad(newTab.id);
  await sleep(3000);
  console.log(`New ${label} tab: ${newTab.id}`);
  return newTab.id;
}

// ====== Retry send ======
async function sendWithRetry(tabId, msg, maxRetries) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, msg);
      if (result) return result;
      console.log(`  No response ${i + 1}/${maxRetries}`);
    } catch (e) {
      console.log(`  Retry ${i + 1}/${maxRetries}: ${e.message}`);
    }
    if (i < maxRetries - 1) await sleep(3000);
  }
  return { success: false, error: "Communication timeout" };
}

// ====== Tab load waiter ======
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 15000);
    chrome.tabs.onUpdated.addListener(function listener(tid, info) {
      if (tid === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1000);
      }
    });
  });
}
