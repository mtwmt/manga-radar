# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

manga-radar 是一個台灣二手漫畫監控系統，自動從多個拍賣平台（露天、Yahoo拍賣、蚤來蚤去、蚤樂趣、跳蚤本舖）抓取商品列表，透過 Telegram 通知新上架商品。

## Architecture

Monorepo 分為兩個主要模組：

- **scraper/** — Playwright 爬蟲，在 GitHub Actions 上每 15 分鐘執行，抓取各平台商品並透過 API 上傳
- **workers/** — Cloudflare Workers (Hono) API，負責資料儲存（D1/SQLite）與 Telegram 通知發送

資料流：GitHub Actions → Scraper 抓取 → Workers API 寫入 D1 → 偵測新商品 → Telegram 通知

每個平台爬蟲採用多層策略：API 攔截 → JSON 解析 → DOM 擷取，依序 fallback。

## Commands

```bash
# 安裝依賴（monorepo root）
npm install

# 本地執行爬蟲
cd scraper && npm start

# 本地開發 Workers
npm run dev:workers

# D1 資料庫 migration
cd workers && npm run db:migrate

# 部署 Workers 到 production（必須指定 bkdglot 帳號的認證）
CLOUDFLARE_API_TOKEN=<見 workers/.dev.vars> CLOUDFLARE_ACCOUNT_ID=ab25fbefc96e0821d6bcc9679d2086d9 npm run deploy:workers
```

> **注意：Workers 部署在 bkdglot@gmail.com 的 Cloudflare 帳號**，不是 Mandy 帳號。
> 不要用 `wrangler login` 的 OAuth（會連到錯的帳號），必須用環境變數指定 token。
> Token 和 Account ID 存在 `workers/.dev.vars`。

## Tech Stack

- TypeScript, npm monorepo
- Scraper: Playwright + playwright-extra (stealth plugin)
- API: Hono on Cloudflare Workers
- Database: Cloudflare D1 (SQLite), schema 在 `workers/schema.sql`
- Notifications: Telegram Bot API
- CI: GitHub Actions (`.github/workflows/scrape.yml`)

## Key Design Decisions

- 商品去重靠 D1 的 `UNIQUE(platform, platform_id)` 約束，INSERT OR IGNORE
- 爬蟲使用 stealth plugin + 自訂 user agent 做反偵測
- Workers API 用 `Bearer API_TOKEN` header 做認證
- Telegram 通知：header 訊息 + 逐筆圖文卡片（縮圖→原圖→純文字 fallback），成功才寫 `notifications` 表，失敗由 cron 補發
- Cron（每天 03:00 UTC）：補發漏通知商品 + 清理 2 天前舊資料
- Carousell 爬蟲因 Cloudflare Turnstile 封鎖已停用
- Shopee 爬蟲需透過 NAS Docker Chrome CDP 連線，目前暫停

## Environment Variables

Scraper（GitHub Actions secrets）：`WORKERS_API_URL`, `API_TOKEN`

Workers（`.dev.vars` / wrangler secrets）：`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `API_TOKEN`, `CLOUDFLARE_*` 系列, D1 binding `DB`

## Adding a New Platform Scraper

1. 在 `scraper/src/platforms/` 新增檔案，export 一個接受 `(page: Page, url: string)` 回傳 `ScrapedProduct[]` 的函式
2. 在 `scraper/src/index.ts` 的 platform switch 中加入路由
3. 在 `watch_sources` 表新增對應 platform 的記錄
