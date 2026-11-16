import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { categorizeSkill, SkillCategory } from './categorize';

export const CLAUDE_DIR            = path.join(os.homedir(), '.claude');
export const CLAUDE_PROJECTS_DIR   = path.join(CLAUDE_DIR, 'projects');
export const CLAUDE_SETTINGS_PATH  = path.join(CLAUDE_DIR, 'settings.json');
export const CLAUDE_CONFIG_PATH    = path.join(os.homedir(), '.claude.json');

/**
 * Claude Code names each folder under ~/.claude/projects after the project's
 * absolute path with every non-alphanumeric character replaced by '-'
 * (e.g. "/Users/niko/My App" → "-Users-niko-My-App").
 */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface SkillInfo {
  name:        string;
  source:      string;
  description: string;
  category:    SkillCategory;
  pluginKey?:  string;
  enabled?:    boolean;
}

const PLUGIN_KEY_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

export function isValidPluginKey(key: string): boolean {
  return PLUGIN_KEY_RE.test(key);
}

export function pluginSettingsFiles(workspaceRoot?: string): string[] {
  const files = [CLAUDE_SETTINGS_PATH];
  if (workspaceRoot) {
    files.push(
      path.join(workspaceRoot, '.claude', 'settings.json'),
      path.join(workspaceRoot, '.claude', 'settings.local.json'),
    );
  }
  return files;
}

/** Later files override earlier ones, matching Claude Code's user < project < local cascade. */
export function mergeEnabledPlugins(files: string[]): Record<string, boolean> {
  const merged: Record<string, boolean> = {};
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) { continue; }
      const enabled = JSON.parse(fs.readFileSync(file, 'utf-8')).enabledPlugins;
      if (!enabled || typeof enabled !== 'object') { continue; }
      for (const [key, value] of Object.entries(enabled)) {
        if (typeof value === 'boolean') { merged[key] = value; }
      }
    } catch { /* unparseable settings are ignored by Claude Code too */ }
  }
  return merged;
}

/**
 * Sets enabledPlugins[key] in one settings file, keeping every other key.
 * Throws rather than overwriting a file that does not parse.
 */
export function writeEnabledPlugin(file: string, key: string, enabled: boolean): void {
  if (!isValidPluginKey(key)) { throw new Error(`Invalid plugin key: ${key}`); }
  let data: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file} is not a JSON object`);
    }
    data = parsed;
  }
  const current = data.enabledPlugins;
  const plugins = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  plugins[key] = enabled;
  data.enabledPlugins = plugins;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function parseSkillDescription(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/description:\s*>?\s*\n?\s*(.+?)(?:\n\S|\n---)/s);
    if (match) {
      return match[1].replace(/\n\s*/g, ' ').trim().slice(0, 120);
    }
    const singleLine = content.match(/description:\s*["']?(.+?)["']?\s*$/m);
    if (singleLine) {
      return singleLine[1].trim().slice(0, 120);
    }
  } catch { /* ignore */ }
  return '';
}

export function getMcpServers(): string[] {
  const servers = new Set<string>();
  // Legacy location (~/.claude/mcp.json) and the current one (~/.claude.json).
  for (const file of [path.join(CLAUDE_DIR, 'mcp.json'), CLAUDE_CONFIG_PATH]) {
    try {
      if (!fs.existsSync(file)) { continue; }
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      for (const name of Object.keys(data.mcpServers ?? {})) {
        servers.add(name);
      }
    } catch { /* ignore */ }
  }
  return Array.from(servers);
}

export function getSkills(workspaceRoot?: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  const enabledPlugins = mergeEnabledPlugins(pluginSettingsFiles(workspaceRoot));

  try {
    const userSkillsDir = path.join(CLAUDE_DIR, 'skills');
    if (fs.existsSync(userSkillsDir)) {
      for (const name of fs.readdirSync(userSkillsDir)) {
        const skillFile = path.join(userSkillsDir, name, 'SKILL.md');
        if (fs.existsSync(skillFile) && !seen.has(name)) {
          seen.add(name);
          const description = parseSkillDescription(skillFile);
          skills.push({ name, source: 'user', description, category: categorizeSkill(name, description) });
        }
      }
    }
  } catch { /* ignore */ }

  try {
    const cacheDir = path.join(CLAUDE_DIR, 'plugins', 'cache');
    if (fs.existsSync(cacheDir)) {
      for (const vendor of fs.readdirSync(cacheDir)) {
        const vendorDir = path.join(cacheDir, vendor);
        try {
          if (!fs.statSync(vendorDir).isDirectory()) { continue; }
          for (const plugin of fs.readdirSync(vendorDir)) {
            const pluginDir = path.join(vendorDir, plugin);
            try {
              if (!fs.statSync(pluginDir).isDirectory()) { continue; }
              const key = `${plugin}@${vendor}`;
              const pluginKey = isValidPluginKey(key) ? key : undefined;
              const enabled = pluginKey ? enabledPlugins[pluginKey] === true : undefined;
              const candidates = [path.join(pluginDir, 'skills')];
              for (const version of fs.readdirSync(pluginDir)) {
                candidates.push(path.join(pluginDir, version, 'skills'));
              }
              for (const skillsDir of candidates) {
                try {
                  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) { continue; }
                  for (const name of fs.readdirSync(skillsDir)) {
                    const sf = path.join(skillsDir, name, 'SKILL.md');
                    if (!seen.has(name) && fs.existsSync(sf)) {
                      seen.add(name);
                      const description = parseSkillDescription(sf);
                      skills.push({ name, source: 'plugin', description, category: categorizeSkill(name, description), pluginKey, enabled });
                    }
                  }
                } catch { /* ignore */ }
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
