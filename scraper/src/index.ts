import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { ScrapedProduct, WatchSource } from "./types";
import { scrapeRuten } from "./platforms/ruten";
import { scrapeYahoo } from "./platforms/yahoo";
import { scrapeCarousell } from "./platforms/carousell";
import { scrapeJljh } from "./platforms/jljh";
import { scrapeSofun } from "./platforms/sofun";
import { scrapeBbbobo } from "./platforms/bbbobo";

// 啟用 stealth plugin（反偵測）
chromium.use(StealthPlugin());

const API_URL = process.env.WORKERS_API_URL;
const API_TOKEN = process.env.API_TOKEN;

if (!API_URL || !API_TOKEN) {
  console.error("缺少環境變數：WORKERS_API_URL 或 API_TOKEN");
  process.exit(1);
}

/** 根據平台選擇對應爬蟲 */
type PlatformScraper = (
  page: import("playwright").Page,
  url: string
) => Promise<ScrapedProduct[]>;

const scrapers: Record<string, PlatformScraper> = {
  ruten: scrapeRuten,
  yahoo: scrapeYahoo,
  // carousell: scrapeCarousell, // 暫停：Cloudflare Turnstile 擋住 GitHub Actions 的 datacenter IP
  jljh: scrapeJljh,
  sofun: scrapeSofun,
  bbbobo: scrapeBbbobo,
};

/** 從 Workers API 取得啟用中的監控來源 */
async function fetchSources(): Promise<WatchSource[]> {
  const res = await fetch(`${API_URL}/api/sources`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`取得監控來源失敗: ${res.status}`);
  }
  const sources = (await res.json()) as WatchSource[];
  return sources.filter((s) => s.active === 1);
}

/** 將爬到的商品批次上傳到 Workers API */
async function uploadProducts(
  sourceId: number,
  platform: string,
  products: ScrapedProduct[]
): Promise<void> {
  if (products.length === 0) return;

  const res = await fetch(`${API_URL}/api/products/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({
      source_id: sourceId,
      platform,
      products,
    }),
  });

  if (!res.ok) {
    console.error(`上傳商品失敗: ${res.status} ${await res.text()}`);
    return;
  }

  const result = (await res.json()) as { inserted: number; total: number };
  console.log(`上傳完成: 新增 ${result.inserted}/${result.total} 件`);
}

/** 主流程 */
async function main() {
  console.log("=== manga-radar 爬蟲開始 ===");

  const sources = await fetchSources();
  console.log(`取得 ${sources.length} 個啟用中的監控來源`);

  if (sources.length === 0) {
    console.log("沒有啟用中的監控來源，結束");
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
  });

  try {
    for (const source of sources) {
      const scraper = scrapers[source.platform];
      if (!scraper) {
        console.warn(`不支援的平台: ${source.platform}，跳過 ${source.name}`);
        continue;
      }

      console.log(`\n--- 爬取: ${source.name} (${source.platform}) ---`);

      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
        locale: "zh-TW",
        timezoneId: "Asia/Taipei",
        extraHTTPHeaders: {
          "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });
      // 隱藏 webdriver 標記
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // @ts-ignore
        delete navigator.__proto__.webdriver;
      });
      const page = await context.newPage();

      try {
        const products = await scraper(page, source.url);
        await uploadProducts(source.id, source.platform, products);
      } catch (err) {
        console.error(`爬取 ${source.name} 失敗:`, err);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log("\n=== 爬蟲結束 ===");
}

main().catch((err) => {
  console.error("爬蟲執行失敗:", err);
  process.exit(1);
});
