import { Hono } from "hono";
import type { Env, BatchProductRequest } from "./types";
import { sendTelegramMessage, sendTelegramMediaGroup } from "./notify";

const VALID_PLATFORMS = ["ruten", "yahoo", "shopee", "carousell"] as const;

/** HTML 跳脫，防止 Telegram HTML injection */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const app = new Hono<{ Bindings: Env }>();

// ── 健康檢查 ──
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── API 認證中間件 ──
app.use("/api/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader !== `Bearer ${c.env.API_TOKEN}`) {
    return c.json({ error: "未授權" }, 401);
  }
  await next();
});

// ── 列出所有監控來源 ──
app.get("/api/sources", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM watch_sources ORDER BY id"
  ).all();
  return c.json(results);
});

// ── 新增監控來源 ──
app.post("/api/sources", async (c) => {
  const body = await c.req.json<{
    name: string;
    platform: string;
    url: string;
    check_interval_min?: number;
  }>();

  const { name, platform, url, check_interval_min } = body;

  if (!name || !platform || !url) {
    return c.json({ error: "缺少必要欄位：name, platform, url" }, 400);
  }

  if (!VALID_PLATFORMS.includes(platform as typeof VALID_PLATFORMS[number])) {
    return c.json({ error: `不支援的平台，可選：${VALID_PLATFORMS.join(", ")}` }, 400);
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO watch_sources (name, platform, url, check_interval_min)
     VALUES (?, ?, ?, ?)`
  )
    .bind(name, platform, url, check_interval_min ?? 240)
    .run();

  return c.json({ id: result.meta.last_row_id }, 201);
});

// ── 爬蟲批次上傳商品 ──
app.post("/api/products/batch", async (c) => {
  const body = await c.req.json<BatchProductRequest>();
  const { source_id, platform, products } = body;

  // 使用 D1 batch 一次送出所有 INSERT
  const statements = products.map((p) =>
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO products (source_id, platform, platform_id, title, price, url, image_url, seller)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(source_id, platform, p.platformId, p.title, p.price, p.url, p.imageUrl, p.seller)
  );

  let inserted = 0;
  const newProducts: { title: string; price: number | null; url: string; imageUrl: string | null }[] = [];

  try {
    const results = await c.env.DB.batch(statements);

    results.forEach((result, i) => {
      if (result.meta.changes > 0) {
        inserted++;
        const p = products[i];
        newProducts.push({ title: p.title, price: p.price, url: p.url, imageUrl: p.imageUrl });
      }
    });
  } catch (err) {
    console.error("批次寫入商品失敗:", err instanceof Error ? err.message : "未知錯誤");
    return c.json({ error: "批次寫入失敗" }, 500);
  }

  // 有新商品就發 Telegram 通知
  if (newProducts.length > 0 && c.env.TELEGRAM_BOT_TOKEN) {
    const platformName: Record<string, string> = { ruten: "露天", yahoo: "Yahoo拍賣", carousell: "旋轉拍賣", shopee: "蝦皮" };
    const pName = platformName[platform] ?? platform;

    // 1) 先發縮圖（有圖的前 10 筆）
    const withImage = newProducts.filter((p) => p.imageUrl);
    if (withImage.length > 0) {
      const photos = withImage.slice(0, 10).map((p, i) => ({
        imageUrl: p.imageUrl!,
        caption:
          i === 0
            ? `<b>🔔 ${pName}｜發現 ${newProducts.length} 件新商品</b>`
            : "",
      }));

      const sent = await sendTelegramMediaGroup(
        c.env.TELEGRAM_BOT_TOKEN,
        c.env.TELEGRAM_CHAT_ID,
        photos
      );
      if (!sent) {
        console.error("Telegram 縮圖發送失敗");
      }
    }

    // 2) 再發文字清單
    const header = withImage.length > 0
      ? `<b>📋 ${pName}｜商品清單</b>\n\n`
      : `<b>🔔 ${pName}｜發現 ${newProducts.length} 件新商品</b>\n\n`;
    const lines = newProducts.map(
      (p) => `• <a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a> ${p.price ? `$${p.price}` : ""}`
    );

    // 分批：確保每則訊息不超過 4000 字元
    const chunks: string[] = [];
    let current = header;
    for (const line of lines) {
      if (current.length + line.length + 1 > 4000) {
        chunks.push(current);
        current = `<b>📋 續...</b>\n\n`;
      }
      current += line + "\n";
    }
    if (current.trim()) chunks.push(current);

    for (const chunk of chunks) {
      const sent = await sendTelegramMessage(
        c.env.TELEGRAM_BOT_TOKEN,
        c.env.TELEGRAM_CHAT_ID,
        chunk
      );
      if (!sent) {
        console.error("Telegram 通知發送失敗");
      }
    }
  }

  return c.json({ inserted, total: products.length });
});

// ── 列出最近商品 ──
app.get("/api/products", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM products ORDER BY first_seen_at DESC LIMIT ?"
  )
    .bind(limit)
    .all();
  return c.json(results);
});

export default app;
