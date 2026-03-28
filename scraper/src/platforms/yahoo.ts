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

      // 商品卡片：Yahoo 拍賣的 <a> 直接放在 <ul> 裡，不包在 <li> 中
      // 所以用 link 本身作為卡片範圍，避免 closest('div') 跳到整個列表容器
      const card = link.closest("li") || link;

      // 標題：優先從 img alt 取（Yahoo 會把完整標題放在圖片 alt），
      // 其次從商品標題 span 取，最後 fallback 到連結文字
      const imgEl = card.querySelector<HTMLImageElement>("img[alt]");
      const titleEl =
        card.querySelector("h3, h4") ||
        card.querySelector("span[class*='1drl28c']");
      const title =
        imgEl?.alt?.trim() ||
        titleEl?.textContent?.trim() ||
        link.textContent?.trim() ||
        "";

      // 價格：Yahoo 拍賣價格在 class 含 sc-1drl28c-5 的 div 或含 $ 的元素中
      let price: number | null = null;
      const allEls = card.querySelectorAll("div, span");
      for (const el of allEls) {
        const t = el.textContent?.trim() || "";
        // 匹配 $數字 格式且不含太多其他文字（避免抓到整個卡片文字）
        if (/^\$[\d,.]+$/.test(t)) {
          const num = Number(t.replace(/[^0-9.]/g, ""));
          if (!isNaN(num) && num > 0) {
            price = num;
            break;
          }
        }
      }

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

/** 爬取單一頁面的商品（JSON 優先，DOM fallback） */
async function scrapeSinglePage(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // 等待頁面 React 渲染完成
  await page.waitForLoadState("networkidle").catch(() => {
    console.warn("[Yahoo] networkidle 等待逾時，繼續嘗試提取");
  });

  // 策略一：從嵌入的 JSON 提取
  const products = await extractFromEmbeddedJson(page);

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

/**
 * Yahoo 拍賣爬蟲（多頁爬取）
 *
 * 爬取前 MAX_PAGES 頁，優先從頁面嵌入的 JSON（ecsearch 物件）中提取資料，
 * 若失敗則 fallback 到 DOM selector 解析。以 platformId 去重。
 */
export async function scrapeYahoo(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  const MAX_PAGES = 3;
  console.log(`[Yahoo] 開始爬取（最多 ${MAX_PAGES} 頁）: ${url}`);

  const allProducts: ScrapedProduct[] = [];
  const seenIds = new Set<string>();

  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    // 組合分頁 URL
    const separator = url.includes("?") ? "&" : "?";
    const pageUrl = pg === 1 ? url : `${url}${separator}pg=${pg}`;

    console.log(`[Yahoo] 爬取第 ${pg}/${MAX_PAGES} 頁: ${pageUrl}`);

    // 頁間隨機延遲（第一頁不需要）
    if (pg > 1) {
      const delay = Math.floor(Math.random() * 2000) + 1000; // 1-3 秒
      console.log(`[Yahoo] 等待 ${delay}ms 後爬取下一頁...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const pageProducts = await scrapeSinglePage(page, pageUrl);

      if (pageProducts.length === 0) {
        console.log(`[Yahoo] 第 ${pg} 頁沒有商品，停止翻頁`);
        break;
      }

      // 以 platformId 去重後加入結果
      let newCount = 0;
      for (const product of pageProducts) {
        if (!seenIds.has(product.platformId)) {
          seenIds.add(product.platformId);
          allProducts.push(product);
          newCount++;
        }
      }

      console.log(
        `[Yahoo] 第 ${pg} 頁取得 ${pageProducts.length} 件，新增 ${newCount} 件（累計 ${allProducts.length} 件）`
      );

      // 如果本頁新增數量為 0，代表已經重複，停止翻頁
      if (newCount === 0) {
        console.log(`[Yahoo] 第 ${pg} 頁全部重複，停止翻頁`);
        break;
      }
    } catch (error) {
      console.error(`[Yahoo] 第 ${pg} 頁爬取失敗，跳過:`, error);
      // 單頁失敗不影響其他頁
      continue;
    }
  }

  console.log(`[Yahoo] 多頁爬取完成，共 ${allProducts.length} 件不重複商品`);
  return allProducts;
}
