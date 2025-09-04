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
const DEBOUNCE_MS     = 150;   // MAIS RÁPIDO
const MAX_PREDICTIONS = 8;     // ↑ deixa espaço pra mostrar mais
const MIN_SUGGESTIONS = 3;     // << mínimo garantido na caixinha
const COUNTRY_CODE    = "br";
const CACHE_TTL_MS    = 3 * 60 * 1000; // 3min

// ===== Caches locais =====
const predCache    = new Map();
const detailsCache = new Map();

// ===== Utils =====
const fmtBRL = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// ---------------------------------------------------------------------------
//                        ✅ Places API (New) – REST
// ---------------------------------------------------------------------------
// 🔑 SUA CHAVE:
const PLACES_API_KEY = "AIzaSyAhGvrR_Gp4e0ROB1BInjNBSUQdHEh6ews";
const PLACES_BASE = "https://places.googleapis.com/v1";

// Foco em São Paulo (viés geográfico p/ sugestões mais próximas)
const SP_CENTER = { latitude: -23.55052, longitude: -46.633308 };
const SP_BIAS   = { circle: { center: SP_CENTER, radius: 50000 } }; // ~75 km

// Field Masks: pedimos só o essencial (rápido e barato)
const FM_AUTOCOMPLETE = [
  "suggestions.placePrediction.placeId",
  "suggestions.placePrediction.text",
  "suggestions.structuredFormat.mainText",
  "suggestions.structuredFormat.secondaryText"
].join(",");
const FM_DETAILS = ["id","displayName","formattedAddress","location"].join(",");
const FM_SEARCH  = ["places.id","places.displayName","places.formattedAddress","places.location"].join(",");

// Gera token de sessão p/ autocomplete (um por ciclo de digitação)
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

// Normaliza sugestões
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

// Autocomplete (New API) com bias de SP
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

// Text Search (fallback “fuzzy”) com bias de SP
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

// Details (New API)
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
function calcularPrecoMoto(kmInt, qtdParadas, pedagio = 0) {
  let base = 0;
  if (kmInt <= 5) base = 40;
  else if (kmInt <= 12) base = 45;
  else if (kmInt <= 85) base = 20 + (2 * kmInt);
  else base = 190 + (kmInt - 85) * 3;
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

// ---------- Monta mensagem WhatsApp ----------
function montarMensagem(origem, destino, kmInt, valor, servicoTxt, paradasList = []) {
  const linhas = ["*RETIRADA*","📍 " + origem,""];
  if (paradasList.length) {
    paradasList.forEach((p, i) => {
      const end = p?.formatted_address || p?.description || "";
      if (end) linhas.push(`*PARADA ${i + 1}*`, "📍 " + end, "");
    });
  }
  linhas.push(
    "*ENTREGA*",
    "📍 " + destino,
    "",
    `*Tipo de veículo:* ${servicoTxt}`,
    "",
    "🛣️ Km " + kmInt,
    "💵 " + fmtBRL(valor)
  );
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

// ===== Pill “Adicionar número” (piu) =====
function showAddNumeroHint(inputEl) {
  if (!inputEl) return;
  const container = (inputEl.closest(".field") || inputEl.parentElement || document.body);
  if (container.querySelector(".add-num-pill-js") && !/\d{1,5}/.test(inputEl.value)) return;

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "add-num-pill-js";
  pill.style.cssText = [
    "display:inline-flex","align-items:center","gap:6px",
    "padding:6px 10px","border-radius:999px",
    "background:#102036","color:#cfe3ff","border:1px solid #274165",
    "font-size:12px","cursor:pointer","margin-top:6px"
  ].join(";");
  pill.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="margin-right:2px">
      <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    Adicionar número
  `;

  const removeIfHasNumber = () => { if (/\d{1,5}/.test(inputEl.value)) pill.remove(); };

  pill.addEventListener("click", () => {
    if (!/,\s*$/.test(inputEl.value)) inputEl.value = inputEl.value.replace(/\s+$/, "") + ", ";
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  });

  inputEl.addEventListener("input", removeIfHasNumber, { once: false });
  setTimeout(() => pill.remove(), 10000);
  container.appendChild(pill);
}

// ===================== Autocomplete (Places New) =====================
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
        const cached = detailsCache.get(p.place_id);
        const fresh  = cached && (Date.now() - cached.ts < CACHE_TTL_MS) ? cached.place : null;

        const finish = (place) => {
          inputEl.value = place.formatted_address || p.description;
          // limpamos alerta + piu de número
          clearInvalid(inputEl);
          if (!/\d{1,5}/.test(inputEl.value)) showAddNumeroHint(inputEl);

          hideList();
          sessionToken = newSessionToken();
          try { onPlaceChosen && onPlaceChosen(place); } catch {}
        };

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

  const requestPredictions = debounce(async () => {
    const q = inputEl.value.trim();
    if (q.length < MIN_CHARS) { hideList(); return; }

    // 1) Cache
    const cached = predCache.get(q);
    if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
      renderPredictions(cached.predictions);
      return;
    }

    // 2) Google (Places API New) — Autocomplete (com viés SP)
    let norm = [];
    try {
      const data = await placesNewAutocomplete({
        input: q,
        sessionToken,
        region: COUNTRY_CODE,
        language: "pt-BR"
      });
      norm = normalizeNewSuggestions(data);
    } catch {
      norm = [];
    }

    // 3) Fallback “fuzzy”: se não veio nada, tenta SearchText
    if (!norm.length) {
      try {
        const st = await placesNewSearchText(q, "pt-BR");
        norm = normalizeSearchToSuggestions(st);
      } catch {
        norm = [];
      }
    }

    predCache.set(q, { ts: Date.now(), predictions: norm });
    renderPredictions(norm);
  }, DEBOUNCE_MS);

  // ====== Navegação via teclado (ENTER sempre escolhe o 1º se nenhum ativo) ======
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
      else items[0].click(); // <<< pega o primeiro SEMPRE
    } else if (ev.key === "Escape") {
      hideList();
    }
  });

  // Clique antes do blur — evita “perder” a seleção
  document.addEventListener('pointerdown', (ev) => {
    const btn = ev.target?.closest?.('.suggestions__item');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    try { btn.click(); } catch {}
  }, true);

  inputEl.addEventListener("input", () => { requestPredictions(); clearInvalid(inputEl); });
  inputEl.addEventListener("blur", () => setTimeout(hideList, 150));
}

// ===================== Autocomplete nos campos =====================
function configurarAutocomplete() {
  if (!window.google) return;

  const origemInput  = document.getElementById("origem");
  const destinoInput = document.getElementById("destino");

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
  setupInputAutocomplete({
    inputEl: input,
    onPlaceChosen: (place) => { paradasPlaces[idx] = place; }
  });
}

// ===================== Regras do serviço (UI dinâmica) =====================
function updateRules(servico) {
  const rulesList = document.querySelector(".rules ul");
  if (!rulesList) return;

  if (servico === "carro") {
    rulesList.innerHTML = `<li>Espera: R$ 0,70/min após 20 min</li>`;
  } else {
    rulesList.innerHTML = `
      <li>Baú máx.: 44 × 42 × 32 cm</li>
      <li>Peso máx.: 20 kg</li>
      <li>Espera: R$ 0,60/min após 15 min</li>
    `;
  }
}

// ===================== Cálculo e UI =====================
function configurarEventos() {
  const btnCalcular = document.getElementById("btnCalcular");
  const btnWhats    = document.getElementById("btnWhats");
  const btnLimpar   = document.getElementById("btnLimpar");
  const mDistEl     = document.getElementById("mDist");
  const mValorEl    = document.getElementById("mValor");
  const servicoSel  = document.getElementById("servico");

  // atualizar regras na troca de serviço
  if (servicoSel) {
    updateRules(servicoSel.value);
    servicoSel.addEventListener("change", () => updateRules(servicoSel.value));
  }

  esconderWhats();

  btnWhats.addEventListener("click", (e)=>{
    if (btnWhats.getAttribute("aria-disabled") === "true") e.preventDefault();
  });

  btnLimpar.addEventListener("click", limparTudo);

  btnCalcular.addEventListener("click", async () => {
    if (!window.google) {
      mDistEl.textContent  = "—";
      mValorEl.textContent = "—";
      esconderWhats();
      return;
    }

    const origemInput  = document.getElementById("origem");
    const destinoInput = document.getElementById("destino");

    if (!origemPlace?.geometry?.location && origemInput?.value) {
      origemPlace = await geocodeByText(origemInput.value.trim());
      if (origemPlace?.geometry?.location) clearInvalid(origemInput);
    }
    if (!destinoPlace?.geometry?.location && destinoInput?.value) {
      destinoPlace = await geocodeByText(destinoInput.value.trim());
      if (destinoPlace?.geometry?.location) clearInvalid(destinoInput);
    }

    // percorre inputs de paradas
    const inputsParadas = Array.from(document.querySelectorAll('[id^="parada-"]'));
    const paradasValidas = [];

    for (let i = 0; i < inputsParadas.length; i++) {
      const txt = inputsParadas[i].value?.trim();
      if (!txt) { clearInvalid(inputsParadas[i]); continue; }

      let place = paradasPlaces[i];
      if (!place?.geometry?.location) {
        place = await geocodeByText(txt);
        paradasPlaces[i] = place;
      }
      if (place?.geometry?.location) {
        paradasValidas.push(place);
        clearInvalid(inputsParadas[i]);
      }
    }

    if (!origemPlace?.geometry?.location || !destinoPlace?.geometry?.location) {
      mDistEl.textContent  = "—";
      mValorEl.textContent = "—";
      esconderWhats();
      return;
    }

    const waypoints = paradasValidas.map(p => ({ location: p.geometry.location, stopover: true }));

    const finalizarComKm = (kmInt) => {
      const servico = servicoSel ? servicoSel.value : "moto";

      const pedagioInput = document.getElementById("pedagio");
      const pedagioVal = pedagioInput ? Number(pedagioInput.value || 0) : 0;

      let valor = 0;
      if (servico === "carro") valor = calcularPrecoCarro(kmInt, paradasValidas.length, pedagioVal);
      else if (servico === "moto") valor = calcularPrecoMoto(kmInt, paradasValidas.length, pedagioVal);
      else valor = calcularPrecoMoto(kmInt, paradasValidas.length, pedagioVal); // fiorino por enquanto

      mDistEl.textContent  = `${kmInt} km`;
      mValorEl.textContent = fmtBRL(valor);

      // limpa qualquer “vermelho” remanescente
      clearInvalid(document.getElementById('origem'));
      clearInvalid(document.getElementById('destino'));
      document.querySelectorAll('[id^="parada-"]').forEach(clearInvalid);

      const servicoMap = { moto: "Moto", carro: "Carro", fiorino: "Fiorino" };
      const servicoTxt = servicoMap[servico] || "Serviço";

      const textoURL = montarMensagem(
        origemPlace.formatted_address,
        destinoPlace.formatted_address,
        kmInt,
        valor,
        servicoTxt,
        paradasValidas
      );

      btnWhats.href = `https://api.whatsapp.com/send?phone=${WHATS_NUM}&text=${textoURL}`;
      btnWhats.setAttribute("aria-disabled", "false");
      btnWhats.removeAttribute("tabindex");
      mostrarWhats();
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

  function esconderWhats() {
    btnWhats.classList.add("hide");
    btnWhats.setAttribute("aria-disabled", "true");
    btnWhats.setAttribute("tabindex", "-1");
    btnWhats.href = "#";
  }
  function mostrarWhats() {
    btnWhats.classList.remove("hide");
  }

  function limparTudo() {
    const origemInput  = document.getElementById("origem");
    const destinoInput = document.getElementById("destino");
    origemInput.value = "";
    destinoInput.value = "";

    origemPlace = null;
    destinoPlace = null;

    const contParadas = document.getElementById("paradas");
    contParadas.innerHTML = "";
    paradasPlaces = [];
    contadorParadas = 0;

    const pesoInput = document.getElementById("peso");
    if (pesoInput) pesoInput.value = "1";
    const pedagioInput = document.getElementById("pedagio");
    if (pedagioInput) pedagioInput.value = "";

    const mDistEl = document.getElementById("mDist");
    const mValorEl = document.getElementById("mValor");
    mDistEl.textContent  = "—";
    mValorEl.textContent = "—";

    esconderWhats();
    origemInput.focus();

    const servicoSel  = document.getElementById("servico");
    if (servicoSel) updateRules(servicoSel.value);
  }
}

// ===================== Validação (erro vermelho) =====================
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
  hint.textContent = hintMsg || 'Selecione um endereço válido da lista.';
}
function clearInvalid(input){
  if(!input) return;
  input.classList.remove('is-invalid');
  input.removeAttribute('aria-invalid');
  const hint = input.nextElementSibling;
  if(hint && hint.classList?.contains('err-hint')) hint.remove();
}

// ===================== Callback do Google =====================
function configurarEventosValidacao(){
  const origemInput  = document.getElementById("origem");
  const destinoInput = document.getElementById("destino");
  const btnCalcular  = document.getElementById("btnCalcular");

  if(!btnCalcular) return;

  // Validação em captura
  btnCalcular.addEventListener("click", function(){
    try{
      if(!(window.origemPlace && origemPlace.geometry && origemPlace.geometry.location)){
        if (origemInput && origemInput.value.trim()) markInvalid(origemInput, 'Selecione a opção sugerida para a Retirada.');
        else if (origemInput) markInvalid(origemInput, 'Informe o endereço de Retirada.');
      } else { clearInvalid(origemInput); }

      if(!(window.destinoPlace && destinoPlace.geometry && destinoPlace.geometry.location)){
        if (destinoInput && destinoInput.value.trim()) markInvalid(destinoInput, 'Selecione a opção sugerida para a Entrega.');
        else if (destinoInput) markInvalid(destinoInput, 'Informe o endereço de Entrega.');
      } else { clearInvalid(destinoInput); }

      const inputsParadas = Array.from(document.querySelectorAll('[id^="parada-"]'));
      inputsParadas.forEach((inp, i)=>{
        const temTexto = (inp.value||"").trim().length > 0;
        const okPlace  = Array.isArray(window.paradasPlaces) && window.paradasPlaces[i]?.geometry?.location;
        if(temTexto && !okPlace){ markInvalid(inp, 'Selecione uma das opções da lista.'); }
        else { clearInvalid(inp); }
      });
    }catch{}
  }, true);

  // limpar ao digitar/focar
  [origemInput, destinoInput].filter(Boolean).forEach(inp=>{
    inp.addEventListener('input', ()=> clearInvalid(inp));
    inp.addEventListener('focus', ()=> clearInvalid(inp));
  });
  document.addEventListener('input', (e)=>{
    const el = e.target;
    if(el && typeof el.id === 'string' && el.id.startsWith('parada-')) clearInvalid(el);
  });
}

function initOrcamento() {
  configurarAutocomplete();
  configurarEventos();
  configurarEventosValidacao();
}
window.initOrcamento = initOrcamento;
