const CODIGOS_SEC = {'MEN2026':'MENDOZA','COR2026':'CÓRDOBA','ROS2026':'ROSARIO','OLA2026':'OLAVARRÍA'};
let APP_MODE = null;

// Hash SHA-256 de la contraseña — se configura desde ☁️ Google Sheets
// Valor inicial: hash de "CAMBIAR_ESTA_CLAVE" — cambiarlo antes de usar
function getAdminHash() {
  return localStorage.getItem('ospiv_admin_hash') || 'cf21ae555a63a1a640fb938a5e4429960a7dd2cabd6712162d6208c93b6a0090';
}

async function hashPassword(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Mostrar setup si no hay hash configurado ─────────────────────
function checkFirstTime() {
  const hasHash = !!localStorage.getItem('ospiv_admin_hash');
  const setupLink = document.getElementById('setup-link');
  if (setupLink) setupLink.style.display = hasHash ? 'none' : 'block';
}

function mostrarSetup() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('login-setup').style.display = 'block';
  document.getElementById('setup-err').textContent = '';
  document.getElementById('setup-pass').value = '';
  document.getElementById('setup-confirm').value = '';
  setTimeout(() => document.getElementById('setup-pass').focus(), 50);
}

function volverLogin() {
  document.getElementById('login-setup').style.display = 'none';
  document.getElementById('login-form').style.display = 'block';
  setTimeout(() => document.getElementById('main-pass').focus(), 50);
}

async function guardarPasswordSetup() {
  const pass    = document.getElementById('setup-pass').value || '';
  const confirm = document.getElementById('setup-confirm').value || '';
  const err     = document.getElementById('setup-err');

  if (pass.length < 8) {
    err.textContent = '⚠ Mínimo 8 caracteres';
    return;
  }
  if (pass !== confirm) {
    err.textContent = '⚠ Las contraseñas no coinciden';
    return;
  }

  const hash = await hashPassword(pass);
  localStorage.setItem('ospiv_admin_hash', hash);

  err.style.color = '#2ecc71';
  err.textContent = '✅ Contraseña guardada. Podés ingresar ahora.';

  setTimeout(() => {
    volverLogin();
    checkFirstTime();
  }, 1500);
}

async function doMainLogin() {
  const raw = (document.getElementById('main-pass').value || '').trim();
  const upper = raw.toUpperCase();
  const err = document.getElementById('main-err');
  err.textContent = '';

  // ── Seccional: verificación local (códigos simples) ──
  if (CODIGOS_SEC[upper]) {
    APP_MODE = 'seccional';
    document.getElementById('login-outer').classList.add('hidden');
    document.getElementById('mode-sec').classList.add('active');
    currentUser = { code: upper, seccional: CODIGOS_SEC[upper] };
    const hr = document.getElementById('header-right');
    if (hr) hr.innerHTML =
      `<span class="badge badge-blue">${currentUser.seccional}</span>
       <button class="btn" onclick="doLogout()" style="font-size:12px;padding:0 10px">↩ Salir</button>`;
    const sl = document.getElementById('sec-label-top');
    if (sl) sl.textContent = currentUser.seccional;
    const cf = document.getElementById('c-fecha');
    if (cf) cf.value = new Date().toISOString().split('T')[0];
    showSec('screen-carga');
    cargarDatos();
    return;
  }

  // ── Admin: verificación por hash ──────────────────────────────
  const storedHash = getAdminHash();
  if (!storedHash) {
    mostrarSetup();
    return;
  }

  const inputHash = await hashPassword(raw);
  if (inputHash === storedHash) {
    sessionStorage.setItem('ospiv_ap', raw);
    entrarAdmin();
  } else {
    err.textContent = 'Contraseña incorrecta.';
    document.getElementById('main-pass').value = '';
    document.getElementById('main-pass').focus();
checkFirstTime();
// Pre-cargar URL de Apps Script
if (!localStorage.getItem('medi_sheets_url')) {
  localStorage.setItem('medi_sheets_url', 'https://script.google.com/macros/s/AKfycbyYNU9b4eB1th811fFRge0i2a3_2ifcZb_MlgqFXSs5C2NGUFfo54uqaEzgwbCd0FmU/exec');
}
  }
}

function entrarAdmin() {
  APP_MODE = 'admin';
  document.getElementById('login-outer').classList.add('hidden');
  document.getElementById('mode-admin').classList.add('active');
  loadDB();
  renderPanel();
  document.getElementById('np-fecha').value = today();
  npUpdateId();
  updateSyncStatus();
  // Cargar datos del Sheet en segundo plano para detectar afiliados nuevos de seccionales
  cargarDatosAdmin().then(function(){ renderPanel(); });
}

function doLogout() {
  APP_MODE = null;
  sessionStorage.removeItem('ospiv_ap');
  if (typeof currentUser !== 'undefined') currentUser = null;
  document.getElementById('mode-admin').classList.remove('active');
  document.getElementById('mode-sec').classList.remove('active');
  var lo=document.getElementById('login-outer');
  lo.classList.remove('hidden'); lo.style.display='';
  document.getElementById('main-pass').value = '';
  setTimeout(() => document.getElementById('main-pass').focus(), 50);
}

document.getElementById('main-pass').focus();

// ════════════════════════════════════════════════════
// MÓDULO ADMIN — MediGestión
// ════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════
// SEED DATA (from Excel)
// SEED data declared above


// ══════════════════════════════════════════════════════════════
// DB
// ══════════════════════════════════════════════════════════════
