import type { Page } from "playwright";
import type { ScrapedProduct } from "../types";

/**
 * 露天拍賣爬蟲
 *
 * 露天是 Vue SPA，必須用 Playwright 等待 JS 渲染完成。
 * 商品卡片 class 前綴為 rt-product-card。
 * 商品 URL 格式：https://www.ruten.com.tw/item/{商品ID}/
 * 商品 ID 為純數字字串（通常 14~17 位）。
 */

/** 隨機延遲（毫秒），避免被偵測為爬蟲 */
function randomDelay(min = 500, max = 1500): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 策略一：從 .rt-product-card DOM 提取商品資料（主要策略）
 *
 * 露天商品卡片 DOM 結構：
 *   .search-result-container > .product-item > .rt-product-card
 *     ├── .rt-product-card-img-wrap
 *     │     ├── .rt-product-card-img-link  (A, 商品連結)
 *     │     └── .rt-product-card-img       (IMG, 商品圖片)
 *     └── .rt-product-card-detail-wrap
 *           ├── .rt-product-card-name-wrap (A, 商品連結)
 *           │     └── .rt-product-card-name (P, 商品標題)
 *           └── .rt-product-card-price-wrap
 *                 └── .rt-text-price        (SPAN, 價格數字)
 */
async function extractFromProductCards(
  page: Page
): Promise<ScrapedProduct[]> {
  // 等待商品卡片載入
  try {
    await page.waitForSelector(".rt-product-card", { timeout: 15000 });
  } catch {
    console.warn("[露天] 等待 .rt-product-card 載入逾時");
    return [];
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

    const cards = document.querySelectorAll(".rt-product-card");

    for (const card of cards) {
      // 商品連結與 ID
      const linkEl =
        card.querySelector<HTMLAnchorElement>(".rt-product-card-img-link") ||
        card.querySelector<HTMLAnchorElement>(".rt-product-card-name-wrap");
      const href = linkEl?.href || "";
      if (!href || !href.includes("/item/")) continue;

      const idMatch = href.match(/\/item\/(\d+)/);
      if (!idMatch) continue;
      const productId = idMatch[1];

      // 商品標題
      const nameEl = card.querySelector(".rt-product-card-name");
      const title = nameEl?.textContent?.trim() || "";
      if (!title) continue;

      // 價格：取第一個 .rt-text-price（有價格區間時取最低價）
      const priceEls = card.querySelectorAll(".rt-text-price");
      let price: number | null = null;
      if (priceEls.length > 0) {
        const priceText =
          priceEls[0].textContent?.replace(/[^0-9.]/g, "") || "";
        const parsed = parseFloat(priceText);
        if (!isNaN(parsed) && parsed > 0) price = parsed;
      }

      // 圖片
      const img = card.querySelector<HTMLImageElement>(
        ".rt-product-card-img"
      );
      const imageUrl =
        img?.src || img?.getAttribute("data-src") || null;

      // 賣家：露天分類列表頁不顯示賣家資訊
      const seller: string | null = null;

      results.push({
        platformId: productId,
        title,
        price,
        url: href,
        imageUrl,
        seller,
      });
    }

    return results;
  });

  return products;
}

/**
 * 策略二（Fallback）：透過通用 a[href*="/item/"] 提取商品資料
 *
 * 當 .rt-product-card 選擇器失效時（例如露天改版），
 * 從所有指向商品頁面的連結中提取商品資料。
 */
async function extractFromLinks(page: Page): Promise<ScrapedProduct[]> {
  const products = await page.evaluate(() => {
    const results: Array<{
      platformId: string;
      title: string;
      price: number | null;
      url: string;
      imageUrl: string | null;
      seller: string | null;
    }> = [];

    const links = document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/item/"]'
    );
    const seen = new Set<string>();

    for (const link of links) {
      const href = link.href;
      if (!href || seen.has(href)) continue;

      const idMatch = href.match(/\/item\/(\d+)/);
      if (!idMatch) continue;

      seen.add(href);
      const productId = idMatch[1];

      // 在連結或其父元素中尋找商品資訊
      const card =
        link.closest(".product-item") ||
        link.closest('[class*="card"]') ||
        link.closest("div") ||
        link;

      // 標題：優先從 img alt 取得，其次從連結文字
      const img = card.querySelector<HTMLImageElement>("img");
      const titleFromAlt = img?.alt?.trim() || "";
      const titleFromLink = link.textContent?.trim() || "";
      const titleFromTitle = link.title?.trim() || "";
      const title = titleFromAlt || titleFromTitle || titleFromLink;
      if (!title || title.length < 2) continue;

      // 價格
      const priceEl = card.querySelector(
        '[class*="price"], [class*="Price"]'
      );
      let price: number | null = null;
      if (priceEl) {
        const priceText =
          priceEl.textContent?.replace(/[^0-9.]/g, "") || "";
        const parsed = parseFloat(priceText);
        if (!isNaN(parsed) && parsed > 0) price = parsed;
      }

      // 圖片
      const imageUrl =
        img?.src || img?.getAttribute("data-src") || null;

      results.push({
        platformId: productId,
        title,
        price,
        url: href,
        imageUrl,
        seller: null,
      });
    }

    return results;
  });

  return products;
}

/**
 * 露天拍賣爬蟲主函式
 *
 * 優先使用 .rt-product-card DOM selector 提取商品資料，
 * 若失敗則 fallback 到通用的 a[href*="/item/"] 連結解析。
 *
 * @param page - Playwright Page 實例
 * @param url - 要爬取的分類/搜尋頁面 URL
 * @returns 爬取到的商品陣列
 */
export async function scrapeRuten(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  console.log(`[露天] 開始爬取: ${url}`);

  // 加入隨機延遲，模擬人類行為
  await randomDelay(500, 1500);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // 等待 SPA 渲染完成
  await page.waitForLoadState("networkidle").catch(() => {
    console.warn("[露天] networkidle 等待逾時，繼續嘗試提取");
  });

  // 額外等待讓 Vue 完成渲染
  await randomDelay(500, 1000);

  // 嘗試向下捲動以觸發懶載入
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight / 2);
  });
  await randomDelay(300, 600);
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await randomDelay(300, 600);

  // 策略一：從 .rt-product-card DOM 提取
  console.log("[露天] 嘗試從 .rt-product-card 提取商品資料...");
  const products = await extractFromProductCards(page);

  if (products.length > 0) {
    console.log(`[露天] DOM 提取成功，共 ${products.length} 件商品`);
    return products;
  }

  // 策略二：Fallback 到通用連結解析
  console.log("[露天] .rt-product-card 提取失敗，改用通用連結解析...");
  await randomDelay(300, 800);
  const fallbackProducts = await extractFromLinks(page);

  if (fallbackProducts.length > 0) {
    console.log(
      `[露天] Fallback 提取完成，共 ${fallbackProducts.length} 件商品`
    );
    return fallbackProducts;
  }

  // 完全沒抓到商品，印出頁面資訊以供除錯
  const pageTitle = await page.title();
  const bodyText = await page.evaluate(
    () => document.body?.innerText?.substring(0, 500) || ""
  );
  console.warn(`[露天] 未抓到任何商品`);
  console.warn(`[露天] 頁面標題: ${pageTitle}`);
  console.warn(`[露天] 頁面內容片段: ${bodyText.substring(0, 200)}`);

  return [];
}
