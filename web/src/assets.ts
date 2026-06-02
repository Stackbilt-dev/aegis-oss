export async function serveSpaIndex(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = '/index.html';
  url.search = '';
  return assets.fetch(new Request(url, request));
}
