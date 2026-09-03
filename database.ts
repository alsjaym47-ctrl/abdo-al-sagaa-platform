import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;
export function getPrisma(){
  if(!process.env.DATABASE_URL) return null;
  if(!prisma) prisma=new PrismaClient({log:process.env.NODE_ENV==='development'?['error','warn']:['error']});
  return prisma;
}
export async function closePrisma(){if(prisma){await prisma.$disconnect();prisma=null}}
