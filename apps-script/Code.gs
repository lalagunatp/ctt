// ============================================================
// CTT LA LAGUNA — Apps Script (Web App API)
// Pegar en: BASE LA LAGUNA 2026 → Extensiones → Apps Script
// Desplegar como Web App (acceso: cualquiera)
// ============================================================

const SPREADSHEET_ID = '1Ph5T-m-Lkbdw1LBq-9wIIMW6C8bljOG1t5GfZQhNZ2o';

// ---- NOMBRES DE HOJAS (ajustar si difieren) ----
const HOJA_CTT        = 'BD CTT';           // Hoja con los casos CTT
const HOJA_OS         = 'OS POR INSTALAR';  // Hoja con OS + cuadrilla/técnico
const HOJA_ATENCION   = 'ATENCION ORDENES'; // Atención de órdenes
const HOJA_SEGUIMIENTO = 'SEGUIMIENTO';     // Nueva hoja de seguimiento

// ---- COLUMNAS FIJAS DE BD CTT ----
const COL_CUENTA = 6;                       // Columna G = número de cuenta

// ================================================================
// doGet — Sirve datos al dashboard
// ================================================================
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'dashboard';
  let result;

  try {
    switch (action) {
      case 'dashboard':
        result = getDashboardData();
        break;
      case 'seguimiento':
        result = getSeguimiento();
        break;
      case 'buscar':
        const os = e.parameter.os || '';
        result = buscarOS(os);
        break;
      default:
        result = { error: 'Acción no válida' };
    }
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================================================================
// doPost — Recibe registros de seguimiento desde el dashboard
// ================================================================
function doPost(e) {
  let result;
  try {
    const data = JSON.parse(e.postData.contents);
    result = registrarSeguimiento(data);
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
  const iFecha     = cttHeaders.indexOf('FECHA');

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
    const fecha = row[iFecha] ? Utilities.formatDate(new Date(row[iFecha]), 'America/Mexico_City', 'yyyy-MM-dd') : '';

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
      n2: n2,
      n3: String(row[iN3] || ''),
      rp: row[iRepetido] === true ? 1 : 0,
      cl: cluster,
      dt: fecha,
      tec: match ? match.tec : '',
      prov: match ? match.prov : '',
      ef: match ? match.ef : '',
      mot: mot,
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
  // periodo (7/15/30/60 días) y contar cuentas únicas.
  // [fecha, cuenta, estatus, OS, cluster, falla N2, técnico, proveedor,
  //  estatus BASE, motivo, con seguimiento (0/1)]
  stats.casos = records.map(r => [
    r.dt, r.ct, r.e, r.os, r.cl, r.n2, r.tec, r.prov, r.ef, r.mot, r.segN ? 1 : 0
  ]);

  return stats;
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
