-- CreateTable
CREATE TABLE "User" (
    "id" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "timezoneConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "sendTime" TEXT NOT NULL DEFAULT '09:00',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "unreachable" BOOLEAN NOT NULL DEFAULT false,
    "nextDue" TIMESTAMP(3),
    "interaction" JSONB NOT NULL DEFAULT '{}',
    "interactionVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "countries" TEXT[],
    "categories" TEXT[],
    "keyword" TEXT NOT NULL DEFAULT '',
    "filterHash" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "watermark" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryCounter" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "DiscoveryCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'jobicy',
    "externalId" TEXT NOT NULL,
    "discovery" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "geo" TEXT NOT NULL,
    "countries" TEXT[],
    "categories" TEXT[],
    "restrictions" JSONB NOT NULL DEFAULT '{}',
    "url" TEXT NOT NULL,
    "salary" TEXT,
    "publishedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "cursor" TEXT,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "jobs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxUpdate" (
    "id" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "InboxUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Digest" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "localDate" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Digest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestItem" (
    "id" TEXT NOT NULL,
    "digestId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "matches" JSONB NOT NULL,

    CONSTRAINT "DigestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "digestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "messageId" BIGINT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeferredMatch" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "jobId" TEXT NOT NULL,

    CONSTRAINT "DeferredMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" BIGINT,
    "dimensions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_chatId_key" ON "User"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_filterHash_key" ON "Subscription"("userId", "filterHash");

-- CreateIndex
CREATE UNIQUE INDEX "Job_discovery_key" ON "Job"("discovery");

-- CreateIndex
CREATE INDEX "Job_status_publishedAt_idx" ON "Job"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "Job_checkedAt_idx" ON "Job"("checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_source_externalId_key" ON "Job"("source", "externalId");

-- CreateIndex
CREATE INDEX "SyncRun_status_startedAt_idx" ON "SyncRun"("status", "startedAt");

-- CreateIndex
CREATE INDEX "InboxUpdate_chatId_status_id_idx" ON "InboxUpdate"("chatId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Task_dedupeKey_key" ON "Task"("dedupeKey");

-- CreateIndex
CREATE INDEX "Task_status_dueAt_idx" ON "Task"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Digest_userId_localDate_key" ON "Digest"("userId", "localDate");

-- CreateIndex
CREATE INDEX "DigestItem_digestId_position_idx" ON "DigestItem"("digestId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "DigestItem_digestId_jobId_key" ON "DigestItem"("digestId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_digestId_key" ON "Delivery"("digestId");

-- CreateIndex
CREATE UNIQUE INDEX "DeferredMatch_subscriptionId_revision_jobId_key" ON "DeferredMatch"("subscriptionId", "revision", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_key_key" ON "Event"("key");

-- CreateIndex
CREATE INDEX "Event_createdAt_idx" ON "Event"("createdAt");

-- CreateIndex
CREATE INDEX "Event_userId_idx" ON "Event"("userId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Digest" ADD CONSTRAINT "Digest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestItem" ADD CONSTRAINT "DigestItem_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "Digest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestItem" ADD CONSTRAINT "DigestItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "Digest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
