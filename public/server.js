import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 4000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.DATABASE_URL?.includes('render') || process.env.DATABASE_URL?.includes('neon') ? { rejectUnauthorized: false } : false
});

function hash(value, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.pbkdf2Sync(value, salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${digest}`;
}
function verify(value, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  return hash(value, salt) === stored;
}
function token() { return crypto.randomBytes(24).toString('hex'); }

const sessions = new Map();
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const t = auth.replace('Bearer ', '');
  const user = sessions.get(t);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

async function q(sql, params = []) { return pool.query(sql, params); }

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'ADMIN', created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'EMPLOYEE',
    pin_hash TEXT NOT NULL, pin_last4 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
    pay_type TEXT NOT NULL DEFAULT 'Hourly', hourly_rate NUMERIC(10,2),
    vacation_hours NUMERIC(10,2) NOT NULL DEFAULT 0, sick_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS punches (
    id SERIAL PRIMARY KEY, employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
    type TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), note TEXT, created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS time_off_requests (
    id SERIAL PRIMARY KEY, employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
    start_date DATE NOT NULL, end_date DATE NOT NULL, hours NUMERIC(10,2) NOT NULL,
    type TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'PENDING', manager_note TEXT,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
  )`);

  const admin = await q('SELECT id FROM users LIMIT 1');
  if (admin.rowCount === 0) {
    await q('INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4)', [
      process.env.ADMIN_EMAIL || 'admin@attendly.local', 'Admin', hash(process.env.ADMIN_PASSWORD || 'admin123!'), 'ADMIN'
    ]);
  }
  const employees = await q('SELECT id FROM employees LIMIT 1');
  if (employees.rowCount === 0) {
    const seed = [
      ['Phillip Cuffy','Flat Rate Technician','8659','Flat Rate'],
      ['Kainat Imtiaz','Office','8545','Hourly'],
      ['Lyn Ford','Office','6548','Hourly'],
      ['Sadie Henry','Parts','9865','Hourly'],
      ['Linda Cardarelli','Hourly Technician','7532','Hourly'],
      ['Tony Cardarelli','Flat Rate Technician','9999','Flat Rate'],
      ['Corey Holloman','Hourly Technician','7777','Hourly'],
      ['Justin Bishop','Flat Rate Technician','0123','Flat Rate'],
      ['Dylan Rower','Hourly Technician','0000','Hourly'],
      ['Andrew Blades','Manager','1234','Salary'],
      ['Sean Ryder','Manager','6386','Salary']
    ];
    for (const [name, role, pin, pay_type] of seed) {
      await q('INSERT INTO employees (name,role,pin_hash,pin_last4,pay_type,vacation_hours,sick_hours) VALUES ($1,$2,$3,$4,$5,$6,$7)', [name, role, hash(pin), pin, pay_type, 40, 24]);
    }
  }
}

app.get('/api/health', async (req,res)=> {
  try { await q('select 1'); res.json({ ok:true }); } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.post('/api/login', async (req,res)=> {
  const { email, password } = req.body;
  const r = await q('SELECT * FROM users WHERE email=$1', [email]);
  if (!r.rowCount || !verify(password, r.rows[0].password_hash)) return res.status(401).json({ error:'Bad login' });
  const t = token(); sessions.set(t, { id:r.rows[0].id, email:r.rows[0].email, name:r.rows[0].name });
  res.json({ token:t, user:sessions.get(t) });
});
app.get('/api/employees', requireAdmin, async (req,res)=> {
  const r = await q('SELECT id,name,role,pin_last4,status,pay_type,hourly_rate,vacation_hours,sick_hours,created_at FROM employees ORDER BY name');
  res.json(r.rows);
});
app.post('/api/employees', requireAdmin, async (req,res)=> {
  const { name, role='EMPLOYEE', pin, status='ACTIVE', pay_type='Hourly', hourly_rate=null } = req.body;
  if (!name || !pin) return res.status(400).json({error:'Name and PIN required'});
  const r = await q('INSERT INTO employees (name,role,pin_hash,pin_last4,status,pay_type,hourly_rate) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [name, role, hash(pin), String(pin).slice(-4), status, pay_type, hourly_rate]);
  res.json(r.rows[0]);
});
app.put('/api/employees/:id', requireAdmin, async (req,res)=> {
  const { name, role, status, pay_type, hourly_rate, vacation_hours, sick_hours, pin } = req.body;
  const old = await q('SELECT * FROM employees WHERE id=$1',[req.params.id]); if(!old.rowCount) return res.status(404).json({error:'Not found'});
  const pinHash = pin ? hash(pin) : old.rows[0].pin_hash; const pinLast = pin ? String(pin).slice(-4) : old.rows[0].pin_last4;
  const r = await q(`UPDATE employees SET name=$1, role=$2, status=$3, pay_type=$4, hourly_rate=$5, vacation_hours=$6, sick_hours=$7, pin_hash=$8, pin_last4=$9, updated_at=now() WHERE id=$10 RETURNING *`,
    [name??old.rows[0].name, role??old.rows[0].role, status??old.rows[0].status, pay_type??old.rows[0].pay_type, hourly_rate??old.rows[0].hourly_rate, vacation_hours??old.rows[0].vacation_hours, sick_hours??old.rows[0].sick_hours, pinHash, pinLast, req.params.id]);
  res.json(r.rows[0]);
});
app.delete('/api/employees/:id', requireAdmin, async (req,res)=> { await q('DELETE FROM employees WHERE id=$1',[req.params.id]); res.json({ok:true}); });

app.post('/api/kiosk/login', async (req,res)=> {
  const { pin } = req.body;
  const r = await q("SELECT id,name,role,status,pin_hash,pin_last4,vacation_hours,sick_hours FROM employees WHERE status='ACTIVE'");
  const emp = r.rows.find(e => verify(String(pin), e.pin_hash));
  if (!emp) return res.status(401).json({ error:'Invalid PIN' });
  const last = await q('SELECT type,occurred_at FROM punches WHERE employee_id=$1 ORDER BY occurred_at DESC LIMIT 1',[emp.id]);
  const recent = await q('SELECT type,occurred_at,note FROM punches WHERE employee_id=$1 ORDER BY occurred_at DESC LIMIT 8',[emp.id]);
  const requests = await q('SELECT * FROM time_off_requests WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 8',[emp.id]);
  res.json({ employee:{id:emp.id,name:emp.name,role:emp.role,vacation_hours:emp.vacation_hours,sick_hours:emp.sick_hours}, clockedIn:last.rowCount && last.rows[0].type==='CLOCK_IN', lastPunch:last.rows[0]||null, recent:recent.rows, requests:requests.rows });
});

app.post('/api/kiosk/timeoff', async (req,res)=> {
  const { pin, start_date, end_date, hours, type, reason='' } = req.body;
  const r = await q("SELECT * FROM employees WHERE status='ACTIVE'");
  const emp = r.rows.find(e => verify(String(pin), e.pin_hash));
  if (!emp) return res.status(401).json({ error:'Invalid PIN' });
  const created = await q('INSERT INTO time_off_requests (employee_id,start_date,end_date,hours,type,reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',[emp.id,start_date,end_date,hours,type,reason]);
  res.json(created.rows[0]);
});

app.post('/api/kiosk/punch', async (req,res)=> {
  const { pin, note='' } = req.body;
  const r = await q("SELECT * FROM employees WHERE status='ACTIVE'");
  const emp = r.rows.find(e => verify(String(pin), e.pin_hash));
  if (!emp) return res.status(401).json({ error:'Invalid PIN' });
  const last = await q('SELECT type FROM punches WHERE employee_id=$1 ORDER BY occurred_at DESC LIMIT 1',[emp.id]);
  const type = last.rowCount && last.rows[0].type === 'CLOCK_IN' ? 'CLOCK_OUT' : 'CLOCK_IN';
  const p = await q('INSERT INTO punches (employee_id,type,note) VALUES ($1,$2,$3) RETURNING *',[emp.id,type,note]);
  res.json({ employee: { id:emp.id, name:emp.name }, punch:p.rows[0] });
});
app.get('/api/punches', requireAdmin, async (req,res)=> {
  const r = await q(`SELECT p.*, e.name employee_name FROM punches p JOIN employees e ON e.id=p.employee_id ORDER BY p.occurred_at DESC LIMIT 500`);
  res.json(r.rows);
});
app.get('/api/timeoff', requireAdmin, async (req,res)=> {
  const r = await q(`SELECT t.*, e.name employee_name FROM time_off_requests t JOIN employees e ON e.id=t.employee_id ORDER BY t.created_at DESC`);
  res.json(r.rows);
});
app.post('/api/timeoff', requireAdmin, async (req,res)=> {
  const { employee_id, start_date, end_date, hours, type, reason='' } = req.body;
  const r = await q('INSERT INTO time_off_requests (employee_id,start_date,end_date,hours,type,reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',[employee_id,start_date,end_date,hours,type,reason]);
  res.json(r.rows[0]);
});
app.put('/api/timeoff/:id', requireAdmin, async (req,res)=> {
  const { status, manager_note='' } = req.body;
  const r = await q('UPDATE time_off_requests SET status=$1, manager_note=$2, updated_at=now() WHERE id=$3 RETURNING *',[status,manager_note,req.params.id]);
  res.json(r.rows[0]);
});
app.get('/api/dashboard', requireAdmin, async (req,res)=> {
  const [employees,punches,pending,total] = await Promise.all([
    q("SELECT count(*)::int c FROM employees WHERE status='ACTIVE'"),
    q("SELECT count(*)::int c FROM punches WHERE occurred_at::date=current_date"),
    q("SELECT count(*)::int c FROM time_off_requests WHERE status='PENDING'"),
    q('SELECT count(*)::int c FROM employees')
  ]);
  res.json({ activeEmployees:employees.rows[0].c, todayPunches:punches.rows[0].c, pendingRequests:pending.rows[0].c, totalEmployees:total.rows[0].c });
});
app.get('/api/reports/summary', requireAdmin, async (req,res)=> {
  const [byRole, recent, pto] = await Promise.all([
    q('SELECT role, count(*)::int count FROM employees GROUP BY role ORDER BY role'),
    q(`SELECT e.name, p.type, p.occurred_at FROM punches p JOIN employees e ON e.id=p.employee_id ORDER BY p.occurred_at DESC LIMIT 12`),
    q('SELECT status, count(*)::int count FROM time_off_requests GROUP BY status ORDER BY status')
  ]);
  res.json({ byRole:byRole.rows, recent:recent.rows, pto:pto.rows });
});

app.get('/api/export/punches.csv', requireAdmin, async (req,res)=> {
  const r = await q(`SELECT e.name,p.type,p.occurred_at,p.note FROM punches p JOIN employees e ON e.id=p.employee_id ORDER BY p.occurred_at DESC`);
  res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename="punches.csv"');
  res.write('Employee,Type,Time,Note\n');
  for (const row of r.rows) res.write([row.name,row.type,row.occurred_at,row.note||''].map(v => `"${String(v).replaceAll('"','""')}"`).join(',')+'\n');
  res.end();
});

app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(()=> app.listen(PORT, '0.0.0.0', () => console.log(`Attendly running on ${PORT}`))).catch(err => {
  console.error('Startup failed:', err.message);
  app.listen(PORT, '0.0.0.0', () => console.log(`Attendly running but database failed: ${err.message}`));
});
