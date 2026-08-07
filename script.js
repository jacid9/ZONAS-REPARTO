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
  capasPuntosPorZona: {},        // { "10": L.layerGroup con los marcadores sin poligono propio }
  capasContornoPorZona: {},      // { "10": L.layerGroup con el contorno grueso + etiqueta "Zona 10" }
  featureLayerPorNombre: {},     // { "POCITOS": layerLeaflet }
  zonasActivas: new Set(),       // zonas visibles actualmente
  cadeteZonaEfectivo: {},        // override TEMPORAL zona -> cadete (por "Falta un cadete", no se guarda)
  redistribucionActiva: null,    // nombre del cadete ausente, o null
  capaSeleccionada: null,
  editMode: false,               // modo edicion (asignar barrio a mano) activo/no
  barrioEnEdicion: null,         // nombre del barrio que se esta asignando ahora mismo
  zonaEnEdicion: null,           // zona que se esta asignando en bloque ahora mismo
  cadeteEnEdicion: null,          // nombre ORIGINAL del cadete que se esta editando (null = alta nueva)
  ultimaBusquedaDireccion: null,  // timestamp, para no pasarnos del limite de uso de Nominatim
  marcadorDireccion: null,        // el pin de la ultima direccion buscada
  firebaseDB: null                // referencia a Firebase Realtime Database, o null si no esta configurado
};

const COLOR_SIN_CADETE = "#9aa5b1"; // gris neutro: zona sin ningun cadete asignado todavia

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

  inicializarFirebase();
  await cargarCambiosCompartidos();
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
/* 4. PERSISTENCIA                                                           */
/*    Esta pagina no tiene servidor propio. Los cadetes que agregues y las   */
/*    asignaciones manuales que hagas se guardan SIEMPRE en localStorage     */
/*    (por si se pierde la conexion), y ADEMAS en Firebase si esta           */
/*    configurado en firebase-config.js — asi todos los que abren el link    */
/*    ven los mismos cambios, en tiempo real, sin descargar/subir nada.      */
/* ========================================================================= */

const LS_KEY = "zonasReparto_overrides_v1";
const FIREBASE_PATH = "zonasReparto"; // nodo dentro de la base de datos

function inicializarFirebase() {
  const cfg = typeof FIREBASE_CONFIG !== "undefined" ? FIREBASE_CONFIG : null;
  const configCompleta = cfg && cfg.apiKey && !String(cfg.apiKey).includes("TU_API_KEY_ACA");
  if (!configCompleta || typeof firebase === "undefined") {
    STATE.firebaseDB = null;
    return;
  }
  try {
    firebase.initializeApp(cfg);
    STATE.firebaseDB = firebase.database().ref(FIREBASE_PATH);
  } catch (err) {
    console.warn("No se pudo conectar a Firebase, sigo con guardado solo local.", err);
    STATE.firebaseDB = null;
  }
}

// Trae los cambios guardados (cadetes/asignaciones/redistribucion), de
// Firebase si esta disponible (y deja un "oyente" para actualizarse solo si
// alguien mas edita algo), o de localStorage si no.
async function cargarCambiosCompartidos() {
  if (STATE.firebaseDB) {
    try {
      const snap = await STATE.firebaseDB.once("value");
      const datos = snap.val();
      if (datos) aplicarCambiosCargados(datos);
    } catch (err) {
      console.warn("No se pudo leer Firebase, uso lo que haya en este navegador.", err);
      cargarCambiosLocales();
    }
    // Oyente en vivo: si otra persona edita desde otro celular, esto se
    // entera solo y repinta, sin que haga falta recargar la pagina.
    STATE.firebaseDB.on("value", (snap) => {
      const datos = snap.val();
      if (!datos || !STATE.map) return; // todavia no termino de armarse el mapa
      aplicarCambiosCargados(datos);
      repintarTodo();
      renderCadetes();
      renderZonas();
    });
  } else {
    cargarCambiosLocales();
  }
  mostrarEstadoGuardado();
}

function aplicarCambiosCargados(datos) {
  if (datos.cadetes) STATE.zonas.cadetes = datos.cadetes;
  if (datos.asignaciones) STATE.zonas.asignaciones = datos.asignaciones;
  if (datos.redistribucion) STATE.zonas.redistribucion = datos.redistribucion;
}

// Guarda los cambios: siempre en localStorage (para no perder nada si se va
// internet), y ademas en Firebase si esta conectado (para que se vea en
// todos lados).
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
  if (STATE.firebaseDB) {
    STATE.firebaseDB.set(datos).catch((err) => {
      console.warn("No se pudo guardar en Firebase, el cambio quedo solo en este navegador.", err);
    });
  }
  mostrarEstadoGuardado();
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
    aplicarCambiosCargados(JSON.parse(guardado));
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

// Chip de estado: aclara si el guardado es compartido (Firebase) o solo de
// este navegador, para que no haya sorpresas.
function mostrarEstadoGuardado() {
  const el = document.getElementById("estado-guardado");
  if (!el) return;
  if (STATE.firebaseDB) {
    el.innerHTML = `🟢 Guardado compartido activo — los cambios los ven todos, en cualquier celular.`;
  } else {
    el.innerHTML = `🟡 Guardado solo en este navegador — para compartir cambios, descargá <code>zonas.json</code> y subilo a GitHub (o configurá <code>firebase-config.js</code> para que sea automático).`;
  }
  document.getElementById("cambios-sin-guardar").classList.toggle("oculto", !!STATE.firebaseDB || !hayCambiosLocales());
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
  const mensaje = STATE.firebaseDB
    ? "Esto borra los cadetes y asignaciones manuales PARA TODOS (estan guardados en Firebase, compartido). ¿Continuar?"
    : "Esto borra los cadetes y asignaciones manuales que agregaste en este navegador, y vuelve al zonas.json original. ¿Continuar?";
  if (!confirm(mensaje)) return;
  try {
    localStorage.removeItem(LS_KEY);
  } catch (_) {}
  if (STATE.firebaseDB) {
    STATE.firebaseDB.remove().finally(() => location.reload());
  } else {
    location.reload();
  }
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

  dibujarDeposito();
}

// Marcador fijo del deposito, de donde salen los cadetes. No es parte de
// ninguna capa de zona: siempre visible, con icono propio. Se define en
// zonas.json -> "deposito" (nombre, direccion, lat, lng).
function dibujarDeposito() {
  const dep = STATE.zonas.deposito;
  if (!dep || typeof dep.lat !== "number" || typeof dep.lng !== "number") return;

  const icono = L.divIcon({
    className: "icono-deposito",
    html: `<div class="icono-deposito-pin"><span>📦</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 32],
    popupAnchor: [0, -30]
  });

  L.marker([dep.lat, dep.lng], { icon: icono, zIndexOffset: 1000 })
    .addTo(STATE.map)
    .bindPopup(`<div class="popup-barrio"><h3>${dep.nombre || "Depósito"}</h3>${dep.direccion ? `<div class="info-fila"><b>Dirección</b><span>${dep.direccion}</span></div>` : ""}</div>`);
}

/* ========================================================================= */
/* 6. RENDER DE ZONAS (pintado de barrios, con soporte de asignacion manual) */
/* ========================================================================= */

function colorZona(zona) {
  // El color de zona ahora es SIEMPRE el fijo del JSON — se usa para el borde
  // del poligono y para el panel de "Zonas", pero ya no para el relleno.
  return STATE.zonas.colores[zona] || "#999999";
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
  if ((STATE.zonas.barrios || {})[nombre]) return STATE.zonas.barrios[nombre];
  if ((STATE.zonas.puntos || {})[nombre]) return STATE.zonas.puntos[nombre].zona;
  return null;
}

// El cadete "por defecto" de una zona: el override temporal de una
// redistribucion activa ("Falta un cadete") si existe, si no el dueño normal
// de esa zona segun zonas.json.
function cadeteDeZona(zona) {
  if (!zona) return null;
  if (STATE.cadeteZonaEfectivo[zona]) return STATE.cadeteZonaEfectivo[zona];
  const cadetes = STATE.zonas.cadetes || {};
  for (const [nombre, datos] of Object.entries(cadetes)) {
    if (nombre.startsWith("_")) continue; // saltea comentarios
    if ((datos.zonas || []).includes(zona)) return nombre;
  }
  return null;
}

// El cadete real de un barrio puntual: gana la asignacion manual de ESE
// barrio (permanente, guardada); si no tiene, el cadete de su zona (que a su
// vez puede estar temporalmente redistribuido).
function cadeteDeBarrio(nombre) {
  const asignado = (STATE.zonas.asignaciones || {})[nombre];
  if (asignado) return asignado;
  return cadeteDeZona(zonaDeBarrio(nombre));
}

function tieneAsignacionManual(nombre) {
  return !!(STATE.zonas.asignaciones || {})[nombre];
}

function construirCapas() {
  // Reinicia cualquier redistribucion temporal que hubiera quedado de antes
  STATE.cadeteZonaEfectivo = {};

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

  construirCapasPuntos();
}

// Puntos sueltos (barrios de Canelones sin limite de municipio oficial
// propio, ver zonas.json -> "puntos"). Se dibujan como circulos chicos, con
// el mismo criterio de color que los barrios: relleno = cadete, borde = zona.
// Se agrupan por zona en un L.layerGroup para que se prendan/apaguen junto
// con el resto de esa zona en el panel "Zonas".
function construirCapasPuntos() {
  const puntos = STATE.zonas.puntos || {};
  const porZona = {};

  Object.entries(puntos).forEach(([nombre, info]) => {
    if (nombre.startsWith("_")) return;
    porZona[info.zona] = porZona[info.zona] || [];
    porZona[info.zona].push([nombre, info]);
  });

  Object.entries(porZona).forEach(([zona, lista]) => {
    const grupo = L.layerGroup();
    lista.forEach(([nombre, info]) => {
      const marker = crearMarcadorPunto(nombre, info);
      marker.addTo(grupo);
      STATE.featureLayerPorNombre[nombre] = marker; // asi el buscador tambien los encuentra
    });
    STATE.capasPuntosPorZona[zona] = grupo;
    if (STATE.zonasActivas.has(zona)) grupo.addTo(STATE.map);
  });
}

function crearMarcadorPunto(nombre, info) {
  const marker = L.circleMarker([info.lat, info.lng], estiloDePunto(nombre, info.zona));
  marker._puntoNombre = nombre; // para poder identificarlo despues (repintar, etc.)
  marker.on("click", () => {
    if (STATE.editMode) return; // el modo edicion (asignar a mano) por ahora solo aplica a barrios con poligono
    const cadete = cadeteDeBarrio(nombre);
    const manual = tieneAsignacionManual(nombre);
    const html = `
      <div class="popup-barrio">
        <h3>${nombre}</h3>
        <div class="info-fila"><b>Zona</b><span>Zona ${info.zona}</span></div>
        <div class="info-fila"><b>Cadete</b><span>${cadete || "Sin asignar"}${manual ? " (manual)" : ""}</span></div>
      </div>`;
    marker.bindPopup(html).openPopup();
    actualizarPanelInfo(nombre, info.zona, cadete, undefined, manual);
  });
  return marker;
}

function estiloDePunto(nombre, zona) {
  const cadete = cadeteDeBarrio(nombre); // respeta asignacion manual igual que un barrio con poligono
  return {
    radius: 7,
    weight: 2,
    color: shadeColor(colorZona(zona), -25),           // borde = color de zona
    fillColor: cadete ? colorDeCadete(cadete) : COLOR_SIN_CADETE, // relleno = cadete
    fillOpacity: 0.85
  };
}

/* --- contorno grueso de zona + etiqueta flotante (como el mapa de ML) ----- */
//
// Fusiona (con Turf.js) todos los barrios con poligono de una zona en una
// sola figura, y la dibuja como una linea gruesa por encima de los barrios
// (sin relleno, para no tapar los colores de los cadetes) mas una etiqueta
// "Zona N" flotante, igual que el mapa de Envios Flex de Mercado Libre.
// Si Turf.js no cargo (por ejemplo sin internet) esto simplemente no se
// dibuja, pero el resto del mapa sigue funcionando normal.
function construirContornosDeZona() {
  if (typeof turf === "undefined") {
    console.warn("Turf.js no cargó: se omiten los contornos de zona (el resto del mapa funciona igual).");
    return;
  }

  Object.keys(STATE.capasPorZona).forEach((zona) => {
    const featuresDeLaZona = STATE.geojsonBarrios.features.filter(
      (f) => zonaDeBarrio(nombreBarrio(f)) === zona
    );
    if (featuresDeLaZona.length === 0) return;

    // En vez de "coser" los poligonos unos con otros (turf.union), que en
    // formas irregulares puede fallar a mitad de camino y dejar barrios
    // afuera sin avisar, juntamos TODOS los vertices de TODOS los barrios
    // de la zona en una sola nube de puntos, y calculamos el contorno
    // envolvente (convex hull) de esa nube. Por definicion matematica, el
    // hull de los vertices de un poligono siempre contiene a ese poligono
    // entero — asi que ningun barrio puede quedar afuera del contorno.
    const puntos = [];
    featuresDeLaZona.forEach((f) => {
      try {
        turf.coordEach(f, (coord) => puntos.push(turf.point(coord)));
      } catch (err) {
        console.warn(`No se pudieron leer los vertices de ${nombreBarrio(f)} (zona ${zona})`, err);
      }
    });
    if (puntos.length < 3) return;

    let contorno;
    try {
      contorno = turf.convex(turf.featureCollection(puntos));
    } catch (err) {
      console.warn(`No se pudo calcular el contorno de zona ${zona}`, err);
      return;
    }
    if (!contorno) return;

    const grupo = L.layerGroup();

    L.geoJSON(contorno, {
      interactive: false, // que los clicks pasen a traves, hacia el barrio de abajo
      style: {
        color: colorZona(zona),
        weight: 3.5,
        opacity: 0.95,
        fill: false
      }
    }).addTo(grupo);

    let centro;
    try {
      centro = turf.pointOnFeature(contorno).geometry.coordinates; // garantiza un punto DENTRO de la figura
    } catch (_) {
      centro = null;
    }
    if (centro) {
      L.marker([centro[1], centro[0]], {
        icon: L.divIcon({
          className: "etiqueta-zona-wrap",
          html: `<div class="etiqueta-zona">Zona ${zona}</div>`,
          iconSize: null
        }),
        interactive: false
      }).addTo(grupo);
    }

    STATE.capasContornoPorZona[zona] = grupo;
    if (STATE.zonasActivas.has(zona)) grupo.addTo(STATE.map);
  });
}

// El color de fondo de cada barrio es SIEMPRE el del cadete que lo cubre
// (asignado a mano, o el dueño por defecto de su zona). El borde es SIEMPRE
// el color fijo de la zona geografica, para que se siga viendo la division
// por zonas aunque el reparto ese dia lo cubra otro cadete. Si el barrio
// tiene una asignacion manual (no sigue el reparto normal de su zona), el
// borde se dibuja punteado para que se note de un vistazo.
function estiloDeBarrio(nombre) {
  const zona = zonaDeBarrio(nombre);
  const cadete = cadeteDeBarrio(nombre);
  const esManual = tieneAsignacionManual(nombre);

  return Object.assign({}, CONFIG.estiloBase, {
    color: shadeColor(colorZona(zona), -25),   // borde = color fijo de la zona
    fillColor: cadete ? colorDeCadete(cadete) : COLOR_SIN_CADETE, // relleno = color del cadete
    weight: esManual ? 3 : 1.8,
    dashArray: esManual ? "5,4" : null
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
      layer.setStyle(estiloDeBarrio(nombre));
    });
  });
  Object.entries(STATE.capasPuntosPorZona).forEach(([zona, grupo]) => {
    grupo.eachLayer((marker) => {
      marker.setStyle(estiloDePunto(marker._puntoNombre, zona));
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
      <button class="cadete-editar" data-nombre="${nombre}" title="Editar nombre o color">
        <span class="cadete-swatch" style="background:${colorDeCadete(nombre)}"></span>
        <span class="cadete-nombre">${nombre}</span>
      </button>
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
  cont.querySelectorAll(".cadete-editar").forEach((btn) => {
    btn.addEventListener("click", () => abrirModalNuevoCadete(btn.dataset.nombre));
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

// Edita nombre y/o color de un cadete que ya existe. Si le cambia el nombre,
// actualiza en cadena todo lo que lo referenciaba: asignaciones manuales,
// reglas de redistribucion, y la redistribucion activa si estaba puesta.
function editarCadete(nombreViejo, nombreNuevo, colorNuevo) {
  nombreNuevo = nombreNuevo.trim();
  if (!nombreNuevo) {
    alert("Poné un nombre para el cadete.");
    return false;
  }
  if (nombreNuevo !== nombreViejo && STATE.zonas.cadetes[nombreNuevo]) {
    alert(`Ya existe un cadete llamado "${nombreNuevo}".`);
    return false;
  }

  const datos = STATE.zonas.cadetes[nombreViejo];
  if (nombreNuevo !== nombreViejo) {
    delete STATE.zonas.cadetes[nombreViejo];
    STATE.zonas.cadetes[nombreNuevo] = { zonas: datos.zonas || [], color: colorNuevo };

    Object.keys(STATE.zonas.asignaciones || {}).forEach((barrio) => {
      if (STATE.zonas.asignaciones[barrio] === nombreViejo) STATE.zonas.asignaciones[barrio] = nombreNuevo;
    });
    if (STATE.zonas.redistribucion && STATE.zonas.redistribucion[nombreViejo]) {
      STATE.zonas.redistribucion[nombreNuevo] = STATE.zonas.redistribucion[nombreViejo];
      delete STATE.zonas.redistribucion[nombreViejo];
    }
    if (STATE.redistribucionActiva === nombreViejo) STATE.redistribucionActiva = nombreNuevo;
  } else {
    datos.color = colorNuevo;
  }

  guardarCambiosLocales();
  renderCadetes();
  renderZonas();
  repintarTodo();
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
    const cantidadPuntos = STATE.capasPuntosPorZona[zona] ? STATE.capasPuntosPorZona[zona].getLayers().length : 0;
    const textoCantidad = cantidadPuntos > 0 ? `${cantidad} barrios + ${cantidadPuntos} puntos` : `${cantidad} barrios`;
    const chip = document.createElement("div");
    chip.className = "zona-chip";
    chip.dataset.zona = zona;
    chip.innerHTML = `
      <span class="zona-color-dot" style="background:${colorZona(zona)}"></span>
      <span class="zona-nombre">Zona ${zona}</span>
      <span class="zona-count">${textoCantidad}</span>
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
  const capaPuntos = STATE.capasPuntosPorZona[zona]; // puede no existir (zonas sin puntos sueltos)
  const capaContorno = STATE.capasContornoPorZona[zona]; // puede no existir si Turf.js no cargo
  if (STATE.zonasActivas.has(zona)) {
    if (capa) STATE.map.removeLayer(capa);
    if (capaPuntos) STATE.map.removeLayer(capaPuntos);
    if (capaContorno) STATE.map.removeLayer(capaContorno);
    STATE.zonasActivas.delete(zona);
    chipEl.classList.add("inactiva");
  } else {
    if (capa) capa.addTo(STATE.map);
    if (capaPuntos) capaPuntos.addTo(STATE.map);
    if (capaContorno) capaContorno.addTo(STATE.map);
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
      resultadosDiv.innerHTML = `<div class="resultado-item resultado-hint">Sin barrios que coincidan — presioná Enter para buscarlo como dirección exacta</div>`;
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

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      buscarDireccion(input.value.trim());
    }
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

/* --- buscador de direcciones (Nominatim / OpenStreetMap, gratis) --------- */
//
// No usamos la API de direcciones de Google: esta pagina no tiene servidor
// propio, y una clave de Google en el codigo quedaria visible para
// cualquiera que abra el link (riesgo de que usen tu clave y te facturen a
// vos). Nominatim es gratis y no necesita clave, a cambio de que solo se
// puede buscar por accion del usuario (Enter), no mientras escribe, para
// respetar su limite de uso (aprox. 1 busqueda por segundo).

async function buscarDireccion(texto) {
  const resultadosDiv = document.getElementById("buscador-resultados");
  if (!texto) return;

  const ahora = Date.now();
  if (STATE.ultimaBusquedaDireccion && ahora - STATE.ultimaBusquedaDireccion < 1200) {
    resultadosDiv.innerHTML = `<div class="resultado-item resultado-hint">Esperá un segundito y probá de nuevo…</div>`;
    resultadosDiv.classList.remove("oculto");
    return;
  }
  STATE.ultimaBusquedaDireccion = ahora;

  resultadosDiv.innerHTML = `<div class="resultado-item resultado-hint">Buscando dirección…</div>`;
  resultadosDiv.classList.remove("oculto");

  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=uy" +
    "&q=" + encodeURIComponent(texto + ", Uruguay");

  let resultados;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    resultados = await res.json();
  } catch (err) {
    resultadosDiv.innerHTML = `<div class="resultado-item resultado-hint">No se pudo buscar la dirección (¿sin internet?). Probá de nuevo.</div>`;
    return;
  }

  if (!resultados || resultados.length === 0) {
    resultadosDiv.innerHTML = `<div class="resultado-item resultado-hint">No encontramos esa dirección. Probá con más detalle (calle y número).</div>`;
    return;
  }

  resultadosDiv.classList.add("oculto");
  const { lat, lon, display_name } = resultados[0];
  ubicarDireccionEnMapa(parseFloat(lat), parseFloat(lon), display_name);
}

function ubicarDireccionEnMapa(lat, lon, direccionTexto) {
  if (STATE.marcadorDireccion) STATE.map.removeLayer(STATE.marcadorDireccion);

  const icono = L.divIcon({
    className: "icono-direccion",
    html: `<div class="icono-direccion-pin"><span>📍</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 32],
    popupAnchor: [0, -30]
  });
  STATE.marcadorDireccion = L.marker([lat, lon], { icon: icono, zIndexOffset: 900 }).addTo(STATE.map);

  STATE.map.setView([lat, lon], 16);

  const encontrado = barrioQueContienePunto(lat, lon);

  let html;
  if (encontrado) {
    const { nombre, zona, cadete, manual } = encontrado;
    html = `
      <div class="popup-barrio">
        <h3>📍 Dirección encontrada</h3>
        <div class="info-fila"><b>Barrio</b><span>${tituloCase(nombre)}</span></div>
        <div class="info-fila"><b>Zona</b><span>${zona ? "Zona " + zona : "—"}</span></div>
        <div class="info-fila"><b>Cadete</b><span>${cadete || "Sin asignar"}${manual ? " (manual)" : ""}</span></div>
      </div>`;
    actualizarPanelInfo(nombre, zona, cadete, undefined, manual);
  } else {
    html = `
      <div class="popup-barrio">
        <h3>📍 Dirección encontrada</h3>
        <p class="panel-hint" style="margin:0;">No cae dentro de ningún barrio cargado en el mapa todavía.</p>
      </div>`;
  }
  STATE.marcadorDireccion.bindPopup(html).openPopup();
}

// Point-in-polygon con Turf.js: recorre todas las capas de barrios (Montevideo
// + Canelones) y devuelve el primer barrio cuyo poligono contiene el punto.
function barrioQueContienePunto(lat, lon) {
  if (typeof turf === "undefined") return null;
  const punto = turf.point([lon, lat]);

  for (const zona of Object.keys(STATE.capasPorZona)) {
    let encontrado = null;
    STATE.capasPorZona[zona].eachLayer((layer) => {
      if (encontrado) return;
      try {
        if (turf.booleanPointInPolygon(punto, layer.feature)) {
          const nombre = nombreBarrio(layer.feature);
          encontrado = {
            nombre,
            zona,
            cadete: cadeteDeBarrio(nombre),
            manual: tieneAsignacionManual(nombre)
          };
        }
      } catch (_) {
        // geometria rara: la salteamos, no rompe la busqueda
      }
    });
    if (encontrado) return encontrado;
  }
  return null;
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
  STATE.cadeteZonaEfectivo = {};

  Object.entries(reglas).forEach(([zonaAfectada, zonaQueAbsorbe]) => {
    // La zona afectada pasa a mostrar como cadete al dueño por defecto de la
    // zona que la absorbe (el relleno de sus barrios ahora es el color de ESE cadete).
    const cadeteQueAbsorbe = cadeteDeZonaSinOverride(zonaQueAbsorbe);
    if (cadeteQueAbsorbe) STATE.cadeteZonaEfectivo[zonaAfectada] = cadeteQueAbsorbe;
  });

  STATE.redistribucionActiva = nombreCadete;
  repintarTodo();
  renderCadetes();
  renderZonas();

  const texto = Object.entries(reglas)
    .map(([z, absorbe]) => `Zona ${z} → cubierta por el cadete de Zona ${absorbe}`)
    .join(" · ");
  document.getElementById("redistribucion-texto").textContent = `${nombreCadete} ausente. ${texto}`;
  document.getElementById("redistribucion-activa").classList.remove("oculto");
}

// Dueño "de fabrica" de una zona segun zonas.json, ignorando cualquier
// redistribucion temporal activa (para no encadenar redistribuciones raras).
function cadeteDeZonaSinOverride(zona) {
  const cadetes = STATE.zonas.cadetes || {};
  for (const [nombre, datos] of Object.entries(cadetes)) {
    if (nombre.startsWith("_")) continue;
    if ((datos.zonas || []).includes(zona)) return nombre;
  }
  return null;
}

function restaurarZonasNormales() {
  STATE.redistribucionActiva = null;
  STATE.cadeteZonaEfectivo = {};
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

  btnAgregarCadete.addEventListener("click", () => abrirModalNuevoCadete());
  btnExportar.addEventListener("click", exportarZonasJSON);
  btnRestablecer.addEventListener("click", restablecerCambiosLocales);

  inicializarModalNuevoCadete();
  inicializarModalAsignarBarrio();
  inicializarModalAsignarZona();

  mostrarEstadoGuardado();
}

/* --- modal: nuevo cadete / editar cadete ---------------------------------- */

// nombreExistente = null -> se esta dando de alta un cadete nuevo.
// nombreExistente = "Damian" -> se esta editando el nombre/color de Damian.
function abrirModalNuevoCadete(nombreExistente) {
  STATE.cadeteEnEdicion = nombreExistente || null;
  const inputNombre = document.getElementById("input-nombre-cadete");
  const inputColor = document.getElementById("input-color-cadete");
  const titulo = document.getElementById("modal-nuevo-cadete-titulo");
  const btnGuardar = document.getElementById("btn-guardar-cadete");

  if (STATE.cadeteEnEdicion) {
    const datos = STATE.zonas.cadetes[STATE.cadeteEnEdicion] || {};
    inputNombre.value = STATE.cadeteEnEdicion;
    inputColor.value = datos.color || "#2f6fed";
    titulo.textContent = "Editar cadete";
    btnGuardar.textContent = "Guardar cambios";
  } else {
    inputNombre.value = "";
    inputColor.value = "#2f6fed";
    titulo.textContent = "Nuevo cadete";
    btnGuardar.textContent = "Agregar cadete";
  }

  document.getElementById("modal-nuevo-cadete").classList.remove("oculto");
  inputNombre.focus();
}

function inicializarModalNuevoCadete() {
  const modal = document.getElementById("modal-nuevo-cadete");
  const btnGuardar = document.getElementById("btn-guardar-cadete");
  const btnCancelar = document.getElementById("modal-nuevo-cadete-cancelar");

  btnGuardar.addEventListener("click", () => {
    const nombre = document.getElementById("input-nombre-cadete").value;
    const color = document.getElementById("input-color-cadete").value;
    const exito = STATE.cadeteEnEdicion
      ? editarCadete(STATE.cadeteEnEdicion, nombre, color)
      : agregarCadete(nombre, color);
    if (exito) modal.classList.add("oculto");
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
  const conPoligono = Object.keys(STATE.zonas.barrios || {}).filter(
    (nombre) => STATE.zonas.barrios[nombre] === zona
  );
  const sinPoligono = Object.keys(STATE.zonas.puntos || {}).filter(
    (nombre) => !nombre.startsWith("_") && (STATE.zonas.puntos[nombre] || {}).zona === zona
  );
  return conPoligono.concat(sinPoligono);
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
/* 13b. IMPRIMIR                                                             */
/* ========================================================================= */
//
// El panel lateral no sale en la version impresa (no tiene sentido en papel:
// botones, buscador, etc). En su lugar armamos una leyenda simple (colores
// de zona + colores de cadete) que solo se muestra al imprimir, para que la
// hoja siga siendo entendible sin la pantalla al lado.

function inicializarImprimir() {
  document.getElementById("btn-imprimir").addEventListener("click", () => {
    armarLeyendaImpresion();
    window.print();
  });
}

function armarLeyendaImpresion() {
  const cont = document.getElementById("leyenda-impresion-contenido");
  const cadetes = Object.keys(STATE.zonas.cadetes || {}).filter((k) => !k.startsWith("_"));

  // Para cada cadete, junto los nombres de TODOS los barrios que tiene
  // asignados ahora mismo (ya sea por su zona por defecto, o a mano) —
  // recorriendo tanto barrios con poligono como los "puntos" sueltos.
  const barriosDeCadete = {};
  cadetes.forEach((c) => (barriosDeCadete[c] = []));

  const todosLosNombres = [
    ...Object.keys(STATE.zonas.barrios || {}).filter((n) => !n.startsWith("_")),
    ...Object.keys(STATE.zonas.puntos || {}).filter((n) => !n.startsWith("_"))
  ];
  todosLosNombres.forEach((nombre) => {
    const cadete = cadeteDeBarrio(nombre);
    if (cadete && barriosDeCadete[cadete]) barriosDeCadete[cadete].push(tituloCase(nombre));
  });

  const filasCadetes = cadetes
    .map((nombre) => {
      const barrios = barriosDeCadete[nombre].sort().join(", ") || "sin barrios asignados";
      return `<div class="leyenda-impresion-fila">
        <span class="leyenda-impresion-dot" style="background:${colorDeCadete(nombre)}"></span>
        <span><b>${nombre}</b>: ${barrios}</span>
      </div>`;
    })
    .join("");

  cont.innerHTML = `
    <div class="leyenda-impresion-grupo">
      <h3>Cadetes</h3>
      ${filasCadetes || "<p>Sin cadetes cargados.</p>"}
    </div>
  `;
  document.getElementById("leyenda-impresion-titulo").textContent =
    "Zonas de Reparto — impreso " + new Date().toLocaleDateString("es-UY");
}

/* ========================================================================= */
/* 14. ARRANQUE                                                              */
/* ========================================================================= */

async function iniciarApp() {
  await cargarDatos();
  inicializarMapa();
  construirCapas();
  construirContornosDeZona();
  renderCadetes();
  renderZonas();
  inicializarBuscador();
  inicializarRedistribucion();
  inicializarModoEdicion();
  inicializarPanelMovil();
  inicializarImprimir();
}

document.addEventListener("DOMContentLoaded", iniciarApp);
