import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

function hash(value, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.pbkdf2Sync(String(value), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${digest}`;
}
function verify(value, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  return hash(String(value), salt) === stored;
}
function token() { return crypto.randomBytes(24).toString('hex'); }
function csvEscape(v) { return `"${String(v ?? '').replaceAll('"','""')}"`; }

const sessions = new Map();
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const t = auth.replace('Bearer ', '') || req.query.token;
  const user = sessions.get(t);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}
async function q(sql, params = []) { return pool.query(sql, params); }

async function columnExists(table, column) {
  const r = await q(`select 1 from information_schema.columns where table_name=$1 and column_name=$2`, [table, column]);
  return r.rowCount > 0;
}
async function addColumn(table, column, definition) {
  if (!(await columnExists(table, column))) await q(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

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
  await addColumn('employees', 'phone', 'TEXT');
  await addColumn('employees', 'email', 'TEXT');
  await addColumn('employees', 'department', "TEXT NOT NULL DEFAULT 'Operations'");
  await addColumn('employees', 'hire_date', 'DATE');
  await addColumn('time_off_requests', 'submitted_by', "TEXT NOT NULL DEFAULT 'ADMIN'");

  const admin = await q('SELECT id FROM users LIMIT 1');
  if (admin.rowCount === 0) {
    await q('INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4)', [
      process.env.ADMIN_EMAIL || 'admin@attendly.local', 'Admin', hash(process.env.ADMIN_PASSWORD || 'admin123!'), 'ADMIN'
    ]);
  }
  const employees = await q('SELECT id FROM employees LIMIT 1');
  if (employees.rowCount === 0) {
    const seed = [
      ['Alfredo Sanchez','MANAGER','1010'], ['Brenda Ortiz','OFFICE','2020'], ['Carlos Rivera','TECHNICIAN','3030'],
      ['Diana Morales','TECHNICIAN','4040'], ['Ethan Brooks','TECHNICIAN','5050'], ['Frances Lee','OFFICE','6060'],
      ['George Patel','EMPLOYEE','7070'], ['Hannah Kim','EMPLOYEE','8080'], ['Ivan Garcia','TECHNICIAN','9090'],
      ['Jasmine Smith','MANAGER','1111'], ['Kevin Brown','EMPLOYEE','2222']
    ];
    for (const [name, role, pin] of seed) {
      await q('INSERT INTO employees (name,role,pin_hash,pin_last4,vacation_hours,sick_hours,department) VALUES ($1,$2,$3,$4,$5,$6,$7)', [name, role, hash(pin), pin, 40, 24, role === 'OFFICE' ? 'Office' : 'Field']);
    }
  }
}

async function findEmployeeByPin(pin) {
  const r = await q("SELECT * FROM employees WHERE status='ACTIVE'");
  return r.rows.find(e => verify(String(pin), e.pin_hash));
}
async function currentStatus(employeeId) {
  const last = await q('SELECT type, occurred_at FROM punches WHERE employee_id=$1 ORDER BY occurred_at DESC LIMIT 1', [employeeId]);
  const clockedIn = last.rowCount && last.rows[0].type === 'CLOCK_IN';
  return { clockedIn, lastPunch: last.rows[0] || null };
}

app.get('/api/health', async (req,res)=> { try { await q('select 1'); res.json({ ok:true }); } catch(e) { res.status(500).json({ ok:false, error:e.message }); } });
app.post('/api/login', async (req,res)=> {
  const { email, password } = req.body;
  const r = await q('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
  if (!r.rowCount || !verify(password, r.rows[0].password_hash)) return res.status(401).json({ error:'Bad login' });
  const t = token(); sessions.set(t, { id:r.rows[0].id, email:r.rows[0].email, name:r.rows[0].name });
  res.json({ token:t, user:sessions.get(t) });
});

app.get('/api/dashboard', requireAdmin, async (req,res)=> {
  const [active,today,pending,total,inNow] = await Promise.all([
    q("SELECT count(*)::int c FROM employees WHERE status='ACTIVE'"),
    q("SELECT count(*)::int c FROM punches WHERE occurred_at::date=current_date"),
    q("SELECT count(*)::int c FROM time_off_requests WHERE status='PENDING'"),
    q('SELECT count(*)::int c FROM employees'),
    q(`WITH latest AS (SELECT DISTINCT ON (employee_id) employee_id,type FROM punches ORDER BY employee_id, occurred_at DESC) SELECT count(*)::int c FROM latest WHERE type='CLOCK_IN'`)
  ]);
  res.json({ activeEmployees:active.rows[0].c, todayPunches:today.rows[0].c, pendingRequests:pending.rows[0].c, totalEmployees:total.rows[0].c, clockedInNow:inNow.rows[0].c });
});

app.get('/api/employees', requireAdmin, async (req,res)=> {
  const r = await q(`SELECT e.id,e.name,e.role,e.pin_last4,e.status,e.pay_type,e.hourly_rate,e.vacation_hours,e.sick_hours,e.phone,e.email,e.department,e.hire_date,e.created_at,
    COALESCE(l.type,'CLOCK_OUT') last_type, l.occurred_at last_punch_at
    FROM employees e LEFT JOIN LATERAL (SELECT type, occurred_at FROM punches p WHERE p.employee_id=e.id ORDER BY occurred_at DESC LIMIT 1) l ON true ORDER BY e.name`);
  res.json(r.rows);
});
app.post('/api/employees', requireAdmin, async (req,res)=> {
  const { name, role='EMPLOYEE', pin, status='ACTIVE', pay_type='Hourly', hourly_rate=null, phone='', email='', department='Operations', hire_date=null } = req.body;
  if (!name || !pin) return res.status(400).json({error:'Name and PIN required'});
  const r = await q('INSERT INTO employees (name,role,pin_hash,pin_last4,status,pay_type,hourly_rate,phone,email,department,hire_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [name, role, hash(pin), String(pin).slice(-4), status, pay_type, hourly_rate || null, phone, email, department, hire_date || null]);
  res.json(r.rows[0]);
});
app.put('/api/employees/:id', requireAdmin, async (req,res)=> {
  const old = await q('SELECT * FROM employees WHERE id=$1',[req.params.id]); if(!old.rowCount) return res.status(404).json({error:'Not found'});
  const o = old.rows[0], b = req.body;
  const pinHash = b.pin ? hash(b.pin) : o.pin_hash; const pinLast = b.pin ? String(b.pin).slice(-4) : o.pin_last4;
  const r = await q(`UPDATE employees SET name=$1, role=$2, status=$3, pay_type=$4, hourly_rate=$5, vacation_hours=$6, sick_hours=$7, pin_hash=$8, pin_last4=$9, phone=$10, email=$11, department=$12, hire_date=$13, updated_at=now() WHERE id=$14 RETURNING *`,
    [b.name??o.name, b.role??o.role, b.status??o.status, b.pay_type??o.pay_type, b.hourly_rate??o.hourly_rate, b.vacation_hours??o.vacation_hours, b.sick_hours??o.sick_hours, pinHash, pinLast, b.phone??o.phone, b.email??o.email, b.department??o.department, b.hire_date??o.hire_date, req.params.id]);
  res.json(r.rows[0]);
});
app.delete('/api/employees/:id', requireAdmin, async (req,res)=> { await q('DELETE FROM employees WHERE id=$1',[req.params.id]); res.json({ok:true}); });

app.post('/api/kiosk/punch', async (req,res)=> {
  const { pin, note='' } = req.body;
  const emp = await findEmployeeByPin(pin);
  if (!emp) return res.status(401).json({ error:'Invalid PIN' });
  const status = await currentStatus(emp.id);
  const type = status.clockedIn ? 'CLOCK_OUT' : 'CLOCK_IN';
  const p = await q('INSERT INTO punches (employee_id,type,note) VALUES ($1,$2,$3) RETURNING *',[emp.id,type,note]);
  res.json({ employee: { id:emp.id, name:emp.name }, punch:p.rows[0] });
});
app.post('/api/kiosk/status', async (req,res)=> {
  const emp = await findEmployeeByPin(req.body.pin);
  if (!emp) return res.status(401).json({ error:'Invalid PIN' });
  const status = await currentStatus(emp.id);
  res.json({ employee: { id:emp.id, name:emp.name, vacation_hours:emp.vacation_hours, sick_hours:emp.sick_hours }, ...status });
});
app.post('/api/kiosk/timeoff', async (req,res)=> {
  const emp = await findEmployeeByPin(req.body.pin);
  if (!emp) return res.status(401).json({ error:'Invalid PIN' });
  const { start_date, end_date, hours, type='Vacation', reason='' } = req.body;
  if (!start_date || !end_date || !hours) return res.status(400).json({ error:'Dates and hours required' });
  const r = await q('INSERT INTO time_off_requests (employee_id,start_date,end_date,hours,type,reason,submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[emp.id,start_date,end_date,hours,type,reason,'EMPLOYEE']);
  res.json({ employee:{id:emp.id,name:emp.name}, request:r.rows[0] });
});

app.get('/api/punches', requireAdmin, async (req,res)=> {
  const r = await q(`SELECT p.*, e.name employee_name FROM punches p JOIN employees e ON e.id=p.employee_id ORDER BY p.occurred_at DESC LIMIT 1000`);
  res.json(r.rows);
});
app.post('/api/punches', requireAdmin, async (req,res)=> {
  const { employee_id, type, occurred_at, note='' } = req.body;
  if (!employee_id || !type) return res.status(400).json({error:'Employee and type required'});
  const r = await q('INSERT INTO punches (employee_id,type,occurred_at,note) VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4) RETURNING *',[employee_id,type,occurred_at || null,note]);
  res.json(r.rows[0]);
});
app.delete('/api/punches/:id', requireAdmin, async (req,res)=> { await q('DELETE FROM punches WHERE id=$1',[req.params.id]); res.json({ok:true}); });

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
  const before = await q('SELECT * FROM time_off_requests WHERE id=$1',[req.params.id]);
  if (!before.rowCount) return res.status(404).json({error:'Not found'});
  const old = before.rows[0];
  const r = await q('UPDATE time_off_requests SET status=$1, manager_note=$2, updated_at=now() WHERE id=$3 RETURNING *',[status,manager_note,req.params.id]);
  if (status === 'APPROVED' && old.status !== 'APPROVED') {
    const col = String(old.type).toLowerCase().includes('sick') ? 'sick_hours' : 'vacation_hours';
    await q(`UPDATE employees SET ${col}=GREATEST(0, ${col} - $1) WHERE id=$2`, [old.hours, old.employee_id]);
  }
  res.json(r.rows[0]);
});

app.get('/api/reports/summary', requireAdmin, async (req,res)=> {
  const days = Math.max(1, Math.min(90, Number(req.query.days || 14)));
  const daily = await q(`SELECT occurred_at::date day, count(*)::int punches FROM punches WHERE occurred_at > now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 1`, [days]);
  const byEmployee = await q(`SELECT e.name, count(p.id)::int punches FROM employees e LEFT JOIN punches p ON p.employee_id=e.id AND p.occurred_at > now() - ($1 || ' days')::interval GROUP BY e.id,e.name ORDER BY punches DESC,e.name`, [days]);
  const inNow = await q(`WITH latest AS (SELECT DISTINCT ON (p.employee_id) p.employee_id,p.type,p.occurred_at,e.name FROM punches p JOIN employees e ON e.id=p.employee_id ORDER BY p.employee_id,p.occurred_at DESC) SELECT * FROM latest WHERE type='CLOCK_IN' ORDER BY name`);
  res.json({ daily: daily.rows, byEmployee: byEmployee.rows, clockedIn: inNow.rows });
});
app.get('/api/export/punches.csv', requireAdmin, async (req,res)=> {
  const r = await q(`SELECT e.name,p.type,p.occurred_at,p.note FROM punches p JOIN employees e ON e.id=p.employee_id ORDER BY p.occurred_at DESC`);
  res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename="punches.csv"');
  res.write('Employee,Type,Time,Note\n');
  for (const row of r.rows) res.write([row.name,row.type,row.occurred_at,row.note||''].map(csvEscape).join(',')+'\n');
  res.end();
});
app.get('/api/export/employees.csv', requireAdmin, async (req,res)=> {
  const r = await q(`SELECT name,role,status,department,pin_last4,vacation_hours,sick_hours,email,phone FROM employees ORDER BY name`);
  res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename="employees.csv"');
  res.write('Name,Role,Status,Department,PIN Last4,Vacation,Sick,Email,Phone\n');
  for (const row of r.rows) res.write([row.name,row.role,row.status,row.department,row.pin_last4,row.vacation_hours,row.sick_hours,row.email,row.phone].map(csvEscape).join(',')+'\n');
  res.end();
});

app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(()=> app.listen(PORT, '0.0.0.0', () => console.log(`Attendly running on ${PORT}`))).catch(err => {
  console.error('Startup failed:', err);
  app.listen(PORT, '0.0.0.0', () => console.log(`Attendly running but database failed: ${err.message}`));
});
