// ============================================================
// CTT LA LAGUNA — Apps Script (Web App API)
// Pegar en: BASE LA LAGUNA 2026 → Extensiones → Apps Script
// Desplegar como Web App (acceso: cualquiera). Los datos solo salen
// con un token de sesión: número de empleado + PIN de PLANTILLA.
// ============================================================

const SPREADSHEET_ID = '1Ph5T-m-Lkbdw1LBq-9wIIMW6C8bljOG1t5GfZQhNZ2o';

// ---- NOMBRES DE HOJAS (ajustar si difieren) ----
const HOJA_CTT        = 'BD CTT';           // Hoja con los casos CTT
const HOJA_OS         = 'OS POR INSTALAR';  // Hoja con OS + cuadrilla/técnico
const HOJA_ATENCION   = 'ATENCION ORDENES'; // Atención de órdenes
const HOJA_SEGUIMIENTO = 'SEGUIMIENTO';     // Nueva hoja de seguimiento
const HOJA_CIERRE     = 'CIERRE OS';        // Cierre de OS: falla, causa, solución, potencias

// ---- COLUMNAS FIJAS DE BD CTT ----
const COL_CUENTA = 6;                       // Columna G = número de cuenta
const COL_FECHA  = 5;                       // Columna F = FECHA/HORA del reporte

// ---- COLUMNAS FIJAS DE CIERRE OS (fila 1 = encabezados) ----
const COL_CIERRE_OS = 2;                    // Columna C = OS
// Columnas AM..AR: Falla, Causa, Solución, Potencia inicial,
// Potencia final, Potencia inicial ticket
const COLS_CIERRE = [38, 39, 40, 41, 42, 43];

// Convierte el valor de FECHA/HORA a ['yyyy-MM-dd', 'HH:mm'].
// Acepta fecha real de la hoja o texto tipo 24/07/2026 18:34 o 2026-07-24 18:34.
function fechaHora_(v) {
  let d = null;
  if (v instanceof Date) {
    d = v;
  } else if (v) {
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?/);
    if (m) d = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
    else {
      m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
      if (m) d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
      else { const p = new Date(s); if (!isNaN(p.getTime())) d = p; }
    }
  }
  if (!d || isNaN(d.getTime())) return ['', ''];
  return [
    Utilities.formatDate(d, 'America/Mexico_City', 'yyyy-MM-dd'),
    Utilities.formatDate(d, 'America/Mexico_City', 'HH:mm')
  ];
}

// ================================================================
// ACCESO — número de empleado + PIN de la pestaña PLANTILLA
// (el mismo PIN que se usa en informeseguimiento)
// ================================================================
const GID_PLANTILLA = 913334386;
const COL_PL_NUMERO = 3;                    // Columna D = número de empleado
const COL_PL_NOMBRE = 4;                    // Columna E = nombre
const COL_PL_PUESTO = 5;                    // Columna F = puesto
const COL_PL_PIN    = 27;                   // Columna AB = PIN

// Solo estos puestos pueden entrar al dashboard
const PUESTOS_ACCESO = [
  'GERENTE DE SERVICIO',
  'ESPECIALISTA DE CAMPAÑAS DE LEALTAD',
  'ESPECIALISTA DE ATENCION A CLIENTES',
  'GERENTE DE OPERACIONES',
  'SUPERVISOR DE PLANTA INTERNA',
  'DIRECTOR DISTRITAL'
];

const SESION_SEG  = 21600;                  // la sesión dura 6 horas
const MAX_FALLOS  = 5;                      // intentos de PIN antes de bloquear
const BLOQUEO_SEG = 900;                    // 15 minutos de bloqueo

function normalizar_(s) {
  return String(s || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

function limpiarNum_(v) {
  let s = String(v === null || v === undefined ? '' : v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  return s.toUpperCase();
}

function puestoPermitido_(puesto) {
  const p = normalizar_(puesto);
  if (!p) return false;
  return PUESTOS_ACCESO.some(t => p.indexOf(normalizar_(t)) >= 0);
}

function login_(numero, pin) {
  const num = limpiarNum_(numero);
  const pinLimpio = String(pin || '').trim();
  if (!num) return { ok: false, error: 'Captura tu número de empleado.' };
  if (!pinLimpio) return { ok: false, error: 'Captura tu PIN.' };

  const cache = CacheService.getScriptCache();
  const claveFallos = 'fallos_' + num;
  const fallos = Number(cache.get(claveFallos) || 0);
  if (fallos >= MAX_FALLOS) {
    return { ok: false, error: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' };
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const hoja = ss.getSheets().find(h => h.getSheetId() === GID_PLANTILLA);
  if (!hoja) return { ok: false, error: 'No se encontró la pestaña PLANTILLA.' };

  const datos = hoja.getDataRange().getValues();
  let persona = null;
  for (let i = 1; i < datos.length; i++) {
    if (limpiarNum_(datos[i][COL_PL_NUMERO]) === num) {
      persona = {
        numero: num,
        nombre: String(datos[i][COL_PL_NOMBRE] || '').trim(),
        puesto: String(datos[i][COL_PL_PUESTO] || '').trim(),
        pin:    String(datos[i][COL_PL_PIN] || '').trim()
      };
      break;
    }
  }

  if (!persona || !persona.pin || persona.pin !== pinLimpio) {
    cache.put(claveFallos, String(fallos + 1), BLOQUEO_SEG);
    return { ok: false, error: 'Número o PIN incorrectos.' };
  }
  cache.remove(claveFallos);

  if (!puestoPermitido_(persona.puesto)) {
    return { ok: false, error: 'Tu puesto (' + (persona.puesto || 'sin puesto') + ') no tiene acceso a este dashboard.' };
  }

  const perfil = { numero: persona.numero, nombre: persona.nombre, puesto: persona.puesto };
  const token = Utilities.getUuid();
  cache.put('tok_' + token, JSON.stringify(perfil), SESION_SEG);
  return { ok: true, token: token, perfil: perfil };
}

// Devuelve el perfil de la sesión, o null si el token no sirve o ya expiró
function perfilDe_(token) {
  if (!token) return null;
  const datos = CacheService.getScriptCache().get('tok_' + token);
  return datos ? JSON.parse(datos) : null;
}

const SIN_SESION = { error: 'Tu sesión expiró. Vuelve a entrar.', expirado: true };

// ================================================================
// doGet — Sirve datos al dashboard (siempre con token de sesión)
// ================================================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = p.action || 'dashboard';
  let result;

  try {
    const perfil = perfilDe_(p.token);
    if (!perfil) {
      result = SIN_SESION;
    } else {
      switch (action) {
        case 'validar':
          result = { ok: true, perfil: perfil };
          break;
        case 'dashboard':
          result = getDashboardData();
          break;
        case 'seguimiento':
          result = getSeguimiento();
          break;
        case 'buscar':
          result = buscarOS(p.os || '');
          break;
        default:
          result = { error: 'Acción no válida' };
      }
    }
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================================================================
// doPost — Login y registros de seguimiento desde el dashboard
// (el cuerpo es JSON; el PIN va aquí y no en la URL)
// ================================================================
function doPost(e) {
  let result;
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'login') {
      result = login_(data.numero, data.pin);
    } else if (!perfilDe_(data.token)) {
      result = SIN_SESION;
    } else {
      result = registrarSeguimiento(data);
    }
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================================================================
// getDashboardData — Lee CTT + OS y hace el cruce
// ================================================================
function getDashboardData() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // 1. Leer CTT
  const cttSheet = ss.getSheetByName(HOJA_CTT);
  if (!cttSheet) return { error: 'No se encontró la hoja ' + HOJA_CTT };
  const cttData = cttSheet.getDataRange().getValues();
  const cttHeaders = cttData[0];
  const cttRows = cttData.slice(1);

  // 2. Leer OS (última asignación por OS)
  const osSheet = ss.getSheetByName(HOJA_OS);
  const osData = osSheet ? osSheet.getDataRange().getValues() : [];
  const osHeaders = osData.length > 0 ? osData[0] : [];
  const osRows = osData.slice(1);

  // Índices CTT
  const iOS_ctt    = cttHeaders.indexOf('OS');
  const iEstatus   = cttHeaders.indexOf('ESTATUS');
  const iFolio     = cttHeaders.indexOf('FOLIO');
  const iN1        = cttHeaders.indexOf('N1');
  const iN2        = cttHeaders.indexOf('N2');
  const iN3        = cttHeaders.indexOf('N3');
  const iRepetido  = cttHeaders.indexOf('REPETIDO');
  const iOLT       = cttHeaders.indexOf('OLT');
  const iCluster   = cttHeaders.indexOf('CLUSTER');

  // Índices OS
  const iOS_os     = osHeaders.indexOf('OS');
  const iTecnico   = osHeaders.indexOf('NOMBRE TECNICO');
  const iProveedor = osHeaders.indexOf('PROVEEDOR');
  const iEstatusFinal = osHeaders.indexOf('ESTATUS FINAL');
  const iEstadoFinal  = osHeaders.indexOf('ESTADO FINAL');
  const iMotDesasig   = osHeaders.indexOf('MOTIVO DESASIGNACION');
  const iMotDetencion = osHeaders.indexOf('MOTIVO DETENCION');
  const iMotCancel    = osHeaders.indexOf('MOTIVO CANCELACION');
  const iFechaAsig    = osHeaders.indexOf('FECHA ASIGNACION');
  const iFechaCompl   = osHeaders.indexOf('FECHA COMPLETA');

  // Construir mapa OS → última asignación (última por fecha)
  const osMap = {};
  for (const row of osRows) {
    const os = String(row[iOS_os] || '').trim();
    if (!os) continue;
    const fechaAsig = row[iFechaAsig];
    // Guardar la más reciente
    if (!osMap[os] || (fechaAsig && fechaAsig > osMap[os]._fecha)) {
      osMap[os] = {
        tec: String(row[iTecnico] || ''),
        prov: String(row[iProveedor] || ''),
        ef: String(row[iEstatusFinal] || ''),
        motD: String(row[iMotDesasig] || ''),
        motDet: String(row[iMotDetencion] || ''),
        motC: String(row[iMotCancel] || ''),
        fa: fechaAsig ? Utilities.formatDate(new Date(fechaAsig), 'America/Mexico_City', 'yyyy-MM-dd HH:mm') : '',
        fc: row[iFechaCompl] ? Utilities.formatDate(new Date(row[iFechaCompl]), 'America/Mexico_City', 'yyyy-MM-dd HH:mm') : '',
        _fecha: fechaAsig
      };
    }
  }

  // 3. Leer SEGUIMIENTO
  const segSheet = ss.getSheetByName(HOJA_SEGUIMIENTO);
  const segMap = {};
  if (segSheet && segSheet.getLastRow() > 1) {
    const segData = segSheet.getDataRange().getValues();
    const segHeaders = segData[0];
    const iOSseg = segHeaders.indexOf('OS');
    for (let i = segData.length - 1; i >= 1; i--) {
      const os = String(segData[i][iOSseg] || '').trim();
      if (os && !segMap[os]) {
        segMap[os] = {
          resultado: String(segData[i][segHeaders.indexOf('RESULTADO')] || ''),
          comentario: String(segData[i][segHeaders.indexOf('COMENTARIO')] || ''),
          fecha_visita: String(segData[i][segHeaders.indexOf('FECHA_VISITA')] || ''),
          quien: String(segData[i][segHeaders.indexOf('QUIEN_REPORTA')] || ''),
          registros: 0
        };
      }
      if (os && segMap[os]) segMap[os].registros++;
    }
  }

  // 4. Cruce y construcción de records
  const records = [];
  const stats = {
    total: 0, con_os: 0, cruzadas: 0, terminadas: 0,
    canceladas_base: 0, total_abiertos: 0, con_seguimiento: 0,
    estatus_ctt: {}, clusters: {}, fallas: {}, motivos: {},
    proveedores: {}, tecnicos: {}, por_fecha: {}
  };

  const abiertos = [];
  const canceladas = [];

  for (const row of cttRows) {
    const os = String(row[iOS_ctt] || '').trim();
    const estatus = String(row[iEstatus] || '');
    const cluster = String(row[iCluster] || '');
    const n2 = String(row[iN2] || '');
    const cuenta = String(row[COL_CUENTA] || '').trim();
    const fh = fechaHora_(row[COL_FECHA]);
    const fecha = fh[0];
    const hora = fh[1];

    const match = os ? osMap[os] : null;
    const seg = os ? segMap[os] : null;

    let mot = 'Sin cruce';
    if (match) {
      if (match.motC && match.motC !== '' && match.motC !== 'SIN INFO') mot = 'Canc: ' + match.motC;
      else if (match.motDet && match.motDet !== '' && match.motDet !== 'SIN INFO') mot = 'Det: ' + match.motDet;
      else if (match.motD && match.motD !== '' && match.motD !== 'SIN INFO') mot = 'Desasig: ' + match.motD;
      else if (match.ef) mot = match.ef;
    }

    const rec = {
      f: String(row[iFolio] || ''),
      e: estatus,
      os: os,
      ct: cuenta,
      n1: String(row[iN1] || ''),
      n2: n2,
      n3: String(row[iN3] || ''),
      rp: row[iRepetido] === true ? 1 : 0,
      cl: cluster,
      dt: fecha,
      hr: hora,
      tec: match ? match.tec : '',
      prov: match ? match.prov : '',
      ef: match ? match.ef : '',
      mot: mot,
      fa: match ? match.fa : '',
      fc: match ? match.fc : '',
      seg: seg ? seg.resultado : '',
      segN: seg ? seg.registros : 0,
    };

    records.push(rec);
    stats.total++;
    if (os) stats.con_os++;
    if (match && match.ef) stats.cruzadas++;
    if (match && match.ef === 'Terminada') stats.terminadas++;
    if (match && match.ef === 'Cancelada') stats.canceladas_base++;
    if (seg) stats.con_seguimiento++;

    // Abiertos
    if (!['Cerrado','Cancelado'].includes(estatus)) {
      stats.total_abiertos++;
      abiertos.push(rec);
    }
    if (match && match.ef === 'Cancelada') canceladas.push(rec);

    // Aggregations
    stats.estatus_ctt[estatus] = (stats.estatus_ctt[estatus] || 0) + 1;
    if (cluster) stats.clusters[cluster] = (stats.clusters[cluster] || 0) + 1;
    if (n2) stats.fallas[n2] = (stats.fallas[n2] || 0) + 1;
    stats.motivos[mot] = (stats.motivos[mot] || 0) + 1;
    if (match && match.prov) stats.proveedores[match.prov] = (stats.proveedores[match.prov] || 0) + 1;
    if (match && match.tec) stats.tecnicos[match.tec] = (stats.tecnicos[match.tec] || 0) + 1;
    if (fecha) stats.por_fecha[fecha] = (stats.por_fecha[fecha] || 0) + 1;
  }

  // Sort & trim tecnicos to top 20
  const sortedTec = Object.entries(stats.tecnicos).sort((a,b) => b[1]-a[1]).slice(0,20);
  stats.tecnicos = Object.fromEntries(sortedTec);

  stats.abiertos = abiertos;
  stats.canceladas_detail = canceladas;

  // Una fila compacta por caso: el dashboard la usa para filtrar por
  // periodo (7/15/30/60 días), contar cuentas únicas y el detalle por cuenta.
  // [fecha, cuenta, estatus, OS, cluster, falla N2, técnico, proveedor,
  //  estatus BASE, motivo, con seguimiento (0/1),
  //  folio, N1, N3, fecha asignación OS, fecha completada OS, hora del reporte]
  stats.casos = records.map(r => [
    r.dt, r.ct, r.e, r.os, r.cl, r.n2, r.tec, r.prov, r.ef, r.mot, r.segN ? 1 : 0,
    r.f, r.n1, r.n3, r.fa, r.fc, r.hr
  ]);

  // 5. Cierres de OS (solo las OS que aparecen en BD CTT).
  // { OS: [[falla, causa, solución, pot. inicial, pot. final, pot. inicial ticket], ...] }
  // Una entrada por cada fila de CIERRE OS con esa OS, en el orden de la hoja.
  stats.cierres = getCierres_(ss, new Set(records.map(r => r.os).filter(Boolean)));

  return stats;
}

// ================================================================
// getCierres_ — Lee CIERRE OS y agrupa por OS (columna C)
// ================================================================
function getCierres_(ss, osSet) {
  const sheet = ss.getSheetByName(HOJA_CIERRE);
  const cierres = {};
  if (!sheet || sheet.getLastRow() < 2) return cierres;
  // Valores tal como se ven en la hoja (respeta el formato de las potencias)
  const ancho = Math.min(Math.max(...COLS_CIERRE) + 1, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, ancho).getDisplayValues();
  for (const row of data) {
    const os = String(row[COL_CIERRE_OS] || '').trim();
    if (!os || !osSet.has(os)) continue;
    (cierres[os] = cierres[os] || []).push(COLS_CIERRE.map(i => String(row[i] || '').trim()));
  }
  return cierres;
}

// ================================================================
// getSeguimiento — Lee todos los registros de seguimiento
// ================================================================
function getSeguimiento() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(HOJA_SEGUIMIENTO);
  if (!sheet || sheet.getLastRow() < 2) return { rows: [] };

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const rows = data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] instanceof Date
        ? Utilities.formatDate(row[i], 'America/Mexico_City', 'yyyy-MM-dd HH:mm')
        : String(row[i] || '');
    });
    return obj;
  });

  return { rows: rows.reverse() }; // más recientes primero
}

// ================================================================
// registrarSeguimiento — Agrega un registro de seguimiento
// ================================================================
function registrarSeguimiento(data) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(HOJA_SEGUIMIENTO);

  // Crear hoja si no existe
  if (!sheet) {
    sheet = ss.insertSheet(HOJA_SEGUIMIENTO);
    sheet.appendRow([
      'MARCA_TIEMPO', 'OS', 'CUENTA', 'CLUSTER', 'RESULTADO',
      'FECHA_VISITA', 'HORARIO', 'COMENTARIO',
      'QUIEN_REPORTA', 'LIDER', 'COACH'
    ]);
    // Formato header
    const headerRange = sheet.getRange(1, 1, 1, 11);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#1a1d27');
    headerRange.setFontColor('#e8eaf0');
    sheet.setFrozenRows(1);
  }

  const timestamp = Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyyy-MM-dd HH:mm:ss');

  sheet.appendRow([
    timestamp,
    data.os || '',
    data.cuenta || '',
    data.cluster || '',
    data.resultado || '',
    data.fecha_visita || '',
    data.horario || '',
    data.comentario || '',
    data.quien_reporta || '',
    data.lider || '',
    data.coach || ''
  ]);

  return { ok: true, timestamp: timestamp };
}

// ================================================================
// buscarOS — Busca una OS específica en CTT + OS + Seguimiento
// ================================================================
function buscarOS(osQuery) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const result = { ctt: [], os: [], seguimiento: [] };

  // CTT
  const cttSheet = ss.getSheetByName(HOJA_CTT);
  if (cttSheet) {
    const data = cttSheet.getDataRange().getValues();
    const headers = data[0];
    const iOS = headers.indexOf('OS');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][iOS]).includes(osQuery)) {
        const obj = {};
        headers.forEach((h, j) => obj[h] = String(data[i][j] || ''));
        result.ctt.push(obj);
      }
    }
  }

  // OS
  const osSheet = ss.getSheetByName(HOJA_OS);
  if (osSheet) {
    const data = osSheet.getDataRange().getValues();
    const headers = data[0];
    const iOS = headers.indexOf('OS');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][iOS]).includes(osQuery)) {
        const obj = {};
        headers.forEach((h, j) => {
          obj[h] = data[i][j] instanceof Date
            ? Utilities.formatDate(data[i][j], 'America/Mexico_City', 'yyyy-MM-dd HH:mm')
            : String(data[i][j] || '');
        });
        result.os.push(obj);
      }
    }
  }

  // Seguimiento
  const segSheet = ss.getSheetByName(HOJA_SEGUIMIENTO);
  if (segSheet && segSheet.getLastRow() > 1) {
    const data = segSheet.getDataRange().getValues();
    const headers = data[0];
    const iOS = headers.indexOf('OS');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][iOS]).includes(osQuery)) {
        const obj = {};
        headers.forEach((h, j) => {
          obj[h] = data[i][j] instanceof Date
            ? Utilities.formatDate(data[i][j], 'America/Mexico_City', 'yyyy-MM-dd HH:mm')
            : String(data[i][j] || '');
        });
        result.seguimiento.push(obj);
      }
    }
  }

  return result;
}

// ================================================================
// crearHojaSeguimiento — Ejecutar una vez para crear la hoja
// ================================================================
function crearHojaSeguimiento() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(HOJA_SEGUIMIENTO);
  if (sheet) {
    Logger.log('La hoja SEGUIMIENTO ya existe');
    return;
  }
  sheet = ss.insertSheet(HOJA_SEGUIMIENTO);
  sheet.appendRow([
    'MARCA_TIEMPO', 'OS', 'CUENTA', 'CLUSTER', 'RESULTADO',
    'FECHA_VISITA', 'HORARIO', 'COMENTARIO',
    'QUIEN_REPORTA', 'LIDER', 'COACH'
  ]);
  const headerRange = sheet.getRange(1, 1, 1, 11);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#1a1d27');
  headerRange.setFontColor('#e8eaf0');
  sheet.setFrozenRows(1);
  Logger.log('Hoja SEGUIMIENTO creada correctamente');
}
