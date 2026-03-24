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

async function scrapeVideos(username) {
    // Chỉ lấy videos gốc (own videos), bỏ reposts
    console.log('  [Puppeteer] Bắt đầu scrape videos gốc...');
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const ownVideos = new Map();
    const apiEndpoints = new Map();

    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('tiktok.com/api') && url.includes('post/item_list')) {
            try {
                const apiPath = url.match(/\/api\/([^?]+)/)?.[1] || 'unknown';
                const json = await response.json();
                if (json.itemList && json.itemList.length > 0) {
                    json.itemList.forEach(v => {
                        v._source = 'own';
                        ownVideos.set(v.id, v);
                    });
                    console.log(`  [${apiPath}] +${json.itemList.length} (own: ${ownVideos.size})`);
                }
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

    // Bỏ qua cookie banner
    try {
        const btn = await page.$('button[data-e2e="cookie-banner-accept"]');
        if (btn) await btn.click();
    } catch (e) { }

    // === 1. Tab VIDEOS — lấy videos gốc ===
    try {
        const videoTab = await page.$('p[data-e2e="videos-tab"]');
        if (videoTab) {
            await videoTab.click();
            console.log('  📹 Clicked tab Videos');
        } else {
            console.log('  ⚠️ Không tìm thấy tab Videos selector');
        }
    } catch (e) { console.log('  ⚠️ Lỗi click Videos tab:', e.message); }

    await new Promise(r => setTimeout(r, 5000));

    // Lấy secUid từ SSR data + debug
    let secUid = '';
    try {
        const ssrDebug = await page.evaluate(() => {
            try {
                const root = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
                if (!root) return { error: 'no __UNIVERSAL_DATA_FOR_REHYDRATION__' };
                const scope = root['__DEFAULT_SCOPE__'];
                if (!scope) return { error: 'no __DEFAULT_SCOPE__', keys: Object.keys(root) };
                const userDetail = scope['webapp.user-detail'];
                if (!userDetail) return { error: 'no webapp.user-detail', keys: Object.keys(scope) };
                const userInfo = userDetail.userInfo;
                if (!userInfo) return { error: 'no userInfo', keys: Object.keys(userDetail) };
                const user = userInfo.user;
                if (!user) return { error: 'no user', keys: Object.keys(userInfo) };
                return {
                    secUid: user.secUid || '',
                    uniqueId: user.uniqueId || '',
                    userKeys: Object.keys(user).filter(k => k.toLowerCase().includes('uid') || k.toLowerCase().includes('sec')),
                };
            } catch (e) { return { error: e.message }; }
        });
        console.log('  🔍 SSR debug:', JSON.stringify(ssrDebug));
        secUid = ssrDebug.secUid || '';
        if (secUid) console.log(`  🔑 secUid: ${secUid.slice(0, 30)}...`);
    } catch (e) { console.log('  ⚠️ SSR error:', e.message); }

    // Dùng in-page fetch gọi TikTok API nếu có secUid
    if (secUid) {
        console.log('  📡 Gọi trực tiếp post/item_list API...');
        let cursor = 0;
        for (let pn = 0; pn < 5; pn++) {
            try {
                const apiResult = await page.evaluate(async (suid, cur) => {
                    try {
                        const r = await fetch(`/api/post/item_list/?aid=1988&count=35&cursor=${cur}&secUid=${encodeURIComponent(suid)}&cookie_enabled=true&device_platform=web_pc`, { credentials: 'include' });
                        const d = await r.json();
                        return { items: d.itemList || [], hasMore: !!d.hasMore, cursor: d.cursor || '0' };
                    } catch (e) { return { items: [], hasMore: false, error: e.message }; }
                }, secUid, cursor);

                if (apiResult.error) { console.log(`    ⚠️ ${apiResult.error}`); break; }
                if (apiResult.items.length > 0) {
                    apiResult.items.forEach(v => { v._source = 'own'; ownVideos.set(v.id, v); });
                    console.log(`    📡 +${apiResult.items.length} (own total: ${ownVideos.size})`);
                }
                if (!apiResult.hasMore) break;
                cursor = apiResult.cursor;
            } catch (e) { console.log(`    ⚠️ ${e.message}`); break; }
        }
    }

    // Navigate tới từng video page để lấy data (cho extra IDs + missing videos)
    const EXTRA_IDS = (process.env.EXTRA_VIDEO_IDS || '').split(',').filter(Boolean);
    const allKnownIds = [...new Set([...EXTRA_IDS])];
    const missingIds = allKnownIds.filter(id => !ownVideos.has(id));

    if (missingIds.length > 0) {
        console.log(`  🎯 Fetching ${missingIds.length} extra videos qua page navigation...`);
        for (const videoId of missingIds) {
            try {
                const videoUrl = `https://www.tiktok.com/@${username}/video/${videoId}`;
                await page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 15000 });
                await new Promise(r => setTimeout(r, 2000));

                const videoData = await page.evaluate(() => {
                    try {
                        const root = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
                        const scope = root?.['__DEFAULT_SCOPE__'];
                        // Video page SSR data is in 'webapp.video-detail'
                        const detail = scope?.['webapp.video-detail'];
                        if (detail?.itemInfo?.itemStruct) return detail.itemInfo.itemStruct;
                        // Fallback: try other paths
                        if (detail?.itemStruct) return detail.itemStruct;
                        return null;
                    } catch { return null; }
                });

                if (videoData) {
                    videoData._source = 'own';
                    ownVideos.set(videoId, videoData);
                    console.log(`    ✅ ${videoId}: "${(videoData.desc || '').slice(0, 40)}"`);
                } else {
                    console.log(`    ⚠️ ${videoId}: no SSR data on video page`);
                }
            } catch (e) {
                console.log(`    ❌ ${videoId}: ${e.message}`);
            }
        }
        // Navigate back to profile for Reposts tab
        await page.goto(`https://www.tiktok.com/@${username}`, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
    }

    console.log(`  ✅ Videos tab xong: ${ownVideos.size} videos gốc`);

    // Phân trang cho post/item_list nếu có
    for (const [apiPath, state] of apiEndpoints) {
        if (!state.hasMore) continue;
        let { url: templateUrl, cursor } = state;
        console.log(`  Phân trang ${apiPath} (cursor=${cursor})...`);

        for (let i = 0; i < 10; i++) {
            try {
                const nextUrl = templateUrl.replace(/cursor=\d+/, `cursor=${cursor}`);
                const moreData = await page.evaluate(async (fetchUrl) => {
                    const r = await fetch(fetchUrl, { credentials: 'include' });
                    return r.json();
                }, nextUrl);

                if (moreData.itemList && moreData.itemList.length > 0) {
                    moreData.itemList.forEach(v => {
                        v._source = 'own';
                        ownVideos.set(v.id, v);
                    });
                    console.log(`  [${apiPath}] +${moreData.itemList.length} (own total: ${ownVideos.size})`);
                }
                if (!moreData.hasMore) break;
                cursor = moreData.cursor || '0';
            } catch (e) { break; }
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
        const result = await scrapeVideos(DEFAULT_USERNAME);
        videos = result.videos;
        cookies = result.cookies;
        console.log(`  ✅ Videos: ${videos.length} items (source: ${result.source})`);
    } catch (err) {
        console.error(`  ❌ Videos lỗi: ${err.message}`);
    }

    // 3. Đẩy sang Node 1
    if (profile || videos.length > 0) {
        await pushToApiServer(profile, videos, cookies);
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
