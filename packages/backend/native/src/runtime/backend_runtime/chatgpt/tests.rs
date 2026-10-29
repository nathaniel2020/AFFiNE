use super::*;
use std::sync::{
  Arc,
  atomic::{AtomicUsize, Ordering},
};

fn config() -> BackendRuntimeConfig {
  BackendRuntimeConfig {
    database_url: String::new(),
    auth: Default::default(),
    invite_quota: Default::default(),
    private_key: Arc::new(Zeroizing::new("test-only-encryption-root".into())),
    deployment: Deployment::SelfHosted,
    copilot: crate::runtime::CopilotRuntimeConfig {
      enabled: true,
      chatgpt_enabled: true,
      ..Default::default()
    },
    search: Default::default(),
    redis: Default::default(),
    payment: Default::default(),
  }
}

fn record(client: &str, generation: i32) -> ImportRecord {
  ImportRecord {
    client_id: client.into(),
    access_token: "access-fixture".into(),
    refresh_token: "refresh-fixture".into(),
    id_token: "verified-fixture".into(),
    nonce: "nonce".into(),
    scope: DIRECT_SCOPE.into(),
    expires_in: 3600,
    saved_at: Utc::now(),
    expected_generation: generation,
  }
}
fn identity(subject: &str) -> Identity {
  Identity {
    iss: ISSUER.into(),
    sub: subject.into(),
    email: Some("same@example.test".into()),
    nonce: Some("nonce".into()),
  }
}
async fn database() -> (PgPool, String) {
  let url = std::env::var("AFFINE_CHATGPT_TEST_DATABASE_URL").expect("dedicated test database required");
  let pool = PgPool::connect(&url).await.unwrap();
  let user = uuid::Uuid::new_v4().to_string();
  sqlx::query("INSERT INTO users (id,name,email) VALUES ($1,'SIWC test',$2)")
    .bind(&user)
    .bind(format!("{user}@example.test"))
    .execute(&pool)
    .await
    .unwrap();
  (pool, user)
}
async fn expire(pool: &PgPool, id: &str) {
  sqlx::query("UPDATE ai_user_chatgpt_profiles SET expires_at=now()-interval '1 minute' WHERE id=$1")
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
}
async fn catalog(pool: &PgPool, id: &str) {
  sqlx::query("UPDATE ai_user_chatgpt_profiles SET models=$2 WHERE id=$1")
    .bind(id)
    .bind(json!([{"slug":"dynamic-model","displayName":"Dynamic","inputModalities":["text","image","file"]}]))
    .execute(pool)
    .await
    .unwrap();
}
async fn cleanup(pool: &PgPool, user: &str) {
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user)
    .execute(pool)
    .await
    .unwrap();
}

#[test]
fn envelope_rejects_other_users_registrations_keys_and_protocols() {
  let config = config();
  let row = Profile {
    id: "p".into(),
    user_id: "a".into(),
    client_id: "c".into(),
    issuer: ISSUER.into(),
    subject: "s".into(),
    email: String::new(),
    encrypted_tokens: None,
    scopes: vec![],
    expires_at: Utc::now(),
    generation: 0,
    active: false,
    status: "connected".into(),
    models: json!([]),
    default_model: None,
  };
  let tokens = Tokens {
    access_token: "secret-access".into(),
    refresh_token: "secret-refresh".into(),
    id_token: "secret-id".into(),
  };
  let encrypted = encrypt(&config, &row, &tokens).unwrap();
  assert!(!encrypted.contains("secret"));
  let mut row = Profile {
    encrypted_tokens: Some(encrypted),
    ..row
  };
  assert_eq!(decrypt(&config, &row).unwrap().access_token, "secret-access");
  row.user_id = "other".into();
  assert!(decrypt(&config, &row).is_err());
  row.user_id = "a".into();
  row.client_id = "other".into();
  assert!(decrypt(&config, &row).is_err());
  row.client_id = "c".into();
  assert!(
    auth_endpoint(
      &json!({"jwks_uri":"https://auth.openai.com.evil.test/keys"}),
      "jwks_uri"
    )
    .is_err()
  );
  assert!(auth_endpoint(&json!({"jwks_uri":"https://evil.test/keys"}), "jwks_uri").is_err());
  let safe = serde_json::to_string(&row).unwrap();
  assert!(!safe.contains("encryptedTokens") && !safe.contains("chatgpt:v1:"));
  assert!(decode_target("chatgpt:not-a-uuid:bW9kZWw").is_err());
}

#[tokio::test]
#[ignore = "requires a migrated AFFINE_CHATGPT_TEST_DATABASE_URL"]
async fn accounts_cas_isolation_and_no_fallback() {
  let (pool, user) = database().await;
  let config = config();
  let first = import_verified(&pool, &config, &user, record("client-a", -1), identity("sub-a"))
    .await
    .unwrap();
  let id = first["id"].as_str().unwrap();
  assert!(
    import_verified(&pool, &config, &user, record("client-a", -1), identity("sub-a"))
      .await
      .is_err()
  );
  assert!(
    import_verified(&pool, &config, &user, record("client-a", 0), identity("other-sub"))
      .await
      .is_err()
  );
  let second = import_verified(&pool, &config, &user, record("client-b", -1), identity("sub-a"))
    .await
    .unwrap();
  assert_ne!(first["id"], second["id"]); // Same email/subject, distinct registrations.
  assert_eq!(profiles(&pool, &user).await.unwrap().len(), 2);
  assert!(profiles(&pool, "other-user").await.unwrap().is_empty());
  assert!(
    manage(
      &pool,
      &config,
      "other-user",
      &json!({"action":"disconnect","profileId":id})
    )
    .await
    .is_err()
  );
  catalog(&pool, id).await;
  manage(
    &pool,
    &config,
    &user,
    &json!({"action":"select","profileId":id,"model":"dynamic-model"}),
  )
  .await
  .unwrap();
  let slot = crate::llm::route::slot("chat.default").unwrap();
  let profiles = load_route_profiles(&pool, &config, &user, &slot, None)
    .await
    .unwrap()
    .unwrap();
  assert_eq!(profiles.len(), 1);
  assert!(matches!(
    profiles[0].source,
    crate::llm::route::ProfileSource::ChatGPTPlan
  ));
  assert!(
    load_route_profiles(&pool, &config, &user, &slot, Some("another-provider"))
      .await
      .unwrap()
      .is_none()
  );
  // Reconnection invalidates the catalog, but preserves the selected source.
  import_verified(&pool, &config, &user, record("client-a", 0), identity("sub-a"))
    .await
    .unwrap();
  assert!(load_route_profiles(&pool, &config, &user, &slot, None).await.is_err());
  catalog(&pool, id).await;
  manage(
    &pool,
    &config,
    &user,
    &json!({"action":"select","profileId":id,"model":"dynamic-model"}),
  )
  .await
  .unwrap();
  sqlx::query("UPDATE ai_user_chatgpt_profiles SET encrypted_tokens=NULL,status='reauth_required' WHERE id=$1")
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
  manage(&pool, &config, &user, &json!({"action":"disconnect","profileId":id}))
    .await
    .unwrap();
  assert!(load_route_profiles(&pool, &config, &user, &slot, None).await.is_err());
  manage(&pool, &config, &user, &json!({"action":"disable","profileId":id}))
    .await
    .unwrap();
  assert!(
    load_route_profiles(&pool, &config, &user, &slot, None)
      .await
      .unwrap()
      .is_none()
  );
  cleanup(&pool, &user).await;
}

#[tokio::test]
#[ignore = "requires a migrated AFFINE_CHATGPT_TEST_DATABASE_URL"]
async fn refresh_is_serialized_atomic_and_recovers_from_transient_failure() {
  let (pool, user) = database().await;
  let config = config();
  let imported = import_verified(&pool, &config, &user, record("client", -1), identity("subject"))
    .await
    .unwrap();
  let id = imported["id"].as_str().unwrap();
  expire(&pool, id).await;
  let calls = AtomicUsize::new(0);
  let renew = async |_: &Profile, tokens: &Tokens| {
    calls.fetch_add(1, Ordering::SeqCst);
    assert_eq!(tokens.refresh_token, "refresh-fixture");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    Ok((
      reqwest::StatusCode::OK,
      json!({"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_in":3600}),
    ))
  };
  let (a, b) = tokio::join!(
    access_token_with(&pool, &config, &user, id, renew),
    access_token_with(&pool, &config, &user, id, renew)
  );
  assert_eq!(a.unwrap().0.as_str(), "rotated-access");
  assert_eq!(b.unwrap().0.as_str(), "rotated-access");
  assert_eq!(calls.load(Ordering::SeqCst), 1);
  let rows = profiles(&pool, &user).await.unwrap();
  assert_eq!(rows[0].generation, 1);
  assert_eq!(decrypt(&config, &rows[0]).unwrap().refresh_token, "rotated-refresh");
  // Opening a new pool simulates process restart: only persisted state is reused.
  let restarted = PgPool::connect(&std::env::var("AFFINE_CHATGPT_TEST_DATABASE_URL").unwrap())
    .await
    .unwrap();
  assert_eq!(
    access_token(&restarted, &config, &user, id).await.unwrap().as_str(),
    "rotated-access"
  );
  expire(&pool, id).await;
  let unavailable = async |_: &Profile, _: &Tokens| Err(invalid("temporary network failure"));
  assert!(access_token_with(&pool, &config, &user, id, unavailable).await.is_err());
  let rows = profiles(&pool, &user).await.unwrap();
  assert_eq!(rows[0].generation, 1);
  assert_eq!(rows[0].status, "connected");
  let revoked =
    async |_: &Profile, _: &Tokens| Ok((reqwest::StatusCode::BAD_REQUEST, json!({"error":"invalid_grant"})));
  assert!(access_token_with(&pool, &config, &user, id, revoked).await.is_err());
  let rows = profiles(&pool, &user).await.unwrap();
  assert_eq!(rows[0].status, "reauth_required");
  assert!(rows[0].encrypted_tokens.is_none());
  cleanup(&pool, &user).await;
}
