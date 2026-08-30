import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { MapDocument } from '../map-document';
import { WarcraftResourceResolver } from '../resources/resource-resolver';

const projectRoot = process.cwd();
const sampleRoot = path.resolve(projectRoot, '..', 'shuaitu1.0');
const warcraftPath = 'F:\\Warcraft III Frozen Throne';

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const data = await new MapDocument(sampleRoot, 'gbk').load(warcraftPath);
  data.points = [{ id: 'preview-center', name: 'center', x: 0, y: 0 }];
  const resources = new WarcraftResourceResolver(sampleRoot, warcraftPath);

  const routes = new Map<string, { filename?: string; type: string; body?: string }>([
    ['/', { filename: path.join(projectRoot, 'scripts', 'harness.html'), type: 'text/html; charset=utf-8' }],
    ['/styles.css', { filename: path.join(projectRoot, 'media', 'styles.css'), type: 'text/css; charset=utf-8' }],
    ['/war3-rect-edit.png', { filename: path.join(projectRoot, 'media', 'war3-rect-edit.png'), type: 'image/png' }],
    ['/webview.js', { filename: path.join(projectRoot, 'dist', 'webview.js'), type: 'text/javascript; charset=utf-8' }],
    ['/data.json', { body: JSON.stringify(data), type: 'application/json; charset=utf-8' }]
  ]);

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1:4173');
      if (requestUrl.pathname === '/resource') {
        const resourcePath = requestUrl.searchParams.get('path');
        const body = resourcePath === null ? undefined : await resources.read(resourcePath);
        if (body === undefined) {
          response.writeHead(404).end('Not found');
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        response.end(body);
        return;
      }
      const route = routes.get(requestUrl.pathname);
      if (route === undefined) {
        response.writeHead(404).end('Not found');
        return;
      }
      const body = route.body ?? await fs.readFile(route.filename!);
      response.writeHead(200, {
        'Content-Type': route.type,
        'Cache-Control': 'no-store'
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });

  server.listen(4173, '127.0.0.1', () => {
    console.log('War3 Rect Edit harness: http://127.0.0.1:4173');
  });
  const close = () => {
    server.close();
    void resources.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
