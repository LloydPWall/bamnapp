'use strict';
const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const POLL = parseInt(process.env.POLL_INTERVAL || '120000'); // ms — default 2 min
const APP_VERSION = '2.8.3';

// ── DATA SOURCES ──────────────────────────────────────────────────────────────
const SECRET = process.env.SECRET || '1300';

const SOURCES = {
  schedule:     process.env.SCHED_PROXY,
  reservations: process.env.RESV_PROXY,
  tips:         process.env.TIPS_PROXY,
  notices:      process.env.NOTICES_PROXY,
  menu:         process.env.MENU_PROXY,
  specs:        process.env.SPECS_PROXY,
};

const WEATHER_URL =
  'https://api.open-meteo.com/v1/forecast' +
  '?latitude=52.499&longitude=13.404' +
  '&daily=weather_code,temperature_2m_max' +
  '&timezone=Europe%2FBerlin&forecast_days=14';

// ── IN-MEMORY CACHE ───────────────────────────────────────────────────────────
const cache = {};
for (const ch of [...Object.keys(SOURCES), 'weather']) {
  cache[ch] = { text: null };
}

// ── SSE CLIENTS ───────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(channel) {
  if (!clients.size) return;
  const msg = `data: ${JSON.stringify({ type: 'updated', channel })}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
  console.log(`[sse] ${channel} → ${clients.size} client(s)`);
}

// ── POLLING ───────────────────────────────────────────────────────────────────
async function fetchSource(channel) {
  const url = SOURCES[channel];
  if (!url) return;
  const res  = await fetch(`${url}?key=${SECRET}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.trim() === 'Unauthorised') throw new Error('Unauthorised');
  if (text !== cache[channel].text) {
    cache[channel].text = text;
    broadcast(channel);
  }
}

async function fetchWeather() {
  const res  = await fetch(WEATHER_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text !== cache.weather.text) {
    cache.weather.text = text;
    broadcast('weather');
  }
}

async function pollAll() {
  const jobs = [
    ...Object.keys(SOURCES).map(ch =>
      fetchSource(ch).catch(e => console.error(`[poll] ${ch}:`, e.message))
    ),
    fetchWeather().catch(e => console.error('[poll] weather:', e.message)),
  ];
  await Promise.allSettled(jobs);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.use(express.json());

// SSE — real-time updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); } }, 25000);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  clients.add(res);
  console.log(`[sse] client connected — ${clients.size} total`);

  req.on('close', () => {
    clearInterval(hb);
    clients.delete(res);
    console.log(`[sse] client disconnected — ${clients.size} total`);
  });
});

// Reservations POST — write new booking to Google Sheets via Apps Script
app.post('/api/reservations', async (req, res) => {
  const { date, time, name, guests, contact, notes } = req.body || {};
  if (!date || !name) return res.status(400).json({ error: 'date and name are required' });

  const url = SOURCES.reservations;
  if (!url) return res.status(503).json({ error: 'Reservations endpoint not configured' });

  try {
    const gsRes = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: SECRET, date, time, name, guests, contact, notes }),
      signal:  AbortSignal.timeout(15000),
    });
    if (!gsRes.ok) throw new Error(`HTTP ${gsRes.status}`);
    const data = await gsRes.json();
    if (data.error) throw new Error(data.error);

    console.log(`[booking] written to sheet: ${name} ${date} ${time}`);
    // Immediately re-poll reservations so the new row is cached before the next SSE poll
    fetchSource('reservations')
      .then(() => broadcast('reservations'))
      .catch(e => console.error('[booking] post-write poll failed:', e.message));

    res.json({ ok: true });
  } catch (e) {
    console.error('[booking] write to Google Sheets failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Data endpoints — one per source
for (const channel of Object.keys(SOURCES)) {
  app.get(`/api/${channel}`, (req, res) => {
    const data = cache[channel];
    if (!data.text) return res.status(503).send('Starting up — data not yet cached');
    res.setHeader('Content-Type',  'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(data.text);
  });
}

// Weather endpoint
app.get('/api/weather', (req, res) => {
  if (!cache.weather.text) return res.status(503).send('Starting up — weather not yet cached');
  res.setHeader('Content-Type',  'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(cache.weather.text);
});

// Version — used by the app to detect stale caches and self-update
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: APP_VERSION });
});

// Health / status
app.get('/api/status', (req, res) => {
  const cacheStatus = {};
  for (const [ch, v] of Object.entries(cache)) cacheStatus[ch] = !!v.text;
  res.json({ ok: true, clients: clients.size, cache: cacheStatus, ts: new Date().toISOString() });
});

// Static files — serve the bamnapp frontend
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[bamnapp] listening on port ${PORT}`);
  console.log('[bamnapp] initial data fetch…');
  await pollAll();
  console.log('[bamnapp] ready');
  setInterval(pollAll, POLL);
  console.log(`[bamnapp] polling every ${POLL / 1000}s`);
});
