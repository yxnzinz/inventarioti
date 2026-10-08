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
const STATUS_VALUES = ['Alugada', 'Patrimônio', 'Pessoal'];
const STATUS_ALIASES = ['status patrimonial','status do ativo','tipo de patrimonio','tipo de patrimônio','tipo de ativo','situacao patrimonial','situação patrimonial','propriedade','posse','alugado','alugada','locado','locada'];
function normalizeLabel(value) { return String(value ?? '').trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function findStatusHeader(headers) { return headers.find((h) => STATUS_ALIASES.includes(normalizeLabel(h)) || normalizeLabel(h).includes('alugad') || normalizeLabel(h).includes('locad')); }
function normalizeStatus(value, header = '') { const label = normalizeLabel(value); const headerLabel = normalizeLabel(header); if (label.includes('pessoal') || label.includes('usuario') || label.includes('usuário')) return 'Pessoal'; if ((headerLabel.includes('alug') || headerLabel.includes('locad')) && ['sim','yes','true','1'].includes(label)) return 'Alugada'; return label.includes('alug') || label.includes('locad') ? 'Alugada' : 'Patrimônio'; }
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
  const rows = payload.Rows || payload.rows;
  if (!rows.length || rows.length > MAX_ROWS) throw new Error('Quantidade de registros fora do limite permitido.');
  const headers = Array.isArray(payload.Headers) ? payload.Headers : (Array.isArray(payload.headers) ? payload.headers : REQUIRED_HEADERS);
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`Colunas obrigatórias ausentes: ${missing.join(', ')}`);
  const statusHeader = findStatusHeader(headers) || STATUS_HEADER;
  const normalized = rows.map((row) => {
    const clean = {};
    for (const h of REQUIRED_HEADERS) clean[h] = row[h] ?? null;
    clean[STATUS_HEADER] = normalizeStatus(row[statusHeader], statusHeader);
    return clean;
  });
  return {
    Version: 1,
    SourceFile: String(payload.SourceFile || payload.sourceFile || 'importacao.xlsx'),
    ImportedAt: new Date().toISOString(),
    Count: normalized.length,
    Headers: [...REQUIRED_HEADERS, STATUS_HEADER],
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
  const [rows] = await pool.query('SELECT state_key FROM inventory_state WHERE state_key = ?', ['current']);
  if (!rows.length) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
    const payload = validatePayload(seed);
    await pool.query('INSERT IGNORE INTO inventory_state (state_key, payload) VALUES (?, ?)', ['current', JSON.stringify(payload)]);
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
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...payload, UpdatedAt: rows[0].updated_at });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao consultar a base de inventário.' });
  }
});

app.post('/api/inventory/import', requireImportToken, async (req, res) => {
  try {
    const payload = validatePayload(req.body);
    await pool.query('UPDATE inventory_state SET payload = ? WHERE state_key = ?', [JSON.stringify(payload), 'current']);
    res.status(200).json({ ok: true, count: payload.Count, importedAt: payload.ImportedAt });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Payload inválido.' });
  }
});

app.put('/api/inventory/status', requireImportToken, async (req, res) => {
  try {
    const requested = normalizeStatus(req.body?.Status || req.body?.status);
    const hostname = String(req.body?.Hostname || req.body?.hostname || '').trim();
    const number = String(req.body?.Numero ?? req.body?.numero ?? '').trim();
    if (!hostname && !number) return res.status(400).json({ error: 'Informe o Hostname ou o Nº da máquina.' });
    const [currentRows] = await pool.query('SELECT payload FROM inventory_state WHERE state_key = ?', ['current']);
    if (!currentRows.length) return res.status(404).json({ error: 'Nenhuma base de inventário disponível.' });
    const payload = typeof currentRows[0].payload === 'string' ? JSON.parse(currentRows[0].payload) : currentRows[0].payload;
    payload.Headers = Array.isArray(payload.Headers) && payload.Headers.includes(STATUS_HEADER) ? payload.Headers : [...REQUIRED_HEADERS, STATUS_HEADER];
    const row = payload.Rows.find((item) => (number && String(item['Nº']) === number) || (hostname && String(item.Hostname || '').trim() === hostname));
    if (!row) return res.status(404).json({ error: 'Máquina não encontrada na base atual.' });
    row[STATUS_HEADER] = requested;
    payload.ImportedAt = new Date().toISOString();
    await pool.query('UPDATE inventory_state SET payload = ? WHERE state_key = ?', [JSON.stringify(payload), 'current']);
    res.json({ ok: true, status: requested, hostname: row.Hostname, numero: row['Nº'] });
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
