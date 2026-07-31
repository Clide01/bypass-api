const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Allow your frontend's origin (or * for testing)
app.use(cors({ origin: '*' }));

// Parse JSON bodies (if you want to proxy POST requests)
app.use(express.json());

// Main proxy endpoint
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url parameter' });
  }

  try {
    // Fetch the real API
    const response = await fetch(targetUrl, {
      headers: {
        // You can add fixed headers here, e.g. an API key
        // 'Authorization': 'Bearer YOUR_SECRET_KEY',
        'User-Agent': 'MyBypasser/1.0'
      }
    });

    const data = await response.text();

    // Forward the content type and status
    res.set('Content-Type', response.headers.get('content-type') || 'application/json');
    res.status(response.status).send(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Proxy request failed' });
  }
});

// Health check
app.get('/', (req, res) => res.send('API Bypasser is running'));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});