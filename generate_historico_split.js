const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = __dirname;
const SOURCE_FILE = path.join(ROOT, 'Historico.xlsx');
const LEGACY_FILE = path.join(ROOT, 'legacy_data.json');
const CURRENT_FILE = path.join(ROOT, 'base_data.json');
const LEGACY_JS_FILE = path.join(ROOT, 'seed_legacy_data.js');
const CURRENT_JS_FILE = path.join(ROOT, 'seed_base_data.js');
const CUTOFF_DATE = '2026-03-01';
const LEGACY_START = '2025-01-01';

function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return '';
    return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }

  const text = String(value).trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) {
    const [day, month, year] = text.split('/');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return '';
}

function cleanText(value, { keepNA = false } = {}) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toFixed(6))).replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
  }

  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!text) return '';

  if (!keepNA) {
    const upper = text.toUpperCase();
    if (upper === 'NA' || upper === 'N/A' || upper === 'SEM INFORMAÇÃO' || upper === 'SEM INFORMACAO') return '';
  }

  return text;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  const text = String(value).trim().replace(/\./g, '').replace(',', '.');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeType(value) {
  const text = cleanText(value, { keepNA: true });
  if (!text) return '';
  if (text.toLowerCase() === 'transfêrencia') return 'Transferência';
  return text;
}

function buildImportKey(record) {
  return [
    record.dataFisico,
    record.tipo,
    record.nf,
    record.depositoOrigem,
    record.origem,
    record.depositoDestino,
    record.destino,
    record.pedido,
    record.remessa,
    record.dataSistemico,
    record.migo,
    record.codProduto,
    record.material,
    record.quantidade,
    record.unidade,
    record.lote
  ].map((item) => cleanText(item, { keepNA: true }).toLowerCase()).join('|');
}

function transformRow(row) {
  const dataFisico = toIsoDate(row['Data movimentação fisica']);
  if (!dataFisico) return null;

  const tipo = normalizeType(row['Tipo']);
  const pedido = cleanText(row['Pedido'], { keepNA: true });
  const migo = cleanText(row['MIGO'], { keepNA: true });
  const dataSistemico = toIsoDate(row['DATA MOV. SISTEMICO']);
  const isWriter = pedido.toUpperCase() === 'WRITER';
  const isPendingWriter = isWriter && (!migo || /sem moviment/i.test(migo));

  const record = {
    dataFisico,
    tipo,
    status: isPendingWriter ? 'pendente' : 'finalizado',
    nfTipo: isWriter ? 'writer' : 'pedido',
    nf: cleanText(row['NF'], { keepNA: true }),
    depositoOrigem: cleanText(row['Origem ( deposito )'], { keepNA: true }),
    origem: cleanText(row['Fazenda Origem'], { keepNA: true }),
    depositoDestino: cleanText(row['Destino ( deposito )'], { keepNA: true }),
    destino: cleanText(row['Fazenda Destino'], { keepNA: true }),
    epsDestino: cleanText(row['Destino ( deposito )'], { keepNA: true }),
    supervisor: cleanText(row['Solicitante'], { keepNA: true }),
    centro: '',
    deposito: '',
    pedido,
    motivo: cleanText(row['Motivo Writer'], { keepNA: true }),
    remessa: cleanText(row['REMESSA'], { keepNA: true }),
    dataSistemico,
    migo,
    codProduto: cleanText(row['Código Produto'], { keepNA: true }),
    material: cleanText(row['Descrição Produto'], { keepNA: true }),
    quantidade: toNumber(row['QUANTIDADE']),
    unidade: cleanText(row['UNIDADE'], { keepNA: true }),
    lote: cleanText(row['LOTE'], { keepNA: true }),
    dataDevEmb: '',
    embDevolver: 0,
    caixasDevolver: 0,
    contEmb: 'NAO',
    inseridoPor: cleanText(row['Atendente'], { keepNA: true }) || 'Importado',
    inseridoEm: dataSistemico || dataFisico,
    finalizadoPor: '',
    finalizadoEm: isPendingWriter ? '' : (dataSistemico || dataFisico),
    atendente: cleanText(row['Atendente'], { keepNA: true }),
    solicitante: cleanText(row['Solicitante'], { keepNA: true }),
    tipoAtendimento: cleanText(row['Tipo de Atendimento'], { keepNA: true }),
    seedManaged: true
  };

  record.importKey = buildImportKey(record);
  return record;
}

function main() {
  const workbook = XLSX.readFile(SOURCE_FILE);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const legacy = [];
  const current = [];

  rows.forEach((row) => {
    const record = transformRow(row);
    if (!record) return;
    if (record.dataFisico >= CUTOFF_DATE) {
      record.seedSource = 'registros-marco-2026';
      current.push(record);
      return;
    }
    if (record.dataFisico >= LEGACY_START) {
      record.seedSource = 'legado-2025-2026';
      legacy.push(record);
    }
  });

  fs.writeFileSync(LEGACY_FILE, JSON.stringify(legacy));
  fs.writeFileSync(CURRENT_FILE, JSON.stringify(current));
  fs.writeFileSync(
    LEGACY_JS_FILE,
    `(function(root){ root.CTI_SEED_LEGACY_DATA = ${JSON.stringify(legacy)}; })(typeof window !== 'undefined' ? window : globalThis);\n`
  );
  fs.writeFileSync(
    CURRENT_JS_FILE,
    `(function(root){ root.CTI_SEED_BASE_DATA = ${JSON.stringify(current)}; })(typeof window !== 'undefined' ? window : globalThis);\n`
  );

  console.log(`Legado: ${legacy.length} registros gravados em ${path.basename(LEGACY_FILE)}`);
  console.log(`Registros: ${current.length} registros gravados em ${path.basename(CURRENT_FILE)}`);
}

main();
