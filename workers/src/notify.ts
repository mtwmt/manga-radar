/** 發送 Telegram 文字訊息 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  message: string
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    console.error(`Telegram API 錯誤: ${res.status} ${await res.text()}`);
    return false;
  }

  return true;
}

interface PhotoMedia {
  type: "photo";
  media: string;
  caption?: string;
  parse_mode?: string;
}

/** 發送 Telegram 圖片群組（最多 10 張縮圖） */
export async function sendTelegramMediaGroup(
  token: string,
  chatId: string,
  photos: Array<{ imageUrl: string; caption: string }>
): Promise<boolean> {
  if (photos.length === 0) return true;

  // Telegram sendMediaGroup 最多 10 張
  const batch = photos.slice(0, 10);
  const media: PhotoMedia[] = batch.map((p, i) => ({
    type: "photo" as const,
    media: p.imageUrl,
    ...(i === 0 ? { caption: p.caption, parse_mode: "HTML" } : {}),
  }));

  const url = `https://api.telegram.org/bot${token}/sendMediaGroup`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      media,
    }),
  });

  if (!res.ok) {
    console.error(`Telegram MediaGroup 錯誤: ${res.status} ${await res.text()}`);
    return false;
  }

  return true;
}
