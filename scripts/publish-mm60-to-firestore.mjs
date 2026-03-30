import XLSX from "xlsx";
import { initializeApp } from "firebase/app";
import { doc, getFirestore, setDoc } from "firebase/firestore/lite";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { config, options } = require("../firebase-config.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workbookPath = path.resolve(__dirname, "..", "MM60.xlsx");

function normalizeText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseLocaleNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = normalizeText(value);
  if (!text) return NaN;

  const normalized = text
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getObjectValueByKeys(row, keys) {
  const entries = Object.entries(row || {});
  for (const key of keys) {
    const target = normalizeKey(key);
    const match = entries.find(([entryKey]) => normalizeKey(entryKey) === target);
    if (match) return match[1];
  }
  return "";
}

function parseMm60Workbook(workbook, fileName = "MM60.xlsx") {
  if (!workbook || !Array.isArray(workbook.SheetNames) || !workbook.SheetNames.length) {
    throw new Error("A planilha MM60 nao possui abas validas.");
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
  const grouped = new Map();
  let ignoredZero = 0;

  rawRows.forEach((row) => {
    const materialCode = normalizeText(getObjectValueByKeys(row, [
      "Material",
      "Codigo material",
      "Codigo do material"
    ]));
    const materialName = normalizeText(getObjectValueByKeys(row, [
      "Texto breve material",
      "Descricao do material",
      "Descricao material"
    ]));
    const rawPrice = parseLocaleNumber(getObjectValueByKeys(row, ["Preco", "Preco medio", "Valor"]));
    const rawPriceUnit = parseLocaleNumber(getObjectValueByKeys(row, ["Unidade preco", "Unidade de preco"]));

    if ((!materialCode && !materialName) || !Number.isFinite(rawPrice) || rawPrice <= 0) {
      if (Number.isFinite(rawPrice) && rawPrice <= 0) ignoredZero += 1;
      return;
    }

    const divisor = Number.isFinite(rawPriceUnit) && rawPriceUnit > 0 ? rawPriceUnit : 1;
    const unitPrice = rawPrice / divisor;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return;

    const key = materialCode
      ? `code:${materialCode.toLowerCase()}`
      : `name:${normalizeKey(materialName)}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        materialCode,
        materialName,
        unitPriceTotal: 0,
        rowCount: 0
      });
    }

    const entry = grouped.get(key);
    if (!entry.materialCode && materialCode) entry.materialCode = materialCode;
    if (!entry.materialName && materialName) entry.materialName = materialName;
    entry.unitPriceTotal += unitPrice;
    entry.rowCount += 1;
  });

  const priceRows = [...grouped.values()]
    .map((entry) => ({
      materialCode: normalizeText(entry.materialCode || ""),
      materialName: normalizeText(entry.materialName || ""),
      unitPrice: Number((entry.unitPriceTotal / Math.max(1, entry.rowCount)).toFixed(6)),
      rowCount: entry.rowCount,
      currency: "BRL"
    }))
    .filter((row) => (row.materialCode || row.materialName) && row.unitPrice > 0)
    .sort((a, b) => {
      const labelA = a.materialName || a.materialCode;
      const labelB = b.materialName || b.materialCode;
      return labelA.localeCompare(labelB, "pt-BR");
    });

  return {
    fileName: normalizeText(fileName || "MM60.xlsx") || "MM60.xlsx",
    priceRows,
    rawCount: rawRows.length,
    ignoredZero
  };
}

async function main() {
  const workbook = XLSX.readFile(workbookPath, { cellDates: true });
  const parsed = parseMm60Workbook(workbook, path.basename(workbookPath));
  const payload = {
    kind: "asset",
    assetKey: "mm60_prices",
    schemaVersion: 1,
    fileName: parsed.fileName,
    rawCount: parsed.rawCount,
    ignoredZero: parsed.ignoredZero,
    totalBaseCount: parsed.priceRows.length,
    generatedAt: new Date().toISOString(),
    updatedAtClient: new Date().toISOString(),
    priceRows: parsed.priceRows
  };

  const app = initializeApp(config);
  const db = getFirestore(app);
  const collectionName = options.collection || "cti_app_state";
  const documentId = options.mm60DocId || "asset__mm60_prices_v1";

  await setDoc(doc(db, collectionName, documentId), payload, { merge: false });

  const jsonBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        projectId: config.projectId,
        collection: collectionName,
        docId: documentId,
        totalBaseCount: parsed.priceRows.length,
        rawCount: parsed.rawCount,
        ignoredZero: parsed.ignoredZero,
        jsonBytes
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
