const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const USER_DATA_DIR = path.join(__dirname, "browser-data-analyze");
  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });

  const page = browser.pages()[0] || (await browser.newPage());

  // 分析公开课列表页
  const urls = [
    "https://ylzt.xuexiao.com.cn/?control-list",       // 公开课
    "https://ylzt.xuexiao.com.cn/?control-roomlist",    // 听课
    "https://ylzt.xuexiao.com.cn/?control-epnewslist",  // 资讯
  ];

  for (const url of urls) {
    console.log(`\n===== 正在分析: ${url} =====`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000);

    // 找所有课程卡片/列表项
    const items = await page.$$eval("*", (els) => {
      // 尝试找到列表容器中的每一项
      const containers = document.querySelectorAll(
        ".course-item, .course-card, .list-item, .news-item, [class*='item'], [class*='card'], [class*='list'] li, .swiper-slide, .col-"
      );
      return Array.from(containers)
        .filter((el) => {
          const text = el.innerText?.trim();
          const img = el.querySelector("img");
          return text && text.length > 10 && img;
        })
        .slice(0, 10)
        .map((el) => ({
          text: el.innerText?.trim().slice(0, 300),
          img: el.querySelector("img")?.src || "",
          link: el.querySelector("a")?.href || "",
        }));
    });

    console.log(`找到 ${items.length} 个有效条目:`);
    items.forEach((item, i) => {
      console.log(`\n  [${i + 1}]`);
      console.log(`   图片: ${item.img.slice(0, 100)}`);
      console.log(`   链接: ${item.link}`);
      console.log(`   文本: ${item.text.replace(/\n/g, " | ").slice(0, 150)}`);
    });

    // 也看看有没有分页
    const pagers = await page.$$eval("a, button, span", (els) =>
      els
        .filter((el) => {
          const t = el.innerText.trim();
          return /^\d+$/.test(t) || t.includes("下一页") || t.includes("下页");
        })
        .map((el) => ({ text: el.innerText.trim(), href: el.href || el.onclick?.toString()?.slice(0, 50) }))
    );
    if (pagers.length > 0) {
      console.log(`\n  分页:`, pagers);
    }
  }

  console.log("\n✅ 分析完成，按 Enter 关闭...");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  await browser.close();
})();
