import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import { fileURLToPath } from 'url';

const prisma = new PrismaClient();
const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 4000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(helmet({ contentSecurityPolicy:false }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(',') || true, credentials:true }));
app.use(express.json({ limit:'1mb' }));
app.use(morgan('dev'));

const sign = (user) => jwt.sign({ id:user.id, email:user.email, role:user.role, name:user.name }, JWT_SECRET, { expiresIn:'8h' });
const auth = (req,res,next)=>{ try { const token=(req.headers.authorization||'').replace('Bearer ',''); req.user=jwt.verify(token,JWT_SECRET); next(); } catch { res.status(401).json({error:'Unauthorized'}); } };
const audit = (action, entity, entityId, actorId, metadata={}) => prisma.auditLog.create({data:{action,entity,entityId,actorId,metadata}}).catch(()=>{});
const safeEmployee = e => ({...e, pinHash:undefined});

app.get('/api/health', (_,res)=>res.json({ok:true, service:'attendly-api'}));
app.post('/api/auth/login', async (req,res)=>{
 const body = z.object({email:z.string().email(), password:z.string().min(1)}).parse(req.body);
 const user = await prisma.user.findUnique({ where:{ email: body.email }});
 if(!user || !(await bcrypt.compare(body.password,user.passwordHash))) return res.status(401).json({error:'Invalid login'});
 res.json({ token: sign(user), user:{id:user.id,email:user.email,name:user.name,role:user.role} });
});

app.get('/api/dashboard', auth, async (_,res)=>{
 const start = new Date(); start.setHours(0,0,0,0);
 const [activeEmployees, totalEmployees, todaysPunches, pendingRequests] = await Promise.all([
  prisma.employee.count({where:{status:'ACTIVE'}}), prisma.employee.count(), prisma.punch.count({where:{occurredAt:{gte:start}}}), prisma.timeOffRequest.count({where:{status:'PENDING'}})
 ]);
 res.json({activeEmployees,totalEmployees,todaysPunches,pendingRequests});
});

app.get('/api/employees', auth, async (_,res)=> res.json((await prisma.employee.findMany({orderBy:{name:'asc'}})).map(safeEmployee)) );
app.post('/api/employees', auth, async (req,res)=>{
 const b=z.object({name:z.string().min(2),role:z.string(),pin:z.string().min(4).max(12),status:z.string().default('ACTIVE'),payType:z.string().default('Hourly'),vacationHours:z.coerce.number().default(0),sickHours:z.coerce.number().default(0)}).parse(req.body);
 const employee=await prisma.employee.create({data:{name:b.name,role:b.role,pinHash:await bcrypt.hash(b.pin,10),pinLast4:b.pin.slice(-4),status:b.status,payType:b.payType,vacationHours:b.vacationHours,sickHours:b.sickHours}});
 await audit('create','employee',employee.id,req.user.id,{name:b.name}); res.json(safeEmployee(employee));
});
app.put('/api/employees/:id', auth, async (req,res)=>{
 const b=z.object({name:z.string().min(2),role:z.string(),status:z.string(),payType:z.string(),vacationHours:z.coerce.number(),sickHours:z.coerce.number(),pin:z.string().optional()}).parse(req.body);
 const data={name:b.name,role:b.role,status:b.status,payType:b.payType,vacationHours:b.vacationHours,sickHours:b.sickHours};
 if(b.pin){ data.pinHash=await bcrypt.hash(b.pin,10); data.pinLast4=b.pin.slice(-4); }
 const employee=await prisma.employee.update({where:{id:req.params.id},data}); await audit('update','employee',employee.id,req.user.id); res.json(safeEmployee(employee));
});
app.delete('/api/employees/:id', auth, async (req,res)=>{ await prisma.employee.update({where:{id:req.params.id},data:{status:'INACTIVE'}}); await audit('deactivate','employee',req.params.id,req.user.id); res.json({ok:true}); });

app.post('/api/kiosk/punch', async (req,res)=>{
 const b=z.object({pin:z.string().min(4), note:z.string().optional()}).parse(req.body);
 const employees=await prisma.employee.findMany({where:{status:'ACTIVE'}});
 const employee = (await Promise.all(employees.map(async e => (await bcrypt.compare(b.pin,e.pinHash)) ? e : null))).find(Boolean);
 if(!employee) return res.status(401).json({error:'Invalid PIN'});
 const last = await prisma.punch.findFirst({where:{employeeId:employee.id},orderBy:{occurredAt:'desc'}});
 const type = last?.type === 'CLOCK_IN' ? 'CLOCK_OUT' : 'CLOCK_IN';
 const punch = await prisma.punch.create({data:{employeeId:employee.id,type,note:b.note}});
 await audit(type.toLowerCase(),'punch',punch.id,employee.id); res.json({employee:safeEmployee(employee),punch});
});
app.get('/api/punches', auth, async (req,res)=>{
 const punches = await prisma.punch.findMany({take:300,orderBy:{occurredAt:'desc'},include:{employee:true}});
 res.json(punches.map(p=>({...p,employee:safeEmployee(p.employee)})));
});
app.post('/api/punches', auth, async (req,res)=>{ const b=z.object({employeeId:z.string(),type:z.string(),occurredAt:z.string(),note:z.string().optional()}).parse(req.body); const punch=await prisma.punch.create({data:{...b,occurredAt:new Date(b.occurredAt)}}); res.json(punch); });

app.get('/api/time-off', auth, async (_,res)=>res.json(await prisma.timeOffRequest.findMany({orderBy:{createdAt:'desc'},include:{employee:true}})));
app.post('/api/time-off', auth, async (req,res)=>{ const b=z.object({employeeId:z.string(),startDate:z.string(),endDate:z.string(),hours:z.coerce.number(),type:z.string(),reason:z.string().optional()}).parse(req.body); const r=await prisma.timeOffRequest.create({data:{...b,startDate:new Date(b.startDate),endDate:new Date(b.endDate)}}); res.json(r); });
app.patch('/api/time-off/:id/status', auth, async (req,res)=>{ const b=z.object({status:z.enum(['PENDING','APPROVED','DENIED','CANCELLED']),managerNote:z.string().optional()}).parse(req.body); const r=await prisma.timeOffRequest.update({where:{id:req.params.id},data:b}); await audit('status','time_off',r.id,req.user.id,b); res.json(r); });

app.get('/api/reports/payroll', auth, async (req,res)=>{
 const from=req.query.from?new Date(req.query.from):new Date(Date.now()-14*864e5), to=req.query.to?new Date(req.query.to):new Date();
 const employees=await prisma.employee.findMany({include:{punches:{where:{occurredAt:{gte:from,lte:to}},orderBy:{occurredAt:'asc'}}}});
 const rows=employees.map(e=>{ let ms=0, open=null; for(const p of e.punches){ if(p.type==='CLOCK_IN') open=p.occurredAt; if(p.type==='CLOCK_OUT'&&open){ ms+=p.occurredAt-open; open=null; }} return {employeeId:e.id,name:e.name,role:e.role,hours:Number((ms/36e5).toFixed(2)),punches:e.punches.length}; });
 res.json({from,to,rows});
});
app.get('/api/reports/export.csv', auth, async (req,res)=>{ const r=await fetchReportRows(req.query.from,req.query.to); res.type('text/csv').send(['Employee,Role,Hours,Punches',...r.rows.map(x=>`"${x.name}",${x.role},${x.hours},${x.punches}`)].join('\n')); });
async function fetchReportRows(fromQ,toQ){ const from=fromQ?new Date(fromQ):new Date(Date.now()-14*864e5), to=toQ?new Date(toQ):new Date(); const employees=await prisma.employee.findMany({include:{punches:{where:{occurredAt:{gte:from,lte:to}},orderBy:{occurredAt:'asc'}}}}); return {rows:employees.map(e=>{let ms=0,open=null; for(const p of e.punches){if(p.type==='CLOCK_IN')open=p.occurredAt;if(p.type==='CLOCK_OUT'&&open){ms+=p.occurredAt-open;open=null}} return {name:e.name,role:e.role,hours:Number((ms/36e5).toFixed(2)),punches:e.punches.length}})}; }

if(process.env.NODE_ENV==='production'){ app.use(express.static(path.join(__dirname,'../dist'))); app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'../dist/index.html'))); }
app.use((err,_,res,next)=>{ console.error(err); res.status(400).json({error:err.message||'Request failed'}); });
app.listen(PORT,()=>console.log(`Attendly API running on :${PORT}`));
