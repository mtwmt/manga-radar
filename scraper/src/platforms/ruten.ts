import type { Page } from "playwright";
import type { ScrapedProduct } from "../types";

/**
 * 露天拍賣爬蟲
 *
 * 策略一（主要）：攔截 Vue SPA 發出的 API 請求，直接取得 JSON 商品資料
 * 策略二（Fallback）：從 DOM 提取商品資料
 */

/** 隨機延遲（毫秒） */
function randomDelay(min = 500, max = 1500): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RutenApiItem {
  Id?: string;
  Name?: string;
  Image?: string;
  PriceRange?: number[];
  Price?: number;
  BuyPrice?: number;
  Nick?: string;
  StoreName?: string;
}

/**
 * 策略一：攔截 API 回應
 *
 * 露天是 Vue SPA，頁面載入時會呼叫 rtapi.ruten.com.tw 取得商品資料。
 * 攔截這些 API 回應，直接解析 JSON。
 */
async function interceptApiResponse(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  const products: ScrapedProduct[] = [];

  // 監聽所有 API 回應
  const apiPromise = new Promise<RutenApiItem[]>((resolve) => {
    let resolved = false;

    page.on("response", async (response) => {
      if (resolved) return;
      const reqUrl = response.url();

      // 攔截露天搜尋 API 回應
      if (
        reqUrl.includes("rtapi.ruten.com.tw") &&
        (reqUrl.includes("search") || reqUrl.includes("seller"))
      ) {
        try {
          const json = await response.json();
          const rows = json.Rows || json.rows || json.Items || json.items;
          if (Array.isArray(rows) && rows.length > 0) {
            resolved = true;
            resolve(rows);
          }
        } catch {
          // 非 JSON 回應，忽略
        }
      }
    });

    // 超時 fallback
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve([]);
      }
    }, 25000);
  });

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // 等待 SPA 渲染 + API 回應
  await page.waitForLoadState("networkidle").catch(() => {
    console.warn("[露天] networkidle 等待逾時");
  });

  const rows = await apiPromise;

  if (rows.length > 0) {
    console.log(`[露天] API 攔截成功，共 ${rows.length} 件商品`);
    for (const item of rows) {
      const id = String(item.Id || "");
      const title = item.Name || "";
      if (!id || !title) continue;

      const price = item.BuyPrice || item.Price || item.PriceRange?.[0] || null;

      products.push({
        platformId: id,
        title,
        price: price ? Number(price) : null,
        url: `https://www.ruten.com.tw/item/${id}`,
        imageUrl: item.Image || null,
        seller: item.StoreName || item.Nick || null,
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
  // 捲動觸發懶載入
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await randomDelay(300, 600);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await randomDelay(500, 1000);

  // 嘗試 .rt-product-card
  const hasCards = await page
    .waitForSelector(".rt-product-card", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  const products = await page.evaluate(
    ({ hasCards: hc }) => {
      const results: Array<{
        platformId: string;
        title: string;
        price: number | null;
        url: string;
        imageUrl: string | null;
        seller: string | null;
      }> = [];

      const seen = new Set<string>();

      if (hc) {
        // 從 .rt-product-card 提取
        const cards = document.querySelectorAll(".rt-product-card");
        for (const card of cards) {
          const linkEl =
            card.querySelector<HTMLAnchorElement>(".rt-product-card-img-link") ||
            card.querySelector<HTMLAnchorElement>(".rt-product-card-name-wrap") ||
            card.querySelector<HTMLAnchorElement>('a[href*="/item/"]');
          const href = linkEl?.href || "";
          const idMatch = href.match(/\/item\/(\d+)/);
          if (!idMatch || seen.has(idMatch[1])) continue;
          seen.add(idMatch[1]);

          const nameEl = card.querySelector(".rt-product-card-name");
          const title = nameEl?.textContent?.trim() || "";
          if (!title) continue;

          const priceEl = card.querySelector(".rt-text-price");
          let price: number | null = null;
          if (priceEl) {
            const p = parseFloat(priceEl.textContent?.replace(/[^0-9.]/g, "") || "");
            if (!isNaN(p) && p > 0) price = p;
          }

          const img = card.querySelector<HTMLImageElement>(".rt-product-card-img");
          results.push({
            platformId: idMatch[1],
            title,
            price,
            url: href,
            imageUrl: img?.src || img?.getAttribute("data-src") || null,
            seller: null,
          });
        }
      }

      // 通用 a[href*="/item/"] fallback
      if (results.length === 0) {
        const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/item/"]');
        for (const link of links) {
          const href = link.href;
          const idMatch = href.match(/\/item\/(\d+)/);
          if (!idMatch || seen.has(idMatch[1])) continue;
          seen.add(idMatch[1]);

          const card = link.closest("div") || link;
          const img = card.querySelector<HTMLImageElement>("img");
          const title = img?.alt?.trim() || link.title?.trim() || link.textContent?.trim() || "";
          if (!title || title.length < 2) continue;

          const priceEl = card.querySelector('[class*="price"]');
          let price: number | null = null;
          if (priceEl) {
            const p = parseFloat(priceEl.textContent?.replace(/[^0-9.]/g, "") || "");
            if (!isNaN(p) && p > 0) price = p;
          }

          results.push({
            platformId: idMatch[1],
            title,
            price,
            url: href,
            imageUrl: img?.src || img?.getAttribute("data-src") || null,
            seller: null,
          });
        }
      }

      return results;
    },
    { hasCards }
  );

  return products;
}

export async function scrapeRuten(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  console.log(`[露天] 開始爬取: ${url}`);

  // 策略一：攔截 API 回應
  console.log("[露天] 嘗試攔截 API 回應...");
  const apiProducts = await interceptApiResponse(page, url);
  if (apiProducts.length > 0) return apiProducts;

  // 策略二：DOM fallback
  console.log("[露天] API 攔截無結果，嘗試 DOM 提取...");
  const domProducts = await extractFromDom(page);
  if (domProducts.length > 0) {
    console.log(`[露天] DOM 提取成功，共 ${domProducts.length} 件商品`);
    return domProducts;
  }

  // 除錯資訊
  const pageTitle = await page.title();
  const bodyText = await page.evaluate(
    () => document.body?.innerText?.substring(0, 300) || ""
  );
  console.warn(`[露天] 未抓到任何商品`);
  console.warn(`[露天] 頁面標題: ${pageTitle}`);
  console.warn(`[露天] 頁面片段: ${bodyText.substring(0, 200)}`);
  return [];
}
