import { createUIResource } from "@mcp-ui/server";

export interface AopMapParams {
	regionId: string;
	grapeVarietyId?: string;
	aopId?: string;
}

export function buildEmbedMapUrl(
	baseUrl: string,
	params: AopMapParams,
): string {
	const url = new URL("/embed/map", baseUrl);
	url.searchParams.set("region", params.regionId);
	if (params.grapeVarietyId)
		url.searchParams.set("grape", params.grapeVarietyId);
	if (params.aopId) url.searchParams.set("aop", params.aopId);
	return url.toString();
}

// show_aop_map の結果に添付する mcp-ui リソース。ホストはサンドボックス化した
// iframe で本アプリの /embed/map を描画する。DB等ランタイム依存なしで
// ユニットテスト可能に保つ。
export function buildAopMapUiResource(baseUrl: string, params: AopMapParams) {
	const query = new URL(buildEmbedMapUrl(baseUrl, params)).search;
	return createUIResource({
		uri: `ui://wine-aop/map${query}` as `ui://${string}`,
		content: {
			type: "externalUrl",
			iframeUrl: buildEmbedMapUrl(baseUrl, params),
		},
		encoding: "text",
	});
}

// MCP Apps (SEP) 用の静的リソースURI。ツールが `_meta.ui.resourceUri` で
// 参照し、ホスト(MCP InspectorのAppsタブ、Claude等)がこのリソースを
// 取得して描画する。
export const AOP_MAP_RESOURCE_URI = "ui://wine-aop/map";

// MCP Apps ホストに返す自己完結のブリッジHTML。リソース自体は静的なので、
// 表示すべき地域・品種・AOPは描画時にホストから届く
// `ui/notifications/tool-input` / `ui/notifications/tool-result`(または
// mcp-ui の render-data メッセージ)から読み取り、実体の /embed/map を
// iframe で埋め込む。一定時間データが届かない場合は既定地域を表示する。
export function buildAopMapAppHtml(baseUrl: string): string {
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
<div id="status">AOP地図を読み込み中…</div>
<script>
(function(){
  var BASE_URL = ${base};
  var rendered = false;
  function render(params){
    if (rendered) return;
    rendered = true;
    var q = "?region=" + encodeURIComponent(params.region || "bourgogne");
    if (params.grape) q += "&grape=" + encodeURIComponent(params.grape);
    if (params.aop) q += "&aop=" + encodeURIComponent(params.aop);
    var f = document.createElement("iframe");
    f.src = BASE_URL + "/embed/map" + q;
    document.body.innerHTML = "";
    document.body.appendChild(f);
  }
  function findParams(p){
    if (!p || typeof p !== "object") return null;
    try {
      var candidates = [];
      if (p.arguments) candidates.push(p.arguments);
      var sc = p.structuredContent || (p.result && p.result.structuredContent);
      if (sc) candidates.push(sc);
      var content = p.content || (p.result && p.result.content) ||
        (p.renderData && p.renderData.content);
      if (Array.isArray(content)){
        for (var i=0;i<content.length;i++){
          var c = content[i];
          if (c && c.type === "text" && c.text){
            try { candidates.push(JSON.parse(c.text)); } catch(e){}
          }
        }
      }
      for (var j=0;j<candidates.length;j++){
        var o = candidates[j];
        if (o && typeof o === "object" && o.region_id){
          return { region: o.region_id, grape: o.grape_variety_id, aop: o.aop_id };
        }
      }
      if (p.renderData) { var r = findParams(p.renderData); if (r) return r; }
    } catch(e){}
    return null;
  }
  function post(msg){ try { window.parent.postMessage(msg, "*"); } catch(e){} }
  window.addEventListener("message", function(ev){
    var m = ev.data;
    if (!m || typeof m !== "object") return;
    // MCP Apps (SEP) JSON-RPC notifications
    if (m.method === "ui/notifications/tool-input" || m.method === "ui/notifications/tool-result"){
      var p = findParams(m.params);
      if (p) render(p);
    }
    // ui/initialize への応答が来たら initialized を返す
    if (m.id === 1 && m.result){
      post({ jsonrpc:"2.0", method:"ui/notifications/initialized" });
    }
    // mcp-ui の render-data メッセージ
    if (m.type === "ui-lifecycle-iframe-render-data"){
      var rp = findParams(m.payload);
      if (rp) render(rp);
    }
  });
  // どちらのハンドシェイクにも応答できるよう両方送る
  post({ jsonrpc:"2.0", id:1, method:"ui/initialize", params:{
    protocolVersion:"2025-06-18",
    appInfo:{ name:"wine-aop", version:"1.0.0" }, appCapabilities:{} } });
  post({ type:"ui-lifecycle-iframe-ready" });
  post({ type:"ui-request-render-data" });
  // ツールデータが届かないホストでも既定地域で描画する
  setTimeout(function(){ render({ region: "bourgogne" }); }, 1500);
})();
</script>
</body>
</html>`;
}

// register_drunk_wine 用の MCP Apps (SEP) リソースURI。
export const DRUNK_WINE_RESOURCE_URI = "ui://wine-aop/drunk-wine";

// register_drunk_wine の結果を表示・編集する自己完結フォームHTML。
// エントリデータはホストからの postMessage(ui/notifications/tool-result
// または ui-lifecycle-iframe-render-data)でのみ受け取り、URLパラメータや
// fetch にエントリIDを載せない(IDOR防止)。保存はホスト仲介の tools/call
// (SEP) / {type:"tool"} (mcp-ui) で update_drunk_wine を呼ぶ。
export function buildDrunkWineAppHtml(baseUrl: string): string {
	const base = JSON.stringify(baseUrl);
	return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{margin:0;background:transparent;font:14px/1.6 system-ui,sans-serif}
  .card{max-width:560px;margin:8px auto;padding:16px;background:#fff;color:#111827;
    border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
  h1{font-size:16px;margin:0 0 4px}
  .sub{font-size:12px;color:#6b7280;margin:0 0 8px}
  label{display:block;font-size:12px;color:#6b7280;margin:10px 0 2px}
  input,select,textarea{width:100%;box-sizing:border-box;padding:6px 8px;
    border:1px solid #d1d5db;border-radius:6px;font:inherit;background:#fff;color:#111827}
  textarea{min-height:72px;resize:vertical}
  .row{display:flex;gap:10px}
  .row>div{flex:1;min-width:0}
  .vars{display:flex;flex-wrap:wrap;gap:2px 14px;max-height:150px;overflow:auto;
    border:1px solid #e5e7eb;border-radius:6px;padding:8px}
  .vars label{display:flex;align-items:center;gap:5px;margin:0;font-size:13px;color:#111827}
  .vars input{width:auto;margin:0}
  img.photo{max-width:100%;max-height:220px;border-radius:8px;display:block;margin:6px 0}
  button{margin-top:14px;padding:8px 18px;border:0;border-radius:8px;
    background:#9f1239;color:#fff;font:inherit;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  #f-status{margin-left:10px;font-size:13px}
  #f-status.okmsg{color:#16a34a}
  #f-status.errmsg{color:#dc2626}
</style>
</head>
<body>
<div class="card" id="app"><p class="sub">登録結果を待っています…</p></div>
<script>
(function(){
  var BASE_URL = ${base};
  var entry = null;
  var varieties = null;
  var varietiesSettled = false;
  var rendered = false;
  var sepMode = false;
  var nextId = 2;
  var pending = null;

  function post(msg){ try { window.parent.postMessage(msg, "*"); } catch(e){} }
  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;"
        : c === '"' ? "&quot;" : "&#39;";
    });
  }
  function findEntry(p){
    if (!p || typeof p !== "object") return null;
    try {
      var cands = [p];
      var sc = p.structuredContent || (p.result && p.result.structuredContent);
      if (sc) cands.push(sc);
      var content = p.content || (p.result && p.result.content) ||
        (p.renderData && p.renderData.content);
      if (Array.isArray(content)){
        for (var i=0;i<content.length;i++){
          var c = content[i];
          if (c && c.type === "text" && c.text){
            try { cands.push(JSON.parse(c.text)); } catch(e){}
          }
        }
      }
      for (var j=0;j<cands.length;j++){
        var o = cands[j];
        if (o && typeof o === "object" && o.entry && o.entry.id) return o.entry;
      }
      if (p.renderData){ var r = findEntry(p.renderData); if (r) return r; }
    } catch(e){}
    return null;
  }
  function textOf(res){
    var content = res && res.content;
    if (Array.isArray(content)){
      for (var i=0;i<content.length;i++){
        if (content[i] && content[i].type === "text") return content[i].text;
      }
    }
    return "";
  }
  function ratingOptions(sel){
    var h = '<option value="">未評価</option>';
    for (var i=1;i<=5;i++){
      var stars = "";
      for (var j=0;j<i;j++) stars += "★";
      h += '<option value="' + i + '"' + (sel === i ? " selected" : "") + '>' +
        stars + " (" + i + ')</option>';
    }
    return h;
  }
  function grapeSection(){
    var ids = entry.grape_variety_ids || [];
    if (varieties && varieties.length){
      var h = '<div class="vars">';
      for (var i=0;i<varieties.length;i++){
        var v = varieties[i];
        h += '<label><input type="checkbox" class="gv" value="' + esc(v.id) + '"' +
          (ids.indexOf(v.id) >= 0 ? " checked" : "") + '>' +
          esc(v.nameJa || v.id) + '</label>';
      }
      return h + '</div>';
    }
    // 品種マスタが取れないホスト向けフォールバック
    return '<input id="f-gv-text" value="' + esc(ids.join(", ")) +
      '" placeholder="list_grape_varietiesのidをカンマ区切りで">';
  }
  function render(){
    rendered = true;
    var h = '<h1>' + esc(entry.name || "飲んだワイン") + '</h1>' +
      '<p class="sub">マイセラーに記録しました。内容はこのまま編集できます。</p>';
    if (entry.photo_url){
      // entryはpostMessage由来の非信頼データなので、自アプリのオリジンの
      // 画像URLのみ表示する(任意URLのimg読み込みを防ぐ)
      var src = null;
      try {
        var u = new URL(entry.photo_url, BASE_URL);
        if (u.origin === new URL(BASE_URL).origin) src = u.toString();
      } catch(e){}
      if (src) h += '<img class="photo" src="' + esc(src) + '" alt="ボトル写真">';
    }
    h += '<label for="f-name">名前 *</label>' +
      '<input id="f-name" value="' + esc(entry.name || "") + '">';
    h += '<div class="row"><div><label for="f-drank_on">飲んだ日</label>' +
      '<input id="f-drank_on" type="date" value="' + esc(entry.drank_on || "") + '"></div>' +
      '<div><label for="f-rating">評価</label><select id="f-rating">' +
      ratingOptions(entry.rating) + '</select></div></div>';
    h += '<div class="row"><div><label for="f-vintage">ヴィンテージ</label>' +
      '<input id="f-vintage" type="number" min="1800" max="2100" value="' +
      (entry.vintage != null ? esc(entry.vintage) : "") + '"></div>' +
      '<div><label for="f-price">価格 (円)</label>' +
      '<input id="f-price" type="number" min="0" value="' +
      (entry.price != null ? esc(entry.price) : "") + '"></div></div>';
    h += '<label for="f-producer">生産者</label>' +
      '<input id="f-producer" value="' + esc(entry.producer || "") + '">';
    h += '<label for="f-aop_id">AOP</label>' +
      '<input id="f-aop_id" value="' + esc(entry.aop_id || "") +
      '" placeholder="list_aopsのid (例: gevrey-chambertin)">';
    h += '<label>ぶどう品種</label>' + grapeSection();
    h += '<label for="f-memo">メモ</label>' +
      '<textarea id="f-memo">' + esc(entry.memo || "") + '</textarea>';
    h += '<button id="f-save" type="button">保存</button><span id="f-status"></span>';
    document.getElementById("app").innerHTML = h;
    document.getElementById("f-save").addEventListener("click", save);
  }
  function maybeRender(){
    if (entry && varietiesSettled && !rendered) render();
  }
  function setStatus(text, isErr){
    var el = document.getElementById("f-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = isErr ? "errmsg" : "okmsg";
  }
  function collectPatch(){
    var p = {};
    function val(id){
      var el = document.getElementById(id);
      return el ? el.value.trim() : "";
    }
    // 空欄への変更は null(=クリア)として送る。undefined(未設定)は変更なし
    function diffText(id, cur, key){
      var v = val(id);
      if (v === (cur || "")) return;
      p[key] = v === "" ? null : v;
    }
    function diffNum(id, cur, key){
      var v = val(id);
      if (v === "" ? cur == null : Number(v) === cur) return;
      p[key] = v === "" ? null : Number(v);
    }
    // name は必須なので空欄は変更として扱わない(クリア不可)
    var name = val("f-name");
    if (name && name !== (entry.name || "")) p.name = name;
    diffText("f-drank_on", entry.drank_on, "drank_on");
    diffNum("f-rating", entry.rating, "rating");
    diffNum("f-vintage", entry.vintage, "vintage");
    diffNum("f-price", entry.price, "price");
    diffText("f-producer", entry.producer, "producer");
    diffText("f-aop_id", entry.aop_id, "aop_id");
    diffText("f-memo", entry.memo, "memo");
    var ids = null;
    var boxes = document.querySelectorAll("input.gv");
    if (boxes.length){
      ids = [];
      for (var i=0;i<boxes.length;i++) if (boxes[i].checked) ids.push(boxes[i].value);
    } else {
      var t = val("f-gv-text");
      if (t){
        ids = t.split(",").map(function(s){ return s.trim(); }).filter(Boolean);
      }
    }
    if (ids){
      var cur = (entry.grape_variety_ids || []).slice().sort().join(",");
      if (ids.slice().sort().join(",") !== cur) p.grape_variety_ids = ids;
    }
    return p;
  }
  function save(){
    if (!entry) return;
    // 前回の保存が応答待ちでも新しい保存で置き換える(古い応答はid不一致で無視)
    if (pending) clearTimeout(pending.timer);
    var patch = collectPatch();
    if (!Object.keys(patch).length){ setStatus("変更はありません", false); return; }
    patch.id = entry.id;
    var btn = document.getElementById("f-save");
    if (btn) btn.disabled = true;
    setStatus("保存中…", false);
    // ホストがツール実行のユーザ承認を挟むと応答まで時間がかかるため、
    // タイムアウトでは pending を破棄せず(遅延応答も反映する)、
    // ボタンだけ再有効化して注意書きを出す
    var timer = setTimeout(function(){
      if (btn) btn.disabled = false;
      setStatus("ホストの応答を待っています。ホストが編集(tools/call)に対応していない可能性もあります", true);
    }, 30000);
    if (sepMode){
      var id = nextId++;
      pending = { kind: "sep", id: id, timer: timer };
      post({ jsonrpc: "2.0", id: id, method: "tools/call",
        params: { name: "update_drunk_wine", arguments: patch } });
    } else {
      var mid = "update-drunk-wine-" + (nextId++);
      pending = { kind: "ui", id: mid, timer: timer };
      post({ type: "tool", messageId: mid,
        payload: { toolName: "update_drunk_wine", params: patch } });
    }
  }
  function settleSave(res, errText){
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
    var btn = document.getElementById("f-save");
    if (btn) btn.disabled = false;
    if (errText){ setStatus(errText, true); return; }
    if (res && res.result &&
      (res.result.content || res.result.structuredContent || res.result.isError)){
      res = res.result;
    }
    if (res && res.isError){
      setStatus(textOf(res) || "保存に失敗しました", true);
      return;
    }
    var e = findEntry(res);
    if (e){ entry = e; render(); }
    setStatus("保存しました", false);
  }
  window.addEventListener("message", function(ev){
    // ホスト(親ウィンドウ)以外からのメッセージは受け付けない
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || typeof m !== "object") return;
    // ui/initialize への応答 → SEPモード確定
    if (m.id === 1 && m.result){
      sepMode = true;
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
      return;
    }
    if (m.method === "ui/notifications/tool-result"){
      var e = findEntry(m.params);
      if (e && !rendered){ entry = e; maybeRender(); }
      return;
    }
    if (m.type === "ui-lifecycle-iframe-render-data"){
      var re = findEntry(m.payload);
      if (re && !rendered){ entry = re; maybeRender(); }
      return;
    }
    if (pending && pending.kind === "sep" && m.jsonrpc === "2.0" && m.id === pending.id){
      if (m.error) settleSave(null, (m.error && m.error.message) || "保存に失敗しました");
      else settleSave(m.result);
      return;
    }
    if (pending && pending.kind === "ui" &&
      m.type === "ui-message-response" && m.messageId === pending.id){
      var pl = m.payload || {};
      if (pl.error){
        settleSave(null, typeof pl.error === "string" ? pl.error : "保存に失敗しました");
      } else {
        settleSave(pl.response);
      }
      return;
    }
  });
  function loadVarieties(){
    var done = false;
    function settle(list){
      if (done) return;
      done = true;
      varieties = list;
      varietiesSettled = true;
      maybeRender();
    }
    // フォーム描画を品種マスタ取得で長く待たせない
    setTimeout(function(){ settle(null); }, 3000);
    try {
      fetch(BASE_URL + "/api/wine/varieties")
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){ settle(j && j.varieties ? j.varieties : null); })
        .catch(function(){ settle(null); });
    } catch(e){ settle(null); }
  }
  loadVarieties();
  // どちらのハンドシェイクにも応答できるよう両方送る
  post({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {
    protocolVersion: "2025-06-18",
    appInfo: { name: "wine-aop", version: "1.0.0" }, appCapabilities: {} } });
  post({ type: "ui-lifecycle-iframe-ready" });
  post({ type: "ui-request-render-data" });
  setTimeout(function(){
    if (!entry){
      document.getElementById("app").innerHTML = '<p class="sub">' +
        '登録結果を受信できませんでした。ホストがツール結果の配信' +
        '(MCP Apps / mcp-ui)に対応している必要があります。</p>';
    }
  }, 10000);
})();
</script>
</body>
</html>`;
}

// register_drunk_wine の結果に添付する mcp-ui フォールバックリソース。
// externalUrl だとURLにエントリIDが載ってしまうため rawHtml で返す。
// URIのサフィックスはホスト側キャッシュの一意性のためで、HTML自体は静的。
export function buildDrunkWineUiResource(
	baseUrl: string,
	entry: { id: string },
) {
	return createUIResource({
		uri: `ui://wine-aop/drunk-wine/${entry.id}` as `ui://${string}`,
		content: { type: "rawHtml", htmlString: buildDrunkWineAppHtml(baseUrl) },
		encoding: "text",
	});
}
