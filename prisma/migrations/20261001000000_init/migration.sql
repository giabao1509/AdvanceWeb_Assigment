CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "stock" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "products_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "products_price_cents_check" CHECK ("price_cents" > 0),
    CONSTRAINT "products_stock_check" CHECK ("stock" >= 0)
);

CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    CONSTRAINT "carts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "carts_status_check" CHECK ("status" IN ('open', 'checked_out'))
);

CREATE TABLE "cart_items" (
    "cart_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("cart_id", "product_id"),
    CONSTRAINT "cart_items_quantity_check" CHECK ("quantity" BETWEEN 1 AND 10)
);

CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

ALTER TABLE "cart_items"
ADD CONSTRAINT "cart_items_cart_id_fkey"
FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cart_items"
ADD CONSTRAINT "cart_items_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
