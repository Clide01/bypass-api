const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const API_KEY = process.env.API_KEY || 'my-secret-key';

const app = express();
app.use(express.json());

// --- BYPASS HANDLERS ---

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

    // Often the key is inside a <pre> or <code> tag
    const $ = cheerio.load(resp.data);
    const key = $('pre, code, textarea').first().text().trim();
    if (key && key.length > 10) return key;

    // Fallback: follow a possible redirect link
    const redirectMatch = resp.data.match(/window\.location\s*=\s*['"]([^'"]+)['"]/);
    if (redirectMatch) {
      const nextUrl = new URL(redirectMatch[1], url).href;
      const redirectResp = await axios.get(nextUrl, {
        maxRedirects: 5,
        headers: { 'User-Agent': '...' }
      });
      const $2 = cheerio.load(redirectResp.data);
      const key2 = $2('pre, code, textarea').first().text().trim();
      return key2 || 'Key not found after redirect';
    }

    return 'Unable to extract key';
  } catch (err) {
    throw new Error(`Platoboost bypass failed: ${err.message}`);
  }
}

// --- GENERIC BYPASS (linkvertise, lootlabs, etc.) ---
async function bypassGeneric(url) {
  // Many ad-links finally redirect to the target if we use the correct headers
  try {
    const resp = await axios.get(url, {
      maxRedirects: 0,
      headers: {
        'User-Agent': 'Mozilla/5.0 ...',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': url
      }
    });

    // If it returns a 301/302 redirect, follow it automatically
    if (resp.status === 301 || resp.status === 302) {
      const location = resp.headers.location;
      if (!location) throw new Error('Redirect without location');
      // Recursive follow (simple)
      return bypassGeneric(new URL(location, url).href);
    }

    // Otherwise, try to find a key in the body
    const $ = cheerio.load(resp.data);
    const key = $('pre, code, textarea, input[name="key"]').first().text().trim()
               || $('body').text().match(/[A-Z0-9_]{20,}/)?.[0];
    return key || 'Key not found on page';
  } catch (err) {
    throw new Error(`Generic bypass failed: ${err.message}`);
  }
}

// --- MAIN BYPASS ENDPOINT ---
app.post('/api/bypass', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing "url" in body' });

  const lowerUrl = url.toLowerCase();
  let result;

  try {
    if (lowerUrl.includes('platoboost.com') || lowerUrl.includes('gateway.platoboost.com')) {
      result = await bypassPlatoboost(url);
    } else if (lowerUrl.includes('linkvertise.com') || lowerUrl.includes('lootlabs.com')) {
      // For now, use generic – you can write dedicated handlers later
      result = await bypassGeneric(url);
    } else {
      // Fallback
      result = await bypassGeneric(url);
    }

    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
});

// --- HEALTH CHECK ---
app.get('/', (req, res) => res.send('Custom Bypass API running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API on port ${PORT}`));