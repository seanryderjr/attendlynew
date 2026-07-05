import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json({limit:'2mb'}));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@attendly.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123!';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin User';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') || process.env.DATABASE_URL?.includes('render') || process.env.DATABASE_URL?.includes('neon') ? { rejectUnauthorized:false } : false });

async function q(text, params=[]){ return pool.query(text, params); }
async function columnExists(table,col){ const r=await q(`select 1 from information_schema.columns where table_name=$1 and column_name=$2`,[table,col]); return r.rowCount>0; }
async function init(){
 await q(`create table if not exists users(id serial primary key, email text unique not null, name text not null default 'Admin User', password text not null, role text not null default 'admin', created_at timestamptz default now())`);
 if(!(await columnExists('users','name'))) await q(`alter table users add column name text not null default 'Admin User'`);
 await q(`create table if not exists employees(id serial primary key, name text not null, pin text unique not null, role text not null, department text default '', email text default '', phone text default '', status text not null default 'active', hourly_rate numeric default 0, created_at timestamptz default now())`);
 await q(`create table if not exists punches(id serial primary key, employee_id int references employees(id) on delete cascade, clock_in timestamptz not null, clock_out timestamptz, note text default '', created_at timestamptz default now())`);
 await q(`create table if not exists time_off(id serial primary key, employee_id int references employees(id) on delete cascade, type text not null default 'Vacation', start_date date not null, end_date date not null, hours numeric default 8, reason text default '', status text not null default 'Pending', created_at timestamptz default now())`);
 await q(`create table if not exists balances(id serial primary key, employee_id int unique references employees(id) on delete cascade, vacation numeric default 40, sick numeric default 24, personal numeric default 8, updated_at timestamptz default now())`);
 await q(`create table if not exists settings(key text primary key, value text not null)`);
 const hash=await bcrypt.hash(ADMIN_PASSWORD,10);
 await q(`insert into users(email,name,password,role) values($1,$2,$3,'admin') on conflict(email) do update set name=coalesce(users.name, excluded.name)`,[ADMIN_EMAIL, ADMIN_NAME, hash]);
 const count = await q(`select count(*)::int c from employees`);
 if(count.rows[0].c===0){
  const employees=[['Kevin Martin','0403','Owner','Management','kevin@example.com',''],['Yordy Perez','1234','Manager','Field','',''],['Bayron Flores','2468','Manager','Field','',''],['Hector Hernandez','1111','Technician','Field','',''],['Karter Davis','2222','Technician','Field','',''],['Andy Tran','3333','Technician','Field','',''],['Jennifer Milan','4444','Office','Office','',''],['Francesca Morales','5555','Office','Office','',''],['Manuel Ramirez','6666','Technician','Field','',''],['Jose Amaya','7777','Technician','Field','',''],['Angel Corado','8888','Technician','Field','','']];
  for(const e of employees){const r=await q(`insert into employees(name,pin,role,department,email,phone,status,hourly_rate) values($1,$2,$3,$4,$5,$6,'active',0) returning id`,e); await q(`insert into balances(employee_id) values($1)`,[r.rows[0].id]);}
 }
}
function token(user){return jwt.sign({id:user.id,email:user.email,role:user.role,name:user.name},JWT_SECRET,{expiresIn:'7d'});}
function auth(req,res,next){const h=req.headers.authorization||''; const t=h.startsWith('Bearer ')?h.slice(7):null; if(!t)return res.status(401).json({error:'Unauthorized'}); try{req.user=jwt.verify(t,JWT_SECRET); next();}catch{return res.status(401).json({error:'Unauthorized'});} }
app.get('/api/health',(req,res)=>res.json({ok:true}));
app.post('/api/login',async(req,res)=>{const {email,password}=req.body; const r=await q(`select * from users where lower(email)=lower($1)`,[email||'']); const u=r.rows[0]; if(!u || !(await bcrypt.compare(password||'',u.password))) return res.status(401).json({error:'Invalid login'}); res.json({token:token(u),user:{id:u.id,email:u.email,name:u.name,role:u.role}});});
app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));
app.get('/api/dashboard',auth,async(req,res)=>{const [emp,active,pending,today,open]=await Promise.all([q(`select count(*)::int c from employees`),q(`select count(*)::int c from employees where status='active'`),q(`select count(*)::int c from time_off where status='Pending'`),q(`select count(*)::int c from punches where clock_in::date=current_date`),q(`select count(*)::int c from punches where clock_out is null`)]); res.json({totalEmployees:emp.rows[0].c,activeEmployees:active.rows[0].c,pendingRequests:pending.rows[0].c,todaysPunches:today.rows[0].c,currentlyClockedIn:open.rows[0].c});});
app.get('/api/employees',auth,async(req,res)=>{const r=await q(`select e.*, b.vacation,b.sick,b.personal from employees e left join balances b on b.employee_id=e.id order by e.status, e.name`); res.json(r.rows);});
app.post('/api/employees',auth,async(req,res)=>{const {name,pin,role,department,email,phone,status,hourly_rate}=req.body; const r=await q(`insert into employees(name,pin,role,department,email,phone,status,hourly_rate) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[name,pin,role||'Employee',department||'',email||'',phone||'',status||'active',hourly_rate||0]); await q(`insert into balances(employee_id) values($1) on conflict do nothing`,[r.rows[0].id]); res.json(r.rows[0]);});
app.put('/api/employees/:id',auth,async(req,res)=>{const {name,pin,role,department,email,phone,status,hourly_rate}=req.body; const r=await q(`update employees set name=$1,pin=$2,role=$3,department=$4,email=$5,phone=$6,status=$7,hourly_rate=$8 where id=$9 returning *`,[name,pin,role,department||'',email||'',phone||'',status||'active',hourly_rate||0,req.params.id]); res.json(r.rows[0]);});
app.delete('/api/employees/:id',auth,async(req,res)=>{await q(`delete from employees where id=$1`,[req.params.id]);res.json({ok:true});});
app.get('/api/punches',auth,async(req,res)=>{const r=await q(`select p.*, e.name employee_name,e.role employee_role from punches p join employees e on e.id=p.employee_id order by p.clock_in desc limit 500`); res.json(r.rows);});
app.post('/api/punches',auth,async(req,res)=>{const {employee_id,clock_in,clock_out,note}=req.body; const r=await q(`insert into punches(employee_id,clock_in,clock_out,note) values($1,$2,$3,$4) returning *`,[employee_id,clock_in||new Date(),clock_out||null,note||'']); res.json(r.rows[0]);});
app.delete('/api/punches/:id',auth,async(req,res)=>{await q(`delete from punches where id=$1`,[req.params.id]);res.json({ok:true});});
app.post('/api/kiosk/pin',async(req,res)=>{const {pin}=req.body; const er=await q(`select * from employees where pin=$1 and status='active'`,[pin]); const e=er.rows[0]; if(!e)return res.status(404).json({error:'Invalid PIN'}); const open=await q(`select * from punches where employee_id=$1 and clock_out is null order by clock_in desc limit 1`,[e.id]); res.json({employee:e,openPunch:open.rows[0]||null});});
app.post('/api/kiosk/punch',async(req,res)=>{const {pin,note}=req.body; const er=await q(`select * from employees where pin=$1 and status='active'`,[pin]); const e=er.rows[0]; if(!e)return res.status(404).json({error:'Invalid PIN'}); const open=await q(`select * from punches where employee_id=$1 and clock_out is null order by clock_in desc limit 1`,[e.id]); if(open.rows[0]){const r=await q(`update punches set clock_out=now(), note=coalesce(nullif($2,''),note) where id=$1 returning *`,[open.rows[0].id,note||'']); return res.json({action:'out',employee:e,punch:r.rows[0]});} const r=await q(`insert into punches(employee_id,clock_in,note) values($1,now(),$2) returning *`,[e.id,note||'']); res.json({action:'in',employee:e,punch:r.rows[0]});});
app.get('/api/time-off',auth,async(req,res)=>{const r=await q(`select t.*,e.name employee_name from time_off t join employees e on e.id=t.employee_id order by t.created_at desc`);res.json(r.rows);});
app.post('/api/time-off',async(req,res)=>{const {employee_id,pin,type,start_date,end_date,hours,reason}=req.body; let id=employee_id; if(pin){const er=await q(`select id from employees where pin=$1 and status='active'`,[pin]); if(!er.rows[0])return res.status(404).json({error:'Invalid PIN'}); id=er.rows[0].id;} const r=await q(`insert into time_off(employee_id,type,start_date,end_date,hours,reason,status) values($1,$2,$3,$4,$5,$6,'Pending') returning *`,[id,type||'Vacation',start_date,end_date,hours||8,reason||'']); res.json(r.rows[0]);});
app.put('/api/time-off/:id/status',auth,async(req,res)=>{const {status}=req.body; const r=await q(`update time_off set status=$1 where id=$2 returning *`,[status,req.params.id]); if(status==='Approved'&&r.rows[0]){const col=(r.rows[0].type||'Vacation').toLowerCase().includes('sick')?'sick':(r.rows[0].type||'Vacation').toLowerCase().includes('personal')?'personal':'vacation'; await q(`update balances set ${col}=greatest(0,${col}-$1), updated_at=now() where employee_id=$2`,[r.rows[0].hours,r.rows[0].employee_id]);} res.json(r.rows[0]);});
app.get('/api/balances',auth,async(req,res)=>{const r=await q(`select b.*, e.name employee_name,e.role from balances b join employees e on e.id=b.employee_id order by e.name`);res.json(r.rows);});
app.put('/api/balances/:employee_id',auth,async(req,res)=>{const {vacation,sick,personal}=req.body; const r=await q(`insert into balances(employee_id,vacation,sick,personal) values($1,$2,$3,$4) on conflict(employee_id) do update set vacation=$2,sick=$3,personal=$4,updated_at=now() returning *`,[req.params.employee_id,vacation||0,sick||0,personal||0]); res.json(r.rows[0]);});
app.get('/api/reports/summary',auth,async(req,res)=>{const r=await q(`select e.id,e.name,e.role,count(p.id)::int punches, round(coalesce(sum(extract(epoch from (coalesce(p.clock_out,now())-p.clock_in))/3600),0)::numeric,2) hours from employees e left join punches p on p.employee_id=e.id group by e.id order by e.name`); res.json(r.rows);});
app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
init().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`Attendly running on ${PORT}`))).catch(e=>{console.error(e); process.exit(1);});
