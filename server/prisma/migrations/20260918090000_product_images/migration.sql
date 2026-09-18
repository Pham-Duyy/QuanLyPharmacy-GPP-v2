-- Ảnh sản phẩm. Bảng mới hoàn toàn, không đụng dữ liệu sản phẩm hiện có.
CREATE TABLE "product_images" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "thumb_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_images_content_type_check" CHECK ("content_type" IN ('image/jpeg', 'image/png')),
    CONSTRAINT "product_images_size_check" CHECK ("size_bytes" > 0)
);

CREATE INDEX "product_images_product_id_sort_order_idx" ON "product_images"("product_id", "sort_order");

-- Mỗi sản phẩm có tối đa một ảnh chính.
CREATE UNIQUE INDEX "product_images_one_primary_idx" ON "product_images"("product_id") WHERE "is_primary";

ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_images" ADD CONSTRAINT "product_images_uploaded_by_fkey"
    FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
