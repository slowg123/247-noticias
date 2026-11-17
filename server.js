// 24/7 Noticias · API de noticias importantes (política, economía y sociedad; Chile y mundo)
import express from "express";
import Parser from "rss-parser";

const PORT = process.env.PORT || 3000;
const REFRESH_MIN = 30;     // cada cuánto se vuelven a leer los feeds
const MAX_POR_FEED = 12;    // notas que se toman de cada feed
const MAX_POR_AMBITO = 25;  // notas que devuelve la API por cada ámbito (Chile / Mundo)
const MAX_EDAD_HORAS = 48;  // notas más viejas se descartan

// Para sumar o quitar medios, edita solo esta lista.
// ambito: "Chile" o "Mundo". Si un feed falla, se ignora y el resto sigue funcionando.
const FEEDS = [
  // Mundo
  { ambito: "Mundo", fuente: "BBC Mundo",   url: "https://feeds.bbci.co.uk/mundo/rss.xml" },
  { ambito: "Mundo", fuente: "DW Español",  url: "https://rss.dw.com/xml/rss-sp-all" },
  { ambito: "Mundo", fuente: "France 24",   url: "https://www.france24.com/es/rss" },
  { ambito: "Mundo", fuente: "El País",     url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada" },
  { ambito: "Mundo", fuente: "CNN Español", url: "https://cnnespanol.cnn.com/feed/" },
  // Chile (las URLs de secciones son las que más probablemente haya que corregir)
  { ambito: "Chile", fuente: "La Tercera",  url: "https://www.latercera.com/arc/outboundfeeds/rss/?outputType=xml" },
  { ambito: "Chile", fuente: "La Tercera",  url: "https://www.latercera.com/arc/outboundfeeds/rss/category/politica/?outputType=xml" },
  { ambito: "Chile", fuente: "La Tercera",  url: "https://www.latercera.com/arc/outboundfeeds/rss/category/pulso/?outputType=xml" },
  { ambito: "Chile", fuente: "El Mostrador", url: "https://www.elmostrador.cl/feed/" }
  // Para sumar más: busca "RSS" en el sitio de BioBioChile, Cooperativa, Emol, etc.
];

// ---- Filtros editoriales -------------------------------------------------
// Se descartan notas de farándula, espectáculos y entretención (por título o por dirección).
const EXCLUIR_TEXTO = /far[aá]ndula|famos[oa]s?\b|celebridad|esp[eé]ctaculo|reality|hor[oó]scopo|telenovela|influencer|youtuber|tiktoker|alfombra roja|chisme|quiniela|loter[ií]a|\bmiss\b|\bsignos?\b del zodiaco|estreno de|cartelera|netflix|disney\+|streaming/i;
const EXCLUIR_URL = /espectaculo|farandula|entretenimiento|entretencion|deportes|horoscopo|tendencias|lifestyle|cultura-y-espectaculos|gente|virales?/i;

// Temas de las notas. Lo que no calce con Economía o Política queda como Sociedad.
const ECON = /econom|inflaci|d[oó]lar|banco central|imacec|\bipc\b|cobre|\bbolsa\b|mercados?\b|tasa de (inter|polit)|desempleo|\bempleo|\bpib\b|arancel|petr[oó]leo|combustible|di[eé]sel|\bfmi\b|presupuesto|impuesto|deuda|inversi[oó]n|exportaci|salario|sueldo|pensi[oó]n|\bafp\b|reserva federal|\bfed\b|quiebra|recesi[oó]n|comercio|precio/i;
const POL = /gobierno|congreso|senado|senador|diputad|president[ea]|ministr|elecci[oó]n|elecciones|\bley\b|reforma|parlamento|tribunal|\bcorte\b|fiscal[ií]a|partido|canciller|indulto|constituci|alcald|votaci[oó]n|sanci[oó]n|guerra|\botan\b|\bonu\b|\bunión europea\b|cumbre|diplom|ej[eé]rcito|acuerdo (de paz|comercial)|protesta|paro\b|huelga/i;

const parser = new Parser({ timeout: 10000, headers: { "User-Agent": "24-7-Noticias/1.0" } });
let cache = { actualizado: null, notas: [] };

const limpiar = (s = "") => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const recorte = (s, n = 220) => (s.length > n ? s.slice(0, n).replace(/\s\S*$/, "") + "…" : s);
const tokens = t =>
  new Set(
    t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9ñ]+/).filter(w => w.length > 4)
  );

function clasificar(titulo, resumen) {
  const txt = `${titulo} ${resumen}`;
  if (ECON.test(titulo) || (ECON.test(txt) && !POL.test(titulo))) return "Economía";
  if (POL.test(txt)) return "Política";
  return "Sociedad";
}

// Importancia: más puntos si varios medios distintos cubren lo mismo,
// si la nota es de política o economía, y si es reciente.
function puntuar(notas) {
  const tk = notas.map(n => tokens(n.titulo));
  const ahora = Date.now();
  notas.forEach((n, i) => {
    const fuentes = new Set();
    notas.forEach((m, j) => {
      if (i === j || m.fuente === n.fuente) return;
      let comunes = 0;
      tk[i].forEach(w => tk[j].has(w) && comunes++);
      if (comunes >= 2) fuentes.add(m.fuente);
    });
    const horas = Math.max(0, (ahora - new Date(n.fecha)) / 36e5);
    n.cobertura = fuentes.size;
    const bonusTema = n.tema === "Sociedad" ? 0 : 2;
    n.score = +(fuentes.size * 3 + bonusTema + Math.max(0, 24 - horas) / 6).toFixed(2);
  });
  return notas;
}

async function actualizar() {
  const resultados = await Promise.allSettled(
    FEEDS.map(async f => {
      const feed = await parser.parseURL(f.url);
      return feed.items.slice(0, MAX_POR_FEED).map(it => {
        const titulo = limpiar(it.title);
        const resumen = recorte(limpiar(it.contentSnippet || it.content || it.summary || ""));
        return {
          titulo, resumen,
          fuente: f.fuente,
          ambito: f.ambito,
          tema: clasificar(titulo, resumen),
          url: it.link,
          fecha: it.isoDate || it.pubDate || new Date().toISOString()
        };
      });
    })
  );
  resultados.forEach((r, i) => {
    if (r.status === "rejected") console.warn(`Feed con error (${FEEDS[i].fuente}):`, r.reason?.message);
  });
  const limite = Date.now() - MAX_EDAD_HORAS * 36e5;
  const todas = resultados.filter(r => r.status === "fulfilled").flatMap(r => r.value)
    .filter(n => n.titulo && n.url)
    .filter(n => !EXCLUIR_TEXTO.test(n.titulo) && !EXCLUIR_URL.test(n.url))
    .filter(n => new Date(n.fecha).getTime() >= limite);
  const vistas = new Set();
  const unicas = todas.filter(n => !vistas.has(n.url) && vistas.add(n.url));
  const ordenadas = puntuar(unicas).sort((a, b) => b.score - a.score);
  const notas = ["Chile", "Mundo"].flatMap(a => ordenadas.filter(n => n.ambito === a).slice(0, MAX_POR_AMBITO))
    .sort((a, b) => b.score - a.score);
  if (notas.length) cache = { actualizado: new Date().toISOString(), notas };
  console.log(`Actualizado: ${notas.length} notas`);
}

const app = express();
app.use(express.static("public"));
app.get("/api/noticias", (req, res) => {
  const { ambito, tema } = req.query;
  const notas = cache.notas.filter(n => (!ambito || n.ambito === ambito) && (!tema || n.tema === tema));
  res.set("Cache-Control", "public, max-age=300");
  res.json({ actualizado: cache.actualizado, total: notas.length, notas });
});
app.get("/api/salud", (_req, res) => res.json({ ok: true, actualizado: cache.actualizado }));

app.listen(PORT, () => console.log(`24/7 Noticias en http://localhost:${PORT}`));
actualizar();
setInterval(actualizar, REFRESH_MIN * 60 * 1000);
