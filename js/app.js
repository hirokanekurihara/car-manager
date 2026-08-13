/* =========================================================
   マイカー管理アプリ - メインスクリプト（Firebase版）
   ---------------------------------------------------------
   ■ 認証   : Firebase Authentication（Googleログイン）
   ■ データ : Cloud Firestore
       users/{uid}/cars/{carId}
       users/{uid}/cars/{carId}/fuelLogs/{logId}
       users/{uid}/cars/{carId}/maintenanceLogs/{logId}
   同じGoogleアカウントでログインすれば、
   複数デバイスから同じデータをリアルタイムに参照・編集できます。
   ========================================================= */

/* ---------- Firebase SDK（モジュール版）読み込み ---------- */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs, setDoc,
  updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ---------- Firebaseプロジェクト設定 -----------------------
   ⚠️ 下記の値は、Firebaseコンソール（プロジェクトの設定＞
   マイアプリ）で発行される、あなた自身のプロジェクトの値に
   必ず置き換えてください。
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

/* =========================================================
   グローバル状態
   ========================================================= */
let currentUser = null;      // ログイン中のFirebaseユーザー
let cars = [];                // 現在ログイン中ユーザーの車両一覧（キャッシュ）
let currentCarId = null;      // 現在選択中の車両ID
let fuelLogs = [];             // 選択中車両の給油記録（キャッシュ）
let maintenanceLogs = [];      // 選択中車両のメンテナンス記録（キャッシュ）

/* Firestoreのリアルタイム購読解除用関数を保持 */
let unsubscribeCars = null;
let unsubscribeFuel = null;
let unsubscribeMaint = null;

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
/* 満了日ステータス判定
   30日以内=赤、31〜60日=黄、61日以上=緑（期限切れも赤） */
function expiryStatus(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return { color: 'slate', label: '未設定', days: null };
  if (days < 0) return { color: 'red', label: `期限切れ (${formatDate(dateStr)})`, days };
  if (days <= 30) return { color: 'red', label: `あと${days}日 (${formatDate(dateStr)})`, days };
  if (days <= 60) return { color: 'yellow', label: `あと${days}日 (${formatDate(dateStr)})`, days };
  return { color: 'green', label: `あと${days}日 (${formatDate(dateStr)})`, days };
}
function colorClasses(color) {
  switch (color) {
    case 'red': return { badge: 'bg-red-100 text-red-700 border border-red-200', dot: 'bg-red-500' };
    case 'yellow': return { badge: 'bg-yellow-100 text-yellow-700 border border-yellow-200', dot: 'bg-yellow-500' };
    case 'green': return { badge: 'bg-green-100 text-green-700 border border-green-200', dot: 'bg-green-500' };
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

/* =========================================================
   認証（Googleログイン／ログアウト）
   ========================================================= */
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const userInfo = document.getElementById('userInfo');
const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');
const authGate = document.getElementById('authGate');
const appContent = document.getElementById('appContent');
const openCarModalBtn = document.getElementById('openCarModalBtn');

/* 「Googleでログイン」ボタン */
loginBtn.addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    console.error('ログインエラー:', e);
    showToast('ログインに失敗しました');
  }
});

/* 「ログアウト」ボタン */
logoutBtn.addEventListener('click', async () => {
  try {
    await signOut(auth);
    showToast('ログアウトしました');
  } catch (e) {
    console.error('ログアウトエラー:', e);
    showToast('ログアウトに失敗しました');
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

    /* Firestoreの車両一覧をリアルタイム購読開始 */
    subscribeToCars();
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
    cars = [];
    fuelLogs = [];
    maintenanceLogs = [];
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
   車両詳細モーダル（基本情報／保険情報タブ）
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

/* 詳細モーダル内のサブタブ切り替え（基本情報／保険情報） */
document.querySelectorAll('.detail-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchDetailTab(btn.dataset.detailTab));
});
function switchDetailTab(tabName) {
  document.querySelectorAll('.detail-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.detailTab === tabName);
  });
  document.getElementById('detailBasicPanel').classList.toggle('hidden', tabName !== 'basic');
  document.getElementById('detailInsurancePanel').classList.toggle('hidden', tabName !== 'insurance');
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
  } catch (err) {
    console.error('任意保険情報の保存に失敗:', err);
    showToast('任意保険情報の保存に失敗しました');
  }
});

/* =========================================================
   タブ切り替え（車両一覧／給油記録／メンテナンス）
   ========================================================= */
const tabButtons = document.querySelectorAll('.tab-btn');
const tabSections = {
  cars: document.getElementById('tab-cars'),
  fuel: document.getElementById('tab-fuel'),
  maintenance: document.getElementById('tab-maintenance')
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
  });
});

/* =========================================================
   給油記録
   ========================================================= */
const fuelForm = document.getElementById('fuelForm');

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
  renderFuelTable();
  initFuelFormDefaults();
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
    tr.innerHTML = `
      <td class="px-3 py-2 whitespace-nowrap">${formatDate(log.date)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${formatNumber(log.odo)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${Number(log.liters).toFixed(2)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">¥${formatNumber(log.price)}</td>
      <td class="px-3 py-2 text-center whitespace-nowrap">${log.isFull ? '✅' : '—'}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap font-semibold ${log.efficiency ? 'text-brand-700' : 'text-slate-400'}">${efficiencyText}</td>
      <td class="px-3 py-2 text-center whitespace-nowrap">
        <button class="delete-fuel-btn text-slate-400 hover:text-red-500" data-id="${log.id}" title="削除">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.delete-fuel-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteFuelLog(btn.dataset.id))
  );
}

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
      createdAt: serverTimestamp()
    });

    /* 車両の現在の走行距離を更新（給油記録のODOが現在値より大きい場合のみ） */
    if (!car.currentOdo || odo > car.currentOdo) {
      await updateDoc(carDocRef(currentCarId), { currentOdo: odo, updatedAt: serverTimestamp() });
    }

    fuelForm.reset();
    document.getElementById('fuelFull').checked = true;
    initFuelFormDefaults();
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
   メンテナンス記録
   ========================================================= */
const maintForm = document.getElementById('maintForm');
const maintCategorySelect = document.getElementById('maintCategory');
const maintCategoryOtherWrap = document.getElementById('maintCategoryOtherWrap');

maintCategorySelect.addEventListener('change', () => {
  maintCategoryOtherWrap.classList.toggle('hidden', maintCategorySelect.value !== 'その他');
});

/* Firestoreのメンテナンス記録をリアルタイム購読 */
function subscribeToMaintenanceLogs(carId) {
  if (unsubscribeMaint) unsubscribeMaint();
  const q = query(maintenanceCollectionRef(carId), orderBy('date', 'desc'));
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
  initMaintFormDefaults();
}

function initMaintFormDefaults() {
  const car = getCarById(currentCarId);
  if (!car) return;
  document.getElementById('maintDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('maintOdo').placeholder = `現在: ${formatNumber(car.currentOdo)} km`;
}

function renderMaintenanceTable() {
  const tbody = document.getElementById('maintTableBody');
  const emptyRow = document.getElementById('maintEmptyRow');
  tbody.innerHTML = '';

  if (!maintenanceLogs.length) {
    emptyRow.classList.remove('hidden');
    return;
  }
  emptyRow.classList.add('hidden');

  maintenanceLogs.forEach(log => {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-slate-100 hover:bg-slate-50';
    tr.innerHTML = `
      <td class="px-3 py-2 whitespace-nowrap">${formatDate(log.date)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${formatNumber(log.odo)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(log.category)}</td>
      <td class="px-3 py-2 text-right whitespace-nowrap">${log.cost ? '¥' + formatNumber(log.cost) : '-'}</td>
      <td class="px-3 py-2 max-w-[220px] truncate" title="${escapeHtml(log.memo)}">${escapeHtml(log.memo) || '-'}</td>
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

maintForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentCarId) return;
  const car = getCarById(currentCarId);
  const date = document.getElementById('maintDate').value;
  const odo = Number(document.getElementById('maintOdo').value);
  let category = maintCategorySelect.value;
  if (category === 'その他') {
    const other = document.getElementById('maintCategoryOther').value.trim();
    category = other || 'その他';
  }
  const cost = document.getElementById('maintCost').value ? Number(document.getElementById('maintCost').value) : 0;
  const memo = document.getElementById('maintMemo').value.trim();

  if (!date || isNaN(odo)) {
    showToast('入力内容を確認してください');
    return;
  }

  try {
    await addDoc(maintenanceCollectionRef(currentCarId), {
      date, odo, category, cost, memo,
      createdAt: serverTimestamp()
    });

    if (!car.currentOdo || odo > car.currentOdo) {
      await updateDoc(carDocRef(currentCarId), { currentOdo: odo, updatedAt: serverTimestamp() });
    }

    maintForm.reset();
    maintCategoryOtherWrap.classList.add('hidden');
    initMaintFormDefaults();
    showToast('メンテナンス記録を追加しました');
  } catch (err) {
    console.error('メンテナンス記録の追加に失敗:', err);
    showToast('メンテナンス記録の追加に失敗しました');
  }
});

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

/* =========================================================
   初期化
   ※ 実際の画面初期表示は onAuthStateChanged のコールバックで
     ログイン状態に応じて行われる（未ログイン時はガイド表示のみ）
   ========================================================= */
updateAddButtonState();
