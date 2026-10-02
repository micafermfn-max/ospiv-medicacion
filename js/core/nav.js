const TITLES = {panel:'Panel de Control',nuevo:'Nuevo Pedido',cotizar:'Cotizar Pedido',
  pedidos:'Pedidos',afiliados:'Afiliados',insulinas:'Control de Insulinas',
  'seccionales-admin':'Gestión de Seccionales',
  pronadia:'Planilla Pronadia',droguerias:'Análisis Droguerías',productos:'Productos',sheets:'Google Sheets',
  stock:'Stock y Movimientos'};   // SEC-1a.2

let currentPage='panel';
let detailPedId=null;

function nav(p){
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(x=>x.classList.remove('active'));
  document.getElementById('page-'+p).classList.add('active');
  document.querySelector(`.ni[onclick="nav('${p}')"]`)?.classList.add('active');
  document.getElementById('tb-title').textContent=TITLES[p]||p;
  currentPage=p;
  renderPage(p);
}
function renderPage(p){
  const m={panel:renderPanel,pedidos:renderPedidos,afiliados:renderAfiliados,
           insulinas:renderInsulinas,'insumos-db':async function(){ await cargarDatosAdmin(); renderInsumos(); },'seccionales-admin':renderSeccionalesAdmin,pronadia:renderPronadia,droguerias:renderDroguerias,
           productos:renderProductos,cotizar:initCotizar,nuevo:initNuevo,sheets:renderSheets,
           // SEC-1a.2: si js/modules/stock.js no cargó, se avisa sin romper la navegación
           stock:function(){ if(typeof renderStkPage==='function') renderStkPage();
             else { const el=document.getElementById('page-stock'); if(el) el.innerHTML='<div class="empty">⚠ No se pudo cargar el módulo de Stock (js/modules/stock.js).</div>'; } }};
  if(m[p]) m[p]();
}
