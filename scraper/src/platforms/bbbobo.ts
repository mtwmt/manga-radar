import type { Page } from "playwright";
import type { ScrapedProduct } from "../types";

/**
 * 跳蚤本舖 bbbobo 二手交易網站爬蟲
 *
 * 需要 JavaScript 渲染（Playwright），使用 networkidle 等待。
 */

const BASE_URL = "https://www.bbbobo.com.tw";

/** 爬取單一頁面 */
async function scrapeSinglePage(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  await page.goto(url, {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // 等待商品列表載入
  try {
    await page.waitForSelector(".pr-info", { timeout: 10000 });
  } catch {
    console.warn("[跳蚤本舖] 等待商品列表逾時");
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

    const items = document.querySelectorAll<HTMLElement>(".pr-info");

    for (const item of items) {
      // 商品 ID
      const gid = item.getAttribute("gid") || "";
      const aid = item.getAttribute("aid") || "";
      if (!gid) continue;

      // 標題：從 .pr-name 的 title 屬性取得（比 textContent 更完整）
      const nameEl = item.querySelector<HTMLElement>(".pr-name");
      const title = nameEl?.getAttribute("title")?.trim() || nameEl?.textContent?.trim() || "";
      if (!title) continue;

      // 價格
      const priceEl = item.querySelector<HTMLElement>(".pr-price-org");
      const priceText = priceEl?.textContent?.replace(/[^0-9.]/g, "") || "";
      const price = priceText ? Number(priceText) : null;

      // 圖片
      const img = item.querySelector<HTMLImageElement>(".listimg img");
      let imageUrl: string | null = null;
      const imgSrc = img?.getAttribute("src") || "";
      if (imgSrc) {
        imageUrl = imgSrc.startsWith("/") ? `${baseUrl}${imgSrc}` : imgSrc;
      }

      // 沒有圖片的商品跳過
      if (!imageUrl) continue;

      // 商品連結
      const productUrl = `${baseUrl}/shop/0/Goods.asp?AID=${aid}&GID=${gid}`;

      // 賣家/店舖
      const shopEl = item.querySelector<HTMLElement>(".shop-name");
      const seller = shopEl?.textContent?.trim() || null;

      results.push({
        platformId: gid,
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
 * 跳蚤本舖爬蟲（多頁爬取）
 *
 * 爬取前 MAX_PAGES 頁，以 platformId 去重。
 */
export async function scrapeBbbobo(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  const MAX_PAGES = 3;
  console.log(`[跳蚤本舖] 開始爬取（最多 ${MAX_PAGES} 頁）: ${url}`);

  const allProducts: ScrapedProduct[] = [];
  const seenIds = new Set<string>();

  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    // 組合分頁 URL
    const separator = url.includes("?") ? "&" : "?";
    const pageUrl = pg === 1 ? url : `${url}${separator}Page=${pg}`;

    console.log(`[跳蚤本舖] 爬取第 ${pg}/${MAX_PAGES} 頁: ${pageUrl}`);

    // 頁間隨機延遲（第一頁不需要）
    if (pg > 1) {
      const delay = Math.floor(Math.random() * 2000) + 1000; // 1-3 秒
      console.log(`[跳蚤本舖] 等待 ${delay}ms 後爬取下一頁...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const pageProducts = await scrapeSinglePage(page, pageUrl);

      if (pageProducts.length === 0) {
        console.log(`[跳蚤本舖] 第 ${pg} 頁沒有商品，停止翻頁`);
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
        `[跳蚤本舖] 第 ${pg} 頁取得 ${pageProducts.length} 件，新增 ${newCount} 件（累計 ${allProducts.length} 件）`
      );

      if (newCount === 0) {
        console.log(`[跳蚤本舖] 第 ${pg} 頁全部重複，停止翻頁`);
        break;
      }
    } catch (error) {
      console.error(`[跳蚤本舖] 第 ${pg} 頁爬取失敗，跳過:`, error);
      continue;
    }
  }

  console.log(`[跳蚤本舖] 多頁爬取完成，共 ${allProducts.length} 件不重複商品`);
  return allProducts;
}
