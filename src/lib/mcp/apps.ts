import { createUIResource } from "@mcp-ui/server";

// Build the read-only MCP App (mcp-ui) resource for a team's todos. The host
// (Claude etc.) renders it in a sandboxed iframe pointed at the app's own
// /embed route, which shows the real todo list in read mode. Kept free of
// DB/runtime imports so it stays unit-testable.
export function buildTodosUiResource(baseUrl: string, teamId: string) {
	return createUIResource({
		uri: `ui://todo-app2026/todos/${teamId}`,
		content: {
			type: "externalUrl",
			iframeUrl: `${baseUrl}/embed/teams/${teamId}`,
		},
		encoding: "text",
	});
}

// Static resource URI for the MCP Apps (SEP) surface. Tools declare this via
// `_meta.ui.resourceUri`; hosts (MCP Inspector's Apps tab, Claude) fetch the
// resource and render it, then push the tool input/result into the iframe.
export const TODOS_RESOURCE_URI = "ui://todo-app2026/todos";

// Self-contained bridge HTML served as the ui:// resource for MCP Apps (SEP)
// hosts. Because the resource is static (shared across teams), the concrete
// team id arrives at render time via the host's `ui/notifications/tool-input`
// / `ui/notifications/tool-result` messages (or the mcp-ui render-data
// message). Once known, it embeds the real /embed/teams/:id route in an
// iframe. Kept import-free so it stays unit-testable.
export function buildTodosAppHtml(baseUrl: string): string {
	const base = JSON.stringify(baseUrl);
	return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:transparent}
  iframe{border:0;width:100%;height:100%;display:block}
  #status{font:14px system-ui,sans-serif;color:#6b7280;padding:16px}
</style>
</head>
<body>
<div id="status">Todoを読み込み中…</div>
<script>
(function(){
  var BASE_URL = ${base};
  var rendered = false;
  function render(teamId){
    if (rendered || !teamId) return;
    rendered = true;
    var f = document.createElement("iframe");
    f.src = BASE_URL + "/embed/teams/" + encodeURIComponent(teamId);
    document.body.innerHTML = "";
    document.body.appendChild(f);
  }
  function findTeamId(p){
    if (!p || typeof p !== "object") return null;
    try {
      if (p.arguments && p.arguments.team_id) return p.arguments.team_id;
      var sc = p.structuredContent || (p.result && p.result.structuredContent);
      if (sc && sc.team_id) return sc.team_id;
      var content = p.content || (p.result && p.result.content) ||
        (p.renderData && p.renderData.content);
      if (Array.isArray(content)){
        for (var i=0;i<content.length;i++){
          var c = content[i];
          if (c && c.type === "text" && c.text){
            try { var j = JSON.parse(c.text); if (j.team_id) return j.team_id; } catch(e){}
          }
        }
      }
      // mcp-ui render-data may carry the raw tool result
      if (p.renderData) { var id = findTeamId(p.renderData); if (id) return id; }
    } catch(e){}
    return null;
  }
  function post(msg){ try { window.parent.postMessage(msg, "*"); } catch(e){} }
  window.addEventListener("message", function(ev){
    var m = ev.data;
    if (!m || typeof m !== "object") return;
    // MCP Apps (SEP) JSON-RPC notifications
    if (m.method === "ui/notifications/tool-input" || m.method === "ui/notifications/tool-result"){
      var id = findTeamId(m.params);
      if (id) render(id);
    }
    // Response to our ui/initialize -> ack with initialized
    if (m.id === 1 && m.result){
      post({ jsonrpc:"2.0", method:"ui/notifications/initialized" });
    }
    // mcp-ui render-data message
    if (m.type === "ui-lifecycle-iframe-render-data"){
      var rid = findTeamId(m.payload);
      if (rid) render(rid);
    }
  });
  // Kick off both handshakes; whichever the host speaks will answer.
  // MCP Apps (SEP) ui/initialize expects appInfo + appCapabilities.
  post({ jsonrpc:"2.0", id:1, method:"ui/initialize", params:{
    protocolVersion:"2025-06-18",
    appInfo:{ name:"todo-app2026", version:"1.0.0" }, appCapabilities:{} } });
  post({ type:"ui-lifecycle-iframe-ready" });
  post({ type:"ui-request-render-data" });
})();
</script>
</body>
</html>`;
}
