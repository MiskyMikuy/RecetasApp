/* eslint-disable no-restricted-globals */
import { useState, useEffect, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import Papa from "papaparse";

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_KEY  = process.env.REACT_APP_SUPABASE_ANON_KEY;
const supabase      = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── CALCULATIONS ─────────────────────────────────────────────────────────────
// Redondeo del "precio redondeado": a qué múltiplo se redondea hacia arriba el
// precio sugerido. Un solo lugar para cambiarlo — así el cálculo y el texto
// "cada $..." que lo acompaña nunca quedan desincronizados.
const PRICE_ROUND_TO = 100;

function normalizeName(s) {
  return (s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function unitCost(ing) {
  const base = ing.buy_qty > 0 ? ing.buy_price / ing.buy_qty : 0;
  return ing.waste_pct > 0 ? base / (1 - ing.waste_pct / 100) : base;
}
function calcRecipe(recipe, ingredients, business) {
  const ingMap     = Object.fromEntries(ingredients.map(i => [i.id, i]));
  const totalFixed = (business.fixed_costs || []).reduce((s, c) => s + (c.amount || 0), 0);
  const cfPerUnit  = business.monthly_units > 0 ? totalFixed / business.monthly_units : 0;
  const varPct     = ((business.delivery_pct || 0) + (business.iva_pct || 0) + (business.other_var_pct || 0)) / 100;
  let mpTotal = 0;
  const lines = (recipe.recipe_ingredients || []).map(ri => {
    const ing = ingMap[ri.ingredient_id];
    if (!ing) return null;
    const uc  = unitCost(ing);
    const sub = uc * ri.qty;
    mpTotal  += sub;
    return { ing, qty: ri.qty, unitCost: uc, subtotal: sub };
  }).filter(Boolean);
  const mpPerPortion   = recipe.portions > 0 ? mpTotal / recipe.portions : 0;
  const subtotalDirect = mpPerPortion + cfPerUnit;
  const varCost        = subtotalDirect * varPct;
  const totalCost      = subtotalDirect + varCost;
  const profitPct      = (recipe.profit_pct || 40) / 100;
  const suggestedPrice = profitPct < 1 ? totalCost / (1 - profitPct) : totalCost * 2;
  const roundedPrice   = Math.ceil(suggestedPrice / PRICE_ROUND_TO) * PRICE_ROUND_TO;
  const realProfit     = roundedPrice - totalCost;
  const realProfitPct  = roundedPrice > 0 ? (realProfit / roundedPrice) * 100 : 0;
  return { lines, mpTotal, mpPerPortion, cfPerUnit, varCost, varPct,
           totalCost, suggestedPrice, roundedPrice, realProfit, realProfitPct };
}

// ─── INFORME DE COSTEO POR PRODUCCIÓN ────────────────────────────────────────
// selections: [{ recipeId, portionsMade }]. Escala cada receta a la cantidad
// de porciones realmente producidas y agrupa el gasto por ingrediente,
// dejando registrado a qué receta(s) pertenece cada uno. Usado por la lista
// de compras y el mise en place "ricos" (HTML descargable).
function calcProductionReport(selections, recipes, ingredients, business) {
  const perRecipe = [];
  const ingredientMap = new Map(); // ingredient_id -> { ing, qty, cost, recipeNames:Set }

  selections.forEach(sel => {
    const recipe = recipes.find(r => r.id === sel.recipeId);
    const portionsMade = +sel.portionsMade || 0;
    if (!recipe || portionsMade <= 0) return;
    const calc = calcRecipe(recipe, ingredients, business);
    const factor = recipe.portions > 0 ? portionsMade / recipe.portions : 0;

    perRecipe.push({
      recipe,
      portionsMade,
      unitCost: calc.mpPerPortion,
      mpTotalScaled: calc.mpTotal * factor,
      totalCostScaled: calc.mpTotal * factor,
    });

    calc.lines.forEach(l => {
      const key = l.ing.id;
      if (!ingredientMap.has(key)) {
        ingredientMap.set(key, { ing: l.ing, qty: 0, cost: 0, recipes: new Set() });
      }
      const entry = ingredientMap.get(key);
      entry.qty += l.qty * factor;
      entry.cost += l.subtotal * factor;
      entry.recipes.add(recipe.name);
    });
  });

  const ingredientRows = Array.from(ingredientMap.values())
    .map(e => ({ ing: e.ing, qty: e.qty, cost: e.cost, recipeNames: Array.from(e.recipes), recipeCount: e.recipes.size }))
    .sort((a, b) => b.cost - a.cost);

  const grandTotal    = perRecipe.reduce((s, r) => s + r.totalCostScaled, 0);
  const totalPortions = perRecipe.reduce((s, r) => s + r.portionsMade, 0);
  const totalMP       = ingredientRows.reduce((s, r) => s + r.cost, 0);

  return { perRecipe, ingredientRows, grandTotal, totalPortions, totalMP };
}

// ─── GUÍA DE UNIDADES ─────────────────────────────────────────────────────────
const UNIT_GUIDE = [
  { unit:"kg",  recipe:"Decimales: 0.250 = 250 g  ·  0.500 = 500 g  ·  1.000 = 1 kg" },
  { unit:"lt",  recipe:"Decimales: 0.100 = 100 ml  ·  0.250 = 250 ml  ·  1.000 = 1 lt" },
  { unit:"ml",  recipe:"Directo: 5 = 5 ml  ·  100 = 100 ml  ·  500 = 500 ml" },
  { unit:"u",   recipe:"Enteros o medios: 1 = 1 unidad  ·  0.5 = media  ·  12 = docena" },
  { unit:"g",   recipe:"Directo: 50 = 50 g  ·  250 = 250 g  ·  500 = 500 g" },
];

// ─── TEXTO NORMALIZADO (para comparar nombres sin distinguir mayúsculas/acentos) ──
// Alias de normalizeName con el nombre usado por el resto de las funciones
// de importación/exportación portadas — misma implementación, dos nombres.
function normalizeText(s) { return normalizeName(s); }
function sortByName(arr) {
  return [...arr].sort((a, b) => (a.name || "").localeCompare(b.name || "", "es", { sensitivity: "base" }));
}

// Si el archivo no es un CSV/TXT, explica en el idioma más simple posible cómo
// convertirlo, en vez de tirar un error de parseo confuso.
function fileTypeGuidance(fileName) {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (ext === "csv" || ext === "txt") return null;
  const guides = {
    xlsx: "Es un archivo de Excel. Abrilo, andá a Archivo → Guardar como (o Descargar) → elegí el formato \"CSV (delimitado por comas)\" → subí ese archivo nuevo.",
    xls:  "Es un archivo de Excel. Abrilo, andá a Archivo → Guardar como (o Descargar) → elegí el formato \"CSV (delimitado por comas)\" → subí ese archivo nuevo.",
    doc:  "Es un archivo de Word — no sirve para importar datos en tabla. Copiá los datos y pegalos en una hoja de Excel o Google Sheets respetando las columnas, y después descargalo como CSV (Archivo → Descargar → Valores separados por comas).",
    docx: "Es un archivo de Word — no sirve para importar datos en tabla. Copiá los datos y pegalos en una hoja de Excel o Google Sheets respetando las columnas, y después descargalo como CSV (Archivo → Descargar → Valores separados por comas).",
    pdf:  "Es un archivo PDF — no se puede importar directamente. Pasá los datos a una hoja de Excel o Google Sheets y descargalo como CSV (Archivo → Descargar → Valores separados por comas).",
  };
  return guides[ext] || `El archivo ".${ext}" no se puede leer acá — subí un CSV (podés hacerlo desde Excel o Google Sheets con Archivo → Descargar/Guardar como → CSV).`;
}

// Lee el archivo detectando si está en UTF-8 o Windows-1252 (la codificación
// típica de un CSV exportado desde Excel en español) — así los acentos no se
// rompen según cómo se haya guardado el archivo.
async function readFileSmartText(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// Convierte el texto crudo del archivo en una matriz de filas usando Papa Parse,
// que soporta comillas, separadores embebidos y saltos de línea dentro de una
// misma celda (necesario para campos de texto largo como el procedimiento).
function parseCSVRows(text) {
  const cleaned = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => !l.startsWith("sep=")).join("\n");
  const result = Papa.parse(cleaned.trim(), { skipEmptyLines: true });
  return result.data;
}

// ─── PARSE CSV RECETAS ────────────────────────────────────────────────────────
// Cada fila del CSV es un ingrediente de una receta. Varias filas con el mismo
// nombre de receta (sin distinguir mayúsculas/acentos) se agrupan como una sola.
// El procedimiento es independiente de las cantidades: se puede completar en
// una sola fila de la receta (o dejar vacío) y no afecta el resto del import.
function parseRecipesCSV(text) {
  const rows2d = parseCSVRows(text);
  if (rows2d.length < 2) throw new Error("El archivo debe tener encabezado y al menos una fila.");
  const colMap = {
    recipe:     ["receta","nombre","recipe","platorece","plato"],
    category:   ["categoria","category","rubro"],
    portions:   ["porciones","portions","cantidadporciones"],
    profit:     ["ganancia","profit","gananciapct","margen","porcentajeganancia"],
    ingredient: ["ingrediente","ingredient"],
    qty:        ["cantidad","qty","cant"],
    procedure:  ["procedimiento","preparacion","instrucciones","procedure"],
    del:        ["eliminar","borrar","delete","baja"],
  };
  let headerRowIndex = -1, idx = {};
  for (let r = 0; r < Math.min(rows2d.length, 15); r++) {
    const normalized = rows2d[r].map(h => normalizeText(h).replace(/[^a-z0-9]/g, ""));
    const testIdx = {};
    for (const [key, aliases] of Object.entries(colMap)) {
      for (const alias of aliases) {
        const i = normalized.indexOf(alias);
        if (i !== -1) { testIdx[key] = i; break; }
      }
    }
    if (testIdx.recipe !== undefined) { headerRowIndex = r; idx = testIdx; break; }
  }
  if (idx.recipe === undefined) throw new Error("No se encontró la columna Receta.");

  const groups = new Map();
  for (let i = headerRowIndex + 1; i < rows2d.length; i++) {
    const cols = rows2d[i];
    const rawName = cols[idx.recipe]?.trim();
    if (!rawName) continue;
    const key = normalizeText(rawName);
    if (!groups.has(key)) {
      groups.set(key, { name: rawName, category: "", portions: null, profit_pct: null, procedure: "", deleteFlag: false, lines: [] });
    }
    const g = groups.get(key);
    const toNum = v => (v === undefined || v === "") ? null : (parseFloat(v.replace(",", ".")) || null);
    const category = idx.category !== undefined ? cols[idx.category]?.trim() : "";
    if (category && !g.category) g.category = category;
    const portions = idx.portions !== undefined ? toNum(cols[idx.portions]) : null;
    if (portions && !g.portions) g.portions = portions;
    const profit = idx.profit !== undefined ? toNum(cols[idx.profit]) : null;
    if (profit && g.profit_pct === null) g.profit_pct = profit;
    const procedure = idx.procedure !== undefined ? cols[idx.procedure]?.trim() : "";
    if (procedure && !g.procedure) g.procedure = procedure;
    const delVal = idx.del !== undefined ? normalizeText(cols[idx.del]) : "";
    if (["si","s","x","1","true","yes"].includes(delVal)) g.deleteFlag = true;
    const ingName = idx.ingredient !== undefined ? cols[idx.ingredient]?.trim() : "";
    if (ingName) {
      const qty = idx.qty !== undefined ? (toNum(cols[idx.qty]) || 0) : 0;
      g.lines.push({ ingredientName: ingName, qty });
    }
  }
  if (groups.size === 0) throw new Error("No se encontraron recetas válidas.");
  return Array.from(groups.values());
}

// Cruza los grupos parseados contra recetas e ingredientes existentes para
// decidir si cada receta se va a agregar, actualizar o eliminar, y para
// resolver el nombre de cada ingrediente a su ID real.
function resolveRecipeImport(groups, recipes, ingredients) {
  return groups.map(g => {
    const existing = recipes.find(r => normalizeText(r.name) === normalizeText(g.name));
    const action = g.deleteFlag ? "delete" : existing ? "update" : "add";
    const resolvedLines = [];
    const unmatched = [];
    if (!g.deleteFlag) {
      for (const l of g.lines) {
        const ing = ingredients.find(i => normalizeText(i.name) === normalizeText(l.ingredientName));
        if (ing) resolvedLines.push({ ingredient_id: ing.id, qty: l.qty, name: ing.name, unit: ing.unit });
        else unmatched.push({ name: l.ingredientName, qty: l.qty });
      }
    }
    return {
      name: g.name,
      category: g.category || existing?.category || "General",
      portions: g.portions || existing?.portions || 4,
      profit_pct: g.profit_pct !== null ? g.profit_pct : (existing?.profit_pct ?? 40),
      procedure: g.procedure || existing?.procedure || "",
      action,
      existingId: existing?.id ?? null,
      lines: resolvedLines,
      unmatched,
    };
  });
}

// Exporta las recetas actuales en el mismo formato que espera el importador
// (una fila por ingrediente), para poder editarlas en Excel y volver a
// subirlas, o como respaldo.
function exportRecipesCSVForImport(recipes, ingredients) {
  const ingMap = Object.fromEntries(ingredients.map(i => [i.id, i]));
  const rows = [];
  recipes.forEach(r => {
    const lines = r.recipe_ingredients || [];
    if (lines.length === 0) {
      rows.push({
        Receta: r.name, "Categoría": r.category || "", Porciones: r.portions, "% Ganancia": r.profit_pct,
        Ingrediente: "", Cantidad: "", Procedimiento: r.procedure || "", Eliminar: "",
      });
    } else {
      lines.forEach((l, idx) => {
        const ing = ingMap[l.ingredient_id];
        rows.push({
          Receta: r.name,
          "Categoría": idx === 0 ? (r.category || "") : "",
          Porciones: idx === 0 ? r.portions : "",
          "% Ganancia": idx === 0 ? r.profit_pct : "",
          Ingrediente: ing ? ing.name : "",
          Cantidad: l.qty,
          Procedimiento: idx === 0 ? (r.procedure || "") : "",
          Eliminar: "",
        });
      });
    }
  });
  const csv = "sep=;\n" + Papa.unparse(rows, { delimiter: ";" });
  downloadCSV(csv, "RecetApp_Recetas.csv");
}

// Plantilla vacía (sin las recetas cargadas) — pensada para arrancar de cero,
// o para saber exactamente qué columnas usar. Trae una fila de ejemplo con el
// formato de dos filas por receta (una con los datos generales + primer
// ingrediente, y otra solo con el segundo ingrediente).
function downloadEmptyRecipesTemplate() {
  const S = ";";
  let csv = "sep=;\n";
  csv += `Receta${S}Categoría${S}Porciones${S}% Ganancia${S}Ingrediente${S}Cantidad${S}Procedimiento${S}Eliminar\n`;
  csv += `Ejemplo: Arroz con pollo${S}Principales${S}4${S}35${S}Arroz${S}0,3${S}Hervir el arroz, saltear el pollo y mezclar.${S}\n`;
  csv += `${S}${S}${S}${S}Pollo${S}0,5${S}${S}\n`;
  downloadCSV(csv, "RecetApp_Plantilla_Recetas.csv");
}

// ─── PARSE CSV INGREDIENTES ───────────────────────────────────────────────────
function parseIngredientsCSV(text) {
  const firstLine = text.split(/\r?\n/)[0];
  const sep = firstLine.includes(";") ? ";" : ",";
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim() && !l.startsWith("sep="));
  if (lines.length < 2) throw new Error("El archivo debe tener encabezado y al menos una fila.");
  const colMap = {
    name:      ["nombre","ingrediente","name"],
    category:  ["categoria","category","rubro","tipo"],
    unit:      ["unidad","unit","medida"],
    buy_price: ["precio","price","costo","preciocompra"],
    buy_qty:   ["cantidad","qty","cantidadcompra","bulto"],
    waste_pct: ["merma","waste","mermapct"],
  };
  // El archivo puede traer una linea de titulo antes del encabezado real (por
  // ejemplo "INGREDIENTES", como lo escribe el propio boton "Descargar" de
  // esta app y tambien el de RecetApp SA) -- en vez de asumir que la primera
  // linea es siempre el encabezado, se busca la fila que efectivamente tiene
  // una columna "Nombre". Esto permite reimportar un CSV exportado desde aca
  // mismo, o pasar ingredientes entre distintas instancias de RecetApp.
  let headerLineIndex = -1, idx = {};
  for (let r = 0; r < Math.min(lines.length, 15); r++) {
    const normalized = lines[r].split(sep).map(h =>
      h.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"")
    );
    const testIdx = {};
    for (const [key, aliases] of Object.entries(colMap)) {
      for (const alias of aliases) {
        const i = normalized.indexOf(alias);
        if (i !== -1) { testIdx[key] = i; break; }
      }
    }
    if (testIdx.name !== undefined) { headerLineIndex = r; idx = testIdx; break; }
  }
  if (idx.name === undefined) throw new Error("No se encontró la columna Nombre.");
  const rows = [];
  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    const cols = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g,""));
    const name = cols[idx.name]?.trim();
    if (!name) continue;
    const toNum = v => (v === undefined || v === "") ? 0 : parseFloat(v.replace(",",".")) || 0;
    rows.push({
      name,
      category:  cols[idx.category]?.trim() || "General",
      unit:      cols[idx.unit]?.trim()      || "kg",
      buy_price: toNum(cols[idx.buy_price]),
      buy_qty:   toNum(cols[idx.buy_qty]) || 1,
      waste_pct: toNum(cols[idx.waste_pct]),
    });
  }
  if (rows.length === 0) throw new Error("No se encontraron filas válidas.");
  return rows;
}

// ─── LOG DE ACTIVIDAD ─────────────────────────────────────────────────────────
async function logActivity(profile, action, entity, detail = "") {
  if (!profile) return;
  await supabase.from("activity_log").insert({
    user_id: profile.id, username: profile.username,
    action, entity, detail
  });
}

// ─── EXPORT CSV ───────────────────────────────────────────────────────────────
function downloadCSV(content, filename) {
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── LOGO MISKY MIKUY (embebido en base64, para los documentos HTML descargables) ──
const LOGO_MM_BASE64 = "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";

function escapeHtml(s) {
  return (s ?? "").toString()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function downloadTextFile(content, filename) {
  const blob = new Blob(["﻿" + content], { type: "text/plain;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function downloadHTMLFile(content, filename) {
  const blob = new Blob([content], { type: "text/html;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Genera un recetario en HTML con diseño institucional (logo y colores de
// Misky Mikuy) para las recetas seleccionadas — se puede abrir en el
// navegador, imprimir o guardar como PDF desde ahí.
function downloadRecipesText(selectedRecipes, ingredients, business) {
  const fecha = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });
  const recipesHtml = selectedRecipes.map(r => {
    const batches = r._batches || 1;
    const calc = calcRecipe(r, ingredients, business);
    const rows = calc.lines.map(l =>
      `<tr><td>${escapeHtml(l.ing.name)}</td><td>${l.qty.toFixed(3)}</td><td>${escapeHtml(l.ing.unit)}</td><td class="qty-cell">${(l.qty * batches).toFixed(3)}</td></tr>`
    ).join("");
    const procedure = r.procedure && r.procedure.trim()
      ? escapeHtml(r.procedure.trim()).replace(/\n/g, "<br/>")
      : "<em>(sin procedimiento cargado)</em>";
    return `
    <div class="recipe">
      <div class="recipe-header">
        <h2>${escapeHtml(r.name)}</h2>
        <p>${escapeHtml(r.category || "-")} · ${batches > 1 ? `×${batches} tandas · ${r.portions * batches} porciones` : `${r.portions} porciones`}</p>
      </div>
      <div class="recipe-body">
        <p class="section-title">Ingredientes</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Ingrediente</th><th>Cant. cargada</th><th>Unidad</th><th>Cant. según selección${batches > 1 ? ` (×${batches})` : ""}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="section-title">Procedimiento</p>
        <div class="procedure">${procedure}</div>
      </div>
    </div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Recetario — Misky Mikuy</title>
<style>
  :root { --brand: #612577; --brand-dark: #351740; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; margin: 0; padding: 0 0 24px; background: #f3f4f6; }
  .page-header { background: linear-gradient(135deg, var(--brand-dark), var(--brand)); padding: 18px 16px; display: flex; align-items: center; gap: 16px; }
  .page-header img { height: 44px; }
  .page-header h1 { color: white; font-size: 21px; margin: 0; }
  .page-header p { color: #e7d6ee; font-size: 14px; margin: 2px 0 0; }
  .recipe { background: white; margin: 16px auto 0; max-width: 760px; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); page-break-inside: avoid; }
  .recipe-header { background: var(--brand); color: white; padding: 16px 16px; }
  .recipe-header h2 { margin: 0; font-size: 22px; }
  .recipe-header p { margin: 4px 0 0; font-size: 14px; color: #ecdcf2; }
  .recipe-body { padding: 16px 14px; }
  .section-title { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--brand); font-weight: 700; margin: 0 0 8px; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 16px; }
  th { text-align: left; color: #6b7280; font-size: 11px; text-transform: uppercase; padding: 6px 5px; border-bottom: 2px solid #e5e7eb; }
  td { padding: 8px 6px; border-bottom: 1px solid #f3f4f6; }
  td.qty-cell { font-weight: 700; color: var(--brand-dark); }
  tr:last-child td { border-bottom: none; }
  .procedure { font-size: 16px; line-height: 1.6; color: #374151; }
  .footer { text-align: center; font-size: 12px; color: #9ca3af; padding: 20px 14px; }
  .print-btn { position: fixed; top: 20px; right: 24px; background: white; color: var(--brand); border: none; border-radius: 999px; padding: 10px 20px; font-size: 14px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.15); cursor: pointer; }
  .print-btn:hover { background: #f9f4fb; }
  @media print {
    body { background: white; }
    .recipe { box-shadow: none; border: 1px solid #e5e7eb; margin-top: 0; }
    .recipe + .recipe { page-break-before: always; margin-top: 0; }
    .footer { page-break-before: avoid; }
    .page-header, .recipe-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .print-btn { display: none; }
  }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
  <div class="page-header">
    <img src="data:image/png;base64,${LOGO_MM_BASE64}" alt="Misky Mikuy" />
    <div>
      <h1>RecetApp</h1>
      <p>Recetario · Misky Mikuy</p>
    </div>
  </div>
  ${recipesHtml}
  <div class="footer">Generado desde RecetApp · ${fecha}</div>
</body>
</html>`;

  downloadHTMLFile(html, "RecetApp_MiskyMikuy_Recetas.html");
}

// Genera una lista de compras imprimible en HTML, sumando los ingredientes de
// todas las recetas seleccionadas (usa la cantidad tal cual está cargada en
// cada receta, sin pedir porciones extra) y agrupada por rubro.
function downloadShoppingListHTML(selectedRecipes, ingredients, business) {
  const selections = selectedRecipes.map(r => ({ recipeId: r.id, portionsMade: r.portions * (r._batches || 1) }));
  const report = calcProductionReport(selections, selectedRecipes, ingredients, business);
  const fecha = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });

  const byCategory = {};
  report.ingredientRows.forEach(row => {
    const cat = row.ing.category || "General";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(row);
  });
  const sortedCategories = Object.entries(byCategory)
    .sort(([catA], [catB]) => catA.localeCompare(catB, "es", { sensitivity: "base" }))
    .map(([cat, rows]) => [
      cat,
      [...rows].sort((a, b) => a.ing.name.localeCompare(b.ing.name, "es", { sensitivity: "base" })),
    ]);

  // Algunos ingredientes no se compran fraccionados (ej. latas, paquetes,
  // unidades sueltas) — para esos, redondea la cantidad a comprar hacia
  // arriba, al entero más cercano. Los que se compran a granel (kg, lt, g,
  // ml) se dejan tal cual, con decimales.
  const DISCRETE_UNITS = ["unidad", "u", "docena", "unid", "un"];
  const qtyToBuy = (row) => {
    const unit = normalizeText(row.ing.unit);
    return DISCRETE_UNITS.includes(unit) ? Math.ceil(row.qty) : row.qty;
  };

  let rowCounter = 0;
  const categoriesHtml = sortedCategories.map(([cat, rows]) => {
    const catTotal = rows.reduce((s, r) => s + qtyToBuy(r) * unitCost(r.ing), 0);
    return `
    <div class="cat-block">
      <h3>${escapeHtml(cat)} <span class="cat-total">$${catTotal.toLocaleString("es-AR", {maximumFractionDigits:2})}</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th class="chk-col"></th><th>Ingrediente</th><th>Cant.</th><th>Unidad</th><th>P. unit.</th><th>Total</th><th class="col-para">Para</th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const buy = qtyToBuy(r);
            const unitPrice = unitCost(r.ing);
            const rowTotal = buy * unitPrice;
            const roundedFlag = buy !== r.qty ? ` <span class="rounded" title="Redondeado, no se compra fraccionado">(necesita ${r.qty.toFixed(3)})</span>` : "";
            const key = "row" + (rowCounter++);
            return `<tr data-key="${key}" data-total="${rowTotal}"><td class="chk-cell"><input type="checkbox" class="buy-check" id="${key}" /></td><td><label for="${key}">${escapeHtml(r.ing.name)}</label></td><td>${buy.toFixed(DISCRETE_UNITS.includes(normalizeText(r.ing.unit)) ? 0 : 3)}${roundedFlag}</td><td>${escapeHtml(r.ing.unit)}</td><td>$${unitPrice.toLocaleString("es-AR",{maximumFractionDigits:2})}</td><td class="price-total">$${rowTotal.toLocaleString("es-AR",{maximumFractionDigits:2})}</td><td class="small col-para">${escapeHtml(r.recipeNames.join(", "))}</td></tr>`;
          }).join("")}
        </tbody>
      </table></div>
    </div>`;
  }).join("");

  const totalRows = rowCounter;
  const grandTotal = sortedCategories.reduce((s, [, rows]) => s + rows.reduce((s2, r) => s2 + qtyToBuy(r) * unitCost(r.ing), 0), 0);
  const listId = (selectedRecipes.map(r => r.id).sort().join("-") + "_" + fecha).replace(/[^a-zA-Z0-9_-]/g, "");

  const recetasResumen = selectedRecipes.map(r => {
    const batches = r._batches || 1;
    return batches > 1
      ? `${escapeHtml(r.name)} ×${batches} tandas (${r.portions * batches} porc.)`
      : `${escapeHtml(r.name)} (${r.portions} porc.)`;
  }).join(" · ");

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Lista de compras — Misky Mikuy</title>
<style>
  :root { --brand: #612577; --brand-dark: #351740; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; margin: 0; padding: 0 0 24px; background: #f3f4f6; }
  .page-header { background: linear-gradient(135deg, var(--brand-dark), var(--brand)); padding: 18px 16px; display: flex; align-items: center; gap: 16px; }
  .page-header img { height: 44px; }
  .page-header h1 { color: white; font-size: 21px; margin: 0; }
  .page-header p { color: #e7d6ee; font-size: 14px; margin: 2px 0 0; }
  .wrap { max-width: 760px; margin: 16px auto 0; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .recetas-resumen { padding: 12px 14px; font-size: 14px; color: #6b7280; border-bottom: 1px solid #f3f4f6; }
  .summary-box { padding: 14px 14px; border-bottom: 1px solid #f3f4f6; background: #f9f4fb; }
  .summary-top { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .summary-top .label { font-size: 14px; color: #4b5563; }
  .summary-top .amount { font-size: 26px; font-weight: 800; color: var(--brand-dark); }
  .summary-progress-row { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: var(--brand-dark); font-weight: 600; margin-bottom: 6px; }
  .progress-track { background: #e2c6ec; border-radius: 999px; height: 8px; overflow: hidden; }
  .progress-fill { background: var(--brand); height: 100%; border-radius: 999px; width: 0%; transition: width .2s ease; }
  .remaining-row { margin-top: 10px; font-size: 14px; color: #4b5563; }
  .remaining-row strong { color: #d97706; font-size: 17px; }
  .cat-total { float: right; color: #6b7280; font-weight: 400; text-transform: none; letter-spacing: normal; }
  .price-total { font-weight: 600; color: var(--brand); }
  .rounded { font-size: 10px; color: #d97706; font-weight: 400; }
  .cat-block { padding: 12px 14px; border-bottom: 1px solid #f3f4f6; }
  .cat-block:last-child { border-bottom: none; }
  .cat-block h3 { font-size: 14px; text-transform: uppercase; letter-spacing: .05em; color: var(--brand); font-weight: 700; margin: 0 0 10px; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th { text-align: left; color: #6b7280; font-size: 11px; text-transform: uppercase; padding: 6px 5px; border-bottom: 2px solid #e5e7eb; }
  th.chk-col { width: 36px; }
  td { padding: 8px 6px; border-bottom: 1px solid #f3f4f6; }
  td.chk-cell { width: 36px; text-align: center; padding: 7px 4px; }
  td.small { font-size: 12px; color: #9ca3af; }
  tr:last-child td { border-bottom: none; }
  .buy-check { width: 22px; height: 22px; cursor: pointer; accent-color: var(--brand); }
  tr.bought td { color: #b0b7c1; text-decoration: line-through; }
  tr.bought .price-total { color: #b0b7c1; }
  label { cursor: pointer; }
  .footer { text-align: center; font-size: 12px; color: #9ca3af; padding: 20px 14px; }
  .print-btn { position: fixed; top: 20px; right: 24px; background: white; color: var(--brand); border: none; border-radius: 999px; padding: 10px 20px; font-size: 14px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.15); cursor: pointer; }
  .print-btn:hover { background: #f9f4fb; }
  .reset-btn { background: none; border: none; color: #9ca3af; font-size: 11px; text-decoration: underline; cursor: pointer; padding: 0; }
  @media (max-width: 480px) {
    .col-para { display: none; }
  }
  @media print {
    body { background: white; }
    .wrap { box-shadow: none; border: 1px solid #e5e7eb; }
    .page-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .print-btn { display: none; }
    .reset-btn { display: none; }
  }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
  <div class="page-header">
    <img src="data:image/png;base64,${LOGO_MM_BASE64}" alt="Misky Mikuy" />
    <div>
      <h1>RecetApp</h1>
      <p>Lista de compras · Misky Mikuy</p>
    </div>
  </div>
  <div class="wrap">
    <div class="summary-box">
      <div class="summary-top">
        <span class="label">Total de la compra</span>
        <span class="amount">$${grandTotal.toLocaleString("es-AR",{maximumFractionDigits:2})}</span>
      </div>
      <div class="summary-progress-row">
        <span>Comprado: <span id="progressCount">0/${totalRows}</span></span>
        <button class="reset-btn" onclick="window.recetappResetCompras && window.recetappResetCompras()">Reiniciar tildes</button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="progressBarFill"></div></div>
      <div class="remaining-row">Falta comprar: <strong id="remainingTotal">$${grandTotal.toLocaleString("es-AR",{maximumFractionDigits:2})}</strong></div>
    </div>
    ${categoriesHtml}
  </div>
  <div class="footer">Generado desde RecetApp · ${fecha} · Tildá cada producto a medida que lo vas comprando — se guarda solo en este dispositivo.</div>
  <script>
  (function(){
    var STORAGE_KEY = "recetapp_compra_${listId}";
    var state = {};
    try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch(e) {}
    var rows = Array.prototype.slice.call(document.querySelectorAll("tr[data-key]"));
    var totalGeneral = ${grandTotal};
    function save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
    }
    function updateSummary() {
      var checkedCount = 0, checkedTotal = 0;
      rows.forEach(function(tr){
        var key = tr.getAttribute("data-key");
        if (state[key]) { checkedCount++; checkedTotal += parseFloat(tr.getAttribute("data-total")) || 0; }
      });
      document.getElementById("progressCount").textContent = checkedCount + "/" + rows.length;
      var pct = rows.length ? Math.round((checkedCount / rows.length) * 100) : 0;
      document.getElementById("progressBarFill").style.width = pct + "%";
      var remaining = totalGeneral - checkedTotal;
      document.getElementById("remainingTotal").textContent = "$" + remaining.toLocaleString("es-AR", {maximumFractionDigits:2});
    }
    rows.forEach(function(tr){
      var key = tr.getAttribute("data-key");
      var chk = tr.querySelector(".buy-check");
      if (state[key]) { chk.checked = true; tr.classList.add("bought"); }
      chk.addEventListener("change", function(){
        state[key] = chk.checked;
        tr.classList.toggle("bought", chk.checked);
        save();
        updateSummary();
      });
    });
    window.recetappResetCompras = function(){
      state = {};
      save();
      rows.forEach(function(tr){
        var chk = tr.querySelector(".buy-check");
        chk.checked = false;
        tr.classList.remove("bought");
      });
      updateSummary();
    };
    updateSummary();
  })();
  </script>
</body>
</html>`;

  downloadHTMLFile(html, "RecetApp_MiskyMikuy_Lista_de_compras.html");
}

// Genera una lista de "mise en place": para las recetas elegidas, suma cuánto
// se necesita de cada ingrediente en total (sin redondear para compra, sin
// precios) para que la cocina pueda pesar/preparar todo de una sola vez.
function downloadMisePrepHTML(selectedRecipes, ingredients, business) {
  const selections = selectedRecipes.map(r => ({ recipeId: r.id, portionsMade: r.portions * (r._batches || 1) }));
  const report = calcProductionReport(selections, selectedRecipes, ingredients, business);
  const fecha = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });

  const byCategory = {};
  report.ingredientRows.forEach(row => {
    const cat = row.ing.category || "General";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(row);
  });
  const sortedCategories = Object.entries(byCategory)
    .sort(([catA], [catB]) => catA.localeCompare(catB, "es", { sensitivity: "base" }))
    .map(([cat, rows]) => [
      cat,
      [...rows].sort((a, b) => a.ing.name.localeCompare(b.ing.name, "es", { sensitivity: "base" })),
    ]);

  const fmtQty = (n) => (Math.round(n * 1000) / 1000).toLocaleString("es-AR", { maximumFractionDigits: 3 });

  let rowCounter = 0;
  const categoriesHtml = sortedCategories.map(([cat, rows]) => `
    <div class="cat-block">
      <h3>${escapeHtml(cat)}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th class="chk-col"></th><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th><th class="col-para">Para</th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const key = "row" + (rowCounter++);
            return `<tr data-key="${key}"><td class="chk-cell"><input type="checkbox" class="prep-check" id="${key}" /></td><td><label for="${key}">${escapeHtml(r.ing.name)}</label></td><td class="qty-cell">${fmtQty(r.qty)}</td><td>${escapeHtml(r.ing.unit)}</td><td class="small col-para">${escapeHtml(r.recipeNames.join(", "))}</td></tr>`;
          }).join("")}
        </tbody>
      </table></div>
    </div>`).join("");

  const totalRows = rowCounter;
  const listId = (selectedRecipes.map(r => r.id).sort().join("-") + "_mep_" + fecha).replace(/[^a-zA-Z0-9_-]/g, "");

  // Detalle por receta: cuánto de cada ingrediente lleva CADA receta elegida
  // (ya escalado por la cantidad de tandas), para armar/cocinar cada plato.
  const perRecipeHtml = selectedRecipes.map(r => {
    const batches = r._batches || 1;
    const calc = calcRecipe(r, ingredients, business);
    const lines = [...calc.lines].sort((a, b) => a.ing.name.localeCompare(b.ing.name, "es", { sensitivity: "base" }));
    return `
    <div class="recipe-block">
      <h3>${escapeHtml(r.name)} <span class="recipe-meta">${batches > 1 ? `×${batches} tandas · ` : ""}${r.portions * batches} porciones</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Unidad</th></tr></thead>
        <tbody>
          ${lines.map(l => `<tr><td>${escapeHtml(l.ing.name)}</td><td class="qty-cell">${fmtQty(l.qty * batches)}</td><td>${escapeHtml(l.ing.unit)}</td></tr>`).join("")}
          ${lines.length === 0 ? `<tr><td colspan="3" class="small">Sin ingredientes cargados</td></tr>` : ""}
        </tbody>
      </table></div>
    </div>`;
  }).join("");

  const recetasResumen = selectedRecipes.map(r => {
    const batches = r._batches || 1;
    return batches > 1
      ? `${escapeHtml(r.name)} ×${batches} tandas (${r.portions * batches} porc.)`
      : `${escapeHtml(r.name)} (${r.portions} porc.)`;
  }).join(" · ");

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Mise en place — Misky Mikuy</title>
<style>
  :root { --brand: #612577; --brand-dark: #351740; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; margin: 0; padding: 0 0 24px; background: #f3f4f6; }
  .page-header { background: linear-gradient(135deg, var(--brand-dark), var(--brand)); padding: 18px 16px; display: flex; align-items: center; gap: 16px; }
  .page-header img { height: 44px; }
  .page-header h1 { color: white; font-size: 21px; margin: 0; }
  .page-header p { color: #e7d6ee; font-size: 14px; margin: 2px 0 0; }
  .wrap { max-width: 760px; margin: 16px auto 0; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .recetas-resumen { padding: 12px 14px; font-size: 14px; color: #6b7280; border-bottom: 1px solid #f3f4f6; }
  .summary-box { padding: 14px 14px; border-bottom: 1px solid #f3f4f6; background: #f9f4fb; }
  .summary-progress-row { display: flex; justify-content: space-between; align-items: center; font-size: 14px; color: var(--brand-dark); font-weight: 600; margin-bottom: 8px; }
  .progress-track { background: #e2c6ec; border-radius: 999px; height: 8px; overflow: hidden; }
  .progress-fill { background: var(--brand); height: 100%; border-radius: 999px; width: 0%; transition: width .2s ease; }
  .cat-block { padding: 12px 14px; border-bottom: 1px solid #f3f4f6; }
  .cat-block:last-child { border-bottom: none; }
  .cat-block h3 { font-size: 14px; text-transform: uppercase; letter-spacing: .05em; color: var(--brand); font-weight: 700; margin: 0 0 10px; }
  .section-title { padding: 14px 14px 4px; font-size: 16px; font-weight: 800; color: var(--brand-dark); }
  .recipe-block { padding: 12px 14px; border-bottom: 1px solid #f3f4f6; }
  .recipe-block:last-child { border-bottom: none; }
  .recipe-block h3 { font-size: 15px; color: #1f2937; font-weight: 700; margin: 0 0 8px; }
  .recipe-meta { font-size: 12px; color: #9ca3af; font-weight: 500; text-transform: none; letter-spacing: normal; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th { text-align: left; color: #6b7280; font-size: 11px; text-transform: uppercase; padding: 6px 5px; border-bottom: 2px solid #e5e7eb; }
  th.chk-col { width: 36px; }
  td { padding: 8px 6px; border-bottom: 1px solid #f3f4f6; }
  td.chk-cell { width: 36px; text-align: center; padding: 7px 4px; }
  td.qty-cell { font-weight: 700; color: var(--brand-dark); }
  td.small { font-size: 12px; color: #9ca3af; }
  tr:last-child td { border-bottom: none; }
  .prep-check { width: 22px; height: 22px; cursor: pointer; accent-color: var(--brand); }
  tr.done td { color: #b0b7c1; text-decoration: line-through; }
  label { cursor: pointer; }
  .footer { text-align: center; font-size: 12px; color: #9ca3af; padding: 20px 14px; }
  .print-btn { position: fixed; top: 20px; right: 24px; background: white; color: var(--brand); border: none; border-radius: 999px; padding: 10px 20px; font-size: 14px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.15); cursor: pointer; }
  .print-btn:hover { background: #f9f4fb; }
  .reset-btn { background: none; border: none; color: #9ca3af; font-size: 11px; text-decoration: underline; cursor: pointer; padding: 0; }
  @media (max-width: 480px) {
    .col-para { display: none; }
  }
  @media print {
    body { background: white; }
    .wrap { box-shadow: none; border: 1px solid #e5e7eb; }
    .page-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .print-btn { display: none; }
    .reset-btn { display: none; }
  }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
  <div class="page-header">
    <img src="data:image/png;base64,${LOGO_MM_BASE64}" alt="Misky Mikuy" />
    <div>
      <h1>RecetApp</h1>
      <p>Mise en place · Misky Mikuy</p>
    </div>
  </div>
  <div class="wrap">
    <div class="recetas-resumen">${recetasResumen}</div>
    <div class="summary-box">
      <div class="summary-progress-row">
        <span>Preparado: <span id="progressCount">0/${totalRows}</span></span>
        <button class="reset-btn" onclick="window.recetappResetPrep && window.recetappResetPrep()">Reiniciar tildes</button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="progressBarFill"></div></div>
    </div>
    ${categoriesHtml}
  </div>
  <div class="wrap">
    <div class="section-title">📋 Detalle por receta</div>
    ${perRecipeHtml}
  </div>
  <div class="footer">Generado desde RecetApp · ${fecha} · Tildá cada ingrediente a medida que lo vas pesando/preparando — se guarda solo en este dispositivo.</div>
  <script>
  (function(){
    var STORAGE_KEY = "recetapp_mep_${listId}";
    var state = {};
    try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch(e) {}
    var rows = Array.prototype.slice.call(document.querySelectorAll("tr[data-key]"));
    function save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
    }
    function updateSummary() {
      var checkedCount = 0;
      rows.forEach(function(tr){
        var key = tr.getAttribute("data-key");
        if (state[key]) checkedCount++;
      });
      document.getElementById("progressCount").textContent = checkedCount + "/" + rows.length;
      var pct = rows.length ? Math.round((checkedCount / rows.length) * 100) : 0;
      document.getElementById("progressBarFill").style.width = pct + "%";
    }
    rows.forEach(function(tr){
      var key = tr.getAttribute("data-key");
      var chk = tr.querySelector(".prep-check");
      if (state[key]) { chk.checked = true; tr.classList.add("done"); }
      chk.addEventListener("change", function(){
        state[key] = chk.checked;
        tr.classList.toggle("done", chk.checked);
        save();
        updateSummary();
      });
    });
    window.recetappResetPrep = function(){
      state = {};
      save();
      rows.forEach(function(tr){
        var chk = tr.querySelector(".prep-check");
        chk.checked = false;
        tr.classList.remove("done");
      });
      updateSummary();
    };
    updateSummary();
  })();
  </script>
</body>
</html>`;

  downloadHTMLFile(html, "RecetApp_MiskyMikuy_Mise_en_place.html");
}

function exportCSV(recipes, ingredients, business) {
  const S = ";";
  const n = (v) => v.toString().replace(".", ",");
  let csv = "sep=;\nCOSTEO DE RECETAS\n\n";
  recipes.forEach(r => {
    const c = calcRecipe(r, ingredients, business);
    csv += `RECETA${S}${r.name}\nCategoría${S}${r.category}\nPorciones${S}${r.portions}\n\n`;
    csv += `Ingrediente${S}Unidad${S}Cantidad${S}Costo neto/u ($)${S}Subtotal ($)\n`;
    c.lines.forEach(l => {
      csv += `${l.ing.name}${S}${l.ing.unit}${S}${n(l.qty.toFixed(3))}${S}${n(l.unitCost.toFixed(4))}${S}${n(l.subtotal.toFixed(2))}\n`;
    });
    csv += `\nCosto MP total${S}${S}${S}${S}${n(c.mpTotal.toFixed(2))}\n`;
    csv += `Costo MP x porción${S}${S}${S}${S}${n(c.mpPerPortion.toFixed(2))}\n`;
    csv += `Costo fijo x porción${S}${S}${S}${S}${n(c.cfPerUnit.toFixed(2))}\n`;
    csv += `Costos variables (${n((c.varPct*100).toFixed(1))}%)${S}${S}${S}${S}${n(c.varCost.toFixed(2))}\n`;
    csv += `COSTO TOTAL x porción${S}${S}${S}${S}${n(c.totalCost.toFixed(2))}\n`;
    csv += `PRECIO REDONDEADO${S}${S}${S}${S}${n(c.roundedPrice.toFixed(2))}\n`;
    csv += `Ganancia real %${S}${S}${S}${S}${n(c.realProfitPct.toFixed(1))}%\n\n\n`;
  });
  downloadCSV(csv, "RecetApp_Costeo.csv");
}

function exportIngredientsCSV(ingredients) {
  const S = ";";
  const n = (v) => v.toString().replace(".", ",");
  let csv = "sep=;\nINGREDIENTES\n\n";
  csv += `Nombre${S}Categoría${S}Unidad${S}Precio compra${S}Cantidad${S}Merma %${S}Costo neto/u\n`;
  ingredients.forEach(ing => {
    const uc = ing.buy_qty > 0 ? ing.buy_price / ing.buy_qty : 0;
    const net = ing.waste_pct > 0 ? uc / (1 - ing.waste_pct / 100) : uc;
    csv += `${ing.name}${S}${ing.category}${S}${ing.unit}${S}${n(ing.buy_price)}${S}${n(ing.buy_qty)}${S}${n(ing.waste_pct)}${S}${n(net.toFixed(4))}\n`;
  });
  downloadCSV(csv, "RecetApp_Ingredientes.csv");
}

function exportBusinessCSV(business) {
  const S = ";";
  const n = (v) => v.toString().replace(".", ",");
  const totalFixed = (business.fixed_costs || []).reduce((s, c) => s + (c.amount || 0), 0);
  const cfUnit = business.monthly_units > 0 ? totalFixed / business.monthly_units : 0;
  let csv = "sep=;\nCONFIGURACIÓN DE COSTOS\n\n";
  csv += `COSTOS FIJOS MENSUALES\n`;
  csv += `Concepto${S}Monto ($)\n`;
  (business.fixed_costs || []).forEach(c => {
    csv += `${c.name}${S}${n(c.amount)}\n`;
  });
  csv += `\nTOTAL COSTOS FIJOS${S}${n(totalFixed)}\n\n`;
  csv += `PRODUCCIÓN Y COSTOS VARIABLES\n`;
  csv += `Unidades por mes${S}${n(business.monthly_units)}\n`;
  csv += `Costo fijo x unidad${S}${n(cfUnit.toFixed(2))}\n`;
  csv += `% Delivery/plataformas${S}${n(business.delivery_pct)}\n`;
  csv += `% IVA${S}${n(business.iva_pct)}\n`;
  csv += `% Otros variables${S}${n(business.other_var_pct)}\n`;
  downloadCSV(csv, "RecetApp_Costos.csv");
}

// ─── UI PRIMITIVES ────────────────────────────────────────────────────────────
// Asigna un color (tono HSL parejo) a cada categoría distinta, para poder
// distinguirlas de un vistazo aunque haya muchas — no depende de una lista
// fija de categorías conocidas de antemano.
function buildCategoryColorMap(categories) {
  const uniq = Array.from(new Set(categories.map(c => c || "Sin categoría"))).sort((a, b) => a.localeCompare(b, "es"));
  const map = {};
  uniq.forEach((cat, idx) => {
    const hue = Math.round((idx / uniq.length) * 360);
    map[cat] = { bg: `hsl(${hue}, 70%, 93%)`, text: `hsl(${hue}, 60%, 30%)` };
  });
  return map;
}
function CategoryTag({ category, colors }) {
  const { bg, text } = colors || { bg: "#f3f4f6", text: "#4b5563" };
  return (
    <span className="text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap" style={{ backgroundColor: bg, color: text }}>
      {category || "Sin categoría"}
    </span>
  );
}

function Pill({ children, color = "misky" }) {
  const map = {
    misky: "bg-misky-100 text-misky-700",
    amber:   "bg-amber-100 text-amber-700",
    rose:    "bg-rose-100 text-rose-700",
    sky:     "bg-sky-100 text-sky-700",
    violet:  "bg-violet-100 text-violet-700",
    gray:    "bg-gray-100 text-gray-600",
  };
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${map[color] || map.misky}`}>{children}</span>;
}
function StatCard({ label, value, sub, accent = "misky" }) {
  const map = {
    misky: "border-l-misky-500 bg-misky-50",
    amber:   "border-l-amber-500 bg-amber-50",
    rose:    "border-l-rose-500 bg-rose-50",
    sky:     "border-l-sky-500 bg-sky-50",
  };
  return (
    <div className={`border-l-4 ${map[accent]} rounded-r-xl p-4`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">{label}</p>
      <p className="text-2xl font-bold text-gray-800 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-2xl shadow-2xl ${wide ? "max-w-3xl" : "max-w-lg"} w-full max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="font-bold text-gray-800 text-lg">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div>
      {label && <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>}
      {children}
    </div>
  );
}
function TextInput({ value, onChange, type = "text", placeholder, suffix, step, min, max, disabled }) {
  return (
    <div className="relative">
      <input
        type={type} value={value} onChange={onChange}
        placeholder={placeholder} step={step} min={min} max={max} disabled={disabled}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-400 bg-white disabled:bg-gray-50 disabled:text-gray-400"
      />
      {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">{suffix}</span>}
    </div>
  );
}
function Btn({ children, onClick, variant = "primary", size = "md", disabled = false, className = "" }) {
  const v = {
    primary:   "bg-misky-600 hover:bg-misky-700 text-white",
    secondary: "bg-white border border-gray-200 hover:bg-gray-50 text-gray-700",
    danger:    "bg-rose-500 hover:bg-rose-600 text-white",
    ghost:     "hover:bg-gray-100 text-gray-600",
  };
  const s = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-6 py-3 text-base" };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`font-medium rounded-lg transition-colors ${v[variant]} ${s[size]} ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}>
      {children}
    </button>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
// ─── ELEGIR NUEVA CONTRASEÑA (link de "olvidé mi contraseña") ────────────────
function SetNewPasswordScreen({ onDone }) {
  const [pw, setPw]           = useState("");
  const [pw2, setPw2]         = useState("");
  const [error, setError]     = useState("");
  const [saving, setSaving]   = useState(false);

  const save = async () => {
    setError("");
    if (pw.length < 6) return setError("La contraseña debe tener al menos 6 caracteres.");
    if (pw !== pw2) return setError("Las dos contraseñas no coinciden.");
    setSaving(true);
    const { error: err } = await supabase.auth.updateUser({ password: pw });
    setSaving(false);
    if (err) return setError("No se pudo guardar: " + err.message);
    onDone();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
         style={{ background: "linear-gradient(135deg,#351740 0%,#612577 55%,#8C1117 100%)" }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-6xl mb-3">🔑</div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Elegí una nueva contraseña</h1>
        </div>
        <div className="bg-white rounded-2xl shadow-2xl p-7 space-y-4">
          <Field label="Contraseña nueva">
            <TextInput value={pw} onChange={e => setPw(e.target.value)} type="password" placeholder="••••••••" />
          </Field>
          <Field label="Repetila">
            <TextInput value={pw2} onChange={e => setPw2(e.target.value)} type="password" placeholder="••••••••" />
          </Field>
          {error && <p className="text-rose-500 text-sm bg-rose-50 px-3 py-2 rounded-lg">{error}</p>}
          <Btn onClick={save} className="w-full" size="lg" disabled={saving}>
            {saving ? "Guardando..." : "Guardar y entrar"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [form, setForm]   = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const handle = async () => {
    setError(""); setLoading(true);
    const { data, error: err } = await supabase.auth.signInWithPassword({
      email: form.email, password: form.password
    });
    setLoading(false);
    if (err) return setError("Email o contraseña incorrectos.");
    onLogin(data.user);
  };

  const handleGoogle = async () => {
    setError(""); setGoogleLoading(true);
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    // Si hay error se dispara al toque (ej: proveedor no habilitado). Si no,
    // el navegador redirige a Google y volvemos con la sesión ya iniciada.
    if (err) { setGoogleLoading(false); setError("No se pudo iniciar con Google: " + err.message); }
  };

  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  return (
    <div className="min-h-screen flex items-center justify-center p-4"
         style={{ background: "linear-gradient(135deg,#351740 0%,#612577 55%,#8C1117 100%)" }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img src="/logo-blanco.svg" alt="Misky Mikuy" className="h-16 mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-white tracking-tight">RecetApp</h1>
          <p className="text-misky-200 text-sm mt-1">Costeo inteligente de recetas</p>
        </div>
        <div className="bg-white rounded-2xl shadow-2xl p-7">
          <button onClick={handleGoogle} disabled={googleLoading}
            className="w-full flex items-center justify-center gap-2 border border-gray-200 rounded-xl py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-60">
            <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.87 2.7-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.6 8.6 0 0 0 9 0 9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
            {googleLoading ? "Redirigiendo..." : "Continuar con Google"}
          </button>
          <div className="flex items-center gap-3 my-4">
            <div className="h-px bg-gray-100 flex-1" /><span className="text-xs text-gray-400">o con tu cuenta</span><div className="h-px bg-gray-100 flex-1" />
          </div>
          <div className="space-y-4">
            <Field label="Email">
              <TextInput value={form.email} onChange={f("email")} type="email" placeholder="tu@email.com" />
            </Field>
            <Field label="Contraseña">
              <TextInput value={form.password} onChange={f("password")} type="password" placeholder="••••••••" />
            </Field>
            {error && <p className="text-rose-500 text-sm bg-rose-50 px-3 py-2 rounded-lg">{error}</p>}
            <Btn onClick={handle} className="w-full" size="lg" disabled={loading}>
              {loading ? "Entrando..." : "Entrar"}
            </Btn>
          </div>
          <p className="text-xs text-gray-400 text-center mt-4">Tu cuenta es creada por el administrador</p>
        </div>
      </div>
    </div>
  );
}

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
// Permisos granulares por sección y acción (solo admin puede asignar)
// ─── PERMISSION GROUPS ────────────────────────────────────────────────────────
// Cada pestaña tiene grupos de campos: { ver: bool, editar: bool }
// dashboard: stats, costos_stats, tabla_recetas
// recipes: basicos, ingredientes, costos, precio_sugerido, precio_redondeado, ganancia
// ingredients: basicos, precios_compra, costo_neto
// business: costos_fijos, produccion_variables

const PERM_GROUPS = {
  dashboard:   ["stats", "costos_stats", "tabla_recetas"],
  recipes:     ["basicos", "ingredientes", "costos", "precio_sugerido", "precio_redondeado", "ganancia"],
  ingredients: ["basicos", "precios_compra", "costo_neto"],
  business:    ["costos_fijos", "produccion_variables"],
};

const GROUP_LABELS = {
  dashboard:   { stats: "📊 Estadísticas generales", costos_stats: "💰 Datos de costos", tabla_recetas: "📋 Tabla de recetas" },
  recipes:     { basicos: "📋 Datos básicos", ingredientes: "🧾 Ingredientes", costos: "💰 Costos", precio_sugerido: "💵 Precio sugerido", precio_redondeado: "🎯 Precio redondeado", ganancia: "📈 Ganancia %" },
  ingredients: { basicos: "📋 Datos básicos", precios_compra: "💰 Precios de compra", costo_neto: "📊 Costo neto calculado" },
  business:    { costos_fijos: "🏢 Costos fijos", produccion_variables: "📈 Producción y variables" },
};

const makeTabPerms = (ver, editar) => ({ ver, editar });
const makeGroups = (tab, ver, editar) => Object.fromEntries(PERM_GROUPS[tab].map(g => [g, makeTabPerms(ver, editar)]));

// Presets
const PRESETS = {
  admin: {
    label: "👑 Admin", color: "rose",
    perms: {
      dashboard:   makeGroups("dashboard", true, true),
      recipes:     makeGroups("recipes", true, true),
      ingredients: makeGroups("ingredients", true, true),
      business:    makeGroups("business", true, true),
      usuarios: true,
    }
  },
  editor_total: {
    label: "✏️ Editor total", color: "misky",
    perms: {
      dashboard:   makeGroups("dashboard", true, true),
      recipes:     makeGroups("recipes", true, true),
      ingredients: makeGroups("ingredients", true, true),
      business:    makeGroups("business", true, true),
      usuarios: false,
    }
  },
  cocinero: {
    label: "👨‍🍳 Cocinero", color: "amber",
    perms: {
      dashboard:   { stats: makeTabPerms(true,false), costos_stats: makeTabPerms(false,false), tabla_recetas: makeTabPerms(true,false) },
      recipes:     { basicos: makeTabPerms(true,true), ingredientes: makeTabPerms(true,true), costos: makeTabPerms(false,false), precio_sugerido: makeTabPerms(false,false), precio_redondeado: makeTabPerms(true,false), ganancia: makeTabPerms(false,false) },
      ingredients: { basicos: makeTabPerms(true,true), precios_compra: makeTabPerms(true,true), costo_neto: makeTabPerms(false,false) },
      business:    makeGroups("business", false, false),
      usuarios: false,
    }
  },
  mozo: {
    label: "👨‍🍽️ Mozo", color: "sky",
    perms: {
      dashboard:   makeGroups("dashboard", false, false),
      recipes:     { basicos: makeTabPerms(true,false), ingredientes: makeTabPerms(false,false), costos: makeTabPerms(false,false), precio_sugerido: makeTabPerms(false,false), precio_redondeado: makeTabPerms(true,false), ganancia: makeTabPerms(false,false) },
      ingredients: makeGroups("ingredients", false, false),
      business:    makeGroups("business", false, false),
      usuarios: false,
      es_mozo: true,
    }
  },
  cliente: {
    label: "🛒 Cliente", color: "violet",
    perms: {
      dashboard:   makeGroups("dashboard", false, false),
      recipes:     { basicos: makeTabPerms(true,false), ingredientes: makeTabPerms(false,false), costos: makeTabPerms(false,false), precio_sugerido: makeTabPerms(false,false), precio_redondeado: makeTabPerms(true,false), ganancia: makeTabPerms(false,false) },
      ingredients: makeGroups("ingredients", false, false),
      business:    makeGroups("business", false, false),
      usuarios: false,
    }
  },
  proveedor: {
    label: "🏭 Proveedor", color: "gray",
    perms: {
      dashboard:   makeGroups("dashboard", false, false),
      recipes:     makeGroups("recipes", false, false),
      ingredients: { basicos: makeTabPerms(true,false), precios_compra: makeTabPerms(true,false), costo_neto: makeTabPerms(false,false) },
      business:    makeGroups("business", false, false),
      usuarios: false,
    }
  },
  solo_lectura: {
    label: "👁 Solo lectura", color: "sky",
    perms: {
      dashboard:   makeGroups("dashboard", true, false),
      recipes:     makeGroups("recipes", true, false),
      ingredients: makeGroups("ingredients", true, false),
      business:    makeGroups("business", true, false),
      usuarios: false,
    }
  },
};

// Helper: check group permission
const canP = (profile, tab, group, action = "ver") => {
  if (profile?.role === "admin") return true;
  const perms = profile?.permissions;
  if (!perms) return false;
  const tabP = perms[tab];
  if (!tabP) return false;
  const grp = tabP[group];
  if (!grp) return false;
  return grp[action] === true;
};

// Can see tab at all?
const canSeeTabPerms = (profile, tab) => {
  if (profile?.role === "admin") return true;
  if (tab === "admin") return profile?.permissions?.usuarios === true;
  const perms = profile?.permissions;
  if (!perms) return false;
  const tabP = perms[tab];
  if (!tabP) return false;
  return Object.values(tabP).some(g => g?.ver === true);
};

// Can edit anything in tab?
const canEditTabPerms = (profile, tab) => {
  if (profile?.role === "admin") return true;
  const perms = profile?.permissions;
  if (!perms) return false;
  const tabP = perms[tab];
  if (!tabP) return false;
  return Object.values(tabP).some(g => g?.editar === true);
};

// Lista de ids de pestaña visibles para este perfil, en el mismo orden y con
// la misma lógica que se usa para armar el menú — se reutiliza también para
// validar la última pestaña recordada (ver recetapp_last_tab más abajo).
const getVisibleTabIds = (profile) => {
  const esMozo = profile?.permissions?.es_mozo === true;
  const ids = [];
  if (!esMozo && canSeeTabPerms(profile, "dashboard"))   ids.push("dashboard");
  if (!esMozo && canSeeTabPerms(profile, "recipes"))     ids.push("recipes");
  if (!esMozo && canSeeTabPerms(profile, "ingredients")) ids.push("ingredients");
  if (!esMozo && canSeeTabPerms(profile, "business"))    ids.push("business");
  if (esMozo) ids.push("comanda");
  if (!esMozo && canSeeTabPerms(profile, "recipes"))     ids.push("miseenplace");
  if (profile?.permissions?.usuarios === true)           ids.push("admin");
  return ids;
};

const SECTION_LABELS = [
  ["dashboard",   "📊 Resumen"],
  ["recipes",     "🍽️ Recetas"],
  ["ingredients", "📦 Ingredientes"],
  ["business",    "⚙️ Costos"],
];

const DEFAULT_PERMS = PRESETS.solo_lectura.perms;
const FULL_PERMS = PRESETS.admin.perms;

function AdminPanel({ profile }) {
  const [users, setUsers]       = useState([]);
  const [logs, setLogs]         = useState([]);
  const [modal, setModal]       = useState(null);
  const [selected, setSelected] = useState(null);
  const emptyForm = { email: "", username: "", password: "", phone: "", role: "custom", permissions: DEFAULT_PERMS };
  const [form, setForm]         = useState(emptyForm);
  const [msg, setMsg]           = useState("");
  const [tab, setTab]           = useState("users");

  useEffect(() => { loadUsers(); loadLogs(); }, []);

  const loadUsers = async () => {
    const { data } = await supabase.from("profiles").select("*").order("created_at");
    setUsers(data || []);
  };
  const loadLogs = async () => {
    const { data } = await supabase.from("activity_log").select("*").order("created_at", { ascending: false }).limit(100);
    setLogs(data || []);
  };

  // Crear usuario via Edge Function (usa service role key de forma segura)
  const createUser = async () => {
    setMsg("");
    if (!form.email || !form.password || !form.username) return setMsg("Completá email, contraseña y nombre.");
    if (form.password.length < 6) return setMsg("La contraseña debe tener al menos 6 caracteres.");

    const perms = form.role === "admin" ? FULL_PERMS : form.permissions;
    const { data: { session } } = await supabase.auth.getSession();

    const res = await fetch(`${SUPABASE_URL}/functions/v1/create-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session?.access_token}`,
        "apikey": SUPABASE_KEY,
      },
      body: JSON.stringify({
        email: form.email,
        password: form.password,
        username: form.username,
        phone: form.phone || null,
        role: form.role,
        permissions: perms,
      }),
    });

    const result = await res.json();
    if (!res.ok) return setMsg("Error: " + (result.error || "Error desconocido"));

    await logActivity(profile, "create", "usuario", form.username);
    setMsg("✅ Usuario creado correctamente.");
    await loadUsers();
    setTimeout(() => { setModal(null); setMsg(""); }, 1500);
  };

  const updateUser = async () => {
    setMsg("");
    const perms = form.role === "admin" ? FULL_PERMS : form.permissions;
    const { error } = await supabase.from("profiles").update({
      role: form.role,
      username: form.username,
      phone: form.phone || null,
      permissions: perms,
    }).eq("id", selected.id);
    if (error) return setMsg("Error: " + error.message);
    await logActivity(profile, "update", "usuario", form.username);
    setMsg("✅ Usuario actualizado.");
    loadUsers();
    setTimeout(() => { setModal(null); setMsg(""); }, 1500);
  };

  const deleteUser = async (u) => {
    await supabase.from("profiles").delete().eq("id", u.id);
    await logActivity(profile, "delete", "usuario", u.username);
    loadUsers();
  };

  const openEdit = (u) => {
    setSelected(u);
    // Migrate old format if needed
    let perms = u.permissions;
    if (!perms || typeof perms.dashboard === "boolean") {
      perms = DEFAULT_PERMS;
    } else if (perms.dashboard && typeof perms.dashboard.ver === "boolean" && !perms.dashboard.stats) {
      // Old format {ver, editar} per tab — migrate to group format
      perms = DEFAULT_PERMS;
    }
    setForm({ email: "", username: u.username, password: "", role: u.role, phone: u.phone || "", permissions: perms });
    setModal("editUser");
  };

  const setPerm = (section, action, val) => {
    setForm(p => ({
      ...p,
      permissions: {
        ...p.permissions,
        [section]: { ...(p.permissions?.[section] || {}), [action]: val }
      }
    }));
  };

  // Si se activa editar, activar ver también
  const handlePermChange = (section, action, val) => {
    if (action === "editar" && val) setPerm(section, "ver", true);
    if (action === "ver" && !val) setPerm(section, "editar", false);
    setPerm(section, action, val);
  };

  const roleColor = { admin: "rose", editor: "misky", viewer: "sky", custom: "violet" };
  const roleLabel = { admin: "Admin", editor: "Editor", viewer: "Solo lectura", custom: "Personalizado",
    viewer_partial: "Vista parcial" };

  const permSummary = (u) => {
    if (u.role === "admin") return "Acceso total";
    if (!u.permissions) return "—";
    const perms = u.permissions;
    const parts = [];
    // Find matching preset
    const matchedPreset = Object.entries(PRESETS).find(([k, p]) =>
      JSON.stringify(p.perms) === JSON.stringify(perms)
    );
    if (matchedPreset) return matchedPreset[1].label;
    // Manual summary
    SECTION_LABELS.forEach(([key, label]) => {
      const tabP = perms[key];
      if (!tabP) return;
      const hasVer = typeof tabP === "object" && Object.values(tabP).some(g => g?.ver);
      const hasEdit = typeof tabP === "object" && Object.values(tabP).some(g => g?.editar);
      if (hasVer) parts.push(`${label.split(" ")[1]}${hasEdit ? "✏️" : "👁"}`);
    });
    return parts.length ? parts.join(" · ") : "Sin acceso";
  };

  return (
    <div className="space-y-5">
      <div className="flex gap-2 border-b border-gray-200 pb-1">
        {[["users","👥 Usuarios"],["logs","📋 Actividad"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${tab === id ? "bg-white border border-b-white border-gray-200 text-misky-700 -mb-px" : "text-gray-500 hover:text-gray-700"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "users" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-gray-700">Usuarios registrados</h3>
            <div className="flex gap-2">
              <Btn variant="secondary" size="sm" onClick={() => {
                const S = ";";
                let csv = "sep=;\nUSUARIOS\n\nUsuario;Rol;Accesos;Teléfono;Creado\n";
                users.forEach(u => {
                  csv += `${u.username}${S}${u.role}${S}${permSummary(u)}${S}${u.phone||""}${S}${new Date(u.created_at).toLocaleDateString("es-AR")}\n`;
                });
                const blob = new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a"); a.href=url; a.download="RecetApp_Usuarios.csv"; a.click();
                URL.revokeObjectURL(url);
              }}>⬇️ CSV</Btn>
              <Btn onClick={() => { setForm(emptyForm); setMsg(""); setModal("newUser"); }}>
                + Nuevo usuario
              </Btn>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  {["Usuario","Rol","Accesos","Creado",""].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u, idx) => (
                  <tr key={u.id} className={`border-b border-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/30"}`}>
                    <td className="px-4 py-3 font-medium text-gray-800">{u.username}</td>
                    <td className="px-4 py-3"><Pill color={roleColor[u.role] || "gray"}>{roleLabel[u.role] || u.role}</Pill></td>
                    <td className="px-4 py-3 text-xs text-gray-500">{permSummary(u)}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{new Date(u.created_at).toLocaleDateString("es-AR")}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => openEdit(u)} className="text-gray-400 hover:text-misky-600 transition-colors">✏️</button>
                        {u.id !== profile.id && (
                          <button onClick={() => deleteUser(u)} className="text-gray-400 hover:text-rose-500 transition-colors">🗑</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {users.length === 0 && <div className="text-center py-10 text-gray-400">Sin usuarios aún</div>}
          </div>
        </div>
      )}

      {tab === "logs" && (
        <div className="space-y-3">
        <div className="flex justify-end">
          <Btn variant="secondary" size="sm" onClick={() => {
            const S = ";";
            let csv = "sep=;\nACTIVIDAD\n\nFecha;Usuario;Acción;Entidad;Detalle\n";
            logs.forEach(l => {
              csv += `${new Date(l.created_at).toLocaleString("es-AR")}${S}${l.username}${S}${l.action}${S}${l.entity}${S}${l.detail}\n`;
            });
            const blob = new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href=url; a.download="RecetApp_Actividad.csv"; a.click();
            URL.revokeObjectURL(url);
          }}>⬇️ CSV Actividad</Btn>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                {["Fecha","Usuario","Acción","Entidad","Detalle"].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((l, idx) => (
                <tr key={l.id} className={`border-b border-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/30"}`}>
                  <td className="px-4 py-2 text-gray-400 text-xs whitespace-nowrap">
                    {new Date(l.created_at).toLocaleString("es-AR", { dateStyle:"short", timeStyle:"short" })}
                  </td>
                  <td className="px-4 py-2 font-medium text-gray-700">{l.username}</td>
                  <td className="px-4 py-2">
                    <Pill color={l.action==="delete"?"rose":l.action==="create"?"misky":"sky"}>{l.action}</Pill>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{l.entity}</td>
                  <td className="px-4 py-2 text-gray-500">{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && <div className="text-center py-10 text-gray-400">Sin actividad registrada</div>}
        </div>
        </div>
      )}

      {(modal === "newUser" || modal === "editUser") && (
        <Modal title={modal === "newUser" ? "Nuevo usuario" : `Editar: ${selected?.username}`} onClose={() => setModal(null)} wide>
          <div className="space-y-4">
            {modal === "newUser" && (
              <Field label="Email">
                <TextInput value={form.email} onChange={e => setForm(p=>({...p, email: e.target.value}))} type="email" placeholder="usuario@email.com" />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Nombre de usuario">
                <TextInput value={form.username} onChange={e => setForm(p=>({...p, username: e.target.value}))} placeholder="ej: maria" />
              </Field>
              <Field label="Teléfono (opcional)">
                <TextInput value={form.phone} onChange={e => setForm(p=>({...p, phone: e.target.value}))} placeholder="+5493511234567" />
              </Field>
            </div>
            {modal === "newUser" && (
              <Field label="Contraseña (mín. 6 caracteres)">
                <TextInput value={form.password} onChange={e => setForm(p=>({...p, password: e.target.value}))} type="password" placeholder="••••••••" />
              </Field>
            )}

            {/* Permisos granulares — solo admin puede asignar */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">🔐 Accesos y permisos</p>
              </div>
              {/* Presets rápidos */}
              <div className="flex flex-wrap gap-2">
                {Object.entries(PRESETS).map(([key, preset]) => (
                  <button key={key}
                    onClick={() => setForm(p => ({ ...p, role: key === "admin" ? "admin" : "custom", permissions: preset.perms }))}
                    className={`text-xs px-2 py-1 rounded-lg border transition-colors ${
                      JSON.stringify(form.permissions) === JSON.stringify(preset.perms)
                        ? "bg-misky-100 border-misky-400 text-misky-700 font-semibold"
                        : "border-gray-200 text-gray-500 hover:bg-gray-100"
                    }`}>
                    {preset.label}
                  </button>
                ))}
              </div>
              {/* Edición manual por grupos */}
              <details className="group">
                <summary className="cursor-pointer text-xs text-misky-600 font-medium hover:text-misky-700">
                  ✏️ Personalizar manualmente
                </summary>
                <div className="mt-3 space-y-3">
                  {/* Usuarios */}
                  <div className="bg-white rounded-lg border border-gray-100 p-3">
                    <p className="text-xs font-semibold text-gray-600 mb-2">👥 Usuarios</p>
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox"
                        checked={form.permissions?.usuarios === true}
                        onChange={e => setForm(p => ({ ...p, permissions: { ...p.permissions, usuarios: e.target.checked } }))}
                        className="w-4 h-4 accent-rose-500" />
                      Gestionar usuarios (solo Admin)
                    </label>
                  </div>
                  {/* Por pestaña y grupo */}
                  {SECTION_LABELS.map(([tabKey, tabLabel]) => (
                    <div key={tabKey} className="bg-white rounded-lg border border-gray-100 p-3">
                      <p className="text-xs font-semibold text-gray-600 mb-2">{tabLabel}</p>
                      <div className="grid grid-cols-3 gap-1 text-xs text-gray-400 font-semibold uppercase mb-1 px-1">
                        <span>Grupo</span><span className="text-center">Ver</span><span className="text-center">Editar</span>
                      </div>
                      {PERM_GROUPS[tabKey].map(grp => (
                        <div key={grp} className="grid grid-cols-3 gap-1 items-center py-1 border-t border-gray-50">
                          <span className="text-xs text-gray-600">{GROUP_LABELS[tabKey][grp]}</span>
                          <div className="flex justify-center">
                            <input type="checkbox"
                              checked={form.permissions?.[tabKey]?.[grp]?.ver ?? false}
                              onChange={e => {
                                const val = e.target.checked;
                                setForm(p => ({
                                  ...p,
                                  permissions: {
                                    ...p.permissions,
                                    [tabKey]: {
                                      ...p.permissions?.[tabKey],
                                      [grp]: { ver: val, editar: val ? (p.permissions?.[tabKey]?.[grp]?.editar ?? false) : false }
                                    }
                                  }
                                }));
                              }}
                              className="w-4 h-4 accent-sky-500" />
                          </div>
                          <div className="flex justify-center">
                            <input type="checkbox"
                              checked={form.permissions?.[tabKey]?.[grp]?.editar ?? false}
                              disabled={!form.permissions?.[tabKey]?.[grp]?.ver}
                              onChange={e => {
                                const val = e.target.checked;
                                setForm(p => ({
                                  ...p,
                                  permissions: {
                                    ...p.permissions,
                                    [tabKey]: {
                                      ...p.permissions?.[tabKey],
                                      [grp]: { ...p.permissions?.[tabKey]?.[grp], editar: val }
                                    }
                                  }
                                }));
                              }}
                              className="w-4 h-4 accent-misky-500 disabled:opacity-30" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </details>
            </div>

            {msg && <p className={`text-sm px-3 py-2 rounded-lg ${msg.startsWith("✅") ? "bg-misky-50 text-misky-700" : "bg-rose-50 text-rose-600"}`}>{msg}</p>}
            <div className="flex gap-3 justify-end">
              <Btn variant="secondary" onClick={() => setModal(null)}>Cancelar</Btn>
              <Btn onClick={modal === "newUser" ? createUser : updateUser}>
                {modal === "newUser" ? "Crear usuario" : "Guardar cambios"}
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── INGREDIENTS ──────────────────────────────────────────────────────────────

// ─── IMPORT CSV MODAL ────────────────────────────────────────────────────────
function ImportCSVModal({ onClose, onImport }) {
  const [step, setStep]       = useState("upload");
  const [preview, setPreview] = useState([]);
  const [error, setError]     = useState("");
  const [fileName, setFileName] = useState("");
  const fileRef = useRef();

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name); setError("");
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const rows = parseIngredientsCSV(ev.target.result);
        setPreview(rows); setStep("preview");
      } catch (err) { setError(err.message); }
    };
    reader.readAsText(file, "UTF-8");
  };

  return (
    <Modal title="Importar ingredientes desde CSV" onClose={onClose} wide>
      {step === "upload" && (
        <div className="space-y-5">
          <div className="bg-sky-50 border border-sky-100 rounded-xl p-4 text-sm text-sky-800 space-y-2">
            <p className="font-semibold">📋 Formato del archivo</p>
            <p>Columnas (en cualquier orden): <strong>Nombre · Categoría · Unidad · Precio · Cantidad · Merma</strong></p>
            <p className="text-xs text-sky-600">Los ingredientes con el mismo nombre se <strong>actualizan</strong>. Los nuevos se <strong>agregan</strong>.</p>
          </div>
          <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 text-sm space-y-2">
            <p className="font-semibold text-amber-800">📐 Guía de unidades de medida</p>
            <table className="w-full text-xs mt-1">
              <thead><tr className="text-amber-700"><th className="text-left py-1 w-12">Unidad</th><th className="text-left py-1">Cómo cargar en recetas</th></tr></thead>
              <tbody>
                {UNIT_GUIDE.map(g => (
                  <tr key={g.unit} className="border-t border-amber-100">
                    <td className="py-1.5 font-bold text-amber-700">{g.unit}</td>
                    <td className="py-1.5 text-amber-800">{g.recipe}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={() => {
            const c = "sep=;\nNombre;Categoría;Unidad;Precio;Cantidad;Merma\nHarina 000;Secos;kg;450;1;0\nManteca;Lácteos;kg;2100;1;3\n";
            const blob = new Blob(["\uFEFF"+c],{type:"text/csv;charset=utf-8;"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href=url; a.download="plantilla_ingredientes.csv"; a.click();
            URL.revokeObjectURL(url);
          }} className="text-sm text-misky-600 hover:text-misky-700 font-medium underline">
            ⬇️ Descargar plantilla CSV
          </button>
          <div onClick={() => fileRef.current.click()}
            className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center cursor-pointer hover:border-misky-400 hover:bg-misky-50/30 transition-all">
            <div className="text-4xl mb-2">📂</div>
            <p className="text-gray-600 font-medium">Hacé clic para seleccionar el archivo</p>
            <p className="text-xs text-gray-400 mt-1">CSV separado por comas o punto y coma</p>
            <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFile} />
          </div>
          {error && <p className="text-rose-500 text-sm bg-rose-50 px-3 py-2 rounded-lg">⚠️ {error}</p>}
          <div className="flex justify-end"><Btn variant="secondary" onClick={onClose}>Cancelar</Btn></div>
        </div>
      )}
      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg">
            <span>📄</span><span className="font-medium">{fileName}</span>
            <span className="ml-auto text-misky-600 font-semibold">{preview.length} ingredientes</span>
          </div>
          <div className="overflow-x-auto max-h-64 rounded-xl border border-gray-100">
            <table className="w-full text-xs min-w-[480px]">
              <thead className="sticky top-0 bg-gray-50 border-b border-gray-100">
                <tr>{["Nombre","Categoría","Unidad","Precio","Cantidad","Merma %"].map(h=>(
                  <th key={h} className="text-left px-3 py-2 font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {preview.map((r,i)=>(
                  <tr key={i} className={`border-b border-gray-50 ${i%2===0?"bg-white":"bg-gray-50/40"}`}>
                    <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                    <td className="px-3 py-2 text-gray-500">{r.category}</td>
                    <td className="px-3 py-2 text-gray-500">{r.unit}</td>
                    <td className="px-3 py-2 text-gray-700">${r.buy_price?.toLocaleString("es-AR")}</td>
                    <td className="px-3 py-2 text-gray-500">{r.buy_qty}</td>
                    <td className="px-3 py-2">{r.waste_pct>0?<Pill color="rose">{r.waste_pct}%</Pill>:<span className="text-gray-300">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3 justify-end">
            <Btn variant="secondary" onClick={()=>{setStep("upload");setPreview([]);setFileName("");}}>← Volver</Btn>
            <Btn onClick={()=>{onImport(preview);setStep("done");}}>✓ Importar {preview.length} ingredientes</Btn>
          </div>
        </div>
      )}
      {step === "done" && (
        <div className="text-center py-8 space-y-3">
          <div className="text-5xl">✅</div>
          <p className="text-lg font-bold text-gray-800">¡Importación exitosa!</p>
          <p className="text-sm text-gray-500">Se procesaron {preview.length} ingredientes.</p>
          <Btn onClick={onClose} className="mt-2">Cerrar</Btn>
        </div>
      )}
    </Modal>
  );
}

// ─── IMPORT CSV RECETAS ───────────────────────────────────────────────────────
function ImportRecipesCSVModal({ onClose, onImport, recipes, ingredients }) {
  const [step, setStep]         = useState("upload");
  const [preview, setPreview]   = useState([]);
  const [error, setError]       = useState("");
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const fileRef = useRef();

  const actionMeta = {
    add:    { label: "Nueva",       color: "misky" },
    update: { label: "Actualizada", color: "amber" },
    delete: { label: "Eliminar",    color: "rose"  },
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name); setError("");
    const guidance = fileTypeGuidance(file.name);
    if (guidance) { setError(guidance); return; }
    readFileSmartText(file).then(text => {
      try {
        const groups = parseRecipesCSV(text);
        const resolved = resolveRecipeImport(groups, recipes, ingredients);
        setPreview(resolved); setStep("preview");
      } catch (err) { setError(err.message); }
    });
  };

  const counts = {
    add:    preview.filter(r => r.action === "add").length,
    update: preview.filter(r => r.action === "update").length,
    delete: preview.filter(r => r.action === "delete").length,
  };
  const hasUnmatched = preview.some(r => r.unmatched.length > 0);

  const doImport = async () => {
    setImporting(true);
    await onImport(preview);
    setImporting(false);
    setStep("done");
  };

  return (
    <Modal title="Importar recetas desde CSV" onClose={onClose} wide>
      {step === "upload" && (
        <div className="space-y-5">
          <div className="bg-sky-50 border border-sky-100 rounded-xl p-4 text-sm text-sky-800 space-y-2">
            <p className="font-semibold">📋 Formato del archivo</p>
            <p>Columnas: <strong>Receta · Categoría · Porciones · % Ganancia · Ingrediente · Cantidad · Procedimiento · Eliminar</strong></p>
            <p className="text-xs text-sky-600"><strong>Procedimiento es opcional</strong> — podés subir el archivo con o sin esa columna. Completala en una sola fila de la receta (no hace falta repetirla); si la dejás vacía, no borra el procedimiento que ya tenía cargado esa receta.</p>
            <p className="text-xs text-sky-600">Poné una fila por cada ingrediente de la receta, repitiendo el nombre de la receta. Todas las filas con el mismo nombre (sin importar mayúsculas o acentos) se agrupan en una sola receta.</p>
            <p className="text-xs text-sky-600">Recetas que ya existen se <strong>actualizan</strong>; las nuevas se <strong>agregan</strong>. Para borrar una receta completa, poné <strong>SI</strong> en la columna Eliminar en cualquier fila de esa receta (no hace falta completar ingrediente ni cantidad en esa fila).</p>
          </div>
          <button onClick={() => downloadEmptyRecipesTemplate()}
            className="text-sm text-misky-600 hover:text-misky-700 font-medium underline">
            ⬇️ Descargar plantilla CSV
          </button>
          <div onClick={() => fileRef.current.click()}
            className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center cursor-pointer hover:border-misky-400 hover:bg-misky-50/30 transition-all">
            <div className="text-4xl mb-2">📂</div>
            <p className="text-gray-600 font-medium">Hacé clic para seleccionar el archivo</p>
            <p className="text-xs text-gray-400 mt-1">CSV separado por comas o punto y coma</p>
            <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFile} />
          </div>
          {error && <p className="text-rose-500 text-sm bg-rose-50 px-3 py-2 rounded-lg">⚠️ {error}</p>}
          <div className="flex justify-end"><Btn variant="secondary" onClick={onClose}>Cancelar</Btn></div>
        </div>
      )}
      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg flex-wrap">
            <span>📄</span><span className="font-medium">{fileName}</span>
            <span className="ml-auto flex gap-2">
              {counts.add > 0 && <Pill color="misky">{counts.add} nueva{counts.add !== 1 ? "s" : ""}</Pill>}
              {counts.update > 0 && <Pill color="amber">{counts.update} actualizada{counts.update !== 1 ? "s" : ""}</Pill>}
              {counts.delete > 0 && <Pill color="rose">{counts.delete} a eliminar</Pill>}
            </span>
          </div>
          {hasUnmatched && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              ✨ Algunos ingredientes no coinciden por nombre exacto con tu lista actual — se van a <strong>crear automáticamente</strong>, sin precio ni unidad definida, para que los completes después en la pestaña Ingredientes.
            </p>
          )}
          <div className="overflow-x-auto max-h-72 rounded-xl border border-gray-100">
            <table className="w-full text-xs min-w-[560px]">
              <thead className="sticky top-0 bg-gray-50 border-b border-gray-100">
                <tr>{["Receta","Acción","Categoría","Porciones","Ingredientes","A crear (sin precio)"].map(h=>(
                  <th key={h} className="text-left px-3 py-2 font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {preview.map((r,i)=>(
                  <tr key={i} className={`border-b border-gray-50 ${i%2===0?"bg-white":"bg-gray-50/40"}`}>
                    <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                    <td className="px-3 py-2"><Pill color={actionMeta[r.action].color}>{actionMeta[r.action].label}</Pill></td>
                    <td className="px-3 py-2 text-gray-500">{r.action === "delete" ? "—" : r.category}</td>
                    <td className="px-3 py-2 text-gray-500">{r.action === "delete" ? "—" : r.portions}</td>
                    <td className="px-3 py-2 text-gray-700">{r.action === "delete" ? "—" : r.lines.length}</td>
                    <td className="px-3 py-2 text-amber-600">{r.unmatched.length > 0 ? r.unmatched.map(u => u.name).join(", ") : <span className="text-gray-300">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3 justify-end">
            <Btn variant="secondary" onClick={()=>{setStep("upload");setPreview([]);setFileName("");}}>← Volver</Btn>
            <Btn onClick={doImport} disabled={importing}>{importing ? "Procesando..." : `✓ Confirmar (${preview.length})`}</Btn>
          </div>
        </div>
      )}
      {step === "done" && (
        <div className="text-center py-8 space-y-3">
          <div className="text-5xl">✅</div>
          <p className="text-lg font-bold text-gray-800">¡Importación exitosa!</p>
          <p className="text-sm text-gray-500">
            {counts.add > 0 && `${counts.add} agregada${counts.add !== 1 ? "s" : ""}`}
            {counts.update > 0 && `${counts.add > 0 ? " · " : ""}${counts.update} actualizada${counts.update !== 1 ? "s" : ""}`}
            {counts.delete > 0 && `${(counts.add > 0 || counts.update > 0) ? " · " : ""}${counts.delete} eliminada${counts.delete !== 1 ? "s" : ""}`}
          </p>
          <Btn onClick={onClose} className="mt-2">Cerrar</Btn>
        </div>
      )}
    </Modal>
  );
}

// ─── QUICK-ADD INGREDIENTE (desde receta) ────────────────────────────────────
function QuickAddIngredientModal({ onClose, onSave }) {
  const [form, setForm] = useState({ name:"", category:"", unit:"kg", buy_price:"", buy_qty:"1", waste_pct:"0" });
  const f = k => e => setForm(p=>({...p,[k]:e.target.value}));
  const previewCost = () => {
    const qty=+form.buy_qty||0; const price=+form.buy_price||0; const waste=+form.waste_pct||0;
    if(qty<=0) return "0.0000";
    const base=price/qty;
    return waste>0?(base/(1-waste/100)).toFixed(4):base.toFixed(4);
  };
  const save = () => {
    if (!form.name.trim()) return;
    onSave({ ...form, id: Date.now(), buy_price:+form.buy_price, buy_qty:+form.buy_qty, waste_pct:+form.waste_pct });
  };
  return (
    <Modal title="Agregar nuevo ingrediente" onClose={onClose}>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="Nombre"><TextInput value={form.name} onChange={f("name")} placeholder="Ej: Harina 000" /></Field>
        </div>
        <Field label="Categoría"><TextInput value={form.category} onChange={f("category")} placeholder="Ej: Secos" /></Field>
        <Field label="Unidad"><TextInput value={form.unit} onChange={f("unit")} placeholder="kg, lt, u, ml" /></Field>
        <Field label="Precio de compra ($)"><TextInput value={form.buy_price} onChange={f("buy_price")} type="number" min="0" step="0.01" /></Field>
        <Field label="Cantidad que comprás"><TextInput value={form.buy_qty} onChange={f("buy_qty")} type="number" min="0.001" step="0.001" /></Field>
        <Field label="% Merma"><TextInput value={form.waste_pct} onChange={f("waste_pct")} type="number" min="0" max="100" step="0.1" suffix="%" /></Field>
        <div className="bg-misky-50 rounded-xl p-4 flex flex-col justify-center">
          <p className="text-xs text-misky-600 font-medium mb-1">Costo neto x unidad</p>
          <p className="text-2xl font-bold text-misky-700">${previewCost()}</p>
        </div>
      </div>
      {form.unit && UNIT_GUIDE.find(g=>g.unit===form.unit) && (
        <div className="mt-3 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-xs text-amber-700">
          💡 <strong>{form.unit}</strong>: {UNIT_GUIDE.find(g=>g.unit===form.unit).recipe}
        </div>
      )}
      <div className="flex gap-3 mt-5 justify-end">
        <Btn variant="secondary" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={!form.name.trim()}>Guardar ingrediente</Btn>
      </div>
    </Modal>
  );
}

function MergeDuplicatesModal({ ingredients, onClose, onMerged, profile }) {
  const groups = useMemo(() => {
    const map = {};
    ingredients.forEach(i => {
      const key = normalizeName(i.name);
      if (!map[key]) map[key] = [];
      map[key].push(i);
    });
    return Object.values(map).filter(g => g.length > 1);
  }, [ingredients]);

  const [keepMap, setKeepMap] = useState(() => {
    const m = {};
    groups.forEach((g, idx) => {
      const withPrice = g.find(i => i.buy_price > 0);
      m[idx] = (withPrice || g[0]).id;
    });
    return m;
  });
  const [merging, setMerging] = useState(false);
  const [done, setDone]       = useState(0);

  const mergeAll = async () => {
    setMerging(true);
    let updated = [...ingredients];
    for (let idx = 0; idx < groups.length; idx++) {
      const group  = groups[idx];
      const keepId = keepMap[idx];
      const dropIds = group.filter(i => i.id !== keepId).map(i => i.id);
      if (dropIds.length === 0) { setDone(d => d + 1); continue; }
      for (const dropId of dropIds) {
        await supabase.from("recipe_ingredients").update({ ingredient_id: keepId }).eq("ingredient_id", dropId);
      }
      await supabase.from("ingredients").delete().in("id", dropIds);
      updated = updated.filter(i => !dropIds.includes(i.id));
      setDone(d => d + 1);
    }
    await logActivity(profile, "merge", "ingredientes", groups.length + " grupo(s) fusionados");
    setMerging(false);
    onMerged(updated);
    onClose();
  };

  return (
    <Modal title="Fusionar ingredientes duplicados" onClose={onClose} wide>
      {groups.length === 0 ? (
        <div className="text-center py-8 text-gray-400">
          <div className="text-4xl mb-2">✅</div>
          <p>No se encontraron nombres duplicados.</p>
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-gray-500">
            Se encontraron {groups.length} grupo{groups.length !== 1 ? "s" : ""} de ingredientes con el mismo nombre.
            Elegí cuál mantener en cada uno — el resto se borra y las recetas que los usaban pasan a usar el que elegiste.
          </p>
          <div className="max-h-96 overflow-y-auto space-y-4 pr-1">
            {groups.map((group, idx) => (
              <div key={idx} className="border border-gray-100 rounded-xl p-4">
                <p className="font-semibold text-gray-700 mb-2">{group[0].name}</p>
                <div className="space-y-1.5">
                  {group.map(ing => (
                    <label key={ing.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" name={`grp-${idx}`} checked={keepMap[idx] === ing.id}
                        onChange={() => setKeepMap(p => ({ ...p, [idx]: ing.id }))}
                        className="accent-misky-500" />
                      <span className="text-gray-700">
                        {ing.category || "sin categoría"} · {ing.unit} · {ing.buy_price ? `$${ing.buy_price}` : "sin precio"} · merma {ing.waste_pct || 0}%
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-3 justify-end">
            <Btn variant="secondary" onClick={onClose} disabled={merging}>Cancelar</Btn>
            <Btn onClick={mergeAll} disabled={merging}>
              {merging ? `Fusionando... (${done}/${groups.length})` : `Fusionar ${groups.length} grupo${groups.length !== 1 ? "s" : ""}`}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

function IngredientsTab({ ingredients, setIngredients, profile }) {
  const canEdit = canEditTabPerms(profile, "ingredients");
  const [modal, setModal]   = useState(null);
  const [search, setSearch] = useState("");
  const [form, setForm]     = useState({});
  const [saving, setSaving] = useState(false);
  const [onlyNoPrice, setOnlyNoPrice] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [batchForm, setBatchForm]   = useState({ category:"", unit:"", waste_pct:"" });
  const [batchApply, setBatchApply] = useState({ category:false, unit:false, waste_pct:false });
  const [batchSaving, setBatchSaving] = useState(false);

  const noPriceCount = ingredients.filter(i => !i.buy_price || i.buy_price === 0).length;

  const categoryOptions = useMemo(() => (
    [...new Set(ingredients.map(i => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"))
  ), [ingredients]);

  const filtered = ingredients.filter(i =>
    (i.name.toLowerCase().includes(search.toLowerCase()) ||
     (i.category || "").toLowerCase().includes(search.toLowerCase())) &&
    (!onlyNoPrice || !i.buy_price || i.buy_price === 0) &&
    (!categoryFilter || i.category === categoryFilter)
  );

  const toggleSelect = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const allFilteredSelected = filtered.length > 0 && filtered.every(i => selectedIds.has(i.id));
  const toggleSelectAllFiltered = () => setSelectedIds(prev => {
    if (allFilteredSelected) {
      const next = new Set(prev);
      filtered.forEach(i => next.delete(i.id));
      return next;
    }
    const next = new Set(prev);
    filtered.forEach(i => next.add(i.id));
    return next;
  });
  const clearSelection = () => setSelectedIds(new Set());

  const saveBatchEdit = async () => {
    setBatchSaving(true);
    const patch = {};
    if (batchApply.category && batchForm.category) patch.category = batchForm.category;
    if (batchApply.unit && batchForm.unit) patch.unit = batchForm.unit;
    if (batchApply.waste_pct && batchForm.waste_pct !== "") patch.waste_pct = +batchForm.waste_pct;
    const ids = [...selectedIds];
    if (Object.keys(patch).length === 0 || ids.length === 0) { setBatchSaving(false); setModal(null); return; }
    const { data, error } = await supabase.from("ingredients").update(patch).in("id", ids).select();
    if (!error && data) {
      setIngredients(prev => prev.map(i => data.find(d => d.id === i.id) || i));
      await logActivity(profile, "update", "ingredientes", ids.length + " ingredientes (edición masiva)");
    }
    setBatchSaving(false);
    setModal(null);
    setBatchForm({ category:"", unit:"", waste_pct:"" });
    setBatchApply({ category:false, unit:false, waste_pct:false });
    clearSelection();
  };

  const deleteBatch = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    await supabase.from("ingredients").delete().in("id", ids);
    setIngredients(prev => prev.filter(i => !ids.includes(i.id)));
    await logActivity(profile, "delete", "ingredientes", ids.length + " ingredientes (borrado masivo)");
    clearSelection();
  };

  const openAdd  = () => { setForm({ name:"", category:"", unit:"kg", buy_price:"", buy_qty:"1", waste_pct:"0" }); setModal("form"); };
  const openEdit = (ing) => { setForm({...ing, buy_price: ing.buy_price+"", buy_qty: ing.buy_qty+"", waste_pct: ing.waste_pct+""}); setModal("form"); };

  const saveIng = async () => {
    setSaving(true);
    const cleanIng = {
      name: form.name,
      category: form.category,
      unit: form.unit,
      buy_price: +form.buy_price,
      buy_qty: +form.buy_qty,
      waste_pct: +form.waste_pct,
    };
    if (!form.id) {
      const { data, error } = await supabase.from("ingredients").insert(cleanIng).select().single();
      if (error) { console.error("Insert error:", error); setSaving(false); return; }
      setIngredients(prev => [...prev, data]);
      await logActivity(profile, "create", "ingrediente", cleanIng.name);
    } else {
      const { data, error } = await supabase.from("ingredients").update(cleanIng).eq("id", form.id).select().single();
      if (error) { console.error("Update error:", error); setSaving(false); return; }
      setIngredients(prev => prev.map(i => i.id === form.id ? data : i));
      await logActivity(profile, "update", "ingrediente", cleanIng.name);
    }
    setSaving(false);
    setModal(null);
  };

  const del = async (id, name) => {
    
    await supabase.from("ingredients").delete().eq("id", id);
    setIngredients(prev => prev.filter(i => i.id !== id));
    await logActivity(profile, "delete", "ingrediente", name);
  };

  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  const categoryColorMap = useMemo(() => buildCategoryColorMap(ingredients.map(i => i.category)), [ingredients]);
  const previewCost = () => {
    const qty = +form.buy_qty || 0; const price = +form.buy_price || 0; const waste = +form.waste_pct || 0;
    if (qty <= 0) return "0.0000";
    const base = price / qty;
    return waste > 0 ? (base / (1 - waste / 100)).toFixed(4) : base.toFixed(4);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-48">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar ingrediente o categoría..."
                 className="flex-1 min-w-48 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-400" />
          <button onClick={() => setOnlyNoPrice(v => !v)}
            className={`flex-shrink-0 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${onlyNoPrice ? "bg-rose-500 border-rose-500 text-white" : "bg-white border-gray-200 text-rose-500 hover:bg-rose-50"}`}>
            Sin precio ({noPriceCount})
          </button>
          <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
            className="flex-shrink-0 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-400">
            <option value="">Todas las categorías</option>
            {categoryOptions.map(cat => <option key={cat} value={cat}>{cat}</option>)}
          </select>
        </div>
        {canEdit && <div className="flex gap-2">
            <Btn variant="secondary" onClick={() => setModal("merge")}>🔗 Fusionar duplicados</Btn>
            <Btn variant="secondary" onClick={() => setModal("import")}>⬆️ Importar CSV</Btn>
            <Btn onClick={openAdd}>+ Agregar ingrediente</Btn>
          </div>}
      </div>
      {canEdit && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-3 bg-misky-50 border border-misky-100 rounded-xl px-4 py-2.5 flex-wrap">
          <span className="text-sm font-semibold text-misky-700">{selectedIds.size} seleccionados</span>
          <button onClick={() => setModal("batchEdit")} className="text-sm text-misky-700 hover:text-misky-800 font-medium underline">✏️ Editar en lote</button>
          <button onClick={deleteBatch} className="text-sm text-rose-600 hover:text-rose-700 font-medium underline">🗑 Eliminar seleccionados</button>
          <button onClick={clearSelection} className="text-sm text-gray-400 hover:text-gray-600 ml-auto">Cancelar selección</button>
        </div>
      )}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              {canEdit && (
                <th className="px-4 py-3 w-8">
                  <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAllFiltered}
                    className="w-4 h-4 accent-misky-500" />
                </th>
              )}
              {["Ingrediente","Categoría","Unidad","Precio compra","Cant.","Merma %","Costo neto/u", canEdit ? "" : null].filter(Boolean).map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((ing, idx) => (
              <tr key={ing.id} className={`border-b border-gray-50 hover:bg-misky-50/30 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/30"} ${selectedIds.has(ing.id) ? "bg-misky-50/60" : ""}`}>
                {canEdit && (
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selectedIds.has(ing.id)} onChange={() => toggleSelect(ing.id)}
                      className="w-4 h-4 accent-misky-500" />
                  </td>
                )}
                <td className="px-4 py-3 font-medium text-gray-800">{ing.name}</td>
                <td className="px-4 py-3"><CategoryTag category={ing.category} colors={categoryColorMap[ing.category || "Sin categoría"]} /></td>
                <td className="px-4 py-3 text-gray-500">{ing.unit}</td>
                <td className="px-4 py-3 text-gray-700">{ing.buy_price ? `$${ing.buy_price.toLocaleString("es-AR")}` : <span className="text-rose-400 font-medium">Sin precio</span>}</td>
                <td className="px-4 py-3 text-gray-500">{ing.buy_qty}</td>
                <td className="px-4 py-3">{ing.waste_pct > 0 ? <Pill color="rose">{ing.waste_pct}%</Pill> : <span className="text-gray-300">—</span>}</td>
                <td className="px-4 py-3 font-semibold text-misky-700">${unitCost(ing).toFixed(4)}</td>
                {canEdit && (
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => openEdit(ing)} className="text-gray-400 hover:text-misky-600">✏️</button>
                      <button onClick={() => del(ing.id, ing.name)} className="text-gray-400 hover:text-rose-500">🗑</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-400"><div className="text-4xl mb-2">🔍</div><p>Sin resultados</p></div>
        )}
      </div>

      {modal === "form" && (
        <Modal title={form.id ? "Editar ingrediente" : "Nuevo ingrediente"} onClose={() => setModal(null)}>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Field label="Nombre"><TextInput value={form.name || ""} onChange={f("name")} placeholder="Ej: Harina 000" /></Field>
            </div>
            <Field label="Categoría"><TextInput value={form.category || ""} onChange={f("category")} placeholder="Ej: Secos" /></Field>
            <Field label="Unidad"><TextInput value={form.unit || ""} onChange={f("unit")} placeholder="kg, lt, u, ml" /></Field>
            <Field label="Precio de compra ($)"><TextInput value={form.buy_price || ""} onChange={f("buy_price")} type="number" min="0" step="0.01" /></Field>
            <Field label="Cantidad que comprás"><TextInput value={form.buy_qty || ""} onChange={f("buy_qty")} type="number" min="0.001" step="0.001" /></Field>
            <Field label="% Merma"><TextInput value={form.waste_pct || "0"} onChange={f("waste_pct")} type="number" min="0" max="100" step="0.1" suffix="%" /></Field>
            <div className="bg-misky-50 rounded-xl p-4 flex flex-col justify-center">
              <p className="text-xs text-misky-600 font-medium mb-1">Costo neto x unidad</p>
              <p className="text-2xl font-bold text-misky-700">${previewCost()}</p>
            </div>
          </div>
          {form.unit && UNIT_GUIDE.find(g => g.unit === form.unit) && (
            <div className="mt-3 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-xs text-amber-700">
              💡 <strong>{form.unit}</strong>: {UNIT_GUIDE.find(g => g.unit === form.unit).recipe}
            </div>
          )}
          <div className="flex gap-3 mt-5 justify-end">
            <Btn variant="secondary" onClick={() => setModal(null)}>Cancelar</Btn>
            <Btn onClick={saveIng} disabled={saving}>{saving ? "Guardando..." : "Guardar"}</Btn>
          </div>
        </Modal>
      )}
      {modal === "batchEdit" && (
        <Modal title={`Editar ${selectedIds.size} ingredientes`} onClose={() => setModal(null)}>
          <p className="text-xs text-gray-400 mb-4">Tildá el campo que querés cambiar. Solo se van a modificar los campos tildados; el resto queda como estaba.</p>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <input type="checkbox" checked={batchApply.category} onChange={e => setBatchApply(p => ({...p, category: e.target.checked}))} className="w-4 h-4 accent-misky-500" />
              <div className="flex-1"><Field label="Categoría"><TextInput value={batchForm.category} disabled={!batchApply.category} onChange={e => setBatchForm(p=>({...p, category: e.target.value}))} placeholder="Ej: Secos" /></Field></div>
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" checked={batchApply.unit} onChange={e => setBatchApply(p => ({...p, unit: e.target.checked}))} className="w-4 h-4 accent-misky-500" />
              <div className="flex-1"><Field label="Unidad"><TextInput value={batchForm.unit} disabled={!batchApply.unit} onChange={e => setBatchForm(p=>({...p, unit: e.target.value}))} placeholder="kg, lt, u, ml" /></Field></div>
            </div>
            <div className="flex items-center gap-3">
              <input type="checkbox" checked={batchApply.waste_pct} onChange={e => setBatchApply(p => ({...p, waste_pct: e.target.checked}))} className="w-4 h-4 accent-misky-500" />
              <div className="flex-1"><Field label="% Merma"><TextInput value={batchForm.waste_pct} disabled={!batchApply.waste_pct} onChange={e => setBatchForm(p=>({...p, waste_pct: e.target.value}))} type="number" min="0" max="100" step="0.1" suffix="%" /></Field></div>
            </div>
          </div>
          <div className="flex gap-3 mt-5 justify-end">
            <Btn variant="secondary" onClick={() => setModal(null)}>Cancelar</Btn>
            <Btn onClick={saveBatchEdit} disabled={batchSaving || !(batchApply.category || batchApply.unit || batchApply.waste_pct)}>
              {batchSaving ? "Guardando..." : `Aplicar a ${selectedIds.size} ingredientes`}
            </Btn>
          </div>
        </Modal>
      )}
      {modal === "merge" && (
        <MergeDuplicatesModal
          ingredients={ingredients}
          onClose={() => setModal(null)}
          onMerged={(updatedIngredients) => { setIngredients(updatedIngredients); }}
          profile={profile}
        />
      )}
      {modal === "import" && (
        <ImportCSVModal onClose={() => setModal(null)} onImport={async (rows) => {
          const existing = [...ingredients];
          for (const row of rows) {
            const cleanRow = {
              name: row.name,
              category: row.category,
              unit: row.unit,
              buy_price: row.buy_price,
              buy_qty: row.buy_qty,
              waste_pct: row.waste_pct,
            };
            const idx = existing.findIndex(x => x.name.toLowerCase().trim() === row.name.toLowerCase().trim());
            if (idx !== -1) {
              const { data, error } = await supabase.from("ingredients").update(cleanRow).eq("id", existing[idx].id).select().single();
              if (error) console.error("Update error:", error);
              else if (data) existing[idx] = data;
            } else {
              const { data, error } = await supabase.from("ingredients").insert(cleanRow).select().single();
              if (error) console.error("Insert error:", error);
              else if (data) existing.push(data);
            }
          }
          setIngredients(existing);
          await logActivity(profile, "import", "ingredientes", rows.length + " ingredientes");
        }} />
      )}
    </div>
  );
}

// ─── BUSINESS ─────────────────────────────────────────────────────────────────
function BusinessTab({ business, setBusiness, profile }) {
  const canEdit = canEditTabPerms(profile, "business");
  const canSeeFijos = canP(profile, "business", "costos_fijos");
  const canSeeVars = canP(profile, "business", "produccion_variables");

  const save = async (updated) => {
    setBusiness(updated);
    await supabase.from("business").update(updated).eq("id", 1);
    await logActivity(profile, "update", "costos", "configuración de negocio");
  };

  const update = (key, val) => save({ ...business, [key]: val });

  const updateCost = (id, field, val) => {
    const updated = {
      ...business,
      fixed_costs: business.fixed_costs.map(c => c.id === id ? { ...c, [field]: field === "amount" ? +val : val } : c)
    };
    save(updated);
  };

  const addCost = () => save({ ...business, fixed_costs: [...business.fixed_costs, { id: Date.now(), name: "Nuevo costo", amount: 0 }] });
  const delCost = id => save({ ...business, fixed_costs: business.fixed_costs.filter(c => c.id !== id) });

  const totalFixed = (business.fixed_costs || []).reduce((s, c) => s + (c.amount || 0), 0);
  const cfUnit     = business.monthly_units > 0 ? totalFixed / business.monthly_units : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total costos fijos/mes" value={`$${totalFixed.toLocaleString("es-AR")}`} accent="rose" />
        <StatCard label="Unidades estimadas/mes" value={business.monthly_units} accent="sky" />
        <StatCard label="Costo fijo x unidad" value={`$${cfUnit.toFixed(2)}`} sub="Aplicado a cada receta" accent="misky" />
      </div>
      {canSeeFijos && <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h3 className="font-semibold text-gray-700 mb-4">🏢 Costos fijos mensuales</h3>
        <div className="space-y-2">
          {(business.fixed_costs || []).map(c => (
            <div key={c.id} className="flex items-center gap-3">
              <input value={c.name} disabled={!canEdit} onChange={e => updateCost(c.id, "name", e.target.value)}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-400 disabled:bg-gray-50" />
              <div className="relative w-36">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input type="number" min="0" value={c.amount} disabled={!canEdit} onChange={e => updateCost(c.id, "amount", e.target.value)}
                  className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-400 disabled:bg-gray-50" />
              </div>
              {canEdit && <button onClick={() => delCost(c.id)} className="text-gray-300 hover:text-rose-400 text-lg">🗑</button>}
            </div>
          ))}
        </div>
        {canEdit && <button onClick={addCost} className="mt-3 text-sm text-misky-600 hover:text-misky-700 font-medium">+ Agregar línea</button>}
      </div>}
      {canSeeVars && <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h3 className="font-semibold text-gray-700 mb-4">📈 Producción y costos variables</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Unidades producidas por mes">
            <TextInput value={business.monthly_units} onChange={e => update("monthly_units", +e.target.value)} type="number" min="1" disabled={!canEdit} />
          </Field>
          {[
            ["% Comisión delivery / plataformas", "delivery_pct"],
            ["% IVA / impuesto sobre ventas", "iva_pct"],
            ["% Otros costos variables", "other_var_pct"],
          ].map(([label, key]) => (
            <Field key={key} label={label}>
              <TextInput value={business[key]} onChange={e => update(key, +e.target.value)} type="number" min="0" max="100" step="0.1" suffix="%" disabled={!canEdit} />
            </Field>
          ))}
        </div>
      </div>}
      {!canEdit && (
        <p className="text-sm text-gray-400 bg-gray-50 px-4 py-2 rounded-lg">👁 Estás en modo solo lectura. No podés modificar la configuración.</p>
      )}
    </div>
  );
}

// ─── RECIPES ──────────────────────────────────────────────────────────────────
// Inserta/actualiza una receta intentando guardar también el campo
// "procedure". Si la base de datos todavía no tiene esa columna (falta
// correr la migración en Supabase), reintenta sin ese campo en vez de
// romper el guardado — así la app nunca se cae por esto, aunque el
// procedimiento no se guarde hasta que se ejecute la migración.
async function insertRecipeSafe(payload) {
  let { data, error } = await supabase.from("recipes").insert(payload).select().single();
  if (error) {
    const { procedure, ...rest } = payload;
    ({ data, error } = await supabase.from("recipes").insert(rest).select().single());
  }
  return { data, error };
}
async function updateRecipeSafe(id, payload) {
  let { data, error } = await supabase.from("recipes").update(payload).eq("id", id).select().single();
  if (error) {
    const { procedure, ...rest } = payload;
    ({ data, error } = await supabase.from("recipes").update(rest).eq("id", id).select().single());
  }
  return { data, error };
}

function RecipesTab({ recipes, setRecipes, ingredients, setIngredients, business, profile }) {
  const canEdit = canEditTabPerms(profile, "recipes");
  const showIngredientes = canP(profile, "recipes", "ingredientes");
  const showCostos = canP(profile, "recipes", "costos");
  const showPrecioSug = canP(profile, "recipes", "precio_sugerido");
  const showPrecioRed = canP(profile, "recipes", "precio_redondeado");
  const showGanancia = canP(profile, "recipes", "ganancia");
  const [selected, setSelected] = useState(null);
  const [modal, setModal]       = useState(null);
  const [search, setSearch]     = useState("");
  const [mode, setMode]         = useState("ver"); // "ver" | "gestionar"
  const [moreMenu, setMoreMenu] = useState(false);
  const [detailMenu, setDetailMenu] = useState(false);
  const [editingCat, setEditingCat] = useState(null);
  const [editingCatValue, setEditingCatValue] = useState("");

  const saveCategoryInline = async (id) => {
    const val = editingCatValue.trim();
    setEditingCat(null);
    if (val === "") return;
    await supabase.from("recipes").update({ category: val }).eq("id", id);
    setRecipes(prev => sortByName(prev.map(r => r.id === id ? { ...r, category: val } : r)));
  };
  const [form, setForm]         = useState({});
  const [saving, setSaving]       = useState(false);
  const [quickIngTarget, setQuickIngTarget] = useState(null);
  const [showUnitGuide, setShowUnitGuide]   = useState(false);

  useEffect(() => {
    if (selected === null && recipes.length > 0) setSelected(recipes[0].id);
    else if (selected !== null && !recipes.find(r => r.id === selected)) setSelected(recipes[0]?.id ?? null);
  }, [recipes, selected]);

  const openAdd = () => {
    setForm({ name:"", category:"", portions:"4", profit_pct:"40", procedure:"", recipe_ingredients:[] });
    setModal("form");
  };
  const openEdit = r => {
    setForm({ ...r, portions: r.portions+"", profit_pct: r.profit_pct+"", procedure: r.procedure || "" });
    setModal("form");
  };
  const openDuplicate = r => {
    setForm({
      name: r.name + " (copia)",
      category: r.category,
      portions: r.portions + "",
      profit_pct: r.profit_pct + "",
      procedure: r.procedure || "",
      recipe_ingredients: (r.recipe_ingredients || []).map(ri => ({ ingredient_id: String(ri.ingredient_id), qty: ri.qty + "" })),
    });
    setModal("form");
  };

  const saveRecipe = async () => {
    setSaving(true);
    const r = { ...form, portions: +form.portions, profit_pct: +form.profit_pct };
    const lines = (r.recipe_ingredients || [])
      .filter(l => l.ingredient_id !== "" && l.ingredient_id !== undefined && l.qty !== "" && +l.qty > 0)
      .map(l => ({ ingredient_id: +l.ingredient_id, qty: +l.qty }));
    const payload = { name: r.name, category: r.category, portions: r.portions, profit_pct: r.profit_pct, procedure: r.procedure || "" };

    let recipeId = r.id;
    if (!r.id) {
      const { data, error } = await insertRecipeSafe(payload);
      if (error || !data) { console.error("Insert error:", error); setSaving(false); return; }
      recipeId = data.id;
      await logActivity(profile, "create", "receta", r.name);
    } else {
      const { error } = await updateRecipeSafe(r.id, payload);
      if (error) { console.error("Update error:", error); setSaving(false); return; }
      await logActivity(profile, "update", "receta", r.name);
    }

    // Reemplazar ingredientes de la receta
    await supabase.from("recipe_ingredients").delete().eq("recipe_id", recipeId);
    if (lines.length > 0) {
      await supabase.from("recipe_ingredients").insert(lines.map(l => ({ ...l, recipe_id: recipeId })));
    }

    // Recargar recetas
    const { data: allRecipes } = await supabase.from("recipes").select("*, recipe_ingredients(*)").order("name");
    setRecipes(sortByName(allRecipes || []));
    setSaving(false);
    setModal(null);
    setSelected(recipeId);
  };

  // Importa recetas desde el CSV ya resuelto (ver ImportRecipesCSVModal):
  // agrega, actualiza o elimina según corresponda, creando automáticamente
  // (sin precio ni unidad) los ingredientes que el archivo menciona pero que
  // todavía no existen, para completarlos después desde Ingredientes.
  const importRecipesCSV = async (rows) => {
    const missingNames = new Map(); // normalizado -> nombre original
    rows.forEach(row => {
      if (row.action === "delete") return;
      row.unmatched.forEach(u => {
        const key = normalizeText(u.name);
        if (!missingNames.has(key)) missingNames.set(key, u.name);
      });
    });
    let currentIngredients = ingredients;
    if (missingNames.size > 0) {
      const toInsert = Array.from(missingNames.values()).map(name => ({
        name, category: "General", unit: "", buy_price: 0, buy_qty: 1, waste_pct: 0,
      }));
      const { data: newIngs } = await supabase.from("ingredients").insert(toInsert).select();
      if (newIngs && newIngs.length > 0) {
        currentIngredients = sortByName([...currentIngredients, ...newIngs]);
        setIngredients(currentIngredients);
      }
    }

    for (const row of rows) {
      if (row.action === "delete") {
        if (row.existingId) await supabase.from("recipes").delete().eq("id", row.existingId);
        continue;
      }
      const payload = { name: row.name, category: row.category, portions: +row.portions, profit_pct: +row.profit_pct, procedure: row.procedure || "" };
      let recipeId = row.existingId;
      if (recipeId) {
        await updateRecipeSafe(recipeId, payload);
      } else {
        const { data } = await insertRecipeSafe(payload);
        recipeId = data?.id;
      }
      if (recipeId) {
        await supabase.from("recipe_ingredients").delete().eq("recipe_id", recipeId);
        const allLines = [...row.lines];
        row.unmatched.forEach(u => {
          const ing = currentIngredients.find(i => normalizeText(i.name) === normalizeText(u.name));
          if (ing) allLines.push({ ingredient_id: ing.id, qty: u.qty });
        });
        if (allLines.length > 0) {
          await supabase.from("recipe_ingredients").insert(
            allLines.map(l => ({ recipe_id: recipeId, ingredient_id: l.ingredient_id, qty: l.qty }))
          );
        }
      }
    }
    const { data: allRecipes } = await supabase.from("recipes").select("*, recipe_ingredients(*)").order("name");
    setRecipes(sortByName(allRecipes || []));
    const added = rows.filter(r => r.action === "add").length;
    const updated = rows.filter(r => r.action === "update").length;
    const deleted = rows.filter(r => r.action === "delete").length;
    await logActivity(profile, "import", "recetas", `${added} nuevas, ${updated} actualizadas, ${deleted} eliminadas, ${missingNames.size} ingredientes nuevos sin precio`);
  };

  const del = async (id, name) => {
    
    await supabase.from("recipes").delete().eq("id", id);
    setRecipes(prev => prev.filter(r => r.id !== id));
    await logActivity(profile, "delete", "receta", name);
    if (selected === id) setSelected(recipes.find(r => r.id !== id)?.id ?? null);
  };

  const handleQuickIngSave = async (newIng) => {
    const cleanNewIng = { name: newIng.name, category: newIng.category, unit: newIng.unit, buy_price: +newIng.buy_price, buy_qty: +newIng.buy_qty, waste_pct: +newIng.waste_pct };
    const { data } = await supabase.from("ingredients")
      .insert(cleanNewIng)
      .select().single();
    if (data) {
      setIngredients(prev => [...prev, data]);
      if (quickIngTarget !== null) {
        setForm(p => {
          const arr = [...(p.recipe_ingredients || [])];
          arr[quickIngTarget] = { ...arr[quickIngTarget], ingredient_id: String(data.id) };
          return { ...p, recipe_ingredients: arr };
        });
      }
    }
    setModal("form"); setQuickIngTarget(null);
  };

  const addLine    = () => setForm(p => ({ ...p, recipe_ingredients: [...(p.recipe_ingredients || []), { ingredient_id: "", qty: "" }] }));
  const updateLine = (idx, k, v) => setForm(p => {
    const arr = [...(p.recipe_ingredients || [])]; arr[idx] = { ...arr[idx], [k]: v }; return { ...p, recipe_ingredients: arr };
  });
  const removeLine = idx => setForm(p => ({ ...p, recipe_ingredients: (p.recipe_ingredients || []).filter((_, i) => i !== idx) }));

  const ingMap  = Object.fromEntries(ingredients.map(i => [i.id, i]));
  const recipe  = recipes.find(r => r.id === selected);
  useEffect(() => { setDetailMenu(false); }, [selected]);
  const calc    = recipe ? calcRecipe(recipe, ingredients, business) : null;

  const liveCalc = (() => {
    if (!form.recipe_ingredients?.length || !form.portions) return null;
    const preview = {
      ...form, portions: +form.portions, profit_pct: +form.profit_pct,
      recipe_ingredients: (form.recipe_ingredients || [])
        .filter(l => l.ingredient_id !== "" && l.qty !== "" && +l.qty > 0)
        .map(l => ({ ingredient_id: +l.ingredient_id, qty: +l.qty })),
    };
    if (!preview.recipe_ingredients.length) return null;
    try { return calcRecipe(preview, ingredients, business); } catch { return null; }
  })();

  return (
    <div className="flex gap-5">
      {/* Sidebar */}
      <div className="w-72 flex-shrink-0 space-y-2">
        {canEdit && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button onClick={() => setMode("ver")}
              className={`flex-1 text-sm py-2 transition-colors ${mode === "ver" ? "bg-misky-600 text-white font-medium" : "bg-white text-gray-500 hover:bg-gray-50"}`}>👁️ Ver</button>
            <button onClick={() => setMode("gestionar")}
              className={`flex-1 text-sm py-2 transition-colors ${mode === "gestionar" ? "bg-misky-600 text-white font-medium" : "bg-white text-gray-500 hover:bg-gray-50"}`}>✏️ Gestionar</button>
          </div>
        )}

        {mode === "gestionar" && canEdit && (
          <div className="flex gap-2">
            <Btn onClick={openAdd} className="flex-1 min-w-0">+ Nueva receta</Btn>
            <div className="relative">
              <button onClick={() => setMoreMenu(v => !v)} title="Más acciones"
                className="h-full px-3 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors">⋯</button>
              {moreMenu && (
                <div className="absolute right-0 mt-1 w-52 bg-white rounded-lg shadow-lg border border-gray-100 z-10 py-1">
                  <button onClick={() => { setModal("import"); setMoreMenu(false); }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">⬆️ Importar CSV</button>
                  <button onClick={() => { exportRecipesCSVForImport(recipes, ingredients); setMoreMenu(false); }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">⬇️ Descargar recetas (CSV)</button>
                  <button onClick={() => { downloadEmptyRecipesTemplate(); setMoreMenu(false); }}
                    title="CSV vacío con el formato correcto, para arrancar de cero"
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">📄 Plantilla vacía (CSV)</button>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar"
                 className="w-full bg-gray-100 border-none rounded-full pl-9 pr-8 py-2 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-misky-400 focus:bg-white transition-colors" />
          {search && (
            <button onClick={() => setSearch("")} title="Borrar búsqueda"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-gray-300 hover:bg-gray-400 text-white text-xs leading-4 text-center">✕</button>
          )}
        </div>

        {recipes.filter(r =>
          normalizeText(r.name).includes(normalizeText(search)) ||
          normalizeText(r.category || "").includes(normalizeText(search))
        ).map(r => {
          const c = calcRecipe(r, ingredients, business);
          return (
            <div key={r.id}
              className={`bg-white rounded-xl border p-3 transition-all hover:shadow-md ${selected === r.id ? "border-misky-400 shadow-md" : "border-gray-100"}`}>
              <div className="cursor-pointer" onClick={() => setSelected(r.id)}>
                <p className="font-semibold text-gray-800 text-sm leading-tight">{r.name}</p>
                <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1 flex-wrap">
                  {mode === "gestionar" && editingCat === r.id ? (
                    <input autoFocus value={editingCatValue}
                      onClick={e => e.stopPropagation()}
                      onChange={e => setEditingCatValue(e.target.value)}
                      onBlur={() => saveCategoryInline(r.id)}
                      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEditingCat(null); }}
                      className="text-xs border border-misky-300 rounded px-1 py-0.5 w-24 focus:outline-none focus:ring-1 focus:ring-misky-400" />
                  ) : (
                    <span
                      onClick={mode === "gestionar" ? (e) => { e.stopPropagation(); setEditingCat(r.id); setEditingCatValue(r.category || ""); } : undefined}
                      title={mode === "gestionar" ? "Click para editar" : undefined}
                      className={mode === "gestionar" ? "hover:bg-amber-50 rounded px-0.5 -mx-0.5 cursor-text border-b border-dotted border-gray-300" : ""}>
                      {r.category || "Sin categoría"}
                    </span>
                  )}
                  <span>· {r.portions} u.</span>
                </p>
                <div className="flex justify-between items-center mt-2">
                  <span className="text-xs text-gray-400">Precio</span>
                  <span className="text-sm font-bold text-misky-600">${c.roundedPrice.toLocaleString("es-AR")}</span>
                </div>
              </div>
            </div>
          );
        })}
        {recipes.length === 0 && (
          <div className="text-center py-8 text-gray-400 text-sm"><div className="text-3xl mb-2">🍽️</div>Sin recetas aún</div>
        )}
        {recipes.length > 0 && recipes.filter(r =>
          normalizeText(r.name).includes(normalizeText(search)) ||
          normalizeText(r.category || "").includes(normalizeText(search))
        ).length === 0 && (
          <div className="text-center py-8 text-gray-400 text-sm"><div className="text-3xl mb-2">🔍</div>Sin resultados</div>
        )}
      </div>

      {/* Detail */}
      <div className="flex-1 min-w-0">
        {recipe && calc ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="bg-gradient-to-r from-misky-700 to-misky-600 px-6 py-5 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">{recipe.name}</h2>
                <p className="text-misky-200 text-sm mt-1">{recipe.category} · {recipe.portions} porciones · {recipe.profit_pct}% ganancia</p>
              </div>
              {canEdit && mode === "gestionar" && (
                <div className="flex gap-2 relative">
                  <button onClick={() => openEdit(recipe)} className="bg-white/20 hover:bg-white/30 text-white text-sm px-3 py-1.5 rounded-lg">✏️ Editar</button>
                  <button onClick={() => setDetailMenu(v => !v)} className="bg-white/20 hover:bg-white/30 text-white text-sm px-2.5 py-1.5 rounded-lg">⋯</button>
                  {detailMenu && (
                    <div className="absolute right-0 top-9 w-44 bg-white rounded-lg shadow-lg border border-gray-100 z-10 py-1">
                      <button onClick={() => { setDetailMenu(false); openDuplicate(recipe); }}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">📄 Duplicar</button>
                      <button onClick={() => { setDetailMenu(false); del(recipe.id, recipe.name); }}
                        className="w-full text-left px-3 py-2 text-sm text-rose-600 hover:bg-rose-50">🗑 Eliminar</button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-5">
              {showCostos && <StatCard label="Costo x porción"   value={`$${calc.totalCost.toFixed(2)}`} accent="rose" />}
              {showPrecioSug && <StatCard label="Precio sugerido"   value={`$${calc.suggestedPrice.toFixed(2)}`} accent="amber" />}
              {showPrecioRed && <StatCard label="Precio redondeado" value={`$${calc.roundedPrice.toLocaleString("es-AR")}`} sub={`cada $${PRICE_ROUND_TO}`} accent="misky" />}
              {showGanancia && <StatCard label="Ganancia real"      value={`${calc.realProfitPct.toFixed(1)}%`} sub={`$${calc.realProfit.toFixed(2)}/p`} accent="sky" />}
            </div>
            {showIngredientes && <div className="px-5 pb-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Ingredientes</h3>
              <table className="w-full text-sm min-w-[480px]">
                <thead>
                  <tr className="text-xs text-gray-400 uppercase border-b border-gray-100">
                    {["Ingrediente","Unidad","Cantidad","Costo neto/u","Subtotal"].map(h => (
                      <th key={h} className="text-left pb-2 font-medium pr-4">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calc.lines.map((l, i) => (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="py-2 text-gray-800 pr-4">{l.ing.name}</td>
                      <td className="py-2 text-gray-500 pr-4">{l.ing.unit}</td>
                      <td className="py-2 text-gray-700 pr-4">{l.qty.toFixed(3)}</td>
                      <td className="py-2 text-gray-600 pr-4">${l.unitCost.toFixed(4)}</td>
                      <td className="py-2 font-medium text-gray-800">${l.subtotal.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
            {recipe.procedure && (
              <div className="px-5 pb-3">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Procedimiento</h3>
                <p className="text-sm text-gray-700 whitespace-pre-line bg-gray-50 rounded-xl p-4 border border-gray-100">{recipe.procedure}</p>
              </div>
            )}
            <div className="mx-5 mb-5 rounded-xl overflow-hidden text-sm border border-gray-100">
              {showCostos && [
                ["Costo MP total", `$${calc.mpTotal.toFixed(2)}`, "bg-white"],
                ["Costo MP x porción", `$${calc.mpPerPortion.toFixed(2)}`, "bg-white"],
                ["Costo fijo x porción", `$${calc.cfPerUnit.toFixed(2)}`, "bg-gray-50"],
                [`Costos variables (${(calc.varPct*100).toFixed(1)}%)`, `$${calc.varCost.toFixed(2)}`, "bg-gray-50"],
              ].map(([l, v, bg]) => (
                <div key={l} className={`flex justify-between px-4 py-2 border-b border-gray-100 ${bg}`}>
                  <span className="text-gray-600">{l}</span><span className="font-medium">{v}</span>
                </div>
              ))}
              {showCostos && <div className="flex justify-between px-4 py-3 bg-rose-50">
                <span className="font-bold text-rose-700">COSTO TOTAL x porción</span>
                <span className="font-bold text-rose-700">${calc.totalCost.toFixed(2)}</span>
              </div>}
              {showPrecioRed && <div className="flex justify-between px-4 py-3.5 bg-misky-600">
                <span className="font-bold text-white text-base">PRECIO DE VENTA</span>
                <span className="font-bold text-white text-xl">${calc.roundedPrice.toLocaleString("es-AR")}</span>
              </div>}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-64 text-gray-400">
            <div className="text-center"><div className="text-5xl mb-3">👈</div><p>Seleccioná una receta</p></div>
          </div>
        )}
      </div>

      {/* Modal receta */}
      {modal === "form" && (
        <Modal title={form.id ? "Editar receta" : "Nueva receta"} onClose={() => setModal(null)} wide>
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Field label="Nombre">
                  <TextInput value={form.name || ""} onChange={e => setForm(p=>({...p, name: e.target.value}))} placeholder="Ej: Medialunas de manteca" />
                </Field>
              </div>
              <Field label="Categoría">
                <TextInput value={form.category || ""} onChange={e => setForm(p=>({...p, category: e.target.value}))} placeholder="Panadería" />
              </Field>
              <Field label="Porciones">
                <TextInput value={form.portions || ""} onChange={e => setForm(p=>({...p, portions: e.target.value}))} type="number" min="1" />
              </Field>
              <div className="col-span-2">
                <Field label="% Ganancia neta deseada">
                  <TextInput value={form.profit_pct || ""} onChange={e => setForm(p=>({...p, profit_pct: e.target.value}))} type="number" min="0" max="99" step="1" suffix="%" />
                </Field>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-gray-700">Ingredientes</h4>
                <div className="flex gap-3 items-center">
                  <button onClick={() => setShowUnitGuide(v => !v)} className="text-xs text-amber-600 hover:text-amber-700 font-medium">📐 Guía de unidades</button>
                  <button onClick={addLine} className="text-sm text-misky-600 hover:text-misky-700 font-medium">+ Agregar línea</button>
                </div>
              </div>
              {showUnitGuide && (
                <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 mb-2">
                  <p className="text-xs font-semibold text-amber-800 mb-2">📐 Las cantidades en recetas se ingresan en la misma unidad que la compra:</p>
                  <table className="w-full text-xs">
                    <tbody>
                      {UNIT_GUIDE.map(g => (
                        <tr key={g.unit} className="border-t border-amber-100">
                          <td className="py-1 pr-3 font-bold text-amber-700 w-10">{g.unit}</td>
                          <td className="py-1 text-amber-800">{g.recipe}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="space-y-2">
                {(form.recipe_ingredients || []).map((line, idx) => {
                  const ingId = line.ingredient_id !== "" ? +line.ingredient_id : null;
                  const ing   = ingId ? ingMap[ingId] : null;
                  const sub   = ing && line.qty ? (unitCost(ing) * +line.qty).toFixed(2) : null;
                  return (
                    <div key={idx} className="flex gap-2 items-center">
                      <select value={line.ingredient_id || ""}
                        onChange={e => {
                          if (e.target.value === "__new__") {
                            setQuickIngTarget(idx); setModal("quickIng");
                          } else { updateLine(idx, "ingredient_id", e.target.value); }
                        }}
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-400">
                        <option value="">-- Elegir ingrediente --</option>
                        <option value="__new__" className="text-misky-700 font-semibold">✚ Crear nuevo ingrediente...</option>
                        <option disabled>──────────────</option>
                        {ingredients.map(i => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                      </select>
                      <input type="number" min="0" step="0.001" value={line.qty || ""}
                        onChange={e => updateLine(idx, "qty", e.target.value)}
                        placeholder="Cant."
                        className="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-400" />
                      {sub && <span className="text-xs font-semibold text-misky-600 w-16 text-right">${sub}</span>}
                      <button onClick={() => removeLine(idx)} className="text-gray-300 hover:text-rose-400 text-lg">×</button>
                    </div>
                  );
                })}
                {!(form.recipe_ingredients?.length) && (
                  <p className="text-sm text-gray-400 text-center py-4 border border-dashed border-gray-200 rounded-xl">
                    Hacé clic en "+ Agregar línea" para sumar ingredientes
                  </p>
                )}
              </div>
            </div>
            <div>
              <Field label="Procedimiento (opcional)">
                <textarea value={form.procedure || ""} onChange={e => setForm(p => ({ ...p, procedure: e.target.value }))}
                  placeholder="Pasos de preparación, tiempos de cocción, notas para la cocina..." rows={6}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-400 resize-y" />
              </Field>
              <p className="text-xs text-gray-400 mt-1">Es independiente de los ingredientes y las cantidades — podés dejarlo vacío y completarlo después, no afecta el costeo.</p>
            </div>
            {liveCalc && (
              <div className="bg-misky-50 rounded-xl p-4 border border-misky-100">
                <p className="text-xs text-misky-600 font-semibold uppercase tracking-wide mb-3">Vista previa en tiempo real</p>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div><p className="text-gray-500">Costo total/p</p><p className="font-bold text-gray-800">${liveCalc.totalCost.toFixed(2)}</p></div>
                  <div><p className="text-gray-500">Precio sugerido</p><p className="font-bold text-misky-700 text-lg">${liveCalc.roundedPrice.toLocaleString("es-AR")}</p></div>
                  <div><p className="text-gray-500">Ganancia real</p><p className="font-bold text-sky-600">{liveCalc.realProfitPct.toFixed(1)}%</p></div>
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-3 mt-5 justify-end">
            <Btn variant="secondary" onClick={() => setModal(null)}>Cancelar</Btn>
            <Btn onClick={saveRecipe} disabled={saving}>{saving ? "Guardando..." : "Guardar receta"}</Btn>
          </div>
        </Modal>
      )}
      {modal === "quickIng" && (
        <QuickAddIngredientModal
          onClose={() => { setModal("form"); setQuickIngTarget(null); }}
          onSave={handleQuickIngSave}
        />
      )}
      {modal === "import" && (
        <ImportRecipesCSVModal
          onClose={() => setModal(null)}
          onImport={importRecipesCSV}
          recipes={recipes}
          ingredients={ingredients}
        />
      )}
    </div>
  );
}


// ─── COMANDA TAB (MOZO) ───────────────────────────────────────────────────────
const COMANDA_STORAGE_KEY = "recetapp_comanda_cart";
const COMANDA_PHONE_KEY   = "recetapp_comanda_phone";

function ComandaTab({ recipes, ingredients, business, cartSel, cartBatch, cartLabel }) {
  const [items, setItems] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COMANDA_STORAGE_KEY) || "{}");
      return saved && typeof saved === "object" ? saved : {};
    } catch { return {}; }
  }); // { recipeId: qty }
  const [countryCode, setCountryCode] = useState("54");
  const [phone, setPhone] = useState(() => {
    try { return localStorage.getItem(COMANDA_PHONE_KEY) || ""; } catch { return ""; }
  });

  // Selección hecha en la pestaña Resumen (carrito compartido) — un botón
  // opcional para traerla acá sin tener que volver a tildar todo a mano. No
  // reemplaza la comanda local: solo la precarga si se toca el botón.
  const cartCount = Object.values(cartSel || {}).filter(Boolean).length;
  const useCartSelection = () => {
    setItems(prev => {
      const next = { ...prev };
      Object.entries(cartSel || {}).forEach(([id, on]) => {
        if (on) next[id] = +(cartBatch?.[id]) || 1;
      });
      return next;
    });
  };

  useEffect(() => {
    try { localStorage.setItem(COMANDA_STORAGE_KEY, JSON.stringify(items)); } catch {}
  }, [items]);
  useEffect(() => {
    try { localStorage.setItem(COMANDA_PHONE_KEY, phone); } catch {}
  }, [phone]);

  const toggle = (id) => setItems(p => ({ ...p, [id]: (p[id] || 0) === 0 ? 1 : p[id] }));
  const setQty = (id, val) => {
    const n = Math.max(0, parseInt(val) || 0);
    setItems(p => ({ ...p, [id]: n }));
  };
  const clearCart = () => {
    setItems({});
    try { localStorage.removeItem(COMANDA_STORAGE_KEY); } catch {}
  };
  const selected = recipes.filter(r => (items[r.id] || 0) > 0);
  const total = selected.reduce((s, r) => {
    const c = calcRecipe(r, ingredients, business);
    return s + c.roundedPrice * (items[r.id] || 1);
  }, 0);

  const whatsappText = () => {
    let txt = "🧾 *Comanda RecetApp*\n\n";
    selected.forEach(r => {
      const c = calcRecipe(r, ingredients, business);
      txt += `• ${items[r.id]}x ${r.name} — $${(c.roundedPrice * items[r.id]).toLocaleString("es-AR")}\n`;
    });
    txt += `\n*TOTAL: $${total.toLocaleString("es-AR")}*`;
    return encodeURIComponent(txt);
  };
  const cleanPhone = phone.replace(/\D/g, "");
  const cleanCode  = countryCode.replace(/\D/g, "");
  const waLink = cleanPhone
    ? `https://wa.me/${cleanCode}${cleanPhone}?text=${whatsappText()}`
    : `https://wa.me/?text=${whatsappText()}`;

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h2 className="font-bold text-gray-800 text-lg mb-4">🧾 Armar comanda</h2>
        {cartCount > 0 && (
          <button onClick={useCartSelection}
            className="w-full flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-sm mb-4 hover:bg-amber-100 transition-colors">
            <span className="text-amber-800 font-medium">📋 Usar selección de Recetas ({cartCount}{cartLabel ? ` · ${cartLabel}` : ""})</span>
            <span className="text-amber-600 text-xs">Tocar para cargar →</span>
          </button>
        )}
        <div className="space-y-2">
          {recipes.map(r => {
            const c = calcRecipe(r, ingredients, business);
            const qty = items[r.id] || 0;
            return (
              <div key={r.id} className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${qty > 0 ? "border-misky-300 bg-misky-50" : "border-gray-100 bg-white hover:bg-gray-50"}`}>
                <input type="checkbox" checked={qty > 0}
                  onChange={() => toggle(r.id)}
                  className="w-5 h-5 accent-misky-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-800 text-sm">{r.name}</p>
                  <p className="text-xs text-gray-400">{r.category}</p>
                </div>
                <p className="font-bold text-misky-600">${c.roundedPrice.toLocaleString("es-AR")}</p>
                {qty > 0 && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => setQty(r.id, qty - 1)} className="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold text-sm flex items-center justify-center">−</button>
                    <input type="number" min="0" value={qty}
                      onChange={e => setQty(r.id, e.target.value)}
                      className="w-10 text-center border border-gray-200 rounded-lg py-0.5 text-sm font-medium" />
                    <button onClick={() => setQty(r.id, qty + 1)} className="w-7 h-7 rounded-full bg-misky-100 hover:bg-misky-200 text-misky-700 font-bold text-sm flex items-center justify-center">+</button>
                  </div>
                )}
              </div>
            );
          })}
          {recipes.length === 0 && <p className="text-center text-gray-400 py-8">Sin recetas disponibles</p>}
        </div>
      </div>

      {selected.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-misky-200 p-5 space-y-3">
          <h3 className="font-bold text-gray-700">Resumen</h3>
          {selected.map(r => {
            const c = calcRecipe(r, ingredients, business);
            return (
              <div key={r.id} className="flex justify-between text-sm">
                <span className="text-gray-600">{items[r.id]}× {r.name}</span>
                <span className="font-medium">${(c.roundedPrice * items[r.id]).toLocaleString("es-AR")}</span>
              </div>
            );
          })}
          <div className="flex justify-between border-t border-gray-100 pt-3 font-bold text-lg">
            <span>TOTAL</span>
            <span className="text-misky-600">${total.toLocaleString("es-AR")}</span>
          </div>
          <div className="flex gap-2 items-center pt-1">
            <div className="w-16">
              <input value={countryCode} onChange={e => setCountryCode(e.target.value)}
                placeholder="Cód." title="Código de país (ej: 54 Argentina)"
                className="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-misky-400" />
            </div>
            <input value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="N° de WhatsApp (opcional)" type="tel"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-400" />
          </div>
          <div className="flex gap-3">
            <a href={waLink} target="_blank" rel="noreferrer"
              className="flex-1 bg-green-500 hover:bg-green-600 text-white text-sm font-medium rounded-lg px-4 py-2.5 text-center transition-colors">
              📲 {cleanPhone ? "Enviar por WhatsApp" : "Compartir por WhatsApp"}
            </a>
            <button onClick={clearCart}
              className="px-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-500 hover:bg-gray-50 transition-colors">
              Limpiar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
// La selección (cartSel/cartBatch/cartLabel) vive en App(), no acá adentro,
// para no perderse al cambiar de pestaña y para poder reutilizarla directo en
// Comanda / Mise en place sin volver a tildar todo.
function Dashboard({ recipes, ingredients, setRecipes, business, profile,
                      cartSel, setCartSel, cartBatch, setCartBatch, cartLabel, setCartLabel }) {
  const canEdit = canEditTabPerms(profile, "dashboard") || profile?.role === "admin";
  const totalFixed = (business.fixed_costs || []).reduce((s, c) => s + (c.amount || 0), 0);
  const cfUnit     = business.monthly_units > 0 ? totalFixed / business.monthly_units : 0;

  const [modal, setModal]           = useState(null);
  const [bulkForm, setBulkForm]     = useState({ category: "", profit_pct: "" });
  const [bulkAddIng, setBulkAddIng] = useState({ ingredientId: "", qty: "" });
  const [bulkRemoveIngId, setBulkRemoveIngId] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);

  const ingredientsInSelected = useMemo(() => {
    const map = new Map();
    recipes.filter(r => cartSel?.[r.id]).forEach(r => (r.recipe_ingredients || []).forEach(ri => {
      const key = String(ri.ingredient_id);
      if (!map.has(key)) {
        const ing = ingredients.find(i => String(i.id) === key);
        if (ing) map.set(key, ing);
      }
    }));
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [recipes, cartSel, ingredients]);

  // Aplica el mismo cambio (categoría y/o % de ganancia) a todas las recetas
  // tildadas de una sola vez — útil para corregir en masa, por ejemplo si un
  // import dejó el rubro en "General" y hay que reasignarlo por lote.
  const applyBulkEdit = async () => {
    const ids = Object.entries(cartSel || {}).filter(([, v]) => v).map(([id]) => id);
    if (ids.length === 0) return;
    const patch = {};
    if (bulkForm.category.trim() !== "") patch.category = bulkForm.category.trim();
    if (bulkForm.profit_pct.trim() !== "") patch.profit_pct = +bulkForm.profit_pct;
    if (Object.keys(patch).length === 0) return;

    setBulkSaving(true);
    await supabase.from("recipes").update(patch).in("id", ids);
    setRecipes(prev => sortByName(prev.map(r => ids.includes(String(r.id)) ? { ...r, ...patch } : r)));
    await logActivity(profile, "update", "recetas",
      `Edición en lote (${ids.length}): ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    setBulkSaving(false);
    setModal(null);
    setBulkForm({ category: "", profit_pct: "" });
  };

  // Agrega (o actualiza la cantidad de) un ingrediente en todas las recetas
  // tildadas de una sola vez — por ejemplo, sumar "Descartable" a un grupo de
  // recetas que lo necesitan sin tener que editarlas una por una.
  const applyBulkAddIngredient = async () => {
    const ids = Object.entries(cartSel || {}).filter(([, v]) => v).map(([id]) => id);
    if (ids.length === 0 || !bulkAddIng.ingredientId || bulkAddIng.qty.trim() === "") return;
    const qtyNum = +bulkAddIng.qty;
    setBulkSaving(true);
    const targetRecipes = recipes.filter(r => ids.includes(String(r.id)));
    const toUpdate = [];
    const toInsertRecipeIds = [];
    targetRecipes.forEach(r => {
      const existing = (r.recipe_ingredients || []).find(ri => String(ri.ingredient_id) === String(bulkAddIng.ingredientId));
      if (existing) toUpdate.push(existing.id);
      else toInsertRecipeIds.push(String(r.id));
    });
    if (toUpdate.length > 0) {
      await Promise.all(toUpdate.map(lineId => supabase.from("recipe_ingredients").update({ qty: qtyNum }).eq("id", lineId)));
    }
    let inserted = [];
    if (toInsertRecipeIds.length > 0) {
      const { data } = await supabase.from("recipe_ingredients")
        .insert(toInsertRecipeIds.map(recipeId => ({ recipe_id: recipeId, ingredient_id: bulkAddIng.ingredientId, qty: qtyNum })))
        .select();
      inserted = data || [];
    }
    setRecipes(prev => sortByName(prev.map(r => {
      if (!ids.includes(String(r.id))) return r;
      const lines = (r.recipe_ingredients || []).map(ri =>
        String(ri.ingredient_id) === String(bulkAddIng.ingredientId) ? { ...ri, qty: qtyNum } : ri
      );
      const newLine = inserted.find(ins => String(ins.recipe_id) === String(r.id));
      if (newLine) lines.push(newLine);
      return { ...r, recipe_ingredients: lines };
    })));
    const ingName = ingredients.find(i => String(i.id) === String(bulkAddIng.ingredientId))?.name || "";
    await logActivity(profile, "update", "recetas",
      `Ingrediente agregado en lote: ${ingName} (${qtyNum}) en ${ids.length} recetas`);
    setBulkSaving(false);
    setBulkAddIng({ ingredientId: "", qty: "" });
  };

  // Quita un ingrediente de todas las recetas tildadas que lo tengan cargado.
  const applyBulkRemoveIngredient = async () => {
    const ids = Object.entries(cartSel || {}).filter(([, v]) => v).map(([id]) => id);
    if (ids.length === 0 || !bulkRemoveIngId) return;
    setBulkSaving(true);
    await supabase.from("recipe_ingredients").delete().eq("ingredient_id", bulkRemoveIngId).in("recipe_id", ids);
    setRecipes(prev => sortByName(prev.map(r => {
      if (!ids.includes(String(r.id))) return r;
      return { ...r, recipe_ingredients: (r.recipe_ingredients || []).filter(ri => String(ri.ingredient_id) !== String(bulkRemoveIngId)) };
    })));
    const ingName = ingredients.find(i => String(i.id) === String(bulkRemoveIngId))?.name || "";
    await logActivity(profile, "delete", "recetas",
      `Ingrediente quitado en lote: ${ingName} de ${ids.length} recetas`);
    setBulkSaving(false);
    setBulkRemoveIngId("");
  };

  const toggleSelect = (id) => setCartSel(prev => ({ ...prev, [id]: !prev[id] }));
  const selectedCount = Object.values(cartSel || {}).filter(Boolean).length;
  const allSelected = recipes.length > 0 && recipes.every(r => cartSel?.[r.id]);
  const toggleSelectAll = () => {
    if (allSelected) { setCartSel({}); return; }
    const next = {}; recipes.forEach(r => { next[r.id] = true; });
    setCartSel(next);
  };
  const clearSelection = () => { setCartSel({}); setCartBatch({}); setCartLabel(""); };
  const setBatch = (id, val) => {
    const n = Math.max(1, parseInt(val) || 1);
    setCartBatch(prev => ({ ...prev, [id]: n }));
  };
  const selectedRecipes = recipes.filter(r => cartSel?.[r.id]);
  const selectedRecipesWithBatches = selectedRecipes.map(r => ({ ...r, _batches: +(cartBatch?.[r.id]) || 1 }));

  const deleteSelected = async () => {
    const ids = selectedRecipes.map(r => r.id);
    if (ids.length === 0) return;
    await supabase.from("recipes").delete().in("id", ids);
    setRecipes(prev => prev.filter(r => !ids.includes(r.id)));
    await logActivity(profile, "delete", "recetas", ids.length + " recetas (borrado masivo)");
    clearSelection();
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Ingredientes"    value={ingredients.length} accent="sky" />
        <StatCard label="Recetas activas" value={recipes.length}     accent="misky" />
        <StatCard label="Costos fijos/mes" value={`$${totalFixed.toLocaleString("es-AR")}`} accent="rose" />
        <StatCard label="CF x unidad"     value={`$${cfUnit.toFixed(2)}`} accent="amber" />
      </div>
      {canEdit && selectedCount > 0 && (
        <div className="bg-misky-50 border border-misky-100 rounded-xl px-4 py-3 space-y-2.5">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-misky-700">{selectedCount} seleccionada{selectedCount !== 1 ? "s" : ""}</span>
            <input value={cartLabel} onChange={e => setCartLabel(e.target.value)} placeholder="Etiqueta (ej: Mesa 5, Juan)..."
                   className="border border-misky-200 rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-misky-400 w-44" />
            <button onClick={clearSelection} className="text-sm text-gray-400 hover:text-gray-600 ml-auto">Cancelar selección</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {selectedRecipes.map(r => (
              <span key={r.id} className="inline-flex items-center gap-1 bg-white border border-misky-200 rounded-full pl-2 pr-1 py-0.5 text-xs text-gray-600">
                {r.name}
                <input type="number" min="1" value={cartBatch?.[r.id] || 1} onChange={e => setBatch(r.id, e.target.value)}
                  title="Cantidad de tandas" className="w-9 text-center border-none bg-transparent text-misky-600 font-semibold focus:outline-none" />×
                <button onClick={() => setCartSel(prev => ({ ...prev, [r.id]: false }))} className="text-gray-300 hover:text-rose-400 px-1">×</button>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => downloadRecipesText(selectedRecipesWithBatches, ingredients, business)} className="text-sm text-misky-700 hover:text-misky-800 font-medium underline">🖨️ Imprimir {selectedCount} receta{selectedCount !== 1 ? "s" : ""}</button>
            <button onClick={() => downloadShoppingListHTML(selectedRecipesWithBatches, ingredients, business)} className="text-sm text-misky-700 hover:text-misky-800 font-medium underline">🛒 Lista de compras</button>
            <button onClick={() => setModal("bulkEdit")} className="text-sm text-misky-700 hover:text-misky-800 font-medium underline">✏️ Editar en lote ({selectedCount})</button>
            <button onClick={deleteSelected} className="text-sm text-rose-600 hover:text-rose-700 font-medium underline">🗑 Eliminar</button>
          </div>
        </div>
      )}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-700">Resumen de recetas</h3>
          <Pill color="misky">{recipes.length} recetas</Pill>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                {canEdit && (
                  <th className="px-4 py-3 w-8">
                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="w-4 h-4 accent-misky-500" />
                  </th>
                )}
                {["Receta","Porciones","Costo/porción","Precio redondeado","Ganancia %"].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recipes.map((r, idx) => {
                const c = calcRecipe(r, ingredients, business);
                return (
                  <tr key={r.id} className={`border-b border-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/30"} ${cartSel?.[r.id] ? "bg-misky-50/60" : ""}`}>
                    {canEdit && (
                      <td className="px-4 py-3">
                        <input type="checkbox" checked={!!cartSel?.[r.id]} onChange={() => toggleSelect(r.id)} className="w-4 h-4 accent-misky-500" />
                      </td>
                    )}
                    <td className="px-4 py-3 font-medium text-gray-800">{r.name}</td>
                    <td className="px-4 py-3 text-gray-500">{r.portions}</td>
                    <td className="px-4 py-3 text-rose-600 font-medium">${c.totalCost.toFixed(2)}</td>
                    <td className="px-4 py-3 font-bold text-misky-600 text-base">${c.roundedPrice.toLocaleString("es-AR")}</td>
                    <td className="px-4 py-3">
                      <Pill color={c.realProfitPct >= 35 ? "misky" : c.realProfitPct >= 20 ? "amber" : "rose"}>
                        {c.realProfitPct.toFixed(1)}%
                      </Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {recipes.length === 0 && <div className="text-center py-10 text-gray-400">Creá tu primera receta en la pestaña Recetas</div>}
        </div>
      </div>

      {modal === "bulkEdit" && (
        <Modal title={`Editar en lote (${selectedCount} recetas)`} onClose={() => setModal(null)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Completá solo lo que quieras cambiar — el campo que dejes vacío no se toca. Se aplica a las{" "}
              <strong>{selectedCount}</strong> recetas tildadas.
            </p>
            <Field label="Categoría / Rubro (opcional)">
              <TextInput value={bulkForm.category} onChange={e => setBulkForm(f => ({ ...f, category: e.target.value }))} placeholder="Ej: Carnes" />
            </Field>
            <Field label="% de ganancia (opcional)">
              <TextInput value={bulkForm.profit_pct} onChange={e => setBulkForm(f => ({ ...f, profit_pct: e.target.value.replace(/[^0-9.]/g,"") }))} type="number" placeholder="Ej: 40" />
            </Field>
            <div className="flex justify-end gap-3 pt-2">
              <Btn variant="secondary" onClick={() => setModal(null)}>Cancelar</Btn>
              <Btn onClick={applyBulkEdit} disabled={bulkSaving || (bulkForm.category.trim()==="" && bulkForm.profit_pct.trim()==="")}>
                {bulkSaving ? "Aplicando..." : "Aplicar cambios"}
              </Btn>
            </div>

            <div className="border-t border-gray-100 pt-4 space-y-4">
              <p className="text-sm font-semibold text-gray-700">Ingredientes</p>

              <div className="bg-misky-50 border border-misky-100 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-misky-700">➕ Agregar un ingrediente a las {selectedCount} recetas</p>
                <div className="flex flex-col gap-2">
                  <select value={bulkAddIng.ingredientId} onChange={e => setBulkAddIng(f => ({ ...f, ingredientId: e.target.value }))}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-300 bg-white">
                    <option value="">Elegir ingrediente...</option>
                    {[...ingredients].sort((a, b) => a.name.localeCompare(b.name, "es")).map(i => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </select>
                  <input value={bulkAddIng.qty} onChange={e => setBulkAddIng(f => ({ ...f, qty: e.target.value.replace(/[^0-9.]/g, "") }))}
                         placeholder="Cantidad" type="number"
                         className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-misky-300" />
                </div>
                <p className="text-[11px] text-misky-600">Si alguna receta ya tenía ese ingrediente, se le actualiza la cantidad. Al resto se lo agrega.</p>
                <div className="flex justify-end">
                  <Btn onClick={applyBulkAddIngredient} disabled={bulkSaving || !bulkAddIng.ingredientId || bulkAddIng.qty.trim() === ""}>
                    {bulkSaving ? "Aplicando..." : "Agregar a todas"}
                  </Btn>
                </div>
              </div>

              <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-rose-700">➖ Quitar un ingrediente de las {selectedCount} recetas</p>
                <select value={bulkRemoveIngId} onChange={e => setBulkRemoveIngId(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-300 bg-white">
                  <option value="">Elegir ingrediente...</option>
                  {ingredientsInSelected.map(i => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
                {ingredientsInSelected.length === 0 && (
                  <p className="text-[11px] text-rose-400">Ninguna de las recetas tildadas tiene ingredientes cargados todavía.</p>
                )}
                <div className="flex justify-end">
                  <Btn variant="danger" onClick={applyBulkRemoveIngredient} disabled={bulkSaving || !bulkRemoveIngId}>
                    {bulkSaving ? "Aplicando..." : "Quitar de todas"}
                  </Btn>
                </div>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── MISE EN PLACE ────────────────────────────────────────────────────────────
// Elegís qué recetas se van a cocinar (y en cuántas tandas) y te arma una
// lista con la cantidad TOTAL de cada ingrediente a pesar/preparar — sin
// precios, sin redondear para compra, agrupada por rubro y tildable.
function MiseEnPlaceTab({ recipes, ingredients, business, cartSel, cartBatch, cartLabel }) {
  const [items, setItems] = useState({});
  const [search, setSearch] = useState("");

  const cartCount = Object.values(cartSel || {}).filter(Boolean).length;
  const useCartSelection = () => {
    const next = {};
    Object.entries(cartSel || {}).forEach(([id, on]) => {
      if (on) next[id] = +(cartBatch?.[id]) || 1;
    });
    setItems(next);
  };

  const toggle = (id) => setItems(p => ({ ...p, [id]: (p[id] || 0) === 0 ? 1 : p[id] }));
  const setBatches = (id, val) => {
    const n = Math.max(0, parseInt(val) || 0);
    setItems(p => ({ ...p, [id]: n }));
  };

  const selected = recipes.filter(r => (items[r.id] || 0) > 0);
  const filteredRecipes = recipes.filter(r =>
    normalizeText(r.name).includes(normalizeText(search)) ||
    normalizeText(r.category || "").includes(normalizeText(search))
  );

  const generar = () => {
    downloadMisePrepHTML(
      selected.map(r => ({ ...r, _batches: items[r.id] || 1 })),
      ingredients, business
    );
  };

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h2 className="font-bold text-gray-800 text-lg mb-1">🔪 Mise en place</h2>
        <p className="text-sm text-gray-500 mb-4">Elegí qué recetas vas a cocinar y te armo la lista con la cantidad total de cada ingrediente, lista para pesar y preparar.</p>
        {cartCount > 0 && (
          <button onClick={useCartSelection}
            className="w-full flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-sm mb-3 hover:bg-amber-100 transition-colors">
            <span className="text-amber-800 font-medium">📋 Usar selección de Recetas ({cartCount}{cartLabel ? ` · ${cartLabel}` : ""})</span>
            <span className="text-amber-600 text-xs">Tocar para cargar →</span>
          </button>
        )}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar receta..."
               className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-misky-400" />
        {selected.length > 0 && (
          <div className="flex justify-between items-center bg-misky-50 border border-misky-100 rounded-lg px-3 py-2 text-sm mb-3">
            <span className="font-semibold text-misky-700">🔪 {selected.length} receta{selected.length !== 1 ? "s" : ""} para preparar</span>
          </div>
        )}
        <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
          {filteredRecipes.map(r => {
            const qty = items[r.id] || 0;
            return (
              <div key={r.id} className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${qty > 0 ? "border-misky-300 bg-misky-50" : "border-gray-100 bg-white hover:bg-gray-50"}`}>
                <input type="checkbox" checked={qty > 0}
                  onChange={() => toggle(r.id)}
                  className="w-5 h-5 accent-misky-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-800 text-sm">{r.name}</p>
                  <p className="text-xs text-gray-400">{r.category} · {r.portions} porc.</p>
                </div>
                {qty > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-400 mr-1">Tandas</span>
                    <button onClick={() => setBatches(r.id, qty - 1)} className="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold text-sm flex items-center justify-center">−</button>
                    <input type="number" min="0" value={qty}
                      onChange={e => setBatches(r.id, e.target.value)}
                      className="w-10 text-center border border-gray-200 rounded-lg py-0.5 text-sm font-medium" />
                    <button onClick={() => setBatches(r.id, qty + 1)} className="w-7 h-7 rounded-full bg-misky-100 hover:bg-misky-200 text-misky-700 font-bold text-sm flex items-center justify-center">+</button>
                  </div>
                )}
              </div>
            );
          })}
          {filteredRecipes.length === 0 && recipes.length > 0 && <p className="text-center text-gray-400 py-8">🔍 Sin resultados</p>}
          {recipes.length === 0 && <p className="text-center text-gray-400 py-8">Sin recetas disponibles</p>}
        </div>
      </div>

      {selected.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-misky-200 p-5 space-y-3">
          <Btn onClick={generar} className="w-full">🔪 Generar mise en place ({selected.length})</Btn>
          <button onClick={() => setItems({})}
            className="w-full px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-500 hover:bg-gray-50 transition-colors">
            Limpiar selección
          </button>
        </div>
      )}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser]           = useState(null);
  const [profile, setProfile]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);
  // La pestaña activa se guarda en localStorage para que un refresh/actualización
  // de la app (o que Vercel despliegue una versión nueva) no te mande de vuelta a
  // Resumen — te deja donde estabas.
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem("recetapp_last_tab") || "dashboard"; } catch { return "dashboard"; }
  });
  const [ingredients, setIngredients] = useState([]);
  const [recipes, setRecipes]         = useState([]);
  const [business, setBusiness]       = useState({ fixed_costs:[], monthly_units:500, delivery_pct:5, iva_pct:21, other_var_pct:2 });

  // Selección de recetas para imprimir / lista de compras / comanda / mise en
  // place — vive acá (no adentro de RecipesTab ni de Dashboard) para que no se
  // pierda al cambiar de pestaña, y para poder reutilizarla directo en
  // Comanda y Mise en place sin volver a tildar todo.
  const lsJSON = (key, fallback) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  };
  const [cartSel, setCartSel]     = useState(() => lsJSON("recetapp_cart_sel", {}));      // recipeId -> true
  const [cartBatch, setCartBatch] = useState(() => lsJSON("recetapp_cart_batch", {}));    // recipeId -> tandas
  const [cartLabel, setCartLabel] = useState(() => {
    try { return localStorage.getItem("recetapp_cart_label") || ""; } catch { return ""; }
  });

  useEffect(() => { try { localStorage.setItem("recetapp_cart_sel", JSON.stringify(cartSel)); } catch {} }, [cartSel]);
  useEffect(() => { try { localStorage.setItem("recetapp_cart_batch", JSON.stringify(cartBatch)); } catch {} }, [cartBatch]);
  useEffect(() => { try { localStorage.setItem("recetapp_cart_label", cartLabel); } catch {} }, [cartLabel]);

  useEffect(() => { try { localStorage.setItem("recetapp_last_tab", tab); } catch {} }, [tab]);

  // Si la pestaña recordada ya no es válida para este perfil (cambiaron sus
  // permisos, o el dispositivo lo comparte otro usuario), la corrige apenas
  // carga el perfil en vez de dejarla en una pestaña que no puede ver.
  useEffect(() => {
    if (!profile) return;
    const visible = getVisibleTabIds(profile);
    setTab(prev => (visible.includes(prev) ? prev : (visible[0] || "dashboard")));
  }, [profile]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) { setUser(session.user); loadProfile(session.user.id); }
      else setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      // Link de "olvidé mi contraseña": Supabase dispara este evento antes de
      // loguear de verdad — mostramos la pantalla de "elegir nueva contraseña"
      // en vez de entrar directo a la app.
      if (_event === "PASSWORD_RECOVERY") { setUser(session?.user ?? null); setRecoveryMode(true); setLoading(false); return; }
      if (session?.user) { setUser(session.user); loadProfile(session.user.id); }
      else { setUser(null); setProfile(null); setLoading(false); }
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadProfile = async (uid) => {
    const { data: prof } = await supabase.from("profiles").select("*").eq("id", uid).single();
    setProfile(prof);
    await loadData();
    setLoading(false);
  };

  const loadData = async () => {
    const [{ data: ings }, { data: recs }, { data: biz }] = await Promise.all([
      supabase.from("ingredients").select("*").order("name"),
      supabase.from("recipes").select("*, recipe_ingredients(*)").order("name"),
      supabase.from("business").select("*").eq("id", 1).single(),
    ]);
    setIngredients(sortByName(ings || []));
    setRecipes(sortByName(recs || []));
    if (biz) setBusiness(biz);
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null); setProfile(null); setTab("dashboard");
  };

  if (loading) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-misky-50">
      <img src="/logo-icono.svg" alt="Misky Mikuy" className="h-12 w-12" />
      <div className="text-misky-600 text-lg font-medium">Cargando...</div>
    </div>
  );
  if (recoveryMode) return (
    <SetNewPasswordScreen onDone={() => {
      setRecoveryMode(false);
      if (user) loadProfile(user.id); else setLoading(false);
    }} />
  );
  if (!user) return <LoginScreen onLogin={(u) => { setUser(u); loadProfile(u.id); }} />;
  if (!profile) return (
    <div className="min-h-screen flex items-center justify-center bg-misky-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm text-center space-y-3">
        <div className="text-5xl">🔒</div>
        <h2 className="font-bold text-gray-800 text-lg">Cuenta sin acceso todavía</h2>
        <p className="text-sm text-gray-500">Entraste con <strong>{user.email}</strong>, pero todavía no tenés permisos asignados en RecetApp. Pedile a un administrador que te dé de alta desde la pestaña Usuarios.</p>
        <button onClick={logout} className="text-sm text-misky-600 hover:text-misky-700 font-medium">Cerrar sesión</button>
      </div>
    </div>
  );

  const roleColor = { admin: "rose", editor: "misky", viewer: "sky", viewer_partial: "violet", custom: "violet" };
  const roleLabel = { admin: "Admin", editor: "Editor", viewer: "Solo lectura", viewer_partial: "Vista parcial", custom: "Personalizado" };

  const canSeeTab = (id) => canSeeTabPerms(profile, id);
  const canEditTab = (id) => canEditTabPerms(profile, id);
  const esMozo = profile?.permissions?.es_mozo === true;
  const TABS = [
    { id:"dashboard",   label:"📊 Resumen",       show: !esMozo && canSeeTab("dashboard") },
    { id:"recipes",     label:"🍽️ Recetas",       show: !esMozo && canSeeTab("recipes") },
    { id:"ingredients", label:"📦 Ingredientes",   show: !esMozo && canSeeTab("ingredients") },
    { id:"business",    label:"⚙️ Costos",         show: !esMozo && canSeeTab("business") },
    { id:"comanda",     label:"🧾 Comanda",        show: esMozo },
    { id:"miseenplace", label:"🔪 Mise en place",  show: !esMozo && canSeeTab("recipes") },
    { id:"admin",       label:"👥 Usuarios",       show: profile?.permissions?.usuarios === true },
  ].filter(t => t.show);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/logo-icono.svg" alt="Misky Mikuy" className="h-8 w-8" />
            <span className="font-bold text-gray-800 text-lg">RecetApp</span>
          </div>
          <nav className="hidden md:flex gap-1">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${tab === t.id ? "bg-misky-50 text-misky-700" : "text-gray-500 hover:bg-gray-50"}`}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <button onClick={() => {
                if (tab === "ingredients") exportIngredientsCSV(ingredients);
                else if (tab === "business") exportBusinessCSV(business);
                else exportCSV(recipes, ingredients, business);
              }}
              className="hidden sm:flex items-center gap-1.5 text-sm text-gray-600 hover:text-misky-600 border border-gray-200 rounded-lg px-3 py-1.5 transition-colors">
              ⬇️ CSV
            </button>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-misky-600 flex items-center justify-center text-white text-xs font-bold">
                {(profile?.username || "?")[0].toUpperCase()}
              </div>
              <div className="hidden sm:block">
                <p className="text-xs font-medium text-gray-700 leading-tight">{profile?.username}</p>
                <Pill color={roleColor[profile?.role] || "gray"}>{roleLabel[profile?.role] || profile?.role}</Pill>
              </div>
            </div>
            <button onClick={logout} className="text-sm text-gray-400 hover:text-gray-700 transition-colors">Salir</button>
          </div>
        </div>
        <div className="md:hidden flex overflow-x-auto border-t border-gray-100 px-2 py-1 gap-1">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg ${tab === t.id ? "bg-misky-50 text-misky-700" : "text-gray-500"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-5">
        {tab === "dashboard"   && <Dashboard ingredients={ingredients} recipes={recipes} setRecipes={setRecipes} business={business} profile={profile}
                                     cartSel={cartSel} setCartSel={setCartSel} cartBatch={cartBatch} setCartBatch={setCartBatch}
                                     cartLabel={cartLabel} setCartLabel={setCartLabel} />}
        {tab === "recipes"     && <RecipesTab recipes={recipes} setRecipes={setRecipes} ingredients={ingredients} setIngredients={setIngredients} business={business} profile={profile} />}
        {tab === "ingredients" && <IngredientsTab ingredients={ingredients} setIngredients={setIngredients} profile={profile} />}
        {tab === "business"    && <BusinessTab business={business} setBusiness={setBusiness} profile={profile} />}
        {tab === "admin"       && profile?.permissions?.usuarios === true && <AdminPanel profile={profile} />}
        {tab === "comanda"     && <ComandaTab recipes={recipes} ingredients={ingredients} business={business} profile={profile}
                                     cartSel={cartSel} cartBatch={cartBatch} cartLabel={cartLabel} />}
        {tab === "miseenplace" && <MiseEnPlaceTab recipes={recipes} ingredients={ingredients} business={business}
                                     cartSel={cartSel} cartBatch={cartBatch} cartLabel={cartLabel} />}
      </main>
    </div>
  );
}
