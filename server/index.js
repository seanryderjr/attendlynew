import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@attendly.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123!';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is missing. Add PostgreSQL in Railway and connect DATABASE_URL.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized:false } : undefined });

async function q(text, params=[]){ const r = await pool.query(text, params); return r; }
function token(user){ return jwt.sign({ id:user.id, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:'7d' }); }
function auth(req,res,next){
  const h=req.headers.authorization||''; const t=h.startsWith('Bearer ')?h.slice(7):'';
  try{ req.user=jwt.verify(t, JWT_SECRET); next(); }catch{ res.status(401).json({error:'Unauthorized'}); }
}

async function init(){
  await q(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'admin',created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS employees(id SERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT DEFAULT '',phone TEXT DEFAULT '',role TEXT NOT NULL DEFAULT 'Employee',department TEXT DEFAULT '',pin TEXT UNIQUE NOT NULL,status TEXT NOT NULL DEFAULT 'Active',pay_type TEXT DEFAULT 'Hourly',created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS punches(id SERIAL PRIMARY KEY,employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,clock_in TIMESTAMPTZ NOT NULL DEFAULT now(),clock_out TIMESTAMPTZ,status TEXT NOT NULL DEFAULT 'Clocked In',notes TEXT DEFAULT '')`);
  await q(`CREATE TABLE IF NOT EXISTS pto(id SERIAL PRIMARY KEY,employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,type TEXT NOT NULL,start_date DATE NOT NULL,end_date DATE NOT NULL,hours NUMERIC DEFAULT 8,reason TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'Pending',created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS balances(employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,vacation NUMERIC DEFAULT 80,sick NUMERIC DEFAULT 40,personal NUMERIC DEFAULT 16)`);
  await q(`CREATE TABLE IF NOT EXISTS audit(id SERIAL PRIMARY KEY,actor TEXT,action TEXT,details TEXT,created_at TIMESTAMPTZ DEFAULT now())`);
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await q(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(email) DO NOTHING`, [ADMIN_EMAIL,hash]);
  const c = await q(`SELECT count(*)::int n FROM employees`);
  if(c.rows[0].n===0){
    const seed=[['Sarah Johnson','Manager','Administration','1001'],['Mike Chen','Technician','Operations','1002'],['Jessica Williams','Office','Administration','1003'],['David Rodriguez','Technician','Operations','1004'],['Amanda Davis','Manager','Sales','1005'],['Chris Miller','Technician','Operations','1006'],['Lisa Garcia','Office','Administration','1007'],['Robert Wilson','Technician','Operations','1008'],['Emily Brown','Office','HR','1009'],['James Taylor','Technician','Operations','1010'],['Jennifer Martinez','Manager','Operations','1011']];
    for(const e of seed){ const r=await q(`INSERT INTO employees(name,role,department,pin,status,pay_type) VALUES($1,$2,$3,$4,'Active','Hourly') RETURNING id`, e); await q(`INSERT INTO balances(employee_id) VALUES($1) ON CONFLICT DO NOTHING`,[r.rows[0].id]); }
  }
}

app.get('/api/health',(_,res)=>res.json({ok:true}));
app.post('/api/login', async (req,res)=>{ const {email,password}=req.body; const r=await q(`SELECT * FROM users WHERE email=$1`,[email]); if(!r.rows[0] || !await bcrypt.compare(password||'', r.rows[0].password_hash)) return res.status(401).json({error:'Invalid login'}); res.json({token:token(r.rows[0]),user:{email:r.rows[0].email,role:r.rows[0].role}}); });
app.post('/api/reset-admin', async(req,res)=>{ const key=req.body.key; if(key!==process.env.JWT_SECRET) return res.status(403).json({error:'Forbidden'}); const hash=await bcrypt.hash(ADMIN_PASSWORD,10); await q(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash`,[ADMIN_EMAIL,hash]); res.json({ok:true,email:ADMIN_EMAIL,password:ADMIN_PASSWORD}); });

app.get('/api/dashboard', auth, async(_,res)=>{ const [e,p,pto]=await Promise.all([q(`SELECT count(*)::int n FROM employees WHERE status='Active'`),q(`SELECT count(*)::int n FROM punches WHERE clock_in::date=CURRENT_DATE`),q(`SELECT count(*)::int n FROM pto WHERE status='Pending'`)]); res.json({activeEmployees:e.rows[0].n,todayPunches:p.rows[0].n,pendingRequests:pto.rows[0].n}); });
app.get('/api/employees', auth, async(_,res)=>res.json((await q(`SELECT * FROM employees ORDER BY name`)).rows));
app.post('/api/employees', auth, async(req,res)=>{ const b=req.body; const r=await q(`INSERT INTO employees(name,email,phone,role,department,pin,status,pay_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[b.name,b.email||'',b.phone||'',b.role||'Employee',b.department||'',b.pin,b.status||'Active',b.pay_type||'Hourly']); await q(`INSERT INTO balances(employee_id) VALUES($1) ON CONFLICT DO NOTHING`,[r.rows[0].id]); res.json(r.rows[0]); });
app.put('/api/employees/:id', auth, async(req,res)=>{ const b=req.body; const r=await q(`UPDATE employees SET name=$1,email=$2,phone=$3,role=$4,department=$5,pin=$6,status=$7,pay_type=$8 WHERE id=$9 RETURNING *`,[b.name,b.email||'',b.phone||'',b.role,b.department||'',b.pin,b.status,b.pay_type||'Hourly',req.params.id]); res.json(r.rows[0]); });
app.delete('/api/employees/:id', auth, async(req,res)=>{ await q(`DELETE FROM employees WHERE id=$1`,[req.params.id]); res.json({ok:true}); });

app.post('/api/kiosk/punch', async(req,res)=>{ const r=await q(`SELECT * FROM employees WHERE pin=$1 AND status='Active'`,[req.body.pin]); const emp=r.rows[0]; if(!emp) return res.status(404).json({error:'PIN not found'}); const open=await q(`SELECT * FROM punches WHERE employee_id=$1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,[emp.id]); if(open.rows[0]){ const p=(await q(`UPDATE punches SET clock_out=now(),status='Completed' WHERE id=$1 RETURNING *`,[open.rows[0].id])).rows[0]; return res.json({message:`${emp.name} clocked out`,employee:emp,punch:p}); } const p=(await q(`INSERT INTO punches(employee_id) VALUES($1) RETURNING *`,[emp.id])).rows[0]; res.json({message:`${emp.name} clocked in`,employee:emp,punch:p}); });
app.get('/api/punches', auth, async(_,res)=>res.json((await q(`SELECT p.*,e.name employee,e.role FROM punches p JOIN employees e ON e.id=p.employee_id ORDER BY p.clock_in DESC LIMIT 300`)).rows));
app.post('/api/punches', auth, async(req,res)=>{ const b=req.body; const r=await q(`INSERT INTO punches(employee_id,clock_in,clock_out,status,notes) VALUES($1,$2,$3,$4,$5) RETURNING *`,[b.employee_id,b.clock_in||new Date(),b.clock_out||null,b.clock_out?'Completed':'Clocked In',b.notes||'Manual punch']); res.json(r.rows[0]); });
app.delete('/api/punches/:id', auth, async(req,res)=>{ await q(`DELETE FROM punches WHERE id=$1`,[req.params.id]); res.json({ok:true}); });

app.get('/api/pto', auth, async(_,res)=>res.json((await q(`SELECT p.*,e.name employee FROM pto p JOIN employees e ON e.id=p.employee_id ORDER BY p.created_at DESC`)).rows));
app.post('/api/kiosk/pto', async(req,res)=>{ const e=(await q(`SELECT * FROM employees WHERE pin=$1`,[req.body.pin])).rows[0]; if(!e) return res.status(404).json({error:'PIN not found'}); const b=req.body; const r=await q(`INSERT INTO pto(employee_id,type,start_date,end_date,hours,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[e.id,b.type,b.start_date,b.end_date,b.hours||8,b.reason||'']); res.json(r.rows[0]); });
app.put('/api/pto/:id', auth, async(req,res)=>{ const status=req.body.status; const r=await q(`UPDATE pto SET status=$1 WHERE id=$2 RETURNING *`,[status,req.params.id]); if(status==='Approved' && r.rows[0]){ const field=String(r.rows[0].type).toLowerCase().includes('sick')?'sick':String(r.rows[0].type).toLowerCase().includes('personal')?'personal':'vacation'; await q(`UPDATE balances SET ${field} = GREATEST(0, ${field} - $1) WHERE employee_id=$2`,[r.rows[0].hours,r.rows[0].employee_id]); } res.json(r.rows[0]); });
app.get('/api/balances', auth, async(_,res)=>res.json((await q(`SELECT b.*,e.name employee FROM balances b JOIN employees e ON e.id=b.employee_id ORDER BY e.name`)).rows));
app.get('/api/reports', auth, async(_,res)=>res.json((await q(`SELECT e.id,e.name,e.role,COUNT(p.id)::int punches,COALESCE(SUM(EXTRACT(EPOCH FROM (p.clock_out-p.clock_in))/3600),0)::numeric(10,2) hours FROM employees e LEFT JOIN punches p ON p.employee_id=e.id AND p.clock_out IS NOT NULL GROUP BY e.id ORDER BY e.name`)).rows));

const staticDir = path.join(__dirname, '../client/dist');
app.use(express.static(staticDir));
app.get('*', (req,res)=>res.sendFile(path.join(staticDir,'index.html')));

init().then(()=>app.listen(PORT,()=>console.log(`Attendly running on ${PORT}`))).catch(err=>{ console.error(err); process.exit(1); });
