/* ============================================================================
 * dsh-aftereffects 鈥?pro template capability pack
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
   * native and third-party alike (Particular, Deep Glow, Saber, Element 3D鈥?.
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

    // Vendor is decided on the Node side, where the classification table lives.
    // This side only reports the raw facts 鈥?guessing "not ADBE/CC therefore
    // third-party" is how effects that ship with AE got labelled third-party.
    return {
      total: total,
      returned: rows.length,
      skippedObsolete: skippedObsolete,
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
   * Read one property row, recursing into any nested group.
   *
   * `propertyIndex` is one-based *within its parent group*, so it is only
   * meaningful together with `path` (the matchName chain from the effect root)
   * 鈥?both are always reported. Recursion is bounded so a pathological tree
   * cannot hang the daemon.
   */
  function describeProperty(p, index, parentPath, depth, maxDepth) {
    var row = {
      propertyIndex: index,
      name: p.name,
      matchName: p.matchName,
      path: parentPath === '' ? p.matchName : parentPath + '.' + p.matchName,
      propertyType: propTypeName(p),
      valueType: valueTypeName(p)
    };

    var custom = isCustom(p);
    row.customValue = custom;
    if (custom) {
      // The binary payload is not read, not serialised, not writable. Saying so
      // in the row is the whole contract.
      row.writable = false;
      row.animatable = false;
      row.reason = 'CUSTOM_VALUE is an opaque binary property of a third-party effect; '
        + 'it has no scriptable value. Use an .ffx preset or set the readable parameters around it.';
      return row;
    }

    row.writable = true;

    try { row.canSetExpression = !!p.canSetExpression; } catch (e1) {}
    try { row.animatable = !!(p.isTimeVarying || p.canVaryOverTime); } catch (e2) {
      try { row.animatable = !!p.isTimeVarying; } catch (e3) {}
    }
    try { row.isTimeVarying = !!p.isTimeVarying; } catch (e4) {}
    try { row.numKeys = p.numKeys || 0; } catch (e5) {}
    try { row.canAddToEGP = typeof p.canAddToMotionGraphicsTemplate === 'function'; } catch (e6) {}

    var v = safeValue(p);
    if (v !== null && v !== undefined) row.value = v;

    // Dropdown / menu parameters. Two APIs exist: older builds expose a
    // PropertyGroup through `propertyParameters()`, while AE 26+ can expose a
    // string array. Whichever shape turns up is handled, and the shape is
    // reported so a caller knows which it got.
    try {
      if (typeof p.getPropertyParameters === 'function') {
        var params = p.getPropertyParameters();
        if (params) {
          if (params instanceof Array) {
            row.menuItems = params.map(function (name, i) { return { index: i + 1, name: String(name) }; });
            row.menuShape = 'array';
          } else if (typeof params.numProperties === 'number') {
            var items = [];
            for (var m = 1; m <= params.numProperties; m++) {
              items.push({ index: m, name: params.property(m).name });
            }
            if (items.length > 0) {
              row.menuItems = items;
              row.menuShape = 'group';
            }
          }
        }
      }
    } catch (e7) {}
    if (!row.menuItems) {
      try {
        var direct = p.propertyParameters;
        if (direct && direct instanceof Array && direct.length > 0) {
          row.menuItems = direct.map(function (name, i) { return { index: i + 1, name: String(name) }; });
          row.menuShape = 'array';
        }
      } catch (e8) {}
    }

    // Recurse into groups. INDEXED_GROUP / NAMED_GROUP are containers; a
    // PROPERTY can still be a group in a few effect families, so the numeric
    // check is the real test.
    var childCount = 0;
    try { childCount = p.numProperties || 0; } catch (e9) { childCount = 0; }
    if (childCount > 0 && depth < maxDepth && p.propertyType !== PropertyType.PROPERTY) {
      var children = [];
      for (var c = 1; c <= childCount; c++) {
        var cp = null;
        try { cp = p.property(c); } catch (e10) { cp = null; }
        if (!cp) continue;
        children.push(describeProperty(cp, c, row.path, depth + 1, maxDepth));
      }
      if (children.length > 0) row.children = children;
    }

    return row;
  }

  /**
   * Read one effect's full parameter tree.
   *
   * Every row carries the numeric `propertyIndex` (the only stable handle
   * across a localised After Effects), the parameter `matchName`, its value
   * type, the full matchName path from the effect root, and an explicit
   * `customValue` flag with the reason it cannot be written.
   */
  function inspectEffectParams(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);
    var fx = findEffect(layer, opts);
    var maxDepth = opts.maxDepth ? Math.max(1, Math.min(12, Number(opts.maxDepth))) : 8;

    var rows = [];
    var customCount = 0;
    var count = fx.numProperties;
    var rootPath = '';

    for (var i = 1; i <= count; i++) {
      var p = fx.property(i);
      if (!p) continue;
      var row = describeProperty(p, i, rootPath, 0, maxDepth);
      if (row.customValue) customCount++;
      rows.push(row);
    }

    return {
      layer: { id: layer.id, index: layer.index, name: layer.name },
      effect: { name: fx.name, matchName: fx.matchName, propertyIndex: fx.propertyIndex },
      parameterCount: rows.length,
      customValueCount: customCount,
      maxDepth: maxDepth,
      warning: customCount > 0
        ? customCount + ' parameter(s) are CUSTOM_VALUE and cannot be read or written by script.'
        : null,
      parameters: rows
    };
  }

  /* --------------------------------------------------------------- C. ffx */

  /**
   * ExtendScript reports `Folder.name` / `File.name` URL-encoded:
   * "After%20Effects%202026", "%E5%BC%B9%E5%85%A5.ffx". Every name comparison
   * and every display string has to decode first 鈥?this one helper is the
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
   * `-noui` mode it terminates the process outright 鈥?no exception, no return.
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
        // Present but not usable headless 鈥?measured, not guessed.
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
            + '(File > Export > "Template鈥?).'
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
   * `resolutionFactor` is the cost lever 鈥?a model judging layout rarely needs
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
    // signal 鈥?it reports true before (or without) producing a file. Poll for a
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
   * Report where an audio layer's samples come from and how its time maps.
   *
   * The Node side needs the *file* so it can read real samples; AE only knows
   * the footage reference. Everything here is a fact AE can state, not a
   * measurement: the waveform itself is analysed outside this process.
   */
  function audioSource(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);

    var source = null;
    try { source = layer.source; } catch (e0) { source = null; }
    if (!source) {
      return { sourcePath: null, reason: 'layer has no footage source (a solid or text layer has no audio file)' };
    }

    var path = null;
    try { path = source.file ? source.file.fsName : null; } catch (e1) { path = null; }

    var mapping = {
      inPoint: 0,
      outPoint: 0,
      startTime: 0,
      stretch: 100,
      duration: 0,
      compFrameRate: 0
    };
    try {
      mapping.inPoint = layer.inPoint;
      mapping.outPoint = layer.outPoint;
      mapping.startTime = layer.startTime;
      mapping.stretch = layer.stretch;
      mapping.duration = layer.outPoint - layer.inPoint;
      mapping.compFrameRate = layer.containingComp.frameRate;
    } catch (e2) {}

    // Time remapping and reversal change the mapping in ways this tool does not
    // claim to model. Saying so is better than writing markers at wrong times.
    var remapped = false;
    try { remapped = layer.timeRemapEnabled === true; } catch (e3) { remapped = false; }

    var hasAudio = false;
    try {
      var ag = layer.property('ADBE Audio Group');
      hasAudio = !!ag;
    } catch (e4) { hasAudio = false; }

    return {
      layer: { id: layer.id, name: layer.name },
      sourcePath: path,
      sourceName: source.name,
      sourceDuration: (function () { try { return source.duration; } catch (e5) { return 0; } })(),
      hasAudio: hasAudio,
      timeRemapEnabled: remapped,
      timeMapping: mapping,
      note: remapped
        ? 'time remapping is enabled; marker times are computed from the plain inPoint/startTime/stretch mapping '
          + 'and may not match what you see for a remapped layer'
        : null
    };
  }

  /**
   * Write markers at the given comp times.
   *
   * Existing markers are preserved unless `clearExisting` is true 鈥?destroying a
   * user's edit markers as a side effect of adding beats is not acceptable.
   */
  function writeMarkers(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);
    var comp = layer.containingComp;
    var times = opts.times;
    if (!times || !(times instanceof Array) || times.length === 0) {
      throw new Error('times must be a non-empty array');
    }

    var target = opts.onComp === false ? layer.markerProperty : comp.markerProperty;
    var cleared = 0;
    if (opts.clearExisting === true) {
      try {
        while (target.numKeys > 0) {
          target.removeKey(1);
          cleared++;
        }
      } catch (e1) {}
    }

    var placed = 0;
    var failed = [];
    for (var i = 0; i < times.length; i++) {
      var t = Number(times[i]);
      if (!isFinite(t)) { failed.push({ index: i, reason: 'not a number' }); continue; }
      if (t < 0 || t > comp.duration) { failed.push({ index: i, time: t, reason: 'outside comp duration' }); continue; }
      try {
        var mv = new MarkerValue('beat ' + (i + 1));
        mv.duration = 0;
        target.setValueAtTime(t, mv);
        placed++;
      } catch (e2) {
        failed.push({ index: i, time: t, reason: String(e2) });
      }
    }

    return {
      placed: placed,
      cleared: cleared,
      failed: failed,
      target: opts.onComp === false ? 'layer' : 'comp',
      totalMarkers: (function () { try { return target.numKeys; } catch (e3) { return placed; } })()
    };
  }

  /* --------------------------------------------------------- G. checkpoint */

  /**
   * Save the project and copy the .aep to a timestamped path.
   *
   * `app.project.save(File(...))` would repoint the project's own file, so the
   * file is saved in place first and then copied 鈥?the open project keeps
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

  /**
   * Reopen a checkpointed project.
   *
   * Refuses when the file cannot be opened as a project: a failed restore that
   * silently closes the current project would be worse than not restoring.
   */
  function restoreCheckpoint(payload) {
    var opts = payload || {};
    var path = String(opts.checkpoint || '');
    if (path === '') throw new Error('checkpoint path is required');

    var file = new File(path);
    if (!file.exists) throw new Error('checkpoint not found: ' + path);
    if (file.length <= 0) throw new Error('checkpoint is empty: ' + path);

    var proj;
    try {
      proj = app.open(file);
    } catch (e1) {
      throw new Error('could not open checkpoint as a project: ' + e1);
    }
    if (!proj) throw new Error('app.open() returned nothing for ' + path);

    return {
      ok: true,
      checkpoint: file.fsName,
      items: proj.numItems,
      file: proj.file ? proj.file.fsName : null
    };
  }

  /**
   * Report the project facts the safety gate needs: where it is saved, how much
   * is in it, and where its checkpoints would live.
   */
  function projectStatus() {
    var file = app.project.file ? app.project.file.fsName : null;
    var compCount = 0;
    for (var i = 1; i <= app.project.numItems; i++) {
      try { if (app.project.item(i) instanceof CompItem) compCount++; } catch (e) {}
    }
    var dir = null;
    if (file !== null) {
      var sepIdx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
      if (sepIdx >= 0) {
        var sep = file.charAt(sepIdx) === '\\' ? '\\' : '/';
        dir = file.substring(0, sepIdx) + sep + 'dsh-checkpoints';
      }
    }
    return {
      file: file,
      saved: file !== null,
      compCount: compCount,
      items: app.project.numItems,
      renderQueue: app.project.renderQueue.numItems,
      checkpointDir: dir
    };
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
   * Make a background rectangle follow a text layer's real glyph bounds.
   *
   * The previous version pointed the *shape's own* rectangle at
   * `thisLayer.sourceRectAtTime()`, which measures the shape 鈥?a constant 鈥?so
   * the box never followed the words. The expression must reference the text
   * layer and convert its rect into the shape's coordinate space.
   *
   * Two modes:
   *   background  drive a shape layer's Rect Size and Position from the text
   *   text        give the text layer itself a rect-reporting expression
   *
   * The expression is pure ES3 and looks the text layer up by name each frame,
   * so renaming is handled by the tool rewriting the expression rather than by
   * a stale hard-coded index.
   */
  function autoFitText(payload) {
    var opts = payload || {};
    var comp = resolveComp(opts);

    var padX = opts.paddingX === undefined ? (opts.padding === undefined ? 24 : Number(opts.padding)) : Number(opts.paddingX);
    var padY = opts.paddingY === undefined ? (opts.padding === undefined ? 24 : Number(opts.padding)) : Number(opts.paddingY);
    var time = (opts.time === undefined || opts.time === null) ? null : Number(opts.time);
    var mode = String(opts.mode || (opts.shapeLayerId !== undefined || opts.shapeLayerName ? 'background' : 'text')).toLowerCase();

    // The text layer is the measuring source in both modes.
    var textLayer = opts.textLayerId !== undefined || opts.textLayerName !== undefined || opts.textLayerIndex !== undefined
      ? resolveLayer({
        compId: comp.id,
        layerId: opts.textLayerId,
        layerIndex: opts.textLayerIndex,
        layerName: opts.textLayerName,
      })
      : resolveLayer(opts);

    // A name is what an expression can look up. Escape a quote so a layer named
    // with an apostrophe cannot break the expression string.
    var textName = String(textLayer.name).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');

    var measured = measureTextBounds(textLayer, comp, time === null ? comp.time : time);
    var result = {
      mode: mode,
      comp: { id: comp.id, name: comp.name },
      textLayer: { id: textLayer.id, name: textLayer.name },
      padding: { x: padX, y: padY },
      bounds: measured
    };

    if (measured === null || measured.width <= 0 || measured.height <= 0) {
      result.applied = false;
      result.error = 'text layer reports an empty bounds rect; it may have no glyphs, '
        + 'or its source text is empty. Nothing was changed.';
      return result;
    }

    if (mode === 'background') {
      var shapeLayer = opts.shapeLayerId !== undefined || opts.shapeLayerName !== undefined
        ? resolveLayer({ compId: comp.id, layerId: opts.shapeLayerId, layerName: opts.shapeLayerName })
        : null;
      if (shapeLayer === null) {
        throw new Error('background mode requires shapeLayerId or shapeLayerName');
      }

      var sizeProp = null;
      var posProp = null;
      try {
        var root = shapeLayer.property('ADBE Root Vectors Group');
        var group = root.property(1);
        var vg = group.property('ADBE Vectors Group');
        // Find the Rect item rather than assuming it is the first child.
        for (var i = 1; i <= vg.numProperties; i++) {
          var item = vg.property(i);
          if (item && item.matchName === 'ADBE Vector Shape - Rect') {
            sizeProp = item.property('ADBE Vector Rect Size');
            break;
          }
        }
        posProp = group.property('ADBE Vector Transform Group').property('ADBE Vector Position');
      } catch (e1) {
        throw new Error('could not locate the rectangle on shape layer "' + shapeLayer.name + '": ' + e1);
      }
      if (sizeProp === null) {
        throw new Error('shape layer "' + shapeLayer.name + '" has no rectangle; auto-fit needs a Rect shape');
      }

      // The expression measures the text layer, in comp space, at the current
      // time, then offsets by the difference between the two layers' positions
      // so the box is centred over the words rather than over the comp origin.
      var sizeExpr =
        'var t = thisComp.layer("' + textName + '");\n' +
        'var r = t.sourceRectAtTime(time, false);\n' +
        '[r.width + ' + (padX * 2) + ', r.height + ' + (padY * 2) + '];';

      var posExpr =
        'var t = thisComp.layer("' + textName + '");\n' +
        'var r = t.sourceRectAtTime(time, false);\n' +
        'var centre = t.toComp([r.left + r.width / 2, r.top + r.height / 2]);\n' +
        'fromComp(centre);';

      sizeProp.expression = sizeExpr;
      sizeProp.expressionEnabled = true;
      posProp.expression = posExpr;
      posProp.expressionEnabled = true;

      result.applied = true;
      result.shapeLayer = { id: shapeLayer.id, name: shapeLayer.name };
      result.expressions = { size: sizeExpr, position: posExpr };
      result.expected = {
        width: Math.round((measured.width + padX * 2) * 100) / 100,
        height: Math.round((measured.height + padY * 2) * 100) / 100,
      };
      return result;
    }

    // text mode: publish the rect so other layers (or the user) can read it.
    var ctrl = textLayer.property('ADBE Transform Group');
    var anchorProp = ctrl.property('ADBE Anchor Point');
    var anchorExpr =
      'var r = sourceRectAtTime(time, false);\n' +
      '[r.left + r.width / 2, r.top + r.height / 2];';
    anchorProp.expression = anchorExpr;
    anchorProp.expressionEnabled = true;

    result.applied = true;
    result.expressions = { anchor: anchorExpr };
    return result;
  }

  /** Measure a text layer's glyph bounds through AE itself, for verification. */
  function measureTextBounds(layer, comp, atTime) {
    try {
      var src = layer.property('ADBE Text Properties').property('ADBE Text Document');
      var doc = atTime === undefined ? src.value : src.valueAtTime(atTime, false);
      if (!doc || !doc.text || String(doc.text).length === 0) {
        return { width: 0, height: 0, left: 0, top: 0, empty: true };
      }
    } catch (e0) {}
    try {
      var r = layer.sourceRectAtTime(atTime, false);
      return {
        width: Math.round(r.width * 100) / 100,
        height: Math.round(r.height * 100) / 100,
        left: Math.round(r.left * 100) / 100,
        top: Math.round(r.top * 100) / 100
      };
    } catch (e1) {
      return null;
    }
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

  /* --------------------------------- J. query / set / animate / layers */

  /**
   * Read one property, resolving nested groups by matchName or index path.
   * `path` is a dotted matchName chain, e.g.
   *   "ADBE Transform Group.ADBE Position"
   */
  function readProperty(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);
    var path = String(opts.path || opts.matchName || '');
    if (path === '') throw new Error('path (or matchName) is required');

    var node = layer;
    var segs = path.split('.');
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (/^\d+$/.test(seg)) node = node.property(Number(seg));
      else node = node.property(seg);
      if (!node) throw new Error('property not found at segment "' + seg + '" of ' + path);
    }

    var atTime = (opts.time !== undefined && opts.time !== null) ? Number(opts.time) : null;
    var custom = isCustom(node);
    var out = {
      layer: { id: layer.id, index: layer.index, name: layer.name },
      property: { name: node.name, matchName: node.matchName, propertyIndex: node.propertyIndex },
      propertyType: propTypeName(node),
      valueType: valueTypeName(node),
      customValue: custom,
      canSetExpression: false,
      isTimeVarying: false,
      numKeys: 0,
      value: null
    };
    try { out.canSetExpression = !!node.canSetExpression; } catch (e1) {}
    try { out.isTimeVarying = !!node.isTimeVarying; } catch (e2) {}
    try { out.numKeys = node.numKeys || 0; } catch (e3) {}

    if (!custom) {
      try {
        out.value = atTime === null ? safeValue(node) : sanitizeAtTime(node, atTime);
      } catch (e4) {}
    } else {
      out.note = 'CUSTOM_VALUE: opaque binary property, read-only';
    }

    if (out.numKeys > 0) {
      var times = [];
      var count = Math.min(out.numKeys, opts.maxKeys ? Number(opts.maxKeys) : 200);
      for (var k = 1; k <= count; k++) {
        var rec = { key: k };
        try { rec.time = node.keyTime(k); } catch (e5) {}
        try { rec.value = safeKeyValue(node, k); } catch (e6) {}
        times.push(rec);
      }
      out.keyframes = times;
    }

    return out;
  }

  function sanitizeAtTime(node, t) {
    var vt = node.propertyValueType;
    if (vt === PropertyValueType.CUSTOM_VALUE) return null;
    var v = node.valueAtTime(t, false);
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(v[i]);
      return a;
    }
    return v;
  }

  function safeKeyValue(node, k) {
    try {
      var vt = node.propertyValueType;
      if (vt === PropertyValueType.CUSTOM_VALUE) return null;
      var v = node.keyValue(k);
      if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(v[i]);
        return a;
      }
      return v;
    } catch (e) { return null; }
  }

  /**
   * Write one property. Refuses CUSTOM_VALUE: assigning it silently corrupts a
   * third-party effect's binary state, which is far worse than an error.
   */
  function writeProperty(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);
    var path = String(opts.path || opts.matchName || '');
    if (path === '') throw new Error('path (or matchName) is required');

    var node = layer;
    var segs = path.split('.');
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      node = /^\d+$/.test(seg) ? node.property(Number(seg)) : node.property(seg);
      if (!node) throw new Error('property not found at segment "' + seg + '" of ' + path);
    }

    if (isCustom(node)) {
      throw new Error('refusing to write CUSTOM_VALUE property "' + path
        + '": it is an opaque binary attribute of a third-party effect. '
        + 'Use an .ffx preset, or set the readable parameters around it.');
    }

    var before = safeValue(node);
    var atTime = (opts.time !== undefined && opts.time !== null) ? Number(opts.time) : null;

    if (opts.expression !== undefined && opts.expression !== null) {
      if (typeof node.expression === 'undefined') {
        throw new Error('property does not support expressions: ' + path);
      }
      node.expression = String(opts.expression);
      try { node.expressionEnabled = true; } catch (e1) {}
      return {
        layer: { id: layer.id, name: layer.name },
        property: { name: node.name, matchName: node.matchName },
        expression: String(opts.expression),
        previous: before
      };
    }

    if (opts.value === undefined) throw new Error('value or expression is required');

    if (atTime === null) node.setValue(opts.value);
    else node.setValueAtTime(atTime, opts.value);

    return {
      layer: { id: layer.id, name: layer.name },
      property: { name: node.name, matchName: node.matchName },
      before: before,
      after: safeValue(node),
      atTime: atTime
    };
  }

  /**
   * Keyframe a property with real easing.
   *
   * The default interpolation in After Effects is linear; a commercial template
   * needs a curve. `ease` accepts linear / in / out / both or an explicit
   * influence number, and `setTemporalEaseAtKey` is applied to every key.
   */
  function animateProperty(payload) {
    var opts = payload || {};
    var layer = resolveLayer(opts);
    var path = String(opts.path || opts.matchName || '');
    if (path === '') throw new Error('path (or matchName) is required');

    var node = layer;
    var segs = path.split('.');
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      node = /^\d+$/.test(seg) ? node.property(Number(seg)) : node.property(seg);
      if (!node) throw new Error('property not found at segment "' + seg + '" of ' + path);
    }
    if (isCustom(node)) throw new Error('refusing to keyframe CUSTOM_VALUE property: ' + path);

    var keys = opts.keys;
    if (!keys || !(keys instanceof Array) || keys.length === 0) {
      throw new Error('keys must be a non-empty array of { time, value }');
    }

    var easeName = opts.ease === undefined ? 'both' : String(opts.ease);
    var easeConf = parseEase(easeName);
    var dim = propertyDim(node);
    var written = [];

    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var t = Number(key.time);
      if (!isFinite(t)) throw new Error('keys[' + k + '].time must be a number');
      var v = coerceValue(key.value, dim, node);
      node.setValueAtTime(t, v);
      written.push({ time: t, value: v });
    }

    var applied = 0;
    if (!easeConf.linear) {
      for (var j = 0; j < written.length; j++) {
        var idx = node.nearestKeyIndex(written[j].time);
        try {
          node.setTemporalEaseAtKey(idx, easeArrayFor(dim, easeConf.inInf), easeArrayFor(dim, easeConf.outInf));
          applied++;
        } catch (e2) {}
      }
    }

    return {
      layer: { id: layer.id, name: layer.name },
      property: { name: node.name, matchName: node.matchName },
      keys: written.length,
      ease: easeName,
      easeApplied: applied,
      totalKeys: (function () { try { return node.numKeys; } catch (e3) { return written.length; } })()
    };
  }

  function propertyDim(node) {
    try {
      var v = node.value;
      return (v instanceof Array) ? v.length : 1;
    } catch (e) { return 1; }
  }

  function coerceValue(value, dim, node) {
    if (value instanceof Array) {
      var out = [];
      for (var i = 0; i < dim; i++) out.push(value[i] === undefined ? 0 : value[i]);
      return out;
    }
    if (dim === 1) return value;
    var uni = [];
    for (var j = 0; j < dim; j++) uni.push(value);
    return uni;
  }

  function parseEase(name) {
    var k = String(name || 'both').toLowerCase();
    if (k === 'linear' || k === 'none') return { linear: true, inInf: 0.1, outInf: 0.1 };
    if (k === 'in') return { linear: false, inInf: 0.1, outInf: 75 };
    if (k === 'out') return { linear: false, inInf: 75, outInf: 0.1 };
    if (k === 'both' || k === 'smooth') return { linear: false, inInf: 66, outInf: 66 };
    if (k === 'hold') return { linear: true, inInf: 0.1, outInf: 0.1 };
    var n = parseFloat(k);
    if (isFinite(n)) {
      var safe = n < 0.1 ? 0.1 : (n > 100 ? 100 : n);
      return { linear: false, inInf: safe, outInf: safe };
    }
    return { linear: false, inInf: 66, outInf: 66 };
  }

  function easeArrayFor(dim, influence) {
    var safe = influence < 0.1 ? 0.1 : (influence > 100 ? 100 : influence);
    var out = [];
    for (var i = 0; i < dim; i++) out.push(new KeyframeEase(0, safe));
    return out;
  }

  /**
   * Enumerate layers with stable ids.
   *
   * `id` is the durable handle: it survives renames and re-stacking, which an
   * index does not. Every layer row carries the facts a caller needs before
   * deciding to touch it.
   */
  function listLayers(payload) {
    var opts = payload || {};
    var comp = resolveComp(opts);
    var rows = [];
    var typeFilter = opts.type ? String(opts.type).toLowerCase() : null;
    var nameFilter = opts.nameFilter ? String(opts.nameFilter).toLowerCase() : null;
    var limit = opts.limit ? Math.max(1, Number(opts.limit)) : 10000;

    for (var i = 1; i <= comp.numLayers && rows.length < limit; i++) {
      var l = comp.layer(i);
      var type = layerType(l);

      if (typeFilter !== null && type !== typeFilter) continue;
      if (nameFilter !== null && String(l.name).toLowerCase().indexOf(nameFilter) < 0) continue;

      var rec = {
        index: i,
        id: l.id,
        name: l.name,
        type: type,
        enabled: true,
        solo: false,
        locked: false,
        threeD: false,
        inPoint: 0,
        outPoint: 0,
        startTime: 0
      };
      try { rec.enabled = !!l.enabled; } catch (e1) {}
      try { rec.solo = !!l.solo; } catch (e2) {}
      try { rec.locked = !!l.locked; } catch (e3) {}
      try { rec.threeD = !!l.threeDLayer; } catch (e4) {}
      try { rec.inPoint = l.inPoint; rec.outPoint = l.outPoint; rec.startTime = l.startTime; } catch (e5) {}
      try { rec.effects = l.property('ADBE Effect Parade').numProperties; } catch (e6) { rec.effects = 0; }
      try { rec.parent = l.parent ? { id: l.parent.id, name: l.parent.name } : null; } catch (e7) { rec.parent = null; }
      try { rec.source = l.source ? l.source.name : null; } catch (e8) {}

      // Transform snapshot 鈥?the common case for a caller deciding what to change.
      try {
        var t = l.property('ADBE Transform Group');
        rec.position = toArray(t.property('ADBE Position').value);
        rec.scale = toArray(t.property('ADBE Scale').value);
        rec.rotation = t.property('ADBE Rotate Z').value;
        rec.opacity = t.property('ADBE Opacity').value;
        rec.anchor = toArray(t.property('ADBE Anchor Point').value);
      } catch (e9) {}

      rows.push(rec);
    }

    return {
      comp: { id: comp.id, name: comp.name, width: comp.width, height: comp.height,
        duration: comp.duration, frameRate: comp.frameRate },
      layerCount: comp.numLayers,
      returned: rows.length,
      layers: rows
    };
  }

  function layerType(l) {
    try {
      if (l instanceof TextLayer) return 'text';
      if (l instanceof ShapeLayer) return 'shape';
      if (l instanceof CameraLayer) return 'camera';
      if (l instanceof LightLayer) return 'light';
      if (l.nullLayer === true) return 'null';
      try { if (l.property('ADBE Audio Group')) return l.source ? 'av' : 'audio'; } catch (e0) {}
      if (l.source) return 'footage';
      return 'solid';
    } catch (e) { return 'other'; }
  }

  function toArray(v) {
    if (!(v instanceof Array)) return v;
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(v[i]);
    return out;
  }

  /* ---------------------------------------------------------------- API */

  return {
    readProperty: readProperty,
    writeProperty: writeProperty,
    animateProperty: animateProperty,
    listLayers: listLayers,
    capabilities: capabilities,
    scanEffects: scanEffects,
    inspectEffectParams: inspectEffectParams,
    scanPresets: scanPresets,
    applyFfxPreset: applyFfxPreset,
    capturePreview: capturePreview,
    captureSequence: captureSequence,
    essentialGraphics: essentialGraphics,
    exportTemplate: exportTemplate,
    audioSource: audioSource,
    writeMarkers: writeMarkers,
    checkpoint: checkpoint,
    restoreCheckpoint: restoreCheckpoint,
    projectStatus: projectStatus,
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