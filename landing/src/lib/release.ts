import { REPO, type Platform } from './site';

type DownloadPlatform = Exclude<Platform, 'other'>;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  sha256?: string;
}

export interface Release {
  url: string;
  checksums: ReleaseAsset;
  downloads: Record<DownloadPlatform, ReleaseAsset>;
}

// GitHub Pages serves a release snapshot generated with the workflow token.
// Local development reads the public API directly.
const API =
  import.meta.env.BASE_URL === '/'
    ? 'https://api.github.com/repos/SakethSripada/Perpetual-Desktop/releases/latest'
    : `${import.meta.env.BASE_URL}release.json`;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function selectAsset(assets: unknown[], pattern: RegExp, tag: string): ReleaseAsset | null {
  const matches: ReleaseAsset[] = [];
  for (const value of assets) {
    const asset = object(value);
    if (!asset || typeof asset.name !== 'string' || !pattern.test(asset.name)) continue;
    if (
      typeof asset.size !== 'number' ||
      !Number.isFinite(asset.size) ||
      asset.size <= 0 ||
      typeof asset.browser_download_url !== 'string' ||
      asset.browser_download_url !==
        `${REPO}/releases/download/${tag}/${encodeURIComponent(asset.name)}`
    )
      return null;
    const sha256 =
      typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest)
        ? asset.digest.slice(7).toLowerCase()
        : undefined;
    matches.push({ name: asset.name, url: asset.browser_download_url, size: asset.size, sha256 });
  }
  return matches.length === 1 ? matches[0] : null;
}

export function parseRelease(value: unknown): Release | null {
  const release = object(value);
  if (
    !release ||
    typeof release.html_url !== 'string' ||
    !Array.isArray(release.assets) ||
    release.draft === true ||
    release.prerelease === true
  )
    return null;
  const prefix = `${REPO}/releases/tag/`;
  if (!release.html_url.startsWith(prefix)) return null;
  const tag = release.html_url.slice(prefix.length);
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) return null;
  const windows = selectAsset(release.assets, /x64-setup\.exe$/i, tag);
  const mac = selectAsset(release.assets, /universal\.dmg$/i, tag);
  const linux = selectAsset(release.assets, /_amd64\.AppImage$/i, tag);
  const checksums = selectAsset(release.assets, /^SHA256SUMS\.txt$/, tag);
  if (!windows || !mac || !linux || !checksums) return null;
  return { url: release.html_url, checksums, downloads: { windows, mac, linux } };
}

let releasePromise: Promise<Release | null> | null = null;

/** A missing, private, or incomplete release is never presented as a download. */
export function latestRelease(): Promise<Release | null> {
  if (!releasePromise) {
    releasePromise = fetch(API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-cache',
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => (data ? parseRelease(data) : null))
      .catch(() => null);
  }
  return releasePromise;
}
