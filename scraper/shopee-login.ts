import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as path from "path";

/**
 * 蝦皮登入工具
 *
 * 使用持久化瀏覽器 profile，登入一次後 session 會保留。
 * Cookie 過期時重新執行即可。
 *
 * 用法：pnpm tsx shopee-login.ts
 */

chromium.use(StealthPlugin());

const PROFILE_DIR = path.join(__dirname, ".shopee-profile");

async function main() {
  console.log("開啟瀏覽器（持久化 profile），請登入蝦皮...");
  console.log(`Profile 目錄: ${PROFILE_DIR}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    viewport: { width: 1280, height: 800 },
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://shopee.tw/", {
    waitUntil: "domcontentloaded",
  });

  const currentUrl = page.url();
  if (currentUrl.includes("/buyer/login")) {
    console.log("需要登入，請在瀏覽器中完成登入...\n");

    // 等待離開登入頁（最多 5 分鐘）
    try {
      await page.waitForURL(
        (url) =>
          !url.pathname.includes("/buyer/login") &&
          !url.pathname.includes("/buyer/signup"),
        { timeout: 300000 }
      );
      console.log("✓ 登入成功！");
    } catch {
      console.log("✗ 逾時（5 分鐘），未偵測到登入成功");
    }
  } else {
    console.log("✓ 已登入（session 仍有效）");
  }

  // 驗證搜尋頁
  console.log("\n驗證中：嘗試訪問搜尋頁...");
  await page.goto(
    "https://shopee.tw/search?keyword=漫畫&sortBy=ctime",
    { waitUntil: "domcontentloaded", timeout: 15000 }
  );
  await page.waitForTimeout(3000);
  const finalUrl = page.url();
  if (finalUrl.includes("/buyer/login")) {
    console.log("✗ 搜尋頁仍被導到登入頁");
  } else {
    const title = await page.title();
    console.log(`✓ 搜尋頁正常載入：${title}`);
  }

  console.log("\n關閉瀏覽器即可完成");

  await new Promise<void>((resolve) => {
    context.on("close", resolve);
  });
}

main().catch(console.error);
