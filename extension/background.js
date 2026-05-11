// ====== Background Service Worker ======
// Task queue + review + persistence

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
let reviewStandardsSent = false;

// ====== Persist ======
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

// ====== SW restore ======
async function restoreQueue() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY];
  if (saved && saved.queue && saved.queue.length > 0 && saved.running) {
    taskQueue = saved.queue;
    completedCount = saved.completed || 0;
    errorCount = saved.errors || 0;
    taskResults = saved.taskResults || {};
    isRunning = false;
    console.log("Restored: " + taskQueue.length + " tasks, resuming");
    startProcessing();
  }
}
restoreQueue();

function sleep(ms) { return new Promise(function(r) { return setTimeout(r, ms); }); }

// ====== Message router ======
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  switch (msg.type) {
    case "enqueueTasks": {
      if (isRunning && taskQueue.length > 0) {
        sendResponse({ ok: false, error: "Queue already running" });
        break;
      }
      if (taskQueue.length > 0 && !isRunning) {
        console.log("Replacing stale queue (" + taskQueue.length + " tasks)");
      }
      var enableReview = msg.enableReview !== false;
      var maxRetries = enableReview ? (msg.maxRetries !== undefined ? msg.maxRetries : DEFAULT_MAX_RETRIES) : 0;
      var passScore = msg.passScore !== undefined ? msg.passScore : DEFAULT_PASS_SCORE;
      var reviewPromptTemplate = msg.reviewPromptTemplate || "";
      taskQueue = msg.tasks.map(function(t) {
        return Object.assign({}, t, {
          _enableReview: enableReview,
          _maxRetries: maxRetries,
          _passScore: passScore,
          _retries: 0,
          _reviewTemplate: reviewPromptTemplate,
        });
      });
      completedCount = 0;
      errorCount = 0;
      taskResults = {};
      reviewStandardsSent = false;
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
      reviewStandardsSent = false;
      persistQueue();
      sendResponse({ ok: true });
      break;
    }

    case "download": {
      chrome.downloads.download({
        url: msg.url,
        filename: DOWNLOAD_DIR + "/" + msg.filename,
        saveAs: false,
      }, function(downloadId) {
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

// ====== Task processor ======
async function startProcessing() {
  if (isRunning) return;
  isRunning = true;
  await persistQueue();

  while (taskQueue.length > 0) {
    var task = taskQueue[0];
    await persistQueue();

    generatorTabId = await ensureGeneratorTab();
    if (!generatorTabId) { markTaskFailed(task, "No ChatGPT tab"); continue; }

    var passed = false;
    var currentPrompt = task.prompt;
    var enableReview = task._enableReview !== false;
    var maxRetries = enableReview ? (task._maxRetries || DEFAULT_MAX_RETRIES) : 0;

    // --- Generate + review loop for ONE task ---
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      task._retries = attempt;
      await persistQueue();

      // 1. Generate
      var genResult = await sendWithRetry(generatorTabId, {
        type: "generate",
        prompt: currentPrompt,
        outputName: task.outputName,
      }, 2);

      if (!genResult || !genResult.success) {
        task._error = (genResult && genResult.error) || "Generation failed";
        break;
      }

      var imageUrl = genResult.imageUrl;
      task._lastImageUrl = imageUrl;

      // 2. No review? Done
      if (!enableReview || !imageUrl) {
        passed = true;
        break;
      }

      // 3. Review
      reviewerTabId = await ensureReviewerTab();
      if (!reviewerTabId) {
        console.log("Reviewer tab unavailable, skipping");
        passed = true;
        break;
      }

      var reviewPrompt = buildReviewPrompt(task, currentPrompt);
      var reviewResult = await sendWithRetry(reviewerTabId, {
        type: "review",
        imageUrl: imageUrl,
        reviewPrompt: reviewPrompt,
      }, 2);

      if (!reviewResult || !reviewResult.success) {
        console.log("Review comm failed: " + (reviewResult && reviewResult.error));
        passed = true;
        break;
      }

      var score = reviewResult.score || 0;
      var threshold = task._passScore || DEFAULT_PASS_SCORE;
      task._lastScore = score;

      if (score >= threshold) {
        console.log("PASS (" + score + " >= " + threshold + ")");
        passed = true;
        break;
      }

      var feedback = reviewResult.fixInstructions || reviewResult.suggestions || reviewResult.feedback || "Improve quality";
      console.log("FAIL (" + score + " < " + threshold + ")");

      if (attempt < maxRetries) {
        currentPrompt = revisePrompt(currentPrompt, feedback);
        task.outputName = task.outputName.replace(/\.png$/, "_r" + (attempt + 1) + ".png");
      }
    }

    // --- Task done ---
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

// ====== Review prompt ======
function buildReviewPrompt(task, generationPrompt) {
  var template = task._reviewTemplate;
  if (template) {
    return template
      .replace(/\{requirements\}/g, task._originalRequirements || generationPrompt)
      .replace(/\{prompt\}/g, generationPrompt);
  }

  var threshold = task._passScore || DEFAULT_PASS_SCORE;
  var reqs = (task._originalRequirements || generationPrompt);

  if (!reviewStandardsSent) {
    reviewStandardsSent = true;
    return [
      "You are a strict professional image reviewer. Examine this generated image against the requirements below.",
      "",
      "[Original Requirements]",
      reqs,
      "",
      "[Scoring - 100 points]",
      "1. Content accuracy (40pts): Every element matches description? Extra/missing objects?",
      "2. Style consistency (25pts): Color, lighting, composition match?",
      "3. Technical quality (20pts): Sharp, clean, well-composed?",
      "4. AI defects (15pts): Deformed limbs? Garbled text? Unnatural seams? Bad anatomy?",
      "",
      "Reply JSON only:",
      '{"score":<0-100>,"passed":<score>=' + threshold + '>,"issues":["problem1","problem2"],"verdict":"summary","fixInstructions":"EXACTLY what to change - be specific: which element, what is wrong, how to fix it"}'
    ].join("\n");
  }

  return [
    "Review this image (same criteria as before).",
    "Original requirements: " + reqs.slice(0, 200),
    "",
    'JSON: {"score":<0-100>,"passed":<score>=' + threshold + '>,"issues":["..."],"verdict":"...","fixInstructions":"specific fixes if score<' + threshold + '"}'
  ].join("\n");
}

// ====== Revise prompt ======
function revisePrompt(originalPrompt, feedback) {
  return [
    originalPrompt,
    "",
    "[CRITICAL FIXES REQUIRED]",
    "The previous image failed review. You MUST fix these specific problems:",
    feedback,
    "",
    "IMPORTANT: Do NOT just re-generate the same thing. Address EACH issue listed above explicitly."
  ].join("\n");
}

// ====== Fail fast ======
function markTaskFailed(task, error) {
  errorCount++;
  taskResults[task.id] = { status: "error", error: error };
  task._error = error;
  taskQueue.shift();
  persistQueue();
}

// ====== Tab management ======
async function ensureGeneratorTab() {
  if (generatorTabId) {
    try { await chrome.tabs.get(generatorTabId); return generatorTabId; } catch(e) {}
  }
  var tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  if (tabs.length > 0) {
    generatorTabId = tabs[0].id;
    return tabs[0].id;
  }
  var newTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
  await waitForTabLoad(newTab.id);
  await sleep(3000);
  generatorTabId = newTab.id;
  return newTab.id;
}

async function ensureReviewerTab() {
  if (reviewerTabId) {
    try { await chrome.tabs.get(reviewerTabId); return reviewerTabId; } catch(e) {}
  }
  // Find a ChatGPT tab that is NOT the generator tab
  var tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  var reviewTab = null;
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].id !== generatorTabId) {
      reviewTab = tabs[i];
      break;
    }
  }
  if (reviewTab) {
    reviewerTabId = reviewTab.id;
    return reviewTab.id;
  }
  // Open a new tab
  var newTab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
  await waitForTabLoad(newTab.id);
  await sleep(3000);
  reviewerTabId = newTab.id;
  return newTab.id;
}

// ====== Retry send ======
async function sendWithRetry(tabId, msg, maxRetries) {
  for (var i = 0; i < maxRetries; i++) {
    try {
      var result = await chrome.tabs.sendMessage(tabId, msg);
      if (result) return result;
    } catch (e) {
      console.log("  Retry " + (i + 1) + "/" + maxRetries + ": " + e.message);
    }
    if (i < maxRetries - 1) await sleep(3000);
  }
  return { success: false, error: "Communication timeout" };
}

// ====== Tab load waiter ======
function waitForTabLoad(tabId) {
  return new Promise(function(resolve) {
    var timeout = setTimeout(function() { resolve(); }, 15000);
    chrome.tabs.onUpdated.addListener(function listener(tid, info) {
      if (tid === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1000);
      }
    });
  });
}
