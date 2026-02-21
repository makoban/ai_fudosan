/**
 * v2.0 E2Eテスト — ローンチ前6項目の確認
 * 1. バージョン表示 v2.0
 * 2. 価格表示 ¥300
 * 3. フッターリンク4つ（利用規約・PP・特商法・お問い合わせ）
 * 4. パスワードリセットUI
 * 5. PDF/Excel生成（モックデータ）
 * 6. 領収書メッセージ（DOM上確認のみ）
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const FRONTEND_URL = 'https://ai-fudosan.bantex.jp';
const OUTPUT_DIR = 'C:\\Users\\banma\\becreative Dropbox\\番野誠\\ビークリ社内用共有\\サービス\\市場調査\\テスト出力';

var passed = 0, failed = 0;
function log(msg) { console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${msg}`); }
function check(name, ok, detail) {
  if (ok) { passed++; log(`✅ ${name}`); }
  else { failed++; log(`❌ ${name} — ${detail || ''}`); }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: OUTPUT_DIR });

  page.on('pageerror', err => log(`[PageError] ${err.message}`));

  try {
    // ========== ページ読み込み ==========
    await page.setCacheEnabled(false);
    await page.goto(FRONTEND_URL + '?_=' + Date.now(), { waitUntil: 'networkidle2', timeout: 30000 });
    log('ページ読み込み完了');

    // ========== 1. バージョン表示 ==========
    const version = await page.$eval('.header__badge', el => el.textContent.trim());
    check('バージョン v2.0', version === 'v2.0', `実際: ${version}`);

    // ========== 2. 価格表示 ¥300 ==========
    const heroPrice = await page.$eval('.pricing-info__badge--paid', el => el.textContent.trim());
    check('ヒーロー価格 ¥300', heroPrice === '¥300', `実際: ${heroPrice}`);

    const purchasePrice = await page.$eval('.purchase-prompt__amount', el => el.textContent.trim());
    check('購入プロンプト価格 ¥300', purchasePrice === '¥300', `実際: ${purchasePrice}`);

    // ========== 3. フッターリンク ==========
    const footerLinks = await page.$$eval('.footer__links a', els => els.map(a => ({
      text: a.textContent.trim(),
      href: a.href,
      target: a.target
    })));
    check('フッターリンク数 = 5', footerLinks.length === 5, `実際: ${footerLinks.length}`);

    const expectedLinks = [
      { text: '利用規約', href: 'https://bantex.jp/terms.html' },
      { text: 'プライバシーポリシー', href: 'https://bantex.jp/privacy.html' },
      { text: '特定商取引法に基づく表記', href: 'https://bantex.jp/tokushoho.html' },
      { text: 'お問い合わせ', href: 'mailto:info@bantex.jp' },
      { text: '領収書について', href: '#receipt-info' },
    ];
    expectedLinks.forEach((exp, i) => {
      const actual = footerLinks[i] || {};
      const hrefMatch = actual.href && actual.href.includes(exp.href);
      check(`フッター[${i}] ${exp.text}`, actual.text === exp.text && hrefMatch,
        `実際: "${actual.text}" → ${actual.href}`);
    });

    // ========== 4. パスワードリセットUI ==========
    // ログインモーダルを開く
    await page.click('.auth-login-btn');
    await new Promise(r => setTimeout(r, 500));

    const modalActive = await page.$eval('#login-modal', el => el.classList.contains('active'));
    check('ログインモーダル表示', modalActive);

    // 「パスワードをお忘れの方」リンク存在
    const forgotLink = await page.$('#auth-forgot a');
    check('パスワードリセットリンク存在', !!forgotLink);

    // リンクをクリック
    if (forgotLink) {
      await forgotLink.click();
      await new Promise(r => setTimeout(r, 300));

      const modeTitle = await page.$eval('#auth-mode-title', el => el.textContent.trim());
      check('リセットモードタイトル', modeTitle === 'パスワードリセット', `実際: ${modeTitle}`);

      const pwVisible = await page.$eval('#auth-password', el => el.style.display);
      check('パスワード欄非表示', pwVisible === 'none', `実際: display=${pwVisible}`);

      const submitText = await page.$eval('#auth-submit-btn', el => el.textContent.trim());
      check('送信ボタン「リセットメールを送信」', submitText === 'リセットメールを送信', `実際: ${submitText}`);

      // 「ログインに戻る」で復帰
      await page.click('#auth-switch-text a');
      await new Promise(r => setTimeout(r, 300));

      const backTitle = await page.$eval('#auth-mode-title', el => el.textContent.trim());
      check('ログインに戻る', backTitle === 'ログイン', `実際: ${backTitle}`);

      const pwVisibleAfter = await page.$eval('#auth-password', el => el.style.display);
      check('パスワード欄復帰', pwVisibleAfter === '' || pwVisibleAfter === 'block', `実際: display=${pwVisibleAfter}`);
    }

    // モーダルを閉じる
    await page.click('#login-modal .modal__close');
    await new Promise(r => setTimeout(r, 300));

    // ========== 5. PDF/Excel生成テスト（モックデータ） ==========
    // 既存のxlsxファイル削除
    fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.xlsx') && f.includes('渋谷区')).forEach(f => {
      fs.unlinkSync(path.join(OUTPUT_DIR, f));
    });

    await page.evaluate(() => {
      window.analysisData = {
        area: { fullLabel: '東京都渋谷区', code: '13113' },
        market: {
          area_name: '東京都渋谷区',
          market_summary: '渋谷区は東京都内でも有数の商業・住宅複合エリアです。',
          population: { total_population: 232616, households: 143468, age_30_45_pct: 25.3, elderly_pct: 23.2, population_growth: '+0.8%', source: '令和2年国勢調査' },
          construction: { total: 3850, owner_occupied: 420, rental: 2150, condo_sale: 1280, yoy_change: '+5.2%' },
          housing: { ownership_rate: 38.5, vacancy_rate: 12.8, total_units: 168000, detached: 18500, apartment: 145000 },
          housing_market: {
            used_home: { avg_price: 85000000, volume: 1250, avg_age: 22 },
            renovation: { market_size: 3200000000, avg_cost: 8500000, demand_trend: '増加傾向' },
            condo_sale: { avg_price: 92000000, supply: 850 },
            condo_rental: { avg_rent: 185000, vacancy_rate: 5.2 }
          },
          land_price: { residential_tsubo: 3850000, residential_sqm: 1165000, commercial_sqm: 8920000, yoy_change: '+3.8%' },
          home_prices: { avg_price: 72000000, price_range: '5,500万〜1億2,000万', required_income: 12000000 },
          competition: { total_companies: 285, local_builders: 95, major_hm: 42, saturation: '高い', top_companies: [{ name: '三井ホーム' }, { name: '住友林業' }] },
          potential: { target_households: 36250, rental_households: 88200, annual_converts: 1840, per_company: 6, ai_insight: '渋谷区は高所得層が多い。' },
          advertising: {
            age_distribution: { under_30_pct: 22.5, age_30_49_pct: 35.8, age_50_64_pct: 20.3, over_65_pct: 21.4 },
            channels: [{ name: 'Web広告', score: 92, platforms: ['Google Ads'], reason: 'IT層が多い' }],
            best_channel: 'Web広告',
            strategy_summary: 'デジタルマーケティング中心の戦略が有効です。'
          }
        }
      };
      window.isPurchased = true;
    });
    log('モックデータ設定完了');

    // Excel生成
    await page.evaluate(() => exportExcel());
    await new Promise(r => setTimeout(r, 3000));

    const xlsxFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.xlsx') && f.includes('渋谷区'));
    check('Excel生成', xlsxFiles.length > 0, `ファイル数: ${xlsxFiles.length}`);
    if (xlsxFiles.length > 0) {
      const stat = fs.statSync(path.join(OUTPUT_DIR, xlsxFiles[0]));
      check('Excelサイズ > 10KB', stat.size > 10000, `${(stat.size/1024).toFixed(1)}KB`);
      log(`  → ${xlsxFiles[0]} (${(stat.size/1024).toFixed(1)}KB)`);
    }

    // PDF生成（新ウィンドウ）
    const newPagePromise = new Promise(resolve => {
      browser.once('targetcreated', async target => {
        const newPage = await target.page();
        resolve(newPage);
      });
    });

    await page.evaluate(() => exportPDF());
    const printPage = await newPagePromise;

    if (printPage) {
      await new Promise(r => setTimeout(r, 3000));

      // PDF印刷ウィンドウのスクリーンショット
      await printPage.screenshot({ path: path.join(OUTPUT_DIR, 'v2_pdf_preview.png'), fullPage: true });
      log('PDF印刷プレビューSS保存');

      // v2.0フッターテキスト確認
      const pdfContent = await printPage.content();
      check('PDF内 v2.0表示', pdfContent.includes('v2.0'));
      check('PDF内「AI不動産市場レポート」', pdfContent.includes('AI不動産市場レポート'));

      await printPage.close().catch(() => {});
    }
    check('PDF印刷ウィンドウ生成', !!printPage);

    // メインページのスクリーンショット
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'v2_main.png'), fullPage: true });
    log('メインページSS保存');

    // フッター部分のスクリーンショット
    await page.evaluate(() => document.querySelector('.footer').scrollIntoView());
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'v2_footer.png') });
    log('フッターSS保存');

  } catch (err) {
    log(`エラー: ${err.message}`);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'v2_error.png'), fullPage: true }).catch(() => {});
  }

  // ========== 結果サマリー ==========
  log('');
  log(`========== テスト結果 ==========`);
  log(`✅ PASSED: ${passed}`);
  log(`❌ FAILED: ${failed}`);
  log(`================================`);

  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
  log('完了');
})();
