import type { Page } from "playwright";
import type { ScrapedProduct } from "../types";

/**
 * iOPEN Mall 爬蟲
 *
 * 傳統 PHP 商城，商品以 div.pic-pds-default01 卡片呈現。
 * 圖片使用 lazyload（data-original），分頁透過 page= 參數。
 */

/** 爬取單一頁面 */
async function scrapeSinglePage(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // 等待商品卡片載入
  try {
    await page.waitForSelector(".pic-pds-default01", { timeout: 10000 });
  } catch {
    console.warn("[iOPEN Mall] 等待商品列表逾時");
    return [];
  }

  // 滾動觸發 lazyload 圖片
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 1000));

  const products = await page.evaluate(() => {
    const results: Array<{
      platformId: string;
      title: string;
      price: number | null;
      url: string;
      imageUrl: string | null;
      seller: string | null;
    }> = [];

    const cards = document.querySelectorAll(".pic-pds-default01");

    for (const card of cards) {
      // 商品連結 & ID
      const linkEl = card.querySelector<HTMLAnchorElement>(
        ".pic-pds-infobox h2 a"
      );
      if (!linkEl) continue;

      const href = linkEl.href;
      const prodNoMatch = href.match(/prod_no=(P\d+)/);
      if (!prodNoMatch) continue;

      const platformId = prodNoMatch[1];

      // 標題
      const title = linkEl.textContent?.trim() || "";
      if (!title) continue;

      // 售價
      const priceEl = card.querySelector(".pic-pds-price_02");
      let price: number | null = null;
      if (priceEl) {
        const priceText =
          priceEl.textContent?.replace(/[^0-9.]/g, "") || "";
        const p = parseFloat(priceText);
        if (!isNaN(p) && p > 0) price = p;
      }

      // 圖片（data-original 或 src）
      const img = card.querySelector<HTMLImageElement>(".pic-pds-imgbox img");
      const imageUrl =
        img?.getAttribute("data-original") || img?.src || null;

      // 商品 URL
      const productUrl = href.startsWith("http")
        ? href
        : `https://mall.iopenmall.tw${href}`;

      results.push({
        platformId,
        title,
        price,
        url: productUrl,
        imageUrl,
        seller: null,
      });
    }

    return results;
  });

  return products;
}

/**
 * iOPEN Mall 爬蟲（多頁爬取）
 */
export async function scrapeIopenmall(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  const MAX_PAGES = 3;
  console.log(`[iOPEN Mall] 開始爬取（最多 ${MAX_PAGES} 頁）: ${url}`);

  const allProducts: ScrapedProduct[] = [];
  const seenIds = new Set<string>();

  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    // 組合分頁 URL：page= 參數
    const pageUrl = pg === 1 ? url : url.replace(/page=[^&]*/, `page=${pg}`);

    console.log(`[iOPEN Mall] 爬取第 ${pg}/${MAX_PAGES} 頁`);

    if (pg > 1) {
      const delay = Math.floor(Math.random() * 2000) + 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const pageProducts = await scrapeSinglePage(page, pageUrl);

      if (pageProducts.length === 0) {
        console.log(`[iOPEN Mall] 第 ${pg} 頁沒有商品，停止翻頁`);
        break;
      }

      let newCount = 0;
      for (const product of pageProducts) {
        if (!seenIds.has(product.platformId)) {
          seenIds.add(product.platformId);
          allProducts.push(product);
          newCount++;
        }
      }

      console.log(
        `[iOPEN Mall] 第 ${pg} 頁取得 ${pageProducts.length} 件，新增 ${newCount} 件（累計 ${allProducts.length} 件）`
      );

      if (newCount === 0) {
        console.log(`[iOPEN Mall] 第 ${pg} 頁全部重複，停止翻頁`);
        break;
      }
    } catch (error) {
      console.error(`[iOPEN Mall] 第 ${pg} 頁爬取失敗，跳過:`, error);
      continue;
    }
  }

  console.log(`[iOPEN Mall] 完成，共 ${allProducts.length} 件不重複商品`);
  return allProducts;
}
