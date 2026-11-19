CREATE TABLE "DiscountSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "compareAtRule" TEXT NOT NULL DEFAULT 'any',
    "syncedRule" TEXT,
    "lastSyncAt" DATETIME,
    "lastSyncError" TEXT
);
