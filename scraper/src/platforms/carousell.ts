import type { Page } from "playwright";
import type { ScrapedProduct } from "../types";

/**
 * 旋轉拍賣 (Carousell) 爬蟲
 *
 * 策略一：攔截 API 回應（Carousell SPA 會呼叫搜尋 API）
 * 策略二：從 __NEXT_DATA__ JSON 提取
 * 策略三：DOM fallback
 *
 * 注意：Carousell 使用 Cloudflare 防護，需等待挑戰完成
 */

const BASE_URL = "https://tw.carousell.com";
const LOG_PREFIX = "[旋轉]";

/** 隨機延遲（毫秒） */
function randomDelay(min = 800, max = 2000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractProductId(url: string): string {
  const match = url.match(/\/p\/.*?(\d{6,})\/?$/);
  if (match) return match[1];
  const slugMatch = url.match(/\/p\/([^/?]+)/);
  if (slugMatch) return slugMatch[1];
  return url;
}

interface CarousellApiListing {
  id?: string | number;
  listingID?: string | number;
  listing_id?: string | number;
  title?: string;
  price?: string | number;
  imageUrl?: string;
  photo?: string;
  photos?: Array<string | { url?: string; thumbnail?: string }>;
  seller?: string;
  sellerName?: string;
  username?: string;
  owner?: { username?: string; name?: string };
  url?: string;
  listingUrl?: string;
  belowOriginalPrice?: number;
  originalPrice?: number;
}

/** 檢查是否為 Cloudflare 挑戰頁面 */
function isCloudflareChallenge(title: string): boolean {
  const patterns = ["Just a moment", "請稍候", "请稍候", "Checking", "Verify"];
  return patterns.some((p) => title.includes(p));
}

/** 等待 Cloudflare 挑戰完成（支援英文與中文版） */
async function waitForCloudflare(page: Page): Promise<boolean> {
  const title = await page.title();
  if (!isCloudflareChallenge(title)) return true;

  console.log(`${LOG_PREFIX} 偵測到 Cloudflare 挑戰（${title}），等待中...`);

  try {
    // 等待頁面標題不再是任何 Cloudflare 挑戰頁
    await page.waitForFunction(
      (patterns: string[]) =>
        !patterns.some((p) => document.title.includes(p)),
      ["Just a moment", "請稍候", "请稍候", "Checking", "Verify"],
      { timeout: 30000 }
    );

    console.log(`${LOG_PREFIX} Cloudflare 第一層通過，檢查是否有第二層...`);
    await randomDelay(2000, 3000);

    // 再次檢查（可能有多層挑戰）
    const newTitle = await page.title();
    if (isCloudflareChallenge(newTitle)) {
      console.log(`${LOG_PREFIX} 偵測到第二層挑戰（${newTitle}），繼續等待...`);
      await page.waitForFunction(
        (patterns: string[]) =>
          !patterns.some((p) => document.title.includes(p)),
        ["Just a moment", "請稍候", "请稍候", "Checking", "Verify"],
        { timeout: 30000 }
      );
      await randomDelay(2000, 3000);
    }

    const finalTitle = await page.title();
    if (isCloudflareChallenge(finalTitle)) {
      console.warn(`${LOG_PREFIX} Cloudflare 挑戰仍未通過: ${finalTitle}`);
      return false;
    }

    console.log(`${LOG_PREFIX} Cloudflare 挑戰通過，頁面標題: ${finalTitle}`);
    return true;
  } catch {
    const currentTitle = await page.title().catch(() => "unknown");
    console.warn(`${LOG_PREFIX} Cloudflare 挑戰等待逾時: ${currentTitle}`);
    return false;
  }
}

/**
 * 策略一：攔截 API 回應
 * Carousell SPA 載入時會呼叫搜尋 API
 */
async function interceptApiResponse(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  const products: ScrapedProduct[] = [];

  const apiPromise = new Promise<CarousellApiListing[]>((resolve) => {
    let resolved = false;

    page.on("response", async (response) => {
      if (resolved) return;
      const reqUrl = response.url();

      // Carousell 搜尋 API
      if (
        reqUrl.includes("carousell.com") &&
        (reqUrl.includes("/search/") ||
          reqUrl.includes("/listing") ||
          reqUrl.includes("/products"))
      ) {
        try {
          const contentType = response.headers()["content-type"] || "";
          if (!contentType.includes("json") && !contentType.includes("grpc"))
            return;

          const json = await response.json();

          // 嘗試從不同結構中取得商品列表
          const listings =
            json.data?.results ||
            json.data?.listings ||
            json.results ||
            json.listings ||
            json.data?.searchResults ||
            json.searchResults ||
            json.items;

          if (Array.isArray(listings) && listings.length > 0) {
            resolved = true;
            resolve(listings);
          }
        } catch {
          // 非 JSON，忽略
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

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // 等待 Cloudflare 挑戰
  const passed = await waitForCloudflare(page);
  if (!passed) return [];

  await page.waitForLoadState("networkidle").catch(() => {
    console.warn(`${LOG_PREFIX} networkidle 等待逾時`);
  });

  const rows = await apiPromise;

  if (rows.length > 0) {
    console.log(`${LOG_PREFIX} API 攔截成功，共 ${rows.length} 件商品`);
    return rows
      .map((item) => {
        const listing = item as CarousellApiListing;
        const id = String(
          listing.listingID || listing.listing_id || listing.id || ""
        );
        const title = listing.title || "";
        if (!id || !title) return null;

        let price: number | null = null;
        if (listing.price !== undefined && listing.price !== null) {
          const p =
            typeof listing.price === "number"
              ? listing.price
              : parseFloat(String(listing.price).replace(/[^0-9.]/g, ""));
          if (!isNaN(p) && p >= 0) price = p;
        }

        let imageUrl: string | null = null;
        if (listing.imageUrl) imageUrl = listing.imageUrl;
        else if (listing.photo) imageUrl = listing.photo;
        else if (listing.photos && listing.photos.length > 0) {
          const first = listing.photos[0];
          imageUrl =
            typeof first === "string"
              ? first
              : first?.url || first?.thumbnail || null;
        }

        const seller =
          listing.sellerName ||
          listing.seller ||
          listing.username ||
          listing.owner?.username ||
          listing.owner?.name ||
          null;

        let productUrl = "";
        if (listing.url) {
          productUrl = listing.url.startsWith("http")
            ? listing.url
            : `${BASE_URL}${listing.url}`;
        } else if (listing.listingUrl) {
          productUrl = listing.listingUrl.startsWith("http")
            ? listing.listingUrl
            : `${BASE_URL}${listing.listingUrl}`;
        } else if (id) {
          productUrl = `${BASE_URL}/p/${id}/`;
        }

        return {
          platformId: id,
          title,
          price,
          url: productUrl,
          imageUrl,
          seller,
        };
      })
      .filter((p): p is ScrapedProduct => p !== null);
  }

  return [];
}

/**
 * 策略二：從 __NEXT_DATA__ 或 inline script JSON 提取
 */
async function extractFromJson(page: Page): Promise<ScrapedProduct[]> {
  const rawListings = await page.evaluate(() => {
    // 方法 1：__NEXT_DATA__
    const nextDataEl = document.querySelector("#__NEXT_DATA__");
    if (nextDataEl?.textContent) {
      try {
        const data = JSON.parse(nextDataEl.textContent);
        const pageProps = data?.props?.pageProps;
        if (pageProps) {
          const keys = [
            "listings",
            "listingCards",
            "products",
            "searchResults",
            "results",
            "items",
            "categoryListings",
          ];

          function findListings(
            obj: Record<string, unknown>,
            depth = 0
          ): unknown[] | null {
            if (depth > 5 || !obj || typeof obj !== "object") return null;
            for (const key of keys) {
              if (Array.isArray(obj[key]) && obj[key].length > 0)
                return obj[key] as unknown[];
            }
            for (const value of Object.values(obj)) {
              if (value && typeof value === "object" && !Array.isArray(value)) {
                const found = findListings(
                  value as Record<string, unknown>,
                  depth + 1
                );
                if (found) return found;
              }
            }
            return null;
          }

          const listings = findListings(pageProps);
          if (listings && listings.length > 0) return listings;
        }
      } catch {
        // 忽略
      }
    }

    // 方法 2：搜尋 inline scripts
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      if (text.length < 100 || text.length > 500000) continue;
      if (
        !text.includes("listing") &&
        !text.includes("product") &&
        !text.includes("carousell.com/p/")
      )
        continue;

      try {
        const jsonStart = text.indexOf("[{");
        if (jsonStart === -1) continue;

        let depth = 0;
        let arrayEnd = -1;
        for (
          let i = jsonStart;
          i < Math.min(text.length, jsonStart + 200000);
          i++
        ) {
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
        const parsed = JSON.parse(text.slice(jsonStart, arrayEnd + 1));
        if (
          Array.isArray(parsed) &&
          parsed.length > 2 &&
          parsed[0] &&
          typeof parsed[0] === "object" &&
          ("title" in parsed[0] ||
            "price" in parsed[0] ||
            "listingID" in parsed[0])
        ) {
          return parsed;
        }
      } catch {
        continue;
      }
    }

    return null;
  });

  if (!rawListings || rawListings.length === 0) return [];

  return (rawListings as CarousellApiListing[])
    .map((listing) => {
      const id = String(
        listing.listingID || listing.listing_id || listing.id || ""
      );
      const title = listing.title || "";
      if (!id || !title) return null;

      let price: number | null = null;
      if (listing.price !== undefined && listing.price !== null) {
        const p =
          typeof listing.price === "number"
            ? listing.price
            : parseFloat(String(listing.price).replace(/[^0-9.]/g, ""));
        if (!isNaN(p) && p >= 0) price = p;
      }

      let imageUrl: string | null = null;
      if (listing.imageUrl) imageUrl = listing.imageUrl;
      else if (listing.photo) imageUrl = listing.photo;
      else if (listing.photos && listing.photos.length > 0) {
        const first = listing.photos[0];
        imageUrl =
          typeof first === "string"
            ? first
            : first?.url || first?.thumbnail || null;
      }

      const seller =
        listing.sellerName ||
        listing.seller ||
        listing.username ||
        listing.owner?.username ||
        listing.owner?.name ||
        null;

      let productUrl = "";
      if (listing.url) {
        productUrl = listing.url.startsWith("http")
          ? listing.url
          : `${BASE_URL}${listing.url}`;
      } else if (listing.listingUrl) {
        productUrl = listing.listingUrl.startsWith("http")
          ? listing.listingUrl
          : `${BASE_URL}${listing.listingUrl}`;
      } else if (id) {
        productUrl = `${BASE_URL}/p/${id}/`;
      }

      return { platformId: id, title, price, url: productUrl, imageUrl, seller };
    })
    .filter((p): p is ScrapedProduct => p !== null);
}

/**
 * 策略三：DOM fallback
 */
async function extractFromDom(page: Page): Promise<ScrapedProduct[]> {
  // 捲動觸發懶載入
  for (const fraction of [0.33, 0.66, 1]) {
    await page.evaluate(
      (f) => window.scrollTo(0, document.body.scrollHeight * f),
      fraction
    );
    await randomDelay(400, 800);
  }

  try {
    await page.waitForSelector('a[href*="/p/"]', { timeout: 10000 });
  } catch {
    console.warn(`${LOG_PREFIX} 等待商品連結逾時`);
    return [];
  }

  return page.evaluate(({ baseUrl }) => {
    const results: Array<{
      platformId: string;
      title: string;
      price: number | null;
      url: string;
      imageUrl: string | null;
      seller: string | null;
    }> = [];

    const seen = new Set<string>();
    const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"]');

    for (const link of links) {
      const href = link.href;
      const idMatch = href.match(/\/p\/.*?(\d{6,})\/?$/);
      if (!idMatch || seen.has(idMatch[1])) continue;
      seen.add(idMatch[1]);

      const card =
        link.closest('[data-testid*="listing"]') ||
        link.closest("li") ||
        link.parentElement?.parentElement?.parentElement ||
        link;

      // 標題
      let title = "";
      const titleEl = card.querySelector(
        '[data-testid*="title"], [data-testid*="name"]'
      );
      if (titleEl) title = titleEl.textContent?.trim() || "";
      if (!title) {
        const img = card.querySelector<HTMLImageElement>("img");
        if (img?.alt && img.alt.length > 2) title = img.alt.trim();
      }
      if (!title)
        title =
          link.getAttribute("title") || link.getAttribute("aria-label") || "";
      if (!title || title.length < 2) continue;

      // 價格
      let price: number | null = null;
      const allText = card.querySelectorAll("p, span, div");
      for (const el of allText) {
        const text = el.textContent?.trim() || "";
        const priceMatch = text.match(/(?:NT\$?\s*|＄\s*|\$\s*)([0-9,]+)/);
        if (priceMatch) {
          const p = parseFloat(priceMatch[1].replace(/,/g, ""));
          if (!isNaN(p) && p > 0) {
            price = p;
            break;
          }
        }
      }

      // 圖片
      const img = card.querySelector<HTMLImageElement>("img");
      const imageUrl =
        img?.src || img?.getAttribute("data-src") || null;

      results.push({
        platformId: idMatch[1],
        title,
        price,
        url: href.startsWith("http") ? href : `${baseUrl}${href}`,
        imageUrl,
        seller: null,
      });
    }

    return results;
  }, { baseUrl: BASE_URL });
}

export async function scrapeCarousell(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  console.log(`${LOG_PREFIX} 開始爬取: ${url}`);

  // 策略一：攔截 API 回應（同時處理 Cloudflare）
  console.log(`${LOG_PREFIX} 嘗試攔截 API 回應...`);
  const apiProducts = await interceptApiResponse(page, url);
  if (apiProducts.length > 0) return apiProducts;

  // 策略二：從 JSON 提取
  console.log(`${LOG_PREFIX} 嘗試從嵌入 JSON 提取...`);
  const jsonProducts = await extractFromJson(page);
  if (jsonProducts.length > 0) {
    console.log(
      `${LOG_PREFIX} JSON 提取成功，共 ${jsonProducts.length} 件商品`
    );
    return jsonProducts;
  }

  // 策略三：DOM fallback
  console.log(`${LOG_PREFIX} 嘗試 DOM 提取...`);
  const domProducts = await extractFromDom(page);
  if (domProducts.length > 0) {
    console.log(
      `${LOG_PREFIX} DOM 提取成功，共 ${domProducts.length} 件商品`
    );
    return domProducts;
  }

  // 除錯資訊
  const pageTitle = await page.title();
  const bodyText = await page.evaluate(
    () => document.body?.innerText?.substring(0, 300) || ""
  );
  console.warn(`${LOG_PREFIX} 未抓到任何商品`);
  console.warn(`${LOG_PREFIX} 頁面標題: ${pageTitle}`);
  console.warn(`${LOG_PREFIX} 頁面片段: ${bodyText.substring(0, 200)}`);
  return [];
}
