const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_ROWS = 50000;
const SESSION_COOKIE = 'webdev_app_session';
const OAUTH_STATE_COOKIE = 'inventario_oauth_state';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const AUTH_USERS = Object.freeze({
  'admin@inter.com.br': { role: 'admin', label: 'Administrador' },
  'yan@inter.com.br': { role: 'viewer', label: 'Cliente visualizador' }
});
const REQUIRED_HEADERS = ['Nº','Filial','Setor','Localização','Responsável','Hostname','Usuário','Processador','Núcleos','Threads','Sistema','Build','RAM','Disco','Coleta','Arquivo de origem'];
const STATUS_HEADER = 'Status patrimonial';
const ASSET_HEADER = 'Patrimônio';
const OPERATIONAL_STATUS_HEADER = 'Status operacional';
const ANYDESK_HEADER = 'AnyDesk';
const OPERATIONAL_STATUS_VALUES = ['Ativo', 'Em manutenção', 'Reserva', 'Backup', 'Desativado', 'Em substituição', 'Aguardando definição de setor'];
const STATUS_VALUES = ['Alugada', 'Patrimônio', 'Pessoal'];
const STATUS_ALIASES = ['status patrimonial','status do ativo','tipo de patrimonio','tipo de patrimônio','tipo de ativo','situacao patrimonial','situação patrimonial','propriedade','posse','alugado','alugada','locado','locada'];
function normalizeLabel(value) { return String(value ?? '').trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function findStatusHeader(headers) { return headers.find((h) => STATUS_ALIASES.includes(normalizeLabel(h)) || normalizeLabel(h).includes('alugad') || normalizeLabel(h).includes('locad')); }
function normalizeSector(value) { const label = normalizeLabel(value); return ['alugado','alugada','aluguel'].includes(label) ? 'ALUGUEL' : String(value ?? '').trim(); }
function isAuxiliaryMemoryRow(row) { const sector = normalizeLabel(row?.Setor); const combined = normalizeLabel([row?.Setor, row?.Responsável, row?.Hostname, row?.Processador, row?.Sistema].join(' ')); const memoryLabel = /(?:\d+\s*(?:gb|gib)\s*(?:de\s*)?ram|ram\s*(?:de\s*)?\d+\s*(?:gb|gib)?|memoria(?:\s+ram)?\s*\d*\s*(?:gb|gib)?)/i.test(combined); const helperLabel = /legenda|observacao|informacao|dados|memoria|memória|\bram\b/i.test(combined); const invalidNumber = !/^\d+$/.test(String(row?.['Nº'] ?? '').trim()); const hasEquipmentIdentity = [row?.Responsável, row?.Hostname, row?.Processador, row?.Sistema].some(value => String(value ?? '').trim() !== ''); return /^(?:\d+\s*(?:gb|gib)\s*(?:de\s*)?ram|ram\s*(?:de\s*)?\d+\s*(?:gb|gib)?|memoria\s*(?:ram\s*)?\d*)/i.test(sector) || (memoryLabel && !hasEquipmentIdentity) || (helperLabel && !String(row?.Sistema ?? '').trim()) || (invalidNumber && !String(row?.Sistema ?? '').trim()); }
function removeAuxiliaryMemoryRows(rows) { return rows.filter(row => !isAuxiliaryMemoryRow(row)); }
function sanitizeStoredPayload(payload) { if (!payload || !Array.isArray(payload.Rows)) return { payload, removed: 0 }; const rows = removeAuxiliaryMemoryRows(payload.Rows); const removed = payload.Rows.length - rows.length; if (removed) { payload.Rows = rows; payload.Count = rows.length; } return { payload, removed }; }
function validateInfrastructurePayload(payload) { const assets = payload?.Assets || payload?.assets; if (!Array.isArray(assets) || assets.length > MAX_ROWS) throw new Error('Payload de infraestrutura inválido.'); const normalized = assets.filter(item => item && typeof item === 'object').map(item => Object.fromEntries(Object.entries(item).map(([key,value]) => [key, value ?? null]))); return { Version: 1, SourceFile: String(payload.SourceFile || payload.sourceFile || 'infraestrutura.xlsx'), ImportedAt: new Date().toISOString(), Count: normalized.length, Assets: normalized }; }
function extractAssetNumber(value) { const text = String(value ?? '').trim(); if(/^\d+$/.test(text)) return text; const match = text.match(/patrim(?:o|ô)nio\s*[:\/\-]?\s*(?:n[º°o]?|numero|número)?\s*[:#-]?\s*(\d+)/i) || text.match(/(?:aluguel|alugada|alugado).*?(\d+)\s*$/i); return match ? String(match[1]) : null; }
function normalizeStatus(value, header = '') { const label = normalizeLabel(value); const headerLabel = normalizeLabel(header); if (label.includes('pessoal') || label.includes('usuario') || label.includes('usuário')) return 'Pessoal'; if ((headerLabel.includes('alug') || headerLabel.includes('locad')) && ['sim','yes','true','1'].includes(label)) return 'Alugada'; return label.includes('alug') || label.includes('locad') ? 'Alugada' : 'Patrimônio'; }
function normalizeOperationalStatus(value) { const label = normalizeLabel(value); const aliases = { ativo: 'Ativo', 'em manutencao': 'Em manutenção', manutencao: 'Em manutenção', reserva: 'Reserva', backup: 'Backup', desativado: 'Desativado', 'em substituicao': 'Em substituição', 'aguardando setor': 'Aguardando definição de setor', 'aguardando definicao de setor': 'Aguardando definição de setor' }; return aliases[label] || 'Ativo'; }
let pool;

app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

function safeEqual(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireImportToken(req, res, next) {
  const configured = process.env.INVENTORY_IMPORT_TOKEN;
  const supplied = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!configured || !safeEqual(supplied, configured)) {
    return res.status(401).json({ error: 'Token de importação inválido ou ausente.' });
  }
  next();
}

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function parseCookies(header) {
  return String(header || '').split(';').reduce((out, part) => {
    const index = part.indexOf('=');
    if (index < 0) return out;
    const key = part.slice(0, index).trim();
    if (key) out[key] = decodeURIComponent(part.slice(index + 1).trim());
    return out;
  }, {});
}
function cookieSecure(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return String(process.env.PUBLIC_ORIGIN || '').startsWith('https://') || forwarded === 'https';
}
function serializeCookie(name, value, req, maxAge) {
  const secure = cookieSecure(req);
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${secure ? 'None' : 'Lax'}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function publicOrigin(req) {
  const configured = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || '').split(',')[0].trim() || req.get('host');
  const localHost = host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('0.0.0.0');
  const proto = forwardedProto || (localHost ? 'http' : 'https');
  return `${proto}://${host}`;
}
function identityFromObject(identity) {
  const source = identity || {};
  const email = normalizeEmail(source.email || source.mail || source.preferred_username || source.user?.email || source.profile?.email);
  const mapped = AUTH_USERS[email];
  if (!mapped) return null;
  return { email, openId: String(source.openId || source.open_id || source.sub || ''), name: String(source.name || source.displayName || source.user?.name || email), role: mapped.role, roleLabel: mapped.label };
}
function verifyPlatformJwt(token) {
  const secret = process.env.MANUS_JWT_SECRET;
  if (!secret) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const [encodedHeader, encodedPayload, signature] = parts;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null;
    const expected = crypto.createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    if (payload.exp && Number(payload.exp) * 1000 <= Date.now()) return null;
    if (process.env.MANUS_PROJECT_ID && payload.appId && String(payload.appId) !== String(process.env.MANUS_PROJECT_ID)) return null;
    return payload;
  } catch (_) { return null; }
}
async function resolveAuthUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const platformIdentity = verifyPlatformJwt(token);
  if (platformIdentity) return identityFromObject(platformIdentity);
  if (!pool) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const [rows] = await pool.query('SELECT email, open_id, display_name, role FROM auth_sessions WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP LIMIT 1', [tokenHash]);
  if (!rows.length) return null;
  const row = rows[0];
  const mapped = AUTH_USERS[normalizeEmail(row.email)];
  if (!mapped || mapped.role !== row.role) return null;
  return { email: normalizeEmail(row.email), openId: String(row.open_id || ''), name: String(row.display_name || row.email), role: row.role, roleLabel: mapped.label };
}
async function requireAuth(req, res, next) {
  try {
    const user = await resolveAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Autenticação necessária.', code: 'AUTH_REQUIRED' });
    req.authUser = user;
    next();
  } catch (_) { res.status(500).json({ error: 'Não foi possível validar a sessão.' }); }
}
function requireAdmin(req, res, next) {
  if (req.authUser?.role !== 'admin') return res.status(403).json({ error: 'Acesso exclusivo para administradores.', code: 'ADMIN_REQUIRED' });
  next();
}
async function exchangeManusCode(code, redirectUri) {
  const base = String(process.env.MANUS_OAUTH_API_URL || '').replace(/\/$/, '');
  if (!base || !process.env.MANUS_PROJECT_ID) throw new Error('OAuth do Manus não está configurado no ambiente.');
  const response = await fetch(`${base}/webdev.v1.WebDevAuthPublicService/ExchangeToken`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: process.env.MANUS_PROJECT_ID, grantType: 'authorization_code', code, redirectUri }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.accessToken) throw new Error('Não foi possível concluir o login.');
  const identityResponse = await fetch(`${base}/webdev.v1.WebDevAuthPublicService/GetUserInfo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: data.accessToken }) });
  const identity = await identityResponse.json().catch(() => ({}));
  if (!identityResponse.ok) throw new Error('Não foi possível identificar a conta Manus.');
  return identity;
}
app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await resolveAuthUser(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!user) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, user: { email: user.email, name: user.name, role: user.role, roleLabel: user.roleLabel } });
  } catch (_) { res.status(500).json({ authenticated: false, error: 'Falha ao consultar a sessão.' }); }
});
app.get('/api/auth/login', (req, res) => {
  const portal = String(process.env.MANUS_OAUTH_PORTAL_URL || '').replace(/\/$/, '');
  if (!portal || !process.env.MANUS_PROJECT_ID) return res.status(503).send('Login Manus indisponível: OAuth não configurado.');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const redirectUri = `${publicOrigin(req)}/api/auth/callback`;
  const state = Buffer.from(JSON.stringify({ nonce, redirectUri })).toString('base64url');
  res.setHeader('Set-Cookie', serializeCookie(OAUTH_STATE_COOKIE, nonce, req, 600));
  const target = `${portal}/app-auth?${new URLSearchParams({ appId: process.env.MANUS_PROJECT_ID, redirectUri, state, responseType: 'code' }).toString()}`;
  res.redirect(target);
});
app.get('/api/auth/callback', async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const parsed = JSON.parse(Buffer.from(String(req.query.state || ''), 'base64url').toString('utf8'));
    const redirectUri = `${publicOrigin(req)}/api/auth/callback`;
    if (!parsed.nonce || !cookies[OAUTH_STATE_COOKIE] || !safeEqual(parsed.nonce, cookies[OAUTH_STATE_COOKIE]) || parsed.redirectUri !== redirectUri) return res.status(400).send('Sessão de login inválida ou expirada.');
    const identity = identityFromObject(await exchangeManusCode(String(req.query.code || ''), redirectUri));
    if (!identity) return res.redirect('/?auth=denied');
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    await pool.query('DELETE FROM auth_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
    await pool.query('INSERT INTO auth_sessions (token_hash, email, open_id, display_name, role, expires_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 7 DAY))', [tokenHash, identity.email, identity.openId, identity.name, identity.role]);
    res.setHeader('Set-Cookie', [serializeCookie(SESSION_COOKIE, sessionToken, req, SESSION_TTL_SECONDS), serializeCookie(OAUTH_STATE_COOKIE, '', req, 0)]);
    res.redirect('/');
  } catch (err) { console.error('Falha no callback OAuth:', err.message); res.status(400).send('Não foi possível concluir o login. Tente novamente.'); }
});
app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token && pool) await pool.query('DELETE FROM auth_sessions WHERE token_hash = ?', [crypto.createHash('sha256').update(token).digest('hex')]);
  } catch (_) {}
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', req, 0));
  res.json({ ok: true });
});
function validatePayload(payload) {
  if (!payload || !Array.isArray(payload.Rows) && !Array.isArray(payload.rows)) {
    throw new Error('Payload precisa conter um array Rows ou rows.');
  }
  const sourceRows = payload.Rows || payload.rows;
  const rows = removeAuxiliaryMemoryRows(sourceRows);
  if (!rows.length || rows.length > MAX_ROWS) throw new Error('Quantidade de registros fora do limite permitido.');
  const headers = Array.isArray(payload.Headers) ? payload.Headers : (Array.isArray(payload.headers) ? payload.headers : REQUIRED_HEADERS);
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`Colunas obrigatórias ausentes: ${missing.join(', ')}`);
  const statusHeader = findStatusHeader(headers) || STATUS_HEADER;
  const operationalHeader = headers.find((h) => normalizeLabel(h) === normalizeLabel(OPERATIONAL_STATUS_HEADER)) || OPERATIONAL_STATUS_HEADER;
  const assetHeader = headers.find((h) => normalizeLabel(h) === 'patrimonio' || normalizeLabel(h) === 'patrimônio' || normalizeLabel(h).includes('patrimonio'));
  const anyDeskHeader = headers.find((h) => ['anydesk', 'anydeskid', 'idanydesk'].includes(normalizeLabel(h).replace(/[ -]/g, '')));
  const normalized = rows.map((row) => {
    const clean = {};
    for (const h of REQUIRED_HEADERS) clean[h] = row[h] ?? null;
    clean['Setor'] = normalizeSector(clean['Setor']);
    if (anyDeskHeader) clean[ANYDESK_HEADER] = row[anyDeskHeader] ?? row[ANYDESK_HEADER] ?? null;
    clean[STATUS_HEADER] = normalizeStatus(row[statusHeader], statusHeader);
    clean[ASSET_HEADER] = extractAssetNumber(row[assetHeader] ?? row[statusHeader]);
    clean[OPERATIONAL_STATUS_HEADER] = normalizeOperationalStatus(row[operationalHeader]);
    return clean;
  });
  return {
    Version: 1,
    SourceFile: String(payload.SourceFile || payload.sourceFile || 'importacao.xlsx'),
    ImportedAt: new Date().toISOString(),
    Count: normalized.length,
    Headers: [...REQUIRED_HEADERS, ...(anyDeskHeader ? [ANYDESK_HEADER] : []), STATUS_HEADER, ASSET_HEADER, OPERATIONAL_STATUS_HEADER],
    Rows: normalized
  };
}

async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada.');
  pool = mysql.createPool(process.env.DATABASE_URL);
  await pool.query(`CREATE TABLE IF NOT EXISTS inventory_state (
    state_key VARCHAR(64) PRIMARY KEY,
    payload JSON NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS inventory_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    state_key VARCHAR(64) NOT NULL,
    action VARCHAR(40) NOT NULL,
    source_file VARCHAR(255),
    record_count INT NOT NULL DEFAULT 0,
    summary JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_inventory_history_state_date (state_key, created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    open_id VARCHAR(255),
    display_name VARCHAR(255),
    role VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    INDEX idx_auth_sessions_expiry (expires_at),
    INDEX idx_auth_sessions_email (email)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS infrastructure_state (state_key VARCHAR(64) PRIMARY KEY, payload JSON NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  const [infraRows] = await pool.query('SELECT state_key FROM infrastructure_state WHERE state_key = ?', ['current']);
  const infraSeed = validateInfrastructurePayload(JSON.parse(fs.readFileSync(path.join(__dirname, 'infrastructure.json'), 'utf8')));
  if (!infraRows.length) await pool.query('INSERT INTO infrastructure_state (state_key, payload) VALUES (?, ?)', ['current', JSON.stringify(infraSeed)]);
  const [rows] = await pool.query('SELECT state_key, payload FROM inventory_state WHERE state_key = ?', ['current']);
  const seed = validatePayload(JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8')));
  if (!rows.length) {
    await pool.query('INSERT IGNORE INTO inventory_state (state_key, payload) VALUES (?, ?)', ['current', JSON.stringify(seed)]);
  } else {
    const current = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
    const currentRows = current.Rows || [];
    const stale66 = currentRows.find((row) => String(row['Nº']) === '66');
    const stale67 = currentRows.find((row) => String(row['Nº']) === '67');
    const stale68 = currentRows.find((row) => String(row['Nº']) === '68');
    const isKnownOldDuplicate = currentRows.length === seed.Rows.length + 1 &&
      String(stale66?.[ASSET_HEADER] || '') === '542' &&
      String(stale67?.[ASSET_HEADER] || '') === '542' &&
      String(stale68?.Setor || '') === 'BACKUP' &&
      String(stale68?.[ASSET_HEADER] || '') === '593';
    if (isKnownOldDuplicate) {
      await pool.query('UPDATE inventory_state SET payload = ? WHERE state_key = ?', [JSON.stringify(seed), 'current']);
      console.log('Migração única aplicada: estado antigo com patrimônio 542 duplicado foi corrigido.');
    }
    // Fora dessa migração específica, a base existente é a fonte de verdade.
    // Não reconciliar com data.json no reinício: preservar a última planilha importada.
  }
}

app.use('/api/inventory', requireAuth);
app.use('/api/infrastructure', requireAuth);
app.get('/_app/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ ok: true, service: 'inventarioti-api' });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'database_unavailable' });
  }
});

app.get('/api/inventory/latest', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT payload, updated_at FROM inventory_state WHERE state_key = ?', ['current']);
    if (!rows.length) return res.status(404).json({ error: 'Nenhuma base de inventário disponível.' });
    const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
    const cleaned = sanitizeStoredPayload(payload);
    if (cleaned.removed) await pool.query('UPDATE inventory_state SET payload = ? WHERE state_key = ?', [JSON.stringify(cleaned.payload), 'current']);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...cleaned.payload, UpdatedAt: rows[0].updated_at });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao consultar a base de inventário.' });
  }
});

app.get('/api/inventory/history', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, state_key, action, source_file, record_count, summary, created_at FROM inventory_history WHERE state_key = ? ORDER BY created_at DESC, id DESC LIMIT 100', ['current']);
    res.setHeader('Cache-Control', 'no-store');
    res.json(rows.map((row) => ({ ...row, summary: typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary })));
  } catch (err) { res.status(500).json({ error: 'Falha ao consultar o histórico de importações.' }); }
});

app.get('/api/infrastructure/latest', async (req, res) => { try { const [rows] = await pool.query('SELECT payload, updated_at FROM infrastructure_state WHERE state_key = ?', ['current']); if (!rows.length) return res.status(404).json({ error: 'Nenhuma base de infraestrutura cadastrada.' }); const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload; res.setHeader('Cache-Control', 'no-store'); res.json({ ...payload, UpdatedAt: rows[0].updated_at }); } catch (err) { res.status(500).json({ error: 'Falha ao consultar a infraestrutura.' }); } });
app.post('/api/infrastructure/import', requireAdmin, requireImportToken, async (req, res) => { try { const payload = validateInfrastructurePayload(req.body); await pool.query('INSERT INTO infrastructure_state (state_key, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', ['current', JSON.stringify(payload)]); res.json({ ok: true, count: payload.Count, importedAt: payload.ImportedAt }); } catch (err) { res.status(400).json({ error: err.message || 'Payload de infraestrutura inválido.' }); } });
function branchStateKey(value) { return `branch:${String(value || 'outra-filial').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'outra-filial'}`; }

app.get('/api/inventory/branch/latest', async (req, res) => {
  try {
    const key = branchStateKey(req.query.branch);
    const [rows] = await pool.query('SELECT payload, updated_at FROM inventory_state WHERE state_key = ?', [key]);
    if (!rows.length) return res.status(404).json({ error: 'Nenhuma base cadastrada para esta filial.' });
    const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...payload, UpdatedAt: rows[0].updated_at });
  } catch (err) { res.status(500).json({ error: 'Falha ao consultar a base da filial.' }); }
});

app.post('/api/inventory/branch/import', requireAdmin, requireImportToken, async (req, res) => {
  try {
    const payload = validatePayload(req.body);
    payload.BranchName = String(req.body.BranchName || 'Outra filial').trim().slice(0, 120);
    const key = branchStateKey(req.body.BranchKey);
    await pool.query('INSERT INTO inventory_state (state_key, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [key, JSON.stringify(payload)]);
    res.status(200).json({ ok: true, count: payload.Count, importedAt: payload.ImportedAt, branchName: payload.BranchName });
  } catch (err) { res.status(400).json({ error: err.message || 'Payload inválido.' }); }
});

app.post('/api/inventory/import', requireAdmin, requireImportToken, async (req, res) => {
  try {
    const payload = validatePayload(req.body);
    await pool.query('UPDATE inventory_state SET payload = ? WHERE state_key = ?', [JSON.stringify(payload), 'current']);
    await pool.query('INSERT INTO inventory_history (state_key, action, source_file, record_count, summary) VALUES (?, ?, ?, ?, ?)', ['current', 'import', payload.SourceFile, payload.Count, JSON.stringify(req.body.Summary || null)]);
    res.status(200).json({ ok: true, count: payload.Count, importedAt: payload.ImportedAt });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Payload inválido.' });
  }
});

app.put('/api/inventory/status', requireAdmin, requireImportToken, async (req, res) => {
  try {
    const kind = String(req.body?.Kind || req.body?.kind || 'asset').toLowerCase();
    const isOperational = kind === 'operational';
    const requested = isOperational ? normalizeOperationalStatus(req.body?.Status || req.body?.status) : normalizeStatus(req.body?.Status || req.body?.status);
    const targetHeader = isOperational ? OPERATIONAL_STATUS_HEADER : STATUS_HEADER;
    const hostname = String(req.body?.Hostname || req.body?.hostname || '').trim();
    const number = String(req.body?.Numero ?? req.body?.numero ?? '').trim();
    if (!hostname && !number) return res.status(400).json({ error: 'Informe o Hostname ou o Nº da máquina.' });
    const [currentRows] = await pool.query('SELECT payload FROM inventory_state WHERE state_key = ?', ['current']);
    if (!currentRows.length) return res.status(404).json({ error: 'Nenhuma base de inventário disponível.' });
    const payload = typeof currentRows[0].payload === 'string' ? JSON.parse(currentRows[0].payload) : currentRows[0].payload;
    payload.Headers = Array.isArray(payload.Headers) ? payload.Headers : [...REQUIRED_HEADERS];
    if (!payload.Headers.includes(STATUS_HEADER)) payload.Headers.push(STATUS_HEADER);
    if (!payload.Headers.includes(ASSET_HEADER)) payload.Headers.push(ASSET_HEADER);
    if (!payload.Headers.includes(OPERATIONAL_STATUS_HEADER)) payload.Headers.push(OPERATIONAL_STATUS_HEADER);
    const row = payload.Rows.find((item) => (number && String(item['Nº']) === number) || (hostname && String(item.Hostname || '').trim() === hostname));
    if (!row) return res.status(404).json({ error: 'Máquina não encontrada na base atual.' });
    row[targetHeader] = requested;
    payload.ImportedAt = new Date().toISOString();
    await pool.query('UPDATE inventory_state SET payload = ? WHERE state_key = ?', [JSON.stringify(payload), 'current']);
    await pool.query('INSERT INTO inventory_history (state_key, action, source_file, record_count, summary) VALUES (?, ?, ?, ?, ?)', ['current', 'status_update', 'atualização manual', payload.Rows.length, JSON.stringify({ kind, status: requested, hostname: row.Hostname, numero: row['Nº'] })]);
    res.json({ ok: true, status: requested, kind, hostname: row.Hostname, numero: row['Nº'] });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Não foi possível atualizar o status.' });
  }
});

app.get('/data.json', (req, res) => res.status(404).end());
app.get('/infrastructure.json', (req, res) => res.status(404).end());
app.use(express.static(path.join(__dirname, 'dist'), { index: 'index.html', maxAge: '1h' }));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

(async () => {
  try {
    await initDb();
    app.listen(PORT, '0.0.0.0', () => console.log(`Inventário TI API listening on ${PORT}`));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
