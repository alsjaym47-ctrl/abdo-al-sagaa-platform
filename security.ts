import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type MediaGrant = { id:string; userId:string; resourceId:string; expiresAt:number; nonce:string };
const grants = new Map<string, MediaGrant>();
const secret = process.env.MEDIA_SIGNING_SECRET || 'dev-media-secret-change-me';

export function issueMediaGrant(userId:string, resourceId:string, ttlSeconds=300){
  const id=randomUUID(); const expiresAt=Math.floor(Date.now()/1000)+ttlSeconds; const nonce=randomUUID();
  grants.set(id,{id,userId,resourceId,expiresAt,nonce});
  const payload=`${id}.${userId}.${resourceId}.${expiresAt}.${nonce}`;
  const sig=createHmac('sha256',secret).update(payload).digest('hex');
  return { token:`${payload}.${sig}`, expiresAt };
}
export function verifyMediaGrant(token:string,userId:string,resourceId:string){
  const parts=token.split('.'); if(parts.length!==6) return false;
  const [id,uid,rid,exp,nonce,sig]=parts; const grant=grants.get(id); if(!grant) return false;
  const payload=`${id}.${uid}.${rid}.${exp}.${nonce}`;
  const expected=createHmac('sha256',secret).update(payload).digest('hex');
  let same=false; try { same=timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(expected,'hex')); } catch {}
  return uid===userId && rid===resourceId && grant.userId===userId && grant.resourceId===resourceId && grant.expiresAt===Number(exp) && grant.nonce===nonce && Number(exp)>=Math.floor(Date.now()/1000) && same;
}
export function revokeMediaGrant(token:string){ const id=token.split('.')[0]; grants.delete(id); }

export function grantIdentity(token:string){ const p=token.split('.'); if(p.length!==6)return null; const g=grants.get(p[0]); if(!g || g.expiresAt<Math.floor(Date.now()/1000))return null; return {userId:g.userId,resourceId:g.resourceId}; }
