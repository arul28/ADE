/**
 * `ade.chart` — the charts a scene gets without writing SVG by hand.
 *
 * A scene has no network, so it cannot load a chart library, and a model that
 * hand-draws every axis spends most of its output on geometry and still gets
 * tick spacing wrong. This is the small set that covers what agents chart in a
 * chat (bar, line, area, donut, sparkline), drawn in ADE's palette so two
 * scenes from two models look like one product.
 *
 * Plain SVG and DOM, no dependency. It runs inside the scene frame after the
 * SDK, so it is a string: a `String.raw` template with no backticks and no
 * template holes, so what is typed here, backslashes included, is exactly what
 * the frame runs.
 */

/** Styles for the marks `ade.chart` draws. Colors are the frame's own variables, so a theme switch restyles a chart in place. */
export const SCENE_CHART_STYLES = `
.ade-chart { position: relative; width: 100%; }
.ade-chart svg { display: block; width: 100%; overflow: visible; }
.ade-chart text { fill: var(--fg-muted); font-family: var(--font-sans); font-size: 11px; }
.ade-chart .ade-chart-grid { stroke: var(--border); stroke-width: 1; shape-rendering: crispEdges; }
.ade-chart .ade-chart-total { fill: var(--fg); font-size: 20px; font-weight: 600; }
.ade-chart [data-tip] { transition: opacity .12s; }
.ade-chart svg:hover [data-mark] { opacity: .45; }
.ade-chart svg:hover [data-mark]:hover { opacity: 1; }
.ade-chart-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 8px; font-size: 12px; color: var(--fg-muted); }
.ade-chart-legend span { display: inline-flex; align-items: center; gap: 6px; }
.ade-chart-legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.ade-chart-legend b { color: var(--fg); font-weight: 500; }
.ade-chart-tip { position: absolute; pointer-events: none; z-index: 2; white-space: pre; padding: 5px 8px; border-radius: 6px;
  background: var(--bg); border: 1px solid var(--border); color: var(--fg); font-size: 11.5px; line-height: 1.45;
  box-shadow: 0 4px 14px rgba(0,0,0,.25); opacity: 0; transition: opacity .1s; }
.ade-chart-spark { display: inline-block; vertical-align: middle; width: auto; }
.ade-chart-spark svg { width: auto; }
`.trim();

export const SCENE_CHART_SOURCE = String.raw`
(function () {
  if (!window.ade) return;
  var NS = "http://www.w3.org/2000/svg";
  var PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];

  function svgEl(name, attrs, parent) {
    var node = document.createElementNS(NS, name);
    for (var key in attrs) node.setAttribute(key, String(attrs[key]));
    if (parent) parent.appendChild(node);
    return node;
  }
  function htmlEl(name, className, parent) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }
  function round(value) { return String(Math.round(value * 100) / 100); }
  function format(value, opts) {
    if (typeof opts.format === "function") { try { return String(opts.format(value)); } catch (e) {} }
    var abs = Math.abs(value);
    var text = abs >= 1e9 ? round(value / 1e9) + "B" : abs >= 1e6 ? round(value / 1e6) + "M" : abs >= 1e4 ? round(value / 1e3) + "k" : round(value);
    return (opts.prefix || "") + text + (opts.suffix || "");
  }
  // The smallest 1 / 2 / 2.5 / 5 / 10 step that covers the data, so the top
  // gridline is a round number.
  function niceMax(max) {
    if (!(max > 0)) return 1;
    var power = Math.pow(10, Math.floor(Math.log(max) / Math.LN10));
    var fraction = max / power;
    var nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return nice * power;
  }
  function numbers(values) {
    var out = [];
    var list = Array.isArray(values) ? values : [];
    for (var i = 0; i < list.length; i++) { var n = Number(list[i]); out.push(isFinite(n) ? n : 0); }
    return out;
  }
  function normalize(opts) {
    var raw = Array.isArray(opts.series) && opts.series.length ? opts.series : [{ name: opts.name || "", values: opts.values, color: opts.color }];
    var series = [];
    var count = 0;
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i] || {};
      var values = numbers(item.values);
      if (values.length > count) count = values.length;
      series.push({ name: String(item.name == null ? "" : item.name), values: values, color: item.color || PALETTE[i % PALETTE.length] });
    }
    var labels = [];
    for (var j = 0; j < count; j++) labels.push(String(opts.labels && opts.labels[j] != null ? opts.labels[j] : j + 1));
    return { series: series, labels: labels, count: count };
  }
  function legend(wrap, items) {
    var box = htmlEl("div", "ade-chart-legend", wrap);
    for (var i = 0; i < items.length; i++) {
      var row = htmlEl("span", "", box);
      var swatch = htmlEl("i", "", row);
      swatch.style.background = items[i].color;
      row.appendChild(document.createTextNode(items[i].name));
      if (items[i].value != null) { var strong = htmlEl("b", "", row); strong.textContent = items[i].value; }
    }
  }
  // One tooltip per chart, following the pointer over any mark that has a tip.
  function tooltips(wrap, svg) {
    var tip = htmlEl("div", "ade-chart-tip", wrap);
    svg.addEventListener("pointermove", function (event) {
      var target = event.target;
      var text = target && target.getAttribute ? target.getAttribute("data-tip") : null;
      if (!text) { tip.style.opacity = "0"; return; }
      tip.textContent = text;
      var box = wrap.getBoundingClientRect();
      var x = event.clientX - box.left + 12;
      var y = event.clientY - box.top + 12;
      if (x + tip.offsetWidth > box.width) x = Math.max(0, event.clientX - box.left - tip.offsetWidth - 12);
      tip.style.left = x + "px";
      tip.style.top = y + "px";
      tip.style.opacity = "1";
    });
    svg.addEventListener("pointerleave", function () { tip.style.opacity = "0"; });
  }

  function drawAxes(svg, data, opts, width, height, yMin, yMax) {
    var left = 40, right = 6, top = 8, bottom = 22;
    var plotW = Math.max(10, width - left - right);
    var plotH = Math.max(10, height - top - bottom);
    var steps = 4;
    for (var i = 0; i <= steps; i++) {
      var value = yMin + (yMax - yMin) * (i / steps);
      var y = top + plotH - plotH * (i / steps);
      svgEl("line", { x1: left, x2: left + plotW, y1: y, y2: y, "class": "ade-chart-grid" }, svg);
      var label = svgEl("text", { x: left - 8, y: y + 3.5, "text-anchor": "end" }, svg);
      label.textContent = format(value, opts);
    }
    // Skip x labels that would run into each other.
    var longest = 0;
    for (var j = 0; j < data.labels.length; j++) if (data.labels[j].length > longest) longest = data.labels[j].length;
    var every = Math.max(1, Math.ceil((data.count * (longest * 6.4 + 10)) / plotW));
    return { left: left, top: top, plotW: plotW, plotH: plotH, every: every, baseline: top + plotH };
  }
  function xLabel(svg, text, x, y) {
    var node = svgEl("text", { x: x, y: y, "text-anchor": "middle" }, svg);
    node.textContent = text;
  }
  function tipFor(data, index, opts) {
    var lines = [data.labels[index]];
    for (var s = 0; s < data.series.length; s++) {
      var name = data.series[s].name;
      lines.push((name ? name + ": " : "") + format(data.series[s].values[index] || 0, opts));
    }
    return lines.join("\n");
  }

  function drawBar(wrap, data, opts, width, height) {
    var stacked = opts.stacked === true;
    var max = 0;
    for (var i = 0; i < data.count; i++) {
      var sum = 0;
      for (var s = 0; s < data.series.length; s++) {
        var v = Math.max(0, data.series[s].values[i] || 0);
        sum += v;
        if (!stacked && v > max) max = v;
      }
      if (stacked && sum > max) max = sum;
    }
    var yMax = niceMax(max);
    var svg = svgEl("svg", { viewBox: "0 0 " + width + " " + height, height: height }, wrap);
    var box = drawAxes(svg, data, opts, width, height, 0, yMax);
    var group = box.plotW / Math.max(1, data.count);
    var lanes = stacked ? 1 : data.series.length;
    var barW = Math.max(2, Math.min(44, (group * 0.72) / lanes));
    for (var g = 0; g < data.count; g++) {
      var center = box.left + group * (g + 0.5);
      var start = center - (barW * lanes) / 2;
      var stackTop = box.baseline;
      for (var k = 0; k < data.series.length; k++) {
        var value = Math.max(0, data.series[k].values[g] || 0);
        var h = (value / yMax) * box.plotH;
        var x = stacked ? start : start + barW * k;
        var y = stacked ? stackTop - h : box.baseline - h;
        if (stacked) stackTop = y;
        var name = data.series[k].name;
        svgEl("rect", {
          x: x + 1, y: y, width: Math.max(1, barW - 2), height: Math.max(0, h), rx: Math.min(3, barW / 4),
          fill: data.series[k].color, "data-mark": "",
          "data-tip": data.labels[g] + "\n" + (name ? name + ": " : "") + format(value, opts),
        }, svg);
      }
      if (g % box.every === 0) xLabel(svg, data.labels[g], center, box.baseline + 15);
    }
    return svg;
  }

  function drawLine(wrap, data, opts, width, height, area) {
    var max = 0, min = 0;
    for (var s = 0; s < data.series.length; s++) {
      for (var i = 0; i < data.series[s].values.length; i++) {
        var v = data.series[s].values[i];
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
    var yMax = niceMax(max);
    var yMin = min < 0 && !area ? -niceMax(-min) : 0;
    var svg = svgEl("svg", { viewBox: "0 0 " + width + " " + height, height: height }, wrap);
    var box = drawAxes(svg, data, opts, width, height, yMin, yMax);
    var step = data.count > 1 ? box.plotW / (data.count - 1) : 0;
    function px(index) { return data.count > 1 ? box.left + step * index : box.left + box.plotW / 2; }
    function py(value) { return box.top + box.plotH - ((Math.max(yMin, value) - yMin) / (yMax - yMin)) * box.plotH; }
    for (var k = 0; k < data.series.length; k++) {
      var points = [];
      for (var p = 0; p < data.count; p++) points.push(round(px(p)) + " " + round(py(data.series[k].values[p] || 0)));
      if (!points.length) continue;
      if (area) {
        svgEl("path", {
          d: "M" + points.join(" L") + " L" + round(px(data.count - 1)) + " " + box.baseline + " L" + round(px(0)) + " " + box.baseline + " Z",
          fill: data.series[k].color, "fill-opacity": 0.16, stroke: "none",
        }, svg);
      }
      svgEl("path", {
        d: "M" + points.join(" L"), fill: "none", stroke: data.series[k].color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }, svg);
      if (data.count === 1) svgEl("circle", { cx: px(0), cy: py(data.series[k].values[0] || 0), r: 3, fill: data.series[k].color }, svg);
    }
    // One hit column per point: the tip names every series at that label.
    var hitW = data.count > 1 ? step : box.plotW;
    for (var h = 0; h < data.count; h++) {
      svgEl("rect", {
        x: px(h) - hitW / 2, y: box.top, width: hitW, height: box.plotH, fill: "transparent",
        "data-tip": tipFor(data, h, opts),
      }, svg);
      if (h % box.every === 0) xLabel(svg, data.labels[h], px(h), box.baseline + 15);
    }
    return svg;
  }

  function drawDonut(wrap, data, opts, height) {
    var values = data.series.length ? data.series[0].values : [];
    var total = 0;
    for (var i = 0; i < values.length; i++) total += Math.max(0, values[i]);
    var size = height;
    var stroke = Math.max(10, size * 0.14);
    var radius = (size - stroke) / 2;
    var circumference = 2 * Math.PI * radius;
    var svg = svgEl("svg", { viewBox: "0 0 " + size + " " + size, height: size, width: size }, wrap);
    svg.style.width = size + "px";
    svgEl("circle", { cx: size / 2, cy: size / 2, r: radius, fill: "none", stroke: "var(--border)", "stroke-width": stroke }, svg);
    var offset = 0;
    var items = [];
    for (var s = 0; s < values.length; s++) {
      var value = Math.max(0, values[s]);
      var share = total > 0 ? value / total : 0;
      var color = (opts.colors && opts.colors[s]) || PALETTE[s % PALETTE.length];
      var percent = Math.round(share * 1000) / 10 + "%";
      svgEl("circle", {
        cx: size / 2, cy: size / 2, r: radius, fill: "none", stroke: color, "stroke-width": stroke,
        "stroke-dasharray": round(share * circumference) + " " + round(circumference),
        "stroke-dashoffset": round(-offset * circumference),
        transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")", "data-mark": "",
        "data-tip": data.labels[s] + "\n" + format(value, opts) + " (" + percent + ")",
      }, svg);
      offset += share;
      items.push({ name: data.labels[s], color: color, value: format(value, opts) + " · " + percent });
    }
    var center = svgEl("text", { x: size / 2, y: size / 2 + 7, "text-anchor": "middle", "class": "ade-chart-total" }, svg);
    center.textContent = opts.total != null ? String(opts.total) : format(total, opts);
    return { svg: svg, items: items };
  }

  function drawSpark(wrap, data, opts) {
    var values = data.series.length ? data.series[0].values : [];
    var width = Number(opts.width) > 0 ? Number(opts.width) : 96;
    var height = Number(opts.height) > 0 ? Number(opts.height) : 24;
    var max = -Infinity, min = Infinity;
    for (var i = 0; i < values.length; i++) { if (values[i] > max) max = values[i]; if (values[i] < min) min = values[i]; }
    if (!(max > min)) { max = (isFinite(max) ? max : 0) + 1; min = max - 2; }
    var svg = svgEl("svg", { viewBox: "0 0 " + width + " " + height, height: height, width: width }, wrap);
    var points = [];
    var lastX = 0, lastY = height / 2;
    for (var p = 0; p < values.length; p++) {
      lastX = values.length > 1 ? 2 + ((width - 4) * p) / (values.length - 1) : width / 2;
      lastY = 2 + (height - 4) * (1 - (values[p] - min) / (max - min));
      points.push(round(lastX) + " " + round(lastY));
    }
    var color = (data.series[0] && data.series[0].color) || PALETTE[0];
    if (points.length) {
      svgEl("path", { d: "M" + points.join(" L"), fill: "none", stroke: color, "stroke-width": 1.6, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      svgEl("circle", { cx: lastX, cy: lastY, r: 2, fill: color }, svg);
    }
    return svg;
  }

  /**
   * ade.chart(target, options) draws a chart into an element and keeps it
   * fitted to that element's width. Returns { update(options), destroy() }.
   */
  window.ade.chart = function (target, options) {
    var host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) return null;
    var opts = options && typeof options === "object" ? options : {};
    var lastWidth = -1;
    var observer = null;

    function draw() {
      var type = String(opts.type || "bar");
      var data = normalize(opts);
      host.textContent = "";
      var spark = type === "spark";
      var wrap = htmlEl(spark ? "span" : "div", "ade-chart" + (spark ? " ade-chart-spark" : ""), host);
      if (opts.label) wrap.setAttribute("aria-label", String(opts.label));
      wrap.setAttribute("role", "img");
      var width = Math.max(160, Math.round(host.clientWidth || 600));
      lastWidth = width;
      if (spark) { drawSpark(wrap, data, opts); return; }
      var svg;
      if (type === "donut") {
        var height = Number(opts.height) > 0 ? Number(opts.height) : 160;
        wrap.style.display = "flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "20px";
        var donut = drawDonut(wrap, data, opts, height);
        svg = donut.svg;
        var side = htmlEl("div", "", wrap);
        legend(side, donut.items);
        side.firstChild.style.flexDirection = "column";
        side.firstChild.style.margin = "0";
      } else {
        if (data.series.length > 1 && opts.legend !== false) legend(wrap, data.series);
        var h = Number(opts.height) > 0 ? Number(opts.height) : 220;
        svg = type === "line" ? drawLine(wrap, data, opts, width, h, false)
          : type === "area" ? drawLine(wrap, data, opts, width, h, true)
          : drawBar(wrap, data, opts, width, h);
      }
      tooltips(wrap, svg);
    }

    draw();
    try { window.ade.resize(); } catch (e) {}
    if (typeof ResizeObserver === "function" && String(opts.type) !== "spark") {
      observer = new ResizeObserver(function () {
        var width = Math.max(160, Math.round(host.clientWidth || 600));
        if (width === lastWidth) return;
        draw();
      });
      observer.observe(host);
    }
    return {
      update: function (next) { if (next && typeof next === "object") opts = next; draw(); try { window.ade.resize(); } catch (e) {} },
      destroy: function () { if (observer) observer.disconnect(); host.textContent = ""; },
    };
  };
})();
`;
