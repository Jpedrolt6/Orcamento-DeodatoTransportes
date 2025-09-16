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
const DEBOUNCE_MS     = 100;
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

// ====== Infos extras por ponto (textarea “só com linhas”) ======
function makeLinedTextarea(id, placeholder) {
  const ta = document.createElement("textarea");
  ta.id = id;
  ta.className = "addr-info";
  ta.rows = 1;
  ta.placeholder = placeholder || "Informações..Ex: Nome de quem procurar, Apto, Conjunto. ";
  ta.style.cssText = `
    margin-top:6px;width:100%;resize:none;color:#e9eef7;
    background:
      linear-gradient(transparent, transparent 10px, rgba(255, 255, 255, 0.06) 20px) repeat-y;
    background-size: 100% 24px;
    background-color: transparent;
    border: none; border-bottom: 0px dashed #ffffffff;
    border-radius: 0; padding: 4px 2px 4px 0;
    font-family: inherit; font-size: 13px; line-height: 24px;
    outline: none; box-shadow: none; overflow:hidden;
  `;
  // auto-grow conforme digita
  const autoGrow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.addEventListener('input', autoGrow);
  setTimeout(autoGrow, 0);
  bloquearEnter(ta);
  return ta;
}
function ensureInfoField(afterInputEl, infoId, placeholder) {
  if (!afterInputEl || !infoId) return;
  if (document.getElementById(infoId)) return;
  const ta = makeLinedTextarea(infoId, placeholder);
  afterInputEl.insertAdjacentElement("afterend", ta);
}
function getInfoValue(infoId) {
  const el = document.getElementById(infoId);
  return (el && el.value || "").trim();
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
  _load() { try { this._list = JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { this._list = []; } },
  _save() { try { localStorage.setItem(FAV_KEY, JSON.stringify(this._list)); } catch {} },
  _norm(s) { return String(s || "").trim().toLowerCase(); },
  addFromPlace(place) {
    if (!place?.formatted_address) return;
    const addr = place.formatted_address;
    const lat = place?.geometry?.location?.lat ?? place?.geometry?.location?.latitude;
    const lng = place?.geometry?.location?.lng ?? place?.geometry?.location?.longitude;
    if (lat == null || lng == null) return;
    this._load();
    const key = this._norm(addr);
    const i = this._list.findIndex(x => this._norm(x.addr) === key);
    if (i >= 0) { this._list[i].count = (this._list[i].count || 0) + 1; this._list[i].last = Date.now(); this._list[i].lat = lat; this._list[i].lng = lng; }
    else { this._list.push({ addr, lat, lng, count: 1, last: Date.now() }); }
    this._list.sort((a,b)=> (b.count-a.count) || (b.last - a.last));
    if (this._list.length > 50) this._list.length = 50;
    this._save();
  },
  matches(query = "", limit = 5) {
    this._load();
    const q = this._norm(query);
    const arr = q ? this._list.filter(x => this._norm(x.addr).includes(q)) : this._list.slice();
    arr.sort((a,b)=> (b.count-a.count) || (b.last - a.last));
    const top = arr.slice(0, limit);
    return top.map((rec, idx) => {
      const parts = rec.addr.split(", ");
      const main  = parts.shift() || rec.addr;
      const sec   = parts.join(", ");
      return {
        description: rec.addr,
        structured_formatting: { main_text: main, secondary_text: sec },
        place_id: "fav:" + idx + ":" + rec.last,
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
  const h = { "Content-Type": "application/json", "X-Goog-Api-Key": PLACES_API_KEY, "X-Goog-FieldMask": fieldMask };
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
    out.push({ description, structured_formatting: { main_text: main || description, secondary_text: secondary || "" }, place_id: p.placeId });
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
    const body = { input, languageCode: language, regionCode: region, includeQueryPredictions: true, locationBias: SP_BIAS };
    const res = await fetch(`${PLACES_BASE}/places:autocomplete`, {
      method: "POST", headers: newHeaders(FM_AUTOCOMPLETE, sessionToken), body: JSON.stringify(body), signal: _acAborter.signal
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
      method: "POST", headers: newHeaders(FM_SEARCH), body: JSON.stringify({ textQuery, languageCode: language, locationBias: SP_BIAS })
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
  return { formatted_address: formatted, geometry: { location: (lat != null && lng != null) ? { lat, lng } : null } };
}

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
function tarifaDegrau(kmInt, ate30Valor, pos30PorKm){
  const k = Math.max(0, Number(kmInt) || 0);
  if (k <= 30) return ate30Valor;
  return ate30Valor + pos30PorKm * (k - 30);
}
function calcularPrecoFiorino(kmInt, qtdParadas = 0, pedagio = 0){
  const base = tarifaDegrau(kmInt, 190, 4);
  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 10;
  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}
function calcularPrecoHRDucato(kmInt, qtdParadas = 0, pedagio = 0){
  const base = tarifaDegrau(kmInt, 290, 5);
  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 20;
  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}
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
function montarMensagem(origem, destino, kmTexto, valor, servicoTxt, paradasList = [], extraObs = "") {
  const linhas = [];
  const origemInfo = getInfoValue("origemInfo");
  linhas.push("*RETIRADA*","📍 " + origem);
  if (origemInfo) linhas.push("📝 " + origemInfo);
  linhas.push("");

  if (paradasList.length) {
    paradasList.forEach((p, i) => {
      const end = p?.formatted_address || p?.description || "";
      const info = getInfoValue(`paradaInfo-${i}`);
      if (end) {
        linhas.push(`*PARADA ${i + 1}*`, "📍 " + end);
        if (info) linhas.push("📝 " + info);
        linhas.push("");
      }
    });
  }

  if (destino) {
    const destinoInfo = getInfoValue("destinoInfo");
    linhas.push("*ENTREGA*","📍 " + destino);
    if (destinoInfo) linhas.push("📝 " + destinoInfo);
    linhas.push("");
  }

  linhas.push(`*Tipo de veículo:* ${servicoTxt}`);
  if (extraObs) linhas.push(extraObs);
  linhas.push("", "🛣️ Km " + kmTexto, "💵 " + fmtBRL(valor));

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
    Adicionar número do local
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
    position: "absolute", zIndex: "9999", background: "#0b0f14",
    border: "1px solid #1d2634", borderRadius: "12px", padding: "6px",
    boxShadow: "0 10px 24px rgba(0,0,0,.35)", display: "none",
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
        width: "100%", textAlign: "left", padding: "10px 12px", border: "0",
        borderRadius: "10px", background: "transparent", color: "#e9eef7", cursor: "pointer", fontFamily: "inherit",
      });

      item.addEventListener("click", async () => {
        const finish = (place) => {
          inputEl.value = place.formatted_address || p.description;
          clearInvalid(inputEl);
          if (!hasStreetNumber(inputEl.value)) showAddNumeroHint(inputEl);
          hideList();
          sessionToken = newSessionToken();
          Favorites.addFromPlace(place);
          try { onPlaceChosen && onPlaceChosen(place); } catch {}
        };

        if (p.favPlace) { finish(p.favPlace); return; }

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
        } catch { hideList(); }
      });

      // conteúdo visual do item
      const mainText = p.structured_formatting?.main_text || p.description || "";
      const secondaryText = p.structured_formatting?.secondary_text || "";
      item.innerHTML = `
        <div style="font-weight:600;display:flex;align-items:center;gap:8px">
          <span class="suggestions__main">${mainText}</span>
        </div>
        <div class="suggestions__sec" style="font-size:12px;color:#a9b2c3">${secondaryText || ""}</div>
      `;

      list.appendChild(item);
    });
    showList(); positionList();
  }

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
          const data = await placesNewAutocomplete({ input: q, sessionToken, region: COUNTRY_CODE, language: "pt-BR" });
          norm = normalizeNewSuggestions(data);
          if (!norm.length || norm.length < MIN_SUGGESTIONS) {
            const st = await placesNewSearchText(q, "pt-BR");
            const extra = normalizeSearchToSuggestions(st);
            const seen = new Set(norm.map(x => x.place_id));
            for (const e of extra) if (!seen.has(e.place_id)) norm.push(e);
          }
          predCache.set(q, { ts: Date.now(), predictions: norm });
        } catch { norm = []; }
      }
    }

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

  const requestPredictions = debounce(() => { buildAndRender(inputEl.value); }, DEBOUNCE_MS);

  inputEl.addEventListener("focus", () => {
    const v = inputEl.value.trim();
    if (!v) {
      const favs = Favorites.matches("", 8);
      if (favs.length) {
        positionList();
        renderPredictions(favs);
      }
    }
  });

  inputEl.addEventListener("keydown", (ev) => {
    const items = list.querySelectorAll(".suggestions__item");
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
  const row = document.querySelector('.row'); if (!row) return;
  const field = document.createElement("div");
  field.className = "field small";
  field.id = "motoTipoRow";
  field.style.display = "none";
  field.innerHTML = `
    <label for="motoTipo">Tipo de Moto</label>
    <select id="motoTipo">
      <option value="">Selecione…</option>
      <option value="bau">Baú</option>
      <option value="food">FOOD (mochila térmica)</option>
    </select>
  `;
  const servField = document.getElementById('servico')?.closest('.field');
  if (servField && servField.parentElement === row) servField.after(field); else row.appendChild(field);
}

// ===================== UI da Otimização (botão e container) =====================
function ensureOptimizeUI() {
  const actions = document.querySelector(".actions");
  if (actions) {
    // remove duplicados de “Rota Otimizada”
    const sameTextBtns = Array.from(actions.querySelectorAll("button")).filter(b => (b.textContent||"").trim().toLowerCase() === "rota otimizada");
    sameTextBtns.slice(1).forEach(b => b.remove());
    let btn = sameTextBtns[0] || document.getElementById("btnOtimizar");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "btnOtimizar";
      btn.className = "outline";
      btn.textContent = "Rota Otimizada";
      btn.style.marginLeft = "8px";
      actions.appendChild(btn);
    } else {
      btn.id = "btnOtimizar";
    }

    // subtítulo solicitado
    let sub = document.getElementById("otSub");
    if (!sub) {
      sub = document.createElement("div");
      sub.id = "otSub";
      sub.textContent = "ROTA OTIMIZADA: Ideal para corridas com bastantes paradas.";
      sub.style.cssText = "display:block;margin:4px 0 0 8px;font-size:12px;color:#a9b2c3;font-weight:600;";
      actions.appendChild(sub);
    }
  }
  if (!document.getElementById("otimizacaoResumo")) {
    const resumoBox = document.getElementById("resumo");
    if (resumoBox) {
      const box = document.createElement("div");
      box.id = "otimizacaoResumo";
      box.className = "glass";
      box.style.cssText = "display:none;margin-top:12px;padding:12px;border-radius:12px;border:1px solid #1d2634;background:#0b0f14;color:#e9eef7";
      resumoBox.appendChild(box);
    }
  }
  if (!document.getElementById("resumoLinkMaps")) {
    const resumoBox = document.getElementById("resumo");
    if (resumoBox) {
      const link = document.createElement("a");
      link.id = "resumoLinkMaps";
      link.href = "#";
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Abrir no Google Maps";
      link.style.cssText = "display:none;margin:10px 0 0;text-decoration:underline;color:#85b7ff;font-weight:600;";
      resumoBox.insertBefore(link, document.getElementById("btnWhats"));
    }
  }
}

// ===================== Botão Voltar ao Topo =====================
function ensureBackToTopUI(){
  if (document.getElementById('btnToTop')) return;
  const btn = document.createElement('button');
  btn.id = 'btnToTop';
  btn.type = 'button';
  btn.setAttribute('aria-label','Voltar ao topo');
  btn.innerHTML = '↑';
  btn.style.cssText = `
    position:fixed; right:20px; bottom:20px; width:44px; height:44px;
    display:none; border-radius:9999px; border:1px solid #1d2634;
    background:#0b0f14cc; color:#e9eef7; font-size:18px; font-weight:700;
    cursor:pointer; z-index:99999; backdrop-filter: blur(4px);
  `;
  btn.addEventListener('click', ()=> window.scrollTo({ top:0, behavior:'smooth' }));
  document.body.appendChild(btn);

  const onScroll = () => {
    const show = window.scrollY > 600;
    btn.style.display = show ? 'grid' : 'none';
    if (show) btn.style.placeItems = 'center';
  };
  window.addEventListener('scroll', onScroll, { passive:true });
  onScroll();
}

// ===================== Autocomplete nos campos =====================
function configurarAutocomplete() {
  if (!window.google) return;

  const origemInput  = document.getElementById("origem");
  const destinoInput = document.getElementById("destino");

  aplicarBloqueioNosCamposBasicos();

  // Textareas de info (linhas) com exemplos profissionais
  ensureInfoField(origemInput, "origemInfo", "Adicionar informações: Nome de quem procurar, Apto, Conjunto e etc...");
  ensureInfoField(destinoInput, "destinoInfo", "Adicionar informações: ");

  setupInputAutocomplete({ inputEl: origemInput,  onPlaceChosen: (place) => { origemPlace = place; } });
  setupInputAutocomplete({ inputEl: destinoInput, onPlaceChosen: (place) => { destinoPlace = place; } });

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

  // Campo de observação abaixo (linhas) — exemplo profissional
  ensureInfoField(wrap.querySelector("input"), `paradaInfo-${idx}`, "Adicionar informações");

  setupInputAutocomplete({ inputEl: input, onPlaceChosen: (place) => { paradasPlaces[idx] = place; } });
}

// ===================== Regras do serviço (UI dinâmica) =====================
function hideRules() {
  const rules = document.querySelector('.rules'); if (!rules) return;
  const ul = rules.querySelector('ul'); if (ul) ul.innerHTML = "";
  rules.style.display = 'none'; setFoodInfo(false);
}
function showRules(htmlList) {
  const rules = document.querySelector('.rules'); if (!rules) return;
  const ul = rules.querySelector('ul'); if (!ul) return;
  ul.innerHTML = htmlList; rules.style.display = '';
}
function updateRules() {
  const servicoSel  = document.getElementById("servico");
  const motoTipoSel = document.getElementById("motoTipo");
  const motoTipoRow = document.getElementById("motoTipoRow");
  const servico = servicoSel?.value || "";

  if (motoTipoRow) motoTipoRow.style.display = (servico === "moto") ? "" : "none";

  if (servico === "carro") {
    showRules(`<li>Ideal para caixas pequenas e médias, acima da capacidade da moto</li><li>Espera: R$ 0,70/min após 20 min</li>`);
    setFoodInfo(false); return;
  }
  if (servico === "moto") {
    const tipo = motoTipoSel?.value || "";
    if (tipo === "food") {
      showRules(`<li>Mochila térmica</li><li>Ideal para entregas de alimentos</li><li>Peso máx.: 20 kg</li><li>Espera: R$ 0,60/min após 20 min</li>`);
      setFoodInfo(true);
    } else if (tipo === "bau") {
      showRules(`<li>Baú máx.: 44 × 42 × 32 cm</li><li>Peso máx.: 20 kg</li><li>Ideal para documentos, eletrônicos, roupas e pequenas encomendas</li><li>Espera: R$ 0,60/min após 15 min</li>`);
      setFoodInfo(false);
    } else { hideRules(); }
    return;
  }
  if (servico === "fiorino") {
    showRules(`<li>Ideal para cargas fracionadas de medio porte</li><li>Melhor custo-benefício para cargas de até 600 kg</li><li>Dimensões máx.: 1,35 m alt. × 1,10 m larg. × 1,85 m comp.</li><li>Peso máx.: 600 kg</li><li>Picapes: Ideal para cargas alongadas (ex.: tubos, barras, perfis metálicos)</li><li> Espera: R$ 0,80/min após 20 min</li>`);
    return;
  }
  if (servico === "hr_ducato") {
    showRules(`<li>Pequeno caminhão / Ideal para cargas volumosas em quantidade intermediária</li><li>Ideal para mudanças pequenas e cargas maiores</li><li>Dimensões máx.: 1,90 m alt. × 1,40 m larg. × 2,50 m comp.</li><li>Peso máx.: 1500 kg</li><li> Espera: R$ 1,20/min após 30 min</li>`);
    return;
  }
  if (servico === "iveco_master") {
    showRules(`<li>Ideal para operações maiores em centros urbanos com restrição de caminhões</li><li>Transporte de cargas paletizadas</li><li>Capacidade volumétrica 10-15 m³</li><li>Peso max.: 2300 kg</li><li> Espera: R$ 1,20/min após 30 min</li>`);
    return;
  }
  hideRules();
}

// ===================== Botão Whats — helpers =====================
function getBtnWhats() { return document.getElementById("btnWhats"); }
function esconderWhats() {
  const btnWhats = getBtnWhats(); if (!btnWhats) return;
  btnWhats.classList.add("hide"); btnWhats.classList.remove("show","wpp-attention");
  btnWhats.setAttribute("aria-disabled","true"); btnWhats.setAttribute("tabindex","-1"); btnWhats.href = "#";
}
function mostrarWhats() {
  const btnWhats = getBtnWhats(); if (!btnWhats) return;
  btnWhats.classList.remove("hide"); btnWhats.classList.add("show");
  btnWhats.setAttribute("aria-disabled","false"); btnWhats.removeAttribute("tabindex");
}
function scrollToWhats() {
  const btnWhats = getBtnWhats(); if (!btnWhats) return;
  const y = btnWhats.getBoundingClientRect().top + window.scrollY - 80;
  window.scrollTo({ top: y, behavior: 'smooth' });
}
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
  .wpp-attention { animation: wpp-wobble 0.9s ease both; }`;
  const style = document.createElement('style'); style.id = 'wpp-attention-style'; style.textContent = css;
  document.head.appendChild(style);
})();
function pulseWhats() {
  const btnWhats = getBtnWhats(); if (!btnWhats) return;
  btnWhats.classList.remove('wpp-attention'); void btnWhats.offsetWidth;
  btnWhats.classList.add('wpp-attention');
  try { if (navigator.vibrate) navigator.vibrate([80,60,80,60,120,60,80]); } catch {}
}
document.addEventListener('pointerdown', (ev) => {
  const btn = ev.target?.closest?.('#btnWhats'); if (!btn) return;
  try { if (navigator.vibrate) navigator.vibrate([40,40,80]); } catch {}
}, { passive: true });

// ===== scroll para resultados (KM/Valor) =====
function scrollToMetrics(){
  const target = document.getElementById('mValor') || document.getElementById('mDist') || document.getElementById('resumo');
  if (!target) return;
  const y = target.getBoundingClientRect().top + window.scrollY - 100;
  window.scrollTo({ top: y, behavior:'smooth' });
}

// ===================== Limpa (inclui UI/renderer da otimização) =====================
function clearOptimizationUI() {
  const el = document.getElementById("otimizacaoResumo");
  if (el) { el.innerHTML = ""; el.style.display = "none"; }
  try { if (directionsRenderer) directionsRenderer.setDirections({ routes: [] }); } catch {}
  const mapsLink = document.getElementById("resumoLinkMaps");
  if (mapsLink) { mapsLink.style.display = "none"; mapsLink.href = "#"; }
}
function limparEnderecosInputs() {
  const origemInput  = document.getElementById("origem");
  const destinoInput = document.getElementById("destino");
  if (origemInput) origemInput.value = "";
  if (destinoInput) destinoInput.value = "";

  const origemInfo = document.getElementById("origemInfo");
  const destinoInfo = document.getElementById("destinoInfo");
  if (origemInfo) origemInfo.value = "";
  if (destinoInfo) destinoInfo.value = "";

  origemPlace = null; destinoPlace = null;

  const contParadas = document.getElementById("paradas");
  if (contParadas) contParadas.innerHTML = "";
  paradasPlaces = []; contadorParadas = 0;

  const mDistEl  = document.getElementById("mDist");
  const mValorEl = document.getElementById("mValor");
  if (mDistEl)  mDistEl.textContent = "—";
  if (mValorEl) mValorEl.textContent = "—";

  esconderWhats();

  clearInvalid(document.getElementById('origem'));
  clearInvalid(document.getElementById('destino'));
  document.querySelectorAll('[id^="parada-"]').forEach(clearInvalid);
  document.querySelectorAll(".add-num-pill-js").forEach(el => el.remove());

  clearOptimizationUI();
}

// ===================== Helpers de rota/links =====================
function placeToLatLngStr(place) {
  const loc = place?.geometry?.location;
  if (!loc) return null;
  const lat = typeof loc.lat === "function" ? loc.lat() : loc.lat;
  const lng = typeof loc.lng === "function" ? loc.lng() : loc.lng;
  return `${lat},${lng}`;
}
function placeToQuery(place) {
  if (!place) return "";
  if (place.formatted_address) return encodeURIComponent(place.formatted_address);
  const latlng = placeToLatLngStr(place);
  return latlng ? encodeURIComponent(latlng) : "";
}
function buildGmapsDirLink(originPlace, orderedStops) {
  const origin = placeToQuery(originPlace);
  const destinoPlaceTmp = orderedStops[orderedStops.length - 1] || originPlace;
  const destination = placeToQuery(destinoPlaceTmp);
  const mids = orderedStops.slice(0, -1).map(placeToQuery).filter(Boolean).join("%7C");
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (mids) url += `&waypoints=${mids}`;
  return url;
}
function showResumoMapsLink(origin, orderedStops) {
  const linkEl = document.getElementById("resumoLinkMaps");
  if (!linkEl) return;
  const url = buildGmapsDirLink(origin, orderedStops);
  linkEl.href = url; linkEl.style.display = "inline-block";
}

// === Distância: "X,Y" (<10 km) e inteiro (>=10 km)
// - Y = 0..9 (cada passo = 100 m), sempre ARREDONDANDO PRA BAIXO
// - locale: 'pt' => vírgula  |  'en' => ponto
function formatKmDisplay(totalMeters, locale = 'pt') {
  const m = Math.max(0, Math.round(Number(totalMeters) || 0));

  // 10 km ou mais: mostrar só o inteiro (estético)
  if (m >= 10000) return String(Math.round(m / 1000));

  // 0–9,999 km: "X,Y", com Y em décimos (100 m) e truncado
  const km = Math.floor(m / 1000);
  const tenths = Math.floor((m % 1000) / 100); // 0..9
  const sep = (locale === 'en') ? '.' : ',';
  return `${km}${sep}${tenths}`;
}

// ===================== Cálculo e UI =====================
function configurarEventos() {
  ensureMotoTipoControl();
  ensureOptimizeUI();

  const btnCalcular = document.getElementById("btnCalcular");
  const btnWhats    = document.getElementById("btnWhats");
  const btnLimpar   = document.getElementById("btnLimpar");
  const mDistEl     = document.getElementById("mDist");
  const mValorEl    = document.getElementById("mValor");
  const servicoSel  = document.getElementById("servico");
  const motoTipoSel = document.getElementById("motoTipo");
  const btnOtimizar = document.getElementById("btnOtimizar");

  esconderWhats();

  if (servicoSel) servicoSel.addEventListener("change", () => {
    updateRules();
    if (servicoSel.value !== "moto") clearInvalid(document.getElementById("motoTipo"));
  });

  if (motoTipoSel) {
    motoTipoSel.addEventListener("change", () => {
      updateRules();
      const novoTipo = motoTipoSel.value || "";
      if (lastQuote.hasQuote && lastQuote.servico === "moto" && lastQuote.motoTipo && novoTipo && novoTipo !== lastQuote.motoTipo) {
        limparEnderecosInputs();
        lastQuote = { hasQuote: false, servico: null, motoTipo: null };
      }
    });
  }

  btnOtimizar?.addEventListener("click", async () => {
    try { await otimizarRotaComGoogle(); } catch(e) { console.error(e); }
  });

  btnWhats?.addEventListener("click", (e)=>{ if (btnWhats.getAttribute("aria-disabled") === "true") e.preventDefault(); });

  btnLimpar?.addEventListener("click", () => {
    const origemInput  = document.getElementById("origem");
    const destinoInput = document.getElementById("destino");
    const motoTipoSel  = document.getElementById("motoTipo");
    if (origemInput) origemInput.value = "";
    if (destinoInput) destinoInput.value = "";
    if (motoTipoSel) motoTipoSel.selectedIndex = 0;

    const origemInfo = document.getElementById("origemInfo");
    const destinoInfo = document.getElementById("destinoInfo");
    if (origemInfo) origemInfo.value = "";
    if (destinoInfo) destinoInfo.value = "";

    origemPlace = null; destinoPlace = null;

    const contParadas = document.getElementById("paradas");
    if (contParadas) contParadas.innerHTML = "";
    paradasPlaces = []; contadorParadas = 0;

    if (mDistEl)  mDistEl.textContent  = "—";
    if (mValorEl) mValorEl.textContent = "—";

    document.querySelectorAll(".add-num-pill-js").forEach(el => el.remove());

    esconderWhats();
    origemInput?.focus();
    updateRules();
    lastQuote = { hasQuote: false, servico: null, motoTipo: null };

    clearOptimizationUI();
  });

  btnCalcular?.addEventListener("click", calcularNormal);

  updateRules();
}

// ---- cálculo padrão (botão CALCULAR já existente)
async function calcularNormal(e){
  if (e) e.preventDefault();

  const mDistEl   = document.getElementById("mDist");
  const mValorEl  = document.getElementById("mValor");
  const servicoSel  = document.getElementById("servico");
  const servico = servicoSel?.value || "";
  const tipoMoto = document.getElementById("motoTipo")?.value || "";

  // tipo obrigatório quando motoboy
  if (servico === "moto" && !tipoMoto) {
    markInvalid(document.getElementById("motoTipo"), "Selecione Baú ou FOOD.");
    mDistEl && (mDistEl.textContent  = "—");
    mValorEl && (mValorEl.textContent = "—");
    esconderWhats();
    document.getElementById("motoTipo")?.focus();
    return;
  } else {
    clearInvalid(document.getElementById("motoTipo"));
  }

  let anyError = false;

  const origemInput  = document.getElementById("origem");
  const destinoInput = document.getElementById("destino");

  if (!origemPlace?.geometry?.location) {
    const t = origemInput?.value.trim() || "";
    if (!t) { markInvalid(origemInput, "Informe o endereço de Retirada."); anyError = true; }
    else {
      const p = await geocodeByText(t);
      if (p?.geometry?.location) { origemPlace = p; clearInvalid(origemInput); }
      else { markInvalid(origemInput, "Selecione uma das opções da lista para Retirada."); anyError = true; }
    }
  } else { clearInvalid(origemInput); }

  const inputsParadas = Array.from(document.querySelectorAll('[id^="parada-"]'));
  const paradasValidas = [];
  for (let i = 0; i < inputsParadas.length; i++) {
    const inp = inputsParadas[i];
    const txt = inp.value?.trim() || "";
    if (!txt) { clearInvalid(inp); continue; }
    let place = paradasPlaces[i];
    if (!place?.geometry?.location) { place = await geocodeByText(txt); paradasPlaces[i] = place; }
    if (place?.geometry?.location) { paradasValidas.push(place); clearInvalid(inp); }
    else { markInvalid(inp, "Selecione uma das opções da lista."); anyError = true; }
  }

  const destinoObrigatorio = paradasValidas.length === 0;
  if (destinoObrigatorio) {
    if (!destinoPlace?.geometry?.location) {
      const t = destinoInput?.value.trim() || "";
      if (!t) { markInvalid(destinoInput, "Informe o endereço de Entrega ou adicione paradas."); anyError = true; }
      else {
        const p = await geocodeByText(t);
        if (p?.geometry?.location) { destinoPlace = p; clearInvalid(destinoInput); }
        else { markInvalid(destinoInput, "Selecione uma das opções da lista para Entrega ou adicione paradas."); anyError = true; }
      }
    } else { clearInvalid(destinoInput); }
  } else {
    const t = destinoInput?.value.trim() || "";
    if (t && !destinoPlace?.geometry?.location) {
      const p = await geocodeByText(t);
      if (p?.geometry?.location) { destinoPlace = p; clearInvalid(destinoInput); }
      else { markInvalid(destinoInput, "Opcional — se preencher, selecione uma opção da lista."); }
    } else { clearInvalid(destinoInput); }
  }

  if (anyError) {
    mDistEl && (mDistEl.textContent  = "—");
    mValorEl && (mValorEl.textContent = "—");
    esconderWhats();
    return;
  }

  const points = [origemPlace, ...paradasValidas];
  if (destinoPlace?.geometry?.location) points.push(destinoPlace);

  if (points.length < 2) {
    markInvalid(destinoInput, "Informe Entrega ou adicione pelo menos uma Parada.");
    mDistEl && (mDistEl.textContent  = "—");
    mValorEl && (mValorEl.textContent = "—");
    esconderWhats();
    return;
  }

  const waypoints = points.slice(1, -1).map(p => ({ location: p.geometry.location, stopover: true }));
  const origemLoc = points[0].geometry.location;
  const destinoLoc = points[points.length - 1].geometry.location;

  const finalizarComKm = (kmInt, totalMeters) => finalizarOrcamentoComKm(kmInt, paradasValidas, servico, totalMeters);

  if (google.maps?.DirectionsService) {
    const dirSvc = new google.maps.DirectionsService();
    dirSvc.route({
      origin:      origemLoc,
      destination: destinoLoc,
      waypoints,
      optimizeWaypoints: false,
      travelMode: google.maps.TravelMode.DRIVING
    }, (res, status) => {
      if (status !== "OK" || !res?.routes?.[0]?.legs?.length) { esconderWhats(); return; }
      const totalMeters = res.routes[0].legs.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0);
      const kmInt = Math.floor(totalMeters / 1000); // cobrar só km inteiro pra baixo
      finalizarComKm(kmInt, totalMeters);
    });
  } else {
    esconderWhats();
  }
}

function finalizarOrcamentoComKm(kmInt, paradasValidas, servico, totalMeters){
  const tipo    = document.getElementById("motoTipo")?.value || "";
  const pedagioInput = document.getElementById("pedagio");
  const pedagioVal = pedagioInput ? Number(pedagioInput.value || 0) : 0;

  const mDistEl  = document.getElementById("mDist");
  const mValorEl = document.getElementById("mValor");

  let valor = 0, servicoTxt = "", extraObs = "";

  if (servico === "carro") { valor = calcularPrecoCarro(kmInt, paradasValidas.length, pedagioVal); servicoTxt = "*_Carro_*"; setFoodInfo(false); }
  else if (servico === "moto") {
    if (tipo === "food") { valor = calcularPrecoMotoFood(kmInt, paradasValidas.length, pedagioVal); servicoTxt = "*_Moto — (Somente mochila térmica)_*"; setFoodInfo(true); }
    else { valor = calcularPrecoMotoBau(kmInt, paradasValidas.length, pedagioVal); servicoTxt = "*_Moto — Baú_*"; setFoodInfo(false); }
  } else if (servico === "fiorino") { valor = calcularPrecoFiorino(kmInt, paradasValidas.length, pedagioVal); servicoTxt = "*_Fiorino_*"; }
  else if (servico === "hr_ducato") { valor = calcularPrecoHRDucato(kmInt, paradasValidas.length, pedagioVal); servicoTxt = "*_HR / Ducato_*"; }
  else if (servico === "iveco_master") { valor = calcularPrecoIvecoMaster(kmInt, paradasValidas.length, pedagioVal); servicoTxt = "*_Iveco / Master_*"; }

  const kmDisplay = formatKmDisplay(totalMeters != null ? totalMeters : (kmInt * 1000));

  if (mDistEl)  mDistEl.textContent  = kmDisplay;
  if (mValorEl) mValorEl.textContent = fmtBRL(valor);

  clearInvalid(document.getElementById('origem'));
  clearInvalid(document.getElementById('destino'));
  document.querySelectorAll('[id^="parada-"]').forEach(clearInvalid);

  // link maps no resumo (sempre) — inclui ENTREGA
  const pointsForLink = [origemPlace, ...paradasValidas];
  if (destinoPlace?.formatted_address || destinoPlace?.geometry?.location) pointsForLink.push(destinoPlace);
  showResumoMapsLink(pointsForLink[0], pointsForLink.slice(1));

  const destinoTexto = destinoPlace?.formatted_address || (paradasValidas.length ? paradasValidas[paradasValidas.length - 1]?.formatted_address : "");
  const textoURL = montarMensagem(
    origemPlace.formatted_address,
    destinoTexto,
    kmDisplay, // mostra igual ao resumo
    valor,
    servicoTxt,
    paradasValidas,
    extraObs
  );

  const btnWhats = getBtnWhats();
  if (btnWhats) btnWhats.href = `https://api.whatsapp.com/send?phone=${WHATS_NUM}&text=${textoURL}`;

  mostrarWhats(); pulseWhats(); // sem scroll para o botão
  scrollToMetrics();            // rola para KM/Valor
  lastQuote = { hasQuote: true, servico, motoTipo: servico === "moto" ? (document.getElementById("motoTipo")?.value || "") : null };
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
  if (hint && hint.classList?.contains('err-hint')) hint.remove();
}

// ===================== === ROTEIRO OTIMIZAÇÃO (RETIRADA FIXA) =====================
let directionsService = null;
let directionsRenderer = null;

function initDirectionsOnce() {
  if (!directionsService) directionsService = new google.maps.DirectionsService();
  if (!directionsRenderer) {
    directionsRenderer = new google.maps.DirectionsRenderer({ suppressMarkers: true });
    // Se tiver um mapa, conecte aqui: directionsRenderer.setMap(seuMapa);
  }
}

function renderResumoOtimizacao(result) {
  const el = document.getElementById("otimizacaoResumo");
  if (!el) return;
  const legs = result?.routes?.[0]?.legs || [];
  const totalKm = legs.reduce((acc, l) => acc + (l.distance?.value || 0), 0) / 1000;
  const totalMin = Math.round(legs.reduce((acc, l) => acc + (l.duration?.value || 0), 0) / 60);

  const itens = [];
  itens.push(`<li><b>Retirada</b>: ${origemPlace?.formatted_address || placeToLatLngStr(origemPlace) || "(sem endereço)"}</li>`);
  paradasPlaces.forEach((p, i) => {
    const texto = p?.formatted_address || placeToLatLngStr(p) || "(sem endereço)";
    itens.push(`<li><b>Parada ${i+1}</b>: ${texto}</li>`);
  });
  if (destinoPlace) {
    const texto = destinoPlace.formatted_address || placeToLatLngStr(destinoPlace) || "(sem endereço)";
    itens.push(`<li><b>Entrega</b>: ${texto}</li>`);
  }

  // Link e preview devem incluir ENTREGA no final
  const orderedForLink = [...paradasPlaces];
  if (destinoPlace) orderedForLink.push(destinoPlace);

  const link = buildGmapsDirLink(origemPlace, orderedForLink);

  el.innerHTML = `
    <div class="card">
      <div class="card-title">Rota otimizada</div>
      <ul>${itens.join("")}</ul>
      <p><b>Total estimado:</b> ~${isFinite(totalKm) ? totalKm.toFixed(1) : "—"} km • ~${isFinite(totalMin) ? totalMin : "—"} min</p>
      <p><a href="${link}" target="_blank" rel="noopener">Abrir no Google Maps</a></p>
      <div style="margin-top:10px">
        <button id="btnCalcularOt" type="button" class="primary">Calcular rota otimizada</button>
      </div>
      <small>Obs.: a navegação considera trânsito em tempo real no app do Maps.</small>
    </div>`;
  el.style.display = "block";

  showResumoMapsLink(origemPlace, orderedForLink);

  // ligar botão
  document.getElementById("btnCalcularOt")?.addEventListener("click", calcularRotaOtimizada);
}

// === reorganiza inputs conforme ordem otimizada (Retirada fixa)
function aplicarOrdemOtimizadaNosInputs(ordered) {
  if (!Array.isArray(ordered) || ordered.length === 0) return;

  // último vira ENTREGA
  const last = ordered[ordered.length - 1];
  const destinoInput = document.getElementById("destino");
  if (destinoInput) destinoInput.value = last?.formatted_address || "";
  destinoPlace = last;

  // demais viram PARADAS
  const novosStops = ordered.slice(0, -1);

  const container = document.getElementById("paradas");
  if (!container) return;
  container.innerHTML = "";
  paradasPlaces = [];
  contadorParadas = 0;

  novosStops.forEach((p, i) => {
    adicionarParadaInput();
    const inp = document.getElementById(`parada-${i}`);
    if (inp) inp.value = p?.formatted_address || "";
    paradasPlaces[i] = p;
  });

  clearInvalid(destinoInput);
  document.querySelectorAll('[id^="parada-"]').forEach(clearInvalid);
}

// === cálculo pela ordem otimizada (força Bau/Food quando Moto)
async function calcularRotaOtimizada() {
  const servicoSel  = document.getElementById("servico");
  const servico = servicoSel?.value || "";
  const tipoMoto = document.getElementById("motoTipo")?.value || "";

  if (servico === "moto" && !tipoMoto) {
    markInvalid(document.getElementById("motoTipo"), "Selecione Baú ou FOOD.");
    document.getElementById("motoTipo")?.focus();
    return;
  } else {
    clearInvalid(document.getElementById("motoTipo"));
  }

  if (!origemPlace?.geometry?.location) {
    alert("Defina a RETIRADA antes de calcular.");
    return;
  }
  if (!paradasPlaces.length && !destinoPlace?.geometry?.location) {
    alert("Adicione paradas ou uma entrega.");
    return;
  }

  // rota na ordem otimizada: origem -> paradas (mids) -> destino (último)
  const ordered = [...paradasPlaces];
  const destino = destinoPlace || ordered[ordered.length - 1];
  const mids = ordered; // todos os paradasPlaces são intermediários; entrega já está em destinoPlace
  if (!destino?.geometry?.location) {
    alert("Não foi possível identificar o destino da rota otimizada.");
    return;
  }

  const origemLoc = origemPlace.geometry.location;
  const destinoLoc = destino.geometry.location;
  const waypoints = mids.map(p => ({ location: p.geometry.location, stopover: true }));

  const dirSvc = new google.maps.DirectionsService();
  dirSvc.route({
    origin: origemLoc,
    destination: destinoLoc,
    waypoints,
    optimizeWaypoints: false, // já está na ordem ótima
    travelMode: google.maps.TravelMode.DRIVING
  }, (res, status) => {
    if (status !== "OK" || !res?.routes?.[0]?.legs?.length) { esconderWhats(); return; }
    const totalMeters = res.routes[0].legs.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0);
    const kmInt = Math.floor(totalMeters / 1000); // cobrar só km inteiro pra baixo
    finalizarOrcamentoComKm(kmInt, mids, servico, totalMeters); // mids = paradas; ENTREGA = destinoPlace
  });
}

/**
 * Otimiza com RETIRADA fixa. ENTREGA (se houver) vira candidata junto das PARADAS.
 * O algoritmo testa cada candidato como destino final e otimiza o restante como intermediárias.
 */
function otimizarRotaComGoogle() {
  if (!window.google || !google.maps?.DirectionsService) {
    alert("Google Maps não carregou ainda. Tente novamente em alguns segundos.");
    return;
  }
  if (!origemPlace?.geometry?.location) {
    alert("Defina a RETIRADA antes de otimizar.");
    return;
  }

  // Reconciliar paradas digitadas
  const inputsParadas = Array.from(document.querySelectorAll('[id^="parada-"]'));
  const tasks = inputsParadas.map(async (inp, idx) => {
    const txt = (inp.value || "").trim();
    if (!txt) return null;
    let p = paradasPlaces[idx];
    if (!p?.geometry?.location) {
      p = await geocodeByText(txt);
      if (p?.geometry?.location) paradasPlaces[idx] = p;
    }
    return (p?.geometry?.location) ? p : null;
  });

  Promise.all(tasks).then(async (list) => {
    const paradasValidas = list.filter(Boolean);

    const candidatos = [...paradasValidas];
    if (destinoPlace?.geometry?.location) candidatos.push(destinoPlace);

    if (!candidatos.length) {
      alert("Adicione pelo menos uma PARADA ou informe uma ENTREGA para otimizar.");
      return;
    }

    initDirectionsOnce();

    function locStr(place){ return place.formatted_address || placeToLatLngStr(place); }
    function routeWith(origin, destination, waypointsArr) {
      return new Promise((resolve) => {
        directionsService.route({
          origin, destination, waypoints: waypointsArr, optimizeWaypoints: true, travelMode: google.maps.TravelMode.DRIVING
        }, (result, status) => {
          if (status !== "OK") return resolve(null);
          const legs = result?.routes?.[0]?.legs || [];
          const totalMeters = legs.reduce((a, l) => a + (l.distance?.value || 0), 0);
          const totalSecs   = legs.reduce((a, l) => a + (l.duration?.value || 0), 0);
          resolve({ result, totalMeters, totalSecs });
        });
      });
    }

    let best = null;

    const origin = locStr(origemPlace);
    for (let i = 0; i < candidatos.length; i++) {
      const dest = locStr(candidatos[i]);
      const mids = candidatos.filter((_, j) => j !== i).map(p => ({ location: locStr(p), stopover: true }));
      const trial = await routeWith(origin, dest, mids);
      if (!trial) continue;
      if (!best || trial.totalSecs < best.totalSecs) best = { ...trial, destIndex: i };
    }

    if (!best) { alert("Não consegui otimizar a rota agora. Tente novamente."); return; }

    const midsOrder = best.result.routes[0].waypoint_order || [];
    const midsList  = candidatos.filter((_, j) => j !== best.destIndex);
    const orderedMids = midsOrder.map(i => midsList[i]);
    const lastStop = candidatos[best.destIndex];
    const ordered = [...orderedMids, lastStop];

    // Atualiza estado e inputs na ordem ótima (último vira ENTREGA)
    paradasPlaces = [...ordered.slice(0, -1)];
    destinoPlace  = lastStop;
    aplicarOrdemOtimizadaNosInputs(ordered);

    try { directionsRenderer.setDirections(best.result); } catch(e) {}
    renderResumoOtimizacao(best.result);
  });
}

// === ROTA OTIMIZADA -> rolar até o botão verde "Calcular rota otimizada" ===
(function setupScrollToOptimizedButton() {
  const HEADER_OFFSET = 0; // se tiver header fixo cobrindo o topo, coloque por ex.: 96
  const TEXT_ROTA = /^\s*rota\s+otimizada\s*$/i;
  const TEXT_CALCULAR = /^\s*calcular\s+rota\s+otimizada\s*$/i;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findButtonByText(re) {
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const el of candidates) {
      const txt = (el.textContent || el.value || '').trim();
      if (re.test(txt)) return el;
    }
    return null;
  }

  function scrollToEl(el) {
    const y = el.getBoundingClientRect().top + window.pageYOffset - HEADER_OFFSET;
    window.scrollTo({ top: y, behavior: 'smooth' });
    // micro realce sem CSS extra
    const old = el.style.boxShadow;
    el.style.boxShadow = '0 0 0 6px rgba(0,0,0,0.15)';
    setTimeout(() => { el.style.boxShadow = old; }, 700);
    try { el.focus({ preventScroll: true }); } catch {}
  }

  // espera o botão existir/ficar visível (até ~5s)
  function waitForOptimizedCalculateBtn(onFound) {
    // 1) tenta agora
    let target = findButtonByText(TEXT_CALCULAR);
    if (target && isVisible(target)) { onFound(target); return () => {}; }

    // 2) observa mutações (aparição tardia)
    const obs = new MutationObserver(() => {
      target = findButtonByText(TEXT_CALCULAR);
      if (target && isVisible(target)) {
        obs.disconnect();
        clearInterval(poll);
        clearTimeout(stopAll);
        onFound(target);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // 3) polling (fallback pra casos em que o botão troca só texto/estilo)
    const poll = setInterval(() => {
      target = findButtonByText(TEXT_CALCULAR);
      if (target && isVisible(target)) {
        obs.disconnect();
        clearInterval(poll);
        clearTimeout(stopAll);
        onFound(target);
      }
    }, 100);

    // 4) limite de segurança (5s)
    const stopAll = setTimeout(() => {
      obs.disconnect();
      clearInterval(poll);
    }, 5000);

    // retorna função pra cancelar (não precisamos aqui, mas fica limpo)
    return () => { obs.disconnect(); clearInterval(poll); clearTimeout(stopAll); };
  }

  // captura clique no botão/label de "ROTA OTIMIZADA" (sem mexer no HTML)
  document.addEventListener('click', (ev) => {
    const el = ev.target && ev.target.closest('button, [role="button"], a, label, .btn, .button');
    if (!el) return;
    const txt = (el.textContent || el.value || '').trim();
    if (!TEXT_ROTA.test(txt)) return;

    // deixa o clique fazer o que já faz (abrir o card/sugestão do Google)
    // e em seguida aguarda o botão verde aparecer para rolar até ele
    setTimeout(() => {
      waitForOptimizedCalculateBtn((btn) => scrollToEl(btn));
    }, 0);
  }, { passive: true });
})();


// ===================== Init =====================
function initOrcamento() {
  ensureMotoTipoControl();
  configurarAutocomplete();
  ensureOptimizeUI();
  ensureBackToTopUI();
  configurarEventos();
  esconderWhats();
}
window.initOrcamento = initOrcamento;
