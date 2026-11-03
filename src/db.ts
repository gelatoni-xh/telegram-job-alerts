import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import type { Config } from './config.js';
const pools=new WeakMap<PrismaClient,pg.Pool>();
export function createDb(config:Config) {
 const pool=new pg.Pool({connectionString:config.DATABASE_URL,max:config.DATABASE_POOL_MAX,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,options:'-c statement_timeout=20000 -c lock_timeout=5000'});
 const db=new PrismaClient({adapter:new PrismaPg(pool,{disposeExternalPool:true})});
 pools.set(db,pool);
 return db;
}
export type Db=ReturnType<typeof createDb>;
export type Tx=Prisma.TransactionClient;
export async function verifyDatabase(db:Db,expected:string) {
 const [row]=await db.$queryRaw<{name:string}[]>`SELECT current_database() AS name`;
 if(row?.name!==expected) throw new Error('Unexpected database identity');
}
export async function boundary(tx:Tx) {
 await tx.$executeRaw`INSERT INTO "DiscoveryCounter" (id,value) VALUES (1,0) ON CONFLICT DO NOTHING`;
 const [row]=await tx.$queryRaw<{value:bigint}[]>`SELECT value FROM "DiscoveryCounter" WHERE id=1 FOR UPDATE`;
 return row!.value;
}
export async function lockUser(tx:Tx,userId:bigint) {
 await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
}

// A session lock prevents two application instances from executing external side effects.
export async function acquireRuntimeLock(db:Db) {
 const client=await pools.get(db)!.connect();
 const result=await client.query('SELECT pg_try_advisory_lock(710924813) AS acquired');
 if(!result.rows[0]?.acquired){client.release();throw new Error('Another application instance is active');}
 client.on('error',()=>{console.error('Runtime database lock connection lost');process.exit(1);});
 return ()=>client.release();
}
