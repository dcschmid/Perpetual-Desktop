import { ExtensionButton } from './ExtensionButton';
import { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import { REPO } from '../lib/site';
import { useDownloadFlow } from './DownloadFlow';
import { AppleLogo, WindowsLogo, TerminalLogo } from './Mark';
import { Reveal } from './Reveal';

const PLATFORMS = [
  { id: 'windows', label: 'Windows', note: 'Source', Logo: WindowsLogo },
  { id: 'mac', label: 'macOS', note: 'Source', Logo: AppleLogo },
  { id: 'linux', label: 'Linux', note: 'Source', Logo: TerminalLogo },
] as const;

export function Download() {
  const section = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: section,
    offset: ['start end', 'center center'],
  });
  const p = useSpring(scrollYProgress, { stiffness: 120, damping: 26, mass: 0.5 });
  // The icon swings up out of the floor and squares up to face you.
  const rotateX = useTransform(p, [0, 1], [reduce ? 0 : 58, 0]);
  const rotateY = useTransform(p, [0, 1], [reduce ? 0 : -24, 0]);
  const y = useTransform(p, [0, 1], [reduce ? 0 : 120, 0]);
  const glow = useTransform(p, [0.4, 1], [0, 1]);

  return (
    <section
      id="download"
      ref={section}
      className="relative isolate overflow-hidden px-5 pt-10 pb-24 sm:px-8 sm:pb-28"
    >
      <motion.div
        aria-hidden
        style={{ opacity: glow }}
        className="absolute top-0 left-1/2 -z-10 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(178,205,189,0.14),transparent)]"
      />

      <div className="flex justify-center [perspective:900px]">
        <motion.div
          style={{ rotateX, rotateY, y }}
          className="relative [transform-style:preserve-3d]"
        >
          <img
            src={`${import.meta.env.BASE_URL}icon.png`}
            alt="Perpetual app icon"
            width={176}
            height={176}
            className="icon-float relative size-[148px] drop-shadow-[0_40px_50px_rgba(0,0,0,0.75)] sm:size-[176px]"
          />
          {/* A soft reflection on the floor beneath. */}
          <img
            src={`${import.meta.env.BASE_URL}icon.png`}
            alt=""
            aria-hidden
            className="absolute top-full left-0 mt-3 size-[148px] scale-y-[-1] opacity-[0.12] blur-[2px] [mask-image:linear-gradient(to_top,black,transparent_55%)] sm:size-[176px]"
          />
        </motion.div>
      </div>

      <Reveal className="relative mx-auto mt-20 max-w-3xl text-center">
        <h2 className="text-[40px] leading-[1.04] font-semibold tracking-[-0.045em] sm:text-[60px]">
          <span className="headline-gradient">Keep your agents working.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-md text-[17px] leading-7 text-muted">
          Free for Windows, macOS, and Linux. Works with the Codex CLI and Claude Code you already
          use.
        </p>
      </Reveal>

      <DownloadActions />
      <div className="mt-6 flex justify-center">
        <ExtensionButton />
      </div>
    </section>
  );
}

function DownloadActions() {
  const { platform, showInstructions } = useDownloadFlow();
  const primary = platform === 'other' ? 'windows' : platform;
  return (
    <>
      <Reveal delay={0.1} className="mt-9 flex flex-wrap items-center justify-center gap-3">
        {PLATFORMS.map(({ id, label, note, Logo }) =>
          id === primary ? (
            <button
              type="button"
              key={id}
              onClick={() => showInstructions(id)}
              className="inline-flex h-12 items-center gap-2.5 rounded-full bg-ink px-6 text-[15px] font-medium text-bg shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_10px_30px_-12px_rgba(255,255,255,0.35)] transition-[transform,box-shadow] duration-300 hover:-translate-y-px hover:shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_16px_40px_-12px_rgba(255,255,255,0.45)]"
            >
              <Logo size={16} />
              {`Download for ${label}`}
              <span className="text-bg/50">{note}</span>
            </button>
          ) : (
            <button
              type="button"
              key={id}
              onClick={() => showInstructions(id)}
              className="inline-flex h-12 items-center gap-2.5 rounded-full px-6 text-[15px] font-medium text-muted ring-1 ring-line-strong transition-colors hover:bg-white/[0.04] hover:text-ink"
            >
              <Logo size={16} />
              {label}
              <span className="text-faint">{note}</span>
            </button>
          ),
        )}
      </Reveal>

      <Reveal delay={0.16} className="mt-7 flex flex-col items-center gap-3 text-center">
        <p id="download-status" className="text-[13px] text-muted">
          Clone the source and run npm start. Setup builds and opens Perpetual on your computer.
        </p>
        {/* Installer notice paused until signed downloads return.
        {release && (
          <p className="max-w-2xl text-[13px] leading-6 text-faint">
            These installers are unsigned. Windows SmartScreen or macOS Gatekeeper may warn on first
            open. Verify the file before running it with{' '}
            <a
              className="text-muted underline underline-offset-4 hover:text-ink"
              href={release.checksums.url}
            >
              SHA256SUMS.txt
            </a>
            : on Windows run <code>Get-FileHash .\Installer.exe -Algorithm SHA256</code>; on macOS
            run <code>shasum -a 256 Installer.dmg</code>. Match the result to your file’s entry in
            the checksum list.{' '}
            <a
              className="text-muted underline underline-offset-4 hover:text-ink"
              href={release.url}
            >
              Release notes and build provenance
            </a>
            .
          </p>
        )}
        */}
        <a
          href={`${REPO}/blob/dev/README.md#build-from-source`}
          className="inline-flex items-center gap-2 text-center text-[13px] text-balance text-faint transition-colors hover:text-muted"
        >
          <svg
            className="hidden shrink-0 sm:block"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          View the source setup guide on GitHub
        </a>
      </Reveal>
    </>
  );
}
