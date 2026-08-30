import * as path from 'node:path';
import * as vscode from 'vscode';
import { LNI_MAP_EDITOR_VIEW_TYPE, LniMapEditorProvider } from './lni-map-editor';
import { MapDocument } from './map-document';
import { TerrainPanel } from './terrain-panel';
import { resolveWarcraftPath } from './warcraft-path';

const OPEN_COMMAND = 'war3MapTools.openTerrain';
const CONFIGURE_COMMAND = 'war3MapTools.configureWarcraftPath';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      LNI_MAP_EDITOR_VIEW_TYPE,
      new LniMapEditorProvider(context.extensionUri),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true }
      }
    ),
    vscode.commands.registerCommand(OPEN_COMMAND, async () => {
      try {
        const root = await chooseMapRoot();
        if (root === undefined) {
          return;
        }
        const configuration = vscode.workspace.getConfiguration('war3MapTools', vscode.Uri.file(root));
        const encoding = configuration.get<string>('textEncoding', 'gbk');
        const warcraftPath = await resolveWarcraftPath(configuration.get<string>('warcraftPath', ''));
        const luaExportPath = configuration.get<string>('luaExportPath', '.war3tool/points.lua');
        await TerrainPanel.show(
          context.extensionUri,
          new MapDocument(root, encoding, luaExportPath),
          warcraftPath
        );
      } catch (error) {
        await vscode.window.showErrorMessage(errorMessage(error));
      }
    }),
    vscode.commands.registerCommand(CONFIGURE_COMMAND, async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:dogeechou.war3-rect-edit'
      );
    })
  );
}

export function deactivate(): void {}

async function chooseMapRoot(): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await MapDocument.isMapRoot(folder.uri.fsPath)) {
      candidates.push(folder.uri.fsPath);
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    return vscode.window.showQuickPick(candidates, {
      placeHolder: '选择一个 LNI 地图根目录'
    });
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '打开 LNI 地图根目录',
    title: '选择包含 map/war3map.w3e 和 map/war3map.w3r 的目录'
  });
  const root = selected?.[0]?.fsPath;
  if (root === undefined) {
    return undefined;
  }
  if (!(await MapDocument.isMapRoot(root))) {
    throw new Error(
      `所选目录不是可识别的 LNI 地图：${path.join(root, 'map', 'war3map.w3e')} 或 war3map.w3r 不存在。`
    );
  }
  return root;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
