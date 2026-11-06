/**
 * All blog interactions. Runs on every `astro:page-load` (first load and
 * after each client-side navigation). Window/document listeners are tied
 * to a per-page AbortController so they don't pile up across navigations.
 */

let page: AbortController | null = null;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function init() {
  page?.abort();
  page = new AbortController();
  const signal = page.signal;
  document.addEventListener("astro:before-swap", () => page?.abort(), { once: true });

  themeToggle();
  reveal(signal);
  navAutoHide(signal);
  progressFallback(signal);
  spotlightCards();
  tagFilter();
  // post page only
  if (document.querySelector("[data-post]")) {
    headingAnchors();
    tableLabels();
    copyButtons();
    toc(signal);
    readerControls();
    focusMode(signal);
    backToTop(signal);
    shareButtons();
  }
}

/* ---------------- theme: circular reveal from the button ---------------- */
function themeToggle() {
  document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((btn) => {
    btn.onclick = (e) => {
      const root = document.documentElement;
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      const set = () => {
        root.dataset.theme = next;
        try {
          localStorage.setItem("argox_theme_v1", next);
        } catch {}
      };
      const vt = (document as any).startViewTransition;
      if (!vt || reduceMotion()) return set();
      const x = e.clientX || innerWidth - 40;
      const y = e.clientY || 30;
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.classList.add("theme-vt");
      const t = vt.call(document, set);
      t.ready.then(() => {
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
          { duration: 560, easing: "cubic-bezier(0.2, 0.8, 0.25, 1)", pseudoElement: "::view-transition-new(root)" }
        );
      });
      t.finished.finally(() => root.classList.remove("theme-vt"));
    };
  });
}

/* ---------------- reveal on scroll (staggered) ---------------- */
function reveal(signal: AbortSignal) {
  const els = document.querySelectorAll<HTMLElement>(".reveal:not(.in)");
  if (!("IntersectionObserver" in window) || reduceMotion()) {
    els.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  els.forEach((el) => io.observe(el));
  signal.addEventListener("abort", () => io.disconnect());
}

/* ---------------- nav hides on scroll down, returns on scroll up ---------------- */
function navAutoHide(signal: AbortSignal) {
  const nav = document.querySelector<HTMLElement>(".nav");
  if (!nav) return;
  const setHidden = (h: boolean) => {
    nav.classList.toggle("hide", h);
    document.documentElement.classList.toggle("nav-hidden", h);
  };
  setHidden(false);
  let last = scrollY;
  addEventListener(
    "scroll",
    () => {
      const y = scrollY;
      if (Math.abs(y - last) < 6) return;
      setHidden(y > last && y > 240 && !document.querySelector(".toc-sheet.open"));
      last = y;
    },
    { passive: true, signal }
  );
}

/* ---------------- progress bar for browsers without scroll timelines ---------------- */
function progressFallback(signal: AbortSignal) {
  if (CSS.supports("animation-timeline: scroll()")) return;
  const bar = document.querySelector<HTMLElement>(".progress span");
  if (!bar) return;
  const update = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.setProperty("--p", String(max > 0 ? Math.min(1, scrollY / max) : 0));
  };
  update();
  addEventListener("scroll", update, { passive: true, signal });
}

/* ---------------- cursor spotlight + gentle tilt on cards ---------------- */
function spotlightCards() {
  if (matchMedia("(hover: none)").matches) return;
  document.querySelectorAll<HTMLElement>("[data-spot]").forEach((card) => {
    card.onpointermove = (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      card.style.setProperty("--mx", `${px * 100}%`);
      card.style.setProperty("--my", `${py * 100}%`);
      if (!reduceMotion() && card.dataset.tilt !== undefined) {
        card.style.setProperty("--rx", `${(0.5 - py) * 4}deg`);
        card.style.setProperty("--ry", `${(px - 0.5) * 5}deg`);
      }
    };
    card.onpointerleave = () => {
      card.style.setProperty("--rx", "0deg");
      card.style.setProperty("--ry", "0deg");
    };
  });
}

/* ---------------- tag filter on the index (animated with view transitions) ---------------- */
function tagFilter() {
  const bar = document.querySelector<HTMLElement>("[data-filter]");
  if (!bar) return;
  const cards = [...document.querySelectorAll<HTMLElement>("[data-tags]")];
  const empty = document.querySelector<HTMLElement>("[data-empty]");
  const pill = bar.querySelector<HTMLElement>(".filter-pill");
  const movePill = (btn: HTMLElement) => {
    if (!pill) return;
    pill.style.width = `${btn.offsetWidth}px`;
    pill.style.transform = `translateX(${btn.offsetLeft}px)`;
  };
  const grid = document.querySelector<HTMLElement>("[data-filtering]");
  const apply = (tag: string) => {
    grid?.setAttribute("data-filtering", tag);
    let shown = 0;
    cards.forEach((c) => {
      const match = tag === "all" || (c.dataset.tags || "").split(",").includes(tag);
      c.hidden = !match;
      if (match && !(tag === "all" && c.classList.contains("featured-copy"))) shown++;
    });
    if (empty) empty.hidden = shown > 0;
  };
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button[data-tag]")];
  const active = buttons.find((b) => b.getAttribute("aria-pressed") === "true") || buttons[0];
  requestAnimationFrame(() => movePill(active));
  document.fonts?.ready.then(() => movePill(buttons.find((b) => b.getAttribute("aria-pressed") === "true") || buttons[0]));
  buttons.forEach((btn) => {
    btn.onclick = () => {
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      movePill(btn);
      const run = () => apply(btn.dataset.tag || "all");
      const vt = (document as any).startViewTransition;
      if (vt && !reduceMotion()) vt.call(document, run);
      else run();
    };
  });
}

/* ---------------- post: heading anchors ---------------- */
function headingAnchors() {
  document.querySelectorAll<HTMLElement>(".prose h2[id], .prose h3[id]").forEach((h) => {
    if (h.querySelector(".anchor")) return;
    const a = document.createElement("a");
    a.className = "anchor";
    a.href = `#${h.id}`;
    a.setAttribute("aria-label", `Link to “${h.textContent}”`);
    a.textContent = "#";
    a.onclick = (e) => {
      e.preventDefault();
      history.replaceState(null, "", `#${h.id}`);
      navigator.clipboard?.writeText(location.href);
      h.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" });
      toast("Link copied");
    };
    h.appendChild(a);
  });
}

/* ---------------- post: label table cells so tables can stack on phones ---------------- */
function tableLabels() {
  document.querySelectorAll<HTMLTableElement>(".prose table").forEach((t) => {
    const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent?.trim() || "");
    t.classList.add("stackable");
    t.querySelectorAll("tbody tr").forEach((tr) =>
      [...tr.children].forEach((td, i) => {
        if (heads[i]) td.setAttribute("data-label", heads[i]);
      })
    );
  });
}

/* ---------------- post: copy buttons on code blocks ---------------- */
function copyButtons() {
  document.querySelectorAll<HTMLElement>(".prose pre").forEach((pre) => {
    if (pre.parentElement?.classList.contains("code-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    const lang = pre.dataset.language;
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    if (lang && lang !== "plaintext" && lang !== "text") {
      const l = document.createElement("span");
      l.className = "code-lang";
      l.textContent = lang;
      wrap.appendChild(l);
    }
    const b = document.createElement("button");
    b.className = "copy";
    b.type = "button";
    b.setAttribute("aria-label", "Copy code");
    b.innerHTML = `<span class="c-copy">Copy</span><span class="c-done">Copied ✓</span>`;
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText.replace(/\n$/, ""));
        b.classList.add("done");
        setTimeout(() => b.classList.remove("done"), 1600);
      } catch {}
    };
    wrap.appendChild(b);
  });
}

/* ---------------- post: table of contents with active section ---------------- */
function toc(signal: AbortSignal) {
  const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-toc] a[href^='#']")];
  if (!links.length) return;
  const heads = links
    .map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))))
    .filter((h): h is HTMLElement => !!h);
  const marker = document.querySelector<HTMLElement>("[data-toc-marker]");
  const setActive = (id: string) => {
    links.forEach((a) => {
      const on = a.hash.slice(1) === id;
      a.classList.toggle("active", on);
      if (on && marker && a.closest(".toc-rail")) {
        marker.style.transform = `translateY(${a.offsetTop}px)`;
        marker.style.height = `${a.offsetHeight}px`;
        marker.style.opacity = "1";
      }
    });
    const label = document.querySelector<HTMLElement>("[data-toc-current]");
    const h = heads.find((x) => x.id === id);
    if (label) label.textContent = h ? h.textContent?.replace(/#$/, "") || "" : "Contents";
  };
  const onScroll = () => {
    let current = heads[0]?.id || "";
    for (const h of heads) if (h.getBoundingClientRect().top < Math.max(160, innerHeight * 0.3)) current = h.id;
    setActive(current);
  };
  onScroll();
  addEventListener("scroll", onScroll, { passive: true, signal });

  // mobile sheet
  const sheet = document.querySelector<HTMLElement>(".toc-sheet");
  const openBtn = document.querySelector<HTMLButtonElement>("[data-toc-open]");
  if (sheet && openBtn) {
    const close = () => {
      sheet.classList.remove("open");
      openBtn.setAttribute("aria-expanded", "false");
    };
    openBtn.onclick = () => {
      const open = !sheet.classList.contains("open");
      sheet.classList.toggle("open", open);
      openBtn.setAttribute("aria-expanded", String(open));
    };
    sheet.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));
    document.addEventListener("keydown", (e) => e.key === "Escape" && close(), { signal });
  }
}

/* ---------------- post: focus mode toggle ---------------- */
function readerControls() {
  const root = document.documentElement;
  const save = (k: string, v: string | null) => {
    try {
      v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {}
  };
  const sync = () => {
    document.querySelectorAll<HTMLButtonElement>("[data-focus-toggle]").forEach((b) => b.setAttribute("aria-pressed", String(root.dataset.focus === "1")));
  };
  document.querySelectorAll<HTMLButtonElement>("[data-focus-toggle]").forEach((b) => {
    b.onclick = () => {
      const on = root.dataset.focus !== "1";
      if (on) root.dataset.focus = "1";
      else delete root.dataset.focus;
      save("argox_focus", on ? "1" : null);
      sync();
      document.dispatchEvent(new Event("argox:focus"));
    };
  });
  sync();
}

/* ---------------- post: focus mode -- the block you're reading stays lit ---------------- */
function focusMode(signal: AbortSignal) {
  const blocks = [...document.querySelectorAll<HTMLElement>(".prose > *")];
  let current: HTMLElement | null = null;
  const update = () => {
    if (document.documentElement.dataset.focus !== "1") return;
    const mid = innerHeight * 0.42;
    let best: HTMLElement | null = null;
    let bestD = Infinity;
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best !== current) {
      current?.classList.remove("lit");
      best?.classList.add("lit");
      current = best;
    }
  };
  update();
  addEventListener("scroll", update, { passive: true, signal });
  document.addEventListener("argox:focus", update, { signal });
}

/* ---------------- post: back to top ---------------- */
function backToTop(signal: AbortSignal) {
  const btn = document.querySelector<HTMLButtonElement>("[data-top]");
  if (!btn) return;
  const update = () => btn.classList.toggle("show", scrollY > innerHeight * 1.2);
  update();
  addEventListener("scroll", update, { passive: true, signal });
  btn.onclick = () => scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
}

/* ---------------- post: share ---------------- */
function shareButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-copy-link]").forEach((b) => {
    b.onclick = async () => {
      const url = location.href.split("#")[0];
      if (navigator.share && matchMedia("(hover: none)").matches) {
        try {
          await navigator.share({ title: document.title, url });
          return;
        } catch {}
      }
      await navigator.clipboard?.writeText(url);
      toast("Link copied");
    };
  });
}

function toast(text: string) {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast glass";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout((el as any)._t);
  (el as any)._t = setTimeout(() => el!.classList.remove("show"), 1600);
}
