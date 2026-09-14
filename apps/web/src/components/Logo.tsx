import type { SVGProps } from "react";

// The Taakify brand mark: a house frame (the household) holding three book
// spines standing on an open-book base (the catalog). Use this wherever the
// brand identity itself needs to appear -- it isn't a stand-in for "no
// cover image" placeholders elsewhere in the app; those stay on lucide's
// BookOpen since they represent an individual book, not the product.
//
// Colors are fixed brand colors, not `currentColor` -- unlike a single-tone
// icon, this mark's identity IS its three-color palette, so it doesn't
// adapt to a parent's text color the way other icons in the app do. Sizing
// still works the normal way via `className`/`width`/`height` props.
export function Logo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4 9 12 3 20 9"
        fill="none"
        stroke="var(--primary)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 9v8" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M20 9v8" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="8" y="9.5" width="2.1" height="7.5" rx="0.5" fill="var(--primary)" />
      <rect x="10.6" y="7.3" width="2.6" height="9.7" rx="0.5" fill="var(--logo-terracotta)" />
      <rect x="13.7" y="10.4" width="2.1" height="6.6" rx="0.5" fill="var(--logo-gold)" />
      <path
        d="M4 17c2.8-0.9 5.5-0.4 8 1 2.5-1.4 5.2-1.9 8-1v3c-2.8-0.9-5.5-0.4-8 1-2.5-1.4-5.2-1.9-8-1z"
        fill="var(--primary)"
      />
    </svg>
  );
}
