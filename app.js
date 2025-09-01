// ===================== Estado principal =====================
let origemPlace = null;
let destinoPlace = null;

// ===== Config — seu número do Whats =====
const WHATS_NUM = "5511983297840"; // DDI+DDD+NÚMERO, só dígitos

// ===== Estado das paradas =====
let paradasPlaces = [];    // Places selecionados nas paradas
let contadorParadas = 0;   // p/ gerar IDs únicos

// ===== Economia: parâmetros ajustáveis (mais responsivo que antes) =====
const MIN_CHARS       = 3;           // mínimo de letras para sugerir
const DEBOUNCE_MS     = 450;         // espera sem digitar antes de consultar
const MAX_PREDICTIONS = 4;           // máximo de itens na lista
const COUNTRY_CODE    = "br";        // restringe ao Brasil
const CACHE_TTL_MS    = 5 * 60 * 1000; // 5 min

// ===== Caches locais (memória) =====
const predCache    = new Map(); // key: texto -> { ts, predictions }
const detailsCache = new Map(); // key: placeId -> { ts, place }

// ===== Utils =====
const fmtBRL = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Tabela de preço
function calcularPreco(km) {
  const k = Number(km);
  if (k <= 5.9) return 40;
  if (k <= 12.0) return 45;
  return 20 + (2 * k);
}

// Mensagem estilo Whats (texto -> URL-encoded) — com SERVIÇO no topo
function montarMensagem(origem, destino, km, valor, servicoTxt) {
  const kmTxt = Number(km).toFixed(0); // agora inteiro
  const linhas = [
    `*SERVIÇO: ${servicoTxt}*`,
    "",
    "*RETIRADA*",
    "📍 " + origem,
    "",
    "*ENTREGA*",
    "📍 " + destino,
    "",
    "🛣️ *Km* " + kmTxt,
    "💵 *R$* " + fmtBRL(valor)
  ];
  const texto = linhas.join("\n");
  return encodeURIComponent(texto);
}

// ===== Debounce helper =====
function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// ===================== Autocomplete "econômico" =====================
function setupInputAutocomplete({ inputEl, onPlaceChosen }) {
  if (!window.google || !google.maps?.places) return;

  const acService  = new google.maps.places.AutocompleteService();
  const placesSvc  = new google.maps.places.PlacesService(document.createElement("div"));
  let sessionToken = new google.maps.places.AutocompleteSessionToken();

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
    list.style.left = `${r.left + window.scrollX}px`;
    list.style.top  = `${r.bottom + window.scrollY + 6}px`;
    list.style.width = `${r.width}px`;
  }
  window.addEventListener("resize", positionList);
  window.addEventListener("scroll", positionList, true);
  inputEl.addEventListener("focus", positionList);

  const hideList = () => { list.style.display = "none"; list.innerHTML = ""; };
  const showList = () => { list.style.display = "block"; };

  function renderPredictions(preds) {
    list.innerHTML = "";
    if (!preds || !preds.length) { hideList(); return; }
    preds.slice(0, MAX_PREDICTIONS).forEach(p => {
      const item = document.createElement("button");
      item.type = "button";
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
      item.addEventListener("mouseover", () => item.style.background = "rgba(255,255,255,.04)");
      item.addEventListener("mouseout",  () => item.style.background = "transparent");

      item.innerHTML = `
        <div style="font-weight:600">${p.structured_formatting?.main_text || p.description}</div>
        <div style="font-size:12px;color:#a9b2c3">${p.structured_formatting?.secondary_text || ""}</div>
      `;

      item.addEventListener("click", () => {
        const cached = detailsCache.get(p.place_id);
        const fresh  = cached && (Date.now() - cached.ts < CACHE_TTL_MS) ? cached.place : null;

        const finish = (place) => {
          inputEl.value = place.formatted_address || p.description;
          hideList();
          sessionToken = new google.maps.places.AutocompleteSessionToken();
          onPlaceChosen(place);
        };

        if (fresh) { finish(fresh); return; }

        placesSvc.getDetails({
          placeId: p.place_id,
          fields: ["formatted_address","geometry"],
          sessionToken
        }, (place, status) => {
          if (status === "OK" && place?.geometry?.location) {
            detailsCache.set(p.place_id, { ts: Date.now(), place });
            finish(place);
          } else {
            hideList();
          }
        });
      });

      list.appendChild(item);
    });
    showList();
    positionList();
  }

  const requestPredictions = debounce(() => {
    const q = inputEl.value.trim();
    if (q.length < MIN_CHARS) { hideList(); return; }

    const cached = predCache.get(q);
    if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
      renderPredictions(cached.predictions);
      return;
    }

    acService.getPlacePredictions({
      input: q,
      sessionToken,
      componentRestrictions: { country: COUNTRY_CODE },
      types: ["address"]
    }, (predictions, status) => {
      if (status !== "OK" || !predictions?.length) { hideList(); return; }
      predCache.set(q, { ts: Date.now(), predictions });
      renderPredictions(predictions);
    });
  }, DEBOUNCE_MS);

  inputEl.addEventListener("input", requestPredictions);
  inputEl.addEventListener("blur", () => setTimeout(hideList, 150));
}

// ===================== Autocomplete nos campos =====================
function configurarAutocomplete() {
  if (!window.google || !google.maps?.places) return;

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

// Cria um novo input de parada
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

// ===================== Cálculo e UI =====================
function configurarEventos() {
  const btnCalcular = document.getElementById("btnCalcular");
  const btnWhats    = document.getElementById("btnWhats");
  const btnLimpar   = document.getElementById("btnLimpar");
  const mDistEl     = document.getElementById("mDist");
  const mValorEl    = document.getElementById("mValor");

  esconderWhats();

  btnWhats.addEventListener("click", (e)=>{
    if (btnWhats.getAttribute("aria-disabled") === "true") e.preventDefault();
  });

  btnLimpar.addEventListener("click", limparTudo);

  btnCalcular.addEventListener("click", () => {
    if (!window.google || (!google.maps?.DistanceMatrixService && !google.maps?.DirectionsService)) {
      mDistEl.textContent  = "—";
      mValorEl.textContent = "—";
      esconderWhats();
      return;
    }

    if (!origemPlace || !destinoPlace) {
      mDistEl.textContent  = "—";
      mValorEl.textContent = "—";
      esconderWhats();
      return;
    }

    const waypoints = (paradasPlaces || [])
      .filter(p => p && p.geometry && p.geometry.location)
      .map(p => ({ location: p.geometry.location, stopover: true }));

    const finalizarComKm = (km) => {
      const valor = calcularPreco(km);
      mDistEl.textContent  = `${km} km`;
      mValorEl.textContent = fmtBRL(valor);

      const servicoSel = document.getElementById("servico");
      const servicoMap = { moto: "Moto", carro: "Carro", fiorino: "Fiorino" };
      const servicoTxt = servicoMap[servicoSel.value] || "Serviço";

      const textoURL = montarMensagem(
        origemPlace.formatted_address,
        destinoPlace.formatted_address,
        km,
        valor,
        servicoTxt
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
        const km = Math.round(totalMeters / 1000); // inteiro agora
        finalizarComKm(km);
      });
    } else {
      const svc = new google.maps.DistanceMatrixService();
      svc.getDistanceMatrix({
        origins:      [origemPlace.geometry.location],
        destinations: [destinoPlace.geometry.location],
        travelMode:   google.maps.TravelMode.DRIVING
      }, (res, status) => {
        if (status !== "OK") { esconderWhats(); return; }
        const el = res?.rows?.[0]?.elements?.[0];
        if (!el || el.status !== "OK") { esconderWhats(); return; }
        const km = Math.round(el.distance.value / 1000); // inteiro agora
        finalizarComKm(km);
      });
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

    mDistEl.textContent  = "—";
    mValorEl.textContent = "—";

    esconderWhats();
    origemInput.focus();
  }
}

// ===================== Callback do Google =====================
function initOrcamento() {
  configurarAutocomplete();  
  configurarEventos();
}
window.initOrcamento = initOrcamento;
