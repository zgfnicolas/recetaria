-- 0. EXTENSIONS AND BASE FUNCTIONS
-- Enables the generation of native UUIDs in PostgreSQL
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Generic function to automatically update the updatedAt field
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 1. ENUMERATED TYPES (Static catalogs)
CREATE TYPE "Role" AS ENUM ('USER', 'CHEF', 'NUTRITIONIST', 'ADMIN');
CREATE TYPE "RecipeStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED');
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD', 'EXPERT');

-- 2. INDEPENDENT TABLES (No FK)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    "passwordHash" VARCHAR(255) NOT NULL,
    "firstName" VARCHAR(100) NOT NULL,
    "lastName" VARCHAR(100) NOT NULL,
    
    role "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
    
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. DEPENDENT TABLES (With FK)
CREATE TABLE recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(150) NOT NULL,
    slug VARCHAR(200) NOT NULL UNIQUE,
    description TEXT NOT NULL,
    
    difficulty "Difficulty" NOT NULL DEFAULT 'MEDIUM',
    status "RecipeStatus" NOT NULL DEFAULT 'DRAFT',
    "prepTimeMinutes" SMALLINT NOT NULL,
    
    tags VARCHAR(50)[] NOT NULL DEFAULT '{}',
    ingredients JSONB NOT NULL,
    "nutritionalInfo" JSONB,
    
    "coverImageUrl" VARCHAR(512),
    "videoUrl" VARCHAR(512),
    
    "authorId" UUID NOT NULL,
    "reviewedById" UUID,
    
    "publishedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Relational Integrity Constraints and Policies
    CONSTRAINT chk_prep_time_positive CHECK ("prepTimeMinutes" > 0),
    CONSTRAINT fk_recipes_author FOREIGN KEY ("authorId") REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_recipes_reviewer FOREIGN KEY ("reviewedById") REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "refreshToken" VARCHAR(512) NOT NULL UNIQUE,
    "ipAddress" VARCHAR(45),
    "userAgent" TEXT,
    
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- If a user is deleted, all their active sessions are destroyed (Cascade)
    CONSTRAINT fk_sessions_user FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "entityName" VARCHAR(50) NOT NULL,
    "entityId" UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    
    "userId" UUID,
    "oldValues" JSONB,
    "newValues" JSONB,
    
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- If the user who performed the action is deleted, the log becomes orphaned (set to NULL) so that traceability is not lost.
    CONSTRAINT fk_audit_logs_user FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
);


-- 4. INDEXES (B-Tree query optimization)
-- Indexes for users
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role_isactive ON users(role, "isActive");

-- Indices for recipes
CREATE INDEX idx_recipes_authorid ON recipes("authorId");
CREATE INDEX idx_recipes_status_difficulty ON recipes(status, difficulty);
CREATE INDEX idx_recipes_slug ON recipes(slug);

-- Indexes for sessions and auditing
CREATE INDEX idx_sessions_userid ON sessions("userId");
CREATE INDEX idx_audit_logs_entity ON audit_logs("entityName", "entityId");
CREATE INDEX idx_audit_logs_createdat ON audit_logs("createdAt");

-- 5. TRIGGERS (Automation at the engine level)
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_recipes_updated_at
BEFORE UPDATE ON recipes
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();