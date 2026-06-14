# 🍽️ RecetApp — Costeo Inteligente de Recetas

App web para costear recetas de cocina/panadería/pastelería con login por usuario, datos en la nube y cálculo automático de precios.

## Funciones

- 🔐 Login / Registro de usuarios (datos persistentes por usuario)
- 📦 Base de datos de ingredientes con precios y % de merma
- 🍽️ Recetas con costeo automático por porción
- ⚙️ Costos fijos y variables del negocio
- 📊 Panel resumen comparativo
- ⬇️ Exportar a CSV (abre en Excel)

## Cómo corre localmente

```bash
npm install
npm start
```

## Deploy en Vercel

1. Subí este repo a GitHub
2. Entrá a [vercel.com](https://vercel.com) → New Project → importá el repo
3. Framework: Create React App → Deploy

¡Listo! Vercel te da una URL pública gratuita.

## Tecnologías

- React 18
- Tailwind CSS
- Storage persistente (via Claude Artifacts API)
