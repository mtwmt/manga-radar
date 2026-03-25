import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page } from "playwright";
import type { ScrapedProduct } from "../types";

/**
 * 蝦皮爬蟲
 *
 * 蝦皮強制登入 + 瀏覽器指紋驗證，無法用一般 headless 爬取。
 * 透過 CDP 連到 NAS 上跑的 Chrome 容器（已登入蝦皮），繞過限制。
 *
 * 策略一（主要）：攔截瀏覽器發出的搜尋 API 回應，直接取得 JSON 商品資料
 * 策略二（Fallback）：從 DOM 提取商品資料
 */

chromium.use(StealthPlugin());

/** CDP 連線端點，預設連 NAS Docker Chrome */
const CDP_ENDPOINT = process.env.SHOPEE_CDP_URL || "http://localhost:9222";

/** 隨機延遲（毫秒） */
function randomDelay(min = 500, max = 1500): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 蝦皮搜尋 API 回應中的商品結構 */
interface ShopeeSearchItem {
  itemid?: number;
  shopid?: number;
  name?: string;
  price?: number;
  price_min?: number;
  price_max?: number;
  image?: string;
  images?: string[];
  item_basic?: {
    itemid?: number;
    shopid?: number;
    name?: string;
    price?: number;
    price_min?: number;
    price_max?: number;
    image?: string;
    images?: string[];
    shop_name?: string;
  };
  shop_name?: string;
}

/** 蝦皮 API 價格除以 100000 才是實際台幣金額 */
function normalizePrice(raw: number | undefined): number | null {
  if (!raw || raw <= 0) return null;
  const price = raw / 100000;
  return price >= 1 ? price : raw;
}

/** 組合蝦皮商品圖片 URL */
function shopeeImageUrl(hash: string | undefined): string | null {
  if (!hash) return null;
  return `https://down-tw.img.susercontent.com/file/${hash}`;
}

/** 清理 URL：移除 is_from_login 參數 */
function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("is_from_login");
    return u.toString();
  } catch {
    return url.replace(/[&?]is_from_login=[^&]*/g, "");
  }
}

/**
 * 透過 CDP 連到遠端 Chrome，執行蝦皮爬蟲
 */
export async function scrapeShopeeViaCDP(
  url: string
): Promise<ScrapedProduct[]> {
  const cleanedUrl = cleanUrl(url);
  console.log(`[蝦皮] 連接 CDP: ${CDP_ENDPOINT}`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  } catch (err) {
    console.error(`[蝦皮] CDP 連接失敗: ${err}`);
    console.error("[蝦皮] 請確認 NAS Docker Chrome 容器正在運行");
    return [];
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error("[蝦皮] 無法取得 browser context");
    await browser.close();
    return [];
  }

  const page = await context.newPage();

  try {
    const products = await scrapeShopee(page, cleanedUrl);
    return products;
  } finally {
    await page.close();
    await browser.close();
  }
}

/**
 * 策略一：攔截搜尋 API 回應
 */
async function interceptApiResponse(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  const products: ScrapedProduct[] = [];

  const apiPromise = new Promise<ShopeeSearchItem[]>((resolve) => {
    let resolved = false;

    page.on("response", async (response) => {
      if (resolved) return;
      const reqUrl = response.url();

      if (
        reqUrl.includes("shopee.tw/api/") &&
        (reqUrl.includes("search_items") || reqUrl.includes("search/"))
      ) {
        try {
          const json = await response.json();
          const items =
            json.items ||
            json.item ||
            json.data?.items ||
            json.data?.item ||
            [];
          if (Array.isArray(items) && items.length > 0) {
            console.log(`[蝦皮] 攔截到搜尋 API，共 ${items.length} 件`);
            resolved = true;
            resolve(items);
          }
        } catch {
          // 非 JSON 回應，忽略
        }
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve([]);
      }
    }, 30000);
  });

  console.log(`[蝦皮] 前往搜尋頁: ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  await page.waitForLoadState("networkidle").catch(() => {
    console.warn("[蝦皮] networkidle 等待逾時");
  });

  await page.evaluate(() => window.scrollTo(0, 600));
  await randomDelay(500, 1000);

  const items = await apiPromise;

  if (items.length > 0) {
    console.log(`[蝦皮] API 攔截成功，開始解析商品`);

    for (const rawItem of items) {
      const item = rawItem.item_basic || rawItem;

      const itemId = item.itemid;
      const shopId = item.shopid;
      const name = item.name || "";
      if (!itemId || !name) continue;

      const price = normalizePrice(
        item.price_min || item.price || item.price_max
      );
      const imageHash = item.image || item.images?.[0];
      const shopName = item.shop_name || rawItem.shop_name || null;

      products.push({
        platformId: String(itemId),
        title: name,
        price,
        url: `https://shopee.tw/product/${shopId}/${itemId}`,
        imageUrl: shopeeImageUrl(imageHash),
        seller: shopName,
      });
    }

    return products;
  }

  return [];
}

/**
 * 策略二（Fallback）：從 DOM 提取商品
 */
async function extractFromDom(page: Page): Promise<ScrapedProduct[]> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await randomDelay(500, 1000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await randomDelay(800, 1500);

  const hasCards = await page
    .waitForSelector('a[data-sqe="link"], div[data-sqe="item"]', {
      timeout: 10000,
    })
    .then(() => true)
    .catch(() => false);

  if (!hasCards) {
    await page
      .waitForSelector('a[href*="/product/"], a[href*="-i."]', {
        timeout: 5000,
      })
      .catch(() => {});
  }

  const products = await page.evaluate(() => {
    const results: Array<{
      platformId: string;
      title: string;
      price: number | null;
      url: string;
      imageUrl: string | null;
      seller: string | null;
    }> = [];

    const seen = new Set<string>();

    const links = document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/product/"], a[href*="-i."]'
    );

    for (const link of links) {
      const href = link.href;
      if (!href) continue;

      let itemId: string | null = null;

      const productMatch = href.match(/\/product\/\d+\/(\d+)/);
      if (productMatch) {
        itemId = productMatch[1];
      }

      if (!itemId) {
        const slugMatch = href.match(/-i\.(\d+)\.(\d+)/);
        if (slugMatch) {
          itemId = slugMatch[2];
        }
      }

      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);

      const card =
        link.closest('[data-sqe="item"]') ||
        link.closest("li") ||
        link.closest("div") ||
        link;

      const titleEl = card.querySelector(
        'div[data-sqe="name"], [class*="name"], [class*="title"]'
      );
      const title =
        titleEl?.textContent?.trim() ||
        link.getAttribute("title") ||
        link.textContent?.trim() ||
        "";
      if (!title || title.length < 2) continue;

      let price: number | null = null;
      const priceEl = card.querySelector(
        'span[class*="price"], div[class*="price"], [class*="Price"]'
      );
      if (priceEl) {
        const priceText =
          priceEl.textContent?.replace(/[^0-9.]/g, "") || "";
        const p = parseFloat(priceText);
        if (!isNaN(p) && p > 0) price = p;
      }

      const img = card.querySelector<HTMLImageElement>("img");
      const imageUrl =
        img?.src || img?.getAttribute("data-src") || null;

      const sellerEl = card.querySelector(
        '[class*="seller"], [class*="shop"], [class*="store"]'
      );
      const seller = sellerEl?.textContent?.trim() || null;

      results.push({
        platformId: itemId,
        title,
        price,
        url: href.startsWith("http") ? href : `https://shopee.tw${href}`,
        imageUrl,
        seller,
      });
    }

    return results;
  });

  return products;
}

/**
 * 蝦皮爬蟲主函式（給 index.ts 呼叫）
 * page 參數由 CDP 連線提供
 */
export async function scrapeShopee(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  console.log(`[蝦皮] 開始爬取: ${url}`);

  // 策略一：攔截 API 回應
  console.log("[蝦皮] 嘗試攔截 API 回應...");
  const apiProducts = await interceptApiResponse(page, url);
  if (apiProducts.length > 0) return apiProducts;

  // 檢查是否被導到登入頁
  const afterUrl = page.url();
  if (afterUrl.includes("/buyer/login")) {
    console.error("[蝦皮] Session 已過期，被導到登入頁");
    console.error("[蝦皮] 請進 noVNC (NAS_IP:6901) 重新登入蝦皮");
    return [];
  }

  // 策略二：DOM fallback
  console.log("[蝦皮] API 攔截無結果，嘗試 DOM 提取...");
  const domProducts = await extractFromDom(page);
  if (domProducts.length > 0) {
    console.log(`[蝦皮] DOM 提取成功，共 ${domProducts.length} 件商品`);
    return domProducts;
  }

  // 除錯資訊
  const pageTitle = await page.title();
  const bodyText = await page.evaluate(
    () => document.body?.innerText?.substring(0, 300) || ""
  );
  console.warn("[蝦皮] 未抓到任何商品");
  console.warn(`[蝦皮] 頁面標題: ${pageTitle}`);
  console.warn(`[蝦皮] 頁面片段: ${bodyText.substring(0, 200)}`);
  return [];
}
