let DB = {};
function loadDB(){
  try {
    const s = localStorage.getItem('medi_db_v2');
    DB = s ? JSON.parse(s) : JSON.parse(JSON.stringify(SEED));
    // Ensure all fields exist
    DB.droguerias    = DB.droguerias    || SEED.droguerias;
    DB.productos     = DB.productos     || SEED.productos;
    DB.pronadia      = DB.pronadia      || SEED.pronadia;
    DB.remesas_sec   = DB.remesas_sec   || [];
    DB.insumos_sec   = DB.insumos_sec   || [];
    DB.pacientes  = (DB.pacientes && DB.pacientes.length > 0) ? DB.pacientes : JSON.parse(JSON.stringify(SEED.pacientes));
    DB.pedidos.forEach(p => {
      if(!p.fecha_entrega) p.fecha_entrega='';
      if(!p.fecha_cierre)  p.fecha_cierre='';
    });
  } catch(e){ DB = JSON.parse(JSON.stringify(SEED)); }
}
function saveDB(){
  localStorage.setItem('medi_db_v2', JSON.stringify(DB));
  updateSyncStatus();
  // Auto-sync: debounced so rapid changes batch into one sync call
  clearTimeout(window._syncTimer);
  window._syncTimer = setTimeout(() => {
    const url = localStorage.getItem('medi_sheets_url');
    if (url) syncToSheets(true); // true = silent (no toast)
  }, 4000); // 4 seconds after last change
}

// ══════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════
