import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@attendly.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123!';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized:false } : false });

app.use(cors()); app.use(express.json({limit:'2mb'})); app.use(express.static(path.join(__dirname,'public')));

async function q(sql, params=[]){ return pool.query(sql, params); }
async function col(table, column, type){ await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`); }
async function init(){
  await q(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE, created_at TIMESTAMPTZ DEFAULT now())`);
  await col('users','name',"TEXT NOT NULL DEFAULT 'Admin User'");
  await col('users','password','TEXT');
  await col('users','role',"TEXT NOT NULL DEFAULT 'admin'");
  await q(`CREATE TABLE IF NOT EXISTS employees (id SERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT DEFAULT 'Technician', department TEXT DEFAULT 'Field', pin TEXT UNIQUE NOT NULL, email TEXT DEFAULT '', phone TEXT DEFAULT '', status TEXT DEFAULT 'Active', hire_date DATE DEFAULT CURRENT_DATE, created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS punches (id SERIAL PRIMARY KEY, employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE, clock_in TIMESTAMPTZ NOT NULL DEFAULT now(), clock_out TIMESTAMPTZ, notes TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS time_off (id SERIAL PRIMARY KEY, employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE, start_date DATE NOT NULL, end_date DATE NOT NULL, type TEXT DEFAULT 'Vacation', hours NUMERIC DEFAULT 8, reason TEXT DEFAULT '', status TEXT DEFAULT 'Pending', created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS balances (employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE, vacation NUMERIC DEFAULT 40, sick NUMERIC DEFAULT 24, personal NUMERIC DEFAULT 8)`);
  await q(`CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, actor TEXT, action TEXT, details TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
  const hash = await bcrypt.hash(ADMIN_PASSWORD,10);
  await q(`INSERT INTO users(email,name,password,role) VALUES($1,'Admin User',$2,'admin') ON CONFLICT(email) DO UPDATE SET name=COALESCE(NULLIF(users.name,''),'Admin User'), password=COALESCE(users.password, EXCLUDED.password), role='admin'`,[ADMIN_EMAIL,hash]);
  const { rows } = await q(`SELECT COUNT(*)::int AS c FROM employees`);
  if(rows[0].c===0){
    const seed=[['Noah Smith','Manager','Office','1001'],['Olivia Johnson','Office','Office','1002'],['Liam Williams','Technician','Field','1003'],['Emma Brown','Technician','Field','1004'],['James Jones','Technician','Field','1005'],['Ava Garcia','Technician','Field','1006'],['William Miller','Manager','Field','1007'],['Sophia Davis','Office','Office','1008'],['Benjamin Rodriguez','Technician','Field','1009'],['Mia Martinez','Technician','Field','1010'],['Lucas Anderson','Technician','Field','1011']];
    for(const e of seed){ const r=await q(`INSERT INTO employees(name,role,department,pin) VALUES($1,$2,$3,$4) RETURNING id`,e); await q(`INSERT INTO balances(employee_id) VALUES($1) ON CONFLICT DO NOTHING`,[r.rows[0].id]); }
  }
  await q(`INSERT INTO balances(employee_id) SELECT id FROM employees ON CONFLICT DO NOTHING`);
}
function token(user){ return jwt.sign({id:user.id,email:user.email,role:user.role,name:user.name},JWT_SECRET,{expiresIn:'7d'}); }
function auth(req,res,next){ const h=req.headers.authorization||''; const t=h.startsWith('Bearer ')?h.slice(7):''; try{req.user=jwt.verify(t,JWT_SECRET); next();}catch{res.status(401).json({error:'Not authorized'});} }
async function audit(actor,action,details=''){ try{ await q(`INSERT INTO audit_log(actor,action,details) VALUES($1,$2,$3)`,[actor,action,details]); }catch{} }

app.get('/api/health',(req,res)=>res.json({ok:true}));
app.post('/api/login',async(req,res)=>{ const {email,password}=req.body; const r=await q(`SELECT * FROM users WHERE email=$1`,[email]); const u=r.rows[0]; if(!u||!u.password||!(await bcrypt.compare(password,u.password))) return res.status(401).json({error:'Invalid login'}); res.json({token:token(u),user:{email:u.email,name:u.name,role:u.role}}); });
app.get('/api/summary',auth,async(req,res)=>{ const emp=(await q(`SELECT COUNT(*)::int c FROM employees WHERE status='Active'`)).rows[0].c; const today=(await q(`SELECT COUNT(*)::int c FROM punches WHERE clock_in::date=CURRENT_DATE`)).rows[0].c; const pending=(await q(`SELECT COUNT(*)::int c FROM time_off WHERE status='Pending'`)).rows[0].c; const open=(await q(`SELECT COUNT(*)::int c FROM punches WHERE clock_out IS NULL`)).rows[0].c; res.json({activeEmployees:emp,todaysPunches:today,pendingRequests:pending,currentlyClockedIn:open}); });
app.get('/api/employees',auth,async(req,res)=>res.json((await q(`SELECT e.*, COALESCE(b.vacation,0) vacation, COALESCE(b.sick,0) sick, COALESCE(b.personal,0) personal FROM employees e LEFT JOIN balances b ON b.employee_id=e.id ORDER BY e.name`)).rows));
app.post('/api/employees',auth,async(req,res)=>{ const {name,role,department,pin,email='',phone='',status='Active'}=req.body; const r=await q(`INSERT INTO employees(name,role,department,pin,email,phone,status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[name,role,department,pin,email,phone,status]); await q(`INSERT INTO balances(employee_id) VALUES($1) ON CONFLICT DO NOTHING`,[r.rows[0].id]); await audit(req.user.email,'employee.created',name); res.json(r.rows[0]); });
app.put('/api/employees/:id',auth,async(req,res)=>{ const {name,role,department,pin,email='',phone='',status='Active'}=req.body; const r=await q(`UPDATE employees SET name=$1,role=$2,department=$3,pin=$4,email=$5,phone=$6,status=$7 WHERE id=$8 RETURNING *`,[name,role,department,pin,email,phone,status,req.params.id]); await audit(req.user.email,'employee.updated',name); res.json(r.rows[0]); });
app.delete('/api/employees/:id',auth,async(req,res)=>{ await q(`DELETE FROM employees WHERE id=$1`,[req.params.id]); await audit(req.user.email,'employee.deleted',req.params.id); res.json({ok:true}); });
app.get('/api/punches',auth,async(req,res)=>res.json((await q(`SELECT p.*, e.name employee_name, e.role FROM punches p JOIN employees e ON e.id=p.employee_id ORDER BY p.clock_in DESC LIMIT 300`)).rows));
app.post('/api/punches',auth,async(req,res)=>{ const {employee_id,clock_in,clock_out,notes=''}=req.body; const r=await q(`INSERT INTO punches(employee_id,clock_in,clock_out,notes) VALUES($1,COALESCE($2::timestamptz,now()),$3,$4) RETURNING *`,[employee_id,clock_in||null,clock_out||null,notes]); res.json(r.rows[0]); });
app.delete('/api/punches/:id',auth,async(req,res)=>{ await q(`DELETE FROM punches WHERE id=$1`,[req.params.id]); res.json({ok:true}); });
app.post('/api/kiosk/punch',async(req,res)=>{ const {pin}=req.body; const er=await q(`SELECT * FROM employees WHERE pin=$1 AND status='Active'`,[pin]); const e=er.rows[0]; if(!e) return res.status(404).json({error:'Invalid PIN'}); const open=(await q(`SELECT * FROM punches WHERE employee_id=$1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,[e.id])).rows[0]; if(open){ await q(`UPDATE punches SET clock_out=now() WHERE id=$1`,[open.id]); return res.json({mode:'out',message:`${e.name} clocked out`,employee:e}); } const p=(await q(`INSERT INTO punches(employee_id) VALUES($1) RETURNING *`,[e.id])).rows[0]; res.json({mode:'in',message:`${e.name} clocked in`,employee:e,punch:p}); });
app.post('/api/kiosk/timeoff',async(req,res)=>{ const {pin,start_date,end_date,type,hours,reason}=req.body; const er=await q(`SELECT id,name FROM employees WHERE pin=$1 AND status='Active'`,[pin]); if(!er.rows[0]) return res.status(404).json({error:'Invalid PIN'}); const r=await q(`INSERT INTO time_off(employee_id,start_date,end_date,type,hours,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[er.rows[0].id,start_date,end_date,type,hours||8,reason||'']); res.json(r.rows[0]); });
app.get('/api/timeoff',auth,async(req,res)=>res.json((await q(`SELECT t.*, e.name employee_name FROM time_off t JOIN employees e ON e.id=t.employee_id ORDER BY t.created_at DESC`)).rows));
app.put('/api/timeoff/:id/status',auth,async(req,res)=>{ const {status}=req.body; const r=await q(`UPDATE time_off SET status=$1 WHERE id=$2 RETURNING *`,[status,req.params.id]); if(status==='Approved'&&r.rows[0]){ const row=r.rows[0]; const col=row.type==='Sick'?'sick':row.type==='Personal'?'personal':'vacation'; await q(`UPDATE balances SET ${col}=GREATEST(0,${col}-$1) WHERE employee_id=$2`,[row.hours,row.employee_id]); } res.json(r.rows[0]); });
app.get('/api/balances',auth,async(req,res)=>res.json((await q(`SELECT e.id,e.name,e.role,b.vacation,b.sick,b.personal FROM employees e JOIN balances b ON b.employee_id=e.id ORDER BY e.name`)).rows));
app.put('/api/balances/:id',auth,async(req,res)=>{ const {vacation,sick,personal}=req.body; await q(`UPDATE balances SET vacation=$1,sick=$2,personal=$3 WHERE employee_id=$4`,[vacation,sick,personal,req.params.id]); res.json({ok:true}); });
app.get('/api/reports',auth,async(req,res)=>{ const rows=(await q(`SELECT e.name, COUNT(p.id)::int punches, ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(p.clock_out,now())-p.clock_in))/3600),0)::numeric,2) hours FROM employees e LEFT JOIN punches p ON p.employee_id=e.id GROUP BY e.id,e.name ORDER BY e.name`)).rows; res.json(rows); });
app.get('/api/audit',auth,async(req,res)=>res.json((await q(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100`)).rows));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

init().then(()=>app.listen(PORT,()=>console.log(`Attendly running on ${PORT}`))).catch(err=>{console.error(err); process.exit(1);});
