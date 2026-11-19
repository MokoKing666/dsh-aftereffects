/* ============================================================================
 * dsh-aftereffects — ExtendScript runtime
 * ----------------------------------------------------------------------------
 * This file is evaluated inside Adobe After Effects by the host plugin. It is
 * plain ES3-compatible ExtendScript: no modules, no arrow functions, no
 * template literals, no let/const. Everything here runs in AE's own engine.
 *
 * It exposes one global object: `DSH`. The daemon and the batch runner call
 * into it with a JSON payload and get a JSON-serialisable value back.
 * ========================================================================== */

var DSH = (function () {
  var VERSION = '1.0.0';

  /* ---------------------------------------------------------------- utils */

  function isArray(v) {
    return v instanceof Array;
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** "#1a7cff" | "#1a7cff80" | "#abc" | [r,g,b] | [r,g,b,a] -> [r,g,b,a] in 0..1 */
  function color(v, alpha) {
    if (v === undefined || v === null || v === '') return null;
    if (isArray(v)) {
      var a = (v.length > 3 && isNum(v[3])) ? v[3] : (isNum(alpha) ? alpha : 1);
      return [v[0], v[1], v[2], a];
    }
    var s = String(v).replace(/^\s+|\s+$/g, '').replace(/^#/, '');
    if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    if (s.length !== 6 && s.length !== 8) return [1, 1, 1, 1];
    var r = parseInt(s.substring(0, 2), 16) / 255;
    var g = parseInt(s.substring(2, 4), 16) / 255;
    var b = parseInt(s.substring(4, 6), 16) / 255;
    var al = s.length === 8 ? parseInt(s.substring(6, 8), 16) / 255 : (isNum(alpha) ? alpha : 1);
    return [r, g, b, al];
  }

  function rgb3(v) {
    var c = color(v);
    return c ? [c[0], c[1], c[2]] : [0, 0, 0];
  }

  function rgba4(v, alpha) {
    var c = color(v, alpha);
    if (!c) c = [0, 0, 0, 1];
    if (!isNum(alpha)) return c;
    return [c[0], c[1], c[2], alpha];
  }

  function fsPath(p) {
    return String(p).replace(/\\/g, '/');
  }

  function decodePath(p) {
    if (!p) return p;
    return String(p).replace(/%5B/g, '[').replace(/%5D/g, ']').replace(/%20/g, ' ');
  }

  function ensureFolder(path) {
    var f = new Folder(fsPath(path));
    if (!f.exists) {
      try { f.create(); } catch (e) {}
    }
    return f;
  }

  function writeText(path, text) {
    var f = new File(fsPath(path));
    f.encoding = 'UTF-8';
    f.open('w');
    f.write(text);
    f.close();
    return f;
  }

  function readText(path) {
    var f = new File(fsPath(path));
    if (!f.exists) return null;
    f.encoding = 'UTF-8';
    if (!f.open('r')) return null;
    var s = f.read();
    f.close();
    return s;
  }

  function fileInfo(path) {
    var f = new File(fsPath(path));
    if (!f.exists) return { path: fsPath(path), name: f.name, exists: false, size: 0 };
    return { path: f.fsName, name: f.name, exists: true, size: f.length };
  }

  /**
   * Runtime entries are called with one JSON payload. A single-argument entry
   * accepts either the bare value or `{ <key>: value }`, so both
   * `saveProject('/x.aep')` and `saveProject({ path: '/x.aep' })` work.
   */
  function argOf(payload, key) {
    if (payload !== null && typeof payload === 'object' && !(payload instanceof Array)) {
      if (payload[key] !== undefined) return payload[key];
    }
    return payload;
  }

  /* ------------------------------------------------------------- project */

  /**
   * Start from a clean project without app.newProject(), which terminates a
   * headless After Effects. Removing every item leaves an empty project that
   * behaves the same way for our purposes.
   */
  function resetProject() {
    var rq = app.project.renderQueue;
    while (rq.numItems > 0) {
      try { rq.item(1).remove(); } catch (e) { break; }
    }
    for (var i = app.project.numItems; i >= 1; i--) {
      try { app.project.item(i).remove(); } catch (e2) {}
    }
    return app.project.numItems;
  }

  function projectInfo() {
    var items = [];
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      var rec = { id: it.id, name: it.name, type: it.typeName };
      if (it instanceof CompItem) {
        rec.width = it.width; rec.height = it.height;
        rec.duration = it.duration; rec.frameRate = it.frameRate;
        rec.layers = it.numLayers;
      }
      items.push(rec);
    }
    return {
      file: app.project.file ? app.project.file.fsName : null,
      items: items,
      count: app.project.numItems,
      renderQueue: app.project.renderQueue.numItems,
      bitsPerChannel: app.project.bitsPerChannel
    };
  }

  function findComp(name) {
    if (!name) {
      // the most recently created composition wins
      for (var i = app.project.numItems; i >= 1; i--) {
        if (app.project.item(i) instanceof CompItem) return app.project.item(i);
      }
      throw new Error('project has no composition');
    }
    for (var j = 1; j <= app.project.numItems; j++) {
      var it = app.project.item(j);
      if (it instanceof CompItem && it.name === name) return it;
    }
    for (var k = 1; k <= app.project.numItems; k++) {
      var it2 = app.project.item(k);
      if (it2 instanceof CompItem && String(it2.id) === String(name)) return it2;
    }
    throw new Error('composition not found: ' + name);
  }

  /* --------------------------------------------------------------- easing */

  function easePair(kind) {
    var k = String(kind || 'auto').toLowerCase();
    if (k === 'linear' || k === 'none') return { inInf: 0, outInf: 0, linear: true };
    if (k === 'in') return { inInf: 0, outInf: 75 };
    if (k === 'out') return { inInf: 75, outInf: 0 };
    if (k === 'both' || k === 'smooth' || k === 'auto') return { inInf: 66, outInf: 66 };
    if (k === 'hold') return { hold: true };
    var n = parseFloat(k);
    if (isNum(n)) return { inInf: n, outInf: n };
    return { inInf: 66, outInf: 66 };
  }

  function propDim(p) {
    var v = p.value;
    if (isArray(v)) return v.length;
    return 1;
  }

  function easeArray(dim, influence) {
    // KeyframeEase rejects an influence outside 0.1..100, so a "no influence"
    // side of an ease must be expressed as the smallest legal value.
    var safe = isNum(influence) ? clamp(influence, 0.1, 100) : 66;
    var out = [];
    for (var i = 0; i < dim; i++) out.push(new KeyframeEase(0, safe));
    return out;
  }

  /* ----------------------------------------------------------- properties */

  var TRANSFORM = 'ADBE Transform Group';

  function transformProp(layer, matchName) {
    return layer.property(TRANSFORM).property(matchName);
  }

  /**
   * Resolve an animation target.
   *   opacity | scale | position | position.x | rotation | anchor
   *   effect:<EffectName>:<ParamName>
   *   <matchName>            (anything else is treated as a matchName path)
   */
  function resolveProp(layer, path) {
    var p = String(path || '').replace(/^\s+|\s+$/g, '');
    var low = p.toLowerCase();
    if (low === 'opacity') return { prop: transformProp(layer, 'ADBE Opacity'), axis: -1 };
    if (low === 'scale') return { prop: transformProp(layer, 'ADBE Scale'), axis: -1 };
    if (low === 'rotation') return { prop: transformProp(layer, 'ADBE Rotate Z'), axis: -1 };
    if (low === 'anchor') return { prop: transformProp(layer, 'ADBE Anchor Point'), axis: -1 };
    if (low === 'position' || low === 'pos') return { prop: transformProp(layer, 'ADBE Position'), axis: -1 };
    if (low === 'position.x') return { prop: transformProp(layer, 'ADBE Position'), axis: 0 };
    if (low === 'position.y') return { prop: transformProp(layer, 'ADBE Position'), axis: 1 };
    if (low === 'position.z') return { prop: transformProp(layer, 'ADBE Position'), axis: 2 };
    if (low === 'scale.x') return { prop: transformProp(layer, 'ADBE Scale'), axis: 0 };
    if (low === 'scale.y') return { prop: transformProp(layer, 'ADBE Scale'), axis: 1 };
    if (low.indexOf('effect:') === 0) {
      var parts = p.split(':');
      var fxName = parts[1];
      var paramName = parts.slice(2).join(':');
      var parade = layer.property('ADBE Effect Parade');
      var fx = null;
      for (var i = 1; i <= parade.numProperties; i++) {
        var cand = parade.property(i);
        if (cand.name === fxName || cand.matchName === fxName) { fx = cand; break; }
      }
      if (!fx) throw new Error('effect not found: ' + fxName);
      if (!paramName) throw new Error('effect parameter missing: ' + p);
      var target = null;
      for (var j = 1; j <= fx.numProperties; j++) {
        var pp = fx.property(j);
        if (pp.name === paramName || pp.matchName === paramName) { target = pp; break; }
      }
      if (!target) throw new Error('effect parameter not found: ' + paramName + ' on ' + fxName);
      return { prop: target, axis: -1 };
    }
    // dotted matchName path, e.g. "ADBE Transform Group.ADBE Position"
    var segs = p.split('.');
    var node = layer;
    for (var s = 0; s < segs.length; s++) node = node.property(segs[s]);
    return { prop: node, axis: -1 };
  }

  function shapeValue(raw, dim, axis, current) {
    if (axis >= 0) {
      var arr = [];
      for (var i = 0; i < dim; i++) arr.push(isArray(current) ? current[i] : (i === axis ? raw : 0));
      arr[axis] = raw;
      return arr;
    }
    if (isArray(raw)) {
      var out = [];
      for (var j = 0; j < dim; j++) out.push(isNum(raw[j]) ? raw[j] : (isArray(current) ? current[j] : 0));
      return out;
    }
    if (dim === 1) return raw;
    var uni = [];
    for (var k = 0; k < dim; k++) uni.push(raw);
    return uni;
  }

  function animate(layer, anim) {
    if (!anim) return null;
    var resolved = resolveProp(layer, anim.property);
    var p = resolved.prop;
    var dim = propDim(p);
    var fromRaw = (anim.from !== undefined) ? anim.from : (anim.value !== undefined ? anim.value : p.value);
    var toRaw = (anim.to !== undefined) ? anim.to : fromRaw;
    var start = isNum(anim.start) ? anim.start : 0;
    var end = isNum(anim.end) ? anim.end : (start + 1);

    var base = p.value;
    var fromV = shapeValue(fromRaw, dim, resolved.axis, base);
    var toV = shapeValue(toRaw, dim, resolved.axis, base);

    var ease = easePair(anim.ease);
    if (ease.hold) {
      p.setValueAtTime(start, fromV);
      p.setValueAtTime(end, toV);
      p.setInterpolationTypeAtKey(p.nearestKeyIndex(start), KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
      return { property: anim.property, keys: 2, ease: 'hold' };
    }

    p.setValueAtTime(start, fromV);
    p.setValueAtTime(end, toV);

    var k1 = p.nearestKeyIndex(start);
    var k2 = p.nearestKeyIndex(end);
    if (k1 === k2) return { property: anim.property, keys: 1 };

    if (!ease.linear) {
      var inA = easeArray(dim, ease.inInf);
      var outA = easeArray(dim, ease.outInf);
      try { p.setTemporalEaseAtKey(k1, inA, outA); } catch (e1) {}
      try { p.setTemporalEaseAtKey(k2, inA, outA); } catch (e2) {}
    }
    return { property: anim.property, keys: 2, from: fromV, to: toV };
  }

  /* --------------------------------------------------------------- layers */

  function placeLayer(comp, layer, spec) {
    var t = layer.property(TRANSFORM);
    if (isNum(spec.x) || isNum(spec.y)) {
      var pos = t.property('ADBE Position').value;
      var nx = isNum(spec.x) ? spec.x : pos[0];
      var ny = isNum(spec.y) ? spec.y : pos[1];
      var nz = isNum(spec.z) ? spec.z : pos[2];
      t.property('ADBE Position').setValue([nx, ny, nz]);
    }
    if (isNum(spec.rotation)) t.property('ADBE Rotate Z').setValue(spec.rotation);
    if (spec.scale !== undefined) {
      var s = spec.scale;
      t.property('ADBE Scale').setValue(isArray(s) ? s : [s, s]);
    }
    if (isNum(spec.opacity)) t.property('ADBE Opacity').setValue(spec.opacity);
    if (spec.anchor !== undefined) {
      var a = spec.anchor;
      var dim = propDim(t.property('ADBE Anchor Point'));
      if (isArray(a)) t.property('ADBE Anchor Point').setValue(a);
      else {
        var arr = [];
        for (var i = 0; i < dim; i++) arr.push(a);
        t.property('ADBE Anchor Point').setValue(arr);
      }
    }
  }

  var BLEND = {
    normal: 'NORMAL', add: 'ADD', screen: 'SCREEN', multiply: 'MULTIPLY', overlay: 'OVERLAY',
    lighten: 'LIGHTEN', darken: 'DARKEN', difference: 'DIFFERENCE', softlight: 'SOFT_LIGHT',
    hardlight: 'HARD_LIGHT', color_dodge: 'COLOR_DODGE', color_burn: 'COLOR_BURN', hue: 'HUE',
    saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY', alpha_add: 'ALPHA_ADD'
  };

  function applyBlend(layer, mode) {
    if (!mode) return;
    var key = String(mode).toLowerCase().replace(/[\s-]/g, '_');
    var name = BLEND[key] || String(mode).toUpperCase();
    try { layer.blendingMode = BlendingMode[name]; } catch (e) {}
  }

  /**
   * Effect catalogue.
   *
   * `mn` is the effect's matchName. `params` maps a friendly, locale-independent
   * parameter key to the exact parameter matchName — necessary because After
   * Effects localises parameter *names* ("Glow Radius" becomes "发光半径") while
   * matchNames stay stable.
   */
  var EFFECTS = {
    glow: {
      mn: 'ADBE Glo2',
      params: { radius: 'ADBE Glo2-0003', intensity: 'ADBE Glo2-0004', threshold: 'ADBE Glo2-0002', color: 'ADBE Glo2-0007' }
    },
    blur: {
      mn: 'ADBE Gaussian Blur 2',
      params: { amount: 'ADBE Gaussian Blur 2-0001', blurriness: 'ADBE Gaussian Blur 2-0001', direction: 'ADBE Gaussian Blur 2-0002', repeatEdge: 'ADBE Gaussian Blur 2-0003' }
    },
    boxblur: {
      mn: 'ADBE Box Blur2',
      params: { amount: 'ADBE Box Blur2-0001', radius: 'ADBE Box Blur2-0001', iterations: 'ADBE Box Blur2-0002' }
    },
    shadow: {
      mn: 'ADBE Drop Shadow',
      params: { color: 'ADBE Drop Shadow-0001', opacity: 'ADBE Drop Shadow-0002', direction: 'ADBE Drop Shadow-0003', distance: 'ADBE Drop Shadow-0004', softness: 'ADBE Drop Shadow-0005' }
    },
    tint: {
      mn: 'ADBE Tint',
      params: { black: 'ADBE Tint-0001', white: 'ADBE Tint-0002', amount: 'ADBE Tint-0003' }
    },
    fill: {
      mn: 'ADBE Fill',
      params: { color: 'ADBE Fill-0002', opacity: 'ADBE Fill-0005', featherH: 'ADBE Fill-0003', featherV: 'ADBE Fill-0004' }
    },
    ramp: {
      mn: 'ADBE Ramp',
      params: { start: 'ADBE Ramp-0001', startColor: 'ADBE Ramp-0002', end: 'ADBE Ramp-0003', endColor: 'ADBE Ramp-0004', shape: 'ADBE Ramp-0005', scatter: 'ADBE Ramp-0006', blend: 'ADBE Ramp-0007' }
    },
    directionblur: {
      mn: 'ADBE Motion Blur',
      params: { direction: 'ADBE Motion Blur-0001', amount: 'ADBE Motion Blur-0002', length: 'ADBE Motion Blur-0002' }
    },
    levels: {
      mn: 'ADBE Easy Levels2',
      params: { inputBlack: 'ADBE Easy Levels2-0003', inputWhite: 'ADBE Easy Levels2-0004', gamma: 'ADBE Easy Levels2-0005', outputBlack: 'ADBE Easy Levels2-0006', outputWhite: 'ADBE Easy Levels2-0007' }
    },
    curves: { mn: 'ADBE CurvesCustom', params: {} },
    vibrance: {
      mn: 'ADBE Vibrance',
      params: { amount: 'ADBE Vibrance-0001', vibrance: 'ADBE Vibrance-0001', saturation: 'ADBE Vibrance-0002' }
    },
    hue: {
      mn: 'ADBE HUE SATURATION',
      params: { hue: 'ADBE HUE SATURATION-0004', saturation: 'ADBE HUE SATURATION-0005', lightness: 'ADBE HUE SATURATION-0006', colorize: 'ADBE HUE SATURATION-0007' }
    },
    saturation: {
      mn: 'ADBE HUE SATURATION',
      params: { hue: 'ADBE HUE SATURATION-0004', saturation: 'ADBE HUE SATURATION-0005', lightness: 'ADBE HUE SATURATION-0006' }
    },
    noise: {
      mn: 'ADBE Noise',
      params: { amount: 'ADBE Noise-0001', type: 'ADBE Noise-0002', clipping: 'ADBE Noise-0003' }
    },
    grain: {
      mn: 'ADBE Noise',
      params: { amount: 'ADBE Noise-0001', type: 'ADBE Noise-0002' }
    },
    mosaic: {
      mn: 'ADBE Mosaic',
      params: { horizontal: 'ADBE Mosaic-0001', vertical: 'ADBE Mosaic-0002', sharpen: 'ADBE Mosaic-0003' }
    },
    wave: {
      mn: 'ADBE Wave Warp',
      params: { type: 'ADBE Wave Warp-0001', height: 'ADBE Wave Warp-0002', width: 'ADBE Wave Warp-0003', direction: 'ADBE Wave Warp-0004', speed: 'ADBE Wave Warp-0005', phase: 'ADBE Wave Warp-0007' }
    },
    sharpen: {
      mn: 'ADBE Sharpen',
      params: { amount: 'ADBE Sharpen-0001' }
    },
    linearwipe: {
      mn: 'ADBE Linear Wipe',
      params: { transition: 'ADBE Linear Wipe-0001', angle: 'ADBE Linear Wipe-0002', feather: 'ADBE Linear Wipe-0003' }
    },
    radialwipe: {
      mn: 'ADBE Radial Wipe',
      params: { transition: 'ADBE Radial Wipe-0001', startAngle: 'ADBE Radial Wipe-0002', center: 'ADBE Radial Wipe-0003', wipe: 'ADBE Radial Wipe-0004', feather: 'ADBE Radial Wipe-0005' }
    },
    posterize: {
      mn: 'ADBE Posterize Time',
      params: { frameRate: 'ADBE Posterize Time-0001' }
    },
    echo: {
      mn: 'ADBE Echo',
      params: { time: 'ADBE Echo-0001', count: 'ADBE Echo-0002', startIntensity: 'ADBE Echo-0003', decay: 'ADBE Echo-0004' }
    },
    findedges: {
      mn: 'ADBE Find Edges',
      params: { invert: 'ADBE Find Edges-0001', blend: 'ADBE Find Edges-0002' }
    },
    minimax: {
      mn: 'ADBE Minimax',
      params: { operation: 'ADBE Minimax-0001', radius: 'ADBE Minimax-0002', channel: 'ADBE Minimax-0003' }
    }
  };

  function effectParams(fx) {
    var out = [];
    for (var i = 1; i <= fx.numProperties; i++) {
      var p = fx.property(i);
      if (!p) continue;
      var rec = { index: i, name: p.name, matchName: p.matchName };
      try { rec.value = p.value; } catch (e) {}
      out.push(rec);
    }
    return out;
  }

  function effectParamByMatchName(fx, matchName) {
    for (var i = 1; i <= fx.numProperties; i++) {
      var p = fx.property(i);
      if (p && p.matchName === matchName) return p;
    }
    return null;
  }

  function setParamValue(prop, value) {
    if (prop === null) return false;
    try {
      if (isArray(value)) prop.setValue(value);
      else if (typeof value === 'string' && value.charAt(0) === '#') prop.setValue(rgb3(value));
      else prop.setValue(value);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Add one effect.
   *
   * spec: { name: 'glow', radius: 40, intensity: 2 }
   *   name     — catalogue key, or a raw matchName, or an effect's display name
   *   matchName— explicit matchName, overrides `name`
   *   <key>    — a friendly parameter key from the catalogue, or a literal
   *              parameter matchName such as 'ADBE Glo2-0004'
   *   animate  — [{ param, from, to, start, end, ease }]
   */
  function addEffect(layer, spec) {
    var key = String(spec.name || spec.type || '').toLowerCase().replace(/[\s_]/g, '');
    var entry = EFFECTS[key];
    var matchName = spec.matchName || (entry ? entry.mn : spec.name);
    var parade = layer.property('ADBE Effect Parade');
    var fx;
    try {
      fx = parade.addProperty(matchName);
    } catch (e) {
      try {
        fx = parade.addProperty(spec.name);
      } catch (e2) {
        throw new Error('effect unavailable: ' + spec.name);
      }
    }

    var applied = [];
    for (var k in spec) {
      if (!spec.hasOwnProperty(k)) continue;
      if (k === 'name' || k === 'type' || k === 'matchName' || k === 'animate') continue;

      var targetMn = null;
      if (entry && entry.params[k]) targetMn = entry.params[k];
      else if (String(k).indexOf('ADBE ') === 0) targetMn = k;
      else if (entry && entry.params[String(k).toLowerCase()]) targetMn = entry.params[String(k).toLowerCase()];

      if (targetMn === null) {
        // last resort: a literal parameter matchName passed straight through
        var direct = effectParamByMatchName(fx, k);
        if (direct !== null) {
          if (setParamValue(direct, spec[k])) applied.push(k);
        }
        continue;
      }

      var target = effectParamByMatchName(fx, targetMn);
      if (target !== null && setParamValue(target, spec[k])) applied.push(k);
    }

    if (spec.animate && isArray(spec.animate)) {
      for (var a = 0; a < spec.animate.length; a++) {
        var an = spec.animate[a];
        var pr = an.param || an.property;
        if (!pr) continue;

        var pMn = (entry && entry.params[pr]) || pr;
        var target2 = effectParamByMatchName(fx, pMn);
        if (target2 === null) continue;

        var dim = propDim(target2);
        var e = easePair(an.ease);
        var fv = shapeValue(an.from, dim, -1, target2.value);
        var tv = shapeValue(an.to, dim, -1, target2.value);
        var st = isNum(an.start) ? an.start : 0;
        var en = isNum(an.end) ? an.end : st + 1;

        target2.setValueAtTime(st, fv);
        target2.setValueAtTime(en, tv);

        if (!e.linear) {
          try {
            target2.setTemporalEaseAtKey(target2.nearestKeyIndex(st), easeArray(dim, e.inInf), easeArray(dim, e.outInf));
            target2.setTemporalEaseAtKey(target2.nearestKeyIndex(en), easeArray(dim, e.inInf), easeArray(dim, e.outInf));
          } catch (e3) {}
        }
      }
    }

    return { name: fx.name, matchName: fx.matchName, applied: applied, params: effectParams(fx).length };
  }

  /* ----------------------------------------------------------------- text */

  var JUSTIFY = { left: 7413, center: 7415, right: 7414 };

  function setTextDocument(layer, spec) {
    var src = layer.property('ADBE Text Properties').property('ADBE Text Document');
    var td = src.value;
    if (spec.text !== undefined) td.text = String(spec.text);
    if (isNum(spec.size)) td.fontSize = spec.size;
    if (isNum(spec.tracking)) td.tracking = spec.tracking;
    if (isNum(spec.leading)) td.leading = spec.leading;
    if (spec.color) td.fillColor = rgb3(spec.color);
    if (spec.fill !== undefined) td.applyFill = !!spec.fill;
    if (spec.stroke) { td.applyStroke = true; td.strokeColor = rgb3(spec.stroke); }
    if (isNum(spec.strokeWidth)) td.strokeWidth = spec.strokeWidth;
    if (spec.align && JUSTIFY[String(spec.align).toLowerCase()] !== undefined) {
      td.justification = JUSTIFY[String(spec.align).toLowerCase()];
    }
    if (spec.font) {
      try { td.font = spec.font; } catch (e) {}
    }
    if (spec.fontFamily) {
      try { td.fontFamily = spec.fontFamily; } catch (e2) {}
    }
    if (spec.fauxBold) td.fauxBold = true;
    if (spec.allCaps) td.allCaps = true;
    src.setValue(td);
    return td;
  }

  function addTextLayer(comp, spec) {
    var layer = comp.layers.addText(String(spec.text === undefined ? '' : spec.text));
    layer.name = spec.name || String(spec.text || 'Text').substring(0, 40);
    setTextDocument(layer, spec);
    return layer;
  }

  /** Typewriter via a source-text expression; no keyframes needed. */
  function applyTypewriter(layer, spec) {
    var tw = spec.typewriter;
    if (!tw) return null;
    var speed = isNum(tw.speed) ? tw.speed : 24;
    var text = String(spec.text === undefined ? '' : spec.text);
    var src = layer.property('ADBE Text Properties').property('ADBE Text Document');
    var expr = 'var s = ' + JSON.stringify(text) + ';\n' +
      'var n = Math.min(s.length, Math.max(0, Math.floor((time - ' + (isNum(tw.start) ? tw.start : 0) + ') * ' + speed + ')));\n' +
      's.substr(0, n);';
    src.expression = expr;
    src.expressionEnabled = true;
    return { speed: speed };
  }

  /** Per-character reveal using a text animator driven by a range selector. */
  function applyCharReveal(layer, spec) {
    var cr = spec.charReveal;
    if (!cr) return null;
    var start = isNum(cr.start) ? cr.start : 0;
    var dur = isNum(cr.duration) ? cr.duration : 1;
    var animators = layer.property('ADBE Text Properties').property('ADBE Text Animators');
    var an = animators.addProperty('ADBE Text Animator');
    an.name = 'Reveal';
    var sel = an.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var startProp = sel.property('ADBE Text Percent Start');
    startProp.setValueAtTime(start, 0);
    startProp.setValueAtTime(start + dur, 100);
    var op = an.property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity');
    op.setValue(0);
    if (isNum(cr.offset)) {
      var off = an.property('ADBE Text Animator Properties');
      try {
        var pos = off.addProperty('ADBE Text Position 3D');
        pos.setValue([0, cr.offset, 0]);
      } catch (e) {}
    }
    return { duration: dur };
  }

  /* ---------------------------------------------------------------- shape */

  function addShapeLayer(comp, spec) {
    var layer = comp.layers.addShape();
    layer.name = spec.name || ('Shape ' + comp.numLayers);
    var root = layer.property('ADBE Root Vectors Group');
    var group = root.addProperty('ADBE Vector Group');
    group.name = spec.name || 'Shape';
    var vg = group.property('ADBE Vectors Group');

    var kind = String(spec.shape || spec.kind || 'rect').toLowerCase();
    var w = isNum(spec.w) ? spec.w : (isNum(spec.width) ? spec.width : 400);
    var h = isNum(spec.h) ? spec.h : (isNum(spec.height) ? spec.height : 400);
    var r = isNum(spec.radius) ? spec.radius : 0;

    if (kind === 'rect' || kind === 'rectangle') {
      var rect = vg.addProperty('ADBE Vector Shape - Rect');
      rect.property('ADBE Vector Rect Size').setValue([w, h]);
      rect.property('ADBE Vector Rect Roundness').setValue(r);
    } else if (kind === 'ellipse' || kind === 'circle') {
      var el = vg.addProperty('ADBE Vector Shape - Ellipse');
      el.property('ADBE Vector Ellipse Size').setValue([w, h]);
    } else if (kind === 'path' && spec.points) {
      var shapeProp = vg.addProperty('ADBE Vector Shape - Group');
      var sh = shapeProp.property('ADBE Vector Shape').value;
      var verts = [];
      for (var i = 0; i < spec.points.length; i++) {
        verts.push([spec.points[i][0], spec.points[i][1]]);
      }
      sh.vertices = verts;
      sh.closed = spec.closed !== false;
      shapeProp.property('ADBE Vector Shape').setValue(sh);
    }

    if (spec.fill !== false) {
      var fill = vg.addProperty('ADBE Vector Graphic - Fill');
      fill.property('ADBE Vector Fill Color').setValue(rgba4(spec.fill || spec.color || '#ffffff', spec.fillOpacity));
    }
    if (spec.stroke) {
      var stroke = vg.addProperty('ADBE Vector Graphic - Stroke');
      stroke.property('ADBE Vector Stroke Color').setValue(rgba4(spec.stroke));
      stroke.property('ADBE Vector Stroke Width').setValue(isNum(spec.strokeWidth) ? spec.strokeWidth : 4);
      if (spec.lineCap === 'round') stroke.property('ADBE Vector Stroke Line Cap').setValue(2);
    }

    var gt = group.property('ADBE Vector Transform Group');
    if (isNum(spec.rotation)) gt.property('ADBE Vector Rotation').setValue(spec.rotation);
    if (spec.scale !== undefined) {
      var sc = spec.scale;
      gt.property('ADBE Vector Scale').setValue(isArray(sc) ? sc : [sc, sc]);
    }

    // trim path animation (draw-on)
    if (spec.trim) {
      var trim = vg.addProperty('ADBE Vector Filter - Trim');
      var endProp = trim.property('ADBE Vector Trim End');
      var t = spec.trim;
      var st = isNum(t.start) ? t.start : 0;
      var en = isNum(t.end) ? t.end : st + 1;
      var from = isNum(t.from) ? t.from : 0;
      var to = isNum(t.to) ? t.to : 100;
      endProp.setValueAtTime(st, from);
      endProp.setValueAtTime(en, to);
      var e = easePair(t.ease || 'out');
      if (!e.linear) {
        try {
          endProp.setTemporalEaseAtKey(endProp.nearestKeyIndex(st), easeArray(1, e.inInf), easeArray(1, e.outInf));
          endProp.setTemporalEaseAtKey(endProp.nearestKeyIndex(en), easeArray(1, e.inInf), easeArray(1, e.outInf));
        } catch (e4) {}
      }
    }

    return layer;
  }

  function addSolidLayer(comp, spec) {
    var w = isNum(spec.w) ? spec.w : comp.width;
    var h = isNum(spec.h) ? spec.h : comp.height;
    var layer = comp.layers.addSolid(rgb3(spec.color || '#000000'), spec.name || ('Solid ' + comp.numLayers), w, h, 1, comp.duration);
    return layer;
  }

  function addFootageLayer(comp, spec) {
    var file = new File(fsPath(spec.path || spec.src));
    if (!file.exists) throw new Error('media not found: ' + spec.path);
    var io = new ImportOptions(file);
    var item = app.project.importFile(io);
    var layer = comp.layers.add(item);
    if (spec.name) layer.name = spec.name;
    if (isNum(spec.start)) layer.startTime = spec.start;
    return layer;
  }

  function addPrecompLayer(comp, spec) {
    var src = findComp(spec.comp || spec.source);
    var layer = comp.layers.add(src);
    if (spec.name) layer.name = spec.name;
    return layer;
  }

  function addNullLayer(comp, spec) {
    var layer = comp.layers.addNull(comp.duration);
    layer.name = spec.name || 'Null';
    return layer;
  }

  /* ---------------------------------------------------------------- scene */

  function addLayerFromSpec(comp, spec) {
    var type = String(spec.type || 'text').toLowerCase();
    var layer;
    if (type === 'text') layer = addTextLayer(comp, spec);
    else if (type === 'shape') layer = addShapeLayer(comp, spec);
    else if (type === 'solid') layer = addSolidLayer(comp, spec);
    else if (type === 'null' || type === 'controller') layer = addNullLayer(comp, spec);
    else if (type === 'footage' || type === 'image' || type === 'video') layer = addFootageLayer(comp, spec);
    else if (type === 'precomp') layer = addPrecompLayer(comp, spec);
    else throw new Error('unknown layer type: ' + type);

    if (spec.name) layer.name = spec.name;
    placeLayer(comp, layer, spec);
    applyBlend(layer, spec.blend);

    if (type === 'text') {
      applyTypewriter(layer, spec);
      applyCharReveal(layer, spec);
    }

    if (spec.effects && isArray(spec.effects)) {
      for (var i = 0; i < spec.effects.length; i++) addEffect(layer, spec.effects[i]);
    }
    if (spec.animate && isArray(spec.animate)) {
      for (var j = 0; j < spec.animate.length; j++) animate(layer, spec.animate[j]);
    }
    if (isNum(spec.inPoint)) layer.inPoint = spec.inPoint;
    if (isNum(spec.outPoint)) layer.outPoint = spec.outPoint;

    // `layer.index` is re-read here because adding layers re-stacks the comp;
    // reporting the index captured at insertion would be stale for every layer
    // except the newest.
    return { name: layer.name, id: layer.id, index: layer.index, type: type };
  }

  /**
   * Build a composition from a declarative scene spec.
   * Returns a compact summary; the comp itself stays in the project.
   */
  function buildScene(scene) {
    scene = scene || {};
    if (scene.resetProject) resetProject();

    var name = scene.name || 'Comp';
    var w = isNum(scene.width) ? scene.width : 1920;
    var h = isNum(scene.height) ? scene.height : 1080;
    var fps = isNum(scene.fps) ? scene.fps : 30;
    var duration = isNum(scene.duration) ? scene.duration : 8;

    var comp;
    if (scene.replace !== false) {
      for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === name) {
          try { it.remove(); } catch (e) {}
          break;
        }
      }
    }

    comp = app.project.items.addComp(name, w, h, 1, duration, fps);
    comp.bgColor = rgb3(scene.background || '#000000');
    if (isNum(scene.workAreaStart)) comp.workAreaStart = scene.workAreaStart;
    if (isNum(scene.workAreaDuration)) comp.workAreaDuration = scene.workAreaDuration;

    var built = [];
    var layers = scene.layers || [];
    for (var j = 0; j < layers.length; j++) {
      try {
        built.push(addLayerFromSpec(comp, layers[j]));
      } catch (e2) {
        built.push({ error: String(e2), spec: layers[j] && layers[j].name });
      }
    }

    if (scene.camera) {
      try {
        var cam = comp.layers.addCamera(scene.camera.name || 'Camera', [w / 2, h / 2]);
        if (scene.camera.position) cam.property(TRANSFORM).property('ADBE Position').setValue(scene.camera.position);
        if (isNum(scene.camera.zoom)) cam.property('ADBE Camera Options Group').property('ADBE Camera Zoom').setValue(scene.camera.zoom);
      } catch (e3) {}
    }

    // Re-index once the stack is final, so callers get the indices that
    // actually address each layer now.
    for (var b = 0; b < built.length; b++) {
      if (built[b].error) continue;
      try {
        for (var L = 1; L <= comp.numLayers; L++) {
          if (comp.layer(L).name === built[b].name) { built[b].index = L; break; }
        }
      } catch (e5) {}
    }

    return {
      comp: comp.name,
      id: comp.id,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      frameRate: comp.frameRate,
      layers: built,
      layerCount: comp.numLayers
    };
  }

  /* --------------------------------------------------------------- render */

  var tplCache = {};

  function templateList(om) {
    var names = [];
    for (var i = 0; i < om.templates.length; i++) names.push(om.templates[i]);
    return names;
  }

  /**
   * Probe every output template until one produces the wanted extension.
   *
   * Templates whose name starts with an underscore are After Effects' own
   * internal variants (`_HIDDEN X-Factor 8`, …): they write a PNG-looking file
   * but only a single frame, so they are ranked last and only used when nothing
   * else produces the extension.
   */
  function resolveTemplate(om, wantExt) {
    var key = 'ext:' + wantExt;
    if (tplCache[key] !== undefined) return tplCache[key];
    var probeDir = ensureFolder(Folder.temp.fsName);
    var probe = new File(probeDir.fsName + '/dsh-probe');
    var names = templateList(om);

    // Stable partition: public templates first, then internal ones.
    var ordered = [];
    var i;
    for (i = 0; i < names.length; i++) {
      if (String(names[i]).charAt(0) !== '_') ordered.push(names[i]);
    }
    for (i = 0; i < names.length; i++) {
      if (String(names[i]).charAt(0) === '_') ordered.push(names[i]);
    }

    for (i = 0; i < ordered.length; i++) {
      try {
        om.applyTemplate(ordered[i]);
        om.file = probe;
        var ext = String(om.file.name).toLowerCase();
        var m = ext.match(/\.([a-z0-9]+)$/);
        if (m && m[1] === wantExt) {
          tplCache[key] = ordered[i];
          return ordered[i];
        }
      } catch (e) {}
    }
    tplCache[key] = null;
    return null;
  }

  function statusOf(item) {
    try { return item.status; } catch (e) { return -1; }
  }

  function waitRender(item, timeoutMs) {
    var limit = isNum(timeoutMs) ? timeoutMs : 600000;
    var t0 = new Date().getTime();
    while (true) {
      var st = statusOf(item);
      if (st === RQItemStatus.DONE || st === RQItemStatus.ERR_STOPPED || st === RQItemStatus.UNQUEUED) break;
      if (new Date().getTime() - t0 > limit) break;
      $.sleep(200);
    }
    return statusOf(item);
  }

  function listOutputs(dir, baseName) {
    var out = [];
    var f = new Folder(fsPath(dir));
    if (!f.exists) return out;
    var files = f.getFiles();
    for (var i = 0; i < files.length; i++) {
      if (baseName && String(files[i].name).indexOf(baseName) !== 0) continue;
      out.push({ name: files[i].name, size: files[i].length });
    }
    return out;
  }

  /**
   * Export every frame of a composition as a numbered PNG file.
   *
   * The render queue's only PNG output templates are After Effects' internal
   * `_HIDDEN X-Factor` variants, and those write a single image rather than a
   * sequence. `saveFrameToPng` per frame is slower but produces exactly the
   * numbered files the caller expects, at any resolution.
   */
  function renderPngSequence(comp, outPath, opts) {
    var target = new File(outPath);
    var dir = target.parent ? target.parent.fsName : Folder.current.fsName;
    ensureFolder(dir);
    var base = target.name.replace(/\.[a-z0-9]+$/i, '');

    var from = isNum(opts.from) ? opts.from : 0;
    var to = isNum(opts.to) ? opts.to : comp.duration;
    var step = 1 / comp.frameRate;
    var pad = isNum(opts.padding) ? opts.padding : 4;

    var files = [];
    var t0 = new Date().getTime();
    var index = 0;
    for (var t = from; t < to - step / 2; t += step) {
      var digits = String(index);
      while (digits.length < pad) digits = '0' + digits;
      var framePath = dir + '/' + base + '_' + digits + '.png';
      comp.saveFrameToPng(t, new File(framePath));
      // saveFrameToPng writes asynchronously; wait for the file to land.
      var waited = 0;
      while (waited < 15000) {
        var probe = new File(framePath);
        if (probe.exists && probe.length > 0) break;
        $.sleep(20);
        waited += 20;
      }
      files.push({ name: base + '_' + digits + '.png', size: new File(framePath).length });
      index++;
    }

    return {
      comp: comp.name,
      format: 'png',
      template: 'saveFrameToPng',
      status: RQItemStatus.DONE,
      done: true,
      ms: new Date().getTime() - t0,
      dir: dir,
      frames: files.length,
      files: files.slice(0, 12),
      first: files.length > 0 ? dir + '/' + files[0].name : ''
    };
  }

  /**
   * Render a composition.
   * opts: { comp, output, format: 'mp4'|'png'|'mov'|'avi'|'tif'|'psd', stillAt, timeout }
   */
  function render(opts) {
    opts = opts || {};
    var comp = findComp(opts.comp);
    var format = String(opts.format || 'mp4').toLowerCase();
    var outPath = fsPath(opts.output || (comp.name + '.' + (format === 'png' ? 'png' : format)));

    if (isNum(opts.stillAt)) {
      var stillFile = new File(outPath);
      ensureFolder(stillFile.parent ? stillFile.parent.fsName : Folder.current.fsName);
      comp.saveFrameToPng(opts.stillAt, stillFile);
      var waited = 0;
      while (waited < 15000) {
        var probe = new File(outPath);
        if (probe.exists && probe.length > 0) break;
        $.sleep(100);
        waited += 100;
      }
      return { format: 'png', still: true, time: opts.stillAt, file: fileInfo(outPath) };
    }

    if (format === 'png') return renderPngSequence(comp, outPath, opts);

    var item = app.project.renderQueue.items.add(comp);
    var om = item.outputModule(1);

    var wantExt = format === 'mov' ? 'mov'
      : format === 'avi' ? 'avi'
      : format === 'tif' || format === 'tiff' ? 'tif'
      : format === 'psd' ? 'psd'
      : 'mp4';

    var tpl = resolveTemplate(om, wantExt);
    if (!tpl) {
      // fall back to the first H.264-ish template for video
      var names = templateList(om);
      for (var i = 0; i < names.length; i++) {
        if (/h\.?264|quicktime|lossless/i.test(names[i])) { tpl = names[i]; break; }
      }
      if (tpl) { try { om.applyTemplate(tpl); } catch (e) {} }
    }

    var seqDir = null;
    var baseName = null;
    if (wantExt === 'tif' || wantExt === 'psd') {
      var target = new File(outPath);
      seqDir = target.parent ? target.parent.fsName : Folder.current.fsName;
      ensureFolder(seqDir);
      baseName = target.name.replace(/\.[a-z0-9]+$/i, '');
      // Without a frame-number token After Effects overwrites one file for every
      // frame, leaving a single image behind. The token is what makes it a
      // sequence.
      var pattern = baseName;
      if (pattern.indexOf('[') < 0 && pattern.indexOf('#') < 0) pattern = baseName + '_[####]';
      om.file = new File(seqDir + '/' + pattern);
    } else {
      om.file = new File(outPath);
    }

    var t0 = new Date().getTime();
    app.project.renderQueue.render();
    var status = waitRender(item, opts.timeout);
    var ms = new Date().getTime() - t0;

    var result = {
      comp: comp.name,
      format: wantExt,
      template: tpl,
      status: status,
      done: status === RQItemStatus.DONE,
      ms: ms
    };

    if (seqDir) {
      var files = listOutputs(seqDir, baseName);
      result.dir = seqDir;
      result.frames = files.length;
      result.files = files.slice(0, 12);
      if (files.length > 0) result.first = seqDir + '/' + files[0].name;
    } else {
      var outFile = null;
      try { outFile = om.file ? decodePath(om.file.fsName) : outPath; } catch (e3) { outFile = outPath; }
      result.file = fileInfo(outFile);
    }

    try { item.remove(); } catch (e4) {}
    return result;
  }

  /* -------------------------------------------------------------- project */

  function saveProject(payload) {
    var path = argOf(payload, 'path');
    var f = new File(fsPath(path));
    ensureFolder(f.parent ? f.parent.fsName : Folder.current.fsName);
    app.project.save(f);
    return fileInfo(path);
  }

  function openProject(payload) {
    var path = argOf(payload, 'path');
    var f = new File(fsPath(path));
    if (!f.exists) throw new Error('project not found: ' + path);
    var proj = app.open(f);
    return { file: proj.file ? proj.file.fsName : null, items: proj.numItems };
  }

  function exportMogrt(opts) {
    opts = opts || {};
    var comp = findComp(opts.comp);
    var out = fsPath(opts.output || (comp.name + '.mogrt'));
    var ok = comp.exportAsMotionGraphicsTemplate(true, out);
    return { ok: !!ok, comp: comp.name, file: fileInfo(out) };
  }

  /* ------------------------------------------------------------ inventory */

  function describeComp(payload) {
    var comp = findComp(argOf(payload, 'comp'));
    var layers = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      var l = comp.layer(i);
      var rec = { index: i, name: l.name, enabled: l.enabled, inPoint: l.inPoint, outPoint: l.outPoint };
      try { rec.type = l instanceof TextLayer ? 'text' : (l instanceof ShapeLayer ? 'shape' : (l.source ? 'footage' : 'other')); } catch (e) {}
      try {
        var t = l.property(TRANSFORM);
        rec.position = t.property('ADBE Position').value;
        rec.opacity = t.property('ADBE Opacity').value;
        rec.scale = t.property('ADBE Scale').value;
      } catch (e2) {}
      try { rec.effects = l.property('ADBE Effect Parade').numProperties; } catch (e3) {}
      layers.push(rec);
    }
    return {
      name: comp.name, id: comp.id, width: comp.width, height: comp.height,
      duration: comp.duration, frameRate: comp.frameRate, layers: layers
    };
  }

  function environment() {
    return {
      runtime: VERSION,
      version: app.version,
      buildName: app.buildName,
      buildNumber: app.buildNumber,
      locale: app.isoLanguage,
      os: $.os,
      engine: $.version,
      project: app.project.file ? app.project.file.fsName : null,
      items: app.project.numItems,
      templates: (function () {
        try {
          var c = app.project.items.addComp('__dsh_probe__', 16, 16, 1, 1, 1);
          var it = app.project.renderQueue.items.add(c);
          var names = templateList(it.outputModule(1));
          it.remove();
          c.remove();
          return names;
        } catch (e) { return []; }
      })()
    };
  }

  /* ------------------------------------------------------------------ API */

  return {
    version: VERSION,
    color: color,
    rgb3: rgb3,
    rgba4: rgba4,
    fsPath: fsPath,
    ensureFolder: ensureFolder,
    writeText: writeText,
    readText: readText,
    fileInfo: fileInfo,
    resetProject: resetProject,
    projectInfo: projectInfo,
    findComp: findComp,
    buildScene: buildScene,
    addLayerFromSpec: addLayerFromSpec,
    addEffect: addEffect,
    animate: animate,
    resolveProp: resolveProp,
    render: render,
    saveProject: saveProject,
    openProject: openProject,
    exportMogrt: exportMogrt,
    describeComp: describeComp,
    environment: environment,
    listOutputs: listOutputs,
    templateList: function (payload) {
      var comp = findComp(argOf(payload, 'comp'));
      var it = app.project.renderQueue.items.add(comp);
      var names = templateList(it.outputModule(1));
      it.remove();
      return names;
    }
  };
})();

DSH;
