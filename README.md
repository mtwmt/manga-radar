# manga-radar — 二手漫畫上架監控通知系統

自動監控露天、Yahoo 拍賣等平台的二手漫畫上架，透過 Telegram 即時通知。

## 架構

- **scraper/** — Playwright 爬蟲，透過 GitHub Actions 定時執行
- **workers/** — Cloudflare Workers API（D1 儲存 + Telegram 通知）

## 開發

```bash
pnpm install
pnpm dev:workers   # 本機啟動 Workers
```
