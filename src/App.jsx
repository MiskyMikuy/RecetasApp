/* eslint-disable no-restricted-globals */
import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_KEY  = process.env.REACT_APP_SUPABASE_ANON_KEY;
const supabase      = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── CALCULATIONS ─────────────────────────────────────────────────────────────
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
  const roundedPrice   = Math.ceil(suggestedPrice / 50) * 50;
  const realProfit     = roundedPrice - totalCost;
  const realProfitPct  = roundedPrice > 0 ? (realProfit / roundedPrice) * 100 : 0;
  return { lines, mpTotal, mpPerPortion, cfPerUnit, varCost, varPct,
           totalCost, suggestedPrice, roundedPrice, realProfit, realProfitPct };
}

// ─── GUÍA DE UNIDADES ─────────────────────────────────────────────────────────
const UNIT_GUIDE = [
  { unit:"kg",  recipe:"Decimales: 0.250 = 250 g  ·  0.500 = 500 g  ·  1.000 = 1 kg" },
  { unit:"lt",  recipe:"Decimales: 0.100 = 100 ml  ·  0.250 = 250 ml  ·  1.000 = 1 lt" },
  { unit:"ml",  recipe:"Directo: 5 = 5 ml  ·  100 = 100 ml  ·  500 = 500 ml" },
  { unit:"u",   recipe:"Enteros o medios: 1 = 1 unidad  ·  0.5 = media  ·  12 = docena" },
  { unit:"g",   recipe:"Directo: 50 = 50 g  ·  250 = 250 g  ·  500 = 500 g" },
];

// ─── PARSE CSV INGREDIENTES ───────────────────────────────────────────────────
function parseIngredientsCSV(text) {
  const firstLine = text.split(/\r?\n/)[0];
  const sep = firstLine.includes(";") ? ";" : ",";
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim() && !l.startsWith("sep="));
  if (lines.length < 2) throw new Error("El archivo debe tener encabezado y al menos una fila.");
  const headers = lines[0].split(sep).map(h =>
    h.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"")
  );
  const colMap = {
    name:      ["nombre","ingrediente","name"],
    category:  ["categoria","category","rubro","tipo"],
    unit:      ["unidad","unit","medida"],
    buy_price: ["precio","price","costo","preciocompra"],
    buy_qty:   ["cantidad","qty","cantidadcompra","bulto"],
    waste_pct: ["merma","waste","mermapct"],
  };
  const idx = {};
  for (const [key, aliases] of Object.entries(colMap)) {
    for (const alias of aliases) {
      const i = headers.indexOf(alias);
      if (i !== -1) { idx[key] = i; break; }
    }
  }
  if (idx.name === undefined) throw new Error("No se encontró la columna Nombre.");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
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
function Pill({ children, color = "emerald" }) {
  const map = {
    emerald: "bg-emerald-100 text-emerald-700",
    amber:   "bg-amber-100 text-amber-700",
    rose:    "bg-rose-100 text-rose-700",
    sky:     "bg-sky-100 text-sky-700",
    violet:  "bg-violet-100 text-violet-700",
    gray:    "bg-gray-100 text-gray-600",
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
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 bg-white disabled:bg-gray-50 disabled:text-gray-400"
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
    <button onClick={onClick} disabled={disabled}
      className={`font-medium rounded-lg transition-colors ${v[variant]} ${s[size]} ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}>
      {children}
    </button>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [form, setForm]   = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handle = async () => {
    setError(""); setLoading(true);
    const { data, error: err } = await supabase.auth.signInWithPassword({
      email: form.email, password: form.password
    });
    setLoading(false);
    if (err) return setError("Email o contraseña incorrectos.");
    onLogin(data.user);
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
function AdminPanel({ profile }) {
  const [users, setUsers]     = useState([]);
  const [logs, setLogs]       = useState([]);
  const [modal, setModal]     = useState(null); // null | "newUser" | "editUser"
  const [selected, setSelected] = useState(null);
  const [form, setForm]       = useState({ email: "", username: "", password: "", role: "viewer", phone: "", permissions: { dashboard: true, recipes: true, ingredients: true, business: true } });
  const [msg, setMsg]         = useState("");
  const [tab, setTab]         = useState("users"); // users | logs

  useEffect(() => { loadUsers(); loadLogs(); }, []);

  const loadUsers = async () => {
    const { data } = await supabase.from("profiles").select("*").order("created_at");
    setUsers(data || []);
  };
  const loadLogs = async () => {
    const { data } = await supabase.from("activity_log").select("*").order("created_at", { ascending: false }).limit(100);
    setLogs(data || []);
  };

  const createUser = async () => {
    setMsg("");
    // Crear usuario en Supabase Auth via Admin API — usamos la función de invitación
    const { data, error } = await supabase.auth.admin.createUser({
      email: form.email,
      password: form.password,
      email_confirm: true,
    });
    if (error) return setMsg("Error: " + error.message);
    // Crear perfil
    await supabase.from("profiles").insert({
      id: data.user.id,
      username: form.username,
      role: form.role,
      phone: form.phone || null,
      permissions: form.role === "viewer_partial" ? form.permissions : { dashboard:true, recipes:true, ingredients:true, business:true },
    });
    await logActivity(profile, "create", "usuario", form.username);
    setMsg("✅ Usuario creado correctamente.");
    loadUsers();
    setTimeout(() => { setModal(null); setMsg(""); }, 1500);
  };

  const updateUser = async () => {
    setMsg("");
    const updates = { role: form.role, username: form.username, phone: form.phone || null, permissions: form.role === "viewer_partial" ? form.permissions : { dashboard:true, recipes:true, ingredients:true, business:true } };
    await supabase.from("profiles").update(updates).eq("id", selected.id);
    if (form.password) {
      await supabase.auth.admin.updateUserById(selected.id, { password: form.password });
    }
    await logActivity(profile, "update", "usuario", form.username);
    setMsg("✅ Usuario actualizado.");
    loadUsers();
    setTimeout(() => { setModal(null); setMsg(""); }, 1500);
  };

  const deleteUser = async (u) => {
    
    await supabase.auth.admin.deleteUser(u.id);
    await supabase.from("profiles").delete().eq("id", u.id);
    await logActivity(profile, "delete", "usuario", u.username);
    loadUsers();
  };

  const openEdit = (u) => {
    setSelected(u);
    setForm({ email: "", username: u.username, password: "", role: u.role, phone: u.phone || "", permissions: u.permissions || { dashboard:true, recipes:true, ingredients:true, business:true } });
    setModal("editUser");
  };

  const roleColor = { admin: "rose", editor: "emerald", viewer: "sky", viewer_partial: "violet" };
  const roleLabel = { admin: "Admin", editor: "Editor", viewer: "Solo lectura", viewer_partial: "Vista parcial" };

  return (
    <div className="space-y-5">
      <div className="flex gap-2 border-b border-gray-200 pb-1">
        {[["users","👥 Usuarios"],["logs","📋 Actividad"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${tab === id ? "bg-white border border-b-white border-gray-200 text-emerald-700 -mb-px" : "text-gray-500 hover:text-gray-700"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "users" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-gray-700">Usuarios registrados</h3>
            <Btn onClick={() => { setForm({ email:"", username:"", password:"", role:"viewer", phone:"", permissions:{ dashboard:true, recipes:true, ingredients:true, business:true } }); setMsg(""); setModal("newUser"); }}>
              + Nuevo usuario
            </Btn>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  {["Usuario","Rol","Teléfono","Creado",""].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u, idx) => (
                  <tr key={u.id} className={`border-b border-gray-50 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/30"}`}>
                    <td className="px-4 py-3 font-medium text-gray-800">{u.username}</td>
                    <td className="px-4 py-3"><Pill color={roleColor[u.role]}>{roleLabel[u.role]}</Pill></td>
                    <td className="px-4 py-3 text-gray-500">{u.phone || "—"}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{new Date(u.created_at).toLocaleDateString("es-AR")}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => openEdit(u)} className="text-gray-400 hover:text-emerald-600 transition-colors">✏️</button>
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
                    <Pill color={l.action==="delete"?"rose":l.action==="create"?"emerald":"sky"}>
                      {l.action}
                    </Pill>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{l.entity}</td>
                  <td className="px-4 py-2 text-gray-500">{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && <div className="text-center py-10 text-gray-400">Sin actividad registrada</div>}
        </div>
      )}

      {/* Modal nuevo/editar usuario */}
      {(modal === "newUser" || modal === "editUser") && (
        <Modal title={modal === "newUser" ? "Nuevo usuario" : `Editar: ${selected?.username}`} onClose={() => setModal(null)}>
          <div className="space-y-4">
            {modal === "newUser" && (
              <Field label="Email">
                <TextInput value={form.email} onChange={e => setForm(p=>({...p, email: e.target.value}))} type="email" placeholder="usuario@email.com" />
              </Field>
            )}
            <Field label="Nombre de usuario">
              <TextInput value={form.username} onChange={e => setForm(p=>({...p, username: e.target.value}))} placeholder="ej: maria" />
            </Field>
            <Field label={modal === "editUser" ? "Nueva contraseña (dejá vacío para no cambiar)" : "Contraseña"}>
              <TextInput value={form.password} onChange={e => setForm(p=>({...p, password: e.target.value}))} type="password" placeholder="••••••••" />
            </Field>
            <Field label="Teléfono (opcional, para SMS)">
              <TextInput value={form.phone} onChange={e => setForm(p=>({...p, phone: e.target.value}))} placeholder="+5493511234567" />
            </Field>
            <Field label="Rol">
              <select value={form.role} onChange={e => setForm(p=>({...p, role: e.target.value}))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400">
                <option value="viewer">Solo lectura — ve todas las secciones</option>
                <option value="viewer_partial">Vista parcial — el admin elige qué secciones ve</option>
                <option value="editor">Editor — puede agregar y editar todo</option>
                <option value="admin">Admin — acceso total + gestión de usuarios</option>
              </select>
            </Field>
            {form.role === "viewer_partial" && (
              <div className="bg-violet-50 border border-violet-100 rounded-xl p-4 space-y-2">
                <p className="text-xs font-semibold text-violet-700 mb-3">Secciones visibles para este usuario:</p>
                {[
                  ["dashboard",    "📊 Resumen"],
                  ["recipes",      "🍽️ Recetas"],
                  ["ingredients",  "📦 Ingredientes"],
                  ["business",     "⚙️ Costos"],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.permissions?.[key] ?? true}
                      onChange={e => setForm(p => ({
                        ...p,
                        permissions: { ...(p.permissions || {}), [key]: e.target.checked }
                      }))}
                      className="w-4 h-4 rounded accent-violet-600"
                    />
                    <span className="text-sm text-gray-700">{label}</span>
                  </label>
                ))}
              </div>
            )}
            {msg && <p className={`text-sm px-3 py-2 rounded-lg ${msg.startsWith("✅") ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-600"}`}>{msg}</p>}
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
          }} className="text-sm text-emerald-600 hover:text-emerald-700 font-medium underline">
            ⬇️ Descargar plantilla CSV
          </button>
          <div onClick={() => fileRef.current.click()}
            className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center cursor-pointer hover:border-emerald-400 hover:bg-emerald-50/30 transition-all">
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
            <span className="ml-auto text-emerald-600 font-semibold">{preview.length} ingredientes</span>
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
        <div className="bg-emerald-50 rounded-xl p-4 flex flex-col justify-center">
          <p className="text-xs text-emerald-600 font-medium mb-1">Costo neto x unidad</p>
          <p className="text-2xl font-bold text-emerald-700">${previewCost()}</p>
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

function IngredientsTab({ ingredients, setIngredients, profile }) {
  const canEdit    = profile?.role !== "viewer" && profile?.role !== "viewer_partial";
  const [modal, setModal]   = useState(null);
  const [search, setSearch] = useState("");
  const [form, setForm]     = useState({});
  const [saving, setSaving] = useState(false);

  const filtered = ingredients.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    (i.category || "").toLowerCase().includes(search.toLowerCase())
  );

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
  const catColors = { Secos:"amber", Lácteos:"sky", Frescos:"emerald", Aceites:"violet", Dulces:"rose", Frutas:"emerald" };
  const previewCost = () => {
    const qty = +form.buy_qty || 0; const price = +form.buy_price || 0; const waste = +form.waste_pct || 0;
    if (qty <= 0) return "0.0000";
    const base = price / qty;
    return waste > 0 ? (base / (1 - waste / 100)).toFixed(4) : base.toFixed(4);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar ingrediente o categoría..."
               className="flex-1 min-w-48 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400" />
        {canEdit && <div className="flex gap-2">
            <Btn variant="secondary" onClick={() => setModal("import")}>⬆️ Importar CSV</Btn>
            <Btn onClick={openAdd}>+ Agregar ingrediente</Btn>
          </div>}
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              {["Ingrediente","Categoría","Unidad","Precio compra","Cant.","Merma %","Costo neto/u", canEdit ? "" : null].filter(Boolean).map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((ing, idx) => (
              <tr key={ing.id} className={`border-b border-gray-50 hover:bg-emerald-50/30 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/30"}`}>
                <td className="px-4 py-3 font-medium text-gray-800">{ing.name}</td>
                <td className="px-4 py-3"><Pill color={catColors[ing.category] || "sky"}>{ing.category}</Pill></td>
                <td className="px-4 py-3 text-gray-500">{ing.unit}</td>
                <td className="px-4 py-3 text-gray-700">${ing.buy_price?.toLocaleString("es-AR")}</td>
                <td className="px-4 py-3 text-gray-500">{ing.buy_qty}</td>
                <td className="px-4 py-3">{ing.waste_pct > 0 ? <Pill color="rose">{ing.waste_pct}%</Pill> : <span className="text-gray-300">—</span>}</td>
                <td className="px-4 py-3 font-semibold text-emerald-700">${unitCost(ing).toFixed(4)}</td>
                {canEdit && (
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => openEdit(ing)} className="text-gray-400 hover:text-emerald-600">✏️</button>
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
            <div className="bg-emerald-50 rounded-xl p-4 flex flex-col justify-center">
              <p className="text-xs text-emerald-600 font-medium mb-1">Costo neto x unidad</p>
              <p className="text-2xl font-bold text-emerald-700">${previewCost()}</p>
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
  const canEdit = profile?.role !== "viewer" && profile?.role !== "viewer_partial";

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
        <StatCard label="Costo fijo x unidad" value={`$${cfUnit.toFixed(2)}`} sub="Aplicado a cada receta" accent="emerald" />
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h3 className="font-semibold text-gray-700 mb-4">🏢 Costos fijos mensuales</h3>
        <div className="space-y-2">
          {(business.fixed_costs || []).map(c => (
            <div key={c.id} className="flex items-center gap-3">
              <input value={c.name} disabled={!canEdit} onChange={e => updateCost(c.id, "name", e.target.value)}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:bg-gray-50" />
              <div className="relative w-36">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input type="number" min="0" value={c.amount} disabled={!canEdit} onChange={e => updateCost(c.id, "amount", e.target.value)}
                  className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:bg-gray-50" />
              </div>
              {canEdit && <button onClick={() => delCost(c.id)} className="text-gray-300 hover:text-rose-400 text-lg">🗑</button>}
            </div>
          ))}
        </div>
        {canEdit && <button onClick={addCost} className="mt-3 text-sm text-emerald-600 hover:text-emerald-700 font-medium">+ Agregar línea</button>}
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
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
      </div>
      {!canEdit && (
        <p className="text-sm text-gray-400 bg-gray-50 px-4 py-2 rounded-lg">👁 Estás en modo solo lectura. No podés modificar la configuración.</p>
      )}
    </div>
  );
}

// ─── RECIPES ──────────────────────────────────────────────────────────────────
function RecipesTab({ recipes, setRecipes, ingredients, setIngredients, business, profile }) {
  const canEdit = profile?.role !== "viewer" && profile?.role !== "viewer_partial";
  const [selected, setSelected] = useState(null);
  const [modal, setModal]       = useState(null);
  const [form, setForm]         = useState({});
  const [saving, setSaving]       = useState(false);
  const [quickIngTarget, setQuickIngTarget] = useState(null);
  const [showUnitGuide, setShowUnitGuide]   = useState(false);

  useEffect(() => {
    if (selected === null && recipes.length > 0) setSelected(recipes[0].id);
    else if (selected !== null && !recipes.find(r => r.id === selected)) setSelected(recipes[0]?.id ?? null);
  }, [recipes, selected]);

  const openAdd = () => {
    setForm({ name:"", category:"", portions:"4", profit_pct:"40", recipe_ingredients:[] });
    setModal("form");
  };
  const openEdit = r => {
    setForm({ ...r, portions: r.portions+"", profit_pct: r.profit_pct+"" });
    setModal("form");
  };

  const saveRecipe = async () => {
    setSaving(true);
    const r = { ...form, portions: +form.portions, profit_pct: +form.profit_pct };
    const lines = (r.recipe_ingredients || [])
      .filter(l => l.ingredient_id !== "" && l.ingredient_id !== undefined && l.qty !== "" && +l.qty > 0)
      .map(l => ({ ingredient_id: +l.ingredient_id, qty: +l.qty }));

    let recipeId = r.id;
    if (!r.id) {
      const { data } = await supabase.from("recipes")
        .insert({ name: r.name, category: r.category, portions: r.portions, profit_pct: r.profit_pct })
        .select().single();
      recipeId = data.id;
      await logActivity(profile, "create", "receta", r.name);
    } else {
      await supabase.from("recipes")
        .update({ name: r.name, category: r.category, portions: r.portions, profit_pct: r.profit_pct })
        .eq("id", r.id);
      await logActivity(profile, "update", "receta", r.name);
    }

    // Reemplazar ingredientes de la receta
    await supabase.from("recipe_ingredients").delete().eq("recipe_id", recipeId);
    if (lines.length > 0) {
      await supabase.from("recipe_ingredients").insert(lines.map(l => ({ ...l, recipe_id: recipeId })));
    }

    // Recargar recetas
    const { data: allRecipes } = await supabase.from("recipes").select("*, recipe_ingredients(*)").order("name");
    setRecipes(allRecipes || []);
    setSaving(false);
    setModal(null);
    setSelected(recipeId);
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
      <div className="w-56 flex-shrink-0 space-y-2">
        {canEdit && <Btn onClick={openAdd} className="w-full">+ Nueva receta</Btn>}
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

      {/* Detail */}
      <div className="flex-1 min-w-0">
        {recipe && calc ? (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="bg-gradient-to-r from-emerald-700 to-emerald-600 px-6 py-5 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">{recipe.name}</h2>
                <p className="text-emerald-200 text-sm mt-1">{recipe.category} · {recipe.portions} porciones · {recipe.profit_pct}% ganancia</p>
              </div>
              {canEdit && (
                <div className="flex gap-2">
                  <button onClick={() => openEdit(recipe)} className="bg-white/20 hover:bg-white/30 text-white text-sm px-3 py-1.5 rounded-lg">✏️ Editar</button>
                  <button onClick={() => del(recipe.id, recipe.name)} className="bg-white/20 hover:bg-rose-500 text-white text-sm px-3 py-1.5 rounded-lg">🗑</button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-5">
              <StatCard label="Costo x porción"   value={`$${calc.totalCost.toFixed(2)}`} accent="rose" />
              <StatCard label="Precio sugerido"   value={`$${calc.suggestedPrice.toFixed(2)}`} accent="amber" />
              <StatCard label="Precio redondeado" value={`$${calc.roundedPrice.toLocaleString("es-AR")}`} sub="cada $50" accent="emerald" />
              <StatCard label="Ganancia real"      value={`${calc.realProfitPct.toFixed(1)}%`} sub={`$${calc.realProfit.toFixed(2)}/p`} accent="sky" />
            </div>
            <div className="px-5 pb-3">
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
            </div>
            <div className="mx-5 mb-5 rounded-xl overflow-hidden text-sm border border-gray-100">
              {[
                ["Costo MP total", `$${calc.mpTotal.toFixed(2)}`, "bg-white"],
                ["Costo MP x porción", `$${calc.mpPerPortion.toFixed(2)}`, "bg-white"],
                ["Costo fijo x porción", `$${calc.cfPerUnit.toFixed(2)}`, "bg-gray-50"],
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
                  <button onClick={addLine} className="text-sm text-emerald-600 hover:text-emerald-700 font-medium">+ Agregar línea</button>
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
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400">
                        <option value="">-- Elegir ingrediente --</option>
                        <option value="__new__" className="text-emerald-700 font-semibold">✚ Crear nuevo ingrediente...</option>
                        <option disabled>──────────────</option>
                        {ingredients.map(i => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                      </select>
                      <input type="number" min="0" step="0.001" value={line.qty || ""}
                        onChange={e => updateLine(idx, "qty", e.target.value)}
                        placeholder="Cant."
                        className="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400" />
                      {sub && <span className="text-xs font-semibold text-emerald-600 w-16 text-right">${sub}</span>}
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
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ recipes, ingredients, business }) {
  const totalFixed = (business.fixed_costs || []).reduce((s, c) => s + (c.amount || 0), 0);
  const cfUnit     = business.monthly_units > 0 ? totalFixed / business.monthly_units : 0;
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
          {recipes.length === 0 && <div className="text-center py-10 text-gray-400">Creá tu primera receta en la pestaña Recetas</div>}
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser]           = useState(null);
  const [profile, setProfile]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [tab, setTab]             = useState("dashboard");
  const [ingredients, setIngredients] = useState([]);
  const [recipes, setRecipes]         = useState([]);
  const [business, setBusiness]       = useState({ fixed_costs:[], monthly_units:500, delivery_pct:5, iva_pct:21, other_var_pct:2 });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) { setUser(session.user); loadProfile(session.user.id); }
      else setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
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
    setIngredients(ings || []);
    setRecipes(recs || []);
    if (biz) setBusiness(biz);
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null); setProfile(null); setTab("dashboard");
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-emerald-50">
      <div className="text-emerald-600 text-xl font-medium">🍽️ Cargando...</div>
    </div>
  );
  if (!user) return <LoginScreen onLogin={(u) => { setUser(u); loadProfile(u.id); }} />;

  const roleColor = { admin: "rose", editor: "emerald", viewer: "sky", viewer_partial: "violet" };
  const roleLabel = { admin: "Admin", editor: "Editor", viewer: "Solo lectura", viewer_partial: "Vista parcial" };

  const perms = profile?.permissions || { dashboard:true, recipes:true, ingredients:true, business:true };
  const canSeeTab = (id) => {
    if (profile?.role === "viewer_partial") return perms[id] === true;
    return true;
  };
  const TABS = [
    { id:"dashboard",   label:"📊 Resumen",      show: canSeeTab("dashboard") },
    { id:"recipes",     label:"🍽️ Recetas",      show: canSeeTab("recipes") },
    { id:"ingredients", label:"📦 Ingredientes",  show: canSeeTab("ingredients") },
    { id:"business",    label:"⚙️ Costos",        show: canSeeTab("business") },
    { id:"admin",       label:"👥 Usuarios",      show: profile?.role === "admin" },
  ].filter(t => t.show);

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
            <button onClick={() => {
                if (tab === "ingredients") exportIngredientsCSV(ingredients);
                else if (tab === "business") exportBusinessCSV(business);
                else exportCSV(recipes, ingredients, business);
              }}
              className="hidden sm:flex items-center gap-1.5 text-sm text-gray-600 hover:text-emerald-600 border border-gray-200 rounded-lg px-3 py-1.5 transition-colors">
              ⬇️ CSV
            </button>
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-emerald-600 flex items-center justify-center text-white text-xs font-bold">
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
              className={`flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg ${tab === t.id ? "bg-emerald-50 text-emerald-700" : "text-gray-500"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-5">
        {tab === "dashboard"   && <Dashboard ingredients={ingredients} recipes={recipes} business={business} />}
        {tab === "recipes"     && <RecipesTab recipes={recipes} setRecipes={setRecipes} ingredients={ingredients} setIngredients={setIngredients} business={business} profile={profile} />}
        {tab === "ingredients" && <IngredientsTab ingredients={ingredients} setIngredients={setIngredients} profile={profile} />}
        {tab === "business"    && <BusinessTab business={business} setBusiness={setBusiness} profile={profile} />}
        {tab === "admin"       && profile?.role === "admin" && <AdminPanel profile={profile} />}
      </main>
    </div>
  );
}
