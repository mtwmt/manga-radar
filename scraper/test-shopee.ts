import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { scrapeShopee, hasShopeeProfile, SHOPEE_PROFILE_DIR } from "./src/platforms/shopee";

chromium.use(StealthPlugin());

async function main() {
  const url =
    "https://shopee.tw/search?facet=11041137&filters=9&noCorrection=true&page=0&sortBy=ctime&is_from_login=true";

  if (!hasShopeeProfile()) {
    console.error("請先執行 pnpm tsx shopee-login.ts 登入蝦皮");
    return;
  }

  console.log("啟動瀏覽器（持久化 profile）...");
  const context = await chromium.launchPersistentContext(SHOPEE_PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    viewport: { width: 1920, height: 1080 },
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    extraHTTPHeaders: {
      "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();

  try {
    const products = await scrapeShopee(page, url);
    console.log(`\n=== 結果：共 ${products.length} 件商品 ===\n`);
    for (const p of products.slice(0, 10)) {
      console.log(`  ${p.title}`);
      console.log(`  價格: ${p.price ?? "無"} | 賣家: ${p.seller ?? "無"}`);
      console.log(`  ${p.url}`);
      console.log();
    }
    if (products.length > 10) {
      console.log(`  ... 還有 ${products.length - 10} 件`);
    }
  } catch (err) {
    console.error("測試失敗:", err);
  } finally {
    await context.close();
  }
}

main();
