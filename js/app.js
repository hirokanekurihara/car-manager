/* =========================================================
   マイカー管理アプリ - メインスクリプト（Firebase版）
   ---------------------------------------------------------
   ■ 認証   : Firebase Authentication（Googleログイン／リダイレクト方式）
   ■ データ : Cloud Firestore
       users/{uid}/cars/{carId}
       users/{uid}/cars/{carId}/fuelLogs/{logId}
       users/{uid}/cars/{carId}/maintenanceLogs/{logId}
       users/{uid}/categories/{categoryId}   … 作業カテゴリマスタ
       users/{uid}/shops/{shopId}            … 店舗マスタ
   同じGoogleアカウントでログインすれば、
   複数デバイスから同じデータをリアルタイムに参照・編集できます。
   ========================================================= */

/* ---------- Firebase SDK（モジュール版）読み込み ---------- */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs, setDoc,
  updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ---------- Firebaseプロジェクト設定 -----------------------
   ⚠️ 下記の値は、Firebaseコンソール（プロジェクトの設定＞
   マイアプリ）で発行される、あなた自身のプロジェクトの値です。
   ----------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyD7fNdMoZBrzBKhQXDnQ2raUHI4KeDN674",
  authDomain: "my-car-manager-daab9.firebaseapp.com",
  projectId: "my-car-manager-daab9",
  storageBucket: "my-car-manager-daab9.firebasestorage.app",
  messagingSenderId: "287236190745",
  appId: "1:287236190745:web:caa18d35701205aa0db088"
};

/* ---------- Firebase 初期化 ---------- */
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

/* 車両の最大登録台数 */
const MAX_CARS = 5;

/* 作業カテゴリの初期シードデータ（カテゴリが1件も無い場合のみ自動投入） */
const DEFAULT_CATEGORIES = [
  'オイル交換', 'タイヤ交換・ローテーション', 'バッテリー交換', 'ブレーキパッド交換',
  'エアフィルター交換', 'ワイパー交換', '車検整備', '定期点検（6ヶ月・12ヶ月）',
  '板金・塗装', '洗車・コーティング', 'その他'
];

/* レシート画像のリサイズ後の最大幅(px) */
const RECEIPT_MAX_WIDTH = 800;

/* =========================================================
   グローバル状態
   ========================================================= */
let currentUser = null;      // ログイン中のFirebaseユーザー
let cars = [];                // 現在ログイン中ユーザーの車両一覧（キャッシュ）
let currentCarId = null;      // 現在選択中の車両ID
let fuelLogs = [];             // 選択中車両の給油記録（キャッシュ）
let maintenanceLogs = [];      // 選択中車両のメンテナンス記録（キャッシュ／全ステータス）
let categories = [];           // 作業カテゴリ一覧（キャッシュ）
let shops = [];                 // 店舗マスタ一覧（キャッシュ）
let currentMaintSubTab = 'active'; // メンテナンスタブ内のサブタブ（active|done）
let pendingReceiptImage = null;     // 給油フォームで撮影中のレシート画像(Base64)

/* Firestoreのリアルタイム購読解除用関数を保持 */
let unsubscribeCars = null;
let unsubscribeFuel = null;
let unsubscribeMaint = null;
let unsubscribeCategories = null;
let unsubscribeShops = null;

/* Chart.js のグラフインスタンス（再描画時に破棄するため保持） */
let monthlyCostChartInstance = null;
let categoryPieChartInstance = null;
let fuelEfficiencyChartInstance = null;

/* =========================================================
   ユーティリティ関数
   ========================================================= */
function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return Number(num).toLocaleString('ja-JP');
}
function formatDate(dateStr) {
  if (!dateStr) return '未設定';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}
/* 満了日ステータス判定（車検・保険用）
   30日以内=赤、31〜60日=黄、61日以上=緑（期限切れも赤） */
function expiryStatus(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return { color: 'slate', label: '未設定', days: null };
  if (days < 0) return { color: 'red', label: `期限切れ (${formatDate(dateStr)})`, days };
  if (days <= 30) return { color: 'red', label: `あと${days}日 (${formatDate(dateStr)})`, days };
  if (days <= 60) return { color: 'yellow', label: `あと${days}日 (${formatDate(dateStr)})`, days };
  return { color: 'green', label: `あと${days}日 (${formatDate(dateStr)})`, days };
}
/* メンテナンス予約の残り日数ステータス判定
   3日以内=赤、4〜7日=黄、8日以上=青、期限超過=赤 */
function reservationStatus(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return { color: 'slate', label: '予約日未設定', days: null };
  if (days < 0) return { color: 'red', label: '期限超過', days };
  if (days <= 3) return { color: 'red', label: `あと${days}日`, days };
  if (days <= 7) return { color: 'yellow', label: `あと${days}日`, days };
  return { color: 'blue', label: `あと${days}日`, days };
}
function colorClasses(color) {
  switch (color) {
    case 'red': return { badge: 'bg-red-100 text-red-700 border border-red-200', dot: 'bg-red-500' };
    case 'yellow': return { badge: 'bg-yellow-100 text-yellow-700 border border-yellow-200', dot: 'bg-yellow-500' };
    case 'green': return { badge: 'bg-green-100 text-green-700 border border-green-200', dot: 'bg-green-500' };
    case 'blue': return { badge: 'bg-blue-100 text-blue-700 border border-blue-200', dot: 'bg-blue-500' };
    default: return { badge: 'bg-slate-100 text-slate-500 border border-slate-200', dot: 'bg-slate-400' };
  }
}
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
/* 電話番号をtel:リンクのHTMLに変換（未入力なら「未登録」） */
function telLinkHtml(phone) {
  if (!phone) return '<span class="text-slate-400">未登録</span>';
  const safe = escapeHtml(phone);
  return `<a href="tel:${safe}" class="text-brand-600 hover:underline">${safe}</a>`;
}
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('opacity-0', 'pointer-events-none');
  toast.classList.add('opacity-100');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toast.classList.remove('opacity-100');
    toast.classList.add('opacity-0', 'pointer-events-none');
  }, 2200);
}
function getCarById(id) {
  return cars.find(c => c.id === id);
}
function getShopById(id) {
  return shops.find(s => s.id === id);
}
function getShopName(id) {
  const shop = getShopById(id);
  return shop ? shop.name : '';
}
/* "YYYY-MM-DD" 形式の日付文字列から "YYYY-MM" を取り出す */
function getMonthKey(dateStr) {
  if (!dateStr) return null;
  return String(dateStr).slice(0, 7);
}
/* 直近12ヶ月分の月キー配列（古い→新しい順）を生成 */
function last12MonthKeys() {
  const keys = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

/* =========================================================
   認証（Googleログイン／ログアウト）
   ---------------------------------------------------------
   ※ iPad/iPhone Safari では signInWithPopup が正しく動作しない
     ことがあるため、signInWithRedirect + getRedirectResult の
     組み合わせに変更している。
   ========================================================= */
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const userInfo = document.getElementById('userInfo');
const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');
const authGate = document.getElementById('authGate');
const appContent = document.getElementById('appContent');
const openCarModalBtn = document.getElementById('openCarModalBtn');

/* 「Googleでログイン」ボタン：リダイレクト方式でログイン開始 */
loginBtn.addEventListener('click', async () => {
  try {
    await signInWithRedirect(auth, googleProvider);
  } catch (e) {
    console.error('ログインエラー:', e);
    showToast('ログインに失敗しました');
    alert("ログインエラー\nコード: " + e.code + "\n内容: " + e.message);
  }
});

/* リダイレクト後にこのページへ戻ってきた際、ログイン結果を取得する */
getRedirectResult(auth)
  .then((result) => {
    if (result && result.user) {
      console.log('リダイレクトログイン成功:', result.user.displayName);
      showToast('ログインしました');
    }
  })
  .catch((error) => {
    console.error('リダイレクトログインエラー:', error);
    alert("ログインエラー\nコード: " + error.code + "\n内容: " + error.message);
  });

/* 「ログアウト」ボタン */
logoutBtn.addEventListener('click', async () => {
  try {
    await signOut(auth);
    showToast('ログアウトしました');
  } catch (e) {
    console.error('ログアウトエラー:', e);
    showToast('ログアウトに失敗しました');
    alert("ログアウトエラー\nコード: " + e.code + "\n内容: " + e.message);
  }
});

/* 認証状態の監視：ログイン／ログアウトでUIとFirestore購読を切り替える */
onAuthStateChanged(auth, (user) => {
  currentUser = user;

  if (user) {
    /* ---- ログイン中のUI表示 ---- */
    loginBtn.classList.add('hidden');
    userInfo.classList.remove('hidden');
    userInfo.classList.add('flex');
    userAvatar.src = user.photoURL || '';
    userName.textContent = user.displayName || user.email || 'ユーザー';
    authGate.classList.add('hidden');
    appContent.classList.remove('hidden');

    /* Firestoreの各種データをリアルタイム購読開始 */
    subscribeToCars();
    subscribeToCategories();
    subscribeToShops();
  } else {
    /* ---- 未ログイン時のUI表示 ---- */
    loginBtn.classList.remove('hidden');
    userInfo.classList.add('hidden');
    userInfo.classList.remove('flex');
    authGate.classList.remove('hidden');
    appContent.classList.add('hidden');
    openCarModalBtn.disabled = true;

    /* 購読解除して状態をリセット（ログイン画面に戻す） */
    if (unsubscribeCars) { unsubscribeCars(); unsubscribeCars = null; }
    if (unsubscribeFuel) { unsubscribeFuel(); unsubscribeFuel = null; }
    if (unsubscribeMaint) { unsubscribeMaint(); unsubscribeMaint = null; }
    if (unsubscribeCategories) { unsubscribeCategories(); unsubscribeCategories = null; }
    if (unsubscribeShops) { unsubscribeShops(); unsubscribeShops = null; }
    cars = [];
    fuelLogs = [];
    maintenanceLogs = [];
    categories = [];
    shops = [];
    currentCarId = null;
  }
});

/* =========================================================
   Firestoreコレクション／ドキュメント参照ヘルパー
   ========================================================= */
function carsCollectionRef() {
  return collection(db, 'users', currentUser.uid, 'cars');
}
function carDocRef(carId) {
  return doc(db, 'users', currentUser.uid, 'cars', carId);
}
function fuelCollectionRef(carId) {
  return collection(db, 'users', currentUser.uid, 'cars', carId, 'fuelLogs');
}
function maintenanceCollectionRef(carId) {
  return collection(db, 'users', currentUser.uid, 'cars', carId, 'maintenanceLogs');
}
function categoriesCollectionRef() {
  return collection(db, 'users', currentUser.uid, 'categories');
}
function categoryDocRef(categoryId) {
  return doc(db, 'users', currentUser.uid, 'categories', categoryId);
}
function shopsCollectionRef() {
  return collection(db, 'users', currentUser.uid, 'shops');
}
function shopDocRef(shopId) {
  return doc(db, 'users', currentUser.uid, 'shops', shopId);
}

/* =========================================================
   車両一覧のリアルタイム購読
   ========================================================= */
function subscribeToCars() {
  if (unsubscribeCars) unsubscribeCars();
  const q = query(carsCollectionRef(), orderBy('createdAt', 'asc'));
  unsubscribeCars = onSnapshot(q, (snapshot) => {
    cars = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    updateAddButtonState();
    renderCarSelector();
    renderCarList();
    ensureCurrentCarValid();
    refreshDetailModalIfOpen();
  }, (err) => {
    console.error('車両データの取得に失敗:', err);
    showToast('車両データの取得に失敗しました');
  });
}

/* 選択中の車両IDが有効かどうかを確認し、必要に応じて選び直す */
function ensureCurrentCarValid() {
  if (!cars.length) {
    currentCarId = null;
    if (unsubscribeFuel) { unsubscribeFuel(); unsubscribeFuel = null; }
    if (unsubscribeMaint) { unsubscribeMaint(); unsubscribeMaint = null; }
    fuelLogs = [];
    maintenanceLogs = [];
    renderFuelTab();
    renderMaintenanceTab();
    return;
  }
  if (!currentCarId || !getCarById(currentCarId)) {
    setCurrentCar(cars[0].id);
  }
}

/* 「＋ 車両を追加」ボタンの有効/無効、登録数ラベルを更新 */
function updateAddButtonState() {
  openCarModalBtn.disabled = !currentUser || cars.length >= MAX_CARS;
  const label = document.getElementById('carCountLabel');
  if (label) label.textContent = `登録車両数: ${cars.length} / ${MAX_CARS}台`;
}

/* =========================================================
   車両：登録／編集モーダル（基本情報）
   ========================================================= */
const carModal = document.getElementById('carModal');
const carForm = document.getElementById('carForm');

function openCarModal(carId = null) {
  carForm.reset();
  document.getElementById('carId').value = '';
  if (carId) {
    const car = getCarById(carId);
    if (!car) return;
    document.getElementById('carModalTitle').textContent = '車両を編集';
    document.getElementById('carId').value = car.id;
    document.getElementById('carNickname').value = car.nickname || '';
    document.getElementById('carMaker').value = car.maker || '';
    document.getElementById('carModel').value = car.model || '';
    document.getElementById('carYear').value = car.year || '';
    document.getElementById('carPlate').value = car.plate || '';
    document.getElementById('carOdo').value = car.currentOdo ?? '';
    document.getElementById('carShaken').value = car.shakenDate || '';
  } else {
    if (cars.length >= MAX_CARS) {
      showToast(`車両は最大${MAX_CARS}台まで登録できます`);
      return;
    }
    document.getElementById('carModalTitle').textContent = '車両を追加';
  }
  carModal.classList.remove('hidden');
  carModal.classList.add('flex');
}
function closeCarModal() {
  carModal.classList.add('hidden');
  carModal.classList.remove('flex');
}

openCarModalBtn.addEventListener('click', () => openCarModal());
document.getElementById('closeCarModalBtn').addEventListener('click', closeCarModal);
document.getElementById('cancelCarModalBtn').addEventListener('click', closeCarModal);
carModal.addEventListener('click', (e) => { if (e.target === carModal) closeCarModal(); });

/* 車両の保存（Firestoreへの追加・更新） */
carForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const id = document.getElementById('carId').value;
  const nickname = document.getElementById('carNickname').value.trim();
  if (!nickname) { showToast('ニックネームを入力してください'); return; }

  const carData = {
    nickname,
    maker: document.getElementById('carMaker').value.trim(),
    model: document.getElementById('carModel').value.trim(),
    year: document.getElementById('carYear').value ? Number(document.getElementById('carYear').value) : null,
    plate: document.getElementById('carPlate').value.trim(),
    currentOdo: document.getElementById('carOdo').value ? Number(document.getElementById('carOdo').value) : 0,
    shakenDate: document.getElementById('carShaken').value || null
  };

  try {
    if (id) {
      /* 既存車両の更新 */
      await updateDoc(carDocRef(id), { ...carData, updatedAt: serverTimestamp() });
      showToast('車両情報を更新しました');
    } else {
      /* 新規車両の追加（5台制限チェック） */
      if (cars.length >= MAX_CARS) {
        showToast(`車両は最大${MAX_CARS}台まで登録できます`);
        return;
      }
      const newDoc = await addDoc(carsCollectionRef(), {
        ...carData,
        jibaiseki: null,
        voluntary: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      setCurrentCar(newDoc.id);
      showToast('車両を追加しました');
    }
    closeCarModal();
  } catch (err) {
    console.error('車両の保存に失敗:', err);
    showToast('車両の保存に失敗しました');
  }
});

/* 車両削除（サブコレクションの給油・メンテナンス記録も合わせて削除） */
async function deleteCar(carId) {
  const car = getCarById(carId);
  if (!car) return;
  if (!confirm(`「${car.nickname}」を削除します。関連する給油・メンテナンス記録も全て削除されます。よろしいですか？`)) return;

  try {
    /* 給油記録を全削除 */
    const fuelSnap = await getDocs(fuelCollectionRef(carId));
    await Promise.all(fuelSnap.docs.map(d => deleteDoc(d.ref)));
    /* メンテナンス記録を全削除 */
    const maintSnap = await getDocs(maintenanceCollectionRef(carId));
    await Promise.all(maintSnap.docs.map(d => deleteDoc(d.ref)));
    /* 車両ドキュメント自体を削除 */
    await deleteDoc(carDocRef(carId));

    closeCarDetailModal();
    showToast('車両を削除しました');
  } catch (err) {
    console.error('車両の削除に失敗:', err);
    showToast('車両の削除に失敗しました');
  }
}

function setCurrentCar(carId) {
  currentCarId = carId;
  renderCarSelector();
  subscribeToFuelLogs(carId);
  subscribeToMaintenanceLogs(carId);
}

function renderCarSelector() {
  const select = document.getElementById('carFilterSelect');
  select.innerHTML = '';
  if (!cars.length) {
    const opt = document.createElement('option');
    opt.textContent = '車両が登録されていません';
    opt.value = '';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  cars.forEach(car => {
    const opt = document.createElement('option');
    opt.value = car.id;
    opt.textContent = `${car.nickname}${car.maker || car.model ? ' (' + [car.maker, car.model].filter(Boolean).join(' ') + ')' : ''}`;
    if (car.id === currentCarId) opt.selected = true;
    select.appendChild(opt);
  });
}
document.getElementById('carFilterSelect').addEventListener('change', (e) => {
  setCurrentCar(e.target.value);
});

/* =========================================================
   車両一覧カードの描画
   ========================================================= */
function renderCarList() {
  const listEl = document.getElementById('carList');
  const emptyEl = document.getElementById('carListEmpty');
  listEl.innerHTML = '';
  if (!cars.length) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  cars.forEach(car => {
    const shakenStatus = expiryStatus(car.shakenDate);
    const jibaisekiStatus = expiryStatus(car.jibaiseki && car.jibaiseki.expiryDate);
    const voluntaryStatus = expiryStatus(car.voluntary && car.voluntary.expiryDate);
    const shakenC = colorClasses(shakenStatus.color);
    const jibaisekiC = colorClasses(jibaisekiStatus.color);
    const voluntaryC = colorClasses(voluntaryStatus.color);
    const isActive = car.id === currentCarId;

    const card = document.createElement('article');
    card.className = `bg-white rounded-xl shadow-sm p-4 border-2 transition ${isActive ? 'border-brand-500' : 'border-transparent'}`;
    card.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="font-bold text-lg text-slate-800 truncate">${escapeHtml(car.nickname)}</h3>
            ${isActive ? '<span class="text-xs bg-brand-600 text-white px-2 py-0.5 rounded-full whitespace-nowrap">選択中</span>' : ''}
          </div>
          <p class="text-sm text-slate-500 truncate">${escapeHtml([car.maker, car.model].filter(Boolean).join(' ') || '車種未登録')} ${car.year ? '・' + escapeHtml(car.year) + '年' : ''}</p>
          <p class="text-xs text-slate-400 truncate">${escapeHtml(car.plate) || 'ナンバー未登録'}</p>
        </div>
        <div class="flex gap-1 shrink-0">
          <button class="select-car-btn text-xs bg-slate-100 hover:bg-brand-100 text-slate-600 px-2 py-1 rounded-lg" data-id="${car.id}">選択</button>
          <button class="detail-car-btn text-xs bg-slate-100 hover:bg-brand-100 text-slate-600 px-2 py-1 rounded-lg" data-id="${car.id}">詳細</button>
          <button class="delete-car-btn text-slate-400 hover:text-red-500 p-1" data-id="${car.id}" title="削除">🗑️</button>
        </div>
      </div>
      <div class="mt-3 flex items-center gap-2 text-sm text-slate-600">
        <span>🛣️ 現在の走行距離:</span>
        <span class="font-bold">${formatNumber(car.currentOdo)} km</span>
      </div>
      <div class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div class="rounded-lg px-3 py-2 text-xs font-medium ${shakenC.badge}">
          <span class="inline-block w-2 h-2 rounded-full ${shakenC.dot} mr-1"></span>
          車検: ${shakenStatus.label}
        </div>
        <div class="rounded-lg px-3 py-2 text-xs font-medium ${jibaisekiC.badge}">
          <span class="inline-block w-2 h-2 rounded-full ${jibaisekiC.dot} mr-1"></span>
          自賠責: ${jibaisekiStatus.label}
        </div>
        <div class="rounded-lg px-3 py-2 text-xs font-medium ${voluntaryC.badge}">
          <span class="inline-block w-2 h-2 rounded-full ${voluntaryC.dot} mr-1"></span>
          任意保険: ${voluntaryStatus.label}
        </div>
      </div>
    `;
    listEl.appendChild(card);
  });

  listEl.querySelectorAll('.select-car-btn').forEach(btn =>
    btn.addEventListener('click', () => setCurrentCar(btn.dataset.id))
  );
  listEl.querySelectorAll('.detail-car-btn').forEach(btn =>
    btn.addEventListener('click', () => openCarDetailModal(btn.dataset.id))
  );
  listEl.querySelectorAll('.delete-car-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteCar(btn.dataset.id))
  );
}

/* =========================================================
   車両詳細モーダル（基本情報／保険情報／費用分析タブ）
   ========================================================= */
const carDetailModal = document.getElementById('carDetailModal');
let detailCarId = null; // 現在詳細モーダルで表示中の車両ID

function openCarDetailModal(carId) {
  const car = getCarById(carId);
  if (!car) return;
  detailCarId = carId;
  document.getElementById('carDetailTitle').textContent = `${car.nickname} の詳細`;
  renderDetailBasicPanel(car);
  renderDetailInsurancePanel(car);
  switchDetailTab('basic');
  carDetailModal.classList.remove('hidden');
  carDetailModal.classList.add('flex');
}
function closeCarDetailModal() {
  carDetailModal.classList.add('hidden');
  carDetailModal.classList.remove('flex');
  detailCarId = null;
}
document.getElementById('closeCarDetailModalBtn').addEventListener('click', closeCarDetailModal);
carDetailModal.addEventListener('click', (e) => { if (e.target === carDetailModal) closeCarDetailModal(); });

/* 詳細モーダル表示中に、Firestoreの最新データで内容を更新する */
function refreshDetailModalIfOpen() {
  if (!detailCarId) return;
  const car = getCarById(detailCarId);
  if (!car) { closeCarDetailModal(); return; }
  renderDetailBasicPanel(car);
  renderDetailInsurancePanel(car);
}

/* 詳細モーダル内のサブタブ切り替え（基本情報／保険情報／費用分析） */
document.querySelectorAll('.detail-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchDetailTab(btn.dataset.detailTab));
});
function switchDetailTab(tabName) {
  document.querySelectorAll('.detail-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.detailTab === tabName);
  });
  document.getElementById('detailBasicPanel').classList.toggle('hidden', tabName !== 'basic');
  document.getElementById('detailInsurancePanel').classList.toggle('hidden', tabName !== 'insurance');
  document.getElementById('detailCostPanel').classList.toggle('hidden', tabName !== 'cost');
  if (tabName === 'cost' && detailCarId) {
    renderCostAnalysis(detailCarId);
  }
}

/* 基本情報パネルの描画 */
function renderDetailBasicPanel(car) {
  document.getElementById('detailMakerModel').textContent = [car.maker, car.model].filter(Boolean).join(' ') || '未登録';
  document.getElementById('detailYear').textContent = car.year ? `${car.year}年` : '未登録';
  document.getElementById('detailPlate').textContent = car.plate || '未登録';
  document.getElementById('detailOdo').textContent = `${formatNumber(car.currentOdo)} km`;

  const shakenStatus = expiryStatus(car.shakenDate);
  const jibaisekiStatus = expiryStatus(car.jibaiseki && car.jibaiseki.expiryDate);
  const voluntaryStatus = expiryStatus(car.voluntary && car.voluntary.expiryDate);
  const shakenC = colorClasses(shakenStatus.color);
  const jibaisekiC = colorClasses(jibaisekiStatus.color);
  const voluntaryC = colorClasses(voluntaryStatus.color);

  const shakenBadge = document.getElementById('detailShakenBadge');
  shakenBadge.className = `rounded-lg px-3 py-2 text-xs font-medium ${shakenC.badge}`;
  shakenBadge.innerHTML = `<span class="inline-block w-2 h-2 rounded-full ${shakenC.dot} mr-1"></span>車検: ${shakenStatus.label}`;

  const jibaisekiBadge = document.getElementById('detailJibaisekiBadge');
  jibaisekiBadge.className = `rounded-lg px-3 py-2 text-xs font-medium ${jibaisekiC.badge}`;
  jibaisekiBadge.innerHTML = `<span class="inline-block w-2 h-2 rounded-full ${jibaisekiC.dot} mr-1"></span>自賠責: ${jibaisekiStatus.label}`;

  const insuranceBadge = document.getElementById('detailInsuranceBadge');
  insuranceBadge.className = `rounded-lg px-3 py-2 text-xs font-medium ${voluntaryC.badge}`;
  insuranceBadge.innerHTML = `<span class="inline-block w-2 h-2 rounded-full ${voluntaryC.dot} mr-1"></span>任意保険: ${voluntaryStatus.label}`;
}
document.getElementById('detailEditBtn').addEventListener('click', () => {
  const id = detailCarId;
  closeCarDetailModal();
  openCarModal(id);
});
document.getElementById('detailDeleteBtn').addEventListener('click', () => {
  if (detailCarId) deleteCar(detailCarId);
});

/* 保険情報パネルの描画（サマリー表示＋フォームへの値反映） */
function renderDetailInsurancePanel(car) {
  /* --- 自賠責保険 --- */
  const jibaiseki = car.jibaiseki || {};
  const jibaisekiStatus = expiryStatus(jibaiseki.expiryDate);
  document.getElementById('jibaisekiSummary').innerHTML = jibaiseki.company
    ? `${escapeHtml(jibaiseki.company)}（証券番号: ${escapeHtml(jibaiseki.policyNo) || '未登録'}）／ 満了日: ${jibaisekiStatus.label}`
    : '未登録';
  document.getElementById('jibaisekiCompany').value = jibaiseki.company || '';
  document.getElementById('jibaisekiPolicyNo').value = jibaiseki.policyNo || '';
  document.getElementById('jibaisekiExpiry').value = jibaiseki.expiryDate || '';

  /* --- 任意保険 --- */
  const vi = car.voluntary || {};
  const viStatus = expiryStatus(vi.expiryDate);
  const viSummaryEl = document.getElementById('viSummary');
  if (vi.company) {
    viSummaryEl.innerHTML = `
      <div>保険会社: ${escapeHtml(vi.company)}（証券番号: ${escapeHtml(vi.policyNo) || '未登録'}）</div>
      <div>担当者: ${escapeHtml(vi.agentName) || '未登録'} / 電話: ${telLinkHtml(vi.agentPhone)}</div>
      <div>代理店: ${escapeHtml(vi.agencyName) || '未登録'} / 電話: ${telLinkHtml(vi.agencyPhone)}</div>
      <div>満了日: ${viStatus.label}　年間保険料: ${vi.premium ? '¥' + formatNumber(vi.premium) : '未登録'}</div>
      <div>補償内容: ${escapeHtml(vi.memo) || '未登録'}</div>
    `;
  } else {
    viSummaryEl.textContent = '未登録';
  }
  document.getElementById('viCompany').value = vi.company || '';
  document.getElementById('viPolicyNo').value = vi.policyNo || '';
  document.getElementById('viAgentName').value = vi.agentName || '';
  document.getElementById('viAgentPhone').value = vi.agentPhone || '';
  document.getElementById('viAgencyName').value = vi.agencyName || '';
  document.getElementById('viAgencyPhone').value = vi.agencyPhone || '';
  document.getElementById('viMemo').value = vi.memo || '';
  document.getElementById('viExpiry').value = vi.expiryDate || '';
  document.getElementById('viPremium').value = vi.premium ?? '';
}

/* 自賠責保険フォームの保存 */
document.getElementById('jibaisekiForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!detailCarId) return;
  const jibaiseki = {
    company: document.getElementById('jibaisekiCompany').value.trim(),
    policyNo: document.getElementById('jibaisekiPolicyNo').value.trim(),
    expiryDate: document.getElementById('jibaisekiExpiry').value || null
  };
  try {
    await updateDoc(carDocRef(detailCarId), { jibaiseki, updatedAt: serverTimestamp() });
    showToast('自賠責保険の情報を保存しました');
  } catch (err) {
    console.error('自賠責情報の保存に失敗:', err);
    showToast('自賠責情報の保存に失敗しました');
  }
});

/* 任意保険フォームの保存 */
document.getElementById('voluntaryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!detailCarId) return;
  const voluntary = {
    company: document.getElementById('viCompany').value.trim(),
    policyNo: document.getElementById('viPolicyNo').value.trim(),
    agentName: document.getElementById('viAgentName').value.trim(),
    agentPhone: document.getElementById('viAgentPhone').value.trim(),
    agencyName: document.getElementById('viAgencyName').value.trim(),
    agencyPhone: document.getElementById('viAgencyPhone').value.trim(),
    memo: document.getElementById('viMemo').value.trim(),
    expiryDate: document.getElementById('viExpiry').value || null,
    premium: document.getElementById('viPremium').value ? Number(document.getElementById('viPremium').value) : null
  };
  try {
    await updateDoc(carDocRef(detailCarId), { voluntary, updatedAt: serverTimestamp() });
    showToast('任意保険の情報を保存しました');
    refreshDetailModalIfOpen();
  } catch (err) {
    console.error('任意保険情報の保存に失敗:', err);
    showToast('任意保険情報の保存に失敗しました');
  }
});

/* =========================================================
   費用分析タブ（Chart.jsによるグラフ描画）
   ========================================================= */
/* 指定車両の給油記録・メンテナンス記録を取得し、グラフと年間維持費カードを更新する */
async function renderCostAnalysis(carId) {
  const car = getCarById(carId);
  if (!car) return;

  let fuelSnap, maintSnap;
  try {
    fuelSnap = await getDocs(fuelCollectionRef(carId));
    maintSnap = await getDocs(maintenanceCollectionRef(carId));
  } catch (err) {
    console.error('費用分析データの取得に失敗:', err);
    showToast('費用分析データの取得に失敗しました');
    return;
  }

  const allFuel = fuelSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const allMaint = maintSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const doneMaint = allMaint.filter(m => m.status === '完了');

  const monthKeys = last12MonthKeys();

  /* --- 月別費用の集計（燃料費／完了済みメンテ費用） --- */
  const fuelByMonth = {};
  const maintByMonth = {};
  monthKeys.forEach(k => { fuelByMonth[k] = 0; maintByMonth[k] = 0; });

  allFuel.forEach(f => {
    const key = getMonthKey(f.date);
    if (key && fuelByMonth.hasOwnProperty(key)) {
      fuelByMonth[key] += Number(f.price) || 0;
    }
  });
  doneMaint.forEach(m => {
    const key = getMonthKey(m.actualDate || m.date);
    const cost = Number(m.actualCost ?? m.cost) || 0;
    if (key && maintByMonth.hasOwnProperty(key)) {
      maintByMonth[key] += cost;
    }
  });

  const monthLabels = monthKeys.map(k => {
    const [y, m] = k.split('-');
    return `${y}/${m}`;
  });
  const fuelMonthData = monthKeys.map(k => fuelByMonth[k]);
  const maintMonthData = monthKeys.map(k => maintByMonth[k]);

  /* --- カテゴリ別費用内訳（完了済みメンテのみ／全期間） --- */
  const categoryTotals = {};
  doneMaint.forEach(m => {
    const cat = m.category || 'その他';
    const cost = Number(m.actualCost ?? m.cost) || 0;
    categoryTotals[cat] = (categoryTotals[cat] || 0) + cost;
  });
  const categoryLabels = Object.keys(categoryTotals);
  const categoryData = categoryLabels.map(k => categoryTotals[k]);

  /* --- 燃費推移（日付昇順） --- */
  const fuelSorted = allFuel
    .filter(f => f.efficiency !== null && f.efficiency !== undefined)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const effLabels = fuelSorted.map(f => formatDate(f.date));
  const effData = fuelSorted.map(f => Number(f.efficiency));

  /* --- 年間維持費（直近12ヶ月の燃料費＋完了済みメンテ費用＋年間保険料） --- */
  const annualFuelCost = fuelMonthData.reduce((a, b) => a + b, 0);
  const annualMaintCost = maintMonthData.reduce((a, b) => a + b, 0);
  const annualInsuranceCost = Number(car.voluntary && car.voluntary.premium) || 0;
  const annualTotal = annualFuelCost + annualMaintCost + annualInsuranceCost;

  document.getElementById('annualCostValue').textContent = `¥${formatNumber(annualTotal)}`;
  document.getElementById('annualFuelCost').textContent = `¥${formatNumber(annualFuelCost)}`;
  document.getElementById('annualMaintCost').textContent = `¥${formatNumber(annualMaintCost)}`;
  document.getElementById('annualInsuranceCost').textContent = `¥${formatNumber(annualInsuranceCost)}`;

  /* --- グラフ描画（既存インスタンスがあれば破棄してから再生成） --- */
  if (typeof Chart === 'undefined') {
    console.error('Chart.jsが読み込まれていません');
    return;
  }

  if (monthlyCostChartInstance) monthlyCostChartInstance.destroy();
  monthlyCostChartInstance = new Chart(document.getElementById('monthlyCostChart'), {
    type: 'bar',
    data: {
      labels: monthLabels,
      datasets: [
        { label: '燃料費', data: fuelMonthData, backgroundColor: '#60a5fa', stack: 'cost' },
        { label: 'メンテ費用', data: maintMonthData, backgroundColor: '#f59e0b', stack: 'cost' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }
    }
  });

  if (categoryPieChartInstance) categoryPieChartInstance.destroy();
  categoryPieChartInstance = new Chart(document.getElementById('categoryPieChart'), {
    type: 'pie',
    data: {
      labels: categoryLabels.length ? categoryLabels : ['データなし'],
      datasets: [{
        data: categoryData.length ? categoryData : [1],
        backgroundColor: ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#64748b', '#a855f7']
      }]
    },
    options: { responsive: true, maintainAspectRatio: false }
  });

  if (fuelEfficiencyChartInstance) fuelEfficiencyChartInstance.destroy();
  fuelEfficiencyChartInstance = new Chart(document.getElementById('fuelEfficiencyChart'), {
    type: 'line',
    data: {
      labels: effLabels,
      datasets: [{
        label: '燃費(km/L)', data: effData,
        borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.15)',
        tension: 0.3, fill: true
      }]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
  });
}

/* =========================================================
   タブ切り替え（車両一覧／給油記録／メンテナンス／設定）
   ========================================================= */
const tabButtons = document.querySelectorAll('.tab-btn');
const tabSections = {
  cars: document.getElementById('tab-cars'),
  fuel: document.getElementById('tab-fuel'),
  maintenance: document.getElementById('tab-maintenance'),
  settings: document.getElementById('tab-settings')
};
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    Object.entries(tabSections).forEach(([key, el]) => {
      el.classList.toggle('hidden', key !== btn.dataset.tab);
    });
    if (btn.dataset.tab === 'fuel') renderFuelTab();
    if (btn.dataset.tab === 'maintenance') renderMaintenanceTab();
    if (btn.dataset.tab === 'settings') renderSettingsTab();
  });
});

/* =========================================================
   給油記録
   ========================================================= */
const fuelForm = document.getElementById('fuelForm');
const fuelReceiptInput = document.getElementById('fuelReceiptInput');
const fuelReceiptBtn = document.getElementById('fuelReceiptBtn');
const fuelReceiptPreview = document.getElementById('fuelReceiptPreview');
const fuelReceiptClearBtn = document.getElementById('fuelReceiptClearBtn');

/* 「📷レシートを撮影」ボタン → 隠しファイル入力をクリック */
fuelReceiptBtn.addEventListener('click', () => fuelReceiptInput.click());

/* 撮影／選択された画像をcanvasでリサイズ・圧縮してBase64化する */
fuelReceiptInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (readerEvent) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, RECEIPT_MAX_WIDTH / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      /* JPEG形式・品質0.7程度に圧縮してBase64文字列を生成 */
      pendingReceiptImage = canvas.toDataURL('image/jpeg', 0.7);
      fuelReceiptPreview.src = pendingReceiptImage;
      fuelReceiptPreview.classList.remove('hidden');
      fuelReceiptClearBtn.classList.remove('hidden');
    };
    img.src = readerEvent.target.result;
  };
  reader.readAsDataURL(file);
});

/* レシート画像の選択を取り消す */
fuelReceiptClearBtn.addEventListener('click', () => {
  pendingReceiptImage = null;
  fuelReceiptInput.value = '';
  fuelReceiptPreview.classList.add('hidden');
  fuelReceiptClearBtn.classList.add('hidden');
});

/* Firestoreの給油記録をリアルタイム購読 */
function subscribeToFuelLogs(carId) {
  if (unsubscribeFuel) unsubscribeFuel();
  const q = query(fuelCollectionRef(carId), orderBy('odo', 'desc'));
  unsubscribeFuel = onSnapshot(q, (snapshot) => {
    fuelLogs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFuelTable();
  }, (err) => {
    console.error('給油記録の取得に失敗:', err);
    showToast('給油記録の取得に失敗しました');
  });
}

/* 給油記録タブ全体の表示切り替え（対象車両の有無で分岐） */
function renderFuelTab() {
  const noCarEl = document.getElementById('fuelNoCar');
  const contentEl = document.getElementById('fuelContent');
  if (!currentCarId || !getCarById(currentCarId)) {
    noCarEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    return;
  }
  noCarEl.classList.add('hidden');
  contentEl.classList.remove('hidden');
  renderFuelShopOptions();
  renderFuelTable();
  initFuelFormDefaults();
}

/* 給油フォームの店舗プルダウンを店舗マスタから再構築 */
function renderFuelShopOptions() {
  const select = document.getElementById('fuelShop');
  const current = select.value;
  select.innerHTML = '<option value="">未選択</option>';
  shops.forEach(shop => {
    const opt = document.createElement('option');
    opt.value = shop.id;
    opt.textContent = shop.name;
    select.appendChild(opt);
  });
  if (shops.some(s => s.id === current)) select.value = current;
}

/* フォームの初期値設定（日付=今日、ODOのプレースホルダー=現在値） */
function initFuelFormDefaults() {
  const car = getCarById(currentCarId);
  if (!car) return;
  document.getElementById('fuelDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('fuelOdo').placeholder = `現在: ${formatNumber(car.currentOdo)} km`;
}

/* 給油記録テーブルの描画（一覧の再描画のみ、フォームは変更しない） */
function renderFuelTable() {
  const tbody = document.getElementById('fuelTableBody');
  const emptyRow = document.getElementById('fuelEmptyRow');
  tbody.innerHTML = '';

  if (!fuelLogs.length) {
    emptyRow.classList.remove('hidden');
    return;
  }
  emptyRow.classList.add('hidden');

  fuelLogs.forEach(log => {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-slate-100 hover:bg-slate-50';
    const efficiencyText = (log.efficiency !== null && log.efficiency !== undefined)
      ? Number(log.efficiency).toFixed(2)
      : '-';
    const thumbHtml = log.receiptImage
      ? `<img src="${log.receiptImage}" class="receipt-thumb receipt-thumb-open mx-auto" data-src="${log.receiptImage}" alt="レシート画像">`
      : '<span class="text-slate-300">-</span>';
    tr.innerHTML = `
      <td class="px-3 py-2 whitespace-nowrap">${formatDate(log.date)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${formatNumber(log.odo)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${Number(log.liters).toFixed(2)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">¥${formatNumber(log.price)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(log.shopName) || '-'}</td>
      <td class="px-3 py-2 text-center whitespace-nowrap">${log.isFull ? '✅' : '—'}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap font-semibold ${log.efficiency ? 'text-brand-700' : 'text-slate-400'}">${efficiencyText}</td>
      <td class="px-3 py-2 text-center whitespace-nowrap">${thumbHtml}</td>
      <td class="px-3 py-2 text-center whitespace-nowrap">
        <button class="delete-fuel-btn text-slate-400 hover:text-red-500" data-id="${log.id}" title="削除">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.delete-fuel-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteFuelLog(btn.dataset.id))
  );
  tbody.querySelectorAll('.receipt-thumb-open').forEach(img =>
    img.addEventListener('click', () => openReceiptLightbox(img.dataset.src))
  );
}

/* レシート画像の拡大表示（ライトボックス） */
const receiptLightbox = document.getElementById('receiptLightbox');
const receiptLightboxImg = document.getElementById('receiptLightboxImg');
function openReceiptLightbox(src) {
  if (!src) return;
  receiptLightboxImg.src = src;
  receiptLightbox.classList.remove('hidden');
  receiptLightbox.classList.add('flex');
}
function closeReceiptLightbox() {
  receiptLightbox.classList.add('hidden');
  receiptLightbox.classList.remove('flex');
  receiptLightboxImg.src = '';
}
document.getElementById('closeReceiptLightboxBtn').addEventListener('click', closeReceiptLightbox);
receiptLightbox.addEventListener('click', (e) => { if (e.target === receiptLightbox) closeReceiptLightbox(); });

/* 給油記録の追加（燃費自動計算＋車両の現在走行距離を更新） */
fuelForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentCarId) return;
  const car = getCarById(currentCarId);
  const date = document.getElementById('fuelDate').value;
  const odo = Number(document.getElementById('fuelOdo').value);
  const liters = Number(document.getElementById('fuelLiters').value);
  const price = Number(document.getElementById('fuelPrice').value);
  const isFull = document.getElementById('fuelFull').checked;
  const shopId = document.getElementById('fuelShop').value || null;
  const shopName = shopId ? getShopName(shopId) : '';

  if (!date || isNaN(odo) || isNaN(liters) || isNaN(price)) {
    showToast('入力内容を確認してください');
    return;
  }

  /* 前回の給油記録（この車の全記録中、ODOが直前で最も近いもの）から燃費を計算 */
  let prevLog = null;
  fuelLogs.forEach(l => {
    if (l.odo < odo && (!prevLog || l.odo > prevLog.odo)) prevLog = l;
  });

  let efficiency = null;
  if (prevLog) {
    const distance = odo - prevLog.odo;
    if (distance > 0 && liters > 0) {
      efficiency = distance / liters; // km/L
    }
  }

  try {
    await addDoc(fuelCollectionRef(currentCarId), {
      date, odo, liters, price, isFull, efficiency,
      shopId, shopName,
      receiptImage: pendingReceiptImage || null, // Firebase Storageは使わずBase64を直接保存
      createdAt: serverTimestamp()
    });

    /* 車両の現在の走行距離を更新（給油記録のODOが現在値より大きい場合のみ） */
    if (!car.currentOdo || odo > car.currentOdo) {
      await updateDoc(carDocRef(currentCarId), { currentOdo: odo, updatedAt: serverTimestamp() });
    }

    fuelForm.reset();
    document.getElementById('fuelFull').checked = true;
    pendingReceiptImage = null;
    fuelReceiptPreview.classList.add('hidden');
    fuelReceiptClearBtn.classList.add('hidden');
    initFuelFormDefaults();
    renderFuelShopOptions();
    showToast('給油記録を追加しました');
  } catch (err) {
    console.error('給油記録の追加に失敗:', err);
    showToast('給油記録の追加に失敗しました');
  }
});

async function deleteFuelLog(id) {
  if (!confirm('この給油記録を削除しますか？')) return;
  try {
    await deleteDoc(doc(fuelCollectionRef(currentCarId), id));
    showToast('給油記録を削除しました');
  } catch (err) {
    console.error('給油記録の削除に失敗:', err);
    showToast('給油記録の削除に失敗しました');
  }
}

/* =========================================================
   メンテナンス記録（予約ステータス管理）
   ========================================================= */

/* メンテナンスタブ内のサブタブ（予約中・進行中／完了済み）切り替え */
document.querySelectorAll('.maint-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentMaintSubTab = btn.dataset.maintTab;
    document.querySelectorAll('.maint-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.maintTab === currentMaintSubTab));
    document.getElementById('maintActivePanel').classList.toggle('hidden', currentMaintSubTab !== 'active');
    document.getElementById('maintDonePanel').classList.toggle('hidden', currentMaintSubTab !== 'done');
  });
});

/* Firestoreのメンテナンス記録をリアルタイム購読（全ステータスを一括取得） */
function subscribeToMaintenanceLogs(carId) {
  if (unsubscribeMaint) unsubscribeMaint();
  const q = query(maintenanceCollectionRef(carId), orderBy('createdAt', 'desc'));
  unsubscribeMaint = onSnapshot(q, (snapshot) => {
    maintenanceLogs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMaintenanceTable();
  }, (err) => {
    console.error('メンテナンス記録の取得に失敗:', err);
    showToast('メンテナンス記録の取得に失敗しました');
  });
}

function renderMaintenanceTab() {
  const noCarEl = document.getElementById('maintNoCar');
  const contentEl = document.getElementById('maintContent');
  if (!currentCarId || !getCarById(currentCarId)) {
    noCarEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    return;
  }
  noCarEl.classList.add('hidden');
  contentEl.classList.remove('hidden');
  renderMaintenanceTable();
}

/* 予約中・進行中／完了済みの2種類のビューを再描画 */
function renderMaintenanceTable() {
  renderMaintActiveList();
  renderMaintDoneTable();
}

/* 「予約中・進行中」カード一覧の描画（status !== '完了'） */
function renderMaintActiveList() {
  const listEl = document.getElementById('maintActiveList');
  const emptyEl = document.getElementById('maintActiveEmpty');
  if (!listEl) return;
  const activeLogs = maintenanceLogs.filter(m => m.status !== '完了');
  listEl.innerHTML = '';
  if (!activeLogs.length) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  activeLogs.forEach(log => {
    const st = reservationStatus(log.reserveDate);
    const c = colorClasses(st.color);
    const card = document.createElement('article');
    card.className = 'bg-white rounded-xl shadow-sm p-4 space-y-2';
    card.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h4 class="font-bold text-slate-800">${escapeHtml(log.category) || 'カテゴリ未設定'}</h4>
          <p class="text-xs text-slate-500">${formatDate(log.reserveDate)}${log.reserveTime ? ' ' + escapeHtml(log.reserveTime) : ''}</p>
        </div>
        <span class="rounded-lg px-2 py-1 text-xs font-medium whitespace-nowrap ${c.badge}">
          <span class="inline-block w-2 h-2 rounded-full ${c.dot} mr-1"></span>${st.label}
        </span>
      </div>
      <div class="text-xs text-slate-500 space-y-0.5">
        <div>🏬 店舗: ${escapeHtml(log.shopName) || '未設定'}</div>
        <div>🙋 担当者: ${escapeHtml(log.person) || '未設定'}</div>
        ${log.notes ? `<div>📝 ${escapeHtml(log.notes)}</div>` : ''}
      </div>
      <div class="flex gap-2 pt-1">
        <button class="maint-complete-btn flex-1 bg-green-50 hover:bg-green-100 text-green-700 font-semibold text-xs py-2 rounded-lg transition" data-id="${log.id}">✅完了にする</button>
        <button class="delete-maint-btn text-slate-400 hover:text-red-500 px-2" data-id="${log.id}" title="削除">🗑️</button>
      </div>
    `;
    listEl.appendChild(card);
  });

  listEl.querySelectorAll('.maint-complete-btn').forEach(btn =>
    btn.addEventListener('click', () => openMaintCompleteModal(btn.dataset.id))
  );
  listEl.querySelectorAll('.delete-maint-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteMaintenanceLog(btn.dataset.id))
  );
}

/* 「完了済み」テーブルの描画（status === '完了'） */
function renderMaintDoneTable() {
  const tbody = document.getElementById('maintDoneTableBody');
  const emptyEl = document.getElementById('maintDoneEmpty');
  if (!tbody) return;
  const doneLogs = maintenanceLogs.filter(m => m.status === '完了');
  tbody.innerHTML = '';
  if (!doneLogs.length) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  doneLogs.forEach(log => {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-slate-100 hover:bg-slate-50';
    const cost = log.actualCost ?? log.cost;
    tr.innerHTML = `
      <td class="px-3 py-2 whitespace-nowrap">${formatDate(log.actualDate)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${formatNumber(log.actualOdo)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(log.category)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(log.shopName) || '-'}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${cost ? '¥' + formatNumber(cost) : '-'}</td>
      <td class="px-3 py-2 max-w-[200px] truncate" title="${escapeHtml(log.workDone)}">${escapeHtml(log.workDone) || '-'}</td>
      <td class="px-3 py-2 whitespace-nowrap">${log.nextDate ? formatDate(log.nextDate) : '-'}</td>
      <td class="px-3 py-2 text-center whitespace-nowrap">
        <button class="delete-maint-btn text-slate-400 hover:text-red-500" data-id="${log.id}" title="削除">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.delete-maint-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteMaintenanceLog(btn.dataset.id))
  );
}

async function deleteMaintenanceLog(id) {
  if (!confirm('このメンテナンス記録を削除しますか？')) return;
  try {
    await deleteDoc(doc(maintenanceCollectionRef(currentCarId), id));
    showToast('メンテナンス記録を削除しました');
  } catch (err) {
    console.error('メンテナンス記録の削除に失敗:', err);
    showToast('メンテナンス記録の削除に失敗しました');
  }
}

/* ---------- ＋新規予約モーダル ---------- */
const maintReserveModal = document.getElementById('maintReserveModal');
const maintReserveForm = document.getElementById('maintReserveForm');

document.getElementById('openMaintReserveBtn').addEventListener('click', () => {
  if (!currentCarId) { showToast('先に車両を選択してください'); return; }
  maintReserveForm.reset();
  renderMaintReserveOptions();
  document.getElementById('maintResDate').value = new Date().toISOString().slice(0, 10);
  maintReserveModal.classList.remove('hidden');
  maintReserveModal.classList.add('flex');
});
function closeMaintReserveModal() {
  maintReserveModal.classList.add('hidden');
  maintReserveModal.classList.remove('flex');
}
document.getElementById('closeMaintReserveModalBtn').addEventListener('click', closeMaintReserveModal);
document.getElementById('cancelMaintReserveBtn').addEventListener('click', closeMaintReserveModal);
maintReserveModal.addEventListener('click', (e) => { if (e.target === maintReserveModal) closeMaintReserveModal(); });

/* 予約モーダルのカテゴリ／店舗プルダウンをマスタから再構築 */
function renderMaintReserveOptions() {
  const catSelect = document.getElementById('maintResCategory');
  catSelect.innerHTML = '';
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.name;
    opt.textContent = cat.name;
    catSelect.appendChild(opt);
  });
  const shopSelect = document.getElementById('maintResShop');
  shopSelect.innerHTML = '<option value="">未選択</option>';
  shops.forEach(shop => {
    const opt = document.createElement('option');
    opt.value = shop.id;
    opt.textContent = shop.name;
    shopSelect.appendChild(opt);
  });
}

maintReserveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentCarId) return;
  const category = document.getElementById('maintResCategory').value;
  const reserveDate = document.getElementById('maintResDate').value;
  const reserveTime = document.getElementById('maintResTime').value;
  const shopId = document.getElementById('maintResShop').value || null;
  const shopName = shopId ? getShopName(shopId) : '';
  const person = document.getElementById('maintResPerson').value.trim();
  const notes = document.getElementById('maintResNotes').value.trim();

  if (!category || !reserveDate) {
    showToast('入力内容を確認してください');
    return;
  }

  try {
    await addDoc(maintenanceCollectionRef(currentCarId), {
      status: '予約済み',
      category, reserveDate, reserveTime, shopId, shopName, person, notes,
      createdAt: serverTimestamp()
    });
    closeMaintReserveModal();
    showToast('メンテナンス予約を登録しました');
  } catch (err) {
    console.error('メンテナンス予約の登録に失敗:', err);
    showToast('メンテナンス予約の登録に失敗しました');
  }
});

/* ---------- 完了にするモーダル ---------- */
const maintCompleteModal = document.getElementById('maintCompleteModal');
const maintCompleteForm = document.getElementById('maintCompleteForm');

function openMaintCompleteModal(logId) {
  const log = maintenanceLogs.find(m => m.id === logId);
  if (!log) return;
  maintCompleteForm.reset();
  document.getElementById('maintCompleteId').value = logId;
  document.getElementById('maintActualDate').value = new Date().toISOString().slice(0, 10);
  const car = getCarById(currentCarId);
  if (car && car.currentOdo) {
    document.getElementById('maintActualOdo').value = car.currentOdo;
  }
  maintCompleteModal.classList.remove('hidden');
  maintCompleteModal.classList.add('flex');
}
function closeMaintCompleteModal() {
  maintCompleteModal.classList.add('hidden');
  maintCompleteModal.classList.remove('flex');
}
document.getElementById('closeMaintCompleteModalBtn').addEventListener('click', closeMaintCompleteModal);
document.getElementById('cancelMaintCompleteBtn').addEventListener('click', closeMaintCompleteModal);
maintCompleteModal.addEventListener('click', (e) => { if (e.target === maintCompleteModal) closeMaintCompleteModal(); });

maintCompleteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const logId = document.getElementById('maintCompleteId').value;
  if (!logId || !currentCarId) return;
  const actualDate = document.getElementById('maintActualDate').value;
  const actualOdo = Number(document.getElementById('maintActualOdo').value);
  const actualCost = document.getElementById('maintActualCost').value ? Number(document.getElementById('maintActualCost').value) : 0;
  const workDone = document.getElementById('maintWorkDone').value.trim();
  const nextDate = document.getElementById('maintNextDate').value || null;

  if (!actualDate || isNaN(actualOdo)) {
    showToast('入力内容を確認してください');
    return;
  }

  try {
    await updateDoc(doc(maintenanceCollectionRef(currentCarId), logId), {
      status: '完了',
      actualDate, actualOdo, actualCost, workDone, nextDate,
      updatedAt: serverTimestamp()
    });

    /* 車両の現在の走行距離を更新（実施時走行距離が現在値より大きい場合のみ） */
    const car = getCarById(currentCarId);
    if (car && (!car.currentOdo || actualOdo > car.currentOdo)) {
      await updateDoc(carDocRef(currentCarId), { currentOdo: actualOdo, updatedAt: serverTimestamp() });
    }

    closeMaintCompleteModal();
    showToast('メンテナンスを完了として記録しました');
  } catch (err) {
    console.error('メンテナンス完了処理に失敗:', err);
    showToast('メンテナンス完了処理に失敗しました');
  }
});

/* =========================================================
   設定タブ：① 作業カテゴリ管理 ／ 店舗マスタ管理 ／ ⑤ CSVエクスポート
   ========================================================= */
function renderSettingsTab() {
  renderCategoryList();
  renderShopList();
}

/* --- 作業カテゴリ管理 --- */

/* カテゴリコレクションが空の場合のみ、初期カテゴリを自動投入する */
async function seedDefaultCategoriesIfEmpty() {
  try {
    const snap = await getDocs(categoriesCollectionRef());
    if (!snap.empty) return;
    await Promise.all(DEFAULT_CATEGORIES.map((name, index) =>
      addDoc(categoriesCollectionRef(), { name, order: index, createdAt: serverTimestamp() })
    ));
  } catch (err) {
    console.error('初期カテゴリの投入に失敗:', err);
  }
}

function subscribeToCategories() {
  if (unsubscribeCategories) unsubscribeCategories();
  /* 初回のみ：カテゴリが1件も無ければ初期セットを投入してから購読を開始 */
  seedDefaultCategoriesIfEmpty().finally(() => {
    const q = query(categoriesCollectionRef(), orderBy('createdAt', 'asc'));
    unsubscribeCategories = onSnapshot(q, (snapshot) => {
      categories = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      renderCategoryList();
    }, (err) => {
      console.error('カテゴリ一覧の取得に失敗:', err);
      showToast('カテゴリ一覧の取得に失敗しました');
    });
  });
}

function renderCategoryList() {
  const listEl = document.getElementById('categoryList');
  const emptyEl = document.getElementById('categoryEmpty');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!categories.length) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  categories.forEach(cat => {
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between py-2';
    li.innerHTML = `
      <span class="text-slate-700">${escapeHtml(cat.name)}</span>
      <span class="flex gap-2">
        <button class="edit-category-btn text-xs bg-slate-100 hover:bg-brand-100 text-slate-600 px-2 py-1 rounded-lg" data-id="${cat.id}">編集</button>
        <button class="delete-category-btn text-slate-400 hover:text-red-500 px-1" data-id="${cat.id}" title="削除">🗑️</button>
      </span>
    `;
    listEl.appendChild(li);
  });

  listEl.querySelectorAll('.edit-category-btn').forEach(btn =>
    btn.addEventListener('click', () => startEditCategory(btn.dataset.id))
  );
  listEl.querySelectorAll('.delete-category-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteCategory(btn.dataset.id))
  );
}

const categoryForm = document.getElementById('categoryForm');
const categoryCancelBtn = document.getElementById('categoryCancelBtn');

function startEditCategory(id) {
  const cat = categories.find(c => c.id === id);
  if (!cat) return;
  document.getElementById('categoryId').value = cat.id;
  document.getElementById('categoryName').value = cat.name;
  document.getElementById('categorySubmitBtn').textContent = '更新';
  categoryCancelBtn.classList.remove('hidden');
}
function resetCategoryForm() {
  categoryForm.reset();
  document.getElementById('categoryId').value = '';
  document.getElementById('categorySubmitBtn').textContent = '追加';
  categoryCancelBtn.classList.add('hidden');
}
categoryCancelBtn.addEventListener('click', resetCategoryForm);

categoryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const id = document.getElementById('categoryId').value;
  const name = document.getElementById('categoryName').value.trim();
  if (!name) { showToast('カテゴリ名を入力してください'); return; }

  try {
    if (id) {
      await updateDoc(categoryDocRef(id), { name, updatedAt: serverTimestamp() });
      showToast('カテゴリを更新しました');
    } else {
      await addDoc(categoriesCollectionRef(), { name, order: categories.length, createdAt: serverTimestamp() });
      showToast('カテゴリを追加しました');
    }
    resetCategoryForm();
  } catch (err) {
    console.error('カテゴリの保存に失敗:', err);
    showToast('カテゴリの保存に失敗しました');
  }
});

async function deleteCategory(id) {
  if (!confirm('このカテゴリを削除しますか？')) return;
  try {
    await deleteDoc(categoryDocRef(id));
    showToast('カテゴリを削除しました');
  } catch (err) {
    console.error('カテゴリの削除に失敗:', err);
    showToast('カテゴリの削除に失敗しました');
  }
}

/* --- 店舗マスタ管理 --- */
function subscribeToShops() {
  if (unsubscribeShops) unsubscribeShops();
  const q = query(shopsCollectionRef(), orderBy('createdAt', 'asc'));
  unsubscribeShops = onSnapshot(q, (snapshot) => {
    shops = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderShopList();
    renderFuelShopOptions();
  }, (err) => {
    console.error('店舗一覧の取得に失敗:', err);
    showToast('店舗一覧の取得に失敗しました');
  });
}

function renderShopList() {
  const listEl = document.getElementById('shopList');
  const emptyEl = document.getElementById('shopEmpty');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!shops.length) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  shops.forEach(shop => {
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between py-2 gap-2';
    li.innerHTML = `
      <span class="min-w-0">
        <span class="font-medium text-slate-700">${escapeHtml(shop.name)}</span>
        <span class="text-xs text-slate-400 block">${telLinkHtml(shop.phone)}${shop.memo ? ' ／ ' + escapeHtml(shop.memo) : ''}</span>
      </span>
      <span class="flex gap-2 shrink-0">
        <button class="edit-shop-btn text-xs bg-slate-100 hover:bg-brand-100 text-slate-600 px-2 py-1 rounded-lg" data-id="${shop.id}">編集</button>
        <button class="delete-shop-btn text-slate-400 hover:text-red-500 px-1" data-id="${shop.id}" title="削除">🗑️</button>
      </span>
    `;
    listEl.appendChild(li);
  });

  listEl.querySelectorAll('.edit-shop-btn').forEach(btn =>
    btn.addEventListener('click', () => startEditShop(btn.dataset.id))
  );
  listEl.querySelectorAll('.delete-shop-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteShop(btn.dataset.id))
  );
}

const shopForm = document.getElementById('shopForm');
const shopCancelBtn = document.getElementById('shopCancelBtn');

function startEditShop(id) {
  const shop = shops.find(s => s.id === id);
  if (!shop) return;
  document.getElementById('shopId').value = shop.id;
  document.getElementById('shopName').value = shop.name || '';
  document.getElementById('shopPhone').value = shop.phone || '';
  document.getElementById('shopMemo').value = shop.memo || '';
  document.getElementById('shopSubmitBtn').textContent = '更新';
  shopCancelBtn.classList.remove('hidden');
}
function resetShopForm() {
  shopForm.reset();
  document.getElementById('shopId').value = '';
  document.getElementById('shopSubmitBtn').textContent = '追加';
  shopCancelBtn.classList.add('hidden');
}
shopCancelBtn.addEventListener('click', resetShopForm);

shopForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const id = document.getElementById('shopId').value;
  const name = document.getElementById('shopName').value.trim();
  const phone = document.getElementById('shopPhone').value.trim();
  const memo = document.getElementById('shopMemo').value.trim();
  if (!name) { showToast('店舗名を入力してください'); return; }

  try {
    if (id) {
      await updateDoc(shopDocRef(id), { name, phone, memo, updatedAt: serverTimestamp() });
      showToast('店舗情報を更新しました');
    } else {
      await addDoc(shopsCollectionRef(), { name, phone, memo, createdAt: serverTimestamp() });
      showToast('店舗を追加しました');
    }
    resetShopForm();
  } catch (err) {
    console.error('店舗情報の保存に失敗:', err);
    showToast('店舗情報の保存に失敗しました');
  }
});

async function deleteShop(id) {
  if (!confirm('この店舗を削除しますか？')) return;
  try {
    await deleteDoc(shopDocRef(id));
    showToast('店舗を削除しました');
  } catch (err) {
    console.error('店舗の削除に失敗:', err);
    showToast('店舗の削除に失敗しました');
  }
}

/* --- ⑤ CSVエクスポート --- */

/* CSVの1フィールドをダブルクオートでエスケープする */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/* rows（2次元配列）からCSVを生成し、ブラウザでダウンロードさせる */
function downloadCsv(filename, rows) {
  const csvBody = rows.map(row => row.map(csvField).join(',')).join('\r\n');
  /* 先頭にBOMを付与し、Excelで開いた際の文字化けを防止 */
  const blob = new Blob(['\uFEFF' + csvBody], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById('exportFuelCsvBtn').addEventListener('click', () => {
  if (!currentCarId) { showToast('先に車両を選択してください'); return; }
  const car = getCarById(currentCarId);
  const header = ['日付', 'ODO(km)', '給油量(L)', '金額(円)', '店舗', '満タン', '燃費(km/L)'];
  const rows = [header].concat(fuelLogs.map(log => [
    log.date || '', log.odo ?? '', log.liters ?? '', log.price ?? '',
    log.shopName || '', log.isFull ? '満タン' : '', log.efficiency != null ? Number(log.efficiency).toFixed(2) : ''
  ]));
  downloadCsv(`${(car && car.nickname) || 'car'}_fuelLogs.csv`, rows);
  showToast('給油記録のCSVをダウンロードしました');
});

document.getElementById('exportMaintCsvBtn').addEventListener('click', () => {
  if (!currentCarId) { showToast('先に車両を選択してください'); return; }
  const car = getCarById(currentCarId);
  const header = ['ステータス', '予約日', '予約時間', '実施日', 'ODO(km)', 'カテゴリ', '店舗', '担当者', '実際費用(円)', '作業内容', '次回予定日', '備考'];
  const rows = [header].concat(maintenanceLogs.map(log => [
    log.status || '', log.reserveDate || '', log.reserveTime || '', log.actualDate || '',
    log.actualOdo ?? '', log.category || '', log.shopName || '', log.person || '',
    (log.actualCost ?? log.cost) ?? '', log.workDone || '', log.nextDate || '', log.notes || ''
  ]));
  downloadCsv(`${(car && car.nickname) || 'car'}_maintenanceLogs.csv`, rows);
  showToast('メンテナンス記録のCSVをダウンロードしました');
});

/* =========================================================
   初期化
   ※ 実際の画面初期表示は onAuthStateChanged のコールバックで
     ログイン状態に応じて行われる（未ログイン時はガイド表示のみ）
   ========================================================= */
updateAddButtonState();
