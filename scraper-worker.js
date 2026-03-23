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
    // Luôn dùng Puppeteer để lấy CẢ Videos tab (own) + Reposts tab
    // External API chỉ trả về reposts, không có videos gốc
    console.log('  [Puppeteer] Bắt đầu scrape cả 2 tab...');
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const ownVideos = new Map();  // từ /api/post/item_list/
    const repostVideos = new Map(); // từ /api/repost/item_list/
    const apiEndpoints = new Map();

    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('tiktok.com/api') && url.includes('item_list')) {
            try {
                const apiPath = url.match(/\/api\/([^?]+)/)?.[1] || 'unknown';
                const json = await response.json();
                if (json.itemList && json.itemList.length > 0) {
                    const isRepost = apiPath.includes('repost');
                    const targetMap = isRepost ? repostVideos : ownVideos;
                    json.itemList.forEach(v => {
                        v._source = isRepost ? 'repost' : 'own';
                        targetMap.set(v.id, v);
                    });
                    console.log(`  [${apiPath}] +${json.itemList.length} (own: ${ownVideos.size}, reposts: ${repostVideos.size})`);
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

    // === 1. Tab VIDEOS (click để chắc chắn) ===
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
    console.log(`  Sau khi load Videos tab: own=${ownVideos.size}, reposts=${repostVideos.size}`);

    // Cuộn trang để load thêm videos
    for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`  Sau cuộn Videos tab: own=${ownVideos.size}, reposts=${repostVideos.size}`);

    // Phân trang cho post/item_list (own videos)
    for (const [apiPath, state] of apiEndpoints) {
        if (!state.hasMore || apiPath.includes('repost')) continue;
        let { url: templateUrl, cursor } = state;
        console.log(`  Phân trang ${apiPath} (cursor=${cursor})...`);

        for (let i = 0; i < 20; i++) {
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
                    console.log(`  [${apiPath}] cursor +${moreData.itemList.length} (own total: ${ownVideos.size})`);
                }
                if (!moreData.hasMore) break;
                cursor = moreData.cursor || '0';
            } catch (e) {
                console.log(`  ${apiPath} lỗi phân trang:`, e.message);
                break;
            }
        }
    }

    console.log(`  ✅ Videos tab xong: ${ownVideos.size} videos gốc`);

    // === 2. Tab REPOSTS ===
    try {
        const repostTab = await page.$('p[data-e2e="repost-tab"]');
        if (repostTab) {
            await repostTab.click();
            console.log('  🔄 Clicked tab Reposts');
            await new Promise(r => setTimeout(r, 3000));

            // Cuộn để load reposts
            for (let i = 0; i < 5; i++) {
                await page.evaluate(() => window.scrollBy(0, 800));
                await new Promise(r => setTimeout(r, 1500));
            }
            console.log(`  Sau cuộn Reposts tab: own=${ownVideos.size}, reposts=${repostVideos.size}`);

            // Phân trang reposts
            for (const [apiPath, state] of apiEndpoints) {
                if (!state.hasMore || !apiPath.includes('repost')) continue;
                let { url: templateUrl, cursor } = state;
                for (let i = 0; i < 20; i++) {
                    try {
                        const nextUrl = templateUrl.replace(/cursor=\d+/, `cursor=${cursor}`);
                        const moreData = await page.evaluate(async (fetchUrl) => {
                            const r = await fetch(fetchUrl, { credentials: 'include' });
                            return r.json();
                        }, nextUrl);

                        if (moreData.itemList && moreData.itemList.length > 0) {
                            moreData.itemList.forEach(v => {
                                v._source = 'repost';
                                repostVideos.set(v.id, v);
                            });
                            console.log(`  [${apiPath}] repost cursor +${moreData.itemList.length} (repost total: ${repostVideos.size})`);
                        }
                        if (!moreData.hasMore) break;
                        cursor = moreData.cursor || '0';
                    } catch (e) { break; }
                }
            }
        } else {
            console.log('  ℹ️ Không tìm thấy tab Reposts');
        }
    } catch (e) {
        console.log('  ⚠️ Lỗi tab Reposts:', e.message);
    }

    console.log(`  📊 Tổng cuối: own=${ownVideos.size}, reposts=${repostVideos.size}, total=${ownVideos.size + repostVideos.size}`);

    // Gộp tất cả (own videos first, then reposts)
    const allVideos = new Map([...ownVideos, ...repostVideos]);

    // Lưu cookies cho CDN proxy
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`  Lưu ${cookies.length} cookies cho CDN proxy`);

    await page.close();

    return {
        videos: formatItems(allVideos, username),
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
