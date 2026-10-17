// Temporarily retained for restoring installer downloads once signing is ready.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { REPO, detectPlatform, type Platform } from '../lib/site';
import type { Release } from '../lib/release';
import { fileMatchesSha256 } from '../lib/checksum';
import { AppleLogo, WindowsLogo, TerminalLogo } from './Mark';

export type DownloadPlatform = Exclude<Platform, 'other'>;

type DownloadFlow = {
  platform: Platform;
  showInstructions: (platform: DownloadPlatform, release: Release) => void;
};

const DownloadContext = createContext<DownloadFlow | null>(null);
const CLONE_COMMAND = `git clone --branch dev ${REPO}.git`;
type Verification = {
  status: 'idle' | 'checking' | 'matched' | 'mismatch' | 'error';
  name?: string;
};

export function useDownloadFlow(): DownloadFlow {
  const flow = useContext(DownloadContext);
  if (!flow) throw new Error('DownloadFlow is missing its provider');
  return flow;
}

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [platform] = useState<Platform>(detectPlatform);
  const [instructionsFor, setInstructionsFor] = useState<{
    platform: DownloadPlatform;
    release: Release;
  } | null>(null);

  return (
    <DownloadContext.Provider
      value={{
        platform,
        showInstructions: (platform, release) => setInstructionsFor({ platform, release }),
      }}
    >
      {children}
      {instructionsFor && (
        <InstallDialog
          platform={instructionsFor.platform}
          release={instructionsFor.release}
          onClose={() => setInstructionsFor(null)}
        />
      )}
    </DownloadContext.Provider>
  );
}

function InstallDialog({
  platform,
  release,
  onClose,
}: {
  platform: DownloadPlatform;
  release: Release;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [checksumCopied, setChecksumCopied] = useState(false);
  const [verification, setVerification] = useState<Verification>({ status: 'idle' });
  const asset = release.downloads[platform];
  const isWindows = platform === 'windows';
  const isLinux = platform === 'linux';
  const checksumCommand = isWindows
    ? `Get-FileHash .\\${asset.name} -Algorithm SHA256`
    : isLinux
      ? `sha256sum ${asset.name}`
      : `shasum -a 256 ${asset.name}`;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  async function copyCloneCommand() {
    try {
      await navigator.clipboard.writeText(CLONE_COMMAND);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function verifyFile(file: File | undefined) {
    if (!file || !asset.sha256) return;
    setVerification({ status: 'checking', name: file.name });
    try {
      setVerification({
        status: (await fileMatchesSha256(file, asset.sha256)) ? 'matched' : 'mismatch',
        name: file.name,
      });
    } catch {
      setVerification({ status: 'error', name: file.name });
    }
  }

  async function copyChecksumCommand() {
    try {
      await navigator.clipboard.writeText(checksumCommand);
      setChecksumCopied(true);
    } catch {
      setChecksumCopied(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="install-dialog-title"
      className="m-auto max-h-[88dvh] w-[min(92vw,520px)] overflow-y-auto rounded-2xl border border-line-strong bg-card p-0 text-ink shadow-[0_30px_100px_rgba(0,0,0,0.75)] backdrop:bg-black/75"
    >
      <div className="p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-[13px] font-medium text-muted">
              {isWindows ? (
                <WindowsLogo size={15} />
              ) : isLinux ? (
                <TerminalLogo size={15} />
              ) : (
                <AppleLogo size={15} />
              )}
              {isWindows ? 'Windows x64' : isLinux ? 'Linux x86_64' : 'macOS universal'}
            </p>
            <h2
              id="install-dialog-title"
              className="mt-2 text-[24px] font-semibold tracking-tight text-sage"
            >
              Install your download
            </h2>
            <p className="mt-1.5 text-[14px] leading-6 text-muted">
              When it finishes, open the downloaded file to install Perpetual.
            </p>
          </div>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            aria-label="Close download instructions"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[23px] leading-none text-muted transition-colors hover:bg-white/10 hover:text-ink"
          >
            ×
          </button>
        </div>

        <div className="mt-6 text-[14px] leading-6 text-muted">
          <section className="rounded-xl border border-line bg-white/[0.025] p-4">
            <h3 className="font-medium text-sage">Install Perpetual</h3>
            {isWindows ? (
              <p className="mt-2">
                Open <span className="font-medium text-ink">{asset.name}</span> from your Downloads
                folder and follow the installer. If SmartScreen appears, choose{' '}
                <strong className="font-medium text-ink">More info</strong>
                <span className="sr-only">, then </span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  className="mx-1 inline size-4 align-[-0.18em] text-ink"
                >
                  <path
                    d="M2.5 10h14m-5-5 5 5-5 5"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>{' '}
                <strong className="font-medium text-ink">Run anyway</strong>. You can verify the
                checksum below. Managed PCs may block unsigned apps.
              </p>
            ) : isLinux ? (
              <p className="mt-2">
                Make <span className="font-medium text-ink">{asset.name}</span> executable in its
                file properties and open it. Requires Ubuntu 22.04 / Debian 12 or newer, or a
                comparable distribution. If FUSE is unavailable, run the AppImage from your terminal
                with <code>--appimage-extract-and-run</code>. Debian, Ubuntu, and Mint users can
                also install the .deb package from the release page.
              </p>
            ) : (
              <p className="mt-2">
                Open <span className="font-medium text-ink">{asset.name}</span> and drag Perpetual
                to Applications. If macOS blocks the first launch, check the download, then go to{' '}
                <strong className="font-medium text-ink">
                  System Settings → Privacy &amp; Security → Open Anyway
                </strong>
                .
              </p>
            )}
          </section>
          <section className="mt-4 rounded-xl border border-line p-4 text-[13px]">
            <h3 className="font-medium text-sage">Set up your coding agent</h3>
            <p className="mt-2">
              Install{' '}
              <a className="text-ink underline" href="https://git-scm.com/downloads">
                Git
              </a>{' '}
              and either{' '}
              <a className="text-ink underline" href="https://developers.openai.com/codex/cli">
                Codex CLI
              </a>{' '}
              or{' '}
              <a
                className="text-ink underline"
                href="https://docs.anthropic.com/en/docs/claude-code/setup"
              >
                Claude Code
              </a>
              . Restart Perpetual after installing them, then sign in from the app. Existing CLI
              sign-ins are detected automatically.
            </p>
          </section>
          <p className="mt-4 text-[13px]">
            Download not starting?{' '}
            <a className="font-medium text-ink underline underline-offset-4" href={asset.url}>
              Download from GitHub
            </a>
          </p>
          <details className="group mt-5 border-t border-line pt-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-medium text-ink transition-colors hover:text-muted [&::-webkit-details-marker]:hidden">
              Verify the download with a SHA-256 checksum
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180"
              >
                <path
                  d="m5 7.5 5 5 5-5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </summary>
            <div className="mt-4 text-[13px] leading-5">
              <p>
                {asset.sha256
                  ? 'Choose the installer you downloaded to check it in your browser. The file is not uploaded.'
                  : 'Browser verification is unavailable for this release. Use the manual command below and compare with the published checksums.'}
              </p>
              <input
                ref={fileInput}
                type="file"
                accept={isWindows ? '.exe' : '.dmg'}
                className="sr-only"
                aria-label="Choose downloaded installer to verify"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  void verifyFile(file);
                }}
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={!asset.sha256 || verification.status === 'checking'}
                className="mt-3 rounded-lg border border-line-strong px-3 py-2 text-[12px] font-medium text-ink transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
              >
                {verification.status === 'checking' ? 'Checking file…' : 'Choose downloaded file'}
              </button>
              <p aria-live="polite" className="mt-2 min-h-5">
                {verification.status === 'checking' &&
                  `Calculating SHA-256 for ${verification.name}…`}
                {verification.status === 'matched' && (
                  <span className="text-good">
                    Verified: {verification.name} matches this release.
                  </span>
                )}
                {verification.status === 'mismatch' && (
                  <span className="text-warn">
                    Checksum does not match. Do not open {verification.name}; download it again from
                    GitHub.
                  </span>
                )}
                {verification.status === 'error' &&
                  'Could not check this file in your browser. Use the manual command below.'}
              </p>
              <div className="mt-4 border-t border-line pt-4">
                <p className="font-medium text-ink">Verify manually</p>
                <p>
                  In your Downloads folder, run this command and compare the result with the{' '}
                  <a className="text-ink underline underline-offset-4" href={release.checksums.url}>
                    published checksums
                  </a>
                  .
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-black/30 px-3 py-2 text-[12px] text-ink">
                    {checksumCommand}
                  </code>
                  <button
                    type="button"
                    aria-label="Copy checksum command"
                    onClick={() => void copyChecksumCommand()}
                    className="shrink-0 rounded-lg border border-line px-3 py-2 text-[12px] font-medium text-ink transition-colors hover:bg-white/10"
                  >
                    {checksumCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="mt-2">Expected SHA-256</p>
                <code className="block break-all text-[12px] text-ink">
                  {asset.sha256 ?? 'See the published checksum list'}
                </code>
              </div>
            </div>
          </details>
          <section className="mt-5 border-t border-line pt-4 text-[13px]">
            <p>
              Prefer to build from source?{' '}
              <a
                className="text-ink underline underline-offset-4"
                href={`${REPO}/blob/dev/README.md#build-from-source`}
              >
                View the setup guide
              </a>
              .
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-black/30 px-3 py-2 font-mono text-[12px] text-ink">
                {CLONE_COMMAND}
              </code>
              <button
                type="button"
                aria-label="Copy source command"
                onClick={() => void copyCloneCommand()}
                className="shrink-0 rounded-lg border border-line px-3 py-2 text-[12px] font-medium text-ink transition-colors hover:bg-white/10"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <span className="sr-only" aria-live="polite">
              {copied ? 'Clone command copied to clipboard' : ''}
            </span>
          </section>
        </div>
      </div>
    </dialog>
  );
}
