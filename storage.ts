import 'dotenv/config';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type StorageProvider='s3'|'r2'|'local';
const provider=(process.env.STORAGE_PROVIDER||'local').toLowerCase() as StorageProvider;
const root=normalize(process.env.LOCAL_STORAGE_DIR||join(process.cwd(),'storage'));
const s3=provider==='local'?null:new S3Client({region:process.env.STORAGE_REGION||'auto',endpoint:process.env.STORAGE_ENDPOINT||undefined,forcePathStyle:process.env.STORAGE_FORCE_PATH_STYLE==='true',credentials:process.env.STORAGE_ACCESS_KEY_ID?{accessKeyId:process.env.STORAGE_ACCESS_KEY_ID,secretAccessKey:process.env.STORAGE_SECRET_ACCESS_KEY||''}:undefined});
export function storageProvider(){return provider==='s3'||provider==='r2'?provider:'local'}
export function isRemoteStorageConfigured(){return !!s3 && !!process.env.STORAGE_BUCKET && !!process.env.STORAGE_ACCESS_KEY_ID && !!process.env.STORAGE_SECRET_ACCESS_KEY}
export function assertProductionStorage(){if(process.env.NODE_ENV==='production'&&!isRemoteStorageConfigured()) throw new Error('Production storage is not configured')}
function safeKey(key:string){const clean=key.replace(/^[/\\]+/,''); if(clean.includes('..')) throw new Error('INVALID_STORAGE_KEY'); return clean}
export async function saveObject(key:string,body:Buffer,contentType:string,bucket=process.env.STORAGE_BUCKET){const k=safeKey(key);if(s3){if(!bucket) throw new Error('STORAGE_BUCKET_NOT_CONFIGURED');await s3.send(new PutObjectCommand({Bucket:bucket,Key:k,Body:body,ContentType:contentType,CacheControl:'private, no-store'}));return k}const path=join(root,k);await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,body);return k}
export async function signedObjectUrl(key:string,ttlSeconds=300,bucket=process.env.STORAGE_BUCKET){const k=safeKey(key);if(s3){if(!bucket) throw new Error('STORAGE_BUCKET_NOT_CONFIGURED');return getSignedUrl(s3,new GetObjectCommand({Bucket:bucket,Key:k,ResponseCacheControl:'private, no-store'}),{expiresIn:ttlSeconds});}return `/api/protected/object/${encodeURIComponent(k)}`}
export async function readObject(key:string,bucket=process.env.STORAGE_BUCKET){const k=safeKey(key);if(s3){if(!bucket) throw new Error('STORAGE_BUCKET_NOT_CONFIGURED');const r=await s3!.send(new GetObjectCommand({Bucket:bucket,Key:k}));if(!r.Body)throw new Error('OBJECT_NOT_FOUND');return Buffer.from(await r.Body.transformToByteArray())}return fs.readFile(join(root,k))}
export function localStream(key:string){const k=safeKey(key);return createReadStream(join(root,k))}
export async function objectExists(key:string){try{await readObject(key);return true}catch{return false}}
export { root as localStorageRoot };
