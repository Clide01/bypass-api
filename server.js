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
// IMPROVED EXTRACTION UTILITIES
// ================================================================

function isValidKey(key) {
    if (!key || typeof key !== 'string') return false;
    key = key.trim();
    
    // Must be at least 10 characters
    if (key.length < 10) return false;
    
    // Must not be a common false positive
    const falsePositives = [
        'undefined', 'null', 'true', 'false', 'nan', 'infinity',
        'script', 'function', 'window', 'document', 'javascript',
        'localhost', 'https', 'http', 'www', 'com', 'org', 'net',
        'cloudflare', 'platorelay', 'platoboost', 'linkvertise',
        'please', 'wait', 'continue', 'loading', 'processing',
        'discord', 'support', 'tutorial', 'home', 'login', 'signup'
    ];
    
    if (falsePositives.some(word => key.toLowerCase().includes(word))) {
        return false;
    }
    
    // Must contain letters or be a proper key format
    const hasLetters = /[a-zA-Z]/.test(key);
    const hasNumbers = /[0-9]/.test(key);
    
    // Keys should be alphanumeric with underscores or dashes
    const isValidFormat = /^[A-Za-z0-9_\-]+$/.test(key);
    
    return (hasLetters || hasNumbers) && isValidFormat;
}

function isFreeKey(key) {
    if (!key || typeof key !== 'string') return false;
    key = key.trim().toUpperCase();
    // Key starts with FREE or contains FREE as a word
    return key.startsWith('FREE') || key.includes('FREE_') || key.includes('FREE-');
}

function isLikelyKey(key) {
    if (!key || typeof key !== 'string') return false;
    key = key.trim();
    
    // Must be a reasonable length
    if (key.length < 15 || key.length > 80) return false;
    
    // Must not be a hash (hexadecimal only)
    if (/^[0-9a-f]{32}$/i.test(key)) return false;
    
    // Must not be base64 encoded (looks like random characters)
    if (/^[A-Za-z0-9+/=]+$/.test(key) && key.length > 30) {
        // Check if it's likely base64
        const base64Score = (key.match(/[A-Z]/g) || []).length / key.length;
        if (base64Score > 0.7) return false;
    }
    
    return isValidKey(key);
}

// ================================================================
// COMPLETELY REWRITTEN PLATORELAY HANDLER WITH BETTER EXTRACTION
// ================================================================

async function bypassPlatoRelay(url) {
    let browser = null;
    let page = null;
    let allExtractedKeys = [];
    
    try {
        console.log(`[PlatoRelay] Starting bypass for: ${url.substring(0, 100)}...`);

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
            timeout: 45000,
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
        let currentUrl = url;
        
        for (let navAttempt = 1; navAttempt <= 3; navAttempt++) {
            try {
                console.log(`[PlatoRelay] Navigation attempt ${navAttempt}/3`);
                
                const response = await page.goto(currentUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                
                if (response && response.ok()) {
                    navigationSuccess = true;
                    console.log(`[PlatoRelay] Navigation successful! Status: ${response.status()}`);
                    break;
                } else if (response) {
                    navigationSuccess = true;
                    break;
                }
            } catch (navError) {
                console.log(`[PlatoRelay] Navigation attempt ${navAttempt} failed: ${navError.message}`);
                if (navError.message.includes('closed') || navError.message.includes('Session closed')) {
                    try {
                        await page.close().catch(() => {});
                        page = await browser.newPage();
                        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                        await page.setRequestInterception(true);
                        page.on('request', (req) => {
                            const type = req.resourceType();
                            const url = req.url();
                            if (['image', 'media', 'font'].includes(type) ||
                                url.includes('google-analytics') ||
                                url.includes('doubleclick')) {
                                req.abort();
                            } else {
                                req.continue();
                            }
                        });
                    } catch (e) {}
                }
                if (navAttempt < 3) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        // Wait for page to settle
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Check for Cloudflare
        try {
            const pageTitle = await page.title();
            if (pageTitle && (pageTitle.includes('Just a moment') || pageTitle.includes('Attention Required') || pageTitle.includes('Cloudflare'))) {
                console.log('[PlatoRelay] Cloudflare detected, waiting...');
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        } catch (e) {}

        // =========================================================================
        // ENHANCED EXTRACTION LOOP - PRIORITIZING "FREE" KEYS
        // =========================================================================
        let extractedKey = null;
        const maxAttempts = 25;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`[PlatoRelay] Extraction attempt ${attempt}/${maxAttempts}...`);
            
            try {
                await new Promise(resolve => setTimeout(resolve, 2500));

                // Check if page is still alive
                try {
                    const currentUrl = await page.url();
                    if (currentUrl === 'about:blank') {
                        console.log('[PlatoRelay] Page is blank, continuing...');
                        continue;
                    }
                } catch (e) {
                    continue;
                }

                // 1. Check URL parameters first (quickest)
                try {
                    const currentUrl = await page.url();
                    const urlObj = new URL(currentUrl);
                    
                    const paramNames = ['key', 'token', 'k', 'code', 'id', 'result', 'free', 'freekey', 'keycode'];
                    for (const param of paramNames) {
                        const value = urlObj.searchParams.get(param);
                        if (value && value.length > 10) {
                            console.log(`[PlatoRelay] Found potential key in URL param ${param}: ${value.substring(0, 20)}...`);
                            // Check if it starts with FREE
                            if (value.toUpperCase().startsWith('FREE')) {
                                console.log(`[PlatoRelay] ✅ Found FREE key in URL!`);
                                extractedKey = value;
                                break;
                            }
                            // Store as candidate
                            if (isLikelyKey(value)) {
                                allExtractedKeys.push(value);
                            }
                        }
                    }
                    if (extractedKey) break;
                } catch (e) {}

                // 2. Get page content
                try {
                    const pageContent = await page.content();
                    if (!pageContent || pageContent.length < 100) {
                        continue;
                    }
                    
                    const $ = cheerio.load(pageContent);
                    
                    // 3. Check specific elements that might contain the key
                    const keySelectors = [
                        'pre', 'code', 'textarea',
                        '.key', '#key', '.result', '#result',
                        '.free-key', '#free-key',
                        '.bypass-key', '#bypass-key',
                        '.generated-key', '#generated-key',
                        '.output', '#output', '.response', '#response',
                        '.script-key', '#script-key',
                        '[data-key]', '[data-result]', '[data-free]'
                    ];
                    
                    for (const selector of keySelectors) {
                        try {
                            const elements = $(selector);
                            if (elements.length > 0) {
                                const element = elements.first();
                                let val = element.text().trim() || element.val();
                                if (val && val.length > 10) {
                                    console.log(`[PlatoRelay] Found potential key in ${selector}: ${val.substring(0, 20)}...`);
                                    
                                    // Check if it starts with FREE
                                    if (val.toUpperCase().startsWith('FREE')) {
                                        console.log(`[PlatoRelay] ✅ Found FREE key in ${selector}!`);
                                        extractedKey = val;
                                        break;
                                    }
                                    
                                    // Store as candidate
                                    if (isLikelyKey(val)) {
                                        allExtractedKeys.push(val);
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                    if (extractedKey) break;

                    // 4. Search for "FREE" in the page text
                    try {
                        const bodyText = $('body').text();
                        
                        // Look for patterns like FREE_XXXXXXXX or FREE-XXXXXXXX
                        const freePatterns = [
                            /FREE_[A-Za-z0-9]{8,}/g,
                            /FREE-[A-Za-z0-9]{8,}/g,
                            /FREE[A-Za-z0-9_\-]{8,}/g,
                            /FREE\s*[:=]\s*['"]([^'"]+)['"]/g,
                            /['"](FREE[A-Za-z0-9_\-]{10,})['"]/g,
                            /(FREE[A-Za-z0-9_\-]{10,})/g
                        ];
                        
                        for (const pattern of freePatterns) {
                            const matches = bodyText.match(pattern);
                            if (matches) {
                                for (const match of matches) {
                                    // Clean up the match
                                    let clean = match.replace(/['"]/g, '').trim();
                                    // Extract just the key part
                                    const keyMatch = clean.match(/(FREE[A-Za-z0-9_\-]{10,})/);
                                    if (keyMatch) {
                                        const key = keyMatch[1];
                                        console.log(`[PlatoRelay] ✅ Found FREE key in text: ${key}`);
                                        extractedKey = key;
                                        break;
                                    }
                                }
                            }
                            if (extractedKey) break;
                        }
                        if (extractedKey) break;
                    } catch (e) {}

                    // 5. Search JavaScript for FREE keys
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
                                            console.log(`[PlatoRelay] ✅ Found FREE key in JavaScript: ${key}`);
                                            extractedKey = key;
                                            break;
                                        }
                                    }
                                }
                                if (extractedKey) break;
                            }
                            if (extractedKey) break;
                        }
                        if (extractedKey) break;
                    } catch (e) {}

                    // 6. Check input fields for values
                    try {
                        const inputs = $('input[type="text"], input[type="hidden"]');
                        for (const input of inputs) {
                            const val = $(input).val();
                            if (val && val.length > 10) {
                                if (val.toUpperCase().startsWith('FREE')) {
                                    console.log(`[PlatoRelay] ✅ Found FREE key in input!`);
                                    extractedKey = val;
                                    break;
                                }
                                if (isLikelyKey(val)) {
                                    allExtractedKeys.push(val);
                                }
                            }
                        }
                        if (extractedKey) break;
                    } catch (e) {}

                } catch (e) {
                    console.log(`[PlatoRelay] Content extraction error: ${e.message}`);
                }

                // 7. Try to click buttons to advance
                try {
                    const clicked = await page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll(
                            'button, a, div[role="button"], span[role="button"], ' +
                            '[class*="btn"], [class*="button"], [class*="continue"], ' +
                            '[class*="verify"], [class*="proceed"], [class*="next"], ' +
                            '[class*="get"], [class*="claim"], [class*="unlock"], ' +
                            '[class*="generate"], [class*="submit"]'
                        ));
                        
                        const targetTexts = ['continue', 'get key', 'free access', 'proceed', 
                                           'verify', 'next', 'claim', 'unlock', 'generate', 
                                           'submit', 'go', 'start', 'begin', 'click here'];
                        
                        for (const el of buttons) {
                            const text = (el.innerText || el.textContent || '').toLowerCase().trim();
                            if (text.includes('discord') || text.includes('support') || 
                                text.includes('tutorial') || text.includes('home') ||
                                text.includes('login') || text.includes('sign up')) continue;
                            
                            if (targetTexts.some(t => text.includes(t))) {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                el.click();
                                return text;
                            }
                        }
                        return null;
                    });

                    if (clicked) {
                        console.log(`[PlatoRelay] Clicked: "${clicked}"`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                } catch (e) {}

                // 8. Handle Cloudflare challenges
                try {
                    const frames = page.frames();
                    for (const frame of frames) {
                        if (frame.url().includes('turnstile') || 
                            frame.url().includes('cloudflare') ||
                            frame.url().includes('challenges')) {
                            try {
                                const checkbox = await frame.$('input[type="checkbox"], .chk, #challenge-stage, .cf-turnstile');
                                if (checkbox) {
                                    await checkbox.click();
                                    console.log('[PlatoRelay] Clicked Cloudflare challenge');
                                    await new Promise(resolve => setTimeout(resolve, 3000));
                                }
                            } catch (e) {}
                        }
                    }
                } catch (e) {}

            } catch (loopError) {
                console.log(`[PlatoRelay] Loop iteration ${attempt} error: ${loopError.message}`);
                continue;
            }
        }

        // =========================================================================
        // FINAL EXTRACTION - PRIORITIZE FREE KEYS
        // =========================================================================
        
        // If we found a FREE key, use it
        if (extractedKey && isFreeKey(extractedKey)) {
            console.log(`[PlatoRelay] ✅ Using FREE key: ${extractedKey}`);
            await browser.close().catch(() => {});
            return extractedKey;
        }

        // If we have a key that starts with FREE but wasn't caught
        const freeKeyCandidates = allExtractedKeys.filter(key => isFreeKey(key));
        if (freeKeyCandidates.length > 0) {
            const bestKey = freeKeyCandidates[0];
            console.log(`[PlatoRelay] ✅ Using FREE key from candidates: ${bestKey}`);
            await browser.close().catch(() => {});
            return bestKey;
        }

        // Check all extracted keys for FREE pattern
        for (const key of allExtractedKeys) {
            if (isFreeKey(key)) {
                console.log(`[PlatoRelay] ✅ Using FREE key from all keys: ${key}`);
                await browser.close().catch(() => {});
                return key;
            }
        }

        // Fallback: look for any key
        const validKeys = allExtractedKeys.filter(key => isValidKey(key));
        if (validKeys.length > 0) {
            console.log(`[PlatoRelay] Using best valid key: ${validKeys[0]}`);
            await browser.close().catch(() => {});
            return validKeys[0];
        }

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

/**
 * Platoboost handler
 */
async function bypassPlatoboost(url) {
    try {
        const resp = await axios.get(url, {
            maxRedirects: 0,
            validateStatus: status => status < 400,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: 15000
        });

        const $ = cheerio.load(resp.data);
        
        const extractors = [
            () => $('pre, code, textarea').first().text().trim(),
            () => {
                const match = resp.data.match(/window\.location\s*=\s*['"]([^'"]+)['"]/);
                if (match) return match[1];
                return null;
            },
            () => {
                const match = resp.data.match(/window\.open\s*\(\s*['"]([^'"]+)['"]/);
                if (match) return match[1];
                return null;
            },
            () => {
                const match = resp.data.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
                if (match) return match[1];
                return null;
            },
            () => {
                const bodyText = $('body').text();
                const keyRegex = /FREE[A-Za-z0-9_\-]{10,}/;
                const match = bodyText.match(keyRegex);
                return match ? match[0] : null;
            },
            () => {
                const bodyText = $('body').text();
                const keyRegex = /[A-Za-z0-9_\-]{25,}/;
                const match = bodyText.match(keyRegex);
                return match ? match[0] : null;
            }
        ];

        for (const extractor of extractors) {
            const result = extractor();
            if (result && result.length > 15 && !result.includes('http') && !result.includes('script')) {
                // Prioritize keys that start with FREE
                if (result.toUpperCase().startsWith('FREE')) {
                    return result;
                }
                // Store but continue looking for FREE
                if (result.length > 20) {
                    return result;
                }
            }
        }

        const redirectMatch = resp.data.match(/window\.location\s*=\s*['"]([^'"]+)['"]/);
        if (redirectMatch) {
            const nextUrl = new URL(redirectMatch[1], url).href;
            const redirectResp = await axios.get(nextUrl, {
                maxRedirects: 5,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 15000
            });
            const $2 = cheerio.load(redirectResp.data);
            const key = $2('pre, code, textarea').first().text().trim();
            if (key && key.length > 15) return key;
        }

        return 'Unable to extract key';
    } catch (err) {
        throw new Error(`Platoboost bypass failed: ${err.message}`);
    }
}

/**
 * Generic bypass handler with FREE key prioritization
 */
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

        // First try to find FREE keys
        const bodyText = $('body').text();
        const freeMatches = bodyText.match(/FREE[A-Za-z0-9_\-]{10,}/g);
        if (freeMatches) {
            for (const match of freeMatches) {
                if (match.length > 15 && !match.includes('http')) {
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
                if (value.toUpperCase().startsWith('FREE')) {
                    return value;
                }
                if (value.length > 20) {
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
                        if (clean.toUpperCase().startsWith('FREE')) {
                            return clean;
                        }
                        if (clean.length > 20) {
                            return clean;
                        }
                    }
                }
            }
        }

        const keyRegex = /([A-Za-z0-9_\-]{20,60})/g;
        const allMatches = bodyText.match(keyRegex);
        
        if (allMatches) {
            const excludedWords = ['script', 'function', 'window', 'document', 'javascript', 
                                 'stylesheet', 'analytics', 'google', 'facebook', 'twitter',
                                 'undefined', 'null', 'true', 'false'];
            for (const match of allMatches) {
                if (!excludedWords.some(word => match.toLowerCase().includes(word)) && 
                    !match.toLowerCase().includes('http') && !match.includes(' ')) {
                    if (match.toUpperCase().startsWith('FREE')) {
                        return match;
                    }
                    if (match.length > 20) {
                        return match;
                    }
                }
            }
        }

        const iframeSrc = $('iframe').attr('src');
        if (iframeSrc && iframeSrc.startsWith('http')) {
            return await bypassGeneric(iframeSrc);
        }

        const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
        if (metaRefresh) {
            const urlMatch = metaRefresh.match(/url=(.+)/i);
            if (urlMatch) {
                return await bypassGeneric(urlMatch[1]);
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