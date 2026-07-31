const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');
const chromiumModule = require('@sparticuz/chromium');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');

// Fix CommonJS/ESM interop
const chromium = chromiumModule.default || chromiumModule;

// Configuration
const API_KEY = process.env.API_KEY || 'nova_secret_key_2026_xyz';
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 300;
const MAX_CACHE_SIZE = 100;

// Initialize cache
const cache = new NodeCache({ 
    stdTTL: CACHE_TTL,
    maxKeys: MAX_CACHE_SIZE,
    checkperiod: 60
});

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
}));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.ip || req.connection.remoteAddress;
    }
});
app.use('/api', limiter);

app.use('/api', (req, res, next) => {
    const providedKey = req.headers['x-api-key'];
    if (providedKey !== API_KEY) {
        return res.status(403).json({ error: 'Invalid API key' });
    }
    next();
});

// ================================================================
// KEY VALIDATION HELPERS
// ================================================================

function isMD5Hash(str) {
    return /^[0-9a-f]{32}$/i.test(str);
}

function isSHAHash(str) {
    return /^[0-9a-f]{40}$/i.test(str) || /^[0-9a-f]{64}$/i.test(str);
}

function isFreeKey(key) {
    if (!key || typeof key !== 'string') return false;
    key = key.trim().toUpperCase();
    return key.startsWith('FREE') || /FREE[_\-\s]/.test(key);
}

function isValidKey(key) {
    if (!key || typeof key !== 'string') return false;
    key = key.trim();
    if (key.length < 10) return false;
    if (isMD5Hash(key) || isSHAHash(key)) return false;
    
    const falsePositives = [
        'undefined', 'null', 'true', 'false', 'nan', 'infinity',
        'script', 'function', 'window', 'document', 'javascript',
        'localhost', 'https', 'http', 'www', 'com', 'org', 'net',
        'cloudflare', 'platorelay', 'platoboost', 'linkvertise',
        'please', 'wait', 'continue', 'loading', 'processing',
        'discord', 'support', 'tutorial', 'home', 'login', 'signup',
        'error', 'failed', 'success', 'response', 'request',
        'body', 'html', 'page', 'site', 'url', 'link'
    ];
    
    if (falsePositives.some(word => key.toLowerCase().includes(word))) return false;
    
    const hasLetters = /[a-zA-Z]/.test(key);
    const hasNumbers = /[0-9]/.test(key);
    const isValidFormat = /^[A-Za-z0-9_\-]+$/.test(key);
    
    return (hasLetters && hasNumbers) && isValidFormat;
}

// ================================================================
// STANDALONE PUPPETEER ENGINE (PlatoRelay & PlatoBoost)
// ================================================================

async function bypassPlatoRelay(url) {
    let browser = null;
    let page = null;
    let allExtractedKeys = [];
    let finalKey = null;
    
    try {
        console.log(`[PlatoEngine] Starting standalone headless bypass for: ${url.substring(0, 80)}...`);

        const chromiumArgs = await chromium.args;
        const baseArgs = Array.isArray(chromiumArgs) ? chromiumArgs : [];

        browser = await puppeteer.launch({
            args: [
                ...baseArgs,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
                '--js-flags=--max-old-space-size=256',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1366,768'
            ],
            defaultViewport: { width: 1366, height: 768 },
            executablePath: await chromium.executablePath(),
            headless: true,
            timeout: 45000,
            ignoreDefaultArgs: ['--enable-automation']
        });

        // Automatically close popup ads so Puppeteer stays on the main checkpoint tab
        browser.on('targetcreated', async (target) => {
            try {
                if (target.type() === 'page') {
                    const newPage = await target.page();
                    if (newPage) {
                        const pageUrl = await newPage.url().catch(() => 'about:blank');
                        if (pageUrl !== url && !pageUrl.includes('platorelay.com') && !pageUrl.includes('platoboost.com')) {
                            await newPage.close().catch(() => {});
                        }
                    }
                }
            } catch (e) {}
        });

        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        
        // =========================================================================
        // NETWORK INTERCEPTOR: Catch JSON payloads containing keys from background fetch/XHR
        // =========================================================================
        page.on('response', async (response) => {
            try {
                const resUrl = response.url();
                const contentType = response.headers()['content-type'] || '';
                if (contentType.includes('application/json') || resUrl.includes('api') || resUrl.includes('key') || resUrl.includes('auth')) {
                    const json = await response.json().catch(() => null);
                    if (json) {
                        const potentialKey = json.key || json.token || json.result || json.data || json.bypassed;
                        if (potentialKey && typeof potentialKey === 'string' && (isValidKey(potentialKey) || isFreeKey(potentialKey))) {
                            console.log(`[PlatoEngine] ⚡ INTERCEPTED KEY FROM NETWORK RESPONSE: ${potentialKey}`);
                            finalKey = potentialKey;
                        }
                    }
                }
            } catch (e) {}
        });

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            const reqUrl = req.url();
            if (['image', 'media', 'font'].includes(type) ||
                reqUrl.includes('google-analytics') ||
                reqUrl.includes('doubleclick') ||
                reqUrl.includes('googletagmanager')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log(`[PlatoEngine] Navigating to URL...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 3000));

        // =========================================================================
        // CHECKPOINT LOOP (12 attempts @ 2.5s each = 30 seconds max)
        // =========================================================================
        let stepCount = 0;
        const maxSteps = 12;
        let previousUrl = '';
        let sameUrlCount = 0;

        while (stepCount < maxSteps && !finalKey) {
            stepCount++;
            console.log(`[PlatoEngine] Step ${stepCount}/${maxSteps} - Checking for key...`);

            try {
                const currentUrl = await page.url().catch(() => 'about:blank');
                console.log(`[PlatoEngine] Current URL: ${currentUrl.substring(0, 80)}...`);

                if (currentUrl === previousUrl) {
                    sameUrlCount++;
                    if (sameUrlCount >= 4) {
                        console.log('[PlatoEngine] Stuck on same checkpoint for 4 checks, breaking loop...');
                        break;
                    }
                } else {
                    sameUrlCount = 0;
                    previousUrl = currentUrl;
                }

                // 1. CHECK URL PARAMETERS
                try {
                    const urlObj = new URL(currentUrl);
                    const keyParam = urlObj.searchParams.get('key') || urlObj.searchParams.get('token') || urlObj.searchParams.get('k');
                    if (keyParam && (isValidKey(keyParam) || isFreeKey(keyParam))) {
                        console.log(`[PlatoEngine] ✅ FOUND KEY in URL Parameter: ${keyParam}`);
                        finalKey = keyParam;
                        break;
                    }
                } catch (e) {}

                // 2. CHECK HTML TEXT CONTENT
                const pageContent = await page.content();
                const $ = cheerio.load(pageContent);
                const bodyText = $('body').text();
                
                const freePatterns = [
                    /(FREE_[A-Za-z0-9]{8,})/g,
                    /(FREE-[A-Za-z0-9]{8,})/g,
                    /(FREE[A-Za-z0-9_\-]{10,})/g
                ];

                for (const pattern of freePatterns) {
                    const matches = bodyText.match(pattern);
                    if (matches) {
                        for (const match of matches) {
                            const clean = match.trim();
                            if (isValidKey(clean) || isFreeKey(clean)) {
                                console.log(`[PlatoEngine] ✅ FOUND FREE KEY in text: ${clean}`);
                                finalKey = clean;
                                break;
                            }
                        }
                    }
                    if (finalKey) break;
                }
                if (finalKey) break;

                // 3. CHECK DOM ELEMENTS & INPUTS
                const selectors = [
                    'pre', 'code', 'textarea', '.key', '#key', '.result', '#result',
                    '.free-key', '#free-key', '.bypass-key', '#bypass-key',
                    'input[name="key"]', 'input[id*="key"]'
                ];

                for (const selector of selectors) {
                    const val = $(selector).first().text().trim() || $(selector).first().val();
                    if (val && val.length > 10) {
                        if (isFreeKey(val) || isValidKey(val)) {
                            console.log(`[PlatoEngine] ✅ FOUND KEY in ${selector}: ${val}`);
                            finalKey = val;
                            break;
                        }
                        if (!isMD5Hash(val) && !isSHAHash(val)) {
                            allExtractedKeys.push(val);
                        }
                    }
                }
                if (finalKey) break;

                // 4. CHECK LOCALSTORAGE & SESSIONSTORAGE
                const memoryKey = await page.evaluate(() => {
                    for (let i = 0; i < localStorage.length; i++) {
                        const keyName = localStorage.key(i);
                        const val = localStorage.getItem(keyName) || '';
                        if (val.includes('FREE_') || val.includes('FREE-') || (val.length > 20 && !val.includes('http'))) {
                            return val;
                        }
                    }
                    return null;
                });
                if (memoryKey && (isFreeKey(memoryKey) || isValidKey(memoryKey))) {
                    console.log(`[PlatoEngine] ✅ FOUND KEY in localStorage: ${memoryKey}`);
                    finalKey = memoryKey;
                    break;
                }

                // 5. CLICK CLOUDFLARE TURNSTILE CHECKBOX IF PRESENT
                try {
                    const frames = page.frames();
                    for (const frame of frames) {
                        if (frame.url().includes('turnstile') || frame.url().includes('cloudflare')) {
                            const checkbox = await frame.$('input[type="checkbox"], .chk, #challenge-stage');
                            if (checkbox) await checkbox.click();
                        }
                    }
                } catch (e) {}

                // 6. CLICK CHECKPOINT BUTTONS
                const clicked = await page.evaluate(() => {
                    const buttonTexts = [
                        'continue', 'get key', 'free access', 'proceed', 
                        'verify', 'next', 'claim', 'unlock', 'generate', 
                        'submit', 'go', 'start', 'reveal key', 'get free key'
                    ];
                    
                    const elements = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
                    
                    for (const el of elements) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        
                        const text = (el.innerText || el.textContent || el.value || '').toLowerCase().trim();
                        if (text.includes('discord') || text.includes('support') || text.includes('tutorial')) continue;
                        
                        for (const target of buttonTexts) {
                            if (text.includes(target)) {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                el.click();
                                return target;
                            }
                        }
                    }
                    return null;
                });

                if (clicked) {
                    console.log(`[PlatoEngine] Clicked checkpoint button: "${clicked}"`);
                    await new Promise(resolve => setTimeout(resolve, 2500));
                } else {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

            } catch (stepError) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                continue;
            }
        }

        if (finalKey) {
            await browser.close().catch(() => {});
            return finalKey;
        }

        // Fallback: Check valid candidates
        const freeKeys = allExtractedKeys.filter(key => isFreeKey(key) && isValidKey(key));
        if (freeKeys.length > 0) {
            await browser.close().catch(() => {});
            return freeKeys[0];
        }

        const validKeys = allExtractedKeys.filter(key => isValidKey(key));
        if (validKeys.length > 0) {
            await browser.close().catch(() => {});
            return validKeys[0];
        }

        await browser.close().catch(() => {});
        return 'Key not found on page';
        
    } catch (err) {
        if (browser) await browser.close().catch(() => {});
        throw new Error(`PlatoEngine bypass failed: ${err.message}`);
    }
}

// ================================================================
// GENERIC BYPASS HANDLER
// ================================================================

async function bypassGeneric(url) {
    try {
        const resp = await axios.get(url, {
            maxRedirects: 10,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': url
            },
            timeout: 20000
        });

        const html = resp.data;
        const $ = cheerio.load(html);

        const bodyText = $('body').text();
        const freeMatches = bodyText.match(/FREE[A-Za-z0-9_\-]{10,}/g);
        if (freeMatches) {
            for (const match of freeMatches) {
                if (match.length > 15 && !match.includes('http') && !isMD5Hash(match) && !isSHAHash(match)) {
                    return match;
                }
            }
        }

        const selectors = [
            'pre', 'code', 'textarea',
            'input[name="key"]', 'input[id*="key"]',
            'div.key', 'span.key', '.generated-key', '#generated-key',
            '.result', '#result', '[data-key]'
        ];

        for (const selector of selectors) {
            const val = $(selector).first().text().trim() || $(selector).first().val();
            if (val && val.length > 10 && !val.includes(' ') && !isMD5Hash(val) && !isSHAHash(val)) {
                return val;
            }
        }

        return 'Key not found on page';
    } catch (err) {
        throw new Error(`Generic bypass failed: ${err.message}`);
    }
}

// ================================================================
// MAIN BYPASS ENDPOINT
// ================================================================

app.post('/api/bypass', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing "url" in body' });

    try {
        new URL(url);
    } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    const cacheKey = url.toLowerCase();
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
        return res.json({ 
            result: cachedResult,
            cached: true,
            timestamp: new Date().toISOString()
        });
    }

    const lowerUrl = url.toLowerCase();
    let result;

    try {
        if (
            lowerUrl.includes('platoboost.com') || 
            lowerUrl.includes('gateway.platoboost.com') ||
            lowerUrl.includes('platorelay.com') || 
            lowerUrl.includes('auth.platorelay.com')
        ) {
            result = await bypassPlatoRelay(url);
        } else {
            result = await bypassGeneric(url);
        }

        if (result && !result.includes('not found') && !result.includes('failed') && result.length > 5) {
            cache.set(cacheKey, result);
        }

        return res.json({ 
            result,
            cached: false,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error(`Bypass error for ${url}:`, err.message);
        return res.status(500).json({ 
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({ name: 'NovaBypass API', version: '2.0.0', status: 'operational' });
});

app.listen(PORT, () => {
    console.log(`✅ NovaBypass API server listening on port ${PORT}`);
});