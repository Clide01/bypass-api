const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const API_KEY = process.env.API_KEY || 'my-secret-key';
const app = express();
app.use(express.json());

// Protect all routes under /api with the key
app.use('/api', (req, res, next) => {
  const providedKey = req.headers['x-api-key'];
  if (providedKey !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
});

// ================================================================
// BYPASS HANDLERS
// ================================================================

/**
 * Platoboost handler: follows redirects to extract a key.
 * Example: https://gateway.platoboost.com/a/8?id=...
 */ 
async function bypassPlatoboost(url) {
  try {
    // First request to the gateway
    const resp = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: status => status < 400,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    // Often the key is inside a <pre>, <code> or <textarea> tag
    const $ = cheerio.load(resp.data);
    let key = $('pre, code, textarea').first().text().trim();
    if (key && key.length > 10) return key;

    // Fallback: look for a JavaScript redirect
    const redirectMatch = resp.data.match(/window\.location\s*=\s*['"]([^'"]+)['"]/);
    if (redirectMatch) {
      const nextUrl = new URL(redirectMatch[1], url).href;
      const redirectResp = await axios.get(nextUrl, {
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const $2 = cheerio.load(redirectResp.data);
      key = $2('pre, code, textarea').first().text().trim();
      if (key) return key;
    }

    // Last attempt: search for a long alphanumeric string (typical key format)
    const bodyText = $('body').text();
    const keyRegex = /[A-Za-z0-9_\-]{20,}/;
    const match = bodyText.match(keyRegex);
    return match ? match[0] : 'Unable to extract key';
  } catch (err) {
    throw new Error(`Platoboost bypass failed: ${err.message}`);
  }
}

const puppeteer = require('puppeteer-core');
const chromiumModule = require('@sparticuz/chromium');
// Fix CommonJS/ESM interop by unwrapping .default if present
const chromium = chromiumModule.default || chromiumModule;

async function bypassPlatoRelay(url) {
  let browser;
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
        '--disable-blink-features=AutomationControlled'
      ],
      defaultViewport: { width: 1366, height: 768 },
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    // Automatically close popup ad windows so we stay on the main tab
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        const newPage = await target.page();
        if (newPage && newPage.url() !== url) {
          console.log(`[PlatoRelay] Blocked & closed popup ad tab: ${newPage.url()}`);
          await newPage.close().catch(() => {});
        }
      }
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[PlatoRelay] Navigating to URL...`);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    const pageTitle = await page.title();
    if (pageTitle.includes('Just a moment') || pageTitle.includes('Attention Required')) {
      await browser.close();
      throw new Error('Cloudflare blocked Render datacenter IP.');
    }

    // =========================================================================
    // SMART CHECKPOINT POLLING LOOP (Runs for up to 35 seconds)
    // =========================================================================
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[PlatoRelay] Checkpoint scan attempt ${attempt}/${maxAttempts}...`);
      await new Promise(resolve => setTimeout(resolve, 3500));

      const currentUrl = page.url();
      const urlObj = new URL(currentUrl);
      const keyParam = urlObj.searchParams.get('key') || urlObj.searchParams.get('token') || urlObj.searchParams.get('k');
      
      // 1. Did we reach a URL with the final key?
      if (keyParam && keyParam.length > 15) {
        console.log(`[PlatoRelay] Success! Extracted key from URL param.`);
        await browser.close();
        return keyParam;
      }

      // 2. Is the key already visible in the HTML?
      const pageContent = await page.content();
      const $ = cheerio.load(pageContent);
      
      const selectors = ['pre', 'code', 'textarea', 'input[name="key"]', '#result', '.result', '.key'];
      for (const selector of selectors) {
        const val = $(selector).first().text().trim() || $(selector).first().val();
        if (val && val.length > 15 && !val.includes('http') && !val.includes('script')) {
          console.log(`[PlatoRelay] Success! Extracted key from DOM element: ${selector}`);
          await browser.close();
          return val;
        }
      }

      // 3. Look for and click ANY button/link to advance the checkpoint
      const clicked = await page.evaluate(() => {
        // Search buttons, links, divs, and spans that act like buttons
        const elements = Array.from(document.querySelectorAll('button, a, div[role="button"], span[role="button"], [class*="btn"], [class*="button"]'));
        
        for (const el of elements) {
          const text = (el.innerText || el.textContent || '').toLowerCase().trim();
          // Avoid clicking "Discord" or "Support" links
          if (text.includes('discord') || text.includes('support') || text.includes('tutorial')) continue;

          if (
            text.includes('continue') ||
            text.includes('get key') ||
            text.includes('free access') ||
            text.includes('proceed') ||
            text.includes('verify') ||
            text.includes('next')
          ) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
            return text;
          }
        }
        return null;
      });

      if (clicked) {
        console.log(`[PlatoRelay] Clicked checkpoint button: "${clicked}"`);
      }

      // 4. Also check if there is a Cloudflare Turnstile iframe box to click
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
    // FINAL FALLBACK SCAN
    // =========================================================================
    const finalContent = await page.content();
    const $ = cheerio.load(finalContent);
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    console.log(`[PlatoRelay] Final Page Text Preview: "${bodyText.substring(0, 150)}..."`);

    // Check JavaScript variables for key strings
    const scripts = $('script').toArray();
    for (const script of scripts) {
      const content = $(script).html() || '';
      const keyMatches = content.match(/['"]([A-Za-z0-9_\-]{25,})['"]/g);
      if (keyMatches) {
        for (const match of keyMatches) {
          const clean = match.replace(/['"]/g, '');
          if (!clean.includes('http') && !clean.includes('script') && !clean.includes('function')) {
            await browser.close();
            return clean;
          }
        }
      }
    }

    // Last resort DOM regex scan
    const potentialKeys = bodyText.match(/[A-Za-z0-9_\-]{20,80}/g) || [];
    const excludedWords = ['script', 'function', 'window', 'document', 'javascript', 'browser', 'chrome', 'firefox', 'chromium', 'cloudflare', 'platorelay', 'completed', 'continue'];

    for (const key of potentialKeys) {
      if (!excludedWords.some(word => key.toLowerCase().includes(word)) && !key.startsWith('http')) {
        await browser.close();
        return key;
      }
    }

    await browser.close();
    return 'Key not found on page';
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw new Error(`PlatoRelay bypass failed: ${err.message}`);
  }
}

// --- ENHANCED GENERIC BYPASS ---
async function bypassGeneric(url) {
  try {
    // Step 1: First request - follow redirects to get the final page
    let resp = await axios.get(url, {
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': url,
        'Cache-Control': 'no-cache'
      }
    });

    const html = resp.data;
    const $ = cheerio.load(html);

    // Step 2: Try common key containers first
    const selectors = [
      'pre', 'code', 'textarea', 
      'input[name="key"]', 'input[id*="key"]',
      'div.key', 'span.key', 'p.key',
      '.generated-key', '#generated-key',
      '.bypass-key', '#bypass-key'
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      let value = element.text().trim() || element.val();
      if (value && value.length > 10 && !value.includes(' ') && value !== 'undefined') {
        return value;
      }
    }

    // Step 3: Look for JavaScript variables containing keys
    const jsPatterns = [
      /var\s+key\s*=\s*['"]([^'"]+)['"]/i,
      /var\s+bypass\s*=\s*['"]([^'"]+)['"]/i,
      /var\s+result\s*=\s*['"]([^'"]+)['"]/i,
      /['"]([A-Za-z0-9_\-]{25,})['"]/g,
      /const\s+\w+\s*=\s*['"]([A-Za-z0-9_\-]{25,})['"]/g
    ];

    for (const pattern of jsPatterns) {
      const matches = html.match(pattern);
      if (matches) {
        for (const match of matches) {
          const clean = match.replace(/^['"]|['"]$/g, '').replace(/^var \w+ = ['"]|^const \w+ = ['"]/i, '');
          if (clean.length > 15 && !clean.includes('http') && !clean.includes(' ')) {
            return clean;
          }
        }
      }
    }

    // Step 4: Look for any long alphanumeric string (likely a key)
    const bodyText = $('body').text();
    const keyRegex = /([A-Za-z0-9_\-]{20,60})/g;
    const allMatches = bodyText.match(keyRegex);
    
    if (allMatches) {
      // Filter out common false positives
      const excludedWords = ['script', 'function', 'window', 'document', 'javascript', 'stylesheet', 'analytics', 'google', 'facebook'];
      for (const match of allMatches) {
        if (!excludedWords.some(word => match.toLowerCase().includes(word))) {
          return match;
        }
      }
    }

    // Step 5: Check for iframe or meta redirect
    const iframeSrc = $('iframe').attr('src');
    if (iframeSrc && iframeSrc.startsWith('http')) {
      // Recursively follow the iframe
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

  const lowerUrl = url.toLowerCase();
  let result;

  try {
    // Route to the appropriate handler based on the domain
    if (lowerUrl.includes('platoboost.com') || lowerUrl.includes('gateway.platoboost.com')) {
    result = await bypassPlatoboost(url);
    } else if (lowerUrl.includes('platorelay.com')) {
    result = await bypassPlatoRelay(url);
    } else if (lowerUrl.includes('linkvertise.com') || lowerUrl.includes('lootlabs.com')) {
    result = await bypassGeneric(url);
    } else {
    result = await bypassGeneric(url);
    }

    return res.json({ result });
  } catch (err) {
    console.error(`Bypass error for ${url}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ================================================================
// HEALTH CHECK (no API key required)
// ================================================================
app.get('/', (req, res) => {
  res.send('Custom Bypass API running');
});

// ================================================================
// START SERVER
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});