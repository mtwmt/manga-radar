import type { Page } from "playwright";
import type { ScrapedProduct } from "../types";

/** 隨機延遲（毫秒），避免被封鎖 */
function randomDelay(min = 800, max = 2000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 從商品 URL 中提取平台商品 ID
 * 範例 URL: https://tw.bid.yahoo.com/item/xxxxx
 */
function extractProductId(itemUrl: string): string {
  // Yahoo 拍賣商品 URL 格式：/item/{productId}
  const match = itemUrl.match(/\/item\/([a-zA-Z0-9]+)/);
  if (match) return match[1];

  // 備用：從 ec_productid 取得（在呼叫端處理）
  return itemUrl;
}

/** 嵌入 JSON 中單一商品的型別（僅列出需要的欄位） */
interface YahooHitItem {
  ec_productid?: string;
  ec_title?: string;
  ec_price?: string | number;
  ec_buyprice?: string | number;
  ec_image?: string;
  ec_item_url?: string;
  ec_seller?: string;
  ec_storename?: string;
  ec_multi_images?: Array<{ src?: string }>;
}

/**
 * 策略一：從頁面嵌入的 JSON（ecsearch 物件）中提取商品資料
 *
 * Yahoo 拍賣使用 React，商品資料以 JSON 格式嵌入在 <script> 標籤內，
 * 結構為 { search: { ecsearch: { hits: [...] } } }
 */
async function extractFromEmbeddedJson(
  page: Page
): Promise<ScrapedProduct[] | null> {
  try {
    const products = await page.evaluate(() => {
      // 遍歷所有 script 標籤，尋找包含 ecsearch 的 JSON 資料
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent || "";
        if (!text.includes("ecsearch") || !text.includes("ec_productid")) {
          continue;
        }

        // 嘗試找出 JSON 物件的起始位置
        // 頁面中的資料可能以多種方式嵌入
        const patterns = [
          // 模式 1：直接的 JSON 物件賦值
          /\{[^]*"ecsearch"\s*:\s*\{[^]*"hits"\s*:\s*\[/,
          // 模式 2：在 state 物件中
          /"search"\s*:\s*\{[^]*"ecsearch"/,
        ];

        for (const pattern of patterns) {
          if (!pattern.test(text)) continue;

          // 找出包含 ecsearch 的最外層 JSON
          // 策略：從 "ecsearch" 位置往前找 { ，往後找完整 hits 陣列
          const ecsearchIdx = text.indexOf('"ecsearch"');
          if (ecsearchIdx === -1) continue;

          // 找到 hits 陣列
          const hitsIdx = text.indexOf('"hits"', ecsearchIdx);
          if (hitsIdx === -1) continue;

          // 找到 hits 陣列的開始 [
          const arrayStart = text.indexOf("[", hitsIdx);
          if (arrayStart === -1) continue;

          // 手動匹配括號找到陣列結尾
          let depth = 0;
          let arrayEnd = -1;
          for (let i = arrayStart; i < text.length; i++) {
            if (text[i] === "[") depth++;
            else if (text[i] === "]") {
              depth--;
              if (depth === 0) {
                arrayEnd = i;
                break;
              }
            }
          }

          if (arrayEnd === -1) continue;

          const hitsJson = text.slice(arrayStart, arrayEnd + 1);
          try {
            const hits = JSON.parse(hitsJson) as Array<Record<string, unknown>>;
            return hits.map((item) => ({
              ec_productid: String(item.ec_productid || ""),
              ec_title: String(item.ec_title || ""),
              ec_price: item.ec_price,
              ec_buyprice: item.ec_buyprice,
              ec_image: String(item.ec_image || ""),
              ec_item_url: String(item.ec_item_url || ""),
              ec_seller: String(item.ec_seller || ""),
              ec_storename: String(item.ec_storename || ""),
            }));
          } catch {
            // JSON 解析失敗，繼續嘗試下一個模式
            continue;
          }
        }
      }
      return null;
    });

    if (!products || products.length === 0) return null;

    return products.map((item) => {
      const price = item.ec_buyprice || item.ec_price;
      const itemUrl = item.ec_item_url || "";
      const productId = item.ec_productid || extractProductId(itemUrl);

      return {
        platformId: String(productId),
        title: item.ec_title || "",
        price: price ? Number(price) : null,
        url: itemUrl.startsWith("http")
          ? itemUrl
          : `https://tw.bid.yahoo.com${itemUrl}`,
        imageUrl: item.ec_image || null,
        seller: item.ec_storename || item.ec_seller || null,
      };
    });
  } catch (error) {
    console.warn("[Yahoo] JSON 提取失敗，將使用 DOM fallback:", error);
    return null;
  }
}

/**
 * 策略二（Fallback）：透過 DOM selector 提取商品資料
 *
 * 當嵌入 JSON 無法取得時，直接從頁面 DOM 解析商品卡片
 */
async function extractFromDom(page: Page): Promise<ScrapedProduct[]> {
  // 等待商品列表載入（使用多個可能的 selector）
  try {
    await page.waitForSelector(
      'a[href*="/item/"], li[class*="item"], div[class*="ProductList"]',
      { timeout: 10000 }
    );
  } catch {
    console.warn("[Yahoo] 等待商品列表逾時");
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

    // 取得所有商品連結（Yahoo 拍賣商品 URL 包含 /item/）
    const links = document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/item/"]'
    );

    // 用 Set 過濾重複的商品連結
    const seen = new Set<string>();

    for (const link of links) {
      const href = link.href;
      if (!href || seen.has(href)) continue;

      // 提取商品 ID
      const idMatch = href.match(/\/item\/([a-zA-Z0-9]+)/);
      if (!idMatch) continue;

      seen.add(href);
      const productId = idMatch[1];

      // 在連結或其父元素中尋找商品資訊
      const card = link.closest("li") || link.closest("div") || link;

      // 標題：優先從 title 屬性取，其次從文字內容取
      const titleEl =
        card.querySelector("[title]") ||
        card.querySelector("h3, h4, span[class*='title'], div[class*='title']");
      const title =
        titleEl?.getAttribute("title") ||
        titleEl?.textContent?.trim() ||
        link.textContent?.trim() ||
        "";

      // 價格：找包含 $ 的元素
      const priceEl = card.querySelector(
        "span[class*='price'], div[class*='price'], em, b"
      );
      const priceText = priceEl?.textContent?.replace(/[^0-9.]/g, "") || "";
      const price = priceText ? Number(priceText) : null;

      // 圖片
      const img = card.querySelector<HTMLImageElement>("img");
      const imageUrl = img?.src || img?.getAttribute("data-src") || null;

      // 賣家
      const sellerEl = card.querySelector(
        "span[class*='seller'], div[class*='seller'], span[class*='store']"
      );
      const seller = sellerEl?.textContent?.trim() || null;

      if (title) {
        results.push({
          platformId: productId,
          title,
          price,
          url: href,
          imageUrl,
          seller,
        });
      }
    }

    return results;
  });

  return products;
}

/**
 * Yahoo 拍賣爬蟲
 *
 * 優先從頁面嵌入的 JSON（ecsearch 物件）中提取資料，
 * 若失敗則 fallback 到 DOM selector 解析。
 */
export async function scrapeYahoo(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  console.log(`[Yahoo] 開始爬取: ${url}`);

  // 加入隨機延遲，模擬人類行為
  await randomDelay(500, 1500);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // 等待頁面 React 渲染完成
  await page.waitForLoadState("networkidle").catch(() => {
    console.warn("[Yahoo] networkidle 等待逾時，繼續嘗試提取");
  });

  // 策略一：從嵌入的 JSON 提取
  console.log("[Yahoo] 嘗試從嵌入 JSON 提取商品資料...");
  let products = await extractFromEmbeddedJson(page);

  if (products && products.length > 0) {
    console.log(`[Yahoo] JSON 提取成功，共 ${products.length} 件商品`);
    return products;
  }

  // 策略二：DOM fallback
  console.log("[Yahoo] JSON 提取失敗，改用 DOM selector...");
  await randomDelay(300, 800);
  const domProducts = await extractFromDom(page);

  console.log(`[Yahoo] DOM 提取完成，共 ${domProducts.length} 件商品`);
  return domProducts;
}
