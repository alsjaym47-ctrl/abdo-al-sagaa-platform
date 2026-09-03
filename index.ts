import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { issueMediaGrant, verifyMediaGrant, revokeMediaGrant, grantIdentity } from './security.js';
import 'dotenv/config';
import { getPrisma, closePrisma } from './database.js';
import multer from 'multer';
import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib';
import { saveObject, readObject, signedObjectUrl, localStorageRoot } from './storage.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const app = express();
const PORT = Number(process.env.PORT || 4000);
const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-change-me';
const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';

type Role = 'admin' | 'student';
type Grade = string;
type Student = { id:string; userId:string; name:string; phone:string; grade:Grade; status:'active'|'suspended'; code:string; createdAt:string; lastLoginAt?:string; };
type Code = { code:string; grade:Grade; startDate:string; expiresAt:string; status:'unused'|'active'|'expired'|'suspended'; isUsed:boolean; studentId?:string; createdAt:string; notes?:string };
type Session = { id:string; userId:string; role:Role; refreshHash:string; createdAt:string; expiresAt:string; revokedAt?:string };
type Video={id:string;title:string;grade:string;unit?:string;sourceType:'upload'|'youtube'|'drive';sourceRef:string;durationSeconds?:number;isPublished:boolean;preventSeeking:boolean;createdAt:string};
type Document={id:string;title:string;grade:string;description?:string;storageKey:string;maxMb:number;createdAt:string};
type Question={id:string;type:'mcq'|'true_false'|'short_answer'|'fill_blank'|'matching'|'ordering'|'essay';prompt:string;options?:string[];answer?:unknown;points:number};
type Exam={id:string;title:string;description?:string;grade:string;durationMinutes:number;startsAt:string;endsAt:string;maxAttempts:number;randomizeQuestions:boolean;randomizeAnswers:boolean;showResultImmediately:boolean;allowReview:boolean;questions:Question[];createdAt:string};
type Ticket={id:string;studentId?:string;subject:string;message:string;status:'open'|'in_progress'|'closed';createdAt:string;updatedAt:string};
type Notification={id:string;userId?:string;title:string;body:string;read:boolean;createdAt:string};


app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

const students = new Map<string, Student>();
const codes = new Map<string, Code>();
const sessions = new Map<string, Session>();
const failedLogins = new Map<string, { count:number; lockedUntil?:number }>();
const audit: any[] = [];
const videos = new Map<string,Video>();
const documents = new Map<string,Document>();
const exams = new Map<string,Exam>();
const tickets = new Map<string,Ticket>();
const notifications: Notification[] = [];
const examAttempts = new Map<string,{id:string;examId:string;studentId:string;attemptNumber:number;startedAt:string;endsAt:string;submittedAt?:string;answers:Record<string,unknown>;score?:number;status:'in_progress'|'submitted'|'manual_review'}>();
const examViolations: {id:string;examId:string;studentId:string;type:string;occurredAt:string;details?:string}[] = [];
const studentPasswords = new Map<string,string>();
const admin = { id: 'admin-local', email: process.env.ADMIN_EMAIL || 'admin@abdo.local', passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'ChangeMe123!', 12) };
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:(Number(process.env.MAX_VIDEO_MB||2048))*1024*1024}});

async function auditLog(action:string, req:any, meta:Record<string,unknown> = {}) {
  const row={ id:randomUUID(), action, actorId:req.user?.sub, ip:req.ip, userAgent:req.get('user-agent'), time:new Date().toISOString(), ...meta };
  audit.push(row);
  const db=getPrisma(); if(db) db.auditLog.create({data:{id:row.id,actorId:row.actorId,action:row.action,ip:row.ip,userAgent:row.userAgent,metadata:meta as any}}).catch(()=>{});
}
function hashToken(token:string){ return bcrypt.hashSync(token, 10); }
async function matchesHash(token:string, hash:string){ return bcrypt.compare(token, hash); }
function signAccess(userId:string, role:Role, grade?:string){ return jwt.sign({ sub:userId, role, grade }, SECRET, { expiresIn:ACCESS_TTL }); }
function signRefresh(userId:string, sessionId:string){ return jwt.sign({ sub:userId, sid:sessionId }, REFRESH_SECRET, { expiresIn:REFRESH_TTL }); }
function auth(req:any,res:any,next:any){
  const h=req.headers.authorization;
  if(!h?.startsWith('Bearer ')) return res.status(401).json({error:'UNAUTHORIZED'});
  try { req.user=jwt.verify(h.slice(7),SECRET); next(); } catch { return res.status(401).json({error:'INVALID_TOKEN'}); }
}
function requireRole(...roles:Role[]){ return (req:any,res:any,next:any)=> roles.includes(req.user?.role) ? next() : res.status(403).json({error:'FORBIDDEN'}); }
function assertGrade(req:any, grade:string){ return req.user?.role==='admin' || req.user?.grade===grade; }
function studentForUser(userId:string){ return [...students.values()].find(x=>x.userId===userId); }
function requireStudentOwnership(req:any, studentId:string){ const s=students.get(studentId); return !!s && (req.user.role==='admin' || s.userId===req.user.sub); }
function addNotification(userId:string|undefined,title:string,body:string){ const n={id:randomUUID(),userId,title,body,read:false,createdAt:new Date().toISOString()}; notifications.unshift(n); void persistNotification(n); }
function makeCode(){ let code='ASG-'+randomBytes(3).toString('hex').toUpperCase(); while(codes.has(code)) code='ASG-'+randomBytes(3).toString('hex').toUpperCase(); return code; }
function shuffle<T>(items:T[]){const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function purgeSessions(){ const now=Date.now(); for(const [id,s] of sessions) if(s.revokedAt || new Date(s.expiresAt).getTime()<now) sessions.delete(id); }
setInterval(purgeSessions, 60_000).unref();

async function hydrateCoreFromDatabase(){
  const db=getPrisma(); if(!db) return;
  try{
    const dbCodes=await db.accessCode.findMany();
    for(const c of dbCodes) codes.set(c.code,{code:c.code,grade:c.grade,startDate:(c.startDate||new Date()).toISOString(),expiresAt:c.expiryDate.toISOString(),status:c.status.toLowerCase() as any,isUsed:c.isUsed,studentId:undefined,createdAt:c.createdAt.toISOString(),notes:c.notes||undefined});
    const dbStudents=await db.student.findMany({include:{user:true,accessCode:true}});
    for(const st of dbStudents){students.set(st.id,{id:st.id,userId:st.userId,name:st.user.name||'طالب',phone:st.user.phone||'',grade:st.grade,status:st.user.status===('SUSPENDED' as any)?'suspended':'active',code:st.accessCodeId||'',createdAt:st.createdAt.toISOString(),lastLoginAt:st.lastLoginAt?.toISOString()});studentPasswords.set(st.userId,st.user.passwordHash)}
    const dbVideos=await db.video.findMany(); for(const v of dbVideos) videos.set(v.id,{id:v.id,title:v.title,grade:v.grade,unit:v.unit||undefined,sourceType:v.sourceType as any,sourceRef:v.sourceRef||'',durationSeconds:v.durationSeconds||undefined,isPublished:v.isPublished,preventSeeking:v.preventSeeking,createdAt:v.createdAt.toISOString()});
    const dbDocs=await db.document.findMany(); for(const d of dbDocs) documents.set(d.id,{id:d.id,title:d.title,grade:d.grade,description:d.description||undefined,storageKey:d.storageKey,maxMb:Number(process.env.MAX_PDF_MB||100),createdAt:d.createdAt.toISOString()});
    const dbSessions=await db.session.findMany({where:{revokedAt:null},include:{user:true}}); for(const x of dbSessions) sessions.set(x.id,{id:x.id,userId:x.userId,role:x.user.role===('ADMIN' as any)?'admin':'student',refreshHash:x.refreshTokenHash,createdAt:x.createdAt.toISOString(),expiresAt:x.expiresAt.toISOString(),revokedAt:x.revokedAt?.toISOString()});
    const dbExams=await db.exam.findMany({include:{questions:true,attempts:true}}); for(const e of dbExams){exams.set(e.id,{id:e.id,title:e.title,description:e.description||undefined,grade:e.grade,durationMinutes:e.durationMinutes,startsAt:e.startsAt.toISOString(),endsAt:e.endsAt.toISOString(),maxAttempts:e.maxAttempts,randomizeQuestions:e.randomizeQuestions,randomizeAnswers:e.randomizeAnswers,showResultImmediately:e.showResultImmediately,allowReview:e.allowReview,questions:e.questions.map(q=>({id:q.id,type:q.type as any,prompt:q.prompt,options:(q.options as any)||undefined,answer:(q.answer as any),points:q.points})),createdAt:e.createdAt.toISOString()}); for(const a of e.attempts) examAttempts.set(a.id,{id:a.id,examId:a.examId,studentId:a.studentId,attemptNumber:a.attemptNumber,startedAt:a.startedAt.toISOString(),endsAt:new Date(a.startedAt.getTime()+e.durationMinutes*60000).toISOString(),submittedAt:a.submittedAt?.toISOString(),answers:(a.answers as any)||{},score:a.score||undefined,status:a.status as any})}
  }catch(err){console.error('Database hydration failed:',err)}
}
async function persistUser(id:string,data:{name?:string,email?:string,phone?:string,passwordHash:string,role:'ADMIN'|'STUDENT'}){const db=getPrisma();if(!db)return;await db.user.upsert({where:{id},update:{name:data.name,email:data.email,phone:data.phone,passwordHash:data.passwordHash,role:data.role as any},create:{id,name:data.name,email:data.email,phone:data.phone,passwordHash:data.passwordHash,role:data.role as any}})}
async function persistStudent(s:Student){const db=getPrisma();if(!db)return;await db.student.upsert({where:{id:s.id},update:{grade:s.grade,lastLoginAt:s.lastLoginAt?new Date(s.lastLoginAt):undefined,accessCodeId:s.code||null},create:{id:s.id,userId:s.userId,grade:s.grade,accessCodeId:s.code||null}})}
async function persistCode(c:Code){const db=getPrisma();if(!db)return;await db.accessCode.upsert({where:{code:c.code},update:{grade:c.grade,status:c.status.toUpperCase() as any,isUsed:c.isUsed,startDate:new Date(c.startDate),expiryDate:new Date(c.expiresAt),notes:c.notes},create:{code:c.code,grade:c.grade,status:c.status.toUpperCase() as any,isUsed:c.isUsed,startDate:new Date(c.startDate),expiryDate:new Date(c.expiresAt),notes:c.notes}})}
async function persistVideo(v:Video){const db=getPrisma();if(!db)return;await db.video.upsert({where:{id:v.id},update:{title:v.title,grade:v.grade,unit:v.unit,sourceType:v.sourceType,sourceRef:v.sourceRef,durationSeconds:v.durationSeconds,isPublished:v.isPublished,preventSeeking:v.preventSeeking},create:{id:v.id,title:v.title,grade:v.grade,unit:v.unit,sourceType:v.sourceType,sourceRef:v.sourceRef,durationSeconds:v.durationSeconds,isPublished:v.isPublished,preventSeeking:v.preventSeeking}})}
async function persistDocument(d:Document){const db=getPrisma();if(!db)return;await db.document.upsert({where:{id:d.id},update:{title:d.title,grade:d.grade,description:d.description,storageKey:d.storageKey},create:{id:d.id,title:d.title,grade:d.grade,description:d.description,storageKey:d.storageKey}})}
async function persistExam(e:Exam){const db=getPrisma();if(!db)return;await db.exam.upsert({where:{id:e.id},update:{title:e.title,description:e.description,grade:e.grade,durationMinutes:e.durationMinutes,startsAt:new Date(e.startsAt),endsAt:new Date(e.endsAt),maxAttempts:e.maxAttempts,randomizeQuestions:e.randomizeQuestions,randomizeAnswers:e.randomizeAnswers,showResultImmediately:e.showResultImmediately,allowReview:e.allowReview},create:{id:e.id,title:e.title,description:e.description,grade:e.grade,durationMinutes:e.durationMinutes,startsAt:new Date(e.startsAt),endsAt:new Date(e.endsAt),maxAttempts:e.maxAttempts,randomizeQuestions:e.randomizeQuestions,randomizeAnswers:e.randomizeAnswers,showResultImmediately:e.showResultImmediately,allowReview:e.allowReview},}); for(const q of e.questions) await db.examQuestion.upsert({where:{id:q.id},update:{type:q.type,prompt:q.prompt,options:q.options as any,answer:q.answer as any,points:q.points},create:{id:q.id,examId:e.id,type:q.type,prompt:q.prompt,options:q.options as any,answer:q.answer as any,points:q.points}})}
async function persistAttempt(a:any){const db=getPrisma();if(!db)return;await db.examAttempt.upsert({where:{id:a.id},update:{submittedAt:a.submittedAt?new Date(a.submittedAt):null,score:a.score, status:a.status,answers:a.answers as any},create:{id:a.id,examId:a.examId,studentId:a.studentId,attemptNumber:a.attemptNumber,startedAt:new Date(a.startedAt),submittedAt:a.submittedAt?new Date(a.submittedAt):null,score:a.score,status:a.status,answers:a.answers as any}})}
async function persistViolation(v:any){const db=getPrisma();if(db)await db.examViolation.create({data:{id:v.id,examId:v.examId,studentId:v.studentId,type:v.type,occurredAt:new Date(v.occurredAt),details:v.details||undefined}}).catch(()=>{})}
async function persistNotification(n:Notification){const db=getPrisma();if(db)await db.notification.create({data:{id:n.id,userId:n.userId,title:n.title,body:n.body,read:n.read,createdAt:new Date(n.createdAt)}}).catch(()=>{})}
async function persistSession(s:Session){const db=getPrisma();if(db)await db.session.upsert({where:{id:s.id},update:{refreshTokenHash:s.refreshHash,expiresAt:new Date(s.expiresAt),revokedAt:s.revokedAt?new Date(s.revokedAt):null},create:{id:s.id,userId:s.userId,refreshTokenHash:s.refreshHash,expiresAt:new Date(s.expiresAt),revokedAt:s.revokedAt?new Date(s.revokedAt):null}})}
async function revokeUserSessions(userId:string){for(const s of sessions.values())if(s.userId===userId&&!s.revokedAt){s.revokedAt=new Date().toISOString();}const db=getPrisma();if(db)await db.session.updateMany({where:{userId,revokedAt:null},data:{revokedAt:new Date()}})}

app.get('/api/health',(_,res)=>res.json({ok:true,service:'abdo-platform-api'}));
app.get('/api/student/dashboard',auth,requireRole('student'),(req,res)=>{
  const s=studentForUser(req.user.sub); if(!s)return res.status(404).json({error:'STUDENT_NOT_FOUND'});
  const now=Date.now();
  const code=codes.get(s.code);
  const availableExams=[...exams.values()].filter(e=>e.grade===s.grade && now>=new Date(e.startsAt).getTime() && now<=new Date(e.endsAt).getTime()).map(e=>({id:e.id,title:e.title,durationMinutes:e.durationMinutes,startsAt:e.startsAt,endsAt:e.endsAt,maxAttempts:e.maxAttempts}));
  const progressVideos=[...videos.values()].filter(v=>v.grade===s.grade && v.isPublished).map(v=>({id:v.id,title:v.title,unit:v.unit,durationSeconds:v.durationSeconds,preventSeeking:v.preventSeeking}));
  const docs=[...documents.values()].filter(d=>d.grade===s.grade).map(d=>({id:d.id,title:d.title,description:d.description}));
  const attempts=[...examAttempts.values()].filter(a=>a.studentId===s.id).map(a=>({id:a.id,examId:a.examId,attemptNumber:a.attemptNumber,status:a.status,score:a.score,startedAt:a.startedAt,submittedAt:a.submittedAt}));
  res.json({student:{id:s.id,name:s.name,grade:s.grade,code:s.code,status:s.status},subscription:{startDate:code?.startDate||null,expiryDate:code?.expiresAt||null,status:code?.status||'unknown'},videos:progressVideos,documents:docs,exams:availableExams,attempts,notifications:notifications.filter(n=>!n.userId||n.userId===s.userId).slice(0,20)});
});


app.post('/api/auth/login', async (req,res)=>{
  const p=z.object({email:z.string().email(),password:z.string().min(8)}).safeParse(req.body);
  if(!p.success) return res.status(400).json({error:'INVALID_INPUT'});
  const key=p.data.email.toLowerCase(); const state=failedLogins.get(key);
  if(state?.lockedUntil && state.lockedUntil>Date.now()) return res.status(423).json({error:'ACCOUNT_LOCKED', retryAfterSeconds:Math.ceil((state.lockedUntil-Date.now())/1000)});
  const db=getPrisma(); const dbAdmin=db?await db.user.findUnique({where:{email:key}}):null; const valid=dbAdmin?.role===('ADMIN' as any)?await bcrypt.compare(p.data.password,dbAdmin.passwordHash):(key===admin.email.toLowerCase() && await bcrypt.compare(p.data.password,admin.passwordHash)); const adminId=dbAdmin?.id||admin.id;
  if(!valid){ const count=(state?.count||0)+1; failedLogins.set(key,{count,lockedUntil:count>=5?Date.now()+15*60_000:undefined}); auditLog('LOGIN_FAILED',req,{email:key,count}); return res.status(count>=5?423:401).json({error:count>=5?'ACCOUNT_LOCKED':'INVALID_CREDENTIALS'}); }
  failedLogins.delete(key);
  await revokeUserSessions(adminId);
  const sessionId=randomUUID(); const refresh=signRefresh(admin.id,sessionId); const adminSession={id:sessionId,userId:adminId,role:'admin' as const,refreshHash:hashToken(refresh),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+7*86400000).toISOString()}; sessions.set(sessionId,adminSession); await persistSession(adminSession);
  const accessToken=signAccess(adminId,'admin'); auditLog('LOGIN_SUCCESS',req,{userId:adminId});
  res.json({accessToken,refreshToken:refresh,role:'admin', expiresIn:900});
});

app.post('/api/auth/student/register', async (req,res)=>{
  const p=z.object({code:z.string().min(5),name:z.string().min(2),phone:z.string().min(6),password:z.string().min(8)}).safeParse(req.body);
  if(!p.success) return res.status(400).json({error:'INVALID_INPUT'});
  const c=codes.get(p.data.code); const now=new Date();
  if(!c || c.isUsed || c.status!=='unused' || new Date(c.expiresAt)<=now || (c.startDate && new Date(c.startDate)>now)) return res.status(400).json({error:'CODE_INVALID_OR_EXPIRED'});
  const id=randomUUID(), userId=randomUUID();
  const s:Student={id,userId,name:p.data.name,phone:p.data.phone,grade:c.grade,status:'active',code:c.code,createdAt:now.toISOString()}; students.set(id,s);
  c.isUsed=true; c.status='active'; c.studentId=id; codes.set(c.code,c);
  // Password is hashed here to guarantee the scaffold never stores it in plaintext.
  const passwordHash=await bcrypt.hash(p.data.password,12); studentPasswords.set(userId,passwordHash); await persistUser(userId,{name:p.data.name,phone:p.data.phone,passwordHash,role:'STUDENT'}); await persistStudent(s); await persistCode(c);
  await revokeUserSessions(userId);
  const sessionId=randomUUID(); const refresh=signRefresh(userId,sessionId); const newSession={id:sessionId,userId,role:'student' as const,refreshHash:hashToken(refresh),createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+7*86400000).toISOString()}; sessions.set(sessionId,newSession); await persistSession(newSession);
  auditLog('STUDENT_REGISTERED',req,{studentId:id,grade:c.grade,code:c.code});
  res.status(201).json({studentId:id,grade:c.grade,accessToken:signAccess(userId,'student',c.grade),refreshToken:refresh});
});

app.post('/api/auth/student/login', async (req,res)=>{
  const p=z.object({phone:z.string().min(6),password:z.string().min(8)}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'});
  const s=[...students.values()].find(x=>x.phone===p.data.phone); if(!s||s.status!=='active')return res.status(401).json({error:'INVALID_CREDENTIALS'});
  const hash=studentPasswords.get(s.userId); if(!hash||!(await bcrypt.compare(p.data.password,hash)))return res.status(401).json({error:'INVALID_CREDENTIALS'});
  await revokeUserSessions(s.userId);
  const sessionId=randomUUID(),refresh=signRefresh(s.userId,sessionId); sessions.set(sessionId,{id:sessionId,userId:s.userId,role:'student',refreshHash:hashToken(refresh),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+7*86400000).toISOString()}); s.lastLoginAt=new Date().toISOString(); await persistStudent(s); auditLog('STUDENT_LOGIN_SUCCESS',req,{studentId:s.id});
  res.json({accessToken:signAccess(s.userId,'student',s.grade),refreshToken:refresh,role:'student',studentId:s.id,grade:s.grade,expiresIn:900});
});

app.post('/api/auth/refresh', async (req,res)=>{
  const p=z.object({refreshToken:z.string().min(20)}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'});
  try { const payload:any=jwt.verify(p.data.refreshToken,REFRESH_SECRET); const s=sessions.get(payload.sid); if(!s || s.revokedAt || s.userId!==payload.sub || !(await matchesHash(p.data.refreshToken,s.refreshHash))) return res.status(401).json({error:'INVALID_REFRESH'});
    s.revokedAt=new Date().toISOString(); await persistSession(s); const newId=randomUUID(); const refresh=signRefresh(s.userId,newId); const nextSession={id:newId,userId:s.userId,role:s.role,refreshHash:hashToken(refresh),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+7*86400000).toISOString()}; sessions.set(newId,nextSession); await persistSession(nextSession);
    const student=[...students.values()].find(x=>x.userId===s.userId); res.json({accessToken:signAccess(s.userId,s.role,student?.grade),refreshToken:refresh});
  } catch { res.status(401).json({error:'INVALID_REFRESH'}); }
});

app.post('/api/auth/logout',auth,async(req,res)=>{ await revokeUserSessions(req.user.sub); auditLog('LOGOUT',req); res.json({ok:true}); });

app.get('/api/students',auth,requireRole('admin'),(req,res)=>{auditLog('STUDENT_LIST',req);res.json([...students.values()])});
app.patch('/api/students/:id/status',auth,requireRole('admin'),async(req,res)=>{const s=students.get(req.params.id);if(!s)return res.status(404).json({error:'NOT_FOUND'});const p=z.object({status:z.enum(['active','suspended'])}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'INVALID_INPUT'});s.status=p.data.status; const db=getPrisma(); if(db) await db.user.update({where:{id:s.userId},data:{status:p.data.status==='active'?'ACTIVE':'SUSPENDED'}}); auditLog('STUDENT_STATUS_CHANGED',req,{studentId:s.id,status:s.status});res.json(s)});
app.post('/api/students',auth,requireRole('admin'),async(req,res)=>{
  const p=z.object({name:z.string().min(2),phone:z.string().min(6),grade:z.string()}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'});
  const id=randomUUID(); const userId=randomUUID(); const s:Student={id,userId,...p.data,status:'active',code:'',createdAt:new Date().toISOString()}; students.set(id,s); const passwordHash=await bcrypt.hash(randomBytes(18).toString('hex'),12); studentPasswords.set(userId,passwordHash); await persistUser(userId,{name:s.name,phone:s.phone,passwordHash,role:'STUDENT'}); await persistStudent(s); auditLog('STUDENT_CREATED',req,{studentId:id,grade:s.grade}); res.status(201).json(s);
});
app.get('/api/codes',auth,requireRole('admin'),(req,res)=>res.json([...codes.values()]));
app.post('/api/codes/batch',auth,requireRole('admin'),async(req,res)=>{
  const p=z.object({grade:z.string().min(1),count:z.number().int().min(1).max(500),startDate:z.string().datetime().optional(),expiresAt:z.string().datetime(),notes:z.string().max(500).optional()}).safeParse(req.body);
  if(!p.success)return res.status(400).json({error:'INVALID_INPUT'});
  const out:Code[]=[]; for(let i=0;i<p.data.count;i++){const code=makeCode();const item:Code={code,grade:p.data.grade,startDate:p.data.startDate||new Date().toISOString(),expiresAt:p.data.expiresAt,status:'unused',isUsed:false,createdAt:new Date().toISOString(),notes:p.data.notes};codes.set(code,item); await persistCode(item); out.push(item)}
  auditLog('CODE_BATCH_CREATED',req,{grade:p.data.grade,count:out.length}); res.status(201).json(out);
});
app.get('/api/codes/export.csv',auth,requireRole('admin'),(req,res)=>{const rows=[['code','grade','status','startDate','expiresAt','studentId'] as string[]].concat([...codes.values()].map(c=>[c.code,c.grade,c.status,c.startDate,c.expiresAt,c.studentId||'']));const csv=rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="access-codes.csv"');res.send('\ufeff'+csv);});
app.post('/api/codes',auth,requireRole('admin'),async(req,res)=>{
  const p=z.object({grade:z.string(),startDate:z.string().datetime().optional(),expiresAt:z.string().datetime(),notes:z.string().max(500).optional()}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'});
  const code=makeCode(); const item:Code={code,grade:p.data.grade,startDate:p.data.startDate||new Date().toISOString(),expiresAt:p.data.expiresAt,status:'unused',isUsed:false,createdAt:new Date().toISOString(),notes:p.data.notes}; codes.set(code,item); await persistCode(item); auditLog('CODE_CREATED',req,{code,grade:item.grade}); res.status(201).json(item);
});
app.post('/api/registration/validate-code',(req,res)=>{const p=z.object({code:z.string()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'INVALID_INPUT'});const c=codes.get(p.data.code);if(!c)return res.status(404).json({valid:false,reason:'NOT_FOUND'});const valid=!c.isUsed&&c.status==='unused'&&new Date(c.expiresAt)>new Date()&&new Date(c.startDate)<=new Date();res.json(valid?{valid:true,grade:c.grade}:{valid:false,reason:'EXPIRED_OR_USED'});});

app.get('/api/student/me',auth,requireRole('student'),(req,res)=>{const s=studentForUser(req.user.sub);if(!s)return res.status(404).json({error:'STUDENT_NOT_FOUND'});if(!assertGrade(req,s.grade))return res.status(403).json({error:'GRADE_FORBIDDEN'});res.json(s)});
app.post('/api/exams/violations',auth,(req,res)=>{const p=z.object({studentId:z.string(),type:z.string(),questionCount:z.number().int().nonnegative()}).safeParse(req.body);if(!p.success)return res.status(400).json({error:'INVALID_INPUT'});const s=students.get(p.data.studentId);if(req.user.role==='student'&&(!s||s.userId!==req.user.sub))return res.status(403).json({error:'OWNERSHIP_REQUIRED'});auditLog('EXAM_VIOLATION',req,p.data);res.status(201).json({ok:true});});
app.get('/api/audit',auth,requireRole('admin'),(req,res)=>res.json(audit.slice(-200).reverse()));



// Protected media/content APIs. Browser controls are deterrence layers; authorization remains server-side.
app.post('/api/content/upload/video',auth,requireRole('admin'),upload.single('file'),async(req,res)=>{
  const p=z.object({title:z.string().min(2),grade:z.string().min(1),unit:z.string().optional(),isPublished:z.coerce.boolean().optional(),preventSeeking:z.coerce.boolean().optional()}).safeParse(req.body);
  if(!p.success||!req.file)return res.status(400).json({error:'INVALID_UPLOAD'});
  const allowed=['video/mp4','video/quicktime','video/x-msvideo','video/x-matroska']; if(!allowed.includes(req.file.mimetype))return res.status(415).json({error:'UNSUPPORTED_VIDEO_TYPE'});
  const key=`videos/${new Date().getFullYear()}/${randomUUID()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`; await saveObject(key,req.file.buffer,req.file.mimetype);
  const v:Video={id:randomUUID(),title:p.data.title,grade:p.data.grade,unit:p.data.unit,sourceType:'upload',sourceRef:key,isPublished:p.data.isPublished??false,preventSeeking:p.data.preventSeeking??true,createdAt:new Date().toISOString()}; videos.set(v.id,v); await persistVideo(v); auditLog('VIDEO_UPLOADED',req,{videoId:v.id,grade:v.grade,size:req.file.size}); res.status(201).json({...v,sourceRef:undefined});
});
app.post('/api/content/upload/pdf',auth,requireRole('admin'),multer({storage:multer.memoryStorage(),limits:{fileSize:(Number(process.env.MAX_PDF_MB||100))*1024*1024}}).single('file'),async(req,res)=>{
  const p=z.object({title:z.string().min(2),grade:z.string().min(1),description:z.string().optional()}).safeParse(req.body); if(!p.success||!req.file)return res.status(400).json({error:'INVALID_UPLOAD'}); if(req.file.mimetype!=='application/pdf')return res.status(415).json({error:'PDF_ONLY'});
  const key=`documents/${new Date().getFullYear()}/${randomUUID()}.pdf`; await saveObject(key,req.file.buffer,'application/pdf'); const d:Document={id:randomUUID(),title:p.data.title,grade:p.data.grade,description:p.data.description,storageKey:key,maxMb:Number(process.env.MAX_PDF_MB||100),createdAt:new Date().toISOString()}; documents.set(d.id,d); await persistDocument(d); auditLog('DOCUMENT_UPLOADED',req,{documentId:d.id,grade:d.grade,size:req.file.size}); res.status(201).json({...d,storageKey:undefined});
});
app.get('/api/content/videos',auth,(req,res)=>{ const list=[...videos.values()].filter(v=>v.isPublished && assertGrade(req,v.grade)); auditLog('VIDEO_LIST',req,{count:list.length}); res.json(list.map(v=>({...v,sourceRef:undefined}))); });
app.post('/api/content/videos',auth,requireRole('admin'),async(req,res)=>{ const p=z.object({title:z.string().min(2),grade:z.string().min(1),unit:z.string().optional(),sourceType:z.enum(['upload','youtube','drive']),sourceRef:z.string().min(1),durationSeconds:z.number().int().nonnegative().optional(),isPublished:z.boolean().optional(),preventSeeking:z.boolean().optional()}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'}); const v:Video={id:randomUUID(),...p.data,isPublished:p.data.isPublished??false,preventSeeking:p.data.preventSeeking??true,createdAt:new Date().toISOString()}; videos.set(v.id,v); auditLog('VIDEO_CREATED',req,{videoId:v.id,grade:v.grade}); res.status(201).json(v); });
app.post('/api/content/videos/:id/grant',auth,requireRole('admin','student'),(req,res)=>{ const v=videos.get(req.params.id); if(!v||!v.isPublished)return res.status(404).json({error:'VIDEO_NOT_FOUND'}); if(!assertGrade(req,v.grade))return res.status(403).json({error:'GRADE_FORBIDDEN'}); const g=issueMediaGrant(req.user.sub,v.id,Number(process.env.MEDIA_URL_TTL_SECONDS||300)); auditLog('MEDIA_GRANT_ISSUED',req,{videoId:v.id}); res.json(g); });
app.get('/api/media/video/:id',auth,(req,res)=>{ const v=videos.get(req.params.id); const token=String(req.query.token||''); if(!v||!token||!verifyMediaGrant(token,req.user.sub,v.id)||!assertGrade(req,v.grade))return res.status(403).json({error:'MEDIA_ACCESS_DENIED'}); res.json({id:v.id,title:v.title,streamUrl:`/protected/video/${v.id}?token=${encodeURIComponent(token)}`,preventSeeking:v.preventSeeking,watermark:{studentName:studentForUser(req.user.sub)?.name||'Student',studentCode:studentForUser(req.user.sub)?.code||'—',rotateSeconds:8}}); });
app.get('/api/protected/video/:id',async(req,res)=>{const v=videos.get(req.params.id);const token=String(req.query.token||'');const identity=grantIdentity(token);if(!v||!identity||identity.resourceId!==v.id||!verifyMediaGrant(token,identity.userId,v.id)||!v.isPublished)return res.status(403).json({error:'MEDIA_ACCESS_DENIED'});if(!assertGrade({user:{role:'student',sub:identity.userId,grade:studentForUser(identity.userId)?.grade}},v.grade))return res.status(403).json({error:'GRADE_FORBIDDEN'});try{const data=await readObject(v.sourceRef);res.setHeader('Content-Type','video/mp4');res.setHeader('Cache-Control','private, no-store');res.setHeader('Accept-Ranges','bytes');res.send(data)}catch{return res.status(404).json({error:'MEDIA_NOT_FOUND'})}});
app.get('/api/protected/document/:id',async(req,res)=>{const d=documents.get(req.params.id);const token=String(req.query.token||'');const identity=grantIdentity(token);if(!d||!identity||identity.resourceId!==d.id||!verifyMediaGrant(token,identity.userId,d.id))return res.status(403).json({error:'DOCUMENT_ACCESS_DENIED'});const student=studentForUser(identity.userId);if(!student||student.grade!==d.grade)return res.status(403).json({error:'GRADE_FORBIDDEN'});try{const bytes=await readObject(d.storageKey);const pdf=await PDFDocument.load(bytes);const font=await pdf.embedFont(StandardFonts.Helvetica);for(const page of pdf.getPages()){const {width,height}=page.getSize();page.drawText(`${student.name} · ${student.code||'—'}`,{x:24,y:height/2,rotate:degrees(25),size:18,font,color:rgb(.55,.55,.55),opacity:.32});page.drawText('منصة عبده السجاعي التعليمية',{x:24,y:18,size:8,font,color:rgb(.45,.45,.45),opacity:.55});}const out=await pdf.save();res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','inline');res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('X-Content-Type-Options','nosniff');res.send(Buffer.from(out));}catch{return res.status(404).json({error:'DOCUMENT_NOT_FOUND'})}});
app.post('/api/media/revoke',auth,(req,res)=>{ const p=z.object({token:z.string().min(20)}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'}); revokeMediaGrant(p.data.token); auditLog('MEDIA_GRANT_REVOKED',req); res.json({ok:true}); });

app.get('/api/content/documents',auth,(req,res)=>{ const list=[...documents.values()].filter(d=>assertGrade(req,d.grade)); res.json(list.map(d=>({...d,storageKey:undefined}))); });
app.post('/api/content/documents',auth,requireRole('admin'),async(req,res)=>{ const p=z.object({title:z.string().min(2),grade:z.string(),description:z.string().optional(),storageKey:z.string().min(1),maxMb:z.number().positive().max(500).default(50)}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'}); const d:Document={id:randomUUID(),...p.data,createdAt:new Date().toISOString()}; documents.set(d.id,d); auditLog('DOCUMENT_CREATED',req,{documentId:d.id,grade:d.grade}); res.status(201).json(d); });
app.post('/api/content/documents/:id/grant',auth,(req,res)=>{ const d=documents.get(req.params.id); if(!d||!assertGrade(req,d.grade))return res.status(403).json({error:'DOCUMENT_ACCESS_DENIED'}); const g=issueMediaGrant(req.user.sub,d.id,300); auditLog('DOCUMENT_GRANT_ISSUED',req,{documentId:d.id}); res.json({grant:g,reader:{url:`/api/protected/document/${d.id}?token=${encodeURIComponent(g.token)}`,watermark:{studentName:studentForUser(req.user.sub)?.name||'Student',studentCode:studentForUser(req.user.sub)?.code||'—'},allowPrint:false,allowDownload:false,allowCopy:false}}); });

app.get('/api/exams',auth,(req,res)=>{ const list=[...exams.values()].filter(e=>assertGrade(req,e.grade)).map(e=>({...e,questions:req.user.role==='admin'?e.questions:e.questions.map(q=>({...q,answer:undefined}))})); res.json(list); });
app.post('/api/exams',auth,requireRole('admin'),async(req,res)=>{ const q=z.object({type:z.enum(['mcq','true_false','short_answer','fill_blank','matching','ordering','essay']),prompt:z.string().min(1),options:z.array(z.string()).optional(),answer:z.unknown().optional(),points:z.number().positive().default(1)}); const p=z.object({title:z.string().min(2),description:z.string().optional(),grade:z.string(),durationMinutes:z.number().int().positive(),startsAt:z.string().datetime(),endsAt:z.string().datetime(),maxAttempts:z.number().int().positive().default(1),randomizeQuestions:z.boolean().default(true),randomizeAnswers:z.boolean().default(true),showResultImmediately:z.boolean().default(false),allowReview:z.boolean().default(false),questions:z.array(q).default([])}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'}); const e:Exam={id:randomUUID(),...p.data,questions:p.data.questions.map(x=>({...x,id:randomUUID()})),createdAt:new Date().toISOString()}; exams.set(e.id,e); await persistExam(e); auditLog('EXAM_CREATED',req,{examId:e.id,grade:e.grade,questionCount:e.questions.length}); res.status(201).json(e); });
app.post('/api/exams/:id/violations',auth,async(req,res)=>{ const e=exams.get(req.params.id); const p=z.object({type:z.string().min(1),details:z.string().max(500).optional()}).safeParse(req.body); if(!e||!p.success)return res.status(400).json({error:'INVALID_INPUT'}); const s=studentForUser(req.user.sub); if(!s||s.grade!==e.grade)return res.status(403).json({error:'GRADE_FORBIDDEN'}); const violation={id:randomUUID(),examId:e.id,studentId:s.id,type:p.data.type,occurredAt:new Date().toISOString(),details:p.data.details}; examViolations.push(violation); await persistViolation(violation); auditLog('EXAM_VIOLATION',req,{...violation}); addNotification(s.userId,'تنبيه امتحان','تم تسجيل مخالفة أثناء الاختبار.'); res.status(201).json({ok:true}); });
app.post('/api/exams/:id/autosave',auth,async(req,res)=>{ const e=exams.get(req.params.id); const s=studentForUser(req.user.sub); if(!e||!s||s.grade!==e.grade)return res.status(403).json({error:'FORBIDDEN'}); const p=z.object({answers:z.record(z.unknown()),savedAt:z.string().datetime().optional()}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'}); const active=[...examAttempts.values()].find(a=>a.examId===e.id&&a.studentId===s.id&&a.status==='in_progress'); if(active){active.answers=p.data.answers; await persistAttempt(active)} auditLog('EXAM_AUTOSAVE',req,{examId:e.id,studentId:s.id,answerCount:Object.keys(p.data.answers).length}); res.json({ok:true,savedAt:new Date().toISOString()}); });


app.post('/api/exams/:id/start',auth,async(req,res)=>{
  const e=exams.get(req.params.id), s=studentForUser(req.user.sub); if(!e||!s||s.grade!==e.grade)return res.status(403).json({error:'FORBIDDEN'});
  const now=Date.now(); if(now<new Date(e.startsAt).getTime()||now>new Date(e.endsAt).getTime())return res.status(409).json({error:'EXAM_NOT_AVAILABLE'});
  const attempts=(audit.filter(x=>x.action==='EXAM_STARTED'&&x.examId===e.id&&x.studentId===s.id).length); if(attempts>=e.maxAttempts)return res.status(409).json({error:'MAX_ATTEMPTS_REACHED'});
  const attemptNumber=attempts+1; const attemptId=randomUUID(); const startedAt=new Date().toISOString(); const endsAt=new Date(Math.min(now+e.durationMinutes*60000,new Date(e.endsAt).getTime())).toISOString(); const attempt={id:attemptId,examId:e.id,studentId:s.id,attemptNumber,startedAt,endsAt,answers:{},status:'in_progress' as const}; examAttempts.set(attemptId,attempt); await persistAttempt(attempt); let questions=e.randomizeQuestions?shuffle(e.questions):[...e.questions]; questions=questions.map(q=>e.randomizeAnswers&&q.options?{...q,options:shuffle(q.options)}:q); auditLog('EXAM_STARTED',req,{examId:e.id,studentId:s.id,attemptId,attemptNumber}); res.status(201).json({attemptId,startedAt,endsAt,questionCount:questions.length,questions:questions.map(q=>({...q,answer:undefined}))});
});
app.post('/api/exams/:id/submit',auth,async(req,res)=>{
  const e=exams.get(req.params.id), s=studentForUser(req.user.sub); if(!e||!s||s.grade!==e.grade)return res.status(403).json({error:'FORBIDDEN'});
  const p=z.object({attemptId:z.string(),answers:z.record(z.unknown())}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'});
  const attempt=examAttempts.get(p.data.attemptId); if(!attempt||attempt.studentId!==s.id||attempt.examId!==e.id)return res.status(404).json({error:'ATTEMPT_NOT_FOUND'}); if(attempt.status!=='in_progress')return res.status(409).json({error:'ATTEMPT_ALREADY_SUBMITTED'}); if(Date.now()>new Date(attempt.endsAt).getTime())return res.status(409).json({error:'ATTEMPT_EXPIRED'});
  let score=0,total=0; for(const q of e.questions){ total+=q.points; const a=p.data.answers[q.id]; if(q.type==='essay')continue; if(JSON.stringify(a)===JSON.stringify(q.answer))score+=q.points; }
  const hasEssay=e.questions.some(q=>q.type==='essay'); const percent=total?Math.round(score/total*100):0; attempt.answers=p.data.answers; attempt.submittedAt=new Date().toISOString(); attempt.score=score; attempt.status=hasEssay?'manual_review':'submitted'; await persistAttempt(attempt); auditLog('EXAM_SUBMITTED',req,{examId:e.id,studentId:s.id,attemptId:p.data.attemptId,score,percent}); addNotification(s.userId,'نتيجة الاختبار',e.showResultImmediately&&!hasEssay?`تم تسجيل النتيجة: ${percent}%`:'تم تسليم الاختبار وسيتم إعلان النتيجة لاحقاً.'); res.json({ok:true,score,total,percent,manualReview:hasEssay,status:attempt.status});
});

app.get('/api/notifications',auth,(req,res)=>res.json(notifications.filter(n=>!n.userId||n.userId===req.user.sub)));
app.post('/api/notifications/:id/read',auth,(req,res)=>{ const n=notifications.find(x=>x.id===req.params.id && (!x.userId||x.userId===req.user.sub)); if(!n)return res.status(404).json({error:'NOT_FOUND'}); n.read=true; res.json({ok:true}); });
app.get('/api/support/tickets',auth,(req,res)=>res.json([...tickets.values()].filter(t=>req.user.role==='admin'||t.studentId===studentForUser(req.user.sub)?.id)));
app.post('/api/support/tickets',auth,(req,res)=>{ const p=z.object({subject:z.string().min(2),message:z.string().min(5)}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'}); const s=studentForUser(req.user.sub); const t:Ticket={id:randomUUID(),studentId:s?.id,subject:p.data.subject,message:p.data.message,status:'open',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; tickets.set(t.id,t); auditLog('TICKET_CREATED',req,{ticketId:t.id}); res.status(201).json(t); });
app.patch('/api/support/tickets/:id',auth,requireRole('admin'),(req,res)=>{ const t=tickets.get(req.params.id); if(!t)return res.status(404).json({error:'NOT_FOUND'}); const p=z.object({status:z.enum(['open','in_progress','closed'])}).safeParse(req.body); if(!p.success)return res.status(400).json({error:'INVALID_INPUT'}); t.status=p.data.status;t.updatedAt=new Date().toISOString();auditLog('TICKET_UPDATED',req,{ticketId:t.id,status:t.status});res.json(t); });

app.get('/api/admin/security/summary',auth,requireRole('admin'),(_,res)=>res.json({httpsRequired:true,hsts:true,rateLimit:true,auditLog:true,mediaSignedUrls:true,dynamicWatermark:true,drmProviderConfigured:Boolean(process.env.DRM_PROVIDER),storageProviderConfigured:Boolean(process.env.STORAGE_PROVIDER),redisConfigured:Boolean(process.env.REDIS_URL)}));

hydrateCoreFromDatabase().then(()=>app.listen(PORT,()=>console.log(`API listening on http://localhost:${PORT}`))).catch(err=>{console.error(err);process.exit(1)});
process.on('SIGTERM',()=>closePrisma().finally(()=>process.exit(0)));
process.on('SIGINT',()=>closePrisma().finally(()=>process.exit(0)));
