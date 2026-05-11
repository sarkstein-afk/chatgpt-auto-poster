const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const USER_DATA_DIR = path.join(__dirname, "browser-data");
  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });

  const page = browser.pages()[0] || (await browser.newPage());

  // 1. 打开目标网站
  console.log("正在打开 https://ylzt.xuexiao.com.cn ...");
  await page.goto("https://ylzt.xuexiao.com.cn", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // 等待 WAF 验证通过
  await page.waitForTimeout(3000);

  // 2. 获取页面标题
  const title = await page.title();
  console.log("页面标题:", title);

  // 3. 获取所有链接
  const links = await page.$$eval("a", (els) =>
    els.map((el) => ({
      text: el.innerText.trim().slice(0, 50),
      href: el.href,
    })).filter((l) => l.text && l.href)
  );
  console.log(`\n找到 ${links.length} 个链接:`);
  links.slice(0, 30).forEach((l) => {
    console.log(`  [${l.text}] → ${l.href}`);
  });

  // 4. 获取所有图片
  const images = await page.$$eval("img", (els) =>
    els.map((el) => ({
      src: el.src,
      alt: el.alt,
    })).filter((i) => i.src && i.src.startsWith("http"))
  );
  console.log(`\n找到 ${images.length} 张图片:`);
  images.slice(0, 10).forEach((i) => {
    console.log(`  [${i.alt}] → ${i.src.slice(0, 100)}`);
  });

  // 5. 截图保存
  await page.screenshot({ path: path.join(__dirname, "screenshot.png"), fullPage: true });
  console.log("\n📸 截图已保存: screenshot.png");

  // 6. 尝试找列表/详情结构
  const bodyText = await page.$$eval("body", (els) =>
    els[0]?.innerText?.slice(0, 3000)
  );
  console.log("\n页面文本 (前 3000 字):");
  console.log(bodyText);

  console.log("\n✅ 结构分析完成，按 Enter 关闭浏览器...");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  await browser.close();
})();
