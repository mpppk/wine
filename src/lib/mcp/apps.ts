import { createUIResource } from "@mcp-ui/server";
import { RELAY_READY_MESSAGE } from "#/lib/mcp-app/host-bridge";

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
    // ホスト(親フレーム)以外からのメッセージは受け付けない
    if (ev.source !== window.parent) return;
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

// register_drunk_wine の結果を表示・編集するフォームの中継HTML。
//
// フォーム本体は /embed/drunk-wine(実 React・Web版と共通の入力コンポーネント)で、
// ここはホストのサンドボックス iframe とその中の自オリジン iframe を繋ぐだけの
// 透過的な中継に徹する。以前はこのテンプレート文字列の中でフォーム描画も差分
// パッチ生成も実装しており、typecheck も lint も効かず substring テストしか
// 書けなかった(#155/#189)。この中継はフィールド名もツール名も知らないので、
// 項目を増やしても手を入れる必要がない。
//
// エントリはホストからの postMessage(ui/notifications/tool-result または
// ui-lifecycle-iframe-render-data)でのみ受け取り、URLには載せない(IDOR防止)。
// 保存もホスト仲介の tools/call (SEP) / {type:"tool"} (mcp-ui) のまま。
export function buildDrunkWineAppHtml(baseUrl: string): string {
	const base = JSON.stringify(baseUrl);
	const ready = JSON.stringify(RELAY_READY_MESSAGE.__wineRelay);
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
<div id="status">フォームを読み込み中…</div>
<script>
(function(){
  var READY = ${ready};
  var childReady = false;
  var queued = [];
  var frame = document.createElement("iframe");
  frame.src = ${base} + "/embed/drunk-wine";
  frame.title = "飲んだワインの編集フォーム";

  function toChild(msg){
    // 子のロード完了前にホストが render-data を送ってくることがあるため、
    // 準備完了の合図が来るまで貯める
    if (!childReady){ queued.push(msg); return; }
    // 子はこのフレームの sandbox を継承して不透明オリジンになるため、
    // targetOrigin にオリジンを指定すると配送されない("*" しか届かない)。
    // 送るのはホスト由来のメッセージだけで、宛先は自分が生成した固定URLの
    // フレームに限られる。
    try { frame.contentWindow.postMessage(msg, "*"); } catch(e){}
  }
  function toHost(msg){
    try { window.parent.postMessage(msg, "*"); } catch(e){}
  }
  window.addEventListener("message", function(ev){
    var m = ev.data;
    if (!m || typeof m !== "object") return;
    if (ev.source === frame.contentWindow){
      if (m.__wineRelay === READY){
        childReady = true;
        var pendingMsgs = queued;
        queued = [];
        for (var i=0;i<pendingMsgs.length;i++) toChild(pendingMsgs[i]);
        return;
      }
      toHost(m);
      return;
    }
    // ホスト(親フレーム)以外からのメッセージは受け付けない
    if (ev.source === window.parent) toChild(m);
  });
  frame.addEventListener("load", function(){
    var status = document.getElementById("status");
    if (status) status.remove();
  });
  document.body.appendChild(frame);
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
