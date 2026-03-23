# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

manga-radar 是一個台灣二手漫畫監控系統，自動從多個拍賣平台（露天、Yahoo拍賣、旋轉拍賣）抓取商品列表，透過 Telegram 通知新上架商品。

## Architecture

Monorepo 分為兩個主要模組：

- **scraper/** — Playwright 爬蟲，在 GitHub Actions 上每 15 分鐘執行，抓取各平台商品並透過 API 上傳
- **workers/** — Cloudflare Workers (Hono) API，負責資料儲存（D1/SQLite）與 Telegram 通知發送

資料流：GitHub Actions → Scraper 抓取 → Workers API 寫入 D1 → 偵測新商品 → Telegram 通知

每個平台爬蟲採用多層策略：API 攔截 → JSON 解析 → DOM 擷取，依序 fallback。

## Commands

```bash
# 安裝依賴（monorepo root）
pnpm install

# 本地執行爬蟲
pnpm scraper start

# 本地開發 Workers
pnpm dev:workers

# D1 資料庫 migration
pnpm workers db:migrate

# 部署 Workers 到 production
pnpm deploy:workers
```

## Tech Stack

- TypeScript, pnpm monorepo
- Scraper: Playwright + playwright-extra (stealth plugin)
- API: Hono on Cloudflare Workers
- Database: Cloudflare D1 (SQLite), schema 在 `workers/schema.sql`
- Notifications: Telegram Bot API
- CI: GitHub Actions (`.github/workflows/scrape.yml`)

## Key Design Decisions

- 商品去重靠 D1 的 `UNIQUE(platform, platform_id)` 約束，INSERT OR IGNORE
- 爬蟲使用 stealth plugin + 自訂 user agent 做反偵測
- Workers API 用 `API_TOKEN` header 做簡易認證
- Telegram 通知分為：header 訊息 + 最多 5 張圖片卡片 + 剩餘商品文字列表（4000 字元分段）
- Carousell 爬蟲目前因 Cloudflare Turnstile 封鎖已停用

## Environment Variables

Scraper（GitHub Actions secrets）：`WORKERS_API_URL`, `API_TOKEN`

Workers（`.dev.vars` / wrangler secrets）：`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `API_TOKEN`, `CLOUDFLARE_*` 系列, D1 binding `DB`

## Adding a New Platform Scraper

1. 在 `scraper/src/platforms/` 新增檔案，export 一個接受 `(page: Page, url: string)` 回傳 `ScrapedProduct[]` 的函式
2. 在 `scraper/src/index.ts` 的 platform switch 中加入路由
3. 在 `watch_sources` 表新增對應 platform 的記錄
