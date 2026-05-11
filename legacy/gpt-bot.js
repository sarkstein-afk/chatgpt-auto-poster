const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));
const OUTPUT_DIR = path.join(__dirname, CONFIG.outputFolder);
const USER_DATA_DIR = path.join(__dirname, "browser-data");
const MODE = CONFIG.mode;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
//  通用：ChatGPT 生图
// ============================================================
async function goToChatGPT(page) {
  await page.goto(CONFIG.chatgptUrl, { waitUntil: "domcontentloaded" });
  await sleep(2500);
}

async function findInput(page) {
  return await page.$("#prompt-textarea, div.ProseMirror, [contenteditable='true']");
}

async function findFileInput(page) {
  return await page.$('input[type="file"]');
}

async function sendMessage(page, text) {
  const inputBox = await findInput(page);
  if (!inputBox) return false;
  await inputBox.click();
  await sleep(300);
  await inputBox.fill(text);
  await sleep(300);

  const sendBtn = await page.$('[data-testid="send-button"]');
  if (sendBtn) await sendBtn.click();
  else await page.keyboard.press("Enter");
  return true;
}

async function waitForGeneration(page, timeout = CONFIG.waitTimeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const stopBtn = await page.$('[data-testid="stop-button"]');
    if (stopBtn) { await sleep(3000); continue; }

    const dalleImgs = await page.$$('img[src*="oaidalleapiprodscus"]');
    const fileImgs = await page.$$('img[src*="files.oaiusercontent.com"]');
    if (dalleImgs.length > 0 || fileImgs.length > 0) {
      await sleep(2000);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

async function downloadGeneratedImage(page, outputName) {
  await sleep(1000);
  const dalleImgs = await page.$$eval('img[src*="oaidalleapiprodscus"]', imgs => imgs.map(i => i.src));
  const fileImgs = await page.$$eval('img[src*="files.oaiusercontent.com"]', imgs => imgs.map(i => i.src));
  const urls = [...dalleImgs, ...fileImgs];

  if (urls.length === 0) {
    const bigImgs = await page.$$eval("img", imgs =>
      imgs.filter(i => i.naturalWidth > 300).map(i => i.src).filter(s => s.startsWith("https://"))
    );
    urls.push(...bigImgs);
  }
  if (urls.length === 0) return false;

  try {
    const resp = await fetch(urls[urls.length - 1]);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const outPath = path.join(OUTPUT_DIR, outputName);
    fs.writeFileSync(outPath, buffer);
    console.log(`  ✅ 保存: ${outputName}`);
    return true;
  } catch (e) {
    console.log(`  ❌ 下载失败: ${e.message}`);
    return false;
  }
}

async function generateOneImage(page, { prompt, outputName }) {
  await goToChatGPT(page);

  if (!(await sendMessage(page, prompt))) {
    console.log("  ❌ 发送失败");
    return false;
  }

  console.log("  ⏳ 等待 GPT 生图...");
  const done = await waitForGeneration(page);
  if (!done) console.log("  ⚠ 等待超时");

  return await downloadGeneratedImage(page, outputName);
}

// ============================================================
//  PDF 模式：解析 PDF → 提取插图标记 → 生图
// ============================================================
async function pdfMode() {
  const pdfPath = path.resolve(__dirname, CONFIG.pdf.path);

  if (!fs.existsSync(pdfPath)) {
    console.log(`❌ 找不到 PDF 文件: ${pdfPath}`);
    console.log(`   请在 config.json → pdf.path 里设置正确的 PDF 路径`);
    process.exit(1);
  }

  console.log(`📄 正在解析 PDF: ${path.basename(pdfPath)}`);

  const dataBuffer = fs.readFileSync(pdfPath);
  const pdfData = await pdfParse(dataBuffer);

  console.log(`   ${pdfData.numpages} 页, ${pdfData.text.length} 字\n`);

  // 提取所有 【插图：xxx】 标记
  const marker = CONFIG.pdf.marker;
  const markerEnd = CONFIG.pdf.markerEnd;

  // 逐页提取，记录页码
  const imageRequests = [];
  let globalIdx = 0;

  // 按页分割文本（pdf-parse 不直接支持按页，我们用比较粗的方式）
  // 尝试用换页符或页标记分割
  const pages = pdfData.text.split(/\f|-----Page \(\d+\)-----/);

  for (let pageNum = 0; pageNum < pages.length; pageNum++) {
    const pageText = pages[pageNum] || "";
    let searchFrom = 0;

    while (true) {
      const startIdx = pageText.indexOf(marker, searchFrom);
      if (startIdx === -1) break;

      const endIdx = pageText.indexOf(markerEnd, startIdx + marker.length);
      if (endIdx === -1) {
        // 没找到结束标记，取到行尾或50字
        const desc = pageText.slice(startIdx + marker.length, startIdx + marker.length + 100)
          .split("\n")[0].trim();
        globalIdx++;
        imageRequests.push({
          index: globalIdx,
          page: pageNum + 1,
          description: desc || "请根据上下文生成合适的插图",
          context: pageText.slice(Math.max(0, startIdx - 100), startIdx + 200).trim(),
        });
        searchFrom = startIdx + marker.length;
      } else {
        const desc = pageText.slice(startIdx + marker.length, endIdx).trim();
        globalIdx++;
        imageRequests.push({
          index: globalIdx,
          page: pageNum + 1,
          description: desc || "请根据上下文生成合适的插图",
          context: pageText.slice(Math.max(0, startIdx - 200), endIdx + 50).trim(),
        });
        searchFrom = endIdx + markerEnd.length;
      }
    }
  }

  console.log(`🔍 找到 ${imageRequests.length} 个插图标记:\n`);
  imageRequests.forEach(r => {
    console.log(`  [${r.index}] P${r.page} — ${r.description.slice(0, 80)}`);
  });

  if (imageRequests.length === 0) {
    console.log("❌ 没有找到任何 【插图：xxx】 标记");
    console.log(`   请在 PDF 中用 "${CONFIG.pdf.marker}描述${CONFIG.pdf.markerEnd}" 格式标注`);
    process.exit(1);
  }

  return imageRequests;
}

// ============================================================
//  爬站模式：遍历网站 → 提取数据 → 生图
// ============================================================
async function scrapeMode() {
  console.log("⚠ 爬站模式，请确认 config.json 中 scrape.sites 已配置\n");
  // 这里复用之前的爬站逻辑（略，保留接口）
  return [];
}

// ============================================================
//  主流程
// ============================================================
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  ChatGPT 自动生图工具");
  console.log("  模式: " + (MODE === "pdf" ? "PDF 插图生成" : "网站爬取"));
  console.log("═══════════════════════════════════════════════════\n");

  // ---- 根据模式获取任务列表 ----
  let tasks = [];

  if (MODE === "pdf") {
    const rawTasks = await pdfMode();
    tasks = rawTasks.map(r => ({
      prompt: `${CONFIG.globalInstruction}\n\n具体需求：${r.description}\n\n（这条需求的上下文：${r.context.slice(0, 300)}）`,
      outputName: `P${r.page}_${r.index}_${r.description.replace(/[\\/:*?"<>|]/g, "_").slice(0, 30)}.png`,
      label: `P${r.page}-${r.description.slice(0, 50)}`,
    }));
  } else if (MODE === "scrape") {
    tasks = await scrapeMode();
  } else {
    console.log(`❌ 未知模式: ${MODE}，请设为 "pdf" 或 "scrape"`);
    process.exit(1);
  }

  if (tasks.length === 0) {
    console.log("❌ 没有任务");
    process.exit(1);
  }

  // 显示任务清单
  console.log(`\n📋 共 ${tasks.length} 个生图任务:\n`);
  tasks.forEach((t, i) => console.log(`  ${i + 1}. ${t.label}`));
  console.log("");

  // ---- 启动浏览器 ----
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("🌐 启动浏览器...\n");
  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = browser.pages()[0] || (await browser.newPage());

  await page.goto(CONFIG.chatgptUrl, { waitUntil: "domcontentloaded" });

  console.log("┌─────────────────────────────────────────────────┐");
  console.log("│ 👆 请在浏览器中登录 ChatGPT                      │");
  console.log("│    登录完成后回到这里按 Enter 开始自动生成       │");
  console.log("└─────────────────────────────────────────────────┘");
  await new Promise((resolve) => process.stdin.once("data", resolve));

  // ---- 逐个生成 ----
  let ok = 0, fail = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    console.log(`\n━━━ [${i + 1}/${tasks.length}] ━━━`);
    console.log(`  🎨 ${task.label}`);

    const result = await generateOneImage(page, task);
    if (result) ok++;
    else fail++;

    if (i < tasks.length - 1) {
      const wait = CONFIG.taskInterval / 1000;
      console.log(`  ⏸ 等待 ${wait} 秒...`);
      await sleep(CONFIG.taskInterval);
    }
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  ✅ 完成: ${ok}  |  ❌ 失败: ${fail}`);
  console.log(`  📁 输出: ${OUTPUT_DIR}`);
  console.log("═══════════════════════════════════════════════════\n");

  console.log("按 Enter 关闭浏览器...");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  await browser.close();
}

main().catch(err => {
  console.error("💥 出错:", err);
  process.stdin.once("data", () => process.exit(1));
});
