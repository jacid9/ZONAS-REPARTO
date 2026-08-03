/* =============================================================================
   ZONAS DE REPARTO — script.js
   JavaScript puro, sin frameworks. Leaflet + OpenStreetMap + GeoJSON.

   Estructura del archivo (buscá estos titulos con Ctrl+F para navegar rapido):
     1. CONFIG
     2. ESTADO GLOBAL
     3. CARGA DE DATOS (barrios.geojson + zonas.json [+ canelones.geojson opc.])
     4. PERSISTENCIA LOCAL (guardar cambios en este navegador + exportar/restablecer)
     5. INICIALIZACION DEL MAPA
     6. RENDER DE ZONAS (pintado de barrios, con soporte de asignacion manual)
     7. INFO / POPUP DE BARRIO
     8. PANEL LATERAL — cadetes (listar + agregar)
     9. PANEL LATERAL — zonas (capas on/off)
     10. BUSCADOR
     11. REDISTRIBUCION ("Falta un cadete")
     12. MODO EDICION — asignar un barrio a mano a cualquier cadete
     13. RESPONSIVE — panel movil
     14. ARRANQUE
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
  capaSeleccionada: null,
  editMode: false,               // modo edicion (asignar barrio a mano) activo/no
  barrioEnEdicion: null,         // nombre del barrio que se esta asignando ahora mismo
  zonaEnEdicion: null            // zona que se esta asignando en bloque ahora mismo
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
  if (!STATE.zonas.cadetes) STATE.zonas.cadetes = {};
  if (!STATE.zonas.asignaciones) STATE.zonas.asignaciones = {};

  // Si en este navegador ya se agregaron cadetes o asignaciones antes, los
  // traemos por encima de lo que venga en zonas.json.
  cargarCambiosLocales();
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
/* 4. PERSISTENCIA LOCAL                                                      */
/*    Esta pagina no tiene servidor propio: los cadetes que agregues y las    */
/*    asignaciones manuales que hagas se guardan en el navegador (localStorage)*/
/*    para que no se pierdan al recargar. Para que el cambio se vea en el     */
/*    link que usan los demas, hay que exportar y subir el archivo a GitHub.  */
/* ========================================================================= */

const LS_KEY = "zonasReparto_overrides_v1";

function guardarCambiosLocales() {
  const datos = {
    cadetes: STATE.zonas.cadetes,
    asignaciones: STATE.zonas.asignaciones,
    redistribucion: STATE.zonas.redistribucion
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(datos));
  } catch (_) {
    // Si el navegador bloquea localStorage (modo privado, etc.) seguimos
    // funcionando igual, solo que no persiste entre recargas.
  }
  mostrarAvisoCambiosSinGuardar();
}

function cargarCambiosLocales() {
  let guardado;
  try {
    guardado = localStorage.getItem(LS_KEY);
  } catch (_) {
    return;
  }
  if (!guardado) return;
  try {
    const datos = JSON.parse(guardado);
    if (datos.cadetes) STATE.zonas.cadetes = datos.cadetes;
    if (datos.asignaciones) STATE.zonas.asignaciones = datos.asignaciones;
    if (datos.redistribucion) STATE.zonas.redistribucion = datos.redistribucion;
  } catch (_) {
    // JSON corrupto en localStorage: lo ignoramos y seguimos con zonas.json tal cual.
  }
}

function hayCambiosLocales() {
  try {
    return !!localStorage.getItem(LS_KEY);
  } catch (_) {
    return false;
  }
}

function mostrarAvisoCambiosSinGuardar() {
  document.getElementById("cambios-sin-guardar").classList.toggle("oculto", !hayCambiosLocales());
}

function exportarZonasJSON() {
  const blob = new Blob([JSON.stringify(STATE.zonas, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "zonas.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function restablecerCambiosLocales() {
  if (!confirm("Esto borra los cadetes y asignaciones manuales que agregaste en este navegador, y vuelve al zonas.json original. ¿Continuar?")) return;
  try {
    localStorage.removeItem(LS_KEY);
  } catch (_) {}
  location.reload();
}

/* ========================================================================= */
/* 5. INICIALIZACION DEL MAPA                                                 */
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
/* 6. RENDER DE ZONAS (pintado de barrios, con soporte de asignacion manual) */
/* ========================================================================= */

function colorZona(zona) {
  return STATE.colorZonaEfectivo[zona] || STATE.zonas.colores[zona] || "#999999";
}

// Paleta de reserva para cadetes que se agregan sin elegir color (no deberia
// pasar desde el formulario, pero por las dudas no se rompe nada).
const PALETA_CADETES_RESERVA = ["#2f6fed", "#e6194B", "#3cb44b", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#469990"];

function colorDeCadete(nombreCadete) {
  const datos = (STATE.zonas.cadetes || {})[nombreCadete];
  if (datos && datos.color) return datos.color;
  // fallback deterministico en base al nombre, para que no cambie en cada recarga
  let hash = 0;
  for (let i = 0; i < nombreCadete.length; i++) hash = nombreCadete.charCodeAt(i) + ((hash << 5) - hash);
  return PALETA_CADETES_RESERVA[Math.abs(hash) % PALETA_CADETES_RESERVA.length];
}

function nombreBarrio(feature) {
  return feature.properties.nombre || feature.properties.NOMBRE || "SIN NOMBRE";
}

function zonaDeBarrio(nombre) {
  return (STATE.zonas.barrios || {})[nombre] || null;
}

// Si el barrio tiene una asignacion manual, esa gana. Si no, el cadete por
// defecto de su zona (o null si nadie cubre esa zona).
function cadeteDeBarrio(nombre) {
  const asignado = (STATE.zonas.asignaciones || {})[nombre];
  if (asignado) return asignado;
  return cadeteDeZona(zonaDeBarrio(nombre));
}

function tieneAsignacionManual(nombre) {
  return !!(STATE.zonas.asignaciones || {})[nombre];
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
        style: (feature) => estiloDeBarrio(nombreBarrio(feature)),
        onEachFeature: (feature, layer) => {
          const nombre = nombreBarrio(feature);
          STATE.featureLayerPorNombre[nombre] = layer;
          layer.on("mouseover", () => {
            if (STATE.capaSeleccionada !== layer) layer.setStyle(CONFIG.estiloHover);
          });
          layer.on("mouseout", () => {
            if (STATE.capaSeleccionada !== layer) layer.setStyle(estiloDeBarrio(nombre));
          });
          layer.on("click", () => {
            if (STATE.editMode) abrirModalAsignarBarrio(feature, layer);
            else seleccionarBarrio(feature, layer);
          });
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

// Como estiloDeZona, pero si el barrio tiene asignacion manual usa el color
// del cadete y un borde punteado mas grueso, para que se note a simple vista
// que ese barrio "no sigue la regla" de su zona.
function estiloDeBarrio(nombre) {
  const asignado = (STATE.zonas.asignaciones || {})[nombre];
  if (asignado) {
    const color = colorDeCadete(asignado);
    return Object.assign({}, CONFIG.estiloBase, {
      color: shadeColor(color, -25),
      fillColor: color,
      weight: 3,
      dashArray: "5,4",
      fillOpacity: 0.65
    });
  }
  return estiloDeZona(zonaDeBarrio(nombre));
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
      layer.setStyle(estiloDeBarrio(nombre));
    });
  });
}

/* ========================================================================= */
/* 7. INFO / POPUP DE BARRIO                                                  */
/* ========================================================================= */

function seleccionarBarrio(feature, layer) {
  if (STATE.capaSeleccionada) {
    const prevNombre = nombreBarrio(STATE.capaSeleccionada.feature);
    STATE.capaSeleccionada.setStyle(estiloDeBarrio(prevNombre));
  }
  STATE.capaSeleccionada = layer;
  layer.setStyle(CONFIG.estiloSeleccionado);

  const nombre = nombreBarrio(feature);
  const zona = zonaDeBarrio(nombre);
  const cadete = cadeteDeBarrio(nombre);
  const manual = tieneAsignacionManual(nombre);
  const paquetes = (STATE.zonas.paquetes || {})[nombre];

  const html = `
    <div class="popup-barrio">
      <h3>${tituloCase(nombre)}</h3>
      <div class="info-fila"><b>Zona</b><span>${zona ? "Zona " + zona : "—"}</span></div>
      <div class="info-fila"><b>Cadete</b><span>${cadete || "Sin asignar"}${manual ? " (manual)" : ""}</span></div>
      ${paquetes !== undefined ? `<div class="info-fila"><b>Paquetes</b><span>${paquetes}</span></div>` : ""}
    </div>`;

  layer.bindPopup(html).openPopup();
  actualizarPanelInfo(nombre, zona, cadete, paquetes, manual);
}

function actualizarPanelInfo(nombre, zona, cadete, paquetes, manual) {
  const el = document.getElementById("info-barrio");
  el.classList.remove("info-vacio");
  el.innerHTML = `
    <div class="info-fila"><b>Nombre</b><span>${tituloCase(nombre)}</span></div>
    <div class="info-fila"><b>Zona</b><span>${zona ? "Zona " + zona : "—"}</span></div>
    <div class="info-fila"><b>Cadete</b><span>${cadete || "Sin asignar"}${manual ? " (manual)" : ""}</span></div>
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
/* 8. PANEL LATERAL — cadetes (listar + agregar)                              */
/* ========================================================================= */

function renderCadetes() {
  const cont = document.getElementById("lista-cadetes");
  cont.innerHTML = "";
  const cadetes = STATE.zonas.cadetes || {};
  const nombres = Object.keys(cadetes).filter((k) => !k.startsWith("_"));

  nombres.forEach((nombre) => {
    const datos = cadetes[nombre];
    const zonasTxt = (datos.zonas || []).length ? (datos.zonas || []).map((z) => "Z" + z).join(", ") : "sin zona fija";
    const div = document.createElement("div");
    div.className = "cadete-item";
    if (STATE.redistribucionActiva === nombre) div.classList.add("reasignado");
    div.innerHTML = `
      <span class="cadete-swatch" style="background:${colorDeCadete(nombre)}"></span>
      <span class="cadete-nombre">${nombre}</span>
      <span class="cadete-meta">${zonasTxt}</span>
      <button class="cadete-borrar" data-nombre="${nombre}" title="Eliminar cadete">✕</button>
    `;
    cont.appendChild(div);
  });

  if (nombres.length === 0) {
    cont.innerHTML = `<p class="panel-hint">No hay cadetes cargados todavía.</p>`;
  }

  cont.querySelectorAll(".cadete-borrar").forEach((btn) => {
    btn.addEventListener("click", () => eliminarCadete(btn.dataset.nombre));
  });
}

function agregarCadete(nombre, color) {
  nombre = nombre.trim();
  if (!nombre) {
    alert("Poné un nombre para el cadete.");
    return false;
  }
  if (STATE.zonas.cadetes[nombre]) {
    alert(`Ya existe un cadete llamado "${nombre}".`);
    return false;
  }
  STATE.zonas.cadetes[nombre] = { zonas: [], color: color };
  guardarCambiosLocales();
  renderCadetes();
  return true;
}

function eliminarCadete(nombre) {
  if (!confirm(`¿Eliminar a ${nombre}? Los barrios que tenía asignados a mano vuelven a su zona normal.`)) return;
  delete STATE.zonas.cadetes[nombre];
  // Limpiamos asignaciones manuales que apuntaban a este cadete, para no dejar
  // barrios "asignados" a alguien que ya no existe.
  Object.keys(STATE.zonas.asignaciones || {}).forEach((barrio) => {
    if (STATE.zonas.asignaciones[barrio] === nombre) delete STATE.zonas.asignaciones[barrio];
  });
  guardarCambiosLocales();
  renderCadetes();
  repintarTodo();
}

/* ========================================================================= */
/* 9. PANEL LATERAL — zonas (capas on/off)                                    */
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
      <button class="zona-asignar-btn" data-zona="${zona}" title="Asignar toda esta zona a un cadete">→ Cadete</button>
    `;
    chip.addEventListener("click", () => toggleZona(zona, chip));
    chip.querySelector(".zona-asignar-btn").addEventListener("click", (e) => {
      e.stopPropagation(); // que no dispare el toggle de mostrar/ocultar la zona
      abrirModalAsignarZona(zona);
    });
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
/* 10. BUSCADOR                                                               */
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
/* 11. REDISTRIBUCION ("Falta un cadete")                                     */
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
/* 12. MODO EDICION — asignar un barrio a mano a cualquier cadete             */
/* ========================================================================= */

function inicializarModoEdicion() {
  const btnModo = document.getElementById("btn-modo-edicion");
  const btnAgregarCadete = document.getElementById("btn-agregar-cadete");
  const btnExportar = document.getElementById("btn-exportar");
  const btnRestablecer = document.getElementById("btn-restablecer");

  btnModo.addEventListener("click", () => {
    STATE.editMode = !STATE.editMode;
    btnModo.textContent = STATE.editMode ? "Desactivar modo edición" : "Activar modo edición";
    btnModo.classList.toggle("activo", STATE.editMode);
    document.getElementById("mapa").classList.toggle("modo-edicion-activo", STATE.editMode);
  });

  btnAgregarCadete.addEventListener("click", abrirModalNuevoCadete);
  btnExportar.addEventListener("click", exportarZonasJSON);
  btnRestablecer.addEventListener("click", restablecerCambiosLocales);

  inicializarModalNuevoCadete();
  inicializarModalAsignarBarrio();
  inicializarModalAsignarZona();

  mostrarAvisoCambiosSinGuardar();
}

/* --- modal: nuevo cadete ------------------------------------------------- */

function abrirModalNuevoCadete() {
  document.getElementById("input-nombre-cadete").value = "";
  document.getElementById("input-color-cadete").value = "#2f6fed";
  document.getElementById("modal-nuevo-cadete").classList.remove("oculto");
  document.getElementById("input-nombre-cadete").focus();
}

function inicializarModalNuevoCadete() {
  const modal = document.getElementById("modal-nuevo-cadete");
  const btnGuardar = document.getElementById("btn-guardar-cadete");
  const btnCancelar = document.getElementById("modal-nuevo-cadete-cancelar");

  btnGuardar.addEventListener("click", () => {
    const nombre = document.getElementById("input-nombre-cadete").value;
    const color = document.getElementById("input-color-cadete").value;
    if (agregarCadete(nombre, color)) modal.classList.add("oculto");
  });
  btnCancelar.addEventListener("click", () => modal.classList.add("oculto"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("oculto"); });
}

/* --- modal: asignar barrio a un cadete (modo edicion) -------------------- */

function inicializarModalAsignarBarrio() {
  const modal = document.getElementById("modal-asignar-barrio");
  const btnCancelar = document.getElementById("modal-asignar-cancelar");
  const btnQuitar = document.getElementById("btn-quitar-asignacion");

  btnCancelar.addEventListener("click", () => modal.classList.add("oculto"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("oculto"); });

  btnQuitar.addEventListener("click", () => {
    if (!STATE.barrioEnEdicion) return;
    delete STATE.zonas.asignaciones[STATE.barrioEnEdicion];
    guardarCambiosLocales();
    repintarUnBarrio(STATE.barrioEnEdicion);
    renderZonas();
    modal.classList.add("oculto");
  });
}

function abrirModalAsignarBarrio(feature, layer) {
  const nombre = nombreBarrio(feature);
  STATE.barrioEnEdicion = nombre;

  document.getElementById("asignar-barrio-titulo").textContent = tituloCase(nombre);
  document.getElementById("asignar-barrio-zona").textContent = "Zona " + (zonaDeBarrio(nombre) || "—");

  const lista = document.getElementById("asignar-barrio-lista");
  const nombresCadetes = Object.keys(STATE.zonas.cadetes || {}).filter((k) => !k.startsWith("_"));

  if (nombresCadetes.length === 0) {
    lista.innerHTML = `<p class="panel-hint">Todavía no agregaste ningún cadete. Cerrá esto y usá "+ Agregar cadete" primero.</p>`;
  } else {
    lista.innerHTML = nombresCadetes
      .map(
        (nombreCadete) => `
        <button class="modal-opcion asignar-opcion-cadete" data-nombre="${nombreCadete}">
          <span class="zona-color-dot" style="background:${colorDeCadete(nombreCadete)}"></span>
          ${nombreCadete}
        </button>`
      )
      .join("");
    lista.querySelectorAll(".asignar-opcion-cadete").forEach((btn) => {
      btn.addEventListener("click", () => {
        STATE.zonas.asignaciones[nombre] = btn.dataset.nombre;
        guardarCambiosLocales();
        repintarUnBarrio(nombre);
        renderZonas();
        document.getElementById("modal-asignar-barrio").classList.add("oculto");
        if (STATE.capaSeleccionada === layer) seleccionarBarrio(feature, layer);
      });
    });
  }

  document.getElementById("modal-asignar-barrio").classList.remove("oculto");
}

function repintarUnBarrio(nombre) {
  const layer = STATE.featureLayerPorNombre[nombre];
  if (layer) layer.setStyle(estiloDeBarrio(nombre));
}

/* --- asignar una ZONA ENTERA de una sola vez ------------------------------ */

function barriosDeZona(zona) {
  return Object.keys(STATE.zonas.barrios || {}).filter(
    (nombre) => STATE.zonas.barrios[nombre] === zona
  );
}

function inicializarModalAsignarZona() {
  const modal = document.getElementById("modal-asignar-zona");
  const btnCancelar = document.getElementById("modal-asignar-zona-cancelar");
  const btnQuitar = document.getElementById("btn-quitar-asignacion-zona");

  btnCancelar.addEventListener("click", () => modal.classList.add("oculto"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("oculto"); });

  btnQuitar.addEventListener("click", () => {
    if (!STATE.zonaEnEdicion) return;
    barriosDeZona(STATE.zonaEnEdicion).forEach((nombre) => delete STATE.zonas.asignaciones[nombre]);
    guardarCambiosLocales();
    repintarTodo();
    renderZonas();
    modal.classList.add("oculto");
  });
}

function abrirModalAsignarZona(zona) {
  STATE.zonaEnEdicion = zona;
  document.getElementById("asignar-zona-titulo").textContent = `Asignar Zona ${zona} a…`;

  const lista = document.getElementById("asignar-zona-lista");
  const nombresCadetes = Object.keys(STATE.zonas.cadetes || {}).filter((k) => !k.startsWith("_"));

  if (nombresCadetes.length === 0) {
    lista.innerHTML = `<p class="panel-hint">Todavía no agregaste ningún cadete. Cerrá esto y usá "+ Agregar cadete" primero.</p>`;
  } else {
    lista.innerHTML = nombresCadetes
      .map(
        (nombreCadete) => `
        <button class="modal-opcion asignar-opcion-cadete" data-nombre="${nombreCadete}">
          <span class="zona-color-dot" style="background:${colorDeCadete(nombreCadete)}"></span>
          ${nombreCadete}
        </button>`
      )
      .join("");
    lista.querySelectorAll(".asignar-opcion-cadete").forEach((btn) => {
      btn.addEventListener("click", () => {
        barriosDeZona(zona).forEach((nombreBarrioZona) => {
          STATE.zonas.asignaciones[nombreBarrioZona] = btn.dataset.nombre;
        });
        guardarCambiosLocales();
        repintarTodo();
        renderZonas();
        document.getElementById("modal-asignar-zona").classList.add("oculto");
      });
    });
  }

  document.getElementById("modal-asignar-zona").classList.remove("oculto");
}

/* ========================================================================= */
/* 13. RESPONSIVE — panel movil                                              */
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
/* 14. ARRANQUE                                                              */
/* ========================================================================= */

async function iniciarApp() {
  await cargarDatos();
  inicializarMapa();
  construirCapas();
  renderCadetes();
  renderZonas();
  inicializarBuscador();
  inicializarRedistribucion();
  inicializarModoEdicion();
  inicializarPanelMovil();
}

document.addEventListener("DOMContentLoaded", iniciarApp);
