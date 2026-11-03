import { mkdir,appendFile,readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Db } from './db.js';
export async function eraseUser(db:Db,userId:bigint) {
 await db.$transaction(async tx=>{
  const subs=await tx.subscription.findMany({where:{userId},select:{id:true}});
  await tx.deferredMatch.deleteMany({where:{subscriptionId:{in:subs.map(s=>s.id)}}});
  await tx.event.deleteMany({where:{userId}});
  await tx.task.deleteMany({where:{OR:[{payload:{path:['userId'],equals:String(userId)}},{payload:{path:['chatId'],equals:String(userId)}}]}});
  await tx.inboxUpdate.deleteMany({where:{chatId:userId}});
  await tx.user.deleteMany({where:{id:userId}});
 });
}
export async function deleteUser(db:Db,userId:bigint,journal:string) {
 await mkdir(dirname(journal),{recursive:true,mode:0o700});
 // The append precedes deletion: restoring any older backup must replay this independent journal.
 await appendFile(journal,JSON.stringify({userId:String(userId),at:new Date().toISOString()})+'\n',{mode:0o600,flush:true});
 await eraseUser(db,userId);
}
export async function replayDeletions(db:Db,journal:string,backupTime:Date) {
 const lines=(await readFile(journal,'utf8')).trim().split('\n').filter(Boolean);
 for(const line of lines){const r=JSON.parse(line) as {userId:string;at:string};if(new Date(r.at)>backupTime)await eraseUser(db,BigInt(r.userId));}
}
