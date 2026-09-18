--- /tmp/chat.v0.js	2026-09-18 22:34:50.689494092 +0000
+++ api/chat.js	2026-09-18 22:34:50.734439792 +0000
@@ -13,6 +13,7 @@
     const { system, userMsg } = req.body;
     if (!system || !userMsg) return res.status(400).json({ error: "Faltan parámetros" });
 
+    const t0 = Date.now();
     const response = await client.messages.create({
       model: "claude-sonnet-4-6",
       max_tokens: 6000,
@@ -21,6 +22,25 @@
       messages: [{ role: "user", content: userMsg }],
     });
 
+    // DIAG (temporal): instrumentación de la búsqueda. No registra secretos ni cabeceras.
+    try {
+      const paso = /scores_social/.test(system) ? "R2" : (/scores_gmaps/.test(system) ? "R1" : "?");
+      const caso = String(userMsg).split("\n")[0].slice(0, 80);
+      const content = response.content || [];
+      const queries = content.filter(b => b.type === "server_tool_use").map(b => b.input && b.input.query);
+      const resultados = [];
+      content.filter(b => b.type === "web_search_tool_result").forEach(b => {
+        if (Array.isArray(b.content)) b.content.forEach(r => resultados.push({ url: r.url, title: r.title }));
+        else resultados.push({ error: b.content && b.content.error_code });
+      });
+      const texto = content.filter(b => b.type === "text").map(b => b.text).join("");
+      const citas = content.filter(b => b.type === "text").reduce((n, b) => n + ((b.citations || []).length), 0);
+      const fin = response.stop_reason === "end_turn" ? "normal" : response.stop_reason === "max_tokens" ? "CORTADA_POR_LIMITE" : response.stop_reason === "pause_turn" ? "PAUSE_TURN" : response.stop_reason;
+      console.log("[DDP-DIAG]", paso, JSON.stringify({ caso, ms: Date.now() - t0, stop_reason: response.stop_reason, fin, pause_turn: response.stop_reason === "pause_turn", usage: response.usage, web_search_requests: response.usage && response.usage.server_tool_use ? response.usage.server_tool_use.web_search_requests : null, n_consultas: queries.length, n_resultados: resultados.length, n_citas: citas, texto_chars: texto.length, json_cerrado: /\}\s*(```)?\s*$/.test(texto) }));
+      queries.forEach((q, i) => console.log("[DDP-DIAG]", paso, "consulta", i + 1, JSON.stringify(q)));
+      for (let i = 0; i < resultados.length; i += 5) console.log("[DDP-DIAG]", paso, "resultados", i + 1 + "-" + Math.min(i + 5, resultados.length), JSON.stringify(resultados.slice(i, i + 5)));
+    } catch (e) { console.log("[DDP-DIAG] error al registrar:", e.message); }
+
     res.status(200).json(response);
   } catch (error) {
     console.error("Error:", error);
