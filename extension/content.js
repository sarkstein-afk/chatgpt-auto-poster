// ====== ChatGPT 页面操控（生成 + 审核双模式，反检测版） ======

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ping") {
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "generate") {
    doGenerate(msg.prompt, msg.outputName, msg.referenceImages).then(sendResponse);
    return true;
  }

  if (msg.type === "review") {
    doReview(msg.imageUrl, msg.reviewPrompt).then(sendResponse);
    return true;
  }
});

// ==================== 工具函数 ====================
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function jitter(base, variance = 0.3) {
  return base + (Math.random() - 0.5) * 2 * base * variance;
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const TYPO_NEARBY = {
  a:"qswz",b:"vghn",c:"xdfv",d:"serfcx",e:"wrsdf",f:"drtgc",g:"ftyhbv",
  h:"gyujnb",i:"uojk",j:"yuikmn",k:"uijlm",l:"ikop",m:"njk",n:"bhjm",
  o:"iklp",p:"ol",q:"was",r:"etdf",s:"awedxz",t:"ryfgh",u:"yihj",
  v:"cfgb",w:"qase",x:"zsdc",y:"tughj",z:"asx",
};
function randomTypo(char) {
  const lower = char.toLowerCase();
  const nearby = TYPO_NEARBY[lower];
  if (!nearby) return char;
  const typo = nearby[Math.floor(Math.random() * nearby.length)];
  return char === lower ? typo : typo.toUpperCase();
}

async function humanScroll() {
  window.scrollBy({ top: rand(50, 300), behavior: "smooth" });
  await sleep(rand(500, 1500));
  if (Math.random() < 0.4) {
    window.scrollBy({ top: -rand(20, 150), behavior: "smooth" });
    await sleep(rand(300, 800));
  }
}

// ==================== 元素查找 ====================
function findInput() {
  const prose = document.querySelector('.ProseMirror[contenteditable="true"]');
  if (prose && prose.offsetParent !== null) return prose;
  const ta = document.querySelector("#prompt-textarea");
  if (ta && ta.offsetParent !== null) return ta;
  const ce = document.querySelector('div[contenteditable="true"]');
  if (ce && ce.offsetParent !== null) return ce;
  const any = document.querySelector("textarea");
  if (any && any.offsetParent !== null) return any;
  return null;
}

function findSendBtn() {
  const byTestId = document.querySelector('[data-testid="send-button"]');
  if (byTestId && !byTestId.disabled && byTestId.offsetParent !== null) return byTestId;
  const byAria = document.querySelector('button[aria-label*="Send"], button[aria-label*="send"]');
  if (byAria && !byAria.disabled && byAria.offsetParent !== null) return byAria;
  return null;
}

function findFileInput() {
  // ChatGPT 的文件上传 input
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  // 优先找可见的/最近的
  const visible = inputs.find(i => i.offsetParent !== null);
  return visible || inputs[0] || null;
}

// ==================== 模拟人手操作 ====================
async function humanClick(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = rect.left + rand(rect.width * 0.2, rect.width * 0.8);
  const y = rect.top + rand(rect.height * 0.2, rect.height * 0.8);
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mouseenter", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
  await sleep(rand(30, 100));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  await sleep(rand(50, 150));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}

async function humanType(el, text) {
  el.focus();
  el.click();
  await sleep(rand(50, 150));

  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    el.value = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      el.value += ch;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(/[一-鿿]/.test(ch) ? rand(60, 180) : rand(30, 120));
      if (Math.random() < 0.02) await sleep(rand(200, 800));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  // ProseMirror — 逐字插入 + 随机打错回删
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const willTypo = char.charCodeAt(0) < 128 && Math.random() < 0.03;
    const actualChar = willTypo ? randomTypo(char) : char;
    const isAscii = actualChar.charCodeAt(0) < 128;

    const keyInit = {
      key: actualChar, bubbles: true, cancelable: true,
      code: isAscii ? ("Key" + actualChar.toUpperCase()) : "",
      keyCode: isAscii ? actualChar.charCodeAt(0) : 229,
      which: isAscii ? actualChar.charCodeAt(0) : 229,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", keyInit));
    el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: actualChar, bubbles: true, cancelable: true }));
    document.execCommand("insertText", false, actualChar);
    el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: actualChar, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", keyInit));

    if (willTypo) {
      await sleep(rand(100, 300));
      const bsInit = { key: "Backspace", code: "Backspace", keyCode: 8, which: 8, bubbles: true };
      el.dispatchEvent(new KeyboardEvent("keydown", bsInit));
      el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", data: null, bubbles: true, cancelable: true }));
      document.execCommand("delete", false, null);
      el.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", data: null, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", bsInit));
      await sleep(rand(150, 400));

      const isAscii2 = char.charCodeAt(0) < 128;
      const fixInit = {
        key: char, bubbles: true, cancelable: true,
        code: isAscii2 ? ("Key" + char.toUpperCase()) : "",
        keyCode: isAscii2 ? char.charCodeAt(0) : 229,
        which: isAscii2 ? char.charCodeAt(0) : 229,
      };
      el.dispatchEvent(new KeyboardEvent("keydown", fixInit));
      el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: char, bubbles: true, cancelable: true }));
      document.execCommand("insertText", false, char);
      el.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", fixInit));
    }

    await sleep(/[一-鿿]/.test(char) ? rand(60, 180) : rand(30, 120));
    if (Math.random() < 0.02) await sleep(rand(200, 800));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForInput(timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = findInput();
    if (el) return el;
    await sleep(500);
  }
  return null;
}

// ==================== 图片上传 ====================
async function uploadImage(imageUrl) {
  const fileInput = findFileInput();
  if (!fileInput) {
    console.log("  ⚠ 找不到文件上传 input");
    return false;
  }

  try {
    // 下载图片为 blob
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    const blob = await resp.blob();

    // 通过 DataTransfer 设置文件
    const file = new File([blob], "review_image.png", { type: blob.type || "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));

    console.log("  📎 图片已上传");
    return true;
  } catch (e) {
    console.log("  ❌ 上传失败:", e.message);
    return false;
  }
}

async function waitForUploadComplete(timeout = 30000) {
  // 等上传完成：文件名/缩略图出现
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // ChatGPT 上传完成通常显示文件名或缩略图
    const indicators = [
      ...document.querySelectorAll('[class*="upload"], [class*="file"], [class*="attachment"]'),
      ...document.querySelectorAll('img[alt*="Upload"]'),
    ];
    // 或者上传中的进度条消失
    const uploading = document.querySelector('[class*="progress"], [class*="spinner"], [class*="loading"]');
    if (indicators.length > 0 && !uploading) {
      await sleep(500);
      return true;
    }
    await sleep(1000);
  }
  return true; // 超时也不阻塞，可能是已经传完了
}

// ==================== 等待生成/响应 ====================
async function waitForImage(timeout = 180000) {
  const start = Date.now();
  const patterns = ["oaidalleapi", "files.oaiusercontent.com", "dall-e"];

  while (Date.now() - start < timeout) {
    if (document.querySelector('[data-testid="stop-button"]')) {
      await sleep(jitter(3000, 0.4));
      continue;
    }
    const imgs = Array.from(document.querySelectorAll("img")).filter(img =>
      patterns.some(p => (img.src || "").includes(p))
    );
    if (imgs.length > 0) { await sleep(jitter(2000, 0.5)); return true; }

    const errEls = Array.from(document.querySelectorAll('[class*="error"], [class*="text-red"]'));
    for (const err of errEls) {
      const txt = (err.innerText || "").toLowerCase();
      if (txt.includes("unable") || txt.includes("无法") || txt.includes("content policy")) return false;
    }
    await sleep(jitter(2500, 0.3));
  }
  return false;
}

async function waitForTextResponse(timeout = 120000) {
  // 等 GPT-4V 文字回复（不是生图）
  const start = Date.now();

  while (Date.now() - start < timeout) {
    // 生成中（stop 按钮可见）
    if (document.querySelector('[data-testid="stop-button"]')) {
      await sleep(jitter(3000, 0.4));
      continue;
    }

    // 已停止生成 — 找最后一条 assistant 消息的文本
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    if (turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      const textEls = lastTurn.querySelectorAll('p, [class*="markdown"], [class*="prose"], [class*="text-message"]');
      const text = Array.from(textEls).map(e => e.innerText).join("\n").trim();
      if (text.length > 30) {
        await sleep(1000);
        return text;
      }
    }

    // 兜底：页面最后出现的段落文本
    const allP = Array.from(document.querySelectorAll("p"));
    const lastText = allP.filter(p => p.innerText.length > 20).map(p => p.innerText).slice(-3).join("\n");
    if (lastText.length > 30) {
      await sleep(1000);
      return lastText;
    }

    await sleep(jitter(2500, 0.3));
  }
  return null;
}

// ==================== JSON 解析 ====================
function extractReviewResult(text) {
  if (!text) return null;

  // 尝试 ```json ... ```
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try {
      const parsed = JSON.parse(codeBlock[1].trim());
      return normalizeScore(parsed);
    } catch {}
  }

  // 尝试 {...}
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeScore(parsed);
    } catch {}
  }

  // 关键词兜底
  const lower = text.toLowerCase();
  const scoreMatch = text.match(/(?:score|分数|评分)[:\s]*(\d+)/i);
  const score = scoreMatch ? parseInt(scoreMatch[1]) : null;

  if (score !== null) {
    return { score: score > 10 ? score : score * 10, feedback: text.slice(0, 200), suggestions: text.slice(0, 500) };
  }
  if (lower.includes("通过") || lower.includes("pass")) {
    return { score: 85, feedback: text.slice(0, 200), suggestions: "" };
  }
  if (lower.includes("不通过") || lower.includes("fail")) {
    return { score: 40, feedback: text.slice(0, 200), suggestions: text.slice(0, 500) };
  }

  return null;
}

// Normalize score to 0-100 scale
function normalizeScore(result) {
  if (!result) return null;
  let score = result.score ?? result.rating ?? 0;
  score = Number(score);
  if (isNaN(score)) score = 0;
  // If score looks like 1-10 scale, convert to 0-100
  // Only do this if the score is <= 10 AND it has a decimal (like 7.5) or is clearly 1-10
  // A raw score of 5 could be 5/10 or 5/100 - we check if there's a "/10" context
  if (score <= 10) {
    // Check if the raw response text suggests a 1-10 scale
    const rawText = JSON.stringify(result);
    const isTenScale = /\/10|out of 10|满分10|十分制|1-10/i.test(rawText);
    if (isTenScale || score % 1 !== 0) {
      // Has decimal or explicit /10 context - it's 1-10 scale
      score = Math.round(score * 10);
    }
    // If it's an integer <= 10 with no /10 context, assume it's already x/100
    // (e.g., a score of 8 without context is more likely 8/100 than 80/100)
    // Actually, this is ambiguous. We trust the prompt asks for 0-100.
    // If score <= 10 and not clearly 1-10 scale, we keep as-is.
  }
  result.score = Math.round(Math.min(100, Math.max(0, score)));
  return result;
}

// ==================== 核心：生成一张图（含参考图一次性上传） ====================
async function doGenerate(prompt, outputName, referenceImages) {
  console.log(`🎨 [生图] ${outputName}${referenceImages?.length ? ` +${referenceImages.length}张参考图` : ""}`);

  try {
    // 0. 新开对话
    const newChatBtn =
      document.querySelector('a[href="/"]') ||
      document.querySelector('[data-testid="new-chat"]') ||
      document.querySelector('button[aria-label*="New chat"], button[aria-label*="new chat"]');
    if (newChatBtn) {
      newChatBtn.click();
      await sleep(2000);
    }

    // 1. 等输入框出现
    const inputBox = await waitForInput();
    if (!inputBox) return { success: false, error: "找不到输入框" };

    // 2. 上传参考图（全部一次性上传）
    const refs = referenceImages || [];
    if (refs.length > 0) {
      for (let i = 0; i < refs.length; i++) {
        const uploaded = await uploadImage(refs[i]);
        if (uploaded) {
          await waitForUploadComplete();
          await sleep(rand(300, 800));
        }
      }
      console.log(`  📎 ${refs.length} 张参考图已上传`);
    }

    // 3. 输入文字（和参考图在同一个消息里）
    await sleep(rand(200, 600));
    await humanType(inputBox, prompt);
    await sleep(rand(300, 1000));

    // 4. 发送（只发一次）
    const sendBtn = findSendBtn();
    if (sendBtn) { await humanClick(sendBtn); }
    else {
      await sleep(rand(50, 200));
      inputBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }

    console.log(`  🚀 已发送（${refs.length ? `含${refs.length}张参考图` : "纯文字"}）`);
    const ok = await waitForImage();
    if (!ok) console.log(`  ⚠ 生成超时，兜底查找`);

    await sleep(jitter(2000, 0.5));

    // 找图片 URL
    const patterns = ["oaidalleapi", "files.oaiusercontent.com", "dall-e"];
    const allImgs = Array.from(document.querySelectorAll("img"));
    const dalleImgs = allImgs.filter(i => patterns.some(p => (i.src || "").includes(p)));
    const bigImgs = allImgs.filter(i => i.naturalWidth > 300 && i.naturalHeight > 300 && i.src.startsWith("https://"));
    const allUrls = [...new Set([...dalleImgs, ...bigImgs].map(i => i.src))];
    const imgUrl = allUrls[allUrls.length - 1];

    if (!imgUrl) return { success: false, error: "没找到生成的图片" };

    try {
      await chrome.runtime.sendMessage({ type: "download", url: imgUrl, filename: outputName });
    } catch {}

    console.log(`  ✅ 完成: ${outputName}`);
    return { success: true, imageUrl: imgUrl };

  } catch (e) {
    console.error(`  ❌ ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ==================== 核心：审核一张图 ====================
async function doReview(imageUrl, reviewPrompt) {
  console.log(`🔍 [审核] 开始`);

  try {
    // 1. 等输入框
    const inputBox = await waitForInput();
    if (!inputBox) return { success: false, error: "找不到输入框" };

    // 2. 上传图片
    const uploaded = await uploadImage(imageUrl);
    if (!uploaded) return { success: false, error: "图片上传失败" };

    // 等上传完成
    await waitForUploadComplete();
    await sleep(rand(500, 1500));

    // 3. 输入审核 prompt
    await humanType(inputBox, reviewPrompt);
    await sleep(rand(400, 1200));

    // 4. 发送
    const sendBtn = findSendBtn();
    if (sendBtn) { await humanClick(sendBtn); }
    else {
      inputBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }

    console.log(`  🚀 审核请求已发送`);

    // 5. 等文字回复
    const text = await waitForTextResponse();
    if (!text) return { success: false, error: "审核超时，未收到回复" };

    console.log(`  📝 审核回复: ${text.slice(0, 100)}...`);

    // 6. 解析结果
    const result = extractReviewResult(text);
    if (!result) {
      return { success: false, error: "无法解析审核结果", rawText: text };
    }

    console.log(`  ${result.pass ? "✅ 通过" : "❌ 不通过"} (${result.score}/10)`);
    return { success: true, passed: result.pass, score: result.score, feedback: result.feedback, suggestions: result.suggestions || "", rawText: text };

  } catch (e) {
    console.error(`  ❌ ${e.message}`);
    return { success: false, error: e.message };
  }
}
