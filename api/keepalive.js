// "Despertador" automático de Supabase.
// Vercel llama a esta función una vez por día (ver vercel.json en la raíz
// del repo) y ella hace una consulta mínima al proyecto de Supabase. Esa
// consulta cuenta como uso real del proyecto, así que evita que Supabase
// lo pause por pasar 7 días seguidos sin actividad — sin que nadie tenga
// que acordarse de entrar a la app.
//
// Completá SUPABASE_ANON_KEY con la misma clave "anon public" que ya
// usaste en public/carta.html (Supabase → Project Settings → API).

const SUPABASE_URL = "https://fwhusxzbgdmxiotumpky.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3aHVzeHpiZ2RteGlvdHVtcGt5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMDYxMzIsImV4cCI6MjA5NzU4MjEzMn0.y2iarbrk5IeNZ91tA4tlPSeKlUBTqeRORzFenXwHORw";

export default async function handler(req, res) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_ANON_KEY },
    });
    res.status(200).json({ ok: true, supabaseStatus: r.status, checkedAt: new Date().toISOString() });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err) });
  }
}
