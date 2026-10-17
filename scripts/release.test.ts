import { describe, expect, it } from 'vitest';
import { parseRelease } from '../landing/src/lib/release';
import { REPO } from '../landing/src/lib/site';

function fixture(tag = 'v0.1.1') {
  return {
    html_url: `${REPO}/releases/tag/${tag}`,
    assets: [
      'Perpetual_0.1.1_x64-setup.exe',
      'Perpetual_0.1.1_universal.dmg',
      'Perpetual_0.1.1_amd64.AppImage',
      'Perpetual_0.1.1_amd64.deb',
      'SHA256SUMS.txt',
    ].map((name) => ({
      name,
      size: 100,
      browser_download_url: `${REPO}/releases/download/${tag}/${name}`,
      digest: `sha256:${'a'.repeat(64)}`,
    })),
  };
}

describe('published downloads', () => {
  it('uses the release URLs and matching asset digests rather than a pinned version', () => {
    const release = parseRelease(fixture('v0.2.0'))!;
    expect(release.downloads.windows.url).toContain('/v0.2.0/');
    expect(release.checksums.url).toContain('/v0.2.0/');
    expect(release.downloads.windows.sha256).toBe('a'.repeat(64));
    expect(release.downloads.linux.url).toContain('/v0.2.0/Perpetual_0.1.1_amd64.AppImage');
    expect(release.downloads.linux.sha256).toBe('a'.repeat(64));
  });
  it.each([null, {}, { html_url: 123 }, { html_url: REPO, assets: [null] }])(
    'rejects malformed responses without throwing',
    (value) => {
      expect(parseRelease(value)).toBeNull();
    },
  );
  it('rejects ambiguous, incomplete, unpublished, and mixed-release assets', () => {
    const release = fixture();
    expect(parseRelease({ ...release, assets: [...release.assets, release.assets[0]] })).toBeNull();
    expect(parseRelease({ ...release, assets: release.assets.slice(1) })).toBeNull();
    expect(parseRelease({ ...release, draft: true })).toBeNull();
    expect(parseRelease({ ...release, prerelease: true })).toBeNull();
    release.assets[0].browser_download_url = `${REPO}/releases/download/v0.1.0/old.exe`;
    expect(parseRelease(release)).toBeNull();
  });
  it('retains the published manual checksum link when GitHub has no digest', () => {
    const release = fixture();
    release.assets[0].digest = '';
    expect(parseRelease(release)?.downloads.windows.sha256).toBeUndefined();
    expect(parseRelease(release)?.checksums.url).toContain('SHA256SUMS.txt');
  });
  it('rejects missing, ambiguous, or mixed-release Linux downloads', () => {
    const release = fixture();
    const linux = release.assets[2];
    expect(
      parseRelease({ ...release, assets: release.assets.filter((asset) => asset !== linux) }),
    ).toBeNull();
    expect(parseRelease({ ...release, assets: [...release.assets, linux] })).toBeNull();
    linux.browser_download_url = `${REPO}/releases/download/v0.1.0/${linux.name}`;
    expect(parseRelease(release)).toBeNull();
  });
});
