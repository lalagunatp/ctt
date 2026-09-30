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
const HOJA_BASE_DATOS = 'BASE DE DATOS';    // Base de clientes: OS, nombre, cuenta, plan

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

// De esos, solo estos pueden subir archivos a CIERRE OS y BD CTT
const PUESTOS_CARGA = [
  'GERENTE DE SERVICIO',
  'GERENTE DE OPERACIONES'
];

// y estos, además de los de arriba, pueden subir solo CIERRE OS
const PUESTOS_CARGA_CIERRE = [
  'SUPERVISOR DE PLANTA INTERNA'
];

const SESION_SEG  = 21600;                 // la sesión dura 6 horas
const MAX_FALLOS  = 5;                      // intentos de PIN antes de bloquear
const BLOQUEO_SEG = 900;                    // 15 minutos de bloqueo

function normalizar_(s) {
  return String(s || '').trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function limpiarNum_(v) {
  let s = String(v === null || v === undefined ? '' : v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  return s.toUpperCase();
}

// Primera columna cuyo encabezado sea alguno de `nombres` (sin importar
// mayúsculas, acentos ni espacios de más). -1 si no está.
function colPorEncabezado_(headers, nombres) {
  const h = headers.map(normalizar_);
  for (const n of nombres) {
    const i = h.indexOf(normalizar_(n));
    if (i >= 0) return i;
  }
  return -1;
}

function puestoEn_(puesto, lista) {
  const p = normalizar_(puesto);
  if (!p) return false;
  return lista.some(t => p.indexOf(normalizar_(t)) >= 0);
}

function puestoPermitido_(puesto) {
  return puestoEn_(puesto, PUESTOS_ACCESO);
}

function puedeCargar_(perfil) {
  return !!perfil && puestoEn_(perfil.puesto, PUESTOS_CARGA);
}

function puedeCargarCierre_(perfil) {
  return puedeCargar_(perfil) || (!!perfil && puestoEn_(perfil.puesto, PUESTOS_CARGA_CIERRE));
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

  const perfil = {
    numero: persona.numero, nombre: persona.nombre, puesto: persona.puesto,
    carga: puestoEn_(persona.puesto, PUESTOS_CARGA),
    cargaCierre: puestoEn_(persona.puesto, PUESTOS_CARGA) || puestoEn_(persona.puesto, PUESTOS_CARGA_CIERRE)
  };
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
        case 'cliente':
          result = buscarCliente_(p.q || '');
          break;
        case 'planes':
          result = planesPorCuenta_();
          break;
        case 'ultimasCargas':
          result = ultimasCargas_();
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
    const perfil = data.action === 'login' ? null : perfilDe_(data.token);
    if (data.action === 'login') {
      result = login_(data.numero, data.pin);
    } else if (!perfil) {
      result = SIN_SESION;
    } else if (data.action === 'subirCierre' || data.action === 'subirCtt') {
      // verificación real del puesto: la página solo esconde la sección
      const permitido = data.action === 'subirCierre' ? puedeCargarCierre_(perfil) : puedeCargar_(perfil);
      if (!permitido) {
        result = { ok: false, error: 'Tu puesto no tiene permiso para subir este archivo.' };
      } else {
        const lock = LockService.getScriptLock();
        if (!lock.tryLock(30000)) {
          result = { ok: false, error: 'Otra persona está subiendo un archivo. Intenta en un minuto.' };
        } else {
          try {
            result = data.action === 'subirCierre'
              ? subirCierre_(perfil, data.filas)
              : subirCtt_(perfil, data.filas);
          } finally {
            lock.releaseLock();
          }
        }
      }
    } else {
      result = registrarSeguimiento(data, perfil);
    }
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================================================================
// SUBIR ARCHIVOS — CIERRE OS (reemplazo completo) y BD CTT (entra
// arriba y se borra lo viejo con la misma llave de la columna B)
// ================================================================
const COL_LLAVE_CTT = 1;                    // Columna B de BD CTT
const BLOQUE_ESCRITURA = 5000;              // renglones por setValues

// Deja todos los renglones del mismo ancho y quita los que vienen vacíos
function prepararFilas_(filas) {
  if (!Array.isArray(filas)) throw new Error('Los renglones no llegaron en un formato válido.');
  const limpias = filas
    .filter(f => Array.isArray(f) && f.some(v => String(v == null ? '' : v).trim() !== ''))
    .map(f => f.map(v => (v == null ? '' : String(v))));
  const ancho = limpias.reduce((m, f) => Math.max(m, f.length), 0);
  limpias.forEach(f => { while (f.length < ancho) f.push(''); });
  return { filas: limpias, ancho: ancho };
}

// Escribe desde la fila `desde` en bloques, para no toparse con los
// límites de tiempo con archivos grandes. Los textos se interpretan como
// si se pegaran a mano (fechas y números quedan como fechas y números).
function escribirFilas_(hoja, desde, filas, ancho) {
  for (let b = 0; b < filas.length; b += BLOQUE_ESCRITURA) {
    const trozo = filas.slice(b, b + BLOQUE_ESCRITURA);
    hoja.getRange(desde + b, 1, trozo.length, ancho).setValues(trozo);
  }
}

function asegurarColumnas_(hoja, ancho) {
  if (hoja.getMaxColumns() < ancho) {
    hoja.insertColumnsAfter(hoja.getMaxColumns(), ancho - hoja.getMaxColumns());
  }
}

function llaveCtt_(v) {
  return limpiarNum_(v).replace(/[^0-9A-Z]/g, '');
}

// CIERRE OS: se borra todo lo que hay debajo del encabezado y queda lo del archivo
function subirCierre_(perfil, filasIn) {
  const p = prepararFilas_(filasIn);
  if (!p.filas.length) return { ok: false, error: 'El archivo no trae renglones de datos.' };

  const hoja = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(HOJA_CIERRE);
  if (!hoja) return { ok: false, error: 'No se encontró la hoja ' + HOJA_CIERRE };

  asegurarColumnas_(hoja, p.ancho);
  const ultimaNecesaria = 1 + p.filas.length;
  if (hoja.getMaxRows() < ultimaNecesaria) {
    hoja.insertRowsAfter(hoja.getMaxRows(), ultimaNecesaria - hoja.getMaxRows());
  }

  const ultimaFila = hoja.getLastRow();
  if (ultimaFila > 1) {
    hoja.getRange(2, 1, ultimaFila - 1, Math.max(p.ancho, hoja.getLastColumn())).clearContent();
  }
  SpreadsheetApp.flush();

  escribirFilas_(hoja, 2, p.filas, p.ancho);
  registrarCarga_('cierre', perfil, p.filas.length);
  return { ok: true, filas: p.filas.length, antes: Math.max(0, ultimaFila - 1) };
}

// BD CTT: lo del archivo entra hasta arriba (debajo del encabezado) y luego
// se borran los renglones viejos con la misma llave (columna B). Lo que no
// venga en el archivo no se toca ni se reescribe.
function subirCtt_(perfil, filasIn) {
  const p = prepararFilas_(filasIn);
  if (!p.filas.length) return { ok: false, error: 'El archivo no trae renglones de datos.' };
  if (p.ancho <= COL_LLAVE_CTT) return { ok: false, error: 'El archivo trae ' + p.ancho + ' columna(s); la llave va en la columna B.' };

  const hoja = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(HOJA_CTT);
  if (!hoja) return { ok: false, error: 'No se encontró la hoja ' + HOJA_CTT };

  // 1) llaves del archivo; si una viene repetida en el mismo archivo se
  //    queda la primera (la de más arriba)
  const vistas = {};
  const nuevas = [];
  let repetidasArchivo = 0;
  for (const f of p.filas) {
    const k = llaveCtt_(f[COL_LLAVE_CTT]);
    if (k) {
      if (vistas[k]) { repetidasArchivo++; continue; }
      vistas[k] = true;
    }
    nuevas.push(f);
  }

  // 2) renglones viejos que traen una llave del archivo (base 1)
  const ultimaFila = hoja.getLastRow();
  const borrar = [];
  if (ultimaFila > 1) {
    const llaves = hoja.getRange(2, COL_LLAVE_CTT + 1, ultimaFila - 1, 1).getValues();
    for (let r = 0; r < llaves.length; r++) {
      const k = llaveCtt_(llaves[r][0]);
      if (k && vistas[k]) borrar.push(r + 2);
    }
  }

  // 3) primero entra lo nuevo (si algo falla después, no se perdió nada)
  asegurarColumnas_(hoja, p.ancho);
  if (hoja.getMaxRows() >= 2) hoja.insertRowsBefore(2, nuevas.length);
  else hoja.insertRowsAfter(1, nuevas.length);
  escribirFilas_(hoja, 2, nuevas, p.ancho);
  SpreadsheetApp.flush();

  // 4) luego se borra lo viejo, que ahora está `nuevas.length` renglones más
  //    abajo; de abajo hacia arriba y agrupando renglones contiguos
  const corr = nuevas.length;
  let i = borrar.length - 1;
  while (i >= 0) {
    let fin = borrar[i];
    let ini = fin;
    while (i > 0 && borrar[i - 1] === ini - 1) { i--; ini = borrar[i]; }
    hoja.deleteRows(ini + corr, fin - ini + 1);
    i--;
  }

  registrarCarga_('ctt', perfil, nuevas.length);
  return {
    ok: true,
    agregados: nuevas.length,
    eliminados: borrar.length,
    repetidasArchivo: repetidasArchivo,
    total: Math.max(0, ultimaFila - 1 - borrar.length) + nuevas.length
  };
}

function registrarCarga_(clave, perfil, filas) {
  PropertiesService.getScriptProperties().setProperty('carga_' + clave, JSON.stringify({
    fecha: Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyyy-MM-dd HH:mm'),
    nombre: perfil.nombre,
    puesto: perfil.puesto,
    filas: filas
  }));
}

function ultimasCargas_() {
  const props = PropertiesService.getScriptProperties();
  const leer = k => { const raw = props.getProperty('carga_' + k); return raw ? JSON.parse(raw) : null; };
  return { ok: true, cierre: leer('cierre'), ctt: leer('ctt') };
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

  // Índices CTT (por encabezado; la hoja ha usado ESTATUS o ESTADO)
  const iOS_ctt    = colPorEncabezado_(cttHeaders, ['OS']);
  const iEstatus   = colPorEncabezado_(cttHeaders, ['ESTATUS', 'ESTADO']);
  const iFolio     = colPorEncabezado_(cttHeaders, ['FOLIO']);
  const iN1        = colPorEncabezado_(cttHeaders, ['N1']);
  const iN2        = colPorEncabezado_(cttHeaders, ['N2']);
  const iN3        = colPorEncabezado_(cttHeaders, ['N3']);
  const iRepetido  = colPorEncabezado_(cttHeaders, ['REPETIDO']);
  const iCluster   = colPorEncabezado_(cttHeaders, ['CLUSTER']);

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

  // Columna N "TECNICO" = usuario del técnico (SLKE3LAGT0241, CRCE3LAGT0047…);
  // si un día cambia el encabezado, se busca por contenido
  let iUsuario = osHeaders.indexOf('TECNICO');
  const usuarioPorEncabezado = iUsuario >= 0;
  if (!usuarioPorEncabezado) iUsuario = colUsuarioTecnico_(osRows);

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
        usr: usuarioPorEncabezado ? String(row[iUsuario] || '').trim().toUpperCase()
          : usuarioTecnico_(iUsuario >= 0 ? row[iUsuario] : row[iTecnico]),
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
      usr: match ? match.usr : '',
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
  //  folio, N1, N3, fecha asignación OS, fecha completada OS, hora del reporte,
  //  usuario del técnico (col. TECNICO de OS POR INSTALAR)]
  stats.casos = records.map(r => [
    r.dt, r.ct, r.e, r.os, r.cl, r.n2, r.tec, r.prov, r.ef, r.mot, r.segN ? 1 : 0,
    r.f, r.n1, r.n3, r.fa, r.fc, r.hr, r.usr
  ]);

  // 5. Cierres de OS (solo las OS que aparecen en BD CTT).
  // { OS: [[falla, causa, solución, pot. inicial, pot. final, pot. inicial ticket], ...] }
  // Una entrada por cada fila de CIERRE OS con esa OS, en el orden de la hoja.
  stats.cierres = getCierres_(ss, new Set(records.map(r => r.os).filter(Boolean)));

  return stats;
}

// ================================================================
// Usuario del técnico (CRCE3LAGT0047 = Crece; SLKE3LAGT0241, SLC…, SOL…
// = Soluciónika). Normalmente viene en la columna "TECNICO"; esto es el
// respaldo por si cambia el encabezado: la columna con más códigos así.
// ================================================================
const PREFIJOS_USUARIO = ['CRC', 'SLK', 'SLC', 'SOL'];
const RE_USUARIO = new RegExp('(?:^|[^A-Z0-9])((?:' + PREFIJOS_USUARIO.join('|') + ')[A-Z0-9]*\\d[A-Z0-9]*)', 'i');

function usuarioTecnico_(v) {
  const m = String(v == null ? '' : v).toUpperCase().match(RE_USUARIO);
  return m ? m[1] : '';
}

function colUsuarioTecnico_(rows) {
  const muestra = rows.slice(-3000);          // lo más reciente basta
  const cuenta = {};
  for (const row of muestra) {
    for (let j = 0; j < row.length; j++) {
      if (usuarioTecnico_(row[j])) cuenta[j] = (cuenta[j] || 0) + 1;
    }
  }
  let mejor = -1, max = 0;
  for (const j in cuenta) if (cuenta[j] > max) { max = cuenta[j]; mejor = +j; }
  return mejor;
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

  // Cliente, plan y cluster al día (de las hojas de clientes). Lo capturado
  // se respeta, salvo un plan "No se especificó"; el cluster sale de BD CTT.
  const F = fuentesClientes_(ss, true);
  const memo = {};
  rows.forEach(obj => {
    const k = limpiarNum_(obj.OS) + '|' + limpiarNum_(obj.CUENTA);
    const info = memo[k] || (memo[k] = resolverCliente_(F, obj.OS, obj.CUENTA));
    if (!info.encontrado) return;
    if (!obj.CUENTA) obj.CUENTA = info.cuenta;
    if (!obj.CLIENTE) obj.CLIENTE = info.cliente;
    if (!planValido_(obj.PLAN) && info.plan) obj.PLAN = info.plan;
    if (info.cluster) obj.CLUSTER = info.cluster;
  });

  return { rows: rows.reverse() }; // más recientes primero
}

// ================================================================
// registrarSeguimiento — Agrega un registro de seguimiento
// ================================================================
// Columnas de SEGUIMIENTO. Se escribe por nombre de encabezado: si a la
// hoja le falta alguna (p. ej. CLIENTE, PLAN o PUESTO) se agrega al final.
// Las viejas LIDER y COACH se quedan en la hoja con lo ya capturado.
const COLS_SEGUIMIENTO = [
  'MARCA_TIEMPO', 'OS', 'CUENTA', 'CLIENTE', 'PLAN', 'CLUSTER', 'RESULTADO',
  'FECHA_VISITA', 'HORARIO', 'COMENTARIO', 'QUIEN_REPORTA', 'PUESTO'
];

function hojaSeguimiento_(ss) {
  let sheet = ss.getSheetByName(HOJA_SEGUIMIENTO);
  if (!sheet) {
    sheet = ss.insertSheet(HOJA_SEGUIMIENTO);
    sheet.appendRow(COLS_SEGUIMIENTO);
    const headerRange = sheet.getRange(1, 1, 1, COLS_SEGUIMIENTO.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#1a1d27');
    headerRange.setFontColor('#e8eaf0');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function encabezadosSeguimiento_(sheet) {
  const ancho = Math.max(sheet.getLastColumn(), 1);
  const encab = sheet.getRange(1, 1, 1, ancho).getValues()[0].map(h => String(h || '').trim());
  const faltan = COLS_SEGUIMIENTO.filter(c => encab.indexOf(c) < 0);
  if (faltan.length) {
    let desde = encab.length;
    while (desde > 0 && !encab[desde - 1]) desde--;   // tras el último encabezado con texto
    asegurarColumnas_(sheet, desde + faltan.length);
    sheet.getRange(1, desde + 1, 1, faltan.length).setValues([faltan]).setFontWeight('bold');
    encab.length = desde;
    encab.push(...faltan);
  }
  return encab;
}

function registrarSeguimiento(data, perfil) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = hojaSeguimiento_(ss);
  const encab = encabezadosSeguimiento_(sheet);

  const timestamp = Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyyy-MM-dd HH:mm:ss');
  const valores = {
    MARCA_TIEMPO: timestamp,
    OS: data.os || '',
    CUENTA: data.cuenta || '',
    CLIENTE: data.cliente || '',
    PLAN: data.plan || '',
    CLUSTER: data.cluster || '',
    RESULTADO: data.resultado || '',
    FECHA_VISITA: data.fecha_visita || '',
    HORARIO: data.horario || '',
    COMENTARIO: data.comentario || '',
    QUIEN_REPORTA: data.quien_reporta || '',
    PUESTO: data.puesto || (perfil ? perfil.puesto : '')
  };
  sheet.appendRow(encab.map(h => valores[h] !== undefined ? valores[h] : ''));

  return { ok: true, timestamp: timestamp };
}

// ================================================================
// Datos del cliente por OS o cuenta (panel y tabla de seguimiento)
//   Cliente: ATENCION ORDENES (E) → BASE DE DATOS (G)
//   Plan:    ATENCION ORDENES (N) → CIERRE OS (K) → BASE DE DATOS (P)
//            → BD CTT N1 (p. ej. "2 O MAS SERVICIOS"), saltando "No se especificó"
//   Cluster: BD CTT (CLUSTER). Cuenta de BD CTT = columna G.
// Los renglones de la OS pedida van antes que los de otras OS de la cuenta.
// ================================================================
const AT_CUENTA = 0, AT_OS = 2, AT_CLIENTE = 4, AT_PLAN = 13;   // ATENCION ORDENES: A, C, E, N
const BD_OS = 0, BD_CLIENTE = 6, BD_CUENTA = 14, BD_PLAN = 15;  // BASE DE DATOS: A, G, O, P
const CI_PLAN = 10;                                             // CIERRE OS: K (OS en C)
const MAX_RENGLONES_BUSQUEDA = 60;

function hojaPorNombre_(ss, nombre) {
  const n = normalizar_(nombre);
  return ss.getSheetByName(nombre) || ss.getSheets().find(h => normalizar_(h.getName()) === n) || null;
}

// Renglones donde alguna de las columnas `cols` (base 0) es exactamente `q`.
// Regresa [{fila, v: [valores como se ven, de A hasta `ancho`]}]
function renglonesCon_(hoja, cols, q, ancho) {
  if (!hoja || !q || hoja.getLastRow() < 2) return [];
  const ult = hoja.getLastRow();
  const maxCol = hoja.getMaxColumns();
  const filas = new Set();
  for (const c of cols) {
    if (c < 0 || c >= maxCol) continue;
    hoja.getRange(2, c + 1, ult - 1, 1).createTextFinder(q).matchEntireCell(true).findAll()
      .forEach(r => filas.add(r.getRow()));
  }
  const w = Math.min(ancho, maxCol);
  return [...filas].sort((a, b) => a - b).slice(0, MAX_RENGLONES_BUSQUEDA).map(f => {
    const v = hoja.getRange(f, 1, 1, w).getDisplayValues()[0].map(x => String(x || '').trim());
    while (v.length < ancho) v.push('');
    return { fila: f, v: v };
  });
}

function unirRenglones_(a, b) {
  const vistas = new Set(a.map(r => r.fila));
  return a.concat(b.filter(r => !vistas.has(r.fila)));
}

function planValido_(v) {
  const s = normalizar_(v).replace(/[^A-Z0-9]/g, '');
  // "No se especificó", "No especificado" y la variante escrita "espesifico"
  return !!s && !/NO(SE)?ESPE[CS]IFIC/.test(s);
}

// Una fuente por hoja; cada una sabe dar sus renglones por OS y por cuenta.
// todo = true lee las hojas completas una vez (para muchos registros);
// si no, busca cada valor con TextFinder (para una sola búsqueda).
function fuentesClientes_(ss, todo) {
  const ctt = ss.getSheetByName(HOJA_CTT);
  let iOS = -1, iCl = -1, iN1 = -1;
  if (ctt && ctt.getLastColumn() > 0) {
    const h = ctt.getRange(1, 1, 1, ctt.getLastColumn()).getValues()[0];
    iOS = colPorEncabezado_(h, ['OS']);
    iCl = colPorEncabezado_(h, ['CLUSTER']);
    iN1 = colPorEncabezado_(h, ['N1']);
  }
  const specs = {
    at:  { hoja: hojaPorNombre_(ss, HOJA_ATENCION), os: AT_OS, cta: AT_CUENTA, ancho: AT_PLAN + 1 },
    bd:  { hoja: hojaPorNombre_(ss, HOJA_BASE_DATOS), os: BD_OS, cta: BD_CUENTA, ancho: BD_PLAN + 1 },
    ci:  { hoja: ss.getSheetByName(HOJA_CIERRE), os: COL_CIERRE_OS, cta: -1, ancho: CI_PLAN + 1 },
    ctt: { hoja: ctt, os: iOS, cta: COL_CUENTA, cl: iCl, n1: iN1, ancho: Math.max(COL_CUENTA, iOS, iCl, iN1) + 1 }
  };
  const F = {};
  for (const k in specs) F[k] = todo ? fuenteIndexada_(specs[k]) : fuenteBuscador_(specs[k]);
  return F;
}

function fuenteIndexada_(spec) {
  const porOS = {}, porCta = {};
  const hoja = spec.hoja;
  if (hoja && hoja.getLastRow() >= 2) {
    const w = Math.min(spec.ancho, hoja.getMaxColumns());
    hoja.getRange(2, 1, hoja.getLastRow() - 1, w).getDisplayValues().forEach((fila, i) => {
      const v = fila.map(x => String(x || '').trim());
      while (v.length < spec.ancho) v.push('');
      const r = { fila: i + 2, v: v };
      const o = spec.os >= 0 ? limpiarNum_(v[spec.os]) : '';
      const c = spec.cta >= 0 ? limpiarNum_(v[spec.cta]) : '';
      if (o) (porOS[o] = porOS[o] || []).push(r);
      if (c) (porCta[c] = porCta[c] || []).push(r);
    });
  }
  return { spec: spec, porOS: k => porOS[k] || [], porCta: k => porCta[k] || [] };
}

function fuenteBuscador_(spec) {
  const memo = {};
  const buscar = (col, k) => {
    if (col < 0 || !k) return [];
    const clave = col + '|' + k;
    return memo[clave] || (memo[clave] = renglonesCon_(spec.hoja, [col], k, spec.ancho));
  };
  return { spec: spec, porOS: k => buscar(spec.os, k), porCta: k => buscar(spec.cta, k) };
}

function resolverCliente_(F, osIn, ctaIn) {
  const os = limpiarNum_(osIn);
  let cta = limpiarNum_(ctaIn);
  const orden = [F.at, F.bd, F.ctt, F.ci];

  // La OS como viene escrita en la hoja, y su cuenta si no se dio
  let osTxt = '';
  if (os) {
    for (const f of orden) {
      for (const r of f.porOS(os)) {
        if (!osTxt) osTxt = r.v[f.spec.os];
        if (!cta && f.spec.cta >= 0) cta = limpiarNum_(r.v[f.spec.cta]);
      }
    }
  }
  const renglones = f => unirRenglones_(os ? f.porOS(os) : [], cta ? f.porCta(cta) : []);
  const at = renglones(F.at), bd = renglones(F.bd), ctt = renglones(F.ctt);

  // OS de la cuenta (la pedida primero)
  const oss = [];
  const agregarOS = v => { const s = String(v || '').trim(); if (s && oss.indexOf(s) < 0) oss.push(s); };
  agregarOS(osTxt);
  at.forEach(r => agregarOS(r.v[AT_OS]));
  bd.forEach(r => agregarOS(r.v[BD_OS]));
  if (F.ctt.spec.os >= 0) ctt.forEach(r => agregarOS(r.v[F.ctt.spec.os]));

  // CIERRE OS no trae cuenta: se busca por la OS y, si ahí no hay plan, por otras OS de la cuenta
  let ci = os ? F.ci.porOS(os) : [];
  if (!ci.some(r => planValido_(r.v[CI_PLAN]))) {
    for (const o of oss.slice(0, 5)) ci = unirRenglones_(ci, F.ci.porOS(limpiarNum_(o)));
  }

  const primerValor = (rows, col, ok) => {
    if (col >= 0) for (const r of rows) if (ok ? ok(r.v[col]) : r.v[col]) return r.v[col];
    return '';
  };
  return {
    encontrado: !!(at.length || bd.length || ctt.length || ci.length),
    esOS: !!osTxt,
    os: osTxt,
    cuenta: cta,
    cliente: primerValor(at, AT_CLIENTE) || primerValor(bd, BD_CLIENTE),
    plan: primerValor(at, AT_PLAN, planValido_) || primerValor(ci, CI_PLAN, planValido_) ||
      primerValor(bd, BD_PLAN, planValido_) || primerValor(ctt, F.ctt.spec.n1, planValido_),
    cluster: primerValor(ctt, F.ctt.spec.cl),
    oss: oss.slice(0, 30)
  };
}

// Plan de cada cuenta de BD CTT (pestaña Cuentas), con el mismo criterio
// que el seguimiento, tomando la OS de su reporte más reciente.
// Va comprimido: { lista: [planes distintos], ct: { cuenta: índice } }
function planesPorCuenta_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const ctt = ss.getSheetByName(HOJA_CTT);
  if (!ctt) return { error: 'No se encontró la hoja ' + HOJA_CTT };
  const data = ctt.getDataRange().getValues();
  const iOS = colPorEncabezado_(data[0], ['OS']);

  const ult = {};   // cuenta → { k: 'fecha hora', os }
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const cuenta = String(row[COL_CUENTA] || '').trim();
    if (!cuenta) continue;
    const k = fechaHora_(row[COL_FECHA]).join(' ');
    const os = iOS >= 0 ? String(row[iOS] || '').trim() : '';
    const u = ult[cuenta];
    if (!u || (os && (!u.os || k >= u.k)) || (!os && !u.os && k >= u.k)) ult[cuenta] = { k: k, os: os };
  }

  const F = fuentesClientes_(ss, true);
  const lista = [], idx = {}, ct = {};
  for (const cuenta in ult) {
    const plan = resolverCliente_(F, ult[cuenta].os, cuenta).plan;
    if (!plan) continue;
    if (!(plan in idx)) { idx[plan] = lista.length; lista.push(plan); }
    ct[cuenta] = idx[plan];
  }
  return { ok: true, lista: lista, ct: ct };
}

// Búsqueda del panel: `q` puede ser OS o cuenta
function buscarCliente_(qIn) {
  const q = limpiarNum_(qIn);
  if (!q) return { ok: false, error: 'Captura una OS o una cuenta.' };
  const F = fuentesClientes_(SpreadsheetApp.openById(SPREADSHEET_ID), false);
  const esOS = [F.at, F.bd, F.ctt, F.ci].some(f => f.porOS(q).length);
  const r = esOS ? resolverCliente_(F, q, '') : resolverCliente_(F, '', q);
  r.ok = true;
  return r;
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
  if (ss.getSheetByName(HOJA_SEGUIMIENTO)) {
    Logger.log('La hoja SEGUIMIENTO ya existe');
    return;
  }
  hojaSeguimiento_(ss);
  Logger.log('Hoja SEGUIMIENTO creada correctamente');
}
