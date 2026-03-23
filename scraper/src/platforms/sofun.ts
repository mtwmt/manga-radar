import type { Page } from "playwright";
import type { ScrapedProduct } from "../types";

/**
 * 蚤樂趣 SoFun 二手交易網站爬蟲
 *
 * 傳統 PHP 頁面，商品以 table 呈現，圖片使用 img.itemcate（非 lazyload）
 */

const BASE_URL = "https://www.sofun.com.tw";

/** 爬取單一頁面 */
async function scrapeSinglePage(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // 等待商品載入
  try {
    await page.waitForSelector('a[id^="apromo_"]', { timeout: 10000 });
  } catch {
    console.warn("[蚤樂趣] 等待商品列表逾時");
    return [];
  }

  const products = await page.evaluate((baseUrl: string) => {
    const results: Array<{
      platformId: string;
      title: string;
      price: number | null;
      url: string;
      imageUrl: string | null;
      seller: string | null;
    }> = [];

    const promoLinks = document.querySelectorAll<HTMLAnchorElement>('a[id^="apromo_"]');

    for (const link of promoLinks) {
      // 商品 ID：從 href 的 mitem 參數取得
      const href = link.getAttribute("href") || "";
      const itemId = new URLSearchParams(href.split("?")[1] || "").get("mitem") || "";
      if (!itemId) continue;

      // 找到包含此連結的 td 容器
      const container = link.closest("td");
      if (!container) continue;

      // 標題
      const titleEl = container.querySelector<HTMLAnchorElement>("a.item");
      const title = titleEl?.textContent?.trim() || "";
      if (!title) continue;

      // 價格
      const priceEl = container.querySelector<HTMLSpanElement>("span.price");
      const priceText = priceEl?.textContent?.replace(/[^0-9.]/g, "") || "";
      const price = priceText ? Number(priceText) : null;

      // 圖片：使用 img.itemcate 的 src（不是 data-original）
      // 每個商品有 2 張（正面 _1s、背面 _2s），只取第一張
      const img = container.querySelector<HTMLImageElement>("img.itemcate");
      let imageUrl: string | null = null;
      const imgSrc = img?.getAttribute("src") || "";
      if (imgSrc) {
        // 相對路徑 ../image/20260323/6806081165_1s.jpg?tm=xxx → 絕對 URL
        // 去掉 query string，去掉 ../，加上 base URL
        const cleanPath = imgSrc.split("?")[0].replace(/^\.\.\//, "");
        imageUrl = `${baseUrl}/${cleanPath}`;
      }

      // 沒有圖片的商品跳過
      if (!imageUrl) continue;

      // 商品連結
      const productUrl = `${baseUrl}/usedcust/itemdesc.php?mitem=${itemId}`;

      // 賣家
      const sellerEl = container.querySelector<HTMLAnchorElement>("a.cates");
      const seller = sellerEl?.textContent?.trim() || null;

      results.push({
        platformId: itemId,
        title,
        price,
        url: productUrl,
        imageUrl,
        seller,
      });
    }

    return results;
  }, BASE_URL);

  return products;
}

/**
 * 蚤樂趣爬蟲（多頁爬取）
 *
 * 爬取前 MAX_PAGES 頁，以 platformId 去重。
 */
export async function scrapeSofun(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  const MAX_PAGES = 3;
  console.log(`[蚤樂趣] 開始爬取（最多 ${MAX_PAGES} 頁）: ${url}`);

  const allProducts: ScrapedProduct[] = [];
  const seenIds = new Set<string>();

  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    // 組合分頁 URL
    const separator = url.includes("?") ? "&" : "?";
    const pageUrl = pg === 1 ? url : `${url}${separator}npg=${pg}`;

    console.log(`[蚤樂趣] 爬取第 ${pg}/${MAX_PAGES} 頁: ${pageUrl}`);

    // 頁間隨機延遲（第一頁不需要）
    if (pg > 1) {
      const delay = Math.floor(Math.random() * 2000) + 1000; // 1-3 秒
      console.log(`[蚤樂趣] 等待 ${delay}ms 後爬取下一頁...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const pageProducts = await scrapeSinglePage(page, pageUrl);

      if (pageProducts.length === 0) {
        console.log(`[蚤樂趣] 第 ${pg} 頁沒有商品，停止翻頁`);
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
        `[蚤樂趣] 第 ${pg} 頁取得 ${pageProducts.length} 件，新增 ${newCount} 件（累計 ${allProducts.length} 件）`
      );

      if (newCount === 0) {
        console.log(`[蚤樂趣] 第 ${pg} 頁全部重複，停止翻頁`);
        break;
      }
    } catch (error) {
      console.error(`[蚤樂趣] 第 ${pg} 頁爬取失敗，跳過:`, error);
      continue;
    }
  }

  console.log(`[蚤樂趣] 多頁爬取完成，共 ${allProducts.length} 件不重複商品`);
  return allProducts;
}
