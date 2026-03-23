const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { StalkUser } = require('@tobyg74/tiktok-api-dl');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DEFAULT_USERNAME = 'The_sunflower71';
const CACHE_INTERVAL = 5 * 60 * 1000; // 5 minutes

// === Data Cache ===
const cache = {
    profile: null,
    videos: null,
    lastUpdated: null,
    isRefreshing: false,
    error: null,
};

async function refreshCache() {
    if (cache.isRefreshing) return;
    cache.isRefreshing = true;
    const start = Date.now();
    console.log(`\n🔄 [Cache] Refreshing data for @${DEFAULT_USERNAME}...`);

    try {
        // Profile
        const profileResult = await StalkUser(DEFAULT_USERNAME);
        if (profileResult.status !== 'error') {
            const r = profileResult.result;
            cache.profile = {
                uid: r?.user?.uid,
                username: r?.user?.username || DEFAULT_USERNAME,
                nickname: r?.user?.nickname,
                avatar: r?.user?.avatarLarger,
                bio: r?.user?.signature,
                verified: r?.user?.verified,
                profileUrl: `https://www.tiktok.com/@${DEFAULT_USERNAME}`,
                stats: {
                    followers: r?.stats?.followerCount,
                    following: r?.stats?.followingCount,
                    likes: r?.stats?.heartCount,
                    videos: r?.stats?.videoCount,
                    friends: r?.stats?.friendCount,
                },
            };
        }

        // Videos
        const videoResult = await scrapeVideos(DEFAULT_USERNAME);
        cache.videos = {
            count: videoResult.videos.length,
            source: videoResult.source || 'puppeteer',
            data: videoResult.videos,
        };

        cache.lastUpdated = new Date().toISOString();
        cache.error = null;
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`✅ [Cache] Done! ${cache.videos.count} videos, took ${elapsed}s. Next refresh in 5min.`);
    } catch (err) {
        cache.error = err.message;
        console.error(`❌ [Cache] Error: ${err.message}`);
    } finally {
        cache.isRefreshing = false;
    }
}

// Global error handler
process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err?.message || err));

// === External API: api.douyin.wtf (Douyin_TikTok_Download_API) ===
const EXTERNAL_API = 'https://api.douyin.wtf';

async function fetchFromExternalAPI(username) {
    try {
        console.log(`  [External API] Getting secUid for @${username}...`);
        // Step 1: Get secUid
        const secRes = await fetch(`${EXTERNAL_API}/api/tiktok/web/get_sec_user_id?url=https://www.tiktok.com/@${username}`);
        const secData = await secRes.json();
        if (secData.code !== 200 || !secData.data) return null;
        const secUid = secData.data;
        console.log(`  [External API] secUid: ${secUid.slice(0, 30)}...`);

        // Step 2: Fetch all posts with cursor pagination
        const allItems = [];
        let cursor = 0;
        for (let page = 0; page < 10; page++) {
            const postRes = await fetch(`${EXTERNAL_API}/api/tiktok/web/fetch_user_post?secUid=${encodeURIComponent(secUid)}&cursor=${cursor}&count=35`);
            if (!postRes.ok) {
                console.log(`  [External API] fetch_user_post failed: ${postRes.status}`);
                break;
            }
            const postData = await postRes.json();
            if (postData.code !== 200 || !postData.data) break;

            const itemList = postData.data.itemList || postData.data.items || [];
            allItems.push(...itemList);
            console.log(`  [External API] page ${page}: +${itemList.length} (total: ${allItems.length})`);

            if (!postData.data.hasMore) break;
            cursor = postData.data.cursor || 0;
        }

        if (allItems.length === 0) return null;
        console.log(`  [External API] Total: ${allItems.length} items`);
        return allItems;
    } catch (e) {
        console.log(`  [External API] Error: ${e.message}`);
        return null;
    }
}

// === Puppeteer: Scrape video CDN links ===
let browserInstance = null;
let savedCookies = ''; // cookies from Puppeteer session for CDN proxy

async function getBrowser() {
    if (!browserInstance || !browserInstance.connected) {
        const launchOptions = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        };
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        browserInstance = await puppeteer.launch(launchOptions);
    }
    return browserInstance;
}

async function scrapeVideos(username) {
    // Try external API first (faster, no browser needed)
    const externalItems = await fetchFromExternalAPI(username);
    if (externalItems && externalItems.length > 0) {
        const videoMap = new Map();
        externalItems.forEach(v => videoMap.set(v.id, v));
        return { videos: formatItems(videoMap, username), domLinks: [], source: 'external_api' };
    }

    console.log('  [Puppeteer] External API failed, using browser scraping...');
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const videoMap = new Map();
    const apiEndpoints = new Map(); // track url/cursor/hasMore per endpoint

    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('tiktok.com/api') && url.includes('item_list')) {
            try {
                const apiPath = url.match(/\/api\/([^?]+)/)?.[1] || 'unknown';
                const json = await response.json();
                if (json.itemList && json.itemList.length > 0) {
                    json.itemList.forEach(v => videoMap.set(v.id, v));
                    console.log(`  [${apiPath}] +${json.itemList.length} (total: ${videoMap.size})`);
                }
                // Track each endpoint's pagination state
                apiEndpoints.set(apiPath, {
                    url,
                    hasMore: !!json.hasMore,
                    cursor: json.cursor || '0',
                });
            } catch (e) { }
        }
    });

    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(`https://www.tiktok.com/@${username}`, {
        waitUntil: 'networkidle2',
        timeout: 30000
    });

    // Dismiss cookie banner if present
    try {
        const btn = await page.$('button[data-e2e="cookie-banner-accept"]');
        if (btn) await btn.click();
    } catch (e) { }

    // Wait for initial load
    await new Promise(r => setTimeout(r, 5000));
    console.log(`  After initial load: ${videoMap.size} items`);

    // Scroll down to load all visible content
    for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`  After scroll: ${videoMap.size} items`);

    // Paginate ALL endpoints that have hasMore=true
    for (const [apiPath, state] of apiEndpoints) {
        if (!state.hasMore) continue;
        let { url: templateUrl, cursor } = state;
        console.log(`  Paginating ${apiPath} (cursor=${cursor})...`);

        for (let i = 0; i < 20; i++) {
            try {
                const nextUrl = templateUrl.replace(/cursor=\d+/, `cursor=${cursor}`);
                const moreData = await page.evaluate(async (fetchUrl) => {
                    const r = await fetch(fetchUrl, { credentials: 'include' });
                    return r.json();
                }, nextUrl);

                if (moreData.itemList && moreData.itemList.length > 0) {
                    moreData.itemList.forEach(v => videoMap.set(v.id, v));
                    console.log(`  [${apiPath}] cursor +${moreData.itemList.length} (total: ${videoMap.size})`);
                }
                if (!moreData.hasMore) break;
                cursor = moreData.cursor || '0';
            } catch (e) {
                console.log(`  ${apiPath} pagination error:`, e.message);
                break;
            }
        }
    }
    console.log(`  Final total: ${videoMap.size} items`);

    // DOM fallback
    let domLinks = [];
    if (videoMap.size === 0) {
        domLinks = await page.evaluate(() => {
            const links = [];
            document.querySelectorAll('a[href*="/video/"]').forEach(a => links.push(a.href));
            return links;
        });
    }

    // Save cookies for CDN proxy
    const cookies = await page.cookies();
    savedCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`  Saved ${cookies.length} cookies for CDN proxy`);

    await page.close();

    return {
        videos: formatItems(videoMap, username),
        domLinks,
        source: 'puppeteer'
    };
}

// Shared formatting for video/image items
function formatItems(videoMap, username) {
    // TikTok fields can be either plain strings or objects with urlList
    const extractUrl = (field) => {
        if (!field) return '';
        if (typeof field === 'string') return field;
        if (field.urlList && field.urlList.length > 0) return field.urlList[0];
        if (field.url) return field.url;
        return '';
    };

    const proxyBase = '/api/proxy?url=';

    return Array.from(videoMap.values()).map(v => {
        const isImagePost = !!v.imagePost;
        const images = isImagePost && v.imagePost?.images
            ? v.imagePost.images.map(img => ({
                url: img.imageURL?.urlList?.[0] || img.imageURL?.url || '',
                width: img.imageWidth,
                height: img.imageHeight,
            }))
            : [];

        const playUrl = extractUrl(v.video?.playAddr);
        const downloadUrl = extractUrl(v.video?.downloadAddr);
        const cover = extractUrl(v.video?.cover) || extractUrl(v.video?.dynamicCover);
        const originCover = extractUrl(v.video?.originCover);

        return {
            id: v.id,
            type: isImagePost ? 'image_diary' : 'video',
            desc: v.desc || '',
            createTime: v.createTime,
            duration: v.video?.duration || 0,
            cover,
            originCover,
            playUrl,
            downloadUrl,
            proxyPlayUrl: playUrl ? `${proxyBase}${encodeURIComponent(playUrl)}` : '',
            proxyDownloadUrl: downloadUrl ? `${proxyBase}${encodeURIComponent(downloadUrl)}` : '',
            images: images,
            music: v.music ? {
                title: v.music.title,
                author: v.music.authorName,
                playUrl: extractUrl(v.music.playUrl),
                cover: extractUrl(v.music.coverLarge) || extractUrl(v.music.coverMedium),
            } : null,
            stats: {
                views: v.stats?.playCount || 0,
                likes: v.stats?.diggCount || 0,
                comments: v.stats?.commentCount || 0,
                shares: v.stats?.shareCount || 0,
                bookmarks: v.stats?.collectCount || 0,
            },
            url: `https://www.tiktok.com/@${username}/video/${v.id}`
        };
    });
}

// === Profile handler ===
async function handleProfile(req, res) {
    const username = req.params.username || DEFAULT_USERNAME;
    try {
        const result = await StalkUser(username);
        if (result.status === 'error') {
            return res.status(404).json({ error: 'Không tìm thấy user', detail: result.message });
        }
        const r = result.result;
        res.json({
            status: 'ok',
            data: {
                uid: r?.user?.uid,
                username: r?.user?.username || username,
                nickname: r?.user?.nickname,
                avatar: r?.user?.avatarLarger,
                bio: r?.user?.signature,
                verified: r?.user?.verified,
                region: r?.user?.region,
                profileUrl: `https://www.tiktok.com/@${username}`,
                stats: {
                    followers: r?.stats?.followerCount,
                    following: r?.stats?.followingCount,
                    likes: r?.stats?.heartCount,
                    videos: r?.stats?.videoCount,
                    friends: r?.stats?.friendCount,
                },
            }
        });
    } catch (err) {
        console.error('Profile error:', err.message);
        res.status(500).json({ error: 'Lỗi server', detail: err.message });
    }
}
app.get('/api/profile', handleProfile);
app.get('/api/profile/:username', handleProfile);

// === Videos handler ===
async function handleVideos(req, res) {
    const username = req.params.username || DEFAULT_USERNAME;
    try {
        // Use cache for default user
        if (username === DEFAULT_USERNAME && cache.videos && cache.videos.count > 0) {
            return res.json({
                status: 'ok',
                cached: true,
                lastUpdated: cache.lastUpdated,
                ...cache.videos,
            });
        }

        console.log(`Scraping videos for @${username}...`);
        const result = await scrapeVideos(username);

        if (result.videos.length > 0) {
            res.json({
                status: 'ok',
                count: result.videos.length,
                source: result.source || 'puppeteer',
                data: result.videos
            });
        } else if (result.domLinks && result.domLinks.length > 0) {
            res.json({
                status: 'partial',
                count: result.domLinks.length,
                data: result.domLinks.map(link => ({ url: link, id: link.split('/video/')[1] || '' }))
            });
        } else {
            res.json({ status: 'error', count: 0, data: [] });
        }
    } catch (err) {
        console.error('Videos error:', err.message);
        // Fallback to cache even if stale
        if (cache.videos) return res.json({ status: 'ok', cached: true, stale: true, ...cache.videos });
        res.status(500).json({ error: 'Lỗi lấy video', detail: err.message });
    }
}
app.get('/api/videos', handleVideos);
app.get('/api/videos/:username', handleVideos);

// === All data handler ===
async function handleAll(req, res) {
    const username = req.params.username || DEFAULT_USERNAME;
    let profile = null;
    let videos = [];

    try {
        const result = await StalkUser(username);
        if (result.status !== 'error') {
            const r = result.result;
            profile = {
                uid: r?.user?.uid,
                username: r?.user?.username || username,
                nickname: r?.user?.nickname,
                avatar: r?.user?.avatarLarger,
                bio: r?.user?.signature,
                verified: r?.user?.verified,
                profileUrl: `https://www.tiktok.com/@${username}`,
                stats: {
                    followers: r?.stats?.followerCount,
                    following: r?.stats?.followingCount,
                    likes: r?.stats?.heartCount,
                    videos: r?.stats?.videoCount,
                    friends: r?.stats?.friendCount,
                },
            };
        }
    } catch (err) {
        console.error('Profile error:', err.message);
    }

    try {
        console.log(`Scraping videos for @${username}...`);
        const result = await scrapeVideos(username);
        videos = result.videos;
    } catch (err) {
        console.error('Videos error:', err.message);
    }

    res.json({
        status: 'ok',
        profile,
        videos: { count: videos.length, data: videos }
    });
}
app.get('/api/all', handleAll);
app.get('/api/all/:username', handleAll);

// === CDN Proxy - bypass TikTok referer check ===
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

        // Forward range header for video seeking
        if (req.headers.range) headers['Range'] = req.headers.range;

        const response = await fetch(url, { headers, redirect: 'follow' });

        if (!response.ok && response.status !== 206) {
            return res.status(response.status).json({ error: `CDN returned ${response.status}` });
        }

        // Forward content headers
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

        // Stream the response
        const reader = response.body.getReader();
        const pump = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); break; }
                res.write(value);
            }
        };
        await pump();
    } catch (err) {
        console.error('Proxy error:', err.message);
        res.status(500).json({ error: 'Proxy failed', detail: err.message });
    }
});

// === Cache status ===
app.get('/api/cache', (req, res) => {
    res.json({
        lastUpdated: cache.lastUpdated,
        isRefreshing: cache.isRefreshing,
        hasProfile: !!cache.profile,
        videoCount: cache.videos?.count || 0,
        error: cache.error,
        nextRefresh: cache.lastUpdated
            ? new Date(new Date(cache.lastUpdated).getTime() + CACHE_INTERVAL).toISOString()
            : null,
    });
});

// === Health check ===
app.get('/', (req, res) => {
    res.json({
        service: 'TikTok API - @The_sunflower71',
        version: '3.0.0',
        cache: {
            lastUpdated: cache.lastUpdated,
            videoCount: cache.videos?.count || 0,
            refreshInterval: '5 minutes',
        },
        endpoints: {
            profile: 'GET /api/profile/:username',
            videos: 'GET /api/videos/:username',
            all: 'GET /api/all/:username',
            proxy: 'GET /api/proxy?url=<CDN_URL>',
            cache: 'GET /api/cache - Cache status',
        },
        default_user: DEFAULT_USERNAME,
    });
});

app.listen(PORT, () => {
    console.log(`🎵 TikTok API v3 running on port ${PORT}`);
    console.log(`📡 Default user: @${DEFAULT_USERNAME}`);
    console.log(`🔗 http://localhost:${PORT}`);
    console.log(`⏱️  Auto-refresh every ${CACHE_INTERVAL / 1000}s`);

    // Initial cache load + periodic refresh
    setTimeout(() => refreshCache(), 2000);
    setInterval(() => refreshCache(), CACHE_INTERVAL);
});

// Cleanup on exit
process.on('SIGINT', async () => {
    if (browserInstance) await browserInstance.close();
    process.exit(0);
});
