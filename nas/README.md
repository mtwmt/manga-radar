# NAS 蝦皮爬蟲 Docker 設定

## 在 Synology NAS 上部署

### 步驟 1：上傳檔案
把 `nas/` 整個資料夾上傳到 NAS 的共用資料夾（例如 `/docker/shopee-chrome/`）

### 步驟 2：Container Manager 建立專案
1. 打開 NAS 的 **Container Manager**
2. 左側選 **專案 (Project)**
3. 點 **建立**
4. 專案名稱輸入 `shopee-chrome`
5. 路徑選擇你上傳的資料夾
6. 它會自動偵測 docker-compose.yml
7. 點 **建立** 啟動

### 步驟 3：登入蝦皮
1. 瀏覽器打開 `http://你的NAS-IP:6901`
2. 密碼輸入 `shopee123`
3. 在 noVNC 桌面裡打開 Chrome
4. 登入蝦皮帳號
5. 確認搜尋頁正常後關閉 noVNC（不要關容器）

### 步驟 4：測試爬蟲
在你的電腦執行：
```bash
cd scraper && pnpm tsx test-shopee-cdp.ts
```

## 維護
- 蝦皮 session 過期時，重新進 noVNC 登入即可
- noVNC 密碼：shopee123
