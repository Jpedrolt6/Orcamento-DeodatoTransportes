// ===================== Estado principal =====================
let origemPlace = null;
let destinoPlace = null;

// ===== Config — seu número do Whats =====
const WHATS_NUM = "5511983297840"; // DDI+DDD+NÚMERO, só dígitos

// ===== Estado das paradas =====
let paradasPlaces = [];
let contadorParadas = 0;

// ===== Economia: parâmetros ajustáveis =====
const MIN_CHARS       = 3;
const DEBOUNCE_MS     = 100;   // responsivo e econômico
const MAX_PREDICTIONS = 8;
const MIN_SUGGESTIONS = 1;
const COUNTRY_CODE    = "br";
const CACHE_TTL_MS    = 3 * 60 * 1000; // 3min

// ===== Caches locais =====
const predCache    = new Map();
const detailsCache = new Map();

// ===== Flag do último orçamento (para limpar endereços ao trocar Baú/Food) =====
let lastQuote = { hasQuote: false, servico: null, motoTipo: null };

// ===== Utils =====
const fmtBRL = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Bloqueia UI nativa de validação (evita tranco)
document.addEventListener('invalid', (e) => e.preventDefault(), true);

// Evita Enter dentro de input causar submit fantasma
function bloquearEnter(el) {
  if (!el) return;
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') ev.preventDefault();
  });
}
function aplicarBloqueioNosCamposBasicos() {
  bloquearEnter(document.getElementById('origem'));
  bloquearEnter(document.getElementById('destino'));
}

// Detector de número de rua
function hasStreetNumber(text) {
  const s = String(text || "");
  const padraoSimples = /(?:,\s*|\s+)\d{1,5}(?!-)\b/;
  const padraoAbrev   = /\b(n[ºo]?|nro\.?|num\.?)\s*\d{1,5}\b/i;
  return padraoSimples.test(s) || padraoAbrev.test(s);
}

// ---------------------------------------------------------------------------
//               🔖 Favoritos simples (localStorage, sem visual extra)
// ---------------------------------------------------------------------------
const FAV_KEY = "favAddrV1";

const Favorites = {
  _list: [],

  _load() {
    try { this._list = JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
    catch { this._list = []; }
  },

  _save() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(this._list)); } catch {}
  },

  _norm(s) {
    return String(s || "").trim().toLowerCase();
  },

  addFromPlace(place) {
    if (!place?.formatted_address) return;
    const addr = place.formatted_address;
    const lat = place?.geometry?.location?.lat ?? place?.geometry?.location?.latitude;
    const lng = place?.geometry?.location?.lng ?? place?.geometry?.location?.longitude;
    if (lat == null || lng == null) return;

    this._load();
    const key = this._norm(addr);
    const i = this._list.findIndex(x => this._norm(x.addr) === key);
    if (i >= 0) {
      this._list[i].count = (this._list[i].count || 0) + 1;
      this._list[i].last  = Date.now();
      this._list[i].lat   = lat;
      this._list[i].lng   = lng;
    } else {
      this._list.push({ addr, lat, lng, count: 1, last: Date.now() });
    }
    // mantém lista enxuta
    this._list.sort((a,b)=> (b.count-a.count) || (b.last-a.last));
    if (this._list.length > 50) this._list.length = 50;
    this._save();
  },

  // retorna sugestões no formato da autocomplete (com flag favPlace)
  matches(query = "", limit = 5) {
    this._load();
    const q = this._norm(query);
    const arr = q
      ? this._list.filter(x => this._norm(x.addr).includes(q))
      : this._list.slice();
    arr.sort((a,b)=> (b.count-a.count) || (b.last-a.last));
    const top = arr.slice(0, limit);
    return top.map((rec, idx) => {
      const parts = rec.addr.split(", ");
      const main  = parts.shift() || rec.addr;
      const sec   = parts.join(", ");
      return {
        description: rec.addr,
        structured_formatting: { main_text: main, secondary_text: sec },
        place_id: "fav:" + idx + ":" + rec.last, // id único o suficiente
        favPlace: {
          formatted_address: rec.addr,
          geometry: { location: { lat: rec.lat, lng: rec.lng } }
        }
      };
    });
  }
};

// ---------------------------------------------------------------------------
//                        Places API (New) – REST
// ---------------------------------------------------------------------------
const PLACES_API_KEY = "AIzaSyAhGvrR_Gp4e0ROB1BInjNBSUQdHEh6ews";
const PLACES_BASE = "https://places.googleapis.com/v1";

const SP_CENTER = { latitude: -23.55052, longitude: -46.633308 };
const SP_BIAS   = { circle: { center: SP_CENTER, radius: 50000 } };

const FM_AUTOCOMPLETE = [
  "suggestions.placePrediction.placeId",
  "suggestions.placePrediction.text",
  "suggestions.structuredFormat.mainText",
  "suggestions.structuredFormat.secondaryText"
].join(",");
const FM_DETAILS = ["id","displayName","formattedAddress","location"].join(",");
const FM_SEARCH  = ["places.id","places.displayName","places.formattedAddress","places.location"].join(",");

function newSessionToken() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return "tok-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}
function newHeaders(fieldMask, sessionToken) {
  const h = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": PLACES_API_KEY,
    "X-Goog-FieldMask": fieldMask
  };
  if (sessionToken) h["X-Goog-Session-Token"] = sessionToken;
  return h;
}

function normalizeNewSuggestions(resp) {
  const out = [];
  const list = resp?.suggestions || [];
  for (const s of list) {
    const p  = s.placePrediction || {};
    const sf = s.structuredFormat || {};
    const main = typeof sf.mainText === "object" ? (sf.mainText?.text || "") : (sf.mainText || "");
    const secondary = typeof sf.secondaryText === "object" ? (sf.secondaryText?.text || "") : (sf.secondaryText || "");
    const description = [main, secondary].filter(Boolean).join(", ") || (p.text?.text || p.text || "");
    if (!p.placeId) continue;
    out.push({
      description,
      structured_formatting: { main_text: main || description, secondary_text: secondary || "" },
      place_id: p.placeId
    });
  }
  return out;
}
function normalizeSearchToSuggestions(resp) {
  const arr = resp?.places || [];
  return arr.slice(0, 10).map((pl) => {
    const main = pl?.displayName?.text || "";
    const secondary = pl?.formattedAddress || "";
    return {
      description: [main, secondary].filter(Boolean).join(", "),
      structured_formatting: { main_text: main || secondary, secondary_text: secondary ? (main ? secondary : "") : "" },
      place_id: pl?.id || ""
    };
  }).filter(x => x.place_id);
}

let _acAborter = null;
async function placesNewAutocomplete({ input, sessionToken, region = "br", language = "pt-BR" }) {
  try {
    if (_acAborter) _acAborter.abort();
    _acAborter = new AbortController();

    const body = {
      input,
      languageCode: language,
      regionCode: region,
      includeQueryPredictions: true,
      locationBias: SP_BIAS
    };

    const res = await fetch(`${PLACES_BASE}/places:autocomplete`, {
      method: "POST",
      headers: newHeaders(FM_AUTOCOMPLETE, sessionToken),
      body: JSON.stringify(body),
      signal: _acAborter.signal
    });
    if (!res.ok) throw new Error("Autocomplete falhou: " + res.status);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") return { suggestions: [] };
    return { suggestions: [] };
  }
}

async function placesNewSearchText(textQuery, language = "pt-BR") {
  try {
    const res = await fetch(`${PLACES_BASE}/places:searchText`, {
      method: "POST",
      headers: newHeaders(FM_SEARCH),
      body: JSON.stringify({
        textQuery,
        languageCode: language,
        locationBias: SP_BIAS
      })
    });
    if (!res.ok) throw new Error("SearchText falhou: " + res.status);
    return await res.json();
  } catch {
    return { places: [] };
  }
}

async function placesNewDetails(placeId, language = "pt-BR") {
  const url = `${PLACES_BASE}/places/${encodeURIComponent(placeId)}?languageCode=${encodeURIComponent(language)}`;
  const res = await fetch(url, { headers: newHeaders(FM_DETAILS) });
  if (!res.ok) throw new Error("Details falhou: " + res.status);
  const data = await res.json();

  const lat = data?.location?.latitude;
  const lng = data?.location?.longitude;
  const formatted = data?.formattedAddress || data?.displayName?.text || "";

  return {
    formatted_address: formatted,
    geometry: { location: (lat != null && lng != null) ? { lat, lng } : null }
  };
}
// ---------------------------------------------------------------------------

// ---------- Regras de preço ----------
function calcularPrecoMotoBau(kmInt, qtdParadas, pedagio = 0) {
  let base = 0;
  if (kmInt <= 5) base = 40;
  else if (kmInt <= 12) base = 45;
  else if (kmInt <= 15) base = 50;
  else if (kmInt <= 80) base = 20 + (2 * kmInt);
  else base = 180 + (kmInt - 80) * 3;

  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 5;
  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}

function calcularPrecoMotoFood(kmInt, qtdParadas, pedagio = 0) {
  let base = 0;
  if (kmInt <= 5) base = 45;
  else if (kmInt <= 12) base = 50;
  else if (kmInt <= 16) base = 55;
  else if (kmInt <= 80) base = 30 + (2 * kmInt);
  else base = 190 + (kmInt - 80) * 3;

  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 5;
  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}

function calcularPrecoCarro(kmInt, qtdParadas, pedagio = 0) {
  let base = 0;
  if (kmInt <= 12) base = 100;
  else if (kmInt <= 19) base = 110;
  else if (kmInt <= 33) base = 130;
  else if (kmInt <= 69) base = 4.0 * kmInt;
  else base = 276 + (kmInt - 69) * 4.5;
  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 10;
  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}

// ---------- Utilitário p/ degrau 0–30 km ----------
function tarifaDegrau(kmInt, ate30Valor, pos30PorKm){
  const k = Math.max(0, Number(kmInt) || 0);
  if (k <= 30) return ate30Valor;
  return ate30Valor + pos30PorKm * (k - 30);
}

// ---------- Fiorino ----------
function calcularPrecoFiorino(kmInt, qtdParadas = 0, pedagio = 0){
  const base = tarifaDegrau(kmInt, 190, 4);
  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 10; // segue padrão do carro
  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}

// ---------- HR / Ducato ----------
function calcularPrecoHRDucato(kmInt, qtdParadas = 0, pedagio = 0){
  const base = tarifaDegrau(kmInt, 290, 5);
  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 20;
  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}

// ---------- Iveco / Master ----------
function calcularPrecoIvecoMaster(kmInt, qtdParadas = 0, pedagio = 0){
  const base = tarifaDegrau(kmInt, 360, 5);
  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 20;
  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}

// ---------- Observação FOOD ----------
function setFoodInfo(show) {
  const resumo = document.getElementById('resumo');
  if (!resumo) return;
  let info = document.getElementById('foodInfo');
  if (!info) {
    info = document.createElement('div');
    info.id = 'foodInfo';
    info.setAttribute('aria-live', 'polite');
    info.style.cssText = 'padding:12px 14px;border:1px solid #2a3342;background:#0d131b;border-radius:12px;color:#cfe3ff;font-size:13px;line-height:1.35;margin-top:6px;';
    info.innerHTML = `
      <div style="font-weight:700; margin-bottom:6px;">Observação — FOOD</div>
      <div>Serviços de alimentação têm valores diferenciados devido à espera em restaurantes e ao maior risco de avarias no transporte em mochila térmica.</div>
    `;
    const btnLimpar = document.getElementById('btnLimpar');
    resumo.insertBefore(info, btnLimpar);
  }
  info.style.display = show ? '' : 'none';
}

// ---------- Monta mensagem WhatsApp ----------
function montarMensagem(origem, destino, kmInt, valor, servicoTxt, paradasList = [], extraObs = "") {
  const linhas = ["*RETIRADA*","📍 " + origem,""];
  if (paradasList.length) {
    paradasList.forEach((p, i) => {
      const end = p?.formatted_address || p?.description || "";
      if (end) linhas.push(`*PARADA ${i + 1}*`, "📍 " + end, "");
    });
  }
  linhas.push("*ENTREGA*", "📍 " + destino, "", `*Tipo de veículo:* ${servicoTxt}`);
  if (extraObs) linhas.push(extraObs);
  linhas.push("", "🛣️ Km " + kmInt, "💵 " + fmtBRL(valor));
  return encodeURIComponent(linhas.join("\n"));
} 

// ===================== debounce =====================
function debounce(fn, wait = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// ===================== geocode fallback =====================
function geocodeByText(texto) {
  return new Promise((resolve) => {
    if (!texto || !window.google || !google.maps?.Geocoder) return resolve(null);
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode(
      { address: texto, componentRestrictions: { country: COUNTRY_CODE } },
      (res, status) => {
        if (status === "OK" && res?.[0]?.geometry?.location) {
          const loc = res[0].geometry.location;
          const lat = typeof loc.lat === "function" ? loc.lat() : (loc?.lat ?? null);
          const lng = typeof loc.lng === "function" ? loc.lng() : (loc?.lng ?? null);
          resolve({
            formatted_address: res[0].formatted_address,
            geometry: { location: (lat != null && lng != null) ? { lat, lng } : loc }
          });
        } else {
          resolve(null);
        }
      }
    );
  });
}

// ===== Pill “Adicionar número”
function showAddNumeroHint(inputEl) {
  if (!inputEl) return;
  const container = (inputEl.closest(".field") || inputEl.parentElement || document.body);

  if (container.querySelector(".add-num-pill-js") && !hasStreetNumber(inputEl.value)) return;
  if (hasStreetNumber(inputEl.value)) {
    container.querySelector(".add-num-pill-js")?.remove();
    return;
  }

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "add-num-pill-js";
  pill.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="margin-right:2px">
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    Adicionar número
  `;

  pill.addEventListener("click", () => {
    if (!/,\s*$/.test(inputEl.value)) inputEl.value = inputEl.value.replace(/\s+$/, "") + ", ";
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  });

  const removeIfHasNumber = () => { if (hasStreetNumber(inputEl.value)) pill.remove(); };
  inputEl.addEventListener("input", removeIfHasNumber, { once: false });

  container.appendChild(pill);
}

// ===================== Autocomplete (Places New) + Favoritos =====================
function setupInputAutocomplete({ inputEl, onPlaceChosen }) {
  if (!window.google) return;

  let sessionToken = newSessionToken();
  let activeIndex  = -1;

  // caixinha de sugestões
  const list = document.createElement("div");
  list.className = "suggestions";
  Object.assign(list.style, {
    position: "absolute",
    zIndex: "9999",
    background: "#0b0f14",
    border: "1px solid #1d2634",
    borderRadius: "12px",
    padding: "6px",
    boxShadow: "0 10px 24px rgba(0,0,0,.35)",
    display: "none",
  });
  document.body.appendChild(list);

  function positionList() {
    const r = inputEl.getBoundingClientRect();
    list.style.left  = `${r.left + window.scrollX}px`;
    list.style.top   = `${r.bottom + window.scrollY + 6}px`;
    list.style.width = `${r.width}px`;
  }
  window.addEventListener("resize", positionList);
  window.addEventListener("scroll", positionList, true);
  inputEl.addEventListener("focus", positionList);

  const hideList = () => { list.style.display = "none"; list.innerHTML = ""; activeIndex = -1; };
  const showList = () => { list.style.display = "block"; };

  function renderPredictions(preds) {
    list.innerHTML = "";
    activeIndex = -1;
    if (!preds || !preds.length) { hideList(); return; }

    preds.slice(0, MAX_PREDICTIONS).forEach((p) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "suggestions__item";
      Object.assign(item.style, {
        width: "100%",
        textAlign: "left",
        padding: "10px 12px",
        border: "0",
        borderRadius: "10px",
        background: "transparent",
        color: "#e9eef7",
        cursor: "pointer",
        fontFamily: "inherit",
      });

      const mainText = p.structured_formatting?.main_text || p.description || "";
      const secondaryText = p.structured_formatting?.secondary_text || "";

      item.innerHTML = `
        <div style="font-weight:600;display:flex;align-items:center;gap:8px">
          <span class="suggestions__main">${mainText}</span>
        </div>
        <div class="suggestions__sec" style="font-size:12px;color:#a9b2c3">${secondaryText || ""}</div>
      `;

      item.addEventListener("click", async () => {
        const finish = (place) => {
          inputEl.value = place.formatted_address || p.description;
          clearInvalid(inputEl);
          if (!hasStreetNumber(inputEl.value)) showAddNumeroHint(inputEl);

          hideList();
          sessionToken = newSessionToken();

          // 🔖 salva favorito
          Favorites.addFromPlace(place);

          try { onPlaceChosen && onPlaceChosen(place); } catch {}
        };

        // Se veio de favorito, já temos lat/lng → não chama Details
        if (p.favPlace) {
          finish(p.favPlace);
          return;
        }

        const cached = detailsCache.get(p.place_id);
        const fresh  = cached && (Date.now() - cached.ts < CACHE_TTL_MS) ? cached.place : null;
        if (fresh) { finish(fresh); return; }

        try {
          const place = await placesNewDetails(p.place_id, "pt-BR");
          if (place?.geometry?.location) {
            detailsCache.set(p.place_id, { ts: Date.now(), place });
            finish(place);
          } else {
            hideList();
          }
        } catch {
          hideList();
        }
      });

      list.appendChild(item);
    });
    showList();
    positionList();
  }

  // monta lista: favoritos (se houver) + predictions do Google
  async function buildAndRender(query) {
    const favs = Favorites.matches(query, 5);
    let norm = [];

    const q = (query || "").trim();
    if (q.length >= MIN_CHARS) {
      const cached = predCache.get(q);
      if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
        norm = cached.predictions;
      } else {
        try {
          const data = await placesNewAutocomplete({
            input: q,
            sessionToken,
            region: COUNTRY_CODE,
            language: "pt-BR"
          });
          norm = normalizeNewSuggestions(data);

          if (!norm.length || norm.length < MIN_SUGGESTIONS) {
            try {
              const st = await placesNewSearchText(q, "pt-BR");
              const extra = normalizeSearchToSuggestions(st);
              const seen = new Set(norm.map(x => x.place_id));
              for (const e of extra) if (!seen.has(e.place_id)) norm.push(e);
            } catch {/* noop */}
          }

          predCache.set(q, { ts: Date.now(), predictions: norm });
        } catch {
          norm = [];
        }
      }
    }

    // merge: favoritos + Google, sem duplicar endereços iguais
    const seenAddr = new Set();
    const merged = [];
    for (const a of favs) {
      const key = (a.description || "").toLowerCase();
      if (!seenAddr.has(key)) { merged.push(a); seenAddr.add(key); }
    }
    for (const a of norm) {
      const key = (a.description || "").toLowerCase();
      if (!seenAddr.has(key)) { merged.push(a); seenAddr.add(key); }
    }

    renderPredictions(merged);
  }

  const requestPredictions = debounce(() => {
    buildAndRender(inputEl.value);
  }, DEBOUNCE_MS);

  inputEl.addEventListener("focus", () => {
    positionList();
    const v = inputEl.value.trim();
    if (!v) {
      const favs = Favorites.matches("", 8);
      if (favs.length) renderPredictions(favs);
    }
  });

  // Navegação via teclado
  inputEl.addEventListener("keydown", (ev) => {
    const items = list.querySelectorAll("button.suggestions__item");
    if (ev.key === "ArrowDown" && items.length) {
      ev.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      items.forEach((btn, i) => btn.classList.toggle("active", i === activeIndex));
      items[activeIndex].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "ArrowUp" && items.length) {
      ev.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      items.forEach((btn, i) => btn.classList.toggle("active", i === activeIndex));
      items[activeIndex].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter" && items.length) {
      ev.preventDefault();
      if (activeIndex >= 0) items[activeIndex].click();
      else items[0].click();
    } else if (ev.key === "Escape") {
      hideList();
    }
  });

  // Clique antes do blur
  document.addEventListener('pointerdown', (ev) => {
    const btn = ev.target?.closest?.('.suggestions__item');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    try { btn.click(); } catch {}
  }, true);

  inputEl.addEventListener("input", () => {
    requestPredictions();
    clearInvalid(inputEl);

    if (inputEl.id === 'origem') origemPlace = null;
    else if (inputEl.id === 'destino') destinoPlace = null;
    else if (inputEl.id?.startsWith('parada-')) {
      const idx = Number(inputEl.id.split('-')[1] || 0);
      paradasPlaces[idx] = null;
    }
  });
  inputEl.addEventListener("blur", () => setTimeout(hideList, 150));
}

// ===================== Injeta seletor “Tipo de Moto” =====================
function ensureMotoTipoControl() {
  if (document.getElementById('motoTipo')) return;

  const row = document.querySelector('.row');
  if (!row) return;

  const field = document.createElement("div");
  field.className = "field small";
  field.id = "motoTipoRow";
  field.style.display = "none"; // escondido até escolher “Motoboy”
  field.innerHTML = `
    <label for="motoTipo">Tipo de Moto</label>
    <select id="motoTipo">
      <option value="">Selecione…</option>
      <option value="bau">Baú</option>
      <option value="food">FOOD (mochila termica)</option>
    </select>
  `;
  const servField = document.getElementById('servico')?.closest('.field');
  if (servField && servField.parentElement === row) servField.after(field);
  else row.appendChild(field);
}

// ===================== Autocomplete nos campos =====================
function configurarAutocomplete() {
  if (!window.google) return;

  const origemInput  = document.getElementById("origem");
  const destinoInput = document.getElementById("destino");

  aplicarBloqueioNosCamposBasicos();

  setupInputAutocomplete({
    inputEl: origemInput,
    onPlaceChosen: (place) => { origemPlace = place; }
  });
  setupInputAutocomplete({
    inputEl: destinoInput,
    onPlaceChosen: (place) => { destinoPlace = place; }
  });

  const btnAddParada = document.getElementById("btnAddParada");
  btnAddParada.addEventListener("click", () => adicionarParadaInput());
}

// ===================== Cria inputs de parada =====================
function adicionarParadaInput() {
  const container = document.getElementById("paradas");
  const idx = contadorParadas++;

  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `
    <label for="parada-${idx}">Parada ${idx + 1}</label>
    <input id="parada-${idx}" type="text" placeholder="Digite o endereço da parada" autocomplete="off" />
  `;
  container.appendChild(wrap);

  const input = document.getElementById(`parada-${idx}`);
  bloquearEnter(input);

  setupInputAutocomplete({
    inputEl: input,
    onPlaceChosen: (place) => { paradasPlaces[idx] = place; }
  });
}

// ===================== Regras do serviço (UI dinâmica) =====================
function hideRules() {
  const rules = document.querySelector('.rules');
  if (!rules) return;
  const ul = rules.querySelector('ul');
  if (ul) ul.innerHTML = "";
  rules.style.display = 'none';
  setFoodInfo(false);
}
function showRules(htmlList) {
  const rules = document.querySelector('.rules');
  if (!rules) return;
  const ul = rules.querySelector('ul');
  if (!ul) return;
  ul.innerHTML = htmlList;
  rules.style.display = '';
}

function updateRules() {
  const servicoSel  = document.getElementById("servico");
  const motoTipoSel = document.getElementById("motoTipo");
  const motoTipoRow = document.getElementById("motoTipoRow");

  const servico = servicoSel?.value || "";

  // mostra/oculta seletor de tipo de moto
  if (motoTipoRow) motoTipoRow.style.display = (servico === "moto") ? "" : "none";

  if (servico === "carro") {
    showRules(`
      <li>Ideal para caixas pequenas e médias, acima da capacidade da moto</li>
      <li>Espera: R$ 0,70/min após 20 min</li>
    `);
    setFoodInfo(false);
    return;
  }

  if (servico === "moto") {
    const tipo = motoTipoSel?.value || "";
    if (tipo === "food") {
      showRules(`
        <li>Mochila térmica</li>
        <li>Ideal para entregas de alimentos</li>
        <li>Peso máx.: 20 kg</li>
        <li>Espera: R$ 0,60/min após 20 min</li>
      `);
      setFoodInfo(true);
    } else if (tipo === "bau") {
      showRules(`
        <li>Baú máx.: 44 × 42 × 32 cm</li>
        <li>Peso máx.: 20 kg</li>
        <li>Ideal para documentos, eletrônicos, roupas e pequenas encomendas</li>
        <li>Espera: R$ 0,60/min após 15 min</li>
      `);
      setFoodInfo(false);
    } else {
      hideRules(); // não escolheu o tipo ainda
    }
    return;
  }

  if (servico === "fiorino") {
    showRules(`
      <li>Ideal para cargas fracionadas de medio porte</li>
      <li>Melhor custo-benefício para cargas de até 600 kg</li>
      <li>Dimensões máx.: 1,35 m alt. × 1,10 m larg. × 1,85 m comp.</li>
      <li>Peso máx.: 600 kg</li>
      <li>Picapes: Ideal para cargas alongadas (ex.: tubos, barras, perfis metálicos)</li>
      <li> Espera: R$ 0,80/min após 20 min</li>
    `);
    return;
  }

  if (servico === "hr_ducato") {
    showRules(`
      <li>Pequeno caminhão / Ideal para cargas volumosas em quantidade intermediária</li>
      <li>Ideal para mudanças pequenas e cargas maiores</li>
      <li>Dimensões máx.: 1,90 m alt. × 1,40 m larg. × 2,50 m comp.</li>
      <li>Peso máx.: 1500 kg</li>
      <li> Espera: R$ 1,20/min após 30 min</li>
    `);
    return;
  }

  if (servico === "iveco_master") {
    showRules(`
      <li>Ideal para operações maiores em centros urbanos com restrição de caminhões</li>
      <li>Transporte de cargas paletizadas</li>
      <li>Capacidade volumétrica 10-15 m³</li>
      <li>Peso max.: 2300 kg</li>
      <li> Espera: R$ 1,20/min após 30 min</li>
    `);
    return;
  }

  hideRules();
}

// ===================== Botão Whats — helpers =====================
function getBtnWhats() {
  return document.getElementById("btnWhats");
}

function esconderWhats() {
  const btnWhats = getBtnWhats();
  if (!btnWhats) return;
  btnWhats.classList.add("hide");
  btnWhats.classList.remove("show", "wpp-attention");
  btnWhats.setAttribute("aria-disabled", "true");
  btnWhats.setAttribute("tabindex", "-1");
  btnWhats.href = "#";
}

function mostrarWhats() {
  const btnWhats = getBtnWhats();
  if (!btnWhats) return;
  btnWhats.classList.remove("hide");
  btnWhats.classList.add("show");
  btnWhats.setAttribute("aria-disabled", "false");
  btnWhats.removeAttribute("tabindex");
}

function scrollToWhats() {
  const btnWhats = getBtnWhats();
  if (!btnWhats) return;
  const y = btnWhats.getBoundingClientRect().top + window.scrollY - 80;
  window.scrollTo({ top: y, behavior: 'smooth' });
}

// injeta CSS da animação (caso não exista no seu CSS)
(function injectWppAttentionCSS(){
  if (document.getElementById('wpp-attention-style')) return;
  const css = `
  @keyframes wpp-wobble {
    0% { transform: translateX(0) rotate(0deg); }
    10% { transform: translateX(-4px) rotate(-2deg); }
    20% { transform: translateX(4px) rotate(2deg); }
    30% { transform: translateX(-6px) rotate(-3deg); }
    40% { transform: translateX(6px) rotate(3deg); }
    50% { transform: translateX(-4px) rotate(-2deg); }
    60% { transform: translateX(4px) rotate(2deg); }
    70% { transform: translateX(-3px) rotate(-1.5deg); }
    80% { transform: translateX(3px) rotate(1.5deg); }
    90% { transform: translateX(-2px) rotate(-1deg); }
    100% { transform: translateX(0) rotate(0deg); }
  }
  .wpp-attention {
    animation: wpp-wobble 0.9s ease both;
  }`;
  const style = document.createElement('style');
  style.id = 'wpp-attention-style';
  style.textContent = css;
  document.head.appendChild(style);
})();

function pulseWhats() {
  const btnWhats = getBtnWhats();
  if (!btnWhats) return;
  btnWhats.classList.remove('wpp-attention');
  void btnWhats.offsetWidth; // reflow
  btnWhats.classList.add('wpp-attention');
  try { if (navigator.vibrate) navigator.vibrate([80, 60, 80, 60, 120, 60, 80]); } catch {}
}

// vibra também se o usuário tocar no botão
document.addEventListener('pointerdown', (ev) => {
  const btn = ev.target?.closest?.('#btnWhats');
  if (!btn) return;
  try { if (navigator.vibrate) navigator.vibrate([40, 40, 80]); } catch {}
}, { passive: true });

// ===================== Limpa só os endereços (para troca Baú/Food pós-orçamento) =====================
function limparEnderecosInputs() {
  const origemInput  = document.getElementById("origem");
  const destinoInput = document.getElementById("destino");
  if (origemInput) origemInput.value = "";
  if (destinoInput) destinoInput.value = "";

  origemPlace = null;
  destinoPlace = null;

  const contParadas = document.getElementById("paradas");
  if (contParadas) contParadas.innerHTML = "";
  paradasPlaces = [];
  contadorParadas = 0;

  const mDistEl  = document.getElementById("mDist");
  const mValorEl = document.getElementById("mValor");
  if (mDistEl)  mDistEl.textContent = "—";
  if (mValorEl) mValorEl.textContent = "—";

  esconderWhats();

  clearInvalid(document.getElementById('origem'));
  clearInvalid(document.getElementById('destino'));
  document.querySelectorAll('[id^="parada-"]').forEach(clearInvalid);
  document.querySelectorAll(".add-num-pill-js").forEach(el => el.remove());
}

// ===================== Cálculo e UI =====================
function configurarEventos() {
  ensureMotoTipoControl(); // injeta o seletor de tipo de moto

  const btnCalcular = document.getElementById("btnCalcular");
  const btnWhats    = document.getElementById("btnWhats");
  const btnLimpar   = document.getElementById("btnLimpar");
  const mDistEl     = document.getElementById("mDist");
  const mValorEl    = document.getElementById("mValor");
  const servicoSel  = document.getElementById("servico");
  const motoTipoSel = document.getElementById("motoTipo");

  esconderWhats();

  // atualizar regras ao trocar serviço/tipo
  if (servicoSel) servicoSel.addEventListener("change", () => {
    updateRules();
    if (servicoSel.value !== "moto") clearInvalid(document.getElementById("motoTipo"));
  });

  if (motoTipoSel) {
    motoTipoSel.addEventListener("change", () => {
      updateRules();

      const novoTipo = motoTipoSel.value || "";
      if (
        lastQuote.hasQuote &&
        lastQuote.servico === "moto" &&
        lastQuote.motoTipo &&
        novoTipo &&
        novoTipo !== lastQuote.motoTipo
      ) {
        limparEnderecosInputs();
        lastQuote = { hasQuote: false, servico: null, motoTipo: null };
      }
    });
  }

  btnWhats?.addEventListener("click", (e)=>{
    if (btnWhats.getAttribute("aria-disabled") === "true") e.preventDefault();
  });

  btnLimpar?.addEventListener("click", () => {
    const origemInput  = document.getElementById("origem");
    const destinoInput = document.getElementById("destino");
    const motoTipoSel  = document.getElementById("motoTipo");
    if (origemInput) origemInput.value = "";
    if (destinoInput) destinoInput.value = "";
    if (motoTipoSel) motoTipoSel.selectedIndex = 0;

    origemPlace = null;
    destinoPlace = null;

    const contParadas = document.getElementById("paradas");
    if (contParadas) contParadas.innerHTML = "";
    paradasPlaces = [];
    contadorParadas = 0;

    if (mDistEl)  mDistEl.textContent  = "—";
    if (mValorEl) mValorEl.textContent = "—";

    document.querySelectorAll(".add-num-pill-js").forEach(el => el.remove());

    esconderWhats();
    origemInput?.focus();

    updateRules();
    lastQuote = { hasQuote: false, servico: null, motoTipo: null };
  });

  btnCalcular?.addEventListener("click", async (e) => {
    e.preventDefault();

    // ====== Validação coletiva ======
    let anyError = false;

    // 1) Validar tipo de moto quando serviço = moto
    const servico = servicoSel?.value || "";
    const tipoMoto = document.getElementById("motoTipo")?.value || "";
    if (servico === "moto" && !tipoMoto) {
      markInvalid(document.getElementById("motoTipo"), "Selecione Baú ou FOOD.");
      anyError = true;
    } else {
      clearInvalid(document.getElementById("motoTipo"));
    }

    // 2) Validar Retirada / Entrega (tenta geocodificar se tiver texto)
    const origemInput  = document.getElementById("origem");
    const destinoInput = document.getElementById("destino");

    if (!origemPlace?.geometry?.location) {
      const t = origemInput?.value.trim() || "";
      if (!t) {
        markInvalid(origemInput, "Informe o endereço de Retirada.");
        anyError = true;
      } else {
        const p = await geocodeByText(t);
        if (p?.geometry?.location) {
          origemPlace = p;
          clearInvalid(origemInput);
        } else {
          markInvalid(origemInput, "Selecione uma das opções da lista para Retirada.");
          anyError = true;
        }
      }
    } else {
      clearInvalid(origemInput);
    }

    if (!destinoPlace?.geometry?.location) {
      const t = destinoInput?.value.trim() || "";
      if (!t) {
        markInvalid(destinoInput, "Informe o endereço de Entrega.");
        anyError = true;
      } else {
        const p = await geocodeByText(t);
        if (p?.geometry?.location) {
          destinoPlace = p;
          clearInvalid(destinoInput);
        } else {
          markInvalid(destinoInput, "Selecione uma das opções da lista para Entrega.");
          anyError = true;
        }
      }
    } else {
      clearInvalid(destinoInput);
    }

    // 3) Validar paradas (se tiver texto, precisa ser place válido)
    const inputsParadas = Array.from(document.querySelectorAll('[id^="parada-"]'));
    const paradasValidas = [];
    for (let i = 0; i < inputsParadas.length; i++) {
      const inp = inputsParadas[i];
      const txt = inp.value?.trim() || "";
      if (!txt) { clearInvalid(inp); continue; }

      let place = paradasPlaces[i];
      if (!place?.geometry?.location) {
        place = await geocodeByText(txt);
        paradasPlaces[i] = place;
      }
      if (place?.geometry?.location) {
        paradasValidas.push(place);
        clearInvalid(inp);
      } else {
        markInvalid(inp, "Selecione uma das opções da lista.");
        anyError = true;
      }
    }

    if (anyError) {
      if (mDistEl)  mDistEl.textContent  = "—";
      if (mValorEl) mValorEl.textContent = "—";
      esconderWhats();
      return;
    }

    // ====== Tudo ok: calcular ======
    const waypoints = paradasValidas.map(p => ({ location: p.geometry.location, stopover: true }));

    const finalizarComKm = (kmInt) => {
      const tipo    = document.getElementById("motoTipo")?.value || "";
      const pedagioInput = document.getElementById("pedagio");
      const pedagioVal = pedagioInput ? Number(pedagioInput.value || 0) : 0;

      let valor = 0;
      let servicoTxt = "";
      let extraObs = "";

      if (servico === "carro") {
        valor = calcularPrecoCarro(kmInt, paradasValidas.length, pedagioVal);
        servicoTxt = "*_Carro_*";
        setFoodInfo(false);
      } else if (servico === "moto") {
        if (tipo === "food") {
          valor = calcularPrecoMotoFood(kmInt, paradasValidas.length, pedagioVal);
          servicoTxt = "*_Moto — (Somente mochila termica)_*";
          setFoodInfo(true);
        } else {
          valor = calcularPrecoMotoBau(kmInt, paradasValidas.length, pedagioVal);
          servicoTxt = "*_Moto — Baú_*";
          setFoodInfo(false);
        }
      } else if (servico === "fiorino") {
        valor = calcularPrecoFiorino(kmInt, paradasValidas.length, pedagioVal);
        servicoTxt = "*_Fiorino_*";
        setFoodInfo(false);
      } else if (servico === "hr_ducato") {
        valor = calcularPrecoHRDucato(kmInt, paradasValidas.length, pedagioVal);
        servicoTxt = "*_HR / Ducato_*";
        setFoodInfo(false);
      } else if (servico === "iveco_master") {
        valor = calcularPrecoIvecoMaster(kmInt, paradasValidas.length, pedagioVal);
        servicoTxt = "*_Iveco / Master_*";
        setFoodInfo(false);
      }

      if (mDistEl)  mDistEl.textContent  = `${kmInt} km`;
      if (mValorEl) mValorEl.textContent = fmtBRL(valor);

      clearInvalid(document.getElementById('origem'));
      clearInvalid(document.getElementById('destino'));
      document.querySelectorAll('[id^="parada-"]').forEach(clearInvalid);

      const textoURL = montarMensagem(
        origemPlace.formatted_address,
        destinoPlace.formatted_address,
        kmInt,
        valor,
        servicoTxt,
        paradasValidas,
        extraObs
      );

      const btnWhats = getBtnWhats();
      if (btnWhats) {
        btnWhats.href = `https://api.whatsapp.com/send?phone=${WHATS_NUM}&text=${textoURL}`;
      }
      mostrarWhats();
      pulseWhats();
      scrollToWhats();

      lastQuote = {
        hasQuote: true,
        servico,
        motoTipo: servico === "moto" ? tipo : null
      };
    };

    if (waypoints.length > 0 && google.maps?.DirectionsService) {
      const dirSvc = new google.maps.DirectionsService();
      dirSvc.route({
        origin:      origemPlace.geometry.location,
        destination: destinoPlace.geometry.location,
        waypoints,
        optimizeWaypoints: false,
        travelMode: google.maps.TravelMode.DRIVING
      }, (res, status) => {
        if (status !== "OK" || !res?.routes?.[0]?.legs?.length) { esconderWhats(); return; }
        const totalMeters = res.routes[0].legs.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0);
        const kmInt = Math.round(totalMeters / 1000);
        finalizarComKm(kmInt);
      });
    } else if (google.maps?.DistanceMatrixService) {
      const svc = new google.maps.DistanceMatrixService();
      svc.getDistanceMatrix({
        origins:      [origemPlace.geometry.location],
        destinations: [destinoPlace.geometry.location],
        travelMode:   google.maps.TravelMode.DRIVING
      }, (res, status) => {
        if (status !== "OK") { esconderWhats(); return; }
        const el = res?.rows?.[0]?.elements?.[0];
        if (!el || el.status !== "OK") { esconderWhats(); return; }
        const kmInt = Math.round(el.distance.value / 1000);
        finalizarComKm(kmInt);
      });
    } else {
      esconderWhats();
    }
  });

  // força estado inicial correto logo na montagem
  updateRules();
}

// ===================== Validação (utilitários) =====================
function markInvalid(input, hintMsg){
  if(!input) return;
  input.classList.add('is-invalid');
  input.setAttribute('aria-invalid','true');
  let hint = input.nextElementSibling && input.nextElementSibling.classList?.contains('err-hint')
    ? input.nextElementSibling : null;
  if(!hint){
    hint = document.createElement('small');
    hint.className = 'err-hint';
    hint.style.display = 'block';
    hint.style.marginTop = '6px';
    hint.style.color = '#ff8181';
    input.after(hint);
  }
  hint.textContent = hintMsg || 'Campo obrigatório.';
}
function clearInvalid(input){
  if(!input) return;
  input.classList.remove('is-invalid');
  input.removeAttribute('aria-invalid');
  const hint = input.nextElementSibling;
  if(hint && hint.classList?.contains('err-hint')) hint.remove();
}

// ===================== Init =====================
function initOrcamento() {
  ensureMotoTipoControl();
  configurarAutocomplete();
  configurarEventos();
  // NÃO chamamos hideRules() aqui; updateRules() já cuida do estado inicial
  esconderWhats();
}
window.initOrcamento = initOrcamento;
