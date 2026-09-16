/**
 * Backend de referencia para Higiene Manta PWA.
 * 1) Cree/seleccione una hoja de cálculo de Google Sheets.
 * 2) Cree una carpeta de Drive para evidencias.
 * 3) Reemplace SPREADSHEET_ID y DRIVE_FOLDER_ID.
 * 4) Despliegue como Aplicación web y copie la URL /exec a config.js.
 *
 * Este backend NO modifica Google Forms. La PWA escribe directamente a Sheets
 * y almacena las fotografías en Drive. El formulario actual puede seguir activo
 * durante el piloto.
 */

const SPREADSHEET_ID = 'PEGAR_ID_DE_GOOGLE_SHEETS';
const SHEET_NAME = 'EVACUACIONES_APP';
const DRIVE_FOLDER_ID = 'PEGAR_ID_CARPETA_DRIVE';

function doGet() {
  return json_({ok:true, service:'Higiene Manta PWA', timestamp:new Date().toISOString()});
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!payload.id || !payload.punto || !payload.punto.codigo) {
      throw new Error('Registro incompleto: falta id o código del punto crítico.');
    }

    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const photoBeforeUrl = savePhoto_(folder, payload.photoBefore, payload.punto.codigo, 'ANTES', payload.id);
    const photoAfterUrl  = savePhoto_(folder, payload.photoAfter,  payload.punto.codigo, 'DESPUES', payload.id);

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sh = ss.getSheetByName(SHEET_NAME);
    if (!sh) sh = ss.insertSheet(SHEET_NAME);
    ensureHeaders_(sh);

    const r = payload;
    const residuos = r.residuos || {};
    sh.appendRow([
      r.id,
      new Date(r.createdAt || new Date()),
      r.supervisor || '',
      r.punto.codigo || '',
      r.punto.parroquiaInventario || '',
      r.punto.barrioInventario || '',
      r.punto.referencia || '',
      r.punto.estado || '',
      r.punto.frecuencia || '',
      r.territorio && r.territorio.parroquia || '',
      r.territorio && r.territorio.barrio || '',
      r.territorio && r.territorio.lat || '',
      r.territorio && r.territorio.lng || '',
      r.territorio && r.territorio.accuracy || '',
      r.fuente || '',
      r.fuenteOtro || '',
      (r.terreno || []).join(' | '),
      toDate_(r.inicio),
      toDate_(r.fin),
      residuos['Residuos Sólidos Urbanos (RSU) Comunes'] || 0,
      residuos['Desechos Orgánicos'] || 0,
      residuos['Material de Construcción y Escombros'] || 0,
      residuos['Desechos Voluminosos (Muebles, Electrodomésticos)'] || 0,
      residuos['Llantas'] || 0,
      residuos['Desechos Peligrosos/Especiales'] || 0,
      residuos['Maleza'] || 0,
      residuos['Otros'] || 0,
      r.vehiculo && r.vehiculo.tipo || '',
      r.vehiculo && r.vehiculo.propiedad || '',
      r.vehiculo && r.vehiculo.capacidadM3 || 0,
      r.vehiculo && r.vehiculo.viajes || 0,
      r.equipo && (r.equipo.tipos || []).join(' | ') || '',
      r.equipo && r.equipo.propiedad || '',
      photoBeforeUrl,
      photoAfterUrl,
      r.observaciones || '',
      new Date()
    ]);

    return json_({ok:true, id:r.id, photoBeforeUrl:photoBeforeUrl, photoAfterUrl:photoAfterUrl});
  } catch (err) {
    return json_({ok:false, error:String(err && err.message || err)});
  }
}

function ensureHeaders_(sh) {
  if (sh.getLastRow() > 0) return;
  sh.appendRow([
    'ID registro','Creado en dispositivo','Supervisor','Código punto','Parroquia inventario','Barrio inventario','Referencia','Estado punto','Frecuencia',
    'Parroquia GPS','Barrio GPS','Latitud GPS','Longitud GPS','Precisión GPS (m)','Fuente pedido','Otra fuente','Caracterización terreno',
    'Inicio evacuación','Fin evacuación','RSU %','Orgánicos %','Construcción/escombros %','Voluminosos %','Llantas %','Peligrosos/especiales %','Maleza %','Otros %',
    'Tipo vehículo','Propiedad vehículo','Capacidad m3','Viajes','Equipo de carga','Propiedad equipo','Foto ANTES','Foto DESPUÉS','Observaciones','Recibido servidor'
  ]);
  sh.setFrozenRows(1);
}

function savePhoto_(folder, photo, code, stage, recordId) {
  if (!photo || !photo.data) return '';
  const mime = photo.mime || 'image/jpeg';
  const ext = mime.indexOf('png') >= 0 ? 'png' : 'jpg';
  const bytes = Utilities.base64Decode(photo.data);
  const blob = Utilities.newBlob(bytes, mime, code + '_' + stage + '_' + recordId + '.' + ext);
  const file = folder.createFile(blob);
  return file.getUrl();
}

function toDate_(iso) {
  return iso ? new Date(iso) : '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
