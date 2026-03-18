-- 監控來源
CREATE TABLE watch_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,           -- 'ruten' | 'yahoo' | 'shopee' | 'carousell'
  url TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  check_interval_min INTEGER DEFAULT 240,  -- 預設 4 小時
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 爬到的商品
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES watch_sources(id),
  platform TEXT NOT NULL,
  platform_id TEXT NOT NULL,        -- 平台上的商品 ID（去重用）
  title TEXT NOT NULL,
  price INTEGER,                    -- 整數，台幣
  url TEXT NOT NULL,
  image_url TEXT,
  seller TEXT,
  first_seen_at TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, platform_id)
);

-- 通知紀錄
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  channel TEXT DEFAULT 'telegram',
  sent_at TEXT DEFAULT (datetime('now'))
);
