export async function onRequest(context) {
  const url = new URL(context.request.url);

  // アクセスされたURLから '/qchizu' の部分を取り除き、転送先のURLを作成
  const targetPath = url.pathname.replace(/^\/qchizu/, '');
  const targetUrl = 'https://qchizu3.xsrv.jp' + targetPath + url.search;

  const res = await fetch(targetUrl);
  const headers = new Headers(res.headers);

  // CORSとキャッシュの設定（以前のWorkerと同じ処理）
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'public, max-age=604800, s-maxage=604800');

  return new Response(res.body, {
    status: res.status,
    headers: headers
  });
}
