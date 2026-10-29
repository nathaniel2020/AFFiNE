CREATE TABLE "ai_user_chatgpt_profiles" (
  "id" VARCHAR NOT NULL PRIMARY KEY,
  "user_id" VARCHAR NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "client_id" VARCHAR NOT NULL,
  "issuer" VARCHAR NOT NULL,
  "subject" VARCHAR NOT NULL,
  "email" VARCHAR NOT NULL,
  "encrypted_tokens" TEXT,
  "scopes" TEXT[] NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT FALSE,
  "status" VARCHAR NOT NULL DEFAULT 'connected',
  "models" JSONB NOT NULL DEFAULT '[]',
  "default_model" VARCHAR,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ai_user_chatgpt_profiles_user_id_client_id_key"
  ON "ai_user_chatgpt_profiles"("user_id", "client_id");
CREATE INDEX "ai_user_chatgpt_profiles_user_id_active_idx"
  ON "ai_user_chatgpt_profiles"("user_id", "active");
CREATE UNIQUE INDEX "ai_user_chatgpt_profiles_one_active"
  ON "ai_user_chatgpt_profiles"("user_id") WHERE "active";
