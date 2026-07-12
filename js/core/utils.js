const today = () => new Date().toISOString().split('T')[0];

// Normaliza cualquier formato de fecha a yyyy-MM-dd
function normFecha(f) {
  if (!f) return '';
  const s = String(f);
  if (s.includes('T')) return s.substring(0, 10);           // ISO: 2026-05-15T03:00:00.000Z
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0'); // dd/MM/yyyy
  return s.length > 10 ? s.substring(0, 10) : s;            // ya es yyyy-MM-dd
}
const diffDays = d => d ? Math.round((new Date(d)-new Date(today()))/86400000) : null;
const fmt = n => new Intl.NumberFormat('es-AR').format(Math.round(n||0));
const fmtD = s => { if(!s)return'—'; const[y,m,d]=s.split('-'); return`${d}/${m}/${y}`; };

function stockBadge(dias){
  if(dias===null) return '<span class="b bgr">⚪ Sin datos</span>';
  if(dias<0)  return '<span class="b br">🔴 Vencido</span>';
  if(dias<15) return `<span class="b bo">🟡 ${dias}d</span>`;
  return `<span class="b bg">🟢 ${dias}d</span>`;
}
function estadoBadge(e){
  if(e==='Autorizado') return '<span class="b bg">✓ Autorizado</span>';
  if(e==='Cotizando')  return '<span class="b bo">⏳ Cotizando</span>';
  if(e==='Entregado')  return '<span class="b bb">📦 Entregado</span>';
  return `<span class="b bgr">${e||'—'}</span>`;
}
function diasBadge(n){
  if(n===null||n==='') return '—';
  const v=parseInt(n);
  const cl = v>14?'br':v>7?'bo':'bg';
  return `<span class="b ${cl}">${v}d</span>`;
}

function nextId(fecha){
  if(!fecha) return '—';
  const d=new Date(fecha);
  const yy=String(d.getFullYear()).slice(2);
  const mm=String(d.getMonth()+1).padStart(2,'0');
  const pref=yy+mm;
  const cnt=DB.pedidos.filter(p=>p.id&&p.id.startsWith(pref)).length;
  return `${pref}-${String(cnt+1).padStart(3,'0')}`;
}

function toast(msg,type='ok'){
  const c=document.getElementById('toast-c');
  const t=document.createElement('div');
  t.className=`toast ${type}`;t.textContent=msg;c.appendChild(t);
  setTimeout(()=>t.remove(),3200);
}
const closeMo = id => document.getElementById(id).classList.remove('open');

// ══════════════════════════════════════════════════════════════
// NAV
// ══════════════════════════════════════════════════════════════
