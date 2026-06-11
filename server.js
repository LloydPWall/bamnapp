'use strict';
const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const POLL = parseInt(process.env.POLL_INTERVAL || '120000'); // ms — default 2 min
const APP_VERSION = '2.8.2';

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

// Local bookings file (persisted via Docker volume)
const LOCAL_RESV_FILE = path.join(__dirname, 'data', 'reservations.json');

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

// ── LOCAL BOOKINGS HELPERS ────────────────────────────────────────────────────
function readLocalBookings() {
  try {
    if (!fs.existsSync(LOCAL_RESV_FILE)) return [];
    return JSON.parse(fs.readFileSync(LOCAL_RESV_FILE, 'utf8'));
  } catch { return []; }
}

function writeLocalBookings(bookings) {
  fs.mkdirSync(path.dirname(LOCAL_RESV_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_RESV_FILE, JSON.stringify(bookings, null, 2));
}

// Convert a local booking object to a CSV row matching the Google Sheets format:
// Day,Date,Name,Guests,Time,Contact,Notes  (Date = DD/MM/YY)
function bookingToCSVRow(b) {
  const d = new Date(b.date + 'T12:00:00');
  const dayName = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/Berlin' });
  const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Europe/Berlin' });
  const fields = [dayName, dateStr, b.name, b.guests || '', b.time || '', b.contact || '', b.notes || ''];
  return fields.map(f => (String(f).includes(',') ? `"${f}"` : f)).join(',');
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
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering if added later
  res.flushHeaders();

  // Send heartbeat every 25s to keep connection alive through proxies/firewalls
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

// Reservations GET — merges Google Sheets cache with locally-added bookings
app.get('/api/reservations', (req, res) => {
  const sheetsText = cache.reservations.text;
  const localBookings = readLocalBookings();

  res.setHeader('Content-Type',  'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!localBookings.length) {
    if (!sheetsText) return res.status(503).send('Starting up — data not yet cached');
    return res.send(sheetsText);
  }

  const localRows = localBookings.map(bookingToCSVRow).join('\n');

  if (!sheetsText) {
    return res.send('Day,Date,Name,Guests,Time,Contact,Notes\n' + localRows);
  }

  res.send(sheetsText + '\n' + localRows);
});

// Bookings GET — local-only bookings as JSON (for edit/delete UI)
app.get('/api/bookings', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(readLocalBookings());
});

// Bookings DELETE
app.delete('/api/bookings/:id', (req, res) => {
  const bookings = readLocalBookings();
  const idx = bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  bookings.splice(idx, 1);
  writeLocalBookings(bookings);
  broadcast('reservations');
  console.log(`[booking] deleted: ${req.params.id}`);
  res.json({ ok: true });
});

// Bookings PATCH — edit an existing local booking
app.patch('/api/bookings/:id', (req, res) => {
  const bookings = readLocalBookings();
  const idx = bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { date, time, name, guests, contact, notes } = req.body || {};
  if (date)              bookings[idx].date    = date;
  if (time  !== undefined) bookings[idx].time  = time;
  if (name)              bookings[idx].name    = name.trim();
  if (guests !== undefined) bookings[idx].guests = String(guests);
  if (contact !== undefined) bookings[idx].contact = (contact || '').trim();
  if (notes  !== undefined) bookings[idx].notes   = (notes  || '').trim();
  writeLocalBookings(bookings);
  broadcast('reservations');
  console.log(`[booking] updated: ${req.params.id}`);
  res.json({ ok: true, booking: bookings[idx] });
});

// Reservations POST — save a new booking locally and broadcast update
app.post('/api/reservations', (req, res) => {
  const { date, time, name, guests, contact, notes } = req.body || {};

  if (!date || !name) {
    return res.status(400).json({ error: 'date and name are required' });
  }

  const booking = {
    id:      Date.now().toString(),
    date,
    time:    time    || '',
    name:    name.trim(),
    guests:  String(guests || '2'),
    contact: (contact || '').trim(),
    notes:   (notes   || '').trim(),
  };

  const bookings = readLocalBookings();
  bookings.push(booking);
  writeLocalBookings(bookings);

  console.log(`[booking] added: ${booking.name} ${booking.date} ${booking.time} (${booking.guests} guests)`);
  broadcast('reservations');

  res.json({ ok: true, booking });
});

// Data endpoints — one per source (reservations handled above)
for (const channel of Object.keys(SOURCES)) {
  if (channel === 'reservations') continue; // custom route above
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
  const localCount = readLocalBookings().length;
  res.json({ ok: true, clients: clients.size, cache: cacheStatus, localBookings: localCount, ts: new Date().toISOString() });
});

// Static files — serve the bamnapp frontend
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    // Always revalidate HTML and service worker — never serve stale versions
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA fallback — all other routes serve index.html
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
