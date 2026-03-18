/** Workers 環境變數型別 */
export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  API_TOKEN: string;
}

/** watch_sources 資料表型別 */
export interface WatchSource {
  id: number;
  name: string;
  platform: string;
  url: string;
  active: number;
  check_interval_min: number;
  created_at: string;
  updated_at: string;
}

/** products 資料表型別 */
export interface Product {
  id: number;
  source_id: number;
  platform: string;
  platform_id: string;
  title: string;
  price: number | null;
  url: string;
  image_url: string | null;
  seller: string | null;
  first_seen_at: string;
}

/** 批次上傳商品的請求格式 */
export interface BatchProductRequest {
  source_id: number;
  platform: string;
  products: {
    platformId: string;
    title: string;
    price: number | null;
    url: string;
    imageUrl: string | null;
    seller: string | null;
  }[];
}
