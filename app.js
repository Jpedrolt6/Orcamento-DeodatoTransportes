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
const DEBOUNCE_MS     = 800;
const MAX_PREDICTIONS = 4;
const COUNTRY_CODE    = "br";
const CACHE_TTL_MS    = 5 * 60 * 1000;

// ===== Caches locais =====
const predCache    = new Map();
const detailsCache = new Map();

// ===== Favoritos locais (salvos por cliente no navegador) =====
function loadFavoritos() {
  try { return JSON.parse(localStorage.getItem("favoritosEnderecos") || "[]"); }
  catch { return []; }
}
function saveFavoritos(arr) {
  localStorage.setItem("favoritosEnderecos", JSON.stringify(arr));
}
function addFavorito(endereco) {
  if (!endereco) return;
  let favs = loadFavoritos();
  if (!favs.includes(endereco)) {
    favs.push(endereco);
    saveFavoritos(favs);
  }
}

// ===== Utils =====
const fmtBRL = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// ---------- Regras de preço (MOTO) ----------
function calcularPrecoMoto(kmInt, qtdParadas, pedagio = 0) {
  let base = 0;
  if (kmInt <= 5) {
    base = 40;
  } else if (kmInt <= 12) {
    base = 45;
  } else if (kmInt <= 85) {
    base = 20 + (2 * kmInt);
  } else {
    base = 190 + (kmInt - 85) * 3;
  }
  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 5; // moto: R$5 cada
  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}

// ---------- Regras de preço (CARRO) ----------
function calcularPrecoCarro(kmInt, qtdParadas, pedagio = 0) {
  let base = 0;

  if (kmInt <= 12) {
    base = 100; // 0–12 km
  } else if (kmInt <= 19) {
    base = 110; // 13–19 km
  } else if (kmInt <= 33) {
    base = 130; // 20–33 km
  } else if (kmInt <= 69) {
    base = 4.0 * kmInt; // 34–69 km → R$4,00 por km (ex.: 34km = 136)
  } else {
    // 70 km em diante:
    // Até 69 km = 69 * 4 = 276
    // Excedente = (kmInt - 69) * 4.5
    base = 276 + (kmInt - 69) * 4.5;
  }

  // Carro: paradas adicionais = R$10 cada
  const taxaParadas = Math.max(0, Number(qtdParadas) || 0) * 10;

  const total = base + taxaParadas + (Number(pedagio) || 0);
  return Math.max(0, Math.round(total));
}

// ---------- Monta mensagem de WhatsApp ----------
function montarMensagem(origem, destino, kmInt, valor, servicoTxt, paradasList = []) {
  const linhas = [
    "*RETIRADA*",
    "📍 " + origem,
    ""
  ];

  if (paradasList.length) {
    paradasList.forEach((p, i) => {
      const end = p?.formatted_address || p?.description || "";
      if (end) {
        linhas.push(`*PARADA ${i + 1}*`, "📍 " + end, "");
      }
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
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
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
          resolve({
            formatted_address: res[0].formatted_address,
            geometry: { location: res[0].geometry.location }
          });
        } else {
          resolve(null);
        }
      }
    );
  });
}

// ===================== Autocomplete "econômico" =====================
function setupInputAutocomplete({ inputEl, onPlaceChosen }) {
  if (!window.google || !google.maps?.places) return;

  const acService  = new google.maps.places.AutocompleteService();
  const placesSvc  = new google.maps.places.PlacesService(document.createElement("div"));
  let sessionToken = new google.maps.places.AutocompleteSessionToken();

  let activeIndex = -1; // item ativo no teclado

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
          sessionToken = new google.maps.places.AutocompleteSessionToken(); // nova sessão
          onPlaceChosen(place);
        };

        if (fresh) { finish(fresh); return; }

        if (p.place_id.startsWith("fav-")) {
          geocodeByText(p.description).then((place) => {
            if (place) {
              detailsCache.set(p.place_id, { ts: Date.now(), place });
              finish(place);
            } else {
              hideList();
            }
          });
          return;
        }

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

    // 1) Favoritos locais primeiro
    const favs = loadFavoritos();
    const matches = favs
      .filter(f => f.toLowerCase().includes(q.toLowerCase()))
      .map(f => ({
        description: f,
        structured_formatting: { main_text: f, secondary_text: "Favorito" },
        place_id: "fav-" + f
      }));

    if (matches.length) {
      renderPredictions(matches);
      return;
    }

    // 2) Cache
    const cached = predCache.get(q);
    if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
      renderPredictions(cached.predictions);
      return;
    }

    // 3) Google
    acService.getPlacePredictions({
      input: q,
      sessionToken,
      componentRestrictions: { country: COUNTRY_CODE }
    }, (predictions, status) => {
      if (status !== "OK" || !predictions?.length) { hideList(); return; }
      predCache.set(q, { ts: Date.now(), predictions });
      renderPredictions(predictions);
    });
  }, DEBOUNCE_MS);

  // Navegação via teclado
  inputEl.addEventListener("keydown", (ev) => {
    const items = list.querySelectorAll("button");
    if (!items.length) return;

    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      items.forEach((btn, i) => btn.classList.toggle("active", i === activeIndex));
      items[activeIndex].scrollIntoView({ block: "nearest" });
    }
    else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      items.forEach((btn, i) => btn.classList.toggle("active", i === activeIndex));
      items[activeIndex].scrollIntoView({ block: "nearest" });
    }
    else if (ev.key === "Enter") {
      if (activeIndex >= 0) {
        ev.preventDefault();
        items[activeIndex].click();
      }
    }
    else if (ev.key === "Escape") {
      hideList();
    }
  });

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
    // Para CARRO: remover baú/peso, deixar só a espera de carro
    rulesList.innerHTML = `
      <li>Espera: R$ 0,70/min após 20 min</li>
    `;
  } else {
    // Para MOTO (e por enquanto FIORINO usa o mesmo padrão antigo)
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
    }
    if (!destinoPlace?.geometry?.location && destinoInput?.value) {
      destinoPlace = await geocodeByText(destinoInput.value.trim());
    }

    // percorre inputs de paradas
    const inputsParadas = Array.from(document.querySelectorAll('[id^="parada-"]'));
    const paradasValidas = [];

    for (let i = 0; i < inputsParadas.length; i++) {
      const txt = inputsParadas[i].value?.trim();
      if (!txt) continue;

      let place = paradasPlaces[i];
      if (!place?.geometry?.location) {
        place = await geocodeByText(txt);
        paradasPlaces[i] = place;
      }
      if (place?.geometry?.location) {
        paradasValidas.push(place);
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
      if (servico === "carro") {
        valor = calcularPrecoCarro(kmInt, paradasValidas.length, pedagioVal);
      } else if (servico === "moto") {
        valor = calcularPrecoMoto(kmInt, paradasValidas.length, pedagioVal);
      } else {
        // provisório: fiorino ainda sem tabela -> usa moto até definirmos
        valor = calcularPrecoMoto(kmInt, paradasValidas.length, pedagioVal);
      }

      mDistEl.textContent  = `${kmInt} km`;
      mValorEl.textContent = fmtBRL(valor);

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

      // salva endereços usados como favoritos locais
      addFavorito(origemPlace.formatted_address);
      addFavorito(destinoPlace.formatted_address);
      paradasValidas.forEach((p) => addFavorito(p.formatted_address || p.description));
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

    // ao limpar, atualiza regras conforme serviço atual
    const servicoSel  = document.getElementById("servico");
    if (servicoSel) updateRules(servicoSel.value);
  }
}

// ===================== Callback do Google =====================
function initOrcamento() {
  configurarAutocomplete();
  configurarEventos();
}
window.initOrcamento = initOrcamento;
