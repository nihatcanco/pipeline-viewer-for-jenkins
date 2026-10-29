import * as vscode from 'vscode';
import { JenkinsParameter } from './jenkinsClient';

type Kind = 'boolean' | 'choice' | 'password' | 'file' | 'string';

function kindOf(param: JenkinsParameter): Kind {
  const type = param.type ?? '';
  if (/Boolean/.test(type)) {
    return 'boolean';
  }
  if (param.choices) {
    return 'choice';
  }
  if (/Password/.test(type)) {
    return 'password';
  }
  if (/File/.test(type)) {
    return 'file';
  }
  return 'string';
}

/** File parameters need a multipart upload, which only the Jenkins web page offers. */
export function needsBrowser(params: JenkinsParameter[]): boolean {
  return params.some((param) => kindOf(param) === 'file');
}

function defaultValue(param: JenkinsParameter): string {
  const value = param.defaultParameterValue?.value;
  // Jenkins starts a choice parameter without a default at its first choice.
  return value === undefined || value === null ? (param.choices?.[0] ?? '') : String(value);
}

/** Jenkins allows HTML in descriptions; a quick pick shows plain text. */
function plainText(html: string | null | undefined): string | undefined {
  const text = html
    ?.replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

interface ParameterItem extends vscode.QuickPickItem {
  param?: JenkinsParameter;
}

/**
 * Lets the user review and change parameter values before a build. Resolves to the changed values only,
 * so Jenkins applies its own defaults to the rest, or to undefined when the user cancels.
 */
export async function promptForParameters(
  title: string,
  params: JenkinsParameter[],
): Promise<Record<string, string> | undefined> {
  const changed = new Map<string, string>();
  const start: ParameterItem = { label: '$(play) Build', description: 'Start the build with these values' };
  for (;;) {
    const items: ParameterItem[] = [
      start,
      { label: 'Parameters', kind: vscode.QuickPickItemKind.Separator },
      ...params.map((param) => {
        const edited = changed.has(param.name);
        const value = kindOf(param) === 'password' ? (edited ? '••••••' : '(default)') : (changed.get(param.name) ?? defaultValue(param));
        return {
          label: param.name,
          description: edited ? `${value}  (changed)` : value,
          detail: plainText(param.description),
          param,
        };
      }),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Pick a parameter to change it, or Build to start',
      ignoreFocusOut: true,
    });
    if (!pick) {
      return undefined;
    }
    if (!pick.param) {
      return Object.fromEntries(changed);
    }
    const value = await editValue(pick.param, changed.get(pick.param.name) ?? defaultValue(pick.param));
    if (value !== undefined) {
      changed.set(pick.param.name, value);
    }
  }
}

async function editValue(param: JenkinsParameter, current: string): Promise<string | undefined> {
  const title = param.name;
  const prompt = plainText(param.description);
  switch (kindOf(param)) {
    case 'boolean':
    case 'choice': {
      const options = kindOf(param) === 'boolean' ? ['true', 'false'] : param.choices ?? [];
      const items = options.map((label) => ({ label, picked: label === current, description: label === current ? 'current' : undefined }));
      return (await vscode.window.showQuickPick(items, { title, placeHolder: prompt, ignoreFocusOut: true }))?.label;
    }
    case 'password':
      return vscode.window.showInputBox({ title, prompt, password: true, ignoreFocusOut: true });
    default:
      return vscode.window.showInputBox({ title, prompt, value: current, ignoreFocusOut: true });
  }
}
