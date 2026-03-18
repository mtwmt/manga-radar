/** 發送 Telegram 訊息 */
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
