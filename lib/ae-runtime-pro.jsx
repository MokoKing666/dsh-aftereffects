/* ============================================================================
 * dsh-aftereffects — pro template capability pack
 * ----------------------------------------------------------------------------
 * Everything a commercial AE template workflow needs, layered on top of the
 * existing runtime. Still ES3 ExtendScript: no const/let/arrows/templates.
 *
 * Sections
 *   A. property type tables (locale-independent value/type names)
 *   B. effect scanning (app.effects) + parameter tree inspection
 *   C. .ffx preset discovery and application
 *   D. preview capture (saveFrameToPng, downsample, solo isolation, sheet)
 *   E. Essential Graphics controllers + .mogrt export
 *   F. audio waveform analysis -> timeline markers
 *   G. project checkpoint (timestamped .aep copy)
 *   H. layer addressing by stable id, sourceRectAtTime auto-fit
 *   I. guarded execution with precise line reporting
 * ========================================================================== */

var DSH_PRO = (function () {

  /**
   * The core runtime is loaded first and published as a global by the daemon.
   * Reaching for it here keeps one source of truth for comp/folder helpers
   * instead of a second copy that can drift.
   */
  var CORE = (typeof DSH !== 'undefined' && DSH) ? DSH : null;
  if (CORE === null) {
    throw new Error('dsh-aftereffects pro pack requires the core runtime (DSH global)');
  }
  var findComp = CORE.findComp;
  var ensureFolder = CORE.ensureFolder;

  /* ---------------------------------------------------------------- A. types */

  var PT = {};
  PT[PropertyType.PROPERTY] = 'PROPERTY';
  PT[PropertyType.INDEXED_GROUP] = 'INDEXED_GROUP';
  PT[PropertyType.NAMED_GROUP] = 'NAMED_GROUP';

  var VT = {};
  (function () {
    var v = PropertyValueType;
    VT[v.NO_VALUE] = 'NO_VALUE';
    VT[v.ThreeD_SPATIAL] = 'ThreeD_SPATIAL';
    VT[v.ThreeD] = 'ThreeD';
    VT[v.TwoD_SPATIAL] = 'TwoD_SPATIAL';
    VT[v.TwoD] = 'TwoD';
    VT[v.OneD] = 'OneD';
    VT[v.COLOR] = 'COLOR';
    VT[v.CUSTOM_VALUE] = 'CUSTOM_VALUE';
    VT[v.MARKER] = 'MARKER';
    VT[v.LAYER_INDEX] = 'LAYER_INDEX';
    VT[v.MASK_INDEX] = 'MASK_INDEX';
    VT[v.SHAPE] = 'SHAPE';
    VT[v.TEXT_DOCUMENT] = 'TEXT_DOCUMENT';
  })();

  function propTypeName(p) {
    try { return PT[p.propertyType] || String(p.propertyType); } catch (e) { return null; }
  }

  function valueTypeName(p) {
    try { return VT[p.propertyValueType] || String(p.propertyValueType); } catch (e) { return null; }
  }

  /**
   * CUSTOM_VALUE marks an opaque binary property (third-party effect internals).
   * Reading it works; writing it silently corrupts or throws. The model must be
   * told, so every inspector row carries this explicit flag.
   */
  function isCustom(p) {
    try { return p.propertyValueType === PropertyValueType.CUSTOM_VALUE; } catch (e) { return false; }
  }

  function safeValue(p) {
    var vt;
    try { vt = p.propertyValueType; } catch (e0) { return null; }
    if (vt === PropertyValueType.NO_VALUE) return null;
    if (vt === PropertyValueType.CUSTOM_VALUE) return null; // never serialise
    if (vt === PropertyValueType.MARKER) {
      try { return { comment: p.value.comment, duration: p.value.duration }; } catch (e1) { return null; }
    }
    if (vt === PropertyValueType.SHAPE) {
      try {
        var s = p.value;
        return { _type: 'Shape', vertexCount: s.vertices.length, closed: s.closed };
      } catch (e2) { return null; }
    }
    if (vt === PropertyValueType.TEXT_DOCUMENT) {
      try {
        var td = p.value;
        return { _type: 'TextDocument', text: td.text, fontSize: td.fontSize };
      } catch (e3) { return null; }
    }
    try {
      var v = p.value;
      if (v instanceof Array) {
        var out = [];
        for (var i = 0; i < v.length; i++) out.push(v[i]);
        return out;
      }
      return v;
    } catch (e4) { return null; }
  }

  /* ------------------------------------------------------------- B. effects */

  /**
   * Enumerate every effect installed for this After Effects installation,
   * native and third-party alike (Particular, Deep Glow, Saber, Element 3D…).
   * `app.effects` is the only API that reports the installed set; display names
   * are localised, matchNames are not, so the mapping is the whole point.
   */
  function scanEffects(payload) {
    var opts = payload || {};
    var query = opts.query ? String(opts.query).toLowerCase() : null;
    var includeObsolete = opts.includeObsolete === true;
    var limit = opts.limit ? Math.max(1, Math.min(100000, opts.limit)) : 100000;

    if (!app.effects) {
      throw new Error('app.effects is unavailable in this After Effects version');
    }

    var coll = app.effects;
    var total;
    try { total = Number(coll.length); } catch (e) { total = NaN; }
    if (!isFinite(total) || total <= 0) {
      try { total = Number(coll.numEffects); } catch (e2) { total = 0; }
    }
    if (!isFinite(total) || total < 0) total = 0;

    var rows = [];
    var skippedObsolete = 0;
    for (var i = 0; i < total; i++) {
      var eff = null;
      try { eff = coll[i]; } catch (e3) { eff = null; }
      if (!eff) {
        try { eff = coll.effect(i + 1); } catch (e4) { eff = null; }
      }
      if (!eff) continue;

      var row = { index: i };
      try { row.displayName = eff.displayName || eff.name || ''; } catch (e5) { row.displayName = ''; }
      try { row.matchName = eff.matchName || ''; } catch (e6) { row.matchName = ''; }
      try { row.category = eff.category || ''; } catch (e7) { row.category = ''; }
      try { row.version = eff.version || ''; } catch (e8) { row.version = ''; }

      var obsolete = false;
      try { obsolete = !!eff.isObsolete; } catch (e9) { obsolete = false; }
      row.obsolete = obsolete;
      if (obsolete && !includeObsolete) { skippedObsolete++; continue; }

      if (query !== null) {
        var hay = (String(row.displayName) + ' ' + String(row.matchName) + ' ' + String(row.category)).toLowerCase();
        if (hay.indexOf(query) < 0) continue;
      }

      rows.push(row);
      if (rows.length >= limit) break;
    }

    // Third-party effects are the practical reason this exists; flag them so a
    // model can tell "installed plugin" from "ships with AE" at a glance.
    var thirdParty = [];
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var isAdobe = /^ADBE /.test(r.matchName) || /^CC /.test(r.matchName);
      r.thirdParty = !isAdobe && r.matchName !== '';
      if (r.thirdParty) thirdParty.push(r);
    }

    return {
      total: total,
      returned: rows.length,
      skippedObsolete: skippedObsolete,
      thirdPartyCount: thirdParty.length,
      query: opts.query || null,
      effects: rows
    };
  }

  /** Resolve one effect on a layer by matchName, display name, or index. */
  function findEffect(layer, spec) {
    var parade = layer.property('ADBE Effect Parade');
    var count = parade.numProperties;
    var i, fx;

    if (spec.effectIndex !== undefined && spec.effectIndex !== null) {
      var idx = Number(spec.effectIndex);
      if (idx >= 1 && idx <= count) return parade.property(idx);
      throw new Error('effectIndex ' + idx + ' out of range 1..' + count);
    }

    var wantMatch = spec.matchName ? String(spec.matchName) : null;
    var wantName = spec.effectName ? String(spec.effectName) : null;

    for (i = 1; i <= count; i++) {
      fx = parade.property(i);
      if (wantMatch !== null && fx.matchName === wantMatch) return fx;
    }
    for (i = 1; i <= count; i++) {
      fx = parade.property(i);
      if (wantName !== null && fx.name === wantName) return fx;
    }
    throw new Error('effect not found on layer ' + layer.name + ': '
      + (wantMatch || wantName || '(none)'));
  }

  /**
   * Read one effect's full parameter tree.
   *
   * Every row carries the numeric `propertyIndex` (the only stable handle
   * across a localised After Effects), the parameter `matchName`, its value
   * type, and an explicit `customValue` flag. Dropdown menus list their items
   * so a model can pick an index instead of guessing an English label.
   */
  function inspectEffectParams(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);
    var fx = findEffect(layer, opts);

    var rows = [];
    var customCount = 0;
    var count = fx.numProperties;

    for (var i = 1; i <= count; i++) {
      var p = fx.property(i);
      if (!p) continue;

      var row = {
        propertyIndex: i,
        name: p.name,
        matchName: p.matchName,
        propertyType: propTypeName(p),
        valueType: valueTypeName(p)
      };

      var custom = isCustom(p);
      row.customValue = custom;
      if (custom) {
        customCount++;
        row.note = 'CUSTOM_VALUE: opaque binary property. Never assign a value from a script.';
      }

      try { row.canSetExpression = !!p.canSetExpression; } catch (e1) {}
      try { row.isTimeVarying = !!p.isTimeVarying; } catch (e2) {}

      if (!custom) {
        var v = safeValue(p);
        if (v !== null && v !== undefined) row.value = v;
      }

      // Dropdown / menu parameters report their legal item list.
      try {
        if (p.propertyType === PropertyType.PROPERTY && p.value !== undefined) {
          var menu = null;
          if (typeof p.getPropertyParameters === 'function') {
            menu = p.getPropertyParameters();
          }
          if (menu && menu.numProperties > 0) {
            var items = [];
            for (var m = 1; m <= menu.numProperties; m++) {
              items.push({ index: m, name: menu.property(m).name });
            }
            row.menuItems = items;
          }
        }
      } catch (e3) {}

      // Composite groups (points, colors) are themselves a tree.
      if (p.propertyType === PropertyType.INDEXED_GROUP || p.propertyType === PropertyType.NAMED_GROUP) {
        var children = [];
        for (var c = 1; c <= p.numProperties; c++) {
          var cp = p.property(c);
          if (!cp) continue;
          var crow = {
            propertyIndex: c,
            name: cp.name,
            matchName: cp.matchName,
            valueType: valueTypeName(cp),
            customValue: isCustom(cp)
          };
          if (!crow.customValue) {
            var cv = safeValue(cp);
            if (cv !== null && cv !== undefined) crow.value = cv;
          }
          children.push(crow);
        }
        row.children = children;
      }

      rows.push(row);
    }

    return {
      layer: { id: layer.id, index: layer.index, name: layer.name },
      effect: { name: fx.name, matchName: fx.matchName, propertyIndex: fx.propertyIndex },
      parameterCount: rows.length,
      customValueCount: customCount,
      warning: customCount > 0
        ? customCount + ' parameter(s) are CUSTOM_VALUE and must not be assigned by script.'
        : null,
      parameters: rows
    };
  }

  /* --------------------------------------------------------------- C. ffx */

  /**
   * ExtendScript reports `Folder.name` / `File.name` URL-encoded:
   * "After%20Effects%202026", "%E5%BC%B9%E5%85%A5.ffx". Every name comparison
   * and every display string has to decode first — this one helper is the
   * difference between discovering the presets and silently finding nothing.
   */
  function decodedName(entry) {
    var raw = String(entry.name);
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }

  /**
   * Recursively collect `.ffx` files under a root, bounded in depth and count.
   * `path` keeps the raw fsName a `File` can open.
   */
  function collectFfx(rootPath, maxDepth, limit) {
    var out = [];
    function walk(folder, depth) {
      if (out.length >= limit) return;
      var entries;
      try { entries = folder.getFiles(); } catch (e) { return; }
      for (var i = 0; i < entries.length; i++) {
        if (out.length >= limit) return;
        var f = entries[i];
        if (f instanceof Folder) {
          if (depth < maxDepth) walk(f, depth + 1);
        } else if (/\.ffx$/i.test(String(f.name))) {
          out.push({ name: decodedName(f), path: f.fsName, size: f.length });
        }
      }
    }
    var root = new Folder(rootPath);
    if (!root.exists) return { root: rootPath, exists: false, presets: out };
    walk(root, 0);
    return { root: rootPath, exists: true, presets: out };
  }

  /**
   * Candidate `.ffx` roots, discovered rather than hard-coded.
   *
   * After Effects stores presets in three places, and which ones exist depends
   * on version and locale:
   *   - the install tree      <AE>/Support Files/Presets        (ships with AE)
   *   - per-user documents    ~/Documents/Adobe/After Effects <v>/User Presets
   *   - roaming app data      %APPDATA%/Adobe/After Effects/<v>/Effect Presets
   * The `<v>` folder name is localised, so it is matched by prefix, not equality.
   */
  function presetRoots(extra) {
    var roots = [];
    var push = function (p) {
      if (p === null || p === undefined) return;
      var s = String(p);
      if (s === '' || s === 'false') return;
      for (var i2 = 0; i2 < roots.length; i2++) if (roots[i2] === s) return;
      roots.push(s);
    };

    if (extra && extra instanceof Array) {
      for (var i = 0; i < extra.length; i++) push(extra[i]);
    }

    var versionFolders = [];

    // Per-user document presets.
    try {
      var docAdobe = new Folder('~/Documents/Adobe');
      if (docAdobe.exists) {
        var dList = docAdobe.getFiles();
        for (var d = 0; d < dList.length; d++) {
          if (!(dList[d] instanceof Folder)) continue;
          if (!/^After Effects/i.test(decodedName(dList[d]))) continue;
          versionFolders.push(dList[d].fsName);
          push(dList[d].fsName + '/User Presets');
          push(dList[d].fsName + '/Presets');
        }
      }
    } catch (e1) {}

    // Roaming app-data presets.
    try {
      var appData = $.getenv('APPDATA');
      if (appData) {
        var appAdobe = new Folder(appData + '/Adobe');
        if (appAdobe.exists) {
          var aList = appAdobe.getFiles();
          for (var a = 0; a < aList.length; a++) {
            if (!(aList[a] instanceof Folder)) continue;
            if (!/^After Effects/i.test(decodedName(aList[a]))) continue;
            versionFolders.push(aList[a].fsName);
            push(aList[a].fsName + '/Effect Presets');
            push(aList[a].fsName + '/Presets');
          }
        }
      }
    } catch (e2) {}

    // Install-tree presets, found next to the running After Effects binary.
    try {
      var exe = new File(app.path ? String(app.path) : '');
      if (exe.exists && exe.parent) {
        push(exe.parent.fsName + '/Presets');
      }
    } catch (e3) {}
    try {
      // `app.path` is not always populated; the install root is the parent of
      // "Support Files", so probe the usual Program Files location too.
      var pf = $.getenv('PROGRAMFILES');
      if (pf) {
        var pfAdobe = new Folder(pf + '/Adobe');
        if (pfAdobe.exists) {
          var pList = pfAdobe.getFiles();
          for (var p = 0; p < pList.length; p++) {
            if (!(pList[p] instanceof Folder)) continue;
            if (!/^Adobe After Effects/i.test(decodedName(pList[p]))) continue;
            // Non-Beta releases carry the bulk of the shipping presets.
            if (/[Bb]eta/.test(decodedName(pList[p]))) continue;
            push(pList[p].fsName + '/Support Files/Presets');
          }
        }
      }
    } catch (e4) {}

    return roots;
  }

  /** Find `.ffx` presets, by name or by scanning the given roots. */
  function scanPresets(payload) {
    var opts = payload || {};
    var roots = presetRoots(opts.roots);
    var limit = opts.limit ? Math.max(1, Math.min(5000, opts.limit)) : 800;
    var maxDepth = opts.maxDepth ? Math.max(1, Math.min(8, opts.maxDepth)) : 4;
    var query = opts.query ? String(opts.query).toLowerCase() : null;

    var all = [];
    var scanned = [];
    for (var i = 0; i < roots.length; i++) {
      var res = collectFfx(roots[i], maxDepth, limit - all.length);
      scanned.push({ root: roots[i], exists: res.exists, found: res.presets.length });
      for (var j = 0; j < res.presets.length && all.length < limit; j++) {
        var p = res.presets[j];
        if (query !== null && String(p.name).toLowerCase().indexOf(query) < 0) continue;
        p.root = roots[i];
        all.push(p);
      }
      if (all.length >= limit) break;
    }

    return { scanned: scanned, count: all.length, presets: all };
  }

  /**
   * Apply an `.ffx` preset to a layer. This is the escape hatch for heavy
   * third-party effects whose parameters cannot be scripted: the preset was
   * authored in the UI, so AE applies the binary config itself.
   */
  /**
   * Apply an `.ffx` preset.
   *
   * `layer.applyPreset()` needs an interactive AE. Measured on AE 27.0x78 in
   * `-noui` mode it terminates the process outright — no exception, no return.
   * The host is therefore asked up front whether presets are usable, and a
   * negative answer becomes a clear, actionable error instead of a crash the
   * caller has to diagnose from a vanished heartbeat.
   */
  function applyFfxPreset(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);
    var path = String(opts.presetPath || opts.path || '');
    if (path === '') throw new Error('presetPath is required');

    var file = new File(path);
    if (!file.exists) throw new Error('preset not found: ' + path);

    var before = 0;
    try { before = layer.property('ADBE Effect Parade').numProperties; } catch (e) {}
    var beforeNames = effectNames(layer);
    var beforeKeys = countTransformKeys(layer);

    var raw = String(file.name);
    var display = raw;
    try { display = decodeURIComponent(raw); } catch (e0) {}

    app.beginUndoGroup('DSH_AE apply preset');
    try {
      layer.applyPreset(file);
    } finally {
      try { app.endUndoGroup(); } catch (e1) {}
    }

    var afterNames = effectNames(layer);
    var added = [];
    for (var i = 0; i < afterNames.length; i++) {
      var seen = false;
      for (var j = 0; j < beforeNames.length; j++) {
        if (beforeNames[j] === afterNames[i]) { seen = true; break; }
      }
      if (!seen) added.push(afterNames[i]);
    }
    var afterKeys = countTransformKeys(layer);

    return {
      applied: true,
      preset: display,
      presetPath: file.fsName,
      layer: { id: layer.id, name: layer.name },
      effectsBefore: before,
      effectsAfter: afterNames.length,
      addedEffects: added,
      keyframesBefore: beforeKeys,
      keyframesAfter: afterKeys,
      // Animation presets change keyframes, effect presets change the stack;
      // reporting both lets the caller tell which kind of preset landed.
      kind: added.length > 0 ? 'effect' : (afterKeys > beforeKeys ? 'animation' : 'no-change')
    };
  }

  /** Total keyframes across the transform group, used to detect animation presets. */
  function countTransformKeys(layer) {
    var total = 0;
    try {
      var t = layer.property('ADBE Transform Group');
      for (var i = 1; i <= t.numProperties; i++) {
        var p = t.property(i);
        try { if (p && p.numKeys) total += p.numKeys; } catch (e) {}
      }
    } catch (e2) {}
    return total;
  }

  function effectNames(layer) {
    var out = [];
    try {
      var parade = layer.property('ADBE Effect Parade');
      for (var i = 1; i <= parade.numProperties; i++) out.push(parade.property(i).name);
    } catch (e) {}
    return out;
  }

  /**
   * Report what this After Effects instance can actually do.
   *
   * `applyPreset` exists as a function but is unusable in `-noui` mode: calling
   * it takes the process down. The distinction between "the API is present" and
   * "the API works headless" is exactly what a caller needs before building a
   * workflow on it, so it is reported separately.
   */
  function capabilities() {
    var out = {
      aeVersion: app.version,
      headless: true,
      applyPreset: { present: false, usable: false, reason: '' },
      exportMogrt: { present: false, usable: false, reason: '' },
      audioLevels: { present: false, usable: false, reason: '' },
      saveFrameToPng: { present: false, usable: false, reason: '' },
      effectsApi: { present: false, usable: false, reason: '' }
    };

    try {
      var probe = app.project.items.addComp('__dsh_cap__', 16, 16, 1, 1, 1);
      var l = probe.layers.addNull();
      try {
        out.applyPreset.present = typeof l.applyPreset === 'function';
        // Present but not usable headless — measured, not guessed.
        out.applyPreset.usable = false;
        out.applyPreset.reason = out.applyPreset.present
          ? 'applyPreset() terminates a -noui instance (measured on AE 27); use an interactive AE, '
            + 'or apply the effect and its parameters directly with ae_run_script.'
          : 'applyPreset() is not available in this After Effects version.';
      } catch (e1) {}

      try {
        out.exportMogrt.present = typeof probe.exportAsMotionGraphicsTemplate === 'function';
        // Measured on AE 27.0x78: the export call terminates a -noui instance,
        // exactly like applyPreset. Present is not the same as usable.
        out.exportMogrt.usable = false;
        out.exportMogrt.reason = out.exportMogrt.present
          ? 'exportAsMotionGraphicsTemplate() terminates a -noui instance (measured on AE 27); '
            + 'bind the controllers here, then export the .mogrt from an interactive After Effects '
            + '(File > Export > "Template…").'
          : 'exportAsMotionGraphicsTemplate() is not available in this After Effects version.';
      } catch (e2) {}

      try {
        out.saveFrameToPng.present = typeof probe.saveFrameToPng === 'function';
        out.saveFrameToPng.usable = out.saveFrameToPng.present;
      } catch (e3) {}

      try {
        out.effectsApi.present = !!app.effects;
        out.effectsApi.usable = out.effectsApi.present;
      } catch (e4) {}

      try { probe.remove(); } catch (e5) {}
    } catch (e6) {
      out.probeError = String(e6);
    }

    try {
      var c2 = app.project.items.addComp('__dsh_aud__', 16, 16, 1, 1, 1);
      var s = c2.layers.addSolid([0, 0, 0], 's', 16, 16, 1, 1);
      var ag = null;
      try { ag = s.property('ADBE Audio Group'); } catch (e7) { ag = null; }
      if (!ag) {
        try { ag = s.property('Audio Group'); } catch (e8) { ag = null; }
      }
      out.audioLevels.present = !!ag;
      out.audioLevels.usable = !!ag;
      if (!ag) out.audioLevels.reason = 'audio group unavailable on this layer type';
      try { c2.remove(); } catch (e9) {}
    } catch (e10) {}

    return out;
  }

  /* ---------------------------------------------------------- D. capture */

  function waitFile(pathStr, timeoutMs) {
    var waited = 0;
    while (waited < timeoutMs) {
      var f = new File(pathStr);
      if (f.exists && f.length > 0) return { file: f, waitedMs: waited };
      $.sleep(25);
      waited += 25;
    }
    return { file: null, waitedMs: waited };
  }

  function factorFor(comp, longEdge) {
    var compLong = Math.max(comp.width, comp.height);
    return Math.max(1, Math.min(99, Math.round(compLong / Math.max(1, longEdge))));
  }

  /**
   * Render one frame to PNG.
   *
   * `resolutionFactor` is the cost lever — a model judging layout rarely needs
   * full resolution. `soloLayerId` isolates a layer so "why is this invisible"
   * becomes answerable; every solo flag is restored afterwards.
   */
  function capturePreview(payload) {
    var opts = payload || {};
    var comp = resolveComp(opts);
    var layer = null;
    if (opts.soloLayerId !== undefined && opts.soloLayerId !== null) {
      layer = layerById(comp, opts.soloLayerId);
    }

    var time = (opts.time === undefined || opts.time === null) ? comp.time : Number(opts.time);
    if (time < 0) time = 0;
    if (time > comp.duration) time = comp.duration;
    // Sampling exactly at duration is one frame past the end and renders empty.
    var lastRenderable = Math.max(0, comp.duration - comp.frameDuration);
    if (time > lastRenderable) time = lastRenderable;

    var out = String(opts.output || '');
    if (out === '') throw new Error('output path is required');
    var target = new File(out);
    ensureFolder(target.parent ? target.parent.fsName : Folder.current.fsName);

    var longEdge = opts.longEdge ? Number(opts.longEdge) : 0;
    var factor = longEdge > 0 ? factorFor(comp, longEdge) : 1;
    var originalFactor = 1;
    try { originalFactor = comp.resolutionFactor[0]; } catch (e0) {}

    var priorSolo = [];
    var t0 = new Date().getTime();
    var res;
    try {
      if (factor > 1) {
        try { comp.resolutionFactor = [factor, factor]; } catch (e1) {}
      }
      if (layer !== null) {
        for (var i = 1; i <= comp.numLayers; i++) {
          var l = comp.layer(i);
          priorSolo.push({ layer: l, solo: l.solo });
        }
        for (var j = 0; j < priorSolo.length; j++) {
          try { priorSolo[j].layer.solo = (priorSolo[j].layer.id === layer.id); } catch (e2) {}
        }
      }
      comp.saveFrameToPng(time, target);
      res = waitFile(out, opts.timeoutMs ? Number(opts.timeoutMs) : 15000);
    } finally {
      if (layer !== null) {
        for (var k = 0; k < priorSolo.length; k++) {
          try { priorSolo[k].layer.solo = priorSolo[k].solo; } catch (e3) {}
        }
      }
      try { comp.resolutionFactor = [originalFactor, originalFactor]; } catch (e4) {}
    }

    if (!res.file) throw new Error('saveFrameToPng produced no file after ' + res.waitedMs + 'ms');

    return {
      path: res.file.fsName,
      comp: { id: comp.id, name: comp.name, width: comp.width, height: comp.height },
      time: time,
      width: Math.round(comp.width / factor),
      height: Math.round(comp.height / factor),
      resolutionFactor: factor,
      bytes: res.file.length,
      isolatedLayer: layer === null ? null : { id: layer.id, name: layer.name },
      ms: new Date().getTime() - t0
    };
  }

  /** Several frames across a range, for judging motion in one pass. */
  function captureSequence(payload) {
    var opts = payload || {};
    var comp = resolveComp(opts);
    var count = Math.max(2, Math.min(24, Number(opts.count || 6)));
    var lastFrame = Math.max(0, comp.duration - comp.frameDuration);
    var start = opts.startTime === undefined ? 0 : Number(opts.startTime);
    var end = opts.endTime === undefined ? lastFrame : Math.min(Number(opts.endTime), lastFrame);
    if (end <= start) throw new Error('endTime must be greater than startTime');

    var dir = String(opts.outputDir || '');
    if (dir === '') throw new Error('outputDir is required');
    ensureFolder(dir);
    var prefix = String(opts.prefix || 'frame').replace(/[^A-Za-z0-9_-]/g, '');
    if (prefix === '') prefix = 'frame';

    var step = (end - start) / (count - 1);
    var frames = [];
    for (var i = 0; i < count; i++) {
      var t = start + step * i;
      if (t > lastFrame) t = lastFrame;
      var file = dir + '/' + prefix + '_' + i + '.png';
      var one = capturePreview({
        comp: comp.name,
        output: file,
        time: t,
        longEdge: opts.longEdge,
        timeoutMs: opts.timeoutMs
      });
      frames.push({ index: i, time: one.time, path: one.path, bytes: one.bytes });
    }
    return { comp: comp.name, startTime: start, endTime: end, count: frames.length, frames: frames };
  }

  /* ------------------------------------------------ E. essential graphics */

  /**
   * Add a layer property to the Essential Graphics panel so it becomes a
   * controller in a .mogrt. `addToEGP` is the scripting hook; the user still
   * needs a Media Encoder / AE "Export as template" step for distribution,
   * which `exportTemplate` below performs.
   */
  function essentialGraphics(payload) {
    var opts = payload || {};
    var comp = resolveComp(opts);
    var layer = resolveLayer(opts);
    var results = [];

    var props = opts.properties;
    if (!props || !(props instanceof Array) || props.length === 0) {
      throw new Error('properties must be a non-empty array of { matchName } / { name } entries');
    }

    for (var i = 0; i < props.length; i++) {
      var spec = props[i];
      var target = null;
      try { target = resolveLayerProperty(layer, spec); } catch (e) { target = null; }
      if (!target) {
        results.push({ requested: spec, ok: false, error: 'property not found' });
        continue;
      }

      // The scripting name is addToMotionGraphicsTemplate (the UI calls it
      // Essential Graphics; there is no `addToEGP` method). canAddTo... is the
      // supported pre-check, so ask it rather than discovering failure by throw.
      var canAdd = true;
      try {
        if (typeof target.canAddToMotionGraphicsTemplate === 'function') {
          canAdd = target.canAddToMotionGraphicsTemplate(comp);
        }
      } catch (e1) { canAdd = true; }

      if (!canAdd) {
        results.push({
          requested: spec, ok: false, matchName: target.matchName,
          error: 'this property cannot be exposed to Essential Graphics (nested group, mask, or unsupported type)'
        });
        continue;
      }

      var added = false;
      var errText = '';
      try {
        if (typeof target.addToMotionGraphicsTemplate === 'function') {
          target.addToMotionGraphicsTemplate(comp);
          added = true;
        } else {
          errText = 'addToMotionGraphicsTemplate is not available on this property';
        }
      } catch (e2) {
        errText = String(e2);
      }

      results.push({
        requested: spec,
        ok: added,
        name: target.name,
        matchName: target.matchName,
        propertyIndex: target.propertyIndex,
        error: errText || undefined
      });
    }

    var exposed = 0;
    try { exposed = comp.motionGraphicsTemplateControllerCount; } catch (e3) {}

    return {
      comp: { id: comp.id, name: comp.name },
      layer: { id: layer.id, name: layer.name },
      controllerCount: exposed,
      results: results
    };
  }

  /** Export the composition as a .mogrt template. */
  function exportTemplate(payload) {
    var opts = payload || {};
    var comp = resolveComp(opts);
    var out = String(opts.output || '');
    if (out === '') throw new Error('output must end in .mogrt');
    if (!/\.mogrt$/i.test(out)) throw new Error('output must end in .mogrt: ' + out);

    var f = new File(out);
    ensureFolder(f.parent ? f.parent.fsName : Folder.current.fsName);

    var returned = comp.exportAsMotionGraphicsTemplate(opts.overwrite === true, f.fsName);

    // The export writes asynchronously and its boolean return is not a success
    // signal — it reports true before (or without) producing a file. Poll for a
    // real, non-empty file and let that decide.
    var waited = waitFile(out, opts.timeoutMs ? Number(opts.timeoutMs) : 30000);
    var info = new File(out);
    var exists = info.exists && info.length > 0;

    return {
      ok: exists,
      returned: !!returned,
      comp: comp.name,
      path: info.exists ? info.fsName : f.fsName,
      exists: exists,
      bytes: info.exists ? info.length : 0,
      waitedMs: waited.waitedMs,
      error: exists ? '' : 'exportAsMotionGraphicsTemplate produced no file after ' + waited.waitedMs + 'ms; '
        + 'add at least one Essential Graphics controller first'
    };
  }

  /* ------------------------------------------------------------ F. audio */

  /**
   * Analyse an audio layer's waveform and drop markers on the loudest peaks.
   * `audioLevels` is a two-channel property sampled per frame; a peak is a
   * local maximum above the mean plus a sensitivity factor.
   */
  function audioMarkers(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);
    var comp = layer.containingComp;

    var prop = null;
    try { prop = layer.property('ADBE Audio Group').property('ADBE Audio Levels'); } catch (e0) { prop = null; }
    if (!prop) throw new Error('layer has no audio levels: ' + layer.name);

    var fps = comp.frameRate;
    var start = Math.max(0, layer.inPoint);
    var end = Math.min(comp.duration, layer.outPoint);
    var step = 1 / fps;
    var samples = [];

    for (var t = start; t <= end; t += step) {
      var v = null;
      try { v = prop.valueAtTime(t, false); } catch (e1) { v = null; }
      if (!v || v.length === 0) continue;
      var peak = Math.abs(v[0]);
      if (v.length > 1 && Math.abs(v[1]) > peak) peak = Math.abs(v[1]);
      samples.push({ time: t, level: peak });
    }
    if (samples.length === 0) throw new Error('no audio samples read');

    var sum = 0;
    var loudest = 0;
    for (var i = 0; i < samples.length; i++) {
      sum += samples[i].level;
      if (samples[i].level > loudest) loudest = samples[i].level;
    }
    var mean = sum / samples.length;

    // A silent or audio-less track reports level 0 everywhere. Without this
    // guard the "local maximum above threshold" test matches every frame and
    // the caller is told it found beats that do not exist.
    if (loudest < 0.001) {
      return {
        layer: { id: layer.id, name: layer.name },
        comp: comp.name,
        sampledFrames: samples.length,
        meanLevel: 0,
        threshold: 0,
        peaksFound: 0,
        markersPlaced: 0,
        markerTarget: opts.onComp === false ? 'layer' : 'comp',
        silent: true,
        times: [],
        note: 'no audible signal on this layer (all levels are zero); nothing marked'
      };
    }

    var sensitivity = opts.sensitivity === undefined ? 1.5 : Number(opts.sensitivity);
    var minGap = opts.minGap === undefined ? 0.18 : Number(opts.minGap);
    // Bound the threshold away from zero: a mean of 0.0001 multiplied by 1.5 is
    // still below any real peak, but a mean of 0 would admit silence.
    var threshold = Math.max(mean * sensitivity, loudest * 0.15);

    var peaks = [];
    var lastTime = -999;
    for (var j = 1; j < samples.length - 1; j++) {
      var s = samples[j];
      if (s.level < threshold) continue;
      if (s.level < samples[j - 1].level || s.level < samples[j + 1].level) continue;
      if (s.time - lastTime < minGap) continue;
      peaks.push(s);
      lastTime = s.time;
    }

    var maxMarkers = opts.maxMarkers ? Math.max(1, Math.min(500, opts.maxMarkers)) : 60;
    if (peaks.length > maxMarkers) {
      peaks.sort(function (a, b) { return b.level - a.level; });
      peaks = peaks.slice(0, maxMarkers);
      peaks.sort(function (a, b) { return a.time - b.time; });
    }

    var placed = 0;
    var target = opts.onComp === false ? layer : comp.markerProperty;
    if (opts.clearExisting === true) {
      try {
        while (target.numKeys > 0) target.removeKey(1);
      } catch (e2) {}
    }
    for (var k = 0; k < peaks.length; k++) {
      var mv = new MarkerValue('beat ' + (k + 1));
      mv.duration = 0;
      try {
        target.setValueAtTime(peaks[k].time, mv);
        placed++;
      } catch (e3) {}
    }

    return {
      layer: { id: layer.id, name: layer.name },
      comp: comp.name,
      sampledFrames: samples.length,
      meanLevel: Math.round(mean * 10000) / 10000,
      threshold: Math.round(threshold * 10000) / 10000,
      peaksFound: peaks.length,
      markersPlaced: placed,
      markerTarget: opts.onComp === false ? 'layer' : 'comp',
      times: (function () {
        var out = [];
        for (var m = 0; m < peaks.length; m++) out.push(Math.round(peaks[m].time * 1000) / 1000);
        return out;
      })()
    };
  }

  /* --------------------------------------------------------- G. checkpoint */

  /**
   * Save the project and copy the .aep to a timestamped path.
   *
   * `app.project.save(File(...))` would repoint the project's own file, so the
   * file is saved in place first and then copied — the open project keeps
   * pointing at the user's original.
   */
  function checkpoint(payload) {
    var opts = payload || {};
    if (app.project.file === null) {
      return { ok: false, skipped: true, reason: 'untitled-project',
        hint: 'save the project once with ae_compose save: or Ctrl+S, then checkpoint' };
    }

    try { app.project.save(); }
    catch (e1) { throw new Error('save() failed before checkpoint: ' + e1); }

    var src = app.project.file;
    var dir = String(opts.dir || '');
    if (dir === '') {
      dir = src.parent ? src.parent.fsName + '/dsh-checkpoints' : Folder.current.fsName + '/dsh-checkpoints';
    }
    ensureFolder(dir);

    var stamp = timestampSlug();
    var label = opts.label ? String(opts.label).replace(/[^A-Za-z0-9_-]/g, '') : '';
    var name = baseNameOf(src.name) + '_' + stamp + (label ? '_' + label : '') + '.aep';
    var dstPath = dir + '/' + name;

    var dst = new File(dstPath);
    var ok = false;
    try { ok = src.copy(dst.fsName); } catch (e2) { throw new Error('copy failed: ' + e2); }
    if (!ok) throw new Error('File.copy() returned false');

    var info = new File(dstPath);

    // Trim old checkpoints so a long session cannot fill the disk.
    var keep = opts.keep === undefined ? 20 : Math.max(1, Math.min(500, Number(opts.keep)));
    var pruned = [];
    try {
      var folder = new Folder(dir);
      var files = folder.getFiles(function (f) { return /\.aep$/i.test(f.name); });
      if (files.length > keep) {
        files.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        for (var i = 0; i < files.length - keep; i++) {
          try { files[i].remove(); pruned.push(files[i].name); } catch (e3) {}
        }
      }
    } catch (e4) {}

    return {
      ok: true,
      source: src.fsName,
      checkpoint: info.fsName,
      bytes: info.exists ? info.length : 0,
      dir: dir,
      pruned: pruned
    };
  }

  function timestampSlug() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function baseNameOf(name) {
    return String(name).replace(/\.[A-Za-z0-9]+$/, '');
  }

  /* ------------------------------------------------- H. addressing + fit */

  /** Resolve a layer from {layerId} / {layerIndex} / {layerName} inside a comp. */
  function resolveLayer(payload) {
    var opts = payload || {};
    var comp = resolveComp(opts);

    if (opts.layerId !== undefined && opts.layerId !== null) {
      return layerById(comp, opts.layerId);
    }
    if (opts.layerIndex !== undefined && opts.layerIndex !== null) {
      var idx = Number(opts.layerIndex);
      if (idx < 1 || idx > comp.numLayers) throw new Error('layerIndex out of range 1..' + comp.numLayers);
      return comp.layer(idx);
    }
    if (opts.layerName) {
      for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === String(opts.layerName)) return comp.layer(i);
      }
      throw new Error('layer not found by name: ' + opts.layerName);
    }
    throw new Error('specify layerId, layerIndex, or layerName');
  }

  function layerById(comp, id) {
    var want = String(id);
    for (var i = 1; i <= comp.numLayers; i++) {
      if (String(comp.layer(i).id) === want) return comp.layer(i);
    }
    throw new Error('layer id not found: ' + id);
  }

  function resolveComp(payload) {
    var opts = payload || {};
    if (opts.compId !== undefined && opts.compId !== null) {
      var want = String(opts.compId);
      for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && String(it.id) === want) return it;
      }
      throw new Error('comp id not found: ' + opts.compId);
    }
    return findComp(opts.comp);
  }

  /** Walk a dotted property path by matchName, falling back to display name. */
  function resolveLayerProperty(layer, spec) {
    if (spec.matchName) {
      var segs = String(spec.matchName).split('.');
      var node = layer;
      for (var i = 0; i < segs.length; i++) {
        node = node.property(segs[i]);
        if (!node) return null;
      }
      return node;
    }
    if (spec.propertyIndex !== undefined) {
      var p = layer.property(Number(spec.propertyIndex));
      return p || null;
    }
    if (spec.name) {
      for (var k = 1; k <= layer.numProperties; k++) {
        var cand = layer.property(k);
        if (cand && cand.name === spec.name) return cand;
      }
    }
    return null;
  }

  /**
   * Drive a text layer's rectangle to follow its glyphs.
   *
   * The expression is pure ES3 and reads sourceRectAtTime(), so a subtitle box
   * resizes itself when copy changes instead of clipping a fixed-width panel.
   */
  function autoFitText(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);
    var target = opts.target || 'shape';
    var padding = opts.padding === undefined ? 24 : Number(opts.padding);
    var layerRef = opts.shapeLayerName || null;

    var expr =
      'var r = thisLayer.sourceRectAtTime(time, false);\n' +
      'var p = ' + padding + ';\n' +
      '[r.width + p * 2, r.height + p * 2];';

    if (target === 'shape') {
      // A background shape reads the text layer's rect; keyed by layer name.
      var shape = layerRef ? findLayerByName(layer.containingComp, layerRef) : layer;
      var rect = shape.property('ADBE Root Vectors Group').property(1)
        .property('ADBE Vectors Group').property(1);
      try {
        rect.property('ADBE Vector Rect Size').expression = expr;
        rect.property('ADBE Vector Rect Size').expressionEnabled = true;
      } catch (e1) {
        throw new Error('could not set shape expression: ' + e1);
      }
      return { applied: true, target: 'shape', layer: shape.name, padding: padding };
    }

    // Text layer itself: expose the rect for downstream expressions.
    try {
      var ctrl = layer.property('ADBE Transform Group');
      ctrl.property('ADBE Position').expression =
        'var r = thisLayer.sourceRectAtTime(time, false);\n' +
        'value + [0, 0];';
      ctrl.property('ADBE Position').expressionEnabled = true;
    } catch (e2) {}

    return { applied: true, target: 'text', layer: layer.name, padding: padding };
  }

  function findLayerByName(comp, name) {
    for (var i = 1; i <= comp.numLayers; i++) {
      if (comp.layer(i).name === String(name)) return comp.layer(i);
    }
    throw new Error('layer not found: ' + name);
  }

  /* ------------------------------------------- I. guarded execution */

  /**
   * Run a snippet inside an undo group, capturing message, line, and the
   * offending source line so a failure is actionable instead of "error".
   */
  function runGuarded(payload) {
    var opts = payload || {};
    var code = String(opts.code || '');
    if (code === '') throw new Error('code is required');
    var label = opts.label ? String(opts.label) : 'DSH_AE';
    var source = code.split(/\r?\n/);

    var result = null;
    var failure = null;
    app.beginUndoGroup(label);
    try {
      // `eval` keeps ES3 semantics; the payload object is in scope for scripts.
      var fn = eval('(function(payload){' + code + '\n})');
      result = fn(opts.payload);
    } catch (e) {
      var line = -1;
      try { line = e.line; } catch (e1) {}
      failure = {
        message: String(e),
        line: line,
        context: (line > 0 && line <= source.length) ? source[line - 1] : null,
        source: source
      };
    } finally {
      try { app.endUndoGroup(); } catch (e2) {}
    }

    if (failure !== null) {
      var err = new Error(failure.message);
      err.line = failure.line;
      err.context = failure.context;
      err.source = failure.source;
      throw err;
    }
    return result === undefined ? null : result;
  }

  /* ---------------------------------------------------------------- API */

  return {
    capabilities: capabilities,
    scanEffects: scanEffects,
    inspectEffectParams: inspectEffectParams,
    scanPresets: scanPresets,
    applyFfxPreset: applyFfxPreset,
    capturePreview: capturePreview,
    captureSequence: captureSequence,
    essentialGraphics: essentialGraphics,
    exportTemplate: exportTemplate,
    audioMarkers: audioMarkers,
    checkpoint: checkpoint,
    autoFitText: autoFitText,
    runGuarded: runGuarded,
    resolveLayer: resolveLayer,
    resolveComp: resolveComp,
    // exported for the daemon's own introspection
    propTypeName: propTypeName,
    valueTypeName: valueTypeName
  };
})();

DSH_PRO;
