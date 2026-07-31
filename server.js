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

// Enable trust proxy for rate limiting on Render
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting with proxy trust enabled
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

// Protect all routes under /api with the key
app.use('/api', (req, res, next) => {
    const providedKey = req.headers['x-api-key'];
    if (providedKey !== API_KEY) {
        return res.status(403).json({ error: 'Invalid API key' });
    }
    next();
});

// ================================================================
// IMPROVED KEY VALIDATION FUNCTIONS
// ================================================================

function isMD5Hash(str) {
    // Check if it's a 32-character hexadecimal string
    return /^[0-9a-f]{32}$/i.test(str);
}

function isSHAHash(str) {
    // Check if it's a 40-character or 64-character hexadecimal string
    return /^[0-9a-f]{40}$/i.test(str) || /^[0-9a-f]{64}$/i.test(str);
}

function isFreeKey(key) {
    if (!key || typeof key !== 'string') return false;
    key = key.trim().toUpperCase();
    // Key starts with FREE or contains FREE_ or FREE-
    return key.startsWith('FREE') || /FREE[_\-\s]/.test(key);
}

function isValidKey(key) {
    if (!key || typeof key !== 'string') return false;
    key = key.trim();
    
    // Must be at least 10 characters
    if (key.length < 10) return false;
    
    // Filter out MD5 and SHA hashes
    if (isMD5Hash(key) || isSHAHash(key)) {
        console.log(`[Filter] Filtered out hash: ${key.substring(0, 10)}...`);
        return false;
    }
    
    // Must not be a common false positive
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
    
    if (falsePositives.some(word => key.toLowerCase().includes(word))) {
        return false;
    }
    
    // Must contain at least one letter and one number, or be a valid key format
    const hasLetters = /[a-zA-Z]/.test(key);
    const hasNumbers = /[0-9]/.test(key);
    
    // Keys should be alphanumeric with underscores or dashes
    const isValidFormat = /^[A-Za-z0-9_\-]+$/.test(key);
    
    return (hasLetters && hasNumbers) && isValidFormat;
}

// ================================================================
// ENHANCED PLATORELAY HANDLER
// ================================================================

async function bypassPlatoRelay(url) {
    let browser = null;
    let page = null;
    let allExtractedKeys = [];
    let finalKey = null;
    
    try {
        console.log(`[PlatoRelay] Starting bypass for: ${url.substring(0, 80)}...`);

        // Launch browser
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
                '--js-flags=--max-old-space-size=512',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-web-security',
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--window-size=1366,768',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-client-side-phishing-detection',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-translate',
                '--metrics-recording-only',
                '--no-first-run',
                '--safebrowsing-disable-auto-update',
                '--password-store=basic',
                '--use-mock-keychain'
            ],
            defaultViewport: { width: 1366, height: 768 },
            executablePath: await chromium.executablePath(),
            headless: true,
            timeout: 60000,
            ignoreDefaultArgs: ['--enable-automation']
        });

        // Handle popups
        browser.on('targetcreated', async (target) => {
            try {
                if (target.type() === 'page') {
                    const newPage = await target.page();
                    if (newPage) {
                        const pageUrl = await newPage.url().catch(() => 'about:blank');
                        if (pageUrl === 'about:blank' || 
                            pageUrl.includes('google') || 
                            pageUrl.includes('doubleclick') || 
                            pageUrl.includes('facebook') || 
                            pageUrl.includes('twitter')) {
                            await newPage.close().catch(() => {});
                        }
                    }
                }
            } catch (e) {}
        });

        // Create main page
        page = await browser.newPage();
        
        // Set up page
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        
        // Block unnecessary resources
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            const url = req.url();
            if (['image', 'media', 'font'].includes(type) ||
                url.includes('google-analytics') ||
                url.includes('doubleclick') ||
                url.includes('facebook.com/tr') ||
                url.includes('googletagmanager')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Set extra headers
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        });

        console.log(`[PlatoRelay] Navigating to URL...`);
        
        // Navigate with retries
        let navigationSuccess = false;
        
        for (let navAttempt = 1; navAttempt <= 3; navAttempt++) {
            try {
                console.log(`[PlatoRelay] Navigation attempt ${navAttempt}/3`);
                
                const response = await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                
                if (response) {
                    navigationSuccess = true;
                    console.log(`[PlatoRelay] Navigation successful! Status: ${response.status()}`);
                    break;
                }
            } catch (navError) {
                console.log(`[PlatoRelay] Navigation attempt ${navAttempt} failed: ${navError.message}`);
                if (navAttempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        if (!navigationSuccess) {
            throw new Error('Failed to navigate to URL after 3 attempts');
        }

        // Wait for page to settle
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Check for Cloudflare
        try {
            const pageTitle = await page.title();
            if (pageTitle && (pageTitle.includes('Just a moment') || pageTitle.includes('Attention Required') || pageTitle.includes('Cloudflare'))) {
                console.log('[PlatoRelay] Cloudflare detected, waiting...');
                await new Promise(resolve => setTimeout(resolve, 15000));
            }
        } catch (e) {}

        // =========================================================================
        // MAIN EXTRACTION LOOP - Click through all steps until we find the FREE key
        // =========================================================================
        let stepCount = 0;
        const maxSteps = 30;
        let previousUrl = '';
        let sameUrlCount = 0;

        while (stepCount < maxSteps && !finalKey) {
            stepCount++;
            console.log(`[PlatoRelay] Step ${stepCount}/${maxSteps} - Looking for key...`);

            try {
                // Check if page is still alive
                const currentUrl = await page.url().catch(() => 'about:blank');
                if (currentUrl === 'about:blank') {
                    console.log('[PlatoRelay] Page went blank, reloading...');
                    await page.reload().catch(() => {});
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }

                // If URL hasn't changed in 3 steps, we might be stuck
                if (currentUrl === previousUrl) {
                    sameUrlCount++;
                    if (sameUrlCount > 3) {
                        console.log('[PlatoRelay] URL stuck, trying to force click...');
                        // Try to click anything that might advance
                        await page.evaluate(() => {
                            const elements = document.querySelectorAll('button, a, [role="button"]');
                            for (const el of elements) {
                                if (el.offsetParent !== null) {
                                    el.click();
                                    break;
                                }
                            }
                        });
                        sameUrlCount = 0;
                    }
                } else {
                    sameUrlCount = 0;
                    previousUrl = currentUrl;
                }

                console.log(`[PlatoRelay] Current URL: ${currentUrl.substring(0, 80)}...`);

                // ==========================================
                // EXTRACT KEYS FROM CURRENT PAGE
                // ==========================================
                const pageContent = await page.content();
                if (!pageContent || pageContent.length < 100) {
                    console.log('[PlatoRelay] Page content is empty, waiting...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }

                const $ = cheerio.load(pageContent);

                // 1. Check for FREE key in text content
                const bodyText = $('body').text();
                
                // Look for FREE_XXXX or FREE-XXXX patterns
                const freePatterns = [
                    /FREE_[A-Za-z0-9]{8,}/g,
                    /FREE-[A-Za-z0-9]{8,}/g,
                    /FREE[A-Za-z0-9_\-]{10,}/g,
                    /FREE\s*[:=]\s*['"]([^'"]+)['"]/g,
                    /['"](FREE[A-Za-z0-9_\-]{10,})['"]/g
                ];

                for (const pattern of freePatterns) {
                    const matches = bodyText.match(pattern);
                    if (matches) {
                        for (const match of matches) {
                            let clean = match.replace(/['"]/g, '').trim();
                            // Extract just the key part
                            const keyMatch = clean.match(/(FREE[A-Za-z0-9_\-]{10,})/);
                            if (keyMatch) {
                                const key = keyMatch[1];
                                if (isValidKey(key) || isFreeKey(key)) {
                                    console.log(`[PlatoRelay] ✅ FOUND FREE KEY in text: ${key}`);
                                    finalKey = key;
                                    break;
                                }
                            }
                        }
                    }
                    if (finalKey) break;
                }

                // 2. Check elements for FREE key
                if (!finalKey) {
                    const selectors = [
                        'pre', 'code', 'textarea',
                        '.key', '#key', '.result', '#result',
                        '.free-key', '#free-key', '.freekey', '#freekey',
                        '.bypass-key', '#bypass-key',
                        '.generated-key', '#generated-key',
                        '.output', '#output', '.response', '#response',
                        '[data-key]', '[data-result]', '[data-free]',
                        '.value', '#value', '.code', '#code'
                    ];

                    for (const selector of selectors) {
                        try {
                            const elements = $(selector);
                            if (elements.length > 0) {
                                const element = elements.first();
                                let val = element.text().trim() || element.val();
                                if (val && val.length > 10) {
                                    // Check if it's a FREE key
                                    if (isFreeKey(val) && isValidKey(val)) {
                                        console.log(`[PlatoRelay] ✅ FOUND FREE KEY in ${selector}: ${val}`);
                                        finalKey = val;
                                        break;
                                    }
                                    // Store as candidate if not a hash
                                    if (!isMD5Hash(val) && !isSHAHash(val) && val.length > 20) {
                                        allExtractedKeys.push(val);
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }

                // 3. Check JavaScript for FREE key
                if (!finalKey) {
                    try {
                        const scripts = $('script').toArray();
                        for (const script of scripts) {
                            const content = $(script).html() || '';
                            
                            // Look for FREE keys in JS
                            const jsPatterns = [
                                /['"](FREE[A-Za-z0-9_\-]{10,})['"]/g,
                                /FREE_[A-Za-z0-9]{8,}/g,
                                /FREE-[A-Za-z0-9]{8,}/g,
                                /FREE[A-Za-z0-9_\-]{10,}/g
                            ];
                            
                            for (const pattern of jsPatterns) {
                                const matches = content.match(pattern);
                                if (matches) {
                                    for (const match of matches) {
                                        const clean = match.replace(/['"]/g, '').trim();
                                        const keyMatch = clean.match(/(FREE[A-Za-z0-9_\-]{10,})/);
                                        if (keyMatch) {
                                            const key = keyMatch[1];
                                            if (isValidKey(key) || isFreeKey(key)) {
                                                console.log(`[PlatoRelay] ✅ FOUND FREE KEY in JavaScript: ${key}`);
                                                finalKey = key;
                                                break;
                                            }
                                        }
                                    }
                                }
                                if (finalKey) break;
                            }
                            if (finalKey) break;
                        }
                    } catch (e) {}
                }

                // ==========================================
                // CLICK BUTTONS TO ADVANCE
                // ==========================================
                if (!finalKey) {
                    // Try to find and click the continue button
                    const clicked = await page.evaluate(() => {
                        // Common button texts for PlatoRelay
                        const buttonTexts = [
                            'continue', 'get key', 'free access', 'proceed', 
                            'verify', 'next', 'claim', 'unlock', 'generate', 
                            'submit', 'go', 'start', 'begin', 'click here',
                            'show key', 'view key', 'reveal key', 'get free key'
                        ];
                        
                        // Find all clickable elements
                        const elements = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
                        
                        for (const el of elements) {
                            // Check if element is visible
                            const rect = el.getBoundingClientRect();
                            if (rect.width === 0 || rect.height === 0) continue;
                            
                            const text = (el.innerText || el.textContent || el.value || '').toLowerCase().trim();
                            
                            // Skip navigation/discord links
                            if (text.includes('discord') || text.includes('support') || 
                                text.includes('tutorial') || text.includes('home') ||
                                text.includes('login') || text.includes('sign up') ||
                                text.includes('privacy') || text.includes('terms')) continue;
                            
                            // Check if text matches our targets
                            for (const target of buttonTexts) {
                                if (text.includes(target)) {
                                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    el.click();
                                    return target;
                                }
                            }
                            
                            // Also click if it has key-related classes
                            const classes = el.className || '';
                            if (classes.includes('btn') || classes.includes('button') || 
                                classes.includes('continue') || classes.includes('next') ||
                                classes.includes('submit') || classes.includes('proceed')) {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                el.click();
                                return 'button with class: ' + classes;
                            }
                        }
                        return null;
                    });

                    if (clicked) {
                        console.log(`[PlatoRelay] Clicked: "${clicked}"`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    } else {
                        console.log('[PlatoRelay] No clickable button found, waiting...');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }

                // If we found the key, break out of the loop
                if (finalKey) break;

            } catch (stepError) {
                console.log(`[PlatoRelay] Step ${stepCount} error: ${stepError.message}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }
        }

        // =========================================================================
        // POST-LOOP: If we found a key, return it
        // =========================================================================
        if (finalKey) {
            console.log(`[PlatoRelay] ✅ SUCCESS! Final key: ${finalKey}`);
            await browser.close().catch(() => {});
            return finalKey;
        }

        // =========================================================================
        // FALLBACK: Search all collected keys for FREE key
        // =========================================================================
        const freeKeys = allExtractedKeys.filter(key => isFreeKey(key) && isValidKey(key));
        if (freeKeys.length > 0) {
            const bestKey = freeKeys[0];
            console.log(`[PlatoRelay] ✅ Using FREE key from fallback: ${bestKey}`);
            await browser.close().catch(() => {});
            return bestKey;
        }

        // Check if any key is valid (filter out hashes)
        const validKeys = allExtractedKeys.filter(key => isValidKey(key) && !isMD5Hash(key) && !isSHAHash(key));
        if (validKeys.length > 0) {
            console.log(`[PlatoRelay] Using best valid key: ${validKeys[0]}`);
            await browser.close().catch(() => {});
            return validKeys[0];
        }

        // =========================================================================
        // FINAL FALLBACK: Try one more time to get the FREE key from page
        // =========================================================================
        try {
            console.log('[PlatoRelay] Final fallback - scanning page one more time...');
            const finalContent = await page.content();
            if (finalContent) {
                const $ = cheerio.load(finalContent);
                const bodyText = $('body').text();
                
                // Look for any FREE key pattern
                const finalPattern = /(FREE[A-Za-z0-9_\-]{10,})/g;
                const matches = bodyText.match(finalPattern);
                if (matches) {
                    for (const match of matches) {
                        if (isValidKey(match) || isFreeKey(match)) {
                            console.log(`[PlatoRelay] ✅ Found FREE key in final scan: ${match}`);
                            await browser.close().catch(() => {});
                            return match;
                        }
                    }
                }
            }
        } catch (e) {}

        // Clean up
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
        
        return 'Key not found on page';
        
    } catch (err) {
        console.error(`[PlatoRelay] Fatal error: ${err.message}`);
        if (browser) {
            try {
                await browser.close();
            } catch (e) {}
            browser = null;
        }
        throw new Error(`PlatoRelay bypass failed: ${err.message}`);
    }
}

// ================================================================
// PLATOBOOST HANDLER
// ================================================================

async function bypassPlatoboost(url) {
    try {
        const resp = await axios.get(url, {
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: 20000
        });

        const html = resp.data;
        const $ = cheerio.load(html);
        
        // Look for FREE key first
        const bodyText = $('body').text();
        const freeMatches = bodyText.match(/FREE[A-Za-z0-9_\-]{10,}/g);
        if (freeMatches) {
            for (const match of freeMatches) {
                if (match.length > 15 && !match.includes('http')) {
                    return match;
                }
            }
        }

        // Then look for other keys
        const selectors = ['pre', 'code', 'textarea', '.key', '#key', '.result', '#result'];
        for (const selector of selectors) {
            const val = $(selector).first().text().trim();
            if (val && val.length > 15 && !isMD5Hash(val) && !isSHAHash(val)) {
                return val;
            }
        }

        return 'Unable to extract key';
    } catch (err) {
        throw new Error(`Platoboost bypass failed: ${err.message}`);
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
                'Referer': url,
                'Cache-Control': 'no-cache'
            },
            timeout: 20000
        });

        const html = resp.data;
        const $ = cheerio.load(html);

        // Look for FREE key first
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
            'input[name="key"]', 'input[id*="key"]', 'input[name="token"]',
            'div.key', 'span.key', 'p.key', '.key',
            '.generated-key', '#generated-key',
            '.bypass-key', '#bypass-key',
            '.result', '#result', '.bypass-result',
            '[data-key]', '[data-token]',
            '.free-key', '#free-key'
        ];

        for (const selector of selectors) {
            const element = $(selector).first();
            let value = element.text().trim() || element.val();
            if (value && value.length > 10 && !value.includes(' ') && value !== 'undefined' && value !== 'null') {
                if (!isMD5Hash(value) && !isSHAHash(value)) {
                    return value;
                }
            }
        }

        const jsPatterns = [
            /var\s+key\s*=\s*['"]([^'"]+)['"]/i,
            /var\s+bypass\s*=\s*['"]([^'"]+)['"]/i,
            /var\s+result\s*=\s*['"]([^'"]+)['"]/i,
            /var\s+token\s*=\s*['"]([^'"]+)['"]/i,
            /const\s+\w+\s*=\s*['"]([A-Za-z0-9_\-]{25,})['"]/g,
            /let\s+\w+\s*=\s*['"]([A-Za-z0-9_\-]{25,})['"]/g,
            /['"](FREE[A-Za-z0-9_\-]{10,})['"]/g,
            /['"]([A-Za-z0-9_\-]{25,})['"]/g
        ];

        for (const pattern of jsPatterns) {
            const matches = html.match(pattern);
            if (matches) {
                for (const match of matches) {
                    let clean = match.replace(/^['"]|['"]$/g, '').trim();
                    clean = clean.replace(/^(var|const|let)\s+\w+\s*=\s*['"]/i, '');
                    if (clean.length > 15 && !clean.includes('http') && !clean.includes(' ') && !clean.includes('undefined')) {
                        if (!isMD5Hash(clean) && !isSHAHash(clean)) {
                            return clean;
                        }
                    }
                }
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
    
    if (!url) {
        return res.status(400).json({ error: 'Missing "url" in body' });
    }

    try {
        new URL(url);
    } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    const cacheKey = url.toLowerCase();
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
        console.log(`[Cache] Hit for ${url.substring(0, 50)}...`);
        return res.json({ 
            result: cachedResult,
            cached: true,
            timestamp: new Date().toISOString()
        });
    }

    const lowerUrl = url.toLowerCase();
    let result;

    try {
        if (lowerUrl.includes('platoboost.com') || lowerUrl.includes('gateway.platoboost.com')) {
            result = await bypassPlatoboost(url);
        } else if (lowerUrl.includes('platorelay.com') || lowerUrl.includes('auth.platorelay.com')) {
            result = await bypassPlatoRelay(url);
        } else {
            result = await bypassGeneric(url);
        }

        if (result && !result.includes('Unable') && !result.includes('failed') && result.length > 5) {
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

// ================================================================
// HEALTH CHECK
// ================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        cacheSize: cache.keys().length,
        memoryUsage: process.memoryUsage()
    });
});

app.get('/', (req, res) => {
    res.json({
        name: 'NovaBypass API',
        version: '2.0.0',
        status: 'operational',
        endpoints: {
            '/api/bypass': 'POST - Bypass ad links',
            '/health': 'GET - Health check'
        }
    });
});

// ================================================================
// ERROR HANDLING
// ================================================================

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ================================================================
// START SERVER
// ================================================================

app.listen(PORT, () => {
    console.log(`✅ NovaBypass API server listening on port ${PORT}`);
    console.log(`📊 Cache TTL: ${CACHE_TTL}s, Max Keys: ${MAX_CACHE_SIZE}`);
    console.log(`🔒 Trust proxy enabled for rate limiting`);
});