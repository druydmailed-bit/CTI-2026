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

function getSheetActualRange(sheet) {
  let minRow = Infinity;
  let minCol = Infinity;
  let maxRow = -1;
  let maxCol = -1;

  const registerCell = (rowIndex, colIndex, value) => {
    const hasValue = typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null && value !== '';
    if (!hasValue) return;
    if (rowIndex < minRow) minRow = rowIndex;
    if (colIndex < minCol) minCol = colIndex;
    if (rowIndex > maxRow) maxRow = rowIndex;
    if (colIndex > maxCol) maxCol = colIndex;
  };

  if (Array.isArray(sheet)) {
    sheet.forEach((row, rowIndex) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, colIndex) => {
        const value = cell && typeof cell === 'object' && 'v' in cell ? cell.v : cell;
        registerCell(rowIndex, colIndex, value);
      });
    });
  } else {
    Object.keys(sheet).forEach((key) => {
      if (!key || key[0] === '!') return;
      const cell = sheet[key];
      const value = cell && typeof cell === 'object' && 'v' in cell ? cell.v : cell;
      const decoded = XLSX.utils.decode_cell(key);
      registerCell(decoded.r, decoded.c, value);
    });
  }

  if (maxRow < 0 || maxCol < 0) return null;
  return {
    s: { r: minRow, c: minCol },
    e: { r: maxRow, c: maxCol }
  };
}

async function extractFoPayload(file) {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array', cellDates: true, dense: true });
  const sheet = findWorkbookSheet(workbook, 'fo', 0);
  if (!sheet) return null;

  const actualRange = getSheetActualRange(sheet);
  const maxCol = Math.max(actualRange ? actualRange.e.c : 11, 11);
  const aoaRange = actualRange
    ? XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: actualRange.e.r, c: maxCol } })
    : undefined;
  const rowRange = actualRange
    ? XLSX.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: actualRange.e.r, c: maxCol } })
    : 2;
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, range: aoaRange });
  const rawRows = XLSX.utils.sheet_to_json(sheet, { range: rowRange, defval: '', raw: true });

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

self.onmessage = async function onMessage(event) {
  const data = event && event.data ? event.data : {};
  if (data.type !== 'parse-fo-files') return;

  try {
    const files = Array.isArray(data.files) ? data.files : [];
    const payloads = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      self.postMessage({
        progress: {
          phase: 'reading-start',
          completed: index,
          total: files.length,
          currentFile: normalizeText(file && file.name)
        }
      });
      const payload = await extractFoPayload(file);
      if (payload) payloads.push(payload);
      self.postMessage({
        progress: {
          phase: 'reading-done',
          completed: index + 1,
          total: files.length,
          currentFile: normalizeText(file && file.name),
          rowCount: Array.isArray(payload && payload.rows) ? payload.rows.length : 0
        }
      });
    }
    self.postMessage({ files: payloads });
  } catch (error) {
    self.postMessage({ error: error && error.message ? error.message : String(error) });
  }
};
