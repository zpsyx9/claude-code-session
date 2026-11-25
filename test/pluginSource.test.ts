import { describe, it, expect } from 'vitest';
import { pluginFileUrl } from '../src/session/claudeEnvironment';

const REL = 'skills/foo/SKILL.md';

describe('pluginFileUrl', () => {
  it('joins a relative plugin path onto the github marketplace repo', () => {
    expect(pluginFileUrl('./plugins/foo', { source: 'github', repo: 'a/b' }, 'abc', REL))
      .toBe('https://github.com/a/b/blob/abc/plugins/foo/skills/foo/SKILL.md');
  });

  it('uses the git-subdir url and path, preferring the installed sha', () => {
    const src = { source: 'git-subdir', url: 'https://github.com/x/y.git', path: 'plugins/p', ref: 'main', sha: 'mk' };
    expect(pluginFileUrl(src, undefined, 'inst', REL)).toBe('https://github.com/x/y/blob/inst/plugins/p/skills/foo/SKILL.md');
    expect(pluginFileUrl(src, undefined, undefined, REL)).toBe('https://github.com/x/y/blob/mk/plugins/p/skills/foo/SKILL.md');
  });

  it('handles Windows separators and falls back to HEAD', () => {
    expect(pluginFileUrl({ source: 'url', url: 'https://github.com/x/y.git' }, undefined, undefined, ['skills', 'foo', 'SKILL.md'].join('\\')))
      .toBe('https://github.com/x/y/blob/HEAD/skills/foo/SKILL.md');
  });

  it('returns the repo root for non-github hosts and nothing for unknown sources', () => {
    expect(pluginFileUrl({ source: 'url', url: 'https://gitlab.com/x/y.git' }, undefined, 's', REL)).toBe('https://gitlab.com/x/y');
    expect(pluginFileUrl('./p', { source: 'directory' }, 's', REL)).toBeUndefined();
    expect(pluginFileUrl(undefined, undefined, 's', REL)).toBeUndefined();
  });
});
