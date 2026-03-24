const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { StalkUser } = require('@tobyg74/tiktok-api-dl');

const API_SERVER_URL = process.env.API_SERVER_URL || 'http://localhost:3000';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'tiktok-internal-2node';
const DEFAULT_USERNAME = 'The_sunflower71';
const SCRAPE_INTERVAL = 5 * 60 * 1000;

process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err?.message || err));

// === Helpers ===
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => delay(min + Math.random() * (max - min));

// === Puppeteer — mỗi lần mở browser mới ===
async function launchBrowser() {
    const args = [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--window-size=1280,900', '--start-maximized',
        '--lang=vi-VN,vi', '--disable-blink-features=AutomationControlled',
    ];
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        console.log(`  🖥️ Launching Chromium (DISPLAY=${process.env.DISPLAY || 'not set'})`);
    }
    return puppeteer.launch({
        headless: false,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args,
    });
}

// === Single scrape attempt ===
async function scrapeAttempt(username, profileSecUid, attemptNum) {
    console.log(`  🔄 Attempt ${attemptNum}: opening fresh browser...`);
    const ownVideos = new Map();
    const browser = await launchBrowser();
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' });
        await page.setViewport({ width: 1280, height: 900 });

        // Response listener
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('tiktok.com/api') && url.includes('item_list')) {
                try {
                    const isRepostEndpoint = url.includes('repost');
                    const text = await response.text();
                    if (text.length > 10) {
                        const json = JSON.parse(text);
                        if (json.itemList && json.itemList.length > 0) {
                            let ownCount = 0, repostCount = 0;
                            json.itemList.forEach(v => {
                                const authorId = (v.author?.uniqueId || '').toLowerCase();
                                const isOwn = authorId === username.toLowerCase();
                                v._source = isOwn ? 'own' : 'repost';
                                ownVideos.set(v.id, v);
                                if (isOwn) ownCount++; else repostCount++;
                            });
                            const endpoint = isRepostEndpoint ? 'repost' : 'post';
                            console.log(`    [${endpoint}] +${json.itemList.length} (own: ${ownCount}, repost: ${repostCount}, total: ${ownVideos.size})`);
                        }
                    }
                } catch (e) { }
            }
        });

        // Navigate to profile
        await page.goto(`https://www.tiktok.com/@${username}`, {
            waitUntil: 'networkidle2', timeout: 30000
        });

        // Wait + dismiss banners
        await randomDelay(3000, 5000);
        try {
            const btn = await page.$('button[data-e2e="cookie-banner-accept"]');
            if (btn) await btn.click();
        } catch (e) {}

        // Click Videos tab explicitly 
        try {
            const videoTab = await page.$('[data-e2e="videos-tab"]');
            if (videoTab) { await videoTab.click(); console.log('    📹 Clicked Videos tab'); }
        } catch (e) {}
        await randomDelay(3000, 5000);

        // Scroll to trigger lazy loading
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollBy(0, 400 + Math.random() * 300));
            await randomDelay(1000, 2000);
        }
        await randomDelay(2000, 3000);

        // Strategy A: Check if response listener got data
        if (ownVideos.size > 0) {
            console.log(`    ✅ [Strategy A] Response listener got ${ownVideos.size} videos`);
        }

        // Strategy B: In-page fetch with secUid
        if (ownVideos.size === 0 && profileSecUid) {
            console.log('    📡 [Strategy B] In-page fetch...');
            const apiResult = await page.evaluate(async (suid) => {
                try {
                    const r = await fetch(`/api/post/item_list/?aid=1988&count=35&cursor=0&secUid=${encodeURIComponent(suid)}&cookie_enabled=true&device_platform=web_pc`, {
                        credentials: 'include',
                        headers: { 'Accept': 'application/json' }
                    });
                    const text = await r.text();
                    if (text.length < 10) return { items: [], error: `empty (${text.length} chars)` };
                    const d = JSON.parse(text);
                    return { items: d.itemList || [], hasMore: !!d.hasMore };
                } catch (e) { return { items: [], error: e.message }; }
            }, profileSecUid);

            if (apiResult.error) console.log(`      ⚠️ ${apiResult.error}`);
            if (apiResult.items.length > 0) {
                apiResult.items.forEach(v => { v._source = 'own'; ownVideos.set(v.id, v); });
                console.log(`      ✅ +${apiResult.items.length} (total: ${ownVideos.size})`);
            }
        }

        // Strategy C: DOM extraction — find video links from rendered page
        if (ownVideos.size === 0) {
            console.log('    🔍 [Strategy C] DOM extraction...');
            // Scroll back up then down to trigger re-render
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(1500);
            for (let i = 0; i < 3; i++) {
                await page.evaluate(() => window.scrollBy(0, 500));
                await delay(1200);
            }

            const videoIds = await page.evaluate((un) => {
                const results = [];
                // Find ALL links that contain video or photo IDs
                const allAnchors = document.querySelectorAll('a');
                for (const a of allAnchors) {
                    const href = a.href || a.getAttribute('href') || '';
                    const match = href.match(/\/(video|photo)\/(\d{10,})/);
                    if (match && !results.find(r => r.id === match[2])) {
                        results.push({ id: match[2], type: match[1] });
                    }
                }
                return results;
            }, username);

            if (videoIds.length > 0) {
                console.log(`      📋 Found ${videoIds.length} video IDs in DOM`);
                // Navigate to each for full SSR data
                for (const vid of videoIds.slice(0, 10)) {
                    if (ownVideos.has(vid.id)) continue;
                    try {
                        await page.goto(`https://www.tiktok.com/@${username}/${vid.type}/${vid.id}`, {
                            waitUntil: 'networkidle2', timeout: 15000
                        });
                        await randomDelay(2000, 3000);
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
                            ownVideos.set(vid.id, postData);
                            console.log(`      ✅ ${vid.id}: "${(postData.desc || '').slice(0, 30)}"`);
                        }
                    } catch (e) { console.log(`      ❌ ${vid.id}: ${e.message}`); }
                }
            } else {
                // Check page state for debug
                const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200));
                if (bodyText.includes('Something went wrong') || bodyText.includes('went wrong')) {
                    console.log('      ⚠️ TikTok shows "Something went wrong" — will retry');
                } else {
                    console.log('      ⚠️ No video links found in DOM');
                }
            }
        }

        // Extra IDs
        const EXTRA_IDS = (process.env.EXTRA_VIDEO_IDS || '').split(',').filter(Boolean);
        const missingIds = EXTRA_IDS.filter(id => !ownVideos.has(id));
        if (missingIds.length > 0) {
            console.log(`    🎯 Extra posts: ${missingIds.length}...`);
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
                        console.log(`      ✅ ${postId}: "${(postData.desc || '').slice(0, 30)}"`);
                    }
                } catch (e) { }
            }
        }

        // Get cookies
        const cookies = await page.cookies();
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        console.log(`    Cookies: ${cookies.length}, Videos: ${ownVideos.size}`);
        await page.close();
        await browser.close();

        return { videos: ownVideos, cookies: cookieStr };
    } catch (err) {
        console.log(`    ❌ Attempt ${attemptNum} error: ${err.message}`);
        try { await browser.close(); } catch (e) {}
        return { videos: new Map(), cookies: '' };
    }
}

// === Main scraper with retry ===
async function scrapeVideos(username, profileSecUid) {
    console.log(`  [Scraper] Bắt đầu (secUid: ${profileSecUid ? 'YES' : 'NONE'})`);

    for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await scrapeAttempt(username, profileSecUid, attempt);
        
        if (result.videos.size > 0) {
            // Chỉ giữ video gốc (own), bỏ repost
            const ownOnly = new Map([...result.videos].filter(([_, v]) => v._source === 'own'));
            console.log(`  📊 Tổng: ${result.videos.size} (own: ${ownOnly.size}, repost: ${result.videos.size - ownOnly.size}) — attempt ${attempt}`);
            if (ownOnly.size > 0) {
                return {
                    videos: formatItems(ownOnly, username),
                    cookies: result.cookies,
                    source: `puppeteer-attempt-${attempt}`
                };
            }
        }

        if (attempt < 3) {
            const waitSec = attempt * 15;
            console.log(`  ⏳ Đợi ${waitSec}s rồi thử lại...`);
            await delay(waitSec * 1000);
        }
    }

    // All attempts failed — return cookies only
    console.log('  ⚠️ Tất cả 3 lần thử đều fail — chỉ push cookies');
    const result = await scrapeAttempt(username, profileSecUid, 0);
    return {
        videos: [],
        cookies: result.cookies,
        source: 'puppeteer-failed'
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
            cover, originCover, playUrl, downloadUrl,
            proxyPlayUrl: playUrl ? `${proxyBase}${encodeURIComponent(playUrl)}` : '',
            proxyDownloadUrl: downloadUrl ? `${proxyBase}${encodeURIComponent(downloadUrl)}` : '',
            images,
            music: v.music ? {
                title: v.music.title, author: v.music.authorName,
                playUrl: extractUrl(v.music.playUrl),
                cover: extractUrl(v.music.coverLarge) || extractUrl(v.music.coverMedium),
            } : null,
            stats: {
                views: v.stats?.playCount || 0, likes: v.stats?.diggCount || 0,
                comments: v.stats?.commentCount || 0, shares: v.stats?.shareCount || 0,
                bookmarks: v.stats?.collectCount || 0,
            },
            url: `https://www.tiktok.com/@${username}/video/${v.id}`
        };
    });
}

// === Push data to Node 1 ===
async function pushToApiServer(profile, videos, cookies) {
    try {
        const res = await fetch(`${API_SERVER_URL}/internal/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
            body: JSON.stringify({ profile, videos, cookies }),
        });
        const result = await res.json();
        console.log(`📤 [Push] Node 1: ${result.videoCount} videos`);
        return true;
    } catch (err) {
        console.error(`❌ [Push] Lỗi: ${err.message}`);
        return false;
    }
}

// === Main scrape loop ===
async function runScrape() {
    const start = Date.now();
    console.log(`\n🔄 [Scrape] Bắt đầu scrape @${DEFAULT_USERNAME}...`);

    let profile = null;
    let videos = [];
    let cookies = '';

    try {
        const result = await StalkUser(DEFAULT_USERNAME);
        if (result.status !== 'error') {
            const r = result.result;
            profile = {
                uid: r?.user?.uid, secUid: r?.user?.secUid || '',
                username: r?.user?.username || DEFAULT_USERNAME,
                nickname: r?.user?.nickname, avatar: r?.user?.avatarLarger,
                bio: r?.user?.signature, verified: r?.user?.verified,
                profileUrl: `https://www.tiktok.com/@${DEFAULT_USERNAME}`,
                stats: {
                    followers: r?.stats?.followerCount, following: r?.stats?.followingCount,
                    likes: r?.stats?.heartCount, videos: r?.stats?.videoCount,
                    friends: r?.stats?.friendCount,
                },
            };
            console.log(`  ✅ Profile: ${profile.nickname} (${profile.stats.followers} followers)`);
        }
    } catch (err) { console.error(`  ❌ Profile: ${err.message}`); }

    try {
        const result = await scrapeVideos(DEFAULT_USERNAME, profile?.secUid || '');
        videos = result.videos;
        cookies = result.cookies;
        console.log(`  ✅ Videos: ${videos.length} items (${result.source})`);
    } catch (err) { console.error(`  ❌ Videos: ${err.message}`); }

    if (videos.length > 0) {
        await pushToApiServer(profile, videos, cookies);
    } else if (cookies) {
        await pushToApiServer(profile, null, cookies);
        console.log('  ℹ️ Cookies/profile only (giữ videos cũ)');
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`⏱️ Hoàn thành trong ${elapsed}s. Lần tiếp: ${SCRAPE_INTERVAL / 1000}s\n`);
}

// === Start ===
console.log(`🔧 [Node 2] Scraper Worker khởi động`);
console.log(`📡 API Server: ${API_SERVER_URL}`);
console.log(`⏱️  Chu kỳ: ${SCRAPE_INTERVAL / 1000}s | 👤 @${DEFAULT_USERNAME}\n`);
setTimeout(() => runScrape(), 3000);
setInterval(() => runScrape(), SCRAPE_INTERVAL);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
