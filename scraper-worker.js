const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { StalkUser } = require('@tobyg74/tiktok-api-dl');

const API_SERVER_URL = process.env.API_SERVER_URL || 'http://localhost:3000';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'tiktok-internal-2node';
const DEFAULT_USERNAME = 'The_sunflower71';
const SCRAPE_INTERVAL = 5 * 60 * 1000; // 5 phút

// === Global error handler ===
process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err?.message || err));

// === External API: api.douyin.wtf ===
const EXTERNAL_API = 'https://api.douyin.wtf';

async function fetchFromExternalAPI(username) {
    try {
        console.log(`  [External API] Lấy secUid cho @${username}...`);
        const secRes = await fetch(`${EXTERNAL_API}/api/tiktok/web/get_sec_user_id?url=https://www.tiktok.com/@${username}`);
        const secData = await secRes.json();
        if (secData.code !== 200 || !secData.data) return null;
        const secUid = secData.data;
        console.log(`  [External API] secUid: ${secUid.slice(0, 30)}...`);

        const allItems = [];
        let cursor = 0;
        for (let page = 0; page < 10; page++) {
            const postRes = await fetch(`${EXTERNAL_API}/api/tiktok/web/fetch_user_post?secUid=${encodeURIComponent(secUid)}&cursor=${cursor}&count=35`);
            if (!postRes.ok) {
                console.log(`  [External API] fetch_user_post lỗi: ${postRes.status}`);
                break;
            }
            const postData = await postRes.json();
            if (postData.code !== 200 || !postData.data) break;

            const itemList = postData.data.itemList || postData.data.items || [];
            allItems.push(...itemList);
            console.log(`  [External API] trang ${page}: +${itemList.length} (tổng: ${allItems.length})`);

            if (!postData.data.hasMore) break;
            cursor = postData.data.cursor || 0;
        }

        if (allItems.length === 0) return null;
        console.log(`  [External API] Tổng: ${allItems.length} items`);
        return allItems;
    } catch (e) {
        console.log(`  [External API] Lỗi: ${e.message}`);
        return null;
    }
}

// === Puppeteer ===
let browserInstance = null;

async function getBrowser() {
    if (!browserInstance || !browserInstance.connected) {
        const launchOptions = {
            headless: false, // Dùng Xvfb virtual display thay vì headless
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1280,900',
                '--start-maximized',
            ]
        };
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        console.log(`  🖥️ Launching Chromium (DISPLAY=${process.env.DISPLAY || 'not set'})`);
        browserInstance = await puppeteer.launch(launchOptions);
    }
    return browserInstance;
}

async function scrapeVideos(username, profileSecUid) {
    console.log('  [Scraper] Bắt đầu lấy videos gốc...');
    const ownVideos = new Map();

    // === 1. External API: nguồn dữ liệu chính (không phụ thuộc VPS IP) ===
    console.log('  📡 [External API] Lấy video list...');
    const externalItems = await fetchFromExternalAPI(username);
    if (externalItems && externalItems.length > 0) {
        externalItems.forEach(v => {
            v._source = 'own';
            ownVideos.set(v.id, v);
        });
        console.log(`  ✅ [External API] ${ownVideos.size} videos`);
    } else {
        console.log('  ⚠️ [External API] Không lấy được data');
    }

    // === 2. Puppeteer: lấy cookies + extra IDs ===
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Bonus: bắt thêm videos nếu response listener nhận được
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('tiktok.com/api') && url.includes('/post/item_list') && !url.includes('repost')) {
            try {
                const text = await response.text();
                if (text.length > 10) {
                    const json = JSON.parse(text);
                    if (json.itemList && json.itemList.length > 0) {
                        json.itemList.forEach(v => { v._source = 'own'; ownVideos.set(v.id, v); });
                        console.log(`  [Puppeteer bonus] +${json.itemList.length} (total: ${ownVideos.size})`);
                    }
                }
            } catch (e) { }
        }
    });

    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`https://www.tiktok.com/@${username}`, {
        waitUntil: 'networkidle2', timeout: 30000
    });
    try { const btn = await page.$('button[data-e2e="cookie-banner-accept"]'); if (btn) await btn.click(); } catch (e) {}
    await new Promise(r => setTimeout(r, 3000));

    // Extra IDs via page navigation
    const EXTRA_IDS = (process.env.EXTRA_VIDEO_IDS || '').split(',').filter(Boolean);
    const missingIds = EXTRA_IDS.filter(id => !ownVideos.has(id));
    if (missingIds.length > 0) {
        console.log(`  🎯 Fetching ${missingIds.length} extra posts...`);
        for (const postId of missingIds) {
            try {
                let postData = null;
                for (const type of ['video', 'photo']) {
                    await page.goto(`https://www.tiktok.com/@${username}/${type}/${postId}`, { waitUntil: 'networkidle2', timeout: 15000 });
                    await new Promise(r => setTimeout(r, 2000));
                    postData = await page.evaluate(() => {
                        try {
                            const root = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
                            const scope = root?.['__DEFAULT_SCOPE__'];
                            const detail = scope?.['webapp.video-detail'];
                            return detail?.itemInfo?.itemStruct || detail?.itemStruct || null;
                        } catch { return null; }
                    });
                    if (postData) break;
                }
                if (postData) {
                    postData._source = 'own';
                    ownVideos.set(postId, postData);
                    console.log(`    ✅ ${postId}: "${(postData.desc || '').slice(0, 40)}"`);
                } else {
                    console.log(`    ⚠️ ${postId}: no SSR data`);
                }
            } catch (e) { console.log(`    ❌ ${postId}: ${e.message}`); }
        }
    }

    console.log(`  📊 Tổng: ${ownVideos.size} videos gốc`);

    // Lưu cookies cho CDN proxy
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`  Lưu ${cookies.length} cookies cho CDN proxy`);
    await page.close();

    return {
        videos: formatItems(ownVideos, username),
        cookies: cookieStr,
        source: 'external-api+puppeteer'
    };
}
function formatItems(videoMap, username) {
    const extractUrl = (field) => {
        if (!field) return '';
        if (typeof field === 'string') return field;
        if (field.urlList && field.urlList.length > 0) return field.urlList[0];
        if (field.url) return field.url;
        return '';
    };

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

        const proxyBase = '/api/proxy?url=';

        return {
            id: v.id,
            type: isImagePost ? 'image_diary' : 'video',
            source: v._source || 'unknown', // 'own' = video gốc, 'repost' = đăng lại
            desc: v.desc || '',
            createTime: v.createTime,
            duration: v.video?.duration || 0,
            cover,
            originCover,
            playUrl,
            downloadUrl,
            proxyPlayUrl: playUrl ? `${proxyBase}${encodeURIComponent(playUrl)}` : '',
            proxyDownloadUrl: downloadUrl ? `${proxyBase}${encodeURIComponent(downloadUrl)}` : '',
            images,
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

// === Đẩy data sang Node 1 ===
async function pushToApiServer(profile, videos, cookies) {
    try {
        const res = await fetch(`${API_SERVER_URL}/internal/update`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Secret': INTERNAL_SECRET,
            },
            body: JSON.stringify({ profile, videos, cookies }),
        });
        const result = await res.json();
        console.log(`📤 [Push] Đã đẩy sang Node 1: ${result.videoCount} videos`);
        return true;
    } catch (err) {
        console.error(`❌ [Push] Lỗi đẩy sang Node 1: ${err.message}`);
        return false;
    }
}

// === Vòng lặp scrape chính ===
async function runScrape() {
    const start = Date.now();
    console.log(`\n🔄 [Scrape] Bắt đầu scrape @${DEFAULT_USERNAME}...`);

    let profile = null;
    let videos = [];
    let cookies = '';

    // 1. Lấy profile
    try {
        const result = await StalkUser(DEFAULT_USERNAME);
        if (result.status !== 'error') {
            const r = result.result;
            profile = {
                uid: r?.user?.uid,
                secUid: r?.user?.secUid || '',
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
            console.log(`  ✅ Profile: ${profile.nickname} (${profile.stats.followers} followers)`);
        }
    } catch (err) {
        console.error(`  ❌ Profile lỗi: ${err.message}`);
    }

    // 2. Scrape videos
    try {
        const result = await scrapeVideos(DEFAULT_USERNAME, profile?.secUid || '');
        videos = result.videos;
        cookies = result.cookies;
        console.log(`  ✅ Videos: ${videos.length} items (source: ${result.source})`);
    } catch (err) {
        console.error(`  ❌ Videos lỗi: ${err.message}`);
    }

    // 3. Đẩy sang Node 1 (cookies luôn push, videos chỉ push khi có data)
    if (videos.length > 0) {
        await pushToApiServer(profile, videos, cookies);
    } else if (cookies) {
        // Push cookies + profile mà không overwrite videos cũ
        await pushToApiServer(profile, null, cookies);
        console.log('  ℹ️ Push cookies/profile only (giữ videos cũ trên server)');
    } else {
        console.log('  ⚠️ Không có data mới, bỏ qua push');
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`⏱️ [Scrape] Hoàn thành trong ${elapsed}s. Lần tiếp: ${SCRAPE_INTERVAL / 1000}s\n`);
}

// === Khởi chạy ===
console.log(`🔧 [Node 2] Scraper Worker khởi động`);
console.log(`📡 API Server: ${API_SERVER_URL}`);
console.log(`⏱️  Chu kỳ scrape: ${SCRAPE_INTERVAL / 1000}s`);
console.log(`👤 User: @${DEFAULT_USERNAME}\n`);

// Chạy lần đầu sau 3 giây (đợi Node 1 sẵn sàng)
setTimeout(() => runScrape(), 3000);
// Lặp lại mỗi 5 phút
setInterval(() => runScrape(), SCRAPE_INTERVAL);

// Cleanup
process.on('SIGINT', async () => {
    if (browserInstance) await browserInstance.close();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    if (browserInstance) await browserInstance.close();
    process.exit(0);
});
