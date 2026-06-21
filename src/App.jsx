import { useState, useEffect, useRef, useCallback } from "react";
// ─── STORAGE (localStorage para deploy standalone) ───────────────────────────
const sget = (key) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
  catch { return null; }
};
const sset = (key, val) => {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
};
const KEY_USERS   = "recetapp:users";
const KEY_SESSION = "recetapp:session";
const kIng  = (u) => `recetapp:${u}:ingredients`;
const kRec  = (u) => `recetapp:${u}:recipes`;
const kBiz  = (u) => `recetapp:${u}:business`;
// ─── DEFAULT DATA ─────────────────────────────────────────────────────────────
const DEFAULT_INGREDIENTS = [
  { id:1,  name:"Harina 000",     category:"Secos",   unit:"kg",  buyPrice:450,  buyQty:1,    wastePct:0  },
  { id:2,  name:"Harina 0000",    category:"Secos",   unit:"kg",  buyPrice:520,  buyQty:1,    wastePct:0  },
  { id:3,  name:"Azúcar",         category:"Secos",   unit:"kg",  buyPrice:380,  buyQty:1,    wastePct:0  },
  { id:4,  name:"Manteca",        category:"Lácteos", unit:"kg",  buyPrice:2100, buyQty:1,    wastePct:3  },
  { id:5,  name:"Huevos",         category:"Frescos", unit:"u",   buyPrice:180,  buyQty:12,   wastePct:2  },
  { id:6,  name:"Leche entera",   category:"Lácteos", unit:"lt",  buyPrice:350,  buyQty:1,    wastePct:0  },
  { id:7,  name:"Crema de leche", category:"Lácteos", unit:"lt",  buyPrice:980,  buyQty:1,    wastePct:0  },
  { id:8,  name:"Levadura seca",  category:"Secos",   unit:"kg",  buyPrice:1800, buyQty:0.5,  wastePct:0  },
  { id:9,  name:"Sal fina",       category:"Secos",   unit:"kg",  buyPrice:120,  buyQty:1,    wastePct:0  },
  { id:10, name:"Cacao en polvo", category:"Secos",   unit:"kg",  buyPrice:2800, buyQty:1,    wastePct:0  },
  { id:11, name:"Dulce de leche", category:"Dulces",  unit:"kg",  buyPrice:2400, buyQty:1,    wastePct:2  },
  { id:12, name:"Nueces",         category:"Frutas",  unit:"kg",  buyPrice:4500, buyQty:1,    wastePct:10 },
];
const DEFAULT_BUSINESS = {
  fixedCosts: [
    { id:1, name:"Alquiler / local",           amount:25000 },
    { id:2, name:"Servicios (luz, gas, agua)", amount:8000  },
    { id:3, name:"Sueldos fijos",              amount:40000 },
    { id:4, name:"Seguro",                     amount:2000  },
    { id:5, name:"Contador / asesor",          amount:4000  },
    { id:6, name:"Otros",                      amount:0     },
  ],
  monthlyUnits: 500,
  deliveryPct:  5,
  ivaPct:       21,
  otherVarPct:  2,
};
const DEFAULT_RECIPES = [
  {
    id:1, name:"Medialunas de manteca", category:"Panadería", portions:24, profitPct:40,
    ingredients:[
      { ingredientId:1, qty:0.500 }, { ingredientId:4, qty:0.150 },
      { ingredientId:3, qty:0.080 }, { ingredientId:5, qty:2     },
      { ingredientId:8, qty:0.010 }, { ingredientId:9, qty:0.005 },
      { ingredientId:6, qty:0.120 },
    ]
  },
  {
    id:2, name:"Torta de chocolate", category:"Pastelería", portions:12, profitPct:40,
    ingredients:[
      { ingredientId:2, qty:0.250 }, { ingredientId:3, qty:0.300 },
      { ingredientId:10,qty:0.080 }, { ingredientId:5, qty:3     },
      { ingredientId:4, qty:0.120 }, { ingredientId:6, qty:0.250 },
      { ingredientId:7, qty:0.100 },
    ]
  },
];
// ─── CALCULATIONS ─────────────────────────────────────────────────────────────
function unitCost(ing) {
  const base = ing.buyQty > 0 ? ing.buyPrice / ing.buyQty : 0;
  return ing.wastePct > 0 ? base / (1 - ing.wastePct / 100) : base;
}
function calcRecipe(recipe, ingredients, business) {
  const ingMap = Object.fromEntries(ingredients.map(i => [i.id, i]));
  const totalFixed = business.fixedCosts.reduce((s, c) => s + (c.amount || 0), 0);
  const cfPerUnit  = business.monthlyUnits > 0 ? totalFixed / business.monthlyUnits : 0;
  const varPct     = ((business.deliveryPct||0) + (business.ivaPct||0) + (business.otherVarPct||0)) / 100;
  let mpTotal = 0;
  const lines = recipe.ingredients.map(ri => {
    const ing = ingMap[ri.ingredientId];
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
  const profitPct      = (recipe.profitPct || 40) / 100;
  const suggestedPrice = profitPct < 1 ? totalCost / (1 - profitPct) : totalCost * 2;
  const roundedPrice   = Math.ceil(suggestedPrice / 50) * 50;
  const realProfit     = roundedPrice - totalCost;
  const realProfitPct  = roundedPrice > 0 ? (realProfit / roundedPrice) * 100 : 0;
  return { lines, mpTotal, mpPerPortion, cfPerUnit, varCost, varPct,
           totalCost, suggestedPrice, roundedPrice, realProfit, realProfitPct };
}
// ─── EXPORT CSV ───────────────────────────────────────────────────────────────
function exportCSV(recipes, ingredients, business) {
  const S = ";";
  const n = (v) => v.toString().replace(".", ",");
  let csv = "sep=;\n";
  csv += `COSTEO DE RECETAS\n\n`;
  recipes.forEach(r => {
    const c = calcRecipe(r, ingredients, business);
    csv += `RECETA${S}${r.name}\n`;
    csv += `Categoría${S}${r.category}\n`;
    csv += `Porciones${S}${r.portions}\n\n`;
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
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = "RecetApp_Costeo.csv"; a.click();
  URL.revokeObjectURL(url);
}
// ─── PARSE CSV/SHEET para importar ingredientes ───────────────────────────────
function parseIngredientsCSV(text) {
  const firstLine = text.split(/\r?\n/)[0];
  const sep = firstLine.includes(";") ? ";" : ",";
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error("El archivo debe tener encabezado y al menos una fila de datos.");
  const headers = lines[0].split(sep).map(h =>
    h.trim().toLowerCase().replace(/[^a-záéíóúüñ0-9]/gi, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  );
  const colMap = {
    name:      ["nombre", "ingrediente", "name"],
    category:  ["categoria", "category", "rubro", "tipo"],
    unit:      ["unidad", "unit", "medida"],
    buyPrice:  ["precio", "price", "costo", "preciocompra", "buyPrice"],
    buyQty:    ["cantidad", "qty", "cantidadcompra", "bulto"],
    wastePct:  ["merma", "waste", "mermapct", "wastePct"],
  };
  const idx = {};
  for (const [key, aliases] of Object.entries(colMap)) {
    for (const alias of aliases) {
      const i = headers.indexOf(alias);
      if (i !== -1) { idx[key] = i; break; }
    }
  }
  if (idx.name === undefined) throw new Error("No se encontró la columna 'Nombre' en el archivo.");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
    const name = cols[idx.name]?.trim();
    if (!name) continue;
    const toNum = (v) => {
      if (v === undefined || v === "" || v === null) return 0;
      return parseFloat(v.replace(",", ".")) || 0;
    };
    rows.push({
      name,
      category: cols[idx.category]?.trim() || "General",
      unit:     cols[idx.unit]?.trim()     || "kg",
      buyPrice: toNum(cols[idx.buyPrice]),
      buyQty:   toNum(cols[idx.buyQty]) || 1,
      wastePct: toNum(cols[idx.wastePct]),
    });
  }
  if (rows.length === 0) throw new Error("No se encontraron filas válidas en el archivo.");
  return rows;
}
// ─── UI PRIMITIVES ────────────────────────────────────────────────────────────
function Pill({ children, color = "emerald" }) {
  const map = {
    emerald: "bg-emerald-100 text-emerald-700",
    amber:   "bg-amber-100 text-amber-700",
    rose:    "bg-rose-100 text-rose-700",
    sky:     "bg-sky-100 text-sky-700",
    violet:  "bg-violet-100 text-violet-700",
  };
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${map[color] || map.emerald}`}>{children}</span>;
}
function StatCard({ label, value, sub, accent = "emerald" }) {
  const map = {
    emerald: "border-l-emerald-500 bg-emerald-50",
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
// ─── MODAL ────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div
        className={`bg-white rounded-2xl shadow-2xl ${wide ? "max-w-3xl" : "max-w-lg"} w-full max-h-[90vh] overflow-y-auto`}
      >
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
function TextInput({ value, onChange, type = "text", placeholder, suffix, step, min, max }) {
  return (
    <div className="relative">
      <input
        type={type} value={value} onChange={onChange}
        placeholder={placeholder} step={step} min={min} max={max}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white"
      />
      {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">{suffix}</span>}
    </div>
  );
}
function Btn({ children, onClick, variant = "primary", size = "md", disabled = false, className = "" }) {
  const v = {
    primary:   "bg-emerald-600 hover:bg-emerald-700 text-white",
    secondary: "bg-white border border-gray-200 hover:bg-gray-50 text-gray-700",
    danger:    "bg-rose-500 hover:bg-rose-600 text-white",
    ghost:     "hover:bg-gray-100 text-gray-600",
  };
  const s = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-6 py-3 text-base" };
  return (
    <button
      onClick={onClick} disabled={disabled}
      className={`font-medium rounded-lg transition-colors ${v[variant]} ${s[size]} ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ username: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const handle = () => {
    setError("");
    const users = sget(KEY_USERS) || {};
    if (mode === "register") {
      if (!form.username.trim() || !form.password) return setError("Completá todos los campos.");
      if (form.password !== form.confirm) return setError("Las contraseñas no coinciden.");
      if (users[form.username]) return setError("Ese usuario ya existe.");
      users[form.username] = { password: form.password };
      sset(KEY_USERS, users);
      sset(kIng(form.username), DEFAULT_INGREDIENTS);
      sset(kRec(form.username), DEFAULT_RECIPES);
      sset(kBiz(form.username), DEFAULT_BUSINESS);
    } else {
      if (!users[form.username] || users[form.username].password !== form.password)
        return setError("Usuario o contraseña incorrectos.");
    }
    sset(KEY_SESSION, { username: form.username });
    onLogin(form.username);
  };
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  return (
    <div className="min-h-screen flex items-center justify-center p-4"
         style={{ background: "linear-gradient(135deg,#064e3b 0%,#065f46 50%,#047857 100%)" }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-6xl mb-3">🍽️</div>
          <h1 className="text-3xl font-bold text-white tracking-tight">RecetApp</h1>
          <p className="text-emerald-200 text-sm mt-1">Costeo inteligente de recetas</p>
        </div>
        <div className="bg-white rounded-2xl shadow-2xl p-7">
          <div className="flex bg-gray-100 rounded-lg p-1 mb-6">
            {["login", "register"].map(m => (
              <button key={m} onClick={() => { setMode(m); setError(""); }}
                      className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${mode === m ? "bg-white shadow text-emerald-700" : "text-gray-500"}`}>
                {m === "login" ? "Iniciar sesión" : "Registrarse"}
              </button>
            ))}
          </div>
          <div className="space-y-4">
            <Field label="Usuario">
              <TextInput value={form.username} onChange={f("username")} placeholder="tu_usuario" />
            </Field>
            <Field label="Contraseña">
              <TextInput value={form.password} onChange={f("password")} type="password" placeholder="••••••••" />
            </Field>
            {mode === "register" && (
              <Field label="Confirmar contraseña">
                <TextInput value={form.confirm} onChange={f("confirm")} type="password" placeholder="••••••••" />
              </Field>
            )}
            {error && <p className="text-rose-500 text-sm bg-rose-50 px-3 py-2 rounded-lg">{error}</p>}
            <Btn onClick={handle} className="w-full" size="lg">
              {mode === "login" ? "Entrar" : "Crear cuenta"}
            </Btn>
          </div>
          <p className="text-xs text-gray-400 text-center mt-4">Tus datos se guardan en este dispositivo</p>
        </div>
      </div>
    </div>
  );
}
// ─── IMPORT INGREDIENTS MODAL ─────────────────────────────────────────────────
function ImportIngredientsModal({ onClose, onImport }) {
  const [step, setStep]         = useState("upload");
  const [preview, setPreview]   = useState([]);
  const [error, setError]       = useState("");
  const [fileName, setFileName] = useState("");
  const fileRef = useRef();
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setError("");
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const rows = parseIngredientsCSV(ev.target.result);
        setPreview(rows);
        setStep("preview");
      } catch (err) {
        setError(err.message);
      }
    };
    reader.readAsText(file, "UTF-8");
  };
  const handleImport = () => {
    onImport(preview);
    setStep("done");
  };
  return (
    <Modal title="Importar ingredientes desde CSV / Excel" onClose={onClose} wide>
      {step === "upload" && (
        <div className="space-y-5">
          <div className="bg-sky-50 border border-sky-100 rounded-xl p-4 text-sm text-sky-800 space-y-2">
            <p className="font-semibold">📋 Cómo preparar el archivo</p>
            <p>Exportá tu planilla como <strong>CSV</strong> (desde Excel: Archivo → Guardar como → CSV UTF-8).</p>
            <p>El archivo debe tener una fila de <strong>encabezado</strong> con estas columnas (en cualquier orden):</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs mt-2 border border-sky-200 rounded-lg overflow-hidden">
                <thead className="bg-sky-100">
                  <tr>
                    {["Nombre *","Categoría","Unidad","Precio","Cantidad","Merma %"].map(h => (
                      <th key={h} className="px-3 py-1.5 text-left font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-white">
                    {["Harina 000","Secos","kg","450","1","0"].map((v, i) => (
                      <td key={i} className="px-3 py-1.5 border-t border-sky-100">{v}</td>
                    ))}
                  </tr>
                  <tr className="bg-sky-50/40">
                    {["Manteca","Lácteos","kg","2100","1","3"].map((v, i) => (
                      <td key={i} className="px-3 py-1.5 border-t border-sky-100">{v}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-sky-600 mt-1">* Columna obligatoria. Las demás tienen valores por defecto si faltan.</p>
            <p className="text-xs text-sky-600">Los ingredientes existentes (mismo nombre) se <strong>actualizan</strong>. Los nuevos se <strong>agregan</strong>.</p>
          </div>
          <button
            onClick={() => {
              const content = "sep=;\nNombre;Categoría;Unidad;Precio;Cantidad;Merma\nHarina 000;Secos;kg;450;1;0\nManteca;Lácteos;kg;2100;1;3\n";
              const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url; a.download = "plantilla_ingredientes.csv"; a.click();
              URL.revokeObjectURL(url);
            }}
            className="text-sm text-emerald-600 hover:text-emerald-700 font-medium underline underline-offset-2"
          >
            ⬇️ Descargar plantilla CSV
          </button>
          <div
            onClick={() => fileRef.current.click()}
            className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center cursor-pointer hover:border-emerald-400 hover:bg-emerald-50/30 transition-all"
          >
            <div className="text-4xl mb-2">📂</div>
            <p className="text-gray-600 font-medium">Hacé clic para seleccionar el archivo</p>
            <p className="text-xs text-gray-400 mt-1">CSV (separado por comas o punto y coma)</p>
            <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFile} />
          </div>
          {error && <p className="text-rose-500 text-sm bg-rose-50 px-3 py-2 rounded-lg">⚠️ {error}</p>}
          <div className="flex justify-end">
            <Btn variant="secondary" onClick={onClose}>Cancelar</Btn>
          </div>
        </div>
      )}
      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-lg">
            <span>📄</span><span className="font-medium">{fileName}</span>
            <span className="ml-auto text-emerald-600 font-semibold">{preview.length} ingredientes encontrados</span>
          </div>
          <div className="overflow-x-auto max-h-72 rounded-xl border border-gray-100">
            <table className="w-full text-xs min-w-[500px]">
              <thead className="sticky top-0 bg-gray-50 border-b border-gray-100">
                <tr>
                  {["Nombre","Categoría","Unidad","Precio","Cantidad","Merma %"].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i} className={`border-b border-gray-50 ${i % 2 === 0 ? "bg-white" : "bg-gray-50/40"}`}>
                    <td className="px-3 py-2 font-medium text-gray-800">{row.name}</td>
                    <td className="px-3 py-2 text-gray-500">{row.category}</td>
                    <td className="px-3 py-2 text-gray-500">{row.unit}</td>
                    <td className="px-3 py-2 text-gray-700">${row.buyPrice.toLocaleString("es-AR")}</td>
                    <td className="px-3 py-2 text-gray-500">{row.buyQty}</td>
                    <td className="px-3 py-2">{row.wastePct > 0 ? <Pill color="rose">{row.wastePct}%</Pill> : <span className="text-gray-300">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 px-3 py-2 rounded-lg">
            ⚠️ Los ingredientes con el mismo nombre serán <strong>actualizados</strong>. Los nuevos se <strong>agregarán</strong> a tu lista.
          </p>
          <div className="flex gap-3 justify-end">
            <Btn variant="secondary" onClick={() => { setStep("upload"); setPreview([]); setFileName(""); }}>
              ← Volver
            </Btn>
            <Btn onClick={handleImport}>
              ✓ Importar {preview.length} ingredientes
            </Btn>
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
// ─── INLINE NEW INGREDIENT (desde RecipesTab) ─────────────────────────────────
function QuickAddIngredientModal({ onClose, onSave }) {
  const [form, setForm] = useState({ name:"", category:"", unit:"kg", buyPrice:"", buyQty:"1", wastePct:"0" });
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  const previewCost = () => {
    const qty = +form.buyQty || 0;
    const price = +form.buyPrice || 0;
    const waste = +form.wastePct || 0;
    if (qty <= 0) return "0.0000";
    const base = price / qty;
    return waste > 0 ? (base / (1 - waste / 100)).toFixed(4) : base.toFixed(4);
  };
  const save = () => {
    if (!form.name.trim()) return;
    const ing = { ...form, id: Date.now(), buyPrice: +form.buyPrice, buyQty: +form.buyQty, wastePct: +form.wastePct };
    onSave(ing);
  };
  return (
    <Modal title="Agregar nuevo ingrediente" onClose={onClose}>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="Nombre del ingrediente">
            <TextInput value={form.name} onChange={f("name")} placeholder="Ej: Harina 000" />
          </Field>
        </div>
        <Field label="Categoría">
          <TextInput value={form.category} onChange={f("category")} placeholder="Ej: Secos" />
        </Field>
        <Field label="Unidad">
          <TextInput value={form.unit} onChange={f("unit")} placeholder="kg, lt, u" />
        </Field>
        <Field label="Precio de compra ($)">
          <TextInput value={form.buyPrice} onChange={f("buyPrice")} type="number" min="0" step="0.01" />
        </Field>
        <Field label="Cantidad que comprás">
          <TextInput value={form.buyQty} onChange={f("buyQty")} type="number" min="0.001" step="0.001" />
        </Field>
        <Field label="% Merma">
          <TextInput value={form.wastePct} onChange={f("wastePct")} type="number" min="0" max="100" step="0.1" suffix="%" />
        </Field>
        <div className="bg-emerald-50 rounded-xl p-4 flex flex-col justify-center">
          <p className="text-xs text-emerald-600 font-medium mb-1">Costo neto x unidad</p>
          <p className="text-2xl font-bold text-emerald-700">${previewCost()}</p>
        </div>
      </div>
      <div className="flex gap-3 mt-5 justify-end">
        <Btn variant="secondary" onClick={onClose}>Cancelar</Btn>
        <Btn onClick={save} disabled={!form.name.trim()}>Guardar ingrediente</Btn>
      </div>
    </Modal>
  );
}
// ─── INGREDIENTS ──────────────────────────────────────────────────────────────
function IngredientsTab({ ingredients, setIngredients, user }) {
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({});
  const filtered = ingredients.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    i.category.toLowerCase().includes(search.toLowerCase())
  );
  const openAdd  = () => { setForm({ name:"", category:"", unit:"kg", buyPrice:"", buyQty:"1", wastePct:"0" }); setModal("form"); };
  const openEdit = (ing) => { setForm({ ...ing, buyPrice: ing.buyPrice+"", buyQty: ing.buyQty+"", wastePct: ing.wastePct+"" }); setModal("form"); };
  const saveIng = () => {
    const ing = { ...form, buyPrice: +form.buyPrice, buyQty: +form.buyQty, wastePct: +form.wastePct };
    let updated;
    if (!ing.id) { ing.id = Date.now(); updated = [...ingredients, ing]; }
    else         { updated = ingredients.map(i => i.id === ing.id ? ing : i); }
    setIngredients(updated); sset(kIng(user), updated); setModal(null);
  };
  const del = id => {
    const updated = ingredients.filter(i => i.id !== id);
    setIngredients(updated); sset(kIng(user), updated);
  };
  const handleImport = (rows) => {
    const existing = [...ingredients];
    rows.forEach(row => {
      const idx = existing.findIndex(i => i.name.toLowerCase().trim() === row.name.toLowerCase().trim());
      if (idx !== -1) {
        existing[idx] = { ...existing[idx], ...row };
      } else {
        existing.push({ ...row, id: Date.now() + Math.random() });
      }
    });
    setIngredients(existing);
    sset(kIng(user), existing);
  };
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }));
  const catColors = { Secos:"amber", Lácteos:"sky", Frescos:"emerald", Aceites:"violet", Dulces:"rose", Frutas:"emerald" };
  const previewCost = () => {
    const qty = +form.buyQty || 0;
    const price = +form.buyPrice || 0;
    const waste = +form.wastePct || 0;
    if (qty <= 0) return "0.0000";
    const base = price / qty;
    return waste > 0 ? (base / (1 - waste / 100)).toFixed(4) : base.toFixed(4);
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar ingrediente o categoría..."
               className="flex-1 min-w-48 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400" />
        <div className="flex gap-2">
          <Btn variant="secondary" onClick={() => setModal("import")}>⬆️ Importar CSV</Btn>
          <Btn onClick={openAdd}>+ Agregar ingrediente</Btn>
        </div>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              {["Ingrediente","Categoría","Unidad","Precio compra","Cant.","Merma %","Costo neto/u",""].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((ing, idx) => (
              <tr key={ing.id} className={`border-b border-gray-50 hover:bg-emerald-50/30 transition-colors ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/30"}`}>
                <td className="px-4 py-3 font-medium text-gray-800">{ing.name}</td>
                <td className="px-4 py-3"><Pill color={catColors[ing.category] || "sky"}>{ing.category}</Pill></td>
                <td className="px-4 py-3 text-gray-500">{ing.unit}</td>
                <td className="px-4 py-3 text-gray-700">${ing.buyPrice.toLocaleString("es-AR")}</td>
                <td className="px-4 py-3 text-gray-500">{ing.buyQty}</td>
                <td className="px-4 py-3">{ing.wastePct > 0 ? <Pill color="rose">{ing.wastePct}%</Pill> : <span className="text-gray-300">—</span>}</td>
                <td className="px-4 py-3 font-semibold text-emerald-700">${unitCost(ing).toFixed(4)}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button onClick={() => openEdit(ing)} className="text-gray-400 hover:text-emerald-600 transition-colors">✏️</button>
                    <button onClick={() => del(ing.id)}   className="text-gray-400 hover:text-rose-500 transition-colors">🗑</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <div className="text-4xl mb-2">🔍</div>
            <p>No se encontraron ingredientes</p>
          </div>
        )}
      </div>
      {modal === "form" && (
        <Modal title={form.id ? "Editar ingrediente" : "Nuevo ingrediente"} onClose={() => setModal(null)}>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Field label="Nombre del ingrediente">
                <TextInput value={form.name || ""} onChange={f("name")} placeholder="Ej: Harina 000" />
              </Field>
            </div>
            <Field label="Categoría">
              <TextInput value={form.category || ""} onChange={f("category")} placeholder="Ej: Secos" />
            </Field>
            <Field label="Unidad">
              <TextInput value={form.unit || ""} onChange={f("unit")} placeholder="kg, lt, u" />
            </Field>
            <Field label="Precio de compra ($)">
              <TextInput value={form.buyPrice || ""} onChange={f("buyPrice")} type="number" min="0" step="0.01" />
            </Field>
            <Field label="Cantidad que comprás">
              <TextInput value={form.buyQty || ""} onChange={f("buyQty")} type="number" min="0.001" step="0.001" />
            </Field>
            <Field label="% Merma">
              <TextInput value={form.wastePct || "0"} onChange={f("wastePct")} type="number" min="0" max="100" step="0.1" suffix="%" />
            </Field>
            <div className="bg-emerald-50 rounded-xl p-4 flex flex-col justify-center">
              <p className="text-xs text-emerald-600 font-medium mb-1">Costo neto x unidad</p>
              <p className="text-2xl font-bold text-emerald-700">${previewCost()}</p>
            </div>
          </div>
          <div className="flex gap-3 mt-5 justify-end">
            <Btn variant="secondary" onClick={() => setModal(null)}>Cancelar</Btn>
            <Btn onClick={saveIng}>Guardar</Btn>
          </div>
        </Modal>
      )}
      {modal === "import" && (
        <ImportIngredientsModal onClose={() => setModal(null)} onImport={(rows) => { handleImport(rows); }} />
      )}
    </div>
  );
}
// ─── BUSINESS ─────────────────────────────────────────────────────────────────
function BusinessTab({ business, setBusiness, user }) {
  const update = (key, val) => {
    const upd = { ...business, [key]: val };
    setBusiness(upd); sset(kBiz(user), upd);
  };
  const updateCost = (id, field, val) => {
    const upd = { ...business, fixedCosts: business.fixedCosts.map(c => c.id === id ? { ...c, [field]: field === "amount" ? +val : val } : c) };
    setBusiness(upd); sset(kBiz(user), upd);
  };
  const addCost = () => {
    const upd = { ...business, fixedCosts: [...business.fixedCosts, { id: Date.now(), name: "Nuevo costo", amount: 0 }] };
    setBusiness(upd); sset(kBiz(user), upd);
  };
  const delCost = id => {
    const upd = { ...business, fixedCosts: business.fixedCosts.filter(c => c.id !== id) };
    setBusiness(upd); sset(kBiz(user), upd);
  };
  const totalFixed = business.fixedCosts.reduce((s, c) => s + (c.amount || 0), 0);
  const cfUnit     = business.monthlyUnits > 0 ? totalFixed / business.monthlyUnits : 0;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total costos fijos/mes" value={`$${totalFixed.toLocaleString("es-AR")}`} accent="rose" />
        <StatCard label="Unidades estimadas/mes"  value={business.monthlyUnits} accent="sky" />
        <StatCard label="Costo fijo x unidad"      value={`$${cfUnit.toFixed(2)}`} sub="Aplicado a cada receta" accent="emerald" />
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h3 className="font-semibold text-gray-700 mb-4">🏢 Costos fijos mensuales</h3>
        <div className="space-y-2">
          {business.fixedCosts.map(c => (
            <div key={c.id} className="flex items-center gap-3">
              <input value={c.name} onChange={e => updateCost(c.id, "name", e.target.value)}
                     className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400" />
              <div className="relative w-36">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input type="number" min="0" value={c.amount} onChange={e => updateCost(c.id, "amount", e.target.value)}
                       className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400" />
              </div>
              <button onClick={() => delCost(c.id)} className="text-gray-300 hover:text-rose-400 transition-colors text-lg">🗑</button>
            </div>
          ))}
        </div>
        <button onClick={addCost} className="mt-3 text-sm text-emerald-600 hover:text-emerald-700 font-medium">+ Agregar línea</button>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h3 className="font-semibold text-gray-700 mb-4">📈 Producción y costos variables</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Unidades producidas por mes">
            <TextInput value={business.monthlyUnits} onChange={e => update("monthlyUnits", +e.target.value)} type="number" min="1" />
          </Field>
          {[
            ["% Comisión delivery / plataformas", "deliveryPct"],
            ["% IVA / impuesto sobre ventas",     "ivaPct"],
            ["% Otros costos variables",           "otherVarPct"],
          ].map(([label, key]) => (
            <Field key={key} label={label}>
              <TextInput value={business[key]} onChange={e => update(key, +e.target.value)} type="number" min="0" max="100" step="0.1" suffix="%" />
            </Field>
          ))}
        </div>
      </div>
    </div>
  );
}
// ─── RECIPES ─────────────────────────────────────────────────────────────────
function RecipesTab({ recipes, setRecipes, ingredients, setIngredients, business, user }) {
  const [selected, setSelected]             = useState(recipes[0]?.id ?? null);
  const [modal, setModal]                   = useState(null);
  const [form, setForm]                     = useState({});
  const [quickIngTarget, setQuickIngTarget] = useState(null);

  // ─── FIX: mantener selected sincronizado con la lista de recetas ───────────
  useEffect(() => {
    if (selected === null && recipes.length > 0) {
      // No había selección pero ahora hay recetas → seleccionar la primera
      setSelected(recipes[0].id);
    } else if (selected !== null && !recipes.find(r => r.id === selected)) {
      // La receta seleccionada ya no existe → ir a la primera disponible
      setSelected(recipes[0]?.id ?? null);
    }
  }, [recipes, selected]);
  // ──────────────────────────────────────────────────────────────────────────

  const openAdd  = () => {
    setForm({ name:"", category:"", portions:"4", profitPct:"40", ingredients:[] });
    setModal("form");
  };
  const openEdit = r => {
    setForm({ ...r, portions: r.portions+"", profitPct: r.profitPct+"" });
    setModal("form");
  };
  const saveRecipe = () => {
    const r = { ...form, portions: +form.portions, profitPct: +form.profitPct };
    r.ingredients = (r.ingredients || [])
      .filter(l => l.ingredientId !== "" && l.ingredientId !== undefined && l.qty !== "" && +l.qty > 0)
      .map(l => ({ ingredientId: +l.ingredientId, qty: +l.qty }));
    let updated;
    if (!r.id) { r.id = Date.now(); updated = [...recipes, r]; }
    else       { updated = recipes.map(x => x.id === r.id ? r : x); }
    setRecipes(updated);
    sset(kRec(user), updated);
    setModal(null);
    setSelected(r.id);
  };
  const del = id => {
    const updated = recipes.filter(r => r.id !== id);
    setRecipes(updated); sset(kRec(user), updated);
    if (selected === id) setSelected(updated[0]?.id ?? null);
  };
  const addLine    = () => setForm(p => ({ ...p, ingredients: [...(p.ingredients || []), { ingredientId: "", qty: "" }] }));
  const updateLine = (idx, k, v) => setForm(p => {
    const ings = [...(p.ingredients || [])];
    ings[idx] = { ...ings[idx], [k]: v };
    return { ...p, ingredients: ings };
  });
  const removeLine = idx => setForm(p => ({ ...p, ingredients: (p.ingredients || []).filter((_, i) => i !== idx) }));
  const handleQuickIngSave = (newIng) => {
    const updatedIngs = [...ingredients, newIng];
    setIngredients(updatedIngs);
    sset(kIng(user), updatedIngs);
    if (quickIngTarget !== null) {
      setForm(p => {
        const ings = [...(p.ingredients || [])];
        ings[quickIngTarget] = { ...ings[quickIngTarget], ingredientId: String(newIng.id) };
        return { ...p, ingredients: ings };
      });
    }
    setModal("form");
    setQuickIngTarget(null);
  };
  const ingMap = Object.fromEntries(ingredients.map(i => [i.id, i]));
  const recipe = recipes.find(r => r.id === selected);
  const calc   = recipe ? calcRecipe(recipe, ingredients, business) : null;
  const liveCalc = (() => {
    if (!form.ingredients?.length || !form.portions) return null;
    const preview = {
      ...form,
      portions: +form.portions,
      profitPct: +form.profitPct,
      ingredients: (form.ingredients || [])
        .filter(l => l.ingredientId !== "" && l.qty !== "" && +l.qty > 0)
        .map(l => ({ ingredientId: +l.ingredientId, qty: +l.qty })),
    };
    if (!preview.ingredients.length) return null;
    try { return calcRecipe(preview, ingredients, business); } catch { return null; }
  })();
  return (
    <div className="flex gap-5">
      {/* Sidebar list */}
      <div className="w-56 flex-shrink-0 space-y-2">
        <Btn onClick={openAdd} className="w-full">+ Nueva receta</Btn>
        {recipes.map(r => {
          const c = calcRecipe(r, ingredients, business);
          return (
            <div key={r.id} onClick={() => setSelected(r.id)}
                 className={`bg-white rounded-xl border p-3 cursor-pointer transition-all hover:shadow-md ${selected === r.id ? "border-emerald-400 shadow-md" : "border-gray-100"}`}>
              <p className="font-semibold text-gray-800 text-sm leading-tight">{r.name}</p>
              <p className="text-xs text-gray-400 mt-0.5">{r.category} · {r.portions} u.</p>
              <div className="flex justify-between items-center mt-2">
                <span className="text-xs text-gray-400">Precio</span>
                <span className="text-sm font-bold text-emerald-600">${c.roundedPrice.toLocaleString("es-AR")}</span>
              </div>
            </div>
          );
        })}
        {recipes.length === 0 && (
          <div className="text-center py-8 text-gray-400 text-sm"><div className="text-3xl mb-2">🍽️</div>Sin recetas aún</div>
        )}
      </div>
      {/* Detail panel */}
      <div className="flex-1 min-w-0">
        {recipe && calc ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="bg-gradient-to-r from-emerald-700 to-emerald-600 px-6 py-5 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">{recipe.name}</h2>
                <p className="text-emerald-200 text-sm mt-1">{recipe.category} · {recipe.portions} porciones · {recipe.profitPct}% ganancia</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => openEdit(recipe)} className="bg-white/20 hover:bg-white/30 text-white text-sm px-3 py-1.5 rounded-lg transition-colors">✏️ Editar</button>
                <button onClick={() => del(recipe.id)}   className="bg-white/20 hover:bg-rose-500  text-white text-sm px-3 py-1.5 rounded-lg transition-colors">🗑</button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-5">
              <StatCard label="Costo x porción"   value={`$${calc.totalCost.toFixed(2)}`}                          accent="rose" />
              <StatCard label="Precio sugerido"   value={`$${calc.suggestedPrice.toFixed(2)}`}                     accent="amber" />
              <StatCard label="Precio redondeado" value={`$${calc.roundedPrice.toLocaleString("es-AR")}`} sub="cada $50" accent="emerald" />
              <StatCard label="Ganancia real"      value={`${calc.realProfitPct.toFixed(1)}%`} sub={`$${calc.realProfit.toFixed(2)}/p`} accent="sky" />
            </div>
            <div className="px-5 pb-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Ingredientes</h3>
              <div className="overflow-x-auto">
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
              </div>
            </div>
            <div className="mx-5 mb-5 rounded-xl overflow-hidden text-sm border border-gray-100">
              {[
                ["Costo MP total",                                `$${calc.mpTotal.toFixed(2)}`,       "bg-white"],
                ["Costo MP x porción",                            `$${calc.mpPerPortion.toFixed(2)}`,  "bg-white"],
                ["Costo fijo x porción",                          `$${calc.cfPerUnit.toFixed(2)}`,     "bg-gray-50"],
                [`Costos variables (${(calc.varPct*100).toFixed(1)}%)`, `$${calc.varCost.toFixed(2)}`, "bg-gray-50"],
              ].map(([l, v, bg]) => (
                <div key={l} className={`flex justify-between px-4 py-2 border-b border-gray-100 ${bg}`}>
                  <span className="text-gray-600">{l}</span><span className="font-medium">{v}</span>
                </div>
              ))}
              <div className="flex justify-between px-4 py-3 bg-rose-50">
                <span className="font-bold text-rose-700">COSTO TOTAL x porción</span>
                <span className="font-bold text-rose-700">${calc.totalCost.toFixed(2)}</span>
              </div>
              <div className="flex justify-between px-4 py-3.5 bg-emerald-600">
                <span className="font-bold text-white text-base">PRECIO DE VENTA</span>
                <span className="font-bold text-white text-xl">${calc.roundedPrice.toLocaleString("es-AR")}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-64 text-gray-400">
            <div className="text-center"><div className="text-5xl mb-3">👈</div><p>Seleccioná una receta</p></div>
          </div>
        )}
      </div>
      {/* ── Modal form receta ── */}
      {modal === "form" && (
        <Modal title={form.id ? "Editar receta" : "Nueva receta"} onClose={() => setModal(null)} wide>
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Field label="Nombre de la receta">
                  <TextInput value={form.name || ""} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Ej: Medialunas de manteca" />
                </Field>
              </div>
              <Field label="Categoría">
                <TextInput value={form.category || ""} onChange={e => setForm(p => ({ ...p, category: e.target.value }))} placeholder="Panadería" />
              </Field>
              <Field label="Porciones / unidades">
                <TextInput value={form.portions || ""} onChange={e => setForm(p => ({ ...p, portions: e.target.value }))} type="number" min="1" />
              </Field>
              <div className="col-span-2">
                <Field label="% Ganancia neta deseada">
                  <TextInput value={form.profitPct || ""} onChange={e => setForm(p => ({ ...p, profitPct: e.target.value }))} type="number" min="0" max="99" step="1" suffix="%" />
                </Field>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-gray-700">Ingredientes</h4>
                <button onClick={addLine} className="text-sm text-emerald-600 hover:text-emerald-700 font-medium">+ Agregar línea</button>
              </div>
              <div className="space-y-2">
                {(form.ingredients || []).map((line, idx) => {
                  const ingId = line.ingredientId !== "" ? +line.ingredientId : null;
                  const ing   = ingId ? ingMap[ingId] : null;
                  const sub   = ing && line.qty ? (unitCost(ing) * +line.qty).toFixed(2) : null;
                  return (
                    <div key={idx} className="flex gap-2 items-center">
                      <select
                        value={line.ingredientId || ""}
                        onChange={e => {
                          if (e.target.value === "__new__") {
                            setQuickIngTarget(idx);
                            setModal("quickIng");
                          } else {
                            updateLine(idx, "ingredientId", e.target.value);
                          }
                        }}
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
                      >
                        <option value="">-- Elegir ingrediente --</option>
                        <option value="__new__" className="text-emerald-700 font-semibold">✚ Crear nuevo ingrediente…</option>
                        <option disabled>──────────────</option>
                        {ingredients.map(i => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                      </select>
                      <input
                        type="number" min="0" step="0.001" value={line.qty || ""}
                        onChange={e => updateLine(idx, "qty", e.target.value)}
                        placeholder="Cant."
                        className="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
                      />
                      {sub && <span className="text-xs font-semibold text-emerald-600 w-16 text-right">${sub}</span>}
                      <button onClick={() => removeLine(idx)} className="text-gray-300 hover:text-rose-400 text-lg transition-colors">×</button>
                    </div>
                  );
                })}
                {!(form.ingredients?.length) && (
                  <p className="text-sm text-gray-400 text-center py-4 border border-dashed border-gray-200 rounded-xl">
                    Hacé clic en "+ Agregar línea" para sumar ingredientes
                  </p>
                )}
              </div>
            </div>
            {liveCalc && (
              <div className="bg-emerald-50 rounded-xl p-4 border border-emerald-100">
                <p className="text-xs text-emerald-600 font-semibold uppercase tracking-wide mb-3">Vista previa en tiempo real</p>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div><p className="text-gray-500">Costo total/p</p><p className="font-bold text-gray-800">${liveCalc.totalCost.toFixed(2)}</p></div>
                  <div><p className="text-gray-500">Precio sugerido</p><p className="font-bold text-emerald-700 text-lg">${liveCalc.roundedPrice.toLocaleString("es-AR")}</p></div>
                  <div><p className="text-gray-500">Ganancia real</p><p className="font-bold text-sky-600">{liveCalc.realProfitPct.toFixed(1)}%</p></div>
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-3 mt-5 justify-end">
            <Btn variant="secondary" onClick={() => setModal(null)}>Cancelar</Btn>
            <Btn onClick={saveRecipe}>Guardar receta</Btn>
          </div>
        </Modal>
      )}
      {/* ── Modal quick-add ingrediente (desde recetas) ── */}
      {modal === "quickIng" && (
        <QuickAddIngredientModal
          onClose={() => { setModal("form"); setQuickIngTarget(null); }}
          onSave={handleQuickIngSave}
        />
      )}
    </div>
  );
}
// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ recipes, ingredients, business }) {
  const totalFixed = business.fixedCosts.reduce((s, c) => s + (c.amount || 0), 0);
  const cfUnit     = business.monthlyUnits > 0 ? totalFixed / business.monthlyUnits : 0;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Ingredientes"    value={ingredients.length} accent="sky" />
        <StatCard label="Recetas activas" value={recipes.length}     accent="emerald" />
        <StatCard label="Costos fijos/mes" value={`$${totalFixed.toLocaleString("es-AR")}`} accent="rose" />
        <StatCard label="CF x unidad"     value={`$${cfUnit.toFixed(2)}`} accent="amber" />
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-700">Resumen de recetas</h3>
          <Pill color="emerald">{recipes.length} recetas</Pill>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                {["Receta","Porciones","Costo/porción","Precio redondeado","Ganancia %"].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recipes.map((r, idx) => {
                const c = calcRecipe(r, ingredients, business);
                return (
                  <tr key={r.id} className={`border-b border-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/30"}`}>
                    <td className="px-4 py-3 font-medium text-gray-800">{r.name}</td>
                    <td className="px-4 py-3 text-gray-500">{r.portions}</td>
                    <td className="px-4 py-3 text-rose-600 font-medium">${c.totalCost.toFixed(2)}</td>
                    <td className="px-4 py-3 font-bold text-emerald-600 text-base">${c.roundedPrice.toLocaleString("es-AR")}</td>
                    <td className="px-4 py-3">
                      <Pill color={c.realProfitPct >= 35 ? "emerald" : c.realProfitPct >= 20 ? "amber" : "rose"}>
                        {c.realProfitPct.toFixed(1)}%
                      </Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {recipes.length === 0 && (
            <div className="text-center py-10 text-gray-400">Creá tu primera receta en la pestaña Recetas</div>
          )}
        </div>
      </div>
    </div>
  );
}
// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser]               = useState(null);
  const [loading, setLoading]         = useState(true);
  const [tab, setTab]                 = useState("dashboard");
  const [ingredients, setIngredients] = useState([]);
  const [recipes, setRecipes]         = useState([]);
  const [business, setBusiness]       = useState(DEFAULT_BUSINESS);
  useEffect(() => {
    const session = sget(KEY_SESSION);
    if (session?.username) {
      loadData(session.username);
      setUser(session.username);
    }
    setLoading(false);
  }, []);
  const loadData = (username) => {
    setIngredients(sget(kIng(username)) || DEFAULT_INGREDIENTS);
    setRecipes    (sget(kRec(username)) || DEFAULT_RECIPES);
    setBusiness   (sget(kBiz(username)) || DEFAULT_BUSINESS);
  };
  const handleLogin = (username) => { loadData(username); setUser(username); };
  const logout = () => {
    sset(KEY_SESSION, null);
    setUser(null); setIngredients([]); setRecipes([]); setBusiness(DEFAULT_BUSINESS); setTab("dashboard");
  };
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-emerald-50">
      <div className="text-emerald-600 text-xl font-medium">🍽️ Cargando...</div>
    </div>
  );
  if (!user) return <LoginScreen onLogin={handleLogin} />;
  const TABS = [
    { id:"dashboard",   label:"📊 Resumen"     },
    { id:"recipes",     label:"🍽️ Recetas"     },
    { id:"ingredients", label:"📦 Ingredientes" },
    { id:"business",    label:"⚙️ Costos"       },
  ];
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🍽️</span>
            <span className="font-bold text-gray-800 text-lg">RecetApp</span>
          </div>
          <nav className="hidden md:flex gap-1">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                      className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${tab === t.id ? "bg-emerald-50 text-emerald-700" : "text-gray-500 hover:bg-gray-50"}`}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <button onClick={() => exportCSV(recipes, ingredients, business)}
                    className="hidden sm:flex items-center gap-1.5 text-sm text-gray-600 hover:text-emerald-600 border border-gray-200 rounded-lg px-3 py-1.5 transition-colors">
              ⬇️ Exportar CSV
            </button>
            <div className="w-7 h-7 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs font-bold">
              {user[0].toUpperCase()}
            </div>
            <button onClick={logout} className="text-sm text-gray-400 hover:text-gray-700 transition-colors">Salir</button>
          </div>
        </div>
        <div className="md:hidden flex overflow-x-auto border-t border-gray-100 px-2 py-1 gap-1">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
                    className={`flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg ${tab === t.id ? "bg-emerald-50 text-emerald-700" : "text-gray-500"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-5">
        {tab === "dashboard"   && <Dashboard      recipes={recipes} ingredients={ingredients} business={business} />}
        {tab === "recipes"     && <RecipesTab     recipes={recipes} setRecipes={setRecipes} ingredients={ingredients} setIngredients={setIngredients} business={business} user={user} />}
        {tab === "ingredients" && <IngredientsTab ingredients={ingredients} setIngredients={setIngredients} user={user} />}
        {tab === "business"    && <BusinessTab    business={business} setBusiness={setBusiness} user={user} />}
      </main>
    </div>
  );
}
