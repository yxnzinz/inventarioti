const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_ROWS = 50000;
const REQUIRED_HEADERS = ['Nº','Filial','Setor','Localização','Responsável','Hostname','Usuário','Processador','Núcleos','Threads','Sistema','Build','RAM','Disco','Coleta','Arquivo de origem'];
const STATUS_HEADER = 'Status patrimonial';
const ASSET_HEADER = 'Patrimônio';
const OPERATIONAL_STATUS_HEADER = 'Status operacional';
const OPERATIONAL_STATUS_VALUES = ['Ativo', 'Em manutenção', 'Reserva', 'Backup', 'Desativado', 'Em substituição', 'Aguardando definição de setor'];
const STATUS_VALUES = ['Alugada', 'Patrimônio', 'Pessoal'];
const STATUS_ALIASES = ['status patrimonial','status do ativo','tipo de patrimonio','tipo de patrimônio','tipo de ativo','situacao patrimonial','situação patrimonial','propriedade','posse','alugado','alugada','locado','locada'];
function normalizeLabel(value) { return String(value ?? '').trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function findStatusHeader(headers) { return headers.find((h) => STATUS_ALIASES.includes(normalizeLabel(h)) || normalizeLabel(h).includes('alugad') || normalizeLabel(h).includes('locad')); }
function normalizeSector(value) { const label = normalizeLabel(value); return ['alugado','alugada','aluguel'].includes(label) ? 'ALUGUEL' : String(value ?? '').trim(); }
function isAuxiliaryMemoryRow(row) { const sector = normalizeLabel(row?.Setor); if (/^(?:\d+\s*(?:gb|gib)\s*(?:de\s*)?ram|ram\s*(?:de\s*)?\d+\s*(?:gb|gib)?|memoria\s*(?:ram\s*)?\d+)/i.test(sector)) return true; const combined = normalizeLabel([row?.Setor, row?.Responsável, row?.Hostname, row?.Processador, row?.Sistema].join(' ')); const hasMemoryLabel = /\d+\s*(?:gb|gib)\s*(?:de\s*)?ram|ram\s*(?:de\s*)?\d+\s*(?:gb|gib)?/i.test(combined); const hasEquipmentIdentity = [row?.Responsável, row?.Hostname, row?.Processador, row?.Sistema].some(value => String(value ?? '').trim() !== ''); return hasMemoryLabel && !hasEquipmentIdentity; }
function removeAuxiliaryMemoryRows(rows) { return rows.filter(row => !isAuxiliaryMemoryRow(row)); }
function sanitizeStoredPayload(payload) { if (!payload || !Array.isArray(payload.Rows)) return { payload, removed: 0 }; const rows = removeAuxiliaryMemoryRows(payload.Rows); const removed = payload.Rows.length - rows.length; if (removed) { payload.Rows = rows; payload.Count = rows.length; } return { payload, removed }; }
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
  const normalized = rows.map((row) => {
    const clean = {};
    for (const h of REQUIRED_HEADERS) clean[h] = row[h] ?? null;
    clean['Setor'] = normalizeSector(clean['Setor']);
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
    Headers: [...REQUIRED_HEADERS, STATUS_HEADER, ASSET_HEADER, OPERATIONAL_STATUS_HEADER],
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

app.post('/api/inventory/branch/import', requireImportToken, async (req, res) => {
  try {
    const payload = validatePayload(req.body);
    payload.BranchName = String(req.body.BranchName || 'Outra filial').trim().slice(0, 120);
    const key = branchStateKey(req.body.BranchKey);
    await pool.query('INSERT INTO inventory_state (state_key, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [key, JSON.stringify(payload)]);
    res.status(200).json({ ok: true, count: payload.Count, importedAt: payload.ImportedAt, branchName: payload.BranchName });
  } catch (err) { res.status(400).json({ error: err.message || 'Payload inválido.' }); }
});

app.post('/api/inventory/import', requireImportToken, async (req, res) => {
  try {
    const payload = validatePayload(req.body);
    await pool.query('UPDATE inventory_state SET payload = ? WHERE state_key = ?', [JSON.stringify(payload), 'current']);
    await pool.query('INSERT INTO inventory_history (state_key, action, source_file, record_count, summary) VALUES (?, ?, ?, ?, ?)', ['current', 'import', payload.SourceFile, payload.Count, JSON.stringify(req.body.Summary || null)]);
    res.status(200).json({ ok: true, count: payload.Count, importedAt: payload.ImportedAt });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Payload inválido.' });
  }
});

app.put('/api/inventory/status', requireImportToken, async (req, res) => {
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
