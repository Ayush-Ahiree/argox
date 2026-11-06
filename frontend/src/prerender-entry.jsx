// Build-time only (scripts/prerender.mjs): renders the public homepage to
// static HTML so search engines and link previews see real content
// instead of an empty <div id="root">.
import React from "react";
import { renderToString } from "react-dom/server";
import Home from "./Home.jsx";
import { FAQ } from "./Home.jsx";

export function renderHome() {
  return renderToString(<Home onSignIn={() => {}} onGetStarted={() => {}} />);
}

export function faqJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}
