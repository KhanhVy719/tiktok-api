# 🎵 TikTok API

API server để lấy dữ liệu TikTok profile, videos, photo diaries, và reposts — sử dụng Puppeteer Stealth để bypass bot detection.

## ✨ Features

- 🔍 **Profile Info** — Lấy thông tin user (avatar, bio, stats)
- 🎬 **Video Data** — Lấy tất cả videos với CDN play URL
- 📸 **Photo Diary** — Hỗ trợ nhật ký ảnh (image posts)
- 🔄 **Reposts** — Lấy danh sách reposts với pagination đầy đủ
- 🛡️ **CDN Proxy** — Proxy bypass TikTok CDN Access Denied
- ⏱️ **Auto Cache** — Tự động refresh data mỗi 5 phút
- 🐳 **Docker Ready** — Dockerfile + docker-compose có sẵn

## 🚀 Quick Start

### Local
```bash
npm install
npm start
```

### Docker
```bash
docker compose up -d --build
```

Server chạy tại `http://localhost:3000`

## 📡 API Endpoints

| Endpoint | Mô tả |
|---|---|
| `GET /` | Health check + API info |
| `GET /api/profile/:username` | Lấy profile info |
| `GET /api/videos/:username` | Lấy tất cả videos + CDN links |
| `GET /api/all/:username` | Profile + Videos |
| `GET /api/proxy?url=<CDN_URL>` | Proxy TikTok CDN (bypass 403) |
| `GET /api/cache` | Cache status |

> **Note:** Nếu không truyền `:username`, mặc định là `@The_sunflower71`

## 🎬 Video Proxy

TikTok CDN chặn truy cập trực tiếp (Access Denied). Dùng proxy:

```
# Thay vì (bị chặn):
https://v16-webapp-prime.tiktok.com/video/...

# Dùng proxy (hoạt động):
http://localhost:3000/api/proxy?url=https%3A%2F%2Fv16-webapp-prime.tiktok.com%2Fvideo%2F...
```

Mỗi video trong response đã có sẵn `proxyPlayUrl` và `proxyDownloadUrl`.

## ⏱️ Auto Cache

- Server tự động scrape data mỗi **5 phút**
- API response trả về ngay lập tức từ cache
- Nếu scrape lỗi, trả về data cũ (stale cache)
- Xem cache status: `GET /api/cache`

## 🛠️ Tech Stack

- **Node.js** + **Express**
- **Puppeteer Extra** + Stealth Plugin (bypass bot detection)
- **TikTok API DL** (profile data)
- **Docker** (deployment)

## 📦 Deploy lên Ubuntu/VPS

```bash
# Upload project
scp -r . user@your-server:/root/tiktok-api

# SSH vào server
ssh user@your-server

# Build & run
cd /root/tiktok-api
docker compose up -d --build

# Xem logs
docker compose logs -f
```

## 📄 License

ISC
