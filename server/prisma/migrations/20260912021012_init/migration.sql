-- CreateTable
CREATE TABLE "stores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "gpp_certificate_number" TEXT,
    "license_number" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "practice_certificate_number" TEXT,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "last_failed_login_at" TIMESTAMPTZ(6),
    "default_store_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_code")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "store_id" UUID,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "user_agent" TEXT,
    "ip" INET,

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "store_id" UUID,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "request_id" TEXT,
    "ip" INET,
    "user_agent" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "store_id" UUID,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_ingredients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "atc_code" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "product_type" TEXT NOT NULL,
    "drug_class" TEXT,
    "registration_number" TEXT,
    "dosage_form" TEXT,
    "strength_text" TEXT,
    "packaging_text" TEXT,
    "manufacturer" TEXT,
    "country_of_origin" TEXT,
    "storage_condition" TEXT,
    "category_id" UUID NOT NULL,
    "min_stock_base_quantity" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_ingredients" (
    "product_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "strength_text" TEXT,

    CONSTRAINT "product_ingredients_pkey" PRIMARY KEY ("product_id","ingredient_id")
);

-- CreateTable
CREATE TABLE "product_units" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "conversion_to_base" INTEGER NOT NULL,
    "is_sellable" BOOLEAN NOT NULL DEFAULT true,
    "is_default_sale_unit" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_barcodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_unit_id" UUID NOT NULL,
    "barcode" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_unit_id" UUID NOT NULL,
    "store_id" UUID,
    "sale_price" BIGINT NOT NULL,
    "vat_rate_percent" DECIMAL(5,2) NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "tax_code" TEXT,
    "license_number" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_number" TEXT NOT NULL,
    "manufacture_date" DATE,
    "expiry_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(18,4),
    "shelf_location" TEXT,
    "note" TEXT,
    "source_type" TEXT,
    "source_id" UUID,
    "recall_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "store_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "base_quantity" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "source_line_id" UUID NOT NULL,
    "user_id" UUID,
    "note" TEXT,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PURCHASE',
    "supplier_id" UUID,
    "supplier_invoice_number" TEXT,
    "supplier_invoice_date" DATE,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "total_cost" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "goods_receipt_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "product_unit_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "base_quantity" INTEGER NOT NULL,
    "unit_cost" BIGINT NOT NULL,
    "line_cost" BIGINT NOT NULL,
    "batch_number" TEXT NOT NULL,
    "manufacture_date" DATE,
    "expiry_date" DATE NOT NULL,
    "batch_id" UUID,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "rejected_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustment_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stock_adjustment_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "batch_id" UUID NOT NULL,
    "product_unit_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "counted_quantity" INTEGER,
    "quantity" INTEGER,
    "system_base_quantity_at_count" INTEGER,
    "delta_base_quantity" INTEGER,

    CONSTRAINT "stock_adjustment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recalls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_number" TEXT NOT NULL,
    "issued_by" TEXT,
    "issued_at" DATE NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_by" UUID NOT NULL,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recall_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_number" TEXT NOT NULL,
    "batch_id" UUID,

    CONSTRAINT "recall_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "full_name" TEXT,
    "phone" TEXT,
    "birth_year" INTEGER,
    "gender" TEXT,
    "note" TEXT,
    "health_data_consent_at" TIMESTAMPTZ(6),
    "is_anonymized" BOOLEAN NOT NULL DEFAULT false,
    "anonymized_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_health_profiles" (
    "customer_id" UUID NOT NULL,
    "chronic_conditions" TEXT,
    "note" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "customer_health_profiles_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "customer_allergies" (
    "customer_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "note" TEXT,

    CONSTRAINT "customer_allergies_pkey" PRIMARY KEY ("customer_id","ingredient_id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "external_code" TEXT,
    "customer_id" UUID,
    "prescriber_name" TEXT,
    "facility_name" TEXT,
    "diagnosis_text" TEXT,
    "prescribed_date" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "rejected_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prescription_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID,
    "drug_name_text" TEXT NOT NULL,
    "product_unit_id" UUID,
    "quantity" INTEGER NOT NULL,
    "base_quantity" INTEGER,
    "dosage_instruction" TEXT,
    "dispensed_base_quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "prescription_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_images" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prescription_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "version_no" INTEGER NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescription_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "customer_id" UUID,
    "prescription_id" UUID,
    "seller_id" UUID NOT NULL,
    "pharmacist_id" UUID,
    "sold_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "discount_type" TEXT,
    "discount_value" DECIMAL(12,2),
    "discount_reason" TEXT,
    "discount_amount" BIGINT NOT NULL DEFAULT 0,
    "vat_amount" BIGINT NOT NULL DEFAULT 0,
    "total_amount" BIGINT NOT NULL DEFAULT 0,
    "payment_method" TEXT NOT NULL DEFAULT 'CASH',
    "amount_tendered" BIGINT,
    "change_amount" BIGINT,
    "return_status" TEXT NOT NULL DEFAULT 'NONE',
    "voided_by" UUID,
    "voided_at" TIMESTAMPTZ(6),
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "product_unit_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "unit_name" TEXT NOT NULL,
    "conversion_to_base" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "base_quantity" INTEGER NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "vat_rate_percent" DECIMAL(5,2) NOT NULL,
    "discount_amount" BIGINT NOT NULL DEFAULT 0,
    "line_total" BIGINT NOT NULL,
    "prescription_item_id" UUID,
    "batch_override_reason" TEXT,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_line_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "base_quantity" INTEGER NOT NULL,
    "returned_base_quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_safety_acks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "product_ids" UUID[],
    "reason" TEXT,
    "acknowledged_by" UUID NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_safety_acks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "returns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "invoice_id" UUID NOT NULL,
    "reason" TEXT,
    "disposition" TEXT NOT NULL,
    "refund_method" TEXT,
    "refund_amount" BIGINT NOT NULL DEFAULT 0,
    "business_date" DATE NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "return_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "invoice_line_id" UUID NOT NULL,
    "invoice_allocation_id" UUID NOT NULL,
    "product_unit_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "base_quantity" INTEGER NOT NULL,
    "refund_amount" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "min_temp_c" DECIMAL(4,1),
    "max_temp_c" DECIMAL(4,1),
    "max_humidity_percent" DECIMAL(5,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_logs" (
    "id" BIGSERIAL NOT NULL,
    "store_id" UUID NOT NULL,
    "storage_location_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "business_date" DATE NOT NULL,
    "temperature_c" DECIMAL(4,1) NOT NULL,
    "humidity_percent" DECIMAL(5,2),
    "out_of_range" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "recorded_by" UUID NOT NULL,
    "corrects_log_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "store_id" UUID,
    "user_id" UUID,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "model_version" TEXT,
    "input_redacted" JSONB,
    "output" JSONB,
    "accepted" BOOLEAN,
    "confirmed_by" UUID,
    "latency_ms" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "estimated_cost" DECIMAL(12,2),

    CONSTRAINT "ai_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stores_code_key" ON "stores"("code");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_default_store_id_idx" ON "users"("default_store_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE INDEX "user_roles_store_id_idx" ON "user_roles"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_sessions_token_hash_key" ON "refresh_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_sessions_user_id_idx" ON "refresh_sessions"("user_id");

-- CreateIndex
CREATE INDEX "refresh_sessions_family_id_idx" ON "refresh_sessions"("family_id");

-- CreateIndex
CREATE INDEX "refresh_sessions_expires_at_idx" ON "refresh_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_user_id_key" ON "idempotency_keys"("key", "user_id");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "settings_key_idx" ON "settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "categories_parent_id_name_key" ON "categories"("parent_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "active_ingredients_name_key" ON "active_ingredients"("name");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "products_product_type_drug_class_idx" ON "products"("product_type", "drug_class");

-- CreateIndex
CREATE INDEX "product_ingredients_ingredient_id_idx" ON "product_ingredients"("ingredient_id");

-- CreateIndex
CREATE INDEX "product_units_product_id_idx" ON "product_units"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_units_product_id_name_key" ON "product_units"("product_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_barcode_key" ON "product_barcodes"("barcode");

-- CreateIndex
CREATE INDEX "product_barcodes_product_unit_id_idx" ON "product_barcodes"("product_unit_id");

-- CreateIndex
CREATE INDEX "product_prices_product_unit_id_store_id_effective_from_idx" ON "product_prices"("product_unit_id", "store_id", "effective_from" DESC);

-- CreateIndex
CREATE INDEX "batches_product_id_expiry_date_idx" ON "batches"("product_id", "expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "batches_store_id_product_id_batch_number_key" ON "batches"("store_id", "product_id", "batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "batches_id_store_id_key" ON "batches"("id", "store_id");

-- CreateIndex
CREATE INDEX "stock_movements_batch_id_id_idx" ON "stock_movements"("batch_id", "id");

-- CreateIndex
CREATE INDEX "stock_movements_product_id_occurred_at_idx" ON "stock_movements"("product_id", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_movements_store_id_occurred_at_idx" ON "stock_movements"("store_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_source_type_source_line_id_batch_id_type_key" ON "stock_movements"("source_type", "source_line_id", "batch_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_code_key" ON "goods_receipts"("code");

-- CreateIndex
CREATE INDEX "goods_receipts_store_id_status_received_at_idx" ON "goods_receipts"("store_id", "status", "received_at" DESC);

-- CreateIndex
CREATE INDEX "goods_receipts_supplier_id_idx" ON "goods_receipts"("supplier_id");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_batch_id_idx" ON "goods_receipt_lines"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_lines_goods_receipt_id_line_no_key" ON "goods_receipt_lines"("goods_receipt_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustments_code_key" ON "stock_adjustments"("code");

-- CreateIndex
CREATE INDEX "stock_adjustments_store_id_status_idx" ON "stock_adjustments"("store_id", "status");

-- CreateIndex
CREATE INDEX "stock_adjustment_lines_batch_id_idx" ON "stock_adjustment_lines"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustment_lines_stock_adjustment_id_line_no_key" ON "stock_adjustment_lines"("stock_adjustment_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "recalls_document_number_key" ON "recalls"("document_number");

-- CreateIndex
CREATE INDEX "recall_items_batch_id_idx" ON "recall_items"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "recall_items_recall_id_product_id_batch_number_key" ON "recall_items"("recall_id", "product_id", "batch_number");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customer_allergies_ingredient_id_idx" ON "customer_allergies"("ingredient_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_code_key" ON "prescriptions"("code");

-- CreateIndex
CREATE INDEX "prescriptions_store_id_status_idx" ON "prescriptions"("store_id", "status");

-- CreateIndex
CREATE INDEX "prescriptions_customer_id_idx" ON "prescriptions"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_items_prescription_id_line_no_key" ON "prescription_items"("prescription_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_images_prescription_id_version_no_key" ON "prescription_images"("prescription_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_code_key" ON "invoices"("code");

-- CreateIndex
CREATE INDEX "invoices_store_id_business_date_status_idx" ON "invoices"("store_id", "business_date", "status");

-- CreateIndex
CREATE INDEX "invoices_customer_id_sold_at_idx" ON "invoices"("customer_id", "sold_at" DESC);

-- CreateIndex
CREATE INDEX "invoices_store_id_seller_id_sold_at_idx" ON "invoices"("store_id", "seller_id", "sold_at" DESC);

-- CreateIndex
CREATE INDEX "invoice_lines_product_id_idx" ON "invoice_lines"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_invoice_id_line_no_key" ON "invoice_lines"("invoice_id", "line_no");

-- CreateIndex
CREATE INDEX "invoice_allocations_batch_id_idx" ON "invoice_allocations"("batch_id");

-- CreateIndex
CREATE INDEX "invoice_allocations_invoice_line_id_idx" ON "invoice_allocations"("invoice_line_id");

-- CreateIndex
CREATE INDEX "invoice_safety_acks_invoice_id_idx" ON "invoice_safety_acks"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "returns_code_key" ON "returns"("code");

-- CreateIndex
CREATE INDEX "returns_store_id_business_date_idx" ON "returns"("store_id", "business_date");

-- CreateIndex
CREATE INDEX "returns_invoice_id_idx" ON "returns"("invoice_id");

-- CreateIndex
CREATE INDEX "return_lines_invoice_allocation_id_idx" ON "return_lines"("invoice_allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_lines_return_id_line_no_key" ON "return_lines"("return_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_store_id_code_key" ON "storage_locations"("store_id", "code");

-- CreateIndex
CREATE INDEX "storage_logs_storage_location_id_recorded_at_idx" ON "storage_logs"("storage_location_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "storage_logs_store_id_business_date_idx" ON "storage_logs"("store_id", "business_date");

-- CreateIndex
CREATE INDEX "ai_logs_occurred_at_idx" ON "ai_logs"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "ai_logs_user_id_idx" ON "ai_logs"("user_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_default_store_id_fkey" FOREIGN KEY ("default_store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "permissions"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_sessions" ADD CONSTRAINT "refresh_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "active_ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_recall_id_fkey" FOREIGN KEY ("recall_id") REFERENCES "recalls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_store_id_fkey" FOREIGN KEY ("batch_id", "store_id") REFERENCES "batches"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_stock_adjustment_id_fkey" FOREIGN KEY ("stock_adjustment_id") REFERENCES "stock_adjustments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_items" ADD CONSTRAINT "recall_items_recall_id_fkey" FOREIGN KEY ("recall_id") REFERENCES "recalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_items" ADD CONSTRAINT "recall_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_items" ADD CONSTRAINT "recall_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_health_profiles" ADD CONSTRAINT "customer_health_profiles_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_health_profiles" ADD CONSTRAINT "customer_health_profiles_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_allergies" ADD CONSTRAINT "customer_allergies_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_allergies" ADD CONSTRAINT "customer_allergies_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "active_ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_images" ADD CONSTRAINT "prescription_images_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_images" ADD CONSTRAINT "prescription_images_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pharmacist_id_fkey" FOREIGN KEY ("pharmacist_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_prescription_item_id_fkey" FOREIGN KEY ("prescription_item_id") REFERENCES "prescription_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_allocations" ADD CONSTRAINT "invoice_allocations_invoice_line_id_fkey" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_allocations" ADD CONSTRAINT "invoice_allocations_batch_id_store_id_fkey" FOREIGN KEY ("batch_id", "store_id") REFERENCES "batches"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_allocations" ADD CONSTRAINT "invoice_allocations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_safety_acks" ADD CONSTRAINT "invoice_safety_acks_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_safety_acks" ADD CONSTRAINT "invoice_safety_acks_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_invoice_line_id_fkey" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_invoice_allocation_id_fkey" FOREIGN KEY ("invoice_allocation_id") REFERENCES "invoice_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "product_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_logs" ADD CONSTRAINT "storage_logs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_logs" ADD CONSTRAINT "storage_logs_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_logs" ADD CONSTRAINT "storage_logs_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_logs" ADD CONSTRAINT "storage_logs_corrects_log_id_fkey" FOREIGN KEY ("corrects_log_id") REFERENCES "storage_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_logs" ADD CONSTRAINT "ai_logs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_logs" ADD CONSTRAINT "ai_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- PHẦN VIẾT TAY (docs/erd.md §9 và §12 bước 9)
-- Những ràng buộc dưới đây Prisma không mô tả được trong schema.prisma,
-- nhưng chính chúng là lớp bảo vệ dữ liệu cuối cùng khi mã ứng dụng có lỗi.
-- ===========================================================================

-- 1. Extension và hàm bọc unaccent để tạo được chỉ mục tìm kiếm không dấu
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION f_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
$$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- 2. Ràng buộc nhóm danh mục
ALTER TABLE "products"
  ADD CONSTRAINT "products_product_type_check"
    CHECK ("product_type" IN ('DRUG','SUPPLEMENT','MEDICAL_DEVICE','COSMETIC','OTHER')),
  ADD CONSTRAINT "products_drug_class_check"
    CHECK ("drug_class" IS NULL OR "drug_class" IN ('OTC','RX','CONTROLLED')),
  ADD CONSTRAINT "products_drug_class_required"
    CHECK (("product_type" = 'DRUG' AND "drug_class" IS NOT NULL)
        OR ("product_type" <> 'DRUG' AND "drug_class" IS NULL)),
  ADD CONSTRAINT "products_min_stock_non_negative"
    CHECK ("min_stock_base_quantity" >= 0);

ALTER TABLE "product_units"
  ADD CONSTRAINT "product_units_conversion_positive" CHECK ("conversion_to_base" >= 1);

ALTER TABLE "product_prices"
  ADD CONSTRAINT "product_prices_sale_price_non_negative" CHECK ("sale_price" >= 0),
  ADD CONSTRAINT "product_prices_vat_range" CHECK ("vat_rate_percent" BETWEEN 0 AND 100);

-- 3. Ràng buộc nhóm kho
ALTER TABLE "batches"
  ADD CONSTRAINT "batches_status_check"
    CHECK ("status" IN ('AVAILABLE','QUARANTINED','RECALLED')),
  ADD CONSTRAINT "batches_qty_non_negative" CHECK ("quantity_on_hand" >= 0),
  ADD CONSTRAINT "batches_mfg_before_exp"
    CHECK ("manufacture_date" IS NULL OR "manufacture_date" <= "expiry_date");

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_type_check"
    CHECK ("type" IN ('RECEIPT','OPENING_BALANCE','SALE','SALE_VOID','CUSTOMER_RETURN','ADJUSTMENT','DISPOSAL')),
  ADD CONSTRAINT "stock_movements_quantity_not_zero" CHECK ("base_quantity" <> 0),
  ADD CONSTRAINT "stock_movements_balance_non_negative" CHECK ("balance_after" >= 0);

ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_type_check" CHECK ("type" IN ('PURCHASE','OPENING_BALANCE')),
  ADD CONSTRAINT "goods_receipts_status_check"
    CHECK ("status" IN ('DRAFT','CONFIRMED','CANCELLED')),
  ADD CONSTRAINT "goods_receipts_supplier_required"
    CHECK (("type" = 'PURCHASE' AND "supplier_id" IS NOT NULL)
        OR ("type" = 'OPENING_BALANCE' AND "supplier_id" IS NULL));

ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "goods_receipt_lines_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "goods_receipt_lines_base_quantity_positive" CHECK ("base_quantity" > 0),
  ADD CONSTRAINT "goods_receipt_lines_cost_non_negative" CHECK ("unit_cost" >= 0 AND "line_cost" >= 0);

-- 4. Điều chỉnh tồn: người duyệt khác người lập, và hình dạng dòng theo lý do
ALTER TABLE "stock_adjustments"
  ADD CONSTRAINT "stock_adjustments_status_check"
    CHECK ("status" IN ('DRAFT','APPROVED','REJECTED','CANCELLED')),
  ADD CONSTRAINT "stock_adjustments_maker_checker"
    CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by");

ALTER TABLE "stock_adjustment_lines"
  ADD CONSTRAINT "stock_adjustment_lines_reason_check"
    CHECK ("reason_code" IN ('COUNT_DIFFERENCE','DAMAGED','EXPIRED_DISPOSAL','RECALL_DISPOSAL','OTHER')),
  ADD CONSTRAINT "stock_adjustment_lines_shape"
    CHECK (
      ("reason_code" = 'COUNT_DIFFERENCE'
         AND "counted_quantity" IS NOT NULL AND "counted_quantity" >= 0 AND "quantity" IS NULL)
      OR
      ("reason_code" <> 'COUNT_DIFFERENCE'
         AND "quantity" IS NOT NULL AND "quantity" > 0 AND "counted_quantity" IS NULL)
    );

ALTER TABLE "recalls"
  ADD CONSTRAINT "recalls_status_check" CHECK ("status" IN ('OPEN','CLOSED'));

-- 5. Đơn thuốc: trạng thái đã xác nhận bắt buộc có người xác nhận,
--    và số đã bán không vượt số lượng kê
ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_status_check"
    CHECK ("status" IN ('DRAFT','PENDING_REVIEW','VERIFIED','PARTIALLY_DISPENSED','DISPENSED','REJECTED')),
  ADD CONSTRAINT "prescriptions_verified_shape"
    CHECK (("status" IN ('VERIFIED','PARTIALLY_DISPENSED','DISPENSED')
            AND "verified_by" IS NOT NULL AND "verified_at" IS NOT NULL)
        OR "status" IN ('DRAFT','PENDING_REVIEW','REJECTED'));

ALTER TABLE "prescription_items"
  ADD CONSTRAINT "prescription_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "prescription_items_dispensed_limit"
    CHECK ("dispensed_base_quantity" >= 0
       AND ("base_quantity" IS NULL OR "dispensed_base_quantity" <= "base_quantity"));

-- 6. Bán hàng và trả hàng
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_status_check" CHECK ("status" IN ('COMPLETED','VOIDED')),
  ADD CONSTRAINT "invoices_return_status_check"
    CHECK ("return_status" IN ('NONE','PARTIAL','FULL')),
  ADD CONSTRAINT "invoices_payment_method_check"
    CHECK ("payment_method" IN ('CASH','BANK_TRANSFER','CARD')),
  ADD CONSTRAINT "invoices_amounts_non_negative"
    CHECK ("subtotal" >= 0 AND "discount_amount" >= 0 AND "vat_amount" >= 0 AND "total_amount" >= 0);

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_quantity_positive" CHECK ("quantity" > 0 AND "base_quantity" > 0),
  ADD CONSTRAINT "invoice_lines_amounts_non_negative"
    CHECK ("unit_price" >= 0 AND "discount_amount" >= 0 AND "line_total" >= 0);

ALTER TABLE "invoice_allocations"
  ADD CONSTRAINT "invoice_allocations_quantity_positive" CHECK ("base_quantity" > 0),
  ADD CONSTRAINT "invoice_allocations_return_limit"
    CHECK ("returned_base_quantity" >= 0 AND "returned_base_quantity" <= "base_quantity");

ALTER TABLE "returns"
  ADD CONSTRAINT "returns_disposition_check" CHECK ("disposition" IN ('RESTOCK','DISPOSE')),
  ADD CONSTRAINT "returns_refund_non_negative" CHECK ("refund_amount" >= 0);

ALTER TABLE "return_lines"
  ADD CONSTRAINT "return_lines_quantity_positive" CHECK ("quantity" > 0 AND "base_quantity" > 0),
  ADD CONSTRAINT "return_lines_refund_non_negative" CHECK ("refund_amount" >= 0);

ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_status_check" CHECK ("status" IN ('IN_PROGRESS','COMPLETED'));

-- 7. Chỉ mục duy nhất từng phần: mỗi sản phẩm đúng một đơn vị cơ bản,
--    và nhiều nhất một đơn vị bán mặc định
CREATE UNIQUE INDEX "product_units_one_base"
  ON "product_units" ("product_id") WHERE "conversion_to_base" = 1;

CREATE UNIQUE INDEX "product_units_one_default"
  ON "product_units" ("product_id") WHERE "is_default_sale_unit";

-- 8. Phạm vi toàn chuỗi biểu diễn bằng store_id NULL.
--    PostgreSQL coi mỗi NULL là khác nhau nên phải dùng NULLS NOT DISTINCT
--    (có từ PostgreSQL 15) mới chặn được hai dòng cùng NULL.
ALTER TABLE "user_roles"
  ADD CONSTRAINT "user_roles_user_role_store_key"
  UNIQUE NULLS NOT DISTINCT ("user_id", "role_id", "store_id");

ALTER TABLE "settings"
  ADD CONSTRAINT "settings_key_store_key"
  UNIQUE NULLS NOT DISTINCT ("key", "store_id");

ALTER TABLE "product_prices"
  ADD CONSTRAINT "product_prices_unit_store_effective_key"
  UNIQUE NULLS NOT DISTINCT ("product_unit_id", "store_id", "effective_from");

-- 9. Chỉ mục FEFO: chỉ chứa lô bán được nên rất nhỏ và luôn nóng trong bộ nhớ
CREATE INDEX "batches_fefo"
  ON "batches" ("store_id", "product_id", "expiry_date", "id")
  WHERE "status" = 'AVAILABLE' AND "quantity_on_hand" > 0;

-- 10. Tìm kiếm tiếng Việt không phân biệt dấu
CREATE INDEX "products_name_trgm"
  ON "products" USING gin (f_unaccent(lower("name")) gin_trgm_ops);

CREATE INDEX "active_ingredients_name_trgm"
  ON "active_ingredients" USING gin (f_unaccent(lower("name")) gin_trgm_ops);

CREATE INDEX "customers_full_name_trgm"
  ON "customers" USING gin (f_unaccent(lower("full_name")) gin_trgm_ops);

-- 11. Sổ chỉ ghi thêm: thu hồi quyền sửa và xóa của chính tài khoản ứng dụng.
--     Muốn mở lại (ví dụ để dọn dữ liệu test) thì chạy:
--       GRANT UPDATE, DELETE ON TABLE "audit_logs", "stock_movements" TO CURRENT_USER;
REVOKE UPDATE, DELETE ON TABLE "audit_logs" FROM CURRENT_USER;
REVOKE UPDATE, DELETE ON TABLE "stock_movements" FROM CURRENT_USER;
REVOKE UPDATE, DELETE ON TABLE "storage_logs" FROM CURRENT_USER;
