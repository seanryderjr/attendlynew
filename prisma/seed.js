import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
const employees = [
 ['Mauro Ayala','MANAGER','3256'],['David Hann','TECHNICIAN','6223'],['Alicia Johnson','OFFICE','1802'],['Chris Miller','TECHNICIAN','9198'],['Dana Stewart','TECHNICIAN','4470'],['Eli Carter','EMPLOYEE','2109'],['Frank Lopez','TECHNICIAN','7411'],['Grace Kim','OFFICE','5338'],['Henry Patel','TECHNICIAN','8820'],['Iris Brown','EMPLOYEE','3004'],['Jason Cole','MANAGER','6642']
];
async function main(){
 await prisma.user.upsert({where:{email:'admin@attendly.local'},update:{},create:{email:'admin@attendly.local',name:'Attendly Admin',passwordHash:await bcrypt.hash('admin123!',10),role:'ADMIN'}});
 for (const [name, role, pin] of employees){
  const existing = await prisma.employee.findFirst({where:{name}});
  if(!existing) await prisma.employee.create({data:{name,role,pinHash:await bcrypt.hash(pin,10),pinLast4:pin,status:'ACTIVE',payType:'Hourly',vacationHours:40,sickHours:24}});
 }
}
main().finally(()=>prisma.$disconnect());
