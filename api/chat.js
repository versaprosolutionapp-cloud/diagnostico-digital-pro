import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Presupuesto de herramientas por paso. R0 = identidad (solo búsqueda); R1/R2 = auditoría (búsqueda + apertura selectiva).
const PRESUPUESTO = {
  R0: { busquedas: 8, aperturas: 0 },
  R1: { busquedas: 6, aperturas: 4 },
  R2: { busquedas: 6, aperturas: 3 },
};
const MAX_CONTENIDO_FETCH = 4000; // tokens por página abierta
const MAX_RONDAS_PAUSE = 3;       // continuaciones tras stop_reason "pause_turn"

const limpiarDominios = (d) => Array.from(new Set((Array.isArray(d) ? d : []).map(x => String(x || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]).filter(x => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)))).slice(0, 40);

const construirTools = (paso, ubicacion, dominios) => {
  const p = PRESUPUESTO[paso] || PRESUPUESTO.R1;
  const search = { type: "web_search_20250305", name: "web_search", max_uses: p.busquedas };
  if (ubicacion && typeof ubicacion === "object" && ubicacion.country) {
    search.user_location = { type: "approximate", country: String(ubicacion.country).slice(0, 2) };
    if (ubicacion.city) search.user_location.city = String(ubicacion.city).slice(0, 60);
    if (ubicacion.region) search.user_location.region = String(ubicacion.region).slice(0, 60);
    if (ubicacion.timezone) search.user_location.timezone = String(ubicacion.timezone).slice(0, 60);
  }
  const tools = [search];
  if (p.aperturas > 0) {
    const fetch = { type: "web_fetch_20250910", name: "web_fetch", max_uses: p.aperturas, max_content_tokens: MAX_CONTENIDO_FETCH };
    const dom = limpiarDominios(dominios);
    if (dom.length) fetch.allowed_domains = dom;
    tools.push(fetch);
  }
  return tools;
};

// Extrae de los bloques de respuesta la evidencia que antes se descartaba: consultas, URLs/títulos vistos, aperturas.
const extraerEvidencia = (content) => {
  const consultas = [], resultados = [], abiertas = [], vistos = new Set();
  const pendientesFetch = {};
  (content || []).forEach(b => {
    if (b.type === "server_tool_use") {
      if (b.name === "web_search") consultas.push(b.input && b.input.query);
      if (b.name === "web_fetch") pendientesFetch[b.id] = b.input && b.input.url;
    }
    if (b.type === "web_search_tool_result") {
      if (Array.isArray(b.content)) b.content.forEach(r => { if (r && r.url && !vistos.has(r.url)) { vistos.add(r.url); resultados.push({ url: r.url, title: r.title || "", page_age: r.page_age || null }); } });
      else resultados.push({ error: b.content && b.content.error_code });
    }
    if (b.type === "web_fetch_tool_result") {
      const url = pendientesFetch[b.tool_use_id] || (b.content && b.content.url) || "";
      if (b.content && b.content.type === "web_fetch_tool_result_error") abiertas.push({ url, ok: false, error: b.content.error_code });
      else abiertas.push({ url: (b.content && b.content.url) || url, ok: true });
    }
  });
  return { consultas, resultados, abiertas };
};

const sumarUso = (a, b) => {
  if (!a) return b; if (!b) return a;
  const out = { ...a };
  ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].forEach(k => { if (typeof b[k] === "number") out[k] = (out[k] || 0) + b[k]; });
  const sa = a.server_tool_use || {}, sb = b.server_tool_use || {};
  out.server_tool_use = { web_search_requests: (sa.web_search_requests || 0) + (sb.web_search_requests || 0), web_fetch_requests: (sa.web_fetch_requests || 0) + (sb.web_fetch_requests || 0) };
  return out;
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { system, userMsg, paso, ubicacion, dominios } = req.body || {};
    if (!system || !userMsg) return res.status(400).json({ error: "Faltan parámetros" });
    // Paso: lo declara el cliente; si no viene, se deduce del system prompt (compatibilidad con la versión anterior)
    const pasoId = /^R[012]$/.test(String(paso || "")) ? paso : (/scores_social/.test(system) ? "R2" : "R1");
    const tools = construirTools(pasoId, ubicacion, dominios);

    const t0 = Date.now();
    const messages = [{ role: "user", content: userMsg }];
    let response = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 6000, system, tools, messages });
    let content = response.content || [];
    let usage = response.usage;
    let rondas = 1;
    // pause_turn: la API pausó un turno largo con herramientas; se reenvía el mensaje del asistente sin cambios para continuar
    while (response.stop_reason === "pause_turn" && rondas < 1 + MAX_RONDAS_PAUSE) {
      messages.push({ role: "assistant", content: response.content });
      response = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 6000, system, tools, messages });
      content = content.concat(response.content || []);
      usage = sumarUso(usage, response.usage);
      rondas++;
    }

    const ev = extraerEvidencia(content);
    const texto = content.filter(b => b.type === "text").map(b => b.text).join("");
    const _evidencia = {
      paso: pasoId, rondas, ms: Date.now() - t0, stop_reason: response.stop_reason, usage,
      web_search_requests: usage && usage.server_tool_use ? usage.server_tool_use.web_search_requests || 0 : null,
      web_fetch_requests: usage && usage.server_tool_use ? usage.server_tool_use.web_fetch_requests || 0 : null,
      consultas: ev.consultas, resultados: ev.resultados, abiertas: ev.abiertas,
      dominios_fetch: tools[1] ? tools[1].allowed_domains || [] : [],
    };

    // DIAG (temporal): instrumentación de la búsqueda. No registra secretos ni cabeceras.
    try {
      const caso = String(userMsg).split("\n")[0].slice(0, 80);
      const fin = response.stop_reason === "end_turn" ? "normal" : response.stop_reason === "max_tokens" ? "CORTADA_POR_LIMITE" : response.stop_reason === "pause_turn" ? "PAUSE_TURN_SIN_RESOLVER" : response.stop_reason;
      console.log("[DDP-DIAG]", pasoId, JSON.stringify({ caso, ms: _evidencia.ms, rondas, stop_reason: response.stop_reason, fin, pause_turn: rondas > 1, usage, web_search_requests: _evidencia.web_search_requests, web_fetch_requests: _evidencia.web_fetch_requests, n_consultas: ev.consultas.length, n_resultados: ev.resultados.length, n_abiertas: ev.abiertas.length, texto_chars: texto.length, json_cerrado: /\}\s*(```)?\s*$/.test(texto), dominios_fetch: _evidencia.dominios_fetch }));
      ev.consultas.forEach((q, i) => console.log("[DDP-DIAG]", pasoId, "consulta", i + 1, JSON.stringify(q)));
      ev.abiertas.forEach((a, i) => console.log("[DDP-DIAG]", pasoId, "apertura", i + 1, JSON.stringify(a)));
      for (let i = 0; i < ev.resultados.length; i += 5) console.log("[DDP-DIAG]", pasoId, "resultados", i + 1 + "-" + Math.min(i + 5, ev.resultados.length), JSON.stringify(ev.resultados.slice(i, i + 5).map(r => ({ url: r.url, title: r.title }))));
    } catch (e) { console.log("[DDP-DIAG] error al registrar:", e.message); }

    // Al frontend: solo los bloques de texto (el JSON del modelo) + la evidencia estructurada. Se omiten contenidos cifrados y páginas abiertas.
    res.status(200).json({ id: response.id, type: response.type, role: response.role, model: response.model, stop_reason: response.stop_reason, usage, content: content.filter(b => b.type === "text").map(b => ({ type: "text", text: b.text })), _evidencia });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: error.message });
  }
}
