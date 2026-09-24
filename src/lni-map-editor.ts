import * as path from 'node:path';
import * as vscode from 'vscode';
import { MapDocument } from './map-document';
import { TerrainPanel } from './terrain-panel';
import { resolveWarcraftPath } from './warcraft-path';

export const LNI_MAP_EDITOR_VIEW_TYPE = 'war3MapTools.lniMap';

class LniMapMarkerDocument implements vscode.CustomDocument {
  public constructor(public readonly uri: vscode.Uri) {}

  public dispose(): void {}
}

export class LniMapEditorProvider implements vscode.CustomReadonlyEditorProvider<LniMapMarkerDocument> {
  public constructor(private readonly extensionUri: vscode.Uri) {}

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<LniMapMarkerDocument> {
    if (path.basename(uri.fsPath).toLowerCase() !== '.w3x') {
      throw new Error('War3 LNI 地图入口必须是地图根目录中的 .w3x 文件。');
    }
    const root = path.dirname(uri.fsPath);
    if (!(await MapDocument.isMapRoot(root))) {
      throw new Error(
        `无法从 ${uri.fsPath} 打开 LNI 地图：` +
        `${path.join(root, 'map', 'war3map.w3e')} 或 war3map.w3r 不存在。`
      );
    }
    return new LniMapMarkerDocument(uri);
  }

  public async resolveCustomEditor(
    marker: LniMapMarkerDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const root = path.dirname(marker.uri.fsPath);
    const configuration = vscode.workspace.getConfiguration('war3MapTools', marker.uri);
    const encoding = configuration.get<string>('textEncoding', 'gbk');
    const warcraftPath = await resolveWarcraftPath(configuration.get<string>('warcraftPath', ''));
    const luaExportPath = configuration.get<string>('luaExportPath', '.war3tool/points.lua');
    TerrainPanel.resolve(
      webviewPanel,
      this.extensionUri,
      new MapDocument(root, encoding, luaExportPath, workspaceRootFor(marker.uri)),
      warcraftPath,
      marker.uri
    );
  }
}

function workspaceRootFor(mapMarker: vscode.Uri): string {
  return vscode.workspace.getWorkspaceFolder(mapMarker)?.uri.fsPath ?? path.dirname(mapMarker.fsPath);
}
