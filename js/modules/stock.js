// ══════════════════════════════════════════════════════════════════════
// 🏬 STOCK Y MOVIMIENTOS — SEC-1a.2 (lectura) + SEC-1a.3a (catálogo, mapeos y operaciones)
//                         + SEC-1a.3b-1 (entregas, bajas, ajustes, constancias, historial, compras, informes)
// ----------------------------------------------------------------------
// Módulo independiente. No modifica allData ni la hoja Entregas. Solo llama
// a acciones del servidor que empiezan con "stk_".
// ÚNICA excepción (SEC-1a.3b-1, D8): agrega fichas INCOMPLETAS de afiliados a
// DB.pacientes (y guarda con saveDB) cuando una entrega de Stock nombra un DNI
// que no tiene ficha. Nunca modifica ni borra fichas existentes.
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
    var res = await Promise.all([stkApi('stk_getData'), stkCargarMovs()]);   // SEC-1a.3a: + movimientos
    var r = res[0], rm = res[1];
    if (r.code === 'SESION_INVALIDA' || rm.code === 'SESION_INVALIDA') {
      stkEstado.datos = null; stkEstado.analisis = null;
      stkEstado.aviso = r.msg || 'Sesión vencida. Ingresá nuevamente la clave de Stock.';
    } else if (r.code === 'ACCION_DESCONOCIDA' || (r.ok && (!r.config || !r.entregas || !r.articulos))) {
      stkEstado.error = 'El servidor no tiene instalado SEC-1a.2 (falta la acción stk_getData). Actualizá el Code.gs y publicá una nueva versión.';
    } else if (!r.ok) {
      stkEstado.error = r.msg || 'No se pudieron leer los datos de Stock.';
    } else if (!rm.ok) {
      stkEstado.error = rm.msg || 'No se pudieron leer los movimientos de Stock.';
    } else {
      stkEstado.datos = r;
      stkEstado.analisis = stkAnalizar(r);
      stkRecuperarFichas();   // SEC-1a.3b-1: fichas incompletas de afiliados con entregas de Stock
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
    '<span class="b bgr">SEC-1a.3b-1</span>' +
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
    '<button class="stk-tab' + (stkEstado.tab === 'stock' ? ' active' : '') + '" onclick="stkTab(\'stock\')">📦 Stock</button>' +
    '<button class="stk-tab' + (stkEstado.tab === 'movimientos' ? ' active' : '') + '" onclick="stkTab(\'movimientos\')">🔁 Movimientos</button>' +
    '<button class="stk-tab' + (stkEstado.tab === 'historial' ? ' active' : '') + '" onclick="stkTab(\'historial\')">📤 Historial de entregas</button>' +   // SEC-1a.3b-1
    '<button class="stk-tab' + (stkEstado.tab === 'compras' ? ' active' : '') + '" onclick="stkTab(\'compras\')">🧾 Compras</button>' +                  // SEC-1a.3b-1
    '<button class="stk-tab' + (stkEstado.tab === 'catalogo' ? ' active' : '') + '" onclick="stkTab(\'catalogo\')">🗂 Catálogo</button>' +
    '<button class="stk-tab' + (stkEstado.tab === 'entregas' ? ' active' : '') + '" onclick="stkTab(\'entregas\')">📋 Entregas desde el corte' +
      (a && a.conteo.SIN_CLASIFICAR ? ' <span class="b br">' + a.conteo.SIN_CLASIFICAR + '</span>' : '') + '</button>' +
    '</div><div id="stk-contenido"></div>';
  el.innerHTML = html;
  var c = document.getElementById('stk-contenido');
  if (stkEstado.tab === 'entregas') renderStkEntregas(c);
  else if (stkEstado.tab === 'stock' || stkEstado.tab === 'movimientos' || stkEstado.tab === 'catalogo' ||
           stkEstado.tab === 'historial' || stkEstado.tab === 'compras') renderStkNuevaSolapa(c);   // SEC-1a.3a + 3b-1
  else renderStkResumen(c);
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
    '<div class="stk-aviso">📦 El saldo por movimientos se consulta en la solapa Stock y las operaciones se cargan en Movimientos. ' +
      'Las entregas, bajas y ajustes registrados en Stock descuentan; las entregas de Diabetes de la hoja Entregas todavía no (SEC-1a.4).</div>' +
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
    }).join('') : '<tr><td colspan="4" class="stk-dim" style="text-align:center">Sin mapeos. Los mapeos se cargan en la solapa 🗂 Catálogo.</td></tr>') +
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
    ' texto(s) distinto(s) · se mapean en la solapa 🗂 Catálogo</span></div><div class="cb tw">' +
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

// ══════════════════════════════════════════════════════════════════════
// SEC-1a.3a · CATÁLOGO · MAPEOS · STOCK INICIAL · INGRESOS · TRANSFERENCIAS
// ----------------------------------------------------------------------
// · "Saldo por movimientos": las Entregas NO descuentan stock hasta SEC-1a.4.
// · Los artículos se eligen SIEMPRE de un selector (nunca texto libre).
// · Toda escritura lleva ReqId; el servidor valida todo y audita.
// ══════════════════════════════════════════════════════════════════════

var STK_NOMBRES_TIPO = { STOCK_INICIAL: 'Stock inicial', INGRESO: 'Ingreso', TRANSFERENCIA: 'Transferencia',
                         ENTREGA: 'Entrega', BAJA: 'Baja', AJUSTE: 'Ajuste' };   // SEC-1a.3b-1
var STK_PREFIJOS = { DIABETES: 'DB-', MATERIAL: 'MAT-', ADMINISTRATIVO: 'ADM-', EQUIPAMIENTO: 'EQ-', OTRO: 'OTR-' };
var STK_MAX_OPS_LISTA = 300;

stkEstado.movs = [];
stkEstado.hoy = '';
stkEstado.ficha = null;
stkEstado.fichaFecha = '';
stkEstado.fichaArt = '';
stkEstado.stockCat = '';
stkEstado.stockTodas = false;
stkEstado.filtrosMov = { tipo: '', ubic: '', art: '', mes: '', estado: 'ACTIVO' };
stkEstado.opsAbiertas = {};
var stkRefs = [];
var stkForm = null;

function stkRef(v) { stkRefs.push(v); return stkRefs.length - 1; }

function stkNuevoReqId() {
  return 'r' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function stkAviso(msg, tipo) {
  if (typeof toast === 'function') { try { toast(msg, tipo || 'ok'); return; } catch (e) {} }
}

// ── Estilos propios de 1a.3a (inyectados: index.html no se modifica) ───
(function stkInyectarEstilos() {
  if (typeof document === 'undefined' || document.getElementById('stk-estilos-1a3a')) return;
  var st = document.createElement('style');
  st.id = 'stk-estilos-1a3a';
  st.textContent = [
    '#page-stock .stk-num{text-align:right;font-family:"DM Mono",monospace;white-space:nowrap}',
    '#page-stock .stk-neg{color:var(--rd);font-weight:700}',
    '#page-stock .stk-cero{color:var(--tx3)}',
    '#page-stock .stk-acciones{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
    '#page-stock .stk-op-det td{background:var(--sf2);font-size:12px}',
    '#page-stock .stk-anulada td{opacity:.55}',
    '#page-stock .stk-enlace{background:none;border:none;color:var(--ac);cursor:pointer;font:inherit;font-weight:600;padding:0}',
    '#page-stock .stk-sel-in{background:var(--sf2);border:1px solid var(--bd2);border-radius:7px;padding:6px 10px;color:var(--tx);font-size:12px;width:auto;height:auto}',
    '#stk-modal .md{max-width:880px}',
    '#stk-modal .stk-k{font-size:10px;font-weight:600;color:var(--tx3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}',
    '#stk-modal .stk-dim{color:var(--tx3);font-size:11.5px}',
    '#stk-modal .stk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:14px}',
    '#stk-modal .stk-in{background:var(--sf2);border:1px solid var(--bd2);border-radius:7px;padding:7px 10px;color:var(--tx);font-size:13px;width:100%;height:auto;font-family:"DM Sans",sans-serif;box-sizing:border-box}',
    '#stk-modal .stk-in:disabled{opacity:.55}',
    '#stk-modal .stk-in.stk-num{text-align:right;font-family:"DM Mono",monospace}',
    '#stk-modal .stk-aviso{background:var(--sf2);border:1px solid var(--bd2);border-radius:8px;padding:9px 12px;font-size:12.5px;color:var(--tx2);line-height:1.55;margin-bottom:12px}',
    '#stk-modal .stk-aviso.warn{background:var(--orb);border-color:rgba(243,156,18,.35);color:var(--or)}',
    '#stk-modal .stk-aviso.bad{background:var(--rdb);border-color:rgba(231,76,60,.35);color:var(--rd)}',
    '#stk-modal .stk-aviso.ok{background:var(--gnb);border-color:var(--gnbd);color:var(--gn)}',
    '#stk-modal .stk-lineas td,#stk-modal .stk-lineas th{padding:5px 6px;vertical-align:middle}',
    '#stk-modal .stk-check{display:inline-flex;align-items:center;gap:6px;margin:0;font-size:12.5px;color:var(--tx);text-transform:none;letter-spacing:0;font-weight:500;cursor:pointer}',
    '#stk-modal .stk-check input{width:auto;height:auto}',
    '#stk-modal .stk-msg{min-height:18px;font-size:12.5px;margin-top:6px}'
  ].join('\n');
  document.head.appendChild(st);
})();

// ── Datos derivados ───────────────────────────────────────────────────
function stkArtMap() {
  var m = {};
  ((stkEstado.datos && stkEstado.datos.articulos) || []).forEach(function(a) { m[stkCampo(a, 'ID')] = a; });
  return m;
}

function stkUbicMap() {
  var m = {};
  ((stkEstado.datos && stkEstado.datos.ubicaciones) || []).forEach(function(u) { m[stkCampo(u, 'ID')] = u; });
  return m;
}

function stkNombreUbic(id) {
  var u = stkUbicMap()[id];
  return u ? stkCampo(u, 'Nombre') || id : (id || '—');
}

function stkUbicacionesActivas() {
  return ((stkEstado.datos && stkEstado.datos.ubicaciones) || []).filter(function(u) { return stkVerdadero(u.Activa); });
}

function stkArticulosActivos() {
  return ((stkEstado.datos && stkEstado.datos.articulos) || []).filter(function(a) { return stkVerdadero(a.Activo); });
}

// Ajuste 1a.3a: solo artículos activos que controlan stock y no se controlan por unidad (eso llega en 1a.3b)
function stkArticulosOperables() {
  return stkArticulosActivos().filter(function(a) { return stkVerdadero(a.ControlaStock) && !stkVerdadero(a.ControlaUnidades); });
}

function stkCant(n, art) {
  var u = art ? stkCampo(art, 'Unidad') : '';
  return (Number(n) || 0).toLocaleString('es-AR') + (u ? ' ' + u : '');
}

function stkEsActivo(m) { return String(m.Estado) !== 'ANULADO'; }

// Saldo[ubicación][artículo] con movimientos activos hasta "hasta" (inclusive; vacío = todos)
function stkSaldos(hasta) {
  var s = {};
  stkEstado.movs.forEach(function(m) {
    if (!stkEsActivo(m) || (hasta && String(m.Fecha) > hasta)) return;
    var a = stkCampo(m, 'ArticuloID'), c = Number(m.Cantidad) || 0;
    var d = stkCampo(m, 'Destino'), o = stkCampo(m, 'Origen');
    if (d) { s[d] = s[d] || {}; s[d][a] = (s[d][a] || 0) + c; }
    if (o) { s[o] = s[o] || {}; s[o][a] = (s[o][a] || 0) - c; }
  });
  return s;
}

// MISMA regla que stkVerificarSaldos del servidor
function stkVerificarSaldosCli(movs, cambios) {
  var porPar = {};
  cambios.forEach(function(c) {
    if (c.delta >= 0) return;
    var k = c.ubicacion + '|' + c.articuloId;
    if (!porPar[k] || c.fecha < porPar[k]) porPar[k] = c.fecha;
  });
  var faltantes = [];
  Object.keys(porPar).forEach(function(k) {
    var p = k.split('|'), u = p[0], a = p[1], desde = porPar[k], porFecha = {};
    function sumar(f, v) { porFecha[f] = (porFecha[f] || 0) + v; }
    movs.forEach(function(m) {
      if (!stkEsActivo(m) || stkCampo(m, 'ArticuloID') !== a) return;
      var cant = Number(m.Cantidad) || 0, f = String(m.Fecha);
      if (stkCampo(m, 'Destino') === u) sumar(f, cant);
      if (stkCampo(m, 'Origen') === u) sumar(f, -cant);
    });
    cambios.forEach(function(c) { if (c.ubicacion === u && c.articuloId === a) sumar(c.fecha, c.delta); });
    var saldo = 0, minimo = null, fechaMin = '';
    Object.keys(porFecha).sort().forEach(function(f) {
      saldo += porFecha[f];
      if (f >= desde && (minimo === null || saldo < minimo)) { minimo = saldo; fechaMin = f; }
    });
    if (minimo !== null && minimo < 0) faltantes.push({ ubicacion: u, articuloId: a, fecha: fechaMin, saldoMinimo: minimo });
  });
  return faltantes;
}

function stkOperaciones() {
  var ops = {}, orden = [];
  stkEstado.movs.forEach(function(m) {
    var id = stkCampo(m, 'OperacionID') || stkCampo(m, 'ID');
    if (!ops[id]) {
      ops[id] = { id: id, tipo: stkCampo(m, 'Tipo'), fecha: stkCampo(m, 'Fecha'), origen: stkCampo(m, 'Origen'),
                  destino: stkCampo(m, 'Destino'), proveedor: stkCampo(m, 'Proveedor'), comprobante: stkCampo(m, 'Comprobante'),
                  observacion: stkCampo(m, 'Observacion'), creadoEn: stkCampo(m, 'CreadoEn'), modificadoEn: stkCampo(m, 'ModificadoEn'),
                  // SEC-1a.3b-1
                  tipoDestinatario: stkCampo(m, 'TipoDestinatario'), destinatario: stkCampo(m, 'Destinatario'), dni: stkCampo(m, 'DNI'),
                  seccional: stkCampo(m, 'SeccionalDestino'), retira: stkCampo(m, 'Retira'), retiraDetalle: stkCampo(m, 'RetiraDetalle'),
                  causa: stkCampo(m, 'Causa'), motivo: stkCampo(m, 'Motivo'),
                  activa: false, lineas: [] };
      orden.push(id);
    }
    ops[id].lineas.push(m);
    if (stkEsActivo(m)) ops[id].activa = true;
  });
  return orden.map(function(id) { return ops[id]; })
    .sort(function(a, b) { return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : (a.creadoEn < b.creadoEn ? 1 : -1); });
}

function stkResumenLineas(op, max) {
  var arts = stkArtMap();
  var partes = op.lineas.map(function(l) {
    var a = arts[stkCampo(l, 'ArticuloID')];
    var signo = op.tipo === 'AJUSTE' ? (stkCampo(l, 'Destino') ? '+' : '−') : '';   // SEC-1a.3b-1
    return (a ? stkCampo(a, 'Nombre') : stkCampo(l, 'ArticuloID')) + ' × ' + signo + stkCant(l.Cantidad, a);
  });
  var max2 = max || 3;
  return partes.slice(0, max2).join(' · ') + (partes.length > max2 ? ' · y ' + (partes.length - max2) + ' más' : '');
}

// Uso de un artículo (aproximación de pantalla; el servidor decide)
function stkUsoCliente(id) {
  var uso = { movimientos: 0, entregas: 0, mapeos: 0 };
  stkEstado.movs.forEach(function(m) { if (stkCampo(m, 'ArticuloID') === id) uso.movimientos++; });
  ((stkEstado.datos && stkEstado.datos.mapeos) || []).forEach(function(m) { if (stkCampo(m, 'ArticuloID') === id) uso.mapeos++; });
  var R = stkEstado.analisis && stkEstado.analisis.resolutor;
  if (R) {
    ((stkEstado.datos.entregas && stkEstado.datos.entregas.filas) || []).forEach(function(f) {
      var r = stkResolverArticulo(f, R);
      if (r.articulo && stkCampo(r.articulo, 'ID') === id) uso.entregas++;
    });
  }
  uso.total = uso.movimientos + uso.entregas + uso.mapeos;
  return uso;
}

// Compatibilidad con los topes actuales (usa las funciones existentes solo para leer)
function stkCompatTopes(texto) {
  var tipo = (typeof getTipoInsumo === 'function') ? getTipoInsumo(texto) : null;
  var u = (typeof cajasAUnidadesSec === 'function') ? cajasAUnidadesSec(texto, 1) : null;
  return { tipo: tipo, unidadesPorEnvase: u };
}

// ── Carga de movimientos (complementa stk_getData) ─────────────────────
async function stkCargarMovs() {
  var r = await stkApi('stk_getMovs');
  if (r.code === 'SESION_INVALIDA') return r;
  if (r.code === 'ACCION_DESCONOCIDA' || (r.ok && !Array.isArray(r.movimientos)))
    return { ok: false, msg: 'El servidor no tiene instalado SEC-1a.3a (falta la acción stk_getMovs). Actualizá el Code.gs y publicá una nueva versión.' };
  if (r.ok && !r.tiposDestinatario)   // SEC-1a.3b-1
    return { ok: false, msg: 'El servidor no tiene instalado SEC-1a.3b-1. Actualizá el Code.gs, ejecutá stkSetup y publicá una nueva versión.' };
  if (r.ok) {
    stkEstado.movs = r.movimientos; stkEstado.hoy = r.hoy || '';
    stkEstado.listas = { campos: r.camposEntrega || {}, estados: r.estadosElemento || [],
      tiposDestinatario: r.tiposDestinatario || {}, retira: r.retira || {}, causasBaja: r.causasBaja || {}, estadosConstancia: r.estadosConstancia || {} };
    stkEstado.afiliadosEntregas = r.afiliadosEntregas || [];
  }
  return r;
}

// ── Router de solapas nuevas ──────────────────────────────────────────
function renderStkNuevaSolapa(c) {
  stkRefs = [];
  if (stkEstado.tab === 'stock') { if (stkEstado.ficha) renderStkFicha(c); else renderStkStock(c); }
  else if (stkEstado.tab === 'movimientos') renderStkMovimientos(c);
  else if (stkEstado.tab === 'catalogo') renderStkCatalogo(c);
  else if (stkEstado.tab === 'historial') renderStkHistorial(c);   // SEC-1a.3b-1
  else if (stkEstado.tab === 'compras') renderStkCompras(c);       // SEC-1a.3b-1
}

function stkBannerSaldo() {
  return '<div class="stk-aviso warn">⚠ <strong>Saldo por movimientos</strong>: stock inicial + ingresos ± transferencias − entregas − bajas ± ajustes. ' +
    'Todavía <strong>no descuenta las entregas de Diabetes de la hoja Entregas</strong> (se habilita en SEC-1a.4).</div>';
}

// ── Solapa STOCK ──────────────────────────────────────────────────────
function renderStkStock(c) {
  var arts = stkArtMap();
  var saldos = stkSaldos('');
  var ubics = ((stkEstado.datos && stkEstado.datos.ubicaciones) || []).filter(function(u) {
    return stkEstado.stockTodas ? stkVerdadero(u.Activa) || saldos[stkCampo(u, 'ID')] : !!saldos[stkCampo(u, 'ID')];
  });
  var conMov = {};
  Object.keys(saldos).forEach(function(u) { Object.keys(saldos[u]).forEach(function(a) { conMov[a] = true; }); });
  var lista = ((stkEstado.datos && stkEstado.datos.articulos) || []).filter(function(a) {
    var id = stkCampo(a, 'ID');
    if (stkEstado.stockCat && String(a.Categoria) !== stkEstado.stockCat) return false;
    return conMov[id] || (stkEstado.stockTodas && stkVerdadero(a.Activo));
  });
  var cats = {};
  lista.forEach(function(a) { var k = String(a.Categoria || 'OTRO'); (cats[k] = cats[k] || []).push(a); });
  var orden = STK_ORDEN_CATEGORIAS.filter(function(k) { return cats[k]; }).concat(Object.keys(cats).filter(function(k) { return STK_ORDEN_CATEGORIAS.indexOf(k) < 0; }));

  var h = stkBannerSaldo();
  h += '<div class="stk-filtros">' +
    '<select class="stk-sel-in" onchange="stkEstado.stockCat=this.value;renderStkPage()">' + stkOpt('', 'Todas las categorías', stkEstado.stockCat) +
      ((stkEstado.datos && stkEstado.datos.categorias) || STK_ORDEN_CATEGORIAS).map(function(k) { return stkOpt(k, k, stkEstado.stockCat); }).join('') + '</select>' +
    '<label class="stk-check"><input type="checkbox" ' + (stkEstado.stockTodas ? 'checked ' : '') +
      'onchange="stkEstado.stockTodas=this.checked;renderStkPage()"> Mostrar todas las ubicaciones y artículos activos</label>' +
    '</div>';
  h += '<div class="card"><div class="ch">📍 <span class="ct">Fichas de ubicación</span></div><div class="stk-body stk-acciones">' +
    stkUbicacionesActivas().map(function(u) {
      return '<button class="btn bs bsm" onclick="stkAbrirFicha(stkRefs[' + stkRef(stkCampo(u, 'ID')) + '])">' + stkEsc(stkCampo(u, 'Nombre')) + '</button>';
    }).join('') + '</div></div>';

  if (!lista.length || !ubics.length) {
    h += '<div class="card"><div class="stk-vacio">Todavía no hay movimientos. Cargá el stock inicial, ingresos o transferencias en la solapa 🔁 Movimientos.</div></div>';
    c.innerHTML = h; return;
  }
  h += '<div class="card"><div class="ch">📦 <span class="ct">Saldo por movimientos · artículo × ubicación</span></div><div class="cb tw"><table>' +
    '<thead><tr><th>Artículo</th><th>Unidad</th>' + ubics.map(function(u) {
      return '<th class="stk-num"><button class="stk-enlace" title="Abrir ficha" onclick="stkAbrirFicha(stkRefs[' + stkRef(stkCampo(u, 'ID')) + '])">' + stkEsc(stkCampo(u, 'Nombre')) + '</button></th>';
    }).join('') + '<th class="stk-num">Total</th></tr></thead><tbody>' +
    orden.map(function(k) {
      return '<tr class="stk-grupo"><td colspan="' + (ubics.length + 3) + '">' + stkEsc(k) + '</td></tr>' +
        cats[k].map(function(a) {
          var id = stkCampo(a, 'ID'), tot = 0;
          var celdas = ubics.map(function(u) {
            var v = (saldos[stkCampo(u, 'ID')] || {})[id] || 0; tot += v;
            return '<td class="stk-num ' + (v < 0 ? 'stk-neg' : v === 0 ? 'stk-cero' : '') + '">' + v.toLocaleString('es-AR') + '</td>';
          }).join('');
          return '<tr><td>' + stkEsc(a.Nombre) + (stkVerdadero(a.Activo) ? '' : ' <span class="b bgr">inactivo</span>') +
            '<div class="mono stk-dim">' + stkEsc(id) + '</div></td><td>' + stkEsc(a.Unidad) + '</td>' + celdas +
            '<td class="stk-num ' + (tot < 0 ? 'stk-neg' : '') + '" style="font-weight:700">' + tot.toLocaleString('es-AR') + '</td></tr>';
        }).join('');
    }).join('') + '</tbody></table></div></div>';
  c.innerHTML = h;
}

function stkAbrirFicha(id) {
  stkEstado.ficha = id; stkEstado.fichaFecha = ''; stkEstado.fichaArt = '';
  stkEstado.tab = 'stock';
  renderStkPage();
}

// ── Ficha de ubicación ────────────────────────────────────────────────
function renderStkFicha(c) {
  var U = stkEstado.ficha, arts = stkArtMap();
  var hasta = stkEstado.fichaFecha || '';
  var saldos = stkSaldos(hasta)[U] || {};
  var ops = stkOperaciones().filter(function(op) { return op.activa && (!hasta || op.fecha <= hasta); });
  var hoy = stkEstado.hoy || '';

  var h = '<div class="stk-filtros">' +
    '<button class="btn bs bsm" onclick="stkEstado.ficha=null;renderStkPage()">← Volver al stock</button>' +
    '<span class="ct" style="font-size:16px;font-weight:700">' + stkEsc(stkNombreUbic(U)) + '</span>' +
    '<span style="flex:1"></span><span class="stk-dim">Saldo al día</span>' +
    '<input type="date" class="stk-sel-in" min="' + stkEsc(stkEstado.analisis.corte) + '"' + (hoy ? ' max="' + stkEsc(hoy) + '"' : '') +
      ' value="' + stkEsc(hasta) + '" onchange="stkEstado.fichaFecha=this.value;renderStkPage()">' +
    (hasta ? '<button class="btn bs bsm" onclick="stkEstado.fichaFecha=\'\';renderStkPage()">Hoy</button>' : '') +
    '</div>' + stkBannerSaldo() +
    (hasta ? '<div class="stk-aviso">Mostrando el saldo y los movimientos hasta el ' + stkFmtFecha(hasta) + ' inclusive.</div>' : '');

  // Saldo por artículo
  var ids = Object.keys(saldos);
  var cats = {};
  ids.forEach(function(id) { var a = arts[id]; var k = a ? String(a.Categoria) : 'OTRO'; (cats[k] = cats[k] || []).push(id); });
  var orden = STK_ORDEN_CATEGORIAS.filter(function(k) { return cats[k]; }).concat(Object.keys(cats).filter(function(k) { return STK_ORDEN_CATEGORIAS.indexOf(k) < 0; }));
  h += '<div class="card"><div class="ch">📦 <span class="ct">Saldo por artículo</span></div><div class="cb tw">' +
    (ids.length ? '<table><thead><tr><th>Artículo</th><th class="stk-num">Saldo</th></tr></thead><tbody>' +
      orden.map(function(k) {
        return '<tr class="stk-grupo"><td colspan="2">' + stkEsc(k) + '</td></tr>' + cats[k].map(function(id) {
          var a = arts[id], v = saldos[id];
          return '<tr><td>' + stkEsc(a ? a.Nombre : id) + '<div class="mono stk-dim">' + stkEsc(id) + '</div></td>' +
            '<td class="stk-num ' + (v < 0 ? 'stk-neg' : v === 0 ? 'stk-cero' : '') + '" style="font-weight:600">' + stkEsc(stkCant(v, a)) + '</td></tr>';
        }).join('');
      }).join('') + '</tbody></table>' : '<div class="stk-vacio">Sin movimientos en esta ubicación.</div>') + '</div></div>';

  // Stock inicial
  var si = ops.filter(function(op) { return op.tipo === 'STOCK_INICIAL' && op.destino === U; });
  h += '<div class="card"><div class="ch">🏁 <span class="ct">Stock inicial al ' + stkFmtFecha(stkEstado.analisis.corte) + '</span></div><div class="cb tw">' +
    (si.length ? stkTablaOps(si, U) : '<div class="stk-vacio">No declarado.</div>') + '</div></div>';
  var ing = ops.filter(function(op) { return op.tipo === 'INGRESO' && op.destino === U; });
  if (ing.length) h += '<div class="card"><div class="ch">🧾 <span class="ct">Ingresos / compras</span><span class="stk-dim">' + ing.length + '</span></div><div class="cb tw">' + stkTablaOps(ing, U) + '</div></div>';
  var env = ops.filter(function(op) { return op.tipo === 'TRANSFERENCIA' && op.origen === U; });
  var rec = ops.filter(function(op) { return op.tipo === 'TRANSFERENCIA' && op.destino === U; });
  h += '<div class="card"><div class="ch">📤 <span class="ct">Transferencias enviadas</span><span class="stk-dim">' + env.length + '</span></div><div class="cb tw">' +
    (env.length ? stkTablaOps(env, U) : '<div class="stk-vacio">Sin transferencias enviadas.</div>') + '</div></div>';
  h += '<div class="card"><div class="ch">📥 <span class="ct">Transferencias recibidas</span><span class="stk-dim">' + rec.length + '</span></div><div class="cb tw">' +
    (rec.length ? stkTablaOps(rec, U) : '<div class="stk-vacio">Sin transferencias recibidas.</div>') + '</div></div>';
  // SEC-1a.3b-1
  var ent = ops.filter(function(op) { return op.tipo === 'ENTREGA' && op.origen === U; });
  if (ent.length) h += '<div class="card"><div class="ch">📤 <span class="ct">Entregas</span><span class="stk-dim">' + ent.length + ' · detalle completo en 📤 Historial de entregas</span></div><div class="cb tw">' + stkTablaOps(ent, U) + '</div></div>';
  var baj = ops.filter(function(op) { return (op.tipo === 'BAJA' && op.origen === U) || (op.tipo === 'AJUSTE' && (op.origen === U || op.destino === U)); });
  if (baj.length) h += '<div class="card"><div class="ch">🗑 <span class="ct">Bajas y ajustes</span><span class="stk-dim">' + baj.length + '</span></div><div class="cb tw">' + stkTablaOps(baj, U) + '</div></div>';

  // Kárdex
  var conMovs = {};
  stkEstado.movs.forEach(function(m) {
    if (stkEsActivo(m) && (stkCampo(m, 'Origen') === U || stkCampo(m, 'Destino') === U)) conMovs[stkCampo(m, 'ArticuloID')] = true;
  });
  var opcK = Object.keys(conMovs).sort(function(x, y) { return String((arts[x] || {}).Nombre || x) < String((arts[y] || {}).Nombre || y) ? -1 : 1; });
  if (stkEstado.fichaArt && !conMovs[stkEstado.fichaArt]) stkEstado.fichaArt = '';
  if (!stkEstado.fichaArt && opcK.length) stkEstado.fichaArt = opcK[0];
  h += '<div class="card"><div class="ch">📒 <span class="ct">Historial por artículo (kárdex)</span>' +
    (opcK.length ? '<select class="stk-sel-in" style="margin-left:auto" onchange="stkEstado.fichaArt=this.value;renderStkPage()">' +
      opcK.map(function(id) { return stkOpt(id, (arts[id] ? arts[id].Nombre : id), stkEstado.fichaArt); }).join('') + '</select>' : '') +
    '</div><div class="cb tw">' + (opcK.length ? stkKardexHtml(U, stkEstado.fichaArt, hasta) : '<div class="stk-vacio">Sin movimientos.</div>') +
    '<div class="stk-body stk-dim" style="margin:0">Las operaciones anuladas no se muestran en la ficha (ver 🔁 Movimientos).</div></div></div>';
  c.innerHTML = h;
}

function stkTablaOps(ops, U) {
  var arts = stkArtMap();
  return '<table><thead><tr><th>Fecha</th><th>Detalle</th><th>Artículo</th><th class="stk-num">Cantidad</th><th>Operación</th></tr></thead><tbody>' +
    ops.map(function(op) {
      var det = op.tipo === 'TRANSFERENCIA' ? (op.origen === U ? '→ ' + stkNombreUbic(op.destino) : '← ' + stkNombreUbic(op.origen))
              : op.tipo === 'INGRESO' ? [op.proveedor, op.comprobante].filter(Boolean).join(' · ') || '—'
              : stkDetalleOp3b(op) || (op.observacion || '—');   // SEC-1a.3b-1
      return op.lineas.filter(stkEsActivo).map(function(l, i) {
        var a = arts[stkCampo(l, 'ArticuloID')];
        var signo = op.tipo === 'AJUSTE' ? (stkCampo(l, 'Destino') ? '+' : '−') : '';
        return '<tr><td class="mono">' + (i ? '' : stkFmtFecha(op.fecha)) + '</td><td>' + (i ? '' : stkEsc(det)) + '</td><td>' +
          stkEsc(a ? a.Nombre : l.ArticuloID) + '</td><td class="stk-num">' + stkEsc(signo + stkCant(l.Cantidad, a)) + '</td><td class="mono stk-dim">' +
          (i ? '' : stkEsc(op.id)) + '</td></tr>';
      }).join('');
    }).join('') + '</tbody></table>';
}

function stkKardexHtml(U, artId, hasta) {
  var a = stkArtMap()[artId];
  var filas = stkEstado.movs.filter(function(m) {
    return stkEsActivo(m) && stkCampo(m, 'ArticuloID') === artId && (stkCampo(m, 'Origen') === U || stkCampo(m, 'Destino') === U) &&
      (!hasta || String(m.Fecha) <= hasta);
  }).sort(function(x, y) { return String(x.Fecha) < String(y.Fecha) ? -1 : String(x.Fecha) > String(y.Fecha) ? 1 : (String(x.CreadoEn) < String(y.CreadoEn) ? -1 : 1); });
  var saldo = 0;
  return '<table><thead><tr><th>Fecha</th><th>Tipo</th><th>Contraparte / detalle</th><th class="stk-num">Entrada</th><th class="stk-num">Salida</th><th class="stk-num">Saldo</th><th>Operación</th></tr></thead><tbody>' +
    filas.map(function(m) {
      var c = Number(m.Cantidad) || 0, entra = stkCampo(m, 'Destino') === U, sale = stkCampo(m, 'Origen') === U;
      saldo += (entra ? c : 0) - (sale ? c : 0);
      var contra = stkCampo(m, 'Tipo') === 'TRANSFERENCIA' ? (entra ? 'desde ' + stkNombreUbic(m.Origen) : 'hacia ' + stkNombreUbic(m.Destino))
                 : stkCampo(m, 'Tipo') === 'INGRESO' ? [stkCampo(m, 'Proveedor'), stkCampo(m, 'Comprobante')].filter(Boolean).join(' · ') || '—'
                 : stkDetalleMov3b(m) || stkCampo(m, 'Observacion') || '—';   // SEC-1a.3b-1
      return '<tr><td class="mono">' + stkFmtFecha(String(m.Fecha)) + '</td><td>' + stkEsc(STK_NOMBRES_TIPO[m.Tipo] || m.Tipo) + '</td><td>' + stkEsc(contra) +
        '</td><td class="stk-num">' + (entra ? c.toLocaleString('es-AR') : '') + '</td><td class="stk-num">' + (sale ? c.toLocaleString('es-AR') : '') +
        '</td><td class="stk-num ' + (saldo < 0 ? 'stk-neg' : '') + '" style="font-weight:600">' + saldo.toLocaleString('es-AR') + '</td><td class="mono stk-dim">' + stkEsc(m.OperacionID) + '</td></tr>';
    }).join('') + '</tbody></table><div class="stk-body stk-dim" style="margin:0">Unidad: ' + stkEsc(a ? a.Unidad : '—') + '</div>';
}

// ── Solapa MOVIMIENTOS ────────────────────────────────────────────────
function renderStkMovimientos(c) {
  var f = stkEstado.filtrosMov, arts = stkArtMap();
  var modo = stkEstado.datos.config && stkEstado.datos.config.modoCargaInicial;
  var ops = stkOperaciones();
  var meses = {};
  ops.forEach(function(op) { if (op.fecha) meses[op.fecha.slice(0, 7)] = true; });
  var filtradas = ops.filter(function(op) {
    if (f.tipo && op.tipo !== f.tipo) return false;
    if (f.ubic && op.origen !== f.ubic && op.destino !== f.ubic) return false;
    if (f.art && !op.lineas.some(function(l) { return stkCampo(l, 'ArticuloID') === f.art; })) return false;
    if (f.mes && op.fecha.slice(0, 7) !== f.mes) return false;
    if (f.estado === 'ACTIVO' && !op.activa) return false;
    if (f.estado === 'ANULADO' && op.activa) return false;
    return true;
  });
  var h = '<div class="stk-filtros">' +
    '<button class="btn bp bsm" ' + (modo ? '' : 'disabled title="Solo con el modo carga inicial activo" ') + 'onclick="stkAbrirOperacion(\'STOCK_INICIAL\')">+ Stock inicial</button>' +
    '<button class="btn bp bsm" onclick="stkAbrirOperacion(\'INGRESO\')">+ Ingreso / compra</button>' +
    '<button class="btn bp bsm" onclick="stkAbrirOperacion(\'TRANSFERENCIA\')">+ Transferencia</button>' +
    '<button class="btn bp bsm" onclick="stkAbrirEntrega()">+ Entrega</button>' +                   // SEC-1a.3b-1
    '<button class="btn bs bsm" onclick="stkAbrirOperacion3b(\'BAJA\')">+ Baja</button>' +          // SEC-1a.3b-1
    '<button class="btn bs bsm" onclick="stkAbrirOperacion3b(\'AJUSTE\')">± Ajuste</button>' +      // SEC-1a.3b-1
    '<span style="flex:1"></span>' +
    (modo ? '<span class="b bo">Modo carga inicial activo</span>' : '<span class="b bg">Modo carga inicial inactivo</span>') + '</div>';
  h += '<div class="stk-filtros">' +
    '<select class="stk-sel-in" onchange="stkEstado.filtrosMov.tipo=this.value;renderStkPage()">' + stkOpt('', 'Todos los tipos', f.tipo) +
      Object.keys(STK_NOMBRES_TIPO).map(function(t) { return stkOpt(t, STK_NOMBRES_TIPO[t], f.tipo); }).join('') + '</select>' +
    '<select class="stk-sel-in" onchange="stkEstado.filtrosMov.ubic=this.value;renderStkPage()">' + stkOpt('', 'Todas las ubicaciones', f.ubic) +
      ((stkEstado.datos.ubicaciones) || []).map(function(u) { return stkOpt(stkCampo(u, 'ID'), stkCampo(u, 'Nombre'), f.ubic); }).join('') + '</select>' +
    '<select class="stk-sel-in" style="max-width:240px" onchange="stkEstado.filtrosMov.art=this.value;renderStkPage()">' + stkOpt('', 'Todos los artículos', f.art) +
      ((stkEstado.datos.articulos) || []).map(function(a) { return stkOpt(stkCampo(a, 'ID'), stkCampo(a, 'Nombre'), f.art); }).join('') + '</select>' +
    '<select class="stk-sel-in" onchange="stkEstado.filtrosMov.mes=this.value;renderStkPage()">' + stkOpt('', 'Todos los meses', f.mes) +
      Object.keys(meses).sort().reverse().map(function(m) { return stkOpt(m, stkFmtMes(m), f.mes); }).join('') + '</select>' +
    '<select class="stk-sel-in" onchange="stkEstado.filtrosMov.estado=this.value;renderStkPage()">' +
      stkOpt('ACTIVO', 'Activas', f.estado) + stkOpt('ANULADO', 'Anuladas', f.estado) + stkOpt('', 'Todas', f.estado) + '</select>' +
    '</div>';
  var vis = filtradas.slice(0, STK_MAX_OPS_LISTA);
  h += '<div class="card"><div class="ch">🔁 <span class="ct">Operaciones</span><span class="stk-dim">' + filtradas.length + ' de ' + ops.length + '</span></div><div class="cb tw">' +
    (vis.length ? '<table><thead><tr><th>Fecha</th><th>Tipo</th><th>Recorrido</th><th>Artículos</th><th>Proveedor / comprobante</th><th>Estado</th><th></th></tr></thead><tbody>' +
      vis.map(function(op) {
        var abierta = !!stkEstado.opsAbiertas[op.id], ref = stkRef(op.id);
        var rec = stkRecorridoOp(op);   // SEC-1a.3b-1 (incluye los tipos de 1a.3a con el mismo texto)
        var fila = '<tr class="' + (op.activa ? '' : 'stk-anulada') + '"><td class="mono">' + stkFmtFecha(op.fecha) + '</td><td>' +
          stkEsc(STK_NOMBRES_TIPO[op.tipo] || op.tipo) + '</td><td>' + stkEsc(rec) + '</td><td style="font-size:12px">' + stkEsc(stkResumenLineas(op, 3)) +
          '</td><td class="stk-dim">' + stkEsc([op.proveedor, op.comprobante].filter(Boolean).join(' · ')) + '</td><td>' +
          (op.activa ? '<span class="b bg">Activa</span>' : '<span class="b bgr">Anulada</span>') + '</td><td><div class="stk-acciones">' +
          '<button class="btn bs bsm" onclick="stkToggleOp(stkRefs[' + ref + '])">' + (abierta ? 'Ocultar' : 'Ver') + '</button>' +
          (op.activa ? '<button class="btn brd bsm" onclick="stkAbrirAnular(stkRefs[' + ref + '])">Anular</button>' : '') + '</div></td></tr>';
        if (abierta) {
          fila += '<tr class="stk-op-det"><td colspan="7"><table><thead><tr><th>Artículo</th><th class="stk-num">Cantidad</th>' +
            (op.tipo === 'INGRESO' ? '<th class="stk-num">Precio unit.</th><th class="stk-num">Importe</th>' : '') + '<th>Estado</th><th>ID línea</th></tr></thead><tbody>' +
            op.lineas.map(function(l) {
              var a = arts[stkCampo(l, 'ArticuloID')];
              var sg = op.tipo === 'AJUSTE' ? (stkCampo(l, 'Destino') ? '+' : '−') : '';   // SEC-1a.3b-1
              return '<tr><td>' + stkEsc(a ? a.Nombre : l.ArticuloID) + stkExtraHtml(l.DatosExtra) + '</td><td class="stk-num">' + stkEsc(sg + stkCant(l.Cantidad, a)) + '</td>' +
                (op.tipo === 'INGRESO' ? '<td class="stk-num">' + stkEsc(l.PrecioUnit === '' ? '—' : Number(l.PrecioUnit).toLocaleString('es-AR')) +
                  '</td><td class="stk-num">' + stkEsc(l.Importe === '' ? '—' : Number(l.Importe).toLocaleString('es-AR')) + '</td>' : '') +
                '<td>' + stkEsc(l.Estado) + '</td><td class="mono stk-dim">' + stkEsc(l.ID) + '</td></tr>';
            }).join('') + '</tbody></table>' +
            stkCabecera3bHtml(op) +   // SEC-1a.3b-1
            '<div class="stk-dim" style="margin-top:6px">Operación ' + stkEsc(op.id) + ' · creada ' + stkEsc(op.creadoEn) +
            (op.observacion ? ' · Observación: ' + stkEsc(op.observacion) : '') + (op.activa ? '' : ' · anulada ' + stkEsc(op.modificadoEn)) + '</div></td></tr>';
        }
        return fila;
      }).join('') + '</tbody></table>' : '<div class="stk-vacio">Sin operaciones para estos filtros.</div>') +
    (filtradas.length > vis.length ? '<div class="stk-vacio">Se muestran ' + vis.length + ' de ' + filtradas.length + '. Usá los filtros.</div>' : '') +
    '</div></div>';
  c.innerHTML = h;
}

function stkToggleOp(id) {
  stkEstado.opsAbiertas[id] = !stkEstado.opsAbiertas[id];
  renderStkPage();
}

// ── Solapa CATÁLOGO (artículos + mapeos) ──────────────────────────────
function renderStkCatalogo(c) {
  var d = stkEstado.datos, a = stkEstado.analisis, R = a.resolutor;
  var arts = (d.articulos || []).slice();
  var cats = {};
  arts.forEach(function(x) { var k = String(x.Categoria || 'OTRO'); (cats[k] = cats[k] || []).push(x); });
  var orden = STK_ORDEN_CATEGORIAS.filter(function(k) { return cats[k]; }).concat(Object.keys(cats).filter(function(k) { return STK_ORDEN_CATEGORIAS.indexOf(k) < 0; }));
  var h = '<div class="stk-filtros"><button class="btn bp bsm" onclick="stkAbrirArticulo(null)">+ Nuevo artículo</button>' +
    '<span class="stk-dim">El ID no cambia nunca. Con uso, Unidad, Controla stock, Controla tope de Diabetes, Control por unidad y TextoEntregas quedan bloqueados.</span></div>';
  h += '<div class="card"><div class="ch">🗂 <span class="ct">Artículos</span><span class="stk-dim">' + arts.length + '</span></div><div class="cb tw"><table>' +
    '<thead><tr><th>ID</th><th>Nombre</th><th>Unidad</th><th>Atributos</th><th>TextoEntregas</th><th>Uso</th><th>Activo</th><th></th></tr></thead><tbody>' +
    orden.map(function(k) {
      return '<tr class="stk-grupo"><td colspan="8">' + stkEsc(k) + ' · ' + cats[k].length + '</td></tr>' + cats[k].map(function(x) {
        var id = stkCampo(x, 'ID'), uso = stkUsoCliente(id), ref = stkRef(id), act = stkVerdadero(x.Activo);
        return '<tr><td class="mono">' + stkEsc(id) + '</td><td>' + stkEsc(x.Nombre) + '</td><td>' + stkEsc(x.Unidad) + '</td><td>' +
          stkAtributosHtml(x) + '</td><td class="stk-dim">' +
          stkEsc(x.TextoEntregas || '—') + '</td><td class="stk-dim" style="font-size:11px">' +
          (uso.total ? [uso.movimientos ? uso.movimientos + ' mov.' : '', uso.entregas ? uso.entregas + ' entregas' : '', uso.mapeos ? uso.mapeos + ' mapeos' : ''].filter(Boolean).join(' · ') : 'sin uso') +
          '</td><td>' + (act ? '<span class="b bg">Sí</span>' : '<span class="b bgr">No</span>') + '</td><td><div class="stk-acciones">' +
          '<button class="btn bs bsm" onclick="stkAbrirArticulo(stkRefs[' + ref + '])">Editar</button>' +
          '<button class="btn ' + (act ? 'brd' : 'bgn') + ' bsm" onclick="stkAbrirActivoArticulo(stkRefs[' + ref + '],' + (act ? 'false' : 'true') + ')">' + (act ? 'Desactivar' : 'Activar') + '</button>' +
          '</div></td></tr>';
      }).join('');
    }).join('') + '</tbody></table></div></div>';

  var maps = d.mapeos || [];
  h += '<div class="card"><div class="ch">🔗 <span class="ct">Mapeos de textos históricos</span><span class="stk-dim">Solo para Entregas históricas sin ArticuloID · nunca para cargas nuevas</span></div>' +
    (R.avisosMapeo.length ? '<div class="stk-body">' + R.avisosMapeo.map(function(t) { return '<div class="stk-aviso warn">⚠ ' + stkEsc(t) + '</div>'; }).join('') + '</div>' : '') +
    '<div class="cb tw"><table><thead><tr><th>Texto original</th><th>Artículo</th><th>Activo</th><th>Observación</th><th></th></tr></thead><tbody>' +
    (maps.length ? maps.map(function(m) {
      var art = R.arts[stkCampo(m, 'ArticuloID')], act = stkVerdadero(m.Activo), ref = stkRef(stkCampo(m, 'ID'));
      return '<tr><td>' + stkEsc(m.TextoOriginal) + '</td><td>' + (art ? stkEsc(art.Nombre) + '<div class="mono stk-dim">' + stkEsc(art.ID) + '</div>'
          : '<span class="b br">⚠ inexistente: ' + stkEsc(m.ArticuloID) + '</span>') + '</td><td>' +
        (act ? '<span class="b bg">Sí</span>' : '<span class="b bgr">No</span>') + '</td><td class="stk-dim">' + stkEsc(m.Observacion || '') + '</td><td>' +
        '<button class="btn ' + (act ? 'brd' : 'bgn') + ' bsm" onclick="stkAbrirActivoMapeo(stkRefs[' + ref + '],' + (act ? 'false' : 'true') + ')">' + (act ? 'Desactivar' : 'Activar') + '</button></td></tr>';
    }).join('') : '<tr><td colspan="5" class="stk-dim" style="text-align:center">Sin mapeos.</td></tr>') + '</tbody></table></div></div>';

  var tsa = a.textosSinArticulo;
  h += '<div class="card"><div class="ch">❓ <span class="ct">Textos históricos sin artículo</span><span class="stk-dim">' + tsa.length + '</span></div><div class="cb tw">' +
    (tsa.length ? '<table><thead><tr><th>Texto en Entregas</th><th class="stk-num">Desde el corte</th><th class="stk-num">Total</th><th>Motivo</th><th></th></tr></thead><tbody>' +
      tsa.map(function(t, i) {
        return '<tr><td>' + stkEsc(t.texto) + '</td><td class="stk-num">' + t.desde + '</td><td class="stk-num">' + t.total + '</td><td class="stk-dim">' +
          stkEsc(t.motivo) + '</td><td><button class="btn bp bsm" onclick="stkAbrirMapeo(' + i + ')">Mapear</button></td></tr>';
      }).join('') + '</tbody></table>' : '<div class="stk-vacio">✓ Todas las entregas tienen un artículo identificado.</div>') + '</div></div>';
  c.innerHTML = h;
}

function stkAtributosHtml(x) {
  var b = [];
  if (stkVerdadero(x.ControlaStock)) b.push('<span class="b bgr" title="Controla stock">Stock</span>');
  if (stkVerdadero(x.GeneraEntrega)) b.push('<span class="b bb" title="Se entrega a afiliados desde Stock">Afiliados</span>');   // SEC-1a.3b-1
  if (stkVerdadero(x.ControlaTopeDiabetes)) b.push('<span class="b bo" title="Controla tope de Diabetes (hoja Entregas)">Tope DB</span>');
  if (stkVerdadero(x.PermiteComodato)) b.push('<span class="b bpu" title="Permite comodato">Comodato</span>');
  if (stkVerdadero(x.ControlaUnidades)) b.push('<span class="b bgr" title="Control por unidad individual">Por unidad</span>');
  var campos = stkCamposLista(), cs = String(x.CamposEntrega || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  return b.join(' ') + (cs.length ? '<div class="stk-dim" style="font-size:11px">Pide: ' + stkEsc(cs.map(function(k) { return campos[k] ? campos[k].etiqueta : k; }).join(', ')) + '</div>' : '');
}

// ══════════════════════════════════════════════════════════════════════
// MODAL GENÉRICO
// ══════════════════════════════════════════════════════════════════════
function stkModalAbrir(titulo, cuerpo, pie) {
  var mo = document.getElementById('stk-modal');
  if (!mo) {
    mo = document.createElement('div');
    mo.className = 'mo'; mo.id = 'stk-modal';
    mo.innerHTML = '<div class="md wide"><div class="mh"><span class="mt" id="stkm-titulo"></span>' +
      '<button class="btn bs bsm" onclick="stkModalCerrar()">✕</button></div><div class="mb" id="stkm-cuerpo"></div>' +
      '<div class="mf" id="stkm-pie"></div></div>';
    document.body.appendChild(mo);
  }
  document.getElementById('stkm-titulo').textContent = titulo;
  document.getElementById('stkm-cuerpo').innerHTML = cuerpo;
  document.getElementById('stkm-pie').innerHTML = pie + '';
  mo.classList.add('open');
}

function stkModalCerrar() {
  var mo = document.getElementById('stk-modal');
  if (mo) mo.classList.remove('open');
  stkForm = null;
}

function stkModalMsg(t, tipo) {
  var el = document.getElementById('stkm-msg');
  if (el) { el.style.color = tipo === 'ok' ? 'var(--gn)' : tipo === 'info' ? 'var(--tx2)' : 'var(--rd)'; el.textContent = t || ''; }
}

function stkModalOcupado(si) {
  var b = document.getElementById('stkm-guardar');
  if (b) { b.disabled = !!si; b.textContent = si ? 'Guardando…' : (b.getAttribute('data-txt') || 'Guardar'); }
}

function stkVal(id) { var el = document.getElementById(id); return el ? el.value : ''; }
function stkChk(id) { var el = document.getElementById(id); return !!(el && el.checked); }

function stkPieGuardar(txt) {
  return '<button class="btn bs" onclick="stkModalCerrar()">Cancelar</button>' +
    '<button class="btn bp" id="stkm-guardar" data-txt="' + stkEsc(txt || 'Guardar') + '" onclick="stkGuardarModal()">' + stkEsc(txt || 'Guardar') + '</button>';
}

function stkGuardarModal() {
  if (!stkForm) return;
  if (stkForm.enviando) return;          // evita doble envío (doble clic)
  var f = stkForm.clase === 'operacion' ? stkGuardarOperacion : stkForm.clase === 'articulo' ? stkGuardarArticulo
        : stkForm.clase === 'activoArt' ? stkGuardarActivoArticulo : stkForm.clase === 'mapeo' ? stkGuardarMapeoForm
        : stkForm.clase === 'activoMap' ? stkGuardarActivoMapeo : stkForm.clase === 'anular' ? stkGuardarAnular
        : stkForm.clase === 'op3b' ? stkGuardarOperacion3b : stkForm.clase === 'constancia' ? stkGuardarConstancia : null;   // SEC-1a.3b-1
  if (!f) return;
  var form = stkForm;
  form.enviando = true;
  return Promise.resolve(f()).finally(function() { form.enviando = false; });
}

async function stkEnviar(accion, payload) {
  stkModalOcupado(true); stkModalMsg('Guardando…', 'info');
  try {
    var r = await stkApi(accion, Object.assign({ reqId: stkForm.reqId }, payload));
    if (r.code === 'SESION_INVALIDA') { stkModalCerrar(); stkEstado.datos = null; stkEstado.aviso = r.msg; renderStkPage(); return null; }
    if (r.code === 'ACCION_DESCONOCIDA') { stkModalMsg('El servidor no tiene instalado SEC-1a.3a. Actualizá el Code.gs.'); return null; }
    return r;
  } catch (e) {
    stkModalMsg(e.message || String(e)); return null;
  } finally {
    stkModalOcupado(false);
  }
}

async function stkExito(msg) {
  stkModalCerrar();
  stkAviso(msg, 'ok');
  stkInvalidarConsultas();   // SEC-1a.3b-1: el historial y las compras se vuelven a consultar al verlos
  await cargarStkDatos();
}

function stkConfirmacionHtml(texto, conMotivo) {
  return '<div id="stkm-confirmar" class="stk-aviso bad">' + texto +
    '<div style="margin-top:8px"><label class="stk-check"><input type="checkbox" id="stkm-conf-chk"> Confirmo y quiero continuar</label></div>' +
    (conMotivo ? '<div style="margin-top:8px"><div class="stk-k">Motivo (obligatorio)</div><input class="stk-in" id="stkm-conf-motivo" maxlength="500"></div>' : '') +
    '</div>';
}

function stkDetalleSaldos(det) {
  var arts = stkArtMap();
  return '<ul style="margin:6px 0 0 18px">' + det.map(function(x) {
    var a = arts[x.articuloId];
    return '<li>' + stkEsc(stkNombreUbic(x.ubicacion)) + ' · ' + stkEsc(a ? a.Nombre : x.articuloId) + ': el saldo llega a <strong>' +
      (x.saldoMinimo).toLocaleString('es-AR') + '</strong> el ' + stkFmtFecha(x.fecha) + '</li>';
  }).join('') + '</ul>';
}

// ══════════════════════════════════════════════════════════════════════
// FORMULARIO DE OPERACIÓN (encabezado una vez + líneas de artículos)
// ══════════════════════════════════════════════════════════════════════
function stkOpcionesArticulos(sel, excluir) {
  var cats = {};
  stkArticulosOperables().forEach(function(a) { var k = String(a.Categoria || 'OTRO'); (cats[k] = cats[k] || []).push(a); });
  var orden = STK_ORDEN_CATEGORIAS.filter(function(k) { return cats[k]; }).concat(Object.keys(cats).filter(function(k) { return STK_ORDEN_CATEGORIAS.indexOf(k) < 0; }));
  return '<option value="">— Elegí un artículo —</option>' + orden.map(function(k) {
    return '<optgroup label="' + stkEsc(k) + '">' + cats[k].map(function(a) {
      var id = stkCampo(a, 'ID');
      return '<option value="' + stkEsc(id) + '"' + (id === sel ? ' selected' : '') + '>' + stkEsc(a.Nombre) + ' (' + stkEsc(a.Unidad) + ')</option>';
    }).join('') + '</optgroup>';
  }).join('');
}

function stkOpcionesUbic(sel, vacio) {
  return (vacio ? '<option value="">— Elegí —</option>' : '') + stkUbicacionesActivas().map(function(u) {
    var id = stkCampo(u, 'ID');
    return '<option value="' + stkEsc(id) + '"' + (id === sel ? ' selected' : '') + '>' + stkEsc(u.Nombre) + '</option>';
  }).join('');
}

function stkAbrirOperacion(tipo) {
  var modo = stkEstado.datos.config && stkEstado.datos.config.modoCargaInicial;
  if (tipo === 'STOCK_INICIAL' && !modo) { stkAviso('El stock inicial solo se carga con el modo carga inicial activo.', 'err'); return; }
  var hoy = stkEstado.hoy || '';
  stkForm = { clase: 'operacion', tipo: tipo, reqId: stkNuevoReqId(), lineas: [{ articuloId: '', cantidad: '', precioUnit: '', importe: '' }], confirmar: false };
  var corte = stkEstado.analisis.corte;
  var cab = '<div class="stk-grid">';
  if (tipo === 'STOCK_INICIAL') {
    cab += '<div><div class="stk-k">Ubicación</div><select class="stk-in" id="stkm-destino" onchange="stkRenderLineasSI()">' + stkOpcionesUbic('CENTRAL') + '</select></div>' +
      '<div><div class="stk-k">Fecha</div><div class="stk-in" style="opacity:.8">' + stkFmtFecha(corte) + ' (fija)</div></div>';
  } else {
    cab += '<div><div class="stk-k">Fecha</div><input type="date" class="stk-in" id="stkm-fecha" min="' + stkEsc(corte) + '"' + (hoy ? ' max="' + stkEsc(hoy) + '"' : '') +
      ' value="' + stkEsc(hoy) + '" onchange="stkRecalcularOperacion()"></div>';
    if (tipo === 'TRANSFERENCIA')
      cab += '<div><div class="stk-k">Origen</div><select class="stk-in" id="stkm-origen" onchange="stkRecalcularOperacion()">' + stkOpcionesUbic('CENTRAL') + '</select></div>';
    cab += '<div><div class="stk-k">Destino</div><select class="stk-in" id="stkm-destino" onchange="stkRecalcularOperacion()">' +
      stkOpcionesUbic(tipo === 'INGRESO' ? 'CENTRAL' : '', tipo === 'TRANSFERENCIA') + '</select></div>';
    if (tipo === 'INGRESO') {
      var provs = {};
      stkEstado.movs.forEach(function(m) { var p = stkCampo(m, 'Proveedor'); if (p) provs[p] = true; });
      cab += '<div><div class="stk-k">Proveedor</div><input class="stk-in" id="stkm-proveedor" list="stkm-provs" maxlength="120">' +
        '<datalist id="stkm-provs">' + Object.keys(provs).sort().map(function(p) { return '<option value="' + stkEsc(p) + '">'; }).join('') + '</datalist></div>' +
        '<div><div class="stk-k">Factura / remito (opcional)</div><input class="stk-in" id="stkm-comprobante" maxlength="120"></div>';
    }
  }
  cab += '<div style="grid-column:1/-1"><div class="stk-k">Observación</div><input class="stk-in" id="stkm-obs" maxlength="500"' +
    (tipo === 'STOCK_INICIAL' ? ' placeholder="Fuente: recuento físico, planilla de stock…"' : '') + '></div></div>';
  var cuerpo = cab + '<div class="stk-k" style="margin-top:4px">Artículos</div><div id="stkm-lineas"></div>' +
    (tipo === 'STOCK_INICIAL' ? '' : '<button class="btn bs bsm" style="margin-top:8px" onclick="stkAgregarLinea()">+ Agregar artículo</button>') +
    '<div id="stkm-adv" style="margin-top:12px"></div><div id="stkm-msg" class="stk-msg"></div>';
  stkModalAbrir('Nueva operación · ' + STK_NOMBRES_TIPO[tipo], cuerpo, stkPieGuardar('Guardar operación'));
  if (tipo === 'STOCK_INICIAL') stkRenderLineasSI(); else stkRenderLineas();
}

// Stock inicial: un campo de cantidad por artículo activo
function stkRenderLineasSI() {
  var U = stkVal('stkm-destino'), arts = stkArticulosOperables();
  var declarados = {};
  stkEstado.movs.forEach(function(m) {
    if (stkEsActivo(m) && stkCampo(m, 'Tipo') === 'STOCK_INICIAL' && stkCampo(m, 'Destino') === U)
      declarados[stkCampo(m, 'ArticuloID')] = (declarados[stkCampo(m, 'ArticuloID')] || 0) + (Number(m.Cantidad) || 0);
  });
  var cats = {};
  arts.forEach(function(a) { var k = String(a.Categoria || 'OTRO'); (cats[k] = cats[k] || []).push(a); });
  var orden = STK_ORDEN_CATEGORIAS.filter(function(k) { return cats[k]; }).concat(Object.keys(cats).filter(function(k) { return STK_ORDEN_CATEGORIAS.indexOf(k) < 0; }));
  // SEC-1a.3b-1 (D5): precio unitario opcional, para que lo entregado desde el stock inicial tenga valor de referencia
  document.getElementById('stkm-lineas').innerHTML = '<div class="tw"><table class="stk-lineas"><thead><tr><th>Artículo</th><th>Unidad</th><th style="width:150px">Cantidad</th><th style="width:150px">Precio unit. (opc.)</th></tr></thead><tbody>' +
    orden.map(function(k) {
      return '<tr class="stk-grupo"><td colspan="4" style="font-size:10.5px;font-weight:700;color:var(--ac)">' + stkEsc(k) + '</td></tr>' + cats[k].map(function(a) {
        var id = stkCampo(a, 'ID'), ya = declarados[id];
        return '<tr><td>' + stkEsc(a.Nombre) + '<div class="mono stk-dim">' + stkEsc(id) + '</div></td><td>' + stkEsc(a.Unidad) + '</td><td>' +
          (ya !== undefined ? '<span class="stk-dim">Ya declarado: ' + ya.toLocaleString('es-AR') + '</span>'
            : '<input class="stk-in stk-num stkm-si" data-art="' + stkEsc(id) + '" inputmode="numeric" placeholder="0">') + '</td><td>' +
          (ya !== undefined ? '' : '<input class="stk-in stk-num stkm-si-p" data-art="' + stkEsc(id) + '" inputmode="decimal" placeholder="—">') + '</td></tr>';
      }).join('');
    }).join('') + '</tbody></table></div><div class="stk-dim" style="margin-top:6px">Solo se guardan las cantidades mayores a 0. El precio es opcional: sirve como valor de referencia de lo entregado. Para corregir un stock inicial ya declarado, anulá esa operación y cargala de nuevo.</div>';
}

function stkRenderLineas() {
  var tipo = stkForm.tipo;
  document.getElementById('stkm-lineas').innerHTML = '<div class="tw"><table class="stk-lineas"><thead><tr><th>Artículo</th><th style="width:120px">Cantidad</th>' +
    (tipo === 'INGRESO' ? '<th style="width:130px">Precio unit. (opc.)</th><th style="width:130px">Importe (opc.)</th>' : '') +
    (tipo === 'TRANSFERENCIA' ? '<th style="width:170px">Disponible en origen</th>' : '') + '<th></th></tr></thead><tbody>' +
    stkForm.lineas.map(function(l, i) {
      return '<tr><td><select class="stk-in" onchange="stkLinea(' + i + ',\'articuloId\',this.value)">' + stkOpcionesArticulos(l.articuloId) + '</select></td>' +
        '<td><input class="stk-in stk-num" inputmode="numeric" value="' + stkEsc(l.cantidad) + '" oninput="stkLinea(' + i + ',\'cantidad\',this.value)"></td>' +
        (tipo === 'INGRESO' ? '<td><input class="stk-in stk-num" inputmode="decimal" value="' + stkEsc(l.precioUnit) + '" oninput="stkLinea(' + i + ',\'precioUnit\',this.value)"></td>' +
          '<td><input class="stk-in stk-num" id="stkm-imp-' + i + '" inputmode="decimal" value="' + stkEsc(l.importe) + '" oninput="stkLinea(' + i + ',\'importe\',this.value)"' +
          (String(l.precioUnit).trim() ? ' disabled' : '') + '></td>' : '') +
        (tipo === 'TRANSFERENCIA' ? '<td class="stk-dim" id="stkm-disp-' + i + '"></td>' : '') +
        '<td>' + (stkForm.lineas.length > 1 ? '<button class="btn bs bsm" title="Quitar" onclick="stkQuitarLinea(' + i + ')">✕</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
    (tipo === 'INGRESO' ? '<div id="stkm-total" class="stk-aviso" style="margin-top:8px"></div>' : '');   // SEC-1a.3b-1: total calculado de la compra
  stkRecalcularOperacion();
  stkTotalIngreso();
}

// SEC-1a.3b-1: total de la compra (solo informativo; el servidor calcula cada importe)
function stkTotalIngreso() {
  var el = document.getElementById('stkm-total');
  if (!el || !stkForm || stkForm.tipo !== 'INGRESO') return;
  var total = 0, sin = 0, con = 0;
  stkForm.lineas.forEach(function(l) {
    if (!l.articuloId) return;
    var p = stkNumeroAR(l.precioUnit), im = stkNumeroAR(l.importe), c = /^\d+$/.test(String(l.cantidad).trim()) ? Number(l.cantidad) : null;
    var v = (p !== null && !isNaN(p) && c !== null) ? Math.round(p * c * 100) / 100 : (p === null && im !== null && !isNaN(im)) ? im : null;
    if (v === null) sin++; else { total += v; con++; }
  });
  el.innerHTML = '🧾 <strong>Total de la compra: ' + stkEsc(stkMoneda(total)) + '</strong>' +
    (sin ? ' <span class="stk-dim">· ' + sin + ' artículo(s) sin precio no suman al total</span>' : '');
}

function stkAgregarLinea() {
  stkForm.lineas.push({ articuloId: '', cantidad: '', precioUnit: '', importe: '' });
  stkRenderLineas();
}

function stkQuitarLinea(i) {
  stkForm.lineas.splice(i, 1);
  stkRenderLineas();
}

function stkNumeroAR(v) {
  var s = String(v == null ? '' : v).trim().replace(/\s/g, '');
  if (!s) return null;
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}

function stkLinea(i, campo, valor) {
  var l = stkForm.lineas[i];
  l[campo] = valor;
  if (stkForm.tipo === 'INGRESO' && (campo === 'precioUnit' || campo === 'cantidad')) {
    var imp = document.getElementById('stkm-imp-' + i), p = stkNumeroAR(l.precioUnit), c = Number(l.cantidad);
    if (imp) {
      imp.disabled = p !== null;
      if (p !== null && !isNaN(p) && /^\d+$/.test(String(l.cantidad).trim())) { l.importe = String(Math.round(p * c * 100) / 100); imp.value = l.importe; }
      else if (p !== null) { l.importe = ''; imp.value = ''; }
    }
  }
  stkRecalcularOperacion();
  stkTotalIngreso();   // SEC-1a.3b-1
}

function stkRecalcularOperacion() {
  if (!stkForm || stkForm.clase !== 'operacion' || stkForm.tipo !== 'TRANSFERENCIA') return;
  var fecha = stkVal('stkm-fecha'), origen = stkVal('stkm-origen');
  var saldos = stkSaldos(fecha)[origen] || {}, arts = stkArtMap();
  stkForm.lineas.forEach(function(l, i) {
    var el = document.getElementById('stkm-disp-' + i);
    if (el) el.textContent = l.articuloId ? stkCant(saldos[l.articuloId] || 0, arts[l.articuloId]) + (fecha ? ' al ' + stkFmtFecha(fecha) : '') : '';
  });
  var adv = document.getElementById('stkm-adv');
  if (!adv) return;
  var cambios = stkForm.lineas.filter(function(l) { return l.articuloId && /^\d+$/.test(String(l.cantidad).trim()) && Number(l.cantidad) > 0; })
    .map(function(l) { return { ubicacion: origen, articuloId: l.articuloId, fecha: fecha, delta: -Number(l.cantidad) }; });
  var det = (origen && fecha) ? stkVerificarSaldosCli(stkEstado.movs, cambios) : [];
  var modo = stkEstado.datos.config && stkEstado.datos.config.modoCargaInicial;
  stkForm.faltantes = det;
  if (!det.length) { adv.innerHTML = ''; return; }
  adv.innerHTML = modo
    ? '<div class="stk-aviso warn">⚠ Saldo insuficiente en el origen. Con el <strong>modo carga inicial activo</strong> se registra igual y queda la advertencia en auditoría.' + stkDetalleSaldos(det) + '</div>'
    : stkConfirmacionHtml('⚠ Saldo insuficiente en el origen.' + stkDetalleSaldos(det), true);
}

async function stkGuardarOperacion() {
  var f = stkForm, tipo = f.tipo;
  var enc = { destino: stkVal('stkm-destino'), observacion: stkVal('stkm-obs') };
  var lineas = [];
  if (tipo === 'STOCK_INICIAL') {
    var malas = 0, malasP = 0;
    document.querySelectorAll('#stk-modal .stkm-si').forEach(function(inp) {
      var v = String(inp.value).trim();
      if (!v || v === '0') return;
      if (!/^\d+$/.test(v)) { malas++; return; }
      var linSI = { articuloId: inp.getAttribute('data-art'), cantidad: Number(v) };
      var pInp = document.querySelector('#stk-modal .stkm-si-p[data-art="' + linSI.articuloId + '"]');   // SEC-1a.3b-1
      var pSI = pInp ? stkNumeroAR(pInp.value) : null;
      if (pSI !== null && (isNaN(pSI) || pSI < 0)) { malasP++; return; }
      if (pSI !== null) linSI.precioUnit = pSI;
      lineas.push(linSI);
    });
    if (malas) { stkModalMsg('Las cantidades deben ser números enteros.'); return; }
    if (malasP) { stkModalMsg('Los precios deben ser números mayores o iguales a 0.'); return; }
  } else {
    enc.fecha = stkVal('stkm-fecha');
    if (tipo === 'TRANSFERENCIA') enc.origen = stkVal('stkm-origen');
    if (tipo === 'INGRESO') { enc.proveedor = stkVal('stkm-proveedor'); enc.comprobante = stkVal('stkm-comprobante'); }
    if (!enc.fecha) { stkModalMsg('Indicá la fecha.'); return; }
    if (tipo === 'TRANSFERENCIA' && enc.origen === enc.destino) { stkModalMsg('El origen y el destino deben ser distintos.'); return; }
    var vistos = {};
    for (var i = 0; i < f.lineas.length; i++) {
      var l = f.lineas[i];
      if (!l.articuloId && !String(l.cantidad).trim()) continue;
      if (!l.articuloId) { stkModalMsg('Línea ' + (i + 1) + ': elegí el artículo.'); return; }
      if (vistos[l.articuloId]) { stkModalMsg('Hay un artículo repetido. Sumá las cantidades en una sola línea.'); return; }
      vistos[l.articuloId] = true;
      if (!/^\d+$/.test(String(l.cantidad).trim()) || Number(l.cantidad) <= 0) { stkModalMsg('Línea ' + (i + 1) + ': la cantidad debe ser un entero mayor a 0.'); return; }
      var lin = { articuloId: l.articuloId, cantidad: Number(l.cantidad) };
      if (tipo === 'INGRESO') {
        var p = stkNumeroAR(l.precioUnit), im = stkNumeroAR(l.importe);
        if ((p !== null && (isNaN(p) || p < 0)) || (im !== null && (isNaN(im) || im < 0))) { stkModalMsg('Línea ' + (i + 1) + ': precio o importe inválido.'); return; }
        if (p !== null) lin.precioUnit = p; else if (im !== null) lin.importe = im;
      }
      lineas.push(lin);
    }
  }
  if (!enc.destino) { stkModalMsg('Indicá el destino.'); return; }
  if (!lineas.length) { stkModalMsg('Cargá al menos un artículo con cantidad mayor a 0.'); return; }
  var payload = { tipo: tipo, encabezado: enc, lineas: lineas };
  if (document.getElementById('stkm-confirmar')) {
    payload.confirmaStock = stkChk('stkm-conf-chk');
    payload.motivoStock = stkVal('stkm-conf-motivo');
    if (!payload.confirmaStock || !String(payload.motivoStock).trim()) { stkModalMsg('Para continuar con saldo insuficiente, confirmá e indicá el motivo.'); return; }
  }
  var r = await stkEnviar('stk_registrarOperacion', payload);
  if (!r) return;
  if (r.ok) {
    await stkExito((r.repetido ? 'Operación ya registrada' : 'Operación registrada') + ' · ' + r.lineas + ' artículo(s)' +
      (r.advertencias && r.advertencias.length ? ' · con advertencia de saldo' : ''));
    return;
  }
  if (r.code === 'STOCK_INSUFICIENTE') {
    document.getElementById('stkm-adv').innerHTML = stkConfirmacionHtml('⚠ ' + stkEsc(r.msg) + stkDetalleSaldos(r.detalle || []), true);
    stkModalMsg('Revisá la advertencia de saldo.');
    return;
  }
  stkModalMsg(r.msg || 'No se pudo guardar.');
}

// ══════════════════════════════════════════════════════════════════════
// ANULAR OPERACIÓN
// ══════════════════════════════════════════════════════════════════════
function stkAbrirAnular(opId) {
  var op = stkOperaciones().filter(function(o) { return o.id === opId; })[0];
  if (!op) return;
  stkForm = { clase: 'anular', reqId: stkNuevoReqId(), operacionId: opId };
  var cambios = [];
  op.lineas.filter(stkEsActivo).forEach(function(m) {
    var c = Number(m.Cantidad) || 0;
    if (stkCampo(m, 'Destino')) cambios.push({ ubicacion: stkCampo(m, 'Destino'), articuloId: stkCampo(m, 'ArticuloID'), fecha: String(m.Fecha), delta: -c });
    if (stkCampo(m, 'Origen')) cambios.push({ ubicacion: stkCampo(m, 'Origen'), articuloId: stkCampo(m, 'ArticuloID'), fecha: String(m.Fecha), delta: c });
  });
  var det = stkVerificarSaldosCli(stkEstado.movs, cambios);
  var modo = stkEstado.datos.config && stkEstado.datos.config.modoCargaInicial;
  var cuerpo = '<div class="stk-aviso">' + stkEsc(STK_NOMBRES_TIPO[op.tipo] || op.tipo) + ' del ' + stkFmtFecha(op.fecha) + ' · ' +
    stkEsc(stkRecorridoOp(op)) +   // SEC-1a.3b-1
    '<br>' + stkEsc(stkResumenLineas(op, 50)) + '</div>' +
    '<div class="stk-aviso warn">La operación completa queda <strong>anulada</strong>: no se borra, deja de contar en los saldos y queda registrada en auditoría. Si fue un error de carga, después cargala de nuevo.</div>' +
    (det.length ? (modo ? '<div class="stk-aviso warn">⚠ Al anular, algún saldo queda negativo (modo carga inicial: solo advertencia).' + stkDetalleSaldos(det) + '</div>'
                        : stkConfirmacionHtml('⚠ Al anular, algún saldo queda negativo.' + stkDetalleSaldos(det), false)) : '') +
    '<div class="stk-k">Motivo de la anulación (obligatorio)</div><input class="stk-in" id="stkm-motivo" maxlength="500"><div id="stkm-msg" class="stk-msg"></div>';
  stkModalAbrir('Anular operación', cuerpo, stkPieGuardar('Anular operación'));
}

async function stkGuardarAnular() {
  var motivo = String(stkVal('stkm-motivo')).trim();
  if (!motivo) { stkModalMsg('Indicá el motivo.'); return; }
  var payload = { operacionId: stkForm.operacionId, motivo: motivo };
  if (document.getElementById('stkm-confirmar')) {
    if (!stkChk('stkm-conf-chk')) { stkModalMsg('Confirmá para continuar.'); return; }
    payload.confirmaStock = true;
  }
  var r = await stkEnviar('stk_anularOperacion', payload);
  if (!r) return;
  if (r.ok) { await stkExito('Operación anulada'); return; }
  if (r.code === 'STOCK_INSUFICIENTE') {
    var cuerpo = document.getElementById('stkm-cuerpo');
    if (cuerpo && !document.getElementById('stkm-confirmar'))
      cuerpo.insertAdjacentHTML('afterbegin', stkConfirmacionHtml('⚠ ' + stkEsc(r.msg) + stkDetalleSaldos(r.detalle || []), false));
    stkModalMsg('Revisá la advertencia de saldo.');
    return;
  }
  stkModalMsg(r.msg || 'No se pudo anular.');
}

// ══════════════════════════════════════════════════════════════════════
// ARTÍCULO: ALTA / EDICIÓN (ajuste 1a.3a: atributos separados)
// ══════════════════════════════════════════════════════════════════════
var STK_ATRIB_UI = [
  { k: 'ControlaStock',        id: 'stkm-a-stock',    txt: 'Controla stock',                 ayuda: 'Se controla por cantidad (saldo y movimientos)' },
  // SEC-1a.3b-1 (D4): "Genera entrega" pasa a significar "se entrega a afiliados desde Stock"
  { k: 'GeneraEntrega',        id: 'stkm-a-entrega',  txt: 'Se entrega a afiliados',         ayuda: 'Puede entregarse a afiliados desde Stock. A consultorios e instituciones se entrega cualquier artículo con stock (salvo Diabetes)' },
  { k: 'ControlaTopeDiabetes', id: 'stkm-a-tope',     txt: 'Controla tope de Diabetes',      ayuda: 'Su entrega a afiliados va a la hoja Entregas y cuenta para los topes (SEC-1a.4)' },
  { k: 'PermiteComodato',      id: 'stkm-a-comodato', txt: 'Permite comodato',               ayuda: 'Puede prestarse y volver (SEC-1a.3b-2)' },
  { k: 'ControlaUnidades',     id: 'stkm-a-unidades', txt: 'Admite identificación individual', ayuda: 'Códigos opcionales: se habilita en SEC-1a.3b-3' }
];
var STK_BLOQUEADOS_CON_USO = ['ControlaStock', 'ControlaTopeDiabetes', 'ControlaUnidades'];

function stkCamposLista() {
  return (stkEstado.listas && stkEstado.listas.campos) || {};
}

function stkAbrirArticulo(id) {
  var d = stkEstado.datos, a = id ? stkArtMap()[id] : null;
  var uso = a ? stkUsoCliente(id) : { total: 0 };
  var bloq = !!(a && uso.total > 0);
  var orig = {};
  STK_ATRIB_UI.forEach(function(x) { orig[x.k] = a ? stkVerdadero(a[x.k]) : (x.k === 'ControlaStock'); });
  orig.Unidad = a ? stkCampo(a, 'Unidad') : 'unidad';
  orig.TextoEntregas = a ? stkCampo(a, 'TextoEntregas') : '';
  var camposAct = String(a ? stkCampo(a, 'CamposEntrega') : '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  stkForm = { clase: 'articulo', reqId: stkNuevoReqId(), modo: a ? 'edicion' : 'alta', id: id, bloqueado: bloq, original: orig, prefijoPrevio: '' };
  var cat = a ? stkCampo(a, 'Categoria') : 'MATERIAL';
  var campos = stkCamposLista();
  var cuerpo = '<div class="stk-grid">' +
    '<div><div class="stk-k">ID ' + (a ? '(permanente)' : '(no se puede cambiar después)') + '</div>' +
      (a ? '<div class="stk-in mono" style="opacity:.8">' + stkEsc(id) + '</div>'
         : '<input class="stk-in mono" id="stkm-id" maxlength="30" placeholder="ej: MAT-MALLA-15" oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9-]/g,\'\')">') + '</div>' +
    '<div style="grid-column:span 2"><div class="stk-k">Nombre visible</div><input class="stk-in" id="stkm-nombre" maxlength="120" value="' + stkEsc(a ? a.Nombre : '') + '"></div>' +
    '<div><div class="stk-k">Categoría</div><select class="stk-in" id="stkm-categoria" onchange="stkArtCambioCategoria()">' +
      (d.categorias || STK_ORDEN_CATEGORIAS).map(function(k) { return stkOpt(k, k, cat); }).join('') + '</select></div>' +
    '<div><div class="stk-k">Unidad</div><select class="stk-in" id="stkm-unidad"' + (bloq ? ' disabled' : '') + '>' +
      (d.unidades || []).map(function(u) { return stkOpt(u, u, orig.Unidad); }).join('') + '</select></div>' +
    '</div>' +
    '<div class="stk-k">Atributos</div><div class="stk-grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">' +
    STK_ATRIB_UI.map(function(x) {
      return '<div><label class="stk-check" title="' + stkEsc(x.ayuda) + '"><input type="checkbox" id="' + x.id + '"' + (orig[x.k] ? ' checked' : '') +
        ' onchange="stkArtPrevia()"> ' + stkEsc(x.txt) + '</label><div class="stk-dim" style="margin-left:22px">' + stkEsc(x.ayuda) + '</div></div>';
    }).join('') + '</div>' +
    '<div class="stk-grid">' +
    '<div style="grid-column:1/-1"><div class="stk-k">Datos que se piden al entregar o prestar (opcionales del artículo)</div><div class="stk-acciones" id="stkm-campos">' +
      Object.keys(campos).map(function(k) {
        return '<label class="stk-check"><input type="checkbox" class="stkm-campo" value="' + stkEsc(k) + '"' + (camposAct.indexOf(k) >= 0 ? ' checked' : '') + '> ' + stkEsc(campos[k].etiqueta) + '</label>';
      }).join('') + '</div></div>' +
    '<div style="grid-column:1/-1"><div class="stk-k">TextoEntregas (solo si controla tope de Diabetes: texto que se escribe en Entregas.Insumo)</div>' +
      '<input class="stk-in" id="stkm-texto" maxlength="120" value="' + stkEsc(orig.TextoEntregas) + '" oninput="stkArtPrevia()"></div>' +
    '<div style="grid-column:1/-1"><div class="stk-k">Observación</div><input class="stk-in" id="stkm-observacion" maxlength="500" value="' + stkEsc(a ? stkCampo(a, 'Observacion') : '') + '"></div>' +
    (a ? '<div style="grid-column:1/-1"><div class="stk-k">Motivo de la modificación (obligatorio)</div><input class="stk-in" id="stkm-motivo" maxlength="500"></div>' : '') +
    '</div>' +
    (bloq ? '<div class="stk-aviso">🔒 Este artículo tiene uso (' + [uso.movimientos ? uso.movimientos + ' movimiento(s)' : '', uso.entregas ? uso.entregas + ' entrega(s)' : '',
      uso.mapeos ? uso.mapeos + ' mapeo(s)' : ''].filter(Boolean).join(', ') + '): Unidad, Controla stock, Controla tope de Diabetes, Control por unidad y TextoEntregas no se pueden modificar. Si hace falta, desactivalo y creá otro.</div>' : '') +
    '<div id="stkm-previa"></div><div id="stkm-msg" class="stk-msg"></div>';
  stkModalAbrir(a ? 'Editar artículo · ' + id : 'Nuevo artículo', cuerpo, stkPieGuardar(a ? 'Guardar cambios' : 'Crear artículo'));
  if (!a) stkArtCambioCategoria();
  stkArtPrevia();
}

function stkArtCambioCategoria() {
  var inp = document.getElementById('stkm-id');
  var pref = STK_PREFIJOS[stkVal('stkm-categoria')] || '';
  if (inp && (!inp.value || inp.value === stkForm.prefijoPrevio)) inp.value = pref;
  stkForm.prefijoPrevio = pref;
  stkArtPrevia();
}

// Aplica reglas de coherencia en pantalla y muestra la vista previa (el servidor valida igual)
function stkArtPrevia() {
  var el = document.getElementById('stkm-previa');
  if (!el || !stkForm) return;
  var bloq = stkForm.bloqueado;
  function cb(id) { return document.getElementById(id); }
  var cStock = cb('stkm-a-stock'), cEnt = cb('stkm-a-entrega'), cTope = cb('stkm-a-tope'), cCom = cb('stkm-a-comodato'), cUni = cb('stkm-a-unidades');
  // Control por unidad: se habilita en SEC-1a.3b
  cUni.checked = false;
  cUni.disabled = true;
  if (cTope.checked) { cEnt.checked = true; cStock.checked = true; }
  if (cCom.checked) cStock.checked = true;
  cEnt.disabled = cTope.checked;
  cStock.disabled = bloq || cTope.checked || cCom.checked;
  cTope.disabled = bloq;
  if (bloq) {
    cStock.checked = stkForm.original.ControlaStock;
    cTope.checked = stkForm.original.ControlaTopeDiabetes;
    if (cTope.checked) { cEnt.checked = true; cEnt.disabled = true; }
  }
  var inp = cb('stkm-texto');
  inp.disabled = bloq || !cTope.checked;
  if (!cTope.checked && !bloq) inp.value = '';
  var permiteCampos = cEnt.checked || cCom.checked;
  document.querySelectorAll('#stk-modal .stkm-campo').forEach(function(c) { c.disabled = !permiteCampos; if (!permiteCampos) c.checked = false; });

  var partes = [];
  if (!cStock.checked) partes.push('<div class="stk-aviso warn">No controla stock: no admite stock inicial, ingresos ni transferencias.</div>');
  if (cTope.checked) {
    var texto = inp.value;
    if (!String(texto).trim()) partes.push('<div class="stk-aviso warn">Indicá el TextoEntregas.</div>');
    else {
      var c = stkCompatTopes(texto);
      partes.push(c.tipo
        ? '<div class="stk-aviso ok">✓ Sus entregas van a la hoja Entregas y en los topes contarán como <strong>' + stkEsc(c.tipo) + '</strong> · ' + (c.unidadesPorEnvase || 1) + ' unidad(es) por cada caja entregada.</div>'
        : '<div class="stk-aviso bad">✗ El TextoEntregas debe ser reconocible por los topes actuales (debe contener "tira", "lanceta", "aguja" o "gluc").</div>');
    }
  } else if (stkVal('stkm-categoria') === 'DIABETES') {   // SEC-1a.3b-1 (D4)
    partes.push('<div class="stk-aviso warn">Categoría DIABETES: <strong>no se entrega desde Stock</strong> (circuito de Diabetes, SEC-1a.4). Sí se transfiere a seccionales, se da de baja o se ajusta.</div>');
  } else if (cEnt.checked) {
    partes.push('<div class="stk-aviso">Se entrega a afiliados desde Stock (con DNI y constancia), pero <strong>no escribe en la hoja Entregas ni afecta los topes de Diabetes</strong>. También puede entregarse a consultorios e instituciones.</div>');
  } else {
    partes.push('<div class="stk-aviso">No se entrega a afiliados: puede entregarse a consultorios, profesionales o destinatarios institucionales, transferirse o darse de baja.</div>');
  }
  if (cCom.checked) partes.push('<div class="stk-aviso">Permite comodato: se presta y vuelve (SEC-1a.3b-2).</div>');
  el.innerHTML = partes.join('');
}

async function stkGuardarArticulo() {
  var f = stkForm;
  function chk(id) { return stkChk(id); }
  var art = {
    ID: f.modo === 'alta' ? stkVal('stkm-id') : f.id,
    Nombre: stkVal('stkm-nombre'), Categoria: stkVal('stkm-categoria'),
    Unidad: f.bloqueado ? f.original.Unidad : stkVal('stkm-unidad'),
    ControlaStock: chk('stkm-a-stock'), GeneraEntrega: chk('stkm-a-entrega'), ControlaTopeDiabetes: chk('stkm-a-tope'),
    PermiteComodato: chk('stkm-a-comodato'), ControlaUnidades: chk('stkm-a-unidades'),
    CamposEntrega: [].slice.call(document.querySelectorAll('#stk-modal .stkm-campo')).filter(function(c) { return c.checked; }).map(function(c) { return c.value; }),
    TextoEntregas: f.bloqueado ? f.original.TextoEntregas : stkVal('stkm-texto'),
    Observacion: stkVal('stkm-observacion')
  };
  if (f.modo === 'alta' && !/^[A-Z0-9][A-Z0-9-]{2,29}$/.test(art.ID)) { stkModalMsg('El ID debe tener entre 3 y 30 caracteres: mayúsculas, números y guiones.'); return; }
  if (!String(art.Nombre).trim()) { stkModalMsg('El nombre es obligatorio.'); return; }
  var payload = { modo: f.modo, articulo: art };
  if (f.modo === 'edicion') {
    payload.motivo = stkVal('stkm-motivo');
    if (!String(payload.motivo).trim()) { stkModalMsg('Indicá el motivo de la modificación.'); return; }
  }
  var r = await stkEnviar('stk_guardarArticulo', payload);
  if (!r) return;
  if (r.ok) { await stkExito(f.modo === 'alta' ? 'Artículo creado: ' + r.id : 'Artículo actualizado'); return; }
  stkModalMsg(r.msg || 'No se pudo guardar.');
}

// ── Activar / desactivar artículo ──────────────────────────────────────
function stkAbrirActivoArticulo(id, activar) {
  var a = stkArtMap()[id];
  if (!a) return;
  stkForm = { clase: 'activoArt', reqId: stkNuevoReqId(), id: id, activar: activar };
  var saldos = [];
  if (!activar) {
    var s = stkSaldos('');
    Object.keys(s).forEach(function(u) { if (s[u][id]) saldos.push({ ubicacion: u, saldo: s[u][id] }); });
  }
  var cuerpo = '<div class="stk-aviso">' + stkEsc(a.Nombre) + ' <span class="mono stk-dim">' + stkEsc(id) + '</span></div>' +
    (activar ? '<div class="stk-aviso">Vuelve a estar disponible en los selectores de operaciones nuevas.</div>'
             : '<div class="stk-aviso warn">No se borra: desaparece de los selectores de operaciones nuevas y sigue visible en el historial y en los saldos.</div>') +
    (saldos.length ? stkConfirmacionHtml('⚠ Todavía tiene saldo:<ul style="margin:6px 0 0 18px">' + saldos.map(function(x) {
      return '<li>' + stkEsc(stkNombreUbic(x.ubicacion)) + ': ' + stkEsc(stkCant(x.saldo, a)) + '</li>'; }).join('') + '</ul>', false) : '') +
    '<div class="stk-k">Motivo (obligatorio)</div><input class="stk-in" id="stkm-motivo" maxlength="500"><div id="stkm-msg" class="stk-msg"></div>';
  stkModalAbrir((activar ? 'Activar' : 'Desactivar') + ' artículo', cuerpo, stkPieGuardar(activar ? 'Activar' : 'Desactivar'));
}

async function stkGuardarActivoArticulo() {
  var motivo = String(stkVal('stkm-motivo')).trim();
  if (!motivo) { stkModalMsg('Indicá el motivo.'); return; }
  var payload = { id: stkForm.id, activo: stkForm.activar, motivo: motivo };
  if (document.getElementById('stkm-confirmar')) {
    if (!stkChk('stkm-conf-chk')) { stkModalMsg('Confirmá para continuar.'); return; }
    payload.confirmaSaldo = true;
  }
  var r = await stkEnviar('stk_setArticuloActivo', payload);
  if (!r) return;
  if (r.ok) { await stkExito(stkForm.activar ? 'Artículo activado' : 'Artículo desactivado'); return; }
  if (r.code === 'CONFIRMAR') {
    var cuerpo = document.getElementById('stkm-cuerpo');
    if (cuerpo && !document.getElementById('stkm-confirmar')) cuerpo.insertAdjacentHTML('afterbegin', stkConfirmacionHtml('⚠ ' + stkEsc(r.msg), false));
    stkModalMsg('Confirmá para continuar.');
    return;
  }
  stkModalMsg(r.msg || 'No se pudo guardar.');
}

// ══════════════════════════════════════════════════════════════════════
// MAPEOS
// ══════════════════════════════════════════════════════════════════════
function stkAbrirMapeo(i) {
  var t = stkEstado.analisis.textosSinArticulo[i];
  if (!t) return;
  stkForm = { clase: 'mapeo', reqId: stkNuevoReqId(), texto: t.texto };
  var arts = ((stkEstado.datos && stkEstado.datos.articulos) || []).filter(function(a) { return stkVerdadero(a.ControlaTopeDiabetes); })
    .sort(function(x, y) { return (stkVerdadero(y.Activo) - stkVerdadero(x.Activo)) || (String(x.Nombre) < String(y.Nombre) ? -1 : 1); });
  var cuerpo = '<div class="stk-k">Texto histórico en Entregas</div><div class="stk-aviso">' + stkEsc(t.texto) +
    ' <span class="stk-dim">· ' + t.desde + ' fila(s) desde el corte · ' + t.total + ' en total</span></div>' +
    '<div class="stk-grid"><div style="grid-column:1/-1"><div class="stk-k">Corresponde al artículo</div><select class="stk-in" id="stkm-art">' +
      '<option value="">— Elegí un artículo —</option>' + arts.map(function(a) {
        return '<option value="' + stkEsc(stkCampo(a, 'ID')) + '">' + stkEsc(a.Nombre) + ' · ' + stkEsc(a.ID) + (stkVerdadero(a.Activo) ? '' : ' (inactivo)') + '</option>';
      }).join('') + '</select></div>' +
    '<div style="grid-column:1/-1"><div class="stk-k">Observación</div><input class="stk-in" id="stkm-obs" maxlength="500"></div></div>' +
    '<div class="stk-aviso">El mapeo solo sirve para identificar entregas históricas que no tienen ArticuloID. Nunca se usa para cargas nuevas.</div>' +
    '<div id="stkm-msg" class="stk-msg"></div>';
  stkModalAbrir('Mapear texto histórico', cuerpo, stkPieGuardar('Crear mapeo'));
}

async function stkGuardarMapeoForm() {
  var art = stkVal('stkm-art');
  if (!art) { stkModalMsg('Elegí el artículo.'); return; }
  var r = await stkEnviar('stk_guardarMapeo', { texto: stkForm.texto, articuloId: art, observacion: stkVal('stkm-obs') });
  if (!r) return;
  if (r.ok) { await stkExito('Mapeo creado'); return; }
  stkModalMsg(r.msg || 'No se pudo guardar.');
}

function stkAbrirActivoMapeo(id, activar) {
  var m = ((stkEstado.datos && stkEstado.datos.mapeos) || []).filter(function(x) { return stkCampo(x, 'ID') === id; })[0];
  if (!m) return;
  stkForm = { clase: 'activoMap', reqId: stkNuevoReqId(), id: id, activar: activar };
  var cuerpo = '<div class="stk-aviso">' + stkEsc(m.TextoOriginal) + ' → <span class="mono">' + stkEsc(m.ArticuloID) + '</span></div>' +
    '<div class="stk-aviso">' + (activar ? 'Las entregas con este texto volverán a identificarse por este mapeo.' : 'Las entregas con este texto volverán a quedar ❓ hasta que exista otro mapeo.') + '</div>' +
    '<div class="stk-k">Motivo (obligatorio)</div><input class="stk-in" id="stkm-motivo" maxlength="500"><div id="stkm-msg" class="stk-msg"></div>';
  stkModalAbrir((activar ? 'Activar' : 'Desactivar') + ' mapeo', cuerpo, stkPieGuardar(activar ? 'Activar' : 'Desactivar'));
}

async function stkGuardarActivoMapeo() {
  var motivo = String(stkVal('stkm-motivo')).trim();
  if (!motivo) { stkModalMsg('Indicá el motivo.'); return; }
  var r = await stkEnviar('stk_setMapeoActivo', { id: stkForm.id, activo: stkForm.activar, motivo: motivo });
  if (!r) return;
  if (r.ok) { await stkExito(stkForm.activar ? 'Mapeo activado' : 'Mapeo desactivado'); return; }
  stkModalMsg(r.msg || 'No se pudo guardar.');
}

// ══════════════════════════════════════════════════════════════════════
// SEC-1a.3b-1 · ENTREGAS · BAJAS · AJUSTES · CONSTANCIAS · HISTORIAL · COMPRAS · INFORMES
// ----------------------------------------------------------------------
// · Historial y compras se filtran EN EL SERVIDOR y llegan paginados: nunca se
//   trae todo el historial. Nada se consulta hasta abrir la solapa.
// · Informes PDF: vista A4 que se imprime o se guarda como PDF desde el
//   navegador. CSV liviano para Excel (UTF-8 con BOM, ";" y coma decimal).
// · Imprimir NUNCA guarda ni recalcula nada.
// · Fichas de afiliados: solo se AGREGAN fichas incompletas (DNI que no existe).
// ══════════════════════════════════════════════════════════════════════
var STK_TAM_PAGINA = 50;
var STK_INFORME_AVISO_OPS = 2000;

stkEstado.afiliadosEntregas = [];
stkEstado.hist = null;
stkEstado.comp = null;

(function stkInyectarEstilos3b1() {
  if (typeof document === 'undefined' || document.getElementById('stk-estilos-1a3b1')) return;
  var st = document.createElement('style');
  st.id = 'stk-estilos-1a3b1';
  st.textContent = [
    '#page-stock .stk-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-bottom:12px}',
    '#page-stock .stk-kpi{background:var(--surface,var(--sf));color:var(--text,var(--tx));border:1px solid var(--border,var(--bd));border-radius:10px;padding:10px 12px}',
    '#page-stock tr.stk-det3b td{background:var(--bg,var(--sf2));color:var(--text,var(--tx));font-size:12px}',
    '#page-stock .stk-kpi .k{font-size:10.5px;font-weight:600;color:var(--tx3);text-transform:uppercase;letter-spacing:.4px}',
    '#page-stock .stk-kpi .v{font-size:20px;font-weight:700;margin-top:2px;font-family:"DM Mono",monospace}',
    '#page-stock .stk-kpi .s{font-size:11.5px;color:var(--tx3);margin-top:2px}',
    '#page-stock .stk-pag{display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:8px 12px}',
    '#page-stock .stk-fil-k{font-size:10px;font-weight:600;color:var(--tx3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px}',
    '#page-stock .stk-fil-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;align-items:end;margin-bottom:10px}',
    '#page-stock .stk-fil-grid .stk-sel-in{width:100%;box-sizing:border-box}',
    '#stk-modal .stk-ant{background:var(--sf2);border:1px dashed var(--bd2);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--tx2);margin-bottom:12px}',
    '#stk-modal .stk-extra td{border-top:none;padding-top:0}',
    '.stk-enlace{background:none;border:none;color:var(--ac);cursor:pointer;font:inherit;font-weight:600;padding:0;text-align:left}'
  ].join('\n');
  document.head.appendChild(st);
})();

// ── Utilidades ─────────────────────────────────────────────────────────
function stkMoneda(n) {
  return '$ ' + (Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function stkDniNorm(v) { return String(v == null ? '' : v).replace(/[\s.\-]/g, ''); }

function stkL(lista, k) {
  var L = (stkEstado.listas && stkEstado.listas[lista]) || {};
  return L[k] || k || '';
}

function stkEsDiabetesCli(a) {
  return stkVerdadero(a.ControlaTopeDiabetes) || String(a.Categoria || '').toUpperCase() === 'DIABETES';
}

function stkExtraHtml(datosExtra) {
  var o = datosExtra;
  if (typeof o === 'string') { try { o = o ? JSON.parse(o) : null; } catch (e) { o = null; } }
  if (!o) return '';
  var campos = stkCamposLista();
  var t = Object.keys(o).map(function(k) {
    var v = o[k]; if (v === 'SI') v = 'Sí'; else if (v === 'NO') v = 'No';
    return (campos[k] ? campos[k].etiqueta : k) + ': ' + v;
  }).join(' · ');
  return t ? '<div class="stk-dim" style="font-size:11px">' + stkEsc(t) + '</div>' : '';
}

function stkExtraTexto(datosExtra) {
  var o = datosExtra;
  if (typeof o === 'string') { try { o = o ? JSON.parse(o) : null; } catch (e) { o = null; } }
  if (!o) return '';
  var campos = stkCamposLista();
  return Object.keys(o).map(function(k) {
    var v = o[k]; if (v === 'SI') v = 'Sí'; else if (v === 'NO') v = 'No';
    return (campos[k] ? campos[k].etiqueta : k) + ': ' + v;
  }).join(' · ');
}

function stkEsAfiTipo(td) { return td === 'AFILIADO' || td === 'AFILIADO_SECCIONAL'; }

// Texto de recorrido de una operación (los tipos de 1a.3a conservan su texto)
function stkRecorridoOp(op) {
  if (op.tipo === 'TRANSFERENCIA') return stkNombreUbic(op.origen) + ' → ' + stkNombreUbic(op.destino);
  if (op.tipo === 'ENTREGA') return stkNombreUbic(op.origen) + ' → ' + (op.destinatario || '—') + (op.seccional ? ' (' + stkNombreUbic(op.seccional) + ')' : '');
  if (op.tipo === 'BAJA') return stkNombreUbic(op.origen) + ' → baja: ' + stkL('causasBaja', op.causa);
  if (op.tipo === 'AJUSTE') return 'Ajuste en ' + stkNombreUbic(op.origen || op.destino);
  return '→ ' + stkNombreUbic(op.destino);
}

function stkDetalleOp3b(op) {
  if (op.tipo === 'ENTREGA') return 'a ' + (op.destinatario || '—') + (op.seccional ? ' (' + stkNombreUbic(op.seccional) + ')' : '');
  if (op.tipo === 'BAJA') return 'Baja: ' + stkL('causasBaja', op.causa) + (op.motivo ? ' · ' + op.motivo : '');
  if (op.tipo === 'AJUSTE') return 'Ajuste: ' + (op.motivo || '');
  return '';
}

function stkDetalleMov3b(m) {
  var t = stkCampo(m, 'Tipo');
  if (t === 'ENTREGA') return 'a ' + stkCampo(m, 'Destinatario') + (stkCampo(m, 'SeccionalDestino') ? ' (' + stkNombreUbic(stkCampo(m, 'SeccionalDestino')) + ')' : '');
  if (t === 'BAJA') return 'Baja: ' + stkL('causasBaja', stkCampo(m, 'Causa')) + (stkCampo(m, 'Motivo') ? ' · ' + stkCampo(m, 'Motivo') : '');
  if (t === 'AJUSTE') return 'Ajuste: ' + stkCampo(m, 'Motivo');
  return '';
}

// Cabecera de entrega / baja / ajuste dentro del detalle de Movimientos
function stkCabecera3bHtml(op) {
  if (op.tipo === 'ENTREGA') {
    return '<div class="stk-dim" style="margin-top:6px">Destinatario: ' + stkDestinatarioHtml(op.destinatario, op.dni, op.seccional, op.tipoDestinatario) +
      ' · ' + stkEsc(stkL('tiposDestinatario', op.tipoDestinatario)) + (op.seccional ? ' · Seccional: ' + stkEsc(stkNombreUbic(op.seccional)) : '') +
      ' · Retira: ' + stkEsc(stkL('retira', op.retira) + (op.retiraDetalle ? ' (' + op.retiraDetalle + ')' : '')) + '</div>';
  }
  if (op.tipo === 'BAJA') return '<div class="stk-dim" style="margin-top:6px">Causa: ' + stkEsc(stkL('causasBaja', op.causa)) + (op.motivo ? ' · Motivo: ' + stkEsc(op.motivo) : '') + '</div>';
  if (op.tipo === 'AJUSTE') return '<div class="stk-dim" style="margin-top:6px">Motivo del ajuste: ' + stkEsc(op.motivo) + '</div>';
  return '';
}

// Nombre del destinatario; si es afiliado, enlace a su ficha en Afiliados
function stkDestinatarioHtml(nombre, dni, seccional, td) {
  if (!stkEsAfiTipo(td) || !dni) return '<span>' + stkEsc(nombre || '—') + '</span>';
  var ref = stkRef({ dni: dni, nombre: nombre, seccional: seccional });
  return '<button class="stk-enlace" title="Abrir la ficha en Afiliados" onclick="stkIrAfiliado(stkRefs[' + ref + '])">' + stkEsc(nombre || dni) + '</button>' +
    ' <span class="mono stk-dim">DNI ' + stkEsc(dni) + '</span>';
}

function stkInvalidarConsultas() {
  if (stkEstado.hist) stkEstado.hist.res = null;
  if (stkEstado.comp) stkEstado.comp.res = null;
}

// ══════════════════════════════════════════════════════════════════════
// AFILIADOS: búsqueda, fichas incompletas y navegación (D8)
// ══════════════════════════════════════════════════════════════════════
function stkPacientes() {
  try { if (typeof DB !== 'undefined' && DB && Array.isArray(DB.pacientes)) return DB.pacientes; } catch (e) {}
  return null;
}

function stkBuscarAfiliado(dni) {
  var P = stkPacientes(), d = stkDniNorm(dni);
  if (!P || !d) return null;
  for (var i = 0; i < P.length; i++) if (stkDniNorm(P[i].dni) === d) return P[i];
  return null;
}

// Agrega fichas incompletas para los DNI que no existen. Nunca modifica fichas existentes.
function stkAsegurarFichas(lista) {
  var P = stkPacientes();
  if (!P) return 0;
  var vistos = {};
  P.forEach(function(p) { vistos[stkDniNorm(p.dni)] = true; });
  var nuevos = 0;
  (lista || []).forEach(function(x) {
    var d = stkDniNorm(x.dni);
    if (!/^\d{6,9}$/.test(d) || vistos[d] || !String(x.nombre || '').trim()) return;
    vistos[d] = true;
    P.push({ nombre: String(x.nombre).trim(), dni: d, programa: '', patologia: '',
             seccional: x.seccional ? stkNombreUbic(x.seccional) : '', localidad: '', telefono: '',
             _incompleto: true, _incompleto_origen: 'STOCK' });
    nuevos++;
  });
  if (nuevos && typeof saveDB === 'function') { try { saveDB(); } catch (e) {} }
  return nuevos;
}

// Recupera fichas a partir de las entregas activas del servidor (en cualquier computadora)
function stkRecuperarFichas() {
  var n = stkAsegurarFichas(stkEstado.afiliadosEntregas || []);
  if (n) stkAviso(n + ' ficha(s) incompleta(s) de afiliados recuperada(s) desde las entregas de Stock. Completalas en Afiliados.', 'ok');
  return n;
}

function stkIrAfiliado(ref) {
  if (!ref) return;
  if (typeof nav !== 'function' || typeof openAfiliadoModal !== 'function' || !stkPacientes()) { stkAviso('No se pudo abrir Afiliados.', 'err'); return; }
  var p = stkBuscarAfiliado(ref.dni);
  if (!p) { stkAsegurarFichas([ref]); p = stkBuscarAfiliado(ref.dni); }
  if (!p) { stkAviso('El DNI ' + ref.dni + ' no tiene ficha en Afiliados.', 'err'); return; }
  nav('afiliados');
  stkMostrarVolver();
  openAfiliadoModal(p.dni);   // el DNI tal como está guardado en la ficha
}

function stkMostrarVolver() {
  var pg = document.getElementById('page-afiliados');
  if (!pg) return;
  var bar = document.getElementById('stk-volver');
  if (!bar) { bar = document.createElement('div'); bar.id = 'stk-volver'; pg.insertBefore(bar, pg.firstChild); }
  var t = { historial: '📤 Historial de entregas', movimientos: '🔁 Movimientos', stock: '📦 Stock' }[stkEstado.tab] || 'Stock';
  bar.innerHTML = '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--sf2);border:1px solid var(--bd2);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:12.5px">' +
    '<button class="btn bp bsm" onclick="stkVolverAStock()">← Volver a Stock · ' + stkEsc(t) + '</button>' +
    '<span style="color:var(--tx2)">Se conservan la solapa, la consulta y los filtros.</span><span style="flex:1"></span>' +
    '<button class="btn bs bsm" title="Ocultar" onclick="stkOcultarVolver()">✕</button></div>';
}

function stkOcultarVolver() {
  var bar = document.getElementById('stk-volver');
  if (bar) bar.remove();
}

function stkVolverAStock() {
  stkOcultarVolver();
  try { if (typeof closeMo === 'function') closeMo('mo-afiliado'); } catch (e) {}
  if (typeof nav === 'function') nav('stock');
}

// ══════════════════════════════════════════════════════════════════════
// FORMULARIO: ENTREGA / BAJA / AJUSTE
// ══════════════════════════════════════════════════════════════════════
function stkArticulosEntregables(td) {
  return stkArticulosOperables().filter(function(a) {
    return !stkEsDiabetesCli(a) && (!stkEsAfiTipo(td) || stkVerdadero(a.GeneraEntrega));
  });
}

function stkOpcionesDe(lista, sel) {
  var cats = {};
  lista.forEach(function(a) { var k = String(a.Categoria || 'OTRO'); (cats[k] = cats[k] || []).push(a); });
  var orden = STK_ORDEN_CATEGORIAS.filter(function(k) { return cats[k]; }).concat(Object.keys(cats).filter(function(k) { return STK_ORDEN_CATEGORIAS.indexOf(k) < 0; }));
  return '<option value="">— Elegí un artículo —</option>' + orden.map(function(k) {
    return '<optgroup label="' + stkEsc(k) + '">' + cats[k].map(function(a) {
      var id = stkCampo(a, 'ID');
      return '<option value="' + stkEsc(id) + '"' + (id === sel ? ' selected' : '') + '>' + stkEsc(a.Nombre) + ' (' + stkEsc(a.Unidad) + ')</option>';
    }).join('') + '</optgroup>';
  }).join('');
}

function stkOpcionesLista(lista, sel, vacio) {
  var L = (stkEstado.listas && stkEstado.listas[lista]) || {};
  return (vacio ? '<option value="">' + stkEsc(vacio) + '</option>' : '') + Object.keys(L).map(function(k) { return stkOpt(k, L[k], sel); }).join('');
}

function stkAbrirEntrega() { stkAbrirOperacion3b('ENTREGA'); }

function stkAbrirOperacion3b(tipo) {
  var hoy = stkEstado.hoy || '', corte = stkEstado.analisis.corte;
  stkForm = { clase: 'op3b', tipo: tipo, reqId: stkNuevoReqId(), lineas: [{ articuloId: '', cantidad: '', sentido: 'MAS', extra: {} }], antSeq: 0, antTimer: null };
  var h = '<div class="stk-grid">' +
    '<div><div class="stk-k">Fecha' + (tipo === 'ENTREGA' ? ' de entrega' : '') + '</div><input type="date" class="stk-in" id="stkm-fecha" min="' + stkEsc(corte) + '"' + (hoy ? ' max="' + stkEsc(hoy) + '"' : '') +
      ' value="' + stkEsc(hoy) + '" onchange="stkRecalcular3b()"></div>' +
    '<div><div class="stk-k">' + (tipo === 'ENTREGA' ? 'Desde (ubicación de origen)' : 'Ubicación') + '</div><select class="stk-in" id="stkm-ubic" onchange="stkRecalcular3b()">' + stkOpcionesUbic('CENTRAL') + '</select></div>';
  if (tipo === 'ENTREGA') {
    var dests = {};
    stkEstado.movs.forEach(function(m) {
      var t = stkCampo(m, 'TipoDestinatario');
      if (stkCampo(m, 'Tipo') === 'ENTREGA' && (t === 'CONSULTORIO' || t === 'INSTITUCIONAL') && stkCampo(m, 'Destinatario')) dests[stkCampo(m, 'Destinatario')] = true;
    });
    h += '<div><div class="stk-k">Tipo de destinatario</div><select class="stk-in" id="stkm-td" onchange="stkEntCambioTipo()">' + stkOpcionesLista('tiposDestinatario', 'AFILIADO') + '</select></div>' +
      '<div><div class="stk-k" id="stkm-sec-k">Seccional asociada (opcional)</div><select class="stk-in" id="stkm-sec">' +
        '<option value="">— Sin seccional —</option>' + stkOpcionesUbic('', false) + '</select></div>' +
      '<div id="stkm-afi-dni"><div class="stk-k">DNI del afiliado</div><input class="stk-in mono" id="stkm-dni" inputmode="numeric" maxlength="12" oninput="stkEntDni()"></div>' +
      '<div id="stkm-afi-nom" style="grid-column:span 2"><div class="stk-k">Nombre y apellido</div><input class="stk-in" id="stkm-nombre" maxlength="120" oninput="stkEntAnterioresProgramar()"></div>' +
      '<div id="stkm-afi-info" style="grid-column:1/-1;display:none"></div>' +
      '<div id="stkm-otro" style="grid-column:span 2;display:none"><div class="stk-k">Destinatario (consultorio, profesional o institución)</div>' +
        '<input class="stk-in" id="stkm-dest" maxlength="120" list="stkm-dests" placeholder="Ej.: Consultorio de Ginecología – Dra. Pérez" oninput="stkEntAnterioresProgramar()">' +
        '<datalist id="stkm-dests">' + Object.keys(dests).sort().map(function(x) { return '<option value="' + stkEsc(x) + '">'; }).join('') + '</datalist></div>' +
      '<div><div class="stk-k">Retira / medio de envío</div><select class="stk-in" id="stkm-retira" onchange="stkEntRetira()">' + stkOpcionesLista('retira', 'AFILIADO', '— Elegí —') + '</select></div>' +
      '<div><div class="stk-k" id="stkm-retdet-k">Detalle (opcional)</div><input class="stk-in" id="stkm-retdet" maxlength="120" placeholder="Nombre, remís, Nº de envío…"></div>' +
      '<div><div class="stk-k">Constancia firmada</div><select class="stk-in" id="stkm-con" onchange="stkEntCon()">' + stkOpcionesLista('estadosConstancia', 'PENDIENTE') + '</select></div>' +
      '<div id="stkm-confr-w" style="display:none"><div class="stk-k">Fecha de recepción</div><input type="date" class="stk-in" id="stkm-confr"' + (hoy ? ' max="' + stkEsc(hoy) + '"' : '') + '></div>';
  } else if (tipo === 'BAJA') {
    h += '<div><div class="stk-k">Causa</div><select class="stk-in" id="stkm-causa" onchange="stkBajaCausa()">' + stkOpcionesLista('causasBaja', '', '— Elegí —') + '</select></div>' +
      '<div style="grid-column:span 2"><div class="stk-k" id="stkm-motivo-k">Detalle (opcional)</div><input class="stk-in" id="stkm-motivo" maxlength="500"></div>';
  } else {
    h += '<div style="grid-column:span 2"><div class="stk-k">Motivo del ajuste (obligatorio)</div><input class="stk-in" id="stkm-motivo" maxlength="500" placeholder="Ej.: recuento físico del 15/05"></div>';
  }
  h += '<div style="grid-column:1/-1"><div class="stk-k">Observación</div><input class="stk-in" id="stkm-obs" maxlength="500"></div></div>';
  if (tipo === 'ENTREGA') h += '<div id="stkm-ant" class="stk-ant" style="display:none"></div>';
  h += '<div class="stk-k" style="margin-top:4px">Artículos</div><div id="stkm-lineas"></div>' +
    '<button class="btn bs bsm" style="margin-top:8px" onclick="stkAgregarLinea3b()">+ Agregar artículo</button>' +
    (tipo === 'ENTREGA' ? '<div class="stk-dim" style="margin-top:8px">Los insumos de Diabetes no aparecen: se entregan por su circuito (hoja Entregas, SEC-1a.4). Para enviar una reserva a una seccional usá <strong>Transferencia</strong>.</div>' : '') +
    (tipo === 'AJUSTE' ? '<div class="stk-dim" style="margin-top:8px">El ajuste queda auditado con fecha, cantidades, saldo antes y después y el motivo. El acceso es compartido: el registro no identifica a una persona.</div>' : '') +
    '<div id="stkm-adv" style="margin-top:12px"></div><div id="stkm-msg" class="stk-msg"></div>';
  var titulo = { ENTREGA: 'Nueva entrega', BAJA: 'Nueva baja de stock', AJUSTE: 'Nuevo ajuste de stock' }[tipo];
  stkModalAbrir(titulo, h, stkPieGuardar(tipo === 'ENTREGA' ? 'Registrar entrega' : tipo === 'BAJA' ? 'Registrar baja' : 'Registrar ajuste'));
  if (tipo === 'ENTREGA') stkEntCambioTipo(); else stkRenderLineas3b();
}

function stkEntTipo() { return stkVal('stkm-td'); }

function stkEntCambioTipo() {
  var td = stkEntTipo(), afi = stkEsAfiTipo(td);
  ['stkm-afi-dni', 'stkm-afi-nom'].forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = afi ? '' : 'none'; });
  var ot = document.getElementById('stkm-otro'); if (ot) ot.style.display = afi ? 'none' : '';
  var info = document.getElementById('stkm-afi-info'); if (info && !afi) info.style.display = 'none';
  var k = document.getElementById('stkm-sec-k');
  if (k) k.textContent = td === 'AFILIADO_SECCIONAL' ? 'Seccional (obligatoria)' : 'Seccional asociada (opcional)';
  var ret = document.getElementById('stkm-retira');
  if (ret) ret.value = td === 'AFILIADO' ? 'AFILIADO' : td === 'AFILIADO_SECCIONAL' ? 'SECCIONAL' : '';
  var con = document.getElementById('stkm-con');
  if (con) con.value = (td === 'CONSULTORIO' || td === 'INSTITUCIONAL') ? 'NO_CORRESPONDE' : 'PENDIENTE';
  stkEntCon(); stkEntRetira();
  // Artículos que ya no corresponden a este tipo de destinatario
  var ok = {}, quitados = 0;
  stkArticulosEntregables(td).forEach(function(a) { ok[stkCampo(a, 'ID')] = true; });
  stkForm.lineas.forEach(function(l) { if (l.articuloId && !ok[l.articuloId]) { l.articuloId = ''; l.extra = {}; quitados++; } });
  stkRenderLineas3b();
  stkModalMsg(quitados ? quitados + ' artículo(s) se quitaron porque no se entregan a este tipo de destinatario.' : '', 'info');
  if (afi) stkEntDni(); else stkEntAnterioresProgramar();
}

function stkEntRetira() {
  var k = document.getElementById('stkm-retdet-k');
  if (k) k.textContent = stkVal('stkm-retira') === 'OTRO' ? 'Detalle (obligatorio)' : 'Detalle (opcional)';
}

function stkEntCon() {
  var w = document.getElementById('stkm-confr-w'), rec = stkVal('stkm-con') === 'RECIBIDA';
  if (w) w.style.display = rec ? '' : 'none';
  var fr = document.getElementById('stkm-confr');
  if (fr && rec && !fr.value) fr.value = stkVal('stkm-fecha');
}

function stkBajaCausa() {
  var k = document.getElementById('stkm-motivo-k');
  if (k) k.textContent = stkVal('stkm-causa') === 'OTRO' ? 'Motivo (obligatorio con "Otro")' : 'Detalle (opcional)';
}

function stkEntDni() {
  var info = document.getElementById('stkm-afi-info'), nom = document.getElementById('stkm-nombre');
  if (!info || !nom) return;
  var d = stkDniNorm(stkVal('stkm-dni'));
  if (!d) { info.style.display = 'none'; nom.readOnly = false; stkEntAnterioresProgramar(); return; }
  if (!/^\d{6,9}$/.test(d)) {
    info.style.display = ''; info.innerHTML = '<div class="stk-aviso warn" style="margin:0">El DNI debe tener entre 6 y 9 números (sin puntos).</div>';
    nom.readOnly = false; stkEntAnterioresProgramar(); return;
  }
  var p = stkBuscarAfiliado(d);
  info.style.display = '';
  if (p) {
    nom.value = p.nombre || ''; nom.readOnly = true;
    info.innerHTML = '<div class="stk-aviso ok" style="margin:0">✓ Afiliado registrado en MediGestión' + (p.seccional ? ' · Seccional: ' + stkEsc(p.seccional) : '') +
      (p._incompleto ? ' · <strong>ficha incompleta</strong>' : '') + '. Sus datos se administran en Afiliados.</div>';
  } else {
    if (nom.readOnly) nom.value = '';
    nom.readOnly = false;
    info.innerHTML = '<div class="stk-aviso" style="margin:0">Este DNI no tiene ficha. Ingresá nombre y apellido: al guardar la entrega se crea una <strong>ficha incompleta</strong> en Afiliados, para completarla después.</div>';
  }
  stkEntAnterioresProgramar();
}

// Entregas anteriores al mismo destinatario (informativo; nunca bloquea)
function stkEntAnterioresProgramar() {
  if (!stkForm || stkForm.tipo !== 'ENTREGA') return;
  clearTimeout(stkForm.antTimer);
  stkForm.antTimer = setTimeout(stkEntAnteriores, 450);
}

async function stkEntAnteriores() {
  var f = stkForm;
  if (!f || f.tipo !== 'ENTREGA') return;
  var el = document.getElementById('stkm-ant');
  if (!el) return;
  var afi = stkEsAfiTipo(stkEntTipo());
  var q = afi ? { dni: stkDniNorm(stkVal('stkm-dni')) } : { destinatario: String(stkVal('stkm-dest')).trim() };
  if ((afi && !/^\d{6,9}$/.test(q.dni)) || (!afi && q.destinatario.length < 3)) { el.style.display = 'none'; return; }
  var seq = ++f.antSeq;
  el.style.display = ''; el.textContent = 'Buscando entregas anteriores…';
  var r;
  try { r = await stkApi('stk_entregasAnteriores', q); } catch (e) { r = { ok: false, msg: e.message }; }
  if (stkForm !== f || seq !== f.antSeq) return;   // respuesta vieja
  if (!r || !r.ok) { el.textContent = 'No se pudieron consultar las entregas anteriores (no impide registrar).'; return; }
  var arts = stkArtMap();
  el.innerHTML = r.ops.length
    ? '<strong>Entregas anteriores a este destinatario</strong> (informativo)' + (r.total > r.ops.length ? ' · últimas ' + r.ops.length + ' de ' + r.total : '') +
      '<ul style="margin:6px 0 0 18px">' + r.ops.map(function(o) {
        return '<li>' + stkFmtFecha(o.fecha) + ' <span class="stk-dim">(hace ' + o.dias + ' día' + (o.dias === 1 ? '' : 's') + ')</span> · ' +
          stkEsc(o.lineas.map(function(l) { var a = arts[l.articuloId]; return (a ? a.Nombre : l.articuloId) + ' × ' + stkCant(l.cantidad, a); }).join(' · ')) +
          ' <span class="stk-dim">desde ' + stkEsc(stkNombreUbic(o.origen)) + '</span></li>';
      }).join('') + '</ul><div class="stk-dim" style="margin-top:4px">No incluye insumos de Diabetes de la hoja Entregas.</div>'
    : 'Sin entregas anteriores registradas en Stock para este destinatario.';
}

function stkRenderLineas3b() {
  var f = stkForm, tipo = f.tipo;
  var lista = tipo === 'ENTREGA' ? stkArticulosEntregables(stkEntTipo()) : stkArticulosOperables();
  var amap = stkArtMap(), campos = stkCamposLista();
  var cols = tipo === 'AJUSTE' ? 5 : 4;
  document.getElementById('stkm-lineas').innerHTML = '<div class="tw"><table class="stk-lineas"><thead><tr><th>Artículo</th>' +
    (tipo === 'AJUSTE' ? '<th style="width:120px">Suma / resta</th>' : '') + '<th style="width:110px">Cantidad</th>' +
    '<th style="width:190px">' + (tipo === 'AJUSTE' ? 'Saldo actual → resultante' : 'Disponible') + '</th><th></th></tr></thead><tbody>' +
    f.lineas.map(function(l, i) {
      var a = amap[l.articuloId];
      var cs = a ? String(stkCampo(a, 'CamposEntrega')).split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
      var fila = '<tr><td><select class="stk-in" onchange="stkLinea3b(' + i + ',\'articuloId\',this.value)">' + stkOpcionesDe(lista, l.articuloId) + '</select></td>' +
        (tipo === 'AJUSTE' ? '<td><select class="stk-in" onchange="stkLinea3b(' + i + ',\'sentido\',this.value)">' + stkOpt('MAS', '+ Suma', l.sentido) + stkOpt('MENOS', '− Resta', l.sentido) + '</select></td>' : '') +
        '<td><input class="stk-in stk-num" inputmode="numeric" value="' + stkEsc(l.cantidad) + '" oninput="stkLinea3b(' + i + ',\'cantidad\',this.value)"></td>' +
        '<td class="stk-dim" id="stkm-disp-' + i + '"></td>' +
        '<td>' + (f.lineas.length > 1 ? '<button class="btn bs bsm" title="Quitar" onclick="stkQuitarLinea3b(' + i + ')">✕</button>' : '') + '</td></tr>';
      if (tipo === 'ENTREGA' && cs.length) {
        fila += '<tr class="stk-extra"><td colspan="' + cols + '"><div class="stk-acciones">' + cs.map(function(k) {
          var def = campos[k] || { etiqueta: k, tipo: 'texto' }, v = (l.extra || {})[k] || '';
          return '<div style="min-width:220px;flex:1"><div class="stk-k">' + stkEsc(def.etiqueta) + ' (opcional)</div>' +
            (def.tipo === 'sino'
              ? '<select class="stk-in" onchange="stkLineaExtra(' + i + ',\'' + k + '\',this.value)">' + stkOpt('', '—', v) + stkOpt('SI', 'Sí', v) + stkOpt('NO', 'No', v) + '</select>'
              : '<input class="stk-in" maxlength="200" value="' + stkEsc(v) + '" oninput="stkLineaExtra(' + i + ',\'' + k + '\',this.value)">') + '</div>';
        }).join('') + '</div></td></tr>';
      }
      return fila;
    }).join('') + '</tbody></table></div>';
  stkRecalcular3b();
}

function stkAgregarLinea3b() { stkForm.lineas.push({ articuloId: '', cantidad: '', sentido: 'MAS', extra: {} }); stkRenderLineas3b(); }
function stkQuitarLinea3b(i) { stkForm.lineas.splice(i, 1); stkRenderLineas3b(); }

function stkLinea3b(i, campo, valor) {
  var l = stkForm.lineas[i];
  l[campo] = valor;
  if (campo === 'articuloId') { l.extra = {}; stkRenderLineas3b(); return; }
  stkRecalcular3b();
}

function stkLineaExtra(i, k, v) {
  var l = stkForm.lineas[i];
  l.extra = l.extra || {};
  l.extra[k] = v;
}

function stkCambios3b() {
  var f = stkForm, fecha = stkVal('stkm-fecha'), U = stkVal('stkm-ubic');
  return f.lineas.filter(function(l) {
    return l.articuloId && /^\d+$/.test(String(l.cantidad).trim()) && Number(l.cantidad) > 0 && (f.tipo !== 'AJUSTE' || l.sentido === 'MENOS');
  }).map(function(l) { return { ubicacion: U, articuloId: l.articuloId, fecha: fecha, delta: -Number(l.cantidad) }; });
}

function stkRecalcular3b() {
  var f = stkForm;
  if (!f || f.clase !== 'op3b') return;
  var fecha = stkVal('stkm-fecha'), U = stkVal('stkm-ubic');
  var alDia = stkSaldos(fecha)[U] || {}, actual = stkSaldos('')[U] || {}, arts = stkArtMap();
  f.lineas.forEach(function(l, i) {
    var el = document.getElementById('stkm-disp-' + i);
    if (!el) return;
    if (!l.articuloId) { el.textContent = ''; return; }
    var a = arts[l.articuloId];
    if (f.tipo === 'AJUSTE') {
      var c = /^\d+$/.test(String(l.cantidad).trim()) ? Number(l.cantidad) : 0, s = actual[l.articuloId] || 0;
      el.textContent = stkCant(s, a) + ' → ' + (s + (l.sentido === 'MENOS' ? -c : c)).toLocaleString('es-AR');
    } else {
      el.textContent = stkCant(alDia[l.articuloId] || 0, a) + (fecha ? ' al ' + stkFmtFecha(fecha) : '');
    }
  });
  var adv = document.getElementById('stkm-adv');
  if (!adv) return;
  var det = (U && fecha) ? stkVerificarSaldosCli(stkEstado.movs, stkCambios3b()) : [];
  var modo = stkEstado.datos.config && stkEstado.datos.config.modoCargaInicial;
  f.faltantes = det;
  if (!det.length) { adv.innerHTML = ''; return; }
  adv.innerHTML = modo
    ? '<div class="stk-aviso warn">⚠ Saldo insuficiente. Con el <strong>modo carga inicial activo</strong> se registra igual y queda la advertencia en auditoría.' + stkDetalleSaldos(det) + '</div>'
    : stkConfirmacionHtml('⚠ Saldo insuficiente.' + stkDetalleSaldos(det), true);
}

async function stkGuardarOperacion3b() {
  var f = stkForm, tipo = f.tipo;
  var enc = { fecha: stkVal('stkm-fecha'), ubicacion: stkVal('stkm-ubic'), observacion: stkVal('stkm-obs') };
  if (!enc.fecha) { stkModalMsg('Indicá la fecha.'); return; }
  if (!enc.ubicacion) { stkModalMsg('Indicá la ubicación.'); return; }
  var afi = false;
  if (tipo === 'ENTREGA') {
    enc.tipoDestinatario = stkEntTipo(); afi = stkEsAfiTipo(enc.tipoDestinatario);
    enc.seccional = stkVal('stkm-sec');
    if (enc.tipoDestinatario === 'AFILIADO_SECCIONAL' && !enc.seccional) { stkModalMsg('Indicá la seccional por la que se entrega.'); return; }
    if (afi) {
      enc.dni = stkDniNorm(stkVal('stkm-dni')); enc.destinatario = String(stkVal('stkm-nombre')).trim();
      if (!/^\d{6,9}$/.test(enc.dni)) { stkModalMsg('DNI inválido: solo números, de 6 a 9 dígitos.'); return; }
      if (!enc.destinatario) { stkModalMsg('Indicá el nombre y apellido del afiliado.'); return; }
    } else {
      enc.destinatario = String(stkVal('stkm-dest')).trim();
      if (!enc.destinatario) { stkModalMsg('Indicá el destinatario.'); return; }
    }
    enc.retira = stkVal('stkm-retira'); enc.retiraDetalle = stkVal('stkm-retdet');
    if (!enc.retira) { stkModalMsg('Indicá quién retira o el medio de envío.'); return; }
    if (enc.retira === 'OTRO' && !String(enc.retiraDetalle).trim()) { stkModalMsg('Con "Otro", detallá quién retira o cómo se envía.'); return; }
    enc.constancia = stkVal('stkm-con');
    if (enc.constancia === 'RECIBIDA') enc.fechaRecepcion = stkVal('stkm-confr') || enc.fecha;
  } else if (tipo === 'BAJA') {
    enc.causa = stkVal('stkm-causa'); enc.motivo = stkVal('stkm-motivo');
    if (!enc.causa) { stkModalMsg('Elegí la causa de la baja.'); return; }
    if (enc.causa === 'OTRO' && !String(enc.motivo).trim()) { stkModalMsg('Con la causa "Otro", el motivo es obligatorio.'); return; }
  } else {
    enc.motivo = stkVal('stkm-motivo');
    if (!String(enc.motivo).trim()) { stkModalMsg('El motivo del ajuste es obligatorio.'); return; }
  }
  var lineas = [], vistos = {};
  for (var i = 0; i < f.lineas.length; i++) {
    var l = f.lineas[i];
    if (!l.articuloId && !String(l.cantidad).trim()) continue;
    if (!l.articuloId) { stkModalMsg('Línea ' + (i + 1) + ': elegí el artículo.'); return; }
    if (vistos[l.articuloId]) { stkModalMsg('Hay un artículo repetido. Sumá las cantidades en una sola línea.'); return; }
    vistos[l.articuloId] = true;
    if (!/^\d+$/.test(String(l.cantidad).trim()) || Number(l.cantidad) <= 0) { stkModalMsg('Línea ' + (i + 1) + ': la cantidad debe ser un entero mayor a 0.'); return; }
    var lin = { articuloId: l.articuloId, cantidad: Number(l.cantidad) };
    if (tipo === 'AJUSTE') lin.sentido = l.sentido;
    if (tipo === 'ENTREGA' && l.extra && Object.keys(l.extra).length) lin.datosExtra = l.extra;
    lineas.push(lin);
  }
  if (!lineas.length) { stkModalMsg('Cargá al menos un artículo con cantidad mayor a 0.'); return; }
  var payload = { tipo: tipo, encabezado: enc, lineas: lineas };
  if (document.getElementById('stkm-confirmar')) {
    payload.confirmaStock = stkChk('stkm-conf-chk');
    payload.motivoStock = stkVal('stkm-conf-motivo');
    if (!payload.confirmaStock || !String(payload.motivoStock).trim()) { stkModalMsg('Para continuar con saldo insuficiente, confirmá e indicá el motivo.'); return; }
  }
  var r = await stkEnviar('stk_registrarOperacion', payload);
  if (!r) return;
  if (r.ok) {
    var extra = '';
    if (tipo === 'ENTREGA' && afi) {
      var n = stkAsegurarFichas([{ dni: enc.dni, nombre: enc.destinatario, seccional: enc.seccional }]);
      if (n) extra = ' · se creó una ficha incompleta en Afiliados';
    }
    var nombre = { ENTREGA: 'Entrega', BAJA: 'Baja', AJUSTE: 'Ajuste' }[tipo];
    await stkExito((r.repetido ? nombre + ' ya registrada' : nombre + ' registrada') + ' · ' + r.lineas + ' artículo(s)' +
      (r.advertencias && r.advertencias.length ? ' · con advertencia de saldo' : '') + extra);
    return;
  }
  if (r.code === 'STOCK_INSUFICIENTE') {
    document.getElementById('stkm-adv').innerHTML = stkConfirmacionHtml('⚠ ' + stkEsc(r.msg) + stkDetalleSaldos(r.detalle || []), true);
    stkModalMsg('Revisá la advertencia de saldo.');
    return;
  }
  stkModalMsg(r.msg || 'No se pudo guardar.');
}

// ══════════════════════════════════════════════════════════════════════
// SOLAPA 📤 HISTORIAL DE ENTREGAS (filtrado y paginado en el servidor)
// ══════════════════════════════════════════════════════════════════════
function stkHistFiltrosIniciales() {
  var hoy = stkEstado.hoy || new Date().toISOString().slice(0, 10);
  return { desde: hoy.slice(0, 8) + '01', hasta: hoy, seccional: '', origen: '', tipoDestinatario: '', destinatario: '', afiliado: '', articulo: '', constancia: '', anuladas: false };
}

function stkHist() {
  if (!stkEstado.hist) stkEstado.hist = { filtros: stkHistFiltrosIniciales(), res: null, cargando: false, error: '', abiertas: {}, pagina: 1, seq: 0 };
  return stkEstado.hist;
}

function stkHistSet(k, v) { stkHist().filtros[k] = v; }

async function stkHistBuscar(pagina) {
  var H = stkHist();
  if (H.filtros.desde && H.filtros.hasta && H.filtros.desde > H.filtros.hasta) { H.error = 'La fecha "desde" es posterior a "hasta".'; renderStkPage(); return; }
  H.cargando = true; H.error = ''; H.pagina = pagina || 1;
  var seq = ++H.seq;
  renderStkPage();
  var r;
  try { r = await stkApi('stk_consultarEntregas', { filtros: H.filtros, pagina: H.pagina, tam: STK_TAM_PAGINA }); }
  catch (e) { r = { ok: false, msg: e.message || String(e) }; }
  if (seq !== H.seq) return;
  H.cargando = false;
  if (r.code === 'SESION_INVALIDA') { stkEstado.datos = null; stkEstado.aviso = r.msg; renderStkPage(); return; }
  if (!r.ok) { H.error = r.msg || 'No se pudo consultar el historial.'; H.res = null; }
  else { H.res = r; H.abiertas = {}; }
  renderStkPage();
}

function stkHistLimpiar() {
  var H = stkHist();
  H.filtros = stkHistFiltrosIniciales();
  stkHistBuscar(1);
}

function stkHistSoloPendientes() {
  var H = stkHist();
  H.filtros.constancia = 'PENDIENTE';
  stkHistBuscar(1);
}

function stkHistToggle(id) {
  var H = stkHist();
  H.abiertas[id] = !H.abiertas[id];
  renderStkPage();
}

function stkFiltroCampo(etq, html) { return '<div><div class="stk-fil-k">' + etq + '</div>' + html + '</div>'; }

function stkConstanciaHtml(c) {
  if (!c) return '<span class="stk-dim">—</span>';
  var t = stkL('estadosConstancia', c.estado);
  if (c.estado === 'PENDIENTE') return '<span class="b bo">⏳ ' + stkEsc(t) + '</span>';
  if (c.estado === 'RECIBIDA') return '<span class="b bg" title="' + stkEsc(c.observacion || '') + '">✓ ' + stkEsc(t) + (c.fechaRecepcion ? ' ' + stkFmtFecha(c.fechaRecepcion) : '') + '</span>';
  return '<span class="b bgr">' + stkEsc(t) + '</span>';
}

function renderStkHistorial(c) {
  var H = stkHist(), F = H.filtros;
  if (!H.res && !H.cargando && !H.error) { stkHistBuscar(1); c.innerHTML = '<div class="stk-vacio">⏳ Consultando…</div>'; return; }
  stkOcultarVolver();
  var hoy = stkEstado.hoy || '', arts = stkArtMap();
  var artOpts = ((stkEstado.datos && stkEstado.datos.articulos) || []).filter(function(a) { return !stkEsDiabetesCli(a); })
    .sort(function(x, y) { return String(x.Nombre) < String(y.Nombre) ? -1 : 1; });
  var ubics = (stkEstado.datos && stkEstado.datos.ubicaciones) || [];
  var h = '<div class="stk-filtros"><button class="btn bp bsm" onclick="stkAbrirEntrega()">+ Nueva entrega</button>' +
    '<span class="stk-dim">Se consulta solo el período y los filtros elegidos. Las entregas de Diabetes (hoja Entregas) se integran en SEC-1a.4.</span></div>';
  h += '<div class="card"><div class="stk-body"><div class="stk-fil-grid">' +
    stkFiltroCampo('Desde', '<input type="date" class="stk-sel-in" value="' + stkEsc(F.desde) + '"' + (hoy ? ' max="' + stkEsc(hoy) + '"' : '') + ' onchange="stkHistSet(\'desde\',this.value)">') +
    stkFiltroCampo('Hasta', '<input type="date" class="stk-sel-in" value="' + stkEsc(F.hasta) + '"' + (hoy ? ' max="' + stkEsc(hoy) + '"' : '') + ' onchange="stkHistSet(\'hasta\',this.value)">') +
    stkFiltroCampo('Seccional', '<select class="stk-sel-in" onchange="stkHistSet(\'seccional\',this.value)">' + stkOpt('', 'Todas', F.seccional) +
      ubics.map(function(u) { return stkOpt(stkCampo(u, 'ID'), stkCampo(u, 'Nombre'), F.seccional); }).join('') + '</select>') +
    stkFiltroCampo('Desde ubicación', '<select class="stk-sel-in" onchange="stkHistSet(\'origen\',this.value)">' + stkOpt('', 'Todas', F.origen) +
      ubics.map(function(u) { return stkOpt(stkCampo(u, 'ID'), stkCampo(u, 'Nombre'), F.origen); }).join('') + '</select>') +
    stkFiltroCampo('Tipo de destinatario', '<select class="stk-sel-in" onchange="stkHistSet(\'tipoDestinatario\',this.value)">' + stkOpcionesLista('tiposDestinatario', F.tipoDestinatario, 'Todos') + '</select>') +
    stkFiltroCampo('Destinatario / consultorio', '<input class="stk-sel-in" value="' + stkEsc(F.destinatario) + '" placeholder="Texto" oninput="stkHistSet(\'destinatario\',this.value)" onkeydown="if(event.key===\'Enter\')stkHistBuscar(1)">') +
    stkFiltroCampo('Afiliado (DNI o nombre)', '<input class="stk-sel-in" value="' + stkEsc(F.afiliado) + '" oninput="stkHistSet(\'afiliado\',this.value)" onkeydown="if(event.key===\'Enter\')stkHistBuscar(1)">') +
    stkFiltroCampo('Artículo', '<select class="stk-sel-in" onchange="stkHistSet(\'articulo\',this.value)">' + stkOpt('', 'Todos', F.articulo) +
      artOpts.map(function(a) { return stkOpt(stkCampo(a, 'ID'), stkCampo(a, 'Nombre'), F.articulo); }).join('') + '</select>') +
    stkFiltroCampo('Constancia', '<select class="stk-sel-in" onchange="stkHistSet(\'constancia\',this.value)">' + stkOpcionesLista('estadosConstancia', F.constancia, 'Todas') + '</select>') +
    '</div><div class="stk-acciones">' +
    '<label class="stk-check"><input type="checkbox"' + (F.anuladas ? ' checked' : '') + ' onchange="stkHistSet(\'anuladas\',this.checked)"> Incluir anuladas</label>' +
    '<span style="flex:1"></span>' +
    '<button class="btn bp bsm" onclick="stkHistBuscar(1)"' + (H.cargando ? ' disabled' : '') + '>🔎 Buscar</button>' +
    '<button class="btn bs bsm" onclick="stkHistLimpiar()">Limpiar</button>' +
    '<button class="btn bs bsm" onclick="stkInforme(\'entregas\',\'pdf\')"' + (H.res && H.res.total ? '' : ' disabled') + '>🖨 Informe PDF</button>' +
    '<button class="btn bs bsm" onclick="stkInforme(\'entregas\',\'csv\')"' + (H.res && H.res.total ? '' : ' disabled') + '>⬇ CSV</button>' +
    '</div></div></div>';
  if (H.cargando) { c.innerHTML = h + '<div class="stk-vacio">⏳ Consultando…</div>'; return; }
  if (H.error) { c.innerHTML = h + '<div class="stk-aviso bad">✗ ' + stkEsc(H.error) + '</div>'; return; }
  var R = H.res, T = R.totales;
  h += '<div class="stk-dim" style="margin:-4px 0 8px">Resultado del ' + stkFmtFecha(R.filtros.desde) + ' al ' + stkFmtFecha(R.filtros.hasta) + ' · consultado ' + stkEsc(R.generado) + '</div>';
  h += '<div class="stk-kpis">' +
    '<div class="stk-kpi"><div class="k">Entregas</div><div class="v">' + T.operaciones.toLocaleString('es-AR') + '</div><div class="s">' + (T.anuladas ? T.anuladas + ' anulada(s) incluida(s)' : 'operaciones') + '</div></div>' +
    '<div class="stk-kpi"><div class="k">Unidades entregadas</div><div class="v">' + T.unidades.toLocaleString('es-AR') + '</div><div class="s">' + (R.filtros.articulo ? 'del artículo filtrado' : 'todas las unidades de medida') + '</div></div>' +
    '<div class="stk-kpi"><div class="k">Valor de materiales entregados</div><div class="v" style="font-size:17px">' + stkEsc(stkMoneda(T.valor)) + '</div><div class="s" title="Último precio de compra registrado con fecha igual o anterior a cada entrega. No es un costo contable.">valor de referencia' +
      (T.lineasSinValor ? ' · ' + T.lineasSinValor + ' línea(s) sin valor' : '') + '</div></div>' +
    '<div class="stk-kpi"><div class="k">Constancias pendientes</div><div class="v">' + T.constanciasPendientes + '</div><div class="s">' +
      (T.constanciasPendientes && F.constancia !== 'PENDIENTE' ? '<button class="stk-enlace" onclick="stkHistSoloPendientes()">ver solo pendientes</button>' : 'en el resultado') + '</div></div>' +
    '</div>';
  if (!R.total) { c.innerHTML = h + '<div class="card"><div class="stk-vacio">Sin entregas para este período y filtros.</div></div>'; return; }
  // Totales por artículo
  h += '<div class="card"><div class="ch">📦 <span class="ct">Totales por artículo</span><span class="stk-dim">' + R.porArticulo.length + '</span></div><div class="cb tw"><table>' +
    '<thead><tr><th>Artículo</th><th>Unidad</th><th class="stk-num">Cantidad</th><th class="stk-num">Valor de referencia</th></tr></thead><tbody>' +
    R.porArticulo.slice().sort(function(x, y) { var a = arts[x.articuloId], b = arts[y.articuloId]; return String(a ? a.Nombre : x.articuloId) < String(b ? b.Nombre : y.articuloId) ? -1 : 1; })
      .map(function(x) {
        var a = arts[x.articuloId];
        return '<tr><td>' + stkEsc(a ? a.Nombre : x.articuloId) + '</td><td>' + stkEsc(a ? a.Unidad : '') + '</td><td class="stk-num">' + x.cantidad.toLocaleString('es-AR') +
          '</td><td class="stk-num">' + (x.valor || !x.lineasSinValor ? stkEsc(stkMoneda(x.valor)) : '<span class="stk-dim">sin valor</span>') +
          (x.lineasSinValor && x.valor ? ' <span class="stk-dim" title="Líneas sin precio de compra registrado">(+' + x.lineasSinValor + ' sin valor)</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  if (R.porSeccional.length > 1) {
    h += '<div class="card"><div class="ch">📍 <span class="ct">Por seccional</span></div><div class="cb tw"><table>' +
      '<thead><tr><th>Seccional</th><th class="stk-num">Entregas</th><th class="stk-num">Unidades</th><th class="stk-num">Valor de referencia</th></tr></thead><tbody>' +
      R.porSeccional.slice().sort(function(x, y) { return y.unidades - x.unidades; }).map(function(x) {
        return '<tr><td>' + stkEsc(x.seccional ? stkNombreUbic(x.seccional) : '(sin seccional)') + '</td><td class="stk-num">' + x.operaciones + '</td><td class="stk-num">' +
          x.unidades.toLocaleString('es-AR') + '</td><td class="stk-num">' + stkEsc(stkMoneda(x.valor)) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }
  // Operaciones
  h += '<div class="card"><div class="ch">📤 <span class="ct">Entregas</span><span class="stk-dim">' + R.total + ' · página ' + R.pagina + ' de ' + R.paginas + '</span></div><div class="cb tw"><table>' +
    '<thead><tr><th>Fecha</th><th>Destinatario</th><th>Seccional</th><th>Desde</th><th>Retira</th><th>Artículos</th><th class="stk-num">Valor ref.</th><th>Constancia</th><th></th></tr></thead><tbody>' +
    R.ops.map(function(o) {
      var ref = stkRef(o.id), abierta = !!H.abiertas[o.id];
      var resumen = o.lineas.slice(0, 3).map(function(l) { var a = arts[l.articuloId]; return (a ? a.Nombre : l.articuloId) + ' × ' + stkCant(l.cantidad, a); }).join(' · ') +
        (o.lineas.length > 3 ? ' · y ' + (o.lineas.length - 3) + ' más' : '');
      var fila = '<tr class="' + (o.activa ? '' : 'stk-anulada') + '"><td class="mono">' + stkFmtFecha(o.fecha) + '</td><td>' +
        stkDestinatarioHtml(o.destinatario, o.dni, o.seccional, o.tipoDestinatario) + '<div class="stk-dim" style="font-size:11px">' + stkEsc(stkL('tiposDestinatario', o.tipoDestinatario)) + '</div></td><td>' +
        stkEsc(o.seccional ? stkNombreUbic(o.seccional) : '—') + '</td><td>' + stkEsc(stkNombreUbic(o.origen)) + '</td><td style="font-size:12px">' +
        stkEsc(stkL('retira', o.retira)) + (o.retiraDetalle ? '<div class="stk-dim" style="font-size:11px">' + stkEsc(o.retiraDetalle) + '</div>' : '') + '</td><td style="font-size:12px">' +
        '<strong>' + o.lineas.length + ' artículo(s)</strong><div class="stk-dim">' + stkEsc(resumen) + '</div></td><td class="stk-num">' +
        (o.lineas.length === o.lineasSinValor ? '<span class="stk-dim">sin valor</span>' : stkEsc(stkMoneda(o.valorRef)) + (o.lineasSinValor ? '<div class="stk-dim" style="font-size:10.5px">+' + o.lineasSinValor + ' sin valor</div>' : '')) +
        '</td><td>' + (o.activa ? stkConstanciaHtml(o.constancia) : '<span class="b bgr">Anulada</span>') + '</td><td><div class="stk-acciones">' +
        '<button class="btn bs bsm" onclick="stkHistToggle(stkRefs[' + ref + '])">' + (abierta ? 'Ocultar' : 'Ver') + '</button>' +
        (o.activa ? '<button class="btn bs bsm" title="Actualizar el estado de la constancia" onclick="stkAbrirConstancia(stkRefs[' + ref + '])">✎ Constancia</button>' : '') +
        '<button class="btn bs bsm" title="Constancia de entrega para imprimir (A4)" onclick="stkImprimirConstancia(stkRefs[' + ref + '])">🖨</button>' +
        '</div></td></tr>';
      if (abierta) {
        fila += '<tr class="stk-op-det stk-det3b"><td colspan="9"><table><thead><tr><th>Artículo</th><th class="stk-num">Cantidad</th><th>Unidad</th><th class="stk-num">Precio ref.</th><th class="stk-num">Valor ref.</th></tr></thead><tbody>' +
          o.lineas.map(function(l) {
            var a = arts[l.articuloId];
            return '<tr><td>' + stkEsc(a ? a.Nombre : l.articuloId) + stkExtraHtml(l.datosExtra) + '<div class="mono stk-dim">' + stkEsc(l.articuloId) + '</div></td><td class="stk-num">' + l.cantidad.toLocaleString('es-AR') +
              '</td><td>' + stkEsc(a ? a.Unidad : '') + '</td><td class="stk-num">' + (l.precioRef === null ? '<span class="stk-dim">sin precio</span>' :
                stkEsc(stkMoneda(l.precioRef)) + '<div class="stk-dim" style="font-size:10.5px">' + (l.origenPrecioRef === 'STOCK_INICIAL' ? 'stock inicial' : 'compra') + ' del ' + stkFmtFecha(l.fechaPrecioRef) + '</div>') +
              '</td><td class="stk-num">' + (l.valorRef === null ? '—' : stkEsc(stkMoneda(l.valorRef))) + '</td></tr>';
          }).join('') + '</tbody></table>' +
          '<div class="stk-dim" style="margin-top:6px">Operación ' + stkEsc(o.id) + ' · registrada ' + stkEsc(o.creadoEn) +
          (o.observacion ? ' · Observación: ' + stkEsc(o.observacion) : '') +
          (o.constancia && o.constancia.observacion ? ' · Constancia: ' + stkEsc(o.constancia.observacion) : '') + '</div></td></tr>';
      }
      return fila;
    }).join('') + '</tbody></table>' + stkPaginadorHtml(R, 'stkHistBuscar') + '</div></div>';
  h += '<div class="stk-dim" style="margin:4px 0 12px">Valor de referencia: último precio de compra (o del stock inicial) registrado con fecha igual o anterior a cada entrega. ' +
    'Es una referencia, no un costo contable, y no se suma al gasto por compras.</div>';
  c.innerHTML = h;
}

function stkPaginadorHtml(R, fn) {
  if (R.paginas <= 1) return '';
  return '<div class="stk-pag">' +
    '<button class="btn bs bsm"' + (R.pagina <= 1 ? ' disabled' : '') + ' onclick="' + fn + '(' + (R.pagina - 1) + ')">« Anterior</button>' +
    '<span class="stk-dim">Página ' + R.pagina + ' de ' + R.paginas + '</span>' +
    '<button class="btn bs bsm"' + (R.pagina >= R.paginas ? ' disabled' : '') + ' onclick="' + fn + '(' + (R.pagina + 1) + ')">Siguiente »</button></div>';
}

// ── Actualizar constancia (no toca el movimiento ni el stock) ──────────
function stkOpHist(opId) {
  var H = stkEstado.hist;
  return (H && H.res && H.res.ops || []).filter(function(o) { return o.id === opId; })[0] || null;
}

function stkAbrirConstancia(opId) {
  var o = stkOpHist(opId);
  if (!o) return;
  var hoy = stkEstado.hoy || '', c = o.constancia || { estado: 'PENDIENTE', fechaRecepcion: '', observacion: '' };
  stkForm = { clase: 'constancia', reqId: stkNuevoReqId(), operacionId: opId, fechaEntrega: o.fecha };
  var cuerpo = '<div class="stk-aviso">Entrega del ' + stkFmtFecha(o.fecha) + ' a <strong>' + stkEsc(o.destinatario) + '</strong>' + (o.dni ? ' (DNI ' + stkEsc(o.dni) + ')' : '') +
    ' · ' + o.lineas.length + ' artículo(s)</div>' +
    '<div class="stk-aviso">Cambiar el estado de la constancia <strong>no modifica la entrega ni el stock</strong>. El cambio queda auditado.</div>' +
    '<div class="stk-grid">' +
    '<div><div class="stk-k">Estado</div><select class="stk-in" id="stkm-con" onchange="stkConEstado()">' + stkOpcionesLista('estadosConstancia', c.estado) + '</select></div>' +
    '<div id="stkm-confr-w"><div class="stk-k">Fecha de recepción</div><input type="date" class="stk-in" id="stkm-confr" min="' + stkEsc(o.fecha) + '"' + (hoy ? ' max="' + stkEsc(hoy) + '"' : '') +
      ' value="' + stkEsc(c.fechaRecepcion || '') + '"></div>' +
    '<div style="grid-column:1/-1"><div class="stk-k">Observación</div><input class="stk-in" id="stkm-obs" maxlength="500" value="' + stkEsc(c.observacion || '') + '" placeholder="Ej.: llegó por correo desde la seccional"></div>' +
    '</div><div id="stkm-msg" class="stk-msg"></div>';
  stkModalAbrir('Constancia de entrega', cuerpo, stkPieGuardar('Guardar'));
  stkConEstado();
}

function stkConEstado() {
  var rec = stkVal('stkm-con') === 'RECIBIDA', w = document.getElementById('stkm-confr-w'), fr = document.getElementById('stkm-confr');
  if (w) w.style.display = rec ? '' : 'none';
  if (rec && fr && !fr.value) fr.value = stkEstado.hoy || '';
}

async function stkGuardarConstancia() {
  var f = stkForm, estado = stkVal('stkm-con'), fr = estado === 'RECIBIDA' ? stkVal('stkm-confr') : '';
  if (estado === 'RECIBIDA' && !fr) { stkModalMsg('Indicá la fecha de recepción.'); return; }
  if (fr && fr < f.fechaEntrega) { stkModalMsg('La fecha de recepción no puede ser anterior a la entrega.'); return; }
  var r = await stkEnviar('stk_setConstancia', { operacionId: f.operacionId, estado: estado, fechaRecepcion: fr, observacion: stkVal('stkm-obs') });
  if (!r) return;
  if (r.ok) {
    stkModalCerrar();
    stkAviso('Constancia actualizada', 'ok');
    var H = stkHist();
    await stkHistBuscar(H.pagina || 1);   // solo se vuelve a consultar el historial
    return;
  }
  stkModalMsg(r.msg || 'No se pudo guardar.');
}

// ══════════════════════════════════════════════════════════════════════
// SOLAPA 🧾 COMPRAS (gasto por compras; filtrado y paginado en el servidor)
// ══════════════════════════════════════════════════════════════════════
function stkComp() {
  if (!stkEstado.comp) {
    var hoy = stkEstado.hoy || new Date().toISOString().slice(0, 10);
    stkEstado.comp = { filtros: { desde: hoy.slice(0, 8) + '01', hasta: hoy, proveedor: '', comprobante: '', articulo: '', ubicacion: '', anuladas: false },
                       res: null, cargando: false, error: '', abiertas: {}, pagina: 1, seq: 0 };
  }
  return stkEstado.comp;
}

function stkCompSet(k, v) { stkComp().filtros[k] = v; }

async function stkCompBuscar(pagina) {
  var C = stkComp();
  if (C.filtros.desde && C.filtros.hasta && C.filtros.desde > C.filtros.hasta) { C.error = 'La fecha "desde" es posterior a "hasta".'; renderStkPage(); return; }
  C.cargando = true; C.error = ''; C.pagina = pagina || 1;
  var seq = ++C.seq;
  renderStkPage();
  var r;
  try { r = await stkApi('stk_consultarCompras', { filtros: C.filtros, pagina: C.pagina, tam: STK_TAM_PAGINA }); }
  catch (e) { r = { ok: false, msg: e.message || String(e) }; }
  if (seq !== C.seq) return;
  C.cargando = false;
  if (r.code === 'SESION_INVALIDA') { stkEstado.datos = null; stkEstado.aviso = r.msg; renderStkPage(); return; }
  if (!r.ok) { C.error = r.msg || 'No se pudo consultar las compras.'; C.res = null; }
  else { C.res = r; C.abiertas = {}; }
  renderStkPage();
}

function stkCompLimpiar() { stkEstado.comp = null; stkComp(); stkCompBuscar(1); }
function stkCompToggle(id) { var C = stkComp(); C.abiertas[id] = !C.abiertas[id]; renderStkPage(); }

function renderStkCompras(c) {
  var C = stkComp(), F = C.filtros;
  if (!C.res && !C.cargando && !C.error) { stkCompBuscar(1); c.innerHTML = '<div class="stk-vacio">⏳ Consultando…</div>'; return; }
  var hoy = stkEstado.hoy || '', arts = stkArtMap();
  var artOpts = ((stkEstado.datos && stkEstado.datos.articulos) || []).slice().sort(function(x, y) { return String(x.Nombre) < String(y.Nombre) ? -1 : 1; });
  var ubics = (stkEstado.datos && stkEstado.datos.ubicaciones) || [];
  var h = '<div class="stk-filtros"><button class="btn bp bsm" onclick="stkAbrirOperacion(\'INGRESO\')">+ Ingreso / compra</button>' +
    '<span class="stk-dim"><strong>Gasto por compras</strong>: importes de las facturas registradas en los ingresos del período. No es lo mismo que el valor de los materiales entregados.</span></div>';
  h += '<div class="card"><div class="stk-body"><div class="stk-fil-grid">' +
    stkFiltroCampo('Desde', '<input type="date" class="stk-sel-in" value="' + stkEsc(F.desde) + '"' + (hoy ? ' max="' + stkEsc(hoy) + '"' : '') + ' onchange="stkCompSet(\'desde\',this.value)">') +
    stkFiltroCampo('Hasta', '<input type="date" class="stk-sel-in" value="' + stkEsc(F.hasta) + '"' + (hoy ? ' max="' + stkEsc(hoy) + '"' : '') + ' onchange="stkCompSet(\'hasta\',this.value)">') +
    stkFiltroCampo('Proveedor', '<input class="stk-sel-in" value="' + stkEsc(F.proveedor) + '" oninput="stkCompSet(\'proveedor\',this.value)" onkeydown="if(event.key===\'Enter\')stkCompBuscar(1)">') +
    stkFiltroCampo('Factura', '<input class="stk-sel-in" value="' + stkEsc(F.comprobante) + '" oninput="stkCompSet(\'comprobante\',this.value)" onkeydown="if(event.key===\'Enter\')stkCompBuscar(1)">') +
    stkFiltroCampo('Artículo', '<select class="stk-sel-in" onchange="stkCompSet(\'articulo\',this.value)">' + stkOpt('', 'Todos', F.articulo) +
      artOpts.map(function(a) { return stkOpt(stkCampo(a, 'ID'), stkCampo(a, 'Nombre'), F.articulo); }).join('') + '</select>') +
    stkFiltroCampo('Ubicación de ingreso', '<select class="stk-sel-in" onchange="stkCompSet(\'ubicacion\',this.value)">' + stkOpt('', 'Todas', F.ubicacion) +
      ubics.map(function(u) { return stkOpt(stkCampo(u, 'ID'), stkCampo(u, 'Nombre'), F.ubicacion); }).join('') + '</select>') +
    '</div><div class="stk-acciones">' +
    '<label class="stk-check"><input type="checkbox"' + (F.anuladas ? ' checked' : '') + ' onchange="stkCompSet(\'anuladas\',this.checked)"> Incluir anuladas</label>' +
    '<span style="flex:1"></span>' +
    '<button class="btn bp bsm" onclick="stkCompBuscar(1)"' + (C.cargando ? ' disabled' : '') + '>🔎 Buscar</button>' +
    '<button class="btn bs bsm" onclick="stkCompLimpiar()">Limpiar</button>' +
    '<button class="btn bs bsm" onclick="stkInforme(\'compras\',\'pdf\')"' + (C.res && C.res.total ? '' : ' disabled') + '>🖨 Informe PDF</button>' +
    '<button class="btn bs bsm" onclick="stkInforme(\'compras\',\'csv\')"' + (C.res && C.res.total ? '' : ' disabled') + '>⬇ CSV</button>' +
    '</div></div></div>';
  if (C.cargando) { c.innerHTML = h + '<div class="stk-vacio">⏳ Consultando…</div>'; return; }
  if (C.error) { c.innerHTML = h + '<div class="stk-aviso bad">✗ ' + stkEsc(C.error) + '</div>'; return; }
  var R = C.res, T = R.totales;
  h += '<div class="stk-dim" style="margin:-4px 0 8px">Resultado del ' + stkFmtFecha(R.filtros.desde) + ' al ' + stkFmtFecha(R.filtros.hasta) + ' · consultado ' + stkEsc(R.generado) + '</div>';
  h += '<div class="stk-kpis">' +
    '<div class="stk-kpi"><div class="k">Compras</div><div class="v">' + T.operaciones.toLocaleString('es-AR') + '</div><div class="s">ingresos registrados</div></div>' +
    '<div class="stk-kpi"><div class="k">Gasto por compras</div><div class="v" style="font-size:17px">' + stkEsc(stkMoneda(T.gasto)) + '</div><div class="s">' +
      (T.lineasSinImporte ? T.lineasSinImporte + ' línea(s) sin importe no suman' : 'según importes registrados') + '</div></div>' +
    '<div class="stk-kpi"><div class="k">Unidades compradas</div><div class="v">' + T.unidades.toLocaleString('es-AR') + '</div><div class="s">todas las unidades de medida</div></div>' +
    '</div>';
  if (!R.total) { c.innerHTML = h + '<div class="card"><div class="stk-vacio">Sin compras para este período y filtros.</div></div>'; return; }
  if (R.porProveedor.length > 1) {
    h += '<div class="card"><div class="ch">🏷 <span class="ct">Por proveedor</span></div><div class="cb tw"><table><thead><tr><th>Proveedor</th><th class="stk-num">Compras</th><th class="stk-num">Importe</th></tr></thead><tbody>' +
      R.porProveedor.slice().sort(function(x, y) { return y.importe - x.importe; }).map(function(x) {
        return '<tr><td>' + stkEsc(x.proveedor || '(sin proveedor)') + '</td><td class="stk-num">' + x.operaciones + '</td><td class="stk-num">' + stkEsc(stkMoneda(x.importe)) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }
  h += '<div class="card"><div class="ch">🧾 <span class="ct">Compras</span><span class="stk-dim">' + R.total + ' · página ' + R.pagina + ' de ' + R.paginas + '</span></div><div class="cb tw"><table>' +
    '<thead><tr><th>Fecha</th><th>Proveedor</th><th>Factura</th><th>Ingresa en</th><th>Artículos</th><th class="stk-num">Total</th><th></th></tr></thead><tbody>' +
    R.ops.map(function(o) {
      var ref = stkRef(o.id), abierta = !!C.abiertas[o.id];
      var fila = '<tr class="' + (o.activa ? '' : 'stk-anulada') + '"><td class="mono">' + stkFmtFecha(o.fecha) + '</td><td>' + stkEsc(o.proveedor || '—') + '</td><td>' + stkEsc(o.comprobante || '—') +
        '</td><td>' + stkEsc(stkNombreUbic(o.ubicacion)) + '</td><td style="font-size:12px">' + o.lineas.length + ' artículo(s)</td><td class="stk-num">' + stkEsc(stkMoneda(o.total)) +
        (o.lineasSinImporte ? '<div class="stk-dim" style="font-size:10.5px">+' + o.lineasSinImporte + ' sin importe</div>' : '') + (o.activa ? '' : ' <span class="b bgr">Anulada</span>') +
        '</td><td><button class="btn bs bsm" onclick="stkCompToggle(stkRefs[' + ref + '])">' + (abierta ? 'Ocultar' : 'Ver') + '</button></td></tr>';
      if (abierta) {
        fila += '<tr class="stk-op-det stk-det3b"><td colspan="7"><table><thead><tr><th>Artículo</th><th class="stk-num">Cantidad</th><th>Unidad</th><th class="stk-num">Precio unit.</th><th class="stk-num">Importe</th></tr></thead><tbody>' +
          o.lineas.map(function(l) {
            var a = arts[l.articuloId];
            return '<tr><td>' + stkEsc(a ? a.Nombre : l.articuloId) + '</td><td class="stk-num">' + l.cantidad.toLocaleString('es-AR') + '</td><td>' + stkEsc(a ? a.Unidad : '') +
              '</td><td class="stk-num">' + (l.precioUnit === null ? '—' : stkEsc(stkMoneda(l.precioUnit))) + '</td><td class="stk-num">' + (l.importe === null ? '—' : stkEsc(stkMoneda(l.importe))) + '</td></tr>';
          }).join('') + '<tr><td colspan="4" style="text-align:right;font-weight:700">Total de la compra</td><td class="stk-num" style="font-weight:700">' + stkEsc(stkMoneda(o.total)) + '</td></tr></tbody></table>' +
          '<div class="stk-dim" style="margin-top:6px">Operación ' + stkEsc(o.id) + ' · registrada ' + stkEsc(o.creadoEn) + (o.observacion ? ' · ' + stkEsc(o.observacion) : '') + '</div></td></tr>';
      }
      return fila;
    }).join('') + '</tbody></table>' + stkPaginadorHtml(R, 'stkCompBuscar') + '</div></div>';
  c.innerHTML = h;
}

// ══════════════════════════════════════════════════════════════════════
// INFORMES: PDF (vista A4 del navegador) y CSV (Excel 2016, Argentina)
// ══════════════════════════════════════════════════════════════════════
// Trae TODAS las operaciones que coinciden con los filtros, en bloques, y verifica que no falte ninguna.
async function stkTraerTodo(tipo, filtros, alProgresar) {
  var accion = tipo === 'entregas' ? 'stk_consultarEntregas' : 'stk_consultarCompras';
  var ops = [], pagina = 1, primera = null, ids = {};
  while (true) {
    var r = await stkApi(accion, { filtros: filtros, pagina: pagina, tam: 500, exportar: true });
    if (!r || !r.ok) throw new Error((r && r.msg) || 'No se pudo leer el informe.');
    if (!primera) {
      primera = r;
      if (r.total > STK_INFORME_AVISO_OPS && typeof window !== 'undefined' && window.confirm &&
          !window.confirm('El informe tiene ' + r.total.toLocaleString('es-AR') + ' operaciones y puede tardar. ¿Continuar? (Podés acotar el período con los filtros.)'))
        return null;
    } else if (r.total !== primera.total) {
      throw new Error('Los datos cambiaron mientras se generaba el informe. Volvé a generarlo.');
    }
    r.ops.forEach(function(o) {
      if (ids[o.id]) throw new Error('Operación repetida en el informe (' + o.id + '). Volvé a generarlo.');
      ids[o.id] = true; ops.push(o);
    });
    if (alProgresar) alProgresar(ops.length, primera.total);
    if (ops.length >= primera.total || pagina >= r.paginas || !r.ops.length) break;
    pagina++;
  }
  if (ops.length !== primera.total) throw new Error('El informe quedó incompleto (' + ops.length + ' de ' + primera.total + '). Volvé a generarlo.');
  return { cab: primera, ops: ops };
}

async function stkInforme(tipo, formato) {
  var est = tipo === 'entregas' ? stkHist() : stkComp();
  if (!est.res) return;
  var filtros = JSON.parse(JSON.stringify(est.res.filtros));   // exactamente lo consultado en pantalla
  var win = null;
  if (formato === 'pdf') {
    win = window.open('', '_blank');
    if (!win) { stkAviso('El navegador bloqueó la ventana del informe. Permití ventanas emergentes para este sitio.', 'err'); return; }
    win.document.open();
    win.document.write('<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe OSPIV</title></head><body style="font-family:Arial,sans-serif;padding:24px">' +
      '<p id="prog">Preparando el informe…</p></body></html>');
    win.document.close();
  }
  try {
    var todo = await stkTraerTodo(tipo, filtros, function(n, t) {
      if (win && !win.closed) { var p = win.document.getElementById('prog'); if (p) p.textContent = 'Leyendo operaciones: ' + n + ' de ' + t + '…'; }
    });
    if (!todo) { if (win) win.close(); return; }
    if (formato === 'csv') stkDescargarCSV3b(tipo, todo);
    else await stkEscribirInforme(win, tipo, todo);
  } catch (e) {
    if (win && !win.closed) { var p = win.document.getElementById('prog'); if (p) { p.style.color = '#c0392b'; p.textContent = '✗ ' + (e.message || e); } }
    stkAviso(e.message || String(e), 'err');
  }
}

function stkNumCSV(n) { return n === null || n === undefined || n === '' ? '' : String(n).replace('.', ','); }

function stkDescargarArchivo(nombre, contenido, mime) {
  var blob = new Blob([contenido], { type: mime });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function stkDescargarCSV3b(tipo, todo) {
  var arts = stkArtMap(), lineas = [], F = todo.cab.filtros;
  function art(id) { return arts[id] || {}; }
  if (tipo === 'entregas') {
    lineas.push(['Operación', 'Fecha', 'Desde', 'Tipo de destinatario', 'Seccional', 'Destinatario', 'DNI', 'Retira / envío', 'Detalle retiro',
      'Constancia', 'Fecha recepción', 'Artículo ID', 'Artículo', 'Cantidad', 'Unidad', 'Datos adicionales', 'Precio ref.', 'Fecha precio ref.', 'Valor ref.', 'Observación', 'Estado'].map(stkCeldaCSV).join(';'));
    todo.ops.forEach(function(o) {
      o.lineas.forEach(function(l) {
        lineas.push([o.id, stkFmtFecha(o.fecha), stkNombreUbic(o.origen), stkL('tiposDestinatario', o.tipoDestinatario), o.seccional ? stkNombreUbic(o.seccional) : '',
          o.destinatario, o.dni, stkL('retira', o.retira), o.retiraDetalle, o.constancia ? stkL('estadosConstancia', o.constancia.estado) : '',
          o.constancia && o.constancia.fechaRecepcion ? stkFmtFecha(o.constancia.fechaRecepcion) : '', l.articuloId, art(l.articuloId).Nombre || '', l.cantidad,
          art(l.articuloId).Unidad || '', stkExtraTexto(l.datosExtra), stkNumCSV(l.precioRef), l.fechaPrecioRef ? stkFmtFecha(l.fechaPrecioRef) : '', stkNumCSV(l.valorRef),
          o.observacion, (o.activa && l.estado !== 'ANULADO') ? 'Activa' : 'Anulada'].map(stkCeldaCSV).join(';'));
      });
    });
  } else {
    lineas.push(['Operación', 'Fecha', 'Proveedor', 'Factura', 'Ingresa en', 'Artículo ID', 'Artículo', 'Cantidad', 'Unidad', 'Precio unit.', 'Importe', 'Total de la compra', 'Observación', 'Estado'].map(stkCeldaCSV).join(';'));
    todo.ops.forEach(function(o) {
      o.lineas.forEach(function(l) {
        lineas.push([o.id, stkFmtFecha(o.fecha), o.proveedor, o.comprobante, stkNombreUbic(o.ubicacion), l.articuloId, art(l.articuloId).Nombre || '', l.cantidad,
          art(l.articuloId).Unidad || '', stkNumCSV(l.precioUnit), stkNumCSV(l.importe), stkNumCSV(o.total), o.observacion,
          (o.activa && l.estado !== 'ANULADO') ? 'Activa' : 'Anulada'].map(stkCeldaCSV).join(';'));
      });
    });
  }
  var nombre = (tipo === 'entregas' ? 'entregas' : 'compras') + '_' + (F.desde || 'inicio') + '_a_' + (F.hasta || 'hoy') + '.csv';
  stkDescargarArchivo(nombre, '﻿' + lineas.join('\r\n'), 'text/csv;charset=utf-8');
  stkAviso('CSV descargado · ' + todo.ops.length + ' operación(es)', 'ok');
}

// ── Vista A4 institucional ─────────────────────────────────────────────
function stkLogoSrc() {
  try { var im = document.querySelector('img[alt="OSPIV"]'); return im ? im.src : ''; } catch (e) { return ''; }
}

var STK_CSS_A4 = [
  '@page{size:A4;margin:14mm 12mm 16mm}',
  '*{box-sizing:border-box}',
  'body{font-family:Arial,Helvetica,sans-serif;color:#1b1f2a;font-size:10.5pt;margin:0;background:#fff}',
  '.barra{position:sticky;top:0;background:#f3f5fa;border-bottom:1px solid #ccd3e3;padding:10px 16px;display:flex;gap:12px;align-items:center;font-size:10pt}',
  '.barra button{background:#1d3a8a;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:10pt;cursor:pointer}',
  '.hoja{max-width:186mm;margin:0 auto;padding:10px 0 24px}',
  '.enc{display:flex;align-items:center;gap:14px;border-bottom:3px solid #1d3a8a;padding-bottom:8px;margin-bottom:10px}',
  '.enc img{height:46px}',
  '.enc h1{font-size:14pt;margin:0;color:#1d3a8a}',
  '.enc .sub{font-size:9pt;color:#555}',
  '.meta{font-size:9pt;color:#333;margin:6px 0 10px;line-height:1.5}',
  '.kpis{display:flex;gap:8px;margin:8px 0 12px}',
  '.kpis div{flex:1;border:1px solid #ccd3e3;border-radius:6px;padding:6px 8px;font-size:8.5pt;color:#555}',
  '.kpis b{display:block;font-size:12pt;color:#1b1f2a}',
  'h2{font-size:11pt;color:#1d3a8a;margin:14px 0 6px;border-bottom:1px solid #ccd3e3;padding-bottom:3px}',
  'table{width:100%;border-collapse:collapse;font-size:9pt}',
  'thead{display:table-header-group}',
  'th{background:#e8ecf6;text-align:left;padding:4px 6px;border:1px solid #ccd3e3;font-size:8.5pt}',
  'td{padding:3px 6px;border:1px solid #dde2ee;vertical-align:top}',
  'tr{page-break-inside:avoid;break-inside:avoid}',
  '.num{text-align:right;white-space:nowrap}',
  '.op{border:1px solid #ccd3e3;border-radius:6px;padding:6px 8px;margin:0 0 8px;page-break-inside:avoid;break-inside:avoid}',
  '.op.grande{page-break-inside:auto;break-inside:auto}',
  '.op .cab{font-size:9pt;margin-bottom:4px;line-height:1.45}',
  '.op .cab b{font-size:9.5pt}',
  '.dim{color:#666;font-size:8.5pt}',
  '.anulada{color:#c0392b;font-weight:bold}',
  '.pie{margin-top:14px;font-size:8pt;color:#666;border-top:1px solid #ccd3e3;padding-top:6px}',
  '.ok{color:#1e7e34;font-weight:bold}',
  '@media print{.barra{display:none}.hoja{max-width:none;padding:0}}'
].join('\n');

function stkEscH(v) { return stkEsc(v); }

function stkFiltrosTexto(tipo, F) {
  var arts = stkArtMap(), t = [];
  t.push('Período: ' + (F.desde ? stkFmtFecha(F.desde) : 'desde el inicio') + ' al ' + (F.hasta ? stkFmtFecha(F.hasta) : 'hoy'));
  if (tipo === 'entregas') {
    if (F.seccional) t.push('Seccional: ' + stkNombreUbic(F.seccional));
    if (F.origen) t.push('Desde: ' + stkNombreUbic(F.origen));
    if (F.tipoDestinatario) t.push('Tipo de destinatario: ' + stkL('tiposDestinatario', F.tipoDestinatario));
    if (F.destinatario) t.push('Destinatario contiene: "' + F.destinatario + '"');
    if (F.afiliado) t.push('Afiliado: "' + F.afiliado + '"');
    if (F.constancia) t.push('Constancia: ' + stkL('estadosConstancia', F.constancia));
  } else {
    if (F.proveedor) t.push('Proveedor contiene: "' + F.proveedor + '"');
    if (F.comprobante) t.push('Factura contiene: "' + F.comprobante + '"');
    if (F.ubicacion) t.push('Ubicación: ' + stkNombreUbic(F.ubicacion));
  }
  if (F.articulo) t.push('Artículo: ' + (arts[F.articulo] ? arts[F.articulo].Nombre : F.articulo));
  t.push(F.anuladas ? 'Incluye operaciones anuladas (no suman en los totales)' : 'Sin operaciones anuladas');
  return t;
}

function stkEncabezadoA4(titulo, sub) {
  var logo = stkLogoSrc();
  return '<div class="enc">' + (logo ? '<img src="' + logo + '" alt="OSPIV">' : '<b style="font-size:18pt;color:#1d3a8a">OSPIV</b>') +
    '<div><h1>' + stkEscH(titulo) + '</h1><div class="sub">' + stkEscH(sub) + '</div></div></div>';
}

function stkHtmlOpEntrega(o, arts) {
  var grande = o.lineas.length > 25;
  return '<div class="op' + (grande ? ' grande' : '') + '"><div class="cab"><b>' + stkFmtFecha(o.fecha) + ' · ' + stkEscH(o.destinatario || '—') + '</b>' +
    (o.dni ? ' · DNI ' + stkEscH(o.dni) : '') + ' · ' + stkEscH(stkL('tiposDestinatario', o.tipoDestinatario)) +
    (o.activa ? '' : ' · <span class="anulada">ANULADA</span>') + '<br>' +
    'Seccional: ' + stkEscH(o.seccional ? stkNombreUbic(o.seccional) : '—') + ' · Desde: ' + stkEscH(stkNombreUbic(o.origen)) +
    ' · Retira: ' + stkEscH(stkL('retira', o.retira) + (o.retiraDetalle ? ' (' + o.retiraDetalle + ')' : '')) +
    ' · Constancia: ' + stkEscH(o.constancia ? stkL('estadosConstancia', o.constancia.estado) + (o.constancia.fechaRecepcion ? ' ' + stkFmtFecha(o.constancia.fechaRecepcion) : '') : '—') +
    ' <span class="dim">· ' + stkEscH(o.id) + '</span></div>' +
    '<table><thead><tr><th>Artículo</th><th class="num">Cantidad</th><th>Unidad</th><th class="num">Valor ref.</th></tr></thead><tbody>' +
    o.lineas.map(function(l) {
      var a = arts[l.articuloId] || {}, ex = stkExtraTexto(l.datosExtra);
      return '<tr><td>' + stkEscH(a.Nombre || l.articuloId) + (ex ? '<div class="dim">' + stkEscH(ex) + '</div>' : '') + '</td><td class="num">' + l.cantidad.toLocaleString('es-AR') +
        '</td><td>' + stkEscH(a.Unidad || '') + '</td><td class="num">' + (l.valorRef === null ? '<span class="dim">sin valor</span>' : stkEscH(stkMoneda(l.valorRef))) + '</td></tr>';
    }).join('') + '</tbody></table>' + (o.observacion ? '<div class="dim" style="margin-top:3px">Observación: ' + stkEscH(o.observacion) + '</div>' : '') + '</div>';
}

function stkHtmlOpCompra(o, arts) {
  return '<div class="op' + (o.lineas.length > 25 ? ' grande' : '') + '"><div class="cab"><b>' + stkFmtFecha(o.fecha) + ' · ' + stkEscH(o.proveedor || '(sin proveedor)') + '</b>' +
    ' · Factura: ' + stkEscH(o.comprobante || '—') + ' · Ingresa en: ' + stkEscH(stkNombreUbic(o.ubicacion)) + (o.activa ? '' : ' · <span class="anulada">ANULADA</span>') +
    ' <span class="dim">· ' + stkEscH(o.id) + '</span></div>' +
    '<table><thead><tr><th>Artículo</th><th class="num">Cantidad</th><th>Unidad</th><th class="num">Precio unit.</th><th class="num">Importe</th></tr></thead><tbody>' +
    o.lineas.map(function(l) {
      var a = arts[l.articuloId] || {};
      return '<tr><td>' + stkEscH(a.Nombre || l.articuloId) + '</td><td class="num">' + l.cantidad.toLocaleString('es-AR') + '</td><td>' + stkEscH(a.Unidad || '') +
        '</td><td class="num">' + (l.precioUnit === null ? '—' : stkEscH(stkMoneda(l.precioUnit))) + '</td><td class="num">' + (l.importe === null ? '—' : stkEscH(stkMoneda(l.importe))) + '</td></tr>';
    }).join('') + '<tr><td colspan="4" class="num"><b>Total de la compra</b>' + (o.lineasSinImporte ? ' <span class="dim">(' + o.lineasSinImporte + ' línea/s sin importe)</span>' : '') +
    '</td><td class="num"><b>' + stkEscH(stkMoneda(o.total)) + '</b></td></tr></tbody></table></div>';
}

// Escribe el informe en bloques para no congelar la pantalla y verifica el total al final
async function stkEscribirInforme(win, tipo, todo) {
  if (!win || win.closed) return;
  var arts = stkArtMap(), R = todo.cab, T = R.totales, F = R.filtros;
  var ahora = new Date(), fh = String(ahora.getDate()).padStart(2, '0') + '/' + String(ahora.getMonth() + 1).padStart(2, '0') + '/' + ahora.getFullYear() + ' ' +
    String(ahora.getHours()).padStart(2, '0') + ':' + String(ahora.getMinutes()).padStart(2, '0');
  var titulo = tipo === 'entregas' ? 'Informe de entregas de materiales' : 'Informe de compras (gasto por compras)';
  var h = '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>' + stkEscH(titulo) + '</title><style>' + STK_CSS_A4 + '</style></head><body>' +
    '<div class="barra"><button onclick="window.print()">🖨 Imprimir o guardar como PDF</button><span id="estado">Armando el informe…</span></div><div class="hoja">' +
    stkEncabezadoA4(titulo, 'Obra Social del Personal de la Industria del Vidrio · MediGestión · Stock y Movimientos') +
    '<div class="meta">' + stkFiltrosTexto(tipo, F).map(stkEscH).join('<br>') + '<br>Generado: ' + fh + '</div>';
  if (tipo === 'entregas') {
    h += '<div class="kpis"><div>Entregas<b>' + T.operaciones.toLocaleString('es-AR') + '</b></div><div>Unidades entregadas<b>' + T.unidades.toLocaleString('es-AR') + '</b></div>' +
      '<div>Valor de materiales entregados (referencia)<b>' + stkEscH(stkMoneda(T.valor)) + '</b>' + (T.lineasSinValor ? T.lineasSinValor + ' línea(s) sin valor' : '') + '</div>' +
      '<div>Constancias pendientes<b>' + T.constanciasPendientes + '</b></div></div>' +
      '<h2>Totales por artículo</h2><table><thead><tr><th>Artículo</th><th>Unidad</th><th class="num">Cantidad</th><th class="num">Valor de referencia</th></tr></thead><tbody>' +
      R.porArticulo.slice().sort(function(x, y) { return String((arts[x.articuloId] || {}).Nombre || x.articuloId) < String((arts[y.articuloId] || {}).Nombre || y.articuloId) ? -1 : 1; })
        .map(function(x) { var a = arts[x.articuloId] || {}; return '<tr><td>' + stkEscH(a.Nombre || x.articuloId) + '</td><td>' + stkEscH(a.Unidad || '') + '</td><td class="num">' + x.cantidad.toLocaleString('es-AR') +
          '</td><td class="num">' + (!x.valor && x.lineasSinValor ? '<span class="dim">sin valor</span>' : stkEscH(stkMoneda(x.valor)) + (x.lineasSinValor ? ' <span class="dim">(+' + x.lineasSinValor + ' sin valor)</span>' : '')) + '</td></tr>'; }).join('') + '</tbody></table>';
    if (R.porSeccional.length > 1) {
      h += '<h2>Por seccional</h2><table><thead><tr><th>Seccional</th><th class="num">Entregas</th><th class="num">Unidades</th><th class="num">Valor de referencia</th></tr></thead><tbody>' +
        R.porSeccional.map(function(x) { return '<tr><td>' + stkEscH(x.seccional ? stkNombreUbic(x.seccional) : '(sin seccional)') + '</td><td class="num">' + x.operaciones + '</td><td class="num">' +
          x.unidades.toLocaleString('es-AR') + '</td><td class="num">' + stkEscH(stkMoneda(x.valor)) + '</td></tr>'; }).join('') + '</tbody></table>';
    }
    h += '<h2>Detalle de entregas (' + todo.ops.length + ')</h2>';
  } else {
    h += '<div class="kpis"><div>Compras<b>' + T.operaciones.toLocaleString('es-AR') + '</b></div><div>Gasto por compras<b>' + stkEscH(stkMoneda(T.gasto)) + '</b>' +
      (T.lineasSinImporte ? T.lineasSinImporte + ' línea(s) sin importe' : '') + '</div><div>Unidades compradas<b>' + T.unidades.toLocaleString('es-AR') + '</b></div></div>';
    if (R.porProveedor.length) {
      h += '<h2>Por proveedor</h2><table><thead><tr><th>Proveedor</th><th class="num">Compras</th><th class="num">Importe</th></tr></thead><tbody>' +
        R.porProveedor.map(function(x) { return '<tr><td>' + stkEscH(x.proveedor || '(sin proveedor)') + '</td><td class="num">' + x.operaciones + '</td><td class="num">' + stkEscH(stkMoneda(x.importe)) + '</td></tr>'; }).join('') + '</tbody></table>';
    }
    h += '<h2>Totales por artículo</h2><table><thead><tr><th>Artículo</th><th>Unidad</th><th class="num">Cantidad</th><th class="num">Importe</th></tr></thead><tbody>' +
      R.porArticulo.map(function(x) { var a = arts[x.articuloId] || {}; return '<tr><td>' + stkEscH(a.Nombre || x.articuloId) + '</td><td>' + stkEscH(a.Unidad || '') + '</td><td class="num">' +
        x.cantidad.toLocaleString('es-AR') + '</td><td class="num">' + stkEscH(stkMoneda(x.importe)) + '</td></tr>'; }).join('') + '</tbody></table>' +
      '<h2>Detalle de compras (' + todo.ops.length + ')</h2>';
  }
  h += '<div id="detalle"></div><div class="pie" id="pie"></div></div></body></html>';
  win.document.open(); win.document.write(h); win.document.close();
  var cont = win.document.getElementById('detalle'), BLOQUE = 150, escritas = 0, lineasTot = 0;
  for (var i = 0; i < todo.ops.length; i += BLOQUE) {
    if (win.closed) return;
    var parte = todo.ops.slice(i, i + BLOQUE);
    cont.insertAdjacentHTML('beforeend', parte.map(function(o) { lineasTot += o.lineas.length; return tipo === 'entregas' ? stkHtmlOpEntrega(o, arts) : stkHtmlOpCompra(o, arts); }).join(''));
    escritas += parte.length;
    var e = win.document.getElementById('estado'); if (e) e.textContent = 'Armando el informe: ' + escritas + ' de ' + todo.ops.length + '…';
    await new Promise(function(res) { setTimeout(res, 0); });
  }
  var enPagina = cont.querySelectorAll('.op').length;
  var okTotal = enPagina === R.total && escritas === R.total;
  var est = win.document.getElementById('estado');
  if (est) est.innerHTML = okTotal ? '<span class="ok">✓ Informe completo y verificado: ' + enPagina + ' operación(es), ' + lineasTot + ' línea(s).</span>'
                                   : '<span class="anulada">✗ El informe no coincide con el total (' + enPagina + ' de ' + R.total + '). Volvé a generarlo.</span>';
  win.document.getElementById('pie').innerHTML = (tipo === 'entregas'
    ? 'Valor de referencia: último precio de compra (o del stock inicial) registrado con fecha igual o anterior a cada entrega. Es una referencia, no un costo contable, y no se suma al gasto por compras. '
    : 'Gasto por compras: importes registrados en los ingresos del período. No incluye el stock inicial. ') +
    'Operaciones: ' + enPagina + ' de ' + R.total + (okTotal ? ' (verificado)' : '') + '. Generado por MediGestión el ' + fh + '.';
}

// ── Constancia de entrega imprimible (A4, para firma manuscrita) ───────
function stkImprimirConstancia(opId) {
  var o = stkOpHist(opId);
  if (!o) return;
  var win = window.open('', '_blank');
  if (!win) { stkAviso('El navegador bloqueó la ventana. Permití ventanas emergentes para este sitio.', 'err'); return; }
  var arts = stkArtMap(), afi = stkEsAfiTipo(o.tipoDestinatario);
  var ahora = new Date(), fh = String(ahora.getDate()).padStart(2, '0') + '/' + String(ahora.getMonth() + 1).padStart(2, '0') + '/' + ahora.getFullYear();
  var css = STK_CSS_A4 + '\n.c-k{font-size:8.5pt;color:#555;text-transform:uppercase;letter-spacing:.3px}.c-v{font-size:11pt;margin-bottom:6px}' +
    '.grid2{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;margin:8px 0}.firmas{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:46px}' +
    '.firma{border-top:1px solid #333;padding-top:4px;font-size:9pt;text-align:center}.linea{border-bottom:1px solid #999;height:22px;margin:10px 0 2px}' +
    '.marca{border:3px solid #c0392b;color:#c0392b;font-weight:bold;font-size:18pt;text-align:center;padding:6px;margin:10px 0}';
  var h = '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Constancia de entrega ' + stkEscH(o.id) + '</title><style>' + css + '</style></head><body>' +
    '<div class="barra"><button onclick="window.print()">🖨 Imprimir o guardar como PDF</button><span>Imprimir no modifica la entrega ni el stock.</span></div><div class="hoja">' +
    stkEncabezadoA4('Constancia de entrega de materiales', 'Obra Social del Personal de la Industria del Vidrio') +
    (o.activa ? '' : '<div class="marca">OPERACIÓN ANULADA — SIN VALIDEZ</div>') +
    '<div class="grid2">' +
      '<div><div class="c-k">N.º de operación</div><div class="c-v">' + stkEscH(o.id) + '</div></div>' +
      '<div><div class="c-k">Fecha de entrega</div><div class="c-v">' + stkFmtFecha(o.fecha) + '</div></div>' +
      (afi ? '<div><div class="c-k">Afiliado/a</div><div class="c-v"><b>' + stkEscH(o.destinatario) + '</b></div></div><div><div class="c-k">DNI</div><div class="c-v">' + stkEscH(o.dni) + '</div></div>'
           : '<div style="grid-column:1/-1"><div class="c-k">Destinatario</div><div class="c-v"><b>' + stkEscH(o.destinatario) + '</b> · ' + stkEscH(stkL('tiposDestinatario', o.tipoDestinatario)) + '</div></div>') +
      '<div><div class="c-k">Seccional</div><div class="c-v">' + stkEscH(o.seccional ? stkNombreUbic(o.seccional) : '—') + '</div></div>' +
      '<div><div class="c-k">Entregado desde</div><div class="c-v">' + stkEscH(stkNombreUbic(o.origen)) + '</div></div>' +
      '<div style="grid-column:1/-1"><div class="c-k">Retira / medio de envío</div><div class="c-v">' + stkEscH(stkL('retira', o.retira) + (o.retiraDetalle ? ' — ' + o.retiraDetalle : '')) + '</div></div>' +
    '</div>' +
    '<h2>Materiales entregados</h2><table><thead><tr><th style="width:55%">Artículo</th><th class="num">Cantidad</th><th>Unidad</th></tr></thead><tbody>' +
    o.lineas.filter(function(l) { return o.activa ? l.estado !== 'ANULADO' : true; }).map(function(l) {
      var a = arts[l.articuloId] || {}, ex = stkExtraTexto(l.datosExtra);
      return '<tr><td>' + stkEscH(a.Nombre || l.articuloId) + (ex ? '<div class="dim">' + stkEscH(ex) + '</div>' : '') + '</td><td class="num">' + l.cantidad.toLocaleString('es-AR') + '</td><td>' + stkEscH(a.Unidad || '') + '</td></tr>';
    }).join('') + '</tbody></table>' +
    (o.observacion ? '<div style="margin-top:8px"><span class="c-k">Observaciones:</span> ' + stkEscH(o.observacion) + '</div>' : '') +
    '<p style="margin-top:16px;font-size:10.5pt;line-height:1.5">' + (afi
      ? 'Recibí de OSPIV los materiales detallados precedentemente, en las cantidades indicadas y en conformidad.'
      : 'Se reciben de OSPIV los materiales detallados precedentemente, en las cantidades indicadas y en conformidad.') + '</p>' +
    '<div class="grid2" style="margin-top:14px"><div><div class="c-k">Aclaración</div><div class="linea"></div></div><div><div class="c-k">DNI</div><div class="linea"></div></div>' +
    '<div><div class="c-k">Carácter (afiliado/a, familiar, delegado/a, seccional…)</div><div class="linea"></div></div><div><div class="c-k">Lugar y fecha de recepción</div><div class="linea"></div></div></div>' +
    '<div class="firmas"><div class="firma">Firma de quien recibe</div><div class="firma">Firma y sello OSPIV</div></div>' +
    '<div class="pie">Documento generado por MediGestión el ' + fh + ' a partir de la entrega registrada. Imprimirlo no modifica el registro ni el stock.</div>' +
    '</div></body></html>';
  win.document.open(); win.document.write(h); win.document.close();
}
