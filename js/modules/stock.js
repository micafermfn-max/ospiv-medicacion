// ══════════════════════════════════════════════════════════════════════
// 🏬 STOCK Y MOVIMIENTOS — SEC-1a.2 (SOLO LECTURA) · ajuste: artículos por ArticuloID
// ----------------------------------------------------------------------
// Módulo independiente. No modifica DB, allData, localStorage ni la hoja
// Entregas. Solo llama a acciones del servidor que empiezan con "stk_".
// El token de sesión vive en sessionStorage (se borra al cerrar la pestaña).
// Todas las funciones y variables globales usan el prefijo "stk".
// ══════════════════════════════════════════════════════════════════════

var STK_SS_TOKEN = 'stk_token';
var STK_SS_VENCE = 'stk_vence';
var STK_CORTE_ESPERADO = '2026-03-01';
var STK_MAX_FILAS_TABLA = 1000;
var STK_DIAS_POSIBLE_DUP = 7;
var STK_ORDEN_CATEGORIAS = ['DIABETES', 'MATERIAL', 'ADMINISTRATIVO', 'EQUIPAMIENTO', 'OTRO'];

var stkEstado = {
  datos: null,        // respuesta de stk_getData
  analisis: null,     // resultado de stkAnalizar(datos)
  cargando: false,
  error: '',
  aviso: '',
  tab: 'resumen',
  filtros: { mes: '', estado: '', lugar: '__todos', insumo: '__todos', texto: '', soloDup: false, soloNoId: false }
};

// ── Utilidades ────────────────────────────────────────────────────────
function stkEsc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function stkNorm(v) {
  return String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

function stkCampo(f, nombre) {
  var v = f ? f[nombre] : '';
  return v == null ? '' : String(v).trim();
}

function stkVerdadero(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

// Devuelve 'yyyy-MM-dd' válido o '' (usa normFecha() existente solo para leer)
function stkFechaISO(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var iso = (typeof normFecha === 'function') ? normFecha(s) : s.substring(0, 10);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  var y = +m[1], mo = +m[2], d = +m[3];
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return iso;
}

function stkDias(isoA, isoB) {
  var a = isoA.split('-'), b = isoB.split('-');
  return Math.round((Date.UTC(+a[0], a[1] - 1, +a[2]) - Date.UTC(+b[0], b[1] - 1, +b[2])) / 86400000);
}

function stkFmtFecha(iso) {
  if (!iso) return '—';
  var p = iso.split('-');
  return p[2] + '/' + p[1] + '/' + p[0];
}

var STK_MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function stkFmtMes(ym) {
  var p = ym.split('-');
  return (STK_MESES[+p[1] - 1] || p[1]) + ' ' + p[0];
}

function stkMesActual() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function stkMesSiguiente(ym) {
  var p = ym.split('-'), y = +p[0], m = +p[1] + 1;
  if (m > 12) { m = 1; y++; }
  return y + '-' + String(m).padStart(2, '0');
}

// ── Sesión (sessionStorage) ───────────────────────────────────────────
function stkTokenLeer() {
  try {
    var t = sessionStorage.getItem(STK_SS_TOKEN);
    var v = Number(sessionStorage.getItem(STK_SS_VENCE));
    if (!t || !/^[a-f0-9]{64}$/.test(t) || !v || Date.now() > v) {
      if (t) stkTokenBorrar();
      return null;
    }
    return { token: t, vence: v };
  } catch (e) { return null; }
}

function stkTokenGuardar(token, vence) {
  try {
    sessionStorage.setItem(STK_SS_TOKEN, token);
    sessionStorage.setItem(STK_SS_VENCE, String(vence));
  } catch (e) {}
}

function stkTokenBorrar() {
  try {
    sessionStorage.removeItem(STK_SS_TOKEN);
    sessionStorage.removeItem(STK_SS_VENCE);
  } catch (e) {}
}

function stkUrl() {
  try { if (typeof getScriptUrl === 'function') return getScriptUrl(); } catch (e) {}
  try { if (typeof SCRIPT_URL !== 'undefined') return SCRIPT_URL; } catch (e) {}
  return '';
}

// Llama a una acción stk_* por POST. El token viaja SIEMPRE en el cuerpo.
async function stkApi(action, payload) {
  var url = stkUrl();
  if (!url) throw new Error('No hay URL de Apps Script configurada (⚙️ Configuración).');
  var body = Object.assign({}, payload || {}, { action: action });
  if (action !== 'stk_login') {
    var s = stkTokenLeer();
    if (!s) return { ok: false, code: 'SESION_INVALIDA', msg: 'Sesión vencida. Ingresá nuevamente la clave de Stock.' };
    body.token = s.token;
  }
  var res, data;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('No se pudo conectar con el servidor: ' + (e.message || e));
  }
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('Respuesta inválida del servidor.');
  }
  if (data && data.code === 'SESION_INVALIDA') stkTokenBorrar();
  return data || {};
}

async function stkLogin() {
  var inp = document.getElementById('stk-clave');
  var msg = document.getElementById('stk-login-msg');
  var btn = document.getElementById('stk-login-btn');
  var clave = inp ? inp.value : '';
  if (inp) inp.value = '';                       // la clave nunca queda en pantalla
  function mostrar(t, color) { if (msg) { msg.style.color = color || 'var(--rd)'; msg.textContent = t; } }
  if (!clave) { mostrar('Ingresá la clave de Stock.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }
  mostrar('', '');
  try {
    var r = await stkApi('stk_login', { clave: clave });
    clave = '';
    if (r && r.ok && typeof r.token === 'string' && /^[a-f0-9]{64}$/.test(r.token) && Number(r.venceEn) > Date.now()) {
      stkTokenGuardar(r.token, Number(r.venceEn));
      stkEstado.datos = null; stkEstado.analisis = null; stkEstado.error = ''; stkEstado.aviso = '';
      stkEstado.tab = 'resumen';
      await cargarStkDatos();
      return;
    }
    if (r && r.ok) {
      mostrar('El servidor configurado no tiene instalado SEC-1a.1 (no devolvió una sesión). Revisá la URL en ⚙️ Configuración y la versión del Apps Script.');
    } else if (r && r.code === 'CLAVE_INCORRECTA') {
      mostrar('Clave incorrecta.' + (r.intentosRestantes != null ? ' Quedan ' + r.intentosRestantes + ' intento(s) antes del bloqueo.' : ''));
    } else {
      mostrar((r && r.msg) || 'No se pudo iniciar la sesión.');
    }
  } catch (e) {
    mostrar(e.message || String(e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Ingresar'; }
    if (inp) inp.focus();
  }
}

async function stkLogout() {
  try { if (stkTokenLeer()) await stkApi('stk_logout'); } catch (e) {}
  stkTokenBorrar();
  stkEstado.datos = null; stkEstado.analisis = null; stkEstado.error = ''; stkEstado.aviso = 'Sesión de Stock cerrada.';
  renderStkPage();
}

// ── Carga de datos (solo lectura) ─────────────────────────────────────
async function cargarStkDatos() {
  stkEstado.cargando = true; stkEstado.error = '';
  renderStkPage();
  try {
    var r = await stkApi('stk_getData');
    if (r.code === 'SESION_INVALIDA') {
      stkEstado.datos = null; stkEstado.analisis = null;
      stkEstado.aviso = r.msg || 'Sesión vencida. Ingresá nuevamente la clave de Stock.';
    } else if (r.code === 'ACCION_DESCONOCIDA' || (r.ok && (!r.config || !r.entregas || !r.articulos))) {
      stkEstado.error = 'El servidor no tiene instalado SEC-1a.2 (falta la acción stk_getData). Actualizá el Code.gs y publicá una nueva versión.';
    } else if (!r.ok) {
      stkEstado.error = r.msg || 'No se pudieron leer los datos de Stock.';
    } else {
      stkEstado.datos = r;
      stkEstado.analisis = stkAnalizar(r);
    }
  } catch (e) {
    stkEstado.error = e.message || String(e);
  } finally {
    stkEstado.cargando = false;
    renderStkPage();
  }
}

// ── Análisis (funciones puras, sin DOM) ───────────────────────────────
function stkEstadoEntrega(f, ubicIds) {
  var origen = stkNorm(stkCampo(f, 'OrigenStock')).replace(/ /g, '_');
  if (origen === 'SIN_STOCK') return { estado: 'SIN_STOCK', motivo: 'Marcada SIN_STOCK', origen: '' };
  if (origen) {
    return { estado: 'CON_ORIGEN', origen: origen,
             motivo: 'Origen: ' + origen + (ubicIds[origen] ? '' : ' (ubicación desconocida)') };
  }
  if (stkCampo(f, 'PedidoId')) return { estado: 'SIN_STOCK', motivo: 'Materializada desde pedido (4-C)', origen: '' };
  if (stkNorm(stkCampo(f, 'Modalidad')) === 'DROGUERIA') return { estado: 'SIN_STOCK', motivo: 'Modalidad Droguería', origen: '' };
  return { estado: 'SIN_CLASIFICAR', motivo: 'Sin origen de stock asignado', origen: '' };
}

function stkMarcarDuplicados(items) {
  var grupos = {};
  items.forEach(function(it) {
    it.dupExacto = []; it.dupCercano = [];
    if (!it.fecha || !it.dni || !(it.articuloId || it.insumoNorm)) return;
    // Ajuste SEC-1a.2: si el artículo está identificado se agrupa por ArticuloID, así dos textos
    // históricos distintos del mismo artículo también se detectan como duplicado.
    var k = it.dni + '|' + (it.articuloId ? 'A:' + it.articuloId : 'T:' + it.insumoNorm);
    (grupos[k] = grupos[k] || []).push(it);
  });
  Object.keys(grupos).forEach(function(k) {
    var g = grupos[k];
    for (var i = 0; i < g.length; i++) {
      for (var j = 0; j < g.length; j++) {
        if (i === j) continue;
        var d = Math.abs(stkDias(g[i].fecha, g[j].fecha));
        if (d === 0) g[i].dupExacto.push(g[j].fila);
        else if (d <= STK_DIAS_POSIBLE_DUP) g[i].dupCercano.push(g[j].fila);
      }
    }
  });
}

// ── Ajuste SEC-1a.2: resolución del artículo de una entrega ─────────────
// Orden: 1) ArticuloID de la entrega · 2) TextoEntregas del catálogo · 3) _StkMapeoTextos · 4) ❓
// Comparación de textos: ignora mayúsculas, acentos y espacios duplicados (stkNorm).
// Sin coincidencias aproximadas: las palabras deben ser exactamente las mismas.
function stkConstruirResolutor(datos) {
  var R = { arts: {}, porTexto: {}, conflictosTexto: {}, porMapeo: {}, conflictosMapeo: {}, avisosMapeo: [], mapeosActivos: 0 };
  (datos.articulos || []).forEach(function(a) {
    var id = stkCampo(a, 'ID');
    if (id) R.arts[id] = a;
  });
  (datos.articulos || []).forEach(function(a) {
    var k = stkNorm(a.TextoEntregas);
    if (!stkVerdadero(a.GeneraEntrega) || !k) return;
    if (R.porTexto[k] && stkCampo(R.porTexto[k], 'ID') !== stkCampo(a, 'ID')) R.conflictosTexto[k] = true;
    else R.porTexto[k] = a;
  });
  (datos.mapeos || []).forEach(function(m) {
    if (!stkVerdadero(m.Activo)) return;
    var k = stkNorm(m.TextoOriginal), id = stkCampo(m, 'ArticuloID');
    if (!k) return;
    R.mapeosActivos++;
    var guardado = stkCampo(m, 'TextoNormalizado');
    if (guardado && guardado !== k) R.avisosMapeo.push('El mapeo "' + m.TextoOriginal + '" tiene TextoNormalizado "' + guardado + '"; se usa "' + k + '".');
    if (R.porTexto[k]) R.avisosMapeo.push('El mapeo "' + m.TextoOriginal + '" no es necesario: ese texto ya coincide con el TextoEntregas de un artículo.');
    if (R.porMapeo[k] && R.porMapeo[k] !== id) R.conflictosMapeo[k] = true;
    else R.porMapeo[k] = id;
  });
  return R;
}

function stkResolverArticulo(f, R) {
  var id = stkCampo(f, 'ArticuloID');
  if (id) {
    return R.arts[id] ? { articulo: R.arts[id], via: 'ID', motivo: '' }
                      : { articulo: null, via: '', motivo: 'ArticuloID desconocido: ' + id };
  }
  var k = stkNorm(stkCampo(f, 'Insumo'));
  if (!k) return { articulo: null, via: '', motivo: 'Insumo vacío' };
  if (R.conflictosTexto[k]) return { articulo: null, via: '', motivo: 'Varios artículos tienen este mismo TextoEntregas' };
  if (R.porTexto[k]) return { articulo: R.porTexto[k], via: 'Texto', motivo: '' };
  if (R.conflictosMapeo[k]) return { articulo: null, via: '', motivo: 'Hay mapeos activos en conflicto para este texto' };
  if (R.porMapeo[k]) {
    var a = R.arts[R.porMapeo[k]];
    return a ? { articulo: a, via: 'Mapeo', motivo: '' }
             : { articulo: null, via: '', motivo: 'El mapeo apunta a un ArticuloID inexistente: ' + R.porMapeo[k] };
  }
  return { articulo: null, via: '', motivo: 'Texto sin artículo ni mapeo' };
}

function stkAnalizar(datos) {
  var corte = (datos.config && datos.config.fechaCorte) || STK_CORTE_ESPERADO;
  var ubicIds = {};
  (datos.ubicaciones || []).forEach(function(u) { ubicIds[stkNorm(u.ID)] = true; });
  var R = stkConstruirResolutor(datos);

  var filas = (datos.entregas && datos.entregas.filas) || [];
  var items = filas.map(function(f) {
    var insumo = stkCampo(f, 'Insumo');
    var res = stkResolverArticulo(f, R);
    var art = res.articulo;
    var est = stkEstadoEntrega(f, ubicIds);
    return {
      fila: f._fila, id: stkCampo(f, 'ID'), fechaRaw: stkCampo(f, 'Fecha'), fecha: stkFechaISO(f['Fecha']),
      dni: stkCampo(f, 'DNI'), nombre: stkCampo(f, 'Apellido y nombre'),
      insumo: insumo, insumoNorm: stkNorm(insumo), articuloId: art ? stkCampo(art, 'ID') : '', noIdentificado: !art,
      articuloNombre: art ? stkCampo(art, 'Nombre') : '', via: res.via, motivoArt: res.motivo,
      cajas: stkCampo(f, 'Cajas'), lugar: stkCampo(f, 'Seccional'), modalidad: stkCampo(f, 'Modalidad'),
      pedidoId: stkCampo(f, 'PedidoId'), nota: stkCampo(f, 'Nota'),
      estado: est.estado, motivo: est.motivo, origen: est.origen
    };
  });
  stkMarcarDuplicados(items);

  var anteriores = 0, desde = [], invalidas = [];
  items.forEach(function(it) {
    if (!it.fecha) invalidas.push(it);
    else if (it.fecha < corte) anteriores++;
    else desde.push(it);
  });
  desde.sort(function(a, b) { return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.fila - b.fila; });

  var conteo = { SIN_CLASIFICAR: 0, SIN_STOCK: 0, CON_ORIGEN: 0, noId: 0, dup: 0 };
  var porMes = {};
  desde.forEach(function(it) {
    conteo[it.estado]++;
    if (it.noIdentificado) conteo.noId++;
    if (it.dupExacto.length || it.dupCercano.length) conteo.dup++;
    var m = it.fecha.slice(0, 7);
    var pm = porMes[m] = porMes[m] || { SIN_CLASIFICAR: 0, SIN_STOCK: 0, CON_ORIGEN: 0, total: 0, noId: 0, dup: 0 };
    pm[it.estado]++; pm.total++;
    if (it.noIdentificado) pm.noId++;
    if (it.dupExacto.length || it.dupCercano.length) pm.dup++;
  });
  var meses = [];
  var fin = stkMesActual();
  Object.keys(porMes).forEach(function(m) { if (m > fin) fin = m; });
  for (var m = corte.slice(0, 7), guard = 0; m <= fin && guard < 600; m = stkMesSiguiente(m), guard++) {
    meses.push(Object.assign({ mes: m }, porMes[m] || { SIN_CLASIFICAR: 0, SIN_STOCK: 0, CON_ORIGEN: 0, total: 0, noId: 0, dup: 0 }));
  }

  // Insumos para el filtro: agrupados por texto normalizado (las variantes de mayúsculas/acentos se unen)
  var lugares = {}, insumos = {};
  desde.forEach(function(it) {
    lugares[it.lugar || ''] = true;
    if (!insumos[it.insumoNorm]) insumos[it.insumoNorm] = it.articuloNombre && it.via === 'Texto' ? it.articuloNombre : (it.insumo || '(sin insumo)');
  });

  // Textos históricos sin artículo (todas las filas, con su cantidad desde el corte)
  var sinArt = {};
  items.forEach(function(it) {
    if (!it.noIdentificado) return;
    var k = it.insumoNorm;
    var g = sinArt[k] = sinArt[k] || { clave: k, texto: it.insumo || '(vacío)', desde: 0, total: 0, motivo: it.motivoArt };
    g.total++;
    if (it.fecha && it.fecha >= corte) g.desde++;
  });
  var textosSinArticulo = Object.keys(sinArt).map(function(k) { return sinArt[k]; })
    .sort(function(a, b) { return (b.desde - a.desde) || (b.total - a.total) || (a.texto < b.texto ? -1 : 1); });

  return {
    corte: corte, total: items.length, anteriores: anteriores, desde: desde, invalidas: invalidas,
    conteo: conteo, meses: meses, resolutor: R, textosSinArticulo: textosSinArticulo,
    lugares: Object.keys(lugares).sort(),
    insumos: Object.keys(insumos).sort(function(a, b) { return insumos[a] < insumos[b] ? -1 : 1; })
      .map(function(k) { return { clave: k, texto: insumos[k] }; })
  };
}

function stkFiltrarEntregas(lista, f) {
  var txt = stkNorm(f.texto);
  return lista.filter(function(it) {
    if (f.mes && it.fecha.slice(0, 7) !== f.mes) return false;
    if (f.estado && it.estado !== f.estado) return false;
    if (f.lugar != null && f.lugar !== '__todos' && it.lugar !== f.lugar) return false;
    if (f.insumo != null && f.insumo !== '__todos' && it.insumoNorm !== f.insumo) return false;
    if (f.soloDup && !(it.dupExacto.length || it.dupCercano.length)) return false;
    if (f.soloNoId && !it.noIdentificado) return false;
    if (txt && stkNorm(it.dni).indexOf(txt) < 0 && stkNorm(it.nombre).indexOf(txt) < 0) return false;
    return true;
  });
}

// ── Render ────────────────────────────────────────────────────────────
function renderStkPage() {
  var el = document.getElementById('page-stock');
  if (!el) return;
  var s = stkTokenLeer();
  if (!s) { renderStkLogin(el); return; }
  if (!stkEstado.datos && !stkEstado.cargando && !stkEstado.error) { cargarStkDatos(); return; }

  var vence = new Date(s.vence);
  var hhmm = String(vence.getHours()).padStart(2, '0') + ':' + String(vence.getMinutes()).padStart(2, '0');
  var html = '<div class="stk-bar">' +
    '<span class="b bg">🔓 Sesión de Stock activa</span>' +
    '<span class="stk-dim">vence a las ' + hhmm + '</span>' +
    '<span style="flex:1"></span>' +
    '<span class="b bgr">Solo lectura · SEC-1a.2</span>' +
    '<button class="btn bs bsm" onclick="cargarStkDatos()"' + (stkEstado.cargando ? ' disabled' : '') + '>🔄 Actualizar</button>' +
    '<button class="btn bs bsm" onclick="stkLogout()">Cerrar sesión</button>' +
    '</div>';

  if (stkEstado.cargando) {
    el.innerHTML = html + '<div class="stk-vacio">⏳ Leyendo datos de Stock…</div>';
    return;
  }
  if (stkEstado.error) {
    el.innerHTML = html + '<div class="stk-aviso bad">✗ ' + stkEsc(stkEstado.error) + '</div>' +
      '<button class="btn bp bsm" onclick="stkEstado.error=\'\';cargarStkDatos()">Reintentar</button>';
    return;
  }

  var a = stkEstado.analisis;
  html += '<div class="stk-tabs">' +
    '<button class="stk-tab' + (stkEstado.tab === 'resumen' ? ' active' : '') + '" onclick="stkTab(\'resumen\')">📌 Resumen</button>' +
    '<button class="stk-tab' + (stkEstado.tab === 'entregas' ? ' active' : '') + '" onclick="stkTab(\'entregas\')">📋 Entregas desde el corte' +
      (a && a.conteo.SIN_CLASIFICAR ? ' <span class="b br">' + a.conteo.SIN_CLASIFICAR + '</span>' : '') + '</button>' +
    '</div><div id="stk-contenido"></div>';
  el.innerHTML = html;
  var c = document.getElementById('stk-contenido');
  if (stkEstado.tab === 'entregas') renderStkEntregas(c); else renderStkResumen(c);
}

function renderStkLogin(el) {
  var aviso = stkEstado.aviso;
  stkEstado.aviso = '';
  el.innerHTML = '<div class="stk-login card">' +
    '<div class="ch">🔒 <span class="ct">Stock y Movimientos</span></div>' +
    '<div class="stk-login-body">' +
      '<div class="stk-dim" style="margin-bottom:12px">Ingresá la clave de Stock. Es distinta de la contraseña de MediGestión. ' +
      'La sesión dura hasta 6 horas y se cierra al cerrar esta pestaña.</div>' +
      (aviso ? '<div class="stk-aviso">' + stkEsc(aviso) + '</div>' : '') +
      '<div class="stk-k">Clave de Stock</div>' +
      '<input type="password" id="stk-clave" autocomplete="off" class="stk-input" ' +
        'onkeydown="if(event.key===\'Enter\')stkLogin()">' +
      '<button class="btn bp" id="stk-login-btn" style="margin-top:12px" onclick="stkLogin()">Ingresar</button>' +
      '<div id="stk-login-msg" class="stk-login-msg"></div>' +
    '</div></div>';
  var inp = document.getElementById('stk-clave');
  if (inp) setTimeout(function() { inp.focus(); }, 30);
}

function stkTab(t) {
  stkEstado.tab = t;
  renderStkPage();
}

function stkKpi(clase, titulo, valor, sub) {
  return '<div class="kpi ' + clase + '"><div class="kl">' + titulo + '</div><div class="kv">' + valor + '</div><div class="ks">' + sub + '</div></div>';
}

function renderStkResumen(c) {
  var d = stkEstado.datos, a = stkEstado.analisis, cfg = d.config || {};
  var h = '';

  // Contadores de entregas
  h += '<div class="kg">' +
    stkKpi('', 'Entregas desde el corte', a.desde.length, 'desde ' + stkFmtFecha(a.corte)) +
    stkKpi('r', '🔴 Sin clasificar', a.conteo.SIN_CLASIFICAR, 'no descuentan stock') +
    stkKpi('', '⚪ Sin stock', a.conteo.SIN_STOCK, 'droguería / 4-C / SIN_STOCK') +
    stkKpi('g', '✅ Con origen', a.conteo.CON_ORIGEN, 'con ubicación asignada') +
    '</div>';
  h += '<div class="stk-aviso">' + a.anteriores + ' entrega(s) anteriores al ' + stkFmtFecha(a.corte) +
       ': histórico, siguen funcionando para topes, Insumos Diabetes y ficha, y no afectan el stock.' +
       (a.invalidas.length ? '<br>⚠ ' + a.invalidas.length + ' entrega(s) con fecha vacía o inválida (ver solapa Entregas).' : '') +
       (a.conteo.noId ? '<br>❓ ' + a.conteo.noId + ' entrega(s) desde el corte con artículo no identificado.' : '') +
       '<br>Total de filas leídas en Entregas: ' + a.total + ' = ' + a.anteriores + ' anteriores + ' + a.desde.length +
       ' desde el corte + ' + a.invalidas.length + ' con fecha inválida.</div>';
  if (d.entregas && d.entregas.existe === false) h += '<div class="stk-aviso bad">No existe la hoja Entregas en la planilla.</div>';

  // Configuración
  h += '<div class="card"><div class="ch">⚙️ <span class="ct">Configuración de Stock</span></div><div class="stk-body">' +
    '<div class="stk-kv">' +
      '<div><div class="stk-k">Fecha de corte</div><div class="stk-v">' + stkFmtFecha(cfg.fechaCorte) + ' <span class="b bgr">fija · no modificable</span></div></div>' +
      '<div><div class="stk-k">Modo carga inicial</div><div class="stk-v">' + (cfg.modoCargaInicial ? '<span class="b bo">Activo</span>' : '<span class="b bg">Inactivo</span>') + '</div></div>' +
      '<div><div class="stk-k">Movimientos registrados</div><div class="stk-v">' + ((d.contadores && d.contadores.movimientos) || 0) + '</div></div>' +
      '<div><div class="stk-k">Pendientes registrados</div><div class="stk-v">' + ((d.contadores && d.contadores.pendientes) || 0) + '</div></div>' +
    '</div>' +
    (cfg.avisoFechaCorte ? '<div class="stk-aviso warn">⚠ ' + stkEsc(cfg.avisoFechaCorte) + '</div>' : '') +
    (cfg.fechaCorte !== STK_CORTE_ESPERADO ? '<div class="stk-aviso bad">⚠ El servidor informa una fecha de corte distinta de ' + stkFmtFecha(STK_CORTE_ESPERADO) + '.</div>' : '') +
    '<div class="stk-aviso">🔒 El cálculo de stock y la carga de movimientos se habilitan en SEC-1a.3a. Esta pantalla es solo de lectura.</div>' +
    '</div></div>';

  // Ubicaciones
  var ubic = d.ubicaciones || [];
  h += '<div class="card"><div class="ch">📍 <span class="ct">Ubicaciones</span><span class="stk-dim">' + ubic.length + '</span></div><div class="cb tw"><table>' +
    '<thead><tr><th>ID</th><th>Nombre</th><th>Alias</th><th>Activa</th></tr></thead><tbody>' +
    (ubic.length ? ubic.map(function(u) {
      return '<tr><td class="mono">' + stkEsc(u.ID) + '</td><td>' + stkEsc(u.Nombre) + '</td><td class="stk-dim">' +
        stkEsc(u.Alias || '—') + '</td><td>' + (stkVerdadero(u.Activa) ? '<span class="b bg">Sí</span>' : '<span class="b bgr">No</span>') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="stk-dim" style="text-align:center">Sin ubicaciones</td></tr>') +
    '</tbody></table></div></div>';

  // Catálogo agrupado por categoría
  var R = a.resolutor;
  var unidadesOk = d.unidades || [];
  var arts = (d.articulos || []).slice();
  var cats = {};
  arts.forEach(function(x) { var k = String(x.Categoria || 'OTRO').toUpperCase(); (cats[k] = cats[k] || []).push(x); });
  var ordenCats = STK_ORDEN_CATEGORIAS.filter(function(k) { return cats[k]; })
    .concat(Object.keys(cats).filter(function(k) { return STK_ORDEN_CATEGORIAS.indexOf(k) < 0; }).sort());
  h += '<div class="card"><div class="ch">🗂 <span class="ct">Catálogo de artículos</span><span class="stk-dim">' + arts.length + '</span></div><div class="cb tw"><table>' +
    '<thead><tr><th>ID</th><th>Nombre</th><th>Unidad</th><th>Genera entrega</th><th>Texto en Entregas</th><th>Activo</th></tr></thead><tbody>' +
    (arts.length ? ordenCats.map(function(k) {
      return '<tr class="stk-grupo"><td colspan="6">' + stkEsc(k) + ' · ' + cats[k].length + '</td></tr>' +
        cats[k].map(function(x) {
          var uOk = unidadesOk.indexOf(String(x.Unidad || '')) >= 0;
          var tDup = stkVerdadero(x.GeneraEntrega) && R.conflictosTexto[stkNorm(x.TextoEntregas)];
          return '<tr><td class="mono">' + stkEsc(x.ID) + '</td><td>' + stkEsc(x.Nombre) + '</td><td>' + stkEsc(x.Unidad || '—') +
            (uOk ? '' : ' <span class="b br" title="Unidad fuera de la lista: ' + stkEsc(unidadesOk.join(', ')) + '">⚠ unidad no válida</span>') + '</td><td>' +
            (stkVerdadero(x.GeneraEntrega) ? '<span class="b bb">Sí</span>' : '<span class="b bgr">No</span>') + '</td><td class="stk-dim">' +
            stkEsc(x.TextoEntregas || '—') + (tDup ? ' <span class="b br">⚠ TextoEntregas repetido</span>' : '') + '</td><td>' +
            (stkVerdadero(x.Activo) ? '<span class="b bg">Sí</span>' : '<span class="b bgr">No</span>') + '</td></tr>';
        }).join('');
    }).join('') : '<tr><td colspan="6" class="stk-dim" style="text-align:center">Catálogo vacío</td></tr>') +
    '</tbody></table></div>' +
    '<div class="stk-body stk-dim" style="margin:0">Unidades permitidas: ' + stkEsc(unidadesOk.join(', ')) + '</div></div>';

  // Mapeos de textos históricos (solo lectura; la carga se habilita en SEC-1a.3a)
  var maps = d.mapeos || [];
  h += '<div class="card"><div class="ch">🔗 <span class="ct">Mapeos de textos históricos</span><span class="stk-dim">' + maps.length +
    ' · ' + R.mapeosActivos + ' activo(s) · solo para Entregas históricas sin ArticuloID</span></div>' +
    (R.avisosMapeo.length ? '<div class="stk-body">' + R.avisosMapeo.map(function(t) { return '<div class="stk-aviso warn">⚠ ' + stkEsc(t) + '</div>'; }).join('') + '</div>' : '') +
    '<div class="cb tw"><table><thead><tr><th>Texto original</th><th>Artículo</th><th>Activo</th><th>Observación</th></tr></thead><tbody>' +
    (maps.length ? maps.map(function(m) {
      var art = R.arts[stkCampo(m, 'ArticuloID')];
      var conf = stkVerdadero(m.Activo) && R.conflictosMapeo[stkNorm(m.TextoOriginal)];
      return '<tr><td>' + stkEsc(m.TextoOriginal || '—') + (conf ? ' <span class="b br">⚠ en conflicto</span>' : '') + '</td><td>' +
        (art ? stkEsc(art.Nombre) + '<div class="mono stk-dim">' + stkEsc(art.ID) + '</div>'
             : '<span class="b br">⚠ ArticuloID inexistente: ' + stkEsc(m.ArticuloID || '(vacío)') + '</span>') + '</td><td>' +
        (stkVerdadero(m.Activo) ? '<span class="b bg">Sí</span>' : '<span class="b bgr">No</span>') + '</td><td class="stk-dim">' +
        stkEsc(m.Observacion || '') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="stk-dim" style="text-align:center">Sin mapeos. La carga de mapeos se habilita en SEC-1a.3a.</td></tr>') +
    '</tbody></table></div></div>';

  c.innerHTML = h;
}

function stkOpt(valor, texto, actual) {
  return '<option value="' + stkEsc(valor) + '"' + (valor === actual ? ' selected' : '') + '>' + stkEsc(texto) + '</option>';
}

function renderStkEntregas(c) {
  var a = stkEstado.analisis, f = stkEstado.filtros;
  var h = '';

  // Resumen mensual
  h += '<div class="card"><div class="ch">📅 <span class="ct">Resumen mensual desde el corte</span>' +
    '<span class="stk-dim">Meta de la reconstrucción: 0 sin clasificar por mes · clic en un mes para filtrar</span></div><div class="cb tw"><table>' +
    '<thead><tr><th>Mes</th><th>🔴 Sin clasificar</th><th>⚪ Sin stock</th><th>✅ Con origen</th><th>Total</th><th>❓</th><th>🔁</th></tr></thead><tbody>' +
    a.meses.map(function(m) {
      return '<tr class="stk-clic' + (f.mes === m.mes ? ' stk-sel' : '') + '" onclick="stkFiltrarMes(\'' + m.mes + '\')">' +
        '<td style="text-transform:capitalize">' + stkFmtMes(m.mes) + '</td>' +
        '<td class="mono">' + (m.SIN_CLASIFICAR ? '<span class="b br">' + m.SIN_CLASIFICAR + '</span>' : (m.total ? '<span class="b bg">0 ✓</span>' : '0')) + '</td>' +
        '<td class="mono">' + m.SIN_STOCK + '</td><td class="mono">' + m.CON_ORIGEN + '</td><td class="mono" style="font-weight:600">' + m.total + '</td>' +
        '<td class="mono">' + (m.noId || '') + '</td><td class="mono">' + (m.dup || '') + '</td></tr>';
    }).join('') +
    '</tbody></table></div></div>';

  // Filtros
  var est = 'background:var(--sf2);border:1px solid var(--bd2);border-radius:7px;padding:6px 10px;color:var(--tx);font-size:12px;width:auto;height:auto';
  h += '<div class="stk-filtros">' +
    '<input type="text" id="stk-f-texto" placeholder="Buscar DNI o nombre…" value="' + stkEsc(f.texto) + '" oninput="stkSetFiltro(\'texto\',this.value)" style="' + est + ';flex:1;min-width:170px">' +
    '<select id="stk-f-mes" onchange="stkSetFiltro(\'mes\',this.value)" style="' + est + '">' + stkOpt('', 'Todos los meses', f.mes) +
      a.meses.map(function(m) { return stkOpt(m.mes, stkFmtMes(m.mes), f.mes); }).join('') + '</select>' +
    '<select id="stk-f-estado" onchange="stkSetFiltro(\'estado\',this.value)" style="' + est + '">' + stkOpt('', 'Todos los estados', f.estado) +
      stkOpt('SIN_CLASIFICAR', '🔴 Sin clasificar', f.estado) + stkOpt('SIN_STOCK', '⚪ Sin stock', f.estado) + stkOpt('CON_ORIGEN', '✅ Con origen', f.estado) + '</select>' +
    '<select id="stk-f-lugar" onchange="stkSetFiltro(\'lugar\',this.value)" style="' + est + '">' + stkOpt('__todos', 'Todos los lugares de retiro', f.lugar) +
      a.lugares.map(function(l) { return stkOpt(l, l || '(sin lugar)', f.lugar); }).join('') + '</select>' +
    '<select id="stk-f-insumo" onchange="stkSetFiltro(\'insumo\',this.value)" style="' + est + ';max-width:240px">' + stkOpt('__todos', 'Todos los insumos', f.insumo) +
      a.insumos.map(function(i) { return stkOpt(i.clave, i.texto, f.insumo); }).join('') + '</select>' +
    '<label class="stk-check"><input type="checkbox" ' + (f.soloDup ? 'checked ' : '') + 'onchange="stkSetFiltro(\'soloDup\',this.checked)"> Solo duplicados</label>' +
    '<label class="stk-check"><input type="checkbox" ' + (f.soloNoId ? 'checked ' : '') + 'onchange="stkSetFiltro(\'soloNoId\',this.checked)"> Solo ❓</label>' +
    '<button class="btn bs bsm" onclick="stkLimpiarFiltros()">Limpiar</button>' +
    '<button class="btn bp bsm" onclick="stkExportarCSV()">⬇ Exportar CSV</button>' +
    '</div>';

  h += '<div class="card"><div class="ch">📋 <span class="ct">Entregas desde el ' + stkFmtFecha(a.corte) + '</span>' +
    '<span class="stk-dim" id="stk-ent-count"></span></div><div class="cb tw" id="stk-ent-lista"></div></div>';

  // Textos históricos sin artículo
  var tsa = a.textosSinArticulo;
  h += '<div class="card"><div class="ch">❓ <span class="ct">Textos históricos sin artículo</span><span class="stk-dim">' + tsa.length +
    ' texto(s) distinto(s) · se resolverán con mapeos en SEC-1a.3a</span></div><div class="cb tw">' +
    (tsa.length ? '<table><thead><tr><th>Texto en Entregas</th><th>Filas desde el corte</th><th>Filas en total</th><th>Motivo</th><th></th></tr></thead><tbody>' +
      tsa.map(function(t, i) {
        return '<tr><td>' + stkEsc(t.texto) + '</td><td class="mono" style="font-weight:600">' + t.desde + '</td><td class="mono">' + t.total +
          '</td><td class="stk-dim">' + stkEsc(t.motivo) + '</td><td>' +
          (t.desde ? '<button class="btn bs bsm" onclick="stkFiltrarTexto(' + i + ')">Ver filas</button>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table>'
      : '<div class="stk-vacio">✓ Todas las entregas tienen un artículo identificado.</div>') +
    '</div></div>';

  // Fechas inválidas
  if (a.invalidas.length) {
    h += '<div class="card"><div class="ch">⚠ <span class="ct">Entregas con fecha vacía o inválida</span><span class="stk-dim">' + a.invalidas.length +
      ' · no se puede saber si son anteriores o posteriores al corte</span></div><div class="cb tw">' + stkTablaEntregas(a.invalidas, true) + '</div></div>';
  }

  c.innerHTML = h;
  stkRenderListaEntregas();
}

function stkMarcasHtml(it) {
  var m = [];
  if (it.dupExacto.length) m.push('<span class="b br" title="Mismo DNI, insumo y fecha">🔁 Duplicado · fila ' + it.dupExacto.join(', ') + '</span>');
  if (it.dupCercano.length) m.push('<span class="b bo" title="Mismo DNI e insumo con ≤ ' + STK_DIAS_POSIBLE_DUP + ' días de diferencia">🔁≈ Posible · fila ' + it.dupCercano.join(', ') + '</span>');
  if (it.noIdentificado) m.push('<span class="b bpu" title="' + stkEsc(it.motivoArt) + '">❓ Artículo no identificado</span>');
  return m.join(' ');
}

function stkEstadoHtml(it) {
  if (it.estado === 'SIN_CLASIFICAR') return '<span class="b br" title="' + stkEsc(it.motivo) + '">🔴 Sin clasificar</span>';
  if (it.estado === 'SIN_STOCK') return '<span class="b bgr" title="' + stkEsc(it.motivo) + '">⚪ Sin stock</span>';
  return '<span class="b bg" title="' + stkEsc(it.motivo) + '">✅ ' + stkEsc(it.origen) + '</span>';
}

function stkInsumoHtml(it) {
  if (!it.articuloId) return stkEsc(it.insumo || '—');
  var h = '<div style="font-weight:500">' + stkEsc(it.articuloNombre) + '</div>' +
    '<div class="mono stk-dim">' + stkEsc(it.articuloId) + ' · <span title="Cómo se identificó el artículo">' + stkEsc(it.via) + '</span></div>';
  if (stkNorm(it.insumo) !== stkNorm(it.articuloNombre)) h += '<div class="stk-dim" title="Texto original en Entregas">texto: ' + stkEsc(it.insumo || '(vacío)') + '</div>';
  return h;
}

function stkTablaEntregas(lista, mostrarFechaCruda) {
  return '<table><thead><tr><th>Fila</th><th>Fecha</th><th>Afiliado</th><th>Insumo</th><th>Cajas</th><th>Lugar de retiro</th>' +
    '<th>Modalidad</th><th>PedidoId</th><th>Estado</th><th>Marcas</th><th>Nota</th></tr></thead><tbody>' +
    lista.map(function(it) {
      return '<tr>' +
        '<td class="mono stk-dim" title="ID ' + stkEsc(it.id) + '">' + stkEsc(it.fila) + '</td>' +
        '<td class="mono">' + (mostrarFechaCruda ? stkEsc(it.fechaRaw || '(vacía)') : stkFmtFecha(it.fecha)) + '</td>' +
        '<td><div style="font-weight:500">' + stkEsc(it.nombre || '—') + '</div><div class="mono stk-dim">' + stkEsc(it.dni || '—') + '</div></td>' +
        '<td>' + stkInsumoHtml(it) + '</td>' +
        '<td class="mono">' + stkEsc(it.cajas) + '</td>' +
        '<td>' + stkEsc(it.lugar || '—') + '</td>' +
        '<td>' + stkEsc(it.modalidad || '—') + '</td>' +
        '<td class="mono">' + stkEsc(it.pedidoId || '') + '</td>' +
        '<td>' + stkEstadoHtml(it) + '</td>' +
        '<td>' + stkMarcasHtml(it) + '</td>' +
        '<td class="stk-dim" style="font-size:11px">' + stkEsc(it.nota) + '</td>' +
        '</tr>';
    }).join('') + '</tbody></table>';
}

function stkRenderListaEntregas() {
  var cont = document.getElementById('stk-ent-lista');
  var cnt = document.getElementById('stk-ent-count');
  if (!cont || !stkEstado.analisis) return;
  var lista = stkFiltrarEntregas(stkEstado.analisis.desde, stkEstado.filtros);
  if (cnt) cnt.textContent = lista.length + ' de ' + stkEstado.analisis.desde.length;
  if (!lista.length) { cont.innerHTML = '<div class="stk-vacio">Sin entregas para estos filtros.</div>'; return; }
  var visibles = lista.slice(0, STK_MAX_FILAS_TABLA);
  cont.innerHTML = stkTablaEntregas(visibles, false) +
    (lista.length > visibles.length ? '<div class="stk-vacio">Se muestran ' + visibles.length + ' de ' + lista.length +
      '. Usá los filtros o exportá a CSV para ver todas.</div>' : '');
}

function stkSetFiltro(k, v) {
  stkEstado.filtros[k] = v;
  if (k === 'mes') stkRenderMesSel();
  stkRenderListaEntregas();
}

function stkRenderMesSel() {
  var sel = document.getElementById('stk-f-mes');
  if (sel) sel.value = stkEstado.filtros.mes;
  document.querySelectorAll('#page-stock tr.stk-clic').forEach(function(tr) {
    var on = tr.getAttribute('onclick') === "stkFiltrarMes('" + stkEstado.filtros.mes + "')";
    tr.classList.toggle('stk-sel', on);
  });
}

function stkFiltrarMes(m) {
  stkEstado.filtros.mes = (stkEstado.filtros.mes === m) ? '' : m;
  stkRenderMesSel();
  stkRenderListaEntregas();
}

function stkFiltrarTexto(i) {
  var t = stkEstado.analisis && stkEstado.analisis.textosSinArticulo[i];
  if (!t) return;
  var clave = t.clave;
  stkEstado.filtros.insumo = clave;
  var sel = document.getElementById('stk-f-insumo');
  if (sel) sel.value = clave;
  stkRenderListaEntregas();
  var lista = document.getElementById('stk-ent-lista');
  if (lista && lista.scrollIntoView) lista.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function stkLimpiarFiltros() {
  stkEstado.filtros = { mes: '', estado: '', lugar: '__todos', insumo: '__todos', texto: '', soloDup: false, soloNoId: false };
  renderStkPage();
}

// ── Exportación CSV (en el navegador; no escribe en la planilla) ──────
function stkCeldaCSV(v) {
  var s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // evita fórmulas al abrir en Excel
  return '"' + s.replace(/"/g, '""') + '"';
}

function stkExportarCSV() {
  if (!stkEstado.analisis) return;
  var lista = stkFiltrarEntregas(stkEstado.analisis.desde, stkEstado.filtros);
  var nombresEstado = { SIN_CLASIFICAR: 'Sin clasificar', SIN_STOCK: 'Sin stock', CON_ORIGEN: 'Con origen' };
  var enc = ['Fila', 'ID', 'Fecha', 'DNI', 'Apellido y nombre', 'Insumo (texto en Entregas)', 'ArticuloID', 'Nombre del artículo',
             'Identificación', 'Cajas', 'Lugar de retiro', 'Modalidad', 'PedidoId', 'Estado', 'Motivo',
             'Duplicado exacto (filas)', 'Posible duplicado (filas)', 'Artículo no identificado', 'Motivo artículo', 'Nota'];
  var lineas = [enc.map(stkCeldaCSV).join(';')];
  lista.forEach(function(it) {
    lineas.push([it.fila, it.id, stkFmtFecha(it.fecha), it.dni, it.nombre, it.insumo, it.articuloId, it.articuloNombre,
      it.via || '—', it.cajas, it.lugar, it.modalidad, it.pedidoId, nombresEstado[it.estado] || it.estado, it.motivo,
      it.dupExacto.join(' '), it.dupCercano.join(' '), it.noIdentificado ? 'Sí' : '', it.motivoArt, it.nota].map(stkCeldaCSV).join(';'));
  });
  var blob = new Blob(['﻿' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  var hoy = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = 'entregas-desde-corte_' + hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' +
    String(hoy.getDate()).padStart(2, '0') + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
