const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

// --- API KEY PROTECTION ---
// Use environment variable or a default for development
const API_KEY = process.env.API_KEY || 'my-secret-key';

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
    } else if (lowerUrl.includes('linkvertise.com') || lowerUrl.includes('lootlabs.com')) {
      // Use generic handler for now; you can add dedicated ones later
      result = await bypassGeneric(url);
    } else {
      // Fallback to generic handler
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