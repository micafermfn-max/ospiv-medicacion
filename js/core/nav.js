const TITLES = {panel:'Panel de Control',nuevo:'Nuevo Pedido',cotizar:'Cotizar Pedido',
  pedidos:'Pedidos',afiliados:'Afiliados',insulinas:'Control de Insulinas',
  'seccionales-admin':'Gestión de Seccionales',
  pronadia:'Planilla Pronadia',droguerias:'Análisis Droguerías',productos:'Productos',sheets:'Google Sheets'};

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
           productos:renderProductos,cotizar:initCotizar,nuevo:initNuevo,sheets:renderSheets};
  if(m[p]) m[p]();
}
