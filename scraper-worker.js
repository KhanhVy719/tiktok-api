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

// === Puppeteer ===
let browserInstance = null;

async function getBrowser() {
    if (!browserInstance || !browserInstance.connected) {
        const launchOptions = {
            headless: false, // Dùng Xvfb virtual display
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1280,900',
                '--start-maximized',
                '--lang=vi-VN,vi',
                '--disable-blink-features=AutomationControlled',
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

// === Helper: random delay ===
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => delay(min + Math.random() * (max - min));

// === Helper: simulate human scrolling ===
async function humanScroll(page, scrolls = 3) {
    for (let i = 0; i < scrolls; i++) {
        await page.evaluate(() => window.scrollBy(0, 300 + Math.random() * 400));
        await randomDelay(800, 1500);
    }
}

// === Main scraper ===
async function scrapeVideos(username, profileSecUid) {
    console.log(`  [Puppeteer] Bắt đầu scrape videos gốc... (secUid: ${profileSecUid ? 'YES' : 'NONE'})`);
    const ownVideos = new Map();

    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    
    // Set extra headers for realism
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    // === Strategy A: Response listener (bắt API responses) ===
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('tiktok.com/api') && url.includes('/post/item_list') && !url.includes('repost')) {
            try {
                const text = await response.text();
                if (text.length > 10) {
                    const json = JSON.parse(text);
                    if (json.itemList && json.itemList.length > 0) {
                        json.itemList.forEach(v => { v._source = 'own'; ownVideos.set(v.id, v); });
                        console.log(`  [Strategy A: Response] +${json.itemList.length} (total: ${ownVideos.size})`);
                    }
                }
            } catch (e) { }
        }
    });

    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`https://www.tiktok.com/@${username}`, {
        waitUntil: 'networkidle2', timeout: 30000
    });

    // Accept cookie banner
    try { const btn = await page.$('button[data-e2e="cookie-banner-accept"]'); if (btn) await btn.click(); } catch (e) {}
    await randomDelay(2000, 3000);

    // Click Videos tab
    try {
        const videoTab = await page.$('p[data-e2e="videos-tab"]');
        if (videoTab) {
            await videoTab.click();
            console.log('  📹 Clicked tab Videos');
            await randomDelay(3000, 5000);
        }
    } catch (e) {}

    // Simulate human scrolling to trigger lazy loading
    await humanScroll(page, 5);
    await randomDelay(2000, 3000);

    // === Strategy B: In-page fetch with secUid (gọi API từ browser context) ===
    if (ownVideos.size === 0 && profileSecUid) {
        console.log('  📡 [Strategy B: In-page fetch] Thử gọi post/item_list...');
        let cursor = 0;
        for (let pn = 0; pn < 3; pn++) {
            try {
                const apiResult = await page.evaluate(async (suid, cur) => {
                    try {
                        const r = await fetch(`/api/post/item_list/?aid=1988&count=35&cursor=${cur}&secUid=${encodeURIComponent(suid)}&cookie_enabled=true&device_platform=web_pc`, {
                            credentials: 'include',
                            headers: { 'Accept': 'application/json' }
                        });
                        const text = await r.text();
                        if (text.length < 10) return { items: [], hasMore: false, error: 'empty response' };
                        const d = JSON.parse(text);
                        return { items: d.itemList || [], hasMore: !!d.hasMore, cursor: d.cursor || '0' };
                    } catch (e) { return { items: [], hasMore: false, error: e.message }; }
                }, profileSecUid, cursor);

                if (apiResult.error) {
                    console.log(`    ⚠️ In-page fetch: ${apiResult.error}`);
                    break;
                }
                if (apiResult.items.length > 0) {
                    apiResult.items.forEach(v => { v._source = 'own'; ownVideos.set(v.id, v); });
                    console.log(`    [In-page] +${apiResult.items.length} (own: ${ownVideos.size})`);
                }
                if (!apiResult.hasMore) break;
                cursor = apiResult.cursor;
            } catch (e) { console.log(`    ❌ In-page error: ${e.message}`); break; }
        }
    }

    // === Strategy C: DOM extraction (lấy video từ DOM đã render) ===
    if (ownVideos.size === 0) {
        console.log('  🔍 [Strategy C: DOM extraction] Lấy video từ trang...');
        
        // Scroll thêm để load hết
        await humanScroll(page, 3);
        await randomDelay(1000, 2000);

        const domVideos = await page.evaluate((un) => {
            const results = [];
            // Cách 1: Lấy từ video card links
            const links = document.querySelectorAll('a[href*="/@' + un + '/video/"], a[href*="/@' + un + '/photo/"]');
            links.forEach(link => {
                const href = link.getAttribute('href') || '';
                const match = href.match(/\/(video|photo)\/(\d+)/);
                if (match) {
                    const id = match[2];
                    const type = match[1];
                    // Lấy cover image
                    const img = link.querySelector('img');
                    const cover = img ? img.src : '';
                    // Lấy description
                    const descEl = link.closest('[class*="ItemContainer"]')?.querySelector('[class*="ItemCaption"], [class*="video-caption"]');
                    const desc = descEl ? descEl.textContent : '';
                    results.push({ id, type, cover, desc });
                }
            });
            
            // Cách 2: Lấy từ data-e2e video items
            if (results.length === 0) {
                const items = document.querySelectorAll('[data-e2e="user-post-item"], [data-e2e="user-post-item-list"] a');
                items.forEach(item => {
                    const link = item.tagName === 'A' ? item : item.querySelector('a');
                    if (!link) return;
                    const href = link.getAttribute('href') || '';
                    const match = href.match(/\/(video|photo)\/(\d+)/);
                    if (match) {
                        const img = item.querySelector('img');
                        results.push({
                            id: match[2],
                            type: match[1],
                            cover: img ? img.src : '',
                            desc: ''
                        });
                    }
                });
            }
            
            return results;
        }, username);

        if (domVideos.length > 0) {
            console.log(`    📋 Tìm thấy ${domVideos.length} video IDs từ DOM`);
            // Dùng page navigation để lấy full data cho mỗi video
            for (const dv of domVideos) {
                if (ownVideos.has(dv.id)) continue;
                try {
                    const urlType = dv.type === 'photo' ? 'photo' : 'video';
                    await page.goto(`https://www.tiktok.com/@${username}/${urlType}/${dv.id}`, {
                        waitUntil: 'networkidle2', timeout: 15000
                    });
                    await randomDelay(1500, 2500);
                    const postData = await page.evaluate(() => {
                        try {
                            const root = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
                            const scope = root?.['__DEFAULT_SCOPE__'];
                            const detail = scope?.['webapp.video-detail'];
                            return detail?.itemInfo?.itemStruct || detail?.itemStruct || null;
                        } catch { return null; }
                    });
                    if (postData) {
                        postData._source = 'own';
                        ownVideos.set(dv.id, postData);
                        console.log(`    ✅ ${dv.id}: "${(postData.desc || '').slice(0, 40)}"`);
                    } else {
                        console.log(`    ⚠️ ${dv.id}: no SSR data`);
                    }
                } catch (e) { console.log(`    ❌ ${dv.id}: ${e.message}`); }
            }
        } else {
            console.log('    ⚠️ DOM extraction: không tìm thấy video links');
        }
    }

    // === Extra IDs (các video/photo cụ thể cần lấy) ===
    const EXTRA_IDS = (process.env.EXTRA_VIDEO_IDS || '').split(',').filter(Boolean);
    const missingIds = EXTRA_IDS.filter(id => !ownVideos.has(id));
    if (missingIds.length > 0) {
        console.log(`  🎯 Fetching ${missingIds.length} extra posts...`);
        for (const postId of missingIds) {
            try {
                let postData = null;
                for (const type of ['video', 'photo']) {
                    await page.goto(`https://www.tiktok.com/@${username}/${type}/${postId}`, {
                        waitUntil: 'networkidle2', timeout: 15000
                    });
                    await randomDelay(1500, 2500);
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
                    const type = postData.imagePost ? 'photo' : 'video';
                    console.log(`    ✅ ${postId} (${type}): "${(postData.desc || '').slice(0, 40)}"`);
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
        source: 'puppeteer'
    };
}

// === Format video/image items ===
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
            source: v._source || 'unknown',
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

    // 1. Lấy profile + secUid
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
            console.log(`  ✅ Profile: ${profile.nickname} (${profile.stats.followers} followers, secUid: ${profile.secUid ? 'YES' : 'NO'})`);
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
