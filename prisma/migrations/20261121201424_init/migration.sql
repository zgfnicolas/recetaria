

    -- 1. AGREGADO ARRIBA: Extensión requerida (Fase 2.1)
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    -- 2. GENERADO POR PRISMA (sin modificar)
    -- CreateEnum
    CREATE TYPE "Role" AS ENUM ('USER', 'CHEF', 'NUTRITIONIST', 'ADMIN');

    -- CreateEnum
    CREATE TYPE "RecipeStatus" AS ENUM ('DRAFT', 'APPROVED');

    -- CreateEnum
    CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD', 'EXPERT');

    -- CreateTable
    CREATE TABLE "users" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "email" VARCHAR(255) NOT NULL,
        "passwordHash" VARCHAR(255) NOT NULL,
        "firstName" VARCHAR(100) NOT NULL,
        "lastName" VARCHAR(100) NOT NULL,
        "role" "Role" NOT NULL DEFAULT 'USER',
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "users_pkey" PRIMARY KEY ("id")
    );

    -- CreateTable
    CREATE TABLE "recipes" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "title" VARCHAR(150) NOT NULL,
        "slug" VARCHAR(200) NOT NULL,
        "description" TEXT NOT NULL,
        "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
        "status" "RecipeStatus" NOT NULL DEFAULT 'DRAFT',
        "prepTimeMinutes" SMALLINT NOT NULL,
        "tags" VARCHAR(50)[] DEFAULT ARRAY[]::VARCHAR(50)[],
        "ingredients" JSONB NOT NULL,
        "nutritionalInfo" JSONB,
        "coverImageUrl" VARCHAR(512),
        "videoUrl" VARCHAR(512),
        "authorId" UUID NOT NULL,
        "reviewedById" UUID,
        "publishedAt" TIMESTAMPTZ(6),
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
    );

    -- CreateTable
    CREATE TABLE "audit_logs" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "entityName" VARCHAR(50) NOT NULL,
        "entityId" UUID NOT NULL,
        "action" VARCHAR(50) NOT NULL,
        "userId" UUID,
        "oldValues" JSONB,
        "newValues" JSONB,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

	CONSTRAINT	"audit_logs_pkey" PRIMARY KEY ("id")
    );

    -- CreateIndex
    CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
    
    -- CreateIndex
    CREATE INDEX "idx_users_role_isactive" ON "users"("role", "isActive");

    -- CreateIndex
    CREATE UNIQUE INDEX "recipes_slug_key" ON "recipes"("slug");

    -- CreateIndex
    CREATE INDEX "idx_recipes_authorid" ON "recipes"("authorId");

    -- CreateIndex
    CREATE INDEX "idx_recipes_status_difficulty" ON "recipes"("status", "difficulty");

    -- CreateIndex
    CREATE INDEX "idx_audit_logs_entity" ON "audit_logs"("entityName", "entityId");

    -- CreateIndex
    CREATE INDEX "idx_audit_logs_createdat" ON "audit_logs"("createdAt");

    -- CreateIndex
    CREATE INDEX "idx_audit_logs_userid" ON "audit_logs"("userId");
    
    -- AddForeignKey
    ALTER TABLE "recipes" ADD CONSTRAINT "fk_recipes_author" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON
    DELETE RESTRICT ON UPDATE NO ACTION;

    -- AddForeignKey
    ALTER TABLE "recipes" ADD CONSTRAINT "fk_recipes_reviewer" FOREIGN KEY ("reviewedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;

    -- AddForeignKey
    ALTER TABLE "audit_logs" ADD CONSTRAINT "fk_audit_logs_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON
    DELETE SET NULL ON UPDATE NO ACTION;

    -- 3. AGREGADO ABAJO: CHECK (Opción B), triggers updatedAt y COMMENT (Fase 2.2-2.4)

    -- Constraints CHECK en "recipes"
    ALTER TABLE "recipes"
      ADD CONSTRAINT "chk_prep_time_positive"
      CHECK ("prepTimeMinutes" > 0 AND "prepTimeMinutes" <= 1440);

    ALTER TABLE "recipes"
      ADD CONSTRAINT "chk_recipes_reviewer_not_author"
      CHECK ("reviewedById" IS NULL OR "reviewedById" <> "authorId");

    ALTER TABLE "recipes"
      ADD CONSTRAINT "chk_recipes_ingredients_array"
      CHECK (jsonb_typeof("ingredients") = 'array');

    ALTER TABLE "recipes"
      ADD CONSTRAINT "chk_recipes_nutritional_info_object"
      CHECK ("nutritionalInfo" IS NULL OR jsonb_typeof("nutritionalInfo") = 'object');

    -- Función y triggers BEFORE UPDATE de "updatedAt"
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW."updatedAt" = NOW();
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON "users"
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    CREATE TRIGGER trg_recipes_updated_at
    BEFORE UPDATE ON "recipes"
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

    -- Documentación en catálogo PostgreSQL (RN-06)
	COMMENT ON COLUMN "audit_logs"."entityId" IS
      'ID de la entidad afectada; sin FK hacia recipes por diseño (RN-06) para conservar trazabilidad tras DELETE
      físico.';