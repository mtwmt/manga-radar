import type { Page } from "playwright";
import type { ScrapedProduct } from "../types";

/**
 * 旋轉拍賣 (Carousell) 爬蟲
 *
 * Carousell 是 Next.js SSR 網站，商品資料可能以下列方式嵌入頁面：
 * 1. __NEXT_DATA__ JSON（Pages Router）
 * 2. self.__next_f.push() flight data（App Router，Next.js 13+）
 * 3. DOM 中的商品卡片（fallback）
 *
 * 商品頁 URL 格式：https://tw.carousell.com/p/{slug}-{productId}/
 */

const BASE_URL = "https://tw.carousell.com";
const LOG_PREFIX = "[旋轉]";

/** 隨機延遲（毫秒），避免被偵測為爬蟲 */
function randomDelay(min = 800, max = 2000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 從商品 URL 提取平台商品 ID
 * URL 格式：/p/{slug}-{productId}/
 * productId 通常是純數字
 */
function extractProductId(url: string): string {
  // 格式：/p/xxxxx-1234567890/
  const match = url.match(/\/p\/.*?(\d{6,})\/?$/);
  if (match) return match[1];

  // 備用：取 /p/ 後面整段 slug 作為 ID
  const slugMatch = url.match(/\/p\/([^/?]+)/);
  if (slugMatch) return slugMatch[1];

  return url;
}

/** __NEXT_DATA__ 中商品的型別（僅列出需要的欄位） */
interface CarousellListing {
  id?: string | number;
  listingID?: string | number;
  listing_id?: string | number;
  title?: string;
  price?: string | number;
  priceFormatted?: string;
  belowOriginalPrice?: number;
  originalPrice?: number;
  imageUrl?: string;
  photo?: string;
  photos?: Array<string | { url?: string; thumbnail?: string }>;
  seller?: string;
  sellerName?: string;
  username?: string;
  owner?: { username?: string; name?: string };
  url?: string;
  listingUrl?: string;
}

/**
 * 策略一：從 __NEXT_DATA__ JSON 提取商品資料
 *
 * Next.js Pages Router 會在 <script id="__NEXT_DATA__"> 中嵌入頁面資料，
 * 結構為 { props: { pageProps: { ... } } }
 */
async function extractFromNextData(
  page: Page
): Promise<ScrapedProduct[] | null> {
  try {
    const products = await page.evaluate(() => {
      // 方法 1：直接取 __NEXT_DATA__ script tag
      const nextDataEl = document.querySelector("#__NEXT_DATA__");
      if (nextDataEl?.textContent) {
        try {
          const data = JSON.parse(nextDataEl.textContent);
          const pageProps = data?.props?.pageProps;
          if (pageProps) {
            // Carousell 可能在不同的 key 下存放商品列表
            const possibleKeys = [
              "listings",
              "listingCards",
              "products",
              "searchResults",
              "results",
              "items",
              "categoryListings",
              "initialData",
            ];

            // 深度搜尋：遞迴尋找陣列形式的商品資料
            function findListings(
              obj: Record<string, unknown>,
              depth = 0
            ): unknown[] | null {
              if (depth > 5 || !obj || typeof obj !== "object") return null;

              for (const key of possibleKeys) {
                if (Array.isArray(obj[key]) && obj[key].length > 0) {
                  return obj[key] as unknown[];
                }
              }

              // 遞迴搜尋子物件
              for (const value of Object.values(obj)) {
                if (value && typeof value === "object" && !Array.isArray(value)) {
                  const found = findListings(
                    value as Record<string, unknown>,
                    depth + 1
                  );
                  if (found) return found;
                }
              }

              // 也嘗試尋找任何包含 listing 相關欄位的陣列
              for (const value of Object.values(obj)) {
                if (Array.isArray(value) && value.length > 0) {
                  const first = value[0];
                  if (
                    first &&
                    typeof first === "object" &&
                    ("title" in first ||
                      "listingID" in first ||
                      "listing_id" in first ||
                      "id" in first)
                  ) {
                    return value as unknown[];
                  }
                }
              }

              return null;
            }

            const listings = findListings(pageProps);
            if (listings && listings.length > 0) {
              return listings as Array<Record<string, unknown>>;
            }
          }
        } catch {
          // JSON 解析失敗
        }
      }

      // 方法 2：搜尋 self.__next_f.push() flight data（App Router）
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent || "";
        if (!text.includes("self.__next_f.push")) continue;

        // 嘗試從 flight data 中提取商品相關的 JSON 片段
        // flight data 格式：self.__next_f.push([1,"...json..."])
        const jsonMatches = text.matchAll(
          /self\.__next_f\.push\(\[[\d,]*"([^"]+)"\]\)/g
        );
        for (const match of jsonMatches) {
          try {
            const decoded = match[1]
              .replace(/\\n/g, "\n")
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, "\\");
            // 尋找包含商品資料的 JSON 片段
            if (
              decoded.includes("listingID") ||
              decoded.includes("listing_id") ||
              decoded.includes('"title"')
            ) {
              // 嘗試提取 JSON 陣列
              const arrayMatch = decoded.match(/\[[\s\S]*\]/);
              if (arrayMatch) {
                const parsed = JSON.parse(arrayMatch[0]);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  return parsed as Array<Record<string, unknown>>;
                }
              }
            }
          } catch {
            continue;
          }
        }
      }

      // 方法 3：搜尋任何包含商品資料的 inline script
      for (const script of scripts) {
        const text = script.textContent || "";
        if (text.length < 100 || text.length > 500000) continue;
        if (
          !text.includes("listing") &&
          !text.includes("product") &&
          !text.includes("carousell.com/p/")
        )
          continue;

        // 嘗試找出 JSON 陣列
        try {
          const jsonStart = text.indexOf("[{");
          if (jsonStart === -1) continue;

          // 手動匹配括號找到陣列結尾
          let depth = 0;
          let arrayEnd = -1;
          for (let i = jsonStart; i < Math.min(text.length, jsonStart + 200000); i++) {
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
          const jsonStr = text.slice(jsonStart, arrayEnd + 1);
          const parsed = JSON.parse(jsonStr);
          if (
            Array.isArray(parsed) &&
            parsed.length > 2 &&
            parsed[0] &&
            typeof parsed[0] === "object"
          ) {
            // 檢查是否像商品資料（有 title 或 price 欄位）
            const first = parsed[0];
            if ("title" in first || "price" in first || "listingID" in first) {
              return parsed as Array<Record<string, unknown>>;
            }
          }
        } catch {
          continue;
        }
      }

      return null;
    });

    if (!products || products.length === 0) return null;

    return products.map((item) => {
      const listing = item as unknown as CarousellListing;

      // 商品 ID
      const id = String(
        listing.listingID ||
          listing.listing_id ||
          listing.id ||
          ""
      );

      // 標題
      const title = listing.title || "";

      // 價格
      let price: number | null = null;
      if (listing.price !== undefined && listing.price !== null) {
        const parsed =
          typeof listing.price === "number"
            ? listing.price
            : parseFloat(String(listing.price).replace(/[^0-9.]/g, ""));
        if (!isNaN(parsed) && parsed >= 0) price = parsed;
      }

      // 圖片
      let imageUrl: string | null = null;
      if (listing.imageUrl) {
        imageUrl = listing.imageUrl;
      } else if (listing.photo) {
        imageUrl = listing.photo;
      } else if (listing.photos && listing.photos.length > 0) {
        const firstPhoto = listing.photos[0];
        imageUrl =
          typeof firstPhoto === "string"
            ? firstPhoto
            : firstPhoto?.url || firstPhoto?.thumbnail || null;
      }

      // 賣家
      const seller =
        listing.sellerName ||
        listing.seller ||
        listing.username ||
        listing.owner?.username ||
        listing.owner?.name ||
        null;

      // 商品 URL
      let url = "";
      if (listing.url) {
        url = listing.url.startsWith("http")
          ? listing.url
          : `${BASE_URL}${listing.url}`;
      } else if (listing.listingUrl) {
        url = listing.listingUrl.startsWith("http")
          ? listing.listingUrl
          : `${BASE_URL}${listing.listingUrl}`;
      } else if (id) {
        url = `${BASE_URL}/p/${id}/`;
      }

      return {
        platformId: id,
        title,
        price,
        url,
        imageUrl,
        seller,
      };
    }).filter((p) => p.platformId && p.title);
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} JSON 提取失敗，將使用 DOM fallback:`,
      error
    );
    return null;
  }
}

/**
 * 策略二（Fallback）：透過 DOM selector 提取商品資料
 *
 * Carousell 的 class name 會動態變化（CSS-in-JS），
 * 因此優先使用 data-testid、href pattern、語義化結構來定位元素。
 */
async function extractFromDom(page: Page): Promise<ScrapedProduct[]> {
  // 等待商品列表載入（嘗試多種可能的 selector）
  try {
    await page.waitForSelector(
      'a[href*="/p/"], [data-testid*="listing"], [data-testid*="product"]',
      { timeout: 15000 }
    );
  } catch {
    console.warn(`${LOG_PREFIX} 等待商品列表載入逾時`);
    return [];
  }

  const products = await page.evaluate(
    ({ baseUrl }) => {
      const results: Array<{
        platformId: string;
        title: string;
        price: number | null;
        url: string;
        imageUrl: string | null;
        seller: string | null;
      }> = [];

      const seen = new Set<string>();

      // 取得所有指向商品頁的連結
      const links = document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/p/"]'
      );

      for (const link of links) {
        const href = link.href;
        if (!href || seen.has(href)) continue;

        // 提取商品 ID（URL 格式：/p/{slug}-{id}/）
        const idMatch = href.match(/\/p\/.*?(\d{6,})\/?$/);
        if (!idMatch) continue;

        seen.add(href);
        const productId = idMatch[1];

        // 向上尋找商品卡片容器
        // Carousell 的卡片通常是 link 的父層或祖父層 div
        const card =
          link.closest('[data-testid*="listing"]') ||
          link.closest('[data-testid*="product"]') ||
          link.closest('[data-testid*="card"]') ||
          link.closest("li") ||
          // Carousell 卡片通常被包在數層 div 中
          link.parentElement?.parentElement?.parentElement ||
          link.parentElement?.parentElement ||
          link.parentElement ||
          link;

        // 標題：多種策略
        let title = "";

        // 策略 1：從 link 或 card 中找 data-testid 包含 title 的元素
        const titleByTestId = card.querySelector(
          '[data-testid*="title"], [data-testid*="name"]'
        );
        if (titleByTestId) {
          title = titleByTestId.textContent?.trim() || "";
        }

        // 策略 2：從 img alt 屬性取得
        if (!title) {
          const img = card.querySelector<HTMLImageElement>("img");
          if (img?.alt && img.alt.length > 2) {
            title = img.alt.trim();
          }
        }

        // 策略 3：從 link 的 title 或 aria-label 取得
        if (!title) {
          title =
            link.getAttribute("title") ||
            link.getAttribute("aria-label") ||
            "";
        }

        // 策略 4：從 card 中最長的文字節點取得（通常是標題）
        if (!title) {
          const textNodes = card.querySelectorAll("p, span, h2, h3, h4");
          let longestText = "";
          for (const node of textNodes) {
            const text = node.textContent?.trim() || "";
            // 排除價格文字（以 $ 或 NT 開頭的）
            if (
              text.length > longestText.length &&
              !text.match(/^[NT$\d]/) &&
              text.length > 3
            ) {
              longestText = text;
            }
          }
          title = longestText;
        }

        if (!title || title.length < 2) continue;

        // 價格：尋找包含 $ 或 NT$ 的元素
        let price: number | null = null;
        const allText = card.querySelectorAll("p, span, div");
        for (const el of allText) {
          const text = el.textContent?.trim() || "";
          // 匹配 NT$ xxx 或 $xxx 格式
          const priceMatch = text.match(
            /(?:NT\$?\s*|＄\s*|\$\s*)([0-9,]+)/
          );
          if (priceMatch) {
            const parsed = parseFloat(
              priceMatch[1].replace(/,/g, "")
            );
            if (!isNaN(parsed) && parsed > 0) {
              price = parsed;
              break;
            }
          }
        }

        // 如果上面沒找到，嘗試純數字+元的格式
        if (price === null) {
          for (const el of allText) {
            const text = el.textContent?.trim() || "";
            const numMatch = text.match(/^([0-9,]+)\s*元?$/);
            if (numMatch && text.length < 15) {
              const parsed = parseFloat(numMatch[1].replace(/,/g, ""));
              if (!isNaN(parsed) && parsed > 0 && parsed < 1000000) {
                price = parsed;
                break;
              }
            }
          }
        }

        // 圖片
        const img = card.querySelector<HTMLImageElement>("img");
        const imageUrl =
          img?.src ||
          img?.getAttribute("data-src") ||
          img?.getAttribute("srcset")?.split(" ")[0] ||
          null;

        // 賣家：通常在商品卡片下方，class 可能包含 seller/username/owner
        let seller: string | null = null;
        const sellerEl = card.querySelector(
          '[data-testid*="seller"], [data-testid*="user"], [data-testid*="owner"]'
        );
        if (sellerEl) {
          seller = sellerEl.textContent?.trim() || null;
        }

        // 備用：尋找第二個 a 標籤（通常指向賣家個人頁）
        if (!seller) {
          const sellerLinks = card.querySelectorAll<HTMLAnchorElement>("a");
          for (const sl of sellerLinks) {
            const slHref = sl.href;
            // 賣家連結通常是 /u/{username}/ 或 /{username}/
            if (
              slHref &&
              !slHref.includes("/p/") &&
              !slHref.includes("/categories/") &&
              sl.textContent?.trim()
            ) {
              const text = sl.textContent.trim();
              // 排除太長的文字（可能是標題連結）
              if (text.length > 0 && text.length < 30) {
                seller = text;
                break;
              }
            }
          }
        }

        results.push({
          platformId: productId,
          title,
          price,
          url: href.startsWith("http") ? href : `${baseUrl}${href}`,
          imageUrl,
          seller,
        });
      }

      return results;
    },
    { baseUrl: BASE_URL }
  );

  return products;
}

/**
 * 旋轉拍賣爬蟲主函式
 *
 * 優先從 __NEXT_DATA__ 或 inline script JSON 中提取商品資料，
 * 若失敗則 fallback 到 DOM selector 解析。
 *
 * @param page - Playwright Page 實例
 * @param url - 要爬取的分類/搜尋頁面 URL
 * @returns 爬取到的商品陣列
 */
export async function scrapeCarousell(
  page: Page,
  url: string
): Promise<ScrapedProduct[]> {
  console.log(`${LOG_PREFIX} 開始爬取: ${url}`);

  // 加入隨機延遲，模擬人類行為
  await randomDelay(500, 1500);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // 等待頁面渲染完成
  await page.waitForLoadState("networkidle").catch(() => {
    console.warn(`${LOG_PREFIX} networkidle 等待逾時，繼續嘗試提取`);
  });

  // 額外等待讓 React/Next.js 完成 hydration
  await randomDelay(500, 1000);

  // 策略一：從 __NEXT_DATA__ 或 inline JSON 提取
  console.log(`${LOG_PREFIX} 嘗試從嵌入 JSON 提取商品資料...`);
  const jsonProducts = await extractFromNextData(page);

  if (jsonProducts && jsonProducts.length > 0) {
    console.log(
      `${LOG_PREFIX} JSON 提取成功，共 ${jsonProducts.length} 件商品`
    );
    return jsonProducts;
  }

  // 捲動頁面以觸發懶載入
  console.log(`${LOG_PREFIX} JSON 提取失敗，改用 DOM selector...`);
  await randomDelay(300, 600);

  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight / 3);
  });
  await randomDelay(400, 800);

  await page.evaluate(() => {
    window.scrollTo(0, (document.body.scrollHeight * 2) / 3);
  });
  await randomDelay(400, 800);

  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await randomDelay(300, 600);

  // 策略二：DOM fallback
  const domProducts = await extractFromDom(page);

  if (domProducts.length > 0) {
    console.log(
      `${LOG_PREFIX} DOM 提取完成，共 ${domProducts.length} 件商品`
    );
    return domProducts;
  }

  // 完全沒抓到商品，印出頁面資訊以供除錯
  const pageTitle = await page.title();
  const bodyText = await page.evaluate(
    () => document.body?.innerText?.substring(0, 500) || ""
  );
  const hasNextData = await page.evaluate(
    () => !!document.querySelector("#__NEXT_DATA__")
  );
  const scriptCount = await page.evaluate(
    () => document.querySelectorAll("script").length
  );
  const linkCount = await page.evaluate(
    () => document.querySelectorAll('a[href*="/p/"]').length
  );

  console.warn(`${LOG_PREFIX} 未抓到任何商品`);
  console.warn(`${LOG_PREFIX} 頁面標題: ${pageTitle}`);
  console.warn(`${LOG_PREFIX} 是否有 __NEXT_DATA__: ${hasNextData}`);
  console.warn(`${LOG_PREFIX} Script 標籤數量: ${scriptCount}`);
  console.warn(`${LOG_PREFIX} 商品連結數量: ${linkCount}`);
  console.warn(
    `${LOG_PREFIX} 頁面內容片段: ${bodyText.substring(0, 200)}`
  );

  return [];
}
