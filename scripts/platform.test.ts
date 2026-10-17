import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform } from '../landing/src/lib/site';

afterEach(() => vi.unstubAllGlobals());

describe('download platform detection', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'mac'],
    ['Mozilla/5.0 (Linux; Android 14)', 'other'],
  ])('detects %s as %s', (userAgent, platform) => {
    vi.stubGlobal('navigator', { userAgent });
    expect(detectPlatform()).toBe(platform);
  });

  it('uses browser platform hints for Linux', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0', userAgentData: { platform: 'Linux' } });
    expect(detectPlatform()).toBe('linux');
  });
});
