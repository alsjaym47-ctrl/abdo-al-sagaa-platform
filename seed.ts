import { PrismaClient, UserRole, AccountStatus, CodeStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main(){
  const email=(process.env.ADMIN_EMAIL||'admin@abdo.local').toLowerCase();
  const password=process.env.ADMIN_PASSWORD||'ChangeMe123!';
  const passwordHash=await bcrypt.hash(password,12);
  await prisma.user.upsert({where:{email},update:{passwordHash,role:UserRole.ADMIN,status:AccountStatus.ACTIVE},create:{email,name:'مدير المنصة',passwordHash,role:UserRole.ADMIN,status:AccountStatus.ACTIVE}});
  const existing=await prisma.accessCode.count();
  if(existing===0){
    const expiry=new Date(); expiry.setFullYear(expiry.getFullYear()+1);
    await prisma.accessCode.create({data:{code:'ASG-DEMO-001',grade:'الثالث الثانوي',status:CodeStatus.UNUSED,isUsed:false,startDate:new Date(),expiryDate:expiry,notes:'كود تجريبي للتطوير فقط'}});
  }
  console.log('Seed completed. Admin:',email);
}
main().catch(e=>{console.error(e);process.exit(1)}).finally(()=>prisma.$disconnect());
