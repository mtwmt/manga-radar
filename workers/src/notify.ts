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

/** 發送單張商品圖+資訊 */
export async function sendTelegramPhoto(
  token: string,
  chatId: string,
  imageUrl: string,
  caption: string
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: imageUrl,
      caption,
      parse_mode: "HTML",
      show_caption_above_media: false,
    }),
  });

  if (!res.ok) {
    console.error(`Telegram Photo 錯誤: ${res.status} ${await res.text()}`);
    return false;
  }

  return true;
}
