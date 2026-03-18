/** 爬蟲爬到的商品資料 */
export interface ScrapedProduct {
  platformId: string;
  title: string;
  price: number | null;
  url: string;
  imageUrl: string | null;
  seller: string | null;
}

/** 監控來源（從 API 取得） */
export interface WatchSource {
  id: number;
  name: string;
  platform: string;
  url: string;
  active: number;
  check_interval_min: number;
}
