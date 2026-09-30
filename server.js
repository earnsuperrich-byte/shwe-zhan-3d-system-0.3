import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret-change-me');
const SESSION_COOKIE = 'sid_pg_v1';
const SESSION_VERSION = 'pg-v1';
const SESSION_IDLE_MS = 10 * 60 * 1000;
const MAX_PROJECTS_PER_USER = 10;
const LEGACY_DATA = path.join(__dirname, 'data.json');

if (process.env.NODE_ENV === 'production' && SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production');
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Connect this service to a Render PostgreSQL database.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const DEFAULT_SETTINGS = { limit: 900, payoutMultiplier: 700, threeDigitRate: 40, toSendBlockSize: 20, toSendSeries: 5 };

function uid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hex] = String(stored || '').split(':');
    if (!salt || !hex) return false;
    const a = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'), 'hex');
    const b = Buffer.from(hex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readSession(req) {
  const raw = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!raw) return null;
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.ver !== SESSION_VERSION || !p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function setSession(res, user) {
  const issued = Date.now();
  const token = sign({ ver: SESSION_VERSION, id: user.id, username: user.username, role: user.role, iat: issued, exp: issued + SESSION_IDLE_MS });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secure}`);
}
function clearSession(res) { res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`); }

async function dbUser(id) {
  const { rows } = await pool.query('SELECT id, username, password_hash, role, approved, created_at FROM users WHERE id=$1', [id]);
  return rows[0] || null;
}
async function auth(req, res, next) {
  try {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: 'Login required' });
    const u = await dbUser(s.id);
    if (!u || !u.approved) { clearSession(res); return res.status(403).json({ error: 'Account is no longer approved. Please contact admin.' }); }
    req.user = { id: u.id, username: u.username, role: u.role };
    setSession(res, u);
    next();
  } catch (e) { console.error('AUTH_ERROR', e); res.status(500).json({ error: 'Authentication server error' }); }
}
function admin(req, res, next) { return auth(req, res, () => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' })); }

async function ensureOwner() {
  const username = String(process.env.OWNER_ADMIN_USERNAME || 'Thuriyakhun').trim();
  const password = String(process.env.OWNER_ADMIN_PASSWORD || 'Khun12101995');
  const existing = await pool.query('SELECT id, username, password_hash, role, approved FROM users WHERE id=$1 OR lower(username)=lower($2) LIMIT 1', ['owner-admin', username]);
  const row = existing.rows[0];
  if (!row) {
    await pool.query('INSERT INTO users(id,username,password_hash,role,approved,created_at) VALUES($1,$2,$3,$4,$5,$6)', ['owner-admin', username, hashPassword(password), 'admin', true, now()]);
    return;
  }
  if (row.id !== 'owner-admin' || row.username !== username || row.role !== 'admin' || row.approved !== true || !verifyPassword(password, row.password_hash)) {
    await pool.query('UPDATE users SET id=$1, username=$2, password_hash=$3, role=$4, approved=$5 WHERE id=$6', ['owner-admin', username, verifyPassword(password, row.password_hash) ? row.password_hash : hashPassword(password), 'admin', true, row.id]);
  }
}

async function migrateLegacyJsonIfNeeded() {
  // Best-effort one-time migration only when the database is empty and a legacy data.json exists.
  const count = Number((await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n);
  if (count > 0 || !fs.existsSync(LEGACY_DATA)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_DATA, 'utf8'));
    await pool.query('BEGIN');
    for (const u of Array.isArray(legacy.users) ? legacy.users : []) {
      if (!u?.id || !u?.username || !u?.passwordHash) continue;
      await pool.query('INSERT INTO users(id,username,password_hash,role,approved,created_at,settings) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [u.id, u.username, u.passwordHash, u.role || 'user', !!u.approved, u.createdAt || now(), JSON.stringify(u.settings || {})]);
    }
    for (const p of Array.isArray(legacy.projects) ? legacy.projects : []) {
      if (!p?.id || !p?.ownerId || !p?.name) continue;
      await pool.query('INSERT INTO projects(id,owner_id,name,result_number,draft_text,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [p.id, p.ownerId, p.name, p.resultNumber || '', p.draftText || '', p.createdAt || now(), p.updatedAt || now()]);
      for (const e of Array.isArray(p.entries) ? p.entries : []) {
        if (!e?.id || !/^\d{3}$/.test(String(e.number)) || !Number.isFinite(Number(e.cash))) continue;
        await pool.query('INSERT INTO entries(id,project_id,number,cash,source,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [e.id, p.id, String(e.number), Number(e.cash), e.source || '', now()]);
      }
      for (const h of Array.isArray(p.history) ? p.history : []) {
        if (!h?.id) continue;
        await pool.query('INSERT INTO project_history(id,project_id,created_at,reason,name,result_number,entries_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [h.id, p.id, h.createdAt || now(), h.reason || 'Saved', h.name || p.name, h.resultNumber || h.resultNumberSnapshot || '', JSON.stringify(h.entries || [])]);
      }
    }
    for (const g of Array.isArray(legacy.groups) ? legacy.groups : []) {
      if (!g?.id || !g?.name || !g?.ownerId) continue;
      await pool.query('INSERT INTO groups_table(id,name,owner_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [g.id, g.name, g.ownerId, g.createdAt || now()]);
      for (const mid of Array.isArray(g.memberIds) ? g.memberIds : []) await pool.query('INSERT INTO group_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [g.id, mid]);
      for (const m of Array.isArray(g.messages) ? g.messages : []) if (m?.id) await pool.query('INSERT INTO messages(id,group_id,user_id,text,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [m.id, g.id, m.userId, m.text || '', m.createdAt || now()]);
    }
    for (const r of Array.isArray(legacy.reports) ? legacy.reports : []) if (r?.id) await pool.query('INSERT INTO reports(id,user_id,text,status,admin_note,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [r.id, r.userId, r.text || '', r.status || 'open', r.adminNote || '', r.createdAt || now(), r.updatedAt || r.createdAt || now()]);
    for (const n of Array.isArray(legacy.notices) ? legacy.notices : []) if (n?.id) await pool.query('INSERT INTO notices(id,target_user_id,text,created_at,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [n.id, n.targetUserId || 'all', n.text || '', n.createdAt || now(), n.createdBy || null]);
    const s = legacy.settings && typeof legacy.settings === 'object' ? legacy.settings : {};
    await pool.query('INSERT INTO system_settings(key,value_json) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', ['global', JSON.stringify(s)]);
    await pool.query('COMMIT');
    console.log('Legacy data.json migration completed.');
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error('LEGACY_MIGRATION_ERROR', e);
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', approved BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL, settings JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, result_number TEXT NOT NULL DEFAULT '', draft_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_owner_created ON projects(owner_id, created_at);
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number TEXT NOT NULL, cash NUMERIC NOT NULL, source TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id, created_at);
    CREATE TABLE IF NOT EXISTS project_history (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL, reason TEXT NOT NULL, name TEXT NOT NULL,
      result_number TEXT NOT NULL DEFAULT '', entries_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_history_project ON project_history(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value_json JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS groups_table (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES groups_table(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(group_id,user_id));
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups_table(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
    CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', admin_note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, target_user_id TEXT NOT NULL DEFAULT 'all', text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by TEXT REFERENCES users(id) ON DELETE SET NULL);
  `);
  await migrateLegacyJsonIfNeeded();
  await ensureOwner();
  await pool.query('INSERT INTO system_settings(key,value_json) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', ['global', JSON.stringify(DEFAULT_SETTINGS)]);
}

function validateSettings(body, current) {
  const n = {
    limit: Number.isFinite(Number(body?.limit)) ? Number(body.limit) : current.limit,
    payoutMultiplier: Number.isFinite(Number(body?.payoutMultiplier)) ? Number(body.payoutMultiplier) : current.payoutMultiplier,
    threeDigitRate: Number.isFinite(Number(body?.threeDigitRate)) ? Number(body.threeDigitRate) : current.threeDigitRate,
    toSendBlockSize: Number.isFinite(Number(body?.toSendBlockSize)) ? Number(body.toSendBlockSize) : current.toSendBlockSize,
    toSendSeries: Number.isFinite(Number(body?.toSendSeries)) ? Number(body.toSendSeries) : current.toSendSeries,
  };
  if (n.limit < 1 || n.limit > 100000 || n.payoutMultiplier < 0 || n.payoutMultiplier > 100000 || n.threeDigitRate < 0 || n.threeDigitRate > 100 || n.toSendBlockSize < 1 || n.toSendBlockSize > 100 || n.toSendSeries < 1 || n.toSendSeries > 20) return null;
  return n;
}
async function getGlobalSettings() {
  const r = await pool.query('SELECT value_json FROM system_settings WHERE key=$1', ['global']);
  return { ...DEFAULT_SETTINGS, ...(r.rows[0]?.value_json || {}) };
}
async function getPersonalSettings(userId) {
  const u = await pool.query('SELECT settings FROM users WHERE id=$1', [userId]);
  return u.rows[0]?.settings || {};
}
async function effectiveSettings(userId) { return { ...(await getGlobalSettings()), ...(await getPersonalSettings(userId)) }; }
async function projectOwned(projectId, userId) {
  const r = await pool.query('SELECT * FROM projects WHERE id=$1 AND owner_id=$2', [projectId, userId]);
  return r.rows[0] || null;
}
async function projectSnapshot(projectId) {
  const p = (await pool.query('SELECT * FROM projects WHERE id=$1', [projectId])).rows[0];
  if (!p) return null;
  const er = await pool.query('SELECT id,number,cash,source,created_at AS "createdAt" FROM entries WHERE project_id=$1 ORDER BY created_at,id', [projectId]);
  return { id:p.id, ownerId:p.owner_id, name:p.name, resultNumber:p.result_number, draftText:p.draft_text, createdAt:p.created_at, updatedAt:p.updated_at, entries:er.rows.map(x=>({...x,cash:Number(x.cash)})) };
}
async function trimProjectsLocked(client, userId) {
  const rows = (await client.query('SELECT id,name FROM projects WHERE owner_id=$1 ORDER BY created_at ASC,id ASC', [userId])).rows;
  if (rows.length >= MAX_PROJECTS_PER_USER) {
    const deleteCount = rows.length - MAX_PROJECTS_PER_USER + 1;
    const ids = rows.slice(0, deleteCount).map(x=>x.id);
    await client.query('DELETE FROM projects WHERE id = ANY($1::text[])', [ids]);
    return rows.slice(0, deleteCount);
  }
  return [];
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Cache-Control','no-store');
  next();
});
app.use(express.static(path.join(__dirname,'public'), { index: 'index.html', etag: true }));

app.get('/api/health', async (req,res)=>{ const r=await pool.query('SELECT 1 AS ok'); res.json({ok:r.rows[0].ok===1,db:true,time:now()}); });
app.post('/api/register', async (req,res)=>{ try { const username=String(req.body?.username||'').trim(), password=String(req.body?.password||''); if(!/^[A-Za-z0-9_.-]{3,30}$/.test(username)||password.length<6)return res.status(400).json({error:'Username 3-30 chars and password at least 6 chars required'}); await pool.query('INSERT INTO users(id,username,password_hash,role,approved,created_at) VALUES($1,$2,$3,$4,$5,$6)',[uid(),username,hashPassword(password),'user',false,now()]); res.json({ok:true,message:'Account created. Wait for admin approval.'}); } catch(e){ if(e.code==='23505')return res.status(409).json({error:'Username already exists'}); console.error(e);res.status(500).json({error:'Registration error'});} });
app.post('/api/login', async (req,res)=>{try{const username=String(req.body?.username||'').trim(),password=String(req.body?.password||'');const r=await pool.query('SELECT * FROM users WHERE lower(username)=lower($1)',[username]);const u=r.rows[0];if(!u||!verifyPassword(password,u.password_hash))return res.status(401).json({error:'Invalid username or password'});if(!u.approved)return res.status(403).json({error:'Account is waiting for admin approval'});setSession(res,u);res.json({ok:true,user:{id:u.id,username:u.username,role:u.role}});}catch(e){console.error('LOGIN_ERROR',e);res.status(500).json({error:'Login server error'});}});
app.post('/api/logout',(req,res)=>{clearSession(res);res.json({ok:true});});
app.get('/api/me',(req,res)=>{const s=readSession(req);if(!s)return res.json({user:null});res.json({user:{id:s.id,username:s.username,role:s.role}});});

app.get('/api/config',auth,async(req,res)=>res.json({settings:await effectiveSettings(req.user.id)}));
app.get('/api/my/settings',auth,async(req,res)=>res.json({settings:await effectiveSettings(req.user.id)}));
app.put('/api/my/settings',auth,async(req,res)=>{const current=await effectiveSettings(req.user.id),next=validateSettings(req.body,current);if(!next)return res.status(400).json({error:'Invalid settings'});await pool.query('UPDATE users SET settings=$1 WHERE id=$2',[JSON.stringify(next),req.user.id]);res.json({ok:true,settings:next});});
app.get('/api/admin/settings',admin,async(req,res)=>res.json({settings:await getGlobalSettings()}));
app.put('/api/admin/settings',admin,async(req,res)=>{const current=await getGlobalSettings(),next=validateSettings(req.body,current);if(!next)return res.status(400).json({error:'Invalid system settings'});await pool.query('INSERT INTO system_settings(key,value_json) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json',['global',JSON.stringify(next)]);res.json({ok:true,settings:next});});

app.get('/api/projects',auth,async(req,res)=>{const r=await pool.query('SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt",result_number AS "resultNumber",(SELECT COUNT(*) FROM entries e WHERE e.project_id=p.id)::int AS "entryCount" FROM projects p WHERE owner_id=$1 ORDER BY created_at DESC',[req.user.id]);res.json({projects:r.rows});});
app.post('/api/projects',auth,async(req,res)=>{const name=String(req.body?.name||'').trim();if(!name)return res.status(400).json({error:'Project name required'});const client=await pool.connect();try{await client.query('BEGIN');const removed=await trimProjectsLocked(client,req.user.id);const t=now(),p={id:uid(),ownerId:req.user.id,name,resultNumber:'',draftText:'',createdAt:t,updatedAt:t,entries:[]};await client.query('INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES($1,$2,$3,$4,$5)',[p.id,p.ownerId,p.name,t,t]);await client.query('COMMIT');res.json({project:p,autoDeleted:removed});}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Project create failed'});}finally{client.release();}});
app.get('/api/projects/:projectId',auth,async(req,res)=>{const p=await projectOwned(req.params.projectId,req.user.id);if(!p)return res.status(404).json({error:'Project not found'});res.json({project:await projectSnapshot(p.id)});});
app.put('/api/projects/:projectId/result',auth,async(req,res)=>{const p=await projectOwned(req.params.projectId,req.user.id);if(!p)return res.status(404).json({error:'Project not found'});const resultNumber=String(req.body?.resultNumber||'');if(!/^\d{3}$/.test(resultNumber))return res.status(400).json({error:'Result number must be 000-999'});const r=await pool.query('UPDATE projects SET result_number=$1,updated_at=$2 WHERE id=$3 RETURNING id,name,result_number AS "resultNumber",draft_text AS "draftText",created_at AS "createdAt",updated_at AS "updatedAt"',[resultNumber,now(),p.id]);const snap=await projectSnapshot(p.id);res.json({ok:true,project:{...r.rows[0],ownerId:req.user.id,entries:snap.entries}});});
app.post('/api/projects/:projectId/entries',auth,async(req,res)=>{const p=await projectOwned(req.params.projectId,req.user.id);if(!p)return res.status(404).json({error:'Project not found'});const incoming=Array.isArray(req.body?.entries)?req.body.entries:[];const clean=incoming.filter(x=>x&&/^\d{3}$/.test(String(x.number||''))&&Number.isFinite(Number(x.cash))).map(x=>({id:String(x.id||uid()),number:String(x.number),cash:Number(x.cash),source:String(x.source||'')}));const client=await pool.connect();try{await client.query('BEGIN');for(const x of clean)await client.query('INSERT INTO entries(id,project_id,number,cash,source,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',[x.id,p.id,x.number,x.cash,x.source,now()]);await client.query('UPDATE projects SET updated_at=$1 WHERE id=$2',[now(),p.id]);await client.query('COMMIT');res.json({ok:true,project:await projectSnapshot(p.id)});}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Entry save failed'});}finally{client.release();}});
app.put('/api/projects/:projectId/entries/:entryId',auth,async(req,res)=>{const p=await projectOwned(req.params.projectId,req.user.id);if(!p)return res.status(404).json({error:'Project not found'});const n=String(req.body?.number||''),c=Number(req.body?.cash);if(!/^\d{3}$/.test(n)||!Number.isFinite(c)||c<0)return res.status(400).json({error:'Invalid entry'});const r=await pool.query('UPDATE entries SET number=$1,cash=$2 WHERE id=$3 AND project_id=$4 RETURNING id,number,cash',[n,c,req.params.entryId,p.id]);if(!r.rows[0])return res.status(404).json({error:'Entry not found'});await pool.query('UPDATE projects SET updated_at=$1 WHERE id=$2',[now(),p.id]);res.json({ok:true,entry:{...r.rows[0],cash:Number(r.rows[0].cash)}});});
app.delete('/api/projects/:projectId/entries/:entryId',auth,async(req,res)=>{const p=await projectOwned(req.params.projectId,req.user.id);if(!p)return res.status(404).json({error:'Project not found'});await pool.query('DELETE FROM entries WHERE id=$1 AND project_id=$2',[req.params.entryId,p.id]);await pool.query('UPDATE projects SET updated_at=$1 WHERE id=$2',[now(),p.id]);res.json({ok:true});});
app.put('/api/projects/:projectId',auth,async(req,res)=>{const p=await projectOwned(req.params.projectId,req.user.id);if(!p)return res.status(404).json({error:'Project not found'});const client=await pool.connect();try{await client.query('BEGIN');const current=await projectSnapshot(p.id);const name=String(req.body?.name||p.name).trim()||p.name;const resultNumber=typeof req.body?.resultNumber==='string'?req.body.resultNumber:p.result_number;const draftText=typeof req.body?.draftText==='string'?req.body.draftText:p.draft_text;const reason=String(req.body?.historyReason||'Saved').slice(0,80);const entries=Array.isArray(req.body?.entries)?req.body.entries.filter(x=>x&&/^\d{3}$/.test(String(x.number))&&Number.isFinite(Number(x.cash))):current.entries;if(!reason.startsWith('auto') && JSON.stringify(current.entries)!==JSON.stringify(entries)) await client.query('INSERT INTO project_history(id,project_id,created_at,reason,name,result_number,entries_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid(),p.id,now(),reason,current.name,current.resultNumber,JSON.stringify(current.entries)]);await client.query('DELETE FROM entries WHERE project_id=$1',[p.id]);for(const x of entries)await client.query('INSERT INTO entries(id,project_id,number,cash,source,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET number=EXCLUDED.number,cash=EXCLUDED.cash,source=EXCLUDED.source',[String(x.id||uid()),p.id,String(x.number),Number(x.cash),String(x.source||''),now()]);await client.query('UPDATE projects SET name=$1,result_number=$2,draft_text=$3,updated_at=$4 WHERE id=$5',[name,resultNumber,draftText,now(),p.id]);await client.query('COMMIT');res.json({ok:true,project:await projectSnapshot(p.id)});}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Project save failed'});}finally{client.release();}});
app.delete('/api/projects/:projectId',auth,async(req,res)=>{const p=await projectOwned(req.params.projectId,req.user.id);if(!p)return res.status(404).json({error:'Project not found'});await pool.query('DELETE FROM projects WHERE id=$1',[p.id]);res.json({ok:true});});
app.get('/api/projects/:projectId/history',auth,async(req,res)=>{const p=await projectOwned(req.params.projectId,req.user.id);if(!p)return res.status(404).json({error:'Project not found'});const r=await pool.query('SELECT id,created_at AS "createdAt",reason,name,result_number AS "resultNumber",jsonb_array_length(entries_snapshot)::int AS "entriesCount" FROM project_history WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50',[p.id]);res.json({history:r.rows});});
app.post('/api/projects/:projectId/history/:historyId',auth,async(req,res)=>{const p=await projectOwned(req.params.projectId,req.user.id);if(!p)return res.status(404).json({error:'Project not found'});const h=(await pool.query('SELECT * FROM project_history WHERE id=$1 AND project_id=$2',[req.params.historyId,p.id])).rows[0];if(!h)return res.status(404).json({error:'History version not found'});const current=await projectSnapshot(p.id);const client=await pool.connect();try{await client.query('BEGIN');await client.query('INSERT INTO project_history(id,project_id,created_at,reason,name,result_number,entries_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid(),p.id,now(),'Before restore',current.name,current.resultNumber,JSON.stringify(current.entries)]);await client.query('DELETE FROM entries WHERE project_id=$1',[p.id]);for(const x of (h.entries_snapshot||[]))await client.query('INSERT INTO entries(id,project_id,number,cash,source,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[String(x.id||uid()),p.id,String(x.number),Number(x.cash),String(x.source||''),now()]);await client.query('UPDATE projects SET result_number=$1,name=$2,updated_at=$3 WHERE id=$4',[h.result_number||'',h.name||p.name,now(),p.id]);await client.query('COMMIT');res.json({ok:true,project:await projectSnapshot(p.id)});}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'History restore failed'});}finally{client.release();}});

app.get('/api/admin/users',admin,async(req,res)=>{const r=await pool.query('SELECT id,username,role,approved,created_at AS "createdAt" FROM users ORDER BY created_at ASC');res.json({users:r.rows});});
app.patch('/api/admin/users/:id',admin,async(req,res)=>{const u=(await pool.query('SELECT * FROM users WHERE id=$1',[req.params.id])).rows[0];if(!u)return res.status(404).json({error:'User not found'});if(u.id===req.user.id && (req.body?.approved===false || req.body?.role==='user'))return res.status(400).json({error:'You cannot revoke or demote your own admin account'});const approved=('approved' in (req.body||{}))?!!req.body.approved:u.approved;const role=['user','developer','admin'].includes(req.body?.role)?req.body.role:u.role;await pool.query('UPDATE users SET approved=$1,role=$2 WHERE id=$3',[approved,role,u.id]);res.json({ok:true});});
app.delete('/api/admin/users/:id',admin,async(req,res)=>{if(req.params.id===req.user.id||req.params.id==='owner-admin')return res.status(400).json({error:'The owner/active admin cannot be deleted'});await pool.query('DELETE FROM users WHERE id=$1',[req.params.id]);res.json({ok:true});});
app.get('/api/users',auth,async(req,res)=>{const r=await pool.query('SELECT id,username,role FROM users WHERE approved=true ORDER BY username');res.json({users:r.rows});});
app.get('/api/admin/projects',admin,async(req,res)=>{const r=await pool.query('SELECT p.id,p.name,p.owner_id AS "ownerId",u.username AS "ownerUsername",p.updated_at AS "updatedAt",(SELECT COUNT(*) FROM entries e WHERE e.project_id=p.id)::int AS "entryCount",p.result_number AS "resultNumber" FROM projects p JOIN users u ON u.id=p.owner_id ORDER BY p.updated_at DESC');res.json({projects:r.rows});});

app.get('/api/reports',auth,async(req,res)=>res.json({reports:[]}));
app.post('/api/reports',auth,async(req,res)=>{const text=String(req.body?.text||'').trim();if(!text||text.length>3000)return res.status(400).json({error:'Report message is required'});await pool.query('INSERT INTO reports(id,user_id,text,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)',[uid(),req.user.id,text,'open',now(),now()]);res.json({ok:true});});
app.get('/api/admin/reports',admin,async(req,res)=>{const r=await pool.query('SELECT r.*,u.username FROM reports r JOIN users u ON u.id=r.user_id ORDER BY created_at DESC');res.json({reports:r.rows});});
app.patch('/api/admin/reports/:id',admin,async(req,res)=>{const status=['open','reviewed','closed'].includes(req.body?.status)?req.body.status:'open';await pool.query('UPDATE reports SET status=$1,admin_note=$2,updated_at=$3 WHERE id=$4',[status,String(req.body?.adminNote||''),now(),req.params.id]);res.json({ok:true});});

app.get('/api/notices',auth,async(req,res)=>{const r=await pool.query("SELECT id,target_user_id AS \"targetUserId\",text,created_at AS \"createdAt\" FROM notices WHERE target_user_id='all' OR target_user_id=$1 ORDER BY created_at DESC LIMIT 50",[req.user.id]);res.json({notices:r.rows});});
app.get('/api/admin/notices',admin,async(req,res)=>{const r=await pool.query('SELECT id,target_user_id AS "targetUserId",text,created_at AS "createdAt" FROM notices ORDER BY created_at DESC LIMIT 500');res.json({notices:r.rows});});
app.post('/api/admin/notices',admin,async(req,res)=>{const text=String(req.body?.text||'').trim(),target=String(req.body?.targetUserId||'all');if(!text||text.length>3000)return res.status(400).json({error:'Notice message is required'});if(target!=='all' && !(await pool.query('SELECT 1 FROM users WHERE id=$1 AND approved=true',[target])).rows[0])return res.status(400).json({error:'Target user not found'});const n={id:uid(),targetUserId:target,text,createdAt:now()};await pool.query('INSERT INTO notices(id,target_user_id,text,created_at,created_by) VALUES($1,$2,$3,$4,$5)',[n.id,n.targetUserId,n.text,n.createdAt,req.user.id]);res.json({ok:true,notice:n});});

app.get('/api/groups',auth,async(req,res)=>{const gq=await pool.query(`SELECT g.id,g.name,g.owner_id AS "ownerId",g.created_at AS "createdAt" FROM groups_table g WHERE $1='admin' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=$2) ORDER BY g.created_at DESC`,[req.user.role,req.user.id]);const groups=[];for(const g of gq.rows){const members=(await pool.query('SELECT u.username FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1 ORDER BY u.username',[g.id])).rows.map(x=>x.username);const msgs=(await pool.query('SELECT m.id,m.user_id AS "userId",u.username,m.text,m.created_at AS "createdAt" FROM messages m JOIN users u ON u.id=m.user_id WHERE m.group_id=$1 ORDER BY m.created_at DESC LIMIT 100',[g.id])).rows.reverse();groups.push({...g,members,messages:msgs});}res.json({groups});});
app.post('/api/groups',auth,async(req,res)=>{const name=String(req.body?.name||'').trim();let ids=Array.isArray(req.body?.memberIds)?req.body.memberIds.map(String):[];if(!name)return res.status(400).json({error:'Group name required'});ids=[req.user.id,...ids];ids=[...new Set(ids)];const approved=(await pool.query('SELECT id FROM users WHERE id=ANY($1::text[]) AND approved=true',[ids])).rows.map(x=>x.id);const g={id:uid(),name,ownerId:req.user.id,createdAt:now()};await pool.query('INSERT INTO groups_table(id,name,owner_id,created_at) VALUES($1,$2,$3,$4)',[g.id,g.name,g.ownerId,g.createdAt]);for(const id of approved)await pool.query('INSERT INTO group_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[g.id,id]);res.json({group:g});});
app.post('/api/groups/:id/messages',auth,async(req,res)=>{const text=String(req.body?.text||'').trim();if(!text)return res.status(400).json({error:'Message is required'});const g=(await pool.query('SELECT id FROM groups_table WHERE id=$1',[req.params.id])).rows[0];if(!g)return res.status(404).json({error:'Group not found'});if(req.user.role!=='admin'&&!(await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[g.id,req.user.id])).rows[0])return res.status(403).json({error:'Not a group member'});await pool.query('INSERT INTO messages(id,group_id,user_id,text,created_at) VALUES($1,$2,$3,$4,$5)',[uid(),g.id,req.user.id,text,now()]);res.json({ok:true});});


app.post('/api/voice/transcribe',auth,async(req,res)=>{
  const audio=String(req.body?.audio||'').trim();
  const language=String(req.body?.language||'my-MM');
  const mimeType=String(req.body?.mimeType||'audio/webm').split(';')[0].toLowerCase();
  const supportedMimeTypes=new Set(['audio/webm','audio/wav','audio/mp4','audio/mpeg','audio/ogg','audio/aac','audio/m4a']);
  if(!audio||audio.length>1500000||!/^[A-Za-z0-9+/]+={0,2}$/.test(audio))return res.status(400).json({error:'Voice recording is missing or too large'});
  if(!supportedMimeTypes.has(mimeType))return res.status(400).json({error:'Unsupported voice recording format'});
  const key=process.env.GEMINI_API_KEY;
  if(!key)return res.status(503).json({error:'GEMINI_API_KEY is not configured'});
  const model=process.env.GEMINI_STT_MODEL||process.env.GEMINI_MODEL||'gemini-2.5-flash';
  const languageHint=language==='en-US'?'English':'Burmese (Myanmar)';
  const prompt=`Transcribe this short voice command spoken in ${languageHint}. Return only the command tokens: digits and uppercase R, separated by single spaces. Convert spoken numbers into digits. Convert the spoken Burmese letter name အာ / အာရ်, the English letter R, and ပါတ်လည် to uppercase R. Do not return any other letters, words, punctuation, labels, or explanation. Keep the order spoken. If speech is unclear, return an empty string.`;
  try{
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt},{inlineData:{mimeType,data:audio}}]}],generationConfig:{temperature:0,responseMimeType:'text/plain'}})});
    const data=await r.json();
    if(!r.ok)return res.status(502).json({error:'Gemini speech recognition failed',detail:data?.error?.message||''});
    const transcript=data?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('').trim()||'';
    if(!transcript)return res.status(422).json({error:'Could not recognize speech'});
    res.json({transcript,source:'gemini'});
  }catch(e){console.error('VOICE_STT_ERROR',e);res.status(502).json({error:'Gemini speech recognition failed'});}
});

app.post('/api/voice/interpret',auth,async(req,res)=>{
  const rawTranscript=String(req.body?.transcript||'').trim();
  const language=String(req.body?.language||'my-MM');
  if(!rawTranscript || rawTranscript.length>2000)return res.status(400).json({error:'Voice transcript is required'});
  const numericTranscript=rawTranscript
    .replace(/[၀-၉]/g,ch=>'၀၁၂၃၄၅၆၇၈၉'.indexOf(ch))
    .replace(/ပတ်လည်|ပါတ်လည်|အာရ်|အာ\s*ရ်|အာ/g,' R ')
    .replace(/\b(?:r|are|ar)\b/gi,' R ')
    .replace(/\b\d{4,}\b/g,n=>`${n.slice(0,3)} ${n.slice(3)}`);
  let hasR=false;
  const transcript=[...numericTranscript.matchAll(/\d+(?:\.\d+)?|\bR\b/gi)].map(x=>x[0].toUpperCase()).filter(x=>{
    if(x!=='R')return true;
    if(hasR)return false;
    hasR=true;return true;
  }).join(' ');
  if(!transcript)return res.json({ambiguous:true,confidence:0});
  const key=process.env.GEMINI_API_KEY;
  if(!key)return res.status(503).json({error:'GEMINI_API_KEY is not configured'});
  const model=process.env.GEMINI_MODEL||'gemini-2.5-flash';
  const prompt=`You interpret voice commands for a Myanmar 3-digit cash ledger. Return JSON only.
Rules:
- A command has a 3-digit number 000-999 and cash amount.
- Only digit tokens and R are command data; ignore every other word or character.
- R, r, spoken အာ / အာရ်, and ပါတ်လည် mean round/permutation.
- "490 R 300" means all six UNIQUE permutations of 490 have cash 300.
- "490 300 R 100" means 490 has 300 and the other five UNIQUE permutations have 100.
- "490 300 R" means all six UNIQUE permutations have 300.
- For repeated digits, only unique permutations.
- Do not invent a number or cash amount.
- Dates are not commands.
- If unclear or missing required data, set ambiguous=true.
Return exactly: {"number":"490","cash":300,"round":true,"roundCash":300,"ambiguous":false,"confidence":0.99}
For non-round: {"number":"490","cash":300,"round":false,"roundCash":null,"ambiguous":false,"confidence":0.99}
Transcript language: ${language}
Transcript: ${transcript}`;
  try{
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0,responseMimeType:'application/json'}})});
    const data=await r.json();
    if(!r.ok) return res.status(502).json({error:'AI voice interpretation failed',detail:data?.error?.message||''});
    const text=data?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||'';
    const clean=text.replace(/^```json\s*/i,'').replace(/```$/,'').trim();
    const out=JSON.parse(clean);
    const number=String(out.number||'');
    const cash=Number(out.cash);
    const round=!!out.round;
    const roundCash=out.roundCash==null?null:Number(out.roundCash);
    const confidence=Math.max(0,Math.min(1,Number(out.confidence??0)));
    if(!/^\d{3}$/.test(number)||!Number.isFinite(cash)||cash<0||cash>1e12||out.ambiguous||confidence<0.75)
      return res.json({ambiguous:true,confidence,raw:out});
    if(round && (roundCash===null||!Number.isFinite(roundCash)||roundCash<0||roundCash>1e12))
      return res.json({ambiguous:true,confidence,raw:out});
    res.json({number,cash,round,roundCash,ambiguous:false,confidence});
  }catch(e){console.error('VOICE_AI_ERROR',e);res.status(502).json({error:'AI voice interpretation failed'});}
});

app.use((req,res,next)=>{ if(req.path.startsWith('/api/')) return res.status(404).json({error:'API endpoint not found'}); next(); });
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(()=>app.listen(PORT,()=>console.log(`Shwe Zhan 3D System running on ${PORT}`))).catch(e=>{console.error('DB_INIT_ERROR',e);process.exit(1);});
