const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'tiktok-internal-2node';

// === Bộ nhớ cache (RAM) ===
const cache = {
    profile: null,
    videos: null,
    lastUpdated: null,
    updateCount: 0,
    error: null,
};

let savedCookies = '';

// === POST /internal/update — Node 2 đẩy data vào ===
app.post('/internal/update', (req, res) => {
    const token = req.headers['x-internal-secret'];
    if (token !== INTERNAL_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const { profile, videos, cookies } = req.body;

    if (profile) cache.profile = profile;
    if (videos) {
        cache.videos = {
            count: videos.length,
            data: videos,
        };
    }
    if (cookies) savedCookies = cookies;

    cache.lastUpdated = new Date().toISOString();
    cache.updateCount++;
    cache.error = null;

    console.log(`✅ [Update] Nhận data từ worker: ${cache.videos?.count || 0} videos, profile=${!!cache.profile}`);
    res.json({ status: 'ok', lastUpdated: cache.lastUpdated, videoCount: cache.videos?.count || 0 });
});

// === GET /api/profile ===
app.get('/api/profile', (req, res) => {
    if (!cache.profile) {
        return res.json({ status: 'waiting', message: 'Đang chờ dữ liệu từ worker...' });
    }
    res.json({ status: 'ok', data: cache.profile });
});

// === GET /api/videos ===
app.get('/api/videos', (req, res) => {
    if (!cache.videos) {
        return res.json({ status: 'waiting', count: 0, data: [] });
    }
    res.json({
        status: 'ok',
        cached: true,
        lastUpdated: cache.lastUpdated,
        ...cache.videos,
    });
});

// === GET /api/all — endpoint chính cho client ===
app.get('/api/all', (req, res) => {
    res.json({
        status: 'ok',
        profile: cache.profile,
        videos: {
            count: cache.videos?.count || 0,
            data: cache.videos?.data || [],
        },
    });
});

// === GET /api/proxy — CDN proxy bypass referer check ===
app.get('/api/proxy', async (req, res) => {
    const url = req.query.url;
    if (!url || (!url.includes('tiktok') && !url.includes('tiktokcdn'))) {
        return res.status(400).json({ error: 'URL param required (tiktok CDN only)' });
    }

    try {
        const headers = {
            'Referer': 'https://www.tiktok.com/',
            'Origin': 'https://www.tiktok.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };
        if (savedCookies) headers['Cookie'] = savedCookies;
        if (req.headers.range) headers['Range'] = req.headers.range;

        const response = await fetch(url, { headers, redirect: 'follow' });

        if (!response.ok && response.status !== 206) {
            return res.status(response.status).json({ error: `CDN returned ${response.status}` });
        }

        res.status(response.status);
        const contentType = response.headers.get('content-type');
        const contentLength = response.headers.get('content-length');
        const contentRange = response.headers.get('content-range');
        if (contentType) res.set('Content-Type', contentType);
        if (contentLength) res.set('Content-Length', contentLength);
        res.set('Accept-Ranges', 'bytes');
        if (contentRange) res.set('Content-Range', contentRange);
        res.set('Cache-Control', 'public, max-age=3600');
        res.set('Access-Control-Allow-Origin', '*');

        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(value);
        }
    } catch (err) {
        console.error('Proxy error:', err.message);
        res.status(500).json({ error: 'Proxy failed', detail: err.message });
    }
});

// === GET /api/cache — trạng thái cache ===
app.get('/api/cache', (req, res) => {
    res.json({
        lastUpdated: cache.lastUpdated,
        hasProfile: !!cache.profile,
        videoCount: cache.videos?.count || 0,
        updateCount: cache.updateCount,
        error: cache.error,
    });
});

// === GET / — health check ===
app.get('/', (req, res) => {
    res.json({
        service: 'TikTok API — Node 1 (API Server)',
        version: '4.0.0',
        architecture: '2-node',
        cache: {
            lastUpdated: cache.lastUpdated,
            videoCount: cache.videos?.count || 0,
            updateCount: cache.updateCount,
        },
        endpoints: {
            profile: 'GET /api/profile',
            videos: 'GET /api/videos',
            all: 'GET /api/all',
            proxy: 'GET /api/proxy?url=<CDN_URL>',
            cache: 'GET /api/cache',
        },
    });
});

app.listen(PORT, () => {
    console.log(`🚀 [Node 1] API Server đang chạy trên cổng ${PORT}`);
    console.log(`📡 Đang chờ data từ scraper worker...`);
    console.log(`🔗 http://localhost:${PORT}`);
});
