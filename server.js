'use strict';

const express      = require('express');
const session      = require('express-session');
const bcrypt       = require('bcryptjs');
const https        = require('https');
const { createClient } = require('@supabase/supabase-js');
const pgSession        = require('connect-pg-simple')(session);

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const POKEPRICE_KEY  = process.env.POKEPRICE_KEY;
const POKEPRICE_BASE = 'https://api.pokeprice.io';
const SESSION_SECRET = process.env.SESSION_SECRET || 'pokevault-secret-change-me';

if (!SUPABASE_URL || !SUPABASE_KEY || !POKEPRICE_KEY || !process.env.DATABASE_URL) {
  console.error('Missing required environment variables. Check SUPABASE_URL, SUPABASE_KEY, POKEPRICE_KEY, DATABASE_URL.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sessionStore = new pgSession({
  conString:            process.env.DATABASE_URL,
  tableName:            'session',
  createTableIfMissing: true,
});

const app = express();
app.use(express.json());
app.use(session({
  store:             sessionStore,
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' },
}));

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ── Shape converter ────────────────────────────────────────────────────────
function toClient(c) {
  return {
    id:            c.id,
    name:          c.name,
    set:           c.set_name,
    type:          c.type,
    grade:         c.grade,
    quantity:      c.quantity       ?? 1,
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
    imageUrl:      c.image_url      ?? null,
    tcgId:         c.tcg_id         ?? null,
    cardNumber:    c.card_number    ?? null,
  };
}

// ── PokéPrice proxy ────────────────────────────────────────────────────────
function pokePriceFetch(path) {
  return new Promise((resolve, reject) => {
    const url     = new URL(POKEPRICE_BASE + path);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers: {
        'X-Api-Key':    POKEPRICE_KEY,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

app.post('/api/pokeprice/search', requireAuth, async (req, res) => {
  const { name, number, setName, promo } = req.body;
  if (!name && !number)
    return res.status(400).json({ error: 'Provide at least a name or card number.' });
  try {
    const params = new URLSearchParams();
    if (name)    params.set('name',    name.trim());
    if (number)  params.set('number',  String(number).trim());
    if (setName) params.set('setName', setName.trim());
    if (promo)   params.set('promo',   'true');
    const { status, data } = await pokePriceFetch(`/cards/search?${params}`);
    if (status !== 200) return res.status(502).json({ error: 'PokéPrice API error', detail: data });
    res.json(data);
  } catch (e) {
    console.error('pokeprice search exception', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/pokeprice/card/:id', requireAuth, async (req, res) => {
  try {
    const { status, data } = await pokePriceFetch(`/cards/${encodeURIComponent(req.params.id)}`);
    if (status !== 200) return res.status(502).json({ error: 'PokéPrice API error', detail: data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

app.get('/api/pokeprice/price/:id', requireAuth, async (req, res) => {
  try {
    const { status, data } = await pokePriceFetch(`/prices/${encodeURIComponent(req.params.id)}`);
    if (status !== 200) return res.status(502).json({ error: 'PokéPrice API error', detail: data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// ── Auth routes ────────────────────────────────────────────────────────────
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

// ── Card routes ────────────────────────────────────────────────────────────
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
    lastUpdated, url, priceHistory, imageUrl, tcgId, cardNumber,
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
    image_url:      imageUrl   ?? null,
    tcg_id:         tcgId      ?? null,
    card_number:    cardNumber ?? null,
  };
  const { error } = await supabase.from('cards').insert([record]);
  if (error) return res.status(500).json({ error: 'Failed to save card' });
  res.json(toClient({ ...record, sold: false }));
});

app.put('/api/cards/:id', requireAuth, async (req, res) => {
  const { currentValue, lastUpdated, priceHistory } = req.body;
  const { error } = await supabase.from('cards')
    .update({ current_value: currentValue, last_updated: lastUpdated, price_history: priceHistory })
    .eq('id', req.params.id).eq('user_id', req.session.userId);
  if (error) return res.status(500).json({ error: 'Failed to update card' });
  res.json({ ok: true });
});

app.patch('/api/cards/:id', requireAuth, async (req, res) => {
  const fieldMap = {
    name: 'name', set: 'set_name', type: 'type', grade: 'grade',
    quantity: 'quantity', purchasePrice: 'purchase_price', purchaseDate: 'purchase_date',
    targetPrice: 'target_price', notes: 'notes', url: 'url',
    sold: 'sold', soldPrice: 'sold_price', soldDate: 'sold_date', soldTo: 'sold_to',
    imageUrl: 'image_url', tcgId: 'tcg_id', cardNumber: 'card_number',
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

// ── Static ─────────────────────────────────────────────────────────────────
app.use(express.static('.'));
app.listen(process.env.PORT || 5000, () => console.log('PokeVault v7 running'));
