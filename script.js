/* =============================================================================
   ZONAS DE REPARTO — script.js
   JavaScript puro, sin frameworks. Leaflet + OpenStreetMap + GeoJSON.

   Estructura del archivo (buscá estos titulos con Ctrl+F para navegar rapido):
     1. CONFIG
     2. ESTADO GLOBAL
     3. CARGA DE DATOS (barrios.geojson + zonas.json [+ canelones.geojson opc.])
     4. INICIALIZACION DEL MAPA
     5. RENDER DE ZONAS (pintado de barrios)
     6. INFO / POPUP DE BARRIO
     7. PANEL LATERAL — cadetes
     8. PANEL LATERAL — zonas (capas on/off)
     9. BUSCADOR
     10. REDISTRIBUCION ("Falta un cadete")
     11. RESPONSIVE — panel movil
     12. ARRANQUE
   ============================================================================= */

/* ========================================================================= */
/* 1. CONFIG                                                                  */
/* ========================================================================= */

const CONFIG = {
  archivoBarrios: "barrios.geojson",
  archivoZonas: "zonas.json",
  // Si existe, se suma como capa adicional (Canelones). Si no existe, se ignora
  // sin romper nada — asi el proyecto queda preparado para crecer sin tocar codigo.
  archivoCanelonesOpcional: "canelones.geojson",

  centroInicial: [-34.83, -56.18], // Montevideo + Canelones
  zoomInicial: 11,

  estiloBase: {
    weight: 1.5,
    opacity: 0.9,
    fillOpacity: 0.55
  },
  estiloHover: {
    weight: 3,
    fillOpacity: 0.72
  },
  estiloSeleccionado: {
    weight: 3.5,
    color: "#1c2530",
    fillOpacity: 0.8
  }
};

/* ========================================================================= */
/* 2. ESTADO GLOBAL                                                           */
/* ========================================================================= */

const STATE = {
  map: null,
  geojsonBarrios: null,          // FeatureCollection crudo
  zonas: null,                   // contenido de zonas.json
  capasPorZona: {},              // { "1": L.geoJSON(...), ... }
  featureLayerPorNombre: {},     // { "POCITOS": layerLeaflet }
  zonasActivas: new Set(),       // zonas visibles actualmente
  colorZonaEfectivo: {},         // color a usar por zona (cambia con redistribucion)
  redistribucionActiva: null,    // nombre del cadete ausente, o null
  capaSeleccionada: null
};

/* ========================================================================= */
/* 3. CARGA DE DATOS                                                          */
/* ========================================================================= */

async function cargarJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo cargar ${url} (HTTP ${res.status})`);
  return res.json();
}

async function cargarDatos() {
  let barrios, zonas;
  try {
    [barrios, zonas] = await Promise.all([
      cargarJSON(CONFIG.archivoBarrios),
      cargarJSON(CONFIG.archivoZonas)
    ]);
  } catch (err) {
    mostrarErrorCarga(err);
    throw err;
  }

  // Canelones es opcional — si no esta el archivo o falla, seguimos solo con Montevideo.
  try {
    const canelones = await cargarJSON(CONFIG.archivoCanelonesOpcional);
    barrios.features = barrios.features.concat(canelones.features);
  } catch (_) {
    // No pasa nada: Canelones todavia no fue agregado a este proyecto.
  }

  STATE.geojsonBarrios = barrios;
  STATE.zonas = zonas;
}

function mostrarErrorCarga(err) {
  const mapaDiv = document.getElementById("mapa");
  mapaDiv.innerHTML = `
    <div style="max-width:560px;margin:60px auto;padding:24px;background:#fff;
      border-radius:10px;font-family:sans-serif;line-height:1.6;color:#1c2530;">
      <h2 style="margin-top:0;">No se pudieron cargar los datos</h2>
      <p>El navegador bloqueó la carga de <code>barrios.geojson</code> / <code>zonas.json</code>
      porque el archivo se abrió directamente (protocolo <code>file://</code>). Esto es una
      restricción normal de seguridad de los navegadores, no un error del proyecto.</p>
      <p><b>Solución rápida (una sola vez):</b> abrí una terminal en esta carpeta y corré:</p>
      <pre style="background:#f0f2f5;padding:10px;border-radius:6px;overflow-x:auto;">python3 -m http.server 8000</pre>
      <p>Y después abrí <code>http://localhost:8000</code> en el navegador.</p>
      <p>Si publicás el proyecto en <b>GitHub Pages</b> (ver README.md), este problema
      desaparece por completo y funciona directo desde el celular.</p>
      <p style="color:#8a97a6;font-size:12.5px;">Detalle técnico: ${err.message}</p>
    </div>`;
}

/* ========================================================================= */
/* 4. INICIALIZACION DEL MAPA                                                 */
/* ========================================================================= */

function inicializarMapa() {
  STATE.map = L.map("mapa", {
    zoomControl: false
  }).setView(CONFIG.centroInicial, CONFIG.zoomInicial);

  L.control.zoom({ position: "bottomright" }).addTo(STATE.map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(STATE.map);
}

/* ========================================================================= */
/* 5. RENDER DE ZONAS (pintado de barrios)                                    */
/* ========================================================================= */

function colorZona(zona) {
  return STATE.colorZonaEfectivo[zona] || STATE.zonas.colores[zona] || "#999999";
}

function nombreBarrio(feature) {
  return feature.properties.nombre || feature.properties.NOMBRE || "SIN NOMBRE";
}

function zonaDeBarrio(nombre) {
  return (STATE.zonas.barrios || {})[nombre] || null;
}

function construirCapas() {
  // Reinicia el estado de color efectivo = color normal de cada zona
  STATE.colorZonaEfectivo = Object.assign({}, STATE.zonas.colores);

  const porZona = {}; // "1" -> [feature, feature, ...]

  STATE.geojsonBarrios.features.forEach((feature) => {
    const nombre = nombreBarrio(feature);
    const zona = zonaDeBarrio(nombre);
    if (!zona) return; // barrio sin zona asignada: no se pinta (evita inventar datos)
    porZona[zona] = porZona[zona] || [];
    porZona[zona].push(feature);
  });

  Object.keys(porZona).forEach((zona) => {
    const capa = L.geoJSON(
      { type: "FeatureCollection", features: porZona[zona] },
      {
        style: () => estiloDeZona(zona),
        onEachFeature: (feature, layer) => {
          const nombre = nombreBarrio(feature);
          STATE.featureLayerPorNombre[nombre] = layer;
          layer.on("mouseover", () => {
            if (STATE.capaSeleccionada !== layer) layer.setStyle(CONFIG.estiloHover);
          });
          layer.on("mouseout", () => {
            if (STATE.capaSeleccionada !== layer) layer.setStyle(estiloDeZona(zonaDeBarrio(nombre)));
          });
          layer.on("click", () => seleccionarBarrio(feature, layer));
        }
      }
    );
    STATE.capasPorZona[zona] = capa;
    STATE.zonasActivas.add(zona);
    capa.addTo(STATE.map);
  });
}

function estiloDeZona(zona) {
  return Object.assign({}, CONFIG.estiloBase, {
    color: shadeColor(colorZona(zona), -20),
    fillColor: colorZona(zona)
  });
}

// Oscurece/aclara un color hex un porcentaje (para el borde del poligono)
function shadeColor(hex, percent) {
  const num = parseInt(hex.replace("#", ""), 16);
  let r = (num >> 16) + Math.round((percent / 100) * 255);
  let g = ((num >> 8) & 0x00ff) + Math.round((percent / 100) * 255);
  let b = (num & 0x0000ff) + Math.round((percent / 100) * 255);
  r = Math.max(Math.min(255, r), 0);
  g = Math.max(Math.min(255, g), 0);
  b = Math.max(Math.min(255, b), 0);
  return "#" + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
}

function repintarTodo() {
  Object.keys(STATE.capasPorZona).forEach((zona) => {
    STATE.capasPorZona[zona].eachLayer((layer) => {
      const nombre = nombreBarrio(layer.feature);
      layer.setStyle(estiloDeZona(zonaDeBarrio(nombre)));
    });
  });
}

/* ========================================================================= */
/* 6. INFO / POPUP DE BARRIO                                                  */
/* ========================================================================= */

function seleccionarBarrio(feature, layer) {
  if (STATE.capaSeleccionada) {
    const prevNombre = nombreBarrio(STATE.capaSeleccionada.feature);
    STATE.capaSeleccionada.setStyle(estiloDeZona(zonaDeBarrio(prevNombre)));
  }
  STATE.capaSeleccionada = layer;
  layer.setStyle(CONFIG.estiloSeleccionado);

  const nombre = nombreBarrio(feature);
  const zona = zonaDeBarrio(nombre);
  const cadete = cadeteDeZona(zona);
  const paquetes = (STATE.zonas.paquetes || {})[nombre];

  const html = `
    <div class="popup-barrio">
      <h3>${tituloCase(nombre)}</h3>
      <div class="info-fila"><b>Zona</b><span>${zona ? "Zona " + zona : "—"}</span></div>
      <div class="info-fila"><b>Cadete</b><span>${cadete || "Sin asignar"}</span></div>
      ${paquetes !== undefined ? `<div class="info-fila"><b>Paquetes</b><span>${paquetes}</span></div>` : ""}
    </div>`;

  layer.bindPopup(html).openPopup();
  actualizarPanelInfo(nombre, zona, cadete, paquetes);
}

function actualizarPanelInfo(nombre, zona, cadete, paquetes) {
  const el = document.getElementById("info-barrio");
  el.classList.remove("info-vacio");
  el.innerHTML = `
    <div class="info-fila"><b>Nombre</b><span>${tituloCase(nombre)}</span></div>
    <div class="info-fila"><b>Zona</b><span>${zona ? "Zona " + zona : "—"}</span></div>
    <div class="info-fila"><b>Cadete</b><span>${cadete || "Sin asignar"}</span></div>
    ${paquetes !== undefined ? `<div class="info-fila"><b>Paquetes</b><span>${paquetes}</span></div>` : ""}
  `;
}

function tituloCase(str) {
  return str
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function cadeteDeZona(zona) {
  if (!zona || !STATE.zonas.cadetes) return null;
  for (const [nombre, datos] of Object.entries(STATE.zonas.cadetes)) {
    if (nombre.startsWith("_")) continue; // saltea comentarios
    if ((datos.zonas || []).includes(zona)) return nombre;
  }
  return null;
}

/* ========================================================================= */
/* 7. PANEL LATERAL — cadetes                                                 */
/* ========================================================================= */

function renderCadetes() {
  const cont = document.getElementById("lista-cadetes");
  cont.innerHTML = "";
  const cadetes = STATE.zonas.cadetes || {};

  Object.entries(cadetes).forEach(([nombre, datos]) => {
    if (nombre.startsWith("_")) return;
    const zonasTxt = (datos.zonas || []).map((z) => "Z" + z).join(", ");
    const colorMuestra = (datos.zonas || [])[0] ? colorZona(datos.zonas[0]) : "#999";
    const div = document.createElement("div");
    div.className = "cadete-item";
    if (STATE.redistribucionActiva === nombre) div.classList.add("reasignado");
    div.innerHTML = `
      <span class="cadete-swatch" style="background:${colorMuestra}"></span>
      <span class="cadete-nombre">${nombre}</span>
      <span class="cadete-meta">${zonasTxt}</span>
    `;
    cont.appendChild(div);
  });

  if (Object.keys(cadetes).filter((k) => !k.startsWith("_")).length === 0) {
    cont.innerHTML = `<p class="panel-hint">No hay cadetes cargados en zonas.json todavía.</p>`;
  }
}

/* ========================================================================= */
/* 8. PANEL LATERAL — zonas (capas on/off)                                   */
/* ========================================================================= */

function renderZonas() {
  const cont = document.getElementById("lista-zonas");
  cont.innerHTML = "";

  const zonasOrdenadas = Object.keys(STATE.capasPorZona).sort(
    (a, b) => Number(a) - Number(b)
  );

  zonasOrdenadas.forEach((zona) => {
    const cantidad = STATE.capasPorZona[zona].getLayers().length;
    const chip = document.createElement("div");
    chip.className = "zona-chip";
    chip.dataset.zona = zona;
    chip.innerHTML = `
      <span class="zona-color-dot" style="background:${colorZona(zona)}"></span>
      <span class="zona-nombre">Zona ${zona}</span>
      <span class="zona-count">${cantidad} barrios</span>
    `;
    chip.addEventListener("click", () => toggleZona(zona, chip));
    cont.appendChild(chip);
  });
}

function toggleZona(zona, chipEl) {
  const capa = STATE.capasPorZona[zona];
  if (STATE.zonasActivas.has(zona)) {
    STATE.map.removeLayer(capa);
    STATE.zonasActivas.delete(zona);
    chipEl.classList.add("inactiva");
  } else {
    capa.addTo(STATE.map);
    STATE.zonasActivas.add(zona);
    chipEl.classList.remove("inactiva");
  }
}

/* ========================================================================= */
/* 9. BUSCADOR                                                               */
/* ========================================================================= */

function inicializarBuscador() {
  const input = document.getElementById("buscador");
  const resultadosDiv = document.getElementById("buscador-resultados");

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) {
      resultadosDiv.classList.add("oculto");
      resultadosDiv.innerHTML = "";
      return;
    }
    const coincidencias = Object.keys(STATE.featureLayerPorNombre)
      .filter((nombre) => tituloCase(nombre).toLowerCase().includes(q))
      .slice(0, 10);

    if (coincidencias.length === 0) {
      resultadosDiv.innerHTML = `<div class="resultado-item">Sin resultados</div>`;
    } else {
      resultadosDiv.innerHTML = coincidencias
        .map((nombre) => {
          const zona = zonaDeBarrio(nombre);
          return `<div class="resultado-item" data-nombre="${nombre}">
            <span>${tituloCase(nombre)}</span>
            <span class="resultado-zona-tag" style="background:${colorZona(zona)}">Z${zona}</span>
          </div>`;
        })
        .join("");
    }
    resultadosDiv.classList.remove("oculto");
  });

  resultadosDiv.addEventListener("click", (e) => {
    const item = e.target.closest(".resultado-item");
    if (!item || !item.dataset.nombre) return;
    irABarrio(item.dataset.nombre);
    resultadosDiv.classList.add("oculto");
    input.value = tituloCase(item.dataset.nombre);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#buscador-wrap")) resultadosDiv.classList.add("oculto");
  });
}

function irABarrio(nombre) {
  const layer = STATE.featureLayerPorNombre[nombre];
  if (!layer) return;
  STATE.map.fitBounds(layer.getBounds(), { maxZoom: 15, padding: [40, 40] });
  seleccionarBarrio(layer.feature, layer);
  if (window.innerWidth <= 900) cerrarPanelMovil();
}

/* ========================================================================= */
/* 10. REDISTRIBUCION ("Falta un cadete")                                    */
/* ========================================================================= */

function inicializarRedistribucion() {
  const btnAbrir = document.getElementById("btn-falta-cadete");
  const modal = document.getElementById("modal-cadete");
  const modalLista = document.getElementById("modal-lista-cadetes");
  const modalCancelar = document.getElementById("modal-cancelar");
  const btnRestaurar = document.getElementById("btn-restaurar");

  btnAbrir.addEventListener("click", () => {
    const cadetes = Object.keys(STATE.zonas.cadetes || {}).filter((k) => !k.startsWith("_"));
    modalLista.innerHTML = cadetes
      .map((nombre) => `<button class="modal-opcion" data-nombre="${nombre}">${nombre}</button>`)
      .join("");
    modal.classList.remove("oculto");
  });

  modalLista.addEventListener("click", (e) => {
    const btn = e.target.closest(".modal-opcion");
    if (!btn) return;
    aplicarRedistribucion(btn.dataset.nombre);
    modal.classList.add("oculto");
  });

  modalCancelar.addEventListener("click", () => modal.classList.add("oculto"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("oculto");
  });

  btnRestaurar.addEventListener("click", restaurarZonasNormales);
}

function aplicarRedistribucion(nombreCadete) {
  const reglas = (STATE.zonas.redistribucion || {})[nombreCadete];
  if (!reglas) {
    alert(`No hay reglas de redistribución definidas para "${nombreCadete}" en zonas.json.`);
    return;
  }

  // Reset primero, para poder aplicar reglas de forma consistente si se cambia de cadete ausente
  STATE.colorZonaEfectivo = Object.assign({}, STATE.zonas.colores);

  Object.entries(reglas).forEach(([zonaAfectada, zonaQueAbsorbe]) => {
    STATE.colorZonaEfectivo[zonaAfectada] = STATE.zonas.colores[zonaQueAbsorbe] || colorZona(zonaQueAbsorbe);
  });

  STATE.redistribucionActiva = nombreCadete;
  repintarTodo();
  renderCadetes();
  renderZonas();

  const texto = Object.entries(reglas)
    .map(([z, absorbe]) => `Zona ${z} → cubierta como Zona ${absorbe}`)
    .join(" · ");
  document.getElementById("redistribucion-texto").textContent = `${nombreCadete} ausente. ${texto}`;
  document.getElementById("redistribucion-activa").classList.remove("oculto");
}

function restaurarZonasNormales() {
  STATE.redistribucionActiva = null;
  STATE.colorZonaEfectivo = Object.assign({}, STATE.zonas.colores);
  repintarTodo();
  renderCadetes();
  renderZonas();
  document.getElementById("redistribucion-activa").classList.add("oculto");
}

/* ========================================================================= */
/* 11. RESPONSIVE — panel movil                                              */
/* ========================================================================= */

function inicializarPanelMovil() {
  const btnMenu = document.getElementById("btn-menu");
  const panel = document.getElementById("panel");
  btnMenu.addEventListener("click", () => panel.classList.toggle("abierto"));
}

function cerrarPanelMovil() {
  document.getElementById("panel").classList.remove("abierto");
}

/* ========================================================================= */
/* 12. ARRANQUE                                                              */
/* ========================================================================= */

async function iniciarApp() {
  await cargarDatos();
  inicializarMapa();
  construirCapas();
  renderCadetes();
  renderZonas();
  inicializarBuscador();
  inicializarRedistribucion();
  inicializarPanelMovil();
}

document.addEventListener("DOMContentLoaded", iniciarApp);
