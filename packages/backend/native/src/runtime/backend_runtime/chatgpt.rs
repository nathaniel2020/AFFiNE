//! Personal SIWC credentials. Tokens never cross the browser API boundary.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool};
use zeroize::{Zeroize, Zeroizing};

use super::{BackendRuntime, RuntimeError, RuntimeResult, to_napi_error};
use crate::{
  llm::byok::{CredentialEnvelopeKey, SensitiveCredential},
  runtime::{BackendRuntimeConfig, Deployment},
};

const ISSUER: &str = "https://auth.openai.com";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE: &str = "https://api.openai.com/v1";
const DIRECT_SCOPE: &str = "chatgpt.tokens.use.direct";

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Profile {
  pub(super) id: String,
  pub(super) user_id: String,
  client_id: String,
  issuer: String,
  subject: String,
  email: String,
  #[serde(skip)]
  encrypted_tokens: Option<String>,
  scopes: Vec<String>,
  expires_at: DateTime<Utc>,
  pub(super) generation: i32,
  pub(super) active: bool,
  pub(super) status: String,
  pub(super) models: Value,
  pub(super) default_model: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Tokens {
  access_token: String,
  refresh_token: String,
  id_token: String,
}

impl Drop for Tokens {
  fn drop(&mut self) {
    self.access_token.zeroize();
    self.refresh_token.zeroize();
    self.id_token.zeroize();
  }
}

#[derive(Deserialize)]
struct ImportRecord {
  client_id: String,
  access_token: String,
  refresh_token: String,
  id_token: String,
  nonce: String,
  scope: String,
  expires_in: i64,
  saved_at: DateTime<Utc>,
  expected_generation: i32,
}

#[derive(Clone, Deserialize)]
struct Identity {
  iss: String,
  sub: String,
  email: Option<String>,
  nonce: Option<String>,
}

fn db(error: sqlx::Error) -> RuntimeError {
  RuntimeError::database("ChatGPT connection operation failed", error)
}

fn invalid(message: &str) -> RuntimeError {
  RuntimeError::invalid_input(format!("chatgpt_plan: {message}"))
}

fn client() -> RuntimeResult<reqwest::Client> {
  reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(20))
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .map_err(|_| invalid("HTTP client unavailable"))
}

fn check(config: &BackendRuntimeConfig) -> RuntimeResult<()> {
  if config.deployment != Deployment::SelfHosted || !config.copilot.chatgpt_enabled {
    return Err(invalid("personal self-hosted connections are disabled"));
  }
  if config.private_key.is_empty() {
    return Err(invalid("a persistent crypto.privateKey is required"));
  }
  Ok(())
}

fn key(config: &BackendRuntimeConfig) -> RuntimeResult<CredentialEnvelopeKey> {
  CredentialEnvelopeKey::derive_domain(config.private_key.as_bytes(), b"AFFiNE/Copilot/ChatGPT/v1")
    .map_err(|_| invalid("credential unavailable"))
}

fn aad(user: &str, id: &str, client_id: &str, issuer: &str, subject: &str) -> Vec<u8> {
  ["chatgpt_plan", user, id, client_id, issuer, subject, RESOURCE]
    .join("\0")
    .into_bytes()
}

fn encrypt(config: &BackendRuntimeConfig, row: &Profile, tokens: &Tokens) -> RuntimeResult<String> {
  let bytes = serde_json::to_vec(tokens).map_err(|_| invalid("invalid credentials"))?;
  key(config)?
    .encrypt(
      &SensitiveCredential::new(bytes),
      &aad(&row.user_id, &row.id, &row.client_id, &row.issuer, &row.subject),
    )
    .map(|value| value.replacen("byok:v1:", "chatgpt:v1:", 1))
    .map_err(|_| invalid("credential unavailable"))
}

fn decrypt(config: &BackendRuntimeConfig, row: &Profile) -> RuntimeResult<Tokens> {
  let encrypted = row
    .encrypted_tokens
    .as_deref()
    .filter(|value| value.starts_with("chatgpt:v1:"))
    .ok_or_else(|| invalid("sign in again"))?;
  let value = key(config)?
    .decrypt(
      &encrypted.replacen("chatgpt:v1:", "byok:v1:", 1),
      &aad(&row.user_id, &row.id, &row.client_id, &row.issuer, &row.subject),
    )
    .map_err(|_| invalid("credential unavailable"))?;
  serde_json::from_slice(value.expose()).map_err(|_| invalid("credential unavailable"))
}

async fn discovery() -> RuntimeResult<Value> {
  client()?
    .get(format!("{ISSUER}/.well-known/openid-configuration"))
    .send()
    .await
    .map_err(|_| invalid("authentication discovery unavailable"))?
    .error_for_status()
    .map_err(|_| invalid("authentication discovery unavailable"))?
    .json()
    .await
    .map_err(|_| invalid("invalid authentication discovery"))
}

fn auth_endpoint<'a>(document: &'a Value, field: &str) -> RuntimeResult<&'a str> {
  document[field]
    .as_str()
    .filter(|url| url.starts_with("https://auth.openai.com/"))
    .ok_or_else(|| invalid("unexpected authentication endpoint"))
}

async fn validate_identity(token: &str, client_id: &str, nonce: Option<&str>) -> RuntimeResult<Identity> {
  let header = decode_header(token).map_err(|_| invalid("invalid ID token"))?;
  if !matches!(
    header.alg,
    jsonwebtoken::Algorithm::RS256 | jsonwebtoken::Algorithm::ES256
  ) {
    return Err(invalid("unsupported ID token algorithm"));
  }
  let document = discovery().await?;
  let jwks: JwkSet = client()?
    .get(auth_endpoint(&document, "jwks_uri")?)
    .send()
    .await
    .map_err(|_| invalid("identity verification unavailable"))?
    .error_for_status()
    .map_err(|_| invalid("identity verification unavailable"))?
    .json()
    .await
    .map_err(|_| invalid("invalid signing keys"))?;
  let jwk = jwks
    .find(header.kid.as_deref().ok_or_else(|| invalid("missing signing key"))?)
    .ok_or_else(|| invalid("unknown signing key"))?;
  let mut validation = Validation::new(header.alg);
  validation.set_issuer(&[ISSUER]);
  validation.set_audience(&[client_id]);
  let identity = decode::<Identity>(
    token,
    &DecodingKey::from_jwk(jwk).map_err(|_| invalid("invalid signing key"))?,
    &validation,
  )
  .map_err(|_| invalid("ID token verification failed"))?
  .claims;
  if identity.sub.is_empty() || nonce.is_some_and(|expected| identity.nonce.as_deref() != Some(expected)) {
    return Err(invalid("identity or nonce mismatch"));
  }
  Ok(identity)
}

pub(super) async fn profiles(pool: &PgPool, user: &str) -> RuntimeResult<Vec<Profile>> {
  sqlx::query_as("SELECT * FROM ai_user_chatgpt_profiles WHERE user_id=$1 ORDER BY created_at,id")
    .bind(user)
    .fetch_all(pool)
    .await
    .map_err(db)
}

async fn import(pool: &PgPool, config: &BackendRuntimeConfig, user: &str, value: Value) -> RuntimeResult<Value> {
  let record: ImportRecord = serde_json::from_value(value).map_err(|_| invalid("invalid import record"))?;
  if record.client_id == "dynamic_agent_client"
    || record.client_id.is_empty()
    || record.nonce.is_empty()
    || record.access_token.is_empty()
    || record.refresh_token.is_empty()
    || !(1..=86400).contains(&record.expires_in)
    || record.saved_at > Utc::now() + Duration::minutes(1)
    || record.saved_at + Duration::seconds(record.expires_in) <= Utc::now()
  {
    return Err(invalid("incomplete or expired import record"));
  }
  let identity = validate_identity(&record.id_token, &record.client_id, Some(&record.nonce)).await?;
  import_verified(pool, config, user, record, identity).await
}

async fn import_verified(
  pool: &PgPool,
  config: &BackendRuntimeConfig,
  user: &str,
  record: ImportRecord,
  identity: Identity,
) -> RuntimeResult<Value> {
  let mut tx = pool.begin().await.map_err(db)?;
  let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE id=$1 AND disabled=FALSE FOR UPDATE")
    .bind(user)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
  if exists.is_none() {
    return Err(invalid("AFFiNE user does not exist"));
  }
  let old: Option<Profile> =
    sqlx::query_as("SELECT * FROM ai_user_chatgpt_profiles WHERE user_id=$1 AND client_id=$2 FOR UPDATE")
      .bind(user)
      .bind(&record.client_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(db)?;
  if old.as_ref().map_or(-1, |row| row.generation) != record.expected_generation {
    return Err(invalid(
      "connection changed; prepare a new authorization before importing",
    ));
  }
  if old
    .as_ref()
    .is_some_and(|row| row.issuer != identity.iss || row.subject != identity.sub)
  {
    return Err(invalid("returning account identity changed"));
  }
  let scopes: Vec<String> = record.scope.split_whitespace().map(str::to_string).collect();
  let sharing = scopes.iter().any(|scope| scope == DIRECT_SCOPE);
  let row = Profile {
    id: old
      .as_ref()
      .map_or_else(|| uuid::Uuid::new_v4().to_string(), |row| row.id.clone()),
    user_id: user.to_string(),
    client_id: record.client_id,
    issuer: identity.iss,
    subject: identity.sub,
    email: identity.email.unwrap_or_default(),
    encrypted_tokens: None,
    scopes,
    expires_at: record.saved_at + Duration::seconds(record.expires_in),
    generation: record.expected_generation + 1,
    active: false,
    status: if sharing { "connected" } else { "consent_required" }.into(),
    models: json!([]),
    default_model: None,
  };
  let tokens = Tokens {
    access_token: record.access_token,
    refresh_token: record.refresh_token,
    id_token: record.id_token,
  };
  let encrypted = encrypt(config, &row, &tokens)?;
  sqlx::query("INSERT INTO ai_user_chatgpt_profiles (id,user_id,client_id,issuer,subject,email,encrypted_tokens,scopes,expires_at,generation,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (user_id,client_id) DO UPDATE SET encrypted_tokens=EXCLUDED.encrypted_tokens,scopes=EXCLUDED.scopes,expires_at=EXCLUDED.expires_at,generation=EXCLUDED.generation,email=EXCLUDED.email,status=EXCLUDED.status,models='[]',default_model=NULL,updated_at=now()")
    .bind(&row.id).bind(user).bind(&row.client_id).bind(&row.issuer).bind(&row.subject).bind(&row.email)
    .bind(encrypted).bind(&row.scopes).bind(row.expires_at).bind(row.generation).bind(&row.status)
    .execute(&mut *tx).await.map_err(db)?;
  tx.commit().await.map_err(db)?;
  Ok(json!({"id": row.id, "status":row.status, "generation":row.generation}))
}

pub(super) async fn access_token(
  pool: &PgPool,
  config: &BackendRuntimeConfig,
  user: &str,
  id: &str,
) -> RuntimeResult<Zeroizing<String>> {
  Ok(access_token_with(pool, config, user, id, refresh).await?.0)
}

async fn refresh(row: &Profile, tokens: &Tokens) -> RuntimeResult<(reqwest::StatusCode, Value)> {
  let response = client()?
    .post(TOKEN_URL)
    .form(&[
      ("grant_type", "refresh_token"),
      ("client_id", row.client_id.as_str()),
      ("refresh_token", tokens.refresh_token.as_str()),
      ("resource", RESOURCE),
    ])
    .send()
    .await
    .map_err(|_| invalid("token refresh temporarily unavailable"))?;
  let status = response.status();
  let body = response
    .json()
    .await
    .map_err(|_| invalid("invalid token refresh response"))?;
  Ok((status, body))
}

// Refresh is injected for transaction tests; production always uses the fixed official endpoint.
async fn access_token_with<F>(
  pool: &PgPool,
  config: &BackendRuntimeConfig,
  user: &str,
  id: &str,
  renew: F,
) -> RuntimeResult<(Zeroizing<String>, i32)>
where
  F: for<'a> AsyncFnOnce(&'a Profile, &'a Tokens) -> RuntimeResult<(reqwest::StatusCode, Value)>,
{
  check(config)?;
  let mut tx = pool.begin().await.map_err(db)?;
  let row: Profile = sqlx::query_as("SELECT * FROM ai_user_chatgpt_profiles WHERE user_id=$1 AND id=$2 FOR UPDATE")
    .bind(user)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| invalid("connection not found"))?;
  if !row.scopes.iter().any(|scope| scope == DIRECT_SCOPE) || row.status != "connected" {
    return Err(invalid("enable ChatGPT plan usage or sign in again"));
  }
  let mut generation = row.generation;
  let mut tokens = decrypt(config, &row)?;
  if row.expires_at <= Utc::now() + Duration::seconds(60) {
    let (status, body) = renew(&row, &tokens).await?;
    if !status.is_success() {
      let code = body["error"].as_str().unwrap_or("");
      if matches!(
        code,
        "invalid_grant"
          | "invalid_refresh_token"
          | "refresh_token_invalid"
          | "token_expired"
          | "refresh_token_expired"
          | "refresh_token_invalidated"
          | "refresh_token_reused"
      ) {
        sqlx::query("UPDATE ai_user_chatgpt_profiles SET encrypted_tokens=NULL,status='reauth_required',generation=generation+1,updated_at=now() WHERE id=$1")
          .bind(id).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        return Err(invalid("session expired; sign in again"));
      }
      return Err(invalid("token refresh unavailable; connection retained"));
    }
    tokens.access_token = body["access_token"]
      .as_str()
      .filter(|s| !s.is_empty())
      .ok_or_else(|| invalid("missing renewed token"))?
      .to_string();
    if let Some(refresh) = body["refresh_token"].as_str().filter(|s| !s.is_empty()) {
      tokens.refresh_token = refresh.into();
    }
    if let Some(id_token) = body["id_token"].as_str() {
      let identity = validate_identity(id_token, &row.client_id, None).await?;
      if identity.iss != row.issuer || identity.sub != row.subject {
        return Err(invalid("renewed identity changed"));
      }
      tokens.id_token = id_token.into();
    }
    let expires = body["expires_in"]
      .as_i64()
      .filter(|v| (1..=86400).contains(v))
      .ok_or_else(|| invalid("invalid token lifetime"))?;
    let scopes = body["scope"]
      .as_str()
      .map(|s| s.split_whitespace().map(str::to_string).collect::<Vec<_>>())
      .unwrap_or_else(|| row.scopes.clone());
    let sharing = scopes.iter().any(|s| s == DIRECT_SCOPE);
    generation += 1;
    let encrypted = encrypt(
      config,
      &Profile {
        scopes: scopes.clone(),
        ..row
      },
      &tokens,
    )?;
    sqlx::query("UPDATE ai_user_chatgpt_profiles SET encrypted_tokens=$2,expires_at=$3,scopes=$4,status=$5,generation=generation+1,updated_at=now() WHERE id=$1")
      .bind(id).bind(encrypted).bind(Utc::now()+Duration::seconds(expires)).bind(scopes)
      .bind(if sharing {"connected"} else {"consent_required"}).execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    if !sharing {
      return Err(invalid("ChatGPT plan permission was removed"));
    }
  } else {
    tx.commit().await.map_err(db)?;
  }
  Ok((Zeroizing::new(std::mem::take(&mut tokens.access_token)), generation))
}

async fn refresh_models(pool: &PgPool, config: &BackendRuntimeConfig, user: &str, id: &str) -> RuntimeResult<Value> {
  let (token, generation) = access_token_with(pool, config, user, id, refresh).await?;
  let response = client()?
    .get(format!("{RESOURCE}/models"))
    .bearer_auth(token.as_str())
    .send()
    .await
    .map_err(|_| invalid("model discovery unavailable"))?;
  if !response.status().is_success() {
    return Err(invalid(
      "model discovery rejected; check the connection in ChatGPT settings",
    ));
  }
  let body: Value = response.json().await.map_err(|_| invalid("invalid model catalog"))?;
  let models = body["models"]
    .as_array()
    .ok_or_else(|| invalid("invalid model catalog"))?
    .iter()
    .filter(|m| m["visibility"] == "list" && m["slug"].as_str().is_some_and(|s| !s.is_empty()))
    .map(|m| {
      json!({"slug":m["slug"], "displayName":m["display_name"].as_str().unwrap_or(m["slug"].as_str().unwrap()),
      "inputModalities":catalog_modalities(m)})
    })
    .collect::<Vec<_>>();
  let updated = sqlx::query(
    "UPDATE ai_user_chatgpt_profiles SET models=$3,updated_at=now() WHERE user_id=$1 AND id=$2 AND status='connected' AND generation=$4",
  )
  .bind(user)
  .bind(id)
  .bind(json!(models))
  .bind(generation)
  .execute(pool)
  .await
  .map_err(db)?;
  if updated.rows_affected() != 1 {
    return Err(invalid("connection changed; refresh models again"));
  }
  Ok(json!(models))
}

fn catalog_modalities(model: &Value) -> Vec<Value> {
  if let Some(modalities) = model["input_modalities"].as_array() {
    return modalities.clone();
  }
  // Older catalogs only expose names. Use the existing provider capability registry
  // for known models; unknown models stay text-only until the catalog declares more.
  use llm_adapter::capability::{ModelInput, provider_default_capability_upper_bound};
  let mut result = vec![json!("text")];
  if let Some(capabilities) = provider_default_capability_upper_bound("openai", model["slug"].as_str().unwrap_or("")) {
    for (kind, label) in [(ModelInput::Image, "image"), (ModelInput::File, "file")] {
      if capabilities.iter().any(|c| c.input.contains(&kind)) {
        result.push(json!(label));
      }
    }
  }
  result
}

async fn manage(pool: &PgPool, config: &BackendRuntimeConfig, user: &str, input: &Value) -> RuntimeResult<Value> {
  let id = input["profileId"]
    .as_str()
    .ok_or_else(|| invalid("profile ID required"))?;
  if input["action"] == "refreshModels" {
    return refresh_models(pool, config, user, id).await;
  }
  let mut tx = pool.begin().await.map_err(db)?;
  sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
    .bind(user)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
  let row: Profile = sqlx::query_as("SELECT * FROM ai_user_chatgpt_profiles WHERE user_id=$1 AND id=$2 FOR UPDATE")
    .bind(user)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| invalid("connection not found"))?;
  let mut revoked = true;
  match input["action"].as_str().unwrap_or("") {
    "select" => {
      let model = input["model"].as_str().ok_or_else(|| invalid("select a model"))?;
      if row.status != "connected"
        || !row
          .models
          .as_array()
          .is_some_and(|models| models.iter().any(|m| m["slug"] == model))
      {
        return Err(invalid("model unavailable; refresh the catalog"));
      }
      sqlx::query("UPDATE ai_user_chatgpt_profiles SET active=FALSE WHERE user_id=$1")
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
      sqlx::query("UPDATE ai_user_chatgpt_profiles SET active=TRUE,default_model=$2,updated_at=now() WHERE id=$1")
        .bind(id)
        .bind(model)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    }
    "disable" => {
      sqlx::query("UPDATE ai_user_chatgpt_profiles SET active=FALSE WHERE user_id=$1")
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    }
    "disconnect" => {
      if row.encrypted_tokens.is_some() {
        let tokens = decrypt(config, &row)?;
        revoked = false;
        if let Ok(document) = discovery().await
          && let Ok(endpoint) = auth_endpoint(&document, "revocation_endpoint")
        {
          for attempt in 0..2 {
            if attempt > 0 {
              tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
            if let Ok(response) = client()?
              .post(endpoint)
              .form(&[
                ("token", tokens.refresh_token.as_str()),
                ("token_type_hint", "refresh_token"),
                ("client_id", row.client_id.as_str()),
              ])
              .send()
              .await
            {
              if response.status().as_u16() == 200 {
                revoked = true;
                break;
              }
              if response.status().is_client_error() {
                break;
              }
            }
          }
        }
      }
      // Keep the active routing selection: stale Auto must fail, never charge another source.
      sqlx::query("UPDATE ai_user_chatgpt_profiles SET encrypted_tokens=NULL,status=$2,generation=generation+1,models='[]',updated_at=now() WHERE id=$1")
        .bind(id).bind(if revoked {"signed_out"} else {"signed_out_revocation_unconfirmed"}).execute(&mut *tx).await.map_err(db)?;
    }
    _ => return Err(invalid("unknown connection operation")),
  }
  tx.commit().await.map_err(db)?;
  Ok(json!({"remoteRevocationConfirmed":revoked}))
}

#[napi_derive::napi]
impl BackendRuntime {
  #[napi]
  pub async fn chatgpt_command(&self, user_id: String, input_json: String) -> napi::Result<String> {
    self
      .chatgpt_command_inner(&user_id, &input_json)
      .await
      .and_then(|value| serde_json::to_string(&value).map_err(|_| invalid("cannot encode connection result")))
      .map_err(to_napi_error)
  }
}

impl BackendRuntime {
  async fn chatgpt_command_inner(&self, user: &str, input_json: &str) -> RuntimeResult<Value> {
    let config = self.config()?;
    let input: Value = serde_json::from_str(input_json).map_err(|_| invalid("invalid command"))?;
    let enabled = config.deployment == Deployment::SelfHosted && config.copilot.chatgpt_enabled;
    if input["action"] == "status" {
      if !enabled {
        return Ok(json!({"enabled":false,"userId":user,"profiles":[]}));
      }
      return Ok(json!({"enabled":true,"userId":user,"profiles":profiles(&self.pool().await?,user).await?}));
    }
    check(&config)?;
    let pool = self.pool().await?;
    match input["action"].as_str().unwrap_or("") {
      "import" => import(&pool, &config, user, input["record"].clone()).await,
      "refreshModels" | "select" | "disable" | "disconnect" => manage(&pool, &config, user, &input).await,
      _ => Err(invalid("unknown command")),
    }
  }
}

pub(super) fn decode_target(id: &str) -> RuntimeResult<crate::llm::route::TargetOverride> {
  let (profile_id, model) = id
    .strip_prefix("chatgpt:")
    .and_then(|value| value.split_once(':'))
    .ok_or_else(|| invalid("invalid model selection"))?;
  uuid::Uuid::parse_str(profile_id).map_err(|_| invalid("invalid connection selection"))?;
  let model_id = String::from_utf8(
    URL_SAFE_NO_PAD
      .decode(model)
      .map_err(|_| invalid("invalid model selection"))?,
  )
  .map_err(|_| invalid("invalid model selection"))?;
  Ok(crate::llm::route::TargetOverride {
    profile_id: profile_id.into(),
    model_id,
  })
}

pub(super) async fn load_route_profiles(
  pool: &PgPool,
  config: &BackendRuntimeConfig,
  user: &str,
  slot: &crate::llm::route::CatalogSlot,
  selection: Option<&str>,
) -> RuntimeResult<Option<Vec<crate::llm::route::AuthorizedProviderProfile>>> {
  use crate::llm::{
    byok::ByokModelDeclaration,
    route::{AuthorizedProviderProfile, CredentialRef, ProfileSource, RouteOperation},
  };
  use llm_adapter::{capability::*, target::*};
  let selected = selection
    .filter(|id| id.starts_with("chatgpt:"))
    .map(decode_target)
    .transpose()?;
  let supported = matches!(slot.operation, RouteOperation::Chat | RouteOperation::Structured);
  if config.deployment != Deployment::SelfHosted || !config.copilot.chatgpt_enabled || !supported {
    return if selected.is_some() {
      Err(invalid("ChatGPT is unavailable for this operation"))
    } else {
      Ok(None)
    };
  }
  if selection.is_some() && selected.is_none() {
    return Ok(None);
  }
  let rows = profiles(pool, user).await?;
  let row = rows.into_iter().find(|row| {
    selected
      .as_ref()
      .map_or(row.active, |target| row.id == target.profile_id)
  });
  let Some(row) = row else {
    return if selected.is_some() {
      Err(invalid("connection not found"))
    } else {
      Ok(None)
    };
  };
  if row.status != "connected" {
    return Err(invalid(
      "selected connection requires sign-in; no alternative billing source was used",
    ));
  }
  let model_id = selected
    .map(|target| target.model_id)
    .or(row.default_model)
    .ok_or_else(|| invalid("choose a default model in Web settings"))?;
  let model = row
    .models
    .as_array()
    .and_then(|models| models.iter().find(|m| m["slug"] == model_id))
    .ok_or_else(|| invalid("selected model is unavailable; refresh models in Web settings"))?;
  let modalities = model["inputModalities"].as_array().cloned().unwrap_or_default();
  let mut input = vec![ModelInput::Text];
  let mut kinds = Vec::new();
  if modalities.contains(&json!("image")) {
    input.push(ModelInput::Image);
    kinds.push(AttachmentKind::Image);
  }
  if modalities.contains(&json!("file")) {
    input.push(ModelInput::File);
    kinds.push(AttachmentKind::File);
  }
  let sources = if kinds.is_empty() {
    vec![]
  } else {
    vec![AttachmentSource::Url, AttachmentSource::Data, AttachmentSource::Bytes]
  };
  Ok(Some(vec![AuthorizedProviderProfile {
    profile_id: row.id.clone(),
    source: ProfileSource::ChatGPTPlan,
    provider: "openai".into(),
    endpoint: BackendEndpoint::Custom(RESOURCE.into()),
    openai_dialect: Some(OpenAiDialect::Responses),
    egress_policy: EgressPolicy::PublicOnly,
    sort_order: 0,
    credential_ref: CredentialRef::ChatGPTPlan {
      user_id: user.into(),
      profile_id: row.id,
    },
    models: vec![ByokModelDeclaration {
      model_id,
      enabled: true,
      capabilities: vec![DeclaredModelCapability {
        input,
        output: vec![ModelOutput::Text, ModelOutput::Structured, ModelOutput::Object],
        features: vec![ModelFeature::ToolCalling, ModelFeature::Reasoning],
        attachment_kinds: kinds,
        attachment_sources: sources,
      }],
    }],
  }]))
}

#[cfg(test)]
mod tests;
