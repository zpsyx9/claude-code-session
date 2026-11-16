import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeEnabledPlugins, writeEnabledPlugin, isValidPluginKey } from '../src/session/claudeEnvironment';

const KEY = 'frontend-design@claude-plugins-official';
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-toggle-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(name: string, data: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

describe('mergeEnabledPlugins', () => {
  it('lets later files override earlier ones', () => {
    const user = write('user.json', { enabledPlugins: { [KEY]: false, 'a@b': true } });
    const local = write('local.json', { enabledPlugins: { [KEY]: true } });
    expect(mergeEnabledPlugins([user, local])).toEqual({ [KEY]: true, 'a@b': true });
  });

  it('skips missing and unparseable files', () => {
    const bad = write('bad.json', '{ nope');
    const good = write('good.json', { enabledPlugins: { [KEY]: true } });
    expect(mergeEnabledPlugins([path.join(dir, 'missing.json'), bad, good])).toEqual({ [KEY]: true });
  });
});

describe('writeEnabledPlugin', () => {
  it('creates .claude/settings.local.json when absent', () => {
    const file = path.join(dir, '.claude', 'settings.local.json');
    writeEnabledPlugin(file, KEY, true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ enabledPlugins: { [KEY]: true } });
  });

  it('keeps other keys', () => {
    const file = write('local.json', { permissions: { allow: ['Read'] }, enabledPlugins: { 'a@b': true } });
    writeEnabledPlugin(file, KEY, false);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      permissions: { allow: ['Read'] },
      enabledPlugins: { 'a@b': true, [KEY]: false },
    });
  });

  it('refuses to overwrite an unparseable file', () => {
    const file = write('local.json', '{ nope');
    expect(() => writeEnabledPlugin(file, KEY, true)).toThrow();
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ nope');
  });

  it('rejects keys with unexpected characters', () => {
    expect(isValidPluginKey('x"@y')).toBe(false);
    expect(() => writeEnabledPlugin(path.join(dir, 'l.json'), '__proto__', true)).toThrow();
  });
});
