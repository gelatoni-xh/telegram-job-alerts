import { z } from 'zod';
const boolean = z.enum(['true','false']).default('false').transform(v=>v==='true');
export function readConfig(env:NodeJS.ProcessEnv=process.env) {
  return z.object({
    NODE_ENV:z.enum(['development','test','production']).default('development'),
    PORT:z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL:z.string().url(), EXPECTED_DATABASE:z.string().min(1),
    ADMIN_TELEGRAM_ID:z.string().regex(/^[1-9]\d{0,15}$/).refine(v=>Number.isSafeInteger(Number(v)),'Invalid Telegram user ID').optional(),
    BOT_TOKEN:z.string().default(''), WEBHOOK_URL:z.string().url().default('https://gelatoni.uk/bots/telegram-job-alerts/webhook'),
    WEBHOOK_SECRET:z.string().default(''), SOURCE_SYNC_ENABLED:boolean, SCHEDULER_ENABLED:boolean, DELIVERY_ENABLED:boolean,
    DATABASE_POOL_MAX:z.coerce.number().int().min(1).max(5).default(3),
    DELETION_JOURNAL_PATH:z.string().default('.secrets/deletions.jsonl'),
  }).parse(env);
}
export type Config=ReturnType<typeof readConfig>;
