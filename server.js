const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_ROWS = 50000;
const SESSION_COOKIE = 'webdev_app_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const USER_ROLES = Object.freeze({ admin: 'Administrador', viewer: 'Visualizador' });
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
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value)); }
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
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedHex] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  try {
    const actual = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}
function publicUser(row) {
  return { id: Number(row.id), name: String(row.name || ''), email: normalizeEmail(row.email), role: String(row.role), roleLabel: USER_ROLES[row.role] || row.role, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at };
}
function validateUserFields(body, { passwordRequired = true } = {}) {
  const name = String(body?.name || '').trim().slice(0, 120);
  const email = normalizeEmail(body?.email);
  const role = body?.role === 'admin' ? 'admin' : body?.role === 'viewer' ? 'viewer' : '';
  const password = String(body?.password || '');
  if (name.length < 2) throw new Error('Informe o nome do usuário.');
  if (!validEmail(email)) throw new Error('Informe um e-mail ou identificador interno válido.');
  if (!role) throw new Error('Selecione Administrador ou Visualizador.');
  if (passwordRequired && password.length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres.');
  if (!passwordRequired && password && password.length < 8) throw new Error('A nova senha deve ter pelo menos 8 caracteres.');
  return { name, email, role, password };
}
async function resolveAuthUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || !pool) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const [rows] = await pool.query(`SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.updated_at
    FROM app_sessions s JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.active = 1 LIMIT 1`, [tokenHash]);
  return rows.length ? publicUser(rows[0]) : null;
}
async function createSession(userId, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query('DELETE FROM app_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
  await pool.query('INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 7 DAY))', [tokenHash, userId]);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, req, SESSION_TTL_SECONDS));
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
app.get('/api/auth/setup-status', async (req, res) => {
  try { const [rows] = await pool.query('SELECT COUNT(*) AS total FROM app_users'); res.json({ setupRequired: Number(rows[0].total) === 0 }); }
  catch (_) { res.status(500).json({ error: 'Não foi possível consultar a configuração inicial.' }); }
});
app.post('/api/auth/setup', async (req, res) => {
  try {
    const fields = validateUserFields({ ...req.body, role: 'admin' });
    const [existing] = await pool.query('SELECT COUNT(*) AS total FROM app_users');
    if (Number(existing[0].total) > 0) return res.status(409).json({ error: 'O administrador inicial já foi criado.' });
    const [result] = await pool.query('INSERT INTO app_users (name, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)', [fields.name, fields.email, hashPassword(fields.password), 'admin']);
    const [rows] = await pool.query('SELECT id, name, email, role, active, created_at, updated_at FROM app_users WHERE id = ?', [result.insertId]);
    await createSession(result.insertId, req, res);
    res.status(201).json({ ok: true, user: publicUser(rows[0]) });
  } catch (err) { res.status(400).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Este identificador já está cadastrado.' : (err.message || 'Não foi possível criar o administrador.') }); }
});
app.get('/api/auth/me', async (req, res) => {
  try { const user = await resolveAuthUser(req); res.setHeader('Cache-Control', 'no-store'); if (!user) return res.status(401).json({ authenticated: false }); res.json({ authenticated: true, user }); }
  catch (_) { res.status(500).json({ authenticated: false, error: 'Falha ao consultar a sessão.' }); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!validEmail(email) || !password) return res.status(401).json({ error: 'Informe o identificador e a senha.' });
    const [rows] = await pool.query('SELECT id, name, email, password_hash, role, active, created_at, updated_at FROM app_users WHERE email = ? LIMIT 1', [email]);
    if (!rows.length || !rows[0].active || !verifyPassword(password, rows[0].password_hash)) return res.status(401).json({ error: 'Identificador ou senha inválidos.' });
    await createSession(rows[0].id, req, res);
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (_) { res.status(500).json({ error: 'Não foi possível realizar o login.' }); }
});
app.post('/api/auth/logout', async (req, res) => {
  try { const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]; if (token && pool) await pool.query('DELETE FROM app_sessions WHERE token_hash = ?', [crypto.createHash('sha256').update(token).digest('hex')]); }
  catch (_) {}
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', req, 0));
  res.json({ ok: true });
});
app.use('/api/users', requireAuth, requireAdmin);
async function buildBackupPayload(generatedBy, trigger) {
  const [inventoryRows] = await pool.query('SELECT state_key, payload, updated_at FROM inventory_state ORDER BY state_key');
  const [infrastructureRows] = await pool.query('SELECT state_key, payload, updated_at FROM infrastructure_state ORDER BY state_key');
  const [userRows] = await pool.query('SELECT id, name, email, role, active, created_at, updated_at FROM app_users ORDER BY id');
  const parsePayload = (row) => ({
    stateKey: row.state_key,
    updatedAt: row.updated_at,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
  });
  return {
    backupVersion: 1,
    generatedAt: new Date().toISOString(),
    trigger,
    generatedBy,
    inventory: inventoryRows.filter((row) => row.state_key === 'current').map(parsePayload),
    branches: inventoryRows.filter((row) => row.state_key !== 'current').map(parsePayload),
    infrastructure: infrastructureRows.map(parsePayload),
    users: userRows.map((user) => ({ ...user, active: Boolean(user.active) }))
  };
}
async function runAutomaticBackup() {
  let locked = false;
  try {
    const [lockRows] = await pool.query("SELECT GET_LOCK('inventarioti:daily-backup', 0) AS acquired");
    locked = Number(lockRows[0]?.acquired) === 1;
    if (!locked) return;
    const [latestRows] = await pool.query('SELECT created_at FROM backup_snapshots ORDER BY created_at DESC LIMIT 1');
    const latest = latestRows[0]?.created_at ? new Date(latestRows[0].created_at).getTime() : 0;
    if (latest && Date.now() - latest < 24 * 60 * 60 * 1000) return;
    const payload = await buildBackupPayload({ id: null, name: 'Backup automático', email: null, role: 'system' }, 'daily');
    await pool.query('INSERT INTO backup_snapshots (trigger_type, payload) VALUES (?, ?)', ['daily', JSON.stringify(payload)]);
    console.log('Backup automático diário criado.');
  } catch (err) {
    console.error('Falha no backup automático diário:', err.message);
  } finally {
    if (locked) await pool.query("SELECT RELEASE_LOCK('inventarioti:daily-backup')").catch(() => {});
  }
}
app.get('/api/admin/backup', requireAuth, requireAdmin, async (req, res) => {
  try {
    const payload = await buildBackupPayload({ id: req.authUser.id, name: req.authUser.name, email: req.authUser.email, role: req.authUser.role }, 'manual');
    const filename = `backup-inventario-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=\"${filename}\"`);
    res.json(payload);
  } catch (_) {
    res.status(500).json({ error: 'Não foi possível gerar o backup manual.' });
  }
});
app.get('/api/users', async (req, res) => {
  try { const [rows] = await pool.query('SELECT id, name, email, role, active, created_at, updated_at FROM app_users ORDER BY active DESC, name ASC'); res.json({ users: rows.map(publicUser) }); }
  catch (_) { res.status(500).json({ error: 'Não foi possível listar os usuários.' }); }
});
app.post('/api/users', async (req, res) => {
  try {
    const fields = validateUserFields(req.body);
    const [result] = await pool.query('INSERT INTO app_users (name, email, password_hash, role, active) VALUES (?, ?, ?, ?, ?)', [fields.name, fields.email, hashPassword(fields.password), fields.role, req.body.active === false ? 0 : 1]);
    const [rows] = await pool.query('SELECT id, name, email, role, active, created_at, updated_at FROM app_users WHERE id = ?', [result.insertId]);
    res.status(201).json({ ok: true, user: publicUser(rows[0]) });
  } catch (err) { res.status(400).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Este identificador já está cadastrado.' : (err.message || 'Não foi possível criar o usuário.') }); }
});
app.put('/api/users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [found] = await pool.query('SELECT id, name, email, password_hash, role, active FROM app_users WHERE id = ?', [id]);
    if (!found.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const current = found[0];
    const fields = validateUserFields({ name: req.body.name ?? current.name, email: req.body.email ?? current.email, role: req.body.role ?? current.role, password: req.body.password || '' }, { passwordRequired: false });
    const active = req.body.active === undefined ? Boolean(current.active) : Boolean(req.body.active);
    if (id === req.authUser.id && (!active || fields.role !== 'admin')) return res.status(400).json({ error: 'Você não pode desativar ou retirar o perfil do próprio usuário.' });
    if (current.role === 'admin' && current.active && (!active || fields.role !== 'admin')) {
      const [admins] = await pool.query("SELECT COUNT(*) AS total FROM app_users WHERE role = 'admin' AND active = 1 AND id <> ?", [id]);
      if (Number(admins[0].total) === 0) return res.status(400).json({ error: 'É necessário manter pelo menos um Administrador ativo.' });
    }
    const passwordHash = fields.password ? hashPassword(fields.password) : current.password_hash;
    await pool.query('UPDATE app_users SET name = ?, email = ?, password_hash = ?, role = ?, active = ? WHERE id = ?', [fields.name, fields.email, passwordHash, fields.role, active ? 1 : 0, id]);
    const [rows] = await pool.query('SELECT id, name, email, role, active, created_at, updated_at FROM app_users WHERE id = ?', [id]);
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (err) { res.status(400).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Este identificador já está cadastrado.' : (err.message || 'Não foi possível atualizar o usuário.') }); }
});
app.delete('/api/users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.authUser.id) return res.status(400).json({ error: 'Não é possível excluir o próprio usuário.' });
    const [found] = await pool.query('SELECT id, role, active FROM app_users WHERE id = ?', [id]);
    if (!found.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (found[0].role === 'admin' && found[0].active) {
      const [admins] = await pool.query("SELECT COUNT(*) AS total FROM app_users WHERE role = 'admin' AND active = 1 AND id <> ?", [id]);
      if (Number(admins[0].total) === 0) return res.status(400).json({ error: 'É necessário manter pelo menos um Administrador ativo.' });
    }
    await pool.query('DELETE FROM app_sessions WHERE user_id = ?', [id]);
    await pool.query('DELETE FROM app_users WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (_) { res.status(500).json({ error: 'Não foi possível excluir o usuário.' }); }
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
  const privateDataDir = path.join(__dirname, 'private-data');
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
  await pool.query(`CREATE TABLE IF NOT EXISTS app_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'viewer',
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_app_users_active (active),
    INDEX idx_app_users_role (role)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS backup_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    trigger_type VARCHAR(24) NOT NULL,
    payload JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_backup_snapshots_created_at (created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    INDEX idx_app_sessions_expiry (expires_at),
    INDEX idx_app_sessions_user (user_id),
    CONSTRAINT fk_app_sessions_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS infrastructure_state (state_key VARCHAR(64) PRIMARY KEY, payload JSON NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  const [infraRows] = await pool.query('SELECT state_key FROM infrastructure_state WHERE state_key = ?', ['current']);
  const infraSeed = validateInfrastructurePayload(JSON.parse(fs.readFileSync(path.join(privateDataDir, 'infrastructure.json'), 'utf8')));
  if (!infraRows.length) await pool.query('INSERT INTO infrastructure_state (state_key, payload) VALUES (?, ?)', ['current', JSON.stringify(infraSeed)]);
  const [rows] = await pool.query('SELECT state_key, payload FROM inventory_state WHERE state_key = ?', ['current']);
  const seed = validatePayload(JSON.parse(fs.readFileSync(path.join(privateDataDir, 'data.json'), 'utf8')));
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

app.get('/api/inventory/history', requireAdmin, async (req, res) => {
  try {
    const stateKey = req.query.branch ? branchStateKey(req.query.branch) : 'current';
    const [rows] = await pool.query('SELECT id, state_key, action, source_file, record_count, summary, created_at FROM inventory_history WHERE state_key = ? ORDER BY created_at DESC, id DESC LIMIT 100', [stateKey]);
    res.setHeader('Cache-Control', 'no-store');
    res.json(rows.map((row) => ({ ...row, summary: typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary })));
  } catch (err) { res.status(500).json({ error: 'Falha ao consultar o histórico de importações.' }); }
});

app.get('/api/infrastructure/latest', async (req, res) => { try { const [rows] = await pool.query('SELECT payload, updated_at FROM infrastructure_state WHERE state_key = ?', ['current']); if (!rows.length) return res.status(404).json({ error: 'Nenhuma base de infraestrutura cadastrada.' }); const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload; res.setHeader('Cache-Control', 'no-store'); res.json({ ...payload, UpdatedAt: rows[0].updated_at }); } catch (err) { res.status(500).json({ error: 'Falha ao consultar a infraestrutura.' }); } });
app.post('/api/infrastructure/import', requireAdmin, requireImportToken, async (req, res) => { try { const payload = validateInfrastructurePayload(req.body); await pool.query('INSERT INTO infrastructure_state (state_key, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', ['current', JSON.stringify(payload)]); res.json({ ok: true, count: payload.Count, importedAt: payload.ImportedAt }); } catch (err) { res.status(400).json({ error: err.message || 'Payload de infraestrutura inválido.' }); } });
const DEFAULT_BRANCH_NAME = 'FOR - INTERCARGAS';
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
    payload.BranchName = String(req.body.BranchName || DEFAULT_BRANCH_NAME).trim().slice(0, 120) || DEFAULT_BRANCH_NAME;
    const key = branchStateKey(req.body.BranchKey);
    await pool.query('INSERT INTO inventory_state (state_key, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [key, JSON.stringify(payload)]);
    await pool.query('INSERT INTO inventory_history (state_key, action, source_file, record_count, summary) VALUES (?, ?, ?, ?, ?)', [key, 'import', payload.SourceFile, payload.Count, JSON.stringify({operator: 'Operador local', origin: 'Importação da filial FOR - INTERCARGAS', branch: DEFAULT_BRANCH_NAME})]);
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
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint não encontrado.' }));

app.get('/data.json', (req, res) => res.status(404).end());
app.get('/infrastructure.json', (req, res) => res.status(404).end());
app.use(express.static(path.join(__dirname, 'dist'), { index: 'index.html', maxAge: '1h' }));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

(async () => {
  try {
    await initDb();
    await runAutomaticBackup();
    setInterval(runAutomaticBackup, 60 * 60 * 1000);
    app.listen(PORT, '0.0.0.0', () => console.log(`Inventário TI API listening on ${PORT}`));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
