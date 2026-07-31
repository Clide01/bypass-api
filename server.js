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
const CACHE_TTL = 300; // 5 minutes
const MAX_CACHE_SIZE = 100;

// Initialize cache
const cache = new NodeCache({ 
    stdTTL: CACHE_TTL,
    maxKeys: MAX_CACHE_SIZE,
    checkperiod: 60
});

const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disabled for bypass functionality
    crossOriginEmbedderPolicy: false
}));
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
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
// ENHANCED BYPASS HANDLERS
// ================================================================

/**
 * Platoboost handler with improved extraction
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
        
        // Try multiple extraction methods
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
                const keyRegex = /[A-Za-z0-9_\-]{25,}/;
                const match = bodyText.match(keyRegex);
                return match ? match[0] : null;
            }
        ];

        for (const extractor of extractors) {
            const result = extractor();
            if (result && result.length > 15 && !result.includes('http') && !result.includes('script')) {
                return result;
            }
        }

        // If we found a redirect URL, follow it
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
 * Enhanced PlatoRelay handler with better browser management and extraction
 */
async function bypassPlatoRelay(url) {
    let browser = null;
    let page = null;
    
    try {
        console.log(`[PlatoRelay] Launching browser for: ${url}`);

        const chromiumArgs = await chromium.args;
        const baseArgs = Array.isArray(chromiumArgs) ? chromiumArgs : [];

        browser = await puppeteer.launch({
            args: [
                ...baseArgs,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote',
                '--js-flags=--max-old-space-size=256',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-web-security',
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--disable-features=OutOfBlinkCors',
                '--window-size=1366,768'
            ],
            defaultViewport: { width: 1366, height: 768 },
            executablePath: await chromium.executablePath(),
            headless: true,
            timeout: 30000,
        });

        // Automatically close popup windows
        browser.on('targetcreated', async (target) => {
            if (target.type() === 'page') {
                const newPage = await target.page();
                if (newPage && newPage.url() !== url) {
                    console.log(`[PlatoRelay] Closed popup: ${newPage.url()}`);
                    await newPage.close().catch(() => {});
                }
            }
        });

        page = await browser.newPage();

        // Set user agent and headers
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        
        // Block unnecessary resources
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Set extra HTTP headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });

        console.log(`[PlatoRelay] Navigating to URL...`);
        await page.goto(url, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        // Check for Cloudflare
        const pageTitle = await page.title();
        if (pageTitle.includes('Just a moment') || pageTitle.includes('Attention Required')) {
            throw new Error('Cloudflare protection detected. Please try again later.');
        }

        // =========================================================================
        // SMART CHECKPOINT POLLING LOOP
        // =========================================================================
        const maxAttempts = 12;
        let extractedKey = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`[PlatoRelay] Checkpoint scan attempt ${attempt}/${maxAttempts}...`);
            await new Promise(resolve => setTimeout(resolve, 3000));

            const currentUrl = page.url();
            const urlObj = new URL(currentUrl);
            
            // Check URL parameters
            const keyParam = urlObj.searchParams.get('key') || 
                           urlObj.searchParams.get('token') || 
                           urlObj.searchParams.get('k') ||
                           urlObj.searchParams.get('code') ||
                           urlObj.searchParams.get('id');
            
            if (keyParam && keyParam.length > 15) {
                console.log(`[PlatoRelay] Extracted key from URL param: ${keyParam.substring(0, 10)}...`);
                extractedKey = keyParam;
                break;
            }

            // Check page content
            const pageContent = await page.content();
            const $ = cheerio.load(pageContent);
            
            const selectors = [
                'pre', 'code', 'textarea', 
                'input[name="key"]', 'input[name="token"]',
                '#result', '.result', '.key', '#key', 
                '.bypass-key', '#bypass-key',
                '[data-key]', '[data-result]'
            ];
            
            for (const selector of selectors) {
                const element = $(selector).first();
                let val = element.text().trim() || element.val();
                if (val && val.length > 15 && !val.includes('http') && !val.includes('script')) {
                    console.log(`[PlatoRelay] Extracted key from ${selector}`);
                    extractedKey = val;
                    break;
                }
            }
            
            if (extractedKey) break;

            // Click any button to advance
            const clicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll(
                    'button, a, div[role="button"], span[role="button"], ' +
                    '[class*="btn"], [class*="button"], [class*="continue"], ' +
                    '[class*="verify"], [class*="proceed"], [class*="next"]'
                ));
                
                const targetTexts = ['continue', 'get key', 'free access', 'proceed', 'verify', 'next', 'claim', 'unlock'];
                
                for (const el of buttons) {
                    const text = (el.innerText || el.textContent || '').toLowerCase().trim();
                    if (text.includes('discord') || text.includes('support') || text.includes('tutorial')) continue;
                    
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
            }

            // Handle Turnstile/Cloudflare challenges
            try {
                const frames = page.frames();
                for (const frame of frames) {
                    if (frame.url().includes('turnstile') || frame.url().includes('cloudflare')) {
                        const checkbox = await frame.$('input[type="checkbox"], .chk, #challenge-stage');
                        if (checkbox) await checkbox.click();
                    }
                }
            } catch (e) {}
        }

        // =========================================================================
        // FINAL EXTRACTION ATTEMPTS
        // =========================================================================
        if (!extractedKey) {
            const finalContent = await page.content();
            const $ = cheerio.load(finalContent);
            
            // Check JavaScript variables
            const scripts = $('script').toArray();
            for (const script of scripts) {
                const content = $(script).html() || '';
                const keyMatches = content.match(/['"]([A-Za-z0-9_\-]{25,})['"]/g);
                if (keyMatches) {
                    for (const match of keyMatches) {
                        const clean = match.replace(/['"]/g, '');
                        if (!clean.includes('http') && !clean.includes('script') && !clean.includes('function')) {
                            extractedKey = clean;
                            break;
                        }
                    }
                }
                if (extractedKey) break;
            }
        }

        if (!extractedKey) {
            const bodyText = await page.evaluate(() => document.body.innerText);
            const keyRegex = /[A-Za-z0-9_\-]{25,}/g;
            const matches = bodyText.match(keyRegex);
            
            if (matches) {
                const excludedWords = ['script', 'function', 'window', 'document', 'javascript', 
                                     'browser', 'chrome', 'firefox', 'chromium', 'cloudflare', 
                                     'platorelay', 'completed', 'continue', 'undefined', 'null'];
                
                for (const key of matches) {
                    if (!excludedWords.some(word => key.toLowerCase().includes(word)) && 
                        !key.startsWith('http') && key.length > 15) {
                        extractedKey = key;
                        break;
                    }
                }
            }
        }

        await browser.close();
        browser = null;
        
        return extractedKey || 'Key not found on page';
        
    } catch (err) {
        console.error(`[PlatoRelay] Error: ${err.message}`);
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
        throw new Error(`PlatoRelay bypass failed: ${err.message}`);
    }
}

/**
 * Enhanced generic bypass with better extraction
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

        // Try common key containers
        const selectors = [
            'pre', 'code', 'textarea',
            'input[name="key"]', 'input[id*="key"]', 'input[name="token"]',
            'div.key', 'span.key', 'p.key', '.key',
            '.generated-key', '#generated-key',
            '.bypass-key', '#bypass-key',
            '.result', '#result', '.bypass-result',
            '[data-key]', '[data-token]'
        ];

        for (const selector of selectors) {
            const element = $(selector).first();
            let value = element.text().trim() || element.val();
            if (value && value.length > 10 && !value.includes(' ') && value !== 'undefined' && value !== 'null') {
                return value;
            }
        }

        // Check JavaScript variables
        const jsPatterns = [
            /var\s+key\s*=\s*['"]([^'"]+)['"]/i,
            /var\s+bypass\s*=\s*['"]([^'"]+)['"]/i,
            /var\s+result\s*=\s*['"]([^'"]+)['"]/i,
            /var\s+token\s*=\s*['"]([^'"]+)['"]/i,
            /const\s+\w+\s*=\s*['"]([A-Za-z0-9_\-]{25,})['"]/g,
            /let\s+\w+\s*=\s*['"]([A-Za-z0-9_\-]{25,})['"]/g,
            /['"]([A-Za-z0-9_\-]{25,})['"]/g
        ];

        for (const pattern of jsPatterns) {
            const matches = html.match(pattern);
            if (matches) {
                for (const match of matches) {
                    let clean = match.replace(/^['"]|['"]$/g, '').trim();
                    clean = clean.replace(/^(var|const|let)\s+\w+\s*=\s*['"]/i, '');
                    if (clean.length > 15 && !clean.includes('http') && !clean.includes(' ') && !clean.includes('undefined')) {
                        return clean;
                    }
                }
            }
        }

        // Look for long alphanumeric strings
        const bodyText = $('body').text();
        const keyRegex = /([A-Za-z0-9_\-]{20,60})/g;
        const allMatches = bodyText.match(keyRegex);
        
        if (allMatches) {
            const excludedWords = ['script', 'function', 'window', 'document', 'javascript', 
                                 'stylesheet', 'analytics', 'google', 'facebook', 'twitter',
                                 'undefined', 'null', 'true', 'false'];
            for (const match of allMatches) {
                if (!excludedWords.some(word => match.toLowerCase().includes(word)) && 
                    !match.toLowerCase().includes('http') && !match.includes(' ')) {
                    return match;
                }
            }
        }

        // Check for iframe or meta redirect
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
// MAIN BYPASS ENDPOINT WITH CACHING
// ================================================================
app.post('/api/bypass', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'Missing "url" in body' });
    }

    // Validate URL
    try {
        new URL(url);
    } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Check cache
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
        // Route to appropriate handler
        if (lowerUrl.includes('platoboost.com') || lowerUrl.includes('gateway.platoboost.com')) {
            result = await bypassPlatoboost(url);
        } else if (lowerUrl.includes('platorelay.com')) {
            result = await bypassPlatoRelay(url);
        } else {
            result = await bypassGeneric(url);
        }

        // Cache successful results
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
// HEALTH CHECK ENDPOINT
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
// ERROR HANDLING MIDDLEWARE
// ================================================================
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ================================================================
// GRACEFUL SHUTDOWN
// ================================================================
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    process.exit(0);
});

// ================================================================
// START SERVER
// ================================================================
app.listen(PORT, () => {
    console.log(`✅ NovaBypass API server listening on port ${PORT}`);
    console.log(`📊 Cache TTL: ${CACHE_TTL}s, Max Keys: ${MAX_CACHE_SIZE}`);
});