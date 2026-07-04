#!/usr/bin/env node
const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { importSitePayload } = require('./src/import-service');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TIMEZONE = process.env.TZ || 'America/Argentina/Buenos_Aires';
const REFRESH_MS = Number(process.env.CODEBURN_REFRESH_MS || 5 * 60 * 1000);
const DB_PATH = process.env.CODEBURN_DB || path.join(__dirname, 'data', 'codeburn.sqlite');
const DEFAULT_TENANT = {
  id: process.env.CODEBURN_TENANT_ID || 'martin',
  name: process.env.CODEBURN_TENANT_NAME || 'Martin',
};
const DEFAULT_DEVICE = {
  id: process.env.CODEBURN_DEVICE_ID || 'raspi-pi-5',
  name: process.env.CODEBURN_DEVICE_NAME || 'Raspi PI 5',
  tenantId: process.env.CODEBURN_DEVICE_TENANT_ID || DEFAULT_TENANT.id,
  hostname: process.env.CODEBURN_DEVICE_HOSTNAME || os.hostname(),
};

const db = new DatabaseSync(DB_PATH);
let collectorState = { running: false, lastOk: null, lastError: null };

function execCodeburn(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile('codeburn', ['--timezone', TIMEZONE, ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr, error: error ? String(error.message || error) : null });
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function jsonForScript(value) { return JSON.stringify(value).replace(/</g, '\\u003c'); }
function money(n, currency = 'USD') { return `${currency} ${Number(n || 0).toFixed(2)}`; }
function nowIso() { return new Date().toISOString(); }

function slugifyId(value, fallback = 'item') {
  const id = String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || fallback;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function reportImportHash(report) {
  return crypto.createHash('sha256').update(stableJson(report)).digest('hex');
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('JSON demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function siteIdentity() {
  return {
    tenant: { id: DEFAULT_TENANT.id, name: DEFAULT_TENANT.name },
    device: { id: DEFAULT_DEVICE.id, name: DEFAULT_DEVICE.name, hostname: DEFAULT_DEVICE.hostname, tenantId: DEFAULT_DEVICE.tenantId },
  };
}

function catalog() {
  const tenants = db.prepare(`SELECT id, name FROM tenants ORDER BY name, id`).all();
  const devices = db.prepare(`SELECT id, tenant_id tenantId, name, hostname FROM devices ORDER BY name, id`).all();
  return {
    tenants: tenants.map(t => ({ ...t, devices: devices.filter(d => d.tenantId === t.id) })),
    devices,
  };
}

function deviceById(deviceId) {
  return db.prepare(`SELECT d.id, d.tenant_id tenantId, d.name, d.hostname, t.name tenantName
    FROM devices d JOIN tenants t ON t.id = d.tenant_id WHERE d.id = ?`).get(deviceId) || null;
}

function firstDeviceForTenant(tenantId) {
  return db.prepare(`SELECT id FROM devices WHERE tenant_id = ? ORDER BY name, id LIMIT 1`).get(tenantId)?.id || null;
}

function upsertSiteIdentity(input = {}, selected = {}) {
  const cleanSelected = { ...selected };
  if (!cleanSelected.tenantId || cleanSelected.tenantId === 'all' || cleanSelected.tenantId === 'json') delete cleanSelected.tenantId;
  if (!cleanSelected.deviceId || cleanSelected.deviceId === 'all' || cleanSelected.deviceId === 'json') delete cleanSelected.deviceId;
  const selectedDevice = cleanSelected.deviceId ? deviceById(cleanSelected.deviceId) : null;
  if (cleanSelected.deviceId && !selectedDevice) throw new Error('Device destino inexistente');
  if (selectedDevice && cleanSelected.tenantId && selectedDevice.tenantId !== cleanSelected.tenantId) {
    throw new Error('El device destino no pertenece al tenant seleccionado');
  }
  const tenantIn = input.tenant || input.tenancy || {};
  const deviceIn = input.device || input.computer || input.machine || {};
  const tenantId = slugifyId(selectedDevice?.tenantId || cleanSelected.tenantId || deviceIn.tenantId || deviceIn.tenant_id || tenantIn.id || tenantIn.slug || tenantIn.name, DEFAULT_TENANT.id);
  const tenantName = cleanSelected.tenantName || selectedDevice?.tenantName || tenantIn.name || tenantIn.label || tenantId;
  const deviceId = slugifyId(selectedDevice?.id || cleanSelected.deviceId || deviceIn.id || deviceIn.slug || deviceIn.name, DEFAULT_DEVICE.id);
  const deviceName = cleanSelected.deviceName || selectedDevice?.name || deviceIn.name || deviceIn.label || deviceId;
  const hostname = cleanSelected.hostname || selectedDevice?.hostname || deviceIn.hostname || input.hostname || null;
  const now = nowIso();
  db.prepare(`INSERT INTO tenants (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`)
    .run(tenantId, tenantName, now, now);
  db.prepare(`INSERT INTO devices (id, tenant_id, name, hostname, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, name = excluded.name, hostname = excluded.hostname, updated_at = excluded.updated_at`)
    .run(deviceId, tenantId, deviceName, hostname, now, now);
  return { tenant: { id: tenantId, name: tenantName }, device: { id: deviceId, name: deviceName, hostname, tenantId } };
}

function upsertTenant(input = {}) {
  const name = String(input.name || input.id || '').trim();
  if (!name) throw new Error('Falta el nombre del tenant');
  const id = slugifyId(input.id || name, 'tenant');
  const now = nowIso();
  db.prepare(`INSERT INTO tenants (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`)
    .run(id, name, now, now);
  return { id, name };
}

function upsertDevice(input = {}) {
  const tenantId = String(input.tenantId || input.tenant_id || '').trim();
  if (!tenantId) throw new Error('Falta seleccionar tenant');
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant) throw new Error('Tenant inexistente');
  const name = String(input.name || input.id || '').trim();
  if (!name) throw new Error('Falta el nombre del device');
  const id = slugifyId(input.id || name, 'device');
  const hostname = String(input.hostname || '').trim() || null;
  const now = nowIso();
  db.prepare(`INSERT INTO devices (id, tenant_id, name, hostname, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, name = excluded.name, hostname = excluded.hostname, updated_at = excluded.updated_at`)
    .run(id, tenantId, name, hostname, now, now);
  return { id, tenantId, name, hostname };
}

function initDb() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL,
      period_key TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT 'raspi-pi-5',
      provider TEXT NOT NULL DEFAULT 'all',
      currency TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      cache_hit_percent REAL,
      import_hash TEXT,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      hostname TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_provider_period ON snapshots(provider, period_key, id DESC);
    CREATE TABLE IF NOT EXISTS daily (
      snapshot_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      edit_turns INTEGER NOT NULL DEFAULT 0,
      one_shot_turns INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS models (
      snapshot_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activities (
      snapshot_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      edit_turns INTEGER NOT NULL DEFAULT 0,
      one_shot_turns INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS projects (
      snapshot_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      path TEXT,
      cost REAL NOT NULL DEFAULT 0,
      avg_cost_per_session REAL NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tools (
      snapshot_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS shell_commands (
      snapshot_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS top_sessions (
      snapshot_id INTEGER NOT NULL,
      project TEXT,
      session_id TEXT,
      date TEXT,
      cost REAL NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0
    );
  `);
  if (!columnExists('snapshots', 'device_id')) db.exec(`ALTER TABLE snapshots ADD COLUMN device_id TEXT NOT NULL DEFAULT 'raspi-pi-5';`);
  if (!columnExists('snapshots', 'import_hash')) db.exec(`ALTER TABLE snapshots ADD COLUMN import_hash TEXT;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_device_provider_period ON snapshots(device_id, provider, period_key, id DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_import_hash ON snapshots(device_id, provider, period_key, import_hash);`);
  const now = nowIso();
  db.prepare(`INSERT INTO tenants (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`)
    .run(DEFAULT_TENANT.id, DEFAULT_TENANT.name, now, now);
  db.prepare(`INSERT INTO devices (id, tenant_id, name, hostname, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, name = excluded.name, hostname = excluded.hostname, updated_at = excluded.updated_at`)
    .run(DEFAULT_DEVICE.id, DEFAULT_DEVICE.tenantId, DEFAULT_DEVICE.name, DEFAULT_DEVICE.hostname, now, now);
  db.prepare(`UPDATE snapshots SET device_id = ? WHERE device_id IS NULL OR device_id = '' OR device_id = 'raspi-pi-5'`).run(DEFAULT_DEVICE.id);
}

function insertReport(report, provider = 'all', periodKey = '30days', deviceId = DEFAULT_DEVICE.id) {
  const overview = report.overview || {};
  const snap = db.prepare(`INSERT INTO snapshots (captured_at, period_key, device_id, provider, currency, cost, calls, sessions, cache_hit_percent, import_hash, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = snap.run(nowIso(), periodKey || report.periodKey || '30days', deviceId || DEFAULT_DEVICE.id, provider || 'all', report.currency || 'USD', overview.cost || 0, overview.calls || 0, overview.sessions || 0, overview.cacheHitPercent ?? null, reportImportHash(report), JSON.stringify(report));
  const id = Number(info.lastInsertRowid);

  const stmts = {
    daily: db.prepare('INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?)'),
    models: db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    activities: db.prepare('INSERT INTO activities VALUES (?, ?, ?, ?, ?, ?)'),
    projects: db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)'),
    tools: db.prepare('INSERT INTO tools VALUES (?, ?, ?)'),
    shell: db.prepare('INSERT INTO shell_commands VALUES (?, ?, ?)'),
    sessions: db.prepare('INSERT INTO top_sessions VALUES (?, ?, ?, ?, ?, ?)'),
  };
  for (const r of report.daily || []) stmts.daily.run(id, r.date || '', r.cost || 0, r.calls || 0, r.turns || 0, r.editTurns || 0, r.oneShotTurns || 0);
  for (const r of report.models || []) stmts.models.run(id, r.name || '', r.calls || 0, r.inputTokens || 0, r.outputTokens || 0, r.cacheReadTokens || 0, r.cacheWriteTokens || 0, r.cost || 0);
  for (const r of report.activities || []) stmts.activities.run(id, r.category || '', r.cost || 0, r.turns || 0, r.editTurns || 0, r.oneShotTurns || 0);
  for (const r of report.projects || []) stmts.projects.run(id, r.name || '', r.path || '', r.cost || 0, r.avgCostPerSession || 0, r.calls || 0, r.sessions || 0);
  for (const r of report.tools || []) stmts.tools.run(id, r.name || '', r.calls || 0);
  for (const r of report.shellCommands || []) stmts.shell.run(id, r.name || '', r.calls || 0);
  for (const r of report.topSessions || []) stmts.sessions.run(id, r.project || '', r.sessionId || '', r.date || '', r.cost || 0, r.calls || 0);

  // Keep enough history for trend/debug without growing forever.
  // Always preserve the latest snapshot per device+provider+period so imported data from other devices isn't wiped.
  db.exec(`DELETE FROM snapshots WHERE id NOT IN (
    SELECT id FROM (SELECT id FROM snapshots ORDER BY id DESC LIMIT 500) AS recent
    UNION
    SELECT id FROM (SELECT MAX(id) id FROM snapshots GROUP BY device_id, provider, period_key) AS latest
  );`);
  db.exec(`DELETE FROM daily WHERE snapshot_id NOT IN (SELECT id FROM snapshots);`);
  db.exec(`DELETE FROM models WHERE snapshot_id NOT IN (SELECT id FROM snapshots);`);
  db.exec(`DELETE FROM activities WHERE snapshot_id NOT IN (SELECT id FROM snapshots);`);
  db.exec(`DELETE FROM projects WHERE snapshot_id NOT IN (SELECT id FROM snapshots);`);
  db.exec(`DELETE FROM tools WHERE snapshot_id NOT IN (SELECT id FROM snapshots);`);
  db.exec(`DELETE FROM shell_commands WHERE snapshot_id NOT IN (SELECT id FROM snapshots);`);
  db.exec(`DELETE FROM top_sessions WHERE snapshot_id NOT IN (SELECT id FROM snapshots);`);
  return id;
}

function findDuplicateSnapshot(report, provider = 'all', periodKey = '30days', deviceId = DEFAULT_DEVICE.id) {
  const normalizedProvider = provider || 'all';
  const normalizedPeriod = periodKey || report.periodKey || '30days';
  const normalizedDevice = deviceId || DEFAULT_DEVICE.id;
  const rawJson = JSON.stringify(report);
  const importHash = reportImportHash(report);
  return db.prepare(`SELECT id, captured_at capturedAt
    FROM snapshots
    WHERE device_id = ? AND provider = ? AND period_key = ?
      AND (import_hash = ? OR raw_json = ?)
    ORDER BY id DESC
    LIMIT 1`).get(normalizedDevice, normalizedProvider, normalizedPeriod, importHash, rawJson) || null;
}

function looksLikeCodeburnReport(value) {
  return !!(value && typeof value === 'object' && value.overview && (Array.isArray(value.daily) || Array.isArray(value.models) || Array.isArray(value.projects) || Array.isArray(value.topSessions)));
}

function reportFromImportBody(body = {}) {
  if (looksLikeCodeburnReport(body)) return body;
  if (looksLikeCodeburnReport(body.report)) return body.report;
  if (looksLikeCodeburnReport(body.data)) return body.data;
  return null;
}

function normalizeProvider(value) {
  const provider = String(value || 'all').trim().toLowerCase();
  return provider || 'all';
}

async function collect(provider = 'all', period = '30days') {
  if (collectorState.running) return;
  collectorState.running = true;
  try {
    const args = ['report', '-p', period, '--format', 'json'];
    if (provider !== 'all') args.push('--provider', provider);
    const out = await execCodeburn(args, 90000);
    if (!out.ok) throw new Error(out.stderr || out.error || 'codeburn failed');
    const report = JSON.parse(out.stdout || '{}');
    db.exec('BEGIN');
    try { insertReport(report, provider, period); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    if (provider === 'all' && period === 'all') await collectMonthlyFromReport(report);
    collectorState.lastOk = nowIso();
    collectorState.lastError = null;
  } catch (e) {
    collectorState.lastError = String(e?.stack || e);
  } finally {
    collectorState.running = false;
  }
}

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const endDate = new Date(Date.UTC(y, m, 0));
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

function monthsBetween(minDate, maxDate) {
  if (!minDate || !maxDate) return [];
  const out = [];
  let [y, m] = minDate.slice(0, 7).split('-').map(Number);
  const [ey, em] = maxDate.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m === 13) { m = 1; y++; }
  }
  return out;
}

async function collectMonthlyFromReport(report) {
  const dates = (report.daily || []).map(r => r.date).filter(Boolean).sort();
  const months = monthsBetween(dates[0], dates[dates.length - 1]);
  for (const month of months) {
    const { start, end } = monthBounds(month);
    const out = await execCodeburn(['report', '--from', start, '--to', end, '--format', 'json'], 90000);
    if (!out.ok) throw new Error(out.stderr || out.error || `codeburn monthly failed ${month}`);
    const monthlyReport = JSON.parse(out.stdout || '{}');
    db.exec('BEGIN');
    try { insertReport(monthlyReport, 'all', `month:${month}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

function latestSnapshots(provider = 'all', period = '30days', tenantId = DEFAULT_TENANT.id, deviceId = 'all') {
  const params = [provider, period];
  const tenantSql = tenantId && tenantId !== 'all' ? 'AND d2.tenant_id = ?' : '';
  if (tenantSql) params.push(tenantId);
  const deviceSql = deviceId && deviceId !== 'all' ? 'AND s.device_id = ?' : '';
  if (deviceSql) params.push(deviceId);
  return db.prepare(`
    SELECT s.*, d.name device_name, d.hostname, d.tenant_id, t.name tenant_name
    FROM snapshots s
    JOIN devices d ON d.id = s.device_id
    JOIN tenants t ON t.id = d.tenant_id
    JOIN (
      SELECT s2.device_id, MAX(s2.id) id
      FROM snapshots s2
      JOIN devices d2 ON d2.id = s2.device_id
      WHERE s2.provider = ? AND s2.period_key = ? ${tenantSql} ${deviceSql.replace('s.device_id', 's2.device_id')}
      GROUP BY s2.device_id
    ) latest ON latest.id = s.id
    ORDER BY d.name, d.id
  `).all(...params);
}

function monthlyReports(provider = 'all', tenantId = DEFAULT_TENANT.id, deviceId = 'all') {
  const params = [provider];
  const tenantSql = tenantId && tenantId !== 'all' ? 'AND d2.tenant_id = ?' : '';
  if (tenantSql) params.push(tenantId);
  const deviceSql = deviceId && deviceId !== 'all' ? 'AND s.device_id = ?' : '';
  if (deviceSql) params.push(deviceId);
  const snaps = db.prepare(`
    SELECT s.* FROM snapshots s
    JOIN devices d ON d.id = s.device_id
    JOIN (SELECT s2.device_id, s2.period_key, MAX(s2.id) id FROM snapshots s2 JOIN devices d2 ON d2.id = s2.device_id WHERE s2.provider = ? ${tenantSql} ${deviceSql.replace('s.device_id', 's2.device_id')} AND s2.period_key LIKE 'month:%' GROUP BY s2.device_id, s2.period_key) latest
      ON latest.id = s.id
    ORDER BY s.period_key, d.name
  `).all(...params);
  const grouped = new Map();
  for (const snap of snaps) {
    const models = rows('models', snap.id).map(r => ({
      name: r.name,
      calls: r.calls,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      cost: r.cost,
      totalTokens: r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens,
    }));
    const month = snap.period_key.replace('month:', '');
    if (!grouped.has(month)) grouped.set(month, { month, date: month, cost: 0, calls: 0, sessions: 0, models: [] });
    const g = grouped.get(month);
    g.cost += Number(snap.cost || 0); g.calls += Number(snap.calls || 0); g.sessions += Number(snap.sessions || 0); g.models.push(...models);
  }
  return [...grouped.values()].map(g => {
    const byModel = new Map();
    for (const m of g.models) {
      const x = byModel.get(m.name) || { name: m.name, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, totalTokens: 0 };
      x.calls += m.calls; x.inputTokens += m.inputTokens; x.outputTokens += m.outputTokens; x.cacheReadTokens += m.cacheReadTokens; x.cacheWriteTokens += m.cacheWriteTokens; x.cost += m.cost; x.totalTokens += m.totalTokens;
      byModel.set(m.name, x);
    }
    g.models = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls || b.cost - a.cost);
    const topModel = g.models[0] || null;
    return { ...g, topModel: topModel?.name || null, topModelCalls: topModel?.calls || 0, topModelCost: topModel?.cost || 0, topModelTokens: topModel?.totalTokens || 0 };
  }).sort((a, b) => String(b.month || b.date).localeCompare(String(a.month || a.date)));
}

function latestSnapshot(provider = 'all', period = '30days', deviceId = DEFAULT_DEVICE.id) {
  return db.prepare('SELECT * FROM snapshots WHERE provider = ? AND period_key = ? AND device_id = ? ORDER BY id DESC LIMIT 1').get(provider, period, deviceId === 'all' ? DEFAULT_DEVICE.id : deviceId);
}
function latestPeriodKey(provider = 'all', tenantId = DEFAULT_TENANT.id, deviceId = 'all') {
  const params = [provider];
  const tenantSql = tenantId && tenantId !== 'all' ? 'AND d.tenant_id = ?' : '';
  if (tenantSql) params.push(tenantId);
  const deviceSql = deviceId && deviceId !== 'all' ? 'AND s.device_id = ?' : '';
  if (deviceSql) params.push(deviceId);
  return db.prepare(`
    SELECT s.period_key periodKey
    FROM snapshots s
    JOIN devices d ON d.id = s.device_id
    WHERE s.provider = ? ${tenantSql} ${deviceSql}
      AND s.period_key NOT LIKE 'month:%'
    ORDER BY CASE s.period_key WHEN 'all' THEN 0 WHEN '30days' THEN 1 ELSE 2 END, s.id DESC
    LIMIT 1
  `).get(...params)?.periodKey || null;
}
function availablePeriods(provider = 'all', tenantId = DEFAULT_TENANT.id, deviceId = 'all') {
  const params = [provider];
  const tenantSql = tenantId && tenantId !== 'all' ? 'AND d.tenant_id = ?' : '';
  if (tenantSql) params.push(tenantId);
  const deviceSql = deviceId && deviceId !== 'all' ? 'AND s.device_id = ?' : '';
  if (deviceSql) params.push(deviceId);
  return db.prepare(`
    SELECT DISTINCT s.period_key periodKey
    FROM snapshots s
    JOIN devices d ON d.id = s.device_id
    WHERE s.provider = ? ${tenantSql} ${deviceSql}
      AND s.period_key NOT LIKE 'month:%'
    ORDER BY CASE s.period_key WHEN 'all' THEN 0 WHEN '30days' THEN 1 ELSE 2 END, s.period_key
  `).all(...params).map(r => r.periodKey);
}
function rows(table, snapshotId) { return db.prepare(`SELECT * FROM ${table} WHERE snapshot_id = ?`).all(snapshotId); }
function sumRows(snaps, table, key, mapFn) {
  const out = new Map();
  for (const snap of snaps) for (const r of rows(table, snap.id)) {
    const k = r[key] || '';
    const x = out.get(k) || mapFn({ [key]: k });
    mapFn(r, x);
    out.set(k, x);
  }
  return [...out.values()];
}
function apiReport(provider = 'all', period = '30days', deviceId = 'all', tenantId = DEFAULT_TENANT.id) {
  const snaps = latestSnapshots(provider, period, tenantId, deviceId);
  if (!snaps.length) return null;
  const selectedDevice = deviceId !== 'all' ? deviceById(deviceId) : null;
  const selectedTenant = tenantId === 'all' ? { id: 'all', name: 'Todos los tenants' } : (db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(tenantId) || siteIdentity().tenant);
  const tokens = snaps.reduce((acc, snap) => {
    try { const t = JSON.parse(snap.raw_json).overview?.tokens || {}; for (const [k, v] of Object.entries(t)) acc[k] = Number(acc[k] || 0) + Number(v || 0); } catch {}
    return acc;
  }, {});
  const daily = sumRows(snaps, 'daily', 'date', (r, x) => {
    x ||= { date: r.date, cost: 0, calls: 0, turns: 0, editTurns: 0, oneShotTurns: 0 };
    x.cost += Number(r.cost || 0); x.calls += Number(r.calls || 0); x.turns += Number(r.turns || 0); x.editTurns += Number(r.edit_turns || 0); x.oneShotTurns += Number(r.one_shot_turns || 0); return x;
  }).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const models = sumRows(snaps, 'models', 'name', (r, x) => {
    x ||= { name: r.name, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
    x.calls += Number(r.calls || 0); x.inputTokens += Number(r.input_tokens || 0); x.outputTokens += Number(r.output_tokens || 0); x.cacheReadTokens += Number(r.cache_read_tokens || 0); x.cacheWriteTokens += Number(r.cache_write_tokens || 0); x.cost += Number(r.cost || 0); return x;
  });
  const activities = sumRows(snaps, 'activities', 'category', (r, x) => {
    x ||= { category: r.category, cost: 0, turns: 0, editTurns: 0, oneShotTurns: 0 };
    x.cost += Number(r.cost || 0); x.turns += Number(r.turns || 0); x.editTurns += Number(r.edit_turns || 0); x.oneShotTurns += Number(r.one_shot_turns || 0); return x;
  });
  const deviceBreakdown = snaps.map(s => ({ id: s.device_id, name: s.device_name || s.device_id, tenantId: s.tenant_id, hostname: s.hostname, cost: s.cost, calls: s.calls, sessions: s.sessions })).sort((a,b)=>b.cost-a.cost);
  return {
    tenant: { id: selectedTenant.id, name: selectedTenant.name },
    device: selectedDevice ? { id: selectedDevice.id, name: selectedDevice.name, hostname: selectedDevice.hostname, tenantId: selectedDevice.tenantId } : { id: 'all', name: 'Todos los dispositivos', tenantId },
    generated: snaps.map(s=>s.captured_at).sort().at(-1),
    currency: snaps[0].currency,
    periodKey: period,
    period: period === 'all' ? 'All History' : (period === '30days' ? 'Last 30 Days' : period),
    source: 'sqlite',
    collector: collectorState,
    overview: { cost: snaps.reduce((a,s)=>a+Number(s.cost||0),0), calls: snaps.reduce((a,s)=>a+Number(s.calls||0),0), sessions: snaps.reduce((a,s)=>a+Number(s.sessions||0),0), cacheHitPercent: snaps.length ? Math.round(snaps.reduce((a,s)=>a+Number(s.cache_hit_percent||0),0)/snaps.length) : 0, tokens },
    deviceBreakdown,
    daily,
    monthly: provider === 'all' ? monthlyReports(provider, tenantId, deviceId) : [],
    models,
    activities,
    projects: snaps.flatMap(snap => rows('projects', snap.id).map(r => ({ name: r.name, path: r.path, cost: r.cost, avgCostPerSession: r.avg_cost_per_session, calls: r.calls, sessions: r.sessions, deviceId: snap.device_id }))),
    tools: sumRows(snaps, 'tools', 'name', (r, x) => { x ||= { name: r.name, calls: 0 }; x.calls += Number(r.calls || 0); return x; }),
    shellCommands: sumRows(snaps, 'shell_commands', 'name', (r, x) => { x ||= { name: r.name, calls: 0 }; x.calls += Number(r.calls || 0); return x; }),
    topSessions: snaps.flatMap(snap => rows('top_sessions', snap.id).map(r => ({ project: r.project, sessionId: r.session_id, date: r.date, cost: r.cost, calls: r.calls, deviceId: snap.device_id }))).sort((a,b)=>Number(b.cost||0)-Number(a.cost||0)),
  };
}

async function dashboard(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const provider = url.searchParams.get('provider') || 'all';
  const cat = catalog();
  const requestedTenantId = url.searchParams.get('tenant') || 'all';
  let deviceId = url.searchParams.get('device') || 'all';
  let selectedDevice = deviceId === 'all' ? null : deviceById(deviceId);
  let tenantId = requestedTenantId || selectedDevice?.tenantId || 'all';
  if (requestedTenantId && requestedTenantId !== 'all' && selectedDevice && selectedDevice.tenantId !== requestedTenantId) {
    deviceId = 'all';
    selectedDevice = null;
    tenantId = requestedTenantId;
  }
  let period = url.searchParams.get('period') || 'all';
  if (url.searchParams.get('refresh') === '1') await collect(provider, period);
  let reportObj = apiReport(provider, period, deviceId, tenantId);
  if (!reportObj) {
    const fallbackPeriod = latestPeriodKey(provider, tenantId, deviceId);
    if (fallbackPeriod && fallbackPeriod !== period) {
      period = fallbackPeriod;
      reportObj = apiReport(provider, period, deviceId, tenantId);
    }
  }
  if (!reportObj) { await collect(provider, period); reportObj = apiReport(provider, period, deviceId, tenantId); }
  let thirtyObj = apiReport(provider, '30days', deviceId, tenantId);
  if (!thirtyObj && provider === 'all') { await collect(provider, '30days'); thirtyObj = apiReport(provider, '30days', deviceId, tenantId); }
  const tab = url.searchParams.get('tab') || 'dashboard';
  const selectedTenant = tenantId === 'all' ? { id: 'all', name: 'Todos los tenants' } : (cat.tenants.find(t => t.id === tenantId) || cat.tenants[0] || siteIdentity().tenant);
  const identity = reportObj || { tenant: { id: selectedTenant.id, name: selectedTenant.name }, device: selectedDevice ? { id: selectedDevice.id, name: selectedDevice.name, hostname: selectedDevice.hostname, tenantId: selectedDevice.tenantId } : { id: 'all', name: 'Todos los dispositivos', tenantId } };

  const currency = reportObj?.currency || thirtyObj?.currency || 'USD';
  const overview = reportObj?.overview || {};
  const tokens = overview.tokens || {};
  const cards = reportObj ? `
    <div class="card metric"><div class="label">Costo histórico</div><div class="big">${escapeHtml(money(overview.cost, currency))}</div><div>${escapeHtml(overview.calls ?? '—')} calls · ${escapeHtml(overview.sessions ?? '—')} sesiones</div></div>
    <div class="card metric"><div class="label">Últimos 30 días</div><div class="big">${escapeHtml(money(thirtyObj?.overview?.cost || 0, currency))}</div><div>${escapeHtml(thirtyObj?.overview?.calls ?? '—')} calls · ${escapeHtml(thirtyObj?.overview?.sessions ?? '—')} sesiones</div></div>
    <div class="card metric"><div class="label">Modelos</div><div class="big">${escapeHtml((reportObj.models || []).filter(m => Number(m.cost || 0) > 0 || Number(m.calls || 0) > 0).length)}</div><div>detectados en el período</div></div>
    <div class="card metric"><div class="label">Días con actividad</div><div class="big">${escapeHtml((reportObj.daily || []).length)}</div><div>en el histórico</div></div>
  ` : `<div class="error">Todavía no hay datos en SQLite. ${escapeHtml(collectorState.lastError || '')}</div>`;
  const systemCards = reportObj ? `
    <div class="card metric"><div class="label">Tenant</div><div class="big smallbig">${escapeHtml(identity.tenant?.name || '—')}</div><div>${escapeHtml(identity.tenant?.id || '—')}</div></div>
    <div class="card metric"><div class="label">Device</div><div class="big smallbig">${escapeHtml(identity.device?.name || '—')}</div><div>${escapeHtml(identity.device?.id || '—')} · ${escapeHtml(identity.device?.hostname || '')}</div></div>
    <div class="card metric"><div class="label">Última actualización</div><div class="big smallbig">${escapeHtml((reportObj.generated || '').replace('T',' ').slice(0,19))}</div><div>${escapeHtml(collectorState.running ? 'Actualizando...' : 'SQLite cache')}</div></div>
    <div class="card metric"><div class="label">Cache hit</div><div class="big">${escapeHtml(overview.cacheHitPercent ?? 0)}%</div><div>${escapeHtml(Math.round((tokens.cacheRead || 0) / 1000))}K tokens cache read</div></div>
    <div class="card metric"><div class="label">DB</div><div class="big smallbig">SQLite</div><div>refresh cada ${Math.round(REFRESH_MS/60000)} min</div></div>
    <div class="card metric"><div class="label">Ruta DB</div><div class="big smallbig">codeburn.sqlite</div><div>${escapeHtml(DB_PATH)}</div></div>
  ` : '';

  const tenantSpecificOptions = cat.tenants.map(t => `<option value="${escapeHtml(t.id)}" ${t.id === tenantId ? 'selected' : ''}>${escapeHtml(t.name)} (${escapeHtml(t.id)})</option>`).join('');
  const tenantOptions = `<option value="all" ${tenantId === 'all' ? 'selected' : ''}>Todos los tenants</option>${tenantSpecificOptions}`;
  const importTenantOptions = `<option value="">Tenant del JSON</option>${cat.tenants.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} (${escapeHtml(t.id)})</option>`).join('')}`;
  const tenantCreateOptions = cat.tenants.map(t => `<option value="${escapeHtml(t.id)}" ${t.id === (tenantId === 'all' ? DEFAULT_TENANT.id : tenantId) ? 'selected' : ''}>${escapeHtml(t.name)} (${escapeHtml(t.id)})</option>`).join('');
  const visibleDevices = tenantId === 'all' ? cat.devices : cat.devices.filter(d => d.tenantId === tenantId);
  const deviceSpecificOptions = visibleDevices.map(d => `<option value="${escapeHtml(d.id)}" ${d.id === deviceId ? 'selected' : ''}>${escapeHtml(d.name)} (${escapeHtml(d.id)})</option>`).join('');
  const deviceOptions = `<option value="all" ${deviceId === 'all' ? 'selected' : ''}>Todos los dispositivos</option>${deviceSpecificOptions}`;
  const periods = [...new Set([period, ...availablePeriods(provider, tenantId, deviceId), 'all', '30days'].filter(Boolean))];
  const periodLabel = p => p === 'all' ? 'Histórico completo' : (p === '30days' ? 'Últimos 30 días' : p);
  const periodOptions = periods.map(p => `<option value="${escapeHtml(p)}" ${p === period ? 'selected' : ''}>${escapeHtml(periodLabel(p))}</option>`).join('');
  const importDeviceId = '';
  const importDevice = importDeviceId ? deviceById(importDeviceId) : null;
  const importIdentity = importDevice ? { tenant: { id: importDevice.tenantId, name: importDevice.tenantName }, device: { id: importDevice.id, name: importDevice.name, hostname: importDevice.hostname, tenantId: importDevice.tenantId } } : identity;
  const importDeviceOptions = `<option value="">Device del JSON / crear nuevo</option>${visibleDevices.map(d => `<option value="${escapeHtml(d.id)}" ${d.id === importDeviceId ? 'selected' : ''}>${escapeHtml(d.name)} (${escapeHtml(d.id)})</option>`).join('')}`;
  const filters = `<section class="card filters"><div><label>Tenant</label><select id="tenantFilter">${tenantOptions}</select></div><div><label>Device</label><select id="deviceFilter">${deviceOptions}</select></div><div><label>Período</label><select id="periodFilter">${periodOptions}</select></div><button id="applyFilters">Aplicar filtros</button><span class="small">Por defecto muestra todos los dispositivos del tenant.</span></section>`;
  const modals = `<div id="modalBackdrop" class="modal-backdrop" hidden></div>
<dialog id="tenantModal" class="modal"><form method="dialog" class="modal-box"><div class="modal-head"><h2>Nuevo tenant</h2><button class="icon-btn" value="cancel" aria-label="Cerrar">×</button></div><label>Nombre</label><input id="tenantNameInput" placeholder="Ej: Martin"><label>ID opcional</label><input id="tenantIdInput" placeholder="se genera automáticamente"><div id="tenantModalStatus" class="small"></div><div class="modal-actions"><button value="cancel" type="submit">Cancelar</button><button id="saveTenant" class="primary" type="button">Guardar tenant</button></div></form></dialog>
<dialog id="deviceModal" class="modal"><form method="dialog" class="modal-box"><div class="modal-head"><h2>Nuevo device</h2><button class="icon-btn" value="cancel" aria-label="Cerrar">×</button></div><label>Tenant</label><select id="deviceTenantInput">${tenantCreateOptions}</select><label>Nombre</label><input id="deviceNameInput" placeholder="Ej: Raspi PI 5"><label>ID opcional</label><input id="deviceIdInput" placeholder="se genera automáticamente"><label>Hostname opcional</label><input id="deviceHostnameInput" placeholder="Ej: raspi5"><div id="deviceModalStatus" class="small"></div><div class="modal-actions"><button value="cancel" type="submit">Cancelar</button><button id="saveDevice" class="primary" type="button">Guardar device</button></div></form></dialog>`;
  const providerLinks = ['all','openclaw','claude'].map(p => `<a class="${provider === p ? 'active' : ''}" href="/?provider=${p}&tenant=${encodeURIComponent(tenantId)}&device=${encodeURIComponent(deviceId)}&period=${encodeURIComponent(period)}">${p === 'all' ? 'Todo' : p[0].toUpperCase()+p.slice(1)}</a>`).join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>CodeBurn Portal</title>
<style>
:root{
  color-scheme:dark;
  --bg:#070b16;--bg2:#0b1221;--card:#101827;--card2:#0d1424;
  --muted:#94a3b8;--muted2:#64748b;--text:#eef4ff;
  --accent:#22d3ee;--accent2:#8b5cf6;--accent3:#10b981;--warn:#f59e0b;--bad:#fb7185;
  --line:rgba(148,163,184,.16);--line2:rgba(255,255,255,.08);
  --shadow:0 24px 80px rgba(0,0,0,.35);--radius:22px;
}
*{box-sizing:border-box}
body{
  margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--text);padding:22px;
  background:
    radial-gradient(circle at 8% 0%,rgba(34,211,238,.18),transparent 28%),
    radial-gradient(circle at 92% 10%,rgba(139,92,246,.18),transparent 30%),
    linear-gradient(135deg,#060914 0%,#0b1221 48%,#07111d 100%);
}
main{max-width:1240px;margin:0 auto}
.top{
  display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-bottom:16px;
  padding:20px;border:1px solid var(--line);border-radius:calc(var(--radius) + 2px);
  background:linear-gradient(135deg,rgba(16,24,39,.88),rgba(8,13,27,.72));box-shadow:var(--shadow);
  position:relative;overflow:hidden;
}
.top:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(34,211,238,.12),transparent 35%,rgba(139,92,246,.12));pointer-events:none}
.top>*{position:relative;z-index:1}
h1{margin:0 0 6px;font-size:34px;line-height:1;letter-spacing:-.045em}
h2{margin:0 0 16px;font-size:18px;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:14px;line-height:1.45}
.tabs{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;max-width:560px}
.tabs a,.subtabs a{
  display:inline-flex;align-items:center;gap:8px;color:var(--text);text-decoration:none;border:1px solid var(--line);
  border-radius:999px;padding:9px 13px;background:rgba(255,255,255,.045);backdrop-filter:blur(12px);
  transition:.18s ease border-color,.18s ease background,.18s ease transform;font-size:14px
}
.tabs a:hover,.subtabs a:hover{border-color:rgba(34,211,238,.65);background:rgba(34,211,238,.08);transform:translateY(-1px)}
.tabs .active,.subtabs a.active{border-color:rgba(34,211,238,.85);color:#a5f3fc;background:linear-gradient(135deg,rgba(34,211,238,.16),rgba(139,92,246,.10))}
.subtabs{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}
.filters{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin:0 0 16px}.filters div{display:flex;flex-direction:column;gap:6px}.filters label,.modal label{color:var(--muted);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.filters select,.filters textarea,.filters input,.modal input,.modal select{min-width:210px;border:1px solid var(--line);border-radius:13px;background:rgba(5,9,22,.75);color:var(--text);padding:10px 11px}.filters textarea{width:100%;min-height:380px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;line-height:1.5;resize:vertical}.filters button,.button,.modal button{border:1px solid rgba(34,211,238,.55);border-radius:13px;background:linear-gradient(135deg,rgba(34,211,238,.18),rgba(139,92,246,.13));color:#e0fbff;padding:10px 13px;font-weight:750;cursor:pointer}.filters button:hover,.button:hover,.modal button:hover{border-color:rgba(34,211,238,.9)}.import-grid{display:grid;grid-template-columns:1fr;gap:12px}.status-msg{margin-top:8px;color:#a7f3d0}.modal-backdrop{position:fixed;inset:0;background:rgba(2,6,23,.72);backdrop-filter:blur(8px);z-index:20}.modal{border:1px solid rgba(148,163,184,.22);border-radius:24px;background:linear-gradient(180deg,rgba(16,24,39,.98),rgba(8,13,27,.98));color:var(--text);box-shadow:0 30px 120px rgba(0,0,0,.55);padding:0;width:min(520px,calc(100vw - 28px));z-index:21}.modal::backdrop{background:rgba(2,6,23,.72);backdrop-filter:blur(8px)}.modal-box{display:grid;gap:12px;padding:20px}.modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.modal-head h2{margin:0}.icon-btn{min-width:auto;border-radius:999px;padding:5px 11px;font-size:22px;line-height:1;background:rgba(255,255,255,.06)}.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}.modal .primary{background:linear-gradient(135deg,rgba(34,211,238,.28),rgba(139,92,246,.22))}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin:18px 0}.grid.two{grid-template-columns:repeat(auto-fit,minmax(360px,1fr))}
.card{
  background:linear-gradient(180deg,rgba(16,24,39,.92),rgba(9,14,28,.92));border:1px solid var(--line);border-radius:var(--radius);
  padding:18px;box-shadow:0 18px 50px rgba(0,0,0,.22);position:relative;overflow:hidden;
}
.card:before{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(34,211,238,.7),rgba(139,92,246,.55),transparent);opacity:.75}
.metric{min-height:138px;display:flex;flex-direction:column;justify-content:space-between}
.metric:after{content:"";position:absolute;right:-34px;bottom:-42px;width:120px;height:120px;border-radius:50%;background:radial-gradient(circle,rgba(34,211,238,.12),transparent 65%)}
.label{color:var(--muted);font-size:13px;font-weight:650;text-transform:uppercase;letter-spacing:.08em}
.big{font-size:36px;font-weight:900;margin:9px 0;color:#e0fbff;letter-spacing:-.055em;text-shadow:0 0 24px rgba(34,211,238,.18)}
.smallbig{font-size:22px;letter-spacing:-.025em;line-height:1.1}.metric div:last-child{color:var(--muted);font-size:13px}
.monthly-card{overflow:hidden;margin-top:18px}.chart{width:100%;height:280px;display:block}.chart.tall{height:360px}.chart-scroll{width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;padding:2px 0 8px}.chart-scroll::-webkit-scrollbar{height:8px}.chart-scroll::-webkit-scrollbar-thumb{background:rgba(148,163,184,.25);border-radius:999px}.chart-box{position:relative;min-width:680px;height:360px}.chart-box .chart{height:100%}.donut-box{position:relative;height:300px;width:100%}.projects-chart-box{position:relative;height:380px;width:100%}.projects-chart-box .chart{height:100%}
.bar-row{display:grid;grid-template-columns:128px 1fr 88px;gap:10px;align-items:center;margin:11px 0}.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dbeafe;font-size:14px}.bar-track{height:12px;border-radius:999px;background:rgba(148,163,184,.12);overflow:hidden;border:1px solid rgba(255,255,255,.04)}.bar-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent2));box-shadow:0 0 18px rgba(34,211,238,.18)}.bar-val{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px}
.table{width:100%;border-collapse:separate;border-spacing:0}.table th,.table td{padding:11px 10px;border-bottom:1px solid var(--line2);text-align:left}.table th{color:var(--muted);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.06em}.table tr:hover td{background:rgba(255,255,255,.025)}.table td.num{text-align:right;font-variant-numeric:tabular-nums;color:#dbeafe}
.error{color:#fecdd3;background:rgba(127,29,29,.30);border:1px solid rgba(248,113,113,.45);border-radius:16px;padding:14px}.small{font-size:12px;color:var(--muted);line-height:1.45}pre{white-space:pre-wrap;word-break:break-word;background:#050916;border:1px solid var(--line);border-radius:16px;padding:16px;overflow:auto;max-height:520px;color:#cbd5e1}
@media (max-width:760px){body{padding:12px}.top{padding:16px;border-radius:18px}.tabs{justify-content:flex-start}.grid.two{grid-template-columns:1fr}.grid{grid-template-columns:1fr 1fr;gap:12px}.card{padding:14px;border-radius:16px}.metric{min-height:118px}.big{font-size:28px}.smallbig{font-size:18px}.tabs a,.subtabs a{padding:8px 10px;font-size:13px}.chart{height:240px}.chart-box{min-width:760px;height:330px}.donut-box{height:280px}.bar-row{grid-template-columns:96px 1fr 72px;gap:8px}.table{font-size:13px}.table th,.table td{padding:8px 6px}}
@media (max-width:430px){h1{font-size:27px}.sub{font-size:13px}.grid{grid-template-columns:1fr}.top{margin-bottom:12px}.monthly-card{margin-top:12px}}
</style></head>
<body><main><div class="top"><div><h1>Token Spend</h1><div class="sub">Tenant ${escapeHtml(identity.tenant?.name || DEFAULT_TENANT.name)} · Device ${escapeHtml(identity.device?.name || DEFAULT_DEVICE.name)} · SQLite · auto-refresh UI 60s · collector ${Math.round(REFRESH_MS/60000)} min · ${escapeHtml(TIMEZONE)}</div></div><div class="tabs">${providerLinks}<a href="/?provider=${encodeURIComponent(provider)}&tenant=${encodeURIComponent(tenantId)}&device=${encodeURIComponent(deviceId)}&period=${encodeURIComponent(period)}&refresh=1">Actualizar ahora</a><a href="/api/report?provider=${encodeURIComponent(provider)}&tenant=${encodeURIComponent(tenantId)}&device=${encodeURIComponent(deviceId)}&period=${encodeURIComponent(period)}">API report</a><a href="/api/site?tenant=${encodeURIComponent(tenantId)}&device=${encodeURIComponent(deviceId)}">API site</a></div></div>
${filters}
${modals}
<div class="subtabs"><a class="${tab === 'dashboard' ? 'active' : ''}" href="/?provider=${encodeURIComponent(provider)}&tenant=${encodeURIComponent(tenantId)}&device=${encodeURIComponent(deviceId)}&period=${encodeURIComponent(period)}&tab=dashboard">Dashboard</a><a class="${tab === 'system' ? 'active' : ''}" href="/?provider=${encodeURIComponent(provider)}&tenant=${encodeURIComponent(tenantId)}&device=${encodeURIComponent(deviceId)}&period=${encodeURIComponent(period)}&tab=system">Sistema</a><a class="${tab === 'config' ? 'active' : ''}" href="/?provider=${encodeURIComponent(provider)}&tenant=${encodeURIComponent(tenantId)}&device=${encodeURIComponent(deviceId)}&period=${encodeURIComponent(period)}&tab=config">Configuración</a></div>
${tab === 'system' ? `
<div class="grid">${systemCards}</div>
<section class="card"><h2>Dispositivos del tenant</h2><div id="devicesTable"></div></section>
` : tab === 'config' ? `
<section class="card"><h2>Altas</h2><div class="filters"><button id="openTenantModal" type="button">+ Tenant</button><button id="openDeviceModal" type="button">+ Device</button><span class="small">Creá tenants y devices desde acá; Dashboard y Sistema quedan solo para visualizar.</span></div></section>
<section class="card"><h2>Importar JSON</h2><div class="import-grid"><div class="filters"><div><label>Tenant destino</label><select id="importTenant">${importTenantOptions}</select></div><div><label>Device destino</label><select id="importDevice">${importDeviceOptions}</select></div><div><label>Archivo JSON</label><input id="siteJsonFile" type="file" accept=".json,application/json"></div><button id="loadSiteJson" type="button">Cargar JSON actual</button><button id="importJson" type="button">Importar / actualizar</button></div><textarea id="siteJsonInput" spellcheck="false">${escapeHtml(JSON.stringify(importIdentity, null, 2))}</textarea><div id="importStatus" class="small">Seleccioná un archivo o pegá el contenido JSON. No pegues la ruta del archivo. Si dejás el destino en JSON, crea/actualiza esa identidad.</div></div></section>
<section class="card"><h2>SQLite / JSON desde la base</h2><pre>${escapeHtml(JSON.stringify(reportObj || {}, null, 2))}</pre><p class="small">DB: ${escapeHtml(DB_PATH)} · LAN abierta sin seguridad.</p></section>
` : `
<div class="grid">${cards}</div>
<section class="card monthly-card"><h2>Costo mensual por modelo</h2><div class="chart-scroll"><div class="chart-box"><canvas id="monthlyStacked" class="chart tall"></canvas></div></div><p class="small">Barras apiladas: cada color es un modelo. En móvil podés deslizar horizontalmente. Tocá una barra para ver costo, tokens y calls.</p></section><section class="card monthly-card"><h2>Top 10 proyectos por consumo</h2><div class="projects-chart-box"><canvas id="topProjectsBar" class="chart"></canvas></div><p class="small">Ranking agregado por proyecto para el tenant/device y período filtrado.</p></section><div class="grid two"><section class="card"><h2>Costo diario</h2><canvas id="daily" class="chart"></canvas></section><section class="card"><h2>Distribución por modelo</h2><div class="donut-box"><canvas id="modelsPie" class="chart"></canvas></div></section><section class="card"><h2>Consumo por device</h2><div class="donut-box"><canvas id="devicesPie" class="chart"></canvas></div></section><section class="card"><h2>Costo por modelo</h2><div id="modelBars"></div></section><section class="card"><h2>Actividad</h2><div id="activityBars"></div></section></div>
<section class="card"><h2>Modelos</h2><div id="modelsTable"></div></section><section class="card"><h2>Top sesiones</h2><div id="sessionsTable"></div></section>
`}</main>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script>window.__REPORT__=${jsonForScript(reportObj || {})};</script>
<script>window.__CATALOG__=${jsonForScript(cat)}; window.__CTX__=${jsonForScript({ provider, tenantId, deviceId, period, tab })};</script>
<script>
const report=window.__REPORT__||{}; const currency=report.currency||'USD'; const fmtMoney=n=>currency+' '+Number(n||0).toFixed(2); const fmtTok=n=>{n=Number(n||0);return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n)}; const colors=['#76e4f7','#a78bfa','#86efac','#fbbf24','#fb7185','#60a5fa','#f472b6','#34d399'];
function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));}
const catalog=window.__CATALOG__||{tenants:[],devices:[]}; const ctx=window.__CTX__||{};
function deviceOptionsFor(tenantId, selected, includeAll=false){const list=(catalog.devices||[]).filter(d=>tenantId==='all'||!tenantId||d.tenantId===tenantId); const opts=list.map(d=>'<option value="'+esc(d.id)+'" '+(d.id===selected?'selected':'')+'>'+esc(d.name)+' ('+esc(d.id)+')</option>').join(''); const first=includeAll?'<option value="all" '+(selected==='all'?'selected':'')+'>Todos los dispositivos</option>':'<option value="" '+(!selected?'selected':'')+'>Device del JSON / crear nuevo</option>'; return first+opts}
function wireCascade(tenantId, deviceId, applyId, includeAll=false){const t=document.getElementById(tenantId),d=document.getElementById(deviceId); if(!t||!d)return; t.addEventListener('change',()=>{d.innerHTML=deviceOptionsFor(t.value,includeAll?'all':'',includeAll);}); const b=applyId&&document.getElementById(applyId); if(b)b.addEventListener('click',()=>{const p=document.getElementById('periodFilter'); const qs=new URLSearchParams({provider:ctx.provider||'all',tenant:t.value,device:d.value||'all',period:p?.value||ctx.period||'all',tab:ctx.tab||'dashboard'}); location.href='/?'+qs.toString();});}
wireCascade('tenantFilter','deviceFilter','applyFilters',true); wireCascade('importTenant','importDevice',null,false);
const fileInput=document.getElementById('siteJsonFile'); if(fileInput)fileInput.addEventListener('change',async()=>{const status=document.getElementById('importStatus'); try{const file=fileInput.files&&fileInput.files[0]; if(!file)return; const text=await file.text(); JSON.parse(text); document.getElementById('siteJsonInput').value=text; status.className='status-msg'; status.textContent='Archivo cargado: '+file.name;}catch(e){status.className='error'; status.textContent='No se pudo leer el JSON: '+String(e.message||e);}});
const loadBtn=document.getElementById('loadSiteJson'); if(loadBtn)loadBtn.addEventListener('click',async()=>{const d=document.getElementById('importDevice')?.value||ctx.deviceId; const r=await fetch('/api/site?device='+encodeURIComponent(d)); document.getElementById('siteJsonInput').value=JSON.stringify(await r.json(),null,2);});
const importBtn=document.getElementById('importJson'); if(importBtn)importBtn.addEventListener('click',async()=>{const status=document.getElementById('importStatus'); try{const payload=JSON.parse(document.getElementById('siteJsonInput').value||'{}'); const body={...payload, selected:{tenantId:document.getElementById('importTenant')?.value||'', deviceId:document.getElementById('importDevice')?.value||''}}; const r=await fetch('/api/site/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); const j=await r.json(); if(!r.ok) throw new Error(j.error||'No se pudo importar'); status.className='status-msg'; status.textContent=(j.duplicateSkipped?'Duplicado omitido: ':'Importado: ')+j.tenant.name+' / '+j.device.name+(j.importedReport?' · snapshot #'+j.snapshotId:''); setTimeout(()=>{const q=new URLSearchParams({provider:j.importedProvider||ctx.provider||'all',tenant:j.tenant.id,device:j.device.id,tab:j.importedReport?'dashboard':'system'}); if(j.importedReport&&j.importedPeriodKey) q.set('period',j.importedPeriodKey); location.href='/?'+q.toString()},650);}catch(e){status.className='error'; status.textContent=String(e.message||e);}});
function openModal(id){const m=document.getElementById(id); if(!m)return; if(typeof m.showModal==='function')m.showModal(); else m.setAttribute('open','');}
document.getElementById('openTenantModal')?.addEventListener('click',()=>openModal('tenantModal'));
document.getElementById('openDeviceModal')?.addEventListener('click',()=>{const s=document.getElementById('deviceTenantInput'); const selected=document.getElementById('tenantFilter')?.value||ctx.tenantId||''; if(s)s.value=selected==='all'?(catalog.tenants?.[0]?.id||''):selected; openModal('deviceModal');});
document.getElementById('saveTenant')?.addEventListener('click',async()=>{const status=document.getElementById('tenantModalStatus'); try{const body={name:document.getElementById('tenantNameInput').value,id:document.getElementById('tenantIdInput').value}; const r=await fetch('/api/tenants',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); const j=await r.json(); if(!r.ok)throw new Error(j.error||'No se pudo crear tenant'); status.className='status-msg'; status.textContent='Tenant creado: '+j.tenant.name; setTimeout(()=>{location.href='/?provider='+(ctx.provider||'all')+'&tenant='+encodeURIComponent(j.tenant.id)+'&period='+encodeURIComponent(ctx.period||'all')+'&tab='+encodeURIComponent(ctx.tab||'dashboard')},500);}catch(e){status.className='error'; status.textContent=String(e.message||e);}});
document.getElementById('saveDevice')?.addEventListener('click',async()=>{const status=document.getElementById('deviceModalStatus'); try{const body={tenantId:document.getElementById('deviceTenantInput').value,name:document.getElementById('deviceNameInput').value,id:document.getElementById('deviceIdInput').value,hostname:document.getElementById('deviceHostnameInput').value}; const r=await fetch('/api/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); const j=await r.json(); if(!r.ok)throw new Error(j.error||'No se pudo crear device'); status.className='status-msg'; status.textContent='Device creado: '+j.device.name; setTimeout(()=>{location.href='/?provider='+(ctx.provider||'all')+'&tenant='+encodeURIComponent(j.device.tenantId)+'&device='+encodeURIComponent(j.device.id)+'&period='+encodeURIComponent(ctx.period||'all')+'&tab='+encodeURIComponent(ctx.tab||'dashboard')},500);}catch(e){status.className='error'; status.textContent=String(e.message||e);}});
function setupCanvas(id){const c=document.getElementById(id),dpr=window.devicePixelRatio||1,r=c.getBoundingClientRect();c.width=r.width*dpr;c.height=r.height*dpr;const ctx=c.getContext('2d');ctx.scale(dpr,dpr);return{c,ctx,w:r.width,h:r.height};}
function lineChart(id,rows){const{ctx,w,h}=setupCanvas(id);const pad={l:44,r:16,t:18,b:42};const vals=rows.map(x=>Number(x.cost||0));const max=Math.max(...vals,0.01);ctx.strokeStyle='rgba(255,255,255,.12)';ctx.font='12px system-ui';ctx.fillStyle='#9aa7bd';for(let i=0;i<4;i++){const y=pad.t+(h-pad.t-pad.b)*i/3;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();ctx.fillText('$'+(max*(1-i/3)).toFixed(2),6,y+4)}const x=i=>pad.l+(w-pad.l-pad.r)*(rows.length<=1?0:i/(rows.length-1));const y=v=>pad.t+(h-pad.t-pad.b)*(1-v/max);ctx.beginPath();rows.forEach((r,i)=>{i?ctx.lineTo(x(i),y(Number(r.cost||0))):ctx.moveTo(x(i),y(Number(r.cost||0)))});ctx.strokeStyle='#76e4f7';ctx.lineWidth=3;ctx.stroke();rows.forEach((r,i)=>{ctx.fillStyle='#76e4f7';ctx.beginPath();ctx.arc(x(i),y(Number(r.cost||0)),4,0,Math.PI*2);ctx.fill();ctx.fillStyle='#9aa7bd';if(rows.length<12||i%Math.ceil(rows.length/6)===0)ctx.fillText(String(r.date||'').slice(5),x(i)-16,h-17)})}
function pieChart(id,rows){
  const canvas=document.getElementById(id);
  if(!canvas || !window.Chart) return;
  const clean=rows.filter(r=>Number(r.cost||0)>0);
  new Chart(canvas,{type:'doughnut',data:{labels:clean.map(r=>r.name||'—'),datasets:[{data:clean.map(r=>Number(r.cost||0)),backgroundColor:clean.map((_,i)=>colors[i%colors.length]),borderColor:'rgba(255,255,255,.12)',borderWidth:1,hoverOffset:8}]},options:{responsive:true,maintainAspectRatio:false,cutout:'62%',plugins:{legend:{position:'bottom',labels:{color:'#edf3ff',boxWidth:10,usePointStyle:true,font:{size:11}}},tooltip:{callbacks:{label:(ctx)=>{const r=clean[ctx.dataIndex]||{};const total=clean.reduce((a,b)=>a+Number(b.cost||0),0)||1;const pct=(Number(r.cost||0)/total*100).toFixed(1);return (r.name||'—')+': '+fmtMoney(r.cost)+' · '+pct+'% · '+fmtTok((r.inputTokens||0)+(r.outputTokens||0)+(r.cacheReadTokens||0)+(r.cacheWriteTokens||0))+' tokens · '+(r.calls||0)+' calls';}}}}}});
}
function bars(elId,rows,getName,getVal,formatter=fmtMoney){const el=document.getElementById(elId);const max=Math.max(...rows.map(getVal),0.001);el.innerHTML=rows.map((r,i)=>{const name=String(getName(r)),val=getVal(r),width=Math.max(1,val/max*100);return '<div class="bar-row"><div class="bar-label" title="'+esc(name)+'">'+esc(name)+'</div><div class="bar-track"><div class="bar-fill" style="width:'+width+'%;background:linear-gradient(90deg,'+colors[i%colors.length]+','+colors[(i+1)%colors.length]+')"></div></div><div class="bar-val">'+esc(formatter(val))+'</div></div>'}).join('')||'<div class="small">Sin datos</div>'}
function table(elId,headers,rows){const el=document.getElementById(elId); if(!el)return; el.innerHTML='<table class="table"><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>'}
const monthly=(report.monthly||[]);
function monthlyStackedChart(){
  const canvas=document.getElementById('monthlyStacked');
  if(!canvas || !window.Chart) return;
  const labels=monthly.map(m=>m.month||m.date||'—');
  const modelNames=[...new Set(monthly.flatMap(m=>(m.models||[]).map(x=>x.name||'—')))];
  const datasets=modelNames.map((name,i)=>({
    label:name,
    data:monthly.map(m=>Number(((m.models||[]).find(x=>(x.name||'—')===name)||{}).cost||0)),
    backgroundColor:colors[i%colors.length],
    borderColor:'rgba(255,255,255,.18)',
    borderWidth:1,
    borderRadius:6,
    modelMeta:monthly.map(m=>((m.models||[]).find(x=>(x.name||'—')===name)||{}))
  })).filter(ds=>ds.data.some(v=>v>0));
  new Chart(canvas,{type:'bar',data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:'#edf3ff',boxWidth:10,usePointStyle:true,font:{size:11}}},tooltip:{callbacks:{label:(ctx)=>{const meta=ctx.dataset.modelMeta[ctx.dataIndex]||{};return ctx.dataset.label+': '+fmtMoney(ctx.parsed.y)+' · '+fmtTok(meta.totalTokens||0)+' tokens · '+(meta.calls||0)+' calls';},footer:(items)=>{const month=monthly[items[0]?.dataIndex]||{};return 'Total: '+fmtMoney(month.cost||0)+' · Top: '+(month.topModel||'—');}}}},scales:{x:{stacked:true,ticks:{color:'#9aa7bd',maxRotation:0,minRotation:0},grid:{color:'rgba(255,255,255,.06)'}},y:{stacked:true,ticks:{color:'#9aa7bd',callback:v=>'$'+Number(v).toFixed(2)},grid:{color:'rgba(255,255,255,.08)'}}}}});
}
function topProjectsBarChart(){
  const canvas=document.getElementById('topProjectsBar');
  if(!canvas || !window.Chart) return;
  const byProject=new Map();
  for(const p of report.projects||[]){
    const name=p.name||p.path||'—';
    const x=byProject.get(name)||{name,path:p.path||'',cost:0,calls:0,sessions:0};
    x.cost+=Number(p.cost||0); x.calls+=Number(p.calls||0); x.sessions+=Number(p.sessions||0);
    if(!x.path && p.path) x.path=p.path;
    byProject.set(name,x);
  }
  const projects=[...byProject.values()].sort((a,b)=>b.cost-a.cost||b.calls-a.calls).slice(0,10);
  new Chart(canvas,{type:'bar',data:{labels:projects.map(p=>p.name),datasets:[{label:'Costo',data:projects.map(p=>p.cost),backgroundColor:projects.map((_,i)=>colors[i%colors.length]),borderColor:'rgba(255,255,255,.18)',borderWidth:1,borderRadius:8}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(ctx)=>{const p=projects[ctx.dataIndex]||{};return fmtMoney(p.cost)+' · '+(p.calls||0)+' calls · '+(p.sessions||0)+' sesiones';},afterLabel:(ctx)=>{const p=projects[ctx.dataIndex]||{};return p.path?'Path: '+p.path:'';}}}},scales:{x:{ticks:{color:'#9aa7bd',callback:v=>'$'+Number(v).toFixed(2)},grid:{color:'rgba(255,255,255,.08)'}},y:{ticks:{color:'#dbeafe',autoSkip:false},grid:{color:'rgba(255,255,255,.04)'}}}}});
}
monthlyStackedChart();topProjectsBarChart();const models=(report.models||[]).filter(m=>Number(m.cost||0)>0||Number(m.calls||0)>0);const devices=(report.deviceBreakdown||[]).filter(d=>Number(d.cost||0)>0||Number(d.calls||0)>0);if(document.getElementById('daily'))lineChart('daily',report.daily||[]);pieChart('modelsPie',models.filter(m=>Number(m.cost||0)>0));pieChart('devicesPie',devices.map(d=>({...d,name:d.name||d.id})));if(document.getElementById('modelBars'))bars('modelBars',models,r=>r.name||'—',r=>Number(r.cost||0));if(document.getElementById('activityBars'))bars('activityBars',report.activities||[],r=>r.category||'—',r=>Number(r.cost||0));table('modelsTable',['Modelo','Calls','Input','Output','Cache read','Cache write','Costo'],models.map(m=>'<tr><td>'+esc(m.name||'—')+'</td><td class="num">'+esc(m.calls||0)+'</td><td class="num">'+esc(fmtTok(m.inputTokens))+'</td><td class="num">'+esc(fmtTok(m.outputTokens))+'</td><td class="num">'+esc(fmtTok(m.cacheReadTokens))+'</td><td class="num">'+esc(fmtTok(m.cacheWriteTokens))+'</td><td class="num">'+esc(fmtMoney(m.cost))+'</td></tr>'));table('sessionsTable',['Fecha','Proyecto','Device','Calls','Costo'],(report.topSessions||[]).slice(0,8).map(s=>'<tr><td>'+esc(s.date||'—')+'</td><td>'+esc(s.project||'—')+'</td><td>'+esc(s.deviceId||'—')+'</td><td class="num">'+esc(s.calls||0)+'</td><td class="num">'+esc(fmtMoney(s.cost))+'</td></tr>'));table('devicesTable',['Device','Hostname','Calls','Sesiones','Costo'],devices.map(d=>'<tr><td>'+esc(d.name||d.id||'—')+'</td><td>'+esc(d.hostname||'—')+'</td><td class="num">'+esc(d.calls||0)+'</td><td class="num">'+esc(d.sessions||0)+'</td><td class="num">'+esc(fmtMoney(d.cost))+'</td></tr>'));
</script></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

async function api(req, res, kind) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const provider = url.searchParams.get('provider') || 'all';
  const deviceId = url.searchParams.get('device') || 'all';
  const tenantId = url.searchParams.get('tenant') || 'all';
  const period = url.searchParams.get('period') || 'all';
  if (kind === 'catalog') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(catalog(), null, 2));
  }
  if (kind === 'tenantCreate') {
    try {
      const body = await readJsonBody(req);
      const tenant = upsertTenant(body);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, tenant, catalog: catalog() }, null, 2));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
    }
  }
  if (kind === 'deviceCreate') {
    try {
      const body = await readJsonBody(req);
      const device = upsertDevice(body);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, device, catalog: catalog() }, null, 2));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
    }
  }
  if (kind === 'siteImport') {
    try {
      const body = await readJsonBody(req);
      const imported = importSitePayload(body, { db, upsertSiteIdentity, insertReport, findDuplicateSnapshot, catalog });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(imported, null, 2));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
    }
  }
  if (kind === 'site') {
    const selected = deviceById(deviceId);
    if (selected) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ tenant: { id: selected.tenantId, name: selected.tenantName }, device: { id: selected.id, name: selected.name, hostname: selected.hostname, tenantId: selected.tenantId } }, null, 2));
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(siteIdentity(), null, 2));
  }
  if (url.searchParams.get('refresh') === '1') await collect(provider, period);
  if (kind === 'status') {
    const snap = deviceId === 'all' ? latestSnapshots(provider, period, tenantId, deviceId) : latestSnapshot(provider, period, deviceId);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ source: 'sqlite', ...siteIdentity(), collector: collectorState, snapshot: snap }, null, 2));
  }
  const report = apiReport(provider, period, deviceId, tenantId);
  res.writeHead(report ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(report || { error: 'no sqlite snapshot yet', collector: collectorState }, null, 2));
}

initDb();
async function collectDefault() { await collect('all', 'all'); await collect('all', '30days'); }
collectDefault();
setInterval(() => collectDefault(), REFRESH_MS).unref();

const server = http.createServer(async (req, res) => {
  try {
    const pathName = new URL(req.url, `http://localhost:${PORT}`).pathname;
    if (pathName === '/api/catalog') return api(req, res, 'catalog');
    if (pathName === '/api/tenants' && req.method === 'POST') return api(req, res, 'tenantCreate');
    if (pathName === '/api/devices' && req.method === 'POST') return api(req, res, 'deviceCreate');
    if (pathName === '/api/site/import' && req.method === 'POST') return api(req, res, 'siteImport');
    if (pathName === '/api/site') return api(req, res, 'site');
    if (pathName === '/api/status') return api(req, res, 'status');
    if (pathName === '/api/report') return api(req, res, 'report');
    if (pathName === '/' || pathName === '/index.html') return dashboard(req, res);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e?.stack || e));
  }
});

server.listen(PORT, HOST, () => {
  const nets = Object.values(os.networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address);
  console.log(`CodeBurn Portal listening on http://${HOST}:${PORT}`);
  console.log(`SQLite DB: ${DB_PATH}`);
  for (const ip of nets) console.log(`LAN URL: http://${ip}:${PORT}/`);
});
