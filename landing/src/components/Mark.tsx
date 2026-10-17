/** Perpetual's mark, drawn with the current text color. */
export function Mark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      className={className}
    >
      <path
        d="M32 12v40M17 22l15 14 15-14M14 49l18-17 18 17"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="12" r="6" fill="currentColor" />
      <circle cx="32" cy="34" r="7" fill="currentColor" />
      <circle cx="14" cy="49" r="6" fill="currentColor" />
      <circle cx="50" cy="49" r="6" fill="currentColor" />
    </svg>
  );
}

export function WindowsLogo({ size = 15 }: { size?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d="M3 5.1 10.4 4v7.2H3zM11.3 3.9 21 2.5v8.7h-9.7zM3 12.2h7.4v7.3L3 18.4zM11.3 12.2H21v8.7l-9.7-1.4z" />
    </svg>
  );
}

export function TerminalLogo({ size = 15 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="m6 9 3 3-3 3m6 0h5" />
    </svg>
  );
}

export function AppleLogo({ size = 15 }: { size?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d="M16.4 12.6c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-1.9-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.8-1-2.8-4.2zM14 5.2c.7-.8 1.1-2 1-3.2-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.5 2.9-1.3z" />
    </svg>
  );
}

export function GithubLogo({ size = 17 }: { size?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5" />
    </svg>
  );
}
