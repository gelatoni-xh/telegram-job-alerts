import type { Db } from './db.js';
export async function cleanup(db:Db) {
 const ago=(days:number)=>new Date(Date.now()-days*86400_000);
 // Raw SQL sets JSON payload to SQL NULL, not Prisma's JSON null sentinel.
 await db.$executeRaw`UPDATE "InboxUpdate" SET payload=NULL WHERE "createdAt"<${ago(7)} AND status IN ('done','throttled')`;
 await db.inboxUpdate.deleteMany({where:{createdAt:{lt:ago(30)},status:{in:['done','throttled']}}});
 await db.task.deleteMany({where:{status:'done',updatedAt:{lt:ago(7)}}});
 await db.event.deleteMany({where:{createdAt:{lt:ago(90)}}});
 await db.digest.deleteMany({where:{createdAt:{lt:ago(90)},OR:[{delivery:{is:null}},{delivery:{status:{in:['sent','cancelled','superseded','unreachable']}}}]}});
 await db.user.updateMany({where:{updatedAt:{lt:ago(1)}},data:{interaction:{},interactionVersion:{increment:1}}});
}
export async function doctor(db:Db) {
 const latest=await db.syncRun.findFirst({where:{status:'complete'},orderBy:{finishedAt:'desc'},select:{finishedAt:true,jobs:true,pages:true}});
 const oldest=await db.task.findFirst({where:{status:'pending'},orderBy:{dueAt:'asc'},select:{dueAt:true,type:true}});
 const failed=await db.task.count({where:{status:'failed'}}),uncertain=await db.delivery.count({where:{status:{in:['uncertain','sending']}}});
 const connections=await db.$queryRaw<{count:bigint}[]>`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()`;
 return {latestSync:latest,oldestPending:oldest,failed,uncertain,connections:Number(connections[0]?.count??0),users:await db.user.count(),subscriptions:await db.subscription.count(),activeJobs:await db.job.count({where:{status:'active'}}),deferred:await db.deferredMatch.count()};
}
