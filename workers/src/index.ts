import { Hono } from "hono";
import type { Env, BatchProductRequest } from "./types";
import { sendTelegramMessage, sendTelegramPhoto } from "./notify";

const VALID_PLATFORMS = ["ruten", "yahoo", "shopee", "carousell", "jljh", "sofun", "bbbobo", "iopenmall"] as const;

/** HTML 跳脫，防止 Telegram HTML injection */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 將圖片 URL 轉為縮圖版本，統一限制最大高度 300px */
function toThumbnail(url: string): string {
  // 透過 wsrv.nl 免費圖片代理統一縮放，限制最大高度
  // fit=inside 會等比縮放，不裁切；output=jpg 確保相容性
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&h=200&fit=inside&output=jpg`;
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

// ── 更新監控來源 ──
app.patch("/api/sources/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id || id < 1) {
    return c.json({ error: "無效的 source ID" }, 400);
  }

  const body = await c.req.json<{
    name?: string;
    url?: string;
    active?: number;
    check_interval_min?: number;
  }>();

  const fields: string[] = [];
  const values: (string | number)[] = [];

  if (body.name !== undefined) { fields.push("name = ?"); values.push(body.name); }
  if (body.url !== undefined) { fields.push("url = ?"); values.push(body.url); }
  if (body.active !== undefined) { fields.push("active = ?"); values.push(body.active); }
  if (body.check_interval_min !== undefined) { fields.push("check_interval_min = ?"); values.push(body.check_interval_min); }

  if (fields.length === 0) {
    return c.json({ error: "未提供任何要更新的欄位" }, 400);
  }

  values.push(id);
  await c.env.DB.prepare(
    `UPDATE watch_sources SET ${fields.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM watch_sources WHERE id = ?"
  ).bind(id).all();

  if (results.length === 0) {
    return c.json({ error: "找不到該 source" }, 404);
  }

  return c.json(results[0]);
});

// ── 爬蟲批次上傳商品 ──
app.post("/api/products/batch", async (c) => {
  const body = await c.req.json<BatchProductRequest>();
  const { source_id, platform, products } = body;

  if (!source_id || !platform || !Array.isArray(products)) {
    return c.json({ error: "缺少必要欄位：source_id, platform, products" }, 400);
  }

  if (!VALID_PLATFORMS.includes(platform as typeof VALID_PLATFORMS[number])) {
    return c.json({ error: `不支援的平台，可選：${VALID_PLATFORMS.join(", ")}` }, 400);
  }

  if (products.length === 0) {
    return c.json({ inserted: 0, total: 0 });
  }

  if (products.length > 200) {
    return c.json({ error: "單次上傳上限 200 件商品" }, 400);
  }

  // 使用 D1 batch 一次送出所有 INSERT
  const statements = products.map((p) =>
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO products (source_id, platform, platform_id, title, price, url, image_url, seller)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(source_id, platform, p.platformId, p.title, p.price, p.url, p.imageUrl, p.seller)
  );

  let inserted = 0;
  const newProductIndices: number[] = [];

  try {
    const results = await c.env.DB.batch(statements);

    results.forEach((result, i) => {
      if (result.meta.changes > 0) {
        inserted++;
        newProductIndices.push(i);
      }
    });
  } catch (err) {
    console.error("批次寫入商品失敗:", err instanceof Error ? err.message : "未知錯誤");
    return c.json({ error: "批次寫入失敗" }, 500);
  }

  // 有新商品：查回 DB 中的 product ID，用於寫 notifications 表
  if (newProductIndices.length > 0 && c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID) {
    const newProducts = newProductIndices.map((i) => products[i]);

    // 查回剛插入的商品 ID（用 platform + platform_id 匹配）
    const idLookups = newProducts.map((p) =>
      c.env.DB.prepare(
        "SELECT id FROM products WHERE platform = ? AND platform_id = ?"
      ).bind(platform, p.platformId)
    );
    const idResults = await c.env.DB.batch(idLookups);
    const productDbIds: (number | null)[] = idResults.map((r) => {
      const row = r.results[0] as { id: number } | undefined;
      return row?.id ?? null;
    });

    const platformName: Record<string, string> = { ruten: "露天", yahoo: "Yahoo拍賣", carousell: "旋轉拍賣", shopee: "蝦皮", jljh: "蚤來蚤去", sofun: "蚤樂趣", bbbobo: "跳蚤本舖", iopenmall: "iOPEN Mall" };
    const pName = platformName[platform] ?? platform;

    // 逐筆發圖文卡片，每則之間延遲避免 Telegram rate limit
    let sentCount = 0;
    const failedItems: Array<{ caption: string; dbId: number | null }> = [];

    for (let idx = 0; idx < newProducts.length; idx++) {
      const p = newProducts[idx];
      const dbId = productDbIds[idx];

      const caption = [
        `<b>${escapeHtml(p.title)}</b>`,
        p.price ? `💰 $${p.price}` : "",
        `🏪 ${escapeHtml(pName)}`,
        `🔗 <a href="${escapeHtml(p.url)}">查看商品</a>`,
      ]
        .filter(Boolean)
        .join("\n");

      let sent = false;

      if (p.imageUrl) {
        const thumbUrl = toThumbnail(p.imageUrl);
        sent = await sendTelegramPhoto(
          c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID, thumbUrl, caption
        );
        // 縮圖失敗 → 試原圖
        if (!sent && thumbUrl !== p.imageUrl) {
          sent = await sendTelegramPhoto(
            c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID, p.imageUrl, caption
          );
        }
        // 圖片都失敗 → 純文字
        if (!sent) {
          sent = await sendTelegramMessage(
            c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID, caption
          );
        }
      } else {
        sent = await sendTelegramMessage(
          c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID, caption
        );
      }

      if (sent && dbId) {
        sentCount++;
        await c.env.DB.prepare(
          "INSERT INTO notifications (product_id) VALUES (?)"
        ).bind(dbId).run();
      } else if (!sent) {
        failedItems.push({ caption, dbId });
      }

      // 延遲 150ms 避免 Telegram rate limit (30 msg/sec)
      if (idx < newProducts.length - 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    // 立刻重試失敗的項目（純文字，不帶圖，間隔加長避免 rate limit）
    for (const item of failedItems) {
      await new Promise((r) => setTimeout(r, 500));
      const sent = await sendTelegramMessage(
        c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID, item.caption
      );
      if (sent && item.dbId) {
        sentCount++;
        await c.env.DB.prepare(
          "INSERT INTO notifications (product_id) VALUES (?)"
        ).bind(item.dbId).run();
      }
    }

    // 最後發送摘要
    await sendTelegramMessage(
      c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID,
      `<b>🔔 ${pName}｜${sentCount} 件新商品</b>`
    );
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

export default {
  fetch: app.fetch,

  /** Cron Trigger：補發漏掉的通知 + 清理舊資料 */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    try {
      // ── 補發未通知的商品（2 天內、沒有 notification 記錄的，之後才清理） ──
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        const { results: missed } = await env.DB.prepare(
          `SELECT p.id, p.platform, p.title, p.price, p.url, p.image_url
           FROM products p
           LEFT JOIN notifications n ON n.product_id = p.id
           WHERE n.id IS NULL AND p.first_seen_at > datetime('now', '-2 days')
           ORDER BY p.first_seen_at ASC
           LIMIT 100`
        ).all<{ id: number; platform: string; title: string; price: number | null; url: string; image_url: string | null }>();

        if (missed.length > 0) {
          const platformName: Record<string, string> = { ruten: "露天", yahoo: "Yahoo拍賣", carousell: "旋轉拍賣", shopee: "蝦皮", jljh: "蚤來蚤去", sofun: "蚤樂趣", bbbobo: "跳蚤本舖", iopenmall: "iOPEN Mall" };

          console.log(`[補發] 發現 ${missed.length} 筆漏通知商品`);
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID,
            `<b>🔄 補發 ${missed.length} 件漏通知商品</b>`
          );

          for (const p of missed) {
            const pName = platformName[p.platform] ?? p.platform;
            const caption = [
              `<b>${escapeHtml(p.title)}</b>`,
              p.price ? `💰 $${p.price}` : "",
              `🏪 ${escapeHtml(pName)}`,
              `🔗 <a href="${escapeHtml(p.url)}">查看商品</a>`,
            ].filter(Boolean).join("\n");

            let sent = false;
            if (p.image_url) {
              sent = await sendTelegramPhoto(
                env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID,
                toThumbnail(p.image_url), caption
              );
              if (!sent) {
                sent = await sendTelegramMessage(
                  env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, caption
                );
              }
            } else {
              sent = await sendTelegramMessage(
                env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, caption
              );
            }

            if (sent) {
              await env.DB.prepare(
                "INSERT INTO notifications (product_id) VALUES (?)"
              ).bind(p.id).run();
            }

            await new Promise((r) => setTimeout(r, 150));
          }
          console.log(`[補發] 完成`);
        }
      }

      // ── 清理 2 天前的舊資料 ──
      const notifResult = await env.DB.prepare(
        "DELETE FROM notifications WHERE sent_at < datetime('now', '-2 days')"
      ).run();
      console.log(`[清理] 已刪除 ${notifResult.meta.changes} 筆通知紀錄`);

      const result = await env.DB.prepare(
        "DELETE FROM products WHERE first_seen_at < datetime('now', '-2 days')"
      ).run();
      console.log(`[清理] 已刪除 ${result.meta.changes} 筆舊商品`);
    } catch (err) {
      console.error("[排程] 失敗:", err instanceof Error ? err.message : "未知錯誤");
    }
  },
};
