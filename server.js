import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@attendly.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123!';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
const q = (sql, params=[]) => pool.query(sql, params);
function requireAuth(req,res,next){
  try{ const token=(req.headers.authorization||'').replace('Bearer ',''); req.user=jwt.verify(token,JWT_SECRET); next(); }
  catch{ res.status(401).json({error:'Please log in again.'}); }
}
async function init(){
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing. Add PostgreSQL to Railway and connect DATABASE_URL.');
  await q(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT DEFAULT 'admin')`);
  await q(`CREATE TABLE IF NOT EXISTS employees(id SERIAL PRIMARY KEY,name TEXT NOT NULL,role TEXT DEFAULT 'Employee',department TEXT DEFAULT '',pin TEXT UNIQUE NOT NULL,status TEXT DEFAULT 'Active',pay_type TEXT DEFAULT 'Hourly',email TEXT DEFAULT '',phone TEXT DEFAULT '')`);
  await q(`CREATE TABLE IF NOT EXISTS punches(id SERIAL PRIMARY KEY,employee_id INT REFERENCES employees(id) ON DELETE CASCADE,clock_in TIMESTAMPTZ DEFAULT now(),clock_out TIMESTAMPTZ,status TEXT DEFAULT 'Clocked In',notes TEXT DEFAULT '')`);
  await q(`CREATE TABLE IF NOT EXISTS pto(id SERIAL PRIMARY KEY,employee_id INT REFERENCES employees(id) ON DELETE CASCADE,type TEXT NOT NULL,start_date DATE NOT NULL,end_date DATE NOT NULL,hours NUMERIC DEFAULT 8,reason TEXT DEFAULT '',status TEXT DEFAULT 'Pending',created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS balances(employee_id INT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,vacation NUMERIC DEFAULT 80,sick NUMERIC DEFAULT 40,personal NUMERIC DEFAULT 16)`);
  const hash=await bcrypt.hash(ADMIN_PASSWORD,10);
  await q(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash`,[ADMIN_EMAIL,hash]);
  const count=(await q('SELECT count(*)::int n FROM employees')).rows[0].n;
  if(count===0){
    const employees=[['John Smith','Manager','Operations','1001'],['Sarah Johnson','Technician','Field','1002'],['Mike Davis','Technician','Field','1003'],['Emily Brown','Office','Admin','1004'],['David Wilson','Technician','Field','1005'],['Lisa Garcia','Manager','Operations','1006'],['Robert Taylor','Technician','Field','1007'],['Jennifer Martinez','Office','Admin','1008'],['Christopher Anderson','Technician','Field','1009'],['Amanda Thomas','Office','Admin','1010'],['Brian Jackson','Technician','Field','1011']];
    for(const e of employees){ const r=await q(`INSERT INTO employees(name,role,department,pin) VALUES($1,$2,$3,$4) RETURNING id`,e); await q(`INSERT INTO balances(employee_id) VALUES($1)`,[r.rows[0].id]); }
  }
}
app.get('/api/health',(_,res)=>res.json({ok:true}));
app.get('/reset-admin',async(req,res)=>{ if(req.query.key!==JWT_SECRET) return res.status(403).send('Wrong key'); const hash=await bcrypt.hash(ADMIN_PASSWORD,10); await q(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash`,[ADMIN_EMAIL,hash]); res.send('Admin reset. Login: '+ADMIN_EMAIL+' / '+ADMIN_PASSWORD); });
app.post('/api/login',async(req,res)=>{ const {email,password}=req.body; const u=(await q('SELECT * FROM users WHERE email=$1',[email])).rows[0]; if(!u || !(await bcrypt.compare(password,u.password_hash))) return res.status(401).json({error:'Wrong email or password'}); res.json({token:jwt.sign({id:u.id,email:u.email,role:u.role},JWT_SECRET,{expiresIn:'7d'})}); });
app.get('/api/all',requireAuth,async(_,res)=>{ const [e,p,t,b,r]=await Promise.all([
  q('SELECT * FROM employees ORDER BY name'),
  q(`SELECT p.*,e.name employee,e.role FROM punches p JOIN employees e ON e.id=p.employee_id ORDER BY p.clock_in DESC LIMIT 300`),
  q(`SELECT p.*,e.name employee FROM pto p JOIN employees e ON e.id=p.employee_id ORDER BY p.created_at DESC`),
  q(`SELECT b.*,e.name employee FROM balances b JOIN employees e ON e.id=b.employee_id ORDER BY e.name`),
  q(`SELECT e.name,e.role,COUNT(p.id)::int punches,COALESCE(SUM(EXTRACT(EPOCH FROM(p.clock_out-p.clock_in))/3600),0)::numeric(10,2) hours FROM employees e LEFT JOIN punches p ON p.employee_id=e.id AND p.clock_out IS NOT NULL GROUP BY e.id ORDER BY e.name`)
]); res.json({employees:e.rows,punches:p.rows,pto:t.rows,balances:b.rows,reports:r.rows}); });
app.post('/api/employees',requireAuth,async(req,res)=>{ const {name,role,department,pin,status,pay_type,email,phone}=req.body; const r=await q(`INSERT INTO employees(name,role,department,pin,status,pay_type,email,phone) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[name,role,department,pin,status||'Active',pay_type||'Hourly',email||'',phone||'']); await q('INSERT INTO balances(employee_id) VALUES($1) ON CONFLICT DO NOTHING',[r.rows[0].id]); res.json(r.rows[0]); });
app.put('/api/employees/:id',requireAuth,async(req,res)=>{ const {name,role,department,pin,status,pay_type,email,phone}=req.body; const r=await q(`UPDATE employees SET name=$1,role=$2,department=$3,pin=$4,status=$5,pay_type=$6,email=$7,phone=$8 WHERE id=$9 RETURNING *`,[name,role,department,pin,status,pay_type,email||'',phone||'',req.params.id]); res.json(r.rows[0]); });
app.delete('/api/employees/:id',requireAuth,async(req,res)=>{ await q('DELETE FROM employees WHERE id=$1',[req.params.id]); res.json({ok:true}); });
app.post('/api/punches',requireAuth,async(req,res)=>{ const {employee_id,clock_in,clock_out,notes}=req.body; await q(`INSERT INTO punches(employee_id,clock_in,clock_out,status,notes) VALUES($1,$2,$3,$4,$5)`,[employee_id,clock_in||new Date(),clock_out||null,clock_out?'Completed':'Clocked In',notes||'Manual']); res.json({ok:true}); });
app.delete('/api/punches/:id',requireAuth,async(req,res)=>{ await q('DELETE FROM punches WHERE id=$1',[req.params.id]); res.json({ok:true}); });
app.put('/api/pto/:id',requireAuth,async(req,res)=>{ const {status}=req.body; const p=(await q('UPDATE pto SET status=$1 WHERE id=$2 RETURNING *',[status,req.params.id])).rows[0]; if(status==='Approved'&&p){ const col=p.type.toLowerCase(); if(['vacation','sick','personal'].includes(col)) await q(`UPDATE balances SET ${col}=GREATEST(0,${col}-$1) WHERE employee_id=$2`,[p.hours,p.employee_id]); } res.json({ok:true}); });
app.post('/api/kiosk/punch',async(req,res)=>{ const emp=(await q('SELECT * FROM employees WHERE pin=$1 AND status=$2',[req.body.pin,'Active'])).rows[0]; if(!emp) return res.status(404).json({error:'PIN not found'}); const open=(await q('SELECT * FROM punches WHERE employee_id=$1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1',[emp.id])).rows[0]; if(open){ await q(`UPDATE punches SET clock_out=now(),status='Completed' WHERE id=$1`,[open.id]); return res.json({message:`${emp.name} clocked out`}); } await q('INSERT INTO punches(employee_id) VALUES($1)',[emp.id]); res.json({message:`${emp.name} clocked in`}); });
app.post('/api/kiosk/pto',async(req,res)=>{ const emp=(await q('SELECT * FROM employees WHERE pin=$1',[req.body.pin])).rows[0]; if(!emp) return res.status(404).json({error:'PIN not found'}); await q(`INSERT INTO pto(employee_id,type,start_date,end_date,hours,reason) VALUES($1,$2,$3,$4,$5,$6)`,[emp.id,req.body.type,req.body.start_date,req.body.end_date,req.body.hours||8,req.body.reason||'']); res.json({ok:true}); });
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
init().then(()=>app.listen(PORT,()=>console.log('Attendly running on port '+PORT))).catch(e=>{console.error(e);process.exit(1)});
