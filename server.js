'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const pgSession = require('connect-pg-simple')(session);
// ── Supabase (credentials from env) ──────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_KEY must be set in environment variables.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── PokéPrice Pro ─────────────────────────────────────────────────────────
const POKEPRICE_API_KEY = process.env.POKEPRICE_API_KEY;
if (!POKEPRICE_API_KEY) {
  console.warn('WARNING: POKEPRICE_API_KEY is not set. Price fetching will be disabled.');
}

// ── App ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.set('trust proxy', 1);
app.use(session({
  store: new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'pokevault-fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
  },
}));

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ── DB ↔ Client shape ─────────────────────────────────────────────────────
function toClient(c) {
  return {
    id:            c.id,
    name:          c.name,
    set:           c.set_name,
    type:          c.type,
    grade:         c.grade,
    quantity:      c.quantity      ?? 1,
    purchasePrice: c.purchase_price,
    purchaseDate:  c.purchase_date,
    targetPrice:   c.target_price,
    notes:         c.notes,
    currentValue:  c.current_value,
    lastUpdated:   c.last_updated,
    url:           c.url,
    priceHistory:  c.price_history  ?? [],
    sold:          c.sold           ?? false,
    soldPrice:     c.sold_price,
    soldDate:      c.sold_date,
    soldTo:        c.sold_to,
  };
}

// ── Auth routes ───────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const { data: existing } = await supabase
    .from('users').select('id').ilike('username', username.trim()).single();
  if (existing) return res.status(400).json({ error: 'Username already taken' });

  const hash = await bcrypt.hash(password, 10);
  const id   = Date.now().toString();
  const { error } = await supabase.from('users')
    .insert([{ id, username: username.trim(), password: hash }]);
  if (error) return res.status(500).json({ error: 'Failed to create account' });

  req.session.userId   = id;
  req.session.username = username.trim();
  res.json({ username: username.trim() });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const { data: user } = await supabase
    .from('users').select('*').ilike('username', username).single();
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'Invalid username or password' });

  req.session.userId   = user.id;
  req.session.username = user.username;
  res.json({ username: user.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: req.session.username });
});

// ── PokéPrice Pro proxy ───────────────────────────────────────────────────
// This keeps the API key server-side and never exposes it to the browser.
//
// PokéPrice Pro API reference:
//   Base URL: https://www.pokeprice.io/api
//   Search:   GET /search?name=<name>&set=<set>   (returns array of cards with prices)
//   Card:     GET /card/<id>                       (returns single card with full price data)
//
// We expose two endpoints to the frontend:
//   GET /api/price-search?name=<name>&set=<set>
//   GET /api/price-card/:id

app.get('/api/price-search', requireAuth, async (req, res) => {
  if (!POKEPRICE_API_KEY) return res.status(503).json({ error: 'Price API not configured' });
  const { name, set } = req.query;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const params = new URLSearchParams({ name: name.trim() });
    if (set) params.set('set', set.trim());
    const url = `https://www.pokeprice.io/api/search?${params.toString()}`;
    const upstream = await fetch(url, {
      headers: {
        'X-Api-Key': POKEPRICE_API_KEY,
        'Accept':    'application/json',
      },
    });
    if (!upstream.ok) {
      console.error('PokéPrice Pro search error:', upstream.status, await upstream.text());
      return res.status(upstream.status).json({ error: 'Price API error' });
    }
    const data = await upstream.json();
    res.json(data);
  } catch (e) {
    console.error('PokéPrice Pro search fetch failed:', e);
    res.status(500).json({ error: 'Failed to contact price API' });
  }
});

app.get('/api/price-card/:id', requireAuth, async (req, res) => {
  if (!POKEPRICE_API_KEY) return res.status(503).json({ error: 'Price API not configured' });
  try {
    const url = `https://www.pokeprice.io/api/card/${encodeURIComponent(req.params.id)}`;
    const upstream = await fetch(url, {
      headers: {
        'X-Api-Key': POKEPRICE_API_KEY,
        'Accept':    'application/json',
      },
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Price API error' });
    }
    const data = await upstream.json();
    res.json(data);
  } catch (e) {
    console.error('PokéPrice Pro card fetch failed:', e);
    res.status(500).json({ error: 'Failed to contact price API' });
  }
});

// ── Card routes ───────────────────────────────────────────────────────────
app.get('/api/cards', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('cards').select('*')
    .eq('user_id', req.session.userId)
    .order('id', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to fetch cards' });
  res.json(data.map(toClient));
});

app.post('/api/cards', requireAuth, async (req, res) => {
  const {
    name, set, type, grade, quantity, purchasePrice,
    purchaseDate, targetPrice, notes, currentValue,
    lastUpdated, url, priceHistory,
  } = req.body;
  const id     = Date.now().toString();
  const record = {
    id,
    user_id:        req.session.userId,
    name,
    set_name:       set,
    type,
    grade,
    quantity:       quantity ?? 1,
    purchase_price: purchasePrice,
    purchase_date:  purchaseDate,
    target_price:   targetPrice,
    notes,
    current_value:  currentValue,
    last_updated:   lastUpdated,
    url,
    price_history:  priceHistory ?? [],
    sold:           false,
  };
  const { error } = await supabase.from('cards').insert([record]);
  if (error) return res.status(500).json({ error: 'Failed to save card' });
  res.json(toClient({ ...record, sold: false }));
});

// Price / history update (PUT)
app.put('/api/cards/:id', requireAuth, async (req, res) => {
  const { currentValue, lastUpdated, priceHistory } = req.body;
  const { error } = await supabase.from('cards')
    .update({ current_value: currentValue, last_updated: lastUpdated, price_history: priceHistory })
    .eq('id', req.params.id).eq('user_id', req.session.userId);
  if (error) return res.status(500).json({ error: 'Failed to update card' });
  res.json({ ok: true });
});

// Partial update — edit / sell (PATCH)
app.patch('/api/cards/:id', requireAuth, async (req, res) => {
  const fieldMap = {
    name: 'name', set: 'set_name', type: 'type', grade: 'grade',
    quantity: 'quantity', purchasePrice: 'purchase_price', purchaseDate: 'purchase_date',
    targetPrice: 'target_price', notes: 'notes', url: 'url',
    sold: 'sold', soldPrice: 'sold_price', soldDate: 'sold_date', soldTo: 'sold_to',
  };
  const update = {};
  for (const [k, v] of Object.entries(fieldMap)) {
    if (req.body[k] !== undefined) update[v] = req.body[k];
  }
  if (!Object.keys(update).length)
    return res.status(400).json({ error: 'No fields to update' });

  const { error } = await supabase.from('cards')
    .update(update).eq('id', req.params.id).eq('user_id', req.session.userId);
  if (error) return res.status(500).json({ error: 'Failed to update card' });
  res.json({ ok: true });
});

app.delete('/api/cards/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('cards')
    .delete().eq('id', req.params.id).eq('user_id', req.session.userId);
  if (error) return res.status(500).json({ error: 'Failed to delete card' });
  res.json({ ok: true });
});

// ── Static files ──────────────────────────────────────────────────────────
app.use(express.static('.'));

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`PokeVault v5 running on :${PORT}`));
