// ========================================
// AI不動産市場レポート v2.0
// エリア入力 → 政府統計 + AI分析 → プレビュー/課金
// ========================================

// ---- Config ----
var WORKER_BASE = 'https://house-search-proxy.ai-fudosan.workers.dev';
// Stripe SDK は不要（CRITICAL-01修正: window.location.href でリダイレクト）
var SUPABASE_URL = 'https://ypyrjsdotkeyvzequdez.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_l5yNWlXOZAHABwlbEalGng_R8zioydf';
var supabaseClient = null;
var currentUser = null;

// ---- Prefecture Codes ----
var PREFECTURE_CODES = {
  '北海道':'01','青森県':'02','岩手県':'03','宮城県':'04','秋田県':'05',
  '山形県':'06','福島県':'07','茨城県':'08','栃木県':'09','群馬県':'10',
  '埼玉県':'11','千葉県':'12','東京都':'13','神奈川県':'14','新潟県':'15',
  '富山県':'16','石川県':'17','福井県':'18','山梨県':'19','長野県':'20',
  '岐阜県':'21','静岡県':'22','愛知県':'23','三重県':'24','滋賀県':'25',
  '京都府':'26','大阪府':'27','兵庫県':'28','奈良県':'29','和歌山県':'30',
  '鳥取県':'31','島根県':'32','岡山県':'33','広島県':'34','山口県':'35',
  '徳島県':'36','香川県':'37','愛媛県':'38','高知県':'39','福岡県':'40',
  '佐賀県':'41','長崎県':'42','熊本県':'43','大分県':'44','宮崎県':'45',
  '鹿児島県':'46','沖縄県':'47'
};

// ---- State ----
var analysisData = null;
var currentArea = null;
var isPurchased = false;
var _analysisRunning = false;

// ---- DOM References ----
var areaInput = document.getElementById('area-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorMsg = document.getElementById('error-msg');
var progressSection = document.getElementById('progress-section');
var resultsSection = document.getElementById('results-section');
var resultsContent = document.getElementById('results-content');
var progressLogContent = document.getElementById('progress-log-content');

// ---- On Load: Check for Stripe redirect ----
var _pendingVerifySessionId = null;

(function checkPurchaseReturn() {
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get('session_id');
  if (sessionId) {
    // sessionStorageから分析データを復元（決済前に保存したもの）
    try {
      var savedAnalysis = sessionStorage.getItem('ai_fudosan_pendingAnalysis');
      var savedArea = sessionStorage.getItem('ai_fudosan_pendingArea');
      if (savedAnalysis && savedArea) {
        analysisData = JSON.parse(savedAnalysis);
        currentArea = JSON.parse(savedArea);
      }
    } catch (e) { /* ignore */ }
    // 認証完了を待ってからverifyPurchaseを実行（CRITICAL-02修正）
    _pendingVerifySessionId = sessionId;
    // URLをクリーンアップ
    window.history.replaceState({}, '', window.location.pathname);
  }

  // オートコンプリート初期化
  initAutocomplete();

  // Supabase認証初期化
  initSupabase();
})();

// ---- Autocomplete ----
function initAutocomplete() {
  var input = document.getElementById('area-input');
  var dropdown = document.getElementById('autocomplete-dropdown');
  var selectedIdx = -1;
  var currentItems = [];

  input.addEventListener('input', function() {
    if (input.disabled) return;
    var query = input.value.trim();
    if (query.length < 1) {
      dropdown.style.display = 'none';
      return;
    }

    currentItems = searchArea(query);
    selectedIdx = -1;

    if (currentItems.length === 0) {
      dropdown.style.display = 'none';
      return;
    }

    dropdown.innerHTML = '';
    currentItems.forEach(function(area, idx) {
      var item = document.createElement('div');
      item.className = 'autocomplete-item';
      var highlighted = highlightMatch(area.fullLabel, query);
      item.innerHTML = '<span class="autocomplete-item__icon">' + (area.type === 'prefecture' ? '🗾' : '📍') + '</span>' +
        '<div><div class="autocomplete-item__name">' + highlighted + '</div>' +
        '<div class="autocomplete-item__type">' + (area.type === 'prefecture' ? '都道府県' : '市区町村') + '</div></div>';
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        selectItem(area);
      });
      dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
  });

  input.addEventListener('keydown', function(e) {
    if (dropdown.style.display !== 'block' || currentItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, currentItems.length - 1);
      highlightItem();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, -1);
      highlightItem();
    } else if (e.key === 'Enter') {
      if (selectedIdx >= 0 && selectedIdx < currentItems.length) {
        e.preventDefault();
        selectItem(currentItems[selectedIdx]);
      }
    } else if (e.key === 'Escape') {
      dropdown.style.display = 'none';
    }
  });

  input.addEventListener('blur', function() {
    setTimeout(function() { dropdown.style.display = 'none'; }, 150);
  });

  function highlightItem() {
    var items = dropdown.querySelectorAll('.autocomplete-item');
    items.forEach(function(el, i) {
      el.classList.toggle('is-selected', i === selectedIdx);
    });
  }

  function selectItem(area) {
    input.value = area.fullLabel;
    dropdown.style.display = 'none';
    // ボタン押下で分析開始に統一（即時分析しない）
  }
}

// ---- Supabase Auth ----
var _pendingCheckout = false;

function initSupabase() {
  if (typeof supabase !== 'undefined' && supabase.createClient) {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    // onAuthStateChangeのみで管理（INITIAL_SESSIONイベントで初期セッションも通知される）
    supabaseClient.auth.onAuthStateChange(function(event, session) {
      currentUser = session ? session.user : null;
      updateAuthUI();
      // ログイン完了後にGoogleリダイレクトやログインモーダルを処理
      if (event === 'SIGNED_IN') {
        var modal = document.getElementById('login-modal');
        if (modal && modal.classList.contains('active')) {
          modal.classList.remove('active');
        }
        // ログイン後に購入フローを自動再開
        if (_pendingCheckout && currentArea) {
          _pendingCheckout = false;
          _doCheckout();
        }
      }
      // パスワードリセットリンクからのリダイレクト検知
      if (event === 'PASSWORD_RECOVERY') {
        var newPass = prompt('新しいパスワードを入力してください（6文字以上）');
        if (newPass && newPass.length >= 6) {
          supabaseClient.auth.updateUser({ password: newPass }).then(function(res) {
            if (res.error) alert('パスワード変更エラー: ' + res.error.message);
            else alert('パスワードを変更しました。ログイン済みです。');
          });
        }
      }
      // 認証完了後にStripe決済戻りの購入確認を実行（CRITICAL-02修正）
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && _pendingVerifySessionId) {
        // INITIAL_SESSION で未ログイン → ログインを促す
        if (event === 'INITIAL_SESSION' && !session) {
          showLoginModal();
          return;
        }
        var sid = _pendingVerifySessionId;
        _pendingVerifySessionId = null;
        verifyPurchase(sid);
      }
    });
  } else {
    console.warn('[Auth] Supabase SDK not loaded');
  }
}

function updateAuthUI() {
  var authArea = document.getElementById('auth-area');
  if (!authArea) return;
  if (currentUser) {
    var email = currentUser.email || '';
    var displayName = email.split('@')[0];
    authArea.innerHTML = '<span class="auth-user">\uD83D\uDC64 ' + escapeHtml(displayName) + '</span>' +
      '<button class="header__history-btn" onclick="showHistoryModal()">📋 履歴</button>' +
      '<button class="auth-logout-btn" onclick="logoutUser()">ログアウト</button>';
  } else {
    authArea.innerHTML = '<button class="auth-login-btn" onclick="showLoginModal()">🔑 ログイン</button>';
  }
}

function showLoginModal() {
  document.getElementById('login-modal').classList.add('active');
  // デフォルトはログインモード
  switchAuthMode('login');
}

function switchAuthMode(mode) {
  var isLogin = (mode === 'login');
  document.getElementById('auth-mode-title').textContent = isLogin ? 'ログイン' : '新規登録';
  document.getElementById('auth-submit-btn').textContent = isLogin ? 'ログイン' : '登録する';
  document.getElementById('auth-switch-text').innerHTML = isLogin ?
    'アカウントをお持ちでない方は <a href="#" onclick="switchAuthMode(\'signup\'); return false;">新規登録</a>' :
    'すでにアカウントをお持ちの方は <a href="#" onclick="switchAuthMode(\'login\'); return false;">ログイン</a>';
  document.getElementById('auth-error').textContent = '';
  // パスワードリセットモードからの復帰
  document.getElementById('auth-password').style.display = '';
  var forgotEl = document.getElementById('auth-forgot');
  if (forgotEl) forgotEl.style.display = isLogin ? '' : 'none';
  // 現在のモードをdata属性に保持
  document.getElementById('auth-form').dataset.mode = mode;
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) { alert('認証システムを初期化中です。少々お待ちください。'); return; }

  var email = document.getElementById('auth-email').value.trim();
  var password = document.getElementById('auth-password').value;
  var errorEl = document.getElementById('auth-error');
  var submitBtn = document.getElementById('auth-submit-btn');
  var mode = document.getElementById('auth-form').dataset.mode || 'login';

  if (!email || !password) { errorEl.textContent = 'メールアドレスとパスワードを入力してください'; return; }
  if (password.length < 6) { errorEl.textContent = 'パスワードは6文字以上で入力してください'; return; }

  submitBtn.disabled = true;
  submitBtn.textContent = '処理中...';
  errorEl.textContent = '';

  try {
    var result;
    if (mode === 'reset') {
      // パスワードリセットメール送信
      result = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname
      });
      if (result.error) throw result.error;
      errorEl.style.color = '#10b981';
      errorEl.textContent = 'リセットメールを送信しました。メールのリンクからパスワードを再設定してください。';
      return;
    } else if (mode === 'login') {
      result = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
    } else {
      result = await supabaseClient.auth.signUp({ email: email, password: password });
    }

    if (result.error) throw result.error;

    // 成功 → モーダルを閉じる
    document.getElementById('login-modal').classList.remove('active');
    document.getElementById('auth-form').reset();

  } catch (err) {
    var msg = err.message || '認証エラーが発生しました';
    // よくあるエラーメッセージを日本語化
    if (msg.includes('Invalid login')) msg = 'メールアドレスまたはパスワードが正しくありません';
    if (msg.includes('already registered')) msg = 'このメールアドレスは既に登録されています';
    if (msg.includes('Email not confirmed')) msg = 'メールアドレスが未確認です';
    errorEl.style.color = '';
    errorEl.textContent = msg;
  } finally {
    submitBtn.disabled = false;
    if (mode === 'reset') submitBtn.textContent = 'リセットメールを送信';
    else submitBtn.textContent = (mode === 'login') ? 'ログイン' : '登録する';
  }
}

async function loginWithGoogle() {
  if (!supabaseClient) return;
  var result = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (result.error) {
    document.getElementById('auth-error').textContent = result.error.message || 'Googleログインエラー';
  }
}

async function logoutUser() {
  if (!supabaseClient) return;
  // signOut()がonAuthStateChangeをトリガーし、currentUser=null + updateAuthUI()が自動実行される
  await supabaseClient.auth.signOut();
}

function showPasswordReset() {
  document.getElementById('auth-mode-title').textContent = 'パスワードリセット';
  document.getElementById('auth-password').style.display = 'none';
  document.getElementById('auth-submit-btn').textContent = 'リセットメールを送信';
  document.getElementById('auth-forgot').style.display = 'none';
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-form').dataset.mode = 'reset';
  document.getElementById('auth-switch-text').innerHTML =
    '<a href="#" onclick="switchAuthMode(\'login\'); return false;">ログインに戻る</a>';
}


// ---- Gemini API via Worker Proxy ----
var _lastGeminiCall = 0;
var _geminiMinInterval = 6000;

async function callGemini(prompt) {
  var now = Date.now();
  var elapsed = now - _lastGeminiCall;
  if (_lastGeminiCall > 0 && elapsed < _geminiMinInterval) {
    var waitMs = _geminiMinInterval - elapsed;
    addLog('  ⏳ API間隔調整 ' + Math.ceil(waitMs/1000) + '秒...', 'info');
    await new Promise(function(r) { setTimeout(r, waitMs); });
  }
  _lastGeminiCall = Date.now();

  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var res = await fetch(WORKER_BASE + '/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt })
    });

    if (res.status === 429 && attempt < maxRetries) {
      var waitSec = 10 * (attempt + 1);
      addLog('  API制限検知、' + waitSec + '秒後にリトライ... (' + (attempt + 1) + '/' + maxRetries + ')', 'info');
      await new Promise(function(r) { setTimeout(r, waitSec * 1000); });
      _lastGeminiCall = Date.now();
      continue;
    }

    var data = await res.json();
    if (!res.ok) {
      var errMessage = (data.error && typeof data.error === 'string') ? data.error : (data.error && data.error.message) || ('API Error: ' + res.status);
      throw new Error(errMessage);
    }
    return data.text || '';
  }
  // リトライ上限に達した場合
  throw new Error('AI APIが混雑しています。しばらくしてから再度お試しください。');
}

// ---- e-Stat API via Worker Proxy ----
async function fetchEstatPopulation(prefecture, city) {
  var prefCode = PREFECTURE_CODES[prefecture];
  if (!prefCode) return null;

  addLog('政府統計APIから人口データを取得中...', 'info');
  try {
    var url = WORKER_BASE + '/api/estat/population?statsDataId=0003448233&cdArea=' + prefCode + '000&limit=100';
    var res = await fetch(url);
    if (!res.ok) throw new Error('e-Stat API HTTP ' + res.status);
    var data = await res.json();

    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      url = WORKER_BASE + '/api/estat/population?statsDataId=0003448233&cdArea=' + prefCode + '&limit=100';
      res = await fetch(url);
      data = await res.json();
      result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    }

    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      addLog('該当データがありません。AI推計に切り替えます。', 'info');
      return null;
    }

    var values = result.DATA_INF.VALUE;
    var population = null;
    var households = null;

    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var val = parseInt(v.$, 10);
      if (isNaN(val)) continue;
      if (v['@tab'] === '020' || (v['@cat01'] && v['@cat01'].indexOf('0010') >= 0)) {
        if (!population || val > 100) population = val;
      }
      if (v['@tab'] === '040' || (v['@cat01'] && v['@cat01'].indexOf('0020') >= 0)) {
        if (!households || val > 100) households = val;
      }
    }

    if (population) {
      addLog('人口データ取得成功 (' + formatNumber(population) + '人)', 'success');
      return { total_population: population, households: households || Math.round(population / 2.3), source: 'e-Stat 国勢調査', from_estat: true };
    }
    return null;
  } catch (e) {
    console.warn('[e-Stat] Error:', e);
    addLog('統計API接続エラー: ' + e.message + '。AI推計に切り替えます。', 'info');
    return null;
  }
}

async function fetchEstatHousing(prefecture) {
  var prefCode = PREFECTURE_CODES[prefecture];
  if (!prefCode) return null;
  try {
    var url = WORKER_BASE + '/api/estat/housing?statsDataId=0003445078&cdArea=' + prefCode + '&limit=50';
    var res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    var data = await res.json();
    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) return null;
    var values = result.DATA_INF.VALUE;
    var totalHousing = 0;
    for (var i = 0; i < values.length; i++) {
      var val = parseInt(values[i].$, 10);
      if (!isNaN(val) && val > totalHousing) totalHousing = val;
    }
    if (totalHousing > 0) {
      addLog('住宅統計データ取得成功', 'success');
      return { total_housing: totalHousing, source: 'e-Stat 住宅・土地統計', from_estat: true };
    }
    return null;
  } catch (e) { return null; }
}

async function fetchEstatConstruction(prefecture) {
  var prefCode = PREFECTURE_CODES[prefecture];
  if (!prefCode) return null;
  try {
    var url = WORKER_BASE + '/api/estat/query?statsDataId=0003400728&cdArea=' + prefCode + '&limit=200';
    var res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    var data = await res.json();
    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) return null;
    var values = result.DATA_INF.VALUE;
    var totals = { total: 0, owner: 0, rental: 0, sale: 0 };
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var val = parseInt(v.$, 10);
      if (isNaN(val) || val <= 0) continue;
      var cat = v['@cat01'] || '';
      if (cat.indexOf('001') >= 0 && !totals.total) totals.total = val;
      if (cat.indexOf('002') >= 0 && !totals.owner) totals.owner = val;
      if (cat.indexOf('003') >= 0 && !totals.rental) totals.rental = val;
      if (cat.indexOf('004') >= 0 && !totals.sale) totals.sale = val;
    }
    if (totals.total > 0) {
      addLog('建築着工統計データ取得成功', 'success');
      return { total: totals.total, owner: totals.owner, rental: totals.rental, sale: totals.sale, source: '建築着工統計', from_estat: true };
    }
    return null;
  } catch (e) { return null; }
}

async function fetchEstatHousingDetail(prefecture) {
  var prefCode = PREFECTURE_CODES[prefecture];
  if (!prefCode) return null;
  try {
    var url = WORKER_BASE + '/api/estat/query?statsDataId=0003445083&cdArea=' + prefCode + '&limit=200';
    var res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    var data = await res.json();
    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) return null;
    var values = result.DATA_INF.VALUE;
    var detail = { owned: 0, rented: 0, apartment: 0, detached: 0, total: 0 };
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var val = parseInt(v.$, 10);
      if (isNaN(val) || val <= 0) continue;
      var cat = (v['@cat01'] || '') + (v['@cat02'] || '');
      if (val > detail.total) detail.total = val;
      if (cat.indexOf('010') >= 0 && val > detail.owned) detail.owned = val;
      if (cat.indexOf('020') >= 0 && val > detail.rented) detail.rented = val;
      if (cat.indexOf('030') >= 0 && val > detail.apartment) detail.apartment = val;
      if (cat.indexOf('040') >= 0 && val > detail.detached) detail.detached = val;
    }
    if (detail.total > 0) {
      addLog('住宅詳細統計データ取得成功', 'success');
      return { owned: detail.owned, rented: detail.rented, apartment: detail.apartment, detached: detail.detached, total: detail.total, source: '住宅・土地統計詳細', from_estat: true };
    }
    return null;
  } catch (e) { return null; }
}

// ---- Logging ----
function addLog(message, type) {
  var div = document.createElement('div');
  div.className = 'log-item' + (type ? ' log-item--' + type : '');
  div.textContent = message;
  progressLogContent.appendChild(div);
  progressLogContent.scrollTop = progressLogContent.scrollHeight;
}

function clearLogs() {
  progressLogContent.innerHTML = '';
}

// ---- Analysis Flow ----
async function startAnalysis() {
  var input = areaInput.value.trim();
  if (!input) { showError('エリア名を入力してください'); return; }

  hideError();
  var candidates = searchArea(input);

  if (candidates.length === 0) {
    showError('「' + input + '」に一致するエリアが見つかりません。都道府県名や市区町村名を入力してください。');
    return;
  }

  if (candidates.length === 1) {
    runAreaAnalysis(candidates[0]);
    return;
  }

  // 複数候補 → 選択モーダル
  showAreaSelectModal(candidates);
}

function showAreaSelectModal(candidates) {
  var listEl = document.getElementById('area-select-list');
  listEl.innerHTML = '';

  candidates.forEach(function(area) {
    var btn = document.createElement('button');
    btn.className = 'area-select-btn';
    btn.innerHTML = '<span style="font-size:20px;">📍</span>' +
      '<div><div style="font-weight:700;">' + escapeHtml(area.fullLabel) + '</div>' +
      '<div style="font-size:11px; color:var(--text-muted);">' + (area.type === 'prefecture' ? '都道府県' : '市区町村') + '</div></div>';

    btn.addEventListener('click', function() {
      document.getElementById('area-select-modal').classList.remove('active');
      runAreaAnalysis(area);
    });
    listEl.appendChild(btn);
  });

  document.getElementById('area-select-modal').classList.add('active');
}

// ---- Main Analysis ----
async function runAreaAnalysis(area) {
  if (_analysisRunning) return;
  _analysisRunning = true;
  currentArea = area;
  isPurchased = await isAreaPurchasedAsync(area.fullLabel);

  // 購入済みかつDBにデータがあれば即表示（再分析不要）
  if (isPurchased && currentUser) {
    var dbData = await _loadAnalysisDataFromDB(area.fullLabel);
    if (dbData) {
      analysisData = dbData;
      document.getElementById('purchase-prompt').style.display = 'none';
      renderResults(analysisData, true);
      showResults();
      _analysisRunning = false;
      return;
    }
  }

  hideError();
  hideResults();
  showProgress();
  setLoading(true);
  clearLogs();

  addLog('🏠 不動産エリア分析を開始します...', 'info');
  addLog('対象エリア: ' + area.fullLabel, 'info');

  try {
    // Step 1: 統計データ取得
    activateStep('step-data');

    addLog('  政府統計APIから人口データを取得中...', 'info');
    var estatPop = await fetchEstatPopulation(area.prefecture, area.city);

    addLog('  政府統計APIから住宅データを取得中...', 'info');
    var estatHousing = await fetchEstatHousing(area.prefecture);

    addLog('  建築着工統計を取得中...', 'info');
    var estatConstruction = await fetchEstatConstruction(area.prefecture);

    addLog('  住宅詳細統計を取得中...', 'info');
    var estatHousingDetail = await fetchEstatHousingDetail(area.prefecture);

    completeStep('step-data');

    // Step 2: AI市場分析
    activateStep('step-ai');
    addLog('AIが市場データを分析中...', 'info');

    var areaForPrompt = {
      label: area.fullLabel,
      prefecture: area.prefecture,
      city: area.city,
      isHQ: true
    };
    var dummyAnalysis = {
      company: { name: area.fullLabel + ' エリア分析', business_type: '不動産・住宅', is_real_estate: true },
      location: { prefecture: area.prefecture, city: area.city }
    };

    var marketPrompt = buildMarketPrompt(dummyAnalysis, estatPop, estatHousing, areaForPrompt, estatConstruction, estatHousingDetail);
    var marketRaw = await callGemini(marketPrompt);
    var marketData = parseJSON(marketRaw);

    // e-Stat実データで上書き
    if (estatPop && estatPop.from_estat) {
      if (!marketData.population) marketData.population = {};
      marketData.population.total_population = estatPop.total_population;
      marketData.population.households = estatPop.households;
      marketData.population.source = estatPop.source;
    }

    addLog('→ ' + area.fullLabel + ' 分析完了', 'success');
    completeStep('step-ai');

    // Step 3: レポート生成
    activateStep('step-report');
    addLog('レポート生成中...', 'info');

    analysisData = {
      area: area,
      market: marketData,
      timestamp: new Date().toISOString(),
      data_source: '政府統計 + AI'
    };

    renderResults(analysisData, isPurchased);
    completeStep('step-report');
    addLog('✅ エリア分析完了！', 'success');

    hideProgress();
    showResults();

    // 購入済みエリアなら分析データをDBにも保存（履歴から再分析不要にする）
    if (isPurchased && currentUser) {
      _saveAnalysisDataToDB(area.fullLabel, analysisData);
    }

  } catch (err) {
    addLog('エラー: ' + err.message, 'error');
    showError(err.message);
  } finally {
    setLoading(false);
    _analysisRunning = false;
  }
}

// ---- Build Market Prompt ----
function buildMarketPrompt(analysis, estatPop, estatHousing, area, estatConstruction, estatHousingDetail) {
  var company = analysis.company || {};
  var pref = area.prefecture || '不明';
  var city = area.city || '';

  var estatInfo = '';
  if (estatPop && estatPop.from_estat) {
    estatInfo += '\n\n【参考: 政府統計実データ】\n' +
      '・総人口: ' + formatNumber(estatPop.total_population) + '人\n' +
      '・世帯数: ' + formatNumber(estatPop.households) + '世帯\n';
  }
  if (estatConstruction && estatConstruction.from_estat) {
    estatInfo += '【建築着工統計（実データ）】\n' +
      '・新設住宅着工総数: ' + formatNumber(estatConstruction.total) + '戸\n' +
      '・持家: ' + formatNumber(estatConstruction.owner) + '戸\n' +
      '・貸家: ' + formatNumber(estatConstruction.rental) + '戸\n' +
      '・分譲: ' + formatNumber(estatConstruction.sale) + '戸\n';
  }
  if (estatHousingDetail && estatHousingDetail.from_estat) {
    estatInfo += '【住宅・土地統計（実データ）】\n' +
      '・住宅総数: ' + formatNumber(estatHousingDetail.total) + '戸\n' +
      '・持家: ' + formatNumber(estatHousingDetail.owned) + '戸\n' +
      '・借家: ' + formatNumber(estatHousingDetail.rented) + '戸\n' +
      '・共同住宅: ' + formatNumber(estatHousingDetail.apartment) + '戸\n' +
      '・一戸建: ' + formatNumber(estatHousingDetail.detached) + '戸\n';
  }
  if (estatInfo) {
    estatInfo += 'これらの実データを基準にして、他の項目も整合性のある値を推定してください。\n';
  }

  return 'あなたは日本の不動産市場データの専門家です。\n' +
    '以下の地域の不動産市場データを、あなたの知識をもとに推定・提供してください。\n\n' +
    '対象エリア: ' + pref + ' ' + city + '\n' +
    '企業の事業: ' + (company.business_type || '不明') + '\n' +
    estatInfo + '\n' +
    'できる限り正確な数値を提供してください。正確な数値が不明な場合は、合理的な推計値を「推計」と明記して提供してください。\n\n' +
    '重要: "market_summary"フィールドには、このエリアの不動産市場の特徴・動向・展望を1000文字程度の日本語テキストで詳しく記述してください。' +
    '地価の傾向、住宅需要の特徴、主な開発動向、人口動態の影響、投資環境、競合状況など具体的に書いてください。\n\n' +
    '【重要: 数値の単位ルール】\n' +
    '- 金額が「万円」表記の項目: 万円単位の数値を入れる（例: 3000万円なら 3000）\n' +
    '- 金額が「億円」表記の項目: 億円単位の数値を入れる（例: 80億円なら 80）\n' +
    '- 金額が「円」表記の項目: 円単位の数値を入れる（例: 15万円/㎡なら 150000）\n' +
    '- 戸数・人数・世帯数: そのままの数値（例: 1500戸なら 1500）\n' +
    '- パーセント: 数値のみ（例: 65.3%なら 65.3）\n\n' +
    '以下のJSON形式で回答してください。マークダウンのコードブロックで囲まず、純粋JSONのみ返してください:\n' +
    '{\n' +
    '  "area_name": "' + pref + ' ' + city + '",\n' +
    '  "market_summary": "（このエリアの不動産市場の特徴・動向・展望を1000文字程度で記述）",\n' +
    '  "population": {\n' +
    '    "total_population": 0,\n' +
    '    "households": 0,\n' +
    '    "age_30_45_pct": 0,\n' +
    '    "elderly_pct": 0,\n' +
    '    "source": "データソース名"\n' +
    '  },\n' +
    '  "construction": {\n' +
    '    "total": 0, "owner_occupied": 0, "rental": 0, "condo_sale": 0,\n' +
    '    "yoy_change": "+0.0%", "year": "2024", "source": "推計"\n' +
    '  },\n' +
    '  "housing": {\n' +
    '    "ownership_rate": 0, "vacancy_rate": 0, "rental_vacancy": 0,\n' +
    '    "total_units": 0, "detached": 0, "apartment": 0, "owned": 0, "rented": 0\n' +
    '  },\n' +
    '  "housing_market": {\n' +
    '    "used_home": { "avg_price": 0, "volume": 0, "avg_age": 0, "note": "avg_priceは万円単位" },\n' +
    '    "renovation": { "market_size": 0, "avg_cost": 0, "demand_trend": "", "note": "market_sizeは億円単位、avg_costは万円単位" },\n' +
    '    "condo_sale": { "avg_price": 0, "supply": 0, "avg_sqm_price": 0, "note": "avg_priceは万円単位、avg_sqm_priceは万円/㎡単位" },\n' +
    '    "condo_rental": { "avg_rent": 0, "vacancy_rate": 0, "supply": 0, "note": "avg_rentは円/月単位（例:85000）" }\n' +
    '  },\n' +
    '  "land_price": {\n' +
    '    "residential_sqm": 0, "residential_tsubo": 0, "commercial_sqm": 0, "yoy_change": "+0.0%",\n' +
    '    "note": "全て円/㎡または円/坪単位（例: 住宅地15万円/㎡なら150000）"\n' +
    '  },\n' +
    '  "home_prices": {\n' +
    '    "avg_price": 0, "price_range": "3000〜5000万円", "required_income": 0,\n' +
    '    "note": "avg_priceとrequired_incomeは万円単位"\n' +
    '  },\n' +
    '  "competition": { "total_companies": 0, "local_builders": 0 },\n' +
    '  "potential": {\n' +
    '    "target_households": 0, "rental_households": 0, "annual_converts": 0,\n' +
    '    "per_company": 0, "ai_insight": ""\n' +
    '  },\n' +
    '  "advertising": {\n' +
    '    "age_distribution": { "under_30_pct": 0, "age_30_49_pct": 0, "age_50_64_pct": 0, "over_65_pct": 0 },\n' +
    '    "channels": [\n' +
    '      { "name": "SNS広告", "score": 0, "platforms": "", "reason": "" },\n' +
    '      { "name": "WEB広告", "score": 0, "platforms": "", "reason": "" },\n' +
    '      { "name": "チラシ・DM", "score": 0, "platforms": "", "reason": "" }\n' +
    '    ],\n' +
    '    "best_channel": "", "strategy_summary": ""\n' +
    '  }\n' +
    '}';
}

// ---- JSON Parser ----
function parseJSON(text) {
  var cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* fall through */ }
    }
    throw new Error('AIの応答をパースできませんでした。再度お試しください。');
  }
}

// ---- Render Results ----
function renderResults(data, purchased) {
  var m = data.market;
  var area = data.area;
  var html = '';

  var sourceBadge = '<span style="background: linear-gradient(135deg, #10b981, #3b82f6); color:#fff; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">📊 実データ + AI分析</span>';

  // エリア情報カード
  html += '<div class="result-card result-card--company">' +
    '<div class="result-card__header">' +
    '<div class="result-card__icon">🏠</div>' +
    '<div>' +
    '<div class="result-card__title">' + escapeHtml(area.fullLabel) + ' 不動産エリア分析</div>' +
    '<div class="result-card__subtitle">不動産市場レポート ' + sourceBadge + '</div>' +
    '</div></div>' +
    '<div class="result-card__body">' +
    '<table class="data-table">' +
    '<tr><th>分析対象</th><td>' + escapeHtml(area.fullLabel) + '</td></tr>' +
    '<tr><th>分析日時</th><td>' + new Date().toLocaleString('ja-JP') + '</td></tr>' +
    '</table>' +
    '</div></div>';

  // ① 人口・世帯（無料プレビュー）
  if (m.population) {
    var pop = m.population;
    var popSource = pop.source ? ' <span style="font-size:11px; color:var(--text-muted);">(' + escapeHtml(pop.source) + ')</span>' : '';
    html += '<div class="result-card" data-section="free">' +
      '<div class="result-card__header"><div class="result-card__icon">👥</div>' +
      '<div><div class="result-card__title">① 人口・世帯データ' + popSource + '</div>' +
      '<div class="result-card__subtitle"><span class="badge-free">無料プレビュー</span></div></div></div>' +
      '<div class="result-card__body">' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.total_population) + '</div><div class="stat-box__label">総人口（人）</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.households) + '</div><div class="stat-box__label">世帯数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (pop.age_30_45_pct || '—') + '%</div><div class="stat-box__label">30〜45歳</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (pop.elderly_pct || '—') + '%</div><div class="stat-box__label">65歳以上</div></div>' +
      '</div></div></div>';
  }

  // AI市場分析（有料）
  var paidClass = purchased ? '' : ' blurred-section';
  var paidOverlay = purchased ? '' : '<div class="blur-overlay"><div class="blur-overlay__inner"><span class="blur-overlay__icon">🔒</span><span>購入すると表示されます</span></div></div>';

  if (m.market_summary) {
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🤖</div>' +
      '<div><div class="result-card__title">AI市場分析</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="market-summary">' + escapeHtml(m.market_summary).replace(/\n/g, '<br>') + '</div>' +
      '</div></div>';
  }

  // ② 建築着工
  if (m.construction) {
    var con = m.construction;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🏗️</div>' +
      '<div><div class="result-card__title">② 建築着工統計</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<table class="data-table">' +
      '<tr><th>全体 着工戸数</th><td>' + formatNumber(con.total) + ' 戸/年</td></tr>' +
      '<tr><th>持家</th><td><span class="highlight">' + formatNumber(con.owner_occupied) + '</span> 戸/年</td></tr>' +
      '<tr><th>貸家</th><td>' + formatNumber(con.rental || 0) + ' 戸/年</td></tr>' +
      '<tr><th>分譲</th><td>' + formatNumber(con.condo_sale || 0) + ' 戸/年</td></tr>' +
      '<tr><th>前年比</th><td>' + (con.yoy_change || '—') + '</td></tr>' +
      '</table></div></div>';
  }

  // ③ 住宅統計
  if (m.housing) {
    var h = m.housing;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🏡</div>' +
      '<div><div class="result-card__title">③ 住宅統計データ（持ち家率・空き家率）</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + (h.ownership_rate || '—') + '%</div><div class="stat-box__label">持ち家率</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (h.vacancy_rate || '—') + '%</div><div class="stat-box__label">空き家率</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (h.rental_vacancy || '—') + '%</div><div class="stat-box__label">貸家空室率</div></div>' +
      '</div>';
    if (h.total_units || h.detached || h.apartment) {
      html += '<table class="data-table" style="margin-top:8px;">' +
        '<tr><th>住宅総数</th><td>' + formatNumber(h.total_units) + ' 戸</td></tr>' +
        '<tr><th>一戸建</th><td>' + formatNumber(h.detached) + ' 戸</td></tr>' +
        '<tr><th>共同住宅</th><td>' + formatNumber(h.apartment) + ' 戸</td></tr>' +
        '<tr><th>持家</th><td>' + formatNumber(h.owned) + ' 戸</td></tr>' +
        '<tr><th>借家</th><td>' + formatNumber(h.rented) + ' 戸</td></tr>' +
        '</table>';
    }
    html += '</div></div>';
  }

  // ③-2 不動産市場
  if (m.housing_market) {
    var hm = m.housing_market;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🏘️</div>' +
      '<div><div class="result-card__title">不動産市場（中古・リフォーム・マンション）</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay;

    if (hm.used_home) {
      var uh = hm.used_home;
      var uhPrice = toMan(uh.avg_price);
      html += '<div class="sub-card"><div class="sub-card__title">🏚️ 中古戸建</div>' +
        '<table class="data-table">' +
        '<tr><th>平均価格</th><td>' + (uhPrice ? formatNumber(uhPrice) + ' 万円' : '—') + '</td></tr>' +
        '<tr><th>年間流通件数</th><td>' + (uh.volume ? formatNumber(uh.volume) + '件' : '—') + '</td></tr>' +
        '<tr><th>平均築年数</th><td>' + (uh.avg_age ? uh.avg_age + '年' : '—') + '</td></tr>' +
        '</table></div>';
    }
    if (hm.renovation) {
      var rv = hm.renovation;
      var rvSize = toOku(rv.market_size);
      var rvCost = toMan(rv.avg_cost);
      html += '<div class="sub-card"><div class="sub-card__title">🔧 リフォーム市場</div>' +
        '<table class="data-table">' +
        '<tr><th>市場規模</th><td>' + (rvSize ? formatNumber(rvSize) + ' 億円' : '—') + '</td></tr>' +
        '<tr><th>平均工事費</th><td>' + (rvCost ? formatNumber(rvCost) + ' 万円' : '—') + '</td></tr>' +
        '<tr><th>需要トレンド</th><td>' + (rv.demand_trend || '—') + '</td></tr>' +
        '</table></div>';
    }
    if (hm.condo_sale) {
      var cs = hm.condo_sale;
      var csPrice = toMan(cs.avg_price);
      var csSqm = toMan(cs.avg_sqm_price);
      html += '<div class="sub-card"><div class="sub-card__title">🏢 分譲マンション</div>' +
        '<table class="data-table">' +
        '<tr><th>平均価格</th><td>' + (csPrice ? formatNumber(csPrice) + ' 万円' : '—') + '</td></tr>' +
        '<tr><th>年間供給戸数</th><td>' + (cs.supply ? formatNumber(cs.supply) + '戸' : '—') + '</td></tr>' +
        '<tr><th>平均㎡単価</th><td>' + (csSqm ? formatNumber(csSqm) + ' 万円/㎡' : '—') + '</td></tr>' +
        '</table></div>';
    }
    if (hm.condo_rental) {
      var cr = hm.condo_rental;
      var crRent = (cr.avg_rent && cr.avg_rent < 1000) ? Math.round(cr.avg_rent * 10000) : cr.avg_rent;
      html += '<div class="sub-card"><div class="sub-card__title">🏬 賃貸マンション</div>' +
        '<table class="data-table">' +
        '<tr><th>平均家賃</th><td>' + (crRent ? formatNumber(crRent) + '円/月' : '—') + '</td></tr>' +
        '<tr><th>空室率</th><td>' + (cr.vacancy_rate ? cr.vacancy_rate + '%' : '—') + '</td></tr>' +
        '<tr><th>賃貸供給数</th><td>' + (cr.supply ? formatNumber(cr.supply) + '戸' : '—') + '</td></tr>' +
        '</table></div>';
    }
    html += '</div></div>';
  }

  // ④ 土地相場
  if (m.land_price) {
    var lp = m.land_price;
    // 円単位で来るはず。万円単位で来た場合（<1000）は円に変換（ローカル変数で元データを保持）
    var lpResSqm = (lp.residential_sqm && lp.residential_sqm < 1000) ? Math.round(lp.residential_sqm * 10000) : lp.residential_sqm;
    var lpResTsubo = (lp.residential_tsubo && lp.residential_tsubo < 3000) ? Math.round(lp.residential_tsubo * 10000) : lp.residential_tsubo;
    var lpComSqm = (lp.commercial_sqm && lp.commercial_sqm < 1000) ? Math.round(lp.commercial_sqm * 10000) : lp.commercial_sqm;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🗺️</div>' +
      '<div><div class="result-card__title">④ 土地相場</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<table class="data-table">' +
      '<tr><th>住宅地 坪単価</th><td><span class="highlight">' + (lpResTsubo ? formatNumber(lpResTsubo) + ' 円/坪' : '—') + '</span></td></tr>' +
      '<tr><th>住宅地 ㎡単価</th><td>' + formatNumber(lpResSqm) + ' 円/㎡</td></tr>' +
      '<tr><th>商業地 ㎡単価</th><td>' + formatNumber(lpComSqm) + ' 円/㎡</td></tr>' +
      '<tr><th>前年比</th><td>' + (lp.yoy_change || '—') + '</td></tr>' +
      '</table></div></div>';
  }

  // ⑤ 新築住宅相場
  if (m.home_prices) {
    var hp = m.home_prices;
    var avgP = toMan(hp.avg_price || 0);
    var reqInc = toMan(hp.required_income || 0);
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🏠</div>' +
      '<div><div class="result-card__title">⑤ 新築住宅相場</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<table class="data-table">' +
      '<tr><th>新築一戸建て 平均</th><td><span class="highlight">' + (avgP ? formatNumber(avgP) + ' 万円' : '—') + '</span></td></tr>' +
      '<tr><th>価格帯</th><td>' + (hp.price_range || '—') + '</td></tr>' +
      '<tr><th>目安年収</th><td>' + (reqInc ? formatNumber(reqInc) + ' 万円〜' : '—') + '</td></tr>' +
      '</table></div></div>';
  }

  // ⑥ 競合分析
  if (m.competition) {
    var comp = m.competition;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🏢</div>' +
      '<div><div class="result-card__title">⑥ 競合分析</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + (comp.total_companies || '—') + ' 社</div><div class="stat-box__label">工務店・HM数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (comp.local_builders || '—') + ' 社</div><div class="stat-box__label">地場工務店</div></div>' +
      '</div></div></div>';
  }

  // 潜在顧客
  if (m.potential) {
    var pot = m.potential;
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">🎯</div>' +
      '<div><div class="result-card__title">潜在顧客数の試算</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay +
      '<table class="data-table">' +
      '<tr><th>30〜45歳 世帯数</th><td>' + formatNumber(pot.target_households) + ' 世帯</td></tr>' +
      '<tr><th>賃貸世帯数</th><td>' + formatNumber(pot.rental_households) + ' 世帯</td></tr>' +
      '<tr><th>年間持ち家転換推定</th><td><span class="highlight">' + formatNumber(pot.annual_converts) + ' 世帯/年</span></td></tr>' +
      '<tr><th>1社あたり年間獲得</th><td><span class="highlight--amber">' + (pot.per_company || '—') + ' 棟</span></td></tr>' +
      '</table>';
    if (pot.ai_insight) {
      html += '<div class="summary-box" style="margin-top:10px"><div class="summary-box__title">📌 AIからの提言</div><div class="summary-box__text">' + escapeHtml(pot.ai_insight) + '</div></div>';
    }
    html += '</div></div>';
  }

  // 広告効果分析
  if (m.advertising) {
    var ad = m.advertising;
    var ageDist = ad.age_distribution || {};
    var channels = ad.channels || [];
    html += '<div class="result-card' + paidClass + '" data-section="paid">' +
      '<div class="result-card__header"><div class="result-card__icon">📢</div>' +
      '<div><div class="result-card__title">広告効果分析（年齢層ベース）</div>' +
      '<div class="result-card__subtitle">' + (purchased ? '' : '<span class="badge-paid">有料</span>') + '</div></div></div>' +
      '<div class="result-card__body">' + paidOverlay;

    // 年齢分布バー
    var u30 = ageDist.under_30_pct || 0;
    var a3049 = ageDist.age_30_49_pct || 0;
    var a5064 = ageDist.age_50_64_pct || 0;
    var o65 = ageDist.over_65_pct || 0;
    html += '<div style="margin-bottom:12px;">' +
      '<div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">年齢構成</div>' +
      '<div style="display:flex; height:24px; border-radius:8px; overflow:hidden; font-size:10px; font-weight:700;">' +
      '<div style="width:' + u30 + '%; background:#818cf8; display:flex; align-items:center; justify-content:center; color:#fff;">' + (u30 >= 10 ? u30 + '%' : '') + '</div>' +
      '<div style="width:' + a3049 + '%; background:#10b981; display:flex; align-items:center; justify-content:center; color:#fff;">' + (a3049 >= 10 ? a3049 + '%' : '') + '</div>' +
      '<div style="width:' + a5064 + '%; background:#f59e0b; display:flex; align-items:center; justify-content:center; color:#fff;">' + (a5064 >= 10 ? a5064 + '%' : '') + '</div>' +
      '<div style="width:' + o65 + '%; background:#ef4444; display:flex; align-items:center; justify-content:center; color:#fff;">' + (o65 >= 10 ? o65 + '%' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex; gap:12px; margin-top:4px; font-size:10px; color:var(--text-muted);">' +
      '<span>🟣 30歳未満 ' + u30 + '%</span><span>🟢 30-49歳 ' + a3049 + '%</span>' +
      '<span>🟡 50-64歳 ' + a5064 + '%</span><span>🔴 65歳以上 ' + o65 + '%</span></div></div>';

    var medals = ['🥇', '🥈', '🥉'];
    var sortedCh = channels.slice().sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
    html += '<div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">推奨広告チャネル</div>';
    sortedCh.forEach(function(ch, idx) {
      var score = ch.score || 0;
      var isBest = (idx === 0);
      var barColor = isBest ? '#10b981' : (idx === 1 ? '#3b82f6' : '#6b7280');
      var medal = medals[idx] || '　';
      html += '<div style="margin-bottom:8px; padding:10px; border-radius:8px; background:' + (isBest ? 'rgba(16,185,129,0.1)' : 'rgba(30,41,59,0.5)') + '; border:1px solid ' + (isBest ? 'rgba(16,185,129,0.3)' : 'rgba(99,102,241,0.1)') + ';">' +
        '<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">' +
        '<span style="font-size:16px;">' + medal + '</span>' +
        '<span style="font-weight:700; font-size:13px; color:var(--text-primary);">' + escapeHtml(ch.name || '') + '</span>' +
        '<span style="font-size:18px; font-weight:800; color:' + barColor + '; margin-left:auto;">' + score + '<span style="font-size:11px; font-weight:400;">点</span></span>' +
        (isBest ? '<span style="background:#10b981; color:#fff; font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px;">推奨</span>' : '') +
        '</div>' +
        '<div style="height:6px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden; margin-bottom:4px;">' +
        '<div style="height:100%; width:' + score + '%; background:' + barColor + '; border-radius:3px;"></div></div>' +
        '<div style="font-size:11px; color:var(--text-muted);">📍 ' + escapeHtml(ch.platforms || '') + '</div>' +
        '<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">→ ' + escapeHtml(ch.reason || '') + '</div>' +
        '</div>';
    });

    if (ad.strategy_summary) {
      html += '<div class="summary-box" style="margin-top:10px"><div class="summary-box__title">💡 広告戦略の提言</div><div class="summary-box__text">' + escapeHtml(ad.strategy_summary) + '</div></div>';
    }
    html += '</div></div>';
  }

  resultsContent.innerHTML = html;

  // 未購入なら購入プロンプトを表示
  if (!purchased) {
    document.getElementById('purchase-prompt').style.display = 'flex';
  } else {
    document.getElementById('purchase-prompt').style.display = 'none';
    hidePurchaseFloat();
  }
}

// ---- Stripe Checkout ----
function startCheckout() {
  if (!currentArea) return;

  // 未ログインなら先にログインを促す（ログイン後に自動で _doCheckout を実行）
  if (!currentUser) {
    _pendingCheckout = true;
    showLoginModal();
    return;
  }

  _doCheckout();
}

async function _doCheckout() {
  if (!currentArea || !currentUser) return;

  // 決済リダイレクト前に分析データを保存（戻ってきた時に復元するため）
  if (analysisData) {
    try {
      var serialized = JSON.stringify(analysisData);
      sessionStorage.setItem('ai_fudosan_pendingAnalysis', serialized);
      sessionStorage.setItem('ai_fudosan_pendingArea', JSON.stringify(currentArea));
    } catch (e) {
      console.error('[Checkout] sessionStorage保存失敗:', e);
      if (!confirm('分析データの一時保存に失敗しました。決済後は履歴からレポートを再表示できます。続行しますか？')) {
        return;
      }
    }
  }

  var btn = document.getElementById('purchase-btn');
  btn.disabled = true;
  btn.textContent = '処理中...';

  try {
    // セッションからJWTを取得（Worker側でuser_idを検証する）
    var session = await supabaseClient.auth.getSession();
    var token = session.data.session ? session.data.session.access_token : null;
    if (!token) throw new Error('認証トークンが取得できません。再ログインしてください。');

    var res = await fetch(WORKER_BASE + '/api/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        area: currentArea.fullLabel,
        area_code: currentArea.code || '',
        success_url: window.location.origin + window.location.pathname + '?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: window.location.origin + window.location.pathname
      })
    });

    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout作成エラー');

    // Stripe CheckoutページへリダイレクトWorkerが返すURLを直接使用）
    if (!data.url) throw new Error('Checkout URLが取得できませんでした');
    window.location.href = data.url;

  } catch (err) {
    alert('決済エラー: ' + err.message);
    btn.disabled = false;
    btn.textContent = '💳 購入してレポートを見る';
  }
}

async function verifyPurchase(sessionId) {
  try {
    // JWTを取得してAuthorizationヘッダーに付与
    var headers = {};
    if (supabaseClient && currentUser) {
      var session = await supabaseClient.auth.getSession();
      var token = session.data.session ? session.data.session.access_token : null;
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }
    var res = await fetch(WORKER_BASE + '/api/purchases?session_id=' + encodeURIComponent(sessionId), { headers: headers });
    var data = await res.json();
    if (data.purchased) {
      // 購入情報をローカルに保存
      savePurchase(data.area, sessionId);
      isPurchased = true;

      // 分析データがあれば購入プロンプトを消して全データ表示
      if (analysisData && analysisData.area) {
        document.getElementById('purchase-prompt').style.display = 'none';
        renderResults(analysisData, true);
        showResults();
        // 領収書メール案内（購入直後のみ表示）
        var receiptNote = document.createElement('div');
        receiptNote.style.cssText = 'text-align:center; padding:8px; margin:8px 0; background:rgba(16,185,129,0.1); border-radius:8px; font-size:13px; color:#10b981;';
        receiptNote.textContent = '購入ありがとうございます。領収書はご登録メールアドレスに送信されます。';
        var resultsHeader = document.querySelector('.results__header');
        if (resultsHeader) resultsHeader.after(receiptNote);

        // 分析データをDBに保存
        _saveAnalysisDataToDB(data.area, analysisData);
      }

      // sessionStorageクリア
      sessionStorage.removeItem('ai_fudosan_pendingAnalysis');
      sessionStorage.removeItem('ai_fudosan_pendingArea');
    }
  } catch (e) {
    console.warn('Purchase verification failed:', e);
  }
}

// ---- DB Analysis Data ----
async function _saveAnalysisDataToDB(areaName, data) {
  if (!currentUser || !supabaseClient) return;
  try {
    var session = await supabaseClient.auth.getSession();
    var token = session.data.session ? session.data.session.access_token : null;
    if (!token) return;
    await fetch(WORKER_BASE + '/api/purchases/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ area_name: areaName, analysis_data: data })
    });
  } catch (e) { console.warn('Analysis data save failed:', e); }
}

async function _loadAnalysisDataFromDB(areaName) {
  if (!currentUser || !supabaseClient) return null;
  try {
    var session = await supabaseClient.auth.getSession();
    var token = session.data.session ? session.data.session.access_token : null;
    if (!token) return null;
    var res = await fetch(WORKER_BASE + '/api/purchases/data?area_name=' + encodeURIComponent(areaName), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var result = await res.json();
    if (result.found && result.analysis_data) return result.analysis_data;
  } catch (e) { /* fall through */ }
  return null;
}

// ---- Purchase History (localStorage) ----
function getPurchases() {
  try {
    return JSON.parse(localStorage.getItem('ai_fudosan_purchases') || '[]');
  } catch (e) { return []; }
}

function savePurchase(areaName, sessionId) {
  var purchases = getPurchases();
  if (!purchases.some(function(p) { return p.area === areaName; })) {
    purchases.push({ area: areaName, session_id: sessionId, date: new Date().toISOString() });
    localStorage.setItem('ai_fudosan_purchases', JSON.stringify(purchases));
  }
}

function isAreaPurchased(areaName) {
  return getPurchases().some(function(p) { return p.area === areaName; });
}

async function isAreaPurchasedAsync(areaName) {
  // ログイン中ならWorker API経由でDB確認（HIGH-04修正: Supabase直接クエリ廃止）
  if (currentUser && supabaseClient) {
    try {
      var session = await supabaseClient.auth.getSession();
      var token = session.data.session ? session.data.session.access_token : null;
      if (token) {
        var res = await fetch(WORKER_BASE + '/api/purchases/check?area_name=' + encodeURIComponent(areaName), {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        var result = await res.json();
        if (result.purchased) return true;
      }
    } catch (e) { /* fall through to localStorage */ }
  }
  // フォールバック: localStorage
  return isAreaPurchased(areaName);
}

async function showHistoryModal() {
  var listEl = document.getElementById('history-list');

  if (currentUser && supabaseClient) {
    // Worker API経由でDB購入履歴を取得（HIGH-04修正: Supabase直接クエリ廃止）
    listEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">読み込み中...</p>';
    document.getElementById('history-modal').classList.add('active');

    try {
      var session = await supabaseClient.auth.getSession();
      var token = session.data.session ? session.data.session.access_token : null;
      if (!token) throw new Error('認証トークンなし');

      var res = await fetch(WORKER_BASE + '/api/purchases/history', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || '履歴取得エラー');
      var purchases = data.purchases || [];

      if (purchases.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">購入履歴はありません</p>';
      } else {
        listEl.innerHTML = '';
        purchases.forEach(function(p) {
          var btn = document.createElement('button');
          btn.className = 'area-select-btn';
          btn.innerHTML = '<span style="font-size:20px;">✅</span>' +
            '<div><div style="font-weight:700;">' + escapeHtml(p.area_name) + '</div>' +
            '<div style="font-size:11px; color:var(--text-muted);">購入日: ' + new Date(p.purchased_at).toLocaleDateString('ja-JP') + '</div></div>';
          btn.addEventListener('click', async function() {
            document.getElementById('history-modal').classList.remove('active');
            // DBから分析データを読み出し（再分析不要）
            var dbData = await _loadAnalysisDataFromDB(p.area_name);
            if (dbData) {
              analysisData = dbData;
              currentArea = dbData.area;
              isPurchased = true;
              areaInput.value = p.area_name;
              document.getElementById('purchase-prompt').style.display = 'none';
              renderResults(analysisData, true);
              showResults();
            } else {
              // DBにデータがなければ従来通り再分析
              areaInput.value = p.area_name;
              startAnalysis();
            }
          });
          listEl.appendChild(btn);
        });
      }
    } catch (err) {
      // DBエラー時はlocalStorageにフォールバック
      showHistoryFromLocalStorage(listEl);
    }
  } else {
    // 未ログイン時はlocalStorageから
    showHistoryFromLocalStorage(listEl);
    document.getElementById('history-modal').classList.add('active');
  }
}

function showHistoryFromLocalStorage(listEl) {
  var purchases = getPurchases();
  if (purchases.length === 0) {
    listEl.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">購入履歴はありません。ログインするとDB履歴を表示できます。</p>';
  } else {
    listEl.innerHTML = '';
    purchases.forEach(function(p) {
      var btn = document.createElement('button');
      btn.className = 'area-select-btn';
      btn.innerHTML = '<span style="font-size:20px;">✅</span>' +
        '<div><div style="font-weight:700;">' + escapeHtml(p.area) + '</div>' +
        '<div style="font-size:11px; color:var(--text-muted);">購入日: ' + new Date(p.date).toLocaleDateString('ja-JP') + '</div></div>';
      btn.addEventListener('click', function() {
        document.getElementById('history-modal').classList.remove('active');
        areaInput.value = p.area;
        startAnalysis();
      });
      listEl.appendChild(btn);
    });
  }
}

// ---- Excel Export ----
// ---- PDF Export ----
function handlePdfDownload() {
  if (!isPurchased) {
    alert('PDFダウンロードは有料レポート購入後に利用できます。');
    return;
  }
  exportPDF();
}

async function exportPDF() {
  if (typeof html2pdf === 'undefined') { alert('PDF生成ライブラリが読み込まれていません。ページを再読み込みしてお試しください。'); return; }
  if (!analysisData || !analysisData.market) { alert('分析データがありません'); return; }

  var m = analysisData.market;
  var area = analysisData.area;
  var dateStr = new Date().toLocaleDateString('ja-JP');

  var html = '<div style="max-width:100%; font-family:\'Noto Sans JP\',sans-serif; color:#000; background:#fff; font-size:12px; line-height:1.6; padding:0;">';

  // セクション共通スタイル
  var S = 'page-break-inside:avoid; margin-bottom:6px; border:1px solid #cbd5e1; border-radius:4px; padding:8px 12px;';
  var T = 'font-size:14px; font-weight:700; border-left:4px solid #3b82f6; padding-left:8px; margin-bottom:6px; color:#1e293b;';
  var TBL = 'width:100%; border-collapse:collapse; font-size:11px;';
  // TH背景を濃くして文字が見えやすいようにする
  var TH = 'text-align:left; padding:5px 8px; background:#e2e8f0; border:1px solid #cbd5e1; font-weight:600; color:#1e293b; width:40%;';
  var TD = 'padding:5px 8px; border:1px solid #cbd5e1; color:#000;';
  var SUB = 'padding:5px 8px; background:#bfdbfe; border:1px solid #93c5fd; font-weight:700; color:#1e40af;';

  function r(label, val) {
    return '<tr><th style="' + TH + '">' + escapeHtml(label) + '</th><td style="' + TD + '">' + escapeHtml(String(val || '—')) + '</td></tr>';
  }

  // ===== ヘッダー =====
  html += '<div style="text-align:center; margin-bottom:10px; padding-bottom:8px; border-bottom:3px solid #3b82f6;">';
  html += '<div style="font-size:22px; font-weight:800; color:#0f172a;">AI不動産市場レポート</div>';
  html += '<div style="font-size:16px; color:#3b82f6; font-weight:700; margin-top:4px;">' + escapeHtml(area.fullLabel) + '</div>';
  html += '<div style="font-size:9px; color:#64748b; margin-top:4px;">分析日: ' + dateStr + ' | データソース: 政府統計(e-Stat) + AI分析(Gemini)</div>';
  html += '</div>';

  // ===== 1. 人口・世帯 =====
  if (m.population) {
    var pop = m.population;
    html += '<div style="' + S + '"><div style="' + T + '">1. 人口・世帯データ</div>';
    html += '<table style="' + TBL + '">';
    html += r('総人口', formatNumber(pop.total_population));
    html += r('世帯数', formatNumber(pop.households));
    html += r('30〜45歳比率', (pop.age_30_45_pct || '—') + '%');
    html += r('65歳以上比率', (pop.elderly_pct || '—') + '%');
    html += r('人口増減率', pop.population_growth || '—');
    if (pop.source) html += r('データソース', pop.source);
    html += '</table></div>';
  }

  // ===== AI市場分析 =====
  if (m.market_summary) {
    html += '<div style="' + S + '"><div style="' + T + '">AI市場分析</div>';
    html += '<div style="font-size:11px; color:#1e293b; white-space:pre-wrap; line-height:1.7; padding:4px 2px;">' + escapeHtml(m.market_summary) + '</div>';
    html += '</div>';
  }

  // ===== 2. 建築着工統計 =====
  if (m.construction) {
    var c = m.construction;
    html += '<div style="' + S + '"><div style="' + T + '">2. 建築着工統計</div>';
    html += '<table style="' + TBL + '">';
    html += r('着工戸数(年)', formatNumber(c.total));
    html += r('持家', formatNumber(c.owner_occupied));
    html += r('貸家', formatNumber(c.rental));
    html += r('分譲', formatNumber(c.condo_sale));
    html += r('前年比', c.yoy_change || '—');
    html += '</table></div>';
  }

  // ===== 3. 住宅統計 =====
  if (m.housing) {
    var h = m.housing;
    html += '<div style="' + S + '"><div style="' + T + '">3. 住宅統計</div>';
    html += '<table style="' + TBL + '">';
    html += r('持ち家率', (h.ownership_rate || '—') + '%');
    html += r('空き家率', (h.vacancy_rate || '—') + '%');
    html += r('住宅総数', formatNumber(h.total_units));
    html += r('一戸建', formatNumber(h.detached));
    html += r('共同住宅', formatNumber(h.apartment));
    html += '</table></div>';
  }

  // ===== 4. 不動産市場 =====
  if (m.housing_market) {
    var hm = m.housing_market;
    html += '<div style="' + S + '"><div style="' + T + '">4. 不動産市場</div>';
    html += '<table style="' + TBL + '">';
    if (hm.used_home) {
      html += '<tr><th style="' + SUB + '" colspan="2">中古戸建</th></tr>';
      html += r('平均価格', toMan(hm.used_home.avg_price) + '万円');
      html += r('年間流通件数', formatNumber(hm.used_home.volume));
      html += r('平均築年数', (hm.used_home.avg_age || '—') + '年');
    }
    if (hm.renovation) {
      html += '<tr><th style="' + SUB + '" colspan="2">リフォーム市場</th></tr>';
      html += r('市場規模', toOku(hm.renovation.market_size) + '億円');
      html += r('平均工事費', toMan(hm.renovation.avg_cost) + '万円');
      html += r('需要トレンド', hm.renovation.demand_trend || '—');
    }
    if (hm.condo_sale) {
      html += '<tr><th style="' + SUB + '" colspan="2">分譲マンション</th></tr>';
      html += r('平均価格', toMan(hm.condo_sale.avg_price) + '万円');
      html += r('年間供給戸数', formatNumber(hm.condo_sale.supply));
      if (hm.condo_sale.avg_sqm_price) html += r('平均㎡単価', toMan(hm.condo_sale.avg_sqm_price) + '万円');
    }
    if (hm.condo_rental) {
      html += '<tr><th style="' + SUB + '" colspan="2">賃貸マンション</th></tr>';
      html += r('平均家賃', formatNumber(hm.condo_rental.avg_rent) + '円/月');
      html += r('空室率', (hm.condo_rental.vacancy_rate || '—') + '%');
      if (hm.condo_rental.supply) html += r('賃貸供給数', formatNumber(hm.condo_rental.supply));
    }
    html += '</table></div>';
  }

  // ===== 5. 土地相場 =====
  if (m.land_price) {
    var lp = m.land_price;
    html += '<div style="' + S + '"><div style="' + T + '">5. 土地相場</div>';
    html += '<table style="' + TBL + '">';
    html += r('住宅地 坪単価', formatNumber(lp.residential_tsubo) + '円');
    html += r('住宅地 ㎡単価', formatNumber(lp.residential_sqm) + '円');
    html += r('商業地 ㎡単価', formatNumber(lp.commercial_sqm) + '円');
    html += r('前年比', lp.yoy_change || '—');
    html += '</table></div>';
  }

  // ===== 6. 新築住宅相場 =====
  if (m.home_prices) {
    var hp2 = m.home_prices;
    html += '<div style="' + S + '"><div style="' + T + '">6. 新築住宅相場</div>';
    html += '<table style="' + TBL + '">';
    html += r('平均価格', toMan(hp2.avg_price) + '万円');
    html += r('価格帯', hp2.price_range || '—');
    html += r('目安年収', toMan(hp2.required_income) + '万円');
    html += '</table></div>';
  }

  // ===== 7. 競合分析 =====
  if (m.competition) {
    var comp2 = m.competition;
    html += '<div style="' + S + '"><div style="' + T + '">7. 競合分析</div>';
    html += '<table style="' + TBL + '">';
    html += r('工務店・HM数', formatNumber(comp2.total_companies));
    html += r('地場工務店', formatNumber(comp2.local_builders));
    html += r('大手HM支店', formatNumber(comp2.major_hm));
    html += r('飽和度', comp2.saturation || '—');
    html += '</table>';
    if (comp2.top_companies && comp2.top_companies.length > 0) {
      html += '<div style="margin-top:5px; font-size:10px; color:#334155; padding:3px 4px;">主要企業: ' + comp2.top_companies.map(function(x) { return escapeHtml(x.name || x); }).join(', ') + '</div>';
    }
    html += '</div>';
  }

  // ===== 8. 潜在顧客 =====
  if (m.potential) {
    var pot2 = m.potential;
    html += '<div style="' + S + '"><div style="' + T + '">8. 潜在顧客試算</div>';
    html += '<table style="' + TBL + '">';
    html += r('30〜45歳世帯数', formatNumber(pot2.target_households));
    html += r('賃貸世帯数', formatNumber(pot2.rental_households));
    html += r('年間持ち家転換', formatNumber(pot2.annual_converts));
    html += r('1社あたり年間', formatNumber(pot2.per_company));
    html += '</table>';
    if (pot2.ai_insight) {
      html += '<div style="margin-top:5px; padding:5px 8px; background:#f0fdf4; border:1px solid #86efac; border-radius:3px; font-size:10px; color:#166534;">' + escapeHtml(pot2.ai_insight) + '</div>';
    }
    html += '</div>';
  }

  // ===== 9. 広告効果分析 =====
  if (m.advertising) {
    var ad2 = m.advertising;
    html += '<div style="' + S + '"><div style="' + T + '">9. 広告効果分析</div>';
    if (ad2.age_distribution) {
      html += '<div style="font-weight:600; font-size:11px; margin-bottom:4px; color:#334155;">年齢構成</div>';
      html += '<table style="' + TBL + '">';
      html += r('30歳未満', (ad2.age_distribution.under_30_pct || '—') + '%');
      html += r('30〜49歳', (ad2.age_distribution.age_30_49_pct || '—') + '%');
      html += r('50〜64歳', (ad2.age_distribution.age_50_64_pct || '—') + '%');
      html += r('65歳以上', (ad2.age_distribution.over_65_pct || '—') + '%');
      html += '</table>';
    }
    if (ad2.channels && ad2.channels.length > 0) {
      html += '<div style="margin-top:8px; font-weight:600; font-size:11px; margin-bottom:4px; color:#334155;">推奨チャネル</div>';
      html += '<table style="' + TBL + '">';
      html += '<tr><th style="' + TH + 'width:26%;">チャネル</th><th style="' + TH + 'width:12%;">スコア</th><th style="' + TH + 'width:62%;">理由</th></tr>';
      ad2.channels.forEach(function(ch) {
        html += '<tr><td style="' + TD + '">' + escapeHtml(ch.name || '') + '</td>';
        html += '<td style="' + TD + 'text-align:center; font-weight:700;">' + (ch.score || '') + '</td>';
        html += '<td style="' + TD + 'font-size:10px;">' + escapeHtml(ch.reason || '') + '</td></tr>';
      });
      html += '</table>';
    }
    if (ad2.strategy_summary) {
      html += '<div style="margin-top:5px; padding:5px 8px; background:#eff6ff; border:1px solid #93c5fd; border-radius:3px; font-size:10px; color:#1e40af;">' + escapeHtml(ad2.strategy_summary) + '</div>';
    }
    html += '</div>';
  }

  // ===== フッター =====
  html += '<div style="text-align:center; margin-top:10px; padding-top:6px; border-top:1px solid #e2e8f0;">';
  html += '<div style="font-size:9px; color:#94a3b8;">AI不動産市場レポート v2.0 | Powered by AI + 政府統計データ | ' + dateStr + '</div>';
  html += '</div>';
  html += '</div>'; // ルートdiv閉じ

  // 新しいウィンドウで印刷（ブラウザネイティブレンダリングで高品質PDF）
  var printWin = window.open('', '_blank', 'width=800,height=1000');
  if (!printWin) { alert('ポップアップがブロックされました。ポップアップを許可してください。'); return; }

  printWin.document.write('<!DOCTYPE html><html><head><meta charset="utf-8">');
  printWin.document.write('<title>不動産市場分析_' + escapeHtml(area.fullLabel) + '</title>');
  printWin.document.write('<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700;800&display=swap" rel="stylesheet">');
  printWin.document.write('<style>');
  printWin.document.write('*{margin:0;padding:0;box-sizing:border-box;}');
  printWin.document.write('body{background:#fff;color:#000;font-family:"Noto Sans JP",sans-serif;font-size:12px;line-height:1.6;padding:20px 30px;}');
  printWin.document.write('@media print{body{padding:0;}@page{margin:12mm 15mm;}}');
  printWin.document.write('</style></head><body>');
  printWin.document.write(html);
  printWin.document.write('</body></html>');
  printWin.document.close();

  // フォント読み込み後に印刷ダイアログを表示
  printWin.onload = function() {
    setTimeout(function() { printWin.print(); }, 800);
  };
}

// ---- Excel Export ----
function handleExcelDownload() {
  if (!isPurchased) {
    alert('Excelダウンロードは有料レポート購入後に利用できます。');
    return;
  }
  exportExcel();
}

function exportExcel() {
  if (!analysisData || !analysisData.market) { alert('分析データがありません'); return; }

  var m = analysisData.market;
  var area = analysisData.area;
  var wb = XLSX.utils.book_new();

  // !merges に追加するヘルパー: 行インデックスと列範囲を指定してセル結合を登録
  var merges = [];
  var rowHeights = []; // { idx: rowIndex, hpx: height } の配列

  // サマリーデータの行を順次積み上げる
  var rows = [];

  function pushRow(cells) {
    rows.push(cells);
  }

  // ===== タイトル行（A1:D1 結合） =====
  pushRow(['AI不動産市場レポート', '', '', '']);
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } });

  pushRow(['エリア', area.fullLabel, '', '']);
  pushRow(['分析日', new Date().toLocaleDateString('ja-JP'), '', '']);
  pushRow(['データソース', '政府統計(e-Stat) + AI分析(Gemini)', '', '']);

  // ===== セクションヘッダーを空行で区切り、A:B結合 =====
  function pushSectionHeader(title) {
    pushRow(['', '', '', '']); // 区切り空行
    var idx = rows.length;
    pushRow([title, '', '', '']);
    // A:D 結合でヘッダーを幅広に見せる
    merges.push({ s: { r: idx, c: 0 }, e: { r: idx, c: 3 } });
  }

  function pushDataRow(label, val, unit) {
    var displayVal = (val === null || val === undefined || val === '') ? '—' : String(val);
    if (unit) displayVal = displayVal + unit;
    pushRow([label, displayVal, '', '']);
  }

  // ===== 1. 人口・世帯データ =====
  pushSectionHeader('① 人口・世帯データ');
  var pop = m.population || {};
  pushDataRow('総人口', pop.total_population ? formatNumber(pop.total_population) : '', '');
  pushDataRow('世帯数', pop.households ? formatNumber(pop.households) : '', '');
  pushDataRow('30〜45歳比率', pop.age_30_45_pct, '%');
  pushDataRow('65歳以上比率', pop.elderly_pct, '%');
  pushDataRow('人口増減率', pop.population_growth, '');
  if (pop.source) pushDataRow('データソース', pop.source, '');

  // ===== 2. 建築着工統計 =====
  pushSectionHeader('② 建築着工統計');
  var cons = m.construction || {};
  pushDataRow('着工戸数(年)', cons.total ? formatNumber(cons.total) : '', '');
  pushDataRow('持家', cons.owner_occupied ? formatNumber(cons.owner_occupied) : '', '');
  pushDataRow('貸家', cons.rental ? formatNumber(cons.rental) : '', '');
  pushDataRow('分譲', cons.condo_sale ? formatNumber(cons.condo_sale) : '', '');
  pushDataRow('前年比', cons.yoy_change, '');

  // ===== 3. 住宅統計 =====
  pushSectionHeader('③ 住宅統計');
  var hs = m.housing || {};
  pushDataRow('持ち家率', hs.ownership_rate, '%');
  pushDataRow('空き家率', hs.vacancy_rate, '%');
  pushDataRow('住宅総数', hs.total_units ? formatNumber(hs.total_units) : '', '');
  pushDataRow('一戸建', hs.detached ? formatNumber(hs.detached) : '', '');
  pushDataRow('共同住宅', hs.apartment ? formatNumber(hs.apartment) : '', '');

  // ===== 4. 不動産市場 =====
  pushSectionHeader('④ 不動産市場');
  var hm = m.housing_market || {};
  if (hm.used_home) {
    pushRow(['【中古戸建】', '', '', '']);
    merges.push({ s: { r: rows.length - 1, c: 0 }, e: { r: rows.length - 1, c: 3 } });
    pushDataRow('平均価格(万円)', hm.used_home.avg_price ? toMan(hm.used_home.avg_price) : '', '');
    pushDataRow('年間流通件数', hm.used_home.volume ? formatNumber(hm.used_home.volume) : '', '');
    pushDataRow('平均築年数(年)', hm.used_home.avg_age, '');
  }
  if (hm.renovation) {
    pushRow(['【リフォーム市場】', '', '', '']);
    merges.push({ s: { r: rows.length - 1, c: 0 }, e: { r: rows.length - 1, c: 3 } });
    pushDataRow('市場規模(億円)', hm.renovation.market_size ? toOku(hm.renovation.market_size) : '', '');
    pushDataRow('平均工事費(万円)', hm.renovation.avg_cost ? toMan(hm.renovation.avg_cost) : '', '');
    pushDataRow('需要トレンド', hm.renovation.demand_trend, '');
  }
  if (hm.condo_sale) {
    pushRow(['【分譲マンション】', '', '', '']);
    merges.push({ s: { r: rows.length - 1, c: 0 }, e: { r: rows.length - 1, c: 3 } });
    pushDataRow('平均価格(万円)', hm.condo_sale.avg_price ? toMan(hm.condo_sale.avg_price) : '', '');
    pushDataRow('年間供給戸数', hm.condo_sale.supply ? formatNumber(hm.condo_sale.supply) : '', '');
    if (hm.condo_sale.avg_sqm_price) pushDataRow('平均㎡単価(万円)', toMan(hm.condo_sale.avg_sqm_price), '');
  }
  if (hm.condo_rental) {
    pushRow(['【賃貸マンション】', '', '', '']);
    merges.push({ s: { r: rows.length - 1, c: 0 }, e: { r: rows.length - 1, c: 3 } });
    pushDataRow('平均家賃(円/月)', hm.condo_rental.avg_rent ? formatNumber(hm.condo_rental.avg_rent) : '', '');
    pushDataRow('空室率(%)', hm.condo_rental.vacancy_rate, '');
    if (hm.condo_rental.supply) pushDataRow('賃貸供給数', formatNumber(hm.condo_rental.supply), '');
  }

  // ===== 5. 土地相場 =====
  pushSectionHeader('⑤ 土地相場');
  var lp = m.land_price || {};
  pushDataRow('住宅地 坪単価(円)', lp.residential_tsubo ? formatNumber(lp.residential_tsubo) : '', '');
  pushDataRow('住宅地 ㎡単価(円)', lp.residential_sqm ? formatNumber(lp.residential_sqm) : '', '');
  pushDataRow('商業地 ㎡単価(円)', lp.commercial_sqm ? formatNumber(lp.commercial_sqm) : '', '');
  pushDataRow('前年比', lp.yoy_change, '');

  // ===== 6. 新築住宅相場 =====
  pushSectionHeader('⑥ 新築住宅相場');
  var hp2 = m.home_prices || {};
  pushDataRow('平均価格(万円)', hp2.avg_price ? toMan(hp2.avg_price) : '', '');
  pushDataRow('価格帯', hp2.price_range, '');
  pushDataRow('目安年収(万円)', hp2.required_income ? toMan(hp2.required_income) : '', '');

  // ===== 7. 競合分析 =====
  pushSectionHeader('⑦ 競合分析');
  var comp2 = m.competition || {};
  pushDataRow('工務店・HM数', comp2.total_companies ? formatNumber(comp2.total_companies) : '', '');
  pushDataRow('地場工務店', comp2.local_builders ? formatNumber(comp2.local_builders) : '', '');
  pushDataRow('大手HM支店', comp2.major_hm ? formatNumber(comp2.major_hm) : '', '');
  pushDataRow('飽和度', comp2.saturation, '');
  if (comp2.top_companies && comp2.top_companies.length > 0) {
    pushDataRow('主要企業', comp2.top_companies.map(function(x) { return x.name || x; }).join(', '), '');
  }

  // ===== 8. 潜在顧客試算 =====
  pushSectionHeader('⑧ 潜在顧客試算');
  var pot2 = m.potential || {};
  pushDataRow('30〜45歳世帯数', pot2.target_households ? formatNumber(pot2.target_households) : '', '');
  pushDataRow('賃貸世帯数', pot2.rental_households ? formatNumber(pot2.rental_households) : '', '');
  pushDataRow('年間持ち家転換', pot2.annual_converts ? formatNumber(pot2.annual_converts) : '', '');
  pushDataRow('1社あたり年間', pot2.per_company ? formatNumber(pot2.per_company) : '', '');
  if (pot2.ai_insight) {
    pushDataRow('AI提言', pot2.ai_insight, '');
  }

  // ===== 9. 広告効果分析 =====
  pushSectionHeader('⑨ 広告効果分析');
  var ad2 = m.advertising || {};
  var ageDist = ad2.age_distribution || {};
  pushDataRow('30歳未満(%)', ageDist.under_30_pct, '');
  pushDataRow('30〜49歳(%)', ageDist.age_30_49_pct, '');
  pushDataRow('50〜64歳(%)', ageDist.age_50_64_pct, '');
  pushDataRow('65歳以上(%)', ageDist.over_65_pct, '');

  var channels = ad2.channels || [];
  if (channels.length > 0) {
    pushRow(['', '', '', '']); // 区切り空行
    // チャネルヘッダー行
    var chHeaderIdx = rows.length;
    pushRow(['推奨広告チャネル', '', '', '']);
    merges.push({ s: { r: chHeaderIdx, c: 0 }, e: { r: chHeaderIdx, c: 3 } });
    // チャネルデータ（4列フル活用）
    pushRow(['チャネル名', 'スコア', 'プラットフォーム', '推奨理由']);
    channels.forEach(function(ch) {
      var plat = ch.platforms || '';
      pushRow([
        ch.name || '',
        ch.score || '',
        Array.isArray(plat) ? plat.join(', ') : String(plat),
        ch.reason || ''
      ]);
    });
  }
  pushDataRow('最も推奨チャネル', ad2.best_channel, '');
  pushDataRow('広告戦略サマリー', ad2.strategy_summary, '');

  // ===== 10. AI市場分析サマリー（長文・行高さ確保） =====
  pushSectionHeader('⑩ AI市場分析サマリー');
  var summaryText = m.market_summary || '';
  // 改行を CRLF に統一し、適度に区切って可読性を上げる
  var formattedSummary = summaryText.replace(/\r\n|\r|\n/g, '\r\n');
  var summaryRowIdx = rows.length;
  // A列とB列を結合して幅広に表示（C,D列は空）
  pushRow([formattedSummary, '', '', '']);
  merges.push({ s: { r: summaryRowIdx, c: 0 }, e: { r: summaryRowIdx, c: 3 } });
  // 長文行の高さを200pxに設定
  rowHeights.push({ idx: summaryRowIdx, hpx: 200 });

  // ===== シート生成 =====
  var ws = XLSX.utils.aoa_to_sheet(rows);

  ws['!cols'] = [{ wch: 28 }, { wch: 50 }, { wch: 30 }, { wch: 40 }];
  ws['!merges'] = merges;

  // 行高さの適用
  var wsRows = [];
  rowHeights.forEach(function(rh) { wsRows[rh.idx] = { hpx: rh.hpx }; });
  ws['!rows'] = wsRows;

  // xlsx-js-style: セルスタイルを適用
  var thinBorder = { style: 'thin', color: { rgb: 'CCCCCC' } };
  var borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
  var wrapAlign = { wrapText: true, vertical: 'top' };

  // 全セルにwrapText + 罫線を適用
  var range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (var R = range.s.r; R <= range.e.r; R++) {
    for (var C = range.s.c; C <= range.e.c; C++) {
      var addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[addr]) ws[addr] = { v: '', t: 's' };
      ws[addr].s = { alignment: wrapAlign, border: borders, font: { name: 'Yu Gothic', sz: 10 } };
    }
  }

  // タイトル行(row 0)を太字・大きく
  var titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
  if (ws[titleAddr]) {
    ws[titleAddr].s = { alignment: { horizontal: 'center', vertical: 'center' }, font: { name: 'Yu Gothic', sz: 14, bold: true }, border: borders };
  }

  // セクションヘッダー行を太字・背景色付き
  merges.forEach(function(mg) {
    var hdrAddr = XLSX.utils.encode_cell({ r: mg.s.r, c: 0 });
    if (ws[hdrAddr] && ws[hdrAddr].v && typeof ws[hdrAddr].v === 'string') {
      var val = ws[hdrAddr].v;
      if (val.match(/^[①-⑩]/) || val.match(/^\[/) || val.match(/^推奨/) || val === 'AI不動産市場レポート') {
        ws[hdrAddr].s = {
          alignment: wrapAlign,
          font: { name: 'Yu Gothic', sz: 11, bold: true, color: { rgb: '1E40AF' } },
          fill: { fgColor: { rgb: 'DBEAFE' } },
          border: borders
        };
      }
    }
  });

  // AI市場分析サマリー行の特別スタイル
  var summaryAddr = XLSX.utils.encode_cell({ r: summaryRowIdx, c: 0 });
  if (ws[summaryAddr]) {
    ws[summaryAddr].s = { alignment: wrapAlign, font: { name: 'Yu Gothic', sz: 10 }, border: borders };
  }

  XLSX.utils.book_append_sheet(wb, ws, '市場分析レポート');

  var fileName = '不動産市場分析_' + area.fullLabel + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fileName);
}

function cancelPurchasePrompt() {
  document.getElementById('purchase-prompt').style.display = 'none';
  // 閉じた後も再決済できるフローティングボタンを表示
  var floatBtn = document.getElementById('purchase-float-btn');
  if (!floatBtn) {
    floatBtn = document.createElement('button');
    floatBtn.id = 'purchase-float-btn';
    floatBtn.className = 'purchase-float-btn';
    floatBtn.textContent = '🔓 完全版を購入 ¥300';
    floatBtn.onclick = function() {
      floatBtn.style.display = 'none';
      document.getElementById('purchase-prompt').style.display = 'flex';
    };
    document.body.appendChild(floatBtn);
  }
  floatBtn.style.display = 'block';
}

function hidePurchaseFloat() {
  var floatBtn = document.getElementById('purchase-float-btn');
  if (floatBtn) floatBtn.style.display = 'none';
}

// ---- UI Helpers ----
function resetAll() {
  analysisData = null;
  currentArea = null;
  isPurchased = false;
  _analysisRunning = false;
  areaInput.value = '';
  hideResults();
  hideProgress();
  hideError();
  document.getElementById('purchase-prompt').style.display = 'none';
  hidePurchaseFloat();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setLoading(isLoading) {
  analyzeBtn.classList.toggle('is-loading', isLoading);
  analyzeBtn.disabled = isLoading;
  // 分析中は入力フィールドもロック
  areaInput.disabled = isLoading;
  areaInput.style.opacity = isLoading ? '0.5' : '';
  areaInput.style.cursor = isLoading ? 'not-allowed' : '';
}

function showProgress() { progressSection.classList.add('is-active'); }
function hideProgress() { progressSection.classList.remove('is-active'); }

function activateStep(id) {
  var el = document.getElementById(id);
  if (el) el.classList.add('is-active');
}

function completeStep(id) {
  var el = document.getElementById(id);
  if (el) { el.classList.remove('is-active'); el.classList.add('is-done'); }
}

function showResults() { resultsSection.classList.add('is-active'); }
function hideResults() { resultsSection.classList.remove('is-active'); }

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('is-active');
}

function hideError() { errorMsg.classList.remove('is-active'); }

// 万円単位に変換（円単位で来た場合に対応）
function toMan(val) {
  if (!val || val === 0) return 0;
  // 100万以上なら円単位と判断して万に変換（例: 30000000→3000万）
  if (val > 100000) return Math.round(val / 10000);
  return val;
}

// 億円単位に変換（円単位で来た場合に対応）
function toOku(val) {
  if (!val || val === 0) return 0;
  // 1万以上なら円or万円単位と判断
  if (val > 1000000000) return Math.round(val / 100000000); // 円→億
  if (val > 10000) return Math.round(val / 10000); // 万円→億（稀）
  return val;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlightMatch(text, query) {
  var escaped = escapeHtml(text);
  var escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp('(' + escapedQuery + ')', 'gi'), '<mark>$1</mark>');
}

function formatNumber(num) {
  if (num === null || num === undefined || num === '') return '—';
  var n = Number(num);
  if (isNaN(n)) return '—';
  return n.toLocaleString('ja-JP');
}

// ---- area-database.js の searchArea 関数（AREA_DATABASEを検索）----
function searchArea(input) {
  if (!input || typeof AREA_DATABASE === 'undefined') return [];
  var query = input.trim();
  var results = [];

  // 完全一致
  for (var i = 0; i < AREA_DATABASE.length; i++) {
    var a = AREA_DATABASE[i];
    if (a.fullLabel === query || a.name === query) {
      results.push(a);
    }
  }
  if (results.length > 0) return results;

  // 部分一致
  for (var i = 0; i < AREA_DATABASE.length; i++) {
    var a = AREA_DATABASE[i];
    if (a.fullLabel.indexOf(query) >= 0 || a.name.indexOf(query) >= 0) {
      results.push(a);
    }
  }

  return results;
}
