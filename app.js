"use strict";

const NOMINATIM = "https://nominatim.openstreetmap.org";

const state = {
  current: null, // full bilingual address object (see buildAddress)
  suggestions: [],
  activeIndex: -1,
};

const el = {
  searchInput: document.getElementById("searchInput"),
  suggestions: document.getElementById("suggestions"),
  card: document.getElementById("card"),
  nameZh: document.getElementById("nameZh"),
  nameEn: document.getElementById("nameEn"),
  streetZh: document.getElementById("streetZh"),
  streetEn: document.getElementById("streetEn"),
  district: document.getElementById("district"),
  map: document.getElementById("map"),
  cardLoading: document.getElementById("cardLoading"),
  status: document.getElementById("status"),
  favoriteBtn: document.getElementById("favoriteBtn"),
  copyBtn: document.getElementById("copyBtn"),
  shareBtn: document.getElementById("shareBtn"),
  favoritesSection: document.getElementById("favoritesSection"),
  favoritesList: document.getElementById("favoritesList"),
  fullscreen: document.getElementById("fullscreen"),
  fullscreenClose: document.getElementById("fullscreenClose"),
  fullNameZh: document.getElementById("fullNameZh"),
  fullNameEn: document.getElementById("fullNameEn"),
  fullStreetZh: document.getElementById("fullStreetZh"),
  fullStreetEn: document.getElementById("fullStreetEn"),
  fullDistrict: document.getElementById("fullDistrict"),
};

let map;
let mapMarker;

// ---------- Nominatim plumbing ----------

// Respect Nominatim's usage policy (max 1 req/s) with a simple throttle.
let nextAllowed = 0;
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function nominatim(url, signal) {
  const now = Date.now();
  const wait = Math.max(0, nextAllowed - now);
  nextAllowed = Math.max(now, nextAllowed) + 1100;
  if (wait) await sleep(wait);
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function qs(params) {
  return new URLSearchParams(params).toString();
}

function searchUrl(query, lang) {
  return `${NOMINATIM}/search?${qs({
    q: query,
    format: "jsonv2",
    limit: 7,
    addressdetails: 1,
    namedetails: 1,
    "accept-language": lang,
    // countrycodes=hk does not work: Nominatim indexes HK under China (cn).
    // Restrict geographically instead: left,top,right,bottom of Hong Kong.
    viewbox: "113.82,22.56,114.40,22.15",
    bounded: 1,
  })}`;
}

function lookupUrl(osmType, osmId, lang) {
  return `${NOMINATIM}/lookup?${qs({
    osm_ids: `${osmType[0].toUpperCase()}${osmId}`,
    format: "jsonv2",
    addressdetails: 1,
    namedetails: 1,
    "accept-language": lang,
  })}`;
}

// ---------- Parsing ----------

// HK OSM often stores bilingual values in one tag, e.g.
// addr:street = "崇平街 Sung Ping Street". Split into zh / en parts.
function splitBilingual(text) {
  if (!text) return { zh: "", en: "" };
  const zh = [];
  const en = [];
  for (const part of String(text).split(/([\u4e00-\u9fff]+)/)) {
    const p = part.trim();
    if (!p) continue;
    if (/[\u4e00-\u9fff]/.test(p)) zh.push(p);
    else en.push(p);
  }
  return {
    zh: zh.join(""),
    en: en.join(" ").replace(/\s+/g, " ").trim(),
  };
}

function parseZh(result) {
  const addr = result.address || {};
  const nd = result.namedetails || {};
  const name =
    nd["name:zh"] ||
    nd["name"] ||
    addr.building ||
    addr.amenity ||
    addr.shop ||
    addr.tourism ||
    addr.office ||
    addr.leisure ||
    addr.road ||
    result.name ||
    "";
  return {
    nameZh: name,
    nameEn: nd["name:en"] || "",
    roadZh: addr.road || "",
    roadEn: result.category === "highway" ? nd["name:en"] || "" : "",
    houseNumber: addr.house_number || "",
    suburbZh:
      addr.suburb || addr.quarter || addr.neighbourhood || addr.city || "",
    lat: parseFloat(result.lat),
    lon: parseFloat(result.lon),
    osmType: result.osm_type,
    osmId: result.osm_id,
  };
}

function parseEn(result) {
  const addr = result.address || {};
  const nd = result.namedetails || {};
  const name =
    nd["name:en"] ||
    nd["name"] ||
    addr.building ||
    addr.amenity ||
    addr.shop ||
    addr.tourism ||
    addr.office ||
    addr.leisure ||
    addr.road ||
    result.name ||
    "";
  return {
    nameEn: name,
    roadEn: addr.road || "",
    houseNumber: addr.house_number || "",
    suburbEn:
      addr.suburb || addr.quarter || addr.neighbourhood || addr.city || "",
  };
}

function buildAddress(zh, en) {
  return {
    nameZh: zh.nameZh,
    nameEn: en.nameEn || zh.nameEn,
    roadZh: zh.roadZh,
    roadEn: en.roadEn || zh.roadEn,
    houseNumber: zh.houseNumber || en.houseNumber,
    suburbZh: zh.suburbZh,
    suburbEn: en.suburbEn,
    lat: zh.lat,
    lon: zh.lon,
  };
}

// Format "street + number" for each language.
function formatStreetZh(loc) {
  if (!loc.roadZh) return "";
  return loc.houseNumber
    ? `${loc.roadZh} ${loc.houseNumber}號`
    : loc.roadZh;
}
function formatStreetEn(loc) {
  if (!loc.roadEn) return "";
  return loc.houseNumber
    ? `${loc.houseNumber} ${loc.roadEn}`
    : loc.roadEn;
}

// ---------- API actions ----------

async function search(query, signal) {
  return nominatim(searchUrl(query, "zh"), signal);
}

// Enrich a Chinese search result with English and raw OSM address tags.
async function enrichResult(zhResult) {
  const zh = parseZh(zhResult);
  // Road results already contain the street name; avoid an unnecessary
  // Overpass request that can fail or delay displaying the address.
  if (zhResult.category === "highway" && zh.osmType === "way" && zh.roadZh) {
    return buildAddress(zh, { nameEn: zh.nameEn, roadEn: zh.roadEn });
  }
  // Nominatim omits addr:street for some objects (e.g. landuse areas),
  // so pull the raw tags from Overpass for reliable street + number.
  const tags = await overpassTags(zh.osmType, zh.osmId);
  if (tags) {
    return buildAddressFromTags(tags, zh);
  }
  const enResult = await nominatim(lookupUrl(zh.osmType, zh.osmId, "en"));
  const en = parseEn(Array.isArray(enResult) ? enResult[0] : enResult);
  return buildAddress(zh, en);
}

// ---------- Overpass (raw OSM tags) ----------

async function overpassTags(osmType, osmId) {
  const type = { node: "node", way: "way", relation: "relation" }[osmType];
  if (!type) return null;
  const query = `[out:json];${type}(${osmId});out tags;`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const el = data.elements && data.elements[0];
    return (el && el.tags) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildAddressFromTags(tags, fallback) {
  const street = splitBilingual(tags["addr:street"]);
  const city = splitBilingual(
    tags["addr:city"] || tags["addr:suburb"] || tags["addr:district"]
  );
  const name = splitBilingual(tags.name);
  return {
    nameZh: tags["name:zh"] || name.zh || fallback.nameZh,
    nameEn: tags["name:en"] || name.en || fallback.nameEn,
    roadZh: street.zh || fallback.roadZh,
    roadEn: street.en || fallback.roadEn,
    houseNumber: tags["addr:housenumber"] || fallback.houseNumber,
    suburbZh: city.zh || fallback.suburbZh,
    suburbEn: city.en || fallback.suburbEn,
    lat: fallback.lat,
    lon: fallback.lon,
  };
}

// ---------- Address display ----------

function setStatus(msg, isError) {
  el.status.textContent = msg;
  el.status.className = "status" + (isError ? " error" : "");
}

function displayAddress(loc) {
  const nameZh = loc.nameZh || loc.roadZh || "Unknown";
  const nameEn = loc.nameEn || loc.roadEn || "";
  const streetZh = formatStreetZh(loc);
  const streetEn = formatStreetEn(loc);
  // Avoid repeating the street if the name already is the street.
  const showStreetZh = streetZh && streetZh !== nameZh ? streetZh : "";
  const showStreetEn = streetEn && streetEn !== nameEn ? streetEn : "";
  const district =
    [loc.suburbZh, loc.suburbEn].filter(Boolean).join(" · ");
  return { nameZh, nameEn, streetZh: showStreetZh, streetEn: showStreetEn, district };
}

function renderAddress(loc) {
  const { nameZh, nameEn, streetZh, streetEn, district } = displayAddress(loc);

  el.nameZh.textContent = nameZh;
  el.nameEn.textContent = nameEn;
  el.streetZh.textContent = streetZh;
  el.streetEn.textContent = streetEn;
  el.district.textContent = district;
  el.district.hidden = !district;

  el.fullNameZh.textContent = nameZh;
  el.fullNameEn.textContent = nameEn;
  el.fullStreetZh.textContent = streetZh;
  el.fullStreetEn.textContent = streetEn;
  el.fullDistrict.textContent = district;
  el.fullDistrict.hidden = !district;
}

function showMap(loc) {
  if (!window.L || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return;

  const position = [loc.lat, loc.lon];
  el.map.hidden = false;
  if (!map) {
    map = L.map(el.map, { zoomControl: false, scrollWheelZoom: false }).setView(position, 17);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    mapMarker = L.marker(position).addTo(map);
  } else {
    map.setView(position, 17);
    mapMarker.setLatLng(position);
  }
  requestAnimationFrame(() => map.invalidateSize());
}

function showAddress(loc) {
  state.current = loc;
  renderAddress(loc);
  showMap(loc);
  el.cardLoading.hidden = true;
  el.favoriteBtn.disabled = false;
  el.copyBtn.disabled = false;
  el.shareBtn.disabled = false;
  setStatus("");
}

function clearAddress() {
  state.current = null;
  el.map.hidden = true;
  for (const field of [
    el.nameZh,
    el.nameEn,
    el.streetZh,
    el.streetEn,
    el.fullNameZh,
    el.fullNameEn,
    el.fullStreetZh,
    el.fullStreetEn,
    el.fullDistrict,
  ]) {
    field.textContent = "";
  }
  el.district.textContent = "";
  el.district.hidden = true;
  el.fullDistrict.hidden = true;
  el.favoriteBtn.disabled = true;
  el.copyBtn.disabled = true;
  el.shareBtn.disabled = true;
}

// ---------- Search suggestions ----------

let debounceTimer;
let searchController = null;

function cancelSearch() {
  if (searchController) {
    searchController.abort();
    searchController = null;
  }
}

function clearSuggestions() {
  el.suggestions.innerHTML = "";
  el.suggestions.hidden = true;
  state.suggestions = [];
  state.activeIndex = -1;
}

function suggestionNames(result) {
  const nd = result.namedetails || {};
  const addr = result.address || {};
  const zh =
    nd["name:zh"] || addr.building || addr.amenity || addr.shop || addr.road || "";
  const en =
    nd["name:en"] || addr.building || addr.amenity || addr.shop || addr.road || "";
  return { zh, en };
}

function suggestionSubtitle(result) {
  const addr = result.address || {};
  const type =
    result.category === "highway"
      ? result.type === "pedestrian"
        ? "Pedestrian street"
        : "Road"
      : result.category === "building"
        ? "Building"
        : result.type || result.category;
  const district = {
    "中西區": "Central and Western District",
    "灣仔區": "Wan Chai District",
    "東區": "Eastern District",
    "南區": "Southern District",
    "油尖旺區": "Yau Tsim Mong District",
    "深水埗區": "Sham Shui Po District",
    "九龍城區": "Kowloon City District",
    "黃大仙區": "Wong Tai Sin District",
    "觀塘區": "Kwun Tong District",
    "葵青區": "Kwai Tsing District",
    "荃灣區": "Tsuen Wan District",
    "屯門區": "Tuen Mun District",
    "元朗區": "Yuen Long District",
    "北區": "North District",
    "大埔區": "Tai Po District",
    "沙田區": "Sha Tin District",
    "西貢區": "Sai Kung District",
    "離島區": "Islands District",
  }[addr.suburb];
  const suburb = district ? `${addr.suburb} (${district})` : addr.suburb;
  return [type, addr.house_number, addr.neighbourhood, suburb]
    .filter(Boolean)
    .join(" · ");
}

function renderSuggestions(results) {
  state.suggestions = results;
  state.activeIndex = -1;
  el.suggestions.innerHTML = "";

  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "suggestion-empty";
    empty.textContent = "No results found";
    el.suggestions.appendChild(empty);
    el.suggestions.hidden = false;
    return;
  }

  results.forEach((result, i) => {
    const names = suggestionNames(result);
    const item = document.createElement("div");
    item.className = "suggestion-item";
    item.dataset.index = i;

    const zh = document.createElement("div");
    zh.className = "suggestion-zh";
    zh.textContent = names.zh;

    const en = document.createElement("div");
    en.className = "suggestion-en";
    en.textContent = names.en;

    const subtitle = document.createElement("div");
    subtitle.className = "suggestion-subtitle";
    subtitle.textContent = suggestionSubtitle(result);

    item.appendChild(zh);
    item.appendChild(en);
    if (subtitle.textContent) item.appendChild(subtitle);
    item.addEventListener("click", () => selectResult(result));
    el.suggestions.appendChild(item);
  });

  el.suggestions.hidden = false;
}

async function runSearch(query) {
  cancelSearch();
  const controller = new AbortController();
  searchController = controller;
  try {
    const results = await search(query, controller.signal);
    if (controller.signal.aborted) return;
    renderSuggestions(results);
  } catch (err) {
    if (err.name === "AbortError") return;
    clearSuggestions();
  }
}

async function selectResult(result) {
  clearSuggestions();
  clearAddress();
  el.cardLoading.hidden = false;
  setStatus("Loading address…");
  try {
    const loc = await enrichResult(result);
    showAddress(loc);
  } catch {
    el.cardLoading.hidden = true;
    setStatus("Could not load address", true);
  }
}

// ---------- Favorites ----------

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem("taxiFavorites") || "[]");
  } catch {
    return [];
  }
}

function saveFavorites(list) {
  localStorage.setItem("taxiFavorites", JSON.stringify(list));
}

function renderFavorites() {
  const favorites = getFavorites();
  el.favoritesSection.hidden = favorites.length === 0;
  el.favoritesList.innerHTML = "";

  favorites.forEach((fav, i) => {
    const li = document.createElement("li");
    li.className = "favorite-item";

    const text = document.createElement("div");
    const zh = document.createElement("div");
    zh.className = "favorite-zh";
    zh.textContent = fav.nameZh;
    const en = document.createElement("div");
    en.className = "favorite-en";
    en.textContent = fav.nameEn;
    text.appendChild(zh);
    text.appendChild(en);

    const del = document.createElement("button");
    del.className = "favorite-delete";
    del.textContent = "×";
    del.setAttribute("aria-label", "Remove favorite");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const list = getFavorites();
      list.splice(i, 1);
      saveFavorites(list);
      renderFavorites();
    });

    li.appendChild(text);
    li.appendChild(del);
    li.addEventListener("click", () => showAddress(fav));
    el.favoritesList.appendChild(li);
  });
}

function addFavorite() {
  if (!state.current) return;
  const favorites = getFavorites();
  const exists = favorites.some(
    (f) => f.nameZh === state.current.nameZh && f.nameEn === state.current.nameEn
  );
  if (!exists) {
    favorites.unshift(state.current);
    saveFavorites(favorites.slice(0, 20));
    renderFavorites();
    el.favoriteBtn.querySelector(".btn-icon").textContent = "★";
    setStatus("Saved to favorites");
  }
}

// ---------- Copy ----------

async function copyAddress() {
  if (!state.current) return;
  const display = displayAddress(state.current);
  const text = [
    display.nameZh,
    display.nameEn,
    display.streetZh,
    display.streetEn,
    display.district,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied");
  } catch {
    setStatus("Could not copy", true);
  }
}

// ---------- Share ----------

function encodeLocation(loc) {
  const json = JSON.stringify(loc);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeLocation(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function shareLink(loc) {
  return location.origin + location.pathname + "?d=" + encodeLocation(loc);
}

async function shareLocation() {
  if (!state.current) return;
  const url = shareLink(state.current);
  const title = [state.current.nameZh, state.current.nameEn]
    .filter(Boolean)
    .join(" · ") || "Taxi destination";
  const data = { title, url };

  if (navigator.share) {
    try {
      await navigator.share(data);
    } catch (err) {
      if (err.name !== "AbortError") copyLink(url);
    }
  } else {
    copyLink(url);
  }
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    setStatus("Link copied");
  } catch {
    setStatus("Could not copy link", true);
  }
}

// ---------- Fullscreen ----------

function openFullscreen() {
  if (!state.current) return;
  renderAddress(state.current);
  el.fullscreen.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeFullscreen() {
  el.fullscreen.hidden = true;
  document.body.style.overflow = "";
}

// ---------- Events ----------

el.favoriteBtn.addEventListener("click", addFavorite);
el.copyBtn.addEventListener("click", copyAddress);
el.shareBtn.addEventListener("click", shareLocation);
el.card.addEventListener("click", openFullscreen);
el.fullscreenClose.addEventListener("click", closeFullscreen);

el.fullscreen.addEventListener("click", (e) => {
  if (e.target === el.fullscreen) closeFullscreen();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el.fullscreen.hidden) closeFullscreen();
});

el.searchInput.addEventListener("input", (e) => {
  clearTimeout(debounceTimer);
  const query = e.target.value.trim();
  if (query.length < 2) {
    cancelSearch();
    clearSuggestions();
    return;
  }
  debounceTimer = setTimeout(() => runSearch(query), 500);
});

el.searchInput.addEventListener("keydown", (e) => {
  const items = el.suggestions.querySelectorAll(".suggestion-item");
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.activeIndex = Math.min(state.activeIndex + 1, items.length - 1);
    updateActive(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    state.activeIndex = Math.max(state.activeIndex - 1, 0);
    updateActive(items);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (state.activeIndex >= 0 && state.suggestions[state.activeIndex]) {
      selectResult(state.suggestions[state.activeIndex]);
    }
  } else if (e.key === "Escape") {
    clearSuggestions();
  }
});

function updateActive(items) {
  items.forEach((item, i) => {
    item.classList.toggle("active", i === state.activeIndex);
    if (i === state.activeIndex) {
      item.scrollIntoView({ block: "nearest" });
    }
  });
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-container")) {
    clearSuggestions();
  }
});

// ---------- Init ----------

function loadFromURL() {
  const encoded = new URLSearchParams(location.search).get("d");
  if (!encoded) return false;
  try {
    showAddress(decodeLocation(encoded));
    return true;
  } catch {
    setStatus("Invalid shared link", true);
    return false;
  }
}

renderFavorites();
loadFromURL();
