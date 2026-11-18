-- CreateTable
CREATE TABLE "SaleSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "collectionId" TEXT,
    "collectionTitle" TEXT,
    "sourceId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "reorder" BOOLEAN NOT NULL DEFAULT true,
    "needsReorder" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" DATETIME,
    "lastSyncMessage" TEXT
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "position" INTEGER NOT NULL,
    "sheetTab" TEXT,
    "unmatched" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SaleProduct" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "saleId" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "SaleProduct_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SaleSyncLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Sale_shop_idx" ON "Sale"("shop");

-- CreateIndex
CREATE INDEX "SaleProduct_saleId_idx" ON "SaleProduct"("saleId");

-- CreateIndex
CREATE INDEX "SaleSyncLog_shop_at_idx" ON "SaleSyncLog"("shop", "at");
