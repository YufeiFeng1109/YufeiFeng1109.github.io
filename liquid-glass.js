/* Liquid glass: real refraction for glass elements.
   For each attached element this builds an SVG displacement filter whose map
   matches that element's exact size and corner radius, and applies it
   through backdrop-filter, so whatever sits behind the glass bends along its
   rim. Only Chromium renders SVG filters inside backdrop-filter; the <head>
   script in index.html marks such engines with html.liquid-glass before
   first paint, and everywhere else attach() does nothing and the frosted
   glass in styles.css applies unchanged. */
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const supported = document.documentElement.classList.contains("liquid-glass");

  let defs = null;
  function ensureDefs() {
    if (defs) return defs;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    defs = document.createElementNS(NS, "defs");
    svg.appendChild(defs);
    document.body.appendChild(svg);
    return defs;
  }

  // Displacement map: R = x offset, G = y offset, 128 = none. Inside a bevel
  // band along the edge, each pixel samples from further inward along the
  // edge normal, most strongly at the rim, which reads as a convex glass edge
  // bending what is behind it. Sampling inward also keeps every read inside
  // the element, where the backdrop actually has pixels. Sizes are in CSS
  // pixels, which is the space Chromium evaluates these filters in.
  function makeMap(w, h, r, bevel, power) {
    const W = Math.max(2, Math.round(w));
    const H = Math.max(2, Math.round(h));
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const rr = Math.min(r, W / 2, H / 2);
    const hx = W / 2 - rr;
    const hy = H / 2 - rr;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = x + 0.5 - W / 2;
        const py = y + 0.5 - H / 2;
        // Signed distance to the rounded rectangle, and its outward normal.
        const qx = Math.abs(px) - hx;
        const qy = Math.abs(py) - hy;
        const ox = Math.max(qx, 0);
        const oy = Math.max(qy, 0);
        const out = Math.hypot(ox, oy);
        const inside = -(out + Math.min(Math.max(qx, qy), 0) - rr);
        let nx = 0;
        let ny = 0;
        if (qx > 0 && qy > 0) {
          const len = out || 1;
          nx = (ox / len) * Math.sign(px);
          ny = (oy / len) * Math.sign(py);
        } else if (qx > qy) {
          nx = Math.sign(px);
        } else {
          ny = Math.sign(py);
        }
        const m = inside >= 0 && inside < bevel ? Math.pow(1 - inside / bevel, power) : 0;
        const i = (y * W + x) * 4;
        d[i] = Math.round(128 - 127 * m * nx);
        d[i + 1] = Math.round(128 - 127 * m * ny);
        d[i + 2] = 128;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { url: canvas.toDataURL("image/png"), W, H };
  }

  // One displacement pass per colour channel at slightly different
  // strengths, summed back together: a touch of chromatic aberration at the
  // rim, which is much of what makes refraction read as glass, not a warp.
  function setFilter(id, map, scale, aberration) {
    let f = document.getElementById(id);
    if (!f) {
      f = document.createElementNS(NS, "filter");
      f.id = id;
      ensureDefs().appendChild(f);
    }
    f.setAttribute("x", "0");
    f.setAttribute("y", "0");
    f.setAttribute("width", "1");
    f.setAttribute("height", "1");
    // sRGB is essential: the default linearRGB would remap 128 away from "no
    // displacement" and shift the whole backdrop.
    f.setAttribute("color-interpolation-filters", "sRGB");
    const s = (k) => (scale * k).toFixed(2);
    const disp = (k, out) =>
      `<feDisplacementMap in="SourceGraphic" in2="map" scale="${s(k)}" xChannelSelector="R" yChannelSelector="G" result="${out}"/>`;
    f.innerHTML =
      `<feImage href="${map.url}" x="0" y="0" width="${map.W}" height="${map.H}" preserveAspectRatio="none" result="map"/>` +
      disp(1, "dr") +
      disp(1 + aberration, "dg") +
      disp(1 + aberration * 2, "db") +
      `<feColorMatrix in="dr" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>` +
      `<feColorMatrix in="dg" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>` +
      `<feColorMatrix in="db" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>` +
      `<feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg"/>` +
      `<feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1"/>`;
  }

  let seq = 0;
  const entries = [];

  function build(entry) {
    const { el, opts } = entry;
    // `inset` shrinks the map for targets drawn inside the border, such as a
    // ::before ring that fills the padding box.
    const w = el.offsetWidth - 2 * opts.inset;
    const h = el.offsetHeight - 2 * opts.inset;
    if (w <= 0 || h <= 0 || (w === entry.w && h === entry.h)) return;
    entry.w = w;
    entry.h = h;
    const r =
      opts.radius != null ? opts.radius : parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    const bevel = Math.min(opts.bevel, Math.min(w, h) / 2);
    setFilter(entry.id, makeMap(w, h, r, bevel, opts.power), opts.scale, opts.aberration);
    const ref = `url(#${entry.id})`;
    if (opts.cssVar) {
      el.style.setProperty(opts.cssVar, ref);
    } else {
      const value = `${ref} ${opts.extra}`.trim();
      el.style.backdropFilter = value;
      el.style.webkitBackdropFilter = value;
    }
  }

  // Rebuilt when an element changes size (fonts loading, the header
  // compacting, a language switch). Debounced: a size transition would
  // otherwise rebuild the map every frame, and the old map stretched to fit
  // is close enough for those few frames.
  const resizeObserver =
    "ResizeObserver" in window
      ? new ResizeObserver((items) => {
          for (const item of items) {
            const entry = entries.find((e) => e.el === item.target);
            if (!entry) continue;
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => build(entry), 140);
          }
        })
      : null;

  // Options: bevel (px width of the refracting band), scale (strength; the
  // maximum offset is scale / 2 px), power (how sharply the bend gathers at
  // the rim), aberration, radius (default: the element's own), inset,
  // extra (filters appended after the refraction, e.g. a light blur), and
  // cssVar (publish the url(#map) in a custom property instead of applying
  // it, for use on a pseudo-element). Keep scale / 2 under ~45% of the bevel,
  // or the rim folds back on itself and smears instead of bending.
  function attach(el, options) {
    if (!supported || !el) return;
    const opts = Object.assign(
      { bevel: 14, scale: 12, power: 2, aberration: 0.1, radius: null, inset: 0, extra: "", cssVar: null },
      options
    );
    const entry = { el, opts, id: `liquid-glass-${++seq}`, w: 0, h: 0, timer: 0 };
    entries.push(entry);
    build(entry);
    if (resizeObserver) resizeObserver.observe(el);
  }

  window.LiquidGlass = { attach };
})();
