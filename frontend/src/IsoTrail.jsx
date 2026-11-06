import React, { useEffect, useMemo, useRef, useState } from "react";
import { T, tint, STATUS, TOOL_META, IconFile, IconTerminal, IconGlobe, IconLock, IconClaude, IconBot } from "./theme.jsx";

/**
 * Isometric 3D path view for the Graph tab, built with plain CSS 3D
 * transforms (no WebGL / three.js dependency). The scene is one flat
 * "plane" div rotated into an isometric view; everything on it is laid
 * out in ordinary 2D plane coordinates and lifted with translateZ:
 *
 *   - a dark agent block (the session's source) sits on a dotted platform
 *   - each tool call is a card on the platform, in call order, laid out
 *     serpentine so long sessions wrap instead of running off the deck
 *   - steps are joined by 3D pipes with a glowing pulse flowing through
 *     them; a blocked step's pipe has a red valve the glow never gets past
 *   - dark resource keycaps (Files / Shell / Network / Sensitive data)
 *     sit on the ground in front, cabled to the platform, and light up
 *     with the worst outcome of the steps that touched them
 *
 * With rotateZ(-45deg) the plane's (0,0) corner is the left-most point
 * on screen, +x runs up-right and +y runs down-right, so the faces that
 * face the viewer are the x=0 face and the y=max face -- Box() only
 * renders those two sides plus the top.
 */

const CW = 210; // card width (plane px)
const CD = 96; // card depth
const CARD_H = 10;
const GAP_X = 92;
const GAP_Y = 84;
const PAD = 40;
const AGENT_D = 130;
const AGENT_H = 64;
const PLAT_H = 16;
const KEY = 120; // keycap footprint
const KEY_H = 34;
const KEY_GAP = 100; // ground gap between platform edge and keycaps
const GROUND_MARGIN = 30;
// camera: a steeper, more top-down view than true isometric so card text
// stays legible, and a shallower spin so it reads closer to horizontal
const RX = 42;
const RZ = -32;

const SEV_RANK = { clean: 0, flagged: 1, warning: 2, critical: 3 };

const DARK = { top: "#24221d", front: "#16140f", side: "#0d0c09" };
const PLATFORM = { top: "var(--ax-platform-top)", front: "var(--ax-platform-front)", side: "var(--ax-platform-side)" };
const CARD = { top: T.surface, front: T.cardFront, side: T.cardSide };

// Resource blocks. `match` takes a trail node (see pathLayout.buildTrail).
const SENSITIVE_TAGS = ["secret", "pii", "internal_only"];
const SENSITIVE_REASONS = ["secret_data_exfil_attempt", "pii_crossing_trust_boundary", "internal_data_crossing_trust_boundary"];
// shell commands that reach the network (mirrors the intent of policy.py's NETWORK_SHELL_RE, kept simple)
const SHELL_NETWORK_RE = /\b(curl|wget|nc|ncat|netcat|ssh|scp|rsync|sftp|ftp|telnet)\b|[a-z][a-z0-9+.-]*:\/\//i;

export const CATEGORIES = [
  { id: "files", label: "Files", Icon: IconFile, match: (n) => n.event.tool === "read_file" || n.event.tool === "write_file" },
  { id: "shell", label: "Shell", Icon: IconTerminal, match: (n) => n.event.tool === "run_shell" },
  {
    id: "network",
    label: "Network",
    Icon: IconGlobe,
    match: (n) => n.event.tool === "call_api" || (n.event.tool === "run_shell" && SHELL_NETWORK_RE.test(n.event.target || "")),
  },
  {
    // steps that brought sensitive data in, or were stopped/flagged for trying to move it out
    id: "sensitive",
    label: "Sensitive data",
    Icon: IconLock,
    match: (n) =>
      (n.introducedTags || []).some((t) => SENSITIVE_TAGS.includes(t)) || (n.event.reasons || []).some((r) => SENSITIVE_REASONS.includes(r)),
  },
];

const FLOW = 80; // length of the glowing pulse travelling through a pipe

const CSS = `
@keyframes iso-drop { 0% { transform: translateZ(14px); opacity: 0; } 100% { transform: translateZ(0); opacity: 1; } }
@keyframes iso-ripple { 0% { transform: scale(0.7); opacity: 0.55; } 100% { transform: scale(1.9); opacity: 0; } }
@keyframes iso-glow { 0%, 100% { box-shadow: 0 0 0 0 var(--glow); } 50% { box-shadow: 0 0 26px 6px var(--glow); } }
@keyframes iso-flow-x { 0% { background-position: var(--from) 0; opacity: 1; } 80% { opacity: 1; } 100% { background-position: var(--to) 0; opacity: var(--end-opacity); } }
@keyframes iso-flow-y { 0% { background-position: 0 var(--from); opacity: 1; } 80% { opacity: 1; } 100% { background-position: 0 var(--to); opacity: var(--end-opacity); } }
@keyframes iso-led { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.iso-drop { animation: iso-drop 280ms ease-out backwards; }
.iso-ripple { animation: iso-ripple 1.8s ease-out infinite; }
.iso-glow { animation: iso-glow 2s ease-in-out infinite; }
.iso-led { animation: iso-led 1.6s ease-in-out infinite; }
.iso-card-lift { transition: transform 220ms cubic-bezier(.2,.8,.25,1); }
@media (prefers-reduced-motion: reduce) {
  .iso-drop, .iso-ripple, .iso-glow, .iso-led, .iso-flow { animation: none !important; }
}
`;

function worse(a, b) {
  return SEV_RANK[a] >= SEV_RANK[b] ? a : b;
}

// An extruded block: top face + the two viewer-facing walls (front, left).
//
// `radius` rounds the block's vertical edges. A rounded top face alone
// isn't enough -- flat walls would still run to the square corners and
// poke out past the curve. So with a radius the walls stop `radius` short
// of each corner, and the corners are filled by a stack of thin rounded
// slices (CSS can't bend a plane), shaded from side colour to front colour
// so the curve reads as turning from one wall into the other.
const SLICE_STEP = 2.5; // px between slices; smaller = smoother corner, more DOM

function Box({ w, d, h, colors, radius = 0, topStyle, style, className, children, ...rest }) {
  const r = Math.min(radius, w / 2, d / 2);
  const slices = r > 0 ? Math.max(1, Math.ceil(h / SLICE_STEP)) : 0;
  const cornerFill = `linear-gradient(to bottom right, ${colors.side} 0%, ${colors.side} 35%, ${colors.front} 65%, ${colors.front} 100%)`;
  return (
    <div className={className} style={{ position: "absolute", width: w, height: d, transformStyle: "preserve-3d", borderRadius: r, ...style }} {...rest}>
      {Array.from({ length: slices }, (_, i) => (
        <div
          key={i}
          style={{ position: "absolute", inset: 0.5, borderRadius: r, background: cornerFill, transform: `translateZ(${Math.min(h - 0.5, i * SLICE_STEP)}px)` }}
        />
      ))}
      <div style={{ position: "absolute", left: r, top: d, width: w - 2 * r, height: h, background: colors.front, transformOrigin: "top", transform: "rotateX(90deg)" }} />
      <div style={{ position: "absolute", left: 0, top: r, width: h, height: d - 2 * r, background: colors.side, transformOrigin: "left", transform: "rotateY(-90deg)" }} />
      <div style={{ position: "absolute", inset: 0, transform: `translateZ(${h}px)`, background: colors.top, ...topStyle, ...(r > 0 ? { borderRadius: r } : null) }}>{children}</div>
    </div>
  );
}

/**
 * A tube lying on the deck between two points (axis-aligned: links are
 * always horizontal or vertical in plane coords). Built like Box(): a
 * cylinder-shaded top band plus the two viewer-facing walls, a collar at
 * each end, and a glowing pulse animated along the inside. A blocked
 * link's pulse fades out before the end, at a red valve.
 */
function Pipe({ x1, y1, x2, y2, color, blocked = false, delay = 0, radius = 7, dim = false, intense = false }) {
  const horizontal = y1 === y2;
  const len = Math.abs(horizontal ? x2 - x1 : y2 - y1);
  if (len < 2) return null;
  const forward = horizontal ? x2 > x1 : y2 > y1;
  const D = radius * 2;
  const H = radius * 1.3;
  const left = horizontal ? Math.min(x1, x2) : x1 - radius;
  const top = horizontal ? y1 - radius : Math.min(y1, y2);
  const w = horizontal ? len : D;
  const d = horizontal ? D : len;
  const across = horizontal ? "180deg" : "90deg";
  const along = horizontal ? "90deg" : "180deg";
  const lit = color && !dim;
  const tint = lit ? color : "#9a958a";
  const shade = `linear-gradient(${across}, #b9b4a8 0%, #f4f2ed 30%, #ffffff 42%, #e6e3db 70%, #a7a296 100%)`;
  const tintLayer = `linear-gradient(${across}, ${tint}66, ${tint}26 40%, ${tint}66)`;
  const stopAt = blocked ? len * 0.62 : len + FLOW / 2;

  // flow animation runs toward the target end, whichever way the link points
  const axis = horizontal ? "x" : "y";
  const flow = (size) => ({
    backgroundImage: `linear-gradient(${along}, transparent 0%, ${color}00 8%, ${color} 38%, #ffffff 50%, ${color} 62%, transparent 100%)`,
    backgroundSize: horizontal ? `${FLOW}px ${size}` : `${size} ${FLOW}px`,
    backgroundRepeat: "no-repeat",
    "--from": `${forward ? -FLOW : len}px`,
    "--to": `${forward ? stopAt - FLOW / 2 : len - stopAt - FLOW / 2}px`,
    "--end-opacity": blocked ? 0 : 1,
    animation: `iso-flow-${axis} ${blocked ? 1.3 : intense ? 0.9 : 1.4}s linear ${delay % 2.8}s infinite`,
    backgroundPosition: horizontal ? `-${FLOW}px 0` : `0 -${FLOW}px`,
  });

  const collar = (cx, cy, key, valve = false) => {
    const size = D + (valve ? 10 : 6);
    const cl = valve ? 6 : 4;
    const bw = horizontal ? cl : size;
    const bd = horizontal ? size : cl;
    return (
      <Box
        key={key}
        className={valve ? "iso-glow" : undefined}
        w={bw}
        d={bd}
        h={H + (valve ? 6 : 2)}
        colors={valve ? { top: color, front: "#8f2020", side: "#6e1818" } : { top: "#5b574e", front: "#3a372f", side: "#2c2a24" }}
        style={{ left: cx - bw / 2, top: cy - bd / 2, transform: "translateZ(1px)", "--glow": valve ? `${color}88` : undefined }}
        topStyle={{ borderRadius: 2 }}
      />
    );
  };

  const endA = forward ? 2 : len - 2;
  const endB = forward ? len - 2 : 2;
  const valveAt = forward ? stopAt : len - stopAt;
  const at = (t) => (horizontal ? [left + t, y1] : [x1, top + t]);
  const coreLine = horizontal ? { left: 3, right: 3, top: "50%", height: 3, marginTop: -1.5 } : { top: 3, bottom: 3, left: "50%", width: 3, marginLeft: -1.5 };

  return (
    <>
      <div style={{ position: "absolute", left: left + 3, top: top + 6, width: w, height: d, background: "rgba(23,20,14,0.12)", boxShadow: "0 0 6px 1px rgba(23,20,14,0.12)", borderRadius: radius }} />
      {lit && (
        // light the pipe throws onto the deck underneath it
        <div style={{ position: "absolute", left: left - 8, top: top - 8, width: w + 16, height: d + 16, borderRadius: radius + 8, boxShadow: `0 0 12px 4px ${color}`, opacity: intense ? 0.3 : 0.15 }} />
      )}
      <Box
        w={w}
        d={d}
        h={H}
        colors={{
          top: "transparent",
          front: `linear-gradient(0deg, #8d887c, #c9c4b8)`,
          side: `linear-gradient(90deg, #c9c4b8, #8d887c)`,
        }}
        style={{ left, top, transform: "translateZ(1px)" }}
        topStyle={{ borderRadius: radius }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: radius,
            overflow: "hidden",
            background: `${tintLayer}, ${shade}`,
            boxShadow: lit ? `0 0 ${intense ? 16 : 10}px ${color}${intense ? "aa" : "66"}` : "none",
          }}
        >
          {/* steady inner light, so a lit pipe reads as "on" between pulses */}
          {lit && <div style={{ position: "absolute", ...coreLine, borderRadius: 2, background: color, opacity: 0.45 }} />}
          {lit && <div className="iso-flow" style={{ position: "absolute", inset: 0, ...flow("100%") }} />}
          {/* glass highlight on top of the glow */}
          <div
            style={{
              position: "absolute",
              borderRadius: radius,
              background: "rgba(255,255,255,0.6)",
              ...(horizontal ? { left: 4, right: 4, top: "20%", height: 2 } : { top: 4, bottom: 4, left: "20%", width: 2 }),
            }}
          />
          {dim && <div style={{ position: "absolute", inset: 0, background: "rgba(250,249,247,0.55)" }} />}
        </div>
      </Box>
      {collar(...at(endA), "a")}
      {collar(...at(endB), "b")}
      {blocked && collar(...at(valveAt), "valve", true)}
    </>
  );
}

function layout(stepCount) {
  const cols = Math.min(4, Math.max(3, stepCount));
  const rows = Math.max(1, Math.ceil(stepCount / cols));
  const W = PAD * 2 + cols * CW + (cols - 1) * GAP_X;
  const H = PAD + AGENT_D + GAP_Y + rows * (CD + GAP_Y) - GAP_Y + PAD;
  const pos = (i) => {
    const row = Math.floor(i / cols);
    const inRow = i % cols;
    const col = row % 2 === 0 ? inRow : cols - 1 - inRow;
    return { x: PAD + col * (CW + GAP_X), y: PAD + AGENT_D + GAP_Y + row * (CD + GAP_Y), row, col };
  };
  const keyY = H + KEY_GAP;
  const keyX = (k) => PAD + (k * (W - 2 * PAD - KEY)) / (CATEGORIES.length - 1);
  return { cols, rows, W, H, pos, keyY, keyX, PW: W, PH: keyY + KEY + 50 };
}

function linkPath(a, b) {
  // a, b: {x, y} card (or agent block) top-left corners in deck coords
  if (a.y === b.y) {
    const y = a.y + CD / 2;
    return b.x > a.x ? [a.x + CW, y, b.x, y] : [a.x, y, b.x + CW, y];
  }
  const x = a.x + CW / 2;
  return [x, a.y + a.d, x, b.y];
}

// `embedded` is the homepage demo: no wheel zoom (it would hijack page
// scroll), no drag/pan, no dashboard controls. `layoutSteps` sizes the
// deck for a known final step count so the camera doesn't re-frame as
// steps arrive.
// `flat` tilts the camera straight down (rotateX/Z -> 0); the transform
// transition animates it, which is how the Graph tab morphs into its 2D view.
export default function IsoTrail({ trail, sessionKey, connected, live, selectedId, onSelect, focusCat, onFocusCat, embedded = false, layoutSteps = 0, flat = false, showLegend = true }) {
  const steps = trail.nodes.filter((n) => !n.isStart);
  const start = trail.nodes.find((n) => n.isStart);
  const L = useMemo(() => layout(Math.max(steps.length, layoutSteps)), [steps.length, layoutSteps]);

  const wrapRef = useRef();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [hoverId, setHoverId] = useState(null);
  const [hoverCatId, setHoverCatId] = useState(null);
  const dragRef = useRef(null);
  const sceneRef = useRef(null);
  const justDraggedRef = useRef(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    if (embedded) return () => observer.disconnect();
    const onWheel = (e) => {
      e.preventDefault();
      setZoom((z) => Math.min(3, Math.max(0.35, z * Math.exp(-e.deltaY * 0.0015))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [embedded]);

  // re-frame when switching sessions
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [sessionKey]);

  // fit the projected scene (ground included) into the container
  // (no mouse-follow tilt: it re-rendered and re-rasterised the whole scene on every mousemove)
  const rx = flat ? 0 : RX;
  const rz = flat ? 0 : RZ;
  const gw = L.PW + GROUND_MARGIN * 2;
  const gh = L.PH + GROUND_MARGIN * 2;
  const zMax = PLAT_H + AGENT_H + 10;
  const sinRx = Math.sin((rx * Math.PI) / 180);
  const cosRx = Math.cos((rx * Math.PI) / 180);
  const sinRz = Math.abs(Math.sin((rz * Math.PI) / 180));
  const cosRz = Math.abs(Math.cos((rz * Math.PI) / 180));
  const projW = gw * cosRz + gh * sinRz;
  const projH = (gw * sinRz + gh * cosRz) * cosRx + zMax * sinRx;
  const fit = size.width ? Math.min(size.width / projW, size.height / projH) * 1.02 : 0.5;
  // the homepage panel is small: trim the empty ground margin a touch
  const scale = fit * zoom * (embedded ? 1.06 : 1);
  const zLift = (zMax * sinRx * scale) / 2;
  const sceneTransform = (p) => `translate(-50%, -50%) translate(${p.x}px, ${p.y + zLift}px) scale(${scale}) rotateX(${rx}deg) rotateZ(${rz}deg)`;

  const catStats = useMemo(
    () =>
      CATEGORIES.map((c) => {
        const hits = steps.filter((n) => c.match(n));
        return { ...c, count: hits.length, severity: hits.reduce((acc, n) => worse(acc, n.severity), "clean") };
      }),
    [steps]
  );
  const hoverNode = steps.find((n) => n.id === hoverId);
  const hoverCats = new Set(hoverNode ? CATEGORIES.filter((c) => c.match(hoverNode)).map((c) => c.id) : []);
  // a focused (clicked) or hovered resource block spotlights the steps that touched it
  const activeCat = CATEGORIES.find((c) => c.id === (focusCat || hoverCatId)) || null;
  const inFocus = (n) => !activeCat || activeCat.match(n);

  const agentBox = { x: PAD, y: PAD, d: AGENT_D };
  const links = steps.map((n, i) => {
    const from = i === 0 ? agentBox : { ...L.pos(i - 1), d: CD };
    const to = L.pos(i);
    return { id: n.id, severity: n.severity, coords: linkPath(from, to), dim: !inFocus(n) };
  });
  const newestId = steps.length ? steps[steps.length - 1].id : null;

  const onPointerDown = (e) => {
    if (embedded) return;
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false };
  };
  // While dragging, write the transform straight to the DOM (no React
  // re-render of the whole scene per mousemove); commit to state on release.
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) > 4) {
      d.moved = true;
      setDragging(true);
    }
    if (d.moved && sceneRef.current) {
      d.cur = { x: d.px + dx, y: d.py + dy };
      sceneRef.current.style.transform = sceneTransform(d.cur);
    }
  };
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && d.cur) setPan(d.cur);
    setDragging(false);
    return d;
  };
  const onPointerUp = (e) => {
    const d = endDrag();
    justDraggedRef.current = !!(d && d.moved);
    if (d && !d.moved && e.target === e.currentTarget) {
      onSelect(null);
      onFocusCat(null);
    }
  };
  const clickedCard = (n) => {
    if (justDraggedRef.current) return;
    onSelect(n);
  };

  const SourceIcon = start && start.label === "Claude Code" ? IconClaude : IconBot;
  const counts = steps.reduce((acc, n) => ({ ...acc, [n.severity]: (acc[n.severity] || 0) + 1 }), {});

  return (
    <div
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={endDrag}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        cursor: embedded ? "default" : dragging ? "grabbing" : "grab",
        background: `radial-gradient(ellipse at 50% 45%, ${T.surface} 0%, ${T.page} 55%, ${T.vignette} 100%)`,
        touchAction: embedded ? "auto" : "none",
        userSelect: "none",
      }}
    >
      <style>{CSS}</style>

      <div
        ref={sceneRef}
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: gw,
          height: gh,
          pointerEvents: "none",
          transformStyle: "preserve-3d",
          transform: sceneTransform(pan),
          transition: dragging ? "none" : "transform 700ms cubic-bezier(.2,.8,.25,1)",
        }}
      >
        {/* ground grid */}
        <svg width={gw} height={gh} style={{ position: "absolute", inset: 0 }}>
          <defs>
            <pattern id="iso-grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M48 0H0V48" fill="none" stroke={T.ink} strokeOpacity="0.06" strokeWidth="1" />
            </pattern>
            <radialGradient id="iso-fade">
              <stop offset="55%" stopColor="#fff" stopOpacity="1" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <mask id="iso-grid-mask">
              <rect width={gw} height={gh} fill="url(#iso-fade)" />
            </mask>
          </defs>
          <rect width={gw} height={gh} fill="url(#iso-grid)" mask="url(#iso-grid-mask)" />
        </svg>

        <div style={{ position: "absolute", left: GROUND_MARGIN, top: GROUND_MARGIN, width: L.PW, height: L.PH, transformStyle: "preserve-3d" }}>
          {/* pipes: platform edge -> keycaps */}
          {catStats.map((c, k) => {
            const x = L.keyX(k) + KEY / 2;
            const used = c.count > 0;
            return (
              <Pipe
                key={c.id}
                x1={x}
                y1={L.H + 1}
                x2={x}
                y2={L.keyY - 1}
                color={used ? STATUS[c.severity].color : null}
                delay={k * 0.4}
                radius={8}
                dim={!!activeCat && activeCat.id !== c.id}
                intense={!!activeCat && activeCat.id === c.id}
              />
            );
          })}

          {/* platform shadow + slab */}
          <div style={{ position: "absolute", left: 10, top: 18, width: L.W, height: L.H, background: "rgba(23,20,14,0.08)", boxShadow: "0 0 24px 6px rgba(23,20,14,0.08)", borderRadius: 16 }} />
          <Box
            w={L.W}
            d={L.H}
            h={PLAT_H}
            colors={PLATFORM}
            radius={8}
            topStyle={{
              backgroundImage: `radial-gradient(${tint(T.ink, 15)} 1.2px, transparent 1.3px)`,
              backgroundSize: "18px 18px",
              backgroundPosition: "9px 9px",
              boxShadow: `inset 0 0 0 1px ${tint(T.ink, 5)}`,
            }}
          />

          {/* deck: everything standing on the platform */}
          <div style={{ position: "absolute", left: 0, top: 0, width: L.W, height: L.H, transformStyle: "preserve-3d", transform: `translateZ(${PLAT_H + 0.5}px)` }}>
            {/* session summary printed on the deck */}
            <div style={{ position: "absolute", right: PAD, top: PAD + 10, width: Math.max(CW, L.W - (PAD * 2 + CW + GAP_X * 2)), textAlign: "right", fontFamily: T.font, color: T.inkSecondary }}>
              <div style={{ fontFamily: T.fontSerif, fontSize: steps.length ? 40 : 30, lineHeight: 1.05, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : "Waiting for activity"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "6px 16px", marginTop: 12, fontSize: 16 }}>
                {["critical", "warning", "flagged", "clean"].map((s) =>
                  counts[s] ? (
                    <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: STATUS[s].color, fontWeight: 600 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: STATUS[s].color }} />
                      {counts[s]} {STATUS[s].label.toLowerCase()}
                    </span>
                  ) : null
                )}
              </div>
            </div>

            {/* pipes between steps -- the glow pulse is staggered by step so it reads as one flow from the agent to the newest step */}
            {links.map((l, i) => {
              const [x1, y1, x2, y2] = l.coords;
              return (
                <Pipe
                  key={`${sessionKey}-${l.id}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  color={STATUS[l.severity].color}
                  blocked={l.severity === "critical"}
                  delay={i * 0.28}
                  dim={l.dim}
                  intense={!!activeCat && !l.dim}
                />
              );
            })}

            {/* agent block */}
            <div style={{ position: "absolute", left: PAD + 10, top: PAD + 16, width: CW, height: AGENT_D, background: "rgba(0,0,0,0.16)", boxShadow: "0 0 18px 4px rgba(0,0,0,0.16)", borderRadius: 12 }} />
            <Box
              w={CW}
              d={AGENT_D}
              h={AGENT_H}
              colors={DARK}
              radius={8}
              style={{ left: PAD, top: PAD }}
              topStyle={{ padding: 14, boxSizing: "border-box", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", justifyContent: "space-between" }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ width: 42, height: 42, borderRadius: 10, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <SourceIcon size={26} color={T.ink} />
                </div>
                <span
                  className={connected ? "iso-led" : undefined}
                  style={{ width: 9, height: 9, borderRadius: "50%", background: connected ? T.good : T.inkMuted, boxShadow: connected ? `0 0 10px ${T.good}` : "none" }}
                />
              </div>
              <div>
                <div style={{ color: "#fff", fontFamily: T.font, fontSize: 19, fontWeight: 600 }}>{steps.length ? start.label : "Your agent"}</div>
                <div style={{ color: "rgba(255,255,255,0.55)", fontFamily: T.fontMono, fontSize: 12.5, marginTop: 3 }}>{!steps.length ? "idle" : live ? "● live session" : "session replay"}</div>
              </div>
            </Box>

            {/* step cards */}
            {steps.map((n, i) => {
              const p = L.pos(i);
              const status = STATUS[n.severity];
              const selected = selectedId === n.id;
              const hovered = hoverId === n.id;
              const isNewest = n.id === newestId && live;
              const alarm = n.severity === "critical" || n.severity === "warning";
              const meta = TOOL_META[n.event.tool];
              const dimmed = !inFocus(n);
              const focused = !!activeCat && !dimmed;
              const lift = selected ? 18 : focused ? 14 : hovered ? 10 : 0;
              return (
                <div
                  key={`${sessionKey}-${n.id}`}
                  className="iso-drop"
                  style={{ position: "absolute", left: p.x, top: p.y, width: CW, height: CD, transformStyle: "preserve-3d", animationDelay: `${Math.min(i, 20) * 45}ms` }}
                >
                  {isNewest && (
                    <div
                      className="iso-ripple"
                      style={{ position: "absolute", inset: -6, borderRadius: 12, border: `2px solid ${status.color}`, pointerEvents: "none" }}
                    />
                  )}
                  <div style={{ position: "absolute", left: 6, top: 10 + lift * 0.4, width: CW, height: CD, background: "rgba(23,20,14,0.11)", boxShadow: `0 0 ${10 + lift * 0.5}px 2px rgba(23,20,14,0.11)`, borderRadius: 6, transition: "top 220ms" }} />
                  <div className="iso-card-lift" style={{ position: "absolute", inset: 0, transformStyle: "preserve-3d", transform: `translateZ(${lift + 1}px)` }}>
                    <Box
                      w={CW}
                      d={CD}
                      h={CARD_H}
                      colors={CARD}
                      radius={6}
                      className={(alarm || focused) && !dimmed ? "iso-glow" : undefined}
                      style={{ left: 0, top: 0, pointerEvents: "auto", cursor: "pointer", "--glow": `${status.color}${focused ? "88" : "55"}` }}
                      topStyle={{
                        border: `${focused ? 2 : 1.5}px solid ${selected ? T.ink : alarm || focused ? status.color : tint(T.ink, 8)}`,
                        boxSizing: "border-box",
                        display: "flex",
                        alignItems: "stretch",
                        overflow: "hidden",
                        background: n.severity === "critical" ? `color-mix(in srgb, ${T.critical} 7%, ${CARD.top})` : CARD.top,
                      }}
                      onPointerEnter={() => setHoverId(n.id)}
                      onPointerLeave={() => setHoverId(null)}
                      onClick={() => clickedCard(n)}
                    >
                      <div style={{ width: 5, background: status.color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0, padding: "12px 14px", display: "flex", flexDirection: "column", justifyContent: "space-between", fontFamily: T.font }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span
                            style={{
                              minWidth: 24,
                              height: 24,
                              borderRadius: 12,
                              background: status.color,
                              color: T.onAccent,
                              fontSize: 12.5,
                              fontWeight: 700,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: "0 5px",
                              boxSizing: "border-box",
                            }}
                          >
                            {n.step}
                          </span>
                          <span style={{ fontSize: 15, fontWeight: 600, color: T.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {meta ? meta.label : n.event.tool}
                          </span>
                          <status.Icon size={18} color={status.color} style={{ marginLeft: "auto", flexShrink: 0 }} />
                        </div>
                        <div style={{ fontFamily: T.fontMono, fontSize: 14, color: T.inkSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.label}</div>
                      </div>
                      {dimmed && <div style={{ position: "absolute", inset: 0, background: "rgba(250,249,247,0.74)" }} />}
                    </Box>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ position: "absolute", left: PAD, top: L.keyY + KEY + 22, width: L.W - PAD * 2, fontFamily: T.font, fontSize: 15, color: T.inkMuted, letterSpacing: 0.2 }}>
            What the agent touched {!embedded && <span style={{ opacity: 0.7 }}>· click a block to trace its steps</span>}
          </div>
          {/* resource keycaps on the ground */}
          {catStats.map((c, k) => {
            const used = c.count > 0;
            const color = STATUS[c.severity].color;
            const focusedCap = focusCat === c.id;
            const lit = hoverCats.has(c.id) || (activeCat && activeCat.id === c.id);
            const capColor = used ? color : T.inkMuted;
            return (
              <div key={c.id} style={{ position: "absolute", left: L.keyX(k), top: L.keyY, width: KEY, height: KEY, transformStyle: "preserve-3d" }}>
                {lit && <div style={{ position: "absolute", inset: -14, borderRadius: 22, boxShadow: `0 0 20px 8px ${capColor}`, opacity: focusedCap ? 0.35 : 0.2 }} />}
                <div style={{ position: "absolute", left: 8, top: 12, width: KEY, height: KEY, background: "rgba(0,0,0,0.15)", boxShadow: "0 0 14px 3px rgba(0,0,0,0.15)", borderRadius: 10 }} />
                <div className="iso-card-lift" style={{ position: "absolute", inset: 0, transformStyle: "preserve-3d", transform: `translateZ(${lit ? 13 : 1}px)` }}>
                  <Box
                    w={KEY}
                    d={KEY}
                    h={KEY_H}
                    colors={DARK}
                    radius={10}
                    style={{ pointerEvents: "auto", cursor: "pointer" }}
                    onPointerEnter={() => setHoverCatId(c.id)}
                    onPointerLeave={() => setHoverCatId(null)}
                    onClick={() => !justDraggedRef.current && onFocusCat(focusedCap ? null : c.id)}
                    topStyle={{
                      padding: 12,
                      boxSizing: "border-box",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      // ring drawn INSIDE the cap: an outer spread ring makes the top face
                      // look larger than the walls below it (an overhanging lip)
                      boxShadow: lit
                        ? `inset 0 0 0 ${focusedCap ? 3 : 2}px ${capColor}, 0 0 28px ${tint(capColor, 67)}`
                        : "inset 0 1px 0 rgba(255,255,255,0.08)",
                      transition: "box-shadow 200ms",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ width: 40, height: 40, borderRadius: 10, background: used ? color : "rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <c.Icon size={22} color="#fff" />
                      </div>
                      <span style={{ fontFamily: T.fontMono, fontSize: 17, fontWeight: 600, color: used ? "#fff" : "rgba(255,255,255,0.35)" }}>{c.count}</span>
                    </div>
                    <div style={{ fontFamily: T.font, fontSize: 14, fontWeight: 500, color: used ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.4)", whiteSpace: "nowrap" }}>{c.label}</div>
                  </Box>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* overlay controls */}
      {!embedded && showLegend && (
      <div style={{ position: "absolute", left: 14, bottom: 12, display: "flex", gap: 12, fontSize: 11, color: T.inkMuted, fontFamily: T.font, pointerEvents: "none" }}>
        {Object.entries(STATUS).map(([k, s]) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      )}
      {!embedded && (
      <div style={{ position: "absolute", right: 12, bottom: 10, display: "flex", gap: 6 }}>
        {[
          ["−", () => setZoom((z) => Math.max(0.35, z / 1.25))],
          ["+", () => setZoom((z) => Math.min(3, z * 1.25))],
          ["Fit", () => (setZoom(1), setPan({ x: 0, y: 0 }))],
        ].map(([label, fn]) => (
          <button
            key={label}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={fn}
            style={{ minWidth: 30, height: 28, padding: "0 9px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.inkSecondary, fontSize: 12, fontFamily: T.font, cursor: "pointer", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}
          >
            {label}
          </button>
        ))}
      </div>
      )}
      {steps.length === 0 && !embedded && (
        <div style={{ position: "absolute", top: 18, left: 0, right: 0, textAlign: "center", fontSize: 13, color: T.inkMuted, pointerEvents: "none", fontFamily: T.font }}>
          Waiting for a session to trace — ask Claude Code to do something, or run the toy agent.
        </div>
      )}
    </div>
  );
}
