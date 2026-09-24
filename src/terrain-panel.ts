import * as vscode from 'vscode';
import type { InstanceLinkData, RegionFileData, ScriptPoint } from './shared/model';
import { DEFAULT_LUA_EXPORT_PATH, MapDocument } from './map-document';
import { WarcraftResourceResolver } from './resources/resource-resolver';

interface SaveMessage {
  type: 'save';
  revision: number;
  regionFile: RegionFileData;
  points: ScriptPoint[];
  instanceLinks: InstanceLinkData[];
}

interface ExportLuaMessage {
  type: 'exportLua';
  points: ScriptPoint[];
}

interface ResourceMessage {
  type: 'resource';
  requestId: number;
  path: string;
}

type WebviewMessage = { type: 'ready' } | SaveMessage | ExportLuaMessage | ResourceMessage;

export class TerrainPanel {
  private static current: TerrainPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly resources: WarcraftResourceResolver;
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly document: MapDocument,
    private readonly warcraftPath: string,
    private readonly configurationUri: vscode.Uri
  ) {
    this.resources = new WarcraftResourceResolver(document.root, warcraftPath);
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.receive(message),
      undefined,
      this.disposables
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('war3MapTools.luaExportPath', this.configurationUri)) {
          this.refreshLuaExportPath();
        }
      })
    );
  }

  public static async show(
    extensionUri: vscode.Uri,
    document: MapDocument,
    warcraftPath: string,
    configurationUri: vscode.Uri = vscode.Uri.file(document.root)
  ): Promise<void> {
    if (TerrainPanel.current !== undefined) {
      TerrainPanel.current.panel.dispose();
    }
    const panel = vscode.window.createWebviewPanel(
      'war3MapTools.terrain',
      terrainTitle(document.root),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist'),
          vscode.Uri.joinPath(extensionUri, 'media')
        ]
      }
    );
    TerrainPanel.current = new TerrainPanel(
      panel,
      extensionUri,
      document,
      warcraftPath,
      configurationUri
    );
  }

  public static resolve(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    document: MapDocument,
    warcraftPath: string,
    configurationUri: vscode.Uri = vscode.Uri.file(document.root)
  ): void {
    if (TerrainPanel.current !== undefined && TerrainPanel.current.panel !== panel) {
      TerrainPanel.current.panel.dispose();
    }
    panel.title = terrainTitle(document.root);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'dist'),
        vscode.Uri.joinPath(extensionUri, 'media')
      ]
    };
    TerrainPanel.current = new TerrainPanel(
      panel,
      extensionUri,
      document,
      warcraftPath,
      configurationUri
    );
  }

  private async receive(message: WebviewMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      switch (message.type) {
        case 'ready': {
          const data = await this.document.load(this.warcraftPath);
          await this.postMessage({ type: 'load', data });
          break;
        }
        case 'save': {
          await this.document.save(message.regionFile, message.points, message.instanceLinks);
          await this.postMessage({ type: 'saved', revision: message.revision });
          break;
        }
        case 'exportLua': {
          this.refreshLuaExportPath();
          const output = await this.document.exportPointsLua(message.points);
          if (!await this.postMessage({ type: 'luaExported', output })) {
            return;
          }
          const document = await vscode.workspace.openTextDocument(output);
          if (this.disposed) {
            return;
          }
          await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
          break;
        }
        case 'resource': {
          const data = await this.resources.read(message.path);
          await this.postMessage({
            type: 'resourceResult',
            requestId: message.requestId,
            path: message.path,
            base64: data?.toString('base64')
          });
          break;
        }
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      const messageText = error instanceof Error ? error.message : String(error);
      await this.postMessage({ type: 'error', message: messageText });
      if (this.disposed) {
        return;
      }
      await vscode.window.showErrorMessage(messageText);
    }
  }

  private async postMessage(message: unknown): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    try {
      return await this.panel.webview.postMessage(message);
    } catch (error) {
      if (this.disposed || /disposed/i.test(error instanceof Error ? error.message : String(error))) {
        return false;
      }
      throw error;
    }
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (TerrainPanel.current === this) {
      TerrainPanel.current = undefined;
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    void this.resources.close();
  }

  private refreshLuaExportPath(): void {
    const configuration = vscode.workspace.getConfiguration(
      'war3MapTools',
      this.configurationUri
    );
    this.document.setLuaExportPath(
      configuration.get<string>('luaExportPath', DEFAULT_LUA_EXPORT_PATH)
    );
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css'));
    const nonce = createNonce();
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>War3 Map Tools</title>
</head>
<body>
  <div id="app" class="app-shell">
    <header class="toolbar">
      <div class="view-control" role="group" aria-label="相机视图">
        <button class="view-button active" data-view="3d" title="倾斜透视三维视图">3D</button>
        <button class="view-button" data-view="top" title="垂直俯视">俯视</button>
      </div>
      <button id="fitButton" title="使地图适合窗口">适配地图</button>
      <div class="toolbar-spacer"></div>
      <button id="exportLuaButton" title="只为逻辑点生成 Lua">生成点位 Lua</button>
      <button id="saveButton" class="primary" title="写入 W3R 和点位文件">保存</button>
    </header>
    <main class="workspace">
      <section id="viewport" class="viewport" aria-label="魔兽地图地形视图">
        <div id="threeHost" class="three-host"></div>
        <canvas id="overlay" class="overlay"></canvas>
        <div id="loading" class="loading">正在读取地图...</div>
      </section>
      <aside class="inspector">
        <div class="tabs" role="tablist">
          <button class="tab active" data-tab="regions" role="tab">区域</button>
          <button class="tab" data-tab="points" role="tab">点 <span id="pointCount">0</span></button>
        </div>
        <section id="regionPanelHeader" class="region-panel-header">
          <div class="current-region">矩形区域：<strong id="currentRegionName">没有</strong></div>
          <div class="tool-settings-row">
            <button
              id="regionToolButton"
              class="region-tool-button"
              type="button"
              title="新建矩形区域（Space 切换新建/编辑）"
              aria-label="切换新建矩形区域状态"
              aria-pressed="false"
            ><span class="region-tool-icon" aria-hidden="true"></span></button>
            <div class="snap-settings">
              <label title="拖动点和区域时启用吸附"><input id="regionSnapEnabledInput" type="checkbox" checked>吸附</label>
              <label title="吸附距离（码）"><span>距离</span><input id="regionSnapDistanceInput" type="number" min="1" max="500" step="1" value="50"><span>码</span></label>
            </div>
          </div>
          <div class="region-list-heading">矩形区域 <span id="regionCount">0</span></div>
        </section>
        <section id="pointPanelHeader" class="region-panel-header" hidden>
          <div class="current-region">逻辑点：<strong id="currentPointName">没有</strong></div>
          <div class="tool-settings-row">
            <button
              id="pointToolButton"
              class="region-tool-button"
              type="button"
              title="新建逻辑点"
              aria-label="切换新建逻辑点状态"
              aria-pressed="false"
            ><span class="point-tool-icon" aria-hidden="true"></span></button>
            <div class="snap-settings">
              <label title="拖动点和区域时启用吸附"><input id="pointSnapEnabledInput" type="checkbox" checked>吸附</label>
              <label title="吸附距离（码）"><span>距离</span><input id="pointSnapDistanceInput" type="number" min="1" max="500" step="1" value="50"><span>码</span></label>
            </div>
          </div>
          <div class="region-list-heading">逻辑点 <span id="pointListCount">0</span></div>
        </section>
        <div id="itemList" class="item-list"></div>
        <form id="inspectorForm" class="inspector-form" autocomplete="off">
          <div id="emptyInspector" class="empty-inspector">选择一个区域或点</div>
          <div id="editorFields" hidden>
            <label>名称<input id="nameInput" type="text" maxlength="255"></label>
            <div id="regionFields" class="coordinate-grid" hidden>
              <label>左<input id="leftInput" type="number" step="1"></label>
              <label>右<input id="rightInput" type="number" step="1"></label>
              <label>下<input id="bottomInput" type="number" step="1"></label>
              <label>上<input id="topInput" type="number" step="1"></label>
            </div>
            <div id="pointFields" class="coordinate-grid" hidden>
              <label>X<input id="xInput" type="number" step="1"></label>
              <label>Y<input id="yInput" type="number" step="1"></label>
            </div>
            <button id="deleteButton" type="button" class="danger">删除</button>
          </div>
        </form>
      </aside>
    </main>
    <footer class="statusbar">
      <span id="statusText">等待地图数据</span>
      <span id="coordinateText"></span>
    </footer>
  </div>
  <div id="pasteDialog" class="modal-backdrop" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="pasteDialogTitle">
      <div id="pasteDialogTitle" class="modal-title">粘贴方式</div>
      <div id="pasteDialogHint" class="modal-hint"></div>
      <div class="modal-group">
        <label class="modal-option" title="粘贴出的对象与源对象保持联动，移动时会一起移动">
          <input id="pasteModeInstanceInput" type="radio" name="pasteMode" value="instance" checked>
          <span>实例</span>
        </label>
        <label class="modal-option" title="粘贴出的对象与源对象完全独立">
          <input id="pasteModeNormalInput" type="radio" name="pasteMode" value="normal">
          <span>普通</span>
        </label>
      </div>
      <div class="modal-group">
        <label class="modal-option" title="按左右或上下翻转粘贴出的对象">
          <input id="pasteMirrorInput" type="checkbox">
          <span>镜像</span>
        </label>
        <select id="pasteMirrorAxisInput" disabled title="镜像方向">
          <option value="horizontal" selected>左右</option>
          <option value="vertical">上下</option>
        </select>
      </div>
      <div class="modal-actions">
        <button id="pasteCancelButton" type="button">取消</button>
        <button id="pasteConfirmButton" type="button" class="primary">确定</button>
      </div>
    </div>
  </div>
  <div id="contextMenu" class="context-menu" role="menu" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function terrainTitle(root: string): string {
  return `War3 地形: ${vscode.Uri.file(root).path.split('/').pop() ?? root}`;
}

function createNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return value;
}
