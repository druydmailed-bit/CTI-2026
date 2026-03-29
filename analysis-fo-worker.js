self.importScripts('vendor/xlsx.full.min.js');

function normalizeText(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function normalizeAnalysisLookupKey(value, loose) {
  let text = normalizeText(value);
  if (!text) return '';
  text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  text = text.replace(/[_./-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (loose) {
    text = text.replace(/\b(ms|servicos|servicos|agroflorestal|i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
  }
  return text;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  const normalized = String(value).trim().replace(/\s+/g, '').replace(',', '.');
  const parsed = parseFloat(normalized);
  return Number.isNaN(parsed) ? NaN : parsed;
}

function parseSpreadsheetDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const base = new Date(Date.UTC(1899, 11, 30));
    base.setUTCDate(base.getUTCDate() + Math.floor(value));
    return base.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text) return '';
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const brMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (brMatch) return `${brMatch[3]}-${String(brMatch[2]).padStart(2, '0')}-${String(brMatch[1]).padStart(2, '0')}`;

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return '';
}

function getObjectValueByKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  const normalized = {};
  Object.keys(obj).forEach((key) => {
    normalized[normalizeAnalysisLookupKey(key, false)] = obj[key];
  });

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    const match = normalized[normalizeAnalysisLookupKey(key, false)];
    if (match !== undefined && match !== null && match !== '') return match;
  }
  return '';
}

function findWorkbookSheet(workbook, matcher, fallbackIndex) {
  const sheetName = workbook.SheetNames.find((name) => normalizeAnalysisLookupKey(name, false).includes(matcher))
    || workbook.SheetNames[fallbackIndex || 0];
  return sheetName ? workbook.Sheets[sheetName] : null;
}

function extractFoPayload(file) {
  const workbook = XLSX.read(file.data, { type: 'array', cellDates: true, dense: true });
  const sheet = findWorkbookSheet(workbook, 'fo', 0);
  if (!sheet) return null;

  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const rawRows = XLSX.utils.sheet_to_json(sheet, { range: 2, defval: '', raw: true });

  let firstDateFromColJ = '';
  for (let r = 2; r < aoa.length; r++) {
    const cellJ = aoa[r] && aoa[r][9];
    if (cellJ !== undefined && cellJ !== null && cellJ !== '') {
      const parsed = parseSpreadsheetDate(cellJ);
      if (parsed) {
        firstDateFromColJ = parsed;
        break;
      }
    }
  }

  return {
    fileName: normalizeText(file.name),
    titleText: normalizeText(aoa[0] && aoa[0][0]),
    firstDateFromColJ,
    rows: rawRows.map((row, index) => ({
      index,
      epsText: normalizeText(getObjectValueByKeys(row, ['EPS', 'Equipe/EPS'])),
      productText: normalizeText(getObjectValueByKeys(row, ['PRODUTO', 'INSUMO'])),
      materialCode: normalizeText(getObjectValueByKeys(row, ['CÓDIGO SAP', 'CODIGO SAP', 'SAP'])),
      rawQuantity: parseLocaleNumber(getObjectValueByKeys(row, ['QUANTIDADE'])),
      operationDate: parseSpreadsheetDate(getObjectValueByKeys(row, ['DATA OPERAÇÃO', 'DATA OPERACAO']))
    }))
  };
}

self.onmessage = function onMessage(event) {
  const data = event && event.data ? event.data : {};
  if (data.type !== 'parse-fo-files') return;

  try {
    const files = Array.isArray(data.files) ? data.files : [];
    const payloads = files.map(extractFoPayload).filter(Boolean);
    self.postMessage({ files: payloads });
  } catch (error) {
    self.postMessage({ error: error && error.message ? error.message : String(error) });
  }
};
