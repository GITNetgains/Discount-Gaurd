CREATE TABLE "DiscountCollectionMirror" (
    "shop" TEXT NOT NULL,
    "originalCollectionId" TEXT NOT NULL,
    "protectedCollectionId" TEXT NOT NULL,
    PRIMARY KEY ("shop", "originalCollectionId")
);
CREATE UNIQUE INDEX "DiscountCollectionMirror_shop_protectedCollectionId_key" ON "DiscountCollectionMirror"("shop", "protectedCollectionId");
