/**
 * ai-fudosan-api - Cloudflare Worker
 *
 * Routes:
 *   POST /api/gemini              - Gemini API proxy
 *   GET  /api/estat/population    - e-Stat 人口統計
 *   GET  /api/estat/housing       - e-Stat 住宅統計
 *   GET  /api/estat/query         - e-Stat 汎用クエリ
 *   POST /api/checkout            - Stripe Checkout Session 作成
 *   POST /api/webhook             - Stripe Webhook 受信
 *   GET  /api/purchases           - 購入確認（session_id クエリパラメータ）
 *
 * Required environment variables (set via wrangler secret put):
 *   GEMINI_API_KEY
 *   ESTAT_APP_ID
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   SUPABASE_SERVICE_KEY
 *   STRIPE_PRICE_ID (wrangler.toml [vars] に設定可)
 *   SUPABASE_URL (wrangler.toml [vars] に設定可)
 *
 * KV binding:
 *   PURCHASES
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const ESTAT_API_BASE = "https://api.e-stat.go.jp/rest/3.0/app/json";

// e-Stat の統計表ID（人口・住宅）
const ESTAT_STATS_ID = {
  population: "0000010101", // 国勢調査 人口等基本集計
  housing: "0000010201",    // 住宅・土地統計調査
};

// Stripe API エンドポイント
const STRIPE_API_BASE = "https://api.stripe.com/v1";

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

/**
 * CORS ヘッダーを生成する。
 * @returns {Headers}
 */
function buildCorsHeaders() {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, stripe-signature");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

/**
 * CORS 付き JSON レスポンスを返す。
 * @param {unknown} data
 * @param {number} status
 * @returns {Response}
 */
function jsonResponse(data, status = 200) {
  const headers = buildCorsHeaders();
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * CORS 付きエラーレスポンスを返す。
 * @param {string} message
 * @param {number} status
 * @returns {Response}
 */
function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

/**
 * OPTIONS プリフライトに対するレスポンスを返す。
 * @returns {Response}
 */
function handleOptions() {
  return new Response(null, { status: 204, headers: buildCorsHeaders() });
}

// ---------------------------------------------------------------------------
// Gemini API proxy
// ---------------------------------------------------------------------------

/**
 * Gemini API へリクエストを転送する。
 * body の model フィールドでモデルを選択可能（デフォルト: gemini-2.0-flash）。
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleGemini(request, env) {
  if (!env.GEMINI_API_KEY) {
    return errorResponse("GEMINI_API_KEY が設定されていません", 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("リクエストボディが不正な JSON です", 400);
  }

  // モデル名をボディから取得（省略時はデフォルト）
  const model = body.model ?? "gemini-2.0-flash";

  // app.js が {prompt: "text"} で送ってくる場合、Gemini API 形式に変換
  let geminiBody;
  if (body.prompt && !body.contents) {
    geminiBody = {
      contents: [{ parts: [{ text: body.prompt }] }],
      generationConfig: body.generationConfig || { temperature: 0.7, maxOutputTokens: 4096 },
    };
  } else {
    const { model: _model, ...rest } = body;
    geminiBody = rest;
  }

  const url = `${GEMINI_API_BASE}/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });
  } catch (err) {
    return errorResponse(`Gemini API への接続に失敗しました: ${err.message}`, 502);
  }

  const responseData = await upstream.json();

  if (!upstream.ok) {
    return jsonResponse(
      { error: "Gemini API エラー", detail: responseData },
      upstream.status
    );
  }

  // app.js が data.text を期待しているので、Gemini レスポンスからテキストを抽出
  const text = responseData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return jsonResponse({ text, raw: responseData });
}

// ---------------------------------------------------------------------------
// e-Stat API proxy helpers
// ---------------------------------------------------------------------------

/**
 * e-Stat API へ GET リクエストを送り、結果を返す。
 *
 * @param {string} endpoint - e-Stat のエンドポイントパス (例: "/getStatsData")
 * @param {URLSearchParams} params - クエリパラメータ（appId を除く）
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function fetchEstat(endpoint, params, env) {
  if (!env.ESTAT_APP_ID) {
    return errorResponse("ESTAT_APP_ID が設定されていません", 500);
  }

  const appId = (typeof env.ESTAT_APP_ID === "string") ? env.ESTAT_APP_ID.trim() : env.ESTAT_APP_ID;
  params.set("appId", appId);

  const url = `${ESTAT_API_BASE}${endpoint}?${params.toString()}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
  } catch (err) {
    return errorResponse(`e-Stat API への接続に失敗しました: ${err.message}`, 502);
  }

  const responseData = await upstream.json();

  if (!upstream.ok) {
    return jsonResponse(
      { error: "e-Stat API エラー", detail: responseData },
      upstream.status
    );
  }

  return jsonResponse(responseData);
}

/**
 * GET /api/estat/population
 * クエリパラメータをそのまま e-Stat に転送し、デフォルト statsDataId を付与する。
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleEstatPopulation(request, env) {
  const incomingParams = new URL(request.url).searchParams;
  const params = new URLSearchParams(incomingParams);

  // statsDataId が未指定の場合はデフォルト値を使用
  if (!params.has("statsDataId")) {
    params.set("statsDataId", ESTAT_STATS_ID.population);
  }

  return fetchEstat("/getStatsData", params, env);
}

/**
 * GET /api/estat/housing
 * クエリパラメータをそのまま e-Stat に転送し、デフォルト statsDataId を付与する。
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleEstatHousing(request, env) {
  const incomingParams = new URL(request.url).searchParams;
  const params = new URLSearchParams(incomingParams);

  if (!params.has("statsDataId")) {
    params.set("statsDataId", ESTAT_STATS_ID.housing);
  }

  return fetchEstat("/getStatsData", params, env);
}

/**
 * GET /api/estat/query
 * クエリパラメータをそのまま e-Stat getStatsList エンドポイントへ転送する。
 * statsDataId や searchWord などを自由に渡せる汎用エンドポイント。
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleEstatQuery(request, env) {
  const incomingParams = new URL(request.url).searchParams;
  const params = new URLSearchParams(incomingParams);

  // endpoint クエリで e-Stat のエンドポイントを選択可能（デフォルト: getStatsData）
  const estatEndpoint = params.get("_endpoint") ?? "/getStatsData";
  params.delete("_endpoint");

  return fetchEstat(estatEndpoint, params, env);
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

/**
 * Supabase REST API にリクエストを送る。
 *
 * @param {string} path - テーブルパス (例: "/purchases")
 * @param {string} method - HTTP メソッド
 * @param {object|null} body - JSON ボディ
 * @param {object} env
 * @param {object} [options] - 追加ヘッダー等
 * @returns {Promise<{ok: boolean, status: number, data: any}>}
 */
async function supabaseRequest(path, method, body, env, options = {}) {
  const url = `${env.SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    "apikey": env.SUPABASE_SERVICE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": options.prefer || "return=representation",
    ...options.headers,
  };

  const fetchOptions = { method, headers };
  if (body) fetchOptions.body = JSON.stringify(body);

  const response = await fetch(url, fetchOptions);
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

/**
 * Authorization ヘッダーの JWT から user_id を取得する。
 * Supabase Auth の /auth/v1/user エンドポイントでトークンを検証。
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<{user_id: string|null, email: string|null}>}
 */
async function getUserFromJWT(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return { user_id: null, email: null };

  const token = authHeader.slice(7);
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": env.SUPABASE_SERVICE_KEY,
      },
    });
    if (!res.ok) return { user_id: null, email: null };
    const user = await res.json();
    return { user_id: user.id || null, email: user.email || null };
  } catch {
    return { user_id: null, email: null };
  }
}

// ---------------------------------------------------------------------------
// Stripe helpers
// ---------------------------------------------------------------------------

/**
 * Stripe API へリクエストを送る。
 *
 * @param {string} path - Stripe API パス (例: "/checkout/sessions")
 * @param {string} method - HTTP メソッド
 * @param {URLSearchParams|null} body - application/x-www-form-urlencoded ボディ
 * @param {object} env
 * @returns {Promise<{ok: boolean, status: number, data: object}>}
 */
async function stripeRequest(path, method, body, env) {
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
  };

  if (body) {
    options.body = body.toString();
  }

  const response = await fetch(`${STRIPE_API_BASE}${path}`, options);
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

// ---------------------------------------------------------------------------
// POST /api/checkout
// ---------------------------------------------------------------------------

/**
 * Stripe Checkout Session を作成し、セッション URL を返す。
 *
 * Request body (JSON):
 *   { area: string, email?: string }
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handleCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return errorResponse("STRIPE_SECRET_KEY が設定されていません", 500);
  }
  if (!env.STRIPE_PRICE_ID) {
    return errorResponse("STRIPE_PRICE_ID が設定されていません", 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("リクエストボディが不正な JSON です", 400);
  }

  const { area, area_code, success_url, cancel_url } = body;

  if (!area || typeof area !== "string" || area.trim() === "") {
    return errorResponse("area フィールドは必須です", 400);
  }

  // JWTからuser_idを安全に取得（フロントエンドからのuser_idは信頼しない）
  const { user_id, email } = await getUserFromJWT(request, env);
  if (!user_id) {
    return errorResponse("認証が必要です。ログインしてください。", 401);
  }

  // success_url / cancel_url はリクエストボディから受け取る（フォールバック付き）
  const origin = request.headers.get("Origin") ?? "https://ai-fudosan.bantex.jp";
  const successUrl = success_url || `${origin}/?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = cancel_url || `${origin}/`;

  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Stripe API は application/x-www-form-urlencoded 形式
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price]", env.STRIPE_PRICE_ID);
  params.set("line_items[0][quantity]", "1");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("metadata[area]", area.trim());
  params.set("metadata[purchased_at]", timestamp);

  // JWTから取得したユーザーID・エリアコードをメタデータに追加
  params.set("metadata[user_id]", user_id);
  if (area_code) params.set("metadata[area_code]", area_code);

  // JWTから取得したメールアドレスをStripe Checkoutに事前入力
  if (email) {
    params.set("customer_email", email);
  }

  // 日本語対応・日本円固定
  params.set("locale", "ja");
  params.set("payment_method_types[0]", "card");

  let result;
  try {
    result = await stripeRequest("/checkout/sessions", "POST", params, env);
  } catch (err) {
    return errorResponse(`Stripe API への接続に失敗しました: ${err.message}`, 502);
  }

  if (!result.ok) {
    return jsonResponse(
      { error: "Stripe Checkout 作成エラー", detail: result.data },
      result.status
    );
  }

  return jsonResponse({
    session_id: result.data.id,
    url: result.data.url,
  });
}

// ---------------------------------------------------------------------------
// Stripe Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Stripe Webhook の署名を検証する。
 * Stripe の HMAC-SHA256 方式を Web Crypto API で実装。
 *
 * @param {string} payload - リクエストボディの生文字列
 * @param {string} sigHeader - Stripe-Signature ヘッダー値
 * @param {string} secret - Webhook シークレット (whsec_...)
 * @returns {Promise<{valid: boolean, timestamp: number|null}>}
 */
async function verifyStripeSignature(payload, sigHeader, secret) {
  // Stripe-Signature ヘッダーをパース
  // 形式: t=TIMESTAMP,v1=SIGNATURE1,v1=SIGNATURE2,...
  const parts = sigHeader.split(",").reduce((acc, part) => {
    const [key, value] = part.split("=");
    if (!acc[key]) acc[key] = [];
    acc[key].push(value);
    return acc;
  }, {});

  const timestamp = parts["t"]?.[0];
  const signatures = parts["v1"] ?? [];

  if (!timestamp || signatures.length === 0) {
    return { valid: false, timestamp: null };
  }

  // タイムスタンプが 5 分以内であることを確認（リプレイ攻撃対策）
  const tolerance = 300; // 5分
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > tolerance) {
    return { valid: false, timestamp: parseInt(timestamp, 10) };
  }

  // 署名対象文字列: "{timestamp}.{payload}"
  const signedPayload = `${timestamp}.${payload}`;

  // HMAC-SHA256 キーを生成
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // 署名を計算
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );

  // バッファを hex 文字列に変換
  const computedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // 受信した署名と比較（定数時間比較）
  const valid = signatures.some((sig) => {
    if (sig.length !== computedSignature.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) {
      diff |= sig.charCodeAt(i) ^ computedSignature.charCodeAt(i);
    }
    return diff === 0;
  });

  return { valid, timestamp: parseInt(timestamp, 10) };
}

// ---------------------------------------------------------------------------
// POST /api/webhook
// ---------------------------------------------------------------------------

/**
 * Stripe Webhook を受信し、購入完了時に KV へ保存する。
 *
 * @param {Request} request
 * @param {object} env
 * @param {ExecutionContext} ctx
 * @returns {Promise<Response>}
 */
async function handleWebhook(request, env, ctx) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return errorResponse("STRIPE_WEBHOOK_SECRET が設定されていません", 500);
  }
  if (!env.PURCHASES) {
    return errorResponse("KV バインディング PURCHASES が設定されていません", 500);
  }

  const sigHeader = request.headers.get("stripe-signature");
  if (!sigHeader) {
    return errorResponse("stripe-signature ヘッダーがありません", 400);
  }

  // ボディを生テキストで取得（署名検証に必要）
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return errorResponse("リクエストボディの読み取りに失敗しました", 400);
  }

  // 署名検証
  const { valid } = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return errorResponse("Stripe Webhook 署名が不正です", 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return errorResponse("Webhook ボディが不正な JSON です", 400);
  }

  // checkout.session.completed イベントのみ処理
  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;

    if (!session) {
      return errorResponse("イベントデータが不正です", 400);
    }

    // payment_status が "paid" の場合のみ処理（HIGH-02修正）
    if (session.payment_status !== "paid") {
      console.log(`[Webhook] payment_status=${session.payment_status} のためスキップ`);
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const sessionId = session.id;
    const area = session.metadata?.area ?? "";
    const areaCode = session.metadata?.area_code ?? "";
    const userId = session.metadata?.user_id ?? null;
    const paymentIntentId = session.payment_intent ?? null;
    const purchasedAt = session.metadata?.purchased_at
      ? parseInt(session.metadata.purchased_at, 10)
      : Math.floor(Date.now() / 1000);
    const email = session.customer_details?.email ?? session.customer_email ?? null;

    const purchaseRecord = {
      session_id: sessionId,
      area,
      email,
      purchased_at: purchasedAt,
      purchased_at_iso: new Date(purchasedAt * 1000).toISOString(),
    };

    // KV + Supabase DB への書き込みはバックグラウンドで実行
    ctx.waitUntil(
      (async () => {
        // 1. KV に保存（既存処理）
        try {
          await env.PURCHASES.put(
            `purchase:${sessionId}`,
            JSON.stringify(purchaseRecord)
          );

          if (email) {
            const userKey = `user:${email}`;
            const existing = await env.PURCHASES.get(userKey, { type: "json" });
            const userRecord = existing ?? { purchases: [] };
            const alreadyExists = userRecord.purchases.some(
              (p) => p.session_id === sessionId
            );
            if (!alreadyExists) {
              userRecord.purchases.push({
                area,
                purchased_at: purchasedAt,
                purchased_at_iso: purchaseRecord.purchased_at_iso,
                session_id: sessionId,
              });
              await env.PURCHASES.put(userKey, JSON.stringify(userRecord));
            }
          }
        } catch (err) {
          console.error("KV 書き込みエラー:", err.message);
        }

        // 2. Supabase DB に保存（user_id がある場合のみ）
        if (userId && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
          try {
            await supabaseRequest("/purchases", "POST", {
              user_id: userId,
              area_code: areaCode || "unknown",
              area_name: area,
              stripe_session_id: sessionId,
              stripe_payment_intent_id: paymentIntentId,
              amount: 150,
            }, env, {
              // 重複を無視（同一 stripe_session_id は UNIQUE 制約）
              headers: { "Prefer": "return=minimal" },
              prefer: "return=minimal",
            });
          } catch (err) {
            console.error("Supabase 書き込みエラー:", err.message);
          }
        }
      })()
    );
  }

  // Stripe には必ず 200 を返す（200 以外は再送される）
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /api/purchases?session_id=xxx
// ---------------------------------------------------------------------------

/**
 * 購入確認エンドポイント。
 * Stripe の Checkout Session を取得し、KV の購入情報と合わせて返す。
 *
 * フロントエンドは success_url へリダイレクトされた後、このエンドポイントを呼ぶ。
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
async function handlePurchases(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return errorResponse("STRIPE_SECRET_KEY が設定されていません", 500);
  }
  if (!env.PURCHASES) {
    return errorResponse("KV バインディング PURCHASES が設定されていません", 500);
  }

  // JWT認証ゲート（CRITICAL-03修正）
  const { user_id: requestingUserId } = await getUserFromJWT(request, env);
  if (!requestingUserId) {
    return errorResponse("認証が必要です", 401);
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId) {
    return errorResponse("session_id クエリパラメータは必須です", 400);
  }

  // KV から購入情報を取得
  let kvRecord = null;
  try {
    kvRecord = await env.PURCHASES.get(`purchase:${sessionId}`, { type: "json" });
  } catch (err) {
    console.error("KV 読み取りエラー:", err.message);
  }

  // KV に存在しない場合は Stripe から直接セッション情報を取得
  // （Webhook が未到着の場合のフォールバック）
  let stripeSession = null;
  if (!kvRecord) {
    let result;
    try {
      result = await stripeRequest(
        `/checkout/sessions/${sessionId}?expand[]=customer_details`,
        "GET",
        null,
        env
      );
    } catch (err) {
      return errorResponse(`Stripe API への接続に失敗しました: ${err.message}`, 502);
    }

    if (!result.ok) {
      return jsonResponse(
        { error: "Stripe セッション取得エラー", detail: result.data },
        result.status
      );
    }

    stripeSession = result.data;

    // セッションの支払いが完了している場合のみ有効とする
    if (stripeSession.payment_status !== "paid") {
      return jsonResponse({ purchased: false, payment_status: stripeSession.payment_status });
    }

    // KV に見つからなかったが Stripe では paid → KV + DB に保存しておく
    const area = stripeSession.metadata?.area ?? "";
    const areaCode = stripeSession.metadata?.area_code ?? "";
    const userId = stripeSession.metadata?.user_id ?? null;
    const paymentIntentId = stripeSession.payment_intent ?? null;
    const purchasedAt = stripeSession.metadata?.purchased_at
      ? parseInt(stripeSession.metadata.purchased_at, 10)
      : Math.floor(Date.now() / 1000);
    const email =
      stripeSession.customer_details?.email ?? stripeSession.customer_email ?? null;

    kvRecord = {
      session_id: sessionId,
      area,
      email,
      purchased_at: purchasedAt,
      purchased_at_iso: new Date(purchasedAt * 1000).toISOString(),
    };

    // KV に保存
    try {
      await env.PURCHASES.put(`purchase:${sessionId}`, JSON.stringify(kvRecord));
    } catch (err) {
      console.error("KV フォールバック書き込みエラー:", err.message);
    }

    // Supabase DB にも保存（user_id がある場合）
    if (userId && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
      try {
        await supabaseRequest("/purchases", "POST", {
          user_id: userId,
          area_code: areaCode || "unknown",
          area_name: area,
          stripe_session_id: sessionId,
          stripe_payment_intent_id: paymentIntentId,
          amount: 150,
        }, env, {
          headers: { "Prefer": "return=minimal" },
          prefer: "return=minimal",
        });
      } catch (err) {
        console.error("Supabase フォールバック書き込みエラー:", err.message);
      }
    }
  }

  return jsonResponse({
    purchased: true,
    session_id: kvRecord.session_id,
    area: kvRecord.area,
    email: kvRecord.email,
    purchased_at: kvRecord.purchased_at,
    purchased_at_iso: kvRecord.purchased_at_iso,
  });
}

// ---------------------------------------------------------------------------
// Analysis Data API (DB保存・読み出し)
// ---------------------------------------------------------------------------

/**
 * 分析データをDBに保存する。
 */
async function handleSaveAnalysisData(request, env) {
  const { user_id } = await getUserFromJWT(request, env);
  if (!user_id) return errorResponse("認証が必要です", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("リクエストボディが不正です", 400);
  }

  const { area_name, analysis_data } = body;
  if (!area_name || !analysis_data) {
    return errorResponse("area_name と analysis_data は必須です", 400);
  }

  // 入力バリデーション（CRITICAL-05修正）
  if (typeof area_name !== 'string' || area_name.length > 100 || /[&=<>'"\\]/.test(area_name)) {
    return errorResponse("area_name に使用できない文字が含まれています", 400);
  }
  const dataStr = JSON.stringify(analysis_data);
  if (dataStr.length > 500000) {
    return errorResponse("analysis_data が大きすぎます", 413);
  }

  const result = await supabaseRequest(
    `/purchases?user_id=eq.${user_id}&area_name=eq.${encodeURIComponent(area_name)}`,
    "PATCH",
    { analysis_data },
    env,
    { prefer: "return=representation" }
  );

  if (!result.ok) {
    return errorResponse("データ保存エラー", 500);
  }

  return jsonResponse({ saved: true });
}

/**
 * 保存済みの分析データをDBから取得する。
 */
async function handleGetAnalysisData(request, env) {
  const { user_id } = await getUserFromJWT(request, env);
  if (!user_id) return errorResponse("認証が必要です", 401);

  const url = new URL(request.url);
  const areaName = url.searchParams.get("area_name");
  if (!areaName) return errorResponse("area_name は必須です", 400);

  const result = await supabaseRequest(
    `/purchases?user_id=eq.${user_id}&area_name=eq.${encodeURIComponent(areaName)}&select=analysis_data,purchased_at&order=purchased_at.desc&limit=1`,
    "GET",
    null,
    env
  );

  if (!result.ok || !result.data || result.data.length === 0) {
    return jsonResponse({ found: false });
  }

  const row = result.data[0];
  if (!row.analysis_data) {
    return jsonResponse({ found: false });
  }

  return jsonResponse({
    found: true,
    analysis_data: row.analysis_data,
    purchased_at: row.purchased_at,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * メインのリクエストハンドラ。
 * URL パスに基づいて各ハンドラへルーティングする。
 *
 * @param {Request} request
 * @param {object} env
 * @param {ExecutionContext} ctx
 * @returns {Promise<Response>}
 */
async function router(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // CORS プリフライト
  if (method === "OPTIONS") {
    return handleOptions();
  }

  // ルーティングテーブル
  // POST /api/gemini
  if (path === "/api/gemini" && method === "POST") {
    return handleGemini(request, env);
  }

  // GET /api/estat/population
  if (path === "/api/estat/population" && method === "GET") {
    return handleEstatPopulation(request, env);
  }

  // GET /api/estat/housing
  if (path === "/api/estat/housing" && method === "GET") {
    return handleEstatHousing(request, env);
  }

  // GET /api/estat/query
  if (path === "/api/estat/query" && method === "GET") {
    return handleEstatQuery(request, env);
  }

  // POST /api/checkout
  if (path === "/api/checkout" && method === "POST") {
    return handleCheckout(request, env);
  }

  // POST /api/webhook
  if (path === "/api/webhook" && method === "POST") {
    return handleWebhook(request, env, ctx);
  }

  // GET /api/purchases
  if (path === "/api/purchases" && method === "GET") {
    return handlePurchases(request, env);
  }

  // POST /api/purchases/save-data - 分析データをDBに保存
  if (path === "/api/purchases/save-data" && method === "POST") {
    return handleSaveAnalysisData(request, env);
  }

  // GET /api/purchases/data - 保存済みの分析データを取得
  if (path === "/api/purchases/data" && method === "GET") {
    return handleGetAnalysisData(request, env);
  }

  // 404
  return jsonResponse({ error: `未定義のルート: ${method} ${path}` }, 404);
}

// ---------------------------------------------------------------------------
// Entry point (Cloudflare Workers Module syntax)
// ---------------------------------------------------------------------------

export default {
  /**
   * @param {Request} request
   * @param {object} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    try {
      return await router(request, env, ctx);
    } catch (err) {
      // 予期しないエラーをキャッチしてログ出力
      console.error("予期しないエラー:", err.message, err.stack);
      return errorResponse("内部サーバーエラーが発生しました", 500);
    }
  },
};
